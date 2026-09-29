import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { isAbsolute, join } from 'node:path';
import { createInterface } from 'node:readline';
import type { Credential, CredentialStore } from '@earendil-works/pi-ai';
import { appError, fail, normalizeAgentRunRequest, normalizeProviderRequest, ok } from '@flowmate/contracts';
import type { Application, DesktopState, ProductSettings } from '@flowmate/contracts';
import { defaultProductSettings, readProductSettings, saveProductSettings } from '@flowmate/core';
import { createPromptTraceBuffer } from '@flowmate/logging';
import { PiAgentAdapter, PiProviderAdapter, createPiModelCatalog, loginPiProvider, logoutPiProvider } from '@flowmate/runtime-pi';
import { resolveProductPaths } from '@flowmate/shared';
import { createApplication } from '../composition.ts';
import { parseHostCommand } from './protocol.ts';
import type { HostCommand, HostOutput } from './protocol.ts';

for (const method of ['log', 'info', 'warn', 'error', 'debug'] as const) {
  console[method] = (...values: unknown[]) => process.stderr.write(`${values.map((value) => String(value)).join(' ')}\n`);
}

function send(value: HostOutput): void {
  try { process.stdout.write(`${JSON.stringify(value)}\n`); } catch { /* parent may already have exited */ }
}

function startupRoot(): string | null {
  const index = process.argv.indexOf('--user-data-root');
  const value = index >= 0 ? process.argv[index + 1] : undefined;
  return value && isAbsolute(value) ? value : null;
}

function startupInvoiceSourceRoot(): string | null {
  const index = process.argv.indexOf('--invoice-source-root');
  const value = index >= 0 ? process.argv[index + 1] : undefined;
  return value && isAbsolute(value) ? value : null;
}

const root = startupRoot();
const invoiceSourceRoot = startupInvoiceSourceRoot() ?? join(process.cwd(), 'data', 'invoices', 'agent-input');
if (!root) {
  send({ version: 1, type: 'ready', state: { version: 1, ready: false, host: 'error', appVersion: '0.0.0', userDataPath: '' } as Omit<DesktopState, 'modelCredentials'> });
  process.exitCode = 2;
} else {
  await runHost(root, invoiceSourceRoot);
}

