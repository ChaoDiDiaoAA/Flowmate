import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, it } from 'bun:test';
import type { ProviderPort, ProviderRequest, SafeConfigSnapshot } from '@flowmate/contracts';
import { RuntimeService } from '../../../packages/core/src/runtime/service.ts';
import { PiProviderAdapter } from '../../../packages/runtime-pi/src/provider.ts';
import { openTestDatabase } from '../../support/database.ts';
import { mkdtempSync } from '../../support/resources.ts';

const request: ProviderRequest = { goal: 'Synthetic test', text: '', timeoutMs: 1_000, stopGraceMs: 100,
  config: { version: 1, name: 'Synthetic', revision: 1, modelRef: { provider: 'synthetic', model: 'synthetic' },
    native: { authPath: join(tmpdir(), 'flowmate-no-user-auth.json'), modelsPath: null },
    connection: { baseUrl: 'https://fixture.invalid/v1', api: 'openai-completions', contextWindow: 64_000, maxTokens: 16_384 },
    parameters: { maxRetries: 0, maxRetryDelayMs: 1 } } };
const snapshot: SafeConfigSnapshot = { version: 1, name: request.config.name, revision: 1,
  requestedModel: request.config.modelRef, resolvedModel: request.config.modelRef,
  api: 'openai-completions', endpoint: null, sdk: { codingAgent: '0.85.1', ai: '0.85.1' },
  parameters: request.config.parameters, limits: { timeoutMs: 1_000, stopGraceMs: 100 },
  native: { authSource: 'pi-native', modelsSelection: null } };

function fixture(provider: ProviderPort, monotonicNow = () => performance.now()) {
  const root = mkdtempSync(join(tmpdir(), 'flowmate-provider-exception-'));
  const database = openTestDatabase({ root, databaseFile: join(root, 'data', 'trial.sqlite'),
    logsDir: join(root, 'logs'), artifactsDir: join(root, 'artifacts'),
    outputsDir: join(root, 'outputs'), runtimeDir: join(root, 'runtime') });
  if (!database.ok) throw new Error(database.error.code);
  const service = new RuntimeService({ memory: database.data.memory, runs: database.data.runs, provider,
    log: { write() {}, close: async () => undefined }, now: () => new Date().toISOString(), monotonicNow });
  return { service, database: database.data };
}

it.each(['sync', 'async', 'after-cancel'] as const)('saves and blocks a Provider %s exception without exposing its message', async (failure) => {
  let entered!: () => void;
  const executing = new Promise<void>((resolve) => { entered = resolve; });
  let internalSignal!: AbortSignal;
  const provider: ProviderPort = {
    async prepare() {
      return { ok: true, data: { snapshot, execute(_input, signal) {
        internalSignal = signal;
        entered();
        const error = new Error('SYNTHETIC_PRIVATE_EXCEPTION');
        if (failure === 'sync') throw error;
        if (failure === 'async') return Promise.reject(error);
        return new Promise((_resolve, reject) => signal.addEventListener('abort', () => reject(error), { once: true }));
      } } };
    },
    async close() { return { stopped: true, closed: true, errors: [] }; },
  };
  const { service, database } = fixture(provider);
  const controller = new AbortController();
  let runId!: number;
  const pending = service.callProvider(request, { signal: controller.signal,
    onObservation(event) { if (event.type === 'run_created') runId = event.runId; } });
  try {
    await executing;
    if (failure === 'after-cancel') controller.abort();
    const result = await pending.catch((error: unknown) => ({ rejected: String(error) }));
    const code = failure === 'after-cancel' ? 'provider_cancelled' : 'provider_runtime_error';
    expect(result).toMatchObject({ ok: true, data: { status: 'failed', stopped: false,
      error: { code }, cleanupErrors: [{ code: 'stop_unconfirmed' }] } });
    expect(internalSignal.aborted).toBe(true);
    expect(JSON.stringify(result)).not.toContain('SYNTHETIC_PRIVATE_EXCEPTION');
    const saved = database.runs.get(runId);
    expect(saved).toMatchObject({ ok: true, data: { status: 'failed', stoppedAt: null,
      error: { code }, cleanup: { stopped: false, lateObservationRequired: true, errors: [{ code: 'stop_unconfirmed' }] } } });
    if (saved.ok) {
      expect(saved.data.endedAt).not.toBeNull();
      if (failure === 'after-cancel') expect(saved.data.cancelRequestedAt).not.toBeNull();
    }
    expect(service.state().blocked).toBe(true);
    expect(await service.callProvider(request)).toMatchObject({ ok: false, error: { code: 'runtime_unusable' } });
  } finally {
    await service.close();
    database.close();
  }
});

