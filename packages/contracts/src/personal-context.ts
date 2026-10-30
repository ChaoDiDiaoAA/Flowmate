import { z } from 'zod';
import { AcceptInvoiceCandidateRequestSchema, DocumentRefSchema } from './invoice.ts';
import { InvoiceCandidateFieldPathSchema, WorkspaceExpectationSchema } from './workspace.ts';
import { RegisteredToolNameSchema } from './tools.ts';
import { RUNTIME_CONFIG } from './runtime-config.ts';
import { RESOURCE_LIMITS, ResourceRefSchema } from './resources.ts';
import { InvoiceWorkActionSchema, InvoiceWorkChildReferenceSchema, InvoiceWorkContinueReceiptSchema,
  InvoiceWorkItemViewSchema, InvoiceWorkSourceLocatorSchema, InvoiceWorkStatusSchema, InvoiceWorkSupplementReceiptSchema,
  InvoiceWorkSupplementRequestSchema, InvoiceWorkTodoViewSchema, InvoiceWorkViewSchema } from './personal-agent.ts';

const id = z.number().int().positive().max(Number.MAX_SAFE_INTEGER);
const revision = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);
const text = z.string().max(22_000).refine(value => new TextEncoder().encode(value).byteLength <= 22_000);
const requestId = z.string().min(1).max(128).refine(value => value.trim().length > 0);
const time = z.string().datetime({ offset: true });
const candidateRef = WorkspaceExpectationSchema.shape.candidateRef;
const documents = z.array(DocumentRefSchema).refine(values => new Set(values.map(value => value.id)).size === values.length,
  'A phase needs one current version of each material.').readonly();
const inputIds = z.array(id).refine(values => new Set(values).size === values.length, 'Input identities must be unique.').readonly();
const sources = z.array(InvoiceWorkSourceLocatorSchema).readonly();

export const InvoiceWorkPhaseBasisSchema = z.object({
  contextSnapshotId: id.nullable(), inputIds, documentRefs: documents, configurationRevision: revision, itemRevision: revision.nullable(),
}).strict().readonly();
export type InvoiceWorkPhaseBasis = z.infer<typeof InvoiceWorkPhaseBasisSchema>;
export const InvoiceWorkContextPhaseSchema = z.object({
  phaseId: id, workId: id, attemptId: id, itemId: id.nullable(), requestId, kind: z.literal('prompt'),
  basis: InvoiceWorkPhaseBasisSchema, createdAt: time,
  nativeConversationId: id.nullable(), nativeSubmissionId: id.nullable(), consumedAt: time.nullable(),
}).strict().readonly();
export type InvoiceWorkContextPhase = z.infer<typeof InvoiceWorkContextPhaseSchema>;

export const InvoiceWorkAuthorizedContextInputSchema = z.object({
  inputId: id, request: InvoiceWorkSupplementRequestSchema, receipt: InvoiceWorkSupplementReceiptSchema,
  continuedBy: InvoiceWorkContinueReceiptSchema.nullable(),
}).strict().readonly();
export type InvoiceWorkAuthorizedContextInput = z.infer<typeof InvoiceWorkAuthorizedContextInputSchema>;
export const InvoiceWorkHistoricalInputReferenceSchema = z.object({
  inputId: id, request: InvoiceWorkSupplementRequestSchema, receipt: InvoiceWorkSupplementReceiptSchema, continuedBy: InvoiceWorkContinueReceiptSchema.nullable(),
  consumedPhase: InvoiceWorkContextPhaseSchema,
}).strict().readonly();
export type InvoiceWorkHistoricalInputReference = z.infer<typeof InvoiceWorkHistoricalInputReferenceSchema>;

const businessFields = { kind: z.enum(['candidate', 'validation', 'user-edit', 'acceptance']), workId: id, itemId: id,
  documentRef: DocumentRefSchema, jobId: id, candidateRef: candidateRef.unwrap(),
  acceptRequest: AcceptInvoiceCandidateRequestSchema.optional() };
