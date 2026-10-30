import { expect, test } from 'bun:test';
import { appError, fail, type Result } from '@flowmate/contracts';
import { makeApplication } from '../../../packages/core/src/application.ts';
import { createJobService } from '../../../packages/core/src/jobs/service.ts';
import { RuntimeService } from '../../../packages/core/src/runtime/service.ts';
import { makeCurrentSelectedCandidate } from '../../support/selected-candidate.ts';
import { deferCleanup } from '../../support/resources.ts';

function need<T>(value: Result<T>): T { if (!value.ok) throw Error(value.error.code); return value.data; }

async function fixture() {
  const database = await makeCurrentSelectedCandidate();
  const service = createJobService(database, () => database.stamp);
  const runtime = new RuntimeService({ database, provider: {
    async prepare() { throw Error('Job operations must not start models.'); },
    async close() { return { stopped: true, closed: true, errors: [] }; },
  }, log: { write() {}, async close() {} }, now: () => database.stamp, monotonicNow: () => performance.now() });
  const app = makeApplication(runtime, { get: id => database.read(scope => scope.runs.get(id)) },
    async () => { await database.close(); return { stopped: true, closed: true, errors: [] }; },
    undefined, undefined, undefined, service, { documents: database.documents, candidates: database.candidates, events: database.businessEvents,
      jobs: { list: input => database.read(scope => scope.jobs.list(input)), get: id => database.read(scope => scope.jobs.get(id)) },
      importInvoiceMaterial: async () => fail(appError('input_unavailable', 'input', 'No imports in Job tests.')),
      importPreparedInvoiceMaterial: async () => fail(appError('input_unavailable', 'input', 'No imports in Job tests.')),
      readDocumentPage: () => fail(appError('input_unavailable', 'input', 'No documents in Job tests.')),
      listDocumentPages: () => fail(appError('input_unavailable', 'input', 'No documents in Job tests.')),
      readDocumentOriginal: () => fail(appError('input_unavailable', 'input', 'No documents in Job tests.')),
    });
  deferCleanup(() => app.close());
  const workspace = need(await database.read(scope => scope.workspace.read(database.stamp)));
  if (!workspace.documentRef) throw Error('The selected fixture document is required.');
  const request = { clientSequence: 2, expectedRevision: workspace.revision, documentRef: workspace.documentRef, goal: '  Check totals  ' };
  return { database, service, app, request };
}

test('Job creation waits for its owner and keeps the original request across retries without another model', async () => {
  const f = await fixture(), entered = Promise.withResolvers<void>(), release = Promise.withResolvers<void>();
  const transaction = f.database.transaction;
  const holding = transaction(async () => { entered.resolve(); await release.promise; });
  await entered.promise;
  const commitEntered = Promise.withResolvers<void>(), commitRelease = Promise.withResolvers<void>();
  f.database.transaction = operation => {
    f.database.transaction = transaction;
    return transaction(async scope => {
      const result = await operation(scope);
      commitEntered.resolve(); await commitRelease.promise;
      return result;
    });
  };
  const original = structuredClone(f.request);
  let settled = false;
  const creating = Promise.resolve(f.service.create(f.request)).then(value => { settled = true; return value; });
  f.request.goal = 'Changed after queueing';
  try {
    await new Promise<void>(resolve => setImmediate(resolve));
    expect(settled).toBe(false);
    release.resolve(); await holding;
    await commitEntered.promise;
    expect(settled).toBe(false);
    commitRelease.resolve();
    const created = need(await creating);
    expect(created.job).toMatchObject({ goal: 'Check totals', status: 'pending' });
    expect(created.workspace.revision).toBe(original.expectedRevision + 1);
    const expired = () => fail(appError('storage_read_failed', 'storage', 'Expired root Job repository.'));
    f.database.jobs.create = expired; f.database.jobs.queryOperation = expired; f.database.jobs.hide = expired;
    f.database.jobs.get = expired; f.database.jobs.list = expired;
    expect(await f.service.create(original)).toMatchObject({ ok: true, data: { job: { jobId: created.job.jobId }, workspace: created.workspace } });
    expect(await f.service.queryOperation(original.clientSequence)).toMatchObject({ ok: true, data: { job: { jobId: created.job.jobId } } });
    expect(await f.service.create({ ...original, goal: 'Different operation' })).toMatchObject({ ok: false, error: { code: 'state_conflict' } });
    expect(await f.app.queryJob(created.job.jobId)).toMatchObject({ ok: true, data: { goal: 'Check totals' } });
    expect(await f.app.listJobs()).toMatchObject({ ok: true, data: { items: [expect.objectContaining({ jobId: created.job.jobId }), expect.any(Object)] } });
    expect(await f.service.hide(created.job.jobId)).toMatchObject({ ok: true, data: { jobId: created.job.jobId } });
    expect(need(await f.app.listJobs()).items).toHaveLength(1);
  } finally { release.resolve(); commitRelease.resolve(); await holding; await creating; }
});

test('an actual Job COMMIT rejection returns no successful receipt and leaves the original Workspace', async () => {
  const f = await fixture();
  await f.database.transaction(scope => scope.db.exec(`
    CREATE TABLE job_commit_parent(id INTEGER PRIMARY KEY);
    CREATE TABLE job_commit_child(id INTEGER PRIMARY KEY,parent_id INTEGER REFERENCES job_commit_parent(id) DEFERRABLE INITIALLY DEFERRED);
    CREATE TRIGGER job_commit_fault AFTER INSERT ON jobs BEGIN INSERT INTO job_commit_child VALUES(1,404); END;
  `));
  expect(await f.service.create(f.request)).toMatchObject({ ok: false, error: { code: 'storage_write_failed' } });
  expect(await f.service.queryOperation(f.request.clientSequence)).toEqual({ ok: true, data: null });
  expect(need(await f.app.listJobs()).items).toHaveLength(1);
  expect(await f.database.read(scope => scope.workspace.read(f.database.stamp)))
    .toMatchObject({ ok: true, data: { revision: f.request.expectedRevision, jobId: f.database.jobId } });
});

test('a closed Job owner returns safe read and write errors instead of an empty operation', async () => {
  const f = await fixture();
  need(await f.app.close());
  expect(await f.service.queryOperation(f.request.clientSequence)).toMatchObject({ ok: false, error: { code: 'storage_read_failed' } });
  expect(await f.service.create(f.request)).toMatchObject({ ok: false, error: { code: 'storage_write_failed' } });
  expect(await f.service.hide(f.database.jobId)).toMatchObject({ ok: false, error: { code: 'storage_write_failed' } });
});
