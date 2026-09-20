import { lstat, mkdir, open, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { dirname, join, resolve } from 'node:path';
import type { Application, StartOptions, StartedProduct, TrustedActor, WorkspacePolicy } from '../packages/contracts/src/index.ts';
import { productError } from '../packages/contracts/src/errors.ts';
import { sha256Bytes, sha256Text, canonicalJson } from '../packages/shared/src/index.ts';
import { ApplicationService, type ApplicationFaultInjector } from '../packages/core/src/application.ts';
import { Kernel } from '../packages/core/src/kernel.ts';
import { FoundationDatabase } from '../packages/core/src/storage/database.ts';
import type { FoundationFaultPoint } from '../packages/core/src/storage/database.ts';
import { InstanceFileStore, type FileStoreFaultInjector } from '../packages/core/src/storage/file-store.ts';
import { Voxel51DataSource } from '../packages/data/src/source/voxel51.ts';
import { createLogger } from '../packages/logging/src/writer.ts';

interface InstanceIdentity { schemaVersion: 'p0-instance/v1'; instanceId: string; osBindingHash: string; ownerActorId: string; workspaceId: string; sourceRootRef: string; }
export interface ProductTestHooks {
  /** Test-only seams; production callers and the CLI do not supply them. */
  databaseFault?: (point: FoundationFaultPoint) => void;
  fileFault?: FileStoreFaultInjector;
  applicationFault?: ApplicationFaultInjector;
}
const execFileAsync = promisify(execFile);

export async function createProduct(options: StartOptions, testHooks?: ProductTestHooks): Promise<StartedProduct> {
  const instanceRoot = resolve(options.instanceRoot);
  if (isEvalRoot(instanceRoot)) throw productError({ code: 'QUALITY_ROOT_DENIED', category: 'authorization', source: { component: 'composition', operation: 'instanceRoot' }, safeMessage: 'The evaluation and quality root cannot host a product instance', impactScope: 'instance', recoveryAction: 'correct_input', correlation: {} });
  await mkdir(instanceRoot, { recursive: true });
  const instanceInfo = await lstat(instanceRoot);
  if (!instanceInfo.isDirectory() || instanceInfo.isSymbolicLink()) throw productError({ code: 'REPARSE_POINT_DENIED', category: 'authorization', source: { component: 'composition', operation: 'instanceRoot' }, safeMessage: 'The instance root must be a real directory', impactScope: 'instance', recoveryAction: 'correct_input', correlation: {} });
  const lockPath = join(instanceRoot, 'instance.lock');
  let lock: Awaited<ReturnType<typeof open>> | undefined;
  let database: FoundationDatabase | undefined;
  let logger: Awaited<ReturnType<typeof createLogger>> | undefined;
  try {
    try { lock = await open(lockPath, 'wx'); } catch (error) {
      throw productError({ code: 'INSTANCE_LOCKED', category: 'state', source: { component: 'composition', operation: 'start' }, safeMessage: 'Another Flowmate process already owns this instance', impactScope: 'instance', recoveryAction: 'manual_review', correlation: {} }, { cause: error as Error });
    }
    const identityPath = join(instanceRoot, 'instance.json');
    let sourceRoot = resolve(process.env.FLOWMATE_SOURCE_ROOT ?? join(process.cwd(), 'data', 'invoices', 'voxel51'));
    if (options.configPath && isEvalRoot(resolve(options.configPath))) throw productError({ code: 'QUALITY_ROOT_DENIED', category: 'authorization', source: { component: 'composition', operation: 'config' }, safeMessage: 'The evaluation and quality root cannot be used as product configuration', impactScope: 'instance', recoveryAction: 'correct_input', correlation: {} });
    if (options.configPath) {
      try {
        const config = JSON.parse(await readFile(resolve(options.configPath), 'utf8')) as { sourceRoot?: string };
        if (config.sourceRoot) sourceRoot = resolve(config.sourceRoot);
      } catch (error) {
        throw productError({ code: 'CONFIG_LOCK_MISMATCH', category: 'configuration', source: { component: 'composition', operation: 'config' }, safeMessage: 'The product configuration cannot be read or is invalid', impactScope: 'instance', recoveryAction: 'manual_review', correlation: {} }, { cause: error as Error });
      }
    }
    if (isEvalRoot(sourceRoot)) throw productError({ code: 'QUALITY_ROOT_DENIED', category: 'authorization', source: { component: 'composition', operation: 'sourceRoot' }, safeMessage: 'The evaluation and quality root cannot be used as a product source', impactScope: 'instance', recoveryAction: 'correct_input', correlation: {} });
    const sourceInfo = await lstat(sourceRoot);
    if (!sourceInfo.isDirectory() || sourceInfo.isSymbolicLink()) throw productError({ code: 'REPARSE_POINT_DENIED', category: 'authorization', source: { component: 'composition', operation: 'sourceRoot' }, safeMessage: 'The approved source root must be a real directory', impactScope: 'instance', recoveryAction: 'correct_input', correlation: {} });
    const manifestPath = join(sourceRoot, 'manifest.json');
    let manifestInfo;
    try { manifestInfo = await lstat(manifestPath); } catch (error) {
      throw productError({ code: 'FILE_MISSING', category: 'input', source: { component: 'composition', operation: 'manifest' }, safeMessage: 'The approved source manifest is missing', impactScope: 'instance', recoveryAction: 'correct_input', correlation: {} }, { cause: error as Error });
    }
    if (manifestInfo.isSymbolicLink()) throw productError({ code: 'REPARSE_POINT_DENIED', category: 'authorization', source: { component: 'composition', operation: 'manifest' }, safeMessage: 'The approved source manifest cannot be a link', impactScope: 'instance', recoveryAction: 'correct_input', correlation: {} });
    const manifestBytes = await readFile(manifestPath);
    const manifestSha256 = sha256Bytes(manifestBytes);
    const osBindingHash = await deriveOsBindingHash();
    let identity: InstanceIdentity;
    let exists = true;
    try { identity = JSON.parse(await readFile(identityPath, 'utf8')) as InstanceIdentity; } catch (error) {
      if (!(error instanceof Error && 'code' in error && (error as NodeJS.ErrnoException).code === 'ENOENT')) throw error;
      exists = false;
      identity = { schemaVersion: 'p0-instance/v1', instanceId: `i_${crypto.randomUUID().replaceAll('-', '')}`, osBindingHash, ownerActorId: `a_${sha256Text(`${osBindingHash}|${crypto.randomUUID()}`).slice(0, 48)}`, workspaceId: '', sourceRootRef: sourceRoot };
      identity.ownerActorId = `a_${sha256Text(`${osBindingHash}|${identity.instanceId}`).slice(0, 48)}`;
      identity.workspaceId = `w_${sha256Text(`${identity.instanceId}|default`).slice(0, 48)}`;
    }
    if (options.mode === 'create' && exists) throw productError({ code: 'INSTANCE_EXISTS', category: 'state', source: { component: 'composition', operation: 'create' }, safeMessage: 'The Flowmate instance already exists', impactScope: 'instance', recoveryAction: 'query_action', correlation: { instanceId: identity.instanceId } });
    if (options.mode === 'open' && !exists) throw productError({ code: 'INSTANCE_IDENTITY_MISSING', category: 'state', source: { component: 'composition', operation: 'open' }, safeMessage: 'The Flowmate instance has not been initialized', impactScope: 'instance', recoveryAction: 'manual_review', correlation: {} });
    if (identity.schemaVersion !== 'p0-instance/v1' || identity.osBindingHash !== osBindingHash) throw productError({ code: 'IDENTITY_UNTRUSTED', category: 'authorization', source: { component: 'composition', operation: 'identity' }, safeMessage: 'The persisted instance identity does not match this host identity', impactScope: 'instance', recoveryAction: 'manual_review', correlation: { instanceId: identity.instanceId } });
    if (resolve(identity.sourceRootRef) !== sourceRoot) throw productError({ code: 'CONFIG_LOCK_MISMATCH', category: 'configuration', source: { component: 'composition', operation: 'sourceRoot' }, safeMessage: 'The persisted source root does not match the locked configuration', impactScope: 'instance', recoveryAction: 'manual_review', correlation: { instanceId: identity.instanceId } });
    if (!exists) await atomicWrite(identityPath, canonicalJson(identity));

    const grants = ['source.inspect', 'source.register', 'source.publish', 'document.read', 'input.capture', 'document.setStatus', 'workspace.setStatus', 'policy.publish', 'evidence.read'] as const;
    const policy: WorkspacePolicy = { schemaVersion: 'p0-policy/v1', version: 1, grants: [{ actorId: identity.ownerActorId, operations: [...grants], sourceKeys: ['voxel51'], purposes: ['development', 'regression'] }], sources: [{ sourceKey: 'voxel51', rootRef: identity.sourceRootRef, manifestSha256, allowedPurposes: ['development', 'regression'], useAuthorizationRef: `workspace:${identity.workspaceId}` }] };
    const policyJson = canonicalJson(policy);
    const policyHash = sha256Bytes(new TextEncoder().encode(policyJson));
    await mkdir(join(instanceRoot, 'data'), { recursive: true });
    database = new FoundationDatabase(join(instanceRoot, 'data', 'app.sqlite'), testHooks?.databaseFault);
    database.initialize();
    database.createOrLoadWorkspace({ workspaceId: identity.workspaceId, ownerActorId: identity.ownerActorId, policyJson, policyHash, instanceId: identity.instanceId, dataRootRef: instanceRoot });
    const files = new InstanceFileStore({ sourceRoot, instanceRoot, faultInjector: testHooks?.fileFault });
    await files.prepare();
    const processInstanceId = `p_${crypto.randomUUID().replaceAll('-', '')}`;
    logger = await createLogger({ instanceId: identity.instanceId, processInstanceId, logRoot: join(instanceRoot, 'logs'), config: { minLevel: 'info', maxRecordBytes: 16_384, maxFileBytes: 4_194_304, maxTotalBytes: 16_777_216, retentionDays: 7, queueLimit: 1024, flushTimeoutMs: 1_000 } });
    const actor: TrustedActor = { actorId: identity.ownerActorId, instanceId: identity.instanceId, osBindingHash };
    const kernel = new Kernel(database, actor);
    const data = new Voxel51DataSource(sourceRoot, identity.workspaceId, database, files);
    const service = new ApplicationService(database, files, data, kernel, actor, logger, testHooks?.applicationFault);
    const application: Application = service;
    let closed = false;
    return { application, instanceId: identity.instanceId, workspaceId: identity.workspaceId, processInstanceId, close: async () => {
      if (closed) return { closed: true, cleanupErrors: [] };
      closed = true;
      service.shutdown();
      const cleanupErrors: import('../packages/contracts/src/errors.ts').ErrorDescriptor[] = [];
      try { await logger?.flush(1_000); } catch (error) { cleanupErrors.push(toDescriptor(error, 'flush')); }
      try { await logger?.close(1_000); } catch (error) { cleanupErrors.push(toDescriptor(error, 'logger.close')); }
      try { database?.close(); } catch (error) { cleanupErrors.push(toDescriptor(error, 'database.close')); }
      try { await lock?.close(); await rm(lockPath, { force: true }); } catch (error) { cleanupErrors.push(toDescriptor(error, 'lock.release')); }
      return { closed: cleanupErrors.length === 0, cleanupErrors };
    } };
  } catch (error) {
    try { await logger?.close(1_000); } catch { /* cleanup best effort */ }
    try { database?.close(); } catch { /* cleanup best effort */ }
    try { await lock?.close(); await rm(lockPath, { force: true }); } catch { /* cleanup best effort */ }
    throw error;
  }
}

async function atomicWrite(path: string, content: string): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  const temp = `${path}.${crypto.randomUUID()}.tmp`;
  await writeFile(temp, content, { flag: 'wx' });
  await rename(temp, path);
}

