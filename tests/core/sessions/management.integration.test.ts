import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { describe, expect, it } from 'bun:test';
import { SessionManager } from '@earendil-works/pi-coding-agent';
import { InMemoryCredentialStore } from '@earendil-works/pi-ai';
import { PiAgentAdapter } from '../../../packages/runtime-pi/src/session.ts';
import { openDatabase } from '../../../packages/core/src/storage/database.ts';
import { SessionService, ensureNativeSession } from '../../../packages/core/src/sessions/service.ts';
import { RuntimeService } from '../../../packages/core/src/runtime/service.ts';
import { ContextService } from '../../../packages/core/src/context/service.ts';
import { appError, fail } from '@flowmate/contracts';
import type { AgentPort, AgentRunEvent, NativeContextBindingSeed, NativeSessionHistory, Result, RuntimeState } from '@flowmate/contracts';
import { deferCleanup, mkdtempSync, waitFor } from '../../support/resources.ts';
const at = '2026-10-02T00:00:00.000Z';
function need<T>(result: Result<T>): T { if (!result.ok) throw new Error(result.error.code); return result.data; }
function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'flowmate-p5-management-'));
  const paths = { root, databaseFile: join(root, 'data', 'test.sqlite'), logsDir: join(root, 'logs'),
    artifactsDir: join(root, 'artifacts'), outputsDir: join(root, 'outputs'), runtimeDir: join(root, 'runtime') };
  const store = need(openDatabase(paths));
  deferCleanup(() => store.close());
  const agent = new PiAgentAdapter({ cwd: root, agentDir: paths.runtimeDir,
    credentials: new InMemoryCredentialStore(), runtimeApiKey: 'synthetic-management-key' });
  deferCleanup(async () => { await agent.close(); });
  let runtime: RuntimeState = { active: null, blocked: false, error: null };
  const service = new SessionService(store.sessions, agent, () => runtime,
    () => at, store.runs, store.memory, store.sessionInputs);
  return { store, service, agent, paths, setRuntime: (state: RuntimeState) => { runtime = state; } };
}
async function savedConversation(app: ReturnType<typeof fixture>) {
  const session = need(await app.service.create({ title: 'Saved replies' }));
  const original = need(app.store.sessions.loadHistory(session.sessionId))!;
  const manager = SessionManager.inMemory(app.paths.root, undefined, [original.header]);
  manager.appendMessage({ role: 'user', content: 'First question', timestamp: 1 });
  const userEntryId = manager.getLeafId()!;
  const reply = (text: string, timestamp: number) => ({ role: 'assistant' as const,
    content: [{ type: 'text' as const, text }], api: 'openai-completions' as const, provider: 'fixture', model: 'fixture',
    stopReason: 'stop' as const, timestamp, usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 2,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } } });
  manager.appendMessage(reply('First reply', 2));
  const firstReply = manager.getLeafId()!;
  manager.appendMessage({ role: 'user', content: 'Second question', timestamp: 3 });
  manager.appendMessage(reply('Second reply', 4));
  const history: NativeSessionHistory = { ...original, entries: manager.getEntries().map(entry => ({ ...entry })), leafId: manager.getLeafId() };
  const receipt = need(app.store.memory.load(session.sessionId))!.commit;
  const committed = need(app.store.memory.commit({ sessionId: session.sessionId, expected: receipt, header: history.header,
    appendEntries: history.entries, contexts: [], leafId: history.leafId, unusable: false }));
  expect((await app.agent.releaseSession(session.nativeSessionId)).closed).toBe(true);
  return { session, history, firstReply, userEntryId,
    request: { sessionId: session.sessionId, expectedCommitRevision: committed.commitRevision, expectedLeafId: history.leafId,
      expectedEntryCount: history.entries.length, targetEntryId: firstReply } };
}
describe('T04 explicit restore and persisted Session queries', () => {
  it('branches the original ready Pi after two real Runtime replies and keeps management available', async () => {
    const app = fixture(); const session = need(await app.service.create({ title: 'Original ready SDK' }));
    let requests = 0;
    const server = Bun.serve({ hostname: '127.0.0.1', port: 0, async fetch(request) {
      await request.json(); requests++;
      const chunk = (delta: unknown, reason: string | null) => `data: ${JSON.stringify({ id: `ready-${requests}`,
        model: 'fixture', choices: [{ index: 0, delta, finish_reason: reason }] })}\n\n`;
      return new Response(`${chunk({ role: 'assistant', content: `Reply ${requests}` }, null)}${chunk({}, 'stop')}data: [DONE]\n\n`,
        { headers: { 'content-type': 'text/event-stream' } });
    } });
    deferCleanup(() => server.stop(true));
    const config = { version: 1 as const, name: 'Ready branch fixture', revision: 1,
      modelRef: { provider: 'ready-branch-fixture', model: 'fixture' }, native: { authPath: join(app.paths.root, 'unused.json'), modelsPath: null },
      connection: { baseUrl: `http://127.0.0.1:${server.port}/v1`, api: 'openai-completions' as const, contextWindow: 64_000, maxTokens: 16_384 },
      parameters: { maxRetries: 0, maxRetryDelayMs: 100 } };
    const runtime = new RuntimeService({ memory: app.store.memory, runs: app.store.runs, sessions: app.store.sessions, sessionInputs: app.store.sessionInputs,
      contextRepository: app.store.context,
      agent: app.agent, contextService: new ContextService({ store: app.store,
        materials: { inspectParsed() { throw new Error('Pure chat cannot inspect material.'); } } }),
      provider: { async prepare() { throw new Error('No direct Provider calls.'); }, async close() { return { stopped: true, closed: true, errors: [] }; } },
      log: { write() {}, async close() {} }, now: () => at, monotonicNow: () => performance.now() });
    deferCleanup(async () => { await runtime.close(); });
    for (const text of ['First question', 'Second question']) {
      let finished!: (event: AgentRunEvent & { type: 'run_finished' }) => void;
      const terminal = new Promise<AgentRunEvent & { type: 'run_finished' }>(resolve => { finished = resolve; });
      need(await runtime.start({ sessionId: session.sessionId, text, config, timeoutMs: 5000, stopGraceMs: 500 },
        { onEvent(event) { if (event.type === 'run_finished') finished(event); } }));
      expect((await terminal).result).toMatchObject({ ok: true, data: { status: 'completed' } });
      await waitFor(async () => runtime.state().active === null);
    }
    const bundle = need(app.store.sessions.loadHistoryForContext(session.sessionId));
    const saved = bundle.history!;
    const exported = need(app.agent.exportSession(session.nativeSessionId));
    expect(app.agent.inspect(session.nativeSessionId).availability).toBe('ready');
    expect(Object.hasOwn(exported.header, 'parentSession')).toBe(true);
    expect(Object.hasOwn(saved.header, 'parentSession')).toBe(false);
    expect(JSON.parse(JSON.stringify(exported))).toEqual(saved);
    expect(bundle.seed.inputs).toHaveLength(2);
    expect(bundle.seed.inputs.every(binding => binding.snapshotId !== null && binding.inputId !== null)).toBe(true);
    const firstReply = saved.entries.find(entry => entry.type === 'message'
      && (entry.message as { role?: string; stopReason?: string } | undefined)?.role === 'assistant'
      && (entry.message as { stopReason?: string }).stopReason === 'stop')!;
    const branched = await app.service.branch({ sessionId: session.sessionId, expectedCommitRevision: bundle.commit!.commitRevision, expectedLeafId: saved.leafId,
      expectedEntryCount: saved.entries.length, targetEntryId: firstReply.id });
    expect(branched).toMatchObject({ ok: true, data: { leafId: firstReply.id, entryCount: saved.entries.length } });
    const committed = need(app.store.sessions.loadHistoryForContext(session.sessionId));
    expect(committed).toEqual({ history: { ...saved, leafId: firstReply.id }, seed: bundle.seed, commit: { ...bundle.commit!, leafId: firstReply.id, commitRevision: bundle.commit!.commitRevision + 1 } });
    expect(JSON.parse(JSON.stringify(need(app.agent.exportSession(session.nativeSessionId))))).toEqual(committed.history);
    expect(app.service.isManaging(session.sessionId)).toBe(false);
    expect(await app.service.branch({ sessionId: session.sessionId, expectedCommitRevision: committed.commit!.commitRevision, expectedLeafId: firstReply.id,
      expectedEntryCount: saved.entries.length, targetEntryId: firstReply.id })).toMatchObject({ ok: true });
    expect(requests).toBe(2);
  });
  it('restores a fresh ready Pi Session from its complete SQLite JSON representation', async () => {
    const app = fixture(); const session = need(await app.service.create({ title: 'Fresh empty history' }));
    const persisted = need(app.store.sessions.loadHistoryForContext(session.sessionId));
    expect(persisted.history?.entries).toEqual([]);
    expect(persisted.seed.inputs).toEqual([]);
    expect(ensureNativeSession(app.store.sessions, app.agent, need(app.store.sessions.get(session.sessionId)), app.store.memory)).toEqual({ ok: true, data: undefined });
    expect(JSON.parse(JSON.stringify(need(app.agent.exportSession(session.nativeSessionId))))).toEqual(persisted.history);
  });
  it.each(['missing', 'ready'] as const)('queries %s native state without restore, watch or prepare', async state => {
    const app = fixture(); const { session } = await savedConversation(app);
    if (state === 'ready') need(ensureNativeSession(app.store.sessions, app.agent, need(app.store.sessions.get(session.sessionId)), app.store.memory));
    const port: AgentPort = app.agent;
    const calls = { restore: 0, leaf: 0, watch: 0, prepare: 0, enqueue: 0 };
    const restore = port.restoreSession!.bind(port), leaf = port.restoreSessionLeaf!.bind(port), watch = port.watchSession!.bind(port);
    const prepare = port.prepare.bind(port), enqueue = port.enqueueInput!.bind(port);
    port.restoreSession = (...args) => { calls.restore++; return restore(...args); };
    port.restoreSessionLeaf = (...args) => { calls.leaf++; return leaf(...args); };
    port.watchSession = (...args) => { calls.watch++; return watch(...args); };
    port.prepare = (...args) => { calls.prepare++; return prepare(...args); };
    port.enqueueInput = (...args) => { calls.enqueue++; return enqueue(...args); };
    const before = app.store.db.query('SELECT * FROM session_native_history').all();
    expect(need(app.service.get(session.sessionId))).toMatchObject({ historyState: 'recoverable', availability: 'ready' });
    const page = need(await app.service.querySessionHistory({ sessionId: session.sessionId }));
    expect(page.items).toHaveLength(4);
    expect(await app.service.querySessionHistoryEntry({ sessionId: session.sessionId, entryId: page.items[0]!.entryId,
      expectedCommitRevision: page.commit.commitRevision })).toMatchObject({ ok: true });
    expect(calls).toEqual({ restore: 0, leaf: 0, watch: 0, prepare: 0, enqueue: 0 });
    expect(app.store.db.query('SELECT * FROM session_native_history').all()).toEqual(before);
  });
  it('keeps corrupt persisted history invalid without asking the SDK to restore it', async () => {
    const app = fixture(); const { session } = await savedConversation(app);
    let restored = 0;
    const original = app.agent.restoreSession.bind(app.agent);
    app.agent.restoreSession = (...args) => { restored++; return original(...args); };
    app.store.db.query("UPDATE session_native_history SET header_json='{}' WHERE session_id=?").run(session.sessionId);
    const before = app.store.db.query('SELECT * FROM session_native_history').all();
    expect(need(app.service.get(session.sessionId)).historyState).toBe('invalid');
    expect(restored).toBe(0); expect(app.store.db.query('SELECT * FROM session_native_history').all()).toEqual(before);
  });
  it.each(['saved', 'rejected', 'lost-receipt'] as const)('passes the exact DB-confirmed branch and seeds after %s', async kind => {
    const app = fixture(); const { session, history, request } = await savedConversation(app);
    const port: AgentPort = app.agent;
    const restored: { history: NativeSessionHistory; bindings: readonly NativeContextBindingSeed[] | undefined }[] = [];
    const originalLeaf = port.restoreSessionLeaf!.bind(port);
    port.restoreSessionLeaf = (nativeId, committed, seed, receipt) => {
      restored.push({ history: structuredClone(committed), bindings: structuredClone(seed.inputs) });
      return originalLeaf(nativeId, committed, seed, receipt);
    };
    if (kind === 'rejected') app.store.db.exec(`CREATE TRIGGER reject_t04_leaf BEFORE UPDATE OF leaf_id ON session_native_history
      WHEN NEW.leaf_id!=OLD.leaf_id BEGIN SELECT RAISE(ABORT,'leaf save failed'); END;`);
    if (kind === 'lost-receipt') {
      const save = app.store.memory.commit;
      app.store.memory.commit = (...args) => { need(save(...args)); return fail(appError('storage_write_failed', 'storage', 'Lost receipt.')); };
    }
    const branched = await app.service.branch(request);
    expect(branched.ok).toBe(kind !== 'rejected');
    const committed = need(app.store.sessions.loadHistory(session.sessionId))!;
    expect(committed).toEqual({ ...history, leafId: kind === 'rejected' ? history.leafId : request.targetEntryId });
    expect(restored.at(-1)).toEqual({ history: committed, bindings: history.entries.filter(entry =>
      (entry.message as { role?: string } | undefined)?.role === 'user').map(entry =>
      ({ nativeEntryId: entry.id, originRunId: null, inputId: null, snapshotId: null })) });
    expect(need(app.agent.exportSession(session.nativeSessionId))).toEqual(committed);
  });
});
describe('P5 same-Session management', () => {
  it('archives and unarchives an idle Session without adding native messages or Runs', async () => {
    const { store, service } = fixture();
    const session = need(await service.create({ title: 'Manage me' }));
    expect(need(service.setStatus({ sessionId: session.sessionId, expectedStatus: 'active', status: 'archived' })))
      .toMatchObject({ status: 'archived', deletePending: false });
    expect(need(service.setStatus({ sessionId: session.sessionId, expectedStatus: 'archived', status: 'active' })))
      .toMatchObject({ status: 'active', deletePending: false });
    expect(store.db.query('SELECT COUNT(*) AS count FROM runs').get()).toEqual({ count: 0 });
    expect(need(store.sessions.loadHistory(session.sessionId))?.entries).toEqual([]);
  });
  it('persists incomplete Delete and rejects Unarchive after process restart', async () => {
    const { store, service, agent, paths } = fixture();
    const session = need(await service.create({ title: 'Incomplete Delete' }));
    const originalRelease = agent.releaseSession.bind(agent);
    agent.releaseSession = async () => ({ stopped: true, closed: false, errors: [] });
    expect(await service.deleteSession(session.sessionId)).toMatchObject({ ok: false, error: { code: 'session_delete_incomplete' } });
    expect(need(store.sessions.get(session.sessionId))).toMatchObject({ status: 'archived', deletePending: true });
    store.close();
    const restarted = need(openDatabase(paths));
    deferCleanup(() => restarted.close());
    const reopenedService = new SessionService(restarted.sessions, agent, () => ({ active: null, blocked: false, error: null }),
      () => at, restarted.runs, restarted.memory, restarted.sessionInputs);
    expect(reopenedService.setStatus({ sessionId: session.sessionId, expectedStatus: 'archived', status: 'active' }))
      .toMatchObject({ ok: false, error: { code: 'session_delete_incomplete' } });
    agent.releaseSession = originalRelease;
    expect(await reopenedService.deleteSession(session.sessionId)).toMatchObject({ ok: true, data: { disposition: 'permanent' } });
  });
  it('rejects target management while its Run is active and permits another idle Session', async () => {
    const app = fixture();
    const first = need(await app.service.create({ title: 'Active' }));
    const other = need(await app.service.create({ title: 'Idle' }));
    app.setRuntime({ active: { kind: 'agent', runId: 1, sessionId: first.sessionId }, blocked: false, error: null });
    expect(app.service.setStatus({ sessionId: first.sessionId, expectedStatus: 'active', status: 'archived' }))
      .toMatchObject({ ok: false, error: { code: 'session_busy' } });
    expect(await app.service.branch({ sessionId: first.sessionId, expectedCommitRevision: 1, expectedLeafId: null, expectedEntryCount: 0, targetEntryId: 'invalid' }))
      .toMatchObject({ ok: false, error: { code: 'session_busy' } });
    expect(need(app.service.setStatus({ sessionId: other.sessionId, expectedStatus: 'active', status: 'archived' })).status).toBe('archived');
    expect(app.store.db.query('SELECT COUNT(*) AS count FROM runs').get()).toEqual({ count: 0 });
  });
  it('keeps revocation and unusable history after Unarchive and refuses hidden Session revival', async () => {
    const app = fixture();
    const session = need(await app.service.create({ title: 'Restricted' }));
    need(app.service.setStatus({ sessionId: session.sessionId, expectedStatus: 'active', status: 'archived' }));
    app.store.db.query("UPDATE sessions SET metadata_json=json_set(metadata_json,'$.model_use_blocked',json(?)) WHERE id=?")
      .run(JSON.stringify({ documentIds: [1], at, reason: 'document_use_revoked' }), session.sessionId);
    app.store.db.query('UPDATE session_native_history SET unusable=1 WHERE session_id=?').run(session.sessionId);
    expect(need(app.service.setStatus({ sessionId: session.sessionId, expectedStatus: 'archived', status: 'active' })))
      .toMatchObject({ status: 'active', modelUseBlocked: true, availability: 'unusable' });
    app.store.db.query("UPDATE sessions SET status='archived',hidden_at=? WHERE id=?").run(at, session.sessionId);
    expect(app.service.setStatus({ sessionId: session.sessionId, expectedStatus: 'archived', status: 'active' }))
      .toMatchObject({ ok: false, error: { code: 'session_not_found' } });
  });
  it('retains Delete intent when its second transaction fails and only explicit Delete retries it', async () => {
    const app = fixture();
    const session = need(await app.service.create({ title: 'Second transaction' }));
    app.store.db.exec("CREATE TRIGGER reject_delete BEFORE DELETE ON sessions BEGIN SELECT RAISE(ABORT,'delete failed'); END;");
    expect(await app.service.deleteSession(session.sessionId)).toMatchObject({ ok: false, error: { code: 'session_delete_incomplete' } });
    app.store.close();
    const reopened = need(openDatabase(app.paths));
    deferCleanup(() => reopened.close());
    const service = new SessionService(reopened.sessions, app.agent, () => ({ active: null, blocked: false, error: null }),
      () => at, reopened.runs, reopened.memory, reopened.sessionInputs);
    expect(need(reopened.sessions.get(session.sessionId))).toMatchObject({ status: 'archived', deletePending: true });
    expect(service.setStatus({ sessionId: session.sessionId, expectedStatus: 'archived', status: 'active' })).toMatchObject({ ok: false });
    expect(await service.branch({ sessionId: session.sessionId, expectedCommitRevision: 1, expectedLeafId: null, expectedEntryCount: 0, targetEntryId: 'irrelevant' }))
      .toMatchObject({ ok: false, error: { code: 'session_delete_incomplete' } });
    reopened.db.exec('DROP TRIGGER reject_delete;');
    expect(await service.deleteSession(session.sessionId)).toMatchObject({ ok: true, data: { disposition: 'permanent' } });
    expect(reopened.db.query('SELECT id FROM sessions WHERE id=?').get(session.sessionId)).toBeNull();
  });
  it('selects complete users and other branches and rejects stale held positions', async () => {
    const app = fixture(); const { session, history, firstReply, userEntryId, request } = await savedConversation(app);
    expect(await app.service.branch({ ...request, expectedEntryCount: 0 })).toMatchObject({ ok: false, error: { code: 'state_conflict' } });
    expect(await app.service.branch(request)).toMatchObject({ ok: true, data: { leafId: firstReply, entryCount: history.entries.length } });
    expect(need(app.store.sessions.loadHistory(session.sessionId))).toEqual({ ...history, leafId: firstReply });
    expect(need(app.agent.exportSession(session.nativeSessionId))).toEqual({ ...history, leafId: firstReply });
    expect(await app.service.branch(request)).toMatchObject({ ok: false, error: { code: 'state_conflict' } });
    const selected = { ...request, expectedLeafId: firstReply, expectedCommitRevision: request.expectedCommitRevision + 1 };
    expect(await app.service.branch(selected)).toMatchObject({ ok: true });
    expect(await app.service.branch({ ...selected, targetEntryId: history.leafId! })).toMatchObject({ ok: true });
    expect(await app.service.branch({ ...request, expectedCommitRevision: request.expectedCommitRevision + 2, targetEntryId: userEntryId })).toMatchObject({ ok: true, data: { leafId: userEntryId } });
    expect(app.store.db.query('SELECT COUNT(*) AS count FROM runs').get()).toEqual({ count: 0 });
  });
  it('restores the last committed native position when SQLite rejects the branch save', async () => {
    const app = fixture();
    const { session, history, request } = await savedConversation(app);
    app.store.db.exec(`CREATE TRIGGER reject_leaf BEFORE UPDATE OF leaf_id ON session_native_history
      WHEN NEW.leaf_id!=OLD.leaf_id BEGIN SELECT RAISE(ABORT,'leaf save failed'); END;`);
    expect(await app.service.branch(request)).toMatchObject({ ok: false, error: { code: 'storage_write_failed' } });
    expect(need(app.store.sessions.loadHistory(session.sessionId))).toEqual(history);
    expect(need(app.agent.exportSession(session.nativeSessionId))).toEqual(history);
    expect(app.service.isManaging(session.sessionId)).toBe(false);
    app.store.db.exec('DROP TRIGGER reject_leaf;');
    expect(await app.service.branch(request)).toMatchObject({ ok: true });
  });
  it('queries committed position after a lost save response and never navigates again', async () => {
    const app = fixture();
    const { session, request, firstReply } = await savedConversation(app);
    const originalSave = app.store.memory.commit;
    let calls = 0;
    app.store.memory.commit = (...args) => { calls += 1; need(originalSave(...args)); return fail(appError('storage_write_failed', 'storage', 'Lost response.')); };
    expect(await app.service.branch(request)).toMatchObject({ ok: true, data: { leafId: firstReply } });
    expect(calls).toBe(1);
    expect(need(app.agent.exportSession(session.nativeSessionId)).leafId).toBe(firstReply);
  });
  it.each(['confirmed', 'lost-receipt'] as const)('preserves the committed branch when the next Run user save fails: %s', async receipt => {
    const app = fixture();
    const { session, firstReply } = await savedConversation(app);
    let providerCalls = 0;
    const server = Bun.serve({ hostname: '127.0.0.1', port: 0, fetch() { providerCalls += 1; return new Response('Unexpected model request.', { status: 500 }); } });
    deferCleanup(() => server.stop(true));
    const config = { version: 1 as const, name: 'Controlled management model', revision: 1,
      modelRef: { provider: 'management-fixture', model: 'fixture' }, native: { authPath: join(app.paths.root, 'unused.json'), modelsPath: null },
      connection: { baseUrl: `http://127.0.0.1:${server.port}/v1`, api: 'openai-completions' as const, contextWindow: 64_000, maxTokens: 16_384 },
      parameters: { maxRetries: 0, maxRetryDelayMs: 100 } };
    need(ensureNativeSession(app.store.sessions, app.agent, need(app.store.sessions.get(session.sessionId)), app.store.memory));
    need(await app.agent.prepare(session.nativeSessionId, config, { timeoutMs: 5000, stopGraceMs: 500 }, new AbortController().signal,
      { sessionInputs: true }));
    const history = need(app.store.sessions.loadHistory(session.sessionId))!;
    const request = { sessionId: session.sessionId, targetEntryId: firstReply, expectedCommitRevision: need(app.store.memory.load(session.sessionId))!.commit.commitRevision, expectedLeafId: history.leafId, expectedEntryCount: history.entries.length };
    const originalSave = app.store.memory.commit;
    if (receipt === 'lost-receipt') app.store.memory.commit = (...args) => {
      need(originalSave(...args)); return fail(appError('storage_write_failed', 'storage', 'Lost branch receipt.'));
    };
    expect(await app.service.branch(request)).toMatchObject({ ok: true, data: { leafId: firstReply } });
    app.store.memory.commit = originalSave;
    app.store.db.exec("CREATE TRIGGER reject_next_user BEFORE INSERT ON session_native_entries WHEN NEW.run_id IS NOT NULL BEGIN SELECT RAISE(ABORT,'new user save failed'); END;");
    const runtime = new RuntimeService({ memory: app.store.memory, runs: app.store.runs, sessions: app.store.sessions, sessionInputs: app.store.sessionInputs,
      agent: app.agent, provider: { async prepare() { throw new Error('No direct Provider calls are authorized.'); },
        async close() { return { stopped: true, closed: true, errors: [] }; } },
      log: { write() {}, async close() {} }, now: () => at, monotonicNow: () => performance.now() });
    let finished!: (event: AgentRunEvent & { type: 'run_finished' }) => void;
    const terminal = new Promise<AgentRunEvent & { type: 'run_finished' }>(resolve => { finished = resolve; });
    const accepted = need(await runtime.start({ sessionId: session.sessionId, text: 'Continue from the selected reply.',
      goalMode: 'answer', timeoutMs: 5000, stopGraceMs: 500, config },
      { onEvent(event) { if (event.type === 'run_finished') finished(event); } }));
    const end = await terminal;
    expect(end.result).toMatchObject({ ok: true, data: { status: 'failed', error: { code: 'storage_write_failed' } } });
    const saved = need(app.store.memory.load(session.sessionId))!;
    expect(saved.history.header).toEqual(history.header);
    expect(saved.history.entries.slice(0, history.entries.length)).toEqual([...history.entries]);
    expect(saved.history.entries).toHaveLength(history.entries.length + 1);
    const metadata = saved.history.entries.at(-1)!;
    expect(metadata).toMatchObject({ type: 'model_change', parentId: firstReply, provider: config.modelRef.provider, modelId: config.modelRef.model });
    expect(saved.history).toMatchObject({ leafId: metadata.id, unusable: true });
    expect(saved.commit).toEqual({ commitRevision: request.expectedCommitRevision + 3, entryCount: history.entries.length + 1, leafId: metadata.id });
    expect(app.store.db.query('SELECT run_id FROM session_native_entries WHERE session_id=? AND entry_id=?').get(session.sessionId, metadata.id)).toEqual({ run_id: null });
    expect(app.store.db.query('SELECT id FROM session_inputs WHERE native_entry_id=? OR result_entry_id=?').all(metadata.id, metadata.id)).toEqual([]);
    expect(need(app.store.sessionInputs.query({ sessionId: session.sessionId, inputId: accepted.inputId! })).input)
      .toMatchObject({ status: 'delivery_unknown', processingStatus: 'failed', nativeEntryId: null });
    expect(providerCalls).toBe(0);
  });
  it.each(['confirmed', 'lost-receipt'] as const)('blocks after committed branch cache confirmation fails: %s', async receipt => {
    const app = fixture();
    const { session, request, firstReply } = await savedConversation(app);
    const originalSave = app.store.memory.commit;
    if (receipt === 'lost-receipt') app.store.memory.commit = (...args) => {
      const result = originalSave(...args);
      return result.ok ? fail(appError('storage_write_failed', 'storage', 'Lost branch receipt.')) : result;
    };
    app.agent.restoreSessionLeaf = () => fail(appError('session_history_invalid', 'session', 'Committed cache confirmation failed.'));
    expect(await app.service.branch(request)).toMatchObject({ ok: false, error: { code: 'session_history_invalid' } });
    expect(app.service.isManaging(session.sessionId)).toBe(true);
    expect(need(app.store.sessions.loadHistory(session.sessionId))).toMatchObject({ leafId: firstReply, unusable: true });
    expect(await app.service.branch({ ...request, expectedLeafId: firstReply })).toMatchObject({ ok: false, error: { code: 'session_busy' } });
  });
  it('persists unusable history when native position rollback cannot be confirmed', async () => {
    const app = fixture();
    const { session, request } = await savedConversation(app);
    app.store.db.exec(`CREATE TRIGGER reject_leaf BEFORE UPDATE OF leaf_id ON session_native_history
      WHEN NEW.leaf_id!=OLD.leaf_id BEGIN SELECT RAISE(ABORT,'leaf save failed'); END;`);
    app.agent.restoreSessionLeaf = () => fail(appError('session_history_invalid', 'session', 'Rollback failed.'));
    expect(await app.service.branch(request)).toMatchObject({ ok: false, error: { code: 'session_history_invalid' } });
    expect(app.service.isManaging(session.sessionId)).toBe(true);
    expect(need(app.store.sessions.get(session.sessionId)).nativeUnusable).toBe(true);
    app.store.close();
    const reopened = need(openDatabase(app.paths));
    deferCleanup(() => reopened.close());
    expect(need(reopened.sessions.get(session.sessionId)).nativeUnusable).toBe(true);
  });
  it('blocks the Session when both the branch save receipt and subsequent query are unknown', async () => {
    const app = fixture();
    const { session, request } = await savedConversation(app);
    const originalSave = app.store.memory.commit;
    const originalLoad = app.store.sessions.readHistorySnapshot;
    let unknown = false;
    app.store.memory.commit = (...args) => { need(originalSave(...args)); unknown = true; return fail(appError('storage_write_failed', 'storage', 'Lost receipt.')); };
    app.store.sessions.readHistorySnapshot = (...args) => unknown ? fail(appError('storage_read_failed', 'storage', 'Read failed.')) : originalLoad(...args);
    expect(await app.service.branch(request)).toMatchObject({ ok: false });
    expect(app.service.isManaging(session.sessionId)).toBe(true);
    expect(await app.service.branch(request)).toMatchObject({ ok: false, error: { code: 'session_busy' } });
  });
});
