import { expect, test } from 'bun:test';
import { join } from 'node:path';
import { PersonalAgentConfigurationSchema, type AcceptInvoiceCandidateRequest, type InvoiceWorkDisposeItemRequest,
  type Result } from '@flowmate/contracts';
import { createPersonalAgentRepository } from '../../../packages/core/src/personal-agent/agent-repository.ts';
import { createInvoiceWorkRepository, type InvoiceWorkRepository } from '../../../packages/core/src/personal-agent/repository.ts';
import type { SqlDatabaseStore } from '../../../packages/core/src/storage/database.ts';
import { createFileStore } from '../../../packages/core/src/storage/file-store.ts';
import { createDocumentService } from '../../../packages/data/src/documents.ts';
import { validateHumanInvoiceCandidate } from '../../../packages/employee-invoice/src/validation.ts';
import { makeCurrentSelectedCandidate } from '../../support/selected-candidate.ts';

function need<T>(result: Result<T>): T {
  if (!result.ok) throw Error(`${result.error.code}: ${result.error.message}`);
  return result.data;
}

async function fixture(memberCount = 2) {
  const database = await makeCurrentSelectedCandidate(true), at = database.stamp;
  const paths = { root: database.root, databaseFile: database.db.filename, artifactsDir: join(database.root, 'artifacts'),
    outputsDir: join(database.root, 'outputs'), logsDir: join(database.root, 'logs'), runtimeDir: join(database.root, 'runtime') };
  const files = createFileStore(paths, database);
  const documents = createDocumentService({ paths, files, allowedSourceRoot: database.root, now: () => at,
    transaction: operation => database.transaction(scope => operation({ repository: scope.documents,
      files: { read: (artifact, name) => files.read(artifact, name, scope.contents) } })) });
  const first = need(await database.read(scope => scope.documents.get(1)));
  const members = [first.documentRef];
  if (memberCount > 1) {
    const sourceText = 'Other invoice total 2.00';
    members.push(need(await documents.importPrepared({ contract: 'flowmate-prepared-invoice/v1', sample: 'other-work-invoice',
      original: { name: 'source.md', base64: Buffer.from(sourceText).toString('base64') }, sourceText,
      pages: [{ page: 1, blocks: [{ id: 'b1', kind: 'text', text: sourceText, sourceIndex: 0,
        sourceType: 'prepared-text', bbox: null }] }] })).documentRef);
  }
  const command = <T>(action: (repository: InvoiceWorkRepository, scope: SqlDatabaseStore) => T) =>
    database.transaction(scope => action(createInvoiceWorkRepository(scope.db), scope));
  const query = <T>(action: (repository: InvoiceWorkRepository, scope: SqlDatabaseStore) => T) =>
    database.read(scope => action(createInvoiceWorkRepository(scope.db), scope));
  const agent = need(await command((_repository, scope) => createPersonalAgentRepository(scope.db).ensureDefault(
    PersonalAgentConfigurationSchema.parse({ modelId: null, thinkingLevel: 'off', resources: { prompt: null, enabledSkills: [] },
      extensions: { enabledExtensions: [] }, tools: [], workingDirectory: null, preferences: '' }), at)));
  const created = need(await command(repository => repository.create({ personalAgentId: agent.personalAgentId,
    expectedAgentRevision: agent.revision, requestId: 'create-disposition-work', goal: 'Review this fixed invoice set.',
    documents: members }, { at, admission: { kind: 'queued' } })));
  const view = async () => {
    const result = need(await query(repository => repository.get({ view: 'work', workId: created.workId, limit: 100 })));
    if (result.view !== 'work') throw Error('Expected the original Work member page.');
    return result;
  };
  const acceptRequest: AcceptInvoiceCandidateRequest = { operationRef: 'original-candidate-accept', jobId: database.jobId,
    candidateId: database.candidateId, expectedCandidateId: database.candidateId,
    expectedRevision: database.selectedWorkspace.revision, dirty: false };
  // This is the original component business record, not UI confirmation or native execution proof.
  const accept = () => command((_repository, scope) => scope.candidates.accept({ ...acceptRequest, at,
    validate: (draft, ref) => validateHumanInvoiceCandidate(draft, ref, {
      readParsedForWorkspace: id => documents.readParsedForWorkspace(id, { repository: scope.documents,
        files: { read: (artifact, name) => files.read(artifact, name, scope.contents) } }),
    }) }));
  const dispose = (input: InvoiceWorkDisposeItemRequest) => command(repository => repository.disposeItem(input, { at }));
  return { database, at, members, command, query, agent, created, view, acceptRequest, accept, dispose };
}

