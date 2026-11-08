import { isDeepStrictEqual } from 'node:util';
import { z } from 'zod';
import { appError, AppErrorSchema, CloudQueueControlQuerySchema, CloudQueueControlSchema, CloudQueueOwnerSchema, CloudQueueReceiptSchema,
  CloudQueueViewSchema, CloudRuntimeRetryReceiptSchema, CloudRuntimeRetryRequestSchema, CloudRuntimeStatusRequestSchema, CloudRuntimeStatusSchema,
  DurableCompactionObservationSchema, DurableModelBindingSchema, fail, matchesCloudQueueReceipt, ok,
  PersonalHistoryEntrySchema, PersonalHistoryPageSchema, type CloudQueuePort, type CloudRuntimeDeliveryPort, type DurableRuntimePort, type Result } from '@flowmate/contracts';
import { callCloudUnixRpc } from './cloud-unix-rpc.ts';

export const CLOUD_RUNTIME_RPC_METHODS = ['openConversation', 'prepareModel', 'restoreModel', 'submit', 'getSubmission', 'observeSubmission', 'observeSubagent',
  'waitForSubmission', 'stopAttempt', 'resumeAttempt', 'queryHistory', 'queryHistoryPage', 'queryHistoryEntry',
  'compact', 'queryCompaction', 'cancelCompaction', 'readQueue', 'controlQueue', 'queryQueueControl', 'resultStatus', 'retryResult'] as const;
const envelope = z.object({ version: z.literal(1), method: z.enum(CLOUD_RUNTIME_RPC_METHODS), input: z.unknown() }).strict();
type Method = typeof CLOUD_RUNTIME_RPC_METHODS[number];
const reply = z.discriminatedUnion('ok', [z.object({ ok: z.literal(true), data: z.unknown().optional() }).strict(),
  z.object({ ok: z.literal(false), error: AppErrorSchema, runId: z.number().int().positive().optional() }).strict()]);
const id = z.number().int().positive().max(Number.MAX_SAFE_INTEGER);
const owner = { workId: id, sessionId: id }, conversation = { ...owner, itemId: id.optional() },
  attempt = { ...owner, attemptId: id }, phase = { ...attempt, itemId: id.optional(), requestId: z.string().min(1).max(128) };
const submission = z.object({ ...phase, nativeConversationId: id, nativeSubmissionId: id,
  status: z.enum(['queued', 'placed', 'done', 'unanswered']), answer: z.string().nullable(), reason: z.string().nullable() }).strict();
const observation = z.object({ ...phase, nativeConversationId: id, nativeSubmissionId: id, nativeEntryId: id.nullable(),
  status: z.enum(['queued', 'placed', 'done', 'unanswered']), consumedAt: z.string().datetime({ offset: true }).nullable(),
  execution: z.enum(['active', 'closed', 'unknown']) }).strict();
export const CloudSubagentObservationSchema = z.object({ ...phase, childRunId: id, childSessionId: id, originToolCallId: id, nativeToolTaskId: id,
  creation: z.enum(['created', 'not-started', 'unknown']), nativeConversationId: id.nullable(), nativeSubmissionId: id.nullable(),
  status: z.enum(['queued', 'placed', 'done', 'unanswered']).nullable(), answer: z.string().nullable(), reason: z.string().nullable(),
  consumedAt: z.string().datetime({ offset: true }).nullable(), execution: z.enum(['active', 'closed', 'unknown']),
  creatorExecution: z.enum(['active', 'closed', 'unknown']), parentToolResultEntryId: id.nullable(), parentModelTaskId: id.nullable(),
  parentModelReceivedAt: z.string().datetime({ offset: true }).nullable() }).strict();
const history = z.object({ ...conversation, nativeConversationId: id,
  entries: z.array(z.object({ nativeEntryId: id, kind: z.string().min(1).max(256), json: z.string() }).strict()).max(100),
  nextBeforeEntryId: id.nullable() }).strict();
const invalid = () => fail(appError('cloud_runtime_response_invalid', 'runtime', 'The original Runtime response could not be verified.', true));

