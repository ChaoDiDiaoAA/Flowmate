import { z } from 'zod';
import { WorkspaceInputSchema } from './workspace.ts';
import { RUNTIME_CONFIG } from './runtime-config.ts';

export type DbId = number;

export const RuntimeBudgetOverridesSchema = z.object({
  maxToolCalls: z.number().int().min(RUNTIME_CONFIG.ranges.maxToolCalls.min).max(RUNTIME_CONFIG.ranges.maxToolCalls.max).optional(),
  maxModelCalls: z.number().int().min(RUNTIME_CONFIG.ranges.maxModelCalls.min).max(RUNTIME_CONFIG.ranges.maxModelCalls.max).optional(),
  toolTimeoutMs: z.number().int().min(RUNTIME_CONFIG.ranges.toolTimeoutMs.min).max(RUNTIME_CONFIG.ranges.toolTimeoutMs.max).optional(),
}).strict();
export type RuntimeBudgetOverrides = z.infer<typeof RuntimeBudgetOverridesSchema>;
export const RuntimeRequestOverridesSchema = z.object({
  budget: RuntimeBudgetOverridesSchema.optional(),
  timeoutMs: z.number().int().min(RUNTIME_CONFIG.ranges.timeoutMs.min).max(RUNTIME_CONFIG.ranges.timeoutMs.max).optional(),
  stopGraceMs: z.number().int().min(RUNTIME_CONFIG.ranges.stopGraceMs.min).max(RUNTIME_CONFIG.ranges.stopGraceMs.max).optional(),
}).strict();
export type RuntimeRequestOverrides = z.infer<typeof RuntimeRequestOverridesSchema>;
export type ResolvedRuntimeBudget = Required<RuntimeBudgetOverrides>;

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
export const UsageRecordV1Schema = usageRecordV1Schema;
export const TokenColumnsSchema = tokenColumnsSchema;
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
  }).strict()).max(64),
}).strict();
export const UsageRecordSchema = z.union([UsageRecordV1Schema, UsageRecordV2Schema]);

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
  version: 1 | 2;
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
  deletePending: boolean;
};

export type MessageTextBlock = { type: 'text'; text: string };
export type MessageToolCallBlock = { type: 'toolCall'; id: string; name: string };
export type MessageDisplayBlock = MessageTextBlock | MessageToolCallBlock;
export type SessionMessageViewBase = {
  entryId: string | null; runId: DbId | null; liveOrdinal: number | null;
  timestamp: number; persistence: 'pending' | 'saved' | 'failed'; truncated: boolean;
};
export type SessionUserMessageView = SessionMessageViewBase & {
  role: 'user'; blocks: MessageTextBlock[]; phase: 'ended'; stopReason: null;
  toolCallId: null; toolName: null; isError: null; textOrigin: 'product-input' | 'native-content';
};
export type SessionAssistantMessageView = SessionMessageViewBase & {
  role: 'assistant'; blocks: MessageDisplayBlock[]; phase: 'streaming' | 'ended';
  stopReason: 'pending' | 'stop' | 'length' | 'toolUse' | 'error' | 'aborted' | 'deferred';
  toolCallId: null; toolName: null; isError: null; textOrigin: 'native-content' | null;
};
export type SessionToolResultMessageView = SessionMessageViewBase & {
  role: 'toolResult'; blocks: MessageTextBlock[]; phase: 'ended'; stopReason: null;
  toolCallId: string; toolName: string; isError: boolean; textOrigin: null;
};
export type SessionMessageView = SessionUserMessageView | SessionAssistantMessageView | SessionToolResultMessageView;
export type SessionMessagesRequest = { sessionId: DbId; beforeEntryId?: string; limit?: number };
export type NormalizedSessionMessagesRequest = { sessionId: DbId; beforeEntryId?: string; limit: number };
export type SessionMessagesPage = {
  session: SessionSnapshot; leafId: string | null; entryCount: number;
  items: SessionMessageView[]; nextBeforeEntryId: string | null;
};
export type NativeEntryRunBinding = { entryId: string; runId: DbId };
export type NativeEntryLiveBinding = NativeEntryRunBinding & { liveOrdinal: number };
export type NativeHistoryAppendContext = NativeEntryRunBinding & { inputId?: DbId; resultInputIds?: DbId[];
  resourceExpansion?: import('./resources.ts').ResourceExpansionEvidence };
