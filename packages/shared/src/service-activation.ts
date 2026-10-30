import { randomUUID } from 'node:crypto';
import { lstat, open, readFile, realpath, rename, rm } from 'node:fs/promises';
import { dirname, isAbsolute, join } from 'node:path';
import { isDeepStrictEqual } from 'node:util';
import { z } from 'zod';
import { appError, fail, ok, type Result } from '@flowmate/contracts';
import { ServiceInstallationSchema, type ServiceInstallation } from './service-layout.ts';
import { resolveRuntimeLayout } from './runtime-layout.ts';

const identity = { installation: ServiceInstallationSchema, operationId: z.string().uuid() };
const querySchema = z.object(identity).strict();
const beginSchema = z.object({ ...identity, expectedSettingsRevision: z.number().int().nonnegative().safe() }).strict();
export type ServiceActivationRequest = z.infer<typeof querySchema>;
export type BeginServiceActivationRequest = z.infer<typeof beginSchema>;
class ActivationError extends Error {}
const failure = (code: string) => fail(appError(code, 'storage', 'The original service activation could not be confirmed. Existing facts were retained.', true));
const code = (cause: unknown) => cause instanceof ActivationError ? cause.message : 'service_activation_unavailable';
function originalIdentity(value: ServiceInstallation) {
  const { enabled: _enabled, activationOperationId: _operation, activationSettingsRevision: _revision, ...original } = value;
  return original;
}
async function owned(path: string, directory = false): Promise<void> {
  const stat = await lstat(path);
  if (stat.isSymbolicLink() || (directory ? !stat.isDirectory() : !stat.isFile()) || await realpath(path) !== path)
    throw new ActivationError('service_activation_path_invalid');
}
async function current(expected: ServiceInstallation) {
  await owned(expected.dataRoot, true);
  const file = join(expected.dataRoot, 'service-installation.json'); await owned(file);
  if ((await lstat(file)).size > 16384) throw new ActivationError('service_activation_record_invalid');
  const raw = await readFile(file, 'utf8'), parsed = ServiceInstallationSchema.safeParse(JSON.parse(raw));
  if (!parsed.success) throw new ActivationError('service_activation_record_invalid');
  if (!isDeepStrictEqual(originalIdentity(parsed.data), originalIdentity(expected))) throw new ActivationError('service_activation_record_changed');
  const layout = resolveRuntimeLayout({ isPackaged: true, appPath: join(dirname(expected.runtimeRoot), 'app.asar'),
    resourcesPath: dirname(expected.runtimeRoot), userDataRoot: expected.dataRoot });
  if (!layout.ok || layout.data.runtimeRoot !== expected.runtimeRoot || !layout.data.release?.service
    || layout.data.release.releaseId !== expected.releaseId) throw new ActivationError('service_activation_installation_incompatible');
  return { file, raw, installation: parsed.data };
}
async function commit(expected: ServiceInstallation, before: Awaited<ReturnType<typeof current>>, next: ServiceInstallation): Promise<ServiceInstallation> {
  const temporary = before.file + '.' + randomUUID() + '.tmp'; let handle: Awaited<ReturnType<typeof open>> | undefined, ownsTemporary = false;
  try {
    handle = await open(temporary, 'wx', 0o600); ownsTemporary = true;
    await handle.writeFile(JSON.stringify(next, null, 2) + '\n'); await handle.sync(); await handle.close(); handle = undefined;
    // Main serializes this flow under its existing single-instance authority; recheck original bytes immediately before publication.
    if ((await current(expected)).raw !== before.raw) throw new ActivationError('service_activation_record_changed');
    await rename(temporary, before.file);
    const saved = await current(expected);
    if (!isDeepStrictEqual(saved.installation, next)) throw new ActivationError('service_activation_write_unconfirmed');
    return saved.installation;
  } catch (cause) { if (cause instanceof ActivationError) throw cause; throw new ActivationError('service_activation_write_unconfirmed'); }
  finally {
    await handle?.close().catch(() => {});
    if (ownsTemporary) await rm(temporary, { force: true }).catch(() => {});
  }
}

export async function beginServiceActivation(raw: BeginServiceActivationRequest): Promise<Result<ServiceInstallation>> {
  const captured = beginSchema.safeParse(raw); if (!captured.success) return failure('service_activation_request_invalid');
  const { installation, operationId, expectedSettingsRevision } = captured.data;
  try {
    const saved = await current(installation), original = saved.installation;
    if (original.activationOperationId !== undefined && original.activationOperationId !== null) {
      if (original.activationOperationId !== operationId || original.activationSettingsRevision !== expectedSettingsRevision)
        return failure('service_activation_operation_conflict');
      return ok(original);
    }
    if (original.enabled === true || !isDeepStrictEqual(original, installation)) return failure('service_activation_record_changed');
    return ok(await commit(installation, saved, { ...original, enabled: false, activationOperationId: operationId,
      activationSettingsRevision: expectedSettingsRevision }));
  } catch (cause) { return failure(code(cause)); }
}

