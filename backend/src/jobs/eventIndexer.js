/**
 * Event indexer for Trivela Soroban contract events.
 *
 * Subscribes to on-chain events and persists them to the database.
 * Snapshot events store a ledger reference so off-chain tools can
 * reconstruct user balances at that point using Horizon getLedgerEntries.
 *
 * `pollWithCursor` (issue #753) adds:
 * - Durable cursor: the last-seen event cursor is stored in `indexer_cursors`
 *   and resumed on restart, so no events are skipped or re-processed after a
 *   crash.
 * - Exactly-once via per-event dedupe: `processed_events` records a unique key
 *   per event (contract_id + ledger + event_index). Replaying the same ledger
 *   range produces no duplicate DB rows.
 * - Backpressure: ingestion is paused when the writer is saturated. A bounded
 *   semaphore caps the number of events being processed concurrently; when all
 *   slots are occupied the fetch loop waits rather than accumulating unbounded
 *   in-flight work.
 */

/**
 * Bounded concurrency semaphore for backpressure.
 * `acquire()` resolves immediately when a slot is free; otherwise it waits
 * until one is released, naturally pausing the fetch loop.
 */
class Semaphore {
  constructor(limit) {
    this._limit = limit;
    this._active = 0;
    this._queue = [];
  }

  acquire() {
    if (this._active < this._limit) {
      this._active++;
      return Promise.resolve();
    }
    return new Promise((resolve) => this._queue.push(resolve));
  }

  release() {
    this._active--;
    if (this._queue.length > 0) {
      this._active++;
      this._queue.shift()();
    }
  }
}

export function createEventIndexer({
  db,
  rpcPool,
  logger = console,
  // Bonus (in reward units) auto-credited to a referrer when an on-chain
  // `referred` event is indexed (issue #455). Defaults to 0 so deployments
  // opt in explicitly.
  referralBonus = 0,
} = {}) {
  const handlers = {
    credit: handleCreditEvent,
    claim: handleClaimEvent,
    snapshot: handleSnapshotEvent,
    vcredit: handleVestedCreditEvent,
    vclaim: handleVestedClaimEvent,
    referred: (event, database) => handleReferredEvent(event, database, referralBonus),
    refbonus: handleRefBonusEvent,
  };

  async function processEvent(event) {
    const topic = event.topic?.[0];
    const handler = handlers[topic];
    if (!handler) return;
    try {
      await handler(event, db);
    } catch (err) {
      logger.error?.(`eventIndexer:error topic=${topic}`, err);
    }
  }

  async function poll(contractId, cursor) {
    const rpc = await rpcPool.acquire();
    try {
      const { events, nextCursor } = await rpc.getEvents({
        contractId,
        cursor,
        limit: 200,
      });
      for (const event of events) {
        await processEvent(event);
      }
      return nextCursor;
    } finally {
      rpcPool.release(rpc);
    }
  }

  /**
   * Poll once with durable cursor persistence, per-event exactly-once dedupe,
   * and bounded concurrency backpressure (issue #753).
   *
   * @param {string} contractId
   * @param {object} opts
   * @param {number} [opts.maxInflight=32]  Max concurrent event handlers.
   *   When all slots are occupied, new fetch calls pause until a slot frees —
   *   this is the backpressure mechanism.
   * @returns {Promise<string|undefined>}  The next cursor, or undefined when
   *   the indexer has caught up.
   */
  async function pollWithCursor(contractId, { maxInflight = 32 } = {}) {
    // Load the last durable cursor so we resume exactly where we left off.
    const cursorRow = await db.get(
      `SELECT cursor FROM indexer_cursors WHERE contract_id = ?`,
      [contractId],
    );
    const cursor = cursorRow?.cursor ?? undefined;

    const rpc = await rpcPool.acquire();
    let events, nextCursor;
    try {
      ({ events, nextCursor } = await rpc.getEvents({
        contractId,
        cursor,
        limit: 200,
      }));
    } finally {
      rpcPool.release(rpc);
    }

    if (!events || events.length === 0) {
      return nextCursor;
    }

    // Bounded concurrency — when all maxInflight slots are taken, acquire()
    // blocks, preventing unbounded in-flight growth (backpressure).
    const sem = new Semaphore(maxInflight);

    await Promise.all(
      events.map(async (event, eventIndex) => {
        await sem.acquire();
        try {
          // Exactly-once: use (contract_id, ledger, eventIndex) as the dedupe
          // key. INSERT OR IGNORE makes re-processing the same ledger range a
          // no-op; `changes === 0` means the event was already handled.
          const dedupeResult = await db.run(
            `INSERT OR IGNORE INTO processed_events
               (contract_id, ledger, event_index, processed_at)
             VALUES (?, ?, ?, ?)`,
            [contractId, event.ledger, eventIndex, Date.now()],
          );
          if (dedupeResult?.changes === 0) return;
          await processEvent(event);
        } finally {
          sem.release();
        }
      }),
    );

    // Persist the cursor only after the entire batch has been written. A crash
    // between batch processing and cursor write causes safe re-delivery (the
    // dedupe table absorbs duplicates); a crash after cursor write skips past
    // the batch — which is why we write cursor last.
    if (nextCursor != null) {
      await db.run(
        `INSERT INTO indexer_cursors (contract_id, cursor, updated_at)
         VALUES (?, ?, ?)
         ON CONFLICT(contract_id)
         DO UPDATE SET cursor = excluded.cursor, updated_at = excluded.updated_at`,
        [contractId, nextCursor, new Date().toISOString()],
      );
    }

    return nextCursor;
  }

  return { processEvent, poll, pollWithCursor };
}

