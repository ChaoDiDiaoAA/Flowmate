import { readFileSync } from 'node:fs';
import { mkdirSync } from 'node:fs';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Database } from 'bun:sqlite';
import { describe, expect, it } from 'bun:test';
import { openDatabase } from '../../../packages/core/src/storage/database.ts';
import { createRunRepository } from '../../../packages/core/src/storage/repositories.ts';
import { normalizeListSessionsRequest, normalizeSessionRunsRequest } from '../../../packages/contracts/src/schemas.ts';
import type { ProductPaths } from '../../../packages/contracts/src/runtime.ts';

function makePaths(root: string): ProductPaths {
  return {
    root,
    databaseFile: join(root, 'data', 'trial.sqlite'),
    logsDir: join(root, 'logs'),
    artifactsDir: join(root, 'artifacts'),
    outputsDir: join(root, 'outputs'),
    runtimeDir: join(root, 'runtime'),
  };
}

function withDatabase(test: (paths: ProductPaths) => void) {
  const root = mkdtempSync(join(tmpdir(), 'flowmate-sessions-'));
  test(makePaths(root));
}

const runInput = {
  version: 1 as const,
  goal: '理解发票摘要',
  text: '发票号码 INV-1',
  messageTimestamp: 1_800_000_000_000,
};
const usage = {
  version: 1 as const,
  source: 'unknown' as const,
  reason: 'not-requested',
  sdkValues: null,
  attempts: null,
  attemptsComplete: false,
  costSource: null,
  updatedAt: '2026-09-24T00:00:00.000Z',
};
const cleanup = {
  version: 1 as const,
  stopped: false,
  stopReason: null,
  errors: [],
  lateObservationRequired: false,
};
const baseConfig = {
  version: 1 as const,
  name: 'fixture',
  revision: 1,
  requestedModel: { provider: 'fixture', model: 'fixture-model' },
  resolvedModel: { provider: 'fixture', model: 'fixture-model' },
  api: 'openai-completions',
  endpoint: 'https://fixture.invalid/v1',
  sdk: { codingAgent: '0.85.1', ai: '0.85.1' },
  parameters: { maxRetries: 0, maxRetryDelayMs: 2000 },
  limits: { timeoutMs: 60_000, stopGraceMs: 5_000 },
  native: { authSource: 'pi-runtime-api-key' as const, modelsSelection: null },
};
const agentConfig = {
  ...baseConfig,
  agent: {
    policyVersion: 'p2-invoice-chat-v1' as const,
    nativeSessionId: 'native-session-one',
    systemPrompt: 'fixture invoice system prompt',
    thinkingLevel: 'off',
    resourcePolicy: 'none' as const,
    historyPolicy: 'memory-only' as const,
    maxContextBytes: 524_288 as const,
    maxOutputBytes: 262_144 as const,
    maxAssistantContentBytes: 524_288 as const,
    maxModelCalls: 1 as const,
    sessionRetry: false as const,
  },
};
const scope = { version: 1 as const, mode: 'chat-text' as const, toolNames: [] as [], resourcePaths: [] as [] };

function createLegacyV1(paths: ProductPaths, includeActive = false) {
  mkdirSync(join(paths.root, 'data'), { recursive: true });
  const db = new Database(paths.databaseFile, { create: true });
  db.exec('PRAGMA foreign_keys=ON; PRAGMA busy_timeout=1000; PRAGMA journal_mode=DELETE; PRAGMA locking_mode=EXCLUSIVE;');
  db.exec(readFileSync(new URL('../../../packages/core/src/storage/migrations/001_provider.sql', import.meta.url), 'utf8'));
  const insert = db.query(`INSERT INTO runs (
    id,kind,status,goal,input_json,config_json,output_json,error_json,cleanup_json,usage_json,
    input_tokens,output_tokens,total_tokens,cost,duration_ms,tool_call_count,usage_complete,
    created_at,started_at,ended_at,cancel_requested_at,stopped_at
  ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`);
  const stamp = '2026-09-24T00:00:00.000Z';
  const records = [
    { id: 11, status: 'completed', output: { version: 1, text: 'legacy complete', partial: false, stopReason: 'stop', responseId: null, responseModel: 'fixture' }, error: null, started: stamp, ended: stamp, cancel: null, stopped: stamp, cleanupValue: { ...cleanup, stopped: true, stopReason: 'native-stop' } },
    { id: 12, status: 'failed', output: null, error: { version: 1, code: 'provider_failed', category: 'provider', message: 'failed', retryable: true }, started: stamp, ended: stamp, cancel: null, stopped: null, cleanupValue: cleanup },
    { id: 13, status: 'cancelled', output: { version: 1, text: 'partial', partial: true, stopReason: 'aborted', responseId: null, responseModel: null }, error: { version: 1, code: 'provider_cancelled', category: 'provider', message: 'cancelled', retryable: false }, started: stamp, ended: stamp, cancel: stamp, stopped: stamp, cleanupValue: { ...cleanup, stopped: true, stopReason: 'user' } },
    ...(includeActive ? [{ id: 14, status: 'running', output: null, error: null, started: stamp, ended: null, cancel: null, stopped: null, cleanupValue: cleanup }] : []),
  ];
  for (const record of records) {
    insert.run(
      record.id, 'provider', record.status, 'legacy goal', JSON.stringify(runInput), JSON.stringify(baseConfig),
      record.output === null ? null : JSON.stringify(record.output), record.error === null ? null : JSON.stringify(record.error),
      JSON.stringify(record.cleanupValue), JSON.stringify(usage), null, null, null, null, null, 0, 0,
      stamp, record.started, record.ended, record.cancel, record.stopped,
    );
  }
  return db;
}

