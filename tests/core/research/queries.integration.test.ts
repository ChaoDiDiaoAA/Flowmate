import { expect, it } from 'bun:test';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { Database } from 'bun:sqlite';
import { createApplication } from '../../../apps/composition.ts';
import { openDatabase } from '@flowmate/core';
import { deferCleanup, mkdtempSync } from '../../support/resources.ts';

it('restores research facts through public queries without admitting model, tool or Session inputs', async () => {
  const root = mkdtempSync(join(tmpdir(), 'flowmate-research-queries-'));
  const paths = { root, databaseFile: join(root, 'data', 'app.sqlite'), artifactsDir: join(root, 'artifacts'),
    runtimeDir: join(root, 'runtime'), logsDir: join(root, 'logs'), outputsDir: join(root, 'outputs') };
  const opened = openDatabase(paths); if (!opened.ok) throw new Error(opened.error.code);
  const store = opened.data, at = '2026-10-10T00:00:00.000Z';
  const session = store.sessions.create({ nativeSessionId: 'research-query', title: 'Query only', at });
  if (!session.ok) throw new Error(session.error.code);
  const task = store.research.create({ sessionId: session.data.sessionId, title: 'Query only',
    sourcePolicy: { web: false, domains: [], documentIds: [], artifactIds: [] }, at });
  if (!task.ok) throw new Error(task.error.code);
  const before = { runs: store.db.query('SELECT * FROM runs').all(), inputs: store.db.query('SELECT * FROM session_inputs').all(),
    tasks: store.db.query('SELECT * FROM research_tasks').all() };
  store.close();
  let modelRequests = 0;
  const app = await createApplication({ paths, logger: { write: () => undefined, close: async () => undefined },
    provider: { prepare: async () => { modelRequests++; throw new Error('Queries must not execute.'); }, close: async () => ({ stopped: true, closed: true, errors: [] }) } });
  if (!app.ok) throw new Error(app.error.code);
  deferCleanup(() => app.data.close());
  expect(typeof app.data.listResearchTasks).toBe('function');
  expect(await app.data.listResearchTasks({ limit: 1 })).toEqual({ ok: true, data: { items: [task.data], nextBeforeId: null } });
  expect(await app.data.queryResearchTask(task.data.researchId)).toEqual(task);
  expect(await app.data.listResearchSources({ researchId: task.data.researchId, limit: 1 })).toEqual({ ok: true, data: { items: [], nextBeforeId: null } });
  expect(await app.data.listResearchReports({ researchId: task.data.researchId })).toEqual({ ok: true, data: { items: [], nextBeforeId: null } });
  expect(await app.data.queryResearchPlan({ researchId: task.data.researchId, planId: 999 })).toMatchObject({ ok: false });
  expect(await app.data.listResearchTasks({ limit: 1000 })).toMatchObject({ ok: false, error: { code: 'input_invalid' } });
  expect(modelRequests).toBe(0);
  await app.data.close();
  const audit = new Database(paths.databaseFile, { readonly: true }); deferCleanup(() => audit.close());
  expect({ runs: audit.query('SELECT * FROM runs').all(), inputs: audit.query('SELECT * FROM session_inputs').all(),
    tasks: audit.query('SELECT * FROM research_tasks').all() }).toEqual(before);
});
