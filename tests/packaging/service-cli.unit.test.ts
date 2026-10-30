import { afterEach, expect, it, spyOn } from 'bun:test';
import { copyFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { join, relative, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { ok } from '@flowmate/contracts';
import * as management from '../../packages/shared/src/service-management.ts';
import { ServiceInstallationSchema } from '../../packages/shared/src/service-layout.ts';
import { runServiceCli } from '../../scripts/service.ts';
import { cleanupResources, deferCleanup, mkdtempSync } from '../support/resources.ts';

afterEach(cleanupResources);
function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'flowmate-service-cli-')), runtimeRoot = join(root, 'recorded-runtime');
  const dataRoot = join(root, '原记录 data'); mkdirSync(runtimeRoot); mkdirSync(dataRoot);
  const installationId = randomUUID();
  // A schema-valid saved record is sufficient for the producer contract, never SCM proof.
  const installation = ServiceInstallationSchema.parse({ version: 1, installationId,
    serviceName: 'FlowmateRuntime' + installationId.replaceAll('-', ''), ownerSid: 'S-1-5-21-100-200-300-1001',
    runtimeRoot, dataRoot, releaseId: randomUUID(), enabled: false, activationOperationId: null });
  const installationFile = join(dataRoot, 'service-installation.json'); writeFileSync(installationFile, JSON.stringify(installation));
  return { root, runtimeRoot, dataRoot, installationFile, installation };
}
function forbidWrapper() {
  const spawn = spyOn(Bun, 'spawn').mockImplementation(() => { throw Error('The producer test must not invoke a wrapper.'); });
  const spawnSync = spyOn(Bun, 'spawnSync').mockImplementation(() => { throw Error('The producer test must not invoke a wrapper.'); });
  deferCleanup(() => { spawn.mockRestore(); spawnSync.mockRestore(); }); return { spawn, spawnSync };
}

it('rejects malformed, duplicate, executable, root override and relative CLI arguments without invoking a wrapper', async () => {
  const f = fixture(), guard = forbidWrapper(), original = readFileSync(f.installationFile);
  const otherName = join(f.dataRoot, 'arbitrary.json'); writeFileSync(otherName, original);
  const cases: string[][] = [[], ['status'], ['status', '--installation-file'],
    ['status', '--installation-file', relative(f.root, f.installationFile)],
    ['status', '--installation-file', f.installationFile, '--installation-file', f.installationFile],
    ['status', `--installation-file=${f.installationFile}`, `--installation-file=${f.installationFile}`],
    ['status', '--installation-file', f.installationFile, '--exe', join(f.root, 'arbitrary.exe')],
    ['status', '--installation-file', f.installationFile, '--runtime-root', f.root],
    ['status', '--installation-file', f.installationFile, '--root', f.root],
    ['status', 'extra', '--installation-file', f.installationFile], ['restart', '--installation-file', f.installationFile],
    ['status', '--installation-file', otherName]];
  for (const input of cases) expect(await runServiceCli(input)).toMatchObject({ ok: false, error: { code: 'service_management_arguments_invalid' } });
  expect(guard.spawn).not.toHaveBeenCalled(); expect(guard.spawnSync).not.toHaveBeenCalled();
  expect(readFileSync(f.installationFile).equals(original)).toBe(true);
  expect(existsSync(join(f.dataRoot, 'data/app.sqlite'))).toBe(false);
  expect(existsSync(join(f.runtimeRoot, 'service/FlowmateRuntime.xml'))).toBe(false);
});

it('forwards the source CLI saved-record facts exactly to runServiceAction as a producer contract only', async () => {
  const f = fixture(), guard = forbidWrapper();
  const report: management.ServiceActionReport = { installationId: f.installation.installationId, serviceName: f.installation.serviceName,
    action: 'status', wrapperExitCode: 0, observedState: 'not-installed', controllerReleased: null, productReadyVerified: false, productStopVerified: false };
  const action = spyOn(management, 'runServiceAction').mockResolvedValue(ok(report)); deferCleanup(() => action.mockRestore());
  expect(await runServiceCli(['status', '--installation-file', f.installationFile])).toEqual(ok(report));
  expect(action).toHaveBeenCalledTimes(1);
  expect(action).toHaveBeenCalledWith({ action: 'status', installationFile: f.installationFile, runtimeRoot: f.installation.runtimeRoot });
  expect(guard.spawn).not.toHaveBeenCalled(); expect(guard.spawnSync).not.toHaveBeenCalled();
  expect(existsSync(join(f.dataRoot, 'data/app.sqlite'))).toBe(false);
});

it('the actual compiled manager rejects a saved record for another runtime before wrapper invocation or configuration creation', async () => {
  const f = fixture(), managerRoot = join(f.root, 'compiled-runtime'), outdir = join(managerRoot, 'apps'); mkdirSync(outdir, { recursive: true });
  const built = await Bun.build({ entrypoints: [resolve(import.meta.dir, '../../scripts/service.ts')], outdir,
    target: 'bun', format: 'esm', naming: 'service-manager.js' });
  expect(built.success).toBe(true); const entry = join(outdir, 'service-manager.js'); expect(existsSync(entry)).toBe(true);
  const preload = join(f.root, 'forbid-wrapper.ts');
  writeFileSync(preload, `import {spyOn} from 'bun:test';
    const forbidden=()=>{process.stderr.write('unexpected_wrapper_invocation\\n');throw Error('Wrapper invocation is forbidden.');};
    spyOn(Bun,'spawn').mockImplementation(forbidden);spyOn(Bun,'spawnSync').mockImplementation(forbidden);
  `);
  const env: Record<string, string> = {};
  for (const name of ['PATH', 'Path', 'SystemRoot', 'SYSTEMROOT', 'COMSPEC', 'PATHEXT', 'TEMP', 'TMP', 'WINDIR', 'USERPROFILE', 'HOME', 'LOCALAPPDATA', 'APPDATA'])
    if (process.env[name]) env[name] = process.env[name]!;
  const original = readFileSync(f.installationFile);
  const child = Bun.spawn([process.execPath, '--no-env-file', '--preload', preload, entry, 'status', '--installation-file', f.installationFile],
    { cwd: f.root, env, stdout: 'pipe', stderr: 'pipe' });
  const [stdout, stderr, code] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
  expect({ code, stderr }).toEqual({ code: 1, stderr: '' });
  expect(JSON.parse(stdout)).toMatchObject({ version: 1, result: { ok: false, error: { code: 'service_installation_incompatible' } } });
  const renamedEntry = join(outdir, 'service-manager.old.js'); copyFileSync(entry, renamedEntry);
  const renamed = Bun.spawn([process.execPath, '--no-env-file', '--preload', preload, renamedEntry, 'status', '--installation-file', f.installationFile],
    { cwd: f.root, env, stdout: 'pipe', stderr: 'pipe' });
  const [renamedOutput, renamedError, renamedCode] = await Promise.all([new Response(renamed.stdout).text(), new Response(renamed.stderr).text(), renamed.exited]);
  expect({ code: renamedCode, stderr: renamedError }).toEqual({ code: 1, stderr: '' });
  expect(JSON.parse(renamedOutput)).toMatchObject({ version: 1, result: { ok: false, error: { code: 'service_manager_entry_invalid' } } });
  expect(readFileSync(f.installationFile).equals(original)).toBe(true);
  for (const root of [f.runtimeRoot, managerRoot]) expect(existsSync(join(root, 'service/FlowmateRuntime.xml'))).toBe(false);
  expect(existsSync(join(f.dataRoot, 'data/app.sqlite'))).toBe(false);
}, 15000);
