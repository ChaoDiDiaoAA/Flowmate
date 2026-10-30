import { BACKGROUND_CONTEXT, withAbortSignal } from '@earendil-works/chord/context';
import { createModels, getSupportedThinkingLevels, InMemoryCredentialStore, InMemoryModelsStore, type TranscriptContext } from '@earendil-works/pi-ai';
import { AgentDoc, AssistantEntry, configure, createRegistry, defineDoc, defineDocFamily, GenerationTask, Harness, hook, InboxDoc, LiveDoc, StorageRequestError, ToolTask,
  type ConversationId, type Cursor, type EntryId, type EntryRecord, type Registry, type Storage, type SubmissionRecord, type TaskGraphWatch, type TaskId, type ToolExecutionApi, type ToolRegistration, type Tx } from '@earendil-works/pi-durable';
import { appError, fail, InvoiceWorkContinueRequestSchema, ok, PersonalAgentConfigurationSchema, ProviderConfigSchema, RUNTIME_CONFIG,
  type AppError, type DurableAttemptIdentity, type DurableConversationIdentity, type DurableRuntimePort, type DurableSubmissionInput,
  type DurableSubmissionQuery, type DurableSubmissionView, type ProviderConfig, type Result, type ToolResult } from '@flowmate/contracts';
import { isDeepStrictEqual } from 'node:util';
import { z } from 'zod';
import { createDurableModels, durableModelBindingSchema, prepareDurableModelBinding, readDurableModelBinding } from './models.ts';
import type { DurableModelBinding, DurableModelPreparation, DurableProductToolCall, DurableProductToolDefinition, DurableProductToolFeedback } from '../../contracts/src/durable-runtime.ts';
import { InvoiceWorkWorkingContextSchema, type InvoiceWorkWorkingContext } from '../../contracts/src/personal-context.ts';
import { createDurableProductTools, projectDurableToolFeedback, readDurableToolCall, rememberDurableToolCall } from './tools.ts';
import { createDurableSubagentRuntime, type ParentChildConsumption } from './subagents.ts';
import type { DurableProductToolExecution, DurableSubagentCallbacks, DurableWorkingContextQuery } from '../../contracts/src/durable-subagents.ts';
import { createDurableHistoryReader } from './history.ts';
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
  verifyWorkingContext?(identity: DurableWorkingContextQuery): Result<void> | Promise<Result<void>>;
  tools?: readonly DurableProductToolDefinition[];
  executeTool?(call: DurableProductToolExecution): Result<ToolResult<unknown>> | Promise<Result<ToolResult<unknown>>>;
  readToolResult?(call: DurableProductToolCall): Result<ToolResult<unknown> | null> | Promise<Result<ToolResult<unknown> | null>>;
  onToolFeedback?(feedback: DurableProductToolFeedback): Result<void> | Promise<Result<void>>;
  onChanged?: () => void;
  subagents?: DurableSubagentCallbacks;
  compactions?: DurableCompactionCallbacks;
};

const id = InvoiceWorkContinueRequestSchema.shape.workId;
const identitySchema = z.object({ workId: id, sessionId: id }).strict();
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
const Binding = defineDoc({ kind: 'flowmate.runtime.binding', version: 1, scope: 'conversation', history: 'latest', fork: 'initial',
  initial: (): { workId: number | null; sessionId: number | null; attemptId: number | null; requestKey: string | null } =>
    ({ workId: null, sessionId: null, attemptId: null, requestKey: null }), checkpointWhen: () => true });
type ConsumptionReceipt = DurableSubmissionQuery & { nativeSubmissionId: number; nativeEntryId: number;
  nativeTaskId: number; cutoff: number; phaseId: number; consumedAt: string };
const GenerationPhase = defineDoc({ kind: 'flowmate.runtime.generation-phase', version: 1, scope: 'task',
  initial: (): { receipt: ConsumptionReceipt | null; calls: Array<{ nativeTaskId: number; argumentsJson: string }> } =>
    ({ receipt: null, calls: [] }), checkpointWhen: () => true });
const Consumption = defineDocFamily({ kind: 'flowmate.runtime.consumption', version: 1, family: true,
  scope: 'conversation', history: 'latest', fork: 'initial', initial: (receipt: ConsumptionReceipt): ConsumptionReceipt => receipt,
  checkpointWhen: () => true });
