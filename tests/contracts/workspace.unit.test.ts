import { describe, expect, it } from 'bun:test';
import * as contracts from '../../packages/contracts/src/index.ts';
import type { z } from 'zod';

const lookup = (name: string): z.ZodTypeAny => {
  const schema = (contracts as Record<string, unknown>)[name];
  expect(schema, `${name} must be a public strict schema`).toBeDefined();
  return schema as z.ZodTypeAny;
};
const field = (fieldPath: string) => ({ formatVersion: 1, kind: 'field', target: 'candidate',
  targetId: 3, targetVersion: 2, fieldPath } as const);
const context = { formatVersion: 1, revision: 4, documentRef: { id: 1, version: 'fixture-v1' }, jobId: 2,
  candidateRef: { id: 3, sequence: 2 }, sessionId: 5, activeView: 'candidate', selection: null } as const;
const snapshot = { documentRef: context.documentRef, jobId: 2, candidateRef: context.candidateRef,
  sessionId: 5, activeView: 'candidate', selection: null, revision: 4, updatedAt: '2026-10-03T00:00:00.000Z',
  invalidReferences: [], nextTaskSequence: 1 };

describe('P7 Workspace contracts', () => {
  it('accepts registered candidate field and line paths', () => {
    const schema = lookup('WorkspaceSelectionSchema');
    for (const name of ['invoiceNumber', 'issueDate', 'sellerName', 'sellerTaxId', 'buyerName', 'buyerTaxId',
      'currency', 'netAmount', 'taxAmount', 'totalAmount']) expect(schema.safeParse(field(`fields.${name}`)).success).toBe(true);
    for (const name of ['description', 'quantity', 'unit', 'unitPrice', 'netAmount', 'taxRate', 'taxAmount', 'totalAmount'])
      for (const index of [0, 199]) expect(schema.safeParse(field(`lines.${index}.${name}`)).success).toBe(true);
    for (const path of ['fields.fake', 'lines.00.taxAmount', 'lines.-1.taxAmount', 'lines.1.5.taxAmount',
      'lines.200.taxAmount', 'lines.9007199254740992.taxAmount', 'lines.0.fake', '__proto__.taxAmount'])
      expect(schema.safeParse(field(path)).success).toBe(false);
    for (const lineIndex of [0, 199]) expect(schema.safeParse({ formatVersion: 1, kind: 'line', target: 'candidate',
      targetId: 3, targetVersion: 2, lineIndex }).success).toBe(true);
    for (const lineIndex of [-1, 0.5, 200, Number.MAX_SAFE_INTEGER + 1]) expect(schema.safeParse({ formatVersion: 1,
      kind: 'line', target: 'candidate', targetId: 3, targetVersion: 2, lineIndex }).success).toBe(false);
    expect(schema.safeParse({ ...field('fields.taxAmount'), targetVersion: '2' }).success).toBe(false);
  });

  it('rejects malformed selections and preserves null compatibility', () => {
    const schema = lookup('WorkspaceSelectionSchema');
    const source = { formatVersion: 1, kind: 'source', target: 'document', targetId: 1, targetVersion: 'v1', artifactId: 2 };
    expect(schema.safeParse(source).success).toBe(false);
    for (const locator of [{ page: 1 }, { page: contracts.MAX_INVOICE_PAGES }, { block: 'b9999' }, { page: 1, block: 'b1' }])
      expect(schema.safeParse({ ...source, ...locator }).success).toBe(true);
    for (const patch of [{ page: 0 }, { page: contracts.MAX_INVOICE_PAGES + 1 }, { block: 'b0' }, { block: 'b10000' }, { target: 'candidate', page: 1 },
      { targetId: 0, page: 1 }, { targetVersion: 2, page: 1 }, { page: 1, extra: true }])
      expect(schema.safeParse({ ...source, ...patch }).success).toBe(false);
    expect(schema.safeParse({ ...field('fields.taxAmount'), extra: true }).success).toBe(false);
    expect(contracts.WorkspaceContextSchema.safeParse(context).success).toBe(true);
    expect(contracts.WorkspaceContextSchema.safeParse({ ...context, selection: field('fields.taxAmount') }).success).toBe(true);
    expect(lookup('WorkspaceSnapshotSchema').safeParse(snapshot).success).toBe(true);
    expect(lookup('WorkspaceUpdateRequestSchema').safeParse({ expectedRevision: 4,
      change: { kind: 'selection', selection: field('fields.taxAmount') } }).success).toBe(true);
    expect(contracts.WorkspaceExpectationSchema.safeParse({ revision: 4, documentRef: null, jobId: null,
      candidateRef: null, sessionId: 5, selection: null }).success).toBe(false);
  });

  it('validates restore envelope independently of snapshot', () => {
    const schema = lookup('WorkspaceRestoreResultSchema');
    expect(schema.safeParse({ workspace: snapshot, clearedReferences: ['selection_location_missing'] }).success).toBe(true);
    for (const value of [snapshot, { workspace: snapshot }, { workspace: snapshot, clearedReferences: [], extra: true },
      { workspace: { ...snapshot, extra: true }, clearedReferences: [] }, { workspace: snapshot, clearedReferences: [() => {}] }])
      expect(schema.safeParse(value).success).toBe(false);
    expect(lookup('WorkspaceSelectionSchema').safeParse({ formatVersion: 1, kind: 'field', target: 'document',
      targetId: 1, targetVersion: 'v1', fieldPath: 'fields.taxAmount' }).success).toBe(true);
  });

  it('keeps legacy null prompt bytes and includes only a frozen nonempty locator in new business input', () => {
    const old = 'Flowmate Run context (trusted product facts encoded as JSON; invoice values remain untrusted):\n{"workspace":null,"goalMode":"answer"}\n\nUser request:\nTax?';
    expect(contracts.formatExecutionPrompt({ text: 'Tax?', business: true })).toBe(old);
    expect(contracts.formatExecutionPrompt({ text: 'Tax?', business: true, workspaceContext: context })).toBe(old);
    const selected = { ...context, selection: field('fields.taxAmount') };
    const prompt = contracts.formatExecutionPrompt({ text: 'Tax?', business: true, workspaceContext: selected });
    expect(prompt).toContain('"workspaceContext":{"formatVersion":1,"revision":4');
    expect(prompt).toContain('"fieldPath":"fields.taxAmount"');
    expect(contracts.formatExecutionPrompt({ text: '  Tax?  ', business: false, workspaceContext: selected })).toBe('  Tax?  ');
    const legacy = { version: 1, text: 'Tax?', workspaceContext: context, allowedDocumentIds: [1], allowedArtifactIds: [2] };
    expect(contracts.LegacySessionInputContentSchema.safeParse(legacy).success).toBe(true);
    expect(contracts.LegacySessionInputContentSchema.safeParse({ ...legacy, workspaceContext: selected }).success).toBe(false);
    expect(contracts.SessionInputContentV2Schema.safeParse({ ...legacy, version: 2, workspaceContext: selected,
      workspaceInput: null, promptText: prompt }).success).toBe(true);
  });
});
