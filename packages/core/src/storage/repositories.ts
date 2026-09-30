import type { Database } from 'bun:sqlite';
import { z } from 'zod';
import { InputRecordV2Schema, UsageRecordV2Schema, appError, fail, ok } from '@flowmate/contracts';
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
  DocumentSnapshot,
  WorkspaceSnapshot,
  WorkspaceChange,
  JobSnapshot,
  CandidateSnapshot,
  CandidateSummary,
  CandidateReceipt,
  CandidateDraft,
  CheckResult,
  InvoiceIssue,
  InvoiceToolOutput,
  WorkspaceExpectation,
  WorkspaceContext,
  WorkspaceInput,
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
  BusinessEventSnapshot,
  BusinessEventType,
  Page,
  NormalizedPageRequest,
  CandidateRepository,
  SaveCandidateRecord,
} from '@flowmate/contracts';
import type { RunAgentConfigFacts, AgentFacts, RunScope } from '@flowmate/contracts';
import { AppErrorSchema, CandidateDraftSchema, CheckResultSchema, DocumentRefSchema, INVOICE_TOOL_NAMES, InvoiceIssueSchema, RunScopeSchema, SourceRefSchema, ToolEffectSchema, WorkspaceContextSchema, WorkspaceExpectationSchema, WorkspaceInputSchema } from '@flowmate/contracts';

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
  config: SafeConfigSnapshot & { agent: P3AgentConfigFacts };
  usage: UsageRecord;
  cleanup: CleanupRecord;
  createdAt: string;
};

export type WorkspaceRunAdmission = {
  runId: DbId;
  jobId: DbId | null;
  scope: RunScope;
  workspaceContext: WorkspaceContext;
  workspaceInput: WorkspaceInput;
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
  read(at: string): Result<WorkspaceSnapshot>;
  update(input: WorkspaceUpdate): Result<WorkspaceSnapshot>;
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
  finish(input: { toolCallId: DbId; result: StoredToolResult; cleanup: ToolCallCleanup; endedAt: string; stoppedAt: string | null }): Result<ToolCallSnapshot>;
  reject(input: { toolCallId: DbId; result: StoredToolResult; cleanup: ToolCallCleanup; endedAt: string }): Result<ToolCallSnapshot>;
  recordDelivery(input: { toolCallId: DbId; delivery: ToolCallDelivery }): Result<ToolCallSnapshot>;
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
  delete(sessionId: DbId, at: string): Result<'hidden' | 'permanent'>;
  loadHistory(sessionId: DbId): Result<NativeSessionHistory | null>;
  readHistoryForDisplay(sessionId: DbId): Result<NativeHistoryDisplayRecord>;
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
};

export interface RunRepository {
  create(input: NewProviderRun): Result<DbId>;
  createAgent(input: NewAgentRun): Result<DbId>;
  createWorkspaceAgent(input: NewWorkspaceAgentRun): Result<WorkspaceRunAdmission>;
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
      || agent.maxAssistantContentBytes !== 524_288 || agent.maxModelCalls !== 12
      || agent.maxToolCalls !== 24 || agent.toolTimeoutMs !== 10_000);
  if (p2Invalid || p3Invalid || (agent.policyVersion !== 'p2-invoice-chat-v1' && agent.policyVersion !== 'p3-invoice-tools-v1')) {
    throw new Error('invalid_agent_config_shape');
  }
  return agent;
}

function validatedConfig(value: unknown, kind: RunRow['kind'] = 'provider'): Record<string, unknown> {
  const record = versioned(value, 'config', ['name', 'revision', 'requestedModel', 'resolvedModel', 'api', 'endpoint', 'sdk', 'parameters', 'limits', 'native']);
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
  if (kind === 'agent') validatedAgentConfig(record.agent);
  else if (record.agent !== undefined) throw new Error('unexpected_provider_agent_config');
  if (record.workspaceContext !== undefined) WorkspaceContextSchema.parse(record.workspaceContext);
  if (record.goalMode !== undefined && !['answer', 'save-candidate'].includes(String(record.goalMode))) throw new Error('invalid_goal_mode');
  return record;
}

function validatedAgentFacts(value: unknown): Record<string, unknown> {
  const agent = object(value, 'output_agent');
  if (typeof agent.nativeSessionId !== 'string' || agent.nativeSessionId.length < 1 || agent.nativeSessionId.length > 128
    || !Number.isSafeInteger(agent.turnCount) || Number(agent.turnCount) < 0
    || !Number.isSafeInteger(agent.modelCallCount) || Number(agent.modelCallCount) < 0) throw new Error('invalid_agent_output_shape');
  if (agent.candidateIds !== undefined && (!Array.isArray(agent.candidateIds) || agent.candidateIds.length > 24
    || !agent.candidateIds.every((id) => Number.isSafeInteger(id) && Number(id) > 0)
    || new Set(agent.candidateIds).size !== agent.candidateIds.length)) throw new Error('invalid_agent_candidate_ids');
  return agent;
}

function validatedScope(value: unknown): ChatScope | RunScope {
  const record = object(value, 'scope');
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
  const record = versioned(value, 'output', ['text', 'partial', 'stopReason', 'responseId', 'responseModel']);
  if (typeof record.text !== 'string' || typeof record.partial !== 'boolean' || typeof record.stopReason !== 'string'
    || (record.wireMaxTokens !== undefined && record.wireMaxTokens !== null && (!Number.isSafeInteger(record.wireMaxTokens) || Number(record.wireMaxTokens) < 1))) throw new Error('invalid_output_shape');
  if (kind === 'agent') validatedAgentFacts(record.agent);
  else if (record.agent !== undefined) throw new Error('unexpected_provider_agent_output');
  return record;
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
  };
}

