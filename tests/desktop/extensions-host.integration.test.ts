import { expect, it } from 'bun:test';
import { mkdtempSync } from '../support/resources.ts';
import { readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { HostClient } from '../../apps/desktop/main/host-client.ts';
import { parseHostCommand } from '../../apps/host/protocol.ts';
import { ExtensionCatalogSchema, ResourceSelectionResultSchema } from '@flowmate/contracts';
import type { Result } from '@flowmate/contracts';

it('[F12-02/03/19] shares the Host settings CAS between Extensions and Resources without changing P11 responses', async () => {
  expect(parseHostCommand({ version: 1, requestId: 'catalog', type: 'list_extensions' })).not.toBeNull();
  const root = mkdtempSync(join(tmpdir(), 'flowmate-p12-host-')), client = new HostClient();
  expect(await client.start(root, '0.1.0', resolve(import.meta.dir, '../..'))).toMatchObject({ ok: true });
  try {
    const raw = await client.request({ type: 'list_extensions' }) as Result<unknown>;
    expect(raw.ok).toBe(true); if (!raw.ok) throw new Error(raw.error.code);
    const catalog = ExtensionCatalogSchema.parse(raw.data);
    expect(catalog.items[0]?.compatibility.available).toBe(true);
    const selection = { enabledExtensions: [catalog.items[0]!.ref] };
    const concurrent = await Promise.all([
      client.request({ type: 'update_extension_selection', input: { expectedRevision: 0, selection } }),
      client.request({ type: 'update_resource_selection', input: { expectedRevision: 0, selection: { prompt: null, enabledSkills: [] } } }),
    ]) as Result<unknown>[];
    expect(concurrent.filter(result => result.ok)).toHaveLength(1);
    expect(concurrent.find(result => !result.ok)).toMatchObject({ error: { code: 'config_revision_conflict' } });
    expect(await client.request({ type: 'update_extension_selection', input: { expectedRevision: 1, selection } }))
      .toMatchObject({ ok: true, data: { revision: 2, selection } });
    const before = readFileSync(join(root, 'data/settings.json'), 'utf8');
    const state = await client.request({ type: 'get_state' }) as Result<{ settings: unknown }>;
    if (!state.ok) throw new Error(state.error.code);
    expect(await client.request({ type: 'save_settings', settings: { ...state.data.settings as object,
      extensions: { enabledExtensions: [{ ...selection.enabledExtensions[0], manifestHash: 'b'.repeat(64) }] } } }))
      .toMatchObject({ ok: false, error: { code: 'extension_config_invalid' } });
    expect(readFileSync(join(root, 'data/settings.json'), 'utf8')).toBe(before);
    const resource = await client.request({ type: 'update_resource_selection', input: { expectedRevision: 2,
      selection: { prompt: null, enabledSkills: [] } } }) as Result<unknown>;
    expect(resource.ok).toBe(true); if (resource.ok) expect(ResourceSelectionResultSchema.parse(resource.data)).toEqual({
      revision: 3, selection: { prompt: null, enabledSkills: [] },
    });
    expect(await client.request({ type: 'query_runtime_state' })).toMatchObject({ ok: true, data: { active: null } });
  } finally { expect(await client.close()).toMatchObject({ ok: true, data: { stopped: true, closed: true } }); }
});

it('[F12-24] exposes all six strict Host requests and rejects product identity or executable input injection', () => {
  const instanceId = '3b207100-a007-4dd4-8e9a-b38c1f77b988';
  const commands = [
    { type: 'query_session_extensions', input: { sessionId: 1 } },
    { type: 'query_run_extensions', input: { sessionId: 1, runId: 2 } },
    { type: 'execute_extension_command', input: { sessionId: 1, expectedInstanceId: instanceId, name: 'invoice-assist', arguments: '' } },
    { type: 'dispose_session_extensions', input: { sessionId: 1, expectedInstanceId: instanceId } },
  ];
  for (const command of commands) {
    expect(parseHostCommand({ version: 1, requestId: 'p12', ...command })).not.toBeNull();
    expect(parseHostCommand({ version: 1, requestId: 'p12', ...command, input: { ...command.input, nativeSessionId: 'forged' } })).toBeNull();
  }
  expect(parseHostCommand({ version: 1, requestId: 'p12', type: 'execute_extension_command', input: {
    sessionId: 1, expectedInstanceId: instanceId, name: 'invoice-assist', arguments: 'exec path' } })).toBeNull();
});
