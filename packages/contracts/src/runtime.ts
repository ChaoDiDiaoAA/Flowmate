import { z } from 'zod';
import { WorkspaceInputSchema } from './workspace.ts';

export type DbId = number;

export type ModelRef = {
  provider: string;
  model: string;
};

export type ProviderApi = string;

export type ProductPaths = {
  root: string;
  databaseFile: string;
  logsDir: string;
  artifactsDir: string;
  outputsDir: string;
  runtimeDir: string;
};

export type RunStatus = 'created' | 'running' | 'completed' | 'failed' | 'cancelled';

export type ErrorCategory =
  | 'provider'
  | 'runtime'
  | 'tool'
  | 'session'
  | 'storage'
  | 'input'
  | 'extension'
  | 'internal';

export type AppError = {
  version?: 1;
  code: string;
  category: ErrorCategory;
  message: string;
  retryable: boolean;
  runId?: DbId;
  sessionId?: DbId;
  toolCallId?: string;
};

export const AppErrorSchema = z.object({
  version: z.literal(1).optional(),
  code: z.string().min(1),
  category: z.enum(['provider', 'runtime', 'tool', 'session', 'storage', 'input', 'extension', 'internal']),
  message: z.string(),
  retryable: z.boolean(),
  runId: z.number().int().positive().max(Number.MAX_SAFE_INTEGER).optional(),
  sessionId: z.number().int().positive().max(Number.MAX_SAFE_INTEGER).optional(),
  toolCallId: z.string().min(1).max(256).optional(),
}).strict();

export type Result<T> =
  | { ok: true; data: T }
  | { ok: false; error: AppError; runId?: DbId };

export type ProviderConfig = {
  version: 1;
  name: string;
  revision: number;
  modelRef: ModelRef;
  credentialRef?: string;
  native: {
    authPath: string;
    modelsPath: string | null;
  };
  connection?: {
    baseUrl: string;
    api: ProviderApi;
    contextWindow?: number;
    maxTokens?: number;
    reasoning?: boolean;
  };
  parameters: {
    maxRetries: number;
    maxRetryDelayMs: number;
  };
};

export type ProviderRequest = {
  goal: string;
  text: string;
  config: ProviderConfig;
  timeoutMs: number;
  stopGraceMs: number;
};

export type ProviderObservationType =
  | 'run_created'
  | 'request_budget'
  | 'model_request'
  | 'request_dispatched'
  | 'response_started'
  | 'text_delta'
  | 'stop_requested'
  | 'cancel_requested'
  | 'native_terminal'
  | 'stopped';

export type ProviderObservation = {
  runId: DbId;
  sequence: number;
  at: string;
  monotonicMs: number;
  type: ProviderObservationType;
  data: Readonly<Record<string, unknown>>;
};

export type ProviderControl = {
  signal?: AbortSignal;
  onObservation?: (event: ProviderObservation) => void;
};

export type UsageRecordV1 = {
  version: 1;
  source: 'sdk' | 'unknown' | 'not-requested';
  reason: string | null;
  sdkValues: SdkUsageValues | null;
  attempts: number | null;
  attemptsComplete: boolean;
  costSource: string | null;
  updatedAt: string;
};

export type UsageRecordV2 = Omit<UsageRecordV1, 'version'> & {
  version: 2;
  calls: { callSequence: number; usage: UsageRecordV1; tokens: TokenColumns }[];
};
export type UsageRecord = UsageRecordV1 | UsageRecordV2;

const sdkUsageValuesSchema = z.object({
  input: z.number().finite().nullable(), output: z.number().finite().nullable(),
  cacheRead: z.number().finite().nullable(), cacheWrite: z.number().finite().nullable(),
  totalTokens: z.number().finite().nullable(), costInput: z.number().finite().nullable(),
  costOutput: z.number().finite().nullable(), costCacheRead: z.number().finite().nullable(),
  costCacheWrite: z.number().finite().nullable(), costTotal: z.number().finite().nullable(),
}).strict();
const usageRecordV1Schema = z.object({
  version: z.literal(1),
  source: z.enum(['sdk', 'unknown', 'not-requested']),
  reason: z.string().nullable(),
  sdkValues: sdkUsageValuesSchema.nullable(),
  attempts: z.number().int().nonnegative().nullable(),
  attemptsComplete: z.boolean(),
  costSource: z.string().nullable(),
  updatedAt: z.string(),
}).strict();
const tokenColumnsSchema = z.object({
  inputTokens: z.number().int().nonnegative().nullable(),
  outputTokens: z.number().int().nonnegative().nullable(),
  totalTokens: z.number().int().nonnegative().nullable(),
  cost: z.string().nullable(),
  usageComplete: z.boolean(),
}).strict();
export const UsageRecordV2Schema = z.object({
  version: z.literal(2),
  source: z.enum(['sdk', 'unknown', 'not-requested']),
  reason: z.string().nullable(),
  sdkValues: sdkUsageValuesSchema.nullable(),
  attempts: z.number().int().nonnegative().nullable(),
  attemptsComplete: z.boolean(),
  costSource: z.string().nullable(),
  updatedAt: z.string(),
  calls: z.array(z.object({
    callSequence: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
    usage: usageRecordV1Schema,
    tokens: tokenColumnsSchema,
  }).strict()).max(12),
}).strict();