async function runHost(userDataRoot: string, invoiceSourceRoot: string): Promise<void> {
  const pathsResult = resolveProductPaths(userDataRoot);
  if (!pathsResult.ok) {
    send({ version: 1, type: 'ready', state: { version: 1, ready: false, host: 'error', appVersion: '0.0.0', userDataPath: userDataRoot } as Omit<DesktopState, 'modelCredentials'> });
    process.exitCode = 2;
    return;
  }
  const paths = pathsResult.data;
  const settingsFile = join(paths.root, 'data', 'settings.json');
  const authFile = join(paths.runtimeDir, 'pi-desktop', 'auth.json');

  let settings = await readProductSettings(settingsFile);
  if (!settings.ok) {
    send({ version: 1, type: 'ready', state: { version: 1, ready: false, host: 'error', appVersion: '0.0.0', userDataPath: paths.root } as Omit<DesktopState, 'modelCredentials'> });
    process.exitCode = 2;
    return;
  }
  try {
    const raw = JSON.parse(await readFile(settingsFile, 'utf8')) as { version?: unknown };
    if (raw.version === 1) settings = await saveProductSettings(settingsFile, settings.data);
  } catch { /* A missing settings file already has safe defaults. */ }
  if (!settings.ok) {
    send({ version: 1, type: 'ready', state: { version: 1, ready: false, host: 'error', appVersion: '0.0.0', userDataPath: paths.root } as Omit<DesktopState, 'modelCredentials'> });
    process.exitCode = 2;
    return;
  }
  let currentSettings: ProductSettings = settings.data ?? defaultProductSettings();
  const active = new Map<string, { controller: AbortController; runId: number | null }>();
  const recentlySeen = new Set<string>();
  const seenOrder: string[] = [];
  let application: Application;
  const pendingCredentials = new Map<string, (value: { ok: boolean; credential?: unknown }) => void>();
  const credentialWrites = new Map<string, Promise<unknown>>();
  const credentialRequest = (ref: string, operation: 'read' | 'write' | 'delete', credential?: Credential): Promise<Credential | undefined> => {
    const requestId = randomUUID();
    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => { pendingCredentials.delete(requestId); reject(new Error('credential_timeout')); }, 10_000);
      pendingCredentials.set(requestId, (value) => {
        clearTimeout(timeout);
        if (!value.ok) reject(new Error('credential_unavailable'));
        else resolve(value.credential as Credential | undefined);
      });
      send({ version: 1, type: 'credential_request', requestId, credentialRef: ref, operation,
        ...(credential === undefined ? {} : { credential }) });
    });
  };
  const credentialsFor = (config: { credentialRef?: string; modelRef: { provider: string } }): CredentialStore | undefined => {
    const ref = config.credentialRef;
    if (!ref) return undefined;
    const providerId = config.modelRef.provider;
    const read = () => credentialRequest(ref, 'read');
    const serialize = <T>(operation: () => Promise<T>): Promise<T> => {
      const previous = credentialWrites.get(ref) ?? Promise.resolve();
      const current = previous.catch(() => undefined).then(operation);
      credentialWrites.set(ref, current.catch(() => undefined));
      return current;
    };
    return {
      read: async (id) => id === providerId ? read() : undefined,
      list: async () => { const credential = await read(); return credential ? [{ providerId, type: credential.type }] : []; },
      modify: (id, fn) => {
        if (id !== providerId) return Promise.reject(new Error('credential_provider_mismatch'));
        return serialize(async () => {
          const current = await read();
          const next = await fn(current);
          if (next !== undefined) await credentialRequest(ref, 'write', next);
          return next ?? current;
        });
      },
      delete: (id) => id === providerId
        ? serialize(async () => { await credentialRequest(ref, 'delete'); })
        : Promise.reject(new Error('credential_provider_mismatch')),
    };
  };
  const promptTrace = createPromptTraceBuffer();
  const created = await createApplication({
    paths,
    invoiceSourceRoot,
    provider: new PiProviderAdapter({ credentialsFor }),
    agentFactory: (tools) => new PiAgentAdapter({ credentialsFor, cwd: paths.runtimeDir, agentDir: paths.runtimeDir, promptTrace, tools }),
    promptTrace,
  });
  if (!created.ok) {
    send({ version: 1, type: 'ready', state: { version: 1, ready: false, host: 'error', appVersion: '0.0.0', userDataPath: paths.root } as Omit<DesktopState, 'modelCredentials'> });
    process.exitCode = 2;
    return;
  }
  application = created.data;
  const catalog = await createPiModelCatalog();
  const logins = new Map<string, AbortController>();
  const authPrompts = new Map<string, { requestId: string; resolve(value: string): void; reject(error: Error): void }>();

  const state = (): Omit<DesktopState, 'modelCredentials'> => ({
    version: 1,
    ready: true,
    host: 'ready',
    settings: currentSettings,
    appVersion: process.env.FLOWMATE_DESKTOP_VERSION ?? '0.1.0',
    userDataPath: paths.root,
  });
  send({ version: 1, type: 'ready', state: state() });
  let settingsWriteQueue = Promise.resolve();
  const claimRequestId = (requestId: string) => {
    if (recentlySeen.has(requestId)) return false;
    recentlySeen.add(requestId);
    seenOrder.push(requestId);
    if (seenOrder.length > 4096) recentlySeen.delete(seenOrder.shift()!);
    return true;
  };

  const dispatch = async (command: HostCommand): Promise<void> => {
    if (command.type === 'credential_response') {
      pendingCredentials.get(command.requestId)?.(command.value);
      pendingCredentials.delete(command.requestId);
      return;
    }
    if (command.type === 'get_state') {
      send({ version: 1, type: 'response', requestId: command.requestId, value: ok(state()) });
      return;
    }
    if (command.type === 'list_model_catalog') {
      try { send({ version: 1, type: 'response', requestId: command.requestId,
        value: ok(await catalog.list(command.providerId, command.refresh)) }); }
      catch { send({ version: 1, type: 'response', requestId: command.requestId,
        value: fail(appError('provider_catalog_unavailable', 'provider', 'Pi model catalog is unavailable.', true)) }); }
      return;
    }
    if (command.type === 'auth_reply') {
      const prompt = authPrompts.get(command.promptId);
      if (!prompt || prompt.requestId !== command.loginRequestId) {
        send({ version: 1, type: 'response', requestId: command.requestId,
          value: fail(appError('auth_prompt_missing', 'input', 'The login prompt is no longer active.')) });
        return;
      }
      authPrompts.delete(command.promptId);
      if (command.value === null) prompt.reject(new Error('auth_cancelled'));
      else prompt.resolve(command.value);
      send({ version: 1, type: 'response', requestId: command.requestId, value: ok(undefined) });
      return;
    }
    if (command.type === 'cancel_login') {
      logins.get(command.loginRequestId)?.abort();
      send({ version: 1, type: 'response', requestId: command.requestId, value: ok(undefined) });
      return;
    }
    if (command.type === 'login_model') {
      if (logins.size > 0 || !claimRequestId(command.requestId)) {
        send({ version: 1, type: 'response', requestId: command.requestId,
          value: fail(appError('auth_login_busy', 'input', 'Another model login is already active.')) });
        return;
      }
      const profile = currentSettings.models.find((model) => model.id === command.modelId);
      if (!profile || profile.kind !== 'catalog' || !profile.providerId) {
        send({ version: 1, type: 'response', requestId: command.requestId,
          value: fail(appError('model_not_configured', 'input', 'Choose and save a Pi provider model first.')) });
        return;
      }
      const credentials = credentialsFor({ credentialRef: profile.credentialRef, modelRef: { provider: profile.providerId } })!;
      const controller = new AbortController();
      logins.set(command.requestId, controller);
      const timer = setTimeout(() => controller.abort(), 180_000);
      try {
        await loginPiProvider(profile.providerId, command.authType, credentials, {
          signal: controller.signal,
          notify: (notice) => send({ version: 1, type: 'event', event: {
            type: 'model_auth_notice', requestId: command.requestId, notice,
          } }),
          prompt: (prompt) => {
            const promptId = randomUUID();
            return new Promise<string>((resolve, reject) => {
              const abort = () => { authPrompts.delete(promptId); reject(new Error('auth_cancelled')); };
              if (controller.signal.aborted || prompt.signal?.aborted) { abort(); return; }
              authPrompts.set(promptId, { requestId: command.requestId, resolve, reject });
              controller.signal.addEventListener('abort', abort, { once: true });
              prompt.signal?.addEventListener('abort', abort, { once: true });
              const { signal: _signal, ...visiblePrompt } = prompt;
              send({ version: 1, type: 'event', event: {
                type: 'model_auth_prompt', requestId: command.requestId, promptId, prompt: visiblePrompt,
              } });
            });
          },
        });
        send({ version: 1, type: 'response', requestId: command.requestId, value: ok({ configured: true }) });
      } catch {
        send({ version: 1, type: 'response', requestId: command.requestId,
          value: fail(appError(controller.signal.aborted ? 'auth_cancelled' : 'auth_login_failed', 'provider',
            controller.signal.aborted ? 'Model login was cancelled or timed out.' : 'Pi provider login failed.', true)) });
      } finally {
        clearTimeout(timer);
        logins.delete(command.requestId);
        for (const [id, prompt] of authPrompts) if (prompt.requestId === command.requestId) authPrompts.delete(id);
      }
      return;
    }
    if (command.type === 'logout_model') {
      if (logins.size > 0) {
        send({ version: 1, type: 'response', requestId: command.requestId,
          value: fail(appError('auth_login_busy', 'input', 'Finish the active model login first.')) });
        return;
      }
      const profile = currentSettings.models.find((model) => model.id === command.modelId);
      if (!profile || profile.kind !== 'catalog' || !profile.providerId) {
        send({ version: 1, type: 'response', requestId: command.requestId,
          value: fail(appError('model_not_configured', 'input', 'The Pi provider model is unavailable.')) });
        return;
      }
      try {
        await logoutPiProvider(profile.providerId, credentialsFor({ credentialRef: profile.credentialRef,
          modelRef: { provider: profile.providerId } })!);
        send({ version: 1, type: 'response', requestId: command.requestId, value: ok(undefined) });
      } catch {
        send({ version: 1, type: 'response', requestId: command.requestId,
          value: fail(appError('auth_logout_failed', 'provider', 'Pi provider logout failed.', true)) });
      }
      return;
    }
    if (command.type === 'save_settings') {
      let resolveQueue!: () => void;
      const previous = settingsWriteQueue;
      settingsWriteQueue = new Promise<void>((resolve) => { resolveQueue = resolve; });
      await previous;
      let saved;
      try { saved = await saveProductSettings(settingsFile, command.settings); }
      finally { resolveQueue(); }
      if (saved.ok) {
        currentSettings = saved.data;
        send({ version: 1, type: 'event', event: { type: 'host_state', state: state() } });
      }
      send({ version: 1, type: 'response', requestId: command.requestId, value: saved });
      return;
    }
    if (command.type === 'query_run') {
      send({ version: 1, type: 'response', requestId: command.requestId, value: await application.queryRun(command.runId) });
      return;
    }
    if (command.type === 'read_workspace') {
      send({ version: 1, type: 'response', requestId: command.requestId, value: await application.readWorkspace() });
      return;
    }
    if (command.type === 'update_workspace') {
      send({ version: 1, type: 'response', requestId: command.requestId, value: await application.updateWorkspace(command.input) });
      return;
    }
    if (command.type === 'start_task') {
      send({ version: 1, type: 'response', requestId: command.requestId, value: await application.startTask(command.input) });
      return;
    }
    if (command.type === 'query_task_operation') {
      send({ version: 1, type: 'response', requestId: command.requestId, value: await application.queryTaskOperation(command.clientSequence) });
      return;
    }
    if (command.type === 'select_candidate') {
      send({ version: 1, type: 'response', requestId: command.requestId, value: await application.selectCandidate(command.input) });
      return;
    }
    if (command.type === 'list_documents') {
      send({ version: 1, type: 'response', requestId: command.requestId, value: await application.listDocuments(command.input) });
      return;
    }
    if (command.type === 'query_document') {
      send({ version: 1, type: 'response', requestId: command.requestId, value: await application.queryDocument(command.documentId) });
      return;
    }
    if (command.type === 'list_jobs') {
      send({ version: 1, type: 'response', requestId: command.requestId, value: await application.listJobs(command.input) });
      return;
    }
    if (command.type === 'query_job') {
      send({ version: 1, type: 'response', requestId: command.requestId, value: await application.queryJob(command.jobId) });
      return;
    }
    if (command.type === 'hide_job') {
      send({ version: 1, type: 'response', requestId: command.requestId, value: await application.hideJob(command.jobId) });
      return;
    }
    if (command.type === 'list_job_candidates') {
      send({ version: 1, type: 'response', requestId: command.requestId,
        value: await application.listJobCandidates({ ...command.input, beforeSequence: command.input.beforeSequence ?? undefined }) });
      return;
    }
    if (command.type === 'query_job_candidate') {
      send({ version: 1, type: 'response', requestId: command.requestId, value: await application.queryJobCandidate(command.input) });
      return;
    }
    if (command.type === 'list_activity') {
      send({ version: 1, type: 'response', requestId: command.requestId, value: await application.listActivity(command.input) });
      return;
    }
    if (command.type === 'import_invoice_material') {
      send({ version: 1, type: 'response', requestId: command.requestId,
        value: await application.importInvoiceMaterial(command.sourceDirectory) });
      return;
    }
    if (command.type === 'read_document_page') {
      send({ version: 1, type: 'response', requestId: command.requestId, value: await application.readDocumentPage(command.input) });
      return;
    }
    if (command.type === 'read_document_original') {
      send({ version: 1, type: 'response', requestId: command.requestId,
        value: await application.readDocumentOriginal(command.documentId, command.page) });
      return;
    }
    if (command.type === 'revoke_document_use') {
      send({ version: 1, type: 'response', requestId: command.requestId,
        value: await application.revokeDocumentUse(command.documentId) });
      return;
    }
    if (command.type === 'create_session') {
      if (!claimRequestId(command.requestId)) {
        send({ version: 1, type: 'response', requestId: command.requestId, value: fail(appError('request_duplicate', 'input', '该请求身份已使用，未重复执行。')) });
        return;
      }
      send({ version: 1, type: 'response', requestId: command.requestId, value: await application.createSession(command.input) });
      return;
    }
    if (command.type === 'rename_session') {
      if (!claimRequestId(command.requestId)) {
        send({ version: 1, type: 'response', requestId: command.requestId, value: fail(appError('request_duplicate', 'input', '该请求身份已使用，未重复执行。')) });
        return;
      }
      send({ version: 1, type: 'response', requestId: command.requestId, value: await application.renameSession(command.input) });
      return;
    }
    if (command.type === 'delete_session') {
      if (!claimRequestId(command.requestId)) {
        send({ version: 1, type: 'response', requestId: command.requestId, value: fail(appError('request_duplicate', 'input', '该请求身份已使用，未重复执行。')) });
        return;
      }
      send({ version: 1, type: 'response', requestId: command.requestId, value: await application.deleteSession(command.sessionId) });
      return;
    }
    if (command.type === 'list_sessions') {
      send({ version: 1, type: 'response', requestId: command.requestId, value: await application.listSessions(command.input) });
      return;
    }
    if (command.type === 'query_session') {
      send({ version: 1, type: 'response', requestId: command.requestId, value: await application.querySession(command.sessionId) });
      return;
    }
    if (command.type === 'list_session_runs') {
      send({ version: 1, type: 'response', requestId: command.requestId, value: await application.listSessionRuns(command.input) });
      return;
    }
    if (command.type === 'query_prompt_trace') {
      send({ version: 1, type: 'response', requestId: command.requestId, value: await application.queryPromptTrace(command.runId, command.callSequence) });
      return;
    }
    if (command.type === 'cancel_run') {
      send({ version: 1, type: 'response', requestId: command.requestId, value: await application.cancelRun(command.runId) });
      return;
    }
    if (command.type === 'query_runtime_state') {
      send({ version: 1, type: 'response', requestId: command.requestId, value: await application.queryRuntimeState() });
      return;
    }
    if (command.type === 'cancel_provider') {
      const target = active.get(command.targetRequestId);
      if (target && !target.controller.signal.aborted) target.controller.abort();
      send({ version: 1, type: 'response', requestId: command.requestId, value: ok({ accepted: Boolean(target), runId: target?.runId ?? null }) });
      return;
    }
    if (command.type === 'close') {
      const report = await application.close();
      send({ version: 1, type: 'response', requestId: command.requestId, value: report });
      if (report.ok && report.data.closed) {
        send({ version: 1, type: 'event', event: { type: 'host_state', state: { ...state(), ready: false, host: 'closing' } } });
        setTimeout(() => process.exit(0), 30);
      }
      return;
    }
    if (command.type === 'start_run') {
      if (!claimRequestId(command.requestId)) {
        send({ version: 1, type: 'response', requestId: command.requestId, value: fail(appError('request_duplicate', 'input', '该请求身份已使用，未重复执行。')) });
        return;
      }
      const profile = currentSettings.models.find((model) => model.id === command.input.modelId);
      if (currentSettings.revision !== command.expectedSettingsRevision || profile && profile.credentialRef !== command.expectedCredentialRef) {
        send({ version: 1, type: 'response', requestId: command.requestId, value: fail(appError('state_conflict', 'input', '模型配置已变化，请重新加载后再发送。', true)) });
        return;
      }
      if (!profile) {
        send({ version: 1, type: 'response', requestId: command.requestId, value: fail(appError('model_not_configured', 'input', '所选模型配置不存在。')) });
        return;
      }
      if (profile.kind === 'legacy') {
        send({ version: 1, type: 'response', requestId: command.requestId,
          value: fail(appError('model_reconfiguration_required', 'input', 'Choose this model again from the Pi catalog or configure it as custom.')) });
        return;
      }
      const providerId = profile.kind === 'catalog' ? profile.providerId! : `flowmate-profile-${profile.id}`;
      const config = {
        version: 1 as const,
        name: `desktop-${profile.name}`,
        revision: Math.max(1, currentSettings.revision),
        modelRef: { provider: providerId, model: profile.model },
        credentialRef: profile.credentialRef,
        native: { authPath: authFile, modelsPath: null },
        ...(profile.kind === 'custom' ? { connection: { baseUrl: profile.baseUrl, api: profile.api,
          contextWindow: profile.contextWindow!, maxTokens: profile.maxTokens!, reasoning: profile.reasoning } } : {}),
        parameters: { maxRetries: 0, maxRetryDelayMs: 2000 },
      };
      const normalized = normalizeAgentRunRequest({
        sessionId: command.input.sessionId,
        text: command.input.text,
        config,
        workspace: command.input.workspace,
        goalMode: command.input.goalMode,
        ...(command.input.timeoutMs === undefined ? {} : { timeoutMs: command.input.timeoutMs }),
      });
      if (!normalized.ok) {
        send({ version: 1, type: 'response', requestId: command.requestId, value: normalized });
        return;
      }
      let accepted;
      try {
        accepted = await application.startRun(normalized.data, { onEvent(event) {
          send({ version: 1, type: 'event', event: { type: 'agent_run_event', requestId: command.requestId, value: event } });
        } });
      } catch {
        send({ version: 1, type: 'response', requestId: command.requestId, value: fail(appError('host_command_failed', 'runtime', 'Agent Run 未能提交。', true)) });
        return;
      }
      if (!accepted.ok) {
        send({ version: 1, type: 'response', requestId: command.requestId, value: accepted });
        return;
      }
      send({ version: 1, type: 'response', requestId: command.requestId, value: ok({ ...accepted.data, requestId: command.requestId }) });
      return;
    }
    if (command.type === 'call_provider') {
      if (!claimRequestId(command.requestId)) {
        send({ version: 1, type: 'response', requestId: command.requestId, value: fail(appError('request_duplicate', 'input', '该请求身份已使用，未重复执行。')) });
        return;
      }
      const profile = currentSettings.models.find((model) => model.id === command.input.modelId);
      if (!profile) {
        send({ version: 1, type: 'response', requestId: command.requestId, value: fail(appError('model_not_configured', 'input', '所选模型配置不存在。')) });
        return;
      }
      if (profile.kind === 'legacy') {
        send({ version: 1, type: 'response', requestId: command.requestId,
          value: fail(appError('model_reconfiguration_required', 'input', 'Choose this model again from the Pi catalog or configure it as custom.')) });
        return;
      }
      const providerId = profile.kind === 'catalog' ? profile.providerId! : `flowmate-profile-${profile.id}`;
      const config = {
        version: 1 as const,
        name: `desktop-${profile.name}`,
        revision: Math.max(1, currentSettings.revision),
        modelRef: { provider: providerId, model: profile.model },
        credentialRef: profile.credentialRef,
        native: { authPath: authFile, modelsPath: null },
        ...(profile.kind === 'custom' ? { connection: { baseUrl: profile.baseUrl, api: profile.api,
          contextWindow: profile.contextWindow!, maxTokens: profile.maxTokens!, reasoning: profile.reasoning } } : {}),
        parameters: {
          maxRetries: 0,
          maxRetryDelayMs: 2000,
        },
      };
      const normalized = normalizeProviderRequest({
        goal: command.input.goal,
        text: command.input.text,
        config,
        ...(command.input.timeoutMs === undefined ? {} : { timeoutMs: command.input.timeoutMs }),
      });
      if (!normalized.ok) {
        send({ version: 1, type: 'response', requestId: command.requestId, value: normalized });
        return;
      }
      const controller = new AbortController();
      const current = { controller, runId: null as number | null };
      active.set(command.requestId, current);
      let accepted = false;
      const result = await application.callProvider(normalized.data, {
        signal: controller.signal,
        onObservation(event) {
          if (event.type === 'run_created') {
            current.runId = event.runId;
            accepted = true;
            send({ version: 1, type: 'response', requestId: command.requestId, value: ok({ accepted: true, requestId: command.requestId, runId: event.runId }) });
          }
          send({ version: 1, type: 'event', event: {
            type: 'provider_observation', requestId: command.requestId, runId: event.runId,
            sequence: event.sequence, observation: event.type, at: event.at, data: event.data,
          } });
        },
      });
      active.delete(command.requestId);
      if (accepted && current.runId !== null) {
        send({ version: 1, type: 'event', event: { type: 'provider_finished', requestId: command.requestId, runId: current.runId, result } });
      } else if (!accepted) {
        send({ version: 1, type: 'response', requestId: command.requestId, value: result });
      }
      return;
    }
  };

  const input = createInterface({ input: process.stdin, crlfDelay: Infinity });
  input.on('line', (line) => {
    if (Buffer.byteLength(line, 'utf8') > 1_100_000) return;
    let raw: unknown;
    try { raw = JSON.parse(line) as unknown; } catch { return; }
    const command = parseHostCommand(raw);
    if (!command) return;
    void dispatch(command).catch(() => {
      send({ version: 1, type: 'response', requestId: command.requestId, value: fail(appError('host_command_failed', 'runtime', 'Host 命令处理失败。', true)) });
    });
  });
  input.on('close', () => {
    let retry: ReturnType<typeof setInterval> | undefined;
    const closeEventually = async () => {
      const report = await application.close();
      if (report.ok && report.data.closed) {
        if (retry) clearInterval(retry);
        process.exit(0);
      }
    };
    void closeEventually();
    retry = setInterval(() => { void closeEventually(); }, 500);
    retry.unref();
  });
}
