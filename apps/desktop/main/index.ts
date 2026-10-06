import { ResourceRefSchema } from '@flowmate/contracts';
import { app, BrowserWindow, dialog, ipcMain, shell } from 'electron';
import { createHash, randomUUID } from 'node:crypto';
import { mkdir } from 'node:fs/promises';
import { existsSync, mkdirSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { z } from 'zod';
import {
  appError,
  fail,
  normalizeCreateSessionRequest,
  normalizeListSessionsRequest,
  normalizeRenameSessionRequest,
  normalizeSessionId,
  normalizeSessionRunsRequest,
  normalizeSessionMessagesRequest,
  SessionMessagesPageSchema,
  MessageUpsertEventSchema,
  AppErrorSchema,
  StartTaskRequestSchema,
  SelectCandidateRequestSchema,
  WorkspaceUpdateRequestSchema,
  WorkspaceExpectationSchema,
  WorkspaceContextSchema,
  WorkingDirectorySchema,
  RuntimeRequestOverridesSchema,
  RUNTIME_CONFIG,
  serializeDesktopInvoiceFormRequest,
  invoiceToolSchemas,
  InvoiceFormApplicationReceiptSchema,
  InvoiceFormTargetSchema,
  SessionInputQuerySchema,
  SessionInputsRequestSchema,
  SetSessionStatusRequestSchema,
  InvoiceCandidateOperationQuerySchema,
  RuntimeEventsQuerySchema,
  RuntimeEventsSubscriptionRequestSchema,
  RuntimeSubscriptionIdSchema,
  RuntimeEventsWakeSchema,
  RunToolCallsRequestSchema,
  RunToolCallRequestSchema,
  RuntimeEventsReadResultSchema,
  RuntimeSubscriptionResultSchema,
  RuntimeSubscriptionReleaseResultSchema,
  RuntimeToolPageResultSchema,
  RuntimeToolResultSchema,
  ContextSnapshotsRequestSchema,
  ContextSnapshotRequestSchema,
  ContextRequestsRequestSchema,
  ContextErrorSchema,
  ok,
} from '@flowmate/contracts';
import type {
  DesktopAgentRunRequest,
  SessionInputAccepted,
  DesktopEvent,
  DesktopState,
  ProductSettings,
  ProviderTestRequest,
  PromptTraceResult,
  Result,
  RunAccepted,
  RunSnapshot,
  SessionPage,
  SessionRunsPage,
  SessionMessagesPage,
  SessionSnapshot,
  RuntimeState,
  InvoiceFormApplicationReceipt,
  InvoiceFormBridgeRequest,
  DesktopInvoiceFormWorkspace,
  CandidateJobDetail,
  WorkspaceSnapshot,
  JobSnapshot,
  DesktopInvoiceFormInspection,
  InvoiceCandidateOperationQuery,
  InvoiceCandidateOperationResult,
  RuntimeEventsReadResult,
  RuntimeSubscriptionInfo,
  RuntimeEventsWake,
} from '@flowmate/contracts';
import { defaultProductSettings, validateProductSettings } from '../../../packages/core/src/configuration/settings.ts';
import { createCredentialStore } from '../../../packages/shared/src/secure-credential-store.ts';
import type { CredentialStore } from '../../../packages/shared/src/secure-credential-store.ts';
import { systemSecureStorage } from './secure-storage.ts';
import { HostClient } from './host-client.ts';
import type { HostCredentialRequest } from '../../host/protocol.ts';
import { DesktopSessionInputRequestSchema, InvoiceFormRunInputSchema } from '../../host/protocol.ts';
import { contextHostFailure, matchesContextResponse, parseContextHostResult } from '../../host/protocol.ts';
import { historyHostFailure, matchesHistoryResponse, parseHistoryHostResult, parseHostCommand, isHistoryHostCommand } from '../../host/protocol.ts';
import type { HostCommand } from '../../host/protocol.ts';
import { DesktopSessionCompactionRequestSchema } from '@flowmate/contracts';
import { isExtensionHostCommand, parseExtensionHostResult, matchesExtensionResponse, extensionHostFailure, isResourceHostCommand, parseResourceHostResult, matchesResourceResponse, resourceHostFailure } from '../../host/protocol.ts';
import { isCompactionHostCommand, parseCompactionHostResult, matchesCompactionResponse, compactionHostFailure, parseCompactionNotification } from '../../host/protocol.ts';
import { checkedInvoiceFormInspection, matchesInvoiceFormRun, matchesInvoiceFormTarget, type InvoiceFormOwner, type InvoiceFormTargetBinding } from './invoice-form-bridge.ts';

const channels = {
  getState: 'flowmate:get-state',
  listModelCatalog: 'flowmate:list-model-catalog',
  loginModel: 'flowmate:login-model',
  logoutModel: 'flowmate:logout-model',
  replyModelAuth: 'flowmate:reply-model-auth',
  cancelModelAuth: 'flowmate:cancel-model-auth',
  saveSettings: 'flowmate:save-settings',
  callProvider: 'flowmate:call-provider',
  cancelProvider: 'flowmate:cancel-provider',
  queryRun: 'flowmate:query-run',
  queryRuntimeEvents: 'flowmate:query-runtime-events',
  subscribeRuntimeEvents: 'flowmate:subscribe-runtime-events',
  unsubscribeRuntimeEvents: 'flowmate:unsubscribe-runtime-events',
  listRunToolCalls: 'flowmate:list-run-tool-calls',
  queryRunToolCall: 'flowmate:query-run-tool-call',
  listContextSnapshots: 'flowmate:list-context-snapshots',
  queryContextSnapshot: 'flowmate:query-context-snapshot',
  listContextRequests: 'flowmate:list-context-requests',
  compactSession: 'flowmate:compact-session',
  querySessionCompaction: 'flowmate:query-session-compaction',
  cancelSessionCompaction: 'flowmate:cancel-session-compaction',
  createSession: 'flowmate:create-session',
  queryNativeTools: 'flowmate:query-native-tools',
  chooseWorkingDirectory: 'flowmate:choose-working-directory',
  renameSession: 'flowmate:rename-session',
  deleteSession: 'flowmate:delete-session',
  listSessions: 'flowmate:list-sessions',
  querySession: 'flowmate:query-session',
  listSessionRuns: 'flowmate:list-session-runs',
  listSessionMessages: 'flowmate:list-session-messages',
  queryPromptTrace: 'flowmate:query-prompt-trace',
  startRun: 'flowmate:start-run',
  submitInput: 'flowmate:submit-input',
  listSessionInputs: 'flowmate:list-session-inputs',
  setSessionStatus: 'flowmate:set-session-status',
  branchSession: 'flowmate:branch-session',
  querySessionHistory: 'flowmate:query-session-history',
  querySessionHistoryEntry: 'flowmate:query-session-history-entry',
  forkSession: 'flowmate:fork-session',
  registerInvoiceFormTarget: 'flowmate:register-invoice-form-target',
  invalidateInvoiceFormTarget: 'flowmate:invalidate-invoice-form-target',
  setInvoiceFormDirty: 'flowmate:set-invoice-form-dirty',
  startInvoiceFormRun: 'flowmate:start-invoice-form-run',
  querySessionInput: 'flowmate:query-session-input',
  queryInvoiceFormApplication: 'flowmate:query-invoice-form-application',
  replyInvoiceFormRequest: 'flowmate:reply-invoice-form-request',
  replyInvoiceFormInspect: 'flowmate:reply-invoice-form-inspect',
  saveInvoiceCandidate: 'flowmate:save-invoice-candidate',
  acceptInvoiceCandidate: 'flowmate:accept-invoice-candidate',
  rejectInvoiceCandidate: 'flowmate:reject-invoice-candidate',
  exportInvoiceCandidate: 'flowmate:export-invoice-candidate',
  queryInvoiceCandidateOperation: 'flowmate:query-invoice-candidate-operation',
  cancelRun: 'flowmate:cancel-run',
  queryRuntimeState: 'flowmate:query-runtime-state',
  readWorkspace: 'flowmate:read-workspace',
  restoreWorkspace: 'flowmate:restore-workspace',
  updateWorkspace: 'flowmate:update-workspace',
  startTask: 'flowmate:start-task',
  queryTaskOperation: 'flowmate:query-task-operation',
  selectCandidate: 'flowmate:select-candidate',
  listDocuments: 'flowmate:list-documents',
  queryDocument: 'flowmate:query-document',
  hideDocument: 'flowmate:hide-document',
  listJobs: 'flowmate:list-jobs',
  queryJob: 'flowmate:query-job',
  hideJob: 'flowmate:hide-job',
  listJobCandidates: 'flowmate:list-job-candidates',
  queryJobCandidate: 'flowmate:query-job-candidate',
  listActivity: 'flowmate:list-activity',
  chooseAndImportInvoice: 'flowmate:choose-and-import-invoice',
  readDocumentPage: 'flowmate:read-document-page',
  listDocumentPages: 'flowmate:list-document-pages',
  readDocumentOriginal: 'flowmate:read-document-original',
  revokeDocumentUse: 'flowmate:revoke-document-use',
  subscribe: 'flowmate:subscribe',
  unsubscribe: 'flowmate:unsubscribe',
} as const;

const providerTestSchema = (value: unknown): value is ProviderTestRequest => value !== null && typeof value === 'object'
  && typeof (value as ProviderTestRequest).goal === 'string'
  && (value as ProviderTestRequest).goal.trim().length > 0
  && new TextEncoder().encode((value as ProviderTestRequest).goal).byteLength <= 4096
  && typeof (value as ProviderTestRequest).text === 'string'
  && new TextEncoder().encode(`${(value as ProviderTestRequest).goal}\n\n${(value as ProviderTestRequest).text}`).byteLength <= 65_536
  && typeof (value as ProviderTestRequest).modelId === 'string'
  && /^[a-zA-Z0-9._-]{1,64}$/.test((value as ProviderTestRequest).modelId)
  && ((value as ProviderTestRequest).timeoutMs === undefined || (Number.isInteger((value as ProviderTestRequest).timeoutMs)
    && (value as ProviderTestRequest).timeoutMs! >= RUNTIME_CONFIG.ranges.providerTestTimeoutMs.min
    && (value as ProviderTestRequest).timeoutMs! <= RUNTIME_CONFIG.ranges.providerTestTimeoutMs.max));

let mainWindow: BrowserWindow | null = null;
let allowWindowClose = false;
let allowQuit = false;
let desktopClosing = false;
let closeInFlight: Promise<void> | null = null;
let devShutdownRequestId: string | null = null;
let hostError = false;
let hostErrorCode = 'host_not_ready';
let ipcRegistered = false;
let userDataRoot = '';
let appVersion = '0.1.0';
let stateBroadcastSequence = 0;
const host = new HostClient();
const subscriptions = new Map<number, () => void>();
type RuntimeOwner = { token: string; contents: Electron.WebContents; frame: Electron.WebFrameMain;
  url: string; generation: number; epoch: number };
type RuntimeBinding = { id: string; owner: RuntimeOwner; runId: number; sessionId: number | null;
  open: boolean; pendingWake: number | null; cleanup(): void };
const runtimeOwners = new Map<number, RuntimeOwner>();
const runtimeGenerations = new Map<number, number>();
const runtimeBindings = new Map<string, RuntimeBinding>();
const runtimeReleased = new Map<string, string>();
const runtimeQueries = new Set<string>();
const credentialStores = new Map<string, CredentialStore>();
const piCredentialPrefix = 'pi-credential-v1:';
type DesktopFormBinding = InvoiceFormTargetBinding & { currentRevision: number; mutationPending?: boolean; unknownOperationRef?: string; clientSequence?: number; requestId?: string; modelId?: string };
let invoiceFormBinding: DesktopFormBinding | null = null;
const pendingInvoiceForms = new Map<string, { request: InvoiceFormBridgeRequest; owner: DesktopFormBinding;
  resolve(receipt: InvoiceFormApplicationReceipt): void }>();
const pendingFormInspections = new Map<string, { owner: DesktopFormBinding; resolve(value: DesktopInvoiceFormInspection | null): void }>();

app.setName('Flowmate');
app.on('web-contents-created', (_event, contents) => {
  contents.setWindowOpenHandler(({ url }) => {
    if (url.startsWith('https://')) void shell.openExternal(url);
    return { action: 'deny' };
  });
  contents.on('will-navigate', (event, url) => {
    if (!isAllowedPage(url)) event.preventDefault();
  });
});

app.on('activate', () => {
  if (BrowserWindow.getAllWindows().length === 0) createMainWindow();
});

app.on('before-quit', (event) => {
  if (allowQuit) return;
  event.preventDefault();
  void confirmInvoiceFormClose().then(confirmed => { if (confirmed) void closeHostAndQuit(); });
});

const startup = bootstrap().catch(async () => {
  hostError = true;
  hostErrorCode = 'desktop_start_failed';
  await sendDevelopmentNotice({ version: 1, type: 'flowmate_dev_ready', ready: false });
  await app.whenReady();
  registerIpc();
  createMainWindow();
});

const managedDevelopment = !app.isPackaged && process.env.FLOWMATE_DEV_PARENT === '1' && typeof process.send === 'function';
if (managedDevelopment) {
  process.on('message', (raw: unknown) => {
    if (!raw || typeof raw !== 'object') return;
    const command = raw as Record<string, unknown>;
    if (command.version !== 1 || command.type !== 'flowmate_dev_shutdown'
      || typeof command.requestId !== 'string' || !/^[a-zA-Z0-9-]{1,128}$/.test(command.requestId)) return;
    devShutdownRequestId = command.requestId;
    void closeHostAndQuit();
  });
  process.on('disconnect', () => { void closeHostAndQuit(); });
}

async function sendDevelopmentNotice(value: Record<string, unknown>): Promise<void> {
  if (!managedDevelopment || !process.connected || !process.send) return;
  await new Promise<void>((resolveSent) => {
    try { process.send!(value, undefined, {}, () => resolveSent()); } catch { resolveSent(); }
  });
}

async function bootstrap(): Promise<void> {
  const appRoot = resolveWorkspaceRoot(app.getAppPath());
  const appDataPath = app.getPath('appData');
  const testRoot = !app.isPackaged && process.env.FLOWMATE_TEST_MODE === '1'
    ? process.env.FLOWMATE_TEST_USER_DATA_ROOT
    : undefined;
  userDataRoot = testRoot && isAbsolutePath(testRoot) ? testRoot : join(appDataPath, 'Flowmate');
  mkdirSync(userDataRoot, { recursive: true });
  app.setPath('userData', userDataRoot);
  await app.whenReady();
  appVersion = readProductVersion(appRoot);
  const testInvoiceSourceRoot = !app.isPackaged && process.env.FLOWMATE_TEST_MODE === '1'
    ? process.env.FLOWMATE_TEST_INVOICE_SOURCE_ROOT : undefined;
  const invoiceSourceRoot = testInvoiceSourceRoot && isAbsolutePath(testInvoiceSourceRoot)
    ? testInvoiceSourceRoot : join(appRoot, 'data', 'invoices', 'agent-input');
  let retiredCredentialRef: string | null = null;
  try {
    const old = JSON.parse(readFileSync(join(userDataRoot, 'data', 'settings.json'), 'utf8')) as { version?: unknown; models?: unknown[] };
    if (old.version === 1 && Array.isArray(old.models)) {
      const retired = old.models.find((model) => model && typeof model === 'object'
        && (model as Record<string, unknown>).model === 'deepseek-flash'
        && (model as Record<string, unknown>).api === 'openai-responses') as { credentialRef?: unknown } | undefined;
      if (typeof retired?.credentialRef === 'string' && /^[a-zA-Z0-9_-]{16,80}$/.test(retired.credentialRef))
        retiredCredentialRef = retired.credentialRef;
    }
  } catch { /* No legacy settings to clean up. */ }
  host.subscribe((event) => {
    if (event.type === 'runtime_events_available') { receiveRuntimeWake(event); return; }
    if (event.type === 'host_state' && event.state.host === 'error') {
      hostError = true;
      hostErrorCode = 'host_exited';
    }
    if (event.type === 'host_state' && event.state.host === 'ready') {
      hostError = false;
      hostErrorCode = 'host_not_ready';
    }
    if (event.type === 'host_state') {
      void broadcastState();
      return;
    }
    const desktopEvent = event.type === 'agent_run_event' ? event.value : event as DesktopEvent;
    if (desktopEvent.type === 'compaction_observation' && !parseCompactionNotification(desktopEvent)) return;
    if (desktopEvent.type === 'message_upsert' && !MessageUpsertEventSchema.safeParse(desktopEvent).success) return;
    for (const [webContentsId] of subscriptions) {
      const contents = BrowserWindow.getAllWindows().find((window) => window.webContents.id === webContentsId)?.webContents;
      if (contents && !contents.isDestroyed()) contents.send('flowmate:event', desktopEvent);
    }
  });
  host.setCredentialHandler(handleHostCredentialRequest);
  host.setInvoiceFormHandler(handleInvoiceFormRequest);
  host.setConnectionChangeHandler(releaseAllRuntimeOwners);
  const started = await host.start(userDataRoot, appVersion, appRoot, invoiceSourceRoot);
  if (started.ok && started.data.ready && retiredCredentialRef) {
    const removed = await credentialStore(retiredCredentialRef).remove();
    if (!removed.ok) process.stderr.write('[Flowmate] A retired encrypted credential could not be deleted.\n');
  }
  if (!started.ok || !started.data.ready) {
    hostError = true;
    hostErrorCode = started.ok ? 'host_start_failed' : started.error.code;
  }
  registerIpc();
  createMainWindow();
  await sendDevelopmentNotice({ version: 1, type: 'flowmate_dev_ready', ready: !hostError });
}

function closeHostAndQuit(): Promise<void> {
  if (closeInFlight) return closeInFlight;
  closeInFlight = closeDesktop().finally(() => { closeInFlight = null; });
  return closeInFlight;
}

async function closeDesktop(): Promise<void> {
  desktopClosing = true;
  await startup;
  releaseAllRuntimeOwners();
  const closed = await host.close();
  await sendDevelopmentNotice({ version: 1, type: 'flowmate_dev_closed', requestId: devShutdownRequestId,
    closed: closed.ok && closed.data.closed, stopped: closed.ok && closed.data.stopped });
  if (closed.ok && closed.data.closed && closed.data.stopped) {
    allowWindowClose = true;
    allowQuit = true;
    for (const unsubscribe of subscriptions.values()) unsubscribe();
    subscriptions.clear();
    app.quit();
  } else {
    hostError = true;
    hostErrorCode = closed.ok ? 'host_close_unconfirmed' : closed.error.code;
    await broadcastState();
  }
}

function createMainWindow(): void {
  const window = new BrowserWindow({
    width: 1380,
    height: 920,
    minWidth: 980,
    minHeight: 720,
    show: false,
    backgroundColor: '#e9e7df',
    title: 'Flowmate',
    webPreferences: {
      preload: join(resolveWorkspaceRoot(app.getAppPath()), 'out', 'preload', 'index.js'),
      contextIsolation: true,
      sandbox: true,
      nodeIntegration: false,
      webSecurity: true,
    },
  });
  mainWindow = window;
  const contentsId = window.webContents.id;
  window.removeMenu();
  window.once('ready-to-show', () => window.show());
  window.on('closed', () => { releaseRuntimeOwner(contentsId); runtimeGenerations.delete(contentsId); mainWindow = null; });
  window.webContents.once('destroyed', () => { releaseRuntimeOwner(contentsId); });
  window.on('close', (event) => {
    if (allowWindowClose) return;
    event.preventDefault();
    void confirmInvoiceFormClose().then(confirmed => { if (confirmed) void closeHostAndQuit(); });
  });
  window.webContents.on('did-start-navigation', (_event, _url, _inPlace, isMainFrame) => {
    if (isMainFrame) {
      if (invoiceFormBinding) invoiceFormBinding.valid = false;
      runtimeGenerations.set(window.webContents.id, (runtimeGenerations.get(window.webContents.id) ?? 0) + 1);
      releaseRuntimeOwner(window.webContents.id);
      subscriptions.delete(window.webContents.id);
    }
  });
  const rendererUrl = process.env.ELECTRON_RENDERER_URL;
  if (rendererUrl) void window.loadURL(rendererUrl);
  else void window.loadFile(join(resolveWorkspaceRoot(app.getAppPath()), 'out', 'renderer', 'index.html'));
}

function resolveWorkspaceRoot(appPath: string): string {
  let candidate = resolve(appPath);
  for (let depth = 0; depth < 4; depth += 1) {
    if (existsSync(join(candidate, 'apps', 'host', 'main.ts'))) return candidate;
    candidate = dirname(candidate);
  }
  return resolve(appPath);
}

function readProductVersion(appRoot: string): string {
  try {
    const metadata = JSON.parse(readFileSync(join(appRoot, 'package.json'), 'utf8')) as { version?: unknown };
    return typeof metadata.version === 'string' && metadata.version.trim() ? metadata.version.trim() : '0.1.0';
  } catch {
    return '0.1.0';
  }
}

async function contextIpcQuery(command: Extract<HostCommand, { type: 'list_context_snapshots' | 'query_context_snapshot' | 'list_context_requests' }>) {
  try {
    const { version: _version, requestId: _requestId, ...request } = command;
    const checked = parseContextHostResult(command.type, await host.request(request));
    return checked !== null && matchesContextResponse(command, checked) ? checked : contextHostFailure();
  } catch { return contextHostFailure(); }
}

async function assemblyIpcQuery(type: string, input?: unknown) {
  const command = parseHostCommand({ version: 1, requestId: randomUUID(), type, ...(input === undefined ? {} : { input }) });
  const extension = isExtensionHostCommand(type);
  if (!command || !extension && !isResourceHostCommand(type)) return fail(appError('input_invalid', 'input', 'Resource request is invalid.'));
  const epoch = host.connectionEpoch;
  try {
    const { version: _version, requestId: _requestId, ...request } = command;
    const checked = (extension ? parseExtensionHostResult : parseResourceHostResult)(type, await host.request(request));
    return epoch === host.connectionEpoch && checked !== null && (extension ? matchesExtensionResponse : matchesResourceResponse)(command, checked) ? checked : (extension ? extensionHostFailure : resourceHostFailure)(type);
  } catch { return (extension ? extensionHostFailure : resourceHostFailure)(type); }
}
async function compactionIpcRequest(command: HostCommand) {
  const epoch = host.connectionEpoch;
  try {
    const { version: _version, ...request } = command;
    const checked = parseCompactionHostResult(command.type, await host.request(request));
    return epoch === host.connectionEpoch && checked !== null && matchesCompactionResponse(command, checked)
      ? checked : compactionHostFailure();
  } catch {
    return command.type === 'compact_session'
      ? fail(appError('operation_result_unknown', 'runtime', 'The receipt is unknown. Query this operation before any new attempt.'))
      : compactionHostFailure();
  }
}

function registerIpc(): void {
  if (ipcRegistered) return;
  ipcRegistered = true;
  const handle = (channel: string, handler: (event: Electron.IpcMainInvokeEvent, ...args: unknown[]) => Promise<unknown>) => {
    ipcMain.handle(channel, async (event, ...args) => {
      const failure = (error: import('@flowmate/contracts').AppError) => [channels.compactSession, channels.querySessionCompaction, channels.cancelSessionCompaction].some(value => value === channel)
        ? compactionHostFailure() : [channels.querySessionHistory, channels.querySessionHistoryEntry, channels.forkSession, channels.branchSession].some(value => value === channel)
        ? historyHostFailure() : channel === channels.queryRuntimeEvents
        ? { ok: false, error, context: null }
        : (channel === channels.listContextSnapshots || channel === channels.queryContextSnapshot || channel === channels.listContextRequests)
          ? (() => { const parsed = ContextErrorSchema.safeParse(error); return parsed.success ? fail(parsed.data) : contextHostFailure(); })()
          : fail(error);
      if (!isTrustedSender(event)) return failure(appError('ipc_forbidden', 'input', '请求来源不受信任。'));
      if (desktopClosing) return failure(appError('runtime_busy', 'runtime', '桌面应用正在关闭。'));
      try { return await handler(event, ...args); }
      catch { return failure(appError('desktop_operation_failed', 'runtime', '桌面操作失败。', true)); }
    });
  };

  handle(channels.getState, async () => readDesktopState());
  handle(channels.saveSettings, async (_event, settingsRaw, credentialUpdateRaw) => saveSettings(settingsRaw, credentialUpdateRaw));
  handle(channels.listModelCatalog, async (_event, providerId, refresh) => {
    if (providerId !== undefined && (typeof providerId !== 'string' || !/^[a-zA-Z0-9._-]{1,128}$/.test(providerId)))
      return fail(appError('input_invalid', 'input', 'Provider ID is invalid.'));
    if (refresh !== undefined && typeof refresh !== 'boolean') return fail(appError('input_invalid', 'input', 'Refresh request is invalid.'));
    return productHostRequest({ type: 'list_model_catalog', ...(providerId === undefined ? {} : { providerId }), refresh: refresh === true },
      'Pi model catalog is unavailable.', 60_000);
  });
  handle(channels.loginModel, async (_event, modelId, authType, requestId) => {
    if (typeof modelId !== 'string' || !/^[a-zA-Z0-9._-]{1,64}$/.test(modelId)
      || (authType !== 'api_key' && authType !== 'oauth')
      || typeof requestId !== 'string' || !/^[a-zA-Z0-9-]{1,128}$/.test(requestId))
      return fail(appError('input_invalid', 'input', 'Model login request is invalid.'));
    const result = await productHostRequest<{ configured: true }>({ type: 'login_model', modelId, authType, requestId },
      'Model login could not complete.', 190_000);
    if (result.ok) await broadcastState();
    return result;
  });
  handle(channels.logoutModel, async (_event, modelId) => {
    if (typeof modelId !== 'string' || !/^[a-zA-Z0-9._-]{1,64}$/.test(modelId))
      return fail(appError('input_invalid', 'input', 'Model ID is invalid.'));
    const result = await productHostRequest<void>({ type: 'logout_model', modelId }, 'Model logout failed.');
    if (result.ok) await broadcastState();
    return result;
  });
  handle(channels.replyModelAuth, async (_event, loginRequestId, promptId, value) => {
    if (typeof loginRequestId !== 'string' || !/^[a-zA-Z0-9-]{1,128}$/.test(loginRequestId)
      || typeof promptId !== 'string' || !/^[a-zA-Z0-9-]{1,128}$/.test(promptId)
      || value !== null && (typeof value !== 'string' || value.length > 8192))
      return fail(appError('input_invalid', 'input', 'Model login response is invalid.'));
    return productHostRequest({ type: 'auth_reply', loginRequestId, promptId, value }, 'Model login response failed.');
  });
  handle(channels.cancelModelAuth, async (_event, loginRequestId) => {
    if (typeof loginRequestId !== 'string' || !/^[a-zA-Z0-9-]{1,128}$/.test(loginRequestId))
      return fail(appError('input_invalid', 'input', 'Model login request is invalid.'));
    return productHostRequest({ type: 'cancel_login', loginRequestId }, 'Model login cancellation failed.');
  });
  handle(channels.callProvider, async (_event, inputRaw) => callProvider(inputRaw));
  handle(channels.cancelProvider, async (_event, requestIdRaw) => cancelProvider(requestIdRaw));
  handle(channels.queryRun, async (_event, runIdRaw) => queryRun(runIdRaw));
  handle(channels.queryRuntimeEvents, queryRuntimeEvents);
  handle(channels.subscribeRuntimeEvents, subscribeRuntimeEvents);
  handle(channels.unsubscribeRuntimeEvents, unsubscribeRuntimeEvents);
  handle(channels.listRunToolCalls, async (_event, raw) => {
    const input = RunToolCallsRequestSchema.safeParse(raw);
    if (!input.success) return fail(appError('input_invalid', 'input', 'Run tool list request is invalid.'));
    try { return RuntimeToolPageResultSchema.parse(await host.request({ type: 'list_run_tool_calls', input: input.data })); }
    catch { return fail(appError('host_protocol_invalid', 'runtime', 'Run tool list could not be confirmed.', true)); }
  });
  handle(channels.queryRunToolCall, async (_event, raw) => {
    const input = RunToolCallRequestSchema.safeParse(raw);
    if (!input.success) return fail(appError('input_invalid', 'input', 'Run tool request is invalid.'));
    try { return RuntimeToolResultSchema.parse(await host.request({ type: 'query_run_tool_call', input: input.data })); }
    catch { return fail(appError('host_protocol_invalid', 'runtime', 'Run tool could not be confirmed.', true)); }
  });
  for (const type of ['list_resources', 'read_resource_file', 'update_resource_selection', 'query_run_resources', 'read_run_resource_file',
    'list_extensions', 'update_extension_selection', 'query_session_extensions', 'query_run_extensions', 'execute_extension_command', 'dispose_session_extensions'] as const)
    handle(`flowmate:${type.replaceAll('_', '-')}`, async (_event, raw) => assemblyIpcQuery(type, raw));
  handle(channels.listContextSnapshots, async (_event, raw) => {
    const input = ContextSnapshotsRequestSchema.safeParse(raw);
    if (!input.success) return fail(appError('input_invalid', 'input', 'Context snapshot list request is invalid.'));
    return contextIpcQuery({ version: 1, requestId: 'context-ipc', type: 'list_context_snapshots', input: input.data });
  });
  handle(channels.queryContextSnapshot, async (_event, raw) => {
    const input = ContextSnapshotRequestSchema.safeParse(raw);
    if (!input.success) return fail(appError('input_invalid', 'input', 'Context snapshot request is invalid.'));
    return contextIpcQuery({ version: 1, requestId: 'context-ipc', type: 'query_context_snapshot', input: input.data });
  });
  handle(channels.listContextRequests, async (_event, raw) => {
    const input = ContextRequestsRequestSchema.safeParse(raw);
    if (!input.success) return fail(appError('input_invalid', 'input', 'Context request list request is invalid.'));
    return contextIpcQuery({ version: 1, requestId: 'context-ipc', type: 'list_context_requests', input: input.data });
  });
  handle(channels.createSession, async (_event, inputRaw) => createSession(inputRaw));
  for (const [channel, type] of [[channels.querySessionCompaction, 'query_session_compaction'],
    [channels.cancelSessionCompaction, 'cancel_session_compaction']] as const) {
    handle(channel, async (_event, raw) => {
      const command = parseHostCommand({ version: 1, requestId: randomUUID(), type, input: raw });
      if (!command || !isCompactionHostCommand(command.type)) return fail(appError('input_invalid', 'input', 'Compaction request is invalid.'));
      return compactionIpcRequest(command);
    });
  }
  handle(channels.compactSession, async (_event, raw) => {
    const input = DesktopSessionCompactionRequestSchema.safeParse(raw);
    if (!input.success) return fail(appError('input_invalid', 'input', 'Compaction request is invalid.'));
    const state = await readDesktopState();
    if (!state.ok || !state.data.ready) return compactionHostFailure();
    const profile = state.data.settings.models.find(value => value.id === input.data.modelId);
    if (!profile || state.data.modelCredentials[profile.id] !== 'configured')
      return fail(appError('compaction_unavailable', 'runtime', 'Choose a model with configured credentials.'));
    const command = parseHostCommand({ version: 1, requestId: randomUUID(), type: 'compact_session', input: input.data,
      expectedSettingsRevision: state.data.settings.revision, expectedCredentialRef: profile.credentialRef });
    return command ? compactionIpcRequest(command) : compactionHostFailure();
  });
  handle(channels.queryNativeTools, async () => productHostRequest({ type: 'query_native_tools' }, 'Native tool availability could not be loaded.'));
  handle(channels.chooseWorkingDirectory, async () => {
    if (!mainWindow || mainWindow.isDestroyed()) return fail(appError('desktop_not_ready', 'runtime', 'The directory picker is not ready.', true));
    const selected = await dialog.showOpenDialog(mainWindow, { title: 'Choose working directory', properties: ['openDirectory', 'dontAddToRecent'] });
    return { ok: true, data: selected.canceled ? null : selected.filePaths[0] ?? null };
  });
  handle(channels.renameSession, async (_event, inputRaw) => renameSession(inputRaw));
  handle(channels.deleteSession, async (_event, sessionIdRaw) => deleteSession(sessionIdRaw));
  handle(channels.listSessions, async (_event, inputRaw) => listSessions(inputRaw));
  handle(channels.querySession, async (_event, sessionIdRaw) => querySession(sessionIdRaw));
  handle(channels.listSessionRuns, async (_event, inputRaw) => listSessionRuns(inputRaw));
  handle(channels.listSessionMessages, async (_event, inputRaw) => listSessionMessages(inputRaw));
  handle(channels.queryPromptTrace, async (_event, runIdRaw, sequenceRaw) => queryPromptTrace(runIdRaw, sequenceRaw));
  handle(channels.startRun, async (_event, inputRaw) => startRun(inputRaw));
  handle(channels.submitInput, async (_event, inputRaw) => submitInput(inputRaw));
  handle(channels.listSessionInputs, async (_event, raw) => {
    const input = SessionInputsRequestSchema.safeParse(raw);
    return input.success ? productHostRequest({ type: 'list_session_inputs', input: input.data }, 'Chat inputs could not be queried.')
      : fail(appError('input_invalid', 'input', 'Chat input list request is invalid.'));
  });
  handle(channels.setSessionStatus, async (_event, raw) => {
    const input = SetSessionStatusRequestSchema.safeParse(raw);
    return input.success ? productHostRequest({ type: 'set_session_status', input: input.data }, 'Chat status could not be changed.')
      : fail(appError('input_invalid', 'input', 'Chat status request is invalid.'));
  });
  for (const [channel, type] of [[channels.querySessionHistory, 'query_session_history'],
    [channels.querySessionHistoryEntry, 'query_session_history_entry'], [channels.forkSession, 'fork_session'], [channels.branchSession, 'branch_session']] as const) {
    handle(channel, async (_event, raw) => {
      const command = parseHostCommand({ version: 1, requestId: randomUUID(), type, input: raw });
      if (!command || !isHistoryHostCommand(command.type)) return fail(appError('input_invalid', 'input', 'Session history request is invalid.'));
      const epoch = host.connectionEpoch;
      try {
        const { version: _version, ...request } = command;
        const value = parseHistoryHostResult(type, await host.request(request));
        return epoch === host.connectionEpoch && value !== null && matchesHistoryResponse(command, value) ? value : historyHostFailure();
      } catch { return historyHostFailure(); }
    });
  }
  handle(channels.registerInvoiceFormTarget, async (event, raw) => registerInvoiceFormTarget(event, raw));
  handle(channels.invalidateInvoiceFormTarget, async (event, id) => {
    if (!ownedInvoiceForm(event, id)) return fail(appError('state_conflict', 'input', 'Form target is no longer current.'));
    invoiceFormBinding!.valid = false;
    return ok(undefined);
  });
  handle(channels.setInvoiceFormDirty, async (event, id, dirty, revision) => {
    if (!ownedInvoiceForm(event, id) || typeof dirty !== 'boolean' || typeof revision !== 'number' || !Number.isSafeInteger(revision) || revision < invoiceFormBinding!.currentRevision)
      return fail(appError('state_conflict', 'input', 'Form target is no longer current.'));
    invoiceFormBinding!.dirty = dirty;
    invoiceFormBinding!.currentRevision = revision;
    return ok(undefined);
  });
  handle(channels.replyInvoiceFormInspect, async (event, id, raw) => {
    const pending = typeof id === 'string' ? pendingFormInspections.get(id) : undefined;
    if (!pending || pending.owner !== invoiceFormBinding) return fail(appError('state_conflict', 'input', 'Form inspection is no longer current.'));
    const checked = checkedInvoiceFormInspection(pending.owner, raw, { frame: event.senderFrame!, contents: event.sender, epoch: host.connectionEpoch });
    pending.resolve(checked);
    return checked ? ok(undefined) : fail(appError('state_conflict', 'input', 'Form inspection does not match its owner or current revision.'));
  });
  for (const [channel, kind] of [[channels.saveInvoiceCandidate, 'save'], [channels.acceptInvoiceCandidate, 'accept'],
    [channels.rejectInvoiceCandidate, 'reject'], [channels.exportInvoiceCandidate, 'export']] as const) {
    handle(channel, async (event, raw) => {
      try { return await submitInvoiceCandidateOperation({ kind, request: raw }, { frame: event.senderFrame!, contents: event.sender, epoch: host.connectionEpoch }); }
      finally { if (!event.sender.isDestroyed()) event.sender.send('flowmate:invoice-form-inspect-finished'); }
    });
  }
  handle(channels.queryInvoiceCandidateOperation, async (_event, raw) => {
    const input = InvoiceCandidateOperationQuerySchema.safeParse(raw);
    if (!input.success) return fail(appError('input_invalid', 'input', 'Original operation query is invalid.'));
    const result = await productHostRequest<InvoiceCandidateOperationResult>({ type: 'query_invoice_candidate_operation', input: input.data }, 'Original operation could not be queried.');
    if (result.ok && result.data !== null && invoiceFormBinding?.unknownOperationRef === input.data.request.operationRef)
      delete invoiceFormBinding.unknownOperationRef;
    return result;
  });
  handle(channels.startInvoiceFormRun, async (event, raw) => startInvoiceFormRun(event, raw));
  handle(channels.querySessionInput, async (_event, raw) => {
    const input = SessionInputQuerySchema.safeParse(raw);
    return input.success ? productHostRequest({ type: 'query_session_input', input: input.data }, 'Chat input could not be queried.')
      : fail(appError('input_invalid', 'input', 'Chat input query is invalid.'));
  });
  handle(channels.queryInvoiceFormApplication, async (_event, raw) => {
    const input = z.object({ runId: z.number().int().positive(), toolCallId: z.number().int().positive() }).strict().safeParse(raw);
    return input.success ? productHostRequest({ type: 'query_invoice_form_application', input: input.data }, 'Form application could not be queried.')
      : fail(appError('input_invalid', 'input', 'Form application query is invalid.'));
  });
  handle(channels.replyInvoiceFormRequest, async (event, id, raw) => replyInvoiceFormRequest(event, id, raw));
  handle(channels.cancelRun, async (_event, runIdRaw) => cancelRun(runIdRaw));
  handle(channels.queryRuntimeState, async () => queryRuntimeState());
  handle(channels.readWorkspace, async () => productHostRequest({ type: 'read_workspace' }, 'Workspace 暂不可用。'));
  handle(channels.restoreWorkspace, async (_event, ...args) => args.length
    ? fail(appError('input_invalid', 'input', 'Workspace recovery takes no parameters.'))
    : productHostRequest({ type: 'restore_workspace' }, 'Workspace recovery could not be confirmed.', 10_000, 'operation_result_unknown'));
  handle(channels.updateWorkspace, async (_event, raw) => updateWorkspace(raw));
  handle(channels.startTask, async (_event, raw) => startTask(raw));
  handle(channels.queryTaskOperation, async (_event, raw) => queryTaskOperation(raw));
  handle(channels.selectCandidate, async (_event, raw) => selectCandidate(raw));
  handle(channels.listDocuments, async (_event, raw) => listDocuments(raw));
  handle(channels.queryDocument, async (_event, raw) => queryDocument(raw));
  handle(channels.hideDocument, async (_event, raw) => hideDocument(raw));
  handle(channels.listJobs, async (_event, raw) => listJobs(raw));
  handle(channels.queryJob, async (_event, raw) => queryJob(raw));
  handle(channels.hideJob, async (_event, raw) => hideJob(raw));
  handle(channels.listJobCandidates, async (_event, raw) => listJobCandidates(raw));
  handle(channels.queryJobCandidate, async (_event, raw) => queryJobCandidate(raw));
  handle(channels.listActivity, async (_event, raw) => listActivity(raw));
  handle(channels.chooseAndImportInvoice, async () => chooseAndImportInvoice());
  handle(channels.listDocumentPages, async (_event, raw) => {
    const input = invoiceToolSchemas.list_invoice_pages.input.safeParse(raw);
    return input.success ? productHostRequest({ type: 'list_document_pages', input: input.data }, 'Parsed page listing could not be loaded.')
      : fail(appError('input_invalid', 'input', 'Parsed page query is invalid.'));
  });
  handle(channels.readDocumentPage, async (_event, raw) => readDocumentPage(raw));
  handle(channels.readDocumentOriginal, async (_event, documentId, page) => readDocumentOriginal(documentId, page));
  handle(channels.revokeDocumentUse, async (_event, raw) => revokeDocumentUse(raw));
  handle(channels.subscribe, async (event) => {
    const id = event.sender.id;
    subscriptions.set(id, () => undefined);
    for (const binding of runtimeBindings.values()) if (binding.owner.contents.id === id) flushRuntimeWake(binding);
    return { ok: true };
  });
  handle(channels.unsubscribe, async (event) => {
    subscriptions.delete(event.sender.id);
    releaseRuntimeOwner(event.sender.id);
    return { ok: true };
  });
}

function runtimeOwnerIsCurrent(owner: RuntimeOwner): boolean {
  return !owner.contents.isDestroyed() && owner.epoch === host.connectionEpoch
    && owner.generation === (runtimeGenerations.get(owner.contents.id) ?? 0)
    && owner.contents.mainFrame === owner.frame && owner.frame.url === owner.url && isAllowedPage(owner.url)
    && runtimeOwners.get(owner.contents.id) === owner;
}

function runtimeOwner(event: Electron.IpcMainInvokeEvent): RuntimeOwner {
  const existing = runtimeOwners.get(event.sender.id);
  if (existing && runtimeOwnerIsCurrent(existing)) return existing;
  releaseRuntimeOwner(event.sender.id);
  const owner: RuntimeOwner = { token: randomUUID(), contents: event.sender, frame: event.senderFrame!,
    url: event.senderFrame!.url, generation: runtimeGenerations.get(event.sender.id) ?? 0, epoch: host.connectionEpoch };
  runtimeOwners.set(event.sender.id, owner);
  return owner;
}

function rememberRuntimeRelease(id: string, token: string): void {
  runtimeReleased.set(id, token);
  if (runtimeReleased.size > 4096) runtimeReleased.delete(runtimeReleased.keys().next().value!);
}

function releaseRuntimeBinding(binding: RuntimeBinding, cleanup = true): void {
  if (runtimeBindings.get(binding.id) !== binding) return;
  runtimeBindings.delete(binding.id);
  binding.pendingWake = null;
  rememberRuntimeRelease(binding.id, binding.owner.token);
  if (cleanup) binding.cleanup();
}

function releaseRuntimeOwner(contentsId: number): void {
  const owner = runtimeOwners.get(contentsId);
  if (!owner) return;
  for (const binding of runtimeBindings.values()) if (binding.owner === owner) releaseRuntimeBinding(binding);
  runtimeQueries.delete(owner.token);
  runtimeOwners.delete(contentsId);
}

function releaseAllRuntimeOwners(): void {
  for (const id of runtimeOwners.keys()) releaseRuntimeOwner(id);
}

function flushRuntimeWake(binding: RuntimeBinding): void {
  if (binding.pendingWake === null || !binding.open || !subscriptions.has(binding.owner.contents.id)) return;
  if (!runtimeOwnerIsCurrent(binding.owner)) { releaseRuntimeBinding(binding); return; }
  const event: RuntimeEventsWake = { type: 'runtime_events_available', subscriptionId: binding.id,
    runId: binding.runId, sequence: binding.pendingWake };
  binding.pendingWake = null;
  try { binding.owner.contents.send('flowmate:event', event); }
  catch { releaseRuntimeBinding(binding); }
}

function receiveRuntimeWake(raw: unknown): void {
  const parsed = RuntimeEventsWakeSchema.safeParse(raw);
  if (!parsed.success) return;
  const wake = parsed.data, binding = runtimeBindings.get(wake.subscriptionId);
  if (!binding || wake.runId !== binding.runId) return;
  if (!runtimeOwnerIsCurrent(binding.owner)) { releaseRuntimeBinding(binding); return; }
  binding.pendingWake = Math.max(binding.pendingWake ?? 0, wake.sequence);
  flushRuntimeWake(binding);
}

async function subscribeRuntimeEvents(event: Electron.IpcMainInvokeEvent, raw: unknown): Promise<Result<RuntimeSubscriptionInfo>> {
  const input = RuntimeEventsSubscriptionRequestSchema.safeParse(raw);
  if (!input.success) return fail(appError('input_invalid', 'input', 'Runtime observation request is invalid.'));
  const owner = runtimeOwner(event);
  const owned = [...runtimeBindings.values()].filter(binding => binding.owner === owner);
  if (runtimeBindings.size >= 64 || owned.length >= 8)
    return fail(appError('event_subscription_limit', 'runtime', 'Runtime observation capacity is full.', false));
  if (owned.some(binding => binding.runId === input.data.runId && !binding.open))
    return fail(appError('event_subscription_invalid', 'input', 'An observation is already opening for this Run.', false));
  // Reserve the ID and its original connection before sending open; early wakes and late cleanup use this identity.
  const id = randomUUID();
  const binding: RuntimeBinding = { id, owner, runId: input.data.runId, sessionId: input.data.sessionId, open: false,
    pendingWake: null, cleanup: host.captureRuntimeSubscriptionCleanup(owner.token, id) };
  runtimeBindings.set(id, binding);
  try {
    const result = RuntimeSubscriptionResultSchema.parse(await host.request({ type: 'subscribe_runtime_events',
      ownerToken: owner.token, subscriptionId: id, input: input.data }));
    if (!result.ok) { releaseRuntimeBinding(binding); return result; }
    if (runtimeBindings.get(id) !== binding || !runtimeOwnerIsCurrent(owner)) {
      binding.cleanup();
      return fail(appError('event_subscription_invalid', 'input', 'The observation page or connection changed.', false));
    }
    binding.open = true;
    flushRuntimeWake(binding);
    if (runtimeBindings.get(id) !== binding)
      return fail(appError('event_subscription_invalid', 'input', 'The observation could not be delivered.', false));
    return result;
  } catch {
    releaseRuntimeBinding(binding);
    return fail(appError('host_protocol_invalid', 'runtime', 'Runtime observation could not be confirmed.', true));
  }
}

async function queryRuntimeEvents(event: Electron.IpcMainInvokeEvent, raw: unknown): Promise<RuntimeEventsReadResult> {
  const failure = (code: string, category: import('@flowmate/contracts').AppError['category'], message: string, retryable = false): RuntimeEventsReadResult =>
    ({ ok: false, error: appError(code, category, message, retryable), context: null });
  const input = RuntimeEventsQuerySchema.safeParse(raw);
  if (!input.success) return failure('input_invalid', 'input', 'Runtime event query is invalid.');
  const owner = runtimeOwner(event);
  if (input.data.subscriptionId !== undefined) {
    const binding = runtimeBindings.get(input.data.subscriptionId);
    if (!binding || binding.owner !== owner || !binding.open || binding.runId !== input.data.runId || binding.sessionId !== input.data.sessionId)
      return failure('event_subscription_invalid', 'input', 'Runtime observation is not owned by this page.');
  }
  if (runtimeQueries.has(owner.token)) return failure('event_query_busy', 'runtime', 'An event query is already in flight.', true);
  runtimeQueries.add(owner.token);
  try {
    const result = RuntimeEventsReadResultSchema.parse(await host.request({ type: 'query_runtime_events', ownerToken: owner.token, input: input.data }));
    if (!runtimeOwnerIsCurrent(owner)) return failure('event_subscription_invalid', 'input', 'The observation page or connection changed.');
    if (!result.ok && result.error.code === 'event_subscription_invalid' && input.data.subscriptionId !== undefined) {
      const binding = runtimeBindings.get(input.data.subscriptionId);
      if (binding?.owner === owner) releaseRuntimeBinding(binding);
    }
    return result;
  } catch { return failure('host_protocol_invalid', 'runtime', 'Runtime event page could not be confirmed.', true); }
  finally { runtimeQueries.delete(owner.token); }
}

async function unsubscribeRuntimeEvents(event: Electron.IpcMainInvokeEvent, raw: unknown): Promise<Result<void>> {
  const parsed = RuntimeSubscriptionIdSchema.safeParse(raw);
  if (!parsed.success) return fail(appError('input_invalid', 'input', 'Runtime observation ID is invalid.'));
  const id = parsed.data, owner = runtimeOwner(event), binding = runtimeBindings.get(id);
  const previousOwner = binding?.owner.token ?? runtimeReleased.get(id);
  if (previousOwner !== undefined && previousOwner !== owner.token)
    return fail(appError('event_subscription_invalid', 'input', 'Runtime observation is owned by another page.', false));
  if (!binding && previousOwner === owner.token) return ok(undefined);
  if (binding) releaseRuntimeBinding(binding, false);
  try {
    const result = RuntimeSubscriptionReleaseResultSchema.parse(await host.request({ type: 'unsubscribe_runtime_events', ownerToken: owner.token, subscriptionId: id }));
    if (result.ok) rememberRuntimeRelease(id, owner.token);
    else binding?.cleanup();
    return result;
  } catch {
    binding?.cleanup();
    return fail(appError('host_protocol_invalid', 'runtime', 'Runtime observation release could not be confirmed.', true));
  }
}

async function readDesktopState(): Promise<Result<DesktopState>> {
  let base: Result<Omit<DesktopState, 'modelCredentials'>>;
  try { base = await host.request({ type: 'get_state' }) as Result<Omit<DesktopState, 'modelCredentials'>>; }
  catch { return fail(appError(hostErrorCode, 'runtime', 'Bun Host 当前不可用。', true)); }
  if (!base.ok) return base;
  const modelCredentials: Record<string, 'missing' | 'configured' | 'unavailable'> = {};
  if (base.data.settings) {
    const settings = base.data.settings as ProductSettings;
    await Promise.all(settings.models.map(async (model) => {
      modelCredentials[model.id] = await modelCredentialStatus(model);
    }));
  }
  return { ok: true, data: {
    ...base.data,
    ...(hostError ? { ready: false, host: 'error' as const } : {}),
    modelCredentials,
  } };
}

async function modelCredentialStatus(model: ProductSettings['models'][number]): Promise<'missing' | 'configured' | 'unavailable'> {
  const store = credentialStore(model.credentialRef);
  const status = await store.status();
  if (status !== 'configured' || model.kind !== 'catalog') return status;
  const saved = await store.read();
  if (!saved.ok) return 'unavailable';
  if (!saved.data) return 'missing';
  if (!saved.data.startsWith(piCredentialPrefix)) return saved.data.trim() ? 'configured' : 'missing';
  try {
    const credential = JSON.parse(saved.data.slice(piCredentialPrefix.length)) as { type?: unknown; key?: unknown };
    return credential.type === 'api_key' && typeof credential.key === 'string' && credential.key.trim()
      ? 'configured' : 'missing';
  } catch { return 'unavailable'; }
}

async function saveSettings(settingsRaw: unknown, credentialUpdateRaw: unknown): Promise<Result<ProductSettings>> {
  const parsed = validateProductSettings(settingsRaw);
  if (!parsed.ok) return parsed;
  const previousResult = await requestHost({ type: 'get_state' }) as Result<Omit<DesktopState, 'modelCredentials'>>;
  if (!previousResult.ok || !previousResult.data.settings) return fail(appError(hostErrorCode, 'runtime', 'Bun Host 尚未就绪。', true));
  const previous = previousResult.data.settings as ProductSettings;
  let next = parsed.data;
  let newCredentialRef: string | null = null;
  let update: { modelId: string; apiKey: string } | null = null;
  const previousModels = new Map(previous.models.map((model) => [model.id, model]));
  next = { ...next, models: next.models.map((model) => {
    const prior = previousModels.get(model.id);
    const sameCredentialTarget = prior?.kind === model.kind && (model.kind === 'catalog'
      ? prior.providerId === model.providerId
      : model.kind === 'custom' ? prior.baseUrl === model.baseUrl && prior.api === model.api : true);
    return { ...model, credentialRef: sameCredentialTarget ? prior!.credentialRef : randomUUID().replaceAll('-', '') };
  }) };
  if (credentialUpdateRaw !== undefined && credentialUpdateRaw !== null) {
    if (typeof credentialUpdateRaw !== 'object') return fail(appError('credential_invalid', 'input', '模型凭据输入无效。'));
    const candidate = credentialUpdateRaw as { modelId?: unknown; apiKey?: unknown };
    if (typeof candidate.modelId !== 'string' || !/^[a-zA-Z0-9._-]{1,64}$/.test(candidate.modelId)
      || typeof candidate.apiKey !== 'string' || !candidate.apiKey.trim() || candidate.apiKey.length > 4096) {
      return fail(appError('credential_invalid', 'input', '模型凭据输入无效。'));
    }
    const nextModel = next.models.find((model) => model.id === candidate.modelId);
    if (!nextModel) return fail(appError('credential_model_missing', 'input', '凭据对应的模型配置不存在。'));
    newCredentialRef = randomUUID().replaceAll('-', '');
    next = {
      ...next,
      models: next.models.map((model) => model.id === candidate.modelId ? { ...model, credentialRef: newCredentialRef! } : model),
    };
    update = { modelId: candidate.modelId, apiKey: candidate.apiKey };
  }
  const validated = validateProductSettings(next);
  if (!validated.ok) return validated;
  if (validated.data.revision !== previous.revision) return fail(appError('config_revision_conflict', 'input', '配置已变化，请重新加载后再保存。', true));

  if (update && newCredentialRef) {
    const stored = await credentialStore(newCredentialRef).write(update.apiKey);
    if (!stored.ok) return stored;
  }
  const saved = await requestHost({ type: 'save_settings', settings: validated.data }) as Result<ProductSettings>;
  if (!saved.ok) {
    if (newCredentialRef) await credentialStore(newCredentialRef).remove();
    return saved;
  }
  const nextRefs = new Set(saved.data.models.map((model) => model.credentialRef));
  for (const priorModel of previous.models) {
    if (!nextRefs.has(priorModel.credentialRef)) {
      const removed = await credentialStore(priorModel.credentialRef).remove();
      if (!removed.ok) process.stderr.write('[Flowmate] An obsolete encrypted credential could not be removed.\n');
    }
  }
  await broadcastState();
  return saved;
}

async function callProvider(inputRaw: unknown): Promise<Result<{ requestId: string; runId: number }>> {
  if (!providerTestSchema(inputRaw)) return fail(appError('input_invalid', 'input', 'Provider 请求参数无效。'));
  const state = await readDesktopState();
  if (!state.ok) return state;
  if (!state.data.ready) return fail(appError(hostErrorCode, 'runtime', 'Bun Host 尚未就绪。', true));
  const model = state.data.settings.models.find((item) => item.id === inputRaw.modelId);
  if (!model) return fail(appError('model_not_configured', 'input', '所选模型配置不存在。'));
  if (state.data.modelCredentials[model.id] !== 'configured')
    return fail(appError('model_credential_missing', 'input', 'Save an API key for this model in Models.'));
  const requestId = randomUUID();
  try {
    const value = await host.request({
      type: 'call_provider',
      requestId,
      input: inputRaw,
    }, 15_000) as Result<{ accepted: boolean; requestId: string; runId: number }>;
    if (!value.ok) return value;
    if (!value.data.accepted || value.data.requestId !== requestId || !Number.isSafeInteger(value.data.runId)) {
      return fail(appError('host_protocol_invalid', 'runtime', 'Bun Host 返回的请求关联无效。'));
    }
    return { ok: true, data: { requestId, runId: value.data.runId } };
  } catch {
    return fail(appError('host_request_failed', 'runtime', 'Provider 请求未能提交给 Bun Host。', true));
  }
}

async function cancelProvider(value: unknown): Promise<Result<{ accepted: boolean; runId: number | null }>> {
  if (typeof value !== 'string' || value.length > 128) return fail(appError('input_invalid', 'input', '取消请求身份无效。'));
  try {
    return await host.request({ type: 'cancel_provider', targetRequestId: value }) as Result<{ accepted: boolean; runId: number | null }>;
  } catch { return fail(appError('host_request_failed', 'runtime', '取消命令未能提交给 Bun Host。', true)); }
}

async function queryRun(value: unknown): Promise<Result<RunSnapshot>> {
  if (!Number.isSafeInteger(value) || Number(value) <= 0) return fail(appError('input_invalid', 'input', 'Run ID 无效。'));
  try { return await host.request({ type: 'query_run', runId: Number(value) }) as Result<RunSnapshot>; }
  catch { return fail(appError('host_request_failed', 'runtime', 'Run 查询未能提交给 Bun Host。', true)); }
}

async function updateWorkspace(raw: unknown) {
  const input = WorkspaceUpdateRequestSchema.safeParse(raw);
  if (!input.success) return fail(appError('input_invalid', 'input', 'Workspace 更新参数无效。'));
  return productHostRequest({ type: 'update_workspace', input: input.data }, 'Workspace update could not be confirmed.', 10_000, 'operation_result_unknown');
}

async function startTask(raw: unknown) {
  const input = StartTaskRequestSchema.safeParse(raw);
  if (!input.success) return fail(appError('input_invalid', 'input', 'Start Task 参数无效。'));
  return productHostRequest({ type: 'start_task', input: input.data }, 'Start Task 未能提交。');
}

async function queryTaskOperation(raw: unknown) {
  if (!Number.isSafeInteger(raw) || Number(raw) < 1) return fail(appError('input_invalid', 'input', 'Task 操作序号无效。'));
  return productHostRequest({ type: 'query_task_operation', clientSequence: Number(raw) }, 'Task 操作暂不可用。');
}

async function selectCandidate(raw: unknown) {
  const input = SelectCandidateRequestSchema.safeParse(raw);
  if (!input.success) return fail(appError('input_invalid', 'input', '候选选择参数无效。'));
  return productHostRequest({ type: 'select_candidate', input: input.data }, '候选选择未能提交。');
}

async function listDocuments(raw: unknown) {
  const input = pageInput(raw, []);
  if (!input) return fail(appError('input_invalid', 'input', 'Document 分页参数无效。'));
  return productHostRequest({ type: 'list_documents', input }, 'Document 列表暂不可用。');
}

async function queryDocument(raw: unknown) {
  if (!validId(raw)) return fail(appError('input_invalid', 'input', 'Document ID 无效。'));
  return productHostRequest({ type: 'query_document', documentId: raw }, 'Document 查询暂不可用。');
}

async function hideDocument(raw: unknown) {
  if (!validId(raw)) return fail(appError('input_invalid', 'input', 'Invoice reference is invalid.'));
  return productHostRequest({ type: 'hide_document', documentId: raw }, 'Invoice could not be removed.');
}

async function listJobs(raw: unknown) {
  const input = pageInput(raw, ['documentId']);
  if (!input || 'documentId' in input && !validId(input.documentId)) return fail(appError('input_invalid', 'input', 'Job 分页参数无效。'));
  return productHostRequest({ type: 'list_jobs', input }, 'Job 列表暂不可用。');
}

async function queryJob(raw: unknown) {
  if (!validId(raw)) return fail(appError('input_invalid', 'input', 'Job ID 无效。'));
  return productHostRequest({ type: 'query_job', jobId: raw }, 'Job 查询暂不可用。');
}

async function hideJob(raw: unknown) {
  if (!validId(raw)) return fail(appError('input_invalid', 'input', 'Processing record ID is invalid.'));
  return productHostRequest({ type: 'hide_job', jobId: raw }, 'Processing record could not be removed.');
}

async function listJobCandidates(raw: unknown) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return fail(appError('input_invalid', 'input', 'Candidate 分页参数无效。'));
  const value = raw as Record<string, unknown>;
  if (!validId(value.jobId) || value.beforeSequence !== undefined && value.beforeSequence !== null && !validId(value.beforeSequence)
    || value.limit !== undefined && (!Number.isSafeInteger(value.limit) || Number(value.limit) < 1 || Number(value.limit) > 100)
    || Object.keys(value).some((key) => !['jobId', 'beforeSequence', 'limit'].includes(key))) {
    return fail(appError('input_invalid', 'input', 'Candidate 分页参数无效。'));
  }
  return productHostRequest({ type: 'list_job_candidates', input: {
    jobId: value.jobId as number,
    ...(value.beforeSequence === undefined ? {} : { beforeSequence: value.beforeSequence as number | null }),
    ...(value.limit === undefined ? {} : { limit: value.limit as number }),
  } }, 'Candidate 列表暂不可用。');
}