const requestCheckpoint = z.object({ phase: z.literal('request'), cutoff: id,
  model: z.object({ provider: z.string(), modelId: z.string() }), thinkingLevel: thinkingLevelSchema.default('off') });
class ProductFailure extends Error { constructor(readonly detail: AppError) { super(detail.code); } }
const attemptIdentity = ({ workId, sessionId, attemptId }: DurableAttemptIdentity): DurableAttemptIdentity => ({ workId, sessionId, attemptId });

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

export async function createDurableRuntime(options: DurableRuntimeOptions): Promise<Result<DurableRuntimePort>> {
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
  try { harness = await Harness.open(options.storage, { models, registry,
    settings: { stream: { maxRetries: 0, transport: 'sse', deferred: false }, retry: { enabled: false }, afterFailedRun: 'keep',
      compaction: { enabled: Boolean(options.compactions) && RUNTIME_CONFIG.compaction.autoEnabled, backgroundTokens: 0,
        reserveTokens: RUNTIME_CONFIG.compaction.reserveTokens, keepRecentTokens: RUNTIME_CONFIG.compaction.keepRecentTokens } } }, context); }
  catch { return fail(appError('durable_runtime_unavailable', 'runtime', 'Durable runtime could not be opened.', true)); }
  let closed = false;
  let changes: TaskGraphWatch | undefined;
  let closeInFlight: Promise<Result<void>> | null = null;
  const close = (): Promise<Result<void>> => {
    if (closeInFlight) return closeInFlight;
    closed = true;
    closeInFlight = (async () => {
      try { await changes?.stop(); await harness.close(context); return ok(undefined); }
      catch { return fail(appError('durable_close_failed', 'runtime', 'Durable runtime close could not be confirmed.', true)); }
    })();
    return closeInFlight;
  };
  if (options.onChanged) {
    try {
      changes = await harness.watchTaskGraph(context);
      changes.start(async () => { if (!closed) options.onChanged?.(); });
    } catch { await close(); return fail(appError('durable_runtime_unavailable', 'runtime', 'Native task changes could not be observed.', true)); }
  }
  const read = async <T>(action: () => Promise<T>): Promise<T> => {
    try { return await action(); }
    catch (error) { if (!(error instanceof StorageRequestError)) void close(); throw error; }
  };
  const attempts = new Map<number, { identity: DurableAttemptIdentity; config: ProviderConfig; binding: DurableModelBinding }>();
  const phases = new Map<string, { provider: string; modelId: string }>();
  const requested = new Map<TaskId, { query: DurableSubmissionQuery; conversationId: ConversationId;
    nativeSubmissionId: number; nativeEntryId: number; cutoff: number; phaseId: number; children: ParentChildConsumption[] }>();
  let children: ReturnType<typeof createDurableSubagentRuntime>;
  let compactions: ReturnType<typeof createDurableCompactionRuntime>;
  const submitting = new Map<number, { identity: DurableAttemptIdentity;
    pending: Set<{ query: DurableSubmissionQuery; settled: Promise<void>; abort: AbortController }> }>();
  const stopping = new Map<string, Promise<Result<'stopped' | 'not-started'>> | null>();
  const scopeKey = (input: DurableAttemptIdentity) => JSON.stringify([input.workId, input.sessionId, input.attemptId]);
  const key = (input: DurableSubmissionQuery) => JSON.stringify([input.attemptId, input.requestId]);
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
    const value = schema.safeParse(raw); if (!value.success) throw Error('input_invalid'); return value.data;
  };
  const find = async (identity: DurableConversationIdentity): Promise<ConversationId | undefined> => {
    let cursor: Cursor | undefined;
    do {
      const page = await read(() => options.storage.scanConversations({}, 100, cursor, context));
      for (const record of page.items) {
        const binding = await harness.snapshot(Binding, record.id, context);
        if (!binding || binding.workId !== identity.workId && binding.sessionId !== identity.sessionId) continue;
        if (binding.workId !== identity.workId || binding.sessionId !== identity.sessionId) throw Error('state_conflict');
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
    const identity = attemptIdentity(input), query = parse(querySchema, { ...identity, requestId: input.requestId });
    const binding = await prepareBinding(input, saved);
    const registered = phases.get(key(query)); if (registered) return registered;
    const prepared = await createDurableModels(input.config, { readApiKey: config => options.readApiKey(identity, config),
      verifyModelUse: signal => withToolFeedback(query, signal, [], async () => {
        const allowed = await options.verifyModelUse(identity); if (!allowed.ok) return allowed;
        if (stopping.has(scopeKey(input))) return fail(appError('state_conflict', 'runtime', 'The attempt is stopping.'));
        return await options.verifyWorkingContext?.(query) ?? ok(undefined);
      }), reserveModelRequest: signal => withToolFeedback(query, signal, [], () => options.reserveModelRequest(identity)),
      readCompactionUse: (signal, binding) => compactions.modelUse(signal, binding),
      ...(options.readWorkingContext ? { readWorkingContext: async (native: TranscriptContext) => guard(async () => {
        const current = await lookup(query);
        if (!current || current.record.status !== 'placed' || current.record.entry === undefined) throw Error('state_conflict');
        const conversationId = current.view.nativeConversationId as ConversationId;
        const binding = await harness.snapshot(Binding, conversationId, context), live = await harness.snapshot(LiveDoc, conversationId, context);
        if (binding?.workId !== query.workId || binding.sessionId !== query.sessionId || binding.attemptId !== query.attemptId
          || !live?.run?.inputs.includes(current.record.id)) throw Error('state_conflict');
        const task = await read(() => options.storage.task(live.run!.taskId, context));
        if (!task || task.kind !== GenerationTask.definition.name || task.conversationId !== conversationId || task.abortRequested
          || task.state.status !== 'running') throw Error('state_conflict');
        const checkpoint = parse(requestCheckpoint, task.state.checkpoint);
        const model = phases.get(key(query));
        if (!model || !isDeepStrictEqual(checkpoint.model, model) || checkpoint.thinkingLevel !== current.saved?.binding.thinkingLevel)
          throw Error('state_conflict');
        const conversation = await harness.conversation(conversationId, context); if (!conversation) throw Error('storage_corrupt');
        const view = await conversation.context(context, { at: checkpoint.cutoff as EntryId });
        if (!isDeepStrictEqual(view.messages, native.messages)) throw Error('state_conflict');
        await compactions.verifyInput(query, conversationId, view, current.record.entry);
        const saved = await options.readWorkingContext!(query); if (!saved.ok) throw new ProductFailure(saved.error);
        const workingContext = parse(InvoiceWorkWorkingContextSchema, saved.data);
        if (workingContext.work.workId !== query.workId || workingContext.work.sessionId !== query.sessionId
          || workingContext.phase.attemptId !== query.attemptId || workingContext.phase.requestId !== query.requestId
          || workingContext.item.workId !== query.workId) throw Error('state_conflict');
        const projected = await compactions.projectPhase(query, conversationId, view), messages = projected.messages;
        requested.set(task.id, { query, conversationId, nativeSubmissionId: current.record.id, nativeEntryId: current.record.entry,
          cutoff: checkpoint.cutoff, phaseId: workingContext.phase.phaseId, children: await children.captureParent(query, view.entries, messages) });
        return { workingContext, ...projected };
      }) } : {}) }, binding);
    if (!prepared.ok) throw new ProductFailure(prepared.error);
    const racedPhase = phases.get(key(query)); if (racedPhase) return racedPhase;
    const source = prepared.data.models, canonical = source.getModel(prepared.data.modelRef.provider, prepared.data.modelRef.modelId);
    const provider = source.getProvider(prepared.data.modelRef.provider);
    if (!canonical || !provider) throw Error('storage_corrupt');
    const alias = `flowmate-attempt-${input.attemptId}-phase-${encodeURIComponent(input.requestId)}`;
    models.setProvider({ ...provider, id: alias, getModels: () => [{ ...canonical, provider: alias }],
      getAllModels: () => [{ ...canonical, provider: alias }],
      stream: (_model, messages, request) => source.stream(canonical, messages, request),
      streamSimple: (_model, messages, request) => source.streamSimple(canonical, messages, request) });
    const ref = { provider: alias, modelId: canonical.id }; phases.set(key(query), ref); return ref;
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
      return { binding, text: binding.inputText ?? text };
    }
    const inbox = await tx.doc(InboxDoc, conversationId), item = inbox.items.find(item => item.id === record.id);
    if (!item || item.mode === 'write' || typeof item.content !== 'string') throw Error('storage_corrupt');
    const binding = parse(entryIdentity, item.entry?.data);
    return { binding, text: binding.inputText ?? item.content };
  };
  const lookup = async (raw: DurableSubmissionQuery) => {
    const input = parse(querySchema, raw), conversationId = await find(input);
    if (conversationId === undefined) return null;
    return read(() => harness.commit(async tx => {
      const record = await tx.submissionByRequest(conversationId, key(input)); if (!record) return null;
      if (record.type !== 'input' || record.conversationId !== conversationId || record.requestId !== key(input)) throw Error('storage_corrupt');
      // Pi removes a withdrawn queued input's Inbox item; its exact native request key still identifies its receipt.
      const saved = record.status === 'unanswered' && record.entry === undefined ? null : await original(conversationId, record, tx);
      if (saved && (saved.binding.workId !== input.workId || saved.binding.sessionId !== input.sessionId || saved.binding.attemptId !== input.attemptId
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
  const currentAttempt = async (input: DurableAttemptIdentity) => {
    const conversationId = await find(input); if (conversationId === undefined) throw Error('session_not_found');
    const binding = await harness.snapshot(Binding, conversationId, context);
    if (binding?.attemptId !== input.attemptId || !binding.requestKey) throw Error('state_conflict');
    const record = await read(() => options.storage.submissionByRequest(conversationId, binding.requestKey!, context));
    if (!record || record.type !== 'input') throw Error('state_conflict');
    return { conversationId, record };
  };
  const assertAttemptOwner = (identity: DurableAttemptIdentity) => {
    const prepared = attempts.get(identity.attemptId), inFlight = submitting.get(identity.attemptId);
    if (prepared && !isDeepStrictEqual(prepared.identity, identity) || inFlight && !isDeepStrictEqual(inFlight.identity, identity))
      throw Error('state_conflict');
  };
  const stopOriginalScope = async (identity: DurableAttemptIdentity): Promise<'stopped' | 'not-started'> => {
    let conversationId: ConversationId | undefined, cursor: Cursor | undefined;
    do {
      const page = await read(() => options.storage.scanConversations({}, 100, cursor, context));
      for (const conversation of page.items) {
        const binding = await harness.snapshot(Binding, conversation.id, context);
        if (!binding || binding.workId === null || binding.sessionId === null) continue;
        if (binding.attemptId === identity.attemptId && (binding.workId !== identity.workId || binding.sessionId !== identity.sessionId))
          throw Error('state_conflict');
        if (binding.workId !== identity.workId && binding.sessionId !== identity.sessionId) continue;
        if (binding.workId !== identity.workId || binding.sessionId !== identity.sessionId
          || conversationId !== undefined && conversationId !== conversation.id) throw Error('state_conflict');
        conversationId = conversation.id;
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
        if (binding.workId !== identity.workId || binding.sessionId !== identity.sessionId || record.conversationId !== conversationId)
          throw Error('state_conflict');
        const query = { ...identity, requestId: request[1] };
        if (record.requestId !== key(query)) throw Error('storage_corrupt');
        if (record.entry !== undefined || record.status !== 'unanswered') {
          const saved = await read(() => harness.commit(tx => original(record.conversationId, record, tx), context));
          if (!isDeepStrictEqual(attemptIdentity(saved.binding), identity) || saved.binding.requestId !== request[1]) throw Error('storage_corrupt');
        }
        created = true;
      }
      cursor = page.next;
    } while (cursor);
    if (conversationId === undefined) return 'not-started';
    const nativeId = conversationId;
    if (!created) {
      if (await read(() => harness.commit(tx => hasLiveOwnedTasks(tx, nativeId), context))) throw Error('state_conflict');
      return 'not-started';
    }
    const binding = await harness.snapshot(Binding, nativeId, context);
    if (binding?.attemptId !== identity.attemptId) throw Error('state_conflict');
    const conversation = await harness.conversation(nativeId, context); if (!conversation) throw Error('storage_corrupt');
    await conversation.abort(context, { background: true });
    const summaries = await compactions.stopAttempt(identity); if (!summaries.ok) throw new ProductFailure(summaries.error);
    if (await read(() => harness.commit(tx => hasLiveOwnedTasks(tx, nativeId), context))) throw Error('state_conflict');
    return 'stopped';
  };
  const assertSchedulable = async () => {
    await children.restoreAll();
    const summaries = await compactions.restoreAll(); if (!summaries.ok) throw new ProductFailure(summaries.error);
    const verified = new Set<string>();
    const verifyPhase = async (query: DurableSubmissionQuery) => {
      if (verified.has(key(query))) return;
      if (!phases.has(key(query))) throw new ProductFailure(appError('provider_model_configuration_unavailable', 'input',
        'Every original phase model binding must be restored before scheduling.'));
      let allowed = await options.verifyModelUse(attemptIdentity(query));
      if (!allowed.ok && allowed.error.code === 'invoice_work_budget_unknown' && options.verifySchedulingUse) {
        const pending = await reconcileToolFeedback(query, undefined, [], false);
        allowed = await options.verifyModelUse(attemptIdentity(query));
        if (!allowed.ok && allowed.error.code === 'invoice_work_budget_unknown' && pending.length)
          allowed = await options.verifySchedulingUse(attemptIdentity(query), pending);
      }
      if (!allowed.ok) throw new ProductFailure(allowed.error);
      const checked = await options.verifyWorkingContext?.(query); if (checked && !checked.ok) throw new ProductFailure(checked.error);
      verified.add(key(query));
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
            return current.status === 'queued' || current.status === 'placed' ? original(record.conversationId, current, tx) : null;
          }, context));
          if (!saved) continue;
          const query = parse(querySchema, { ...attemptIdentity(saved.binding), requestId: saved.binding.requestId });
          await verifyPhase(query);
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
          return { workId: binding.workId, sessionId: binding.sessionId, attemptId, requestId };
        }, context));
        if (query) await verifyPhase(query);
      }
      cursor = page.next;
    } while (cursor);
  };
  const resolveToolCall = async (nativeTaskId: TaskId, nativeConversationId: ConversationId, feedback = false): Promise<DurableProductToolCall> => {
    if (await children.isChild(nativeConversationId)) return children.resolveToolCall(nativeTaskId, nativeConversationId, feedback);
    if (feedback) {
      const call = await read(() => readDurableToolCall(harness, options.storage, nativeTaskId, nativeConversationId, context));
      if (!call || call.child) throw Error('state_conflict');
      const query = parse(querySchema, { ...attemptIdentity(call), requestId: call.requestId });
      const receipt = await read(() => options.storage.submissionByRequest(nativeConversationId, key(query), context));
      if (receipt?.type !== 'input' || receipt.entry === undefined) throw Error('state_conflict');
      const saved = await read(() => harness.commit(tx => original(nativeConversationId, receipt, tx), context));
      if (!isDeepStrictEqual(parse(querySchema, { ...attemptIdentity(saved.binding), requestId: saved.binding.requestId }), query)) throw Error('state_conflict');
      const task = await read(() => options.storage.task(nativeTaskId, context));
      const input = parse(z.object({ assistant: id }), task?.input);
      const conversation = await harness.conversation(nativeConversationId, context); if (!conversation) throw Error('storage_corrupt');
      const view = await conversation.context(context, { at: input.assistant as EntryId });
      await compactions.verifyInput(query, nativeConversationId, view, receipt.entry);
      return call;
    }
    return read(() => harness.commit(async tx => {
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
      const query = parse(querySchema, { ...attemptIdentity(selected), requestId: selected.requestId });
      const binding = await tx.doc(Binding, nativeConversationId), live = await tx.doc(LiveDoc, nativeConversationId);
      const submission = await tx.submissionByRequest(nativeConversationId, key(query));
      if (!submission || submission.id !== selected.nativeSubmissionId || submission.entry !== selected.nativeEntryId
        || binding.workId !== query.workId || binding.sessionId !== query.sessionId || binding.attemptId !== query.attemptId
        || !live.run?.inputs.includes(submission.id) || live.run.taskId !== generation.id) throw Error('state_conflict');
      const saved = await original(nativeConversationId, submission, tx);
      if (!isDeepStrictEqual(attemptIdentity(saved.binding), attemptIdentity(query)) || saved.binding.requestId !== query.requestId)
        throw Error('state_conflict');
      const assistant = await tx.entry(input.assistant as EntryId), message = assistant?.model?.[0];
      const call = message?.role === 'assistant' ? message.content.find(block => block.type === 'toolCall' && block.id === input.callId) : undefined;
      if (assistant?.conversationId !== nativeConversationId || assistant.kind !== AssistantEntry.kind || assistant.byTaskId !== task.owner || call?.type !== 'toolCall')
        throw Error('storage_corrupt');
      const existing = phase.calls.find(item => item.nativeTaskId === nativeTaskId);
      let args: unknown = existing ? JSON.parse(existing.argumentsJson) : call.arguments;
      if ('checkpoint' in task.state) {
        args = parse(z.object({ phase: z.literal('execute'), arguments: z.unknown() }), task.state.checkpoint).arguments;
        if (existing && !isDeepStrictEqual(JSON.parse(existing.argumentsJson), args)) throw Error('storage_corrupt');
        if (!existing) phase.calls.push({ nativeTaskId, argumentsJson: JSON.stringify(args) });
      }
      return { ...query, nativeConversationId, nativeTaskId, nativeToolCallId: input.callId, name: call.name, arguments: args };
    }, context));
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
  compactions = createDurableCompactionRuntime({ harness, storage: options.storage, models, registry, callbacks: options.compactions,
    read, isClosed: () => closed, isStopping: query => stopping.has(scopeKey(query)), hasLiveOwnedTasks,
    beforeSchedule: () => assertSchedulable(),
    resolvePhase: async input => {
      if (input.child) return children.resolvePhase(input.child);
      const current = await lookup({ ...attemptIdentity(input), requestId: input.requestId }); if (!current?.saved || current.record.entry === undefined) throw Error('state_conflict');
      const agent = await harness.snapshot(AgentDoc, current.view.nativeConversationId as ConversationId, context); if (!agent?.model) throw Error('state_conflict');
      return { workId: input.workId, sessionId: input.sessionId, attemptId: input.attemptId, requestId: input.requestId,
        nativeConversationId: current.view.nativeConversationId, nativeSubmissionId: current.record.id, nativeEntryId: current.record.entry, model: agent.model };
    },
    prepareModel: async (plan, expected) => {
      if (plan.child) { if (!models.getModel(expected.provider, expected.modelId)) throw Error('state_conflict'); return; }
      const ref = await register({ workId: plan.workId, sessionId: plan.sessionId, attemptId: plan.attemptId, requestId: plan.requestId,
        config: plan.binding.configuration }, plan.binding);
      if (!isDeepStrictEqual(ref, expected)) throw Error('state_conflict');
    },
    resolveAutomatic: async (taskId, conversationId, reason, tail) => {
      const task = await read(() => options.storage.task(taskId, context)), live = await harness.snapshot(LiveDoc, conversationId, context);
      if (!task?.owner || live?.run?.taskId !== task.owner) throw Error('state_conflict');
      if (await children.isChild(conversationId)) {
        const child = await children.identityForConversation(conversationId); if (!child) throw Error('state_conflict');
        return { workId: child.workId, sessionId: child.sessionId, attemptId: child.attemptId, requestId: child.requestId, child,
          operationId: `durable-compaction:${taskId}`, reason, expectedTailEntryId: tail, instructions: null };
      }
      let selected: DurableSubmissionQuery | null = null;
      for (const submissionId of live.run.inputs) {
        const record = await read(() => options.storage.submission(submissionId, context));
        if (record?.type !== 'input' || record.entry === undefined) throw Error('state_conflict');
        const entry = (await read(() => options.storage.entry(record.entry!, context)))?.entry;
        if (entry?.kind !== 'flowmate.input' || selected) throw Error('state_conflict');
        const raw = parse(entryIdentity, entry.data); selected = { workId: raw.workId, sessionId: raw.sessionId, attemptId: raw.attemptId, requestId: raw.requestId };
      }
      if (!selected) throw Error('state_conflict');
      return { ...selected, operationId: `durable-compaction:${taskId}`, reason, expectedTailEntryId: tail, instructions: null };
    },
  });
  children = createDurableSubagentRuntime({ harness, storage: options.storage, models, registry, callbacks: options.subagents,
    isClosed: () => closed, isStopping: identity => stopping.has(scopeKey(identity)), readApiKey: options.readApiKey,
    readWorkingContext: options.readWorkingContext, read, hasLiveOwnedTasks, withToolFeedback, compactions });
  const history = createDurableHistoryReader({ storage: options.storage, read, resolveOwner: async input => ({
    owner: { runtimeKind: 'durable', workId: input.workId, sessionId: input.child?.childSessionId ?? input.sessionId,
      childRunId: input.child?.childRunId ?? null },
    conversationId: input.child ? await children.resolveConversationId(input.child) : await find(input),
  }) });
  if (options.tools?.length) registry.install({ name: 'flowmate-product-tools', tools: createDurableProductTools({ definitions: options.tools,
    resolve: async (api: ToolExecutionApi) => resolveToolCall(api.taskId, api.conversationId),
    verify: async (call, signal) => {
      if (call.child) return children.verifyTool(call, signal);
      return withToolFeedback(call, signal, [call.nativeTaskId], async () => {
      if (closed || stopping.has(scopeKey(call))) return fail(appError('state_conflict', 'runtime', 'The original tool attempt is stopping.'));
      const query = parse(querySchema, { ...attemptIdentity(call), requestId: call.requestId });
      const checked = await options.verifyWorkingContext!(query); if (!checked.ok) return checked;
      const saved = await options.readWorkingContext!(query); if (!saved.ok) return saved;
      const working = parse(InvoiceWorkWorkingContextSchema, saved.data);
      if (working.work.workId !== call.workId || working.work.sessionId !== call.sessionId || working.phase.attemptId !== call.attemptId
        || working.phase.requestId !== call.requestId || !working.actions.tools.includes(call.name))
        return fail(appError('tool_not_allowed', 'tool', 'The tool is outside its original phase tool set.'));
      return options.verifyModelUse(attemptIdentity(call));
      });
    }, execute: async call => {
      const { signal, nativeDelegate: _nativeDelegate, ...identity } = call;
      await rememberDurableToolCall(harness, options.storage, identity, withAbortSignal(signal, context));
      return options.executeTool!(call);
    }, read: call => options.readToolResult!(call),
    ...(options.subagents ? { delegate: children.invoker } : {}) }) });
  registry.install({ name: 'flowmate-phase-consumption', hooks: [hook(GenerationTask, { afterResponse: async (message, api) => {
    const selected = requested.get(api.taskId); requested.delete(api.taskId);
    if (!selected || selected.conversationId !== api.conversationId || !['stop', 'length', 'toolUse'].includes(message.stopReason)) return;
    await harness.commit(async tx => {
      const submission = await tx.submissionByRequest(api.conversationId, key(selected.query)), task = await tx.task(api.taskId);
      if (!submission || submission.id !== selected.nativeSubmissionId || submission.entry !== selected.nativeEntryId
        || task?.kind !== GenerationTask.definition.name || task.conversationId !== api.conversationId) throw Error('storage_corrupt');
      const receipt: ConsumptionReceipt = { ...selected.query, nativeSubmissionId: selected.nativeSubmissionId,
        nativeEntryId: selected.nativeEntryId, nativeTaskId: api.taskId, cutoff: selected.cutoff, phaseId: selected.phaseId,
        consumedAt: new Date().toISOString() };
      await tx.doc(Consumption, api.conversationId, key(selected.query), receipt);
      (await tx.doc(GenerationPhase, api.taskId)).receipt = receipt;
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
  const port: DurableRuntimePort = {
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
            return record.id;
          }
          cursor = page.next;
        } while (cursor);
        const record = await tx.createConversation({ ownership: { kind: 'ownerless' } });
        const binding = await tx.doc(Binding, record.id); binding.workId = input.workId; binding.sessionId = input.sessionId;
        return record.id;
      }, context);
      return { ...input, nativeConversationId: conversationId };
    }),
    prepareModel: raw => guard(async () => prepareBinding(parse(preparationSchema, raw))),
    restoreModel: raw => guard(async () => {
      const input = parse(restoreSchema, raw), current = await lookup({ ...attemptIdentity(input), requestId: input.requestId });
      if (!current?.saved) throw Error('state_conflict');
      const config = input.binding.configuration;
      if (current.saved.binding.configName !== config.name || current.saved.binding.configRevision !== config.revision) throw Error('state_conflict');
      const checked = readDurableModelBinding(input.binding); if (!checked.ok) throw new ProductFailure(checked.error);
      const expected = { provider: `flowmate-attempt-${input.attemptId}-phase-${encodeURIComponent(input.requestId)}`, modelId: checked.data.selected.id };
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
      await children.reconcileParentConsumed(input);
    }),
    submit: raw => guard(async () => {
      const input = parse(inputSchema, raw), query = { workId: input.workId, sessionId: input.sessionId, attemptId: input.attemptId, requestId: input.requestId };
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
      let content = input.text, instructions: string | undefined, scopedTools: readonly ToolRegistration[] | undefined;
      if (options.readWorkingContext) {
        const saved = await options.readWorkingContext(query); if (!saved.ok) throw new ProductFailure(saved.error);
        const working = parse(InvoiceWorkWorkingContextSchema, saved.data);
        if (working.work.workId !== query.workId || working.work.sessionId !== query.sessionId || working.phase.attemptId !== query.attemptId
          || working.phase.requestId !== query.requestId) throw Error('state_conflict');
        const formatted = formatInvoiceWorkContext(working), rendered = formatInvoiceWorkInstructions(working.instructions);
        if (!formatted.ok) throw new ProductFailure(formatted.error); if (!rendered.ok) throw new ProductFailure(rendered.error);
        content = formatted.data; instructions = rendered.data;
        scopedTools = registry.snapshot().tools().map(item => item.tool).filter(tool => working.actions.tools.includes(tool.name));
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
          ...(scopedTools === undefined ? {} : { tools: scopedTools, modelTools: scopedTools }) });
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
          || binding.workId !== input.workId || binding.sessionId !== input.sessionId) throw Error('storage_corrupt');
        if (record.status === 'queued' || binding.attemptId !== input.attemptId) return { record, execution: 'unknown' as const };
        const live = await tx.doc(LiveDoc, conversationId);
        return { record, execution: live.run || await hasLiveOwnedTasks(tx, conversationId) ? 'active' as const
          : record.status === 'done' || record.status === 'unanswered' ? 'closed' as const : 'unknown' as const };
      }, context);
      if (!observed) return null;
      if (consumed && (consumed.workId !== input.workId || consumed.sessionId !== input.sessionId || consumed.attemptId !== input.attemptId
        || consumed.requestId !== input.requestId || consumed.nativeSubmissionId !== observed.record.id
        || consumed.nativeEntryId !== observed.record.entry)) throw Error('storage_corrupt');
      return { ...input, nativeConversationId: conversationId, nativeSubmissionId: observed.record.id,
        nativeEntryId: observed.record.entry ?? null, status: observed.record.status,
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
      const input = parse(attemptSchema, raw), current = await currentAttempt(input);
      if (stopping.has(scopeKey(input)) || current.record.status === 'unanswered'
        || current.record.status === 'done' && !await read(() => harness.commit(tx => hasLiveOwnedTasks(tx, current.conversationId), context)))
        throw Error('state_conflict');
      if (!attempts.has(input.attemptId)) throw new ProductFailure(appError('provider_model_configuration_unavailable', 'input', 'Original attempt model binding is unavailable.'));
      await assertSchedulable();
      let allowed = await options.verifyModelUse(input);
      if (!allowed.ok && allowed.error.code === 'invoice_work_budget_unknown' && options.verifySchedulingUse) {
        const [attemptId, requestId] = parse(z.tuple([id, InvoiceWorkContinueRequestSchema.shape.requestId]), JSON.parse(current.record.requestId!));
        if (attemptId !== input.attemptId) throw Error('state_conflict');
        allowed = await withToolFeedback({ ...input, requestId }, undefined, [], () => options.verifyModelUse(input));
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
      return { workId: input.workId, sessionId: input.sessionId, nativeConversationId: conversationId, entries,
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
  return ok(port);
}