export type SdkUsageValues = {
  input: number | null;
  output: number | null;
  cacheRead: number | null;
  cacheWrite: number | null;
  totalTokens: number | null;
  costInput: number | null;
  costOutput: number | null;
  costCacheRead: number | null;
  costCacheWrite: number | null;
  costTotal: number | null;
};

export type TokenColumns = {
  inputTokens: number | null;
  outputTokens: number | null;
  totalTokens: number | null;
  cost: string | null;
  usageComplete: boolean;
};

export type InputRecordV1 = {
  version: 1;
  goal: string;
  text: string;
  messageTimestamp: number;
};
export type InputRecordV2 = Omit<InputRecordV1, 'version'> & {
  version: 2;
  workspaceInput: import('./workspace.ts').WorkspaceInput;
};
export type InputRecord = InputRecordV1 | InputRecordV2;
export const InputRecordV2Schema = z.object({
  version: z.literal(2), goal: z.string(), text: z.string(),
  messageTimestamp: z.number().finite(),
  workspaceInput: WorkspaceInputSchema,
}).strict();

export type OutputRecord = {
  version: 1;
  wireMaxTokens?: number | null;
  text: string;
  partial: boolean;
  stopReason: string;
  responseId: string | null;
  responseModel: string | null;
};

export type CleanupRecord = {
  version: 1;
  stopped: boolean;
  stopReason: string | null;
  errors: readonly AppError[];
  lateObservationRequired: boolean;
};

export type ProviderOutcome = {
  runId: DbId;
  status: 'completed' | 'failed' | 'cancelled';
  text: string;
  error: AppError | null;
  stopped: boolean;
  cleanupErrors: readonly AppError[];
};

export type ChatScope = {
  version: 1;
  mode: 'chat-text';
  toolNames: [];
  resourcePaths: [];
};

export type SessionAvailability = 'ready' | 'busy' | 'unusable' | 'history-unavailable' | 'archived';
export type SessionStatus = 'active' | 'archived';
export type SessionHistoryState = 'recoverable' | 'legacy-read-only' | 'invalid';

export type NativeSessionHistory = {
  storageVersion: 1;
  header: { type: 'session'; id: string; timestamp: string; cwd: string; version?: number; parentSession?: string };
  entries: readonly { type: string; id: string; parentId: string | null; timestamp: string; [key: string]: unknown }[];
  leafId: string | null;
  unusable: boolean;
};

export type SessionSnapshot = {
  sessionId: DbId;
  nativeSessionId: string;
  title: string;
  status: SessionStatus;
  createdAt: string;
  updatedAt: string;
  availability: SessionAvailability;
  historyState: SessionHistoryState;
  activeRunId: DbId | null;
  modelUseBlocked: boolean;
  hasBusinessHistory: boolean;
};

export type CreateSessionRequest = { title?: string; expectedRevision?: number };
export type RenameSessionRequest = { sessionId: DbId; title: string };

export type SessionCursor = { updatedAt: string; sessionId: DbId };
export type ListSessionsRequest = { limit?: number; before?: SessionCursor };
export type NormalizedListSessionsRequest = { limit: number; before?: SessionCursor };
export type SessionPage = { items: SessionSnapshot[]; next: SessionCursor | null };

export type AgentRunRequest = {
  sessionId: DbId;
  text: string;
  config: ProviderConfig;
  workspace?: import('./workspace.ts').WorkspaceExpectation;
  goalMode?: import('./workspace.ts').GoalMode;
  timeoutMs?: number;
  stopGraceMs?: number;
};

export type NormalizedAgentRunRequest = Omit<AgentRunRequest, 'timeoutMs' | 'stopGraceMs'> & {
  timeoutMs: number;
  stopGraceMs: number;
};

export type RunAccepted = { runId: DbId; sessionId: DbId };

export type AgentOutcome = ProviderOutcome & { sessionId: DbId; nativeSessionId: string };

export type RuntimeState = {
  active: { runId: DbId; sessionId: DbId | null; kind: 'provider' | 'agent' } | null;
  blocked: boolean;
  error: AppError | null;
};

export type AgentRunEvent = {
  runId: DbId;
  sessionId: DbId;
  nativeSessionId: string;
  sequence: number;
  at: string;
} & (
  | { type: 'run_progress'; phase: 'created' | 'running' | 'stopping'; reason?: string }
  | { type: 'text_delta'; text: string }
  | { type: 'tool_progress'; toolName: string; label: string; phase: 'running' | 'succeeded' | 'failed' | 'cancelled' }
  | { type: 'run_finished'; result: Result<AgentOutcome> }
);

export type AgentControl = { onEvent?: (event: AgentRunEvent) => void };

export type SessionRunsRequest = { sessionId: DbId; beforeRunId?: DbId; limit?: number };
export type NormalizedSessionRunsRequest = { sessionId: DbId; beforeRunId?: DbId; limit: number };
export type SessionRunsPage = { items: AgentRunSnapshot[]; nextBeforeRunId: DbId | null };

