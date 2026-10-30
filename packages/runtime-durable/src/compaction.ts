import { BACKGROUND_CONTEXT } from '@earendil-works/chord/context';
import { type Message, type MutableModels, type UserMessage } from '@earendil-works/pi-ai';
import { AgentDoc, CompactionEntry, CompactionTask, defineDocFamily, hook, LiveDoc,
  type ConversationId, type ContextView, type Cursor, type EntryId, type Harness, type ModelRef, type Registry, type Storage, type SubmissionId, type TaskId, type Tx } from '@earendil-works/pi-durable';
import { appError, fail, ok, DurableCompactionIdentitySchema, DurableCompactionRequestSchema, DurableCompactionPlanSchema,
  DurableCompactionObservationSchema, type AppError, type DurableCompactionCallbacks, type DurableCompactionIdentity,
  type DurableCompactionRequest, type DurableCompactionPlan, type DurableCompactionObservation, type DurableModelBinding,
  type DurableAttemptIdentity, type DurableSubmissionQuery, type Result, type UsageRecord } from '@flowmate/contracts';
import { isDeepStrictEqual } from 'node:util';
import { z } from 'zod';
import type { DurableCompactionModelUse } from './models.ts';

const context = BACKGROUND_CONTEXT, id = z.number().int().positive().max(Number.MAX_SAFE_INTEGER);
type Source = { firstKept: number; tail: number | null; inputEntryId: number; entries: number[] };
type RequestFact = { reservedAt: string; enteredAt: string | null; responseAt: string | null; usageJson: string | null };
type State = { planJson: string | null; taskId: number | null; model: ModelRef | null; source: Source | null;
  cancelRequestedAt: string | null; requests: RequestFact[] };
const Operation = defineDocFamily({ kind: 'flowmate.runtime.compaction', version: 1, family: true, scope: 'conversation', history: 'latest', fork: 'initial',
  initial: (): State => ({ planJson: null, taskId: null, model: null, source: null, cancelRequestedAt: null, requests: [] }), checkpointWhen: () => true });
const TaskIndex = defineDocFamily({ kind: 'flowmate.runtime.compaction-task', version: 1, family: true, scope: 'conversation', history: 'latest', fork: 'initial',
  initial: (): { operationKey: string | null } => ({ operationKey: null }), checkpointWhen: () => true });
const Phase = defineDocFamily({ kind: 'flowmate.runtime.phase-head', version: 1, family: true, scope: 'conversation', history: 'latest', fork: 'initial',
  initial: (): { queryJson: string | null; entryId: number | null; lowerBound: number | null } => ({ queryJson: null, entryId: null, lowerBound: null }), checkpointWhen: () => true });
class CompactionFailure extends Error { constructor(readonly fact: AppError) { super(fact.code); } }
const need = <T>(value: Result<T>): T => { if (!value.ok) throw new CompactionFailure(value.error); return value.data; };
const requestOf = (value: DurableCompactionPlan | DurableCompactionRequest): DurableCompactionRequest => ({
  workId: value.workId, sessionId: value.sessionId, attemptId: value.attemptId, requestId: value.requestId, operationId: value.operationId,
  ...(value.child ? { child: value.child } : {}), reason: value.reason, expectedTailEntryId: value.expectedTailEntryId, instructions: value.instructions });
const identityOf = (value: DurableCompactionIdentity): DurableCompactionIdentity => DurableCompactionIdentitySchema.parse({
  workId: value.workId, sessionId: value.sessionId, attemptId: value.attemptId, requestId: value.requestId, operationId: value.operationId,
  ...(value.child ? { child: value.child } : {}) });
const phaseKey = (value: DurableSubmissionQuery) => JSON.stringify([value.attemptId, value.requestId]);
const operationKey = (value: DurableCompactionIdentity) => JSON.stringify([value.attemptId, value.requestId, value.operationId, value.child?.childRunId ?? null]);
type Record = { conversationId: ConversationId; key: string; state: Readonly<State>; plan: DurableCompactionPlan };
export type DurableCompactionPhase = DurableSubmissionQuery & { nativeConversationId: number; nativeSubmissionId: number;
  nativeEntryId: number; model: ModelRef };
