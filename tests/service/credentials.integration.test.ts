import { expect, it, mock } from 'bun:test';
import { randomUUID } from 'node:crypto';
import * as files from 'node:fs/promises';
import { access, mkdir, readFile, readdir, rename, rmdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { appError, fail, type ProductSettings, type Result } from '@flowmate/contracts';
import { createServiceCredentialService } from '../../packages/core/src/configuration/service-credentials.ts';
import type { ServiceCredentialSettingsAuthority, ServiceCredentialSettingsScope } from '../../packages/core/src/configuration/service-credentials.ts';
import { defaultProductSettings, readProductSettings, saveProductSettings } from '../../packages/core/src/configuration/settings.ts';
import { createCredentialStore, type SecureStoragePort } from '../../packages/shared/src/secure-credential-store.ts';
import { createServiceSecureStorage } from '../../packages/shared/src/service-secure-storage.ts';
import { readCurrentWindowsSid } from '../../packages/shared/src/windows-identity.ts';
import { mkdtemp } from '../support/resources.ts';

const reference = 'legacy-model-reference_1234', missingReference = 'missing-model-reference_1234';
const originalKey = 'synthetic-original-service-key';
const actualFiles = { ...files };
let receiptWriteFault: { target: string; remaining: number } | null = null;
mock.module('node:fs/promises', () => ({ ...actualFiles, rename: async (...paths: Parameters<typeof rename>) => {
  if (receiptWriteFault && paths[1] === receiptWriteFault.target && receiptWriteFault.remaining > 0) {
    const record: { receipt?: { phase?: string } } = JSON.parse(await actualFiles.readFile(paths[0], 'utf8'));
    if (record.receipt?.phase === 'committed') { receiptWriteFault.remaining--; throw Object.assign(Error('synthetic_receipt_write_failed'), { code: 'EIO' }); }
  }
  return actualFiles.rename(...paths);
} }));
const oldStorage: SecureStoragePort = { isAvailable: async () => true,
  encrypt: async value => Buffer.from('old-electron:' + value),
  decrypt: async value => ({ plaintext: Buffer.from(value).toString().slice('old-electron:'.length), shouldReEncrypt: false }) };

function need<T>(value: Result<T>): T { if (!value.ok) throw Error(value.error.code); return value.data; }
const key = (value: { installationId: string; operationId: string }) => ({ installationId: value.installationId, operationId: value.operationId });
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'flowmate-service-migration-')), settingsFile = join(root, 'data/settings.json');
  await mkdir(join(root, 'data'), { recursive: true });
  const model = { id: 'local-model', name: 'Local model', kind: 'custom' as const, providerId: null,
    credentialRef: reference, baseUrl: 'http://127.0.0.1:9/v1', model: 'controlled', api: 'openai-completions',
    contextWindow: 64000, maxTokens: 8192, reasoning: false };
  const settings = { ...defaultProductSettings(), models: [model, { ...model, id: 'missing-model', credentialRef: missingReference }], defaultModelId: model.id };
  await writeFile(settingsFile, JSON.stringify(settings));
  const identity = need(await readCurrentWindowsSid()), native = createServiceSecureStorage(identity);
  const controls = { protectFailure: false, decryptFailure: false, unavailable: false, publishFailure: false, throwAfterPublish: false,
    decrypts: 0, reads: 0, saves: 0, changed: 0 };
  const hooks: { afterDecrypt: ((plaintext: string) => Promise<void>) | null } = { afterDecrypt: null };
  const storage: SecureStoragePort = { isAvailable: async () => !controls.unavailable && native.isAvailable(),
    encrypt: async value => { if (controls.protectFailure) throw Error('PRIVATE_PROTECT_PATH'); return native.encrypt(value); },
    decrypt: async value => {
      controls.decrypts++; if (controls.decryptFailure) throw Error('PRIVATE_DECRYPT_PATH');
      const restored = await native.decrypt(value); await hooks.afterDecrypt?.(restored.plaintext); return restored;
    } };
  const oldFile = join(root, 'security/credentials', reference + '.json'), old = createCredentialStore(oldFile, oldStorage);
  need(await old.write(originalKey));
  const installationId = randomUUID();
  let queue = Promise.resolve(), recovery: ((scope: ServiceCredentialSettingsScope) => Promise<Result<void>>) | undefined;
  const authority: ServiceCredentialSettingsAuthority = {
    readSettings: async () => { controls.reads++; return readProductSettings(settingsFile); },
    withSettingsWrite<T>(action: (scope: ServiceCredentialSettingsScope) => Promise<Result<T>>): Promise<Result<T>> {
      const pending = queue.then(async () => {
        const current = need(await readProductSettings(settingsFile));
        const scope: ServiceCredentialSettingsScope = { current, conditionsChanged: () => { controls.changed++; }, save: async next => {
      controls.saves++;
      if (controls.publishFailure) return fail(appError('config_settings_write_failed', 'storage', 'PRIVATE_PUBLISH_PATH'));
      const saved = await saveProductSettings(settingsFile, next);
      if (controls.throwAfterPublish) throw Error('PRIVATE_TIMEOUT_PATH');
      return saved;
        } };
        const recovered = await recovery?.(scope); if (recovered && !recovered.ok) return recovered;
        return action({ ...scope, current: need(await readProductSettings(settingsFile)) });
      });
      queue = pending.then(() => undefined, () => undefined); return pending;
    }, setCredentialRecoveryHook(hook) { recovery = hook; },
  };
  const options = { installationId, dataRoot: root, secureStorage: storage, settingsAuthority: authority };
  const service = createServiceCredentialService(options);
  const request = { installationId, operationId: randomUUID(), expectedSettingsRevision: settings.revision,
    credentials: [{ modelId: 'local-model', credentialRef: reference, value: need(await old.read()) },
      { modelId: 'missing-model', credentialRef: missingReference, value: null }] };
  return { root, settings, settingsFile, oldFile, old, identity, controls, hooks, options, service, request,
    current: (ref = reference) => createCredentialStore(join(root, 'security/service-credentials', ref + '.json'), native) };
}

