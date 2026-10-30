import { afterAll, expect, it, mock } from 'bun:test';
import { randomUUID } from 'node:crypto';
import * as files from 'node:fs/promises';
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import type { ProductSettings } from '@flowmate/contracts';
import { beginServiceActivation, publishServiceEnabled, readServiceActivationBackup,
  serviceActivationBackupDirectory } from '../../packages/shared/src/service-activation.ts';
import { prepareServiceInstallation, ServiceInstallationSchema } from '../../packages/shared/src/service-layout.ts';
import { HostClient } from '../../apps/desktop/main/host-client.ts';
import { mkdtempSync } from '../support/resources.ts';
import { packageOwnerFixture, removeOwnerFixture } from '../service/owner-fixture.ts';

const nativeFiles = { ...files };
let failRecordRename: string | null = null;
mock.module('node:fs/promises', () => ({ ...nativeFiles, rename: async (...paths: Parameters<typeof files.rename>) => {
  if (paths[1] === failRecordRename) throw Error('synthetic_activation_commit_failure');
  return nativeFiles.rename(...paths);
} }));
let packaged: Awaited<ReturnType<typeof packageOwnerFixture>> | undefined;
afterAll(() => { if (packaged) removeOwnerFixture(packaged.root); });
async function fixture() {
  packaged ??= await packageOwnerFixture();
  const dataRoot = mkdtempSync(join(tmpdir(), 'flowmate-service-activation-'));
  const installation = await prepareServiceInstallation({ runtimeRoot: packaged.runtimeRoot, dataRoot });
  if (!installation.ok) throw Error(installation.error.code);
  return { installation: installation.data, operationId: randomUUID(), expectedSettingsRevision: 7,
    file: join(dataRoot, 'service-installation.json') };
}

it('commits the original pending operation and revision once, then preserves terminal and conflicting facts', async () => {
  const f = await fixture(), request = { installation: f.installation, operationId: f.operationId, expectedSettingsRevision: f.expectedSettingsRevision };
  const original = readFileSync(f.file, 'utf8');
  expect((await publishServiceEnabled({ installation: f.installation, operationId: f.operationId })).ok).toBe(false);
  expect(readFileSync(f.file, 'utf8')).toBe(original);
  const pending = await beginServiceActivation(request);
  expect(pending).toMatchObject({ ok: true, data: { enabled: false, activationOperationId: f.operationId, activationSettingsRevision: 7 } });
  if (!pending.ok) throw Error(pending.error.code);
  const pendingBytes = readFileSync(f.file, 'utf8');
  expect(await beginServiceActivation(request)).toEqual(pending); expect(readFileSync(f.file, 'utf8')).toBe(pendingBytes);
  expect((await beginServiceActivation({ ...request, expectedSettingsRevision: 8 })).ok).toBe(false);
  expect((await beginServiceActivation({ ...request, operationId: randomUUID() })).ok).toBe(false);
  const committed = await publishServiceEnabled({ installation: pending.data, operationId: f.operationId });
  expect(committed).toMatchObject({ ok: true, data: { enabled: true, activationOperationId: f.operationId, activationSettingsRevision: 7 } });
  const terminal = readFileSync(f.file, 'utf8');
  expect(await publishServiceEnabled({ installation: pending.data, operationId: f.operationId })).toEqual(committed);
  expect(await beginServiceActivation(request)).toEqual(committed);
  expect((await beginServiceActivation({ ...request, operationId: randomUUID() })).ok).toBe(false);
  expect(readFileSync(f.file, 'utf8')).toBe(terminal);
}, 60_000);

it('refuses changed original identities and failed file commits without destroying the prior record', async () => {
  const f = await fixture(), original = readFileSync(f.file, 'utf8');
  const request = { installation: f.installation, operationId: f.operationId, expectedSettingsRevision: 0 };
  for (const patch of [{ releaseId: randomUUID() }, { installationId: randomUUID() }, { ownerSid: 'S-1-5-21-1-2-3-9999' }])
    expect((await beginServiceActivation({ ...request, installation: { ...f.installation, ...patch } })).ok).toBe(false);
  expect(readFileSync(f.file, 'utf8')).toBe(original);
  failRecordRename = f.file;
  try { expect((await beginServiceActivation(request)).ok).toBe(false); }
  finally { failRecordRename = null; }
  expect(readFileSync(f.file, 'utf8')).toBe(original);
  expect(readdirSync(f.installation.dataRoot).some(name => name.endsWith('.tmp'))).toBe(false);
  expect(ServiceInstallationSchema.safeParse({ ...f.installation, activationSettingsRevision: 0 }).success).toBe(false);
}, 60_000);

