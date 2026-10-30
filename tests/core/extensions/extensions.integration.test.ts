import { openTestDatabase } from '../../support/database.ts';
import { resolveProductPaths } from '@flowmate/shared';
import { describe, expect, it, spyOn } from 'bun:test';
import { mkdirSync, writeFileSync, readFileSync, unlinkSync, readdirSync } from 'node:fs';
import * as fsPromises from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import * as core from '../../../packages/core/src/index.ts';
import { defaultProductSettings, readProductSettings, saveProductSettings } from '../../../packages/core/src/configuration/settings.ts';
import { createResourceService } from '../../../packages/core/src/resources/service.ts';
import { inspectNativeResources } from '../../../packages/runtime-pi/src/resources/loader.ts';
import { mkdtempSync, deferCleanup } from '../../support/resources.ts';

const manifest = { schemaVersion: 2, kind: 'extension', id: 'invoice-assist', version: 'v1', sdkVersion: '1.4.0', entryId: 'invoice-assist-v1',
  tools: [{ name: 'check_invoice_sources', version: '1' }], commands: ['invoice-assist'], hooks: [
    { event: 'session_start', policy: 'critical' }, { event: 'tool_call', policy: 'critical' },
    { event: 'tool_result', policy: 'observer' }, { event: 'tool_execution_end', policy: 'observer' },
    { event: 'session_shutdown', policy: 'critical' },
  ] };
const ref = { id: 'invoice-assist', version: 'v1' };
const selection = { enabledExtensions: [ref] };
const at = '2026-10-06T08:00:00.000Z';
function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'flowmate-p12-catalog-')), resourceRoot = join(root, 'author');
  mkdirSync(join(resourceRoot, 'extensions'), { recursive: true });
  const file = join(resourceRoot, 'extensions', 'invoice-v1.json'); writeFileSync(file, JSON.stringify(manifest));
  writeFileSync(join(resourceRoot, 'extensions', 'subagents-v1.json'), readFileSync(join(import.meta.dir, '../../../resources/extensions/subagents-v1.json')));
  const paths = resolveProductPaths(join(root, 'product')); if (!paths.ok) throw new Error(paths.error.code);
  const storage = openTestDatabase(paths.data); if (!storage.ok) throw new Error(storage.error.code); deferCleanup(() => storage.data.close());
  return { root, resourceRoot, file, contents: storage.data.contents };
}
function makeCatalog(resourceRoot: string, sdkVersion = '1.4.0') {
  const create = Reflect.get(core, 'createExtensionService');
  expect(typeof create).toBe('function');
  return create?.({ resourceRoot, sdkVersion, registeredTools: [{ name: 'check_invoice_sources', version: '1', effect: 'READ' }, { name: 'Agent', version: '0.19.0-p13.2', effect: 'READ' }] });
}

it('requires actual invoice extension selection and eligibility for an evaluation Hook profile', () => {
  const f = fixture();
  const service = core.createExtensionService({ resourceRoot: f.resourceRoot, sdkVersion: '1.4.0',
    registeredTools: [{ name: 'check_invoice_sources', version: '1', effect: 'READ' }],
    evaluationProfile: { id: 'source-quote-trim', version: 1 } });
  const request = { selection, settingsRevision: 7, activeToolNames: ['check_invoice_sources'], policy: 'p3' as const };
  expect(service.freeze(request)).toMatchObject({ ok: true, data: { evaluationProfile: { id: 'source-quote-trim', version: 1 }, included: [{ ref }] } });
  for (const change of [{ activeToolNames: [] }, { policy: 'p2' as const }, { policy: 'fill' as const }, { selection: { enabledExtensions: [] } }])
    expect(service.freeze({ ...request, ...change })).toMatchObject({ ok: false, error: { code: 'extension_config_invalid' } });
  const baseline = makeCatalog(f.resourceRoot).freeze(request);
  expect(baseline.ok).toBe(true);
  if (!baseline.ok) throw new Error(baseline.error.code);
  expect(baseline.data).not.toHaveProperty('evaluationProfile');
});

