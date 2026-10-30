import { expect, test } from 'bun:test';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { openDatabase } from '../../../packages/core/src/storage/database.ts';
import { bootstrapDatabase } from '../../../packages/core/src/storage/bootstrap.ts';
import type { SqlDatabaseStore } from '../../../packages/core/src/storage/database.ts';
import { testDatabase } from '../../support/database.ts';
import { mkdtempSync, deferCleanup } from '../../support/resources.ts';

const stamp = '2026-10-28T00:00:00.000Z';
test('formal DbHandle exposes the owner while keeping raw SQLite and root repositories inside storage', async () => {
  const { store } = fixture();
  try {
    expect(Object.keys(store).sort()).toEqual(['read', 'transaction', 'coordinator', 'runtimeEvents',
      'recoveryError', 'maxRunIdAtBoot', 'close'].sort());
    expect(Object.keys(store.coordinator).sort()).toEqual(['read', 'transaction']);
    expect(await store.read(scope => scope.db.query('SELECT version FROM schema_migrations ORDER BY version').all()))
      .toEqual(Array.from({ length: 21 }, (_, index) => ({ version: index + 1 })));
    expect(await store.transaction(scope => scope.sessions.create({ nativeSessionId: 'owner-only', title: 'Owner only', at: stamp })))
      .toMatchObject({ ok: true, data: { sessionId: 1 } });
    expect(await store.read(scope => scope.sessions.get(1))).toMatchObject({ ok: true, data: { nativeSessionId: 'owner-only' } });
  } finally { await store.close(); }
});

test('DbHandle rejects close reentry without disabling its existing event service', async () => {
  const { store } = fixture();
  try {
    await store.transaction(async scope => {
      scope.db.query(`INSERT INTO runs(id,kind,status,goal,input_json,config_json,cleanup_json,usage_json,created_at)
        VALUES (1,'provider','created','Close reentry','{"version":1,"text":"fixture"}','{}','{}','{}',?)`).run(stamp);
      await expect(store.close()).rejects.toMatchObject({ code: 'storage_queue_reentry' });
    });
    expect(await store.runtimeEvents.subscribe({ runId: 1, sessionId: null,
      cursor: { runId: 1, lastPersistedSequence: 0 } }, () => {})).toMatchObject({ ok: true, data: { coverage: 'none' } });
  } finally { await store.close(); }
});

test('the test storage view shares the exact owner connection without adding raw properties to the formal handle', async () => {
  const root = mkdtempSync(join(tmpdir(), 'flowmate-database-view-'));
  const opened = bootstrapDatabase({ root, databaseFile: join(root, 'data', 'app.sqlite'), logsDir: join(root, 'logs'),
    artifactsDir: join(root, 'artifacts'), outputsDir: join(root, 'outputs'), runtimeDir: join(root, 'runtime') });
  if (!opened.ok) throw Error(opened.error.code);
  const { owner } = opened.data, view = testDatabase(opened.data);
  const entered = Promise.withResolvers<void>(), release = Promise.withResolvers<void>();
  let intercepted = false, read = false;
  const transaction = view.transaction;
  view.transaction = operation => { intercepted = true; return transaction(operation); };
  const writing = owner.transaction(async scope => {
    const created = scope.sessions.create({ nativeSessionId: 'same-connection', title: 'Uncommitted session', at: stamp });
    if (!created.ok) throw Error(created.error.code);
    entered.resolve(); await release.promise;
  });
  try {
    await Promise.race([entered.promise, writing]);
    expect(intercepted).toBe(true);
    expect(view.db.inTransaction).toBe(true);
    expect(view.db.query('SELECT title FROM sessions WHERE id=1').get()).toEqual({ title: 'Uncommitted session' });
    expect(Object.hasOwn(owner, 'db')).toBe(false); expect(Object.hasOwn(owner, 'sessions')).toBe(false);
    const reading = owner.read(scope => { read = true; return scope.sessions.get(1); });
    await new Promise<void>(resolve => setImmediate(resolve)); expect(read).toBe(false);
    release.resolve(); await writing;
    expect(await reading).toMatchObject({ ok: true, data: { title: 'Uncommitted session' } });
  } finally { release.resolve(); await writing; await owner.close(); }
});

function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'flowmate-database-coordination-'));
  const paths = { root, databaseFile: join(root, 'data', 'app.sqlite'), logsDir: join(root, 'logs'),
    artifactsDir: join(root, 'artifacts'), outputsDir: join(root, 'outputs'), runtimeDir: join(root, 'runtime') };
  const opened = openDatabase(paths);
  if (!opened.ok) throw Error(opened.error.code);
  deferCleanup(() => opened.data.close());
  return { store: opened.data, paths };
}

