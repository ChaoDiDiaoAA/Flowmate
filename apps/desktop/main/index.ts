import { app, BrowserWindow, ipcMain, safeStorage, shell } from 'electron';
import { createHash, randomUUID } from 'node:crypto';
import { mkdir } from 'node:fs/promises';
import { existsSync, mkdirSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import {
  appError,
  fail,
  normalizeCreateSessionRequest,
  normalizeListSessionsRequest,
  normalizeRenameSessionRequest,
  normalizeSessionId,
  normalizeSessionRunsRequest,
} from '@flowmate/contracts';
import type {
  DesktopAgentRunRequest,
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
  SessionSnapshot,
  RuntimeState,
} from '@flowmate/contracts';
import { defaultProductSettings, validateProductSettings } from '../../../packages/core/src/configuration/settings.ts';
import { createCredentialStore } from '../../../packages/shared/src/secure-credential-store.ts';
import type { CredentialStore, SecureStoragePort } from '../../../packages/shared/src/secure-credential-store.ts';
import { HostClient } from './host-client.ts';

const channels = {
  getState: 'flowmate:get-state',
  saveSettings: 'flowmate:save-settings',
  callProvider: 'flowmate:call-provider',
  cancelProvider: 'flowmate:cancel-provider',
  queryRun: 'flowmate:query-run',
  createSession: 'flowmate:create-session',
  renameSession: 'flowmate:rename-session',
  deleteSession: 'flowmate:delete-session',
  listSessions: 'flowmate:list-sessions',
  querySession: 'flowmate:query-session',
  listSessionRuns: 'flowmate:list-session-runs',
  queryPromptTrace: 'flowmate:query-prompt-trace',
  startRun: 'flowmate:start-run',
  cancelRun: 'flowmate:cancel-run',
  queryRuntimeState: 'flowmate:query-runtime-state',
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
  && ((value as ProviderTestRequest).timeoutMs === undefined || (Number.isInteger((value as ProviderTestRequest).timeoutMs) && (value as ProviderTestRequest).timeoutMs! >= 100 && (value as ProviderTestRequest).timeoutMs! <= 120_000));

let mainWindow: BrowserWindow | null = null;
let allowWindowClose = false;
let allowQuit = false;
let hostError = false;
let hostErrorCode = 'host_not_ready';
let ipcRegistered = false;
let userDataRoot = '';
let appVersion = '0.1.0';
const host = new HostClient();
const subscriptions = new Map<number, () => void>();
const credentialStores = new Map<string, CredentialStore>();

const systemSecureStorage: SecureStoragePort = {
  async isAvailable() {
    try {
      const available = await safeStorage.isAsyncEncryptionAvailable();
      const backend = process.platform === 'linux' ? safeStorage.getSelectedStorageBackend() : 'system';
      return available && safeStorage.isEncryptionAvailable() && backend !== 'basic_text' && backend !== 'unknown';
    } catch { return false; }
  },
  encrypt: (plaintext) => safeStorage.encryptStringAsync(plaintext),
  async decrypt(ciphertext) {
    const result = await safeStorage.decryptStringAsync(Buffer.from(ciphertext));
    return { plaintext: result.result, shouldReEncrypt: result.shouldReEncrypt };
  },
};

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
  void closeHostAndQuit();
});

void bootstrap().catch(() => {
  hostError = true;
  hostErrorCode = 'desktop_start_failed';
  registerIpc();
  createMainWindow();
});

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
  host.subscribe((event) => {
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
    for (const [webContentsId] of subscriptions) {
      const contents = BrowserWindow.getAllWindows().find((window) => window.webContents.id === webContentsId)?.webContents;
      if (contents && !contents.isDestroyed()) contents.send('flowmate:event', desktopEvent);
    }
  });
  const started = await host.start(userDataRoot, appVersion, appRoot);
  if (!started.ok || !started.data.ready) {
    hostError = true;
    hostErrorCode = started.ok ? 'host_start_failed' : started.error.code;
  }
  registerIpc();
  createMainWindow();
}

