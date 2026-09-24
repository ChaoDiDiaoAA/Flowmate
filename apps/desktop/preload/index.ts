import { contextBridge, ipcRenderer } from 'electron';
import type { DesktopBridge, DesktopEvent, ProductSettings, ProviderTestRequest } from '@flowmate/contracts';

const bridge: DesktopBridge = {
  getState: () => ipcRenderer.invoke('flowmate:get-state'),
  saveSettings: (settings: ProductSettings, credentialUpdate?: { modelId: string; apiKey: string }) =>
    ipcRenderer.invoke('flowmate:save-settings', settings, credentialUpdate),
  callProvider: (input: ProviderTestRequest) => ipcRenderer.invoke('flowmate:call-provider', input),
  cancelProvider: (requestId: string) => ipcRenderer.invoke('flowmate:cancel-provider', requestId),
  createSession: (request = {}) => ipcRenderer.invoke('flowmate:create-session', request),
  listSessions: (request = {}) => ipcRenderer.invoke('flowmate:list-sessions', request),
  querySession: (sessionId) => ipcRenderer.invoke('flowmate:query-session', sessionId),
  listSessionRuns: (request) => ipcRenderer.invoke('flowmate:list-session-runs', request),
  queryPromptTrace: (runId, callSequence) => ipcRenderer.invoke('flowmate:query-prompt-trace', runId, callSequence),
  startRun: (input) => ipcRenderer.invoke('flowmate:start-run', input),
  cancelRun: (runId) => ipcRenderer.invoke('flowmate:cancel-run', runId),
  queryRuntimeState: () => ipcRenderer.invoke('flowmate:query-runtime-state'),
  queryRun: (runId: number) => ipcRenderer.invoke('flowmate:query-run', runId),
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
