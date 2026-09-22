import { describe, expect, it, vi } from 'vitest';
import { makeApplication } from '../packages/core/src/application.ts';
import { ok } from '../packages/contracts/src/errors.ts';
import type { Application, CloseReport, ProviderRequest, RunSnapshot } from '../packages/contracts/src/runtime.ts';

const request = {
  goal: '概述',
  text: '合成文本',
  config: {
    version: 1 as const,
    name: 'test',
    revision: 1,
    modelRef: { provider: 'p', model: 'm' },
    native: { authPath: 'C:\\test\\auth.json', modelsPath: null },
    parameters: { maxTokens: 1, maxRetries: 0, maxRetryDelayMs: 1 },
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
      callProvider: vi.fn(async () => ok(outcome)),
      close: vi.fn(async () => report),
    };
    const runs = { get: vi.fn(() => ok(snapshot)) };
    const dispose = vi.fn(async () => report);

    const app: Application = makeApplication(runtime, runs, dispose);

    await expect(app.callProvider(request)).resolves.toEqual({ ok: true, data: outcome });
    await expect(app.queryRun(7)).resolves.toEqual({ ok: true, data: snapshot });
    await expect(app.close()).resolves.toEqual({ ok: true, data: report });
    expect(runtime.callProvider).toHaveBeenCalledWith(request, undefined);
    expect(runs.get).toHaveBeenCalledWith(7);
    expect(runtime.close).toHaveBeenCalledOnce();
    expect(dispose).toHaveBeenCalledOnce();
  });
});
