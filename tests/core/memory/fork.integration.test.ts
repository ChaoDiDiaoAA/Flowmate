import { expect, it } from 'bun:test';
import { InMemoryCredentialStore } from '@earendil-works/pi-ai';
import { SessionManager } from '@earendil-works/pi-coding-agent';
import { PiAgentAdapter } from '../../../packages/runtime-pi/src/session.ts';
import { openDatabase } from '../../../packages/core/src/storage/database.ts';
import { SessionService, ensureNativeSession } from '../../../packages/core/src/sessions/service.ts';
import { RuntimeService } from '../../../packages/core/src/runtime/service.ts';
import { ContextService } from '../../../packages/core/src/context/service.ts';
import { appError, fail, ok, ContextSnapshotJsonSchema, type ForkSessionRequest, type NativeSessionEntry, type Result, type RuntimeState } from '@flowmate/contracts';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { readdirSync } from 'node:fs';
import { deferCleanup, mkdtempSync } from '../../support/resources.ts';

const at = '2026-10-04T00:00:00.000Z';
function need<T>(result: Result<T>): T { if (!result.ok) throw new Error(JSON.stringify(result.error)); return result.data; }
const user = (id: string, parentId: string | null = null): NativeSessionEntry => ({ type: 'message', id, parentId, timestamp: at,
  message: { role: 'user', content: id, timestamp: 1 } });
function fixture(entries: NativeSessionEntry[] = [user('a'), user('b', 'a')]) {
  const root = mkdtempSync(join(tmpdir(), 'flowmate-p9-fork-'));
  const paths = { root, databaseFile: join(root, 'test.sqlite'), logsDir: join(root, 'logs'), artifactsDir: join(root, 'artifacts'),
    outputsDir: join(root, 'outputs'), runtimeDir: join(root, 'runtime') };
  const store = need(openDatabase(paths)); deferCleanup(() => store.close());
  let requests = 0, prepares = 0;
  const agent = new PiAgentAdapter({ cwd: root, agentDir: paths.runtimeDir, credentials: new InMemoryCredentialStore(),
    fetch: async () => { requests++; throw new Error('Unexpected fork HTTP'); } });
  deferCleanup(async () => { await agent.close(); });
  agent.prepare = async () => { prepares++; throw new Error('Unexpected fork prepare'); };
  const header = SessionManager.inMemory(root).getHeader()!;
  const session = need(store.sessions.create({ nativeSessionId: header.id, title: 'Source', at,
    nativeHistory: { storageVersion: 1, header, entries, leafId: entries.at(-1)!.id, unusable: false } }));
  let runtime: RuntimeState = { active: null, blocked: false, error: null };
  const service = new SessionService(store.sessions, agent, () => runtime, () => at, store.runs, store.memory);
  const request: ForkSessionRequest = { sourceSessionId: session.sessionId, expected: need(store.memory.load(session.sessionId))!.commit,
    targetEntryId: entries.at(-1)!.id, title: 'Fork', clientOperationId: crypto.randomUUID() };
  const published: unknown[] = []; store.runtimeEventStore.onCommitted(refs => published.push(refs));
  const quiet = () => { expect(requests).toBe(0); expect(prepares).toBe(0); expect(published).toEqual([]);
    expect(store.db.query('PRAGMA foreign_key_check').all()).toEqual([]); expect(store.db.inTransaction).toBe(false); };
  return { root, store, agent, service, session, request, quiet, published, setRuntime: (value: RuntimeState) => { runtime = value; } };
}
function facts(f: ReturnType<typeof fixture>) {
  const tables = f.store.db.query<{ name: string }, []>("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name").all();
  return Object.fromEntries(tables.map(({ name }) => [name, f.store.db.query(`SELECT * FROM "${name}" ORDER BY rowid`).all()]));
}
function sourceFacts(f: ReturnType<typeof fixture>) {
  return { session: f.store.db.query('SELECT * FROM sessions WHERE id=?').get(f.session.sessionId),
    header: f.store.db.query('SELECT * FROM session_native_history WHERE session_id=?').get(f.session.sessionId),
    entries: f.store.db.query('SELECT * FROM session_native_entries WHERE session_id=? ORDER BY sequence').all(f.session.sessionId) };
}
function noExecutionChanges(before: ReturnType<typeof facts>, f: ReturnType<typeof fixture>) {
  const after = facts(f);
  for (const table of Object.keys(before).filter(name => !['sessions', 'session_native_history', 'session_native_entries', 'session_forks'].includes(name)))
    expect(after[table]).toEqual(before[table]);
  f.quiet();
}

