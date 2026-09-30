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
import type { InputRecordV2, UsageRecordV2 } from '../../../packages/contracts/src/runtime.ts';
import type { P3AgentConfigFacts } from '../../../packages/contracts/src/ports.ts';
import type { RunScope } from '../../../packages/contracts/src/tools.ts';
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
  it('migrates a real new database through version 8 before exposing repositories', () => withDatabase((paths) => {
    const opened = openDatabase(paths);
    expect(opened.ok).toBe(true);
    if (!opened.ok) return;
    expect(opened.data.db.query('SELECT version FROM schema_migrations ORDER BY version').all()).toEqual([{ version: 1 }, { version: 2 }, { version: 3 }, { version: 4 }, { version: 5 }, { version: 6 }, { version: 7 }, { version: 8 }]);
    expect(opened.data.db.query('PRAGMA foreign_key_check').all()).toEqual([]);
    opened.data.close();
  }));

  it('migrates version 7 without guessing old entry ownership and preserves native JSON', () => withDatabase((paths) => {
    const legacy = createLegacyV1(paths);
    for (const file of ['002_agent_sessions.sql', '003_invoice_tools.sql', '004_parsed_documents.sql',
      '005_native_session_history.sql', '006_hidden_processing.sql', '007_hidden_chats_invoices.sql']) {
      if (file === '004_parsed_documents.sql') {
        for (const sql of readFileSync(new URL(`../../../packages/core/src/storage/migrations/${file}`, import.meta.url), 'utf8')
          .split(';').map((sql) => sql.trim()).filter(Boolean)) legacy.exec(sql);
        legacy.exec('COMMIT');
      } else legacy.exec(readFileSync(new URL(`../../../packages/core/src/storage/migrations/${file}`, import.meta.url), 'utf8'));
    }
    const header = '{"type":"session","version":3,"id":"native-v7","timestamp":"2026-09-30T00:00:00.000Z","cwd":"fixture"}';
    const entry = '{"type":"message","id":"old-e1","parentId":null,"timestamp":"2026-09-30T00:00:00.000Z","message":{"role":"user","content":"old input","timestamp":1}}';
    legacy.query("INSERT INTO sessions(id,native_session_id,title,created_at,updated_at) VALUES (1,'native-v7','Old chat',?,?)")
      .run('2026-09-30T00:00:00.000Z', '2026-09-30T00:00:00.000Z');
    legacy.query("INSERT INTO session_native_history(session_id,storage_version,header_json,leaf_id,entry_count,unusable) VALUES (1,1,?,'old-e1',1,0)").run(header);
    legacy.query("INSERT INTO session_native_entries(session_id,sequence,entry_id,entry_json) VALUES (1,0,'old-e1',?)").run(entry);
    legacy.close();
    const migrated = openDatabase(paths);
    expect(migrated.ok).toBe(true);
    if (!migrated.ok) return;
    try {
      expect(migrated.data.db.query('SELECT MAX(version) AS version FROM schema_migrations').get()).toEqual({ version: 8 });
      expect(migrated.data.db.query('SELECT entry_json,run_id FROM session_native_entries').get()).toEqual({ entry_json: entry, run_id: null });
      expect(migrated.data.db.query('SELECT header_json,storage_version,leaf_id,entry_count FROM session_native_history').get())
        .toEqual({ header_json: header, storage_version: 1, leaf_id: 'old-e1', entry_count: 1 });
      expect(migrated.data.db.query('PRAGMA foreign_key_check').all()).toEqual([]);
    } finally { migrated.data.close(); }
  }));

  it('keeps ordered native history and leaf across restart, and marks corrupt history invalid', () => withDatabase((paths) => {
    const first = openDatabase(paths);
    expect(first.ok).toBe(true);
    if (!first.ok) return;
    const header = { type: 'session' as const, version: 3, id: 'native-history-one',
      timestamp: '2026-09-24T00:00:00.000Z', cwd: paths.runtimeDir };
    const created = first.data.sessions.create({ nativeSessionId: header.id, title: 'History', at: header.timestamp,
      nativeHistory: { storageVersion: 1, header, entries: [], leafId: null, unusable: false } });
    expect(created.ok).toBe(true);
    if (!created.ok) return;
    const sessionId = created.data.sessionId;
    const entry = { type: 'message', id: 'first', parentId: null, timestamp: header.timestamp,
      message: { role: 'user', content: [{ type: 'text', text: 'hello' }] } };
    expect(first.data.sessions.saveHistory(sessionId, { storageVersion: 1, header, entries: [entry], leafId: entry.id, unusable: false }).ok).toBe(true);
    first.data.close();
    const second = openDatabase(paths);
    expect(second.ok).toBe(true);
    if (!second.ok) return;
    expect(second.data.sessions.loadHistory(sessionId)).toMatchObject({ ok: true, data: { leafId: 'first', entries: [entry] } });
    expect(second.data.sessions.get(sessionId)).toMatchObject({ ok: true, data: { historyState: 'recoverable' } });
    second.data.db.query('UPDATE session_native_entries SET entry_json=? WHERE session_id=? AND sequence=0')
      .run(JSON.stringify({ ...entry, parentId: 'missing' }), sessionId);
    expect(second.data.sessions.get(sessionId)).toMatchObject({ ok: true, data: { historyState: 'invalid' } });
    expect(second.data.sessions.loadHistory(sessionId)).toMatchObject({ ok: false, error: { code: 'session_history_invalid' } });
    second.data.close();
  }));

  it('deletes a permitted session and its native history in one transaction', () => withDatabase((paths) => {
    const opened = openDatabase(paths);
    expect(opened.ok).toBe(true);
    if (!opened.ok) return;
    const at = '2026-09-24T00:00:00.000Z';
    const header = { type: 'session' as const, version: 3, id: 'native-delete-one', timestamp: at, cwd: paths.runtimeDir };
    const created = opened.data.sessions.create({ nativeSessionId: header.id, title: 'Delete', at,
      nativeHistory: { storageVersion: 1, header, entries: [], leafId: null, unusable: false } });
    expect(created.ok).toBe(true);
    if (!created.ok) return;
    const id = created.data.sessionId;
    expect(opened.data.sessions.prepareDelete(id, at).ok).toBe(true);
    expect(opened.data.sessions.delete(id, at)).toEqual({ ok: true, data: 'permanent' });
    expect(opened.data.db.query('SELECT * FROM session_native_history WHERE session_id=?').get(id)).toBeNull();
    expect(opened.data.sessions.get(id)).toMatchObject({ ok: false, error: { code: 'session_not_found' } });
    opened.data.close();
  }));

  it('reads version-2 P3 Run facts beside unchanged version-1 P2 records', () => withDatabase((paths) => {
    const opened = openDatabase(paths);
    expect(opened.ok).toBe(true);
    if (!opened.ok) return;
    const { sessions, runs } = opened.data;
    const session = sessions.create({ nativeSessionId: 'p3-native-session', title: 'P3', at: '2026-09-24T00:00:00.000Z' });
    expect(session.ok).toBe(true);
    if (!session.ok) return;

    const p3Agent: P3AgentConfigFacts = {
      policyVersion: 'p3-invoice-tools-v1', nativeSessionId: 'p3-native-session',
      systemPrompt: 'P3 fixture', thinkingLevel: 'off', resourcePolicy: 'none', historyPolicy: 'memory-only',
      maxContextBytes: 8_388_608, maxOutputBytes: 262_144, maxAssistantContentBytes: 524_288,
      maxModelCalls: 12, maxToolCalls: 24, toolTimeoutMs: 10_000, sessionRetry: false,
    };
    const p3Input: InputRecordV2 = {
      version: 2, goal: 'Read invoice', text: 'Invoice INV-1', messageTimestamp: 1_800_000_000_000,
      workspaceInput: { documentRef: null, job: null, candidate: null },
    };
    const p3Usage: UsageRecordV2 = {
      ...usage, version: 2, calls: [],
    };
    const p3Scope: RunScope = {
      version: 2, allowedTools: ['list_invoice_pages'], allowedDocumentIds: [1],
      allowedArtifactIds: [2], allowedResourcePaths: [],
    };
    const created = runs.createAgent({
      goal: p3Input.goal, input: p3Input, config: { ...baseConfig, agent: p3Agent }, usage: p3Usage,
      cleanup, createdAt: '2026-09-24T00:01:00.000Z', sessionId: session.data.sessionId, scope: p3Scope,
    });
    expect(created.ok).toBe(true);
    if (!created.ok) return;
    expect(runs.get(created.data)).toMatchObject({
      ok: true,
      data: { input: { version: 2, workspaceInput: { documentRef: null } }, usage: { version: 2, calls: [] },
        config: { agent: { policyVersion: 'p3-invoice-tools-v1', maxToolCalls: 24 } }, scope: p3Scope },
    });
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

  it('renames a Session in place without changing its identity', () => withDatabase((paths) => {
    const opened = openDatabase(paths);
    expect(opened.ok).toBe(true);
    if (!opened.ok) return;
    const { sessions } = opened.data;
    const created = sessions.create({ nativeSessionId: 'native-rename-session', title: 'Before', at: '2026-09-24T00:00:00.000Z' });
    expect(created.ok).toBe(true);
    if (!created.ok) return;
    const sessionId = created.data.sessionId;
    const renamed = sessions.rename({ sessionId, title: 'After', at: '2026-09-24T01:00:00.000Z' });
    expect(renamed).toMatchObject({ ok: true, data: { sessionId, nativeSessionId: 'native-rename-session', title: 'After', updatedAt: '2026-09-24T01:00:00.000Z' } });
    expect(sessions.get(sessionId)).toMatchObject({ ok: true, data: { nativeSessionId: 'native-rename-session', title: 'After' } });
    opened.data.close();
  }));

  it('permanently deletes only the selected Session and its Agent Runs while retaining other Sessions and Provider Runs', () => withDatabase((paths) => {
    const opened = openDatabase(paths);
    expect(opened.ok).toBe(true);
    if (!opened.ok) return;
    const { db, sessions, runs } = opened.data;
    const firstSession = sessions.create({ nativeSessionId: 'native-delete-all-one', title: 'One', at: '2026-09-24T00:00:00.000Z' });
    const secondSession = sessions.create({ nativeSessionId: 'native-delete-all-two', title: 'Two', at: '2026-09-24T00:00:00.000Z' });
    expect(firstSession.ok && secondSession.ok).toBe(true);
    if (!firstSession.ok || !secondSession.ok) return;
    const firstRun = runs.createAgent({ goal: runInput.goal, input: runInput, config: agentConfig, usage, cleanup,
      createdAt: '2026-09-24T00:01:00.000Z', sessionId: firstSession.data.sessionId, scope });
    expect(firstRun.ok).toBe(true);
    if (!firstRun.ok) return;
    const finishAgent = (runId: number, endedAt: string) => runs.finish(runId, {
      status: 'failed', output: null,
      error: { code: 'fixture_failed', category: 'runtime', message: 'fixture', retryable: false },
      usage, tokens: { inputTokens: null, outputTokens: null, totalTokens: null, cost: null, usageComplete: false },
      cleanup, endedAt, stoppedAt: null, durationMs: 1,
    });
    expect(finishAgent(firstRun.data, '2026-09-24T00:01:30.000Z').ok).toBe(true);
    const secondRun = runs.createAgent({ goal: runInput.goal, input: runInput, config: agentConfig, usage, cleanup,
      createdAt: '2026-09-24T00:02:00.000Z', sessionId: secondSession.data.sessionId, scope });
    expect(secondRun.ok).toBe(true);
    if (!secondRun.ok) return;
    expect(finishAgent(secondRun.data, '2026-09-24T00:02:30.000Z').ok).toBe(true);
    const providerRun = runs.create({ goal: runInput.goal, input: runInput, config: baseConfig, usage, cleanup, createdAt: '2026-09-24T00:03:00.000Z' });
    expect(providerRun.ok).toBe(true);
    if (!providerRun.ok) return;
    expect(runs.finish(providerRun.data, {
      status: 'failed', output: null,
      error: { code: 'fixture_failed', category: 'provider', message: 'fixture', retryable: false },
      usage, tokens: { inputTokens: null, outputTokens: null, totalTokens: null, cost: null, usageComplete: false },
      cleanup, endedAt: '2026-09-24T00:05:00.000Z', stoppedAt: null, durationMs: 1,
    }).ok).toBe(true);

    const activeTarget = runs.createAgent({ goal: runInput.goal, input: runInput, config: agentConfig, usage, cleanup,
      createdAt: '2026-09-24T00:05:30.000Z', sessionId: secondSession.data.sessionId, scope });
    expect(activeTarget.ok).toBe(true);
    if (!activeTarget.ok) return;
    expect(sessions.prepareDelete(secondSession.data.sessionId, '2026-09-24T00:05:40.000Z')).toMatchObject({ ok: false, error: { code: 'session_busy' } });
    expect(sessions.get(firstSession.data.sessionId)).toMatchObject({ ok: true, data: { status: 'active' } });
    expect(sessions.get(secondSession.data.sessionId)).toMatchObject({ ok: true, data: { status: 'active' } });
    expect(finishAgent(activeTarget.data, '2026-09-24T00:05:50.000Z').ok).toBe(true);

    const activeOther = runs.createAgent({ goal: runInput.goal, input: runInput, config: agentConfig, usage, cleanup,
      createdAt: '2026-09-24T00:05:55.000Z', sessionId: firstSession.data.sessionId, scope });
    expect(activeOther.ok).toBe(true);
    if (!activeOther.ok) return;
    const prepared = sessions.prepareDelete(secondSession.data.sessionId, '2026-09-24T00:06:00.000Z');
    expect(prepared).toMatchObject({ ok: true, data: { sessionId: secondSession.data.sessionId, status: 'archived' } });
    expect(sessions.get(firstSession.data.sessionId)).toMatchObject({ ok: true, data: { status: 'active' } });
    db.exec("CREATE TRIGGER block_second_session_delete BEFORE DELETE ON sessions WHEN OLD.id=(SELECT id FROM sessions WHERE title='Two') BEGIN SELECT RAISE(ABORT, 'fixture failure'); END;");
    expect(sessions.delete(secondSession.data.sessionId, '2026-09-24T00:06:30.000Z')).toMatchObject({ ok: false, error: { code: 'storage_write_failed' } });
    expect(sessions.get(secondSession.data.sessionId)).toMatchObject({ ok: true, data: { status: 'archived' } });
    expect(runs.get(firstRun.data)).toMatchObject({ ok: true, data: { kind: 'agent' } });
    expect(runs.get(secondRun.data)).toMatchObject({ ok: true, data: { kind: 'agent' } });
    db.exec('DROP TRIGGER block_second_session_delete;');
    expect(sessions.delete(secondSession.data.sessionId, '2026-09-24T00:07:00.000Z')).toEqual({ ok: true, data: 'permanent' });
    expect(sessions.list({ limit: 10 })).toMatchObject({ ok: true, data: { items: [{ sessionId: firstSession.data.sessionId, status: 'active' }] } });
    expect(runs.get(firstRun.data)).toMatchObject({ ok: true, data: { kind: 'agent', status: 'failed', sessionId: firstSession.data.sessionId } });
    expect(runs.get(secondRun.data)).toMatchObject({ ok: false, error: { code: 'run_not_found' } });
    expect(runs.get(activeOther.data)).toMatchObject({ ok: true, data: { kind: 'agent', status: 'created', sessionId: firstSession.data.sessionId } });
    expect(runs.get(providerRun.data)).toMatchObject({ ok: true, data: { kind: 'provider', sessionId: null } });
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
