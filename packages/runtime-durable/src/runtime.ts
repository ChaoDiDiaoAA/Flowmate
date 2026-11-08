import { BACKGROUND_CONTEXT, withAbortSignal } from '@earendil-works/chord/context';
import { createModels, getSupportedThinkingLevels, InMemoryCredentialStore, InMemoryModelsStore, type TranscriptContext } from '@earendil-works/pi-ai';
import { AgentDoc, AssistantEntry, configure, createRegistry, defineDoc, defineDocFamily, GenerationTask, Harness, hook, InboxDoc, LiveDoc, StorageRequestError, ToolTask,
  type ContextView, type ConversationId, type Cursor, type EntryId, type EntryRecord, type Registry, type Storage, type SubmissionId, type SubmissionRecord, type TaskGraphWatch, type TaskId, type ToolExecutionApi, type ToolRegistration, type Tx, type Wake } from '@earendil-works/pi-durable';
import { appError, CloudNativeOversizedResultSchema, CloudNativeResultSchema, CloudQueueInstructionSchema, CloudQueueVerifyInputsSchema, CloudRuntimeBindingSchema, DURABLE_REVIEWER_INSTRUCTIONS, fail, InvoiceWorkContinueRequestSchema, isRetryableCloudModelStatus, MemoryRecallResultSchema, ok, PersonalAgentConfigurationSchema, ProviderConfigSchema, RUNTIME_CONFIG,
  type AppError, type DurableAttemptIdentity, type DurableConversationIdentity, type DurableRuntimePort, type DurableSubmissionInput,
  type CloudModelAttemptRequest, type CloudNativeOversizedResult, type CloudNativeResult, type CloudQueueInstruction, type CloudQueueVerifyInputs, type CloudRuntimeBinding, type DurableSubmissionQuery, type DurableSubmissionView, type ProviderConfig, type Result, type ToolResult } from '@flowmate/contracts';
import { isDeepStrictEqual } from 'node:util';
import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { createDurableModels, durableModelBindingSchema, prepareDurableModelBinding, readDurableModelBinding } from './models.ts';
import type { DurableModelBinding, DurableModelPreparation, DurableProductToolCall, DurableProductToolDefinition, DurableProductToolFeedback } from '../../contracts/src/durable-runtime.ts';
import { InvoiceWorkWorkingContextSchema, type InvoiceWorkWorkingContext } from '../../contracts/src/personal-context.ts';
import type { DurableApprovalWaitCallbacks } from '../../contracts/src/durable-approval.ts';
import { createDurableProductTools, projectDurableToolFeedback, readDurableToolCall, rememberDurableToolCall } from './tools.ts';
import { createDurableSubagentRuntime, type ParentChildConsumption } from './subagents.ts';
import type { DurableProductToolExecution, DurableSubagentCallbacks, DurableWorkingContextQuery } from '../../contracts/src/durable-subagents.ts';
import { createDurableHistoryReader } from './history.ts';
import { createDurableQueueController, queueSubmissionKey } from './queue.ts';
import type { CloudQueuePort } from '../../contracts/src/cloud-queue.ts';
import { observePromptTrace, type PromptTraceBuffer, type PromptTraceCall } from '@flowmate/contracts';
import { createDurableCompactionRuntime } from './compaction.ts';
import { formatInvoiceWorkContext, formatInvoiceWorkInstructions } from './context.ts';
import { DurableCompactionIdentitySchema, DurableCompactionRequestSchema, type DurableCompactionCallbacks } from '../../contracts/src/durable-compaction.ts';

export type DurableRuntimeOptions = {
  storage: Storage;
  registry?: Registry;
  readApiKey(identity: DurableAttemptIdentity, config: ProviderConfig): string | undefined | Promise<string | undefined>;
  verifyModelUse(identity: DurableAttemptIdentity): Result<void> | Promise<Result<void>>;
  verifySchedulingUse?(identity: DurableAttemptIdentity, pendingFeedback: readonly DurableProductToolCall[]): Result<void> | Promise<Result<void>>;
  reserveModelRequest(identity: DurableAttemptIdentity): Result<void> | Promise<Result<void>>;
  readWorkingContext?(identity: DurableWorkingContextQuery): Result<InvoiceWorkWorkingContext> | Promise<Result<InvoiceWorkWorkingContext>>;
  modelDiagnostics?: { buffer: PromptTraceBuffer; readRunId(query: DurableSubmissionQuery): Promise<number | null>;
    capture?(call: PromptTraceCall): void;
    source?(input: DurableSubmissionQuery & { nativeTaskId: number; generationTaskId: number; assistantEntryId: number; phaseId: number; observationId?: string }): void };
  readMemory?(identity: DurableWorkingContextQuery): Result<import('@flowmate/contracts').MemoryRecallResult> | Promise<Result<import('@flowmate/contracts').MemoryRecallResult>>;
  verifyQueueInputs?(input: CloudQueueVerifyInputs): Result<CloudQueueInstruction[]> | Promise<Result<CloudQueueInstruction[]>>;
  verifyWorkingContext?(identity: DurableWorkingContextQuery): Result<void> | Promise<Result<void>>;
  tools?: readonly DurableProductToolDefinition[];
  executeTool?(call: DurableProductToolExecution): Result<ToolResult<unknown>> | Promise<Result<ToolResult<unknown>>>;
  readToolResult?(call: DurableProductToolCall): Result<ToolResult<unknown> | null> | Promise<Result<ToolResult<unknown> | null>>;
  onToolFeedback?(feedback: DurableProductToolFeedback): Result<void> | Promise<Result<void>>;
  approvalWait?: DurableApprovalWaitCallbacks;
  onChanged?: () => void;
  onWake?(wake: Wake): void;
  subagents?: DurableSubagentCallbacks;
  compactions?: DurableCompactionCallbacks;
  cloudModel?: { binding: CloudRuntimeBinding; send(input: CloudModelAttemptRequest, signal?: AbortSignal): Promise<Result<Response>> };
  onNativeResult?(result: CloudNativeResult): Promise<Result<void>>;
  onNativeResultOversized?(result: CloudNativeOversizedResult): Promise<Result<void>>;
  onNativeResultError?(error: AppError): void;
};

const id = InvoiceWorkContinueRequestSchema.shape.workId;
const identitySchema = z.object({ workId: id, sessionId: id, itemId: id.optional(), participant: z.literal('reviewer').optional() }).strict();
const attemptSchema = identitySchema.extend({ attemptId: id });
const stopSchema = attemptSchema.extend({ stopGraceMs: z.number().int().min(1).max(10000) });
const historySchema = identitySchema.extend({ limit: z.number().int().min(1).max(100).default(50), beforeEntryId: id.optional() });
const querySchema = identitySchema.extend({ attemptId: id, requestId: InvoiceWorkContinueRequestSchema.shape.requestId });
const preparationSchema = querySchema.extend({ config: ProviderConfigSchema });
const restoreSchema = querySchema.extend({ binding: durableModelBindingSchema });
const thinkingLevelSchema = PersonalAgentConfigurationSchema.unwrap().innerType().shape.thinkingLevel;
const inputSchema = preparationSchema.extend({ text: z.string().min(1).max(22000).refine(text => text.trim().length > 0),
  binding: durableModelBindingSchema.optional(), thinkingLevel: thinkingLevelSchema.default('off') });
const entryIdentity = querySchema.extend({ configName: z.string(), configRevision: z.number().int().positive(),
  thinkingLevel: thinkingLevelSchema.default('off'), inputText: z.string().optional() });
const queuedEntryIdentity = querySchema.extend({ controlRequestId: z.string().min(1).max(128), submissionId: id,
  inputText: z.string().min(1).max(22000) }).strict();
const legacyBinding = z.object({ workId: id.nullable(), sessionId: id.nullable(), attemptId: id.nullable(), requestKey: z.string().nullable() }).strict();
const itemBinding = legacyBinding.extend({ itemId: id.nullable() });
type Lane = { itemId?: number | null; participant?: 'reviewer' | null };
const laneIdentity = ({ itemId, participant }: Lane) => ({
  ...(itemId === null || itemId === undefined ? {} : { itemId }), ...(participant ? { participant } : {}),
});
const sameLane = (first: Lane, second: Lane) => (first.itemId ?? null) === (second.itemId ?? null)
  && (first.participant ?? null) === (second.participant ?? null);
const Binding = defineDoc({ kind: 'flowmate.runtime.binding', version: 3, scope: 'conversation', history: 'latest', fork: 'initial',
  initial: (): z.infer<typeof itemBinding> & { participant: 'reviewer' | null } =>
    ({ workId: null, sessionId: null, itemId: null, attemptId: null, requestKey: null, participant: null }),
  migrate: (value, fromVersion) => {
    if (fromVersion === 1) return { ...legacyBinding.parse(value), itemId: null, participant: null };
    if (fromVersion === 2) return { ...itemBinding.parse(value), participant: null };
    throw Error('storage_corrupt');
  }, checkpointWhen: () => true });
type ConsumptionReceipt = DurableSubmissionQuery & { nativeSubmissionId: number; nativeEntryId: number;
  nativeTaskId: number; cutoff: number; phaseId: number; consumedAt: string };
const GenerationPhase = defineDoc({ kind: 'flowmate.runtime.generation-phase', version: 1, scope: 'task',
  initial: (): { receipt: ConsumptionReceipt | null; observationId?: string; calls: Array<{ nativeTaskId: number; argumentsJson: string }> } =>
    ({ receipt: null, calls: [] }), checkpointWhen: () => true });
const Consumption = defineDocFamily({ kind: 'flowmate.runtime.consumption', version: 1, family: true,
  scope: 'conversation', history: 'latest', fork: 'initial', initial: (receipt: ConsumptionReceipt): ConsumptionReceipt => receipt,
  checkpointWhen: () => true });
const requestCheckpoint = z.object({ phase: z.literal('request'), cutoff: id,
  model: z.object({ provider: z.string(), modelId: z.string() }), thinkingLevel: thinkingLevelSchema.default('off') });
class ProductFailure extends Error { constructor(readonly detail: AppError) { super(detail.code); } }
const attemptIdentity = ({ workId, sessionId, attemptId }: DurableAttemptIdentity): DurableAttemptIdentity => ({ workId, sessionId, attemptId });
const phaseIdentity = (query: DurableSubmissionQuery): DurableSubmissionQuery =>
  ({ ...attemptIdentity(query), ...laneIdentity(query), requestId: query.requestId });

async function hasLiveOwnedTasks(tx: Tx, root: ConversationId): Promise<boolean> {
  const conversations = [root];
  for (const conversationId of conversations) {
    for (const status of ['pending', 'running', 'waiting', 'sleeping', 'completing'] as const)
      if ((await tx.scanTasks({ conversationId, status }, 1)).items.length > 0) return true;
    let cursor: Cursor | undefined;
    do {
      const page = await tx.scanConversations({ ownerConversationId: conversationId }, 100, cursor);
      conversations.push(...page.items.map(record => record.id));
      cursor = page.next;
    } while (cursor);
  }
  return false;
}

