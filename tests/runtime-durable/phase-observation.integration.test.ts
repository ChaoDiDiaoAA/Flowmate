import { expect, test } from 'bun:test';
import { Database } from 'bun:sqlite';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createRegistry, defineTask, defineTool, MemoryStorage, StorageRequestError } from '@earendil-works/pi-durable';
import { Type } from '@earendil-works/pi-ai';
import { appError, fail, ok, type DurableSubmissionQuery, type ProviderConfig, type Result } from '@flowmate/contracts';
import { createDatabaseCoordinator } from '@flowmate/core';
import { createDurableRuntime, createDurableSqliteStorage } from '@flowmate/runtime-durable';
import type { InvoiceWorkWorkingContext } from '../../packages/contracts/src/personal-context.ts';

function need<T>(value: Result<T>): T { if (!value.ok) throw Error(value.error.code); return value.data; }
const owner = { workId: 7, sessionId: 70, attemptId: 700 };
test.each(['read', 'verify'] as const)('a phase runtime rejects a lone %s working-context hook before execution', async hook => {
  let calls = 0;
  const runtime = await createDurableRuntime({ storage: new MemoryStorage(),
    readApiKey: () => { calls++; return 'controlled-key'; }, verifyModelUse: () => { calls++; return ok(undefined); },
    reserveModelRequest: () => { calls++; return ok(undefined); },
    ...(hook === 'read' ? { readWorkingContext: () => fail(appError('state_conflict', 'runtime', 'No phase.')) }
      : { verifyWorkingContext: () => ok(undefined) }) });
  try {
    expect(runtime).toMatchObject({ ok: false, error: { code: 'input_invalid' } });
    expect(calls).toBe(0);
  } finally { if (runtime.ok) need(await runtime.data.close()); }
});
function context(query: DurableSubmissionQuery, text = query.requestId, tools: InvoiceWorkWorkingContext['actions']['tools'] = []): InvoiceWorkWorkingContext {
  return { version: 1, runtimeKind: 'durable', inputUse: 'phase-bound-only',
    work: { workId: query.workId, personalAgentId: 1, sessionId: query.sessionId, goal: 'Organize invoices.', status: 'open',
      counts: { total: 2, unresolved: 2, accepted: 0, rejected: 0, excluded: 0 } },
    phase: { phaseId: query.requestId === 'phase-two' ? 62 : 61, attemptId: query.attemptId, requestId: query.requestId,
      basis: { contextSnapshotId: null, inputIds: [101], documentRefs: [{ id: 11, version: 'v1' }], configurationRevision: 1, itemRevision: 1 } },
    item: { workId: query.workId, itemId: 71, revision: 1, documentRef: { id: 11, version: 'v1' }, jobId: 91,
      candidateRef: null, disposition: 'unresolved', decision: null, disposedAt: null, todoCount: 0,
      latestInputId: 101, updatedAt: '2026-10-29T00:00:00.000Z' },
    userInputs: [{ provenance: 'user-provided', inputId: 101, requestId: 'supplement-original', todoId: 81, text, documentRefs: [] }],
    historicalInputReferences: [], confirmedBusinessReferences: [], todos: [], conflicts: [], modelReports: [],
    actions: { authorizesExecution: false, tools, available: [], remainingBudget: {
      modelCalls: 4, toolCalls: 4, toolFeedbackBytes: 4096, timeoutMs: 30_000, childSlots: 1 } }, waitingReason: null, evidenceRefs: [] };
}
function config(port: number): ProviderConfig { return { version: 1, name: 'phase-profile', revision: 1,
  modelRef: { provider: 'controlled-phase', model: 'phase-model' }, native: { authPath: 'unused-auth.json', modelsPath: null },
  connection: { api: 'openai-completions', baseUrl: `http://127.0.0.1:${port}/v1`, contextWindow: 64_000, maxTokens: 8_192 },
  parameters: { maxRetries: 0, maxRetryDelayMs: 1000 } }; }
