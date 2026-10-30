import { isInputDefinitionHostCommand, parseInputDefinitionHostResult, matchesInputDefinitionResponse, inputDefinitionHostFailure } from '../../host/protocol.ts';
import { isResearchHostCommand, parseResearchHostResult, matchesResearchResponse, researchHostFailure, researchOperations } from '../../../packages/contracts/src/research-commands.ts';
import { isPersonalAgentHostCommand, parsePersonalAgentHostResult, matchesPersonalAgentResponse, personalAgentHostFailure, personalAgentHostCommandTypes } from '../../../packages/contracts/src/personal-agent-commands.ts';
import { ResourceRefSchema } from '@flowmate/contracts';
import { app, BrowserWindow, dialog, ipcMain, shell } from 'electron';
import { randomUUID } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { mkdir, lstat, open, readFile, rename, rm } from 'node:fs/promises';
import { existsSync, mkdirSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { resolveRuntimeLayout, type RuntimeLayout } from '../../../packages/shared/src/runtime-layout.ts';
import { createRuntimeLogBuffer } from '../../../packages/logging/src/runtime-log.ts';
import { DiagnosticsSnapshotSchema, HostDiagnosticsResultSchema, type DiagnosticsSnapshot } from '@flowmate/contracts';
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
  ExportInvoiceCandidateRequestSchema,
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
  DesktopInvoiceExportResult,
  InvoiceExportReference,
  RuntimeEventsReadResult,
  RuntimeSubscriptionInfo,
  RuntimeEventsWake,
} from '@flowmate/contracts';
import { defaultProductSettings, validateProductSettings } from '../../../packages/core/src/configuration/settings.ts';
import { createCredentialStore } from '../../../packages/shared/src/secure-credential-store.ts';
import type { CredentialStore } from '../../../packages/shared/src/secure-credential-store.ts';
import { systemSecureStorage } from './secure-storage.ts';
import { HostClient } from './host-client.ts';
import { ServiceClient, type ServiceCommandInput } from './service-client.ts';
import { createServiceActivation } from './service-activation.ts';
import { readDesktopServiceSelection, type ServiceInstallation } from '../../../packages/shared/src/service-layout.ts';
import { BackgroundServiceConnectRequestSchema, BackgroundServiceDisconnectRequestSchema, BackgroundServicePrepareRequestSchema,
  BackgroundServiceEnableRequestSchema, BackgroundServiceActivationQuerySchema, type BackgroundServiceState } from '@flowmate/contracts';
import { SERVICE_PROTOCOL_VERSION, SERVICE_DATA_VERSION } from '../../service/protocol.ts';
import { validateBusinessSettings, saveEvaluationSettings, evaluationCredentialStatus, evaluationConfigurationSnapshot, prepareEvaluationCredentials, prepareExperimentCredentials } from './evaluation-settings.ts';
import { EvaluationClient } from './evaluation-client.ts';
import { EvaluationWorkflowRequestSchema, isWorkflowReadOnly, EVALUATION_WORKSPACE_UNAVAILABLE_REASON } from '../../../packages/contracts/src/evaluation-workflow.ts';
import { evaluationResponses, parseEvaluationCommand, parseEvaluationResponse, type EvaluationResponseType } from '@flowmate/contracts';
import { registerSecrets, scanEvidence } from '../../../agent-eval/src/execution/evidence-safety.ts';
import type { HostCredentialRequest } from '../../host/protocol.ts';
import { DesktopSessionInputRequestSchema, InvoiceFormRunInputSchema } from '../../host/protocol.ts';
import { contextHostFailure, matchesContextResponse, parseContextHostResult } from '../../host/protocol.ts';
import { historyHostFailure, matchesHistoryResponse, parseHistoryHostResult, parseHostCommand, isHistoryHostCommand } from '../../host/protocol.ts';
import type { HostCommand } from '../../host/protocol.ts';
import { DesktopSessionCompactionRequestSchema } from '@flowmate/contracts';
import { isExtensionHostCommand, parseExtensionHostResult, matchesExtensionResponse, extensionHostFailure, isResourceHostCommand, parseResourceHostResult, matchesResourceResponse, resourceHostFailure } from '../../host/protocol.ts';
import { isSubagentHostCommand, parseSubagentHostResult, matchesSubagentResponse, subagentHostFailure } from '../../host/protocol.ts';
import { isCompactionHostCommand, parseCompactionHostResult, matchesCompactionResponse, compactionHostFailure, parseCompactionNotification } from '../../host/protocol.ts';
import { checkedInvoiceFormInspection, matchesInvoiceFormRun, matchesInvoiceFormTarget, type InvoiceFormOwner, type InvoiceFormTargetBinding } from './invoice-form-bridge.ts';
import { resolveProductPaths } from '../../../packages/shared/src/paths.ts';
import { readManagedInvoiceExport } from '../../../packages/core/src/storage/file-store.ts';
import { publishInvoiceExportCopy } from './invoice-export.ts';
import { publishExportCopy } from './invoice-export.ts';
import { ResearchReportRequestSchema, ResearchExportResultSchema } from '@flowmate/contracts';

