import { InMemoryCredentialStore } from '@earendil-works/pi-ai';
import { PiAgentAdapter } from '../../../packages/runtime-pi/src/session.ts';
import { openDatabase } from '../../../packages/core/src/storage/database.ts';
import { SessionService, ensureNativeSession } from '../../../packages/core/src/sessions/service.ts';
import type { NativeSessionEntry } from '@flowmate/contracts';
import { appError, fail, INVOICE_TOOLS_SYSTEM_PROMPT } from '@flowmate/contracts';
import { expect, it, spyOn } from 'bun:test';
import { Database, type SQLQueryBindings, type Statement } from 'bun:sqlite';
import { readFileSync, readdirSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import * as core from '../../../packages/core/src/storage/database.ts';
import type { HistoryCommitInput, MemoryStore, NativeSessionHistory, Result } from '@flowmate/contracts';
import { deferCleanup, mkdtempSync } from '../../support/resources.ts';
import { nativeAssistantFacts } from '../../support/history.ts';

const at = '2026-10-04T00:00:00.000Z';
function need<T>(result: Result<T>): T { if (!result.ok) throw new Error(result.error.code); return result.data; }
function paths() {
  const root = mkdtempSync(join(tmpdir(), 'flowmate-p9-memory-'));
  return { root, databaseFile: join(root, 'data', 'test.sqlite'), logsDir: join(root, 'logs'),
    artifactsDir: join(root, 'artifacts'), outputsDir: join(root, 'outputs'), runtimeDir: join(root, 'runtime') };
}

function fixture(legacy = false) {
  const p = paths(), store = need(core.openDatabase(p));
  deferCleanup(() => store.close());
  const history: NativeSessionHistory = { storageVersion: 1, header: { type: 'session', version: 3, id: 'p9-native', timestamp: at, cwd: p.root },
    entries: [], leafId: null, unusable: false };
  const session = need(store.sessions.create({ nativeSessionId: history.header.id, title: 'P9', at, ...(legacy ? {} : { nativeHistory: history }) }));
  const memory = Reflect.get(store, 'memory') as Pick<MemoryStore, 'load' | 'commit'>;
  expect(memory).toBeDefined();
  const load = () => need(memory.load(session.sessionId))!;
  const commit = (change: Partial<HistoryCommitInput> = {}) => memory.commit({ sessionId: session.sessionId,
    expected: load().commit, header: history.header, appendEntries: [], leafId: load().history.leafId,
    unusable: false, contexts: [], ...change });
  return { p, store, history, session, memory, load, commit };
}
const entry = (id: string, parentId: string | null = null) => ({ type: 'message', id, parentId, timestamp: at,
  message: { role: 'user', content: id, timestamp: 1 } });

it('P9 T02 commits revision once and rejects ABA and stale writers', () => {
  const f = fixture();
  expect(f.load().commit).toEqual({ commitRevision: 1, entryCount: 0, leafId: null });
  expect(need(f.commit())).toEqual({ commitRevision: 1, entryCount: 0, leafId: null });
  const first = need(f.commit({ appendEntries: [entry('a'), entry('b', 'a')], leafId: 'a' }));
  expect(first).toEqual({ commitRevision: 2, entryCount: 2, leafId: 'a' });
  expect(need(f.commit({ leafId: 'b' })).commitRevision).toBe(3);
  expect(need(f.commit({ leafId: 'a' })).commitRevision).toBe(4);
  expect(f.commit({ expected: first, leafId: 'b' })).toMatchObject({ ok: false, error: { code: 'state_conflict' } });
  expect(need(f.commit({ leafId: null, unusable: true })).commitRevision).toBe(5);
  expect(f.load().commit.leafId).toBeNull();
  expect(need(f.commit({ unusable: false })).commitRevision).toBe(5);
  expect(f.load().history.unusable).toBe(true);
  f.store.db.query('UPDATE session_native_history SET commit_revision=?').run(Number.MAX_SAFE_INTEGER);
  expect(need(f.commit()).commitRevision).toBe(Number.MAX_SAFE_INTEGER);
  expect(f.commit({ leafId: 'a' })).toMatchObject({ ok: false, error: { code: 'storage_write_failed', category: 'storage',
    message: 'Conversation history commit revision is exhausted. Further changes cannot be saved.', retryable: false } });
  expect(f.load().commit.commitRevision).toBe(Number.MAX_SAFE_INTEGER);
  expect(f.commit({ expected: null })).toMatchObject({ ok: false, error: { code: 'state_conflict' } });
});

function agentInput(f: ReturnType<typeof fixture>, runId?: number, sequence = 1) {
  const db = f.store.db;
  runId ??= Number(db.query(`INSERT INTO runs(kind,session_id,scope_json,status,goal,input_json,config_json,cleanup_json,usage_json,created_at)
    VALUES('agent',?,'{}','running','fixture','{}','{}','{}','{}',?)`).run(f.session.sessionId, at).lastInsertRowid);
  const inputId = Number(db.query(`INSERT INTO session_inputs(session_id,client_sequence,mode,goal_mode,request_identity_json,run_id,content_json,status,processing_status,created_at,updated_at)
    VALUES(?,?,'prompt','answer',?,?,'{"version":2,"text":"a","promptText":"a","workspaceContext":null,"workspaceInput":null,"allowedDocumentIds":[],"allowedArtifactIds":[]}','queued','pending',?,?)`)
    .run(f.session.sessionId, sequence, '{}', runId, at, at).lastInsertRowid);
  return { runId, inputId };
}
function persistenceFacts(f: ReturnType<typeof fixture>) {
  return ['session_native_history', 'session_native_entries', 'session_inputs', 'runtime_events'].map(table => f.store.db.query(`SELECT * FROM ${table}`).all());
}
const assistant = () => ({ type: 'message', id: 'b', parentId: 'a', timestamp: at,
  message: { ...nativeAssistantFacts, role: 'assistant', content: [{ type: 'text', text: 'Saved.' }], stopReason: 'stop', timestamp: 2 } });

it('P9 T02 fix1 rejects late assistant result membership without rewriting SQL receipt P6 or notifications', () => {
  const f = fixture(), { runId, inputId } = agentInput(f), b = assistant();
  const receipt = need(f.commit({ appendEntries: [entry('a'), b], leafId: 'b', contexts: [
    { entryId: 'a', runId, inputId }, { entryId: 'b', runId } ] }));
  expect(f.store.db.query('SELECT native_entry_id,result_entry_id FROM session_inputs').get()).toEqual({ native_entry_id: 'a', result_entry_id: null });
  const before = persistenceFacts(f), published: unknown[] = [];
  f.store.runtimeEventStore.onCommitted(refs => published.push(refs));
  expect(f.commit({ expected: receipt, appendEntries: [b], contexts: [{ entryId: 'b', runId, resultInputIds: [inputId] }] }))
    .toMatchObject({ ok: false, error: { code: 'state_conflict' } });
  expect(persistenceFacts(f)).toEqual(before);
  expect(f.load().commit).toEqual(receipt);
  expect(published).toEqual([]);
});

it('P9 T02 fix1 rejects late user Input identity and confirms only complete original associations', () => {
  const f = fixture(), db = f.store.db;
  const runId = Number(db.query(`INSERT INTO runs(kind,session_id,scope_json,status,goal,input_json,config_json,cleanup_json,usage_json,created_at)
    VALUES('agent',?,'{}','running','fixture','{}','{}','{}','{}',?)`).run(f.session.sessionId, at).lastInsertRowid);
  const receipt = need(f.commit({ appendEntries: [entry('a')], leafId: 'a', contexts: [{ entryId: 'a', runId }] }));
  const { inputId } = agentInput(f, runId);
  const before = persistenceFacts(f), published: unknown[] = [];
  f.store.runtimeEventStore.onCommitted(refs => published.push(refs));
  expect(f.commit({ expected: receipt, appendEntries: [entry('a')], contexts: [{ entryId: 'a', runId, inputId }] }))
    .toMatchObject({ ok: false, error: { code: 'state_conflict' } });
  expect(persistenceFacts(f)).toEqual(before);
  expect(f.load().commit).toEqual(receipt);
  expect(published).toEqual([]);

  const exact = fixture(), original = agentInput(exact), b = assistant();
  const contexts = [{ entryId: 'b', runId: original.runId, resultInputIds: [original.inputId] },
    { entryId: 'a', runId: original.runId, inputId: original.inputId }];
  const exactReceipt = need(exact.commit({ appendEntries: [entry('a'), b], leafId: 'b', contexts }));
  const other = agentInput(exact, original.runId, 2);
  const exactFacts = persistenceFacts(exact), exactPublished: unknown[] = [];
  exact.store.runtimeEventStore.onCommitted(refs => exactPublished.push(refs));
  expect(need(exact.commit({ expected: exactReceipt, appendEntries: [entry('a'), b], contexts }))).toEqual(exactReceipt);
  expect(persistenceFacts(exact)).toEqual(exactFacts);
  expect(exactPublished).toEqual([]);
  for (const changed of [
    [{ entryId: 'b', runId: original.runId }],
    [{ entryId: 'b', runId: original.runId, resultInputIds: [other.inputId] }],
    [{ entryId: 'b', runId: original.runId, resultInputIds: [original.inputId, other.inputId] }],
    [{ entryId: 'a', runId: original.runId, inputId: other.inputId }],
  ]) {
    expect(exact.commit({ expected: exactReceipt, contexts: changed })).toMatchObject({ ok: false, error: { code: 'state_conflict' } });
    expect(persistenceFacts(exact)).toEqual(exactFacts);
    expect(exact.load().commit).toEqual(exactReceipt);
    expect(exactPublished).toEqual([]);
  }
});

it.each(['active-run', 'completed-input'] as const)('P9 T02 fix1 reports exhausted sticky revision and rolls back %s recovery', recovery => {
  const f = fixture(), { runId } = agentInput(f), db = f.store.db;
  if (recovery === 'completed-input') db.query("UPDATE runs SET status='completed',ended_at=?,stopped_at=?,output_json='{}' WHERE id=?").run(at, at, runId);
  db.query('UPDATE session_native_history SET commit_revision=?').run(Number.MAX_SAFE_INTEGER);
  const before = persistenceFacts(f), runs = db.query('SELECT * FROM runs').all(), published: unknown[] = [];
  f.store.runtimeEventStore.onCommitted(refs => published.push(refs));
  expect(f.store.runs.failInterrupted(at)).toMatchObject({ ok: false, error: { code: 'storage_write_failed', category: 'storage',
    message: 'Conversation history commit revision is exhausted. Further changes cannot be saved.', retryable: false } });
  expect(persistenceFacts(f)).toEqual(before);
  expect(db.query('SELECT * FROM runs').all()).toEqual(runs);
  expect(published).toEqual([]);
  expect(f.load().commit.commitRevision).toBe(Number.MAX_SAFE_INTEGER);
  expect(need(f.commit()).commitRevision).toBe(Number.MAX_SAFE_INTEGER);
  expect(db.query('SELECT status FROM runs WHERE id=?').get(runId)).toEqual({ status: recovery === 'active-run' ? 'running' : 'completed' });
});

it('P9 T02 rejects conflicting entries without changing the committed prefix', () => {
  const f = fixture(), a = entry('a');
  need(f.commit({ appendEntries: [a], leafId: 'a' }));
  const before = f.store.db.query('SELECT * FROM session_native_entries').all();
  expect(need(f.commit({ appendEntries: [{ message: a.message, timestamp: at, parentId: null, id: 'a', type: 'message' }] })).commitRevision).toBe(2);
  for (const appendEntries of [[{ ...a, message: { ...a.message, content: 'changed' } }], [entry('b'), { ...a, parentId: 'b' }],
    [entry('b', 'missing')], [{ ...a, type: 'future' }], [{ type: 'label', id: 'label', parentId: 'a', timestamp: at, targetId: 'missing' }]]) {
    expect(f.commit({ appendEntries }).ok).toBe(false);
    expect(f.store.db.query('SELECT * FROM session_native_entries').all()).toEqual(before);
    expect(f.load().commit.commitRevision).toBe(2);
  }
  expect(f.commit({ header: { ...f.history.header, cwd: 'changed' } }).ok).toBe(false);
  const runId = Number(f.store.db.query(`INSERT INTO runs(kind,session_id,scope_json,status,goal,input_json,config_json,cleanup_json,usage_json,created_at)
    VALUES('agent',?,'{}','created','fixture','{}','{}','{}','{}',?)`).run(f.session.sessionId, at).lastInsertRowid);
  expect(f.commit({ appendEntries: [a], contexts: [{ entryId: 'a', runId }] }).ok).toBe(false);
  expect(f.store.db.query('SELECT run_id FROM session_native_entries').get()).toEqual({ run_id: null });
});

it('P9 T02 stores all native kinds and roles without rewriting JSON or requiring finished tool pairs', () => {
  const f = fixture();
  const base = (id: string) => ({ id, parentId: 'a', timestamp: at });
  const entries = [entry('a'),
    { ...base('assistant'), type: 'message', message: { ...nativeAssistantFacts, role: 'assistant', timestamp: 2, stopReason: 'toolUse',
      content: [{ type: 'toolCall', id: 'call', name: 'fixture', arguments: { opaque: ['中文', null] } }] } },
    { ...base('tool'), type: 'message', message: { role: 'toolResult', toolCallId: 'call', toolName: 'fixture', timestamp: 3, isError: false,
      content: [{ type: 'image', mimeType: 'image/png', data: 'opaque-original' }], details: { extra: 1 } } },
    { ...base('bash'), type: 'message', message: { role: 'bashExecution', command: 'fixture', output: '中文😀', cancelled: false, truncated: false, timestamp: 4 } },
    { ...base('message-custom'), type: 'message', message: { role: 'custom', customType: 'fixture', content: 'custom', display: true, timestamp: 5 } },
    { ...base('message-branch'), type: 'message', message: { role: 'branchSummary', summary: 'summary', fromId: 'a', timestamp: 6 } },
    { ...base('message-compaction'), type: 'message', message: { role: 'compactionSummary', summary: 'compact', tokensBefore: 10, timestamp: 7 } },
    { ...base('model'), type: 'model_change', provider: 'fixture', modelId: 'fixture' },
    { ...base('thinking'), type: 'thinking_level_change', thinkingLevel: 'off' },
    { ...base('compact'), type: 'compaction', summary: 'summary', firstKeptEntryId: 'a', tokensBefore: 10 },
    { ...base('branch'), type: 'branch_summary', summary: 'summary', fromId: 'root' },
    { ...base('custom'), type: 'custom', customType: 'fixture', data: { original: '中文😀', nullable: null } },
    { ...base('custom-message'), type: 'custom_message', customType: 'fixture', display: true, content: [{ type: 'image', mimeType: 'image/png', data: 'original' }] },
    { ...base('label'), type: 'label', targetId: 'a', label: 'label' },
    { ...base('info'), type: 'session_info', name: 'name' } ];
  expect(need(f.commit({ appendEntries: entries, leafId: 'assistant', unusable: true }))).toEqual({ commitRevision: 2, entryCount: 15, leafId: 'assistant' });
  expect(f.load().history.entries).toEqual(entries);
  expect(f.store.db.query('SELECT entry_json FROM session_native_entries ORDER BY sequence').all()).toEqual(entries.map(entry => ({ entry_json: JSON.stringify(entry) })));
  const before = f.store.db.query('SELECT * FROM session_native_history').all();
  for (const data of [Number.NaN, Number.POSITIVE_INFINITY, () => 'value']) {
    expect(f.commit({ appendEntries: [{ ...base('bad'), type: 'custom', customType: 'fixture', data }] }).ok).toBe(false);
    expect(f.store.db.query('SELECT * FROM session_native_history').all()).toEqual(before);
  }
});

it('P9 T02 rolls back history input and P6 when CAS or an input write fails', () => {
  const f = fixture();
  const db = f.store.db;
  const runId = Number(db.query(`INSERT INTO runs(kind,session_id,scope_json,status,goal,input_json,config_json,cleanup_json,usage_json,created_at)
    VALUES('agent',?,'{}','running','fixture','{}','{}','{}','{}',?)`).run(f.session.sessionId, at).lastInsertRowid);
  const inputId = Number(db.query(`INSERT INTO session_inputs(session_id,client_sequence,mode,goal_mode,request_identity_json,run_id,content_json,status,processing_status,created_at,updated_at)
    VALUES(?,1,'prompt','answer',?,?,'{"version":2,"text":"a","promptText":"a","workspaceContext":null,"workspaceInput":null,"allowedDocumentIds":[],"allowedArtifactIds":[]}','queued','pending',?,?)`)
    .run(f.session.sessionId, '{}', runId, at, at).lastInsertRowid);
  const published: unknown[] = [];
  f.store.runtimeEventStore.onCommitted(refs => { expect(db.inTransaction).toBe(false); published.push(refs); });
  const before = db.query('SELECT * FROM session_inputs').all();
  const change = { appendEntries: [entry('a')], leafId: 'a', contexts: [{ entryId: 'a', runId, inputId }] };
  for (const [trigger, code] of [
    ["CREATE TRIGGER reject_cas BEFORE UPDATE ON session_native_history BEGIN SELECT RAISE(IGNORE); END", 'state_conflict'],
    ["CREATE TRIGGER reject_input BEFORE UPDATE ON session_inputs BEGIN SELECT RAISE(ABORT,'input failed'); END", 'storage_write_failed'],
    ["CREATE TRIGGER ignore_input BEFORE UPDATE ON session_inputs BEGIN SELECT RAISE(IGNORE); END", 'state_conflict'],
    ["CREATE TRIGGER reject_event BEFORE INSERT ON runtime_events BEGIN SELECT RAISE(ABORT,'event failed'); END", 'storage_write_failed'],
  ]) {
    db.exec(trigger!);
    expect(f.commit(change)).toMatchObject({ ok: false, error: { code } });
    expect(db.query('SELECT * FROM session_inputs').all()).toEqual(before);
    expect(db.query('SELECT * FROM session_native_entries').all()).toEqual([]);
    expect(db.query('SELECT * FROM runtime_events').all()).toEqual([]);
    expect(published).toEqual([]);
    expect(f.load().commit.commitRevision).toBe(1);
    db.exec(`DROP TRIGGER ${trigger!.match(/CREATE TRIGGER (\w+)/)![1]}`);
  }
  expect(need(f.commit(change))).toEqual({ commitRevision: 2, entryCount: 1, leafId: 'a' });
  expect(db.query('SELECT status,native_entry_id FROM session_inputs').get()).toEqual({ status: 'consumed', native_entry_id: 'a' });
  expect(db.query('SELECT type FROM runtime_events').all()).toEqual([{ type: 'input_state_changed' }]);
  expect(published.length).toBe(1);
});

it('P9 T02 blocks every old recovery path in its original transaction', () => {
  const f = fixture(), db = f.store.db;
  db.query(`INSERT INTO runs(kind,session_id,scope_json,status,goal,input_json,config_json,cleanup_json,usage_json,created_at)
    VALUES('agent',?,'{}','running','fixture','{}','{}','{}','{}',?)`).run(f.session.sessionId, at);
  const before = db.query('SELECT * FROM runs').all();
  db.exec("CREATE TRIGGER reject_block BEFORE UPDATE OF unusable ON session_native_history BEGIN SELECT RAISE(IGNORE); END");
  expect(f.store.runs.failInterrupted(at)).toMatchObject({ ok: false, error: { code: 'state_conflict' } });
  expect(db.query('SELECT * FROM runs').all()).toEqual(before);
  expect(f.load().commit.commitRevision).toBe(1);
  db.exec('DROP TRIGGER reject_block');
  expect(f.store.runs.failInterrupted(at).ok).toBe(true);
  expect(f.load().commit.commitRevision).toBe(2);
  expect(f.load().history.unusable).toBe(true);
  expect(f.store.runs.failInterrupted(at).ok).toBe(true);
  expect(f.load().commit.commitRevision).toBe(2);
  const legacy = need(f.store.sessions.create({ nativeSessionId: 'legacy', title: 'Legacy', at }));
  db.query(`INSERT INTO runs(kind,session_id,scope_json,status,goal,input_json,config_json,cleanup_json,usage_json,created_at)
    VALUES('agent',?,'{}','running','fixture','{}','{}','{}','{}',?)`).run(legacy.sessionId, at);
  expect(f.store.runs.failInterrupted(at).ok).toBe(true);
  expect(need(f.memory.load(legacy.sessionId))).toBeNull();
});

it.each(['completed', 'pending'] as const)('P9 T02 revises %s input recovery blockers once and rolls back P6 with blocked persistence', processing => {
  const f = fixture(), db = f.store.db;
  const runId = Number(db.query(`INSERT INTO runs(kind,session_id,scope_json,status,goal,input_json,config_json,cleanup_json,usage_json,created_at)
    VALUES('agent',?,'{}','running','fixture','{}','{}','{"stopped":true}','{}',?)`).run(f.session.sessionId, at).lastInsertRowid);
  const inputId = Number(db.query(`INSERT INTO session_inputs(session_id,client_sequence,mode,goal_mode,request_identity_json,run_id,content_json,status,processing_status,created_at,updated_at)
    VALUES(?,1,'prompt','answer',?,?,'{"version":2,"text":"a","promptText":"a","workspaceContext":null,"workspaceInput":null,"allowedDocumentIds":[],"allowedArtifactIds":[]}','queued','pending',?,?)`)
    .run(f.session.sessionId, '{}', runId, at, at).lastInsertRowid);
  const result = { type: 'message', id: 'result', parentId: 'a', timestamp: at,
    message: { ...nativeAssistantFacts, role: 'assistant', content: [{ type: 'text', text: 'Saved.' }], stopReason: 'stop', timestamp: 2 } };
  expect(need(f.commit({ appendEntries: [entry('a'), result], leafId: 'result', contexts: [
    { entryId: 'result', runId, resultInputIds: [inputId] }, { entryId: 'a', runId, inputId } ] })).commitRevision).toBe(2);
  db.query("UPDATE runs SET status='completed',ended_at=?,stopped_at=?,output_json='{}' WHERE id=?").run(at, at, runId);
  db.query('UPDATE session_inputs SET processing_status=? WHERE id=?').run(processing, inputId);
  const before = db.query('SELECT * FROM session_inputs').all(), events = db.query('SELECT * FROM runtime_events').all();
  const published: unknown[] = [];
  f.store.runtimeEventStore.onCommitted(refs => published.push(refs));
  db.exec("CREATE TRIGGER reject_input_block BEFORE UPDATE OF unusable ON session_native_history BEGIN SELECT RAISE(IGNORE); END");
  expect(f.store.runs.failInterrupted(at)).toMatchObject({ ok: false, error: { code: 'state_conflict' } });
  expect(db.query('SELECT * FROM session_inputs').all()).toEqual(before);
  expect(db.query('SELECT * FROM runtime_events').all()).toEqual(events);
  expect(published).toEqual([]);
  expect(f.load().commit.commitRevision).toBe(2);
  db.exec('DROP TRIGGER reject_input_block');
  expect(f.store.runs.failInterrupted(at).ok).toBe(true);
  expect(f.load().history.unusable).toBe(true);
  expect(f.load().commit.commitRevision).toBe(3);
  expect(f.store.runs.failInterrupted(at).ok).toBe(true);
  expect(f.load().commit.commitRevision).toBe(3);
  expect(f.load().history.entries).toEqual([entry('a'), result]);
});

it('P9 T02 protects fork provenance and permits only deletion tombstones', () => {
  const f = fixture(), db = f.store.db;
  const target = need(f.store.sessions.create({ nativeSessionId: 'target', title: 'Target', at }));
  const otherTarget = need(f.store.sessions.create({ nativeSessionId: 'target2', title: 'Target2', at }));
  db.query(`INSERT INTO session_forks VALUES(?,?,1,1,NULL,'entry',1,'operation','{}',?)`).run(target.sessionId, f.session.sessionId, at);
  expect(() => db.query(`INSERT INTO session_forks VALUES(?,?,1,1,NULL,'entry',1,'another','{}',?)`).run(target.sessionId, f.session.sessionId, at)).toThrow();
  expect(() => db.query(`INSERT INTO session_forks VALUES(?,?,1,1,NULL,'entry',1,'operation','{}',?)`).run(otherTarget.sessionId, f.session.sessionId, at)).toThrow();
  expect(() => db.query(`INSERT INTO session_forks VALUES(?,?,1.5,1,NULL,'entry',1,'bad-revision','{}',?)`).run(otherTarget.sessionId, f.session.sessionId, at)).toThrow();
  expect(() => db.query(`INSERT INTO session_forks VALUES(?,?,1,1,NULL,'entry',0,'bad-count','{}',?)`).run(otherTarget.sessionId, f.session.sessionId, at)).toThrow();
  expect(() => db.query(`INSERT INTO session_forks VALUES(?,?,1,1,NULL,'entry',1,'self','{}',?)`).run(f.session.sessionId, f.session.sessionId, at)).toThrow();
  expect(() => db.query('UPDATE session_forks SET target_session_id=NULL').run()).toThrow();
  for (const [field, value] of [['source_commit_revision', '2'], ['source_entry_count', '2'], ['source_leaf_id', "'leaf'"],
    ['selected_entry_id', "'other'"], ['inherited_entry_count', '2'], ['client_operation_id', "'other'"], ['request_json', "'{\"changed\":true}'"], ['created_at', "'other'"]])
    expect(() => db.exec(`UPDATE session_forks SET ${field}=${value}`)).toThrow();
  expect(() => db.query('DELETE FROM sessions WHERE id=?').run(f.session.sessionId)).toThrow();
  need(f.store.sessions.prepareDelete(f.session.sessionId, at));
  expect(f.store.sessions.delete(f.session.sessionId, at)).toEqual({ ok: true, data: 'hidden' });
  expect(need(f.store.sessions.get(f.session.sessionId)).hasBusinessHistory).toBe(false);
  need(f.store.sessions.prepareDelete(target.sessionId, at));
  expect(f.store.sessions.delete(target.sessionId, at)).toEqual({ ok: true, data: 'permanent' });
  expect(db.query('SELECT target_session_id FROM session_forks').get()).toEqual({ target_session_id: null });
  db.query(`INSERT INTO session_forks VALUES(?,?,1,1,NULL,'entry',1,'operation2','{}',?)`).run(otherTarget.sessionId, f.session.sessionId, at);
  need(f.store.sessions.prepareDelete(f.session.sessionId, at));
  expect(f.store.sessions.delete(f.session.sessionId, at)).toEqual({ ok: true, data: 'hidden' });
  need(f.store.sessions.prepareDelete(otherTarget.sessionId, at));
  expect(f.store.sessions.delete(otherTarget.sessionId, at)).toEqual({ ok: true, data: 'permanent' });
  expect(db.query('SELECT target_session_id FROM session_forks').all()).toEqual([{ target_session_id: null }, { target_session_id: null }]);
  expect(() => db.query(`INSERT INTO session_forks VALUES(NULL,?,1,1,NULL,'entry',1,'bad','{}',?)`).run(f.session.sessionId, at)).toThrow();
  // Retry rechecks an already-hidden source after its last live target was deleted.
  need(f.store.sessions.prepareDelete(f.session.sessionId, at));
  expect(f.store.sessions.delete(f.session.sessionId, at)).toEqual({ ok: true, data: 'permanent' });
  expect(db.query('SELECT * FROM session_forks').all()).toEqual([]);
  expect(db.query('PRAGMA foreign_key_check').all()).toEqual([]);
});

function seed015(p: ReturnType<typeof paths>) {
  mkdirSync(join(p.root, 'data'), { recursive: true });
  const db = new Database(p.databaseFile, { create: true });
  deferCleanup(() => db.close());
  db.exec('PRAGMA foreign_keys=ON');
  const dir = new URL('../../../packages/core/src/storage/migrations/', import.meta.url);
  for (const file of readdirSync(dir).filter(name => /^0(0[1-9]|1[0-5])_/.test(name)).sort()) {
    const version = Number(file.slice(0, 3)), sql = readFileSync(new URL(file, dir), 'utf8');
    if (version === 15) for (const part of sql.split(/^\s*-- statement\s*$/m).filter(part => part.trim())) db.exec(part);
    else if ([4, 8, 9, 10, 11, 12, 13, 14].includes(version)) for (const part of sql.split(';').filter(part => part.trim())) db.exec(part);
    else db.exec(sql);
    if ([4, 10, 11, 14, 15].includes(version)) db.exec('COMMIT');
    db.exec('PRAGMA foreign_keys=ON');
  }
  const header = '{ "type":"session", "version":3,"id":"old","timestamp":"2026-10-04T00:00:00.000Z","cwd":"old" }';
  db.query("INSERT INTO sessions(id,native_session_id,title,created_at,updated_at) VALUES(1,'old','Old',?,?)").run(at, at);
  db.query('INSERT INTO session_native_history(session_id,storage_version,header_json,leaf_id,entry_count,unusable) VALUES(1,1,?,NULL,1,0)').run(header);
  db.query('INSERT INTO session_native_entries VALUES(1,0,\'old-entry\',?,NULL)').run(JSON.stringify(entry('old-entry')));
  db.query(`INSERT INTO runs(id,kind,session_id,scope_json,status,goal,input_json,config_json,cleanup_json,usage_json,created_at,ended_at,error_json,context_observations_json)
    VALUES(1,'agent',1,'{}','failed','old','{ "old":"input" }','{}','{"stopped":true}','{}',?,?,'{}','{ "version":1,"old":"journal" }')`).run(at, at);
  db.query("INSERT INTO context_snapshots(id,session_id,run_id,sequence,snapshot_json,created_at) VALUES(1,1,1,1,'{ \"old\":\"snapshot\" }',?)").run(at);
  db.query(`INSERT INTO session_inputs(session_id,client_sequence,mode,goal_mode,request_hash,run_id,content_json,status,processing_status,created_at,updated_at,context_snapshot_id)
    VALUES(1,1,'prompt','answer',?,1,'{ "version":1,"old":"input" }','failed','failed',?,?,1)`).run('a'.repeat(64), at, at);
  const facts = () => ['session_native_entries', 'session_inputs', 'context_snapshots', 'runs'].map(table => db.query(`SELECT * FROM ${table}`).all());
  const original = facts(), oldHeader = db.query('SELECT header_json,leaf_id,entry_count,unusable FROM session_native_history').all();
  db.close();
  return { original, oldHeader };
}
it('P9 T02 migrates 015 atomically without rewriting original facts', () => {
  const failures = ['BEGIN IMMEDIATE', 'ALTER TABLE session_native_history', 'CREATE TABLE session_forks', 'CREATE INDEX session_forks_source',
    'CREATE TRIGGER session_forks_initial_target', 'CREATE TRIGGER session_forks_immutable', 'INSERT INTO schema_migrations(version,applied_at) VALUES(16', 'FK', 'COMMIT'];
  for (const failure of failures) {
    const p = paths(), before = seed015(p);
    const originalExec = Database.prototype.exec, originalQuery = Database.prototype.query;
    let in016 = false, fired = false;
    const exec = spyOn(Database.prototype, 'exec').mockImplementation(function(this: Database, sql: string) {
      if (sql.trim() === 'BEGIN IMMEDIATE;' || sql.includes('ALTER TABLE session_native_history ADD COLUMN commit_revision')) in016 = true;
      if (in016 && (sql.includes(failure) || failure === 'COMMIT' && sql === 'COMMIT')) { fired = true; throw new Error('injected'); }
      return originalExec.call(this, sql);
    });
    const query = spyOn(Database.prototype, 'query').mockImplementation(function<R, P extends SQLQueryBindings | SQLQueryBindings[]>(this: Database, sql: string): Statement<R, P extends any[] ? P : [P]> {
      if (in016 && failure === 'FK' && sql === 'PRAGMA foreign_key_check') { fired = true; throw new Error('injected-fk'); }
      return originalQuery.call(this, sql) as Statement<R, P extends any[] ? P : [P]>;
    });
    try { const opened = core.openDatabase(p); if (opened.ok) opened.data.close(); expect(opened.ok).toBe(false); expect(fired).toBe(true); }
    finally { exec.mockRestore(); query.mockRestore(); }
    const db = new Database(p.databaseFile);
    try {
      expect(db.query('SELECT MAX(version) AS version FROM schema_migrations').get()).toEqual({ version: 15 });
      expect(db.query("SELECT name FROM sqlite_master WHERE name='session_forks'").get()).toBeNull();
      expect(db.query('PRAGMA table_info(session_native_history)').all().some(row => (row as { name: string }).name === 'commit_revision')).toBe(false);
      expect(['session_native_entries', 'session_inputs', 'context_snapshots', 'runs'].map(table => db.query(`SELECT * FROM ${table}`).all())).toEqual(before.original);
      expect(db.query('SELECT header_json,leaf_id,entry_count,unusable FROM session_native_history').all()).toEqual(before.oldHeader);
      expect(db.query('PRAGMA foreign_key_check').all()).toEqual([]);
    } finally { db.close(); }
    const opened = need(core.openDatabase(p));
    expect(opened.db.query('SELECT commit_revision FROM session_native_history').get()).toEqual({ commit_revision: 0 });
    expect(['session_native_entries', 'session_inputs', 'context_snapshots', 'runs'].map((table, index) =>
      opened.db.query(`SELECT ${table === 'runs' ? Object.keys((before.original[index] as Record<string, unknown>[])[0]!).join(',') : table === 'session_inputs' ? Object.keys((before.original[index] as Record<string, unknown>[])[0]!).filter(key => key !== 'request_hash').join(',') : '*'} FROM ${table}`).all())).toEqual(before.original.map((rows, index) => index === 1 ? (rows as Record<string, unknown>[]).map(({ request_hash: _retired, ...row }) => row) : rows));
    expect(opened.db.query('SELECT parent_run_id,origin_tool_call_id,plugin_agent_id FROM runs').get())
      .toEqual({ parent_run_id: null, origin_tool_call_id: null, plugin_agent_id: null });
    expect(opened.db.query('SELECT header_json,leaf_id,entry_count,unusable FROM session_native_history').all()).toEqual(before.oldHeader);
    expect(opened.db.query('PRAGMA foreign_key_check').all()).toEqual([]);
    expect(opened.db.query('PRAGMA foreign_keys').get()).toEqual({ foreign_keys: 1 });
    opened.close();
  }
});

function historyFixture(entries: NativeSessionEntry[]) {
  const root = mkdtempSync(join(tmpdir(), 'flowmate-p9-history-'));
  const paths = { root, databaseFile: join(root, 'test.sqlite'), logsDir: join(root, 'logs'),
    artifactsDir: join(root, 'artifacts'), outputsDir: join(root, 'outputs'), runtimeDir: join(root, 'runtime') };
  const store = need(openDatabase(paths)); deferCleanup(() => store.close());
  let requests = 0;
  const agent = new PiAgentAdapter({ cwd: root, agentDir: paths.runtimeDir, credentials: new InMemoryCredentialStore(),
    fetch: async () => { requests++; throw new Error('Unexpected model HTTP during history management'); } });
  deferCleanup(async () => { await agent.close(); });
  const native = need(agent.createSession()); const empty = need(agent.exportSession(native.nativeSessionId));
  const session = need(store.sessions.create({ nativeSessionId: native.nativeSessionId, title: 'History', at,
    nativeHistory: { ...empty, entries, leafId: entries.at(-1)?.id ?? null } }));
  const service = new SessionService(store.sessions, agent, () => ({ active: null, blocked: false, error: null }),
    () => at, store.runs, store.memory);
  return { store, agent, service, session, requests: () => requests };
}
const user = (id: string, parentId: string | null, text: string): NativeSessionEntry => ({ type: 'message', id, parentId,
  timestamp: at, message: { role: 'user', content: text, timestamp: 1 } });
const usage = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } };
const historyAssistant = (content: unknown[]) => ({ role: 'assistant', content, api: 'openai-completions', provider: 'fixture', model: 'fixture', usage, stopReason: 'stop', timestamp: 1 });
function historyRun(f: ReturnType<typeof historyFixture>) {
  const config = { version: 1 as const, name: 'History fixture', revision: 1,
    requestedModel: { provider: 'synthetic', model: 'synthetic' }, resolvedModel: null, api: null, endpoint: null,
    sdk: { codingAgent: '0.85.1', ai: '0.85.1' }, parameters: { maxRetries: 0, maxRetryDelayMs: 100 },
    limits: { timeoutMs: 1000, stopGraceMs: 100 }, native: { authSource: 'unknown' as const, modelsSelection: null },
    goalMode: 'answer' as const, agent: { policyVersion: 'p3-invoice-tools-v1' as const, nativeSessionId: f.session.nativeSessionId,
      systemPrompt: INVOICE_TOOLS_SYSTEM_PROMPT, thinkingLevel: 'off' as const, resourcePolicy: 'none' as const,
      historyPolicy: 'memory-only' as const, maxContextBytes: 8388608 as const, maxOutputBytes: 262144 as const,
      maxAssistantContentBytes: 524288 as const, maxModelCalls: 12 as const, maxToolCalls: 24 as const,
      toolTimeoutMs: 10000 as const, sessionRetry: false as const } };
  return need(f.store.runs.createAgent({ sessionId: f.session.sessionId, goal: 'History',
    input: { version: 1, goal: 'History', text: '', messageTimestamp: 1 }, config,
    scope: { version: 2, allowedTools: [], allowedDocumentIds: [], allowedArtifactIds: [], allowedResourcePaths: [] },
    usage: { version: 1, source: 'unknown', reason: 'offline', sdkValues: null, attempts: null,
      attemptsComplete: false, costSource: null, updatedAt: at },
    cleanup: { version: 1, stopped: false, stopReason: null, errors: [], lateObservationRequired: false }, createdAt: at }));
}

