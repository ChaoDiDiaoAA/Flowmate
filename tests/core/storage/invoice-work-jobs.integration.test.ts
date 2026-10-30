import { expect, test } from 'bun:test';
import { join } from 'node:path';
import { PersonalAgentConfigurationSchema, type AcceptInvoiceCandidateRequest, type DocumentRef,
  type InvoiceWorkCreateRequest, type Result } from '@flowmate/contracts';
import type { SqlDatabaseStore } from '../../../packages/core/src/storage/database.ts';
import { createFileStore } from '../../../packages/core/src/storage/file-store.ts';
import { createDocumentService } from '../../../packages/data/src/documents.ts';
import { validateHumanInvoiceCandidate } from '../../../packages/employee-invoice/src/validation.ts';
import { makeCurrentSelectedCandidate } from '../../support/selected-candidate.ts';

function need<T>(result: Result<T>): T { if (!result.ok) throw Error(`${result.error.code}: ${result.error.message}`); return result.data; }

function registerSecondDocument(scope: SqlDatabaseStore, at: string): DocumentRef {
  const metadata = { version: 1 as const, sourceKey: 'work-job-preparation', sourceRecordId: 'invoice-2', sourceVersion: 'v1' };
  need(scope.documents.register({ documentId: 2, sourceKey: metadata.sourceKey, sourceRecordId: metadata.sourceRecordId, version: 'v1',
    originalArtifact: { artifactId: 3, kind: 'original', relativePath: 'artifacts/3/source.md', bytes: 1,
      mimeType: 'text/markdown', metadata: { ...metadata, files: [{ relativePath: 'source.md', bytes: 1, mimeType: 'text/markdown' }] }, createdAt: at },
    parsedArtifact: { artifactId: 4, kind: 'parsed', relativePath: 'artifacts/4/parsed.json', bytes: 1,
      mimeType: 'application/json', metadata: { ...metadata, files: [{ relativePath: 'parsed.json', bytes: 1, mimeType: 'application/json' }] }, createdAt: at },
    status: 'available', metadata: { version: 2, pageCount: 1, warnings: [], allowedUsesClaim: ['Controlled product Job preparation records'],
      licenseVerification: 'not_verified', unavailableReason: null }, createdAt: at, updatedAt: at }));
  return { id: 2, version: 'v1' };
}

async function fixture() {
  const database = await makeCurrentSelectedCandidate(true), at = database.stamp;
  const seeded = await database.transaction(scope => ({
    agent: need(scope.personalAgents.ensureDefault(PersonalAgentConfigurationSchema.parse({ modelId: null, thinkingLevel: 'off',
      resources: { prompt: null, enabledSkills: [] }, extensions: { enabledExtensions: [] }, tools: [], workingDirectory: null, preferences: '' }), at)),
    documents: [need(scope.documents.get(1)).documentRef, registerSecondDocument(scope, at)],
  }));
  const created = need(await database.transaction(scope => scope.invoiceWorks.create({ personalAgentId: seeded.agent.personalAgentId,
    expectedAgentRevision: seeded.agent.revision, requestId: 'create-job-preparation-work', goal: 'Review these fixed invoices in the background.',
    documents: seeded.documents }, { at, admission: { kind: 'queued' } })));
  const work = async (workId = created.workId) => {
    const result = need(await database.read(scope => scope.invoiceWorks.get({ view: 'work', workId, limit: 100 })));
    if (result.view !== 'work') throw Error('Expected the original fixed member page.');
    return result;
  };
  const effects = () => database.read(scope => {
    const row = scope.db.query<{ jobs: number; taskEvents: number; runs: number; tools: number }, []>(`SELECT
      (SELECT COUNT(*) FROM jobs) jobs,(SELECT COUNT(*) FROM business_events WHERE type='task_started') taskEvents,
      (SELECT COUNT(*) FROM runs) runs,(SELECT COUNT(*) FROM tool_calls) tools`).get();
    if (!row) throw Error('Expected original business record counts.'); return row;
  });
  return { database, at, ...seeded, created, work, effects };
}

