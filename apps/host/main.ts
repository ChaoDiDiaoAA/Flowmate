import { mkdir, open, readFile, writeFile } from 'node:fs/promises';
import { dirname, isAbsolute, join } from 'node:path';
import { createInterface } from 'node:readline';
import { appError, fail, normalizeAgentRunRequest, normalizeProviderRequest, ok } from '@flowmate/contracts';
import type { Application, DesktopState, ProductSettings } from '@flowmate/contracts';
import { defaultProductSettings, readProductSettings, saveProductSettings } from '@flowmate/core';
import { createPromptTraceBuffer } from '@flowmate/logging';
import { PiAgentAdapter, PiProviderAdapter } from '@flowmate/runtime-pi';
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

const root = startupRoot();
if (!root) {
  send({ version: 1, type: 'ready', state: { version: 1, ready: false, host: 'error', appVersion: '0.0.0', userDataPath: '' } as Omit<DesktopState, 'modelCredentials'> });
  process.exitCode = 2;
} else {
  await runHost(root);
}

async function runHost(userDataRoot: string): Promise<void> {
  const pathsResult = resolveProductPaths(userDataRoot);
  if (!pathsResult.ok) {
    send({ version: 1, type: 'ready', state: { version: 1, ready: false, host: 'error', appVersion: '0.0.0', userDataPath: userDataRoot } as Omit<DesktopState, 'modelCredentials'> });
    process.exitCode = 2;
    return;
  }
  const paths = pathsResult.data;
  const settingsFile = join(paths.root, 'data', 'settings.json');
  const authFile = join(paths.runtimeDir, 'pi-desktop', 'auth.json');
  await mkdir(dirname(authFile), { recursive: true });
  try { await readFile(authFile, 'utf8'); }
  catch {
    const handle = await open(authFile, 'wx', 0o600).catch(() => null);
    if (handle) { await handle.writeFile('{}\n', 'utf8'); await handle.close(); }
  }

  let settings = await readProductSettings(settingsFile);
  if (!settings.ok) {
    send({ version: 1, type: 'ready', state: { version: 1, ready: false, host: 'error', appVersion: '0.0.0', userDataPath: paths.root } as Omit<DesktopState, 'modelCredentials'> });
    process.exitCode = 2;
    return;
  }
  let currentSettings: ProductSettings = settings.data ?? defaultProductSettings();
  const activeKeys = new Map<string, string>();
  const agentKeyByRun = new Map<number, string>();
  const active = new Map<string, { controller: AbortController; runId: number | null }>();
  const recentlySeen = new Set<string>();
  const seenOrder: string[] = [];
  let application: Application;
  const runtimeApiKeyFor = (config: { modelRef: { provider: string } }) => activeKeys.get(config.modelRef.provider);
  const promptTrace = createPromptTraceBuffer();
  const agent = new PiAgentAdapter({ runtimeApiKeyFor, cwd: paths.runtimeDir, agentDir: paths.runtimeDir, promptTrace });
  const created = await createApplication({
    paths,
    provider: new PiProviderAdapter({ runtimeApiKeyFor }),
    agent,
    promptTrace,
  });
  if (!created.ok) {
    send({ version: 1, type: 'ready', state: { version: 1, ready: false, host: 'error', appVersion: '0.0.0', userDataPath: paths.root } as Omit<DesktopState, 'modelCredentials'> });
    process.exitCode = 2;
    return;
  }
  application = created.data;

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
    if (command.type === 'get_state') {
      send({ version: 1, type: 'response', requestId: command.requestId, value: ok(state()) });
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
    if (command.type === 'create_session') {
      if (!claimRequestId(command.requestId)) {
        send({ version: 1, type: 'response', requestId: command.requestId, value: fail(appError('request_duplicate', 'input', '该请求身份已使用，未重复执行。')) });
        return;
      }
      send({ version: 1, type: 'response', requestId: command.requestId, value: await application.createSession(command.input) });
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
      const providerId = `flowmate-profile-${profile.id}`;
      const config = {
        version: 1 as const,
        name: `desktop-${profile.name}`,
        revision: Math.max(1, currentSettings.revision),
        modelRef: { provider: providerId, model: profile.model },
        native: { authPath: authFile, modelsPath: null },
        connection: { baseUrl: profile.baseUrl, api: profile.api },
        parameters: { maxRetries: 0, maxRetryDelayMs: 2000 },
      };
      const normalized = normalizeAgentRunRequest({
        sessionId: command.input.sessionId,
        text: command.input.text,
        config,
        ...(command.input.timeoutMs === undefined ? {} : { timeoutMs: command.input.timeoutMs }),
      });
      if (!normalized.ok) {
        send({ version: 1, type: 'response', requestId: command.requestId, value: normalized });
        return;
      }
      activeKeys.set(providerId, command.apiKey);
      let accepted;
      try {
        accepted = await application.startRun(normalized.data, { onEvent(event) {
          if (event.type === 'run_progress' && event.phase === 'created') agentKeyByRun.set(event.runId, providerId);
          if (event.type === 'run_finished') {
            const key = agentKeyByRun.get(event.runId);
            if (key) activeKeys.delete(key);
            agentKeyByRun.delete(event.runId);
          }
          send({ version: 1, type: 'event', event: { type: 'agent_run_event', requestId: command.requestId, value: event } });
        } });
      } catch {
        if (![...agentKeyByRun.values()].includes(providerId)) activeKeys.delete(providerId);
        send({ version: 1, type: 'response', requestId: command.requestId, value: fail(appError('host_command_failed', 'runtime', 'Agent Run 未能提交。', true)) });
        return;
      }
      if (!accepted.ok) {
        if (![...agentKeyByRun.values()].includes(providerId)) activeKeys.delete(providerId);
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
      const providerId = `flowmate-profile-${profile.id}`;
      const config = {
        version: 1 as const,
        name: `desktop-${profile.name}`,
        revision: Math.max(1, currentSettings.revision),
        modelRef: { provider: providerId, model: profile.model },
        native: { authPath: authFile, modelsPath: null },
        connection: { baseUrl: profile.baseUrl, api: profile.api },
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
      activeKeys.set(providerId, command.apiKey);
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
      activeKeys.delete(providerId);
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
