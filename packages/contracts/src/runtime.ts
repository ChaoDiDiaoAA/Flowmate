export type DbId = number;

export type ModelRef = {
  provider: string;
  model: string;
};

export type ProviderApi =
  | 'openai-completions'
  | 'openai-responses'
  | 'anthropic-messages'
  | 'google-generative-ai';

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
};

export type Result<T> =
  | { ok: true; data: T }
  | { ok: false; error: AppError; runId?: DbId };

export type ProviderConfig = {
  version: 1;
  name: string;
  revision: number;
  modelRef: ModelRef;
  native: {
    authPath: string;
    modelsPath: string | null;
  };
  connection?: {
    baseUrl: string;
    api: ProviderApi;
  };
  parameters: {
    maxTokens: number;
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

export type UsageRecord = {
  version: 1;
  source: 'sdk' | 'unknown' | 'not-requested';
  reason: string | null;
  sdkValues: SdkUsageValues | null;
  attempts: number | null;
  attemptsComplete: boolean;
  costSource: string | null;
  updatedAt: string;
};

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

export type InputRecord = {
  version: 1;
  goal: string;
  text: string;
  messageTimestamp: number;
};

export type OutputRecord = {
  version: 1;
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

export type RunSnapshot = {
  runId: DbId;
  kind: 'provider';
  status: RunStatus;
  input: Readonly<Record<string, unknown>>;
  config: Readonly<Record<string, unknown>>;
  output: Readonly<Record<string, unknown>> | null;
  usage: Readonly<Record<string, unknown>>;
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
  close(): Promise<Result<CloseReport>>;
}
