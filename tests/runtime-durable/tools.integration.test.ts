import { expect, test } from 'bun:test';
import { createRegistry, defineTask, defineTool, MemoryStorage } from '@earendil-works/pi-durable';
import { Type } from '@earendil-works/pi-ai';
import { Database } from 'bun:sqlite';
import { appError, fail, ok, type DurableSubmissionQuery, type ProviderConfig, type Result, type ToolResult } from '@flowmate/contracts';
import { createDurableRuntime } from '../../packages/runtime-durable/src/runtime.ts';
import { createDurableSqliteStorage } from '../../packages/runtime-durable/src/storage.ts';
import { createDatabaseCoordinator } from '../../packages/core/src/storage/write-coordinator.ts';
import type { InvoiceWorkWorkingContext } from '../../packages/contracts/src/personal-context.ts';
import type { DurableProductToolCall, DurableProductToolFeedback } from '../../packages/contracts/src/durable-runtime.ts';

function need<T>(value: Result<T>): T { if (!value.ok) throw Error(value.error.code); return value.data; }
const owner = { workId: 7, sessionId: 70, attemptId: 700 };
const definition = { name: 'read_invoice_document', description: 'Read the original invoice document.', executionMode: 'sequential' as const,
  inputSchema: { type: 'object', properties: { documentId: { type: 'integer' } }, required: ['documentId'], additionalProperties: false } };
function working(query: DurableSubmissionQuery, tools: InvoiceWorkWorkingContext['actions']['tools'] = ['read_invoice_document']): InvoiceWorkWorkingContext {
  return { version: 1, runtimeKind: 'durable', inputUse: 'phase-bound-only',
    work: { workId: query.workId, personalAgentId: 1, sessionId: query.sessionId, goal: 'Read original invoice.', status: 'open',
      counts: { total: 1, unresolved: 1, accepted: 0, rejected: 0, excluded: 0 } },
    phase: { phaseId: query.requestId === 'phase-two' ? 62 : 61, attemptId: query.attemptId, requestId: query.requestId,
      basis: { contextSnapshotId: null, inputIds: [101], documentRefs: [{ id: 11, version: 'v1' }], configurationRevision: 1, itemRevision: 1 } },
    item: { workId: query.workId, itemId: 71, revision: 1, documentRef: { id: 11, version: 'v1' }, jobId: 91, candidateRef: null,
      disposition: 'unresolved', decision: null, disposedAt: null, todoCount: 0, latestInputId: 101, updatedAt: '2026-10-29T00:00:00.000Z' },
    userInputs: [{ provenance: 'user-provided', inputId: 101, requestId: 'original', todoId: 81, text: query.requestId, documentRefs: [] }],
    historicalInputReferences: [], confirmedBusinessReferences: [], todos: [], conflicts: [], modelReports: [],
    actions: { authorizesExecution: false, tools, available: [], remainingBudget: {
      modelCalls: 4, toolCalls: 4, toolFeedbackBytes: 4096, timeoutMs: 30_000, childSlots: 1 } }, waitingReason: null, evidenceRefs: [] };
}
function config(port: number): ProviderConfig { return { version: 1, name: 'tool-profile', revision: 1,
  modelRef: { provider: 'controlled-tool', model: 'tool-model' }, native: { authPath: 'unused-auth.json', modelsPath: null },
  connection: { api: 'openai-completions', baseUrl: `http://127.0.0.1:${port}/v1`, contextWindow: 64_000, maxTokens: 8_192 },
  parameters: { maxRetries: 0, maxRetryDelayMs: 1000 } }; }
function response(tool: boolean, calls = 1): Response {
  const delta = tool ? { role: 'assistant', tool_calls: Array.from({ length: calls }, (_, index) => ({ index,
    id: index === 0 ? 'same-provider-call' : 'second-provider-call', type: 'function',
    function: { name: definition.name, arguments: JSON.stringify({ documentId: 11 + index }) } })) }
    : { role: 'assistant', content: 'Original tool receipt consumed.' };
  const chunk = { id: 'controlled-tool', object: 'chat.completion.chunk', created: 1, model: 'tool-model',
    choices: [{ index: 0, delta, finish_reason: tool ? 'tool_calls' : 'stop' }] };
  return new Response(`data: ${JSON.stringify(chunk)}\n\ndata: [DONE]\n\n`, { headers: { 'content-type': 'text/event-stream' } });
}