async function queryJobCandidate(raw: unknown) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return fail(appError('input_invalid', 'input', 'Candidate 查询参数无效。'));
  const value = raw as Record<string, unknown>;
  if (!validId(value.jobId) || !validId(value.candidateId) || Object.keys(value).some((key) => !['jobId', 'candidateId'].includes(key))) {
    return fail(appError('input_invalid', 'input', 'Candidate 查询参数无效。'));
  }
  return productHostRequest({ type: 'query_job_candidate', input: { jobId: value.jobId, candidateId: value.candidateId } }, 'Candidate 查询暂不可用。');
}

async function listActivity(raw: unknown) {
  const input = pageInput(raw, ['jobId', 'documentId']);
  if (!input || (('jobId' in input) === ('documentId' in input))) return fail(appError('input_invalid', 'input', 'Activity 分页参数无效。'));
  const id = 'jobId' in input ? input.jobId : input.documentId;
  if (!validId(id)) return fail(appError('input_invalid', 'input', 'Activity 所属 ID 无效。'));
  const paging = { ...(input.beforeId === undefined ? {} : { beforeId: input.beforeId }),
    ...(input.limit === undefined ? {} : { limit: input.limit }) };
  const filtered = 'jobId' in input ? { ...paging, jobId: id } : { ...paging, documentId: id };
  return productHostRequest({ type: 'list_activity', input: filtered }, 'Activity 暂不可用。');
}

