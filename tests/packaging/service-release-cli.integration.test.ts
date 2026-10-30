import { afterAll, beforeAll, expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { cpSync, existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { join, relative } from 'node:path';
import { tmpdir } from 'node:os';
import { z } from 'zod';
import { AppErrorSchema } from '@flowmate/contracts';
import { acquireProductControllerLock, resolveProductPaths } from '../../packages/shared/src/index.ts';
import { PackagedReleaseSchema } from '../../packages/shared/src/runtime-layout.ts';
import { readPublishedServiceConfiguration, publishServiceConfiguration, ServiceInstallationSchema } from '../../packages/shared/src/service-layout.ts';
import { backupStore, verifyBackupSnapshot } from '../../packages/core/src/storage/maintenance.ts';
import { installOwnerFixture, packageOwnerFixture, removeOwnerFixture } from '../service/owner-fixture.ts';
import { deferCleanup, mkdtempSync } from '../support/resources.ts';
import type { Result } from '@flowmate/contracts';

function need<T>(result: Result<T>): T { if (!result.ok) throw Error(result.error.code + ': ' + result.error.message); return result.data; }
let inventory: Awaited<ReturnType<typeof packageOwnerFixture>>;
beforeAll(async () => { inventory = await packageOwnerFixture(); }, 90000);
afterAll(() => { if (inventory) removeOwnerFixture(inventory.root); });

async function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'flowmate-service-release-cli-'));
  const originalRuntime = join(root, 'resources/flowmate-runtime'), targetRuntime = join(root, 'next/resources/flowmate-runtime');
  cpSync(inventory.runtimeRoot, originalRuntime, { recursive: true }); cpSync(inventory.runtimeRoot, targetRuntime, { recursive: true });
  const targetRelease = { ...PackagedReleaseSchema.parse(JSON.parse(readFileSync(join(targetRuntime, 'release.json'), 'utf8'))), releaseId: randomUUID() };
  writeFileSync(join(targetRuntime, 'release.json'), JSON.stringify(targetRelease));
  const installation = { ...await installOwnerFixture(originalRuntime), activationSettingsRevision: 0 };
  deferCleanup(() => removeOwnerFixture(installation.dataRoot));
  const file = join(installation.dataRoot, 'service-installation.json'); writeFileSync(file, JSON.stringify(installation));
  const originalConfiguration = need(await publishServiceConfiguration(installation));
  const originalXml = readFileSync(originalConfiguration.configurationFile), originalRelease = readFileSync(join(originalRuntime, 'release.json'));
  const paths = need(resolveProductPaths(installation.dataRoot)), destination = join(paths.root, 'backups/before-cli-release');
  mkdirSync(join(paths.root, 'backups'), { recursive: true });
  const lease = need(await acquireProductControllerLock(paths));
  let safety: Awaited<ReturnType<typeof backupStore>>;
  try { safety = await backupStore(paths, destination); }
  finally { need(await lease.release()); }
  const backup = need(safety);
  return { root, paths, file, installation, destination, backup, originalRuntime, targetRuntime, targetRelease, originalXml, originalRelease,
    expected: { ...installation, runtimeRoot: targetRuntime, releaseId: targetRelease.releaseId } };
}

const envelopeSchema = z.object({ version: z.literal(1), operation: z.string(),
  result: z.discriminatedUnion('ok', [z.object({ ok: z.literal(true), data: z.unknown() }).strict(),
    z.object({ ok: z.literal(false), error: AppErrorSchema }).strict()]),
  leaseRelease: z.union([z.null(), z.object({ ok: z.literal(true) }).strict(), z.object({ ok: z.literal(false), error: AppErrorSchema }).strict()]),
}).strict();