test('native tools consume one product result and exact feedback per original phase despite identical input and provider call IDs', async () => {
  const calls: DurableProductToolCall[] = [], feedback: DurableProductToolFeedback[] = [], seen: string[] = [];
  const checked: string[] = [];
  const storage = new MemoryStorage();
  const server = Bun.serve({ port: 0, fetch: async request => {
    const body = await request.json() as { messages: Array<{ role: string }> }; seen.push(JSON.stringify(body));
    return response(!body.messages.some(message => message.role === 'tool'));
  } });
  const runtime = need(await createDurableRuntime({ storage, readApiKey: () => 'synthetic-tool-key',
    verifyModelUse: () => { checked.push('model'); return ok(undefined); }, reserveModelRequest: () => ok(undefined),
    readWorkingContext: query => ok(working(query)), verifyWorkingContext: query => { checked.push(query.requestId); return ok(undefined); },
    tools: [definition], executeTool: async input => {
      expect(checked.at(-1)).toBe('model'); expect(checked.at(-2)).toBe(input.requestId);
      expect(input.signal.aborted).toBe(false); calls.push(input);
      return ok({ status: 'succeeded', data: { invoiceText: `发票 ${input.requestId}`, version: 'v1' } });
    }, readToolResult: () => ok(null), onToolFeedback: input => { feedback.push(input); return ok(undefined); } }));
  try {
    need(await runtime.openConversation({ workId: owner.workId, sessionId: owner.sessionId }));
    for (const requestId of ['phase-one', 'phase-two']) {
      const query = { ...owner, requestId };
      need(await runtime.submit({ ...query, text: 'Identical native admission.', config: config(server.port!) }));
      const settled = await runtime.waitForSubmission(query);
      expect(need(settled)).toMatchObject({ status: 'done', answer: 'Original tool receipt consumed.' });
    }
    expect(calls).toHaveLength(2); expect(feedback).toHaveLength(2); expect(seen).toHaveLength(4);
    expect(calls.map(call => call.requestId)).toEqual(['phase-one', 'phase-two']);
    expect(calls[0]!.nativeToolCallId).toBe(calls[1]!.nativeToolCallId);
    expect(calls[0]!.nativeTaskId).not.toBe(calls[1]!.nativeTaskId);
    expect(calls[0]!.nativeConversationId).toBe(calls[1]!.nativeConversationId);
    expect(seen[2]).not.toContain('发票 phase-one');
    const history = need(await runtime.queryHistory({ workId: owner.workId, sessionId: owner.sessionId, limit: 100 }));
    for (const saved of feedback) {
      const entry = history.entries.find(entry => entry.nativeEntryId === saved.nativeEntryId);
      expect(entry).toBeDefined();
      expect(saved.feedbackJson).toBe(JSON.stringify(JSON.parse(entry!.json).model[0]));
      expect(new TextEncoder().encode(saved.feedbackJson).byteLength).toBeGreaterThan(saved.feedbackJson.length);
      expect(JSON.parse(saved.feedbackJson)).toMatchObject({ role: 'toolResult', toolCallId: 'same-provider-call', toolName: definition.name, isError: false });
    }
  } finally { need(await runtime.close()); server.stop(true); }
}, 15_000);

