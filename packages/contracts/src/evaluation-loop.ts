import { z } from 'zod';

const identity = z.string().min(1).max(200);
const revision = z.number().int().positive().max(Number.MAX_SAFE_INTEGER);
const userText = z.string().refine(value => value.trim().length > 0, 'User input must contain text');
export const TraceMaterialSchema = z.object({ id: identity, path: z.string().min(1).optional(), text: z.string().optional(),
  content: z.string().optional(), encoding: z.enum(['utf8', 'base64']).optional() }).strict();
export const TraceBundleSchema = z.object({
  id: z.string().uuid(), revision,
  source: z.object({ kind: z.enum(['evaluation', 'product']), executionId: identity.optional(), trialId: identity.optional(),
    runId: identity.optional(), sessionId: identity.optional(), userId: identity.optional(), operationId: z.string().uuid().optional(), productRoot: z.string().min(1).max(32768).optional() }).strict(),
  entry: z.enum(['chats', 'invoices', 'research', 'evaluation']), startedAt: z.string().datetime(), endedAt: z.string().datetime().nullable(),
  input: z.object({ prompt: userText, turns: z.array(z.object({ id: z.string().regex(/^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/),
    role: z.literal('user'), content: userText, mode: z.enum(['prompt', 'followUp', 'steer']).optional() }).strict()).optional(),
    materials: z.array(z.unknown()).optional() }).strict(),
  output: z.unknown(), status: z.enum(['PASS', 'FAIL', 'ERROR', 'UNJUDGEABLE', 'NOT_RUN', 'completed', 'failed', 'timeout', 'cancelled', 'error', 'running', 'not-started']),
  complete: z.boolean(), gaps: z.array(z.string().min(1)), configuration: z.record(z.unknown()), events: z.array(z.unknown()),
  facts: z.record(z.unknown()), materials: z.array(TraceMaterialSchema),
}).strict().superRefine((value, context) => {
  if (new Set(value.materials.map(item => item.id)).size !== value.materials.length)
    context.addIssue({ code: 'custom', message: 'Duplicate trace material identity' });
  if (new Set(value.input.turns?.map(item => item.id)).size !== (value.input.turns?.length ?? 0))
    context.addIssue({ code: 'custom', message: 'Duplicate trace user turn identity' });
});
export type TraceBundle = z.infer<typeof TraceBundleSchema>;

export const CurationTargetSchema = z.object({ kind: z.enum(['trace-feedback', 'candidate-review']), id: z.string().uuid(), revision }).strict();
export const CurationFeedbackRequestSchema = z.object({ operationId: z.string().uuid(), target: CurationTargetSchema,
  reviewer: z.string().trim().min(1), source: z.enum(['human', 'agent']), verdict: z.enum(['good', 'bad', 'approve', 'reject', 'needs-work']),
  note: z.string().trim().min(1) }).strict();
export type CurationFeedbackRequest = z.infer<typeof CurationFeedbackRequestSchema>;
