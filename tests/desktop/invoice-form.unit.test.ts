import { describe, expect, it } from 'bun:test';
import type { StoredCandidateDraft, StoredInvoiceField } from '@flowmate/contracts';
import { applyInvoiceForm, bindInvoiceFormRun, cancelInvoiceFormRun, createInvoiceFormState, discardInvoiceForm,
  editInvoiceForm, invalidateInvoiceForm, mapInvoiceCandidate, queryInvoiceFormApplication,
  type InvoiceFormApplyRequest } from '../../apps/desktop/renderer/src/invoice-form.ts';

function field(value: string | null = null): StoredInvoiceField {
  return { raw: value, normalized: value, state: value === null ? 'missing' : 'present', alternatives: [], sources: [] };
}

function candidate(): StoredCandidateDraft {
  return { fields: {
    invoiceNumber: field('INV-1'), issueDate: field('2026-10-01'), sellerName: field('Seller'), sellerTaxId: field('S1'),
    buyerName: field('Buyer'), buyerTaxId: field('B1'), currency: field('CNY'), netAmount: field('9007199254740993.000001'),
    taxAmount: field('0'), totalAmount: field('9007199254740993.000001'),
  }, lines: [{ description: field('Item'), quantity: field('0'), unit: field('件'), unitPrice: field('1.000001'),
    netAmount: field('0'), taxRate: field('0.13'), taxAmount: field('0'), totalAmount: field('0') }], notes: ['Check source'] };
}

describe('fixed invoice form mapping', () => {
  it('maps the ten header and eight line fields without a numeric round trip', () => {
    const result = mapInvoiceCandidate(candidate())!;
    expect(Object.keys(result.draft.fields)).toHaveLength(10);
    expect(Object.keys(result.draft.lines[0]!)).toHaveLength(8);
    expect(result.draft.fields.netAmount).toBe('9007199254740993.000001');
    expect(result.draft.fields.taxAmount).toBe('0');
    expect(result.draft.lines[0]!.quantity).toBe('0');
    expect(result.draft.notes).toEqual(['Check source']);
    expect(result.warnings).toEqual([]);
  });

  it('leaves missing and not-applicable fields empty instead of inventing zero', () => {
    const source = candidate();
    source.fields.taxAmount = { ...field('0'), state: 'missing' };
    source.fields.buyerTaxId = { ...field('unexpected'), state: 'not_applicable' };
    const result = mapInvoiceCandidate(source)!;
    expect(result.draft.fields.taxAmount).toBe('');
    expect(result.draft.fields.buyerTaxId).toBe('');
  });

  it('uses raw with a warning for invalid normalized date and decimal text', () => {
    const source = candidate();
    source.fields.issueDate = { ...field('2026/02/28'), normalized: '2026-02-30' };
    source.fields.totalAmount = { ...field('1,000.00'), normalized: '1e3' };
    const result = mapInvoiceCandidate(source)!;
    expect(result.draft.fields.issueDate).toBe('2026/02/28');
    expect(result.draft.fields.totalAmount).toBe('1,000.00');
    expect(result.warnings).toEqual([
      { path: '/fields/issueDate', reason: 'raw_fallback' },
      { path: '/fields/totalAmount', reason: 'raw_fallback' },
    ]);
  });

  it('does not select an ambiguous normalized value or alternative', () => {
    const source = candidate();
    source.fields.issueDate = { ...field('01/02/2026'), normalized: '2026-01-02', state: 'ambiguous',
      alternatives: ['2026-01-02', '2026-02-01'] };
    const result = mapInvoiceCandidate(source)!;
    expect(result.draft.fields.issueDate).toBe('01/02/2026');
    expect(result.warnings).toContainEqual({ path: '/fields/issueDate', reason: 'ambiguous' });
  });

  it('rejects malformed or oversized candidates before producing any form values', () => {
    const source = candidate();
    expect(mapInvoiceCandidate({ ...source, lines: Array.from({ length: 201 }, () => source.lines[0]) })).toBeNull();
    expect(mapInvoiceCandidate({ ...source, fields: { ...source.fields, inventedField: field('extra') } })).toBeNull();
  });

  it('copies values and notes without retaining mutable candidate references', () => {
    const source = candidate();
    const result = mapInvoiceCandidate(source)!;
    source.notes[0] = 'Changed later';
    source.lines[0]!.description.normalized = 'Changed later';
    expect(result.draft.notes).toEqual(['Check source']);
    expect(result.draft.lines[0]!.description).toBe('Item');
  });
});

const basis = { sessionId: 12, documentRef: { id: 4, version: 'doc-v1' }, jobId: 7, candidateId: 9, candidateSequence: 1 };

function form() {
  return createInvoiceFormState({ formInstanceId: 'form-1', basis, candidate: candidate(), editable: true })!;
}