async function interruptPublication(f: Awaited<ReturnType<typeof fixture>>, operationId: string, afterFiles: number,
  settingsRequest?: { installationId: string; operationId: string; settings: ProductSettings; credentialUpdate: { modelId: string; apiKey: string } }) {
  const child = Bun.spawn([process.execPath, '--no-env-file', '--eval', `
    const input=await new Response(Bun.stdin.stream()).json();
    const files=await import('node:fs/promises'),original={...files},path=await import('node:path');
    const {mock}=await import('bun:test');let published=0;
    mock.module('node:fs/promises',()=>({...original,rename:async(...paths)=>{
      if(typeof paths[1]==='string'&&path.dirname(paths[1])===path.join(input.dataRoot,'security/service-credentials')){
        if(input.afterFiles===0)process.exit(79);
        await original.rename(...paths);if(++published===input.afterFiles)process.exit(79);return;
      }
      return original.rename(...paths);
    }}));
    const {createServiceCredentialService}=await import(input.core),{createServiceSecureStorage}=await import(input.storage);
    const {readProductSettings,saveProductSettings}=await import(input.settingsModule);let recovery;
    const settingsFile=path.join(input.dataRoot,'data/settings.json');
    const authority={readSettings:()=>readProductSettings(settingsFile),setCredentialRecoveryHook:hook=>{recovery=hook},
      withSettingsWrite:async action=>{
        const current=await readProductSettings(settingsFile);if(!current.ok)return current;
        const scope={current:current.data,save:next=>saveProductSettings(settingsFile,next),conditionsChanged:()=>{}};
        const checked=await recovery?.(scope);return checked&&!checked.ok?checked:action(scope);
      }};
    const service=createServiceCredentialService({installationId:input.installationId,dataRoot:input.dataRoot,
      secureStorage:createServiceSecureStorage(input.ownerSid),settingsAuthority:authority});
    const result=input.settingsRequest?await service.saveSettings(input.settingsRequest)
      :await service.commitMigration({installationId:input.installationId,operationId:input.operationId});
    process.stdout.write(JSON.stringify(result));process.exitCode=1;
  `], { stdin: 'pipe', stdout: 'pipe', stderr: 'pipe', env: {} });
  child.stdin.write(JSON.stringify({ installationId: f.request.installationId, dataRoot: f.root, ownerSid: f.identity,
    operationId, afterFiles, settingsRequest, core: new URL('../../packages/core/src/configuration/service-credentials.ts', import.meta.url).href,
    storage: new URL('../../packages/shared/src/service-secure-storage.ts', import.meta.url).href,
    settingsModule: new URL('../../packages/core/src/configuration/settings.ts', import.meta.url).href })); child.stdin.end();
  const [code, stdout, stderr] = await Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()]);
  expect({ code, stdout, stderr }).toEqual({ code: 79, stdout: '', stderr: '' });
}

