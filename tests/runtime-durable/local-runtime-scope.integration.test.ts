import { expect, test } from 'bun:test';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { ok, type DurableRuntimePort, type Result } from '@flowmate/contracts';
import { createLocalDurableRuntime } from '../../apps/local-durable-runtime.ts';
import { openTestDatabase } from '../support/database.ts';
import { mkdtempSync } from '../support/resources.ts';

function need<T>(result: Result<T>): T { if (!result.ok) throw Error(result.error.code); return result.data; }

test('every local Durable entry rejects a cloud-owned Session before touching native storage', async () => {
  const root = mkdtempSync(join(tmpdir(), 'flowmate-local-runtime-scope-'));
  const database = need(openTestDatabase({ root, databaseFile: join(root, 'data/app.sqlite'), artifactsDir: join(root, 'artifacts'),
    outputsDir: join(root, 'outputs'), runtimeDir: join(root, 'runtime'), logsDir: join(root, 'logs') }));
  const at = '2026-10-29T00:00:00.000Z';
  try {
    const local = need(await database.transaction(scope => scope.sessions.create({ runtimeKind: 'durable', nativeSessionId: null, title: 'Local', at })));
    const cloud = need(await database.transaction(scope => scope.sessions.create({ runtimeKind: 'durable', nativeSessionId: null, title: 'Cloud', at,
      durableRuntimeId: '11111111-1111-4111-8111-111111111111', cloudWorkspaceId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa' })));
    const calls: string[] = [];
    const native = new Proxy({} as DurableRuntimePort, { get: (_target, name) => async () => { calls.push(String(name)); return ok(null); } });
    const runtime = createLocalDurableRuntime(native, database);
    const operations = ['openConversation', 'prepareModel', 'restoreModel', 'submit', 'getSubmission', 'observeSubmission', 'observeSubagent',
      'waitForSubmission', 'stopAttempt', 'resumeAttempt', 'queryHistory', 'queryHistoryPage', 'queryHistoryEntry',
      'compact', 'queryCompaction', 'cancelCompaction'] as const;
    for (const operation of operations) {
      const result = await Reflect.apply(runtime[operation], runtime, [{ workId: 1, sessionId: cloud.sessionId }]);
      expect(result).toMatchObject({ ok: false, error: { code: 'cloud_runtime_unavailable' } });
    }
    expect(calls).toEqual([]);
    expect(await runtime.openConversation({ workId: 1, sessionId: local.sessionId })).toMatchObject({ ok: true });
    expect(calls).toEqual(['openConversation']);
  } finally { await database.close(); }
});
