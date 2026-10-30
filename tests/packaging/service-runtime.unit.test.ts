import { afterEach, expect, it } from 'bun:test';
import { copyFileSync, existsSync, mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { PACKAGED_REQUIRED_FILES, PackagedReleaseSchema } from '../../packages/shared/src/runtime-layout.ts';
import { buildRuntime } from '../../scripts/package.ts';
import { cleanupResources, mkdtempSync } from '../support/resources.ts';
import { readCurrentWindowsSid } from '../../packages/shared/src/windows-identity.ts';

afterEach(cleanupResources);
const serviceFiles = ['apps/service.js', 'apps/service-manager.js', 'service/FlowmateRuntime.exe', 'resources/service/FlowmateRuntime.xml',
  'licenses/winsw@2.12.0/LICENSE.txt', 'resources/prompts/invoice/prompt.md'];
function release() {
  return { version: 1, releaseId: '7fcdf7d9-c2ed-4ac9-860d-98ee69ad7ceb', productVersion: '0.1.0',
    platform: 'win32', arch: 'x64', bunVersion: '1.4.4', electronVersion: '44.4.5', sdkVersion: '1.4.0',
    pluginVersion: '0.19.0', schemaVersion: 22, settingsVersion: 7,
    service: { wrapperVersion: '2.12.0', framework: 'net461' }, files: [...PACKAGED_REQUIRED_FILES, ...serviceFiles] };
}

it('accepts one complete pinned service inventory in the existing release manifest', () => {
  expect(PackagedReleaseSchema.safeParse(release()).success).toBe(true);
});

it('rejects a supported old Bun declaration when the actual service binary is the new release', async () => {
  const api = await serviceLayout(), fixture = installation();
  writeFileSync(join(fixture.runtimeRoot, 'release.json'), JSON.stringify({ ...fixture.metadata, bunVersion: '1.4.0' }));
  expect(await api.prepareServiceInstallation(fixture)).toMatchObject({ ok: false, error: { code: 'service_bun_version_invalid' } });
  expect(existsSync(fixture.installationFile)).toBe(false); expect(existsSync(join(fixture.dataRoot, 'data/app.sqlite'))).toBe(false);
});

it('reads explicit desktop service selection without treating preparation as enablement', async () => {
  const api = await serviceLayout(), fixture = installation();
  expect(typeof api.readDesktopServiceSelection).toBe('function');
  expect(api.readDesktopServiceSelection({ dataRoot: fixture.dataRoot })).toEqual({ ok: true, data: { kind: 'legacy', installation: null } });
  const prepared = await api.prepareServiceInstallation(fixture); if (!prepared.ok) throw Error(prepared.error.code);
  expect(prepared.data).toMatchObject({ enabled: false, activationOperationId: null });
  expect(api.readDesktopServiceSelection({ dataRoot: fixture.dataRoot })).toMatchObject({ ok: true, data: { kind: 'legacy', installation: prepared.data } });
  const operationId = '72e0417b-e3bf-4fa8-a811-070d48969f15';
  writeFileSync(fixture.installationFile, JSON.stringify({ ...prepared.data, activationOperationId: operationId }));
  expect(api.readDesktopServiceSelection({ dataRoot: fixture.dataRoot })).toMatchObject({ ok: true, data: { kind: 'pending' } });
  writeFileSync(fixture.installationFile, JSON.stringify({ ...prepared.data, enabled: true, activationOperationId: operationId }));
  expect(api.readDesktopServiceSelection({ dataRoot: fixture.dataRoot, runtimeRoot: fixture.runtimeRoot, releaseId: fixture.metadata.releaseId }))
    .toMatchObject({ ok: true, data: { kind: 'service', installation: { enabled: true, activationOperationId: operationId } } });
  const node = Bun.which('node'); expect(node).not.toBeNull();
  const child = Bun.spawn([node!, '--import', 'tsx', '--input-type=module', '--eval', `
    const input=await new Response(process.stdin).json();
    const {readDesktopServiceSelection}=await import(input.module);
    process.stdout.write(JSON.stringify({bun:Boolean(process.versions.bun), selection:readDesktopServiceSelection(input.paths)}));
  `], { stdin: 'pipe', stdout: 'pipe', stderr: 'pipe', env: {} });
  child.stdin.write(JSON.stringify({ module: new URL('../../packages/shared/src/service-layout.ts', import.meta.url).href,
    paths: { dataRoot: fixture.dataRoot, runtimeRoot: fixture.runtimeRoot, releaseId: fixture.metadata.releaseId } })); child.stdin.end();
  const [stdout, stderr, code] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
  expect({ code, stderr }).toEqual({ code: 0, stderr: '' });
  expect(JSON.parse(stdout)).toMatchObject({ bun: false, selection: { ok: true, data: { kind: 'service' } } });
  expect(existsSync(join(fixture.dataRoot, 'data/app.sqlite'))).toBe(false);
});

it('blocks invalid and incompatible selected records instead of falling back to a new Host', async () => {
  const api = await serviceLayout(), fixture = installation();
  expect(typeof api.readDesktopServiceSelection).toBe('function');
  const prepared = await api.prepareServiceInstallation(fixture); if (!prepared.ok) throw Error(prepared.error.code);
  for (const value of ['{broken', JSON.stringify({ ...prepared.data, enabled: true }),
    JSON.stringify({ ...prepared.data, enabled: true, activationOperationId: '72e0417b-e3bf-4fa8-a811-070d48969f15', dataRoot: fixture.root })]) {
    writeFileSync(fixture.installationFile, value);
    expect(api.readDesktopServiceSelection({ dataRoot: fixture.dataRoot })).toMatchObject({ ok: false });
    expect(readFileSync(fixture.installationFile, 'utf8')).toBe(value);
  }
  writeFileSync(fixture.installationFile, JSON.stringify({ ...prepared.data, enabled: true, activationOperationId: '72e0417b-e3bf-4fa8-a811-070d48969f15' }));
  expect(api.readDesktopServiceSelection({ dataRoot: fixture.dataRoot, runtimeRoot: fixture.root })).toMatchObject({ ok: false });
  expect(api.readDesktopServiceSelection({ dataRoot: fixture.dataRoot, releaseId: '00000000-0000-4000-8000-000000000001' })).toMatchObject({ ok: false });
  unlinkSync(join(fixture.runtimeRoot, 'apps/service.js'));
  expect(api.readDesktopServiceSelection({ dataRoot: fixture.dataRoot })).toMatchObject({ ok: false });
  expect(existsSync(join(fixture.dataRoot, 'data/app.sqlite'))).toBe(false);
});

it('rejects incomplete or incompatible service assets while retaining older desktop-only releases', () => {
  for (const omitted of serviceFiles) {
    const value = release(); value.files = value.files.filter(path => path !== omitted);
    expect(PackagedReleaseSchema.safeParse(value).success).toBe(false);
  }
  for (const service of [{ wrapperVersion: '2.11.0', framework: 'net461' }, { wrapperVersion: '2.12.0', framework: 'net4' }])
    expect(PackagedReleaseSchema.safeParse({ ...release(), service }).success).toBe(false);
  const { service, ...older } = release();
  expect(PackagedReleaseSchema.safeParse({ ...older, files: [...PACKAGED_REQUIRED_FILES] }).success).toBe(true);
});

it('rejects a missing real service or management producer before creating runtime output', async () => {
  for (const omitted of ['apps/service/main.ts', 'scripts/service.ts']) {
  const source = mkdtempSync(join(tmpdir(), 'flowmate-service-source-'));
  for (const entry of ['apps/host/main.ts', 'agent-eval/src/desktop/worker.ts', 'apps/maintenance/main.ts', 'apps/service/main.ts', 'scripts/service.ts']) {
    if (entry === omitted) continue;
    mkdirSync(dirname(join(source, entry)), { recursive: true }); writeFileSync(join(source, entry), 'export {};');
  }
  const destination = join(source, 'flowmate-runtime');
  await expect(buildRuntime(source, destination)).rejects.toThrow('packaging_entry_missing');
  expect(existsSync(destination)).toBe(false);
  }
});

async function serviceLayout() {
  const module = await import('../../packages/shared/src/service-layout.ts').catch(() => null);
  expect(module).not.toBeNull(); if (!module) throw Error('Service layout is not implemented'); return module;
}
function installation() {
  const root = mkdtempSync(join(tmpdir(), 'flowmate-service-layout-')), runtimeRoot = join(root, 'resources/flowmate-runtime');
  const dataRoot = join(root, '用户 data & review'); mkdirSync(dataRoot);
  const metadata = release();
  for (const file of metadata.files) {
    const target = join(runtimeRoot, file); mkdirSync(dirname(target), { recursive: true });
    writeFileSync(target, file === 'sdk/package.json' ? JSON.stringify({ version: '1.4.0' }) : 'Synthetic layout prerequisite');
  }
  const repository = resolve(import.meta.dir, '../..');
  copyFileSync(process.execPath, join(runtimeRoot, 'bin/bun.exe'));
  copyFileSync(join(repository, 'resources/service/WinSW.NET461.exe'), join(runtimeRoot, 'service/FlowmateRuntime.exe'));
  copyFileSync(join(repository, 'resources/service/FlowmateRuntime.xml'), join(runtimeRoot, 'resources/service/FlowmateRuntime.xml'));
  copyFileSync(join(repository, 'licenses/winsw-2.12.0.LICENSE.txt'), join(runtimeRoot, 'licenses/winsw@2.12.0/LICENSE.txt'));
  writeFileSync(join(runtimeRoot, 'release.json'), JSON.stringify(metadata));
  return { root, runtimeRoot, dataRoot, metadata, installationFile: join(dataRoot, 'service-installation.json') };
}

it('persists one installation UUID for the actual account without creating a database or a service', async () => {
  const api = await serviceLayout(), fixture = installation(), identity = await readCurrentWindowsSid();
  expect(identity.ok).toBe(true); if (!identity.ok) throw Error(identity.error.code);
  const first = await api.prepareServiceInstallation(fixture), second = await api.prepareServiceInstallation(fixture);
  expect(first).toMatchObject({ ok: true, data: { version: 1, ownerSid: identity.data, runtimeRoot: fixture.runtimeRoot,
    dataRoot: fixture.dataRoot, releaseId: fixture.metadata.releaseId } });
  if (!first.ok) throw Error(first.error.code);
  expect(first.data.installationId).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
  expect(first.data.serviceName).toBe('FlowmateRuntime' + first.data.installationId.replaceAll('-', ''));
  expect(second).toEqual(first);
  expect(await api.readServiceInstallation(fixture)).toEqual(first);
  expect(JSON.parse(readFileSync(fixture.installationFile, 'utf8'))).toEqual(first.data);
  expect(existsSync(join(fixture.dataRoot, 'data/app.sqlite'))).toBe(false);
  expect(existsSync(join(fixture.dataRoot, 'FlowmateRuntime.exe'))).toBe(false);
  const xml = await api.renderServiceConfiguration(first.data);
  expect(xml.ok).toBe(true); if (!xml.ok) throw Error(xml.error.code);
  expect(xml.data).toContain('<id>' + first.data.serviceName + '</id>');
  expect(xml.data).toContain('--installation-file &quot;' + fixture.installationFile.replaceAll('&', '&amp;') + '&quot;');
  expect(xml.data).toContain('<domain>');
  expect(xml.data).toContain('<user>');
  expect(xml.data).not.toContain('FlowmateAccountNotConfigured');
  expect(xml.data).toContain('<delayedAutoStart>true</delayedAutoStart>');
  expect(xml.data).not.toMatch(/<password|LocalSystem|\{\{|FLOWMATE_TEST|FLOWMATE_BUN_EXECUTABLE/);
});

it('rejects missing service prerequisites and an incompatible actual WinSW executable', async () => {
  const api = await serviceLayout(), fixture = installation();
  for (const file of ['bin/bun.exe', 'service/FlowmateRuntime.exe', 'resources/service/FlowmateRuntime.xml',
    'licenses/winsw@2.12.0/LICENSE.txt', 'apps/service.js', 'apps/migrations/021_personal_agent.sql', 'resources/prompts/invoice/prompt.md']) {
    const target = join(fixture.runtimeRoot, file), held = target + '.held';
    renameSync(target, held);
    try { expect(await api.resolveServiceRuntime(fixture)).toMatchObject({ ok: false }); }
    finally { renameSync(held, target); }
  }
  const wrapper = join(fixture.runtimeRoot, 'service/FlowmateRuntime.exe'), held = wrapper + '.held';
  renameSync(wrapper, held);
  try {
    copyFileSync(process.execPath, wrapper);
    expect(await api.resolveServiceRuntime(fixture)).toMatchObject({ ok: false, error: { code: 'service_wrapper_version_invalid' } });
  } finally { unlinkSync(wrapper); renameSync(held, wrapper); }
  expect(existsSync(fixture.installationFile)).toBe(false);
});

it('preserves a saved installation when SID, name, release, or trusted paths no longer match', async () => {
  const api = await serviceLayout(), fixture = installation(), created = await api.prepareServiceInstallation(fixture);
  expect(created.ok).toBe(true); if (!created.ok) throw Error(created.error.code);
  for (const change of [{ ownerSid: 'S-1-5-18' }, { ownerSid: 'S-1-5-21-1-2-3-1001' }, { serviceName: 'OtherService' },
    { releaseId: '9a58eb41-0384-46bc-bbc1-c8b88595566c' }, { runtimeRoot: fixture.root }, { dataRoot: fixture.root },
    { password: 'must-not-enter-the-record' }]) {
    const content = JSON.stringify({ ...created.data, ...change }); writeFileSync(fixture.installationFile, content);
    expect(await api.readServiceInstallation(fixture)).toMatchObject({ ok: false });
    expect(await api.prepareServiceInstallation(fixture)).toMatchObject({ ok: false });
    expect(readFileSync(fixture.installationFile, 'utf8')).toBe(content);
  }
  expect(await api.resolveServiceRuntime({ runtimeRoot: '.', dataRoot: fixture.dataRoot })).toMatchObject({ ok: false });
  expect(await api.resolveServiceRuntime({ runtimeRoot: fixture.runtimeRoot, dataRoot: fixture.runtimeRoot })).toMatchObject({ ok: false });
});