it('prepares actual CurrentUser ciphertext, then explicitly publishes the same logical refs without changing old credentials or settings', async () => {
  const f = await fixture(), original = await readFile(f.oldFile, 'utf8');
  const prepared = need(await f.service.prepareMigration(f.request));
  expect(prepared).toMatchObject({ version: 1, installationId: f.request.installationId, operationId: f.request.operationId,
    kind: 'migration', phase: 'prepared', settingsRevision: 0 });
  expect(await f.current().read()).toEqual({ ok: true, data: null });
  expect(f.controls.changed).toBe(0);
  expect(need(await f.service.queryOperation(key(f.request)))).toEqual(prepared);
  const committed = need(await f.service.commitMigration(key(f.request)));
  expect(committed).toMatchObject({ phase: 'committed', settingsRevision: 0 });
  expect(JSON.parse(need(await f.current().read())!)).toEqual({ type: 'api_key', key: originalKey });
  expect(await f.current(missingReference).read()).toEqual({ ok: true, data: null });
  expect(need(await readProductSettings(f.settingsFile))).toEqual(f.settings);
  expect(await readFile(f.oldFile, 'utf8')).toBe(original); expect(f.controls.changed).toBe(1); expect(f.controls.saves).toBe(0);
  const status = need(await f.service.getStatus());
  expect(status).toEqual({ installationId: f.request.installationId, settingsRevision: 0,
    models: [{ modelId: 'local-model', credentialRef: reference, status: 'configured' },
      { modelId: 'missing-model', credentialRef: missingReference, status: 'missing' }] });
  expect(JSON.stringify([prepared, committed, status])).not.toContain(originalKey);
  expect(JSON.stringify([prepared, committed, status])).not.toContain(f.root);
});

it('looks up the original operation without decrypting, mutating settings, notifying or scheduling after an unknown response', async () => {
  const f = await fixture(); need(await f.service.prepareMigration(f.request));
  const replacement = createServiceCredentialService(f.options), before = { ...f.controls };
  const receipt = need(await replacement.queryOperation({ installationId: f.request.installationId, operationId: f.request.operationId }));
  if (receipt === null) throw Error('original_operation_missing');
  expect(receipt?.phase).toBe('prepared'); expect(f.controls).toEqual(before);
  expect(need(await replacement.prepareMigration(f.request))).toEqual(receipt);
  const changed = await replacement.prepareMigration({ ...f.request, credentials: f.request.credentials.map(value =>
    value.modelId === 'local-model' ? { ...value, value: 'different-synthetic-secret' } : value) });
  expect(changed).toMatchObject({ ok: false, error: { code: 'service_credential_operation_conflict' } });
  need(await replacement.commitMigration(key(f.request)));
  const changedCount = f.controls.changed;
  expect(need(await replacement.commitMigration(key(f.request))).phase).toBe('committed'); expect(f.controls.changed).toBe(changedCount);
});

