import { expect, test } from 'bun:test';
import { appError, fail, invoiceHeaderFields, invoiceToolSchemas, ok, type Result } from '@flowmate/contracts';
import { CloudDesktopReview } from '../../../apps/cloud-desktop-review.ts';
import { createCloudDesktopHandler } from '../../../apps/cloud-desktop-gateway.ts';
import { invoiceWorkToolsFixture, invoiceWorkCandidateDraft } from '../../support/invoice-work-tools.ts';

const at = '2026-10-29T00:00:00.000Z';
function need<T>(result: Result<T>): T { if (!result.ok) throw Error(result.error.code); return result.data; }

test('cloud candidate review exposes only the original Work item and Job', async () => {
  const f = await invoiceWorkToolsFixture({ durableRuntimeId: '11111111-1111-4111-8111-111111111111' });
  const saved = await f.execute('save_invoice_candidate', { documentId: 1, candidate: invoiceWorkCandidateDraft() }, 'original-candidate');
  if (saved.result.status !== 'succeeded') throw Error(saved.result.error.code);
  const candidate = invoiceToolSchemas.save_invoice_candidate.output.parse(saved.result.data);
  const workspaceId = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
  const review = new CloudDesktopReview({ database: f.database, workspaceId,
    readOriginal: async () => fail(appError('unused', 'input', 'Unused.')) });
  const handler = createCloudDesktopHandler({ workspaceId, authorize: async () => ok(undefined),
    dispatch: async () => fail(appError('unused', 'input', 'Unused.')), review });
  const command = { type: 'cloud_review_candidate' as const, input: { workId: f.created.workId, itemId: f.itemId,
    documentRef: { id: 1, version: 'v1' }, jobId: f.jobId, candidateId: candidate.candidateId } };
  const envelope = { version: 1 as const, workspaceId, requestId: '22222222-2222-4222-8222-222222222222', command };
  try {
    expect(await handler(envelope)).toMatchObject({ ok: true, data: { workId: f.created.workId, itemId: f.itemId,
      status: 'generated', detail: { jobId: f.jobId, candidateId: candidate.candidateId, documentRef: { id: 1, version: 'v1' },
        candidate: { fields: { totalAmount: { normalized: '113.00' } } } } } });
    expect(await handler({ ...envelope, command: { ...command, input: { ...command.input, itemId: f.itemId + 1 } } }))
      .toMatchObject({ ok: false });
    expect(await handler({ ...envelope, command: { ...command, input: { ...command.input, jobId: f.jobId + 100 } } }))
      .toMatchObject({ ok: false });
    expect(await handler({ ...envelope, workspaceId: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb' })).toMatchObject({ ok: false });
  } finally { await f.database.close(); }
});

test('cloud acceptance uses the original Work and workspace revision and recovers the original receipt', async () => {
  const f = await invoiceWorkToolsFixture({ durableRuntimeId: '11111111-1111-4111-8111-111111111111' });
  const saved = await f.execute('save_invoice_candidate', { documentId: 1, candidate: invoiceWorkCandidateDraft() }, 'candidate-for-review');
  if (saved.result.status !== 'succeeded') throw Error(saved.result.error.code);
  const candidate = invoiceToolSchemas.save_invoice_candidate.output.parse(saved.result.data);
  await f.database.transaction(scope => {
    scope.db.query('UPDATE invoice_work_phases SET closed_at=? WHERE id=?').run(at, f.phase.phaseId);
    const run = need(scope.runs.get(f.runId));
    need(scope.runs.finish(f.runId, { status: 'completed', output: { version: 3, text: 'Candidate is ready for review.', partial: false,
      stopReason: 'phase-boundary', responseId: null, responseModel: null, durable: { workId: f.created.workId, attemptId: f.attemptId } },
      error: null, usage: run.usage, tokens: run.tokens,
      cleanup: { version: 1, stopped: true, stopReason: 'fixture-native-closed', errors: [], lateObservationRequired: false },
      endedAt: at, stoppedAt: at, durationMs: 0 }));
  });
  const workspaceId = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
  const verifyWorkspace = () => ok({ invalidReferences: [], material: null });
  const review = new CloudDesktopReview({ database: f.database, workspaceId, now: () => at, verifyWorkspace,
    validateCandidate: () => ok({ checks: [], issues: [] }), readOriginal: async () => fail(appError('unused', 'input', 'Unused.')) });
  const handler = createCloudDesktopHandler({ workspaceId, authorize: async () => ok(undefined),
    dispatch: async () => fail(appError('unused', 'input', 'Unused.')), review });
  const target = { workId: f.created.workId, itemId: f.itemId, documentRef: { id: 1, version: 'v1' } };
  const send = (command: unknown) => handler({ version: 1, workspaceId, requestId: '22222222-2222-4222-8222-222222222222', command });
  try {
    const opened = need(await send({ type: 'cloud_review_open', input: { ...target, jobId: f.jobId, candidateId: candidate.candidateId } })) as
      { workspaceRevision: number; sequence: number };
    const stale = { operationRef: 'cloud-accept-stale', jobId: f.jobId, expectedCandidateId: candidate.candidateId,
      candidateId: candidate.candidateId, expectedRevision: opened.workspaceRevision, dirty: false as const };
    await f.database.transaction(scope => need(scope.workspace.update({ expectedRevision: opened.workspaceRevision,
      change: { kind: 'document', documentId: null }, at }, verifyWorkspace)));
    expect(await send({ type: 'cloud_review_accept', input: { ...target, request: stale } })).toMatchObject({ ok: false });
    const reopened = need(await send({ type: 'cloud_review_open', input: { ...target, jobId: f.jobId, candidateId: candidate.candidateId } })) as
      { workspaceRevision: number; sequence: number };
    const request = { ...stale, operationRef: 'cloud-accept-original', expectedRevision: reopened.workspaceRevision };
    const input = { ...target, request };
    expect(await send({ type: 'cloud_review_accept', input: { ...input, itemId: input.itemId + 1 } })).toMatchObject({ ok: false });
    const results = await Promise.all([send({ type: 'cloud_review_accept', input }), send({ type: 'cloud_review_accept', input })]);
    expect(results).toEqual([expect.objectContaining({ ok: true }), expect.objectContaining({ ok: true })]);
    expect(await send({ type: 'cloud_review_query_accept', input })).toEqual(results[0]);
    expect(await f.database.read(scope => scope.db.query("SELECT COUNT(*) AS count FROM business_events WHERE type='candidate_accepted'").get()))
      .toEqual({ count: 1 });
    const item = need(await f.database.read(scope => scope.invoiceWorks.get({ view: 'item', workId: target.workId, itemId: target.itemId })));
    if (item.view !== 'item') throw Error('Expected the original Work item.');
    expect(need(await f.database.transaction(scope => scope.invoiceWorks.disposeItem({ workId: target.workId, itemId: target.itemId,
      expectedRevision: item.work.revision, requestId: 'attach-cloud-acceptance',
      decision: { kind: 'accepted', candidateRef: { id: candidate.candidateId, sequence: reopened.sequence }, acceptRequest: request } }, { at }))))
      .toMatchObject({ disposition: 'accepted' });
    expect(await send({ type: 'cloud_review_query_accept', input })).toEqual(results[0]);
  } finally { await f.database.close(); }
});

test('cloud candidate edits retain the original request and save user provenance once', async () => {
  const f = await invoiceWorkToolsFixture({ durableRuntimeId: '11111111-1111-4111-8111-111111111111' });
  const saved = await f.execute('save_invoice_candidate', { documentId: 1, candidate: invoiceWorkCandidateDraft() }, 'candidate-to-edit');
  if (saved.result.status !== 'succeeded') throw Error(saved.result.error.code);
  const candidate = invoiceToolSchemas.save_invoice_candidate.output.parse(saved.result.data);
  await f.database.transaction(scope => {
    scope.db.query('UPDATE invoice_work_phases SET closed_at=? WHERE id=?').run(at, f.phase.phaseId);
    const run = need(scope.runs.get(f.runId));
    need(scope.runs.finish(f.runId, { status: 'completed', output: { version: 3, text: 'Ready for review.', partial: false,
      stopReason: 'phase-boundary', responseId: null, responseModel: null, durable: { workId: f.created.workId, attemptId: f.attemptId } },
      error: null, usage: run.usage, tokens: run.tokens, cleanup: { version: 1, stopped: true, stopReason: 'fixture-native-closed',
        errors: [], lateObservationRequired: false }, endedAt: at, stoppedAt: at, durationMs: 0 }));
  });
  const workspaceId = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
  const review = new CloudDesktopReview({ database: f.database, workspaceId, now: () => at,
    verifyWorkspace: () => ok({ invalidReferences: [], material: null }), validateCandidate: () => ok({ checks: [], issues: [] }),
    readOriginal: async () => fail(appError('unused', 'input', 'Unused.')) });
  const handler = createCloudDesktopHandler({ workspaceId, authorize: async () => ok(undefined),
    dispatch: async () => fail(appError('unused', 'input', 'Unused.')), review });
  const target = { workId: f.created.workId, itemId: f.itemId, documentRef: { id: 1, version: 'v1' } };
  const send = (command: unknown) => handler({ version: 1, workspaceId, requestId: '22222222-2222-4222-8222-222222222222', command });
  try {
    const opened = need(await send({ type: 'cloud_review_open', input: { ...target, jobId: f.jobId, candidateId: candidate.candidateId } })) as { workspaceRevision: number };
    const fields = Object.fromEntries(invoiceHeaderFields.map(name => [name, name === 'totalAmount' ? '120.00' : '']));
    const request = { operationRef: 'original-cloud-edit', jobId: f.jobId, expectedCandidateId: candidate.candidateId,
      basedOnCandidateId: candidate.candidateId, expectedRevision: opened.workspaceRevision, draft: { fields, lines: [], notes: [] } };
    const input = { ...target, request };
    const unchanged = { ...input, request: { ...request, operationRef: 'unchanged-cloud-edit',
      draft: { ...request.draft, fields: { ...fields, totalAmount: '113.00' } } } };
    expect(await send({ type: 'cloud_review_save', input: unchanged })).toMatchObject({ ok: true, data: { changed: false, candidateId: candidate.candidateId } });
    expect(await send({ type: 'cloud_review_query_save', input: unchanged })).toEqual({ ok: true, data: null });
    expect(await send({ type: 'cloud_review_save', input: unchanged })).toMatchObject({ ok: true, data: { changed: false } });
    const receipt = need(await send({ type: 'cloud_review_save', input })) as { candidateId: number; sequence: number; changed: boolean };
    expect(receipt).toMatchObject({ changed: true, sequence: 2 });
    expect(await send({ type: 'cloud_review_query_save', input })).toEqual({ ok: true, data: receipt });
    expect(await send({ type: 'cloud_review_save', input })).toEqual({ ok: true, data: receipt });
    expect(await send({ type: 'cloud_review_save', input: { ...input, request: { ...request, draft: { ...request.draft,
      fields: { ...fields, totalAmount: '130.00' } } } } })).toMatchObject({ ok: false });
    const edited = need(await f.database.read(scope => scope.candidates.readByJob({ jobId: f.jobId, candidateId: receipt.candidateId })));
    expect(edited.candidate).toMatchObject({ origin: 'human_edit', basedOnCandidateId: candidate.candidateId,
      fields: { totalAmount: { normalized: '120.00', valueOrigin: 'user-provided' } } });
    expect(await f.database.read(scope => scope.db.query("SELECT COUNT(*) AS count FROM business_events WHERE type='candidate_edited'").get()))
      .toEqual({ count: 1 });
    const reopened = need(await send({ type: 'cloud_review_open', input: { ...target, jobId: f.jobId, candidateId: receipt.candidateId } })) as { workspaceRevision: number };
    const reject = { ...target, request: { operationRef: 'original-cloud-rejection', jobId: f.jobId,
      expectedCandidateId: receipt.candidateId, candidateId: receipt.candidateId, expectedRevision: reopened.workspaceRevision, reason: 'Needs another review.' } };
    const rejected = need(await send({ type: 'cloud_review_reject', input: reject }));
    expect(rejected).toMatchObject({ candidateId: receipt.candidateId, status: 'rejected' });
    expect(await send({ type: 'cloud_review_query_reject', input: reject })).toEqual({ ok: true, data: rejected });
    const item = need(await f.database.read(scope => scope.invoiceWorks.get({ view: 'item', workId: target.workId, itemId: target.itemId })));
    expect(item).toMatchObject({ item: { disposition: 'unresolved' } });
  } finally { await f.database.close(); }
});