test('preparing each fixed invoice creates its own pending Job without changing the foreground Workspace', async () => {
  const f = await fixture(), before = await f.work(), counts = await f.effects();
  const workspace = need(await f.database.read(scope => scope.workspace.read(f.at)));
  const [first, second] = before.items; if (!first || !second) throw Error('Expected both original fixed invoices.');
  const firstJob = need(await f.database.transaction(scope => scope.invoiceWorks.prepareItemJob({ workId: f.created.workId,
    itemId: first.itemId, expectedRevision: first.revision, at: f.at })));
  const secondJob = need(await f.database.transaction(scope => scope.invoiceWorks.prepareItemJob({ workId: f.created.workId,
    itemId: second.itemId, expectedRevision: second.revision, at: f.at })));
  expect(firstJob).toMatchObject({ documentRef: first.documentRef, status: 'pending', currentCandidateId: null, acceptedCandidateId: null });
  expect(secondJob).toMatchObject({ documentRef: second.documentRef, status: 'pending', currentCandidateId: null, acceptedCandidateId: null });
  expect(firstJob.jobId).not.toBe(secondJob.jobId);
  expect(firstJob.jobId).not.toBe(f.database.jobId);
  const after = await f.work();
  expect(after.items.map(item => item.jobId)).toEqual([firstJob.jobId, secondJob.jobId]);
  expect(after.items.map(item => item.documentRef)).toEqual(before.items.map(item => item.documentRef));
  expect(after.items[0]!.revision).toBeGreaterThan(first.revision);
  expect(need(await f.database.read(scope => scope.workspace.read(f.at)))).toEqual(workspace);
  expect(await f.effects()).toEqual({ ...counts, jobs: counts.jobs + 2, taskEvents: counts.taskEvents + 2 });
});

test('same item concurrent preparation and old item revision retries return one original Job and task event', async () => {
  const f = await fixture(), before = await f.work(), counts = await f.effects(), selected = before.items[0];
  if (!selected) throw Error('Expected the original fixed invoice item.');
  const input = { workId: f.created.workId, itemId: selected.itemId, expectedRevision: selected.revision, at: f.at };
  const results = await Promise.all([f.database.transaction(scope => scope.invoiceWorks.prepareItemJob(input)),
    f.database.transaction(scope => scope.invoiceWorks.prepareItemJob(input))]);
  const job = need(results[0]!);
  expect(results[1]).toEqual({ ok: true, data: job });
  expect((await f.work()).items[0]!.revision).toBeGreaterThan(input.expectedRevision);
  expect(await f.database.transaction(scope => scope.invoiceWorks.prepareItemJob(input))).toEqual({ ok: true, data: job });
  expect(await f.database.read(scope => scope.db.query('SELECT COUNT(*) AS count FROM business_events WHERE type=\'task_started\' AND job_id=?')
    .get(job.jobId))).toEqual({ count: 1 });
  expect(await f.effects()).toEqual({ ...counts, jobs: counts.jobs + 1, taskEvents: counts.taskEvents + 1 });
});

test('foreign items, stale unprepared revisions and final work cannot leave background Job records', async () => {
  const f = await fixture(), original = await f.work(), selected = original.items[0], remaining = original.items[1];
  if (!selected || !remaining) throw Error('Expected both original fixed items.');
  const foreign = need(await f.database.transaction(scope => scope.invoiceWorks.create({ personalAgentId: f.agent.personalAgentId,
    expectedAgentRevision: f.agent.revision, requestId: 'foreign-work', goal: 'Another explicit invoice Work.',
    documents: [selected.documentRef] }, { at: f.at, admission: { kind: 'queued' } })));
  const foreignItem = (await f.work(foreign.workId)).items[0]; if (!foreignItem) throw Error('Expected the other Work item.');
  const before = await f.effects();
  expect(await f.database.transaction(scope => scope.invoiceWorks.prepareItemJob({ workId: f.created.workId,
    itemId: foreignItem.itemId, expectedRevision: foreignItem.revision, at: f.at })))
    .toMatchObject({ ok: false, error: { code: 'invoice_work_item_not_found' } });
  expect(await f.database.transaction(scope => scope.invoiceWorks.prepareItemJob({ workId: f.created.workId,
    itemId: selected.itemId, expectedRevision: selected.revision + 1, at: f.at })))
    .toMatchObject({ ok: false, error: { code: 'state_conflict' } });
  expect(await f.work()).toEqual(original);
  const disposed = need(await f.database.transaction(scope => scope.invoiceWorks.disposeItem({ workId: f.created.workId,
    itemId: selected.itemId, expectedRevision: original.work.revision, requestId: 'exclude-before-job',
    decision: { kind: 'excluded', reason: 'Do not process this invoice.' } }, { at: f.at })));
  const finalItem = (await f.work()).items[0]; if (!finalItem) throw Error('Expected the retained final member.');
  expect(await f.database.transaction(scope => scope.invoiceWorks.prepareItemJob({ workId: f.created.workId,
    itemId: finalItem.itemId, expectedRevision: finalItem.revision, at: f.at })))
    .toMatchObject({ ok: false, error: { code: 'state_conflict' } });
  need(await f.database.transaction(scope => scope.invoiceWorks.cancelWork({ workId: f.created.workId,
    expectedRevision: disposed.revision, requestId: 'cancel-before-job' }, { at: f.at })));
  const cancelled = await f.work();
  expect(await f.database.transaction(scope => scope.invoiceWorks.prepareItemJob({ workId: f.created.workId,
    itemId: remaining.itemId, expectedRevision: remaining.revision, at: f.at })))
    .toMatchObject({ ok: false, error: { code: 'state_conflict' } });
  expect(await f.work()).toEqual(cancelled);
  expect(await f.effects()).toEqual(before);
  expect(need(await f.database.read(scope => scope.workspace.read(f.at)))).toEqual(f.database.selectedWorkspace);
});