function parseSessionModelUse(value: string): { documentIds: number[]; at: string; reason: 'document_use_revoked' } | null {
  const metadata = exactRecord(readJson(value, 'session_metadata'), 'session_metadata', ['version', 'model_use_blocked']);
  if (metadata.version !== 1) throw new Error('invalid_session_metadata_version');
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
  const parsed = RunScopeSchema.safeParse(scope);
  return parsed.success && parsed.data.allowedDocumentIds.includes(documentId)
    || row.job_document_id === documentId || !parsed.success && configPolicy(row.config_json) !== 'p2';
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
    const metadata = JSON.stringify({ version: 1, model_use_blocked: { documentIds, at, reason: 'document_use_revoked' } });
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
    || Number(metadata.pageCount) > 20
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

function toolCallSnapshot(value: unknown): ToolCallSnapshot {
  const row = value as {
    id: number; run_id: number; session_id: number; native_tool_call_id: string; tool_name: string;
    tool_version: string | null; effect: string | null; status: string; args_json: string; result_json: string | null;
    delivery_json: string; cleanup_json: string; requested_at: string; started_at: string | null;
    ended_at: string | null; stopped_at: string | null;
  } | null;
  if (!row || !Number.isSafeInteger(row.id) || row.id < 1 || !Number.isSafeInteger(row.run_id) || row.run_id < 1
    || !Number.isSafeInteger(row.session_id) || row.session_id < 1 || typeof row.native_tool_call_id !== 'string'
    || row.native_tool_call_id.length < 1 || row.native_tool_call_id.length > 256 || typeof row.tool_name !== 'string'
    || row.tool_name.length < 1 || row.tool_name.length > 128
    || (row.tool_version !== null && (typeof row.tool_version !== 'string' || row.tool_version.length < 1 || row.tool_version.length > 32))
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
  const cleanupObject = exactRecord(readJson(row.cleanup_json, 'tool_call_cleanup'), 'tool_call_cleanup', ['version', 'stopReason', 'stopped', 'errors']);
  if (cleanupObject.version !== 1 || (cleanupObject.stopReason !== null && typeof cleanupObject.stopReason !== 'string')
    || typeof cleanupObject.stopped !== 'boolean' || !Array.isArray(cleanupObject.errors)) throw new Error('invalid_tool_call_cleanup');
  const cleanupErrors = cleanupObject.errors.map((error) => AppErrorSchema.parse(error));
  let result: StoredToolResult | null = null;
  if (row.result_json !== null) {
    const record = object(readJson(row.result_json, 'tool_call_result'), 'tool_call_result');
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
    result = record as unknown as StoredToolResult;
  }
  const terminal = ['succeeded', 'failed', 'cancelled'].includes(row.status);
  if (terminal !== (row.ended_at !== null) || terminal !== (result !== null)) throw new Error('invalid_tool_call_terminal');
  if (row.status === 'succeeded' && (row.started_at === null || row.stopped_at === null)) throw new Error('invalid_tool_call_success');
  return {
    toolCallId: row.id, runId: row.run_id, sessionId: row.session_id, nativeToolCallId: row.native_tool_call_id,
    toolName: row.tool_name, toolVersion: row.tool_version, effect: row.effect as ToolCallSnapshot['effect'],
    status: row.status as ToolCallStatus, args: args as unknown as ToolCallSnapshot['args'], result,
    delivery: { version: 1, state: deliveryObject.state as ToolCallDelivery['state'],
      messageObservedAt: deliveryObject.messageObservedAt as string | null,
      includedInCallSequence: deliveryObject.includedInCallSequence as number | null,
      requestDispatchedAt: deliveryObject.requestDispatchedAt as string | null, error: deliveryError },
    cleanup: { version: 1, stopReason: cleanupObject.stopReason as string | null, stopped: cleanupObject.stopped,
      errors: cleanupErrors },
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
    || !['document_imported', 'task_started', 'candidate_generated', 'candidate_selected'].includes(row.type)
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

function candidateSnapshot(value: unknown): { snapshot: CandidateSnapshot; documentRef: { id: DbId; version: string } } {
  const row = value as {
    id: number; job_id: number; run_id: number; tool_call_id: number; sequence: number; status: string;
    fields_json: string; lines_json: string; issues_json: string; created_at: string; accepted_at: string | null;
    document_id: number; document_version: string;
  } | null;
  if (!row || !Number.isSafeInteger(row.id) || row.id < 1 || !Number.isSafeInteger(row.job_id) || row.job_id < 1
    || !Number.isSafeInteger(row.run_id) || row.run_id < 1 || !Number.isSafeInteger(row.tool_call_id) || row.tool_call_id < 1
    || !Number.isSafeInteger(row.sequence) || row.sequence < 1 || !['generated', 'accepted', 'rejected'].includes(row.status)
    || typeof row.created_at !== 'string' || (row.accepted_at !== null && typeof row.accepted_at !== 'string')
    || !Number.isSafeInteger(row.document_id) || row.document_id < 1 || typeof row.document_version !== 'string') {
    throw new Error('invalid_candidate_row');
  }
  const fields = exactRecord(readJson(row.fields_json, 'candidate_fields'), 'candidate_fields', ['version', 'values']);
  const lines = exactRecord(readJson(row.lines_json, 'candidate_lines'), 'candidate_lines', ['version', 'items']);
  const persisted = exactRecord(readJson(row.issues_json, 'candidate_issues'), 'candidate_issues', ['version', 'notes', 'checks', 'items']);
  if (fields.version !== 1 || lines.version !== 1 || persisted.version !== 1 || !Array.isArray(persisted.notes)) {
    throw new Error('invalid_candidate_version');
  }
  const candidate = CandidateDraftSchema.parse({ fields: fields.values, lines: lines.items, notes: persisted.notes });
  const checks = z.array(CheckResultSchema).max(1_000).parse(persisted.checks);
  const issues = z.array(InvoiceIssueSchema).max(1_000).parse(persisted.items);
  const sourceMap = new Map<string, CandidateDraft['fields'][keyof CandidateDraft['fields']]['sources'][number]>();
  const fieldsToRead = [...Object.values(candidate.fields), ...candidate.lines.flatMap((line) => Object.values(line))];
  for (const field of fieldsToRead) for (const source of field.sources) {
    const validated = SourceRefSchema.parse(source);
    sourceMap.set(stableJson(validated), validated);
  }
  const snapshot: CandidateSnapshot = {
    candidateId: row.id, jobId: row.job_id, runId: row.run_id, toolCallId: row.tool_call_id, sequence: row.sequence,
    status: row.status as CandidateSummary['status'], issueCount: issues.length, createdAt: row.created_at,
    fields: candidate.fields, lines: candidate.lines, notes: candidate.notes, checks, issues, sources: [...sourceMap.values()],
  };
  return { snapshot, documentRef: DocumentRefSchema.parse({ id: row.document_id, version: row.document_version }) };
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

function workspaceSnapshot(db: Database, row: unknown, at: string): WorkspaceSnapshot {
  const record = row as {
    active_document_id: number | null; active_job_id: number | null; active_session_id: number | null;
    active_view: string; revision: number; updated_at: string;
  } | null;
  if (!record || !Number.isSafeInteger(record.revision) || record.revision < 0
    || !['original', 'parsed', 'candidate'].includes(record.active_view) || typeof record.updated_at !== 'string') {
    throw new Error('invalid_workspace_row');
  }
  const invalidReferences: string[] = [];
  let documentRef: WorkspaceSnapshot['documentRef'] = null;
  if (record.active_document_id !== null) {
    const document = db.query('SELECT id,version FROM documents WHERE id=?').get(record.active_document_id) as { id: number; version: string } | null;
    if (document) documentRef = DocumentRefSchema.parse(document);
    else invalidReferences.push('document_missing');
  }
  let jobId: DbId | null = record.active_job_id;
  let candidateRef: WorkspaceSnapshot['candidateRef'] = null;
  if (record.active_job_id !== null) {
    const job = db.query('SELECT id,document_id,current_candidate_id FROM jobs WHERE id=?').get(record.active_job_id) as {
      id: number; document_id: number; current_candidate_id: number | null;
    } | null;
    if (!job) {
      invalidReferences.push('job_missing');
      jobId = null;
    } else if (job.document_id !== record.active_document_id) {
      invalidReferences.push('job_document_mismatch');
      jobId = null;
    } else if (job.current_candidate_id !== null) {
      const candidate = db.query('SELECT id,sequence,job_id FROM invoice_candidates WHERE id=?').get(job.current_candidate_id) as {
        id: number; sequence: number; job_id: number;
      } | null;
      if (candidate && candidate.job_id === job.id) candidateRef = { id: candidate.id, sequence: candidate.sequence };
      else invalidReferences.push('candidate_mismatch');
    }
  }
  let sessionId: DbId | null = record.active_session_id;
  if (record.active_session_id !== null) {
    const session = db.query("SELECT id,status FROM sessions WHERE id=?").get(record.active_session_id) as { id: number; status: string } | null;
    if (!session || session.status !== 'active') {
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
    selection: null, revision: record.revision, updatedAt: record.updated_at || at, invalidReferences, nextTaskSequence,
  };
}

function ensureWorkspace(db: Database, at: string): unknown {
  db.query(`INSERT INTO workspace(id,active_view,selection_json,revision,created_at,updated_at)
    VALUES (1,'original',NULL,0,?,?) ON CONFLICT(id) DO NOTHING`).run(at, at);
  return db.query('SELECT * FROM workspace WHERE id=1').get();
}

export function createWorkspaceRepository(db: Database): WorkspaceRepository {
  return {
    read(at) {
      const result = transaction(db, () => workspaceSnapshot(db, ensureWorkspace(db, at), at));
      return result.ok ? result : fail(appError('storage_corrupt', 'storage', 'Workspace 事实无法读取。'));
    },

    update(input) {
      const changed = transaction(db, () => {
        const row = ensureWorkspace(db, input.at) as {
          active_document_id: number | null; active_job_id: number | null; active_session_id: number | null;
          active_view: string; revision: number;
        };
        if (row.revision !== input.expectedRevision) return fail(appError('state_conflict', 'input', 'Workspace 已变化，请重新读取。', true));
        let documentId = row.active_document_id;
        let jobId = row.active_job_id;
        let sessionId = row.active_session_id;
        let activeView = row.active_view as WorkspaceSnapshot['activeView'];
        const change = input.change;
        if (change.kind === 'document') {
          if (change.documentId !== null && !db.query('SELECT id FROM documents WHERE id=? AND hidden_at IS NULL').get(change.documentId)) {
            return fail(appError('document_not_found', 'input', 'Invoice is no longer in the workspace.'));
          }
          if (documentId !== change.documentId) {
            documentId = change.documentId;
            jobId = null;
            activeView = 'original';
          }
        } else if (change.kind === 'job') {
          const job = readJob(db, change.jobId);
          if (!job) return fail(appError('job_not_found', 'input', 'Job 不存在。'));
          if (!db.query('SELECT id FROM documents WHERE id=? AND hidden_at IS NULL').get(job.documentRef.id)) {
            return fail(appError('input_unavailable', 'input', 'This invoice is available only in Processing History.'));
          }
          if (jobId !== change.jobId || documentId !== job.documentRef.id) {
            jobId = change.jobId;
            documentId = job.documentRef.id;
            activeView = 'original';
          }
        } else if (change.kind === 'session') {
          if (change.sessionId !== null) {
            const session = db.query("SELECT status FROM sessions WHERE id=?").get(change.sessionId) as { status: string } | null;
            if (!session || session.status !== 'active') return fail(appError('session_not_found', 'input', '可用 Session 不存在。'));
          }
          sessionId = change.sessionId;
        } else {
          activeView = change.view;
        }
        if (documentId === row.active_document_id && jobId === row.active_job_id
          && sessionId === row.active_session_id && activeView === row.active_view) {
          return ok(workspaceSnapshot(db, row, input.at));
        }
        const updated = db.query(`UPDATE workspace SET active_document_id=?,active_job_id=?,active_session_id=?,
          active_view=?,selection_json=NULL,revision=revision+1,updated_at=? WHERE id=1 AND revision=?`)
          .run(documentId, jobId, sessionId, activeView, input.at, input.expectedRevision).changes;
        if (updated !== 1) return fail(appError('state_conflict', 'input', 'Workspace 已变化，请重新读取。', true));
        return ok(workspaceSnapshot(db, db.query('SELECT * FROM workspace WHERE id=1').get(), input.at));
      });
      return changed.ok ? changed.data : changed;
    },

    selectCandidate(input) {
      const selected = transaction(db, () => {
        const workspace = ensureWorkspace(db, input.at) as { active_job_id: number | null; revision: number };
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
        if (candidate.status !== 'generated') return fail(appError('candidate_not_selectable', 'input', '只有 generated Candidate 可以选择。'));
        if (job.current_candidate_id === input.candidateId) {
          return ok({ jobId: input.jobId, candidateId: input.candidateId, workspace: workspaceSnapshot(db, workspace, input.at) });
        }
        if (job.status === 'completed') return fail(appError('job_completed', 'input', '已完成 Job 不能更换候选。'));
        if (job.status === 'running') return fail(appError('state_conflict', 'runtime', 'Job 仍在运行，暂时不能选择候选。', true));
        const relatedRuns = db.query('SELECT status,cleanup_json FROM runs WHERE job_id=?').all(input.jobId) as Array<{
          status: string; cleanup_json: string;
        }>;
        if (relatedRuns.some((run) => {
          if (run.status === 'created' || run.status === 'running') return true;
          const cleanup = validatedCleanup(readJson(run.cleanup_json, 'cleanup'));
          return !cleanup.stopped || cleanup.lateObservationRequired;
        })) return fail(appError('state_conflict', 'runtime', 'Job 仍有未停止或未收尾的执行。', true));
        if (!Number.isSafeInteger(workspace.revision + 1)) {
          return fail(appError('state_conflict', 'input', 'Workspace revision 已到上限。'));
        }
        const changedJob = db.query('UPDATE jobs SET current_candidate_id=?,updated_at=? WHERE id=? AND current_candidate_id IS ?')
          .run(input.candidateId, input.at, input.jobId, input.expectedCandidateId).changes;
        if (changedJob !== 1) return fail(appError('state_conflict', 'input', 'Job 当前候选已变化，请重新读取。', true));
        if (workspace.active_job_id === input.jobId) {
          const changedWorkspace = db.query(`UPDATE workspace SET selection_json=NULL,revision=revision+1,updated_at=?
            WHERE id=1 AND revision=?`).run(input.at, input.expectedRevision).changes;
          if (changedWorkspace !== 1) return fail(appError('state_conflict', 'input', 'Workspace 已变化，请重新读取。', true));
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
        const inputJson = { version: 1, clientSequence: input.clientSequence, expectedRevision: input.expectedRevision,
          documentRef: input.documentRef, goal: input.goal };
        const inserted = db.query(`INSERT INTO jobs(document_id,goal,input_json,status,created_at,updated_at)
          VALUES (?,?,?,'pending',?,?)`).run(input.documentRef.id, input.goal, asJson(inputJson), input.at, input.at);
        const jobId = Number(inserted.lastInsertRowid);
        if (!Number.isSafeInteger(jobId) || jobId <= 0) throw new Error('unsafe_job_id');
        const updated = db.query(`UPDATE workspace SET active_job_id=?,active_view='original',selection_json=NULL,
          revision=revision+1,updated_at=? WHERE id=1 AND revision=?`).run(jobId, input.at, input.expectedRevision).changes;
        if (updated !== 1) return fail(appError('state_conflict', 'input', 'Workspace 已变化，请重新读取。', true));
        db.query(`INSERT INTO business_events(type,occurred_at,actor_source,operation_ref,document_id,job_id,result,safe_summary)
          VALUES ('task_started',?,'user',?,?,?,'succeeded','Task started')`)
          .run(input.at, operationRef(input.clientSequence), input.documentRef.id, jobId);
        return ok(taskResult(jobId, input.at));
      });
      return created.ok ? created.data : created;
    },
  };
}

export function createToolCallRepository(db: Database): ToolCallRepository {
  const byId = (toolCallId: DbId) => {
    const row = db.query('SELECT * FROM tool_calls WHERE id=?').get(toolCallId);
    if (!row) return fail(appError('tool_call_not_found', 'input', 'ToolCall 不存在。'));
    return ok(toolCallSnapshot(row));
  };
  return {
    request(input) {
      try {
        if (!Number.isSafeInteger(input.runId) || input.runId < 1 || !Number.isSafeInteger(input.sessionId) || input.sessionId < 1
          || typeof input.nativeToolCallId !== 'string' || input.nativeToolCallId.length < 1 || input.nativeToolCallId.length > 256
          || typeof input.toolName !== 'string' || input.toolName.length < 1 || input.toolName.length > 128
          || input.toolVersion !== null && (typeof input.toolVersion !== 'string' || input.toolVersion.length < 1 || input.toolVersion.length > 32)
          || input.effect !== null && !ToolEffectSchema.safeParse(input.effect).success
          || (input.toolVersion === null) !== (input.effect === null)) return fail(appError('input_invalid', 'input', '原生 ToolCall 身份无效。'));
        const raw = JSON.stringify(input.rawArguments);
        if (raw === undefined || Buffer.byteLength(raw, 'utf8') > 256 * 1024) return fail(appError('tool_result_too_large', 'input', 'ToolCall 参数超过记录上限。'));
        const existing = db.query('SELECT * FROM tool_calls WHERE session_id=? AND native_tool_call_id=?')
          .get(input.sessionId, input.nativeToolCallId);
        if (existing) {
          const call = toolCallSnapshot(existing);
          if (call.runId !== input.runId || call.toolName !== input.toolName || call.toolVersion !== input.toolVersion
            || call.effect !== input.effect || stableJson(call.args.raw) !== stableJson(input.rawArguments)) {
            return fail(appError('state_conflict', 'runtime', '原生 ToolCall ID 已属于不同的执行请求。'));
          }
          return ok(call);
        }
        const run = db.query("SELECT session_id,status FROM runs WHERE id=? AND kind='agent'").get(input.runId) as { session_id: number; status: string } | null;
        if (!run || run.session_id !== input.sessionId) return fail(appError('tool_access_denied', 'runtime', 'ToolCall 与可信 Agent Run 不匹配.'));
        if (!['created', 'running'].includes(run.status)) return fail(appError('run_state_invalid', 'runtime', 'Run 已停止接纳新的 ToolCall。'));
        const id = transaction(db, () => {
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
        return row ? ok(toolCallSnapshot(row)) : fail(appError('tool_call_not_found', 'input', 'ToolCall 不存在。'));
      } catch {
        return fail(appError('storage_corrupt', 'storage', 'ToolCall 事实无法读取。'));
      }
    },

    getById(toolCallId) {
      try { return byId(toolCallId); }
      catch { return fail(appError('storage_corrupt', 'storage', 'ToolCall 事实无法读取。', false, toolCallId)); }
    },

    list(input) {
      try {
        if (!Number.isSafeInteger(input.runId) || input.runId < 1 || !Number.isSafeInteger(input.limit) || input.limit < 1 || input.limit > 100
          || input.beforeId !== undefined && (!Number.isSafeInteger(input.beforeId) || input.beforeId < 1)) return fail(appError('input_invalid', 'input', 'ToolCall 分页参数无效。'));
        const rows = input.beforeId === undefined
          ? db.query('SELECT * FROM tool_calls WHERE run_id=? ORDER BY id DESC LIMIT ?').all(input.runId, input.limit + 1)
          : db.query('SELECT * FROM tool_calls WHERE run_id=? AND id<? ORDER BY id DESC LIMIT ?').all(input.runId, input.beforeId, input.limit + 1);
        const calls = (rows as unknown[]).map(toolCallSnapshot);
        const hasMore = calls.length > input.limit;
        const items = hasMore ? calls.slice(0, input.limit) : calls;
        return ok({ items, nextBeforeId: hasMore ? items.at(-1)?.toolCallId ?? null : null });
      } catch {
        return fail(appError('storage_corrupt', 'storage', 'ToolCall 列表无法读取。'));
      }
    },

    fixArguments(input) {
      try {
        const serialized = JSON.stringify(input.finalArguments);
        if (serialized === undefined || Buffer.byteLength(serialized, 'utf8') > 65_536) return fail(appError('tool_result_too_large', 'input', 'ToolCall 最终参数超过记录上限.'));
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
        const changed = db.query("UPDATE tool_calls SET status='running',started_at=? WHERE id=? AND status='requested' AND json_type(args_json,'$.final')!='null'")
          .run(input.startedAt, input.toolCallId).changes;
        if (changed === 1) return byId(input.toolCallId);
        const current = byId(input.toolCallId);
        return current.ok && current.data.status === 'running' ? current
          : fail(appError('run_state_invalid', 'runtime', 'ToolCall 未处于可执行状态。'));
      } catch { return fail(databaseError('ToolCall 执行状态保存失败。')); }
    },

    finish(input) {
      try {
        if (!['succeeded', 'failed', 'cancelled'].includes(input.result.status)
          || !Array.isArray(input.cleanup.errors) || (input.result.status === 'succeeded' && (!input.cleanup.stopped || input.stoppedAt === null))) {
          return fail(appError('input_invalid', 'storage', 'ToolCall 终态事实无效。'));
        }
        const serialized = JSON.stringify(input.result);
        if (serialized === undefined || Buffer.byteLength(serialized, 'utf8') > 256 * 1024) return fail(appError('tool_result_too_large', 'storage', 'ToolCall 结果超过记录上限。'));
        const changed = db.query(`UPDATE tool_calls SET status=?,result_json=?,cleanup_json=?,ended_at=?,stopped_at=?
          WHERE id=? AND status='running'`).run(input.result.status, serialized, JSON.stringify(input.cleanup), input.endedAt,
          input.stoppedAt, input.toolCallId).changes;
        if (changed === 1) return byId(input.toolCallId);
        const current = byId(input.toolCallId);
        return current.ok && stableJson(current.data.result) === stableJson(input.result) ? current
          : fail(appError('state_conflict', 'runtime', 'ToolCall 终态已固定或状态已变化。'));
      } catch { return fail(databaseError('ToolCall 终态保存失败。')); }
    },

    reject(input) {
      try {
        if (!['failed', 'cancelled'].includes(input.result.status) || input.cleanup.version !== 1
          || input.cleanup.stopped !== true || !Array.isArray(input.cleanup.errors)) {
          return fail(appError('input_invalid', 'storage', '未执行调用的终态事实无效。'));
        }
        const serialized = JSON.stringify(input.result);
        if (serialized === undefined || Buffer.byteLength(serialized, 'utf8') > 256 * 1024) return fail(appError('tool_result_too_large', 'storage', 'ToolCall 结果超过记录上限。'));
        const changed = db.query(`UPDATE tool_calls SET status=?,result_json=?,cleanup_json=?,ended_at=?,stopped_at=NULL
          WHERE id=? AND status='requested'`).run(input.result.status, serialized, JSON.stringify(input.cleanup), input.endedAt, input.toolCallId).changes;
        if (changed === 1) return byId(input.toolCallId);
        const current = byId(input.toolCallId);
        return current.ok && stableJson(current.data.result) === stableJson(input.result) ? current
          : fail(appError('state_conflict', 'runtime', 'ToolCall 已开始或终态已固定。'));
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

export function createCandidateRepository(db: Database): CandidateRepository {
  const queryCandidate = (candidateId: DbId, jobId?: DbId) => {
    const sql = `SELECT candidate.*,document.id AS document_id,document.version AS document_version
      FROM invoice_candidates candidate JOIN jobs job ON job.id=candidate.job_id
      JOIN documents document ON document.id=job.document_id WHERE candidate.id=?${jobId === undefined ? '' : ' AND candidate.job_id=?'}`;
    return jobId === undefined ? db.query(sql).get(candidateId) : db.query(sql).get(candidateId, jobId);
  };
  return {
    save(input) {
      try {
        const draft = CandidateDraftSchema.parse(input.candidate);
        const checks = z.array(CheckResultSchema).max(1_000).parse(input.checks);
        const issues = z.array(InvoiceIssueSchema).max(1_000).parse(input.issues);
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
            const candidate = candidateSnapshot(queryCandidate(existing.id, facts.job_id));
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
          const candidate = candidateSnapshot(queryCandidate(candidateId, facts.job_id));
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
        const items = (rows as Array<{ id: number }>).map(({ id }) => candidateSnapshot(queryCandidate(id, input.jobId)).snapshot)
          .map(({ candidateId, jobId, runId, sequence, status, issueCount, createdAt }) =>
            ({ candidateId, jobId, runId, sequence, status, issueCount, createdAt }));
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
        const row = queryCandidate(input.candidateId, input.jobId);
        if (!row) return fail(appError('candidate_not_found', 'input', '此 Job 下不存在该 Candidate。'));
        const { snapshot, documentRef } = candidateSnapshot(row);
        return ok({ documentRef, candidate: snapshot });
      } catch { return fail(appError('storage_corrupt', 'storage', 'Candidate 无法读取。')); }
    },

    listForRun(input) {
      try {
        if (!Number.isSafeInteger(input.runId) || input.runId < 1 || !Number.isSafeInteger(input.limit) || input.limit < 1 || input.limit > 50
          || input.beforeSequence !== null && (!Number.isSafeInteger(input.beforeSequence) || input.beforeSequence < 1)) {
          return fail(appError('input_invalid', 'input', '候选分页参数无效。'));
        }
        const run = db.query("SELECT job_id FROM runs WHERE id=? AND kind='agent'").get(input.runId) as { job_id: number | null } | null;
        if (!run?.job_id) return fail(appError('state_conflict', 'runtime', '当前 Run 没有归属 Job。'));
        const rows = input.beforeSequence === null
          ? db.query('SELECT * FROM invoice_candidates WHERE job_id=? ORDER BY sequence DESC LIMIT ?').all(run.job_id, input.limit + 1)
          : db.query('SELECT * FROM invoice_candidates WHERE job_id=? AND sequence<? ORDER BY sequence DESC LIMIT ?').all(run.job_id, input.beforeSequence, input.limit + 1);
        const items = (rows as Array<Record<string, unknown>>).map((row) => {
          const record = row as unknown as { id: number; job_id: number; run_id: number; sequence: number; status: string; issues_json: string; created_at: string };
          const issues = exactRecord(readJson(record.issues_json, 'candidate_issues'), 'candidate_issues', ['version', 'notes', 'checks', 'items']);
          const parsedIssues = z.array(InvoiceIssueSchema).parse(issues.items);
          if (!Number.isSafeInteger(record.id) || !Number.isSafeInteger(record.sequence) || issues.version !== 1
            || !['generated', 'accepted', 'rejected'].includes(record.status)) throw new Error('invalid_candidate_index_row');
          return { candidateId: record.id, runId: record.run_id, sequence: record.sequence, issueCount: parsedIssues.length };
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
        const row = queryCandidate(input.candidateId, run.job_id);
        if (!row) return fail(appError('candidate_not_found', 'input', 'Candidate 不存在。'));
        const { snapshot, documentRef } = candidateSnapshot(row);
        return ok({ candidateId: snapshot.candidateId, jobId: snapshot.jobId, runId: snapshot.runId,
          sequence: snapshot.sequence, issueCount: snapshot.issueCount,
          documentRef, toolCallId: snapshot.toolCallId,
          candidate: { fields: snapshot.fields, lines: snapshot.lines, notes: snapshot.notes }, checks: snapshot.checks, issues: snapshot.issues });
      } catch { return fail(appError('storage_corrupt', 'storage', 'Candidate 无法读取。')); }
    },
  };
}

function snapshotFromRow(row: RunRow): RunSnapshot {
  const output = row.output_json === null ? null : validatedOutput(readJson(row.output_json, 'output'), row.kind);
  const error = validatedError(readJson(row.error_json ?? 'null', 'error'));
  const input = validatedInput(readJson(row.input_json, 'input'));
  const config = validatedConfig(readJson(row.config_json, 'config'), row.kind);
  const usage = validatedUsage(readJson(row.usage_json, 'usage'));
  const cleanup = validatedCleanup(readJson(row.cleanup_json, 'cleanup'));
  const base = {
    runId: row.id,
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
  return {
    version: 1,
    source,
    reason: source === 'sdk' ? null : incoming.reason ?? current.reason,
    sdkValues: mergedValues,
    attempts: current.attempts ?? incoming.attempts,
    attemptsComplete: current.attemptsComplete || incoming.attemptsComplete,
    costSource: current.costSource ?? incoming.costSource,
    updatedAt: incoming.updatedAt,
  };
}

function transaction<T>(db: Database, fn: () => T): Result<T> {
  try {
    db.exec('BEGIN IMMEDIATE');
    const result = fn();
    db.exec('COMMIT');
    return ok(result);
  } catch (error) {
    try {
      db.exec('ROLLBACK');
    } catch {
      // Keep the original storage failure; the connection is closed by owner.
    }
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

function writeNativeHistory(db: Database, sessionId: DbId, history: NativeSessionHistory, context?: NativeHistoryAppendContext): void {
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
    const binding = exactRecord(context, 'native_entry_run_binding', ['entryId', 'runId']);
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
  db.query('UPDATE session_native_history SET leaf_id=?,entry_count=?,unusable=? WHERE session_id=?')
    .run(history.leafId, history.entries.length, previous?.unusable || history.unusable ? 1 : 0, sessionId);
}

function hasTable(db: Database, table: string): boolean {
  return db.query("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(table) !== null;
}

export function createSessionRepository(db: Database): SessionRepository {
  return {
    create(input) {
      const created = transaction(db, () => {
        if (input.expectedRevision !== undefined) {
          const workspace = ensureWorkspace(db, input.at) as { revision: number };
          if (workspace.revision !== input.expectedRevision) return null;
        }
        const result = db.query('INSERT INTO sessions(native_session_id,title,created_at,updated_at) VALUES (?,?,?,?)')
          .run(input.nativeSessionId, input.title, input.at, input.at);
        const id = Number(result.lastInsertRowid);
        if (!Number.isSafeInteger(id) || id <= 0) throw new Error('unsafe_session_id');
        if (input.nativeHistory) writeNativeHistory(db, id, input.nativeHistory);
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
        return ok(db.transaction((): NativeHistoryDisplayRecord => {
          const history = readNativeHistory(db, sessionId);
          const bindings = db.query('SELECT entry_id,run_id FROM session_native_entries WHERE session_id=? AND run_id IS NOT NULL ORDER BY sequence')
            .all(sessionId) as Array<{ entry_id: string; run_id: number }>;
          return { history, bindings: bindings.map((entry) => ({ entryId: entry.entry_id, runId: entry.run_id })) };
        }).deferred());
      } catch { return fail(appError('session_history_invalid', 'session', 'Saved conversation history is invalid. Start a new chat.')); }
    },

    saveHistory(sessionId, history, context) {
      const saved = transaction(db, () => writeNativeHistory(db, sessionId, history, context));
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
      const result = transaction(db, () => {
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
      const revoked = transaction(db, () => {
        if (!db.query('SELECT id FROM documents WHERE id=?').get(input.documentId)) {
          return { ok: false as const, error: appError('document_not_found', 'input', '正式材料不存在。') };
        }
        return { ok: true as const, data: { affectedSessionIds: blockSessionsUsingDocument(db, input.documentId, input.at) } };
      });
      return revoked.ok ? revoked.data : revoked;
    },

    prepareDelete(sessionId, at) {
      const prepared = transaction(db, () => {
        const row = db.query('SELECT * FROM sessions WHERE id=?').get(sessionId);
        if (!row) return fail(appError('session_not_found', 'session', 'Session 不存在。'));
        if (db.query("SELECT id FROM runs WHERE kind='agent' AND session_id=? AND status IN ('created','running') LIMIT 1").get(sessionId)) {
          return fail(appError('session_busy', 'session', 'An Agent Run is active in this Session. Wait for it to finish before deleting this Session.', true));
        }
        db.query("UPDATE sessions SET status='archived',updated_at=? WHERE id=? AND status!='archived'").run(at, sessionId);
        return ok(readSessionRow(db, db.query('SELECT * FROM sessions WHERE id=?').get(sessionId)));
      });
      return prepared.ok ? prepared.data : prepared;
    },

    delete(sessionId, at) {
      const deleted = transaction(db, () => {
        const row = db.query('SELECT status,hidden_at FROM sessions WHERE id=?').get(sessionId) as { status: string; hidden_at: string | null } | null;
        if (!row) return fail(appError('session_not_found', 'session', 'Session 不存在。'));
        if (row.status !== 'archived') {
          return fail(appError('session_delete_not_prepared', 'session', 'Session deletion has not been prepared.'));
        }
        if (db.query("SELECT id FROM runs WHERE kind='agent' AND session_id=? AND status IN ('created','running') LIMIT 1").get(sessionId)) {
          return fail(appError('session_busy', 'session', 'An Agent Run is active in this Session. Wait for it to finish before deleting this Session.', true));
        }
        if (row.hidden_at !== null) return ok('hidden' as const);
        db.query('UPDATE workspace SET active_session_id=NULL,revision=revision+1,updated_at=? WHERE id=1 AND active_session_id=?')
          .run(at, sessionId);
        if (hasBusinessHistory(db, sessionId)) {
          db.query('UPDATE sessions SET hidden_at=?,updated_at=? WHERE id=?').run(at, at, sessionId);
          return ok('hidden' as const);
        }
        db.query("DELETE FROM runs WHERE kind='agent' AND session_id=?").run(sessionId);
        // Bun counts rows removed by the native-history cascades too.
        if (db.query('DELETE FROM sessions WHERE id=?').run(sessionId).changes < 1) {
          return fail(appError('session_not_found', 'session', 'Session 不存在。'));
        }
        return ok('permanent' as const);
      });
      return deleted.ok ? deleted.data : deleted;
    },
  };
}

export function createRunRepository(db: Database): RunRepository {
  return {
    create(input) {
      const result = transaction(db, () => {
        const inserted = db
          .query(
            `INSERT INTO runs
              (kind,session_id,scope_json,status,goal,input_json,config_json,cleanup_json,usage_json,created_at)
             VALUES ('provider',NULL,NULL,'created',?,?,?,?,?,?)`,
          )
          .run(input.goal, asJson(input.input), asJson(input.config), asJson(input.cleanup), asJson(input.usage), input.createdAt);
        const id = Number(inserted.lastInsertRowid);
        if (!Number.isSafeInteger(id)) throw new Error('unsafe_run_id');
        return id;
      });
      return result;
    },

    createAgent(input) {
      const created = transaction(db, () => {
        const session = db.query('SELECT status FROM sessions WHERE id=?').get(input.sessionId) as { status: string } | null;
        if (!session) return fail(appError('session_not_found', 'session', 'Session 不存在。'));
        if (session.status !== 'active') return fail(appError('session_archived', 'session', '归档 Session 不能继续执行。'));
        validatedScope(input.scope);
        const inserted = db.query(`INSERT INTO runs
          (kind,session_id,scope_json,status,goal,input_json,config_json,cleanup_json,usage_json,created_at)
          VALUES ('agent',?,?,'created',?,?,?,?,?,?)`)
          .run(input.sessionId, asJson(input.scope), input.goal, asJson(input.input), asJson(input.config),
            asJson(input.cleanup), asJson(input.usage), input.createdAt);
        const id = Number(inserted.lastInsertRowid);
        if (!Number.isSafeInteger(id) || id <= 0) throw new Error('unsafe_run_id');
        db.query('UPDATE sessions SET updated_at=? WHERE id=?').run(input.createdAt, input.sessionId);
        return ok(id);
      });
      return created.ok ? created.data : created;
    },

    createWorkspaceAgent(input) {
      const created = transaction(db, () => {
        const expected = WorkspaceExpectationSchema.safeParse(input.expected);
        if (!expected.success || input.sessionId !== input.expected.sessionId
          || !['answer', 'save-candidate'].includes(input.goalMode)) {
          return fail(appError('input_invalid', 'input', 'P3 Workspace Run 参数无效。'));
        }
        const session = db.query('SELECT status FROM sessions WHERE id=?').get(input.sessionId) as { status: string } | null;
        if (!session || session.status !== 'active') return fail(appError('session_archived', 'session', 'Session 不可用于新 Run。'));
        const rawWorkspace = ensureWorkspace(db, input.createdAt);
        const workspace = workspaceSnapshot(db, rawWorkspace, input.createdAt);
        const actualExpectation: WorkspaceExpectation = {
          revision: workspace.revision, documentRef: workspace.documentRef, jobId: workspace.jobId,
          candidateRef: workspace.candidateRef, sessionId: workspace.sessionId ?? 0,
        };
        const sameDocument = actualExpectation.documentRef?.id === expected.data.documentRef?.id
          && actualExpectation.documentRef?.version === expected.data.documentRef?.version;
        const sameCandidate = actualExpectation.candidateRef?.id === expected.data.candidateRef?.id
          && actualExpectation.candidateRef?.sequence === expected.data.candidateRef?.sequence;
        if (workspace.invalidReferences.length || actualExpectation.revision !== expected.data.revision
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
        if (input.goalMode === 'save-candidate' && (!job || !document)) {
          return fail(appError('state_conflict', 'input', '保存候选需要当前 Document 和 Job。'));
        }
        if (job?.status === 'completed') return fail(appError('job_completed', 'input', '已完成 Job 不能继续运行。'));

        let candidate: WorkspaceInput['candidate'] = null;
        if (job?.currentCandidateId !== null && job?.currentCandidateId !== undefined) {
          const row = db.query(`SELECT id,sequence,job_id,fields_json,lines_json,issues_json FROM invoice_candidates WHERE id=?`)
            .get(job.currentCandidateId) as { id: number; sequence: number; job_id: number; fields_json: string; lines_json: string; issues_json: string } | null;
          if (!row || row.job_id !== job.jobId) return fail(appError('state_conflict', 'input', '当前候选引用无效。'));
          candidate = {
            id: row.id, sequence: row.sequence,
            fields: CandidateDraftSchema.shape.fields.parse(readJson(row.fields_json, 'candidate_fields')),
            lines: CandidateDraftSchema.shape.lines.parse(readJson(row.lines_json, 'candidate_lines')),
            issues: z.array(InvoiceIssueSchema).max(1_000).parse(readJson(row.issues_json, 'candidate_issues')),
          };
        }
        const workspaceContext = WorkspaceContextSchema.parse({
          formatVersion: 1, revision: workspace.revision, documentRef: workspace.documentRef, jobId: workspace.jobId,
          candidateRef: workspace.candidateRef, sessionId: input.sessionId, activeView: workspace.activeView, selection: null,
        });
        const workspaceInput = WorkspaceInputSchema.parse({
          documentRef: workspace.documentRef,
          job: job ? { id: job.jobId, goal: job.goal } : null,
          candidate,
        });
        if (Buffer.byteLength(JSON.stringify(workspaceInput), 'utf8') > 512 * 1024) {
          return fail(appError('input_too_large', 'input', '冻结 Workspace 输入超过 512 KiB。'));
        }
        const allowedTools = !document ? [INVOICE_TOOL_NAMES[6]!, INVOICE_TOOL_NAMES[7]!]
          : !job ? INVOICE_TOOL_NAMES.slice(0, 9)
            : input.goalMode === 'save-candidate' ? [...INVOICE_TOOL_NAMES] : INVOICE_TOOL_NAMES.slice(0, 12);
        const scope = RunScopeSchema.parse({ version: 2, allowedTools,
          allowedDocumentIds: document ? [document.id] : [],
          allowedArtifactIds: document ? [document.parsed_artifact_id] : [],
          allowedResourcePaths: [],
        });
        const inputRecord = { version: 2, goal: input.goal, text: input.text, messageTimestamp: input.messageTimestamp, workspaceInput };
        const config = { ...input.config, goalMode: input.goalMode, workspaceContext };
        const inserted = db.query(`INSERT INTO runs(kind,session_id,job_id,scope_json,status,goal,input_json,config_json,cleanup_json,usage_json,created_at)
          VALUES ('agent',?,?,?,?,?,?,?,?,?,?)`)
          .run(input.sessionId, job?.jobId ?? null, asJson(scope), 'created', input.goal, asJson(inputRecord), asJson(config),
            asJson(input.cleanup), asJson(input.usage), input.createdAt);
        const runId = Number(inserted.lastInsertRowid);
        if (!Number.isSafeInteger(runId) || runId <= 0) throw new Error('unsafe_run_id');
        if (job) db.query("UPDATE jobs SET status='running',status_reason=NULL,updated_at=? WHERE id=? AND status!='completed'")
          .run(input.createdAt, job.jobId);
        db.query('UPDATE sessions SET updated_at=? WHERE id=?').run(input.createdAt, input.sessionId);
        return ok({ runId, jobId: job?.jobId ?? null, scope, workspaceContext, workspaceInput });
      });
      return created.ok ? created.data : created;
    },

    start(runId, config, startedAt) {
      try {
        const changed = db
          .query("UPDATE runs SET status='running', config_json=?, started_at=? WHERE id=? AND status='created'")
          .run(asJson(config), startedAt, runId).changes;
        return changed === 1
          ? ok(undefined)
          : fail(appError('run_state_invalid', 'runtime', 'Run 不处于可启动状态。', false, runId));
      } catch {
        return fail(databaseError(), runId);
      }
    },

    recordCancel(runId, requestedAt) {
      try {
        const changed = db
          .query("UPDATE runs SET cancel_requested_at=? WHERE id=? AND status IN ('created','running')")
          .run(requestedAt, runId).changes;
        return ok(changed === 1);
      } catch {
        return fail(databaseError(), runId);
      }
    },

    finish(runId, terminal) {
      const result = transaction(db, () => {
        const active = db.query("SELECT kind,session_id,job_id,config_json FROM runs WHERE id=? AND status IN ('created','running')")
          .get(runId) as { kind: 'provider' | 'agent'; session_id: number | null; job_id: number | null; config_json: string } | null;
        if (terminal.nativeHistoryUnusable !== undefined && typeof terminal.nativeHistoryUnusable !== 'boolean'
          || terminal.nativeHistoryUnusable === true && active?.kind === 'provider') throw new Error('invalid_native_history_terminal');
        const changed = db
          .query(
            `UPDATE runs SET
              status=?, output_json=?, error_json=?, cleanup_json=?, usage_json=?,
              input_tokens=?, output_tokens=?, total_tokens=?, cost=?, usage_complete=?,
              duration_ms=?, cancel_requested_at=COALESCE(cancel_requested_at,?), ended_at=?, stopped_at=?
             WHERE id=? AND status IN ('created','running')`,
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
          ).changes;
        if (changed === 1 && active?.kind === 'agent' && active.session_id !== null) {
          if (terminal.nativeHistoryUnusable === true) db.query('UPDATE session_native_history SET unusable=1 WHERE session_id=?').run(active.session_id);
          db.query('UPDATE sessions SET updated_at=? WHERE id=?').run(terminal.endedAt, active.session_id);
        }
        if (changed === 1 && active?.kind === 'agent' && active.job_id !== null) {
          const config = object(readJson(active.config_json, 'config'), 'config');
          const goalMode = config.goalMode === 'save-candidate' ? 'save-candidate' : 'answer';
          const needsInput = terminal.status === 'failed' && terminal.error?.code === 'agent_goal_not_met' && goalMode === 'save-candidate';
          const jobStatus = terminal.status === 'completed' || needsInput ? 'waiting'
            : terminal.status === 'cancelled' ? 'cancelled' : 'failed';
          const reason = needsInput ? 'needs_input'
            : terminal.status === 'completed' ? goalMode === 'save-candidate' ? 'review_candidate' : 'review_answer'
              : terminal.error?.code ?? terminal.status;
          const jobChanged = db.query("UPDATE jobs SET status=?,status_reason=?,updated_at=? WHERE id=? AND status='running'")
            .run(jobStatus, reason, terminal.endedAt, active.job_id).changes;
          if (jobChanged !== 1) throw new Error('job_terminal_state_invalid');
        }
        return changed === 1;
      });
      return result.ok ? result : { ...result, ...(result.error && runId !== undefined ? { runId } : {}) };
    },

    get(runId) {
      try {
        const row = db.query('SELECT * FROM runs WHERE id=?').get(runId) as RunRow | null;
        if (!row) return fail(appError('run_not_found', 'input', 'Run 不存在。', false, runId));
        return ok(snapshotFromRow(row));
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
        const mapped = (rows as RunRow[]).map((row) => snapshotFromRow(row) as AgentRunSnapshot);
        const hasMore = mapped.length > request.limit;
        const items = hasMore ? mapped.slice(0, request.limit) : mapped;
        return ok({ items, nextBeforeRunId: hasMore ? items.at(-1)?.runId ?? null : null });
      } catch {
        return fail(appError('storage_corrupt', 'storage', 'Session Run 列表无法读取。'));
      }
    },

    supplementUsage(runId, usageValue, tokens) {
      const result = transaction(db, () => {
        const row = db.query('SELECT usage_json,input_tokens,output_tokens,total_tokens,cost FROM runs WHERE id=? AND status IN (\'completed\',\'failed\',\'cancelled\')').get(runId) as { usage_json: string; input_tokens: number | null; output_tokens: number | null; total_tokens: number | null; cost: string | null } | null;
        if (!row) return false;
        const current = validatedUsage(readJson(row.usage_json, 'usage'));
        const currentValues = current.sdkValues;
        const incomingValues = usageValue.sdkValues;
        const conflicts = usageKeys.some((key) => currentValues?.[key] !== null && currentValues?.[key] !== undefined
          && incomingValues?.[key] !== null && incomingValues?.[key] !== undefined && currentValues[key] !== incomingValues[key]);
        const tokenConflicts = (row.input_tokens !== null && tokens.inputTokens !== null && row.input_tokens !== tokens.inputTokens)
          || (row.output_tokens !== null && tokens.outputTokens !== null && row.output_tokens !== tokens.outputTokens)
          || (row.total_tokens !== null && tokens.totalTokens !== null && row.total_tokens !== tokens.totalTokens)
          || (row.cost !== null && tokens.cost !== null && row.cost !== tokens.cost);
        if (conflicts || tokenConflicts) return false;
        const merged = mergeUsage(current, usageValue);
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
        return changed === 1;
      });
      return result.ok ? result : { ...result, ...(result.error && runId !== undefined ? { runId } : {}) };
    },

    failInterrupted(endedAt) {
      try {
        const error = asJson({ version: 1, ...appError('runtime_interrupted', 'runtime', '上一次进程退出，Run 未收口。') });
        const cleanup = asJson({ version: 1, stopped: false, stopReason: 'process-exit', errors: [], lateObservationRequired: true });
        const recovered = transaction(db, () => {
          const activeRuns = db.query("SELECT id FROM runs WHERE status IN ('created','running')").all() as Array<{ id: number }>;
          if (activeRuns.length === 0) return 0;
          if (hasTable(db, 'session_native_history')) db.query(`UPDATE session_native_history SET unusable=1
            WHERE session_id IN (SELECT session_id FROM runs WHERE kind='agent' AND status IN ('created','running'))`).run();
          if (hasTable(db, 'tool_calls')) db.query(`UPDATE tool_calls SET status='failed',
              result_json=json_object('version',1,'status','failed',
                'error',json_object('code','runtime_interrupted','category','runtime','message','The process exited during this tool call.','retryable',true),
                'committedCandidateId',(SELECT candidate.id FROM invoice_candidates candidate WHERE candidate.tool_call_id=tool_calls.id)),
              cleanup_json=json_object('version',1,'stopReason','process-exit','stopped',1,'errors',json('[]')),
              ended_at=COALESCE(ended_at,?),stopped_at=COALESCE(stopped_at,?)
            WHERE status IN ('requested','running')
              AND run_id IN (SELECT id FROM runs WHERE status IN ('created','running'))`).run(endedAt, endedAt);
          if (hasTable(db, 'jobs')) db.query(`UPDATE jobs SET status='failed',status_reason='runtime_interrupted',updated_at=?
            WHERE status!='completed' AND id IN (
              SELECT job_id FROM runs WHERE status IN ('created','running') AND job_id IS NOT NULL
            )`).run(endedAt);
          return db.query("UPDATE runs SET status='failed',error_json=?,cleanup_json=?,ended_at=? WHERE status IN ('created','running')")
            .run(error, cleanup, endedAt).changes;
        });
        return recovered;
      } catch {
        return fail(databaseError());
      }
    },
  };
}
