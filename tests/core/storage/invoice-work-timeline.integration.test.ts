import { expect, test } from 'bun:test';
import type { SQLQueryBindings } from 'bun:sqlite';
import { InvoiceWorkTimelinePageSchema, InvoiceFormDraftSchema, compareInvoiceWorkTimelineCursor,
  type InvoiceWorkTimelineCursor, type InvoiceWorkTimelineEntry, type Result } from '@flowmate/contracts';
import { invoiceWorkToolsFixture, invoiceWorkCandidateDraft } from '../../support/invoice-work-tools.ts';
import { createFileStore } from '../../../packages/core/src/storage/file-store.ts';
import { createDocumentService } from '../../../packages/data/src/documents.ts';
import { validateHumanInvoiceCandidate } from '../../../packages/employee-invoice/src/validation.ts';
import { createWorkspaceVerifier } from '../../../packages/core/src/workspace/verification.ts';
import { prepareTestWorkspaceVerifier } from '../../support/workspace.ts';
import { createInvoiceWorkTimelineService } from '../../../packages/core/src/personal-agent/timeline.ts';

const at = '2026-10-29T00:00:00.000Z';
function need<T>(value: Result<T>): T { if (!value.ok) throw Error(`${value.error.code}: ${value.error.message}`); return value.data; }
type Fixture = Awaited<ReturnType<typeof invoiceWorkToolsFixture>>;
function service(f: Fixture) { return createInvoiceWorkTimelineService({ database: f.database }); }
async function work(f: Fixture) {
  const view = need(await f.database.read(scope => scope.invoiceWorks.get({ view: 'work', workId: f.created.workId, limit: 100 })));
  if (view.view !== 'work') throw Error('Expected the original Work.'); return view;
}

test('timeline is read-only, paginates equal timestamps by original keys and validates its actual cursor owner', async () => {
  const f = await invoiceWorkToolsFixture();
  const other = need(await f.database.transaction(scope => scope.invoiceWorks.create({ personalAgentId: 1, expectedAgentRevision: 0,
    requestId: 'another-work', goal: 'Independent review of the same original invoice.', documents: [{ id: 1, version: 'v1' }] },
  { at, admission: { kind: 'queued' } })));
  const readonly = createInvoiceWorkTimelineService({ database: { read: operation => f.database.read(scope => {
    const query = scope.db.query;
    scope.db.query = <Row extends object, Bindings extends SQLQueryBindings | SQLQueryBindings[]>(sql: string) => {
      if (!/^\s*(?:SELECT|WITH)\b/i.test(sql)) throw Error('The timeline attempted a write.');
      return query<Row, Bindings>(sql);
    };
    return operation(scope);
  }) } });
  const original = await work(f), entries: InvoiceWorkTimelineEntry[] = [];
  let before: InvoiceWorkTimelineCursor | undefined;
  for (let pages = 0; pages < 20; pages++) {
    const page = need(await readonly.timeline({ workId: f.created.workId, limit: 2, ...(before ? { before } : {}) }));
    expect(InvoiceWorkTimelinePageSchema.safeParse(page).success).toBe(true);
    expect(page.entries.length).toBeLessThanOrEqual(2);
    entries.push(...page.entries);
    if (page.nextBefore === null) break;
    before = page.nextBefore;
    if (pages === 19) throw Error('Timeline continuation did not finish.');
  }
  expect(entries.map(entry => entry.kind)).toEqual(expect.arrayContaining(['work_created', 'attempt_created', 'run_created', 'run_started']));
  expect(new Set(entries.map(entry => entry.key)).size).toBe(entries.length);
  expect(entries.every((entry, index) => index === 0 || compareInvoiceWorkTimelineCursor(entries[index - 1]!, entry) > 0)).toBe(true);
  const foreign = need(await service(f).timeline({ workId: other.workId, limit: 100 })).entries.find(entry => entry.sourceKind === 'operation');
  if (!foreign) throw Error('Expected the other original operation.');
  const { occurredAt, sourceKind, sourceId, kind } = foreign;
  expect(await readonly.timeline({ workId: f.created.workId, before: { occurredAt, sourceKind, sourceId, kind } })).toMatchObject({ ok: false });
  expect(await readonly.timeline({ workId: f.created.workId, limit: 101 })).toMatchObject({ ok: false });
  expect(await readonly.timeline({ workId: 999_999 })).toMatchObject({ ok: false });
  expect(await work(f)).toEqual(original);
  await f.database.close();
});

