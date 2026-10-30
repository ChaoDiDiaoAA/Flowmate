import { existsSync, lstatSync, readFileSync, realpathSync } from 'node:fs';
import { basename, dirname, isAbsolute, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { z } from 'zod';
import { appError, fail, ok, type ProductPaths, type Result } from '@flowmate/contracts';
import { acquireProductControllerLock, resolveProductPaths, resolveRuntimeLayout,
  prepareServiceInstallation, publishServiceConfiguration, readDesktopServiceSelection, ServiceInstallationSchema } from '@flowmate/shared';
import { runServiceAction } from '../../packages/shared/src/service-management.ts';
import { backupStore, verifyBackupSnapshot, verifyRestoredStore, type BackupManifest, type BackupReceipt } from '../../packages/core/src/storage/maintenance.ts';
import { changeServiceRelease } from './service-release.ts';

function backupResult(receipt: BackupReceipt) {
  return ok({ directory: receipt.directory, backupId: receipt.manifest.backupId,
    schemaVersion: receipt.manifest.schemaVersion, settingsVersion: receipt.manifest.settingsVersion,
    fileCount: receipt.manifest.files.length, gaps: receipt.manifest.gaps.slice(0, 100), gapCount: receipt.manifest.gaps.length });
}

async function verifyOfflineService(paths: ProductPaths, runtimeRoot: string, releaseId: string, restoredCopy: boolean): Promise<Result<void>> {
  const file = join(paths.root, 'service-installation.json');
  if (restoredCopy && existsSync(file)) {
    try {
      const stat = lstatSync(file);
      if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 16384 || realpathSync(file) !== file) throw Error();
      const original = ServiceInstallationSchema.parse(JSON.parse(readFileSync(file, 'utf8')));
      // A copied record retains its original absolute root; verification cannot operate that installation or rebind it.
      if (original.dataRoot !== paths.root) return ok(undefined);
    } catch { return fail(appError('service_installation_invalid', 'runtime', 'The original service installation could not be verified.')); }
  }
  const selected = readDesktopServiceSelection({ dataRoot: paths.root, runtimeRoot, releaseId });
  if (!selected.ok) return selected;
  if (selected.data.kind !== 'service') return ok(undefined);
  const installation = selected.data.installation;
  const observed = await runServiceAction({ action: 'status', installationFile: file, runtimeRoot });
  if (!observed.ok) return observed;
  if (observed.data.installationId !== installation.installationId || observed.data.serviceName !== installation.serviceName
    || observed.data.observedState !== 'stopped') return fail(appError('service_stop_unconfirmed', 'runtime',
      'The original service must report Stopped before offline maintenance. Product and native stop facts remain unchanged.', true));
  return ok(undefined);
}

