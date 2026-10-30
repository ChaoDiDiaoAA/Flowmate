import { existsSync, lstatSync, readFileSync, realpathSync } from 'node:fs';
import { isDeepStrictEqual } from 'node:util';
import { isAbsolute, join, resolve } from 'node:path';
import { z } from 'zod';
import { Database } from 'bun:sqlite';
import { appError, fail, ok, type ProductPaths, type Result } from '@flowmate/contracts';
import { acquireProductControllerLock } from '../../packages/shared/src/controller-lock.ts';
import { readServiceInstallation, resolveServiceRuntime, publishServiceConfiguration, readPublishedServiceConfiguration, ServiceInstallationSchema,
  type ServiceInstallation } from '../../packages/shared/src/service-layout.ts';
import { readServiceRegistration } from '../../packages/shared/src/service-registration.ts';
import { publishServiceRelease } from '../../packages/shared/src/service-upgrade.ts';
import { backupStore, verifyBackupSnapshot, verifyServiceStoreCopy, restoreServiceStore, finishServiceRestore,
  ServiceRestoreIntentSchema, type BackupReceipt } from '../../packages/core/src/storage/maintenance.ts';
import { createRunRepository, createToolCallRepository } from '../../packages/core/src/storage/repositories.ts';

export type ServiceReleaseRequest = {
  operation: 'publish-service-release' | 'restore-service-release'; paths: ProductPaths; runtimeRoot: string;
  destination: string; backup?: { directory: string; backupId: string };
};
export type ServiceReleaseReceipt = {
  operation: ServiceReleaseRequest['operation']; installation: ServiceInstallation;
  safetyBackup: { directory: string; backupId: string }; restoredBackupId: string | null;
  registration: 'not-installed' | 'target'; productReadyVerified: false; leaseReleased: boolean;
};
const error = (code: string) => fail(appError(code, 'storage', 'The service release stage could not be confirmed. Existing backups and control facts were retained.', true));
const immutable = (value: ServiceInstallation) => ({ installationId: value.installationId, serviceName: value.serviceName,
  ownerSid: value.ownerSid, dataRoot: value.dataRoot, enabled: value.enabled,
  activationOperationId: value.activationOperationId, activationSettingsRevision: value.activationSettingsRevision });
function record(file: string): ServiceInstallation {
  const stat = lstatSync(file);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 16384 || realpathSync(file) !== file) throw Error();
  return ServiceInstallationSchema.parse(JSON.parse(readFileSync(file, 'utf8')));
}
function active(value: ServiceInstallation, root: string): boolean {
  return value.dataRoot === root && value.enabled === true && typeof value.activationOperationId === 'string'
    && typeof value.activationSettingsRevision === 'number';
}
function restoreIntent(file: string) {
  let stat: ReturnType<typeof lstatSync>;
  try { stat = lstatSync(file); }
  catch (cause) { if (cause && typeof cause === 'object' && 'code' in cause && cause.code === 'ENOENT') return null; throw cause; }
  if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 65536 || realpathSync(file) !== file) throw Error();
  return ServiceRestoreIntentSchema.parse(JSON.parse(readFileSync(file, 'utf8')));
}
function sourceInstallation(backup: BackupReceipt, original: ServiceInstallation): ServiceInstallation {
  const source = record(join(backup.directory, 'service-installation.json'));
  if (!isDeepStrictEqual(immutable(source), immutable(original))) throw Error();
  return source;
}
function confirmSnapshotStops(backup: BackupReceipt): Result<void> {
  let database: Database | undefined;
  try {
    database = new Database(join(backup.directory, 'data/app.sqlite'), { readonly: true, create: false });
    const runs = createRunRepository(database), tools = createToolCallRepository(database);
    for (const row of database.query<{ id: number }, []>('SELECT id FROM runs ORDER BY id').all()) {
      const run = runs.get(row.id);
      if (!run.ok || run.data.status === 'created' || run.data.status === 'running' || run.data.stoppedAt === null
        || run.data.cleanup.stopped !== true || run.data.cleanup.lateObservationRequired !== false)
        return error('maintenance_stop_unconfirmed');
    }
    for (const row of database.query<{ id: number }, []>('SELECT id FROM tool_calls ORDER BY id').all()) {
      const tool = tools.getById(row.id);
      if (!tool.ok || tool.data.status === 'requested' || tool.data.status === 'running' || tool.data.cleanup.stopped !== true
        || tool.data.stoppedAt === null || tool.data.cleanup.nativeProcesses?.some(process => process.stopped !== true))
        return error('maintenance_stop_unconfirmed');
      if (tool.data.runtimeObservation?.commit === 'unknown') {
        if (tool.data.effect === 'PURE' || tool.data.effect === 'READ') continue;
        if (tool.data.effect === 'LOCAL_WRITE' && tool.data.toolName === 'save_invoice_candidate') {
          const committed = tools.queryCandidateCommit({ toolCallId: tool.data.toolCallId, runId: tool.data.runId, sessionId: tool.data.sessionId });
          if (committed.ok && committed.data !== null) continue;
        }
        return error('maintenance_stop_unconfirmed');
      }
    }
    return ok(undefined);
  } catch { return error('maintenance_stop_unconfirmed'); }
  finally { database?.close(); }
}

