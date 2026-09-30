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
  renameSession: (request) => ipcRenderer.invoke('flowmate:rename-session', request),
  deleteSession: (sessionId) => ipcRenderer.invoke('flowmate:delete-session', sessionId),
  listSessions: (request = {}) => ipcRenderer.invoke('flowmate:list-sessions', request),
  querySession: (sessionId) => ipcRenderer.invoke('flowmate:query-session', sessionId),
  listSessionRuns: (request) => ipcRenderer.invoke('flowmate:list-session-runs', request),
  listSessionMessages: (request) => ipcRenderer.invoke('flowmate:list-session-messages', request),
  queryPromptTrace: (runId, callSequence) => ipcRenderer.invoke('flowmate:query-prompt-trace', runId, callSequence),
  startRun: (input) => ipcRenderer.invoke('flowmate:start-run', input),
  cancelRun: (runId) => ipcRenderer.invoke('flowmate:cancel-run', runId),
  queryRuntimeState: () => ipcRenderer.invoke('flowmate:query-runtime-state'),
  queryRun: (runId: number) => ipcRenderer.invoke('flowmate:query-run', runId),
  readWorkspace: () => ipcRenderer.invoke('flowmate:read-workspace'),
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
