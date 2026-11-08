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

test('a saved desktop proposal ends its Durable phase before another model request', async () => {
  let requests = 0, executions = 0;
  const server = Bun.serve({ port: 0, fetch: () => {
    requests++;
    const delta = requests === 1 ? { role: 'assistant', tool_calls: [{ index: 0, id: 'proposal-call', type: 'function',
      function: { name: 'desktop_propose_action', arguments: JSON.stringify({ kind: 'click', observationId: '84c2bb96-6c56-48e0-aab0-f49f059cb1ba', elementIndex: 3 }) } }] }
      : { role: 'assistant', content: 'The model continued without the user.' };
    const chunk = { id: 'desktop-proposal', object: 'chat.completion.chunk', created: 1, model: 'tool-model',
      choices: [{ index: 0, delta, finish_reason: requests === 1 ? 'tool_calls' : 'stop' }] };
    return new Response(`data: ${JSON.stringify(chunk)}\n\ndata: [DONE]\n\n`, { headers: { 'content-type': 'text/event-stream' } });
  } });
  const tool = { name: 'desktop_propose_action', description: 'Request user confirmation.', executionMode: 'sequential' as const,
    effect: 'LOCAL_WRITE' as const, inputSchema: { type: 'object', properties: { kind: { type: 'string' },
      observationId: { type: 'string' }, elementIndex: { type: 'integer' } }, required: ['kind', 'observationId', 'elementIndex'] } };
  const runtime = need(await createDurableRuntime({ storage: new MemoryStorage(), readApiKey: () => 'synthetic-key',
    verifyModelUse: () => ok(undefined), reserveModelRequest: () => ok(undefined), readWorkingContext: query => ok(working(query, [tool.name])),
    verifyWorkingContext: () => ok(undefined), tools: [tool], executeTool: () => { executions++; return ok({ status: 'succeeded', data: { proposalId: 9 } }); },
    readToolResult: () => ok(null), onToolFeedback: () => ok(undefined) }));
  const query = { ...owner, requestId: 'desktop-proposal' };
  try {
    need(await runtime.openConversation({ workId: owner.workId, sessionId: owner.sessionId }));
    need(await runtime.submit({ ...query, text: 'Propose the observed action.', config: config(server.port!) }));
    expect(need(await runtime.waitForSubmission(query)).status).toBe('done');
    expect(requests).toBe(1); expect(executions).toBe(1);
  } finally { need(await runtime.close()); server.stop(true); }
}, 10_000);

test('a desktop proposal mixed with another tool call is not admitted', async () => {
  const executed: string[] = [];
  let requests = 0;
  const server = Bun.serve({ port: 0, fetch: () => {
    requests++;
    const chunk = { id: 'mixed-desktop', object: 'chat.completion.chunk', created: 1, model: 'tool-model',
      choices: [{ index: 0, delta: requests === 1 ? { role: 'assistant', tool_calls: [
        { index: 0, id: 'proposal-mixed', type: 'function', function: { name: 'desktop_propose_action',
          arguments: JSON.stringify({ kind: 'click', observationId: '84c2bb96-6c56-48e0-aab0-f49f059cb1ba', elementIndex: 3 }) } },
        { index: 1, id: 'read-mixed', type: 'function', function: { name: definition.name, arguments: JSON.stringify({ documentId: 11 }) } },
      ] } : { role: 'assistant', content: 'The mixed call was handled.' }, finish_reason: requests === 1 ? 'tool_calls' : 'stop' }] };
    return new Response(`data: ${JSON.stringify(chunk)}\n\ndata: [DONE]\n\n`, { headers: { 'content-type': 'text/event-stream' } });
  } });
  const tool = { name: 'desktop_propose_action', description: 'Request user confirmation.', executionMode: 'sequential' as const,
    effect: 'LOCAL_WRITE' as const, inputSchema: { type: 'object', properties: { kind: { type: 'string' },
      observationId: { type: 'string' }, elementIndex: { type: 'integer' } }, required: ['kind', 'observationId', 'elementIndex'] } };
  const runtime = need(await createDurableRuntime({ storage: new MemoryStorage(), readApiKey: () => 'synthetic-key',
    verifyModelUse: () => ok(undefined), reserveModelRequest: () => ok(undefined),
    readWorkingContext: query => ok(working(query, [tool.name, definition.name])), verifyWorkingContext: () => ok(undefined),
    tools: [tool, definition], executeTool: call => { executed.push(call.name); return ok({ status: 'succeeded', data: { proposalId: 9 } }); },
    readToolResult: () => ok(null), onToolFeedback: () => ok(undefined) }));
  const query = { ...owner, requestId: 'desktop-mixed' };
  try {
    need(await runtime.openConversation({ workId: owner.workId, sessionId: owner.sessionId }));
    need(await runtime.submit({ ...query, text: 'Propose the observed action.', config: config(server.port!) }));
    await runtime.waitForSubmission(query);
    expect(executed).not.toContain('desktop_propose_action');
  } finally { need(await runtime.close()); server.stop(true); }
}, 10_000);