it('P9 T05 pages the whole tree at one committed revision', async () => {
  const entries = Array.from({ length: 121 }, (_, n) => user(`u${n}`, n ? 'u0' : null, `question ${n}`));
  const f = historyFixture(entries);
  const before = f.store.db.query('SELECT * FROM session_native_entries').all();
  const first = await f.service.querySessionHistory?.({ sessionId: f.session.sessionId });
  expect(first).toMatchObject({ ok: true, data: { commit: { commitRevision: 1, entryCount: 121 }, nextAfterSequence: 49 } });
  if (!first?.ok) return;
  expect(first.data.items).toHaveLength(50);
  expect(need(await f.service.querySessionHistory({ sessionId: f.session.sessionId, limit: 100 })).items).toHaveLength(100);
  expect(await f.service.querySessionHistory({ sessionId: f.session.sessionId, limit: 101 })).toMatchObject({ ok: false, error: { code: 'input_invalid' } });
  expect(first.data.items[1]).toMatchObject({ entryId: 'u1', sequence: 1, isCurrentPath: false, canSelect: true });
  const second = need(await f.service.querySessionHistory({ sessionId: f.session.sessionId, expectedCommitRevision: 1, afterSequence: 49, limit: 100 }));
  expect(second.items).toHaveLength(71); expect(second.items[0]?.sequence).toBe(50); expect(second.nextAfterSequence).toBeNull();
  expect(need(await f.service.querySessionHistory({ sessionId: f.session.sessionId, afterSequence: 120, expectedCommitRevision: 1 })).items).toEqual([]);
  expect(await f.service.querySessionHistory({ sessionId: f.session.sessionId, afterSequence: 49 })).toMatchObject({ ok: false, error: { code: 'input_invalid' } });
  const original = need(f.store.memory.load(f.session.sessionId))!;
  need(f.store.memory.commit({ sessionId: f.session.sessionId, expected: original.commit, header: original.history.header,
    appendEntries: [], contexts: [], leafId: 'u1', unusable: false }));
  expect(await f.service.querySessionHistory({ sessionId: f.session.sessionId, expectedCommitRevision: 1 })).toMatchObject({ ok: false, error: { code: 'state_conflict' } });
  expect(await f.service.querySessionHistoryEntry({ sessionId: f.session.sessionId, entryId: 'u0', expectedCommitRevision: 1 })).toMatchObject({ ok: false, error: { code: 'state_conflict' } });
  expect(f.store.db.query('SELECT * FROM session_native_entries').all()).toEqual(before);
});

