import { expect, test } from 'bun:test';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { mkdtemp } from '../../support/resources.ts';
import { defaultProductSettings, readProductSettings, saveProductSettings, validateProductSettings } from '../../../packages/core/src/configuration/settings.ts';

test('research preferences default empty and persist only an explicit settings save', async () => {
  const root = await mkdtemp(join(tmpdir(), 'flowmate-research-preferences-'));
  const file = join(root, 'settings.json');
  const initial = await readProductSettings(file);
  expect(initial).toMatchObject({ ok: true, data: { researchPreferences: '' } });
  if (!initial.ok) throw Error(initial.error.code);
  const saved = await saveProductSettings(file, { ...initial.data, researchPreferences: 'Compare dates and conflicting source statements.' });
  expect(saved).toMatchObject({ ok: true, data: { revision: 1, researchPreferences: 'Compare dates and conflicting source statements.' } });
  expect(await readProductSettings(file)).toEqual(saved);
  expect(await saveProductSettings(file, { ...initial.data, researchPreferences: 'stale' }))
    .toMatchObject({ ok: false, error: { code: 'config_revision_conflict' } });
});

test('research preferences accept legacy settings and reject an oversized preference', () => {
  const legacy: Record<string, unknown> = { ...defaultProductSettings() };
  delete legacy.researchPreferences;
  expect(validateProductSettings(legacy)).toMatchObject({ ok: true, data: { researchPreferences: '' } });
  expect(validateProductSettings({ ...legacy, researchPreferences: '😀'.repeat(4097) }).ok).toBe(false);
});
