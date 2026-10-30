import { isAbsolute, join, resolve } from 'node:path';
import { z } from 'zod';
import { appError, fail, ok, type Result } from '@flowmate/contracts';
import { readServiceInstallation, publishServiceConfiguration,
  readPublishedServiceConfiguration, type ServiceInstallation, type PublishedServiceConfiguration } from './service-layout.ts';
import { readCurrentWindowsElevation } from './windows-identity.ts';
import { acquireProductControllerLock } from './controller-lock.ts';
import { resolveProductPaths } from './paths.ts';

export const ServiceActionSchema = z.enum(['install', 'start', 'stop', 'status', 'uninstall']);
export type ServiceAction = z.infer<typeof ServiceActionSchema>;
const requestSchema = z.object({ action: ServiceActionSchema, installationFile: z.string().min(1).max(32767)
  .refine(value => isAbsolute(value) && resolve(value) === value), runtimeRoot: z.string().min(1).max(32767)
  .refine(value => isAbsolute(value) && resolve(value) === value) }).strict();
type ServiceState = 'not-installed' | 'stopped' | 'not-stopped';
export type ServiceActionReport = { installationId: string; serviceName: string; action: ServiceAction;
  wrapperExitCode: 0; observedState: ServiceState; controllerReleased: boolean | null;
  productReadyVerified: false; productStopVerified: false };
const error = (code: string, message: string) => fail(appError(code, 'runtime', message, false));

function environment(): Record<string, string> {
  const env: Record<string, string> = {};
  for (const name of ['PATH', 'Path', 'SystemRoot', 'SYSTEMROOT', 'COMSPEC', 'PATHEXT', 'TEMP', 'TMP', 'WINDIR',
    'USERPROFILE', 'HOME', 'LOCALAPPDATA', 'APPDATA']) if (process.env[name]) env[name] = process.env[name]!;
  return env;
}
async function statusText(stream: ReadableStream<Uint8Array>): Promise<string> {
  const decoder = new TextDecoder('utf-8', { fatal: true }); let bytes = 0, output = '';
  for await (const chunk of stream) {
    bytes += chunk.byteLength;
    if (bytes > 4096) throw Error('service_status_invalid');
    output += decoder.decode(chunk, { stream: true });
  }
  return (output + decoder.decode()).trim();
}

async function invoke(configuration: PublishedServiceConfiguration, command: 'install' | 'start' | 'stopwait' | 'status' | 'uninstall'):
Promise<Result<ServiceState | null>> {
  try {
    const interactive = command === 'install';
    let stdout: 'inherit' | 'pipe' | 'ignore' = 'ignore', timeout = 60_000;
    if (interactive) { stdout = 'inherit'; timeout = 300_000; }
    else if (command === 'status') { stdout = 'pipe'; timeout = 10_000; }
    const child = Bun.spawn([configuration.wrapperExecutable, command, ...(interactive ? ['/p'] : [])], {
      cwd: configuration.workingDirectory, env: environment(), stdin: interactive ? 'inherit' : 'ignore',
      stdout, stderr: interactive ? 'inherit' : 'ignore',
    });
    let deadlineFired = false;
    const terminate = () => { try { child.kill(); } catch { /* The exit observation still decides whether this process ended. */ } };
    const watchdog = setTimeout(() => { deadlineFired = true; terminate(); }, timeout);
    try {
      const [exit, output] = await Promise.all([child.exited, command === 'status' ? statusText(child.stdout as ReadableStream<Uint8Array>) : Promise.resolve(null)]);
      // Bun 1.4 on Windows reports killed=true even for an exit-0 process. Use this invocation's deadline and actual exit.
      if (deadlineFired || child.signalCode !== null || exit === null)
        return error('service_management_result_unknown', 'The wrapper result is unknown. Query its status before another management action.');
      if (exit !== 0) return error('service_management_failed', 'The wrapper did not confirm completion. Query its status before retrying.');
      if (command !== 'status') return ok(null);
      if (output === 'NonExistent') return ok('not-installed');
      if (output === 'Stopped') return ok('stopped');
      // WinSW 2.12 reports Started for every SCM state except Stopped, including pending transitions.
      if (output === 'Started') return ok('not-stopped');
      return error('service_management_result_unknown', 'The wrapper status could not be confirmed.');
    } catch {
      terminate(); await child.exited.catch(() => null);
      return error('service_management_result_unknown', 'The wrapper result is unknown. Query its status before another management action.');
    } finally { clearTimeout(watchdog); }
  } catch { return error('service_management_result_unknown', 'The wrapper result is unknown. Query its status before another management action.'); }
}