it('refuses foreign installation, revision, model, reference, evaluation and corrupt configured credentials before publishing', async () => {
  const f = await fixture();
  for (const patch of [{ installationId: randomUUID() }, { expectedSettingsRevision: 99 },
    { credentials: [{ modelId: 'evaluation-agent', credentialRef: reference, value: originalKey }] },
    { credentials: [{ modelId: 'local-model', credentialRef: '../outside', value: originalKey }] },
    { credentials: f.request.credentials.map(value => value.modelId === 'local-model' ? { ...value, value: 'pi-credential-v1:{invalid' } : value) }]) {
    expect((await f.service.prepareMigration({ ...f.request, ...patch })).ok).toBe(false);
  }
  expect(await f.current().read()).toEqual({ ok: true, data: null }); expect(f.controls.changed).toBe(0);
  const wrongAccount = createServiceCredentialService({ ...f.options, secureStorage: createServiceSecureStorage('S-1-0-0') });
  expect((await wrongAccount.prepareMigration(f.request)).ok).toBe(false);
});

it('keeps original files and refuses plaintext fallback on unavailable protection, protect failure and staged readback failure', async () => {
  for (const fault of ['unavailable', 'protectFailure', 'decryptFailure'] as const) {
    const f = await fixture(), old = await readFile(f.oldFile, 'utf8'); f.controls[fault] = true;
    const result = await f.service.prepareMigration(f.request);
    expect(result.ok).toBe(false); expect(JSON.stringify(result)).not.toContain('PRIVATE_');
    expect(await readFile(f.oldFile, 'utf8')).toBe(old); expect(f.controls.changed).toBe(0);
    expect(need(await readProductSettings(f.settingsFile))).toEqual(f.settings);
  }
});

it('publishes captured missing intent without reusing a preexisting service secret and keeps its ciphertext backup', async () => {
  const f = await fixture(); need(await f.current(missingReference).write(JSON.stringify({ type: 'api_key', key: 'stale-service-key' })));
  const stale = await readFile(join(f.root, 'security/service-credentials', missingReference + '.json'), 'utf8');
  need(await f.service.prepareMigration(f.request)); need(await f.service.commitMigration(key(f.request)));
  expect(await f.current(missingReference).read()).toEqual({ ok: true, data: null });
  const backup = join(f.root, 'security/service-credentials/operations', f.request.operationId, 'previous', missingReference + '.json');
  expect(await readFile(backup, 'utf8')).toBe(stale);
});

it('rotates an actual key to a new ref through the original CAS authority and publishes one durable receipt', async () => {
  const f = await fixture(); need(await f.service.prepareMigration(f.request)); need(await f.service.commitMigration(key(f.request)));
  const request = { installationId: f.request.installationId, operationId: randomUUID(), settings: f.settings,
    credentialUpdate: { modelId: 'local-model', apiKey: 'synthetic-replacement-key' } };
  const result = need(await f.service.saveSettings(request)); expect(result.phase).toBe('committed'); expect(result.settingsRevision).toBe(1);
  const settings = need(await readProductSettings(f.settingsFile)), rotated = settings.models.find(model => model.id === 'local-model')!;
  expect(rotated.credentialRef).not.toBe(reference);
  expect(JSON.parse(need(await f.current(rotated.credentialRef).read())!)).toEqual({ type: 'api_key', key: 'synthetic-replacement-key' });
  const before = { ...f.controls }; expect(need(await f.service.queryOperation(key(request)))).toEqual(result); expect(f.controls).toEqual(before);
  expect(need(await f.service.saveSettings(request))).toEqual(result); expect(f.controls.saves).toBe(1);
});

it('does not publish a new key reference or notify when settings publication fails after ciphertext staging', async () => {
  const f = await fixture(); f.controls.publishFailure = true;
  const request = { installationId: f.request.installationId, operationId: randomUUID(), settings: f.settings,
    credentialUpdate: { modelId: 'local-model', apiKey: 'synthetic-unpublished-key' } };
  const result = await f.service.saveSettings(request); expect(result.ok).toBe(false); expect(JSON.stringify(result)).not.toContain('PRIVATE_');
  expect(need(await readProductSettings(f.settingsFile))).toEqual(f.settings); expect(f.controls.changed).toBe(0);
  expect(need(await f.service.queryOperation(key(request)))).toMatchObject({ phase: 'failed' });
});

