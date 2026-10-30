import { afterEach, expect, it, spyOn } from 'bun:test';
import { copyFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { ok } from '@flowmate/contracts';
import * as identity from '../../packages/shared/src/windows-identity.ts';
import * as layout from '../../packages/shared/src/service-layout.ts';
import { PACKAGED_REQUIRED_FILES, PACKAGED_SERVICE_FILES } from '../../packages/shared/src/runtime-layout.ts';
import { acquireProductControllerLock } from '../../packages/shared/src/controller-lock.ts';
import { resolveProductPaths } from '../../packages/shared/src/paths.ts';
import { cleanupResources, deferCleanup, mkdtempSync } from '../support/resources.ts';

const actualSpawn = Bun.spawn.bind(Bun);

afterEach(cleanupResources);
async function fixture(published = true) {
  const root = mkdtempSync(join(tmpdir(), 'flowmate-service-manager-')), runtimeRoot = join(root, 'resources/flowmate-runtime');
  const dataRoot = join(root, '原始 data & owner'); mkdirSync(dataRoot);
  const files = [...PACKAGED_REQUIRED_FILES, ...PACKAGED_SERVICE_FILES];
  for (const path of files) {
    const target = join(runtimeRoot, path); mkdirSync(dirname(target), { recursive: true });
    writeFileSync(target, path === 'sdk/package.json' ? JSON.stringify({ version: '1.4.0' }) : 'Controlled inventory prerequisite.');
  }
  const repo = resolve(import.meta.dir, '../..');
  copyFileSync(process.execPath, join(runtimeRoot, 'bin/bun.exe'));
  copyFileSync(join(repo, 'resources/service/WinSW.NET461.exe'), join(runtimeRoot, 'service/FlowmateRuntime.exe'));
  copyFileSync(join(repo, 'resources/service/FlowmateRuntime.xml'), join(runtimeRoot, 'resources/service/FlowmateRuntime.xml'));
  writeFileSync(join(runtimeRoot, 'release.json'), JSON.stringify({ version: 1,
    releaseId: '165f0598-c6b8-4e71-902e-dc64555e0e4e', productVersion: '0.1.0', platform: 'win32', arch: 'x64',
    bunVersion: '1.4.4', electronVersion: '44.4.5', sdkVersion: '1.4.0', pluginVersion: '0.19.0', schemaVersion: 21,
    settingsVersion: 7, service: { wrapperVersion: '2.12.0', framework: 'net461' }, files }));
  const saved = await layout.prepareServiceInstallation({ runtimeRoot, dataRoot }); if (!saved.ok) throw Error(saved.error.code);
  if (published) { const result = await layout.publishServiceConfiguration(saved.data); if (!result.ok) throw Error(result.error.code); }
  return { root, runtimeRoot, dataRoot, installation: saved.data, installationFile: join(dataRoot, 'service-installation.json'),
    configurationFile: join(runtimeRoot, 'service/FlowmateRuntime.xml'), wrapper: join(runtimeRoot, 'service/FlowmateRuntime.exe') };
}
type SpawnPlan = { output?: string; exitCode?: number; killed?: boolean; signalCode?: 'SIGTERM'; reject?: boolean };
function stubSpawn(plans: SpawnPlan[]) {
  const calls: Array<{ command: string[]; options: Record<string, unknown> }> = [];
  const spy = spyOn(Bun, 'spawn').mockImplementation((...args) => {
    calls.push({ command: args[0] as string[], options: args[1] as Record<string, unknown> });
    const plan = plans.shift(); if (!plan) throw Error('unexpected_wrapper_invocation');
    return { exited: plan.reject ? Promise.reject(Error('PRIVATE_WRAPPER_ERROR')) : Promise.resolve(plan.exitCode ?? 0),
      stdout: new Response(plan.output ?? '').body!, killed: plan.killed ?? false, signalCode: plan.signalCode ?? null,
      kill() {} } as ReturnType<typeof Bun.spawn>;
  });
  return { calls, spy };
}
function consoleTty(value: boolean) {
  const input = Object.getOwnPropertyDescriptor(process.stdin, 'isTTY'), output = Object.getOwnPropertyDescriptor(process.stdout, 'isTTY');
  Object.defineProperty(process.stdin, 'isTTY', { value, configurable: true });
  Object.defineProperty(process.stdout, 'isTTY', { value, configurable: true });
  return () => {
    if (input) Object.defineProperty(process.stdin, 'isTTY', input); else Reflect.deleteProperty(process.stdin, 'isTTY');
    if (output) Object.defineProperty(process.stdout, 'isTTY', output); else Reflect.deleteProperty(process.stdout, 'isTTY');
  };
}

function controlledStatus(f: Awaited<ReturnType<typeof fixture>>, script: string) {
  const children: Array<ReturnType<typeof Bun.spawn>> = [], options: Array<Record<string, unknown>> = [], exited = new Set<number>();
  const spy = spyOn(Bun, 'spawn').mockImplementation((...args) => {
    expect(args[0]).toEqual([f.wrapper, 'status']);
    const original = args[1] as Record<string, unknown>; expect(original.cwd).toBe(join(f.runtimeRoot, 'service')); options.push(original);
    // Real harmless Bun process at the fixed-command seam; never invoke WinSW or supply a fake SCM state.
    const child = actualSpawn([process.execPath, '--no-env-file', '-e', script],
      { cwd: f.root, env: {}, stdin: 'ignore', stdout: 'pipe', stderr: 'ignore' });
    children.push(child); void child.exited.then(() => { exited.add(child.pid); }, () => {}); return child as ReturnType<typeof Bun.spawn>;
  });
  deferCleanup(async () => { spy.mockRestore(); for (const child of children) {
    if (!exited.has(child.pid)) child.kill(); await child.exited.catch(() => null);
  } });
  return { children, options, exited };
}

it('accepts the real Bun 1.4 clean exit even though killed is true, using only the fixed controlled status process', async () => {
  const { runServiceAction } = await import('../../packages/shared/src/service-management.ts'), f = await fixture();
  const controlled = controlledStatus(f, 'process.stdout.write("NonExistent");');
  const result = await runServiceAction({ action: 'status', installationFile: f.installationFile, runtimeRoot: f.runtimeRoot });
  expect(controlled.children).toHaveLength(1); expect(await controlled.children[0]!.exited).toBe(0);
  expect(controlled.children[0]!.signalCode).toBeNull(); expect(controlled.children[0]!.killed).toBe(true);
  expect(result).toMatchObject({ ok: true, data: { action: 'status', observedState: 'not-installed',
    productReadyVerified: false, productStopVerified: false } });
  expect(controlled.options[0]).not.toHaveProperty('timeout');
}, 15000);

for (const output of ['oversized', 'invalid-utf8'] as const) it('reaps the actual controlled child after ' + output + ' status output fails', async () => {
  const { runServiceAction } = await import('../../packages/shared/src/service-management.ts'), f = await fixture();
  const script = output === 'oversized' ? 'process.stdout.write("X".repeat(4097));setInterval(()=>{},1000);'
    : 'const fs=require("node:fs");fs.writeSync(1,Buffer.from([255]));setInterval(()=>{},1000);';
  const controlled = controlledStatus(f, script);
  const started = Date.now();
  expect(await runServiceAction({ action: 'status', installationFile: f.installationFile, runtimeRoot: f.runtimeRoot }))
    .toMatchObject({ ok: false, error: { code: 'service_management_result_unknown' } });
  expect(Date.now() - started).toBeLessThan(5000);
  expect(controlled.children).toHaveLength(1); expect(controlled.exited.has(controlled.children[0]!.pid)).toBe(true);
}, 15000);

it('treats its own fired status watchdog as unknown and reaps the controlled process', async () => {
  const { runServiceAction } = await import('../../packages/shared/src/service-management.ts'), f = await fixture();
  const controlled = controlledStatus(f, 'process.stdout.write("NonExistent");setInterval(()=>{},1000);');
  const started = Date.now();
  expect(await runServiceAction({ action: 'status', installationFile: f.installationFile, runtimeRoot: f.runtimeRoot }))
    .toMatchObject({ ok: false, error: { code: 'service_management_result_unknown' } });
  expect(Date.now() - started).toBeGreaterThanOrEqual(10000);
  expect(controlled.options[0]).not.toHaveProperty('timeout');
  expect(controlled.children).toHaveLength(1); expect(controlled.exited.has(controlled.children[0]!.pid)).toBe(true);
}, 20000);

it('imports the fixed manager and CLI without consuming argv or launching any process', async () => {
  const argv = [...process.argv], directory = process.cwd();
  const spawn = spyOn(Bun, 'spawn').mockImplementation(() => { throw Error('test_process_launch_forbidden'); });
  try {
    const manager = await import('../../packages/shared/src/service-management.ts').catch(() => null);
    const cli = await import('../../scripts/service.ts').catch(() => null);
    expect(manager).not.toBeNull(); expect(cli).not.toBeNull();
    expect(spawn).not.toHaveBeenCalled(); expect(process.argv).toEqual(argv); expect(process.cwd()).toBe(directory);
  } finally { spawn.mockRestore(); }
});

it('status only reads the existing publication and maps the three literal WinSW states without claiming readiness or stop', async () => {
  const { runServiceAction } = await import('../../packages/shared/src/service-management.ts');
  const f = await fixture(false), missing = stubSpawn([]), publish = spyOn(layout, 'publishServiceConfiguration');
  const elevation = spyOn(identity, 'readCurrentWindowsElevation');
  try {
    expect(await runServiceAction({ ...f, action: 'status' })).toMatchObject({ ok: false });
    expect(await runServiceAction({ action: 'status', installationFile: f.installationFile, runtimeRoot: f.runtimeRoot }))
      .toMatchObject({ ok: false, error: { code: 'service_configuration_missing' } });
    expect(existsSync(f.configurationFile)).toBe(false); expect(publish).not.toHaveBeenCalled(); expect(missing.calls).toHaveLength(0);
  } finally { missing.spy.mockRestore(); publish.mockRestore(); elevation.mockRestore(); }
  const published = await layout.publishServiceConfiguration(f.installation); if (!published.ok) throw Error(published.error.code);
  const xml = readFileSync(f.configurationFile), processStub = stubSpawn([{ output: 'Started\r\n' }, { output: 'Stopped\n' }, { output: 'NonExistent\n' }]);
  const statusElevation = spyOn(identity, 'readCurrentWindowsElevation');
  try {
    for (const observedState of ['not-stopped', 'stopped', 'not-installed']) {
      expect(await runServiceAction({ action: 'status', installationFile: f.installationFile, runtimeRoot: f.runtimeRoot }))
        .toMatchObject({ ok: true, data: { action: 'status', observedState, controllerReleased: null,
          productReadyVerified: false, productStopVerified: false } });
    }
    expect(statusElevation).not.toHaveBeenCalled(); expect(readFileSync(f.configurationFile)).toEqual(xml);
    expect(existsSync(join(f.dataRoot, 'data/app.sqlite'))).toBe(false);
    expect(processStub.calls.map(call => call.command)).toEqual([[f.wrapper, 'status'], [f.wrapper, 'status'], [f.wrapper, 'status']]);
  } finally { processStub.spy.mockRestore(); statusElevation.mockRestore(); }
});

for (const action of ['install', 'start', 'stop', 'uninstall'] as const) it('constructs only the fixed ' + action + ' command and reports bounded SCM facts', async () => {
  const { runServiceAction } = await import('../../packages/shared/src/service-management.ts');
  const f = await fixture(action !== 'install'), before = action === 'install' ? null : readFileSync(f.configurationFile);
  const plans: SpawnPlan[] = [{}, { output: 'Stopped' }];
  if (action === 'start') plans[1] = { output: 'Started' };
  if (action === 'uninstall') plans.splice(0, plans.length, { output: 'Stopped' }, {}, { output: 'NonExistent' });
  const processStub = stubSpawn(plans), elevation = spyOn(identity, 'readCurrentWindowsElevation').mockResolvedValue(ok(true));
  const restoreTty = consoleTty(true), originalSecret = process.env.FLOWMATE_SERVICE_PASSWORD;
  process.env.FLOWMATE_SERVICE_PASSWORD = 'synthetic-password-must-not-be-forwarded';
  try {
    const report = await runServiceAction({ action, installationFile: f.installationFile, runtimeRoot: f.runtimeRoot });
    expect(report).toMatchObject({ ok: true, data: { action, installationId: f.installation.installationId,
      wrapperExitCode: 0, controllerReleased: action === 'stop' || action === 'uninstall' ? true : null,
      productStopVerified: false, productReadyVerified: false } });
    const expected = { install: [[f.wrapper, 'install', '/p'], [f.wrapper, 'status']],
      start: [[f.wrapper, 'start'], [f.wrapper, 'status']], stop: [[f.wrapper, 'stopwait'], [f.wrapper, 'status']],
      uninstall: [[f.wrapper, 'status'], [f.wrapper, 'uninstall'], [f.wrapper, 'status']] };
    expect(processStub.calls.map(call => call.command)).toEqual(expected[action]);
    for (const call of processStub.calls) {
      expect(call.options.cwd).toBe(join(f.runtimeRoot, 'service'));
      expect(call.options.env).not.toHaveProperty('FLOWMATE_SERVICE_PASSWORD');
      expect(JSON.stringify(call)).not.toContain('synthetic-password');
      if (call.command[1] === 'install') expect([call.options.stdin, call.options.stdout, call.options.stderr]).toEqual(['inherit', 'inherit', 'inherit']);
    }
    if (before) expect(readFileSync(f.configurationFile)).toEqual(before);
    expect(readFileSync(f.configurationFile, 'utf8')).not.toMatch(/<password>|FlowmateAccountNotConfigured/);
  } finally {
    if (originalSecret === undefined) delete process.env.FLOWMATE_SERVICE_PASSWORD; else process.env.FLOWMATE_SERVICE_PASSWORD = originalSecret;
    restoreTty(); elevation.mockRestore(); processStub.spy.mockRestore();
  }
});

it('refuses implicit elevation, noninteractive installation and arbitrary command, path, password or runner options before spawn', async () => {
  const { runServiceAction } = await import('../../packages/shared/src/service-management.ts');
  const f = await fixture(false), processStub = stubSpawn([]), elevation = spyOn(identity, 'readCurrentWindowsElevation').mockResolvedValue(ok(false));
  const restoreTty = consoleTty(false);
  try {
    for (const action of ['install', 'start', 'stop', 'uninstall']) expect(await runServiceAction({ action, installationFile: f.installationFile, runtimeRoot: f.runtimeRoot }))
      .toMatchObject({ ok: false, error: { code: 'service_elevation_required' } });
    elevation.mockResolvedValue(ok(true));
    expect(await runServiceAction({ action: 'install', installationFile: f.installationFile, runtimeRoot: f.runtimeRoot }))
      .toMatchObject({ ok: false, error: { code: 'service_interactive_console_required' } });
    for (const patch of [{ action: 'restart' }, { executable: f.wrapper }, { dataRoot: f.root }, { password: 'synthetic-secret' },
      { runner: 'arbitrary' }, { shell: 'cmd.exe' }]) expect(await runServiceAction({ action: 'status', installationFile: f.installationFile, runtimeRoot: f.runtimeRoot, ...patch }))
      .toMatchObject({ ok: false, error: { code: 'service_management_arguments_invalid' } });
    expect(await runServiceAction({ action: 'status', installationFile: f.installationFile, runtimeRoot: f.root })).toMatchObject({ ok: false });
    expect(processStub.calls).toHaveLength(0); expect(existsSync(f.configurationFile)).toBe(false);
  } finally { restoreTty(); elevation.mockRestore(); processStub.spy.mockRestore(); }
});

it('requires Stopped before uninstall and rejects a live product controller without deleting configuration or data', async () => {
  const { runServiceAction } = await import('../../packages/shared/src/service-management.ts');
  const f = await fixture(), elevation = spyOn(identity, 'readCurrentWindowsElevation').mockResolvedValue(ok(true));
  const status = stubSpawn([{ output: 'Started' }]);
  try {
    expect(await runServiceAction({ action: 'uninstall', installationFile: f.installationFile, runtimeRoot: f.runtimeRoot }))
      .toMatchObject({ ok: false, error: { code: 'service_stop_unconfirmed' } });
    expect(status.calls.map(call => call.command[1])).toEqual(['status']);
  } finally { status.spy.mockRestore(); }
  const paths = resolveProductPaths(f.dataRoot); if (!paths.ok) throw Error(paths.error.code);
  const lease = await acquireProductControllerLock(paths.data); if (!lease.ok) throw Error(lease.error.code);
  const blocked = stubSpawn([{ output: 'Stopped' }]), xml = readFileSync(f.configurationFile);
  try {
    expect(await runServiceAction({ action: 'start', installationFile: f.installationFile, runtimeRoot: f.runtimeRoot }))
      .toMatchObject({ ok: false, error: { code: 'runtime_already_owned' } });
    expect(await runServiceAction({ action: 'uninstall', installationFile: f.installationFile, runtimeRoot: f.runtimeRoot }))
      .toMatchObject({ ok: false, error: { code: 'runtime_already_owned' } });
    expect(blocked.calls.map(call => call.command[1])).toEqual(['status']); expect(readFileSync(f.configurationFile)).toEqual(xml);
  } finally { await lease.data.release(); elevation.mockRestore(); blocked.spy.mockRestore(); }
});

it('keeps malformed, failed, interrupted and lost wrapper results unknown without echoing private output', async () => {
  const { runServiceAction } = await import('../../packages/shared/src/service-management.ts');
  const f = await fixture(), processStub = stubSpawn([{ output: 'PRIVATE_PASSWORD' }, { output: 'Stopped', exitCode: 5 },
    { output: 'Stopped', killed: true, signalCode: 'SIGTERM' }, { reject: true }]);
  try {
    for (let index = 0; index < 4; index++) {
      const result = await runServiceAction({ action: 'status', installationFile: f.installationFile, runtimeRoot: f.runtimeRoot });
      expect(result.ok).toBe(false); expect(JSON.stringify(result)).not.toContain('PRIVATE_');
    }
    expect(processStub.calls).toHaveLength(4);
  } finally { processStub.spy.mockRestore(); }
});
