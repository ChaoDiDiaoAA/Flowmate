import { randomUUID } from 'node:crypto';
import { lstat, mkdir, open, readFile, readdir, realpath, rename, rm } from 'node:fs/promises';
import { isAbsolute, join, resolve } from 'node:path';
import { isDeepStrictEqual } from 'node:util';
import { z } from 'zod';
import { AppErrorSchema, appError, fail, ok, type ProductSettings, type Result } from '@flowmate/contracts';
import { createCredentialStore, type SecureStoragePort } from '../../../shared/src/secure-credential-store.ts';
import { validateProductSettings } from './settings.ts';

const reference = z.string().regex(/^[a-zA-Z0-9_-]{16,80}$/), modelId = z.string().regex(/^[a-zA-Z0-9._-]{1,64}$/);
const revision = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);
const identity = { installationId: z.string().uuid(), operationId: z.string().uuid() };
const publicSettingsSchema = z.unknown().transform((value, context) => {
  const parsed = validateProductSettings(value); if (parsed.ok) return parsed.data;
  context.addIssue({ code: 'custom', message: 'The original settings snapshot is invalid.' }); return z.NEVER;
});
export const ServiceCredentialOperationQuerySchema = z.object(identity).strict();
export const ServiceCredentialMigrationRequestSchema = z.object({ ...identity, expectedSettingsRevision: revision,
  credentials: z.array(z.object({ modelId, credentialRef: reference, value: z.string().min(1).max(65_536).nullable() }).strict()).max(32) }).strict();
export const ServiceCredentialSettingsRequestSchema = z.object({ ...identity, settings: z.unknown(), credentialUpdate: z.object({
  modelId, apiKey: z.string().max(4096).refine(value => value.trim().length > 0) }).strict().optional() }).strict();
export const ServiceCredentialStatusSchema = z.object({ installationId: z.string().uuid(), settingsRevision: revision,
  models: z.array(z.object({ modelId, credentialRef: reference, status: z.enum(['missing', 'configured', 'unavailable']) }).strict()).max(32) }).strict()
  .refine(value => new Set(value.models.map(model => model.modelId)).size === value.models.length, 'Each model has one credential status.');
export const ServiceCredentialOperationReceiptSchema = z.object({ version: z.literal(1), ...identity,
  kind: z.enum(['migration', 'settings']), phase: z.enum(['pending', 'prepared', 'committed', 'failed']),
  expectedSettingsRevision: revision, settingsRevision: revision,
  models: z.array(z.object({ modelId, credentialRef: reference, state: z.enum(['pending', 'missing', 'prepared', 'published']) }).strict()).max(32),
  settings: publicSettingsSchema.nullable().default(null), error: AppErrorSchema.nullable() }).strict().refine(value => new Set(value.models.map(model => model.modelId)).size === value.models.length
    && (value.phase !== 'committed' || value.error === null && value.models.every(model => model.state === 'published' || model.state === 'missing')
      && value.settingsRevision === value.expectedSettingsRevision + (value.kind === 'settings' ? 1 : 0))
    && (value.phase !== 'prepared' || value.error === null && value.models.every(model => model.state === 'prepared' || model.state === 'missing')),
  'Credential receipts require distinct models and their actual publication phase.')
  .refine(value => value.kind === 'settings' && value.phase === 'committed'
    ? value.settings !== null && value.settings.revision === value.settingsRevision : value.settings === null,
  'Only an actual committed settings operation returns its original settings snapshot.');
export type ServiceCredentialOperationQuery = z.infer<typeof ServiceCredentialOperationQuerySchema>;
export type ServiceCredentialMigrationRequest = z.infer<typeof ServiceCredentialMigrationRequestSchema>;
export type ServiceCredentialSettingsRequest = z.infer<typeof ServiceCredentialSettingsRequestSchema>;
export type ServiceCredentialStatus = z.infer<typeof ServiceCredentialStatusSchema>;
export type ServiceCredentialOperationReceipt = z.infer<typeof ServiceCredentialOperationReceiptSchema>;
export type ServiceCredentialSettingsScope = { readonly current: ProductSettings;
  save(next: unknown, options?: { notifyConditionsChanged?: boolean }): Promise<Result<ProductSettings>>;
  conditionsChanged(): void };
