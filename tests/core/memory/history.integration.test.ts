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
function fixture() {
  const p = paths(), store = need(core.openDatabase(p));
  deferCleanup(() => store.close());
  const history: NativeSessionHistory = { storageVersion: 1, header: { type: 'session', version: 3, id: 'p9-native', timestamp: at, cwd: p.root },
    entries: [], leafId: null, unusable: false };
  const session = need(store.sessions.create({ nativeSessionId: history.header.id, title: 'P9', at, nativeHistory: history }));
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
  const inputId = Number(db.query(`INSERT INTO session_inputs(session_id,client_sequence,mode,goal_mode,request_hash,run_id,content_json,status,processing_status,created_at,updated_at)
    VALUES(?,?,'prompt','answer',?,?,'{"version":2,"text":"a","promptText":"a","workspaceContext":null,"workspaceInput":null,"allowedDocumentIds":[],"allowedArtifactIds":[]}','queued','pending',?,?)`)
    .run(f.session.sessionId, sequence, 'a'.repeat(64), runId, at, at).lastInsertRowid);
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
  const inputId = Number(db.query(`INSERT INTO session_inputs(session_id,client_sequence,mode,goal_mode,request_hash,run_id,content_json,status,processing_status,created_at,updated_at)
    VALUES(?,1,'prompt','answer',?,?,'{"version":2,"text":"a","promptText":"a","workspaceContext":null,"workspaceInput":null,"allowedDocumentIds":[],"allowedArtifactIds":[]}','queued','pending',?,?)`)
    .run(f.session.sessionId, 'a'.repeat(64), runId, at, at).lastInsertRowid);
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
  const inputId = Number(db.query(`INSERT INTO session_inputs(session_id,client_sequence,mode,goal_mode,request_hash,run_id,content_json,status,processing_status,created_at,updated_at)
    VALUES(?,1,'prompt','answer',?,?,'{"version":2,"text":"a","promptText":"a","workspaceContext":null,"workspaceInput":null,"allowedDocumentIds":[],"allowedArtifactIds":[]}','queued','pending',?,?)`)
    .run(f.session.sessionId, 'a'.repeat(64), runId, at, at).lastInsertRowid);
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
    expect(['session_native_entries', 'session_inputs', 'context_snapshots', 'runs'].map(table => opened.db.query(`SELECT * FROM ${table}`).all())).toEqual(before.original);
    expect(opened.db.query('SELECT header_json,leaf_id,entry_count,unusable FROM session_native_history').all()).toEqual(before.oldHeader);
    expect(opened.db.query('PRAGMA foreign_key_check').all()).toEqual([]);
    expect(opened.db.query('PRAGMA foreign_keys').get()).toEqual({ foreign_keys: 1 });
    opened.close();
  }
});
