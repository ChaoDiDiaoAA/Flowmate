import { expect, test } from 'bun:test';
import { Database } from 'bun:sqlite';
import { randomUUID } from 'node:crypto';
import { join, resolve } from 'node:path';
import { InvoiceWorkCreateReceiptSchema, PersonalTaskGetResultSchema, type PromptTraceResult, type Result } from '@flowmate/contracts';
import { createPersonalObservations } from '../../packages/core/src/personal-agent/observations.ts';
import { invoiceWorkToolsFixture } from '../../tests/support/invoice-work-tools.ts';
import { openTestDatabase } from '../../tests/support/database.ts';
import { waitFor } from '../../tests/support/resources.ts';
import { controlledHost, invoke } from './support/personal-agent-host.ts';

test('observation writes can fail without changing the committed Personal Agent result', async () => {
  const f = await controlledHost();
  const restart = async () => {
    expect(await f.client.start(f.root, '0.1.0', resolve(import.meta.dirname, '../..'))).toMatchObject({ ok: true, data: { ready: true } });
  };
  expect(await f.client.close()).toMatchObject({ ok: true, data: { closed: true } });
  const db = new Database(join(f.root, 'data', 'app.sqlite'));
  try {
    db.exec("CREATE TRIGGER synthetic_observation_failure BEFORE INSERT ON personal_model_observations BEGIN SELECT RAISE(ABORT,'synthetic_observation_failure'); END");
  } finally { db.close(); }
  await restart();
  const created = await invoke(f.client, { type: 'invoice_work_create', input: {
    personalAgentId: f.agent.personalAgentId, expectedAgentRevision: f.agent.revision, requestId: 'eval-observation-failure',
    goal: 'Review the synthetic invoice.', documents: [f.document.documentRef],
  } }, InvoiceWorkCreateReceiptSchema);
  const command = { type: 'personal_task_get', input: { workId: created.workId, attemptId: created.execution.attempt!.attemptId, limit: 10 } } as const;
  await waitFor(async () => (await invoke(f.client, command, PersonalTaskGetResultSchema)).task.stoppedAt !== null);
  const { task } = await invoke(f.client, command, PersonalTaskGetResultSchema);
  expect(task.runStatus).toBe('completed');
  const live = await f.client.request({ type: 'query_prompt_trace', runId: task.attempt.runId! }) as Result<PromptTraceResult>;
  expect(live).toMatchObject({ ok: true, data: { availability: 'available' } });
  expect(await f.client.close()).toMatchObject({ ok: true, data: { closed: true } });
  await restart();
  const reopened = await invoke(f.client, command, PersonalTaskGetResultSchema);
  expect(reopened.task).toEqual(task);
  expect(await f.client.request({ type: 'query_prompt_trace', runId: task.attempt.runId! }))
    .toMatchObject({ ok: true, data: { availability: 'process-exited', calls: [] } });
  expect(f.wire).toHaveLength(1);
}, 30_000);

test('upgrades an existing schema 29 Work and expires observation details without deleting its source', async () => {
  const fixture = await invoiceWorkToolsFixture();
  const original = await fixture.database.read(store => store.runs.get(fixture.runId));
  await fixture.database.close();
  const legacy = new Database(fixture.paths.databaseFile);
  try {
    legacy.exec('DROP TABLE personal_tool_model_sources; DROP TABLE personal_model_observations; DELETE FROM schema_migrations WHERE version=30');
  } finally { legacy.close(); }
  const opened = openTestDatabase(fixture.paths);
  if (!opened.ok) throw Error(opened.error.code);
  const db = opened.data;
  const originalId = fixture.runId;
  expect(await db.read(store => store.runs.get(originalId))).toMatchObject({ ok: true, data: { runId: originalId, sessionId: fixture.created.sessionId } });
  expect(original.ok).toBe(true);
  expect(db.db.query('SELECT MAX(version) AS version FROM schema_migrations').get()).toEqual({ version: 30 });
  let now = '2026-11-08T00:00:00.000Z';
  const store = createPersonalObservations(db, () => now);
  const observationId = randomUUID();
  store.capture({ observationId, runId: originalId, sessionId: fixture.created.sessionId, nativeSessionId: '9', callSequence: 1,
    startedAt: now, state: 'active', entries: [{ at: now, event: 'model_request', summary: 'SYNTHETIC_PRIVATE_TEXT', truncated: false }], droppedEntries: 0,
    durable: { workId: fixture.created.workId, itemId: fixture.itemId, attemptId: fixture.attemptId, phaseId: fixture.phase.phaseId, nativeTaskId: 11 },
    timing: { elapsedMs: null, budgetMs: null, beforeHttpMs: null, firstTextMs: null, transport: 'not-entered',
      outcome: 'pending', attempts: [], droppedAttempts: 0 } });
  store.source({ workId: fixture.created.workId, sessionId: fixture.created.sessionId, itemId: fixture.itemId,
    attemptId: fixture.attemptId, phaseId: fixture.phase.phaseId, requestId: fixture.phase.requestId,
    nativeTaskId: 12, generationTaskId: 11, assistantEntryId: 13, observationId });
  const recovered = await store.read(originalId);
  expect(recovered).toMatchObject([{ observationId, timing: { outcome: 'incomplete' } }]);
  expect(JSON.stringify(recovered)).not.toContain('SYNTHETIC_PRIVATE_TEXT');
  now = '2026-11-16T00:00:00.000Z';
  expect(await store.read(originalId)).toEqual([]);
  expect(await db.read(({ db }) => db.query('SELECT observation_id FROM personal_tool_model_sources WHERE run_id=?').get(originalId)))
    .toEqual({ observation_id: observationId });
});