it('recovers the original settings receipt after a response loss without a second CAS or key rotation', async () => {
  const f = await fixture(); f.controls.throwAfterPublish = true;
  const request = { installationId: f.request.installationId, operationId: randomUUID(), settings: f.settings,
    credentialUpdate: { modelId: 'local-model', apiKey: 'synthetic-once-key' } };
  const result = need(await f.service.saveSettings(request)); expect(result.phase).toBe('committed');
  const reference = need(await readProductSettings(f.settingsFile)).models[0]!.credentialRef;
  expect(need(await f.service.saveSettings(request))).toEqual(result);
  expect(need(await readProductSettings(f.settingsFile)).models[0]!.credentialRef).toBe(reference); expect(f.controls.saves).toBe(1);
  const files = await readdir(join(f.root, 'security/service-credentials/operations'));
  expect(files.some(name => name.endsWith('.tmp'))).toBe(false);
});

it('proves publication across the settings-to-receipt gap without decrypting and seals it before native credential overwrite', async () => {
  const f = await fixture(), request = { installationId: f.request.installationId, operationId: randomUUID(), settings: f.settings,
    credentialUpdate: { modelId: 'local-model', apiKey: 'synthetic-publication-gap-key' } };
  const committed = need(await f.service.saveSettings(request));
  const file = join(f.root, 'security/service-credentials/operations', request.operationId + '.json');
  const raw = await readFile(file, 'utf8'); expect(raw).not.toContain(request.credentialUpdate.apiKey);
  const record: { receipt: { phase: string; settingsRevision: number; settings: unknown; models: Array<{ state: string }> }; commitRequested: boolean } = JSON.parse(raw);
  record.receipt.phase = 'prepared'; record.receipt.settingsRevision = 0; record.receipt.settings = null;
  record.receipt.models.forEach(model => { if (model.state === 'published') model.state = 'prepared'; });
  await writeFile(file, JSON.stringify(record));
  f.controls.decryptFailure = true; const before = { ...f.controls };
  expect(need(await f.service.queryOperation(key(request)))).toEqual(committed);
  expect(f.controls.decrypts).toBe(before.decrypts); expect(f.controls.saves).toBe(before.saves); expect(f.controls.changed).toBe(before.changed);
  const targetRef = need(await readProductSettings(f.settingsFile)).models[0]!.credentialRef;
  need(await f.options.settingsAuthority.withSettingsWrite(async () => f.current(targetRef).write(JSON.stringify({ type: 'api_key', key: 'synthetic-native-updated-key' }))));
  expect(f.controls.decrypts).toBe(before.decrypts); expect(f.controls.changed).toBe(before.changed + 1);
  expect(JSON.parse(await readFile(file, 'utf8')).receipt.phase).toBe('committed');
  expect(need(await f.service.queryOperation(key(request)))).toEqual(committed);
});

it('finishes only the originally requested settings CAS before a later queued write can replace its publication proof', async () => {
  const f = await fixture(), request = { installationId: f.request.installationId, operationId: randomUUID(), settings: f.settings,
    credentialUpdate: { modelId: 'local-model', apiKey: 'synthetic-before-cas-key' } };
  const committed = need(await f.service.saveSettings(request)), publishedRef = need(await readProductSettings(f.settingsFile)).models[0]!.credentialRef;
  const file = join(f.root, 'security/service-credentials/operations', request.operationId + '.json');
  const record: { receipt: { phase: string; settingsRevision: number; settings: unknown; models: Array<{ state: string }> } } = JSON.parse(await readFile(file, 'utf8'));
  record.receipt.phase = 'prepared'; record.receipt.settingsRevision = 0; record.receipt.settings = null;
  record.receipt.models.forEach(model => { if (model.state === 'published') model.state = 'prepared'; });
  await writeFile(file, JSON.stringify(record)); await writeFile(f.settingsFile, JSON.stringify(f.settings));
  f.controls.saves = 0; f.controls.decryptFailure = true;
  const saved = need(await f.options.settingsAuthority.withSettingsWrite(async scope => scope.save({ ...scope.current,
    profile: { ...scope.current.profile, displayName: 'Later settings change' } })));
  expect(saved.revision).toBe(2); expect(saved.models[0]!.credentialRef).toBe(publishedRef); expect(f.controls.saves).toBe(2);
  const recovered = need(await f.service.queryOperation(key(request)));
  expect(recovered).toMatchObject({ operationId: committed.operationId, phase: 'committed', settingsRevision: 1,
    settings: { revision: 1, profile: f.settings.profile, models: [{ ...f.settings.models[0]!, credentialRef: publishedRef }, f.settings.models[1]] } });
});