it('P9 T05 browses empty and incomplete positions, uses current authorization, and rejects unprovable origins', async () => {
  const f = historyFixture([{ type: 'custom', id: 'metadata', parentId: null, timestamp: at, customType: 'opaque', data: { secret: 'private' } },
    user('u', 'metadata', 'user'), { type: 'message', id: 'call', parentId: 'u', timestamp: at,
      message: { ...historyAssistant([{ type: 'toolCall', id: 'call-id', name: 'tool', arguments: { secret: 'private' } }]), stopReason: 'toolUse' } } as NativeSessionEntry]);
  const page = need(await f.service.querySessionHistory({ sessionId: f.session.sessionId }));
  expect(page.items.map(item => [item.entryId, item.canSelect, item.cannotSelectReason]))
    .toEqual([['metadata', false, 'empty-context'], ['u', true, null], ['call', false, 'incomplete-tool-pair']]);
  expect(await f.service.querySessionHistoryEntry({ sessionId: f.session.sessionId, entryId: 'call', expectedCommitRevision: 1 }))
    .toMatchObject({ ok: true, data: { part: null, partIndex: 0, offset: 0, next: null } });
  expect(await f.service.branch({ sessionId: f.session.sessionId, expectedCommitRevision: 1, expectedLeafId: 'call', expectedEntryCount: 3, targetEntryId: 'call' }))
    .toMatchObject({ ok: false, error: { code: 'session_branch_unavailable' } });
  f.store.db.query("UPDATE sessions SET metadata_json=json_set(metadata_json,'$.model_use_blocked',json(?)) WHERE id=?")
    .run(JSON.stringify({ documentIds: [1], at, reason: 'document_use_revoked' }), f.session.sessionId);
  expect(need(await f.service.querySessionHistory({ sessionId: f.session.sessionId })).items[1]).toMatchObject({ canSelect: false, cannotSelectReason: 'source-unavailable' });
  expect(ensureNativeSession(f.store.sessions, f.agent, f.session, f.store.memory)).toMatchObject({ ok: false, error: { code: 'session_scope_revoked' } });
  f.store.db.exec('PRAGMA foreign_keys=OFF');
  f.store.db.query("UPDATE session_native_entries SET run_id=999 WHERE entry_id='u'").run();
  expect(await f.service.querySessionHistory({ sessionId: f.session.sessionId })).toMatchObject({ ok: false, error: { code: 'context_binding_unknown' } });
});

