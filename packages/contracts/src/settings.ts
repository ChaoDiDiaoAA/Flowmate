export type ProductApi = string;

export type ModelCatalogProvider = {
  id: string;
  name: string;
  /** Interactive options; an api_key provider may also resolve ambient credentials through Pi. */
  authMethods: readonly ('api_key' | 'oauth' | 'ambient')[];
  models: readonly { id: string; name: string; api: string; endpoint: string | null;
    contextWindow: number; maxTokens: number; reasoning: boolean }[];
};

export type ModelAuthPrompt =
  | { type: 'text' | 'secret' | 'manual_code'; message: string; placeholder?: string }
  | { type: 'select'; message: string; options: readonly { id: string; label: string; description?: string }[] };

export type ModelAuthNotice =
  | { type: 'info'; message: string; links?: readonly { url: string; label?: string }[] }
  | { type: 'auth_url'; url: string; instructions?: string }
  | { type: 'device_code'; userCode: string; verificationUri: string; intervalSeconds?: number; expiresInSeconds?: number }
  | { type: 'progress'; message: string };

export type ModelProfile = {
  id: string;
  credentialRef: string;
  name: string;
  kind: 'catalog' | 'custom' | 'legacy';
  providerId: string | null;
  baseUrl: string;
  model: string;
  api: ProductApi;
  contextWindow: number | null;
  maxTokens: number | null;
  reasoning: boolean;
};

