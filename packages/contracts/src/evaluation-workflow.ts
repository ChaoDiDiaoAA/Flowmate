import { z } from 'zod';
import { CurationFeedbackRequestSchema, TraceBundleSchema } from './evaluation-loop.ts';
import { EvaluationReadPageSchema } from './evaluation.ts';
import { baselineReferenceSchema,gateThresholdsSchema } from './evaluation-baseline.ts';

const uuid = z.string().uuid(), revision = z.number().int().positive().max(Number.MAX_SAFE_INTEGER);
const id = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/), text = z.string().min(1), record = z.record(z.unknown());
const kind = z.enum(['gold', 'bad', 'regression']), count = z.number().int().nonnegative();
export const ObservabilitySettingsSchema = z.object({ capture: z.boolean(), upload: z.boolean(), mining: z.boolean() }).strict();
export type ObservabilitySettings = z.infer<typeof ObservabilitySettingsSchema>;
const request = <A extends string, S extends z.ZodRawShape>(action: A, shape: S) => z.object({ action: z.literal(action), ...shape }).strict();
const feedback = CurationFeedbackRequestSchema.shape;
const publication = { operationId: uuid, benchmarkId: z.string().regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/), candidateIds: z.array(uuid).min(1),
  approvals: z.array(uuid).min(1), smokeCaseIds: z.array(z.string().regex(/^FM-\d{3}$/)).optional() };
const paging = { offset: count.optional(), limit: z.number().int().min(1).max(50).optional(), viewId: uuid.optional() };
export const WorkflowRecordReferenceSchema = z.object({ kind: z.enum(['trace', 'candidate', 'baseline', 'gate']), id,
  part: z.enum(['record', 'platform', 'feedback']).default('record'), experimentId: id.optional(), revision: revision.optional(),
  location: text, characters: count, bytes: count }).strict();
export type WorkflowRecordReference = z.infer<typeof WorkflowRecordReferenceSchema>;
export const EvaluationWorkflowRequestSchema = z.discriminatedUnion('action', [
  request('settings.get', {}), request('settings.save', { settings: ObservabilitySettingsSchema }),
  request('trace.list', { ...paging, source: TraceBundleSchema.innerType().shape.source.partial().optional() }), request('trace.show', { traceId: uuid }),
  request('trace.pull', { from: z.string().datetime(), to: z.string().datetime(), traceId: z.string().regex(/^(?:[a-fA-F0-9]{32}|[a-fA-F0-9-]{36})$/).optional(),
    entry: z.enum(['chats', 'invoices', 'research', 'evaluation']).optional() }),
  request('trace.upload', { traceId: uuid, expectedRevision: revision, operationId: uuid }),
  request('trace.process', { traceId: uuid }),
  request('trace.feedback', { ...feedback, target: z.object({ kind: z.literal('trace-feedback'), id: uuid, revision }).strict() }),
  request('mine', { traceId: uuid, expectedRevision: revision, operationId: uuid, kind }),
  request('candidate.list', { ...paging, kind: kind.optional() }), request('candidate.show', { candidateId: uuid }),
  request('candidate.edit', { candidateId: uuid, expectedRevision: revision, patch: record }),
  request('candidate.validate', { candidateId: uuid, expectedRevision: revision, replay: z.boolean().optional() }),
  request('candidate.review', { ...feedback, target: z.object({ kind: z.literal('candidate-review'), id: uuid, revision }).strict() }),
  request('candidate.publish', publication), request('benchmark.list', { ...paging }), request('benchmark.run', { selection: z.enum(['smoke', 'full']) }),
  request('score.retry', { runId: id, operationId: uuid.optional(), trialId: id.optional(), failedOnly: z.literal(true) }),
  request('score.list', { runId: id }),
  request('score.show', { runId: id, revisionId: id, executionId: id, trialId: id.optional() }),
  request('score.upload', { runId: id, revisionId: id }),
  // Domain services validate these JSON declarations with the existing authoring and experiment schemas before any side effect.
  request('experiment.preview', { plan: record }), request('experiment.run', { plan: record }),
  request('experiment.list', { ...paging }), request('experiment.show', { experimentId: id }), request('experiment.compare', { experimentId: id, scoringRevision: id.optional() }),
  request('baseline.create', { experimentId: id, armId: id, baselineId: id.optional(), scoringRevision: id.optional() }), request('baseline.list', { ...paging }),
  request('gate.check', { baselineId: id, experimentId: id, armId: id, fullRelease: z.boolean().optional(), scoringRevision: id.optional() }),
  request('record.read', { kind: WorkflowRecordReferenceSchema.shape.kind, id, part: z.enum(['record', 'platform', 'feedback']).optional(),
    experimentId: id.optional(), viewId: uuid.optional(), offset: count.optional(), limit: z.number().int().min(1).max(32000).optional() }),
]);
export type EvaluationWorkflowRequest = z.infer<typeof EvaluationWorkflowRequestSchema>;
export function isWorkflowReadOnly(action: EvaluationWorkflowRequest['action']): boolean {
  return ['settings.get', 'trace.list', 'trace.show', 'candidate.list', 'candidate.show', 'benchmark.list',
    'experiment.preview', 'experiment.list', 'experiment.show', 'baseline.list', 'record.read', 'score.list', 'score.show'].includes(action);
}
export const EVALUATION_WORKSPACE_UNAVAILABLE_REASON = 'Evaluation loop writes require an explicit repository workspace. This installed build has no repository binding; capture, upload, mining and candidate/experiment writes are unavailable. Saved Benchmark reports and their Export remain available.';