const channels = {
  evaluationWorkflow: 'flowmate:evaluation-workflow',
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
  saveInvoiceExport: 'flowmate:save-invoice-export',
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
let interactiveCloseRequested = false;
let devShutdownRequestId: string | null = null;
let hostError = false;
let hostErrorCode = 'host_not_ready';
let ipcRegistered = false;
let userDataRoot = '';
let appVersion = '0.1.0';
let runtimeLayout: RuntimeLayout | null = null;
let invoiceSourceRoot = '';
let hostLaunch: { executable: string; args: readonly string[] } | undefined;
let stateBroadcastSequence = 0;
const legacyHost = new HostClient(), serviceClient = new ServiceClient();
let host: HostClient | ServiceClient = legacyHost;
let transportEpoch = 0, transportGeneration = 0;
let clientSubscription: (() => void) | null = null;
let serviceMode = false, legacyAllowed = true;
let serviceInstallation: ServiceInstallation | null = null;
let backgroundService: BackgroundServiceState = { state: 'disabled', installationId: null, protocolVersion: null, dataVersion: null, error: null };
let lastServiceSettings = defaultProductSettings();
let serviceConnectionId: string | null = null, pendingServiceDisconnectId: string | null = null;
let serviceSettingsSaving = false;
let configurationWriting = false;
const serviceSettingsRequestSchema = z.object({ version: z.literal(1), installationId: z.string().uuid(), operationId: z.string().uuid() }).strict();
type ServiceSettingsRequest = z.infer<typeof serviceSettingsRequestSchema>;
const mainLog = createRuntimeLogBuffer();
mainLog.write({ at: new Date().toISOString(), level: 'info', component: 'main', event: 'desktop_started' });
let evaluation: EvaluationClient | null = null;
let evaluationWorkspaceRoot: string | undefined;
const handleEvaluationTrace: Parameters<HostClient['setEvaluationTraceHandler']>[0] = value => {
  if (evaluationWorkspaceRoot && resolve(value.workspaceRoot) === resolve(evaluationWorkspaceRoot)) evaluation?.enqueueTrace(value.traceId);
};
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
const serviceActivation = createServiceActivation({ client: serviceClient, dataRoot: () => userDataRoot, runtimeLayout: () => runtimeLayout,
  installation: () => { const selected = serviceSelection(); return selected.ok ? ok(selected.data.installation) : selected; },
  readSettings: async () => {
    if (host === legacyHost && legacyAllowed) return readSavedSettings();
    // Resume reads the original validated product configuration without migration writes or evaluation credentials.
    try { return validateProductSettings(JSON.parse(await readFile(join(userDataRoot, 'data/settings.json'), 'utf8'))); }
    catch (cause) { return cause && typeof cause === 'object' && 'code' in cause && cause.code === 'ENOENT'
      && serviceInstallation?.activationSettingsRevision === 0 ? ok(defaultProductSettings())
      : fail(appError('config_settings_read_failed', 'storage', 'The original product configuration is unreadable. No credential migration was submitted.')); }
  },
  readCredential: reference => credentialStore(reference).read(), confirmForm: confirmInvoiceFormClose,
  closing: () => desktopClosing, canBegin: () => !pendingServiceDisconnectId && !configurationWriting && !serviceSettingsSaving && (!evaluation || evaluation.canRestartHost),
  pending: installation => {
    serviceInstallation = installation; legacyAllowed = false; serviceMode = true; hostError = true; hostErrorCode = 'service_activation_pending';
    projectService('blocked', appError('service_activation_pending', 'runtime', 'Continue the original service activation operation.'));
    revokeDesktopConnection(); void broadcastState();
  },
  closeLegacy: async () => {
    // A reopened Main has no original handle. The offline backup lease excludes an owner still holding this root.
    if (host === legacyHost) {
      const closed = await legacyHost.close();
      if (!closed.ok) return closed;
      if (!closed.data.closed || !closed.data.stopped || legacyHost.hasLiveProcess) return fail(appError('host_close_unconfirmed', 'runtime',
        'The original Host has not confirmed stopping and process exit. Continue its original handoff.', true));
      installProductClient(serviceClient);
    }
    return ok(undefined);
  },
  active: async installation => {
    serviceInstallation = installation;
    if (host !== serviceClient) installProductClient(serviceClient);
    serviceConnectionId = serviceClient.serverConnectionId;
    if (!serviceClient.isConnected || !serviceConnectionId) return fail(appError('service_disconnected', 'runtime', 'The activated service connection was lost.', true));
    const recovered = await recoverServiceSettingsRequest(); if (!recovered.ok) return recovered;
    projectService('ready'); hostError = false; hostErrorCode = 'host_not_ready'; await broadcastState(); return ok(undefined);
  },
});
const piCredentialPrefix = 'pi-credential-v1:';
type DesktopFormBinding = InvoiceFormTargetBinding & { currentRevision: number; mutationPending?: boolean; unknownOperationRef?: string; clientSequence?: number; requestId?: string; modelId?: string };
let invoiceFormBinding: DesktopFormBinding | null = null;
const pendingInvoiceForms = new Map<string, { request: InvoiceFormBridgeRequest; owner: DesktopFormBinding;
  resolve(receipt: InvoiceFormApplicationReceipt): void }>();
const pendingFormInspections = new Map<string, { owner: DesktopFormBinding; resolve(value: DesktopInvoiceFormInspection | null): void }>();

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

function transportAvailable(): boolean { return host === legacyHost ? legacyHost.hasLiveProcess : serviceClient.isConnected; }
async function requestProduct(command: Parameters<HostClient['request']>[0], timeoutMs?: number): Promise<unknown> {
  const original = host, epoch = transportEpoch, generation = transportGeneration;
  let result: unknown;
  if (original instanceof HostClient) result = await original.request(command, timeoutMs);
  else {
    if (command.type === 'close' || command.type === 'credential_response' || command.type === 'invoice_form_response') throw Error('service_command_forbidden');
    result = await original.request(command, timeoutMs);
  }
  if (host !== original || transportEpoch !== epoch || transportGeneration !== generation) throw Error('host_connection_changed');
  return result;
}
function revokeDesktopConnection(): void {
  transportEpoch++;
  releaseAllRuntimeOwners();
  if (invoiceFormBinding) invoiceFormBinding.valid = false;
  for (const pending of pendingInvoiceForms.values()) pending.resolve(unknownInvoiceForm(pending.request));
  for (const pending of pendingFormInspections.values()) pending.resolve(null);
}
function projectService(state: BackgroundServiceState['state'], error: BackgroundServiceState['error'] = null): void {
  backgroundService = { state, installationId: serviceInstallation?.installationId ?? null,
    protocolVersion: state === 'ready' ? SERVICE_PROTOCOL_VERSION : null, dataVersion: state === 'ready' ? SERVICE_DATA_VERSION : null,
    activationOperationId: serviceInstallation?.activationOperationId ?? null,
    activationSettingsRevision: serviceInstallation?.activationSettingsRevision ?? null, error };
}
function serviceSelection() {
  return readDesktopServiceSelection({ dataRoot: userDataRoot,
    ...(app.isPackaged && runtimeLayout ? { runtimeRoot: runtimeLayout.runtimeRoot, releaseId: runtimeLayout.release?.releaseId } : {}) });
}
function serviceSettingsRequestFile(): string { return join(userDataRoot, 'data', 'desktop-service-settings-request.json'); }
async function readServiceSettingsRequest(): Promise<Result<ServiceSettingsRequest | null>> {
  try {
    const file = serviceSettingsRequestFile(), stat = await lstat(file);
    if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 4096) throw Error('invalid_request');
    const parsed = serviceSettingsRequestSchema.safeParse(JSON.parse(await readFile(file, 'utf8')));
    if (!parsed.success || parsed.data.installationId !== serviceInstallation?.installationId) throw Error('invalid_request');
    return ok(parsed.data);
  } catch (cause) {
    if (cause && typeof cause === 'object' && 'code' in cause && cause.code === 'ENOENT') return ok(null);
    return fail(appError('service_settings_request_invalid', 'storage', 'The original desktop settings request is unreadable or belongs to another installation. It was retained.'));
  }
}
async function saveServiceSettingsRequest(request: ServiceSettingsRequest): Promise<Result<void>> {
  const file = serviceSettingsRequestFile(), temporary = file + '.' + randomUUID() + '.tmp';
  let handle: Awaited<ReturnType<typeof open>> | undefined;
  try {
    handle = await open(temporary, 'wx', 0o600); await handle.writeFile(JSON.stringify(request) + '\n'); await handle.sync();
    await handle.close(); handle = undefined; await rename(temporary, file); return ok(undefined);
  } catch {
    try { await handle?.close(); } catch { /* Preserve the original failure. */ }
    try { await rm(temporary, { force: true }); } catch { /* Only this unpublished ID-only file is eligible. */ }
    return fail(appError('service_settings_request_write_failed', 'storage', 'The original settings request ID could not be saved. No service write was submitted.', true));
  }
}
async function clearServiceSettingsRequest(request: ServiceSettingsRequest): Promise<Result<void>> {
  const current = await readServiceSettingsRequest(); if (!current.ok) return current;
  if (current.data && current.data.operationId !== request.operationId) return fail(appError('service_settings_request_invalid', 'storage', 'The original settings request changed. It was retained.'));
  try { await rm(serviceSettingsRequestFile(), { force: true }); return ok(undefined); }
  catch { return fail(appError('service_settings_request_clear_failed', 'storage', 'The confirmed settings request ID could not be cleared. Its original result is retained.', true)); }
}
async function recoverServiceSettingsRequest(): Promise<Result<{ operationId: string | null }>> {
  const pending = await readServiceSettingsRequest(); if (!pending.ok) return pending;
  if (!pending.data) return ok({ operationId: null });
  const request = pending.data;
  const original = await serviceClient.queryCredentialOperation({ installationId: request.installationId, operationId: request.operationId });
  if (!original.ok || !original.data || original.data.phase === 'pending' || original.data.phase === 'prepared'
    || original.data.phase === 'failed' && (!original.data.error || original.data.error.code === 'operation_result_unknown')) return fail(appError('service_settings_request_pending', 'runtime',
    `The original service settings request ${request.operationId} is awaiting confirmation. No new save was submitted.`, true));
  if (original.data.phase === 'failed') {
    const cleared = await clearServiceSettingsRequest(request); if (!cleared.ok) return cleared;
    return fail(original.data.error ?? appError('service_settings_failed', 'storage', 'The original service settings save was refused.'));
  }
  if (!original.data.settings || original.data.settings.revision !== original.data.settingsRevision) return fail(appError('service_settings_request_pending', 'runtime',
    `The original committed settings snapshot for request ${request.operationId} could not be confirmed.`, true));
  const cleared = await clearServiceSettingsRequest(request); if (!cleared.ok) return cleared;
  lastServiceSettings = original.data.settings; return ok({ operationId: request.operationId });
}
async function connectBackgroundService(installationId: string): Promise<Result<BackgroundServiceState>> {
  const selection = serviceSelection();
  if (!selection.ok) { projectService('incompatible', selection.error); return selection; }
  if (selection.data.kind !== 'service') return fail(appError(selection.data.kind === 'pending' ? 'service_activation_pending' : 'service_disabled',
    'runtime', 'The background service has not been enabled.'));
  if (selection.data.installation.installationId !== installationId) return fail(appError('service_installation_invalid', 'input', 'The selected service installation changed.'));
  if (host !== serviceClient || !serviceMode) return fail(appError('service_transition_required', 'runtime', 'Restart the desktop after the original owner transition is complete.'));
  const installation = selection.data.installation; serviceInstallation = installation;
  if (serviceClient.isConnected) return ok(backgroundService);
  if (serviceClient.connectionState === 'connecting') return ok(backgroundService);
  projectService('starting'); hostError = true; hostErrorCode = 'service_connecting';
  void broadcastState();
  const result = await serviceClient.connect(installation);
  if (result.ok) {
    serviceConnectionId = serviceClient.serverConnectionId ?? serviceClient.lastServerConnectionId;
    if (!serviceClient.isConnected) {
      pendingServiceDisconnectId ??= serviceConnectionId;
      const error = appError('service_disconnected', 'runtime', 'The original service connection was lost while opening.', true);
      projectService('offline', error); hostError = true; hostErrorCode = error.code; return ok(backgroundService);
    }
    if (pendingServiceDisconnectId) {
      const original = await serviceClient.queryDisconnect(pendingServiceDisconnectId);
      if (!original.ok || !original.data.stopped) {
        const error = original.ok ? appError('service_foreground_stop_unconfirmed', 'runtime', 'The original connection still has unconfirmed foreground work.', true) : original.error;
        projectService('stopping', error); hostError = true; hostErrorCode = error.code; return ok(backgroundService);
      }
      pendingServiceDisconnectId = null;
    }
    const recovered = await recoverServiceSettingsRequest();
    if (!recovered.ok) { projectService('blocked', recovered.error); hostError = true; hostErrorCode = recovered.error.code; return ok(backgroundService); }
    projectService(desktopClosing ? 'stopping' : 'ready'); hostError = desktopClosing; hostErrorCode = desktopClosing ? 'runtime_closing' : 'host_not_ready';
  }
  else { projectService(result.error.code === 'host_protocol_invalid' ? 'incompatible' : 'offline', result.error); hostError = true; hostErrorCode = result.error.code; }
  return ok(backgroundService);
}
async function disconnectBackgroundService(): Promise<Result<BackgroundServiceState>> {
  if (!serviceMode || host !== serviceClient) return fail(appError('service_disabled', 'runtime', 'The desktop uses its local Host.'));
  if (!serviceClient.isConnected) {
    if (pendingServiceDisconnectId) return fail(appError('service_foreground_stop_unconfirmed', 'runtime', 'Reconnect to check the original foreground stop before closing.', true));
    serviceClient.disconnect(); return ok(backgroundService);
  }
  if (pendingServiceDisconnectId && pendingServiceDisconnectId !== serviceConnectionId) {
    const original = await serviceClient.queryDisconnect(pendingServiceDisconnectId);
    if (!original.ok || !original.data.stopped) {
      const error = original.ok ? appError('service_foreground_stop_unconfirmed', 'runtime', 'The original connection still has unconfirmed foreground work.', true) : original.error;
      projectService('stopping', error); return fail(error);
    }
    pendingServiceDisconnectId = null;
  }
  pendingServiceDisconnectId = serviceConnectionId;
  projectService('stopping');
  void broadcastState();
  const report = await serviceClient.prepareDisconnect().catch(() => fail(appError('service_foreground_stop_unconfirmed', 'runtime', 'The original foreground stop response is unknown.', true)));
  if (!report.ok || !report.data.stopped) {
    const error = report.ok ? appError('service_foreground_stop_unconfirmed', 'runtime', 'The original foreground execution has not confirmed stopping.', true) : report.error;
    projectService('stopping', error); hostError = true; hostErrorCode = error.code;
    return fail(error);
  }
  pendingServiceDisconnectId = null; serviceConnectionId = null; revokeDesktopConnection();
  projectService('offline'); serviceClient.disconnect(); hostError = true; hostErrorCode = 'service_disconnected';
  return ok(backgroundService);
}

