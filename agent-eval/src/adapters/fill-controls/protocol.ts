import { z } from 'zod';
import { WorkspaceExpectationSchema } from '../../../../packages/contracts/src/workspace.ts';
import { RunScopeSchema } from '../../../../packages/contracts/src/tools.ts';
import { WorkspaceContextSchema } from '../../../../packages/contracts/src/workspace.ts';
import { InvoiceFormBridgeRequestSchema, InvoiceFormApplicationReceiptSchema, InvoiceFormTargetSchema } from '../../../../packages/contracts/src/invoice.ts';
import { invoiceFormInspectionSchema } from '../../../../apps/desktop/main/invoice-form-bridge.ts';

export const fillRunSchema = z.object({ kind: z.literal('agent'), runId: z.number().int().positive(), sessionId: z.number().int().positive(),
    jobId: z.number().int().positive(), config: z.object({ goalMode: z.literal('fill-form'), formTarget: InvoiceFormTargetSchema,
        workspaceContext: WorkspaceContextSchema }).strict(), scope: RunScopeSchema,
    status: z.enum(['created', 'running', 'completed', 'failed', 'cancelled']), cancelRequestedAt: z.string().datetime().nullable() }).strict();
export const fillCommandSchema = z.discriminatedUnion('action', [
    z.object({ action: z.literal('open'), workspace: WorkspaceExpectationSchema.refine(value => !!value.documentRef && !!value.jobId && !!value.candidateRef),
        epoch: z.number().int().positive() }).strict(),
    z.object({ action: z.literal('request'), request: InvoiceFormBridgeRequestSchema, run: fillRunSchema, epoch: z.number().int().positive() }).strict(),
    z.object({ action: z.literal('inspect') }).strict(),
    z.object({ action: z.literal('cancel') }).strict(),
    z.object({ action: z.literal('close') }).strict(),
]);
export const fillEnvelopeSchema = z.object({ requestId: z.string().uuid(), command: fillCommandSchema }).strict();
export const fillResultSchema = z.object({ target: InvoiceFormTargetSchema.optional(), inspection: invoiceFormInspectionSchema.optional(),
    receipt: InvoiceFormApplicationReceiptSchema.optional(), closed: z.literal(true).optional() }).strict();
export const fillResponseSchema = z.object({ requestId: z.string().uuid(), result: fillResultSchema.optional(), error: z.string().max(256).optional() }).strict()
    .refine(value => (value.result === undefined) !== (value.error === undefined));
export type FillCommand = z.infer<typeof fillCommandSchema>;