it('keeps activation record commits usable in Node without loading Bun native identity code', async () => {
  const f = await fixture(), node = Bun.which('node'); if (!node) throw Error('node_required');
  const child = Bun.spawn([node, '--import', 'tsx', '--input-type=module', '--eval', `
    const input=await new Response(process.stdin).json(),api=await import(input.module);
    const pending=await api.beginServiceActivation(input.request);
    const result=pending.ok?await api.publishServiceEnabled({installation:pending.data,operationId:input.request.operationId}):pending;
    process.stdout.write(JSON.stringify({node:!process.versions.bun,result}));
  `], { stdin: 'pipe', stdout: 'pipe', stderr: 'pipe', env: {} });
  child.stdin.write(JSON.stringify({ module: new URL('../../packages/shared/src/service-activation.ts', import.meta.url).href,
    request: { installation: f.installation, operationId: f.operationId, expectedSettingsRevision: 3 } })); child.stdin.end();
  const [stdout, stderr, code] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
  expect({ code, stderr }).toEqual({ code: 0, stderr: '' });
  expect(JSON.parse(stdout)).toMatchObject({ node: true, result: { ok: true, data: { enabled: true, activationSettingsRevision: 3 } } });
}, 60_000);

it('projects only the original backup manifest identity and distinguishes absent, partial and corrupt records', async () => {
  const f = await fixture(), pending = await beginServiceActivation({ installation: f.installation, operationId: f.operationId, expectedSettingsRevision: 7 });
  if (!pending.ok) throw Error(pending.error.code);
  const key = { installation: pending.data, operationId: f.operationId };
  const path = serviceActivationBackupDirectory(f.installation, f.operationId); if (!path.ok) throw Error(path.error.code);
  expect(path.data).toBe(join(f.installation.dataRoot, 'backups', 'service-activation-' + f.operationId));
  expect(await readServiceActivationBackup(key)).toEqual({ ok: true, data: null });
  mkdirSync(path.data, { recursive: true }); expect((await readServiceActivationBackup(key)).ok).toBe(false);
  const manifest = { version: 1, backupId: randomUUID(), createdAt: '2026-10-29T00:00:00.000Z', productVersion: '0.1.0',
    releaseId: f.installation.releaseId, schemaVersion: 21, settingsVersion: 7,
    files: [{ path: 'service-installation.json', byteLength: 100 }, { path: 'data/app.sqlite', byteLength: 100 }], gaps: [] };
  writeFileSync(join(path.data, 'manifest.json'), JSON.stringify(manifest));
  const snapshot = join(path.data, 'service-installation.json'), foreignId = randomUUID();
  writeFileSync(snapshot, JSON.stringify({ ...pending.data, installationId: foreignId, serviceName: 'FlowmateRuntime' + foreignId.replaceAll('-', '') }));
  expect((await readServiceActivationBackup(key)).ok).toBe(false);
  for (const patch of [{ dataRoot: packaged!.root }, { activationOperationId: randomUUID() }, { activationSettingsRevision: 8 }]) {
    writeFileSync(snapshot, JSON.stringify({ ...pending.data, ...patch })); expect((await readServiceActivationBackup(key)).ok).toBe(false);
  }
  writeFileSync(snapshot, JSON.stringify(pending.data));
  expect(await readServiceActivationBackup(key)).toEqual({ ok: true, data: { id: manifest.backupId, directory: path.data } });
  expect((await readServiceActivationBackup({ ...key, installation: { ...pending.data, activationSettingsRevision: 8 } })).ok).toBe(false);
  const enabled = await publishServiceEnabled(key); if (!enabled.ok) throw Error(enabled.error.code);
  expect(await readServiceActivationBackup({ ...key, installation: enabled.data })).toEqual({ ok: true, data: { id: manifest.backupId, directory: path.data } });
  expect(existsSync(join(path.data, 'data/app.sqlite'))).toBe(false);
  writeFileSync(join(path.data, 'manifest.json'), '{broken'); expect((await readServiceActivationBackup(key)).ok).toBe(false);
}, 60_000);