it('P9 T05 reads complete display text through safe UTF8 parts', async () => {
  const text = '中文🙂'.repeat(18000);
  const entry: NativeSessionEntry = { type: 'custom_message', id: 'long', parentId: null, timestamp: at, customType: 'fixture', display: false,
    content: [{ type: 'text', text: '' }, { type: 'text', text }, { type: 'text', text: '' }, { type: 'text', text: '尾🙂' }], details: { secret: 'never expose' } };
  const f = historyFixture([entry]);
  const first = await f.service.querySessionHistoryEntry?.({ sessionId: f.session.sessionId, entryId: 'long', expectedCommitRevision: 1 });
  expect(first).toMatchObject({ ok: true, data: { partIndex: 1, offset: 0, part: { kind: 'text' } } });
  if (!first?.ok) return;
  let part = first.data; let recovered = '';
  for (;;) {
    expect(Buffer.byteLength(JSON.stringify({ ok: true, data: part }))).toBeLessThanOrEqual(131072);
    expect(Buffer.byteLength(part.part!.text)).toBeLessThanOrEqual(65536);
    recovered += part.part!.text;
    if (!part.next) break;
    part = need(await f.service.querySessionHistoryEntry({ sessionId: f.session.sessionId, entryId: 'long', expectedCommitRevision: 1, ...part.next }));
  }
  expect(recovered).toBe(text + '尾🙂'); expect(JSON.stringify(first)).not.toContain('never expose');
  expect(await f.service.querySessionHistoryEntry({ sessionId: f.session.sessionId, entryId: 'long', expectedCommitRevision: 1, partIndex: 1, offset: 1 }))
    .toMatchObject({ ok: false, error: { code: 'input_invalid' } });
});