test('Todo, supplement and final disposition project once from committed records without copying bodies', async () => {
  const f = await invoiceWorkToolsFixture();
  const todo = await f.database.transaction(scope => {
    const state = need(scope.invoiceWorks.get({ view: 'item', workId: f.created.workId, itemId: f.itemId }));
    if (state.view !== 'item') throw Error('Expected the selected original invoice.');
    return need(scope.invoiceWorks.replaceTodos({ workId: f.created.workId, itemId: f.itemId, expectedRevision: state.item.revision,
      todos: [{ actor: 'user', fieldPath: 'fields.totalAmount', problem: 'Private Todo body must remain in its original reader.',
        needed: 'Original explanation.', satisfiedBy: 'Recorded clarification.', action: 'supplement',
        basis: { origin: 'rule', documentRefs: [{ id: 1, version: 'v1' }], sourceRefs: [], inputIds: [], candidateRef: null } }], at }))[0]!;
  });
  const command = { workId: f.created.workId, itemId: f.itemId, todoId: todo.todoId, requestId: 'original-clarification',
    expectedRevision: (await work(f)).work.revision, text: 'Private supplement body must remain in its original reader.', materials: [] };
  const receipt = need(await f.database.transaction(scope => scope.invoiceWorks.supplement(command,
    { at, admission: { kind: 'waiting', reason: 'Controlled saved-only input.' } })));
  expect(await f.database.transaction(scope => scope.invoiceWorks.supplement(command,
    { at, admission: { kind: 'queued' } }))).toEqual({ ok: true, data: receipt });
  need(await f.database.transaction(scope => scope.invoiceWorks.disposeItem({ workId: f.created.workId, itemId: f.itemId,
    expectedRevision: (need(scope.invoiceWorks.get({ view: 'work', workId: f.created.workId })) as { work: { revision: number } }).work.revision,
    requestId: 'original-exclusion', decision: { kind: 'excluded', reason: 'Original explicit exclusion.' } }, { at })));
  const page = need(await service(f).timeline({ workId: f.created.workId, limit: 100 }));
  expect(page.entries.filter(entry => entry.kind === 'supplement_received')).toHaveLength(1);
  expect(page.entries.find(entry => entry.kind === 'supplement_received')?.refs)
    .toMatchObject({ inputId: receipt.inputId, todoId: todo.todoId, requestId: command.requestId });
  expect(page.entries.filter(entry => entry.kind === 'item_disposed')).toHaveLength(1);
  expect(page.entries.map(entry => entry.kind)).toEqual(expect.arrayContaining(['todo_created', 'todo_superseded']));
  expect(JSON.stringify(page)).not.toContain('Private Todo body');
  expect(JSON.stringify(page)).not.toContain('Private supplement body');
  expect(need(await service(f).timeline({ workId: f.created.workId, limit: 100 }))).toEqual(page);
  await f.database.close();
});

async function acceptedFixture() {
  const f = await invoiceWorkToolsFixture(), saved = await f.execute('save_invoice_candidate', { documentId: 1, candidate: invoiceWorkCandidateDraft() }, 'save-original');
  expect(saved.result.status).toBe('succeeded');
  const candidate = need(await f.database.read(scope => scope.candidates.readByJob({ jobId: f.jobId,
    candidateId: need(scope.jobs.get(f.jobId)).currentCandidateId! }))).candidate;
  need(await f.database.transaction(scope => scope.runs.finish(f.runId, { status: 'failed', output: null,
    error: { code: 'controlled-finish', category: 'runtime', message: 'Controlled offline closure.', retryable: false },
    usage: { version: 1, source: 'not-requested', reason: 'offline', sdkValues: null, attempts: 0, attemptsComplete: true, costSource: null, updatedAt: at },
    tokens: { inputTokens: null, outputTokens: null, totalTokens: null, cost: null, usageComplete: false },
    cleanup: { version: 1, stopped: true, stopReason: 'controlled-close', errors: [], lateObservationRequired: false }, endedAt: at, stoppedAt: at, durationMs: 0 })));
  need(await f.database.transaction(scope => scope.invoiceWorkAttempts.requestStop({ workId: f.created.workId, attemptId: f.attemptId,
    requestId: 'close-original-offline-attempt', expectedRevision: need(scope.invoiceWorks.get({ view: 'work', workId: f.created.workId })).work.revision }, { at })));
  need(await f.database.transaction(scope => scope.invoiceWorks.closeUnsubmittedPhase({ workId: f.created.workId, attemptId: f.attemptId,
    requestId: f.phase.requestId, stopResult: { workId: f.created.workId, sessionId: f.created.sessionId, attemptId: f.attemptId,
      stopped: true, reason: 'not-started' }, at })));
  need(await f.database.transaction(scope => scope.invoiceWorkAttempts.finish({ workId: f.created.workId, attemptId: f.attemptId,
    runId: f.runId, effectsReconciled: true, at })));
  const files = createFileStore(f.paths, f.database), documents = createDocumentService({ paths: f.paths, files, allowedSourceRoot: f.paths.root,
    now: () => at, transaction: operation => f.database.transaction(scope => operation({ repository: scope.documents,
      files: { read: (artifact, name) => files.read(artifact, name, scope.contents) } })) });
  await f.database.transaction(() => { prepareTestWorkspaceVerifier(f.database, f.paths.root); });
  const selected = need(await f.database.transaction(scope => scope.workspace.update({ change: { kind: 'job', jobId: f.jobId },
    expectedRevision: need(scope.workspace.read(at)).revision, at }, createWorkspaceVerifier({
      inspectMaterial: (reference) => documents.inspectForWorkspace(reference, { repository: scope.documents,
        files: { read: (artifact, name) => files.read(artifact, name, scope.contents) } }),
    }))));
  const edited = need(await f.database.transaction(scope => scope.candidates.saveHuman({ operationRef: 'original-human-edit', jobId: f.jobId,
    basedOnCandidateId: candidate.candidateId, expectedCandidateId: candidate.candidateId, expectedRevision: selected.revision,
    draft: InvoiceFormDraftSchema.parse({ fields: { invoiceNumber: '', issueDate: '', sellerName: '', sellerTaxId: '', buyerName: '',
      buyerTaxId: '', currency: '', netAmount: '', taxAmount: '', totalAmount: '114.00' }, lines: [], notes: [] }), at,
    validate: (draft, reference) => validateHumanInvoiceCandidate(draft, reference, { readParsedForWorkspace: id => documents.readParsedForWorkspace(id,
      { repository: scope.documents, files: { read: (artifact, name) => files.read(artifact, name, scope.contents) } }) }) })));
  const acceptRequest = { operationRef: 'original-human-accept', jobId: f.jobId, candidateId: edited.candidate.candidateId,
    expectedCandidateId: edited.candidate.candidateId, expectedRevision: edited.workspace.revision, dirty: false as const };
  need(await f.database.transaction(scope => scope.candidates.accept({ ...acceptRequest, at,
    validate: (draft, reference) => validateHumanInvoiceCandidate(draft, reference, { readParsedForWorkspace: id => documents.readParsedForWorkspace(id,
      { repository: scope.documents, files: { read: (artifact, name) => files.read(artifact, name, scope.contents) } }) }) })));
  return { f, candidate, edited, acceptRequest };
}

