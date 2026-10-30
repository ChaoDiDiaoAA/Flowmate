import { expect, test } from 'bun:test';
import { Database } from 'bun:sqlite';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createDatabaseCoordinator } from '../../../packages/core/src/storage/write-coordinator.ts';
import type { SynchronousDatabaseExecutor } from '../../../packages/core/src/storage/write-coordinator.ts';
import { createManagedFileContents } from '../../../packages/core/src/storage/managed-file-contents.ts';
import { createRuntimeEventStore } from '../../../packages/core/src/events/store.ts';
import { openTestDatabase as openDatabase } from '../../support/database.ts';

test('legacy managed contents use the current SQL executor and retained access expires with its callback', async () => {
  const coordinator = createDatabaseCoordinator(new Database(':memory:'));
  const owner = { ownerKind: 'document', ownerId: '1', relativePath: 'parsed.txt' };
  let retained: ReturnType<typeof createManagedFileContents> | undefined;
  try {
    await coordinator.transaction(async executor => {
      expect(executor.synchronous).toBeDefined();
      const sql = executor.synchronous;
      sql.exec('CREATE TABLE managed_file_contents(owner_kind TEXT,owner_id TEXT,relative_path TEXT,content BLOB,PRIMARY KEY(owner_kind,owner_id,relative_path))');
      const contents = createManagedFileContents(sql); retained = contents;
      contents.remember(owner, new Uint8Array([1, 2, 3]));
      expect(contents.read(owner)).toEqual(new Uint8Array([1, 2, 3]));
      expect(() => contents.remember(owner, new Uint8Array([4]))).toThrow('managed_file_content_conflict');
      await Promise.resolve();
      expect(contents.read(owner)).toEqual(new Uint8Array([1, 2, 3]));
    });
    expect(() => retained!.read(owner)).toThrow('storage_executor_expired');
    expect(await coordinator.read(executor => createManagedFileContents(executor.synchronous).read(owner)))
      .toEqual(new Uint8Array([1, 2, 3]));
  } finally { await coordinator.close(); }
});

test('legacy prepared statements and nested transactions cannot escape their live coordinator scope', async () => {
  const coordinator = createDatabaseCoordinator(new Database(':memory:'));
  const entered = Promise.withResolvers<void>(), release = Promise.withResolvers<void>();
  let statement: ReturnType<SynchronousDatabaseExecutor['query']> | undefined;
  let nested: ReturnType<SynchronousDatabaseExecutor['transaction']> | undefined;
  try {
    const running = coordinator.transaction(async executor => {
      expect(executor.synchronous).toBeDefined();
      statement = executor.synchronous.query('SELECT 1 AS n');
      nested = executor.synchronous.transaction(() => statement!.get());
      entered.resolve(); await release.promise;
      expect(nested()).toEqual({ n: 1 });
    });
    await Promise.race([entered.promise, running]);
    expect(() => statement!.get()).toThrow('storage_executor_scope_mismatch');
    expect(() => nested!()).toThrow('storage_executor_scope_mismatch');
    release.resolve(); await running;
    expect(() => statement!.all()).toThrow('storage_executor_expired');
    expect(() => nested!.immediate()).toThrow('storage_executor_expired');
  } finally { release.resolve(); await coordinator.close(); }
});

test('real product events publish only after the coordinated outer COMMIT and disappear on outer or savepoint rollback', async () => {
  const root = mkdtempSync(join(tmpdir(), 'flowmate-coordinated-events-'));
  const opened = openDatabase({ root, databaseFile: join(root, 'data', 'app.sqlite'), logsDir: join(root, 'logs'),
    artifactsDir: join(root, 'artifacts'), outputsDir: join(root, 'outputs'), runtimeDir: join(root, 'runtime') });
  if (!opened.ok) throw new Error(opened.error.code);
  const coordinator = opened.data.coordinator, published: number[] = [];
  const entered = Promise.withResolvers<void>(), release = Promise.withResolvers<void>();
  const stamp = '2026-10-28T00:00:00.000Z';
  const write = (sql: SynchronousDatabaseExecutor, total: number) => {
    if (total === 1) sql.query(`INSERT INTO runs(id,kind,status,goal,input_json,config_json,cleanup_json,usage_json,created_at)
      VALUES (1,'provider','created','Coordinated event','{"version":1,"text":"fixture"}','{}','{}','{}',?)`).run(stamp);
    sql.query('UPDATE runs SET input_tokens=?,output_tokens=0,total_tokens=?,usage_complete=1,usage_json=? WHERE id=1')
      .run(total, total, JSON.stringify({ source: 'sdk', attempts: total, attemptsComplete: true }));
    const events = createRuntimeEventStore(sql);
    events.onCommitted(refs => { expect(opened.data.db.inTransaction).toBe(false); published.push(...refs.map(ref => ref.sequence)); });
    events.withTransaction(() => events.appendInTransaction({ runId: 1, sessionId: null, toolCallId: null,
      type: 'run_usage_updated', occurredAt: stamp, payload: { version: 1, source: 'sdk', attempts: total,
        attemptsComplete: true, tokens: { inputTokens: total, outputTokens: 0, totalTokens: total, cost: null, usageComplete: true } } }));
  };
  try {
    const first = coordinator.transaction(async executor => {
      expect(executor.synchronous).toBeDefined();
      write(executor.synchronous, 1); entered.resolve(); await release.promise;
      expect(published).toEqual([]);
    });
    await Promise.race([entered.promise, first]);
    expect(published).toEqual([]); release.resolve(); await first;
    expect(published).toEqual([1]);
    const failure = new Error('controlled rollback');
    await expect(coordinator.transaction(async executor => { write(executor.synchronous, 2); throw failure; })).rejects.toBe(failure);
    await expect(coordinator.transaction(async executor => {
      write(executor.synchronous, 2);
      await executor.exec('CREATE TABLE deferred_effect(run_id INTEGER REFERENCES runs(id) DEFERRABLE INITIALLY DEFERRED)');
      await executor.run('INSERT INTO deferred_effect VALUES (?)', 999);
    })).rejects.toThrow('FOREIGN KEY constraint failed');
    expect(published).toEqual([1]);
    await coordinator.transaction(async executor => {
      expect(() => executor.synchronous.transaction(() => { write(executor.synchronous, 3); throw failure; })()).toThrow('controlled rollback');
      write(executor.synchronous, 4);
    });
    expect(published).toEqual([1, 2]);
    expect(await coordinator.read(executor => executor.all('SELECT run_id,sequence FROM runtime_events ORDER BY sequence')))
      .toEqual([{ run_id: 1, sequence: 1 }, { run_id: 1, sequence: 2 }]);
    expect(await coordinator.read(executor => executor.all('SELECT id,total_tokens FROM runs'))).toEqual([{ id: 1, total_tokens: 4 }]);
  } finally { release.resolve(); await opened.data.close(); rmSync(root, { recursive: true, force: true }); }
});
