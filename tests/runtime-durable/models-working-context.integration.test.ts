import { expect, test } from 'bun:test';
import { Type, type Context, type Message, type TranscriptContext } from '@earendil-works/pi-ai';
import { appError, fail, ok, type ProviderConfig, type Result } from '@flowmate/contracts';
import type { InvoiceWorkWorkingContext } from '../../packages/contracts/src/personal-context.ts';
import { createDurableModels } from '../../packages/runtime-durable/src/models.ts';

const at = '2026-10-29T00:00:00.000Z';
const config: ProviderConfig = { version: 1, name: 'phase-model', revision: 3,
  modelRef: { provider: 'phase-controlled', model: 'selected-model' }, native: { authPath: 'unused-auth.json', modelsPath: null },
  connection: { api: 'openai-completions', baseUrl: 'http://127.0.0.1:1/v1', contextWindow: 96_000, maxTokens: 4_096 },
  parameters: { maxRetries: 0, maxRetryDelayMs: 1000 } };

function workingContext(): InvoiceWorkWorkingContext {
  return { version: 1, runtimeKind: 'durable', inputUse: 'phase-bound-only',
    work: { workId: 7, personalAgentId: 1, sessionId: 70, goal: 'Organize the selected invoices.', status: 'open',
      counts: { total: 2, unresolved: 2, accepted: 0, rejected: 0, excluded: 0 } },
    phase: { phaseId: 61, attemptId: 21, requestId: 'phase-original', basis: { contextSnapshotId: null,
      inputIds: [101, 102], documentRefs: [{ id: 11, version: 'v1' }], configurationRevision: 3, itemRevision: 2 } },
    item: { workId: 7, itemId: 71, revision: 2, documentRef: { id: 11, version: 'v1' }, jobId: 91,
      candidateRef: null, disposition: 'unresolved', decision: null, disposedAt: null, todoCount: 0,
      latestInputId: 102, updatedAt: at },
    userInputs: [
      { provenance: 'user-provided', inputId: 101, requestId: 'saved-first', todoId: 81,
        text: `FIRST-SAVED:${'a'.repeat(14_000)}:FIRST-SAVED-END`, documentRefs: [] },
      { provenance: 'user-provided', inputId: 102, requestId: 'saved-second', todoId: 82,
        text: `SECOND-SAVED:${'b'.repeat(14_000)}:SECOND-SAVED-END`, documentRefs: [] },
    ],
    historicalInputReferences: [], confirmedBusinessReferences: [], todos: [], conflicts: [], modelReports: [],
    actions: { authorizesExecution: false, tools: ['read_invoice_document'], available: [],
      remainingBudget: { modelCalls: 2, toolCalls: 4, toolFeedbackBytes: 4096, timeoutMs: 30000, childSlots: 1 } },
    waitingReason: null, evidenceRefs: [] };
}

type WireRequest = { model: string; messages: Array<{ role: string; content?: string; tool_call_id?: string; tool_calls?: unknown }>;
  tools?: Array<{ function: { name: string } }> };
function response(tool = false): Response {
  const delta = tool ? { role: 'assistant', tool_calls: [{ index: 0, id: 'phase-read-1', type: 'function',
    function: { name: 'read_invoice_document', arguments: '{"documentId":11}' } }] }
    : { role: 'assistant', content: 'Selected invoice checked.' };
  const chunk = { id: 'phase-response', object: 'chat.completion.chunk', created: 1, model: 'selected-model',
    choices: [{ index: 0, delta, finish_reason: tool ? 'tool_calls' : 'stop' }] };
  return new Response(`data: ${JSON.stringify(chunk)}\n\ndata: [DONE]\n\n`, { headers: { 'content-type': 'text/event-stream' } });
}
function need<T>(value: Result<T>): T { if (!value.ok) throw Error(value.error.code); return value.data; }
function nativeContext(): Context {
  return { messages: [
    { role: 'system', content: 'PRIVATE-PARENT-SYSTEM', sections: { previous: 'PRIVATE-OTHER-INVOICE-SECTION' }, timestamp: 1,
      toolsAdded: [
        { name: 'read_invoice_document', description: 'Read the selected invoice.', parameters: Type.Object({ documentId: Type.Integer() }) },
        { name: 'unapproved_tool', description: 'Not in the frozen tool set.', parameters: Type.Object({}) },
      ] },
    { role: 'user', content: 'PRIVATE-OTHER-INVOICE-USER-HISTORY', timestamp: 2 },
    { role: 'user', content: 'PRIVATE-UNCOMMITTED-DRAFT', timestamp: 3 },
  ] };
}