test.each(['single', 'mixed'] as const)('a browser request ends its phase and cannot be mixed with other tools: %s', async mode => {
  const executed: string[] = []; let requests = 0;
  const server = Bun.serve({ port: 0, fetch: () => {
    requests++;
    const calls = [{ index: 0, id: 'browser-proposal', type: 'function',
      function: { name: 'browser_request_read', arguments: '{}' } }];
    if (mode === 'mixed') calls.push({ index: 1, id: 'other-read', type: 'function',
      function: { name: definition.name, arguments: JSON.stringify({ documentId: 11 }) } });
    const delta = requests === 1 ? { role: 'assistant', tool_calls: calls }
      : { role: 'assistant', content: 'The model continued without approval.' };
    const chunk = { id: 'browser-proposal', object: 'chat.completion.chunk', created: 1, model: 'tool-model',
      choices: [{ index: 0, delta, finish_reason: requests === 1 ? 'tool_calls' : 'stop' }] };
    return new Response(`data: ${JSON.stringify(chunk)}\n\ndata: [DONE]\n\n`, { headers: { 'content-type': 'text/event-stream' } });
  } });
  const tool = { name: 'browser_request_read', description: 'Request a page read.', executionMode: 'sequential' as const,
    effect: 'LOCAL_WRITE' as const, inputSchema: { type: 'object', properties: {}, additionalProperties: false } };
  const runtime = need(await createDurableRuntime({ storage: new MemoryStorage(), readApiKey: () => 'synthetic-key',
    verifyModelUse: () => ok(undefined), reserveModelRequest: () => ok(undefined),
    readWorkingContext: query => ok(working(query, [tool.name, definition.name])), verifyWorkingContext: () => ok(undefined),
    tools: [tool, definition], executeTool: call => { executed.push(call.name); return ok({ status: 'succeeded', data: { proposalId: 9 } }); },
    readToolResult: () => ok(null), onToolFeedback: () => ok(undefined) }));
  const query = { ...owner, requestId: 'browser-' + mode };
  try {
    need(await runtime.openConversation({ workId: owner.workId, sessionId: owner.sessionId }));
    need(await runtime.submit({ ...query, text: 'Request the selected page.', config: config(server.port!) }));
    await runtime.waitForSubmission(query);
    if (mode === 'single') { expect(executed).toEqual(['browser_request_read']); expect(requests).toBe(1); }
    else expect(executed).not.toContain('browser_request_read');
  } finally { need(await runtime.close()); server.stop(true); }
}, 10_000);

