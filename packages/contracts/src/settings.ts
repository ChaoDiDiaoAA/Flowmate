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
  version: 2 | 3;
  revision: number;
  profile: { displayName: string; theme: 'system' | 'light' | 'dark' };
  models: readonly ModelProfile[];
  defaultModelId: string | null;
  runtime?: import('./runtime.ts').RuntimeRequestOverrides;
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
  | import('./events.ts').RuntimeEventsWake
  | import('./runtime.ts').AgentRunEvent;

export type DesktopAgentRunRequest = {
  sessionId: import('./runtime.ts').DbId;
  text: string;
  modelId: string;
  workspace?: import('./workspace.ts').WorkspaceExpectation;
  goalMode: 'answer' | 'save-candidate';
  workingDirectory?: string;
  budget?: import('./runtime.ts').RuntimeBudgetOverrides;
  timeoutMs?: number;
  stopGraceMs?: number;
};

export type DesktopInvoiceFormRunRequest = {
  workspace: import('./workspace.ts').WorkspaceExpectation;
  target: import('./invoice.ts').InvoiceFormTarget;
  clientSequence: import('./runtime.ts').DbId;
  modelId: string;
  budget?: import('./runtime.ts').RuntimeBudgetOverrides;
  timeoutMs?: number;
  stopGraceMs?: number;
};
export function serializeDesktopInvoiceFormRequest(input: DesktopInvoiceFormRunRequest): string {
  const workspace = input.workspace;
  return JSON.stringify({ requestIdentityVersion: 1, clientSequence: input.clientSequence, modelId: input.modelId,
    target: { formInstanceId: input.target.formInstanceId, expectedRevision: input.target.expectedRevision },
    workspace: { revision: workspace.revision, sessionId: workspace.sessionId,
      documentRef: workspace.documentRef === null ? null : { id: workspace.documentRef.id, version: workspace.documentRef.version },
      jobId: workspace.jobId, candidateRef: workspace.candidateRef === null ? null : { id: workspace.candidateRef.id, sequence: workspace.candidateRef.sequence } },
    originalBudgetOverrides: { ...(input.budget === undefined ? {} : { budget: {
      ...(input.budget.maxToolCalls === undefined ? {} : { maxToolCalls: input.budget.maxToolCalls }),
      ...(input.budget.maxModelCalls === undefined ? {} : { maxModelCalls: input.budget.maxModelCalls }),
      ...(input.budget.toolTimeoutMs === undefined ? {} : { toolTimeoutMs: input.budget.toolTimeoutMs }) } }),
      ...(input.timeoutMs === undefined ? {} : { timeoutMs: input.timeoutMs }),
      ...(input.stopGraceMs === undefined ? {} : { stopGraceMs: input.stopGraceMs }) } });
}
export type DesktopSessionInputRequest =
  | Omit<import('./session-inputs.ts').PromptInputRequest, 'config'> & { modelId: string }
  | import('./session-inputs.ts').ActiveInputRequest;