function answer(text: string): Response {
  const chunk = { id: 'phase', object: 'chat.completion.chunk', created: 1, model: 'phase-model',
    choices: [{ index: 0, delta: { role: 'assistant', content: text }, finish_reason: 'stop' }] };
  return new Response(`data: ${JSON.stringify(chunk)}\n\ndata: [DONE]\n\n`, { headers: { 'content-type': 'text/event-stream' } });
}

test('phase observations prove the exact frozen input was consumed and survive SQLite reopen without execution', async () => {
  const root = await mkdtemp(join(tmpdir(), 'flowmate-phase-observation-')), path = join(root, 'app.sqlite');
  let coordinator = createDatabaseCoordinator(new Database(path, { create: true }));
  const entered = Promise.withResolvers<void>(), release = Promise.withResolvers<void>();
  const seen: string[] = []; let reads = 0, checks = 0;
  const server = Bun.serve({ port: 0, fetch: async request => {
    seen.push(JSON.stringify(await request.json()));
    if (seen.length === 1) { entered.resolve(); await release.promise; }
    return answer(`answer-${seen.length}`);
  } });
  const options = { readApiKey: () => { reads++; return 'synthetic-phase-key'; }, verifyModelUse: () => ok(undefined),
    reserveModelRequest: () => ok(undefined), readWorkingContext: (query: DurableSubmissionQuery) => ok(context(query)),
    verifyWorkingContext: () => { checks++; return ok(undefined); } };
  let runtime = need(await createDurableRuntime({ ...options, storage: await createDurableSqliteStorage(coordinator) }));
  const first = { ...owner, requestId: 'phase-one' }, second = { ...owner, requestId: 'phase-two' };
  try {
    expect(runtime.observeSubmission).toBeFunction();
    need(await runtime.openConversation({ workId: 7, sessionId: 70 }));
    const submitted = need(await runtime.submit({ ...first, config: config(server.port!), text: 'Identical native admission.' }));
    await entered.promise;
    expect(need(await runtime.observeSubmission(first))).toMatchObject({ nativeSubmissionId: submitted.nativeSubmissionId,
      consumedAt: null, execution: 'active' });
    release.resolve(); need(await runtime.waitForSubmission(first));
    const observed = need(await runtime.observeSubmission(first));
    expect(observed).toMatchObject({ ...first, nativeSubmissionId: submitted.nativeSubmissionId, status: 'done', execution: 'closed' });
    expect(observed?.nativeEntryId).toBeNumber(); expect(observed?.consumedAt).toBeString();
    need(await runtime.submit({ ...second, config: config(server.port!), text: 'Identical native admission.' }));
    need(await runtime.waitForSubmission(second));
    const newer = need(await runtime.observeSubmission(second));
    expect(newer?.nativeEntryId).not.toBe(observed?.nativeEntryId);
    expect(newer).toMatchObject({ status: 'done', execution: 'closed' }); expect(newer?.consumedAt).toBeString();
    expect(seen).toHaveLength(2); expect(seen[0]).toContain('phase-one'); expect(seen[1]).toContain('phase-two');
    expect(seen[1]).not.toContain('phase-one'); expect(seen[1]).not.toContain('answer-1');
    expect(await runtime.observeSubmission({ ...first, sessionId: 80 })).toMatchObject({ ok: false });
    expect(need(await runtime.observeSubmission({ ...first, requestId: 'absent' }))).toBeNull();
    await runtime.close(); await coordinator.close();
    coordinator = createDatabaseCoordinator(new Database(path));
    const reopened = await createDurableSqliteStorage(coordinator), commit = reopened.commit.bind(reopened); let writes = 0;
    reopened.commit = (batch, context) => { writes += batch.length; return commit(batch, context); };
    runtime = need(await createDurableRuntime({ ...options, storage: reopened }));
    const before = { reads, checks, requests: seen.length };
    const beforeWrites = writes;
    expect(need(await runtime.observeSubmission(first))).toEqual(observed);
    expect(need(await runtime.observeSubmission(second))).toEqual(newer);
    expect(need(await runtime.getSubmission(first))).toMatchObject({ status: 'done' });
    expect(writes).toBe(beforeWrites);
    expect({ reads, checks, requests: seen.length }).toEqual(before);
  } finally { release.resolve(); await runtime.close(); await coordinator.close(); server.stop(true); await rm(root, { recursive: true, force: true }); }
}, 15_000);