test('ordinary candidate rejection leaves the fixed Work item unresolved', async () => {
  const f = await fixture(), before = await f.view();
  const rejected = need(await f.command((_repository, scope) => scope.candidates.reject({
    operationRef: 'ordinary-candidate-reject', jobId: f.database.jobId, candidateId: f.database.candidateId,
    expectedCandidateId: f.database.candidateId, expectedRevision: f.database.selectedWorkspace.revision,
    reason: 'Review another candidate.', at: f.at,
  })));
  expect(rejected.candidate.status).toBe('rejected');
  const after = await f.view();
  expect(after.work).toMatchObject({ status: 'open', revision: before.work.revision,
    counts: { total: 2, unresolved: 2, accepted: 0, rejected: 0, excluded: 0 } });
  expect(after.items).toEqual(before.items);
});

test('explicit rejection and exclusion retain members and finish only an unstarted admission', async () => {
  const f = await fixture(), before = await f.view(), [first, second] = before.items;
  if (!first || !second) throw Error('Expected both original fixed members.');
  const rejected = need(await f.dispose({ workId: f.created.workId, itemId: first.itemId, requestId: 'finally-rejected',
    expectedRevision: before.work.revision, decision: { kind: 'rejected', reason: 'The user rejects this invoice.' } }));
  const middle = await f.view();
  expect(middle.work).toMatchObject({ status: 'open', counts: { unresolved: 1, rejected: 1 } });
  need(await f.dispose({ workId: f.created.workId, itemId: second.itemId, requestId: 'finally-excluded',
    expectedRevision: rejected.revision, decision: { kind: 'excluded', reason: 'Outside this reimbursement.' } }));
  const after = await f.view();
  expect(after.work).toMatchObject({ status: 'completed', counts: { total: 2, unresolved: 0, accepted: 0, rejected: 1, excluded: 1 },
    execution: { queued: false, stopUnconfirmed: false, ownedChildRunIds: [] } });
  expect(after.items.map(item => [item.itemId, item.documentRef])).toEqual(before.items.map(item => [item.itemId, item.documentRef]));
  expect(after.items.map(item => item.disposition)).toEqual(['rejected', 'excluded']);
  expect(need(await f.query((_repository, scope) => scope.candidates.readByJob({ jobId: f.database.jobId,
    candidateId: f.database.candidateId }))).candidate.status).toBe('generated');
  expect(need(await f.query((_repository, scope) => scope.workspace.read(f.at)))).toEqual(f.database.selectedWorkspace);
});

test('accepted disposal binds an unbound item from the exact original acceptance without selecting Workspace', async () => {
  const f = await fixture(), before = await f.view(), first = before.items[0];
  if (!first) throw Error('Expected the original invoice item.');
  expect(first.jobId).toBeNull();
  const accepted = need(await f.accept());
  const receipt = need(await f.query((_repository, scope) => scope.candidates.queryOperation({ kind: 'accept', request: f.acceptRequest, at: f.at })));
  expect(receipt).toMatchObject({ candidate: { candidateId: f.database.candidateId, status: 'accepted' }, job: { jobId: f.database.jobId } });
  const current = need(await f.query((_repository, scope) => scope.workspace.read(f.at)));
  const workspace = need(await f.command((_repository, scope) => scope.workspace.update({ expectedRevision: current.revision,
    change: { kind: 'document', documentId: f.members[1]!.id }, at: f.at }, input => f.database.verify(input, scope))));
  need(await f.dispose({ workId: f.created.workId, itemId: first.itemId, requestId: 'accepted-original-receipt',
    expectedRevision: before.work.revision, decision: { kind: 'accepted',
      candidateRef: { id: accepted.candidate.candidateId, sequence: accepted.candidate.sequence }, acceptRequest: f.acceptRequest } }));
  const after = await f.view();
  expect(after.items[0]).toMatchObject({ disposition: 'accepted', jobId: f.database.jobId,
    candidateRef: { id: f.database.candidateId, sequence: accepted.candidate.sequence } });
  expect(after.items[1]).toEqual(before.items[1]);
  expect(after.work).toMatchObject({ status: 'open', counts: { total: 2, unresolved: 1, accepted: 1 } });
  expect(need(await f.query((_repository, scope) => scope.workspace.read(f.at)))).toEqual(workspace);
});

