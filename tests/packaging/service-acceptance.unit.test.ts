import { afterEach, expect, it, mock, spyOn } from 'bun:test';
import * as files from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { appError, fail, ok } from '@flowmate/contracts';
import * as identity from '../../packages/shared/src/windows-identity.ts';
import * as layout from '../../packages/shared/src/service-layout.ts';
import * as management from '../../packages/shared/src/service-management.ts';
import * as packaging from '../../scripts/package.ts';
import type { ServiceInstallation } from '../../packages/shared/src/service-layout.ts';

const flags = ['--allow-system-service-changes', '--account-ready'];
const ownerSid = 'S-1-5-21-1000-1001-1002-1003';
const restorations: Array<() => void> = [];
function property(target: object, key: string, value: unknown) {
  const before = Object.getOwnPropertyDescriptor(target, key);
  Object.defineProperty(target, key, { value, configurable: true });
  restorations.push(() => { if (before) Object.defineProperty(target, key, before); else Reflect.deleteProperty(target, key); });
}
afterEach(() => { mock.restore(); for (const restore of restorations.splice(0).reverse()) restore(); });

function isolatedPorts() {
  const root = resolve(tmpdir(), 'flowmate-service-acceptance-unit'), runtimeRoot = join(root, 'resources/flowmate-runtime'), dataRoot = join(root, 'data');
  const installation: ServiceInstallation = { version: 1, installationId: '460cf30d-a05e-4a2c-b31e-2e7db6cae0ad',
    serviceName: 'FlowmateRuntime460cf30da05e4a2cb31e2e7db6cae0ad', ownerSid, runtimeRoot, dataRoot,
    releaseId: '61798baf-491e-4771-878a-d19beeb77769', enabled: false, activationOperationId: null };
  property(process.stdin, 'isTTY', true); property(process.stdout, 'isTTY', true);
  const sid = spyOn(identity, 'readCurrentWindowsSid').mockResolvedValue(ok(ownerSid));
  const account = spyOn(identity, 'readCurrentWindowsAccount').mockResolvedValue(ok({ sid: ownerSid, domain: 'TESTPC', user: 'original-owner' }));
  const elevation = spyOn(identity, 'readCurrentWindowsElevation').mockResolvedValue(ok(true));
  const systemDirectory = spyOn(identity, 'windowsSystemDirectory').mockResolvedValue('C:\\Windows\\System32');
  const temporary = spyOn(files, 'mkdtemp').mockResolvedValue(root), mkdir = spyOn(files, 'mkdir').mockResolvedValue(undefined);
  const realpath = spyOn(files, 'realpath').mockResolvedValue(root);
  const remove = spyOn(files, 'rm').mockImplementation(async () => { throw Error('Runner must retain all temporary data.'); });
  const build = spyOn(packaging, 'buildRuntime').mockResolvedValue({ version: 1, releaseId: installation.releaseId,
    productVersion: '0.1.0', platform: 'win32', arch: 'x64', bunVersion: '1.4.4', electronVersion: '44.4.5',
    sdkVersion: '1.4.0', pluginVersion: '0.19.0', schemaVersion: 21, settingsVersion: 7, files: [],
    service: { wrapperVersion: '2.12.0', framework: 'net461' } });
  const prepare = spyOn(layout, 'prepareServiceInstallation').mockResolvedValue(ok(installation));
  const publish = spyOn(layout, 'publishServiceConfiguration').mockResolvedValue(ok({ installation,
    wrapperExecutable: join(runtimeRoot, 'service/FlowmateRuntime.exe'), configurationFile: join(runtimeRoot, 'service/FlowmateRuntime.xml'),
    workingDirectory: join(runtimeRoot, 'service') }));
  const read = spyOn(layout, 'readServiceInstallation').mockImplementation(async () => ok(structuredClone(installation)));
  const actions: management.ServiceAction[] = [];
  let state: 'not-installed' | 'stopped' | 'not-stopped' = 'not-installed';
  const manager = spyOn(management, 'runServiceAction').mockImplementation(async request => {
    const parsed = request as { action: management.ServiceAction; installationFile: string; runtimeRoot: string };
    expect(parsed.installationFile).toBe(join(dataRoot, 'service-installation.json')); expect(parsed.runtimeRoot).toBe(runtimeRoot);
    actions.push(parsed.action);
    if (parsed.action === 'install') state = 'stopped';
    if (parsed.action === 'stop') state = 'stopped';
    if (parsed.action === 'uninstall') state = 'not-installed';
    return ok({ installationId: installation.installationId, serviceName: installation.serviceName, action: parsed.action,
      wrapperExitCode: 0, observedState: state, controllerReleased: parsed.action === 'stop' || parsed.action === 'uninstall' ? true : null,
      productReadyVerified: false, productStopVerified: false });
  });
  const which = spyOn(Bun, 'which').mockReturnValue(join('C:\\', 'tools/node.exe'));
  const spawn = spyOn(Bun, 'spawn').mockImplementation(() => { throw Error('Actual process launch is forbidden in runner unit tests.'); });
  const output = spyOn(process.stderr, 'write').mockReturnValue(true);
  return { root, runtimeRoot, dataRoot, installation, sid, account, elevation, systemDirectory, temporary, mkdir, realpath, remove,
    build, prepare, publish, read, manager, actions, which, spawn, output, setState(value: typeof state) { state = value; } };
}