test('a failed ordinary run leaves its queued input unconsumed and observation never restarts afterFailedRun keep', async () => {
  const coordinator = createDatabaseCoordinator(new Database(':memory:'));
  const entered = Promise.withResolvers<void>(), release = Promise.withResolvers<void>(); let requests = 0;
  const server = Bun.serve({ port: 0, fetch: async () => {
    requests++; entered.resolve(); await release.promise;
    return new Response(JSON.stringify({ error: { message: 'Controlled failure.' } }), { status: 503 });
  } });
  const runtime = need(await createDurableRuntime({ storage: await createDurableSqliteStorage(coordinator),
    readApiKey: () => 'synthetic-key', verifyModelUse: () => ok(undefined), reserveModelRequest: () => ok(undefined) }));
  const first = { ...owner, requestId: 'failed-phase' }, queued = { ...owner, requestId: 'queued-phase' };
  try {
    need(await runtime.openConversation({ workId: 7, sessionId: 70 }));
    need(await runtime.submit({ ...first, config: config(server.port!), text: 'Identical native admission.' }));
    await entered.promise;
    expect(need(await runtime.submit({ ...queued, config: config(server.port!), text: 'Identical native admission.' })).status).toBe('queued');
    expect(need(await runtime.observeSubmission(queued))).toMatchObject({ status: 'queued', nativeEntryId: null, consumedAt: null, execution: 'unknown' });
    release.resolve(); expect(need(await runtime.waitForSubmission(first)).status).toBe('unanswered');
    expect(need(await runtime.observeSubmission(first))).toMatchObject({ consumedAt: null, status: 'unanswered' });
    expect(need(await runtime.observeSubmission(queued))).toMatchObject({ status: 'queued', nativeEntryId: null, consumedAt: null, execution: 'unknown' });
    expect(requests).toBe(1);
  } finally { release.resolve(); await runtime.close(); await coordinator.close(); server.stop(true); }
}, 10_000);

test('a frozen phase failure blocks model use before request dispatch and reports no consumption', async () => {
  const coordinator = createDatabaseCoordinator(new Database(':memory:')); let requests = 0;
  const server = Bun.serve({ port: 0, fetch: () => { requests++; return answer('Must not run.'); } });
  let allowed = true;
  const runtime = need(await createDurableRuntime({ storage: await createDurableSqliteStorage(coordinator),
    readApiKey: () => { allowed = false; return 'synthetic-key'; }, verifyModelUse: () => ok(undefined), reserveModelRequest: () => ok(undefined),
    readWorkingContext: query => ok(context(query)), verifyWorkingContext: () => allowed ? ok(undefined)
      : fail(appError('state_conflict', 'runtime', 'The frozen invoice basis changed.')) }));
  const query = { ...owner, requestId: 'stale-phase' };
  try {
    need(await runtime.openConversation({ workId: 7, sessionId: 70 }));
    need(await runtime.submit({ ...query, config: config(server.port!), text: 'Review.' }));
    expect(need(await runtime.waitForSubmission(query)).status).toBe('unanswered');
    expect(need(await runtime.observeSubmission(query))).toMatchObject({ consumedAt: null, status: 'unanswered', execution: 'closed' });
    expect(requests).toBe(0);
  } finally { await runtime.close(); await coordinator.close(); server.stop(true); }
}, 10_000);

