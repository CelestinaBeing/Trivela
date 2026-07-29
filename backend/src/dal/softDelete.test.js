import assert from 'node:assert/strict';
import test from 'node:test';
import Database from 'better-sqlite3';
import { runMigrations } from '../db/migrate.js';
import { createSqliteCampaignRepository } from './sqliteCampaignRepository.js';
import { purgePiiForUser, purgePiiForCampaign } from '../services/piiPurgeService.js';

async function setupTestRepository(seed = []) {
  const db = new Database(':memory:');
  await runMigrations(db);
  return { db, repository: createSqliteCampaignRepository({ db, seed }) };
}

const createListable = (repository, attrs) => repository.create({ status: 'published', ...attrs });

// ─── Soft-Delete Visibility Tests ────────────────────────────────────────────

test('soft-deleted campaign is hidden from list()', async () => {
  const { repository } = await setupTestRepository();

  const campaign = createListable(repository, { name: 'Test Campaign', rewardPerAction: 10 });
  assert.equal(repository.list().length, 1);

  repository.delete(campaign.id);
  assert.equal(repository.list().length, 0);
});

test('soft-deleted campaign is hidden from getById() by default', async () => {
  const { repository } = await setupTestRepository();

  const campaign = repository.create({ name: 'Test Campaign', rewardPerAction: 10 });
  assert.ok(repository.getById(campaign.id));

  repository.delete(campaign.id);
  assert.equal(repository.getById(campaign.id), undefined);
});

test('soft-deleted campaign is hidden from getBySlug() by default', async () => {
  const { repository } = await setupTestRepository();

  const campaign = repository.create({ name: 'Test Campaign', slug: 'test-campaign', rewardPerAction: 10 });
  assert.ok(repository.getBySlug('test-campaign'));

  repository.delete(campaign.id);
  assert.equal(repository.getBySlug('test-campaign'), undefined);
});

test('soft-deleted campaign is excluded from listCategories()', async () => {
  const { repository } = await setupTestRepository();

  createListable(repository, { name: 'Test', rewardPerAction: 10, category: 'DeFi' });
  assert.equal(repository.listCategories().length, 1);

  const campaign = repository.create({ name: 'Test 2', rewardPerAction: 10, category: 'NFT' });
  repository.update(campaign.id, { status: 'published' });
  repository.delete(campaign.id);
  assert.equal(repository.listCategories().length, 1);
});

test('soft-deleted campaign is excluded from listTags()', async () => {
  const { repository } = await setupTestRepository();

  createListable(repository, { name: 'Test', rewardPerAction: 10, tags: ['defi'] });
  assert.equal(repository.listTags().length, 1);

  const campaign = repository.create({ name: 'Test 2', rewardPerAction: 10, tags: ['nft'] });
  repository.update(campaign.id, { status: 'published' });
  repository.delete(campaign.id);
  assert.equal(repository.listTags().length, 1);
});

test('includeDeleted option shows soft-deleted campaigns in list()', async () => {
  const { repository } = await setupTestRepository();

  const campaign = createListable(repository, { name: 'Test Campaign', rewardPerAction: 10 });
  repository.delete(campaign.id);

  assert.equal(repository.list().length, 0);
  assert.equal(repository.list({ includeDeleted: true }).length, 1);
});

test('includeDeleted option shows soft-deleted campaign in getById()', async () => {
  const { repository } = await setupTestRepository();

  const campaign = repository.create({ name: 'Test Campaign', rewardPerAction: 10 });
  repository.delete(campaign.id);

  assert.equal(repository.getById(campaign.id), undefined);
  assert.ok(repository.getById(campaign.id, { includeDeleted: true }));
});

test('includeDeleted option shows soft-deleted campaign in getBySlug()', async () => {
  const { repository } = await setupTestRepository();

  const campaign = repository.create({ name: 'Test Campaign', slug: 'test', rewardPerAction: 10 });
  repository.delete(campaign.id);

  assert.equal(repository.getBySlug('test'), undefined);
  assert.ok(repository.getBySlug('test', { includeDeleted: true }));
});

