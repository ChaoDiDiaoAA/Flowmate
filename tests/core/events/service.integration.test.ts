import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { describe, expect, it, spyOn } from 'bun:test';
import { RuntimeEventsReadResultSchema } from '@flowmate/contracts';
import type { RuntimeEventSubscription, RuntimeEventsAvailable, RuntimeEventsQuery } from '@flowmate/contracts';
import { createEventService } from '../../../packages/core/src/events/service.ts';
import { createRuntimeEventStore } from '../../../packages/core/src/events/store.ts';
import type { CommittedEventRef } from '../../../packages/core/src/events/store.ts';
import { openDatabase } from '../../../packages/core/src/storage/database.ts';
import { deferCleanup, mkdtempSync } from '../../support/resources.ts';

const stamp = '2026-10-03T00:00:00.000Z';
function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'flowmate-p6-event-service-'));
  const opened = openDatabase({ root, databaseFile: join(root, 'data', 'app.sqlite'), logsDir: join(root, 'logs'),
    artifactsDir: join(root, 'artifacts'), outputsDir: join(root, 'outputs'), runtimeDir: join(root, 'runtime') });
  if (!opened.ok) throw new Error(opened.error.code);
  deferCleanup(() => opened.data.close());
  const db = opened.data.db;
  db.query(`INSERT INTO runs(id,kind,status,goal,input_json,config_json,cleanup_json,usage_json,created_at)
    VALUES (1,'provider','created','Event observation','{"version":1,"text":"fixture"}','{}','{}','{}',?)`).run(stamp);
  const store = createRuntimeEventStore(db);
  function created() {
    return store.withTransaction(() => store.appendInTransaction({ runId: 1, sessionId: null, toolCallId: null,
      type: 'run_created', dedupeKey: 'run:created', occurredAt: stamp,
      payload: { version: 1, status: 'created', origin: 'live', stopped: null, errorCode: null } }));
  }
  function usage(total: number, runId = 1, cost: string | null = null) {
    return store.withTransaction(() => {
      db.query('UPDATE runs SET input_tokens=?,output_tokens=0,total_tokens=?,cost=?,usage_complete=1,usage_json=? WHERE id=?')
        .run(total, total, cost, JSON.stringify({ attempts: total, attemptsComplete: true, source: 'sdk' }), runId);
      return store.appendInTransaction({ runId, sessionId: null, toolCallId: null,
        type: 'run_usage_updated', occurredAt: stamp, payload: { version: 1, attempts: total, attemptsComplete: true,
          source: 'sdk', tokens: { inputTokens: total, outputTokens: 0, totalTokens: total, cost, usageComplete: true } } });
    });
  }
  const request = (sequence = 0): RuntimeEventsQuery => ({ runId: 1, sessionId: null,
    cursor: { runId: 1, lastPersistedSequence: sequence } });
  return { db, store, created, usage, request };
}

