import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ok } from '@flowmate/contracts';
import type { Application, ProviderOutcome, ProviderRequest, Result } from '@flowmate/contracts';
import { serve, type ResponseFrame } from '../agent-eval/src/adapters/flowmate.ts';
import { expect, test } from 'bun:test';

function frame(requestId: number, command: string, payload: Record<string, unknown>): string {
  return JSON.stringify({ protocol: 'flowmate-eval/v1', executionId: 'exec-1', trialId: 'trial-1', requestId, command, payload });
}

function fakeApplication(): Application {
  return {
    callProvider: async (_request: ProviderRequest, control = {}): Promise<Result<ProviderOutcome>> => {
      const runId = 7;
      control.onObservation?.({ runId, sequence: 1, at: new Date().toISOString(), monotonicMs: performance.now(), type: 'run_created', data: { status: 'created' } });
      return await new Promise((resolve) => {
        control.signal?.addEventListener('abort', () => {
          control.onObservation?.({ runId, sequence: 2, at: new Date().toISOString(), monotonicMs: performance.now(), type: 'stopped', data: { stopped: true, reason: 'user', cleanupErrors: [] } });
          resolve(ok({ runId, status: 'cancelled', text: '', error: { version: 1, code: 'provider_cancelled', category: 'provider', message: 'cancelled', retryable: false, runId }, stopped: true, cleanupErrors: [] }));
        }, { once: true });
      });
    },
    async queryRun() { return { ok: false, error: { version: 1, code: 'run_not_found', category: 'input', message: 'not found', retryable: false, runId: 7 }, runId: 7 }; },
    async close() { return ok({ stopped: true, closed: true, errors: [] }); },
  };
}

async function* inputLines(): AsyncIterable<string> {
  const root = mkdtempSync(join(tmpdir(), 'flowmate-adapter-'));
  writeFileSync(join(root, '.flowmate-trial-owner.json'), JSON.stringify({ version: 1, executionId: 'exec-1', trialId: 'trial-1', root }));
  yield frame(1, 'start', {
    paths: { root, databaseFile: join(root, 'data', 'trial-1.sqlite'), logsDir: join(root, 'logs'), artifactsDir: join(root, 'artifacts'), outputsDir: join(root, 'outputs'), runtimeDir: join(root, 'runtime') },
    productConfig: { version: 1, name: 'fixture', revision: 1, modelRef: { provider: 'deepseek', model: 'deepseek-v4-flash' }, native: { authPath: join(root, 'auth.json'), modelsPath: null }, parameters: { maxTokens: 8, maxRetries: 0, maxRetryDelayMs: 10 } },
    mode: 'fixture', faultProfile: 'cancel', controlVersion: 1,
  });
  yield frame(2, 'call_provider', { goal: 'hello', text: '', timeoutMs: 60_000, stopGraceMs: 100 });
  await new Promise((resolve) => setTimeout(resolve, 5));
  yield frame(3, 'cancel', { targetRequestId: 2, runId: 7 });
  await new Promise((resolve) => setTimeout(resolve, 5));
  yield frame(4, 'close', {});
}

test('adapter keeps cancel non-blocking and preserves stopped/result frames', async () => {
  const output: ResponseFrame[] = [];
  await serve(inputLines(), (value) => { output.push(value); }, {
    createApp: async () => ok(fakeApplication()),
  });

  expect(output.some((item) => item.type === 'ready')).toBe(true);
  expect(output.some((item) => item.type === 'cancel_ack' && item.data.accepted === true)).toBe(true);
  expect(output.some((item) => item.type === 'stopped' && item.data.stopped === true)).toBe(true);
  expect(output.some((item) => item.type === 'result' && (item.data.outcome as { data?: ProviderOutcome }).data?.status === 'cancelled')).toBe(true);
  expect(output.some((item) => item.type === 'closed')).toBe(true);
});

test('adapter rejects an owner marker mismatch before creating the Application', async () => {
  const root = mkdtempSync(join(tmpdir(), 'flowmate-adapter-owner-'));
  writeFileSync(join(root, '.flowmate-trial-owner.json'), JSON.stringify({ version: 1, executionId: 'other', trialId: 'trial-1', root }));
  const output: ResponseFrame[] = [];
  let createCalls = 0;
  async function* lines(): AsyncIterable<string> {
    yield frame(1, 'start', {
      paths: { root, databaseFile: join(root, 'data', 'trial-1.sqlite'), logsDir: join(root, 'logs'), artifactsDir: join(root, 'artifacts'), outputsDir: join(root, 'outputs'), runtimeDir: join(root, 'runtime') },
      productConfig: { version: 1, name: 'fixture', revision: 1, modelRef: { provider: 'deepseek', model: 'deepseek-v4-flash' }, native: { authPath: join(root, 'auth.json'), modelsPath: null }, parameters: { maxTokens: 8, maxRetries: 0, maxRetryDelayMs: 10 } },
      mode: 'fixture', faultProfile: 'none', controlVersion: 1,
    });
  }

  await serve(lines(), (value) => { output.push(value); }, {
    createApp: async () => {
      createCalls += 1;
      return ok(fakeApplication());
    },
  });

  expect(createCalls).toBe(0);
  expect(output.some((item) => item.type === 'error' && item.data.code === 'start_invalid')).toBe(true);
});