test('a persisted submission phase prevents completion when every item is disposed', async () => {
  const f = await fixture(1), before = await f.view(), selected = before.items[0], attempt = f.created.execution.attempt;
  if (!selected || !attempt) throw Error('Expected the original queued item and attempt.');
  const phase = need(await f.command(repository => repository.freezePhase({ workId: f.created.workId, attemptId: attempt.attemptId,
    itemId: selected.itemId, requestId: 'prompt-boundary-before-crash', kind: 'prompt', at: f.at,
    basis: { contextSnapshotId: null, inputIds: [], documentRefs: [selected.documentRef], configurationRevision: f.agent.revision,
      itemRevision: selected.revision } })));
  need(await f.dispose({ workId: f.created.workId, itemId: selected.itemId, requestId: 'dispose-with-unknown-phase',
    expectedRevision: before.work.revision, decision: { kind: 'excluded', reason: 'No longer part of this claim.' } }));
  expect((await f.view()).work).toMatchObject({ status: 'open', counts: { total: 1, unresolved: 0, excluded: 1 } });
  expect(await f.query((_repository, scope) => scope.db.query('SELECT native_conversation_id,native_submission_id,consumed_at FROM invoice_work_phases WHERE id=?')
    .get(phase.phaseId))).toEqual({ native_conversation_id: null, native_submission_id: null, consumed_at: null });
  const current = await f.view();
  need(await f.command(repository => repository.cancelWork({ workId: f.created.workId, requestId: 'cancel-unknown-phase',
    expectedRevision: current.work.revision }, { at: f.at })));
  expect((await f.view()).work).toMatchObject({ status: 'cancelled', counts: { unresolved: 0, excluded: 1 },
    execution: { stopUnconfirmed: true } });
});

test('disposition retries recover the original receipt before new CAS and reject changed intent', async () => {
  const f = await fixture(), before = await f.view(), [first, second] = before.items;
  if (!first || !second) throw Error('Expected both fixed members.');
  const input: InvoiceWorkDisposeItemRequest = { workId: f.created.workId, itemId: first.itemId, requestId: 'original-disposition',
    expectedRevision: before.work.revision, decision: { kind: 'rejected', reason: 'Original explicit decision.' } };
  const original = need(await f.dispose(input));
  need(await f.dispose({ workId: f.created.workId, itemId: second.itemId, requestId: 'last-disposition',
    expectedRevision: original.revision, decision: { kind: 'excluded', reason: 'Original exclusion.' } }));
  const terminal = await f.view();
  expect(terminal.work.status).toBe('completed');
  expect(await f.dispose(input)).toEqual({ ok: true, data: original });
  expect(await f.query(repository => repository.queryOperation({ operation: 'disposeItem', workId: f.created.workId,
    requestId: input.requestId }))).toEqual({ ok: true, data: original });
  expect(await f.dispose({ ...input, decision: { kind: 'rejected', reason: 'Changed intent.' } }))
    .toMatchObject({ ok: false, error: { code: 'state_conflict' } });
  expect(await f.dispose({ ...input, requestId: 'new-decision-on-final-item', expectedRevision: terminal.work.revision }))
    .toMatchObject({ ok: false, error: { code: 'state_conflict' } });
  expect(await f.command(repository => repository.continueWork({ workId: f.created.workId, requestId: 'revive-completed-work',
    expectedRevision: terminal.work.revision, expectedAttemptId: terminal.work.execution.attempt?.attemptId ?? null },
  { at: f.at, admission: { kind: 'queued' } }))).toMatchObject({ ok: false, error: { code: 'state_conflict' } });
  expect(await f.view()).toEqual(terminal);
});