const candidate = z.object({ contract: z.literal('flowmate-evaluation-candidate/v1'), id: uuid, revision, kind,
  status: z.enum(['draft', 'blocked', 'validated']), traceRef: z.object({ id: uuid, revision }).strict(),
  createdAt: z.string().datetime().optional(), updatedAt: z.string().datetime().optional(), sourceLabels: z.array(text).min(1), reason: text,
  case: record.optional(), gold: record.optional(), review: record.optional(), scenario: record.optional(), bindings: z.array(record),
  controls: record.optional(), controlBindings: z.array(record), reuseCaseId: text.optional(),
  reviseCase: z.object({ id: z.string().regex(/^FM-\d{3}$/), version: revision }).strict().optional(), validation: record.optional() }).strict();
const feedbackRecord = CurationFeedbackRequestSchema.omit({ operationId: true }).extend({ id: uuid, at: z.string().datetime(), conditions: z.unknown() }).strict();
export const EvaluationCandidateRecordSchema = candidate;
export const WorkflowTraceSummarySchema = z.object({ projection: z.literal('summary'), id: uuid, revision,
  source: TraceBundleSchema.innerType().shape.source, entry: TraceBundleSchema.innerType().shape.entry,
  startedAt: z.string().datetime(), endedAt: z.string().datetime().nullable(), status: TraceBundleSchema.innerType().shape.status,
  complete: z.boolean(), gapCount: count, inputPreview: z.string().max(2000), inputTruncated: z.boolean(),
  eventCount: count, materialCount: count, uploadEligible: z.boolean(), uploadReason: text, record: WorkflowRecordReferenceSchema }).strict();
export const WorkflowCandidateSummarySchema = candidate.pick({ id: true, revision: true, kind: true, status: true, traceRef: true,
  createdAt: true, updatedAt: true, reason: true, sourceLabels: true, reuseCaseId: true, reviseCase: true }).extend({ projection: z.literal('summary'),
  reasonTruncated: z.boolean(), validation: record.optional(), record: WorkflowRecordReferenceSchema }).strict();
const feedbackSummary = feedbackRecord.omit({ conditions: true }).extend({ projection: z.literal('summary'), noteTruncated: z.boolean(),
  record: WorkflowRecordReferenceSchema }).strict();
const publicationRecord = z.object({ contract: z.literal('flowmate-published-benchmark/v1'), id: text, revision, operationId: uuid,
  at: z.string().datetime(), request: record, members: z.array(z.object({ caseId: text, caseVersion: revision, candidateId: uuid, candidateRevision: revision, approvalId: uuid,
    kind, traceRef: z.object({ id: uuid, revision }).strict(), reused: z.boolean() }).strict()), regressionCaseIds: z.array(text), smokeCaseIds: z.array(text) }).strict();
const publicationSummary = publicationRecord.pick({ id: true, revision: true, at: true }).extend({ projection: z.literal('summary'),
  memberCount: count, regressionCount: count, smokeCount: count, location: text }).strict();