it('imports without consuming argv, creating a temporary root or launching a process and defaults to explicit unrun', async () => {
  const f = isolatedPorts(), argv = [...process.argv], cwd = process.cwd();
  const { runServiceAcceptance } = await import('../../scripts/service-acceptance.ts');
  expect(process.argv).toEqual(argv); expect(process.cwd()).toBe(cwd);
  expect(f.temporary).not.toHaveBeenCalled(); expect(f.manager).not.toHaveBeenCalled(); expect(f.spawn).not.toHaveBeenCalled();
  expect(await runServiceAcceptance([])).toMatchObject({ version: 1, status: 'unrun', exitCode: 2,
    code: 'service_acceptance_authorization_required', root: null, installationId: null, serviceName: null, cleanup: 'not-created' });
  expect(f.sid).not.toHaveBeenCalled(); expect(f.temporary).not.toHaveBeenCalled(); expect(f.build).not.toHaveBeenCalled();
  expect(f.manager).not.toHaveBeenCalled(); expect(f.spawn).not.toHaveBeenCalled();
});

it('accepts only two single boolean flags and refuses incomplete authorization or target/password overrides before side effects', async () => {
  const f = isolatedPorts(), { runServiceAcceptance } = await import('../../scripts/service-acceptance.ts');
  for (const args of [[flags[0]!], [flags[1]!]]) expect(await runServiceAcceptance(args))
    .toMatchObject({ status: 'unrun', exitCode: 2, code: 'service_acceptance_authorization_required' });
  for (const args of [[...flags, flags[0]!], [...flags, '--installation-file', 'C:\\formal\\service-installation.json'],
    [...flags, '--root=C:\\formal'], [...flags, '--service', 'FlowmateRuntimeOther'], [...flags, '--password=synthetic-private-password'],
    [...flags, '--account-ready=false'], [...flags, '--', 'existing-service'], ['install'], ['--help']]) {
    const result = await runServiceAcceptance(args);
    expect(result).toMatchObject({ status: 'unrun', exitCode: 2, code: 'service_acceptance_arguments_invalid', root: null });
    expect(JSON.stringify(result)).not.toContain('synthetic-private-password');
  }
  expect(f.sid).not.toHaveBeenCalled(); expect(f.temporary).not.toHaveBeenCalled(); expect(f.mkdir).not.toHaveBeenCalled();
  expect(f.prepare).not.toHaveBeenCalled(); expect(f.manager).not.toHaveBeenCalled(); expect(f.spawn).not.toHaveBeenCalled();
});

it('requires Windows Bun, one actual original user, actual elevation, an interactive terminal and Node before allocating a root', async () => {
  const f = isolatedPorts(), { runServiceAcceptance } = await import('../../scripts/service-acceptance.ts');
  property(process, 'platform', 'linux');
  expect(await runServiceAcceptance(flags)).toMatchObject({ status: 'unrun', exitCode: 2, code: 'service_acceptance_platform_unavailable' });
  property(process, 'platform', 'win32'); property(process.versions, 'bun', undefined);
  expect(await runServiceAcceptance(flags)).toMatchObject({ status: 'unrun', exitCode: 2, code: 'service_acceptance_platform_unavailable' });
  property(process.versions, 'bun', Bun.version);
  f.account.mockResolvedValue(ok({ sid: ownerSid + '-9', domain: 'TESTPC', user: 'another-admin' }));
  expect(await runServiceAcceptance(flags)).toMatchObject({ status: 'unrun', exitCode: 2, code: 'service_acceptance_owner_unavailable' });
  f.account.mockResolvedValue(ok({ sid: ownerSid, domain: 'TESTPC', user: 'original-owner' })); f.elevation.mockResolvedValue(ok(false));
  expect(await runServiceAcceptance(flags)).toMatchObject({ status: 'unrun', exitCode: 2, code: 'service_elevation_required' });
  f.elevation.mockResolvedValue(ok(true)); property(process.stdout, 'isTTY', false);
  expect(await runServiceAcceptance(flags)).toMatchObject({ status: 'unrun', exitCode: 2, code: 'service_interactive_console_required' });
  property(process.stdout, 'isTTY', true); f.which.mockReturnValue(null);
  expect(await runServiceAcceptance(flags)).toMatchObject({ status: 'unrun', exitCode: 2, code: 'service_acceptance_node_unavailable' });
  expect(f.temporary).not.toHaveBeenCalled(); expect(f.mkdir).not.toHaveBeenCalled(); expect(f.build).not.toHaveBeenCalled();
  expect(f.manager).not.toHaveBeenCalled(); expect(f.spawn).not.toHaveBeenCalled();
});

