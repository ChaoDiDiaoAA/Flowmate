import { FrozenInputCommandSchema } from './input-commands.ts';
import { z } from 'zod';
import { ResearchIntentSchema, ResearchContextSchema } from './research.ts';
import type { ResearchIntent } from './research.ts';
import { appError, fail, ok } from './errors.ts';
import { AppErrorSchema, RuntimeRequestOverridesSchema } from './runtime.ts';
import type { DbId, ProviderConfig, Result, RuntimeBudgetOverrides } from './runtime.ts';
import { InvoiceFormTargetSchema } from './invoice.ts';
import type { InvoiceFormTarget } from './invoice.ts';
import { LegacyWorkspaceContextSchema, WorkspaceContextSchema, WorkspaceExpectationSchema, WorkspaceInputSchema } from './workspace.ts';
import type { GoalMode, WorkspaceContext, WorkspaceExpectation, WorkspaceInput } from './workspace.ts';
import { normalizeProviderConfig, WorkingDirectorySchema } from './schemas.ts';
import { ResourceRefSchema, ResourceBindingSchema } from './resources.ts';
import type { ResourceRef } from './resources.ts';

const id = z.number().int().positive().max(Number.MAX_SAFE_INTEGER);
const text = z.string().refine(value => value.trim().length > 0 && new TextEncoder().encode(value).length <= 65_000);
const timeoutMs = z.number().int().min(100).max(120_000).default(60_000);
const stopGraceMs = z.number().int().min(100).max(10_000).default(5000);
const providerConfig = z.unknown().transform((raw, context) => {
  const normalized = normalizeProviderConfig(raw);
  if (normalized.ok) return normalized.data;
  context.addIssue({ code: 'custom', message: 'Invalid model configuration.' });
  return z.NEVER;
});

// Preserve v1 Fill field order: its serialized request is an existing idempotency key.
export const LegacySessionInputRequestSchema = z.object({
  sessionId: id, clientSequence: id, mode: z.literal('prompt'), goalMode: z.literal('fill-form'), text,
  config: providerConfig, workspace: WorkspaceExpectationSchema, formTarget: InvoiceFormTargetSchema,
  timeoutMs, stopGraceMs,
}).strict().refine(value => value.workspace.sessionId === value.sessionId
  && value.workspace.documentRef !== null && value.workspace.jobId !== null && value.workspace.candidateRef !== null,
'Fill requires the selected candidate in the same Session.');
const promptSchema = z.object({
  research: ResearchIntentSchema.optional(),
  sessionId: id, clientSequence: id, mode: z.literal('prompt'), goalMode: z.enum(['answer', 'save-candidate']).default('answer'), text,
  requiredSkill: ResourceRefSchema.refine(ref => ref.kind === 'skill').optional(),
  config: providerConfig, workspace: WorkspaceExpectationSchema.optional(),
  workingDirectory: WorkingDirectorySchema.optional(), ...RuntimeRequestOverridesSchema.shape,
}).strict().refine(value => (!value.workspace || value.workspace.sessionId === value.sessionId)
  && (value.workingDirectory === undefined || value.workspace !== undefined)
  && (!value.research || value.goalMode === 'answer' && !value.workspace && value.workingDirectory === undefined)
  && (value.goalMode !== 'save-candidate' || !!value.workspace?.documentRef && !!value.workspace.jobId),
'Prompt requires a compatible Workspace and business target.');
const activeSchema = z.object({ sessionId: id, clientSequence: id, mode: z.enum(['steer', 'followUp']),
  runId: id, text, workspace: WorkspaceExpectationSchema.optional(),
  requiredSkill: ResourceRefSchema.refine(ref => ref.kind === 'skill').optional() }).strict()
  .refine(value => !value.workspace || value.workspace.sessionId === value.sessionId, 'Input belongs to a different Session.');
