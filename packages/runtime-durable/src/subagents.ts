import { BACKGROUND_CONTEXT, withAbortSignal, type Context } from '@earendil-works/chord/context';
import { getSupportedThinkingLevels, type AssistantMessage, type Message, type MutableModels, type TranscriptContext } from '@earendil-works/pi-ai';
import { AgentDoc, AssistantEntry, configure, defineDoc, GenerationTask, hook, LiveDoc, ToolResultEntry, ToolTask,
  type ConversationId, type ConversationRecord, type Cursor, type EntryId, type EntryRecord, type Harness, type HookApi,
  type Registry, type Storage, type TaskId, type ToolExecutionApi, type Tx } from '@earendil-works/pi-durable';
import { appError, fail, ok, PersonalAgentConfigurationSchema, SUBAGENT_ROLE, SUBAGENT_TOOL_NAMES,
  type AppError, type DurableAttemptIdentity, type DurableProductToolCall, type DurableSubagentCallbacks,
  type DurableSubagentIdentity, type DurableSubagentInvoker, type DurableSubagentObservation, type DurableSubagentPlan,
  type DurableSubmissionQuery, type DurableWorkingContextQuery, type InvoiceWorkWorkingContext, type ProviderConfig, type Result } from '@flowmate/contracts';
import { InvoiceWorkWorkingContextSchema } from '../../contracts/src/personal-context.ts';
import { isDeepStrictEqual } from 'node:util';
import { z } from 'zod';
import { createDurableModels, durableModelBindingSchema } from './models.ts';
import { readDurableToolCall } from './tools.ts';
import { formatInvoiceWorkContext } from './context.ts';
import type { createDurableCompactionRuntime } from './compaction.ts';

const id = z.number().int().positive().max(Number.MAX_SAFE_INTEGER), requestId = z.string().min(1).max(128);
const identitySchema = z.object({ workId: id, sessionId: id, attemptId: id, requestId,
  childRunId: id, childSessionId: id, originToolCallId: id, nativeToolTaskId: id }).strict();
const thinking = PersonalAgentConfigurationSchema.unwrap().innerType().shape.thinkingLevel;
const planSchema = identitySchema.extend({ role: z.literal(SUBAGENT_ROLE), binding: durableModelBindingSchema, thinkingLevel: thinking,
  prompt: z.string().min(1).max(65000), systemPrompt: z.string().min(1).max(65000), allowedTools: z.array(z.string().min(1)).max(64) }).strict();
type ChildState = { planJson: string | null; consumedAt: string | null; parentToolResultEntryId: number | null;
  parentModelTaskId: number | null; parentModelReceivedAt: string | null };
const Child = defineDoc({ kind: 'flowmate.runtime.child', version: 1, scope: 'conversation', history: 'latest', fork: 'initial',
  initial: (): ChildState => ({ planJson: null, consumedAt: null, parentToolResultEntryId: null, parentModelTaskId: null, parentModelReceivedAt: null }),
  checkpointWhen: () => true });
const ChildGeneration = defineDoc({ kind: 'flowmate.runtime.child-generation', version: 1, scope: 'task',
  initial: (): { identity: DurableSubagentIdentity | null; submissionId: number | null; entryId: number | null;
    calls: Array<{ taskId: number; argumentsJson: string }> } =>
    ({ identity: null, submissionId: null, entryId: null, calls: [] }), checkpointWhen: () => true });
export type ParentChildConsumption = { identity: DurableSubagentIdentity; entryId: number };
type ChildRecord = { conversation: ConversationRecord; state: Readonly<ChildState>; plan: DurableSubagentPlan };
class ChildFailure extends Error { constructor(readonly fact: AppError) { super(fact.code); } }
const need = <T>(result: Result<T>): T => { if (!result.ok) throw new ChildFailure(result.error); return result.data; };
const parent = ({ workId, sessionId, attemptId, requestId }: DurableSubmissionQuery): DurableSubmissionQuery => ({ workId, sessionId, attemptId, requestId });
const identity = (plan: DurableSubagentIdentity): DurableSubagentIdentity => identitySchema.parse({ ...parent(plan), childRunId: plan.childRunId,
  childSessionId: plan.childSessionId, originToolCallId: plan.originToolCallId, nativeToolTaskId: plan.nativeToolTaskId });