it('reports a corrupt current ciphertext as unavailable and rejects an operation file from another bound root', async () => {
  const f = await fixture(); need(await f.service.prepareMigration(f.request)); need(await f.service.commitMigration(key(f.request)));
  const file = join(f.root, 'security/service-credentials', reference + '.json');
  const envelope: { ciphertext: string } = JSON.parse(await readFile(file, 'utf8'));
  envelope.ciphertext = Buffer.from('corrupt-current-ciphertext').toString('base64'); await writeFile(file, JSON.stringify(envelope));
  expect(need(await f.service.getStatus()).models[0]!.status).toBe('unavailable');
  const operation = join(f.root, 'security/service-credentials/operations', f.request.operationId + '.json');
  const record: { dataRoot: string } = JSON.parse(await readFile(operation, 'utf8'));
  record.dataRoot += '-foreign'; await writeFile(operation, JSON.stringify(record));
  const result = await f.service.queryOperation(key(f.request)); expect(result.ok).toBe(false);
  expect(JSON.stringify(result)).not.toContain(f.root); expect(JSON.stringify(result)).not.toContain(originalKey);
});

it('publishes a new same-value migration proof before a lost receipt can block a later settings writer', async () => {
  const f = await fixture(), old = await readFile(f.oldFile, 'utf8');
  need(await f.service.prepareMigration(f.request)); const first = need(await f.service.commitMigration(key(f.request)));
  const target = join(f.root, 'security/service-credentials', reference + '.json');
  const ciphertext: unknown = JSON.parse(await readFile(target, 'utf8')).ciphertext;
  const second = { ...f.request, operationId: randomUUID() }; need(await f.service.prepareMigration(second));
  const operation = join(f.root, 'security/service-credentials/operations', second.operationId + '.json'), held = operation + '.held';
  let reads = 0;
  f.hooks.afterDecrypt = async plaintext => {
    if (plaintext !== JSON.stringify({ type: 'api_key', key: originalKey }) || ++reads !== 2) return;
    // Hold the actual pending receipt only after the published credential has passed its final readback.
    await rename(operation, held); await mkdir(operation);
  };
  const lost = await f.service.commitMigration(key(second)); f.hooks.afterDecrypt = null;
  expect(lost).toMatchObject({ ok: false, error: { code: 'operation_result_unknown' } }); expect(reads).toBe(2);
  await rmdir(operation); await rename(held, operation);
  f.controls.decryptFailure = true; const decrypts = f.controls.decrypts;
  const recovered = need(await f.service.queryOperation(key(second)));
  expect(recovered).toMatchObject({ operationId: second.operationId, phase: 'committed' }); expect(f.controls.decrypts).toBe(decrypts);
  need(await f.options.settingsAuthority.withSettingsWrite(scope => scope.save({ ...scope.current,
    profile: { ...scope.current.profile, displayName: 'After same-value migration' } })));
  expect(need(await f.service.queryOperation(key(second)))).toEqual(recovered);
  expect(need(await f.service.queryOperation(key(f.request)))).toEqual(first);
  expect(JSON.parse(await readFile(target, 'utf8')).ciphertext).toBe(ciphertext);
  expect(await readFile(f.oldFile, 'utf8')).toBe(old);
});

