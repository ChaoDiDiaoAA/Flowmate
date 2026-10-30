import { afterAll, afterEach, beforeAll, expect, mock, spyOn, test } from 'bun:test';
import { Database } from 'bun:sqlite';
import { cpSync, existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { appError, fail, ok, type Result } from '@flowmate/contracts';
import { changeServiceRelease } from '../../apps/maintenance/service-release.ts';
import * as registration from '../../packages/shared/src/service-registration.ts';
import * as publication from '../../packages/shared/src/service-upgrade.ts';
import { acquireProductControllerLock, resolveProductPaths } from '../../packages/shared/src/index.ts';
import { verifyBackupSnapshot } from '../../packages/core/src/storage/maintenance.ts';
import { openDatabase } from '../../packages/core/src/storage/database.ts';
import { installOwnerFixture, packageOwnerFixture, removeOwnerFixture } from '../service/owner-fixture.ts';
import { deferCleanup, mkdtempSync } from '../support/resources.ts';

function need<T>(result: Result<T>): T { if (!result.ok) throw Error(result.error.code + ': ' + result.error.message); return result.data; }
let inventory: Awaited<ReturnType<typeof packageOwnerFixture>>;
beforeAll(async () => { inventory = await packageOwnerFixture(); }, 45000);
afterAll(() => { if (inventory) removeOwnerFixture(inventory.root); });
afterEach(() => mock.restore());

async function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'flowmate-service-release-')); deferCleanup(() => removeOwnerFixture(root));
  const originalRuntime = join(root, 'resources/flowmate-runtime'), targetRuntime = join(root, 'next/resources/flowmate-runtime');
  cpSync(inventory.runtimeRoot, originalRuntime, { recursive: true }); cpSync(inventory.runtimeRoot, targetRuntime, { recursive: true });
  const targetFile = join(targetRuntime, 'release.json'), targetRelease = { ...JSON.parse(readFileSync(targetFile, 'utf8')), releaseId: randomUUID() };
  writeFileSync(targetFile, JSON.stringify(targetRelease));
  const installation = { ...await installOwnerFixture(originalRuntime), activationSettingsRevision: 0 };
  deferCleanup(() => removeOwnerFixture(installation.dataRoot));
  const file = join(installation.dataRoot, 'service-installation.json'); writeFileSync(file, JSON.stringify(installation));
  const paths = need(resolveProductPaths(installation.dataRoot));
  const reader = spyOn(registration, 'readServiceRegistration').mockResolvedValue(ok(null));
  expect(registration.readServiceRegistration).toBe(reader);
  const ffi = await import('bun:ffi'), originalDlopen = ffi.dlopen;
  const nativeGate = spyOn(ffi, 'dlopen').mockImplementation((file, definitions) => {
    if (Object.prototype.hasOwnProperty.call(definitions, 'OpenSCManagerW')) throw Error('The engineering fixture forbids an actual SCM binding.');
    return originalDlopen(file, definitions);
  });
  expect(Object.is(ffi.dlopen, nativeGate)).toBe(true);
  const destination = join(paths.root, 'backups/before-service-release'); mkdirSync(join(paths.root, 'backups'), { recursive: true });
  const originalBackups = readdirSync(join(paths.root, 'backups'));
  const request = { operation: 'publish-service-release' as const, paths, runtimeRoot: targetRuntime, destination };
  return { root, originalRuntime, targetRuntime, targetRelease, installation, file, paths, reader, request, originalBackups };
}

test('a registered service blocks the release stage before backup or metadata writes', async () => {
  const f = await fixture(), before = readFileSync(f.file);
  f.reader.mockResolvedValue(ok({ serviceName: f.installation.serviceName,
    binaryPath: join(f.originalRuntime, 'service/FlowmateRuntime.exe'), accountName: 'controlled-owner', accountSid: f.installation.ownerSid }));
  expect(await changeServiceRelease(f.request)).toMatchObject({ ok: false, error: { code: 'service_registration_present' } });
  expect(f.reader).toHaveBeenCalledTimes(1); expect(existsSync(f.request.destination)).toBe(false);
  expect(readFileSync(f.file)).toEqual(before);
}, 30000);

test('an absent registration permits one real backup and target publication, and the same stage retains its original backup on retry', async () => {
  const f = await fixture(), originalRelease = readFileSync(join(f.originalRuntime, 'release.json'));
  const first = need(await changeServiceRelease(f.request));
  expect(first).toMatchObject({ registration: 'not-installed', productReadyVerified: false, leaseReleased: true,
    installation: { ...f.installation, runtimeRoot: f.targetRuntime, releaseId: f.targetRelease.releaseId } });
  expect(need(await verifyBackupSnapshot(first.safetyBackup.directory)).manifest.backupId).toBe(first.safetyBackup.backupId);
  expect(JSON.parse(readFileSync(join(first.safetyBackup.directory, 'service-installation.json'), 'utf8'))).toEqual(f.installation);
  expect(existsSync(join(f.targetRuntime, 'service/FlowmateRuntime.xml'))).toBe(true);
  expect(readFileSync(join(f.originalRuntime, 'release.json'))).toEqual(originalRelease);
  expect(need(await changeServiceRelease(f.request))).toEqual(first);
  expect(readdirSync(join(f.paths.root, 'backups')).sort()).toEqual([...f.originalBackups, 'before-service-release'].sort());
  expect(f.reader.mock.calls.length).toBeGreaterThanOrEqual(6);
  const lease = need(await acquireProductControllerLock(f.paths)); need(await lease.release());
}, 45000);