export type ServiceCredentialSettingsAuthority = { readSettings(): Promise<Result<ProductSettings>>;
  withSettingsWrite<T>(action: (scope: ServiceCredentialSettingsScope) => Promise<Result<T>>): Promise<Result<T>>;
  setCredentialRecoveryHook(hook: (scope: ServiceCredentialSettingsScope) => Promise<Result<void>>): void };
export type ServiceCredentialPorts = { installationId: string; dataRoot: string; secureStorage: SecureStoragePort;
  settingsAuthority: ServiceCredentialSettingsAuthority };

const credentialSchema = z.union([z.object({ type: z.literal('api_key'), key: z.string().min(1).max(65_536), env: z.record(z.string()).optional() }).strict(),
  z.object({ type: z.literal('oauth'), access: z.string(), refresh: z.string(), expires: z.number().finite() }).passthrough()]);
const recordSchema = z.object({ version: z.literal(1), dataRoot: z.string(), receipt: ServiceCredentialOperationReceiptSchema,
  sealedIntent: z.string().min(1).max(4_000_000), commitRequested: z.boolean(), nextSettings: z.unknown() }).strict();
type OperationRecord = z.infer<typeof recordSchema>;
const intentSchema = z.object({ version: z.literal(1), installationId: z.string().uuid(), dataRoot: z.string(),
  kind: z.enum(['migration', 'settings']), request: z.unknown(), before: z.unknown(), next: z.unknown(),
  credentials: z.array(z.object({ modelId, credentialRef: reference, value: z.string().nullable() }).strict()).max(32) }).strict();
type Intent = Omit<z.infer<typeof intentSchema>, 'before' | 'next'> & { before: ProductSettings; next: ProductSettings };
const error = (code: string, category: 'input' | 'storage' = 'storage') => appError(code, category,
  code === 'config_revision_conflict' ? 'Reload the current configuration before publishing credentials.'
    : code === 'service_credential_operation_conflict' ? 'This operation belongs to a different original request.'
    : 'The service credential operation could not be confirmed.', true);
const failure = (code: string, category?: 'input' | 'storage') => fail(error(code, category));
const publicationSchema = z.object({ version: z.literal(1), installationId: z.string().uuid(), operationId: z.string().uuid(),
  dataRoot: z.string(), credentialRef: reference }).strict();
const envelopeSchema = z.object({ version: z.literal(1), ciphertext: z.string().min(1),
  servicePublication: publicationSchema.optional() }).strict();

function normalizeCredential(value: string): string {
  const raw: unknown = value.startsWith('pi-credential-v1:') ? JSON.parse(value.slice('pi-credential-v1:'.length))
    : { type: 'api_key', key: value };
  return JSON.stringify(credentialSchema.parse(raw));
}
function sameSettings(actual: ProductSettings, expected: ProductSettings): boolean {
  const { revision: _actualRevision, updatedAt: _actualAt, ...actualBody } = actual;
  const { revision: _expectedRevision, updatedAt: _expectedAt, ...expectedBody } = expected;
  return isDeepStrictEqual(actualBody, expectedBody);
}