it.each(['user', 'custom_message'] as const)('P9 T05 selects complete nodes on other branches without preparing a model: %s', async kind => {
  const other: NativeSessionEntry = kind === 'user' ? user('other', 'first', 'other')
    : { type: 'custom_message', id: 'other', parentId: 'first', timestamp: at, customType: 'fixture', display: false, content: 'other' };
  const f = historyFixture([user('first', null, 'first'), other, user('current', 'first', 'current')]);
  await f.agent.releaseSession(f.session.nativeSessionId);
  const before = f.store.db.query('SELECT * FROM session_native_entries').all();
  let prepares = 0; f.agent.prepare = async () => { prepares++; throw new Error('Management must not prepare'); };
  const selected = await f.service.branch({ sessionId: f.session.sessionId, expectedCommitRevision: 1,
    expectedEntryCount: 3, expectedLeafId: 'current', targetEntryId: 'other' });
  expect(selected).toMatchObject({ ok: true, data: { leafId: 'other' } });
  expect(need(f.store.memory.load(f.session.sessionId))?.commit).toEqual({ commitRevision: 2, entryCount: 3, leafId: 'other' });
  expect(need(f.agent.exportSession(f.session.nativeSessionId)).leafId).toBe('other');
  expect(f.store.db.query('SELECT * FROM session_native_entries').all()).toEqual(before); expect(prepares).toBe(0);
});

it('P9 T05 restores complete history beyond the first page for missing and ready instances', async () => {
  const f = historyFixture(Array.from({ length: 61 }, (_, n) => user(`u${n}`, n ? `u${n - 1}` : null, `question ${n}`)));
  await f.agent.releaseSession(f.session.nativeSessionId);
  expect(ensureNativeSession(f.store.sessions, f.agent, f.session, f.store.memory)).toEqual({ ok: true, data: undefined });
  expect(need(f.agent.exportSession(f.session.nativeSessionId)).entries).toHaveLength(61);
  expect(ensureNativeSession(f.store.sessions, f.agent, f.session, f.store.memory)).toEqual({ ok: true, data: undefined });
  const created = await f.service.create({ title: 'Receipt installation' });
  expect(created).toMatchObject({ ok: true });
});

it('P9 T05 shrinks whole rows by complete page bytes with an advancing exclusive cursor', async () => {
  const timestamp = `2026-10-04T00:00:00.${'0'.repeat(7000)}Z`;
  const f = historyFixture(Array.from({ length: 121 }, (_, n) => ({ ...user(`u${n}`, n ? 'u0' : null, '\u0000'.repeat(1024)), timestamp })));
  let afterSequence: number | undefined; const ids: string[] = [];
  do {
    const result = await f.service.querySessionHistory({ sessionId: f.session.sessionId, expectedCommitRevision: 1, limit: 100,
      ...(afterSequence === undefined ? {} : { afterSequence }) });
    const page = need(result); expect(Buffer.byteLength(JSON.stringify(result))).toBeLessThanOrEqual(1048576);
    expect(page.items.length).toBeGreaterThan(0); expect(page.items.length).toBeLessThan(100);
    ids.push(...page.items.map(item => item.entryId)); afterSequence = page.nextAfterSequence ?? undefined;
  } while (afterSequence !== undefined);
  expect(ids).toEqual(Array.from({ length: 121 }, (_, n) => `u${n}`));
  f.store.db.query('UPDATE sessions SET created_at=? WHERE id=?').run(`2026-10-04T00:00:00.${'0'.repeat(1048576)}Z`, f.session.sessionId);
  expect(await f.service.querySessionHistory({ sessionId: f.session.sessionId })).toMatchObject({ ok: false, error: { code: 'context_evidence_too_large' } });
});

it.each(['newer-revision', 'changed-body', 'unknown-read', 'sticky-failure'] as const)('P9 T05 never confirms unknown or different committed facts: %s', async fault => {
  const f = historyFixture([user('old', null, 'old'), user('target', 'old', 'target')]);
  await f.agent.releaseSession(f.session.nativeSessionId);
  const original = f.store.memory.commit; const read = f.store.sessions.readHistorySnapshot; let written = false; let writes = 0;
  const before = f.store.db.query('SELECT * FROM session_native_entries').all();
  const old = need(read(f.session.sessionId, value => ({ ok: true, data: value })));
  const move = f.agent.moveSessionLeaf.bind(f.agent); let nativeMoved: unknown; let moves = 0;
  f.agent.moveSessionLeaf = async (...args) => { moves++; const result = await move(...args); nativeMoved = result; return result; };
  f.store.memory.commit = input => {
    writes++; const saved = need(original(input)); written = true;
    if (fault === 'newer-revision') {
      const a = need(original({ ...input, expected: saved, leafId: 'target' })); need(original({ ...input, expected: a }));
    }
    if (fault === 'changed-body') f.store.db.query("UPDATE session_native_entries SET entry_json=json_set(entry_json,'$.message.content','different') WHERE entry_id='old'").run();
    return fail(appError('storage_write_failed', 'storage', 'Lost receipt.'));
  };
  if (fault === 'unknown-read' || fault === 'sticky-failure') f.store.sessions.readHistorySnapshot = (...args) => written
    ? fail(appError('storage_read_failed', 'storage', 'Unknown readback.')) : read(...args);
  if (fault === 'sticky-failure') f.store.db.exec("CREATE TRIGGER reject_sticky BEFORE UPDATE OF unusable ON session_native_history WHEN NEW.unusable=1 BEGIN SELECT RAISE(ABORT,'sticky failed'); END;");
  const request = { sessionId: f.session.sessionId, expectedCommitRevision: 1, expectedEntryCount: 2, expectedLeafId: 'target', targetEntryId: 'old' };
  const result = await f.service.branch(request);
  expect(result).toMatchObject({ ok: false }); expect(writes).toBe(1); expect(moves).toBe(1);
  expect(f.service.isManaging(f.session.sessionId)).toBe(true); expect(await f.service.branch(request)).toMatchObject({ ok: false, error: { code: 'session_busy' } });
  expect(f.agent.inspect(f.session.nativeSessionId).availability).toBe('missing');
  const saved = need(f.store.memory.load(f.session.sessionId))!;
  expect(saved.commit).toEqual({ leafId: 'old', entryCount: 2, commitRevision: fault === 'newer-revision' ? 5 : fault === 'sticky-failure' ? 2 : 3 });
  expect(saved.history.unusable).toBe(fault !== 'sticky-failure');
  if (fault !== 'changed-body') expect(f.store.db.query('SELECT * FROM session_native_entries').all()).toEqual(before);
  expect(f.store.db.query('SELECT * FROM runs').all()).toEqual([]); expect(f.store.db.query('SELECT * FROM session_inputs').all()).toEqual([]);
  console.log('P9 T05 position evidence', JSON.stringify({ fault, old, intended: { history: { ...old.bundle.history!, leafId: 'old' },
    commit: { commitRevision: 2, entryCount: 2, leafId: 'old' }, seed: old.bundle.seed, associations: old.associations }, nativeMoved,
    result, readback: fault === 'unknown-read' || fault === 'sticky-failure' ? 'storage_read_failed' : read(f.session.sessionId, value => ({ ok: true, data: value })),
    sqlHeader: f.store.db.query('SELECT * FROM session_native_history').all(), sqlEntries: f.store.db.query('SELECT * FROM session_native_entries').all(),
    sqlInputs: f.store.db.query('SELECT * FROM session_inputs').all(), finalReceipt: saved.commit, moves, writes, retainedGate: f.service.isManaging(f.session.sessionId) }));
});