// Seed genuine P8 ownership through the ContextRepository and MemoryStore, not NULL legacy associations.
function appendOwnedInput(f: ReturnType<typeof fixture>, sessionId: number, entryId: string) {
  const row = need(f.store.sessions.get(sessionId)), db = f.store.db;
  const config = { version: 1, name: 'fixture', revision: 1, requestedModel: { provider: 'fixture', model: 'fixture' },
    resolvedModel: null, api: null, endpoint: null, sdk: { codingAgent: '0.85.1', ai: '0.85.1' },
    parameters: { maxRetries: 0, maxRetryDelayMs: 100 }, limits: { timeoutMs: 1000, stopGraceMs: 100 },
    native: { authSource: 'unknown', modelsSelection: null }, contextPolicyVersion: 'p8-context-v1',
    agent: { policyVersion: 'p2-invoice-chat-v1', nativeSessionId: row.nativeSessionId, systemPrompt: 'fixture',
      thinkingLevel: 'off', resourcePolicy: 'none', historyPolicy: 'memory-only', maxContextBytes: 524288,
      maxOutputBytes: 262144, maxAssistantContentBytes: 524288, maxModelCalls: 1, sessionRetry: false } };
  const runId = Number(db.query(`INSERT INTO runs(kind,session_id,scope_json,status,goal,input_json,config_json,cleanup_json,usage_json,
    context_observations_json,created_at) VALUES('agent',?,'{"version":1,"mode":"chat-text","toolNames":[],"resourcePaths":[]}',
    'running','Explain',?,?,?,?,'{"version":1,"requests":[]}',?)`).run(sessionId,
    JSON.stringify({ version: 1, goal: 'Explain', text: entryId, messageTimestamp: 1 }), JSON.stringify(config),
    JSON.stringify({ version: 1, stopped: false, stopReason: null, errors: [], lateObservationRequired: false }),
    JSON.stringify({ version: 1, source: 'unknown', reason: 'fixture', sdkValues: null, attempts: null, attemptsComplete: false,
      costSource: null, updatedAt: at }), at).lastInsertRowid);
  const json = ContextSnapshotJsonSchema.parse({ version: 1, policyVersion: 'p8-context-v1', text: entryId, goalMode: 'answer',
    workingDirectory: null, workspaceContext: null, allowedDocumentIds: [], allowedArtifactIds: [], resourcePolicy: 'none',
    modelProjection: { taskGoal: 'Explain', candidate: null, fragments: [], issues: [], gaps: [] },
    budgets: { projectionBytes: 65536, fragmentBytes: 4096, fragments: 32, issueCount: 20, snapshotBytes: 262144 } });
  const snapshot = need(f.store.runtimeEventStore.withTransaction(() => f.store.context.appendInTransaction({ runId, sessionId, jobId: null, json, at })));
  const content = { version: 2, text: entryId, promptText: entryId, workspaceContext: null, workspaceInput: null,
    allowedDocumentIds: [], allowedArtifactIds: [] };
  const inputId = Number(db.query(`INSERT INTO session_inputs(session_id,client_sequence,mode,goal_mode,request_hash,run_id,
    context_snapshot_id,content_json,status,processing_status,created_at,updated_at)
    VALUES(?,1,'prompt','answer',?,?,?,?,'queued','pending',?,?)`).run(sessionId, 'a'.repeat(64), runId, snapshot.id, JSON.stringify(content), at, at).lastInsertRowid);
  const saved = need(f.store.memory.load(sessionId))!;
  need(f.store.memory.commit({ sessionId, expected: saved.commit, header: saved.history.header,
    appendEntries: [user(entryId, saved.history.leafId)], leafId: entryId, unusable: false, contexts: [{ entryId, runId, inputId }] }));
  need(f.store.context.bindRequest({ binding: { runId, sessionId, nativeSessionId: row.nativeSessionId, requestSequence: 1, callSequence: 1,
    inputId, snapshotId: snapshot.id, includedBindings: [{ originRunId: runId, inputId, snapshotId: snapshot.id, nativeEntryId: entryId }],
    includedToolResults: [], includedNativeContexts: [] }, api: 'openai-responses', transport: 'observed-fetch', at }));
  db.query("UPDATE runs SET status='failed',ended_at=?,error_json=? WHERE id=?").run(at,
    JSON.stringify({ version: 1, code: 'agent_execution_failed', category: 'runtime', message: 'fixture', retryable: false }), runId);
  f.published.length = 0;
  return { runId, inputId, snapshotId: snapshot.id, nativeEntryId: entryId };
}