test('soft-deleted campaign has deletedAt timestamp', async () => {
  const { repository } = await setupTestRepository();

  const campaign = repository.create({ name: 'Test Campaign', rewardPerAction: 10 });
  assert.equal(campaign.deletedAt, null);

  repository.delete(campaign.id);
  const deleted = repository.getById(campaign.id, { includeDeleted: true });
  assert.ok(deleted.deletedAt);
  assert.ok(new Date(deleted.deletedAt) <= new Date());
});

// ─── Restore Tests ───────────────────────────────────────────────────────────

test('restore() brings back a soft-deleted campaign', async () => {
  const { repository } = await setupTestRepository();

  const campaign = repository.create({ name: 'Test Campaign', rewardPerAction: 10 });
  repository.delete(campaign.id);
  assert.equal(repository.getById(campaign.id), undefined);

  const restored = repository.restore(campaign.id);
  assert.ok(restored);
  assert.equal(restored.id, campaign.id);
  assert.equal(restored.name, 'Test Campaign');
  assert.equal(restored.deletedAt, null);
});

test('restore() makes campaign visible in list() again', async () => {
  const { repository } = await setupTestRepository();

  const campaign = createListable(repository, { name: 'Test Campaign', rewardPerAction: 10 });
  repository.delete(campaign.id);
  assert.equal(repository.list().length, 0);

  repository.restore(campaign.id);
  assert.equal(repository.list().length, 1);
});

test('restore() returns undefined for non-existent campaign', async () => {
  const { repository } = await setupTestRepository();
  assert.equal(repository.restore('999'), undefined);
});

test('restore() returns undefined for non-deleted campaign', async () => {
  const { repository } = await setupTestRepository();

  const campaign = repository.create({ name: 'Test Campaign', rewardPerAction: 10 });
  assert.equal(repository.restore(campaign.id), undefined);
});

test('cannot publish a soft-deleted campaign', async () => {
  const { repository } = await setupTestRepository();

  const campaign = repository.create({
    name: 'Test Campaign',
    rewardPerAction: 10,
    contractId: 'CAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA',
  });
  repository.delete(campaign.id);

  assert.throws(() => repository.publish(campaign.id), /deleted/);
});

test('cannot archive a soft-deleted campaign', async () => {
  const { repository } = await setupTestRepository();

  const campaign = createListable(repository, { name: 'Test Campaign', rewardPerAction: 10 });
  repository.delete(campaign.id);

  assert.throws(() => repository.archive(campaign.id), /deleted/);
});

// ─── Hard Delete / Purge Tests ───────────────────────────────────────────────

test('hardDelete() permanently removes a campaign', async () => {
  const { repository } = await setupTestRepository();

  const campaign = repository.create({ name: 'Test Campaign', rewardPerAction: 10 });
  repository.delete(campaign.id);

  const purged = repository.hardDelete(campaign.id);
  assert.equal(purged, true);

  // Should not be found even with includeDeleted
  assert.equal(repository.getById(campaign.id, { includeDeleted: true }), undefined);
});

test('hardDelete() returns false for non-existent campaign', async () => {
  const { repository } = await setupTestRepository();
  assert.equal(repository.hardDelete('999'), false);
});

// ─── Retention Purge Tests ──────────────────────────────────────────────────

test('listDeleted() returns soft-deleted campaigns', async () => {
  const { repository } = await setupTestRepository();

  const campaign1 = repository.create({ name: 'Campaign 1', rewardPerAction: 10 });
  const campaign2 = repository.create({ name: 'Campaign 2', rewardPerAction: 20 });
  repository.create({ name: 'Campaign 3', rewardPerAction: 30 });

  repository.delete(campaign1.id);
  repository.delete(campaign2.id);

  const deleted = repository.listDeleted();
  assert.equal(deleted.length, 2);
  assert.ok(deleted.some((c) => c.id === campaign1.id));
  assert.ok(deleted.some((c) => c.id === campaign2.id));
});

