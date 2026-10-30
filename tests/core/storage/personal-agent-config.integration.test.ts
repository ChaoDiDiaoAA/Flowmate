import { expect, test } from 'bun:test';
import { Database } from 'bun:sqlite';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import type { PersonalAgentConfiguration, Result } from '@flowmate/contracts';
import { createPersonalAgentRepository } from '../../../packages/core/src/personal-agent/agent-repository.ts';
import { createDatabaseCoordinator } from '../../../packages/core/src/storage/write-coordinator.ts';
import { deferCleanup, mkdtempSync } from '../../support/resources.ts';
import { openTestDatabase } from '../../support/database.ts';

const at = '2026-10-28T00:00:00.000Z', later = '2026-10-28T00:01:00.000Z';
const configuration: PersonalAgentConfiguration = { modelId: null, thinkingLevel: 'off',
  resources: { prompt: null, enabledSkills: [] }, extensions: { enabledExtensions: [] },
  tools: [], workingDirectory: null, preferences: 'Default invoice assistant.' };
const edited: PersonalAgentConfiguration = { ...configuration, modelId: 'controlled-model', preferences: 'Preserve user choices.' };
function need<T>(value: Result<T>): T { if (!value.ok) throw Error(value.error.code); return value.data; }

function fixture() {
  const db = new Database(':memory:');
  db.exec(`CREATE TABLE personal_agents (
    id INTEGER PRIMARY KEY CHECK(id=1), revision INTEGER NOT NULL CHECK(revision>=0),
    configuration_json TEXT NOT NULL CHECK(json_valid(configuration_json)),
    created_at TEXT NOT NULL, updated_at TEXT NOT NULL
  )`);
  const owner = createDatabaseCoordinator(db); deferCleanup(() => owner.close());
  const seed = (revision = 0, json = JSON.stringify(configuration)) => owner.transaction(sql =>
    sql.run('INSERT INTO personal_agents VALUES (1,?,?,?,?)', revision, json, at, at));
  const rows = () => owner.read(sql => sql.all('SELECT * FROM personal_agents ORDER BY id'));
  return { db, owner, seed, rows };
}

test('default Personal Agent is absent until explicitly ensured, and ensure never replaces user configuration', async () => {
  const f = fixture();
  expect(await f.owner.read(sql => createPersonalAgentRepository(sql.synchronous).getDefault())).toEqual({ ok: true, data: null });
  const first = need(await f.owner.transaction(sql => createPersonalAgentRepository(sql.synchronous).ensureDefault(configuration, at)));
  expect(first).toEqual({ personalAgentId: 1, revision: 0, runtimeKind: 'durable', configuration, createdAt: at, updatedAt: at });
  const changed = need(await f.owner.transaction(sql => createPersonalAgentRepository(sql.synchronous).update({
    personalAgentId: 1, expectedRevision: 0, configuration: edited, at: later })));
  expect(changed).toEqual({ ...first, revision: 1, configuration: edited, updatedAt: later });
  expect(await f.owner.transaction(sql => createPersonalAgentRepository(sql.synchronous).ensureDefault(configuration, later)))
    .toEqual({ ok: true, data: changed });
  expect(await f.owner.read(sql => createPersonalAgentRepository(sql.synchronous).getDefault())).toEqual({ ok: true, data: changed });
  expect(await f.rows()).toHaveLength(1);
});

test('concurrent ensure callbacks on the same SQLite owner retain one id=1 and its first configuration', async () => {
  const f = fixture();
  const results = await Promise.all([configuration, edited, configuration].map(value =>
    f.owner.transaction(sql => createPersonalAgentRepository(sql.synchronous).ensureDefault(value, at))));
  expect(results).toEqual(Array.from({ length: 3 }, () => ({ ok: true, data: {
    personalAgentId: 1, revision: 0, runtimeKind: 'durable', configuration, createdAt: at, updatedAt: at,
  } })));
  expect(await f.owner.read(sql => sql.all('SELECT id,revision FROM personal_agents'))).toEqual([{ id: 1, revision: 0 }]);
});