export type DurableCompactionRuntimeOptions = {
  harness: Harness; storage: Storage; registry: Registry; models: MutableModels; callbacks?: DurableCompactionCallbacks;
  resolvePhase(query: DurableCompactionIdentity): Promise<DurableCompactionPhase>;
  resolveAutomatic?(taskId: TaskId, conversationId: ConversationId, reason: 'threshold' | 'overflow', tail: EntryId): Promise<DurableCompactionRequest>;
  prepareModel?(plan: DurableCompactionPlan, model: ModelRef): Promise<void>;
  beforeSchedule?(): Promise<void>;
  hasLiveOwnedTasks?(tx: Tx, conversationId: ConversationId): Promise<boolean>;
  read<T>(action: () => Promise<T>): Promise<T>;
  isClosed(): boolean;
  isStopping(query: DurableSubmissionQuery): boolean;
};

/** Public built-in tasks stay untouched; only the application's Models instance is instrumented. */
export function createDurableCompactionRuntime(options: DurableCompactionRuntimeOptions) {
  const { harness, storage } = options;
  const signals = new WeakMap<AbortSignal, { record: Record; index: number | null }>();
  const checks = async (plan: DurableCompactionPlan, signal?: AbortSignal) => {
    signal?.throwIfAborted();
    if (options.isClosed() || options.isStopping(plan)) throw Error('state_conflict');
    if (!options.callbacks) throw Error('compaction_unavailable');
    need(await options.callbacks.verify(plan)); signal?.throwIfAborted();
    if (options.isClosed() || options.isStopping(plan)) throw Error('state_conflict');
  };
  const safe = async <T>(action: () => Promise<T>): Promise<Result<T>> => {
    try { return ok(await action()); }
    catch (error) { return fail(error instanceof CompactionFailure ? error.fact : appError(error instanceof Error
      && ['input_invalid', 'state_conflict', 'storage_corrupt', 'agent_busy', 'compaction_unavailable'].includes(error.message)
      ? error.message : 'durable_compaction_failed', 'runtime', 'The original native compaction could not be confirmed.', true)); }
  };
  const at = async (conversationId: ConversationId, key: string): Promise<Record | null> => {
    const state = await harness.snapshot(Operation, conversationId, key, context); if (!state?.planJson) return null;
    const plan = DurableCompactionPlanSchema.parse(JSON.parse(state.planJson));
    if (operationKey(plan) !== key || state.taskId === null || state.model === null) throw Error('storage_corrupt');
    return { conversationId, key, state, plan };
  };
  const byTask = async (conversationId: ConversationId, taskId: number) => {
    const index = await harness.snapshot(TaskIndex, conversationId, String(taskId), context);
    const record = index?.operationKey ? await at(conversationId, index.operationKey) : null;
    if (record && record.state.taskId !== taskId) throw Error('storage_corrupt'); return record;
  };
  const locate = async (raw: DurableCompactionIdentity) => {
    const input = identityOf(raw), phase = await options.resolvePhase(input), record = await at(phase.nativeConversationId as ConversationId, operationKey(input));
    if (record && !isDeepStrictEqual(identityOf(record.plan), input)) throw Error('state_conflict'); return record;
  };
  const all = async (): Promise<Record[]> => {
    const values: Record[] = []; let cursor: Cursor | undefined;
    do {
      const page = await options.read(() => storage.scanConversations({}, 100, cursor, context));
      for (const conversation of page.items) {
        let docs: Cursor | undefined;
        do {
          const members = await options.read(() => storage.scanDocuments({ scope: { kind: 'conversation', conversationId: conversation.id },
            kind: Operation.definition.kind, at: 'current' }, 100, docs, context));
          for (const member of members.items) { const value = await at(conversation.id, member.key!); if (value) values.push(value); }
          docs = members.next;
        } while (docs);
      }
      cursor = page.next;
    } while (cursor); return values;
  };
  const preparePhase = async (query: DurableSubmissionQuery, conversationId: ConversationId, inputEntryId?: number) => {
    await harness.commit(async tx => {
      const state = await tx.doc(Phase, conversationId, phaseKey(query), null);
      const queryJson = JSON.stringify({ workId: query.workId, sessionId: query.sessionId, attemptId: query.attemptId, requestId: query.requestId });
      if (state.queryJson !== null) { if (state.queryJson !== queryJson) throw Error('state_conflict'); return; }
      if (await options.hasLiveOwnedTasks?.(tx, conversationId)) throw Error('agent_busy');
      for (const status of ['pending', 'running', 'waiting', 'sleeping', 'completing'] as const)
        if ((await tx.scanTasks({ conversationId, status }, 1)).items.length > 0) throw Error('agent_busy');
      const entry = await tx.appendEntry(conversationId, { kind: 'flowmate.phase-boundary', head: inputEntryId === undefined ? 'self' : inputEntryId as EntryId,
        data: JSON.parse(queryJson) });
      state.queryJson = queryJson; state.entryId = entry.id; state.lowerBound = inputEntryId ?? entry.id;
    }, context);
  };
  const sourceFor = async (record: Record, firstKept: EntryId, entries: readonly { id: EntryId }[]) => {
    const phase = await harness.snapshot(Phase, record.conversationId, phaseKey(record.plan), context);
    if (!phase?.lowerBound || firstKept < phase.lowerBound || entries.some(entry => entry.id < phase.lowerBound!)) throw Error('state_conflict');
    const original = await options.resolvePhase(record.plan), conversation = await harness.conversation(record.conversationId, context);
    if (!conversation) throw Error('storage_corrupt');
    await verifyInput(record.plan, record.conversationId, await conversation.context(context), original.nativeEntryId);
    await harness.commit(async tx => {
      const state = await tx.doc(Operation, record.conversationId, record.key, null), ids = entries.map(entry => entry.id);
      if (state.source && (state.source.firstKept !== firstKept || state.source.inputEntryId !== original.nativeEntryId
        || state.source.entries.length !== ids.length || state.source.entries.some((entry, index) => entry !== ids[index]))) throw Error('state_conflict');
      state.source ??= { firstKept, tail: null, inputEntryId: original.nativeEntryId, entries: ids };
    }, context);
  };
  const bind = async (record: Record, taskId: number, signal: AbortSignal) => {
    const task = await options.read(() => storage.task(taskId as TaskId, context));
    if (task?.kind !== CompactionTask.definition.name || task.conversationId !== record.conversationId || task.state.status !== 'running' || task.abortRequested
      || !('checkpoint' in task.state)) throw Error('state_conflict');
    const checkpoint = z.object({ phase: z.literal('summarize'), tail: id, firstKept: id,
      model: z.object({ provider: z.string(), modelId: z.string() }), thinkingLevel: z.string() }).parse(task.state.checkpoint);
    if (!record.state.source || record.state.source.firstKept !== checkpoint.firstKept || !isDeepStrictEqual(record.state.model, checkpoint.model)
      || checkpoint.thinkingLevel !== record.plan.thinkingLevel) throw Error('state_conflict');
    const conversation = await harness.conversation(record.conversationId, context); if (!conversation) throw Error('storage_corrupt');
    const view = await conversation.context(context, { at: checkpoint.tail as EntryId }), cut = view.entries.findIndex(entry => entry.id === checkpoint.firstKept);
    if (cut < 0 || !isDeepStrictEqual(view.entries.slice(0, cut).map(entry => entry.id), record.state.source.entries)) throw Error('state_conflict');
    await checks(record.plan, signal);
    await harness.commit(async tx => {
      const state = await tx.doc(Operation, record.conversationId, record.key, null);
      if (!state.source || state.source.tail !== null && state.source.tail !== checkpoint.tail) throw Error('state_conflict'); state.source.tail = checkpoint.tail;
    }, context);
    const current = await at(record.conversationId, record.key); if (!current) throw Error('storage_corrupt');
    signals.set(signal, { record: current, index: null });
  };
  const originalComplete = options.models.completeSimple.bind(options.models);
  options.models.completeSimple = async (model, native, request) => {
    const signal = request?.signal; if (!signal) return originalComplete(model, native, request);
    const known = signals.get(signal), candidates: Record[] = []; let cursor: Cursor | undefined;
    if (known) candidates.push(known.record);
    else do {
      const page = await options.read(() => storage.scanTasks({ kind: CompactionTask.definition.name, status: 'running' }, 100, cursor, context));
      for (const task of page.items) {
        if (!('checkpoint' in task.state)) continue;
        const point = z.object({ phase: z.literal('summarize'), model: z.object({ provider: z.string(), modelId: z.string() }) }).safeParse(task.state.checkpoint);
        if (!point.success || point.data.model.provider !== model.provider || point.data.model.modelId !== model.id) continue;
        const record = await byTask(task.conversationId, task.id); if (!record) throw Error('state_conflict'); candidates.push(record);
      }
      cursor = page.next;
    } while (cursor);
    if (candidates.length === 0) return originalComplete(model, native, request);
    if (candidates.length !== 1) throw Error('state_conflict');
    await bind(candidates[0]!, candidates[0]!.state.taskId!, signal);
    try {
      const message = await originalComplete(model, native, request), active = signals.get(signal);
      if (active?.index !== null && active?.index !== undefined && !signal.aborted && !options.isClosed()) {
        await harness.commit(async tx => {
          const state = await tx.doc(Operation, active.record.conversationId, active.record.key, null), slot = state.requests[active.index!];
          if (!slot) throw Error('storage_corrupt'); slot.responseAt = new Date().toISOString(); slot.usageJson = JSON.stringify(message.usage);
        }, context);
      }
      await checks(candidates[0]!.plan, signal);
      return message;
    } finally { signals.delete(signal); }
  };
  options.registry.install({ name: 'flowmate-compaction-scope', hooks: [hook(CompactionTask, { beforeCompact: async (source, api, nativeContext) => {
    try {
      let record = await byTask(api.conversationId, api.taskId);
      if (!record) {
        if (!options.resolveAutomatic || source.reason === 'manual') throw Error('state_conflict');
        const conversation = await harness.conversation(api.conversationId, context); if (!conversation) throw Error('storage_corrupt');
        const tail = (await conversation.context(context)).entries.reduce<number>((last, entry) => Math.max(last, entry.id), source.firstKept) as EntryId;
        const request = await options.resolveAutomatic(api.taskId, api.conversationId, source.reason, tail);
        const plan = DurableCompactionPlanSchema.parse(need(await options.callbacks!.readPlan(request))), phase = await options.resolvePhase(plan);
        await checks(plan, nativeContext.abortSignal);
        const agent = await harness.snapshot(AgentDoc, api.conversationId, context); if (!agent?.model || phase.nativeConversationId !== api.conversationId) throw Error('state_conflict');
        const model = agent.model;
        await harness.commit(async tx => {
          const state = await tx.doc(Operation, api.conversationId, operationKey(plan), null), index = await tx.doc(TaskIndex, api.conversationId, String(api.taskId), null);
          if (state.planJson !== null || index.operationKey !== null) throw Error('state_conflict');
          state.planJson = JSON.stringify(plan); state.taskId = api.taskId; state.model = model; index.operationKey = operationKey(plan);
        }, context);
        record = await byTask(api.conversationId, api.taskId);
      }
      if (!record || source.reason !== record.plan.reason) throw Error('state_conflict');
      await checks(record.plan, nativeContext.abortSignal); await sourceFor(record, source.firstKept, source.entries);
      if (!nativeContext.abortSignal) throw Error('state_conflict');
      const selected = await at(record.conversationId, record.key); if (!selected) throw Error('storage_corrupt');
      signals.set(nativeContext.abortSignal, { record: selected, index: null });
      return undefined;
    } catch (error) {
      await harness.abortTask(api.taskId, nativeContext); throw error;
    }
  } })] });
  const usage = (state: Readonly<State>): UsageRecord | null => {
    if (state.requests.length === 0) return null;
    const values = state.requests.filter(item => item.usageJson !== null).map(item => JSON.parse(item.usageJson!));
    const sum = (field: string, cost = false): number | null => {
      if (!values.length) return null; let total = 0;
      for (const value of values) {
        const parsed = z.record(z.unknown()).parse(value), raw = cost ? z.record(z.unknown()).parse(parsed.cost)[field] : parsed[field];
        if (typeof raw !== 'number' || !Number.isFinite(raw)) return null; total += raw;
      }
      return total;
    };
    const reported = ['input', 'output', 'cacheRead', 'cacheWrite', 'totalTokens'].some(field => (sum(field) ?? 0) > 0);
    return { version: 1, source: reported ? 'sdk' : 'unknown', reason: 'native-compaction-usage-partial',
      sdkValues: values.length ? { input: sum('input'), output: sum('output'), cacheRead: sum('cacheRead'), cacheWrite: sum('cacheWrite'), totalTokens: sum('totalTokens'),
        costInput: sum('input', true), costOutput: sum('output', true), costCacheRead: sum('cacheRead', true), costCacheWrite: sum('cacheWrite', true), costTotal: sum('total', true) } : null,
      attempts: state.requests.some(item => item.enteredAt !== null) ? state.requests.filter(item => item.enteredAt !== null).length : null,
      attemptsComplete: state.requests.every(item => item.enteredAt !== null && item.responseAt !== null), costSource: null,
      updatedAt: state.requests.at(-1)!.responseAt ?? state.requests.at(-1)!.enteredAt ?? state.requests.at(-1)!.reservedAt };
  };
  const observe = (raw: DurableCompactionIdentity): Promise<Result<DurableCompactionObservation | null>> => safe(async () => {
    const record = await locate(raw); if (!record) return null;
    const task = await options.read(() => storage.task(record.state.taskId! as TaskId, context));
    if (!task || task.kind !== CompactionTask.definition.name || task.conversationId !== record.conversationId
      || !isDeepStrictEqual(task.input, { reason: record.plan.reason, ...(record.plan.instructions === null ? {} : { instructions: record.plan.instructions }) })) throw Error('storage_corrupt');
    const outcome = 'outcome' in task.state ? task.state.outcome : null, result = outcome && 'result' in outcome
      ? z.object({ entryId: id.optional(), submissionId: id.optional() }).parse(outcome.result) : null;
    const write = result?.submissionId ? await options.read(() => storage.submission(result.submissionId! as SubmissionId, context)) : null;
    if (result?.submissionId && (!write || write.type !== 'write' || write.conversationId !== record.conversationId)) throw Error('storage_corrupt');
    const entryId = result?.entryId ?? (write?.status === 'done' ? write.entry : null);
    const entry = entryId ? (await options.read(() => storage.entry(entryId as EntryId, context)))?.entry : null;
    if (entry && (entry.kind !== CompactionEntry.kind || entry.conversationId !== record.conversationId || entry.head !== record.state.source?.firstKept)) throw Error('storage_corrupt');
    const error = outcome && outcome.status !== 'completed' && outcome.status !== 'aborted' ? appError('durable_compaction_failed', 'runtime',
      'The original native summary task did not complete successfully.') : write?.status === 'unanswered'
        ? appError('compaction_write_unanswered', 'runtime', 'The original summary write was withdrawn or became stale.') : null;
    return DurableCompactionObservationSchema.parse({ ...requestOf(record.plan), nativeConversationId: record.conversationId, nativeTaskId: task.id,
      nativeTaskStatus: task.state.status, outcome: outcome?.status ?? null,
      firstKeptEntryId: record.state.source?.firstKept ?? null, summaryEntryId: entry?.id ?? null, writeSubmissionId: result?.submissionId ?? null,
      writeStatus: write?.status ?? null, summaryGenerated: result?.entryId !== undefined || result?.submissionId !== undefined, summarySaved: Boolean(entry),
      stopped: task.state.status === 'terminal' && (!write || write.status === 'done' || write.status === 'unanswered'),
      cancelRequestedAt: record.state.cancelRequestedAt, error, usage: usage(record.state) });
  });
  const summaryRecord = async (query: DurableSubmissionQuery, conversationId: ConversationId, view: ContextView) => {
    if (view.head?.kind !== CompactionEntry.kind) return null;
    let found = view.head.byTaskId ? await byTask(conversationId, view.head.byTaskId) : null;
    if (!found) for (const candidate of await all()) if (candidate.conversationId === conversationId) {
      const observed = need(await observe(candidate.plan)); if (observed?.summaryEntryId === view.head.id) { found = candidate; break; }
    }
    if (!found || found.plan.workId !== query.workId || found.plan.sessionId !== query.sessionId || found.plan.attemptId !== query.attemptId
      || found.plan.requestId !== query.requestId || !found.state.source || found.state.source.firstKept !== view.head.head) throw Error('state_conflict');
    const observed = need(await observe(found.plan));
    if (!observed?.summarySaved || observed.summaryEntryId !== view.head.id) throw Error('state_conflict'); return found;
  };
  const verifyInput = async (query: DurableSubmissionQuery, conversationId: ConversationId, view: ContextView, inputEntryId: number) => {
    const phase = await harness.snapshot(Phase, conversationId, phaseKey(query), context);
    if (!phase?.lowerBound || inputEntryId < phase.lowerBound || phase.queryJson !== JSON.stringify({ workId: query.workId, sessionId: query.sessionId,
      attemptId: query.attemptId, requestId: query.requestId }) || view.entries.some(entry => entry.id < phase.lowerBound!)) throw Error('state_conflict');
    const inputs = view.entries.filter(entry => entry.kind === 'flowmate.input' || entry.kind === 'flowmate.child-input');
    if (inputs.at(-1)?.id === inputEntryId) return;
    const summary = await summaryRecord(query, conversationId, view);
    if (!summary?.state.source || summary.state.source.inputEntryId !== inputEntryId || inputEntryId >= summary.state.source.firstKept
      || summary.state.source.entries.some(entry => entry < phase.lowerBound!)) throw Error('state_conflict');
  };
  return { preparePhase, observe,
    verifyInput,
    projectPhase: async (query: DurableSubmissionQuery, conversationId: ConversationId, view: ContextView): Promise<{ messages: Message[]; summary?: UserMessage }> => {
      const phase = await harness.snapshot(Phase, conversationId, phaseKey(query), context);
      if (!phase?.lowerBound || phase.queryJson !== JSON.stringify({ workId: query.workId, sessionId: query.sessionId, attemptId: query.attemptId, requestId: query.requestId })
        || view.entries.some(entry => entry.id < phase.lowerBound!)) throw Error('state_conflict');
      let summary: UserMessage | undefined;
      if (await summaryRecord(query, conversationId, view)) {
        const message = view.head?.model?.[0];
        if (view.head?.model?.length !== 1 || message?.role !== 'user') throw Error('state_conflict');
        summary = structuredClone(message);
      }
      return { messages: view.messages.filter(message => message.role === 'assistant' || message.role === 'toolResult'), ...(summary ? { summary } : {}) };
    },
    start: (raw: DurableCompactionRequest): Promise<Result<DurableCompactionObservation>> => safe(async () => {
      const request = DurableCompactionRequestSchema.parse(requestOf(raw)), phase = await options.resolvePhase(request), conversationId = phase.nativeConversationId as ConversationId;
      const previous = await at(conversationId, operationKey(request));
      if (previous) { if (!isDeepStrictEqual(requestOf(previous.plan), request)) throw Error('state_conflict'); return need(await observe(request))!; }
      if (!options.callbacks) throw Error('compaction_unavailable');
      const plan = DurableCompactionPlanSchema.parse(need(await options.callbacks.readPlan(request)));
      if (!isDeepStrictEqual(requestOf(plan), request)) throw Error('state_conflict'); await checks(plan);
      const tail = (await options.read(() => storage.scanEntries({ conversationId }, 1, undefined, context))).items[0]?.id;
      if (tail !== plan.expectedTailEntryId) throw Error('state_conflict');
      if (!await harness.snapshot(Phase, conversationId, phaseKey(plan), context)) await preparePhase(plan, conversationId, phase.nativeEntryId);
      await checks(plan);
      await harness.commit(async tx => {
        const state = await tx.doc(Operation, conversationId, operationKey(plan), null);
        if (options.isClosed() || options.isStopping(plan)) throw Error('state_conflict');
        if (state.planJson !== null) { if (!isDeepStrictEqual(JSON.parse(state.planJson), plan)) throw Error('state_conflict'); return; }
        for (const status of ['pending', 'running', 'waiting', 'sleeping', 'completing'] as const)
          if ((await tx.scanTasks({ conversationId, kind: CompactionTask.definition.name, status }, 1)).items.length > 0) throw Error('agent_busy');
        const agent = await tx.doc(AgentDoc, conversationId);
        if (agent.model?.provider !== phase.model.provider || agent.model.modelId !== phase.model.modelId
          || (agent.thinkingLevel ?? 'off') !== plan.thinkingLevel) throw Error('state_conflict');
        const taskId = await tx.createTask(CompactionTask, { reason: plan.reason, ...(plan.instructions === null ? {} : { instructions: plan.instructions }) },
          { conversationId, ownership: { kind: 'conversation' }, background: false });
        const live = await tx.doc(LiveDoc, conversationId); live.compactions ??= [];
        live.compactions.push({ taskId, reason: plan.reason, blocking: false, attempt: 1 });
        state.planJson = JSON.stringify(plan); state.taskId = taskId; state.model = phase.model;
        (await tx.doc(TaskIndex, conversationId, String(taskId), null)).operationKey = operationKey(plan);
        if (options.isClosed() || options.isStopping(plan)) throw Error('state_conflict');
      }, context);
      await options.beforeSchedule?.(); harness.resume(); return need(await observe(request))!;
    }),
    cancel: (raw: DurableCompactionIdentity): Promise<Result<DurableCompactionObservation>> => safe(async () => {
      const record = await locate(raw); if (!record) throw Error('state_conflict');
      await harness.commit(async tx => { (await tx.doc(Operation, record.conversationId, record.key, null)).cancelRequestedAt ??= new Date().toISOString(); }, context);
      await harness.abortTask(record.state.taskId! as TaskId, context);
      const observed = need(await observe(raw));
      if (observed?.writeSubmissionId && observed.writeStatus === 'queued') await harness.abortSubmission(observed.writeSubmissionId as SubmissionId, context, record.conversationId);
      const final = need(await observe(raw)); if (!final) throw Error('storage_corrupt'); return final;
    }),
    stopAttempt: (query: DurableAttemptIdentity): Promise<Result<void>> => safe(async () => {
      for (const record of await all()) if (record.plan.workId === query.workId && record.plan.sessionId === query.sessionId && record.plan.attemptId === query.attemptId) {
        await harness.commit(async tx => { (await tx.doc(Operation, record.conversationId, record.key, null)).cancelRequestedAt ??= new Date().toISOString(); }, context);
        await harness.abortTask(record.state.taskId! as TaskId, context);
        const observed = need(await observe(record.plan));
        if (observed?.writeSubmissionId && observed.writeStatus === 'queued') await harness.abortSubmission(observed.writeSubmissionId as SubmissionId, context, record.conversationId);
        if (!need(await observe(record.plan))?.stopped) throw Error('state_conflict');
      }
    }),
    restoreAll: (): Promise<Result<void>> => safe(async () => {
      for (const record of await all()) {
        const task = await options.read(() => storage.task(record.state.taskId! as TaskId, context)); if (task?.state.status === 'terminal') continue;
        if (!options.callbacks) throw Error('compaction_unavailable');
        const plan = DurableCompactionPlanSchema.parse(need(await options.callbacks.readPlan(requestOf(record.plan))));
        if (!isDeepStrictEqual(plan, record.plan)) throw Error('state_conflict'); await options.prepareModel?.(plan, record.state.model!);
      }
    }),
    modelUse: async (signal: AbortSignal | undefined, binding: DurableModelBinding): Promise<Result<DurableCompactionModelUse | null>> => safe(async () => {
      const active = signal ? signals.get(signal) : null; if (!active) return null;
      if (!isDeepStrictEqual(active.record.plan.binding, binding)) throw Error('state_conflict');
      return { verify: async () => safe(async () => {
        const current = await at(active.record.conversationId, active.record.key); if (!current || current.state.cancelRequestedAt !== null) throw Error('state_conflict');
        await checks(current.plan, signal);
      }), reserve: async () => safe(async () => {
        await checks(active.record.plan, signal); need(await options.callbacks!.reserveModelRequest(active.record.plan));
        await harness.commit(async tx => { const state = await tx.doc(Operation, active.record.conversationId, active.record.key, null);
          active.index = state.requests.length; state.requests.push({ reservedAt: new Date().toISOString(), enteredAt: null, responseAt: null, usageJson: null }); }, context);
      }), entered: async () => {
        if (active.index === null) throw Error('state_conflict');
        await harness.commit(async tx => { const state = await tx.doc(Operation, active.record.conversationId, active.record.key, null);
          const slot = state.requests[active.index!]; if (!slot) throw Error('storage_corrupt'); slot.enteredAt = new Date().toISOString(); }, context);
      } };
    }),
  };
}
