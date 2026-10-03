import type { Database } from 'bun:sqlite';
import { join, isAbsolute } from 'node:path';
import { createHash } from 'node:crypto';
import { z } from 'zod';
import { associateInputResult, completeSessionInputs, createSessionInputLedger, finishSessionInputs, markInputConsumed, recoverSessionInputs } from '../sessions/input-ledger.ts';
import type { InputResultBatch, SessionInputAdmission } from '../sessions/input-ledger.ts';
import type { RuntimeEventStore } from '../events/store.ts';
import { requireValidWorkspace, sameWorkspaceSelection } from '../workspace/verification.ts';
import { contextReferenceFromColumns, readRunContextOwner, readContextSnapshotOwner, readToolContext } from '../context/repository.ts';
import type { WorkspaceVerifier, WorkspaceVerification } from '../workspace/verification.ts';
import { InputRecordV2Schema, UsageRecordV2Schema, ToolRuntimeObservationSchema, RuntimeStrategySnapshotSchema, TOOL_CONFIG, appError, fail, ok, formatExecutionPrompt, FillInvoiceFormOutputSchema } from '@flowmate/contracts';
import type {
  AgentRunSnapshot,
  AppError,
  ChatScope,
  CleanupRecord,
  DbId,
  InputRecord,
  InputRecordV1,
  OutputRecord,
  Result,
  RunSnapshot,
  SessionCursor,
  NormalizedListSessionsRequest,
  NormalizedSessionRunsRequest,
  SessionStatus,
  SessionHistoryState,
  NativeSessionHistory,
  NativeHistoryAppendContext,
  NativeHistoryDisplayRecord,
  SafeConfigSnapshot,
  SdkUsageValues,
  TokenColumns,
  UsageRecord,
  UsageRecordV1,
  UsageRecordV2,
  DocumentSnapshot,
  WorkspaceSnapshot,
  WorkspaceSelection,
  WorkspaceRestoreResult,
  WorkspaceChange,
  JobSnapshot,
  CandidateSnapshot,
  CandidateSummary,
  CandidateReceipt,
  CandidateDraft,
  CheckResult,
  InvoiceIssue,
  InvoiceFormTarget,
  InvoiceFormApplicationReceipt,
  InvoiceFormBridgeRequest,
  InvoiceToolOutput,
  WorkspaceExpectation,
  WorkspaceContext,
  WorkspaceInput,
  SessionInputContentV2,
  GoalMode,
  SelectCandidateRequest,
  CandidateSelection,
  P3AgentConfigFacts,
  ToolIdentity,
  ToolCallSnapshot,
  ToolCallDelivery,
  ToolCallCleanup,
  StoredToolResult,
  ToolCallStatus,
  ToolRuntimeObservation,
  BusinessEventSnapshot,
  BusinessEventType,
  Page,
  NormalizedPageRequest,
  CandidateRepository,
  SaveCandidateRecord,
  ProductToolContext,
  StoredCandidateDraft,
  StoredInvoiceField,
  SaveInvoiceCandidateRequest,
  SaveInvoiceCandidateResponse,
  AcceptInvoiceCandidateRequest,
  RejectInvoiceCandidateRequest,
  InvoiceCandidateDecisionResponse,
  ExportInvoiceCandidateRequest,
  InvoiceExportReference,
  InvoiceCandidateOperationQuery,
  InvoiceCandidateOperationResult,
  SetSessionStatusRequest,
  MessageSessionInput,
} from '@flowmate/contracts';
import type { RunAgentConfigFacts, RuntimeAgentConfigFacts, AgentFacts, RunScope, LegacyRunScope } from '@flowmate/contracts';
import { AppErrorSchema, CandidateDraftSchema, CheckResultSchema, DocumentRefSchema, INVOICE_REVIEW_TOOL_NAMES, NATIVE_TOOL_NAMES, InvoiceIssueSchema, RunScopeSchema, SourceRefSchema, ToolEffectSchema, WorkspaceContextSchema, WorkspaceExpectationSchema, WorkspaceInputSchema, WorkspaceSelectionSchema, InvoiceFormTargetSchema, InvoiceFormApplicationReceiptSchema, InvoiceFormBridgeRequestSchema, FillInvoiceFormInputSchema } from '@flowmate/contracts';
import { StoredCandidateDraftSchema, SaveInvoiceCandidateRequestSchema, AcceptInvoiceCandidateRequestSchema,
  RejectInvoiceCandidateRequestSchema, ExportInvoiceCandidateRequestSchema, invoiceHeaderFields, invoiceLineFields,
  invoiceFieldDisplayValue, isLegalInvoiceNormalizedValue } from '@flowmate/contracts';
import { InvoiceCandidateOperationQuerySchema } from '@flowmate/contracts';

import { MAX_TOOL_NAME_CHARS, MAX_TOOL_VERSION_CHARS, MAX_INVOICE_PAGES,
  MAX_INVOICE_CHECKS, MAX_INVOICE_ISSUES, MAX_INVOICE_TOOL_PAGE_SIZE } from '@flowmate/contracts';

export type ValidateHumanInvoice = (draft: StoredCandidateDraft, documentRef: { id: DbId; version: string }) =>
  Result<{ checks: CheckResult[]; issues: InvoiceIssue[] }>;
export interface InvoiceEditRepository extends CandidateRepository {
  saveHuman(input: SaveInvoiceCandidateRequest & { at: string; validate: ValidateHumanInvoice }): Result<SaveInvoiceCandidateResponse>;
  accept(input: AcceptInvoiceCandidateRequest & { at: string; validate: ValidateHumanInvoice }): Result<InvoiceCandidateDecisionResponse>;
  reject(input: RejectInvoiceCandidateRequest & { at: string }): Result<InvoiceCandidateDecisionResponse>;
  readAccepted(candidateId: DbId): Result<{ candidate: CandidateSnapshot; documentRef: { id: DbId; version: string } }>;
  findExport(input: ExportInvoiceCandidateRequest): Result<InvoiceExportReference | null>;
  registerExport(input: ExportInvoiceCandidateRequest & { relativePath: string; bytes: number; sha256: string; at: string }): Result<InvoiceExportReference>;
  queryOperation(input: InvoiceCandidateOperationQuery & { at: string }): Result<InvoiceCandidateOperationResult>;
}

export type NewProviderRun = {
  goal: string;
  input: InputRecord;
  config: SafeConfigSnapshot;
  usage: UsageRecord;
  cleanup: CleanupRecord;
  createdAt: string;
};

export type NewAgentRun = Omit<NewProviderRun, 'config'> & {
  config: SafeConfigSnapshot & { agent: RunAgentConfigFacts };
  sessionId: DbId;
  scope: ChatScope | RunScope;
};

export type NewWorkspaceAgentRun = {
  sessionId: DbId;
  expected: WorkspaceExpectation;
  goalMode: GoalMode;
  text: string;
  messageTimestamp: number;
  goal: string;
  config: SafeConfigSnapshot & { agent: P3AgentConfigFacts | RuntimeAgentConfigFacts };
  usage: UsageRecord;
  cleanup: CleanupRecord;
  createdAt: string;
  nativeTools?: { runtimeDir: string; allowedTools: readonly string[]; workingDirectory?: string };
  formTarget?: InvoiceFormTarget;
};

export type WorkspaceRunAdmission = {
  runId: DbId;
  jobId: DbId | null;
  scope: RunScope;
  workspaceContext: WorkspaceContext;
  workspaceInput: WorkspaceInput;
  formTarget?: InvoiceFormTarget;
};

export type SessionRow = {
  sessionId: DbId;
  nativeSessionId: string;
  title: string;
  status: SessionStatus;
  createdAt: string;
  updatedAt: string;
  modelUseBlocked: boolean;
  hasBusinessHistory: boolean;
  historyState: SessionHistoryState;
  nativeUnusable: boolean;
  deletePending: boolean;
};

export type NewSession = { nativeSessionId: string; title: string; at: string; expectedRevision?: number; nativeHistory?: NativeSessionHistory };

export type AgentOutputRecord = OutputRecord & { agent: AgentFacts };

export type ArtifactMetadata = {
  version: 1;
  sourceKey: string;
  sourceRecordId: string;
  sourceVersion: string;
  files: Array<{ relativePath: string; bytes: number; mimeType: string }>;
};

export type StoredArtifact = {
  artifactId: DbId;
  kind: 'original' | 'parsed';
  relativePath: string;
  bytes: number;
  mimeType: string;
  metadata: ArtifactMetadata;
};

export type NewDocumentRegistration = {
  documentId: DbId;
  sourceKey: string;
  sourceRecordId: string;
  version: string;
  originalArtifact: Omit<StoredArtifact, 'kind'> & { kind: 'original'; createdAt: string };
  parsedArtifact: Omit<StoredArtifact, 'kind'> & { kind: 'parsed'; createdAt: string };
  status: 'available' | 'unavailable';
  metadata: {
    version: 2;
    sampleId?: string;
    pageCount: number;
    warnings: string[];
    allowedUsesClaim: string[];
    licenseVerification: string;
    unavailableReason: string | null;
  };
  createdAt: string;
  updatedAt: string;
};

export interface DocumentRepository {
  listArtifactIds(): Result<DbId[]>;
  listDocumentIds(): Result<DbId[]>;
  findBySource(input: { sourceKey: string; sourceRecordId: string; version: string }): Result<DocumentSnapshot | null>;
  get(documentId: DbId): Result<DocumentSnapshot>;
  list(input: NormalizedPageRequest): Result<Page<DocumentSnapshot>>;
  getArtifact(artifactId: DbId): Result<StoredArtifact>;
  register(input: NewDocumentRegistration): Result<DocumentSnapshot>;
  setAvailability(input: { documentId: DbId; status: 'available' | 'unavailable'; reason: string | null; at: string }): Result<DocumentSnapshot>;
  hide(documentId: DbId, at: string): Result<{ documentId: DbId; affectedChatCount: number }>;
  unhide(documentId: DbId, at: string): Result<DocumentSnapshot>;
}

export type WorkspaceUpdate = { expectedRevision: number; change: WorkspaceChange; at: string };
export type SelectCandidateRecord = SelectCandidateRequest & { at: string };
export interface WorkspaceRepository {
  read(at: string, verify?: WorkspaceVerifier): Result<WorkspaceSnapshot>;
  update(input: WorkspaceUpdate, verify: WorkspaceVerifier): Result<WorkspaceSnapshot>;
  restore(input: { expectedRevision: number; at: string }, verify: WorkspaceVerifier): Result<WorkspaceRestoreResult>;
  selectCandidate(input: SelectCandidateRecord): Result<CandidateSelection>;
}

export type TaskOperation = { job: JobSnapshot; workspace: WorkspaceSnapshot };
export type StartTaskRecord = {
  clientSequence: DbId;
  expectedRevision: number;
  documentRef: { id: DbId; version: string };
  goal: string;
  at: string;
};
export interface JobRepository {
  get(jobId: DbId): Result<JobSnapshot>;
  list(input: NormalizedPageRequest & { documentId?: DbId }): Result<Page<JobSnapshot>>;
  hide(jobId: DbId, at: string): Result<JobSnapshot>;
  create(input: StartTaskRecord): Result<TaskOperation>;
  queryOperation(clientSequence: DbId, at: string): Result<TaskOperation | null>;
}

export type NewToolCall = {
  runId: DbId;
  sessionId: DbId;
  nativeToolCallId: string;
  toolName: string;
  toolVersion: string | null;
  effect: import('@flowmate/contracts').ToolEffect | null;
  rawArguments: unknown;
  requestedAt: string;
};

export type ToolCallIdentity = { runId: DbId; sessionId: DbId; nativeToolCallId: string };
export interface ToolCallRepository {
  request(input: NewToolCall): Result<ToolCallSnapshot>;
  get(identity: ToolCallIdentity): Result<ToolCallSnapshot>;
  getById(toolCallId: DbId): Result<ToolCallSnapshot>;
  list(input: NormalizedPageRequest & { runId: DbId }): Result<Page<ToolCallSnapshot>>;
  fixArguments(input: { toolCallId: DbId; finalArguments: unknown }): Result<ToolCallSnapshot>;
  start(input: { toolCallId: DbId; startedAt: string }): Result<ToolCallSnapshot>;
  finish(input: { toolCallId: DbId; result: StoredToolResult; cleanup: ToolCallCleanup; endedAt: string; stoppedAt: string | null; runtimeObservation?: ToolRuntimeObservation }): Result<ToolCallSnapshot>;
  reject(input: { toolCallId: DbId; result: StoredToolResult; cleanup: ToolCallCleanup; endedAt: string; runtimeObservation?: ToolRuntimeObservation }): Result<ToolCallSnapshot>;
  queryCandidateCommit(input: { toolCallId: DbId; runId: DbId; sessionId: DbId }): Result<CandidateReceipt | null>;
  observationCutoff(): Result<DbId>;
  recentStarted(input: { groupKey: string; cutoff: DbId }): Result<ToolCallSnapshot[]>;
  recentObservations(input: { groupKey: string; cutoff: DbId }): Result<ToolCallSnapshot[]>;
  verifyUse(context: ProductToolContext): Result<void>;
  validateOutput(input: { toolCallId: DbId; data: unknown }): Result<'valid' | 'not_applicable'>;
  recordDelivery(input: { toolCallId: DbId; delivery: ToolCallDelivery }): Result<ToolCallSnapshot>;
  recordFormApplication(input: { toolCallId: DbId; receipt: InvoiceFormApplicationReceipt }): Result<ToolCallSnapshot>;
  readFormApplicationRequest(toolCallId: DbId): Result<Extract<InvoiceFormBridgeRequest, { operation: 'apply' }>>;
  getNativeWorkingDirectory(context: ProductToolContext): Result<string>;
}

export type ActivityFilter = { documentId: DbId } | { jobId: DbId };
export interface BusinessEventRepository {
  list(input: NormalizedPageRequest & ActivityFilter): Result<Page<BusinessEventSnapshot>>;
  getByOperation(input: { type: BusinessEventType; operationRef: string; result?: 'succeeded' | 'failed' }): Result<BusinessEventSnapshot | null>;
}

export interface SessionRepository {
  create(input: NewSession): Result<SessionRow>;
  get(sessionId: DbId): Result<SessionRow>;
  list(request: NormalizedListSessionsRequest): Result<{ items: SessionRow[]; next: SessionCursor | null }>;
  rename(input: { sessionId: DbId; title: string; at: string }): Result<SessionRow>;
  isModelUseBlocked(sessionId: DbId): Result<boolean>;
  revokeDocumentUse(input: { documentId: DbId; at: string }): Result<{ affectedSessionIds: DbId[] }>;
  prepareDelete(sessionId: DbId, at: string): Result<SessionRow>;
  setStatus(input: SetSessionStatusRequest & { at: string }): Result<SessionRow>;
  delete(sessionId: DbId, at: string): Result<'hidden' | 'permanent'>;
  loadHistory(sessionId: DbId): Result<NativeSessionHistory | null>;
  readHistoryForDisplay(sessionId: DbId): Result<NativeHistoryDisplayRecord & { sessionInputs: MessageSessionInput[] }>;
  saveHistory(sessionId: DbId, history: NativeSessionHistory, context?: NativeHistoryAppendContext): Result<void>;
}

export type TerminalWrite = {
  status: 'completed' | 'failed' | 'cancelled';
  output: OutputRecord | AgentOutputRecord | null;
  error: AppError | null;
  usage: UsageRecord;
  tokens: TokenColumns;
  cleanup: CleanupRecord;
  endedAt: string;
  stoppedAt: string | null;
  durationMs: number | null;
  cancelRequestedAt?: string;
  nativeHistoryUnusable?: boolean;
  inputResults?: readonly InputResultBatch[];
  confirmedUnconsumedInputIds?: readonly DbId[];
};

export interface RunRepository {
  create(input: NewProviderRun): Result<DbId>;
  createAgent(input: NewAgentRun): Result<DbId>;
  createWorkspaceAgent(input: NewWorkspaceAgentRun, verify: WorkspaceVerifier): Result<WorkspaceRunAdmission>;
  freezeInput(input: { runId: DbId; sessionId: DbId; text: string; expected?: WorkspaceExpectation; at: string }, verify: WorkspaceVerifier | undefined): Result<SessionInputAdmission>;
  verifyInputUse(content: SessionInputContentV2, verify: WorkspaceVerifier | undefined): Result<void>;
  listBySession(request: NormalizedSessionRunsRequest): Result<{ items: AgentRunSnapshot[]; nextBeforeRunId: DbId | null }>;
  start(runId: DbId, config: SafeConfigSnapshot, startedAt: string): Result<void>;
  recordCancel(runId: DbId, requestedAt: string): Result<boolean>;
  finish(runId: DbId, terminal: TerminalWrite): Result<boolean>;
  get(runId: DbId): Result<RunSnapshot>;
  supplementUsage(runId: DbId, usage: UsageRecord, tokens: TokenColumns): Result<boolean>;
  failInterrupted(endedAt: string): Result<number>;
}

type RunRow = {
  id: number;
  kind: 'provider' | 'agent';
  session_id: number | null;
  job_id?: number | null;
  current_context_snapshot_id?: number | null;
  context_observations_json?: string | null;
  scope_json: string | null;
  status: RunSnapshot['status'];
  goal: string;
  input_json: string;
  config_json: string;
  output_json: string | null;
  error_json: string | null;
  cleanup_json: string;
  usage_json: string;
  input_tokens: number | null;
  output_tokens: number | null;
  total_tokens: number | null;
  cost: string | null;
  duration_ms: number | null;
  tool_call_count: number;
  usage_complete: 0 | 1;
  created_at: string;
  started_at: string | null;
  ended_at: string | null;
  cancel_requested_at: string | null;
  stopped_at: string | null;
};

function databaseError(message = '数据库操作失败。'): ReturnType<typeof appError> {
  return appError('storage_write_failed', 'storage', message, true);
}

function isBusyConstraint(error: unknown): boolean {
  return error instanceof Error && /runs_one_active/i.test(error.message);
}

function asJson(value: unknown): string {
  return JSON.stringify(value);
}

function readJson(value: string, label: string): unknown {
  try {
    return JSON.parse(value) as unknown;
  } catch {
    throw new Error(`invalid_${label}_json`);
  }
}

function object(value: unknown, label: string): Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) throw new Error(`invalid_${label}_shape`);
  return value as Record<string, unknown>;
}

function versioned(value: unknown, label: string, keys: readonly string[]): Record<string, unknown> {
  const record = object(value, label);
  if (record.version !== 1 || keys.some((key) => !(key in record))) throw new Error(`invalid_${label}_version_or_shape`);
  return record;
}

function validAppError(value: unknown, label: string, requireVersion: boolean): AppError {
  const parsed = AppErrorSchema.safeParse(value);
  if (!parsed.success || (requireVersion && parsed.data.version !== 1)) {
    throw new Error(`invalid_${label}_shape`);
  }
  return parsed.data;
}

function validatedInput(value: unknown): InputRecord {
  const record = object(value, 'input');
  if (record.version === 2) return InputRecordV2Schema.parse(record);
  const v1 = versioned(value, 'input', ['goal', 'text', 'messageTimestamp']);
  if (typeof v1.goal !== 'string' || typeof v1.text !== 'string' || typeof v1.messageTimestamp !== 'number') throw new Error('invalid_input_shape');
  return v1 as unknown as InputRecordV1;
}

// 已保存 runtime-v1 的预算协议范围固定；不随新请求的可配置范围改变。
const storedRuntimeBudgetSchema = z.object({
  maxToolCalls: z.number().int().min(0).max(100),
  maxModelCalls: z.number().int().min(1).max(64),
  toolTimeoutMs: z.number().int().min(100).max(1_800_000),
}).strict();

function validatedAgentConfig(value: unknown): Record<string, unknown> {
  const agent = object(value, 'config_agent');
  const commonInvalid = typeof agent.nativeSessionId !== 'string'
    || agent.nativeSessionId.length < 1 || agent.nativeSessionId.length > 128
    || typeof agent.systemPrompt !== 'string'
    || !['off', 'minimal', 'low', 'medium', 'high', 'xhigh'].includes(String(agent.thinkingLevel))
    || agent.resourcePolicy !== 'none'
    || agent.historyPolicy !== 'memory-only'
    || agent.sessionRetry !== false;
  const p2Invalid = agent.policyVersion === 'p2-invoice-chat-v1'
    && (commonInvalid || agent.maxContextBytes !== 524_288 || agent.maxOutputBytes !== 262_144
      || agent.maxAssistantContentBytes !== 524_288 || agent.maxModelCalls !== 1);
  const p3Invalid = agent.policyVersion === 'p3-invoice-tools-v1'
    && (commonInvalid || agent.maxContextBytes !== 8_388_608 || agent.maxOutputBytes !== 262_144
      || agent.maxAssistantContentBytes !== 524_288 || (agent.maxModelCalls !== 12 && agent.maxModelCalls !== 16)
      || agent.maxToolCalls !== 24 || agent.toolTimeoutMs !== 10_000);
  const p5Invalid = agent.policyVersion === 'p5-session-inputs-v1'
    && (commonInvalid || agent.maxContextBytes !== 524_288 || agent.maxOutputBytes !== 262_144
      || agent.maxAssistantContentBytes !== 524_288 || agent.maxModelCalls !== 12);
  const runtimeInvalid = agent.policyVersion === 'runtime-v1' && (commonInvalid
    || !['p2-invoice-chat-v1', 'p3-invoice-tools-v1', 'p5-session-inputs-v1'].includes(String(agent.taskPolicyVersion))
    || agent.maxContextBytes !== (agent.taskPolicyVersion === 'p3-invoice-tools-v1' ? 8_388_608 : 524_288)
    || agent.maxOutputBytes !== 262_144 || agent.maxAssistantContentBytes !== 524_288
    || !storedRuntimeBudgetSchema.safeParse({ maxToolCalls: agent.maxToolCalls,
      maxModelCalls: agent.maxModelCalls, toolTimeoutMs: agent.toolTimeoutMs }).success);
  if (p2Invalid || p3Invalid || p5Invalid || runtimeInvalid
    || !['p2-invoice-chat-v1', 'p3-invoice-tools-v1', 'p5-session-inputs-v1', 'runtime-v1'].includes(String(agent.policyVersion))) {
    throw new Error('invalid_agent_config_shape');
  }
  return agent;
}

function validatedConfig(value: unknown, kind: RunRow['kind'] = 'provider'): Record<string, unknown> {
  const raw = object(value, 'config');
  if (Object.hasOwn(raw, 'contextPolicyVersion') && (raw.contextPolicyVersion !== 'p8-context-v1' || kind !== 'agent')) throw new Error('invalid_context_policy');
  const record = versioned(raw.version === 2 ? { ...raw, version: 1 } : raw, 'config', ['name', 'revision', 'requestedModel', 'resolvedModel', 'api', 'endpoint', 'sdk', 'parameters', 'limits', 'native']);
  if (typeof record.name !== 'string' || !Number.isSafeInteger(record.revision) || Number(record.revision) <= 0) throw new Error('invalid_config_shape');
  const model = (candidate: unknown, label: string) => {
    if (candidate === null && label === 'resolvedModel') return;
    const value = object(candidate, label);
    if (typeof value.provider !== 'string' || typeof value.model !== 'string') throw new Error(`invalid_${label}_shape`);
  };
  model(record.requestedModel, 'requestedModel');
  model(record.resolvedModel, 'resolvedModel');
  object(record.sdk, 'config_sdk');
  object(record.parameters, 'config_parameters');
  object(record.limits, 'config_limits');
  object(record.native, 'config_native');
  if (record.outputBudget !== undefined) versioned(record.outputBudget, 'outputBudget', ['policy', 'selectedMaxTokens', 'source']);
  if (kind === 'agent') {
    const agent = validatedAgentConfig(record.agent);
    if ((raw.version === 2) !== (agent.policyVersion === 'runtime-v1')) throw new Error('invalid_runtime_config_version');
    if (raw.version === 2 && record.runtimeBudget === undefined) throw new Error('missing_runtime_budget');
    if (record.runtimeBudget !== undefined) {
      const budget = storedRuntimeBudgetSchema.parse(record.runtimeBudget);
      if (budget.maxToolCalls !== agent.maxToolCalls || budget.maxModelCalls !== agent.maxModelCalls
        || budget.toolTimeoutMs !== agent.toolTimeoutMs) throw new Error('invalid_runtime_config_budget');
    }
  }
  else if (record.agent !== undefined) throw new Error('unexpected_provider_agent_config');
  if (record.runtimeStrategy !== undefined) RuntimeStrategySnapshotSchema.parse(record.runtimeStrategy);
  if (record.workspaceContext !== undefined) WorkspaceContextSchema.parse(record.workspaceContext);
  if (record.goalMode !== undefined && !['answer', 'save-candidate', 'fill-form', 'local-task'].includes(String(record.goalMode))) throw new Error('invalid_goal_mode');
  if (record.formTarget !== undefined) {
    InvoiceFormTargetSchema.parse(record.formTarget);
    if (record.goalMode !== 'fill-form') throw new Error('unexpected_form_target');
  } else if (record.goalMode === 'fill-form') throw new Error('missing_form_target');
  if (record.workingDirectory !== undefined && (typeof record.workingDirectory !== 'string'
    || !isAbsolute(record.workingDirectory) || /[\x00-\x1f\x7f]/.test(record.workingDirectory))) throw new Error('invalid_working_directory');
  if (record.goalMode === 'local-task' && (typeof record.workingDirectory !== 'string'
    || record.workspaceContext !== undefined)) throw new Error('invalid_local_task_config');
  return { ...record, version: raw.version };
}

function validatedAgentFacts(value: unknown, runtime = false): Record<string, unknown> {
  const agent = object(value, 'output_agent');
  if (typeof agent.nativeSessionId !== 'string' || agent.nativeSessionId.length < 1 || agent.nativeSessionId.length > 128
    || !Number.isSafeInteger(agent.turnCount) || Number(agent.turnCount) < 0
    || !Number.isSafeInteger(agent.modelCallCount) || Number(agent.modelCallCount) < 0) throw new Error('invalid_agent_output_shape');
  if (agent.candidateIds !== undefined && (!Array.isArray(agent.candidateIds) || agent.candidateIds.length > (runtime ? 100 : 24)
    || !agent.candidateIds.every((id) => Number.isSafeInteger(id) && Number(id) > 0)
    || new Set(agent.candidateIds).size !== agent.candidateIds.length)) throw new Error('invalid_agent_candidate_ids');
  if (agent.modelCalls !== undefined) z.array(z.object({ callSequence: z.number().int().min(1).max(64),
    durationMs: z.number().finite().nonnegative(), complete: z.boolean() }).strict()).max(64)
    .superRefine((calls, context) => {
      if (new Set(calls.map(call => call.callSequence)).size !== calls.length) context.addIssue({ code: 'custom', message: 'Model call sequences must be unique.' });
    }).parse(agent.modelCalls);
  return agent;
}

function validatedScope(value: unknown): ChatScope | RunScope | LegacyRunScope {
  const record = object(value, 'scope');
  if (record.version === 3) {
    const { allowedWritePaths, commandAccess, ...base } = record;
    const scope = RunScopeSchema.parse({ ...base, version: 2 });
    if (!Array.isArray(allowedWritePaths) || !allowedWritePaths.every((path) => typeof path === 'string'
      && isAbsolute(path) && !/[\x00-\x1f\x7f]/.test(path)) || new Set(allowedWritePaths).size !== allowedWritePaths.length
      || !['none', 'trusted-local'].includes(String(commandAccess))) throw new Error('invalid_legacy_agent_scope_shape');
    return { ...scope, version: 3, allowedWritePaths, commandAccess } as LegacyRunScope;
  }
  if (record.version === 2) {
    const parsed = RunScopeSchema.safeParse(record);
    if (!parsed.success) throw new Error('invalid_agent_scope_shape');
    return parsed.data;
  }
  if (record.version !== 1 || record.mode !== 'chat-text'
    || !Array.isArray(record.toolNames) || record.toolNames.length !== 0
    || !Array.isArray(record.resourcePaths) || record.resourcePaths.length !== 0
    || Object.keys(record).some((key) => !['version', 'mode', 'toolNames', 'resourcePaths'].includes(key))) {
    throw new Error('invalid_agent_scope_shape');
  }
  return record as unknown as ChatScope;
}

function validatedOutput(value: unknown, kind: RunRow['kind'] = 'provider'): Record<string, unknown> {
  const raw = object(value, 'output');
  const record = versioned(raw.version === 2 ? { ...raw, version: 1 } : raw, 'output', ['text', 'partial', 'stopReason', 'responseId', 'responseModel']);
  if (typeof record.text !== 'string' || typeof record.partial !== 'boolean' || typeof record.stopReason !== 'string'
    || (record.wireMaxTokens !== undefined && record.wireMaxTokens !== null && (!Number.isSafeInteger(record.wireMaxTokens) || Number(record.wireMaxTokens) < 1))) throw new Error('invalid_output_shape');
  if (kind === 'agent') validatedAgentFacts(record.agent, raw.version === 2);
  else if (record.agent !== undefined) throw new Error('unexpected_provider_agent_output');
  return { ...record, version: raw.version };
}