async function chooseAndImportInvoice(): Promise<Result<import('@flowmate/contracts').DocumentSnapshot | null>> {
  if (!mainWindow || mainWindow.isDestroyed()) return fail(appError('desktop_not_ready', 'runtime', '材料选择窗口尚未就绪。', true));
  const selected = await dialog.showOpenDialog(mainWindow, { title: '选择正式发票材料',
    defaultPath: join(resolveWorkspaceRoot(app.getAppPath()), 'data', 'invoices', 'agent-input'),
    properties: ['openDirectory', 'dontAddToRecent'] });
  if (selected.canceled) return { ok: true, data: null };
  const sourceDirectory = selected.filePaths[0];
  if (!sourceDirectory) return fail(appError('input_invalid', 'input', '未选择材料目录。'));
  return productHostRequest({ type: 'import_invoice_material', sourceDirectory }, '材料导入未能提交。', 120_000);
}

async function readDocumentPage(raw: unknown) {
  const input = invoiceToolSchemas.read_invoice_document.input.safeParse(raw);
  if (!input.success) return fail(appError('input_invalid', 'input', '解析页面参数无效。'));
  return productHostRequest({ type: 'read_document_page', input: input.data }, '解析页面暂不可用。');
}

async function readDocumentOriginal(documentIdRaw: unknown, pageRaw: unknown) {
  if (!validId(documentIdRaw) || pageRaw !== 1) return fail(appError('input_invalid', 'input', '原图查询参数无效。'));
  const response = await productHostRequest<import('@flowmate/contracts').DocumentOriginalImage>(
    { type: 'read_document_original', documentId: documentIdRaw, page: 1 }, '原图暂不可用。', 30_000);
  if (!response.ok) return response;
  const value = response.data;
  if (value.documentRef.id !== documentIdRaw || !['image/jpeg', 'image/png'].includes(value.mimeType)
    || typeof value.base64 !== 'string' || value.base64.length > 14 * 1024 * 1024 || !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(value.base64)) {
    return fail(appError('host_protocol_invalid', 'runtime', 'Host 返回的原图数据无效。'));
  }
  return response;
}