const experiment = z.object({ contract: z.literal('flowmate-experiment/v1'), id, createdAt: z.string().datetime(), plan: record,
  attribution: z.enum(['single-axis', 'combination']), status: z.enum(['running', 'complete', 'blocked', 'stopped']),
  arms: z.array(z.object({ id, status: z.enum(['pending', 'running', 'complete', 'blocked', 'stopped']), executionIds: z.array(id),
    reason: text.optional(), runtimeRepository: text.optional(), sourceCommit: text.optional() }).strict()), reason: text.optional() }).strict();
const baseline = z.object({ contract: z.literal('flowmate-baseline/v1'), id, createdAt: z.string().datetime(), experimentId: id, armId: id,
  scoringRevision: id.optional(),
  executionIds: z.array(id), plan: record, conditions: z.array(z.unknown()), evidenceKind: z.enum(['model', 'controlled', 'unknown']),
  reference:baselineReferenceSchema.optional(),thresholds:gateThresholdsSchema.optional() }).strict();
const baselineSummary = baseline.omit({ conditions: true,reference:true }).extend({ projection: z.literal('summary'), conditionCount: count,
  referenceSummary:z.object({metricCount:count,assertionCount:count,measurementCount:count}).strict().optional(),
  conditionsSummary: z.array(record), record: WorkflowRecordReferenceSchema }).strict();
export const WorkflowUploadOperationSchema = z.object({ operationId: uuid, traceId: uuid, revision, at: z.string().datetime(),
  status: z.enum(['submitted', 'verified', 'unknown']), reason: text, traceIds: z.array(z.string()), observationIds: z.array(z.string()),
  target: z.object({ baseUrl: z.string().url(), projectId: z.string().min(1).max(200) }).strict().optional(), conditions: TraceBundleSchema }).strict();
export const WorkflowMiningOperationSchema = z.object({ request: z.object({ operationId: uuid, traceId: uuid, expectedRevision: revision, kind }).strict(),
  status: z.enum(['completed', 'rejected', 'unknown']), at: z.string().datetime(), reason: z.string(), candidateId: uuid.optional(), stopConfirmed: z.boolean().optional() }).strict();
const settingsView = z.object({ settings: ObservabilitySettingsSchema, roles: z.object({ agent: record.nullable(), judge: record.nullable(), mining: record.nullable() }).strict(),
  langfuse: z.object({ configured: z.boolean(), baseUrl: z.string().nullable() }).strict(),
  workspace: z.object({ available: z.boolean(), reason: z.string().nullable() }).strict().optional() }).strict();
const preview = z.object({ plan: record, attribution: z.enum(['single-axis', 'combination']), arms: count,
  datasets: z.array(z.object({ id, revision, caseIds: z.array(text), regressionCaseIds: z.array(text), caseCount: count, total: count }).strict()),
  caseCount: count, totalTrials: count }).strict();
const gate = z.object({ id: id.optional(), baselineId: id.optional(), experimentId: id.optional(), armId: id.optional(),
  scoringRevision: id.optional(),
  status: z.enum(['pass', 'fail', 'blocked']), exitCode: z.union([z.literal(0), z.literal(1), z.literal(2)]), fullRelease: z.boolean(),
  scope: record, reasons: z.array(record), deltas: z.array(record) }).strict();
const gateSummary = gate.extend({ projection: z.literal('summary'), reasonCount: count, deltaCount: count, record: WorkflowRecordReferenceSchema }).strict();
const result = <const A extends string, S extends z.ZodTypeAny>(action: A, data: S) => z.object({ action: z.literal(action),
  exitCode: z.union([z.literal(0), z.literal(1), z.literal(2)]), data }).strict();
const traceView = z.union([TraceBundleSchema, WorkflowTraceSummarySchema]);
const candidateView = z.union([candidate, WorkflowCandidateSummarySchema]);
const feedbackView = z.union([feedbackRecord, feedbackSummary]);
export const EvaluationRunProgressSchema = z.object({ storedTrials: count, startedTrials: count, endedTrials: count, stopConfirmedTrials: count,
      scoredTrials: count, processedTrials: count.optional(), scoringErrorTrials: count.optional(), unjudgeableTrials: count.optional(),
      judgeTasksPrepared: count.optional(), judgeTasksEnded: count.optional(), judgeTasksUnknown: count.optional(),
      judgeTasksSubmitted: count, judgeTasksCompleted: count, verifiedTrials: count }).strict();
