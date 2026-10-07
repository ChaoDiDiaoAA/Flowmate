import { z } from 'zod';
import { DocumentRefSchema, InvoiceFormApplicationReceiptSchema, InvoiceFormDraftSchema, InvoiceFormLineOriginsSchema, InvoiceFormTargetSchema,
  StoredCandidateDraftSchema, invoiceFieldDisplayValue, invoiceHeaderFields, invoiceLineFields, isLegalInvoiceNormalizedValue } from '../../../../packages/contracts/src/invoice.ts';
import type { DbId, DocumentRef, InvoiceFormApplicationReceipt, InvoiceFormDraft, InvoiceFormLineOrigins, InvoiceFormTarget, StoredCandidateDraft, StoredInvoiceField } from '@flowmate/contracts';
export { invoiceHeaderFields, invoiceLineFields } from '../../../../packages/contracts/src/invoice.ts';
export type { InvoiceFormDraft } from '@flowmate/contracts';
export type InvoiceFormWarning = { path: string; reason: 'raw_fallback' | 'ambiguous' | 'unreadable' };
export type InvoiceFormMapping = { draft: InvoiceFormDraft; warnings: InvoiceFormWarning[] };

export type InvoiceFormBasis = {
  sessionId: DbId | null; documentRef: DocumentRef; jobId: DbId; candidateId: DbId; candidateSequence: number;
};
export type InvoiceFormCallIdentity = Omit<InvoiceFormBasis, 'sessionId'> & {
  sessionId: DbId; runId: DbId; toolCallId: DbId; nativeToolCallId: string; target: InvoiceFormTarget;
};
export type InvoiceFormApplyRequest = InvoiceFormCallIdentity & { candidate: unknown };
export type InvoiceFormApplyResult = { state: InvoiceFormState; receipt: InvoiceFormApplicationReceipt | null };
type CachedApplication = { identity: string; content: string; receipt: InvoiceFormApplicationReceipt };
export type InvoiceFormState = {
  formInstanceId: string;
  basis: InvoiceFormBasis;
  baseline: InvoiceFormDraft;
  draft: InvoiceFormDraft;
  lineOrigins: InvoiceFormLineOrigins;
  baselineLineOrigins: InvoiceFormLineOrigins;
  warnings: InvoiceFormWarning[];
  revision: number;
  dirty: boolean;
  editable: boolean;
  valid: boolean;
  cancelled: boolean;
  runId: DbId | null;
  runExpectedRevision: number | null;
  receipts: ReadonlyMap<string, CachedApplication>;
};

const dbId = z.number().int().positive().max(Number.MAX_SAFE_INTEGER);
const basisSchema = z.object({ sessionId: dbId.nullable(), documentRef: DocumentRefSchema, jobId: dbId,
  candidateId: dbId, candidateSequence: dbId }).strict();
const callIdentitySchema = basisSchema.extend({ sessionId: dbId, runId: dbId, toolCallId: dbId,
  nativeToolCallId: z.string().min(1).max(256), target: InvoiceFormTargetSchema }).strict();

export function createInvoiceFormState(input: {
  formInstanceId: string; basis: InvoiceFormBasis; candidate: StoredCandidateDraft | null; editable: boolean;
}): InvoiceFormState | null {
  const basis = basisSchema.safeParse(input.basis);
  if (!basis.success || !InvoiceFormTargetSchema.safeParse({ formInstanceId: input.formInstanceId, expectedRevision: 0 }).success) return null;
  const mapped = input.candidate === null ? { draft: {
    fields: Object.fromEntries(invoiceHeaderFields.map(name => [name, ''])) as InvoiceFormDraft['fields'],
    lines: [], notes: [],
  }, warnings: [] } : mapInvoiceCandidate(input.candidate);
  if (!mapped) return null;
  return { formInstanceId: input.formInstanceId, basis: basis.data, baseline: structuredClone(mapped.draft),
    draft: mapped.draft, lineOrigins: mapped.draft.lines.map((_, index) => index), baselineLineOrigins: mapped.draft.lines.map((_, index) => index),
    warnings: mapped.warnings, revision: 0, dirty: false, editable: input.editable,
    valid: true, cancelled: false, runId: null, runExpectedRevision: null, receipts: new Map() };
}

