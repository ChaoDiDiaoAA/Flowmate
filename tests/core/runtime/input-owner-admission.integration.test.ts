import { expect, test } from 'bun:test';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { appError } from '@flowmate/contracts';
import type { AgentInputDispatch, AgentRunEvent, NormalizedActiveInputRequest, ProviderConfig, Result } from '@flowmate/contracts';
import { ContextService } from '../../../packages/core/src/context/service.ts';
import { RuntimeService } from '../../../packages/core/src/runtime/service.ts';
import { SessionService } from '../../../packages/core/src/sessions/service.ts';
import { PiAgentAdapter } from '../../../packages/runtime-pi/src/session.ts';
import { openTestDatabase } from '../../support/database.ts';
import { createFixtureDependencies } from '../../support/pi-provider.ts';
import { deferCleanup, mkdtempSync } from '../../support/resources.ts';

const at = '2026-10-28T00:00:00.000Z';
function need<T>(result: Result<T>): T { if (!result.ok) throw Error(result.error.code); return result.data; }
const tick = () => new Promise<void>(resolve => setImmediate(resolve));

async function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'flowmate-input-owner-'));
  const store = need(openTestDatabase({ root, databaseFile: join(root, 'data', 'app.sqlite'), logsDir: join(root, 'logs'),
    artifactsDir: join(root, 'artifacts'), outputsDir: join(root, 'outputs'), runtimeDir: join(root, 'runtime') }));
  const modelEntered = Promise.withResolvers<void>(), modelReleased = Promise.withResolvers<void>();
  let modelCalls = 0;
  const native = await createFixtureDependencies('none', async event => {
    if (event.type !== 'fixture_fetch') return;
    if (++modelCalls === 1) { modelEntered.resolve(); await modelReleased.promise; }
  });
  let aborted = false;
  const fetch = native.fetch!;
  native.fetch = async (...args) => { args[1]?.signal?.addEventListener('abort', () => { aborted = true; }, { once: true }); return fetch(...args); };
  const agent = new PiAgentAdapter({ cwd: root, agentDir: join(root, 'agent'), ...native, runtimeApiKey: 'controlled-input-owner' });
  const contextService = new ContextService({ store, materials: { inspectParsed() { throw Error('Chat has no material'); } } });
  const provider = { async prepare(): Promise<never> { throw Error('No direct Provider work'); },
    async close() { return { stopped: true, closed: true, errors: [] }; } };
  const dependencies = { database: store,
    agent, provider, contextService,
    log: { write() {}, async close() {} }, now: () => at, monotonicNow: () => performance.now() };
  const runtime = new RuntimeService(dependencies);
  const sessions = new SessionService(agent, () => runtime.state(), () => at, store,
    (request, submission, control) => runtime.start(request, control, submission), request => runtime.appendInput(request),
    (id, intent, repository) => runtime.verifySessionMutation(id, intent, repository));
  deferCleanup(async () => { modelReleased.resolve(); await runtime.close(); });
  const session = need(await sessions.create({ title: 'Input owner' }));
  const config: ProviderConfig = { version: 1, name: 'Input owner', revision: 1,
    modelRef: { provider: 'input-owner-fixture', model: 'deepseek-flash' },
    native: { authPath: join(root, 'absent-auth.json'), modelsPath: null },
    connection: { baseUrl: 'https://fixture.invalid/v1', api: 'openai-completions', contextWindow: 64000, maxTokens: 8192 },
    parameters: { maxRetries: 0, maxRetryDelayMs: 1000 } };
  const finished = Promise.withResolvers<Extract<AgentRunEvent, { type: 'run_finished' }>>();
  const initial = need(await sessions.submitInput({ sessionId: session.sessionId, clientSequence: 1, mode: 'prompt',
    text: 'Initial question', config, timeoutMs: 10000, stopGraceMs: 1000 }, {
    onEvent(event) { if (event.type === 'run_finished') finished.resolve(event); },
  }));
  await modelEntered.promise;
  const deliveries: AgentInputDispatch[] = [], enqueue = agent.enqueueInput.bind(agent);
  agent.enqueueInput = async (...args) => { expect(store.db.inTransaction).toBe(false); deliveries.push(structuredClone(args[1])); return enqueue(...args); };
  const request = (mode: 'steer' | 'followUp' = 'steer'): NormalizedActiveInputRequest => ({ sessionId: session.sessionId,
    clientSequence: 2, runId: initial.runId, mode, text: 'Original extra input' });
  return { store, agent, runtime, sessions, dependencies, session, initial, request, deliveries, modelReleased, finished, aborted: () => aborted };
}