test('a live product phase rejects another request before alias changes and completes its original tool and model turn', async () => {
  const entered = Promise.withResolvers<void>(), release = Promise.withResolvers<void>();
  let requests = 0, held = false;
  const calls: DurableProductToolCall[] = [];
  const server = Bun.serve({ port: 0, fetch: () => { requests++; return response(requests === 1); } });
  const runtime = need(await createDurableRuntime({ storage: new MemoryStorage(), readApiKey: () => 'synthetic-key',
    verifyModelUse: () => ok(undefined), reserveModelRequest: () => ok(undefined), readWorkingContext: query => ok(working(query)),
    verifyWorkingContext: async query => {
      if (requests === 1 && !held && query.requestId === 'phase-one') { held = true; entered.resolve(); await release.promise; }
      return ok(undefined);
    }, tools: [definition], executeTool: call => { calls.push(call); return ok({ status: 'succeeded', data: { phase: call.requestId } }); },
    readToolResult: () => ok(null) }));
  const first = { ...owner, requestId: 'phase-one' }, second = { ...owner, requestId: 'phase-two' };
  try {
    need(await runtime.openConversation({ workId: owner.workId, sessionId: owner.sessionId }));
    need(await runtime.submit({ ...first, text: 'Identical native admission.', config: config(server.port!) }));
    await entered.promise;
    const secondResult = await runtime.submit({ ...second, text: 'Identical native admission.', config: config(server.port!) });
    expect(calls).toHaveLength(0); release.resolve();
    const firstResult = need(await runtime.waitForSubmission(first));
    expect({ secondResult, firstResult }).toMatchObject({ secondResult: { ok: false, error: { code: 'agent_busy' } },
      firstResult: { status: 'done', answer: 'Original tool receipt consumed.' } });
    expect(calls.map(call => call.requestId)).toEqual(['phase-one']);
    expect(need(await runtime.getSubmission(second))).toBeNull();
    expect(requests).toBe(2);
  } finally { release.resolve(); need(await runtime.close()); server.stop(true); }
}, 15_000);

test('a completed product input still rejects a new phase until its owned native task ends', async () => {
  const entered = Promise.withResolvers<void>(), release = Promise.withResolvers<void>(), completed = Promise.withResolvers<void>();
  let requests = 0;
  const background = defineTask<Record<string, never>, { phase: 'wait' }, null>({ name: 'test.product-owned-tool', version: 1,
    initial: () => ({ phase: 'wait' }), phases: { wait: async (_task, api, context) => {
      entered.resolve(); await release.promise;
      await api.commit(() => ({ status: 'terminal', outcome: { status: 'completed', result: null } }), context);
      completed.resolve();
    } }, abort: (_task, api, context) => api.commit(() => ({ status: 'terminal', outcome: { status: 'aborted' } }), context) });
  const registry = createRegistry();
  registry.install({ name: 'test-product-owned', tasks: [background], tools: [defineTool({ name: definition.name,
    description: definition.description, parameters: Type.Object({ documentId: Type.Integer() }), replay: 'safe', execute: async (_args, api, context) => {
      await api.commit(async tx => {
        const child = await tx.createConversation({ ownership: { kind: 'task', taskId: api.taskId } });
        await tx.createTask(background, {}, { conversationId: child.id, ownership: { kind: 'conversation' }, background: true });
      }, context);
      return { output: [{ type: 'text', text: 'Original owned evidence task started.' }], control: { terminate: true } };
    } })] });
  const server = Bun.serve({ port: 0, fetch: () => { requests++; return response(requests === 1); } });
  const runtime = need(await createDurableRuntime({ storage: new MemoryStorage(), registry, readApiKey: () => 'synthetic-key',
    verifyModelUse: () => ok(undefined), reserveModelRequest: () => ok(undefined), readWorkingContext: query => ok(working(query)),
    verifyWorkingContext: () => ok(undefined) }));
  const first = { ...owner, requestId: 'phase-one' }, second = { ...owner, requestId: 'phase-two' };
  try {
    need(await runtime.openConversation({ workId: owner.workId, sessionId: owner.sessionId }));
    need(await runtime.submit({ ...first, text: 'Original input.', config: config(server.port!) }));
    await entered.promise;
    expect(need(await runtime.waitForSubmission(first)).status).toBe('done');
    expect(await runtime.submit({ ...second, text: 'Next input.', config: config(server.port!) }))
      .toMatchObject({ ok: false, error: { code: 'agent_busy' } });
    expect(need(await runtime.getSubmission(second))).toBeNull(); expect(requests).toBe(1);
    release.resolve(); await completed.promise;
    need(await runtime.submit({ ...second, text: 'Next input.', config: config(server.port!) }));
    expect(need(await runtime.waitForSubmission(second))).toMatchObject({ status: 'done', answer: 'Original tool receipt consumed.' });
    expect(requests).toBe(2);
  } finally { release.resolve(); need(await runtime.close()); server.stop(true); }
}, 15_000);