async function command(f: Awaited<ReturnType<typeof fixture>>, args: readonly string[]) {
  const suffix = randomUUID(), preload = join(f.root, 'readonly-scm-' + suffix + '.ts'), journal = join(f.root, 'readonly-scm-' + suffix + '.jsonl');
  writeFileSync(journal, '');
  // Fake only the original registration reader's FFI binding. Other approved identity/version reads remain real.
  writeFileSync(preload, String.raw`import { spyOn } from 'bun:test';
import * as ffi from 'bun:ffi';
import { appendFileSync } from 'node:fs';
import { basename } from 'node:path';
const journal = ${JSON.stringify(journal)}, expected = ${JSON.stringify(f.installation.serviceName)};
const log = (type: string, detail: Record<string, unknown> = {}) => appendFileSync(journal, JSON.stringify({type,...detail})+'\n');
const forbidden = (type: string): never => { log('forbidden',{operation:type}); throw Error('Unexpected native or process operation is forbidden.'); };
spyOn(Bun,'spawn').mockImplementation(()=>forbidden('process_spawn'));
spyOn(Bun,'spawnSync').mockImplementation(()=>forbidden('process_spawn_sync'));
const actual = ffi.dlopen;
const same = (names: string[], expected: string[]) => JSON.stringify(names)===JSON.stringify([...expected].sort());
const gate = spyOn(ffi,'dlopen').mockImplementation((file,definitions)=>{
  const library=basename(String(file)).toLowerCase(), names=Object.keys(definitions).sort();
  if(names.includes('OpenSCManagerW')) {
    if(library!=='advapi32.dll'||!same(names,['OpenSCManagerW','OpenServiceW','QueryServiceConfigW','CloseServiceHandle','LookupAccountNameW','ConvertSidToStringSidA'])) forbidden('scm_binding');
    log('scm_binding');
    return {symbols:{
      OpenSCManagerW(machine: unknown,database: unknown,access: unknown){if(machine!==null||database!==null||access!==1)forbidden('manager_access');log('OpenSCManagerW',{access});return 1n;},
      OpenServiceW(manager: unknown,name: unknown,access: unknown){if(manager!==1n||!Buffer.isBuffer(name)||access!==1)forbidden('service_access');
        const serviceName=(name as Buffer).toString('utf16le').slice(0,-1);if(serviceName!==expected)forbidden('foreign_service');log('OpenServiceW',{serviceName,access});return 0n;},
      QueryServiceConfigW(){return forbidden('QueryServiceConfigW');},LookupAccountNameW(){return forbidden('LookupAccountNameW');},
      ConvertSidToStringSidA(){return forbidden('ConvertSidToStringSidA');},
      CloseServiceHandle(handle: unknown){if(handle!==1n)forbidden('foreign_handle');log('CloseServiceHandle');return 1;}
    },close(){log('scm_binding_closed');}} as ReturnType<typeof ffi.dlopen>;
  }
  if(library==='kernel32.dll'&&same(names,['GetLastError','LocalFree']))return {symbols:{
    GetLastError(){log('GetLastError',{value:1060});return 1060;},LocalFree(){return forbidden('LocalFree');}
  },close(){log('scm_kernel_closed');}} as ReturnType<typeof ffi.dlopen>;
  const allowed = library==='kernel32.dll'&&(same(names,['GetSystemDirectoryW'])||same(names,['GetCurrentProcess','GetLastError','CloseHandle','LocalFree']))
    ||library==='advapi32.dll'&&(same(names,['RegGetValueW'])||same(names,['OpenProcessToken','GetTokenInformation','ConvertSidToStringSidA','LookupAccountSidW']))
    ||library==='version.dll'&&same(names,['GetFileVersionInfoSizeW','GetFileVersionInfoW','VerQueryValueW']);
  if(!allowed)forbidden('unapproved_ffi_binding');return actual(file,definitions);
});
if(ffi.dlopen!==gate)forbidden('unbound_ffi_gate');log('ffi_gate_bound');
`);
  const env: Record<string, string> = {};
  for (const key of ['PATH', 'Path', 'SystemRoot', 'SYSTEMROOT', 'COMSPEC', 'PATHEXT', 'TEMP', 'TMP', 'WINDIR', 'USERPROFILE', 'HOME', 'LOCALAPPDATA', 'APPDATA'])
    if (process.env[key]) env[key] = process.env[key]!;
  const child = Bun.spawn([join(f.targetRuntime, 'bin/bun.exe'), '--no-env-file', '--preload', preload,
    join(f.targetRuntime, 'apps/maintenance.js'), ...args], { cwd: f.targetRuntime, env, stdin: 'ignore', stdout: 'pipe', stderr: 'pipe', timeout: 30000 });
  const [stdout, stderr, exit] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
  const lines = readFileSync(journal, 'utf8').trim();
  const calls = (lines ? lines.split(/\r?\n/) : []).map(line => z.object({ type: z.string() }).passthrough().parse(JSON.parse(line)));
  expect(calls.filter(call => call.type === 'ffi_gate_bound')).toHaveLength(1); expect(calls.some(call => call.type === 'forbidden')).toBe(false);
  expect(stderr).toBe(''); expect(child.signalCode).toBeNull();
  return { exit, output: envelopeSchema.parse(JSON.parse(stdout)), calls };
}

