import { expect, test } from 'bun:test';
import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { defaultProductSettings, readProductSettings, validateProductSettings } from '../../../packages/core/src/configuration/settings.ts';

const businessModel = { id: 'primary', credentialRef: 'existing_business_credential', name: 'Business', kind: 'catalog',
  providerId: 'openai', model: 'existing-model', baseUrl: '', api: '', contextWindow: null, maxTokens: null, reasoning: false };
const agent = { api: 'openai-completions', model: 'synthetic-agent', baseUrl: 'https://provider.invalid/v1', credentialRef: 'a'.repeat(32) };

test('v6 upgrade retains business identity and encrypted files and creates empty independent roles once', async () => {
  const root = await mkdtemp(join(tmpdir(), 'flowmate-p16-settings-'));
  try {
    const file = join(root, 'settings.json'), key = join(root, 'existing_business_credential.enc');
    const { evaluation: _future, ...base } = defaultProductSettings() as ReturnType<typeof defaultProductSettings> & { evaluation?: unknown };
    const previous = { ...base, version: 6, revision: 9, models: [businessModel], defaultModelId: 'primary' };
    const original = JSON.stringify(previous); await writeFile(file, original); await writeFile(key, 'synthetic encrypted envelope');
    const loaded = await readProductSettings(file);
    expect(loaded).toMatchObject({ ok: true, data: { version: 7, revision: 9, models: [businessModel], defaultModelId: 'primary',
      evaluation: { agent: null, judge: null } } });
    expect(await readFile(key, 'utf8')).toBe('synthetic encrypted envelope');
    expect(await readProductSettings(file)).toEqual(loaded);
    const backups = (await readdir(root)).filter(name => name.includes('.pre-v7.'));
    expect(backups).toHaveLength(1); expect(await readFile(join(root, backups[0]!), 'utf8')).toBe(original);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('v7 validates each evaluation role without borrowing business or another role credential identity', () => {
  const settings = { ...defaultProductSettings(), version: 7, models: [businessModel], defaultModelId: 'primary',
    evaluation: { agent, judge: { ...agent, credentialRef: 'b'.repeat(32), timeoutMs: 180_000 } } };
  expect(validateProductSettings(settings)).toMatchObject({ ok: true, data: { evaluation: { agent, judge: { timeoutMs: 180_000 } } } });
  expect(validateProductSettings({ ...settings, evaluation: { agent, judge: { ...agent, timeoutMs: 180_000 } } })).toMatchObject({ ok: false });
  expect(validateProductSettings({ ...settings, models: [{ ...businessModel, credentialRef: agent.credentialRef }] })).toMatchObject({ ok: false });
});

test('v7 refuses secrets and provider generation parameters in saved evaluation connections', () => {
  const settings = { ...defaultProductSettings(), version: 7, evaluation: { agent, judge: null } };
  expect(validateProductSettings(settings)).toMatchObject({ ok: true });
  for (const field of ['apiKey', 'env', 'temperature', 'maxTokens']) {
    expect(validateProductSettings({ ...settings, evaluation: { agent: { ...agent, [field]: 'untrusted' }, judge: null } }))
      .toMatchObject({ ok: false });
  }
  expect(validateProductSettings({ ...settings, evaluation: { agent: { ...agent, baseUrl: 'https://user:secret@provider.invalid/v1' }, judge: null } }))
    .toMatchObject({ ok: false });
});
