import { expect, test } from 'bun:test';
import { Database } from 'bun:sqlite';
import { createDatabaseCoordinator } from '@flowmate/core';
import { appError, fail, ok, SUBAGENT_ROLE, SUBAGENT_SYSTEM_PROMPT, type DurableProductToolExecution,
  type DurableSubagentIdentity, type DurableSubagentPlan, type DurableWorkingContextQuery, type InvoiceWorkWorkingContext,
  type ProviderConfig, type Result, type ToolResult } from '@flowmate/contracts';
import { createDurableRuntime } from '../../packages/runtime-durable/src/runtime.ts';
import { createDurableSqliteStorage } from '../../packages/runtime-durable/src/storage.ts';

function need<T>(result: Result<T>): T { if (!result.ok) throw Error(result.error.code); return result.data; }
const owner = { workId: 7, sessionId: 70, attemptId: 700 }, query = { ...owner, requestId: 'original-parent-phase' };
const tools = [{ name: 'Agent', description: 'Ask the read-only invoice evidence checker.', executionMode: 'parallel' as const,
  inputSchema: { type: 'object', properties: { prompt: { type: 'string' }, description: { type: 'string' }, subagent_type: { const: SUBAGENT_ROLE } },
    required: ['prompt', 'description', 'subagent_type'], additionalProperties: false } },
{ name: 'read_invoice_document', description: 'Read the selected invoice.', executionMode: 'parallel' as const,
  inputSchema: { type: 'object', properties: { documentId: { type: 'integer' } }, required: ['documentId'], additionalProperties: false } }];
function working(input: DurableWorkingContextQuery): InvoiceWorkWorkingContext {
  return { version: 1, runtimeKind: 'durable', inputUse: 'phase-bound-only',
    instructions: { version: 1, role: input.child ? SUBAGENT_ROLE : 'invoice-master', provenance: 'phase-instructions', preferences: '', resources: null },
    ...(input.child ? { delegation: { ...input.child, parentRunId: 400, role: SUBAGENT_ROLE,
      prompt: 'Check only invoice eleven.', description: 'Verify original evidence.' } } : {}),
    work: { workId: input.workId, sessionId: input.sessionId, personalAgentId: 1, goal: 'Master organizes only the current invoice.',
      status: 'open', counts: { total: 1, unresolved: 1, accepted: 0, rejected: 0, excluded: 0 } },
    phase: { phaseId: 61, attemptId: input.attemptId, requestId: input.requestId,
      basis: { contextSnapshotId: null, inputIds: [], documentRefs: [{ id: 11, version: 'v1' }], configurationRevision: 1, itemRevision: 1 } },
    item: { workId: input.workId, itemId: 71, revision: 1, documentRef: { id: 11, version: 'v1' }, jobId: 91,
      candidateRef: null, disposition: 'unresolved', decision: null, disposedAt: null, todoCount: 0, latestInputId: null, updatedAt: '2026-10-29T00:00:00.000Z' },
    userInputs: [], historicalInputReferences: [], confirmedBusinessReferences: [], todos: [], conflicts: [], modelReports: [],
    actions: { authorizesExecution: false, tools: input.child ? ['read_invoice_document'] : ['Agent', 'read_invoice_document'], available: [],
      remainingBudget: { modelCalls: 12, toolCalls: 16, toolFeedbackBytes: 65536, timeoutMs: 30000, childSlots: 4 } },
    waitingReason: null, evidenceRefs: [] };
}
function response(name: string | null, text = ''): Response {
  const args = name === 'Agent' ? { prompt: 'Check only invoice eleven.', description: 'Verify original evidence.', subagent_type: SUBAGENT_ROLE } : { documentId: 11 };
  const delta = name ? { role: 'assistant', tool_calls: [{ index: 0, id: name === 'Agent' ? 'original-agent-call' : 'original-child-read', type: 'function',
    function: { name, arguments: JSON.stringify(args) } }] } : { role: 'assistant', content: text };
  const chunk = { id: name ?? 'answer', object: 'chat.completion.chunk', created: 1, model: 'subagent-model',
    choices: [{ index: 0, delta, finish_reason: name ? 'tool_calls' : 'stop' }] };
  return new Response(`data: ${JSON.stringify(chunk)}\n\ndata: [DONE]\n\n`, { headers: { 'content-type': 'text/event-stream' } });
}
function config(port: number): ProviderConfig { return { version: 1, name: 'subagent-profile', revision: 1,
  modelRef: { provider: 'controlled-subagent', model: 'subagent-model' }, native: { authPath: 'unused.json', modelsPath: null },
  connection: { api: 'openai-completions', baseUrl: `http://127.0.0.1:${port}/v1`, contextWindow: 64000, maxTokens: 8192 }, parameters: { maxRetries: 0, maxRetryDelayMs: 1000 } }; }

