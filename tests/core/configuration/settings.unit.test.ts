import { mkdtemp } from '../../support/resources.ts';
import { readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import * as fs from 'node:fs/promises';
import { describe, expect, it, spyOn } from 'bun:test';
import { defaultProductSettings, readProductSettings, saveProductSettings, validateProductSettings } from '../../../packages/core/src/configuration/settings.ts';

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
    delete (legacy as Record<string, unknown>).resources;
    await writeFile(file, JSON.stringify(legacy));
    const loaded = await readProductSettings(file);
    expect(loaded).toMatchObject({ ok: true, data: { version: 4, runtime: {}, resources: { prompt: null, enabledSkills: [] } } });
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

  it('settings-v1-v2-v3-to-v4-empty preserves saved bytes and revisions until an explicit save', async () => {
    const root = await mkdtemp(join(tmpdir(), 'flowmate-settings-'));
    const file = join(root, 'settings.json');
    const { runtime: _runtime, ...base } = defaultProductSettings('2026-09-23T00:00:00.000Z');
    delete (base as Record<string, unknown>).resources;
    for (const version of [1, 2, 3]) {
      const original = JSON.stringify({ ...base, version, revision: 7, ...(version === 3 ? { runtime: {} } : {}) });
      await writeFile(file, original);
      const loaded = await readProductSettings(file);
      expect(loaded).toMatchObject({ ok: true, data: { version: 4, revision: 7, runtime: {}, resources: { prompt: null, enabledSkills: [] } } });
      expect(await readFile(file, 'utf8')).toBe(original);
    }
    const current = defaultProductSettings();
    const ref = { kind: 'skill', id: 'invoice', version: 'v1', contentHash: 'a'.repeat(64) };
    expect(validateProductSettings({ ...current, resources: { prompt: null, enabledSkills: [ref] } }).ok).toBe(true);
    for (const change of [{ version: 5 }, { resources: undefined }, { resources: { prompt: null, enabledSkills: [ref, ref] } },
      { resources: { prompt: null, enabledSkills: [], inferredRead: true } }])
      expect(validateProductSettings({ ...current, ...change }).ok).toBe(false);
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
    delete (legacy as Record<string, unknown>).resources;
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
    delete (legacyDefaults as Record<string, unknown>).resources;
    await writeFile(file, JSON.stringify({ ...legacyDefaults, version: 1,
      models: [{ id: 'old-deepseek', credentialRef: 'old-deepseek-credential', name: 'Old',
        baseUrl: 'https://api.deepseek.com', model: 'deepseek-flash', api: 'openai-responses' },
      { id: 'other', credentialRef: 'other-credential-ref', name: 'Other', baseUrl: 'https://other.example/v1',
        model: 'other-model', api: 'openai-completions' }], defaultModelId: 'old-deepseek' }), 'utf8');
    const loaded = await readProductSettings(file);
    expect(loaded).toMatchObject({ ok: true, data: { version: 4, defaultModelId: null,
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


it.each(['write', 'sync', 'rename'] as const)('P11 selection save keeps the prior committed bytes when %s fails', async window => {
  const root = await mkdtemp(join(tmpdir(), 'flowmate-p11-settings-fault-')), file = join(root, 'settings.json');
  const base = defaultProductSettings(); await writeFile(file, JSON.stringify(base)); const before = await readFile(file, 'utf8');
  const next = { ...base, resources: { prompt: { kind: 'prompt', id: 'invoice', version: 'v1', contentHash: 'a'.repeat(64) }, enabledSkills: [] } };
  let hits = 0;
  const originalOpen = fs.open, originalRename = fs.rename;
  const injected = window === 'rename' ? spyOn(fs, 'rename').mockImplementation(async (from, to) => {
    if (String(to) === file) { hits++; throw new Error('P11 rename fault'); } return originalRename(from, to);
  }) : spyOn(fs, 'open').mockImplementation(async (...args: Parameters<typeof fs.open>) => {
    const handle = await originalOpen(...args);
    if (String(args[0]).startsWith(`${file}.`)) {
      if (window === 'write') handle.writeFile = async () => { hits++; throw new Error('P11 write fault'); };
      else handle.sync = async () => { hits++; throw new Error('P11 sync fault'); };
    }
    return handle;
  });
  try { expect(await saveProductSettings(file, next)).toMatchObject({ ok: false, error: { code: 'config_settings_write_failed' } }); }
  finally { injected.mockRestore(); }
  expect(hits).toBe(1); expect(await readFile(file, 'utf8')).toBe(before);
  expect(await readProductSettings(file)).toMatchObject({ ok: true, data: { revision: 0, resources: base.resources } });
  expect(await fs.readdir(root)).toEqual(['settings.json']);
});