async function hold(f: Awaited<ReturnType<typeof fixture>>) {
  const entered = Promise.withResolvers<void>(), release = Promise.withResolvers<void>();
  const completion = f.store.transaction(async () => { entered.resolve(); await release.promise; });
  await entered.promise;
  return { release: release.resolve, completion };
}

test.each(['steer', 'followUp'] as const)('active %s input waits for its owner and retains the original content', async mode => {
  const f = await fixture(), blocker = await hold(f), request = f.request(mode);
  let settled = false;
  const pending = f.runtime.appendInput(request).then(value => { settled = true; return value; });
  request.text = 'Changed after queueing';
  try {
    await tick(); expect(settled).toBe(false); expect(f.deliveries).toHaveLength(0);
    blocker.release(); await blocker.completion;
    const receipt = need(await pending), input = need(await f.store.read(scope => scope.sessionInputs.get(receipt.inputId)))!;
    expect(input).toMatchObject({ content: { text: 'Original extra input' }, status: 'queued', processingStatus: 'pending', nativeEntryId: null });
    expect(input.contextSnapshotId).toBeGreaterThan(0); expect(input.dispatchedAt).toBe(at);
    expect(f.deliveries).toMatchObject([{ inputId: receipt.inputId, text: 'Original extra input', contextSnapshotId: input.contextSnapshotId }]);
    f.modelReleased.resolve();
    expect((await f.finished.promise).result).toMatchObject({ ok: true, data: { status: 'completed' } });
    expect(need(await f.store.read(scope => scope.sessionInputs.get(receipt.inputId)))).toMatchObject({ status: 'consumed', processingStatus: 'completed' });
  } finally { blocker.release(); f.modelReleased.resolve(); await blocker.completion; await pending; await f.runtime.close(); }
});

test('Session input admission waits for its actual COMMIT before delivering to the SDK', async () => {
  const f = await fixture(), transaction = f.store.transaction, release = Promise.withResolvers<void>();
  let paused = false, settled = false;
  f.store.transaction = operation => transaction(async scope => {
    const value = await operation(scope);
    if (!paused && scope.db.query('SELECT id FROM session_inputs WHERE client_sequence=2').get()) { paused = true; await release.promise; }
    return value;
  });
  const pending = f.sessions.submitInput(f.request()).then(value => { settled = true; return value; });
  try {
    await tick(); expect(paused).toBe(true); expect(settled).toBe(false); expect(f.deliveries).toHaveLength(0);
    release.resolve();
    expect(await pending).toMatchObject({ ok: true, data: { runId: f.initial.runId, sessionId: f.session.sessionId } });
    expect(f.deliveries).toHaveLength(1);
  } finally { release.resolve(); f.modelReleased.resolve(); await pending; await f.runtime.close(); }
});

test('queued active input rechecks a user Stop before admitting metadata or calling the SDK', async () => {
  const f = await fixture(), blocker = await hold(f), pending = f.sessions.submitInput(f.request());
  let cancellation: ReturnType<typeof f.runtime.cancel> | undefined;
  try {
    await tick(); cancellation = f.runtime.cancel(f.initial.runId);
    blocker.release(); await blocker.completion;
    expect(await pending).toMatchObject({ ok: false, error: { code: 'input_admission_closed' } });
    expect(f.deliveries).toHaveLength(0);
    expect(await f.store.read(scope => scope.db.query('SELECT id FROM session_inputs WHERE client_sequence=2').get())).toBeNull();
  } finally { blocker.release(); f.modelReleased.resolve(); await blocker.completion; await pending; await cancellation; await f.runtime.close(); }
});