describe('invoice form local draft and instance', () => {
  it('permits a local manual Edit without a Session but never binds it to a model Run', () => {
    const manual = createInvoiceFormState({ formInstanceId: 'manual-1', basis: { ...basis, sessionId: null },
      candidate: candidate(), editable: true });
    expect(manual).not.toBeNull();
    expect(manual!.draft.fields.taxAmount).toBe('0');
    expect(editInvoiceForm(manual!, { ...manual!.draft, notes: ['Manual edit'] })?.dirty).toBe(true);
    expect(bindInvoiceFormRun(manual!, 101)).toBeNull();
  });
  it('creates an isolated Edit baseline, while an unfilled target starts empty', () => {
    const source = candidate();
    const state = createInvoiceFormState({ formInstanceId: 'form-1', basis, candidate: source, editable: true })!;
    source.notes[0] = 'outside mutation';
    expect(state.draft.notes).toEqual(['Check source']);
    expect(state.dirty).toBe(false);
    expect(state.revision).toBe(0);
    expect(state.baseline).toEqual(state.draft);
    const empty = createInvoiceFormState({ formInstanceId: 'form-2', basis, candidate: null, editable: true })!;
    expect(empty.draft.fields.taxAmount).toBe('');
    expect(empty.draft.lines).toEqual([]);
    expect(empty.dirty).toBe(false);
  });

  it('increments revision only for actual manual differences and clears dirty on a real revert', () => {
    const original = form();
    expect(editInvoiceForm(original, structuredClone(original.draft))).toBe(original);
    const changedDraft = structuredClone(original.draft);
    changedDraft.fields.taxAmount = '';
    changedDraft.lines.push({ ...changedDraft.lines[0]!, description: 'Added line' });
    changedDraft.notes = [];
    const changed = editInvoiceForm(original, changedDraft)!;
    changedDraft.fields.taxAmount = 'outside mutation';
    expect(changed.dirty).toBe(true);
    expect(changed.revision).toBe(1);
    expect(changed.draft.fields.taxAmount).toBe('');
    expect(original.draft.fields.taxAmount).toBe('0');
    const reverted = editInvoiceForm(changed, original.baseline)!;
    expect(reverted.dirty).toBe(false);
    expect(reverted.revision).toBe(2);
  });

  it('does not treat object property order as a manual change', () => {
    const original = form();
    const reordered = { fields: Object.fromEntries(Object.entries(original.draft.fields).reverse()),
      lines: original.draft.lines.map(line => Object.fromEntries(Object.entries(line).reverse())), notes: [...original.draft.notes] };
    expect(editInvoiceForm(original, reordered)).toBe(original);
  });

  it('requires every fixed header and line field even when its value is empty', () => {
    const original = form();
    const { taxAmount: ignoredHeader, ...incompleteHeader } = original.draft.fields;
    const { quantity: ignoredLine, ...incompleteLine } = original.draft.lines[0]!;
    expect(editInvoiceForm(original, { ...original.draft, fields: incompleteHeader })).toBeNull();
    expect(editInvoiceForm(original, { ...original.draft, lines: [incompleteLine] })).toBeNull();
  });

  it('rejects structurally invalid edits, excessive lines and read-only targets without clearing a draft', () => {
    const original = form();
    expect(editInvoiceForm(original, { ...original.draft, fields: { ...original.draft.fields, invented: 'x' } })).toBeNull();
    expect(editInvoiceForm(original, { ...original.draft, lines: Array.from({ length: 201 }, () => original.draft.lines[0]) })).toBeNull();
    const readOnly = createInvoiceFormState({ formInstanceId: 'readonly', basis, candidate: candidate(), editable: false })!;
    expect(editInvoiceForm(readOnly, original.draft)).toBeNull();
    expect(bindInvoiceFormRun(readOnly, 101)).toBeNull();
    expect(original.draft.notes).toEqual(['Check source']);
  });

  it('invalidates a target without erasing content and discards into a distinct fresh instance', () => {
    const original = form();
    const changed = editInvoiceForm(original, { ...original.draft, notes: ['Manual note'] })!;
    const invalid = invalidateInvoiceForm(changed);
    expect(invalid.valid).toBe(false);
    expect(invalid.draft.notes).toEqual(['Manual note']);
    expect(editInvoiceForm(invalid, original.draft)).toBeNull();
    expect(bindInvoiceFormRun(invalid, 101)).toBeNull();
    expect(discardInvoiceForm(changed, 'form-1')).toBeNull();
    const reset = discardInvoiceForm(changed, 'form-2')!;
    expect(reset.formInstanceId).toBe('form-2');
    expect(reset.revision).toBe(0);
    expect(reset.dirty).toBe(false);
    expect(reset.draft).toEqual(original.baseline);
    expect(changed.draft.notes).toEqual(['Manual note']);
  });

  it('binds one actual Run and retains cancellation as a separate observation', () => {
    const original = form();
    const bound = bindInvoiceFormRun(original, 101)!;
    expect(bound.runId).toBe(101);
    expect(bindInvoiceFormRun(bound, 102)).toBeNull();
    const cancelled = cancelInvoiceFormRun(bound);
    expect(cancelled.cancelled).toBe(true);
    expect(cancelled.valid).toBe(true);
    expect(cancelled.draft).toEqual(bound.draft);
  });
});