export type NativeHistoryDisplayRecord = { history: NativeSessionHistory | null; bindings: NativeEntryRunBinding[] };
export type MessageRunInput = {
  runId: DbId; input: Readonly<InputRecord>; goalMode: import('./workspace.ts').GoalMode | null;
  workingDirectory?: string;
  workspaceContext?: import('./workspace.ts').WorkspaceContext;
};
export type NativeMessageProjectionInput = {
  history: NativeSessionHistory; bindings: NativeEntryRunBinding[]; runInputs: MessageRunInput[];
  sessionInputs?: readonly MessageSessionInput[];
  beforeEntryId?: string; limit: number; liveBindings?: readonly NativeEntryLiveBinding[];
};
export type MessageSessionInput = { inputId: DbId; runId: DbId; nativeEntryId: string;
  resourceExpansion?: import('./resources.ts').ResourceExpansionEvidence;
  content: import('./session-inputs.ts').SessionInputContent };
export type SetSessionStatusRequest = { sessionId: DbId; expectedStatus: SessionStatus; status: SessionStatus };
export type BranchSessionRequest = { sessionId: DbId; expectedLeafId: string | null; expectedEntryCount: number; expectedCommitRevision: number; targetEntryId: string };
export type BranchSessionResult = { session: SessionSnapshot; leafId: string; entryCount: number };

const messageDbIdSchema = z.number().int().positive().max(Number.MAX_SAFE_INTEGER);
const messageIdSchema = z.string().min(1);
const messageCursorSchema = messageIdSchema.max(128);
export const SetSessionStatusRequestSchema = z.object({ sessionId: messageDbIdSchema,
  expectedStatus: z.enum(['active', 'archived']), status: z.enum(['active', 'archived']) }).strict();
export const BranchSessionRequestSchema = z.object({ sessionId: messageDbIdSchema,
  expectedLeafId: messageIdSchema.max(256).nullable(), expectedEntryCount: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
  expectedCommitRevision: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
  targetEntryId: messageIdSchema.max(256) }).strict();
export function normalizeSetSessionStatusRequest(raw: unknown): Result<SetSessionStatusRequest> {
  const parsed = SetSessionStatusRequestSchema.safeParse(raw);
  return parsed.success ? { ok: true, data: parsed.data } : { ok: false,
    error: { code: 'input_invalid', category: 'input', message: 'Session status request is invalid.', retryable: false } };
}
export function normalizeBranchSessionRequest(raw: unknown): Result<BranchSessionRequest> {
  const parsed = BranchSessionRequestSchema.safeParse(raw);
  return parsed.success ? { ok: true, data: parsed.data } : { ok: false,
    error: { code: 'input_invalid', category: 'input', message: 'Session branch request is invalid.', retryable: false } };
}
const messageTextBlockSchema = z.object({ type: z.literal('text'), text: z.string() }).strict();
const messageToolCallBlockSchema = z.object({ type: z.literal('toolCall'), id: messageIdSchema, name: messageIdSchema }).strict();
const messageBaseShape = {
  entryId: messageIdSchema.nullable(), runId: messageDbIdSchema.nullable(), liveOrdinal: messageDbIdSchema.nullable(),
  timestamp: z.number().finite(), persistence: z.enum(['pending', 'saved', 'failed']), truncated: z.boolean(),
};
const messageNullResultShape = { toolCallId: z.null(), toolName: z.null(), isError: z.null() };
export const SessionMessageViewSchema: z.ZodType<SessionMessageView> = z.discriminatedUnion('role', [
  z.object({ ...messageBaseShape, ...messageNullResultShape, role: z.literal('user'),
    blocks: z.array(messageTextBlockSchema).max(256), phase: z.literal('ended'), stopReason: z.null(),
    textOrigin: z.enum(['product-input', 'native-content']) }).strict(),
  z.object({ ...messageBaseShape, ...messageNullResultShape, role: z.literal('assistant'),
    blocks: z.array(z.discriminatedUnion('type', [messageTextBlockSchema, messageToolCallBlockSchema])).max(256),
    phase: z.enum(['streaming', 'ended']), stopReason: z.enum(['pending', 'stop', 'length', 'toolUse', 'error', 'aborted', 'deferred']),
    textOrigin: z.literal('native-content').nullable() }).strict(),
  z.object({ ...messageBaseShape, role: z.literal('toolResult'), blocks: z.array(messageTextBlockSchema).max(256),
    phase: z.literal('ended'), stopReason: z.null(), toolCallId: messageIdSchema, toolName: messageIdSchema,
    isError: z.boolean(), textOrigin: z.null() }).strict(),
]).superRefine((message, context) => {
  const textBytes = message.blocks.reduce((sum, block) => sum + (block.type === 'text' ? new TextEncoder().encode(block.text).length : 0), 0);
  if (textBytes > 65_536) context.addIssue({ code: 'custom', message: 'Message display text exceeds its byte limit.' });
  if (message.persistence === 'saved' && message.entryId === null) context.addIssue({ code: 'custom', message: 'Saved message needs an entry identity.' });
  if (message.role === 'assistant' && (message.blocks.some(block => block.type === 'text') !== (message.textOrigin === 'native-content'))) {
    context.addIssue({ code: 'custom', message: 'Assistant text origin must describe the projected blocks.' });
  }
});

