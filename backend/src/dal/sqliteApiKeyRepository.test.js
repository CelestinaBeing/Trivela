import assert from 'node:assert/strict';
import test from 'node:test';
import Database from 'better-sqlite3';
import { runMigrations } from '../db/migrate.js';
import { createSqliteApiKeyRepository } from './sqliteApiKeyRepository.js';

async function setupRepository() {
  const db = new Database(':memory:');
  await runMigrations(db);
  return createSqliteApiKeyRepository({ db });
}

test('api key repository creates, validates, and revokes keys', async () => {
  const repository = await setupRepository();

  const created = repository.create({ label: 'ops-key' });
  assert.ok(created.rawKey.startsWith('tk_'));
  assert.equal(created.key.label, 'ops-key');
  assert.equal(created.key.active, true);

  const match = repository.validate(created.rawKey);
  assert.ok(match);
  assert.equal(match.id, created.key.id);

  repository.revoke(created.key.id);
  assert.equal(repository.validate(created.rawKey), null);
});

test('api key repository rejects expired keys', async () => {
  const repository = await setupRepository();
  const expiredAt = new Date(Date.now() - 60_000).toISOString();
  const created = repository.create({ label: 'expired', expiresAt: expiredAt });

  assert.equal(repository.validate(created.rawKey), null);
});

test('api key repository rotates keys', async () => {
  const repository = await setupRepository();
  const created = repository.create({ label: 'rotate-me' });

  const rotated = repository.rotate(created.key.id);
  assert.ok(rotated);
  assert.notEqual(rotated.rawKey, created.rawKey);
  assert.equal(repository.validate(created.rawKey), null);
  assert.ok(repository.validate(rotated.rawKey));
});

test('api key repository updates last_used_at on touch', async () => {
  const repository = await setupRepository();
  const created = repository.create({ label: 'usage' });

  repository.touchLastUsed(created.key.id);
  const listed = repository.list();
  assert.ok(listed[0].lastUsedAt);
});

// ── Rate tiers (#924) ────────────────────────────────────────────────────────

test('api key repository defaults new keys to the standard rate tier', async () => {
  const repository = await setupRepository();
  const created = repository.create({ label: 'default-tier' });

  assert.equal(created.key.rateTier, 'standard');
  assert.equal(repository.getById(created.key.id).rateTier, 'standard');
  assert.equal(repository.validate(created.rawKey).rateTier, 'standard');
});

test('api key repository accepts an explicit rate tier at creation', async () => {
  const repository = await setupRepository();
  const created = repository.create({ label: 'pro-tier', rateTier: 'pro' });

  assert.equal(created.key.rateTier, 'pro');
  assert.equal(repository.list()[0].rateTier, 'pro');
  assert.equal(repository.validate(created.rawKey).rateTier, 'pro');
});

test('api key repository setRateTier updates an existing key in place', async () => {
  const repository = await setupRepository();
  const created = repository.create({ label: 'upgrade-me' });
  assert.equal(created.key.rateTier, 'standard');

  const updated = repository.setRateTier(created.key.id, 'enterprise');
  assert.equal(updated.rateTier, 'enterprise');
  assert.equal(repository.getById(created.key.id).rateTier, 'enterprise');
  // The raw key keeps working — this is not a rotation.
  assert.ok(repository.validate(created.rawKey));
});

test('api key repository setRateTier returns null for an unknown id', async () => {
  const repository = await setupRepository();
  assert.equal(repository.setRateTier('does-not-exist', 'pro'), null);
});

test('api key repository rotate inherits the original rate tier', async () => {
  const repository = await setupRepository();
  const created = repository.create({ label: 'rotate-tier', rateTier: 'pro' });

  const rotated = repository.rotate(created.key.id);
  assert.equal(rotated.key.rateTier, 'pro');
});
