import { expect, test } from 'bun:test';
import { mkdir, mkdtemp, readFile, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { appError, fail } from '@flowmate/contracts';
import { createCredentialStore } from '../../packages/shared/src/secure-credential-store.ts';
import { defaultProductSettings, readProductSettings, saveProductSettings } from '../../packages/core/src/configuration/settings.ts';
import { saveEvaluationSettings as save, validateBusinessSettings as validate, type EvaluationSettingsPorts as Ports } from '../../apps/desktop/main/evaluation-settings.ts';
import * as implementation from '../../apps/desktop/main/evaluation-settings.ts';

const connection = { api: 'openai-completions' as const, baseUrl: 'https://synthetic.invalid/v1', model: 'synthetic-agent' };

async function fixture(withAgent = false) {
  const root = await mkdtemp(join(tmpdir(), 'p16-credentials-')), directory = join(root, 'security');
  await mkdir(directory);
  const credentialStore = (reference: string) => createCredentialStore(join(directory, reference + '.json'), {
    isAvailable: async () => true,
    encrypt: async plaintext => Buffer.from('controlled-cipher:' + plaintext),
    decrypt: async ciphertext => ({ plaintext: Buffer.from(ciphertext).toString().slice('controlled-cipher:'.length), shouldReEncrypt: false }),
  });
  const file = join(root, 'settings.json');
  const model = { id: 'business', credentialRef: 'business_credential_reference', name: 'Business', kind: 'catalog' as const,
    providerId: 'openai', baseUrl: '', api: '', model: 'business-model', contextWindow: null, maxTokens: null, reasoning: false };
  const settings = { ...defaultProductSettings(), models: [model], defaultModelId: 'business', evaluation: {
    agent: withAgent ? { ...connection, credentialRef: 'a'.repeat(32) } : null,
    judge: { ...connection, timeoutMs: 180_000, credentialRef: 'b'.repeat(32) },
  } };
  await saveProductSettings(file, settings);
  await credentialStore(model.credentialRef).write('synthetic-business-key');
  await credentialStore('b'.repeat(32)).write('synthetic-judge-key');
  if (withAgent) await credentialStore('a'.repeat(32)).write('synthetic-original-agent-key');
  const ports: Ports = { getSettings: () => readProductSettings(file), saveSettings: value => saveProductSettings(file, value), credentialStore };
  return { root, directory, file, ports, model };
}

test('dedicated Agent save keeps business and Judge identities and never returns the submitted key', async () => {
  const f = await fixture();
  try {
    const saved = await save?.({ expectedRevision: 1, role: 'agent', connection, apiKey: 'synthetic-new-agent-key' }, f.ports);
    expect(saved).toMatchObject({ ok: true, data: { revision: 2, models: [f.model], defaultModelId: 'business',
      evaluation: { agent: connection, judge: { credentialRef: 'b'.repeat(32) } } } });
    if (!saved?.ok) return;
    const ref = saved.data.evaluation!.agent!.credentialRef;
    expect(ref).not.toBe('b'.repeat(32)); expect(ref).not.toBe(f.model.credentialRef);
    expect(await f.ports.credentialStore(ref).read()).toEqual({ ok: true, data: 'synthetic-new-agent-key' });
    expect(await f.ports.credentialStore('b'.repeat(32)).read()).toEqual({ ok: true, data: 'synthetic-judge-key' });
    expect(JSON.stringify(saved)).not.toContain('synthetic-new-agent-key');
    expect(await readFile(f.file, 'utf8')).not.toContain('synthetic-new-agent-key');
  } finally { await rm(f.root, { recursive: true, force: true }); }
});

test('stale revision and failed publication leave prior settings and remove only a newly written credential', async () => {
  const f = await fixture(true);
  try {
    const before = await readFile(f.file, 'utf8'), files = await readdir(f.directory);
    expect(await save?.({ expectedRevision: 0, role: 'agent', connection, apiKey: 'synthetic-unused-key' }, f.ports))
      .toMatchObject({ ok: false, error: { code: 'config_revision_conflict' } });
    expect(await readdir(f.directory)).toEqual(files);
    expect(await save?.({ expectedRevision: 1, role: 'agent', connection, apiKey: 'synthetic-replacement-key' }, {
      ...f.ports, saveSettings: async () => fail(appError('config_settings_write_failed', 'storage', 'Synthetic publish failure')),
    })).toMatchObject({ ok: false, error: { code: 'config_settings_write_failed' } });
    expect(await readdir(f.directory)).toEqual(files); expect(await readFile(f.file, 'utf8')).toBe(before);
    expect(await f.ports.credentialStore('a'.repeat(32)).read()).toEqual({ ok: true, data: 'synthetic-original-agent-key' });
  } finally { await rm(f.root, { recursive: true, force: true }); }
});

test('model-only changes preserve the key while endpoint changes require their own credential', async () => {
  const f = await fixture(true);
  try {
    expect(await save?.({ expectedRevision: 1, role: 'agent', connection: { ...connection, model: 'another-model' } }, f.ports))
      .toMatchObject({ ok: true, data: { evaluation: { agent: { credentialRef: 'a'.repeat(32), model: 'another-model' } } } });
    const changed = await save?.({ expectedRevision: 2, role: 'agent', connection: { ...connection, baseUrl: 'https://another.invalid/v1' } }, f.ports);
    expect(changed).toMatchObject({ ok: true }); if (!changed?.ok) return;
    const ref = changed.data.evaluation!.agent!.credentialRef;
    expect(ref).not.toBe('a'.repeat(32)); expect(await f.ports.credentialStore(ref).status()).toBe('missing');
    expect(await f.ports.credentialStore('a'.repeat(32)).status()).toBe('missing');
    expect(await f.ports.credentialStore(f.model.credentialRef).status()).toBe('configured');
  } finally { await rm(f.root, { recursive: true, force: true }); }
});

for (const cleanupFails of [false, true]) test(`a partial credential write failure ${cleanupFails ? 'reports failed cleanup' : 'removes the unpublished key'}`, async () => {
  const f = await fixture(true);
  try {
    const before = await readFile(f.file, 'utf8'), files = await readdir(f.directory);
    const result = await save({ expectedRevision: 1, role: 'agent', connection, apiKey: 'synthetic-partial-key' }, {
      ...f.ports, credentialStore: reference => {
        const original = f.ports.credentialStore(reference);
        return { ...original, write: async key => {
          const written = await original.write(key); if (!written.ok) return written;
          return fail(appError('credential_write_failed', 'storage', 'Synthetic failure after writing.'));
        }, remove: cleanupFails ? async () => fail(appError('credential_remove_failed', 'storage', 'Synthetic cleanup failure.')) : original.remove };
      },
    });
    expect(result).toMatchObject({ ok: false, error: { code: cleanupFails ? 'evaluation_credential_cleanup_failed' : 'credential_write_failed' } });
    expect(await readFile(f.file, 'utf8')).toBe(before);
    expect((await readdir(f.directory)).length - files.length).toBe(cleanupFails ? 1 : 0);
    expect(await f.ports.credentialStore('a'.repeat(32)).read()).toEqual({ ok: true, data: 'synthetic-original-agent-key' });
    expect(await f.ports.credentialStore('b'.repeat(32)).read()).toEqual({ ok: true, data: 'synthetic-judge-key' });
  } finally { await rm(f.root, { recursive: true, force: true }); }
});

test('clearing a role removes only its retired encrypted credential after settings are committed', async () => {
  const f = await fixture(true);
  try {
    expect(await save?.({ expectedRevision: 1, role: 'agent', connection: null }, f.ports))
      .toMatchObject({ ok: true, data: { evaluation: { agent: null, judge: { credentialRef: 'b'.repeat(32) } } } });
    expect(await f.ports.credentialStore('a'.repeat(32)).status()).toBe('missing');
    expect(await f.ports.credentialStore('b'.repeat(32)).status()).toBe('configured');
    expect(await f.ports.credentialStore(f.model.credentialRef).status()).toBe('configured');
  } finally { await rm(f.root, { recursive: true, force: true }); }
});

test('a rejected settings publication reports failure to clean its unpublished key while retaining prior credentials', async () => {
  const f = await fixture(true);
  try {
    const before = await readFile(f.file, 'utf8');
    const result = await save({ expectedRevision: 1, role: 'agent', connection, apiKey: 'synthetic-unpublished-key' }, {
      ...f.ports, saveSettings: async () => fail(appError('config_settings_write_failed', 'storage', 'Synthetic publication rejected.')),
      credentialStore: reference => ({ ...f.ports.credentialStore(reference),
        remove: async () => fail(appError('credential_remove_failed', 'storage', 'Synthetic cleanup rejected.')) }),
    });
    expect(result).toMatchObject({ ok: false, error: { code: 'evaluation_credential_cleanup_failed' } });
    expect(await readFile(f.file, 'utf8')).toBe(before);
    expect(await f.ports.credentialStore('a'.repeat(32)).read()).toEqual({ ok: true, data: 'synthetic-original-agent-key' });
    expect(await f.ports.credentialStore('b'.repeat(32)).read()).toEqual({ ok: true, data: 'synthetic-judge-key' });
  } finally { await rm(f.root, { recursive: true, force: true }); }
});

test('a lost publication reply is resolved from saved settings without deleting the committed key', async () => {
  const f = await fixture(true);
  try {
    const result = await save?.({ expectedRevision: 1, role: 'agent', connection, apiKey: 'synthetic-committed-key' }, {
      ...f.ports, saveSettings: async settings => {
        const committed = await f.ports.saveSettings(settings); expect(committed.ok).toBe(true);
        return fail(appError('operation_result_unknown', 'runtime', 'Synthetic lost reply', true));
      },
    });
    expect(result).toMatchObject({ ok: true, data: { revision: 2 } }); if (!result?.ok) return;
    expect(await f.ports.credentialStore(result.data.evaluation!.agent!.credentialRef).read())
      .toEqual({ ok: true, data: 'synthetic-committed-key' });
  } finally { await rm(f.root, { recursive: true, force: true }); }
});

test('an unresolved publication retains the possibly committed new key and the old working key', async () => {
  const f = await fixture(true);
  try {
    const files = await readdir(f.directory); let reads = 0;
    const result = await save({ expectedRevision: 1, role: 'agent', connection, apiKey: 'synthetic-uncertain-key' }, {
      ...f.ports, getSettings: async () => { if (reads++) throw Error('Synthetic channel unavailable'); return f.ports.getSettings(); },
      saveSettings: async () => fail(appError('operation_result_unknown', 'runtime', 'Synthetic lost reply', true)),
    });
    expect(result).toMatchObject({ ok: false, error: { code: 'operation_result_unknown' } });
    const added = (await readdir(f.directory)).filter(file => !files.includes(file));
    expect(added).toHaveLength(1);
    expect(await f.ports.credentialStore(added[0]!.replace('.json', '')).read()).toEqual({ ok: true, data: 'synthetic-uncertain-key' });
    expect(await f.ports.credentialStore('a'.repeat(32)).read()).toEqual({ ok: true, data: 'synthetic-original-agent-key' });
  } finally { await rm(f.root, { recursive: true, force: true }); }
});

test('business settings round trips preserve evaluation roles and cannot change their credential targets', async () => {
  const f = await fixture(true);
  try {
    const current = await f.ports.getSettings(); if (!current.ok) throw Error('Synthetic settings missing');
    const { evaluation: omitted, ...legacyCall } = current.data;
    expect(validate?.({ ...legacyCall, profile: { ...current.data.profile, displayName: 'Edited business profile' } }, current.data))
      .toMatchObject({ ok: true, data: { evaluation: omitted, profile: { displayName: 'Edited business profile' } } });
    expect(validate?.(current.data, current.data)).toMatchObject({ ok: true, data: { evaluation: omitted } });
    expect(validate?.({ ...current.data, evaluation: { agent: null, judge: null } }, current.data))
      .toMatchObject({ ok: false, error: { code: 'evaluation_settings_separate' } });
  } finally { await rm(f.root, { recursive: true, force: true }); }
});

test('the startup snapshot reads only the Agent key for a deterministic selection and refuses changed conditions before any key read', async () => {
  const f = await fixture(true), reads: string[] = [];
  const snapshot = Reflect.get(implementation, 'evaluationConfigurationSnapshot') as typeof implementation.evaluationConfigurationSnapshot | undefined;
  const prepare = Reflect.get(implementation, 'prepareEvaluationCredentials') as typeof implementation.prepareEvaluationCredentials | undefined;
  try {
    const stored = await f.ports.getSettings(); if (!stored.ok) throw Error('Synthetic settings missing');
    const config = await snapshot?.(stored.data, f.ports.credentialStore); expect(config).toBeDefined();
    const store: Ports['credentialStore'] = reference => ({ ...f.ports.credentialStore(reference), read: () => {
      reads.push(reference); return f.ports.credentialStore(reference).read();
    } });
    const preview = { settings: config!, plan: { judgeMaxGenerations: 0, judgeRequired: false } };
    expect(await prepare?.(preview, stored.data, store)).toMatchObject({ ok: true,
      data: { settings: config, credentials: { agent: 'synthetic-original-agent-key', judge: null } } });
    expect(reads).toEqual(['a'.repeat(32)]); reads.length = 0;
    expect(await prepare?.(preview, { ...stored.data, revision: stored.data.revision + 1 }, store))
      .toMatchObject({ ok: false, error: { code: 'evaluation_preview_changed' } });
    expect(reads).toEqual([]);
    expect(await prepare?.({ ...preview, plan: { judgeMaxGenerations: 1, judgeRequired: true } }, stored.data, store))
      .toMatchObject({ ok: true, data: { credentials: { agent: 'synthetic-original-agent-key', judge: 'synthetic-judge-key' } } });
    expect(reads).toEqual(['a'.repeat(32), 'b'.repeat(32)]);
  } finally { await rm(f.root, { recursive: true, force: true }); }
});
