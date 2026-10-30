import { describe, expect, it } from 'bun:test';
import type { Result } from '@flowmate/contracts';
import type { InvoiceWorkContextBuildInput } from '../../packages/contracts/src/personal-context.ts';
import { buildInvoiceWorkContext, formatInvoiceWorkContext } from '../../packages/runtime-durable/src/context.ts';

const at = '2026-10-29T00:00:00.000Z';
function need<T>(value: Result<T>): T { if (!value.ok) throw Error(value.error.code); return value.data; }

function fixture(): InvoiceWorkContextBuildInput {
  const documentRef = { id: 11, version: 'v1' }, material = { id: 13, version: 'v2' };
  const candidateRef = { id: 44, sequence: 2 };
  const source = { documentId: 11, version: 'v1', artifactId: 22, page: 1, blockId: 'b1' };
  const input = {
    phase: { phaseId: 61, workId: 7, attemptId: 21, itemId: 71, requestId: 'phase-original', kind: 'prompt',
      basis: { contextSnapshotId: null, inputIds: [101], documentRefs: [documentRef, material], configurationRevision: 3, itemRevision: 2 },
      createdAt: at, nativeConversationId: null, nativeSubmissionId: null, consumedAt: null },
    work: { workId: 7, personalAgentId: 1, sessionId: 70, runtimeKind: 'durable', revision: 5, goal: 'Organize invoices.',
      status: 'open', createdAt: at, updatedAt: at,
      counts: { total: 128, unresolved: 126, accepted: 1, rejected: 0, excluded: 1 },
      execution: { attempt: { attemptId: 21, runId: 31, runtimeLinked: false }, runStatus: 'running', queued: false,
        requiresContinue: false, stopUnconfirmed: false, waitingReason: null, ownedChildRunIds: [] },
      actions: [{ kind: 'supplement', enabled: true, reason: null, itemId: 71, todoId: 81 },
        { kind: 'review', enabled: true, reason: null, itemId: 72, todoId: null }] },
    item: { workId: 7, itemId: 71, revision: 2, documentRef, jobId: 91, candidateRef, disposition: 'unresolved',
      decision: null, disposedAt: null, todoCount: 1, latestInputId: 101, updatedAt: at },
    authorizedInputs: [{ inputId: 101,
      request: { workId: 7, itemId: 71, todoId: 81, requestId: 'supplement-original', expectedRevision: 4,
        text: '  User says the seller tax ID is 123.  ', materials: [material] },
      receipt: { operation: 'supplement', workId: 7, itemId: 71, todoId: 81, inputId: 101,
        requestId: 'supplement-original', revision: 5, receivedAt: at, saved: true,
        execution: { kind: 'pending-boundary', authorizationAccepted: true,
          attempt: { attemptId: 21, runId: 31, runtimeLinked: false }, relation: 'original' } },
      continuedBy: null }], historicalInputReferences: [],
    todos: [{ todoId: 81, workId: 7, itemId: 71, revision: 2, actor: 'user', fieldPath: 'fields.sellerTaxId',
      problem: 'Seller ID is ambiguous.', needed: 'Confirm the seller ID.', satisfiedBy: 'A checked source resolves the discrepancy.',
      applicable: true, action: 'supplement', basis: { origin: 'rule', documentRefs: [documentRef], sourceRefs: [source],
        inputIds: [101], candidateRef } }],
    confirmedBusinessReferences: [{ kind: 'validation', workId: 7, itemId: 71, documentRef, jobId: 91, candidateRef }],
    conflicts: [{ workId: 7, itemId: 71, fieldPath: 'fields.sellerTaxId', origin: 'model',
      problem: 'The user clarification disagrees with the original seller ID.', sourceRefs: [source], inputIds: [101] }],
    modelReports: [], evidenceRefs: [source], allowedTools: ['read_invoice_document', 'read_invoice_evidence'],
    remainingBudget: { modelCalls: 2, toolCalls: 4, toolFeedbackBytes: 4096, timeoutMs: 30000, childSlots: 1 },
  } satisfies Omit<InvoiceWorkContextBuildInput, 'current'>;
  return { ...input, current: { work: input.work, item: input.item, configurationRevision: 3, documentRefs: [documentRef, material] } };
}