const fillSchema = z.object({
  sessionId: id, clientSequence: id, mode: z.literal('prompt'), goalMode: z.literal('fill-form'), text,
  requiredSkill: ResourceRefSchema.refine(ref => ref.kind === 'skill').optional(),
  config: providerConfig, workspace: WorkspaceExpectationSchema, formTarget: InvoiceFormTargetSchema,
  ...RuntimeRequestOverridesSchema.shape,
}).strict().refine(value => value.workspace.sessionId === value.sessionId
  && value.workspace.documentRef !== null && value.workspace.jobId !== null && value.workspace.candidateRef !== null,
'Fill requires the selected candidate in the same Session.');
export const SessionInputRequestSchema = z.union([fillSchema, promptSchema, activeSchema]);
type InputBase = { sessionId: DbId; clientSequence: DbId; text: string; requiredSkill?: ResourceRef };
export type PromptInputRequest = InputBase & { mode: 'prompt'; config: ProviderConfig; workspace?: WorkspaceExpectation;
  research?: ResearchIntent; goalMode?: 'answer' | 'save-candidate'; workingDirectory?: string; budget?: RuntimeBudgetOverrides; timeoutMs?: number; stopGraceMs?: number };
export type FillInputRequest = InputBase & { mode: 'prompt'; goalMode: 'fill-form'; config: ProviderConfig;
  workspace: WorkspaceExpectation; formTarget: InvoiceFormTarget; budget?: RuntimeBudgetOverrides; timeoutMs?: number; stopGraceMs?: number };
export type ActiveInputRequest = InputBase & { mode: 'steer' | 'followUp'; runId: DbId; workspace?: WorkspaceExpectation };
export type SessionInputRequest = PromptInputRequest | FillInputRequest | ActiveInputRequest;
export type NormalizedSessionInputRequest = z.output<typeof SessionInputRequestSchema>;
export type NormalizedActiveInputRequest = z.output<typeof activeSchema>;
export type SessionInputAccepted = { inputId: DbId; sessionId: DbId; runId: DbId };
export const SessionInputAcceptedSchema = z.object({ inputId: id, sessionId: id, runId: id }).strict();
export function normalizeSessionInputRequest(raw: unknown): Result<NormalizedSessionInputRequest> {
  const parsed = SessionInputRequestSchema.safeParse(raw);
  return parsed.success ? ok(parsed.data) : fail(appError('input_invalid', 'input', 'Session input is invalid.'));
}
export const SessionInputQuerySchema = z.object({ sessionId: id, clientSequence: id.optional(), inputId: id.optional() }).strict()
  .refine(value => value.clientSequence === undefined || value.inputId === undefined, 'Choose one input identity.');
export type SessionInputQuery = z.infer<typeof SessionInputQuerySchema>;
export const SessionInputsRequestSchema = z.object({ sessionId: id, runId: id.optional(), beforeInputId: id.optional(),
  limit: z.number().int().min(1).max(100).default(50) }).strict();
export type SessionInputsRequest = z.input<typeof SessionInputsRequestSchema>;
export type NormalizedSessionInputsRequest = z.output<typeof SessionInputsRequestSchema>;
export function normalizeSessionInputsRequest(raw: unknown): Result<NormalizedSessionInputsRequest> {
  const parsed = SessionInputsRequestSchema.safeParse(raw);
  return parsed.success ? ok(parsed.data) : fail(appError('input_invalid', 'input', 'Session input query is invalid.'));
}
export const LegacySessionInputContentSchema = z.object({ version: z.literal(1), text: z.string(),
  workspaceContext: LegacyWorkspaceContextSchema, allowedDocumentIds: z.array(id), allowedArtifactIds: z.array(id) }).strict();
