import { openTestDatabase as openDatabase } from '../../support/database.ts';
import { mkdtempSync } from '../../support/resources.ts';
import { mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Database } from 'bun:sqlite';
import { describe, expect, it } from 'bun:test';
import type { NewProviderRun, TerminalWrite } from '../../../packages/core/src/storage/repositories.ts';

function makePaths(root: string) {
  return {
    root,
    databaseFile: join(root, 'data', 'trial-1.sqlite'),
    logsDir: join(root, 'logs'),
    artifactsDir: join(root, 'artifacts'),
    outputsDir: join(root, 'outputs'),
    runtimeDir: join(root, 'runtime'),
  };
}

const config = {
  version: 1 as const,
  name: 'fixture',
  revision: 1,
  requestedModel: { provider: 'deepseek', model: 'deepseek-v4-flash' },
  resolvedModel: { provider: 'deepseek', model: 'deepseek-v4-flash' },
  api: 'openai-completions',
  endpoint: null,
  sdk: { codingAgent: '0.85.1', ai: '0.85.1' },
  parameters: { maxRetries: 0, maxRetryDelayMs: 2000 },
  limits: { timeoutMs: 60_000, stopGraceMs: 5_000 },
  native: { authSource: 'pi-native' as const, modelsSelection: null },
};

const usage = {
  version: 1 as const,
  source: 'unknown' as const,
  reason: 'request-not-finished',
  sdkValues: null,
  attempts: null,
  attemptsComplete: false,
  costSource: null,
  updatedAt: '2026-09-21T00:00:00.000Z',
};

const cleanup = {
  version: 1 as const,
  stopped: false,
  stopReason: null,
  errors: [],
  lateObservationRequired: false,
};

const input = {
  version: 1 as const,
  goal: '概述',
  text: '合成发票',
  messageTimestamp: 1789948800000,
};

