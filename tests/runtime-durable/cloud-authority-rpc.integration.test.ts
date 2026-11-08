import { expect, test } from 'bun:test';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { appError, fail, ok, type DurableProductToolExecution, type DurableSubagentObservation, type Result } from '@flowmate/contracts';
import { prepareDurableModelBinding } from '../../packages/runtime-durable/src/models.ts';
import { createCloudAuthorityCallbacksClient, createCloudAuthorityRpcHandler, type CloudAuthorityCallbacks } from '../../apps/cloud-authority-rpc.ts';
import { listenCloudUnixRpc } from '../../apps/cloud-unix-rpc.ts';
import { mkdtempSync } from '../support/resources.ts';

function need<T>(value: Result<T>): T { if (!value.ok) throw Error(value.error.code); return value.data; }

test('Authority RPC retains the invoice identity on phase context and product tool calls', async () => {
  const seen: unknown[] = [];
  const callbacks = { readWorkingContext: async (input: unknown) => { seen.push(input); return ok({}); },
    executeTool: async (input: DurableProductToolExecution) => { seen.push(input); return ok({ status: 'succeeded', data: {} }); } } as unknown as CloudAuthorityCallbacks;
  const handle = createCloudAuthorityRpcHandler(async () => fail(appError('cloud_runtime_forbidden', 'runtime', 'Unused.')), callbacks);
  const phase = { workId: 1, sessionId: 2, itemId: 9, attemptId: 3, requestId: 'phase' };
  const call = { ...phase, nativeConversationId: 4, nativeTaskId: 5, nativeToolCallId: 'original', name: 'read_invoice_document', arguments: {} };
  expect(await handle({ version: 1, method: 'readWorkingContext', request: phase })).toMatchObject({ ok: true });
  expect(await handle({ version: 1, method: 'executeTool', request: call })).toMatchObject({ ok: true });
  expect(seen).toHaveLength(2);
  expect(seen[0]).toMatchObject({ itemId: 9 }); expect(seen[1]).toMatchObject({ itemId: 9, nativeTaskId: 5 });
});

test('Authority RPC reads only the original approval wait identity', async () => {
  const seen: unknown[] = [];
  const callbacks = { approvalWait: { begin: async (input: unknown) => { seen.push(input); return ok({ status: 'waiting', scheduling: 'waiting_approval', decisionRequestId: null }); },
    read: async (input: unknown) => { seen.push(input); return ok({ status: 'approved', scheduling: 'ready', decisionRequestId: 'original' }); } } } as unknown as CloudAuthorityCallbacks;
  const handle = createCloudAuthorityRpcHandler(async () => fail(appError('cloud_runtime_forbidden', 'runtime', 'Unused.')), callbacks);
  const identity = { workId: 1, sessionId: 2, attemptId: 3, phaseId: 4, requestId: 'phase', itemId: 5,
    nativeConversationId: 6, nativeTaskId: 7, proposalId: 8, kind: 'browser' as const };
  expect(await handle({ version: 1, method: 'beginApprovalWait', request: identity })).toMatchObject({ ok: true, data: { status: 'waiting' } });
  expect(await handle({ version: 1, method: 'readApprovalWait', request: identity })).toMatchObject({ ok: true, data: { status: 'approved' } });
  expect(await handle({ version: 1, method: 'readApprovalWait', request: { ...identity, itemId: 0 } })).toMatchObject({ ok: false });
  expect(seen).toEqual([identity, identity]);
});

test('Authority memory RPC accepts only the original phase identity', async () => {
  const seen: unknown[] = [];
  const callbacks = { readMemory: async (input: unknown) => { seen.push(input); return ok({ status: 'ready',
    items: [{ uri: 'viking://user/alice/memories/fact.md', revision: 1, content: 'Authorized fact', truncated: false }] }); } } as unknown as CloudAuthorityCallbacks;
  const handle = createCloudAuthorityRpcHandler(async () => fail(appError('cloud_runtime_forbidden', 'runtime', 'Unused.')), callbacks);
  const phase = { workId: 1, sessionId: 2, itemId: 9, attemptId: 3, requestId: 'phase' };
  expect(await handle({ version: 1, method: 'readMemory', request: phase })).toMatchObject({ ok: true,
    data: { identity: phase, result: { status: 'ready', items: [{ content: 'Authorized fact' }] } } });
  expect(await handle({ version: 1, method: 'readMemory', request: { ...phase, ownerId: 'other-owner' } })).toMatchObject({ ok: false });
  expect(seen).toEqual([phase]);
});