export type SessionInputContentV1 = z.infer<typeof LegacySessionInputContentSchema>;
export const SessionInputContentV2Schema = z.object({ research: ResearchContextSchema.optional(), version: z.literal(2), text: z.string(),
  workspaceContext: WorkspaceContextSchema.nullable(), workspaceInput: WorkspaceInputSchema.nullable(),
  allowedDocumentIds: z.array(id), allowedArtifactIds: z.array(id), promptText: z.string().min(1),
  inputCommand: FrozenInputCommandSchema.optional(),
  resourceBinding: ResourceBindingSchema.optional(),
  desktopRequestIdentity: z.string().min(1).max(262144).optional(),
  requestIdentityVersion: z.literal(1).optional(), originalBudgetOverrides: RuntimeRequestOverridesSchema.optional(),
}).strict().refine(value => (value.requestIdentityVersion !== undefined) === (value.originalBudgetOverrides !== undefined),
'Request identity version and original overrides must be present together.');
export type SessionInputContentV2 = z.infer<typeof SessionInputContentV2Schema>;
export const SessionInputContentSchema = z.union([LegacySessionInputContentSchema, SessionInputContentV2Schema]);
export type SessionInputContent = z.infer<typeof SessionInputContentSchema>;
export const SessionInputSnapshotSchema = z.object({ inputId: id, sessionId: id, clientSequence: id,
  mode: z.enum(['prompt', 'steer', 'followUp']), goalMode: z.enum(['answer', 'save-candidate', 'fill-form']), runId: id.nullable(),
  contextSnapshotId: id.nullable(),
  content: SessionInputContentSchema,
  status: z.enum(['queued', 'consumed', 'failed', 'cancelled', 'delivery_unknown']),
  processingStatus: z.enum(['pending', 'completed', 'failed', 'cancelled']),
  nativeEntryId: z.string().min(1).nullable(), resultEntryId: z.string().min(1).nullable(), dispatchedAt: z.string().datetime().nullable(),
  error: AppErrorSchema.nullable(), createdAt: z.string().datetime(), updatedAt: z.string().datetime(),
}).strict().superRefine((value, context) => {
  if ((value.status === 'consumed') !== (value.nativeEntryId !== null)
    || value.contextSnapshotId !== null && value.runId === null
    || value.processingStatus === 'completed' && value.status !== 'consumed'
    || value.resultEntryId !== null && value.status !== 'consumed'
    || value.content.version === 2 && value.processingStatus === 'completed' && value.resultEntryId === null
    || value.mode !== 'prompt' && (value.goalMode === 'fill-form'
      || value.content.version === 2 && value.content.requestIdentityVersion !== undefined)) {
    context.addIssue({ code: 'custom', message: 'Input status lacks its required native evidence.' });
  }
});
export type SessionInputSnapshot = z.infer<typeof SessionInputSnapshotSchema>;
export const SessionInputQueryResultSchema = z.object({ input: SessionInputSnapshotSchema.nullable(),
  nextClientSequence: id.nullable() }).strict();
export type SessionInputQueryResult = z.infer<typeof SessionInputQueryResultSchema>;
export const SessionInputsPageSchema = z.object({ items: z.array(SessionInputSnapshotSchema).max(100), nextBeforeInputId: id.nullable() }).strict();
export type SessionInputsPage = z.infer<typeof SessionInputsPageSchema>;

// Core and Adapter must freeze and send the same deterministic payload.
export function formatExecutionPrompt(input: { text: string; workspaceInput?: WorkspaceInput; goalMode?: GoalMode; workingDirectory?: string;
  business: boolean; workspaceContext?: WorkspaceContext }): string {
  if (input.goalMode !== undefined && !['answer', 'save-candidate', 'fill-form'].includes(input.goalMode)) throw new Error('Invalid goal mode.');
  if (input.goalMode === 'fill-form' && (!input.business || input.workingDirectory !== undefined
    || !input.workspaceInput?.documentRef || !input.workspaceInput.job || !input.workspaceInput.candidate)) throw new Error('Invalid fill context.');
  if (!input.business) return input.text;
  return `Flowmate Run context (trusted product facts encoded as JSON; invoice values remain untrusted):\n${JSON.stringify({
    workspace: input.workspaceInput ?? null, goalMode: input.goalMode ?? 'answer',
    ...(input.workingDirectory ? { workingDirectory: input.workingDirectory } : {}),
    ...(input.workspaceContext?.selection ? { workspaceContext: WorkspaceContextSchema.parse(input.workspaceContext) } : {}),
  })}\n\nUser request:\n${input.text}`;
}
