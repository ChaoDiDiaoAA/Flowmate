import { saveTestHistory } from '../../support/history.ts';
import { readFileSync } from 'node:fs';
import { mkdirSync } from 'node:fs';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Database } from 'bun:sqlite';
import { describe, expect, it } from 'bun:test';
import { openDatabase } from '../../../packages/core/src/storage/database.ts';
import { createRunRepository, createSessionRepository } from '../../../packages/core/src/storage/repositories.ts';
import { normalizeListSessionsRequest, normalizeSessionRunsRequest } from '../../../packages/contracts/src/schemas.ts';
import type { InputRecordV2, UsageRecordV2 } from '../../../packages/contracts/src/runtime.ts';
import type { P3AgentConfigFacts } from '../../../packages/contracts/src/ports.ts';
import type { RunScope } from '../../../packages/contracts/src/tools.ts';
import type { ProductPaths } from '../../../packages/contracts/src/runtime.ts';
import type { NativeSessionHistory } from '@flowmate/contracts';
import { deferCleanup } from '../../support/resources.ts';

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

function nativeFixture(paths: ProductPaths, historical = false) {
  const opened = openDatabase(paths);
  expect(opened.ok).toBe(true);
  if (!opened.ok) throw new Error(opened.error.code);
  let closed = false;
  const close = () => { if (!closed) { closed = true; opened.data.close(); } };
  deferCleanup(close);
  // These corruption/repair fixtures represent history written before P6 event recording.
  const sessions = historical ? createSessionRepository(opened.data.db) : opened.data.sessions;
  const runs = historical ? createRunRepository(opened.data.db) : opened.data.runs;
  const history: NativeSessionHistory = { storageVersion: 1,
    header: { type: 'session', version: 3, id: 'native-p4-storage', timestamp: '2026-09-30T00:00:00.000Z', cwd: paths.runtimeDir },
    entries: [], leafId: null, unusable: false };
  const session = sessions.create({ nativeSessionId: history.header.id, title: 'P4 storage', at: history.header.timestamp, nativeHistory: history });
  expect(session.ok).toBe(true);
  if (!session.ok) throw new Error(session.error.code);
  const run = runs.createAgent({ goal: runInput.goal, input: runInput,
    config: { ...agentConfig, agent: { ...agentConfig.agent, nativeSessionId: history.header.id } }, usage, cleanup,
    createdAt: history.header.timestamp, sessionId: session.data.sessionId, scope });
  expect(run.ok).toBe(true);
  if (!run.ok) throw new Error(run.error.code);
  const entry = { type: 'message', id: 'p4-e1', parentId: null, timestamp: history.header.timestamp,
    message: { role: 'user', content: 'hello', timestamp: 1 } };
  const terminal = { status: 'failed' as const, output: null, error: { code: 'agent_failed', category: 'runtime' as const, message: 'fixture', retryable: false },
    usage, tokens: { inputTokens: null, outputTokens: null, totalTokens: null, cost: null, usageComplete: false },
    cleanup, endedAt: '2026-09-30T00:01:00.000Z', stoppedAt: null, durationMs: 1000 };
  return { ...opened.data, historyEvents: historical ? undefined : opened.data.runtimeEventStore, runs, sessions, close, sessionId: session.data.sessionId, runId: run.data, history, entry, terminal };
}

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

function createLegacyV7(paths: ProductPaths) {
  const db = createLegacyV1(paths);
  for (const file of ['002_agent_sessions.sql', '003_invoice_tools.sql', '004_parsed_documents.sql',
    '005_native_session_history.sql', '006_hidden_processing.sql', '007_hidden_chats_invoices.sql']) {
    if (file === '004_parsed_documents.sql') {
      for (const sql of readFileSync(new URL(`../../../packages/core/src/storage/migrations/${file}`, import.meta.url), 'utf8')
        .split(';').map((sql) => sql.trim()).filter(Boolean)) db.exec(sql);
      db.exec('COMMIT');
    } else db.exec(readFileSync(new URL(`../../../packages/core/src/storage/migrations/${file}`, import.meta.url), 'utf8'));
  }
  return db;
}

