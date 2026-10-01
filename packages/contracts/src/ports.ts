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
  NativeHistoryAppendContext,
  NativeMessageProjectionInput,
} from './runtime.ts';
import type { ProductToolContext, ToolCallContext, ToolResult } from './tools.ts';
import type { CandidateJobDetail, CandidateJobPage, GoalMode, WorkspaceInput } from './workspace.ts';
import type { ToolCallDelivery } from './activity.ts';
import type { CandidateSnapshot } from './activity.ts';
import type { CandidateDraft, CandidateReceipt, CheckResult, InvoiceIssue, InvoiceToolOutput } from './invoice.ts';

export type SaveCandidateRecord = {
  runId: DbId;
  sessionId: DbId;
  nativeToolCallId: string;
  documentId: DbId;
  candidate: CandidateDraft;
  checks: CheckResult[];
  issues: InvoiceIssue[];
  at: string;
};
export interface CandidateRepository {
  save(input: SaveCandidateRecord): Result<{ receipt: CandidateReceipt; candidate: CandidateSnapshot; created: boolean }>;
  listByJob(input: { jobId: DbId; beforeSequence: DbId | null; limit: number }): Result<CandidateJobPage>;
  readByJob(input: { jobId: DbId; candidateId: DbId }): Result<CandidateJobDetail>;
  listForRun(input: { runId: DbId; beforeSequence: DbId | null; limit: number }): Result<InvoiceToolOutput<'list_invoice_candidates'>>;
  readForRun(input: { runId: DbId; candidateId: DbId }): Result<InvoiceToolOutput<'get_invoice_candidate'>>;
}

export type SafeConfigSnapshot = {
  version: 1;
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
};

export type NativeInput = {
  goal: string;
  text: string;
  messageTimestamp: number;
};

export type AgentConfigFacts = {
  policyVersion: 'p2-invoice-chat-v1';
  nativeSessionId: string;
  systemPrompt: string;
  thinkingLevel: string;
  resourcePolicy: 'none';
  historyPolicy: 'memory-only';
  maxContextBytes: 524_288;
  maxOutputBytes: 262_144;
  maxAssistantContentBytes: 524_288;
  maxModelCalls: 1;
  sessionRetry: false;
};

export type P3AgentConfigFacts = {
  policyVersion: 'p3-invoice-tools-v1';
  nativeSessionId: string;
  systemPrompt: string;
  thinkingLevel: string;
  resourcePolicy: 'none';
  historyPolicy: 'memory-only';
  maxContextBytes: 8_388_608;
  maxOutputBytes: 262_144;
  maxAssistantContentBytes: 524_288;
  maxModelCalls: 12;
  maxToolCalls: 24;
  toolTimeoutMs: 10_000;
  sessionRetry: false;
};

export type RunAgentConfigFacts = AgentConfigFacts | P3AgentConfigFacts;

export type AgentFacts = { nativeSessionId: string; turnCount: number; modelCallCount: number; candidateIds?: DbId[] };

export type AgentPortAvailability = 'ready' | 'busy' | 'unusable' | 'missing';

export type AgentNativeOutcome = NativeOutcome & { agent: AgentFacts };

export type AgentToolInvocation = { result: ToolResult<unknown>; fatal: boolean };
export type AgentToolBinding = {
  context: ProductToolContext;
  observeRequest(name: string, raw: unknown, call: ToolCallContext): Result<void>;
  rejectRequest(name: string, raw: unknown, call: ToolCallContext, error: AppError): Result<void>;
  recordDelivery(nativeToolCallId: string, delivery: ToolCallDelivery): Result<void>;
  /** Keep the observed model arguments separate from the SDK/Hook's final input. */
  execute(name: string, input: unknown, call: ToolCallContext, rawArguments?: unknown): Promise<AgentToolInvocation>;
};

export type AgentExecutionInput = NativeInput & {
  runId: DbId;
  sessionId: DbId;
  workspaceInput?: WorkspaceInput;
  goalMode?: GoalMode;
  workingDirectory?: string;
  toolBinding?: AgentToolBinding;
  verifyModelUse: () => Result<void>;
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
  snapshot: SafeConfigSnapshot & { agent: RunAgentConfigFacts };
  execute(
    input: AgentExecutionInput,
    signal: AbortSignal,
    observe: (event: AgentObservation) => void,
  ): Promise<AgentNativeOutcome>;
}

export interface AgentPort {
  createSession(): Result<{ nativeSessionId: string }>;
  exportSession?(nativeSessionId: string): Result<import('./runtime.ts').NativeSessionHistory>;
  restoreSession?(nativeSessionId: string, history: import('./runtime.ts').NativeSessionHistory): Result<void>;
  watchSession?(nativeSessionId: string, save: (history: import('./runtime.ts').NativeSessionHistory, context?: NativeHistoryAppendContext) => Result<void>): Result<void>;
  projectSessionMessages?(input: NativeMessageProjectionInput): Result<Pick<SessionMessagesPage, 'items' | 'nextBeforeEntryId'>>;
  inspect(nativeSessionId: string): {
    availability: AgentPortAvailability;
  };
  prepare(
    nativeSessionId: string,
    config: ProviderConfig,
    limits: { timeoutMs: number; stopGraceMs: number },
    signal: AbortSignal,
    options?: { activeToolNames?: readonly string[]; workingDirectory?: string; goalMode?: GoalMode },
  ): Promise<Result<PreparedAgent>>;
  releaseSession(nativeSessionId: string): Promise<CloseReport>;
  close(): Promise<CloseReport>;
}
