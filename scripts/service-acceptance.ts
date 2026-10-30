import { mkdtemp, mkdir, realpath } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { appError, fail, type Result } from '@flowmate/contracts';
import { readCurrentWindowsSid, readCurrentWindowsAccount, readCurrentWindowsElevation,
  windowsSystemDirectory } from '../packages/shared/src/windows-identity.ts';
import { prepareServiceInstallation, publishServiceConfiguration, readServiceInstallation,
  type ServiceInstallation } from '../packages/shared/src/service-layout.ts';
import { runServiceAction, type ServiceAction, type ServiceActionReport } from '../packages/shared/src/service-management.ts';

export type ServiceAcceptanceOutcome = {
  version: 1; status: 'unrun' | 'failed' | 'passed'; exitCode: 0 | 1 | 2; code: string;
  root: string | null; installationId: string | null; serviceName: string | null;
  cleanup: 'not-created' | 'not-installed' | 'uninstalled' | 'unknown';
};
const repository = fileURLToPath(new URL('..', import.meta.url));
const identityFields = ['version', 'installationId', 'serviceName', 'ownerSid', 'runtimeRoot', 'dataRoot', 'releaseId'] as const;
const unrun = (code: string): ServiceAcceptanceOutcome => ({ version: 1, status: 'unrun', exitCode: 2, code,
  root: null, installationId: null, serviceName: null, cleanup: 'not-created' });