it('runs only the dedicated Node configuration with nonsecret metadata and cleans only its own stopped service while retaining data', async () => {
  const f = isolatedPorts(), { runServiceAcceptance } = await import('../../scripts/service-acceptance.ts');
  const previous = process.env.FLOWMATE_SERVICE_PASSWORD; process.env.FLOWMATE_SERVICE_PASSWORD = 'synthetic-private-password';
  f.spawn.mockImplementation(() => { f.setState('not-stopped'); return { exited: Promise.resolve(0), killed: false, signalCode: null } as ReturnType<typeof Bun.spawn>; });
  try {
    const result = await runServiceAcceptance(flags);
    expect(result).toMatchObject({ status: 'passed', exitCode: 0, root: f.root, installationId: f.installation.installationId,
      serviceName: f.installation.serviceName, cleanup: 'uninstalled' });
    expect(f.prepare).toHaveBeenCalledWith({ runtimeRoot: f.runtimeRoot, dataRoot: f.dataRoot });
    expect(f.publish).toHaveBeenCalledWith(f.installation); expect(f.actions).toEqual(['status', 'install', 'status', 'stop', 'uninstall']);
    expect(f.spawn).toHaveBeenCalledTimes(1);
    const [args, options] = f.spawn.mock.calls[0]!;
    expect(args).toEqual([f.which.mock.results[0]!.value, expect.stringContaining('@playwright'), 'test',
      '--config', resolve(import.meta.dir, '../service/playwright.config.ts'), '--workers=1', '--retries=0']);
    expect(options).toMatchObject({ stdin: 'inherit', stdout: 'inherit', stderr: 'inherit', env: {
      FLOWMATE_WINDOWS_SERVICE_AUTHORIZED: '1', FLOWMATE_WINDOWS_SERVICE_ACCEPTANCE_ROOT: f.root,
      FLOWMATE_WINDOWS_SERVICE_INSTALLATION_FILE: join(f.dataRoot, 'service-installation.json'),
      FLOWMATE_WINDOWS_SERVICE_ACCEPTANCE_SID: ownerSid, FLOWMATE_WINDOWS_SERVICE_SYSTEM_DIRECTORY: 'C:\\Windows\\System32' } });
    expect(JSON.stringify(options)).not.toContain('synthetic-private-password');
    expect(f.output.mock.calls.map(call => String(call[0])).join('')).toContain('TESTPC\\original-owner');
    expect(f.remove).not.toHaveBeenCalled();
  } finally { if (previous === undefined) delete process.env.FLOWMATE_SERVICE_PASSWORD; else process.env.FLOWMATE_SERVICE_PASSWORD = previous; }
});

it('queries a possibly registered service after partial install failure and never turns that failure into a pass', async () => {
  const f = isolatedPorts(), { runServiceAcceptance } = await import('../../scripts/service-acceptance.ts');
  const original = f.manager.getMockImplementation()!;
  f.manager.mockImplementation(async input => {
    if ((input as { action: string }).action === 'install') {
      f.actions.push('install'); f.setState('stopped'); return fail(appError('service_management_result_unknown', 'runtime', 'Controlled lost install acknowledgement.'));
    }
    return original(input);
  });
  expect(await runServiceAcceptance(flags)).toMatchObject({ status: 'failed', exitCode: 1, code: 'service_management_result_unknown', cleanup: 'uninstalled' });
  expect(f.actions).toEqual(['status', 'install', 'status', 'uninstall']); expect(f.spawn).not.toHaveBeenCalled();
});

