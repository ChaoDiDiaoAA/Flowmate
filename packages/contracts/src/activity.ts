import { z } from 'zod';
import { AppErrorSchema } from './runtime.ts';
import type { AppError, DbId } from './runtime.ts';
import type { StoredCandidateDraft, CheckResult, DocumentRef, InvoiceIssue, SourceRef, InvoiceFormApplicationReceipt } from './invoice.ts';
import type { ToolEffect, ToolResult } from './tools.ts';
import type { JobStatus } from './workspace.ts';
import type { ContextReference } from './context.ts';

export type CandidateSummary = {
  candidateId: DbId;
  context: ContextReference | null;
  jobId: DbId;
  runId: DbId | null;
  origin?: 'model' | 'human_edit';
  basedOnCandidateId?: DbId | null;
  sequence: number;
  status: 'generated' | 'accepted' | 'rejected';
  issueCount: number;
  createdAt: string;
};

export type CandidateSnapshot = CandidateSummary & {
  toolCallId: DbId | null;
  fields: StoredCandidateDraft['fields'];
  lines: StoredCandidateDraft['lines'];
  notes: string[];
  checks: CheckResult[];
  issues: InvoiceIssue[];
  sources: SourceRef[];
};

export type BusinessEventType = 'document_imported' | 'task_started' | 'candidate_generated' | 'candidate_selected'
  | 'candidate_edited' | 'candidate_accepted' | 'candidate_rejected' | 'candidate_exported';
export type BusinessEventSnapshot = {
  id: DbId;
  type: BusinessEventType;
  occurredAt: string;
  actorSource: 'user' | 'agent' | 'system';
  operationRef: string;
  documentId: DbId | null;
  jobId: DbId | null;
  candidateId: DbId | null;
  artifactId: DbId | null;
  runId: DbId | null;
  result: 'succeeded' | 'failed';
  safeSummary: string;
  errorCode: string | null;
};
export type ActivityFilter = { documentId: DbId } | { jobId: DbId };
export type ActivityPageRequest = import('./workspace.ts').PageRequest & ActivityFilter;

export type ToolCallStatus = 'requested' | 'running' | 'succeeded' | 'failed' | 'cancelled';
export type ToolCallDeliveryState = 'not_attempted' | 'message_observed' | 'request_observed' | 'failed' | 'unknown';
export type ToolCallDelivery = {
  version: 1;
  state: ToolCallDeliveryState;
  messageObservedAt: string | null;
  includedInCallSequence: number | null;
  requestDispatchedAt: string | null;
  error: AppError | null;
};
export const ToolCallDeliverySchema: z.ZodType<ToolCallDelivery> = z.object({ version: z.literal(1),
  state: z.enum(['not_attempted', 'message_observed', 'request_observed', 'failed', 'unknown']),
  messageObservedAt: z.string().datetime({ offset: true }).nullable(),
  includedInCallSequence: z.number().int().positive().max(Number.MAX_SAFE_INTEGER).nullable(),
  requestDispatchedAt: z.string().datetime({ offset: true }).nullable(), error: AppErrorSchema.nullable() }).strict();
export type NativeProcessRecord = {
  nativeToolCallId: string;
  pid: number;
  identity: string;
  executable: string;
  startedAt: string;
  stopped: boolean;
  stoppedAt?: string;
  exitCode?: number | null;
};
export type NativeOutputRecord = {
  nativeToolCallId: string;
  fileName: string;
  bytes: number;
  truncated: boolean;
  observedBytes: number;
};
export type ToolCallCleanup = {
  version: 1;
  stopReason: string | null;
  stopped: boolean;
  errors: AppError[];
  nativeProcesses?: NativeProcessRecord[];
  nativeOutputs?: NativeOutputRecord[];
};

const observationConclusion = z.enum(['valid', 'invalid', 'not_applicable', 'unknown']);
export const ToolRuntimeObservationSchema = z.object({
  version: z.literal(1),
  groupKey: z.string().min(1).max(2048),
  strategyVersion: z.literal('runtime-v1'),
  sampleSource: z.enum(['production', 'test', 'evaluation']),
  beforeOutcome: z.enum(['allowed', 'rejected']),
  failureStage: z.enum(['identity', 'sdk_arguments', 'sdk_before', 'before', 'execute', 'commit', 'validation',
    'storage', 'sdk_after', 'delivery', 'history', 'unknown']).nullable(),
  diagnosticCode: z.string().min(1).max(128).nullable(),
  afterStructure: observationConclusion,
  afterDomain: observationConclusion,
  executionDurationMs: z.number().finite().nonnegative().nullable(),
  timingComplete: z.boolean(),
  effectiveTimeoutMs: z.number().finite().positive().max(1_800_000).nullable(),
  timeoutSource: z.enum(['configured', 'statistical', 'native', 'run_remaining']).nullable(),
  runDeadlineTruncated: z.boolean(),
  commit: z.enum(['none_confirmed', 'committed', 'unknown']),
  commitError: AppErrorSchema.nullable(),
}).strict().superRefine((record, context) => {
  if (record.beforeOutcome === 'rejected' && (record.executionDurationMs !== null || record.timingComplete)) {
    context.addIssue({ code: z.ZodIssueCode.custom, message: 'A rejected call has no execution timing.' });
  }
  if (record.timingComplete && record.executionDurationMs === null) {
    context.addIssue({ code: z.ZodIssueCode.custom, message: 'Complete timing requires monotonic duration.' });
  }
  if ((record.commit === 'unknown') !== (record.commitError !== null)) {
    context.addIssue({ code: z.ZodIssueCode.custom, message: 'Unknown commit requires its query error.' });
  }
  if ((record.effectiveTimeoutMs === null) !== (record.timeoutSource === null)) {
    context.addIssue({ code: z.ZodIssueCode.custom, message: 'An effective timeout requires its source.' });
  }
});
export type ToolRuntimeObservation = z.infer<typeof ToolRuntimeObservationSchema>;
export type StoredToolResult = {
  version: 1;
  committedCandidateId: DbId | null;
  formApplication?: InvoiceFormApplicationReceipt;
} & ToolResult<unknown>;

export type ToolCallSnapshot = {
  toolCallId: DbId;
  context: ContextReference | null;
  runId: DbId;
  sessionId: DbId;
  nativeToolCallId: string;
  toolName: string;
  toolVersion: string | null;
  effect: ToolEffect | null;
  status: ToolCallStatus;
  args: { version: 1; raw: unknown; final: unknown | null };
  result: StoredToolResult | null;
  formApplication?: InvoiceFormApplicationReceipt;
  delivery: ToolCallDelivery;
  cleanup: ToolCallCleanup;
  runtimeObservation?: ToolRuntimeObservation | null;
  requestedAt: string;
  startedAt: string | null;
  endedAt: string | null;
  stoppedAt: string | null;
};