export type RunSnapshotBase = {
  runId: DbId;
  jobId: DbId | null;
  status: RunStatus;
  input: Readonly<InputRecord>;
  config: Readonly<Record<string, unknown>>;
  output: Readonly<Record<string, unknown>> | null;
  usage: Readonly<UsageRecord>;
  tokens: TokenColumns;
  durationMs: number | null;
  toolCallCount: number;
  error: AppError | null;
  cleanup: Readonly<Record<string, unknown>>;
  createdAt: string;
  startedAt: string | null;
  endedAt: string | null;
  cancelRequestedAt: string | null;
  stoppedAt: string | null;
};

export type ProviderRunSnapshot = RunSnapshotBase & {
  kind: 'provider';
  jobId: null;
  sessionId: null;
  scope: null;
};

export type AgentRunSnapshot = RunSnapshotBase & {
  kind: 'agent';
  jobId: DbId | null;
  sessionId: DbId;
  scope: ChatScope | import('./tools.ts').RunScope;
};

export type RunSnapshot = ProviderRunSnapshot | AgentRunSnapshot;

export type CloseReport = {
  stopped: boolean;
  closed: boolean;
  errors: readonly AppError[];
};

export interface Application {
  callProvider(
    request: ProviderRequest,
    control?: ProviderControl,
  ): Promise<Result<ProviderOutcome>>;
  queryRun(runId: DbId): Promise<Result<RunSnapshot>>;
  createSession(request?: CreateSessionRequest): Promise<Result<SessionSnapshot>>;
  renameSession(request: RenameSessionRequest): Promise<Result<SessionSnapshot>>;
  deleteSession(sessionId: DbId): Promise<Result<{ deletedSessionId: DbId }>>;
  listSessions(request?: ListSessionsRequest): Promise<Result<SessionPage>>;
  querySession(sessionId: DbId): Promise<Result<SessionSnapshot>>;
  listSessionRuns(request: SessionRunsRequest): Promise<Result<SessionRunsPage>>;
  queryPromptTrace(runId: DbId, callSequence?: number): Promise<Result<import('./diagnostics.ts').PromptTraceResult>>;
  startRun(request: AgentRunRequest, control?: AgentControl): Promise<Result<RunAccepted>>;
  readWorkspace(): Promise<Result<import('./workspace.ts').WorkspaceSnapshot>>;
  updateWorkspace(input: { expectedRevision: number; change: import('./workspace.ts').WorkspaceChange }): Promise<Result<import('./workspace.ts').WorkspaceSnapshot>>;
  startTask(input: import('./workspace.ts').StartTaskRequest): Promise<Result<import('./workspace.ts').TaskOperation>>;
  queryTaskOperation(clientSequence: DbId): Promise<Result<import('./workspace.ts').TaskOperation | null>>;
  selectCandidate(input: import('./workspace.ts').SelectCandidateRequest): Promise<Result<import('./workspace.ts').CandidateSelection>>;
  listDocuments(request?: import('./workspace.ts').PageRequest): Promise<Result<import('./workspace.ts').Page<import('./workspace.ts').DocumentSnapshot>>>;
  queryDocument(documentId: DbId): Promise<Result<import('./workspace.ts').DocumentSnapshot>>;
  listJobs(request?: import('./workspace.ts').JobPageRequest): Promise<Result<import('./workspace.ts').Page<import('./workspace.ts').JobSnapshot>>>;
  queryJob(jobId: DbId): Promise<Result<import('./workspace.ts').JobSnapshot>>;
  hideJob(jobId: DbId): Promise<Result<import('./workspace.ts').JobSnapshot>>;
  listJobCandidates(request: import('./workspace.ts').CandidateJobPageRequest): Promise<Result<import('./workspace.ts').CandidateJobPage>>;
  queryJobCandidate(request: { jobId: DbId; candidateId: DbId }): Promise<Result<import('./workspace.ts').CandidateJobDetail>>;
  listActivity(request: import('./activity.ts').ActivityPageRequest): Promise<Result<import('./workspace.ts').Page<import('./activity.ts').BusinessEventSnapshot>>>;
  importInvoiceMaterial(sourceDirectory: string): Promise<Result<import('./workspace.ts').DocumentSnapshot>>;
  readDocumentPage(input: import('./invoice.ts').InvoiceToolInput<'read_invoice_document'>): Promise<Result<import('./invoice.ts').InvoiceToolOutput<'read_invoice_document'>>>;
  readDocumentOriginal(documentId: DbId, page: number): Promise<Result<import('./workspace.ts').DocumentOriginalImage>>;
  revokeDocumentUse(documentId: DbId): Promise<Result<{ affectedSessionIds: DbId[]; stopRequested: boolean }>>;
  cancelRun(runId: DbId): Promise<Result<{ accepted: boolean; runId: DbId }>>;
  queryRuntimeState(): Promise<Result<RuntimeState>>;
  close(): Promise<Result<CloseReport>>;
}