test('a rejected invoice approval resumes the same native tool without executing an external action', async () => {
  let requests = 0, executions = 0, decision = false;
  const began = Promise.withResolvers<void>();
  const server = Bun.serve({ port: 0, fetch: async request => {
    requests++; const body = await request.json() as { messages: Array<{ role: string }> };
    const call = !body.messages.some(message => message.role === 'tool');
    const delta = call ? { role: 'assistant', tool_calls: [{ index: 0, id: 'original-browser-request', type: 'function',
      function: { name: 'browser_request_read', arguments: '{}' } }] } : { role: 'assistant', content: 'Original rejection received.' };
    const chunk = { id: 'wait-rejection', object: 'chat.completion.chunk', created: 1, model: 'tool-model',
      choices: [{ index: 0, delta, finish_reason: call ? 'tool_calls' : 'stop' }] };
    return new Response(`data: ${JSON.stringify(chunk)}\n\ndata: [DONE]\n\n`, { headers: { 'content-type': 'text/event-stream' } });
  } });
  const tool = { name: 'browser_request_read', description: 'Request a page read.', executionMode: 'sequential' as const,
    effect: 'LOCAL_WRITE' as const, inputSchema: { type: 'object', properties: {}, additionalProperties: false } };
  const runtime = need(await createDurableRuntime({ storage: new MemoryStorage(), readApiKey: () => 'synthetic-key',
    verifyModelUse: () => ok(undefined), reserveModelRequest: () => ok(undefined), readWorkingContext: query => {
      const context = working(query, [tool.name]); return ok({ ...context, phase: { ...context.phase,
        basis: { ...context.phase.basis, executionMode: 'item-lane-approval-v1' } } });
    }, verifyWorkingContext: () => ok(undefined), tools: [tool], executeTool: () => { executions++; return ok({ status: 'succeeded', data: { proposalId: 9 } }); },
    readToolResult: () => ok({ status: 'succeeded', data: { proposalId: 9 } }), onToolFeedback: () => ok(undefined),
    approvalWait: { begin: async input => { expect(input).toMatchObject({ itemId: 71, proposalId: 9, kind: 'browser' }); began.resolve();
      return ok({ status: 'waiting', scheduling: 'waiting_approval', decisionRequestId: null }); },
    read: async () => ok(decision ? { status: 'rejected', scheduling: 'active', decisionRequestId: 'reject-original' }
      : { status: 'waiting', scheduling: 'waiting_approval', decisionRequestId: null }) } }));
  const query = { ...owner, itemId: 71, requestId: 'waiting-browser' };
  try {
    need(await runtime.openConversation({ workId: owner.workId, sessionId: owner.sessionId, itemId: query.itemId }));
    need(await runtime.submit({ ...query, text: 'Read this page only after confirmation.', config: config(server.port!) }));
    await Promise.race([began.promise, new Promise<never>((_resolve, reject) => setTimeout(() => reject(Error('Original approval did not begin.')), 2_000))]);
    expect(need(await runtime.getSubmission(query))).toMatchObject({ status: 'placed' });
    expect(requests).toBe(1); expect(executions).toBe(1);
    decision = true;
    expect(need(await runtime.waitForSubmission(query))).toMatchObject({ status: 'done', answer: 'Original rejection received.' });
    expect(requests).toBe(2); expect(executions).toBe(1);
  } finally { need(await runtime.close()); server.stop(true); }
}, 15_000);

test('memory is projected only to the original invoice phase request', async () => {
  const requests: string[] = [], lookedUp: number[] = [];
  const server = Bun.serve({ port: 0, fetch: async request => { requests.push(await request.text()); return response(false); } });
  const runtime = need(await createDurableRuntime({ storage: new MemoryStorage(), readApiKey: () => 'synthetic-key',
    verifyModelUse: () => ok(undefined), reserveModelRequest: () => ok(undefined),
    readWorkingContext: query => { const context = working(query, []); return ok({ ...context,
      item: { ...context.item, itemId: query.itemId! }, phase: { ...context.phase,
        basis: { ...context.phase.basis, executionMode: 'item-lane-approval-v1' } } }); },
    verifyWorkingContext: () => ok(undefined), readMemory: query => {
      lookedUp.push(query.itemId!);
      return ok({ status: 'ready' as const, items: [{ uri: `viking://user/alice/memories/${query.itemId}.md`,
        revision: 1, content: `Invoice memory ${query.itemId}`, truncated: false }] });
    } }));
  const first = { ...owner, itemId: 71, requestId: 'memory-first' }, second = { ...owner, itemId: 72, requestId: 'memory-second' };
  try {
    for (const query of [first, second]) {
      need(await runtime.openConversation({ workId: query.workId, sessionId: query.sessionId, itemId: query.itemId }));
      need(await runtime.submit({ ...query, text: 'Process the invoice.', config: config(server.port!) }));
      expect(need(await runtime.waitForSubmission(query)).status).toBe('done');
    }
    expect(lookedUp).toEqual([71, 72]);
    expect(requests[0]).toContain('Invoice memory 71'); expect(requests[0]).not.toContain('Invoice memory 72');
    expect(requests[1]).toContain('Invoice memory 72'); expect(requests[1]).not.toContain('Invoice memory 71');
  } finally { need(await runtime.close()); server.stop(true); }
}, 15_000);