test('adapter rejects a supplied runId before run_created is observed', async () => {
  const root = mkdtempSync(join(tmpdir(), 'flowmate-adapter-run-mismatch-'));
  writeFileSync(join(root, '.flowmate-trial-owner.json'), JSON.stringify({ version: 1, executionId: 'exec-1', trialId: 'trial-1', root }));
  const output: ResponseFrame[] = [];
  async function* lines(): AsyncIterable<string> {
    yield frame(1, 'start', {
      paths: { root, databaseFile: join(root, 'data', 'trial-1.sqlite'), logsDir: join(root, 'logs'), artifactsDir: join(root, 'artifacts'), outputsDir: join(root, 'outputs'), runtimeDir: join(root, 'runtime') },
      productConfig: { version: 1, name: 'fixture', revision: 1, modelRef: { provider: 'deepseek', model: 'deepseek-v4-flash' }, native: { authPath: join(root, 'auth.json'), modelsPath: null }, parameters: { maxTokens: 8, maxRetries: 0, maxRetryDelayMs: 10 } },
      mode: 'fixture', faultProfile: 'cancel', controlVersion: 1,
    });
    yield frame(2, 'call_provider', { goal: 'hello', text: '', timeoutMs: 60_000, stopGraceMs: 100 });
    yield frame(3, 'cancel', { targetRequestId: 2, runId: 999 });
    await new Promise((resolve) => setTimeout(resolve, 20));
    yield frame(4, 'close', {});
  }

  const delayedApp: Application = {
    callProvider: async (_request, control = {}): Promise<Result<ProviderOutcome>> => {
      await new Promise((resolve) => setTimeout(resolve, 50));
      control.onObservation?.({ runId: 7, sequence: 1, at: new Date().toISOString(), monotonicMs: performance.now(), type: 'run_created', data: { status: 'created' } });
      return new Promise(() => undefined);
    },
    async queryRun() { return { ok: false, error: { version: 1, code: 'run_not_found', category: 'input', message: 'not found', retryable: false, runId: 7 }, runId: 7 }; },
    async close() { return ok({ stopped: true, closed: true, errors: [] }); },
  };
  await serve(lines(), (value) => { output.push(value); }, { createApp: async () => ok(delayedApp) });

  expect(output.some((item) => item.type === 'error' && item.data.code === 'cancel_run_mismatch')).toBe(true);
  expect(output.some((item) => item.type === 'cancel_ack' && item.data.accepted === true)).toBe(false);
});

test('adapter treats stopped as terminal before the result envelope arrives', async () => {
  const root = mkdtempSync(join(tmpdir(), 'flowmate-adapter-stopped-race-'));
  writeFileSync(join(root, '.flowmate-trial-owner.json'), JSON.stringify({ version: 1, executionId: 'exec-1', trialId: 'trial-1', root }));
  const output: ResponseFrame[] = [];
  async function* lines(): AsyncIterable<string> {
    yield frame(1, 'start', {
      paths: { root, databaseFile: join(root, 'data', 'trial-1.sqlite'), logsDir: join(root, 'logs'), artifactsDir: join(root, 'artifacts'), outputsDir: join(root, 'outputs'), runtimeDir: join(root, 'runtime') },
      productConfig: { version: 1, name: 'fixture', revision: 1, modelRef: { provider: 'deepseek', model: 'deepseek-v4-flash' }, native: { authPath: join(root, 'auth.json'), modelsPath: null }, parameters: { maxTokens: 8, maxRetries: 0, maxRetryDelayMs: 10 } },
      mode: 'fixture', faultProfile: 'cancel', controlVersion: 1,
    });
    yield frame(2, 'call_provider', { goal: 'hello', text: '', timeoutMs: 60_000, stopGraceMs: 100 });
    await new Promise((resolve) => setTimeout(resolve, 5));
    yield frame(3, 'cancel', { targetRequestId: 2 });
    await new Promise((resolve) => setTimeout(resolve, 40));
    yield frame(4, 'close', {});
  }
  const terminalThenResult: Application = {
    callProvider: async (_request, control = {}): Promise<Result<ProviderOutcome>> => {
      control.onObservation?.({ runId: 7, sequence: 1, at: new Date().toISOString(), monotonicMs: performance.now(), type: 'run_created', data: { status: 'created' } });
      control.onObservation?.({ runId: 7, sequence: 2, at: new Date().toISOString(), monotonicMs: performance.now(), type: 'stopped', data: { stopped: true, reason: 'user', cleanupErrors: [] } });
      await new Promise((resolve) => setTimeout(resolve, 25));
      return ok({ runId: 7, status: 'cancelled', text: '', error: { version: 1, code: 'provider_cancelled', category: 'provider', message: 'cancelled', retryable: false, runId: 7 }, stopped: true, cleanupErrors: [] });
    },
    async queryRun() { return { ok: false, error: { version: 1, code: 'run_not_found', category: 'input', message: 'not found', retryable: false, runId: 7 }, runId: 7 }; },
    async close() { return ok({ stopped: true, closed: true, errors: [] }); },
  };
  await serve(lines(), (value) => { output.push(value); }, { createApp: async () => ok(terminalThenResult) });

  expect(output.some((item) => item.type === 'stopped' && item.data.stopped === true)).toBe(true);
  expect(output.some((item) => item.type === 'cancel_ack' && item.data.accepted === false && item.data.reason === 'already_terminal')).toBe(true);
});
