import { expect, test, spyOn } from 'bun:test';
import * as fs from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { mkdtemp } from '../../support/resources.ts';
import { defaultProductSettings, readProductSettings } from '../../../packages/core/src/configuration/settings.ts';

const legacy = () => ({ ...defaultProductSettings(), version: 5, revision: 7, models: [{ id: 'primary',
  credentialRef: 'old_model_credential', name: 'Original model', kind: 'catalog', providerId: 'openai', model: 'original',
  baseUrl: '', api: '', contextWindow: null, maxTokens: null, reasoning: false }], defaultModelId: 'primary' });

test('settings upgrade backs up original facts and preserves the credential reference', async () => {
  const root = await mkdtemp(join(tmpdir(), 'flowmate-settings-v6-')), file = join(root, 'settings.json');
  const original = JSON.stringify(legacy()); await fs.writeFile(file, original);
  const first = await readProductSettings(file); expect(first.ok).toBe(true); if (!first.ok) throw new Error(first.error.code);
  expect(first.data).toMatchObject({ version: 7, revision: 7, defaultModelId: 'primary', models: [{ id: 'primary', model: 'original' }] });
  expect(first.data.models[0]!.credentialRef).toBe('old_model_credential');
  expect(await readProductSettings(file)).toEqual(first);
  const backups = (await fs.readdir(root)).filter(name => name.includes('.pre-v6.'));
  expect(backups).toHaveLength(1);
  expect(await fs.readFile(join(root, backups[0]!), 'utf8')).toBe(original);
});

test('a failed settings upgrade publication leaves original settings and a complete backup', async () => {
  const root = await mkdtemp(join(tmpdir(), 'flowmate-settings-v6-fault-')), file = join(root, 'settings.json');
  const original = JSON.stringify(legacy()); await fs.writeFile(file, original);
  const rename = fs.rename;
  const fault = spyOn(fs, 'rename').mockImplementation(async (from, to) => {
    if (String(to) === file) throw new Error('upgrade publication unavailable');
    return rename(from, to);
  });
  try { expect(await readProductSettings(file)).toMatchObject({ ok: false, error: { code: 'config_settings_write_failed' } }); }
  finally { fault.mockRestore(); }
  expect(await fs.readFile(file, 'utf8')).toBe(original);
  const names = await fs.readdir(root), backups = names.filter(name => name.includes('.pre-v6.'));
  expect(backups).toHaveLength(1); expect(names.some(name => name.endsWith('.tmp'))).toBe(false);
  expect(await fs.readFile(join(root, backups[0]!), 'utf8')).toBe(original);
});