/** This explicit entry owns one fresh temporary installation; importing it performs no action. */
export async function runServiceAcceptance(argv: readonly string[]): Promise<ServiceAcceptanceOutcome> {
  try {
    const options = { 'allow-system-service-changes': { type: 'boolean' as const }, 'account-ready': { type: 'boolean' as const } };
    const parsed = parseArgs({ args: [...argv], strict: true, allowPositionals: false, options });
    if (argv.some(value => value !== '--allow-system-service-changes' && value !== '--account-ready')
      || new Set(argv).size !== argv.length) return unrun('service_acceptance_arguments_invalid');
    if (!parsed.values['allow-system-service-changes'] || !parsed.values['account-ready'])
      return unrun('service_acceptance_authorization_required');
  } catch { return unrun('service_acceptance_arguments_invalid'); }
  if (process.platform !== 'win32' || process.arch !== 'x64' || !process.versions.bun || typeof Bun === 'undefined')
    return unrun('service_acceptance_platform_unavailable');

  let ownerSid: string, accountName: string, systemDirectory: string, node: string;
  try {
    const sid = await readCurrentWindowsSid(); if (!sid.ok) return unrun('service_acceptance_owner_unavailable');
    const [account, elevation, directory] = await Promise.all([
      readCurrentWindowsAccount(), readCurrentWindowsElevation(), windowsSystemDirectory(),
    ]);
    if (!account.ok || account.data.sid !== sid.data || ['S-1-5-18', 'S-1-5-19', 'S-1-5-20'].includes(sid.data))
      return unrun('service_acceptance_owner_unavailable');
    if (!elevation.ok || !elevation.data) return unrun('service_elevation_required');
    if (!process.stdin.isTTY || !process.stdout.isTTY) return unrun('service_interactive_console_required');
    const executable = Bun.which('node'); if (!executable) return unrun('service_acceptance_node_unavailable');
    ownerSid = sid.data; accountName = account.data.domain + '\\' + account.data.user; systemDirectory = directory; node = executable;
  } catch { return unrun('service_acceptance_owner_unavailable'); }

  let root: string | null = null, installAttempted = false;
  const owned: { installation: ServiceInstallation | null } = { installation: null };
  let cleanup: ServiceAcceptanceOutcome['cleanup'] = 'not-created', failure: string | null = null;
  const ownAction = async (action: ServiceAction): Promise<Result<ServiceActionReport>> => {
    const captured = owned.installation;
    if (!captured) return fail(appError('service_acceptance_owner_changed', 'runtime', 'The test installation owner is unavailable.'));
    try {
      const currentSid = await readCurrentWindowsSid();
      const current = await readServiceInstallation({ installationFile: join(captured.dataRoot, 'service-installation.json'), runtimeRoot: captured.runtimeRoot });
      if (!currentSid.ok || currentSid.data !== ownerSid || !current.ok
        || !identityFields.every(field => current.data[field] === captured[field]))
        return fail(appError('service_acceptance_owner_changed', 'runtime', 'The original test installation or process owner changed.'));
      return await runServiceAction({ action, installationFile: join(captured.dataRoot, 'service-installation.json'), runtimeRoot: captured.runtimeRoot });
    } catch { return fail(appError('service_acceptance_owner_changed', 'runtime', 'The original test installation could not be verified.')); }
  };
  const execute = async (): Promise<string | null> => {
    const { buildRuntime } = await import('./package.ts');
    root = await mkdtemp(join(tmpdir(), 'flowmate-service-acceptance-'));
    root = await realpath(root);
    const runtimeRoot = join(root, 'resources/flowmate-runtime'), dataRoot = join(root, 'data');
    await buildRuntime(repository, runtimeRoot); await mkdir(dataRoot);
    const prepared = await prepareServiceInstallation({ runtimeRoot, dataRoot }); if (!prepared.ok) return prepared.error.code;
    if (prepared.data.ownerSid !== ownerSid || prepared.data.runtimeRoot !== runtimeRoot || prepared.data.dataRoot !== dataRoot
      || prepared.data.enabled !== false || prepared.data.activationOperationId !== null) return 'service_acceptance_owner_changed';
    owned.installation = structuredClone(prepared.data);
    const configuration = await publishServiceConfiguration(owned.installation); if (!configuration.ok) return configuration.error.code;
    const before = await ownAction('status'); if (!before.ok) return before.error.code;
    if (before.data.observedState !== 'not-installed') return 'service_acceptance_service_exists';
    process.stderr.write('Confirm ' + accountName + ' is the intended isolated test account. Enter only this account in the official WinSW prompt; enter its password only there.\n');
    installAttempted = true;
    const installed = await ownAction('install'); if (!installed.ok) return installed.error.code;
    if (installed.data.observedState !== 'stopped') return 'service_stop_unconfirmed';
    const env: Record<string, string> = {};
    for (const key of ['PATH', 'Path', 'SystemRoot', 'SYSTEMROOT', 'COMSPEC', 'PATHEXT', 'TEMP', 'TMP', 'WINDIR', 'USERPROFILE', 'HOME', 'LOCALAPPDATA', 'APPDATA'])
      if (process.env[key]) env[key] = process.env[key]!;
    Object.assign(env, { FLOWMATE_WINDOWS_SERVICE_AUTHORIZED: '1', FLOWMATE_WINDOWS_SERVICE_ACCEPTANCE_ROOT: root,
      FLOWMATE_WINDOWS_SERVICE_INSTALLATION_FILE: join(dataRoot, 'service-installation.json'),
      FLOWMATE_WINDOWS_SERVICE_ACCEPTANCE_SID: ownerSid, FLOWMATE_WINDOWS_SERVICE_SYSTEM_DIRECTORY: systemDirectory });
    const child = Bun.spawn([node, fileURLToPath(import.meta.resolve('@playwright/test/cli')), 'test',
      '--config', resolve(repository, 'tests/service/playwright.config.ts'), '--workers=1', '--retries=0'],
    { cwd: repository, env, stdin: 'inherit', stdout: 'inherit', stderr: 'inherit' });
    const exit = await child.exited;
    return exit === 0 && child.signalCode === null ? null : 'service_acceptance_tests_failed';
  };
  try { failure = await execute(); }
  catch { failure = 'service_acceptance_failed'; }
  finally {
    if (owned.installation && installAttempted) {
      cleanup = 'unknown';
      const status = await ownAction('status');
      if (status.ok && status.data.observedState === 'not-installed') cleanup = 'not-installed';
      else if (status.ok) {
        let stopped = status.data.observedState === 'stopped';
        if (!stopped) {
          const stop = await ownAction('stop');
          stopped = stop.ok && stop.data.observedState === 'stopped' && stop.data.controllerReleased === true;
        }
        if (stopped) {
          // The existing manager checks controller release again before its fixed uninstall action.
          const removed = await ownAction('uninstall');
          if (removed.ok && removed.data.observedState === 'not-installed' && removed.data.controllerReleased === true) cleanup = 'uninstalled';
        }
      }
      if (cleanup === 'unknown' && failure === null) failure = 'service_acceptance_cleanup_unconfirmed';
    }
  }
  // SCM facts do not rewrite business receipts. Retain every temporary file, including unknown results, for inspection.
  return { version: 1, status: failure === null ? 'passed' : 'failed', exitCode: failure === null ? 0 : 1,
    code: failure ?? 'service_acceptance_completed', root, installationId: owned.installation?.installationId ?? null,
    serviceName: owned.installation?.serviceName ?? null, cleanup };
}

if (import.meta.main) {
  const result = await runServiceAcceptance(process.argv.slice(2));
  process.stdout.write(JSON.stringify(result) + '\n'); process.exitCode = result.exitCode;
}