async function main(): Promise<void> {
  let operation = 'invalid', result: Result<unknown> = fail(appError('maintenance_arguments_invalid', 'input', 'Expected one explicit maintenance operation and its original paths.'));
  let leaseRelease: Result<void> | null = null;
  try {
    const argv = process.argv.slice(2);
    const args = parseArgs({ args: argv, options: { 'user-data-root': { type: 'string' },
      destination: { type: 'string' }, backup: { type: 'string' }, 'backup-id': { type: 'string' } }, strict: true, allowPositionals: true });
    if (args.positionals.length !== 1 || !['backup', 'verify-restore', 'verify-backup', 'prepare-service',
      'publish-service-release', 'restore-service-release'].includes(args.positionals[0]!)) throw Error();
    operation = args.positionals[0]!;
    const root = args.values['user-data-root'], destination = args.values.destination, backup = args.values.backup, backupId = args.values['backup-id'];
    for (const name of ['user-data-root', 'destination', 'backup', 'backup-id'])
      if (argv.filter(arg => arg === `--${name}` || arg.startsWith(`--${name}=`)).length > 1) throw Error();
    if (!root || !isAbsolute(root)) throw Error();
    if (operation === 'restore-service-release') {
      if (!destination || !isAbsolute(destination) || !backup || !isAbsolute(backup) || !z.string().uuid().safeParse(backupId).success) throw Error();
    } else if (operation === 'publish-service-release') {
      if (!destination || !isAbsolute(destination) || backup !== undefined || backupId !== undefined) throw Error();
    } else if (backupId !== undefined) throw Error();
    else if (operation === 'prepare-service') {
      if (destination !== undefined || backup !== undefined) throw Error();
    } else if (operation === 'backup') {
      if (!destination || !isAbsolute(destination) || backup !== undefined) throw Error();
    } else if (!backup || !isAbsolute(backup) || destination !== undefined) throw Error();
    const paths = resolveProductPaths(root); if (!paths.ok) { result = paths; throw Error(); }
    const runtime = resolve(fileURLToPath(new URL('..', import.meta.url)));
    const layout = resolveRuntimeLayout({ isPackaged: true, appPath: join(dirname(runtime), 'app.asar'),
      resourcesPath: dirname(runtime), userDataRoot: paths.data.root });
    if (!layout.ok || !layout.data.release) { result = layout.ok ? result : layout; throw Error(); }
    if (operation === 'publish-service-release' || operation === 'restore-service-release') {
      result = await changeServiceRelease({ operation, paths: paths.data, runtimeRoot: layout.data.runtimeRoot, destination: destination!,
        ...(operation === 'restore-service-release' ? { backup: { directory: backup!, backupId: backupId! } } : {}) });
    } else if (operation === 'prepare-service') {
      result = fail(appError('maintenance_service_prepare_failed', 'runtime', 'Service preparation could not be confirmed. Existing facts were retained.', true));
      const prepared = await prepareServiceInstallation({ runtimeRoot: layout.data.runtimeRoot, dataRoot: paths.data.root });
      if (!prepared.ok) result = prepared;
      else {
        const published = await publishServiceConfiguration(prepared.data);
        result = published.ok ? ok(published.data.installation) : published;
      }
    } else if (operation === 'verify-backup') {
      if (dirname(backup!) !== join(paths.data.root, 'backups') || !basename(backup!).startsWith('service-activation-')
        || !z.string().uuid().safeParse(basename(backup!).slice('service-activation-'.length)).success
        || !lstatSync(backup!).isDirectory() || lstatSync(backup!).isSymbolicLink() || realpathSync(backup!) !== backup)
        throw Error();
      result = fail(appError('maintenance_backup_failed', 'storage', 'The original backup snapshot could not be confirmed.', true));
      const verified = await verifyBackupSnapshot(backup!); result = verified.ok ? backupResult(verified.data) : verified;
    } else {
      const lease = await acquireProductControllerLock(paths.data);
      if (!lease.ok) { result = lease; throw Error(); }
      try {
        result = fail(appError(operation === 'backup' ? 'maintenance_backup_failed' : 'maintenance_restore_failed',
          'storage', 'Offline maintenance failed; original data was retained.', true));
        const stopped = await verifyOfflineService(paths.data, layout.data.runtimeRoot, layout.data.release.releaseId, operation === 'verify-restore');
        if (!stopped.ok) { result = stopped; throw Error(); }
        if (operation === 'backup') {
          const backed = await backupStore(paths.data, destination!);
          result = backed.ok ? backupResult(backed.data) : backed;
        } else {
          const manifest = JSON.parse(readFileSync(join(backup!, 'manifest.json'), 'utf8')) as BackupManifest;
          const verified = await verifyRestoredStore(paths.data, { directory: backup!, manifest }, layout.data.release);
          result = verified.ok ? ok({ readable: verified.data.readable, gaps: verified.data.gaps.slice(0, 100),
            gapCount: verified.data.gaps.length, runtimeValidation: 'pending' }) : verified;
        }
      } finally { leaseRelease = await lease.data.release(); }
    }
  } catch { /* Only fixed codes and explicitly requested backup locations leave this offline process. */ }
  const output = JSON.stringify({ version: 1, operation, result, leaseRelease });
  process.stdout.write((Buffer.byteLength(output) <= 65_536 ? output : JSON.stringify({ version: 1, operation,
    result: fail(appError('maintenance_output_too_large', 'storage', 'Maintenance result exceeds the output limit.')) })) + '\n');
  if (!result.ok || leaseRelease && !leaseRelease.ok) process.exitCode = 1;
}

if (import.meta.main) await main();
