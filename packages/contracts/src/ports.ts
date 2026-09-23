import type {
  AppError,
  CloseReport,
  ModelRef,
  ProviderConfig,
  Result,
  UsageRecord,
  TokenColumns,
} from './runtime.ts';

export type OutputBudget = {
  version: 1;
  policy: 'model-aware/v1';
  requestedMaxTokens: number | null;
  selectedMaxTokens: number;
  modelMaxTokens: number | null;
  automaticCap: number;
  source: 'explicit' | 'model-metadata' | 'fallback';
};

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
  outputBudget?: OutputBudget;
  limits: { timeoutMs: number; stopGraceMs: number };
  native: { authSource: 'pi-native' | 'pi-runtime-api-key'; modelsSelection: string | null };
};

export type NativeInput = {
  goal: string;
  text: string;
  messageTimestamp: number;
};

export type NativeObservation = {
  type: 'model_request' | 'request_budget' | 'request_dispatched' | 'response_started' | 'text_delta' | 'native_terminal';
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
