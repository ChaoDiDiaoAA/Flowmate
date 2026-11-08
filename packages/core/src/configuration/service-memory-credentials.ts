import { mkdir, lstat, open, readFile, realpath, rename, rm } from 'node:fs/promises';
import { isAbsolute, join, resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import { z } from 'zod';
import { appError, fail, MemoryConnectionConfigurationSchema, MemorySettingsViewSchema, ok, type Result } from '@flowmate/contracts';
import { createCredentialStore, type SecureStoragePort } from '../../../shared/src/secure-credential-store.ts';
import { verifyOpenVikingIdentity } from '../openviking/identity.ts';

const configuration = MemoryConnectionConfigurationSchema.omit({ credentialRef: true });
export const ServiceMemoryConfigurationRequestSchema = configuration.extend({ installationId: z.string().uuid(), operationId: z.string().uuid(),
  apiKey: z.string().min(1).max(4096).refine(value => /^[\x21-\x7e]+$/.test(value)) }).strict();
export const ServiceMemoryOperationQuerySchema = z.object({ installationId: z.string().uuid(), operationId: z.string().uuid() }).strict();
export const ServiceMemoryOperationReceiptSchema = z.object({ installationId: z.string().uuid(), operationId: z.string().uuid(),
  phase: z.enum(['pending', 'committed', 'failed']), settings: MemorySettingsViewSchema.nullable(),
  errorCode: z.literal('memory_identity_unavailable').nullable() }).strict()
  .refine(value => (value.phase === 'committed') === (value.settings !== null)
    && (value.phase === 'failed') === (value.errorCode !== null));
export type ServiceMemoryConfigurationRequest = z.infer<typeof ServiceMemoryConfigurationRequestSchema>;
export type ServiceMemoryOperationQuery = z.infer<typeof ServiceMemoryOperationQuerySchema>;
export type ServiceMemoryOperationReceipt = z.infer<typeof ServiceMemoryOperationReceiptSchema>;
type View = z.infer<typeof MemorySettingsViewSchema>;
type Config = z.infer<typeof MemoryConnectionConfigurationSchema>;
const recordSchema = z.object({ version: z.literal(1), installationId: z.string().uuid(), operationId: z.string().uuid(),
  configuration, credentialRef: z.string().regex(/^memory_[a-f0-9]{32}$/), phase: z.enum(['pending', 'committed', 'failed']),
  settings: MemorySettingsViewSchema.nullable(), errorCode: z.literal('memory_identity_unavailable').nullable() }).strict()
  .refine(value => (value.phase === 'committed') === (value.settings !== null) && (value.phase === 'failed') === (value.errorCode !== null));
type Record = z.infer<typeof recordSchema>;
const failure = (code: string) => fail(appError(code, code === 'service_memory_operation_conflict' ? 'input' : 'runtime',
  'The original service memory configuration could not be confirmed.', true));

export function createServiceMemoryCredentialService(options: { installationId: string; dataRoot: string; secureStorage: SecureStoragePort;
  fetch?: typeof fetch; controller: { configure(input: Config): Promise<Result<View>>; inspect(input: Config): Promise<Result<View | null>> } }) {
  const root = resolve(options.dataRoot), credentials = join(root, 'security/service-memory-credentials'), operations = join(credentials, 'operations');
  let queue = Promise.resolve();
  const mutate = <T>(action: () => Promise<T>): Promise<T> => { const next = queue.then(action); queue = next.then(() => undefined, () => undefined); return next; };
  async function directory(path: string, create: boolean): Promise<boolean> {
    try {
      if (create) await mkdir(path).catch(error => { if (!(error instanceof Error && 'code' in error && error.code === 'EEXIST')) throw error; });
      const stat = await lstat(path);
      if (!stat.isDirectory() || stat.isSymbolicLink() || await realpath(path) !== path) throw Error('service_memory_path_invalid');
      return true;
    } catch (error) { if (!create && error instanceof Error && 'code' in error && error.code === 'ENOENT') return false; throw error; }
  }
  async function boundary(create: boolean): Promise<boolean> {
    if (!z.string().uuid().safeParse(options.installationId).success || !isAbsolute(options.dataRoot) || root !== options.dataRoot
      || !await directory(root, false)) throw Error('service_memory_path_invalid');
    for (const path of [join(root, 'security'), credentials, operations]) if (!await directory(path, create)) return false;
    return true;
  }
  async function exists(file: string): Promise<boolean> {
    try {
      const stat = await lstat(file);
      if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 32768 || await realpath(file) !== file) throw Error('service_memory_file_invalid');
      return true;
    } catch (error) { if (error instanceof Error && 'code' in error && error.code === 'ENOENT') return false; throw error; }
  }
  const operationFile = (id: string) => join(operations, id + '.json');
  async function readRecord(id: string): Promise<Record | null> {
    if (!await boundary(false) || !await exists(operationFile(id))) return null;
    const record = recordSchema.parse(JSON.parse(await readFile(operationFile(id), 'utf8')));
    if (record.installationId !== options.installationId || record.operationId !== id
      || record.credentialRef !== 'memory_' + id.replaceAll('-', '').toLowerCase()) throw Error('service_memory_operation_invalid');
    return record;
  }
  async function writeRecord(record: Record): Promise<void> {
    recordSchema.parse(record); await boundary(true);
    const file = operationFile(record.operationId), temporary = file + '.' + randomUUID() + '.tmp';
    await exists(file);
    let handle: Awaited<ReturnType<typeof open>> | undefined;
    try {
      handle = await open(temporary, 'wx', 0o600); await handle.writeFile(JSON.stringify(record) + '\n'); await handle.sync();
      await handle.close(); handle = undefined; await rename(temporary, file);
    } catch (error) { await handle?.close().catch(() => {}); await rm(temporary, { force: true }).catch(() => {}); throw error; }
  }
  const receipt = (record: Record): ServiceMemoryOperationReceipt => ({ installationId: record.installationId, operationId: record.operationId,
    phase: record.phase, settings: record.settings, errorCode: record.errorCode });
  const config = (record: Record): Config => ({ ...record.configuration, credentialRef: record.credentialRef });
  async function confirm(record: Record, view: View): Promise<ServiceMemoryOperationReceipt> {
    const expected = record.configuration, checked = MemorySettingsViewSchema.parse(view);
    if (checked.settings.revision !== expected.expectedRevision + 1 || checked.settings.provider !== 'openviking'
      || checked.settings.endpoint !== expected.endpoint || checked.settings.recallEnabled !== expected.recallEnabled
      || checked.settings.captureMode !== expected.captureMode || checked.identity?.accountId !== expected.accountId
      || checked.identity.userId !== expected.userId || checked.identity.peerId !== expected.peerId) throw Error('service_memory_receipt_invalid');
    record.phase = 'committed'; record.settings = view; record.errorCode = null; await writeRecord(record); return receipt(record);
  }
  async function proof(record: Record): Promise<Result<View | null>> { return options.controller.inspect(config(record)); }
  return {
    configure(raw: unknown): Promise<Result<ServiceMemoryOperationReceipt>> {
      return mutate(async () => {
        const parsed = ServiceMemoryConfigurationRequestSchema.safeParse(raw);
        if (!parsed.success || parsed.data.installationId !== options.installationId) return failure('service_memory_request_invalid');
        const { apiKey, installationId, operationId, ...input } = parsed.data;
        try {
          let record = await readRecord(operationId);
          if (record && !isDeepStrictEqual(record.configuration, input)) return failure('service_memory_operation_conflict');
          if (!record) {
            if (!await verifyOpenVikingIdentity({ endpoint: input.endpoint, apiKey, accountId: input.accountId, userId: input.userId,
              role: 'user', fetch: options.fetch ?? globalThis.fetch, signal: AbortSignal.timeout(5000) })) return failure('memory_identity_unavailable');
            record = { version: 1, installationId, operationId, configuration: input,
              credentialRef: 'memory_' + operationId.replaceAll('-', '').toLowerCase(), phase: 'pending', settings: null, errorCode: null };
            await writeRecord(record);
          }
          const file = join(credentials, record.credentialRef + '.json');
          await exists(file);
          const store = createCredentialStore(file, options.secureStorage), original = await store.read();
          if (!original.ok) return failure('operation_result_unknown');
          if (original.data !== null && original.data !== apiKey) return failure('service_memory_operation_conflict');
          if (original.data === null) {
            const saved = await store.write(apiKey); if (!saved.ok) return failure('operation_result_unknown');
            const checked = await store.read(); if (!checked.ok || checked.data !== apiKey) return failure('operation_result_unknown');
          }
          if (record.phase !== 'pending') return ok(receipt(record));
          const existing = await proof(record); if (!existing.ok) return failure('operation_result_unknown');
          if (existing.data) return ok(await confirm(record, existing.data));
          const applied = await options.controller.configure(config(record));
          if (!applied.ok) {
            const after = await proof(record);
            if (after.ok && after.data) return ok(await confirm(record, after.data));
            if (after.ok && applied.error.code === 'memory_identity_unavailable') {
              record.phase = 'failed'; record.errorCode = 'memory_identity_unavailable'; await writeRecord(record); return ok(receipt(record));
            }
            return failure('operation_result_unknown');
          }
          return ok(await confirm(record, applied.data));
        } catch { return failure('operation_result_unknown'); }
      });
    },
    query(raw: unknown): Promise<Result<ServiceMemoryOperationReceipt | null>> {
      return mutate(async () => {
        const parsed = ServiceMemoryOperationQuerySchema.safeParse(raw);
        if (!parsed.success || parsed.data.installationId !== options.installationId) return failure('service_memory_request_invalid');
        try {
          const record = await readRecord(parsed.data.operationId); if (!record) return ok(null);
          if (record.phase !== 'pending') return ok(receipt(record));
          const existing = await proof(record); if (!existing.ok) return failure('operation_result_unknown');
          return existing.data ? ok(await confirm(record, existing.data)) : ok(receipt(record));
        } catch { return failure('operation_result_unknown'); }
      });
    },
  };
}