function validatedUsage(value: unknown): UsageRecord {
  const usageObject = object(value, 'usage');
  if (usageObject.version === 2) return UsageRecordV2Schema.parse(usageObject);
  const record = versioned(value, 'usage', ['source', 'reason', 'sdkValues', 'attempts', 'attemptsComplete', 'costSource', 'updatedAt']);
  if (!['sdk', 'unknown', 'not-requested'].includes(String(record.source))
    || (record.reason !== null && typeof record.reason !== 'string')
    || (record.sdkValues !== null && typeof record.sdkValues !== 'object')
    || (record.attempts !== null && (!Number.isSafeInteger(record.attempts) || Number(record.attempts) < 0))
    || typeof record.attemptsComplete !== 'boolean'
    || (record.costSource !== null && typeof record.costSource !== 'string')
    || typeof record.updatedAt !== 'string') throw new Error('invalid_usage_shape');
  return record as unknown as UsageRecord;
}

function validatedCleanup(value: unknown): CleanupRecord {
  const record = versioned(value, 'cleanup', ['stopped', 'stopReason', 'errors', 'lateObservationRequired']);
  if (typeof record.stopped !== 'boolean' || (record.stopReason !== null && typeof record.stopReason !== 'string')
    || !Array.isArray(record.errors) || typeof record.lateObservationRequired !== 'boolean') throw new Error('invalid_cleanup_shape');
  record.errors.forEach((entry, index) => validAppError(entry, `cleanup_error_${index}`, false));
  return record as unknown as CleanupRecord;
}

function validatedError(value: unknown): AppError | null {
  if (value === null) return null;
  return validAppError(value, 'error', true);
}

function sessionRow(value: unknown, hasHistory = false): SessionRow {
  const row = value as {
    id: number; native_session_id: string; title: string; status: string; created_at: string; updated_at: string; metadata_json: string;
  } | null;
  if (!row || !Number.isSafeInteger(row.id) || row.id <= 0
    || typeof row.native_session_id !== 'string' || row.native_session_id.length < 1 || row.native_session_id.length > 128
    || typeof row.title !== 'string' || row.title.trim().length < 1 || [...row.title].length > 120
    || !['active', 'archived'].includes(row.status)
    || typeof row.created_at !== 'string' || typeof row.updated_at !== 'string') throw new Error('invalid_session_row');
  const blocked = parseSessionModelUse(row.metadata_json);
  return {
    sessionId: row.id,
    nativeSessionId: row.native_session_id,
    title: row.title,
    status: row.status as SessionRow['status'],
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    modelUseBlocked: blocked !== null,
    hasBusinessHistory: hasHistory,
    historyState: 'legacy-read-only',
    nativeUnusable: false,
    deletePending: parseSessionMetadata(row.metadata_json).delete_pending === true,
  };
}

function parseSessionMetadata(value: string): Record<string, unknown> {
  const metadata = recordWithOptional(readJson(value, 'session_metadata'), 'session_metadata', ['version', 'model_use_blocked'], ['tool_profile', 'delete_pending']);
  if (metadata.version !== 1) throw new Error('invalid_session_metadata_version');
  if (metadata.tool_profile !== undefined && !['invoice', 'trusted-local'].includes(String(metadata.tool_profile))) throw new Error('invalid_session_tool_profile');
  if (metadata.delete_pending !== undefined && metadata.delete_pending !== true) throw new Error('invalid_session_delete_pending');
  return metadata;
}
function parseSessionModelUse(value: string): { documentIds: number[]; at: string; reason: 'document_use_revoked' } | null {
  const metadata = parseSessionMetadata(value);
  if (metadata.model_use_blocked === null) return null;
  const blocked = exactRecord(metadata.model_use_blocked, 'session_model_use_blocked', ['documentIds', 'at', 'reason']);
  if (!Array.isArray(blocked.documentIds) || blocked.documentIds.length < 1
    || !blocked.documentIds.every((id) => Number.isSafeInteger(id) && Number(id) > 0)
    || new Set(blocked.documentIds).size !== blocked.documentIds.length
    || typeof blocked.at !== 'string' || !Number.isFinite(Date.parse(blocked.at))
    || blocked.reason !== 'document_use_revoked') throw new Error('invalid_session_model_use_blocked');
  return { documentIds: blocked.documentIds as number[], at: blocked.at, reason: blocked.reason };
}

type DocumentRunAssociation = { session_id: number; scope_json: string | null; config_json: string; job_document_id: number | null };

function runUsesDocument(row: DocumentRunAssociation, documentId: DbId): boolean {
  let scope: unknown = null;
  try { scope = row.scope_json === null ? null : JSON.parse(row.scope_json); } catch { /* Invalid P3 scope must be treated conservatively. */ }
  try {
    const parsed = validatedScope(scope);
    return parsed.version !== 1 && parsed.allowedDocumentIds.includes(documentId) || row.job_document_id === documentId;
  } catch { return row.job_document_id === documentId || configPolicy(row.config_json) !== 'p2'; }
}

function blockSessionsUsingDocument(db: Database, documentId: DbId, at: string): DbId[] {
  const rows = db.query(`SELECT run.session_id,run.scope_json,run.config_json,job.document_id AS job_document_id
    FROM runs run LEFT JOIN jobs job ON job.id=run.job_id WHERE run.kind='agent' AND run.session_id IS NOT NULL`).all() as DocumentRunAssociation[];
  const affected = [...new Set(rows.filter((row) => runUsesDocument(row, documentId)).map((row) => row.session_id))]
    .sort((left, right) => left - right);
  for (const sessionId of affected) {
    const row = db.query('SELECT metadata_json FROM sessions WHERE id=?').get(sessionId) as { metadata_json: string } | null;
    if (!row) throw new Error('revocation_session_missing');
    const current = parseSessionModelUse(row.metadata_json);
    const documentIds = [...new Set([...(current?.documentIds ?? []), documentId])].sort((left, right) => left - right);
    const metadata = JSON.stringify({ ...parseSessionMetadata(row.metadata_json), model_use_blocked: { documentIds, at, reason: 'document_use_revoked' } });
    if (db.query('UPDATE sessions SET metadata_json=?,updated_at=? WHERE id=?').run(metadata, at, sessionId).changes !== 1) {
      throw new Error('revocation_session_update_failed');
    }
  }
  return affected;
}

function configPolicy(value: string | null): 'p2' | 'p3' | null {
  if (value === null) return null;
  try {
    const config = object(JSON.parse(value), 'run_config');
    const agent = object(config.agent, 'run_config_agent');
    return agent.policyVersion === 'p2-invoice-chat-v1' ? 'p2'
      : agent.policyVersion === 'p3-invoice-tools-v1' ? 'p3' : null;
  } catch { return null; }
}

function exactRecord(value: unknown, label: string, keys: readonly string[]): Record<string, unknown> {
  const parsed = object(value, label);
  if (Object.keys(parsed).length !== keys.length || keys.some((key) => !(key in parsed))) throw new Error(`invalid_${label}_shape`);
  return parsed;
}

function recordWithOptional(value: unknown, label: string, required: readonly string[], optional: readonly string[]): Record<string, unknown> {
  const parsed = object(value, label);
  if (required.some((key) => !(key in parsed)) || Object.keys(parsed).some((key) => !required.includes(key) && !optional.includes(key))) throw new Error(`invalid_${label}_shape`);
  return parsed;
}

const nativeIdSchema = z.string().min(1).max(256).refine((value) => !/[\x00-\x1f\x7f]/.test(value));
const nativeProcessSchema = z.object({
  nativeToolCallId: nativeIdSchema, pid: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
  identity: nativeIdSchema, executable: z.string().min(1).max(4096).refine((value) => !/[\x00-\x1f\x7f]/.test(value)),
  startedAt: z.string().datetime(), stopped: z.boolean(), stoppedAt: z.string().datetime().optional(),
  exitCode: z.number().int().nullable().optional(),
}).strict().superRefine((record, context) => {
  if (!record.stopped && (record.stoppedAt !== undefined || record.exitCode !== undefined)) {
    context.addIssue({ code: z.ZodIssueCode.custom, message: 'An active process cannot have terminal facts.' });
  }
});
const nativeOutputSchema = z.object({
  nativeToolCallId: nativeIdSchema,
  fileName: z.string().min(1).max(255).refine((value) => !/[\\/:\x00-\x1f\x7f]/.test(value) && value !== '.' && value !== '..'),
  bytes: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER), truncated: z.boolean(),
  observedBytes: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
}).strict().refine((record) => record.observedBytes >= record.bytes);

function readToolCleanup(value: unknown): ToolCallCleanup {
  const cleanup = recordWithOptional(value, 'tool_call_cleanup', ['version', 'stopReason', 'stopped', 'errors'], ['nativeProcesses', 'nativeOutputs']);
  if (cleanup.version !== 1 || cleanup.stopReason !== null && typeof cleanup.stopReason !== 'string'
    || typeof cleanup.stopped !== 'boolean' || !Array.isArray(cleanup.errors)) throw new Error('invalid_tool_call_cleanup');
  return { version: 1, stopReason: cleanup.stopReason as string | null, stopped: cleanup.stopped,
    errors: cleanup.errors.map((error) => AppErrorSchema.parse(error)),
    ...(cleanup.nativeProcesses === undefined ? {} : { nativeProcesses: z.array(nativeProcessSchema).max(24).parse(cleanup.nativeProcesses) }),
    ...(cleanup.nativeOutputs === undefined ? {} : { nativeOutputs: z.array(nativeOutputSchema).max(24).parse(cleanup.nativeOutputs) }) };
}

function artifactMetadata(value: unknown): ArtifactMetadata {
  const row = exactRecord(value, 'artifact_metadata', ['version', 'sourceKey', 'sourceRecordId', 'sourceVersion', 'files']);
  if (row.version !== 1 || typeof row.sourceKey !== 'string' || typeof row.sourceRecordId !== 'string'
    || typeof row.sourceVersion !== 'string' || !Array.isArray(row.files)) throw new Error('invalid_artifact_metadata');
  const files = row.files.map((item) => {
    const file = exactRecord(item, 'artifact_file', ['relativePath', 'bytes', 'mimeType']);
    if (typeof file.relativePath !== 'string' || file.relativePath.length < 1
      || !Number.isSafeInteger(file.bytes) || Number(file.bytes) <= 0
      || typeof file.mimeType !== 'string' || file.mimeType.length < 1) throw new Error('invalid_artifact_file');
    return { relativePath: file.relativePath, bytes: Number(file.bytes), mimeType: file.mimeType };
  });
  return { version: 1, sourceKey: row.sourceKey, sourceRecordId: row.sourceRecordId, sourceVersion: row.sourceVersion, files };
}

function documentSnapshot(value: unknown): DocumentSnapshot {
  const row = value as {
    id: number; version: string; status: string; original_artifact_id: number; parsed_artifact_id: number;
    metadata_json: string; created_at: string; updated_at: string; hidden_at?: string | null;
  } | null;
  if (!row || !Number.isSafeInteger(row.id) || row.id <= 0 || typeof row.version !== 'string'
    || !['available', 'unavailable'].includes(row.status) || !Number.isSafeInteger(row.original_artifact_id)
    || !Number.isSafeInteger(row.parsed_artifact_id)
    || typeof row.created_at !== 'string' || typeof row.updated_at !== 'string') {
    throw new Error('invalid_document_row');
  }
  const rawMetadata = readJson(row.metadata_json, 'document_metadata');
  const hasSampleId = Object.prototype.hasOwnProperty.call(rawMetadata, 'sampleId');
  const metadata = exactRecord(rawMetadata, 'document_metadata', [
    'version', 'pageCount', 'warnings', 'allowedUsesClaim', 'licenseVerification', 'unavailableReason',
    ...(hasSampleId ? ['sampleId'] : []),
  ]);
  if (metadata.version !== 2 || !Number.isSafeInteger(metadata.pageCount) || Number(metadata.pageCount) < 1
    || Number(metadata.pageCount) > MAX_INVOICE_PAGES
    || !Array.isArray(metadata.warnings) || !metadata.warnings.every((item) => typeof item === 'string')
    || !Array.isArray(metadata.allowedUsesClaim) || !metadata.allowedUsesClaim.every((item) => typeof item === 'string')
    || typeof metadata.licenseVerification !== 'string'
    || (metadata.unavailableReason !== null && typeof metadata.unavailableReason !== 'string')
    || (hasSampleId && (typeof metadata.sampleId !== 'string' || !/^\d{6}$/.test(metadata.sampleId)))) throw new Error('invalid_document_metadata');
  DocumentRefSchema.parse({ id: row.id, version: row.version });
  return {
    documentRef: { id: row.id, version: row.version }, status: row.status as DocumentSnapshot['status'], isHidden: row.hidden_at != null,
    displayName: hasSampleId ? `Invoice ${metadata.sampleId}` : `Invoice imported ${new Intl.DateTimeFormat('en-US', {
      month: 'short', day: 'numeric', year: 'numeric', timeZone: 'UTC',
    }).format(new Date(row.created_at))}`,
    pageCount: Number(metadata.pageCount), originalArtifactId: row.original_artifact_id, parsedArtifactId: row.parsed_artifact_id,
    warnings: metadata.warnings as string[], unavailableReason: metadata.unavailableReason as string | null,
    createdAt: row.created_at, updatedAt: row.updated_at,
  };
}

function storedArtifact(value: unknown): StoredArtifact {
  const row = value as {
    id: number; kind: string; relative_path: string; bytes: number; mime_type: string; metadata_json: string;
  } | null;
  if (!row || !Number.isSafeInteger(row.id) || row.id <= 0 || !['original', 'parsed'].includes(row.kind)
    || typeof row.relative_path !== 'string' || !Number.isSafeInteger(row.bytes) || row.bytes <= 0
    || typeof row.mime_type !== 'string') throw new Error('invalid_artifact_row');
  return { artifactId: row.id, kind: row.kind as StoredArtifact['kind'], relativePath: row.relative_path,
    bytes: row.bytes, mimeType: row.mime_type, metadata: artifactMetadata(readJson(row.metadata_json, 'artifact_metadata')) };
}

function readToolEnvelope(value: string | null): { result: StoredToolResult | null; formApplication?: InvoiceFormApplicationReceipt } {
  if (value === null) return { result: null };
  const record = object(readJson(value, 'tool_call_result'), 'tool_call_result');
  const formApplication = record.formApplication === undefined ? undefined : InvoiceFormApplicationReceiptSchema.parse(record.formApplication);
  if (!('status' in record)) {
    exactRecord(record, 'pending_tool_result', ['version', 'formApplication']);
    if (record.version !== 1 || formApplication === undefined) throw new Error('invalid_pending_tool_result');
    return { result: null, formApplication };
  }
  if (record.version !== 1 || !['succeeded', 'failed', 'cancelled'].includes(String(record.status))
    || (record.committedCandidateId !== null && (!Number.isSafeInteger(record.committedCandidateId) || Number(record.committedCandidateId) < 1))) {
    throw new Error('invalid_tool_call_result');
  }
  if (record.status === 'succeeded') {
    if (!('data' in record) || 'error' in record) throw new Error('invalid_tool_call_result');
  } else {
    if (!('error' in record) || 'data' in record && record.data === undefined) throw new Error('invalid_tool_call_result');
    AppErrorSchema.parse(record.error);
  }
  return { result: record as unknown as StoredToolResult, ...(formApplication === undefined ? {} : { formApplication }) };
}

type FormApplicationCall = {
  toolCallId: DbId; runId: DbId; sessionId: DbId; nativeToolCallId: string; toolName: string; effect: string | null;
  args: { final: unknown }; startedAt: string | null;
};

function deriveFormApplicationRequest(db: Database, call: FormApplicationCall): Extract<InvoiceFormBridgeRequest, { operation: 'apply' }> {
  if (call.toolName !== 'fill_invoice_form' || call.effect !== 'LOCAL_WRITE') throw new Error('invalid_form_application_identity');
  const run = db.query("SELECT session_id,job_id,scope_json,config_json FROM runs WHERE id=? AND kind='agent'")
    .get(call.runId) as { session_id: number; job_id: number | null; scope_json: string; config_json: string } | null;
  if (!run || run.session_id !== call.sessionId || run.job_id === null) throw new Error('invalid_form_application_run');
  const config = validatedConfig(readJson(run.config_json, 'run_config'), 'agent');
  const context = WorkspaceContextSchema.parse(config.workspaceContext);
  const target = InvoiceFormTargetSchema.parse(config.formTarget);
  const scope = RunScopeSchema.parse(readJson(run.scope_json, 'run_scope'));
  const args = FillInvoiceFormInputSchema.parse(call.args.final);
  const candidate = candidateSnapshot(db, queryCandidateRow(db, args.candidateId, run.job_id));
  if (config.goalMode !== 'fill-form' || scope.allowedTools.length !== 1 || scope.allowedTools[0] !== 'fill_invoice_form'
    || context.sessionId !== call.sessionId || context.jobId !== run.job_id
    || context.documentRef?.id !== candidate.documentRef.id || context.documentRef.version !== candidate.documentRef.version
    || !scope.allowedDocumentIds.includes(candidate.documentRef.id)
    || context.candidateRef?.id !== args.candidateId || context.candidateRef.sequence !== candidate.snapshot.sequence) {
    throw new Error('invalid_form_application_binding');
  }
  const request = InvoiceFormBridgeRequestSchema.parse({ operation: 'apply', runId: call.runId, sessionId: call.sessionId,
    toolCallId: call.toolCallId, nativeToolCallId: call.nativeToolCallId, documentRef: candidate.documentRef, jobId: run.job_id,
    candidateId: candidate.snapshot.candidateId, candidateSequence: candidate.snapshot.sequence, target,
    candidate: { fields: candidate.snapshot.fields, lines: candidate.snapshot.lines, notes: candidate.snapshot.notes } });
  if (request.operation !== 'apply') throw new Error('invalid_form_application_operation');
  return request;
}

function validateFormApplication(db: Database, call: FormApplicationCall, receipt: InvoiceFormApplicationReceipt): void {
  const request = deriveFormApplicationRequest(db, call);
  if (receipt.toolCallId !== request.toolCallId || receipt.runId !== request.runId
    || receipt.candidateId !== request.candidateId || receipt.candidateSequence !== request.candidateSequence
    || receipt.formInstanceId !== request.target.formInstanceId
    || receipt.outcome === 'applied' && (call.startedAt === null || !Number.isSafeInteger(request.target.expectedRevision + 1)
      || receipt.appliedRevision !== request.target.expectedRevision + 1 || Date.parse(receipt.appliedAt) > Date.parse(receipt.observedAt))) {
    throw new Error('invalid_form_application_receipt');
  }
}

function toolResultCore(result: StoredToolResult): Omit<StoredToolResult, 'formApplication'> {
  const { formApplication: _receipt, ...core } = result;
  return core;
}

function toolCallSnapshot(db: Database, value: unknown): ToolCallSnapshot {
  const row = value as {
    id: number; run_id: number; session_id: number; native_tool_call_id: string; tool_name: string;
    tool_version: string | null; effect: string | null; status: string; args_json: string; result_json: string | null;
    delivery_json: string; cleanup_json: string; requested_at: string; started_at: string | null;
    ended_at: string | null; stopped_at: string | null; runtime_observation_json: string | null;
    context_snapshot_id?: number | null; request_sequence?: number | null;
  } | null;
  if (!row || !Number.isSafeInteger(row.id) || row.id < 1 || !Number.isSafeInteger(row.run_id) || row.run_id < 1
    || !Number.isSafeInteger(row.session_id) || row.session_id < 1 || typeof row.native_tool_call_id !== 'string'
    || row.native_tool_call_id.length < 1 || row.native_tool_call_id.length > 256 || typeof row.tool_name !== 'string'
    || row.tool_name.length < 1 || row.tool_name.length > MAX_TOOL_NAME_CHARS
    || (row.tool_version !== null && (typeof row.tool_version !== 'string' || row.tool_version.length < 1 || row.tool_version.length > MAX_TOOL_VERSION_CHARS))
    || (row.effect !== null && !ToolEffectSchema.safeParse(row.effect).success)
    || !['requested', 'running', 'succeeded', 'failed', 'cancelled'].includes(row.status)
    || typeof row.requested_at !== 'string'
    || (row.started_at !== null && typeof row.started_at !== 'string')
    || (row.ended_at !== null && typeof row.ended_at !== 'string')
    || (row.stopped_at !== null && typeof row.stopped_at !== 'string')) throw new Error('invalid_tool_call_row');
  const args = exactRecord(readJson(row.args_json, 'tool_call_arguments'), 'tool_call_arguments', ['version', 'raw', 'final']);
  if (args.version !== 1) throw new Error('invalid_tool_call_arguments');
  const deliveryObject = exactRecord(readJson(row.delivery_json, 'tool_call_delivery'), 'tool_call_delivery', [
    'version', 'state', 'messageObservedAt', 'includedInCallSequence', 'requestDispatchedAt', 'error',
  ]);
  if (deliveryObject.version !== 1 || !['not_attempted', 'message_observed', 'request_observed', 'failed', 'unknown'].includes(String(deliveryObject.state))
    || (deliveryObject.messageObservedAt !== null && typeof deliveryObject.messageObservedAt !== 'string')
    || (deliveryObject.includedInCallSequence !== null && (!Number.isSafeInteger(deliveryObject.includedInCallSequence) || Number(deliveryObject.includedInCallSequence) < 1))
    || (deliveryObject.requestDispatchedAt !== null && typeof deliveryObject.requestDispatchedAt !== 'string')) throw new Error('invalid_tool_call_delivery');
  const deliveryError = deliveryObject.error === null ? null : AppErrorSchema.parse(deliveryObject.error);
  const cleanup = readToolCleanup(readJson(row.cleanup_json, 'tool_call_cleanup'));
  const { result, formApplication } = readToolEnvelope(row.result_json);
  const terminal = ['succeeded', 'failed', 'cancelled'].includes(row.status);
  const runtimeObservation = row.runtime_observation_json == null ? null
    : ToolRuntimeObservationSchema.parse(readJson(row.runtime_observation_json, 'tool_runtime_observation'));
  if (runtimeObservation !== null && (!terminal || runtimeObservation.beforeOutcome === 'rejected' && row.started_at !== null)) {
    throw new Error('invalid_tool_runtime_observation_state');
  }
  if (terminal !== (row.ended_at !== null) || terminal !== (result !== null)
    || result !== null && result.status !== row.status) throw new Error('invalid_tool_call_terminal');
  if (row.status === 'succeeded' && (row.started_at === null || row.stopped_at === null)) throw new Error('invalid_tool_call_success');
  if (formApplication !== undefined) validateFormApplication(db, {
    toolCallId: row.id, runId: row.run_id, sessionId: row.session_id, nativeToolCallId: row.native_tool_call_id, toolName: row.tool_name, effect: row.effect,
    args: { final: args.final }, startedAt: row.started_at,
  }, formApplication);
  return {
    toolCallId: row.id, runId: row.run_id, sessionId: row.session_id, nativeToolCallId: row.native_tool_call_id,
    context: readToolContext(db, row),
    toolName: row.tool_name, toolVersion: row.tool_version, effect: row.effect as ToolCallSnapshot['effect'],
    status: row.status as ToolCallStatus, args: args as unknown as ToolCallSnapshot['args'], result,
    ...(formApplication === undefined ? {} : { formApplication }),
    delivery: { version: 1, state: deliveryObject.state as ToolCallDelivery['state'],
      messageObservedAt: deliveryObject.messageObservedAt as string | null,
      includedInCallSequence: deliveryObject.includedInCallSequence as number | null,
      requestDispatchedAt: deliveryObject.requestDispatchedAt as string | null, error: deliveryError },
    cleanup, runtimeObservation,
    requestedAt: row.requested_at, startedAt: row.started_at, endedAt: row.ended_at, stoppedAt: row.stopped_at,
  };
}

function businessEventSnapshot(value: unknown): BusinessEventSnapshot {
  const row = value as {
    id: number; type: string; occurred_at: string; actor_source: string; operation_ref: string;
    document_id: number | null; job_id: number | null; candidate_id: number | null; artifact_id: number | null;
    run_id: number | null; result: string; safe_summary: string; error_code: string | null;
  } | null;
  if (!row || !Number.isSafeInteger(row.id) || row.id < 1
    || !['document_imported', 'task_started', 'candidate_generated', 'candidate_selected', 'candidate_edited',
      'candidate_accepted', 'candidate_rejected', 'candidate_exported'].includes(row.type)
    || typeof row.occurred_at !== 'string' || !['user', 'agent', 'system'].includes(row.actor_source)
    || typeof row.operation_ref !== 'string' || row.operation_ref.length < 1 || row.operation_ref.length > 256
    || !['succeeded', 'failed'].includes(row.result) || typeof row.safe_summary !== 'string' || row.safe_summary.length > 512
    || (row.error_code !== null && typeof row.error_code !== 'string')
    || [row.document_id, row.job_id, row.candidate_id, row.artifact_id, row.run_id].some((id) => id !== null && (!Number.isSafeInteger(id) || id < 1))) {
    throw new Error('invalid_business_event_row');
  }
  return { id: row.id, type: row.type as BusinessEventType, occurredAt: row.occurred_at,
    actorSource: row.actor_source as BusinessEventSnapshot['actorSource'], operationRef: row.operation_ref,
    documentId: row.document_id, jobId: row.job_id, candidateId: row.candidate_id, artifactId: row.artifact_id,
    runId: row.run_id, result: row.result as BusinessEventSnapshot['result'], safeSummary: row.safe_summary, errorCode: row.error_code };
}

function candidateSnapshot(db: Database, value: unknown): { snapshot: CandidateSnapshot; documentRef: { id: DbId; version: string } } {
  const row = value as {
    id: number; job_id: number; run_id: number | null; tool_call_id: number | null; sequence: number; status: string;
    origin: string; based_on_candidate_id?: number | null;
    fields_json: string; lines_json: string; issues_json: string; created_at: string; accepted_at: string | null;
    document_id: number; document_version: string;
    context_snapshot_id?: number | null; request_sequence?: number | null;
  } | null;
  if (!row || !Number.isSafeInteger(row.id) || row.id < 1 || !Number.isSafeInteger(row.job_id) || row.job_id < 1
    || (row.origin === 'model' ? !Number.isSafeInteger(row.run_id) || Number(row.run_id) < 1
      || !Number.isSafeInteger(row.tool_call_id) || Number(row.tool_call_id) < 1 || (row.based_on_candidate_id ?? null) !== null
      : row.origin !== 'human_edit' || row.run_id !== null || row.tool_call_id !== null
        || !Number.isSafeInteger(row.based_on_candidate_id) || Number(row.based_on_candidate_id) < 1 || row.based_on_candidate_id === row.id)
    || !Number.isSafeInteger(row.sequence) || row.sequence < 1 || !['generated', 'accepted', 'rejected'].includes(row.status)
    || typeof row.created_at !== 'string' || (row.accepted_at !== null && typeof row.accepted_at !== 'string')
    || !Number.isSafeInteger(row.document_id) || row.document_id < 1 || typeof row.document_version !== 'string') {
    throw new Error('invalid_candidate_row');
  }
  const fields = exactRecord(readJson(row.fields_json, 'candidate_fields'), 'candidate_fields',
    row.origin === 'human_edit' ? ['version', 'values', 'editRequestHash'] : ['version', 'values']);
  const lines = exactRecord(readJson(row.lines_json, 'candidate_lines'), 'candidate_lines', ['version', 'items']);
  const persisted = exactRecord(readJson(row.issues_json, 'candidate_issues'), 'candidate_issues', ['version', 'notes', 'checks', 'items']);
  if (fields.version !== 1 || lines.version !== 1 || persisted.version !== 1 || !Array.isArray(persisted.notes)) {
    throw new Error('invalid_candidate_version');
  }
  if (row.origin === 'human_edit' && (typeof fields.editRequestHash !== 'string' || !/^[0-9a-f]{64}$/.test(fields.editRequestHash))) {
    throw new Error('invalid_edit_request_hash');
  }
  const candidate = (row.origin === 'human_edit' ? StoredCandidateDraftSchema : CandidateDraftSchema)
    .parse({ fields: fields.values, lines: lines.items, notes: persisted.notes });
  const checks = z.array(CheckResultSchema).max(MAX_INVOICE_CHECKS).parse(persisted.checks);
  const issues = z.array(InvoiceIssueSchema).max(MAX_INVOICE_ISSUES).parse(persisted.items);
  const sourceMap = new Map<string, CandidateDraft['fields'][keyof CandidateDraft['fields']]['sources'][number]>();
  const fieldsToRead = [...Object.values(candidate.fields), ...candidate.lines.flatMap((line) => Object.values(line))];
  for (const field of fieldsToRead) for (const source of field.sources) {
    const validated = SourceRefSchema.parse(source);
    sourceMap.set(stableJson(validated), validated);
  }
  const snapshot: CandidateSnapshot = {
    candidateId: row.id, jobId: row.job_id, runId: row.run_id, toolCallId: row.tool_call_id, sequence: row.sequence,
    context: contextReferenceFromColumns(row),
    status: row.status as CandidateSummary['status'], issueCount: issues.length, createdAt: row.created_at,
    fields: candidate.fields, lines: candidate.lines, notes: candidate.notes, checks, issues, sources: [...sourceMap.values()],
    ...(row.origin === 'human_edit' ? { origin: 'human_edit' as const, basedOnCandidateId: row.based_on_candidate_id! } : {}),
  };
  if (row.origin === 'human_edit') {
    if (snapshot.context !== null) throw new Error('unexpected_human_context');
  } else {
    const original = db.query('SELECT * FROM tool_calls WHERE id=? AND run_id=?').get(row.tool_call_id!, row.run_id!) as Parameters<typeof readToolContext>[1] | null;
    if (!original || !sameContextReference(snapshot.context, readToolContext(db, original))) throw new Error('invalid_candidate_context');
    if (snapshot.context !== null) readContextSnapshotOwner(db, snapshot.context.snapshotId, { id: row.run_id!, session_id: original.session_id, job_id: row.job_id });
  }
  return { snapshot, documentRef: DocumentRefSchema.parse({ id: row.document_id, version: row.document_version }) };
}