function createLegacyV10(paths: ProductPaths) {
  const db = createLegacyV7(paths);
  for (const file of ['008_native_entry_runs.sql', '009_session_inputs.sql', '010_human_candidates.sql']) {
    for (const sql of readFileSync(new URL(`../../../packages/core/src/storage/migrations/${file}`, import.meta.url), 'utf8')
      .split(';').map(value => value.trim()).filter(Boolean)) db.exec(sql);
    if (file === '010_human_candidates.sql') { db.exec('COMMIT'); db.exec('PRAGMA foreign_keys=ON'); }
  }
  return db;
}

describe('P5 migration compatibility', () => {
  const stamp = '2026-10-02T00:00:00.000Z';
  const metadata = JSON.stringify({ version: 1, model_use_blocked: null, tool_profile: 'invoice' });
  function seedLegacy(paths: ProductPaths) {
    const db = createLegacyV10(paths);
    for (const [id, status, hidden] of [[1, 'archived', null], [2, 'active', null], [3, 'archived', stamp]] as const) {
      db.query('INSERT INTO sessions(id,native_session_id,title,status,created_at,updated_at,metadata_json,hidden_at) VALUES(?,?,?,?,?,?,?,?)')
        .run(id, `native-old-${id}`, 'Old input', status, stamp, stamp, metadata, hidden);
    }
    const header = { type: 'session', version: 3, id: 'native-old-1', timestamp: stamp, cwd: paths.runtimeDir };
    const entry = { type: 'message', id: 'u1', parentId: null, timestamp: stamp,
      message: { role: 'user', content: [{ type: 'text', text: 'Frozen request' }], timestamp: 1 } };
    db.query('INSERT INTO session_native_history(session_id,storage_version,header_json,leaf_id,entry_count,unusable) VALUES(1,1,?,?,1,0)')
      .run(JSON.stringify(header), 'u1');
    db.query('INSERT INTO session_native_entries(session_id,sequence,entry_id,entry_json,run_id) VALUES(1,0,?,?,NULL)')
      .run('u1', JSON.stringify(entry));
    const content = { version: 1, text: 'Frozen request', workspaceContext: { formatVersion: 1, revision: 0,
      documentRef: null, jobId: null, candidateRef: null, sessionId: 1, activeView: 'original', selection: null },
      allowedDocumentIds: [], allowedArtifactIds: [] };
    db.query("INSERT INTO session_inputs(id,session_id,client_sequence,mode,goal_mode,request_hash,run_id,content_json,status,processing_status,native_entry_id,created_at,updated_at) VALUES(1,1,7,'prompt','fill-form',?,NULL,?,'consumed','completed','u1',?,?)")
      .run('a'.repeat(64), JSON.stringify(content), stamp, stamp);
    return db;
  }

  it('preserves v1 input bytes and identifies unfinished legacy Delete without hiding normal Sessions', () => withDatabase(paths => {
    const legacy = seedLegacy(paths);
    const before = legacy.query('SELECT * FROM session_inputs').get(); legacy.close();
    const opened = openDatabase(paths);
    expect(opened.ok).toBe(true); if (!opened.ok) return;
    deferCleanup(() => opened.data.close());
    expect(opened.data.db.query('SELECT MAX(version) AS version FROM schema_migrations').get()).toEqual({ version: 19 });
    expect(opened.data.db.query('SELECT * FROM session_inputs').get()).toEqual({ ...before as object, result_entry_id: null, context_snapshot_id: null });
    const rows = opened.data.db.query('SELECT id,metadata_json,hidden_at,updated_at FROM sessions ORDER BY id').all() as Array<{ id: number; metadata_json: string; hidden_at: string | null; updated_at: string }>;
    expect(JSON.parse(rows[0]!.metadata_json)).toEqual({ version: 1, model_use_blocked: null, tool_profile: 'invoice', delete_pending: true });
    expect(rows[0]!.hidden_at).toBeNull(); expect(rows[0]!.updated_at).toBe(stamp);
    expect(rows[1]!.metadata_json).toBe(metadata); expect(rows[2]!.metadata_json).toBe(metadata);
    expect(opened.data.db.query('PRAGMA foreign_key_check').all()).toEqual([]);
  }));

  it('rolls back the input-table rebuild and Delete marker when the v11 commit marker fails', () => withDatabase(paths => {
    const legacy = seedLegacy(paths);
    const before = legacy.query('SELECT * FROM session_inputs').get();
    legacy.exec("CREATE TRIGGER reject_schema_11 BEFORE INSERT ON schema_migrations WHEN NEW.version=11 BEGIN SELECT RAISE(ABORT,'v11 rejected'); END;");
    legacy.close();
    expect(openDatabase(paths)).toMatchObject({ ok: false, error: { code: 'storage_open_failed' } });
    const after = new Database(paths.databaseFile); deferCleanup(() => after.close());
    expect(after.query('SELECT MAX(version) AS version FROM schema_migrations').get()).toEqual({ version: 10 });
    expect(after.query('SELECT * FROM session_inputs').get()).toEqual(before);
    expect(after.query('SELECT metadata_json FROM sessions WHERE id=1').get()).toEqual({ metadata_json: metadata });
    expect(after.query('PRAGMA foreign_key_check').all()).toEqual([]);
  }));

  it('requires v2 result references while retaining legacy completions and allowing shared results', () => withDatabase(paths => {
    const legacy = seedLegacy(paths); legacy.close();
    const opened = openDatabase(paths); expect(opened.ok).toBe(true); if (!opened.ok) return;
    deferCleanup(() => opened.data.close()); const db = opened.data.db;
    expect((db.query('PRAGMA table_info(session_inputs)').all() as Array<{ name: string }>).map(value => value.name)).toContain('result_entry_id');
    const v2 = JSON.stringify({ version: 2, text: 'Frozen request', workspaceContext: null, workspaceInput: null,
      allowedDocumentIds: [], allowedArtifactIds: [], promptText: 'Frozen request' });
    expect(() => db.query('UPDATE session_inputs SET content_json=? WHERE id=1').run(v2)).toThrow();
    db.query("INSERT INTO session_native_entries(session_id,sequence,entry_id,entry_json,run_id) VALUES(1,1,'a1','{}',NULL),(1,2,'u2','{}',NULL)").run();
    db.query("UPDATE session_inputs SET mode='steer',goal_mode='answer',content_json=?,result_entry_id='a1' WHERE id=1").run(v2);
    db.query("INSERT INTO session_inputs(id,session_id,client_sequence,mode,goal_mode,request_hash,content_json,status,processing_status,native_entry_id,result_entry_id,created_at,updated_at) VALUES(2,1,8,'followUp','answer',?,?,'consumed','completed','u2','a1',?,?)")
      .run('b'.repeat(64), v2, stamp, stamp);
    expect(db.query("SELECT COUNT(*) AS count FROM session_inputs WHERE result_entry_id='a1'").get()).toEqual({ count: 2 });
    expect(() => db.query("UPDATE session_inputs SET mode='followUp',goal_mode='fill-form' WHERE id=1").run()).toThrow();
    expect(() => db.query('UPDATE session_inputs SET session_id=2 WHERE id=2').run()).toThrow();
    expect(db.query('PRAGMA foreign_key_check').all()).toEqual([]);
  }));
});