test.each(['read', 'failed-child', 'nested-attempt'] as const)('a genuine owned child reports through the parent tool into the next Master HTTP request: %s', async mode => {
  const coordinator = createDatabaseCoordinator(new Database(':memory:')), requests: Array<Record<string, unknown>> = [];
  let rootCalls = 0, childCalls = 0, readCalls = 0, agentCalls = 0, plan: DurableSubagentPlan | undefined;
  const consumed: Array<DurableSubagentIdentity & { nativeToolResultEntryId: number; nativeModelTaskId: number; observedAt: string }> = [];
  const feedback: Array<{ child?: unknown; name: string }> = [];
  const delegateResults: unknown[] = [];
  const server = Bun.serve({ port: 0, fetch: async request => {
    const body = await request.json() as { messages: Array<{ role: string; content?: unknown }>; tools?: Array<{ function: { name: string } }> }; requests.push(body);
    const child = body.messages.some(message => typeof message.content === 'string' && message.content.includes('"delegation"'));
    const result = body.messages.some(message => message.role === 'tool');
    if (child) {
      expect(body.tools?.map(tool => tool.function.name)).toEqual(['read_invoice_document']);
      if (mode === 'failed-child') return new Response(JSON.stringify({ error: { message: 'Original controlled child failure.' } }), { status: 503 });
      return result ? response(null, mode === 'nested-attempt' ? 'Nested delegation was refused.' : 'Verified source page one for invoice eleven.')
        : response(mode === 'nested-attempt' ? 'Agent' : 'read_invoice_document');
    }
    return result ? response(null, 'Master received the original child evidence.') : response('Agent');
  } });
  const runtime = need(await createDurableRuntime({ storage: await createDurableSqliteStorage(coordinator), readApiKey: () => 'synthetic-key',
    verifyModelUse: () => ok(undefined), reserveModelRequest: () => { rootCalls++; return ok(undefined); }, tools,
    readWorkingContext: input => ok(working(input)), verifyWorkingContext: () => ok(undefined),
    subagents: { readPlan: async () => plan ? ok(plan) : fail(appError('state_conflict', 'runtime', 'No original child plan.')),
      verify: async () => ok(undefined), adopt: async () => ok(undefined), reserveModelRequest: async () => { childCalls++; return ok(undefined); },
      onParentConsumed: async value => { consumed.push(value); return ok(undefined); } },
    executeTool: async (call: DurableProductToolExecution): Promise<Result<ToolResult<unknown>>> => {
      if (call.name === 'Agent') {
        agentCalls++;
        plan ??= { ...query, childRunId: 501, childSessionId: 801, originToolCallId: 901, nativeToolTaskId: call.nativeTaskId,
          role: SUBAGENT_ROLE, binding: need(await runtime.prepareModel({ ...query, config: config(server.port!) })), thinkingLevel: 'off',
          prompt: 'Check only invoice eleven.', systemPrompt: SUBAGENT_SYSTEM_PROMPT, allowedTools: ['read_invoice_document'] };
        expect(call.nativeDelegate).toBeFunction();
        const result = await call.nativeDelegate!(plan, call.signal); delegateResults.push(result); const observed = need(result);
        if (observed.status === 'unanswered') return ok({ status: 'failed', error: appError('subagent_failed', 'runtime', 'Original child failed.'),
          data: { content: [{ type: 'text', text: `Original child failed: ${observed.reason}` }], details: { childRunId: plan.childRunId } } });
        return ok({ status: 'succeeded', data: { content: [{ type: 'text', text: observed.answer }], details: { childRunId: plan.childRunId } } });
      }
      expect(call.child).toEqual({ childRunId: 501, childSessionId: 801, originToolCallId: 901 });
      expect(call).toMatchObject(query); readCalls++; return ok({ status: 'succeeded', data: { page: 1, text: 'Original invoice eleven evidence.' } });
    }, readToolResult: () => ok(null), onToolFeedback: value => { feedback.push(value); return ok(undefined); } }));
  try {
    need(await runtime.openConversation({ workId: owner.workId, sessionId: owner.sessionId }));
    need(await runtime.submit({ ...query, config: config(server.port!), text: 'Use the checker for this original phase.' }));
    const waited = await runtime.waitForSubmission(query);
    if (!waited.ok) throw Error(JSON.stringify({ waited, delegateResults, requestCount: requests.length,
      native: await coordinator.read(db => db.all('SELECT * FROM fm_durable_tasks')) }));
    const settled = need(waited);
    if (settled.status !== 'done') throw Error(JSON.stringify({ settled, delegateResults, requests }));
    expect(settled).toMatchObject({ status: 'done', answer: 'Master received the original child evidence.' });
    expect(rootCalls).toBe(2); expect(childCalls).toBe(mode === 'failed-child' ? 1 : 2); expect(readCalls).toBe(mode === 'read' ? 1 : 0);
    expect(agentCalls).toBe(1); expect(requests).toHaveLength(mode === 'failed-child' ? 3 : 4);
    expect(JSON.stringify(requests.at(-1))).toContain(mode === 'read' ? 'Verified source page one for invoice eleven.'
      : mode === 'failed-child' ? 'Original child failed' : 'Nested delegation was refused.');
    expect(feedback.map(item => item.name).sort()).toEqual(mode === 'read' ? ['Agent', 'read_invoice_document'] : ['Agent']);
    expect(consumed).toHaveLength(1);
    const observation = need(await runtime.observeSubagent(plan!));
    expect(observation).toMatchObject({ creation: 'created', creatorExecution: 'closed', status: mode === 'failed-child' ? 'unanswered' : 'done', execution: 'closed',
      answer: mode === 'read' ? 'Verified source page one for invoice eleven.' : mode === 'failed-child' ? null : 'Nested delegation was refused.',
      parentToolResultEntryId: consumed[0]!.nativeToolResultEntryId, parentModelTaskId: consumed[0]!.nativeModelTaskId,
      parentModelReceivedAt: consumed[0]!.observedAt });
    const child = { ...query, childRunId: plan!.childRunId, childSessionId: plan!.childSessionId,
      originToolCallId: plan!.originToolCallId, nativeToolTaskId: plan!.nativeToolTaskId };
    const requestCount = requests.length, page = need(await runtime.queryHistoryPage({ workId: owner.workId, sessionId: owner.sessionId, child }));
    expect(page.owner).toEqual({ runtimeKind: 'durable', workId: owner.workId, sessionId: child.childSessionId, childRunId: child.childRunId });
    expect(page.entries.some(entry => entry.kind === 'flowmate.child-input')).toBe(true);
    const entry = need(await runtime.queryHistoryEntry({ workId: owner.workId, sessionId: owner.sessionId, child,
      entryId: page.entries[0]!.entryId, throughEntryId: page.throughEntryId }));
    expect(JSON.parse(entry.text).conversationId).toBe(observation?.nativeConversationId);
    expect((await runtime.queryHistoryPage({ workId: owner.workId, sessionId: owner.sessionId, child: { ...child, requestId: 'foreign-original-phase' } })).ok).toBe(false);
    expect(requests).toHaveLength(requestCount);
  } finally { need(await runtime.close()); await coordinator.close(); server.stop(true); }
}, 15000);

