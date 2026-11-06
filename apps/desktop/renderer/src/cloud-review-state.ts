import { z } from 'zod';
import { appError, CloudReviewAcceptRequestSchema, CloudReviewRejectRequestSchema, CloudReviewSaveRequestSchema, CloudWorkspaceIdSchema,
  fail, InvoiceFormDraftSchema, InvoiceFormLineOriginsSchema, ok, type Result } from '@flowmate/contracts';
import { PersonalReviewTargetSchema } from './personal-state.ts';

const id = z.number().int().positive().max(Number.MAX_SAFE_INTEGER);
const pending = z.discriminatedUnion('type', [
  z.object({ type: z.literal('cloud_review_save'), input: CloudReviewSaveRequestSchema }).strict(),
  z.object({ type: z.literal('cloud_review_accept'), input: CloudReviewAcceptRequestSchema }).strict(),
  z.object({ type: z.literal('cloud_review_reject'), input: CloudReviewRejectRequestSchema }).strict(),
]);
export const CloudReviewDraftSchema = z.object({ version: z.literal(1), target: PersonalReviewTargetSchema,
  candidateId: id, sequence: id, workspaceRevision: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER).nullable(),
  draft: InvoiceFormDraftSchema, lineOrigins: InvoiceFormLineOriginsSchema,
  baseline: InvoiceFormDraftSchema, baselineLineOrigins: InvoiceFormLineOriginsSchema, pending: pending.nullable() }).strict().superRefine((value, context) => {
  const target = value.target, input = value.pending?.input;
  if (target.jobId === null || target.candidateRef === null || value.lineOrigins.length !== value.draft.lines.length
    || value.baselineLineOrigins.length !== value.baseline.lines.length || value.lineOrigins.some(origin => origin !== null && origin >= value.baseline.lines.length))
    context.addIssue({ code: 'custom', message: 'The cloud review draft is inconsistent.' });
  if (input && (input.workId !== target.workId || input.itemId !== target.itemId || input.documentRef.id !== target.documentRef.id
    || input.documentRef.version !== target.documentRef.version || input.request.jobId !== target.jobId
    || input.request.expectedCandidateId !== value.candidateId || input.request.expectedRevision !== value.workspaceRevision
    || ('candidateId' in input.request ? input.request.candidateId !== value.candidateId : input.request.basedOnCandidateId !== value.candidateId)))
    context.addIssue({ code: 'custom', message: 'The pending review belongs to another original candidate.' });
});
export type CloudReviewDraft = z.infer<typeof CloudReviewDraftSchema>;
const key = (workspaceId: string) => `flowmate.personal-agent.cloud-review.v1.${CloudWorkspaceIdSchema.parse(workspaceId)}`;
export function readCloudReviewDraft(storage: Pick<Storage, 'getItem'>, workspaceId: string): Result<CloudReviewDraft | null> {
  try {
    const raw = storage.getItem(key(workspaceId)); if (raw === null) return ok(null);
    if (new TextEncoder().encode(raw).byteLength > 4 * 1024 * 1024) throw Error('cloud_review_too_large');
    return ok(CloudReviewDraftSchema.parse(JSON.parse(raw)));
  } catch { return fail(appError('cloud_review_draft_unavailable', 'storage', 'The original cloud review draft could not be verified.', true)); }
}
export function saveCloudReviewDraft(storage: Pick<Storage, 'setItem'>, workspaceId: string, raw: unknown): boolean {
  try {
    const value = JSON.stringify(CloudReviewDraftSchema.parse(raw));
    if (new TextEncoder().encode(value).byteLength > 4 * 1024 * 1024) return false;
    storage.setItem(key(workspaceId), value); return true;
  } catch { return false; }
}
export function clearCloudReviewDraft(storage: Pick<Storage, 'removeItem'>, workspaceId: string): boolean {
  try { storage.removeItem(key(workspaceId)); return true; } catch { return false; }
}
