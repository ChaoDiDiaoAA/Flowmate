import { z } from 'zod';
import { DocumentRefSchema, StoredCandidateDraftSchema, CheckResultSchema, InvoiceIssueSchema, SourceRefSchema } from '../../../packages/contracts/src/invoice.ts';
import { ContextReferenceSchema } from '../../../packages/contracts/src/context.ts';

const id = z.number().int().positive().max(Number.MAX_SAFE_INTEGER), time = z.string().datetime();
export const documentSchema = z.object({ documentRef: DocumentRefSchema, displayName: z.string(), isHidden: z.boolean(),
    status: z.enum(['available', 'unavailable']), pageCount: id, originalArtifactId: id, parsedArtifactId: id,
    warnings: z.array(z.string()), unavailableReason: z.string().nullable(), createdAt: time, updatedAt: time }).strict();
export const jobSchema = z.object({ jobId: id, documentRef: DocumentRefSchema, goal: z.string(),
    status: z.enum(['pending', 'running', 'waiting', 'completed', 'failed', 'cancelled']), reason: z.string().nullable(),
    currentCandidateId: id.nullable(), acceptedCandidateId: id.nullable(), createdAt: time, updatedAt: time }).strict();
export const candidateSummarySchema = z.object({ candidateId: id, context: ContextReferenceSchema.nullable(), jobId: id, runId: id.nullable(),
    origin: z.enum(['model', 'human_edit']).optional(), basedOnCandidateId: id.nullable().optional(), sequence: id,
    status: z.enum(['generated', 'accepted', 'rejected']), issueCount: z.number().int().nonnegative(), createdAt: time }).strict();
export const candidateSchema = candidateSummarySchema.extend({ ...StoredCandidateDraftSchema.shape, toolCallId: id.nullable(),
    checks: z.array(CheckResultSchema), issues: z.array(InvoiceIssueSchema), sources: z.array(SourceRefSchema) }).strict();
export const invoiceExportSchema = z.object({ artifactId: id, candidateId: id, format: z.enum(['json', 'csv', 'markdown']),
    relativePath: z.string().regex(/^outputs\/invoice-[1-9]\d*-result-[1-9]\d*\.(json|csv|md)$/),
    bytes: id.max(64 * 1024 * 1024), sha256: z.string().regex(/^[a-f0-9]{64}$/), createdAt: time }).strict();