// Missing atomic creation, early registration, or copying all branches breaks these independent identities and closure assertions.
it('P9 T06 creates a new native identity with the exact reference closure', async () => {
  const base = (id: string, parentId: string | null) => ({ id, parentId, timestamp: at });
  const entries: NativeSessionEntry[] = [user('a'), user('unrelated'), user('ref', 'a'),
    { ...base('compact', 'a'), type: 'compaction', summary: 'saved summary', firstKeptEntryId: 'ref', tokensBefore: 10 },
    { ...base('summary', 'compact'), type: 'branch_summary', summary: 'branch summary', fromId: 'ref' },
    { ...base('message-summary', 'summary'), type: 'message', message: { role: 'branchSummary', summary: 'message summary', fromId: 'ref', timestamp: 2 } },
    { ...base('label', 'ref'), type: 'label', targetId: 'ref', label: 'reference' },
    { ...base('label-label', 'label'), type: 'label', targetId: 'label', label: 'fixed point' }, user('selected', 'message-summary')];
  const f = fixture(entries), before = facts(f), source = sourceFacts(f), files = readdirSync(f.root);
  const build = f.agent.buildForkSessionHistory.bind(f.agent); let builtId = '';
  f.agent.buildForkSessionHistory = input => { const result = build(input); if (result.ok) { builtId = result.data.header.id;
    expect(f.agent.inspect(builtId).availability).toBe('missing'); expect(facts(f)).toEqual(before); } return result; };
  const result = need(await f.service.forkSession(f.request));
  const target = need(f.store.memory.load(result.session.sessionId))!;
  expect(result.session.sessionId).not.toBe(f.session.sessionId); expect(result.session.nativeSessionId).toBe(builtId);
  expect(builtId).not.toBe(f.session.nativeSessionId); expect(target.history.header.parentSession).toBeUndefined();
  expect(target.history.header.cwd).toBe(f.root); expect(result.commit).toEqual({ commitRevision: 1, entryCount: 8, leafId: 'selected' });
  expect(target.history.entries.map(entry => entry.id)).toEqual(['a', 'ref', 'compact', 'summary', 'message-summary', 'label', 'label-label', 'selected']);
  expect(target.history.entries).toEqual(entries.filter(entry => entry.id !== 'unrelated'));
  expect(f.store.db.query('SELECT sequence,run_id FROM session_native_entries WHERE session_id=? ORDER BY sequence').all(result.session.sessionId))
    .toEqual(Array.from({ length: 8 }, (_, sequence) => ({ sequence, run_id: null })));
  const sourceManager = SessionManager.inMemory(f.root, undefined, [target.history.header, ...entries] as any); sourceManager.branch('selected');
  const targetManager = SessionManager.inMemory(f.root, undefined, [target.history.header, ...target.history.entries] as any); targetManager.branch('selected');
  expect(targetManager.buildSessionContext()).toEqual(sourceManager.buildSessionContext()); expect(targetManager.getSessionFile()).toBeUndefined();
  expect(sourceFacts(f)).toEqual(source); expect(readdirSync(f.root)).toEqual(files);
  expect(need(f.agent.exportSession(builtId))).toEqual(target.history);
  expect(need(f.store.sessions.loadHistoryForContext(result.session.sessionId)).seed.origins.every(origin => origin.originSessionId === f.session.sessionId)).toBe(true);
  noExecutionChanges(before, f);
});

it.each(['session', 'header', 'entry-first', 'entry-last', 'leaf', 'revision', 'provenance', 'foreign-key', 'commit'] as const)
('P9 T06 commits a fork atomically and leaves no target on failure: %s', async fault => {
  const f = fixture(), db = f.store.db;
  const originalTransaction = f.store.runtimeEventStore.withTransaction.bind(f.store.runtimeEventStore);
  const target = f.session.sessionId + 1;
  const windows = { session: ['INSERT', 'sessions', `NEW.title='Fork'`], header: ['INSERT', 'session_native_history', `NEW.session_id=${target}`],
    'entry-first': ['INSERT', 'session_native_entries', `NEW.session_id=${target} AND NEW.sequence=0`],
    'entry-last': ['INSERT', 'session_native_entries', `NEW.session_id=${target} AND NEW.sequence=1`],
    leaf: ['UPDATE OF leaf_id', 'session_native_history', `NEW.session_id=${target}`],
    revision: ['UPDATE OF commit_revision', 'session_native_history', `NEW.session_id=${target}`],
    provenance: ['INSERT', 'session_forks', `NEW.client_operation_id='${f.request.clientOperationId}'`] };
  let completed = false;
  if (fault === 'commit' || fault === 'foreign-key') {
    db.exec(`CREATE TABLE fault_parent(id INTEGER PRIMARY KEY); CREATE TABLE fault_child(id INTEGER PRIMARY KEY, parent_id INTEGER REFERENCES fault_parent(id) ${fault === 'commit' ? 'DEFERRABLE INITIALLY DEFERRED' : ''});
      CREATE TRIGGER fork_fault AFTER INSERT ON session_forks WHEN NEW.client_operation_id='${f.request.clientOperationId}' BEGIN INSERT INTO fault_child VALUES(1,404); END;`);
    f.store.runtimeEventStore.withTransaction = write => originalTransaction(() => { const value = write(); completed = true;
      expect(db.inTransaction).toBe(true); expect(db.query('SELECT * FROM session_forks').all()).toHaveLength(1);
      expect(db.query('SELECT entry_count,leaf_id,commit_revision FROM session_native_history WHERE session_id=?').get(target))
        .toEqual({ entry_count: 2, leaf_id: 'b', commit_revision: 1 });
      expect(db.query('PRAGMA foreign_key_check').all()).toHaveLength(1); return value; });
  } else { const [event, table, condition] = windows[fault];
    db.exec(`CREATE TRIGGER fork_fault BEFORE ${event} ON ${table} WHEN ${condition} BEGIN SELECT RAISE(ABORT,'fork fault'); END`); }
  const before = facts(f), source = sourceFacts(f); let builtId = '';
  const build = f.agent.buildForkSessionHistory.bind(f.agent);
  f.agent.buildForkSessionHistory = input => { const result = build(input); if (result.ok) builtId = result.data.header.id; return result; };
  expect(await f.service.forkSession(f.request)).toMatchObject({ ok: false });
  expect(completed).toBe(fault === 'commit'); expect(facts(f)).toEqual(before); expect(sourceFacts(f)).toEqual(source);
  expect(f.agent.inspect(builtId).availability).toBe('missing'); f.quiet();
  console.log('P9 T06 rollback', JSON.stringify({ fault, completed, source, tables: Object.fromEntries(Object.entries(before).map(([table, rows]) => [table, rows.length])), http: 0, published: f.published }));
  db.exec('DROP TRIGGER fork_fault'); f.store.runtimeEventStore.withTransaction = originalTransaction;
  if (fault === 'commit' || fault === 'foreign-key') db.exec('DROP TABLE fault_child; DROP TABLE fault_parent');
  const retried = need(await f.service.forkSession(f.request));
  expect(retried.commit).toEqual({ commitRevision: 1, entryCount: 2, leafId: 'b' });
  expect(db.query('SELECT * FROM session_forks').all()).toHaveLength(1); expect(sourceFacts(f)).toEqual(source); f.quiet();
});