test('a waiting original approval does not block another invoice in the same Work', async () => {
  let decision = false, executions = 0;
  const began = Promise.withResolvers<void>();
  const server = Bun.serve({ port: 0, fetch: async request => {
    const body = await request.json() as { messages: Array<{ role: string; content?: string }> };
    const context = JSON.parse(body.messages.find(message => message.role === 'user')!.content!) as { phase: { requestId: string } };
    const first = context.phase.requestId === 'first-wait', tool = first && !body.messages.some(message => message.role === 'tool');
    const delta = tool ? { role: 'assistant', tool_calls: [{ index: 0, id: 'original-wait', type: 'function',
      function: { name: 'browser_request_read', arguments: '{}' } }] } : { role: 'assistant', content: first ? 'First resumed.' : 'Second completed.' };
    const chunk = { id: 'parallel-item', object: 'chat.completion.chunk', created: 1, model: 'tool-model',
      choices: [{ index: 0, delta, finish_reason: tool ? 'tool_calls' : 'stop' }] };
    return new Response(`data: ${JSON.stringify(chunk)}\n\ndata: [DONE]\n\n`, { headers: { 'content-type': 'text/event-stream' } });
  } });
  const tool = { name: 'browser_request_read', description: 'Request a page read.', executionMode: 'sequential' as const,
    effect: 'LOCAL_WRITE' as const, inputSchema: { type: 'object', properties: {}, additionalProperties: false } };
  const runtime = need(await createDurableRuntime({ storage: new MemoryStorage(), readApiKey: () => 'synthetic-key',
    verifyModelUse: () => ok(undefined), reserveModelRequest: () => ok(undefined), readWorkingContext: query => {
      const context = working(query, [tool.name]); return ok({ ...context, item: { ...context.item, itemId: query.itemId! },
        phase: { ...context.phase, basis: { ...context.phase.basis, executionMode: 'item-lane-approval-v1' } } });
    }, verifyWorkingContext: () => ok(undefined), tools: [tool], executeTool: () => { executions++; return ok({ status: 'succeeded', data: { proposalId: 9 } }); },
    readToolResult: () => ok({ status: 'succeeded', data: { proposalId: 9 } }), onToolFeedback: () => ok(undefined),
    approvalWait: { begin: async () => { began.resolve(); return ok({ status: 'waiting', scheduling: 'waiting_approval', decisionRequestId: null }); },
      read: async () => ok(decision ? { status: 'rejected', scheduling: 'active', decisionRequestId: 'reject-original' }
        : { status: 'waiting', scheduling: 'waiting_approval', decisionRequestId: null }) } }));
  const first = { ...owner, itemId: 71, requestId: 'first-wait' }, second = { ...owner, itemId: 72, requestId: 'second-item' };
  try {
    need(await runtime.openConversation({ workId: first.workId, sessionId: first.sessionId, itemId: first.itemId }));
    need(await runtime.openConversation({ workId: second.workId, sessionId: second.sessionId, itemId: second.itemId }));
    need(await runtime.submit({ ...first, text: 'First invoice.', config: config(server.port!) }));
    await Promise.race([began.promise, new Promise<never>((_resolve, reject) => setTimeout(() => reject(Error('Original approval did not begin.')), 2_000))]);
    need(await runtime.submit({ ...second, text: 'Second invoice.', config: config(server.port!) }));
    const completed = await Promise.race([runtime.waitForSubmission(second),
      new Promise<never>((_resolve, reject) => setTimeout(() => reject(Error('Second invoice remained blocked.')), 2_000))]);
    expect(need(completed)).toMatchObject({ status: 'done', answer: 'Second completed.' });
    expect(need(await runtime.getSubmission(first))).toMatchObject({ status: 'placed' });
    decision = true;
    expect(need(await runtime.waitForSubmission(first))).toMatchObject({ status: 'done', answer: 'First resumed.' });
    expect(executions).toBe(1);
  } finally { need(await runtime.close()); server.stop(true); }
}, 15_000);

