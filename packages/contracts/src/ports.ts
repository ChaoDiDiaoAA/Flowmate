import type { FrozenInputDefinitions } from './input-commands.ts';
import { z } from 'zod';
import { ToolRuntimeObservationSchema } from './activity.ts';
import { RegisteredToolNameSchema } from './tools.ts';
import type {
  AppError,
  CloseReport,
  DbId,
  ModelRef,
  ProviderConfig,
  Result,
  SessionSnapshot,
  UsageRecord,
  TokenColumns,
  SessionMessageView,
  SessionMessagesPage,
  NativeMessageProjectionInput,
  ResolvedRuntimeBudget,
} from './runtime.ts';
import type { ProductToolContext, ToolCallContext, ToolResult } from './tools.ts';
import type { CandidateJobDetail, CandidateJobPage, GoalMode, WorkspaceContext, WorkspaceInput } from './workspace.ts';
import type { ToolCallDelivery } from './activity.ts';
import type { CandidateSnapshot } from './activity.ts';
import type { CandidateDraft, CandidateReceipt, CheckResult, InvoiceIssue, InvoiceToolOutput, InvoiceCandidateChildReportReference } from './invoice.ts';
import type { ContextHooks } from './context.ts';
import type { FrozenResources, ResourceBinding, ManagedFileContents } from './resources.ts';
import type { HistoryCommitState, HistoryCommitReceipt, NativeHistoryRecoverySeed, NativeHistoryWriter, NativeHistoryInspection } from './memory.ts';
import type { CompactionPolicy, CompactionCapacity, SavedCompactionView, CompactionObservation,
  NativeCompactionControl, NativeCompactionOutcome } from './compaction.ts';

export type SaveCandidateRecord = {
  runId: DbId;
  sessionId: DbId;
  nativeToolCallId: string;
  documentId: DbId;
  candidate: CandidateDraft;
  childReportRefs?: InvoiceCandidateChildReportReference[];
  checks: CheckResult[];
  issues: InvoiceIssue[];
  at: string;
};
export interface CandidateRepository {
  save(input: SaveCandidateRecord): Result<{ receipt: CandidateReceipt; candidate: CandidateSnapshot; created: boolean }>;
  listByJob(input: { jobId: DbId; beforeSequence: DbId | null; limit: number }): Result<CandidateJobPage>;
  readByJob(input: { jobId: DbId; candidateId: DbId }): Result<CandidateJobDetail>;
  listForRun(input: { runId: DbId; beforeSequence: DbId | null; limit: number; invoiceWork?: ProductToolContext['scope']['invoiceWork'] }): Result<InvoiceToolOutput<'list_invoice_candidates'>>;
  readForRun(input: { runId: DbId; candidateId: DbId; invoiceWork?: ProductToolContext['scope']['invoiceWork'] }): Result<InvoiceToolOutput<'get_invoice_candidate'>>;
}

export type SafeConfigSnapshot = {
  inputDefinitions?: FrozenInputDefinitions;
  inputCommandReceipt?: import('zod').z.infer<typeof import('./input-commands.ts').InputCommandReceiptSchema>;
  extensions?: import('./extensions.ts').FrozenExtensions;
  extensionAssembly?: import('./extensions.ts').ExtensionAssemblyEvidence;
  resources?: FrozenResources;
  compactionPolicy?: CompactionPolicy;
  version: 1 | 2;
  name: string;
  revision: number;
  requestedModel: ModelRef;
  resolvedModel: ModelRef | null;
  api: string | null;
  endpoint: string | null;
  sdk: { codingAgent: string; ai: string };
  parameters: ProviderConfig['parameters'];
  limits: { timeoutMs: number; stopGraceMs: number };
  native: { authSource: 'pi-native' | 'pi-runtime-api-key' | 'unknown'; modelsSelection: string | null };
  runtimeBudget?: ResolvedRuntimeBudget;
  runtimeStrategy?: RuntimeStrategySnapshot;
  contextPolicyVersion?: 'p8-context-v1';
  historyPolicyVersion?: 'p9-native-history-v1';
};

export type NativeInput = {
  goal: string;
  text: string;
  messageTimestamp: number;
};

export type AgentConfigFacts = {
  extensionPolicy?: 'none' | 'p12-managed-extensions-v1' | 'p13-managed-extensions-v1';
  policyVersion: 'p2-invoice-chat-v1';
  nativeSessionId: string;
  systemPrompt: string;
  thinkingLevel: string;
  resourcePolicy: 'none' | 'p11-resources-v1';
  historyPolicy: 'memory-only';
  maxContextBytes: 524_288;
  maxOutputBytes: 262_144;
  maxAssistantContentBytes: 524_288;
  maxModelCalls: 1;
  sessionRetry: false;
};

