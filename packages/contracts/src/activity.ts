import type { AppError, DbId } from './runtime.ts';
import type { CandidateDraft, CheckResult, DocumentRef, InvoiceIssue, SourceRef } from './invoice.ts';
import type { ToolEffect, ToolResult } from './tools.ts';
import type { JobStatus } from './workspace.ts';

export type CandidateSummary = {
  candidateId: DbId;
  jobId: DbId;
  runId: DbId;
  sequence: number;
  status: 'generated' | 'accepted' | 'rejected';
  issueCount: number;
  createdAt: string;
};

export type CandidateSnapshot = CandidateSummary & {
  toolCallId: DbId;
  fields: CandidateDraft['fields'];
  lines: CandidateDraft['lines'];
  notes: string[];
  checks: CheckResult[];
  issues: InvoiceIssue[];
  sources: SourceRef[];
};

export type BusinessEventType = 'document_imported' | 'task_started' | 'candidate_generated' | 'candidate_selected';
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
export type ToolCallCleanup = {
  version: 1;
  stopReason: string | null;
  stopped: boolean;
  errors: AppError[];
};
export type StoredToolResult = {
  version: 1;
  committedCandidateId: DbId | null;
} & ToolResult<unknown>;

export type ToolCallSnapshot = {
  toolCallId: DbId;
  runId: DbId;
  sessionId: DbId;
  nativeToolCallId: string;
  toolName: string;
  toolVersion: string | null;
  effect: ToolEffect | null;
  status: ToolCallStatus;
  args: { version: 1; raw: unknown; final: unknown | null };
  result: StoredToolResult | null;
  delivery: ToolCallDelivery;
  cleanup: ToolCallCleanup;
  requestedAt: string;
  startedAt: string | null;
  endedAt: string | null;
  stoppedAt: string | null;
};