const childOwner = (plan: DurableSubagentIdentity) => ({ childRunId: plan.childRunId, childSessionId: plan.childSessionId, originToolCallId: plan.originToolCallId });
const requestKey = (plan: DurableSubagentIdentity) => `durable-child:${plan.childRunId}`;

export type DurableSubagentRuntimeOptions = {
  harness: Harness; storage: Storage; models: MutableModels; registry: Registry; callbacks?: DurableSubagentCallbacks;
  isClosed(): boolean;
  isStopping(identity: DurableAttemptIdentity): boolean;
  readApiKey(identity: DurableAttemptIdentity, config: ProviderConfig): string | undefined | Promise<string | undefined>;
  readWorkingContext?(query: DurableWorkingContextQuery): Result<InvoiceWorkWorkingContext> | Promise<Result<InvoiceWorkWorkingContext>>;
  read<T>(action: () => Promise<T>): Promise<T>;
  hasLiveOwnedTasks(tx: Tx, conversationId: ConversationId): Promise<boolean>;
  withToolFeedback(query: DurableSubmissionQuery, signal: AbortSignal | undefined, excluded: readonly number[],
    verify: () => Result<void> | Promise<Result<void>>): Promise<Result<void>>;
  compactions: ReturnType<typeof createDurableCompactionRuntime>;
};