it('retains an original committed operation after a one-shot committed-receipt failure and a later writer', async () => {
  for (const kind of ['migration', 'settings'] as const) {
    const f = await fixture();
    if (kind === 'migration') need(await f.service.prepareMigration(f.request));
    const operation = join(f.root, 'security/service-credentials/operations', f.request.operationId + '.json');
    receiptWriteFault = { target: operation, remaining: 1 };
    let lost: Awaited<ReturnType<typeof f.service.commitMigration>>;
    try {
      lost = kind === 'migration' ? await f.service.commitMigration(key(f.request))
        : await f.service.saveSettings({ ...key(f.request), settings: f.settings,
          credentialUpdate: { modelId: 'local-model', apiKey: 'synthetic-one-shot-settings-key' } });
      expect(receiptWriteFault.remaining).toBe(0);
    } finally { receiptWriteFault = null; }
    expect(lost.ok).toBe(false);
    const metadata: { receipt: { phase: string; error: { code: string } | null } } = JSON.parse(await readFile(operation, 'utf8'));
    expect(metadata.receipt.phase).toBe('failed'); expect(metadata.receipt.error?.code).toBe('operation_result_unknown');
    f.controls.decryptFailure = true; const decrypts = f.controls.decrypts;
    const committed = need(await f.service.queryOperation(key(f.request)));
    expect(committed).toMatchObject({ phase: 'committed', operationId: f.request.operationId }); expect(f.controls.decrypts).toBe(decrypts);
    need(await f.options.settingsAuthority.withSettingsWrite(scope => scope.save({ ...scope.current,
      profile: { ...scope.current.profile, displayName: 'After original receipt recovery' } })));
    expect(need(await f.service.queryOperation(key(f.request)))).toEqual(committed);
    expect(f.controls.decrypts).toBe(decrypts);
  }
});

for (const afterFiles of [0, 1]) it('resumes the original migration after process loss at published file count ' + afterFiles, async () => {
    const f = await fixture(), secondOld = createCredentialStore(join(f.root, 'security/credentials', missingReference + '.json'), oldStorage);
    need(await secondOld.write('synthetic-second-original-key'));
    const secondValue = need(await secondOld.read());
    const request = { ...f.request, credentials: f.request.credentials.map(entry => entry.modelId === 'missing-model'
      ? { ...entry, value: secondValue } : entry) };
    const beforeSettings = await readFile(f.settingsFile, 'utf8'), old = await readFile(f.oldFile, 'utf8');
    need(await f.service.prepareMigration(request));
    await interruptPublication(f, request.operationId, afterFiles);
    const operation = join(f.root, 'security/service-credentials/operations', request.operationId + '.json');
    const pending: { commitRequested: boolean; sealedIntent: string } = JSON.parse(await readFile(operation, 'utf8'));
    expect(pending.commitRequested).toBe(true);
    expect(await access(join(f.root, 'security/service-credentials', reference + '.json')).then(() => true, () => false)).toBe(afterFiles === 1);
    expect(await access(join(f.root, 'security/service-credentials', missingReference + '.json')).then(() => true, () => false)).toBe(false);
    const resumed = createServiceCredentialService(f.options), beforeDecrypts = f.controls.decrypts;
    expect(need(await resumed.queryOperation(key(request)))?.phase).toBe('prepared'); expect(f.controls.decrypts).toBe(beforeDecrypts);
    expect(await readFile(f.settingsFile, 'utf8')).toBe(beforeSettings); expect(f.controls.changed).toBe(0);
    expect(need(await resumed.commitMigration(key(request)))).toMatchObject({ phase: 'committed', operationId: request.operationId,
      models: [{ modelId: 'local-model', credentialRef: reference, state: 'published' },
        { modelId: 'missing-model', credentialRef: missingReference, state: 'published' }] });
    expect(JSON.parse(need(await f.current().read())!).key).toBe(originalKey);
    expect(JSON.parse(need(await f.current(missingReference).read())!).key).toBe('synthetic-second-original-key');
    expect(JSON.parse(await readFile(operation, 'utf8')).sealedIntent).toBe(pending.sealedIntent);
    expect(await readFile(f.settingsFile, 'utf8')).toBe(beforeSettings); expect(await readFile(f.oldFile, 'utf8')).toBe(old);
    need(await f.options.settingsAuthority.withSettingsWrite(scope => scope.save({ ...scope.current,
      profile: { ...scope.current.profile, displayName: 'After resumed publication' } })));
    const decrypts = f.controls.decrypts;
    expect(need(await resumed.queryOperation(key(request)))?.phase).toBe('committed'); expect(f.controls.decrypts).toBe(decrypts);
}, 30_000);