export const SessionMessagesRequestSchema = z.object({ sessionId: messageDbIdSchema,
  beforeEntryId: messageCursorSchema.optional(), limit: z.number().int().min(1).max(100).default(50) }).strict();
export function normalizeSessionMessagesRequest(raw: unknown): Result<NormalizedSessionMessagesRequest> {
  const parsed = SessionMessagesRequestSchema.safeParse(raw);
  return parsed.success ? { ok: true, data: parsed.data } : { ok: false,
    error: { code: 'input_invalid', category: 'input', message: 'Conversation message query is invalid.', retryable: false } };
}
export const SessionSnapshotSchema: z.ZodType<SessionSnapshot> = z.object({
  sessionId: messageDbIdSchema, nativeSessionId: messageIdSchema, title: z.string(),
  status: z.enum(['active', 'archived']), createdAt: z.string().datetime({ offset: true }), updatedAt: z.string().datetime({ offset: true }),
  availability: z.enum(['ready', 'busy', 'unusable', 'history-unavailable', 'archived']),
  historyState: z.enum(['recoverable', 'legacy-read-only', 'invalid']), activeRunId: messageDbIdSchema.nullable(),
  modelUseBlocked: z.boolean(), hasBusinessHistory: z.boolean(), deletePending: z.boolean(),
}).strict();
export const SessionMessagesPageSchema: z.ZodType<SessionMessagesPage> = z.object({
  session: SessionSnapshotSchema, leafId: messageIdSchema.nullable(), entryCount: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
  items: z.array(SessionMessageViewSchema).max(100), nextBeforeEntryId: messageCursorSchema.nullable(),
}).strict().superRefine((page, context) => {
  if (page.items.some(item => item.phase !== 'ended' || item.persistence !== 'saved' || item.entryId === null)) {
    context.addIssue({ code: 'custom', message: 'Message queries contain saved, ended entries only.' });
  }
  if (new TextEncoder().encode(JSON.stringify({ items: page.items, nextBeforeEntryId: page.nextBeforeEntryId })).length > 1_048_576) {
    context.addIssue({ code: 'custom', message: 'Message page exceeds its byte limit.' });
  }
});
export const MessageUpsertEventSchema = z.object({
  type: z.literal('message_upsert'), runId: messageDbIdSchema, sessionId: messageDbIdSchema,
  nativeSessionId: messageIdSchema, sequence: messageDbIdSchema, at: z.string().datetime({ offset: true }),
  message: SessionMessageViewSchema,
}).strict().superRefine((event, context) => {
  if (event.message.runId !== event.runId || event.message.liveOrdinal === null) {
    context.addIssue({ code: 'custom', message: 'Live message must belong to its Run and have its real ordinal.' });
  }
});

export type DeleteSessionResult = { deletedSessionId: DbId; disposition: 'hidden' | 'permanent' };

export type CreateSessionRequest = { title?: string; expectedRevision?: number };
export type RenameSessionRequest = { sessionId: DbId; title: string };

export type SessionCursor = { updatedAt: string; sessionId: DbId };
export type ListSessionsRequest = { limit?: number; before?: SessionCursor };
export type NormalizedListSessionsRequest = { limit: number; before?: SessionCursor };
export type SessionPage = { items: SessionSnapshot[]; next: SessionCursor | null };

export type AgentRunRequest = {
  requiredSkill?: import('./resources.ts').ResourceRef;
  sessionId: DbId;
  text: string;
  config: ProviderConfig;
  workspace?: import('./workspace.ts').WorkspaceExpectation;
  goalMode?: import('./workspace.ts').GoalMode;
  workingDirectory?: string;
  budget?: RuntimeBudgetOverrides;
  timeoutMs?: number;
  stopGraceMs?: number;
};