describe('P1 SQLite storage', () => {
  it('persists a provider run and projects the terminal fact through query', () => {
    const root = mkdtempSync(join(tmpdir(), 'flowmate-storage-'));
    const opened = openDatabase(makePaths(root));
    expect(opened.ok).toBe(true);
    if (!opened.ok) return;

    const run: NewProviderRun = { goal: input.goal, input, config, usage, cleanup, createdAt: input.messageTimestamp ? '2026-09-21T00:00:00.000Z' : '' };
    const created = opened.data.runs.create(run);
    expect(created.ok).toBe(true);
    if (!created.ok) return;
    const runId = created.data;

    expect(opened.data.runs.start(runId, config, '2026-09-21T00:00:00.010Z').ok).toBe(true);
    const terminal: TerminalWrite = {
      status: 'completed',
      output: { version: 1, text: '完成', partial: false, stopReason: 'stop', responseId: null, responseModel: 'deepseek-v4-flash' },
      error: null,
      usage: { ...usage, source: 'sdk', reason: null, attempts: 1, attemptsComplete: true },
      tokens: { inputTokens: 10, outputTokens: 4, totalTokens: 14, cost: '0.001', usageComplete: true },
      cleanup: { ...cleanup, stopped: true, stopReason: 'native-stop' },
      endedAt: '2026-09-21T00:00:00.020Z',
      stoppedAt: '2026-09-21T00:00:00.019Z',
      durationMs: 10,
    };
    expect(opened.data.runs.finish(runId, terminal)).toEqual({ ok: true, data: true });

    const queried = opened.data.runs.get(runId);
    expect(queried.ok).toBe(true);
    if (queried.ok) {
      expect(queried.data).toMatchObject({ kind: 'provider', sessionId: null, scope: null });
      expect(queried.data.status).toBe('completed');
      expect(queried.data.output).toMatchObject({ text: '完成', partial: false });
      expect(queried.data.tokens).toEqual({ inputTokens: 10, outputTokens: 4, totalTokens: 14, cost: '0.001', usageComplete: true });
      expect(queried.data.durationMs).toBe(10);
    }
    expect(opened.data.runs.supplementUsage(runId, {
      ...usage,
      source: 'unknown',
      reason: 'late-unknown',
      sdkValues: null,
      attempts: null,
      attemptsComplete: false,
    }, { inputTokens: null, outputTokens: null, totalTokens: null, cost: null, usageComplete: false })).toEqual({ ok: true, data: true });
    const afterUnknown = opened.data.runs.get(runId);
    expect(afterUnknown.ok).toBe(true);
    if (afterUnknown.ok) {
      expect(afterUnknown.data.usage.source).toBe('sdk');
      expect(afterUnknown.data.tokens).toEqual({ inputTokens: 10, outputTokens: 4, totalTokens: 14, cost: '0.001', usageComplete: true });
    }
    expect(opened.data.runs.finish(runId, terminal)).toEqual({ ok: true, data: false });
    opened.data.close();
  });

  it('[F-single-owner] rejects a second active provider run and keeps a cancelled terminal immutable', () => {
    const root = mkdtempSync(join(tmpdir(), 'flowmate-storage-'));
    const opened = openDatabase(makePaths(root));
    expect(opened.ok).toBe(true);
    if (!opened.ok) return;

    const first = opened.data.runs.create({ goal: input.goal, input, config, usage, cleanup, createdAt: '2026-09-21T00:00:00.000Z' });
    expect(first.ok).toBe(true);
    if (!first.ok) return;
    const second = opened.data.runs.create({ goal: input.goal, input, config, usage, cleanup, createdAt: '2026-09-21T00:00:00.001Z' });
    expect(second.ok).toBe(false);
    if (!second.ok) expect(second.error.code).toBe('runtime_busy');
    expect(opened.data.runs.recordCancel(first.data, '2026-09-21T00:00:00.100Z')).toEqual({ ok: true, data: true });

    expect(opened.data.runs.finish(first.data, {
      status: 'cancelled',
      output: { version: 1, text: '', partial: true, stopReason: 'aborted', responseId: null, responseModel: null },
      error: { version: 1, code: 'provider_cancelled', category: 'provider', message: '请求已取消。', retryable: false, runId: first.data },
      usage,
      tokens: { inputTokens: null, outputTokens: null, totalTokens: null, cost: null, usageComplete: false },
      cleanup: { ...cleanup, stopped: true, stopReason: 'user' },
      endedAt: '2026-09-21T00:00:00.200Z',
      stoppedAt: '2026-09-21T00:00:00.150Z',
      durationMs: 100,
    })).toEqual({ ok: true, data: true });
    expect(opened.data.runs.recordCancel(first.data, '2026-09-21T00:00:00.300Z')).toEqual({ ok: true, data: false });
    opened.data.close();
  });

  it('[F-crash-reopen] marks created and running rows as interrupted on a real reopen', () => {
    const root = mkdtempSync(join(tmpdir(), 'flowmate-storage-reopen-'));
    const first = openDatabase(makePaths(root));
    expect(first.ok).toBe(true);
    if (!first.ok) return;
    const created = first.data.runs.create({ goal: input.goal, input, config, usage, cleanup, createdAt: '2026-09-21T00:00:00.000Z' });
    expect(created.ok).toBe(true);
    if (!created.ok) return;
    expect(first.data.runs.start(created.data, config, '2026-09-21T00:00:00.010Z').ok).toBe(true);
    first.data.close();

    const reopened = openDatabase(makePaths(root));
    expect(reopened.ok).toBe(true);
    if (reopened.ok) {
      const snapshot = reopened.data.runs.get(created.data);
      expect(snapshot.ok).toBe(true);
      if (snapshot.ok) {
        expect(snapshot.data.status).toBe('failed');
        expect(snapshot.data.error?.code).toBe('runtime_interrupted');
        expect(snapshot.data.cleanup).toMatchObject({ stopped: false, lateObservationRequired: true });
      }
      reopened.data.close();
    }
  });

  it('[F-schema-version] rejects an unsupported schema and a corrupt database instead of creating a replacement', () => {
    const unsupportedRoot = mkdtempSync(join(tmpdir(), 'flowmate-storage-schema-'));
    const unsupported = openDatabase(makePaths(unsupportedRoot));
    expect(unsupported.ok).toBe(true);
    if (unsupported.ok) unsupported.data.close();
    const raw = new Database(makePaths(unsupportedRoot).databaseFile);
    raw.exec('UPDATE schema_migrations SET version=99 WHERE id=1');
    raw.close();
    const unsupportedReopen = openDatabase(makePaths(unsupportedRoot));
    expect(unsupportedReopen.ok).toBe(false);
    if (!unsupportedReopen.ok) expect(unsupportedReopen.error.code).toBe('storage_schema_unsupported');

    const corruptRoot = mkdtempSync(join(tmpdir(), 'flowmate-storage-corrupt-'));
    const corruptPaths = makePaths(corruptRoot);
    mkdirSync(join(corruptRoot, 'data'), { recursive: true });
    writeFileSync(corruptPaths.databaseFile, 'not-a-sqlite-database', 'utf8');
    const corrupt = openDatabase(corruptPaths);
    expect(corrupt.ok).toBe(false);
    if (!corrupt.ok) expect(corrupt.error.code).toBe('storage_open_failed');
  });

  it('[F-run-json-version] rejects valid JSON with an unsupported Run record version', () => {
    const root = mkdtempSync(join(tmpdir(), 'flowmate-storage-json-version-'));
    const opened = openDatabase(makePaths(root));
    expect(opened.ok).toBe(true);
    if (!opened.ok) return;
    const created = opened.data.runs.create({ goal: input.goal, input, config, usage, cleanup, createdAt: '2026-09-21T00:00:00.000Z' });
    expect(created.ok).toBe(true);
    if (!created.ok) return;
    opened.data.db.query('UPDATE runs SET input_json=? WHERE id=?').run(JSON.stringify({ ...input, version: 2 }), created.data);

    const queried = opened.data.runs.get(created.data);

    expect(queried).toMatchObject({ ok: false, error: { code: 'storage_corrupt' } });
    opened.data.close();
  });

  it('[F-disk-write-failure] reports a real closed-database write failure', () => {
    const root = mkdtempSync(join(tmpdir(), 'flowmate-storage-closed-'));
    const opened = openDatabase(makePaths(root));
    expect(opened.ok).toBe(true);
    if (!opened.ok) return;
    const created = opened.data.runs.create({ goal: input.goal, input, config, usage, cleanup, createdAt: '2026-09-21T00:00:00.000Z' });
    expect(created.ok).toBe(true);
    if (!created.ok) return;
    opened.data.db.close();

    const result = opened.data.runs.finish(created.data, {
      status: 'failed',
      output: null,
      error: { version: 1, code: 'provider_network_error', category: 'provider', message: '网络失败。', retryable: true, runId: created.data },
      usage,
      tokens: { inputTokens: null, outputTokens: null, totalTokens: null, cost: null, usageComplete: false },
      cleanup,
      endedAt: '2026-09-21T00:00:00.010Z',
      stoppedAt: null,
      durationMs: 10,
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe('storage_write_failed');
  });

  it('[F-single-owner-process] rejects a second process while the first process owns the SQLite file', async () => {
    const root = mkdtempSync(join(tmpdir(), 'flowmate-storage-process-lock-'));
    const first = openDatabase(makePaths(root));
    expect(first.ok).toBe(true);
    if (!first.ok) return;
    first.data.close();

    const databaseFile = makePaths(root).databaseFile;
    writeFileSync(join(root, '.env'), 'FLOWMATE_LLM_API_KEY=synthetic-child-dotenv\n');
    const script = [
      "import { Database } from 'bun:sqlite';",
      "if (process.env.FLOWMATE_LLM_API_KEY === 'synthetic-child-dotenv') throw new Error('Test child loaded dotenv');",
      `const db = new Database(${JSON.stringify(databaseFile)});`,
      "db.exec('PRAGMA locking_mode=EXCLUSIVE; SELECT 1;');",
      "console.log('ready');",
      "await new Promise(() => {});",
    ].join('\n');
    const child = Bun.spawn([process.execPath, '--no-env-file', '-e', script], { cwd: root, stdout: 'pipe', stderr: 'pipe' });
    const timer = setTimeout(() => child.kill(), 5000);
    try {
      const reader = child.stdout.getReader();
      const decoder = new TextDecoder();
      let output = '';
      const deadline = Date.now() + 5_000;
      while (!output.includes('ready') && Date.now() < deadline) {
        const next = await reader.read();
        if (next.done) break;
        output += decoder.decode(next.value);
      }
      expect(output).toContain('ready');
      const second = openDatabase(makePaths(root));
      expect(second.ok).toBe(false);
      if (!second.ok) expect(second.error.code).toBe('storage_open_failed');
    } finally {
      clearTimeout(timer);
      child.kill();
      await child.exited;
    }
  });
});
