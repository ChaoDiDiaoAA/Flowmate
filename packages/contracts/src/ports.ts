import type {
  AppError,
  AgentConfigFacts,
  AgentRunRequest,
  ChatScope,
  CloseReport,
  DbId,
  ModelRef,
  ProviderConfig,
  Result,
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
  native: { authSource: 'pi-native' | 'pi-runtime-api-key'; modelsSelection: string | null };
};

export type NativeInput = {
  goal: string;
  text: string;
  messageTimestamp: number;
};

export type NativeObservation = {
  type: 'model_request' | 'request_budget' | 'request_dispatched' | 'response_started' | 'text_delta' | 'native_terminal' | 'agent_event';
  at: string;
  monotonicMs: number;
  data: Readonly<Record<string, unknown>>;
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

export type AgentConfigSnapshot = SafeConfigSnapshot & { agent: AgentConfigFacts };
export type AgentNativeOutcome = NativeOutcome & { agent: { nativeSessionId: string; turnCount: number; modelCallCount: number } };
export type AgentExecutionInput = NativeInput & { runId: DbId; sessionId: DbId };

export interface PreparedAgent {
  snapshot: AgentConfigSnapshot;
  execute(input: AgentExecutionInput, signal: AbortSignal, observe: (event: NativeObservation) => void): Promise<AgentNativeOutcome>;
}

export interface AgentPort {
  createSession(): Result<{ nativeSessionId: string }>;
  inspect(nativeSessionId: string): { availability: 'ready' | 'busy' | 'unusable' | 'missing' };
  prepare(nativeSessionId: string, config: AgentRunRequest['config'], limits: { timeoutMs: number; stopGraceMs: number }, signal: AbortSignal): Promise<Result<PreparedAgent>>;
  releaseSession(nativeSessionId: string): Promise<CloseReport>;
  close(): Promise<CloseReport>;
}
