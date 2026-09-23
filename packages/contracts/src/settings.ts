export type ProductApi = 'openai-completions' | 'openai-responses' | 'anthropic-messages' | 'google-generative-ai';

export type ModelProfile = {
  id: string;
  credentialRef: string;
  name: string;
  baseUrl: string;
  model: string;
  api: ProductApi;
};

export type ProductSettings = {
  version: 1;
  revision: number;
  profile: { displayName: string; theme: 'system' | 'light' | 'dark' };
  models: readonly ModelProfile[];
  defaultModelId: string | null;
  updatedAt: string;
};

export type DesktopState = {
  version: 1;
  ready: boolean;
  host: 'starting' | 'ready' | 'closing' | 'error';
  modelCredentials: Readonly<Record<string, 'missing' | 'configured' | 'unavailable'>>;
  settings: ProductSettings;
  appVersion: string;
  userDataPath: string;
};

export type ProviderTestRequest = {
  goal: string;
  text: string;
  modelId: string;
  timeoutMs?: number;
};

export type DesktopEvent =
  | { type: 'provider_observation'; requestId: string; runId: number; sequence: number; observation: string; at: string; data: Readonly<Record<string, unknown>> }
  | { type: 'provider_finished'; requestId: string; runId: number; result: import('./runtime.ts').Result<import('./runtime.ts').ProviderOutcome> }
  | { type: 'host_state'; state: DesktopState };

export type DesktopBridge = {
  getState(): Promise<import('./runtime.ts').Result<DesktopState>>;
  saveSettings(settings: ProductSettings, credentialUpdate?: { modelId: string; apiKey: string }): Promise<import('./runtime.ts').Result<ProductSettings>>;
  callProvider(input: ProviderTestRequest): Promise<import('./runtime.ts').Result<{ requestId: string; runId: number }>>;
  cancelProvider(requestId: string): Promise<import('./runtime.ts').Result<{ accepted: boolean; runId: number | null }>>;
  queryRun(runId: number): Promise<import('./runtime.ts').Result<import('./runtime.ts').RunSnapshot>>;
  subscribe(listener: (event: DesktopEvent) => void): () => void;
};
