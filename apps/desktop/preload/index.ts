import { contextBridge, ipcRenderer } from 'electron';
import type { DesktopBridge, DesktopEvent, ProductSettings, ProviderTestRequest } from '@flowmate/contracts';

const bridge: DesktopBridge = {
  getState: () => ipcRenderer.invoke('flowmate:get-state'),
  listModelCatalog: (providerId, refresh = false) => ipcRenderer.invoke('flowmate:list-model-catalog', providerId, refresh),
  loginModel: (modelId, authType, requestId) => ipcRenderer.invoke('flowmate:login-model', modelId, authType, requestId),
  logoutModel: (modelId) => ipcRenderer.invoke('flowmate:logout-model', modelId),
  replyModelAuth: (requestId, promptId, value) => ipcRenderer.invoke('flowmate:reply-model-auth', requestId, promptId, value),
  cancelModelAuth: (requestId) => ipcRenderer.invoke('flowmate:cancel-model-auth', requestId),
  saveSettings: (settings: ProductSettings, credentialUpdate?: { modelId: string; apiKey: string }) =>
    ipcRenderer.invoke('flowmate:save-settings', settings, credentialUpdate),
  callProvider: (input: ProviderTestRequest) => ipcRenderer.invoke('flowmate:call-provider', input),
  cancelProvider: (requestId: string) => ipcRenderer.invoke('flowmate:cancel-provider', requestId),
  createSession: (request = {}) => ipcRenderer.invoke('flowmate:create-session', request),
  queryNativeTools: () => ipcRenderer.invoke('flowmate:query-native-tools'),
  chooseWorkingDirectory: () => ipcRenderer.invoke('flowmate:choose-working-directory'),
  renameSession: (request) => ipcRenderer.invoke('flowmate:rename-session', request),
  deleteSession: (sessionId) => ipcRenderer.invoke('flowmate:delete-session', sessionId),
  listSessions: (request = {}) => ipcRenderer.invoke('flowmate:list-sessions', request),
  querySession: (sessionId) => ipcRenderer.invoke('flowmate:query-session', sessionId),
  listSessionRuns: (request) => ipcRenderer.invoke('flowmate:list-session-runs', request),
  listSessionMessages: (request) => ipcRenderer.invoke('flowmate:list-session-messages', request),
  queryPromptTrace: (runId, callSequence) => ipcRenderer.invoke('flowmate:query-prompt-trace', runId, callSequence),
  startRun: (input) => ipcRenderer.invoke('flowmate:start-run', input),
  submitInput: input => ipcRenderer.invoke('flowmate:submit-input', input),
  listSessionInputs: input => ipcRenderer.invoke('flowmate:list-session-inputs', input),
  setSessionStatus: input => ipcRenderer.invoke('flowmate:set-session-status', input),
  branchSession: input => ipcRenderer.invoke('flowmate:branch-session', input),
  querySessionHistory: input => ipcRenderer.invoke('flowmate:query-session-history', input),
  querySessionHistoryEntry: input => ipcRenderer.invoke('flowmate:query-session-history-entry', input),
  forkSession: input => ipcRenderer.invoke('flowmate:fork-session', input),
  registerInvoiceFormTarget: input => ipcRenderer.invoke('flowmate:register-invoice-form-target', input),
  invalidateInvoiceFormTarget: id => ipcRenderer.invoke('flowmate:invalidate-invoice-form-target', id),
  setInvoiceFormDirty: (id, dirty, revision) => ipcRenderer.invoke('flowmate:set-invoice-form-dirty', id, dirty, revision),
  saveInvoiceCandidate: input => ipcRenderer.invoke('flowmate:save-invoice-candidate', input),
  acceptInvoiceCandidate: input => ipcRenderer.invoke('flowmate:accept-invoice-candidate', input),
  rejectInvoiceCandidate: input => ipcRenderer.invoke('flowmate:reject-invoice-candidate', input),
  exportInvoiceCandidate: input => ipcRenderer.invoke('flowmate:export-invoice-candidate', input),
  queryInvoiceCandidateOperation: input => ipcRenderer.invoke('flowmate:query-invoice-candidate-operation', input),
  replyInvoiceFormInspect: (id, value) => ipcRenderer.invoke('flowmate:reply-invoice-form-inspect', id, value),
  onInvoiceFormInspect(listener) {
    const handler = (_event: Electron.IpcRendererEvent, value: { requestId: string; formInstanceId: string }) => listener(value.requestId, value.formInstanceId);
    ipcRenderer.on('flowmate:invoice-form-inspect', handler);
    return () => ipcRenderer.removeListener('flowmate:invoice-form-inspect', handler);
  },
  onInvoiceFormInspectFinished(listener) {
    const handler = (_event: Electron.IpcRendererEvent, value?: { unknownOperation?: import('@flowmate/contracts').InvoiceCandidateOperationQuery }) => listener(value?.unknownOperation);
    ipcRenderer.on('flowmate:invoice-form-inspect-finished', handler);
    return () => ipcRenderer.removeListener('flowmate:invoice-form-inspect-finished', handler);
  },
  startInvoiceFormRun: input => ipcRenderer.invoke('flowmate:start-invoice-form-run', input),
  querySessionInput: input => ipcRenderer.invoke('flowmate:query-session-input', input),
  queryInvoiceFormApplication: input => ipcRenderer.invoke('flowmate:query-invoice-form-application', input),
  replyInvoiceFormRequest: (id, receipt) => ipcRenderer.invoke('flowmate:reply-invoice-form-request', id, receipt),
  onInvoiceFormRequest(listener) {
    const handler = (_event: Electron.IpcRendererEvent, value: { requestId: string; request: import('@flowmate/contracts').InvoiceFormBridgeRequest }) => listener(value.requestId, value.request);
    ipcRenderer.on('flowmate:invoice-form-request', handler);
    return () => ipcRenderer.removeListener('flowmate:invoice-form-request', handler);
  },
  cancelRun: (runId) => ipcRenderer.invoke('flowmate:cancel-run', runId),
  queryRuntimeState: () => ipcRenderer.invoke('flowmate:query-runtime-state'),
  queryRun: (runId: number) => ipcRenderer.invoke('flowmate:query-run', runId),
  queryRuntimeEvents: input => ipcRenderer.invoke('flowmate:query-runtime-events', input),
  subscribeRuntimeEvents: input => ipcRenderer.invoke('flowmate:subscribe-runtime-events', input),
  unsubscribeRuntimeEvents: subscriptionId => ipcRenderer.invoke('flowmate:unsubscribe-runtime-events', subscriptionId),
  listRunToolCalls: input => ipcRenderer.invoke('flowmate:list-run-tool-calls', input),
  queryRunToolCall: input => ipcRenderer.invoke('flowmate:query-run-tool-call', input),
  listContextSnapshots: input => ipcRenderer.invoke('flowmate:list-context-snapshots', input),
  queryContextSnapshot: input => ipcRenderer.invoke('flowmate:query-context-snapshot', input),
  listContextRequests: input => ipcRenderer.invoke('flowmate:list-context-requests', input),
  readWorkspace: () => ipcRenderer.invoke('flowmate:read-workspace'),
  restoreWorkspace: () => ipcRenderer.invoke('flowmate:restore-workspace'),
  updateWorkspace: (input) => ipcRenderer.invoke('flowmate:update-workspace', input),
  startTask: (input) => ipcRenderer.invoke('flowmate:start-task', input),
  queryTaskOperation: (sequence) => ipcRenderer.invoke('flowmate:query-task-operation', sequence),
  selectCandidate: (input) => ipcRenderer.invoke('flowmate:select-candidate', input),
  listDocuments: (request = {}) => ipcRenderer.invoke('flowmate:list-documents', request),
  queryDocument: (documentId) => ipcRenderer.invoke('flowmate:query-document', documentId),
  hideDocument: (documentId) => ipcRenderer.invoke('flowmate:hide-document', documentId),
  listJobs: (request = {}) => ipcRenderer.invoke('flowmate:list-jobs', request),
  queryJob: (jobId) => ipcRenderer.invoke('flowmate:query-job', jobId),
  hideJob: (jobId) => ipcRenderer.invoke('flowmate:hide-job', jobId),
  listJobCandidates: (request) => ipcRenderer.invoke('flowmate:list-job-candidates', request),
  queryJobCandidate: (request) => ipcRenderer.invoke('flowmate:query-job-candidate', request),
  listActivity: (request) => ipcRenderer.invoke('flowmate:list-activity', request),
  chooseAndImportInvoice: () => ipcRenderer.invoke('flowmate:choose-and-import-invoice'),
  readDocumentPage: (input) => ipcRenderer.invoke('flowmate:read-document-page', input),
  listDocumentPages: input => ipcRenderer.invoke('flowmate:list-document-pages', input),
  readDocumentOriginal: (documentId, page) => ipcRenderer.invoke('flowmate:read-document-original', documentId, page),
  revokeDocumentUse: (documentId) => ipcRenderer.invoke('flowmate:revoke-document-use', documentId),
  subscribe(listener: (event: DesktopEvent) => void) {
    const handler = (_event: Electron.IpcRendererEvent, value: DesktopEvent) => listener(value);
    ipcRenderer.on('flowmate:event', handler);
    void ipcRenderer.invoke('flowmate:subscribe');
    return () => {
      ipcRenderer.removeListener('flowmate:event', handler);
      void ipcRenderer.invoke('flowmate:unsubscribe');
    };
  },
};

contextBridge.exposeInMainWorld('flowmate', bridge);
