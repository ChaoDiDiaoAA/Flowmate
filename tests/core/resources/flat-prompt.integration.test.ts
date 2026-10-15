import { resolveProductPaths } from '@flowmate/shared';
import { expect, it } from 'bun:test';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createResourceService, openDatabase } from '../../../packages/core/src/index.ts';
import { inspectNativeResources } from '../../../packages/runtime-pi/src/index.ts';
import { mkdtempSync, deferCleanup } from '../../support/resources.ts';

it('loads one flat Prompt author package without changing its version or fixed bundle identity', () => {
  const root = mkdtempSync(join(tmpdir(), 'flowmate-flat-prompt-'));
  const author = join(root, 'author'), dir = join(author, 'prompts', 'invoice');
  mkdirSync(dir, { recursive: true });
  const original = join(import.meta.dir, '../../../resources/prompts/invoice');
  const manifestText = readFileSync(join(original, 'resource.json'), 'utf8');
  const body = readFileSync(join(original, 'prompt.md'));
  writeFileSync(join(dir, 'resource.json'), manifestText); writeFileSync(join(dir, 'prompt.md'), body);
  const paths = resolveProductPaths(join(root, 'product')); if (!paths.ok) throw new Error(paths.error.code);
  const storage = openDatabase(paths.data); if (!storage.ok) throw new Error(storage.error.code); deferCleanup(() => storage.data.close());
  const service = createResourceService({ contents: storage.data.contents, resourceRoot: author, bundleRoot: join(root, 'bundles'), registeredToolNames: [], inspectNativeResources });
  const catalog = service.catalog({ revision: 0, selection: { prompt: null, enabledSkills: [] } });
  expect(catalog.ok).toBe(true); if (!catalog.ok) throw new Error(catalog.error.code);
  expect(catalog.data.diagnostics).toEqual([]); expect(catalog.data.items).toHaveLength(1);
  const ref = catalog.data.items[0]!.ref;
  expect(ref).toMatchObject({ id: 'invoice', version: 'v1', kind: 'prompt' });
  const frozen = service.freeze({ settingsRevision: 0, selection: { prompt: ref, enabledSkills: [] }, activeToolNames: [], requiredSkill: null });
  expect(frozen.ok).toBe(true); if (!frozen.ok || !frozen.data) throw new Error('missing flat prompt');
  expect(readFileSync(join(frozen.data.bundleDirectory, 'prompts/invoice/v1/prompt.md'))).toEqual(body);
  expect(service.verifyFrozen(frozen.data).ok).toBe(true);
  const changed = Buffer.from(body);
  changed[changed.length - 1] = changed[changed.length - 1] === 32 ? 10 : 32;
  writeFileSync(join(frozen.data.bundleDirectory, 'prompts/invoice/v1/prompt.md'), changed);
  expect(service.verifyFrozen(frozen.data)).toMatchObject({ ok: false, error: { code: 'resource_bundle_unavailable' } });
  storage.data.close();
  const restarted = openDatabase(paths.data); if (!restarted.ok) throw new Error(restarted.error.code);
  deferCleanup(() => restarted.data.close());
  const restored = createResourceService({ contents: restarted.data.contents, resourceRoot: author,
    bundleRoot: join(root, 'bundles'), registeredToolNames: [], inspectNativeResources });
  expect(restored.readFrozenFile(frozen.data, { ref, path: 'prompt.md' })).toMatchObject({ ok: false, error: { code: 'resource_bundle_unavailable' } });
  writeFileSync(join(frozen.data.bundleDirectory, 'prompts/invoice/v1/prompt.md'), body);
  expect(restored.verifyFrozen(frozen.data).ok).toBe(true);
  const withoutOriginal = createResourceService({ contents: { read: () => null, remember: () => {} }, resourceRoot: author,
    bundleRoot: join(root, 'bundles'), registeredToolNames: [], inspectNativeResources });
  expect(withoutOriginal.verifyFrozen(frozen.data)).toMatchObject({ ok: false, error: { code: 'resource_bundle_unavailable' } });
});