test('the actual target maintenance CLI publishes its own release and XML using the original complete safety backup without managing a service', async () => {
  const f = await fixture(), beforeBackups = readdirSync(join(f.paths.root, 'backups')).sort();
  const args = ['publish-service-release', '--user-data-root', f.paths.root, '--destination', f.destination];
  const first = await command(f, args); expect(first.exit).toBe(0); expect(first.output.result.ok).toBe(true);
  if (!first.output.result.ok) throw Error(first.output.result.error.code);
  const result = z.object({ operation: z.literal('publish-service-release'), installation: ServiceInstallationSchema,
    safetyBackup: z.object({ directory: z.string(), backupId: z.string().uuid() }).strict(), restoredBackupId: z.null(),
    registration: z.literal('not-installed'), productReadyVerified: z.literal(false), leaseReleased: z.literal(true) }).strict().parse(first.output.result.data);
  expect(result.installation).toEqual(f.expected); expect(result.safetyBackup).toEqual({ directory: f.destination, backupId: f.backup.manifest.backupId });
  expect(first.output).toMatchObject({ operation: 'publish-service-release', leaseRelease: null });
  const queries = first.calls.filter(call => call.type === 'OpenServiceW'); expect(queries.length).toBeGreaterThan(0);
  expect(queries.every(call => call.serviceName === f.installation.serviceName && call.access === 1)).toBe(true);
  expect(first.calls.filter(call => call.type === 'OpenSCManagerW')).toHaveLength(queries.length);
  expect(first.calls.filter(call => call.type === 'CloseServiceHandle')).toHaveLength(queries.length);
  expect(first.calls.filter(call => call.type === 'GetLastError')).toHaveLength(queries.length);
  expect(first.calls.filter(call => call.type === 'scm_binding_closed')).toHaveLength(queries.length);
  expect(first.calls.filter(call => call.type === 'scm_kernel_closed')).toHaveLength(queries.length);
  expect(first.calls.filter(call => call.type === 'GetLastError').every(call => call.value === 1060)).toBe(true);
  const published = need(await readPublishedServiceConfiguration(result.installation));
  expect(published.configurationFile).toBe(join(f.targetRuntime, 'service/FlowmateRuntime.xml'));
  expect(readFileSync(published.configurationFile, 'utf8')).toContain(join(f.targetRuntime, 'apps/service.js'));
  expect(readFileSync(published.configurationFile, 'utf8')).not.toMatch(/<password|LocalSystem|\{\{/i);
  expect(readFileSync(join(f.originalRuntime, 'service/FlowmateRuntime.xml')).equals(f.originalXml)).toBe(true);
  expect(readFileSync(join(f.originalRuntime, 'release.json')).equals(f.originalRelease)).toBe(true);
  expect(existsSync(join(f.originalRuntime, 'bin/bun.exe'))).toBe(true);
  expect(need(await verifyBackupSnapshot(f.destination)).manifest.backupId).toBe(f.backup.manifest.backupId);
  const record = readFileSync(f.file), xml = readFileSync(published.configurationFile);
  const repeat = await command(f, args); expect(repeat.exit).toBe(0); expect(repeat.output.result).toEqual(first.output.result);
  expect(readFileSync(f.file).equals(record)).toBe(true); expect(readFileSync(published.configurationFile).equals(xml)).toBe(true);
  expect(readdirSync(join(f.paths.root, 'backups')).sort()).toEqual(beforeBackups);
}, 90000);

test('the compiled release CLI rejects strict malformed and target override arguments before native service reads or publication', async () => {
  const f = await fixture(), record = readFileSync(f.file), prefix = ['publish-service-release', '--user-data-root', f.paths.root];
  const cases: string[][] = [[], ['publish-service-release'], [...prefix], [...prefix, '--destination', 'relative-backup'],
    [...prefix, '--destination', f.destination, '--destination', f.destination],
    [...prefix, '--destination', f.destination, '--runtime-root', f.originalRuntime],
    [...prefix, '--destination', f.destination, '--installation-file', f.file],
    [...prefix, '--destination', f.destination, '--backup', f.destination],
    [...prefix, '--destination', f.destination, '--backup-id', f.backup.manifest.backupId],
    [...prefix, '--destination', f.destination, '--exe', join(f.root, 'arbitrary.exe')],
    ['publish-service-release', '--user-data-root', relative(f.root, f.paths.root), '--destination', f.destination],
    [...prefix, '--destination', f.destination, 'extra']];
  for (const args of cases) {
    const result = await command(f, args); expect(result.exit).toBe(1);
    expect(result.output.result).toMatchObject({ ok: false, error: { code: 'maintenance_arguments_invalid' } });
    expect(result.calls).toEqual([{ type: 'ffi_gate_bound' }]); expect(readFileSync(f.file).equals(record)).toBe(true);
    expect(existsSync(join(f.targetRuntime, 'service/FlowmateRuntime.xml'))).toBe(false);
  }
}, 90000);
