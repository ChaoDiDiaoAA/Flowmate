import { z } from 'zod';
import type { Result } from './runtime.ts';

const id = z.number().int().positive().max(Number.MAX_SAFE_INTEGER);
const requestId = z.string().min(1).max(128);
const text = z.string().min(1).refine(value => new TextEncoder().encode(value).byteLength <= 262_144);
const instruction = z.string().min(1).max(22_000).refine(value => new TextEncoder().encode(value).byteLength <= 22_000);
export const CloudQueueOwnerSchema = z.object({ workId: id, sessionId: id, itemId: id.optional(), attemptId: id }).strict();
export const CloudQueueActionSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('cancel'), submissionId: id }).strict(),
  z.object({ kind: z.literal('edit'), submissionId: id, content: instruction }).strict(),
  z.object({ kind: z.literal('mode'), submissionId: id, mode: z.enum(['steer', 'followUp']) }).strict(),
  z.object({ kind: z.literal('reorder'), submissionIds: z.array(id).max(100)
    .refine(values => new Set(values).size === values.length) }).strict(),
  z.object({ kind: z.literal('enqueue'), phaseRequestId: requestId, mode: z.enum(['steer', 'followUp']), content: instruction }).strict(),
]);
export const CloudQueueControlSchema = CloudQueueOwnerSchema.extend({ controlRequestId: requestId,
  expectedVersion: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER), action: CloudQueueActionSchema }).strict();
export const CloudQueueControlQuerySchema = CloudQueueOwnerSchema.extend({ controlRequestId: requestId }).strict();
export const CloudQueueViewSchema = CloudQueueOwnerSchema.extend({ version: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
  activePhaseRequestId: requestId.nullable().optional(),
  items: z.array(z.object({ submissionId: id, requestId, mode: z.enum(['steer', 'followUp']), content: text }).strict()).max(100) }).strict();
export const CloudQueueReceiptSchema = CloudQueueControlQuerySchema.extend({ status: z.enum(['applied', 'conflict']),
  version: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER), submissionId: id.optional() }).strict();
export const CloudQueuePlacedInputSchema = z.object({ controlRequestId: requestId, submissionId: id, entryId: id.nullable(), content: instruction }).strict();
export const CloudQueueVerifyInputsSchema = CloudQueueOwnerSchema.extend({ requestId,
  items: z.array(CloudQueuePlacedInputSchema).max(100) }).strict().refine(value =>
  new Set(value.items.map(item => item.controlRequestId)).size === value.items.length
    && new Set(value.items.map(item => item.submissionId)).size === value.items.length
    && value.items.every((item, index) => index === 0 || (item.entryId === null && value.items[index - 1]!.entryId === null
      ? item.submissionId > value.items[index - 1]!.submissionId : item.entryId !== null && value.items[index - 1]!.entryId !== null
        && item.entryId > value.items[index - 1]!.entryId!))
    && new TextEncoder().encode(JSON.stringify(value)).byteLength <= 262_144);
export const CloudQueueInstructionSchema = z.object({ provenance: z.literal('user-provided'), controlRequestId: requestId,
  submissionId: id, content: instruction }).strict();
export type CloudQueueVerifyInputs = z.infer<typeof CloudQueueVerifyInputsSchema>;
export type CloudQueueInstruction = z.infer<typeof CloudQueueInstructionSchema>;
export type CloudQueueOwner = z.infer<typeof CloudQueueOwnerSchema>;
export type CloudQueueControl = z.infer<typeof CloudQueueControlSchema>;
export type CloudQueueControlQuery = z.infer<typeof CloudQueueControlQuerySchema>;
export type CloudQueueView = z.infer<typeof CloudQueueViewSchema>;
export type CloudQueueReceipt = z.infer<typeof CloudQueueReceiptSchema>;
export function matchesCloudQueueReceipt(input: CloudQueueControl, receipt: CloudQueueReceipt): boolean {
  return receipt.workId === input.workId && receipt.sessionId === input.sessionId && receipt.attemptId === input.attemptId
    && receipt.itemId === input.itemId
    && receipt.controlRequestId === input.controlRequestId
    && (receipt.status !== 'applied' || receipt.version === input.expectedVersion + 1)
    && (input.action.kind === 'enqueue' && receipt.status === 'applied' ? receipt.submissionId !== undefined : receipt.submissionId === undefined);
}
export type CloudQueuePort = {
  read(input: CloudQueueOwner): Promise<Result<CloudQueueView>>;
  apply(input: CloudQueueControl): Promise<Result<CloudQueueReceipt>>;
  queryControl(input: CloudQueueControlQuery): Promise<Result<CloudQueueReceipt | null>>;
};
