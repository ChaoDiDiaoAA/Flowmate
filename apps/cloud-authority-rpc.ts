import { z } from 'zod';
import { isDeepStrictEqual } from 'node:util';
import { appError, AppErrorSchema, CloudNativeResultReceiptSchema, CloudNativeResultSchema, CloudQueueInstructionSchema, CloudQueueVerifyInputsSchema, CloudRuntimeBindingSchema, CloudRuntimeNoticeSchema, DurableCompactionPlanSchema, DurableCompactionRequestSchema, DurableModelBindingSchema, InvoiceWorkWorkingContextSchema,
  INVOICE_REVIEW_TOOL_NAMES, PersonalAgentConfigurationSchema, RegisteredToolNameSchema, SKILL_RESOURCE_TOOL_NAMES, SUBAGENT_ROLE, ToolEffectSchema, fail, ok,
  type CloudNativeResult, type CloudNativeResultReceipt, type CloudQueueInstruction, type CloudQueueVerifyInputs, type CloudRuntimeBinding, type CloudRuntimeNotice, type DurableAttemptIdentity, type DurableConversationIdentity, type DurableProductToolCall, type DurableProductToolDefinition, type DurableWorkingContextQuery,
  type DurableCompactionCallbacks, type DurableCompactionPlan, type DurableProductToolExecution, type DurableProductToolFeedback,
  type DurableSubagentCallbacks, type DurableSubagentObservation, type DurableSubagentPlan,
  type InvoiceWorkWorkingContext, type Result, type ToolResult } from '@flowmate/contracts';
import { callCloudUnixRpc } from './cloud-unix-rpc.ts';
import { CLOUD_RUNTIME_RPC_METHODS, CloudSubagentObservationSchema } from './cloud-runtime-rpc.ts';
import type { CloudRuntimeGrant, CloudRuntimeOperation } from './cloud-runtime-router.ts';

const id = z.number().int().positive().max(Number.MAX_SAFE_INTEGER);
const identity = z.object({ workId: id, sessionId: id, attemptId: id }).strict();
const child = z.object({ childRunId: id, childSessionId: id, originToolCallId: id }).strict();
const query = identity.extend({ requestId: z.string().min(1).max(128), child: child.optional() }).strict();
const jsonValue = z.union([z.null(), z.boolean(), z.number().finite(), z.string(), z.array(z.unknown()), z.record(z.unknown())]);
const tool = query.extend({ nativeConversationId: id, nativeTaskId: id, nativeToolCallId: z.string().min(1).max(256),
  name: z.string().min(1).max(128), arguments: jsonValue }).strict();
const feedback = tool.extend({ nativeEntryId: id, feedbackJson: z.string().min(1).max(1_100_000) }).strict();
const childIdentity = identity.extend({ requestId: z.string().min(1).max(128), childRunId: id, childSessionId: id,
  originToolCallId: id, nativeToolTaskId: id }).strict();
const plan = childIdentity.extend({ role: z.literal(SUBAGENT_ROLE), binding: DurableModelBindingSchema,
  thinkingLevel: PersonalAgentConfigurationSchema.unwrap().innerType().shape.thinkingLevel,
  prompt: z.string().min(1).max(65000), systemPrompt: z.string().min(1).max(65000), allowedTools: z.array(z.string().min(1)).max(64) }).strict();
const childOutcome = z.discriminatedUnion('ok', [z.object({ ok: z.literal(true), data: CloudSubagentObservationSchema }).strict(),
  z.object({ ok: z.literal(false), error: AppErrorSchema }).strict()]);
const toolResult = z.discriminatedUnion('status', [z.object({ status: z.literal('succeeded'), data: z.unknown() }).strict(),
  z.object({ status: z.literal('failed'), error: AppErrorSchema, data: z.unknown().optional() }).strict(),
  z.object({ status: z.literal('cancelled'), error: AppErrorSchema, data: z.unknown().optional() }).strict()]);
const allowedTools = new Set<string>([...INVOICE_REVIEW_TOOL_NAMES, ...SKILL_RESOURCE_TOOL_NAMES, 'Agent']);
export const CloudRuntimeToolsSchema = z.array(z.object({ name: RegisteredToolNameSchema.refine(name => allowedTools.has(name)),
  description: z.string().min(1).max(65000), inputSchema: z.record(z.unknown()), executionMode: z.enum(['parallel', 'sequential']),
  effect: ToolEffectSchema.optional() }).strict()).max(128).refine(tools => new Set(tools.map(tool => tool.name)).size === tools.length);