export function createDurableSubagentRuntime(options: DurableSubagentRuntimeOptions) {
  const { harness, storage } = options, context = BACKGROUND_CONTEXT;
  const refs = new Map<number, { plan: DurableSubagentPlan; provider: string; modelId: string }>();
  const creating = new Set<number>();
  const invoking = new Set<number>();
  const requested = new Map<TaskId, { identity: DurableSubagentIdentity; conversationId: ConversationId; submissionId: number; entryId: number }>();
  const check = (plan: DurableSubagentIdentity, signal?: AbortSignal) => {
    signal?.throwIfAborted(); if (options.isClosed() || options.isStopping(plan)) throw Error('state_conflict');
  };
  const suspended = () => appError('durable_delegation_suspended', 'runtime', 'The original delegation was interrupted by runtime close and remains recoverable.', true);
  const safe = async <T>(action: () => Promise<T>, interrupted?: () => boolean): Promise<Result<T>> => {
    try { return ok(await action()); }
    catch (error) { return fail(interrupted?.() ? suspended() : error instanceof ChildFailure ? error.fact : appError(error instanceof Error &&
      ['input_invalid', 'state_conflict', 'storage_corrupt'].includes(error.message) ? error.message : 'durable_subagent_failed',
    'runtime', 'The original native child facts could not be confirmed.', true)); }
  };
  const owned = async (taskId: number): Promise<ConversationRecord[]> => {
    const records: ConversationRecord[] = []; let cursor: Cursor | undefined;
    do { const page = await options.read(() => storage.scanConversations({ ownerTaskId: taskId as TaskId }, 100, cursor, context));
      records.push(...page.items); cursor = page.next; } while (cursor);
    return records;
  };
  const locate = async (source: DurableSubagentIdentity): Promise<ChildRecord | null> => {
    const input = identity(source), conversations = await owned(input.nativeToolTaskId);
    if (conversations.length > 1) throw Error('storage_corrupt');
    const conversation = conversations[0]; if (!conversation) return null;
    const state = await harness.snapshot(Child, conversation.id, context);
    if (!state?.planJson) throw Error('storage_corrupt');
    const plan = planSchema.parse(JSON.parse(state.planJson));
    if (!isDeepStrictEqual(identity(plan), input)) throw Error('state_conflict');
    return { conversation, state, plan };
  };
  const creator = async (input: DurableSubagentIdentity) => {
    const task = await options.read(() => storage.task(input.nativeToolTaskId as TaskId, context));
    if (!task) return null;
    if (task.kind !== ToolTask.definition.name || task.owner === undefined) throw Error('state_conflict');
    const raw = z.object({ kind: z.literal('model'), assistant: id, callId: z.string() }).strict().parse(task.input);
    const assistant = (await options.read(() => storage.entry(raw.assistant as EntryId, context)))?.entry;
    const message = assistant?.model?.[0], call = message?.role === 'assistant'
      ? message.content.find(block => block.type === 'toolCall' && block.id === raw.callId && block.name === 'Agent') : undefined;
    if (!assistant || assistant.conversationId !== task.conversationId || assistant.byTaskId !== task.owner || !call) throw Error('state_conflict');
    const receipt = await options.read(() => storage.submissionByRequest(task.conversationId, JSON.stringify([input.attemptId, input.requestId]), context));
    if (receipt?.type !== 'input' || receipt.entry === undefined) throw Error('state_conflict');
    const entry = (await options.read(() => storage.entry(receipt.entry!, context)))?.entry;
    if (entry?.kind !== 'flowmate.input' || !isDeepStrictEqual(parent(z.object({ workId: id, sessionId: id, attemptId: id, requestId }).parse(entry.data)), parent(input)))
      throw Error('state_conflict');
    const conversation = await harness.conversation(task.conversationId, context); if (!conversation) throw Error('storage_corrupt');
    const view = await conversation.context(context, { at: assistant.id });
    await options.compactions.verifyInput(parent(input), task.conversationId, view, receipt.entry);
    return task;
  };
  const observe = (raw: DurableSubagentIdentity): Promise<Result<DurableSubagentObservation | null>> => safe(async () => {
    const input = identity(raw);
    if (options.isClosed()) throw new ChildFailure(options.isStopping(input)
      ? appError('durable_runtime_closed', 'runtime', 'Native runtime is closed.') : suspended());
    const task = await creator(input); if (!task) return null;
    const child = await locate(input);
    if (!child) {
      const stopped = task.state.status === 'terminal' && options.isStopping(input)
        && !invoking.has(input.childRunId) && !creating.has(input.childRunId);
      return { ...input, creatorExecution: task.state.status === 'terminal' && !invoking.has(input.childRunId) && !creating.has(input.childRunId) ? 'closed' : 'active',
        creation: stopped ? 'not-started' : 'unknown', nativeConversationId: null, nativeSubmissionId: null,
        status: null, answer: null, reason: null, consumedAt: null, execution: stopped ? 'closed' : 'unknown',
        parentToolResultEntryId: null, parentModelTaskId: null, parentModelReceivedAt: null };
    }
    const record = await options.read(() => storage.submissionByRequest(child.conversation.id, requestKey(input), context));
    if (record && record.type !== 'input') throw Error('storage_corrupt');
    const live = await options.read(() => harness.commit(tx => options.hasLiveOwnedTasks(tx, child.conversation.id), context));
    let answer: string | null = null;
    if (record?.status === 'done') {
      const entry = (await options.read(() => storage.entry(record.answer, context)))?.entry;
      const message = entry?.model?.[0];
      if (entry?.kind !== AssistantEntry.kind || entry.conversationId !== child.conversation.id || message?.role !== 'assistant') throw Error('storage_corrupt');
      answer = message.content.filter(block => block.type === 'text').map(block => block.text).join('');
    }
    return { ...input, creatorExecution: task.state.status === 'terminal' && !invoking.has(input.childRunId) && !creating.has(input.childRunId) ? 'closed' : 'active',
      creation: 'created', nativeConversationId: child.conversation.id, nativeSubmissionId: record?.id ?? null,
      status: record?.status ?? null, answer, reason: record?.status === 'unanswered' ? record.reason : null, consumedAt: child.state.consumedAt,
      execution: live ? 'active' : record?.status === 'done' || record?.status === 'unanswered'
        || task.state.status === 'terminal' && options.isStopping(input) ? 'closed' : 'unknown',
      parentToolResultEntryId: child.state.parentToolResultEntryId, parentModelTaskId: child.state.parentModelTaskId,
      parentModelReceivedAt: child.state.parentModelReceivedAt };
  });
  const verify = async (plan: DurableSubagentIdentity, signal?: AbortSignal, toolTaskId?: number) => {
    check(plan, signal); if (!options.callbacks) throw Error('state_conflict');
    need(await options.withToolFeedback(plan, signal, [plan.nativeToolTaskId, ...(toolTaskId === undefined ? [] : [toolTaskId])],
      () => options.callbacks!.verify(identity(plan)))); check(plan, signal);
  };
  const register = async (raw: DurableSubagentPlan) => {
    const plan = planSchema.parse(raw), existing = refs.get(plan.childRunId);
    if (existing) { if (!isDeepStrictEqual(existing.plan, plan)) throw Error('state_conflict'); return existing; }
    if (!options.callbacks || plan.allowedTools.some(name => !(SUBAGENT_TOOL_NAMES as readonly string[]).includes(name))) throw Error('state_conflict');
    const source = need(await createDurableModels(plan.binding.configuration, {
      readApiKey: config => options.readApiKey({ workId: plan.workId, sessionId: plan.sessionId, attemptId: plan.attemptId }, config),
      verifyModelUse: async signal => safe(async () => verify(plan, signal)),
      readCompactionUse: (signal, binding) => options.compactions.modelUse(signal, binding),
      reserveModelRequest: signal => options.withToolFeedback(plan, signal, [plan.nativeToolTaskId],
        () => options.callbacks!.reserveModelRequest(identity(plan))),
      readWorkingContext: (native, signal) => safe(async () => {
        await verify(plan, signal);
        const child = await locate(plan); if (!child) throw Error('state_conflict');
        const live = await harness.snapshot(LiveDoc, child.conversation.id, context), task = live?.run ? await options.read(() => storage.task(live.run!.taskId, context)) : null;
        if (!task || task.kind !== GenerationTask.definition.name || task.abortRequested || task.state.status !== 'running') throw Error('state_conflict');
        const point = z.object({ phase: z.literal('request'), cutoff: id, model: z.object({ provider: z.string(), modelId: z.string() }), thinkingLevel: thinking })
          .parse(task.state.checkpoint);
        const ref = refs.get(plan.childRunId);
        if (!ref || point.model.provider !== ref.provider || point.model.modelId !== ref.modelId || point.thinkingLevel !== plan.thinkingLevel) throw Error('state_conflict');
        const record = await options.read(() => storage.submissionByRequest(child.conversation.id, requestKey(plan), context));
        if (record?.type !== 'input' || record.status !== 'placed' || record.entry === undefined || !live?.run?.inputs.includes(record.id)) throw Error('state_conflict');
        const conversation = await harness.conversation(child.conversation.id, context); if (!conversation) throw Error('storage_corrupt');
        const view = await conversation.context(context, { at: point.cutoff as EntryId });
        const input = (await options.read(() => storage.entry(record.entry!, context)))?.entry;
        if (!isDeepStrictEqual(view.messages, native.messages) || input?.kind !== 'flowmate.child-input'
          || !isDeepStrictEqual(identity(identitySchema.parse(input.data)), identity(plan))) throw Error('state_conflict');
        await options.compactions.verifyInput(parent(plan), child.conversation.id, view, record.entry);
        const saved = need(await options.readWorkingContext!({ ...parent(plan), child: childOwner(plan) }));
        const workingContext = InvoiceWorkWorkingContextSchema.parse(saved);
        if (workingContext.work.workId !== plan.workId || workingContext.work.sessionId !== plan.sessionId
          || workingContext.phase.attemptId !== plan.attemptId || workingContext.phase.requestId !== plan.requestId
          || workingContext.instructions?.role !== SUBAGENT_ROLE || workingContext.delegation?.childRunId !== plan.childRunId
          || workingContext.delegation.childSessionId !== plan.childSessionId || workingContext.delegation.originToolCallId !== plan.originToolCallId
          || workingContext.delegation.prompt !== plan.prompt || workingContext.actions.tools.some(name => !plan.allowedTools.includes(name))) throw Error('state_conflict');
        requested.set(task.id, { identity: identity(plan), conversationId: child.conversation.id, submissionId: record.id, entryId: record.entry });
        return { workingContext, systemPrompt: `${plan.systemPrompt}\n\nFrozen child instructions:\n${JSON.stringify(workingContext.instructions)}`,
          ...await options.compactions.projectPhase(parent(plan), child.conversation.id, view) };
      }),
    }, plan.binding));
    const model = source.models.getModel(source.modelRef.provider, source.modelRef.modelId), provider = source.models.getProvider(source.modelRef.provider);
    if (!model || !provider || !getSupportedThinkingLevels(model).includes(plan.thinkingLevel)) throw Error('state_conflict');
    const ref = { plan: structuredClone(plan), provider: `flowmate-child-${plan.childRunId}`, modelId: model.id };
    options.models.setProvider({ ...provider, id: ref.provider, getModels: () => [{ ...model, provider: ref.provider }], getAllModels: () => [{ ...model, provider: ref.provider }],
      stream: (_model, messages, request) => source.models.stream(model, messages, request), streamSimple: (_model, messages, request) => source.models.streamSimple(model, messages, request) });
    refs.set(plan.childRunId, ref); return ref;
  };
  const isChild = async (conversationId: ConversationId) => Boolean((await harness.snapshot(Child, conversationId, context))?.planJson);
  const restoreAll = async () => {
    let cursor: Cursor | undefined;
    do {
      const page = await options.read(() => storage.scanConversations({}, 100, cursor, context));
      for (const conversation of page.items) {
        const state = await harness.snapshot(Child, conversation.id, context); if (!state?.planJson) continue;
        const original = planSchema.parse(JSON.parse(state.planJson));
        if (!options.callbacks) throw Error('state_conflict');
        const saved = planSchema.parse(need(await options.callbacks.readPlan(identity(original))));
        if (!isDeepStrictEqual(saved, original)) throw Error('state_conflict');
        await register(saved);
        await replayParentReceipt({ conversation, state, plan: original });
      }
      cursor = page.next;
    } while (cursor);
  };
  const invoker = (api: ToolExecutionApi, nativeContext: Context, call: DurableProductToolCall): DurableSubagentInvoker =>
    (raw, signal) => {
      let original: DurableSubagentIdentity | undefined;
      return safe(async () => {
      const plan = planSchema.parse(raw);
      if (call.child || call.name !== 'Agent' || plan.nativeToolTaskId !== api.taskId || api.taskId !== call.nativeTaskId
        || api.conversationId !== call.nativeConversationId || !isDeepStrictEqual(parent(plan), parent(call))) throw Error('state_conflict');
      original = identity(plan);
      if (invoking.has(plan.childRunId)) throw Error('state_conflict');
      invoking.add(plan.childRunId);
      try {
      if (!options.callbacks) throw Error('state_conflict');
      const saved = planSchema.parse(need(await options.callbacks.readPlan(identity(plan))));
      if (!isDeepStrictEqual(saved, plan)) throw Error('state_conflict');
      const previous = need(await observe(plan));
      if (previous?.creation === 'created' && previous.execution === 'closed' && (previous.status === 'done' || previous.status === 'unanswered')) return previous;
      await verify(plan, signal); check(plan, signal);
      const taskContext = withAbortSignal(signal, nativeContext), ref = await register(plan);
      creating.add(plan.childRunId);
      let childId: ConversationId;
      try {
        const found = await locate(plan);
        childId = found ? found.conversation.id : await api.commit(async tx => {
          check(plan, signal);
          const original = (await tx.scanConversations({ ownerTaskId: api.taskId }, 2)).items;
          if (original.length > 0) throw Error('state_conflict');
          const child = await tx.createConversation({ ownership: { kind: 'task', taskId: api.taskId } });
          const tools = options.registry.snapshot().tools().map(item => item.tool).filter(tool => plan.allowedTools.includes(tool.name));
          if (new Set(tools.map(tool => tool.name)).size !== plan.allowedTools.length) throw Error('state_conflict');
          await configure(tx, child.id, { model: { provider: ref.provider, modelId: ref.modelId }, thinkingLevel: plan.thinkingLevel,
            instructions: plan.systemPrompt, tools, modelTools: tools });
          (await tx.doc(Child, child.id)).planJson = JSON.stringify(plan);
          check(plan, signal); return child.id;
        }, taskContext);
      } finally { creating.delete(plan.childRunId); }
      check(plan, signal);
      need(await options.callbacks.adopt({ ...identity(plan), nativeConversationId: childId }));
      await verify(plan, signal); check(plan, signal);
      const child = await api.conversation(childId, taskContext); if (!child) throw Error('storage_corrupt');
      const prior = await options.read(() => storage.submissionByRequest(childId, requestKey(plan), context));
      let content = plan.prompt;
      if (!prior) {
        const working = InvoiceWorkWorkingContextSchema.parse(need(await options.readWorkingContext!({ ...parent(plan), child: childOwner(plan) })));
        const formatted = formatInvoiceWorkContext(working); if (!formatted.ok) throw new ChildFailure(formatted.error);
        content = formatted.data;
        await options.compactions.preparePhase(parent(plan), childId);
        await api.commit(tx => configure(tx, childId, { instructions: `${plan.systemPrompt}\n\nFrozen child instructions:\n${JSON.stringify(working.instructions)}` }), taskContext);
      }
      const abort = () => { void harness.conversation(childId, context).then(child => child?.abort(context, { background: true })).catch(() => {}); };
      signal.addEventListener('abort', abort, { once: true });
      try {
        check(plan, signal);
        const submission = await child.submit({ type: 'input', requestId: requestKey(plan), content,
          whenBusy: 'reject', entry: { kind: 'flowmate.child-input', data: identity(plan) } }, taskContext);
        await submission.wait(taskContext); await child.waitForIdle(taskContext);
        const observed = need(await observe(plan)); if (!observed) throw Error('storage_corrupt'); return observed;
      } finally { signal.removeEventListener('abort', abort); }
      } finally { invoking.delete(plan.childRunId); }
      }, () => original !== undefined && options.isClosed() && !options.isStopping(original));
    };
  const resolveToolCall = async (taskId: TaskId, conversationId: ConversationId, feedback = false): Promise<DurableProductToolCall> => {
    if (feedback) {
      const call = await options.read(() => readDurableToolCall(harness, storage, taskId, conversationId, context));
      const meta = await harness.snapshot(Child, conversationId, context); if (!call?.child || !meta?.planJson) throw Error('state_conflict');
      const plan = planSchema.parse(JSON.parse(meta.planJson));
      if (!isDeepStrictEqual(parent(plan), parent(call)) || !isDeepStrictEqual(childOwner(plan), call.child)) throw Error('state_conflict');
      if (!await creator(plan)) throw Error('state_conflict');
      const receipt = await options.read(() => storage.submissionByRequest(conversationId, requestKey(plan), context));
      if (receipt?.type !== 'input' || receipt.entry === undefined) throw Error('state_conflict');
      const original = (await options.read(() => storage.entry(receipt.entry!, context)))?.entry;
      if (original?.kind !== 'flowmate.child-input' || !isDeepStrictEqual(identitySchema.parse(original.data), identity(plan))) throw Error('state_conflict');
      const task = await options.read(() => storage.task(taskId, context)), input = z.object({ assistant: id }).parse(task?.input);
      const child = await harness.conversation(conversationId, context); if (!child) throw Error('storage_corrupt');
      await options.compactions.verifyInput(parent(plan), conversationId, await child.context(context, { at: input.assistant as EntryId }), receipt.entry);
      return call;
    }
    return options.read(() => harness.commit(async tx => {
    const task = await tx.task(taskId);
    if (task?.kind !== ToolTask.definition.name || task.conversationId !== conversationId || task.owner === undefined) throw Error('state_conflict');
    const input = z.object({ kind: z.literal('model'), assistant: id, callId: z.string() }).strict().parse(task.input);
    const generation = await tx.task(task.owner), selected = await tx.doc(ChildGeneration, task.owner), meta = await tx.doc(Child, conversationId);
    if (!selected.identity || !meta.planJson || generation?.kind !== GenerationTask.definition.name || generation.conversationId !== conversationId) throw Error('state_conflict');
    const plan = planSchema.parse(JSON.parse(meta.planJson));
    if (!isDeepStrictEqual(identity(plan), identity(selected.identity)) || !('checkpoint' in generation.state)) throw Error('state_conflict');
    const point = z.object({ phase: z.literal('tools'), assistant: id, tools: z.array(id) }).parse(generation.state.checkpoint);
    if (point.assistant !== input.assistant || !point.tools.includes(taskId)) throw Error('state_conflict');
    const assistant = await tx.entry(input.assistant as EntryId), message = assistant?.model?.[0];
    const call = message?.role === 'assistant' ? message.content.find(block => block.type === 'toolCall' && block.id === input.callId) : undefined;
    if (assistant?.conversationId !== conversationId || assistant.byTaskId !== task.owner || call?.type !== 'toolCall'
      || !plan.allowedTools.includes(call.name) || call.name === 'Agent') throw Error('state_conflict');
    const previous = selected.calls.find(item => item.taskId === taskId);
    const args = 'checkpoint' in task.state ? z.object({ arguments: z.unknown() }).parse(task.state.checkpoint).arguments
      : previous ? JSON.parse(previous.argumentsJson) : call.arguments;
    if (previous && !isDeepStrictEqual(JSON.parse(previous.argumentsJson), args)) throw Error('storage_corrupt');
    if (!previous && 'checkpoint' in task.state) selected.calls.push({ taskId, argumentsJson: JSON.stringify(args) });
    return { ...parent(plan), child: childOwner(plan), nativeConversationId: conversationId, nativeTaskId: taskId,
      nativeToolCallId: input.callId, name: call.name, arguments: args };
    }, context));
  };
  options.registry.install({ name: 'flowmate-native-children', hooks: [hook(GenerationTask, { afterResponse: async (message: AssistantMessage, api: HookApi) => {
    const selected = requested.get(api.taskId); requested.delete(api.taskId);
    if (!selected || !['stop', 'length', 'toolUse'].includes(message.stopReason)) return;
    await harness.commit(async tx => {
      const meta = await tx.doc(Child, selected.conversationId), generation = await tx.doc(ChildGeneration, api.taskId);
      if (!meta.planJson || !isDeepStrictEqual(identity(planSchema.parse(JSON.parse(meta.planJson))), selected.identity)) throw Error('storage_corrupt');
      meta.consumedAt ??= new Date().toISOString();
      generation.identity = selected.identity; generation.submissionId = selected.submissionId; generation.entryId = selected.entryId;
    }, context);
  } })] });
  const allChildren = async (): Promise<ChildRecord[]> => {
    const values: ChildRecord[] = []; let cursor: Cursor | undefined;
    do { const page = await options.read(() => storage.scanConversations({}, 100, cursor, context));
      for (const conversation of page.items) { const state = await harness.snapshot(Child, conversation.id, context);
        if (state?.planJson) values.push({ conversation, state, plan: planSchema.parse(JSON.parse(state.planJson)) }); }
      cursor = page.next;
    } while (cursor); return values;
  };
  const noteParentResult = async (call: DurableProductToolCall, entry: EntryRecord) => {
    if (call.name !== 'Agent' || call.child) return;
    for (const child of await allChildren()) if (child.plan.nativeToolTaskId === call.nativeTaskId) {
      if (!isDeepStrictEqual(parent(child.plan), parent(call)) || entry.kind !== ToolResultEntry.kind || entry.conversationId !== call.nativeConversationId) throw Error('state_conflict');
      await harness.commit(async tx => { const meta = await tx.doc(Child, child.conversation.id);
        if (meta.parentToolResultEntryId !== null && meta.parentToolResultEntryId !== entry.id) throw Error('storage_corrupt'); meta.parentToolResultEntryId = entry.id; }, context);
    }
  };
  const captureParent = async (query: DurableSubmissionQuery, entries: readonly EntryRecord[], messages: readonly Message[]): Promise<ParentChildConsumption[]> => {
    const included: ParentChildConsumption[] = [];
    for (const child of await allChildren()) {
      if (!isDeepStrictEqual(parent(child.plan), parent(query)) || child.state.parentToolResultEntryId === null || child.state.parentModelReceivedAt !== null) continue;
      const entry = entries.find(entry => entry.id === child.state.parentToolResultEntryId), message = entry?.model?.[0];
      if (message?.role === 'toolResult' && messages.some(item => isDeepStrictEqual(item, message))) included.push({ identity: identity(child.plan), entryId: entry!.id });
    }
    return included;
  };
  const parentConsumed = async (included: readonly ParentChildConsumption[], taskId: number, at: string) => {
    for (const item of included) {
      const child = await locate(item.identity); if (!child) throw Error('storage_corrupt');
      await harness.commit(async tx => { const meta = await tx.doc(Child, child.conversation.id);
        if (meta.parentToolResultEntryId !== item.entryId) throw Error('state_conflict');
        if (meta.parentModelReceivedAt === null) { meta.parentModelTaskId = taskId; meta.parentModelReceivedAt = at; }
      }, context);
      if (options.callbacks) need(await options.callbacks.onParentConsumed({ ...item.identity, nativeToolResultEntryId: item.entryId,
        nativeModelTaskId: child.state.parentModelTaskId ?? taskId, observedAt: child.state.parentModelReceivedAt ?? at }));
    }
  };
  const replayParentReceipt = async (child: ChildRecord) => {
    const { parentToolResultEntryId, parentModelTaskId, parentModelReceivedAt } = child.state;
    if (parentModelReceivedAt === null) return;
    if (parentToolResultEntryId === null || parentModelTaskId === null || !options.callbacks) throw Error('storage_corrupt');
    need(await options.callbacks.onParentConsumed({ ...identity(child.plan), nativeToolResultEntryId: parentToolResultEntryId,
      nativeModelTaskId: parentModelTaskId, observedAt: parentModelReceivedAt }));
  };
  return { invoker, observe, isChild, restoreAll, resolveToolCall, noteParentResult, captureParent, parentConsumed,
    resolveConversationId: async (raw: DurableSubagentIdentity): Promise<ConversationId | undefined> => {
      const input = identity(raw); if (!await creator(input)) return undefined;
      return (await locate(input))?.conversation.id;
    },
    identityForConversation: async (conversationId: ConversationId): Promise<DurableSubagentIdentity | null> => {
      const state = await harness.snapshot(Child, conversationId, context); if (!state?.planJson) return null;
      const plan = planSchema.parse(JSON.parse(state.planJson)); if (!await creator(plan)) throw Error('state_conflict'); return identity(plan);
    },
    resolvePhase: async (raw: DurableSubagentIdentity) => {
      const input = identity(raw); if (!await creator(input)) throw Error('state_conflict');
      const child = await locate(input); if (!child) throw Error('state_conflict');
      const record = await options.read(() => storage.submissionByRequest(child.conversation.id, requestKey(input), context));
      const agent = await harness.snapshot(AgentDoc, child.conversation.id, context);
      if (record?.type !== 'input' || record.entry === undefined || !agent?.model) throw Error('state_conflict');
      return { ...parent(input), nativeConversationId: child.conversation.id, nativeSubmissionId: record.id, nativeEntryId: record.entry, model: agent.model };
    },
    matchesWork: async (conversationId: ConversationId, query: DurableSubmissionQuery) => {
      const meta = await harness.snapshot(Child, conversationId, context); if (!meta?.planJson) return false;
      const plan = planSchema.parse(JSON.parse(meta.planJson)); return plan.workId === query.workId && plan.sessionId === query.sessionId;
    },
    reconcileParentConsumed: async (query: DurableSubmissionQuery) => {
      for (const child of await allChildren()) if (isDeepStrictEqual(parent(child.plan), parent(query))) await replayParentReceipt(child);
    },
    verifyTool: async (call: DurableProductToolCall, signal?: AbortSignal) => safe(async () => {
      if (!call.child || call.name === 'Agent') throw Error('state_conflict');
      const meta = await harness.snapshot(Child, call.nativeConversationId as ConversationId, context); if (!meta?.planJson) throw Error('state_conflict');
      const plan = planSchema.parse(JSON.parse(meta.planJson));
      if (!isDeepStrictEqual(parent(plan), parent(call)) || !isDeepStrictEqual(childOwner(plan), call.child) || !plan.allowedTools.includes(call.name)) throw Error('state_conflict');
      await verify(plan, signal, call.nativeTaskId);
    }) };
}