function sameContextReference(left: CandidateSnapshot['context'], right: CandidateSnapshot['context']) {
  return left === null ? right === null : right !== null && left.snapshotId === right.snapshotId && left.requestSequence === right.requestSequence;
}

export function createDocumentRepository(db: Database): DocumentRepository {
  return {
    listArtifactIds() {
      try {
        const rows = db.query('SELECT id FROM artifacts ORDER BY id').all() as Array<{ id: number }>;
        if (rows.some((row) => !Number.isSafeInteger(row.id) || row.id <= 0)) throw new Error('invalid_artifact_id');
        return ok(rows.map((row) => row.id));
      } catch {
        return fail(appError('storage_corrupt', 'storage', 'Artifact 列表无法读取。'));
      }
    },

    listDocumentIds() {
      try {
        const rows = db.query('SELECT id FROM documents ORDER BY id').all() as Array<{ id: number }>;
        if (rows.some((row) => !Number.isSafeInteger(row.id) || row.id <= 0)) throw new Error('invalid_document_id');
        return ok(rows.map((row) => row.id));
      } catch {
        return fail(appError('storage_corrupt', 'storage', 'Document 列表无法读取。'));
      }
    },

    findBySource(input) {
      try {
        const row = db.query('SELECT * FROM documents WHERE source_key=? AND source_record_id=? AND version=?')
          .get(input.sourceKey, input.sourceRecordId, input.version);
        return ok(row ? documentSnapshot(row) : null);
      } catch {
        return fail(appError('storage_corrupt', 'storage', 'Document 事实无法读取。'));
      }
    },

    get(documentId) {
      try {
        const row = db.query('SELECT * FROM documents WHERE id=?').get(documentId);
        if (!row) return fail(appError('document_not_found', 'input', 'Document 不存在。'));
        return ok(documentSnapshot(row));
      } catch {
        return fail(appError('storage_corrupt', 'storage', 'Document 事实无法读取。'));
      }
    },

    list(input) {
      try {
        if (!Number.isSafeInteger(input.limit) || input.limit < 1 || input.limit > 100
          || input.beforeId !== undefined && (!Number.isSafeInteger(input.beforeId) || input.beforeId < 1)) {
          return fail(appError('input_invalid', 'input', 'Document 分页参数无效。'));
        }
        const rows = input.beforeId === undefined
          ? db.query('SELECT * FROM documents WHERE hidden_at IS NULL ORDER BY id DESC LIMIT ?').all(input.limit + 1)
          : db.query('SELECT * FROM documents WHERE hidden_at IS NULL AND id<? ORDER BY id DESC LIMIT ?').all(input.beforeId, input.limit + 1);
        const items = (rows as unknown[]).map(documentSnapshot);
        const hasMore = items.length > input.limit;
        const page = hasMore ? items.slice(0, input.limit) : items;
        return ok({ items: page, nextBeforeId: hasMore ? page.at(-1)?.documentRef.id ?? null : null });
      } catch {
        return fail(appError('storage_corrupt', 'storage', 'Document 列表无法读取。'));
      }
    },

    getArtifact(artifactId) {
      try {
        const row = db.query('SELECT * FROM artifacts WHERE id=?').get(artifactId);
        if (!row) return fail(appError('artifact_not_found', 'input', 'Artifact 不存在。'));
        return ok(storedArtifact(row));
      } catch {
        return fail(appError('storage_corrupt', 'storage', 'Artifact 事实无法读取。'));
      }
    },

    register(input) {
      const result = transaction(db, () => {
        const original = storedArtifact({ id: input.originalArtifact.artifactId, kind: input.originalArtifact.kind,
          relative_path: input.originalArtifact.relativePath, bytes: input.originalArtifact.bytes,
          mime_type: input.originalArtifact.mimeType, metadata_json: asJson(input.originalArtifact.metadata) });
        const parsed = storedArtifact({ id: input.parsedArtifact.artifactId, kind: input.parsedArtifact.kind,
          relative_path: input.parsedArtifact.relativePath, bytes: input.parsedArtifact.bytes,
          mime_type: input.parsedArtifact.mimeType, metadata_json: asJson(input.parsedArtifact.metadata) });
        if (original.kind !== 'original' || parsed.kind !== 'parsed' || original.artifactId === parsed.artifactId
          || original.metadata.sourceKey !== input.sourceKey || parsed.metadata.sourceKey !== input.sourceKey
          || original.metadata.sourceRecordId !== input.sourceRecordId || parsed.metadata.sourceRecordId !== input.sourceRecordId
          || original.metadata.sourceVersion !== input.version || parsed.metadata.sourceVersion !== input.version
          || input.status !== 'available' && input.status !== 'unavailable') throw new Error('invalid_document_registration');
        const metadata = exactRecord(input.metadata, 'document_metadata', [
          'version', 'pageCount', 'warnings', 'allowedUsesClaim', 'licenseVerification', 'unavailableReason',
          ...(Object.prototype.hasOwnProperty.call(input.metadata, 'sampleId') ? ['sampleId'] : []),
        ]);
        const validatedSnapshot = documentSnapshot({ id: input.documentId, version: input.version, status: input.status,
          original_artifact_id: original.artifactId, parsed_artifact_id: parsed.artifactId,
          metadata_json: asJson(metadata), created_at: input.createdAt, updated_at: input.updatedAt });
        const insertArtifact = db.query(`INSERT INTO artifacts(id,kind,relative_path,bytes,mime_type,metadata_json,created_at)
          VALUES (?,?,?,?,?,?,?)`);
        insertArtifact.run(original.artifactId, original.kind, original.relativePath, original.bytes, original.mimeType,
          asJson(original.metadata), input.originalArtifact.createdAt);
        insertArtifact.run(parsed.artifactId, parsed.kind, parsed.relativePath, parsed.bytes, parsed.mimeType,
          asJson(parsed.metadata), input.parsedArtifact.createdAt);
        db.query(`INSERT INTO documents(id,source_key,source_record_id,version,original_artifact_id,parsed_artifact_id,
          status,metadata_json,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?,?)`)
          .run(input.documentId, input.sourceKey, input.sourceRecordId, input.version, original.artifactId, parsed.artifactId,
            input.status, asJson(metadata), input.createdAt, input.updatedAt);
        db.query(`INSERT INTO business_events(type,occurred_at,actor_source,operation_ref,document_id,artifact_id,result,safe_summary)
          VALUES ('document_imported',?,'system',?,?,?,'succeeded','Document imported')`)
          .run(input.createdAt, `document:${input.documentId}`, input.documentId, original.artifactId);
        return validatedSnapshot;
      });
      return result;
    },

    setAvailability(input) {
      const updated = transaction(db, () => {
        const row = db.query('SELECT * FROM documents WHERE id=?').get(input.documentId);
        if (!row) return fail(appError('document_not_found', 'input', 'Document 不存在。'));
        const current = documentSnapshot(row);
        if (input.status === 'unavailable' && (!input.reason || input.reason.length > 1024)) {
          return fail(appError('invalid_input', 'input', '不可用原因无效。'));
        }
        const meta = object(readJson((row as { metadata_json: string }).metadata_json, 'document_metadata'), 'document_metadata');
        const reason = input.status === 'available' ? null : input.reason;
        if (current.status === input.status && current.unavailableReason === reason) return ok(current);
        db.query('UPDATE documents SET status=?,metadata_json=?,updated_at=? WHERE id=?')
          .run(input.status, asJson({ ...meta, unavailableReason: reason }), input.at, input.documentId);
        return ok(documentSnapshot(db.query('SELECT * FROM documents WHERE id=?').get(input.documentId)));
      });
      return updated.ok ? updated.data : updated;
    },

    hide(documentId, at) {
      const hidden = transaction(db, () => {
        const row = db.query('SELECT hidden_at FROM documents WHERE id=?').get(documentId) as { hidden_at: string | null } | null;
        if (!row) return fail(appError('document_not_found', 'input', 'Invoice not found.'));
        if (row.hidden_at !== null) return ok({ documentId, affectedChatCount: 0 });
        const active = db.query(`SELECT run.session_id,run.scope_json,run.config_json,job.document_id AS job_document_id
          FROM runs run LEFT JOIN jobs job ON job.id=run.job_id
          WHERE run.kind='agent' AND run.status IN ('created','running')`).all() as DocumentRunAssociation[];
        if (active.some((run) => runUsesDocument(run, documentId))) {
          return fail(appError('document_busy', 'runtime', 'Wait for the active response or stop it before removing this invoice.', true));
        }
        if (!activeWorkspaceCanAdvance(db, 'active_document_id', documentId)) return fail(appError('state_conflict', 'input', 'Workspace revision 已到上限。'));
        const affectedSessionIds = blockSessionsUsingDocument(db, documentId, at);
        db.query('UPDATE documents SET hidden_at=?,updated_at=? WHERE id=?').run(at, at, documentId);
        db.query(`UPDATE workspace SET active_document_id=NULL,active_job_id=NULL,active_view='original',
          selection_json=NULL,revision=revision+1,updated_at=? WHERE id=1 AND active_document_id=?`).run(at, documentId);
        return ok({ documentId, affectedChatCount: affectedSessionIds.length });
      });
      return hidden.ok ? hidden.data : hidden;
    },

    unhide(documentId, at) {
      const restored = transaction(db, () => {
        const row = db.query('SELECT hidden_at FROM documents WHERE id=?').get(documentId) as { hidden_at: string | null } | null;
        if (!row) return fail(appError('document_not_found', 'input', 'Invoice not found.'));
        if (row.hidden_at !== null) db.query('UPDATE documents SET hidden_at=NULL,updated_at=? WHERE id=?').run(at, documentId);
        return ok(documentSnapshot(db.query('SELECT * FROM documents WHERE id=?').get(documentId)));
      });
      return restored.ok ? restored.data : restored;
    },
  };
}

function readJob(db: Database, jobId: DbId): JobSnapshot | null {
  const row = db.query(`SELECT job.*,document.version AS document_version FROM jobs job
    JOIN documents document ON document.id=job.document_id WHERE job.id=?`).get(jobId) as {
      id: number; document_id: number; document_version: string; goal: string; status: string; status_reason: string | null;
      current_candidate_id: number | null; accepted_candidate_id: number | null; created_at: string; updated_at: string;
    } | null;
  if (!row) return null;
  if (!Number.isSafeInteger(row.id) || !Number.isSafeInteger(row.document_id) || typeof row.document_version !== 'string'
    || typeof row.goal !== 'string' || !['pending', 'running', 'waiting', 'completed', 'failed', 'cancelled'].includes(row.status)
    || (row.status_reason !== null && typeof row.status_reason !== 'string')
    || (row.current_candidate_id !== null && !Number.isSafeInteger(row.current_candidate_id))
    || (row.accepted_candidate_id !== null && !Number.isSafeInteger(row.accepted_candidate_id))
    || typeof row.created_at !== 'string' || typeof row.updated_at !== 'string') throw new Error('invalid_job_row');
  return {
    jobId: row.id, documentRef: DocumentRefSchema.parse({ id: row.document_id, version: row.document_version }), goal: row.goal,
    status: row.status as JobSnapshot['status'], reason: row.status_reason,
    currentCandidateId: row.current_candidate_id, acceptedCandidateId: row.accepted_candidate_id,
    createdAt: row.created_at, updatedAt: row.updated_at,
  };
}

type WorkspaceRow = { active_document_id: number | null; active_job_id: number | null; active_session_id: number | null;
  active_view: string; selection_json: string | null; revision: number; updated_at: string };

function workspaceSnapshot(db: Database, row: unknown, at: string): WorkspaceSnapshot {
  const record = row as WorkspaceRow | null;
  if (!record || !Number.isSafeInteger(record.revision) || record.revision < 0
    || !['original', 'parsed', 'candidate'].includes(record.active_view) || typeof record.updated_at !== 'string'
    || record.active_job_id !== null && record.active_document_id === null
    || [record.active_document_id, record.active_job_id, record.active_session_id].some(id => id !== null && (!Number.isSafeInteger(id) || id < 1))) {
    throw new Error('invalid_workspace_row');
  }
  const invalidReferences: string[] = [];
  const selection = record.selection_json === null ? null : WorkspaceSelectionSchema.parse(readJson(record.selection_json, 'workspace_selection'));
  let documentRef: WorkspaceSnapshot['documentRef'] = null;
  if (record.active_document_id !== null) {
    const document = db.query('SELECT id,version,status,hidden_at FROM documents WHERE id=?').get(record.active_document_id) as { id: number; version: string; status: string; hidden_at: string | null } | null;
    if (document) {
      documentRef = DocumentRefSchema.parse({ id: document.id, version: document.version });
      if (document.hidden_at !== null) invalidReferences.push('document_hidden');
      if (document.status !== 'available') invalidReferences.push('document_unavailable');
    }
    else invalidReferences.push('document_missing');
  }
  let jobId: DbId | null = record.active_document_id !== null && documentRef === null ? null : record.active_job_id;
  let candidateRef: WorkspaceSnapshot['candidateRef'] = null;
  if (record.active_job_id !== null && documentRef !== null) {
    const job = db.query('SELECT id,document_id,current_candidate_id,hidden_at FROM jobs WHERE id=?').get(record.active_job_id) as {
      id: number; document_id: number; current_candidate_id: number | null; hidden_at: string | null;
    } | null;
    if (!job) {
      invalidReferences.push('job_missing');
      jobId = null;
    } else if (job.hidden_at !== null) {
      invalidReferences.push('job_hidden');
      jobId = null;
    } else if (job.document_id !== record.active_document_id) {
      invalidReferences.push('job_document_mismatch');
      jobId = null;
    } else if (job.current_candidate_id !== null) {
      const candidate = db.query('SELECT id,sequence,job_id FROM invoice_candidates WHERE id=?').get(job.current_candidate_id) as {
        id: number; sequence: number; job_id: number;
      } | null;
      if (candidate && candidate.job_id === job.id) candidateRef = { id: candidate.id, sequence: candidate.sequence };
      else throw new Error('candidate_authority_mismatch');
    }
  }
  let sessionId: DbId | null = record.active_session_id;
  if (record.active_session_id !== null) {
    const session = db.query('SELECT * FROM sessions WHERE id=?').get(record.active_session_id);
    const facts = session ? readSessionRow(db, session) : null;
    if (!facts || facts.status !== 'active' || (session as { hidden_at: string | null }).hidden_at !== null || facts.deletePending) {
      invalidReferences.push('session_unavailable');
      sessionId = null;
    }
  }
  const sequences = db.query("SELECT operation_ref FROM business_events WHERE type='task_started' AND operation_ref LIKE 'workspace:1:start-task:%'")
    .all() as Array<{ operation_ref: string }>;
  const nextTaskSequence = sequences.reduce((max, item) => {
    const match = /^workspace:1:start-task:([1-9]\d*)$/.exec(item.operation_ref);
    const sequence = match ? Number(match[1]) : 0;
    return Number.isSafeInteger(sequence) ? Math.max(max, sequence) : max;
  }, 0) + 1;
  if (!Number.isSafeInteger(nextTaskSequence)) throw new Error('task_sequence_exhausted');
  return {
    documentRef, jobId, sessionId, candidateRef, activeView: record.active_view as WorkspaceSnapshot['activeView'],
    selection, revision: record.revision, updatedAt: record.updated_at || at, invalidReferences, nextTaskSequence,
  };
}

function workspaceCandidate(db: Database, workspace: Pick<WorkspaceSnapshot, 'candidateRef' | 'jobId'>): WorkspaceInput['candidate'] {
  if (!workspace.candidateRef) return null;
  const row = queryCandidateRow(db, workspace.candidateRef.id, workspace.jobId ?? undefined);
  if (!row) throw new Error('candidate_authority_missing');
  const candidate = candidateSnapshot(db, row).snapshot;
  if (candidate.jobId !== workspace.jobId || candidate.sequence !== workspace.candidateRef.sequence) throw new Error('candidate_authority_mismatch');
  return { id: candidate.candidateId, sequence: candidate.sequence, fields: candidate.fields, lines: candidate.lines, issues: candidate.issues };
}

function verifyWorkspaceSnapshot(db: Database, workspace: WorkspaceSnapshot, verify: WorkspaceVerifier): Result<WorkspaceVerification> {
  const candidate = workspaceCandidate(db, workspace);
  const verified = verify({ documentRef: workspace.documentRef, jobId: workspace.jobId,
    candidateRef: workspace.candidateRef, candidate, selection: workspace.selection });
  return verified.ok ? ok({ ...verified.data,
    invalidReferences: [...new Set([...workspace.invalidReferences, ...verified.data.invalidReferences])] }) : verified;
}

function revisionCanAdvance(revision: number): boolean { return Number.isSafeInteger(revision + 1); }
function activeWorkspaceCanAdvance(db: Database, field: 'active_document_id' | 'active_job_id' | 'active_session_id', id: DbId): boolean {
  const row = db.query(`SELECT revision FROM workspace WHERE id=1 AND ${field}=?`).get(id) as { revision: number } | null;
  return !row || revisionCanAdvance(row.revision);
}
function corruptWorkspace<T>(): Result<T> { return fail(appError('storage_corrupt', 'storage', 'Workspace 持久事实损坏。')); }
function workspaceReadFailure<T>(error: unknown): Result<T> {
  return error instanceof Error && (error.name === 'SQLiteError' || /closed database|database is closed|no such table/i.test(error.message))
    ? fail(appError('storage_read_failed', 'storage', 'Workspace 事实暂时无法读取。', true)) : corruptWorkspace<T>();
}

function ensureWorkspace(db: Database, at: string): unknown {
  db.query(`INSERT INTO workspace(id,active_view,selection_json,revision,created_at,updated_at)
    VALUES (1,'original',NULL,0,?,?) ON CONFLICT(id) DO NOTHING`).run(at, at);
  return db.query('SELECT * FROM workspace WHERE id=1').get();
}

export function createWorkspaceRepository(db: Database): WorkspaceRepository {
  return {
    read(at, verify) {
      try { return db.transaction(() => {
        const workspace = workspaceSnapshot(db, ensureWorkspace(db, at), at);
        // Even an unverified revision read must reject malformed candidate authority.
        workspaceCandidate(db, workspace);
        if (!verify) return ok(workspace);
        const verified = verifyWorkspaceSnapshot(db, workspace, verify);
        return verified.ok ? ok({ ...workspace, invalidReferences: verified.data.invalidReferences }) : verified;
      }).immediate(); } catch (error) { return workspaceReadFailure<WorkspaceSnapshot>(error); }
    },

    update(input, verify) {
      if (typeof verify !== 'function') return fail(appError('workspace_unavailable', 'storage', 'Workspace verifier is unavailable.', true));
      const changed = transaction(db, () => {
        const row = ensureWorkspace(db, input.at) as WorkspaceRow;
        if (row.revision !== input.expectedRevision) return fail(appError('state_conflict', 'input', 'Workspace 已变化，请重新读取。', true));
        let current: WorkspaceSnapshot;
        try { current = workspaceSnapshot(db, row, input.at); workspaceCandidate(db, current); }
        catch (error) { return workspaceReadFailure<WorkspaceSnapshot>(error); }
        let documentId = row.active_document_id;
        let jobId = row.active_job_id;
        let sessionId = row.active_session_id;
        let activeView = row.active_view as WorkspaceSnapshot['activeView'];
        let selection = current.selection;
        const change = input.change;
        if (change.kind === 'document') {
          if (change.documentId !== null && !db.query('SELECT id FROM documents WHERE id=? AND hidden_at IS NULL').get(change.documentId)) {
            return fail(appError('document_not_found', 'input', 'Invoice is no longer in the workspace.'));
          }
          if (documentId !== change.documentId) {
            documentId = change.documentId;
            jobId = null;
            selection = null;
            activeView = 'original';
          }
        } else if (change.kind === 'job') {
          const job = readJob(db, change.jobId);
          const visible = db.query('SELECT hidden_at FROM jobs WHERE id=?').get(change.jobId) as { hidden_at: string | null } | null;
          if (!job || visible?.hidden_at !== null) return fail(appError('job_not_found', 'input', 'Job 不存在。'));
          if (!db.query('SELECT id FROM documents WHERE id=? AND hidden_at IS NULL').get(job.documentRef.id)) {
            return fail(appError('input_unavailable', 'input', 'This invoice is available only in Processing History.'));
          }
          if (jobId !== change.jobId || documentId !== job.documentRef.id) {
            if (documentId !== job.documentRef.id || selection?.target === 'candidate') selection = null;
            jobId = change.jobId;
            documentId = job.documentRef.id;
            activeView = 'original';
          }
        } else if (change.kind === 'session') {
          if (change.sessionId !== null) {
            const session = db.query('SELECT * FROM sessions WHERE id=? AND hidden_at IS NULL').get(change.sessionId);
            const facts = session ? readSessionRow(db, session) : null;
            if (!facts || facts.status !== 'active' || facts.deletePending) return fail(appError('session_not_found', 'input', '可用 Session 不存在。'));
          }
          sessionId = change.sessionId;
        } else if (change.kind === 'view') {
          activeView = change.view;
        } else {
          const parsed = change.selection === null ? null : WorkspaceSelectionSchema.safeParse(change.selection);
          if (parsed !== null && !parsed.success) return fail(appError('selection_invalid', 'input', '选择定位无效。'));
          selection = parsed?.data ?? null;
        }
        const proposedRow = { ...row, active_document_id: documentId, active_job_id: jobId, active_session_id: sessionId,
          active_view: activeView, selection_json: selection === null ? null : asJson(selection) };
        const proposed = workspaceSnapshot(db, proposedRow, input.at);
        const verified = verifyWorkspaceSnapshot(db, proposed, verify);
        if (!verified.ok) return verified;
        const valid = requireValidWorkspace(verified.data);
        if (!valid.ok) return valid;
        if (documentId === row.active_document_id && jobId === row.active_job_id
          && sessionId === row.active_session_id && activeView === row.active_view && sameWorkspaceSelection(selection, current.selection)) {
          return ok(proposed);
        }
        if (!revisionCanAdvance(row.revision)) return fail(appError('state_conflict', 'input', 'Workspace revision 已到上限。'));
        const updated = db.query(`UPDATE workspace SET active_document_id=?,active_job_id=?,active_session_id=?,
          active_view=?,selection_json=?,revision=revision+1,updated_at=? WHERE id=1 AND revision=?`)
          .run(documentId, jobId, sessionId, activeView, proposedRow.selection_json, input.at, input.expectedRevision).changes;
        if (updated !== 1) return fail(appError('state_conflict', 'input', 'Workspace 已变化，请重新读取。', true));
        const saved = workspaceSnapshot(db, db.query('SELECT * FROM workspace WHERE id=1').get(), input.at);
        const final = verifyWorkspaceSnapshot(db, saved, verify);
        if (!final.ok) throw new Error('workspace_projection_failed');
        const admitted = requireValidWorkspace(final.data);
        if (!admitted.ok) throw new Error('workspace_projection_failed');
        return ok({ ...saved, invalidReferences: final.data.invalidReferences });
      });
      return changed.ok ? changed.data : changed;
    },

    restore(input, verify) {
      if (typeof verify !== 'function') return fail(appError('workspace_unavailable', 'storage', 'Workspace verifier is unavailable.', true));
      const restored = transaction(db, () => {
        const row = ensureWorkspace(db, input.at) as WorkspaceRow;
        if (row.revision !== input.expectedRevision) return fail(appError('state_conflict', 'input', 'Workspace 已变化，请重新读取。', true));
        let current: WorkspaceSnapshot, verified: Result<WorkspaceVerification>;
        try { current = workspaceSnapshot(db, row, input.at); verified = verifyWorkspaceSnapshot(db, current, verify); }
        catch (error) { return workspaceReadFailure<WorkspaceRestoreResult>(error); }
        if (!verified.ok) return verified;
        const invalid = new Set(verified.data.invalidReferences);
        const definiteDocument = ['document_missing', 'document_hidden', 'document_version_mismatch', 'artifact_missing_or_invalid'].some(reason => invalid.has(reason));
        const definiteJob = ['job_missing', 'job_hidden', 'job_document_mismatch'].some(reason => invalid.has(reason));
        const supported = new Set(['document_unavailable', 'session_unavailable', 'document_missing', 'document_hidden', 'document_version_mismatch',
          'artifact_missing_or_invalid', 'job_missing', 'job_hidden', 'job_document_mismatch', 'selection_target_mismatch',
          'selection_version_mismatch', 'selection_location_missing', 'selection_unsupported']);
        if ([...invalid].some(reason => !supported.has(reason))) return fail(appError('storage_corrupt', 'storage', 'Workspace 引用无法安全恢复。'));
        let documentId = row.active_document_id, jobId = row.active_job_id, sessionId = row.active_session_id;
        let selection = current.selection, activeView = row.active_view;
        const clearedReferences: string[] = [];
        if (definiteDocument) {
          documentId = null; jobId = null; selection = null; activeView = 'original';
          clearedReferences.push(...[...invalid].filter(reason => ['document_missing', 'document_hidden', 'document_version_mismatch', 'artifact_missing_or_invalid'].includes(reason)));
        } else {
          if (definiteJob) {
            jobId = null;
            if (selection?.target === 'candidate') selection = null;
            clearedReferences.push(...[...invalid].filter(reason => reason.startsWith('job_')));
          }
          if ([...invalid].some(reason => reason.startsWith('selection_'))) {
            selection = null;
            clearedReferences.push(...[...invalid].filter(reason => reason.startsWith('selection_')));
          }
        }
        if (invalid.has('session_unavailable')) { sessionId = null; clearedReferences.push('session_unavailable'); }
        const changed = documentId !== row.active_document_id || jobId !== row.active_job_id || sessionId !== row.active_session_id
          || activeView !== row.active_view || !sameWorkspaceSelection(selection, current.selection);
        if (changed && !revisionCanAdvance(row.revision)) return fail(appError('state_conflict', 'input', 'Workspace revision 已到上限。'));
        const material = verified.data.material;
        if (!definiteDocument && material?.kind === 'valid' && material.document.status === 'unavailable') {
          const repaired = createDocumentRepository(db).setAvailability({ documentId: material.document.documentRef.id,
            status: 'available', reason: null, at: input.at });
          if (!repaired.ok) throw new Error('workspace_material_repair_failed');
        }
        if (changed) {
          const count = db.query(`UPDATE workspace SET active_document_id=?,active_job_id=?,active_session_id=?,active_view=?,
            selection_json=?,revision=revision+1,updated_at=? WHERE id=1 AND revision=?`)
            .run(documentId, jobId, sessionId, activeView, selection === null ? null : asJson(selection), input.at, input.expectedRevision).changes;
          if (count !== 1) throw new Error('workspace_restore_cas_failed');
        }
        const workspace = workspaceSnapshot(db, db.query('SELECT * FROM workspace WHERE id=1').get(), input.at);
        const final = verifyWorkspaceSnapshot(db, workspace, verify);
        if (!final.ok || final.data.invalidReferences.length) throw new Error('workspace_restore_projection_failed');
        return ok({ workspace: { ...workspace, invalidReferences: final.data.invalidReferences }, clearedReferences });
      });
      return restored.ok ? restored.data : restored;
    },

    selectCandidate(input) {
      const selected = transaction(db, () => {
        const workspace = ensureWorkspace(db, input.at) as WorkspaceRow;
        const operationRef = `job:${input.jobId}:select:${input.expectedRevision}:from:${input.expectedCandidateId ?? 'none'}:to:${input.candidateId}`;
        const previous = db.query("SELECT job_id,candidate_id FROM business_events WHERE type='candidate_selected' AND operation_ref=? AND result='succeeded'")
          .get(operationRef) as { job_id: number | null; candidate_id: number | null } | null;
        if (previous) {
          if (previous.job_id !== input.jobId || previous.candidate_id !== input.candidateId) throw new Error('selection_operation_mismatch');
          return ok({ jobId: input.jobId, candidateId: input.candidateId, workspace: workspaceSnapshot(db, workspace, input.at) });
        }
        if (workspace.revision !== input.expectedRevision) {
          return fail(appError('state_conflict', 'input', 'Workspace 已变化，请重新读取。', true));
        }
        const job = db.query('SELECT document_id,current_candidate_id,status FROM jobs WHERE id=?').get(input.jobId) as {
          document_id: number; current_candidate_id: number | null; status: string;
        } | null;
        if (!job) return fail(appError('job_not_found', 'input', 'Job 不存在。'));
        if (!db.query('SELECT id FROM documents WHERE id=? AND hidden_at IS NULL').get(job.document_id)) {
          return fail(appError('input_unavailable', 'input', 'This invoice is available only for review.'));
        }
        if (job.current_candidate_id !== input.expectedCandidateId) {
          return fail(appError('state_conflict', 'input', 'Job 当前候选已变化，请重新读取。', true));
        }
        const candidate = db.query('SELECT status FROM invoice_candidates WHERE id=? AND job_id=?')
          .get(input.candidateId, input.jobId) as { status: string } | null;
        if (!candidate) return fail(appError('candidate_not_found', 'input', '此 Job 下不存在该 Candidate。'));
        if (!['generated', 'rejected'].includes(candidate.status)) return fail(appError('candidate_not_selectable', 'input', '只有未接受 Candidate 可以选择。'));
        if (job.current_candidate_id === input.candidateId) {
          return ok({ jobId: input.jobId, candidateId: input.candidateId, workspace: workspaceSnapshot(db, workspace, input.at) });
        }
        if (job.status === 'completed') return fail(appError('job_completed', 'input', '已完成 Job 不能更换候选。'));
        if (job.status === 'running') return fail(appError('state_conflict', 'runtime', 'Job 仍在运行，暂时不能选择候选。', true));
        if (!executionReleased(db, input.jobId)) return fail(appError('state_conflict', 'runtime', 'Job 仍有未停止或未收尾的执行。', true));
        if (workspace.active_job_id === input.jobId && !revisionCanAdvance(workspace.revision)) {
          return fail(appError('state_conflict', 'input', 'Workspace revision 已到上限。'));
        }
        const changedJob = db.query('UPDATE jobs SET current_candidate_id=?,updated_at=? WHERE id=? AND current_candidate_id IS ?')
          .run(input.candidateId, input.at, input.jobId, input.expectedCandidateId).changes;
        if (changedJob !== 1) return fail(appError('state_conflict', 'input', 'Job 当前候选已变化，请重新读取。', true));
        if (workspace.active_job_id === input.jobId) {
          const changedWorkspace = db.query(`UPDATE workspace SET selection_json=NULL,revision=revision+1,updated_at=?
            WHERE id=1 AND revision=?`).run(input.at, input.expectedRevision).changes;
          if (changedWorkspace !== 1) throw new Error('workspace_selection_cas_failed');
        }
        db.query(`INSERT INTO business_events(type,occurred_at,actor_source,operation_ref,document_id,job_id,candidate_id,result,safe_summary)
          VALUES ('candidate_selected',?,'user',?,?,?,?,'succeeded','Candidate selected')`)
          .run(input.at, operationRef, job.document_id, input.jobId, input.candidateId);
        const currentWorkspace = db.query('SELECT * FROM workspace WHERE id=1').get();
        return ok({ jobId: input.jobId, candidateId: input.candidateId, workspace: workspaceSnapshot(db, currentWorkspace, input.at) });
      });
      if (!selected.ok) return selected;
      return selected.data;
    },
  };
}