async function mutateAfterPublication(f: Awaited<ReturnType<typeof fixture>>) {
  const lease = need(await acquireProductControllerLock(f.paths));
  try {
    const database = new Database(f.paths.databaseFile, { readwrite: true, create: false });
    try { database.exec('CREATE TABLE release_after_backup(value TEXT); INSERT INTO release_after_backup VALUES(\'after-backup\')'); }
    finally { database.close(); }
    mkdirSync(f.paths.outputsDir, { recursive: true }); writeFileSync(join(f.paths.outputsDir, 'after-release.txt'), 'new managed output');
  } finally { need(await lease.release()); }
}

test('the retained old artifact restores the selected original data under the same authority and can finish the exact stage twice', async () => {
  const f = await fixture(), upgraded = need(await changeServiceRelease(f.request)); await mutateAfterPublication(f);
  const rollback = { operation: 'restore-service-release' as const, paths: f.paths, runtimeRoot: f.originalRuntime,
    destination: join(f.paths.root, 'backups/before-service-restore'),
    backup: { directory: upgraded.safetyBackup.directory, backupId: upgraded.safetyBackup.backupId } };
  const restored = need(await changeServiceRelease(rollback));
  expect(restored).toMatchObject({ installation: f.installation, restoredBackupId: upgraded.safetyBackup.backupId,
    productReadyVerified: false, registration: 'not-installed', leaseReleased: true });
  expect(existsSync(join(f.paths.root, 'data/service-restore.json'))).toBe(false);
  expect(existsSync(join(f.paths.outputsDir, 'after-release.txt'))).toBe(false);
  const database = new Database(f.paths.databaseFile, { readonly: true });
  try { expect(database.query("SELECT name FROM sqlite_master WHERE name='release_after_backup'").get()).toBeNull(); }
  finally { database.close(); }
  expect(need(await changeServiceRelease(rollback))).toEqual(restored);
  expect(readdirSync(join(f.paths.root, 'backups')).sort()).toEqual([...f.originalBackups, 'before-service-release', 'before-service-restore'].sort());
}, 60000);

test('a publication failure after actual data restore leaves startup blocked and the same original backup can resume', async () => {
  const f = await fixture(), upgraded = need(await changeServiceRelease(f.request)); await mutateAfterPublication(f);
  const rollback = { operation: 'restore-service-release' as const, paths: f.paths, runtimeRoot: f.originalRuntime,
    destination: join(f.paths.root, 'backups/before-service-restore'),
    backup: { directory: upgraded.safetyBackup.directory, backupId: upgraded.safetyBackup.backupId } };
  const publisher = spyOn(publication, 'publishServiceRelease').mockResolvedValueOnce(fail(appError('controlled_publication_failure', 'storage', 'Controlled publication failure.')));
  expect(await changeServiceRelease(rollback)).toMatchObject({ ok: false, error: { code: 'controlled_publication_failure' } });
  expect(existsSync(join(f.paths.root, 'data/service-restore.json'))).toBe(true);
  expect(openDatabase(f.paths)).toMatchObject({ ok: false, error: { code: 'maintenance_restore_pending' } });
  const originalSafety = need(await verifyBackupSnapshot(rollback.destination)).manifest.backupId;
  publisher.mockRestore();
  const recovered = need(await changeServiceRelease(rollback));
  expect(recovered.safetyBackup.backupId).toBe(originalSafety); expect(recovered.installation).toEqual(f.installation);
  expect(existsSync(join(f.paths.root, 'data/service-restore.json'))).toBe(false);
}, 60000);

test('a stale original safety backup cannot authorize another publication after data changes', async () => {
  const f = await fixture(), before = readFileSync(f.file);
  const publisher = spyOn(publication, 'publishServiceRelease').mockResolvedValueOnce(fail(appError('controlled_publication_failure', 'storage', 'Controlled publication failure.')));
  expect((await changeServiceRelease(f.request)).ok).toBe(false); publisher.mockRestore();
  const original = need(await verifyBackupSnapshot(f.request.destination)); await mutateAfterPublication(f);
  expect((await changeServiceRelease(f.request)).ok).toBe(false);
  expect(readFileSync(f.file)).toEqual(before);
  expect(need(await verifyBackupSnapshot(f.request.destination)).manifest.backupId).toBe(original.manifest.backupId);
}, 45000);