const observedAt = '2026-10-01T00:00:00.000Z';
function request(): InvoiceFormApplyRequest {
  return { ...basis, runId: 101, toolCallId: 21, nativeToolCallId: 'native-call-1',
    target: { formInstanceId: 'form-1', expectedRevision: 0 }, candidate: candidate() };
}

function emptyBoundForm() {
  const empty = createInvoiceFormState({ formInstanceId: 'form-1', basis, candidate: null, editable: true })!;
  return bindInvoiceFormRun(empty, 101)!;
}

describe('invoice form application and original-call query', () => {
  it('atomically fills the whole draft, establishes its baseline and advances revision once', () => {
    const original = emptyBoundForm();
    const result = applyInvoiceForm(original, request(), observedAt);
    expect(result.receipt).toEqual({ runId: 101, toolCallId: 21, formInstanceId: 'form-1', candidateId: 9,
      candidateSequence: 1, observedAt, outcome: 'applied', appliedRevision: 1, appliedAt: observedAt });
    expect(result.state.draft).toEqual(mapInvoiceCandidate(candidate())!.draft);
    expect(result.state.baseline).toEqual(result.state.draft);
    expect(result.state.dirty).toBe(false);
    expect(result.state.revision).toBe(1);
    expect(original.draft.fields.invoiceNumber).toBe('');
    expect(original.receipts.size).toBe(0);
  });

  it('rejects invalid whole-candidate mapping without partially changing any controls', () => {
    const original = emptyBoundForm();
    const source = candidate();
    const result = applyInvoiceForm(original, { ...request(), candidate: { ...source,
      lines: Array.from({ length: 201 }, () => source.lines[0]) } }, observedAt);
    expect(result.receipt?.outcome).toBe('not_applied');
    expect(result.state.draft).toEqual(original.draft);
    expect(result.state.revision).toBe(0);
    expect(result.state.dirty).toBe(false);
  });

  it('checks every current instance, Run and material identity before applying', () => {
    const original = emptyBoundForm();
    const mismatches: Partial<InvoiceFormApplyRequest>[] = [
      { runId: 102 }, { sessionId: 13 }, { documentRef: { id: 5, version: 'doc-v1' } },
      { documentRef: { id: 4, version: 'doc-v2' } }, { jobId: 8 }, { candidateId: 10 },
      { candidateSequence: 2 }, { target: { formInstanceId: 'other-form', expectedRevision: 0 } },
      { target: { formInstanceId: 'form-1', expectedRevision: 1 } },
    ];
    for (const mismatch of mismatches) {
      const result = applyInvoiceForm(original, { ...request(), ...mismatch }, observedAt);
      expect(result.receipt?.outcome).toBe('not_applied');
      expect(result.state.draft).toEqual(original.draft);
      expect(result.state.revision).toBe(0);
    }
  });

  it('preserves content on dirty, cancelled, invalid or read-only targets', () => {
    const original = emptyBoundForm();
    const dirty = editInvoiceForm(original, { ...original.draft, notes: ['Human work'] })!;
    for (const blocked of [dirty, cancelInvoiceFormRun(original), invalidateInvoiceForm(original),
      { ...original, editable: false }, { ...original, runId: null }]) {
      const result = applyInvoiceForm(blocked, request(), observedAt);
      expect(result.receipt?.outcome).toBe('not_applied');
      expect(result.state.draft).toEqual(blocked.draft);
      expect(result.state.revision).toBe(blocked.revision);
    }
  });

  it('returns a duplicate original receipt after edits or invalidation without writing the draft again', () => {
    const first = applyInvoiceForm(emptyBoundForm(), request(), observedAt);
    const edited = editInvoiceForm(first.state, { ...first.state.draft, notes: ['Later human work'] })!;
    const closed = invalidateInvoiceForm(cancelInvoiceFormRun(edited));
    const repeated = applyInvoiceForm(closed, request(), '2026-10-01T00:00:01.000Z');
    expect(repeated.state).toBe(closed);
    expect(repeated.receipt).toEqual(first.receipt);
    expect(repeated.state.draft.notes).toEqual(['Later human work']);
    expect(repeated.state.revision).toBe(2);
  });

  it('keeps the original receipt on conflicting content or native-call identity', () => {
    const first = applyInvoiceForm(emptyBoundForm(), request(), observedAt);
    const changed = candidate();
    changed.notes = ['Different payload'];
    for (const conflicting of [{ ...request(), candidate: changed }, { ...request(), nativeToolCallId: 'other-native-call' }]) {
      const result = applyInvoiceForm(first.state, conflicting, observedAt);
      expect(result.receipt).toMatchObject({ outcome: 'not_applied', reason: 'call_conflict' });
      expect(result.state).toBe(first.state);
    }
    expect(queryInvoiceFormApplication(first.state, request(), observedAt)).toEqual(first.receipt);
  });

  it('rejects the next ToolCall with the old expected revision instead of rebinding its target', () => {
    const first = applyInvoiceForm(emptyBoundForm(), request(), observedAt);
    const second = applyInvoiceForm(first.state, { ...request(), toolCallId: 22, nativeToolCallId: 'native-call-2' }, observedAt);
    expect(second.receipt).toMatchObject({ outcome: 'not_applied', reason: 'revision_conflict' });
    expect(second.state.draft).toEqual(first.state.draft);
    expect(second.state.revision).toBe(1);
    const retargeted = applyInvoiceForm(first.state, { ...request(), toolCallId: 23, nativeToolCallId: 'native-call-3',
      target: { formInstanceId: 'form-1', expectedRevision: 1 } }, observedAt);
    expect(retargeted.receipt).toMatchObject({ outcome: 'not_applied', reason: 'revision_conflict' });
    expect(retargeted.state.revision).toBe(1);
  });

  it('queries only matching original-call evidence and returns unknown when none exists', () => {
    const original = emptyBoundForm();
    expect(queryInvoiceFormApplication(original, request(), observedAt)?.outcome).toBe('unknown');
    expect(original.receipts.size).toBe(0);
    const first = applyInvoiceForm(original, request(), observedAt);
    expect(queryInvoiceFormApplication(first.state, request(), '2026-10-01T00:00:01.000Z')).toEqual(first.receipt);
    expect(queryInvoiceFormApplication(first.state, { ...request(), nativeToolCallId: 'wrong-call' }, observedAt)?.outcome).toBe('unknown');
    expect(first.state.receipts.size).toBe(1);
    expect(first.state.revision).toBe(1);
  });

  it('keeps an explicit rejection queryable and does not turn a retried original call into a new apply', () => {
    const original = cancelInvoiceFormRun(emptyBoundForm());
    const rejected = applyInvoiceForm(original, request(), observedAt);
    expect(rejected.receipt).toMatchObject({ outcome: 'not_applied', reason: 'cancelled' });
    expect(queryInvoiceFormApplication(rejected.state, request(), observedAt)).toEqual(rejected.receipt);
    const retry = applyInvoiceForm({ ...rejected.state, cancelled: false }, request(), observedAt);
    expect(retry.receipt).toEqual(rejected.receipt);
    expect(retry.state.revision).toBe(0);
    expect(retry.state.draft.fields.invoiceNumber).toBe('');
  });

  it('bounds evidence to 24 calls, refuses a new apply when full and never evicts old receipts', () => {
    let state = cancelInvoiceFormRun(emptyBoundForm());
    for (let i = 0; i < 24; i++) state = applyInvoiceForm(state,
      { ...request(), toolCallId: 21 + i, nativeToolCallId: `native-call-${i + 1}` }, observedAt).state;
    expect(state.receipts.size).toBe(24);
    const first = queryInvoiceFormApplication(state, request(), observedAt);
    const overflow = applyInvoiceForm({ ...state, cancelled: false }, { ...request(), toolCallId: 45,
      nativeToolCallId: 'native-call-25' }, observedAt);
    expect(overflow.receipt).toMatchObject({ outcome: 'not_applied', reason: 'receipt_capacity' });
    expect(overflow.state.receipts.size).toBe(24);
    expect(overflow.state.draft).toEqual(state.draft);
    expect(queryInvoiceFormApplication(overflow.state, request(), observedAt)).toEqual(first);
  });

  it('discards into a new target without copying or erasing the old application evidence', () => {
    const applied = applyInvoiceForm(emptyBoundForm(), request(), observedAt);
    const edited = editInvoiceForm(applied.state, { ...applied.state.draft, notes: ['Unsaved note'] })!;
    const fresh = discardInvoiceForm(edited, 'form-2')!;
    expect(fresh.receipts.size).toBe(0);
    expect(fresh.draft).toEqual(applied.state.baseline);
    expect(queryInvoiceFormApplication(fresh, request(), observedAt)?.outcome).toBe('unknown');
    expect(queryInvoiceFormApplication(edited, request(), observedAt)).toEqual(applied.receipt);
    expect(edited.draft.notes).toEqual(['Unsaved note']);
  });
});