test('a failed product parent-consumption write replays its original native receipt after SQLite reopen without another HTTP request', async () => {
  const coordinator = createDatabaseCoordinator(new Database(':memory:'));
  let requests = 0, executions = 0, plan: DurableSubagentPlan | undefined;
  const received: Array<DurableSubagentIdentity & { nativeToolResultEntryId: number; nativeModelTaskId: number; observedAt: string }> = [];
  const server = Bun.serve({ port: 0, fetch: async request => {
    requests++;
    const body = await request.json() as { messages: Array<{ role: string; content?: unknown }> };
    return body.messages.some(message => typeof message.content === 'string' && message.content.includes('"delegation"'))
      ? response(null, 'Original child receipt.') : body.messages.some(message => message.role === 'tool')
        ? response(null, 'Original Master receipt.') : response('Agent');
  } });
  const options = { readApiKey: () => 'synthetic-key', verifyModelUse: () => ok(undefined), reserveModelRequest: () => ok(undefined), tools,
    readWorkingContext: (input: DurableWorkingContextQuery) => ok(working(input)), verifyWorkingContext: () => ok(undefined),
    subagents: { readPlan: async () => plan ? ok(plan) : fail(appError('state_conflict', 'runtime', 'No original plan.')),
      verify: async () => ok(undefined), adopt: async () => ok(undefined), reserveModelRequest: async () => ok(undefined),
      onParentConsumed: async (value: typeof received[number]): Promise<Result<void>> => {
        received.push(value); return received.length === 1 ? fail(appError('storage_write_failed', 'storage', 'Controlled first product write failure.', true)) : ok(undefined);
      } },
    executeTool: async (call: DurableProductToolExecution): Promise<Result<ToolResult<unknown>>> => {
      executions++;
      plan ??= { ...query, childRunId: 501, childSessionId: 801, originToolCallId: 901, nativeToolTaskId: call.nativeTaskId,
        role: SUBAGENT_ROLE, binding, thinkingLevel: 'off', prompt: 'Check only invoice eleven.', systemPrompt: SUBAGENT_SYSTEM_PROMPT,
        allowedTools: ['read_invoice_document'] };
      return ok({ status: 'succeeded', data: { answer: need(await call.nativeDelegate!(plan, call.signal)).answer } });
    }, readToolResult: () => ok(null), onToolFeedback: () => ok(undefined) };
  let runtime = need(await createDurableRuntime({ ...options, storage: await createDurableSqliteStorage(coordinator) }));
  const binding = need(await runtime.prepareModel({ ...query, config: config(server.port!) }));
  try {
    need(await runtime.openConversation({ workId: owner.workId, sessionId: owner.sessionId }));
    need(await runtime.submit({ ...query, binding, config: binding.configuration, text: 'Preserve this original receipt.' }));
    const original = need(await runtime.waitForSubmission(query));
    if (original.status !== 'done') throw Error(JSON.stringify({ original, native: await coordinator.read(db => db.all('SELECT * FROM fm_durable_tasks')) }));
    expect(original.status).toBe('done');
    expect(received).toHaveLength(1);
    const before = need(await runtime.observeSubagent(plan!));
    expect(before?.parentModelReceivedAt).toBe(received[0]!.observedAt);
    need(await runtime.close());
    runtime = need(await createDurableRuntime({ ...options, storage: await createDurableSqliteStorage(coordinator) }));
    need(await runtime.restoreModel({ ...query, binding }));
    expect(need(await runtime.waitForSubmission(query)).status).toBe('done');
    expect(received).toHaveLength(2); expect(received[1]).toEqual(received[0]);
    expect(need(await runtime.observeSubagent(plan!))).toEqual(before);
    expect(requests).toBe(3); expect(executions).toBe(1);
  } finally { need(await runtime.close()); await coordinator.close(); server.stop(true); }
}, 15000);