describe('P6 EventService', () => {
  it('registers before reading H and preserves commits during catch up', async () => {
    const { store, created, usage, request } = fixture();
    created();
    for (let total = 1; total <= 9; total += 1) usage(total);
    let queries = 0;
    const service = createEventService({ ...store, query(input) {
      const result = store.query(input);
      queries += 1;
      // Real COMMIT at the synchronous H/open handoff, before subscribe returns.
      if (queries === 1) usage(10);
      // Real COMMIT while the caller is paging the fixed (C,H] prefix.
      if (queries === 2) usage(11);
      return result;
    } });
    deferCleanup(() => service.close());
    const wakes: RuntimeEventsAvailable[] = [];
    const opened = service.subscribe(request(), wake => wakes.push(wake));
    expect(opened).toMatchObject({ ok: true, data: { highWatermark: 10,
      availableRange: { fromSequence: 1, toSequence: 10 }, coverage: 'from-created' } });
    if (!opened.ok) throw new Error(opened.error.code);
    await Promise.resolve();
    expect(wakes).toEqual([{ runId: 1, sequence: 11 }]);
    let cursor = request().cursor;
    const seen: number[] = [];
    for (;;) {
      const result = service.query({ ...request(), cursor, throughSequence: opened.data.highWatermark, limit: 3 });
      if (!result.ok) throw new Error(result.error.code);
      seen.push(...result.data.items.map(event => event.sequence));
      cursor = result.data.nextCursor;
      if (!result.data.hasMore) break;
    }
    expect(seen).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 10]);
    const live = service.query({ ...request(), cursor });
    expect(live).toMatchObject({ ok: true, data: { items: [{ sequence: 11 }, { sequence: 12 }],
      nextCursor: { runId: 1, lastPersistedSequence: 12 }, hasMore: false } });
    if (!live.ok) throw new Error(live.error.code);
    seen.push(...live.data.items.map(event => event.sequence));
    expect(seen).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12]);
    await Promise.resolve();
    expect(wakes).toEqual([{ runId: 1, sequence: 11 }, { runId: 1, sequence: 12 }]);
  });

  it('bounds observation at 64 and releases capacity on unsubscribe and close', () => {
    const { store, request } = fixture();
    let listeners = 0;
    const service = createEventService({ ...store, onCommitted(listener) {
      listeners += 1;
      const detach = store.onCommitted(listener);
      return () => { listeners -= 1; detach(); };
    } });
    deferCleanup(() => service.close());
    const subscriptions: RuntimeEventSubscription[] = [];
    for (let index = 0; index < 64; index += 1) {
      const opened = service.subscribe(request(), () => {});
      if (!opened.ok) throw new Error(opened.error.code);
      subscriptions.push(opened.data);
    }
    expect(listeners).toBe(64);
    expect(service.subscribe(request(), () => {})).toMatchObject({ ok: false,
      error: { code: 'event_subscription_limit', category: 'runtime', retryable: false } });
    expect(listeners).toBe(64);
    subscriptions[0]!.unsubscribe();
    subscriptions[0]!.unsubscribe();
    expect(listeners).toBe(63);
    expect(service.subscribe(request(), () => {})).toMatchObject({ ok: true, data: { highWatermark: 0, coverage: 'none' } });
    expect(listeners).toBe(64);
    service.close();
    service.close();
    subscriptions[1]!.unsubscribe();
    expect(listeners).toBe(0);
    expect(service.subscribe(request(), () => {})).toMatchObject({ ok: false,
      error: { code: 'event_subscription_invalid', category: 'input', retryable: false } });
    expect(listeners).toBe(0);
    expect(service.query(request())).toMatchObject({ ok: true, data: { coverage: 'none', items: [] } });
  });

  it('opens a legal gap observation and keeps the continuous cursor independent from explicit display position', () => {
    const { db, store, created, usage, request } = fixture();
    created(); usage(1); usage(2);
    const missing = db.query('SELECT * FROM runtime_events WHERE run_id=1 AND sequence=2').get() as Record<string, unknown>;
    db.query('DELETE FROM runtime_events WHERE run_id=1 AND sequence=2').run();
    const service = createEventService(store);
    deferCleanup(() => service.close());
    const prefix = service.query(request());
    expect(prefix).toMatchObject({ ok: true, data: { items: [{ sequence: 1 }], hasMore: true,
      nextCursor: { runId: 1, lastPersistedSequence: 1 }, nextAvailableAfterSequence: null } });
    const opened = service.subscribe(request(1), () => {});
    expect(opened).toMatchObject({ ok: true, data: { runId: 1, sessionId: null, highWatermark: 3,
      availableRange: { fromSequence: 1, toSequence: 3 }, coverage: 'from-created' } });
    if (!opened.ok) throw new Error(opened.error.code);
    expect(opened.data).not.toHaveProperty('gap');
    expect(opened.data).not.toHaveProperty('items');
    const gap = service.query(request(1));
    expect(gap).toMatchObject({ ok: false, error: { code: 'event_gap', category: 'storage', retryable: false },
      context: { highWatermark: 3, gap: { fromSequence: 2, toSequence: 2, continueAfterSequence: 2 } } });
    const segment = service.query({ ...request(1), availableAfterSequence: 2 });
    expect(segment).toMatchObject({ ok: true, data: { items: [{ sequence: 3 }], hasMore: false,
      nextCursor: { runId: 1, lastPersistedSequence: 1 }, nextAvailableAfterSequence: 3 } });
    expect(service.query({ ...request(1), availableAfterSequence: 3 })).toMatchObject({ ok: true, data: { items: [],
      nextCursor: { runId: 1, lastPersistedSequence: 1 }, nextAvailableAfterSequence: 3 } });
    usage(3); usage(4);
    db.query('DELETE FROM runtime_events WHERE run_id=1 AND sequence=4').run();
    expect(service.query({ ...request(1), availableAfterSequence: 2 })).toMatchObject({ ok: true,
      data: { items: [{ sequence: 3 }], hasMore: true, nextCursor: { lastPersistedSequence: 1 }, nextAvailableAfterSequence: 3 } });
    expect(service.query({ ...request(1), availableAfterSequence: 3 })).toMatchObject({ ok: false,
      error: { code: 'event_gap' }, context: { gap: { fromSequence: 4, toSequence: 4, continueAfterSequence: 4 } } });
    const columns = Object.keys(missing);
    db.query(`INSERT INTO runtime_events(${columns.join(',')}) VALUES(${columns.map(() => '?').join(',')})`)
      .run(...Object.values(missing) as Array<string | number | null>);
    const runBefore = db.query('SELECT * FROM runs WHERE id=1').get();
    const eventsBefore = db.query('SELECT * FROM runtime_events WHERE run_id=1 ORDER BY sequence').all();
    expect(service.query(request(1))).toMatchObject({ ok: true, data: { items: [{ sequence: 2 }, { sequence: 3 }],
      hasMore: true, nextCursor: { lastPersistedSequence: 3 }, nextAvailableAfterSequence: null } });
    for (const result of [prefix, gap, segment]) expect(RuntimeEventsReadResultSchema.safeParse(result).success).toBe(true);
    expect(db.query('SELECT * FROM runs WHERE id=1').get()).toEqual(runBefore);
    expect(db.query('SELECT * FROM runtime_events WHERE run_id=1 ORDER BY sequence').all()).toEqual(eventsBefore);
  });

  it('rejects query-only or untrusted subscription fields and releases failed opens', async () => {
    const { db, store, created, request } = fixture();
    let listeners = 0;
    const service = createEventService({ ...store, onCommitted(listener) {
      listeners += 1;
      const detach = store.onCommitted(listener);
      return () => { listeners -= 1; detach(); };
    } });
    deferCleanup(() => service.close());
    for (const extra of [{ throughSequence: 0 }, { limit: 1 }, { availableAfterSequence: 0 },
      { subscriptionId: 'transport-only' }, { owner: 'untrusted' }]) {
      expect(service.subscribe({ ...request(), ...extra }, () => {})).toMatchObject({ ok: false,
        error: { code: 'input_invalid', category: 'input', retryable: false } });
      expect(listeners).toBe(0);
    }
    for (const input of [request(-1), request(1), { ...request(), cursor: { runId: 2, lastPersistedSequence: 0 } },
      { ...request(), sessionId: 1 }]) {
      expect(service.subscribe(input, () => {})).toMatchObject({ ok: false,
        error: { code: 'event_cursor_invalid', category: 'input', retryable: false } });
      expect(listeners).toBe(0);
    }
    created();
    db.query(`UPDATE runtime_events SET payload_json='{"version":1,"status":"created","origin":"live","stopped":null,"errorCode":null,"secret":"forbidden"}' WHERE run_id=1`).run();
    expect(service.subscribe(request(), () => {})).toMatchObject({ ok: false,
      error: { code: 'storage_corrupt', category: 'storage', retryable: false } });
    expect(listeners).toBe(0);
    db.close();
    expect(service.subscribe(request(), () => {})).toMatchObject({ ok: false,
      error: { code: 'storage_read_failed', category: 'storage', retryable: true } });
    expect(listeners).toBe(0);
    await Promise.resolve();
    expect(listeners).toBe(0);
  });

  it('uses reordered duplicate and lost wakes only as a hint while coalescing pressure', async () => {
    const { db, store, created, usage, request } = fixture();
    let deliver: ((refs: readonly CommittedEventRef[]) => void) | undefined;
    const committed: CommittedEventRef[] = [];
    const service = createEventService({ ...store, onCommitted(listener) {
      deliver = listener;
      return store.onCommitted(refs => committed.push(...refs));
    } });
    deferCleanup(() => service.close());
    const wakes: RuntimeEventsAvailable[] = [];
    expect(service.subscribe(request(), wake => wakes.push(wake)).ok).toBe(true);
    created(); usage(1);
    const notify = deliver!;
    notify([committed[1]!]);
    notify([committed[0]!]);
    notify([committed[1]!]);
    expect(wakes).toEqual([]);
    await Promise.resolve();
    expect(wakes).toEqual([{ runId: 1, sequence: 2 }]);
    notify([committed[0]!, committed[1]!]);
    await Promise.resolve();
    expect(wakes).toHaveLength(1);
    expect(service.query(request())).toMatchObject({ ok: true, data: { items: [{ sequence: 1 }, { sequence: 2 }],
      nextCursor: { lastPersistedSequence: 2 } } });
    usage(2); // Drop the final actual commit's wake, with no following notification.
    await Promise.resolve();
    expect(wakes).toHaveLength(1);
    const before = db.query('SELECT * FROM runs WHERE id=1').get();
    const totalChanges = db.query('SELECT total_changes() AS count').get();
    expect(service.query(request(2))).toMatchObject({ ok: true, data: { items: [{ sequence: 3 }],
      nextCursor: { lastPersistedSequence: 3 }, hasMore: false } });
    expect(db.query('SELECT * FROM runs WHERE id=1').get()).toEqual(before);
    expect(db.query('SELECT total_changes() AS count').get()).toEqual(totalChanges);
    for (let total = 3; total <= 40; total += 1) {
      usage(total);
      notify([committed.at(-1)!]);
    }
    expect(wakes).toHaveLength(1);
    await Promise.resolve();
    expect(wakes).toEqual([{ runId: 1, sequence: 2 }, { runId: 1, sequence: 41 }]);
  });

  it('isolates throwing and asynchronous observers from commits and other Run subscriptions', async () => {
    const { db, store, created, usage, request } = fixture();
    created();
    db.query(`INSERT INTO runs(id,kind,status,goal,input_json,config_json,output_json,cleanup_json,usage_json,
      created_at,ended_at,stopped_at) VALUES (2,'provider','completed','Other observed Run','{}','{}','{}','{}','{}',?,?,?)`)
      .run(stamp, stamp, stamp);
    const service = createEventService(store);
    deferCleanup(() => service.close());
    const warning = spyOn(console, 'warn').mockImplementation(() => {});
    deferCleanup(() => warning.mockRestore());
    const runOne: RuntimeEventsAvailable[] = [];
    const runTwo: RuntimeEventsAvailable[] = [];
    let releaseObserver!: () => void;
    expect(service.subscribe(request(), () => { throw new Error('private observer data'); }).ok).toBe(true);
    expect(service.subscribe(request(), () => new Promise<void>(resolve => { releaseObserver = resolve; })).ok).toBe(true);
    expect(service.subscribe(request(), wake => runOne.push(wake)).ok).toBe(true);
    expect(service.subscribe({ runId: 2, sessionId: null, cursor: { runId: 2, lastPersistedSequence: 0 } },
      wake => runTwo.push(wake)).ok).toBe(true);
    expect(usage(1)).toMatchObject({ runId: 1, sequence: 2 });
    expect(usage(1, 2)).toMatchObject({ runId: 2, sequence: 1 });
    expect(runOne).toEqual([]);
    await Promise.resolve();
    expect(warning.mock.calls).toEqual([['runtime_event_observer_failed']]);
    expect(runOne).toEqual([{ runId: 1, sequence: 2 }]);
    expect(runTwo).toEqual([{ runId: 2, sequence: 1 }]);
    expect(service.query(request(1))).toMatchObject({ ok: true, data: { items: [{ sequence: 2 }] } });
    releaseObserver();
    warning.mockImplementation(() => { throw new Error('diagnostic sink failure'); });
    expect(usage(2)).toMatchObject({ runId: 1, sequence: 3 });
    await Promise.resolve();
    expect(runOne).toEqual([{ runId: 1, sequence: 2 }, { runId: 1, sequence: 3 }]);
    expect(runTwo).toEqual([{ runId: 2, sequence: 1 }]);
    expect(service.query(request(2))).toMatchObject({ ok: true, data: { items: [{ sequence: 3 }] } });
    releaseObserver();
  });

  it('suppresses queued wakes when observation is closed or its opening fails', async () => {
    const { store, created, usage, request } = fixture();
    created();
    const service = createEventService(store);
    deferCleanup(() => service.close());
    const wakes: RuntimeEventsAvailable[] = [];
    const opened = service.subscribe(request(), wake => wakes.push(wake));
    if (!opened.ok) throw new Error(opened.error.code);
    usage(1);
    opened.data.unsubscribe();
    opened.data.unsubscribe();
    await Promise.resolve();
    expect(wakes).toEqual([]);
    expect(service.subscribe(request(), wake => wakes.push(wake)).ok).toBe(true);
    usage(2);
    service.close();
    await Promise.resolve();
    expect(wakes).toEqual([]);

    let listeners = 0;
    const failedService = createEventService({ ...store, query(input) {
      const result = store.query(input);
      usage(3); // Commit after the failing H read, while the registration still exists.
      return result;
    }, onCommitted(listener) {
      listeners += 1;
      const detach = store.onCommitted(listener);
      return () => { listeners -= 1; detach(); };
    } });
    deferCleanup(() => failedService.close());
    expect(failedService.subscribe(request(-1), wake => wakes.push(wake))).toMatchObject({ ok: false,
      error: { code: 'event_cursor_invalid' } });
    expect(listeners).toBe(0);
    await Promise.resolve();
    expect(wakes).toEqual([]);
  });

  it('delegates bounded UTF-8 pages without losing events or changing stored Run facts', () => {
    const { db, store, created, usage, request } = fixture();
    created();
    const cost = '汉'.repeat(1250);
    for (let total = 1; total <= 101; total += 1) usage(total, 1, cost);
    const service = createEventService(store);
    deferCleanup(() => service.close());
    const before = db.query('SELECT * FROM runs WHERE id=1').get();
    const totalChanges = db.query('SELECT total_changes() AS count').get();
    const defaultPage = service.query(request());
    expect(defaultPage).toMatchObject({ ok: true, data: { hasMore: true, highWatermark: 102 } });
    if (!defaultPage.ok) throw new Error(defaultPage.error.code);
    expect(defaultPage.data.items).toHaveLength(50);
    const largePage = service.query({ ...request(), limit: 100 });
    if (!largePage.ok) throw new Error(largePage.error.code);
    expect(largePage.data.items.length).toBeGreaterThan(50);
    expect(largePage.data.items.length).toBeLessThan(100);
    expect(Buffer.byteLength(JSON.stringify(largePage), 'utf8')).toBeLessThanOrEqual(256 * 1024);
    const seen = largePage.data.items.map(event => event.sequence);
    let cursor = largePage.data.nextCursor;
    for (;;) {
      const result = service.query({ ...request(), cursor, limit: 100 });
      if (!result.ok) throw new Error(result.error.code);
      expect(Buffer.byteLength(JSON.stringify(result), 'utf8')).toBeLessThanOrEqual(256 * 1024);
      expect(RuntimeEventsReadResultSchema.safeParse(result).success).toBe(true);
      seen.push(...result.data.items.map(event => event.sequence));
      cursor = result.data.nextCursor;
      if (!result.data.hasMore) break;
    }
    expect(seen).toHaveLength(102);
    expect(seen[0]).toBe(1);
    expect(seen.at(-1)).toBe(102);
    expect(new Set(seen).size).toBe(102);
    expect(service.query({ ...request(), throughSequence: 3 })).toMatchObject({ ok: true,
      data: { highWatermark: 102, items: [{ sequence: 1 }, { sequence: 2 }, { sequence: 3 }], hasMore: false } });
    expect(service.query({ ...request(2), throughSequence: 1 })).toMatchObject({ ok: false,
      error: { code: 'event_cursor_invalid' } });
    expect(service.query({ ...request(), throughSequence: 103 })).toMatchObject({ ok: false,
      error: { code: 'event_cursor_invalid' } });
    expect(db.query('SELECT * FROM runs WHERE id=1').get()).toEqual(before);
    expect(db.query('SELECT total_changes() AS count').get()).toEqual(totalChanges);
  });

  it('keeps no-event and recovery-only history honest without inventing a created event', () => {
    const { db, store, request } = fixture();
    const service = createEventService(store);
    deferCleanup(() => service.close());
    expect(service.subscribe(request(), () => {})).toMatchObject({ ok: true,
      data: { highWatermark: 0, availableRange: null, coverage: 'none' } });
    expect(service.query(request())).toMatchObject({ ok: true,
      data: { items: [], highWatermark: 0, availableRange: null, coverage: 'none', nextCursor: { lastPersistedSequence: 0 } } });
    store.withTransaction(() => {
      db.query(`UPDATE runs SET status='failed',ended_at=?,error_json='{"code":"controller_interrupted"}',
        cleanup_json='{"stopped":false}' WHERE id=1`).run(stamp);
      store.appendInTransaction({ runId: 1, sessionId: null, toolCallId: null, type: 'run_failed',
        dedupeKey: 'run:terminal', occurredAt: stamp, payload: { version: 1, status: 'failed', origin: 'recovery',
          stopped: false, errorCode: 'controller_interrupted' } });
    });
    expect(service.query(request())).toMatchObject({ ok: true, data: { highWatermark: 1, coverage: 'partial',
      items: [{ sequence: 1, type: 'run_failed', payload: { origin: 'recovery', status: 'failed' } }],
      nextCursor: { lastPersistedSequence: 1 } } });
    expect(db.query('SELECT type FROM runtime_events WHERE run_id=1').all()).toEqual([{ type: 'run_failed' }]);
  });
});
