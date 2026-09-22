import { InMemoryCredentialStore } from '@earendil-works/pi-ai';
import { describe, expect, it, vi } from 'vitest';
import { PiProviderAdapter, type FetchLike } from '../packages/runtime-pi/src/provider.ts';
import type { ProviderConfig } from '../packages/contracts/src/runtime.ts';

const config: ProviderConfig = {
  version: 1,
  name: 'fixture',
  revision: 1,
  modelRef: { provider: 'deepseek', model: 'deepseek-v4-flash' },
  native: { authPath: 'C:\\Users\\test\\.pi\\auth.json', modelsPath: null },
  parameters: { maxTokens: 64, maxRetries: 0, maxRetryDelayMs: 2000 },
};

const input = { goal: '返回一句话', text: '合成文本', messageTimestamp: 1789948800000 };

describe('PiProviderAdapter', () => {
  it('[F-missing-auth] rejects missing native credentials before an HTTP attempt', async () => {
    const previousKey = process.env.DEEPSEEK_API_KEY;
    delete process.env.DEEPSEEK_API_KEY;
    const fetch = vi.fn<FetchLike>();
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

  it('uses Pi streamSimple for a controlled SSE response and reports the final text', async () => {
    const credentials = new InMemoryCredentialStore();
    await credentials.modify('deepseek', async () => ({ type: 'api_key', key: 'FLOWMATE_SYNTHETIC_KEY' }));
    const fetch = vi.fn<FetchLike>(async () => new Response([
      'data: {"id":"fixture-1","choices":[{"index":0,"delta":{"content":"你好"},"finish_reason":null}]}\n\n',
      'data: {"id":"fixture-1","choices":[{"index":0,"delta":{},"finish_reason":"stop"}],"usage":{"prompt_tokens":3,"completion_tokens":1,"total_tokens":4}}\n\n',
      'data: [DONE]\n\n',
    ].join(''), { status: 200, headers: { 'content-type': 'text/event-stream' } }));
    const adapter = new PiProviderAdapter({ credentials, fetch });
    const prepared = await adapter.prepare(config, { timeoutMs: 10_000, stopGraceMs: 5_000 }, new AbortController().signal);
    expect(prepared.ok).toBe(true);
    if (!prepared.ok) return;

    const events: string[] = [];
    const outcome = await prepared.data.execute(input, new AbortController().signal, (event) => events.push(event.type));

    expect(outcome.error).toBeNull();
    expect(outcome.text).toContain('你好');
    expect(outcome.stopReason).toBe('stop');
    expect(outcome.stopped).toBe(true);
    expect(events).toContain('request_dispatched');
    expect(events).toContain('native_terminal');
    expect(fetch).toHaveBeenCalledOnce();
  });

  it('registers the environment-defined endpoint with Pi and keeps its API key out of the persisted snapshot', async () => {
    const envConfig: ProviderConfig = {
      ...config,
      modelRef: { provider: 'flowmate-env', model: 'invoice-model' },
      connection: { baseUrl: 'https://llm.example.com/v1', api: 'openai-completions' },
    };
    const fetch = vi.fn<FetchLike>(async () => new Response([
      'data: {"id":"env-1","choices":[{"index":0,"delta":{"content":"已提取"},"finish_reason":null}]}\n\n',
      'data: {"id":"env-1","choices":[{"index":0,"delta":{},"finish_reason":"stop"}],"usage":{"prompt_tokens":3,"completion_tokens":1,"total_tokens":4}}\n\n',
      'data: [DONE]\n\n',
    ].join(''), { status: 200, headers: { 'content-type': 'text/event-stream' } }));
    const adapter = new PiProviderAdapter({ runtimeApiKey: 'ENV_TEST_KEY', fetch });

    const prepared = await adapter.prepare(envConfig, { timeoutMs: 10_000, stopGraceMs: 5_000 }, new AbortController().signal);

    expect(prepared.ok).toBe(true);
    if (!prepared.ok) return;
    const outcome = await prepared.data.execute(input, new AbortController().signal, () => undefined);
    const [requestInput, requestInit] = fetch.mock.calls[0] ?? [];
    const request = requestInput === undefined ? null : new Request(requestInput, requestInit);
    expect(outcome.text).toContain('已提取');
    expect(prepared.data.snapshot.endpoint).toBe('https://llm.example.com/v1');
    expect(JSON.stringify(prepared.data.snapshot)).not.toContain('ENV_TEST_KEY');
    expect(request?.url).toBe('https://llm.example.com/v1/chat/completions');
    if (request) {
      expect(request.headers.get('authorization')).toBe('Bearer ENV_TEST_KEY');
      expect(await request.text()).toContain('"model":"invoice-model"');
    }
  });

  it('[F-output-limit] fails closed when the streamed response exceeds the output limit', async () => {
    const credentials = new InMemoryCredentialStore();
    await credentials.modify('deepseek', async () => ({ type: 'api_key', key: 'FLOWMATE_SYNTHETIC_KEY' }));
    const oversized = 'x'.repeat(256 * 1024 + 1);
    const fetch = vi.fn<FetchLike>(async () => new Response(
      `data: ${JSON.stringify({ id: 'fixture-limit', choices: [{ index: 0, delta: { content: oversized }, finish_reason: null }] })}\n\n`,
      { status: 200, headers: { 'content-type': 'text/event-stream' } },
    ));
    const adapter = new PiProviderAdapter({ credentials, fetch });
    const prepared = await adapter.prepare(config, { timeoutMs: 10_000, stopGraceMs: 5_000 }, new AbortController().signal);
    expect(prepared.ok).toBe(true);
    if (!prepared.ok) return;

    const outcome = await prepared.data.execute(input, new AbortController().signal, () => undefined);

    expect(outcome.error?.code).toBe('provider_output_limit');
    expect(outcome.partial).toBe(true);
    expect(outcome.stopped).toBe(false);
    expect(outcome.usage.source).toBe('unknown');
  });

  it('[F-network-failure] classifies a transport failure before any response as a network error', async () => {
    const credentials = new InMemoryCredentialStore();
    await credentials.modify('deepseek', async () => ({ type: 'api_key', key: 'FLOWMATE_SYNTHETIC_KEY' }));
    const fetch = vi.fn<FetchLike>(async () => { throw new Error('synthetic socket reset'); });
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
    const fetch = vi.fn<FetchLike>(async () => new Response('unexpected', { status: 200 }));
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