const legacyColumns = [
  'id', 'kind', 'status', 'goal', 'input_json', 'config_json', 'output_json', 'error_json', 'cleanup_json', 'usage_json',
  'input_tokens', 'output_tokens', 'total_tokens', 'cost', 'duration_ms', 'tool_call_count', 'usage_complete', 'created_at',
  'started_at', 'ended_at', 'cancel_requested_at', 'stopped_at',
].join(',');

describe('P2 Session and Agent Run storage', () => {
  it('migrates a real new database through versions 1 and 2 before exposing repositories', () => withDatabase((paths) => {
    const opened = openDatabase(paths);
    expect(opened.ok).toBe(true);
    if (!opened.ok) return;
    expect(opened.data.db.query('SELECT version FROM schema_migrations ORDER BY version').all()).toEqual([{ version: 1 }, { version: 2 }]);
    expect(opened.data.db.query('PRAGMA foreign_key_check').all()).toEqual([]);
    opened.data.close();
  }));

  it('preserves every legacy column before interrupted-run recovery, then recovers only active rows', () => withDatabase((paths) => {
    const legacy = createLegacyV1(paths, true);
    const before = legacy.query(`SELECT ${legacyColumns} FROM runs ORDER BY id`).all();
    legacy.exec(readFileSync(new URL('../../../packages/core/src/storage/migrations/002_agent_sessions.sql', import.meta.url), 'utf8'));
    const afterMigration = legacy.query(`SELECT ${legacyColumns} FROM runs ORDER BY id`).all();
    expect(afterMigration).toEqual(before);

    const runs = createRunRepository(legacy);
    expect(runs.failInterrupted('2026-09-24T01:00:00.000Z')).toEqual({ ok: true, data: 1 });
    const recovered = runs.get(14);
    expect(recovered).toMatchObject({ ok: true, data: { status: 'failed', stoppedAt: null, error: { code: 'runtime_interrupted' } } });
    expect(legacy.query(`SELECT ${legacyColumns} FROM runs WHERE id=11`).get()).toEqual(before[0]);
    expect(legacy.query(`SELECT ${legacyColumns} FROM runs WHERE id=12`).get()).toEqual(before[1]);
    expect(legacy.query(`SELECT ${legacyColumns} FROM runs WHERE id=13`).get()).toEqual(before[2]);
    legacy.close();
  }));

  it('rolls back a failed version-2 migration through openDatabase without touching legacy data or recovery state', () => withDatabase((paths) => {
    const legacy = createLegacyV1(paths, true);
    legacy.exec('CREATE TABLE runs_v2 (fixture_collision INTEGER);');
    const before = legacy.query(`SELECT ${legacyColumns} FROM runs ORDER BY id`).all();
    legacy.close();

    const failedOpen = openDatabase(paths);
    expect(failedOpen).toMatchObject({ ok: false, error: { code: 'storage_open_failed' } });

    const reopened = new Database(paths.databaseFile);
    expect(reopened.query('SELECT version FROM schema_migrations ORDER BY version').all()).toEqual([{ version: 1 }]);
    expect(reopened.query("SELECT name FROM sqlite_master WHERE type='table' AND name='sessions'").get()).toBeNull();
    expect(reopened.query('SELECT fixture_collision FROM runs_v2').all()).toEqual([]);
    expect(reopened.query(`SELECT ${legacyColumns} FROM runs ORDER BY id`).all()).toEqual(before);
    const active = reopened.query('SELECT status,ended_at,stopped_at FROM runs WHERE id=14').get();
    expect(active).toEqual({ status: 'running', ended_at: null, stopped_at: null });
    reopened.close();
  }));

  it('persists native Session identities, enforces Agent links, and updates a Session with its Run terminal', () => withDatabase((paths) => {
    const opened = openDatabase(paths);
    expect(opened.ok).toBe(true);
    if (!opened.ok) return;
    const { sessions, runs, db } = opened.data;
    const first = sessions.create({ nativeSessionId: 'native-session-one', title: 'Invoice A', at: '2026-09-24T00:00:00.000Z' });
    const second = sessions.create({ nativeSessionId: 'native-session-two', title: 'Invoice B', at: '2026-09-24T00:00:00.000Z' });
    expect(first.ok).toBe(true);
    expect(second.ok).toBe(true);
    if (!first.ok || !second.ok) return;
    expect(first.data.nativeSessionId).toBe('native-session-one');
    expect(first.data.sessionId).not.toBe('native-session-one');
    expect(sessions.create({ nativeSessionId: 'native-session-one', title: 'Duplicate', at: '2026-09-24T00:00:00.000Z' }).ok).toBe(false);

    const pageOneRequest = normalizeListSessionsRequest({ limit: 1 });
    expect(pageOneRequest.ok).toBe(true);
    if (!pageOneRequest.ok) return;
    const pageOne = sessions.list(pageOneRequest.data);
    expect(pageOne).toMatchObject({ ok: true, data: { items: [{ sessionId: second.data.sessionId }], next: { sessionId: second.data.sessionId } } });
    if (!pageOne.ok || !pageOne.data.next) return;
    const pageTwoRequest = normalizeListSessionsRequest({ limit: 1, before: pageOne.data.next });
    expect(pageTwoRequest.ok).toBe(true);
    if (!pageTwoRequest.ok) return;
    expect(sessions.list(pageTwoRequest.data)).toMatchObject({ ok: true, data: { items: [{ sessionId: first.data.sessionId }], next: null } });

    const invalidSession = runs.createAgent({
      goal: runInput.goal, input: runInput, config: agentConfig, usage, cleanup, createdAt: '2026-09-24T00:01:00.000Z',
      sessionId: 999, scope,
    });
    expect(invalidSession).toMatchObject({ ok: false, error: { code: 'session_not_found' } });

    const created = runs.createAgent({
      goal: runInput.goal, input: runInput, config: agentConfig, usage, cleanup, createdAt: '2026-09-24T00:01:00.000Z',
      sessionId: first.data.sessionId, scope,
    });
    expect(created.ok).toBe(true);
    if (!created.ok) return;
    expect(runs.create({ goal: runInput.goal, input: runInput, config: baseConfig, usage, cleanup, createdAt: '2026-09-24T00:02:00.000Z' }))
      .toMatchObject({ ok: false, error: { code: 'runtime_busy' } });
    expect(runs.get(created.data)).toMatchObject({
      ok: true,
      data: { kind: 'agent', sessionId: first.data.sessionId, scope, config: { agent: { nativeSessionId: 'native-session-one' } } },
    });
    const runPageRequest = normalizeSessionRunsRequest({ sessionId: first.data.sessionId });
    expect(runPageRequest.ok).toBe(true);
    if (!runPageRequest.ok) return;
    expect(runs.listBySession(runPageRequest.data)).toMatchObject({
      ok: true,
      data: { items: [{ runId: created.data, kind: 'agent' }], nextBeforeRunId: null },
    });

    const finalized = runs.finish(created.data, {
      status: 'cancelled',
      output: { version: 1, text: 'partial answer', partial: true, stopReason: 'aborted', responseId: null, responseModel: 'fixture-model', agent: { nativeSessionId: 'native-session-one', turnCount: 1, modelCallCount: 1 } },
      error: { code: 'agent_cancelled', category: 'runtime', message: 'cancelled', retryable: false, runId: created.data },
      usage,
      tokens: { inputTokens: null, outputTokens: null, totalTokens: null, cost: null, usageComplete: false },
      cleanup: { ...cleanup, stopped: true, stopReason: 'user' },
      endedAt: '2026-09-24T00:03:00.000Z',
      stoppedAt: '2026-09-24T00:02:59.000Z',
      durationMs: 120_000,
      cancelRequestedAt: '2026-09-24T00:02:58.000Z',
    });
    expect(finalized).toEqual({ ok: true, data: true });
    expect(runs.get(created.data)).toMatchObject({ ok: true, data: { status: 'cancelled', cancelRequestedAt: '2026-09-24T00:02:58.000Z' } });
    expect(sessions.get(first.data.sessionId)).toMatchObject({ ok: true, data: { updatedAt: '2026-09-24T00:03:00.000Z' } });

    expect(() => db.query('DELETE FROM sessions WHERE id=?').run(first.data.sessionId)).toThrow();
    expect(db.query('PRAGMA foreign_key_check').all()).toEqual([]);
    opened.data.close();
  }));

  it('enforces Run kind and Session reference combinations with SQLite constraints', () => withDatabase((paths) => {
    const opened = openDatabase(paths);
    expect(opened.ok).toBe(true);
    if (!opened.ok) return;
    const { db, sessions } = opened.data;
    const session = sessions.create({ nativeSessionId: 'native-session-constraints', title: 'Constraints', at: '2026-09-24T00:00:00.000Z' });
    expect(session.ok).toBe(true);
    if (!session.ok) return;
    const insert = db.query(`INSERT INTO runs(kind,session_id,scope_json,status,goal,input_json,config_json,cleanup_json,usage_json,created_at)
      VALUES (?,?,?,'created','goal','{}','{}','{}','{}','2026-09-24T00:00:00.000Z')`);
    expect(() => insert.run('unknown', null, null)).toThrow();
    expect(() => insert.run('provider', session.data.sessionId, null)).toThrow();
    expect(() => insert.run('agent', null, JSON.stringify(scope))).toThrow();
    expect(() => insert.run('agent', 99_999, JSON.stringify(scope))).toThrow();
    expect(db.query('PRAGMA foreign_key_check').all()).toEqual([]);
    opened.data.close();
  }));
});
