import { mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createAssistantMessageEventStream, InMemoryCredentialStore, InMemoryModelsStore, type AssistantMessage } from '@earendil-works/pi-ai';
import { ModelRuntime } from '@earendil-works/pi-coding-agent';
import { expect, it } from 'bun:test';
import { ok, type ProviderConfig, type NativeObservation } from '@flowmate/contracts';
import { PiProviderAdapter } from '../../packages/runtime-pi/src/provider.ts';
import { PiAgentAdapter } from '../../packages/runtime-pi/src/session.ts';
import { mkdtempSync } from '../support/resources.ts';

const apis = ['google-generative-ai', 'google-vertex', 'bedrock-converse-stream',
  'openai-completions', 'openai-responses', 'azure-openai-responses', 'openai-codex-responses',
  'anthropic-messages', 'mistral-conversations', 'pi-messages'];

it.each(apis)('uses only verified fetch support for Provider and Agent %s', async (api) => {
  const root = mkdtempSync(join(tmpdir(), 'flowmate-transport-options-'));
  const cwd = join(root, 'project');
  const agentDir = join(root, 'agent');
  mkdirSync(cwd);
  mkdirSync(agentDir);
  const credentials = new InMemoryCredentialStore();
  const runtime = await ModelRuntime.create({ credentials, modelsStore: new InMemoryModelsStore(),
    authPath: join(root, 'auth.json'), allowModelNetwork: false, refreshOnCreate: false });
  const model = runtime.getModels().find((item) => item.api === api && (api !== 'openai-responses' || item.provider === 'openai'));
  if (api !== 'pi-messages' && !model) throw new Error(`Locked SDK public catalog has no ${api} model`);
  const custom = !model || api === 'openai-codex-responses';
  const config: ProviderConfig = { version: 1, name: 'Synthetic', revision: 1,
    modelRef: custom ? { provider: 'synthetic', model: model?.id ?? 'synthetic' } : { provider: model.provider, model: model.id },
    native: { authPath: join(root, 'auth.json'), modelsPath: null },
    ...(custom ? { connection: { api, baseUrl: 'https://fixture.invalid/v1', contextWindow: model?.contextWindow ?? 64_000, maxTokens: model?.maxTokens ?? 16_384 } } : {}),
    parameters: { maxRetries: 0, maxRetryDelayMs: 1 } };
  let fetchCalls = 0;
  const dependencies = { credentials, runtimeApiKey: 'SYNTHETIC_ONLY', fetch: async () => {
    fetchCalls += 1;
    throw new Error('The transport option test must not send a request');
  } };
  const provider = new PiProviderAdapter(dependencies);
  const agent = new PiAgentAdapter({ ...dependencies, cwd, agentDir });
  const captured: Array<Parameters<ModelRuntime['streamSimple']>[2]> = [];
  let nativeFailure = false;
  const original = ModelRuntime.prototype.streamSimple;
  ModelRuntime.prototype.streamSimple = function (requested, _context, options) {
    expect(requested.api).toBe(api);
    captured.push(options);
    const stream = createAssistantMessageEventStream();
    const message: AssistantMessage = { role: 'assistant', api, provider: requested.provider, model: requested.id,
      content: nativeFailure ? [] : [{ type: 'text', text: 'Synthetic answer' }], stopReason: nativeFailure ? 'error' : 'stop', timestamp: 1,
      usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0,
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } } };
    queueMicrotask(async () => {
      await options?.onPayload?.({ generationConfig: { maxOutputTokens: requested.maxTokens } }, requested);
      if (nativeFailure) {
        stream.push({ type: 'error', reason: 'error', error: { ...message, errorMessage: 'SYNTHETIC_PRIVATE_ERROR' } });
        return;
      }
      stream.push({ type: 'start', partial: message });
      stream.push({ type: 'text_delta', contentIndex: 0, delta: 'Synthetic answer', partial: message });
      stream.push({ type: 'done', reason: 'stop', message });
    });
    return stream;
  };
  const signal = new AbortController().signal;
  const input = { goal: 'Synthetic test', text: '', messageTimestamp: 1 };
  const limits = { timeoutMs: 1_000, stopGraceMs: 100 };
  try {
    const prepared = await provider.prepare(config, limits, signal);
    if (!prepared.ok) throw new Error(prepared.error.code);
    expect(prepared.data.snapshot.api).toBe(api);
    const observations: NativeObservation[] = [];
    const outcome = await prepared.data.execute(input, signal, (event) => observations.push(event));
    const supported = !['google-generative-ai', 'google-vertex', 'bedrock-converse-stream'].includes(api);
    expect(typeof captured[0]?.fetch).toBe(supported ? 'function' : 'undefined');
    expect(outcome.error).toBeNull();
    expect(outcome.usage).toMatchObject({ source: 'unknown', reason: 'request-attempts-unobserved',
      attempts: null, attemptsComplete: false });
    expect(observations.some((event) => event.type === 'request_dispatched')).toBe(false);
    const created = agent.createSession();
    if (!created.ok) throw new Error(created.error.code);
    const preparedAgent = await agent.prepare(created.data.nativeSessionId, config, limits, signal);
    if (!preparedAgent.ok) throw new Error(preparedAgent.error.code);
    const agentOutcome = await preparedAgent.data.execute({ ...input, runId: 1, sessionId: 1,
      verifyModelUse: () => ok(undefined) }, signal, () => undefined);
    expect(agentOutcome.error).toBeNull();
    expect(agentOutcome.usage).toMatchObject({ source: 'unknown', reason: 'request-attempts-unobserved',
      attempts: null, attemptsComplete: false });
    expect(captured).toHaveLength(2);
    for (const options of captured) expect(typeof options?.fetch).toBe(supported ? 'function' : 'undefined');
    nativeFailure = true;
    const failed = await prepared.data.execute(input, signal, () => undefined);
    expect(failed.error?.code).toBe('provider_error');
    expect(failed.usage).toMatchObject({ source: 'unknown', reason: 'request-attempts-unobserved', attempts: null, attemptsComplete: false });
    expect(JSON.stringify(failed)).not.toContain('SYNTHETIC_PRIVATE_ERROR');
    const failedAgent = await preparedAgent.data.execute({ ...input, runId: 2, sessionId: 1,
      verifyModelUse: () => ok(undefined) }, signal, () => undefined);
    expect(failedAgent.error?.code).toBe('provider_error');
    expect(failedAgent.usage).toMatchObject({ source: 'unknown', reason: 'request-attempts-unobserved', attempts: null, attemptsComplete: false });
    expect(JSON.stringify(failedAgent)).not.toContain('SYNTHETIC_PRIVATE_ERROR');
    expect(fetchCalls).toBe(0);
  } finally {
    ModelRuntime.prototype.streamSimple = original;
    await agent.close();
    await provider.close();
  }
});
