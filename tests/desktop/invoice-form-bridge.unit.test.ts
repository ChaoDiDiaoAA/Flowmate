import { describe, expect, it } from 'bun:test';
import type { AgentRunSnapshot, InvoiceFormBridgeRequest } from '@flowmate/contracts';
import { checkedInvoiceFormInspection, matchesInvoiceFormRun, matchesInvoiceFormTarget, type InvoiceFormTargetBinding } from '../../apps/desktop/main/invoice-form-bridge.ts';
import { InvoiceFormDraftSchema, invoiceHeaderFields } from '@flowmate/contracts';

const owner = { frame: {}, contents: {}, epoch: 1 };
const workspace = { revision: 2, documentRef: { id: 4, version: 'v1' }, jobId: 7, candidateRef: { id: 9, sequence: 1 }, sessionId: 12 };
function binding(): InvoiceFormTargetBinding {
  return { ...owner, workspace, purpose: 'fill', target: { formInstanceId: 'form-1', expectedRevision: 0 }, valid: true, dirty: false,
    runId: null, pendingFill: true };
}
function request(): InvoiceFormBridgeRequest {
  return { operation: 'query', sessionId: 12, runId: 101, toolCallId: 21, nativeToolCallId: 'native-call-1',
    documentRef: workspace.documentRef, jobId: workspace.jobId, candidateId: 9, candidateSequence: 1,
    target: { formInstanceId: 'form-1', expectedRevision: 0 } };
}
function run(): AgentRunSnapshot {
  return { runId: 101, currentContextSnapshotId: null, kind: 'agent', jobId: 7, sessionId: 12, status: 'running', cancelRequestedAt: null,
    config: { goalMode: 'fill-form', formTarget: binding().target,
      workspaceContext: { ...workspace, formatVersion: 1, activeView: 'candidate', selection: null } },
    scope: { version: 2, allowedTools: ['fill_invoice_form'], allowedDocumentIds: [4], allowedArtifactIds: [], allowedResourcePaths: [] },
    input: { version: 1, goal: 'Fill current form', text: 'Fill', messageTimestamp: 1790812800000 },
    output: null, usage: { version: 1, source: 'unknown', reason: null, sdkValues: null, attempts: null,
      attemptsComplete: false, costSource: null, updatedAt: '2026-10-01T00:00:00.000Z' },
    tokens: { inputTokens: null, outputTokens: null, totalTokens: null, cost: null, usageComplete: false },
    durationMs: null, toolCallCount: 1, error: null, cleanup: {}, createdAt: '2026-10-01T00:00:00.000Z',
    startedAt: '2026-10-01T00:00:00.000Z', endedAt: null, stoppedAt: null,
  };
}

describe('trusted invoice form target binding', () => {
  it('accepts only a complete current owner-bound manual inspection and refuses stale revision or extra fields', () => {
    const form = { ...binding(), currentRevision: 3, dirty: true };
    const inspection = { formInstanceId: 'form-1', revision: 3, dirty: true, valid: true,
      basis: { sessionId: 12, documentRef: workspace.documentRef, jobId: 7, candidateId: 9, candidateSequence: 1 },
      draft: InvoiceFormDraftSchema.parse({ fields: Object.fromEntries(invoiceHeaderFields.map(name => [name, ''])), lines: [], notes: [] }) };
    expect(checkedInvoiceFormInspection(form, inspection, owner)).toEqual(inspection);
    for (const value of [{ ...inspection, revision: 2 }, { ...inspection, dirty: false }, { ...inspection, formInstanceId: 'other' },
      { ...inspection, basis: { ...inspection.basis, candidateId: 10 } }, { ...inspection, valid: false }, { ...inspection, runId: 1 }])
      expect(checkedInvoiceFormInspection(form, value, owner)).toBeNull();
    expect(checkedInvoiceFormInspection(form, inspection, { ...owner, frame: {} })).toBeNull();
    expect(checkedInvoiceFormInspection(form, inspection, { ...owner, epoch: 2 })).toBeNull();
    expect(checkedInvoiceFormInspection(form, { ...inspection, lineOrigins: [] }, owner)).toEqual({ ...inspection, lineOrigins: [] });
    expect(checkedInvoiceFormInspection(form, { ...inspection, lineOrigins: [null] }, owner)).toBeNull();
  });
  it('binds actual owner objects and rejects a new frame, window or Host epoch', () => {
    expect(matchesInvoiceFormTarget(binding(), request(), owner)).toBe(true);
    expect(matchesInvoiceFormTarget(binding(), request(), { ...owner, frame: {} })).toBe(false);
    expect(matchesInvoiceFormTarget(binding(), request(), { ...owner, contents: {} })).toBe(false);
    expect(matchesInvoiceFormTarget(binding(), request(), { ...owner, epoch: 2 })).toBe(false);
    expect(matchesInvoiceFormTarget({ ...binding(), valid: false }, request(), owner)).toBe(false);
    // The original-call cache decides duplicate application facts before checking current dirty.
    expect(matchesInvoiceFormTarget({ ...binding(), dirty: true }, request(), owner)).toBe(true);
    expect(matchesInvoiceFormTarget({ ...binding(), purpose: 'edit' }, request(), owner)).toBe(false);
  });

  it('checks every original material and target reference rather than accepting an instance ID alone', () => {
    for (const change of [{ sessionId: 13 }, { jobId: 8 }, { documentRef: { id: 5, version: 'v1' } },
      { documentRef: { id: 4, version: 'v2' } }, { candidateId: 10 }, { candidateSequence: 2 },
      { target: { formInstanceId: 'form-2', expectedRevision: 0 } }, { target: { formInstanceId: 'form-1', expectedRevision: 1 } }]) {
      expect(matchesInvoiceFormTarget(binding(), { ...request(), ...change }, owner)).toBe(false);
    }
  });

  it('requires an admitted Run with the fixed form target and scope before binding an early tool request', () => {
    expect(matchesInvoiceFormRun(binding(), request(), run())).toBe(true);
    expect(matchesInvoiceFormRun({ ...binding(), pendingFill: false }, request(), run())).toBe(false);
    expect(matchesInvoiceFormRun({ ...binding(), runId: 102 }, request(), run())).toBe(false);
    for (const change of [{ sessionId: 13 }, { jobId: 8 }, { runId: 102 }, { config: { ...run().config, goalMode: 'answer' } },
      { config: { ...run().config, formTarget: { formInstanceId: 'other', expectedRevision: 0 } } },
      { scope: { ...run().scope, allowedTools: ['fill_invoice_form', 'save_invoice_candidate'] } }]) {
      expect(matchesInvoiceFormRun(binding(), request(), { ...run(), ...change } as AgentRunSnapshot)).toBe(false);
    }
  });
});