it('retains unknown cleanup and refuses a changed installation or changed process owner without touching another service', async () => {
  const f = isolatedPorts(), { runServiceAcceptance } = await import('../../scripts/service-acceptance.ts');
  f.spawn.mockImplementation(() => {
    f.read.mockResolvedValue(ok({ ...f.installation, ownerSid: ownerSid + '-9' }));
    return { exited: Promise.resolve(1), killed: false, signalCode: null } as ReturnType<typeof Bun.spawn>;
  });
  expect(await runServiceAcceptance(flags)).toMatchObject({ status: 'failed', exitCode: 1, cleanup: 'unknown', root: f.root });
  expect(f.actions).toEqual(['status', 'install']);
  f.read.mockResolvedValue(ok(f.installation)); f.actions.splice(0); f.setState('not-installed');
  f.spawn.mockImplementation(() => {
    f.sid.mockResolvedValue(ok(ownerSid + '-9'));
    return { exited: Promise.resolve(0), killed: false, signalCode: null } as ReturnType<typeof Bun.spawn>;
  });
  expect(await runServiceAcceptance(flags)).toMatchObject({ status: 'failed', exitCode: 1, cleanup: 'unknown' });
  expect(f.actions).toEqual(['status', 'install']);
});

it('never installs, stops or uninstalls a service that already existed before its own install attempt', async () => {
  const f = isolatedPorts(), { runServiceAcceptance } = await import('../../scripts/service-acceptance.ts');
  f.setState('stopped');
  expect(await runServiceAcceptance(flags)).toMatchObject({ status: 'failed', exitCode: 1,
    code: 'service_acceptance_service_exists', cleanup: 'not-created' });
  expect(f.actions).toEqual(['status']); expect(f.spawn).not.toHaveBeenCalled(); expect(f.remove).not.toHaveBeenCalled();
});

it('a stop result that remains unknown prevents uninstall and preserves the original test data', async () => {
  const f = isolatedPorts(), { runServiceAcceptance } = await import('../../scripts/service-acceptance.ts');
  const original = f.manager.getMockImplementation()!;
  f.manager.mockImplementation(async input => {
    if ((input as { action: string }).action === 'stop') {
      f.actions.push('stop'); return fail(appError('service_management_result_unknown', 'runtime', 'The controlled stop remains unknown.'));
    }
    return original(input);
  });
  f.spawn.mockImplementation(() => { f.setState('not-stopped'); return { exited: Promise.resolve(0), killed: false, signalCode: null } as ReturnType<typeof Bun.spawn>; });
  expect(await runServiceAcceptance(flags)).toMatchObject({ status: 'failed', exitCode: 1,
    code: 'service_acceptance_cleanup_unconfirmed', cleanup: 'unknown', root: f.root });
  expect(f.actions).toEqual(['status', 'install', 'status', 'stop']); expect(f.remove).not.toHaveBeenCalled();
});

it('retains the original created directory when its subsequent canonical read fails before any service action', async () => {
  const f = isolatedPorts(), { runServiceAcceptance } = await import('../../scripts/service-acceptance.ts');
  f.realpath.mockRejectedValue(Error('Controlled canonical read failure.'));
  expect(await runServiceAcceptance(flags)).toMatchObject({ status: 'failed', exitCode: 1,
    code: 'service_acceptance_failed', root: f.root, cleanup: 'not-created' });
  expect(f.temporary).toHaveBeenCalledTimes(1); expect(f.build).not.toHaveBeenCalled();
  expect(f.manager).not.toHaveBeenCalled(); expect(f.spawn).not.toHaveBeenCalled(); expect(f.remove).not.toHaveBeenCalled();
});

it('accepts actual normal Bun child completion even when its killed property is true, while preserving nonzero and signal rejection', async () => {
  const spawn = Bun.spawn.bind(Bun), f = isolatedPorts();
  const { runServiceAcceptance } = await import('../../scripts/service-acceptance.ts');
  let actual: ReturnType<typeof Bun.spawn> | undefined;
  f.spawn.mockImplementation(() => {
    actual = spawn([process.execPath, '--no-env-file', '-e', 'process.stdout.write("completed")'],
      { stdin: 'ignore', stdout: 'ignore', stderr: 'ignore', env: {} });
    return actual;
  });
  expect(await runServiceAcceptance(flags)).toMatchObject({ status: 'passed', exitCode: 0, cleanup: 'uninstalled' });
  expect(actual?.exitCode).toBe(0); expect(actual?.signalCode).toBeNull(); expect(actual?.killed).toBe(true);
  for (const outcome of [{ exit: 3, signal: null }, { exit: 0, signal: 'SIGTERM' as const }]) {
    f.setState('not-installed');
    f.spawn.mockImplementation(() => ({ exited: Promise.resolve(outcome.exit), killed: true, signalCode: outcome.signal }) as ReturnType<typeof Bun.spawn>);
    expect(await runServiceAcceptance(flags)).toMatchObject({ status: 'failed', exitCode: 1, code: 'service_acceptance_tests_failed' });
  }
}, 15000);