export async function publishServiceEnabled(raw: ServiceActivationRequest): Promise<Result<ServiceInstallation>> {
  const captured = querySchema.safeParse(raw); if (!captured.success) return failure('service_activation_request_invalid');
  const { installation, operationId } = captured.data;
  try {
    const saved = await current(installation), original = saved.installation;
    if (original.activationOperationId !== operationId || original.activationSettingsRevision === undefined || original.activationSettingsRevision === null)
      return failure('service_activation_operation_conflict');
    if (original.enabled === true) return ok(original);
    if (installation.activationOperationId !== operationId || installation.activationSettingsRevision !== original.activationSettingsRevision
      || !isDeepStrictEqual(original, installation)) return failure('service_activation_record_changed');
    return ok(await commit(installation, saved, { ...original, enabled: true }));
  } catch (cause) { return failure(code(cause)); }
}

export function serviceActivationBackupDirectory(installation: ServiceInstallation, operationId: string): Result<string> {
  const captured = querySchema.safeParse({ installation, operationId });
  return captured.success ? ok(join(captured.data.installation.dataRoot, 'backups', 'service-activation-' + captured.data.operationId))
    : failure('service_activation_request_invalid');
}
// The existing offline manifest contract is read as metadata only; maintenance verifies actual bytes and database references.
const manifestSchema = z.object({ version: z.literal(1), backupId: z.string().uuid(), createdAt: z.string().datetime(),
  productVersion: z.string().max(128).nullable(), releaseId: z.string().uuid().nullable(),
  schemaVersion: z.number().int().min(1).max(21).nullable(), settingsVersion: z.number().int().min(1).max(7).nullable(),
  files: z.array(z.object({ path: z.string().min(1).max(1024).refine(path => !isAbsolute(path)
    && path.split('/').every(part => part && part !== '.' && part !== '..' && !/[\\:\x00-\x1f]/.test(part))),
    byteLength: z.number().int().nonnegative().safe() }).strict()).min(1), gaps: z.array(z.string().max(256)) }).strict()
  .refine(value => new Set(value.files.map(file => file.path)).size === value.files.length);
export async function readServiceActivationBackup(raw: ServiceActivationRequest): Promise<Result<{ id: string; directory: string } | null>> {
  const captured = querySchema.safeParse(raw); if (!captured.success) return failure('service_activation_request_invalid');
  try {
    const saved = await current(captured.data.installation);
    const derived = serviceActivationBackupDirectory(captured.data.installation, captured.data.operationId);
    if (!derived.ok) return derived;
    const parent = join(captured.data.installation.dataRoot, 'backups');
    try { await owned(parent, true); await owned(derived.data, true); }
    catch (cause) { if (cause && typeof cause === 'object' && 'code' in cause && cause.code === 'ENOENT') return ok(null); throw cause; }
    const file = join(derived.data, 'manifest.json'); await owned(file);
    const manifest = manifestSchema.safeParse(JSON.parse(await readFile(file, 'utf8')));
    if (!manifest.success) return failure('service_activation_backup_invalid');
    const snapshotFile = join(derived.data, 'service-installation.json'); await owned(snapshotFile);
    if ((await lstat(snapshotFile)).size > 16384 || !manifest.data.files.some(member => member.path === 'service-installation.json'))
      return failure('service_activation_backup_invalid');
    const snapshot = ServiceInstallationSchema.safeParse(JSON.parse(await readFile(snapshotFile, 'utf8')));
    if (!snapshot.success || !isDeepStrictEqual(originalIdentity(snapshot.data), originalIdentity(saved.installation))
      || saved.installation.activationOperationId !== captured.data.operationId
      || saved.installation.activationSettingsRevision === undefined || saved.installation.activationSettingsRevision === null
      || captured.data.installation.activationOperationId !== undefined && captured.data.installation.activationOperationId !== null
        && captured.data.installation.activationOperationId !== captured.data.operationId
      || captured.data.installation.activationSettingsRevision !== undefined && captured.data.installation.activationSettingsRevision !== null
        && captured.data.installation.activationSettingsRevision !== saved.installation.activationSettingsRevision
      || snapshot.data.activationOperationId !== captured.data.operationId
      || snapshot.data.activationSettingsRevision !== saved.installation.activationSettingsRevision)
      return failure('service_activation_backup_invalid');
    return ok({ id: manifest.data.backupId, directory: derived.data });
  } catch (cause) { return failure(cause instanceof ActivationError ? cause.message : 'service_activation_backup_invalid'); }
}