it('P9 T05 keeps chat and History cursors independent on mixed paths', async () => {
  const entries = [user('user', null, 'visible user'),
    { id: 'assistant', parentId: 'user', type: 'message', timestamp: at, message: historyAssistant([{ type: 'text', text: 'visible assistant' }]) },
    { id: 'bash', parentId: 'assistant', type: 'message', timestamp: at, message: { role: 'bashExecution', command: 'cmd', output: 'output', cancelled: false, truncated: false, timestamp: 1 } },
    { id: 'custom', parentId: 'bash', type: 'custom_message', timestamp: at, customType: 'private', display: false, content: 'derived', details: { password: 'private-secret' } },
    { id: 'label', parentId: 'custom', type: 'label', timestamp: at, targetId: 'user', label: 'label' },
    { id: 'name', parentId: 'label', type: 'session_info', timestamp: at, name: 'name' },
    { id: 'model', parentId: 'name', type: 'model_change', timestamp: at, provider: 'fixture', modelId: 'fixture' },
    { id: 'thinking', parentId: 'model', type: 'thinking_level_change', timestamp: at, thinkingLevel: 'off' },
    { id: 'opaque', parentId: 'thinking', type: 'custom', timestamp: at, customType: 'private', data: { token: 'private-secret' } },
    { id: 'compact', parentId: 'opaque', type: 'compaction', timestamp: at, summary: 'summary', firstKeptEntryId: 'user', tokensBefore: 1 },
    { id: 'branch', parentId: 'compact', type: 'branch_summary', timestamp: at, fromId: 'user', summary: 'branch' },
  ] as NativeSessionEntry[];
  const f = historyFixture(entries); const before = f.store.db.query('SELECT * FROM session_native_entries').all();
  const page = need(await f.service.querySessionHistory({ sessionId: f.session.sessionId }));
  expect(new Set(page.items.map(item => item.type)).size).toBe(9);
  const chat = need(f.service.listMessages({ sessionId: f.session.sessionId, limit: 1 }));
  expect(chat.items.map(item => item.role)).toEqual(['assistant']); expect(chat.nextBeforeEntryId).toBe('assistant');
  const earlier = need(f.service.listMessages({ sessionId: f.session.sessionId, limit: 1, beforeEntryId: 'assistant' }));
  expect(earlier.items.map(item => item.role)).toEqual(['user']);
  const empty = need(f.service.listMessages({ sessionId: f.session.sessionId, limit: 1, beforeEntryId: 'user' }));
  expect(empty.items).toEqual([]); expect(need(await f.service.querySessionHistory({ sessionId: f.session.sessionId })).items).toHaveLength(11);
  expect(JSON.stringify(page)).not.toContain('private-secret'); expect(f.store.db.query('SELECT * FROM session_native_entries').all()).toEqual(before);
  await f.agent.releaseSession(f.session.nativeSessionId);
  const prepares = spyOn(f.agent, 'prepare');
  expect(page.items.every(item => item.canSelect)).toBe(true);
  for (const item of page.items) {
    const prior = need(f.store.memory.load(f.session.sessionId))!;
    expect(await f.service.branch({ sessionId: f.session.sessionId, targetEntryId: item.entryId,
      expectedCommitRevision: prior.commit.commitRevision, expectedEntryCount: prior.commit.entryCount, expectedLeafId: prior.commit.leafId }))
      .toMatchObject({ ok: true, data: { leafId: item.entryId } });
    expect(need(f.agent.exportSession(f.session.nativeSessionId)).leafId).toBe(item.entryId);
    expect(need(f.store.memory.load(f.session.sessionId))!.commit).toEqual({ ...prior.commit, leafId: item.entryId,
      commitRevision: prior.commit.commitRevision + (prior.commit.leafId === item.entryId ? 0 : 1) });
  }
  expect(prepares).not.toHaveBeenCalled(); expect(f.requests()).toBe(0);
  expect(f.store.db.query('SELECT * FROM session_native_entries').all()).toEqual(before);
});

it('P9 T05 projects all seven message roles through the closed display fields', async () => {
  const secret = 'PRIVATE-PAYLOAD-SENTINEL'; const toolName = '工具'.repeat(1000);
  const roles = [
    { role: 'user', content: [{ type: 'text', text: 'user' }, { type: 'image', data: secret, mimeType: 'image/png' }], timestamp: 1 },
    { ...historyAssistant([{ type: 'toolCall', id: 'pair', name: toolName, arguments: { secret } }]), stopReason: 'toolUse' },
    { role: 'toolResult', content: [{ type: 'text', text: 'result' }, { type: 'image', data: secret, mimeType: 'image/png' }], toolCallId: 'pair', toolName, isError: false, details: { secret }, timestamp: 1 },
    { role: 'bashExecution', command: 'command', output: 'output', cancelled: false, truncated: false, fullOutputPath: secret, timestamp: 1 },
    { role: 'custom', customType: 'custom', display: false, content: 'custom', details: { secret }, timestamp: 1 },
    { role: 'branchSummary', fromId: '0', summary: 'branch summary', timestamp: 1 },
    { role: 'compactionSummary', summary: 'compaction summary', tokensBefore: 1, timestamp: 1 },
  ];
  const entries = roles.map((message, n) => ({ type: 'message', id: `${n}`, parentId: n ? `${n - 1}` : null,
    timestamp: at, message, privateExtra: secret })) as NativeSessionEntry[];
  const f = historyFixture([]), runId = historyRun(f), empty = need(f.store.memory.load(f.session.sessionId))!;
  need(f.store.memory.commit({ sessionId: f.session.sessionId, expected: empty.commit, header: empty.history.header,
    appendEntries: entries, leafId: '6', unusable: false, contexts: [{ entryId: '1', runId }, { entryId: '2', runId }] }));
  const original = f.store.db.query('SELECT * FROM session_native_entries').all();
  for (let n = 0; n < roles.length; n++) {
    const detail = need(await f.service.querySessionHistoryEntry({ sessionId: f.session.sessionId, entryId: `${n}`, expectedCommitRevision: 2 }));
    expect(detail.fields).toMatchObject({ type: 'message', role: roles[n]!.role,
      stopReason: n === 1 ? 'toolUse' : null, isError: n === 2 ? false : null, callId: n === 2 ? 'pair' : null });
    if (n === 2) expect(detail.fields).toMatchObject({ toolName: { truncated: true }, hasImages: true, imageMimeTypes: ['image/png'] });
    else expect(detail.fields).toMatchObject({ toolName: null });
    expect(JSON.stringify(detail)).not.toContain(secret);
  }
  const chat = need(f.service.listMessages({ sessionId: f.session.sessionId, limit: 100 }));
  expect(chat.items.map(item => item.role)).toEqual(['user', 'assistant', 'toolResult']);
  expect(f.store.db.query('SELECT * FROM session_native_entries').all()).toEqual(original);
});

it('P9 T05 preserves escape-expanded text and long label/name/summary/command/output with bounded Results', async () => {
  const long = '\u0000'.repeat(70000) + '中文🙂'.repeat(12000);
  const entries = [user('u', null, 'base'),
    { id: 'a', parentId: 'u', type: 'message', timestamp: at, message: historyAssistant([{ type: 'thinking', thinking: long }, { type: 'text', text: long }]) },
    { id: 'b', parentId: 'a', type: 'message', timestamp: at, message: { role: 'bashExecution', command: long, output: long, fullOutputPath: 'private-path', cancelled: false, truncated: false, timestamp: 1 } },
    { id: 'l', parentId: 'b', type: 'label', timestamp: at, targetId: 'u', label: long },
    { id: 'n', parentId: 'l', type: 'session_info', timestamp: at, name: long },
    { id: 's', parentId: 'n', type: 'branch_summary', timestamp: at, fromId: 'u', summary: long },
  ] as NativeSessionEntry[];
  const f = historyFixture(entries);
  const first = need(await f.service.querySessionHistoryEntry({ sessionId: f.session.sessionId, entryId: 'a', expectedCommitRevision: 1 }));
  expect(Buffer.byteLength(first.part!.text)).toBeLessThan(65536);
  expect(first.next).toEqual({ partIndex: 0, offset: Buffer.byteLength(first.part!.text) });
  for (const [entryId, expected] of [['a', long + long], ['b', long + long], ['l', long], ['n', long], ['s', long]]) {
    let next: { partIndex: number; offset: number } | null = { partIndex: 0, offset: 0 }; let text = '';
    while (next) {
      const result = await f.service.querySessionHistoryEntry({ sessionId: f.session.sessionId, entryId: entryId!, expectedCommitRevision: 1, ...next });
      const part = need(result); expect(Buffer.byteLength(JSON.stringify(result))).toBeLessThanOrEqual(131072);
      expect(JSON.stringify(result)).not.toContain('private-path'); expect(Buffer.byteLength(part.summary.preview)).toBeLessThanOrEqual(1024);
      text += part.part!.text; next = part.next;
    }
    expect(text).toBe(expected!);
  }
});

it('P9 T05 rejects impossible text cursors and fixed display metadata overflow without leaking images', async () => {
  const f = historyFixture([{ type: 'custom_message', id: 'image', parentId: null, timestamp: at, customType: 'image', display: true,
    content: [{ type: 'image', data: 'private-base64', mimeType: 'image/png' }] }]);
  const request = { sessionId: f.session.sessionId, entryId: 'image', expectedCommitRevision: 1 };
  expect(await f.service.querySessionHistoryEntry(request)).toMatchObject({ ok: true, data: { part: null, partIndex: 0, offset: 0, next: null } });
  expect(JSON.stringify(await f.service.querySessionHistoryEntry(request))).not.toContain('private-base64');
  for (const positions of [{ offset: -1 }, { offset: 1 }, { partIndex: 1 }, { offset: 0.5 }, { partIndex: Number.MAX_SAFE_INTEGER + 1 }])
    expect(await f.service.querySessionHistoryEntry({ ...request, ...positions })).toMatchObject({ ok: false, error: { code: 'input_invalid' } });
  const images = Array.from({ length: 1200 }, (_, n) => ({ type: 'image' as const, data: 'private-base64', mimeType: `image/${n}${'x'.repeat(220)}` }));
  const huge = historyFixture([{ type: 'custom_message', id: 'huge', parentId: null, timestamp: at, customType: 'image', display: true, content: images }]);
  expect(await huge.service.querySessionHistoryEntry({ sessionId: huge.session.sessionId, entryId: 'huge', expectedCommitRevision: 1 }))
    .toMatchObject({ ok: false, error: { code: 'context_evidence_too_large' } });
});

it.each([false, true])('P9 T05 confirms committed positions after lost changed and no-op responses: no-op=%s', async noOp => {
  const f = historyFixture([user('old', null, 'old'), user('target', 'old', 'target')]);
  await f.agent.releaseSession(f.session.nativeSessionId);
  const before = need(f.store.sessions.loadHistoryForContext(f.session.sessionId));
  const original = f.store.memory.commit; let commits = 0; let moves = 0;
  const move = f.agent.moveSessionLeaf.bind(f.agent); f.agent.moveSessionLeaf = (...args) => { moves++; return move(...args); };
  f.store.memory.commit = input => { commits++; need(original(input)); return fail(appError('storage_write_failed', 'storage', 'Lost receipt.')); };
  const targetEntryId = noOp ? 'target' : 'old';
  const selected = await f.service.branch({ sessionId: f.session.sessionId, expectedCommitRevision: 1, expectedEntryCount: 2, expectedLeafId: 'target', targetEntryId });
  expect(selected).toMatchObject({ ok: true, data: { leafId: targetEntryId } });
  const after = need(f.store.sessions.loadHistoryForContext(f.session.sessionId));
  expect(after).toEqual({ ...before, history: { ...before.history!, leafId: targetEntryId }, commit: { commitRevision: noOp ? 1 : 2, entryCount: 2, leafId: targetEntryId } });
  expect(need(f.agent.exportSession(f.session.nativeSessionId)).leafId).toBe(targetEntryId);
  expect(commits).toBe(1); expect(moves).toBe(1); expect(f.requests()).toBe(0);
  console.log('P9 T05 lost receipt evidence', JSON.stringify({ noOp, old: before,
    intended: { ...before, history: { ...before.history!, leafId: targetEntryId },
      commit: { commitRevision: noOp ? 1 : 2, entryCount: 2, leafId: targetEntryId } }, readback: after,
    native: need(f.agent.exportSession(f.session.nativeSessionId)),
    sqlHeader: f.store.db.query('SELECT * FROM session_native_history').all(),
    sqlEntries: f.store.db.query('SELECT * FROM session_native_entries').all(), sqlInputs: f.store.db.query('SELECT * FROM session_inputs').all(),
    moves, commits, http: f.requests() }));
});

