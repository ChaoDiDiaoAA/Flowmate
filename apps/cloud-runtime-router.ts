import { BACKGROUND_CONTEXT } from '@earendil-works/chord/context';
import { ToolTask, type ConversationId, type Cursor, type EntryId, type TaskId } from '@earendil-works/pi-durable';
import { z } from 'zod';
import { isDeepStrictEqual } from 'node:util';
import { randomUUID } from 'node:crypto';
import { appError, CloudRuntimeBindingSchema, CloudRuntimeRetryReceiptSchema, CloudRuntimeRetryRequestSchema, CloudRuntimeStatusRequestSchema, CloudRuntimeStatusSchema,
  fail, ok, type CloudQueuePort, type CloudRuntimeBinding, type CloudRuntimeDeliveryPort, type DurableConversationIdentity, type DurableSubagentIdentity,
  type DurableRuntimePort, type Result } from '@flowmate/contracts';
import { createDurableRuntime, type DurableRuntimeOptions } from '@flowmate/runtime-durable';
import { createDurableHistoryReader } from '../packages/runtime-durable/src/history.ts';
import { cloudNativeLane, type CloudRuntimeSession, type CloudRuntimeStore } from './cloud-runtime-storage.ts';

export type CloudRuntimeOperation = Exclude<keyof DurableRuntimePort, 'close'> | 'readQueue' | 'controlQueue' | 'queryQueueControl' | 'resultStatus' | 'retryResult';
export type CloudRuntimeGrant = { binding: CloudRuntimeBinding; state: 'allocated' } |
  { binding: CloudRuntimeBinding; state: 'ready'; nativeConversationId: number };
type Operation = CloudRuntimeOperation;
type Grant = CloudRuntimeGrant;
type Options = {
  store: CloudRuntimeStore;
  runtimeGeneration?: string;
  runtimeOptions: Omit<DurableRuntimeOptions, 'storage'> |
    ((binding: CloudRuntimeBinding, session: CloudRuntimeSession) => Omit<DurableRuntimeOptions, 'storage'>);
  authorize(operation: Operation, request: DurableConversationIdentity & Record<string, unknown>): Result<Grant> | Promise<Result<Grant>>;
  beforeSchedule?(binding: CloudRuntimeBinding, session: CloudRuntimeSession,
    request: DurableConversationIdentity & { attemptId: number; requestId?: string }): Promise<Result<void>>;
  onResultRetry?(binding: CloudRuntimeBinding, session: CloudRuntimeSession): Promise<Result<void>>;
};
const id = z.number().int().positive().max(Number.MAX_SAFE_INTEGER);
const identitySchema = z.object({ workId: id, sessionId: id, itemId: id.optional(), participant: z.literal('reviewer').optional() }).passthrough();
const scheduledSchema = identitySchema.extend({ attemptId: id, requestId: z.string().min(1).max(128).optional() });
const scheduling = new Set<Operation>(['submit', 'waitForSubmission', 'resumeAttempt', 'compact', 'controlQueue']);
const grantSchema = z.discriminatedUnion('state', [
  z.object({ binding: CloudRuntimeBindingSchema, state: z.literal('allocated') }).strict(),
  z.object({ binding: CloudRuntimeBindingSchema, state: z.literal('ready'), nativeConversationId: id }).strict(),
]);
const fault = (code: string, message: string) => fail(appError(code, 'runtime', message, true));
type Opened = { session: CloudRuntimeSession; runtime: DurableRuntimePort & { queue: CloudQueuePort } };
type Entry = { binding: CloudRuntimeBinding; opened: Promise<Result<Opened>>; nativeConversationId: number | null; ready: boolean };