export type P3AgentConfigFacts = {
  extensionPolicy?: 'none' | 'p12-managed-extensions-v1' | 'p13-managed-extensions-v1';
  policyVersion: 'p3-invoice-tools-v1';
  nativeSessionId: string;
  systemPrompt: string;
  thinkingLevel: string;
  resourcePolicy: 'none' | 'p11-resources-v1';
  historyPolicy: 'memory-only';
  maxContextBytes: 8_388_608;
  maxOutputBytes: 262_144;
  maxAssistantContentBytes: 524_288;
  maxModelCalls: 12 | 16; // Old Run facts keep 12; new tool Runs use 16.
  maxToolCalls: 24;
  toolTimeoutMs: 10_000;
  sessionRetry: false;
};

export type P5ChatAgentConfigFacts = Omit<AgentConfigFacts, 'policyVersion' | 'maxModelCalls'> & {
  policyVersion: 'p5-session-inputs-v1'; maxModelCalls: 12;
};
export type RuntimeAgentConfigFacts = Omit<AgentConfigFacts, 'policyVersion' | 'maxContextBytes' | 'maxModelCalls'> & ResolvedRuntimeBudget & {
  policyVersion: 'runtime-v1';
  taskPolicyVersion: AgentConfigFacts['policyVersion'] | P3AgentConfigFacts['policyVersion'] | P5ChatAgentConfigFacts['policyVersion'];
  maxContextBytes: 524_288 | 8_388_608;
};
export type RunAgentConfigFacts = AgentConfigFacts | P3AgentConfigFacts | P5ChatAgentConfigFacts | RuntimeAgentConfigFacts;

// runtime-v1 已保存策略的固定读取边界，不跟随新 Run 的可调默认变化。
const observationFields = ToolRuntimeObservationSchema.innerType().shape;
const calibrationGroupSchema = z.object({
  toolName: RegisteredToolNameSchema,
  toolVersion: z.string().min(1).max(32),
  groupKey: observationFields.groupKey, attemptCount: z.number().int().min(0).max(200),
  eligibleCount: z.number().int().min(0).max(200), p95Ms: z.number().finite().nonnegative().nullable(),
  selectedTimeoutMs: z.number().finite().min(100).max(1_800_000),
  timeoutSource: z.enum(['configured', 'statistical']),
  fallbackReason: z.string().min(1).max(128).nullable(),
}).strict().refine(group => group.eligibleCount <= group.attemptCount
  && (group.timeoutSource !== 'statistical' || group.eligibleCount >= 20 && group.p95Ms !== null), 'Invalid calibration evidence.');
export const RuntimeStrategySnapshotSchema = z.object({
  version: z.literal('runtime-v1'), sampleSource: observationFields.sampleSource,
  calibration: z.object({ sourceCutoffToolCallId: z.number().int().min(0).max(Number.MAX_SAFE_INTEGER),
    groups: z.array(calibrationGroupSchema).max(128) }).strict()
    .refine(value => new Set(value.groups.map(group => group.toolName)).size === value.groups.length
      && new Set(value.groups.map(group => group.groupKey)).size === value.groups.length, 'Duplicate calibration group.'),
  experience: z.object({ version: z.literal(1), modelKey: z.string().min(1).max(1024), promptVersion: z.string().min(1).max(128),
    taskType: z.string().min(1).max(128), items: z.array(z.object({
      toolName: RegisteredToolNameSchema, failureStage: observationFields.failureStage,
      diagnosticCode: observationFields.diagnosticCode, afterStructure: observationFields.afterStructure,
      afterDomain: observationFields.afterDomain, timingComplete: z.boolean(), missingEvidence: z.boolean(),
      count: z.number().int().positive().max(200),
    }).strict()).max(64) }).strict(),
}).strict().refine(value => value.experience.items.every(item => value.calibration.groups.some(group => group.toolName === item.toolName)),
'Experience must use a frozen allowed tool.');
export type RuntimeStrategySnapshot = z.infer<typeof RuntimeStrategySnapshotSchema>;
export const RuntimeStrategyPolicySchema = z.object({ budgetAwareness: z.boolean(), statistics: z.boolean(), experience: z.boolean() }).strict();
export type RuntimeStrategyPolicy = z.infer<typeof RuntimeStrategyPolicySchema>;

export type AgentFacts = { nativeSessionId: string; turnCount: number; modelCallCount: number; candidateIds?: DbId[];
  confirmedUnconsumedInputIds?: DbId[]; modelCalls?: Array<{ callSequence: number; durationMs: number; complete: boolean }> };