async function bootstrap(): Promise<void> {
  const appRoot = app.isPackaged ? app.getAppPath() : resolveWorkspaceRoot(app.getAppPath());
  const testRoot = !app.isPackaged && process.env.FLOWMATE_TEST_MODE === '1'
    ? process.env.FLOWMATE_TEST_USER_DATA_ROOT
    : undefined;
  userDataRoot = app.getPath('userData');
  await app.whenReady();
  appVersion = readProductVersion(appRoot);
  const layout = resolveRuntimeLayout({ isPackaged: app.isPackaged, appPath: app.getAppPath(),
    resourcesPath: process.resourcesPath, userDataRoot });
  if (!layout.ok) {
    mainLog.write({ at: new Date().toISOString(), level: 'error', component: 'main', event: 'installation_unavailable', code: layout.error.code });
    hostError = true; hostErrorCode = layout.error.code; registerIpc(); createMainWindow(); return;
  }
  runtimeLayout = layout.data;
  appVersion = runtimeLayout.release?.productVersion ?? appVersion;
  const selection = serviceSelection();
  legacyAllowed = selection.ok && selection.data.kind === 'legacy'; serviceMode = !legacyAllowed;
  serviceInstallation = selection.ok ? selection.data.installation : null;
  host = serviceMode ? serviceClient : legacyHost; transportGeneration++; revokeDesktopConnection();
  if (!selection.ok) projectService('incompatible', selection.error);
  else if (selection.data.kind === 'pending') projectService('blocked', appError('service_activation_pending', 'runtime', 'The original credential activation has not completed.'));
  else if (selection.data.kind === 'service') projectService('offline');
  else projectService('disabled');
  // The existing local test kernel owns this fixed synthetic data root; production keeps the workspace root.
  evaluation = new EvaluationClient(appRoot, app.isPackaged ? runtimeLayout.evaluationRoot
    : testRoot && isAbsolutePath(testRoot) ? join(userDataRoot, 'evaluation-fixture') : appRoot,
    runtimeLayout.mode === 'installed' && runtimeLayout.release ? { executable: runtimeLayout.bunExecutable,
      entry: runtimeLayout.workerLauncher, cwd: runtimeLayout.runtimeRoot,
      runtime: { mode: 'installed', layout: runtimeLayout, release: runtimeLayout.release } } : undefined);
  evaluationWorkspaceRoot = app.isPackaged ? undefined
    : testRoot && isAbsolutePath(testRoot) ? join(userDataRoot, 'evaluation-fixture') : appRoot;
  if (evaluationWorkspaceRoot) mkdirSync(evaluationWorkspaceRoot, { recursive: true });
  legacyHost.setEvaluationTraceHandler(handleEvaluationTrace);
  evaluation.subscribe(value => {
    for (const [webContentsId] of subscriptions) {
      const contents = BrowserWindow.getAllWindows().find(window => window.webContents.id === webContentsId)?.webContents;
      if (contents && !contents.isDestroyed()) contents.send('flowmate:event', { type: 'evaluation_event', value } satisfies DesktopEvent);
    }
  });
  const testInvoiceSourceRoot = !app.isPackaged && process.env.FLOWMATE_TEST_MODE === '1'
    ? process.env.FLOWMATE_TEST_INVOICE_SOURCE_ROOT : undefined;
  invoiceSourceRoot = testInvoiceSourceRoot && isAbsolutePath(testInvoiceSourceRoot)
    ? testInvoiceSourceRoot : runtimeLayout.invoiceSourceRoot;
  if (app.isPackaged && legacyAllowed) mkdirSync(invoiceSourceRoot, { recursive: true });
  hostLaunch = { executable: runtimeLayout.bunExecutable, args: ['--no-env-file', app.isPackaged ? runtimeLayout.hostLauncher : 'apps/host/main.ts',
    '--user-data-root', userDataRoot, '--invoice-source-root', invoiceSourceRoot] };
  let retiredCredentialRef: string | null = null;
  try { if (legacyAllowed) {
    const old = JSON.parse(readFileSync(join(userDataRoot, 'data', 'settings.json'), 'utf8')) as { version?: unknown; models?: unknown[] };
    if (old.version === 1 && Array.isArray(old.models)) {
      const retired = old.models.find((model) => model && typeof model === 'object'
        && (model as Record<string, unknown>).model === 'deepseek-flash'
        && (model as Record<string, unknown>).api === 'openai-responses') as { credentialRef?: unknown } | undefined;
      if (typeof retired?.credentialRef === 'string' && /^[a-zA-Z0-9_-]{16,80}$/.test(retired.credentialRef))
        retiredCredentialRef = retired.credentialRef;
    }
  } } catch { /* No legacy settings to clean up. */ }
  installProductClient(host);
  const started = legacyAllowed ? await legacyHost.start(userDataRoot, appVersion, runtimeLayout.runtimeRoot, invoiceSourceRoot, hostLaunch, evaluationWorkspaceRoot)
    : selection.ok && selection.data.kind === 'service' ? await connectBackgroundService(selection.data.installation.installationId).then(result => result.ok
      ? serviceClient.state ? ok(serviceClient.state) : fail(result.data.error ?? appError('service_offline', 'runtime', 'The background service is offline.')) : result)
      : fail(backgroundService.error ?? appError('service_unavailable', 'runtime', 'The background service is unavailable.'));
  if (started.ok && started.data.ready && retiredCredentialRef) {
    const removed = await credentialStore(retiredCredentialRef).remove();
    if (!removed.ok) process.stderr.write('[Flowmate] A retired encrypted credential could not be deleted.\n');
  }
  if (!started.ok || !started.data.ready) {
    hostError = true;
    hostErrorCode = started.ok ? 'host_start_failed' : started.error.code;
  }
  mainLog.write({ at: new Date().toISOString(), level: hostError ? 'error' : 'info', component: 'main',
    event: hostError ? 'host_start_failed' : 'host_ready', ...(hostError ? { code: hostErrorCode } : {}) });
  registerIpc();
  createMainWindow();
  await sendDevelopmentNotice({ version: 1, type: 'flowmate_dev_ready', ready: !hostError });
}

