import { mkdtemp } from '../support/resources.ts';
import { test, expect } from "bun:test";
import { rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createApplication } from '../../apps/composition.ts';
import type { ProductPaths, ProviderConfig } from '@flowmate/contracts';
import { createFixtureDependencies } from '../support/pi-provider.ts';
import { PiProviderAdapter } from '@flowmate/runtime-pi';

type FixtureProfile = 'normal' | 'auth' | 'model' | 'timeout' | 'cancel' | 'stream-interrupted' | 'rate-limit' | 'usage-unknown';

function paths(root: string): ProductPaths {
  return {
    root,
    databaseFile: join(root, 'data', 'trial-1.sqlite'),
    logsDir: join(root, 'logs'),
    artifactsDir: join(root, 'artifacts'),
    outputsDir: join(root, 'outputs'),
    runtimeDir: join(root, 'runtime'),
  };
}

function config(root: string, profile: FixtureProfile): ProviderConfig {
  return {
    version: 1,
    name: 'controlled-provider',
    revision: 1,
    modelRef: {
      provider: 'deepseek',
    model: profile === 'model' ? 'flowmate-p1-intentionally-absent-model' : 'deepseek-v4-flash',
    },
    native: { authPath: join(root, 'auth.json'), modelsPath: null },
    parameters: { maxRetries: profile === 'rate-limit' ? 1 : 0, maxRetryDelayMs: 10 },
  };
}

async function runProfile(root: string, profile: FixtureProfile): Promise<{ profile: FixtureProfile; status: string; code: string | null; stopped: boolean }> {
  let controller: AbortController | undefined;
  const witness = async (value: Readonly<Record<string, unknown>>) => {
    if (profile === 'cancel' && value.type === 'fetch_entered') controller?.abort('user');
  };
  const fixtureProfile = profile === 'model' || profile === 'normal' ? 'none' : profile;
  const fixture = await createFixtureDependencies(fixtureProfile, witness);
  await fixture.credentials.modify('deepseek', async () => ({ type: 'api_key', key: 'fixture-synthetic-key' }));
  const appResult = await createApplication({ paths: paths(root), provider: new PiProviderAdapter(fixture) });
  if (!appResult.ok) throw new Error(`application init failed: ${appResult.error.code}`);
  const app = appResult.data;
  try {
  controller = new AbortController();
  const result = await app.callProvider({
    goal: '请返回一句简短说明。',
    text: '',
    config: config(root, profile),
    timeoutMs: profile === 'timeout' ? 250 : 60_000,
    stopGraceMs: 300,
  }, { signal: controller.signal });
  const runId = result.ok ? result.data.runId : result.runId;
  const snapshot = runId === undefined ? null : await app.queryRun(runId);
  const status = result.ok ? result.data.status : (snapshot && snapshot.ok ? snapshot.data.status : 'error');
  const code = result.ok ? result.data.error?.code ?? null : result.error.code;
  const stopped = result.ok ? result.data.stopped : false;
  return { profile, status, code, stopped };
  } finally {
    const close = await app.close();
    if (!close.ok || !close.data.closed) throw new Error(`close failed for ${profile}`);
  }
}

const expected: Record<FixtureProfile, [string, string | null]> = {
  normal: ['completed', null], auth: ['failed', 'provider_auth_failed'], model: ['failed', 'provider_model_not_found'],
  timeout: ['failed', 'provider_timeout'], cancel: ['cancelled', 'provider_cancelled'],
  'stream-interrupted': ['failed', 'provider_stream_interrupted'], 'rate-limit': ['completed', null], 'usage-unknown': ['completed', null]
};
for (const profile of Object.keys(expected) as FixtureProfile[]) test(`real Provider adapter controlled ${profile}`, async () => {
  const root = await mkdtemp(join(tmpdir(), 'flowmate-provider-'));
  try {
    const result = await runProfile(root, profile);
    expect([result.status, result.code]).toEqual(expected[profile]);
    expect(result.stopped).toBe(true);
  } finally { await rm(root, { recursive: true, force: true }); }
});