/** The Authority must authorize each operation; this router never infers permission from a runtime ID. */
export function createCloudRuntimeRouter(options: Options): DurableRuntimePort & { queue: CloudQueuePort; delivery: CloudRuntimeDeliveryPort; recoverSession(input: DurableConversationIdentity): Promise<Result<void>>;
  wakeSession(input: DurableConversationIdentity & { attemptId: number }): Promise<Result<void>> } {
  const entries = new Map<string, Entry>();
  const runtimeGeneration = z.string().uuid().parse(options.runtimeGeneration ?? randomUUID());
  const sessions = new Map<string, { binding: CloudRuntimeBinding; opened: Promise<Result<CloudRuntimeSession>> }>();
  const inFlight = new Set<Promise<unknown>>();
  const registries = new WeakSet<object>();
  let closing: Promise<Result<void>> | undefined;

  function sessionFor(binding: CloudRuntimeBinding, create: boolean): Promise<Result<CloudRuntimeSession>> {
    const existing = sessions.get(binding.cloudRuntimeId);
    if (existing) return isDeepStrictEqual(existing.binding, binding) ? existing.opened
      : Promise.resolve(fault('cloud_runtime_owner_conflict', 'The cloud runtime already belongs to another Session.'));
    const opened = options.store.openSession(binding, create), entry = { binding: structuredClone(binding), opened };
    sessions.set(binding.cloudRuntimeId, entry);
    void opened.then(result => { if (!result.ok && sessions.get(binding.cloudRuntimeId) === entry) sessions.delete(binding.cloudRuntimeId); });
    return opened;
  }
  const conflicts = (binding: CloudRuntimeBinding) => [...entries.values(), ...sessions.values()].some(entry =>
    (entry.binding.workId === binding.workId || entry.binding.sessionId === binding.sessionId || entry.binding.cloudRuntimeId === binding.cloudRuntimeId)
      && !isDeepStrictEqual(entry.binding, binding));

  async function authorization(operation: Operation, request: DurableConversationIdentity & Record<string, unknown>): Promise<Result<Grant>> {
    try {
      const result = await options.authorize(operation, structuredClone(request));
      if (!result.ok) return result;
      const parsed = grantSchema.safeParse(result.data);
      return parsed.success ? ok(parsed.data) : fault('cloud_authorization_invalid', 'The Authority returned an invalid runtime authorization.');
    } catch { return fault('cloud_authorization_unavailable', 'The Authority could not confirm this cloud operation.'); }
  }

  async function open(entry: Entry, grant: Grant, operation: Operation,
    request: DurableConversationIdentity & Record<string, unknown>): Promise<Result<Opened>> {
    const acquired = await sessionFor(entry.binding, grant.state === 'allocated');
    if (!acquired.ok) return acquired;
    const session = acquired.data;
    try {
      if (grant.state === 'allocated') {
        const [tasks, submissions, conversations] = await Promise.all([
          session.storage.scanTasks({}, 1, undefined, BACKGROUND_CONTEXT),
          session.storage.scanSubmissions({}, 1, undefined, BACKGROUND_CONTEXT),
          session.storage.scanConversations({}, 2, undefined, BACKGROUND_CONTEXT),
        ]);
        if (tasks.items.length || submissions.items.length || conversations.next || conversations.items.length > 1
          || conversations.items.some(record => record.owner)) throw Error('cloud_runtime_owner_conflict');
        entry.nativeConversationId = conversations.items[0]?.id ?? null;
      } else {
        const conversation = await session.storage.conversation(grant.nativeConversationId as ConversationId, BACKGROUND_CONTEXT);
        if (!conversation || conversation.owner) throw Error('cloud_runtime_owner_conflict');
        entry.nativeConversationId = grant.nativeConversationId;
      }
      const confirmed = await authorization(operation, request);
      if (!confirmed.ok || !isDeepStrictEqual(confirmed.data, grant) || closing) {
        return !confirmed.ok ? confirmed : closing ? fault('cloud_runtime_closed', 'The cloud runtime is closing.')
          : fault('cloud_runtime_owner_conflict', 'The Authority changed the original cloud Session authorization.');
      }
      const runtimeOptions = typeof options.runtimeOptions === 'function' ? options.runtimeOptions(structuredClone(entry.binding), session) : options.runtimeOptions;
      if (runtimeOptions.registry && registries.has(runtimeOptions.registry)) {
        return fault('cloud_runtime_registry_conflict', 'Each cloud Session needs its own native registry.');
      }
      if (runtimeOptions.registry) registries.add(runtimeOptions.registry);
      if (runtimeOptions.cloudModel && !isDeepStrictEqual(runtimeOptions.cloudModel.binding, entry.binding)) {
        return fault('cloud_runtime_owner_conflict', 'The model transport belongs to another Session.');
      }
      const cloudModel = runtimeOptions.cloudModel ?? { binding: entry.binding,
        send: async () => fault('cloud_model_transport_unavailable', 'The Authority model transport is unavailable.') };
      const runtime = await createDurableRuntime({ ...runtimeOptions, cloudModel, storage: session.storage });
      if (!runtime.ok) {
        return runtime;
      }
      return ok({ session, runtime: runtime.data });
    } catch {
      return fault('cloud_runtime_owner_conflict', 'The original native Session does not match its Authority binding.');
    }
  }

  function invoke<I extends DurableConversationIdentity, O>(operation: Operation, input: I,
    call: (runtime: DurableRuntimePort & { queue: CloudQueuePort }, request: I) => Promise<Result<O>>, recordIntent = true): Promise<Result<O>> {
    if (closing) return Promise.resolve(fault('cloud_runtime_closed', 'The cloud runtime is closing.'));
    const action = (async (): Promise<Result<O>> => {
      try {
        const request = structuredClone(input), identity = identitySchema.safeParse(request);
        if (!identity.success || identity.data.participant && identity.data.itemId === undefined)
          return fault('input_invalid', 'The original cloud Session identity is invalid.');
        const authorized = await authorization(operation, identity.data);
        if (!authorized.ok) return authorized;
        const grant = authorized.data;
        if (closing) return fault('cloud_runtime_closed', 'The cloud runtime is closing.');
        if (grant.binding.workId !== request.workId || grant.binding.sessionId !== request.sessionId)
          return fault('cloud_runtime_owner_conflict', 'The authorized owner does not match the original Session.');
        if (grant.state !== 'ready' && operation !== 'openConversation')
          return fault('cloud_runtime_not_ready', 'The original cloud Session has not been confirmed by the Authority.');
        if (grant.state !== 'ready' && identity.data.itemId !== undefined)
          return fault('cloud_runtime_not_ready', 'The original cloud Session must be confirmed before opening an invoice.');
        if (conflicts(grant.binding)) return fault('cloud_runtime_owner_conflict', 'The cloud runtime already belongs to another Session.');
        let entry = entries.get(grant.binding.cloudRuntimeId);
        if (!entry) {
          let created!: Entry;
          const opened = Promise.resolve().then(() => open(created, grant, operation, identity.data));
          created = { binding: grant.binding, nativeConversationId: null, ready: grant.state === 'ready', opened };
          entry = created; entries.set(grant.binding.cloudRuntimeId, entry);
          const original = entry;
          void entry.opened.then(result => { if (!result.ok && entries.get(grant.binding.cloudRuntimeId) === original) entries.delete(grant.binding.cloudRuntimeId); });
        }
        const opened = await entry.opened;
        if (!opened.ok) return opened;
        const confirmed = await authorization(operation, identity.data);
        if (!confirmed.ok) return confirmed;
        if (closing) return fault('cloud_runtime_closed', 'The cloud runtime is closing.');
        if (!isDeepStrictEqual(confirmed.data, grant))
          return fault('cloud_runtime_owner_conflict', 'The Authority changed the original cloud Session authorization.');
        if (grant.state === 'allocated' && entry.ready || grant.state === 'ready' && entry.nativeConversationId !== grant.nativeConversationId)
          return fault('cloud_runtime_owner_conflict', 'The original native Session does not match its Authority binding.');
        if (grant.state === 'ready') entry.ready = true;
        if (recordIntent && options.beforeSchedule && scheduling.has(operation)) {
          const planned = scheduledSchema.safeParse(identity.data);
          if (!planned.success) return fault('input_invalid', 'The original scheduling identity is invalid.');
          const saved = await options.beforeSchedule(structuredClone(grant.binding), opened.data.session, {
            workId: planned.data.workId, sessionId: planned.data.sessionId, attemptId: planned.data.attemptId,
            ...(planned.data.requestId === undefined ? {} : { requestId: planned.data.requestId }) });
          if (!saved.ok) return saved;
          const latest = await authorization(operation, identity.data); if (!latest.ok) return latest;
          if (closing) return fault('cloud_runtime_closed', 'The cloud runtime is closing.');
          if (!isDeepStrictEqual(latest.data, grant)) return fault('cloud_runtime_owner_conflict', 'The original scheduling authorization changed.');
        }
        const result = await call(opened.data.runtime, request);
        if (result.ok && operation === 'openConversation' && request.itemId === undefined) {
          const nativeId = (result.data as { nativeConversationId: number }).nativeConversationId;
          if (entry.nativeConversationId !== null && entry.nativeConversationId !== nativeId)
            return fault('cloud_runtime_owner_conflict', 'The native Session identity changed.');
          entry.nativeConversationId = nativeId;
        }
        return result;
      } catch { return fault('cloud_runtime_unavailable', 'The authorized cloud operation could not be confirmed.'); }
    })();
    inFlight.add(action); void action.then(() => inFlight.delete(action), () => inFlight.delete(action));
    return action;
  }

  async function childConversation(session: CloudRuntimeSession, root: ConversationId, input: DurableSubagentIdentity): Promise<ConversationId | undefined> {
    const storage = session.storage, task = await storage.task(input.nativeToolTaskId as TaskId, BACKGROUND_CONTEXT);
    if (!task) return undefined;
    if (task.conversationId !== root || task.kind !== ToolTask.definition.name || task.owner === undefined) throw Error('state_conflict');
    const call = z.object({ kind: z.literal('model'), assistant: id, callId: z.string() }).strict().parse(task.input);
    const assistant = (await storage.entry(call.assistant as EntryId, BACKGROUND_CONTEXT))?.entry;
    const message = assistant?.model?.[0];
    if (!assistant || assistant.conversationId !== root || assistant.byTaskId !== task.owner || message?.role !== 'assistant'
      || !message.content.some(block => block.type === 'toolCall' && block.id === call.callId && block.name === 'Agent')) throw Error('state_conflict');
    const submission = await storage.submissionByRequest(root, JSON.stringify([input.attemptId, input.requestId]), BACKGROUND_CONTEXT);
    if (submission?.type !== 'input' || submission.entry === undefined) throw Error('state_conflict');
    const entry = (await storage.entry(submission.entry, BACKGROUND_CONTEXT))?.entry;
    const original = z.object({ workId: id, sessionId: id, itemId: id.optional(), attemptId: id, requestId: z.string() }).passthrough().safeParse(entry?.data);
    if (entry?.kind !== 'flowmate.input' || entry.conversationId !== root || !original.success || original.data.workId !== input.workId
      || original.data.sessionId !== input.sessionId || original.data.itemId !== input.itemId
      || original.data.attemptId !== input.attemptId || original.data.requestId !== input.requestId)
      throw Error('state_conflict');
    const found = await storage.scanConversations({ ownerTaskId: task.id }, 2, undefined, BACKGROUND_CONTEXT);
    if (found.next || found.items.length > 1) throw Error('state_conflict');
    const child = found.items[0]; if (!child) return undefined;
    if (child.owner?.conversationId !== root || child.owner.taskId !== task.id) throw Error('state_conflict');
    const document = await storage.findDocument({ kind: 'flowmate.runtime.child', scope: { kind: 'conversation', conversationId: child.id } }, 'current', BACKGROUND_CONTEXT);
    const state = document && await storage.document(document.id, 'current', BACKGROUND_CONTEXT);
    if (!state || state.version !== 1 || typeof state.value.planJson !== 'string') throw Error('state_conflict');
    const plan = z.object({ workId: id, sessionId: id, itemId: id.optional(), attemptId: id, requestId: z.string(), childRunId: id, childSessionId: id,
      originToolCallId: id, nativeToolTaskId: id }).passthrough().parse(JSON.parse(state.value.planJson));
    const identity = { workId: plan.workId, sessionId: plan.sessionId, ...(plan.itemId === undefined ? {} : { itemId: plan.itemId }), attemptId: plan.attemptId, requestId: plan.requestId,
      childRunId: plan.childRunId, childSessionId: plan.childSessionId, originToolCallId: plan.originToolCallId, nativeToolTaskId: plan.nativeToolTaskId };
    if (!isDeepStrictEqual(identity, input)) throw Error('state_conflict');
    return child.id;
  }

  function history<I extends DurableConversationIdentity, O>(operation: 'queryHistory' | 'queryHistoryPage' | 'queryHistoryEntry' | 'resultStatus' | 'retryResult', input: I,
    call: (session: CloudRuntimeSession, root: ConversationId, request: I, binding: CloudRuntimeBinding) => Promise<Result<O>>): Promise<Result<O>> {
    if (closing) return Promise.resolve(fault('cloud_runtime_closed', 'The cloud runtime is closing.'));
    const action = (async (): Promise<Result<O>> => {
      try {
        const request = structuredClone(input), identity = identitySchema.safeParse(request);
        if (!identity.success || identity.data.participant && identity.data.itemId === undefined)
          return fault('input_invalid', 'The original cloud Session identity is invalid.');
        const authorized = await authorization(operation, identity.data); if (!authorized.ok) return authorized;
        const grant = authorized.data;
        if (grant.state !== 'ready') return fault('cloud_runtime_not_ready', 'The original cloud Session has not been confirmed by the Authority.');
        if (grant.binding.workId !== request.workId || grant.binding.sessionId !== request.sessionId || conflicts(grant.binding))
          return fault('cloud_runtime_owner_conflict', 'The authorized owner does not match the original Session.');
        const opened = await sessionFor(grant.binding, false); if (!opened.ok) return opened;
        const root = await opened.data.storage.conversation(grant.nativeConversationId as ConversationId, BACKGROUND_CONTEXT);
        const confirmed = await authorization(operation, identity.data);
        if (!confirmed.ok) return confirmed;
        if (closing) return fault('cloud_runtime_closed', 'The cloud runtime is closing.');
        if (!root || root.owner || !isDeepStrictEqual(confirmed.data, grant))
          return fault('cloud_runtime_owner_conflict', 'The original native Session does not match its Authority binding.');
        return await call(opened.data, root.id, request, grant.binding);
      } catch { return fault('cloud_runtime_unavailable', 'The authorized cloud history could not be confirmed.'); }
    })();
    inFlight.add(action); void action.then(() => inFlight.delete(action), () => inFlight.delete(action)); return action;
  }

  async function invoiceConversation(session: CloudRuntimeSession, input: DurableConversationIdentity): Promise<ConversationId | undefined> {
    let cursor: Cursor | undefined, found: ConversationId | undefined;
    do {
      const page = await session.storage.scanConversations({}, 100, cursor, BACKGROUND_CONTEXT);
      for (const conversation of page.items) {
        if (conversation.owner) continue;
        const document = await session.storage.findDocument({ kind: 'flowmate.runtime.binding',
          scope: { kind: 'conversation', conversationId: conversation.id } }, 'current', BACKGROUND_CONTEXT);
        const state = document && await session.storage.document(document.id, 'current', BACKGROUND_CONTEXT);
        const lane = state && cloudNativeLane(state);
        if (!state || !lane || state.value.workId !== input.workId || state.value.sessionId !== input.sessionId
          || lane.itemId !== input.itemId || lane.participant !== input.participant) continue;
        if (found !== undefined) throw Error('state_conflict');
        found = conversation.id;
      }
      cursor = page.next;
    } while (cursor);
    return found;
  }

  function reader(session: CloudRuntimeSession, root: ConversationId) {
    return createDurableHistoryReader({ storage: session.storage, read: action => action(), resolveOwner: async input => ({
      owner: { runtimeKind: 'durable', workId: input.workId, sessionId: input.child?.childSessionId ?? input.sessionId,
        childRunId: input.child?.childRunId ?? null, ...(input.itemId === undefined ? {} : { itemId: input.itemId }),
        ...(input.participant ? { participant: input.participant } : {}) },
      conversationId: input.child ? await (async () => {
        const parent = input.child!.itemId === undefined ? root : await invoiceConversation(session, { workId: input.workId,
          sessionId: input.sessionId, itemId: input.child!.itemId });
        return parent === undefined ? undefined : childConversation(session, parent, input.child!);
      })()
        : input.itemId === undefined ? root : await invoiceConversation(session, input),
    }) });
  }

  return {
    delivery: {
      status: input => history('resultStatus', input, async (session, root, raw) => {
        const parsed = CloudRuntimeStatusRequestSchema.safeParse(raw); if (!parsed.success) return fault('input_invalid', 'The cloud result status request is invalid.');
        const { workId, sessionId, attemptId, afterSubmissionId, limit } = parsed.data;
        const [wake, results, observation, tasks, submissions] = await Promise.all([session.readWake(), session.listResults({ attemptId, afterSubmissionId, limit }), session.readObservation(),
          session.storage.scanTasks({ conversationId: root, order: 'descending' }, 50, undefined, BACKGROUND_CONTEXT),
          session.storage.scanSubmissions({ conversationId: root, order: 'descending' }, 50, undefined, BACKGROUND_CONTEXT)]);
        if (!wake.ok) return wake; if (!results.ok) return results; if (!observation.ok) return observation;
        const original = wake.data?.attemptId === attemptId ? wake.data : null;
        return ok(CloudRuntimeStatusSchema.parse({ workId, sessionId, attemptId, runtimeGeneration, observationRevision: observation.data, results: results.data,
          native: { conversationId: root, tasks: tasks.items.map(task => ({ taskId: task.id, kind: task.kind, status: task.state.status, abortRequested: task.abortRequested })),
            moreTasks: Boolean(tasks.next), submissions: submissions.items.map(item => ({ submissionId: item.id, type: item.type, status: item.status })),
            moreSubmissions: Boolean(submissions.next) },
          wake: original ? { requestId: original.requestId, revision: original.revision, active: original.active, at: original.at, blocked: original.blocked } : null }));
      }),
      retry: input => history('retryResult', input, async (session, _root, raw, binding) => {
        const parsed = CloudRuntimeRetryRequestSchema.safeParse(raw); if (!parsed.success) return fault('input_invalid', 'The cloud result retry request is invalid.');
        const original = await session.retryResultByIdentity({ attemptId: parsed.data.attemptId, requestId: parsed.data.requestId,
          ...(parsed.data.itemId === undefined ? {} : { itemId: parsed.data.itemId }),
          ...(parsed.data.participant ? { participant: parsed.data.participant } : {}), nativeSubmissionId: parsed.data.nativeSubmissionId });
        if (!original.ok) return original;
        if (!options.onResultRetry) return fault('cloud_result_unavailable', 'The original result retry could not be scheduled.');
        const scheduled = await options.onResultRetry(binding, session); if (!scheduled.ok) return scheduled;
        return ok(CloudRuntimeRetryReceiptSchema.parse({ ...parsed.data, state: 'pending' }));
      }),
    },
    queue: {
      read: input => invoke('readQueue', input, (runtime, request) => runtime.queue.read(request)),
      apply: input => invoke('controlQueue', input, (runtime, request) => runtime.queue.apply(request)),
      queryControl: input => invoke('queryQueueControl', input, (runtime, request) => runtime.queue.queryControl(request)),
    },
    openConversation: input => invoke('openConversation', input, (runtime, request) => runtime.openConversation(request)),
    prepareModel: input => invoke('prepareModel', input, (runtime, request) => runtime.prepareModel(request)),
    restoreModel: input => invoke('restoreModel', input, (runtime, request) => runtime.restoreModel(request)),
    submit: input => invoke('submit', input, (runtime, request) => runtime.submit(request)),
    getSubmission: input => invoke('getSubmission', input, (runtime, request) => runtime.getSubmission(request)),
    observeSubmission: input => invoke('observeSubmission', input, (runtime, request) => runtime.observeSubmission(request)),
    observeSubagent: input => invoke('observeSubagent', input, (runtime, request) => runtime.observeSubagent(request)),
    waitForSubmission: input => invoke('waitForSubmission', input, (runtime, request) => runtime.waitForSubmission(request)),
    stopAttempt: input => invoke('stopAttempt', input, (runtime, request) => runtime.stopAttempt(request)),
    resumeAttempt: input => invoke('resumeAttempt', input, (runtime, request) => runtime.resumeAttempt(request)),
    queryHistory: input => history('queryHistory', input, async (session, root, raw) => {
      const parsed = z.object({ workId: id, sessionId: id, itemId: id.optional(), participant: z.literal('reviewer').optional(), limit: z.number().int().min(1).max(100).default(50), beforeEntryId: id.optional() }).strict().safeParse(raw);
      if (!parsed.success) return fault('input_invalid', 'The native history request is invalid.');
      const request = parsed.data, before = request.beforeEntryId;
      const conversationId = request.itemId === undefined ? root : await invoiceConversation(session, request);
      if (conversationId === undefined) return fault('session_not_found', 'The original invoice conversation is unavailable.');
      if (before !== undefined) {
        const entry = (await session.storage.entry(before as EntryId, BACKGROUND_CONTEXT))?.entry;
        if (!entry || entry.conversationId !== conversationId) return fault('state_conflict', 'The native history cursor does not belong to this Session.');
      }
      const page = await session.storage.scanEntries({ conversationId, order: 'descending',
        ...(before === undefined ? {} : { maxEntryId: before as EntryId }) }, request.limit + (before === undefined ? 0 : 1), undefined, BACKGROUND_CONTEXT);
      const entries = page.items.filter(entry => entry.id !== before).map(entry => ({ nativeEntryId: entry.id, kind: entry.kind, json: JSON.stringify(entry) }));
      return ok({ workId: request.workId, sessionId: request.sessionId, ...(request.itemId === undefined ? {} : { itemId: request.itemId }),
        ...(request.participant ? { participant: request.participant } : {}), nativeConversationId: conversationId, entries,
        nextBeforeEntryId: page.next && entries.length ? entries.at(-1)!.nativeEntryId : null });
    }),
    queryHistoryPage: input => history('queryHistoryPage', input, (session, root, request) => reader(session, root).queryHistoryPage(request)),
    queryHistoryEntry: input => history('queryHistoryEntry', input, (session, root, request) => reader(session, root).queryHistoryEntry(request)),
    recoverSession: input => invoke('queryHistory', input, async () => ok(undefined)),
    wakeSession: input => invoke('resumeAttempt', input, (runtime, request) => runtime.resumeAttempt(request), false),
    compact: input => invoke('compact', input, (runtime, request) => runtime.compact(request)),
    queryCompaction: input => invoke('queryCompaction', input, (runtime, request) => runtime.queryCompaction(request)),
    cancelCompaction: input => invoke('cancelCompaction', input, (runtime, request) => runtime.cancelCompaction(request)),
    close() {
      closing ??= (async () => {
        for (const entry of entries.values()) {
          const opened = await entry.opened; if (!opened.ok) continue;
          const runtime = await opened.data.runtime.close(); if (!runtime.ok) return runtime;
        }
        await Promise.all(inFlight);
        for (const entry of sessions.values()) {
          const opened = await entry.opened; if (!opened.ok) continue;
          const closed = await opened.data.close(); if (!closed.ok) return closed;
        }
        return ok(undefined);
      })();
      return closing;
    },
  };
}
