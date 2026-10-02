import { describe, expect, it } from 'bun:test';
import { invoiceHeaderFields, invoiceFieldDisplayValue, CandidateDraftSchema, StoredCandidateDraftSchema } from '@flowmate/contracts';
import type { InvoiceFormDraft, Result } from '@flowmate/contracts';
import { makeSelectedCandidate } from '../../support/selected-candidate.ts';
import { openDatabase } from '../../../packages/core/src/storage/database.ts';
import { Database } from 'bun:sqlite';
import { join } from 'node:path';
import { deferCleanup } from '../../support/resources.ts';
import { createInvoiceEditService } from '../../../packages/core/src/invoice-edit/service.ts';
import { createFileStore } from '../../../packages/core/src/storage/file-store.ts';
import { DocumentService } from '../../../packages/data/src/documents.ts';
import { validateHumanInvoiceCandidate } from '../../../packages/employee-invoice/src/validation.ts';

function required<T>(result: Result<T>): T { if (!result.ok) throw new Error(result.error.code); return result.data; }
function request(store: ReturnType<typeof makeSelectedCandidate>) {
  const candidate = required(store.candidates.readByJob({ jobId: store.jobId, candidateId: store.candidateId })).candidate;
  const draft: InvoiceFormDraft = { fields: Object.fromEntries(invoiceHeaderFields.map(name =>
    [name, invoiceFieldDisplayValue(name, candidate.fields[name])])) as InvoiceFormDraft['fields'], lines: [], notes: [] };
  return { operationRef: 'edit-once', jobId: store.jobId, basedOnCandidateId: store.candidateId,
    expectedCandidateId: store.candidateId, expectedRevision: store.selectedWorkspace.revision, draft };
}

