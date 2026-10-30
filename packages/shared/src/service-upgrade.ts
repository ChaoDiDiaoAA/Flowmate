import { randomUUID } from 'node:crypto';
import { lstat, open, readFile, realpath, rename, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { isDeepStrictEqual } from 'node:util';
import { z } from 'zod';
import { appError, fail, ok, type Result } from '@flowmate/contracts';
import { ServiceInstallationSchema, readServiceInstallation, resolveServiceRuntime, type ServiceInstallation } from './service-layout.ts';

const requestSchema = z.object({ installationFile: z.string().min(1).max(32767), original: ServiceInstallationSchema,
  targetRuntimeRoot: z.string().min(1).max(32767) }).strict().refine(({ original }) => original.enabled === true
    && original.activationOperationId !== undefined && original.activationOperationId !== null
    && original.activationSettingsRevision !== undefined && original.activationSettingsRevision !== null);
export type PublishServiceReleaseRequest = z.infer<typeof requestSchema>;
class ReleaseError extends Error {}
const failure = (code: string) => fail(appError(code, 'storage',
  'The service release publication could not be confirmed. Query the original installation before retrying; its identity and business data were retained.', true));

async function record(file: string) {
  const stat = await lstat(file);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 16384 || await realpath(file) !== file)
    throw new ReleaseError('service_upgrade_record_invalid');
  const raw = await readFile(file, 'utf8'), parsed = ServiceInstallationSchema.safeParse(JSON.parse(raw));
  if (!parsed.success) throw new ReleaseError('service_upgrade_record_invalid');
  return { raw, installation: parsed.data };
}
async function target(runtimeRoot: string, dataRoot: string) {
  const checked = await resolveServiceRuntime({ runtimeRoot, dataRoot });
  if (!checked.ok) throw new ReleaseError(checked.error.code);
  const release = checked.data.runtime.release;
  if (!release || release.schemaVersion !== 22 || release.settingsVersion !== 7 || release.sdkVersion !== '1.4.0')
    throw new ReleaseError('service_upgrade_target_incompatible');
  return release;
}

/** The caller holds the original data-root maintenance lease. This file CAS is separate from all SCM actions. */
export async function publishServiceRelease(raw: PublishServiceReleaseRequest): Promise<Result<ServiceInstallation>> {
  const captured = requestSchema.safeParse(raw); if (!captured.success) return failure('service_upgrade_request_invalid');
  const { installationFile, original, targetRuntimeRoot } = captured.data;
  if (installationFile !== join(original.dataRoot, 'service-installation.json')) return failure('service_upgrade_request_invalid');
  try {
    const before = await record(installationFile);
    const verified = await readServiceInstallation({ installationFile, runtimeRoot: before.installation.runtimeRoot });
    if (!verified.ok) return verified;
    if (!isDeepStrictEqual(verified.data, before.installation)) return failure('service_upgrade_record_changed');
    const release = await target(targetRuntimeRoot, original.dataRoot);
    const next: ServiceInstallation = { ...original, runtimeRoot: targetRuntimeRoot, releaseId: release.releaseId };
    if (isDeepStrictEqual(before.installation, next)) {
      if ((await record(installationFile)).raw !== before.raw) return failure('service_upgrade_record_changed');
      return ok(before.installation);
    }
    if (!isDeepStrictEqual(before.installation, original)) return failure('service_upgrade_record_changed');
    const temporary = installationFile + '.' + randomUUID() + '.tmp';
    let handle: Awaited<ReturnType<typeof open>> | undefined, ownsTemporary = false;
    try {
      handle = await open(temporary, 'wx', 0o600); ownsTemporary = true;
      await handle.writeFile(JSON.stringify(next, null, 2) + '\n'); await handle.sync(); await handle.close(); handle = undefined;
      const current = await readServiceInstallation({ installationFile, runtimeRoot: original.runtimeRoot });
      if (!current.ok) throw new ReleaseError(current.error.code);
      if (!isDeepStrictEqual(current.data, original)) throw new ReleaseError('service_upgrade_record_changed');
      if ((await target(targetRuntimeRoot, original.dataRoot)).releaseId !== release.releaseId)
        throw new ReleaseError('service_upgrade_target_changed');
      if ((await record(installationFile)).raw !== before.raw) throw new ReleaseError('service_upgrade_record_changed');
      // After rename is attempted, retain a remaining stage on an unknown result; the source path may have a later owner.
      ownsTemporary = false;
      await rename(temporary, installationFile);
      const saved = await readServiceInstallation({ installationFile, runtimeRoot: targetRuntimeRoot });
      if (!saved.ok || !isDeepStrictEqual(saved.data, next)) throw new ReleaseError('service_upgrade_write_unconfirmed');
      return ok(saved.data);
    } catch (cause) { return failure(cause instanceof ReleaseError ? cause.message : 'service_upgrade_write_unconfirmed'); }
    finally {
      await handle?.close().catch(() => {});
      if (ownsTemporary) await rm(temporary, { force: true }).catch(() => {});
    }
  } catch (cause) { return failure(cause instanceof ReleaseError ? cause.message : 'service_upgrade_unavailable'); }
}