export function bindInvoiceFormRun(state: InvoiceFormState, runId: DbId): InvoiceFormState | null {
  if (state.basis.sessionId === null || !state.valid || !state.editable || state.dirty || state.cancelled || !dbId.safeParse(runId).success
    || state.runId !== null && state.runId !== runId) return null;
  return state.runId === runId ? state : { ...state, runId, runExpectedRevision: state.revision };
}

export function editInvoiceForm(state: InvoiceFormState, draft: unknown, lineOrigins: unknown = state.lineOrigins): InvoiceFormState | null {
  const parsed = InvoiceFormDraftSchema.safeParse(draft);
  const origins = InvoiceFormLineOriginsSchema.safeParse(lineOrigins);
  if (!state.valid || !state.editable || !parsed.success || !origins.success || origins.data.length !== parsed.data.lines.length
    || origins.data.some(origin => origin !== null && origin >= state.baseline.lines.length)) return null;
  if (sameDraft(parsed.data, state.draft) && JSON.stringify(origins.data) === JSON.stringify(state.lineOrigins)) return state;
  if (state.revision === Number.MAX_SAFE_INTEGER) return null;
  return { ...state, draft: parsed.data, lineOrigins: origins.data, revision: state.revision + 1,
    dirty: !sameDraft(parsed.data, state.baseline) || JSON.stringify(origins.data) !== JSON.stringify(state.baselineLineOrigins) };
}

function sameDraft(left: InvoiceFormDraft, right: InvoiceFormDraft): boolean {
  return invoiceHeaderFields.every(name => left.fields[name] === right.fields[name])
    && left.lines.length === right.lines.length && left.lines.every((line, index) =>
      invoiceLineFields.every(name => line[name] === right.lines[index]![name]))
    && left.notes.length === right.notes.length && left.notes.every((note, index) => note === right.notes[index]);
}

export function invalidateInvoiceForm(state: InvoiceFormState): InvoiceFormState {
  return { ...state, valid: false };
}

export function cancelInvoiceFormRun(state: InvoiceFormState): InvoiceFormState {
  return { ...state, cancelled: true };
}

export function discardInvoiceForm(state: InvoiceFormState, newInstanceId: string): InvoiceFormState | null {
  if (newInstanceId === state.formInstanceId
    || !InvoiceFormTargetSchema.safeParse({ formInstanceId: newInstanceId, expectedRevision: 0 }).success) return null;
  return { ...state, formInstanceId: newInstanceId, baseline: structuredClone(state.baseline),
    draft: structuredClone(state.baseline), revision: 0, dirty: false, valid: true, cancelled: false,
    lineOrigins: [...state.baselineLineOrigins], baselineLineOrigins: [...state.baselineLineOrigins],
    runId: null, runExpectedRevision: null, receipts: new Map() };
}

function receiptIdentity(identity: InvoiceFormCallIdentity, observedAt: string) {
  return { runId: identity.runId, toolCallId: identity.toolCallId, formInstanceId: identity.target.formInstanceId,
    candidateId: identity.candidateId, candidateSequence: identity.candidateSequence, observedAt };
}

