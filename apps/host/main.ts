import { mkdir, open, readFile, writeFile } from 'node:fs/promises';
import { dirname, isAbsolute, join } from 'node:path';
import { createInterface } from 'node:readline';
import { appError, fail, normalizeProviderRequest, ok } from '@flowmate/contracts';
import type { Application, DesktopState, ProductSettings } from '@flowmate/contracts';
import { defaultProductSettings, readProductSettings, saveProductSettings } from '@flowmate/core';
import { PiProviderAdapter } from '@flowmate/runtime-pi';
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
  const active = new Map<string, { controller: AbortController; runId: number | null }>();
  const recentlySeen = new Set<string>();
  const seenOrder: string[] = [];
  let application: Application;
  const created = await createApplication({
    paths,
    provider: new PiProviderAdapter({ runtimeApiKeyFor: (config) => activeKeys.get(config.modelRef.provider) }),
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
    if (command.type === 'call_provider') {
      if (recentlySeen.has(command.requestId)) {
        send({ version: 1, type: 'response', requestId: command.requestId, value: fail(appError('request_duplicate', 'input', '该请求身份已使用，未重复执行。')) });
        return;
      }
      recentlySeen.add(command.requestId);
      seenOrder.push(command.requestId);
      if (seenOrder.length > 4096) recentlySeen.delete(seenOrder.shift()!);
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