/** Stable identity for an already validated Desktop prompt, shared with the browser. */
export function serializeDesktopPromptRequest(input: Extract<DesktopSessionInputRequest, { mode: 'prompt' }>, identityVersion?: 1): string {
  const workspace = input.workspace;
  const budget = input.budget === undefined ? undefined : {
    ...(input.budget.maxToolCalls === undefined ? {} : { maxToolCalls: input.budget.maxToolCalls }),
    ...(input.budget.maxModelCalls === undefined ? {} : { maxModelCalls: input.budget.maxModelCalls }),
    ...(input.budget.toolTimeoutMs === undefined ? {} : { toolTimeoutMs: input.budget.toolTimeoutMs }),
  };
  return JSON.stringify({ sessionId: input.sessionId, clientSequence: input.clientSequence, mode: input.mode,
    text: input.text, modelId: input.modelId, goalMode: input.goalMode ?? 'answer',
    ...(workspace === undefined ? {} : { workspace: { revision: workspace.revision,
      documentRef: workspace.documentRef === null ? null : { id: workspace.documentRef.id, version: workspace.documentRef.version },
      jobId: workspace.jobId, candidateRef: workspace.candidateRef === null ? null : { id: workspace.candidateRef.id, sequence: workspace.candidateRef.sequence },
      sessionId: workspace.sessionId } }),
    ...(input.workingDirectory === undefined ? {} : { workingDirectory: input.workingDirectory }),
    ...(identityVersion === 1 ? { requestIdentityVersion: 1, originalBudgetOverrides: {
      ...(budget === undefined ? {} : { budget }),
      ...(input.timeoutMs === undefined ? {} : { timeoutMs: input.timeoutMs }),
      ...(input.stopGraceMs === undefined ? {} : { stopGraceMs: input.stopGraceMs }),
    } } : { timeoutMs: input.timeoutMs ?? 60_000, stopGraceMs: input.stopGraceMs ?? 5000,
      ...(budget === undefined ? {} : { budget }) }) });
}
export type DesktopInvoiceFormWorkspace = Omit<import('./workspace.ts').WorkspaceExpectation, 'sessionId'> & {
  sessionId: import('./runtime.ts').DbId | null;
};
export type DesktopInvoiceFormInspection = {
  formInstanceId: string; revision: number; dirty: boolean; valid: boolean;
  basis: { sessionId: import('./runtime.ts').DbId | null; documentRef: import('./invoice.ts').DocumentRef;
    jobId: import('./runtime.ts').DbId; candidateId: import('./runtime.ts').DbId; candidateSequence: number };
  draft: import('./invoice.ts').InvoiceFormDraft;
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
  queryNativeTools(): Promise<import('./runtime.ts').Result<readonly import('./tools.ts').NativeToolAvailability[]>>;
  chooseWorkingDirectory(): Promise<import('./runtime.ts').Result<string | null>>;
  renameSession(request: import('./runtime.ts').RenameSessionRequest): Promise<import('./runtime.ts').Result<import('./runtime.ts').SessionSnapshot>>;
  deleteSession(sessionId: import('./runtime.ts').DbId): Promise<import('./runtime.ts').Result<import('./runtime.ts').DeleteSessionResult>>;
  listSessions(request?: import('./runtime.ts').ListSessionsRequest): Promise<import('./runtime.ts').Result<import('./runtime.ts').SessionPage>>;
  querySession(sessionId: import('./runtime.ts').DbId): Promise<import('./runtime.ts').Result<import('./runtime.ts').SessionSnapshot>>;
  listSessionRuns(request: import('./runtime.ts').SessionRunsRequest): Promise<import('./runtime.ts').Result<import('./runtime.ts').SessionRunsPage>>;
  listSessionMessages(request: import('./runtime.ts').SessionMessagesRequest): Promise<import('./runtime.ts').Result<import('./runtime.ts').SessionMessagesPage>>;
  queryPromptTrace(runId: import('./runtime.ts').DbId, callSequence?: number): Promise<import('./runtime.ts').Result<import('./diagnostics.ts').PromptTraceResult>>;
  startRun(input: DesktopAgentRunRequest): Promise<import('./runtime.ts').Result<import('./runtime.ts').RunAccepted & { requestId: string }>>;
  submitInput(input: DesktopSessionInputRequest): Promise<import('./runtime.ts').Result<import('./session-inputs.ts').SessionInputAccepted & { requestId: string }>>;
  listSessionInputs(input: import('./session-inputs.ts').SessionInputsRequest): Promise<import('./runtime.ts').Result<import('./session-inputs.ts').SessionInputsPage>>;
  setSessionStatus(input: import('./runtime.ts').SetSessionStatusRequest): Promise<import('./runtime.ts').Result<import('./runtime.ts').SessionSnapshot>>;
  branchSession(input: import('./runtime.ts').BranchSessionRequest): Promise<import('./runtime.ts').Result<import('./runtime.ts').BranchSessionResult>>;
  registerInvoiceFormTarget(input: { purpose: 'fill' | 'edit'; workspace: DesktopInvoiceFormWorkspace; formRevision: number }): Promise<import('./runtime.ts').Result<import('./invoice.ts').InvoiceFormTarget>>;
  invalidateInvoiceFormTarget(formInstanceId: string): Promise<import('./runtime.ts').Result<void>>;
  setInvoiceFormDirty(formInstanceId: string, dirty: boolean, formRevision: number): Promise<import('./runtime.ts').Result<void>>;
  onInvoiceFormInspect(listener: (requestId: string, formInstanceId: string) => void): () => void;
  onInvoiceFormInspectFinished(listener: (unknownOperation?: import('./invoice.ts').InvoiceCandidateOperationQuery) => void): () => void;
  replyInvoiceFormInspect(requestId: string, value: DesktopInvoiceFormInspection | null): Promise<import('./runtime.ts').Result<void>>;
  saveInvoiceCandidate(input: import('./invoice.ts').SaveInvoiceCandidateRequest): Promise<import('./runtime.ts').Result<import('./invoice.ts').SaveInvoiceCandidateResponse>>;
  acceptInvoiceCandidate(input: import('./invoice.ts').AcceptInvoiceCandidateRequest): Promise<import('./runtime.ts').Result<import('./invoice.ts').InvoiceCandidateDecisionResponse>>;
  rejectInvoiceCandidate(input: import('./invoice.ts').RejectInvoiceCandidateRequest): Promise<import('./runtime.ts').Result<import('./invoice.ts').InvoiceCandidateDecisionResponse>>;
  exportInvoiceCandidate(input: import('./invoice.ts').ExportInvoiceCandidateRequest): Promise<import('./runtime.ts').Result<import('./invoice.ts').InvoiceExportReference>>;
  queryInvoiceCandidateOperation(input: import('./invoice.ts').InvoiceCandidateOperationQuery): Promise<import('./runtime.ts').Result<import('./invoice.ts').InvoiceCandidateOperationResult>>;
  startInvoiceFormRun(input: DesktopInvoiceFormRunRequest): Promise<import('./runtime.ts').Result<import('./runtime.ts').RunAccepted & { requestId: string }>>;
  querySessionInput(input: import('./session-inputs.ts').SessionInputQuery): Promise<import('./runtime.ts').Result<import('./session-inputs.ts').SessionInputQueryResult>>;
  queryInvoiceFormApplication(input: { runId: import('./runtime.ts').DbId; toolCallId: import('./runtime.ts').DbId }): Promise<import('./runtime.ts').Result<import('./invoice.ts').InvoiceFormApplicationReceipt>>;
  onInvoiceFormRequest(listener: (requestId: string, request: import('./invoice.ts').InvoiceFormBridgeRequest) => void): () => void;
  replyInvoiceFormRequest(requestId: string, receipt: import('./invoice.ts').InvoiceFormApplicationReceipt): Promise<import('./runtime.ts').Result<void>>;
  cancelRun(runId: import('./runtime.ts').DbId): Promise<import('./runtime.ts').Result<{ accepted: boolean; runId: import('./runtime.ts').DbId }>>;
  queryRuntimeState(): Promise<import('./runtime.ts').Result<import('./runtime.ts').RuntimeState>>;
  queryRun(runId: number): Promise<import('./runtime.ts').Result<import('./runtime.ts').RunSnapshot>>;
  queryRuntimeEvents(input: import('./events.ts').RuntimeEventsQuery): Promise<import('./events.ts').RuntimeEventsReadResult>;
  subscribeRuntimeEvents(input: import('./events.ts').RuntimeEventsSubscriptionRequest): Promise<import('./runtime.ts').Result<import('./events.ts').RuntimeSubscriptionInfo>>;
  unsubscribeRuntimeEvents(subscriptionId: string): Promise<import('./runtime.ts').Result<void>>;
  listRunToolCalls(input: import('./events.ts').RunToolCallsRequest): Promise<import('./runtime.ts').Result<import('./workspace.ts').Page<import('./events.ts').RuntimeToolView>>>;
  queryRunToolCall(input: import('./events.ts').RunToolCallRequest): Promise<import('./runtime.ts').Result<import('./events.ts').RuntimeToolView>>;
  listContextSnapshots(input: import('./context.ts').ContextSnapshotsRequest): Promise<import('./runtime.ts').Result<import('./context.ts').ContextSnapshotsPage>>;
  queryContextSnapshot(input: import('./context.ts').ContextSnapshotRequest): Promise<import('./runtime.ts').Result<import('./context.ts').ContextSnapshotDetail>>;
  listContextRequests(input: import('./context.ts').ContextRequestsRequest): Promise<import('./runtime.ts').Result<import('./context.ts').ContextRequestsPage>>;
  readWorkspace(): Promise<import('./runtime.ts').Result<import('./workspace.ts').WorkspaceSnapshot>>;
  updateWorkspace(input: { expectedRevision: number; change: import('./workspace.ts').WorkspaceChange }): Promise<import('./runtime.ts').Result<import('./workspace.ts').WorkspaceSnapshot>>;
  restoreWorkspace(): Promise<import('./runtime.ts').Result<import('./workspace.ts').WorkspaceRestoreResult>>;
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
  listDocumentPages(input: import('./invoice.ts').InvoiceToolInput<'list_invoice_pages'>): Promise<import('./runtime.ts').Result<import('./invoice.ts').InvoiceToolOutput<'list_invoice_pages'>>>;
  readDocumentOriginal(documentId: number, page: number): Promise<import('./runtime.ts').Result<import('./workspace.ts').DocumentOriginalImage>>;
  revokeDocumentUse(documentId: number): Promise<import('./runtime.ts').Result<{ affectedSessionIds: number[]; stopRequested: boolean }>>;
  subscribe(listener: (event: DesktopEvent) => void): () => void;
};
