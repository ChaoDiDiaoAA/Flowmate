import { InMemoryCredentialStore } from '@earendil-works/pi-ai';
import type { PiProviderDependencies } from '@flowmate/runtime-pi';

export type FixtureProfile = 'none' | 'auth' | 'invalid-auth' | 'timeout' | 'cancel' | 'stream-interrupted' | 'rate-limit' | 'usage-unknown';

function json(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
}

function chunk(content: string, finishReason: string | null = null, usage?: Record<string, number>): string {
  return `data: ${JSON.stringify({
    id: 'fixture-response-1',
    object: 'chat.completion.chunk',
    created: 1,
    model: 'deepseek-v4-flash',
    choices: [{ index: 0, delta: content ? { content } : {}, finish_reason: finishReason }],
    ...(usage ? { usage } : {}),
  })}\n\n`;
}

function successResponse(includeUsage = true): Response {
  const encoder = new TextEncoder();
  const body = [
    chunk('fixture response'),
    chunk('', 'stop', includeUsage ? { prompt_tokens: 5, completion_tokens: 2, total_tokens: 7 } : undefined),
    'data: [DONE]\n\n',
  ].join('');
  return new Response(encoder.encode(body), { status: 200, headers: { 'content-type': 'text/event-stream' } });
}

function interruptedResponse(): Response {
  const encoder = new TextEncoder();
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(encoder.encode(chunk('partial fixture')));
      setTimeout(() => controller.error(new Error('fixture stream interrupted')), 10);
    },
  });
  return new Response(stream, { status: 200, headers: { 'content-type': 'text/event-stream' } });
}

function waitForAbort(signal: AbortSignal | null | undefined): Promise<Response> {
  return new Promise((_, reject) => {
    const abort = () => reject(new DOMException('Aborted', 'AbortError'));
    if (signal?.aborted) abort();
    else signal?.addEventListener('abort', abort, { once: true });
  });
}

export async function createFixtureDependencies(
  profile: FixtureProfile | string,
  witness?: (value: Readonly<Record<string, unknown>>) => void | Promise<void>,
): Promise<PiProviderDependencies & { credentials: InMemoryCredentialStore }> {
  const credentials = new InMemoryCredentialStore();
  let attempts = 0;
  const fetch: PiProviderDependencies['fetch'] = async (_input, init) => {
    attempts += 1;
    await witness?.({ type: 'fixture_fetch', profile, attempt: attempts });
    if (profile === 'auth' || profile === 'invalid-auth') return json(401, { error: { message: 'fixture invalid credential' } });
    if (profile === 'timeout' || profile === 'cancel') return waitForAbort(init?.signal);
    if (profile === 'stream-interrupted') return interruptedResponse();
    if (profile === 'rate-limit' && attempts === 1) {
      return new Response(JSON.stringify({ error: { message: 'fixture rate limit' } }), {
        status: 429,
        headers: { 'content-type': 'application/json', 'retry-after': '0' },
      });
    }
    return successResponse(profile !== 'usage-unknown');
  };
  return { credentials, fetch, witness };
}