/** Only the fixed Durable port is exposed; shutdown is controlled by the Runtime service itself. */
export function createCloudRuntimeRpcHandler(runtime: DurableRuntimePort & { queue?: CloudQueuePort; delivery?: CloudRuntimeDeliveryPort }): (raw: unknown) => Promise<unknown> {
  return async raw => {
    const request = envelope.safeParse(raw);
    if (!request.success) return fail(appError('input_invalid', 'input', 'The cloud Runtime request is invalid.'));
    const input = request.data.input;
    try {
      switch (request.data.method) {
        case 'resultStatus': { const parsed = CloudRuntimeStatusRequestSchema.safeParse(input);
          return parsed.success && runtime.delivery ? await runtime.delivery.status(parsed.data) : invalid(); }
        case 'retryResult': { const parsed = CloudRuntimeRetryRequestSchema.safeParse(input);
          return parsed.success && runtime.delivery ? await runtime.delivery.retry(parsed.data) : invalid(); }
        case 'readQueue': {
          const parsed = CloudQueueOwnerSchema.safeParse(input);
          return parsed.success && runtime.queue ? await runtime.queue.read(parsed.data) : invalid();
        }
        case 'controlQueue': {
          const parsed = CloudQueueControlSchema.safeParse(input);
          return parsed.success && runtime.queue ? await runtime.queue.apply(parsed.data) : invalid();
        }
        case 'queryQueueControl': {
          const parsed = CloudQueueControlQuerySchema.safeParse(input);
          return parsed.success && runtime.queue ? await runtime.queue.queryControl(parsed.data) : invalid();
        }
        case 'openConversation': return await runtime.openConversation(input as Parameters<DurableRuntimePort['openConversation']>[0]);
        case 'prepareModel': return await runtime.prepareModel(input as Parameters<DurableRuntimePort['prepareModel']>[0]);
        case 'restoreModel': return await runtime.restoreModel(input as Parameters<DurableRuntimePort['restoreModel']>[0]);
        case 'submit': return await runtime.submit(input as Parameters<DurableRuntimePort['submit']>[0]);
        case 'getSubmission': return await runtime.getSubmission(input as Parameters<DurableRuntimePort['getSubmission']>[0]);
        case 'observeSubmission': return await runtime.observeSubmission(input as Parameters<DurableRuntimePort['observeSubmission']>[0]);
        case 'observeSubagent': return await runtime.observeSubagent(input as Parameters<DurableRuntimePort['observeSubagent']>[0]);
        case 'waitForSubmission': return await runtime.waitForSubmission(input as Parameters<DurableRuntimePort['waitForSubmission']>[0]);
        case 'stopAttempt': return await runtime.stopAttempt(input as Parameters<DurableRuntimePort['stopAttempt']>[0]);
        case 'resumeAttempt': return await runtime.resumeAttempt(input as Parameters<DurableRuntimePort['resumeAttempt']>[0]);
        case 'queryHistory': return await runtime.queryHistory(input as Parameters<DurableRuntimePort['queryHistory']>[0]);
        case 'queryHistoryPage': return await runtime.queryHistoryPage(input as Parameters<DurableRuntimePort['queryHistoryPage']>[0]);
        case 'queryHistoryEntry': return await runtime.queryHistoryEntry(input as Parameters<DurableRuntimePort['queryHistoryEntry']>[0]);
        case 'compact': return await runtime.compact(input as Parameters<DurableRuntimePort['compact']>[0]);
        case 'queryCompaction': return await runtime.queryCompaction(input as Parameters<DurableRuntimePort['queryCompaction']>[0]);
        case 'cancelCompaction': return await runtime.cancelCompaction(input as Parameters<DurableRuntimePort['cancelCompaction']>[0]);
      }
    } catch { return invalid(); }
  };
}

