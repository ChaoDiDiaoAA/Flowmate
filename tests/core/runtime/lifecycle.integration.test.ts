import { openTestDatabase as openDatabase } from '../../support/database.ts';
import { mkdtempSync } from '../../support/resources.ts';

import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'bun:test';
import { PiProviderAdapter } from '../../../packages/runtime-pi/src/provider.ts';
import type { NativeOutcome, PreparedProvider, ProviderPort, SafeConfigSnapshot } from '../../../packages/contracts/src/ports.ts';
import type { RunRepository } from '../../../packages/core/src/storage/repositories.ts';
import type { ProviderConfig, ProviderRequest } from '../../../packages/contracts/src/runtime.ts';
import { RuntimeService } from '../../../packages/core/src/runtime/service.ts';

const config: ProviderConfig = {
  version: 1,
  name: 'fixture',
  revision: 1,
  modelRef: { provider: 'deepseek', model: 'deepseek-v4-flash' },
  native: { authPath: 'C:\\Users\\test\\.pi\\auth.json', modelsPath: null },
  parameters: { maxRetries: 0, maxRetryDelayMs: 2000 },
};

const request: ProviderRequest = {
  goal: '返回一句话',
  text: '合成文本',
  config,
  timeoutMs: 100,
  stopGraceMs: 100,
};

const snapshot: SafeConfigSnapshot = {
  version: 1,
  name: config.name,
  revision: config.revision,
  requestedModel: config.modelRef,
  resolvedModel: config.modelRef,
  api: 'openai-completions',
  endpoint: null,
  sdk: { codingAgent: '0.85.1', ai: '0.85.1' },
  parameters: config.parameters,
  limits: { timeoutMs: 100, stopGraceMs: 100 },
  native: { authSource: 'pi-native', modelsSelection: null },
};

const success: NativeOutcome = {
  text: '完成', partial: false, stopReason: 'stop', responseId: null, responseModel: 'deepseek-v4-flash',
  error: null,
  usage: { version: 1, source: 'unknown', reason: 'fixture', sdkValues: null, attempts: 1, attemptsComplete: true, costSource: null, updatedAt: '2026-09-21T00:00:00.000Z' },
  tokens: { inputTokens: null, outputTokens: null, totalTokens: null, cost: null, usageComplete: false },
  stopped: true, cleanupErrors: [],
};

function paths(root: string) {
  return { root, databaseFile: join(root, 'data', 'trial.sqlite'), logsDir: join(root, 'logs'), artifactsDir: join(root, 'artifacts'), outputsDir: join(root, 'outputs'), runtimeDir: join(root, 'runtime') };
}

class ControlledProvider implements ProviderPort {
  private pending = false;
  public constructor(private readonly behavior: 'success' | 'abort' | 'hang') {}
  public async prepare(): Promise<{ ok: true; data: PreparedProvider }> {
    return {
      ok: true,
      data: {
        snapshot,
        execute: async (_input, signal, observe) => {
          this.pending = true;
          observe({ type: 'request_dispatched', at: new Date().toISOString(), monotonicMs: performance.now(), data: {} });
          try {
            if (this.behavior === 'success') return success;
            if (this.behavior === 'hang') await new Promise<void>(() => undefined);
            await new Promise<void>((resolve) => signal.addEventListener('abort', () => resolve(), { once: true }));
            return { ...success, text: '', partial: true, stopReason: 'aborted', error: { code: 'provider_cancelled', category: 'provider', message: 'Provider 请求已中止。', retryable: false } };
          } finally {
            this.pending = false;
          }
        },
      },
    };
  }
  public async close() {
    return this.pending
      ? { stopped: false, closed: false, errors: [{ code: 'stop_unconfirmed', category: 'runtime' as const, message: 'Provider 请求仍在收口。', retryable: true }] }
      : { stopped: true, closed: true, errors: [] as const };
  }
}

function serviceFor(provider: ProviderPort, runsOverride?: RunRepository) {
  const root = mkdtempSync(join(tmpdir(), 'flowmate-runtime-'));
  const db = openDatabase(paths(root));
  if (!db.ok) throw new Error(db.error.message);
  const service = new RuntimeService({
    runs: runsOverride ?? db.data.runs,
    provider,
    log: { write: () => undefined, close: async () => undefined },
    now: () => '2026-09-21T00:00:00.000Z',
    monotonicNow: () => performance.now(),
  });
  return { db: db.data, service };
}