test('an unconfirmed exact native feedback charge prevents the next model round', async () => {
  let requests = 0, executions = 0, charges = 0;
  const server = Bun.serve({ port: 0, fetch: () => { requests++; return response(true); } });
  const runtime = need(await createDurableRuntime({ storage: new MemoryStorage(), readApiKey: () => 'synthetic-key',
    verifyModelUse: () => ok(undefined), reserveModelRequest: () => ok(undefined), readWorkingContext: query => ok(working(query)),
    verifyWorkingContext: () => ok(undefined), tools: [definition],
    executeTool: () => { executions++; return ok({ status: 'succeeded', data: { original: true } }); }, readToolResult: () => ok(null),
    onToolFeedback: () => { charges++; return fail(appError('tool_context_limit', 'runtime', 'Exact native feedback exceeds the shared budget.')); } }));
  const query = { ...owner, requestId: 'feedback-limit' };
  try {
    need(await runtime.openConversation({ workId: owner.workId, sessionId: owner.sessionId }));
    need(await runtime.submit({ ...query, text: 'Read the invoice.', config: config(server.port!) }));
    expect(need(await runtime.waitForSubmission(query)).status).toBe('unanswered');
    expect(requests).toBe(1); expect(executions).toBe(1); expect(charges).toBe(1);
  } finally { need(await runtime.close()); server.stop(true); }
}, 10_000);

test('one unknown result ends a mixed native tool round before another model request', async () => {
  let requests = 0, executions = 0, reads = 0;
  const server = Bun.serve({ port: 0, fetch: () => { requests++; return response(requests === 1, 2); } });
  const runtime = need(await createDurableRuntime({ storage: new MemoryStorage(), readApiKey: () => 'synthetic-key',
    verifyModelUse: () => ok(undefined), reserveModelRequest: () => ok(undefined), readWorkingContext: query => ok(working(query)),
    verifyWorkingContext: () => ok(undefined), tools: [{ ...definition, executionMode: 'parallel' }],
    executeTool: call => {
      executions++; return call.nativeToolCallId === 'same-provider-call'
        ? fail(appError('tool_commit_unconfirmed', 'runtime', 'The original write receipt is unknown.'))
        : ok({ status: 'succeeded', data: { invoiceId: 12 } });
    }, readToolResult: () => { reads++; return ok(null); } }));
  const query = { ...owner, requestId: 'mixed-round' };
  try {
    need(await runtime.openConversation({ workId: owner.workId, sessionId: owner.sessionId }));
    need(await runtime.submit({ ...query, text: 'Read both invoices.', config: config(server.port!) }));
    expect(need(await runtime.waitForSubmission(query)).status).toBe('unanswered');
    expect(executions).toBe(2); expect(reads).toBe(1); expect(requests).toBe(1);
    const history = need(await runtime.queryHistory({ workId: owner.workId, sessionId: owner.sessionId, limit: 100 }));
    expect(history.entries.filter(entry => entry.kind === 'pi.tool-result').map(entry => JSON.parse(entry.json).model[0].details.status).sort())
      .toEqual(['succeeded', 'unknown']);
  } finally { need(await runtime.close()); server.stop(true); }
}, 10_000);