it.each(['auth', 'length', 'output-limit'] as const)('preserves a real Pi %s failure before cancellation from its terminal callback', async (failure) => {
  const controller = new AbortController();
  const provider = new PiProviderAdapter({ runtimeApiKey: 'SYNTHETIC_ONLY', fetch: async (_input, init) => {
    if (failure === 'auth') return new Response('{"error":{"message":"SYNTHETIC_PRIVATE_EXCEPTION"}}', { status: 401 });
    const content = failure === 'output-limit' ? 'x'.repeat(262_145) : 'partial';
    const chunk = `data: ${JSON.stringify({ choices: [{ index: 0, delta: { content }, finish_reason: failure === 'length' ? 'length' : null }] })}\n\n`;
    if (failure === 'length') return new Response(`${chunk}data: [DONE]\n\n`, { headers: { 'content-type': 'text/event-stream' } });
    return new Response(new ReadableStream<Uint8Array>({ start(bodyController) {
      bodyController.enqueue(new TextEncoder().encode(chunk));
      init?.signal?.addEventListener('abort', () => { bodyController.close(); controller.abort(); }, { once: true });
    } }), { headers: { 'content-type': 'text/event-stream' } });
  } });
  const { service, database } = fixture(provider);
  let terminalFacts: Readonly<Record<string, unknown>> | undefined;
  const codes = { auth: 'provider_auth_failed', length: 'provider_incomplete_response', 'output-limit': 'provider_output_limit' };
  try {
    const result = await service.callProvider(request, { signal: controller.signal, onObservation(event) {
      if (event.type === 'native_terminal') { terminalFacts = event.data; controller.abort(); }
    } });
    expect(result).toMatchObject({ ok: true, data: { status: 'failed', error: { code: codes[failure] } } });
    if (!result.ok) throw new Error(result.error.code);
    const saved = database.runs.get(result.data.runId);
    expect(saved).toMatchObject({ ok: true, data: { status: 'failed', error: { code: codes[failure] }, cleanup: { stopReason: 'user' } } });
    if (saved.ok) expect(saved.data.cancelRequestedAt).not.toBeNull();
    expect(JSON.stringify(result)).not.toContain('SYNTHETIC_PRIVATE_EXCEPTION');
    expect(terminalFacts?.failed).toBe(true);
    expect(Number.isFinite(terminalFacts?.failureMonotonicMs)).toBe(true);
  } finally {
    await service.close();
    database.close();
  }
});

it.each(['cancel', 'timeout'] as const)('keeps a prior %s as the main cause when Pi subsequently receives an error', async (reason) => {
  const controller = new AbortController();
  const provider = new PiProviderAdapter({ runtimeApiKey: 'SYNTHETIC_ONLY', fetch: async (_input, init) => {
    if (!init?.signal?.aborted) await new Promise<void>((resolve) => init?.signal?.addEventListener('abort', () => resolve(), { once: true }));
    return new Response('{"error":{"message":"SYNTHETIC_PRIVATE_EXCEPTION"}}', { status: 401 });
  } });
  const { service, database } = fixture(provider);
  try {
    const result = await service.callProvider({ ...request, timeoutMs: 100 }, { signal: controller.signal, onObservation(event) {
      if (reason === 'cancel' && event.type === 'request_dispatched') controller.abort();
    } });
    expect(result).toMatchObject({ ok: true, data: { error: { code: reason === 'cancel' ? 'provider_cancelled' : 'provider_timeout' } } });
    if (!result.ok) throw new Error(result.error.code);
    expect(database.runs.get(result.data.runId)).toMatchObject({ ok: true, data: {
      status: reason === 'cancel' ? 'cancelled' : 'failed', error: { code: reason === 'cancel' ? 'provider_cancelled' : 'provider_timeout' } } });
  } finally {
    await service.close();
    database.close();
  }
});

it('does not dispatch after the start transaction exhausts the total deadline', async () => {
  let elapsed = 0;
  let executed = false;
  const provider: ProviderPort = {
    async prepare() { return { ok: true, data: { snapshot, execute() { executed = true; throw new Error('Unexpected dispatch'); } } }; },
    async close() { return { stopped: true, closed: true, errors: [] }; },
  };
  const { service, database } = fixture(provider, () => elapsed);
  const start = database.runs.start;
  database.runs.start = (...args) => { const saved = start(...args); elapsed = 2_000; return saved; };
  try {
    const result = await service.callProvider(request);
    expect(executed).toBe(false);
    expect(result).toMatchObject({ ok: true, data: { status: 'failed', stopped: true, error: { code: 'provider_timeout' } } });
  } finally {
    await service.close();
    database.close();
  }
});

it('does not defer Provider dispatch past a cancellation queued by the start transaction', async () => {
  const controller = new AbortController();
  let abortedAtDispatch: boolean | undefined;
  const provider: ProviderPort = {
    async prepare() { return { ok: true, data: { snapshot, execute(_input, signal) {
      abortedAtDispatch = signal.aborted;
      throw new Error('Synthetic execution exception');
    } } }; },
    async close() { return { stopped: true, closed: true, errors: [] }; },
  };
  const { service, database } = fixture(provider);
  const start = database.runs.start;
  database.runs.start = (...args) => {
    const saved = start(...args);
    queueMicrotask(() => controller.abort());
    return saved;
  };
  try {
    await service.callProvider(request, { signal: controller.signal });
    expect(abortedAtDispatch).toBe(false);
  } finally {
    await service.close();
    database.close();
  }
});