describe('RuntimeService lifecycle', () => {
  it('[F-cancel-preabort] records a pre-aborted request without dispatching provider work', async () => {
    let prepared = false;
    let executed = false;
    const provider: ProviderPort = {
      async prepare() {
        prepared = true;
        return {
          ok: true as const,
          data: {
            snapshot,
            execute: async () => {
              executed = true;
              return success;
            },
          },
        };
      },
      async close() { return { stopped: true, closed: true, errors: [] as const }; },
    };
    const { db, service } = serviceFor(provider);
    const controller = new AbortController();
    controller.abort();

    const result = await service.callProvider(request, { signal: controller.signal });

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.data.status).toBe('cancelled');
      expect(result.data.error?.code).toBe('provider_cancelled');
      expect(result.data.stopped).toBe(true);
    }
    expect(prepared).toBe(false);
    expect(executed).toBe(false);
    if (result.ok) {
      const queried = db.runs.get(result.data.runId);
      expect(queried.ok).toBe(true);
      if (queried.ok) expect(queried.data.cancelRequestedAt).not.toBeNull();
    }
    db.close();
  });

  it('[F-db-create-failure] does not dispatch provider work when the initial Run insert fails', async () => {
    const root = mkdtempSync(join(tmpdir(), 'flowmate-runtime-create-failure-'));
    const db = openDatabase(paths(root));
    expect(db.ok).toBe(true);
    if (!db.ok) return;
    let prepared = false;
    const runs: RunRepository = {
      ...db.data.runs,
      create: () => ({ ok: false, error: { code: 'storage_write_failed', category: 'storage', message: '模拟创建失败。', retryable: true } }),
    };
    const provider: ProviderPort = {
      async prepare() {
        prepared = true;
        return { ok: true as const, data: { snapshot, execute: async () => success } };
      },
      async close() { return { stopped: true, closed: true, errors: [] as const }; },
    };
    const service = new RuntimeService({
      runs,
      provider,
      log: { write: () => undefined, close: async () => undefined },
      now: () => '2026-09-21T00:00:00.000Z',
      monotonicNow: () => performance.now(),
    });

    const result = await service.callProvider(request);

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe('storage_write_failed');
    expect(prepared).toBe(false);
    db.data.close();
  });

  it('[F-timeout-prepare] applies the total deadline while Provider preparation is still pending', async () => {
    let aborted = false;
    let preparing = true;
    const provider: ProviderPort = {
      async prepare(_config, _limits, signal) {
        signal.addEventListener('abort', () => { aborted = true; }, { once: true });
        return await new Promise<never>(() => undefined);
      },
      async close() { return { stopped: !preparing, closed: !preparing, errors: preparing ? [{ code: 'stop_unconfirmed', category: 'runtime' as const, message: 'Provider 初始化仍在收口。', retryable: true }] : [] }; },
    };
    const { db, service } = serviceFor(provider);

    const result = await service.callProvider({ ...request, timeoutMs: 20, stopGraceMs: 10 });

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.data.status).toBe('failed');
      expect(result.data.error?.code).toBe('provider_timeout');
      expect(result.data.stopped).toBe(false);
    }
    expect(aborted).toBe(true);
    preparing = false;
    expect((await service.close()).closed).toBe(true);
    db.close();
  });

  it('persists a completed provider outcome through the service', async () => {
    const { db, service } = serviceFor(new ControlledProvider('success'));
    const result = await service.callProvider(request);

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.data.status).toBe('completed');
      expect(db.runs.get(result.data.runId).ok).toBe(true);
    }
    db.close();
  });

  it('[F-config-new-run] takes a new configuration snapshot for each new Run', async () => {
    const root = mkdtempSync(join(tmpdir(), 'flowmate-runtime-config-revision-'));
    const db = openDatabase(paths(root));
    expect(db.ok).toBe(true);
    if (!db.ok) return;
    const provider: ProviderPort = {
      async prepare(nextConfig) {
        return {
          ok: true as const,
          data: {
            snapshot: { ...snapshot, name: nextConfig.name, revision: nextConfig.revision, requestedModel: nextConfig.modelRef, resolvedModel: nextConfig.modelRef, parameters: nextConfig.parameters },
            execute: async () => success,
          },
        };
      },
      async close() { return { stopped: true, closed: true, errors: [] as const }; },
    };
    const service = new RuntimeService({
      runs: db.data.runs,
      provider,
      log: { write: () => undefined, close: async () => undefined },
      now: () => '2026-09-21T00:00:00.000Z',
      monotonicNow: () => performance.now(),
    });
    const first = await service.callProvider(request);
    const second = await service.callProvider({
      ...request,
      config: { ...config, name: 'fixture-next', revision: 2, modelRef: { provider: 'deepseek', model: 'next-model' } },
    });
    expect(first.ok).toBe(true);
    expect(second.ok).toBe(true);
    if (first.ok && second.ok) {
      const firstSnapshot = db.data.runs.get(first.data.runId);
      const secondSnapshot = db.data.runs.get(second.data.runId);
      expect(firstSnapshot.ok).toBe(true);
      expect(secondSnapshot.ok).toBe(true);
      if (firstSnapshot.ok && secondSnapshot.ok) {
        expect(firstSnapshot.data.config).toMatchObject({ name: 'fixture', revision: 1, requestedModel: config.modelRef });
        expect(secondSnapshot.data.config).toMatchObject({ name: 'fixture-next', revision: 2, requestedModel: { provider: 'deepseek', model: 'next-model' } });
      }
    }
    db.data.close();
  });

  it('[F-cancel-race] turns an in-flight caller abort into cancelled only after provider stop', async () => {
    const { db, service } = serviceFor(new ControlledProvider('abort'));
    const controller = new AbortController();
    let runId: number | undefined;
    const pending = service.callProvider(request, { signal: controller.signal, onObservation: (event) => {
      if (event.type === 'run_created') runId = event.runId;
    } });
    await new Promise((resolve) => setTimeout(resolve, 10));
    controller.abort();
    const result = await pending;

    expect(runId).toBeDefined();
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.data.status).toBe('cancelled');
    if (runId !== undefined) {
      const queried = db.runs.get(runId);
      expect(queried.ok).toBe(true);
      if (queried.ok) expect(queried.data.cancelRequestedAt).not.toBeNull();
    }
    db.close();
  });

  it('[F-timeout-cancel-order] preserves the first stop intent', async () => {
    const { db, service } = serviceFor(new ControlledProvider('abort'));
    const controller = new AbortController();
    const pending = service.callProvider({ ...request, timeoutMs: 50, stopGraceMs: 100 }, { signal: controller.signal });
    await new Promise((resolve) => setTimeout(resolve, 5));
    controller.abort();
    const result = await pending;

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.data.status).toBe('cancelled');
      expect(result.data.error?.code).toBe('provider_cancelled');
    }
    db.close();
  });

  it('[F-timeout-cancel-order] keeps a deadline terminal when a later cancel arrives', async () => {
    const { db, service } = serviceFor(new ControlledProvider('abort'));
    const controller = new AbortController();
    const result = await service.callProvider({ ...request, timeoutMs: 20, stopGraceMs: 100 }, { signal: controller.signal });
    controller.abort();

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.data.status).toBe('failed');
      expect(result.data.error?.code).toBe('provider_timeout');
      const snapshot = db.runs.get(result.data.runId);
      expect(snapshot.ok).toBe(true);
      if (snapshot.ok) expect(snapshot.data.cancelRequestedAt).toBeNull();
    }
    db.close();
  });

  it('[F-cancel-complete-race] does not record a cancel after completed commit', async () => {
    const { db, service } = serviceFor(new ControlledProvider('success'));
    const controller = new AbortController();
    const result = await service.callProvider(request, { signal: controller.signal });
    controller.abort();

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.data.status).toBe('completed');
      const snapshot = db.runs.get(result.data.runId);
      expect(snapshot.ok).toBe(true);
      if (snapshot.ok) expect(snapshot.data.cancelRequestedAt).toBeNull();
    }
    db.close();
  });

  it('rejects a second call while the first provider run is active', async () => {
    const { db, service } = serviceFor(new ControlledProvider('abort'));
    const controller = new AbortController();
    const pending = service.callProvider(request, { signal: controller.signal });
    await new Promise((resolve) => setTimeout(resolve, 10));
    const second = await service.callProvider(request);
    expect(second.ok).toBe(false);
    if (!second.ok) expect(second.error.code).toBe('runtime_busy');
    controller.abort();
    await pending;
    db.close();
  });

  it('maps a deadline stop to failed/provider_timeout and preserves the stop observation', async () => {
    const { db, service } = serviceFor(new ControlledProvider('abort'));
    const observations: string[] = [];
    const result = await service.callProvider({ ...request, timeoutMs: 20 }, { onObservation: (event) => observations.push(event.type) });

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.data.status).toBe('failed');
      expect(result.data.error?.code).toBe('provider_timeout');
    }
    expect(observations).toContain('stop_requested');
    expect(observations).toContain('stopped');
    db.close();
  });

  it('[F-stop-unconfirmed] does not reuse the instance when the provider ignores the stop signal', async () => {
    const { db, service } = serviceFor(new ControlledProvider('hang'));
    const result = await service.callProvider({ ...request, timeoutMs: 20, stopGraceMs: 20 });

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.data.status).toBe('failed');
      expect(result.data.stopped).toBe(false);
      expect(result.data.error?.code).toBe('provider_timeout');
    }
    const retry = await service.callProvider(request);
    expect(retry.ok).toBe(false);
    if (!retry.ok) expect(retry.error.code).toBe('runtime_unusable');
    const close = await service.close();
    expect(close.closed).toBe(false);
    db.close();
  });

  it('[F-cancel-unconfirmed] persists an unconfirmed user cancellation as failed with no stopped timestamp', async () => {
    const { db, service } = serviceFor(new ControlledProvider('hang'));
    const controller = new AbortController();
    const pending = service.callProvider({ ...request, timeoutMs: 10_000, stopGraceMs: 20 }, { signal: controller.signal });
    await new Promise((resolve) => setTimeout(resolve, 10));
    controller.abort();
    const result = await pending;

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.data.status).toBe('failed');
      expect(result.data.stopped).toBe(false);
      expect(result.data.error?.code).toBe('provider_cancelled');
      const queried = db.runs.get(result.data.runId);
      expect(queried.ok).toBe(true);
      if (queried.ok) {
        expect(queried.data.status).toBe('failed');
        expect(queried.data.cancelRequestedAt).not.toBeNull();
        expect(queried.data.stoppedAt).toBeNull();
        expect(queried.data.cleanup).toMatchObject({ stopped: false, errors: [{ code: 'stop_unconfirmed' }] });
      }
    }
    expect((await service.callProvider(request)).ok).toBe(false);
    db.close();
  });

  it('[F-db-finish-failure] blocks reuse when the terminal database write fails', async () => {
    const root = mkdtempSync(join(tmpdir(), 'flowmate-runtime-finish-failure-'));
    const db = openDatabase(paths(root));
    expect(db.ok).toBe(true);
    if (!db.ok) return;
    let finishCalls = 0;
    const runs: RunRepository = {
      ...db.data.runs,
      finish: (runId, terminal) => {
        finishCalls += 1;
        return { ok: false, error: { code: 'storage_write_failed', category: 'storage', message: '模拟终态写失败。', retryable: true, runId } };
      },
    };
    const service = new RuntimeService({
      runs,
      provider: new ControlledProvider('success'),
      log: { write: () => undefined, close: async () => undefined },
      now: () => '2026-09-21T00:00:00.000Z',
      monotonicNow: () => performance.now(),
    });

    const result = await service.callProvider(request);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe('storage_write_failed');
    expect(finishCalls).toBe(1);
    const retry = await service.callProvider(request);
    expect(retry.ok).toBe(false);
    if (!retry.ok) expect(retry.error.code).toBe('runtime_unusable');
    expect((await service.close()).closed).toBe(true);
    db.data.close();
  });

  it('[F-cancel-record-failure] still aborts the provider when recording cancel intent fails', async () => {
    const root = mkdtempSync(join(tmpdir(), 'flowmate-runtime-cancel-record-failure-'));
    const db = openDatabase(paths(root));
    expect(db.ok).toBe(true);
    if (!db.ok) return;
    const runs: RunRepository = {
      ...db.data.runs,
      recordCancel: (runId) => ({ ok: false, error: { code: 'storage_write_failed', category: 'storage', message: '模拟取消记录失败。', retryable: true, runId } }),
    };
    const service = new RuntimeService({
      runs,
      provider: new ControlledProvider('abort'),
      log: { write: () => undefined, close: async () => undefined },
      now: () => '2026-09-21T00:00:00.000Z',
      monotonicNow: () => performance.now(),
    });
    const controller = new AbortController();
    const pending = service.callProvider(request, { signal: controller.signal });
    await new Promise((resolve) => setTimeout(resolve, 10));
    controller.abort();
    const result = await pending;

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe('storage_write_failed');
    const retry = await service.callProvider(request);
    expect(retry.ok).toBe(false);
    if (!retry.ok) expect(retry.error.code).toBe('runtime_unusable');
    db.data.close();
  });

  it('[F-late-result] does not allow a late provider result to revive an unconfirmed stopped Run', async () => {
    const root = mkdtempSync(join(tmpdir(), 'flowmate-runtime-late-result-'));
    const db = openDatabase(paths(root));
    expect(db.ok).toBe(true);
    if (!db.ok) return;
    let release!: () => void;
    let pendingWork = true;
    const lateOutcome: NativeOutcome = {
      ...success,
      usage: {
        ...success.usage,
        source: 'sdk',
        reason: null,
        sdkValues: { input: 3, output: 2, cacheRead: 0, cacheWrite: 0, totalTokens: 5, costInput: null, costOutput: null, costCacheRead: null, costCacheWrite: null, costTotal: null },
        attempts: 1,
        attemptsComplete: true,
      },
      tokens: { inputTokens: 3, outputTokens: 2, totalTokens: 5, cost: null, usageComplete: true },
    };
    const provider: ProviderPort = {
      async prepare() {
        return {
          ok: true as const,
          data: {
            snapshot,
            execute: async () => {
              try {
                await new Promise<void>((resolve) => { release = resolve; });
                return lateOutcome;
              } finally {
                pendingWork = false;
              }
            },
          },
        };
      },
      async close() { return { stopped: !pendingWork, closed: !pendingWork, errors: pendingWork ? [{ code: 'stop_unconfirmed', category: 'runtime' as const, message: 'Provider 请求仍在收口。', retryable: true }] : [] }; },
    };
    const service = new RuntimeService({
      runs: db.data.runs,
      provider,
      log: { write: () => undefined, close: async () => undefined },
      now: () => '2026-09-21T00:00:00.000Z',
      monotonicNow: () => performance.now(),
    });
    const result = await service.callProvider({ ...request, timeoutMs: 20, stopGraceMs: 10 });
    expect(result.ok).toBe(true);
    let runId: number | undefined;
    if (result.ok) {
      runId = result.data.runId;
      expect(result.data.status).toBe('failed');
      expect(result.data.stopped).toBe(false);
      expect(result.data.error?.code).toBe('provider_timeout');
    }
    const firstClose = await service.close();
    expect(firstClose.closed).toBe(false);
    release();
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(runId).toBeDefined();
    if (runId !== undefined) {
      const queried = db.data.runs.get(runId);
      expect(queried.ok).toBe(true);
      if (queried.ok) {
        expect(queried.data.status).toBe('failed');
        expect(queried.data.error?.code).toBe('provider_timeout');
        expect(queried.data.output).toBeNull();
        expect(queried.data.tokens).toMatchObject({ inputTokens: 3, outputTokens: 2, totalTokens: 5 });
        expect(queried.data.usage).toMatchObject({ source: 'sdk', attempts: 1 });
      }
    }
    const finalClose = await service.close();
    expect(finalClose).toMatchObject({ stopped: true, closed: true, errors: [{ code: 'stop_unconfirmed' }] });
    db.data.close();
  });
});
