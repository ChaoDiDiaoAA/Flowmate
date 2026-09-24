import { describe, expect, it, mock } from 'bun:test';
import { makeApplication, type RuntimeServicePort } from '../../../packages/core/src/application.ts';
import { ok } from '../../../packages/contracts/src/errors.ts';
import type { Application, CloseReport, ProviderRequest, RunSnapshot } from '../../../packages/contracts/src/runtime.ts';

const request = {
  goal: '概述',
  text: '合成文本',
  config: {
    version: 1 as const,
    name: 'test',
    revision: 1,
    modelRef: { provider: 'p', model: 'm' },
    native: { authPath: 'C:\\test\\auth.json', modelsPath: null },
    parameters: { maxRetries: 0, maxRetryDelayMs: 1 },
  },
  timeoutMs: 100,
  stopGraceMs: 100,
} satisfies ProviderRequest;

describe('Application composition', () => {
  it('delegates provider calls, queries, and close without adding product semantics', async () => {
    const outcome = {
      runId: 7,
      status: 'completed' as const,
      text: '完成',
      error: null,
      stopped: true,
      cleanupErrors: [],
    };
    const snapshot = { runId: 7, status: 'completed' } as unknown as RunSnapshot;
    const report: CloseReport = { stopped: true, closed: true, errors: [] };
    const runtime = {
      callProvider: mock(async () => ok(outcome)),
      start: mock(async () => ok({ runId: 7, sessionId: 1 })),
      cancel: mock((runId: number) => ok({ runId, accepted: false })),
      state: mock(() => ({ active: null, blocked: false, error: null })),
      close: mock(async () => report),
    };
    const runs = { get: mock(() => ok(snapshot)) };
    const dispose = mock(async () => report);

    const app: Application = makeApplication(runtime as unknown as RuntimeServicePort, runs, dispose);

    await expect(app.callProvider(request)).resolves.toEqual({ ok: true, data: outcome });
    await expect(app.queryRun(7)).resolves.toEqual({ ok: true, data: snapshot });
    await expect(app.close()).resolves.toEqual({ ok: true, data: report });
    expect(runtime.callProvider).toHaveBeenCalledWith(request, undefined);
    expect(runs.get).toHaveBeenCalledWith(7);
    expect(runtime.close).toHaveBeenCalledTimes(1);
    expect(dispose).toHaveBeenCalledTimes(1);
  });

  it('retries an unconfirmed close without releasing storage early and keeps the first failure visible', async () => {
    let closeAttempts = 0;
    const runtime = {
      callProvider: mock(async () => ok({ runId: 7, status: 'failed' as const, text: '', error: null, stopped: false, cleanupErrors: [] })),
      start: mock(async () => ok({ runId: 7, sessionId: 1 })),
      cancel: mock((runId: number) => ok({ runId, accepted: false })),
      state: mock(() => ({ active: null, blocked: false, error: null })),
      close: mock(async () => {
        closeAttempts += 1;
        return closeAttempts === 1
          ? { stopped: false, closed: false, errors: [{ code: 'stop_unconfirmed', category: 'runtime' as const, message: '未停止。', retryable: true }] }
          : { stopped: true, closed: true, errors: [] };
      }),
    };
    const runs = { get: mock(() => ok({} as RunSnapshot)) };
    const dispose = mock(async () => ({ stopped: true, closed: true, errors: [] }));
    const app = makeApplication(runtime as unknown as RuntimeServicePort, runs, dispose);

    const first = await app.close();
    const second = await app.close();
    const third = await app.close();

    expect(first).toMatchObject({ ok: true, data: { stopped: false, closed: false, errors: [{ code: 'stop_unconfirmed' }] } });
    expect(second).toMatchObject({ ok: true, data: { stopped: true, closed: true, errors: [{ code: 'stop_unconfirmed' }] } });
    expect(third).toEqual(second);
    expect(runtime.close).toHaveBeenCalledTimes(2);
    expect(dispose).toHaveBeenCalledTimes(1);
  });

  it('preserves a resource disposal failure when a later close succeeds', async () => {
    const report = { stopped: true, closed: true, errors: [] } satisfies CloseReport;
    const runtime = {
      callProvider: mock(async () => ok({} as never)),
      start: mock(async () => ok({ runId: 1, sessionId: 1 })),
      cancel: mock((runId: number) => ok({ runId, accepted: false })),
      state: mock(() => ({ active: null, blocked: false, error: null })),
      close: mock(async () => report),
    };
    let disposeAttempts = 0;
    const dispose = mock(async () => {
      disposeAttempts += 1;
      if (disposeAttempts === 1) throw new Error('sensitive filesystem detail');
      return report;
    });
    const app = makeApplication(runtime as unknown as RuntimeServicePort, { get: mock(() => ok({} as RunSnapshot)) }, dispose);

    const first = await app.close();
    const second = await app.close();

    expect(first).toMatchObject({ ok: true, data: { stopped: true, closed: false, errors: [{ code: 'storage_close_failed' }] } });
    expect(second).toMatchObject({ ok: true, data: { stopped: true, closed: true, errors: [{ code: 'storage_close_failed' }] } });
    expect(JSON.stringify([first, second])).not.toContain('sensitive filesystem detail');
    expect(dispose).toHaveBeenCalledTimes(2);
  });
});