test.each(['committed-before-check', 'commits-during-check'] as const)('a fast parallel Agent commits exact native feedback before its peer checks the shared budget for another model: %s', async mode => {
  const coordinator = createDatabaseCoordinator(new Database(':memory:'));
  const results = new Map<number, ToolResult<unknown>>(), plans = new Map<number, DurableSubagentPlan>(), feedback = new Set<number>();
  const both = Promise.withResolvers<void>(), committed = Promise.withResolvers<void>(), releaseFast = Promise.withResolvers<void>();
  const fastReady = Promise.withResolvers<void>(), allowCommit = Promise.withResolvers<void>();
  let entered = 0, rootRequests = 0, childRequests = 0, reads = 0, fastReturned = false, waitedForOriginal = false, slowModelReturned = false;
  const server = Bun.serve({ port: 0, fetch: async request => {
    const body = await request.json() as { messages: Array<{ role: string; content?: unknown }> };
    const child = body.messages.some(message => typeof message.content === 'string' && message.content.includes('"delegation"'));
    if (!child) {
      rootRequests++;
      if (body.messages.some(message => message.role === 'tool')) return response(null, 'Both original reports received.');
      const original = response('Agent'), text = await original.text();
      const chunk = JSON.parse(text.slice(6, text.indexOf('\n\n'))) as { choices: Array<{ delta: { tool_calls: Array<{ index: number; id: string }> } }> };
      const first = chunk.choices[0]!.delta.tool_calls[0]!;
      chunk.choices[0]!.delta.tool_calls.push({ ...first, index: 1, id: 'original-second-agent-call' });
      return new Response(`data: ${JSON.stringify(chunk)}\n\ndata: [DONE]\n\n`, { headers: { 'content-type': 'text/event-stream' } });
    }
    childRequests++;
    const context = body.messages.find(message => typeof message.content === 'string' && message.content.includes('"delegation"'))!.content as string;
    const slow = /"childRunId"\s*:\s*502/.test(context);
    if (!body.messages.some(message => message.role === 'tool')) {
      entered++; if (entered === 2) both.resolve(); await both.promise;
      if (slow) {
        await (mode === 'committed-before-check' ? committed.promise : fastReady.promise);
        slowModelReturned = true; return response('read_invoice_document');
      }
      return response(null, 'Fast original report.');
    }
    return response(null, 'Slow original report.');
  } });
  const budget = (): Result<void> => [...results.keys()].every(task => feedback.has(task)) ? ok(undefined)
    : fail(appError('invoice_work_budget_unknown', 'runtime', 'A committed product result has no exact native feedback yet.'));
  const runtime = need(await createDurableRuntime({ storage: await createDurableSqliteStorage(coordinator), readApiKey: () => 'synthetic-key',
    verifyModelUse: budget, reserveModelRequest: budget, tools, readWorkingContext: input => ok(working(input)), verifyWorkingContext: () => ok(undefined),
    subagents: { readPlan: async input => ok(plans.get(input.childRunId)!), verify: async input => {
      if (mode === 'commits-during-check' && input.childRunId === 502 && slowModelReturned
        && !results.has(plans.get(501)!.nativeToolTaskId)) { allowCommit.resolve(); await committed.promise; }
      const checked = budget();
      if (mode === 'commits-during-check' && !checked.ok) setTimeout(() => releaseFast.resolve(), 0);
      return checked;
    }, adopt: async () => ok(undefined),
      reserveModelRequest: async () => budget(), onParentConsumed: async () => ok(undefined) },
    executeTool: async (call): Promise<Result<ToolResult<unknown>>> => {
      if (call.name === 'Agent') {
        const childRunId = 501 + plans.size;
        const plan: DurableSubagentPlan = { ...query, childRunId, childSessionId: childRunId + 300, originToolCallId: childRunId + 400,
          nativeToolTaskId: call.nativeTaskId, role: SUBAGENT_ROLE, binding, thinkingLevel: 'off', prompt: 'Check only invoice eleven.',
          systemPrompt: SUBAGENT_SYSTEM_PROMPT, allowedTools: ['read_invoice_document'] };
        plans.set(childRunId, plan);
        const result = await call.nativeDelegate!(plan, call.signal); if (!result.ok) return result;
        const saved: ToolResult<unknown> = { status: 'succeeded', data: { answer: result.data.answer } };
        if (childRunId === 501) { fastReady.resolve(); if (mode === 'commits-during-check') await allowCommit.promise; }
        results.set(call.nativeTaskId, saved);
        if (childRunId === 501) { committed.resolve(); await releaseFast.promise; fastReturned = true; }
        return ok(saved);
      }
      reads++; const saved: ToolResult<unknown> = { status: 'succeeded', data: { page: 1 } }; results.set(call.nativeTaskId, saved); return ok(saved);
    }, readToolResult: call => {
      const saved = results.get(call.nativeTaskId) ?? null;
      if (saved && plans.get(501)?.nativeToolTaskId === call.nativeTaskId && !fastReturned) {
        waitedForOriginal = true; setTimeout(() => releaseFast.resolve(), 0);
      }
      return ok(saved);
    }, onToolFeedback: value => {
      expect(JSON.parse(value.feedbackJson)).toMatchObject({ role: 'toolResult', toolCallId: value.nativeToolCallId, toolName: value.name });
      feedback.add(value.nativeTaskId); return ok(undefined);
    } }));
  const binding = need(await runtime.prepareModel({ ...query, config: config(server.port!) }));
  try {
    need(await runtime.openConversation({ workId: owner.workId, sessionId: owner.sessionId }));
    need(await runtime.submit({ ...query, binding, config: binding.configuration, text: 'Check two independent reports.' }));
    expect(need(await runtime.waitForSubmission(query))).toMatchObject({ status: 'done', answer: 'Both original reports received.' });
    expect(plans.size).toBe(2);
    for (const plan of plans.values()) expect(need(await runtime.observeSubagent(plan))).toMatchObject({ status: 'done',
      answer: plan.childRunId === 501 ? 'Fast original report.' : 'Slow original report.', parentModelReceivedAt: expect.any(String) });
    expect(waitedForOriginal).toBe(true);
    expect(rootRequests).toBe(2); expect(childRequests).toBe(3); expect(reads).toBe(1); expect(feedback.size).toBe(3);
  } finally { both.resolve(); committed.resolve(); allowCommit.resolve(); releaseFast.resolve(); need(await runtime.close()); await coordinator.close(); server.stop(true); }
}, 15000);

