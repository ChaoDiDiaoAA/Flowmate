import { expect, test } from 'bun:test';
import { Database } from 'bun:sqlite';
import * as core from '../../../packages/core/src/index.ts';

test('database coordination preserves multi-statement SQL literals and rolls back a later statement failure', async () => {
  const coordinator = core.createDatabaseCoordinator(new Database(':memory:'));
  try {
    await coordinator.transaction(async sql => { await sql.exec('CREATE TABLE values_seen (id INTEGER PRIMARY KEY, value TEXT)'); });
    await coordinator.transaction(async sql => { await sql.exec("INSERT INTO values_seen VALUES (1,'a;b'); INSERT INTO values_seen VALUES (2,'c')"); });
    await expect(coordinator.transaction(async sql => {
      await sql.exec("INSERT INTO values_seen VALUES (3,'new'); INSERT INTO values_seen VALUES (3,'duplicate')");
    })).rejects.toThrow();
    expect(await coordinator.read(sql => sql.all('SELECT * FROM values_seen ORDER BY id'))).toEqual([{ id: 1, value: 'a;b' }, { id: 2, value: 'c' }]);
  } finally { await coordinator.close(); }
});


test('database coordination keeps unrelated reads and writes outside a transaction that crosses await', async () => {
  expect(core.createDatabaseCoordinator).toBeFunction();
  const db = new Database(':memory:'), coordinator = core.createDatabaseCoordinator(db);
  const entered = Promise.withResolvers<void>(), release = Promise.withResolvers<void>();
  try {
    await coordinator.transaction(async sql => { await sql.exec('CREATE TABLE values_seen (id INTEGER PRIMARY KEY)'); });
    const first = coordinator.transaction(async sql => {
      await sql.run('INSERT INTO values_seen VALUES (?)', 1); entered.resolve(); await release.promise;
      await sql.run('INSERT INTO values_seen VALUES (?)', 2);
    });
    await entered.promise;
    let secondDone = false, readDone = false;
    const second = coordinator.transaction(async sql => { await sql.run('INSERT INTO values_seen VALUES (?)', 3); secondDone = true; });
    const reading = coordinator.read(async sql => { const rows = await sql.all<{ id: number }>('SELECT id FROM values_seen ORDER BY id'); readDone = true; return rows; });
    await new Promise<void>(resolve => setImmediate(resolve));
    expect(secondDone).toBe(false); expect(readDone).toBe(false);
    release.resolve(); await first; await second;
    expect(await reading).toEqual([{ id: 1 }, { id: 2 }, { id: 3 }]);
  } finally { release.resolve(); await coordinator.close(); }
});

test('database coordination rolls back a failed callback and preserves the original error without poisoning later work', async () => {
  expect(core.createDatabaseCoordinator).toBeFunction();
  const db = new Database(':memory:'), coordinator = core.createDatabaseCoordinator(db), failure = new Error('controlled callback failure');
  try {
    await coordinator.transaction(async sql => { await sql.exec('CREATE TABLE values_seen (id INTEGER PRIMARY KEY)'); });
    await expect(coordinator.transaction(async sql => {
      await sql.run('INSERT INTO values_seen VALUES (?)', 1); throw failure;
    })).rejects.toBe(failure);
    expect(db.inTransaction).toBe(false);
    expect(await coordinator.read(sql => sql.all('SELECT id FROM values_seen'))).toEqual([]);
    await coordinator.transaction(async sql => { await sql.run('INSERT INTO values_seen VALUES (?)', 2); });
    expect(await coordinator.read(sql => sql.get<{ id: number }>('SELECT id FROM values_seen'))).toEqual({ id: 2 });
  } finally { await coordinator.close(); }
});

test('database coordination rejects queue reentry and executor use outside its live callback', async () => {
  expect(core.createDatabaseCoordinator).toBeFunction();
  const coordinator = core.createDatabaseCoordinator(new Database(':memory:'));
  const entered = Promise.withResolvers<void>(), release = Promise.withResolvers<void>();
  let executor: core.DatabaseExecutor | undefined;
  try {
    const running = coordinator.transaction(async sql => {
      executor = sql;
      await expect(coordinator.read(other => other.get('SELECT 1'))).rejects.toMatchObject({ code: 'storage_queue_reentry' });
      await expect(coordinator.transaction(async () => undefined)).rejects.toMatchObject({ code: 'storage_queue_reentry' });
      await expect(coordinator.close()).rejects.toMatchObject({ code: 'storage_queue_reentry' });
      entered.resolve(); await release.promise;
      expect(await sql.get<{ n: number }>('SELECT 1 AS n')).toEqual({ n: 1 });
    });
    await entered.promise;
    if (!executor) throw Error('Executor was not observed');
    await expect(executor.get('SELECT 1')).rejects.toMatchObject({ code: 'storage_executor_scope_mismatch' });
    release.resolve(); await running;
    await expect(executor.get('SELECT 1')).rejects.toMatchObject({ code: 'storage_executor_expired' });
  } finally { release.resolve(); await coordinator.close(); }
}, 5000);

test('database coordination close waits for admitted work and never acknowledges a concurrent close early', async () => {
  expect(core.createDatabaseCoordinator).toBeFunction();
  const db = new Database(':memory:'), coordinator = core.createDatabaseCoordinator(db);
  const entered = Promise.withResolvers<void>(), release = Promise.withResolvers<void>();
  const running = coordinator.transaction(async sql => { entered.resolve(); await release.promise; await sql.exec('CREATE TABLE final_write (id INTEGER)'); });
  await entered.promise;
  let firstDone = false, secondDone = false;
  const first = coordinator.close().then(() => { firstDone = true; });
  const second = coordinator.close().then(() => { secondDone = true; });
  try {
    await new Promise<void>(resolve => setImmediate(resolve));
    expect(firstDone).toBe(false); expect(secondDone).toBe(false);
    await expect(coordinator.read(sql => sql.get('SELECT 1'))).rejects.toMatchObject({ code: 'storage_coordinator_closed' });
  } finally { release.resolve(); await running; await Promise.all([first, second]); }
  expect(firstDone).toBe(true); expect(secondDone).toBe(true);
  expect(() => db.query('SELECT 1').get()).toThrow();
});

test('database coordination reports an uncertain rollback distinctly and blocks further work', async () => {
  expect(core.createDatabaseCoordinator).toBeFunction();
  const db = new Database(':memory:'), coordinator = core.createDatabaseCoordinator(db), failure = new Error('failure after unmanaged commit');
  try {
    let observed: unknown;
    try {
      await coordinator.transaction(async sql => {
        await sql.exec('CREATE TABLE committed_value (id INTEGER)');
        await sql.run('INSERT INTO committed_value VALUES (1)');
        await sql.exec('COMMIT');
        throw failure;
      });
    } catch (error) { observed = error; }
    expect(observed).toBeInstanceOf(AggregateError);
    expect(observed).not.toBe(failure);
    if (!(observed instanceof AggregateError)) throw Error('Missing rollback uncertainty');
    expect(observed.errors[0]).toBe(failure);
    await expect(coordinator.read(sql => sql.get('SELECT 1'))).rejects.toMatchObject({ code: 'storage_coordinator_failed' });
  } finally { await coordinator.close(); }
});
