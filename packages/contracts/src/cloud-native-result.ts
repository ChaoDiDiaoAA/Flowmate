import { z } from 'zod';
import { CloudRuntimeBindingSchema } from './durable-runtime.ts';
import { CloudQueueOwnerSchema } from './cloud-queue.ts';
import type { Result } from './runtime.ts';
import { RUNTIME_CONFIG } from './runtime-config.ts';

const id = z.number().int().positive().max(Number.MAX_SAFE_INTEGER);
const participant = z.literal('reviewer').optional();
const bytes = (value: string) => new TextEncoder().encode(value).byteLength;
export const CloudNativeResultSchema = CloudRuntimeBindingSchema.extend({ version: z.literal(1), itemId: id.optional(), participant, attemptId: id,
  requestId: z.string().min(1).max(128), nativeConversationId: id, nativeSubmissionId: id,
  nativeInputEntryId: id.nullable(), nativeAnswerEntryId: id.nullable(), consumedAt: z.string().datetime({ offset: true }).nullable(),
  status: z.enum(['done', 'unanswered']), answer: z.string().refine(value => bytes(value) <= RUNTIME_CONFIG.llmPayload.maxOutputTextBytes).nullable(),
  reason: z.string().max(8192).nullable() }).strict()
  .refine(value => value.status === 'done' ? value.nativeAnswerEntryId !== null && value.answer !== null && value.reason === null
    : value.nativeAnswerEntryId === null && value.answer === null, 'A terminal result must retain its actual native answer or unanswered reason.')
  .refine(value => value.consumedAt === null || value.nativeInputEntryId !== null, 'Consumption requires the original native input.')
  .refine(value => !value.participant || value.itemId !== undefined && (value.status !== 'done' || value.consumedAt !== null));
export type CloudNativeResult = z.infer<typeof CloudNativeResultSchema>;
const oversizedIdentity = CloudRuntimeBindingSchema.extend({ version: z.literal(1), itemId: id.optional(), participant, attemptId: id,
  requestId: z.string().min(1).max(128), nativeConversationId: id, nativeSubmissionId: id,
  consumedAt: z.string().datetime({ offset: true }).nullable() });
export const CloudNativeOversizedResultSchema = z.discriminatedUnion('status', [
  oversizedIdentity.extend({ status: z.literal('done'), nativeInputEntryId: id, nativeAnswerEntryId: id,
    answerBytes: z.number().int().min(RUNTIME_CONFIG.llmPayload.maxOutputTextBytes + 1).max(Number.MAX_SAFE_INTEGER) }).strict(),
  oversizedIdentity.extend({ status: z.literal('unanswered'), nativeInputEntryId: id.nullable(), nativeAnswerEntryId: z.null(),
    reasonLength: z.number().int().min(8193).max(Number.MAX_SAFE_INTEGER) }).strict(),
]).refine(value => (value.consumedAt === null || value.nativeInputEntryId !== null)
  && (!value.participant || value.itemId !== undefined && (value.status !== 'done' || value.consumedAt !== null)));
export type CloudNativeOversizedResult = z.infer<typeof CloudNativeOversizedResultSchema>;
export const CloudNativeResultReceiptSchema = z.object({ receiptId: z.string().uuid(), cloudRuntimeId: z.string().uuid(),
  workId: id, sessionId: id, itemId: id.optional(), participant, nativeConversationId: id, nativeSubmissionId: id }).strict()
  .refine(value => !value.participant || value.itemId !== undefined);
export type CloudNativeResultReceipt = z.infer<typeof CloudNativeResultReceiptSchema>;
const requestId = z.string().min(1).max(128);
export const CloudRuntimeNoticeSchema = CloudRuntimeBindingSchema.extend({ runtimeGeneration: z.string().uuid(),
  observationRevision: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER) }).strict();
export type CloudRuntimeNotice = z.infer<typeof CloudRuntimeNoticeSchema>;
export const CloudResultPageRequestSchema = z.object({ attemptId: id, afterSubmissionId: id.optional(),
  limit: z.number().int().min(1).max(100).default(50) }).strict();