test('an in-flight owned child creation remains unconfirmed until its exact creator and original scope stop', async () => {
  const coordinator = createDatabaseCoordinator(new Database(':memory:')), storage = await createDurableSqliteStorage(coordinator), commit = storage.commit.bind(storage);
  const entered = Promise.withResolvers<void>(), release = Promise.withResolvers<void>();
  let held = false, requests = 0, childCalls = 0, adopts = 0, plan: DurableSubagentPlan | undefined;
  const codes: string[] = [];
  storage.commit = async (batch, context) => {
    const seq = await commit(batch, context);
    if (!held && batch.some(write => write.type === 'document.create' && write.record.kind === 'flowmate.runtime.child')) {
      held = true; entered.resolve(); await release.promise;
    }
    return seq;
  };
  const server = Bun.serve({ port: 0, fetch: () => { requests++; return response('Agent'); } });
  const runtime = need(await createDurableRuntime({ storage, readApiKey: () => 'synthetic-key', verifyModelUse: () => ok(undefined),
    reserveModelRequest: () => ok(undefined), tools, readWorkingContext: input => ok(working(input)), verifyWorkingContext: () => ok(undefined),
    subagents: { readPlan: async () => plan ? ok(plan) : fail(appError('state_conflict', 'runtime', 'No original plan.')),
      verify: async () => ok(undefined), adopt: async () => { adopts++; return ok(undefined); },
      reserveModelRequest: async () => { childCalls++; return ok(undefined); }, onParentConsumed: async () => ok(undefined) },
    executeTool: async call => {
      plan ??= { ...query, childRunId: 501, childSessionId: 801, originToolCallId: 901, nativeToolTaskId: call.nativeTaskId,
        role: SUBAGENT_ROLE, binding: need(await runtime.prepareModel({ ...query, config: config(server.port!) })), thinkingLevel: 'off',
        prompt: 'Check only invoice eleven.', systemPrompt: SUBAGENT_SYSTEM_PROMPT, allowedTools: ['read_invoice_document'] };
      const observed = await call.nativeDelegate!(plan, call.signal);
      if (!observed.ok) { codes.push(observed.error.code); return observed; }
      return ok({ status: 'succeeded', data: {} });
    }, readToolResult: () => ok(null), onToolFeedback: () => ok(undefined) }));
  try {
    need(await runtime.openConversation({ workId: owner.workId, sessionId: owner.sessionId }));
    need(await runtime.submit({ ...query, config: config(server.port!), text: 'Create only this original checker.' }));
    await entered.promise;
    expect(need(await runtime.stopAttempt({ ...owner, stopGraceMs: 10 }))).toMatchObject({ stopped: false, reason: 'stop-unconfirmed' });
    expect(childCalls).toBe(0); expect(adopts).toBe(0); expect(requests).toBe(1);
    release.resolve(); expect(need(await runtime.stopAttempt({ ...owner, stopGraceMs: 1000 })).stopped).toBe(true);
    expect(need(await runtime.observeSubagent(plan!))).toMatchObject({ creation: 'created', nativeSubmissionId: null,
      status: null, execution: 'closed', creatorExecution: 'closed', consumedAt: null, parentModelReceivedAt: null });
    expect(childCalls).toBe(0); expect(requests).toBe(1); expect(codes).not.toContain('durable_delegation_suspended');
  } finally { release.resolve(); storage.commit = commit; need(await runtime.close()); await coordinator.close(); server.stop(true); }
}, 15000);