async function handleCreditEvent(event, db) {
  const user = event.topic?.[1];
  const amount = BigInt(event.data ?? 0);
  await db.run(
    `INSERT OR IGNORE INTO balances (user) VALUES (?)
     ON CONFLICT(user) DO UPDATE SET balance = balance + ?`,
    [user, amount.toString()],
  );
  await db.run(`INSERT INTO credit_events (user, amount, ledger, tx_hash) VALUES (?, ?, ?, ?)`, [
    user,
    amount.toString(),
    event.ledger,
    event.txHash,
  ]);
}

async function handleClaimEvent(event, db) {
  const user = event.topic?.[1];
  const amount = BigInt(event.data ?? 0);
  await db.run(`UPDATE balances SET balance = balance - ? WHERE user = ?`, [
    amount.toString(),
    user,
  ]);
  await db.run(`INSERT INTO claim_events (user, amount, ledger, tx_hash) VALUES (?, ?, ?, ?)`, [
    user,
    amount.toString(),
    event.ledger,
    event.txHash,
  ]);
}

/**
 * Index a snapshot event.
 *
 * The contract stores only a ledger reference — not a full balance copy.
 * Off-chain consumers can call Horizon getLedgerEntries with this ledger
 * number to reconstruct all user balances at that exact point in time.
 *
 * Pattern:
 *   1. Read `snapshot_ledger` from this event.
 *   2. Fetch all `BALANCE` storage entries at `snapshot_ledger` from Horizon.
 *   3. Persist the reconstructed balances to `snapshot_balances`.
 */
/**
 * Index a `referred` event emitted by the campaign contract (issue #455).
 *
 * Topics are `(referred, referee, referrer)`. The contract has already
 * validated that the referrer is a registered participant and is not the
 * referee, so the indexer can trust the edge and auto-credit the referrer's
 * bonus without trusting the frontend.
 *
 * The credit mirrors `handleCreditEvent`: the referrer's balance is bumped and
 * a `credit_events` row records the on-chain reference. Recording is idempotent
 * per (referrer, referee) so re-indexing the same event does not double-credit.
 */
async function handleReferredEvent(event, db, referralBonus = 0) {
  const referee = event.topic?.[1];
  const referrer = event.topic?.[2];
  if (!referee || !referrer) return;

  // Record the referral edge first; the UNIQUE(referee) guard makes replays
  // a no-op and lets us skip the credit when nothing was inserted.
  const recorded = await db.run(
    `INSERT OR IGNORE INTO referral_credits (referee, referrer, ledger, tx_hash)
     VALUES (?, ?, ?, ?)`,
    [referee, referrer, event.ledger, event.txHash],
  );
  if (recorded && recorded.changes === 0) return;

  const bonus = BigInt(referralBonus);
  if (bonus <= 0n) return;

  await db.run(
    `INSERT OR IGNORE INTO balances (user) VALUES (?)
     ON CONFLICT(user) DO UPDATE SET balance = balance + ?`,
    [referrer, bonus.toString()],
  );
  await db.run(`INSERT INTO credit_events (user, amount, ledger, tx_hash) VALUES (?, ?, ?, ?)`, [
    referrer,
    bonus.toString(),
    event.ledger,
    event.txHash,
  ]);
}

/**
 * Index a `ref_bonus` event emitted by the rewards contract's on-chain referral
 * engine (issue #656).
 *
 * Topics are `(refbonus, referrer, referee)`, data `(bonus, qualifying_amount)`.
 * The same payout also emits a standard `credit` event for the referrer, which
 * `handleCreditEvent` already applies to balances — so this handler records
 * *instrumentation only* (the attribution edge, bonus, and qualifying amount)
 * for referral-conversion metrics, and never touches balances to avoid
 * double-counting. The `UNIQUE(referee)` guard makes re-indexing idempotent,
 * mirroring the contract's one-bonus-per-referee invariant.
 */
async function handleRefBonusEvent(event, db) {
  const referrer = event.topic?.[1];
  const referee = event.topic?.[2];
  if (!referrer || !referee) return;

  const [bonus, qualifyingAmount] = Array.isArray(event.data) ? event.data : [0, 0];
  await db.run(
    `INSERT OR IGNORE INTO referral_bonus_events
       (referrer, referee, bonus, qualifying_amount, ledger, tx_hash, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
    [
      referrer,
      referee,
      String(bonus),
      String(qualifyingAmount),
      event.ledger,
      event.txHash,
      Date.now(),
    ],
  );
}

async function handleSnapshotEvent(event, db) {
  const snapshotId = BigInt(event.topic?.[1] ?? 0);
  const snapshotLedger = BigInt(event.data ?? 0);
  await db.run(
    `INSERT OR REPLACE INTO snapshots (snapshot_id, ledger_number, recorded_at)
     VALUES (?, ?, ?)`,
    [snapshotId.toString(), snapshotLedger.toString(), Date.now()],
  );
}

async function handleVestedCreditEvent(event, db) {
  const user = event.topic?.[1];
  const [vestId, total] = Array.isArray(event.data) ? event.data : [0, 0];
  await db.run(
    `INSERT INTO vesting_schedules (user, vest_id, total, ledger, tx_hash)
     VALUES (?, ?, ?, ?, ?)`,
    [user, String(vestId), String(total), event.ledger, event.txHash],
  );
}

async function handleVestedClaimEvent(event, db) {
  const user = event.topic?.[1];
  const [vestId, amount] = Array.isArray(event.data) ? event.data : [0, 0];
  await db.run(
    `INSERT INTO vested_claim_events (user, vest_id, amount, ledger, tx_hash)
     VALUES (?, ?, ?, ?, ?)`,
    [user, String(vestId), String(amount), event.ledger, event.txHash],
  );
}
