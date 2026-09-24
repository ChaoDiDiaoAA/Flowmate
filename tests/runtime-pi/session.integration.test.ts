import { describe, expect, it, mock } from 'bun:test';
import { PiAgentAdapter } from '../../packages/runtime-pi/src/session.ts';
import type { FetchLike } from '../../packages/runtime-pi/src/provider.ts';
import type { ProviderConfig } from '../../packages/contracts/src/runtime.ts';
import type { AgentExecutionInput } from '../../packages/contracts/src/ports.ts';

function config(model: string, baseUrl = 'https://agent-one.invalid/v1'): ProviderConfig {
  return {
    version: 1,
    name: 'agent-test',
    revision: 1,
    modelRef: { provider: 'flowmate-agent-test', model },
    native: { authPath: 'C:\\flowmate-test\\auth.json', modelsPath: null },
    connection: { baseUrl, api: 'openai-completions' },
    parameters: { maxRetries: 0, maxRetryDelayMs: 0 },
  };
}

function response(model: string, text: string): Response {
  const chunks = [
    { id: 'agent-fixture', choices: [{ index: 0, delta: { content: text }, finish_reason: null }] },
    { id: 'agent-fixture', choices: [{ index: 0, delta: {}, finish_reason: 'stop' }], usage: { prompt_tokens: 10, completion_tokens: 2, total_tokens: 12 } },
  ].map((chunk) => `data: ${JSON.stringify({ ...chunk, model })}\n\n`).join('');
  return new Response(`${chunks}data: [DONE]\n\n`, { status: 200, headers: { 'content-type': 'text/event-stream' } });
}

function executionInput(sessionId: number, runId: number, text: string): AgentExecutionInput {
  return { goal: 'invoice summary', text, messageTimestamp: runId, sessionId, runId };
}

describe('PiAgentAdapter native sessions', () => {
  it('shares a model runtime while isolating session history and preserving it across model changes', async () => {
    const requests: Array<{ url: string; body: { model: string; messages: Array<{ role: string; content: unknown }> } }> = [];
    const modelRequests: Readonly<Record<string, unknown>>[] = [];
    const fetch = mock<FetchLike>(async (input, init) => {
      const request = new Request(input, init);
      const body = await request.json() as { model: string; messages: Array<{ role: string; content: unknown }> };
      requests.push({ url: request.url, body });
      return response(body.model, `answer-${requests.length}`);
    });
    const adapter = new PiAgentAdapter({ cwd: 'C:\\flowmate-test', runtimeApiKey: 'SYNTHETIC_TEST_KEY', fetch });
    const a = adapter.createSession();
    const b = adapter.createSession();
    expect(a.ok && b.ok).toBe(true);
    if (!a.ok || !b.ok) return;
    expect(a.data.nativeSessionId).not.toBe(b.data.nativeSessionId);
    expect(fetch).not.toHaveBeenCalled();

    const run = async (nativeSessionId: string, sessionId: number, runId: number, text: string, selected: ProviderConfig) => {
      const prepared = await adapter.prepare(nativeSessionId, selected, { timeoutMs: 10_000, stopGraceMs: 100 }, new AbortController().signal);
      expect(prepared.ok).toBe(true);
      if (!prepared.ok) return;
      return prepared.data.execute(executionInput(sessionId, runId, text), new AbortController().signal, (event) => {
        if (event.type === 'model_request') modelRequests.push(event.data);
      });
    };

    await run(a.data.nativeSessionId, 1, 1, 'INVOICE_A_FIRST', config('model-a'));
    await run(a.data.nativeSessionId, 1, 2, 'INVOICE_A_FOLLOWUP', config('model-a'));
    await run(b.data.nativeSessionId, 2, 3, 'INVOICE_B_ONLY', config('model-a'));
    await run(a.data.nativeSessionId, 1, 4, 'INVOICE_A_NEW_MODEL', config('model-b', 'https://agent-two.invalid/v1'));

    expect(requests.map(({ body }) => body.messages.filter((message) => message.role !== 'system').length)).toEqual([1, 3, 1, 5]);
    expect(JSON.stringify(requests[1]?.body)).toContain('INVOICE_A_FIRST');
    expect(JSON.stringify(requests[1]?.body)).not.toContain('INVOICE_B_ONLY');
    expect(JSON.stringify(requests[2]?.body)).toContain('INVOICE_B_ONLY');
    expect(JSON.stringify(requests[2]?.body)).not.toContain('INVOICE_A_FIRST');
    expect(JSON.stringify(requests[3]?.body)).toContain('INVOICE_A_FOLLOWUP');
    expect(requests[3]?.body.model).toBe('model-b');
    expect(requests[3]?.url).toBe('https://agent-two.invalid/v1/chat/completions');
    expect(modelRequests.map((request) => request.toolCount)).toEqual([0, 0, 0, 0]);
    expect(fetch).toHaveBeenCalledTimes(4);
    await adapter.close();
  });

  it('aborts an active native prompt and confirms Session cleanup before reuse', async () => {
    let signalRequestStarted!: () => void;
    const requestStarted = new Promise<void>((resolve) => { signalRequestStarted = resolve; });
    const fetch = mock<FetchLike>((input, init) => {
      const request = new Request(input, init);
      signalRequestStarted();
      return new Promise<Response>((_resolve, reject) => {
        const abort = () => reject(request.signal.reason ?? new DOMException('Aborted', 'AbortError'));
        if (request.signal.aborted) abort();
        else request.signal.addEventListener('abort', abort, { once: true });
      });
    });
    const adapter = new PiAgentAdapter({ cwd: 'C:\\flowmate-test', runtimeApiKey: 'SYNTHETIC_TEST_KEY', fetch });
    const created = adapter.createSession();
    expect(created.ok).toBe(true);
    if (!created.ok) return;
    const prepared = await adapter.prepare(created.data.nativeSessionId, config('model-a'), { timeoutMs: 10_000, stopGraceMs: 1_000 }, new AbortController().signal);
    expect(prepared.ok).toBe(true);
    if (!prepared.ok) return;
    const controller = new AbortController();
    const running = prepared.data.execute(executionInput(1, 1, 'cancel this native prompt'), controller.signal, () => undefined);
    await requestStarted;
    controller.abort();
    const outcome = await running;
    expect(outcome.error?.code).toBe('provider_cancelled');
    expect(outcome.stopped).toBe(true);
    expect(outcome.agent.modelCallCount).toBe(1);
    expect(adapter.inspect(created.data.nativeSessionId).availability).toBe('ready');
    await adapter.close();
  });
});
