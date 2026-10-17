import { readFileSync } from 'node:fs';
import { dirname, isAbsolute, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { appError, fail, ok, type Result } from '@flowmate/contracts';
import { acquireProductControllerLock, resolveProductPaths, resolveRuntimeLayout } from '@flowmate/shared';
import { backupStore, verifyRestoredStore, type BackupManifest } from '../../packages/core/src/storage/maintenance.ts';

async function main(): Promise<void> {
  let operation = 'invalid', result: Result<unknown> = fail(appError('maintenance_arguments_invalid', 'input', 'Expected an explicit offline backup or verify-restore operation.'));
  let leaseRelease: Result<void> | null = null;
  try {
    const argv = process.argv.slice(2);
    const args = parseArgs({ args: argv, options: { 'user-data-root': { type: 'string' },
      destination: { type: 'string' }, backup: { type: 'string' } }, strict: true, allowPositionals: true });
    if (args.positionals.length !== 1 || !['backup', 'verify-restore'].includes(args.positionals[0]!)) throw Error();
    operation = args.positionals[0]!;
    const root = args.values['user-data-root'], destination = args.values.destination, backup = args.values.backup;
    for (const name of ['user-data-root', 'destination', 'backup'])
      if (argv.filter(arg => arg === `--${name}` || arg.startsWith(`--${name}=`)).length > 1) throw Error();
    if (!root || !isAbsolute(root) || (operation === 'backup' ? !destination || !isAbsolute(destination) || backup !== undefined
      : !backup || !isAbsolute(backup) || destination !== undefined)) throw Error();
    const paths = resolveProductPaths(root); if (!paths.ok) { result = paths; throw Error(); }
    const runtime = resolve(fileURLToPath(new URL('..', import.meta.url)));
    const layout = resolveRuntimeLayout({ isPackaged: true, appPath: join(dirname(runtime), 'app.asar'),
      resourcesPath: dirname(runtime), userDataRoot: paths.data.root });
    if (!layout.ok || !layout.data.release) { result = layout.ok ? result : layout; throw Error(); }
    const lease = await acquireProductControllerLock(paths.data);
    if (!lease.ok) { result = lease; throw Error(); }
    try {
      result = fail(appError(operation === 'backup' ? 'maintenance_backup_failed' : 'maintenance_restore_failed',
        'storage', 'Offline maintenance failed; original data was retained.', true));
      if (operation === 'backup') {
        const backed = await backupStore(paths.data, destination!);
        result = backed.ok ? ok({ directory: backed.data.directory, backupId: backed.data.manifest.backupId,
          schemaVersion: backed.data.manifest.schemaVersion, settingsVersion: backed.data.manifest.settingsVersion,
          fileCount: backed.data.manifest.files.length, gaps: backed.data.manifest.gaps.slice(0, 100), gapCount: backed.data.manifest.gaps.length }) : backed;
      } else {
        const manifest = JSON.parse(readFileSync(join(backup!, 'manifest.json'), 'utf8')) as BackupManifest;
        const verified = await verifyRestoredStore(paths.data, { directory: backup!, manifest }, layout.data.release);
        result = verified.ok ? ok({ readable: verified.data.readable, gaps: verified.data.gaps.slice(0, 100),
          gapCount: verified.data.gaps.length, runtimeValidation: 'pending' }) : verified;
      }
    } finally { leaseRelease = await lease.data.release(); }
  } catch { /* Only fixed codes and explicitly requested backup locations leave this offline process. */ }
  const output = JSON.stringify({ version: 1, operation, result, leaseRelease });
  process.stdout.write((Buffer.byteLength(output) <= 65_536 ? output : JSON.stringify({ version: 1, operation,
    result: fail(appError('maintenance_output_too_large', 'storage', 'Maintenance result exceeds the output limit.')) })) + '\n');
  if (!result.ok || leaseRelease && !leaseRelease.ok) process.exitCode = 1;
}

if (import.meta.main) await main();