function toDescriptor(error: unknown, operation: string) {
  if (error && typeof error === 'object' && 'descriptor' in error) return (error as { descriptor: import('../packages/contracts/src/errors.ts').ErrorDescriptor }).descriptor;
  return { version: 'error/v1' as const, errorId: crypto.randomUUID(), code: 'CLOSE_FAILED', category: 'lifecycle', source: { component: 'composition', operation }, safeMessage: 'A resource could not be closed cleanly', impactScope: 'instance' as const, recoveryAction: 'manual_review' as const, correlation: {} };
}

function isEvalRoot(path: string): boolean {
  return path.split(/[\\/]+/).some((part) => part.toLowerCase() === 'agent-eval');
}

async function deriveOsBindingHash(): Promise<string> {
  if (process.platform === 'win32') {
    try {
      const result = await execFileAsync('whoami.exe', ['/user', '/fo', 'csv', '/nh'], { windowsHide: true, timeout: 2_000 });
      const sid = result.stdout.match(/S-1-[0-9-]+/)?.[0];
      if (sid) return sha256Text(`windows-sid|${sid}`);
    } catch { /* fall back to the host-provided account name below */ }
  }
  const account = process.env.USERDOMAIN && process.env.USERNAME ? `${process.env.USERDOMAIN}\\${process.env.USERNAME}` : process.env.USER ?? process.env.USERNAME ?? '';
  if (!account) throw productError({ code: 'IDENTITY_UNTRUSTED', category: 'authorization', source: { component: 'composition', operation: 'osIdentity' }, safeMessage: 'The local operating system identity could not be determined', impactScope: 'instance', recoveryAction: 'manual_review', correlation: {} });
  return sha256Text(`${process.platform}|${account}`);
}

export type { StartOptions, StartedProduct } from '../packages/contracts/src/index.ts';