async function revokeDocumentUse(documentIdRaw: unknown) {
  if (!Number.isSafeInteger(documentIdRaw) || Number(documentIdRaw) < 1) return fail(appError('input_invalid', 'input', 'Document ID 无效。'));
  return productHostRequest({ type: 'revoke_document_use', documentId: Number(documentIdRaw) }, '材料使用权限撤回失败。');
}

type MainPageInput = { beforeId?: number; limit?: number; documentId?: number; jobId?: number };
function pageInput(raw: unknown, extraKeys: readonly string[]): MainPageInput | null {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const value = raw as Record<string, unknown>;
  if (Object.keys(value).some((key) => !['beforeId', 'limit', ...extraKeys].includes(key))
    || value.beforeId !== undefined && !validId(value.beforeId)
    || value.limit !== undefined && (!Number.isSafeInteger(value.limit) || Number(value.limit) < 1 || Number(value.limit) > 100)
    || extraKeys.some((key) => key in value && !validId(value[key]))) return null;
  return Object.fromEntries(Object.entries(value).filter(([, item]) => item !== undefined)) as MainPageInput;
}

function validId(value: unknown): value is number { return Number.isSafeInteger(value) && Number(value) > 0; }

async function productHostRequest<T = unknown>(command: Parameters<HostClient['request']>[0], message: string,
  timeoutMs = 10_000, transportErrorCode = hostErrorCode): Promise<Result<T>> {
  const epoch = host.connectionEpoch;
  try {
    const result = await host.request(command, timeoutMs) as Result<T>;
    return epoch === host.connectionEpoch ? result : fail(appError(transportErrorCode, 'runtime', message, true));
  } catch (error) {
    return fail(appError(error instanceof Error && error.message === 'host_protocol_invalid' ? 'host_protocol_invalid' : transportErrorCode,
      'runtime', message, true));
  }
}

