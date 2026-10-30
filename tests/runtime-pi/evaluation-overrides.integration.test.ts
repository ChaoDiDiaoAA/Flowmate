import { expect, test } from 'bun:test';
import { mkdtempSync } from '../support/resources.ts';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { InMemoryCredentialStore, InMemoryModelsStore, getSupportedThinkingLevels } from '@earendil-works/pi-ai';
import { ModelRuntime } from '@earendil-works/pi-coding-agent';
import { ok, type ProviderConfig } from '@flowmate/contracts';
import { PiAgentAdapter } from '../../packages/runtime-pi/src/session.ts';
import { prepareModelRuntime } from '../../packages/runtime-pi/src/model-runtime.ts';

const config: ProviderConfig = { version: 1, name: 'Evaluation Luna', revision: 1,
  modelRef: { provider: 'evaluation-luna', model: 'gpt-6-luna' }, native: { authPath: 'unused-evaluation-auth', modelsPath: null },
  connection: { api: 'openai-completions', baseUrl: 'http://127.0.0.1:8767/v1', contextWindow: 272000, maxTokens: 32768, reasoning: true },
  parameters: { maxRetries: 0, maxRetryDelayMs: 0 } };

for (const model of ['gpt-6-luna', 'gpt-6.1-sol'])
test('trusted local ' + model + ' max and experiment prompt reach the serialized provider request without clamping', async () => {
  const root = mkdtempSync(join(tmpdir(), 'evaluation-sdk-overrides-')), requests: Record<string, unknown>[] = [];
  const prompt = 'Use only supplied evidence. This is the selected experiment prompt.';
  const adapter = new PiAgentAdapter({ cwd: root, agentDir: root, credentials: new InMemoryCredentialStore(), runtimeApiKey: 'synthetic-evaluation-key',
    systemPromptOverride: prompt, thinkingLevelOverride: 'max', fetch: async (_url, init) => {
      requests.push(JSON.parse(String(init?.body)));
      const chunk = (delta: unknown, finish: string | null) => 'data: ' + JSON.stringify({ id: 'controlled', model, choices: [{ index: 0, delta, finish_reason: finish }] }) + '\n\n';
      return new Response(chunk({ role: 'assistant', content: 'Supported.' }, null) + chunk({}, 'stop') + 'data: [DONE]\n\n', { headers: { 'content-type': 'text/event-stream' } });
    } });
  try {
    const session = adapter.createSession(); if (!session.ok) throw Error(session.error.message);
    const prepared = await adapter.prepare(session.data.nativeSessionId, { ...config, modelRef: { ...config.modelRef, model } },
      { timeoutMs: 5000, stopGraceMs: 1000 }, new AbortController().signal);
    expect(prepared.ok).toBe(true); if (!prepared.ok) throw Error(prepared.error.message);
    expect(prepared.data.snapshot.agent).toMatchObject({ thinkingLevel: 'max' });
    expect(prepared.data.snapshot.agent?.systemPrompt.startsWith(prompt + '\n')).toBe(true);
    const outcome = await prepared.data.execute({ runId: 1, sessionId: 1, goal: 'Summarize evidence', text: 'Original evidence.', messageTimestamp: Date.now(),
      verifyModelUse: () => ok(undefined) }, new AbortController().signal, () => {});
    expect(outcome.error).toBeNull(); expect(requests).toHaveLength(1);
    expect(requests[0]).toMatchObject({ reasoning_effort: 'max' });
    expect(JSON.stringify(requests[0]!.messages)).toContain(prompt);
  } finally { await adapter.close(); }
});

test('an unsupported max request is rejected before any provider dispatch', async () => {
  const root = mkdtempSync(join(tmpdir(), 'evaluation-sdk-unsupported-')); let requests = 0;
  const adapter = new PiAgentAdapter({ cwd: root, agentDir: root, credentials: new InMemoryCredentialStore(), runtimeApiKey: 'synthetic-evaluation-key',
    thinkingLevelOverride: 'max', fetch: async () => { requests++; throw Error('Unsupported configuration must not dispatch'); } });
  try {
    const session = adapter.createSession(); if (!session.ok) throw Error(session.error.message);
    const result = await adapter.prepare(session.data.nativeSessionId, { ...config,
      connection: { ...config.connection!, baseUrl: 'https://unsupported.invalid/v1' } }, { timeoutMs: 5000, stopGraceMs: 1000 }, new AbortController().signal);
    expect(result).toMatchObject({ ok: false, error: { code: 'agent_thinking_level_unsupported' } }); expect(requests).toBe(0);
  } finally { await adapter.close(); }
});

test('explicit connections preserve thinking levels from their exact matching catalog model', async () => {
  const credentials = new InMemoryCredentialStore(), runtime = await ModelRuntime.create({ credentials, modelsStore: new InMemoryModelsStore(),
    modelsPath: null, allowModelNetwork: false, refreshOnCreate: false });
  runtime.registerProvider('declared-catalog', { api: 'openai-completions', baseUrl: 'https://declared.invalid/v1', models: [{ id: 'declared-model',
    name: 'Declared model', input: ['text'], reasoning: true, thinkingLevelMap: { max: 'max' }, contextWindow: 32000, maxTokens: 4000,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } }] });
  const result = await prepareModelRuntime({ ...config, modelRef: { provider: 'evaluation-custom', model: 'declared-model' },
    connection: { api: 'openai-completions', baseUrl: 'https://declared.invalid/v1' } },
    { timeoutMs: 5000, stopGraceMs: 1000 }, new AbortController().signal, { credentials, runtimeApiKey: 'synthetic-key' }, runtime);
  expect(result.ok).toBe(true); if (!result.ok) throw Error(result.error.message);
  expect(getSupportedThinkingLevels(result.data.model)).toContain('max');
});
