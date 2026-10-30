import { z } from 'zod';
import { ResolvedEvaluationBudgetSchema, EvaluationBudgetProfilesSchema } from './evaluation-budget.ts';
import { AppErrorSchema, RuntimeBudgetOverridesSchema, type Result } from './runtime.ts';
import { ResourceSelectionSchema } from './resources.ts';
import { ExtensionSelectionSchema } from './extensions.ts';

export const EvaluationIdSchema = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._-]{0,199}$/);
const executionId = EvaluationIdSchema.max(128);
const revision = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);
const page = { offset: revision.default(0), limit: z.number().int().min(1).max(200).default(50) };
const textPage = { offset: revision.default(0), limit: z.number().int().min(1).max(32_000).default(16_000) };

export const EvaluationApiSchema = z.enum(['openai-completions', 'openai-responses', 'anthropic-messages', 'google-generative-ai']);
export const EvaluationConnectionSchema = z.object({
  api: EvaluationApiSchema,
  baseUrl: z.string().url().max(2048).refine(value => {
    const url = new URL(value);
    return ['http:', 'https:'].includes(url.protocol) && !url.username && !url.password && !url.search && !url.hash;
  }, 'A credential-free HTTP URL is required'),
  model: z.string().trim().min(1).max(128),
}).strict();
export const EvaluationHttpJudgeConnectionSchema = EvaluationConnectionSchema.extend({
  timeoutMs: z.number().int().positive().max(300_000).default(180_000),
});
export const EvaluationNativeJudgeConnectionSchema = z.object({ provider: z.literal('codex-cli'),
  executable: z.string().trim().min(1).max(2048), model: z.string().trim().min(1).max(128),
  reasoningEffort: z.enum(['none', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max']).default('medium'),
  timeoutMs: z.number().int().positive().max(300_000).default(180_000),
}).strict();
export const EvaluationJudgeConnectionSchema = z.union([EvaluationHttpJudgeConnectionSchema, EvaluationNativeJudgeConnectionSchema]);
export type EvaluationConnection = z.infer<typeof EvaluationConnectionSchema>;
export type EvaluationJudgeConnection = z.infer<typeof EvaluationJudgeConnectionSchema>;
export const EvaluationAgentProfileSchema = EvaluationConnectionSchema.extend({ credentialRef: z.string().regex(/^[a-f0-9]{32}$/) });
export const EvaluationJudgeProfileSchema = z.union([
  EvaluationHttpJudgeConnectionSchema.extend({ credentialRef: z.string().regex(/^[a-f0-9]{32}$/) }), EvaluationNativeJudgeConnectionSchema,
]);
export const EvaluationSettingsSchema = z.object({
  agent: EvaluationAgentProfileSchema.nullable(), judge: EvaluationJudgeProfileSchema.nullable(),
}).strict();
export type EvaluationSettings = z.infer<typeof EvaluationSettingsSchema>;

export const EvaluationRunConfigurationSchema = z.object({
  budget: RuntimeBudgetOverridesSchema.optional(),
  timeoutMs: z.number().int().min(100).max(1_800_000).optional(),
  trialTimeoutMs: z.number().int().min(100).max(1_800_000).optional(),
  evaluationBudgets: EvaluationBudgetProfilesSchema.optional(),
  stopGraceMs: z.number().int().min(100).max(10_000).optional(),
  environment: z.string().regex(/^[a-z0-9_-]{1,80}$/).optional(),
}).strict();
export const EvaluationPreviewRequestSchema = z.object({
  datasetId: EvaluationIdSchema.default('all'),
  selection: z.enum(['smoke', 'full', 'case']).default('smoke'),
  caseId: EvaluationIdSchema.optional(), repeat: z.number().int().min(1).max(20).default(1),
  judge: z.enum(['auto', 'off', 'required']).default('auto'),
  configuration: EvaluationRunConfigurationSchema.default({}),
}).strict().superRefine((value, context) => {
  if (value.selection === 'case' ? value.datasetId === 'all' || value.caseId === undefined : value.caseId !== undefined)
    context.addIssue({ code: 'custom', message: 'A single Case requires its Dataset; suite selections cannot include a Case' });
});
export type EvaluationPreviewRequest = z.infer<typeof EvaluationPreviewRequestSchema>;

export const EvaluationEvaluatorPlanSchema = z.object({
  evaluatorId: EvaluationIdSchema, version: z.number().int().positive(), kind: z.enum(['deterministic', 'llm-judge']),
  applicable: z.boolean(), reason: z.string(), outputs: z.array(z.object({ metricId: z.string().min(1).max(200),
    category: z.enum(['formal', 'diagnostic', 'guardrail']), applicable: z.boolean(), reason: z.string(), required: z.boolean(),
    denominator: z.number().nonnegative().nullable().optional(),
  }).strict()),
}).strict();
export const EvaluationCasePlanSchema = z.object({
  caseId: EvaluationIdSchema, caseVersion: z.number().int().positive(), name: z.string(), category: z.string(),
  evaluationBudget: ResolvedEvaluationBudgetSchema.optional(),
  evaluators: z.array(EvaluationEvaluatorPlanSchema),
  judge: z.object({ applicable: z.boolean(), required: z.boolean(), enabled: z.boolean() }).strict(),
}).strict();
export const EvaluationDatasetPlanSchema = z.object({
  id: EvaluationIdSchema, version: z.number().int().positive(), name: z.string(), caseCount: revision, total: revision,
  cases: z.array(EvaluationCasePlanSchema),
}).strict();
export const EvaluationPlanSummarySchema = z.object({
  selection: z.enum(['smoke', 'full', 'case']), repeat: z.number().int().min(1).max(20), judge: z.enum(['auto', 'off', 'required']),
  configuration: EvaluationRunConfigurationSchema, datasets: z.array(EvaluationDatasetPlanSchema),
  caseCount: revision, total: revision, judgeMaxGenerations: revision, judgeRequired: z.boolean(),
  unmeasuredRequiredCaseIds: z.array(EvaluationIdSchema),
}).strict();
export type EvaluationPlanSummary = z.infer<typeof EvaluationPlanSummarySchema>;

const caseTarget = z.object({ kind: z.literal('case-quality'), datasetId: EvaluationIdSchema, caseId: EvaluationIdSchema }).strict();
const trialTarget = z.object({ kind: z.literal('run-feedback'), executionId, caseId: EvaluationIdSchema, trialId: EvaluationIdSchema }).strict();
export const EvaluationFeedbackTargetSchema = z.discriminatedUnion('kind', [caseTarget, trialTarget]);
export type EvaluationFeedbackTarget = z.infer<typeof EvaluationFeedbackTargetSchema>;
export const EvaluationFeedbackRequestSchema = z.object({
  target: z.discriminatedUnion('kind', [caseTarget.extend({ caseViewId: EvaluationIdSchema }), trialTarget]),
  operationId: EvaluationIdSchema, reviewer: z.string().trim().min(1).max(128),
  verdict: z.enum(['good', 'bad']), note: z.string().trim().min(1).max(16_000),
}).strict();
export type EvaluationFeedbackRequest = z.infer<typeof EvaluationFeedbackRequestSchema>;

const keyUpdate = z.string().trim().min(1).max(4096).optional();
export const SaveEvaluationSettingsSchema = z.discriminatedUnion('role', [
  z.object({ expectedRevision: revision, role: z.literal('agent'), connection: EvaluationConnectionSchema.nullable(), apiKey: keyUpdate }).strict(),
  z.object({ expectedRevision: revision, role: z.literal('judge'), connection: EvaluationJudgeConnectionSchema.nullable(), apiKey: keyUpdate }).strict(),
]).refine(value => (value.connection !== null && !('provider' in value.connection && value.connection.provider === 'codex-cli')) || value.apiKey === undefined,
  'A cleared or native connection cannot receive an API credential');
export type SaveEvaluationSettingsRequest = z.infer<typeof SaveEvaluationSettingsSchema>;

export const evaluationRequests = {
  query_evaluation_catalog: z.discriminatedUnion('view', [
    z.object({ view: z.literal('list'), viewId: EvaluationIdSchema.optional(), ...page }).strict(),
    z.object({ view: z.literal('case'), datasetId: EvaluationIdSchema, caseId: EvaluationIdSchema,
      caseViewId: EvaluationIdSchema.optional(), ...textPage }).strict(),
  ]),
  preview_evaluation: EvaluationPreviewRequestSchema,
  start_evaluation: z.object({ previewId: EvaluationIdSchema, requestId: EvaluationIdSchema }).strict(),
  query_evaluation_control: z.object({ requestId: EvaluationIdSchema.optional(), batchId: EvaluationIdSchema.optional() }).strict(),
  cancel_evaluation: z.object({ batchId: EvaluationIdSchema }).strict(),
  list_evaluation_executions: z.object({ ...page, viewId: EvaluationIdSchema.optional() }).strict(),
  query_evaluation_result: z.object({ executionId, trialId: EvaluationIdSchema.optional(),
    view: z.enum(['summary', 'scores', 'observations', 'events', 'artifacts']), viewId: EvaluationIdSchema.optional(), ...textPage }).strict(),
  compare_evaluation: z.object({ left: executionId, right: executionId }).strict(),
  add_evaluation_feedback: EvaluationFeedbackRequestSchema,
  query_evaluation_feedback: z.object({ target: z.discriminatedUnion('kind', [caseTarget,
    z.object({ kind: z.literal('run-feedback'), executionId }).strict()]), operationId: EvaluationIdSchema.optional(), viewId: EvaluationIdSchema.optional(), ...page }).strict(),
  export_evaluation: z.object({ executionId, operationId: EvaluationIdSchema }).strict(),
  save_evaluation_settings: SaveEvaluationSettingsSchema,
} as const;
export type EvaluationCommandType = keyof typeof evaluationRequests;
export type EvaluationRequest<K extends EvaluationCommandType> = z.infer<(typeof evaluationRequests)[K]>;
export type EvaluationInput<K extends EvaluationCommandType> = z.input<(typeof evaluationRequests)[K]>;
export type EvaluationCommand = { [K in EvaluationCommandType]: { type: K; input: EvaluationRequest<K> } }[EvaluationCommandType];

export function isEvaluationCommand(type: string): type is EvaluationCommandType {
  return Object.hasOwn(evaluationRequests, type);
}
export function parseEvaluationCommand(value: unknown): EvaluationCommand | null {
  const envelope = z.object({ type: z.string(), input: z.unknown() }).strict().safeParse(value);
  if (!envelope.success || !isEvaluationCommand(envelope.data.type)) return null;
  const input = evaluationRequests[envelope.data.type].safeParse(envelope.data.input);
  return input.success ? { type: envelope.data.type, input: input.data } as EvaluationCommand : null;
}

export const EvaluationCredentialStatusSchema = z.enum(['missing', 'configured', 'unavailable']);
export const EvaluationConfigurationSnapshotSchema = z.object({
  revision, agent: EvaluationConnectionSchema.nullable(), judge: EvaluationJudgeConnectionSchema.nullable(),
  credentials: z.object({ agent: EvaluationCredentialStatusSchema, judge: EvaluationCredentialStatusSchema }).strict(),
}).strict();
export type EvaluationConfigurationSnapshot = z.infer<typeof EvaluationConfigurationSnapshotSchema>;

export const EvaluationPreviewSchema = z.object({
  version: z.literal(1), previewId: EvaluationIdSchema, settings: EvaluationConfigurationSnapshotSchema,
  request: EvaluationPreviewRequestSchema, plan: EvaluationPlanSummarySchema, ready: z.boolean(),
  issues: z.array(z.string().max(16_000)),
}).strict();
export type EvaluationPreview = z.infer<typeof EvaluationPreviewSchema>;

export const EvaluationProgressViewSchema = z.object({
  type: z.enum(['preflight', 'plan', 'dataset-start', 'trial-phase', 'trial-cleanup', 'agent-end', 'scoring-end',
    'trial-end', 'source-invalidated', 'diagnostics-end', 'regression-record-error', 'dataset-end']),
  executionId: executionId.optional(), datasetId: EvaluationIdSchema.optional(), caseId: EvaluationIdSchema.optional(),
  trialId: EvaluationIdSchema.optional(), index: revision.optional(), total: revision.optional(), caseCount: revision.optional(),
  trialIndex: revision.optional(), trialsPerCase: revision.optional(),
  phase: z.enum(['preparing', 'executing', 'capturing', 'cleanup', 'restoring', 'scoring', 'saving']).optional(),
  status: z.string().max(64).optional(), reason: z.string().max(16_000).optional(), error: z.string().max(16_000).optional(),
  endpointReached: z.boolean().optional(), elapsedMs: z.number().finite().nonnegative().optional(),
  stopped: z.boolean().optional(), stopConfirmed: z.boolean().optional(), count: revision.optional(),
  counts: z.record(revision).optional(), paths: z.array(z.string().max(2048)).optional(),
}).strict();
export type EvaluationProgressView = z.infer<typeof EvaluationProgressViewSchema>;

export const EvaluationControlStateSchema = z.object({
  version: z.literal(1), sessionId: EvaluationIdSchema, batchId: EvaluationIdSchema.nullable(), requestId: EvaluationIdSchema.nullable(),
  state: z.enum(['idle', 'preparing', 'running', 'cancelling', 'finished', 'stop-unconfirmed', 'interrupted']),
  outcome: z.enum(['completed', 'cancelled', 'failed']).nullable(),
  startedAt: z.string().datetime().nullable(), endedAt: z.string().datetime().nullable(),
  executionIds: z.array(executionId), progress: EvaluationProgressViewSchema.nullable(),
  stop: z.enum(['not-started', 'pending', 'confirmed', 'unconfirmed']), errors: z.array(z.string().max(16_000)),
}).strict().superRefine((value, context) => {
  if (value.state !== 'idle' && (!value.batchId || !value.requestId || !value.startedAt))
    context.addIssue({ code: 'custom', message: 'An accepted batch requires its original identities' });
  if (value.state === 'idle' && (value.batchId !== null || value.requestId !== null))
    context.addIssue({ code: 'custom', message: 'Idle control cannot claim an accepted batch' });
  if (value.state === 'stop-unconfirmed' && value.stop !== 'unconfirmed')
    context.addIssue({ code: 'custom', message: 'Unconfirmed stopping must remain explicit' });
});
export type EvaluationControlState = z.infer<typeof EvaluationControlStateSchema>;
export const EvaluationEventSchema = z.object({ version: z.literal(1), sessionId: EvaluationIdSchema,
  sequence: z.number().int().positive().max(Number.MAX_SAFE_INTEGER), control: EvaluationControlStateSchema,
}).strict().refine(value => value.sessionId === value.control.sessionId, 'Worker session differs');
export type EvaluationEvent = z.infer<typeof EvaluationEventSchema>;
export function parseEvaluationEvent(value: unknown): EvaluationEvent | null {
  const parsed = EvaluationEventSchema.safeParse(value); return parsed.success ? parsed.data : null;
}

export const EvaluationSavedSettingsSchema = z.object({ role: z.enum(['agent', 'judge']), revision,
  evaluation: EvaluationSettingsSchema,
  credentials: z.object({ agent: EvaluationCredentialStatusSchema, judge: EvaluationCredentialStatusSchema }).strict(),
}).strict();
export type EvaluationSavedSettings = z.infer<typeof EvaluationSavedSettingsSchema>;

const grade = z.enum(['PASS', 'FAIL', 'UNJUDGEABLE', 'ERROR', 'NOT_RUN']);
const measured = z.number().finite().nonnegative().nullable();
export const EvaluationReadPageSchema = z.object({ offset: revision, limit: z.number().int().positive().max(32_000),
  total: revision, nextOffset: revision.nullable(), complete: z.boolean(), unit: z.enum(['rows', 'characters']) }).strict()
  .refine(value => value.offset <= value.total && value.complete === (value.nextOffset === null)
    && (value.nextOffset === null || value.nextOffset > value.offset && value.nextOffset <= value.total), 'Invalid read page');
const catalogItem = z.object({ datasetId: EvaluationIdSchema, datasetVersion: z.number().int().positive(),
  caseId: EvaluationIdSchema, caseVersion: z.number().int().positive(), name: z.string().max(2000), category: z.string().max(200), smoke: z.boolean() }).strict();
export const EvaluationCatalogSchema = z.discriminatedUnion('view', [
  z.object({ version: z.literal(1), sessionId: EvaluationIdSchema, view: z.literal('list'), viewId: EvaluationIdSchema,
    page: EvaluationReadPageSchema, items: z.array(catalogItem).max(200) }).strict(),
  z.object({ version: z.literal(1), sessionId: EvaluationIdSchema, view: z.literal('case'), caseViewId: EvaluationIdSchema,
    datasetId: EvaluationIdSchema, caseId: EvaluationIdSchema, caseVersion: z.number().int().positive(), name: z.string().max(2000),
    category: z.string().max(200), summary: z.string().max(32_000), summaryTruncated: z.boolean(),
    page: EvaluationReadPageSchema, text: z.string().max(32_000), fileCount: revision,
    gaps: z.array(z.object({ path: z.string().max(1024), reason: z.enum(['missing', 'invalid']) }).strict()) }).strict(),
]);
export type EvaluationCatalog = z.infer<typeof EvaluationCatalogSchema>;
export const EvaluationFeedbackRecordSchema = z.object({ id: z.string().min(1).max(2000), kind: z.enum(['case-quality', 'run-feedback']),
  datasetId: EvaluationIdSchema.nullable(), caseId: EvaluationIdSchema, caseVersion: z.number().int().positive(),
  executionId: executionId.nullable(), trialId: EvaluationIdSchema.nullable(), reviewer: z.string().max(128), reviewerTruncated: z.boolean(),
  at: z.string().datetime(), verdict: z.enum(['good', 'bad']), note: z.string().max(16_000), noteTruncated: z.boolean(),
  source: z.string().max(2000), sourceTruncated: z.boolean() }).strict();
export type EvaluationFeedbackRecord = z.infer<typeof EvaluationFeedbackRecordSchema>;
export const EvaluationFeedbackSavedSchema = z.object({ version: z.literal(1), sessionId: EvaluationIdSchema,
  operationId: EvaluationIdSchema, record: EvaluationFeedbackRecordSchema }).strict().refine(value => value.operationId === value.record.id);
export type EvaluationFeedbackSaved = z.infer<typeof EvaluationFeedbackSavedSchema>;
const feedbackRow = EvaluationFeedbackRecordSchema.extend({ validity: z.enum(['current', 'stale', 'unverified']) });
export const EvaluationFeedbackListSchema = z.object({ version: z.literal(1), sessionId: EvaluationIdSchema, viewId: EvaluationIdSchema,
  target: evaluationRequests.query_evaluation_feedback.shape.target, operationId: EvaluationIdSchema.nullable(),
  page: EvaluationReadPageSchema, records: z.array(feedbackRow).max(200), operation: feedbackRow.nullable(),
  stale: revision, unverified: revision, formalAcceptance: z.literal('pending'), issues: z.array(z.string().max(2000)) }).strict();
export type EvaluationFeedbackList = z.infer<typeof EvaluationFeedbackListSchema>;
export const EvaluationExportViewSchema = z.object({ backend: z.enum(['local', 'langfuse']),
  status: z.enum(['disabled', 'pending', 'complete', 'partial', 'error']),
  target: z.object({ baseUrl: EvaluationConnectionSchema.shape.baseUrl, projectId: z.string().min(1).max(200) }).strict().nullable(),
  progress: z.object({ total: revision, accepted: revision, rejected: revision, unconfirmed: revision }).strict().nullable(),
  error: z.string().max(2000).nullable(), errorTruncated: z.boolean(),
}).strict();
export type EvaluationExportView = z.infer<typeof EvaluationExportViewSchema>;
export const EvaluationExportResultSchema = z.object({ version: z.literal(1), sessionId: EvaluationIdSchema,
  executionId, operationId: EvaluationIdSchema, export: EvaluationExportViewSchema }).strict();
export type EvaluationExportResult = z.infer<typeof EvaluationExportResultSchema>;
export const EvaluationExecutionConditionsSchema = z.object({
  agent: EvaluationConnectionSchema.extend({ modelCapabilities: z.object({ contextWindow: z.number().int().positive(),
    transport: z.object({ maxTokens: z.number().int().positive(), source: z.literal('local-codex-gateway-source') }).strict().optional(),
    maxTokens: z.number().int().positive(), reasoning: z.boolean(), source: z.enum(['pi-sdk-model-catalog', 'deepseek-models-api', 'codex-cli-cache-and-openai-model-reference']),
    providers: z.array(z.string().max(200)).min(1).max(50) }).strict().nullable() }),
  run: EvaluationRunConfigurationSchema.extend({ resources: ResourceSelectionSchema.optional(), extensions: ExtensionSelectionSchema.optional() }),
  judge: z.object({ api: EvaluationApiSchema.nullable(), baseUrl: EvaluationConnectionSchema.shape.baseUrl.nullable(),
    model: EvaluationConnectionSchema.shape.model, timeoutMs: z.number().int().positive(),
    transport: z.literal('codex-cli').optional(), reasoningEffort: z.enum(['none', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max']).optional() }).strict().nullable().optional(),
  scoring: z.object({ version: z.number().int().positive(), scoringVersion:z.literal(2).optional(), judgeMode: z.enum(['off', 'auto', 'required']) }).strict(),
  source: z.object({ runtime: z.object({ node: z.string().max(200), platform: z.string().max(200), arch: z.string().max(200) }).strict(),
    dependencies: z.record(z.string().max(200).nullable()).refine(value => Object.keys(value).length <= 100), fileCount: revision,
    paths: z.array(z.string().max(1024)).max(200), pathsTruncated: z.boolean() }).strict().nullable(),
}).strict();
export type EvaluationExecutionConditions = z.infer<typeof EvaluationExecutionConditionsSchema>;
export const EvaluationExecutionSummarySchema = z.object({ executionId,
  dataset: z.object({ id: EvaluationIdSchema, version: z.number().int().positive(), subject: z.literal('agent') }).strict(),
  selection: z.enum(['smoke', 'holdout', 'full', 'case']), environment: z.string().max(200), repeat: z.number().int().min(1).max(20),
  startedAt: z.string().datetime(), endedAt: z.string().datetime().nullable(), executionComplete: z.boolean(),
  scoring: z.enum(['pending', 'complete']), plannedTrials: revision, evidenceComplete: z.boolean().nullable(),
  historyGaps: z.array(z.string().max(2000)), export: EvaluationExportViewSchema.nullable(),
  conditions: EvaluationExecutionConditionsSchema.nullable().optional(), conditionsIssue: z.enum(['missing', 'invalid']).nullable().optional(),
}).strict();
export type EvaluationExecutionSummary = z.infer<typeof EvaluationExecutionSummarySchema>;
export const EvaluationTrialViewSchema = z.object({ trialId: EvaluationIdSchema, traceId: z.string().regex(/^[a-f0-9]{32}$/),
  caseId: EvaluationIdSchema, caseVersion: z.number().int().positive(), caseName: z.string().max(2000), repetition: z.number().int().positive(),
  status: grade, reason: z.string().max(2000), reasonTruncated: z.boolean(), executionStatus: z.enum(['completed', 'failed', 'timeout', 'cancelled', 'error', 'not-started']).nullable(),
  judgeGenerations: revision.nullable(), usage: z.record(measured).nullable(), artifactReferences: revision.nullable(),
}).strict();
export type EvaluationTrialView = z.infer<typeof EvaluationTrialViewSchema>;
export const EvaluationCalibrationViewSchema = z.object({ state:z.enum(['not-provided','insufficient-coverage','version-mismatch','matched']),
  reason:z.string().max(2000),metricIds:z.array(z.string().min(1).max(200)).max(30),reference:EvaluationIdSchema.nullable(),
  kind:z.enum(['engineering-fixture','actual-judge-calibration']).nullable(),acceptance:z.literal('not-assessed') }).strict();
export type EvaluationCalibrationView = z.infer<typeof EvaluationCalibrationViewSchema>;
export const EvaluationScoreViewSchema = z.object({ trialId: EvaluationIdSchema, caseId: EvaluationIdSchema, repetition: z.number().int().positive(),
  metricId: z.string().min(1).max(200), name: z.string().max(2000), version: z.number().int().positive(), method: z.enum(['deterministic', 'llm-judge']),
  required: z.boolean(), status: z.enum([...grade.options, 'NOT_APPLICABLE']), value: z.number().finite().min(0).max(1).nullable(),
  reason: z.string().max(2000), reasonTruncated: z.boolean(), evidence: z.array(z.string().max(2000)),
  evaluatorId: EvaluationIdSchema.nullable(), evaluatorVersion: z.number().int().positive().nullable(),
  judge:z.object({callId:EvaluationIdSchema,criterion:z.number().int().nonnegative()}).strict().nullable().optional(),
  calibration:EvaluationCalibrationViewSchema.nullable().optional(),
  category: z.enum(['formal', 'diagnostic', 'guardrail']).nullable(), applicabilityReason: z.string().max(2000).nullable(),
  statistics: z.object({ unit: z.string().min(1).max(200), numerator: revision.nullable(), denominator: revision.nullable(), missing: revision.nullable() }).strict().nullable(),
}).strict();
export type EvaluationScoreView = z.infer<typeof EvaluationScoreViewSchema>;
export const EvaluationMetricSummarySchema = z.object({ metricId: EvaluationIdSchema, version: z.number().int().positive(), unit: z.string().min(1).max(200),
  formula: z.string().max(2000), numerator: revision.nullable(), denominator: revision.nullable(), missing: revision,
  value: z.number().finite().min(0).max(1).nullable(), unknownDenominators: revision, unknownMissing: revision, zeroDenominators: revision,
  unplannedTrials: revision, notApplicable: revision, derivedFrom: z.array(z.string()).optional(), missingUnit: z.literal('Trial').optional(),
}).strict();
export const EvaluationExecutionListSchema = z.object({ version: z.literal(1), sessionId: EvaluationIdSchema, viewId: EvaluationIdSchema,
  page: EvaluationReadPageSchema, items: z.array(z.object({ executionId: z.string().min(1).max(255),
    summary: EvaluationExecutionSummarySchema.nullable(), error: z.string().max(2000).nullable() }).strict()).max(200),
}).strict();
export type EvaluationExecutionList = z.infer<typeof EvaluationExecutionListSchema>;
export const EvaluationResultSchema = z.object({ version: z.literal(1), sessionId: EvaluationIdSchema, viewId: EvaluationIdSchema, executionId,
  trialId: EvaluationIdSchema.nullable(), view: evaluationRequests.query_evaluation_result.shape.view,
  page: EvaluationReadPageSchema, summary: EvaluationExecutionSummarySchema,
  trials: z.array(EvaluationTrialViewSchema).max(200), scores: z.array(EvaluationScoreViewSchema).max(200), text: z.string().max(32_000),
  metrics: z.array(EvaluationMetricSummarySchema).nullable(),
  gaps: z.array(z.object({ trialId: EvaluationIdSchema.nullable(), kind: z.enum(['trial', 'observation', 'events', 'artifact', 'export']),
    reference: z.string().max(1024), reason: z.enum(['missing', 'invalid']) }).strict()),
  sourceInvalidation: z.object({ reason: z.string(), paths: z.array(z.string()) }).strict().nullable(),
}).strict().refine(value => value.executionId === value.summary.executionId, 'Result identity differs from its summary');
export type EvaluationResult = z.infer<typeof EvaluationResultSchema>;
export const EvaluationComparisonSchema = z.object({ version: z.literal(1), sessionId: EvaluationIdSchema, left: executionId, right: executionId,
  rows: z.array(z.object({ caseId: EvaluationIdSchema, repetition: z.number().int().positive(), before: grade, after: grade }).strict()),
}).strict();
export type EvaluationComparison = z.infer<typeof EvaluationComparisonSchema>;

export const evaluationResponses = {
  query_evaluation_catalog: EvaluationCatalogSchema,
  add_evaluation_feedback: EvaluationFeedbackSavedSchema,
  query_evaluation_feedback: EvaluationFeedbackListSchema,
  export_evaluation: EvaluationExportResultSchema,
  preview_evaluation: EvaluationPreviewSchema,
  start_evaluation: EvaluationControlStateSchema,
  query_evaluation_control: EvaluationControlStateSchema,
  cancel_evaluation: EvaluationControlStateSchema,
  save_evaluation_settings: EvaluationSavedSettingsSchema,
  list_evaluation_executions: EvaluationExecutionListSchema,
  query_evaluation_result: EvaluationResultSchema,
  compare_evaluation: EvaluationComparisonSchema,
} as const;
export type EvaluationResponseType = keyof typeof evaluationResponses;
export type EvaluationOutput<K extends EvaluationResponseType> = z.infer<(typeof evaluationResponses)[K]>;
export function parseEvaluationResponse<K extends EvaluationResponseType>(type: K, value: unknown): Result<EvaluationOutput<K>> | null {
  if (!Object.hasOwn(evaluationResponses, type)) return null;
  const parsed = z.discriminatedUnion('ok', [z.object({ ok: z.literal(true), data: evaluationResponses[type] }).strict(),
    z.object({ ok: z.literal(false), error: AppErrorSchema }).strict()]).safeParse(value);
  return parsed.success ? parsed.data as Result<EvaluationOutput<K>> : null;
}
export function matchesEvaluationResponse(command: EvaluationCommand, value: Result<EvaluationOutput<EvaluationResponseType>>): boolean {
  if (!value.ok) return true;
  const data = value.data;
  if (command.type === 'query_evaluation_catalog') {
    if (!('view' in data) || data.view !== command.input.view || data.page.offset !== command.input.offset || data.page.limit > command.input.limit) return false;
    if (command.input.view === 'list') return data.view === 'list' && (!command.input.viewId || data.viewId === command.input.viewId);
    return data.view === 'case' && data.datasetId === command.input.datasetId && data.caseId === command.input.caseId
      && (!command.input.caseViewId || data.caseViewId === command.input.caseViewId);
  }
  if (command.type === 'add_evaluation_feedback') {
    if (!('record' in data) || data.operationId !== command.input.operationId) return false;
    const record = data.record, expected = command.input.target;
    return record.id === command.input.operationId && record.kind === expected.kind && record.caseId === expected.caseId
      && record.reviewer === command.input.reviewer && record.verdict === command.input.verdict && record.note === command.input.note
      && (expected.kind === 'case-quality' ? record.datasetId === expected.datasetId
        : record.executionId === expected.executionId && record.trialId === expected.trialId);
  }
  if (command.type === 'query_evaluation_feedback') return 'records' in data
    && JSON.stringify(data.target) === JSON.stringify(command.input.target) && data.operationId === (command.input.operationId ?? null)
    && data.page.offset === command.input.offset && data.page.limit <= command.input.limit && (!command.input.viewId || data.viewId === command.input.viewId);
  if (command.type === 'export_evaluation') return 'export' in data && 'operationId' in data
    && data.executionId === command.input.executionId && data.operationId === command.input.operationId;
  if (command.type === 'save_evaluation_settings') {
    if (!('role' in data) || data.role !== command.input.role || data.revision <= command.input.expectedRevision) return false;
    const role = data.evaluation[command.input.role], expected = command.input.connection;
    if (expected === null) return role === null;
    if (role === null || role.model !== expected.model) return false;
    if ('provider' in expected) return 'provider' in role && role.provider === expected.provider && role.executable === expected.executable
      && role.reasoningEffort === expected.reasoningEffort && role.timeoutMs === expected.timeoutMs;
    return 'api' in role && role.api === expected.api && role.baseUrl === expected.baseUrl
      && (!('timeoutMs' in expected) || 'timeoutMs' in role && role.timeoutMs === expected.timeoutMs);
  }
  if (command.type === 'preview_evaluation')
    return 'previewId' in data && JSON.stringify(data.request) === JSON.stringify(command.input);
  if (command.type === 'list_evaluation_executions') return 'items' in data && !('view' in data) && data.page.offset === command.input.offset
    && (!command.input.viewId || data.viewId === command.input.viewId) && data.page.limit <= command.input.limit;
  if (command.type === 'query_evaluation_result') return 'view' in data && 'executionId' in data && data.executionId === command.input.executionId
    && data.trialId === (command.input.trialId ?? null) && data.view === command.input.view && data.page.offset === command.input.offset
    && (!command.input.viewId || data.viewId === command.input.viewId) && data.page.limit <= command.input.limit;
  if (command.type === 'compare_evaluation') return 'rows' in data && data.left === command.input.left && data.right === command.input.right;
  if (!('batchId' in data)) return false;
  if (command.type === 'start_evaluation') return data.requestId === command.input.requestId;
  if (command.type === 'cancel_evaluation') return data.batchId === command.input.batchId;
  if (command.type === 'query_evaluation_control') return (!command.input.batchId || data.batchId === command.input.batchId)
    && (!command.input.requestId || data.requestId === command.input.requestId);
  return false;
}

export type EvaluationDesktopApi = {
  queryEvaluationCatalog(input: EvaluationInput<'query_evaluation_catalog'>): Promise<Result<EvaluationCatalog>>;
  addEvaluationFeedback(input: EvaluationFeedbackRequest): Promise<Result<EvaluationFeedbackSaved>>;
  queryEvaluationFeedback(input: EvaluationInput<'query_evaluation_feedback'>): Promise<Result<EvaluationFeedbackList>>;
  exportEvaluation(input: EvaluationRequest<'export_evaluation'>): Promise<Result<EvaluationExportResult>>;
  listEvaluationExecutions(input?: EvaluationInput<'list_evaluation_executions'>): Promise<Result<EvaluationExecutionList>>;
  queryEvaluationResult(input: EvaluationInput<'query_evaluation_result'>): Promise<Result<EvaluationResult>>;
  compareEvaluation(input: EvaluationInput<'compare_evaluation'>): Promise<Result<EvaluationComparison>>;
  previewEvaluation(input: EvaluationPreviewRequest): Promise<Result<EvaluationPreview>>;
  startEvaluation(input: EvaluationRequest<'start_evaluation'>): Promise<Result<EvaluationControlState>>;
  queryEvaluationControl(input?: EvaluationRequest<'query_evaluation_control'>): Promise<Result<EvaluationControlState>>;
  cancelEvaluation(input: EvaluationRequest<'cancel_evaluation'>): Promise<Result<EvaluationControlState>>;
  saveEvaluationSettings(input: SaveEvaluationSettingsRequest): Promise<Result<EvaluationSavedSettings>>;
};