export type NormalizedAgentRunRequest = AgentRunRequest;

export type RunAccepted = { runId: DbId; sessionId: DbId; inputId?: DbId };

export type AgentOutcome = ProviderOutcome & { sessionId: DbId; nativeSessionId: string };

export type RuntimeState = {
  active: { runId: DbId; sessionId: DbId | null; kind: 'provider' | 'agent' }
    | { kind: 'compaction'; runId: null; sessionId: DbId; operationId: string } | null;
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
  | { type: 'message_upsert'; message: SessionMessageView }
  | { type: 'run_finished'; result: Result<AgentOutcome> }
);

export type AgentControl = { onEvent?: (event: AgentRunEvent) => void;
  /** Trusted Host digest of the canonical Desktop prompt, never a Renderer input field. */
  desktopRequestHash?: string };

export type SessionRunsRequest = { sessionId: DbId; beforeRunId?: DbId; limit?: number };
export type NormalizedSessionRunsRequest = { sessionId: DbId; beforeRunId?: DbId; limit: number };
export type SessionRunsPage = { items: AgentRunSnapshot[]; nextBeforeRunId: DbId | null };

export type RunSnapshotBase = {
  runId: DbId;
  currentContextSnapshotId: DbId | null;
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
  scope: ChatScope | import('./tools.ts').RunScope | import('./tools.ts').LegacyRunScope;
};

export type SubagentRunSnapshot = Omit<AgentRunSnapshot, 'kind' | 'scope'> & {
  kind: 'subagent'; scope: import('./tools.ts').RunScope;
  parentRunId: DbId; originToolCallId: DbId; pluginAgentId: string;
};
export type RunSnapshot = ProviderRunSnapshot | AgentRunSnapshot | SubagentRunSnapshot;

export type CloseReport = {
  stopped: boolean;
  closed: boolean;
  errors: readonly AppError[];
};