async function createSession(raw: unknown): Promise<Result<SessionSnapshot>> {
  const input = normalizeCreateSessionRequest(raw);
  if (!input.ok) return input;
  try { return await host.request({ type: 'create_session', input: input.data }) as Result<SessionSnapshot>; }
  catch { return fail(appError('host_request_failed', 'runtime', 'New Session 未能提交给 Bun Host。', true)); }
}

async function renameSession(raw: unknown): Promise<Result<SessionSnapshot>> {
  const input = normalizeRenameSessionRequest(raw);
  if (!input.ok) return input;
  try { return await host.request({ type: 'rename_session', input: input.data }) as Result<SessionSnapshot>; }
  catch { return fail(appError('host_request_failed', 'runtime', 'Session 重命名未能提交给 Bun Host。', true)); }
}

async function deleteSession(raw: unknown): Promise<Result<import('@flowmate/contracts').DeleteSessionResult>> {
  const sessionId = normalizeSessionId(raw);
  if (!sessionId.ok) return sessionId;
  try { return await host.request({ type: 'delete_session', sessionId: sessionId.data }) as Result<import('@flowmate/contracts').DeleteSessionResult>; }
  catch { return fail(appError('host_request_failed', 'runtime', 'Session could not be submitted for deletion to Bun Host.', true)); }
}