test.each(['conversation', 'owned-conversation'] as const)('a completed submission is active until every native owned task ends: %s', async scope => {
  const coordinator = createDatabaseCoordinator(new Database(':memory:'));
  const storage = await createDurableSqliteStorage(coordinator), registry = createRegistry();
  const entered = Promise.withResolvers<void>(), release = Promise.withResolvers<void>(); let requests = 0;
  const background = defineTask<Record<string, never>, { phase: 'wait' }, null>({ name: 'phase.background', version: 1,
    initial: () => ({ phase: 'wait' }), phases: { wait: async (_task, runtime, context) => {
      entered.resolve(); await release.promise;
      await runtime.commit(() => ({ status: 'terminal', outcome: { status: 'completed', result: null } }), context);
    } }, abort: (_task, runtime, context) => runtime.commit(() => ({ status: 'terminal', outcome: { status: 'aborted' } }), context) });
  registry.install({ name: 'phase-background', tasks: [background], tools: [defineTool({ name: 'read_invoice_document',
    description: 'Read controlled invoice evidence.', parameters: Type.Object({}), replay: 'safe', execute: async (_args, api, context) => {
      if (scope === 'conversation') await api.createTask(background, {}, { ownership: { kind: 'conversation' }, background: true }, context);
      else await api.commit(async tx => {
        const child = await tx.createConversation({ ownership: { kind: 'task', taskId: api.taskId } });
        await tx.createTask(background, {}, { conversationId: child.id, ownership: { kind: 'conversation' }, background: true });
      }, context);
      return { output: [{ type: 'text', text: 'Original evidence.' }], control: { terminate: true } };
    } })] });
  const server = Bun.serve({ port: 0, fetch: () => {
    requests++;
    const chunk = { id: 'phase-tool', object: 'chat.completion.chunk', created: 1, model: 'phase-model',
      choices: [{ index: 0, delta: { role: 'assistant', tool_calls: [{ index: 0, id: 'invoice-reader', type: 'function',
        function: { name: 'read_invoice_document', arguments: '{}' } }] }, finish_reason: 'tool_calls' }] };
    return new Response(`data: ${JSON.stringify(chunk)}\n\ndata: [DONE]\n\n`, { headers: { 'content-type': 'text/event-stream' } });
  } });
  const runtime = need(await createDurableRuntime({ storage, registry, readApiKey: () => 'synthetic-key',
    verifyModelUse: () => ok(undefined), reserveModelRequest: () => ok(undefined),
    readWorkingContext: query => ok(context(query, 'Current phase.', ['read_invoice_document'])), verifyWorkingContext: () => ok(undefined) }));
  const query = { ...owner, requestId: 'owned-phase' };
  try {
    need(await runtime.openConversation({ workId: 7, sessionId: 70 }));
    need(await runtime.submit({ ...query, config: config(server.port!), text: 'Read.' }));
    await entered.promise; expect(need(await runtime.waitForSubmission(query)).status).toBe('done');
    const before = need(await runtime.observeSubmission(query));
    expect(before).toMatchObject({ status: 'done', execution: 'active' }); expect(before?.consumedAt).toBeString();
    expect(need(await runtime.stopAttempt({ ...owner, stopGraceMs: 10 })).stopped).toBe(false);
    expect(need(await runtime.observeSubmission(query))).toMatchObject({ status: 'done', execution: 'active', consumedAt: before?.consumedAt });
    release.resolve(); expect(need(await runtime.stopAttempt({ ...owner, stopGraceMs: 1000 })).stopped).toBe(true);
    expect(need(await runtime.observeSubmission(query))).toMatchObject({ status: 'done', execution: 'closed', consumedAt: before?.consumedAt });
    expect(requests).toBe(1);
  } finally { release.resolve(); await runtime.close(); await coordinator.close(); server.stop(true); }
}, 10_000);