test('a duplicate active input queues its original receipt lookup before the Runtime blocked gate', async () => {
  const f = await fixture(), request = f.request(), first = need(await f.sessions.submitInput(request));
  const blocked = new RuntimeService({ ...f.dependencies, agent: undefined, recoveryError: appError('controlled_blocked', 'runtime', 'Controlled blocked Runtime') });
  const blocker = await hold(f);
  let settled = false;
  const duplicate = blocked.appendInput(structuredClone(request)).then(value => { settled = true; return value; });
  try {
    await tick(); expect(settled).toBe(false);
    blocker.release(); await blocker.completion;
    expect(await duplicate).toEqual({ ok: true, data: first });
    expect(await blocked.appendInput({ ...request, text: 'Different request' })).toMatchObject({ ok: false, error: { code: 'state_conflict' } });
    expect(f.deliveries).toHaveLength(1);
  } finally { blocker.release(); f.modelReleased.resolve(); await blocker.completion; await duplicate; await f.runtime.close(); }
});

test('a failed active input metadata COMMIT rolls back its Context and starts no SDK delivery', async () => {
  const f = await fixture();
  await f.store.transaction(scope => scope.db.exec('CREATE TABLE input_owner_parent(id INTEGER PRIMARY KEY); '
    + 'CREATE TABLE input_owner_child(id INTEGER PRIMARY KEY,parent_id INTEGER REFERENCES input_owner_parent(id) DEFERRABLE INITIALLY DEFERRED); '
    + 'CREATE TRIGGER input_owner_fault AFTER INSERT ON session_inputs WHEN NEW.client_sequence=2 BEGIN INSERT INTO input_owner_child VALUES(1,404); END;'));
  const contexts = await f.store.read(scope => scope.db.query('SELECT id FROM context_snapshots ORDER BY id').all());
  expect(await f.sessions.submitInput(f.request())).toMatchObject({ ok: false, error: { code: 'storage_write_failed' } });
  expect(f.deliveries).toHaveLength(0);
  expect(await f.store.read(scope => scope.db.query('SELECT id FROM session_inputs WHERE client_sequence=2').get())).toBeNull();
  expect(await f.store.read(scope => scope.db.query('SELECT id FROM context_snapshots ORDER BY id').all())).toEqual(contexts);
});

test('active input keeps its committed receipt and dispatches once when the admission response is lost', async () => {
  const f = await fixture(), transaction = f.store.transaction, request = f.request();
  f.store.transaction = async operation => {
    f.store.transaction = transaction;
    await transaction(operation); throw Error('Controlled response loss after input COMMIT');
  };
  const receipt = need(await f.sessions.submitInput(request));
  expect(await f.sessions.submitInput(request)).toEqual({ ok: true, data: receipt });
  expect(f.deliveries).toHaveLength(1);
  expect(await f.store.read(scope => scope.db.query('SELECT COUNT(*) AS count FROM session_inputs WHERE client_sequence=2').get())).toEqual({ count: 1 });
});

test('a user Stop committed after input metadata prevents its subsequent SDK dispatch', async () => {
  const f = await fixture(), transaction = f.store.transaction, request = f.request();
  let cancellation: ReturnType<typeof f.runtime.cancel> | undefined;
  f.store.transaction = operation => transaction(async scope => {
    const value = await operation(scope);
    if (!cancellation && scope.db.query('SELECT id FROM session_inputs WHERE client_sequence=2').get())
      scope.db.afterCommit!(() => { cancellation = f.runtime.cancel(f.initial.runId); });
    return value;
  });
  try {
    expect(await f.sessions.submitInput(request)).toMatchObject({ ok: false, error: { code: 'input_admission_closed' } });
    expect(f.deliveries).toHaveLength(0);
    const input = need(await f.sessions.queryInput({ sessionId: f.session.sessionId, clientSequence: 2 })).input!;
    expect(input.nativeEntryId).toBeNull(); expect(input.dispatchedAt).toBeNull();
    expect(await f.sessions.submitInput(request)).toEqual({ ok: true, data: {
      inputId: input.inputId, sessionId: f.session.sessionId, runId: f.initial.runId } });
  } finally { f.modelReleased.resolve(); await cancellation; await f.runtime.close(); }
});

