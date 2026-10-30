import { expect, test } from 'bun:test';
import { Database } from 'bun:sqlite';
import { mkdirSync, readFileSync, readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { z } from 'zod';
import { AgentSessionSnapshotSchema, SessionSnapshotSchema, SessionInputContentV2Schema, CandidateDraftSchema, invoiceHeaderFields,
  DurableRunConfigSnapshotSchema, DurableWorkBudgetSchema, PersonalAgentConfigurationSchema, type Result } from '@flowmate/contracts';
import { openTestDatabase } from '../../support/database.ts';
import { makeSelectedCandidate, makeCurrentSelectedCandidate } from '../../support/selected-candidate.ts';
import { backupStore, inspectStore } from '../../../packages/core/src/storage/maintenance.ts';
import { PACKAGED_MIGRATIONS, PACKAGED_REQUIRED_FILES, PackagedReleaseSchema } from '@flowmate/shared';
import { BACKGROUND_CONTEXT } from '@earendil-works/chord/context';
import { createModels, InMemoryCredentialStore, InMemoryModelsStore } from '@earendil-works/pi-ai';
import { createRegistry, Harness } from '@earendil-works/pi-durable';
import { createDurableSqliteStorage } from '@flowmate/runtime-durable';
import { PiAgentAdapter } from '@flowmate/runtime-pi';
import { SessionService } from '../../../packages/core/src/sessions/service.ts';
import { createSessionRepository } from '../../../packages/core/src/storage/repositories.ts';
import { createFileStore } from '../../../packages/core/src/storage/file-store.ts';
import { createDocumentService } from '../../../packages/data/src/documents.ts';
import { deferCleanup, mkdtempSync } from '../../support/resources.ts';

const at = '2026-10-28T00:00:00.000Z';
function need<T>(value: Result<T>): T { if (!value.ok) throw Error(value.error.code); return value.data; }
function paths() {
  const root = mkdtempSync(join(tmpdir(), 'flowmate-session-engine-'));
  return { root, databaseFile: join(root, 'data/app.sqlite'), artifactsDir: join(root, 'artifacts'),
    outputsDir: join(root, 'outputs'), runtimeDir: join(root, 'runtime'), logsDir: join(root, 'logs') };
}
function historicalStore(input: ReturnType<typeof paths>, maximumVersion = 20) {
  mkdirSync(dirname(input.databaseFile), { recursive: true });
  const db = new Database(input.databaseFile); deferCleanup(() => db.close()); db.exec('PRAGMA foreign_keys=ON');
  const directory = new URL('../../../packages/core/src/storage/migrations/', import.meta.url);
  for (const name of readdirSync(directory).filter(name => /^\d{3}_.*\.sql$/.test(name) && Number(name.slice(0, 3)) <= maximumVersion).sort()) {
    const version = Number(name.slice(0, 3));
    if (version === 17) db.exec('PRAGMA foreign_keys=OFF; PRAGMA legacy_alter_table=ON');
    for (const statement of readFileSync(new URL(name, directory), 'utf8').split(/^\s*-- statement\s*$/m).filter(part => part.trim())) db.exec(statement);
    if (db.inTransaction) db.exec('COMMIT');
    if (version === 10 || version === 17) db.exec('PRAGMA foreign_keys=ON; PRAGMA legacy_alter_table=OFF');
  }
  return db;
}

test('021 upgrades actual schema20 Sessions as legacy and preserves their rows, indexes and foreign keys', async () => {
  const input = paths(), old = historicalStore(input);
  old.query('INSERT INTO sessions(native_session_id,title,created_at,updated_at) VALUES(?,?,?,?)').run('original-pi-session', 'Original', at, at);
  old.query('INSERT INTO workspace(id,revision,active_session_id,created_at,updated_at) VALUES(1,0,1,?,?)').run(at, at);
  const before = old.query('SELECT * FROM sessions').all(); old.close();
  const current = need(openTestDatabase(input));
  try {
    expect(current.db.query('SELECT max(version) AS version FROM schema_migrations').get()).toEqual({ version: 21 });
    expect(current.db.query('SELECT id,native_session_id,title,status,created_at,updated_at,metadata_json,hidden_at FROM sessions').all()).toEqual(before);
    expect(current.sessions.get(1)).toMatchObject({ ok: true, data: { runtimeKind: 'agent_session', nativeSessionId: 'original-pi-session', durableConversationId: null } });
    expect(current.db.query('SELECT active_session_id FROM workspace WHERE id=1').get()).toEqual({ active_session_id: 1 });
    expect(current.db.query('PRAGMA foreign_key_check').all()).toEqual([]);
    expect(current.db.query("SELECT name FROM sqlite_master WHERE type='index' AND tbl_name='sessions' ORDER BY name").all())
      .toEqual(expect.arrayContaining([{ name: 'sessions_recent' }, { name: 'sessions_visible_recent' }]));
  } finally { await current.close(); }
});

test.each([9, 20])('physical schema%d Session reads keep missing engine columns as legacy without rewriting the old schema', version => {
  const input = paths(), old = historicalStore(input, version), repository = createSessionRepository(old);
  const session = need(repository.create({ nativeSessionId: `legacy-schema-${version}`, title: 'Historical reader', at }));
  expect(session).toMatchObject({ runtimeKind: 'agent_session', nativeSessionId: `legacy-schema-${version}`, durableConversationId: null });
  expect(repository.get(session.sessionId)).toMatchObject({ ok: true, data: { runtimeKind: 'agent_session' } });
  expect(repository.list({ limit: 50 })).toMatchObject({ ok: true, data: { items: [{ sessionId: session.sessionId }] } });
  expect(old.query('PRAGMA table_info(sessions)').all()).not.toEqual(expect.arrayContaining([expect.objectContaining({ name: 'runtime_kind' })]));
  expect(old.query('SELECT max(version) AS version FROM schema_migrations').get()).toEqual({ version });
  old.close();
});

test('a rejected schema21 commit rolls back Session rebuilding, engine guards and all business tables', async () => {
  const input = paths(), old = historicalStore(input);
  old.query('INSERT INTO sessions(native_session_id,title,created_at,updated_at) VALUES(?,?,?,?)').run('before-021-failure', 'Preserved', at, at);
  old.query('INSERT INTO workspace(id,revision,active_session_id,created_at,updated_at) VALUES(1,0,1,?,?)').run(at, at);
  old.exec("CREATE TRIGGER reject_schema21 BEFORE INSERT ON schema_migrations WHEN NEW.version=21 BEGIN SELECT RAISE(ABORT,'controlled schema21 failure'); END");
  const rows = old.query('SELECT * FROM sessions').all();
  const schema = old.query('SELECT name,sql FROM sqlite_master WHERE sql IS NOT NULL ORDER BY name').all(); old.close();
  expect(openTestDatabase(input)).toMatchObject({ ok: false, error: { code: 'storage_open_failed' } });
  const after = new Database(input.databaseFile);
  try {
    expect(after.query('SELECT * FROM sessions').all()).toEqual(rows);
    expect(after.query('SELECT name,sql FROM sqlite_master WHERE sql IS NOT NULL ORDER BY name').all()).toEqual(schema);
    expect(after.query('SELECT max(version) AS version FROM schema_migrations').get()).toEqual({ version: 20 });
    expect(after.query('PRAGMA foreign_key_check').all()).toEqual([]);
  } finally { after.close(); }
});

test('Durable product Sessions exist before their integer Conversation is bound and bind only once', async () => {
  const current = need(openTestDatabase(paths()));
  try {
    const created = current.sessions.create({ runtimeKind: 'durable', nativeSessionId: null, title: 'Awaiting native commit', at });
    expect(created).toMatchObject({ ok: true, data: { runtimeKind: 'durable', nativeSessionId: null, durableConversationId: null } });
    const session = need(created);
    expect(current.db.query('SELECT * FROM session_native_history WHERE session_id=?').get(session.sessionId)).toBeNull();
    expect(current.sessions.bindDurableConversation(session.sessionId, 17, at)).toMatchObject({ ok: true, data: { durableConversationId: 17 } });
    expect(current.sessions.bindDurableConversation(session.sessionId, 17, at)).toMatchObject({ ok: true, data: { durableConversationId: 17 } });
    expect(current.sessions.bindDurableConversation(session.sessionId, 18, at)).toMatchObject({ ok: false, error: { code: 'state_conflict' } });
    const other = need(current.sessions.create({ runtimeKind: 'durable', nativeSessionId: null, title: 'Other work', at }));
    expect(current.sessions.bindDurableConversation(other.sessionId, 17, at)).toMatchObject({ ok: false });
    const legacy = need(current.sessions.create({ nativeSessionId: 'legacy', title: 'Legacy', at }));
    expect(current.sessions.bindDurableConversation(legacy.sessionId, 19, at)).toMatchObject({ ok: false, error: { code: 'state_conflict' } });
  } finally { await current.close(); }
});

test('persisted unknown Session engines are rejected by SQLite and by the actual row reader', async () => {
  const current = need(openTestDatabase(paths()));
  try {
    const legacy = need(current.sessions.create({ nativeSessionId: 'legacy-kind', title: 'Legacy', at }));
    expect(() => current.db.query("UPDATE sessions SET runtime_kind='durable',native_session_id=NULL WHERE id=?").run(legacy.sessionId))
      .toThrow('session_runtime_immutable');
    expect(() => current.db.query("UPDATE sessions SET runtime_kind='other' WHERE id=?").run(legacy.sessionId)).toThrow();
    current.db.exec('DROP TRIGGER session_runtime_immutable');
    current.db.exec('PRAGMA ignore_check_constraints=ON');
    current.db.query("UPDATE sessions SET runtime_kind='other' WHERE id=?").run(legacy.sessionId);
    expect(current.sessions.get(legacy.sessionId)).toMatchObject({ ok: false, error: { code: 'storage_corrupt' } });
  } finally { await current.close(); }
});

function durableFacts(current: NonNullable<ReturnType<typeof makeSelectedCandidate>['currentStore']>) {
  const session = need(current.sessions.create({ runtimeKind: 'durable', nativeSessionId: null, title: 'Durable pending work', at }));
  const runId = Number(current.db.query(`INSERT INTO runs(kind,session_id,status,goal,input_json,config_json,scope_json,cleanup_json,usage_json,created_at)
    VALUES('agent',?,'created','Durable pending phase','{}','{"runtimeKind":"durable"}','{}',?, '{}',?)`)
    .run(session.sessionId, JSON.stringify({ version: 1, stopped: false, stopReason: null, errors: [], lateObservationRequired: false }), at).lastInsertRowid);
  const toolId = Number(current.db.query(`INSERT INTO tool_calls(run_id,session_id,native_tool_call_id,tool_name,tool_version,effect,
    args_json,status,delivery_json,cleanup_json,requested_at) VALUES(?,?,'durable-owned-call','read','1','READ',?,'requested',?,?,?)`)
    .run(runId, session.sessionId, JSON.stringify({ version: 1, raw: {}, final: null }),
      JSON.stringify({ version: 1, state: 'not_attempted', messageObservedAt: null, includedInCallSequence: null, requestDispatchedAt: null, error: null }),
      JSON.stringify({ version: 1, stopped: false, stopReason: null, errors: [] }), at).lastInsertRowid);
  const inputId = Number(current.db.query(`INSERT INTO session_inputs(session_id,client_sequence,mode,goal_mode,run_id,content_json,status,processing_status,created_at,updated_at)
    VALUES(?,1,'prompt','answer',?,?,'queued','pending',?,?)`).run(session.sessionId, runId,
      JSON.stringify(SessionInputContentV2Schema.parse({ version: 2, text: 'Original Durable input', promptText: 'Original Durable input',
        workspaceContext: null, workspaceInput: null, allowedDocumentIds: [], allowedArtifactIds: [] })), at, at).lastInsertRowid);
  const snapshot = () => ({ run: current.db.query('SELECT * FROM runs WHERE id=?').get(runId),
    tool: current.db.query('SELECT * FROM tool_calls WHERE id=?').get(toolId), input: current.db.query('SELECT * FROM session_inputs WHERE id=?').get(inputId) });
  return { sessionId: session.sessionId, runId, toolId, inputId, original: snapshot() };
}

test('reopening mixed engines repairs only legacy Run, ToolCall and input facts', async () => {
  const f = makeSelectedCandidate(), current = f.currentStore;
  if (!current) throw Error('Current storage fixture required.');
  const selected = f.selectedWorkspace;
  const run = need(current.runs.createWorkspaceAgent({ sessionId: f.session.sessionId,
    expected: { revision: selected.revision, sessionId: f.session.sessionId, documentRef: selected.documentRef,
      jobId: selected.jobId, candidateRef: selected.candidateRef }, goalMode: 'answer', text: 'Legacy pending input',
    messageTimestamp: 2, goal: 'Legacy interrupted root', config: f.config, usage: f.usage, cleanup: f.cleanup, createdAt: at }, f.verify));
  const legacyConfig = { ...f.config, goalMode: 'answer', workspaceContext: run.workspaceContext };
  need(current.runs.start(run.runId, legacyConfig, at));
  const call = need(current.toolCalls.request({ runId: run.runId, sessionId: f.session.sessionId,
    nativeToolCallId: 'legacy-pending-call', toolName: 'read_invoice_evidence', toolVersion: '1', effect: 'READ',
    context: null, rawArguments: { documentId: 1 }, requestedAt: at }));
  const inputId = Number(current.db.query(`INSERT INTO session_inputs(session_id,client_sequence,mode,goal_mode,run_id,content_json,status,processing_status,created_at,updated_at)
    VALUES(?,1,'prompt','answer',?,?,'queued','pending',?,?)`).run(f.session.sessionId, run.runId,
      JSON.stringify(SessionInputContentV2Schema.parse({ version: 2, text: 'Legacy pending input', promptText: 'Legacy pending input',
        workspaceContext: run.workspaceContext, workspaceInput: run.workspaceInput,
        allowedDocumentIds: run.scope.allowedDocumentIds, allowedArtifactIds: run.scope.allowedArtifactIds })), at, at).lastInsertRowid);
  const durable = durableFacts(current);
  await current.close();
  const reopened = need(openTestDatabase({ root: f.root, databaseFile: join(f.root, 'data/flowmate.sqlite'),
    artifactsDir: join(f.root, 'artifacts'), outputsDir: join(f.root, 'outputs'), runtimeDir: join(f.root, 'runtime'), logsDir: join(f.root, 'logs') }));
  try {
    expect(reopened.db.query('SELECT status FROM runs WHERE id=?').get(run.runId)).toEqual({ status: 'failed' });
    expect(reopened.db.query('SELECT status FROM tool_calls WHERE id=?').get(call.toolCallId)).toEqual({ status: 'failed' });
    expect(reopened.db.query('SELECT status,processing_status FROM session_inputs WHERE id=?').get(inputId)).toEqual({ status: 'failed', processing_status: 'failed' });
    expect({ run: reopened.db.query('SELECT * FROM runs WHERE id=?').get(durable.runId),
      tool: reopened.db.query('SELECT * FROM tool_calls WHERE id=?').get(durable.toolId),
      input: reopened.db.query('SELECT * FROM session_inputs WHERE id=?').get(durable.inputId) }).toEqual(durable.original);
    expect(reopened.db.query('SELECT * FROM session_native_history WHERE session_id=?').get(durable.sessionId)).toBeNull();
  } finally { await reopened.close(); }
});

test('a pending Durable root is not an interrupted legacy Run or a legacy recovery block', async () => {
  const input = paths(), current = need(openTestDatabase(input)), durable = durableFacts(current);
  await current.close();
  const reopened = need(openTestDatabase(input));
  try {
    expect(reopened.recoveryError).toBeNull();
    expect(reopened.db.query('SELECT * FROM runs WHERE id=?').get(durable.runId)).toEqual(durable.original.run);
    expect(reopened.db.query('SELECT * FROM tool_calls WHERE id=?').get(durable.toolId)).toEqual(durable.original.tool);
    expect(reopened.db.query('SELECT * FROM session_inputs WHERE id=?').get(durable.inputId)).toEqual(durable.original.input);
  } finally { await reopened.close(); }
});

test('the actual active-root constraint separates engines while rejecting same-engine inserts and reactivation', async () => {
  const current = need(openTestDatabase(paths()));
  try {
    const legacy = need(current.sessions.create({ nativeSessionId: 'legacy-root-lock', title: 'Legacy lock', at }));
    const durable = need(current.sessions.create({ runtimeKind: 'durable', nativeSessionId: null, title: 'Durable lock', at }));
    const insert = (sessionId: number) => Number(current.db.query(`INSERT INTO runs(kind,session_id,status,goal,input_json,config_json,scope_json,cleanup_json,usage_json,created_at)
      VALUES('agent',?,'created','Root identity constraint','{}','{}','{}','{}','{}',?)`).run(sessionId, at).lastInsertRowid);
    const legacyRun = insert(legacy.sessionId), durableRun = insert(durable.sessionId);
    expect(current.db.query("SELECT id FROM runs WHERE status='created' ORDER BY id").all()).toEqual([{ id: legacyRun }, { id: durableRun }]);
    expect(() => insert(legacy.sessionId)).toThrow(); expect(() => insert(durable.sessionId)).toThrow();
    const provider = () => Number(current.db.query(`INSERT INTO runs(kind,status,goal,input_json,config_json,cleanup_json,usage_json,created_at)
      VALUES('provider','created','Legacy Provider root','{}','{}','{}','{}',?)`).run(at).lastInsertRowid);
    expect(provider).toThrow();
    current.db.query("UPDATE runs SET status='failed',error_json='{}',ended_at=? WHERE id=?").run(at, durableRun);
    const successor = insert(durable.sessionId);
    expect(() => current.db.query("UPDATE runs SET status='created',error_json=NULL,ended_at=NULL WHERE id=?").run(durableRun)).toThrow();
    expect(current.db.query('SELECT status FROM runs WHERE id=?').get(durableRun)).toEqual({ status: 'failed' });
    expect(current.db.query('SELECT status FROM runs WHERE id=?').get(successor)).toEqual({ status: 'created' });
    current.db.query("UPDATE runs SET status='failed',error_json='{}',ended_at=? WHERE id=?").run(at, legacyRun);
    expect(provider()).toBeGreaterThan(0);
    expect(() => current.db.query("UPDATE runs SET status='created',error_json=NULL,ended_at=NULL WHERE id=?").run(legacyRun)).toThrow();
  } finally { await current.close(); }
});

test('schema21 remains inspectable and backed up without interpreting an unbound Durable Session as Pi history', async () => {
  const input = paths(), current = need(openTestDatabase(input));
  const session = need(current.sessions.create({ runtimeKind: 'durable', nativeSessionId: null, title: 'Accepted before native binding', at }));
  await current.close();
  expect(inspectStore(input)).toMatchObject({ ok: true, data: { schemaVersion: 21 } });
  mkdirSync(join(input.root, 'backups'));
  const backup = need(await backupStore(input, join(input.root, 'backups/saved-backup')));
  expect(backup.manifest.schemaVersion).toBe(21);
  expect(backup.manifest.gaps).not.toContain(`session_execution_requires_recheck:${session.sessionId}`);
});

test('the current packaged release includes migration021 and declares product schema21', () => {
  expect(PACKAGED_MIGRATIONS).toContain('021_personal_agent.sql');
  expect(PackagedReleaseSchema.safeParse({ version: 1, releaseId: 'a0000000-0000-4000-8000-000000000021', productVersion: '0.1.0',
    platform: 'win32', arch: 'x64', bunVersion: '1.4.4', electronVersion: '44.4.5', sdkVersion: '1.4.0', pluginVersion: '0.19.0',
    schemaVersion: 21, settingsVersion: 7, files: [...PACKAGED_REQUIRED_FILES] }).success).toBe(true);
});

test('maintenance preserves an actual zero-model Durable Conversation binding and rejects a future native schema', async () => {
  const input = paths(), current = need(openTestDatabase(input));
  const storage = await createDurableSqliteStorage(current.coordinator);
  const harness = await Harness.open(storage, { models: createModels({ credentials: new InMemoryCredentialStore(), modelsStore: new InMemoryModelsStore(),
    authContext: { env: async () => undefined, fileExists: async () => false } }), registry: createRegistry() }, BACKGROUND_CONTEXT);
  try {
    const conversation = await harness.commit(tx => tx.createConversation({ ownership: { kind: 'ownerless' } }), BACKGROUND_CONTEXT);
    const session = need(await current.transaction(scope => scope.sessions.create({ runtimeKind: 'durable', nativeSessionId: null, title: 'Native bound', at })));
    need(await current.transaction(scope => scope.sessions.bindDurableConversation(session.sessionId, conversation.id, at)));
    expect(await current.read(scope => scope.db.query('SELECT count(*) AS count FROM fm_durable_tasks').get())).toEqual({ count: 0 });
  } finally { await harness.close(BACKGROUND_CONTEXT); await current.close(); }
  expect(inspectStore(input)).toMatchObject({ ok: true, data: { schemaVersion: 21 } });
  mkdirSync(join(input.root, 'backups'));
  expect(await backupStore(input, join(input.root, 'backups/bound-backup'))).toMatchObject({ ok: true });
  const changed = need(openTestDatabase(input));
  await changed.transaction(scope => { scope.db.exec('UPDATE fm_durable_durable_schema SET version=99 WHERE singleton=1'); });
  await changed.close();
  expect(inspectStore(input)).toMatchObject({ ok: false, error: { code: 'maintenance_store_incompatible' } });
});

test('maintenance rejects a stored Durable binding whose native Conversation row is absent', async () => {
  const input = paths(), current = need(openTestDatabase(input));
  const session = need(current.sessions.create({ runtimeKind: 'durable', nativeSessionId: null, title: 'Missing native row', at }));
  need(current.sessions.bindDurableConversation(session.sessionId, 99, at));
  await current.close(); mkdirSync(join(input.root, 'backups'));
  expect(await backupStore(input, join(input.root, 'backups/missing-native')))
    .toMatchObject({ ok: false, error: { code: 'maintenance_reference_missing' } });
});

for (const operation of ['get', 'messages', 'history', 'history-entry', 'input', 'inputs', 'extensions', 'archive', 'delete']) {
  test(`legacy Session ${operation} rejects Durable ownership before any Pi inspection`, async () => {
    const input = paths(), current = need(openTestDatabase(input));
    const session = need(current.sessions.create({ runtimeKind: 'durable', nativeSessionId: null, title: 'Other engine', at }));
    const agent = new PiAgentAdapter({ cwd: input.root, agentDir: input.runtimeDir, credentials: new InMemoryCredentialStore() });
    let inspections = 0;
    const inspect = agent.inspect.bind(agent);
    agent.inspect = (...args) => { inspections++; return inspect(...args); };
    const service = new SessionService(agent, () => ({ active: null, blocked: false, error: null }), () => at, current);
    try {
      const id = session.sessionId;
      const result = operation === 'get' ? await service.get(id)
        : operation === 'messages' ? await service.listMessages({ sessionId: id, limit: 50 })
          : operation === 'history' ? await service.querySessionHistory({ sessionId: id })
            : operation === 'history-entry' ? await service.querySessionHistoryEntry({ sessionId: id, entryId: 'missing', expectedCommitRevision: 0 })
              : operation === 'input' ? await service.queryInput({ sessionId: id })
                : operation === 'inputs' ? await service.listInputs({ sessionId: id })
                  : operation === 'extensions' ? await service.queryExtensions({ sessionId: id })
                    : operation === 'archive' ? await service.setStatus({ sessionId: id, expectedStatus: 'active', status: 'archived' }) : await service.deleteSession(id);
      expect(result).toMatchObject({ ok: false, error: { code: 'session_runtime_mismatch' } });
      expect(inspections).toBe(0);
      expect(current.sessions.get(id)).toMatchObject({ ok: true, data: { runtimeKind: 'durable', status: 'active', nativeSessionId: null } });
    } finally { await agent.close(); await current.close(); }
  });
}

test('legacy chat listing excludes accepted Durable Sessions without inspecting Pi', async () => {
  const input = paths(), current = need(openTestDatabase(input));
  need(current.sessions.create({ runtimeKind: 'durable', nativeSessionId: null, title: 'Durable work', at }));
  const agent = new PiAgentAdapter({ cwd: input.root, agentDir: input.runtimeDir, credentials: new InMemoryCredentialStore() });
  let inspections = 0;
  agent.inspect = () => { inspections++; throw Error('No Pi owner exists.'); };
  const service = new SessionService(agent, () => ({ active: null, blocked: false, error: null }), () => at, current);
  try { expect(await service.list({ limit: 50 })).toMatchObject({ ok: true, data: { items: [] } }); expect(inspections).toBe(0); }
  finally { await agent.close(); await current.close(); }
});

test('an unrelated active Durable root does not prevent rejecting the original released legacy Candidate', async () => {
  const f = makeSelectedCandidate(), current = f.currentStore;
  if (!current) throw Error('Current storage fixture required.');
  durableFacts(current);
  expect(current.candidates.reject({ operationRef: 'reject-independent-engine', jobId: f.jobId, candidateId: f.candidateId,
    expectedCandidateId: f.candidateId, expectedRevision: f.selectedWorkspace.revision, reason: 'Explicit user decision', at }))
    .toMatchObject({ ok: true, data: { candidate: { status: 'rejected' } } });
  expect(current.db.query('SELECT status FROM invoice_candidates WHERE id=?').get(f.candidateId)).toEqual({ status: 'rejected' });
});

test('Session DTO codecs keep the actual Pi identity separate from a nullable Durable binding', async () => {
  const input = paths(), current = need(openTestDatabase(input));
  const agent = new PiAgentAdapter({ cwd: input.root, agentDir: input.runtimeDir, credentials: new InMemoryCredentialStore() });
  const service = new SessionService(agent, () => ({ active: null, blocked: false, error: null }), () => at, current);
  try {
    const legacy = need(await service.create({ title: 'Actual Pi identity' }));
    const durable = { ...legacy, runtimeKind: 'durable', nativeSessionId: null };
    expect(SessionSnapshotSchema.safeParse(durable).success).toBe(true);
    expect(AgentSessionSnapshotSchema.safeParse(durable).success).toBe(false);
    expect(SessionSnapshotSchema.safeParse({ ...legacy, runtimeKind: 'durable' }).success).toBe(false);
  } finally { await agent.close(); await current.close(); }
});

test('a genuine open Master phase protects its item Job with Run.jobId null and leaves another invoice decision legal', async () => {
  const database = await makeCurrentSelectedCandidate(), input = { root: database.root, databaseFile: database.db.filename,
    artifactsDir: join(database.root, 'artifacts'), outputsDir: join(database.root, 'outputs'), runtimeDir: join(database.root, 'runtime'),
    logsDir: join(database.root, 'logs') };
  const files = createFileStore(input, database);
  const documents = createDocumentService({ paths: input, files, allowedSourceRoot: input.root, now: () => at,
    transaction: operation => database.transaction(scope => operation({ repository: scope.documents,
      files: { read: (artifact, name) => files.read(artifact, name, scope.contents) } })) });
  const text = 'A separately owned second invoice.';
  const secondDocument = need(await documents.importPrepared({ contract: 'flowmate-prepared-invoice/v1', sample: 'master-phase-other-invoice',
    original: { name: 'source.md', base64: Buffer.from(text).toString('base64') }, sourceText: text,
    pages: [{ page: 1, blocks: [{ id: 'b1', kind: 'text', text, sourceIndex: 0, sourceType: 'prepared-text', bbox: null }] }] }));
  const configuration = PersonalAgentConfigurationSchema.parse({ modelId: 'durable-fixture', thinkingLevel: 'off',
    resources: { prompt: null, enabledSkills: [] }, extensions: { enabledExtensions: [] }, tools: ['read_invoice_document'],
    workingDirectory: null, preferences: '' });
  const created = await database.transaction(scope => {
    const agent = need(scope.personalAgents.ensureDefault(configuration, at));
    const receipt = need(scope.invoiceWorks.create({ personalAgentId: agent.personalAgentId, expectedAgentRevision: agent.revision,
      requestId: 'create-master-phase-guard', goal: 'Review two fixed invoices.',
      documents: [need(scope.documents.get(1)).documentRef, secondDocument.documentRef] }, { at, admission: { kind: 'ready' } }));
    const view = need(scope.invoiceWorks.get({ view: 'work', workId: receipt.workId, limit: 100 }));
    if (view.view !== 'work') throw Error('Expected the fixed member page.');
    const jobs = view.items.map(item => need(scope.invoiceWorks.prepareItemJob({ workId: receipt.workId,
      itemId: item.itemId, expectedRevision: item.revision, at })));
    return { agent, receipt, jobs };
  });
  if (!('attempt' in created.receipt.execution) || created.receipt.execution.attempt === null) throw Error('Expected the admitted product attempt.');
  const attemptId = created.receipt.execution.attempt.attemptId;
  const requireRuntime = createRequire(new URL('../../../packages/runtime-durable/package.json', import.meta.url));
  const version = (name: string) => z.object({ version: z.string() }).passthrough()
    .parse(JSON.parse(readFileSync(requireRuntime.resolve(`${name}/package.json`), 'utf8'))).version;
  const sdk = { durable: version('@earendil-works/pi-durable'), ai: version('@earendil-works/pi-ai'), chord: version('@earendil-works/chord') };
  const candidate = CandidateDraftSchema.parse({ fields: Object.fromEntries(invoiceHeaderFields.map(name => [name,
    { raw: null, normalized: null, state: 'missing', alternatives: [], sources: [] }])), lines: [], notes: [] });
  const saved = [];
  for (const job of created.jobs) {
    // Existing business component producers supply the candidate; this is not SDK generation or delivery evidence.
    saved.push(await database.transaction(scope => {
      let workspace = need(scope.workspace.read(at));
      workspace = need(scope.workspace.update({ expectedRevision: workspace.revision, change: { kind: 'job', jobId: job.jobId }, at },
        value => database.verify(value, scope)));
      if (workspace.sessionId === null || workspace.sessionId !== database.session.sessionId)
        throw Error('The component candidate requires the original selected legacy Session.');
      const config = { ...database.config, sdk: { codingAgent: version('@earendil-works/pi-coding-agent'), ai: sdk.ai } };
      const run = need(scope.runs.createWorkspaceAgent({ sessionId: database.session.sessionId,
        expected: { revision: workspace.revision, sessionId: workspace.sessionId, documentRef: workspace.documentRef,
          jobId: workspace.jobId, candidateRef: workspace.candidateRef }, goalMode: 'save-candidate', text: 'Controlled component candidate.',
        messageTimestamp: Date.parse(at), goal: job.goal, config, usage: database.usage, cleanup: database.cleanup, createdAt: at },
      value => database.verify(value, scope)));
      const frozen = { ...config, goalMode: 'save-candidate', workspaceContext: run.workspaceContext };
      need(scope.runs.start(run.runId, frozen, at));
      const nativeToolCallId = `component-save-${job.jobId}`, args = { documentId: job.documentRef.id, candidate };
      const call = need(scope.toolCalls.request({ context: null, runId: run.runId, sessionId: database.session.sessionId,
        nativeToolCallId, toolName: 'save_invoice_candidate', toolVersion: '1', effect: 'LOCAL_WRITE', rawArguments: args, requestedAt: at }));
      need(scope.toolCalls.fixArguments({ toolCallId: call.toolCallId, finalArguments: args }));
      need(scope.toolCalls.start({ toolCallId: call.toolCallId, startedAt: at }));
      const result = need(scope.candidates.save({ runId: run.runId, sessionId: database.session.sessionId, nativeToolCallId,
        documentId: job.documentRef.id, candidate, checks: [], issues: [], at }));
      need(scope.toolCalls.finish({ toolCallId: call.toolCallId, result: { version: 1, status: 'succeeded',
        committedCandidateId: result.receipt.candidateId, data: result.receipt },
        cleanup: { version: 1, stopped: true, stopReason: 'tool-completed', errors: [] }, endedAt: at, stoppedAt: at }));
      need(scope.runs.finish(run.runId, { status: 'completed', output: { version: 1, text: 'Component save.', partial: false,
        stopReason: 'stop', responseId: null, responseModel: null,
        agent: { nativeSessionId: database.session.nativeSessionId, turnCount: 0, modelCallCount: 0 } }, error: null,
        usage: database.usage, tokens: { inputTokens: null, outputTokens: null, totalTokens: null, cost: null, usageComplete: false },
        cleanup: { ...database.cleanup, stopped: true, stopReason: 'component-completed' }, endedAt: at, stoppedAt: at, durationMs: 0 }));
      workspace = need(scope.workspace.read(at));
      need(scope.workspace.selectCandidate({ jobId: job.jobId, candidateId: result.receipt.candidateId,
        expectedCandidateId: need(scope.jobs.get(job.jobId)).currentCandidateId, expectedRevision: workspace.revision, at }));
      return { jobId: job.jobId, candidateId: result.receipt.candidateId };
    }));
  }
  const [first, second] = saved;
  if (!first || !second) throw Error('Expected both original business candidates.');
  const select = (jobId: number) => database.transaction(scope => {
    const workspace = need(scope.workspace.read(at));
    return need(scope.workspace.update({ expectedRevision: workspace.revision, change: { kind: 'job', jobId }, at },
      value => database.verify(value, scope)));
  });
  const before = await select(first.jobId), rollback = Error('Rollback the legitimate pre-Master decision probe.');
  await expect(database.transaction(scope => {
    need(scope.candidates.reject({ operationRef: 'before-master-probe', ...first, expectedCandidateId: first.candidateId,
      expectedRevision: before.revision, reason: 'Explicit component decision', at }));
    throw rollback;
  })).rejects.toBe(rollback);
  const budget = await database.read(scope => {
    const row = scope.db.query<{ budget_json: string }, [number]>('SELECT budget_json FROM invoice_works WHERE id=?').get(created.receipt.workId);
    if (!row) throw Error('Expected the original Work budget.'); return DurableWorkBudgetSchema.parse(JSON.parse(row.budget_json));
  });
  const config = DurableRunConfigSnapshotSchema.parse({ version: 3, runtimeKind: 'durable', name: 'Master phase guard', revision: 1,
    requestedModel: { provider: 'durable-fixture', model: 'explicit-model' }, resolvedModel: null, api: null, endpoint: null, sdk,
    parameters: { maxRetries: 0, maxRetryDelayMs: 1000 }, ...budget, durable: { workId: created.receipt.workId, attemptId,
      configurationRevision: created.agent.revision }, resources: configuration.resources, extensions: configuration.extensions, workingDirectory: null });
  const master = need(await database.transaction(scope => scope.runs.createDurable({ workId: created.receipt.workId, attemptId,
    input: { version: 1, goal: 'Review two fixed invoices.', text: 'Review two fixed invoices.', messageTimestamp: Date.parse(at) },
    config, usage: database.usage, cleanup: database.cleanup, createdAt: at })));
  const phase = need(await database.transaction(scope => {
    const view = need(scope.invoiceWorks.get({ view: 'work', workId: created.receipt.workId, limit: 100 }));
    if (view.view !== 'work') throw Error('Expected the fixed member page.');
    const item = view.items.find(value => value.jobId === first.jobId); if (!item) throw Error('Expected the real prepared Job association.');
    return scope.invoiceWorks.freezePhase({ workId: created.receipt.workId, attemptId, itemId: item.itemId, requestId: 'original-master-phase', kind: 'prompt',
      basis: { configurationRevision: created.agent.revision, contextSnapshotId: null, inputIds: [], documentRefs: [item.documentRef], itemRevision: item.revision }, at });
  }));
  expect(await database.read(scope => scope.runs.get(master))).toMatchObject({ ok: true,
    data: { kind: 'agent', runtimeKind: 'durable', jobId: null, status: 'created', scope: { version: 4 } } });
  expect(await database.transaction(scope => scope.candidates.reject({ operationRef: 'blocked-by-original-master', ...first,
    expectedCandidateId: first.candidateId, expectedRevision: before.revision, reason: 'Explicit component decision', at })))
    .toMatchObject({ ok: false, error: { code: 'state_conflict', category: 'runtime' } });
  const other = await select(second.jobId);
  expect(await database.transaction(scope => scope.candidates.reject({ operationRef: 'unrelated-invoice-decision', ...second,
    expectedCandidateId: second.candidateId, expectedRevision: other.revision, reason: 'Explicit other invoice decision', at })))
    .toMatchObject({ ok: true, data: { candidate: { status: 'rejected' } } });
  expect(await database.read(scope => scope.candidates.readByJob({ jobId: first.jobId, candidateId: first.candidateId })))
    .toMatchObject({ ok: true, data: { candidate: { status: 'generated' } } });
  expect(await database.read(scope => scope.db.query('SELECT closed_at FROM invoice_work_phases WHERE id=?').get(phase.phaseId))).toEqual({ closed_at: null });
  expect(await database.read(scope => scope.db.query('SELECT COUNT(*) AS count FROM tool_calls WHERE run_id=?').get(master))).toEqual({ count: 0 });
});