/** Authority closes only this client; the Runtime keeps ownership of its Sessions. */
export function createCloudRuntimeRpcClient(socketPath: string): DurableRuntimePort & { queue: CloudQueuePort; delivery: CloudRuntimeDeliveryPort } {
  const pending = new Set<AbortController>(); let closed = false;
  async function invoke<T>(method: Method, raw: { workId: number; sessionId: number }, schema: z.ZodTypeAny): Promise<Result<T>> {
    if (closed) return fail(appError('cloud_runtime_closed', 'runtime', 'The cloud Runtime client is closed.'));
    let input: typeof raw;
    try { input = structuredClone(raw); } catch { return fail(appError('input_invalid', 'input', 'The cloud Runtime request is invalid.')); }
    const controller = new AbortController(); pending.add(controller);
    try {
      const queue = method === 'readQueue' || method === 'controlQueue' || method === 'queryQueueControl' || method === 'resultStatus' || method === 'retryResult';
      const signal = queue ? AbortSignal.any([controller.signal, AbortSignal.timeout(30_000)]) : controller.signal;
      const sent = await callCloudUnixRpc(socketPath, { version: 1, method, input }, signal);
      if (!sent.ok) return sent;
      const parsed = reply.safeParse(sent.data); if (!parsed.success) return invalid();
      if (!parsed.data.ok) return fail(parsed.data.error);
      const data = schema.safeParse(parsed.data.data); if (!data.success) return invalid();
      if (data.data !== null && data.data !== undefined && typeof data.data === 'object') {
        const value = data.data as Record<string, unknown>, source = input as Record<string, unknown>;
        for (const key of ['workId', 'sessionId', 'attemptId', 'requestId', 'controlRequestId', 'nativeSubmissionId', 'operationId', 'childRunId', 'childSessionId', 'originToolCallId', 'nativeToolTaskId'])
          if (key in value && key in source && value[key] !== source[key]) return invalid();
        if ('child' in value && 'child' in source && !isDeepStrictEqual(value.child, source.child)) return invalid();
        if ('owner' in value) {
          const returned = value.owner as { workId: number; sessionId: number; childRunId: number | null; itemId?: number };
          const expectedChild = source.child as { childRunId: number; childSessionId: number } | undefined;
          if (returned.workId !== input.workId || returned.sessionId !== (expectedChild?.childSessionId ?? input.sessionId)
            || returned.childRunId !== (expectedChild?.childRunId ?? null) || returned.itemId !== source.itemId) return invalid();
        }
        if (['openConversation', 'submit', 'getSubmission', 'observeSubmission', 'observeSubagent', 'waitForSubmission', 'queryHistory', 'compact', 'queryCompaction', 'cancelCompaction'].includes(method)
          && value.itemId !== source.itemId) return invalid();
        if (method === 'queryHistoryEntry' && (value.entryId !== source.entryId || value.throughEntryId !== source.throughEntryId
          || value.offset !== (source.offset ?? 0) || typeof value.text !== 'string'
          || new TextEncoder().encode(value.text).byteLength > Number(source.limit ?? 16384))) return invalid();
        if (method === 'queryHistoryPage') {
          const entries = value.entries as Array<{ entryId: number }>;
          if (source.throughEntryId !== undefined && value.throughEntryId !== source.throughEntryId
            || entries.length > Number(source.limit ?? 50)
            || source.beforeEntryId !== undefined && entries.some(entry => entry.entryId >= Number(source.beforeEntryId))) return invalid();
        }
        if (method === 'queryHistory') {
          const entries = value.entries as Array<{ nativeEntryId: number }>;
          if (entries.length > Number(source.limit ?? 50) || entries.some((entry, index) =>
            index > 0 && entry.nativeEntryId >= entries[index - 1]!.nativeEntryId
            || source.beforeEntryId !== undefined && entry.nativeEntryId >= Number(source.beforeEntryId))) return invalid();
        }
        if (method === 'stopAttempt' && (value.stopped === true) === (value.reason === 'stop-unconfirmed')) return invalid();
        if (method === 'controlQueue') {
          const control = CloudQueueControlSchema.safeParse(input), receipt = CloudQueueReceiptSchema.safeParse(value);
          if (!control.success || !receipt.success || !matchesCloudQueueReceipt(control.data, receipt.data)) return invalid();
        }
        if (method === 'readQueue') {
          const items = value.items as Array<{ submissionId: number }>;
          if (value.itemId !== source.itemId || new Set(items.map(item => item.submissionId)).size !== items.length) return invalid();
        }
        if (method === 'queryQueueControl' && value.itemId !== source.itemId) return invalid();
        if (method === 'retryResult' && value.itemId !== source.itemId) return invalid();
        if (method === 'resultStatus') {
          const page = value.results as { items: Array<{ nativeSubmissionId: number }> };
          if (page.items.length > Number(source.limit ?? 50) || source.afterSubmissionId !== undefined
            && page.items.some(item => item.nativeSubmissionId <= Number(source.afterSubmissionId))) return invalid();
        }
        if (method === 'prepareModel' && !isDeepStrictEqual(value.configuration, source.config)) return invalid();
      }
      return ok(data.data as T);
    } finally { pending.delete(controller); }
  }
  const voidSchema = z.undefined();
  const same = <T>(method: Method, input: { workId: number; sessionId: number }, schema: z.ZodTypeAny) => invoke<T>(method, input, schema);
  return {
    delivery: { status: input => same('resultStatus', input, CloudRuntimeStatusSchema),
      retry: input => same('retryResult', input, CloudRuntimeRetryReceiptSchema) },
    queue: {
      read: input => same('readQueue', input, CloudQueueViewSchema),
      apply: input => same('controlQueue', input, CloudQueueReceiptSchema),
      queryControl: input => same('queryQueueControl', input, CloudQueueReceiptSchema.nullable()),
    },
    openConversation: input => same('openConversation', input, z.object({ ...conversation, nativeConversationId: id }).strict()),
    prepareModel: input => same('prepareModel', input, DurableModelBindingSchema),
    restoreModel: input => same('restoreModel', input, voidSchema),
    submit: input => same('submit', input, submission),
    getSubmission: input => same('getSubmission', input, submission.nullable()),
    observeSubmission: input => same('observeSubmission', input, observation.nullable()),
    observeSubagent: input => same('observeSubagent', input, CloudSubagentObservationSchema.nullable()),
    waitForSubmission: input => same('waitForSubmission', input, submission),
    stopAttempt: input => same('stopAttempt', input, z.object({ ...attempt, stopped: z.boolean(),
      reason: z.enum(['stopped', 'not-started', 'stop-unconfirmed']) }).strict()),
    resumeAttempt: input => same('resumeAttempt', input, voidSchema),
    queryHistory: input => same('queryHistory', input, history),
    queryHistoryPage: input => same('queryHistoryPage', input, PersonalHistoryPageSchema),
    queryHistoryEntry: input => same('queryHistoryEntry', input, PersonalHistoryEntrySchema),
    compact: input => same('compact', input, DurableCompactionObservationSchema),
    queryCompaction: input => same('queryCompaction', input, DurableCompactionObservationSchema.nullable()),
    cancelCompaction: input => same('cancelCompaction', input, DurableCompactionObservationSchema),
    close: async () => { closed = true; for (const controller of pending) controller.abort(); return ok(undefined); },
  };
}