it('P9 T06 returns the original target for the same normalized operation and its current commit', async () => {
  const f = fixture(), before = facts(f);
  const request = { ...f.request, title: '  Fork  ', clientOperationId: f.request.clientOperationId.toUpperCase() };
  const first = need(await f.service.forkSession(request));
  const source = need(f.store.memory.load(f.session.sessionId))!;
  need(f.store.memory.commit({ sessionId: f.session.sessionId, expected: source.commit, header: source.history.header,
    appendEntries: [user('later', 'b')], leafId: 'later', unusable: false, contexts: [] }));
  await f.agent.releaseSession(first.session.nativeSessionId);
  const target = need(f.store.memory.load(first.session.sessionId))!;
  const latest = need(f.store.memory.commit({ sessionId: first.session.sessionId, expected: target.commit, header: target.history.header,
    appendEntries: [user('target-local', 'b')], leafId: 'target-local', unusable: false, contexts: [] }));
  const repeated = need(await f.service.forkSession(f.request));
  expect(repeated.session.sessionId).toBe(first.session.sessionId); expect(repeated.commit).toEqual(latest); expect(repeated.selectedEntryId).toBe('b');
  expect(need(f.agent.exportSession(first.session.nativeSessionId)).leafId).toBe('target-local');
  for (const change of [{ title: 'Different' }, { targetEntryId: 'a' }, { expected: { ...f.request.expected, commitRevision: 0 } }])
    expect(await f.service.forkSession({ ...f.request, ...change })).toMatchObject({ ok: false, error: { code: 'state_conflict' } });
  expect(f.store.db.query('SELECT * FROM sessions').all()).toHaveLength(2); noExecutionChanges(before, f);
});

it.each(['restore', 'watch'] as const)('P9 T06 keeps the committed target after postcommit %s failure', async fault => {
  const f = fixture(), before = facts(f), original = fault === 'restore' ? f.agent.restoreSession : f.agent.watchSession;
  if (fault === 'restore') f.agent.restoreSession = () => fail(appError('session_history_unavailable', 'session', 'Install fault'));
  else f.agent.watchSession = () => fail(appError('session_history_unavailable', 'session', 'Install fault'));
  expect(await f.service.forkSession(f.request)).toMatchObject({ ok: false, error: { code: 'session_history_unavailable' } });
  const rows = f.store.db.query<{ target_session_id: number }, []>('SELECT target_session_id FROM session_forks').all(); expect(rows).toHaveLength(1);
  if (fault === 'restore') f.agent.restoreSession = original as typeof f.agent.restoreSession;
  else f.agent.watchSession = original as typeof f.agent.watchSession;
  expect(need(await f.service.forkSession(f.request)).session.sessionId).toBe(rows[0]!.target_session_id);
  expect(f.store.db.query('SELECT unusable FROM session_native_history').all()).toEqual([{ unusable: 0 }, { unusable: 0 }]);
  noExecutionChanges(before, f);
});

it('P9 T06 keeps a deletion tombstone and never recreates its old operation', async () => {
  const f = fixture(), created = need(await f.service.forkSession(f.request));
  expect(() => f.store.db.exec('UPDATE session_forks SET target_session_id=NULL')).toThrow();
  expect(need(await f.service.deleteSession(created.session.sessionId)).disposition).toBe('permanent');
  const before = facts(f);
  expect(await f.service.forkSession(f.request)).toMatchObject({ ok: false, error: { code: 'session_history_unavailable' } });
  expect(facts(f)).toEqual(before);
  const next = need(await f.service.forkSession({ ...f.request, clientOperationId: crypto.randomUUID() }));
  expect(next.session.sessionId).not.toBe(f.session.sessionId); expect(f.store.db.query('SELECT * FROM session_forks').all()).toHaveLength(2); f.quiet();
});