async function controllerReleased(value: ServiceInstallation): Promise<Result<void>> {
  const paths = resolveProductPaths(value.dataRoot); if (!paths.ok) return paths;
  const lease = await acquireProductControllerLock(paths.data); if (!lease.ok) return lease;
  return lease.data.release();
}

/** Fixed saved-installation management only. SCM status and controller release never prove product/native stop. */
export async function runServiceAction(raw: unknown): Promise<Result<ServiceActionReport>> {
  const request = requestSchema.safeParse(raw);
  if (!request.success) return error('service_management_arguments_invalid', 'Expected a fixed service action and its original absolute installation file.');
  const { action, installationFile, runtimeRoot } = request.data;
  const saved = await readServiceInstallation({ installationFile, runtimeRoot }); if (!saved.ok) return saved;
  if (action !== 'status') {
    const elevation = await readCurrentWindowsElevation(); if (!elevation.ok) return elevation;
    // WinSW would otherwise invoke its own UAC/runas path, including for stop and uninstall.
    if (!elevation.data) return error('service_elevation_required', 'Run this explicit management command from an elevated console. No elevation was requested.');
    if (action === 'install' && (!process.stdin.isTTY || !process.stdout.isTTY))
      return error('service_interactive_console_required', 'Install requires the official interactive console account/password prompt.');
  }
  if (action === 'start' || action === 'install') {
    const released = await controllerReleased(saved.data); if (!released.ok) return released;
  }
  const configuration = action === 'install' ? await publishServiceConfiguration(saved.data) : await readPublishedServiceConfiguration(saved.data);
  if (!configuration.ok) return configuration;
  if (configuration.data.wrapperExecutable !== join(saved.data.runtimeRoot, 'service/FlowmateRuntime.exe')
    || configuration.data.configurationFile !== join(saved.data.runtimeRoot, 'service/FlowmateRuntime.xml')
    || configuration.data.workingDirectory !== join(saved.data.runtimeRoot, 'service'))
    return error('service_configuration_invalid', 'The published wrapper configuration does not match the saved installation.');
  if (action === 'uninstall') {
    const current = await invoke(configuration.data, 'status'); if (!current.ok) return current;
    if (current.data !== 'stopped') return error('service_stop_unconfirmed', 'Uninstall requires the original service to report Stopped first.');
    const released = await controllerReleased(saved.data); if (!released.ok) return released;
  }
  const command = action === 'stop' ? 'stopwait' : action;
  const applied = await invoke(configuration.data, command); if (!applied.ok) return applied;
  const observed = action === 'status' ? applied : await invoke(configuration.data, 'status');
  if (!observed.ok) return observed;
  if (observed.data === null || action === 'start' && observed.data !== 'not-stopped'
    || action === 'stop' && observed.data !== 'stopped' || action === 'uninstall' && observed.data !== 'not-installed'
    || action === 'install' && observed.data === 'not-installed')
    return error('service_management_result_unknown', 'The requested SCM state was not confirmed. Product readiness and stop remain unverified.');
  if (action === 'stop' || action === 'uninstall') { const released = await controllerReleased(saved.data); if (!released.ok) return released; }
  return ok({ installationId: saved.data.installationId, serviceName: saved.data.serviceName, action, wrapperExitCode: 0,
    observedState: observed.data, controllerReleased: action === 'stop' || action === 'uninstall' ? true : null,
    productReadyVerified: false, productStopVerified: false });
}