async function closeHostAndQuit(): Promise<void> {
  const closed = await host.close();
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
  window.removeMenu();
  window.once('ready-to-show', () => window.show());
  window.on('closed', () => { mainWindow = null; });
  window.on('close', (event) => {
    if (allowWindowClose) return;
    event.preventDefault();
    void closeHostAndQuit();
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

function registerIpc(): void {
  if (ipcRegistered) return;
  ipcRegistered = true;
  const handle = (channel: string, handler: (event: Electron.IpcMainInvokeEvent, ...args: unknown[]) => Promise<unknown>) => {
    ipcMain.handle(channel, async (event, ...args) => {
      if (!isTrustedSender(event)) return fail(appError('ipc_forbidden', 'input', '请求来源不受信任。'));
      try { return await handler(event, ...args); }
      catch { return fail(appError('desktop_operation_failed', 'runtime', '桌面操作失败。', true)); }
    });
  };

  handle(channels.getState, async () => readDesktopState());
  handle(channels.saveSettings, async (_event, settingsRaw, credentialUpdateRaw) => saveSettings(settingsRaw, credentialUpdateRaw));
  handle(channels.callProvider, async (_event, inputRaw) => callProvider(inputRaw));
  handle(channels.cancelProvider, async (_event, requestIdRaw) => cancelProvider(requestIdRaw));
  handle(channels.queryRun, async (_event, runIdRaw) => queryRun(runIdRaw));
  handle(channels.createSession, async (_event, inputRaw) => createSession(inputRaw));
  handle(channels.renameSession, async (_event, inputRaw) => renameSession(inputRaw));
  handle(channels.deleteSession, async (_event, sessionIdRaw) => deleteSession(sessionIdRaw));
  handle(channels.listSessions, async (_event, inputRaw) => listSessions(inputRaw));
  handle(channels.querySession, async (_event, sessionIdRaw) => querySession(sessionIdRaw));
  handle(channels.listSessionRuns, async (_event, inputRaw) => listSessionRuns(inputRaw));
  handle(channels.queryPromptTrace, async (_event, runIdRaw, sequenceRaw) => queryPromptTrace(runIdRaw, sequenceRaw));
  handle(channels.startRun, async (_event, inputRaw) => startRun(inputRaw));
  handle(channels.cancelRun, async (_event, runIdRaw) => cancelRun(runIdRaw));
  handle(channels.queryRuntimeState, async () => queryRuntimeState());
  handle(channels.subscribe, async (event) => {
    const id = event.sender.id;
    subscriptions.set(id, () => undefined);
    return { ok: true };
  });
  handle(channels.unsubscribe, async (event) => {
    subscriptions.delete(event.sender.id);
    return { ok: true };
  });
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
      modelCredentials[model.id] = await credentialStore(model.credentialRef).status();
    }));
  }
  return { ok: true, data: {
    ...base.data,
    ...(hostError ? { ready: false, host: 'error' as const } : {}),
    modelCredentials,
  } };
}