export async function createDurableRuntime(options: DurableRuntimeOptions): Promise<Result<DurableRuntimePort & { queue: CloudQueuePort }>> {
  const cloud = options.cloudModel && CloudRuntimeBindingSchema.safeParse(options.cloudModel.binding);
  if (options.cloudModel && (!cloud || !cloud.success))
    return fail(appError('input_invalid', 'input', 'A cloud runtime needs a valid owner.'));
  if (Boolean(options.readWorkingContext) !== Boolean(options.verifyWorkingContext))
    return fail(appError('input_invalid', 'input', 'A phase runtime needs both working context reading and live basis verification.'));
  if (Boolean(options.executeTool) !== Boolean(options.readToolResult)
    || options.tools?.length && (!options.executeTool || !options.readWorkingContext || !options.verifyWorkingContext))
    return fail(appError('input_invalid', 'input', 'Product tools need phase verification, execution and original result lookup.'));
  const context = BACKGROUND_CONTEXT;
  const registry = options.registry ?? createRegistry();
  const models = createModels({ credentials: new InMemoryCredentialStore(), modelsStore: new InMemoryModelsStore(),
    authContext: { env: async () => undefined, fileExists: async () => false } });
  let harness: Harness;
  try { harness = await Harness.open(options.storage, { models, registry, ...(options.onWake ? { onWake: options.onWake } : {}),
    settings: { stream: { maxRetries: 0, transport: 'sse', deferred: false }, retry: { enabled: false }, afterFailedRun: 'keep',
      compaction: { enabled: Boolean(options.compactions) && RUNTIME_CONFIG.compaction.autoEnabled, backgroundTokens: 0,
        reserveTokens: RUNTIME_CONFIG.compaction.reserveTokens, keepRecentTokens: RUNTIME_CONFIG.compaction.keepRecentTokens } } }, context); }
  catch { return fail(appError('durable_runtime_unavailable', 'runtime', 'Durable runtime could not be opened.', true)); }
  let closed = false;
  let changes: TaskGraphWatch | undefined;
  let requestResultScan: (() => void) | undefined, resultScan: Promise<void> | undefined, scanPending = false;
  let closeInFlight: Promise<Result<void>> | null = null;
  const close = (): Promise<Result<void>> => {
    if (closeInFlight) return closeInFlight;
    closed = true;
    closeInFlight = (async () => {
      try { await changes?.stop(); if (resultScan) await resultScan; await harness.close(context); return ok(undefined); }
      catch { return fail(appError('durable_close_failed', 'runtime', 'Durable runtime close could not be confirmed.', true)); }
    })();
    return closeInFlight;
  };
  if (options.onChanged || options.onNativeResult) {
    try {
      changes = await harness.watchTaskGraph(context);
      changes.start(async () => { if (!closed) { options.onChanged?.(); requestResultScan?.(); } });
    } catch { await close(); return fail(appError('durable_runtime_unavailable', 'runtime', 'Native task changes could not be observed.', true)); }
  }
  const read = async <T>(action: () => Promise<T>): Promise<T> => {
    try { return await action(); }
    catch (error) { if (!(error instanceof StorageRequestError)) void close(); throw error; }
  };
  const attempts = new Map<number, { identity: DurableAttemptIdentity; config: ProviderConfig; binding: DurableModelBinding }>();
  const phases = new Map<string, { provider: string; modelId: string }>();
  let diagnosticCallSequence = 0;
  const observedOutputs = new WeakMap<object, string>();
  const requested = new Map<TaskId, { query: DurableSubmissionQuery; conversationId: ConversationId;
    nativeSubmissionId: number; nativeEntryId: number; cutoff: number; phaseId: number; children: ParentChildConsumption[] }>();
  const cloudAttempts = new Map<TaskId, { modelAttemptIds: string[]; cutoff: number }>();
  let children: ReturnType<typeof createDurableSubagentRuntime>;
  let compactions: ReturnType<typeof createDurableCompactionRuntime>;
  const sendCloud = async (input: Omit<CloudModelAttemptRequest, 'modelAttemptId' | 'transportOrdinal'>,
    ids: readonly string[], signal?: AbortSignal): Promise<Result<Response>> => {
    for (let ordinal = 0; ordinal < ids.length; ordinal++) {
      if (signal?.aborted) return fail(appError('run_cancelled', 'runtime', 'The original cloud model request was cancelled.'));
      const sent = await options.cloudModel!.send({ ...input, modelAttemptId: ids[ordinal]!, transportOrdinal: ordinal }, signal);
      if (!sent.ok || !isRetryableCloudModelStatus(sent.data.status) || ordinal === ids.length - 1) return sent;
      if (sent.data.body) {
        const reader = sent.data.body.getReader(); let received = 0;
        try {
          for (;;) { const part = await reader.read(); if (part.done) break; received += part.value.byteLength;
            if (received > 65_536) { await reader.cancel(); return fail(appError('cloud_model_result_unknown', 'runtime', 'The original model failure could not be confirmed.', true)); } }
        } catch { return fail(appError('cloud_model_result_unknown', 'runtime', 'The original model failure could not be confirmed.', true)); }
        finally { reader.releaseLock(); }
      }
      try { await new Promise<void>((resolve, reject) => {
        const timer = setTimeout(() => { signal?.removeEventListener('abort', abort); resolve(); }, 1000 * 2 ** ordinal);
        const abort = () => { clearTimeout(timer); reject(Error('cancelled')); };
        if (signal?.aborted) abort(); else signal?.addEventListener('abort', abort, { once: true });
      }); } catch { return fail(appError('run_cancelled', 'runtime', 'The original cloud model request was cancelled.')); }
    }
    return fail(appError('cloud_model_result_unknown', 'runtime', 'The original model request has no available attempt.', true));
  };
  const sendCloudSummary = async (body: string, originalSignal?: AbortSignal, signal?: AbortSignal): Promise<Response | null> => {
    if (!cloud?.success) return null;
    const observed = await compactions.cloudAttempt(originalSignal);
    if (!observed.ok) throw new ProductFailure(observed.error);
    const summary = observed.data; if (!summary) return null;
    const plan = summary.plan, query = phaseIdentity(plan);
    const parent = await lookup(query);
    if (!parent || !options.readWorkingContext) throw Error('state_conflict');
    const child = plan.child;
    const working = await options.readWorkingContext({ ...query, ...(child ? { child: { childRunId: child.childRunId,
      childSessionId: child.childSessionId, originToolCallId: child.originToolCallId } } : {}) });
    if (!working.ok) throw new ProductFailure(working.error);
    const sent = await sendCloud({ ...cloud.data, ...query, phaseId: working.data.phase.phaseId,
      nativeConversationId: summary.nativeConversationId, nativeSubmissionId: parent.record.id, nativeTaskId: summary.nativeTaskId,
      checkpointEntryId: summary.checkpointEntryId,
      model: plan.binding.configuration.modelRef.model, body, kind: 'compaction', compactionOperationId: plan.operationId,
      ...(child ? { child: { childRunId: child.childRunId, childSessionId: child.childSessionId, originToolCallId: child.originToolCallId,
        nativeToolTaskId: child.nativeToolTaskId, nativeSubmissionId: summary.nativeSubmissionId } } : {}) }, summary.modelAttemptIds, signal);
    if (!sent.ok) throw new ProductFailure(sent.error);
    return sent.data;
  };
  const submitting = new Map<number, { identity: DurableAttemptIdentity;
    pending: Set<{ query: DurableSubmissionQuery; settled: Promise<void>; abort: AbortController }> }>();
  const stopping = new Map<string, Promise<Result<'stopped' | 'not-started'>> | null>();
  const scopeKey = (input: DurableAttemptIdentity) => JSON.stringify([input.workId, input.sessionId, input.attemptId]);
  const key = (input: DurableSubmissionQuery) => JSON.stringify([input.attemptId, input.requestId]);
  const modelKey = (input: DurableSubmissionQuery) => input.participant === 'reviewer' ? 'reviewer:' + key(input) : key(input);
  const modelAlias = (input: DurableSubmissionQuery) =>
    `flowmate-attempt-${input.attemptId}-phase-${encodeURIComponent(input.requestId)}${input.participant === 'reviewer' ? '-reviewer' : ''}`;
  const guard = async <T>(action: () => Promise<T>): Promise<Result<T>> => {
    if (closed) return fail(appError('durable_runtime_closed', 'runtime', 'Durable runtime is closed.'));
    try { return ok(await action()); }
    catch (error) {
      if (error instanceof ProductFailure) return fail(error.detail);
      const code = error instanceof Error && ['input_invalid', 'state_conflict', 'agent_busy', 'session_not_found', 'storage_corrupt'].includes(error.message)
        ? error.message : 'durable_runtime_failed';
      return fail(appError(code, 'runtime', 'Durable runtime operation could not be confirmed.', true));
    }
  };
  const parse = <T>(schema: z.ZodType<T, z.ZodTypeDef, unknown>, raw: unknown): T => {
    const value = schema.safeParse(raw);
    if (!value.success || value.data !== null && typeof value.data === 'object' && 'participant' in value.data
      && value.data.participant === 'reviewer' && (!('itemId' in value.data) || value.data.itemId === undefined)) throw Error('input_invalid');
    return value.data;
  };
  const verifyQueueAuthorization = async (queued: CloudQueueVerifyInputs) => {
    if (!cloud?.success || !options.verifyQueueInputs) throw Error('state_conflict');
    const verified = await options.verifyQueueInputs(queued); if (!verified.ok) throw new ProductFailure(verified.error);
    const instructions = z.array(CloudQueueInstructionSchema).max(100).parse(verified.data);
    if (instructions.length !== queued.items.length || instructions.some((item, index) =>
      item.controlRequestId !== queued.items[index]!.controlRequestId || item.submissionId !== queued.items[index]!.submissionId
        || item.content !== queued.items[index]!.content)) throw Error('state_conflict');
    return instructions;
  };
  const verifyQueuedInputs = async (query: DurableSubmissionQuery, conversationId: ConversationId, view: ContextView) => {
    const queued = await read(() => harness.commit(async tx => {
      const items: CloudQueueVerifyInputs['items'] = [];
      for (const entry of view.entries.filter(value => value.kind === 'flowmate.queue-input')) {
        const original = queuedEntryIdentity.parse(entry.data), message = entry.model?.[0];
        if (entry.conversationId !== conversationId || entry.model?.length !== 1 || message?.role !== 'user'
          || original.workId !== query.workId || original.sessionId !== query.sessionId || original.itemId !== query.itemId || original.attemptId !== query.attemptId
          || original.requestId !== query.requestId) throw Error('state_conflict');
        const content = typeof message.content === 'string' ? message.content
          : message.content.length === 1 && message.content[0]?.type === 'text' ? message.content[0].text : null;
        const submission = await tx.submissionByRequest(conversationId, queueSubmissionKey(query.attemptId, original.controlRequestId));
        if (content === null || !submission || submission.type !== 'input' || !['placed', 'done'].includes(submission.status)
          || submission.id !== original.submissionId || submission.conversationId !== conversationId || submission.entry !== entry.id
          || submission.requestId !== queueSubmissionKey(query.attemptId, original.controlRequestId)) throw Error('state_conflict');
        items.push({ controlRequestId: original.controlRequestId, submissionId: original.submissionId, entryId: entry.id, content });
      }
      return CloudQueueVerifyInputsSchema.parse({ ...query, items });
    }, context));
    if (!queued.items.length) return { queued, instructions: undefined };
    return { queued, instructions: await verifyQueueAuthorization(queued) };
  };
  const find = async (identity: DurableConversationIdentity): Promise<ConversationId | undefined> => {
    let cursor: Cursor | undefined;
    do {
      const page = await read(() => options.storage.scanConversations({}, 100, cursor, context));
      for (const record of page.items) {
        const binding = await harness.snapshot(Binding, record.id, context);
        if (!binding || binding.workId !== identity.workId && binding.sessionId !== identity.sessionId) continue;
        if (binding.workId !== identity.workId || binding.sessionId !== identity.sessionId) throw Error('state_conflict');
        if (!sameLane(binding, identity)) continue;
        return record.id;
      }
      cursor = page.next;
    } while (cursor);
    return undefined;
  };
  const prepareBinding = async (input: DurableModelPreparation, saved?: DurableModelBinding): Promise<DurableModelBinding> => {
    const identity = attemptIdentity(input), existing = attempts.get(input.attemptId);
    if (existing && (!isDeepStrictEqual(existing.identity, identity) || !isDeepStrictEqual(existing.config, input.config)
      || saved && !isDeepStrictEqual(existing.binding, saved))) throw Error('state_conflict');
    if (existing) return structuredClone(existing.binding);
    const prepared = saved ? ok(saved) : await prepareDurableModelBinding(input.config);
    if (!prepared.ok) throw new ProductFailure(prepared.error);
    const checked = readDurableModelBinding(prepared.data); if (!checked.ok) throw new ProductFailure(checked.error);
    const binding = checked.data.binding;
    if (!isDeepStrictEqual(binding.configuration, input.config)) throw Error('state_conflict');
    const raced = attempts.get(input.attemptId);
    if (raced) {
      if (!isDeepStrictEqual(raced.identity, identity) || !isDeepStrictEqual(raced.config, input.config)
        || !isDeepStrictEqual(raced.binding, binding)) throw Error('state_conflict');
      return structuredClone(raced.binding);
    }
    attempts.set(input.attemptId, { identity, config: structuredClone(input.config), binding: structuredClone(binding) });
    return structuredClone(binding);
  };
  const register = async (input: DurableModelPreparation, saved?: DurableModelBinding) => {
    const identity = attemptIdentity(input), query = parse(querySchema, phaseIdentity(input));
    const binding = await prepareBinding(input, saved);
    if (query.participant === 'reviewer' && !options.readWorkingContext) throw Error('state_conflict');
    if (cloud?.success) {
      if (!options.readWorkingContext || !options.verifyWorkingContext) throw Error('state_conflict');
      if (cloud.data.workId !== input.workId || cloud.data.sessionId !== input.sessionId) throw Error('state_conflict');
      const checked = readDurableModelBinding(binding);
      if (!checked.ok || checked.data.selected.api !== 'openai-completions') throw Error('state_conflict');
    }
    const registered = phases.get(modelKey(query)); if (registered) return registered;
    const prepared = await createDurableModels(input.config, { readApiKey: config => cloud?.success ? 'flowmate-cloud-proxy' : options.readApiKey(identity, config),
      verifyModelUse: signal => withToolFeedback(query, signal, [], async () => {
        const allowed = await options.verifyModelUse(identity); if (!allowed.ok) return allowed;
        if (stopping.has(scopeKey(input))) return fail(appError('state_conflict', 'runtime', 'The attempt is stopping.'));
        return await options.verifyWorkingContext?.(query) ?? ok(undefined);
      }), reserveModelRequest: signal => cloud?.success ? ok(undefined) : withToolFeedback(query, signal, [], () => options.reserveModelRequest(identity)),
      ...(query.participant === 'reviewer' ? {} : { readCompactionUse: (signal, binding) => compactions.modelUse(signal, binding) }),
      ...(cloud?.success ? { fetch: async (_target: RequestInfo | URL, init?: RequestInit, originalSignal?: AbortSignal) => {
        if (typeof init?.body !== 'string') throw Error('state_conflict');
        const summary = query.participant === 'reviewer' ? null : await sendCloudSummary(init.body, originalSignal, init.signal ?? undefined);
        if (summary) return summary;
        const conversationId = await find(query), live = conversationId && await harness.snapshot(LiveDoc, conversationId, context);
        const taskId = live?.run?.taskId, selected = taskId && requested.get(taskId), attempt = taskId && cloudAttempts.get(taskId);
        if (!taskId || !selected || !attempt || !isDeepStrictEqual(selected.query, query) || selected.cutoff !== attempt.cutoff) throw Error('state_conflict');
        const sent = await sendCloud({ ...cloud.data, ...query, phaseId: selected.phaseId,
          nativeConversationId: selected.conversationId, nativeSubmissionId: selected.nativeSubmissionId,
          nativeTaskId: taskId, checkpointEntryId: selected.cutoff,
          model: binding.configuration.modelRef.model, body: init.body }, attempt.modelAttemptIds, init.signal ?? undefined);
        if (!sent.ok) throw new ProductFailure(sent.error);
        return sent.data;
      } } : {}),
      ...(options.readWorkingContext ? { readWorkingContext: async (native: TranscriptContext) => guard(async () => {
        const current = await lookup(query);
        if (!current || !['placed', 'done'].includes(current.record.status) || current.record.entry === undefined) throw Error('state_conflict');
        const conversationId = current.view.nativeConversationId as ConversationId;
        const binding = await harness.snapshot(Binding, conversationId, context), live = await harness.snapshot(LiveDoc, conversationId, context);
        if (binding?.workId !== query.workId || binding.sessionId !== query.sessionId || !sameLane(binding, query) || binding.attemptId !== query.attemptId
          || !live?.run) throw Error('state_conflict');
        const task = await read(() => options.storage.task(live.run!.taskId, context));
        if (!task || task.kind !== GenerationTask.definition.name || task.conversationId !== conversationId || task.abortRequested
          || task.state.status !== 'running') throw Error('state_conflict');
        const checkpoint = parse(requestCheckpoint, task.state.checkpoint);
        const model = phases.get(modelKey(query));
        if (!model || !isDeepStrictEqual(checkpoint.model, model) || checkpoint.thinkingLevel !== current.saved?.binding.thinkingLevel)
          throw Error('state_conflict');
        const conversation = await harness.conversation(conversationId, context); if (!conversation) throw Error('storage_corrupt');
        const view = await conversation.context(context, { at: checkpoint.cutoff as EntryId });
        if (!isDeepStrictEqual(view.messages, native.messages)) throw Error('state_conflict');
        await compactions.verifyInput(query, conversationId, view, current.record.entry);
        const reviewing = query.participant === 'reviewer';
        if (reviewing && view.entries.some(entry => entry.kind === 'flowmate.queue-input')) throw Error('state_conflict');
        const { queued, instructions: queueInstructions } = reviewing ? { queued: { items: [] }, instructions: undefined }
          : await verifyQueuedInputs(query, conversationId, view);
        if (!live.run.inputs.includes(current.record.id) && !queued.items.some(item => live.run!.inputs.includes(item.submissionId as SubmissionId)))
          throw Error('state_conflict');
        const saved = await options.readWorkingContext!(query); if (!saved.ok) throw new ProductFailure(saved.error);
        const workingContext = parse(InvoiceWorkWorkingContextSchema, queueInstructions ? { ...saved.data, queueInstructions } : saved.data);
        if (workingContext.work.workId !== query.workId || workingContext.work.sessionId !== query.sessionId
          || workingContext.phase.attemptId !== query.attemptId || workingContext.phase.requestId !== query.requestId
          || workingContext.item.workId !== query.workId || query.itemId !== undefined && workingContext.item.itemId !== query.itemId
          || reviewing !== Boolean(workingContext.peerReview)
          || reviewing && workingContext.peerReview?.shared !== current.saved?.content) throw Error('state_conflict');
        const projected = reviewing ? { messages: [] } : await compactions.projectPhase(query, conversationId, view), messages = projected.messages;
        requested.set(task.id, { query, conversationId, nativeSubmissionId: current.record.id, nativeEntryId: current.record.entry,
          cutoff: checkpoint.cutoff, phaseId: workingContext.phase.phaseId,
          children: reviewing ? [] : await children.captureParent(query, view.entries, messages) });
        const diagnostics = options.modelDiagnostics;
        let runId: number | null = null;
        if (diagnostics?.buffer.beginTiming && !cloud?.success) {
          try { runId = await diagnostics.readRunId(query); } catch { /* Diagnostics cannot block model use. */ }
        }
        const observedRunId = runId;
        let observationId: string | undefined;
        const trace = diagnostics && observedRunId !== null ? {
          beginTiming: (startedAt: number, observesHttp: boolean) => {
            observationId = randomUUID();
            return diagnostics.buffer.beginTiming?.({
            runId: observedRunId, sessionId: query.sessionId, nativeSessionId: String(conversationId), callSequence: ++diagnosticCallSequence,
            observationId, startedAt: new Date().toISOString(),
            durable: { workId: query.workId, itemId: workingContext.item.itemId, attemptId: query.attemptId,
              phaseId: workingContext.phase.phaseId, nativeTaskId: task.id },
            }, startedAt, observesHttp, diagnostics.capture);
          },
          observeOutput: (message: object) => { if (observationId) observedOutputs.set(message, observationId); },
        } : {};
        if (reviewing) return { workingContext, messages, ...trace };
        let memory: import('@flowmate/contracts').MemoryRecallResult | undefined;
        if (options.readMemory) {
          try {
            const recalled = await options.readMemory(query);
            if (recalled.ok) {
              const checked = MemoryRecallResultSchema.safeParse(recalled.data);
              if (checked.success) memory = checked.data;
            }
          } catch { /* Memory is optional; the original phase remains authoritative. */ }
        }
        return { workingContext, ...projected, ...trace, ...(memory ? { memory } : {}) };
      }) } : {}) }, binding);
    if (!prepared.ok) throw new ProductFailure(prepared.error);
    const racedPhase = phases.get(modelKey(query)); if (racedPhase) return racedPhase;
    const source = prepared.data.models, canonical = source.getModel(prepared.data.modelRef.provider, prepared.data.modelRef.modelId);
    const provider = source.getProvider(prepared.data.modelRef.provider);
    if (!canonical || !provider) throw Error('storage_corrupt');
    const alias = modelAlias(input);
    models.setProvider({ ...provider, id: alias, getModels: () => [{ ...canonical, provider: alias }],
      getAllModels: () => [{ ...canonical, provider: alias }],
      stream: (_model, messages, request) => source.stream(canonical, messages, request),
      streamSimple: (_model, messages, request) => source.streamSimple(canonical, messages, request) });
    const ref = { provider: alias, modelId: canonical.id }; phases.set(modelKey(query), ref); return ref;
  };
  const original = async (conversationId: ConversationId, record: SubmissionRecord, tx: Tx) => {
    if (record.type !== 'input') throw Error('storage_corrupt');
    if (record.entry !== undefined) {
      const entry = await tx.entry(record.entry);
      const message = entry?.model?.[0];
      if (entry?.kind !== 'flowmate.input' || entry.conversationId !== conversationId || message?.role !== 'user') throw Error('storage_corrupt');
      const content = message.content;
      const text = typeof content === 'string' ? content : content.length === 1 && content[0]?.type === 'text' ? content[0].text : null;
      if (text === null) throw Error('storage_corrupt');
      const binding = parse(entryIdentity, entry.data);
      return { binding, text: binding.inputText ?? text, content: text };
    }
    const inbox = await tx.doc(InboxDoc, conversationId), item = inbox.items.find(item => item.id === record.id);
    if (!item || item.mode === 'write' || typeof item.content !== 'string') throw Error('storage_corrupt');
    const binding = parse(entryIdentity, item.entry?.data);
    return { binding, text: binding.inputText ?? item.content, content: item.content };
  };
  const lookup = async (raw: DurableSubmissionQuery) => {
    const input = parse(querySchema, raw), conversationId = await find(input);
    if (conversationId === undefined) return null;
    return read(() => harness.commit(async tx => {
      const record = await tx.submissionByRequest(conversationId, key(input)); if (!record) return null;
      if (record.type !== 'input' || record.conversationId !== conversationId || record.requestId !== key(input)) throw Error('storage_corrupt');
      // Pi removes a withdrawn queued input's Inbox item; its exact native request key still identifies its receipt.
      const saved = record.status === 'unanswered' && record.entry === undefined ? null : await original(conversationId, record, tx);
      if (saved && (saved.binding.workId !== input.workId || saved.binding.sessionId !== input.sessionId || !sameLane(saved.binding, input) || saved.binding.attemptId !== input.attemptId
        || saved.binding.requestId !== input.requestId)) throw Error('storage_corrupt');
      let answer: string | null = null;
      if (record.status === 'done') {
        const entry = await tx.entry(record.answer);
        if (!entry || entry.conversationId !== conversationId || entry.kind !== AssistantEntry.kind) throw Error('storage_corrupt');
        const message = entry.model?.find(message => message.role === 'assistant');
        if (!message || message.role !== 'assistant') throw Error('storage_corrupt');
        answer = message.content.filter(block => block.type === 'text').map(block => block.text).join('');
      }
      const view: DurableSubmissionView = { ...input, nativeConversationId: conversationId, nativeSubmissionId: record.id,
        status: record.status, answer, reason: record.status === 'unanswered' ? record.reason : null };
      return { record, view, saved };
    }, context));
  };
  const verifyIntent = (saved: Awaited<ReturnType<typeof original>> | null, input: DurableSubmissionInput) => {
    if (!saved) throw Error('state_conflict');
    const bound = attempts.get(input.attemptId);
    if (saved.text !== input.text || saved.binding.configName !== input.config.name || saved.binding.configRevision !== input.config.revision
      || saved.binding.thinkingLevel !== (input.thinkingLevel ?? 'off')
      || bound && !isDeepStrictEqual(bound.config, input.config)) throw Error('state_conflict');
  };
  const currentAttempts = async (input: DurableAttemptIdentity) => {
    const records: Array<{ conversationId: ConversationId; record: SubmissionRecord; query: DurableSubmissionQuery }> = [];
    const lanes: Lane[] = []; let cursor: Cursor | undefined;
    do {
      const page = await read(() => options.storage.scanConversations({}, 100, cursor, context));
      for (const conversation of page.items) {
        const binding = await harness.snapshot(Binding, conversation.id, context);
        if (!binding || binding.workId === null || binding.sessionId === null) continue;
        if (binding.attemptId === input.attemptId && (binding.workId !== input.workId || binding.sessionId !== input.sessionId))
          throw Error('state_conflict');
        if (binding.workId !== input.workId && binding.sessionId !== input.sessionId) continue;
        if (binding.workId !== input.workId || binding.sessionId !== input.sessionId || lanes.some(lane => sameLane(lane, binding))) throw Error('state_conflict');
        lanes.push(binding);
        if (binding.attemptId !== input.attemptId || !binding.requestKey) continue;
        const record = await read(() => options.storage.submissionByRequest(conversation.id, binding.requestKey!, context));
        if (!record || record.type !== 'input') throw Error('state_conflict');
        const [attemptId, requestId] = parse(z.tuple([id, InvoiceWorkContinueRequestSchema.shape.requestId]), JSON.parse(binding.requestKey));
        if (attemptId !== input.attemptId || record.conversationId !== conversation.id) throw Error('state_conflict');
        records.push({ conversationId: conversation.id, record, query: { ...attemptIdentity(input),
          ...laneIdentity(binding), requestId } });
      }
      cursor = page.next;
    } while (cursor);
    if (!lanes.length) throw Error('session_not_found');
    if (!records.length) throw Error('state_conflict');
    return records;
  };
  const assertAttemptOwner = (identity: DurableAttemptIdentity) => {
    const prepared = attempts.get(identity.attemptId), inFlight = submitting.get(identity.attemptId);
    if (prepared && !isDeepStrictEqual(prepared.identity, identity) || inFlight && !isDeepStrictEqual(inFlight.identity, identity))
      throw Error('state_conflict');
  };
  const stopOriginalScope = async (identity: DurableAttemptIdentity): Promise<'stopped' | 'not-started'> => {
    const conversations: Array<Lane & { id: ConversationId; attemptId: number | null }> = [];
    let cursor: Cursor | undefined;
    do {
      const page = await read(() => options.storage.scanConversations({}, 100, cursor, context));
      for (const conversation of page.items) {
        const binding = await harness.snapshot(Binding, conversation.id, context);
        if (!binding || binding.workId === null || binding.sessionId === null) continue;
        if (binding.attemptId === identity.attemptId && (binding.workId !== identity.workId || binding.sessionId !== identity.sessionId))
          throw Error('state_conflict');
        if (binding.workId !== identity.workId && binding.sessionId !== identity.sessionId) continue;
        if (binding.workId !== identity.workId || binding.sessionId !== identity.sessionId
          || conversations.some(original => sameLane(original, binding))) throw Error('state_conflict');
        conversations.push({ id: conversation.id, ...laneIdentity(binding), attemptId: binding.attemptId });
      }
      cursor = page.next;
    } while (cursor);
    let created = false;
    do {
      const page = await read(() => options.storage.scanSubmissions({}, 100, cursor, context));
      for (const record of page.items) {
        if (record.type !== 'input' || !record.requestId) continue;
        let request: [number, string];
        try { request = parse(z.tuple([id, InvoiceWorkContinueRequestSchema.shape.requestId]), JSON.parse(record.requestId)); }
        catch { continue; }
        if (request[0] !== identity.attemptId) continue;
        const binding = await harness.snapshot(Binding, record.conversationId, context);
        if (!binding || binding.workId === null || binding.sessionId === null) continue;
        if (binding.workId !== identity.workId || binding.sessionId !== identity.sessionId || binding.attemptId !== identity.attemptId
          || !conversations.some(original => original.id === record.conversationId && sameLane(original, binding)))
          throw Error('state_conflict');
        const query = { ...identity, requestId: request[1] };
        if (record.requestId !== key(query)) throw Error('storage_corrupt');
        if (record.entry !== undefined || record.status !== 'unanswered') {
          const saved = await read(() => harness.commit(tx => original(record.conversationId, record, tx), context));
          if (!isDeepStrictEqual(attemptIdentity(saved.binding), identity) || saved.binding.requestId !== request[1]
            || !sameLane(saved.binding, binding)) throw Error('storage_corrupt');
        }
        created = true;
      }
      cursor = page.next;
    } while (cursor);
    for (const original of conversations) if ((!created || original.attemptId !== identity.attemptId)
      && await read(() => harness.commit(tx => hasLiveOwnedTasks(tx, original.id), context))) throw Error('state_conflict');
    if (!created) {
      return 'not-started';
    }
    const owned = conversations.filter(original => original.attemptId === identity.attemptId);
    await Promise.all(owned.map(async original => {
      const conversation = await harness.conversation(original.id, context); if (!conversation) throw Error('storage_corrupt');
      await conversation.abort(context, { background: true });
    }));
    const summaries = await compactions.stopAttempt(identity); if (!summaries.ok) throw new ProductFailure(summaries.error);
    for (const original of owned) if (await read(() => harness.commit(tx => hasLiveOwnedTasks(tx, original.id), context))) throw Error('state_conflict');
    return 'stopped';
  };
  const assertSchedulable = async () => {
    await children.restoreAll();
    const summaries = await compactions.restoreAll(); if (!summaries.ok) throw new ProductFailure(summaries.error);
    const verified = new Set<string>();
    const verifyPhase = async (query: DurableSubmissionQuery) => {
      if (verified.has(modelKey(query))) return;
      if (!phases.has(modelKey(query))) throw new ProductFailure(appError('provider_model_configuration_unavailable', 'input',
        'Every original phase model binding must be restored before scheduling.'));
      let allowed = await options.verifyModelUse(attemptIdentity(query));
      if (!allowed.ok && ['invoice_work_budget_unknown', 'invoice_work_admission_waiting'].includes(allowed.error.code) && options.verifySchedulingUse) {
        const pending = await reconcileToolFeedback(query, undefined, [], false);
        allowed = await options.verifyModelUse(attemptIdentity(query));
        if (!allowed.ok && ['invoice_work_budget_unknown', 'invoice_work_admission_waiting'].includes(allowed.error.code) && pending.length)
          allowed = await options.verifySchedulingUse(attemptIdentity(query), pending);
      }
      if (!allowed.ok) throw new ProductFailure(allowed.error);
      const checked = await options.verifyWorkingContext?.(query); if (checked && !checked.ok) throw new ProductFailure(checked.error);
      verified.add(modelKey(query));
    };
    for (const status of ['queued', 'placed'] as const) {
      let cursor: Cursor | undefined;
      do {
        const page = await read(() => options.storage.scanSubmissions({ status }, 100, cursor, context));
        for (const record of page.items) {
          if (record.type !== 'input') continue;
          if (await children.isChild(record.conversationId)) continue;
          const saved = await read(() => harness.commit(async tx => {
            if (!record.requestId) throw Error('storage_corrupt');
            const current = await tx.submissionByRequest(record.conversationId, record.requestId);
            if (!current || current.id !== record.id) throw Error('storage_corrupt');
            if (current.status !== 'queued' && current.status !== 'placed') return null;
            let auxiliary: [string, number, string] | null = null;
            try { auxiliary = z.tuple([z.literal('flowmate.queue'), id, z.string().min(1).max(128)]).parse(JSON.parse(record.requestId)); } catch { /* Original phases use their own request key. */ }
            if (!auxiliary) {
              const saved = await original(record.conversationId, current, tx), binding = await tx.doc(Binding, record.conversationId);
              if (!sameLane(saved.binding, binding)) throw Error('storage_corrupt');
              return { query: parse(querySchema, phaseIdentity(saved.binding)), item: null };
            }
            const binding = await tx.doc(Binding, record.conversationId);
            const entry = current.status === 'placed' ? await tx.entry(current.entry) : null;
            const inboxItem = current.status === 'queued' ? (await tx.doc(InboxDoc, record.conversationId)).items.find(item => item.id === current.id) : null;
            const data = entry?.data ?? inboxItem?.entry?.data, kind = entry?.kind ?? inboxItem?.entry?.kind;
            const queuedOriginal = queuedEntryIdentity.parse(data), message = entry?.model?.[0];
            let content: string | null = null;
            if (inboxItem && inboxItem.mode !== 'write' && typeof inboxItem.content === 'string') content = inboxItem.content;
            else if (message?.role === 'user') {
              if (typeof message.content === 'string') content = message.content;
              else if (message.content.length === 1 && message.content[0]?.type === 'text') content = message.content[0].text;
            }
            if (kind !== 'flowmate.queue-input' || typeof content !== 'string' || current.id !== queuedOriginal.submissionId
              || auxiliary[1] !== queuedOriginal.attemptId || auxiliary[2] !== queuedOriginal.controlRequestId
              || binding.workId !== queuedOriginal.workId || binding.sessionId !== queuedOriginal.sessionId
              || !sameLane(binding, queuedOriginal) || binding.attemptId !== queuedOriginal.attemptId
              || binding.requestKey !== JSON.stringify([queuedOriginal.attemptId, queuedOriginal.requestId])
              || entry && (entry.conversationId !== record.conversationId || entry.model?.length !== 1)) throw Error('state_conflict');
            const query = phaseIdentity(queuedOriginal);
            return { query, item: { controlRequestId: queuedOriginal.controlRequestId, submissionId: current.id, entryId: entry?.id ?? null, content } };
          }, context));
          if (!saved) continue;
          await verifyPhase(saved.query);
          if (saved.item) await verifyQueueAuthorization(CloudQueueVerifyInputsSchema.parse({ ...saved.query, items: [saved.item] }));
        }
        cursor = page.next;
      } while (cursor);
    }
    // A settled input can still own tasks; every scheduling entry resumes the whole Harness.
    let cursor: Cursor | undefined;
    do {
      const page = await read(() => options.storage.scanConversations({}, 100, cursor, context));
      for (const conversation of page.items) {
        if (await children.isChild(conversation.id)) continue;
        const query = await read(() => harness.commit(async tx => {
          const binding = await tx.doc(Binding, conversation.id);
          if (binding.workId === null || binding.sessionId === null || binding.attemptId === null || binding.requestKey === null
            || !await hasLiveOwnedTasks(tx, conversation.id)) return null;
          const record = await tx.submissionByRequest(conversation.id, binding.requestKey);
          if (!record || record.type !== 'input') throw Error('storage_corrupt');
          const [attemptId, requestId] = parse(z.tuple([id, InvoiceWorkContinueRequestSchema.shape.requestId]), JSON.parse(binding.requestKey));
          if (attemptId !== binding.attemptId) throw Error('storage_corrupt');
          return { workId: binding.workId, sessionId: binding.sessionId, ...laneIdentity(binding), attemptId, requestId };
        }, context));
        if (query) await verifyPhase(query);
      }
      cursor = page.next;
    } while (cursor);
  };
  const resolveToolCall = async (nativeTaskId: TaskId, nativeConversationId: ConversationId, feedback = false): Promise<DurableProductToolCall> => {
    if (await children.isChild(nativeConversationId)) return children.resolveToolCall(nativeTaskId, nativeConversationId, feedback);
    const nestedTask = await read(() => options.storage.task(nativeTaskId, context));
    const nested = z.object({ kind: z.literal('nested'), parent: id, parentCallId: z.string(), key: z.literal('approved-execution'),
      call: z.object({ type: z.literal('toolCall'), id: z.string(), name: z.string(), arguments: z.record(z.unknown()) }).strict(),
      progress: z.literal(false).optional() }).strict().safeParse(nestedTask?.input);
    if (nested.success) {
      if (feedback || !nestedTask || nestedTask.kind !== ToolTask.definition.name || nestedTask.conversationId !== nativeConversationId
        || nestedTask.owner !== nested.data.parent || !options.readWorkingContext || !options.readToolResult || !options.approvalWait) throw Error('state_conflict');
      const parent = await resolveToolCall(nested.data.parent as TaskId, nativeConversationId);
      const expectedName = parent.name === 'browser_request_read' ? 'browser_read_approved'
        : parent.name === 'desktop_propose_action' ? 'desktop_execute_approved' : null;
      const working = await options.readWorkingContext(phaseIdentity(parent)), saved = await options.readToolResult(parent);
      const proposal = saved.ok && saved.data?.status === 'succeeded' ? z.object({ proposalId: id }).passthrough().safeParse(saved.data.data) : null;
      if (!expectedName || !working.ok || working.data.phase.basis.executionMode !== 'item-lane-approval-v1'
        || parent.itemId === undefined || working.data.item.itemId !== parent.itemId || !proposal?.success
        || nested.data.parentCallId !== parent.nativeToolCallId || nested.data.call.id !== `${parent.nativeToolCallId}/approved-execution`
        || nested.data.call.name !== expectedName || !isDeepStrictEqual(nested.data.call.arguments,
          expectedName === 'browser_read_approved' ? {} : { proposalId: proposal.data.proposalId })) throw Error('state_conflict');
      const decision = await options.approvalWait.read({ ...phaseIdentity(parent), itemId: parent.itemId, phaseId: working.data.phase.phaseId,
        nativeConversationId, nativeTaskId: parent.nativeTaskId, proposalId: proposal.data.proposalId,
        kind: expectedName === 'browser_read_approved' ? 'browser' : 'desktop' });
      if (!decision.ok || decision.data.status !== 'approved' || decision.data.scheduling !== 'active') throw Error('state_conflict');
      return { ...parent, nativeTaskId, nativeToolCallId: nested.data.call.id, name: expectedName,
        arguments: nested.data.call.arguments, parentNativeTaskId: parent.nativeTaskId };
    }
    if (feedback) {
      const call = await read(() => readDurableToolCall(harness, options.storage, nativeTaskId, nativeConversationId, context));
      if (!call || call.child) throw Error('state_conflict');
      const query = parse(querySchema, phaseIdentity(call));
      const receipt = await read(() => options.storage.submissionByRequest(nativeConversationId, key(query), context));
      if (receipt?.type !== 'input' || receipt.entry === undefined) throw Error('state_conflict');
      const saved = await read(() => harness.commit(tx => original(nativeConversationId, receipt, tx), context));
      if (!isDeepStrictEqual(parse(querySchema, phaseIdentity(saved.binding)), query)) throw Error('state_conflict');
      const task = await read(() => options.storage.task(nativeTaskId, context));
      const input = parse(z.object({ assistant: id }), task?.input);
      const conversation = await harness.conversation(nativeConversationId, context); if (!conversation) throw Error('storage_corrupt');
      const view = await conversation.context(context, { at: input.assistant as EntryId });
      await compactions.verifyInput(query, nativeConversationId, view, receipt.entry);
      return call;
    }
    const resolved = await read(() => harness.commit(async tx => {
      const task = await tx.task(nativeTaskId);
      if (!task || task.kind !== ToolTask.definition.name || task.conversationId !== nativeConversationId || task.owner === undefined)
        throw Error('state_conflict');
      const input = parse(z.object({ kind: z.literal('model'), assistant: id, callId: z.string().min(1) }).strict(), task.input);
      const generation = await tx.task(task.owner), phase = await tx.doc(GenerationPhase, task.owner);
      if (generation?.kind !== GenerationTask.definition.name || generation.conversationId !== nativeConversationId) throw Error('state_conflict');
      const selected = phase.receipt;
      if (!selected || selected.nativeTaskId !== task.owner || !('checkpoint' in generation.state)) throw Error('state_conflict');
      const checkpoint = parse(z.object({ phase: z.literal('tools'), assistant: id, tools: z.array(id) }), generation.state.checkpoint);
      if (checkpoint.assistant !== input.assistant || !checkpoint.tools.includes(nativeTaskId)) throw Error('state_conflict');
      const query = parse(querySchema, phaseIdentity(selected));
      const binding = await tx.doc(Binding, nativeConversationId), live = await tx.doc(LiveDoc, nativeConversationId);
      const submission = await tx.submissionByRequest(nativeConversationId, key(query));
      if (!submission || submission.id !== selected.nativeSubmissionId || submission.entry !== selected.nativeEntryId
        || binding.workId !== query.workId || binding.sessionId !== query.sessionId || !sameLane(binding, query) || binding.attemptId !== query.attemptId
        || !live.run?.inputs.includes(submission.id) || live.run.taskId !== generation.id) throw Error('state_conflict');
      const saved = await original(nativeConversationId, submission, tx);
      if (!isDeepStrictEqual(phaseIdentity(saved.binding), query))
        throw Error('state_conflict');
      const assistant = await tx.entry(input.assistant as EntryId), message = assistant?.model?.[0];
      const call = message?.role === 'assistant' ? message.content.find(block => block.type === 'toolCall' && block.id === input.callId) : undefined;
      if (assistant?.conversationId !== nativeConversationId || assistant.kind !== AssistantEntry.kind || assistant.byTaskId !== task.owner || call?.type !== 'toolCall')
        throw Error('storage_corrupt');
      if ((call.name === 'desktop_propose_action' || call.name === 'browser_request_read') && message?.role === 'assistant'
        && message.content.filter(block => block.type === 'toolCall').length !== 1)
        throw new ProductFailure(appError(call.name === 'desktop_propose_action' ? 'desktop_action_requires_single_call' : 'browser_read_requires_single_call',
          'runtime', 'A user confirmation request must be the only tool call in its model response.'));
      const existing = phase.calls.find(item => item.nativeTaskId === nativeTaskId);
      let args: unknown = existing ? JSON.parse(existing.argumentsJson) : call.arguments;
      if ('checkpoint' in task.state) {
        args = parse(z.object({ phase: z.literal('execute'), arguments: z.unknown() }), task.state.checkpoint).arguments;
        if (existing && !isDeepStrictEqual(JSON.parse(existing.argumentsJson), args)) throw Error('storage_corrupt');
        if (!existing) phase.calls.push({ nativeTaskId, argumentsJson: JSON.stringify(args) });
      }
      return { call: { ...query, nativeConversationId, nativeTaskId, nativeToolCallId: input.callId, name: call.name, arguments: args },
        generationTaskId: task.owner, assistantEntryId: input.assistant, phaseId: selected.phaseId, observationId: phase.observationId };
    }, context));
    if (!cloud?.success && resolved.call.name === 'save_invoice_candidate')
      observePromptTrace(() => options.modelDiagnostics?.source?.({ ...phaseIdentity(resolved.call),
        nativeTaskId, generationTaskId: resolved.generationTaskId, assistantEntryId: resolved.assistantEntryId,
        phaseId: resolved.phaseId, observationId: resolved.observationId }));
    return resolved.call;
  };
  const feedbackWrites = new Map<TaskId, { workId: number; sessionId: number; entryId: EntryId; confirmed: boolean; settled: Promise<boolean> }>();
  const recordToolFeedback = (call: DurableProductToolCall, entry: EntryRecord): Promise<boolean> => {
    const taskId = call.nativeTaskId as TaskId, previous = feedbackWrites.get(taskId);
    if (previous) {
      if (previous.entryId !== entry.id) throw Error('storage_corrupt');
      return previous.settled;
    }
    const settled = (async () => {
      const feedback = projectDurableToolFeedback(call, entry), message = entry.model?.[0];
      if (entry.byTaskId !== taskId) throw Error('storage_corrupt');
      await children.noteParentResult(call, entry);
      if (options.onToolFeedback) {
        let recorded: Result<void>;
        try { recorded = await options.onToolFeedback(feedback); }
        catch { recorded = fail(appError('tool_feedback_unconfirmed', 'runtime', 'The exact native tool feedback charge could not be confirmed.')); }
        if (!recorded.ok) throw new ProductFailure(recorded.error);
      }
      const details = message?.role === 'toolResult' ? message.details : null;
      return typeof details === 'object' && details !== null && 'status' in details && details.status === 'unknown';
    })().then(unknown => { const saved = feedbackWrites.get(taskId); if (saved && !unknown) saved.confirmed = true; return unknown; })
      .catch(error => { feedbackWrites.delete(taskId); throw error; });
    feedbackWrites.set(taskId, { workId: call.workId, sessionId: call.sessionId, entryId: entry.id, confirmed: false, settled }); return settled;
  };
  const waitingForApproval = async (call: DurableProductToolCall): Promise<boolean> => {
    if (call.child || call.itemId === undefined || !options.approvalWait || !options.readWorkingContext || !options.readToolResult
      || call.name !== 'browser_request_read' && call.name !== 'desktop_propose_action') return false;
    const context = await options.readWorkingContext(phaseIdentity(call)), result = await options.readToolResult(call);
    const proposal = result.ok && result.data?.status === 'succeeded' ? z.object({ proposalId: id }).passthrough().safeParse(result.data.data) : null;
    if (!context.ok || context.data.phase.basis.executionMode !== 'item-lane-approval-v1'
      || context.data.item.itemId !== call.itemId || !proposal?.success) return false;
    const state = await options.approvalWait.read({ ...phaseIdentity(call), itemId: call.itemId, phaseId: context.data.phase.phaseId,
      nativeConversationId: call.nativeConversationId, nativeTaskId: call.nativeTaskId, proposalId: proposal.data.proposalId,
      kind: call.name === 'browser_request_read' ? 'browser' : 'desktop' });
    return state.ok && (state.data.status === 'waiting' && state.data.scheduling === 'waiting_approval'
      || ['approved', 'rejected'].includes(state.data.status) && state.data.scheduling === 'ready');
  };
  const reconcileToolFeedback = async (query: DurableSubmissionQuery, signal: AbortSignal | undefined, excluded: readonly number[], waitForPending = true) => {
    const pending: DurableProductToolCall[] = [];
    if (!options.onToolFeedback || !options.readToolResult || !options.tools?.length) return pending;
    const check = () => { signal?.throwIfAborted(); if (closed || stopping.has(scopeKey(query))) throw Error('state_conflict'); };
    const bound = signal ? withAbortSignal(signal, context) : context;
    check();
    let cursor: Cursor | undefined;
    do {
      const conversations = await read(() => options.storage.scanConversations({}, 100, cursor, bound));
      for (const conversation of conversations.items) {
        const binding = await harness.snapshot(Binding, conversation.id, bound);
        if (!(binding?.workId === query.workId && binding.sessionId === query.sessionId) && !await children.matchesWork(conversation.id, query)) continue;
        let taskCursor: Cursor | undefined;
        do {
          const tasks = await read(() => options.storage.scanTasks({ conversationId: conversation.id, kind: ToolTask.definition.name }, 100, taskCursor, bound));
          for (let task of tasks.items) {
            check(); if (excluded.includes(task.id)) continue;
            const input = z.object({ kind: z.literal('model'), assistant: id, callId: z.string() }).safeParse(task.input); if (!input.success) continue;
            const assistant = (await read(() => options.storage.entry(input.data.assistant as EntryId, bound)))?.entry;
            const message = assistant?.model?.[0], wire = message?.role === 'assistant' ? message.content.find(block => block.type === 'toolCall' && block.id === input.data.callId) : undefined;
            if (wire?.type !== 'toolCall' || !options.tools.some(tool => tool.name === wire.name)) continue;
            if (!await readDurableToolCall(harness, options.storage, task.id, conversation.id, bound)) continue;
            const call = await resolveToolCall(task.id, conversation.id, true);
            if (call.workId !== query.workId || call.sessionId !== query.sessionId) throw Error('state_conflict');
            if (task.state.status !== 'terminal') {
              const saved = await options.readToolResult(call); if (!saved.ok) throw new ProductFailure(saved.error);
              if (saved.data === null) continue;
              if (await waitingForApproval(call)) { if (!waitForPending) pending.push(call); continue; }
              // A passive preflight must check every original scope before resuming the whole Harness.
              if (!waitForPending) { pending.push(call); continue; }
              // Only a positively committed product result may wait for its original native settling commit.
              await harness.waitForTask(task.id, bound); check();
              const current = await read(() => options.storage.task(task.id, bound)); if (!current) throw Error('storage_corrupt'); task = current;
            }
            const outcome = 'outcome' in task.state ? task.state.outcome : undefined;
            if (!outcome || !('result' in outcome)) throw new ProductFailure(appError('tool_feedback_unconfirmed', 'runtime', 'The original tool has no committed native feedback.'));
            const result = parse(z.object({ entryId: id }), outcome.result);
            const entry = (await read(() => options.storage.entry(result.entryId as EntryId, bound)))?.entry; if (!entry) throw Error('storage_corrupt');
            if (await recordToolFeedback(call, entry)) throw new ProductFailure(appError('tool_commit_unconfirmed', 'runtime', 'The original product tool result remains unknown.'));
          }
          taskCursor = tasks.next;
        } while (taskCursor);
      }
      cursor = conversations.next;
    } while (cursor);
    check();
    return pending;
  };
  const withToolFeedback = async (query: DurableSubmissionQuery, signal: AbortSignal | undefined, excluded: readonly number[],
    verify: () => Result<void> | Promise<Result<void>>): Promise<Result<void>> => {
    const progress = () => [...feedbackWrites.values()].filter(item => item.workId === query.workId && item.sessionId === query.sessionId && item.confirmed).length;
    await reconcileToolFeedback(query, signal, excluded);
    let confirmed = progress(), result = await verify();
    // A peer may commit after the scan; only new exact feedback permits another budget check.
    while (!result.ok && result.error.code === 'invoice_work_budget_unknown') {
      await reconcileToolFeedback(query, signal, excluded);
      const current = progress(); if (current <= confirmed) return result;
      confirmed = current; result = await verify();
    }
    return result;
  };
  compactions = createDurableCompactionRuntime({ harness, storage: options.storage, models, registry, callbacks: options.compactions, cloud: Boolean(cloud?.success),
    read, isClosed: () => closed, isStopping: query => stopping.has(scopeKey(query)), hasLiveOwnedTasks,
    verifyQueueInputs: async (plan, conversationId, view) => {
      if (plan.child && view.entries.some(entry => entry.kind === 'flowmate.queue-input')) throw Error('state_conflict');
      await verifyQueuedInputs(phaseIdentity(plan), conversationId, view);
    },
    beforeSchedule: () => assertSchedulable(),
    resolvePhase: async input => {
      if (input.child) return children.resolvePhase(input.child);
      const current = await lookup(phaseIdentity(input)); if (!current?.saved || current.record.entry === undefined) throw Error('state_conflict');
      const agent = await harness.snapshot(AgentDoc, current.view.nativeConversationId as ConversationId, context); if (!agent?.model) throw Error('state_conflict');
      return { ...phaseIdentity(input),
        nativeConversationId: current.view.nativeConversationId, nativeSubmissionId: current.record.id, nativeEntryId: current.record.entry, model: agent.model };
    },
    prepareModel: async (plan, expected) => {
      if (plan.child) { if (!models.getModel(expected.provider, expected.modelId)) throw Error('state_conflict'); return; }
      const ref = await register({ ...phaseIdentity(plan),
        config: plan.binding.configuration }, plan.binding);
      if (!isDeepStrictEqual(ref, expected)) throw Error('state_conflict');
    },
    resolveAutomatic: async (taskId, conversationId, reason, tail) => {
      const task = await read(() => options.storage.task(taskId, context)), live = await harness.snapshot(LiveDoc, conversationId, context);
      if (!task?.owner || live?.run?.taskId !== task.owner) throw Error('state_conflict');
      if (await children.isChild(conversationId)) {
        const child = await children.identityForConversation(conversationId); if (!child) throw Error('state_conflict');
        return { ...phaseIdentity(child), child,
          operationId: `durable-compaction:${taskId}`, reason, expectedTailEntryId: tail, instructions: null };
      }
      let selected: DurableSubmissionQuery | null = null;
      for (const submissionId of live.run.inputs) {
        const record = await read(() => options.storage.submission(submissionId, context));
        if (record?.type !== 'input' || record.entry === undefined) throw Error('state_conflict');
        const entry = (await read(() => options.storage.entry(record.entry!, context)))?.entry;
        if (!entry || entry.kind !== 'flowmate.input' && entry.kind !== 'flowmate.queue-input') throw Error('state_conflict');
        const raw = entry.kind === 'flowmate.input' ? parse(entryIdentity, entry.data) : parse(queuedEntryIdentity, entry.data);
        const identity = phaseIdentity(raw);
        if (selected && !isDeepStrictEqual(selected, identity)) throw Error('state_conflict'); selected = identity;
      }
      if (!selected || selected.participant === 'reviewer') throw Error('state_conflict');
      return { ...selected, operationId: `durable-compaction:${taskId}`, reason, expectedTailEntryId: tail, instructions: null };
    },
  });
  children = createDurableSubagentRuntime({ harness, storage: options.storage, models, registry, callbacks: options.subagents,
    isClosed: () => closed, isStopping: identity => stopping.has(scopeKey(identity)), readApiKey: options.readApiKey,
    ...(cloud?.success ? { cloudModel: { sendSummary: sendCloudSummary, send: async (identity, native, signal) => {
      const attempt = cloudAttempts.get(native.taskId as TaskId), parent = await lookup(phaseIdentity(identity));
      if (!attempt || attempt.cutoff !== native.cutoff || !parent) throw Error('state_conflict');
      const sent = await sendCloud({ ...cloud.data, workId: identity.workId, sessionId: identity.sessionId,
        ...(identity.itemId === undefined ? {} : { itemId: identity.itemId }), attemptId: identity.attemptId, requestId: identity.requestId, phaseId: native.phaseId,
        nativeConversationId: native.conversationId, nativeSubmissionId: parent.record.id, nativeTaskId: native.taskId,
        checkpointEntryId: native.cutoff,
        model: native.model, body: native.body,
        child: { childRunId: identity.childRunId, childSessionId: identity.childSessionId, originToolCallId: identity.originToolCallId,
          nativeToolTaskId: identity.nativeToolTaskId, nativeSubmissionId: native.submissionId } }, attempt.modelAttemptIds, signal);
      if (!sent.ok) throw new ProductFailure(sent.error);
      return sent.data;
    } } } : {}),
    readWorkingContext: options.readWorkingContext, read, hasLiveOwnedTasks, withToolFeedback, compactions });
  const history = createDurableHistoryReader({ storage: options.storage, read, resolveOwner: async input => ({
    owner: { runtimeKind: 'durable', workId: input.workId, sessionId: input.child?.childSessionId ?? input.sessionId,
      childRunId: input.child?.childRunId ?? null, ...laneIdentity(input) },
    conversationId: input.child ? await children.resolveConversationId(input.child) : await find(input),
  }) });
  if (options.tools?.length) registry.install({ name: 'flowmate-product-tools', tools: createDurableProductTools({ definitions: options.tools,
    resolve: async (api: ToolExecutionApi) => resolveToolCall(api.taskId, api.conversationId),
    verify: async (call, signal) => {
      if (call.child) return children.verifyTool(call, signal);
      return withToolFeedback(call, signal, [call.nativeTaskId, ...(call.parentNativeTaskId === undefined ? [] : [call.parentNativeTaskId])], async () => {
      if (closed || stopping.has(scopeKey(call))) return fail(appError('state_conflict', 'runtime', 'The original tool attempt is stopping.'));
      const query = parse(querySchema, phaseIdentity(call));
      const checked = await options.verifyWorkingContext!(query); if (!checked.ok) return checked;
      const saved = await options.readWorkingContext!(query); if (!saved.ok) return saved;
      const working = parse(InvoiceWorkWorkingContextSchema, saved.data);
      if (working.work.workId !== call.workId || working.work.sessionId !== call.sessionId || working.phase.attemptId !== call.attemptId
        || working.phase.requestId !== call.requestId || call.itemId !== undefined && working.item.itemId !== call.itemId || !working.actions.tools.includes(call.name))
        return fail(appError('tool_not_allowed', 'tool', 'The tool is outside its original phase tool set.'));
      if (working.phase.basis.executionMode === 'item-lane-approval-v1'
        && (call.name === 'browser_read_approved' || call.name === 'desktop_execute_approved') && call.parentNativeTaskId === undefined)
        return fail(appError('tool_not_allowed', 'tool', 'The approved operation requires its original waiting tool.'));
      if (call.parentNativeTaskId !== undefined && options.verifySchedulingUse) {
        const parent = await resolveToolCall(call.parentNativeTaskId as TaskId, call.nativeConversationId as ConversationId);
        return options.verifySchedulingUse(attemptIdentity(call), [parent]);
      }
      return options.verifyModelUse(attemptIdentity(call));
      });
    }, execute: async call => {
      const { signal, nativeDelegate: _nativeDelegate, ...identity } = call;
      await rememberDurableToolCall(harness, options.storage, identity, withAbortSignal(signal, context));
      return options.executeTool!(call);
    }, read: call => options.readToolResult!(call),
    approval: { context: call => Promise.resolve(options.readWorkingContext!(phaseIdentity(call))), wait: options.approvalWait },
    ...(options.subagents ? { delegate: children.invoker } : {}) }) });
  registry.install({ name: 'flowmate-phase-consumption', hooks: [hook(GenerationTask, { beforeRequest: async (_request, api, nativeContext) => {
    if (!cloud?.success) return undefined;
    const task = await read(() => options.storage.task(api.taskId, context));
    const checkpoint = z.object({ phase: z.literal('request'), cutoff: id }).parse(task?.state.status === 'running' ? task.state.checkpoint : null);
    const modelAttemptIds: string[] = [];
    const binding = await harness.snapshot(Binding, api.conversationId, context);
    const limit = binding?.participant === 'reviewer' ? 1 : 4;
    for (let ordinal = 0; ordinal < limit; ordinal++) {
      const key = `flowmate.cloud-model:${checkpoint.cutoff}${ordinal === 0 ? '' : `:${ordinal}`}`;
      const modelAttemptId = await api.memo(key, randomUUID(), nativeContext);
      if (!z.string().uuid().safeParse(modelAttemptId).success) throw Error('storage_corrupt'); modelAttemptIds.push(modelAttemptId);
    }
    cloudAttempts.set(api.taskId, { modelAttemptIds, cutoff: checkpoint.cutoff });
    return undefined;
  }, afterResponse: async (message, api) => {
    const selected = requested.get(api.taskId); requested.delete(api.taskId);
    cloudAttempts.delete(api.taskId);
    if (!selected || selected.conversationId !== api.conversationId || !['stop', 'length', 'toolUse'].includes(message.stopReason)) return;
    if (selected.query.participant === 'reviewer' && message.content.some(block => block.type === 'toolCall'))
      throw new ProductFailure(appError('tool_not_allowed', 'runtime', 'The reviewer cannot invoke tools.'));
    await harness.commit(async tx => {
      const submission = await tx.submissionByRequest(api.conversationId, key(selected.query)), task = await tx.task(api.taskId);
      if (!submission || submission.id !== selected.nativeSubmissionId || submission.entry !== selected.nativeEntryId
        || task?.kind !== GenerationTask.definition.name || task.conversationId !== api.conversationId) throw Error('storage_corrupt');
      const receipt: ConsumptionReceipt = { ...selected.query, nativeSubmissionId: selected.nativeSubmissionId,
        nativeEntryId: selected.nativeEntryId, nativeTaskId: api.taskId, cutoff: selected.cutoff, phaseId: selected.phaseId,
        consumedAt: new Date().toISOString() };
      await tx.doc(Consumption, api.conversationId, key(selected.query), receipt);
      const phase = await tx.doc(GenerationPhase, api.taskId);
      phase.receipt = receipt;
      // Only the actual SDK result returned to Durable can identify a model invocation.
      const observationId = observedOutputs.get(message);
      if (observationId) phase.observationId = observationId;
      else delete phase.observationId;
    }, context);
    await children.parentConsumed(selected.children, api.taskId, new Date().toISOString());
  }, afterTools: async (_assistant, results, api, nativeContext) => {
    if (!options.tools?.length) return;
    const generation = await read(() => options.storage.task(api.taskId, context));
    if (!generation || !('checkpoint' in generation.state)) throw Error('storage_corrupt');
    const checkpoint = parse(z.object({ phase: z.literal('tools'), tools: z.array(id) }), generation.state.checkpoint);
    let unknown = false;
    for (const nativeTaskId of checkpoint.tools) {
      const task = await read(() => options.storage.task(nativeTaskId as TaskId, context));
      const settled = task && 'outcome' in task.state ? task.state.outcome : undefined;
      if (!task || !settled || !('result' in settled)) throw Error('storage_corrupt');
      const outcome = parse(z.object({ entryId: id }), settled.result);
      if (!results.includes(outcome.entryId as EntryId)) throw Error('storage_corrupt');
      const call = await resolveToolCall(task.id, api.conversationId);
      if (!options.tools?.some(tool => tool.name === call.name)) continue;
      const entry = (await read(() => options.storage.entry(outcome.entryId as EntryId, context)))?.entry;
      if (!entry) throw Error('storage_corrupt');
      try { const unconfirmed = await recordToolFeedback(call, entry); unknown ||= unconfirmed; }
      catch (error) {
        // Its own signal cancels abortTask's join once the durable abort mark commits.
        await harness.abortTask(api.taskId, nativeContext);
        throw error;
      }
    }
    if (unknown) {
      await harness.abortTask(api.taskId, nativeContext);
      throw new ProductFailure(appError('tool_commit_unconfirmed', 'runtime', 'The original product tool result remains unknown.'));
    }
  } })] });
  const port: DurableRuntimePort & { queue: CloudQueuePort } = {
    queue: createDurableQueueController({ harness, resolve: owner => find(owner), activePhase: async (tx, conversationId, owner, requestId) => {
      const binding = await tx.doc(Binding, conversationId), live = await tx.doc(LiveDoc, conversationId);
      return !closed && !stopping.has(scopeKey(owner)) && binding.workId === owner.workId && binding.sessionId === owner.sessionId
        && sameLane(binding, owner) && binding.attemptId === owner.attemptId
        && binding.requestKey === key({ ...owner, requestId }) && live.run !== undefined;
    } }),
    openConversation: raw => guard(async () => {
      const input = parse(identitySchema, raw);
      const conversationId = await harness.commit(async tx => {
        let cursor: Cursor | undefined;
        do {
          const page = await tx.scanConversations({}, 100, cursor);
          for (const record of page.items) {
            const binding = await tx.doc(Binding, record.id);
            if (binding.workId !== input.workId && binding.sessionId !== input.sessionId) continue;
            if (binding.workId !== input.workId || binding.sessionId !== input.sessionId) throw Error('state_conflict');
            if (!sameLane(binding, input)) continue;
            return record.id;
          }
          cursor = page.next;
        } while (cursor);
        const record = await tx.createConversation({ ownership: { kind: 'ownerless' } });
        const binding = await tx.doc(Binding, record.id);
        binding.workId = input.workId; binding.sessionId = input.sessionId; binding.itemId = input.itemId ?? null;
        binding.participant = input.participant ?? null;
        return record.id;
      }, context);
      return { ...input, nativeConversationId: conversationId };
    }),
    prepareModel: raw => guard(async () => prepareBinding(parse(preparationSchema, raw))),
    restoreModel: raw => guard(async () => {
      const input = parse(restoreSchema, raw), current = await lookup(phaseIdentity(input));
      if (!current?.saved) throw Error('state_conflict');
      const config = input.binding.configuration;
      if (current.saved.binding.configName !== config.name || current.saved.binding.configRevision !== config.revision) throw Error('state_conflict');
      const checked = readDurableModelBinding(input.binding); if (!checked.ok) throw new ProductFailure(checked.error);
      const expected = { provider: modelAlias(input), modelId: checked.data.selected.id };
      if (current.record.status === 'queued' || current.record.status === 'placed') {
        const agent = await harness.snapshot(AgentDoc, current.view.nativeConversationId as ConversationId, context);
        let matched = isDeepStrictEqual(agent?.model, expected) && (agent?.thinkingLevel ?? 'off') === current.saved.binding.thinkingLevel,
          cursor: Cursor | undefined;
        do {
          const page = await read(() => options.storage.scanTasks({ conversationId: current.view.nativeConversationId as ConversationId,
            kind: GenerationTask.definition.name }, 100, cursor, context));
          matched ||= page.items.some(task => {
            if (!('checkpoint' in task.state)) return false;
            const checkpoint = requestCheckpoint.safeParse(task.state.checkpoint);
            return checkpoint.success && isDeepStrictEqual(checkpoint.data.model, expected)
              && checkpoint.data.thinkingLevel === current.saved!.binding.thinkingLevel;
          });
          cursor = page.next;
        } while (!matched && cursor);
        if (!matched) throw Error('state_conflict');
      }
      await register({ ...input, config }, input.binding);
      if (!input.participant) await children.reconcileParentConsumed(input);
    }),
    submit: raw => guard(async () => {
      const input = parse(inputSchema, raw), query = phaseIdentity(input);
      const identity = attemptIdentity(query), stopKey = scopeKey(identity);
      assertAttemptOwner(identity);
      let active = submitting.get(input.attemptId);
      if (stopping.has(stopKey) && active?.pending.size) throw Error('state_conflict');
      if (!active && !stopping.has(stopKey)) { active = { identity, pending: new Set() }; submitting.set(input.attemptId, active); }
      const completion = Promise.withResolvers<void>(), pending = { query, settled: completion.promise, abort: new AbortController() };
      if (!stopping.has(stopKey)) active!.pending.add(pending);
      const check = () => { if (closed || stopping.has(stopKey)) throw Error('state_conflict'); };
      const nativeContext = withAbortSignal(pending.abort.signal, context);
      try {
      const existing = await lookup(query);
      if (existing) {
        verifyIntent(existing.saved, input);
        return existing.view;
      }
      check();
      const conversationId = await find(input); if (conversationId === undefined) throw Error('session_not_found');
      check(); await assertSchedulable(); check();
      const model = await register(input, input.binding), allowed = await options.verifyModelUse(attemptIdentity(query)); if (!allowed.ok) throw new ProductFailure(allowed.error);
      check();
      const selected = models.getModel(model.provider, model.modelId);
      if (!selected || !getSupportedThinkingLevels(selected).includes(input.thinkingLevel))
        throw new ProductFailure(appError('provider_thinking_level_unsupported', 'input', 'The original model does not support the requested thinking level.'));
      let content = input.text, instructions: string | undefined, scopedTools: readonly ToolRegistration[] | undefined,
        modelTools: readonly ToolRegistration[] | undefined;
      if (options.readWorkingContext) {
        const saved = await options.readWorkingContext(query); if (!saved.ok) throw new ProductFailure(saved.error);
        const working = parse(InvoiceWorkWorkingContextSchema, saved.data);
        if (working.work.workId !== query.workId || working.work.sessionId !== query.sessionId || working.phase.attemptId !== query.attemptId
          || working.phase.requestId !== query.requestId || Boolean(working.peerReview) !== (query.participant === 'reviewer'))
          throw Error('state_conflict');
        if (working.peerReview) {
          if (working.item.itemId !== query.itemId || working.item.workId !== query.workId) throw Error('state_conflict');
          content = working.peerReview.shared;
          instructions = DURABLE_REVIEWER_INSTRUCTIONS;
          scopedTools = [];
          modelTools = [];
        } else {
          const formatted = formatInvoiceWorkContext(working), rendered = formatInvoiceWorkInstructions(working.instructions);
          if (!formatted.ok) throw new ProductFailure(formatted.error); if (!rendered.ok) throw new ProductFailure(rendered.error);
          content = formatted.data; instructions = rendered.data;
          scopedTools = registry.snapshot().tools().map(item => item.tool).filter(tool => working.actions.tools.includes(tool.name));
          modelTools = working.phase.basis.executionMode === 'item-lane-approval-v1'
            ? scopedTools.filter(tool => tool.name !== 'browser_read_approved' && tool.name !== 'desktop_execute_approved') : scopedTools;
        }
        check(); await compactions.preparePhase(query, conversationId); check();
      }
      await harness.commit(async tx => {
        const binding = await tx.doc(Binding, conversationId), live = await tx.doc(LiveDoc, conversationId);
        check();
        if (options.readWorkingContext && binding.requestKey !== key(input)
          && (live.run || await hasLiveOwnedTasks(tx, conversationId))) throw Error('agent_busy');
        if (binding.attemptId !== null && binding.attemptId !== input.attemptId) {
          const previous = binding.requestKey ? await tx.submissionByRequest(conversationId, binding.requestKey) : undefined;
          if (live.run || !previous || !['done', 'unanswered'].includes(previous.status)
            || await hasLiveOwnedTasks(tx, conversationId)) throw Error('agent_busy');
        }
        check(); binding.attemptId = input.attemptId; binding.requestKey = key(input);
        await configure(tx, conversationId, { model, thinkingLevel: input.thinkingLevel, ...(instructions === undefined ? {} : { instructions }),
          ...(scopedTools === undefined ? {} : { tools: scopedTools, modelTools }) });
        check();
      }, nativeContext);
      check();
      const conversation = await harness.conversation(conversationId, nativeContext); if (!conversation) throw Error('storage_corrupt');
      check();
      const admitted = await conversation.submit({ type: 'input', requestId: key(input), content, whenBusy: 'followUp',
        entry: { kind: 'flowmate.input', data: { ...query, configName: input.config.name, configRevision: input.config.revision,
          thinkingLevel: input.thinkingLevel, ...(options.readWorkingContext ? { inputText: input.text } : {}) } } }, nativeContext);
      check();
      const result = await lookup(query); if (!result || result.record.id !== admitted.id) throw Error('storage_corrupt');
      check(); verifyIntent(result.saved, input); return result.view;
      } catch (error) { check(); throw error; }
      finally { active?.pending.delete(pending); completion.resolve(); }
    }),
    getSubmission: raw => guard(async () => (await lookup(raw))?.view ?? null),
    observeSubmission: raw => guard(async () => {
      const input = parse(querySchema, raw), conversationId = await find(input); if (conversationId === undefined) return null;
      const consumed = await harness.snapshot(Consumption, conversationId, key(input), context);
      const observed = await harness.commit(async tx => {
        const record = await tx.submissionByRequest(conversationId, key(input)); if (!record) return null;
        const binding = await tx.doc(Binding, conversationId);
        if (record.type !== 'input' || record.conversationId !== conversationId || record.requestId !== key(input)
          || binding.workId !== input.workId || binding.sessionId !== input.sessionId || !sameLane(binding, input)) throw Error('storage_corrupt');
        if (record.status === 'unanswered' && record.entry === undefined) return { record, execution: 'closed' as const };
        if (record.status === 'queued' || binding.attemptId !== input.attemptId) return { record, execution: 'unknown' as const };
        if (input.participant === 'reviewer' && record.status === 'done') {
          const answer = await tx.entry(record.answer);
          if (!consumed || answer?.kind !== AssistantEntry.kind || answer.conversationId !== conversationId
            || answer.byTaskId !== consumed.nativeTaskId || answer.model?.[0]?.role !== 'assistant') throw Error('storage_corrupt');
        }
        const live = await tx.doc(LiveDoc, conversationId);
        return { record, execution: live.run || await hasLiveOwnedTasks(tx, conversationId) ? 'active' as const
          : record.status === 'done' || record.status === 'unanswered' ? 'closed' as const : 'unknown' as const };
      }, context);
      if (!observed) return null;
      if (consumed && (consumed.workId !== input.workId || consumed.sessionId !== input.sessionId || !sameLane(consumed, input) || consumed.attemptId !== input.attemptId
        || consumed.requestId !== input.requestId || consumed.nativeSubmissionId !== observed.record.id
        || consumed.nativeEntryId !== observed.record.entry)) throw Error('storage_corrupt');
      return { ...input, nativeConversationId: conversationId, nativeSubmissionId: observed.record.id,
        nativeEntryId: observed.record.entry ?? null, status: observed.record.status,
        ...(input.participant === 'reviewer' && observed.record.status === 'done' ? { nativeAnswerEntryId: observed.record.answer } : {}),
        consumedAt: consumed?.consumedAt ?? null, execution: observed.execution };
    }),
    observeSubagent: raw => children.observe(raw),
    waitForSubmission: raw => guard(async () => {
      const input = parse(querySchema, raw), record = await lookup(input); if (!record) throw Error('state_conflict');
      if (['done', 'unanswered'].includes(record.record.status)) return record.view;
      await assertSchedulable();
      let allowed = await options.verifyModelUse(attemptIdentity(input));
      if (!allowed.ok && allowed.error.code === 'invoice_work_budget_unknown' && options.verifySchedulingUse)
        allowed = await withToolFeedback(input, undefined, [], () => options.verifyModelUse(attemptIdentity(input)));
      if (!allowed.ok) throw new ProductFailure(allowed.error);
      const submission = await harness.submission(record.record.id, context); if (!submission) throw Error('storage_corrupt');
      await submission.wait(context);
      const result = await lookup(input); if (!result) throw Error('storage_corrupt'); return result.view;
    }),
    stopAttempt: raw => guard(async () => {
      const input = parse(stopSchema, raw), identity = attemptIdentity(input);
      assertAttemptOwner(identity);
      const stopKey = scopeKey(identity);
      let operation = stopping.get(stopKey);
      if (!operation) {
        stopping.set(stopKey, null);
        const pending = [...(submitting.get(input.attemptId)?.pending ?? [])];
        for (const submission of pending) submission.abort.abort();
        operation = (async () => { await Promise.all(pending.map(submission => submission.settled)); return stopOriginalScope(identity); })()
          .then(reason => ok(reason), error => {
          stopping.set(stopKey, null);
          const code = error instanceof Error && ['state_conflict', 'session_not_found', 'storage_corrupt'].includes(error.message)
            ? error.message : 'durable_stop_failed';
          return fail(appError(code, 'runtime', 'Durable stop could not be confirmed.', true));
        });
        stopping.set(stopKey, operation);
      }
      let timer: ReturnType<typeof setTimeout> | undefined;
      try {
        const observed = await Promise.race([operation.then(result => ({ done: true as const, result })),
          new Promise<{ done: false }>(resolve => { timer = setTimeout(() => resolve({ done: false }), input.stopGraceMs); })]);
        if (observed.done) {
          if (!observed.result.ok) throw new ProductFailure(observed.result.error);
          return { ...identity, stopped: true, reason: observed.result.data };
        }
        return { ...identity, stopped: false, reason: 'stop-unconfirmed' as const };
      } finally { if (timer !== undefined) clearTimeout(timer); }
    }),
    resumeAttempt: raw => guard(async () => {
      const input = attemptIdentity(parse(attemptSchema, raw)), records = await currentAttempts(input);
      if (stopping.has(scopeKey(input))) throw Error('state_conflict');
      let current: typeof records[number] | undefined;
      for (const original of records) {
        const live = await read(() => harness.commit(tx => hasLiveOwnedTasks(tx, original.conversationId), context));
        if (original.record.status === 'unanswered' && live) throw Error('state_conflict');
        if (!current && (original.record.status === 'queued' || original.record.status === 'placed'
          || original.record.status === 'done' && live)) current = original;
      }
      if (!current) throw Error('state_conflict');
      if (!attempts.has(input.attemptId)) throw new ProductFailure(appError('provider_model_configuration_unavailable', 'input', 'Original attempt model binding is unavailable.'));
      await assertSchedulable();
      let allowed = await options.verifyModelUse(input);
      if (!allowed.ok && ['invoice_work_budget_unknown', 'invoice_work_admission_waiting'].includes(allowed.error.code) && options.verifySchedulingUse) {
        const pending = await reconcileToolFeedback(current.query, undefined, [], false);
        allowed = await options.verifyModelUse(input);
        if (!allowed.ok && ['invoice_work_budget_unknown', 'invoice_work_admission_waiting'].includes(allowed.error.code) && pending.length)
          allowed = await options.verifySchedulingUse(input, pending);
      }
      if (!allowed.ok) throw new ProductFailure(allowed.error);
      harness.resume();
    }),
    queryHistory: raw => guard(async () => {
      const input = parse(historySchema, raw), conversationId = await find(input);
      if (conversationId === undefined) throw Error('session_not_found');
      let before: EntryId | undefined;
      if (input.beforeEntryId !== undefined) {
        const point = (await read(() => options.storage.entry(input.beforeEntryId! as EntryId, context)))?.entry;
        if (!point || point.conversationId !== conversationId) throw Error('state_conflict');
        before = point.id;
      }
      const page = await read(() => options.storage.scanEntries({ conversationId, order: 'descending',
        ...(before === undefined ? {} : { maxEntryId: before }) }, input.limit + (before === undefined ? 0 : 1), undefined, context));
      const entries = page.items.filter(entry => entry.id !== before).map(entry => ({ nativeEntryId: entry.id, kind: entry.kind, json: JSON.stringify(entry) }));
      return { workId: input.workId, sessionId: input.sessionId, ...laneIdentity(input),
        nativeConversationId: conversationId, entries,
        nextBeforeEntryId: page.next && entries.length ? entries.at(-1)!.nativeEntryId : null };
    }),
    queryHistoryPage: raw => guard(async () => {
      const result = await history.queryHistoryPage(raw); if (!result.ok) throw new ProductFailure(result.error); return result.data;
    }),
    queryHistoryEntry: raw => guard(async () => {
      const result = await history.queryHistoryEntry(raw); if (!result.ok) throw new ProductFailure(result.error); return result.data;
    }),
    compact: raw => guard(async () => { const result = await compactions.start(parse(DurableCompactionRequestSchema, raw)); if (!result.ok) throw new ProductFailure(result.error); return result.data; }),
    queryCompaction: raw => guard(async () => { const result = await compactions.observe(parse(DurableCompactionIdentitySchema, raw)); if (!result.ok) throw new ProductFailure(result.error); return result.data; }),
    cancelCompaction: raw => guard(async () => { const result = await compactions.cancel(parse(DurableCompactionIdentitySchema, raw)); if (!result.ok) throw new ProductFailure(result.error); return result.data; }),
    close,
  };
  if (cloud?.success && options.onNativeResult) {
    const binding = cloud.data;
    const report = (error: AppError) => { try { options.onNativeResultError?.(error); } catch { /* The original native result remains available. */ } };
    requestResultScan = () => {
      if (closed) return;
      scanPending = true; if (resultScan) return;
      resultScan = (async () => {
        while (scanPending && !closed) {
          scanPending = false;
          for (const status of ['done', 'unanswered'] as const) {
            let cursor: Cursor | undefined;
            do {
              const page = await read(() => options.storage.scanSubmissions({ status }, 100, cursor, context));
              for (const record of page.items) {
                if (closed || record.type !== 'input' || !record.requestId) continue;
                let key: [number, string];
                try { key = parse(z.tuple([id, InvoiceWorkContinueRequestSchema.shape.requestId]), JSON.parse(record.requestId)); }
                catch { continue; }
                const owner = await harness.snapshot(Binding, record.conversationId, context);
                if (!owner || owner.workId !== binding.workId || owner.sessionId !== binding.sessionId) continue;
                const query = { workId: binding.workId, sessionId: binding.sessionId,
                  ...laneIdentity(owner), attemptId: key[0], requestId: key[1] };
                const current = await lookup(query); if (!current || current.record.id !== record.id) continue;
                const observed = await port.observeSubmission(query); if (!observed.ok || !observed.data || observed.data.execution !== 'closed') continue;
                const answerBytes = current.view.answer === null ? 0 : Buffer.byteLength(current.view.answer, 'utf8');
                let oversized: CloudNativeOversizedResult | null = null;
                if (record.status === 'done' && answerBytes > RUNTIME_CONFIG.llmPayload.maxOutputTextBytes) {
                  oversized = CloudNativeOversizedResultSchema.parse({ version: 1, ...binding, ...query, nativeConversationId: record.conversationId,
                    nativeSubmissionId: record.id, nativeInputEntryId: record.entry, nativeAnswerEntryId: record.answer,
                    consumedAt: observed.data.consumedAt, status: 'done', answerBytes });
                } else if (record.status === 'unanswered' && record.reason.length > 8192) {
                  oversized = CloudNativeOversizedResultSchema.parse({ version: 1, ...binding, ...query, nativeConversationId: record.conversationId,
                    nativeSubmissionId: record.id, nativeInputEntryId: record.entry ?? null, nativeAnswerEntryId: null,
                    consumedAt: observed.data.consumedAt, status: 'unanswered', reasonLength: record.reason.length });
                }
                if (oversized) {
                  if (!options.onNativeResultOversized) { report(appError('cloud_result_too_large', 'runtime', 'The original result exceeds the delivery limit.')); continue; }
                  const saved = await options.onNativeResultOversized(oversized); if (!saved.ok) report(saved.error); continue;
                }
                const event = CloudNativeResultSchema.parse({ version: 1, ...binding, ...query, nativeConversationId: record.conversationId,
                  nativeSubmissionId: record.id, nativeInputEntryId: record.entry ?? null,
                  nativeAnswerEntryId: record.status === 'done' ? record.answer : null, consumedAt: observed.data.consumedAt,
                  status: record.status, answer: current.view.answer, reason: current.view.reason });
                const saved = await options.onNativeResult!(event); if (!saved.ok) report(saved.error);
              }
              cursor = page.next;
            } while (cursor && !closed);
          }
        }
      })().catch(() => report(appError('cloud_result_unavailable', 'runtime', 'Native terminal results could not be reconciled.', true)))
        .finally(() => { resultScan = undefined; if (scanPending && !closed) requestResultScan?.(); });
    };
    requestResultScan();
  }
  return ok(port);
}