const requestSchema = z.discriminatedUnion('method', [
  z.object({ version: z.literal(1), method: z.literal('authorize'), operation: z.enum(CLOUD_RUNTIME_RPC_METHODS), request: z.record(z.unknown()) }).strict(),
  z.object({ version: z.literal(1), method: z.literal('runtimeTools'), request: z.object({}).strict() }).strict(),
  z.object({ version: z.literal(1), method: z.literal('readWorkingContext'), request: query }).strict(),
  z.object({ version: z.literal(1), method: z.literal('verifyQueueInputs'), request: CloudQueueVerifyInputsSchema }).strict(),
  z.object({ version: z.literal(1), method: z.literal('verifyWorkingContext'), request: query }).strict(),
  z.object({ version: z.literal(1), method: z.literal('verifyModelUse'), request: identity }).strict(),
  z.object({ version: z.literal(1), method: z.literal('verifySchedulingUse'), request: z.object({ identity, pendingFeedback: z.array(tool).max(128) }).strict() }).strict(),
  z.object({ version: z.literal(1), method: z.literal('executeTool'), request: tool }).strict(),
  z.object({ version: z.literal(1), method: z.literal('readToolResult'), request: tool }).strict(),
  z.object({ version: z.literal(1), method: z.literal('onToolFeedback'), request: feedback }).strict(),
  z.object({ version: z.literal(1), method: z.literal('awaitDelegation'), request: tool }).strict(),
  z.object({ version: z.literal(1), method: z.literal('settleDelegation'), request: z.object({ call: tool, plan, outcome: childOutcome }).strict() }).strict(),
  z.object({ version: z.literal(1), method: z.literal('readChildPlan'), request: childIdentity }).strict(),
  z.object({ version: z.literal(1), method: z.literal('verifyChild'), request: childIdentity }).strict(),
  z.object({ version: z.literal(1), method: z.literal('adoptChild'), request: childIdentity.extend({ nativeConversationId: id }).strict() }).strict(),
  z.object({ version: z.literal(1), method: z.literal('childConsumed'), request: childIdentity.extend({ nativeToolResultEntryId: id,
    nativeModelTaskId: id, observedAt: z.string().datetime({ offset: true }) }).strict() }).strict(),
  z.object({ version: z.literal(1), method: z.literal('readCompactionPlan'), request: DurableCompactionRequestSchema }).strict(),
  z.object({ version: z.literal(1), method: z.literal('verifyCompaction'), request: DurableCompactionPlanSchema }).strict(),
  z.object({ version: z.literal(1), method: z.literal('runtimeChanged'), request: CloudRuntimeNoticeSchema }).strict(),
  z.object({ version: z.literal(1), method: z.literal('nativeResult'), request: CloudNativeResultSchema }).strict(),
]);
const grantSchema = z.discriminatedUnion('state', [
  z.object({ binding: CloudRuntimeBindingSchema, state: z.literal('allocated') }).strict(),
  z.object({ binding: CloudRuntimeBindingSchema, state: z.literal('ready'), nativeConversationId: id }).strict(),
]);
const responseSchema = z.discriminatedUnion('ok', [z.object({ ok: z.literal(true), data: z.unknown().optional() }).strict(),
  z.object({ ok: z.literal(false), error: AppErrorSchema }).strict()]);
const unavailable = () => fail(appError('cloud_authorization_unavailable', 'runtime', 'The cloud Authority could not confirm the original operation.', true));
const delegationKey = (call: DurableProductToolCall) => JSON.stringify([call.workId, call.sessionId, call.attemptId, call.requestId,
  call.nativeConversationId, call.nativeTaskId]);