test('an approved invoice request invokes only its original nested browser tool and resumes the model', async () => {
  const calls: DurableProductToolCall[] = [], offered: string[][] = [];
  const server = Bun.serve({ port: 0, fetch: async request => {
    const body = await request.json() as { messages: Array<{ role: string }>; tools?: Array<{ function: { name: string } }> };
    offered.push((body.tools ?? []).map(tool => tool.function.name));
    const call = !body.messages.some(message => message.role === 'tool');
    const delta = call ? { role: 'assistant', tool_calls: [{ index: 0, id: 'original-browser-request', type: 'function',
      function: { name: 'browser_request_read', arguments: '{}' } }] } : { role: 'assistant', content: 'Original page received.' };
    const chunk = { id: 'wait-approved', object: 'chat.completion.chunk', created: 1, model: 'tool-model',
      choices: [{ index: 0, delta, finish_reason: call ? 'tool_calls' : 'stop' }] };
    return new Response(`data: ${JSON.stringify(chunk)}\n\ndata: [DONE]\n\n`, { headers: { 'content-type': 'text/event-stream' } });
  } });
  const requestTool = { name: 'browser_request_read', description: 'Request a page read.', executionMode: 'sequential' as const,
    effect: 'LOCAL_WRITE' as const, inputSchema: { type: 'object', properties: {}, additionalProperties: false } };
  const executeTool = { ...requestTool, name: 'browser_read_approved', description: 'Read the confirmed page.' };
  const runtime = need(await createDurableRuntime({ storage: new MemoryStorage(), readApiKey: () => 'synthetic-key',
    verifyModelUse: () => ok(undefined), reserveModelRequest: () => ok(undefined), readWorkingContext: query => {
      const context = working(query, [requestTool.name, executeTool.name]); return ok({ ...context, phase: { ...context.phase,
        basis: { ...context.phase.basis, executionMode: 'item-lane-approval-v1' } } });
    }, verifyWorkingContext: () => ok(undefined), tools: [requestTool, executeTool], executeTool: call => {
      calls.push(call); return ok(call.name === requestTool.name ? { status: 'succeeded', data: { proposalId: 9 } }
        : { status: 'succeeded', data: { text: 'untrusted original page' } });
    }, readToolResult: call => ok(call.name === requestTool.name ? { status: 'succeeded', data: { proposalId: 9 } } : null),
    onToolFeedback: () => ok(undefined), approvalWait: { begin: async () => ok({ status: 'approved', scheduling: 'active', decisionRequestId: 'approve-original' }),
      read: async () => ok({ status: 'approved', scheduling: 'active', decisionRequestId: 'approve-original' }) } }));
  const query = { ...owner, itemId: 71, requestId: 'approved-browser' };
  try {
    need(await runtime.openConversation({ workId: owner.workId, sessionId: owner.sessionId, itemId: query.itemId }));
    need(await runtime.submit({ ...query, text: 'Read this page only after confirmation.', config: config(server.port!) }));
    expect(need(await runtime.waitForSubmission(query))).toMatchObject({ status: 'done', answer: 'Original page received.' });
    expect(calls.map(call => call.name)).toEqual(['browser_request_read', 'browser_read_approved']);
    expect(calls[1]!.nativeTaskId).not.toBe(calls[0]!.nativeTaskId);
    expect(calls[1]!.nativeToolCallId).toBe('original-browser-request/approved-execution');
    expect(calls[1]).toMatchObject({ ...query, arguments: {} });
    expect(offered.every(names => names.includes('browser_request_read') && !names.includes('browser_read_approved'))).toBe(true);
  } finally { need(await runtime.close()); server.stop(true); }
}, 15_000);

test('an invoice tool call and its native feedback retain the original item identity', async () => {
  const calls: DurableProductToolCall[] = [], feedback: DurableProductToolFeedback[] = [];
  const server = Bun.serve({ port: 0, fetch: async request => {
    const body = await request.json() as { messages: Array<{ role: string }> };
    return response(!body.messages.some(message => message.role === 'tool'));
  } });
  const runtime = need(await createDurableRuntime({ storage: new MemoryStorage(), readApiKey: () => 'synthetic-tool-key',
    verifyModelUse: () => ok(undefined), reserveModelRequest: () => ok(undefined), readWorkingContext: query => ok(working(query)),
    verifyWorkingContext: () => ok(undefined), tools: [definition],
    executeTool: call => { calls.push(call); return ok({ status: 'succeeded', data: { invoiceText: 'original' } }); },
    readToolResult: () => ok(null), onToolFeedback: value => { feedback.push(value); return ok(undefined); } }));
  const query = { ...owner, itemId: 71, requestId: 'item-tool' };
  try {
    need(await runtime.openConversation({ workId: owner.workId, sessionId: owner.sessionId, itemId: query.itemId }));
    need(await runtime.submit({ ...query, text: 'Read this invoice.', config: config(server.port!) }));
    expect(need(await runtime.waitForSubmission(query))).toMatchObject({ status: 'done', answer: 'Original tool receipt consumed.' });
    expect(calls).toHaveLength(1); expect(feedback).toHaveLength(1);
    expect(calls[0]).toMatchObject({ itemId: query.itemId, requestId: query.requestId });
    expect(feedback[0]).toMatchObject({ itemId: query.itemId, nativeTaskId: calls[0]!.nativeTaskId });
  } finally { need(await runtime.close()); server.stop(true); }
}, 15_000);

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