async function registerDocument(f: Awaited<ReturnType<typeof fixture>>) {
  const metadata = { version: 1 as const, sourceKey: 'input-owner', sourceRecordId: 'controlled-document', sourceVersion: 'v1' };
  await f.store.transaction(scope => need(scope.documents.register({ documentId: 1, sourceKey: metadata.sourceKey,
    sourceRecordId: metadata.sourceRecordId, version: metadata.sourceVersion,
    originalArtifact: { artifactId: 1, kind: 'original', relativePath: 'artifacts/1/original.pdf', bytes: 1, mimeType: 'application/pdf',
      metadata: { ...metadata, files: [{ relativePath: 'original.pdf', bytes: 1, mimeType: 'application/pdf' }] }, createdAt: at },
    parsedArtifact: { artifactId: 2, kind: 'parsed', relativePath: 'artifacts/2/parsed.json', bytes: 1, mimeType: 'application/json',
      metadata: { ...metadata, files: [{ relativePath: 'parsed.json', bytes: 1, mimeType: 'application/json' }] }, createdAt: at },
    status: 'unavailable', metadata: { version: 2, pageCount: 1, warnings: [], allowedUsesClaim: ['controlled fixture'],
      licenseVerification: 'not_verified', unavailableReason: 'Controlled unavailable fixture' }, createdAt: at, updatedAt: at })));
}

test('document revocation and missing-document lookup wait for their current owner', async () => {
  const f = await fixture(); await registerDocument(f);
  const blocker = await hold(f);
  let settled = 0;
  const revoking = f.runtime.revokeDocumentUse(1).then(value => { settled++; return value; });
  const missing = f.runtime.revokeDocumentUse(999).then(value => { settled++; return value; });
  try {
    await tick(); expect(settled).toBe(0); expect(f.aborted()).toBe(false);
    blocker.release(); await blocker.completion;
    expect(await revoking).toEqual({ ok: true, data: { affectedSessionIds: [], stopRequested: false } });
    expect(await missing).toMatchObject({ ok: false, error: { code: 'document_not_found' } });
    expect(f.runtime.state().blocked).toBe(false); expect(f.aborted()).toBe(false);
  } finally { blocker.release(); f.modelReleased.resolve(); await blocker.completion; await revoking; await missing; await f.runtime.close(); }
});

test('document revocation reports success only after its actual owner COMMIT', async () => {
  const f = await fixture(); await registerDocument(f);
  const transaction = f.store.transaction, release = Promise.withResolvers<void>();
  let paused = false, settled = false;
  f.store.transaction = operation => {
    f.store.transaction = transaction;
    return transaction(async scope => { const result = await operation(scope); paused = true; await release.promise; return result; });
  };
  const revoking = f.runtime.revokeDocumentUse(1).then(value => { settled = true; return value; });
  try {
    await tick(); expect(paused).toBe(true); expect(settled).toBe(false); expect(f.aborted()).toBe(false);
    release.resolve();
    expect(await revoking).toEqual({ ok: true, data: { affectedSessionIds: [], stopRequested: false } });
  } finally { release.resolve(); f.modelReleased.resolve(); await revoking; await f.runtime.close(); }
});

test('an unknown revocation COMMIT failure blocks Runtime reuse and stops the active native work', async () => {
  const f = await fixture(); await registerDocument(f);
  await f.store.transaction(scope => scope.db.exec('CREATE TABLE revoke_owner_parent(id INTEGER PRIMARY KEY); '
    + 'CREATE TABLE revoke_owner_child(id INTEGER PRIMARY KEY,parent_id INTEGER REFERENCES revoke_owner_parent(id) DEFERRABLE INITIALLY DEFERRED);'));
  const transaction = f.store.transaction;
  f.store.transaction = operation => {
    f.store.transaction = transaction;
    return transaction(async scope => { const result = await operation(scope); scope.db.exec('INSERT INTO revoke_owner_child VALUES(1,404)'); return result; });
  };
  try {
    expect(await f.runtime.revokeDocumentUse(1)).toMatchObject({ ok: false, error: { code: 'model_access_revocation_failed' } });
    await tick(); expect(f.runtime.state().blocked).toBe(true); expect(f.aborted()).toBe(true);
    expect(await f.store.read(scope => scope.db.query('SELECT id FROM revoke_owner_child').all())).toEqual([]);
  } finally { f.modelReleased.resolve(); await f.runtime.close(); }
});
