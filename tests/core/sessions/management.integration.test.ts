import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { describe, expect, it } from 'bun:test';
import { SessionManager } from '@earendil-works/pi-coding-agent';
import { InMemoryCredentialStore } from '@earendil-works/pi-ai';
import { PiAgentAdapter } from '../../../packages/runtime-pi/src/session.ts';
import { openDatabase } from '../../../packages/core/src/storage/database.ts';
import { SessionService } from '../../../packages/core/src/sessions/service.ts';
import { RuntimeService } from '../../../packages/core/src/runtime/service.ts';
import { appError, fail } from '@flowmate/contracts';
import type { AgentRunEvent, NativeSessionHistory, Result, RuntimeState } from '@flowmate/contracts';
import { deferCleanup, mkdtempSync } from '../../support/resources.ts';
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
    () => at, store.runs, store.sessionInputs);
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
  need(app.store.sessions.saveHistory(session.sessionId, history));
  expect((await app.agent.releaseSession(session.nativeSessionId)).closed).toBe(true);
  return { session, history, firstReply, userEntryId,
    request: { sessionId: session.sessionId, expectedLeafId: history.leafId,
      expectedEntryCount: history.entries.length, targetEntryId: firstReply } };
}
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
      () => at, restarted.runs, restarted.sessionInputs);
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
    expect(await app.service.branch({ sessionId: first.sessionId, expectedLeafId: null, expectedEntryCount: 0, targetEntryId: 'invalid' }))
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
      () => at, reopened.runs, reopened.sessionInputs);
    expect(need(reopened.sessions.get(session.sessionId))).toMatchObject({ status: 'archived', deletePending: true });
    expect(service.setStatus({ sessionId: session.sessionId, expectedStatus: 'archived', status: 'active' })).toMatchObject({ ok: false });
    expect(await service.branch({ sessionId: session.sessionId, expectedLeafId: null, expectedEntryCount: 0, targetEntryId: 'irrelevant' }))
      .toMatchObject({ ok: false, error: { code: 'session_delete_incomplete' } });
    reopened.db.exec('DROP TRIGGER reject_delete;');
    expect(await service.deleteSession(session.sessionId)).toMatchObject({ ok: true, data: { disposition: 'permanent' } });
    expect(reopened.db.query('SELECT id FROM sessions WHERE id=?').get(session.sessionId)).toBeNull();
  });
  it('saves only a final reply on the current path, preserves all entries, and rejects stale positions', async () => {
    const app = fixture();
    const { session, history, firstReply, userEntryId, request } = await savedConversation(app);
    expect(await app.service.branch({ ...request, targetEntryId: userEntryId })).toMatchObject({ ok: false, error: { code: 'input_invalid' } });
    expect(await app.service.branch({ ...request, expectedEntryCount: 0 })).toMatchObject({ ok: false, error: { code: 'state_conflict' } });
    expect(await app.service.branch(request)).toMatchObject({ ok: true, data: { leafId: firstReply, entryCount: history.entries.length } });
    expect(need(app.store.sessions.loadHistory(session.sessionId))).toEqual({ ...history, leafId: firstReply });
    expect(need(app.agent.exportSession(session.nativeSessionId))).toEqual({ ...history, leafId: firstReply });
    expect(await app.service.branch(request)).toMatchObject({ ok: false, error: { code: 'state_conflict' } });
    expect(await app.service.branch({ ...request, expectedLeafId: firstReply })).toMatchObject({ ok: true });
    expect(await app.service.branch({ ...request, expectedLeafId: firstReply, targetEntryId: history.leafId! }))
      .toMatchObject({ ok: false, error: { code: 'input_invalid' } });
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
    const originalSave = app.store.sessions.saveHistory;
    let calls = 0;
    app.store.sessions.saveHistory = (...args) => { calls += 1; need(originalSave(...args)); return fail(appError('storage_write_failed', 'storage', 'Lost response.')); };
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
    need(app.service.get(session.sessionId));
    need(await app.agent.prepare(session.nativeSessionId, config, { timeoutMs: 5000, stopGraceMs: 500 }, new AbortController().signal,
      { sessionInputs: true }));
    const history = need(app.store.sessions.loadHistory(session.sessionId))!;
    const request = { sessionId: session.sessionId, targetEntryId: firstReply, expectedLeafId: history.leafId, expectedEntryCount: history.entries.length };
    const originalSave = app.store.sessions.saveHistory;
    if (receipt === 'lost-receipt') app.store.sessions.saveHistory = (...args) => {
      need(originalSave(...args)); return fail(appError('storage_write_failed', 'storage', 'Lost branch receipt.'));
    };
    expect(await app.service.branch(request)).toMatchObject({ ok: true, data: { leafId: firstReply } });
    app.store.sessions.saveHistory = originalSave;
    app.store.db.exec("CREATE TRIGGER reject_next_user BEFORE INSERT ON session_native_entries WHEN NEW.run_id IS NOT NULL BEGIN SELECT RAISE(ABORT,'new user save failed'); END;");
    const runtime = new RuntimeService({ runs: app.store.runs, sessions: app.store.sessions, sessionInputs: app.store.sessionInputs,
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
    expect(need(app.store.sessions.loadHistory(session.sessionId))).toEqual({ ...history, leafId: firstReply, unusable: true });
    expect(need(app.store.sessionInputs.query({ sessionId: session.sessionId, inputId: accepted.inputId! })).input)
      .toMatchObject({ status: 'delivery_unknown', processingStatus: 'failed', nativeEntryId: null });
    expect(providerCalls).toBe(0);
  });
  it.each(['confirmed', 'lost-receipt'] as const)('blocks after committed branch cache confirmation fails: %s', async receipt => {
    const app = fixture();
    const { session, request, firstReply } = await savedConversation(app);
    const originalSave = app.store.sessions.saveHistory;
    if (receipt === 'lost-receipt') app.store.sessions.saveHistory = (...args) => {
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
    const originalSave = app.store.sessions.saveHistory;
    const originalLoad = app.store.sessions.loadHistory;
    let unknown = false;
    app.store.sessions.saveHistory = (...args) => { need(originalSave(...args)); unknown = true; return fail(appError('storage_write_failed', 'storage', 'Lost receipt.')); };
    app.store.sessions.loadHistory = (...args) => unknown ? fail(appError('storage_read_failed', 'storage', 'Read failed.')) : originalLoad(...args);
    expect(await app.service.branch(request)).toMatchObject({ ok: false });
    expect(app.service.isManaging(session.sessionId)).toBe(true);
    expect(await app.service.branch(request)).toMatchObject({ ok: false, error: { code: 'session_busy' } });
  });
});
