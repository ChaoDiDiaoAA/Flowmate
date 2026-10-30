import { expect, test } from 'bun:test';
import { ok } from '@flowmate/contracts';
import { defaultProductSettings } from '../../packages/core/src/configuration/settings.ts';
import { prepareExperimentCredentials } from '../../apps/desktop/main/evaluation-settings.ts';
import type { EvaluationSettingsPorts } from '../../apps/desktop/main/evaluation-settings.ts';

const deepseek = { api: 'openai-completions' as const, model: 'deepseek-v4-flash', baseUrl: 'https://api.deepseek.com/v1' };
const luna = { api: 'openai-completions' as const, model: 'gpt-6-luna', baseUrl: 'http://127.0.0.1:8767/v1' };
const plan = { benchmark: { id: 'baseline', revision: 1, selection: 'smoke' }, repeats: 1, axes: ['model'],
  control: { id: 'deepseek', model: deepseek }, candidates: [{ id: 'luna', model: luna }] };
const profile = (id: string, connection: typeof deepseek | typeof luna) => ({ ...connection, id, name: id, credentialRef: id + '_credential_ref',
  kind: 'custom' as const, providerId: null, contextWindow: 1048576, maxTokens: 32768, reasoning: true });

test('desktop resolves only exact arm profiles and local Luna never reads or receives another provider key', async () => {
  const settings = { ...defaultProductSettings(), models: [profile('deepseek', deepseek), profile('luna', luna)] }, reads: string[] = [];
  const store: EvaluationSettingsPorts['credentialStore'] = reference => ({ status: async () => 'configured',
    read: async () => { reads.push(reference); return ok('pi-credential-v1:' + JSON.stringify({ type: 'api_key', key: 'synthetic-deepseek-private' })); },
    write: async () => { throw Error('Must not write credentials'); }, remove: async () => { throw Error('Must not remove credentials'); } });
  const result = await prepareExperimentCredentials(plan, settings, store);
  expect(result).toMatchObject({ ok: true, data: [{ connection: deepseek, apiKey: 'synthetic-deepseek-private' }, { connection: luna, apiKey: 'flowmate-local-no-auth' }] });
  expect(reads).toEqual(['deepseek_credential_ref']); expect(JSON.stringify(plan)).not.toContain('synthetic-deepseek-private');
});

test('unmatched profiles stay absent for backend validation and duplicate matches cannot select a credential arbitrarily', async () => {
  let reads = 0;
  const store: EvaluationSettingsPorts['credentialStore'] = () => ({ status: async () => 'configured', read: async () => { reads++; return ok('synthetic-key'); },
    write: async () => ok(undefined), remove: async () => ok(undefined) });
  expect(await prepareExperimentCredentials(plan, { ...defaultProductSettings(), models: [] }, store)).toEqual({ ok: true, data: [] });
  const settings = { ...defaultProductSettings(), models: [profile('one', deepseek), profile('two', { ...deepseek, baseUrl: deepseek.baseUrl + '/' })] };
  expect(await prepareExperimentCredentials(plan, settings, store)).toMatchObject({ ok: false, error: { code: 'evaluation_not_ready' } });
  expect(reads).toBe(0);
});
