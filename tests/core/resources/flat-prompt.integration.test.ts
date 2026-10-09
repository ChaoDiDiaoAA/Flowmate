import { expect, it } from 'bun:test';
import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { canonicalResourceManifest } from '../../../packages/contracts/src/index.ts';
import { createResourceService } from '../../../packages/core/src/index.ts';
import { inspectNativeResources } from '../../../packages/runtime-pi/src/index.ts';
import { mkdtempSync } from '../../support/resources.ts';

it('loads one flat Prompt author package without changing its version or fixed bundle identity', () => {
  const root = mkdtempSync(join(tmpdir(), 'flowmate-flat-prompt-'));
  const author = join(root, 'author'), dir = join(author, 'prompts', 'invoice');
  mkdirSync(dir, { recursive: true });
  const original = join(import.meta.dir, '../../../resources/prompts/invoice');
  const manifestText = readFileSync(join(original, 'resource.json'), 'utf8');
  const body = readFileSync(join(original, 'prompt.md'));
  writeFileSync(join(dir, 'resource.json'), manifestText); writeFileSync(join(dir, 'prompt.md'), body);
  const service = createResourceService({ resourceRoot: author, bundleRoot: join(root, 'bundles'), registeredToolNames: [], inspectNativeResources });
  const catalog = service.catalog({ revision: 0, selection: { prompt: null, enabledSkills: [] } });
  expect(catalog.ok).toBe(true); if (!catalog.ok) throw new Error(catalog.error.code);
  expect(catalog.data.diagnostics).toEqual([]); expect(catalog.data.items).toHaveLength(1);
  const ref = catalog.data.items[0]!.ref;
  expect(ref).toMatchObject({ id: 'invoice', version: 'v1', contentHash: createHash('sha256').update(canonicalResourceManifest(JSON.parse(manifestText))).digest('hex') });
  const frozen = service.freeze({ settingsRevision: 0, selection: { prompt: ref, enabledSkills: [] }, activeToolNames: [], requiredSkill: null });
  expect(frozen.ok).toBe(true); if (!frozen.ok || !frozen.data) throw new Error('missing flat prompt');
  expect(readFileSync(join(frozen.data.bundleDirectory, 'prompts/invoice/v1/prompt.md'))).toEqual(body);
  expect(service.verifyFrozen(frozen.data).ok).toBe(true);
});
