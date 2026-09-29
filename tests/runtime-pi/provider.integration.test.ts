import { InMemoryCredentialStore } from '@earendil-works/pi-ai';
import { describe, expect, it, mock } from 'bun:test';
import { PiProviderAdapter, type FetchLike } from '../../packages/runtime-pi/src/provider.ts';
import { prepareModelRuntime } from '../../packages/runtime-pi/src/model-runtime.ts';
import type { ProviderConfig } from '../../packages/contracts/src/runtime.ts';
import type { NativeObservation } from '../../packages/contracts/src/ports.ts';

const config: ProviderConfig = {
  version: 1,
  name: 'fixture',
  revision: 1,
  modelRef: { provider: 'deepseek', model: 'deepseek-v4-flash' },
  native: { authPath: 'C:\\Users\\test\\.pi\\auth.json', modelsPath: null },
  parameters: { maxRetries: 0, maxRetryDelayMs: 2000 },
};

const input = { goal: '返回一句话', text: '合成文本', messageTimestamp: 1789948800000 };

describe('PiProviderAdapter', () => {
  it('requires a real output limit for an unknown custom model', async () => {
    const profile: ProviderConfig = { ...config,
      modelRef: { provider: 'flowmate-profile-test', model: 'deepseek-flash' },
      connection: { baseUrl: 'http://127.0.0.1:9999', api: 'openai-responses' } };
    const prepared = await prepareModelRuntime(profile, { timeoutMs: 10_000, stopGraceMs: 5_000 },
      new AbortController().signal, { runtimeApiKey: 'SYNTHETIC_ONLY' });
    expect(prepared.ok).toBe(false);
    if (!prepared.ok) expect(prepared.error.code).toBe('provider_model_limits_missing');
    const configured = await prepareModelRuntime({ ...profile, connection: { ...profile.connection!, contextWindow: 64_000, maxTokens: 16_384 } },
      { timeoutMs: 10_000, stopGraceMs: 5_000 }, new AbortController().signal, { runtimeApiKey: 'SYNTHETIC_ONLY' });
    expect(configured.ok).toBe(true);
    if (configured.ok) expect(configured.data.model.maxTokens).toBe(16_384);
  });
  it('resolves Pi model metadata offline without adding a Flowmate output-token setting', async () => {
    const adapter = new PiProviderAdapter({ credentials: new InMemoryCredentialStore(), runtimeApiKey: 'SYNTHETIC_ONLY', fetch: mock<FetchLike>() });
    const prepared = await adapter.prepare(config, { timeoutMs: 10000, stopGraceMs: 5000 }, new AbortController().signal);
    expect(prepared.ok).toBe(true);
    if (!prepared.ok) return;
    expect(prepared.data.snapshot.parameters).toEqual({ maxRetries: 0, maxRetryDelayMs: 2000 });
    expect(prepared.data.snapshot).not.toHaveProperty('outputBudget');
  });
  it('reports a model or service output-limit stop without implying a Flowmate override', async () => {
    const response = { id: 'synthetic-budget-limit', model: 'synthetic-model', status: 'incomplete', output: [],
      incomplete_details: { reason: 'max_output_tokens' },
      usage: { input_tokens: 34, output_tokens: 512, total_tokens: 546, output_tokens_details: { reasoning_tokens: 512 } } };
    const fetch = mock<FetchLike>(async () => new Response(`event: response.incomplete\ndata: ${JSON.stringify({ type: 'response.incomplete', response })}\n\n`,
      { status: 200, headers: { 'content-type': 'text/event-stream' } }));
    const adapter = new PiProviderAdapter({ runtimeApiKey: 'SYNTHETIC_ONLY', fetch });
    const requested: ProviderConfig = { ...config, modelRef: { provider: 'flowmate-env', model: 'synthetic-model' },
      connection: { baseUrl: 'https://not-contacted.invalid/v1', api: 'openai-responses', contextWindow: 64_000, maxTokens: 16_384 } };
    const prepared = await adapter.prepare(requested, { timeoutMs: 10_000, stopGraceMs: 5000 }, new AbortController().signal);
    expect(prepared.ok).toBe(true);
    if (!prepared.ok) return;
    const outcome = await prepared.data.execute(input, new AbortController().signal, () => undefined);
    expect(outcome.stopReason).toBe('length');
    expect(outcome.text).toBe('');
    expect(outcome.tokens.outputTokens).toBe(512);
    expect(outcome.error?.code).toBe('provider_incomplete_response');
    expect(outcome.error?.message).toContain('模型或服务端输出限制');
    expect(fetch).toHaveBeenCalledTimes(1);
  });
  it('[F-missing-auth] rejects missing native credentials before an HTTP attempt', async () => {
    const previousKey = process.env.DEEPSEEK_API_KEY;
    delete process.env.DEEPSEEK_API_KEY;
    const fetch = mock<FetchLike>();
    try {
      const adapter = new PiProviderAdapter({
        credentials: new InMemoryCredentialStore(),
        fetch,
      });
      const prepared = await adapter.prepare(config, { timeoutMs: 10_000, stopGraceMs: 5_000 }, new AbortController().signal);

      expect(prepared.ok).toBe(false);
      if (!prepared.ok) expect(prepared.error.code).toBe('provider_auth_failed');
      expect(fetch).not.toHaveBeenCalled();
    } finally {
      if (previousKey === undefined) delete process.env.DEEPSEEK_API_KEY;
      else process.env.DEEPSEEK_API_KEY = previousKey;
    }
  });

  it('matches catalog metadata only when model, protocol and endpoint all agree', async () => {
    const adapter = new PiProviderAdapter({ credentials: new InMemoryCredentialStore(), runtimeApiKey: 'SYNTHETIC_ONLY', fetch: mock<FetchLike>() });
    const native = await adapter.prepare(config, { timeoutMs: 10000, stopGraceMs: 5000 }, new AbortController().signal);
    expect(native.ok).toBe(true);
    if (!native.ok) return;
    const baseUrl = native.data.snapshot.endpoint!;
    for (const [url, api] of [[baseUrl, native.data.snapshot.api!], ['https://gateway.invalid/v1', 'openai-completions'], [baseUrl, 'openai-responses']] as const) {
      const prepared = await adapter.prepare({ ...config, modelRef: { provider: 'flowmate-env', model: config.modelRef.model }, connection: { baseUrl: url, api }, parameters: { maxRetries: 0, maxRetryDelayMs: 1000 } }, { timeoutMs: 10000, stopGraceMs: 5000 }, new AbortController().signal);
      expect(prepared.ok).toBe(url === baseUrl && api === native.data.snapshot.api);
      if (prepared.ok) {
        expect(prepared.data.snapshot.endpoint).toBe(url);
        expect(prepared.data.snapshot.parameters).not.toHaveProperty('maxTokens');
      }
    }
  });

  it('uses Pi streamSimple for a controlled SSE response and reports the final text', async () => {
    const credentials = new InMemoryCredentialStore();
    await credentials.modify('deepseek', async () => ({ type: 'api_key', key: 'FLOWMATE_SYNTHETIC_KEY' }));
    const fetch = mock<FetchLike>(async () => new Response([
      'data: {"id":"fixture-1","choices":[{"index":0,"delta":{"content":"你好"},"finish_reason":null}]}\n\n',
      'data: {"id":"fixture-1","choices":[{"index":0,"delta":{},"finish_reason":"stop"}],"usage":{"prompt_tokens":3,"completion_tokens":1,"total_tokens":4}}\n\n',
      'data: [DONE]\n\n',
    ].join(''), { status: 200, headers: { 'content-type': 'text/event-stream' } }));
    const adapter = new PiProviderAdapter({ credentials, fetch });
    const prepared = await adapter.prepare(config, { timeoutMs: 10_000, stopGraceMs: 5_000 }, new AbortController().signal);
    expect(prepared.ok).toBe(true);
    if (!prepared.ok) return;

    const events: NativeObservation[] = [];
    const outcome = await prepared.data.execute(input, new AbortController().signal, (event) => events.push(event));

    expect(outcome.error).toBeNull();
    expect(outcome.text).toContain('你好');
    expect(outcome.stopReason).toBe('stop');
    expect(outcome.stopped).toBe(true);
    expect(events.map((event) => event.type)).toContain('request_dispatched');
    expect(events.map((event) => event.type)).toContain('native_terminal');
    expect(events[0]?.type).toBe('model_request');
    expect(events[0]?.data).toEqual({ messages: [{ role: 'user', content: '返回一句话\n\n合成文本', timestamp: input.messageTimestamp }], tools: [] });
    expect(JSON.stringify(events)).not.toContain('FLOWMATE_SYNTHETIC_KEY');
    expect(events.some((event) => event.type === 'text_delta' && Number(event.data.length) > 0)).toBe(true);
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it('registers the environment-defined endpoint with Pi and keeps its API key out of the persisted snapshot', async () => {
    const envConfig: ProviderConfig = {
      ...config,
      modelRef: { provider: 'flowmate-env', model: 'invoice-model' },
      connection: { baseUrl: 'https://llm.example.com/v1', api: 'openai-completions', contextWindow: 64_000, maxTokens: 16_384 },
      parameters: { maxRetries: 0, maxRetryDelayMs: 1000 },
    };
    const fetch = mock<FetchLike>(async () => new Response([
      'data: {"id":"env-1","choices":[{"index":0,"delta":{"content":"已提取"},"finish_reason":null}]}\n\n',
      'data: {"id":"env-1","choices":[{"index":0,"delta":{},"finish_reason":"stop"}],"usage":{"prompt_tokens":3,"completion_tokens":1,"total_tokens":4}}\n\n',
      'data: [DONE]\n\n',
    ].join(''), { status: 200, headers: { 'content-type': 'text/event-stream' } }));
    const adapter = new PiProviderAdapter({ runtimeApiKey: 'ENV_TEST_KEY', fetch });

    const prepared = await adapter.prepare(envConfig, { timeoutMs: 10_000, stopGraceMs: 5_000 }, new AbortController().signal);

    expect(prepared.ok).toBe(true);
    if (!prepared.ok) return;
    expect(prepared.data.snapshot).not.toHaveProperty('outputBudget');
    expect(prepared.data.snapshot.parameters).not.toHaveProperty('maxTokens');
    const outcome = await prepared.data.execute(input, new AbortController().signal, () => undefined);
    const [requestInput, requestInit] = fetch.mock.calls[0] ?? [];
    expect(outcome.wireMaxTokens).toBe(16_384);
    const request = requestInput === undefined ? null : new Request(requestInput, requestInit);
    expect(outcome.text).toContain('已提取');
    expect(prepared.data.snapshot.endpoint).toBe('https://llm.example.com/v1');
    expect(JSON.stringify(prepared.data.snapshot)).not.toContain('ENV_TEST_KEY');
    expect(request?.url).toBe('https://llm.example.com/v1/chat/completions');
    if (request) {
      expect(request.headers.get('authorization')).toBe('Bearer ENV_TEST_KEY');
      const payload = await request.json();
      expect(payload.model).toBe('invoice-model');
      expect(payload.max_tokens ?? payload.max_completion_tokens).toBe(16_384);
    }
  });

  it('[F-output-limit] fails closed when the streamed response exceeds the output limit', async () => {
    const credentials = new InMemoryCredentialStore();
    await credentials.modify('deepseek', async () => ({ type: 'api_key', key: 'FLOWMATE_SYNTHETIC_KEY' }));
    const oversized = 'x'.repeat(256 * 1024 + 1);
    let requestSignal: AbortSignal | undefined;
    const witnesses: Readonly<Record<string, unknown>>[] = [];
    const fetch = mock<FetchLike>(async (_request, init) => {
      requestSignal = init?.signal as AbortSignal | undefined;
      const encoded = new TextEncoder().encode(`data: ${JSON.stringify({ id: 'fixture-limit', choices: [{ index: 0, delta: { content: oversized }, finish_reason: null }] })}\n\n`);
      return new Response(new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(encoded);
          requestSignal?.addEventListener('abort', () => controller.close(), { once: true });
        },
      }), { status: 200, headers: { 'content-type': 'text/event-stream' } });
    });
    const adapter = new PiProviderAdapter({ credentials, fetch, witness: (entry) => witnesses.push(entry) });
    const prepared = await adapter.prepare(config, { timeoutMs: 10_000, stopGraceMs: 5_000 }, new AbortController().signal);
    expect(prepared.ok).toBe(true);
    if (!prepared.ok) return;

    const outcome = await prepared.data.execute(input, new AbortController().signal, () => undefined);

    expect(outcome.error?.code).toBe('provider_output_limit');
    expect(outcome.partial).toBe(true);
    expect(new TextEncoder().encode(outcome.text).byteLength).toBeLessThanOrEqual(256 * 1024);
    expect(requestSignal?.aborted).toBe(true);
    expect(witnesses).toContainEqual({ type: 'output_limit_stop', stopped: true, streamFailed: false, aborted: true });
    expect(outcome.stopped).toBe(true);
    expect(outcome.usage.source).toBe('unknown');
  });

  it('[F-output-limit-stop-unconfirmed] preserves bounded partial text when the transport ignores abort', async () => {
    const credentials = new InMemoryCredentialStore();
    await credentials.modify('deepseek', async () => ({ type: 'api_key', key: 'FLOWMATE_SYNTHETIC_KEY' }));
    const oversized = 'x'.repeat(256 * 1024 + 1);
    let bodyController: ReadableStreamDefaultController<Uint8Array> | undefined;
    let requestSignal: AbortSignal | undefined;
    const witnesses: Readonly<Record<string, unknown>>[] = [];
    const fetch = mock<FetchLike>(async (_request, init) => {
      requestSignal = init?.signal as AbortSignal | undefined;
      const encoded = new TextEncoder().encode(`data: ${JSON.stringify({ id: 'fixture-limit-hang', choices: [{ index: 0, delta: { content: oversized }, finish_reason: null }] })}\n\n`);
      return new Response(new ReadableStream<Uint8Array>({
        start(controller) {
          bodyController = controller;
          controller.enqueue(encoded);
        },
      }), { status: 200, headers: { 'content-type': 'text/event-stream' } });
    });
    const adapter = new PiProviderAdapter({ credentials, fetch, witness: (entry) => witnesses.push(entry) });
    const prepared = await adapter.prepare(config, { timeoutMs: 10_000, stopGraceMs: 25 }, new AbortController().signal);
    expect(prepared.ok).toBe(true);
    if (!prepared.ok) return;

    const outcome = await prepared.data.execute(input, new AbortController().signal, () => undefined);

    expect(outcome.error?.code).toBe('provider_output_limit');
    expect(new TextEncoder().encode(outcome.text).byteLength).toBeLessThanOrEqual(256 * 1024);
    expect(requestSignal?.aborted).toBe(true);
    expect(outcome.stopped).toBe(false);
    expect(outcome.cleanupErrors.map((entry) => entry.code)).toContain('stop_unconfirmed');
    expect(witnesses).toContainEqual({ type: 'output_limit_stop', stopped: false, streamFailed: false, aborted: true });
    bodyController?.close();
  });

  it('[F-network-failure] classifies a transport failure before any response as a network error', async () => {
    const credentials = new InMemoryCredentialStore();
    await credentials.modify('deepseek', async () => ({ type: 'api_key', key: 'FLOWMATE_SYNTHETIC_KEY' }));
    const fetch = mock<FetchLike>(async () => { throw new Error('synthetic socket reset'); });
    const adapter = new PiProviderAdapter({ credentials, fetch });
    const prepared = await adapter.prepare(config, { timeoutMs: 10_000, stopGraceMs: 5_000 }, new AbortController().signal);
    expect(prepared.ok).toBe(true);
    if (!prepared.ok) return;

    const outcome = await prepared.data.execute(input, new AbortController().signal, () => undefined);

    expect(outcome.error?.code).toBe('provider_network_error');
    expect(outcome.partial).toBe(false);
    expect(outcome.usage.attempts).toBe(1);
    expect(outcome.usage.attemptsComplete).toBe(false);
  });

  it('[F-auth-source-change] does not turn credentials removed after prepare into success', async () => {
    const credentials = new InMemoryCredentialStore();
    await credentials.modify('deepseek', async () => ({ type: 'api_key', key: 'FLOWMATE_SYNTHETIC_KEY' }));
    const fetch = mock<FetchLike>(async () => new Response('unexpected', { status: 200 }));
    const adapter = new PiProviderAdapter({ credentials, fetch });
    const prepared = await adapter.prepare(config, { timeoutMs: 10_000, stopGraceMs: 5_000 }, new AbortController().signal);
    expect(prepared.ok).toBe(true);
    if (!prepared.ok) return;

    await credentials.delete('deepseek');
    const outcome = await prepared.data.execute(input, new AbortController().signal, () => undefined);

    expect(outcome.error).not.toBeNull();
    expect(outcome.text).not.toContain('FLOWMATE_SYNTHETIC_KEY');
    expect(outcome.stopReason).not.toBe('stop');
  });
});