describe('P12 trusted extension selection', () => {
  it('[F12-02/04] freezes only eligible tools without enabling an excluded extension', () => {
    const f = fixture(), hub = makeCatalog(f.resourceRoot);
    if (!hub) return;
    expect(hub.list()).toMatchObject({ ok: true, data: [{ ref, compatibility: { available: true, code: null } }, { ref: { id: 'subagents' }, compatibility: { available: true, code: null } }] });
    const input = { selection, settingsRevision: 7, activeToolNames: ['check_invoice_sources'], policy: 'p3' as const };
    expect(hub.freeze(input)).toMatchObject({ ok: true, data: { settingsRevision: 7, selected: [ref], included: [{ ref, manifest }], excluded: [] } });
    for (const change of [{ activeToolNames: [] }, { policy: 'p2' as const }, { policy: 'fill' as const }])
      expect(hub.freeze({ ...input, ...change })).toMatchObject({ ok: true, data: { included: [], excluded: [{ ref, code: 'tool_not_active' }] } });
    expect(hub.freeze({ ...input, selection: { enabledExtensions: [] } })).toMatchObject({ ok: true, data: { selected: [], included: [], excluded: [] } });
    expect(hub.validateSelection({ enabledExtensions: [{ ...ref, version: 'missing-version' }] })).toMatchObject({ ok: false, error: { code: 'extension_config_invalid' } });
  });

  it('[F12-19] revalidates trust after mutation and can clear a broken future selection', () => {
    const f = fixture(), hub = makeCatalog(f.resourceRoot);
    if (!hub) return;
    expect(hub.validateSelection(selection)).toMatchObject({ ok: true });
    expect(makeCatalog(f.resourceRoot, '1.0.2')?.list()).toMatchObject({ ok: true, data: [{ compatibility: { available: false, code: 'sdk_version_mismatch' } }, { compatibility: { available: false, code: 'sdk_version_mismatch' } }] });
    expect(makeCatalog(f.resourceRoot, '1.0.2')?.validateSelection(selection)).toMatchObject({ ok: false, error: { code: 'extension_incompatible' } });
    writeFileSync(f.file, JSON.stringify({ ...manifest, entryId: 'C:/untrusted.js' }));
    expect(hub.validateSelection(selection)).toMatchObject({ ok: false, error: { code: 'extension_config_invalid' } });
    unlinkSync(f.file);
    expect(hub.validateSelection({ enabledExtensions: [] })).toMatchObject({ ok: true });
    expect(hub.freeze({ selection: { enabledExtensions: [] }, settingsRevision: 8, activeToolNames: [], policy: 'p3' })).toMatchObject({ ok: true });
    expect(hub.list()).toMatchObject({ ok: false });
  });

  it('[F12-02/03] upgrades v1..v4 once with backups and saves v6 with CAS and original-file preservation', async () => {
    const f = fixture(), file = join(f.root, 'settings.json');
    for (const version of [1, 2, 3, 4]) {
      const old: Record<string, unknown> = { ...defaultProductSettings(at), version, revision: 7 };
      delete old.extensions;
      if (version < 4) delete old.resources;
      if (version < 3) delete old.runtime;
      const original = JSON.stringify(old); writeFileSync(file, original);
      const loaded = await readProductSettings(file);
      expect(loaded).toMatchObject({ ok: true, data: { version: 7, revision: 7, extensions: { enabledExtensions: [] } } });
      expect(JSON.parse(readFileSync(file, 'utf8'))).toMatchObject({ version: 7, revision: 7 });
      expect(readdirSync(f.root).filter(name => name.startsWith('settings.json.pre-v6.')).some(name => readFileSync(join(f.root, name), 'utf8') === original)).toBe(true);
      if (!loaded.ok) continue;
      const next = { ...loaded.data, extensions: selection };
      expect(await saveProductSettings(file, next, at)).toMatchObject({ ok: true, data: { version: 7, revision: 8, extensions: selection } });
      expect(await saveProductSettings(file, next, at)).toMatchObject({ ok: false, error: { code: 'config_revision_conflict' } });
      const saved = readFileSync(file, 'utf8'), rename = spyOn(fsPromises, 'rename').mockRejectedValueOnce(new Error('controlled rename failure'));
      try {
        const current = await readProductSettings(file); if (!current.ok) throw new Error(current.error.code);
        expect(await saveProductSettings(file, { ...current.data, extensions: { enabledExtensions: [] } })).toMatchObject({ ok: false, error: { code: 'config_settings_write_failed' } });
        expect(readFileSync(file, 'utf8')).toBe(saved);
      } finally { rename.mockRestore(); }
    }
  });

  it('[F12-04] checks explicit extension dependencies without loading code or silently enabling them', () => {
    const f = fixture(), skillDir = join(f.resourceRoot, 'skills', 'invoice'); mkdirSync(skillDir, { recursive: true });
    const text = '---\nname: invoice\ndescription: Invoice source SOP\n---\nCheck original invoice sources.';
    const skillManifest = { schemaVersion: 2, kind: 'skill', id: 'invoice', version: 'v1', bodyFile: 'SKILL.md', keywords: [],
      requires: [{ kind: 'extension', id: 'invoice-assist', version: 'v1' }],
      files: [{ path: 'SKILL.md', bytes: Buffer.byteLength(text) }] };
    writeFileSync(join(skillDir, 'SKILL.md'), text); writeFileSync(join(skillDir, 'resource.json'), JSON.stringify(skillManifest));
    const hub = createResourceService({ contents: f.contents, resourceRoot: f.resourceRoot, bundleRoot: join(f.root, 'bundles'), registeredToolNames: ['check_invoice_sources'], inspectNativeResources });
    const catalog = hub.catalog({ revision: 1, selection: { prompt: null, enabledSkills: [] } });
    if (!catalog.ok) throw new Error(catalog.error.code);
    const skill = catalog.data.items.find(item => item.ref.kind === 'skill')!.ref;
    const resources = { prompt: null, enabledSkills: [skill] }, availableExtensions = [{ id: 'invoice-assist', version: 'v1' }];
    expect(hub.validateSelection(resources)).toMatchObject({ ok: false, error: { code: 'resource_dependency_missing' } });
    expect(hub.validateSelection(resources, availableExtensions)).toMatchObject({ ok: true });
    const request = { selection: resources, settingsRevision: 2, activeToolNames: ['check_invoice_sources'], requiredSkill: skill };
    expect(hub.freeze(request)).toMatchObject({ ok: false, error: { code: 'resource_dependency_missing' } });
    expect(hub.freeze({ ...request, availableExtensions })).toMatchObject({ ok: true, data: { discoveredSkills: [skill], settingsRevision: 2 } });
    expect(hub.freeze({ ...request, requiredSkill: null })).toMatchObject({ ok: true, data: { discoveredSkills: [], excludedSkills: [{ ref: skill }] } });
  });
});