it('P9 T06 retains live sources but deletes a source with only its own tombstones', async () => {
  const f = fixture(), child = need(await f.service.forkSession(f.request));
  expect(need(await f.service.deleteSession(f.session.sessionId)).disposition).toBe('hidden');
  expect(need(f.store.sessions.get(f.session.sessionId)).hasBusinessHistory).toBe(false);
  expect(need(await f.service.forkSession(f.request)).session.sessionId).toBe(child.session.sessionId);
  expect(need(await f.service.deleteSession(child.session.sessionId)).disposition).toBe('permanent');
  f.store.db.exec(`CREATE TRIGGER reject_source BEFORE DELETE ON sessions WHEN OLD.id=${f.session.sessionId} BEGIN SELECT RAISE(ABORT,'delete fault'); END`);
  expect(await f.service.deleteSession(f.session.sessionId)).toMatchObject({ ok: false });
  expect(f.store.db.query('SELECT target_session_id FROM session_forks').all()).toEqual([{ target_session_id: null }]);
  f.store.db.exec('DROP TRIGGER reject_source');
  expect(need(await f.service.deleteSession(f.session.sessionId)).disposition).toBe('permanent');
  expect(f.store.db.query('SELECT * FROM session_forks').all()).toEqual([]); f.quiet();
});

it.each(['revision', 'revoke', 'body'] as const)('P9 T06 rejects raced fork sources: %s', async race => {
  const f = fixture(), build = f.agent.buildForkSessionHistory.bind(f.agent);
  let afterRace: ReturnType<typeof facts>;
  f.agent.buildForkSessionHistory = input => { const built = build(input);
    if (race === 'revision') f.store.db.exec('UPDATE session_native_history SET commit_revision=commit_revision+1');
    if (race === 'revoke') f.store.db.exec(`UPDATE sessions SET metadata_json='{"version":1,"model_use_blocked":{"reason":"document_use_revoked","documentIds":[1],"at":"${at}"}}'`);
    if (race === 'body') f.store.db.exec(`UPDATE session_native_entries SET entry_json=json_set(entry_json,'$.message.content','changed') WHERE entry_id='a'`);
    afterRace = facts(f); return built; };
  expect(await f.service.forkSession(f.request)).toMatchObject({ ok: false });
  expect(facts(f)).toEqual(afterRace!); f.quiet();
});

it('P9 T06 resolves nested original and parent-local owners and rejects revoked ancestor retrieval', async () => {
  const f = fixture(), first = need(await f.service.forkSession(f.request));
  const parent = need(f.store.memory.load(first.session.sessionId))!;
  const commit = need(f.store.memory.commit({ sessionId: first.session.sessionId, expected: parent.commit, header: parent.history.header,
    appendEntries: [user('local', 'b')], leafId: 'local', contexts: [], unusable: false }));
  const request = { ...f.request, sourceSessionId: first.session.sessionId, expected: commit, targetEntryId: 'local', clientOperationId: crypto.randomUUID() };
  const nested = need(await f.service.forkSession(request));
  const bundle = need(f.store.sessions.loadHistoryForContext(nested.session.sessionId));
  expect(bundle.seed.origins.map(origin => [origin.nativeEntryId, origin.originSessionId])).toEqual([
    ['a', f.session.sessionId], ['b', f.session.sessionId], ['local', first.session.sessionId]]);
  f.store.db.query('UPDATE sessions SET metadata_json=? WHERE id=?').run(JSON.stringify({ version: 1,
    model_use_blocked: { reason: 'document_use_revoked', documentIds: [1], at } }), f.session.sessionId);
  expect(await f.service.forkSession(request)).toMatchObject({ ok: false, error: { code: 'session_scope_revoked' } });
  expect(ensureNativeSession(f.store.sessions, f.agent, need(f.store.sessions.get(nested.session.sessionId)), f.store.memory))
    .toMatchObject({ ok: false, error: { code: 'session_scope_revoked' } }); f.quiet();
});

// Removing the owning-transaction admission recheck permits a Run or runtime shutdown to overtake detached construction.
it.each(['blocked', 'active'] as const)('P9 T06 rechecks runtime management after detached build: %s', async race => {
  const f = fixture(), before = facts(f), build = f.agent.buildForkSessionHistory.bind(f.agent);
  f.agent.buildForkSessionHistory = input => {
    const built = build(input);
    f.setRuntime(race === 'blocked' ? { active: null, blocked: true, error: null }
      : { active: { runId: 1, sessionId: f.session.sessionId, kind: 'agent' }, blocked: false, error: null });
    return built;
  };
  expect(await f.service.forkSession(f.request)).toMatchObject({ ok: false,
    error: { code: race === 'blocked' ? 'runtime_unusable' : 'session_busy' } });
  expect(facts(f)).toEqual(before); expect(f.service.isManaging(f.session.sessionId)).toBe(false); f.quiet();
});