export function applyInvoiceForm(state: InvoiceFormState, request: InvoiceFormApplyRequest, observedAt: string): InvoiceFormApplyResult {
  const identity = checkedIdentity(request, observedAt);
  if (!identity) return { state, receipt: null };
  const key = `${identity.runId}:${identity.toolCallId}`;
  const identityKey = JSON.stringify(identity);
  const candidate = StoredCandidateDraftSchema.safeParse(request.candidate);
  let content: string;
  try { content = JSON.stringify(candidate.success ? candidate.data : request.candidate) ?? 'invalid'; }
  catch { content = 'invalid'; }
  const prior = state.receipts.get(key);
  const rejected = (reason: string): InvoiceFormApplicationReceipt => ({ ...receiptIdentity(identity, observedAt),
    outcome: 'not_applied', reason });
  if (prior) {
    return { state, receipt: prior.identity === identityKey && prior.content === content
      ? { ...prior.receipt } : rejected('call_conflict') };
  }
  if (state.receipts.size >= 24) return { state, receipt: rejected('receipt_capacity') };

  let reason: string | null = null;
  if (state.formInstanceId !== identity.target.formInstanceId || state.runId !== identity.runId
    || JSON.stringify(state.basis) !== JSON.stringify({ sessionId: identity.sessionId, documentRef: identity.documentRef,
      jobId: identity.jobId, candidateId: identity.candidateId, candidateSequence: identity.candidateSequence })) reason = 'identity_conflict';
  else if (!state.valid) reason = 'target_invalid';
  else if (!state.editable) reason = 'read_only';
  else if (state.cancelled) reason = 'cancelled';
  else if (state.dirty) reason = 'dirty';
  else if (identity.target.expectedRevision !== state.runExpectedRevision
    || identity.target.expectedRevision !== state.revision || state.revision === Number.MAX_SAFE_INTEGER) reason = 'revision_conflict';
  const mapping = reason === null && candidate.success ? mapInvoiceCandidate(candidate.data) : null;
  if (reason === null && !mapping) reason = 'invalid_candidate';
  const receipt: InvoiceFormApplicationReceipt = reason !== null ? rejected(reason) : {
    ...receiptIdentity(identity, observedAt), outcome: 'applied', appliedRevision: state.revision + 1, appliedAt: observedAt,
  };
  const receipts = new Map(state.receipts);
  receipts.set(key, { identity: identityKey, content, receipt: { ...receipt } });
  return { state: mapping && reason === null ? { ...state, draft: mapping.draft, baseline: structuredClone(mapping.draft),
    lineOrigins: mapping.draft.lines.map((_, index) => index), baselineLineOrigins: mapping.draft.lines.map((_, index) => index),
    warnings: mapping.warnings, revision: state.revision + 1, dirty: false, receipts } : { ...state, receipts }, receipt };
}

export function queryInvoiceFormApplication(state: InvoiceFormState, identity: InvoiceFormCallIdentity,
  observedAt: string): InvoiceFormApplicationReceipt | null {
  const checked = checkedIdentity(identity, observedAt);
  if (!checked) return null;
  const prior = state.receipts.get(`${checked.runId}:${checked.toolCallId}`);
  return prior?.identity === JSON.stringify(checked) ? { ...prior.receipt }
    : { ...receiptIdentity(checked, observedAt), outcome: 'unknown' };
}

function checkedIdentity(identity: InvoiceFormCallIdentity, observedAt: string): InvoiceFormCallIdentity | null {
  const checked = callIdentitySchema.safeParse({ sessionId: identity.sessionId, documentRef: identity.documentRef,
    jobId: identity.jobId, candidateId: identity.candidateId, candidateSequence: identity.candidateSequence,
    runId: identity.runId, toolCallId: identity.toolCallId, nativeToolCallId: identity.nativeToolCallId, target: identity.target });
  return checked.success && InvoiceFormApplicationReceiptSchema.safeParse({ ...receiptIdentity(checked.data, observedAt),
    outcome: 'unknown' }).success ? checked.data : null;
}

export function mapInvoiceCandidate(candidate: unknown): InvoiceFormMapping | null {
  const parsed = StoredCandidateDraftSchema.safeParse(candidate);
  if (!parsed.success) return null;
  const warnings: InvoiceFormWarning[] = [];
  const value = (name: string, field: StoredInvoiceField, path: string): string => {
    if (field.state === 'missing' || field.state === 'not_applicable') return '';
    if (field.state === 'present' && field.normalized !== null && isLegalInvoiceNormalizedValue(name, field.normalized)) {
      return invoiceFieldDisplayValue(name, field);
    }
    warnings.push({ path, reason: field.state === 'ambiguous' || field.state === 'unreadable' ? field.state : 'raw_fallback' });
    return invoiceFieldDisplayValue(name, field);
  };
  const source: StoredCandidateDraft = parsed.data;
  return { draft: {
    fields: Object.fromEntries(invoiceHeaderFields.map(name => [name, value(name, source.fields[name], `/fields/${name}`)])) as InvoiceFormDraft['fields'],
    lines: source.lines.map((line, index) => Object.fromEntries(invoiceLineFields.map(name =>
      [name, value(name, line[name], `/lines/${index}/${name}`)])) as InvoiceFormDraft['lines'][number]),
    notes: [...source.notes],
  }, warnings };
}