/** Data/record/XML stage only. The operator runs the existing fixed uninstall/install/start commands separately. */
export async function changeServiceRelease(request: ServiceReleaseRequest): Promise<Result<ServiceReleaseReceipt>> {
  let release: (() => Promise<Result<void>>) | undefined;
  let result: Result<ServiceReleaseReceipt> = error('maintenance_service_release_failed');
  const stage = async (): Promise<Result<ServiceReleaseReceipt>> => {
    const { paths, runtimeRoot, destination } = request;
    if (!isAbsolute(destination) || resolve(destination) !== destination || (request.operation === 'restore-service-release') !== (request.backup !== undefined)
      || request.backup && !z.string().uuid().safeParse(request.backup.backupId).success) return error('maintenance_arguments_invalid');
    const installationFile = join(paths.root, 'service-installation.json');
    const saved = record(installationFile);
    if (!active(saved, paths.root)) return error('service_activation_incomplete');
    const checked = await readServiceInstallation({ installationFile, runtimeRoot: saved.runtimeRoot });
    if (!checked.ok) return checked;
    if (!isDeepStrictEqual(checked.data, saved)) return error('state_conflict');
    const target = await resolveServiceRuntime({ runtimeRoot, dataRoot: paths.root });
    if (!target.ok) return target;
    const targetRelease = target.data.runtime.release;
    if (!targetRelease) return error('service_assets_missing');
    const guardFile = join(paths.root, 'data/service-restore.json');
    const guard = restoreIntent(guardFile);
    if (guard && request.operation !== 'restore-service-release') return error('maintenance_restore_pending');
    let selected: BackupReceipt | null = null;
    if (request.backup) {
      const snapshot = await verifyBackupSnapshot(request.backup.directory); if (!snapshot.ok) return snapshot;
      if (snapshot.data.manifest.backupId !== request.backup.backupId) return error('maintenance_backup_invalid');
      selected = snapshot.data;
      const source = sourceInstallation(selected, saved);
      if (source.releaseId !== targetRelease.releaseId || source.runtimeRoot !== runtimeRoot) return error('maintenance_service_release_mismatch');
      if (guard && (guard.backupId !== selected.manifest.backupId || guard.backupDirectory !== selected.directory
        || guard.targetReleaseId !== targetRelease.releaseId)) return error('state_conflict');
    }
    let safety: BackupReceipt | null = null;
    if (existsSync(destination)) {
      const snapshot = await verifyBackupSnapshot(destination); if (!snapshot.ok) return snapshot;
      safety = snapshot.data;
    } else if (guard) return error('maintenance_backup_invalid');
    const original = safety ? sourceInstallation(safety, saved) : saved;
    if (guard && !isDeepStrictEqual(guard.original, original)) return error('state_conflict');
    const desired = { ...original, runtimeRoot, releaseId: targetRelease.releaseId };
    if (!isDeepStrictEqual(saved, original) && !isDeepStrictEqual(saved, desired)) return error('state_conflict');
    const registration = await readServiceRegistration(saved.serviceName); if (!registration.ok) return registration;
    if (registration.data !== null) {
      // An already-published upgrade can be queried without touching the live database; running status is a separate fact.
      if (request.operation !== 'publish-service-release' || guard || !safety || !isDeepStrictEqual(saved, desired)
        || registration.data.accountSid !== original.ownerSid
        || realpathSync(registration.data.binaryPath) !== target.data.wrapperExecutable) return error('service_registration_present');
      const configuration = await readPublishedServiceConfiguration(saved); if (!configuration.ok) return configuration;
      return ok({ operation: request.operation, installation: saved,
        safetyBackup: { directory: safety.directory, backupId: safety.manifest.backupId }, restoredBackupId: null,
        registration: 'target', productReadyVerified: false, leaseReleased: true });
    }
    const lease = await acquireProductControllerLock(paths); if (!lease.ok) return lease;
    release = () => lease.data.release();
    const locked = record(installationFile);
    if (!isDeepStrictEqual(locked, saved)) return error('state_conflict');
    const absent = await readServiceRegistration(saved.serviceName); if (!absent.ok) return absent;
    if (absent.data !== null) return error('service_registration_present');
    if (!safety) {
      const backed = await backupStore(paths, destination); if (!backed.ok) return backed;
      const verified = await verifyBackupSnapshot(backed.data.directory); if (!verified.ok) return verified;
      safety = verified.data;
      if (!isDeepStrictEqual(sourceInstallation(safety, saved), original)) return error('state_conflict');
    } else if (!guard && isDeepStrictEqual(saved, original)) {
      const matches = await verifyServiceStoreCopy(paths, safety, saved); if (!matches.ok) return matches;
    }
    if (selected) {
      // A rewind must not erase later stop uncertainty or revive an in-flight snapshot, in either runtime.
      const currentStops = confirmSnapshotStops(safety); if (!currentStops.ok) return currentStops;
      const selectedStops = confirmSnapshotStops(selected); if (!selectedStops.ok) return selectedStops;
      if (!guard && !isDeepStrictEqual(saved, original)) {
        const matches = await verifyServiceStoreCopy(paths, selected, saved); if (!matches.ok) return matches;
      } else {
        const restored = await restoreServiceStore(paths, selected, original, targetRelease); if (!restored.ok) return restored;
      }
    }
    const beforePublish = await readServiceRegistration(saved.serviceName); if (!beforePublish.ok) return beforePublish;
    if (beforePublish.data !== null) return error('service_registration_present');
    const published = await publishServiceRelease({ installationFile, original, targetRuntimeRoot: runtimeRoot });
    if (!published.ok) return published;
    const xml = await publishServiceConfiguration(published.data); if (!xml.ok) return xml;
    if (selected) {
      const finished = await finishServiceRestore(paths, selected, published.data, targetRelease); if (!finished.ok) return finished;
    }
    return ok({ operation: request.operation, installation: published.data,
      safetyBackup: { directory: safety.directory, backupId: safety.manifest.backupId }, restoredBackupId: selected?.manifest.backupId ?? null,
      registration: 'not-installed', productReadyVerified: false, leaseReleased: false });
  };
  try { result = await stage(); }
  catch { result = error('maintenance_service_release_failed'); }
  finally {
    if (release) {
      const released = await release();
      if (!released.ok) result = released;
      else if (result.ok) result = ok({ ...result.data, leaseReleased: true });
    }
  }
  return result;
}