export type CloudAuthorityCallbacks = {
  readWorkingContext(input: DurableWorkingContextQuery): Promise<Result<InvoiceWorkWorkingContext>>;
  verifyQueueInputs?(input: CloudQueueVerifyInputs): Promise<Result<CloudQueueInstruction[]>>;
  verifyWorkingContext(input: DurableWorkingContextQuery): Promise<Result<void>>;
  verifyModelUse(input: DurableAttemptIdentity): Promise<Result<void>>;
  verifySchedulingUse(input: DurableAttemptIdentity, pending: readonly DurableProductToolCall[]): Promise<Result<void>>;
  executeTool(input: DurableProductToolExecution): Promise<Result<ToolResult<unknown>>>;
  readToolResult(input: DurableProductToolCall): Promise<Result<ToolResult<unknown> | null>>;
  onToolFeedback(input: DurableProductToolFeedback): Promise<Result<void>>;
  subagents?: DurableSubagentCallbacks;
  compactions?: DurableCompactionCallbacks;
};

export function createCloudAuthorityRpcHandler(authorize: (operation: CloudRuntimeOperation, request: unknown) => Promise<Result<CloudRuntimeGrant>>,
  callbacks?: CloudAuthorityCallbacks, onRuntimeChanged?: (binding: CloudRuntimeNotice) => Promise<Result<void>>,
  onNativeResult?: (event: CloudNativeResult) => Promise<Result<CloudNativeResultReceipt>>, runtimeTools?: readonly DurableProductToolDefinition[]):
  (raw: unknown, signal?: AbortSignal) => Promise<unknown> {
  type Entry = { call: DurableProductToolCall; ready: { promise: Promise<Result<DurableSubagentPlan | null>>; resolve(value: Result<DurableSubagentPlan | null>): void };
    completed: { promise: Promise<Result<DurableSubagentObservation>>; resolve(value: Result<DurableSubagentObservation>): void }; running?: Promise<Result<ToolResult<unknown>>>;
    plan?: DurableSubagentPlan; outcome?: Result<DurableSubagentObservation> };
  const delegations = new Map<string, Entry>();
  const key = delegationKey;
  const entryFor = (call: DurableProductToolCall): Entry | null => {
    const original = delegations.get(key(call));
    if (original) return isDeepStrictEqual(original.call, call) ? original : null;
    if (delegations.size >= 64) return null;
    const entry: Entry = { call: structuredClone(call), ready: Promise.withResolvers(), completed: Promise.withResolvers() };
    delegations.set(key(call), entry); return entry;
  };
  async function wait<T>(promise: Promise<T>, signal?: AbortSignal): Promise<T> {
    if (!signal) return promise;
    if (signal.aborted) throw Error('cancelled');
    let abort: (() => void) | undefined;
    try { return await Promise.race([promise, new Promise<never>((_resolve, reject) => {
      abort = () => reject(Error('cancelled')); signal.addEventListener('abort', abort, { once: true });
    })]); } finally { if (abort) signal.removeEventListener('abort', abort); }
  }
  return async (raw, signal) => {
    const parsed = requestSchema.safeParse(raw);
    if (!parsed.success) return fail(appError('input_invalid', 'input', 'The cloud Authority request is invalid.'));
    try {
      if (parsed.data.method === 'authorize') return await authorize(parsed.data.operation, parsed.data.request);
      if (parsed.data.method === 'runtimeTools') {
        const tools = CloudRuntimeToolsSchema.safeParse(runtimeTools);
        return tools.success ? ok(tools.data) : unavailable();
      }
      if (parsed.data.method === 'runtimeChanged') {
        if (!onRuntimeChanged) return unavailable();
        const allowed = await authorize('queryHistory', parsed.data.request);
        const { runtimeGeneration: _generation, observationRevision: _revision, ...binding } = parsed.data.request;
        return allowed.ok && isDeepStrictEqual(allowed.data.binding, binding)
          ? await onRuntimeChanged(parsed.data.request) : unavailable();
      }
      if (parsed.data.method === 'nativeResult') return onNativeResult ? await onNativeResult(parsed.data.request) : unavailable();
      if (!callbacks) return unavailable();
      switch (parsed.data.method) {
        case 'readWorkingContext': return await callbacks.readWorkingContext(parsed.data.request);
        case 'verifyQueueInputs': return callbacks.verifyQueueInputs ? await callbacks.verifyQueueInputs(parsed.data.request) : unavailable();
        case 'verifyWorkingContext': return await callbacks.verifyWorkingContext(parsed.data.request);
        case 'verifyModelUse': return await callbacks.verifyModelUse(parsed.data.request);
        case 'verifySchedulingUse': return await callbacks.verifySchedulingUse(parsed.data.request.identity, parsed.data.request.pendingFeedback);
        case 'executeTool':
          if (parsed.data.request.name !== 'Agent') return await callbacks.executeTool({ ...parsed.data.request, signal: signal ?? new AbortController().signal });
          if (parsed.data.request.child) return unavailable();
          {
            const call = parsed.data.request, entry = entryFor(call); if (!entry) return unavailable();
            if (!entry.running) {
              entry.running = callbacks.executeTool({ ...call, signal: signal ?? new AbortController().signal,
                nativeDelegate: async (rawPlan, nativeSignal) => {
                  const checked = plan.safeParse(rawPlan);
                  if (!checked.success || checked.data.workId !== call.workId || checked.data.sessionId !== call.sessionId
                    || checked.data.attemptId !== call.attemptId || checked.data.requestId !== call.requestId
                    || checked.data.nativeToolTaskId !== call.nativeTaskId || entry.plan && !isDeepStrictEqual(entry.plan, checked.data))
                    return unavailable();
                  entry.plan = checked.data; entry.ready.resolve(ok(checked.data));
                  try { return await wait(entry.completed.promise, nativeSignal); } catch { return unavailable(); }
                } }).finally(() => {
                  entry.ready.resolve(ok(null));
                  if (delegations.get(key(call)) === entry) delegations.delete(key(call));
                });
            }
            return await entry.running;
          }
        case 'readToolResult': return await callbacks.readToolResult(parsed.data.request);
        case 'onToolFeedback': return await callbacks.onToolFeedback(parsed.data.request);
        case 'awaitDelegation': {
          const call = parsed.data.request;
          if (call.name !== 'Agent' || call.child) return unavailable();
          const entry = entryFor(call); if (!entry) return unavailable();
          try { return await wait(entry.ready.promise, signal); }
          finally { if (!entry.running && delegations.get(key(call)) === entry) delegations.delete(key(call)); }
        }
        case 'settleDelegation': {
          const { call, plan: original, outcome } = parsed.data.request, entry = delegations.get(key(call));
          if (!entry || !isDeepStrictEqual(entry.call, call) || !entry.plan || !isDeepStrictEqual(entry.plan, original)) return unavailable();
          if (outcome.ok && (outcome.data.workId !== original.workId || outcome.data.sessionId !== original.sessionId
            || outcome.data.attemptId !== original.attemptId || outcome.data.requestId !== original.requestId
            || outcome.data.childRunId !== original.childRunId || outcome.data.childSessionId !== original.childSessionId
            || outcome.data.originToolCallId !== original.originToolCallId || outcome.data.nativeToolTaskId !== original.nativeToolTaskId)) return unavailable();
          if (entry.outcome && !isDeepStrictEqual(entry.outcome, outcome)) return unavailable();
          entry.outcome = outcome; entry.completed.resolve(outcome); return ok(undefined);
        }
        case 'readChildPlan': return callbacks.subagents ? await callbacks.subagents.readPlan(parsed.data.request) : unavailable();
        case 'verifyChild': return callbacks.subagents ? await callbacks.subagents.verify(parsed.data.request) : unavailable();
        case 'adoptChild': return callbacks.subagents ? await callbacks.subagents.adopt(parsed.data.request) : unavailable();
        case 'childConsumed': return callbacks.subagents ? await callbacks.subagents.onParentConsumed(parsed.data.request) : unavailable();
        case 'readCompactionPlan': return callbacks.compactions ? await callbacks.compactions.readPlan(parsed.data.request) : unavailable();
        case 'verifyCompaction': return callbacks.compactions ? await callbacks.compactions.verify(parsed.data.request) : unavailable();
      }
    } catch { return unavailable(); }
  };
}