const validBusinessReference = (value: { kind: string; candidateRef: { id: number; sequence: number };
  jobId: number; acceptRequest?: z.infer<typeof AcceptInvoiceCandidateRequestSchema> }) => value.kind === 'acceptance'
  ? value.acceptRequest?.jobId === value.jobId && value.acceptRequest.candidateId === value.candidateRef.id
    && value.acceptRequest.expectedCandidateId === value.candidateRef.id : value.acceptRequest === undefined;
export const InvoiceWorkContextBusinessReferenceSchema = z.object(businessFields).strict()
  .refine(validBusinessReference, 'An acceptance reference needs the original matching business request.').readonly();
export type InvoiceWorkContextBusinessReference = z.infer<typeof InvoiceWorkContextBusinessReferenceSchema>;

const conflictFields = { workId: id, itemId: id, fieldPath: InvoiceCandidateFieldPathSchema.nullable(),
  origin: z.enum(['rule', 'model', 'user']), problem: z.string().min(1).max(2048), sourceRefs: sources, inputIds };
export const InvoiceWorkContextConflictSchema = z.object(conflictFields).strict()
  .refine(value => value.sourceRefs.length + value.inputIds.length >= 2, 'A conflict needs its opposing original references.').readonly();
export type InvoiceWorkContextConflict = z.infer<typeof InvoiceWorkContextConflictSchema>;
const reportFields = { child: InvoiceWorkChildReferenceSchema, candidateRef, fieldPath: InvoiceCandidateFieldPathSchema.nullable(),
  summary: text.refine(value => value.trim().length > 0), documentRefs: documents, inputIds, sourceRefs: sources };
export const InvoiceWorkContextModelReportSchema = z.object(reportFields).strict().readonly();
export type InvoiceWorkContextModelReport = z.infer<typeof InvoiceWorkContextModelReportSchema>;

const remainingBudget = z.object({
  modelCalls: revision.max(RUNTIME_CONFIG.ranges.maxModelCalls.max), toolCalls: revision.max(RUNTIME_CONFIG.ranges.maxToolCalls.max),
  toolFeedbackBytes: revision.max(RUNTIME_CONFIG.runBudget.maxToolFeedbackBytes), timeoutMs: revision.max(RUNTIME_CONFIG.ranges.timeoutMs.max),
  childSlots: revision.max(4),
}).strict().readonly();
const tools = z.array(RegisteredToolNameSchema).refine(values => new Set(values).size === values.length, 'Tools must be unique.').readonly();

const instructionBody = z.string().refine(value => new TextEncoder().encode(value).byteLength <= RESOURCE_LIMITS.bodyBytes
  && !/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(value), 'Instruction bodies must be bounded UTF-8 resource text.');
const promptInstruction = z.object({ ref: ResourceRefSchema.refine(ref => ref.kind === 'prompt'),
  path: z.literal('prompt.md'), text: instructionBody }).strict().readonly();
const skillInstruction = z.object({ ref: ResourceRefSchema.refine(ref => ref.kind === 'skill'),
  path: z.literal('SKILL.md'), text: instructionBody }).strict().readonly();
/** Configuration and selected resource instructions; these are never invoice evidence or execution authority. */
export const InvoiceWorkPhaseInstructionsSchema = z.object({
  version: z.literal(1), role: z.enum(['invoice-master', 'invoice-evidence-checker']), provenance: z.literal('phase-instructions'), preferences: text,
  resources: z.object({ bundleId: z.string().uuid(), prompt: promptInstruction.nullable(),
    skills: z.array(skillInstruction).max(RESOURCE_LIMITS.packages).readonly(),
  }).strict().refine(value => value.skills.length + Number(value.prompt !== null) <= RESOURCE_LIMITS.packages
    && new Set(value.skills.map(skill => skill.ref.id)).size === value.skills.length,
  'Only the selected version of each instruction resource may be included.').readonly().nullable(),
}).strict().readonly();
export type InvoiceWorkPhaseInstructions = z.infer<typeof InvoiceWorkPhaseInstructionsSchema>;

