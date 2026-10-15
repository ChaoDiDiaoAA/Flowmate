import { expect, it } from 'bun:test';
import { mkdtempSync } from '../support/resources.ts';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { HostClient } from '../../apps/desktop/main/host-client.ts';
import { parseHostCommand } from '../../apps/host/protocol.ts';
import { defaultProductSettings } from '../../packages/core/src/configuration/settings.ts';
import { ResourceCatalogSchema, ResourceSelectionResultSchema } from '@flowmate/contracts';
import type { Result } from '@flowmate/contracts';

const repo = resolve(import.meta.dir, '../..');
it('serialize-settings-mutations-once uses one Host queue and generic settings cannot bypass resource validation', async () => {
  expect(parseHostCommand({ version: 1, requestId: 'catalog', type: 'list_resources' })).not.toBeNull();
  const root = mkdtempSync(join(tmpdir(), 'flowmate-p11-host-')), client = new HostClient();
  expect(await client.start(root, '0.1.0', repo)).toMatchObject({ ok: true });
  try {
    const raw = await client.request({ type: 'list_resources' }) as Result<unknown>;
    expect(raw.ok).toBe(true); if (!raw.ok) throw new Error(raw.error.code);
    const catalog = ResourceCatalogSchema.parse(raw.data);
    const prompt = catalog.items.find(item => item.ref.kind === 'prompt' && item.ref.id === 'invoice');
    expect(prompt?.available).toBe(true); if (!prompt) throw new Error('missing author Prompt');
    const selection = { prompt: prompt.ref, enabledSkills: [] };
    const original = defaultProductSettings();
    const results = await Promise.all([
      client.request({ type: 'update_resource_selection', input: { expectedRevision: 0, selection } }),
      client.request({ type: 'save_settings', settings: { ...original, profile: { displayName: 'Concurrent profile', theme: 'light' } } }),
    ]) as Result<unknown>[];
    expect(results.filter(result => result.ok)).toHaveLength(1);
    expect(results.find(result => !result.ok)).toMatchObject({ error: { code: 'config_revision_conflict' } });
    const state = await client.request({ type: 'get_state' }) as Result<{ settings: ReturnType<typeof defaultProductSettings> }>;
    expect(state.ok).toBe(true); if (!state.ok) throw new Error(state.error.code);
    expect(state.data.settings.revision).toBe(1);
    const saved = await client.request({ type: 'update_resource_selection', input: { expectedRevision: 1, selection } }) as Result<unknown>;
    expect(saved.ok).toBe(true); if (saved.ok) expect(ResourceSelectionResultSchema.parse(saved.data)).toEqual({ revision: 2, selection });
    const before = readFileSync(join(root, 'data/settings.json'), 'utf8');
    const invalid = { ...selection, prompt: { ...prompt.ref, version: 'missing-version' } };
    expect(await client.request({ type: 'save_settings', settings: { ...state.data.settings, revision: 2, resources: invalid } }))
      .toMatchObject({ ok: false, error: { code: 'resource_required_unavailable' } });
    expect(await client.request({ type: 'update_resource_selection', input: { expectedRevision: 1, selection: invalid } }))
      .toMatchObject({ ok: false, error: { code: 'config_revision_conflict' } });
    expect(readFileSync(join(root, 'data/settings.json'), 'utf8')).toBe(before);
    expect(await client.request({ type: 'query_runtime_state' })).toMatchObject({ ok: true, data: { active: null } });
  } finally { expect(await client.close()).toMatchObject({ ok: true, data: { closed: true, stopped: true } }); }
});

it('preserves an unchanged stale selection during unrelated settings saves after migrating legacy settings', async () => {
  expect(parseHostCommand({ version: 1, requestId: 'catalog', type: 'list_resources' })).not.toBeNull();
  const root = mkdtempSync(join(tmpdir(), 'flowmate-p11-host-')), file = join(root, 'data/settings.json');
  mkdirSync(join(root, 'data'));
  const base = defaultProductSettings();
  const resources = { prompt: { kind: 'prompt', id: 'invoice', version: 'missing-version' }, enabledSkills: [] };
  const { extensions: _extensions, ...legacyBase } = base;
  writeFileSync(file, JSON.stringify({ ...legacyBase, version: 4, resources }));
  const client = new HostClient();
  expect(await client.start(root, '0.1.0', repo)).toMatchObject({ ok: true });
  try {
    expect(await client.request({ type: 'save_settings', settings: { ...base, resources, profile: { displayName: 'Still editable', theme: 'dark' } } }))
      .toMatchObject({ ok: true, data: { revision: 1, resources } });
    expect(await client.request({ type: 'list_resources' })).toMatchObject({ ok: true, data: { selection: resources,
      diagnostics: [{ code: 'resource_required_unavailable' }] } });
  } finally { expect(await client.close()).toMatchObject({ ok: true, data: { closed: true } }); }
  const legacy = { ...legacyBase, version: 1, revision: 9 };
  delete (legacy as Record<string, unknown>).resources; delete (legacy as Record<string, unknown>).runtime;
  const original = JSON.stringify(legacy); writeFileSync(file, original);
  const restarted = new HostClient();
  expect(await restarted.start(root, '0.1.0', repo)).toMatchObject({ ok: true, data: { settings: { version: 6, revision: 9 } } });
  try { expect(JSON.parse(readFileSync(file, 'utf8'))).toMatchObject({ version: 6, revision: 9 }); }
  finally { expect(await restarted.close()).toMatchObject({ ok: true, data: { closed: true } }); }
});