it.each(['source-progress', 'result-association'] as const)('P9 T05 confirms exactly the frozen origin associations after a lost receipt: %s', async fault => {
  const f = historyFixture([]), runId = historyRun(f);
  const addInput = (sequence: number) => Number(f.store.db.query(`INSERT INTO session_inputs(session_id,client_sequence,mode,goal_mode,
    request_identity_json,run_id,content_json,status,processing_status,created_at,updated_at)
    VALUES(?,?,'prompt','answer',?, ?,?,'queued','pending',?,?)`).run(f.session.sessionId, sequence, '{}', runId,
      JSON.stringify({ version: 2, text: 'source', promptText: 'source', workspaceContext: null, workspaceInput: null,
        allowedDocumentIds: [], allowedArtifactIds: [] }), at, at).lastInsertRowid);
  const inputId = addInput(1), empty = need(f.store.memory.load(f.session.sessionId))!;
  const entries = [user('user', null, 'source'), { type: 'message', id: 'reply', parentId: 'user', timestamp: at,
    message: historyAssistant([{ type: 'text', text: 'reply' }]) }] as NativeSessionEntry[];
  need(f.store.memory.commit({ sessionId: f.session.sessionId, expected: empty.commit, header: empty.history.header,
    appendEntries: entries, leafId: 'reply', unusable: false,
    contexts: [{ entryId: 'user', runId, inputId }, { entryId: 'reply', runId, resultInputIds: [inputId] }] }));
  const source = need(f.store.memory.load(f.session.sessionId))!;
  const native = need(f.agent.createSession()), targetHeader = need(f.agent.exportSession(native.nativeSessionId)).header;
  const target = need(f.store.sessions.create({ nativeSessionId: native.nativeSessionId, title: 'Trusted copied prefix', at,
    nativeHistory: { ...source.history, header: targetHeader } }));
  // Existing trusted provenance in disposable SQLite, not a public fork implementation.
  f.store.db.query(`INSERT INTO session_forks(target_session_id,source_session_id,source_commit_revision,source_entry_count,
    source_leaf_id,selected_entry_id,inherited_entry_count,client_operation_id,request_json,created_at) VALUES(?,?,?,?,?,?,?,?,?,?)`)
    .run(target.sessionId, f.session.sessionId, source.commit.commitRevision, 2, 'reply', 'reply', 2, native.nativeSessionId,
      JSON.stringify({ selectedEntryId: 'reply' }), at);
  const before = need(f.store.sessions.readHistorySnapshot(target.sessionId, value => ({ ok: true, data: value })));
  const businessBefore = f.store.db.query('SELECT * FROM runs').all();
  await f.agent.releaseSession(native.nativeSessionId);
  const originalMove = f.agent.moveSessionLeaf.bind(f.agent), originalCommit = f.store.memory.commit;
  let moves = 0, writes = 0;
  f.agent.moveSessionLeaf = async (...args) => {
    moves++; const moved = await originalMove(...args);
    if (fault === 'source-progress') {
      const laterInput = addInput(2), latest = need(f.store.memory.load(f.session.sessionId))!;
      need(originalCommit({ sessionId: f.session.sessionId, expected: latest.commit, header: latest.history.header,
        appendEntries: [user('later', 'reply', 'source')], leafId: 'later', unusable: false,
        contexts: [{ entryId: 'later', runId, inputId: laterInput }] }));
    }
    return moved;
  };
  f.store.memory.commit = request => {
    writes++; need(originalCommit(request));
    if (fault === 'result-association') f.store.db.query('UPDATE session_inputs SET result_entry_id=NULL WHERE id=?').run(inputId);
    const after = need(f.store.sessions.loadHistoryForContext(target.sessionId));
    expect(after.seed).toEqual(before.bundle.seed);
    expect(after.history).toEqual({ ...before.bundle.history!, leafId: 'user' });
    expect(after.commit).toEqual({ commitRevision: 2, entryCount: 2, leafId: 'user' });
    return fail(appError('storage_write_failed', 'storage', 'Lost receipt.'));
  };
  const result = await f.service.branch({ sessionId: target.sessionId, targetEntryId: 'user', expectedCommitRevision: 1,
    expectedEntryCount: 2, expectedLeafId: 'reply' });
  expect({ moves, result }).toMatchObject({ moves: 1 }); expect(writes).toBe(1);
  expect(f.store.db.query('SELECT * FROM runs').all()).toEqual(businessBefore);
  const after = need(f.store.memory.load(target.sessionId))!;
  expect(after.history.header).toEqual(targetHeader); expect(after.history.entries).toEqual(entries);
  console.log('P9 T05 origin association evidence', JSON.stringify({ fault, old: before, result,
    readback: need(f.store.sessions.readHistorySnapshot(target.sessionId, value => ({ ok: true, data: value }))),
    sqlHeaders: f.store.db.query('SELECT * FROM session_native_history ORDER BY session_id').all(),
    sqlEntries: f.store.db.query('SELECT * FROM session_native_entries ORDER BY session_id,sequence').all(),
    sqlInputs: f.store.db.query('SELECT * FROM session_inputs ORDER BY id').all(), moves, writes }));
  if (fault === 'source-progress') {
    expect(result).toMatchObject({ ok: true, data: { leafId: 'user' } });
    expect(after.commit).toEqual({ commitRevision: 2, entryCount: 2, leafId: 'user' });
    expect(after.history.unusable).toBe(false);
  } else {
    expect(result).toMatchObject({ ok: false, error: { code: 'session_history_invalid' } });
    expect(after.history.unusable).toBe(true); expect(after.commit.commitRevision).toBe(3);
    expect(f.service.isManaging(target.sessionId)).toBe(true);
    expect(await f.service.branch({ sessionId: target.sessionId, targetEntryId: 'user', expectedCommitRevision: 3,
      expectedEntryCount: 2, expectedLeafId: 'user' })).toMatchObject({ ok: false, error: { code: 'session_busy' } });
    expect(f.agent.inspect(native.nativeSessionId).availability).toBe('missing');
  }
});

