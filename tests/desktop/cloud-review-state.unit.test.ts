import { expect, test } from 'bun:test';
import { invoiceHeaderFields, InvoiceFormDraftSchema } from '@flowmate/contracts';
import { readCloudReviewDraft, saveCloudReviewDraft } from '../../apps/desktop/renderer/src/cloud-review-state.ts';

test('cloud review retains its exact pending edit only in the original workspace', () => {
  const values = new Map<string, string>(), storage = { getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => { values.set(key, value); } };
  const workspaceId = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', other = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
  const target = { workId: 1, itemId: 2, documentRef: { id: 3, version: 'v1' }, jobId: 4, candidateRef: { id: 5, sequence: 1 } };
  const draft = InvoiceFormDraftSchema.parse({ fields: Object.fromEntries(invoiceHeaderFields.map(name => [name, name === 'totalAmount' ? '123.00' : ''])), lines: [], notes: [] });
  const request = { operationRef: 'original-edit', jobId: 4, expectedCandidateId: 5, basedOnCandidateId: 5,
    expectedRevision: 6, draft, lineOrigins: [] };
  const saved = { version: 1 as const, target, candidateId: 5, sequence: 1, workspaceRevision: 6, draft, lineOrigins: [],
    baseline: draft, baselineLineOrigins: [], pending: { type: 'cloud_review_save' as const, input: { workId: 1, itemId: 2,
      documentRef: target.documentRef, request } } };
  expect(saveCloudReviewDraft(storage, workspaceId, saved)).toBe(true);
  expect(readCloudReviewDraft(storage, workspaceId)).toEqual({ ok: true, data: saved });
  expect(readCloudReviewDraft(storage, other)).toEqual({ ok: true, data: null });
  expect(saveCloudReviewDraft(storage, workspaceId, { ...saved, pending: { ...saved.pending,
    input: { ...saved.pending.input, itemId: 99 } } })).toBe(false);
  expect(readCloudReviewDraft(storage, workspaceId)).toEqual({ ok: true, data: saved });
});