test('candidate creation, checks, human edit and acceptance retain their actual candidate version and operation references', async () => {
  const { f, candidate, edited, acceptRequest } = await acceptedFixture();
  const page = need(await service(f).timeline({ workId: f.created.workId, limit: 100 }));
  expect(page.entries.find(entry => entry.kind === 'candidate_generated')?.refs.candidateRef)
    .toEqual({ id: candidate.candidateId, sequence: candidate.sequence });
  expect(page.entries.find(entry => entry.kind === 'candidate_edited')?.refs)
    .toMatchObject({ operationRef: 'original-human-edit', candidateRef: { id: edited.candidate.candidateId, sequence: edited.candidate.sequence } });
  expect(page.entries.find(entry => entry.kind === 'candidate_accepted')?.refs.operationRef).toBe(acceptRequest.operationRef);
  expect(page.entries.find(entry => entry.kind === 'candidate_generated')?.summary).toContain('checks');
  expect(JSON.stringify(page)).not.toContain('Total 113.00');
  expect(JSON.stringify(page)).not.toContain('fields');
  await f.database.close();
});

test('the same invoice acceptance stays with its original Work until the other item explicitly references it', async () => {
  const { f, edited, acceptRequest } = await acceptedFixture();
  const other = need(await f.database.transaction(scope => scope.invoiceWorks.create({ personalAgentId: 1, expectedAgentRevision: 0,
    requestId: 'separate-same-invoice', goal: 'A separate review of the same parsed invoice.', documents: [{ id: 1, version: 'v1' }] },
  { at, admission: { kind: 'queued' } })));
  const before = need(await service(f).timeline({ workId: other.workId, limit: 100 }));
  expect(before.entries.some(entry => entry.kind.startsWith('candidate_') || entry.kind === 'item_disposed')).toBe(false);
  const state = need(await f.database.read(scope => scope.invoiceWorks.get({ view: 'work', workId: other.workId, limit: 100 })));
  if (state.view !== 'work' || !state.items[0]) throw Error('Expected the separate invoice item.');
  need(await f.database.transaction(scope => scope.invoiceWorks.disposeItem({ workId: other.workId, itemId: state.items[0]!.itemId,
    expectedRevision: state.work.revision, requestId: 'explicit-original-acceptance', decision: { kind: 'accepted',
      candidateRef: { id: edited.candidate.candidateId, sequence: edited.candidate.sequence }, acceptRequest } }, { at })));
  const after = need(await service(f).timeline({ workId: other.workId, limit: 100 }));
  expect(after.entries.some(entry => entry.kind.startsWith('candidate_'))).toBe(false);
  expect(after.entries.filter(entry => entry.kind === 'item_disposed')).toHaveLength(1);
  expect(after.entries.find(entry => entry.kind === 'item_disposed')?.refs).toMatchObject({
    operationRef: acceptRequest.operationRef, candidateRef: { id: edited.candidate.candidateId, sequence: edited.candidate.sequence } });
  expect(need(await service(f).timeline({ workId: f.created.workId, limit: 100 })).entries.some(entry => entry.kind === 'candidate_accepted')).toBe(true);
  await f.database.close();
});