it('P9 T06 preserves real P8 original and parent-local ownership across nested forks and rejects a new Run after revocation', async () => {
  const f = fixture(), original = appendOwnedInput(f, f.session.sessionId, 'owned-original');
  f.store.db.query(`INSERT INTO tool_calls(run_id,session_id,native_tool_call_id,tool_name,tool_version,effect,args_json,
    delivery_json,cleanup_json,requested_at,context_snapshot_id,request_sequence) VALUES(?,?,'original-call','read_fixture','1','READ',?,?,?,?,?,1)`)
    .run(original.runId, f.session.sessionId, JSON.stringify({ version: 1, raw: {}, final: null }),
      JSON.stringify({ version: 1, state: 'not_attempted', messageObservedAt: null, includedInCallSequence: null, requestDispatchedAt: null, error: null }),
      JSON.stringify({ version: 1, stopped: false, stopReason: null, errors: [] }), at, original.snapshotId);
  f.store.db.query('INSERT INTO workspace(id,active_session_id,revision,created_at,updated_at) VALUES(1,?,17,?,?)').run(f.session.sessionId, at, at);
  const firstRequest = { ...f.request, expected: need(f.store.memory.load(f.session.sessionId))!.commit, targetEntryId: original.nativeEntryId };
  const beforeFirst = facts(f), first = need(await f.service.forkSession(firstRequest)); noExecutionChanges(beforeFirst, f);
  await f.agent.releaseSession(first.session.nativeSessionId);
  const local = appendOwnedInput(f, first.session.sessionId, 'owned-parent');
  const request = { ...firstRequest, sourceSessionId: first.session.sessionId, expected: need(f.store.memory.load(first.session.sessionId))!.commit,
    targetEntryId: local.nativeEntryId, clientOperationId: crypto.randomUUID() };
  const before = facts(f), nested = need(await f.service.forkSession(request));
  const bundle = need(f.store.sessions.loadHistoryForContext(nested.session.sessionId));
  expect(bundle.seed.inputs).toEqual([
    { nativeEntryId: 'a', originRunId: null, inputId: null, snapshotId: null },
    { nativeEntryId: 'b', originRunId: null, inputId: null, snapshotId: null },
    { nativeEntryId: 'owned-original', originRunId: original.runId, inputId: original.inputId, snapshotId: original.snapshotId },
    { nativeEntryId: 'owned-parent', originRunId: local.runId, inputId: local.inputId, snapshotId: local.snapshotId }]);
  expect(bundle.seed.origins.filter(origin => origin.originRunId !== null)).toEqual([
    { nativeEntryId: 'owned-original', originSessionId: f.session.sessionId, originRunId: original.runId },
    { nativeEntryId: 'owned-parent', originSessionId: first.session.sessionId, originRunId: local.runId }]);
  expect(f.store.db.query('SELECT run_id FROM session_native_entries WHERE session_id=?').all(nested.session.sessionId))
    .toEqual([{ run_id: null }, { run_id: null }, { run_id: null }, { run_id: null }]);
  expect(f.store.db.query('SELECT * FROM session_inputs WHERE session_id=?').all(nested.session.sessionId)).toEqual([]);
  expect(bundle.history!.storageVersion).toBe(1); expect(bundle.history!.header.version).toBe(3);
  expect(bundle.commit).toEqual({ commitRevision: 1, entryCount: 4, leafId: 'owned-parent' });
  expect(f.store.db.query('SELECT client_sequence FROM session_inputs ORDER BY id').all()).toEqual([{ client_sequence: 1 }, { client_sequence: 1 }]);
  expect(f.store.db.query('SELECT revision,active_session_id FROM workspace').get()).toEqual({ revision: 17, active_session_id: f.session.sessionId });
  expect(f.store.db.query('SELECT * FROM runtime_events').all().length).toBeGreaterThan(0);
  noExecutionChanges(before, f);
  expect(need(await f.service.deleteSession(f.session.sessionId)).disposition).toBe('hidden');
  expect(need(f.store.sessions.get(f.session.sessionId)).hasBusinessHistory).toBe(true);
  const retained = facts(f);
  expect(need(await f.service.forkSession(request)).session.sessionId).toBe(nested.session.sessionId);
  expect(facts(f)).toEqual(retained);
  f.store.db.query('UPDATE sessions SET metadata_json=? WHERE id=?').run(JSON.stringify({ version: 1,
    model_use_blocked: { reason: 'document_use_revoked', documentIds: [1], at } }), f.session.sessionId);
  const revoked = facts(f);
  expect(await f.service.forkSession(request)).toMatchObject({ ok: false, error: { code: 'session_scope_revoked' } });
  expect(await f.service.forkSession({ ...request, clientOperationId: crypto.randomUUID() }))
    .toMatchObject({ ok: false, error: { code: 'session_scope_revoked' } });
  const runtime = new RuntimeService({ memory: f.store.memory, runs: f.store.runs, sessions: f.store.sessions, sessionInputs: f.store.sessionInputs,
    contextRepository: f.store.context, agent: f.agent, contextService: new ContextService({ store: f.store,
      materials: { inspectParsed() { throw new Error('Unexpected material read'); } } }),
    provider: { async prepare() { throw new Error('Unexpected Provider'); }, async close() { return { stopped: true, closed: true, errors: [] }; } },
    log: { write() {}, async close() {} }, now: () => at, monotonicNow: () => performance.now() });
  deferCleanup(async () => { await runtime.close(); });
  expect(await runtime.start({ sessionId: nested.session.sessionId, text: 'Must not run', timeoutMs: 1000, stopGraceMs: 100,
    config: { version: 1, name: 'Fixture', revision: 1, modelRef: { provider: 'fixture', model: 'fixture' },
      native: { authPath: join(f.root, 'unused.json'), modelsPath: null }, parameters: { maxRetries: 0, maxRetryDelayMs: 100 } } }))
    .toMatchObject({ ok: false, error: { code: 'session_scope_revoked' } });
  noExecutionChanges(revoked, f);
});