test.each(['owner', 'stale', 'overflow', 'duplicate-tools', 'time', 'credential-field'] as const)
  ('Personal Agent update rejects %s without changing its stored configuration', async reason => {
  const f = fixture(), revision = reason === 'overflow' ? Number.MAX_SAFE_INTEGER : 0;
  await f.seed(revision); const before = await f.rows();
  const credentialConfiguration = { ...edited, apiKey: 'SYNTHETIC_PRIVATE_VALUE' };
  const invalidConfiguration: PersonalAgentConfiguration = reason === 'duplicate-tools' ? { ...edited, tools: ['read_invoice_document', 'read_invoice_document'] }
    : reason === 'credential-field' ? credentialConfiguration : edited;
  const result = await f.owner.transaction(sql => createPersonalAgentRepository(sql.synchronous).update({
    personalAgentId: reason === 'owner' ? 2 : 1, expectedRevision: reason === 'stale' ? 1 : revision,
    configuration: invalidConfiguration, at: reason === 'time' ? 'not-a-time' : later,
  }));
  expect(result).toMatchObject({ ok: false, error: { code: reason === 'owner' ? 'personal_agent_not_found'
    : reason === 'stale' || reason === 'overflow' ? 'state_conflict' : 'input_invalid' } });
  expect(await f.rows()).toEqual(before);
  expect(JSON.stringify(await f.rows())).not.toContain('SYNTHETIC_PRIVATE_VALUE');
});

test('a missing Personal Agent cannot be updated or implicitly created', async () => {
  const f = fixture();
  expect(await f.owner.transaction(sql => createPersonalAgentRepository(sql.synchronous).update({
    personalAgentId: 1, expectedRevision: 0, configuration: edited, at: later })))
    .toMatchObject({ ok: false, error: { code: 'personal_agent_not_found' } });
  expect(await f.rows()).toEqual([]);
});

test('corrupt stored configuration stays visible as corruption and is never replaced by ensure or update', async () => {
  const f = fixture(); await f.seed(0, '{}'); const before = await f.rows();
  expect(await f.owner.read(sql => createPersonalAgentRepository(sql.synchronous).getDefault()))
    .toMatchObject({ ok: false, error: { code: 'storage_corrupt' } });
  expect(await f.owner.transaction(sql => createPersonalAgentRepository(sql.synchronous).ensureDefault(configuration, later)))
    .toMatchObject({ ok: false, error: { code: 'storage_corrupt' } });
  expect(await f.owner.transaction(sql => createPersonalAgentRepository(sql.synchronous).update({
    personalAgentId: 1, expectedRevision: 0, configuration: edited, at: later })))
    .toMatchObject({ ok: false, error: { code: 'storage_corrupt' } });
  expect(await f.rows()).toEqual(before);
});

test('a real SQLite update rejection preserves the prior Personal Agent revision and configuration', async () => {
  const f = fixture(); await f.seed(); const before = await f.rows();
  await f.owner.transaction(sql => sql.exec("CREATE TRIGGER reject_agent_update BEFORE UPDATE ON personal_agents BEGIN SELECT RAISE(ABORT,'controlled update failure'); END"));
  expect(await f.owner.transaction(sql => createPersonalAgentRepository(sql.synchronous).update({
    personalAgentId: 1, expectedRevision: 0, configuration: edited, at: later })))
    .toMatchObject({ ok: false, error: { code: 'storage_write_failed' } });
  expect(await f.rows()).toEqual(before);
});

test('021 creates the real default configuration table and its queued readers wait for the same owner COMMIT', async () => {
  const root = mkdtempSync(join(tmpdir(), 'flowmate-personal-config-'));
  const database = need(openTestDatabase({ root, databaseFile: join(root, 'data/app.sqlite'), artifactsDir: join(root, 'artifacts'),
    runtimeDir: join(root, 'runtime'), logsDir: join(root, 'logs'), outputsDir: join(root, 'outputs') }));
  expect(await database.read(scope => scope.db.query('SELECT MAX(version) AS version FROM schema_migrations').get())).toEqual({ version: 22 });
  const entered = Promise.withResolvers<void>(), release = Promise.withResolvers<void>();
  const writing = database.transaction(async scope => {
    const saved = createPersonalAgentRepository(scope.db).ensureDefault(configuration, at);
    entered.resolve(); await release.promise; return saved;
  });
  await entered.promise;
  let settled = false;
  const reading = database.read(scope => createPersonalAgentRepository(scope.db).getDefault()).then(value => { settled = true; return value; });
  try {
    await new Promise<void>(resolve => setImmediate(resolve)); expect(settled).toBe(false);
    release.resolve(); const saved = need(await writing);
    expect(saved).toMatchObject({ personalAgentId: 1, revision: 0, runtimeKind: 'durable', configuration });
    expect(await reading).toEqual({ ok: true, data: saved });
    expect(await database.read(scope => scope.db.query('SELECT COUNT(*) AS count FROM runs').get())).toEqual({ count: 0 });
  } finally { release.resolve(); await writing; await reading; }
});
