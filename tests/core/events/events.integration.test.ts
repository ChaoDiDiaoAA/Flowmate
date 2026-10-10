import { mkdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { tmpdir } from 'node:os';
import { Database } from 'bun:sqlite';
import { describe, expect, it } from 'bun:test';
import { openDatabase } from '../../../packages/core/src/storage/database.ts';
import { deferCleanup, mkdtempSync } from '../../support/resources.ts';
import { createRuntimeEventStore, type EventWrite } from '../../../packages/core/src/events/store.ts';
import { RuntimeEventsReadResultSchema } from '@flowmate/contracts';
import { makeSelectedCandidate } from '../../support/selected-candidate.ts';

const stamp = '2026-10-03T00:00:00.000Z';
function paths() {
  const root = mkdtempSync(join(tmpdir(), 'flowmate-p6-events-'));
  return { root, databaseFile: join(root, 'data', 'app.sqlite'), logsDir: join(root, 'logs'),
    artifactsDir: join(root, 'artifacts'), outputsDir: join(root, 'outputs'), runtimeDir: join(root, 'runtime') };
}
function legacyTwelve(productPaths: ReturnType<typeof paths>) {
  mkdirSync(dirname(productPaths.databaseFile), { recursive: true });
  const db = new Database(productPaths.databaseFile, { create: true });
  const names = ['001_provider.sql', '002_agent_sessions.sql', '003_invoice_tools.sql', '004_parsed_documents.sql',
    '005_native_session_history.sql', '006_hidden_processing.sql', '007_hidden_chats_invoices.sql',
    '008_native_entry_runs.sql', '009_session_inputs.sql', '010_human_candidates.sql',
    '011_session_management.sql', '012_tool_runtime_observations.sql'];
  for (const [index, name] of names.entries()) {
    const version = index + 1;
    const sql = readFileSync(new URL(`../../../packages/core/src/storage/migrations/${name}`, import.meta.url), 'utf8');
    if ([4, 8, 9, 10, 11, 12].includes(version)) {
      for (const statement of sql.split(';').map(part => part.trim()).filter(Boolean)) db.exec(statement);
      if ([4, 10, 11].includes(version)) db.exec('COMMIT');
      if (version === 10) db.exec('PRAGMA foreign_keys=ON');
    } else db.exec(sql);
  }
  expect(db.query('SELECT MAX(version) AS version FROM schema_migrations').get()).toEqual({ version: 12 });
  expect(db.query('PRAGMA foreign_key_check').all()).toEqual([]);
  db.query(`INSERT INTO runs(id,kind,status,goal,input_json,config_json,output_json,cleanup_json,usage_json,
    created_at,ended_at,stopped_at) VALUES (24,'provider','completed','Old provider',?,?,?,'{}','{}',?,?,?)`)
    .run('{"version":1,"text":"old input"}', '{"legacy":"unchanged"}', '{"text":"old reply"}', stamp, stamp, stamp);
  return db;
}

describe('P6 runtime event migration', () => {
  it('creates schema 13 without changing the database modes', () => {
    const opened = openDatabase(paths());
    expect(opened.ok).toBe(true);
    if (!opened.ok) return;
    deferCleanup(() => opened.data.close());
    expect(opened.data.db.query('SELECT MAX(version) AS version FROM schema_migrations').get()).toEqual({ version: 19 });
    expect(opened.data.db.query('PRAGMA foreign_keys').get()).toEqual({ foreign_keys: 1 });
    expect(opened.data.db.query('PRAGMA busy_timeout').get()).toEqual({ timeout: 1000 });
    expect(opened.data.db.query('PRAGMA journal_mode').get()).toEqual({ journal_mode: 'delete' });
    expect(opened.data.db.query('PRAGMA locking_mode').get()).toEqual({ locking_mode: 'exclusive' });
    expect(opened.data.db.query('SELECT COUNT(*) AS count FROM runtime_events').get()).toEqual({ count: 0 });
  });

  it('migrates actual schema 12 while preserving old IDs and JSON bytes', () => {
    const productPaths = paths();
    const old = legacyTwelve(productPaths);
    const before = old.query('SELECT * FROM runs WHERE id=24').get();
    old.close();
    const opened = openDatabase(productPaths);
    expect(opened.ok).toBe(true);
    if (!opened.ok) return;
    deferCleanup(() => opened.data.close());
    expect(opened.data.db.query('SELECT MAX(version) AS version FROM schema_migrations').get()).toEqual({ version: 19 });
    expect(opened.data.db.query('SELECT * FROM runs WHERE id=24').get()).toEqual({ ...(before as Record<string, unknown>),
      current_context_snapshot_id: null, context_observations_json: null, parent_run_id: null, origin_tool_call_id: null, plugin_agent_id: null });
    expect(opened.data.db.query('PRAGMA foreign_key_check').all()).toEqual([]);
    expect(opened.data.db.query('SELECT COUNT(*) AS count FROM runtime_events WHERE run_id=24').get()).toEqual({ count: 0 });
  });

  it('rolls back the entire migration when version 13 registration fails', () => {
    const productPaths = paths();
    const old = legacyTwelve(productPaths);
    const before = old.query('SELECT * FROM runs WHERE id=24').get();
    old.exec("CREATE TRIGGER reject_13 BEFORE INSERT ON schema_migrations WHEN NEW.version=13 BEGIN SELECT RAISE(ABORT,'fixture migration failure'); END;");
    old.close();
    const attempted = openDatabase(productPaths);
    if (attempted.ok) attempted.data.close();
    expect(attempted).toMatchObject({ ok: false, error: { code: 'storage_open_failed' } });
    const inspected = new Database(productPaths.databaseFile);
    deferCleanup(() => inspected.close());
    expect(inspected.query('SELECT MAX(version) AS version FROM schema_migrations').get()).toEqual({ version: 12 });
    expect(inspected.query("SELECT name FROM sqlite_master WHERE name='runtime_events' OR tbl_name='runtime_events'").all()).toEqual([]);
    expect(inspected.query('SELECT * FROM runs WHERE id=24').get()).toEqual(before);
    expect(inspected.query('PRAGMA foreign_key_check').all()).toEqual([]);
  });

  it('rejects direct SQL violations of schema 13 event ownership, uniqueness and payload version without changing saved facts', () => {
    const opened = openDatabase(paths());
    if (!opened.ok) throw new Error(opened.error.code);
    const product = opened.data; deferCleanup(() => product.close());
    const db = product.db;
    expect(db.query('SELECT MAX(version) AS version FROM schema_migrations').get()).toEqual({ version: 19 });
    expect(db.query('PRAGMA foreign_keys').get()).toEqual({ foreign_keys: 1 });
    const firstSession = product.sessions.create({ nativeSessionId: 'p6-ddl-first', title: 'First', at: stamp });
    const secondSession = product.sessions.create({ nativeSessionId: 'p6-ddl-second', title: 'Second', at: stamp });
    if (!firstSession.ok || !secondSession.ok) throw new Error('fixture sessions failed');
    const sessionId = firstSession.data.sessionId;
    const otherSessionId = secondSession.data.sessionId;
    db.query(`INSERT INTO runs(id,kind,session_id,status,goal,input_json,config_json,scope_json,error_json,
      cleanup_json,usage_json,created_at,ended_at) VALUES(201,'agent',?,'created','DDL first','{}','{}','{}',NULL,'{}','{}',?,NULL)`)
      .run(sessionId, stamp);
    db.query(`INSERT INTO runs(id,kind,session_id,status,goal,input_json,config_json,scope_json,error_json,
      cleanup_json,usage_json,created_at,ended_at) VALUES(202,'agent',?,'failed','DDL other','{}','{}','{}',?, '{}','{}',?,?)`)
      .run(otherSessionId, '{"code":"fixture_failed"}', stamp, stamp);
    db.query(`INSERT INTO tool_calls(id,run_id,session_id,native_tool_call_id,tool_name,args_json,
      delivery_json,cleanup_json,requested_at) VALUES(301,202,?,'ddl-other-tool','fixture_tool','{}','{}','{}',?)`)
      .run(otherSessionId, stamp);
    const payload = { version: 1 as const, status: 'created' as const, origin: 'live' as const, stopped: null, errorCode: null };
    const first = product.runtimeEventStore.withTransaction(() => product.runtimeEventStore.appendInTransaction({
      runId: 201, sessionId, toolCallId: null, type: 'run_created', dedupeKey: 'run:created', occurredAt: stamp, payload }));
    const beforeEvents = db.query('SELECT * FROM runtime_events ORDER BY id').all();
    const beforeRuns = db.query('SELECT * FROM runs ORDER BY id').all();
    const beforeSessions = db.query('SELECT * FROM sessions ORDER BY id').all();
    const beforeTools = db.query('SELECT * FROM tool_calls ORDER BY id').all();
    const published: unknown[] = [];
    product.runtimeEventStore.onCommitted(refs => published.push(refs));
    const valid = { id: first.eventId + 1, runId: 201, sequence: 2, sessionId, toolCallId: null,
      dedupeKey: 'direct:second', payloadJson: JSON.stringify(payload) };
    const violations = [
      { ...valid, runId: 999_999, sessionId: null, error: /FOREIGN KEY constraint failed/ },
      { ...valid, sessionId: otherSessionId, error: /FOREIGN KEY constraint failed/ },
      { ...valid, sessionId: 999_999, error: /FOREIGN KEY constraint failed/ },
      { ...valid, toolCallId: 999_999, error: /FOREIGN KEY constraint failed/ },
      { ...valid, toolCallId: 301, error: /FOREIGN KEY constraint failed/ },
      { ...valid, id: first.eventId, error: /UNIQUE constraint failed: runtime_events.id/ },
      { ...valid, sequence: 1, error: /UNIQUE constraint failed: runtime_events.run_id, runtime_events.sequence/ },
      { ...valid, dedupeKey: 'run:created', error: /UNIQUE constraint failed: runtime_events.run_id, runtime_events.dedupe_key/ },
      ...['{', '{}', '{"version":2}', '{"version":"1"}', '{"version":1.0}', '{"version":null}', '{"version":false}']
        .map(payloadJson => ({ ...valid, payloadJson, error: /CHECK constraint failed/ })),
    ];
    const insert = db.query(`INSERT INTO runtime_events(id,run_id,sequence,session_id,tool_call_id,dedupe_key,
      type,payload_json,occurred_at,received_at) VALUES(?,?,?,?,?,?,'run_created',?,?,?)`);
    for (const row of violations) {
      expect(() => insert.run(row.id, row.runId, row.sequence, row.sessionId, row.toolCallId, row.dedupeKey,
        row.payloadJson, stamp, stamp)).toThrow(row.error);
      expect(db.query('SELECT * FROM runtime_events ORDER BY id').all()).toEqual(beforeEvents);
      expect(db.query('SELECT * FROM runs ORDER BY id').all()).toEqual(beforeRuns);
      expect(db.query('SELECT * FROM sessions ORDER BY id').all()).toEqual(beforeSessions);
      expect(db.query('SELECT * FROM tool_calls ORDER BY id').all()).toEqual(beforeTools);
      expect(published).toEqual([]);
    }
    expect(db.inTransaction).toBe(false);
    expect(db.query('PRAGMA foreign_key_check').all()).toEqual([]);
  });

  it('cascades event rows on permanent chat deletion and preserves hidden business history', () => {
    const opened = openDatabase(paths());
    if (!opened.ok) throw new Error(opened.error.code);
    const store = opened.data; deferCleanup(() => store.close());
    const session = store.sessions.create({ nativeSessionId: 'p6-delete-plain', title: 'Plain chat', at: stamp });
    if (!session.ok) throw new Error(session.error.code);
    store.db.query(`INSERT INTO runs(id,kind,session_id,status,goal,input_json,config_json,scope_json,cleanup_json,usage_json,created_at)
      VALUES(24,'agent',?,'created','Plain chat','{}','{}','{}','{}','{}',?)`).run(session.data.sessionId, stamp);
    store.runtimeEventStore.withTransaction(() => store.runtimeEventStore.appendInTransaction({ runId: 24,
      sessionId: session.data.sessionId, toolCallId: null, type: 'run_created', dedupeKey: 'run:created', occurredAt: stamp,
      payload: { version: 1, status: 'created', origin: 'live', stopped: null, errorCode: null } }));
    store.db.query("UPDATE runs SET status='failed',error_json=?,ended_at=? WHERE id=24")
      .run('{"code":"fixture_failed"}', stamp);
    expect(store.sessions.prepareDelete(session.data.sessionId, stamp).ok).toBe(true);
    expect(store.sessions.delete(session.data.sessionId, stamp)).toEqual({ ok: true, data: 'permanent' });
    expect(store.db.query('SELECT * FROM runtime_events WHERE run_id=24').all()).toEqual([]);
    expect(store.db.query('PRAGMA foreign_key_check').all()).toEqual([]);

    const business = makeSelectedCandidate();
    const businessEvents = createRuntimeEventStore(business.db);
    expect(() => businessEvents.withTransaction(() => businessEvents.appendInTransaction({
      runId: business.runId, sessionId: business.session.sessionId, toolCallId: 999_999,
      type: 'tool_requested', dedupeKey: 'tool:999999:requested', occurredAt: business.stamp,
      payload: { version: 1, toolName: 'save_invoice_candidate', status: 'requested', origin: 'live',
        committedCandidateId: null, errorCode: null, stopped: null } }))).toThrow('state_conflict');
    const before = business.db.query('SELECT * FROM runtime_events WHERE run_id=? ORDER BY sequence').all(business.runId);
    expect(before.length).toBeGreaterThan(0);
    expect(business.sessions.prepareDelete(business.session.sessionId, business.stamp).ok).toBe(true);
    expect(business.sessions.delete(business.session.sessionId, business.stamp)).toEqual({ ok: true, data: 'hidden' });
    expect(business.db.query('SELECT * FROM runtime_events WHERE run_id=? ORDER BY sequence').all(business.runId)).toEqual(before);
    expect(businessEvents.query({ runId: business.runId, sessionId: business.session.sessionId,
      cursor: { runId: business.runId, lastPersistedSequence: 0 } })).toMatchObject({ ok: true, data: { coverage: 'from-created' } });
    expect(business.candidates.readByJob({ jobId: business.jobId, candidateId: business.candidateId }).ok).toBe(true);
    expect(business.db.query('PRAGMA foreign_key_check').all()).toEqual([]);
  });
});

function eventFixture() {
  const opened = openDatabase(paths());
  if (!opened.ok) throw new Error(opened.error.code);
  deferCleanup(() => opened.data.close());
  const db = opened.data.db;
  db.query(`INSERT INTO runs(id,kind,status,goal,input_json,config_json,cleanup_json,usage_json,created_at)
    VALUES(101,'provider','created','Observe only','{}','{}','{}','{}',?)`).run(stamp);
  const store = createRuntimeEventStore(db);
  const created: EventWrite = { runId: 101, sessionId: null, toolCallId: null, type: 'run_created',
    payload: { version: 1, status: 'created', origin: 'live', stopped: null, errorCode: null },
    occurredAt: stamp, dedupeKey: 'run:created' };
  const query = (cursor = 0, extra = {}) => store.query({ runId: 101, sessionId: null,
    cursor: { runId: 101, lastPersistedSequence: cursor }, ...extra });
  const start = () => {
    db.query("UPDATE runs SET status='running',started_at=? WHERE id=101").run(stamp);
    return store.appendInTransaction({ ...created, type: 'run_started', dedupeKey: 'run:started',
      payload: { ...created.payload, status: 'running' } });
  };
  return { db, store, created, query, start };
}

describe('P6 runtime event transactions and replay', () => {
  it('requires the shared transaction and only publishes after the outer commit', () => {
    const f = eventFixture();
    const seen: unknown[] = [];
    f.store.onCommitted(refs => { expect(f.db.inTransaction).toBe(false); seen.push(refs); });
    expect(() => f.store.appendInTransaction(f.created)).toThrow();
    f.store.withTransaction(() => {
      f.store.appendInTransaction(f.created);
      f.store.withTransaction(f.start);
      expect(seen).toEqual([]);
    });
    expect(seen).toEqual([[{ runId: 101, sequence: 1 }, { runId: 101, sequence: 2 }]]);
    expect(f.query()).toMatchObject({ ok: true, data: { highWatermark: 2, coverage: 'from-created' } });
  });

  it('rolls back state, sequence and notifications on outer and inner failures', () => {
    const f = eventFixture();
    const seen: unknown[] = [];
    f.store.onCommitted(refs => seen.push(refs));
    expect(() => f.store.withTransaction(() => {
      f.store.appendInTransaction(f.created); f.start(); throw new Error('fixture rollback');
    })).toThrow('fixture rollback');
    expect(seen).toEqual([]);
    expect(f.db.query('SELECT status FROM runs WHERE id=101').get()).toEqual({ status: 'created' });
    expect(f.query()).toMatchObject({ ok: true, data: { highWatermark: 0, coverage: 'none' } });
    f.store.withTransaction(() => {
      expect(f.store.appendInTransaction(f.created).sequence).toBe(1);
      expect(() => f.store.withTransaction(() => { f.start(); throw new Error('inner'); })).toThrow('inner');
    });
    expect(seen).toEqual([[{ runId: 101, sequence: 1 }]]);
    expect(f.store.withTransaction(f.start).sequence).toBe(2);
  });

  it('keeps one fact for retries while rejecting conflicting keys and untrusted state', () => {
    const f = eventFixture();
    const seen: unknown[] = [];
    f.store.onCommitted(refs => seen.push(refs));
    const first = f.store.withTransaction(() => f.store.appendInTransaction(f.created));
    f.store.withTransaction(f.start);
    const retry = f.store.withTransaction(() => f.store.appendInTransaction({ ...f.created,
      occurredAt: '2026-10-03T01:00:00.000Z', payload: { ...f.created.payload, origin: 'recovery' as const } }));
    expect(retry).toEqual(first);
    expect(seen.length).toBe(2);
    expect(() => f.store.withTransaction(() => f.store.appendInTransaction({ ...f.created,
      payload: { ...f.created.payload, stopped: true } }))).toThrow('state_conflict');
    const other = eventFixture();
    expect(() => other.store.withTransaction(() => other.store.appendInTransaction({ ...other.created,
      type: 'run_started', dedupeKey: 'run:started', payload: { ...other.created.payload, status: 'running' } }))).toThrow();
    expect(() => other.store.withTransaction(() => other.store.appendInTransaction({ ...other.created, dedupeKey: 'invented' }))).toThrow();
    expect(other.query()).toMatchObject({ ok: true, data: { highWatermark: 0 } });
  });

  it('queries strict ownership and invalid cursors without writing or starting anything', () => {
    const f = eventFixture();
    f.store.withTransaction(() => { f.store.appendInTransaction(f.created); f.start(); });
    const before = f.db.query('SELECT * FROM runs WHERE id=101').get();
    for (const c of [-1, 3]) expect(f.query(c)).toMatchObject({ ok: false,
      error: { code: 'event_cursor_invalid', category: 'input', retryable: false }, context: { highWatermark: 2 } });
    expect(f.query(0, { cursor: { runId: 102, lastPersistedSequence: 0 } })).toMatchObject({ ok: false, error: { code: 'event_cursor_invalid' } });
    expect(f.query(0, { sessionId: 1 })).toMatchObject({ ok: false, error: { code: 'event_cursor_invalid' } });
    expect(f.query(0, { throughSequence: 3 })).toMatchObject({ ok: false, error: { code: 'event_cursor_invalid' } });
    expect(f.query(0, { limit: 101 })).toMatchObject({ ok: false, error: { code: 'input_invalid' }, context: null });
    expect(f.query(0, { runId: 999, cursor: { runId: 999, lastPersistedSequence: 0 } })).toMatchObject({ ok: false, error: { code: 'run_not_found' }, context: null });
    expect(f.db.query('SELECT * FROM runs WHERE id=101').get()).toEqual(before);
    expect(f.db.query('SELECT COUNT(*) AS count FROM runtime_events').get()).toEqual({ count: 2 });
  });

  it('delivers the continuous prefix before a gap and keeps C independent from explicit D', () => {
    const f = eventFixture();
    f.store.withTransaction(() => { f.store.appendInTransaction(f.created); f.start();
      f.db.query('UPDATE runs SET cancel_requested_at=? WHERE id=101').run(stamp);
      f.store.appendInTransaction({ ...f.created, type: 'run_cancel_requested', dedupeKey: 'run:cancel-requested',
        payload: { version: 1, requestedAt: stamp } }); });
    f.db.query('DELETE FROM runtime_events WHERE run_id=101 AND sequence=2').run();
    const prefix = f.query();
    expect(prefix).toMatchObject({ ok: true, data: { items: [{ sequence: 1 }], hasMore: true,
      nextCursor: { runId: 101, lastPersistedSequence: 1 }, nextAvailableAfterSequence: null } });
    const gap = f.query(1);
    expect(gap).toMatchObject({ ok: false, error: { code: 'event_gap', category: 'storage', retryable: false },
      context: { highWatermark: 3, gap: { fromSequence: 2, toSequence: 2, continueAfterSequence: 2 } } });
    expect(f.query(1, { throughSequence: 2 })).toMatchObject({ ok: false, error: { code: 'event_gap' },
      context: { gap: { fromSequence: 2, toSequence: 2, continueAfterSequence: 2 } } });
    const segment = f.query(1, { availableAfterSequence: 2 });
    expect(segment).toMatchObject({ ok: true, data: { items: [{ sequence: 3 }], hasMore: false,
      nextCursor: { runId: 101, lastPersistedSequence: 1 }, nextAvailableAfterSequence: 3 } });
    expect(f.query(1, { availableAfterSequence: 3 })).toMatchObject({ ok: true, data: { items: [],
      nextCursor: { lastPersistedSequence: 1 }, nextAvailableAfterSequence: 3 } });
    expect(f.query(1, { availableAfterSequence: 0 })).toMatchObject({ ok: false, error: { code: 'event_cursor_invalid' } });
    for (const result of [prefix, gap, segment]) expect(RuntimeEventsReadResultSchema.safeParse(result).success).toBe(true);
  });

  it('bounds the complete UTF-8 response and respects a frozen through position', () => {
    const f = eventFixture();
    f.store.withTransaction(() => {
      f.store.appendInTransaction(f.created); f.start();
      const cost = '汉'.repeat(1250);
      f.db.query('UPDATE runs SET cost=? WHERE id=101').run(cost);
      for (let i = 0; i < 100; i++) f.store.appendInTransaction({ runId: 101, sessionId: null, toolCallId: null,
        occurredAt: stamp, type: 'run_usage_updated', payload: { version: 1,
          tokens: { inputTokens: null, outputTokens: null, totalTokens: null, cost, usageComplete: false },
          attempts: null, attemptsComplete: false, source: 'unknown' } });
    });
    const first = f.query(2, { limit: 100 });
    expect(first.ok).toBe(true);
    if (!first.ok) return;
    expect(first.data.items.length).toBeGreaterThan(1);
    expect(first.data.items.length).toBeLessThan(100);
    expect(Buffer.byteLength(JSON.stringify(first), 'utf8')).toBeLessThanOrEqual(262144);
    expect(first.data.hasMore).toBe(true);
    const frozen = f.query(0, { throughSequence: 1 });
    expect(frozen).toMatchObject({ ok: true, data: { highWatermark: 102, items: [{ sequence: 1 }], hasMore: false } });
    expect(RuntimeEventsReadResultSchema.safeParse(first).success).toBe(true);
  });

  it('reports corrupted stored data instead of turning it into an empty page', () => {
    const f = eventFixture();
    f.store.withTransaction(() => f.store.appendInTransaction(f.created));
    f.db.query(`UPDATE runtime_events SET payload_json='{"version":1,"status":"created","origin":"live","stopped":null,"errorCode":null,"raw":"forbidden"}' WHERE run_id=101`).run();
    expect(f.query()).toMatchObject({ ok: false, error: { code: 'storage_corrupt', retryable: false }, context: { highWatermark: 1 } });
    f.db.close();
    expect(f.query()).toMatchObject({ ok: false, error: { code: 'storage_read_failed', retryable: true }, context: null });
  });

  it('never publishes from an unrelated outer transaction and isolates reentrant observers', () => {
    const f = eventFixture();
    expect(() => f.db.transaction(() => f.store.withTransaction(() => f.store.appendInTransaction(f.created)))()).toThrow('state_conflict');
    const seen: number[] = [];
    const removed = f.store.onCommitted(() => { throw new Error('sensitive observer details'); });
    const warnings: unknown[][] = [];
    const previous = console.warn;
    console.warn = (...args) => { warnings.push(args); };
    try {
      f.store.onCommitted(refs => { seen.push(...refs.map(ref => ref.sequence));
        if (refs[0]?.sequence === 1) f.store.withTransaction(f.start); });
      expect(f.store.withTransaction(() => f.store.appendInTransaction(f.created)).sequence).toBe(1);
      expect(seen).toEqual([1, 2]);
      expect(warnings).toEqual([['runtime_event_observer_failed'], ['runtime_event_observer_failed']]);
      removed(); removed();
    } finally { console.warn = previous; }
    expect(f.query()).toMatchObject({ ok: true, data: { highWatermark: 2 } });
  });
});