it('P9 T06 preserves a committed target when its first postcommit recovery read fails', async () => {
  const f = fixture(), before = facts(f), original = f.store.sessions.readHistorySnapshot.bind(f.store.sessions);
  f.store.sessions.readHistorySnapshot = (id, read, writeInputIds) => {
    if (!f.store.db.inTransaction && id !== f.session.sessionId)
      return fail(appError('storage_read_failed', 'storage', 'Postcommit seed read failed.', true));
    return original(id, read, writeInputIds);
  };
  expect(await f.service.forkSession(f.request)).toMatchObject({ ok: false, error: { code: 'storage_read_failed' } });
  const target = f.store.db.query<{ target_session_id: number }, []>('SELECT target_session_id FROM session_forks').get()!;
  expect(f.store.db.query('SELECT * FROM sessions').all()).toHaveLength(2);
  f.store.sessions.readHistorySnapshot = original;
  expect(need(await f.service.forkSession(f.request)).session.sessionId).toBe(target.target_session_id); noExecutionChanges(before, f);
});

it.each(['hidden', 'revoked', 'unusable'] as const)('P9 T06 repeats only with current target proof: %s', async fault => {
  const f = fixture(), result = need(await f.service.forkSession(f.request)), target = result.session.sessionId;
  if (fault === 'hidden') f.store.db.query('UPDATE sessions SET hidden_at=? WHERE id=?').run(at, target);
  if (fault === 'revoked') f.store.db.query('UPDATE sessions SET metadata_json=? WHERE id=?').run(JSON.stringify({ version: 1,
    model_use_blocked: { reason: 'document_use_revoked', documentIds: [1], at } }), target);
  if (fault === 'unusable') need(f.store.sessions.markHistoryUnusable(target));
  const before = facts(f);
  expect(await f.service.forkSession(f.request)).toMatchObject({ ok: false,
    error: { code: fault === 'hidden' ? 'session_not_found' : fault === 'revoked' ? 'session_scope_revoked' : 'agent_session_unusable' } });
  expect(facts(f)).toEqual(before); f.quiet();
});

// The repository must validate the real SDK output before a NULL copy can acquire legacy status.
it.each(['missing-closure', 'cycle', 'different-json', 'wrong-native-id', 'extra-branch'] as const)
('P9 T06 rejects malformed detached closure: %s', async fault => {
  const f = fixture([user('a'), user('unselected'), user('b', 'a')]), before = facts(f);
  const build = f.agent.buildForkSessionHistory.bind(f.agent);
  f.agent.buildForkSessionHistory = input => {
    const built = build(input); if (!built.ok) return built;
    const history = { ...structuredClone(built.data), entries: [...structuredClone(built.data.entries)] };
    if (fault === 'missing-closure') history.entries.shift();
    if (fault === 'cycle') history.entries[0]!.parentId = 'b';
    if (fault === 'different-json') history.entries[0] = user('a-forged');
    if (fault === 'wrong-native-id') history.header.id = input.source.header.id;
    if (fault === 'extra-branch') history.entries.splice(1, 0, user('unselected'));
    return ok(history);
  };
  expect(await f.service.forkSession(f.request)).toMatchObject({ ok: false, error: { code: 'context_binding_unknown' } });
  expect(facts(f)).toEqual(before); f.quiet();
});

it.each(['missing-closure', 'cycle', 'different-json'] as const)('P9 T06 rejects malformed persisted nested source: %s', async fault => {
  const f = fixture(), first = need(await f.service.forkSession(f.request));
  const db = f.store.db;
  if (fault === 'missing-closure') db.query("DELETE FROM session_native_entries WHERE session_id=? AND entry_id='a'").run(first.session.sessionId);
  if (fault === 'cycle') db.query("UPDATE session_native_entries SET entry_json=json_set(entry_json,'$.parentId','b') WHERE session_id=? AND entry_id='a'").run(first.session.sessionId);
  if (fault === 'different-json') db.query("UPDATE session_native_entries SET entry_json=json_set(entry_json,'$.message.content','forged') WHERE session_id=? AND entry_id='a'").run(first.session.sessionId);
  const before = facts(f);
  expect(await f.service.forkSession(f.request)).toMatchObject({ ok: false, error: { code: 'context_binding_unknown' } });
  expect(await f.service.forkSession({ ...f.request, sourceSessionId: first.session.sessionId, expected: first.commit, clientOperationId: crypto.randomUUID() }))
    .toMatchObject({ ok: false, error: { code: 'context_binding_unknown' } });
  expect(facts(f)).toEqual(before); f.quiet();
});