export const CloudResultDeliverySchema = z.object({ requestId, itemId: id.optional(), participant, nativeSubmissionId: id,
  state: z.enum(['pending', 'blocked', 'delivered']), attempts: z.number().int().min(0).max(8),
  nextAt: z.string().datetime({ offset: true }).nullable(), nativeStatus: z.enum(['done', 'unanswered']),
  blockedReason: z.enum(['size_limit', 'retry_limit']).optional() }).strict()
  .refine(value => (value.blockedReason === undefined || value.state === 'blocked') && (!value.participant || value.itemId !== undefined));
export const CloudResultPageSchema = z.object({ items: z.array(CloudResultDeliverySchema).max(100), nextAfterSubmissionId: id.nullable() }).strict()
  .refine(value => value.items.every((item, index) => index === 0 || item.nativeSubmissionId > value.items[index - 1]!.nativeSubmissionId)
    && (value.nextAfterSubmissionId === null || value.items.length > 0 && value.nextAfterSubmissionId === value.items.at(-1)!.nativeSubmissionId));
export const CloudResultRetryIdentitySchema = z.object({ attemptId: id, itemId: id.optional(), participant, requestId, nativeSubmissionId: id }).strict()
  .refine(value => !value.participant || value.itemId !== undefined);
const deliveryOwner = CloudQueueOwnerSchema.omit({ itemId: true });
export const CloudRuntimeStatusRequestSchema = deliveryOwner.extend({ afterSubmissionId: id.optional(),
  limit: z.number().int().min(1).max(100).default(50) }).strict();
export const CloudRuntimeStatusSchema = deliveryOwner.extend({
  runtimeGeneration: z.string().uuid(), observationRevision: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
  native: z.object({ conversationId: id, tasks: z.array(z.object({ taskId: id, kind: z.string().min(1).max(256),
    status: z.enum(['pending', 'running', 'waiting', 'sleeping', 'completing', 'terminal']), abortRequested: z.boolean() }).strict()).max(50),
    moreTasks: z.boolean(), submissions: z.array(z.object({ submissionId: id, type: z.enum(['input', 'write']),
      status: z.enum(['queued', 'placed', 'done', 'unanswered']) }).strict()).max(50), moreSubmissions: z.boolean() }).strict(),
  wake: z.object({ requestId: requestId.nullable(), revision: id, active: z.boolean(),
    at: z.number().int().nonnegative().max(8_640_000_000_000_000).nullable(), blocked: z.boolean() }).strict().nullable(),
  results: CloudResultPageSchema }).strict();
const retry = CloudQueueOwnerSchema.extend({ requestId, participant, nativeSubmissionId: id }).strict();
export const CloudRuntimeRetryRequestSchema = retry.refine(value => !value.participant || value.itemId !== undefined);
export const CloudRuntimeRetryReceiptSchema = retry.extend({ state: z.literal('pending') }).strict()
  .refine(value => !value.participant || value.itemId !== undefined);
export type CloudResultPage = z.infer<typeof CloudResultPageSchema>;
export type CloudResultPageRequest = z.input<typeof CloudResultPageRequestSchema>;
export type CloudResultRetryIdentity = z.infer<typeof CloudResultRetryIdentitySchema>;
export type CloudRuntimeStatusRequest = z.input<typeof CloudRuntimeStatusRequestSchema>;
export type CloudRuntimeStatus = z.infer<typeof CloudRuntimeStatusSchema>;
export type CloudRuntimeRetryRequest = z.infer<typeof CloudRuntimeRetryRequestSchema>;
export type CloudRuntimeRetryReceipt = z.infer<typeof CloudRuntimeRetryReceiptSchema>;
export type CloudRuntimeDeliveryPort = {
  status(input: CloudRuntimeStatusRequest): Promise<Result<CloudRuntimeStatus>>;
  retry(input: CloudRuntimeRetryRequest): Promise<Result<CloudRuntimeRetryReceipt>>;
};