it('prepares the real installed record and XML while the original Host remains the unique live owner', async () => {
  packaged ??= await packageOwnerFixture();
  const dataRoot = mkdtempSync(join(tmpdir(), 'flowmate-service-live-prepare-')), client = new HostClient();
  const source = resolve(import.meta.dir, '../..'), invoiceSourceRoot = join(dataRoot, 'imports/invoices');
  try {
    const ready = await client.start(dataRoot, '0.1.0', packaged.runtimeRoot, invoiceSourceRoot, {
      executable: join(packaged.runtimeRoot, 'bin/bun.exe'), args: ['--no-env-file', join(packaged.runtimeRoot, 'apps/start-host.js'),
        '--user-data-root', dataRoot, '--invoice-source-root', invoiceSourceRoot] });
    expect(ready.ok).toBe(true);
    const session = await client.request({ type: 'create_session', input: { title: 'Original owner retained' } }) as { ok: true; data: { sessionId: number } };
    expect(session.ok).toBe(true); const epoch = client.connectionEpoch;
    const invoke = async (operation: string, extra: string[] = []) => {
      const child = Bun.spawn([join(packaged!.runtimeRoot, 'bin/bun.exe'), '--no-env-file', join(packaged!.runtimeRoot, 'apps/maintenance.js'),
        operation, '--user-data-root', dataRoot, ...extra], { cwd: source, stdout: 'pipe', stderr: 'pipe', env: {} });
      const [stdout, stderr, code] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
      return { code, stderr, output: JSON.parse(stdout) };
    };
    const prepared = await invoke('prepare-service');
    expect(prepared).toMatchObject({ code: 0, stderr: '', output: { version: 1, operation: 'prepare-service',
      result: { ok: true, data: { enabled: false, activationOperationId: null } }, leaseRelease: null } });
    expect(client.hasLiveProcess).toBe(true); expect(client.connectionEpoch).toBe(epoch);
    expect(await client.request({ type: 'query_session', sessionId: session.data.sessionId })).toMatchObject({ ok: true, data: { sessionId: session.data.sessionId } });
    const blocked = await invoke('backup', ['--destination', join(dataRoot, 'backups/blocked')]);
    expect(blocked).toMatchObject({ code: 1, output: { result: { ok: false, error: { code: 'runtime_already_owned' } } } });
    expect(existsSync(join(dataRoot, 'backups/blocked'))).toBe(false);
    expect(existsSync(join(packaged.runtimeRoot, 'service/FlowmateRuntime.xml'))).toBe(true);
    expect(readFileSync(join(packaged.runtimeRoot, 'service/FlowmateRuntime.xml'), 'utf8')).not.toMatch(/<password|AccountNotConfigured/);
    const base = await client.request({ type: 'get_state' }) as { ok: true; data: { settings: ProductSettings } };
    expect(await client.close()).toMatchObject({ ok: true, data: { closed: true, stopped: true } });
    const installation = ServiceInstallationSchema.parse(prepared.output.result.data), operationId = randomUUID();
    const pending = await beginServiceActivation({ installation, operationId, expectedSettingsRevision: base.data.settings.revision });
    if (!pending.ok) throw Error(pending.error.code);
    const directory = serviceActivationBackupDirectory(pending.data, operationId); if (!directory.ok) throw Error(directory.error.code);
    mkdirSync(join(dataRoot, 'backups'), { recursive: true });
    const saved = await invoke('backup', ['--destination', directory.data]);
    expect(saved).toMatchObject({ code: 0, stderr: '', output: { result: { ok: true, data: { directory: directory.data, schemaVersion: 21 } } } });
    expect(await readServiceActivationBackup({ installation: pending.data, operationId })).toEqual({ ok: true,
      data: { id: saved.output.result.data.backupId, directory: directory.data } });
    writeFileSync(join(dataRoot, 'data/settings.json'), JSON.stringify({ ...base.data.settings, revision: base.data.settings.revision + 1,
      profile: { ...base.data.settings.profile, displayName: 'Live settings after original backup' } }));
    const verified = await invoke('verify-backup', ['--backup', directory.data]);
    expect(verified).toMatchObject({ code: 0, stderr: '', output: { operation: 'verify-backup',
      result: { ok: true, data: { backupId: saved.output.result.data.backupId } }, leaseRelease: null } });
  } finally { expect(await client.close()).toMatchObject({ ok: true, data: { closed: true, stopped: true } }); }
}, 60_000);