test('listDeleted() respects olderThanDays filter', async () => {
  const { db, repository } = await setupTestRepository();

  const campaign = repository.create({ name: 'Old Campaign', rewardPerAction: 10 });
  repository.delete(campaign.id);

  // Backdate the deleted_at to 60 days ago
  db.prepare("UPDATE campaigns SET deleted_at = datetime('now', '-60 days') WHERE id = ?").run(
    Number(campaign.id),
  );

  // Campaign is 60 days old, so olderThanDays: 90 should NOT include it (60 < 90)
  const notOldEnough = repository.listDeleted({ olderThanDays: 90 });
  assert.equal(notOldEnough.length, 0);

  // Campaign is 60 days old, so olderThanDays: 30 SHOULD include it (60 > 30)
  const oldEnough = repository.listDeleted({ olderThanDays: 30 });
  assert.equal(oldEnough.length, 1);
});

test('listDeleted() respects limit', async () => {
  const { repository } = await setupTestRepository();

  for (let i = 0; i < 5; i++) {
    const c = repository.create({ name: `Campaign ${i}`, rewardPerAction: i });
    repository.delete(c.id);
  }

  assert.equal(repository.listDeleted({ limit: 3 }).length, 3);
  assert.equal(repository.listDeleted({ limit: 10 }).length, 5);
});

// ─── PII Purge Tests ─────────────────────────────────────────────────────────

test('purgePiiForUser deletes referral rows for the user', async () => {
  const { db } = await setupTestRepository();

  // Insert test referral data
  db.prepare(
    'INSERT INTO referrals (campaign_id, referrer_address, referee_address, created_at) VALUES (?, ?, ?, ?)',
  ).run(1, 'user1', 'user2', new Date().toISOString());
  db.prepare(
    'INSERT INTO referrals (campaign_id, referrer_address, referee_address, created_at) VALUES (?, ?, ?, ?)',
  ).run(1, 'user3', 'user4', new Date().toISOString());

  const result = purgePiiForUser(db, 'user1');
  assert.ok(result.purged.some((p) => p.table === 'referrals'));

  const remaining = db.prepare('SELECT * FROM referrals').all();
  assert.equal(remaining.length, 1);
  assert.equal(remaining[0].referrer_address, 'user3');
});

test('purgePiiForCampaign deletes campaign-specific PII rows', async () => {
  const { db } = await setupTestRepository();

  // Insert test data
  db.prepare(
    'INSERT INTO referrals (campaign_id, referrer_address, referee_address, created_at) VALUES (?, ?, ?, ?)',
  ).run(1, 'user1', 'user2', new Date().toISOString());
  db.prepare(
    'INSERT INTO referrals (campaign_id, referrer_address, referee_address, created_at) VALUES (?, ?, ?, ?)',
  ).run(2, 'user3', 'user4', new Date().toISOString());

  const result = purgePiiForCampaign(db, 1);
  assert.ok(result.purged.some((p) => p.table === 'referrals'));

  const remaining = db.prepare('SELECT * FROM referrals').all();
  assert.equal(remaining.length, 1);
  assert.equal(remaining[0].campaign_id, 2);
});

test('purgePiiForUser returns empty result when no PII found', async () => {
  const { db } = await setupTestRepository();
  const result = purgePiiForUser(db, 'nonexistent');
  assert.equal(result.purged.length, 0);
});

// ─── Integration Test ────────────────────────────────────────────────────────

test('full soft-delete lifecycle: create, soft-delete, restore, hard-delete', async () => {
  const { repository } = await setupTestRepository();

  // Create
  const campaign = createListable(repository, {
    name: 'Lifecycle Test',
    rewardPerAction: 10,
    tags: ['test'],
    category: 'DeFi',
  });
  assert.equal(repository.list().length, 1);

  // Soft-delete
  repository.delete(campaign.id);
  assert.equal(repository.list().length, 0);
  assert.equal(repository.getById(campaign.id), undefined);

  // List deleted
  const deleted = repository.listDeleted();
  assert.equal(deleted.length, 1);
  assert.equal(deleted[0].id, campaign.id);

  // Restore
  const restored = repository.restore(campaign.id);
  assert.ok(restored);
  assert.equal(repository.list().length, 1);
  assert.equal(repository.getById(campaign.id).id, campaign.id);

  // Hard-delete
  repository.delete(campaign.id);
  repository.hardDelete(campaign.id);
  assert.equal(repository.listDeleted().length, 0);
  assert.equal(repository.getById(campaign.id, { includeDeleted: true }), undefined);
});