export type AgentPortAvailability = 'ready' | 'busy' | 'unusable' | 'missing';

export type AgentNativeOutcome = NativeOutcome & { agent: AgentFacts };

export type AgentToolInvocation = { result: ToolResult<unknown>; fatal: boolean };
export type AgentToolBinding = {
  context: ProductToolContext;
  observeRequest(name: string, raw: unknown, call: ToolCallContext): Result<void> | Promise<Result<void>>;
  rejectRequest(name: string, raw: unknown, call: ToolCallContext, error: AppError, stage?: 'sdk_arguments' | 'sdk_before' | 'unknown'): Result<void> | Promise<Result<void>>;
  queryCall?(nativeToolCallId: string): Result<import('./activity.ts').ToolCallSnapshot> | Promise<Result<import('./activity.ts').ToolCallSnapshot>>;
  recordDelivery(nativeToolCallId: string, delivery: ToolCallDelivery): Result<void> | Promise<Result<void>>;
  /** Keep the observed model arguments separate from the SDK/Hook's final input. */
  execute(name: string, input: unknown, call: ToolCallContext, rawArguments?: unknown): Promise<AgentToolInvocation>;
};

export type AgentExecutionInput = NativeInput & {
  inputDefinitions?: FrozenInputDefinitions;
  extensions?: import('./extensions.ts').FrozenExtensions;
  resources?: FrozenResources;
  /** Trusted child visibility; the original immutable bundle remains intact. */
  visibleSkillRefs?: readonly import('./resources.ts').ResourceRef[];
  resourceBinding?: ResourceBinding;
  runId: DbId;
  sessionId: DbId;
  contextSnapshotId?: DbId;
  contextHooks?: ContextHooks;
  workspaceInput?: WorkspaceInput;
  workspaceContext?: WorkspaceContext;
  goalMode?: GoalMode;
  workingDirectory?: string;
  runtimeBudget?: ResolvedRuntimeBudget;
  runtimeStrategy?: RuntimeStrategySnapshot;
  remainingRunMs?: () => number;
  budgetAwareness?: boolean;
  toolBinding?: AgentToolBinding;
  verifyModelUse: () => Result<void> | Promise<Result<void>>;
  /** P13 root budget, charged once per actual HTTP attempt including retries. */
  reserveModelRequest?: () => Result<void>;
  /** Legacy direct SDK callers may omit these; complete product P5 paths always provide them. */
  inputId?: DbId;
  promptText?: string;
  verifyInputUse?: (inputIds: readonly DbId[]) => Result<void> | Promise<Result<void>>;
  completeInputResult?: (inputIds: readonly DbId[], resultEntryId: string) => Result<void> | Promise<Result<void>>;
  onInputAdmissionClosed?: () => void;
};

export type AgentNativeEventName =
  | 'agent_start' | 'agent_end' | 'agent_settled'
  | 'turn_start' | 'turn_end'
  | 'message_start' | 'message_update' | 'message_end'
  | 'tool_execution_start' | 'tool_execution_update' | 'tool_execution_end';

export type NativeObservation = {
  type: 'model_request' | 'request_budget' | 'request_dispatched' | 'response_started' | 'text_delta' | 'native_terminal';
  at: string;
  monotonicMs: number;
  data: Readonly<Record<string, unknown>>;
} | {
  type: 'agent_event';
  at: string;
  monotonicMs: number;
  data: Readonly<{
    eventName: AgentNativeEventName;
    role?: 'user' | 'assistant' | 'toolResult';
    stopReason?: string;
    turnOrdinal?: number;
    callSequence?: number;
    textBytes?: number;
  }>;
};

export type AgentObservation = NativeObservation
  | { type: 'display_text_delta'; text: string; at: string; monotonicMs: number }
  | { type: 'display_message'; message: SessionMessageView; at: string; monotonicMs: number };

export type NativeOutcome = {
  wireMaxTokens?: number | null;
  text: string;
  partial: boolean;
  stopReason: string;
  responseId: string | null;
  responseModel: string | null;
  error: AppError | null;
  usage: UsageRecord;
  tokens: TokenColumns;
  stopped: boolean;
  cleanupErrors: readonly AppError[];
};

export interface PreparedProvider {
  snapshot: SafeConfigSnapshot;
  execute(
    input: NativeInput,
    signal: AbortSignal,
    observe: (event: NativeObservation) => void,
  ): Promise<NativeOutcome>;
}

export interface ProviderPort {
  prepare(
    config: ProviderConfig,
    limits: { timeoutMs: number; stopGraceMs: number },
    signal: AbortSignal,
  ): Promise<Result<PreparedProvider>>;
  close(): Promise<CloseReport>;
}