test.each(['child-http-inflight', 'child-completed'] as const)('SQLite runtime interruption resumes the original Agent and child: %s', async stage => {
  const coordinator = createDatabaseCoordinator(new Database(':memory:'));
  const entered = Promise.withResolvers<void>(), releaseHttp = Promise.withResolvers<void>();
  const requests: Array<{ child: boolean; key: string | null }> = [], codes: string[] = [];
  let plan: DurableSubagentPlan | undefined, parentCalls = 0, childCalls = 0, executions = 0, admitted = 0, key = 'before-runtime-reopen';
  let completedChild: Awaited<ReturnType<typeof runtime.observeSubagent>> | undefined;
  const server = Bun.serve({ port: 0, fetch: async request => {
    const body = await request.json() as { messages: Array<{ role: string; content?: unknown }> };
    const child = body.messages.some(message => typeof message.content === 'string' && message.content.includes('"delegation"'));
    requests.push({ child, key: request.headers.get('authorization') });
    if (child) {
      if (stage === 'child-http-inflight' && requests.filter(item => item.child).length === 1) { entered.resolve(); await releaseHttp.promise; }
      return response(null, 'Original completed child report.');
    }
    return body.messages.some(message => message.role === 'tool') ? response(null, 'Master resumed the original child.') : response('Agent');
  } });
  const options = { readApiKey: () => key, verifyModelUse: () => ok(undefined), reserveModelRequest: () => { parentCalls++; return ok(undefined); }, tools,
    readWorkingContext: (input: DurableWorkingContextQuery) => ok(working(input)), verifyWorkingContext: () => ok(undefined),
    subagents: { readPlan: async () => plan ? ok(plan) : fail(appError('state_conflict', 'runtime', 'No original plan.')),
      verify: async () => ok(undefined), adopt: async () => ok(undefined), reserveModelRequest: async () => { childCalls++; return ok(undefined); },
      onParentConsumed: async () => ok(undefined) },
    executeTool: async (call: DurableProductToolExecution): Promise<Result<ToolResult<unknown>>> => {
      executions++;
      if (!plan) {
        admitted++; plan = { ...query, childRunId: 501, childSessionId: 801, originToolCallId: 901, nativeToolTaskId: call.nativeTaskId,
          role: SUBAGENT_ROLE, binding: rootBinding, thinkingLevel: 'off', prompt: 'Check only invoice eleven.',
          systemPrompt: SUBAGENT_SYSTEM_PROMPT, allowedTools: ['read_invoice_document'] };
      }
      const observed = await call.nativeDelegate!(plan, call.signal);
      if (!observed.ok) { codes.push(observed.error.code); return observed; }
      if (stage === 'child-completed' && executions === 1) {
        completedChild = observed; entered.resolve();
        await new Promise<void>(resolve => { if (call.signal.aborted) resolve(); else call.signal.addEventListener('abort', () => resolve(), { once: true }); });
        const closed = await runtime.observeSubagent(plan);
        if (!closed.ok) { codes.push(closed.error.code); return closed; }
        throw Error('Closing a runtime must suspend the pending parent result.');
      }
      return ok({ status: 'succeeded', data: { content: [{ type: 'text', text: observed.data.answer }], details: {} } });
    }, readToolResult: () => ok(null), onToolFeedback: () => ok(undefined) };
  let runtime = need(await createDurableRuntime({ ...options, storage: await createDurableSqliteStorage(coordinator) }));
  const rootBinding = need(await runtime.prepareModel({ ...query, config: config(server.port!) }));
  try {
    need(await runtime.openConversation({ workId: owner.workId, sessionId: owner.sessionId }));
    const original = need(await runtime.submit({ ...query, binding: rootBinding, config: rootBinding.configuration, text: 'Resume this original delegation.' }));
    await entered.promise;
    const before = need(await runtime.observeSubagent(plan!));
    expect(before).toMatchObject({ creation: 'created', creatorExecution: 'active' });
    need(await runtime.close()); releaseHttp.resolve();
    expect(codes).toEqual(['durable_delegation_suspended']);
    expect(await runtime.observeSubagent(plan!)).toMatchObject({ ok: false, error: { code: 'durable_delegation_suspended' } });
    key = 'current-reopened-runtime-key';
    runtime = need(await createDurableRuntime({ ...options, storage: await createDurableSqliteStorage(coordinator) }));
    const cold = need(await runtime.observeSubagent(plan!));
    expect(cold?.nativeConversationId).toBe(before?.nativeConversationId); expect(cold?.nativeSubmissionId).toBe(before?.nativeSubmissionId);
    need(await runtime.restoreModel({ ...query, binding: rootBinding }));
    expect(need(await runtime.waitForSubmission(query))).toMatchObject({ nativeSubmissionId: original.nativeSubmissionId,
      status: 'done', answer: 'Master resumed the original child.' });
    const after = need(await runtime.observeSubagent(plan!));
    expect(after).toMatchObject({ nativeConversationId: before?.nativeConversationId, nativeSubmissionId: before?.nativeSubmissionId,
      creatorExecution: 'closed', status: 'done', execution: 'closed', answer: 'Original completed child report.' });
    if (completedChild?.ok) expect(after?.consumedAt).toBe(completedChild.data?.consumedAt);
    expect(admitted).toBe(1); expect(executions).toBe(2); expect(parentCalls).toBe(2); expect(childCalls).toBe(stage === 'child-http-inflight' ? 2 : 1);
    expect(requests.filter(item => item.child)).toHaveLength(stage === 'child-http-inflight' ? 2 : 1);
    expect(requests.at(-1)?.key).toBe('Bearer current-reopened-runtime-key');
  } finally { releaseHttp.resolve(); need(await runtime.close()); await coordinator.close(); server.stop(true); }
}, 15000);