it('resumes an interrupted original settings publication with its allocated reference and CAS, without rotating again', async () => {
  const f = await fixture(), request = { ...key(f.request), settings: f.settings,
    credentialUpdate: { modelId: 'local-model', apiKey: 'synthetic-original-interrupted-update' } };
  await interruptPublication(f, request.operationId, 0, request);
  const operation = join(f.root, 'security/service-credentials/operations', request.operationId + '.json');
  const pending: { sealedIntent: string; receipt: { models: Array<{ credentialRef: string }> } } = JSON.parse(await readFile(operation, 'utf8'));
  const allocated = pending.receipt.models[0]!.credentialRef; expect(allocated).not.toBe(reference);
  const resumed = createServiceCredentialService(f.options), current = need(await readProductSettings(f.settingsFile));
  expect(current.revision).toBe(0); const decrypts = f.controls.decrypts;
  expect(need(await resumed.queryOperation(key(request)))?.phase).toBe('prepared'); expect(f.controls.decrypts).toBe(decrypts);
  const committed = need(await resumed.saveSettings(request));
  expect(committed).toMatchObject({ phase: 'committed', settingsRevision: 1, settings: { revision: 1,
    models: [{ ...f.settings.models[0]!, credentialRef: allocated }, f.settings.models[1]] } });
  expect(JSON.parse(need(await f.current(allocated).read())!).key).toBe(request.credentialUpdate.apiKey);
  expect(JSON.parse(await readFile(operation, 'utf8')).sealedIntent).toBe(pending.sealedIntent);
  expect(f.controls.saves).toBe(1);
  need(await f.options.settingsAuthority.withSettingsWrite(scope => scope.save({ ...scope.current,
    profile: { ...scope.current.profile, displayName: 'After resumed settings CAS' } })));
  expect(need(await resumed.queryOperation(key(request)))).toEqual(committed); expect(f.controls.saves).toBe(2);
}, 30_000);

it('keeps prepared-only ciphertext private across a settings write and refuses publishing it against a later revision', async () => {
  const f = await fixture(); need(await f.service.prepareMigration(f.request));
  const resumed = createServiceCredentialService(f.options);
  const changed = need(await f.options.settingsAuthority.withSettingsWrite(scope => scope.save({ ...scope.current,
    profile: { ...scope.current.profile, displayName: 'Changed before requesting publication' } })));
  expect(changed.revision).toBe(1); expect(await f.current().read()).toEqual({ ok: true, data: null });
  expect(await resumed.commitMigration(key(f.request))).toMatchObject({ ok: false, error: { code: 'config_revision_conflict' } });
  const decrypts = f.controls.decrypts;
  expect(need(await resumed.queryOperation(key(f.request)))?.phase).toBe('prepared'); expect(f.controls.decrypts).toBe(decrypts);
  expect(need(await readProductSettings(f.settingsFile))).toEqual(changed);
});

it('refuses resuming an interrupted publication under another SID or over a changed current configuration', async () => {
  const f = await fixture(); need(await f.service.prepareMigration(f.request)); await interruptPublication(f, f.request.operationId, 0);
  const wrongOwner = createServiceCredentialService({ ...f.options, secureStorage: createServiceSecureStorage('S-1-0-0') });
  expect((await wrongOwner.commitMigration(key(f.request))).ok).toBe(false);
  expect(await f.current().read()).toEqual({ ok: true, data: null });
  const changed = need(await saveProductSettings(f.settingsFile, { ...f.settings,
    profile: { ...f.settings.profile, displayName: 'Existing later configuration' } }));
  const preserved = await readFile(f.settingsFile, 'utf8'), resumed = createServiceCredentialService(f.options);
  expect(await resumed.commitMigration(key(f.request))).toMatchObject({ ok: false, error: { code: 'config_revision_conflict' } });
  expect(await readFile(f.settingsFile, 'utf8')).toBe(preserved); expect(need(await readProductSettings(f.settingsFile))).toEqual(changed);
  expect(await f.current().read()).toEqual({ ok: true, data: null }); expect(f.controls.changed).toBe(0);
}, 30_000);