const legacyColumns = [
  'id', 'kind', 'status', 'goal', 'input_json', 'config_json', 'output_json', 'error_json', 'cleanup_json', 'usage_json',
  'input_tokens', 'output_tokens', 'total_tokens', 'cost', 'duration_ms', 'tool_call_count', 'usage_complete', 'created_at',
  'started_at', 'ended_at', 'cancel_requested_at', 'stopped_at',
].join(',');

describe('P2 Session and Agent Run storage', () => {
  it('binds only the true appended message to its Run and reads display facts without changing the SDK snapshot', () => withDatabase((paths) => {
    const store = nativeFixture(paths);
    const history = { ...store.history, entries: [store.entry], leafId: store.entry.id };
    expect(typeof store.sessions.readHistoryForDisplay).toBe('function');
    expect(store.sessions.readHistoryForDisplay(store.sessionId)).toEqual({ ok: true, data: { history: store.history, bindings: [], sessionInputs: [], origins: [] } });
    expect(store.sessions.readHistoryForDisplay(999_999)).toEqual({ ok: true, data: { history: null, bindings: [], sessionInputs: [], origins: [] } });
    const context = { entryId: store.entry.id, runId: store.runId };
    expect(saveTestHistory(store.db, store.historyEvents, store.sessionId, history, context)).toEqual({ ok: true, data: undefined });
    expect(store.sessions.readHistoryForDisplay(store.sessionId)).toEqual({ ok: true, data: { history,
      bindings: [{ entryId: 'p4-e1', runId: store.runId }], sessionInputs: [],
      origins: [{ nativeEntryId: 'p4-e1', originSessionId: store.sessionId, originRunId: store.runId }] } });
    expect(store.sessions.loadHistory(store.sessionId)).toEqual({ ok: true, data: history });
    store.db.exec("CREATE TRIGGER reject_duplicate_append BEFORE INSERT ON session_native_entries BEGIN SELECT RAISE(ABORT,'duplicate append'); END;");
    expect(saveTestHistory(store.db, store.historyEvents, store.sessionId, history, context)).toEqual({ ok: true, data: undefined });
    expect(store.db.query('SELECT COUNT(*) AS count FROM session_native_entries').get()).toEqual({ count: 1 });
    expect(() => store.db.query('UPDATE session_native_entries SET run_id=999999').run()).toThrow();
    store.db.exec('DROP TRIGGER reject_duplicate_append;');
    expect(store.runs.finish(store.runId, store.terminal).ok).toBe(true);
    store.db.query('DELETE FROM runs WHERE id=?').run(store.runId);
    expect(store.db.query('SELECT entry_json,run_id FROM session_native_entries').get())
      .toEqual({ entry_json: JSON.stringify(store.entry), run_id: null });
    expect(store.db.query('PRAGMA foreign_key_check').all()).toEqual([]);
    expect(store.sessions.prepareDelete(store.sessionId, store.terminal.endedAt).ok).toBe(true);
    expect(store.sessions.delete(store.sessionId, store.terminal.endedAt)).toEqual({ ok: true, data: 'permanent' });
  }));

  it('rejects foreign, Provider, nonmessage and missing entry bindings without a partial append or old null backfill', () => withDatabase((paths) => {
    const store = nativeFixture(paths);
    const other = store.sessions.create({ nativeSessionId: 'native-p4-other', title: 'Other', at: store.history.header.timestamp });
    expect(other.ok).toBe(true);
    if (!other.ok) return;
    store.db.query(`INSERT INTO runs(id,kind,session_id,scope_json,status,goal,input_json,config_json,cleanup_json,usage_json,error_json,created_at,ended_at)
      VALUES (100,'agent',?,'{}','failed','fixture','{}','{}','{}','{}','{}',?,?)`).run(other.data.sessionId, store.history.header.timestamp, store.history.header.timestamp);
    store.db.query(`INSERT INTO runs(id,kind,status,goal,input_json,config_json,cleanup_json,usage_json,error_json,created_at,ended_at)
      VALUES (101,'provider','failed','fixture','{}','{}','{}','{}','{}',?,?)`).run(store.history.header.timestamp, store.history.header.timestamp);
    const history = { ...store.history, entries: [store.entry], leafId: store.entry.id };
    for (const context of [{ entryId: store.entry.id, runId: 100 }, { entryId: store.entry.id, runId: 101 },
      { entryId: 'missing', runId: store.runId }, { entryId: store.entry.id, runId: 999_999 }]) {
      expect(saveTestHistory(store.db, store.historyEvents, store.sessionId, history, context)).toMatchObject({ ok: false, error: { code: 'state_conflict' } });
      expect(store.sessions.loadHistory(store.sessionId)).toEqual({ ok: true, data: store.history });
    }
    const setting = { ...store.entry, type: 'model_change', provider: 'fixture', modelId: 'fixture' };
    expect(saveTestHistory(store.db, store.historyEvents, store.sessionId, { ...history, entries: [setting] }, { entryId: setting.id, runId: store.runId }).ok).toBe(false);
    expect(saveTestHistory(store.db, store.historyEvents, store.sessionId, history)).toEqual({ ok: true, data: undefined });
    expect(saveTestHistory(store.db, store.historyEvents, store.sessionId, history, { entryId: store.entry.id, runId: store.runId }).ok).toBe(false);
    expect(store.db.query('SELECT run_id FROM session_native_entries').get()).toEqual({ run_id: null });
  }));

  it('rolls back failed message binding with the header count leaf and committed JSON prefix unchanged', () => withDatabase((paths) => {
    const store = nativeFixture(paths);
    const prefix = { ...store.history, entries: [store.entry], leafId: store.entry.id };
    expect(saveTestHistory(store.db, store.historyEvents, store.sessionId, prefix).ok).toBe(true);
    const before = store.db.query('SELECT * FROM session_native_history').get();
    const second = { ...store.entry, id: 'p4-e2', parentId: store.entry.id };
    store.db.exec("CREATE TRIGGER reject_run_binding BEFORE INSERT ON session_native_entries WHEN NEW.run_id IS NOT NULL BEGIN SELECT RAISE(ABORT,'binding failed'); END;");
    expect(saveTestHistory(store.db, store.historyEvents, store.sessionId, { ...prefix, entries: [store.entry, second], leafId: second.id },
      { entryId: second.id, runId: store.runId })).toMatchObject({ ok: false, error: { code: 'storage_write_failed' } });
    expect(store.db.query('SELECT * FROM session_native_history').get()).toEqual(before);
    expect(store.db.query('SELECT entry_id,entry_json,run_id FROM session_native_entries ORDER BY sequence').all())
      .toEqual([{ entry_id: 'p4-e1', entry_json: JSON.stringify(store.entry), run_id: null }]);
  }));

  it('preserves opaque native metadata instead of guessing image content from serialized strings', () => withDatabase((paths) => {
    const store = nativeFixture(paths);
    const entry = { type: 'custom', id: 'sdk-metadata', parentId: null, timestamp: store.history.header.timestamp,
      customType: 'sdk-fixture-metadata', data: { type: 'image', note: 'metadata only' } };
    const history = { ...store.history, entries: [entry], leafId: entry.id };
    expect(saveTestHistory(store.db, store.historyEvents, store.sessionId, history)).toEqual({ ok: true, data: undefined });
    expect(store.sessions.loadHistory(store.sessionId)).toEqual({ ok: true, data: history });
  }));

  it('commits sticky unusable with the Agent terminal or rolls back both facts, and never accepts it for a Provider Run', () => withDatabase((paths) => {
    const store = nativeFixture(paths);
    store.db.exec("CREATE TRIGGER reject_history_block BEFORE UPDATE OF unusable ON session_native_history WHEN NEW.unusable=1 BEGIN SELECT RAISE(ABORT,'history block failed'); END;");
    expect(store.runs.finish(store.runId, { ...store.terminal, nativeHistoryUnusable: true }).ok).toBe(false);
    expect(store.db.query('SELECT status FROM runs WHERE id=?').get(store.runId)).toEqual({ status: 'created' });
    expect(store.sessions.loadHistory(store.sessionId)).toMatchObject({ ok: true, data: { unusable: false } });
    expect(store.db.query('SELECT commit_revision FROM session_native_history').get()).toEqual({ commit_revision: 1 });
    store.db.exec('DROP TRIGGER reject_history_block;');
    expect(store.runs.finish(store.runId, { ...store.terminal, nativeHistoryUnusable: true })).toEqual({ ok: true, data: true });
    expect(store.db.query('SELECT commit_revision FROM session_native_history').get()).toEqual({ commit_revision: 2 });
    expect(saveTestHistory(store.db, store.historyEvents, store.sessionId, store.history).ok).toBe(true);
    expect(store.sessions.loadHistory(store.sessionId)).toMatchObject({ ok: true, data: { unusable: true } });
    const provider = store.runs.create({ goal: runInput.goal, input: runInput, config: baseConfig, usage, cleanup, createdAt: store.terminal.endedAt });
    expect(provider.ok).toBe(true);
    if (!provider.ok) return;
    expect(store.runs.finish(provider.data, { ...store.terminal, nativeHistoryUnusable: true }).ok).toBe(false);
    expect(store.db.query('SELECT status FROM runs WHERE id=?').get(provider.data)).toEqual({ status: 'created' });
  }));

  it('P9 T02 fix1 preserves revision exhaustion storage reason and rolls back Run terminal and P6', () => withDatabase((paths) => {
    const store = nativeFixture(paths);
    store.db.query('UPDATE session_native_history SET commit_revision=?').run(Number.MAX_SAFE_INTEGER);
    const facts = () => ['runs', 'sessions', 'session_native_history', 'session_native_entries', 'session_inputs', 'runtime_events']
      .map(table => store.db.query(`SELECT * FROM ${table}`).all());
    const before = facts(), published: unknown[] = [];
    store.runtimeEventStore.onCommitted(refs => published.push(refs));
    expect(store.runs.finish(store.runId, { ...store.terminal, nativeHistoryUnusable: true }))
      .toMatchObject({ ok: false, error: { code: 'storage_write_failed', category: 'storage', retryable: false,
        message: 'Conversation history commit revision is exhausted. Further changes cannot be saved.' } });
    expect(facts()).toEqual(before);
    expect(published).toEqual([]);
    expect(store.sessions.loadHistory(store.sessionId)).toMatchObject({ ok: true, data: { unusable: false } });
  }));

  it.each(['created', 'running'] as const)('blocks an interrupted %s Agent history on startup without blocking a completed Session', (status) => withDatabase((paths) => {
    const store = nativeFixture(paths);
    const completed = store.sessions.create({ nativeSessionId: 'native-completed', title: 'Complete', at: store.history.header.timestamp,
      nativeHistory: { ...store.history, header: { ...store.history.header, id: 'native-completed' } } });
    expect(completed.ok).toBe(true);
    if (!completed.ok) return;
    store.db.query('UPDATE runs SET status=? WHERE id=?').run(status, store.runId);
    store.close();
    const reopened = openDatabase(paths);
    expect(reopened.ok).toBe(true);
    if (!reopened.ok) return;
    deferCleanup(() => reopened.data.close());
    expect(reopened.data.sessions.loadHistory(store.sessionId)).toMatchObject({ ok: true, data: { unusable: true } });
    expect(reopened.data.sessions.loadHistory(completed.data.sessionId)).toMatchObject({ ok: true, data: { unusable: false } });
    expect(reopened.data.db.query("SELECT COUNT(*) AS count FROM runs WHERE status IN ('created','running')").get()).toEqual({ count: 0 });
  }));

  it('migrates a real new database through version 13 before exposing repositories', () => withDatabase((paths) => {
    const opened = openDatabase(paths);
    expect(opened.ok).toBe(true);
    if (!opened.ok) return;
    expect(opened.data.db.query('SELECT version FROM schema_migrations ORDER BY version').all()).toEqual(Array.from({ length: 19 }, (_, index) => ({ version: index + 1 })));
    expect(opened.data.db.query('PRAGMA foreign_key_check').all()).toEqual([]);
    opened.data.close();
  }));

  it('migrates version 7 without guessing old entry ownership and preserves native JSON', () => withDatabase((paths) => {
    const legacy = createLegacyV7(paths);
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
    expect(migrated.data.db.query('SELECT MAX(version) AS version FROM schema_migrations').get()).toEqual({ version: 19 });
      expect(migrated.data.db.query('SELECT entry_json,run_id FROM session_native_entries').get()).toEqual({ entry_json: entry, run_id: null });
      expect(migrated.data.db.query('SELECT header_json,storage_version,leaf_id,entry_count FROM session_native_history').get())
        .toEqual({ header_json: header, storage_version: 1, leaf_id: 'old-e1', entry_count: 1 });
      expect(migrated.data.db.query('PRAGMA foreign_key_check').all()).toEqual([]);
    } finally { migrated.data.close(); }
  }));

  it('rolls back the new column when migration 008 cannot commit its version marker', () => withDatabase((paths) => {
    const legacy = createLegacyV7(paths);
    const before = legacy.query(`SELECT ${legacyColumns} FROM runs ORDER BY id`).all();
    legacy.exec("CREATE TRIGGER reject_schema_8 BEFORE INSERT ON schema_migrations WHEN NEW.version=8 BEGIN SELECT RAISE(ABORT,'version marker failed'); END;");
    legacy.close();
    expect(openDatabase(paths)).toMatchObject({ ok: false, error: { code: 'storage_open_failed' } });
    const after = new Database(paths.databaseFile);
    try {
      expect(after.query('SELECT MAX(version) AS version FROM schema_migrations').get()).toEqual({ version: 7 });
      expect((after.query('PRAGMA table_info(session_native_entries)').all() as Array<{ name: string }>).map((column) => column.name)).not.toContain('run_id');
      expect(after.query(`SELECT ${legacyColumns} FROM runs ORDER BY id`).all()).toEqual(before);
      expect(after.query('PRAGMA foreign_key_check').all()).toEqual([]);
    } finally { after.close(); }
  }));

  it('rejects inconsistent persisted Run ownership rather than displaying or restoring guessed facts', () => withDatabase((paths) => {
    const store = nativeFixture(paths, true);
    const history = { ...store.history, entries: [store.entry], leafId: store.entry.id };
    expect(saveTestHistory(store.db, store.historyEvents, store.sessionId, history, { entryId: store.entry.id, runId: store.runId }).ok).toBe(true);
    const other = store.sessions.create({ nativeSessionId: 'native-corrupt-other', title: 'Other', at: store.history.header.timestamp });
    expect(other.ok).toBe(true);
    if (!other.ok) return;
    store.db.query('UPDATE runs SET session_id=? WHERE id=?').run(other.data.sessionId, store.runId);
    expect(store.sessions.readHistoryForDisplay(store.sessionId)).toMatchObject({ ok: false, error: { code: 'context_binding_unknown' } });
    expect(store.sessions.loadHistory(store.sessionId)).toMatchObject({ ok: false, error: { code: 'session_history_invalid' } });
    expect(store.sessions.get(store.sessionId)).toMatchObject({ ok: true, data: { historyState: 'invalid' } });
    expect(store.db.query('SELECT entry_json,run_id FROM session_native_entries').get()).toEqual({ entry_json: JSON.stringify(store.entry), run_id: store.runId });
  }));

  it('rolls back startup history blocking when interrupted Run repair fails, then blocks on the next successful startup', () => withDatabase((paths) => {
    const store = nativeFixture(paths, true);
    expect(store.runs.finish(store.runId, { ...store.terminal, nativeHistoryUnusable: true }).ok).toBe(true);
    store.db.query('UPDATE session_native_history SET unusable=0').run();
    store.db.query("UPDATE runs SET status='running',ended_at=NULL,error_json=NULL WHERE id=?").run(store.runId);
    store.db.exec("CREATE TRIGGER reject_interruption BEFORE UPDATE ON runs WHEN NEW.status='failed' BEGIN SELECT RAISE(ABORT,'interrupted repair failed'); END;");
    store.close();
    expect(openDatabase(paths)).toMatchObject({ ok: false, error: { code: 'storage_open_failed' } });
    const unrecovered = new Database(paths.databaseFile);
    expect(unrecovered.query('SELECT status FROM runs WHERE id=?').get(store.runId)).toEqual({ status: 'running' });
    expect(unrecovered.query('SELECT unusable FROM session_native_history').get()).toEqual({ unusable: 0 });
    unrecovered.exec('DROP TRIGGER reject_interruption;');
    unrecovered.close();
    const recovered = openDatabase(paths);
    expect(recovered.ok).toBe(true);
    if (!recovered.ok) return;
    deferCleanup(() => recovered.data.close());
    expect(recovered.data.db.query('SELECT status FROM runs WHERE id=?').get(store.runId)).toEqual({ status: 'failed' });
    expect(recovered.data.sessions.loadHistory(store.sessionId)).toMatchObject({ ok: true, data: { unusable: true } });
    expect(recovered.data.db.query('PRAGMA foreign_key_check').all()).toEqual([]);
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
      message: { role: 'user', content: [{ type: 'text', text: 'hello' }], timestamp: 1 } };
    expect(saveTestHistory(first.data.db, first.data.runtimeEventStore, sessionId, { storageVersion: 1, header, entries: [entry], leafId: entry.id, unusable: false }).ok).toBe(true);
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
