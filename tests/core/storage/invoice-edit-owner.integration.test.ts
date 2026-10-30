import { expect, test } from 'bun:test';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { appError, fail, ok, invoiceHeaderFields } from '@flowmate/contracts';
import type { Result } from '@flowmate/contracts';
import { createInvoiceEditService } from '../../../packages/core/src/invoice-edit/service.ts';
import { createFileStore } from '../../../packages/core/src/storage/file-store.ts';
import { makeCurrentSelectedCandidate } from '../../support/selected-candidate.ts';

function need<T>(value: Result<T>): T { if (!value.ok) throw Error(value.error.code); return value.data; }
const tick = () => new Promise<void>(resolve => setImmediate(resolve));

async function fixture() {
  const store = await makeCurrentSelectedCandidate();
  const files = createFileStore({ root: store.root, databaseFile: store.db.filename,
    artifactsDir: join(store.root, 'artifacts'), outputsDir: join(store.root, 'outputs'),
    logsDir: join(store.root, 'logs'), runtimeDir: join(store.root, 'runtime') }, store);
  const edits = createInvoiceEditService({ database: store, files, now: () => store.stamp,
    validate: () => ok({ checks: [], issues: [] }) });
  const accept = { operationRef: 'owner-human-accept', jobId: store.jobId, candidateId: store.candidateId,
    expectedCandidateId: store.candidateId, expectedRevision: store.selectedWorkspace.revision, dirty: false };
  return { store, files, edits, accept };
}

test('human acceptance waits for its owner and uses the current candidate repository', async () => {
  const f = await fixture(), entered = Promise.withResolvers<void>(), release = Promise.withResolvers<void>();
  const held = f.store.transaction(async () => { entered.resolve(); await release.promise; });
  await entered.promise;
  f.store.candidates.accept = () => fail(appError('storage_write_failed', 'storage', 'Expired root candidate repository.'));
  let settled = false;
  const accepting = Promise.resolve(f.edits.accept(f.accept)).then(value => { settled = true; return value; });
  try { await tick(); expect(settled).toBe(false); }
  finally { release.resolve(); await held; }
  expect(await accepting).toMatchObject({ ok: true, data: { candidate: { status: 'accepted' } } });
  expect(await f.store.read(scope => scope.jobs.get(f.store.jobId))).toMatchObject({ ok: true, data: { status: 'completed' } });
});

test('an invoice export waits for committed bytes and publishes outside its SQL transaction', async () => {
  const f = await fixture(); need(await f.edits.accept(f.accept));
  const transaction = f.store.transaction, release = Promise.withResolvers<void>();
  let entered = false, publishedInTransaction: boolean | undefined;
  f.store.transaction = operation => {
    f.store.transaction = transaction;
    return transaction(async scope => { const value = await operation(scope); entered = true; await release.promise; return value; });
  };
  const publish = f.files.publishInvoiceExport.bind(f.files);
  f.files.publishInvoiceExport = (...parameters) => { publishedInTransaction = f.store.db.inTransaction; return publish(...parameters); };
  const request = { operationRef: 'owner-invoice-export', candidateId: f.store.candidateId, format: 'json' as const };
  let settled = false;
  const exporting = Promise.resolve(f.edits.export(request)).then(value => { settled = true; return value; });
  try {
    await tick(); expect(entered).toBe(true); expect(settled).toBe(false);
    expect(existsSync(join(f.store.root, 'outputs', `invoice-${f.store.jobId}-result-1.json`))).toBe(false);
  } finally { release.resolve(); }
  const reference = need(await exporting);
  expect(publishedInTransaction).toBe(false);
  expect(await f.edits.queryOperation({ kind: 'export', request })).toEqual(ok(reference));
});

test('oversized formatted exports store no managed bytes and publish no file', async () => {
  const f = await fixture();
  const candidate = need(await f.store.read(scope => scope.candidates.readByJob({ jobId: f.store.jobId,
    candidateId: f.store.candidateId }))).candidate;
  const text = '\u0001'.repeat(1024);
  for (const name of invoiceHeaderFields) candidate.fields[name] = { raw: text, normalized: text,
    state: 'ambiguous', alternatives: Array.from({ length: 5 }, () => text), sources: [] };
  const missing = () => ({ raw: null, normalized: null, state: 'missing' as const, alternatives: [], sources: [] });
  const lines = Array.from({ length: 200 }, () => ({ description: missing(), quantity: missing(), unit: missing(),
    unitPrice: missing(), netAmount: missing(), taxRate: missing(), taxAmount: missing(), totalAmount: missing() }));
  await f.store.transaction(scope => {
    scope.db.query("UPDATE invoice_candidates SET fields_json=json_set(fields_json,'$.values',json(?)),lines_json=json_set(lines_json,'$.items',json(?)) WHERE id=?")
      .run(JSON.stringify(candidate.fields), JSON.stringify(lines), f.store.candidateId);
  });
  need(await f.edits.accept(f.accept));
  expect(await f.edits.export({ operationRef: 'too-large-export', candidateId: f.store.candidateId, format: 'csv' }))
    .toMatchObject({ ok: false, error: { code: 'input_invalid' } });
  expect(await f.store.read(scope => scope.db.query("SELECT COUNT(*) AS count FROM managed_file_contents WHERE owner_kind='invoice-export'").get()))
    .toEqual({ count: 0 });
  expect(existsSync(join(f.store.root, 'outputs', `invoice-${f.store.jobId}-result-1.csv`))).toBe(false);
});