test.each([true, false])('a lost product receipt is queried once and never reexecutes the write; confirmed=%s', async confirmed => {
  let requests = 0, executions = 0, reads = 0;
  const feedback: DurableProductToolFeedback[] = [];
  const server = Bun.serve({ port: 0, fetch: () => { requests++; return response(requests === 1); } });
  const result: ToolResult<unknown> = { status: 'succeeded', data: { candidateId: 123, state: 'saved' } };
  const runtime = need(await createDurableRuntime({ storage: new MemoryStorage(), readApiKey: () => 'synthetic-key',
    verifyModelUse: () => ok(undefined), reserveModelRequest: () => ok(undefined),
    readWorkingContext: query => ok(working(query)), verifyWorkingContext: () => ok(undefined), tools: [definition],
    executeTool: () => { executions++; return fail(appError('storage_write_failed', 'storage', 'The commit acknowledgment was lost.', true)); },
    readToolResult: () => { reads++; return ok(confirmed ? result : null); },
    onToolFeedback: value => { feedback.push(value); return ok(undefined); } }));
  const query = { ...owner, requestId: 'lost-receipt' };
  try {
    need(await runtime.openConversation({ workId: owner.workId, sessionId: owner.sessionId }));
    need(await runtime.submit({ ...query, text: 'Use the original tool result.', config: config(server.port!) }));
    expect(need(await runtime.waitForSubmission(query)).status).toBe(confirmed ? 'done' : 'unanswered');
    expect(executions).toBe(1); expect(reads).toBe(1); expect(requests).toBe(confirmed ? 2 : 1);
    expect(feedback).toHaveLength(1);
    expect(JSON.parse(feedback[0]!.feedbackJson).details).toMatchObject({ status: confirmed ? 'succeeded' : 'unknown' });
    expect(need(await runtime.getSubmission(query))?.status).toBe(confirmed ? 'done' : 'unanswered');
    expect(executions).toBe(1); expect(reads).toBe(1);
  } finally { need(await runtime.close()); server.stop(true); }
}, 10_000);

test.each(['basis', 'model', 'tool-set'] as const)('native dispatch rejects a revoked original %s before product execution', async denied => {
  let dispatched = false, executions = 0, requests = 0;
  const feedback: DurableProductToolFeedback[] = [];
  const refusal = fail(appError('state_conflict', 'runtime', 'Original phase authority changed.'));
  const server = Bun.serve({ port: 0, fetch: () => { requests++; dispatched = true; return response(true); } });
  const runtime = need(await createDurableRuntime({ storage: new MemoryStorage(), readApiKey: () => 'synthetic-key',
    verifyModelUse: () => denied === 'model' && dispatched ? refusal : ok(undefined), reserveModelRequest: () => ok(undefined),
    readWorkingContext: query => ok(working(query, denied === 'tool-set' && dispatched ? [] : [definition.name])),
    verifyWorkingContext: () => denied === 'basis' && dispatched ? refusal : ok(undefined), tools: [definition],
    executeTool: () => { executions++; return ok({ status: 'succeeded', data: {} }); }, readToolResult: () => ok(null),
    onToolFeedback: value => { feedback.push(value); return ok(undefined); } }));
  const query = { ...owner, requestId: 'revoked-phase' };
  try {
    need(await runtime.openConversation({ workId: owner.workId, sessionId: owner.sessionId }));
    need(await runtime.submit({ ...query, text: 'Read the invoice.', config: config(server.port!) }));
    // Waiting can itself refuse the revoked admission; original receipt queries never restart it.
    await runtime.waitForSubmission(query);
    const until = Date.now() + 2000;
    while (feedback.length === 0 && Date.now() < until) await new Promise<void>(resolve => setTimeout(resolve, 10));
    expect(executions).toBe(0); expect(requests).toBe(1); expect(feedback).toHaveLength(1);
    expect(JSON.parse(feedback[0]!.feedbackJson)).toMatchObject({ isError: true, details: { status: 'failed' } });
  } finally { need(await runtime.close()); server.stop(true); }
}, 10_000);

test('stopping the original attempt aborts the product tool signal and prevents a later write', async () => {
  const entered = Promise.withResolvers<void>(); let allowed = true, writes = 0, requests = 0;
  const server = Bun.serve({ port: 0, fetch: () => { requests++; return response(true); } });
  const runtime = need(await createDurableRuntime({ storage: new MemoryStorage(), readApiKey: () => 'synthetic-key',
    verifyModelUse: () => allowed ? ok(undefined) : fail(appError('session_scope_revoked', 'session', 'Stopped.')),
    reserveModelRequest: () => ok(undefined), readWorkingContext: query => ok(working(query)), verifyWorkingContext: () => ok(undefined), tools: [definition],
    executeTool: async ({ signal }) => {
      entered.resolve();
      await new Promise<void>(resolve => { if (signal.aborted) resolve(); else signal.addEventListener('abort', () => resolve(), { once: true }); });
      if (signal.aborted) return ok({ status: 'cancelled', error: appError('tool_cancelled', 'runtime', 'Cancelled before its write.') });
      writes++; return ok({ status: 'succeeded', data: {} });
    }, readToolResult: () => ok(null) }));
  const query = { ...owner, requestId: 'stop-tool' };
  try {
    need(await runtime.openConversation({ workId: owner.workId, sessionId: owner.sessionId }));
    need(await runtime.submit({ ...query, text: 'Read the invoice.', config: config(server.port!) }));
    await entered.promise; allowed = false;
    expect(need(await runtime.stopAttempt({ ...owner, stopGraceMs: 1000 }))).toMatchObject({ stopped: true });
    expect(writes).toBe(0); expect(requests).toBe(1);
    expect(need(await runtime.getSubmission(query))?.status).toBe('unanswered');
    expect(await runtime.resumeAttempt(owner)).toMatchObject({ ok: false });
    expect(writes).toBe(0); expect(requests).toBe(1);
  } finally { need(await runtime.close()); server.stop(true); }
}, 10_000);