test('stopping an ordinary dispatched request before any successful response keeps consumption unknown and withdraws its queued input', async () => {
  const coordinator = createDatabaseCoordinator(new Database(':memory:'));
  const entered = Promise.withResolvers<void>(), release = Promise.withResolvers<void>(); let requests = 0;
  const server = Bun.serve({ port: 0, fetch: async () => { requests++; entered.resolve(); await release.promise; return answer('Too late.'); } });
  const runtime = need(await createDurableRuntime({ storage: await createDurableSqliteStorage(coordinator),
    readApiKey: () => 'synthetic-key', verifyModelUse: () => ok(undefined), reserveModelRequest: () => ok(undefined) }));
  const query = { ...owner, requestId: 'interrupted-phase' }, queued = { ...owner, requestId: 'withdrawn-phase' };
  try {
    need(await runtime.openConversation({ workId: 7, sessionId: 70 }));
    need(await runtime.submit({ ...query, config: config(server.port!), text: 'Review.' })); await entered.promise;
    need(await runtime.submit({ ...queued, config: config(server.port!), text: 'Queued review.' }));
    expect(need(await runtime.observeSubmission(query))).toMatchObject({ status: 'placed', execution: 'active', consumedAt: null });
    expect(need(await runtime.stopAttempt({ ...owner, stopGraceMs: 1000 })).stopped).toBe(true);
    release.resolve();
    expect(need(await runtime.observeSubmission(query))).toMatchObject({ status: 'unanswered', execution: 'closed', consumedAt: null });
    expect(need(await runtime.getSubmission(queued))).toMatchObject({ status: 'unanswered', reason: 'aborted' });
    expect(need(await runtime.observeSubmission(queued))).toMatchObject({ status: 'unanswered', nativeEntryId: null, consumedAt: null, execution: 'closed' });
    expect(await runtime.submit({ ...queued, config: config(server.port!), text: 'Queued review.' }))
      .toMatchObject({ ok: false, error: { code: 'state_conflict' } });
    expect(await runtime.resumeAttempt(owner)).toMatchObject({ ok: false }); expect(requests).toBe(1);
  } finally { release.resolve(); await runtime.close(); await coordinator.close(); server.stop(true); }
}, 10_000);