test('a real item association failure rolls back its Job, task event and member update together', async () => {
  const f = await fixture(), before = await f.work(), counts = await f.effects(), item = before.items[0];
  if (!item) throw Error('Expected the original invoice item.');
  await f.database.transaction(scope => scope.db.exec(`CREATE TRIGGER reject_work_job_association
    BEFORE UPDATE OF job_id ON invoice_work_items BEGIN SELECT RAISE(ABORT,'controlled item Job association failure'); END`));
  const input = { workId: f.created.workId, itemId: item.itemId, expectedRevision: item.revision, at: f.at };
  expect(await f.database.transaction(scope => scope.invoiceWorks.prepareItemJob(input)))
    .toMatchObject({ ok: false, error: { code: 'storage_write_failed' } });
  expect(await f.work()).toEqual(before);
  expect(await f.effects()).toEqual(counts);
  expect(need(await f.database.read(scope => scope.workspace.read(f.at)))).toEqual(f.database.selectedWorkspace);
  await f.database.transaction(scope => scope.db.exec('DROP TRIGGER reject_work_job_association'));
  const recovered = need(await f.database.transaction(scope => scope.invoiceWorks.prepareItemJob(input)));
  expect(recovered).toMatchObject({ documentRef: item.documentRef, status: 'pending' });
  expect(await f.effects()).toEqual({ ...counts, jobs: counts.jobs + 1, taskEvents: counts.taskEvents + 1 });
});