describe('human candidate transactions', () => {
  it('migrates to 12 while preserving model IDs, bytes, pointers and foreign keys', () => {
    const legacy = makeSelectedCandidate(true);
    const paths = { root: legacy.root, databaseFile: join(legacy.root,'data','flowmate.sqlite'), outputsDir: join(legacy.root,'outputs'),
      artifactsDir: join(legacy.root,'artifacts'), logsDir: join(legacy.root,'logs'), runtimeDir: join(legacy.root,'runtime') };
    const candidateSql = 'SELECT id,job_id,run_id,tool_call_id,sequence,origin,status,fields_json,lines_json,issues_json,created_at,accepted_at FROM invoice_candidates';
    const before = { candidate: legacy.db.query(candidateSql).all(), jobs: legacy.db.query('SELECT * FROM jobs').all(),
      artifacts: legacy.db.query('SELECT * FROM artifacts').all(), events: legacy.db.query('SELECT * FROM business_events').all() };
    expect(legacy.db.query('SELECT MAX(version) AS version FROM schema_migrations').get()).toEqual({ version: 9 });
    legacy.close();
    const store = required(openDatabase(paths)); deferCleanup(() => store.close());
    expect(store.db.query('SELECT MAX(version) AS version FROM schema_migrations').get()).toEqual({ version: 12 });
    expect({ candidate: store.db.query(candidateSql).all(), jobs: store.db.query('SELECT * FROM jobs').all(),
      artifacts: store.db.query('SELECT * FROM artifacts').all(), events: store.db.query('SELECT * FROM business_events').all() }).toEqual(before);
    expect(store.db.query('PRAGMA foreign_key_check').all()).toEqual([]);
    expect(store.db.query('PRAGMA foreign_keys').get()).toEqual({ foreign_keys: 1 });
    const input = request({ ...legacy, candidates: store.candidates }); input.draft.notes = ['Migrated human note.'];
    expect(required(store.candidates.saveHuman({ ...input, at: legacy.stamp, validate: () => ({ ok: true, data: { checks: [], issues: [] } }) })))
      .toMatchObject({ changed: true, candidate: { runId: null, toolCallId: null, origin: 'human_edit' } });
  });

  it('rolls back all table replacements if migration 010 cannot commit its marker', () => {
    const legacy = makeSelectedCandidate(true);
    const before = legacy.db.query('SELECT * FROM invoice_candidates').all();
    const path = join(legacy.root,'data','flowmate.sqlite');
    legacy.db.exec("CREATE TRIGGER reject_schema_10 BEFORE INSERT ON schema_migrations WHEN NEW.version=10 BEGIN SELECT RAISE(ABORT,'injected'); END");
    legacy.close();
    expect(openDatabase({ root: legacy.root, databaseFile: path, artifactsDir: join(legacy.root,'artifacts'),
      outputsDir: join(legacy.root,'outputs'), logsDir: join(legacy.root,'logs'), runtimeDir: join(legacy.root,'runtime') }))
      .toMatchObject({ ok: false, error: { code: 'storage_open_failed' } });
    const db = new Database(path); deferCleanup(() => db.close());
    expect(db.query('SELECT MAX(version) AS version FROM schema_migrations').get()).toEqual({ version: 9 });
    expect(db.query('SELECT * FROM invoice_candidates').all()).toEqual(before);
    expect(db.query('PRAGMA foreign_key_check').all()).toEqual([]);
    expect((db.query('PRAGMA table_info(invoice_candidates)').all() as { name: string }[]).some(column => column.name === 'based_on_candidate_id')).toBe(false);
  });

  it('saves an actual string diff with null execution identity, retains its basis and never reselects on retry', () => {
    const store = makeSelectedCandidate();
    const input = request(store); input.draft.fields.totalAmount = '999999999999999999.123456';
    const changed = required(store.candidates.saveHuman({ ...input, at: store.stamp,
      validate: () => ({ ok: true, data: { checks: [], issues: [] } }) }));
    expect(changed).toMatchObject({ changed: true, candidate: { origin: 'human_edit', basedOnCandidateId: store.candidateId,
      runId: null, toolCallId: null, fields: { totalAmount: { raw: '999999999999999999.123456',
        normalized: '999999999999999999.123456', valueOrigin: 'user-provided', sources: [] } } } });
    required(store.workspace.selectCandidate({ jobId: store.jobId, candidateId: store.candidateId,
      expectedCandidateId: changed.candidate.candidateId, expectedRevision: changed.workspace.revision, at: store.stamp }));
    const again = required(store.candidates.saveHuman({ ...input, at: store.stamp,
      validate: () => { throw new Error('duplicate must query first'); } }));
    expect(again.candidate.candidateId).toBe(changed.candidate.candidateId);
    expect(again.workspace.candidateRef?.id).toBe(store.candidateId);
    input.draft.fields.totalAmount = '2';
    expect(store.candidates.saveHuman({ ...input, at: store.stamp, validate: () => ({ ok: true, data: { checks: [], issues: [] } }) }))
      .toMatchObject({ ok: false, error: { code: 'state_conflict' } });
  });

  it('does not append a no-difference version or activity, rejects evidence injection and invalid decimals', () => {
    const store = makeSelectedCandidate(); const input = request(store);
    const count = () => store.db.query('SELECT COUNT(*) AS count FROM business_events').get();
    const originalCount = count();
    expect(required(store.candidates.saveHuman({ ...input, at: store.stamp, validate: () => { throw new Error('no diff'); } })))
      .toMatchObject({ changed: false, candidate: { candidateId: store.candidateId } });
    expect(count()).toEqual(originalCount);
    input.draft.fields.totalAmount = '1e3';
    expect(store.candidates.saveHuman({ ...input, at: store.stamp, validate: () => ({ ok: true, data: { checks: [], issues: [] } }) }))
      .toMatchObject({ ok: false, error: { code: 'input_invalid' } });
    const field = { raw: '1', normalized: '1', state: 'present', alternatives: [], sources: [], valueOrigin: 'user-provided' };
    const original = required(store.candidates.readByJob({ jobId: store.jobId, candidateId: store.candidateId })).candidate;
    expect(CandidateDraftSchema.safeParse({ fields: { ...original.fields, totalAmount: field }, lines: [], notes: [] }).success).toBe(false);
    expect(StoredCandidateDraftSchema.safeParse({ fields: { ...original.fields, totalAmount: field }, lines: [], notes: [] }).success).toBe(true);
  });

  it('rolls back a candidate, pointer and event together and forbids writes while cleanup is unresolved', () => {
    const store = makeSelectedCandidate(); const input = request(store); input.draft.fields.totalAmount = '1';
    store.db.exec("CREATE TRIGGER reject_human_activity BEFORE INSERT ON business_events WHEN NEW.type='candidate_edited' BEGIN SELECT RAISE(ABORT,'injected'); END");
    expect(store.candidates.saveHuman({ ...input, at: store.stamp, validate: () => ({ ok: true, data: { checks: [], issues: [] } }) }))
      .toMatchObject({ ok: false, error: { code: 'storage_write_failed' } });
    expect(store.db.query('SELECT COUNT(*) AS count FROM invoice_candidates').get()).toEqual({ count: 1 });
    expect(required(store.workspace.read(store.stamp)).candidateRef?.id).toBe(store.candidateId);
    store.db.exec('DROP TRIGGER reject_human_activity');
    store.db.query("UPDATE runs SET cleanup_json=json_set(cleanup_json,'$.lateObservationRequired',json('true')) WHERE id=?").run(store.runId);
    expect(store.candidates.saveHuman({ ...input, at: store.stamp, validate: () => ({ ok: true, data: { checks: [], issues: [] } }) }))
      .toMatchObject({ ok: false, error: { code: 'state_conflict' } });
  });

  it('requires explicit saved candidate acceptance, commits the Job and preserves accepted immutability', () => {
    const store = makeSelectedCandidate();
    const input = { operationRef: 'accept-once', jobId: store.jobId, candidateId: store.candidateId,
      expectedCandidateId: store.candidateId, expectedRevision: store.selectedWorkspace.revision, dirty: false as const, at: store.stamp, validate: () => ({ ok: true as const, data: { checks: [], issues: [] } }) };
    expect(store.candidates.accept({ ...input, dirty: true } as never)).toMatchObject({ ok: false, error: { code: 'input_invalid' } });
    const accepted = required(store.candidates.accept(input));
    expect(accepted).toMatchObject({ candidate: { status: 'accepted' }, job: { status: 'completed', acceptedCandidateId: store.candidateId } });
    expect(required(store.candidates.accept(input))).toEqual(accepted);
    expect(required(store.candidates.readAccepted(store.candidateId)).candidate.status).toBe('accepted');
    const editing = request(store); editing.expectedRevision = accepted.workspace.revision; editing.draft.fields.totalAmount = '1';
    expect(store.candidates.saveHuman({ ...editing, at: store.stamp, validate: () => ({ ok: true, data: { checks: [], issues: [] } }) }))
      .toMatchObject({ ok: false, error: { code: 'job_completed' } });
    expect(store.candidates.reject({ operationRef: 'reject-accepted', jobId: store.jobId, candidateId: store.candidateId,
      expectedCandidateId: store.candidateId, expectedRevision: accepted.workspace.revision, reason: 'No', at: store.stamp }))
      .toMatchObject({ ok: false, error: { code: 'job_completed' } });
  });

  it('verifies real parsed evidence, keeps unchanged sources, and checks damaged values again before acceptance', () => {
    const store = makeSelectedCandidate(false, true);
    const paths = { root: store.root, databaseFile: join(store.root,'data','flowmate.sqlite'), outputsDir: join(store.root,'outputs'),
      artifactsDir: join(store.root,'artifacts'), logsDir: join(store.root,'logs'), runtimeDir: join(store.root,'runtime') };
    const files = createFileStore(paths, store.documents);
    const documents = new DocumentService({ paths, allowedSourceRoot: store.root, repository: store.documents, files, now: () => store.stamp });
    const edits = createInvoiceEditService({ candidates: store.candidates, files, now: () => store.stamp,
      validate: (draft, ref) => validateHumanInvoiceCandidate(draft, ref, documents) });
    const input = request(store); input.draft.notes = ['User explanation only.'];
    const saved = required(edits.save(input));
    expect(saved.candidate.fields.totalAmount).toEqual(required(store.candidates.readByJob({ jobId: store.jobId, candidateId: store.candidateId })).candidate.fields.totalAmount);
    expect(saved.candidate.issues.some(issue => issue.code === 'model_note')).toBe(false);
    expect(saved.candidate.sources).toHaveLength(1);
    const operation = { operationRef: 'accept-source', jobId: store.jobId, candidateId: saved.candidate.candidateId,
      expectedCandidateId: saved.candidate.candidateId, expectedRevision: saved.workspace.revision, dirty: false };
    store.db.query("UPDATE invoice_candidates SET fields_json=json_set(fields_json,'$.values.totalAmount.sources[0].quote','Forged quote') WHERE id=?")
      .run(saved.candidate.candidateId);
    expect(edits.accept(operation)).toMatchObject({ ok: false, error: { code: 'input_invalid' } });
    expect(required(store.jobs.get(store.jobId)).status).not.toBe('completed');
    store.db.query("UPDATE invoice_candidates SET fields_json=json_set(fields_json,'$.values.totalAmount.sources[0].quote','Total 113.00','$.values.totalAmount.normalized','1e3') WHERE id=?")
      .run(saved.candidate.candidateId);
    expect(edits.accept(operation)).toMatchObject({ ok: false, error: { code: 'input_invalid' } });
    store.db.query("UPDATE invoice_candidates SET fields_json=json_set(fields_json,'$.values.totalAmount.normalized','113.00') WHERE id=?").run(saved.candidate.candidateId);
    expect(edits.accept(operation)).toMatchObject({ ok: true, data: { candidate: { status: 'accepted' } } });
  });

  it('queries committed operations without running validation or modifying a later current pointer', () => {
    const store = makeSelectedCandidate(); const input = request(store); input.draft.notes = ['Note'];
    const saved = required(store.candidates.saveHuman({ ...input, at: store.stamp, validate: () => ({ ok: true, data: { checks: [], issues: [] } }) }));
    required(store.workspace.selectCandidate({ jobId: store.jobId, candidateId: store.candidateId, expectedCandidateId: saved.candidate.candidateId,
      expectedRevision: saved.workspace.revision, at: store.stamp }));
    const before = store.db.query('SELECT * FROM workspace').get();
    expect(required(store.candidates.queryOperation({ kind: 'save', request: input, at: store.stamp })))
      .toMatchObject({ candidate: { candidateId: saved.candidate.candidateId }, workspace: { candidateRef: { id: store.candidateId } } });
    expect(store.db.query('SELECT * FROM workspace').get()).toEqual(before);
    expect(store.candidates.queryOperation({ kind: 'save', request: { ...input, draft: { ...input.draft, notes: ['Other'] } }, at: store.stamp }))
      .toMatchObject({ ok: false, error: { code: 'state_conflict' } });
    expect(required(store.candidates.queryOperation({ kind: 'save', request: { ...input, operationRef: 'missing' }, at: store.stamp }))).toBeNull();
  });

  it('requires a new explicit selection to accept a rejected candidate and keeps delayed old pointers from changing it', () => {
    const store = makeSelectedCandidate();
    const rejected = required(store.candidates.reject({ operationRef: 'reject-once', jobId: store.jobId, candidateId: store.candidateId,
      expectedCandidateId: store.candidateId, expectedRevision: store.selectedWorkspace.revision, reason: 'Review again', at: store.stamp }));
    expect(rejected).toMatchObject({ candidate: { status: 'rejected' }, job: { currentCandidateId: null }, workspace: { candidateRef: null } });
    const selected = required(store.workspace.selectCandidate({ jobId: store.jobId, candidateId: store.candidateId,
      expectedCandidateId: null, expectedRevision: rejected.workspace.revision, at: store.stamp }));
    expect(required(store.candidates.readByJob({ jobId: store.jobId, candidateId: store.candidateId })).candidate.status).toBe('rejected');
    expect(store.candidates.accept({ operationRef: 'accept-old', jobId: store.jobId, candidateId: store.candidateId,
      expectedCandidateId: store.candidateId, expectedRevision: store.selectedWorkspace.revision, dirty: false, at: store.stamp,
      validate: () => ({ ok: true, data: { checks: [], issues: [] } }) }))
      .toMatchObject({ ok: false, error: { code: 'state_conflict' } });
    expect(required(store.candidates.accept({ operationRef: 'accept-reselected', jobId: store.jobId, candidateId: store.candidateId,
      expectedCandidateId: store.candidateId, expectedRevision: selected.workspace.revision, dirty: false, at: store.stamp,
      validate: () => ({ ok: true, data: { checks: [], issues: [] } }) })))
      .toMatchObject({ candidate: { status: 'accepted' }, job: { status: 'completed' } });
  });

  it('marks actual clearing and new lines as user values while all unchanged metadata remains intact', () => {
    const store = makeSelectedCandidate(false, true); const input = request(store);
    const basis = required(store.candidates.readByJob({ jobId: store.jobId, candidateId: store.candidateId })).candidate;
    input.draft.fields.totalAmount = '';
    input.draft.lines = [{ description: 'User line', quantity: '0', unit: 'each', unitPrice: '0.000001', netAmount: '0',
      taxRate: '0', taxAmount: '0', totalAmount: '0' }];
    const saved = required(store.candidates.saveHuman({ ...input, at: store.stamp, validate: () => ({ ok: true, data: { checks: [], issues: [] } }) }));
    expect(saved.candidate.fields.totalAmount).toEqual({ raw: null, normalized: null, state: 'missing', alternatives: [], sources: [], valueOrigin: 'user-provided' });
    expect(saved.candidate.fields.invoiceNumber).toEqual(basis.fields.invoiceNumber);
    expect(saved.candidate.fields.invoiceNumber).not.toHaveProperty('valueOrigin');
    expect(Object.values(saved.candidate.lines[0]!).every(field => field.valueOrigin === 'user-provided' && field.sources.length === 0)).toBe(true);
    expect(saved.candidate.lines[0]?.quantity.normalized).toBe('0');
    expect(required(store.candidates.readByJob({ jobId: store.jobId, candidateId: store.candidateId })).candidate).toEqual(basis);
    expect(required(store.candidates.listByJob({ jobId: store.jobId, beforeSequence: null, limit: 10 })).items[0])
      .toMatchObject({ origin: 'human_edit', basedOnCandidateId: store.candidateId, runId: null });
    expect(required(store.candidates.listForRun({ runId: store.runId, beforeSequence: null, limit: 10 })).candidates[0])
      .toMatchObject({ origin: 'human_edit', basedOnCandidateId: store.candidateId, runId: null });
    expect(required(store.candidates.readForRun({ runId: store.runId, candidateId: saved.candidate.candidateId })))
      .toMatchObject({ origin: 'human_edit', basedOnCandidateId: store.candidateId, runId: null, toolCallId: null });
  });
});