async function saveSettings(settingsRaw: unknown, credentialUpdateRaw: unknown): Promise<Result<ProductSettings>> {
  const parsed = validateProductSettings(settingsRaw);
  if (!parsed.ok) return parsed;
  const previousResult = await requestHost({ type: 'get_state' }) as Result<Omit<DesktopState, 'modelCredentials'>>;
  if (!previousResult.ok || !previousResult.data.settings) return fail(appError(hostErrorCode, 'runtime', 'Bun Host 尚未就绪。', true));
  const previous = previousResult.data.settings as ProductSettings;
  let next = parsed.data;
  let newCredentialRef: string | null = null;
  let oldCredentialRef: string | null = null;
  let update: { modelId: string; apiKey: string } | null = null;
  if (credentialUpdateRaw !== undefined && credentialUpdateRaw !== null) {
    if (typeof credentialUpdateRaw !== 'object') return fail(appError('credential_invalid', 'input', '模型凭据输入无效。'));
    const candidate = credentialUpdateRaw as { modelId?: unknown; apiKey?: unknown };
    if (typeof candidate.modelId !== 'string' || !/^[a-zA-Z0-9._-]{1,64}$/.test(candidate.modelId)
      || typeof candidate.apiKey !== 'string' || !candidate.apiKey.trim() || candidate.apiKey.length > 4096) {
      return fail(appError('credential_invalid', 'input', '模型凭据输入无效。'));
    }
    const nextModel = next.models.find((model) => model.id === candidate.modelId);
    if (!nextModel) return fail(appError('credential_model_missing', 'input', '凭据对应的模型配置不存在。'));
    const priorModel = previous.models.find((model) => model.id === candidate.modelId);
    oldCredentialRef = priorModel?.credentialRef ?? null;
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
  if (newCredentialRef && oldCredentialRef && oldCredentialRef !== newCredentialRef) {
    const removed = await credentialStore(oldCredentialRef).remove();
    if (!removed.ok) process.stderr.write('[Flowmate] An old encrypted credential could not be removed.\n');
  }
  const nextIds = new Set(saved.data.models.map((model) => model.id));
  for (const priorModel of previous.models) {
    if (!nextIds.has(priorModel.id) && !saved.data.models.some((model) => model.credentialRef === priorModel.credentialRef)) {
      const removed = await credentialStore(priorModel.credentialRef).remove();
      if (!removed.ok) process.stderr.write('[Flowmate] A removed model credential could not be deleted.\n');
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
  const store = credentialStore(model.credentialRef);
  const credential = await store.read();
  if (!credential.ok) return credential;
  if (!credential.data) return fail(appError('model_credential_missing', 'input', '请先保存该模型的 API Key。'));
  const requestId = randomUUID();
  try {
    const value = await host.request({
      type: 'call_provider',
      requestId,
      input: inputRaw,
      apiKey: credential.data,
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

async function deleteSession(raw: unknown): Promise<Result<{ deletedSessionId: number }>> {
  const sessionId = normalizeSessionId(raw);
  if (!sessionId.ok) return sessionId;
  try { return await host.request({ type: 'delete_session', sessionId: sessionId.data }) as Result<{ deletedSessionId: number }>; }
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
  const store = credentialStore(profile.credentialRef);
  const credential = await store.read();
  if (!credential.ok) return credential;
  if (!credential.data) return fail(appError('model_credential_missing', 'input', '请先保存该模型的 API Key。'));

  const requestId = randomUUID();
  let apiKey = credential.data;
  try {
    const value = await host.request({
      type: 'start_run',
      requestId,
      input: raw,
      apiKey,
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
  } finally {
    apiKey = '';
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
  if (!value || typeof value !== 'object') return false;
  const request = value as Partial<DesktopAgentRunRequest>;
  return Number.isSafeInteger(request.sessionId) && Number(request.sessionId) > 0
    && typeof request.text === 'string' && request.text.trim().length > 0
    && new TextEncoder().encode(request.text).byteLength <= 65_536
    && typeof request.modelId === 'string' && /^[a-zA-Z0-9._-]{1,64}$/.test(request.modelId)
    && (request.timeoutMs === undefined || Number.isInteger(request.timeoutMs) && request.timeoutMs >= 100 && request.timeoutMs <= 120_000);
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

async function requestHost(command: Parameters<HostClient['request']>[0]): Promise<unknown> {
  try { return await host.request(command); }
  catch { return fail(appError('host_request_failed', 'runtime', 'Bun Host 命令未能完成。', true)); }
}

async function broadcastState(): Promise<void> {
  const result = await readDesktopState();
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

function isTrustedSender(event: Electron.IpcMainInvokeEvent): boolean {
  if (!mainWindow || event.sender !== mainWindow.webContents || mainWindow.webContents.isDestroyed()) return false;
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