export type ProductSettings = {
  version: 2;
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
  | { type: 'model_auth_notice'; requestId: string; notice: ModelAuthNotice }
  | { type: 'model_auth_prompt'; requestId: string; promptId: string; prompt: ModelAuthPrompt }
  | { type: 'provider_observation'; requestId: string; runId: number; sequence: number; observation: string; at: string; data: Readonly<Record<string, unknown>> }
  | { type: 'provider_finished'; requestId: string; runId: number; result: import('./runtime.ts').Result<import('./runtime.ts').ProviderOutcome> }
  | { type: 'host_state'; state: DesktopState }
  | import('./runtime.ts').AgentRunEvent;

export type DesktopAgentRunRequest = {
  sessionId: import('./runtime.ts').DbId;
  text: string;
  modelId: string;
  workspace?: import('./workspace.ts').WorkspaceExpectation;
  goalMode: import('./workspace.ts').GoalMode;
  timeoutMs?: number;
};

export type DesktopBridge = {
  getState(): Promise<import('./runtime.ts').Result<DesktopState>>;
  listModelCatalog(providerId?: string, refresh?: boolean): Promise<import('./runtime.ts').Result<readonly ModelCatalogProvider[]>>;
  loginModel(modelId: string, authType: 'api_key' | 'oauth', requestId: string): Promise<import('./runtime.ts').Result<{ configured: true }>>;
  logoutModel(modelId: string): Promise<import('./runtime.ts').Result<void>>;
  replyModelAuth(requestId: string, promptId: string, value: string | null): Promise<import('./runtime.ts').Result<void>>;
  cancelModelAuth(requestId: string): Promise<import('./runtime.ts').Result<void>>;
  saveSettings(settings: ProductSettings, credentialUpdate?: { modelId: string; apiKey: string }): Promise<import('./runtime.ts').Result<ProductSettings>>;
  callProvider(input: ProviderTestRequest): Promise<import('./runtime.ts').Result<{ requestId: string; runId: number }>>;
  cancelProvider(requestId: string): Promise<import('./runtime.ts').Result<{ accepted: boolean; runId: number | null }>>;
  createSession(request?: import('./runtime.ts').CreateSessionRequest): Promise<import('./runtime.ts').Result<import('./runtime.ts').SessionSnapshot>>;
  renameSession(request: import('./runtime.ts').RenameSessionRequest): Promise<import('./runtime.ts').Result<import('./runtime.ts').SessionSnapshot>>;
  deleteSession(sessionId: import('./runtime.ts').DbId): Promise<import('./runtime.ts').Result<import('./runtime.ts').DeleteSessionResult>>;
  listSessions(request?: import('./runtime.ts').ListSessionsRequest): Promise<import('./runtime.ts').Result<import('./runtime.ts').SessionPage>>;
  querySession(sessionId: import('./runtime.ts').DbId): Promise<import('./runtime.ts').Result<import('./runtime.ts').SessionSnapshot>>;
  listSessionRuns(request: import('./runtime.ts').SessionRunsRequest): Promise<import('./runtime.ts').Result<import('./runtime.ts').SessionRunsPage>>;
  listSessionMessages(request: import('./runtime.ts').SessionMessagesRequest): Promise<import('./runtime.ts').Result<import('./runtime.ts').SessionMessagesPage>>;
  queryPromptTrace(runId: import('./runtime.ts').DbId, callSequence?: number): Promise<import('./runtime.ts').Result<import('./diagnostics.ts').PromptTraceResult>>;
  startRun(input: DesktopAgentRunRequest): Promise<import('./runtime.ts').Result<import('./runtime.ts').RunAccepted & { requestId: string }>>;
  cancelRun(runId: import('./runtime.ts').DbId): Promise<import('./runtime.ts').Result<{ accepted: boolean; runId: import('./runtime.ts').DbId }>>;
  queryRuntimeState(): Promise<import('./runtime.ts').Result<import('./runtime.ts').RuntimeState>>;
  queryRun(runId: number): Promise<import('./runtime.ts').Result<import('./runtime.ts').RunSnapshot>>;
  readWorkspace(): Promise<import('./runtime.ts').Result<import('./workspace.ts').WorkspaceSnapshot>>;
  updateWorkspace(input: { expectedRevision: number; change: import('./workspace.ts').WorkspaceChange }): Promise<import('./runtime.ts').Result<import('./workspace.ts').WorkspaceSnapshot>>;
  startTask(input: import('./workspace.ts').StartTaskRequest): Promise<import('./runtime.ts').Result<import('./workspace.ts').TaskOperation>>;
  queryTaskOperation(clientSequence: number): Promise<import('./runtime.ts').Result<import('./workspace.ts').TaskOperation | null>>;
  selectCandidate(input: import('./workspace.ts').SelectCandidateRequest): Promise<import('./runtime.ts').Result<import('./workspace.ts').CandidateSelection>>;
  listDocuments(request?: import('./workspace.ts').PageRequest): Promise<import('./runtime.ts').Result<import('./workspace.ts').Page<import('./workspace.ts').DocumentSnapshot>>>;
  queryDocument(documentId: number): Promise<import('./runtime.ts').Result<import('./workspace.ts').DocumentSnapshot>>;
  hideDocument(documentId: number): Promise<import('./runtime.ts').Result<{ documentId: number; affectedChatCount: number }>>;
  listJobs(request?: import('./workspace.ts').JobPageRequest): Promise<import('./runtime.ts').Result<import('./workspace.ts').Page<import('./workspace.ts').JobSnapshot>>>;
  queryJob(jobId: number): Promise<import('./runtime.ts').Result<import('./workspace.ts').JobSnapshot>>;
  hideJob(jobId: number): Promise<import('./runtime.ts').Result<import('./workspace.ts').JobSnapshot>>;
  listJobCandidates(request: import('./workspace.ts').CandidateJobPageRequest): Promise<import('./runtime.ts').Result<import('./workspace.ts').CandidateJobPage>>;
  queryJobCandidate(request: { jobId: number; candidateId: number }): Promise<import('./runtime.ts').Result<import('./workspace.ts').CandidateJobDetail>>;
  listActivity(request: import('./activity.ts').ActivityPageRequest): Promise<import('./runtime.ts').Result<import('./workspace.ts').Page<import('./activity.ts').BusinessEventSnapshot>>>;
  chooseAndImportInvoice(): Promise<import('./runtime.ts').Result<import('./workspace.ts').DocumentSnapshot | null>>;
  readDocumentPage(input: import('./invoice.ts').InvoiceToolInput<'read_invoice_document'>): Promise<import('./runtime.ts').Result<import('./invoice.ts').InvoiceToolOutput<'read_invoice_document'>>>;
  readDocumentOriginal(documentId: number, page: number): Promise<import('./runtime.ts').Result<import('./workspace.ts').DocumentOriginalImage>>;
  revokeDocumentUse(documentId: number): Promise<import('./runtime.ts').Result<{ affectedSessionIds: number[]; stopRequested: boolean }>>;
  subscribe(listener: (event: DesktopEvent) => void): () => void;
};
