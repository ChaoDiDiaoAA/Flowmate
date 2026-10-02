import { mkdtemp } from '../../support/resources.ts';
import { readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'bun:test';
import { defaultProductSettings, readProductSettings, saveProductSettings } from '../../../packages/core/src/configuration/settings.ts';

const model = {
  id: 'model-main',
  credentialRef: 'credential-ref-0001',
  name: 'Primary model',
  kind: 'custom' as const,
  providerId: null,
  baseUrl: 'https://llm.example/v1',
  model: 'example-chat',
  api: 'openai-responses' as const,
  contextWindow: 64_000,
  maxTokens: 16_000,
  reasoning: false,
};

describe('desktop settings', () => {
  it('upgrades old settings and persists bounded Runtime defaults with revision checks', async () => {
    const root = await mkdtemp(join(tmpdir(), 'flowmate-settings-'));
    const file = join(root, 'settings.json');
    const legacy = { ...defaultProductSettings(), version: 2 };
    delete (legacy as Record<string, unknown>).runtime;
    await writeFile(file, JSON.stringify(legacy));
    const loaded = await readProductSettings(file);
    expect(loaded).toMatchObject({ ok: true, data: { version: 3, runtime: {} } });
    if (!loaded.ok) return;
    const runtime = { budget: { maxModelCalls: 64, maxToolCalls: 100, toolTimeoutMs: 1_800_000 },
      timeoutMs: 1_800_000, stopGraceMs: 10_000 };
    expect(await saveProductSettings(file, { ...loaded.data, runtime })).toMatchObject({ ok: true, data: { revision: 1, runtime } });
    for (const change of [{ budget: { maxModelCalls: 65 } }, { timeoutMs: 99 }, { toolTimeoutMs: 1000 }, { stopGraceMs: 10_001 }])
      expect(await saveProductSettings(file, { ...loaded.data, runtime: change })).toMatchObject({ ok: false, error: { code: 'config_settings_invalid' } });
  });
  it('writes versioned non-secret settings with compare-and-swap revision', async () => {
    const root = await mkdtemp(join(tmpdir(), 'flowmate-settings-'));
    const file = join(root, 'data', 'settings.json');
    const initial = defaultProductSettings('2026-09-23T00:00:00.000Z');

    const saved = await saveProductSettings(file, { ...initial, models: [model], defaultModelId: model.id }, '2026-09-23T01:00:00.000Z');
    expect(saved.ok).toBe(true);
    if (!saved.ok) return;
    expect(saved.data.revision).toBe(1);
    expect((await readProductSettings(file)).ok).toBe(true);
    expect(await readFile(file, 'utf8')).not.toContain('apiKey');
    expect(await readFile(file, 'utf8')).not.toContain('secret');

    const stale = await saveProductSettings(file, { ...initial, models: [model], defaultModelId: model.id });
    expect(stale.ok).toBe(false);
    if (!stale.ok) expect(stale.error.code).toBe('config_revision_conflict');
    const current = await readProductSettings(file);
    expect(current.ok && current.data.revision).toBe(1);
  });

  it('returns defaults for a missing file but rejects malformed existing settings', async () => {
    const root = await mkdtemp(join(tmpdir(), 'flowmate-settings-'));
    const file = join(root, 'settings.json');
    const missing = await readProductSettings(file);
    expect(missing.ok && missing.data.revision).toBe(0);
    await writeFile(file, JSON.stringify({ version: 2 }), 'utf8');
    const corrupt = await readProductSettings(file);
    expect(corrupt.ok).toBe(false);
    if (!corrupt.ok) expect(corrupt.error.code).toBe('config_settings_invalid');
  });

  it('does not reuse a retired output-token setting from a legacy profile', async () => {
    const root = await mkdtemp(join(tmpdir(), 'flowmate-settings-'));
    const file = join(root, 'settings.json');
    const legacy = {
      ...defaultProductSettings('2026-09-23T00:00:00.000Z'), version: 1,
      revision: 3,
      models: [{ id: model.id, credentialRef: model.credentialRef, name: model.name,
        baseUrl: model.baseUrl, model: model.model, api: model.api, maxTokens: 2048 }],
      defaultModelId: model.id,
    };
    delete (legacy as Record<string, unknown>).runtime;
    await writeFile(file, JSON.stringify(legacy), 'utf8');

    const loaded = await readProductSettings(file);
    expect(loaded.ok).toBe(true);
    if (!loaded.ok) return;
    expect(loaded.data.models[0]).toHaveProperty('maxTokens', null);
    expect(loaded.data.models[0]).toHaveProperty('kind', 'legacy');

    const saved = await saveProductSettings(file, loaded.data);
    expect(saved.ok).toBe(true);
    const persisted = JSON.parse(await readFile(file, 'utf8')) as { models: Record<string, unknown>[] };
    expect(persisted.models[0]).toHaveProperty('maxTokens', null);
  });

  it('removes only the retired DeepSeek Responses profile while preserving other legacy routes', async () => {
    const root = await mkdtemp(join(tmpdir(), 'flowmate-settings-'));
    const file = join(root, 'settings.json');
    const { runtime: _runtime, ...legacyDefaults } = defaultProductSettings();
    await writeFile(file, JSON.stringify({ ...legacyDefaults, version: 1,
      models: [{ id: 'old-deepseek', credentialRef: 'old-deepseek-credential', name: 'Old',
        baseUrl: 'https://api.deepseek.com', model: 'deepseek-flash', api: 'openai-responses' },
      { id: 'other', credentialRef: 'other-credential-ref', name: 'Other', baseUrl: 'https://other.example/v1',
        model: 'other-model', api: 'openai-completions' }], defaultModelId: 'old-deepseek' }), 'utf8');
    const loaded = await readProductSettings(file);
    expect(loaded).toMatchObject({ ok: true, data: { version: 3, defaultModelId: null,
      models: [{ id: 'other', kind: 'legacy' }] } });
  });

  it('rejects credentials embedded in a model profile', async () => {
    const root = await mkdtemp(join(tmpdir(), 'flowmate-settings-'));
    const file = join(root, 'settings.json');
    const result = await saveProductSettings(file, {
      ...defaultProductSettings(),
      models: [{ ...model, apiKey: 'should-not-be-stored' }],
      defaultModelId: model.id,
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe('config_settings_invalid');
  });
});