export function createCloudAuthorityRpcClient(socketPath: string):
  (operation: CloudRuntimeOperation, request: DurableConversationIdentity & Record<string, unknown>) => Promise<Result<CloudRuntimeGrant>> {
  return async (operation, request) => {
    let captured: typeof request;
    try { captured = structuredClone(request); } catch { return fail(appError('input_invalid', 'input', 'The cloud Authority request is invalid.')); }
    const sent = await callCloudUnixRpc(socketPath, { version: 1, method: 'authorize', operation, request: captured });
    if (!sent.ok) return unavailable();
    const parsed = responseSchema.safeParse(sent.data);
    if (!parsed.success) return unavailable();
    if (!parsed.data.ok) return fail(parsed.data.error);
    const grant = grantSchema.safeParse(parsed.data.data);
    if (!grant.success || grant.data.binding.workId !== captured.workId || grant.data.binding.sessionId !== captured.sessionId) return unavailable();
    return ok(grant.data);
  };
}

export function createCloudAuthorityCallbacksClient(socketPath: string): CloudAuthorityCallbacks & {
  verifyQueueInputs(input: CloudQueueVerifyInputs): Promise<Result<CloudQueueInstruction[]>>;
  subagents: DurableSubagentCallbacks; compactions: DurableCompactionCallbacks; notifyRuntimeChanged(binding: CloudRuntimeNotice, signal?: AbortSignal): Promise<Result<void>>;
  deliverNativeResult(event: CloudNativeResult, signal?: AbortSignal): Promise<Result<CloudNativeResultReceipt>>;
  runtimeTools(): Promise<Result<DurableProductToolDefinition[]>> } {
  const delegations = new Map<string, { call: DurableProductToolCall; pending: Promise<Result<ToolResult<unknown>>> }>();
  async function call<T>(method: Exclude<z.infer<typeof requestSchema>['method'], 'authorize'>, request: unknown,
    schema: z.ZodTypeAny, signal?: AbortSignal): Promise<Result<T>> {
    const sent = await callCloudUnixRpc(socketPath, { version: 1, method, request }, signal);
    if (!sent.ok) return unavailable();
    const result = responseSchema.safeParse(sent.data); if (!result.success) return unavailable();
    if (!result.data.ok) return fail(result.data.error);
    const parsed = schema.safeParse(result.data.data); return parsed.success ? ok(parsed.data as T) : unavailable();
  }
  return {
    runtimeTools: () => call('runtimeTools', {}, CloudRuntimeToolsSchema),
    async readWorkingContext(input) {
      const captured = query.safeParse(input); if (!captured.success) return fail(appError('input_invalid', 'input', 'The cloud context request is invalid.'));
      const result = await call<InvoiceWorkWorkingContext>('readWorkingContext', captured.data, InvoiceWorkWorkingContextSchema);
      if (!result.ok) return result;
      const value = result.data, expected = captured.data;
      if (value.work.workId !== expected.workId || value.work.sessionId !== expected.sessionId || value.phase.attemptId !== expected.attemptId
        || value.phase.requestId !== expected.requestId || value.item.workId !== expected.workId
        || (expected.child ? value.delegation?.childRunId !== expected.child.childRunId
          || value.delegation.childSessionId !== expected.child.childSessionId || value.delegation.originToolCallId !== expected.child.originToolCallId
          : value.delegation !== undefined)) return unavailable();
      return result;
    },
    async verifyQueueInputs(input) {
      const captured = CloudQueueVerifyInputsSchema.safeParse(input); if (!captured.success) return fail(appError('input_invalid', 'input', 'The cloud queue inputs are invalid.'));
      const result = await call<CloudQueueInstruction[]>('verifyQueueInputs', captured.data, z.array(CloudQueueInstructionSchema).max(100));
      if (!result.ok) return result;
      return result.data.length === captured.data.items.length && result.data.every((item, index) =>
        item.controlRequestId === captured.data.items[index]!.controlRequestId && item.submissionId === captured.data.items[index]!.submissionId
          && item.content === captured.data.items[index]!.content) ? result : unavailable();
    },
    verifyWorkingContext: input => call('verifyWorkingContext', input, z.undefined()),
    verifyModelUse: input => call('verifyModelUse', input, z.undefined()),
    verifySchedulingUse: (input, pending) => call('verifySchedulingUse', { identity: input, pendingFeedback: pending }, z.undefined()),
    executeTool: async input => {
      const { signal, nativeDelegate, ...raw } = input;
      const parsed = tool.safeParse(raw);
      if (!parsed.success) return fail(appError('input_invalid', 'input', 'The original cloud tool request is invalid.'));
      const original = structuredClone(parsed.data);
      if (input.name !== 'Agent') return call('executeTool', original, toolResult, signal);
      if (!nativeDelegate || input.child) return unavailable();
      const key = delegationKey(original), existing = delegations.get(key);
      if (existing) return isDeepStrictEqual(existing.call, original) ? structuredClone(await existing.pending)
        : fail(appError('state_conflict', 'runtime', 'The original cloud tool identity has different arguments.'));
      const pending = Promise.resolve().then(async () => {
        const controller = new AbortController(), abort = () => controller.abort();
        if (signal.aborted) return unavailable();
        signal.addEventListener('abort', abort, { once: true });
        try {
          const execution = call<ToolResult<unknown>>('executeTool', original, toolResult, controller.signal);
          const waiting = call<DurableSubagentPlan | null>('awaitDelegation', original, plan.nullable(), controller.signal);
          const first = await Promise.race([execution.then(result => ({ type: 'execution' as const, result })),
            waiting.then(result => ({ type: 'waiting' as const, result }))]);
          if (first.type === 'execution') return first.result;
          if (!first.result.ok) return first.result;
          const selected = first.result.data;
          if (selected === null) return await execution;
          if (selected.workId !== original.workId || selected.sessionId !== original.sessionId || selected.attemptId !== original.attemptId
            || selected.requestId !== original.requestId || selected.nativeToolTaskId !== original.nativeTaskId) return unavailable();
          let outcome: Result<DurableSubagentObservation>;
          try { outcome = await nativeDelegate(selected, signal); } catch { outcome = unavailable(); }
          const settled = await call<void>('settleDelegation', { call: original, plan: selected, outcome }, z.undefined(), controller.signal);
          return settled.ok ? await execution : settled;
        } finally { signal.removeEventListener('abort', abort); controller.abort(); }
      }).finally(() => { if (delegations.get(key)?.pending === pending) delegations.delete(key); });
      delegations.set(key, { call: original, pending });
      return structuredClone(await pending);
    },
    readToolResult: input => call('readToolResult', input, toolResult.nullable()),
    onToolFeedback: input => call('onToolFeedback', input, z.undefined()),
    notifyRuntimeChanged: (input, signal) => call('runtimeChanged', input, z.undefined(), signal),
    async deliverNativeResult(input, signal) {
      const captured = CloudNativeResultSchema.safeParse(input); if (!captured.success) return fail(appError('input_invalid', 'input', 'The native result is invalid.'));
      const result = await call<CloudNativeResultReceipt>('nativeResult', captured.data, CloudNativeResultReceiptSchema, signal);
      if (!result.ok) return result;
      const event = captured.data, receipt = result.data;
      return receipt.cloudRuntimeId === event.cloudRuntimeId && receipt.workId === event.workId && receipt.sessionId === event.sessionId
        && receipt.nativeConversationId === event.nativeConversationId && receipt.nativeSubmissionId === event.nativeSubmissionId ? result : unavailable();
    },
    subagents: {
      async readPlan(input) {
        const result = await call<DurableSubagentPlan>('readChildPlan', input, plan); if (!result.ok) return result;
        const expected = childIdentity.safeParse(input), actual = childIdentity.strip().safeParse(result.data);
        return expected.success && actual.success && isDeepStrictEqual(expected.data, actual.data) ? result : unavailable();
      },
      verify: input => call('verifyChild', input, z.undefined()),
      adopt: input => call('adoptChild', input, z.undefined()),
      reserveModelRequest: async () => fail(appError('cloud_model_transport_unavailable', 'runtime', 'Cloud model quota is reserved by the Authority proxy.')),
      onParentConsumed: input => call('childConsumed', input, z.undefined()),
    },
    compactions: {
      async readPlan(input) {
        const captured = DurableCompactionRequestSchema.safeParse(input);
        if (!captured.success) return fail(appError('input_invalid', 'input', 'The cloud summary request is invalid.'));
        const result = await call<DurableCompactionPlan>('readCompactionPlan', captured.data, DurableCompactionPlanSchema);
        if (!result.ok) return result;
        const { binding: _binding, thinkingLevel: _thinking, ...original } = result.data;
        return isDeepStrictEqual(original, captured.data) ? result : unavailable();
      },
      verify: input => call('verifyCompaction', input, z.undefined()),
      reserveModelRequest: async () => fail(appError('cloud_model_transport_unavailable', 'runtime', 'Cloud model quota is reserved by the Authority proxy.')),
    },
  };
}
