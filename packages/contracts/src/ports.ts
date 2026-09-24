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
} from './runtime.ts';

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

export type AgentFacts = { nativeSessionId: string; turnCount: number; modelCallCount: number };

export type AgentPortAvailability = 'ready' | 'busy' | 'unusable' | 'missing';

export type AgentNativeOutcome = NativeOutcome & { agent: AgentFacts };

export type AgentExecutionInput = NativeInput & { runId: DbId; sessionId: DbId };

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
  snapshot: SafeConfigSnapshot & { agent: AgentConfigFacts };
  execute(
    input: AgentExecutionInput,
    signal: AbortSignal,
    observe: (event: NativeObservation) => void,
  ): Promise<AgentNativeOutcome>;
}

export interface AgentPort {
  createSession(): Result<{ nativeSessionId: string }>;
  inspect(nativeSessionId: string): {
    availability: AgentPortAvailability;
    boundConfig: ProviderConfig | null;
    boundModel: SessionSnapshot['boundModel'];
  };
  prepare(
    nativeSessionId: string,
    config: ProviderConfig,
    limits: { timeoutMs: number; stopGraceMs: number },
    signal: AbortSignal,
  ): Promise<Result<PreparedAgent>>;
  releaseSession(nativeSessionId: string): Promise<CloseReport>;
  close(): Promise<CloseReport>;
}