describe('bounded Durable invoice working context', () => {
  it('projects one frozen ticket and aggregate counts, with descriptive actions and explicit provenance', () => {
    const input = fixture(), before = structuredClone(input);
    const context = need(buildInvoiceWorkContext(input));
    expect(context.work).toEqual({ workId: 7, personalAgentId: 1, sessionId: 70, goal: input.work.goal,
      status: 'open', counts: input.work.counts });
    expect(context.item).toEqual(input.item);
    expect(context.phase).toEqual({ phaseId: 61, attemptId: 21, requestId: 'phase-original', basis: input.phase.basis });
    expect(context.userInputs[0]).toEqual({ provenance: 'user-provided', inputId: 101, requestId: 'supplement-original',
      todoId: 81, text: input.authorizedInputs[0]!.request.text, documentRefs: input.authorizedInputs[0]!.request.materials });
    expect(context.confirmedBusinessReferences[0]).toMatchObject({ provenance: 'business-record-reference', kind: 'validation' });
    expect(context.actions).toEqual({ authorizesExecution: false, tools: input.allowedTools,
      available: [input.work.actions[0]], remainingBudget: input.remainingBudget });
    expect(input).toEqual(before);
    const text = need(formatInvoiceWorkContext(context));
    expect(JSON.parse(text)).toEqual(context);
    expect(text).not.toContain('"itemId":72');
    expect(text).not.toContain('nativeConversationId');
    expect(context.evidenceRefs).toEqual(input.evidenceRefs);
  });

  it('rejects foreign work, item, phase, Todo, business record and original source ownership', () => {
    const input = fixture();
    for (const invalid of [
      { ...input, phase: { ...input.phase, workId: 8 } },
      { ...input, phase: { ...input.phase, itemId: 72 } },
      { ...input, phase: { ...input.phase, attemptId: 22 } },
      { ...input, item: { ...input.item, workId: 8 } },
      { ...input, todos: [{ ...input.todos[0]!, itemId: 72 }] },
      { ...input, confirmedBusinessReferences: [{ ...input.confirmedBusinessReferences[0]!, workId: 8 }] },
      { ...input, evidenceRefs: [{ ...input.evidenceRefs[0]!, documentId: 12 }] },
    ]) expect(buildInvoiceWorkContext(invalid).ok).toBe(false);
  });

  it('rejects stale ticket, configuration, document, candidate and Todo bases while allowing unrelated work progress', () => {
    const input = fixture();
    for (const invalid of [
      { ...input, item: { ...input.item, revision: 3 } },
      { ...input, current: { ...input.current, item: { ...input.current.item, revision: 3 } } },
      { ...input, current: { ...input.current, configurationRevision: 4 } },
      { ...input, current: { ...input.current, documentRefs: [{ id: 11, version: 'v2' }, { id: 13, version: 'v2' }] } },
      { ...input, phase: { ...input.phase, basis: { ...input.phase.basis, documentRefs: [{ id: 11, version: 'v2' }] } } },
      { ...input, confirmedBusinessReferences: [{ ...input.confirmedBusinessReferences[0]!, candidateRef: { id: 44, sequence: 1 } }] },
      { ...input, todos: [{ ...input.todos[0]!, basis: { ...input.todos[0]!.basis, documentRefs: [{ id: 11, version: 'v0' }] } }] },
    ]) expect(buildInvoiceWorkContext(invalid).ok).toBe(false);
    const original = need(formatInvoiceWorkContext(need(buildInvoiceWorkContext(input))));
    const later = { ...input, current: { ...input.current, work: { ...input.work, revision: 99,
      counts: { total: 128, unresolved: 100, accepted: 27, rejected: 0, excluded: 1 } } } };
    expect(need(formatInvoiceWorkContext(need(buildInvoiceWorkContext(later))))).toBe(original);
  });

  it('uses exactly frozen authorized inputs and retains immutable original request identity', () => {
    const input = fixture(), original = input.authorizedInputs[0]!;
    for (const invalid of [
      { ...input, authorizedInputs: [] },
      { ...input, authorizedInputs: [original, { ...original, inputId: 102 }] },
      { ...input, authorizedInputs: [{ ...original, request: { ...original.request, requestId: 'another-request' } }] },
      { ...input, authorizedInputs: [{ ...original, request: { ...original.request, itemId: 72 } }] },
      { ...input, authorizedInputs: [{ ...original, receipt: { ...original.receipt, inputId: 102 } }] },
      { ...input, authorizedInputs: [{ ...original, receipt: { ...original.receipt,
        execution: { kind: 'existing', authorizationAccepted: false, attempt: original.receipt.execution.attempt!, relation: 'original' } } }] },
    ]) expect(buildInvoiceWorkContext(invalid).ok).toBe(false);
    expect(need(buildInvoiceWorkContext(input)).userInputs[0]!.text).toBe(original.request.text);
  });

  it('allows saved-only material only after an actual accepted continue for the same attempt', () => {
    const input = fixture(), original = input.authorizedInputs[0]!;
    const saved = { ...original, receipt: { ...original.receipt,
      execution: { kind: 'waiting', authorizationAccepted: false, attempt: null, reason: 'Explicit continue required.', todoIds: [81] } } } as const;
    expect(buildInvoiceWorkContext({ ...input, authorizedInputs: [saved] }).ok).toBe(false);
    const continuedBy = { operation: 'continueWork', workId: 7, requestId: 'continue-original', revision: 6, receivedAt: at,
      execution: { kind: 'accepted', authorizationAccepted: true, attempt: { attemptId: 21, runId: null, runtimeLinked: false }, relation: 'new' } } as const;
    expect(buildInvoiceWorkContext({ ...input, work: { ...input.work, revision: 6 }, authorizedInputs: [{ ...saved, continuedBy }] }).ok).toBe(true);
    for (const invalid of [
      { ...continuedBy, workId: 8 },
      { ...continuedBy, execution: { ...continuedBy.execution, attempt: { ...continuedBy.execution.attempt, attemptId: 22 } } },
      { ...continuedBy, execution: { kind: 'existing', authorizationAccepted: false,
        attempt: continuedBy.execution.attempt, relation: 'original' } },
    ]) expect(buildInvoiceWorkContext({ ...input, authorizedInputs: [{ ...saved, continuedBy: invalid }] }).ok).toBe(false);
  });

  it('retains conflicting source locators and labels child reports as model self reports', () => {
    const input = fixture();
    const report = { child: { runtimeKind: 'durable', kind: 'subagent', workId: 7, itemId: 71, parentAttemptId: 21,
      childRunId: 32, originToolCallId: 33, role: 'invoice-evidence-checker', runStatus: 'completed', resultRecorded: true,
      stopConfirmed: true, stoppedAt: at, delivery: { version: 1, state: 'unknown', messageObservedAt: null,
        includedInCallSequence: null, requestDispatchedAt: null, error: null } },
      candidateRef: input.item.candidateRef, fieldPath: 'fields.sellerTaxId', summary: 'The child proposes seller ID 999; unverified.',
      documentRefs: input.phase.basis.documentRefs, inputIds: [101], sourceRefs: input.evidenceRefs } as const;
    const context = need(buildInvoiceWorkContext({ ...input, modelReports: [report] }));
    expect(context.conflicts[0]).toMatchObject({ provenance: 'model-self-report', sourceRefs: input.evidenceRefs, inputIds: [101] });
    expect(context.modelReports[0]).toMatchObject({ provenance: 'model-self-report', child: report.child, summary: report.summary });
    expect(context.confirmedBusinessReferences).toHaveLength(1);
    for (const invalid of [
      { ...report, child: { ...report.child, itemId: 72 } },
      { ...report, child: { ...report.child, parentAttemptId: 22 } },
      { ...report, candidateRef: { id: 44, sequence: 1 } },
      { ...report, inputIds: [102] },
    ]) expect(buildInvoiceWorkContext({ ...input, modelReports: [invalid] }).ok).toBe(false);
  });

  it('does not let an earlier continue authorize a later saved supplement, including same-timestamp commands', () => {
    const input = fixture(), original = input.authorizedInputs[0]!;
    const continuedBy = { operation: 'continueWork', workId: 7, requestId: 'continue-before-new-supplement', revision: 6, receivedAt: at,
      execution: { kind: 'accepted', authorizationAccepted: true, attempt: { attemptId: 21, runId: null, runtimeLinked: false }, relation: 'new' } } as const;
    const savedLater = { ...original, request: { ...original.request, expectedRevision: 6 },
      receipt: { ...original.receipt, revision: 7, execution: { kind: 'waiting', authorizationAccepted: false,
        attempt: null, reason: 'New material still needs explicit continue.', todoIds: [81] } }, continuedBy } as const;
    expect(buildInvoiceWorkContext({ ...input, work: { ...input.work, revision: 7 }, authorizedInputs: [savedLater] }).ok).toBe(false);
    expect(buildInvoiceWorkContext({ ...input, work: { ...input.work, revision: 7 },
      authorizedInputs: [{ ...savedLater, continuedBy: { ...continuedBy, revision: 7 } }] }).ok).toBe(false);
    expect(buildInvoiceWorkContext({ ...input, work: { ...input.work, revision: 8 },
      authorizedInputs: [{ ...savedLater, continuedBy: { ...continuedBy, revision: 8 } }] }).ok).toBe(true);
  });

  it('keeps original acceptance requests and user edits as distinct business provenance', () => {
    const input = fixture(), original = input.confirmedBusinessReferences[0]!;
    const accepted = { ...original, kind: 'acceptance', acceptRequest: { jobId: 91, candidateId: 44,
      expectedCandidateId: 44, expectedRevision: 2, operationRef: 'original-accept-operation', dirty: false } } as const;
    const edited = { ...original, kind: 'user-edit' } as const;
    const context = need(buildInvoiceWorkContext({ ...input, confirmedBusinessReferences: [accepted, edited] }));
    expect(context.confirmedBusinessReferences).toEqual([{ ...accepted, provenance: 'business-record-reference' },
      { ...edited, provenance: 'user-provided' }]);
    expect(buildInvoiceWorkContext({ ...input, confirmedBusinessReferences: [{ ...accepted,
      acceptRequest: { ...accepted.acceptRequest, expectedCandidateId: 45 } }] }).ok).toBe(false);
    expect(buildInvoiceWorkContext({ ...input, confirmedBusinessReferences: [{ ...accepted, acceptRequest: undefined }] }).ok).toBe(false);
  });

  it('reuses only still-relevant historical clarification content without turning it into a new consumed input', () => {
    const input = fixture(), original = input.authorizedInputs[0]!;
    const historical = { inputId: 102, receipt: { ...original.receipt, inputId: 102, revision: 3, requestId: 'old-supplement',
      execution: { kind: 'accepted', authorizationAccepted: true,
        attempt: { attemptId: 20, runId: 30, runtimeLinked: true }, relation: 'original' } }, continuedBy: null,
      request: { ...original.request, requestId: 'old-supplement', expectedRevision: 2, text: 'HISTORICAL-SELLER-CLARIFICATION' },
      consumedPhase: { ...input.phase, phaseId: 60, attemptId: 20, requestId: 'old-phase', consumedAt: at,
        nativeConversationId: 50, nativeSubmissionId: 51, basis: { ...input.phase.basis, inputIds: [102], itemRevision: 1 } } } as const;
    const report = { child: { runtimeKind: 'durable', kind: 'subagent', workId: 7, itemId: 71, parentAttemptId: 21,
      childRunId: 32, originToolCallId: 33, role: 'invoice-evidence-checker', runStatus: 'completed', resultRecorded: true,
      stopConfirmed: true, stoppedAt: at, delivery: { version: 1, state: 'unknown', messageObservedAt: null,
        includedInCallSequence: null, requestDispatchedAt: null, error: null } },
      candidateRef: input.item.candidateRef, fieldPath: 'fields.sellerTaxId', summary: 'Check the earlier clarification against the current candidate.',
      documentRefs: input.phase.basis.documentRefs, inputIds: [102], sourceRefs: input.evidenceRefs } as const;
    const withHistory = { ...input, historicalInputReferences: [historical], modelReports: [report],
      todos: [{ ...input.todos[0]!, basis: { ...input.todos[0]!.basis, inputIds: [102] } }] };
    const context = need(buildInvoiceWorkContext(withHistory));
    expect(context.userInputs.map(value => value.inputId)).toEqual([101]);
    expect(context.phase.basis.inputIds).toEqual([101]);
    expect(context.historicalInputReferences).toEqual([{ provenance: 'historical-user-input-reference', inputId: 102,
      requestId: 'old-supplement', todoId: 81, phaseId: 60, attemptId: 20, consumedAt: at,
      content: { provenance: 'user-provided', text: 'HISTORICAL-SELLER-CLARIFICATION', documentRefs: [{ id: 13, version: 'v2' }] } }]);
    expect(context.modelReports[0]!.inputIds).toEqual([102]);
    const unrelated = { ...historical, receipt: { ...historical.receipt, todoId: 82 }, request: { ...historical.request, todoId: 82 } };
    const referenceOnly = need(buildInvoiceWorkContext({ ...withHistory, historicalInputReferences: [unrelated],
      todos: input.todos, modelReports: [] }));
    expect(referenceOnly.historicalInputReferences[0]).not.toHaveProperty('content');
    expect(need(formatInvoiceWorkContext(referenceOnly))).not.toContain('HISTORICAL-SELLER-CLARIFICATION');
    expect(need(buildInvoiceWorkContext({ ...withHistory, historicalInputReferences: [unrelated] })).historicalInputReferences[0])
      .toHaveProperty('content.text', 'HISTORICAL-SELLER-CLARIFICATION');
    for (const invalid of [
      { ...historical, consumedPhase: { ...historical.consumedPhase, consumedAt: null } },
      { ...historical, consumedPhase: { ...historical.consumedPhase, workId: 8 } },
      { ...historical, consumedPhase: { ...historical.consumedPhase, itemId: 72 } },
      { ...historical, consumedPhase: { ...historical.consumedPhase, nativeSubmissionId: null } },
      { ...historical, consumedPhase: { ...historical.consumedPhase, basis: { ...historical.consumedPhase.basis, inputIds: [] } } },
      { ...historical, receipt: { ...historical.receipt, execution: { kind: 'waiting', authorizationAccepted: false,
        attempt: null, reason: 'Saved only.', todoIds: [81] } } },
      { ...historical, text: 'Copied old input text.' },
      { ...historical, request: { ...historical.request, itemId: 72 } },
      { ...historical, request: { ...historical.request, todoId: 82 } },
      { ...historical, request: { ...historical.request, materials: [{ id: 99, version: 'foreign' }] } },
    ]) expect(buildInvoiceWorkContext({ ...withHistory, historicalInputReferences: [invalid] }).ok).toBe(false);
    expect(buildInvoiceWorkContext({ ...withHistory, historicalInputReferences: [] }).ok).toBe(false);
  });

  it('does not build a model working set across current stop, cancellation or final disposition gates', () => {
    const input = fixture();
    expect(buildInvoiceWorkContext({ ...input, current: { ...input.current, work: { ...input.work, status: 'cancelled' } } }).ok).toBe(false);
    expect(buildInvoiceWorkContext({ ...input, current: { ...input.current, work: { ...input.work,
      execution: { ...input.work.execution, requiresContinue: true } } } }).ok).toBe(false);
    expect(buildInvoiceWorkContext({ ...input, current: { ...input.current, work: { ...input.work,
      execution: { ...input.work.execution, stopUnconfirmed: true } } } }).ok).toBe(false);
    expect(buildInvoiceWorkContext({ ...input, current: { ...input.current, item: { ...input.item, disposition: 'excluded',
      decision: { kind: 'excluded', reason: 'User excluded this ticket.' }, disposedAt: at } } }).ok).toBe(false);
  });

  it('fails explicitly on UTF-8 or formatted context limits without truncating the input or erasing history', () => {
    const input = fixture(), original = input.authorizedInputs[0]!;
    expect(buildInvoiceWorkContext({ ...input, authorizedInputs: [{ ...original,
      request: { ...original.request, text: '票'.repeat(7334) } }] }).ok).toBe(false);
    const large = { ...input, work: { ...input.work, goal: '票'.repeat(5000) },
      authorizedInputs: [{ ...original, request: { ...original.request, text: '字'.repeat(3000) } }] };
    const context = need(buildInvoiceWorkContext(large));
    expect(new TextEncoder().encode(need(formatInvoiceWorkContext(context))).byteLength).toBeGreaterThan(22000);
    const tooManyTodos = Array.from({ length: 1500 }, (_, index) => ({ ...input.todos[0]!, todoId: index + 1,
      problem: '问'.repeat(2048) }));
    const oversized = { ...context, todos: tooManyTodos.map(todo => ({ provenance: 'business-rule', todo })) };
    expect(formatInvoiceWorkContext(oversized)).toMatchObject({ ok: false, error: { code: 'context_evidence_too_large' } });
    expect(large.authorizedInputs[0]!.request.text).toHaveLength(3000);
    expect(need(formatInvoiceWorkContext(need(buildInvoiceWorkContext(input))))).toContain(input.work.goal);
  });

  it('rejects transcript bodies, copied evidence text and model statements masquerading as business records', () => {
    const input = fixture();
    expect(buildInvoiceWorkContext({ ...input, transcript: ['Whole parent history.'] }).ok).toBe(false);
    expect(buildInvoiceWorkContext({ ...input, evidenceRefs: [{ ...input.evidenceRefs[0]!, quote: 'Copied original body.' }] }).ok).toBe(false);
    expect(buildInvoiceWorkContext({ ...input,
      confirmedBusinessReferences: [{ ...input.confirmedBusinessReferences[0]!, kind: 'model-report' }] }).ok).toBe(false);
  });
});