export const EvaluationWorkflowResultSchema = z.discriminatedUnion('action', [
  result('score.retry', record), result('score.list', record), result('score.show', record), result('score.upload', record),
  result('settings.get', settingsView), result('settings.save', settingsView),
  result('trace.list', z.object({ items: z.array(traceView), page: EvaluationReadPageSchema.optional(), viewId: uuid.optional(), saved: count.optional(), gaps: z.array(text).optional() }).strict()),
  result('trace.pull', z.object({ items: z.array(traceView), page: EvaluationReadPageSchema.optional(), viewId: uuid.optional(), saved: count.optional(), gaps: z.array(text).optional() }).strict()),
  result('trace.show', z.object({ trace: traceView, feedback: z.array(feedbackView).optional(),
    platformSnapshot: z.object({ readAt: z.string().datetime(), trace: traceView }).strict().nullable().optional() }).strict()),
  result('trace.upload', z.object({ operation: z.union([WorkflowUploadOperationSchema,
    WorkflowUploadOperationSchema.omit({ conditions: true }).extend({ projection: z.literal('summary'), sourceRecord: WorkflowRecordReferenceSchema }).strict()]) }).strict()),
  result('trace.process', z.object({ traceId: uuid, revision, upload: record, mining: record }).strict()),
  result('mine', z.object({ operation: WorkflowMiningOperationSchema }).strict()),
  result('candidate.list', z.object({ items: z.array(candidateView), page: EvaluationReadPageSchema.optional(), viewId: uuid.optional() }).strict()),
  result('candidate.show', z.object({ candidate: candidateView, feedback: z.array(feedbackView).optional() }).strict()), result('candidate.edit', z.object({ candidate: candidateView }).strict()),
  result('candidate.validate', z.object({ validation: record }).strict()),
  result('candidate.review', z.object({ feedback: feedbackView }).strict()), result('trace.feedback', z.object({ feedback: feedbackView }).strict()),
  result('candidate.publish', z.object({ publication: publicationRecord }).strict()),
  result('benchmark.list', z.object({ items: z.array(z.union([publicationRecord, publicationSummary])), page: EvaluationReadPageSchema.optional(), viewId: uuid.optional() }).strict()),
  result('benchmark.run', z.object({ run: z.object({ runId: id, selection: z.enum(['smoke', 'full']), expectedCases: count, plannedTrials: count,
    observedTrials: count, progress: EvaluationRunProgressSchema.optional(),
    executionComplete: z.boolean(), scoringComplete: z.boolean(), exportComplete: z.boolean(), gate: z.enum(['pass', 'fail', 'blocked']),
    exitCode: z.union([z.literal(0), z.literal(1), z.literal(2)]), reportPath: text, readmePath: text }).strict() }).strict()),
  result('experiment.preview', z.object({ preview }).strict()),
  result('experiment.run', z.object({ experiment, progress: EvaluationRunProgressSchema.optional() }).strict()), result('experiment.show', z.object({ experiment, progress: EvaluationRunProgressSchema.optional() }).strict()),
  result('experiment.list', z.object({ items: z.array(z.union([experiment, experiment.extend({ projection: z.literal('summary') }).strict()])),
    page: EvaluationReadPageSchema.optional(), viewId: uuid.optional() }).strict()),
  result('experiment.compare', z.object({ comparisons: z.array(record) }).strict()),
  result('baseline.create', z.object({ baseline: z.union([baseline, baselineSummary]) }).strict()), result('baseline.list', z.object({ items: z.array(z.union([baseline, baselineSummary])), page: EvaluationReadPageSchema.optional(), viewId: uuid.optional() }).strict()),
  result('gate.check', z.object({ gate: z.union([gate, gateSummary]) }).strict()),
  result('record.read', z.object({ record: WorkflowRecordReferenceSchema.extend({ viewId: uuid, page: EvaluationReadPageSchema,
    text: z.string().max(32000), redacted: z.boolean(), sourceUnchanged: z.literal(true) }).strict() }).strict()),
]);
export type EvaluationWorkflowResult = z.infer<typeof EvaluationWorkflowResultSchema>;