function installProductClient(client: HostClient | ServiceClient): void {
  clientSubscription?.(); clientSubscription = null;
  transportGeneration++; revokeDesktopConnection(); host = client;
  const originalClient = client, clientGeneration = transportGeneration;
  clientSubscription = client.subscribe((event) => {
    if (host !== originalClient || transportGeneration !== clientGeneration) return;
    if (event.type === 'runtime_events_available') { receiveRuntimeWake(event); return; }
    if (event.type === 'host_state' && event.state.host === 'error') {
      mainLog.write({ at: new Date().toISOString(), level: 'error', component: 'main', event: 'host_unavailable', code: 'host_exited' });
      hostError = true;
      hostErrorCode = 'host_exited';
    }
    if (event.type === 'host_state' && event.state.host === 'ready') {
      hostError = serviceMode && backgroundService.state !== 'ready';
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
  legacyHost.setCredentialHandler(request => host === legacyHost && legacyAllowed ? handleHostCredentialRequest(request) : Promise.resolve({ ok: false }));
  client.setInvoiceFormHandler((request) => host === originalClient && transportGeneration === clientGeneration
    ? handleInvoiceFormRequest(request, transportEpoch) : Promise.resolve(unknownInvoiceForm(request)));
  client.setConnectionChangeHandler(() => {
    if (host !== originalClient || transportGeneration !== clientGeneration) return;
    revokeDesktopConnection();
    if (originalClient === serviceClient) {
      pendingServiceDisconnectId ??= serviceConnectionId;
      serviceConnectionId = serviceClient.serverConnectionId;
    }
    if (serviceMode && (backgroundService.state === 'ready' || backgroundService.state === 'stopping')) {
      const error = appError('service_disconnected', 'runtime', 'The original background service connection was lost.', true);
      projectService('offline', error); hostError = true; hostErrorCode = error.code; void broadcastState();
    }
  });
}

async function restartHost(): Promise<Result<DesktopState>> {
  await startup;
  if (serviceMode) {
    if (serviceInstallation && backgroundService.state !== 'blocked') await connectBackgroundService(serviceInstallation.installationId);
    await broadcastState(); return readDesktopState();
  }
  if (desktopClosing || transportAvailable() || evaluation && !evaluation.canRestartHost)
    return fail(appError('host_still_running', 'runtime', 'The original controller or stopping state must be resolved before Recheck.', true));
  if (!runtimeLayout || !hostLaunch) return fail(appError('installation_runtime_invalid', 'runtime', 'Runtime layout is unavailable.'));
  mainLog.write({ at: new Date().toISOString(), level: 'info', component: 'main', event: 'host_recheck_started' });
  const started = await legacyHost.start(userDataRoot, appVersion, runtimeLayout.runtimeRoot, invoiceSourceRoot, hostLaunch, evaluationWorkspaceRoot);
  hostError = !started.ok || !started.data.ready;
  hostErrorCode = started.ok ? hostError ? 'host_start_failed' : 'host_not_ready' : started.error.code;
  await broadcastState();
  return readDesktopState();
}

async function queryDiagnostics(): Promise<Result<DiagnosticsSnapshot>> {
  const epoch = transportEpoch, gaps: string[] = [];
  let availability: DiagnosticsSnapshot['host']['availability'] = 'source-unavailable';
  let source: import('zod').z.infer<typeof HostDiagnosticsResultSchema> | null = null;
  if (transportAvailable() && host.state?.ready) {
    try {
      const checked = HostDiagnosticsResultSchema.safeParse(await requestProduct({ type: 'query_diagnostics' }, 2000));
      if (checked.success && checked.data.ok && epoch === transportEpoch) { source = checked.data; availability = 'available'; }
    } catch (error) { if (epoch === transportEpoch && error instanceof Error && error.message === 'host_request_timeout') availability = 'timeout'; }
  }
  if (epoch !== transportEpoch) { availability = 'source-unavailable'; source = null; gaps.push('host_connection_changed'); }
  if (availability !== 'available') gaps.push(availability === 'timeout' ? 'host_query_timeout' : 'host_memory_unavailable');
  const clean = (value: { entries: readonly import('@flowmate/contracts').DiagnosticLogEntry[]; dropped: number }) => {
    const entries = value.entries.filter(entry => !(scanEvidence(entry).fact.actual as { leaked: boolean }).leaked);
    if (entries.length !== value.entries.length) gaps.push('diagnostic_entries_omitted');
    return { entries, dropped: value.dropped + value.entries.length - entries.length };
  };
  try {
    const settings = validateProductSettings(epoch === transportEpoch && transportAvailable() && host.state?.ready ? host.state.settings : null);
    let modelId = settings.ok ? settings.data.defaultModelId : null;
    const model = settings.ok ? settings.data.models.find(item => item.id === modelId) : null;
    let credential: DiagnosticsSnapshot['configuration']['credential'] = settings.ok
      ? model ? await modelCredentialStatus(model) : 'missing' : 'unavailable';
    if (!settings.ok) gaps.push('model_configuration_unavailable');
    if (epoch !== transportEpoch || !transportAvailable() || !host.state?.ready) {
      availability = 'source-unavailable'; source = null; modelId = null; credential = 'unavailable';
      gaps.push(epoch !== transportEpoch ? 'host_connection_changed' : 'host_memory_unavailable', 'model_configuration_unavailable');
    }
    const stderr = host === legacyHost ? legacyHost.diagnosticsStderr : { tail: '', truncated: false };
    if (host === serviceClient) gaps.push('service_stderr_unavailable');
    if (stderr.truncated) gaps.push('host_stderr_omitted');
    const hostRecords = source?.ok ? clean(source.data) : { entries: [], dropped: null };
    const snapshot = { version: 1, collectedAt: new Date().toISOString(), productVersion: appVersion, main: clean(mainLog.snapshot()),
      host: { availability, ...hostRecords, stderrTail: stderr.tail, stderrTruncated: stderr.truncated },
      runtime: source?.ok ? source.data.runtime : { bunVersion: null, sdkVersion: runtimeLayout?.release?.sdkVersion ?? 'unknown',
        platform: process.platform, arch: process.arch }, configuration: { modelId, credential }, gaps: [...new Set(gaps)] };
    if ((scanEvidence(snapshot).fact.actual as { leaked: boolean }).leaked) throw Error('Unsafe diagnostics');
    return ok(DiagnosticsSnapshotSchema.parse(snapshot));
  } catch { return fail(appError('diagnostics_unavailable', 'runtime', 'Safe diagnostics could not be collected.', true)); }
}

async function exportDiagnostics(event: Electron.IpcMainInvokeEvent): Promise<Result<{ outcome: 'cancelled' | 'saved' }>> {
  const window = mainWindow, frame = event.senderFrame;
  if (!window || window.isDestroyed()) return fail(appError('diagnostics_export_failed', 'runtime', 'The diagnostics window is unavailable.'));
  const currentOwner = () => mainWindow === window && !window.isDestroyed() && event.senderFrame === frame && isTrustedSender(event);
  const snapshot = await queryDiagnostics(); if (!snapshot.ok) return snapshot;
  const selected = await dialog.showSaveDialog(window, { title: 'Export diagnostics JSON',
    defaultPath: `Flowmate-diagnostics-${snapshot.data.collectedAt.replace(/[:.]/g, '-')}.json`, filters: [{ name: 'JSON', extensions: ['json'] }] });
  if (selected.canceled) return ok({ outcome: 'cancelled' });
  if (!currentOwner() || !selected.filePath)
    return fail(appError('diagnostics_export_failed', 'runtime', 'The diagnostics owner changed.'));
  const current = await queryDiagnostics();
  if (!current.ok) return current;
  if (!currentOwner()) return fail(appError('diagnostics_export_failed', 'runtime', 'The diagnostics owner changed.'));
  const saved = publishExportCopy(selected.filePath, new TextEncoder().encode(JSON.stringify(current.data, null, 2) + '\n'));
  return saved.ok ? ok({ outcome: 'saved' }) : fail(appError('diagnostics_export_failed', 'storage', 'Diagnostics could not be saved. Choose a new writable filename.', true));
}

function closeHostAndQuit(interactive = false): Promise<void> {
  interactiveCloseRequested ||= interactive;
  if (closeInFlight) return closeInFlight;
  closeInFlight = closeDesktop().catch(async () => {
    hostError = true; hostErrorCode = 'desktop_close_failed'; await broadcastState();
  }).then(async () => {
    if (interactiveCloseRequested && !allowQuit && !serviceActivation.busy) await confirmDesktopExit();
  }).finally(() => { closeInFlight = null; interactiveCloseRequested = false; });
  return closeInFlight;
}

async function confirmDesktopExit(): Promise<void> {
  if (!mainWindow || mainWindow.isDestroyed()) return;
  const choice = await dialog.showMessageBox(mainWindow, { type: 'warning', title: 'Unable to finish closing',
    message: 'Background cleanup could not be confirmed.',
    detail: 'Exit now stops this Flowmate window and its child processes. Running tasks may be interrupted; check their saved results after restarting.',
    buttons: ['Keep open', 'Exit now'], defaultId: 0, cancelId: 0 });
  if (choice.response !== 1) return;
  for (const pid of [legacyHost.processId, evaluation?.processId]) {
    if (pid === undefined) continue;
    const result = spawnSync('taskkill.exe', ['/PID', String(pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore', timeout: 5_000 });
    if (result.error || result.status !== 0) {
      dialog.showErrorBox('Flowmate could not exit', 'A background process could not be stopped. Keep this window open and try closing again.');
      return;
    }
  }
  app.exit(1);
}

async function closeDesktop(): Promise<void> {
  if (serviceActivation.busy) { hostError = true; hostErrorCode = 'service_activation_busy'; await broadcastState(); return; }
  desktopClosing = true;
  await startup;
  const [closed, evaluationClosed] = await Promise.all([host === serviceClient ? disconnectBackgroundService().then(result => result.ok
    ? ok({ closed: true, stopped: true, errors: [] }) : result) : legacyHost.close(),
    evaluation?.close() ?? Promise.resolve(ok({ closed: true, stopped: true, errors: [] }))]);
  const allClosed = closed.ok && closed.data.closed && evaluationClosed.ok && evaluationClosed.data.closed;
  const allStopped = closed.ok && closed.data.stopped && evaluationClosed.ok && evaluationClosed.data.stopped;
  await sendDevelopmentNotice({ version: 1, type: 'flowmate_dev_closed', requestId: devShutdownRequestId,
    closed: allClosed, stopped: allStopped });
  // Preserve stop uncertainty without trapping a window whose processes have exited.
  if (allClosed) {
    releaseAllRuntimeOwners();
    allowWindowClose = true;
    allowQuit = true;
    for (const unsubscribe of subscriptions.values()) unsubscribe();
    subscriptions.clear();
    app.quit();
  } else {
    hostError = true;
    hostErrorCode = !closed.ok ? closed.error.code : !closed.data.closed || !closed.data.stopped ? 'host_close_unconfirmed'
      : evaluationClosed.ok ? 'evaluation_stop_unconfirmed' : evaluationClosed.error.code;
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
      preload: join(app.isPackaged ? app.getAppPath() : resolveWorkspaceRoot(app.getAppPath()), 'out', 'preload', 'index.js'),
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
    void confirmInvoiceFormClose().then(confirmed => { if (confirmed) void closeHostAndQuit(true); });
  });
  window.webContents.on('did-start-navigation', (_event, _url, _inPlace, isMainFrame) => {
    if (isMainFrame) {
      if (invoiceFormBinding) invoiceFormBinding.valid = false;
      runtimeGenerations.set(window.webContents.id, (runtimeGenerations.get(window.webContents.id) ?? 0) + 1);
      releaseRuntimeOwner(window.webContents.id);
      subscriptions.delete(window.webContents.id);
    }
  });
  const rendererUrl = !app.isPackaged ? process.env.ELECTRON_RENDERER_URL : undefined;
  if (rendererUrl) void window.loadURL(rendererUrl);
  else void window.loadFile(join(app.isPackaged ? app.getAppPath() : resolveWorkspaceRoot(app.getAppPath()), 'out', 'renderer', 'index.html'));
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
    const checked = parseContextHostResult(command.type, await requestProduct(request));
    return checked !== null && matchesContextResponse(command, checked) ? checked : contextHostFailure();
  } catch { return contextHostFailure(); }
}

async function assemblyIpcQuery(type: string, input?: unknown) {
  const command = parseHostCommand({ version: 1, requestId: randomUUID(), type, ...(input === undefined ? {} : { input }) });
  const extension = isExtensionHostCommand(type);
  const subagent = isSubagentHostCommand(type);
  const definition = isInputDefinitionHostCommand(type);
  const personal = isPersonalAgentHostCommand(type);
  if (!command || !extension && !subagent && !definition && !personal && !isResearchHostCommand(type) && !isResourceHostCommand(type)) return fail(appError('input_invalid', 'input', 'Resource request is invalid.'));
  const [parse, matches, failure] = personal ? [parsePersonalAgentHostResult, matchesPersonalAgentResponse, personalAgentHostFailure]
    : isResearchHostCommand(type) ? [parseResearchHostResult, matchesResearchResponse, researchHostFailure] : definition ? [parseInputDefinitionHostResult, matchesInputDefinitionResponse, inputDefinitionHostFailure] : subagent ? [parseSubagentHostResult, matchesSubagentResponse, subagentHostFailure]
    : extension ? [parseExtensionHostResult, matchesExtensionResponse, extensionHostFailure]
      : [parseResourceHostResult, matchesResourceResponse, resourceHostFailure];
  const epoch = transportEpoch;
  try {
    const { version: _version, requestId: _requestId, ...request } = command;
    const checked = parse(type, await requestProduct(request));
    return epoch === transportEpoch && checked !== null && matches(command, checked) ? checked : failure(type);
  } catch { return failure(type); }
}
async function compactionIpcRequest(command: HostCommand) {
  const epoch = transportEpoch;
  try {
    const { version: _version, ...request } = command;
    const checked = parseCompactionHostResult(command.type, await requestProduct(request));
    return epoch === transportEpoch && checked !== null && matchesCompactionResponse(command, checked)
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
  const configurationWrites = new Set([channels.saveSettings, 'flowmate:save-evaluation-settings',
    'flowmate:update-resource-selection', 'flowmate:update-extension-selection']);
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
      if (desktopClosing && !['flowmate:get-state', 'flowmate:get-service-state', 'flowmate:query-service-activation', 'flowmate:connect-service', 'flowmate:disconnect-service', 'flowmate:query-diagnostics', 'flowmate:export-diagnostics', 'flowmate:query-evaluation-control', 'flowmate:cancel-evaluation', 'flowmate:list-evaluation-executions', 'flowmate:query-evaluation-result', 'flowmate:compare-evaluation', 'flowmate:query-evaluation-catalog', 'flowmate:query-evaluation-feedback'].includes(channel))
        return failure(appError('runtime_busy', 'runtime', '桌面应用正在关闭。'));
      const configurationWrite = configurationWrites.has(channel);
      if (configurationWrite && (configurationWriting || serviceActivation.busy)) return failure(appError('config_settings_write_busy', 'runtime',
        'The original configuration save or service activation is still in progress. No new configuration write was submitted.', true));
      if (configurationWrite) configurationWriting = true;
      try { return await handler(event, ...args); }
      catch { return failure(appError('desktop_operation_failed', 'runtime', '桌面操作失败。', true)); }
      finally { if (configurationWrite) configurationWriting = false; }
    });
  };
  handle('flowmate:restart-host', async (_event, ...args) => args.length ? fail(appError('input_invalid', 'input', 'Recheck takes no arguments.')) : restartHost());
  handle('flowmate:prepare-service', async (_event, raw, ...extra) => {
    if (extra.length || !BackgroundServicePrepareRequestSchema.safeParse(raw).success) return fail(appError('input_invalid', 'input', 'The service preparation request is invalid.'));
    await startup; const prepared = await serviceActivation.prepare();
    if (prepared.ok) { const selected = serviceSelection(); if (selected.ok) serviceInstallation = selected.data.installation; projectService(backgroundService.state, backgroundService.error); }
    await broadcastState(); return prepared;
  });
  handle('flowmate:enable-service', async (_event, raw, ...extra) => {
    const input = BackgroundServiceEnableRequestSchema.safeParse(raw);
    if (extra.length || !input.success) return fail(appError('input_invalid', 'input', 'The service activation request is invalid.'));
    await startup; const result = await serviceActivation.enable(input.data);
    if (result.ok && result.data.error && serviceMode) {
      const selected = serviceSelection(); if (selected.ok) serviceInstallation = selected.data.installation;
      projectService(serviceInstallation?.enabled ? 'offline' : 'blocked', result.data.error); hostError = true; hostErrorCode = result.data.error.code;
    }
    await broadcastState(); return result;
  });
  handle('flowmate:query-service-activation', async (_event, raw, ...extra) => {
    const input = BackgroundServiceActivationQuerySchema.safeParse(raw);
    if (extra.length || !input.success) return fail(appError('input_invalid', 'input', 'The original activation query is invalid.'));
    await startup; return serviceActivation.query(input.data);
  });
  handle('flowmate:get-service-state', async (_event, ...args) => {
    if (args.length) return fail(appError('input_invalid', 'input', 'Service state takes no arguments.'));
    await startup;
    if (serviceClient.isConnected && !serviceSettingsSaving && backgroundService.state === 'blocked' && backgroundService.error?.code.startsWith('service_settings_')) {
      const recovered = await recoverServiceSettingsRequest();
      if (recovered.ok) { projectService(desktopClosing ? 'stopping' : 'ready'); hostError = desktopClosing; }
      else projectService('blocked', recovered.error);
    }
    return ok(backgroundService);
  });
  handle('flowmate:connect-service', async (_event, raw, ...extra) => {
    const input = BackgroundServiceConnectRequestSchema.safeParse(raw);
    if (extra.length || !input.success) return fail(appError('input_invalid', 'input', 'The service connection request is invalid.'));
    await startup; const result = await connectBackgroundService(input.data.installationId); await broadcastState(); return result;
  });
  handle('flowmate:disconnect-service', async (_event, raw, ...extra) => {
    const input = BackgroundServiceDisconnectRequestSchema.safeParse(raw);
    if (extra.length || !input.success) return fail(appError('input_invalid', 'input', 'The service disconnection request is invalid.'));
    await startup;
    if (serviceInstallation?.installationId !== input.data.installationId) return fail(appError('service_installation_invalid', 'input', 'The original service installation changed.'));
    if (!await confirmInvoiceFormClose()) return fail(appError('state_conflict', 'input', 'The original invoice draft is retained.'));
    const result = await disconnectBackgroundService(); await broadcastState(); return result;
  });
  handle('flowmate:query-diagnostics', async (_event, ...args) => args.length ? fail(appError('input_invalid', 'input', 'Diagnostics takes no arguments.')) : queryDiagnostics());
  handle('flowmate:export-diagnostics', async (event, ...args) => args.length ? fail(appError('input_invalid', 'input', 'Diagnostics export takes no arguments.')) : exportDiagnostics(event));

  handle('flowmate:save-research-export', async (event, raw) => {
    const parsed = ResearchReportRequestSchema.safeParse(raw);
    if (!parsed.success) return fail(appError('input_invalid', 'input', 'Report export request is invalid.'));
    const owner = mainWindow, frame = event.senderFrame, epoch = transportEpoch;
    const current = () => owner !== null && owner === mainWindow && !owner.isDestroyed()
      && event.sender === owner.webContents && frame === owner.webContents.mainFrame && epoch === transportEpoch;
    if (!current()) return fail(appError('state_conflict', 'input', 'The research window changed.'));
    const exported = ResearchExportResultSchema.safeParse(await assemblyIpcQuery('export_research_report', parsed.data));
    if (!exported.success) return fail(appError('host_protocol_invalid', 'runtime', 'Report export could not be verified.'));
    if (!exported.data.ok) return exported.data;
    if (!current()) return fail(appError('state_conflict', 'input', 'The research window changed.'));
    const report = exported.data.data;
    if (Buffer.byteLength(report.markdown, 'utf8') !== report.bytes)
      return fail(appError('research_evidence_mismatch', 'storage', 'Report export size changed.'));
    const selected = await dialog.showSaveDialog(owner!, { title: 'Save research report', defaultPath: report.filename,
      filters: [{ name: 'Markdown', extensions: ['md'] }] });
    if (!current()) return fail(appError('state_conflict', 'input', 'The research window changed before saving.'));
    if (selected.canceled || !selected.filePath) return ok({ cancelled: true });
    const saved = publishExportCopy(selected.filePath, Buffer.from(report.markdown, 'utf8'));
    return saved.ok ? ok({ cancelled: false, destinationPath: saved.data.destinationPath }) : saved;
  });
  handle(channels.getState, async () => readDesktopState());
  handle(channels.saveSettings, async (_event, settingsRaw, credentialUpdateRaw) => saveSettings(settingsRaw, credentialUpdateRaw));
  handle(channels.evaluationWorkflow, async (_event, input) => {
    const request = EvaluationWorkflowRequestSchema.safeParse(input);
    if (!request.success || !evaluation) return fail(appError('input_invalid', 'input', '评测闭环请求或控制器不可用。'));
    if (runtimeLayout?.mode === 'installed' && !isWorkflowReadOnly(request.data.action))
      return fail(appError('evaluation_workspace_unavailable', 'runtime', EVALUATION_WORKSPACE_UNAVAILABLE_REASON));
    if (request.data.action !== 'experiment.run') return evaluation.workflow(request.data);
    const settings = await readSavedSettings(); if (!settings.ok) return settings;
    const credentials = await prepareExperimentCredentials(request.data.plan, settings.data, credentialStore);
    return credentials.ok ? evaluation.workflow(request.data, credentials.data) : credentials;
  });
  for (const type of Object.keys(evaluationResponses) as EvaluationResponseType[]) {
    handle(`flowmate:${type.replaceAll('_', '-')}`, async (_event, input) => {
      const command = parseEvaluationCommand({ type, input });
      if (!command || !evaluation) return fail(appError('input_invalid', 'input', '评测操作或控制器不可用。'));
      let result: unknown;
      switch (command.type) {
        case 'query_evaluation_catalog': result = await evaluation.catalog(command.input); break;
        case 'add_evaluation_feedback': result = await evaluation.addFeedback(command.input); break;
        case 'query_evaluation_feedback': result = await evaluation.feedback(command.input); break;
        case 'export_evaluation': result = await evaluation.export(command.input); break;
        case 'preview_evaluation': {
          const current = await readSavedSettings(); if (!current.ok) return current;
          result = await evaluation.preview(command.input, await evaluationConfigurationSnapshot(current.data, credentialStore)); break;
        }
        case 'start_evaluation':
          result = await evaluation.start(command.input, async preview => {
            const current = await readSavedSettings(); if (!current.ok) return current;
            return prepareEvaluationCredentials(preview, current.data, credentialStore);
          }); break;
        case 'query_evaluation_control': result = await evaluation.control(command.input); break;
        case 'cancel_evaluation': result = await evaluation.cancel(command.input); break;
        case 'list_evaluation_executions': result = await evaluation.listExecutions(command.input); break;
        case 'query_evaluation_result': result = await evaluation.result(command.input); break;
        case 'compare_evaluation': result = await evaluation.compare(command.input); break;
        case 'save_evaluation_settings': {
          if (command.input.apiKey) registerSecrets([command.input.apiKey]);
          const saved = await saveEvaluationSettings(command.input, { getSettings: readSavedSettings,
            saveSettings: settings => requestHost({ type: 'save_settings', settings }) as Promise<Result<ProductSettings>>, credentialStore });
          if (!saved.ok) { result = saved; break; }
          result = ok({ role: command.input.role, revision: saved.data.revision,
            evaluation: saved.data.evaluation ?? { agent: null, judge: null }, credentials: await evaluationCredentialStatus(saved.data, credentialStore) });
          await broadcastState(); break;
        }
        default: return fail(appError('input_invalid', 'input', '未开放该评测操作。'));
      }
      return parseEvaluationResponse(type, scanEvidence(result).value)
        ?? fail(appError('evaluation_protocol_invalid', 'runtime', '评测结果结构无效。', true));
    });
  }
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
    try { return RuntimeToolPageResultSchema.parse(await requestProduct({ type: 'list_run_tool_calls', input: input.data })); }
    catch { return fail(appError('host_protocol_invalid', 'runtime', 'Run tool list could not be confirmed.', true)); }
  });
  handle(channels.queryRunToolCall, async (_event, raw) => {
    const input = RunToolCallRequestSchema.safeParse(raw);
    if (!input.success) return fail(appError('input_invalid', 'input', 'Run tool request is invalid.'));
    try { return RuntimeToolResultSchema.parse(await requestProduct({ type: 'query_run_tool_call', input: input.data })); }
    catch { return fail(appError('host_protocol_invalid', 'runtime', 'Run tool could not be confirmed.', true)); }
  });
  for (const type of [...personalAgentHostCommandTypes(), ...Object.keys(researchOperations), 'list_resources', 'read_resource_file', 'update_resource_selection', 'query_run_resources', 'read_run_resource_file',
    'list_extensions', 'update_extension_selection', 'query_session_extensions', 'query_run_extensions', 'execute_extension_command', 'dispose_session_extensions',
    'list_subagents', 'query_subagent', 'cancel_subagent', 'list_input_commands', 'list_subagent_definitions', 'get_subagent_definition', 'save_subagent_definition'] as const)
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
      const epoch = transportEpoch;
      try {
        const { version: _version, ...request } = command;
        const value = parseHistoryHostResult(type, await requestProduct(request));
        return epoch === transportEpoch && value !== null && matchesHistoryResponse(command, value) ? value : historyHostFailure();
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
    const checked = checkedInvoiceFormInspection(pending.owner, raw, { frame: event.senderFrame!, contents: event.sender, epoch: transportEpoch });
    pending.resolve(checked);
    return checked ? ok(undefined) : fail(appError('state_conflict', 'input', 'Form inspection does not match its owner or current revision.'));
  });
  for (const [channel, kind] of [[channels.saveInvoiceCandidate, 'save'], [channels.acceptInvoiceCandidate, 'accept'],
    [channels.rejectInvoiceCandidate, 'reject'], [channels.exportInvoiceCandidate, 'export']] as const) {
    handle(channel, async (event, raw) => {
      try { return await submitInvoiceCandidateOperation({ kind, request: raw }, { frame: event.senderFrame!, contents: event.sender, epoch: transportEpoch }); }
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
  handle(channels.saveInvoiceExport, async (event, raw) => saveInvoiceExport(event, raw));
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
  return !owner.contents.isDestroyed() && owner.epoch === transportEpoch
    && owner.generation === (runtimeGenerations.get(owner.contents.id) ?? 0)
    && owner.contents.mainFrame === owner.frame && owner.frame.url === owner.url && isAllowedPage(owner.url)
    && runtimeOwners.get(owner.contents.id) === owner;
}

function runtimeOwner(event: Electron.IpcMainInvokeEvent): RuntimeOwner {
  const existing = runtimeOwners.get(event.sender.id);
  if (existing && runtimeOwnerIsCurrent(existing)) return existing;
  releaseRuntimeOwner(event.sender.id);
  const owner: RuntimeOwner = { token: randomUUID(), contents: event.sender, frame: event.senderFrame!,
    url: event.senderFrame!.url, generation: runtimeGenerations.get(event.sender.id) ?? 0, epoch: transportEpoch };
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
    const result = RuntimeSubscriptionResultSchema.parse(await requestProduct({ type: 'subscribe_runtime_events',
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
    const result = RuntimeEventsReadResultSchema.parse(await requestProduct({ type: 'query_runtime_events', ownerToken: owner.token, input: input.data }));
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
    const result = RuntimeSubscriptionReleaseResultSchema.parse(await requestProduct({ type: 'unsubscribe_runtime_events', ownerToken: owner.token, subscriptionId: id }));
    if (result.ok) rememberRuntimeRelease(id, owner.token);
    else binding?.cleanup();
    return result;
  } catch {
    binding?.cleanup();
    return fail(appError('host_protocol_invalid', 'runtime', 'Runtime observation release could not be confirmed.', true));
  }
}

async function readDesktopState(): Promise<Result<DesktopState>> {
  const originalEpoch = transportEpoch;
  if (serviceMode && !serviceClient.isConnected) return ok({ version: 1, ready: false, host: 'error', settings: lastServiceSettings,
    modelCredentials: Object.fromEntries(lastServiceSettings.models.map(model => [model.id, 'unavailable' as const])),
    evaluationCredentials: await evaluationCredentialStatus(lastServiceSettings, credentialStore), evaluationControl: evaluation?.state ?? null,
    appVersion, userDataPath: userDataRoot, backgroundService });
  let base: Result<Omit<DesktopState, 'modelCredentials'>>;
  try { base = await requestProduct({ type: 'get_state' }) as Result<Omit<DesktopState, 'modelCredentials'>>; }
  catch { return fail(appError(hostErrorCode, 'runtime', 'Bun Host 当前不可用。', true)); }
  if (!base.ok) return base;
  if (serviceMode) { const saved = validateProductSettings(base.data.settings); if (!saved.ok) return saved; lastServiceSettings = saved.data; }
  const modelCredentials: Record<string, 'missing' | 'configured' | 'unavailable'> = {};
  if (base.data.settings) {
    const settings = base.data.settings as ProductSettings;
    if (serviceMode) {
      const status = await serviceClient.getCredentialStatus();
      for (const model of settings.models) modelCredentials[model.id] = status.ok && status.data.installationId === serviceInstallation?.installationId
        && status.data.settingsRevision === settings.revision ? status.data.models.find(item => item.modelId === model.id && item.credentialRef === model.credentialRef)?.status ?? 'unavailable' : 'unavailable';
    } else await Promise.all(settings.models.map(async (model) => { modelCredentials[model.id] = await modelCredentialStatus(model); }));
  }
  const evaluationCredentials = await evaluationCredentialStatus(base.data.settings, credentialStore);
  if (originalEpoch !== transportEpoch) return fail(appError('host_connection_changed', 'runtime', 'The original runtime connection changed.', true));
  return { ok: true, data: {
    ...base.data,
    ...(hostError || desktopClosing || serviceMode && backgroundService.state !== 'ready' ? { ready: false, host: desktopClosing ? 'closing' as const : 'error' as const } : {}),
    backgroundService,
    modelCredentials,
    evaluationCredentials,
    evaluationControl: evaluation?.state ?? null,
  } };
}

async function readSavedSettings(): Promise<Result<ProductSettings>> {
  const state = await requestHost({ type: 'get_state' }) as Result<Omit<DesktopState, 'modelCredentials'>>;
  if (!state.ok) return state;
  return state.data.settings ? ok(state.data.settings) : fail(appError(hostErrorCode, 'runtime', 'Bun Host 设置尚未就绪。', true));
}

async function modelCredentialStatus(model: ProductSettings['models'][number]): Promise<'missing' | 'configured' | 'unavailable'> {
  if (serviceMode) {
    if (!serviceClient.isConnected) return 'unavailable';
    const result = await serviceClient.getCredentialStatus();
    return result.ok && result.data.installationId === serviceInstallation?.installationId
      ? result.data.models.find(item => item.modelId === model.id && item.credentialRef === model.credentialRef)?.status ?? 'unavailable' : 'unavailable';
  }
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
  const previousResult = await requestHost({ type: 'get_state' }) as Result<Omit<DesktopState, 'modelCredentials'>>;
  if (!previousResult.ok || !previousResult.data.settings) return fail(appError(hostErrorCode, 'runtime', 'Bun Host 尚未就绪。', true));
  const previous = previousResult.data.settings as ProductSettings;
  const parsed = validateBusinessSettings(settingsRaw, previous);
  if (!parsed.ok) return parsed;
  if (serviceMode) {
    if (!serviceInstallation || !serviceClient.isConnected) return fail(appError('service_offline', 'runtime', 'Connect the enabled service before saving product settings.'));
    if (backgroundService.state !== 'ready') return fail(backgroundService.error ?? appError('service_offline', 'runtime', 'The original service connection is not ready for a settings save.'));
    if (serviceSettingsSaving) return fail(appError('config_settings_write_busy', 'runtime', 'The original settings request is still being checked.', true));
    serviceSettingsSaving = true;
    try {
    const recovered = await recoverServiceSettingsRequest(); if (!recovered.ok) return recovered;
    if (recovered.data.operationId) { await broadcastState(); return fail(appError('config_revision_conflict', 'input',
      `Original settings request ${recovered.data.operationId} was committed. Reload its saved settings before submitting a new draft.`, true)); }
    let credentialUpdate: { modelId: string; apiKey: string } | undefined;
    if (credentialUpdateRaw !== undefined && credentialUpdateRaw !== null) {
      const candidate = z.object({ modelId: z.string().regex(/^[a-zA-Z0-9._-]{1,64}$/), apiKey: z.string().min(1).max(4096).refine(value => Boolean(value.trim())) }).strict().safeParse(credentialUpdateRaw);
      if (!candidate.success) return fail(appError('credential_invalid', 'input', 'The selected model credential is invalid.'));
      credentialUpdate = candidate.data; registerSecrets([credentialUpdate.apiKey]);
    }
    const request: ServiceSettingsRequest = { version: 1, installationId: serviceInstallation.installationId, operationId: randomUUID() };
    const persisted = await saveServiceSettingsRequest(request); if (!persisted.ok) return persisted;
    const receipt = await serviceClient.saveServiceSettings({ installationId: request.installationId, operationId: request.operationId,
      settings: parsed.data, ...(credentialUpdate ? { credentialUpdate } : {}) });
    if (!receipt.ok) {
      if (receipt.error.category === 'input' && receipt.error.code !== 'operation_result_unknown') { const cleared = await clearServiceSettingsRequest(request); if (!cleared.ok) return cleared; return receipt; }
      return fail(appError('operation_result_unknown', 'runtime', `Original service settings request ${request.operationId} is retained. Check it before submitting another save.`, true));
    }
    if (receipt.data.phase === 'pending' || receipt.data.phase === 'prepared'
      || receipt.data.phase === 'failed' && (!receipt.data.error || receipt.data.error.code === 'operation_result_unknown')) return fail(appError('operation_result_unknown', 'runtime', `Original settings request ${request.operationId} is still pending.`, true));
    if (receipt.data.phase === 'failed') { const cleared = await clearServiceSettingsRequest(request); return cleared.ok
      ? fail(receipt.data.error ?? appError('service_settings_failed', 'storage', 'The service did not publish the requested settings.')) : cleared; }
    const saved = receipt.data.settings;
    if (!saved || saved.revision !== receipt.data.settingsRevision) return fail(appError('operation_result_unknown', 'runtime', 'The original committed settings snapshot is unavailable. Query the retained save before changing its draft.', true));
    const cleared = await clearServiceSettingsRequest(request); if (!cleared.ok) return cleared;
    await broadcastState(); return ok(saved);
    } finally { serviceSettingsSaving = false; }
  }
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
  let admittedRunId: number | null = null;
  const unsubscribe = host.subscribe(event => {
    if ((event.type === 'provider_observation' && event.observation === 'run_created' || event.type === 'provider_finished')
      && event.requestId === requestId && Number.isSafeInteger(event.runId) && event.runId > 0) admittedRunId = event.runId;
  });
  try {
    const value = await requestProduct({
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
    // Recover a lost receipt only from this request's actual Host admission.
    if (admittedRunId !== null) return { ok: true, data: { requestId, runId: admittedRunId } };
    return fail(appError('host_request_failed', 'runtime', 'Provider 请求未能提交给 Bun Host。', true));
  } finally { unsubscribe(); }
}

async function cancelProvider(value: unknown): Promise<Result<{ accepted: boolean; runId: number | null }>> {
  if (typeof value !== 'string' || value.length > 128) return fail(appError('input_invalid', 'input', '取消请求身份无效。'));
  try {
    return await requestProduct({ type: 'cancel_provider', targetRequestId: value }) as Result<{ accepted: boolean; runId: number | null }>;
  } catch { return fail(appError('host_request_failed', 'runtime', '取消命令未能提交给 Bun Host。', true)); }
}

async function queryRun(value: unknown): Promise<Result<RunSnapshot>> {
  if (!Number.isSafeInteger(value) || Number(value) <= 0) return fail(appError('input_invalid', 'input', 'Run ID 无效。'));
  try { return await requestProduct({ type: 'query_run', runId: Number(value) }) as Result<RunSnapshot>; }
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
    defaultPath: invoiceSourceRoot,
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

async function productHostRequest<T = unknown>(command: ServiceCommandInput, message: string,
  timeoutMs = 10_000, transportErrorCode = hostErrorCode): Promise<Result<T>> {
  const epoch = transportEpoch;
  try {
    const result = await requestProduct(command, timeoutMs) as Result<T>;
    return epoch === transportEpoch ? result : fail(appError(transportErrorCode, 'runtime', message, true));
  } catch (error) {
    return fail(appError(error instanceof Error && error.message === 'host_protocol_invalid' ? 'host_protocol_invalid' : transportErrorCode,
      'runtime', message, true));
  }
}

async function createSession(raw: unknown): Promise<Result<SessionSnapshot>> {
  const input = normalizeCreateSessionRequest(raw);
  if (!input.ok) return input;
  try { return await requestProduct({ type: 'create_session', input: input.data }) as Result<SessionSnapshot>; }
  catch { return fail(appError('host_request_failed', 'runtime', 'New Session 未能提交给 Bun Host。', true)); }
}

async function renameSession(raw: unknown): Promise<Result<SessionSnapshot>> {
  const input = normalizeRenameSessionRequest(raw);
  if (!input.ok) return input;
  try { return await requestProduct({ type: 'rename_session', input: input.data }) as Result<SessionSnapshot>; }
  catch { return fail(appError('host_request_failed', 'runtime', 'Session 重命名未能提交给 Bun Host。', true)); }
}

async function deleteSession(raw: unknown): Promise<Result<import('@flowmate/contracts').DeleteSessionResult>> {
  const sessionId = normalizeSessionId(raw);
  if (!sessionId.ok) return sessionId;
  try { return await requestProduct({ type: 'delete_session', sessionId: sessionId.data }) as Result<import('@flowmate/contracts').DeleteSessionResult>; }
  catch { return fail(appError('host_request_failed', 'runtime', 'Session could not be submitted for deletion to Bun Host.', true)); }
}

async function listSessions(raw?: unknown): Promise<Result<SessionPage>> {
  const input = normalizeListSessionsRequest(raw);
  if (!input.ok) return input;
  try { return await requestProduct({ type: 'list_sessions', input: input.data }) as Result<SessionPage>; }
  catch { return fail(appError('host_request_failed', 'runtime', 'Session 列表暂不可用。', true)); }
}

async function querySession(value: unknown): Promise<Result<SessionSnapshot>> {
  if (!Number.isSafeInteger(value) || Number(value) <= 0) return fail(appError('input_invalid', 'input', 'Session ID 无效。'));
  try { return await requestProduct({ type: 'query_session', sessionId: Number(value) }) as Result<SessionSnapshot>; }
  catch { return fail(appError('host_request_failed', 'runtime', 'Session 查询暂不可用。', true)); }
}

async function listSessionRuns(raw: unknown): Promise<Result<SessionRunsPage>> {
  const input = normalizeSessionRunsRequest(raw);
  if (!input.ok) return input;
  try { return await requestProduct({ type: 'list_session_runs', input: input.data }) as Result<SessionRunsPage>; }
  catch { return fail(appError('host_request_failed', 'runtime', 'Session Run 历史暂不可用。', true)); }
}

async function listSessionMessages(raw: unknown): Promise<Result<SessionMessagesPage>> {
  const input = normalizeSessionMessagesRequest(raw);
  if (!input.ok) return input;
  try {
    const result = await requestProduct({ type: 'list_session_messages', input: input.data }) as Result<unknown>;
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
    return await requestProduct({ type: 'query_prompt_trace', runId: Number(runIdRaw), ...(sequenceRaw === undefined ? {} : { callSequence: Number(sequenceRaw) }) }) as Result<PromptTraceResult>;
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
    const value = await requestProduct({
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
    const value = await requestProduct({ type: 'submit_session_input', requestId, input, ...preparation }, 15_000) as Result<SessionInputAccepted & { requestId: string }>;
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
  try { return await requestProduct({ type: 'cancel_run', runId: Number(value) }) as Result<{ accepted: boolean; runId: number }>; }
  catch { return fail(appError('host_request_failed', 'runtime', 'Stop 命令未能提交给 Bun Host。', true)); }
}

async function queryRuntimeState(): Promise<Result<RuntimeState>> {
  try { return await requestProduct({ type: 'query_runtime_state' }) as Result<RuntimeState>; }
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
    const file = join(userDataRoot, 'security', 'credentials', `${reference}.json`);
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
    if (!result.data.startsWith(piCredentialPrefix)) { registerSecrets([result.data]); return { ok: true, credential: { type: 'api_key', key: result.data } }; }
    try {
      const credential: unknown = JSON.parse(result.data.slice(piCredentialPrefix.length));
      if (!validPiCredential(credential)) return { ok: false };
      for (const name of ['key', 'access', 'refresh']) { const value = (credential as Record<string, unknown>)[name]; if (typeof value === 'string') registerSecrets([value]); }
      return { ok: true, credential };
    }
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

async function requestHost(command: ServiceCommandInput): Promise<unknown> {
  try { return await requestProduct(command); }
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
    backgroundService,
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
  invoiceFormBinding = { frame: event.senderFrame!, contents: event.sender, epoch: transportEpoch, currentRevision: input.data.formRevision,
    workspace: expected, purpose: input.data.purpose, target, valid: true, dirty: false, runId: null, pendingFill: false };
  return ok(target);
}

async function startInvoiceFormRun(event: Electron.IpcMainInvokeEvent, raw: unknown) {
  const input = InvoiceFormRunInputSchema.safeParse(raw);
  const binding = invoiceFormBinding;
  if (!input.success || !binding || !ownedInvoiceForm(event, input.data.target.formInstanceId) || !binding.valid
    || binding.epoch !== transportEpoch || binding.purpose !== 'fill' || binding.dirty
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
      && saved.content.desktopRequestIdentity !== serializeDesktopInvoiceFormRequest(input.data))
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
    || binding.epoch !== transportEpoch || binding.purpose !== 'fill' || binding.dirty
    || binding.target.expectedRevision !== input.data.target.expectedRevision || !sameFormWorkspace(binding.workspace, input.data.workspace))
    return fail(appError('state_conflict', 'input', 'The form target changed while preparing Fill. Check the current form.'));
  if (binding.clientSequence !== undefined) return startInvoiceFormRun(event, raw);
  if (!current.ok) return current;
  const profile = current.data.settings.models.find(model => model.id === input.data.modelId);
  if (!current.data.ready || !profile || current.data.modelCredentials[profile.id] !== 'configured') return fail(appError('model_credential_missing', 'input', 'Configure a model before Fill with Agent.'));
  binding.requestId = randomUUID(); binding.clientSequence = input.data.clientSequence; binding.modelId = input.data.modelId; binding.pendingFill = true;
  try {
    const accepted = await requestProduct({ type: 'submit_invoice_form_input', requestId: binding.requestId, input: input.data,
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
  if (!binding || !window || window.webContents.isDestroyed() || epoch !== transportEpoch
    || !matchesInvoiceFormTarget(binding, request, { frame: window.webContents.mainFrame, contents: window.webContents, epoch })) return unknownInvoiceForm(request);
  const run = await productHostRequest<RunSnapshot>({ type: 'query_run', runId: request.runId }, 'Fill Run could not be confirmed.', 1500);
  if (!run.ok || !matchesInvoiceFormRun(binding, request, run.data) || invoiceFormBinding !== binding || !binding.valid
    || transportEpoch !== epoch || window.webContents.mainFrame !== binding.frame) return unknownInvoiceForm(request);
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
    || pending.owner.epoch !== transportEpoch || receipt.data.runId !== pending.request.runId
    || receipt.data.toolCallId !== pending.request.toolCallId || receipt.data.formInstanceId !== pending.request.target.formInstanceId
    || receipt.data.candidateId !== pending.request.candidateId || receipt.data.candidateSequence !== pending.request.candidateSequence
    || receipt.data.outcome === 'applied' && receipt.data.appliedRevision !== pending.request.target.expectedRevision + 1) {
    return fail(appError('state_conflict', 'input', 'Form receipt does not match its original request.'));
  }
  pending.resolve(receipt.data);
  return ok(undefined);
}

async function inspectCurrentInvoiceForm(binding: DesktopFormBinding): Promise<DesktopInvoiceFormInspection | null> {
  if (!mainWindow || binding !== invoiceFormBinding || !binding.valid || binding.epoch !== transportEpoch
    || binding.frame !== mainWindow.webContents.mainFrame || binding.contents !== mainWindow.webContents) return null;
  return new Promise(resolve => {
    const requestId = randomUUID();
    const timer = setTimeout(() => finish(null), 2500);
    const finish = (value: DesktopInvoiceFormInspection | null) => { clearTimeout(timer); pendingFormInspections.delete(requestId); resolve(value); };
    pendingFormInspections.set(requestId, { owner: binding, resolve: finish });
    mainWindow!.webContents.send('flowmate:invoice-form-inspect', { requestId, formInstanceId: binding.target.formInstanceId });
  });
}

const pendingInvoiceExports = new WeakSet<object>();
async function saveInvoiceExport(event: Electron.IpcMainInvokeEvent, raw: unknown): Promise<Result<DesktopInvoiceExportResult>> {
  const parsed = ExportInvoiceCandidateRequestSchema.safeParse(raw);
  if (!parsed.success) return fail(appError('input_invalid', 'input', 'Invoice export request is invalid.'));
  if (!mainWindow || pendingInvoiceExports.has(event.sender)) return fail(appError('state_conflict', 'input', 'An invoice Save dialog is already open.'));
  const window = mainWindow, frame = event.senderFrame, epoch = transportEpoch;
  const currentOwner = () => mainWindow === window && !window.isDestroyed() && epoch === transportEpoch
    && !event.sender.isDestroyed() && event.sender.mainFrame === frame && isTrustedSender(event);
  pendingInvoiceExports.add(event.sender);
  try {
    const extension = parsed.data.format === 'markdown' ? 'md' : parsed.data.format;
    const selected = await dialog.showSaveDialog(window, { title: 'Save invoice export',
      defaultPath: `invoice-result-${parsed.data.candidateId}.${extension}`,
      filters: [{ name: parsed.data.format.toUpperCase(), extensions: [extension] }] });
    if (!currentOwner()) return fail(appError('state_conflict', 'input', 'The invoice export window or Host changed. Open Save again.'));
    if (selected.canceled || !selected.filePath) return ok({ outcome: 'cancelled' });
    const managed = await submitInvoiceCandidateOperation({ kind: 'export', request: parsed.data }, { frame: frame!, contents: event.sender, epoch });
    if (!managed.ok) return managed;
    const reference = managed.data as InvoiceExportReference;
    if (!currentOwner()) return fail(appError('state_conflict', 'input', 'The managed export is registered; the window changed before the external copy.'));
    const paths = resolveProductPaths(userDataRoot);
    if (!paths.ok) return paths;
    const chunks: Buffer[] = [];
    let offset = 0;
    do {
      const page = await productHostRequest<import('@flowmate/contracts').InvoiceExportPage>({ type: 'read_invoice_export',
        input: { ...parsed.data, offset, limit: 32_768 } }, 'Original export bytes are unavailable.');
      if (!page.ok) return page;
      if (!currentOwner() || page.data.artifactId !== reference.artifactId || page.data.candidateId !== reference.candidateId
        || page.data.relativePath !== reference.relativePath || page.data.format !== reference.format || page.data.bytes !== reference.bytes
        || page.data.offset !== offset) return fail(appError('state_conflict', 'input', 'Export bytes do not match the original operation.'));
      chunks.push(Buffer.from(page.data.chunkBase64, 'base64'));
      offset = page.data.nextOffset ?? reference.bytes;
    } while (offset < reference.bytes);
    const source = readManagedInvoiceExport(paths.data, reference, Buffer.concat(chunks));
    if (!source.ok) return source;
    const published = publishInvoiceExportCopy(selected.filePath, source.data);
    return published.ok ? ok({ outcome: 'saved', reference, destinationPath: published.data.destinationPath })
      : fail({ ...published.error, message: `Managed export registered: ${reference.relativePath}. ${published.error.message}` });
  } catch { return fail(appError('storage_write_failed', 'storage', 'The invoice Save dialog or copy could not be confirmed. Check the original managed operation before saving again.', true)); }
  finally { pendingInvoiceExports.delete(event.sender); }
}

async function submitInvoiceCandidateOperation(raw: unknown, owner: InvoiceFormOwner,
  inspected?: DesktopInvoiceFormInspection): Promise<Result<InvoiceCandidateOperationResult>> {
  const generation = mainWindow ? runtimeGenerations.get(mainWindow.webContents.id) ?? 0 : -1;
  const query = InvoiceCandidateOperationQuerySchema.safeParse(raw);
  if (!query.success) return fail(appError('input_invalid', 'input', 'Candidate operation is invalid.'));
  const input = query.data;
  // Resolve the exact original command before consulting a now-stale target or Workspace.
  const prior = await productHostRequest<InvoiceCandidateOperationResult>({ type: 'query_invoice_candidate_operation', input }, 'Original candidate operation could not be queried.');
  if (!prior.ok || prior.data !== null) return prior;
  if (!mainWindow || mainWindow.isDestroyed() || mainWindow.webContents.isDestroyed()
    || generation !== (runtimeGenerations.get(mainWindow.webContents.id) ?? 0)
    || owner.contents !== mainWindow.webContents || owner.frame !== mainWindow.webContents.mainFrame || owner.epoch !== transportEpoch)
    return fail(appError('state_conflict', 'input', 'The invoice operation window or Host changed. Open the current result again.'));
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
    if (input.request.basedOnCandidateId !== form.basis.candidateId || JSON.stringify(input.request.draft) !== JSON.stringify(form.draft)
      || JSON.stringify(input.request.lineOrigins) !== JSON.stringify(form.lineOrigins))
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
      expectedRevision: current.data.revision, draft: form.draft, ...(form.lineOrigins === undefined ? {} : { lineOrigins: form.lineOrigins }) } };
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
  const rendererUrl = !app.isPackaged ? process.env.ELECTRON_RENDERER_URL : undefined;
  if (rendererUrl) {
    try { return new URL(value).origin === new URL(rendererUrl).origin; } catch { return false; }
  }
  return value === pathToFileURL(join(app.isPackaged ? app.getAppPath() : resolveWorkspaceRoot(app.getAppPath()), 'out/renderer/index.html')).href;
}

function isAbsolutePath(value: string): boolean {
  return /^[a-zA-Z]:[\\/]/.test(value) || value.startsWith('\\\\') || value.startsWith('/');
}