test.skipIf(process.platform !== 'linux')('duplicate original delegation calls share one native child invocation', async () => {
  const root = mkdtempSync(join(tmpdir(), 'flowmate-delegation-rpc-')), socketPath = join(root, 'authority.sock');
  const config = { version: 1 as const, name: 'controlled', revision: 1, modelRef: { provider: 'controlled', model: 'fixture' },
    native: { authPath: 'unused.json', modelsPath: null }, connection: { api: 'openai-completions' as const,
      baseUrl: 'https://api.deepseek.com', contextWindow: 64000, maxTokens: 8192 }, parameters: { maxRetries: 0, maxRetryDelayMs: 1000 } };
  const binding = need(await prepareDurableModelBinding(config));
  const child = { workId: 1, sessionId: 2, attemptId: 3, requestId: 'phase', childRunId: 4, childSessionId: 5,
    originToolCallId: 6, nativeToolTaskId: 7 };
  const plan = { ...child, role: 'invoice-evidence-checker' as const, binding, thinkingLevel: 'off' as const,
    prompt: 'Check the original invoice.', systemPrompt: 'Read only.', allowedTools: ['read_invoice_document'] };
  const observation: DurableSubagentObservation = { ...child, creation: 'created', nativeConversationId: 8, nativeSubmissionId: 9,
    status: 'done', answer: 'Controlled result', reason: null, consumedAt: null, execution: 'closed', creatorExecution: 'closed',
    parentToolResultEntryId: null, parentModelTaskId: null, parentModelReceivedAt: null };
  let authorityCalls = 0, nativeCalls = 0;
  const callbacks = { async executeTool(input: DurableProductToolExecution) {
    authorityCalls++; const returned = await input.nativeDelegate!(plan, input.signal);
    return returned.ok ? ok({ status: 'succeeded' as const, data: returned.data }) : returned;
  } } as unknown as CloudAuthorityCallbacks;
  const server = need(await listenCloudUnixRpc({ socketPath, handle: createCloudAuthorityRpcHandler(async () =>
    fail(appError('cloud_runtime_forbidden', 'runtime', 'Unused.')), callbacks) }));
  const client = createCloudAuthorityCallbacksClient(socketPath), abort = new AbortController();
  const call: DurableProductToolExecution = { workId: 1, sessionId: 2, attemptId: 3, requestId: 'phase', nativeConversationId: 8,
    nativeTaskId: 7, nativeToolCallId: 'original-tool', name: 'Agent', arguments: { description: 'Original' }, signal: abort.signal,
    nativeDelegate: async () => { nativeCalls++; await new Promise(resolve => setTimeout(resolve, 100)); return ok(observation); } };
  try {
    const [first, second] = await Promise.all([client.executeTool(call), client.executeTool(call)]);
    expect(first).toMatchObject({ ok: true, data: { status: 'succeeded' } }); expect(second).toEqual(first);
    expect(authorityCalls).toBe(1); expect(nativeCalls).toBe(1);
  } finally { abort.abort(); need(await server.close()); }
});

test.skipIf(process.platform !== 'linux')('native result delivery accepts only a receipt for the original Session and Submission', async () => {
  const root = mkdtempSync(join(tmpdir(), 'flowmate-result-rpc-')), socketPath = join(root, 'authority.sock');
  const event = { version: 1 as const, workspaceId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
    cloudRuntimeId: '11111111-1111-4111-8111-111111111111', workId: 1, sessionId: 2, attemptId: 3, requestId: 'phase',
    nativeConversationId: 4, nativeSubmissionId: 5, nativeInputEntryId: null, nativeAnswerEntryId: null,
    consumedAt: null, status: 'unanswered' as const, answer: null, reason: 'cancelled before placement' };
  let wrong = false;
  const receipt = { receiptId: '22222222-2222-4222-8222-222222222222', cloudRuntimeId: event.cloudRuntimeId,
    workId: event.workId, sessionId: event.sessionId, nativeConversationId: event.nativeConversationId, nativeSubmissionId: event.nativeSubmissionId };
  const server = need(await listenCloudUnixRpc({ socketPath, handle: createCloudAuthorityRpcHandler(async () =>
    fail(appError('cloud_runtime_forbidden', 'runtime', 'Unused.')), undefined, undefined,
  async () => ok(wrong ? { ...receipt, nativeSubmissionId: 6 } : receipt)) }));
  const client = createCloudAuthorityCallbacksClient(socketPath);
  try {
    expect(await client.deliverNativeResult(event)).toEqual({ ok: true, data: receipt });
    wrong = true;
    expect(await client.deliverNativeResult(event)).toMatchObject({ ok: false });
  } finally { need(await server.close()); }
});

test.skipIf(process.platform !== 'linux')('queued context verification preserves the exact original content over Authority RPC', async () => {
  const root = mkdtempSync(join(tmpdir(), 'flowmate-queue-context-rpc-')), socketPath = join(root, 'authority.sock'); let wrong = false;
  const callbacks = { verifyQueueInputs: async (input: { items: Array<{ controlRequestId: string; submissionId: number; content: string }> }) =>
    ok(input.items.map(item => ({ provenance: 'user-provided', controlRequestId: item.controlRequestId,
      submissionId: item.submissionId, content: wrong ? 'Different content.' : item.content }))) } as unknown as CloudAuthorityCallbacks;
  const server = need(await listenCloudUnixRpc({ socketPath, handle: createCloudAuthorityRpcHandler(async () =>
    fail(appError('cloud_runtime_forbidden', 'runtime', 'Unused.')), callbacks) }));
  const client = createCloudAuthorityCallbacksClient(socketPath), input = { workId: 1, sessionId: 2, attemptId: 3, requestId: 'original-phase',
    items: [{ controlRequestId: 'original-followup', submissionId: 4, entryId: 5, content: 'Review the original total.' }] };
  try {
    expect(await client.verifyQueueInputs(input)).toEqual({ ok: true, data: [{ provenance: 'user-provided', controlRequestId: 'original-followup',
      submissionId: 4, content: 'Review the original total.' }] });
    wrong = true; expect(await client.verifyQueueInputs(input)).toMatchObject({ ok: false });
  } finally { need(await server.close()); }
});