test('a related Work prepares a new pending Job while preserving the original accepted Job and source facts', async () => {
  const f = await fixture(), initial = await f.work(), [first, second] = initial.items;
  if (!first || !second) throw Error('Expected both source Work members.');
  const paths = { root: f.database.root, databaseFile: f.database.db.filename, artifactsDir: join(f.database.root, 'artifacts'),
    outputsDir: join(f.database.root, 'outputs'), logsDir: join(f.database.root, 'logs'), runtimeDir: join(f.database.root, 'runtime') };
  const files = createFileStore(paths, f.database);
  const documents = createDocumentService({ paths, files, allowedSourceRoot: f.database.root, now: () => f.at,
    transaction: operation => f.database.transaction(scope => operation({ repository: scope.documents,
      files: { read: (artifact, name) => files.read(artifact, name, scope.contents) } })) });
  const acceptRequest: AcceptInvoiceCandidateRequest = { operationRef: 'accept-original-for-related-work',
    jobId: f.database.jobId, candidateId: f.database.candidateId, expectedCandidateId: f.database.candidateId,
    expectedRevision: f.database.selectedWorkspace.revision, dirty: false };
  // This records the original component acceptance; it is not UI confirmation or SDK execution evidence.
  const accepted = need(await f.database.transaction(scope => scope.candidates.accept({ ...acceptRequest, at: f.at,
    validate: (draft, ref) => validateHumanInvoiceCandidate(draft, ref, {
      readParsedForWorkspace: id => documents.readParsedForWorkspace(id, { repository: scope.documents,
        files: { read: (artifact, name) => files.read(artifact, name, scope.contents) } }),
    }) })));
  const acceptedItem = need(await f.database.transaction(scope => scope.invoiceWorks.disposeItem({ workId: f.created.workId,
    itemId: first.itemId, expectedRevision: initial.work.revision, requestId: 'dispose-original-accepted',
    decision: { kind: 'accepted', candidateRef: { id: accepted.candidate.candidateId, sequence: accepted.candidate.sequence }, acceptRequest } }, { at: f.at })));
  need(await f.database.transaction(scope => scope.invoiceWorks.disposeItem({ workId: f.created.workId, itemId: second.itemId,
    expectedRevision: acceptedItem.revision, requestId: 'exclude-other-source-member',
    decision: { kind: 'excluded', reason: 'Only the first accepted invoice belongs to the related Work.' } }, { at: f.at })));
  const sourceWork = await f.work(), oldJob = need(await f.database.read(scope => scope.jobs.get(f.database.jobId)));
  expect(sourceWork.work.status).toBe('completed');
  expect(oldJob).toMatchObject({ status: 'completed', acceptedCandidateId: f.database.candidateId });
  const originalReceipt = need(await f.database.read(scope => scope.candidates.queryOperation({ kind: 'accept', request: acceptRequest, at: f.at })));
  const workspace = need(await f.database.read(scope => scope.workspace.read(f.at))), counts = await f.effects();
  const input: InvoiceWorkCreateRequest = { personalAgentId: f.agent.personalAgentId, expectedAgentRevision: f.agent.revision,
    requestId: 'related-work-new-processing', goal: 'Explicitly process this invoice again in a new Work.', documents: [first.documentRef],
    source: { workId: f.created.workId, items: [{ itemId: first.itemId, documentRef: first.documentRef,
      candidateRef: { id: accepted.candidate.candidateId, sequence: accepted.candidate.sequence } }] } };
  const originalInput = structuredClone(input);
  const related = need(await f.database.transaction(scope => scope.invoiceWorks.create(input, { at: f.at, admission: { kind: 'queued' } })));
  expect(input).toEqual(originalInput);
  expect(await f.effects()).toEqual(counts);
  const sourceRow = await f.database.read(scope => scope.db.query<{ source_json: string | null }, [number]>(
    'SELECT source_json FROM invoice_works WHERE id=?').get(related.workId));
  if (!sourceRow?.source_json) throw Error('Expected the canonical original source facts.');
  const sourceFacts: unknown = JSON.parse(sourceRow.source_json);
  expect(sourceFacts).toMatchObject({ workId: f.created.workId, items: [{ itemId: first.itemId, jobId: f.database.jobId,
    documentRef: first.documentRef, candidateRef: { id: f.database.candidateId, sequence: accepted.candidate.sequence } }] });
  const relatedItem = (await f.work(related.workId)).items[0]; if (!relatedItem) throw Error('Expected the new fixed invoice member.');
  const prepared = need(await f.database.transaction(scope => scope.invoiceWorks.prepareItemJob({ workId: related.workId,
    itemId: relatedItem.itemId, expectedRevision: relatedItem.revision, at: f.at })));
  expect(prepared).toMatchObject({ documentRef: first.documentRef, status: 'pending', currentCandidateId: null, acceptedCandidateId: null });
  expect(prepared.jobId).not.toBe(oldJob.jobId);
  expect((await f.work(related.workId)).items[0]).toMatchObject({ jobId: prepared.jobId, candidateRef: null, disposition: 'unresolved' });
  expect(await f.database.read(scope => scope.db.query('SELECT source_json FROM invoice_works WHERE id=?').get(related.workId))).toEqual(sourceRow);
  expect(need(await f.database.read(scope => scope.jobs.get(oldJob.jobId)))).toEqual(oldJob);
  expect(await f.database.read(scope => scope.candidates.queryOperation({ kind: 'accept', request: acceptRequest, at: f.at })))
    .toEqual({ ok: true, data: originalReceipt });
  expect(await f.work()).toEqual(sourceWork);
  expect(need(await f.database.read(scope => scope.workspace.read(f.at)))).toEqual(workspace);
  expect(await f.effects()).toEqual({ ...counts, jobs: counts.jobs + 1, taskEvents: counts.taskEvents + 1 });
});