export interface Application {
  querySessionExtensions(input: import('./extensions.ts').SessionExtensionQuery): Promise<Result<import('./extensions.ts').SessionExtensionView>>;
  queryRunExtensions(input: import('./extensions.ts').RunExtensionQuery): Promise<Result<import('./extensions.ts').RunExtensionView>>;
  executeExtensionCommand(input: import('./extensions.ts').ExtensionCommandRequest): Promise<Result<import('./extensions.ts').ExtensionCommandReceipt>>;
  disposeSessionExtensions(input: import('./extensions.ts').ExtensionDisposeRequest): Promise<Result<import('./extensions.ts').ExtensionDisposeReceipt>>;
  listExtensions(): Promise<Result<import('./extensions.ts').ExtensionCatalog>>;
  updateExtensionSelection(input: import('./extensions.ts').ExtensionSelectionRequest): Promise<Result<import('./extensions.ts').ExtensionSelectionResult>>;
  validateExtensionSelection(selection: import('./extensions.ts').ExtensionSelection): Result<void>;
  listResources(): Promise<Result<import('./resources.ts').ResourceCatalog>>;
  readResourceFile(input: import('./resources.ts').ResourceFileRequest): Promise<Result<import('./resources.ts').ResourceFilePage>>;
  updateResourceSelection(input: import('./resources.ts').ResourceSelectionRequest): Promise<Result<import('./resources.ts').ResourceSelectionResult>>;
  queryRunResources(input: import('./resources.ts').RunResourceQuery): Promise<Result<import('./resources.ts').RunResourceView>>;
  readRunResourceFile(input: import('./resources.ts').RunResourceFileRequest): Promise<Result<import('./resources.ts').ResourceFilePage>>;
  /** Host configuration validation only; never exposed to Renderer/IPC. */
  validateResourceSelection(selection: import('./resources.ts').ResourceSelection, extensions?: import('./extensions.ts').ExtensionSelection): Result<void>;
  callProvider(
    request: ProviderRequest,
    control?: ProviderControl,
  ): Promise<Result<ProviderOutcome>>;
  queryRun(runId: DbId): Promise<Result<RunSnapshot>>;
  queryRuntimeEvents(input: import('./events.ts').RuntimeEventsQuery): Promise<import('./events.ts').RuntimeEventsReadResult>;
  subscribeRuntimeEvents(input: import('./events.ts').RuntimeEventsSubscriptionRequest,
    listener: (wake: import('./events.ts').RuntimeEventsAvailable) => void): Promise<Result<import('./events.ts').RuntimeEventSubscription>>;
  listRunToolCalls(input: import('./events.ts').RunToolCallsRequest): Promise<Result<import('./workspace.ts').Page<import('./events.ts').RuntimeToolView>>>;
  queryRunToolCall(input: import('./events.ts').RunToolCallRequest): Promise<Result<import('./events.ts').RuntimeToolView>>;
  listContextSnapshots(input: import('./context.ts').ContextSnapshotsRequest): Promise<Result<import('./context.ts').ContextSnapshotsPage>>;
  queryContextSnapshot(input: import('./context.ts').ContextSnapshotRequest): Promise<Result<import('./context.ts').ContextSnapshotDetail>>;
  listContextRequests(input: import('./context.ts').ContextRequestsRequest): Promise<Result<import('./context.ts').ContextRequestsPage>>;
  createSession(request?: CreateSessionRequest): Promise<Result<SessionSnapshot>>;
  queryNativeTools(): Promise<Result<readonly import('./tools.ts').NativeToolAvailability[]>>;
  renameSession(request: RenameSessionRequest): Promise<Result<SessionSnapshot>>;
  deleteSession(sessionId: DbId): Promise<Result<DeleteSessionResult>>;
  listSessions(request?: ListSessionsRequest): Promise<Result<SessionPage>>;
  querySession(sessionId: DbId): Promise<Result<SessionSnapshot>>;
  listSessionRuns(request: SessionRunsRequest): Promise<Result<SessionRunsPage>>;
  listSessionMessages(request: SessionMessagesRequest): Promise<Result<SessionMessagesPage>>;
  queryPromptTrace(runId: DbId, callSequence?: number): Promise<Result<import('./diagnostics.ts').PromptTraceResult>>;
  startRun(request: AgentRunRequest, control?: AgentControl): Promise<Result<RunAccepted>>;
  submitInput(request: import('./session-inputs.ts').SessionInputRequest, control?: AgentControl): Promise<Result<import('./session-inputs.ts').SessionInputAccepted>>;
  querySessionInput(request: import('./session-inputs.ts').SessionInputQuery): Promise<Result<import('./session-inputs.ts').SessionInputQueryResult>>;
  listSessionInputs(request: import('./session-inputs.ts').SessionInputsRequest): Promise<Result<import('./session-inputs.ts').SessionInputsPage>>;
  setSessionStatus(request: SetSessionStatusRequest): Promise<Result<SessionSnapshot>>;
  branchSession(request: BranchSessionRequest): Promise<Result<BranchSessionResult>>;
  querySessionHistory(input: import('./memory.ts').NativeHistoryPageRequest): Promise<Result<import('./memory.ts').NativeHistoryPage>>;
  querySessionHistoryEntry(input: import('./memory.ts').SessionHistoryEntryRequest): Promise<Result<import('./memory.ts').SessionHistoryEntryDetail>>;
  forkSession(input: import('./memory.ts').ForkSessionRequest): Promise<Result<import('./memory.ts').ForkSessionResult>>;
  queryInvoiceFormApplication(request: { runId: DbId; toolCallId: DbId }): Promise<Result<import('./invoice.ts').InvoiceFormApplicationReceipt>>;
  saveInvoiceCandidate(request: import('./invoice.ts').SaveInvoiceCandidateRequest): Promise<Result<import('./invoice.ts').SaveInvoiceCandidateResponse>>;
  acceptInvoiceCandidate(request: import('./invoice.ts').AcceptInvoiceCandidateRequest): Promise<Result<import('./invoice.ts').InvoiceCandidateDecisionResponse>>;
  rejectInvoiceCandidate(request: import('./invoice.ts').RejectInvoiceCandidateRequest): Promise<Result<import('./invoice.ts').InvoiceCandidateDecisionResponse>>;
  exportInvoiceCandidate(request: import('./invoice.ts').ExportInvoiceCandidateRequest): Promise<Result<import('./invoice.ts').InvoiceExportReference>>;
  queryInvoiceCandidateOperation(request: import('./invoice.ts').InvoiceCandidateOperationQuery): Promise<Result<import('./invoice.ts').InvoiceCandidateOperationResult>>;
  readWorkspace(): Promise<Result<import('./workspace.ts').WorkspaceSnapshot>>;
  updateWorkspace(input: { expectedRevision: number; change: import('./workspace.ts').WorkspaceChange }): Promise<Result<import('./workspace.ts').WorkspaceSnapshot>>;
  restoreWorkspace(): Promise<Result<import('./workspace.ts').WorkspaceRestoreResult>>;
  startTask(input: import('./workspace.ts').StartTaskRequest): Promise<Result<import('./workspace.ts').TaskOperation>>;
  queryTaskOperation(clientSequence: DbId): Promise<Result<import('./workspace.ts').TaskOperation | null>>;
  selectCandidate(input: import('./workspace.ts').SelectCandidateRequest): Promise<Result<import('./workspace.ts').CandidateSelection>>;
  listDocuments(request?: import('./workspace.ts').PageRequest): Promise<Result<import('./workspace.ts').Page<import('./workspace.ts').DocumentSnapshot>>>;
  queryDocument(documentId: DbId): Promise<Result<import('./workspace.ts').DocumentSnapshot>>;
  hideDocument(documentId: DbId): Promise<Result<{ documentId: DbId; affectedChatCount: number }>>;
  listJobs(request?: import('./workspace.ts').JobPageRequest): Promise<Result<import('./workspace.ts').Page<import('./workspace.ts').JobSnapshot>>>;
  queryJob(jobId: DbId): Promise<Result<import('./workspace.ts').JobSnapshot>>;
  hideJob(jobId: DbId): Promise<Result<import('./workspace.ts').JobSnapshot>>;
  listJobCandidates(request: import('./workspace.ts').CandidateJobPageRequest): Promise<Result<import('./workspace.ts').CandidateJobPage>>;
  queryJobCandidate(request: { jobId: DbId; candidateId: DbId }): Promise<Result<import('./workspace.ts').CandidateJobDetail>>;
  listActivity(request: import('./activity.ts').ActivityPageRequest): Promise<Result<import('./workspace.ts').Page<import('./activity.ts').BusinessEventSnapshot>>>;
  importInvoiceMaterial(sourceDirectory: string): Promise<Result<import('./workspace.ts').DocumentSnapshot>>;
  readDocumentPage(input: import('./invoice.ts').InvoiceToolInput<'read_invoice_document'>): Promise<Result<import('./invoice.ts').InvoiceToolOutput<'read_invoice_document'>>>;
  listDocumentPages(input: import('./invoice.ts').InvoiceToolInput<'list_invoice_pages'>): Promise<Result<import('./invoice.ts').InvoiceToolOutput<'list_invoice_pages'>>>;
  readDocumentOriginal(documentId: DbId, page: number): Promise<Result<import('./workspace.ts').DocumentOriginalImage>>;
  revokeDocumentUse(documentId: DbId): Promise<Result<{ affectedSessionIds: DbId[]; stopRequested: boolean }>>;
  cancelRun(runId: DbId): Promise<Result<{ accepted: boolean; runId: DbId }>>;
  listInputCommands(request?: { sessionId?: DbId }): Promise<Result<import('./input-commands.ts').InputCommandItem[]>>;
  listSubagentDefinitions(): Promise<Result<import('./input-commands.ts').SubagentDefinition[]>>;
  getSubagentDefinition(request: { id: string }): Promise<Result<import('./input-commands.ts').SubagentDefinition>>;
  saveSubagentDefinition(request: import('./input-commands.ts').SaveSubagentDefinition): Promise<Result<import('./input-commands.ts').SubagentDefinition>>;
  cancelSubagent(request: import('./subagents.ts').CancelSubagentRequest): Promise<Result<import('./subagents.ts').SubagentCancelReceipt>>;
  listSubagents(request: import('./subagents.ts').ListSubagentsRequest): Promise<Result<import('./subagents.ts').SubagentPage>>;
  querySubagent(request: import('./subagents.ts').QuerySubagentRequest): Promise<Result<import('./subagents.ts').SubagentDetail>>;
  queryRuntimeState(): Promise<Result<RuntimeState>>;
  compactSession(request: import('./compaction.ts').SessionCompactionRequest): Promise<Result<import('./compaction.ts').CompactionAccepted>>;
  querySessionCompaction(request: import('./compaction.ts').SessionCompactionQuery): Promise<Result<import('./compaction.ts').SessionCompactionSnapshot>>;
  cancelSessionCompaction(request: import('./compaction.ts').SessionCompactionCancel): Promise<Result<{ sessionId: DbId; operationId: string; accepted: boolean }>>;
  close(): Promise<Result<CloseReport>>;
}