test('accepted disposal rejects missing or changed original receipts, wrong sequence and another invoice', async () => {
  const f = await fixture(), accepted = need(await f.accept()), before = await f.view(), [first, second] = before.items;
  if (!first || !second) throw Error('Expected both original invoice members.');
  const decision = { kind: 'accepted' as const, candidateRef: { id: accepted.candidate.candidateId,
    sequence: accepted.candidate.sequence }, acceptRequest: f.acceptRequest };
  const input: InvoiceWorkDisposeItemRequest = { workId: f.created.workId, itemId: first.itemId,
    requestId: 'missing-acceptance', expectedRevision: before.work.revision, decision };
  const invalid: InvoiceWorkDisposeItemRequest[] = [
    { ...input, decision: { ...decision, acceptRequest: { ...f.acceptRequest, operationRef: 'never-accepted' } } },
    { ...input, requestId: 'changed-acceptance', decision: { ...decision,
      acceptRequest: { ...f.acceptRequest, expectedRevision: f.acceptRequest.expectedRevision + 1 } } },
    { ...input, requestId: 'wrong-candidate-sequence', decision: { ...decision,
      candidateRef: { ...decision.candidateRef, sequence: decision.candidateRef.sequence + 1 } } },
    { ...input, requestId: 'wrong-job-receipt', decision: { ...decision,
      acceptRequest: { ...f.acceptRequest, jobId: f.database.jobId + 100 } } },
    { ...input, requestId: 'foreign-invoice-acceptance', itemId: second.itemId },
  ];
  for (const request of invalid) {
    expect((await f.dispose(request)).ok).toBe(false);
    expect(await f.query(repository => repository.queryOperation({ operation: 'disposeItem', workId: f.created.workId,
      requestId: request.requestId }))).toEqual({ ok: true, data: null });
    expect(await f.view()).toEqual(before);
  }
  expect(need(await f.query((_repository, scope) => scope.candidates.queryOperation({ kind: 'accept', request: f.acceptRequest,
    at: f.at })))).toMatchObject({ candidate: { candidateId: f.database.candidateId, status: 'accepted' } });
});

test('an original acceptance cannot replace an item already associated with another Job for the same invoice', async () => {
  const f = await fixture(1), accepted = need(await f.accept()), initial = await f.view(), item = initial.items[0];
  if (!item) throw Error('Expected the original invoice item.');
  const another = need(await f.command((_repository, scope) => scope.jobs.create({ clientSequence: 1001,
    expectedRevision: accepted.workspace.revision, documentRef: item.documentRef,
    goal: 'A separate processing of this same invoice.', at: f.at })));
  expect(another.job.jobId).not.toBe(f.database.jobId);
  await f.command((_repository, scope) => {
    // Seed the existing product association; both Jobs and the acceptance remain real original business records.
    scope.db.query('UPDATE invoice_work_items SET job_id=? WHERE work_id=? AND id=?')
      .run(another.job.jobId, f.created.workId, item.itemId);
  });
  const before = await f.view();
  expect(before.items[0]!.jobId).toBe(another.job.jobId);
  expect((await f.dispose({ workId: f.created.workId, itemId: item.itemId, requestId: 'replace-original-job',
    expectedRevision: before.work.revision, decision: { kind: 'accepted', candidateRef: {
      id: accepted.candidate.candidateId, sequence: accepted.candidate.sequence }, acceptRequest: f.acceptRequest } })).ok).toBe(false);
  expect(await f.view()).toEqual(before);
  expect(await f.query(repository => repository.queryOperation({ operation: 'disposeItem', workId: f.created.workId,
    requestId: 'replace-original-job' }))).toEqual({ ok: true, data: null });
  expect(need(await f.query((_repository, scope) => scope.workspace.read(f.at)))).toEqual(another.workspace);
});

for (const first of ['dispose', 'cancel'] as const) {
  test(`last disposition and cancellation with one revision admit only the first ${first} command`, async () => {
    const f = await fixture(1), before = await f.view(), item = before.items[0];
    if (!item) throw Error('Expected the fixed invoice item.');
    const dispose = () => f.dispose({ workId: f.created.workId, itemId: item.itemId, requestId: 'race-final-disposition',
      expectedRevision: before.work.revision, decision: { kind: 'excluded', reason: 'Finish this invoice.' } });
    const cancel = () => f.command(repository => repository.cancelWork({ workId: f.created.workId, requestId: 'race-cancel',
      expectedRevision: before.work.revision }, { at: f.at }));
    const results = await Promise.all(first === 'dispose' ? [dispose(), cancel()] : [cancel(), dispose()]);
    expect(results[0]!.ok).toBe(true);
    expect(results[1]).toMatchObject({ ok: false, error: { code: 'state_conflict' } });
    const after = await f.view();
    expect(after.work).toMatchObject({ status: first === 'dispose' ? 'completed' : 'cancelled', revision: before.work.revision + 1 });
    expect(after.items.map(value => [value.itemId, value.documentRef])).toEqual(before.items.map(value => [value.itemId, value.documentRef]));
    expect(await f.query((_repository, scope) => scope.db.query('SELECT COUNT(*) AS count FROM invoice_work_operations WHERE work_id=?')
      .get(f.created.workId))).toEqual({ count: 2 });
  });
}