test.each([true, false])('SQLite native tool recovery reads its original product receipt without replay; confirmed=%s', async confirmed => {
  const coordinator = createDatabaseCoordinator(new Database(':memory:'));
  const entered = Promise.withResolvers<void>(); let executions = 0, reads = 0, requests = 0;
  let originalCall: DurableProductToolCall | undefined;
  const seenCalls: DurableProductToolCall[] = [], feedback: DurableProductToolFeedback[] = [];
  const server = Bun.serve({ port: 0, fetch: () => { requests++; return response(requests === 1); } });
  const options = { readApiKey: () => 'synthetic-key', verifyModelUse: () => ok(undefined), reserveModelRequest: () => ok(undefined),
    readWorkingContext: (query: DurableSubmissionQuery) => ok(working(query)), verifyWorkingContext: () => ok(undefined),
    tools: [{ ...definition, ...(confirmed ? { effect: 'READ' as const } : {}) }],
    executeTool: async (call: DurableProductToolCall & { signal: AbortSignal }): Promise<Result<ToolResult<unknown>>> => {
      executions++; originalCall = call; entered.resolve();
      await new Promise<void>((_resolve, reject) => { if (call.signal.aborted) reject(call.signal.reason);
        else call.signal.addEventListener('abort', () => reject(call.signal.reason), { once: true }); });
      return ok({ status: 'succeeded', data: {} });
    }, readToolResult: (call: DurableProductToolCall): Result<ToolResult<unknown> | null> => {
      reads++; seenCalls.push(call); return ok(confirmed ? { status: 'succeeded', data: { originalCandidateId: 123 } } : null);
    }, onToolFeedback: (value: DurableProductToolFeedback) => { feedback.push(value); return ok(undefined); } };
  let runtime = need(await createDurableRuntime({ ...options, storage: await createDurableSqliteStorage(coordinator) }));
  const query = { ...owner, requestId: 'restart-tool' }, selected = config(server.port!);
  try {
    const binding = need(await runtime.prepareModel({ ...query, config: selected }));
    need(await runtime.openConversation({ workId: owner.workId, sessionId: owner.sessionId }));
    need(await runtime.submit({ ...query, binding, text: 'Use the original receipt.', config: selected }));
    await entered.promise; need(await runtime.close());
    runtime = need(await createDurableRuntime({ ...options, storage: await createDurableSqliteStorage(coordinator) }));
    need(await runtime.restoreModel({ ...query, binding }));
    expect(need(await runtime.waitForSubmission(query)).status).toBe(confirmed ? 'done' : 'unanswered');
    expect(executions).toBe(1); expect(reads).toBe(1); expect(requests).toBe(confirmed ? 2 : 1);
    expect(seenCalls[0]).toMatchObject({ ...query, nativeTaskId: originalCall!.nativeTaskId,
      nativeConversationId: originalCall!.nativeConversationId, nativeToolCallId: originalCall!.nativeToolCallId,
      arguments: { documentId: 11 } });
    expect(feedback).toHaveLength(1);
    expect(JSON.parse(feedback[0]!.feedbackJson).details.status).toBe(confirmed ? 'succeeded' : 'unknown');
  } finally { need(await runtime.close()); await coordinator.close(); server.stop(true); }
}, 15_000);