test('a recoverable native abort transaction failure keeps stop intent and retries only its original execution scope', async () => {
  const coordinator = createDatabaseCoordinator(new Database(':memory:'));
  const storage = await createDurableSqliteStorage(coordinator), scan = storage.scanSubmissions.bind(storage), commit = storage.commit.bind(storage);
  const entered = Promise.withResolvers<void>(), signalled = Promise.withResolvers<void>(), release = Promise.withResolvers<void>();
  let requests = 0, executions = 0, reservations = 0, writes = 0, failAbortRead = false, watchAbort = false, abortReads = 0, abortCommits = 0;
  storage.scanSubmissions = async (query, limit, cursor, context) => {
    if (watchAbort && query.status === 'queued') {
      abortReads++;
      if (failAbortRead) { failAbortRead = false; throw new StorageRequestError('Controlled abort transaction pre-read failure.'); }
    }
    return scan(query, limit, cursor, context);
  };
  storage.commit = async (batch, context) => {
    if (batch.some(write => write.type === 'task' && write.value.abortRequested)) abortCommits++;
    return commit(batch, context);
  };
  const server = Bun.serve({ port: 0, fetch: () => {
    requests++;
    const chunk = { id: 'original-stop-scope', object: 'chat.completion.chunk', created: 1, model: 'phase-model',
      choices: [{ index: 0, delta: { role: 'assistant', tool_calls: [{ index: 0, id: 'original-stop-tool', type: 'function',
        function: { name: 'read_invoice_document', arguments: '{}' } }] }, finish_reason: 'tool_calls' }] };
    return new Response(`data: ${JSON.stringify(chunk)}\n\ndata: [DONE]\n\n`, { headers: { 'content-type': 'text/event-stream' } });
  } });
  const runtime = need(await createDurableRuntime({ storage, readApiKey: () => 'synthetic-key', verifyModelUse: () => ok(undefined),
    reserveModelRequest: () => { reservations++; return ok(undefined); },
    readWorkingContext: query => ok(context(query, 'Original stop scope.', ['read_invoice_document'])), verifyWorkingContext: () => ok(undefined),
    tools: [{ name: 'read_invoice_document', description: 'Hold the original product tool until its native stop is confirmed.', executionMode: 'sequential',
      inputSchema: { type: 'object', properties: {}, additionalProperties: false } }], executeTool: async ({ signal }) => {
      executions++; entered.resolve();
      await new Promise<void>(resolve => { if (signal.aborted) resolve(); else signal.addEventListener('abort', () => resolve(), { once: true }); });
      signalled.resolve(); await release.promise;
      if (!signal.aborted) writes++;
      return ok({ status: 'cancelled', error: appError('tool_cancelled', 'runtime', 'The original native scope stopped before writing.') });
    }, readToolResult: () => ok(null) }));
  const query = { ...owner, requestId: 'retry-original-stop' }, input = { ...query, config: config(server.port!), text: 'Stop this original scope.' };
  try {
    need(await runtime.openConversation({ workId: owner.workId, sessionId: owner.sessionId }));
    const submitted = need(await runtime.submit(input)); await entered.promise;
    const before = need(await runtime.observeSubmission(query));
    expect(before).toMatchObject({ nativeSubmissionId: submitted.nativeSubmissionId, status: 'placed', execution: 'active' });
    expect(before?.consumedAt).toBeString();
    watchAbort = true; failAbortRead = true;
    expect(await runtime.stopAttempt({ ...owner, stopGraceMs: 1000 }))
      .toMatchObject({ ok: false, error: { code: 'durable_stop_failed', retryable: true } });
    expect(abortReads).toBe(1); expect(abortCommits).toBe(0);
    expect(await runtime.resumeAttempt(owner)).toMatchObject({ ok: false, error: { code: 'state_conflict' } });
    expect(need(await runtime.submit(input)).nativeSubmissionId).toBe(submitted.nativeSubmissionId);
    expect(need(await runtime.observeSubmission(query))).toMatchObject({ execution: 'active', consumedAt: before?.consumedAt });
    expect(requests).toBe(1); expect(executions).toBe(1); expect(reservations).toBe(1); expect(writes).toBe(0);
    expect(need(await runtime.stopAttempt({ ...owner, stopGraceMs: 10 })))
      .toMatchObject({ stopped: false, reason: 'stop-unconfirmed' });
    await signalled.promise;
    const pending = { reads: abortReads, commits: abortCommits };
    expect(pending.reads).toBeGreaterThan(1); expect(pending.commits).toBeGreaterThan(0);
    expect(need(await runtime.stopAttempt({ ...owner, stopGraceMs: 10 })).stopped).toBe(false);
    expect({ reads: abortReads, commits: abortCommits }).toEqual(pending);
    release.resolve();
    expect(need(await runtime.stopAttempt({ ...owner, stopGraceMs: 1000 }))).toMatchObject({ stopped: true, reason: 'stopped' });
    expect(need(await runtime.observeSubmission(query))).toMatchObject({ nativeSubmissionId: submitted.nativeSubmissionId,
      status: 'unanswered', execution: 'closed', consumedAt: before?.consumedAt });
    const stopped = { reads: abortReads, commits: abortCommits };
    expect(need(await runtime.stopAttempt({ ...owner, stopGraceMs: 1000 })).stopped).toBe(true);
    expect({ reads: abortReads, commits: abortCommits }).toEqual(stopped);
    expect(await runtime.resumeAttempt(owner)).toMatchObject({ ok: false });
    expect(requests).toBe(1); expect(executions).toBe(1); expect(reservations).toBe(1); expect(writes).toBe(0);
  } finally { release.resolve(); storage.scanSubmissions = scan; storage.commit = commit; await runtime.close(); await coordinator.close(); server.stop(true); }
}, 10_000);