it.each(['archive', 'hidden', 'delete-pending', 'native-busy', 'native-unusable'] as const)
('P9 T06 rechecks source management between construction and SQL: %s', async race => {
  const f = fixture(), build = f.agent.buildForkSessionHistory.bind(f.agent);
  let raced: ReturnType<typeof facts>;
  f.agent.buildForkSessionHistory = input => {
    const built = build(input);
    if (race === 'archive') f.store.db.exec("UPDATE sessions SET status='archived'");
    if (race === 'hidden') f.store.db.query('UPDATE sessions SET hidden_at=?').run(at);
    if (race === 'delete-pending') f.store.db.exec("UPDATE sessions SET metadata_json=json_set(metadata_json,'$.delete_pending',json('true'))");
    if (race === 'native-busy' || race === 'native-unusable') {
      const inspect = f.agent.inspect.bind(f.agent);
      f.agent.inspect = id => ({ ...inspect(id), availability: race === 'native-busy' ? 'busy' : 'unusable' });
    }
    raced = facts(f); return built;
  };
  const codes = { archive: 'session_archived', hidden: 'session_not_found', 'delete-pending': 'session_delete_incomplete',
    'native-busy': 'session_busy', 'native-unusable': 'agent_session_unusable' };
  expect(await f.service.forkSession(f.request)).toMatchObject({ ok: false, error: { code: codes[race] } });
  expect(facts(f)).toEqual(raced!); expect(f.service.isManaging(f.session.sessionId)).toBe(false); f.quiet();
});

it('P9 T06 rechecks a competing committed operation before rejecting the now-stale source', async () => {
  const f = fixture(), build = f.agent.buildForkSessionHistory.bind(f.agent), before = facts(f);
  const competitor = new SessionService(f.store.sessions, f.agent, () => ({ active: null, blocked: false, error: null }), () => at, f.store.runs, f.store.memory);
  let competing: ReturnType<SessionService['forkSession']>;
  f.agent.buildForkSessionHistory = input => {
    const built = build(input); f.agent.buildForkSessionHistory = build;
    competing = competitor.forkSession(f.request);
    const source = need(f.store.memory.load(f.session.sessionId))!;
    need(f.store.memory.commit({ sessionId: f.session.sessionId, expected: source.commit, header: source.history.header,
      appendEntries: [user('newer', 'b')], leafId: 'newer', unusable: false, contexts: [] }));
    return built;
  };
  const result = need(await f.service.forkSession(f.request)), winner = need(await competing!);
  expect(result.session.sessionId).toBe(winner.session.sessionId);
  expect(f.store.db.query('SELECT * FROM sessions').all()).toHaveLength(2);
  expect(f.store.db.query('SELECT * FROM session_forks').all()).toHaveLength(1); noExecutionChanges(before, f);
});

it('P9 T06 rolls back nested tombstone cleanup while preserving incoming intent and other sessions', async () => {
  const f = fixture(), parent = need(await f.service.forkSession(f.request));
  const childRequest = { ...f.request, sourceSessionId: parent.session.sessionId, expected: parent.commit, clientOperationId: crypto.randomUUID() };
  const child = need(await f.service.forkSession(childRequest));
  const unrelated = need(f.store.sessions.create({ nativeSessionId: 'unrelated-session', title: 'Other', at }));
  const unrelatedRow = need(f.store.sessions.get(unrelated.sessionId));
  need(await f.service.deleteSession(child.session.sessionId));
  f.store.db.exec(`CREATE TRIGGER reject_parent BEFORE DELETE ON sessions WHEN OLD.id=${parent.session.sessionId} BEGIN SELECT RAISE(ABORT,'cleanup failure'); END`);
  let afterPrepare: ReturnType<typeof facts>;
  const release = f.agent.releaseSession.bind(f.agent);
  f.agent.releaseSession = async id => { const result = await release(id); afterPrepare = facts(f); return result; };
  expect(await f.service.deleteSession(parent.session.sessionId)).toMatchObject({ ok: false });
  expect(facts(f)).toEqual(afterPrepare!);
  expect(f.store.db.query('SELECT source_session_id,target_session_id FROM session_forks ORDER BY source_session_id').all())
    .toEqual([{ source_session_id: f.session.sessionId, target_session_id: parent.session.sessionId },
      { source_session_id: parent.session.sessionId, target_session_id: null }]);
  f.store.db.exec('DROP TRIGGER reject_parent');
  expect(need(await f.service.deleteSession(parent.session.sessionId)).disposition).toBe('permanent');
  expect(f.store.db.query('SELECT source_session_id,target_session_id FROM session_forks').all())
    .toEqual([{ source_session_id: f.session.sessionId, target_session_id: null }]);
  expect(await f.service.forkSession(f.request)).toMatchObject({ ok: false, error: { code: 'session_history_unavailable' } });
  expect(need(f.store.sessions.get(unrelated.sessionId))).toEqual(unrelatedRow); f.quiet();
});

it('P9 T06 rejects a persisted active source Run admitted during detached construction', async () => {
  const f = fixture(), owned = appendOwnedInput(f, f.session.sessionId, 'owned');
  const request = { ...f.request, expected: need(f.store.memory.load(f.session.sessionId))!.commit };
  const build = f.agent.buildForkSessionHistory.bind(f.agent);
  let raced: ReturnType<typeof facts>;
  f.agent.buildForkSessionHistory = input => {
    const built = build(input); f.store.db.query("UPDATE runs SET status='running',ended_at=NULL,error_json=NULL WHERE id=?").run(owned.runId);
    raced = facts(f); return built;
  };
  expect(await f.service.forkSession(request)).toMatchObject({ ok: false, error: { code: 'session_busy' } });
  expect(facts(f)).toEqual(raced!); f.quiet();
});