async function listSessions(raw?: unknown): Promise<Result<SessionPage>> {
  const input = normalizeListSessionsRequest(raw);
  if (!input.ok) return input;
  try { return await host.request({ type: 'list_sessions', input: input.data }) as Result<SessionPage>; }
  catch { return fail(appError('host_request_failed', 'runtime', 'Session 列表暂不可用。', true)); }
}

async function querySession(value: unknown): Promise<Result<SessionSnapshot>> {
  if (!Number.isSafeInteger(value) || Number(value) <= 0) return fail(appError('input_invalid', 'input', 'Session ID 无效。'));
  try { return await host.request({ type: 'query_session', sessionId: Number(value) }) as Result<SessionSnapshot>; }
  catch { return fail(appError('host_request_failed', 'runtime', 'Session 查询暂不可用。', true)); }
}

async function listSessionRuns(raw: unknown): Promise<Result<SessionRunsPage>> {
  const input = normalizeSessionRunsRequest(raw);
  if (!input.ok) return input;
  try { return await host.request({ type: 'list_session_runs', input: input.data }) as Result<SessionRunsPage>; }
  catch { return fail(appError('host_request_failed', 'runtime', 'Session Run 历史暂不可用。', true)); }
}

async function listSessionMessages(raw: unknown): Promise<Result<SessionMessagesPage>> {
  const input = normalizeSessionMessagesRequest(raw);
  if (!input.ok) return input;
  try {
    const result = await host.request({ type: 'list_session_messages', input: input.data }) as Result<unknown>;
    if (!result || typeof result !== 'object' || result.ok !== true && result.ok !== false) {
      return fail(appError('session_history_invalid', 'session', 'Message query returned an invalid result.'));
    }
    if (!result.ok) {
      const error = AppErrorSchema.safeParse(result.error);
      return error.success ? { ok: false, error: error.data }
        : fail(appError('session_history_invalid', 'session', 'Message query returned an invalid error.'));
    }
    const parsed = SessionMessagesPageSchema.safeParse(result.data);
    return parsed.success && parsed.data.session.sessionId === input.data.sessionId ? { ok: true, data: parsed.data }
      : fail(appError('session_history_invalid', 'session', 'Message query returned an invalid projection.'));
  } catch { return fail(appError('host_request_failed', 'runtime', 'Session 消息暂不可用。', true)); }
}

async function queryPromptTrace(runIdRaw: unknown, sequenceRaw?: unknown): Promise<Result<PromptTraceResult>> {
  if (!Number.isSafeInteger(runIdRaw) || Number(runIdRaw) <= 0
    || (sequenceRaw !== undefined && (!Number.isSafeInteger(sequenceRaw) || Number(sequenceRaw) <= 0))) {
    return fail(appError('input_invalid', 'input', 'Prompt Trace 查询参数无效。'));
  }
  try {
    return await host.request({ type: 'query_prompt_trace', runId: Number(runIdRaw), ...(sequenceRaw === undefined ? {} : { callSequence: Number(sequenceRaw) }) }) as Result<PromptTraceResult>;
  } catch {
    return { ok: true, data: { availability: 'source-unavailable', calls: [], droppedCalls: null } };
  }
}

async function startRun(raw: unknown): Promise<Result<RunAccepted & { requestId: string }>> {
  if (!isDesktopAgentRunRequest(raw)) return fail(appError('input_invalid', 'input', 'Agent Run 参数无效。'));
  const state = await readDesktopState();
  if (!state.ok) return state;
  if (!state.data.ready) return fail(appError(hostErrorCode, 'runtime', 'Bun Host 尚未就绪。', true));
  const profile = state.data.settings.models.find((item) => item.id === raw.modelId);
  if (!profile) return fail(appError('model_not_configured', 'input', '所选模型配置不存在。'));
  if (state.data.modelCredentials[profile.id] !== 'configured')
    return fail(appError('model_credential_missing', 'input', 'Save an API key for this model in Models.'));

  const requestId = randomUUID();
  try {
    const value = await host.request({
      type: 'start_run',
      requestId,
      input: raw,
      expectedSettingsRevision: state.data.settings.revision,
      expectedCredentialRef: profile.credentialRef,
    }, 15_000) as Result<RunAccepted & { requestId: string }>;
    if (!value.ok) return value;
    if (value.data.requestId !== requestId || !Number.isSafeInteger(value.data.runId) || value.data.runId <= 0 || value.data.sessionId !== raw.sessionId) {
      return fail(appError('host_protocol_invalid', 'runtime', 'Bun Host 返回的 Agent Run 关联无效。'));
    }
    return value;
  } catch {
    return fail(appError('operation_result_unknown', 'runtime', 'Agent Run 受理结果未知。请查询 Session Runs 与 Runtime 状态，不要重新发送。', true));
  }
}

async function submitInput(raw: unknown): Promise<Result<SessionInputAccepted & { requestId: string }>> {
  const parsed = DesktopSessionInputRequestSchema.safeParse(raw);
  if (!parsed.success) return fail(appError('input_invalid', 'input', 'Chat input is invalid.'));
  const input = parsed.data;
  const requestId = randomUUID();
  let preparation: { expectedSettingsRevision: number; expectedCredentialRef: string } | undefined;
  if (input.mode === 'prompt') {
    const state = await readDesktopState();
    if (!state.ok) return state;
    if (!state.data.ready) return fail(appError(hostErrorCode, 'runtime', 'Bun Host is not ready.', true));
    const profile = state.data.settings.models.find(item => item.id === input.modelId);
    // Host compares the original input before resolving today's profile or credential.
    if (profile) preparation = { expectedSettingsRevision: state.data.settings.revision, expectedCredentialRef: profile.credentialRef };
  }
  try {
    const value = await host.request({ type: 'submit_session_input', requestId, input, ...preparation }, 15_000) as Result<SessionInputAccepted & { requestId: string }>;
    if (!value.ok) return value;
    if (value.data.requestId !== requestId || value.data.sessionId !== input.sessionId
      || !Number.isSafeInteger(value.data.runId) || value.data.runId <= 0
      || !Number.isSafeInteger(value.data.inputId) || value.data.inputId <= 0
      || input.mode !== 'prompt' && value.data.runId !== input.runId)
      return fail(appError('operation_result_unknown', 'runtime', 'Chat input receipt could not be confirmed. Check input status.', true));
    return value;
  } catch {
    return fail(appError('operation_result_unknown', 'runtime', 'Chat input receipt is unknown. Check input status before sending again.', true));
  }
}