test('DbHandle coordinates real legacy repositories through one live SQL scope', async () => {
  const { store } = fixture();
  expect(store.read).toBeFunction(); expect(store.transaction).toBeFunction();
  const entered = Promise.withResolvers<void>(), release = Promise.withResolvers<void>();
  let retained: SqlDatabaseStore | undefined;
  try {
    const first = store.transaction(async scope => {
      retained = scope;
      const created = scope.sessions.create({ nativeSessionId: 'coordinated-native', title: 'Created', at: stamp });
      expect(created).toMatchObject({ ok: true, data: { sessionId: 1 } });
      entered.resolve(); await release.promise;
    });
    await Promise.race([entered.promise, first]);
    let renamed = false, read = false;
    const second = store.transaction(scope => {
      const value = scope.sessions.rename({ sessionId: 1, title: 'Queued rename', at: stamp }); renamed = true; return value;
    });
    const snapshot = store.read(scope => { read = true; return scope.sessions.get(1); });
    await new Promise<void>(resolve => setImmediate(resolve));
    expect(renamed).toBe(false); expect(read).toBe(false);
    release.resolve(); await first;
    expect(await second).toMatchObject({ ok: true });
    expect(await snapshot).toMatchObject({ ok: true, data: { title: 'Queued rename' } });
    expect(() => retained!.db.query('SELECT 1').get()).toThrow('storage_executor_expired');
  } finally { release.resolve(); await store.close(); }
});

test('DbHandle event queries and subscriptions wait for the same confirmed product commit', async () => {
  const { store } = fixture();
  expect(store.transaction).toBeFunction();
  const entered = Promise.withResolvers<void>(), release = Promise.withResolvers<void>();
  const wakes: unknown[] = [];
  const request = { runId: 1, sessionId: null, cursor: { runId: 1, lastPersistedSequence: 0 } };
  try {
    const writing = store.transaction(async scope => {
      scope.db.query(`INSERT INTO runs(id,kind,status,goal,input_json,config_json,cleanup_json,usage_json,created_at)
        VALUES (1,'provider','created','Committed product event','{"version":1,"text":"fixture"}','{}','{}','{}',?)`).run(stamp);
      scope.runtimeEventStore.withTransaction(() => scope.runtimeEventStore.appendInTransaction({
        runId: 1, sessionId: null, toolCallId: null, type: 'run_created', dedupeKey: 'run:created', occurredAt: stamp,
        payload: { version: 1, status: 'created', origin: 'live', stopped: null, errorCode: null },
      }));
      entered.resolve(); await release.promise;
    });
    await Promise.race([entered.promise, writing]);
    let queried = false, subscribed = false;
    const subscription = store.runtimeEvents.subscribe(request, wake => wakes.push(wake)).then(value => { subscribed = true; return value; });
    const query = store.runtimeEvents.query(request).then(value => { queried = true; return value; });
    await new Promise<void>(resolve => setImmediate(resolve));
    expect(subscribed).toBe(false); expect(queried).toBe(false); expect(wakes).toEqual([]);
    release.resolve(); await writing;
    expect(await subscription).toMatchObject({ ok: true, data: { highWatermark: 1 } });
    expect(await query).toMatchObject({ ok: true, data: { highWatermark: 1, items: [{ sequence: 1, type: 'run_created' }] } });
    expect(wakes).toEqual([{ runId: 1, sequence: 1 }]);
    const failed = new Error('rollback product event');
    await expect(store.transaction(scope => {
      scope.db.query('UPDATE runs SET cancel_requested_at=? WHERE id=1').run(stamp);
      scope.runtimeEventStore.withTransaction(() => scope.runtimeEventStore.appendInTransaction({
        runId: 1, sessionId: null, toolCallId: null, type: 'run_cancel_requested', dedupeKey: 'run:cancel-requested',
        occurredAt: stamp, payload: { version: 1, requestedAt: stamp },
      }));
      throw failed;
    })).rejects.toBe(failed);
    expect(await store.runtimeEvents.query(request)).toMatchObject({ ok: true, data: { highWatermark: 1 } });
    expect(wakes).toEqual([{ runId: 1, sequence: 1 }]);
  } finally { release.resolve(); await store.close(); }
});

test('DbHandle close drains admitted transactions before releasing the actual database connection', async () => {
  const { store, paths } = fixture();
  expect(store.transaction).toBeFunction();
  const entered = Promise.withResolvers<void>(), release = Promise.withResolvers<void>();
  const writing = store.transaction(async scope => { entered.resolve(); await release.promise; scope.db.exec('CREATE TABLE final_product_write(id INTEGER)'); });
  await entered.promise;
  let firstClosed = false, secondClosed = false;
  const first = store.close().then(() => { firstClosed = true; });
  const second = store.close().then(() => { secondClosed = true; });
  try {
    await new Promise<void>(resolve => setImmediate(resolve));
    expect(firstClosed).toBe(false); expect(secondClosed).toBe(false);
    await expect(store.read(scope => scope.sessions.get(1))).rejects.toMatchObject({ code: 'storage_coordinator_closed' });
  } finally { release.resolve(); await writing; await Promise.all([first, second]); }
  const reopened = openDatabase(paths);
  if (!reopened.ok) throw Error(reopened.error.code);
  try { expect(await reopened.data.read(scope => scope.db.query("SELECT name FROM sqlite_master WHERE name='final_product_write'").get()))
    .toEqual({ name: 'final_product_write' }); }
  finally { await reopened.data.close(); }
});