export interface PreparedAgent {
  snapshot: SafeConfigSnapshot & { historyPolicyVersion: 'p9-native-history-v1'; agent: RunAgentConfigFacts };
  execute(
    input: AgentExecutionInput,
    signal: AbortSignal,
    observe: (event: AgentObservation) => void,
  ): Promise<AgentNativeOutcome>;
}

export interface AgentPort {
  invokeSubagent?(context: import('./tools.ts').ToolExecutionContext,
    args: import('./subagents.ts').DelegateArgs): Promise<import('./tools.ts').NativeToolOutput>;
  bindSubagents?(callbacks: import('./subagents.ts').SubagentCallbacks): void;
  requestSubagentStop?(input: { childRunId: DbId; childNativeSessionId: string; pluginAgentId: string }): Result<void>;
  inspectExtensions?(nativeSessionId: string): Result<import('./extensions.ts').NativeExtensionView>;
  executeExtensionCommand?(nativeSessionId: string, request: import('./extensions.ts').NativeExtensionCommandRequest): Promise<Result<import('./extensions.ts').NativeExtensionCommandReceipt>>;
  disposeExtensions?(nativeSessionId: string, expectedInstanceId: string): Promise<Result<import('./extensions.ts').NativeExtensionDisposeReceipt>>;
  compactSession?(nativeSessionId: string, control: NativeCompactionControl): Promise<NativeCompactionOutcome>;
  inspectSessionCompaction?(input: { history: import('./runtime.ts').NativeSessionHistory; seed: NativeHistoryRecoverySeed;
    commit: HistoryCommitState }): Result<{ capacity: CompactionCapacity; lastSaved: SavedCompactionView | null;
      operation: CompactionObservation | null }>;
  createSession(): Result<{ nativeSessionId: string }>;
  exportSession?(nativeSessionId: string): Result<import('./runtime.ts').NativeSessionHistory>;
  restoreSession?(nativeSessionId: string, history: import('./runtime.ts').NativeSessionHistory, seed: NativeHistoryRecoverySeed, commit: HistoryCommitState): Result<void>;
  watchSession?(nativeSessionId: string, commit: HistoryCommitState, seed: NativeHistoryRecoverySeed,
    save: NativeHistoryWriter): Result<void>;
  projectSessionMessages?(input: NativeMessageProjectionInput): Result<Pick<SessionMessagesPage, 'items' | 'nextBeforeEntryId'>>;
  enqueueInput?(nativeSessionId: string, input: AgentInputDispatch): Promise<Result<void>>;
  moveSessionLeaf?(nativeSessionId: string, targetEntryId: string): Promise<Result<import('./runtime.ts').NativeSessionHistory>>;
  restoreSessionLeaf?(nativeSessionId: string, committed: import('./runtime.ts').NativeSessionHistory, seed: NativeHistoryRecoverySeed, commit: HistoryCommitState): Result<void>;
  inspectSessionHistory?(input: { history: import('./runtime.ts').NativeSessionHistory; seed: NativeHistoryRecoverySeed }): Result<NativeHistoryInspection>;
  buildForkSessionHistory?(input: { source: import('./runtime.ts').NativeSessionHistory; targetEntryId: string }): Result<import('./runtime.ts').NativeSessionHistory>;
  inspect(nativeSessionId: string): {
    availability: AgentPortAvailability;
  };
  prepare(
    nativeSessionId: string,
    config: ProviderConfig,
    limits: { timeoutMs: number; stopGraceMs: number },
    signal: AbortSignal,
    options?: { activeToolNames?: readonly string[]; inputDefinitions?: FrozenInputDefinitions; inputCommandOwner?: { runId: DbId; sessionId: DbId; inputId: DbId }; chatDelegation?: boolean; researchPhase?: 'planning' | 'researching'; workingDirectory?: string; goalMode?: GoalMode; sessionInputs?: boolean;
      runtimeBudget?: ResolvedRuntimeBudget; runtimeStrategy?: RuntimeStrategySnapshot; compactionPolicy?: CompactionPolicy;
      resources?: FrozenResources; resourceContents?: Pick<ManagedFileContents, 'read'>;
      extensions?: import('./extensions.ts').FrozenExtensions; verifyExtensions?: () => Result<void> },
  ): Promise<Result<PreparedAgent>>;
  releaseSession(nativeSessionId: string): Promise<CloseReport>;
  close(): Promise<CloseReport>;
}

export type AgentInputDispatch = { inputId: DbId; runId: DbId; sessionId: DbId;
  resourceBinding?: ResourceBinding;
  contextSnapshotId?: DbId;
  mode: 'steer' | 'followUp'; text: string; promptText: string };