async function cancelRun(value: unknown): Promise<Result<{ accepted: boolean; runId: number }>> {
  if (!Number.isSafeInteger(value) || Number(value) <= 0) return fail(appError('input_invalid', 'input', 'Run ID 无效。'));
  try { return await host.request({ type: 'cancel_run', runId: Number(value) }) as Result<{ accepted: boolean; runId: number }>; }
  catch { return fail(appError('host_request_failed', 'runtime', 'Stop 命令未能提交给 Bun Host。', true)); }
}

async function queryRuntimeState(): Promise<Result<RuntimeState>> {
  try { return await host.request({ type: 'query_runtime_state' }) as Result<RuntimeState>; }
  catch { return fail(appError('host_request_failed', 'runtime', 'Runtime 状态暂不可用。', true)); }
}

function isDesktopAgentRunRequest(value: unknown): value is DesktopAgentRunRequest {
  if (!value || typeof value !== 'object' || Array.isArray(value)
    || Object.keys(value).some((key) => !['sessionId', 'text', 'modelId', 'workspace', 'goalMode', 'workingDirectory', 'budget', 'timeoutMs', 'stopGraceMs', 'requiredSkill'].includes(key))) return false;
  const request = value as Partial<DesktopAgentRunRequest>;
  const workspace = request.workspace === undefined ? null : WorkspaceExpectationSchema.safeParse(request.workspace);
  return Number.isSafeInteger(request.sessionId) && Number(request.sessionId) > 0
    && typeof request.text === 'string' && request.text.trim().length > 0
    && new TextEncoder().encode(request.text).byteLength <= 65_536
    && typeof request.modelId === 'string' && /^[a-zA-Z0-9._-]{1,64}$/.test(request.modelId)
    && (workspace === null || workspace.success && workspace.data.sessionId === request.sessionId)
    && (request.goalMode === 'answer' || request.goalMode === 'save-candidate')
    && (request.requiredSkill === undefined || ResourceRefSchema.safeParse(request.requiredSkill).success && request.requiredSkill.kind === 'skill')
    && (request.workingDirectory === undefined || WorkingDirectorySchema.safeParse(request.workingDirectory).success)
    && (request.workingDirectory === undefined || workspace?.success === true)
    && (request.goalMode !== 'save-candidate' || workspace?.success === true
      && workspace.data.documentRef !== null && workspace.data.jobId !== null)
    && RuntimeRequestOverridesSchema.safeParse({ budget: request.budget, timeoutMs: request.timeoutMs, stopGraceMs: request.stopGraceMs }).success;
}

function credentialStore(reference: string): CredentialStore {
  if (!/^[a-zA-Z0-9_-]{16,80}$/.test(reference)) throw new Error('invalid_credential_reference');
  let store = credentialStores.get(reference);
  if (!store) {
    const hash = createHash('sha256').update(reference).digest('hex');
    const file = join(userDataRoot, 'security', 'credentials', `${hash}.json`);
    store = createCredentialStore(file, systemSecureStorage);
    credentialStores.set(reference, store);
  }
  return store;
}

async function handleHostCredentialRequest(request: HostCredentialRequest): Promise<{ ok: boolean; credential?: unknown }> {
  const settings = host.state?.settings as ProductSettings | undefined;
  if (!settings?.models.some((model) => model.credentialRef === request.credentialRef)) return { ok: false };
  const store = credentialStore(request.credentialRef);
  if (request.operation === 'read') {
    const result = await store.read();
    if (!result.ok) return { ok: false };
    if (!result.data) return { ok: true };
    if (!result.data.startsWith(piCredentialPrefix)) return { ok: true, credential: { type: 'api_key', key: result.data } };
    try { return { ok: true, credential: JSON.parse(result.data.slice(piCredentialPrefix.length)) as unknown }; }
    catch { return { ok: false }; }
  }
  if (request.operation === 'delete') return { ok: (await store.remove()).ok };
  if (!validPiCredential(request.credential)) return { ok: false };
  return { ok: (await store.write(`${piCredentialPrefix}${JSON.stringify(request.credential)}`)).ok };
}

function validPiCredential(value: unknown): boolean {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const credential = value as Record<string, unknown>;
  if (credential.type === 'api_key' && credential.key !== undefined && typeof credential.key !== 'string') return false;
  if (credential.type === 'oauth' && (typeof credential.access !== 'string' || typeof credential.refresh !== 'string'
    || typeof credential.expires !== 'number' || !Number.isFinite(credential.expires))) return false;
  if (credential.type !== 'api_key' && credential.type !== 'oauth') return false;
  try { return JSON.stringify(value).length <= 65_536; } catch { return false; }
}

async function requestHost(command: Parameters<HostClient['request']>[0]): Promise<unknown> {
  try { return await host.request(command); }
  catch { return fail(appError('host_request_failed', 'runtime', 'Bun Host 命令未能完成。', true)); }
}

async function broadcastState(): Promise<void> {
  const sequence = ++stateBroadcastSequence;
  const result = await readDesktopState();
  if (sequence !== stateBroadcastSequence) return;
  const state: DesktopState = result.ok ? result.data : {
    version: 1,
    ready: false,
    host: 'error',
    modelCredentials: {},
    settings: defaultProductSettings(),
    appVersion,
    userDataPath: userDataRoot,
  };
  const event: DesktopEvent = { type: 'host_state', state };
  for (const window of BrowserWindow.getAllWindows()) {
    if (!window.webContents.isDestroyed()) window.webContents.send('flowmate:event', event);
  }
}

function sameFormWorkspace(expected: DesktopInvoiceFormWorkspace, actual: DesktopInvoiceFormWorkspace): boolean {
  return expected.revision === actual.revision && sameFormWorkspaceBasis(expected, actual);
}

function sameFormWorkspaceBasis(expected: DesktopInvoiceFormWorkspace, actual: DesktopInvoiceFormWorkspace): boolean {
  return expected.sessionId === actual.sessionId && expected.jobId === actual.jobId
    && expected.documentRef?.id === actual.documentRef?.id && expected.documentRef?.version === actual.documentRef?.version
    && expected.candidateRef?.id === actual.candidateRef?.id && expected.candidateRef?.sequence === actual.candidateRef?.sequence;
}

function ownedInvoiceForm(event: Electron.IpcMainInvokeEvent, id: unknown): boolean {
  return typeof id === 'string' && invoiceFormBinding !== null && invoiceFormBinding.target.formInstanceId === id
    && invoiceFormBinding.frame === event.senderFrame && invoiceFormBinding.contents === event.sender;
}

async function registerInvoiceFormTarget(event: Electron.IpcMainInvokeEvent, raw: unknown) {
  const input = z.object({ purpose: z.enum(['fill', 'edit']), formRevision: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
    workspace: WorkspaceExpectationSchema.extend({ sessionId: z.number().int().positive().max(Number.MAX_SAFE_INTEGER).nullable() }).strict(),
  }).strict().safeParse(raw);
  if (!input.success || !input.data.workspace.documentRef || !input.data.workspace.jobId || !input.data.workspace.candidateRef
    || input.data.purpose === 'fill' && input.data.workspace.sessionId === null) return fail(appError('input_invalid', 'input', 'Choose a saved candidate before preparing the form.'));
  if (invoiceFormBinding?.dirty || invoiceFormBinding?.mutationPending) return fail(appError('state_conflict', 'input', 'Keep or discard the current edits first.'));
  const expected = input.data.workspace;
  const [current, job, candidate, runtime] = await Promise.all([
    productHostRequest<WorkspaceSnapshot>({ type: 'read_workspace' }, 'Workspace is unavailable.'),
    productHostRequest<JobSnapshot>({ type: 'query_job', jobId: expected.jobId! }, 'Task is unavailable.'),
    productHostRequest<CandidateJobDetail>({ type: 'query_job_candidate', input: { jobId: expected.jobId!, candidateId: expected.candidateRef!.id } }, 'Candidate is unavailable.'),
    queryRuntimeState(),
  ]);
  if (!current.ok) return current;
  if (!job.ok) return job;
  if (!candidate.ok) return candidate;
  if (!runtime.ok) return runtime;
  if (!sameFormWorkspace(expected, current.data) || current.data.invalidReferences.length
    || job.data.currentCandidateId !== expected.candidateRef!.id || job.data.status === 'completed'
    || candidate.data.candidate.status === 'accepted' || candidate.data.candidate.sequence !== expected.candidateRef!.sequence
    || candidate.data.documentRef.id !== expected.documentRef!.id || candidate.data.documentRef.version !== expected.documentRef!.version) {
    return fail(appError('state_conflict', 'input', 'The selected candidate or Workspace changed.'));
  }
  if (runtime.data.blocked || runtime.data.active) return fail(appError('runtime_busy', 'runtime', 'Wait for the actual execution to release the Runtime.'));
  if (input.data.purpose === 'fill') {
    const session = await querySession(expected.sessionId);
    if (!session.ok) return session;
    if (session.data.modelUseBlocked || session.data.availability !== 'ready') return fail(appError('session_scope_revoked', 'session', 'This Session is unavailable for model use.'));
  }
  const target = { formInstanceId: randomUUID(), expectedRevision: input.data.formRevision };
  invoiceFormBinding = { frame: event.senderFrame!, contents: event.sender, epoch: host.connectionEpoch, currentRevision: input.data.formRevision,
    workspace: expected, purpose: input.data.purpose, target, valid: true, dirty: false, runId: null, pendingFill: false };
  return ok(target);
}

async function startInvoiceFormRun(event: Electron.IpcMainInvokeEvent, raw: unknown) {
  const input = InvoiceFormRunInputSchema.safeParse(raw);
  const binding = invoiceFormBinding;
  if (!input.success || !binding || !ownedInvoiceForm(event, input.data.target.formInstanceId) || !binding.valid
    || binding.epoch !== host.connectionEpoch || binding.purpose !== 'fill' || binding.dirty
    || binding.target.expectedRevision !== input.data.target.expectedRevision || !sameFormWorkspace(binding.workspace, input.data.workspace)) {
    return fail(appError('state_conflict', 'input', 'The form target changed. Prepare a new Fill after checking the current form.'));
  }
  if (binding.clientSequence !== undefined) {
    if (binding.clientSequence !== input.data.clientSequence || binding.modelId !== input.data.modelId) return fail(appError('state_conflict', 'input', 'This target already belongs to a different input.'));
    const original = await productHostRequest<import('@flowmate/contracts').SessionInputQueryResult>({ type: 'query_session_input',
      input: { sessionId: input.data.workspace.sessionId, clientSequence: input.data.clientSequence } }, 'Fill admission is unknown.');
    if (!original.ok || !original.data.input?.runId) return fail(appError('operation_result_unknown', 'runtime', 'Fill admission is unknown. Query its original input.'));
    const saved = original.data.input;
    if (saved.content.version === 2 && saved.content.requestIdentityVersion === 1
      && saved.content.desktopRequestHash !== createHash('sha256').update(serializeDesktopInvoiceFormRequest(input.data)).digest('hex'))
      return fail(appError('state_conflict', 'input', 'This input sequence belongs to another Fill request.'));
    if (saved.sessionId !== input.data.workspace.sessionId || saved.clientSequence !== input.data.clientSequence || saved.mode !== 'prompt'
      || saved.goalMode !== 'fill-form' || saved.content.version !== 2 || saved.content.workspaceContext === null
      || !sameFormWorkspace(input.data.workspace, saved.content.workspaceContext))
      return fail(appError('state_conflict', 'input', 'This input sequence belongs to another form request.'));
    const run = await productHostRequest<RunSnapshot>({ type: 'query_run', runId: saved.runId! }, 'Original Fill Run is unavailable.');
    if (!run.ok) return fail(appError('operation_result_unknown', 'runtime', 'Original Fill Run cannot be verified. Query its original input.'));
    const target = InvoiceFormTargetSchema.safeParse(run.data.config.formTarget);
    const runWorkspace = WorkspaceContextSchema.safeParse(run.data.config.workspaceContext);
    if (run.data.kind !== 'agent' || run.data.sessionId !== saved.sessionId || run.data.config.goalMode !== 'fill-form'
      || !target.success || target.data.formInstanceId !== input.data.target.formInstanceId || target.data.expectedRevision !== input.data.target.expectedRevision
      || !runWorkspace.success || !sameFormWorkspace(input.data.workspace, runWorkspace.data)
      || binding.runId !== null && binding.runId !== saved.runId)
      return fail(appError('state_conflict', 'input', 'This input sequence belongs to another form target.'));
    binding.runId = saved.runId; binding.pendingFill = false;
    return ok({ runId: saved.runId, sessionId: saved.sessionId, inputId: saved.inputId, requestId: binding.requestId! });
  }
  const current = await readDesktopState();
  if (invoiceFormBinding !== binding || !ownedInvoiceForm(event, input.data.target.formInstanceId) || !binding.valid
    || binding.epoch !== host.connectionEpoch || binding.purpose !== 'fill' || binding.dirty
    || binding.target.expectedRevision !== input.data.target.expectedRevision || !sameFormWorkspace(binding.workspace, input.data.workspace))
    return fail(appError('state_conflict', 'input', 'The form target changed while preparing Fill. Check the current form.'));
  if (binding.clientSequence !== undefined) return startInvoiceFormRun(event, raw);
  if (!current.ok) return current;
  const profile = current.data.settings.models.find(model => model.id === input.data.modelId);
  if (!current.data.ready || !profile || current.data.modelCredentials[profile.id] !== 'configured') return fail(appError('model_credential_missing', 'input', 'Configure a model before Fill with Agent.'));
  binding.requestId = randomUUID(); binding.clientSequence = input.data.clientSequence; binding.modelId = input.data.modelId; binding.pendingFill = true;
  try {
    const accepted = await host.request({ type: 'submit_invoice_form_input', requestId: binding.requestId, input: input.data,
      expectedSettingsRevision: current.data.settings.revision, expectedCredentialRef: profile.credentialRef }, 15_000) as Result<RunAccepted & { requestId: string }>;
    if (!accepted.ok) { binding.pendingFill = accepted.error.code === 'operation_result_unknown'; return accepted; }
    if (accepted.data.requestId !== binding.requestId || accepted.data.sessionId !== input.data.workspace.sessionId
      || !validId(accepted.data.runId) || !validId(accepted.data.inputId)
      || binding.runId !== null && binding.runId !== accepted.data.runId) return fail(appError('operation_result_unknown', 'runtime', 'Fill Run association is unknown. Query its original input.'));
    binding.runId = accepted.data.runId; binding.pendingFill = false;
    return accepted;
  } catch { return fail(appError('operation_result_unknown', 'runtime', 'Fill admission is unknown. Query its original input; do not send it again.')); }
}