function readTaskInput(value: unknown): StartTaskRecord {
  const record = exactRecord(readJson(typeof value === 'string' ? value : asJson(value), 'job_input'),
    'job_input', ['version', 'clientSequence', 'expectedRevision', 'documentRef', 'goal']);
  if (record.version !== 1 || !Number.isSafeInteger(record.clientSequence) || Number(record.clientSequence) < 1
    || !Number.isSafeInteger(record.expectedRevision) || Number(record.expectedRevision) < 0
    || typeof record.goal !== 'string') throw new Error('invalid_job_input');
  return { clientSequence: Number(record.clientSequence), expectedRevision: Number(record.expectedRevision),
    documentRef: DocumentRefSchema.parse(record.documentRef), goal: record.goal, at: '' };
}

export function createJobRepository(db: Database): JobRepository {
  const operationRef = (sequence: DbId) => `workspace:1:start-task:${sequence}`;
  const taskResult = (jobId: DbId, at: string): TaskOperation => {
    const job = readJob(db, jobId);
    if (!job) throw new Error('job_not_found');
    const workspace = workspaceSnapshot(db, db.query('SELECT * FROM workspace WHERE id=1').get(), at);
    return { job, workspace };
  };

  return {
    get(jobId) {
      try {
        const job = readJob(db, jobId);
        return job ? ok(job) : fail(appError('job_not_found', 'input', 'Job 不存在。'));
      } catch {
        return fail(appError('storage_corrupt', 'storage', 'Job 事实无法读取。'));
      }
    },

    list(input) {
      try {
        if (!Number.isSafeInteger(input.limit) || input.limit < 1 || input.limit > 100
          || input.beforeId !== undefined && (!Number.isSafeInteger(input.beforeId) || input.beforeId < 1)
          || input.documentId !== undefined && (!Number.isSafeInteger(input.documentId) || input.documentId < 1)) {
          return fail(appError('input_invalid', 'input', 'Job 分页参数无效。'));
        }
        const clauses = ['hidden_at IS NULL', input.documentId === undefined ? '' : 'document_id=?', input.beforeId === undefined ? '' : 'id<?'].filter(Boolean);
        const values = [input.documentId, input.beforeId].filter((value): value is number => value !== undefined);
        const query = `SELECT id FROM jobs${clauses.length ? ` WHERE ${clauses.join(' AND ')}` : ''} ORDER BY id DESC LIMIT ?`;
        const rows = db.query(query).all(...values, input.limit + 1) as Array<{ id: number }>;
        const items = rows.map((row) => {
          const job = readJob(db, row.id);
          if (!job) throw new Error('job_missing_from_list');
          return job;
        });
        const hasMore = items.length > input.limit;
        const page = hasMore ? items.slice(0, input.limit) : items;
        return ok({ items: page, nextBeforeId: hasMore ? page.at(-1)?.jobId ?? null : null });
      } catch {
        return fail(appError('storage_corrupt', 'storage', 'Job 列表无法读取。'));
      }
    },

    hide(jobId, at) {
      const hidden = transaction(db, () => {
        const row = db.query('SELECT hidden_at FROM jobs WHERE id=?').get(jobId) as { hidden_at: string | null } | null;
        if (!row) return fail(appError('job_not_found', 'input', 'Processing record not found.'));
        const job = readJob(db, jobId);
        if (!job) throw new Error('hidden_job_invalid');
        if (row.hidden_at !== null) return ok(job);
        const active = db.query("SELECT 1 FROM runs WHERE job_id=? AND status IN ('created','running') LIMIT 1").get(jobId);
        if (active) return fail(appError('run_state_invalid', 'runtime', 'Wait for the active response before deleting this processing record.'));
        if (!activeWorkspaceCanAdvance(db, 'active_job_id', jobId)) return fail(appError('state_conflict', 'input', 'Workspace revision 已到上限。'));
        db.query('UPDATE jobs SET hidden_at=? WHERE id=?').run(at, jobId);
        db.query("UPDATE workspace SET active_job_id=NULL,selection_json=NULL,active_view='original',revision=revision+1,updated_at=? WHERE id=1 AND active_job_id=?")
          .run(at, jobId);
        return ok(job);
      });
      return hidden.ok ? hidden.data : hidden;
    },

    queryOperation(clientSequence, at) {
      try {
        const event = db.query("SELECT job_id FROM business_events WHERE type='task_started' AND operation_ref=? AND result='succeeded'")
          .get(operationRef(clientSequence)) as { job_id: number | null } | null;
        if (!event || event.job_id === null) return ok(null);
        return ok(taskResult(event.job_id, at));
      } catch {
        return fail(appError('storage_corrupt', 'storage', 'Start Task 操作无法读取。'));
      }
    },

    create(input) {
      const created = transaction(db, () => {
        if (!Number.isSafeInteger(input.clientSequence) || input.clientSequence <= 0
          || !Number.isSafeInteger(input.expectedRevision) || input.expectedRevision < 0
          || input.goal !== input.goal.trim() || new TextEncoder().encode(input.goal).length < 1
          || new TextEncoder().encode(input.goal).length > 4096) {
          return fail(appError('invalid_input', 'input', 'Start Task 参数无效。'));
        }
        const expectedRef = DocumentRefSchema.safeParse(input.documentRef);
        if (!expectedRef.success) return fail(appError('invalid_input', 'input', 'Document 引用无效。'));
        const existing = db.query("SELECT job_id FROM business_events WHERE type='task_started' AND operation_ref=? AND result='succeeded'")
          .get(operationRef(input.clientSequence)) as { job_id: number | null } | null;
        if (existing) {
          const job = existing.job_id === null ? null : readJob(db, existing.job_id);
          if (!job) throw new Error('task_operation_missing_job');
          const storedRow = db.query('SELECT input_json FROM jobs WHERE id=?').get(job.jobId) as { input_json: string } | null;
          if (!storedRow) throw new Error('task_operation_missing_input');
          const stored = readTaskInput(storedRow.input_json);
          if (stored.clientSequence !== input.clientSequence || stored.expectedRevision !== input.expectedRevision
            || stored.documentRef.id !== input.documentRef.id || stored.documentRef.version !== input.documentRef.version
            || stored.goal !== input.goal) return fail(appError('state_conflict', 'input', '该客户端序号已用于不同的 Start Task 请求。'));
          return ok(taskResult(job.jobId, input.at));
        }
        const workspace = ensureWorkspace(db, input.at) as { active_document_id: number | null; active_job_id: number | null; revision: number };
        if (workspace.revision !== input.expectedRevision || workspace.active_document_id !== input.documentRef.id) {
          return fail(appError('state_conflict', 'input', 'Workspace 已变化，请重新读取。', true));
        }
        const document = db.query('SELECT version,status,hidden_at FROM documents WHERE id=?').get(input.documentRef.id) as { version: string; status: string; hidden_at: string | null } | null;
        if (!document || document.version !== input.documentRef.version) return fail(appError('document_not_found', 'input', 'Document 版本不存在。'));
        if (document.status !== 'available' || document.hidden_at !== null) return fail(appError('input_unavailable', 'input', 'Invoice is no longer available for processing.', true));
        if (!revisionCanAdvance(workspace.revision)) return fail(appError('state_conflict', 'input', 'Workspace revision 已到上限。'));
        const inputJson = { version: 1, clientSequence: input.clientSequence, expectedRevision: input.expectedRevision,
          documentRef: input.documentRef, goal: input.goal };
        const inserted = db.query(`INSERT INTO jobs(document_id,goal,input_json,status,created_at,updated_at)
          VALUES (?,?,?,'pending',?,?)`).run(input.documentRef.id, input.goal, asJson(inputJson), input.at, input.at);
        const jobId = Number(inserted.lastInsertRowid);
        if (!Number.isSafeInteger(jobId) || jobId <= 0) throw new Error('unsafe_job_id');
        const updated = db.query(`UPDATE workspace SET active_job_id=?,active_view='original',selection_json=NULL,
          revision=revision+1,updated_at=? WHERE id=1 AND revision=?`).run(jobId, input.at, input.expectedRevision).changes;
        if (updated !== 1) throw new Error('workspace_task_cas_failed');
        db.query(`INSERT INTO business_events(type,occurred_at,actor_source,operation_ref,document_id,job_id,result,safe_summary)
          VALUES ('task_started',?,'user',?,?,?,'succeeded','Task started')`)
          .run(input.at, operationRef(input.clientSequence), input.documentRef.id, jobId);
        return ok(taskResult(jobId, input.at));
      });
      return created.ok ? created.data : created;
    },
  };
}

function appendToolState(db: Database, events: RuntimeEventStore | undefined, toolCallId: DbId,
  type: 'tool_requested' | 'tool_started' | 'tool_succeeded' | 'tool_failed' | 'tool_cancelled', origin: 'live' | 'recovery' = 'live'): void {
  if (!events) return;
  const row = db.query('SELECT run_id,session_id,status,tool_name,requested_at,started_at,ended_at,result_json,cleanup_json FROM tool_calls WHERE id=?')
    .get(toolCallId) as { run_id: number; session_id: number; status: ToolCallStatus; tool_name: string; requested_at: string;
      started_at: string | null; ended_at: string | null; result_json: string | null; cleanup_json: string } | null;
  if (!row) throw new Error('event_tool_missing');
  const result = row.result_json === null ? null : object(readJson(row.result_json, 'tool_result'), 'tool_result');
  const cleanup = object(readJson(row.cleanup_json, 'tool_cleanup'), 'tool_cleanup');
  const error = result?.error === undefined ? null : object(result.error, 'tool_error');
  events.appendInTransaction({ runId: row.run_id, sessionId: row.session_id, toolCallId, type,
    occurredAt: (type === 'tool_requested' ? row.requested_at : type === 'tool_started' ? row.started_at : row.ended_at)!,
    dedupeKey: `tool:${toolCallId}:${type === 'tool_requested' ? 'requested' : type === 'tool_started' ? 'started' : 'terminal'}`,
    payload: { version: 1, status: row.status, origin, toolName: row.tool_name,
      stopped: typeof cleanup.stopped === 'boolean' ? cleanup.stopped : null,
      committedCandidateId: typeof result?.committedCandidateId === 'number' ? result.committedCandidateId : null,
      errorCode: typeof error?.code === 'string' ? error.code : null } });
}

export function createToolCallRepository(db: Database, events?: RuntimeEventStore): ToolCallRepository {
  const writeTransaction = <T>(fn: () => T) => transaction(db, fn, events);
  const byId = (toolCallId: DbId) => {
    const row = db.query('SELECT * FROM tool_calls WHERE id=?').get(toolCallId);
    if (!row) return fail(appError('tool_call_not_found', 'input', 'ToolCall 不存在。'));
    return ok(toolCallSnapshot(db, row));
  };
  const trustedContext = (context: ProductToolContext): Result<string> => {
    const row = db.query(`SELECT run.session_id,run.scope_json,run.config_json,run.status,session.status AS session_status,session.metadata_json
      FROM runs run JOIN sessions session ON session.id=run.session_id WHERE run.id=? AND run.kind='agent'`)
      .get(context.runId) as { session_id: number; scope_json: string; config_json: string; status: string; session_status: string; metadata_json: string } | null;
    if (!row || row.session_id !== context.sessionId) return fail(appError('tool_access_denied', 'runtime', 'Native tool context does not match the Run.'));
    if (row.status !== 'running' || row.session_status !== 'active') return fail(appError('run_state_invalid', 'runtime', 'Native tools require an active Run.'));
    const scope = RunScopeSchema.parse(readJson(row.scope_json, 'run_scope'));
    if (stableJson(scope) !== stableJson(context.scope)) return fail(appError('tool_access_denied', 'runtime', 'Native context does not match the frozen Run.'));
    const config = validatedConfig(readJson(row.config_json, 'run_config'), 'agent');
    if (parseSessionModelUse(row.metadata_json)) return fail(appError('session_scope_revoked', 'session', 'Conversation material access has been revoked.'));
    if (typeof config.workingDirectory !== 'string') {
      return fail(appError('tool_access_denied', 'runtime', 'The Run has no trusted working directory.'));
    }
    return ok(config.workingDirectory);
  };
  return {
    request(input) {
      try {
        if (!Number.isSafeInteger(input.runId) || input.runId < 1 || !Number.isSafeInteger(input.sessionId) || input.sessionId < 1
          || typeof input.nativeToolCallId !== 'string' || input.nativeToolCallId.length < 1 || input.nativeToolCallId.length > 256
          || typeof input.toolName !== 'string' || input.toolName.length < 1 || input.toolName.length > MAX_TOOL_NAME_CHARS
          || input.toolVersion !== null && (typeof input.toolVersion !== 'string' || input.toolVersion.length < 1 || input.toolVersion.length > MAX_TOOL_VERSION_CHARS)
          || input.effect !== null && !ToolEffectSchema.safeParse(input.effect).success
          || (input.toolVersion === null) !== (input.effect === null)) return fail(appError('input_invalid', 'input', '原生 ToolCall 身份无效。'));
        const raw = JSON.stringify(input.rawArguments);
        if (raw === undefined || !NATIVE_TOOL_NAMES.includes(input.toolName as (typeof NATIVE_TOOL_NAMES)[number])
          && Buffer.byteLength(raw, 'utf8') > TOOL_CONFIG.payload.maxRawArgumentsBytes) return fail(appError('tool_result_too_large', 'input', 'ToolCall 参数超过记录上限。'));
        const existing = db.query('SELECT * FROM tool_calls WHERE session_id=? AND native_tool_call_id=?')
          .get(input.sessionId, input.nativeToolCallId);
        if (existing) {
          const call = toolCallSnapshot(db, existing);
          if (call.runId !== input.runId || call.toolName !== input.toolName || call.toolVersion !== input.toolVersion
            || call.effect !== input.effect || stableJson(call.args.raw) !== stableJson(input.rawArguments)) {
            return fail(appError('state_conflict', 'runtime', '原生 ToolCall ID 已属于不同的执行请求。'));
          }
          return ok(call);
        }
        const run = db.query("SELECT session_id,status FROM runs WHERE id=? AND kind='agent'").get(input.runId) as { session_id: number; status: string } | null;
        if (!run || run.session_id !== input.sessionId) return fail(appError('tool_access_denied', 'runtime', 'ToolCall 与可信 Agent Run 不匹配.'));
        if (!['created', 'running'].includes(run.status)) return fail(appError('run_state_invalid', 'runtime', 'Run 已停止接纳新的 ToolCall。'));
        const id = writeTransaction(() => {
          const inserted = db.query(`INSERT INTO tool_calls(run_id,session_id,native_tool_call_id,tool_name,tool_version,effect,args_json,
            delivery_json,cleanup_json,requested_at) VALUES (?,?,?,?,?,?,?, ?,?,?)`)
            .run(input.runId, input.sessionId, input.nativeToolCallId, input.toolName, input.toolVersion, input.effect,
              JSON.stringify({ version: 1, raw: input.rawArguments, final: null }),
              JSON.stringify({ version: 1, state: 'not_attempted', messageObservedAt: null, includedInCallSequence: null,
                requestDispatchedAt: null, error: null }),
              JSON.stringify({ version: 1, stopReason: null, stopped: false, errors: [] }), input.requestedAt);
          const counted = db.query("UPDATE runs SET tool_call_count=tool_call_count+1 WHERE id=? AND status IN ('created','running')")
            .run(input.runId).changes;
          if (counted !== 1) throw new Error('tool_call_run_closed');
          appendToolState(db, events, Number(inserted.lastInsertRowid), 'tool_requested');
          return Number(inserted.lastInsertRowid);
        });
        if (!id.ok) return id;
        return byId(id.data);
      } catch {
        return fail(databaseError('ToolCall 请求记录失败。'));
      }
    },

    get(identity) {
      try {
        const row = db.query('SELECT * FROM tool_calls WHERE run_id=? AND session_id=? AND native_tool_call_id=?')
          .get(identity.runId, identity.sessionId, identity.nativeToolCallId);
        return row ? ok(toolCallSnapshot(db, row)) : fail(appError('tool_call_not_found', 'input', 'ToolCall 不存在。'));
      } catch {
        return fail(appError('storage_corrupt', 'storage', 'ToolCall 事实无法读取。'));
      }
    },

    getById(toolCallId) {
      try { return byId(toolCallId); }
      catch { return fail(appError('storage_corrupt', 'storage', 'ToolCall 事实无法读取。', false, toolCallId)); }
    },

    queryCandidateCommit(input) {
      try {
        const call = byId(input.toolCallId);
        if (!call.ok) return call;
        if (call.data.runId !== input.runId || call.data.sessionId !== input.sessionId) {
          return fail(appError('state_conflict', 'runtime', 'Candidate commit query does not match the original ToolCall.'));
        }
        const row = db.query(`SELECT candidate.id FROM invoice_candidates candidate
          JOIN tool_calls tool ON tool.id=candidate.tool_call_id JOIN runs run ON run.id=tool.run_id
          WHERE tool.id=? AND tool.run_id=? AND tool.session_id=? AND candidate.run_id=run.id AND run.session_id=tool.session_id`)
          .get(input.toolCallId, input.runId, input.sessionId) as { id: number } | null;
        if (!row) return ok(null);
        const { snapshot } = candidateSnapshot(db, queryCandidateRow(db, row.id));
        return ok({ candidateId: snapshot.candidateId, jobId: snapshot.jobId, sequence: snapshot.sequence,
          issueCount: snapshot.issueCount, checks: snapshot.checks });
      } catch { return fail(appError('storage_corrupt', 'storage', 'Candidate commit could not be verified.')); }
    },

    observationCutoff() {
      try { return ok((db.query('SELECT COALESCE(MAX(id),0) AS cutoff FROM tool_calls').get() as { cutoff: number }).cutoff); }
      catch { return fail(appError('storage_corrupt', 'storage', 'Observation cutoff could not be read.')); }
    },

    recentStarted(input) {
      try {
        const rows = db.query(`SELECT tool.* FROM tool_calls tool JOIN runs run ON run.id=tool.run_id
          WHERE tool.started_at IS NOT NULL AND tool.id<=? AND (
            tool.runtime_observation_json IS NOT NULL AND json_extract(tool.runtime_observation_json,'$.groupKey')=?
            OR tool.runtime_observation_json IS NULL AND EXISTS (
              SELECT 1 FROM json_each(run.config_json,'$.runtimeStrategy.calibration.groups') strategy
              WHERE json_extract(strategy.value,'$.groupKey')=? AND json_extract(strategy.value,'$.toolName')=tool.tool_name
              AND json_extract(strategy.value,'$.toolVersion')=tool.tool_version))
          ORDER BY tool.id DESC LIMIT ?`).all(input.cutoff, input.groupKey, input.groupKey, TOOL_CONFIG.statistics.maxAttempts);
        return ok(rows.map(row => toolCallSnapshot(db, row)));
      } catch { return fail(appError('storage_corrupt', 'storage', 'Runtime observations could not be read.')); }
    },

    recentObservations(input) {
      try {
        return ok(db.query(`SELECT * FROM tool_calls WHERE runtime_observation_json IS NOT NULL
          AND json_extract(runtime_observation_json,'$.groupKey')=? AND id<=? ORDER BY id DESC LIMIT ?`)
          .all(input.groupKey, input.cutoff, TOOL_CONFIG.statistics.maxAttempts).map(row => toolCallSnapshot(db, row)));
      } catch { return fail(appError('storage_corrupt', 'storage', 'Runtime experience could not be read.')); }
    },

    verifyUse(context) {
      try {
        const row = db.query(`SELECT run.session_id,run.scope_json,run.status,run.cancel_requested_at,
          session.status AS session_status,session.metadata_json FROM runs run JOIN sessions session ON session.id=run.session_id
          WHERE run.id=? AND run.kind='agent'`).get(context.runId) as {
            session_id: number; scope_json: string; status: string; cancel_requested_at: string | null;
            session_status: string; metadata_json: string;
          } | null;
        if (!row || row.session_id !== context.sessionId
          || stableJson(RunScopeSchema.parse(readJson(row.scope_json, 'run_scope'))) !== stableJson(context.scope)) {
          return fail(appError('tool_access_denied', 'runtime', 'Tool context does not match the frozen Run.'));
        }
        if (row.status !== 'running' || row.session_status !== 'active') return fail(appError('run_state_invalid', 'runtime', 'Tool execution requires an active Run.'));
        if (row.cancel_requested_at !== null) return fail(appError('agent_cancelled', 'runtime', 'Run cancellation was requested.'));
        if (parseSessionModelUse(row.metadata_json)) return fail(appError('session_scope_revoked', 'session', 'Material access was revoked.'));
        return ok(undefined);
      } catch { return fail(appError('storage_corrupt', 'storage', 'The trusted Run context could not be verified.')); }
    },

    validateOutput(input) {
      try {
        const call = byId(input.toolCallId);
        if (!call.ok) return call;
        const run = db.query(`SELECT run.job_id,run.scope_json,job.document_id AS job_document_id FROM runs run
          LEFT JOIN jobs job ON job.id=run.job_id WHERE run.id=? AND run.session_id=?`).get(call.data.runId, call.data.sessionId) as
          { job_id: number | null; scope_json: string; job_document_id: number | null } | null;
        if (!run) return fail(appError('storage_corrupt', 'storage', 'Original output ownership could not be verified.'));
        const scope = RunScopeSchema.parse(readJson(run.scope_json, 'run_scope'));
        const args = call.data.args.final as Record<string, unknown> | null;
        const expectedDocumentId = args?.documentId ?? run.job_document_id ?? (input.data as { documentRef?: { id: number } })?.documentRef?.id;
        let checked = false;
        const documents = new Map<number, { version: string; parsed_artifact_id: number } | null>();
        const document = (id: number) => {
          if (!documents.has(id)) documents.set(id, db.query('SELECT version,parsed_artifact_id FROM documents WHERE id=?').get(id) as
            { version: string; parsed_artifact_id: number } | null);
          return documents.get(id);
        };
        const visit = (value: unknown): boolean => {
          if (Array.isArray(value)) return value.every(visit);
          if (!value || typeof value !== 'object') return true;
          const data = value as Record<string, any>;
          if (data.documentRef) {
            checked = true;
            const ref = data.documentRef;
            if (!scope.allowedDocumentIds.includes(ref.id) || expectedDocumentId !== undefined && ref.id !== expectedDocumentId
              || document(ref.id)?.version !== ref.version) return false;
            if (data.parsedArtifactId !== undefined && (!scope.allowedArtifactIds.includes(data.parsedArtifactId)
              || document(ref.id)?.parsed_artifact_id !== data.parsedArtifactId)) return false;
          }
          if (data.documentId !== undefined && data.artifactId !== undefined && data.version !== undefined) {
            checked = true;
            if (!scope.allowedDocumentIds.includes(data.documentId) || !scope.allowedArtifactIds.includes(data.artifactId)
              || expectedDocumentId !== undefined && data.documentId !== expectedDocumentId
              || args?.page != null && data.page !== args.page || args?.blockId != null && data.blockId !== args.blockId
              || document(data.documentId)?.version !== data.version
              || document(data.documentId)?.parsed_artifact_id !== data.artifactId) return false;
          }
          if (data.source && (data.page !== undefined && data.source.page !== data.page
            || (data.blockId ?? data.id) !== undefined && data.source.blockId !== (data.blockId ?? data.id))) return false;
          if (data.jobId !== undefined) { checked = true; if (data.jobId !== run.job_id) return false; }
          for (const key of ['candidateId', 'leftCandidateId', 'rightCandidateId']) {
            if (data[key] !== undefined && args?.[key] !== undefined) { checked = true; if (data[key] !== args[key]) return false; }
          }
          return Object.values(data).every(visit);
        };
        return visit(input.data) ? ok(checked ? 'valid' : 'not_applicable')
          : fail(appError('tool_invalid_output', 'tool', 'Invoice output references do not match the original Run.'));
      } catch { return fail(appError('storage_corrupt', 'storage', 'Invoice output ownership could not be verified.')); }
    },

    list(input) {
      try {
        if (!Number.isSafeInteger(input.runId) || input.runId < 1 || !Number.isSafeInteger(input.limit) || input.limit < 1 || input.limit > 100
          || input.beforeId !== undefined && (!Number.isSafeInteger(input.beforeId) || input.beforeId < 1)) return fail(appError('input_invalid', 'input', 'ToolCall 分页参数无效。'));
        const rows = input.beforeId === undefined
          ? db.query('SELECT * FROM tool_calls WHERE run_id=? ORDER BY id DESC LIMIT ?').all(input.runId, input.limit + 1)
          : db.query('SELECT * FROM tool_calls WHERE run_id=? AND id<? ORDER BY id DESC LIMIT ?').all(input.runId, input.beforeId, input.limit + 1);
        const calls = (rows as unknown[]).map((row) => toolCallSnapshot(db, row));
        const hasMore = calls.length > input.limit;
        const items = hasMore ? calls.slice(0, input.limit) : calls;
        return ok({ items, nextBeforeId: hasMore ? items.at(-1)?.toolCallId ?? null : null });
      } catch {
        return fail(appError('storage_corrupt', 'storage', 'ToolCall 列表无法读取。'));
      }
    },

    fixArguments(input) {
      try {
        const before = byId(input.toolCallId);
        if (!before.ok) return before;
        const serialized = JSON.stringify(input.finalArguments);
        if (serialized === undefined || !NATIVE_TOOL_NAMES.includes(before.data.toolName as (typeof NATIVE_TOOL_NAMES)[number])
          && Buffer.byteLength(serialized, 'utf8') > TOOL_CONFIG.payload.maxFinalArgumentsBytes) return fail(appError('tool_result_too_large', 'input', 'ToolCall 最终参数超过记录上限.'));
        const changed = db.query(`UPDATE tool_calls SET args_json=json_set(args_json,'$.final',json(?)) WHERE id=? AND status='requested' AND json_type(args_json,'$.final')='null'`)
          .run(serialized, input.toolCallId).changes;
        if (changed === 1) return byId(input.toolCallId);
        const current = byId(input.toolCallId);
        if (!current.ok) return current;
        return stableJson(current.data.args.final) === stableJson(input.finalArguments) ? current
          : fail(appError('state_conflict', 'runtime', 'ToolCall 最终参数已固定或状态已变化。'));
      } catch {
        return fail(databaseError('ToolCall 最终参数保存失败。'));
      }
    },

    start(input) {
      try {
        const started = writeTransaction(() => {
          const changed = db.query("UPDATE tool_calls SET status='running',started_at=? WHERE id=? AND status='requested' AND json_type(args_json,'$.final')!='null'")
            .run(input.startedAt, input.toolCallId).changes;
          if (changed === 1) {
            appendToolState(db, events, input.toolCallId, 'tool_started');
            return byId(input.toolCallId);
          }
          const current = byId(input.toolCallId);
          return current.ok && current.data.status === 'running' ? current
            : fail(appError('run_state_invalid', 'runtime', 'ToolCall 未处于可执行状态。'));
        });
        return started.ok ? started.data : started;
      } catch { return fail(databaseError('ToolCall 执行状态保存失败。')); }
    },

    finish(input) {
      try {
        const completed = writeTransaction(() => {
          if (!['succeeded', 'failed', 'cancelled'].includes(input.result.status)
            || !Array.isArray(input.cleanup.errors) || (input.result.status === 'succeeded' && (!input.cleanup.stopped || input.stoppedAt === null))) {
            return fail(appError('input_invalid', 'storage', 'ToolCall 终态事实无效。'));
          }
          const before = byId(input.toolCallId);
          if (!before.ok) return before;
          const observation = input.runtimeObservation === undefined ? null : ToolRuntimeObservationSchema.parse(input.runtimeObservation);
          if (observation?.beforeOutcome === 'rejected') return fail(appError('input_invalid', 'storage', 'An executed call requires an allowed before observation.'));
          const incoming = readToolEnvelope(JSON.stringify(input.result)).result;
          if (incoming === null) return fail(appError('input_invalid', 'storage', 'ToolCall 终态结果缺失。'));
          if (incoming.formApplication !== undefined) {
            try { validateFormApplication(db, before.data, incoming.formApplication); }
            catch { return fail(appError('state_conflict', 'runtime', '表单回执与原调用不匹配。')); }
          }
          const cleanup = readToolCleanup({ ...input.cleanup,
            ...(before.data.cleanup.nativeProcesses ? { nativeProcesses: before.data.cleanup.nativeProcesses } : {}),
            ...(before.data.cleanup.nativeOutputs ? { nativeOutputs: before.data.cleanup.nativeOutputs } : {}) });
          if (cleanup.nativeProcesses?.some((record) => !record.stopped)) cleanup.stopped = false;
          if (input.result.status === 'succeeded' && !cleanup.stopped) return fail(appError('stop_not_confirmed', 'runtime', 'Native process termination has not been confirmed.'));
          if (before.data.result !== null) return stableJson(toolResultCore(before.data.result)) === stableJson(toolResultCore(incoming))
            && stableJson(before.data.cleanup) === stableJson(cleanup) && before.data.endedAt === input.endedAt
            && before.data.stoppedAt === input.stoppedAt && stableJson(before.data.runtimeObservation ?? null) === stableJson(observation)
            ? before : fail(appError('state_conflict', 'runtime', 'ToolCall 终态已固定。'));
          if (incoming.formApplication !== undefined && before.data.formApplication !== undefined
            && stableJson(incoming.formApplication) !== stableJson(before.data.formApplication)) {
            return fail(appError('state_conflict', 'runtime', '表单应用事实已固定，请通过原调用补证。'));
          }
          const formApplication = before.data.formApplication ?? incoming.formApplication;
          const serialized = JSON.stringify({ ...incoming, ...(formApplication === undefined ? {} : { formApplication }) });
          if (!NATIVE_TOOL_NAMES.includes(before.data.toolName as (typeof NATIVE_TOOL_NAMES)[number])
            && Buffer.byteLength(serialized, 'utf8') > TOOL_CONFIG.payload.maxStoredResultEnvelopeBytes) return fail(appError('tool_result_too_large', 'storage', 'ToolCall 结果超过记录上限。'));
          const changed = db.query(`UPDATE tool_calls SET status=?,result_json=?,cleanup_json=?,ended_at=?,stopped_at=?,runtime_observation_json=?
            WHERE id=? AND status='running'`).run(input.result.status, serialized, JSON.stringify(cleanup), input.endedAt,
            input.stoppedAt, observation === null ? null : JSON.stringify(observation), input.toolCallId).changes;
          if (changed === 1) {
            appendToolState(db, events, input.toolCallId, input.result.status === 'succeeded' ? 'tool_succeeded'
              : input.result.status === 'failed' ? 'tool_failed' : 'tool_cancelled');
            return byId(input.toolCallId);
          }
          return fail(appError('state_conflict', 'runtime', 'ToolCall 终态已固定或状态已变化。'));
        });
        return completed.ok ? completed.data : completed;
      } catch { return fail(databaseError('ToolCall 终态保存失败。')); }
    },

    reject(input) {
      try {
        const rejected = writeTransaction(() => {
          if (!['failed', 'cancelled'].includes(input.result.status) || input.cleanup.version !== 1
            || input.cleanup.stopped !== true || !Array.isArray(input.cleanup.errors)) {
            return fail(appError('input_invalid', 'storage', '未执行调用的终态事实无效。'));
          }
          const before = byId(input.toolCallId);
          if (!before.ok) return before;
          const observation = input.runtimeObservation === undefined ? null : ToolRuntimeObservationSchema.parse(input.runtimeObservation);
          if (observation !== null && observation.beforeOutcome !== 'rejected') return fail(appError('input_invalid', 'storage', 'A rejected call requires a rejected before observation.'));
          const incoming = readToolEnvelope(JSON.stringify(input.result)).result;
          if (incoming === null) return fail(appError('input_invalid', 'storage', 'ToolCall 终态结果缺失。'));
          if (incoming.formApplication !== undefined) {
            try { validateFormApplication(db, before.data, incoming.formApplication); }
            catch { return fail(appError('state_conflict', 'runtime', '表单回执与原调用不匹配。')); }
          }
          if (before.data.result !== null) return stableJson(toolResultCore(before.data.result)) === stableJson(toolResultCore(incoming))
            && stableJson(before.data.cleanup) === stableJson(input.cleanup) && before.data.endedAt === input.endedAt
            && before.data.stoppedAt === null && stableJson(before.data.runtimeObservation ?? null) === stableJson(observation)
            ? before : fail(appError('state_conflict', 'runtime', 'ToolCall 终态已固定。'));
          if (incoming.formApplication !== undefined && before.data.formApplication !== undefined
            && stableJson(incoming.formApplication) !== stableJson(before.data.formApplication)) {
            return fail(appError('state_conflict', 'runtime', '表单应用事实已固定，请通过原调用补证。'));
          }
          const formApplication = before.data.formApplication ?? incoming.formApplication;
          const serialized = JSON.stringify({ ...incoming, ...(formApplication === undefined ? {} : { formApplication }) });
          if (Buffer.byteLength(serialized, 'utf8') > TOOL_CONFIG.payload.maxStoredResultEnvelopeBytes) return fail(appError('tool_result_too_large', 'storage', 'ToolCall 结果超过记录上限。'));
          const changed = db.query(`UPDATE tool_calls SET status=?,result_json=?,cleanup_json=?,ended_at=?,stopped_at=NULL,runtime_observation_json=?
            WHERE id=? AND status='requested'`).run(input.result.status, serialized, JSON.stringify(input.cleanup), input.endedAt,
            observation === null ? null : JSON.stringify(observation), input.toolCallId).changes;
          if (changed === 1) {
            appendToolState(db, events, input.toolCallId, input.result.status === 'failed' ? 'tool_failed' : 'tool_cancelled');
            return byId(input.toolCallId);
          }
          return fail(appError('state_conflict', 'runtime', 'ToolCall 已开始或终态已固定。'));
        });
        return rejected.ok ? rejected.data : rejected;
      } catch { return fail(databaseError('ToolCall 拒绝记录保存失败。')); }
    },

    recordDelivery(input) {
      try {
        const parsed = readDelivery(input.delivery);
        if (!parsed) return fail(appError('input_invalid', 'storage', 'ToolCall 回送事实无效。'));
        const current = byId(input.toolCallId);
        if (!current.ok) return current;
        if (current.data.delivery.state === parsed.state) {
          return stableJson(current.data.delivery) === stableJson(parsed) ? current
            : fail(appError('state_conflict', 'runtime', 'ToolCall 同状态回送事实已固定。'));
        }
        if (!deliveryTransition(current.data.delivery.state, parsed.state)) return fail(appError('state_conflict', 'runtime', 'ToolCall 回送事实不能回退。'));
        const changed = db.query('UPDATE tool_calls SET delivery_json=? WHERE id=?')
          .run(JSON.stringify(parsed), input.toolCallId).changes;
        return changed === 1 ? byId(input.toolCallId) : fail(appError('tool_call_not_found', 'input', 'ToolCall 不存在。'));
      } catch { return fail(databaseError('ToolCall 回送事实保存失败。')); }
    },

    recordFormApplication(input) {
      const parsed = InvoiceFormApplicationReceiptSchema.safeParse(input.receipt);
      if (!Number.isSafeInteger(input.toolCallId) || input.toolCallId < 1 || !parsed.success) {
        return fail(appError('input_invalid', 'input', '表单应用回执无效。'));
      }
      const recorded = writeTransaction(() => {
        const before = byId(input.toolCallId);
        if (!before.ok) return before;
        try { validateFormApplication(db, before.data, parsed.data); }
        catch { return fail(appError('state_conflict', 'runtime', '表单回执与原调用、候选或目标不匹配。')); }
        const previous = before.data.formApplication;
        if (previous !== undefined) {
          if (stableJson(previous) === stableJson(parsed.data)) return before;
          if (previous.outcome !== 'unknown' || parsed.data.outcome === 'unknown') {
            return fail(appError('state_conflict', 'runtime', '表单应用事实不能回退或被矛盾回执覆盖。'));
          }
        }
        const envelope = { ...(before.data.result ?? { version: 1 }), formApplication: parsed.data };
        const changed = db.query('UPDATE tool_calls SET result_json=? WHERE id=?')
          .run(JSON.stringify(envelope), input.toolCallId).changes;
        return changed === 1 ? byId(input.toolCallId) : fail(appError('tool_call_not_found', 'input', 'ToolCall 不存在。'));
      });
      return recorded.ok ? recorded.data : recorded;
    },

    readFormApplicationRequest(toolCallId) {
      if (!Number.isSafeInteger(toolCallId) || toolCallId < 1) return fail(appError('input_invalid', 'input', 'ToolCall 身份无效。'));
      try {
        const before = byId(toolCallId);
        if (!before.ok) return before;
        try { return ok(deriveFormApplicationRequest(db, before.data)); }
        catch { return fail(appError('state_conflict', 'runtime', '原调用没有可核验的填表依据。')); }
      } catch { return fail(appError('storage_corrupt', 'storage', '原填表调用无法读取。')); }
    },

    getNativeWorkingDirectory(context) {
      try {
        const trusted = trustedContext(context);
        return trusted;
      } catch { return fail(appError('storage_corrupt', 'storage', 'Frozen native Run context is unreadable.')); }
    },


  };
}

function stableJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(',')}]`;
  if (value && typeof value === 'object') {
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${stableJson((value as Record<string, unknown>)[key])}`).join(',')}}`;
  }
  return JSON.stringify(value) ?? 'undefined';
}

function readDelivery(value: unknown): ToolCallDelivery | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const delivery = value as Record<string, unknown>;
  if (delivery.version !== 1 || !['not_attempted', 'message_observed', 'request_observed', 'failed', 'unknown'].includes(String(delivery.state))
    || (delivery.messageObservedAt !== null && typeof delivery.messageObservedAt !== 'string')
    || (delivery.includedInCallSequence !== null && (!Number.isSafeInteger(delivery.includedInCallSequence) || Number(delivery.includedInCallSequence) < 1))
    || (delivery.requestDispatchedAt !== null && typeof delivery.requestDispatchedAt !== 'string')) return null;
  const error = delivery.error === null ? null : AppErrorSchema.safeParse(delivery.error);
  if (delivery.error !== null && !error?.success) return null;
  return { version: 1, state: delivery.state as ToolCallDelivery['state'],
    messageObservedAt: delivery.messageObservedAt as string | null,
    includedInCallSequence: delivery.includedInCallSequence as number | null,
    requestDispatchedAt: delivery.requestDispatchedAt as string | null,
    error: error?.success ? error.data : null };
}

function deliveryTransition(from: ToolCallDelivery['state'], to: ToolCallDelivery['state']): boolean {
  if (from === to) return true;
  if (from === 'not_attempted') return ['message_observed', 'failed', 'unknown'].includes(to);
  if (from === 'message_observed') return ['request_observed', 'failed', 'unknown'].includes(to);
  return false;
}

export function createBusinessEventRepository(db: Database): BusinessEventRepository {
  return {
    list(input) {
      try {
        if (!Number.isSafeInteger(input.limit) || input.limit < 1 || input.limit > 100
          || input.beforeId !== undefined && (!Number.isSafeInteger(input.beforeId) || input.beforeId < 1)
          || !('documentId' in input ? Number.isSafeInteger(input.documentId) && input.documentId > 0
            : Number.isSafeInteger(input.jobId) && input.jobId > 0)) return fail(appError('input_invalid', 'input', 'Activity 分页参数无效。'));
        const column = 'documentId' in input ? 'document_id' : 'job_id';
        const id = 'documentId' in input ? input.documentId : input.jobId;
        const rows = input.beforeId === undefined
          ? db.query(`SELECT * FROM business_events WHERE ${column}=? ORDER BY id DESC LIMIT ?`).all(id, input.limit + 1)
          : db.query(`SELECT * FROM business_events WHERE ${column}=? AND id<? ORDER BY id DESC LIMIT ?`).all(id, input.beforeId, input.limit + 1);
        const events = (rows as unknown[]).map(businessEventSnapshot);
        const hasMore = events.length > input.limit;
        const items = hasMore ? events.slice(0, input.limit) : events;
        return ok({ items, nextBeforeId: hasMore ? items.at(-1)?.id ?? null : null });
      } catch { return fail(appError('storage_corrupt', 'storage', 'Activity 无法读取。')); }
    },
    getByOperation(input) {
      try {
        if (typeof input.operationRef !== 'string' || input.operationRef.length < 1 || input.operationRef.length > 256) {
          return fail(appError('input_invalid', 'input', 'Activity 操作引用无效。'));
        }
        const row = input.result
          ? db.query('SELECT * FROM business_events WHERE type=? AND operation_ref=? AND result=?').get(input.type, input.operationRef, input.result)
          : db.query('SELECT * FROM business_events WHERE type=? AND operation_ref=? ORDER BY id DESC LIMIT 1').get(input.type, input.operationRef);
        return row ? ok(businessEventSnapshot(row)) : ok(null);
      } catch { return fail(appError('storage_corrupt', 'storage', 'Activity 操作无法读取。')); }
    },
  };
}

function queryCandidateRow(db: Database, candidateId: DbId, jobId?: DbId): unknown {
  const sql = `SELECT candidate.*,document.id AS document_id,document.version AS document_version
    FROM invoice_candidates candidate JOIN jobs job ON job.id=candidate.job_id
    JOIN documents document ON document.id=job.document_id WHERE candidate.id=?${jobId === undefined ? '' : ' AND candidate.job_id=?'}`;
  return jobId === undefined ? db.query(sql).get(candidateId) : db.query(sql).get(candidateId, jobId);
}

function invoiceRequestHash(value: unknown): string {
  return createHash('sha256').update(stableJson(value)).digest('hex');
}
function executionReleased(db: Database, jobId: DbId): boolean {
  const runs = db.query('SELECT status,cleanup_json FROM runs WHERE job_id=? OR status IN (\'created\',\'running\')').all(jobId) as
    Array<{ status: string; cleanup_json: string }>;
  if (runs.some(run => {
    if (run.status === 'created' || run.status === 'running') return true;
    const cleanup = validatedCleanup(readJson(run.cleanup_json, 'cleanup'));
    return !cleanup.stopped || cleanup.lateObservationRequired;
  })) return false;
  const calls = db.query('SELECT call.status,call.cleanup_json FROM tool_calls call JOIN runs run ON run.id=call.run_id WHERE run.job_id=?')
    .all(jobId) as Array<{ status: string; cleanup_json: string }>;
  return !calls.some(call => {
    if (call.status === 'requested' || call.status === 'running') return true;
    const cleanup = readToolCleanup(readJson(call.cleanup_json, 'tool_cleanup'));
    return !cleanup.stopped || cleanup.nativeProcesses?.some(item => !item.stopped);
  });
}
function humanField(name: string, text: string, before?: StoredInvoiceField): StoredInvoiceField {
  if (before && text === invoiceFieldDisplayValue(name, before)) return structuredClone(before);
  if (!text.trim()) return { raw: null, normalized: null, state: 'missing', alternatives: [], sources: [], valueOrigin: 'user-provided' };
  const normalized = text.trim();
  if (!isLegalInvoiceNormalizedValue(name, normalized)) throw new Error('human_value_invalid');
  return { raw: text, normalized, state: 'present', alternatives: [], sources: [], valueOrigin: 'user-provided' };
}
function humanDraft(input: SaveInvoiceCandidateRequest, before: CandidateSnapshot): StoredCandidateDraft {
  return StoredCandidateDraftSchema.parse({
    fields: Object.fromEntries(invoiceHeaderFields.map(name => [name, humanField(name, input.draft.fields[name], before.fields[name])])),
    lines: input.draft.lines.map((line, index) => Object.fromEntries(invoiceLineFields.map(name =>
      [name, humanField(name, line[name], before.lines[index]?.[name])]))), notes: [...input.draft.notes],
  });
}
function invoiceOperationFacts(db: Database, input: { jobId: DbId; expectedCandidateId: DbId; expectedRevision: number }, at: string):
  Result<{ job: JobSnapshot; workspace: WorkspaceSnapshot }> {
  const workspace = workspaceSnapshot(db, ensureWorkspace(db, at), at);
  const job = readJob(db, input.jobId);
  if (!job) return fail(appError('job_not_found', 'input', 'Job 不存在。'));
  if (workspace.revision !== input.expectedRevision || workspace.jobId !== input.jobId
    || workspace.documentRef?.id !== job.documentRef.id || workspace.documentRef.version !== job.documentRef.version
    || job.currentCandidateId !== input.expectedCandidateId || workspace.candidateRef?.id !== input.expectedCandidateId) {
    return fail(appError('state_conflict', 'input', '候选或 Workspace 已变化，请重新读取。', true));
  }
  if (job.status === 'completed') return fail(appError('job_completed', 'input', '已接受结果不能修改。'));
  const document = db.query('SELECT status,hidden_at FROM documents WHERE id=?').get(job.documentRef.id) as { status: string; hidden_at: string | null };
  if (document.status !== 'available' || document.hidden_at !== null) return fail(appError('input_unavailable', 'input', '材料当前不可用于修改。'));
  if (!executionReleased(db, input.jobId)) return fail(appError('state_conflict', 'runtime', '实际执行尚未释放，不能修改结果。', true));
  if (!Number.isSafeInteger(workspace.revision + 1)) return fail(appError('state_conflict', 'input', 'Workspace revision 已到上限。'));
  return ok({ job, workspace });
}
function invoiceEvent(db: Database, type: BusinessEventType, operationRef: string): BusinessEventSnapshot | null {
  const row = db.query("SELECT * FROM business_events WHERE type=? AND operation_ref=? AND result='succeeded'").get(type, operationRef);
  return row ? businessEventSnapshot(row) : null;
}
function invoiceExportName(candidate: CandidateSnapshot, format: ExportInvoiceCandidateRequest['format']): string {
  return `outputs/invoice-${candidate.jobId}-result-${candidate.sequence}.${format === 'markdown' ? 'md' : format}`;
}
function findInvoiceExport(db: Database, input: ExportInvoiceCandidateRequest): Result<InvoiceExportReference | null> {
  if (!ExportInvoiceCandidateRequestSchema.safeParse(input).success) return fail(appError('input_invalid', 'input', '导出参数无效。'));
  try {
    const prior = invoiceEvent(db, 'candidate_exported', input.operationRef);
    if (!prior) return ok(null);
    const summary = object(readJson(prior.safeSummary, 'export_event'), 'export_event');
    if (summary.requestHash !== invoiceRequestHash(input) || prior.candidateId !== input.candidateId) {
      return fail(appError('state_conflict', 'input', '同一操作引用已有不同导出事实。'));
    }
    const artifact = db.query("SELECT * FROM artifacts WHERE id=? AND kind='export'").get(prior.artifactId!) as {
      id: number; relative_path: string; bytes: number; metadata_json: string; created_at: string;
    } | null;
    if (!artifact) throw new Error('missing_export_artifact');
    const meta = exactRecord(readJson(artifact.metadata_json, 'export_metadata'), 'export_metadata',
      ['version', 'candidateId', 'basedOnCandidateId', 'format', 'sha256', 'requestHash']);
    const saved = candidateSnapshot(db, queryCandidateRow(db, input.candidateId));
    const job = readJob(db, saved.snapshot.jobId);
    if (meta.version !== 1 || meta.candidateId !== input.candidateId || meta.format !== input.format
      || typeof meta.sha256 !== 'string' || !/^[0-9a-f]{64}$/.test(meta.sha256)
      || typeof meta.requestHash !== 'string' || !/^[0-9a-f]{64}$/.test(meta.requestHash)
      || meta.basedOnCandidateId !== (saved.snapshot.basedOnCandidateId ?? null)
      || saved.snapshot.status !== 'accepted' || job?.status !== 'completed' || job.acceptedCandidateId !== input.candidateId
      || prior.jobId !== saved.snapshot.jobId || prior.documentId !== saved.documentRef.id
      || !Number.isSafeInteger(artifact.bytes) || artifact.bytes <= 0
      || artifact.relative_path !== invoiceExportName(saved.snapshot, input.format)) throw new Error('invalid_export_artifact');
    return ok({ artifactId: artifact.id, candidateId: input.candidateId, format: input.format,
      relativePath: artifact.relative_path, bytes: artifact.bytes, sha256: meta.sha256, createdAt: artifact.created_at });
  } catch { return fail(appError('storage_corrupt', 'storage', '导出事实无法读取。')); }
}
function recordInvoiceEvent(db: Database, type: BusinessEventType, operationRef: string, candidate: CandidateSnapshot,
  documentId: DbId, at: string, summary: string, artifactId: DbId | null = null): void {
  db.query(`INSERT INTO business_events(type,occurred_at,actor_source,operation_ref,document_id,job_id,candidate_id,artifact_id,result,safe_summary)
    VALUES (?,?,'user',?,?,?,?,?,'succeeded',?)`).run(type, at, operationRef, documentId, candidate.jobId, candidate.candidateId, artifactId, summary);
}

export function createCandidateRepository(db: Database): InvoiceEditRepository {
  const readDecision = (candidateId: DbId, jobId: DbId, at: string): InvoiceCandidateDecisionResponse => {
    const candidate = candidateSnapshot(db, queryCandidateRow(db, candidateId, jobId)).snapshot;
    const job = readJob(db, jobId);
    if (!job) throw new Error('job_not_found');
    return { candidate, job, workspace: workspaceSnapshot(db, db.query('SELECT * FROM workspace WHERE id=1').get(), at) };
  };
  const decision = (input: (AcceptInvoiceCandidateRequest | RejectInvoiceCandidateRequest) & { at: string; validate?: ValidateHumanInvoice }, accept: boolean): Result<InvoiceCandidateDecisionResponse> => {
    const { at, validate, ...request } = input;
    const schema = accept ? AcceptInvoiceCandidateRequestSchema : RejectInvoiceCandidateRequestSchema;
    const parsed = schema.safeParse(request);
    if (!parsed.success) return fail(appError('input_invalid', 'input', '候选确认参数无效。'));
    const type = accept ? 'candidate_accepted' : 'candidate_rejected';
    const hash = invoiceRequestHash(parsed.data);
    const committed = transaction(db, () => {
      const prior = invoiceEvent(db, type, input.operationRef);
      if (prior) {
        const summary = object(readJson(prior.safeSummary, 'decision'), 'decision');
        if (summary.requestHash !== hash || prior.jobId !== input.jobId || prior.candidateId !== input.candidateId) {
          return fail(appError('state_conflict', 'input', '同一操作引用已有不同事实。'));
        }
        return ok(readDecision(input.candidateId, input.jobId, at));
      }
      const facts = invoiceOperationFacts(db, input, at);
      if (!facts.ok) return facts;
      const row = queryCandidateRow(db, input.candidateId, input.jobId);
      if (!row) return fail(appError('candidate_not_found', 'input', '当前 Job 不存在该候选。'));
      const candidate = candidateSnapshot(db, row).snapshot;
      if (candidate.status === 'accepted' || input.candidateId !== input.expectedCandidateId) {
        return fail(appError('state_conflict', 'input', '候选不再满足确认条件。'));
      }
      if (!accept && candidate.status === 'rejected') return fail(appError('state_conflict', 'input', '候选已拒绝。'));
      if (accept) {
        if (!validate) return fail(appError('input_invalid', 'input', '接受缺少必要领域核验。'));
        const validated = validate({ fields: candidate.fields, lines: candidate.lines, notes: candidate.notes }, facts.data.job.documentRef);
        if (!validated.ok) return validated;
      }
      db.query('UPDATE invoice_candidates SET status=?,accepted_at=? WHERE id=? AND status IN (\'generated\',\'rejected\')')
        .run(accept ? 'accepted' : 'rejected', accept ? at : null, input.candidateId);
      if (accept) db.query("UPDATE jobs SET status='completed',status_reason='user_accepted',accepted_candidate_id=?,updated_at=? WHERE id=?")
        .run(input.candidateId, at, input.jobId);
      else db.query('UPDATE jobs SET current_candidate_id=NULL,updated_at=? WHERE id=?').run(at, input.jobId);
      db.query('UPDATE workspace SET selection_json=NULL,revision=revision+1,updated_at=? WHERE id=1').run(at);
      recordInvoiceEvent(db, type, input.operationRef, candidate, facts.data.job.documentRef.id, at,
        asJson({ version: 1, requestHash: hash, ...('reason' in parsed.data ? { reason: parsed.data.reason } : {}) }));
      return ok(readDecision(input.candidateId, input.jobId, at));
    });
    return committed.ok ? committed.data : committed;
  };
  return {
    queryOperation(input) {
      const { at, ...query } = input;
      const parsed = InvoiceCandidateOperationQuerySchema.safeParse(query);
      if (!parsed.success) return fail(appError('input_invalid', 'input', '操作查询参数无效。'));
      try {
        const { kind, request } = parsed.data;
        if (kind === 'export') return findInvoiceExport(db, request);
        const type = kind === 'save' ? 'candidate_edited' : kind === 'accept' ? 'candidate_accepted' : 'candidate_rejected';
        const prior = invoiceEvent(db, type, request.operationRef);
        if (!prior) return ok(null);
        if (prior.jobId !== request.jobId || prior.candidateId === null) return fail(appError('state_conflict', 'input', '同一操作引用已有不同事实。'));
        const row = queryCandidateRow(db, prior.candidateId, request.jobId) as { fields_json: string } | null;
        if (!row) throw new Error('missing_operation_candidate');
        const hash = kind === 'save' ? object(readJson(row.fields_json, 'candidate_fields'), 'candidate_fields').editRequestHash
          : object(readJson(prior.safeSummary, 'decision'), 'decision').requestHash;
        if (hash !== invoiceRequestHash(request)) return fail(appError('state_conflict', 'input', '同一操作引用已有不同载荷。'));
        if (kind === 'save') return ok({ changed: true, candidate: candidateSnapshot(db, row).snapshot,
          workspace: workspaceSnapshot(db, db.query('SELECT * FROM workspace WHERE id=1').get(), at) });
        return ok(readDecision(prior.candidateId, request.jobId, at));
      } catch { return fail(appError('storage_corrupt', 'storage', '操作事实无法读取。')); }
    },
    saveHuman(input) {
      const { at, validate, ...request } = input;
      const parsed = SaveInvoiceCandidateRequestSchema.safeParse(request);
      if (!parsed.success) return fail(appError('input_invalid', 'input', '人工表单参数无效。'));
      const hash = invoiceRequestHash(parsed.data);
      const committed = transaction(db, () => {
        const prior = invoiceEvent(db, 'candidate_edited', input.operationRef);
        if (prior) {
          const row = queryCandidateRow(db, prior.candidateId!, input.jobId) as { fields_json: string } | null;
          if (!row || object(readJson(row.fields_json, 'candidate_fields'), 'candidate_fields').editRequestHash !== hash) {
            return fail(appError('state_conflict', 'input', '同一操作引用已有不同人工版本。'));
          }
          return ok({ changed: true, candidate: candidateSnapshot(db, row).snapshot,
            workspace: workspaceSnapshot(db, ensureWorkspace(db, at), at) });
        }
        const facts = invoiceOperationFacts(db, input, at);
        if (!facts.ok) return facts;
        if (input.basedOnCandidateId !== input.expectedCandidateId) return fail(appError('state_conflict', 'input', '编辑依据不是当前候选。'));
        const row = queryCandidateRow(db, input.basedOnCandidateId, input.jobId);
        if (!row) return fail(appError('candidate_not_found', 'input', '编辑依据不存在。'));
        const basis = candidateSnapshot(db, row).snapshot;
        if (basis.status === 'accepted') return fail(appError('state_conflict', 'input', '已接受结果不能编辑。'));
        let candidate: StoredCandidateDraft;
        try { candidate = humanDraft(input, basis); }
        catch { return fail(appError('input_invalid', 'input', '人工值不满足字段或精确数值规则。')); }
        if (stableJson(candidate) === stableJson({ fields: basis.fields, lines: basis.lines, notes: basis.notes })) {
          return ok({ changed: false, candidate: basis, workspace: facts.data.workspace });
        }
        const validation = validate(candidate, facts.data.job.documentRef);
        if (!validation.ok) return validation;
        const checks = z.array(CheckResultSchema).max(MAX_INVOICE_CHECKS).parse(validation.data.checks);
        const issues = z.array(InvoiceIssueSchema).max(MAX_INVOICE_ISSUES).parse(validation.data.issues);
        const fieldsJson = asJson({ version: 1, values: candidate.fields, editRequestHash: hash });
        const linesJson = asJson({ version: 1, items: candidate.lines });
        const issuesJson = asJson({ version: 1, notes: candidate.notes, checks, items: issues });
        if (Buffer.byteLength(fieldsJson + linesJson + issuesJson, 'utf8') > 256 * 1024) return fail(appError('tool_result_too_large', 'input', '人工候选超过保存上限。'));
        const sequence = (db.query('SELECT COALESCE(MAX(sequence),0)+1 AS next FROM invoice_candidates WHERE job_id=?').get(input.jobId) as { next: number }).next;
        if (!Number.isSafeInteger(sequence)) return fail(appError('state_conflict', 'input', '候选版本已到上限。'));
        const inserted = db.query(`INSERT INTO invoice_candidates(job_id,run_id,tool_call_id,sequence,origin,based_on_candidate_id,status,
          fields_json,lines_json,issues_json,created_at) VALUES (?,NULL,NULL,?,'human_edit',?,'generated',?,?,?,?)`)
          .run(input.jobId, sequence, basis.candidateId, fieldsJson, linesJson, issuesJson, at);
        const candidateId = Number(inserted.lastInsertRowid);
        db.query('UPDATE jobs SET current_candidate_id=?,updated_at=? WHERE id=?').run(candidateId, at, input.jobId);
        db.query('UPDATE workspace SET selection_json=NULL,revision=revision+1,updated_at=? WHERE id=1').run(at);
        const saved = candidateSnapshot(db, queryCandidateRow(db, candidateId, input.jobId)).snapshot;
        recordInvoiceEvent(db, 'candidate_edited', input.operationRef, saved, facts.data.job.documentRef.id, at, 'Human changes saved');
        return ok({ changed: true, candidate: saved, workspace: workspaceSnapshot(db, db.query('SELECT * FROM workspace WHERE id=1').get(), at) });
      });
      return committed.ok ? committed.data : committed;
    },
    accept(input) { return decision(input, true); },
    reject(input) { return decision(input, false); },
    readAccepted(candidateId) {
      try {
        const candidate = candidateSnapshot(db, queryCandidateRow(db, candidateId));
        const job = readJob(db, candidate.snapshot.jobId);
        if (candidate.snapshot.status !== 'accepted' || job?.status !== 'completed' || job.acceptedCandidateId !== candidateId
          || job.currentCandidateId !== candidateId) return fail(appError('state_conflict', 'input', '只能导出指定的已接受结果。'));
        return ok({ candidate: candidate.snapshot, documentRef: candidate.documentRef });
      } catch { return fail(appError('storage_corrupt', 'storage', '已接受结果无法读取。')); }
    },
    findExport(input) { return findInvoiceExport(db, input); },
    registerExport(input) {
      const { at, relativePath, bytes, sha256, ...request } = input;
      if (!ExportInvoiceCandidateRequestSchema.safeParse(request).success || !/^outputs\/invoice-[1-9]\d*-result-[1-9]\d*\.(json|csv|md)$/.test(relativePath)
        || !Number.isSafeInteger(bytes) || bytes <= 0 || !/^[a-f0-9]{64}$/.test(sha256)) return fail(appError('input_invalid', 'input', '导出文件引用无效。'));
      const committed = transaction(db, () => {
        const prior = findInvoiceExport(db, request);
        if (!prior.ok) return prior;
        if (prior.data) return prior.data.relativePath === relativePath && prior.data.bytes === bytes && prior.data.sha256 === sha256
          ? prior : fail(appError('state_conflict', 'input', '同一操作已有不同的文件登记事实。'));
        const saved = candidateSnapshot(db, queryCandidateRow(db, input.candidateId));
        const job = readJob(db, saved.snapshot.jobId);
        if (saved.snapshot.status !== 'accepted' || job?.acceptedCandidateId !== input.candidateId || job.currentCandidateId !== input.candidateId
          || job.status !== 'completed') return fail(appError('state_conflict', 'input', '导出结果不再满足接受条件。'));
        if (relativePath !== invoiceExportName(saved.snapshot, input.format)) return fail(appError('state_conflict', 'input', '导出路径不属于指定的已接受版本。'));
        const existing = db.query('SELECT * FROM artifacts WHERE relative_path=?').get(relativePath) as { id: number; kind: string; metadata_json: string; bytes: number } | null;
        const metadata = { version: 1, candidateId: input.candidateId, basedOnCandidateId: saved.snapshot.basedOnCandidateId ?? null,
          format: input.format, sha256, requestHash: invoiceRequestHash(request) };
        let artifactId: number;
        if (existing) {
          const facts = object(readJson(existing.metadata_json, 'export'), 'export');
          if (existing.kind !== 'export' || existing.bytes !== bytes || facts.candidateId !== input.candidateId || facts.format !== input.format || facts.sha256 !== sha256
            || facts.basedOnCandidateId !== (saved.snapshot.basedOnCandidateId ?? null)) {
            return fail(appError('state_conflict', 'input', '目标文件已有不同的登记事实。'));
          }
          artifactId = existing.id;
        } else {
          artifactId = Number(db.query("INSERT INTO artifacts(kind,relative_path,bytes,mime_type,metadata_json,created_at) VALUES ('export',?,?,?,?,?)")
            .run(relativePath, bytes, input.format === 'json' ? 'application/json' : input.format === 'csv' ? 'text/csv' : 'text/markdown', asJson(metadata), at).lastInsertRowid);
        }
        recordInvoiceEvent(db, 'candidate_exported', input.operationRef, saved.snapshot, saved.documentRef.id, at,
          asJson({ version: 1, requestHash: invoiceRequestHash(request), format: input.format }), artifactId);
        return findInvoiceExport(db, request);
      });
      if (!committed.ok) return committed;
      return committed.data.ok && committed.data.data ? ok(committed.data.data) : committed.data.ok
        ? fail(appError('storage_corrupt', 'storage', '导出登记缺少事实。')) : committed.data;
    },
    save(input) {
      try {
        const draft = CandidateDraftSchema.parse(input.candidate);
        const checks = z.array(CheckResultSchema).max(MAX_INVOICE_CHECKS).parse(input.checks);
        const issues = z.array(InvoiceIssueSchema).max(MAX_INVOICE_ISSUES).parse(input.issues);
        const finalArgs = JSON.stringify({ documentId: input.documentId, candidate: draft });
        if (Buffer.byteLength(finalArgs, 'utf8') > 256 * 1024) return fail(appError('tool_result_too_large', 'input', '候选参数超过保存上限。'));
        const committed = transaction(db, () => {
          const facts = db.query(`SELECT run.status AS run_status,run.session_id,run.job_id,run.scope_json,
              job.document_id,job.status AS job_status,document.version AS document_version,document.status AS document_status,
              session.metadata_json,tool.id AS tool_call_id,tool.status AS tool_status,tool.tool_name,tool.native_tool_call_id,tool.args_json
            FROM runs run JOIN sessions session ON session.id=run.session_id
            JOIN tool_calls tool ON tool.run_id=run.id AND tool.session_id=run.session_id
            JOIN jobs job ON job.id=run.job_id JOIN documents document ON document.id=job.document_id
            WHERE run.id=? AND run.session_id=? AND tool.native_tool_call_id=?`).get(input.runId, input.sessionId, input.nativeToolCallId) as {
              run_status: string; session_id: number; job_id: number; scope_json: string; document_id: number; tool_call_id: number;
              job_status: string; document_version: string; document_status: string; metadata_json: string;
              tool_status: string; tool_name: string; native_tool_call_id: string; args_json: string;
            } | null;
          if (!facts || facts.run_status !== 'running' || facts.job_status !== 'running' || facts.document_status !== 'available') {
            return { ok: false as const, error: appError('state_conflict', 'runtime', 'Run、Job 或正式材料已不可提交候选。') };
          }
          if (facts.document_id !== input.documentId || facts.tool_status !== 'running' || facts.tool_name !== 'save_invoice_candidate') {
            return { ok: false as const, error: appError('tool_access_denied', 'runtime', '候选保存与可信工具调用不匹配。') };
          }
          const scope = RunScopeSchema.safeParse(readJson(facts.scope_json, 'run_scope'));
          if (!scope.success || !scope.data.allowedTools.includes('save_invoice_candidate')
            || !scope.data.allowedDocumentIds.includes(input.documentId)) {
            return { ok: false as const, error: appError('tool_access_denied', 'runtime', '当前 Run 无权保存此材料的候选。') };
          }
          if (parseSessionModelUse(facts.metadata_json) !== null) {
            return { ok: false as const, error: appError('session_scope_revoked', 'session', '此 Session 已撤回材料使用权限。') };
          }
          const storedArgs = object(readJson(facts.args_json, 'tool_call_arguments'), 'tool_call_arguments');
          if (storedArgs.version !== 1 || stableJson(storedArgs.final) !== stableJson(JSON.parse(finalArgs))) {
            return { ok: false as const, error: appError('state_conflict', 'runtime', '候选与已固定的 ToolCall 参数不一致。') };
          }
          const existing = db.query('SELECT id FROM invoice_candidates WHERE tool_call_id=?').get(facts.tool_call_id) as { id: number } | null;
          if (existing) {
            const candidate = candidateSnapshot(db, queryCandidateRow(db, existing.id, facts.job_id));
            if (candidate.snapshot.runId !== input.runId || stableJson({ fields: candidate.snapshot.fields, lines: candidate.snapshot.lines, notes: candidate.snapshot.notes })
              !== stableJson(draft)) return { ok: false as const, error: appError('state_conflict', 'runtime', '同一 ToolCall 已提交了不同候选。') };
            return { ok: true as const, candidate, created: false };
          }
          if (facts.session_id < 1 || facts.document_version.length < 1 || !['running'].includes(facts.tool_status)) {
            return { ok: false as const, error: appError('state_conflict', 'runtime', '候选来源上下文无效。') };
          }
          const sequence = (db.query('SELECT COALESCE(MAX(sequence),0)+1 AS next FROM invoice_candidates WHERE job_id=?')
            .get(facts.job_id) as { next: number }).next;
          const inserted = db.query(`INSERT INTO invoice_candidates(job_id,run_id,tool_call_id,sequence,origin,status,fields_json,lines_json,issues_json,created_at)
            VALUES (?,?,?,?,'model','generated',?,?,?,?)`).run(facts.job_id, input.runId, facts.tool_call_id, sequence,
            asJson({ version: 1, values: draft.fields }), asJson({ version: 1, items: draft.lines }),
            asJson({ version: 1, notes: draft.notes, checks, items: issues }), input.at);
          const candidateId = Number(inserted.lastInsertRowid);
          if (!Number.isSafeInteger(candidateId) || candidateId < 1) throw new Error('unsafe_candidate_id');
          db.query(`INSERT INTO business_events(type,occurred_at,actor_source,operation_ref,document_id,job_id,candidate_id,run_id,result,safe_summary)
            VALUES ('candidate_generated',?,'agent',?,?,?,?,?,'succeeded','Invoice candidate generated')`)
            .run(input.at, `tool-call-id:${facts.tool_call_id}`, input.documentId, facts.job_id, candidateId, input.runId);
          const candidate = candidateSnapshot(db, queryCandidateRow(db, candidateId, facts.job_id));
          return { ok: true as const, candidate, created: true };
        });
        if (!committed.ok) return committed;
        if (!committed.data.ok) return fail(committed.data.error);
        const snapshot = committed.data.candidate.snapshot;
        return ok({ candidate: snapshot, created: committed.data.created, receipt: {
          candidateId: snapshot.candidateId, jobId: snapshot.jobId, sequence: snapshot.sequence,
          issueCount: snapshot.issueCount, checks: snapshot.checks,
        } });
      } catch {
        return fail(databaseError('候选事务提交失败。'));
      }
    },

    listByJob(input) {
      try {
        if (!Number.isSafeInteger(input.jobId) || input.jobId < 1 || !Number.isSafeInteger(input.limit) || input.limit < 1 || input.limit > 100
          || input.beforeSequence !== null && (!Number.isSafeInteger(input.beforeSequence) || input.beforeSequence < 1)) {
          return fail(appError('input_invalid', 'input', 'Candidate 分页参数无效。'));
        }
        if (!readJob(db, input.jobId)) return fail(appError('job_not_found', 'input', 'Job 不存在。'));
        const rows = input.beforeSequence === null
          ? db.query('SELECT id FROM invoice_candidates WHERE job_id=? ORDER BY sequence DESC LIMIT ?').all(input.jobId, input.limit + 1)
          : db.query('SELECT id FROM invoice_candidates WHERE job_id=? AND sequence<? ORDER BY sequence DESC LIMIT ?')
            .all(input.jobId, input.beforeSequence, input.limit + 1);
        const items = (rows as Array<{ id: number }>).map(({ id }) => candidateSnapshot(db, queryCandidateRow(db, id, input.jobId)).snapshot)
          .map(({ candidateId, jobId, runId, sequence, status, issueCount, createdAt, context, origin, basedOnCandidateId }) =>
            ({ candidateId, jobId, runId, sequence, status, issueCount, createdAt, context,
              ...(origin === undefined ? {} : { origin, basedOnCandidateId }) }));
        const hasMore = items.length > input.limit;
        const page = hasMore ? items.slice(0, input.limit) : items;
        return ok({ items: page, nextBeforeSequence: hasMore ? page.at(-1)?.sequence ?? null : null });
      } catch { return fail(appError('storage_corrupt', 'storage', 'Candidate 列表无法读取。')); }
    },

    readByJob(input) {
      try {
        if (!Number.isSafeInteger(input.jobId) || input.jobId < 1 || !Number.isSafeInteger(input.candidateId) || input.candidateId < 1) {
          return fail(appError('input_invalid', 'input', 'Candidate 查询参数无效。'));
        }
        if (!readJob(db, input.jobId)) return fail(appError('job_not_found', 'input', 'Job 不存在。'));
        const row = queryCandidateRow(db, input.candidateId, input.jobId);
        if (!row) return fail(appError('candidate_not_found', 'input', '此 Job 下不存在该 Candidate。'));
        const { snapshot, documentRef } = candidateSnapshot(db, row);
        return ok({ documentRef, candidate: snapshot });
      } catch { return fail(appError('storage_corrupt', 'storage', 'Candidate 无法读取。')); }
    },

    listForRun(input) {
      try {
        if (!Number.isSafeInteger(input.runId) || input.runId < 1 || !Number.isSafeInteger(input.limit)
          || input.limit < 1 || input.limit > MAX_INVOICE_TOOL_PAGE_SIZE
          || input.beforeSequence !== null && (!Number.isSafeInteger(input.beforeSequence) || input.beforeSequence < 1)) {
          return fail(appError('input_invalid', 'input', '候选分页参数无效。'));
        }
        const run = db.query("SELECT job_id FROM runs WHERE id=? AND kind='agent'").get(input.runId) as { job_id: number | null } | null;
        if (!run?.job_id) return fail(appError('state_conflict', 'runtime', '当前 Run 没有归属 Job。'));
        const rows = input.beforeSequence === null
          ? db.query('SELECT * FROM invoice_candidates WHERE job_id=? ORDER BY sequence DESC LIMIT ?').all(run.job_id, input.limit + 1)
          : db.query('SELECT * FROM invoice_candidates WHERE job_id=? AND sequence<? ORDER BY sequence DESC LIMIT ?').all(run.job_id, input.beforeSequence, input.limit + 1);
        const items = (rows as Array<{ id: number }>).map((row) => {
          const record = candidateSnapshot(db, queryCandidateRow(db, row.id, run.job_id!)).snapshot;
          return { candidateId: record.candidateId, runId: record.runId, sequence: record.sequence, issueCount: record.issueCount,
            ...(record.origin === undefined ? {} : { origin: record.origin, basedOnCandidateId: record.basedOnCandidateId }) };
        });
        const hasMore = items.length > input.limit;
        const page = hasMore ? items.slice(0, input.limit) : items;
        return ok({ jobId: run.job_id, candidates: page, nextBeforeSequence: hasMore ? page.at(-1)?.sequence ?? null : null });
      } catch { return fail(appError('storage_corrupt', 'storage', '候选列表无法读取。')); }
    },

    readForRun(input) {
      try {
        if (!Number.isSafeInteger(input.runId) || input.runId < 1 || !Number.isSafeInteger(input.candidateId) || input.candidateId < 1) {
          return fail(appError('input_invalid', 'input', 'Candidate ID 无效。'));
        }
        const run = db.query("SELECT job_id FROM runs WHERE id=? AND kind='agent'").get(input.runId) as { job_id: number | null } | null;
        if (!run?.job_id) return fail(appError('candidate_not_found', 'input', 'Candidate 不存在。'));
        const row = queryCandidateRow(db, input.candidateId, run.job_id);
        if (!row) return fail(appError('candidate_not_found', 'input', 'Candidate 不存在。'));
        const { snapshot, documentRef } = candidateSnapshot(db, row);
        return ok({ candidateId: snapshot.candidateId, jobId: snapshot.jobId, runId: snapshot.runId,
          sequence: snapshot.sequence, issueCount: snapshot.issueCount,
          documentRef, toolCallId: snapshot.toolCallId,
          candidate: { fields: snapshot.fields, lines: snapshot.lines, notes: snapshot.notes }, checks: snapshot.checks, issues: snapshot.issues,
          ...(snapshot.origin === undefined ? {} : { origin: snapshot.origin, basedOnCandidateId: snapshot.basedOnCandidateId }) });
      } catch { return fail(appError('storage_corrupt', 'storage', 'Candidate 无法读取。')); }
    },
  };
}

function snapshotFromRow(db: Database, row: RunRow): RunSnapshot {
  const context = readRunContextOwner(db, row);
  const output = row.output_json === null ? null : validatedOutput(readJson(row.output_json, 'output'), row.kind);
  const error = validatedError(readJson(row.error_json ?? 'null', 'error'));
  const input = validatedInput(readJson(row.input_json, 'input'));
  const config = validatedConfig(readJson(row.config_json, 'config'), row.kind);
  const usage = validatedUsage(readJson(row.usage_json, 'usage'));
  const cleanup = validatedCleanup(readJson(row.cleanup_json, 'cleanup'));
  const base = {
    runId: row.id,
    currentContextSnapshotId: context.pointer,
    status: row.status,
    input,
    config,
    output,
    usage,
    tokens: {
      inputTokens: row.input_tokens,
      outputTokens: row.output_tokens,
      totalTokens: row.total_tokens,
      cost: row.cost,
      usageComplete: row.usage_complete === 1,
    },
    durationMs: row.duration_ms,
    toolCallCount: row.tool_call_count,
    error,
    cleanup,
    createdAt: row.created_at,
    startedAt: row.started_at,
    endedAt: row.ended_at,
    cancelRequestedAt: row.cancel_requested_at,
    stoppedAt: row.stopped_at,
  };
  if (row.kind === 'provider') {
    if (row.session_id !== null || row.scope_json !== null || (row.job_id !== null && row.job_id !== undefined)) throw new Error('invalid_provider_session_reference');
    return { ...base, jobId: null, kind: 'provider', sessionId: null, scope: null };
  }
  if (!Number.isSafeInteger(row.session_id) || Number(row.session_id) <= 0 || row.scope_json === null) {
    throw new Error('invalid_agent_session_reference');
  }
  return {
    ...base,
    jobId: row.job_id ?? null,
    kind: 'agent',
    sessionId: Number(row.session_id),
    scope: validatedScope(readJson(row.scope_json, 'scope')),
  };
}

const usageKeys: readonly (keyof SdkUsageValues)[] = [
  'input', 'output', 'cacheRead', 'cacheWrite', 'totalTokens',
  'costInput', 'costOutput', 'costCacheRead', 'costCacheWrite', 'costTotal',
];

function tokenConflicts(current: TokenColumns, incoming: TokenColumns): boolean {
  return (['inputTokens', 'outputTokens', 'totalTokens', 'cost'] as const)
    .some(key => current[key] !== null && incoming[key] !== null && current[key] !== incoming[key]);
}
function usageConflicts(current: UsageRecord, incoming: UsageRecord): boolean {
  if ((current.attemptsComplete || incoming.attemptsComplete) && current.attempts !== null && incoming.attempts !== null
    && current.attempts !== incoming.attempts) return true;
  if (usageKeys.some(key => current.sdkValues?.[key] != null && incoming.sdkValues?.[key] != null
    && current.sdkValues[key] !== incoming.sdkValues[key])) return true;
  if (current.version !== 2 || incoming.version !== 2) return false;
  return current.calls.some(call => {
    const next = incoming.calls.find(value => value.callSequence === call.callSequence);
    return next !== undefined && (usageConflicts(call.usage, next.usage) || tokenConflicts(call.tokens, next.tokens));
  });
}
function usageFacts(usage: UsageRecord): unknown {
  const { updatedAt: _updatedAt, ...facts } = usage;
  return usage.version === 2 ? { ...facts, calls: usage.calls.map(call => ({ ...call, usage: usageFacts(call.usage) })) } : facts;
}

function mergeUsage(current: UsageRecordV1, incoming: UsageRecordV1): UsageRecordV1;
function mergeUsage(current: UsageRecord, incoming: UsageRecord): UsageRecord;
function mergeUsage(current: UsageRecord, incoming: UsageRecord): UsageRecord {
  const currentValues = current.sdkValues;
  const incomingValues = incoming.sdkValues;
  const mergedValues = currentValues !== null || incomingValues !== null
    ? usageKeys.reduce<SdkUsageValues>((result, key) => {
      result[key] = currentValues?.[key] ?? incomingValues?.[key] ?? null;
      return result;
    }, {
      input: null, output: null, cacheRead: null, cacheWrite: null, totalTokens: null,
      costInput: null, costOutput: null, costCacheRead: null, costCacheWrite: null, costTotal: null,
    })
    : null;
  const source = current.source === 'sdk' || incoming.source === 'sdk' ? 'sdk' : current.source;
  const merged: UsageRecordV1 = {
    version: 1,
    source,
    reason: current.source === 'sdk' ? current.reason
      : incoming.source === 'sdk' ? incoming.reason : incoming.reason ?? current.reason,
    sdkValues: mergedValues,
    attempts: current.attempts ?? incoming.attempts,
    attemptsComplete: current.attemptsComplete || incoming.attemptsComplete,
    costSource: current.costSource ?? incoming.costSource,
    updatedAt: incoming.updatedAt,
  };
  if (current.version === 1 && incoming.version === 1) return merged;
  const calls = new Map<number, UsageRecordV2['calls'][number]>();
  for (const record of [current, incoming]) {
    if (record.version !== 2) continue;
    for (const call of record.calls) {
      const previous = calls.get(call.callSequence);
      calls.set(call.callSequence, previous ? {
        callSequence: call.callSequence,
        usage: mergeUsage(previous.usage, call.usage),
        tokens: {
          inputTokens: previous.tokens.inputTokens ?? call.tokens.inputTokens,
          outputTokens: previous.tokens.outputTokens ?? call.tokens.outputTokens,
          totalTokens: previous.tokens.totalTokens ?? call.tokens.totalTokens,
          cost: previous.tokens.cost ?? call.tokens.cost,
          usageComplete: previous.tokens.usageComplete || call.tokens.usageComplete,
        },
      } : call);
    }
  }
  return UsageRecordV2Schema.parse({ ...merged, version: 2,
    calls: [...calls.values()].sort((a, b) => a.callSequence - b.callSequence) });
}

function transaction<T>(db: Database, fn: () => T, events?: RuntimeEventStore): Result<T> {
  try {
    return ok(events ? events.withTransaction(fn) : db.transaction(fn).immediate());
  } catch (error) {
    if (isBusyConstraint(error)) {
      return fail(appError('runtime_busy', 'runtime', '已有 Provider Run 正在执行。'));
    }
    return fail(databaseError());
  }
}

function hasBusinessHistory(db: Database, sessionId: DbId): boolean {
  return db.query(`SELECT 1 AS present WHERE
    EXISTS (SELECT 1 FROM runs WHERE session_id=? AND job_id IS NOT NULL)
    OR EXISTS (SELECT 1 FROM tool_calls WHERE session_id=?)
    OR EXISTS (SELECT 1 FROM business_events event JOIN runs run ON run.id=event.run_id WHERE run.session_id=?)
    OR EXISTS (SELECT 1 FROM invoice_candidates candidate JOIN runs run ON run.id=candidate.run_id WHERE run.session_id=?)`)
    .get(sessionId, sessionId, sessionId, sessionId) !== null;
}

function readSessionRow(db: Database, value: unknown): SessionRow {
  const row = sessionRow(value);
  let historyState: SessionHistoryState = 'legacy-read-only';
  let nativeUnusable = false;
  try {
    const history = readNativeHistory(db, row.sessionId);
    if (history) { historyState = 'recoverable'; nativeUnusable = history.unusable; }
  } catch { historyState = 'invalid'; }
  return { ...row, hasBusinessHistory: hasBusinessHistory(db, row.sessionId), historyState, nativeUnusable };
}

function readNativeHistory(db: Database, sessionId: DbId): NativeSessionHistory | null {
  const row = db.query('SELECT storage_version,header_json,leaf_id,entry_count,unusable FROM session_native_history WHERE session_id=?')
    .get(sessionId) as { storage_version: number; header_json: string; leaf_id: string | null; entry_count: number; unusable: number } | null;
  if (!row) return null;
  const header = JSON.parse(row.header_json) as NativeSessionHistory['header'];
  const stored = db.query(`SELECT entry.sequence,entry.entry_id,entry.entry_json,entry.run_id,
      run.kind AS run_kind,run.session_id AS run_session_id
    FROM session_native_entries entry LEFT JOIN runs run ON run.id=entry.run_id
    WHERE entry.session_id=? ORDER BY entry.sequence`)
    .all(sessionId) as Array<{ sequence: number; entry_id: string; entry_json: string; run_id: number | null; run_kind: string | null; run_session_id: number | null }>;
  if (row.storage_version !== 1 || row.unusable !== 0 && row.unusable !== 1 || !Number.isSafeInteger(row.entry_count)
    || stored.length !== row.entry_count || header?.type !== 'session' || header.id !== (db.query('SELECT native_session_id FROM sessions WHERE id=?').get(sessionId) as { native_session_id: string } | null)?.native_session_id
    || header.version !== 3 || typeof header.timestamp !== 'string' || typeof header.cwd !== 'string') throw new Error('invalid_native_header');
  const ids = new Set<string>();
  const entries = stored.map((item, index) => {
    const entry = JSON.parse(item.entry_json) as NativeSessionHistory['entries'][number];
    if (item.sequence !== index || !entry || typeof entry !== 'object' || entry.id !== item.entry_id
      || typeof entry.id !== 'string' || ids.has(entry.id) || typeof entry.type !== 'string'
      || typeof entry.timestamp !== 'string' || entry.parentId !== null && !ids.has(entry.parentId)
      || item.run_id !== null && (!Number.isSafeInteger(item.run_id) || item.run_id <= 0 || item.run_kind !== 'agent'
        || item.run_session_id !== sessionId || entry.type !== 'message')) throw new Error('invalid_native_entry');
    ids.add(entry.id);
    return entry;
  });
  if (row.leaf_id !== null && !ids.has(row.leaf_id) || row.leaf_id === null && entries.length > 0) throw new Error('invalid_native_leaf');
  return { storageVersion: 1, header, entries, leafId: row.leaf_id, unusable: row.unusable === 1 };
}

function writeNativeHistory(db: Database, sessionId: DbId, history: NativeSessionHistory, context?: NativeHistoryAppendContext,
  events?: RuntimeEventStore): void {
  const session = db.query('SELECT native_session_id FROM sessions WHERE id=?').get(sessionId) as { native_session_id: string } | null;
  if (!session || history.storageVersion !== 1 || history.header.type !== 'session'
    || history.header.version !== 3 || history.header.id !== session.native_session_id
    || typeof history.header.timestamp !== 'string' || typeof history.header.cwd !== 'string' || typeof history.unusable !== 'boolean'
    || history.leafId === null && history.entries.length > 0
    || history.leafId !== null && !history.entries.some((entry) => entry.id === history.leafId)) throw new Error('invalid_native_history');
  const previous = db.query('SELECT header_json,entry_count,unusable FROM session_native_history WHERE session_id=?')
    .get(sessionId) as { header_json: string; entry_count: number; unusable: number } | null;
  const headerJson = JSON.stringify(history.header);
  if (!previous) {
    db.query('INSERT INTO session_native_history(session_id,storage_version,header_json,leaf_id,entry_count,unusable) VALUES (?,1,?,?,0,?)')
      .run(sessionId, headerJson, null, history.unusable ? 1 : 0);
  } else if (previous.header_json !== headerJson || previous.entry_count > history.entries.length) {
    throw new Error('native_history_rewrite');
  }
  const existing = db.query('SELECT sequence,entry_id,entry_json,run_id FROM session_native_entries WHERE session_id=? ORDER BY sequence')
    .all(sessionId) as Array<{ sequence: number; entry_id: string; entry_json: string; run_id: number | null }>;
  if (existing.length !== (previous?.entry_count ?? 0)
    || existing.some((row, index) => row.sequence !== index || row.entry_json !== JSON.stringify(history.entries[index]))) {
    throw new Error('native_history_diverged');
  }
  if (context !== undefined) {
    const binding = recordWithOptional(context, 'native_entry_run_binding', ['entryId', 'runId'], ['inputId', 'resultInputIds']);
    const index = history.entries.findIndex((entry) => entry.id === binding.entryId);
    const run = db.query('SELECT kind,session_id FROM runs WHERE id=?').get(context.runId) as { kind: string; session_id: number | null } | null;
    if (typeof binding.entryId !== 'string' || !Number.isSafeInteger(binding.runId) || Number(binding.runId) <= 0
      || index < 0 || history.entries[index]?.type !== 'message' || run?.kind !== 'agent' || run.session_id !== sessionId
      || index < existing.length && existing[index]?.run_id !== binding.runId) throw new Error('invalid_native_entry_run_binding');
  }
  for (let index = existing.length; index < history.entries.length; index += 1) {
    const entry = history.entries[index]!;
    if (!entry.id || typeof entry.id !== 'string' || typeof entry.timestamp !== 'string'
      || typeof entry.type !== 'string' || entry.parentId !== null && !history.entries.slice(0, index).some((parent) => parent.id === entry.parentId)) throw new Error('invalid_native_entry');
    db.query('INSERT INTO session_native_entries(session_id,sequence,entry_id,entry_json,run_id) VALUES (?,?,?,?,?)')
      .run(sessionId, index, entry.id, JSON.stringify(entry), context?.entryId === entry.id ? context.runId : null);
  }
  if (context !== undefined && hasTable(db, 'session_inputs')) {
    const entry = history.entries.find((candidate) => candidate.id === context.entryId)!;
    const message = entry.message as { role?: unknown } | undefined;
    if (context.inputId !== undefined) {
      if (!Number.isSafeInteger(context.inputId) || context.inputId <= 0 || message?.role !== 'user' || context.resultInputIds !== undefined)
        throw new Error('input_consumption_identity_invalid');
      markInputConsumed(db, context.inputId, context.runId, entry.id, entry.timestamp, events);
    } else if (message?.role === 'user'
      && db.query('SELECT id FROM session_inputs WHERE run_id=? LIMIT 1').get(context.runId)) throw new Error('input_consumption_identity_missing');
    if (context.resultInputIds !== undefined) associateInputResult(db, context.runId, context.resultInputIds, entry.id, entry.timestamp, events);
  }
  db.query('UPDATE session_native_history SET leaf_id=?,entry_count=?,unusable=? WHERE session_id=?')
    .run(history.leafId, history.entries.length, previous?.unusable || history.unusable ? 1 : 0, sessionId);
}

function hasTable(db: Database, table: string): boolean {
  return db.query("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(table) !== null;
}

export function createSessionRepository(db: Database, events?: RuntimeEventStore): SessionRepository {
  const writeTransaction = <T>(fn: () => T) => transaction(db, fn, events);
  return {
    create(input) {
      const created = writeTransaction(() => {
        if (input.expectedRevision !== undefined) {
          const workspace = ensureWorkspace(db, input.at) as { revision: number };
          if (workspace.revision !== input.expectedRevision || !revisionCanAdvance(workspace.revision)) return null;
        }
        const result = db.query('INSERT INTO sessions(native_session_id,title,created_at,updated_at,metadata_json) VALUES (?,?,?,?,?)')
          .run(input.nativeSessionId, input.title, input.at, input.at, asJson({ version: 1, model_use_blocked: null }));
        const id = Number(result.lastInsertRowid);
        if (!Number.isSafeInteger(id) || id <= 0) throw new Error('unsafe_session_id');
        if (input.nativeHistory) writeNativeHistory(db, id, input.nativeHistory, undefined, events);
        if (input.expectedRevision !== undefined) {
          const changed = db.query(`UPDATE workspace SET active_session_id=?,revision=revision+1,updated_at=?
            WHERE id=1 AND revision=?`).run(id, input.at, input.expectedRevision).changes;
          if (changed !== 1) throw new Error('workspace_revision_raced');
        }
        return readSessionRow(db, db.query('SELECT * FROM sessions WHERE id=?').get(id));
      });
      if (!created.ok) return created;
      return created.data === null
        ? fail(appError('state_conflict', 'input', 'Workspace 已变化，请重新读取。', true))
        : ok(created.data);
    },

    get(sessionId) {
      try {
        const row = db.query('SELECT * FROM sessions WHERE id=?').get(sessionId);
        if (!row) return fail(appError('session_not_found', 'session', 'Session 不存在。'));
        return ok(readSessionRow(db, row));
      } catch {
        return fail(appError('storage_corrupt', 'storage', 'Session 事实无法读取。'));
      }
    },

    loadHistory(sessionId) {
      try { return ok(readNativeHistory(db, sessionId)); }
      catch { return fail(appError('session_history_invalid', 'session', 'Saved conversation history is invalid. Start a new chat.')); }
    },

    readHistoryForDisplay(sessionId) {
      try {
        return ok(db.transaction(() => {
          const history = readNativeHistory(db, sessionId);
          const bindings = db.query('SELECT entry_id,run_id FROM session_native_entries WHERE session_id=? AND run_id IS NOT NULL ORDER BY sequence')
            .all(sessionId) as Array<{ entry_id: string; run_id: number }>;
          const rows = db.query('SELECT id,run_id,native_entry_id,content_json FROM session_inputs WHERE session_id=? AND native_entry_id IS NOT NULL ORDER BY id')
            .all(sessionId) as { id: number; run_id: number; native_entry_id: string; content_json: string }[];
          return { history, bindings: bindings.map((entry) => ({ entryId: entry.entry_id, runId: entry.run_id })),
            sessionInputs: rows.map(row => ({ inputId: row.id, runId: row.run_id, nativeEntryId: row.native_entry_id,
              content: JSON.parse(row.content_json) })) };
        }).deferred());
      } catch { return fail(appError('session_history_invalid', 'session', 'Saved conversation history is invalid. Start a new chat.')); }
    },

    saveHistory(sessionId, history, context) {
      const saved = writeTransaction(() => writeNativeHistory(db, sessionId, history, context, events));
      return saved.ok ? ok(undefined) : fail(appError('storage_write_failed', 'storage', 'Conversation history could not be saved.', true));
    },

    list(request) {
      try {
        const rows = request.before
          ? db.query(`SELECT * FROM sessions
              WHERE hidden_at IS NULL AND (updated_at < ? OR (updated_at = ? AND id < ?))
              ORDER BY updated_at DESC,id DESC LIMIT ?`)
            .all(request.before.updatedAt, request.before.updatedAt, request.before.sessionId, request.limit + 1)
          : db.query('SELECT * FROM sessions WHERE hidden_at IS NULL ORDER BY updated_at DESC,id DESC LIMIT ?').all(request.limit + 1);
        const mapped = (rows as unknown[]).map((row) => readSessionRow(db, row));
        const hasMore = mapped.length > request.limit;
        const items = hasMore ? mapped.slice(0, request.limit) : mapped;
        const last = items.at(-1);
        return ok({
          items,
          next: hasMore && last ? { updatedAt: last.updatedAt, sessionId: last.sessionId } : null,
        });
      } catch {
        return fail(appError('storage_corrupt', 'storage', 'Session 列表无法读取。'));
      }
    },

    rename(input) {
      const result = writeTransaction(() => {
        const changed = db.query('UPDATE sessions SET title=?,updated_at=? WHERE id=?')
          .run(input.title, input.at, input.sessionId).changes;
        return changed === 1
          ? ok(readSessionRow(db, db.query('SELECT * FROM sessions WHERE id=?').get(input.sessionId)))
          : fail(appError('session_not_found', 'session', 'Session 不存在。'));
      });
      return result.ok ? result.data : result;
    },

    isModelUseBlocked(sessionId) {
      try {
        const row = db.query('SELECT metadata_json FROM sessions WHERE id=?').get(sessionId) as { metadata_json: string } | null;
        if (!row) return fail(appError('session_not_found', 'session', 'Session 不存在。'));
        return ok(parseSessionModelUse(row.metadata_json) !== null);
      } catch { return fail(appError('storage_corrupt', 'storage', 'Session 使用权限无法读取。', true)); }
    },

    revokeDocumentUse(input) {
      const revoked = writeTransaction(() => {
        if (!db.query('SELECT id FROM documents WHERE id=?').get(input.documentId)) {
          return { ok: false as const, error: appError('document_not_found', 'input', '正式材料不存在。') };
        }
        return { ok: true as const, data: { affectedSessionIds: blockSessionsUsingDocument(db, input.documentId, input.at) } };
      });
      return revoked.ok ? revoked.data : revoked;
    },

    prepareDelete(sessionId, at) {
      const prepared = writeTransaction(() => {
        const row = db.query('SELECT * FROM sessions WHERE id=?').get(sessionId);
        if (!row) return fail(appError('session_not_found', 'session', 'Session 不存在。'));
        if (db.query("SELECT id FROM runs WHERE kind='agent' AND session_id=? AND status IN ('created','running') LIMIT 1").get(sessionId)) {
          return fail(appError('session_busy', 'session', 'An Agent Run is active in this Session. Wait for it to finish before deleting this Session.', true));
        }
        const metadata = parseSessionMetadata((row as { metadata_json: string }).metadata_json);
        db.query("UPDATE sessions SET status='archived',metadata_json=?,updated_at=? WHERE id=?")
          .run(asJson({ ...metadata, delete_pending: true }), at, sessionId);
        return ok(readSessionRow(db, db.query('SELECT * FROM sessions WHERE id=?').get(sessionId)));
      });
      return prepared.ok ? prepared.data : prepared;
    },

    setStatus(input) {
      const changed = writeTransaction(() => {
        const raw = db.query('SELECT * FROM sessions WHERE id=?').get(input.sessionId) as { hidden_at: string | null } | null;
        if (!raw || raw.hidden_at !== null) return fail(appError('session_not_found', 'session', 'Session does not exist.'));
        const row = readSessionRow(db, raw);
        if (row.deletePending) return fail(appError('session_delete_incomplete', 'session', 'Retry Delete to finish removing this Session.', true));
        if (db.query("SELECT id FROM runs WHERE session_id=? AND kind='agent' AND status IN ('created','running') LIMIT 1").get(input.sessionId))
          return fail(appError('session_busy', 'session', 'This Session has an active Run.', true));
        if (row.status === input.status) return ok(row);
        if (row.status !== input.expectedStatus) return fail(appError('state_conflict', 'session', 'Session status has changed.', true));
        if (input.status === 'archived' && !activeWorkspaceCanAdvance(db, 'active_session_id', input.sessionId))
          return fail(appError('state_conflict', 'input', 'Workspace revision 已到上限。'));
        db.query('UPDATE sessions SET status=?,updated_at=? WHERE id=?').run(input.status, input.at, input.sessionId);
        if (input.status === 'archived') db.query('UPDATE workspace SET active_session_id=NULL,revision=revision+1,updated_at=? WHERE id=1 AND active_session_id=?')
          .run(input.at, input.sessionId);
        return ok(readSessionRow(db, db.query('SELECT * FROM sessions WHERE id=?').get(input.sessionId)));
      });
      return changed.ok ? changed.data : changed;
    },

    delete(sessionId, at) {
      const deleted = writeTransaction(() => {
        const row = db.query('SELECT status,hidden_at,metadata_json FROM sessions WHERE id=?').get(sessionId) as { status: string; hidden_at: string | null; metadata_json: string } | null;
        if (!row) return fail(appError('session_not_found', 'session', 'Session 不存在。'));
        if (row.status !== 'archived') {
          return fail(appError('session_delete_not_prepared', 'session', 'Session deletion has not been prepared.'));
        }
        if (db.query("SELECT id FROM runs WHERE kind='agent' AND session_id=? AND status IN ('created','running') LIMIT 1").get(sessionId)) {
          return fail(appError('session_busy', 'session', 'An Agent Run is active in this Session. Wait for it to finish before deleting this Session.', true));
        }
        const metadata = parseSessionMetadata(row.metadata_json);
        const { delete_pending: _pending, ...completedMetadata } = metadata;
        if (row.hidden_at !== null) {
          db.query('UPDATE sessions SET metadata_json=? WHERE id=?').run(asJson(completedMetadata), sessionId);
          return ok('hidden' as const);
        }
        if (!activeWorkspaceCanAdvance(db, 'active_session_id', sessionId)) return fail(appError('state_conflict', 'input', 'Workspace revision 已到上限。'));
        db.query('UPDATE workspace SET active_session_id=NULL,revision=revision+1,updated_at=? WHERE id=1 AND active_session_id=?')
          .run(at, sessionId);
        if (hasBusinessHistory(db, sessionId)) {
          db.query('UPDATE sessions SET hidden_at=?,metadata_json=?,updated_at=? WHERE id=?').run(at, asJson(completedMetadata), at, sessionId);
          return ok('hidden' as const);
        }
        db.query("UPDATE runs SET current_context_snapshot_id=NULL WHERE kind='agent' AND session_id=?").run(sessionId);
        db.query('UPDATE session_inputs SET context_snapshot_id=NULL WHERE session_id=?').run(sessionId);
        db.query('DELETE FROM context_snapshots WHERE session_id=?').run(sessionId);
        db.query('DELETE FROM session_inputs WHERE session_id=?').run(sessionId);
        db.query("DELETE FROM runs WHERE kind='agent' AND session_id=?").run(sessionId);
        // Bun counts rows removed by the native-history cascades too.
        if (db.query('DELETE FROM sessions WHERE id=?').run(sessionId).changes < 1) {
          throw new Error('session_delete_missing');
        }
        return ok('permanent' as const);
      });
      return deleted.ok ? deleted.data : deleted;
    },
  };
}

function freezeWorkspaceInput(db: Database, input: Pick<NewWorkspaceAgentRun, 'sessionId' | 'expected' | 'goalMode' | 'createdAt'>, verify: WorkspaceVerifier | undefined) {
  if (typeof verify !== 'function') return fail(appError('workspace_unavailable', 'storage', 'Workspace verifier is unavailable.', true));
  const expected = WorkspaceExpectationSchema.safeParse(input.expected);
  if (!expected.success) return fail(appError('input_invalid', 'input', 'Workspace expectation is invalid.'));
  const fill = input.goalMode === 'fill-form';
        const rawWorkspace = ensureWorkspace(db, input.createdAt);
        let workspace: WorkspaceSnapshot;
        try { workspace = workspaceSnapshot(db, rawWorkspace, input.createdAt); workspaceCandidate(db, workspace); }
        catch (error) { return workspaceReadFailure<never>(error); }
        const actualExpectation: WorkspaceExpectation = {
          revision: workspace.revision, documentRef: workspace.documentRef, jobId: workspace.jobId,
          candidateRef: workspace.candidateRef, sessionId: workspace.sessionId ?? 0,
        };
        const sameDocument = actualExpectation.documentRef?.id === expected.data.documentRef?.id
          && actualExpectation.documentRef?.version === expected.data.documentRef?.version;
        const sameCandidate = actualExpectation.candidateRef?.id === expected.data.candidateRef?.id
          && actualExpectation.candidateRef?.sequence === expected.data.candidateRef?.sequence;
        if (actualExpectation.revision !== expected.data.revision
          || actualExpectation.jobId !== expected.data.jobId || actualExpectation.sessionId !== expected.data.sessionId
          || !sameDocument || !sameCandidate) {
          return fail(appError('state_conflict', 'input', 'Workspace 或其引用已变化，请重新确认。', true));
        }
        if (input.expected.sessionId !== input.sessionId) return fail(appError('state_conflict', 'input', '当前 Session 与请求不一致。', true));

        let document: { id: number; version: string; status: string; hidden_at: string | null; original_artifact_id: number; parsed_artifact_id: number } | null = null;
        if (input.expected.documentRef !== null) {
          type DocumentRow = { id: number; version: string; status: string; hidden_at: string | null; original_artifact_id: number; parsed_artifact_id: number };
          document = db.query('SELECT id,version,status,hidden_at,original_artifact_id,parsed_artifact_id FROM documents WHERE id=?')
            .get(input.expected.documentRef.id) as DocumentRow | null;
          if (!document || document.version !== input.expected.documentRef.version) {
            return fail(appError('document_not_found', 'input', 'Document 版本不存在。'));
          }
          if (document.status !== 'available' || document.hidden_at !== null) return fail(appError('input_unavailable', 'input', 'Invoice is no longer available for processing.', true));
        }
        const job = input.expected.jobId === null ? null : readJob(db, input.expected.jobId);
        if ((input.expected.jobId !== null && !job) || (job && (!document || job.documentRef.id !== document.id
          || job.documentRef.version !== document.version))) {
          return fail(appError('state_conflict', 'input', 'Job 与当前 Document 不匹配。'));
        }
        if ((input.goalMode === 'save-candidate' || fill) && (!job || !document)) {
          return fail(appError('state_conflict', 'input', '保存候选需要当前 Document 和 Job。'));
        }
        if (job?.status === 'completed') return fail(appError('job_completed', 'input', '已完成 Job 不能继续运行。'));

        let candidate: WorkspaceInput['candidate'] = null;
        if (job?.currentCandidateId !== null && job?.currentCandidateId !== undefined) {
          const row = queryCandidateRow(db, job.currentCandidateId, job.jobId);
          if (!row) return fail(appError('state_conflict', 'input', '当前候选引用无效。'));
          const saved = candidateSnapshot(db, row).snapshot;
          if (fill && (saved.status !== 'generated' || saved.candidateId !== expected.data.candidateRef?.id
            || saved.sequence !== expected.data.candidateRef.sequence)) {
            return fail(appError('state_conflict', 'input', '填表需要当前 generated 候选的真实版本。'));
          }
          candidate = {
            id: saved.candidateId, sequence: saved.sequence,
            fields: saved.fields, lines: saved.lines, issues: saved.issues,
          };
        }
        if (fill && candidate === null) return fail(appError('state_conflict', 'input', '填表需要已选候选。'));
        const verified = verifyWorkspaceSnapshot(db, workspace, verify);
        if (!verified.ok) return verified;
        const valid = requireValidWorkspace(verified.data);
        if (!valid.ok) return valid;
        const workspaceContext = WorkspaceContextSchema.parse({
          formatVersion: 1, revision: workspace.revision, documentRef: workspace.documentRef, jobId: workspace.jobId,
          candidateRef: workspace.candidateRef, sessionId: input.sessionId, activeView: workspace.activeView, selection: workspace.selection,
        });
        const workspaceInput = WorkspaceInputSchema.parse({
          documentRef: workspace.documentRef,
          job: job ? { id: job.jobId, goal: job.goal } : null,
          candidate,
        });
        if (Buffer.byteLength(JSON.stringify({ workspaceContext, workspaceInput }), 'utf8') > 512 * 1024) {
          return fail(appError('input_too_large', 'input', '冻结 Workspace 输入超过 512 KiB。'));
        }
  return ok({ document, job, workspaceContext, workspaceInput });
}

function appendRunState(db: Database, events: RuntimeEventStore | undefined, runId: DbId,
  type: 'run_created' | 'run_started' | 'run_completed' | 'run_failed' | 'run_cancelled', origin: 'live' | 'recovery' = 'live'): void {
  if (!events) return;
  const row = db.query('SELECT * FROM runs WHERE id=?').get(runId) as RunRow | null;
  if (!row) throw new Error('event_run_missing');
  const cleanup = object(readJson(row.cleanup_json, 'cleanup'), 'cleanup');
  const error = row.error_json === null ? null : object(readJson(row.error_json, 'error'), 'error');
  events.appendInTransaction({ runId, sessionId: row.session_id, toolCallId: null, type,
    occurredAt: (type === 'run_created' ? row.created_at : type === 'run_started' ? row.started_at : row.ended_at)!,
    dedupeKey: type === 'run_created' ? 'run:created' : type === 'run_started' ? 'run:started' : 'run:terminal',
    payload: { version: 1, status: row.status, origin, stopped: typeof cleanup.stopped === 'boolean' ? cleanup.stopped : null,
      errorCode: typeof error?.code === 'string' ? error.code : null } });
}

export function createRunRepository(db: Database, events?: RuntimeEventStore): RunRepository {
  const writeTransaction = <T>(fn: () => T) => transaction(db, fn, events);
  return {
    create(input) {
      const result = writeTransaction(() => {
        const inserted = db
          .query(
            `INSERT INTO runs
              (kind,session_id,scope_json,status,goal,input_json,config_json,cleanup_json,usage_json,created_at)
             VALUES ('provider',NULL,NULL,'created',?,?,?,?,?,?)`,
          )
          .run(input.goal, asJson(input.input), asJson(input.config), asJson(input.cleanup), asJson(input.usage), input.createdAt);
        const id = Number(inserted.lastInsertRowid);
        if (!Number.isSafeInteger(id)) throw new Error('unsafe_run_id');
        appendRunState(db, events, id, 'run_created');
        return id;
      });
      return result;
    },

    createAgent(input) {
      const created = writeTransaction(() => {
        const session = db.query('SELECT status,metadata_json,native_session_id FROM sessions WHERE id=?').get(input.sessionId) as { status: string; metadata_json: string; native_session_id: string } | null;
        if (!session) return fail(appError('session_not_found', 'session', 'Session 不存在。'));
        if (parseSessionMetadata(session.metadata_json).delete_pending === true) return fail(appError('session_delete_incomplete', 'session', 'Session deletion is incomplete.', true));
        if (session.status !== 'active') return fail(appError('session_archived', 'session', '归档 Session 不能继续执行。'));
        const config = validatedConfig(input.config, 'agent');
        const scope = validatedScope(input.scope);
        if (scope.version === 3 || config.goalMode === 'local-task') return fail(appError('input_invalid', 'input', 'Legacy native Run formats are read only.'));
        if (parseSessionModelUse(session.metadata_json)) return fail(appError('session_scope_revoked', 'session', 'Conversation material access has been revoked.'));
        if (readNativeHistory(db, input.sessionId)?.unusable) return fail(appError('agent_session_unusable', 'session', 'Conversation history is unusable.'));
        const inserted = db.query(`INSERT INTO runs
          (kind,session_id,scope_json,status,goal,input_json,config_json,cleanup_json,usage_json,created_at)
          VALUES ('agent',?,?,'created',?,?,?,?,?,?)`)
          .run(input.sessionId, asJson(input.scope), input.goal, asJson(input.input), asJson(input.config),
            asJson(input.cleanup), asJson(input.usage), input.createdAt);
        const id = Number(inserted.lastInsertRowid);
        if (!Number.isSafeInteger(id) || id <= 0) throw new Error('unsafe_run_id');
        appendRunState(db, events, id, 'run_created');
        db.query('UPDATE sessions SET updated_at=? WHERE id=?').run(input.createdAt, input.sessionId);
        return ok(id);
      });
      return created.ok ? created.data : created;
    },

    createWorkspaceAgent(input, verify) {
      if (typeof verify !== 'function') return fail(appError('workspace_unavailable', 'storage', 'Workspace verifier is unavailable.', true));
      const created = writeTransaction(() => {
        const expected = WorkspaceExpectationSchema.safeParse(input.expected);
        const target = input.formTarget === undefined ? null : InvoiceFormTargetSchema.safeParse(input.formTarget);
        const fill = input.goalMode === 'fill-form';
        if (!expected.success || input.sessionId !== input.expected.sessionId
          || !['answer', 'save-candidate', 'fill-form'].includes(input.goalMode)
          || (fill ? !target?.success : input.formTarget !== undefined)
          || !fill && 'formTarget' in input.config) {
          return fail(appError('input_invalid', 'input', 'P3 Workspace Run 参数无效。'));
        }
        const session = db.query('SELECT status,metadata_json FROM sessions WHERE id=? AND hidden_at IS NULL').get(input.sessionId) as { status: string; metadata_json: string } | null;
        if (!session || session.status !== 'active') return fail(appError('session_archived', 'session', 'Session 不可用于新 Run。'));
        if (parseSessionMetadata(session.metadata_json).delete_pending === true) return fail(appError('session_delete_incomplete', 'session', 'Session deletion is incomplete.', true));
        if (parseSessionModelUse(session.metadata_json)) return fail(appError('session_scope_revoked', 'session', 'Conversation material access has been revoked.'));
        if (readNativeHistory(db, input.sessionId)?.unusable) return fail(appError('agent_session_unusable', 'session', 'Conversation history is unusable.'));
        const frozen = freezeWorkspaceInput(db, input, verify);
        if (!frozen.ok) return frozen;
        const { document, job, workspaceContext, workspaceInput } = frozen.data;
        const allowedTools = fill ? ['fill_invoice_form'] : !document ? [INVOICE_REVIEW_TOOL_NAMES[6]!, INVOICE_REVIEW_TOOL_NAMES[7]!]
          : !job ? INVOICE_REVIEW_TOOL_NAMES.slice(0, 9)
            : input.goalMode === 'save-candidate' ? [...INVOICE_REVIEW_TOOL_NAMES] : INVOICE_REVIEW_TOOL_NAMES.slice(0, 12);
        const nativeNames = fill ? [] : input.nativeTools?.allowedTools ?? [];
        const scope = RunScopeSchema.parse({ version: 2, allowedTools: [...allowedTools, ...nativeNames],
          allowedDocumentIds: document ? [document.id] : [],
          allowedArtifactIds: document ? [document.parsed_artifact_id] : [],
          allowedResourcePaths: [],
        });
        const inputRecord = { version: 2, goal: input.goal, text: input.text, messageTimestamp: input.messageTimestamp, workspaceInput };
        let config: SafeConfigSnapshot & { agent: P3AgentConfigFacts | RuntimeAgentConfigFacts; goalMode: GoalMode; workspaceContext: WorkspaceContext; workingDirectory?: string; formTarget?: InvoiceFormTarget } = {
          ...input.config, goalMode: input.goalMode, workspaceContext,
          ...(fill && target?.success ? { formTarget: target.data } : {}),
        };
        const inserted = db.query(`INSERT INTO runs(kind,session_id,job_id,scope_json,status,goal,input_json,config_json,cleanup_json,usage_json,created_at)
          VALUES ('agent',?,?,?,?,?,?,?,?,?,?)`)
          .run(input.sessionId, job?.jobId ?? null, asJson(scope), 'created', input.goal, asJson(inputRecord), asJson(config),
            asJson(input.cleanup), asJson(input.usage), input.createdAt);
        const runId = Number(inserted.lastInsertRowid);
        if (!Number.isSafeInteger(runId) || runId <= 0) throw new Error('unsafe_run_id');
        appendRunState(db, events, runId, 'run_created');
        if (input.nativeTools && !fill) {
          const workingDirectory = input.nativeTools.workingDirectory ?? join(input.nativeTools.runtimeDir, String(runId), 'work');
          if (!isAbsolute(workingDirectory) || /[\x00-\x1f\x7f]/.test(workingDirectory)) throw new Error('invalid_native_runtime_directory');
          config = { ...config, workingDirectory };
          db.query('UPDATE runs SET config_json=? WHERE id=?').run(asJson(config), runId);
        }
        if (job) db.query("UPDATE jobs SET status='running',status_reason=NULL,updated_at=? WHERE id=? AND status!='completed'")
          .run(input.createdAt, job.jobId);
        db.query('UPDATE sessions SET updated_at=? WHERE id=?').run(input.createdAt, input.sessionId);
        return ok({ runId, jobId: job?.jobId ?? null, scope, workspaceContext, workspaceInput,
          ...(fill && target?.success ? { formTarget: target.data } : {}) });
      });
      return created.ok ? created.data : created;
    },

    freezeInput(input, verify) {
      try {
        const raw = db.query('SELECT * FROM runs WHERE id=?').get(input.runId) as RunRow | null;
        if (!raw || raw.kind !== 'agent' || raw.session_id !== input.sessionId || !['created', 'running'].includes(raw.status)
          || raw.cancel_requested_at !== null) return fail(appError('run_state_invalid', 'runtime', 'Input requires its active Run.'));
        const session = db.query('SELECT * FROM sessions WHERE id=? AND hidden_at IS NULL').get(input.sessionId);
        if (!session) return fail(appError('session_not_found', 'session', 'Session does not exist.'));
        const current = readSessionRow(db, session);
        if (current.deletePending) return fail(appError('session_delete_incomplete', 'session', 'Session deletion is incomplete.', true));
        if (current.status !== 'active') return fail(appError('session_archived', 'session', 'Session is archived.'));
        if (current.modelUseBlocked) return fail(appError('session_scope_revoked', 'session', 'Material access was revoked.'));
        if (current.nativeUnusable || current.historyState === 'invalid') return fail(appError('session_history_invalid', 'session', 'Saved history is unusable.'));
        const config = validatedConfig(readJson(raw.config_json, 'config'), 'agent');
        const scope = validatedScope(readJson(raw.scope_json!, 'scope'));
        const goalMode = config.goalMode ?? 'answer';
        if (goalMode === 'fill-form') return fail(appError('input_invalid', 'input', 'Fill does not accept active input.'));
        if (scope.version === 1) {
          const savedInput = validatedInput(readJson(raw.input_json, 'input'));
          if (input.expected !== undefined) return fail(appError('state_conflict', 'input', 'This Chat Run has no Workspace.'));
          if (config.workspaceContext != null || savedInput.version === 2 && savedInput.workspaceInput !== null)
            return fail(appError('storage_corrupt', 'storage', 'Chat Run contains persisted Workspace references.'));
          return ok({ runId: input.runId, content: { version: 2, text: input.text, workspaceContext: null,
            workspaceInput: null, allowedDocumentIds: [], allowedArtifactIds: [], promptText: input.text } });
        }
        if (typeof verify !== 'function') return fail(appError('workspace_unavailable', 'storage', 'Workspace verifier is unavailable.', true));
        if (scope.version !== 2 || input.expected === undefined || !config.workspaceContext)
          return fail(appError('state_conflict', 'input', 'This Run requires its compatible current Workspace.'));
        const original = WorkspaceContextSchema.parse(config.workspaceContext);
        const expected = input.expected;
        if (expected.documentRef?.id !== original.documentRef?.id || expected.documentRef?.version !== original.documentRef?.version
          || expected.jobId !== original.jobId || expected.candidateRef?.id !== original.candidateRef?.id
          || expected.candidateRef?.sequence !== original.candidateRef?.sequence)
          return fail(appError('state_conflict', 'input', 'Input Workspace differs from the Run admission.'));
        const frozen = freezeWorkspaceInput(db, { sessionId: input.sessionId, expected, goalMode: goalMode as GoalMode, createdAt: input.at }, verify);
        if (!frozen.ok) return frozen;
        const { document, workspaceContext, workspaceInput } = frozen.data;
        if (document && (!scope.allowedDocumentIds.includes(document.id) || !scope.allowedArtifactIds.includes(document.parsed_artifact_id)))
          return fail(appError('state_conflict', 'input', 'Input would expand the Run scope.'));
        return ok({ runId: input.runId, content: { version: 2, text: input.text, workspaceContext, workspaceInput,
          allowedDocumentIds: [...scope.allowedDocumentIds], allowedArtifactIds: [...scope.allowedArtifactIds],
          promptText: formatExecutionPrompt({ text: input.text, workspaceInput, workspaceContext, goalMode: goalMode as GoalMode, business: true,
            ...(typeof config.workingDirectory === 'string' ? { workingDirectory: config.workingDirectory } : {}) }) } });
      } catch { return fail(appError('storage_read_failed', 'storage', 'Input admission facts cannot be read.', true)); }
    },

    verifyInputUse(content, verify) {
      try {
        const frozen = content.workspaceContext;
        if (frozen === null) return content.workspaceInput === null && !content.allowedDocumentIds.length && !content.allowedArtifactIds.length
          ? ok(undefined) : fail(appError('storage_corrupt', 'storage', 'Chat input contains Workspace references.'));
        const business = WorkspaceInputSchema.safeParse(content.workspaceInput);
        if (!business.success || business.data.documentRef?.id !== frozen.documentRef?.id || business.data.documentRef?.version !== frozen.documentRef?.version
          || business.data.job?.id !== (frozen.jobId ?? undefined) || business.data.candidate?.id !== frozen.candidateRef?.id
          || business.data.candidate?.sequence !== frozen.candidateRef?.sequence
          || content.allowedDocumentIds.length !== (frozen.documentRef ? 1 : 0)
          || content.allowedArtifactIds.length !== (frozen.documentRef ? 1 : 0))
          return fail(appError('storage_corrupt', 'storage', 'Frozen Workspace projection is inconsistent.'));
        if (typeof verify !== 'function') return fail(appError('workspace_unavailable', 'storage', 'Workspace verifier is unavailable.', true));
        const documents = createDocumentRepository(db);
        if (frozen.documentRef !== null) {
          const document = documents.get(frozen.documentRef.id);
          if (!document.ok) return document;
          if (document.data.status !== 'available' || document.data.isHidden)
            return fail(appError('input_unavailable', 'input', 'Frozen input material is unavailable.', true));
          if (document.data.documentRef.version !== frozen.documentRef.version
            || !content.allowedDocumentIds.includes(frozen.documentRef.id)
            || !content.allowedArtifactIds.includes(document.data.parsedArtifactId))
            return fail(appError('state_conflict', 'input', 'Frozen input material references changed.'));
        }
        for (const id of content.allowedArtifactIds) {
          const artifact = documents.getArtifact(id);
          if (!artifact.ok) return artifact;
        }
        let candidate: WorkspaceInput['candidate'] = null;
        if (frozen.jobId !== null) {
          const job = readJob(db, frozen.jobId);
          const visibility = db.query('SELECT hidden_at FROM jobs WHERE id=?').get(frozen.jobId) as { hidden_at: string | null } | null;
          if (!job || job.documentRef.id !== frozen.documentRef?.id || job.documentRef.version !== frozen.documentRef.version
            || visibility?.hidden_at !== null)
            return fail(appError('state_conflict', 'input', 'Frozen input task references changed.'));
          if (job.status === 'completed') return fail(appError('job_completed', 'input', 'The input task has already completed.'));
          if (frozen.candidateRef !== null) {
            const row = queryCandidateRow(db, frozen.candidateRef.id, frozen.jobId);
            if (!row || candidateSnapshot(db, row).snapshot.sequence !== frozen.candidateRef.sequence)
              return fail(appError('state_conflict', 'input', 'Frozen input candidate references changed.'));
            candidate = workspaceCandidate(db, frozen);
          }
        }
        if (frozen.candidateRef !== null && frozen.jobId === null) return fail(appError('storage_corrupt', 'storage', 'Frozen candidate has no task.'));
        const verified = verify({ documentRef: frozen.documentRef, jobId: frozen.jobId, candidateRef: frozen.candidateRef,
          candidate, selection: frozen.selection });
        return verified.ok ? requireValidWorkspace(verified.data) : verified;
      } catch (error) { return workspaceReadFailure<void>(error); }
    },

    start(runId, config, startedAt) {
      try {
        const saved = writeTransaction(() => {
          const changed = db
            .query("UPDATE runs SET status='running', config_json=?, started_at=? WHERE id=? AND status='created'")
            .run(asJson(config), startedAt, runId).changes;
          if (changed === 1) appendRunState(db, events, runId, 'run_started');
          return changed === 1
            ? ok(undefined)
            : fail(appError('run_state_invalid', 'runtime', 'Run 不处于可启动状态。', false, runId));
        });
        return saved.ok ? saved.data : saved;
      } catch {
        return fail(databaseError(), runId);
      }
    },

    recordCancel(runId, requestedAt) {
      try {
        return writeTransaction(() => {
          const changed = db
            .query("UPDATE runs SET cancel_requested_at=? WHERE id=? AND status IN ('created','running') AND cancel_requested_at IS NULL")
            .run(requestedAt, runId).changes;
          const row = db.query("SELECT session_id,cancel_requested_at FROM runs WHERE id=? AND status IN ('created','running')")
            .get(runId) as { session_id: number | null; cancel_requested_at: string | null } | null;
          if (changed === 1) events?.appendInTransaction({ runId, sessionId: row!.session_id, toolCallId: null,
            type: 'run_cancel_requested', occurredAt: row!.cancel_requested_at!, dedupeKey: 'run:cancel-requested',
            payload: { version: 1, requestedAt: row!.cancel_requested_at! } });
          return row?.cancel_requested_at != null;
        });
      } catch {
        return fail(databaseError(), runId);
      }
    },

    finish(runId, terminal) {
      const result = writeTransaction(() => {
        const current = db.query('SELECT * FROM runs WHERE id=?').get(runId) as RunRow | null;
        if (terminal.nativeHistoryUnusable !== undefined && typeof terminal.nativeHistoryUnusable !== 'boolean'
          || terminal.nativeHistoryUnusable === true && current?.kind === 'provider') throw new Error('invalid_native_history_terminal');
        if (current && ['completed', 'failed', 'cancelled'].includes(current.status)) {
          if (terminal.nativeHistoryUnusable === true) {
            const history = db.query('SELECT unusable FROM session_native_history WHERE session_id=?')
              .get(current.session_id) as { unusable: number } | null;
            if (history?.unusable !== 1) return false;
          }
          // Usage may have advanced independently. A repeated terminal only reads its fixed core facts.
          return current.status === terminal.status
            && stableJson(readJson(current.output_json ?? 'null', 'output')) === stableJson(readJson(asJson(terminal.output), 'output'))
            && stableJson(readJson(current.error_json ?? 'null', 'error')) === stableJson(readJson(asJson(terminal.error === null ? null : { version: 1, ...terminal.error }), 'error'))
            && stableJson(readJson(current.cleanup_json, 'cleanup')) === stableJson(readJson(asJson(terminal.cleanup), 'cleanup'))
            && current.ended_at === terminal.endedAt && current.stopped_at === terminal.stoppedAt
            && current.duration_ms === terminal.durationMs
            && current.cancel_requested_at === (terminal.cancelRequestedAt ?? current.cancel_requested_at);
        }
        const active = current && ['created', 'running'].includes(current.status) ? current : null;
        const changed = db
          .query(
            `UPDATE runs SET
              status=?, output_json=?, error_json=?, cleanup_json=?, usage_json=?,
              input_tokens=?, output_tokens=?, total_tokens=?, cost=?, usage_complete=?,
              duration_ms=?, cancel_requested_at=COALESCE(cancel_requested_at,?), ended_at=?, stopped_at=?
             WHERE id=? AND (status='running' OR (status='created' AND ?!='completed'))`,
          )
          .run(
            terminal.status,
            terminal.output === null ? null : asJson(terminal.output),
            terminal.error === null ? null : asJson({ version: 1, ...terminal.error }),
            asJson(terminal.cleanup),
            asJson(terminal.usage),
            terminal.tokens.inputTokens,
            terminal.tokens.outputTokens,
            terminal.tokens.totalTokens,
            terminal.tokens.cost,
            terminal.tokens.usageComplete ? 1 : 0,
            terminal.durationMs,
            terminal.cancelRequestedAt ?? null,
            terminal.endedAt,
            terminal.stoppedAt,
            runId,
            terminal.status,
          ).changes;
        if (changed === 1) {
          if (active?.cancel_requested_at === null && terminal.cancelRequestedAt !== undefined) {
            events?.appendInTransaction({ runId, sessionId: active.session_id, toolCallId: null,
              type: 'run_cancel_requested', occurredAt: terminal.cancelRequestedAt, dedupeKey: 'run:cancel-requested',
              payload: { version: 1, requestedAt: terminal.cancelRequestedAt } });
          }
          appendRunState(db, events, runId,
            terminal.status === 'completed' ? 'run_completed' : terminal.status === 'failed' ? 'run_failed' : 'run_cancelled');
        }
        if (changed === 1 && active?.kind === 'agent' && active.session_id !== null) {
          if (terminal.nativeHistoryUnusable === true) db.query('UPDATE session_native_history SET unusable=1 WHERE session_id=?').run(active.session_id);
          db.query('UPDATE sessions SET updated_at=? WHERE id=?').run(terminal.endedAt, active.session_id);
        }
        if (changed === 1 && active?.kind === 'agent' && active.job_id != null) {
          const config = object(readJson(active.config_json, 'config'), 'config');
          const goalMode = config.goalMode === 'save-candidate' ? 'save-candidate' : config.goalMode === 'fill-form' ? 'fill-form' : 'answer';
          const needsInput = terminal.status === 'failed' && terminal.error?.code === 'agent_goal_not_met' && goalMode === 'save-candidate';
          const jobStatus = terminal.status === 'completed' || needsInput ? 'waiting'
            : terminal.status === 'cancelled' ? 'cancelled' : 'failed';
          const reason = needsInput ? 'needs_input'
            : terminal.status === 'completed' ? goalMode === 'save-candidate' ? 'review_candidate' : goalMode === 'fill-form' ? 'review_form' : 'review_answer'
              : terminal.error?.code ?? terminal.status;
          const jobChanged = db.query("UPDATE jobs SET status=?,status_reason=?,updated_at=? WHERE id=? AND status='running'")
            .run(jobStatus, reason, terminal.endedAt, active.job_id).changes;
          if (jobChanged !== 1) throw new Error('job_terminal_state_invalid');
        }
        if (changed === 1 && hasTable(db, 'session_inputs')) {
          for (const batch of terminal.inputResults ?? []) completeSessionInputs(db, runId, batch.inputIds, batch.resultEntryId, terminal.endedAt, events);
          finishSessionInputs(db, runId, terminal.status, terminal.error, terminal.endedAt, terminal.confirmedUnconsumedInputIds, events);
        }
        return changed === 1;
      });
      return result.ok ? result : { ...result, ...(result.error && runId !== undefined ? { runId } : {}) };
    },

    get(runId) {
      try {
        const row = db.query('SELECT * FROM runs WHERE id=?').get(runId) as RunRow | null;
        if (!row) return fail(appError('run_not_found', 'input', 'Run 不存在。', false, runId));
        return ok(snapshotFromRow(db, row));
      } catch {
        return fail(appError('storage_corrupt', 'storage', 'Run 事实无法读取。', false, runId));
      }
    },

    listBySession(request) {
      try {
        const session = db.query('SELECT id FROM sessions WHERE id=?').get(request.sessionId);
        if (!session) return fail(appError('session_not_found', 'session', 'Session 不存在。'));
        const rows = request.beforeRunId === undefined
          ? db.query("SELECT * FROM runs WHERE session_id=? AND kind='agent' ORDER BY id DESC LIMIT ?")
            .all(request.sessionId, request.limit + 1)
          : db.query("SELECT * FROM runs WHERE session_id=? AND kind='agent' AND id<? ORDER BY id DESC LIMIT ?")
            .all(request.sessionId, request.beforeRunId, request.limit + 1);
        const mapped = (rows as RunRow[]).map((row) => snapshotFromRow(db, row) as AgentRunSnapshot);
        const hasMore = mapped.length > request.limit;
        const items = hasMore ? mapped.slice(0, request.limit) : mapped;
        return ok({ items, nextBeforeRunId: hasMore ? items.at(-1)?.runId ?? null : null });
      } catch {
        return fail(appError('storage_corrupt', 'storage', 'Session Run 列表无法读取。'));
      }
    },

    supplementUsage(runId, usageValue, tokens) {
      const result = writeTransaction(() => {
        const row = db.query('SELECT session_id,usage_json,input_tokens,output_tokens,total_tokens,cost,usage_complete FROM runs WHERE id=? AND status IN (\'completed\',\'failed\',\'cancelled\')').get(runId) as {
          session_id: number | null; usage_json: string; input_tokens: number | null; output_tokens: number | null;
          total_tokens: number | null; cost: string | null; usage_complete: number } | null;
        if (!row) return false;
        const current = validatedUsage(readJson(row.usage_json, 'usage'));
        const currentTokens: TokenColumns = { inputTokens: row.input_tokens, outputTokens: row.output_tokens,
          totalTokens: row.total_tokens, cost: row.cost, usageComplete: row.usage_complete === 1 };
        if (usageConflicts(current, usageValue) || tokenConflicts(currentTokens, tokens)) return false;
        const merged = mergeUsage(current, usageValue);
        const mergedTokens: TokenColumns = { inputTokens: currentTokens.inputTokens ?? tokens.inputTokens,
          outputTokens: currentTokens.outputTokens ?? tokens.outputTokens, totalTokens: currentTokens.totalTokens ?? tokens.totalTokens,
          cost: currentTokens.cost ?? tokens.cost, usageComplete: currentTokens.usageComplete || tokens.usageComplete };
        if (stableJson({ usage: usageFacts(current), tokens: currentTokens })
          === stableJson({ usage: usageFacts(merged), tokens: mergedTokens })) {
          // A compatible replay is accepted, as before; it writes no new usage or event.
          return true;
        }
        const changed = db
          .query(
            `UPDATE runs SET
              usage_json=?,
              input_tokens=COALESCE(input_tokens,?),
              output_tokens=COALESCE(output_tokens,?),
              total_tokens=COALESCE(total_tokens,?),
              cost=COALESCE(cost,?),
              usage_complete=CASE WHEN usage_complete=1 THEN 1 ELSE ? END
             WHERE id=? AND status IN ('completed','failed','cancelled')`,
          )
          .run(
            asJson(merged), tokens.inputTokens, tokens.outputTokens, tokens.totalTokens,
            tokens.cost, tokens.usageComplete ? 1 : 0, runId,
          ).changes;
        if (changed === 1) events?.appendInTransaction({ runId, sessionId: row.session_id, toolCallId: null,
          type: 'run_usage_updated', occurredAt: merged.updatedAt, payload: { version: 1, tokens: mergedTokens,
            attempts: merged.attempts, attemptsComplete: merged.attemptsComplete, source: merged.source } });
        return changed === 1;
      });
      return result.ok ? result : { ...result, ...(result.error && runId !== undefined ? { runId } : {}) };
    },

    failInterrupted(endedAt) {
      try {
        const error = asJson({ version: 1, ...appError('runtime_interrupted', 'runtime', '上一次进程退出，Run 未收口。') });
        const cleanup = asJson({ version: 1, stopped: false, stopReason: 'process-exit', errors: [], lateObservationRequired: true });
        const recovered = writeTransaction(() => {
          const activeRuns = events ? db.query("SELECT id FROM runs WHERE status IN ('created','running') ORDER BY id").all() as { id: number }[] : [];
          const activeTools = events && hasTable(db, 'tool_calls')
            ? db.query("SELECT id FROM tool_calls WHERE status IN ('requested','running') ORDER BY id").all() as { id: number }[] : [];
          if (hasTable(db, 'session_native_history')) db.query(`UPDATE session_native_history SET unusable=1
            WHERE session_id IN (SELECT session_id FROM runs WHERE kind='agent' AND status IN ('created','running'))
              OR session_id IN (SELECT session_id FROM tool_calls WHERE status IN ('requested','running'))`).run();
          if (hasTable(db, 'tool_calls')) db.query(`UPDATE tool_calls SET status='failed',
              result_json=json_patch(json_object('version',1,'status','failed',
                'error',json_object('code','runtime_interrupted','category','runtime','message','The process exited during this tool call.','retryable',json('true')),
                'committedCandidateId',(SELECT candidate.id FROM invoice_candidates candidate WHERE candidate.tool_call_id=tool_calls.id)),
                CASE WHEN json_type(result_json,'$.formApplication') IS NULL THEN '{}'
                  ELSE json_object('formApplication',json_extract(result_json,'$.formApplication')) END),
              cleanup_json=json_set(cleanup_json,'$.stopReason','process-exit','$.stopped',json(CASE
                WHEN EXISTS(SELECT 1 FROM json_each(tool_calls.cleanup_json,'$.nativeProcesses') process
                  WHERE json_extract(process.value,'$.stopped')=0) THEN 'false'
                WHEN status='requested' AND started_at IS NULL THEN 'true'
                WHEN json_extract(cleanup_json,'$.stopped')=1 AND stopped_at IS NOT NULL THEN 'true'
                ELSE 'false' END)),
              ended_at=COALESCE(ended_at,?),stopped_at=CASE
                WHEN EXISTS(SELECT 1 FROM json_each(tool_calls.cleanup_json,'$.nativeProcesses') process
                  WHERE json_extract(process.value,'$.stopped')=0) THEN NULL
                WHEN json_extract(cleanup_json,'$.stopped')=1 AND stopped_at IS NOT NULL THEN stopped_at
                ELSE NULL END
            WHERE status IN ('requested','running')`).run(endedAt);
          for (const call of activeTools) appendToolState(db, events, call.id, 'tool_failed', 'recovery');
          // A stopped tool with an unreadable required result makes only its own
          // persisted conversation unsafe to resume. Diagnostic delivery failures
          // are still readable records and do not disable unrelated Sessions.
          if (hasTable(db, 'tool_calls') && hasTable(db, 'session_native_history')) {
            const calls = db.query("SELECT * FROM tool_calls WHERE status IN ('succeeded','failed','cancelled')")
              .all() as Array<{ session_id: number; status: string; result_json: string | null }>;
            for (const call of calls) {
              try {
                const envelope = readToolEnvelope(call.result_json);
                if (envelope.formApplication !== undefined) toolCallSnapshot(db, call);
                const result = envelope.result;
                if (!result || result.status !== call.status) throw new Error('tool_result_missing');
              }
              catch { db.query('UPDATE session_native_history SET unusable=1 WHERE session_id=?').run(call.session_id); }
            }
          }
          if (hasTable(db, 'jobs')) db.query(`UPDATE jobs SET status='failed',status_reason='runtime_interrupted',updated_at=?
            WHERE status!='completed' AND id IN (
              SELECT job_id FROM runs WHERE status IN ('created','running') AND job_id IS NOT NULL
            )`).run(endedAt);
          const changed = db.query("UPDATE runs SET status='failed',error_json=?,cleanup_json=?,ended_at=? WHERE status IN ('created','running')")
            .run(error, cleanup, endedAt).changes;
          for (const run of activeRuns) appendRunState(db, events, run.id, 'run_failed', 'recovery');
          if (hasTable(db, 'session_inputs')) recoverSessionInputs(db, endedAt,
            (runId, inputIds, resultEntryId, completed) => qualifyRecoveredInputResult(db, runId, inputIds, resultEntryId, completed), events);
          return changed;
        });
        return recovered;
      } catch {
        return fail(databaseError());
      }
    },
  };
}

function qualifyRecoveredInputResult(db: Database, runId: DbId, inputIds: readonly DbId[], resultEntryId: string, completed = false): boolean {
  try {
    const raw = db.query('SELECT * FROM runs WHERE id=?').get(runId) as RunRow | null;
    if (!raw || raw.kind !== 'agent' || (completed ? !['completed', 'failed', 'cancelled'].includes(raw.status) : raw.status !== 'completed')
      || raw.session_id === null || raw.stopped_at === null) return false;
    const cleanup = validatedCleanup(readJson(raw.cleanup_json, 'cleanup'));
    if (!cleanup.stopped || cleanup.lateObservationRequired || !completed && cleanup.errors.length) return false;
    const row = db.query('SELECT * FROM sessions WHERE id=?').get(raw.session_id);
    if (!row) return false;
    const session = readSessionRow(db, row);
    if (session.historyState !== 'recoverable' || !completed && (session.deletePending || session.modelUseBlocked || session.nativeUnusable)) return false;
    const config = validatedConfig(readJson(raw.config_json, 'config'), 'agent');
    const evidence = createSessionInputLedger(db).resultEvidence(runId, inputIds, resultEntryId);
    if (!evidence.ok) return false;
    const all = db.query('SELECT * FROM tool_calls WHERE run_id=?').all(runId);
    const calls = all.map(row => toolCallSnapshot(db, row)).filter(call => evidence.data.toolCallIds.includes(call.nativeToolCallId));
    if (calls.length !== new Set(evidence.data.toolCallIds).size || calls.some(call => !call.cleanup.stopped || call.cleanup.errors.length
      || call.cleanup.nativeProcesses?.some(process => !process.stopped))) return false;
    if (config.goalMode === 'save-candidate' && evidence.data.inputs.some(input => input.mode === 'prompt')) {
      return calls.some(call => call.status === 'succeeded' && call.result?.status === 'succeeded'
        && call.result.committedCandidateId !== null && call.delivery.state === 'request_observed');
    }
    if (config.goalMode === 'fill-form') {
      const target = InvoiceFormTargetSchema.parse(config.formTarget);
      const context = WorkspaceContextSchema.parse(config.workspaceContext);
      const job = raw.job_id == null ? null : readJob(db, raw.job_id);
      // A later Run can change this Job without invalidating an already completed input's evidence.
      if (!job || !completed && !['waiting', 'completed'].includes(job.status) || context.candidateRef === null) return false;
      return calls.some(call => {
        const output = FillInvoiceFormOutputSchema.safeParse(call.result?.data);
        const receipt = call.formApplication;
        return call.toolName === 'fill_invoice_form' && call.status === 'succeeded' && call.result?.status === 'succeeded'
          && call.delivery.state === 'request_observed' && receipt?.outcome === 'applied'
          && receipt.runId === runId && receipt.toolCallId === call.toolCallId && receipt.formInstanceId === target.formInstanceId
          && receipt.appliedRevision === target.expectedRevision + 1 && receipt.candidateId === context.candidateRef!.id
          && receipt.candidateSequence === context.candidateRef!.sequence && output.success
          && output.data.candidateId === receipt.candidateId && output.data.candidateSequence === receipt.candidateSequence;
      });
    }
    return true;
  } catch { return false; }
}

/** Recheck persisted stop facts; a controller lease is not actual stop evidence. */
export function inspectRuntimeRecovery(db: Database): AppError | null {
  // ponytail: one O(n) startup scan; index unresolved facts if measured history size makes startup slow.
  let currentRunId: number | undefined;
  let currentSessionId: number | undefined;
  let currentToolCallId: string | undefined;
  const blocked = (message: string) => appError('runtime_recovery_blocked', 'runtime', message, true,
    currentRunId, currentSessionId, currentToolCallId);
  try {
    const runs = db.query('SELECT id,session_id,cleanup_json FROM runs ORDER BY id').all() as Array<{
      id: number; session_id: number | null; cleanup_json: string;
    }>;
    for (const run of runs) {
      currentRunId = run.id;
      currentSessionId = run.session_id ?? undefined;
      const saved = validatedCleanup(readJson(run.cleanup_json, 'cleanup'));
      if (!saved.stopped || saved.lateObservationRequired) return blocked(
        '原 Run 的实际停止或必要观察尚未确认；可查看原记录，取得实际停止及必要保存证据前不开放新执行。');
    }
    const calls = db.query('SELECT run_id,session_id,native_tool_call_id,cleanup_json FROM tool_calls ORDER BY id').all() as Array<{
      run_id: number; session_id: number; native_tool_call_id: string; cleanup_json: string;
    }>;
    for (const call of calls) {
      currentRunId = call.run_id;
      currentSessionId = call.session_id;
      currentToolCallId = call.native_tool_call_id;
      const saved = readToolCleanup(readJson(call.cleanup_json, 'tool_call_cleanup'));
      if (!saved.stopped || saved.nativeProcesses?.some((process) => !process.stopped)) return blocked(
        '原 ToolCall 的实际停止尚未确认；旧 Host 退出和取得控制锁不能证明本机命令已停，缺证据时只允许查看原事实。');
    }
    return null;
  } catch {
    return blocked('原对象的必要停止事实无法读取；保留现有记录，只读核验成功前不开放新执行。');
  }
}
