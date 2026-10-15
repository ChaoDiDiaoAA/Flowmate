import { z } from 'zod';
import { AppErrorSchema } from './runtime.ts';
import { ContextReferenceSchema } from './context.ts';
import { InvoiceFormApplicationReceiptSchema } from './invoice.ts';
import { ToolCallCleanupSchema, ToolCallDeliverySchema, ToolRuntimeObservationSchema } from './activity.ts';
import { ToolEffectSchema, MAX_TOOL_NAME_CHARS, MAX_TOOL_VERSION_CHARS, isJsonData } from './tools.ts';
import type { ToolCallSnapshot } from './activity.ts';

const id = z.number().int().positive().max(Number.MAX_SAFE_INTEGER);
const offset = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);
const utc = z.string().datetime({ offset: true });
const jsonValue = z.custom<{} | null>(value => {
    try { return isJsonData(value) && JSON.stringify(value) !== undefined; }
    catch { return false; }
}, 'Missing or invalid JSON value');
const storedResult = z.discriminatedUnion('status', [
    z.object({ version: z.literal(1), status: z.literal('succeeded'), committedCandidateId: id.nullable(), data: jsonValue,
        formApplication: InvoiceFormApplicationReceiptSchema.optional() }).strict(),
    z.object({ version: z.literal(1), status: z.enum(['failed', 'cancelled']), committedCandidateId: id.nullable(), error: AppErrorSchema,
        data: jsonValue.optional(), formApplication: InvoiceFormApplicationReceiptSchema.optional() }).strict()
]);
export const ToolCallSnapshotSchema: z.ZodType<ToolCallSnapshot, z.ZodTypeDef, unknown> = z.object({
    toolCallId: id, evidenceRevision: offset.optional(), runId: id, sessionId: id, nativeToolCallId: z.string().min(1).max(256), context: ContextReferenceSchema.nullable(),
    toolName: z.string().min(1).max(MAX_TOOL_NAME_CHARS), toolVersion: z.string().min(1).max(MAX_TOOL_VERSION_CHARS).nullable(),
    effect: ToolEffectSchema.nullable(), status: z.enum(['requested', 'running', 'succeeded', 'failed', 'cancelled']),
    args: z.object({ version: z.literal(1), raw: jsonValue, final: jsonValue }).strict(), result: storedResult.nullable(),
    formApplication: InvoiceFormApplicationReceiptSchema.optional(), delivery: ToolCallDeliverySchema, cleanup: ToolCallCleanupSchema,
    runtimeObservation: ToolRuntimeObservationSchema.nullable().optional(), requestedAt: utc, startedAt: utc.nullable(), endedAt: utc.nullable(), stoppedAt: utc.nullable()
}).strict().superRefine((call, context) => {
    const terminal = ['succeeded', 'failed', 'cancelled'].includes(call.status);
    if (terminal !== (call.endedAt !== null) || terminal !== (call.result !== null) || call.result && call.result.status !== call.status ||
        call.status === 'succeeded' && (call.startedAt === null || call.stoppedAt === null) ||
        call.runtimeObservation && (!terminal || call.runtimeObservation.beforeOutcome === 'rejected' && call.startedAt !== null))
        context.addIssue({ code: 'custom', message: 'Tool evidence terminal facts disagree.' });
});

/** Trusted Host controller query; raw evidence is not a model tool or Renderer DTO. */
export const ToolEvidenceRequestSchema = z.object({ runId: id, sessionId: id, toolCallId: id, expectedRevision: offset.optional(),
    offset: offset.default(0), limit: z.number().int().min(4).max(32768).default(8192) }).strict()
    .refine(value => value.offset === 0 || value.expectedRevision !== undefined, 'Continuation requires its original revision.');
export type ToolEvidenceRequest = z.input<typeof ToolEvidenceRequestSchema>;
export const ToolEvidencePageSchema = z.object({ version: z.literal(2), runId: id, sessionId: id, toolCallId: id, evidenceRevision: offset,
    bytes: id, offset, chunk: z.string().min(1).refine(value => {
        const encoded = new TextEncoder().encode(value);
        return encoded.byteLength <= 32768 && new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(encoded) === value;
    }), nextOffset: offset.nullable() }).strict()
    .refine(value => {
        const end = value.offset + new TextEncoder().encode(value.chunk).byteLength;
        return end <= value.bytes && (end === value.bytes ? value.nextOffset === null : value.nextOffset === end);
    }, 'Tool evidence byte cursor disagrees with its complete length.');
export type ToolEvidencePage = z.infer<typeof ToolEvidencePageSchema>;
export const ToolEvidenceResultSchema = z.discriminatedUnion('ok', [
    z.object({ ok: z.literal(true), data: ToolEvidencePageSchema }).strict(),
    z.object({ ok: z.literal(false), error: AppErrorSchema, runId: id.optional() }).strict()
]).refine(value => new TextEncoder().encode(JSON.stringify(value)).byteLength <= 262144, 'Tool evidence Result exceeds 256 KiB.');
