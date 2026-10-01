import { z } from 'zod';
import { appError, fail, ok } from './errors.ts';
import { AppErrorSchema } from './runtime.ts';
import type { DbId, ProviderConfig, Result } from './runtime.ts';
import { InvoiceFormTargetSchema } from './invoice.ts';
import type { InvoiceFormTarget } from './invoice.ts';
import { WorkspaceContextSchema, WorkspaceExpectationSchema } from './workspace.ts';
import type { WorkspaceExpectation } from './workspace.ts';
import { normalizeProviderConfig } from './schemas.ts';

const id = z.number().int().positive().max(Number.MAX_SAFE_INTEGER);
const providerConfig = z.unknown().transform((raw, context) => {
  const normalized = normalizeProviderConfig(raw);
  if (normalized.ok) return normalized.data;
  context.addIssue({ code: 'custom', message: 'Invalid model configuration.' });
  return z.NEVER;
});
export const SessionInputRequestSchema = z.object({
  sessionId: id, clientSequence: id, mode: z.literal('prompt'), goalMode: z.literal('fill-form'),
  text: z.string().refine(text => text.trim().length > 0 && new TextEncoder().encode(text).length <= 65_000),
  config: providerConfig, workspace: WorkspaceExpectationSchema, formTarget: InvoiceFormTargetSchema,
  timeoutMs: z.number().int().min(100).max(120_000).default(60_000),
  stopGraceMs: z.number().int().min(100).max(10_000).default(5000),
}).strict().refine(value => value.workspace.sessionId === value.sessionId
  && value.workspace.documentRef !== null && value.workspace.jobId !== null && value.workspace.candidateRef !== null,
'Fill requires the selected candidate in the same Session.');
export type SessionInputRequest = {
  sessionId: DbId; clientSequence: DbId; mode: 'prompt'; goalMode: 'fill-form'; text: string;
  config: ProviderConfig; workspace: WorkspaceExpectation; formTarget: InvoiceFormTarget;
  timeoutMs?: number; stopGraceMs?: number;
};
export type NormalizedSessionInputRequest = z.output<typeof SessionInputRequestSchema>;
export function normalizeSessionInputRequest(raw: unknown): Result<NormalizedSessionInputRequest> {
  const parsed = SessionInputRequestSchema.safeParse(raw);
  return parsed.success ? ok(parsed.data) : fail(appError('input_invalid', 'input', 'Fill input is invalid.'));
}
export const SessionInputQuerySchema = z.object({ sessionId: id, clientSequence: id.optional() }).strict();
export type SessionInputQuery = z.infer<typeof SessionInputQuerySchema>;
export const SessionInputContentSchema = z.object({ version: z.literal(1), text: z.string(),
  workspaceContext: WorkspaceContextSchema, allowedDocumentIds: z.array(id), allowedArtifactIds: z.array(id),
}).strict();
export const SessionInputSnapshotSchema = z.object({ inputId: id, sessionId: id, clientSequence: id,
  mode: z.literal('prompt'), goalMode: z.literal('fill-form'), runId: id.nullable(),
  content: SessionInputContentSchema,
  status: z.enum(['queued', 'consumed', 'failed', 'cancelled', 'delivery_unknown']),
  processingStatus: z.enum(['pending', 'completed', 'failed', 'cancelled']),
  nativeEntryId: z.string().min(1).nullable(), dispatchedAt: z.string().datetime().nullable(),
  error: AppErrorSchema.nullable(), createdAt: z.string().datetime(), updatedAt: z.string().datetime(),
}).strict();
export type SessionInputSnapshot = z.infer<typeof SessionInputSnapshotSchema>;
export const SessionInputQueryResultSchema = z.object({ input: SessionInputSnapshotSchema.nullable(),
  nextClientSequence: id.nullable() }).strict();
export type SessionInputQueryResult = z.infer<typeof SessionInputQueryResultSchema>;