// Every case invokes the original repository transaction; no helper-only stand-in.
const t09Terminal = {
  status: 'failed' as const, output: null, error: appError('agent_failed', 'runtime', 'T09 terminal'),
  usage: { version: 1 as const, source: 'unknown' as const, reason: 'fixture', sdkValues: null, attempts: null,
    attemptsComplete: false, costSource: null, updatedAt: at },
  tokens: { inputTokens: null, outputTokens: null, totalTokens: null, cost: null, usageComplete: false },
  cleanup: { version: 1 as const, stopped: true, stopReason: 'fixture', errors: [], lateObservationRequired: false },
  endedAt: at, stoppedAt: at, durationMs: 1, nativeHistoryUnusable: true,
};
function t09Facts(db: Database) {
  return Object.fromEntries(['sessions', 'runs', 'jobs', 'tool_calls', 'session_inputs', 'session_native_history',
    'session_native_entries', 'runtime_events'].map(table => [table, db.query(`SELECT * FROM ${table} ORDER BY rowid`).all()]));
}
function t09Writer(writer: 'W1' | 'W2' | 'W3' | 'W4' | 'W5', legacy = false) {
  const f = fixture(legacy), { runId, inputId } = agentInput(f), db = f.store.db;
  const entries = [entry('a'), assistant()];
  if (!legacy) need(f.commit({ appendEntries: entries, leafId: 'b', contexts: [{ entryId: 'a', runId, inputId },
    { entryId: 'b', runId, ...(writer === 'W4' ? { resultInputIds: [inputId] } : {}) }] }));
  if (writer === 'W2' || writer === 'W3') {
    const call = need(f.store.toolCalls.request({ context: null, runId, sessionId: f.session.sessionId,
      nativeToolCallId: 't09-required-result', toolName: 'powershell', toolVersion: '0.85.1', effect: 'LOCAL_WRITE', rawArguments: {}, requestedAt: at }));
    need(f.store.toolCalls.fixArguments({ toolCallId: call.toolCallId, finalArguments: {} }));
    need(f.store.toolCalls.start({ toolCallId: call.toolCallId, startedAt: at }));
    if (writer === 'W3') need(f.store.toolCalls.finish({ toolCallId: call.toolCallId, result: { version: 1, committedCandidateId: null,
      status: 'succeeded', data: { content: [{ type: 'text', text: 'saved' }] } },
      cleanup: { version: 1, stopped: true, stopReason: 'tool-settled', errors: [] }, endedAt: at, stoppedAt: at }));
    if (writer === 'W3') db.query("UPDATE tool_calls SET result_json='{\"version\":999}' WHERE id=?").run(call.toolCallId);
  }
  if (writer === 'W3' || writer === 'W4' || writer === 'W5') {
    db.query("UPDATE runs SET status='completed',ended_at=?,stopped_at=?,output_json='{}' WHERE id=?").run(at, at, runId);
    // W3 must be selected by the Tool result catch, not pending-input recovery.
    if (writer === 'W3') db.query("UPDATE session_inputs SET processing_status='failed' WHERE id=?").run(inputId);
    if (writer === 'W4') db.query("UPDATE session_inputs SET processing_status='completed' WHERE id=?").run(inputId);
  }
  return { ...f, runId, inputId, invoke: () => writer === 'W1' ? f.store.runs.finish(runId, t09Terminal) : f.store.runs.failInterrupted(at) };
}
for (const writer of ['W1', 'W2', 'W3', 'W4', 'W5'] as const)
  it(`P9 T09 all legacy unusable writers advance revision in original recovery transactions: ${writer}`, () => {
    // Completed W4 Input requires consumed -> native Entry -> Header FKs, so
    // a missing Header is structurally impossible with foreign_keys=ON.
    for (const mode of (['first', 'missing-header', 'sticky-max', 'first-max', 'marker-ignore', 'later-fault'] as const)
      .filter(mode => writer !== 'W4' || mode !== 'missing-header')) {
      const f = t09Writer(writer, mode === 'missing-header'), db = f.store.db;
      if (mode === 'sticky-max' || mode === 'first-max') db.query('UPDATE session_native_history SET commit_revision=?,unusable=?')
        .run(Number.MAX_SAFE_INTEGER, mode === 'sticky-max' ? 1 : 0);
      const before = t09Facts(db), receipt = mode === 'missing-header' ? null : f.load().commit;
      const notifications: unknown[] = [];
      f.store.runtimeEventStore.onCommitted(refs => { expect(db.inTransaction).toBe(false); notifications.push(refs); });
      if (mode === 'marker-ignore') db.exec('CREATE TRIGGER t09_reject BEFORE UPDATE OF unusable ON session_native_history BEGIN SELECT RAISE(IGNORE); END');
      if (mode === 'later-fault') {
        // W3 needs a later active Run P6; W4/W5 use a later pending Input
        // closure so the injected fault follows the selected sticky marker.
        if (writer === 'W3') {
          const later = need(f.store.sessions.create({ nativeSessionId: 't09-later', title: 'Later', at,
            nativeHistory: { ...f.history, header: { ...f.history.header, id: 't09-later' } } }));
          db.query(`INSERT INTO runs(kind,session_id,scope_json,status,goal,input_json,config_json,cleanup_json,usage_json,created_at)
            VALUES('agent',?,'{}','running','later','{}','{}','{}','{}',?)`).run(later.sessionId, at);
          Object.assign(before, t09Facts(db));
        }
        let laterInput: number | undefined;
        if (writer === 'W4' || writer === 'W5') {
          const later = agentInput(f, undefined, 2); laterInput = later.inputId;
          db.query("UPDATE runs SET status='completed',ended_at=?,stopped_at=?,output_json='{}' WHERE id=?").run(at, at, later.runId);
          Object.assign(before, t09Facts(db));
        }
        db.exec(laterInput !== undefined
          ? `CREATE TRIGGER t09_late BEFORE UPDATE ON session_inputs WHEN OLD.id=${laterInput} BEGIN SELECT RAISE(ABORT,'T09 later batch Input fault'); END`
          : writer === 'W1'
          ? "CREATE TRIGGER t09_late BEFORE UPDATE ON session_inputs BEGIN SELECT RAISE(ABORT,'T09 later Input fault'); END"
          : "CREATE TRIGGER t09_late BEFORE INSERT ON runtime_events BEGIN SELECT RAISE(ABORT,'T09 later P6 fault'); END");
      }
      const result = f.invoke();
      if (mode === 'first-max' || mode === 'marker-ignore' || mode === 'later-fault') {
        expect(result).toMatchObject({ ok: false, error: { code: mode === 'marker-ignore' ? 'state_conflict' : 'storage_write_failed' } });
        if (mode === 'first-max') expect(result).toMatchObject({ ok: false, error: { retryable: false,
          message: 'Conversation history commit revision is exhausted. Further changes cannot be saved.' } });
        expect(t09Facts(db)).toEqual(before); expect(notifications).toEqual([]);
      } else {
        expect(result).toMatchObject({ ok: true });
        const saved = need(f.store.memory.load(f.session.sessionId));
        if (mode === 'missing-header') expect(saved).toBeNull();
        else {
          expect(saved!.commit).toEqual({ ...receipt!, commitRevision: mode === 'sticky-max' ? Number.MAX_SAFE_INTEGER : receipt!.commitRevision + 1 });
          expect(saved!.history.unusable).toBe(true);
          expect(db.query('SELECT * FROM session_native_entries ORDER BY rowid').all()).toEqual(before.session_native_entries);
          const originalHead = (before.session_native_history as any[])[0];
          expect(db.query('SELECT header_json,leaf_id,entry_count FROM session_native_history').get()).toEqual({ header_json: originalHead.header_json,
            leaf_id: originalHead.leaf_id, entry_count: originalHead.entry_count });
        }
        const after = t09Facts(db), published = notifications.length;
        const repeated = f.invoke();
        expect(repeated).toMatchObject({ ok: true });
        if (writer === 'W1' && mode === 'missing-header') expect(repeated).toEqual({ ok: true, data: false });
        expect(t09Facts(db)).toEqual(after); expect(notifications.length).toBe(published);
      }
      expect(db.query('PRAGMA foreign_keys').get()).toEqual({ foreign_keys: 1 });
      expect(db.query('PRAGMA foreign_key_check').all()).toEqual([]);
      console.log('T09 legacy transaction', JSON.stringify({ writer, mode, result, beforeRevision: receipt?.commitRevision,
        afterRevision: (db.query('SELECT commit_revision FROM session_native_history').get() as any)?.commit_revision,
        notifications: notifications.length }));
    }
  });

it('P9 T09 all legacy unusable writers advance revision in original recovery transactions: overlapping batch and provider', () => {
  const f = t09Writer('W4'), db = f.store.db;
  // W2 + W4 overlap in the same Session, and a second Session receives one mark.
  const other = need(f.store.sessions.create({ nativeSessionId: 't09-other', title: 'Other', at,
    nativeHistory: { ...f.history, header: { ...f.history.header, id: 't09-other' } } }));
  const otherRun = Number(db.query(`INSERT INTO runs(kind,session_id,scope_json,status,goal,input_json,config_json,cleanup_json,usage_json,created_at)
    VALUES('agent',?,'{}','running','other','{}','{}','{}','{}',?)`).run(other.sessionId, at).lastInsertRowid);
  const otherTool = need(f.store.toolCalls.request({ context: null, runId: otherRun, sessionId: other.sessionId, nativeToolCallId: 'other-active',
    toolName: 'powershell', toolVersion: '0.85.1', effect: 'LOCAL_WRITE', rawArguments: {}, requestedAt: at }));
  expect(otherTool.toolCallId).toBeGreaterThan(0);
  db.query("UPDATE runs SET status='completed',ended_at=?,stopped_at=?,output_json='{}' WHERE id=?").run(at, at, otherRun);
  agentInput(f, undefined, 2);
  const before = t09Facts(db), published: unknown[] = [];
  f.store.runtimeEventStore.onCommitted(refs => published.push(refs));
  db.exec(`CREATE TRIGGER t09_second BEFORE UPDATE OF unusable ON session_native_history WHEN OLD.session_id=${other.sessionId} BEGIN SELECT RAISE(ABORT,'second session'); END`);
  expect(f.store.runs.failInterrupted(at)).toMatchObject({ ok: false, error: { code: 'storage_write_failed' } });
  expect(t09Facts(db)).toEqual(before); expect(published).toEqual([]);
  db.exec('DROP TRIGGER t09_second');
  expect(f.store.runs.failInterrupted(at)).toMatchObject({ ok: true });
  expect(f.load().commit.commitRevision).toBe(3);
  expect(need(f.store.memory.load(other.sessionId))!.commit.commitRevision).toBe(2);
  const after = t09Facts(db); need(f.store.runs.failInterrupted(at)); expect(t09Facts(db)).toEqual(after);
  const provider = Number(db.query(`INSERT INTO runs(kind,session_id,scope_json,status,goal,input_json,config_json,cleanup_json,usage_json,created_at)
    VALUES('provider',NULL,NULL,'running','provider','{}','{}','{}','{}',?)`).run(at).lastInsertRowid);
  const providerBefore = t09Facts(db);
  expect(f.store.runs.finish(provider, t09Terminal)).toMatchObject({ ok: false, error: { code: 'storage_write_failed' } });
  expect(t09Facts(db)).toEqual(providerBefore); expect(db.query('PRAGMA foreign_key_check').all()).toEqual([]);
});

it('P9 T09 all legacy unusable writers advance revision in original recovery transactions: W2 rolls back an already changed Job after later Run P6 failure', () => {
  const f = t09Writer('W2'), db = f.store.db;
  // Minimal trusted legacy business rows; existing native/Input associations
  // remain exact and no P8 snapshot or model execution is fabricated.
  db.query("INSERT INTO artifacts(id,kind,relative_path,bytes,mime_type,metadata_json,created_at) VALUES(1,'original','a',1,'image/png','{}',?),(2,'parsed','b',1,'application/json','{}',?)").run(at, at);
  db.query(`INSERT INTO documents(id,source_key,source_record_id,version,original_artifact_id,parsed_artifact_id,status,metadata_json,created_at,updated_at)
    VALUES(1,'t09','fixture','v1',1,2,'available','{}',?,?)`).run(at, at);
  db.query("INSERT INTO jobs(id,document_id,goal,input_json,status,created_at,updated_at) VALUES(1,1,'T09 recovery','{}','running',?,?)").run(at, at);
  db.query('UPDATE runs SET job_id=1 WHERE id=?').run(f.runId);
  const before = t09Facts(db), notifications: unknown[] = [];
  let inside: ReturnType<typeof t09Facts> | undefined;
  const append = f.store.runtimeEventStore.appendInTransaction.bind(f.store.runtimeEventStore);
  f.store.runtimeEventStore.appendInTransaction = event => {
    if (event.type === 'run_failed') { expect(db.inTransaction).toBe(true); inside = t09Facts(db); }
    return append(event);
  };
  f.store.runtimeEventStore.onCommitted(refs => { expect(db.inTransaction).toBe(false); notifications.push(refs); });
  db.exec("CREATE TRIGGER t09_after_job BEFORE INSERT ON runtime_events WHEN NEW.type='run_failed' BEGIN SELECT RAISE(ABORT,'T09 later Run P6 fault'); END");
  expect(f.invoke()).toMatchObject({ ok: false, error: { code: 'storage_write_failed' } });
  expect(inside).toBeDefined();
  expect(inside!.jobs).toMatchObject([{ id: 1, status: 'failed', status_reason: 'runtime_interrupted' }]);
  expect(inside!.runs).toMatchObject([{ id: f.runId, status: 'failed' }]);
  expect(inside!.tool_calls).toMatchObject([{ status: 'failed' }]);
  expect(inside!.session_native_history).toMatchObject([{ unusable: 1, commit_revision: 3 }]);
  expect(inside!.session_inputs).toEqual(before.session_inputs);
  expect(t09Facts(db)).toEqual(before); expect(notifications).toEqual([]);
  const aborted = inside;
  db.exec('DROP TRIGGER t09_after_job');
  expect(f.invoke()).toMatchObject({ ok: true });
  expect(db.query('SELECT status,status_reason FROM jobs WHERE id=1').get()).toEqual({ status: 'failed', status_reason: 'runtime_interrupted' });
  expect(f.load().commit.commitRevision).toBe(3);
  const repaired = t09Facts(db); expect(notifications).toHaveLength(1);
  expect(f.invoke()).toMatchObject({ ok: true }); expect(t09Facts(db)).toEqual(repaired); expect(notifications).toHaveLength(1);
  expect(db.query('PRAGMA foreign_keys').get()).toEqual({ foreign_keys: 1 });
  expect(db.query('PRAGMA foreign_key_check').all()).toEqual([]);
  console.log('T09 W2 post-Job rollback', JSON.stringify({ before, insideAbortedTransaction: aborted, afterSuccessfulRepair: repaired, notifications: notifications.length }));
});