export function createServiceCredentialService(ports: ServiceCredentialPorts) {
  const installationId = ports.installationId, dataRoot = ports.dataRoot;
  const credentialRoot = join(dataRoot, 'security/service-credentials'), operationsRoot = join(credentialRoot, 'operations');
  let mutations = Promise.resolve();
  const mutate = <T>(action: () => Promise<T>): Promise<T> => {
    const pending = mutations.then(action); mutations = pending.then(() => undefined, () => undefined); return pending;
  };
  async function directory(path: string, create: boolean): Promise<boolean> {
    try {
      if (create) await mkdir(path).catch(cause => { if (!(cause instanceof Error && 'code' in cause && cause.code === 'EEXIST')) throw cause; });
      const stat = await lstat(path);
      if (!stat.isDirectory() || stat.isSymbolicLink() || await realpath(path) !== path) throw Error('credential_path_invalid');
      return true;
    } catch (cause) { if (!create && cause instanceof Error && 'code' in cause && cause.code === 'ENOENT') return false; throw cause; }
  }
  async function boundary(create: boolean): Promise<boolean> {
    if (!z.string().uuid().safeParse(installationId).success || !isAbsolute(dataRoot) || resolve(dataRoot) !== dataRoot
      || !await directory(dataRoot, false)) throw Error('credential_path_invalid');
    for (const path of [join(dataRoot, 'security'), credentialRoot, operationsRoot]) if (!await directory(path, create)) return false;
    return true;
  }
  async function fileExists(path: string): Promise<boolean> {
    try {
      const stat = await lstat(path);
      if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 4_200_000 || await realpath(path) !== path) throw Error('credential_file_invalid');
      return true;
    } catch (cause) { if (cause instanceof Error && 'code' in cause && cause.code === 'ENOENT') return false; throw cause; }
  }
  const operationFile = (id: string) => join(operationsRoot, id + '.json');
  const finalFile = (ref: string) => join(credentialRoot, ref + '.json');
  const stageFile = (id: string, ref: string) => join(operationsRoot, id, ref + '.json');
  async function readRecord(id: string): Promise<OperationRecord | null> {
    if (!await boundary(false) || !await fileExists(operationFile(id))) return null;
    const record = recordSchema.parse(JSON.parse(await readFile(operationFile(id), 'utf8')));
    if (record.dataRoot !== dataRoot || record.receipt.installationId !== installationId || record.receipt.operationId !== id) throw Error('credential_operation_invalid');
    return record;
  }
  async function writeJson(file: string, value: unknown): Promise<void> {
    await fileExists(file);
    const serialized = JSON.stringify(value) + '\n';
    if (Buffer.byteLength(serialized) > 4_200_000) throw Error('credential_file_too_large');
    const temporary = file + '.' + randomUUID() + '.tmp'; let handle: Awaited<ReturnType<typeof open>> | undefined;
    try {
      handle = await open(temporary, 'wx', 0o600); await handle.writeFile(serialized); await handle.sync();
      await handle.close(); handle = undefined; await rename(temporary, file);
    } catch (cause) {
      await handle?.close().catch(() => {}); await rm(temporary, { force: true }).catch(() => {}); throw cause;
    }
  }
  async function writeRecord(record: OperationRecord): Promise<void> {
    recordSchema.parse(record); await boundary(true); await writeJson(operationFile(record.receipt.operationId), record);
  }
  async function readIntent(record: OperationRecord): Promise<Intent> {
    const decrypted = await ports.secureStorage.decrypt(Buffer.from(record.sealedIntent, 'base64'));
    const value = intentSchema.parse(JSON.parse(decrypted.plaintext));
    const before = validateProductSettings(value.before), next = validateProductSettings(value.next);
    const request = value.kind === 'migration' ? ServiceCredentialMigrationRequestSchema.safeParse(value.request) : ServiceCredentialSettingsRequestSchema.safeParse(value.request);
    if (!before.ok || !next.ok || !request.success || value.installationId !== installationId || value.dataRoot !== dataRoot
      || value.kind !== record.receipt.kind || request.data.operationId !== record.receipt.operationId || request.data.installationId !== installationId
      || record.receipt.expectedSettingsRevision !== before.data.revision || !isDeepStrictEqual(record.nextSettings, next.data)
      || record.receipt.models.length !== value.credentials.length || record.receipt.models.some(model => !value.credentials.some(
        entry => entry.modelId === model.modelId && entry.credentialRef === model.credentialRef)))
      throw Error('credential_operation_invalid');
    return { ...value, request: request.data, before: before.data, next: next.data };
  }
  async function settings(): Promise<ProductSettings> {
    const value = await ports.settingsAuthority.readSettings(); if (!value.ok) throw Error('credential_settings_unavailable');
    const parsed = validateProductSettings(value.data); if (!parsed.ok) throw Error('credential_settings_invalid'); return parsed.data;
  }
  async function stage(record: OperationRecord, intent: Intent): Promise<void> {
    await directory(join(operationsRoot, record.receipt.operationId), true);
    for (const entry of intent.credentials) {
      const model = record.receipt.models.find(value => value.modelId === entry.modelId)!;
      if (entry.value === null) { model.state = 'missing'; continue; }
      const file = stageFile(record.receipt.operationId, entry.credentialRef); await fileExists(file);
      const store = createCredentialStore(file, ports.secureStorage), written = await store.write(entry.value);
      if (!written.ok) throw Error('credential_stage_write_failed');
      const envelope = envelopeSchema.parse(JSON.parse(await readFile(file, 'utf8')));
      await writeJson(file, { ...envelope, servicePublication: { version: 1, installationId,
        operationId: record.receipt.operationId, dataRoot, credentialRef: entry.credentialRef } });
      const restored = await store.read(); if (!restored.ok || restored.data !== entry.value) throw Error('credential_stage_readback_failed');
      model.state = 'prepared';
    }
    record.receipt.phase = 'prepared'; record.receipt.error = null; await writeRecord(record);
  }
  async function publish(record: OperationRecord, intent: Intent): Promise<void> {
    // Original Electron files and superseded service ciphertext support rollback and frozen receipts; current configuration still authorizes use.
    for (const entry of intent.credentials) {
      const target = finalFile(entry.credentialRef); await fileExists(target);
      const model = record.receipt.models.find(value => value.modelId === entry.modelId)!;
      if (entry.value === null) {
        if (await fileExists(target)) {
          const previous = join(operationsRoot, record.receipt.operationId, 'previous'); await directory(previous, true);
          const backup = join(previous, entry.credentialRef + '.json'); if (await fileExists(backup)) throw Error('credential_backup_conflict');
          await rename(target, backup);
        }
        model.state = 'missing'; continue;
      }
      const store = createCredentialStore(target, ports.secureStorage), previous = await store.read();
      if (!previous.ok) throw Error('credential_publish_read_failed');
      if (previous.data !== null && previous.data !== entry.value) throw Error('credential_publish_conflict');
      if (previous.data === null) {
        const file = stageFile(record.receipt.operationId, entry.credentialRef);
        if (!await fileExists(file)) throw Error('credential_stage_missing');
        const staged = await createCredentialStore(file, ports.secureStorage).read();
        if (!staged.ok || staged.data !== entry.value) throw Error('credential_stage_readback_failed');
        await rename(file, target);
      } else {
        const envelope = envelopeSchema.parse(JSON.parse(await readFile(target, 'utf8')));
        await writeJson(target, { ...envelope, servicePublication: { version: 1, installationId,
          operationId: record.receipt.operationId, dataRoot, credentialRef: entry.credentialRef } });
      }
      const restored = await store.read(); if (!restored.ok || restored.data !== entry.value) throw Error('credential_publish_readback_failed');
      model.state = 'published';
    }
  }
  async function failed(record: OperationRecord | undefined, code: string): Promise<Result<ServiceCredentialOperationReceipt>> {
    if (record) {
      if (record.commitRequested && record.receipt.phase === 'committed') code = 'operation_result_unknown';
      record.receipt.settings = null;
      record.receipt.phase = 'failed'; record.receipt.error = error(code);
      try { await writeRecord(record); } catch { return failure('operation_result_unknown'); }
    }
    return failure(code);
  }
  async function publicationProof(record: OperationRecord, current: ProductSettings): Promise<ServiceCredentialOperationReceipt | null> {
    if (!record.commitRequested) return null;
    const next = validateProductSettings(record.nextSettings), receipt = record.receipt;
    const expectedRevision = receipt.expectedSettingsRevision + (receipt.kind === 'settings' ? 1 : 0);
    if (!next.ok || current.revision !== expectedRevision || !sameSettings(current, next.data)) return null;
    const models = structuredClone(receipt.models);
    for (const model of models) {
      const target = finalFile(model.credentialRef);
      if (model.state === 'missing') { if (await fileExists(target)) return null; continue; }
      if (!await fileExists(target)) return null;
      const envelope = envelopeSchema.safeParse(JSON.parse(await readFile(target, 'utf8'))), proof = envelope.success ? envelope.data.servicePublication : null;
      if (!proof || proof.installationId !== installationId || proof.dataRoot !== dataRoot
        || proof.operationId !== receipt.operationId || proof.credentialRef !== model.credentialRef) return null;
      model.state = 'published';
    }
    return { ...receipt, phase: 'committed', settingsRevision: current.revision, models,
      settings: receipt.kind === 'settings' ? structuredClone(current) : null, error: null };
  }
  async function recover(scope: ServiceCredentialSettingsScope): Promise<Result<void>> {
    try {
      if (!await boundary(false)) return ok(undefined);
      for (const file of await readdir(operationsRoot)) {
        const id = file.endsWith('.json') ? file.slice(0, -5) : '';
        if (!z.string().uuid().safeParse(id).success) continue;
        const record = await readRecord(id);
        if (!record || !record.commitRequested || record.receipt.phase === 'committed'
          || record.receipt.phase === 'failed' && record.receipt.error?.code !== 'operation_result_unknown') continue;
        let current = scope.current, proof = await publicationProof(record, current);
        if (!proof && record.receipt.kind === 'settings' && current.revision === record.receipt.expectedSettingsRevision) {
          // Only an already requested publication can finish its original CAS; no key or intent is regenerated.
          const next = validateProductSettings(record.nextSettings);
          if (!next.ok) return failure('service_credential_operation_unavailable');
          const provisional = { ...current, ...next.data, revision: current.revision + 1 };
          if (await publicationProof(record, provisional)) {
            const saved = await scope.save(next.data, { notifyConditionsChanged: false }); if (!saved.ok) return failure('service_credential_publication_pending');
            current = saved.data; proof = await publicationProof(record, current);
          }
        }
        if (!proof) {
          const intent = await readIntent(record);
          const originalRevision = current.revision === intent.before.revision && isDeepStrictEqual(current, intent.before);
          const committedRevision = intent.kind === 'settings' && current.revision === intent.before.revision + 1 && sameSettings(current, intent.next);
          if (!originalRevision && !committedRevision) return failure('config_revision_conflict', 'input');
          // Resume only the sealed publication already requested before the interruption; prepared-only stages remain untouched.
          await publish(record, intent);
          if (intent.kind === 'settings' && originalRevision) {
            const saved = await scope.save(intent.next, { notifyConditionsChanged: false }); if (!saved.ok) return failure('service_credential_publication_pending');
            current = saved.data;
          }
          proof = await publicationProof(record, current);
        }
        if (!proof) return failure('service_credential_publication_pending');
        record.receipt = proof; await writeRecord(record); scope.conditionsChanged();
      }
      return ok(undefined);
    } catch { return failure('service_credential_operation_unavailable'); }
  }
  async function original(request: ServiceCredentialMigrationRequest | ServiceCredentialSettingsRequest, kind: 'migration' | 'settings') {
    const record = await readRecord(request.operationId); if (!record) return null;
    const intent = await readIntent(record);
    if (intent.kind !== kind || !isDeepStrictEqual(intent.request, request)) throw Error('service_credential_operation_conflict');
    return { record, intent };
  }
  async function createRecord(request: ServiceCredentialMigrationRequest | ServiceCredentialSettingsRequest, intent: Intent): Promise<OperationRecord> {
    if (!await ports.secureStorage.isAvailable()) throw Error('credential_storage_unavailable');
    const sealedIntent = Buffer.from(await ports.secureStorage.encrypt(JSON.stringify(intent))).toString('base64');
    const record: OperationRecord = { version: 1, dataRoot, sealedIntent, commitRequested: false, nextSettings: intent.next,
      receipt: { version: 1, installationId,
      operationId: request.operationId, kind: intent.kind, phase: 'pending', expectedSettingsRevision: intent.before.revision,
      settingsRevision: intent.before.revision, models: intent.credentials.map(entry => ({ modelId: entry.modelId,
        credentialRef: entry.credentialRef, state: entry.value === null ? 'missing' : 'pending' })), settings: null, error: null } };
    await writeRecord(record); return record;
  }
  const key = (raw: unknown) => { const parsed = ServiceCredentialOperationQuerySchema.safeParse(raw);
    return parsed.success && parsed.data.installationId === installationId ? parsed.data : null; };
  ports.settingsAuthority.setCredentialRecoveryHook(recover);

  return {
    async getStatus(): Promise<Result<ServiceCredentialStatus>> {
      try {
        await boundary(false); const current = await settings();
        const models: ServiceCredentialStatus['models'] = [];
        for (const model of current.models) {
          const file = finalFile(model.credentialRef); let status: ServiceCredentialStatus['models'][number]['status'] = 'unavailable';
          try {
            await fileExists(file); const value = await createCredentialStore(file, ports.secureStorage).read();
            if (value.ok) { if (value.data === null) status = 'missing'; else if (credentialSchema.safeParse(JSON.parse(value.data)).success) status = 'configured'; }
          } catch { /* Current status stays unavailable; no secret or filesystem detail leaves this boundary. */ }
          models.push({ modelId: model.id, credentialRef: model.credentialRef, status });
        }
        return ok({ installationId, settingsRevision: current.revision, models });
      } catch { return failure('service_credential_status_unavailable'); }
    },
    async queryOperation(raw: ServiceCredentialOperationQuery): Promise<Result<ServiceCredentialOperationReceipt | null>> {
      const input = key(raw); if (!input) return failure('service_credential_request_invalid', 'input');
      try {
        const record = await readRecord(input.operationId);
        if (!record || record.receipt.phase === 'committed' || !record.commitRequested) return ok(record?.receipt ?? null);
        return ok(await publicationProof(record, await settings()) ?? record.receipt);
      }
      catch { return failure('service_credential_operation_unavailable'); }
    },
    prepareMigration(raw: ServiceCredentialMigrationRequest): Promise<Result<ServiceCredentialOperationReceipt>> {
      return mutate(async () => {
        const parsed = ServiceCredentialMigrationRequestSchema.safeParse(raw);
        if (!parsed.success || parsed.data.installationId !== installationId
          || Buffer.byteLength(JSON.stringify(parsed.data)) > 1_000_000) return failure('service_credential_request_invalid', 'input');
        let record: OperationRecord | undefined;
        try {
          const input = parsed.data, prior = await original(input, 'migration');
          if (prior) {
            if (['prepared', 'committed'].includes(prior.record.receipt.phase)) return ok(prior.record.receipt);
            record = prior.record; await stage(record, prior.intent); return ok(record.receipt);
          }
          const current = await settings();
          if (input.expectedSettingsRevision !== current.revision) return failure('config_revision_conflict', 'input');
          if (input.credentials.length !== current.models.length || new Set(input.credentials.map(entry => entry.modelId)).size !== current.models.length
            || input.credentials.some(entry => !current.models.some(model => model.id === entry.modelId && model.credentialRef === entry.credentialRef)))
            return failure('service_credential_models_changed', 'input');
          const intent: Intent = { version: 1, installationId, dataRoot, kind: 'migration', request: input, before: current, next: current,
            credentials: input.credentials.map(entry => ({ ...entry, value: entry.value === null ? null : normalizeCredential(entry.value) })) };
          record = await createRecord(input, intent); await stage(record, intent); return ok(record.receipt);
        } catch (cause) { return failed(record, cause instanceof Error && cause.message === 'service_credential_operation_conflict'
          ? cause.message : 'service_credential_prepare_failed'); }
      });
    },
    commitMigration(raw: ServiceCredentialOperationQuery): Promise<Result<ServiceCredentialOperationReceipt>> {
      return mutate(() => ports.settingsAuthority.withSettingsWrite(async scope => {
        const input = key(raw); if (!input) return failure('service_credential_request_invalid', 'input');
        let record: OperationRecord | undefined;
        try {
          record = await readRecord(input.operationId) ?? undefined;
          if (!record || record.receipt.kind !== 'migration') return failure('service_credential_operation_missing', 'input');
          if (record.receipt.phase === 'committed') return ok(record.receipt);
          if (record.receipt.models.some(model => model.state === 'pending')) return failure('service_credential_not_prepared', 'input');
          const intent = await readIntent(record), current = scope.current;
          if (current.revision !== intent.before.revision || !isDeepStrictEqual(current, intent.before)) return failure('config_revision_conflict', 'input');
          record.commitRequested = true; await writeRecord(record);
          await publish(record, intent); record.receipt.phase = 'committed'; record.receipt.error = null;
          await writeRecord(record); scope.conditionsChanged(); return ok(record.receipt);
        } catch { return failed(record, 'service_credential_publish_failed'); }
      }));
    },
    saveSettings(raw: ServiceCredentialSettingsRequest): Promise<Result<ServiceCredentialOperationReceipt>> {
      return mutate(() => ports.settingsAuthority.withSettingsWrite(async scope => {
        const parsed = ServiceCredentialSettingsRequestSchema.safeParse(raw);
        if (!parsed.success || parsed.data.installationId !== installationId) return failure('service_credential_request_invalid', 'input');
        let record: OperationRecord | undefined;
        try {
          const input = JSON.parse(JSON.stringify(parsed.data)) as ServiceCredentialSettingsRequest;
          const prior = await original(input, 'settings'); let intent: Intent;
          if (prior) { record = prior.record; intent = prior.intent; if (record.receipt.phase === 'committed') return ok(record.receipt); }
          else {
            const current = scope.current, raw = input.settings;
            if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return failure('config_settings_invalid', 'input');
            const submitted = raw as Record<string, unknown>, evaluation = current.evaluation ?? { agent: null, judge: null };
            if (Object.hasOwn(submitted, 'evaluation') && !isDeepStrictEqual(submitted.evaluation, evaluation)) return failure('evaluation_settings_separate', 'input');
            const validated = validateProductSettings({ ...submitted, evaluation }); if (!validated.ok) return failure('config_settings_invalid', 'input');
            if (validated.data.revision !== current.revision) return failure('config_revision_conflict', 'input');
            let foundUpdate = !input.credentialUpdate;
            const next = { ...validated.data, models: validated.data.models.map(model => {
              const before = current.models.find(value => value.id === model.id);
              const sameTarget = before?.kind === model.kind && (model.kind === 'catalog' ? before.providerId === model.providerId
                : model.kind === 'custom' ? before.baseUrl === model.baseUrl && before.api === model.api : true);
              const updated = input.credentialUpdate?.modelId === model.id; if (updated) foundUpdate = true;
              return { ...model, credentialRef: updated || !sameTarget ? randomUUID().replaceAll('-', '') : before!.credentialRef };
            }) };
            if (!foundUpdate) return failure('credential_model_missing', 'input');
            const checked = validateProductSettings(next); if (!checked.ok) return failure('config_settings_invalid', 'input');
            const update = input.credentialUpdate, target = update ? checked.data.models.find(model => model.id === update.modelId)! : null;
            intent = { version: 1, installationId, dataRoot, kind: 'settings', request: input, before: current, next: checked.data,
              credentials: update && target ? [{ modelId: target.id, credentialRef: target.credentialRef,
                value: JSON.stringify({ type: 'api_key', key: update.apiKey }) }] : [] };
            record = await createRecord(input, intent);
          }
          const current = scope.current;
          if (current.revision === intent.before.revision + 1 && sameSettings(current, intent.next)) {
            const proof = await publicationProof(record, current);
            if (!proof) return failed(record, 'operation_result_unknown');
            record.receipt = proof;
            await writeRecord(record); scope.conditionsChanged(); return ok(record.receipt);
          }
          if (current.revision !== intent.before.revision) return failed(record, 'config_revision_conflict');
          await stage(record, intent); record.commitRequested = true; await writeRecord(record); await publish(record, intent);
          let saved: Result<ProductSettings>;
          try { saved = await scope.save(intent.next, { notifyConditionsChanged: false }); } catch { saved = failure('operation_result_unknown'); }
          const observed = await settings();
          if (observed.revision !== intent.before.revision + 1 || !sameSettings(observed, intent.next))
            return failed(record, saved.ok ? 'operation_result_unknown' : 'service_credential_publish_failed');
          record.receipt.phase = 'committed'; record.receipt.settingsRevision = observed.revision; record.receipt.error = null;
          record.receipt.settings = structuredClone(observed);
          await writeRecord(record); scope.conditionsChanged(); return ok(record.receipt);
        } catch (cause) { return failed(record, cause instanceof Error && cause.message === 'service_credential_operation_conflict'
          ? cause.message : 'service_credential_save_failed'); }
      }));
    },
  };
}

export type ServiceCredentialService = ReturnType<typeof createServiceCredentialService>;