/** work/item and the working data are the saved phase snapshot; current is used only for live rejection checks. */
export const InvoiceWorkContextBuildInputSchema = z.object({
  phase: InvoiceWorkContextPhaseSchema, work: InvoiceWorkViewSchema, item: InvoiceWorkItemViewSchema,
  current: z.object({ work: InvoiceWorkViewSchema, item: InvoiceWorkItemViewSchema,
    configurationRevision: revision, documentRefs: documents }).strict().readonly(),
  authorizedInputs: z.array(InvoiceWorkAuthorizedContextInputSchema).readonly(),
  historicalInputReferences: z.array(InvoiceWorkHistoricalInputReferenceSchema).readonly(), todos: z.array(InvoiceWorkTodoViewSchema).readonly(),
  confirmedBusinessReferences: z.array(InvoiceWorkContextBusinessReferenceSchema).readonly(),
  conflicts: z.array(InvoiceWorkContextConflictSchema).readonly(), modelReports: z.array(InvoiceWorkContextModelReportSchema).readonly(),
  evidenceRefs: sources, allowedTools: tools, remainingBudget,
}).strict().readonly();
export type InvoiceWorkContextBuildInput = z.infer<typeof InvoiceWorkContextBuildInputSchema>;

const provenance = z.enum(['business-rule', 'model-self-report', 'user-provided']);
export const InvoiceWorkWorkingContextSchema = z.object({
  version: z.literal(1), runtimeKind: z.literal('durable'), inputUse: z.literal('phase-bound-only'),
  instructions: InvoiceWorkPhaseInstructionsSchema.optional(),
  delegation: z.object({ childRunId: id, childSessionId: id, parentRunId: id, originToolCallId: id,
    role: z.literal('invoice-evidence-checker'), prompt: z.string().min(1).max(65_000)
      .refine(value => new TextEncoder().encode(value).byteLength <= 65_000),
    description: z.string().min(1).max(512).refine(value => new TextEncoder().encode(value).byteLength <= 512),
  }).strict().readonly().optional(),
  work: z.object({ workId: id, personalAgentId: id, sessionId: id, goal: text.refine(value => value.trim().length > 0),
    status: InvoiceWorkStatusSchema, counts: z.object({ total: id, unresolved: revision, accepted: revision,
      rejected: revision, excluded: revision }).strict().readonly() }).strict().readonly(),
  phase: z.object({ phaseId: id, attemptId: id, requestId, basis: InvoiceWorkPhaseBasisSchema }).strict().readonly(),
  item: InvoiceWorkItemViewSchema,
  userInputs: z.array(z.object({ provenance: z.literal('user-provided'), inputId: id, requestId, todoId: id,
    text, documentRefs: documents }).strict().readonly()).readonly(),
  historicalInputReferences: z.array(z.object({ provenance: z.literal('historical-user-input-reference'), inputId: id,
    requestId, todoId: id, phaseId: id, attemptId: id, consumedAt: time,
    content: z.object({ provenance: z.literal('user-provided'), text, documentRefs: documents }).strict().readonly().optional(),
  }).strict().readonly()).readonly(),
  confirmedBusinessReferences: z.array(z.object({ ...businessFields,
    provenance: z.enum(['business-record-reference', 'user-provided']) }).strict().refine(validBusinessReference)).readonly(),
  todos: z.array(z.object({ provenance, todo: InvoiceWorkTodoViewSchema }).strict().readonly()).readonly(),
  conflicts: z.array(z.object({ ...conflictFields, provenance }).strict().readonly()).readonly(),
  modelReports: z.array(z.object({ ...reportFields, provenance: z.literal('model-self-report') }).strict().readonly()).readonly(),
  actions: z.object({ authorizesExecution: z.literal(false), tools, available: z.array(InvoiceWorkActionSchema).readonly(),
    remainingBudget }).strict().readonly(),
  waitingReason: z.string().max(2048).nullable(), evidenceRefs: sources,
}).strict().readonly();
export type InvoiceWorkWorkingContext = z.infer<typeof InvoiceWorkWorkingContextSchema>;