function unknownInvoiceForm(request: InvoiceFormBridgeRequest): InvoiceFormApplicationReceipt {
  return { runId: request.runId, toolCallId: request.toolCallId, formInstanceId: request.target.formInstanceId,
    candidateId: request.candidateId, candidateSequence: request.candidateSequence, observedAt: new Date().toISOString(), outcome: 'unknown' };
}

async function handleInvoiceFormRequest(request: InvoiceFormBridgeRequest, epoch: number): Promise<InvoiceFormApplicationReceipt> {
  const binding = invoiceFormBinding;
  const window = mainWindow;
  if (!binding || !window || window.webContents.isDestroyed() || epoch !== host.connectionEpoch
    || !matchesInvoiceFormTarget(binding, request, { frame: window.webContents.mainFrame, contents: window.webContents, epoch })) return unknownInvoiceForm(request);
  const run = await productHostRequest<RunSnapshot>({ type: 'query_run', runId: request.runId }, 'Fill Run could not be confirmed.', 1500);
  if (!run.ok || !matchesInvoiceFormRun(binding, request, run.data) || invoiceFormBinding !== binding || !binding.valid
    || host.connectionEpoch !== epoch || window.webContents.mainFrame !== binding.frame) return unknownInvoiceForm(request);
  binding.runId = request.runId;
  return new Promise(resolve => {
    const requestId = randomUUID();
    const timer = setTimeout(() => finish(unknownInvoiceForm(request)), 3000);
    const finish = (receipt: InvoiceFormApplicationReceipt) => {
      clearTimeout(timer); pendingInvoiceForms.delete(requestId); resolve(receipt);
    };
    pendingInvoiceForms.set(requestId, { request, owner: binding, resolve: finish });
    window.webContents.send('flowmate:invoice-form-request', { requestId, request });
  });
}

async function replyInvoiceFormRequest(event: Electron.IpcMainInvokeEvent, id: unknown, raw: unknown) {
  const pending = typeof id === 'string' ? pendingInvoiceForms.get(id) : undefined;
  const receipt = InvoiceFormApplicationReceiptSchema.safeParse(raw);
  if (!pending || !receipt.success || pending.owner.frame !== event.senderFrame || pending.owner.contents !== event.sender
    || pending.owner.epoch !== host.connectionEpoch || receipt.data.runId !== pending.request.runId
    || receipt.data.toolCallId !== pending.request.toolCallId || receipt.data.formInstanceId !== pending.request.target.formInstanceId
    || receipt.data.candidateId !== pending.request.candidateId || receipt.data.candidateSequence !== pending.request.candidateSequence
    || receipt.data.outcome === 'applied' && receipt.data.appliedRevision !== pending.request.target.expectedRevision + 1) {
    return fail(appError('state_conflict', 'input', 'Form receipt does not match its original request.'));
  }
  pending.resolve(receipt.data);
  return ok(undefined);
}

async function inspectCurrentInvoiceForm(binding: DesktopFormBinding): Promise<DesktopInvoiceFormInspection | null> {
  if (!mainWindow || binding !== invoiceFormBinding || !binding.valid || binding.epoch !== host.connectionEpoch
    || binding.frame !== mainWindow.webContents.mainFrame || binding.contents !== mainWindow.webContents) return null;
  return new Promise(resolve => {
    const requestId = randomUUID();
    const timer = setTimeout(() => finish(null), 2500);
    const finish = (value: DesktopInvoiceFormInspection | null) => { clearTimeout(timer); pendingFormInspections.delete(requestId); resolve(value); };
    pendingFormInspections.set(requestId, { owner: binding, resolve: finish });
    mainWindow!.webContents.send('flowmate:invoice-form-inspect', { requestId, formInstanceId: binding.target.formInstanceId });
  });
}

async function submitInvoiceCandidateOperation(raw: unknown, owner: InvoiceFormOwner,
  inspected?: DesktopInvoiceFormInspection): Promise<Result<InvoiceCandidateOperationResult>> {
  const query = InvoiceCandidateOperationQuerySchema.safeParse(raw);
  if (!query.success) return fail(appError('input_invalid', 'input', 'Candidate operation is invalid.'));
  const input = query.data;
  // Resolve the exact original command before consulting a now-stale target or Workspace.
  const prior = await productHostRequest<InvoiceCandidateOperationResult>({ type: 'query_invoice_candidate_operation', input }, 'Original candidate operation could not be queried.');
  if (!prior.ok || prior.data !== null) return prior;
  if (input.kind === 'export') return productHostRequest({ type: 'export_invoice_candidate', input: input.request }, 'Export result is unknown. Query the original operation.', 10_000, 'operation_result_unknown');
  const binding = invoiceFormBinding;
  if (!binding || !binding.valid || binding.frame !== owner.frame || binding.contents !== owner.contents || binding.epoch !== owner.epoch)
    return fail(appError('state_conflict', 'input', 'Choose a current editable form before this operation.'));
  if (binding.unknownOperationRef) return fail(appError('operation_result_unknown', 'input', 'Check the original operation before creating another operation.'));
  if (binding.mutationPending) return fail(appError('state_conflict', 'input', 'The current form already has an operation in progress.'));
  binding.mutationPending = true;
  try {
  const form = inspected ?? await inspectCurrentInvoiceForm(binding);
  if (!form) return fail(appError('operation_result_unknown', 'input', 'Current form could not be inspected. Your local draft is retained.'));
  const current = await productHostRequest<WorkspaceSnapshot>({ type: 'read_workspace' }, 'Workspace is unavailable.');
  if (!current.ok) return current;
  if (binding !== invoiceFormBinding || !checkedInvoiceFormInspection(binding, form, owner)
    || input.request.jobId !== form.basis.jobId || input.request.expectedCandidateId !== form.basis.candidateId
    || current.data.invalidReferences.length || !sameFormWorkspaceBasis(binding.workspace, current.data)
    || input.request.expectedRevision !== current.data.revision)
    return fail(appError('state_conflict', 'input', 'Current form or selected result changed.'));
  if (input.kind === 'save') {
    if (input.request.basedOnCandidateId !== form.basis.candidateId || JSON.stringify(input.request.draft) !== JSON.stringify(form.draft))
      return fail(appError('state_conflict', 'input', 'Save draft does not match the current form.'));
    const result = await productHostRequest<InvoiceCandidateOperationResult>({ type: 'save_invoice_candidate', input: input.request }, 'Save result is unknown. Query the original operation.', 10_000, 'operation_result_unknown');
    if (!result.ok && result.error.code === 'operation_result_unknown') binding.unknownOperationRef = input.request.operationRef;
    return result;
  }
  if (form.dirty || input.request.candidateId !== form.basis.candidateId)
    return fail(appError('state_conflict', 'input', 'Save or discard the actual local changes before making a decision.'));
  const result = await (input.kind === 'accept'
    ? productHostRequest<InvoiceCandidateOperationResult>({ type: 'accept_invoice_candidate', input: input.request }, 'Accept result is unknown. Query the original operation.', 10_000, 'operation_result_unknown')
    : productHostRequest<InvoiceCandidateOperationResult>({ type: 'reject_invoice_candidate', input: input.request }, 'Reject result is unknown. Query the original operation.', 10_000, 'operation_result_unknown'));
  if (!result.ok && result.error.code === 'operation_result_unknown') binding.unknownOperationRef = input.request.operationRef;
  return result;
  } finally { binding.mutationPending = false; }
}

async function confirmInvoiceFormClose(): Promise<boolean> {
  if (!invoiceFormBinding?.dirty || !mainWindow) return true;
  const choice = await dialog.showMessageBox(mainWindow, { type: 'warning', title: 'Unsaved invoice changes',
    message: 'Save, keep editing or discard the local invoice changes before closing.', buttons: ['Continue editing', 'Discard changes', 'Save result'], defaultId: 0, cancelId: 0 });
  const binding = invoiceFormBinding;
  if (!binding) return false;
  if (choice.response === 1) { binding.valid = false; binding.dirty = false; return true; }
  if (choice.response !== 2) return false;
  if (binding.unknownOperationRef) {
    await dialog.showMessageBox(mainWindow, { type: 'warning', message: 'Check the original Save status in the invoice form before saving again.', buttons: ['Continue editing'] });
    return false;
  }
  let unknownOperation: InvoiceCandidateOperationQuery | undefined;
  try {
    const form = await inspectCurrentInvoiceForm(binding);
    if (!form) return false;
    const current = await productHostRequest<WorkspaceSnapshot>({ type: 'read_workspace' }, 'Workspace is unavailable.');
    if (!current.ok) return false;
    const operation: InvoiceCandidateOperationQuery = { kind: 'save', request: { operationRef: randomUUID(), jobId: form.basis.jobId,
      basedOnCandidateId: form.basis.candidateId, expectedCandidateId: form.basis.candidateId,
      expectedRevision: current.data.revision, draft: form.draft } };
    const result = await submitInvoiceCandidateOperation(operation, binding, form);
    if (!result.ok) {
      if (result.error.code === 'operation_result_unknown') unknownOperation = operation;
      await dialog.showMessageBox(mainWindow, { type: 'error', message: result.error.message, buttons: ['Continue editing'] });
      return false;
    }
    binding.dirty = false; return true;
  } finally { if (mainWindow && !mainWindow.webContents.isDestroyed()) mainWindow.webContents.send('flowmate:invoice-form-inspect-finished', { unknownOperation }); }
}

function isTrustedSender(event: Electron.IpcMainInvokeEvent): boolean {
  if (!mainWindow || event.sender !== mainWindow.webContents || mainWindow.webContents.isDestroyed()) return false;
  if (event.senderFrame !== mainWindow.webContents.mainFrame) return false;
  const frameUrl = event.senderFrame?.url;
  return typeof frameUrl === 'string' && isAllowedPage(frameUrl);
}

function isAllowedPage(value: string): boolean {
  const rendererUrl = process.env.ELECTRON_RENDERER_URL;
  if (rendererUrl) {
    try { return new URL(value).origin === new URL(rendererUrl).origin; } catch { return false; }
  }
  return value.startsWith('file://') && value.endsWith('/out/renderer/index.html');
}

function isAbsolutePath(value: string): boolean {
  return /^[a-zA-Z]:[\\/]/.test(value) || value.startsWith('\\\\') || value.startsWith('/');
}