test.each([false, true])('Durable Models sends the full frozen working set and excludes parent history (simple=%s)', async simple => {
  const saved = workingContext(), context = nativeContext(), requests: WireRequest[] = [], credentials: Array<string | null> = [];
  let charged = 0;
  const prepared = need(await createDurableModels(config, { readApiKey: () => 'synthetic-product-key',
    verifyModelUse: () => ok(undefined), reserveModelRequest: () => { charged++; return ok(undefined); },
    readWorkingContext: () => ok({ workingContext: saved, messages: [] }),
    fetch: async (_input, init) => {
      if (typeof init?.body !== 'string') throw Error('Expected the official driver JSON body.');
      requests.push(JSON.parse(init.body)); credentials.push(new Headers(init.headers).get('authorization'));
      return response();
    } }));
  const model = prepared.models.getModel(prepared.modelRef.provider, prepared.modelRef.modelId);
  if (!model) throw Error('Missing model.');
  const result = await (simple ? prepared.models.completeSimple(model, context) : prepared.models.complete(model, context));
  expect(result.stopReason).toBe('stop');
  expect(requests).toHaveLength(1); expect(charged).toBe(1);
  const request = requests[0]!, text = request.messages.find(message => message.role === 'user')?.content;
  expect(text).toBeString(); if (!text) throw Error('Missing working context.');
  expect(new TextEncoder().encode(text).byteLength).toBeGreaterThan(22_000);
  const sent = JSON.parse(text);
  expect(sent.phase).toMatchObject({ phaseId: 61, attemptId: 21, requestId: 'phase-original' });
  expect(sent.item).toMatchObject({ itemId: 71, documentRef: { id: 11, version: 'v1' } });
  expect(sent.userInputs.map((input: { text: string }) => input.text)).toEqual(saved.userInputs.map(input => input.text));
  expect(request.model).toBe('selected-model'); expect(credentials).toEqual(['Bearer synthetic-product-key']);
  expect(request.tools?.map(tool => tool.function.name)).toEqual(['read_invoice_document']);
  expect(JSON.stringify(request)).not.toContain('PRIVATE-');
});

test('Durable Models keeps the current phase tool call and result across real official driver requests', async () => {
  const saved = workingContext(), context = nativeContext(), requests: WireRequest[] = [];
  const phaseInput: Message = { role: 'user', content: 'phase-envelope', timestamp: 4 };
  context.messages.push(phaseInput);
  let reads = 0, charged = 0;
  const prepared = need(await createDurableModels(config, { readApiKey: () => 'synthetic-product-key',
    verifyModelUse: () => ok(undefined), reserveModelRequest: () => { charged++; return ok(undefined); },
    readWorkingContext: (native: TranscriptContext) => {
      reads++;
      const start = native.messages.indexOf(phaseInput);
      return start < 0 ? fail(appError('context_binding_conflict', 'runtime', 'The original phase input is missing.'))
        : ok({ workingContext: saved, messages: native.messages.slice(start + 1) });
    },
    fetch: async (_input, init) => {
      if (typeof init?.body !== 'string') throw Error('Expected the official driver JSON body.');
      requests.push(JSON.parse(init.body)); return response(requests.length === 1);
    } }));
  const model = prepared.models.getModel(prepared.modelRef.provider, prepared.modelRef.modelId);
  if (!model) throw Error('Missing model.');
  const first = await prepared.models.completeSimple(model, context);
  expect(first.stopReason).toBe('toolUse');
  const call = first.content.find(block => block.type === 'toolCall');
  expect(call).toMatchObject({ id: 'phase-read-1', name: 'read_invoice_document', arguments: { documentId: 11 } });
  if (!call || call.type !== 'toolCall') throw Error('Missing tool call.');
  context.messages.push(first, { role: 'toolResult', toolCallId: call.id, toolName: call.name,
    content: [{ type: 'text', text: 'CURRENT-PHASE-DOCUMENT-ELEVEN' }], isError: false, timestamp: 5 });
  const second = await prepared.models.completeSimple(model, context);
  expect(second.stopReason).toBe('stop'); expect(reads).toBe(2); expect(charged).toBe(2); expect(requests).toHaveLength(2);
  expect(requests[1]!.messages).toContainEqual(expect.objectContaining({ role: 'assistant',
    tool_calls: [expect.objectContaining({ id: 'phase-read-1', function: { name: 'read_invoice_document', arguments: '{"documentId":11}' } })] }));
  expect(requests[1]!.messages).toContainEqual({ role: 'tool', tool_call_id: 'phase-read-1', content: 'CURRENT-PHASE-DOCUMENT-ELEVEN' });
  expect(JSON.stringify(requests)).not.toContain('PRIVATE-'); expect(JSON.stringify(requests)).not.toContain('phase-envelope');
});

test.each(['read-failure', 'malformed-working-set', 'user-history', 'system-history', 'thrown-read'] as const)(
  'Durable Models refuses %s before charging or dispatching', async reason => {
    let requests = 0, charged = 0;
    const saved = workingContext();
    const prepared = need(await createDurableModels(config, { readApiKey: () => 'synthetic-product-key',
      verifyModelUse: () => ok(undefined), reserveModelRequest: () => { charged++; return ok(undefined); },
      readWorkingContext: () => {
        if (reason === 'thrown-read') throw Error('context_binding_conflict');
        if (reason === 'read-failure') return fail(appError('context_binding_conflict', 'runtime', 'Wrong phase owner.'));
        const messages: Message[] = reason === 'user-history' ? [{ role: 'user', content: 'PRIVATE-USER', timestamp: 1 }]
          : reason === 'system-history' ? [{ role: 'system', content: 'PRIVATE-SYSTEM', timestamp: 1 }] : [];
        return ok({ workingContext: reason === 'malformed-working-set'
          ? { ...saved, userInputs: [{ ...saved.userInputs[0]!, text: 'a'.repeat(22_001) }] } : saved, messages });
      }, fetch: async () => { requests++; return response(); } }));
    const model = prepared.models.getModel(prepared.modelRef.provider, prepared.modelRef.modelId);
    if (!model) throw Error('Missing model.');
    const result = await prepared.models.completeSimple(model, nativeContext());
    expect(result.stopReason).toBe('error'); expect(requests).toBe(0); expect(charged).toBe(0);
  });
