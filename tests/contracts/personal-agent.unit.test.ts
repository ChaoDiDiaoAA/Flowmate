import { describe, expect, it } from 'bun:test';
import * as contracts from '../../packages/contracts/src/index.ts';

const at = '2026-10-28T00:00:00.000Z';
const configuration = { modelId: null, thinkingLevel: 'off', preferences: '', workingDirectory: null,
  resources: { prompt: null, enabledSkills: [] }, extensions: { enabledExtensions: [] }, tools: ['read_invoice_document'] } as const;
const work = { workId: 7, personalAgentId: 1, sessionId: 70, runtimeKind: 'durable', revision: 3, goal: 'Organize invoices.',
  status: 'open', createdAt: at, updatedAt: at, counts: { total: 2, unresolved: 2, accepted: 0, rejected: 0, excluded: 0 },
  execution: { attempt: null, runStatus: null, queued: false, requiresContinue: false, stopUnconfirmed: false,
    waitingReason: 'Waiting for materials.', ownedChildRunIds: [] },
  actions: [{ kind: 'continue', enabled: false, reason: 'No executable work.', itemId: null, todoId: null }] } as const;
const item = { workId: 7, itemId: 71, revision: 2, documentRef: { id: 11, version: 'v1' }, jobId: 91,
  candidateRef: { id: 44, sequence: 2 }, disposition: 'unresolved', decision: null, disposedAt: null, todoCount: 1,
  latestInputId: 101, updatedAt: at } as const;
const todo = { todoId: 81, workId: 7, itemId: 71, revision: 2, actor: 'user', fieldPath: 'fields.sellerTaxId',
  problem: 'Tax ID is ambiguous.', needed: 'Provide the seller tax ID.', satisfiedBy: 'An authorized clarification resolves the discrepancy.',
  applicable: true, action: 'supplement', basis: { origin: 'rule', documentRefs: [{ id: 11, version: 'v1' }],
    sourceRefs: [{ documentId: 11, version: 'v1', artifactId: 22, page: 1, blockId: 'b1' }], inputIds: [101],
    candidateRef: { id: 44, sequence: 2 } } } as const;


const child = { runtimeKind: 'durable', kind: 'subagent', workId: 7, itemId: 71, parentAttemptId: 21, childRunId: 22,
  originToolCallId: 23, role: 'invoice-evidence-checker', runStatus: 'completed', resultRecorded: true,
  stopConfirmed: false, stoppedAt: null, parentModelReceivedAt: null, delivery: { version: 1, state: 'unknown', messageObservedAt: null,
    includedInCallSequence: null, requestDispatchedAt: null, error: null } } as const;

describe('P18 public business command contracts', () => {
  it('keeps execution states out of work status and final item disposition', () => {
    expect(contracts.SessionRuntimeKindSchema).toBeDefined();
    expect(contracts.InvoiceWorkStatusSchema).toBeDefined();
    expect(contracts.InvoiceWorkItemDispositionSchema).toBeDefined();
    for (const kind of ['agent_session', 'durable'])
      expect(contracts.SessionRuntimeKindSchema.safeParse(kind).success).toBe(true);
    for (const state of ['open', 'completed', 'cancelled'])
      expect(contracts.InvoiceWorkStatusSchema.safeParse(state).success).toBe(true);
    for (const disposition of ['unresolved', 'accepted', 'rejected', 'excluded'])
      expect(contracts.InvoiceWorkItemDispositionSchema.safeParse(disposition).success).toBe(true);
    for (const state of ['running', 'waiting', 'failed', 'accepted'])
      expect(contracts.InvoiceWorkStatusSchema.safeParse(state).success).toBe(false);
    for (const state of ['completed', 'failed', 'candidate-rejected'])
      expect(contracts.InvoiceWorkItemDispositionSchema.safeParse(state).success).toBe(false);
    expect(contracts.SessionRuntimeKindSchema.safeParse('provider').success).toBe(false);
  });

  it('requires the seen product attempt and revision without accepting native handles or expanded limits', () => {
    expect(contracts.InvoiceWorkContinueRequestSchema).toBeDefined();
    const request = { workId: 7, requestId: 'continue-1', expectedRevision: 3, expectedAttemptId: null };
    expect(contracts.InvoiceWorkContinueRequestSchema.parse(request)).toEqual(request);
    expect(contracts.InvoiceWorkContinueRequestSchema.safeParse({ ...request, expectedAttemptId: 15 }).success).toBe(true);
    for (const invalid of [
      { ...request, workId: 0 }, { ...request, expectedRevision: -1 }, { ...request, expectedRevision: 1.5 },
      { ...request, expectedAttemptId: undefined }, { ...request, expectedAttemptId: 0 },
      { ...request, requestId: ' ' }, { ...request, nativeTaskId: 15 }, { ...request, nativeConversationId: 4 },
      { ...request, runtimeKind: 'agent_session' }, { ...request, budget: { maxModelCalls: 64 } },
    ]) expect(contracts.InvoiceWorkContinueRequestSchema.safeParse(invalid).success).toBe(false);
  });

  it('queries a lost create receipt without a work ID or write revision and keeps other operations work-scoped', () => {
    expect(contracts.InvoiceWorkQueryOperationRequestSchema).toBeDefined();
    const created = { operation: 'create', personalAgentId: 1, requestId: 'create-1' } satisfies contracts.InvoiceWorkQueryOperationRequest;
    expect(contracts.InvoiceWorkQueryOperationRequestSchema.parse(created)).toEqual(created);
    for (const operation of ['continueWork', 'supplement', 'disposeItem', 'cancelWork'] as const) {
      const query = { operation, workId: 7, requestId: 'operation-1' };
      expect(contracts.InvoiceWorkQueryOperationRequestSchema.parse(query)).toEqual(query);
      expect(contracts.InvoiceWorkQueryOperationRequestSchema.safeParse({ operation, requestId: 'operation-1' }).success).toBe(false);
      expect(contracts.InvoiceWorkQueryOperationRequestSchema.safeParse({ ...query, expectedRevision: 3 }).success).toBe(false);
    }
    for (const invalid of [
      { ...created, personalAgentId: 0 }, { ...created, nativeConversationId: 4 },
      { operation: 'create', requestId: 'create-1' }, { operation: 'resume', workId: 7, requestId: 'operation-1' },
      { operation: 'supplement', workId: 0, requestId: 'operation-1' },
    ]) expect(contracts.InvoiceWorkQueryOperationRequestSchema.safeParse(invalid).success).toBe(false);
  });

  it('creates a fixed document selection and related-source references without accepting runtime authority or candidate bodies', () => {
    expect(contracts.InvoiceWorkCreateRequestSchema).toBeDefined();
    // @ts-expect-error A native handle is not a typed product business request.
    const forged: contracts.InvoiceWorkCreateRequest = { nativeConversationId: 2 };
    expect(contracts.InvoiceWorkCreateRequestSchema.safeParse(forged).success).toBe(false);
    const input = { personalAgentId: 1, expectedAgentRevision: 0, requestId: 'create-original',
      goal: 'Organize these invoices.', documents: [{ id: 11, version: 'v1' }, { id: 12, version: 'v1' }],
      source: { workId: 3, items: [{ itemId: 31, documentRef: { id: 11, version: 'v0' }, candidateRef: { id: 41, sequence: 2 } }] } };
    expect(contracts.InvoiceWorkCreateRequestSchema.parse(input)).toEqual(input);
    const versions = { ...input, source: { workId: 3, items: [input.source.items[0],
      { ...input.source.items[0], documentRef: { id: 11, version: 'v1' }, candidateRef: { id: 42, sequence: 3 } }] } };
    expect(contracts.InvoiceWorkCreateRequestSchema.parse(versions)).toEqual(versions);
    for (const invalid of [
      { ...input, documents: [] }, { ...input, documents: [{ id: 11, version: 'v1' }, { id: 11, version: 'v2' }] },
      { ...input, expectedAgentRevision: undefined }, { ...input, runtimeKind: 'agent_session' },
      { ...input, nativeConversationId: 2 }, { ...input, accepted: true }, { ...input, budget: { maxModelCalls: 64 } },
      { ...input, source: { workId: 3, items: [{ itemId: 31, candidate: { fields: {} } }] } },
    ]) expect(contracts.InvoiceWorkCreateRequestSchema.safeParse(invalid).success).toBe(false);
    const many = { ...input, source: undefined, documents: Array.from({ length: 128 }, (_, index) => ({ id: index + 1, version: 'v1' })) };
    expect(contracts.InvoiceWorkCreateRequestSchema.safeParse(many).success).toBe(true);
    const oversized = { ...many, documents: Array.from({ length: 14_000 }, (_, index) => ({ id: index + 1, version: 'v1' })) };
    expect(new TextEncoder().encode(JSON.stringify(oversized)).byteLength).toBeGreaterThan(262_144);
    expect(contracts.InvoiceWorkCreateRequestSchema.safeParse(oversized).success).toBe(false);
  });

  it('binds supplementation to a specific item and Todo while preserving text and versioned material references', () => {
    expect(contracts.InvoiceWorkSupplementRequestSchema).toBeDefined();
    const input = { workId: 7, itemId: 71, todoId: 81, requestId: 'supplement-1', expectedRevision: 3,
      text: '  Seller clarification.  ', materials: [{ id: 13, version: 'v2' }] };
    expect(contracts.InvoiceWorkSupplementRequestSchema.parse(input)).toEqual(input);
    const versions = { ...input, materials: [{ id: 13, version: 'v1' }, { id: 13, version: 'v2' }] };
    expect(contracts.InvoiceWorkSupplementRequestSchema.parse(versions)).toEqual(versions);
    expect(contracts.InvoiceWorkSupplementRequestSchema.safeParse({ ...input, text: '', materials: input.materials }).success).toBe(true);
    for (const invalid of [
      { ...input, todoId: undefined }, { ...input, todoId: 0 }, { ...input, expectedRevision: -1 },
      { ...input, text: ' ', materials: [] }, { ...input, materials: [{ id: 13, version: '' }] },
      { ...input, goal: 'A new target.' }, { ...input, runtimeKind: 'durable' }, { ...input, mode: 'steer' },
      { ...input, materials: [{ id: 13, version: 'v2', path: 'C:/unapproved.pdf' }] },
    ]) expect(contracts.InvoiceWorkSupplementRequestSchema.safeParse(invalid).success).toBe(false);
  });

  it('requires the original acceptance operation or an explicit final rejection/exclusion reason for item disposal', () => {
    expect(contracts.InvoiceWorkDisposeItemRequestSchema).toBeDefined();
    expect(contracts.InvoiceWorkCancelRequestSchema).toBeDefined();
    const input = { workId: 7, itemId: 71, requestId: 'dispose-1', expectedRevision: 4,
      decision: { kind: 'accepted', candidateRef: { id: 44, sequence: 2 },
        acceptRequest: { operationRef: 'original-accept', jobId: 91, expectedCandidateId: 44, candidateId: 44, expectedRevision: 2, dirty: false } } } satisfies contracts.InvoiceWorkDisposeItemRequest;
    expect(contracts.InvoiceWorkDisposeItemRequestSchema.parse(input)).toEqual(input);
    for (const kind of ['rejected', 'excluded'] as const) {
      const explicit = { ...input, decision: { kind, reason: 'User explicitly ended this item.' } };
      expect(contracts.InvoiceWorkDisposeItemRequestSchema.parse(explicit)).toEqual(explicit);
      expect(contracts.InvoiceWorkDisposeItemRequestSchema.safeParse({ ...input, decision: { kind } }).success).toBe(false);
    }
    for (const decision of [
      { kind: 'accepted' }, { kind: 'unresolved', reason: 'Reopen.' },
      { ...input.decision, candidateRef: { id: 45, sequence: 2 } },
      { ...input.decision, acceptRequest: { ...input.decision.acceptRequest, dirty: true } },
      { kind: 'candidate-rejected', reason: 'Rejected candidate only.' },
    ]) expect(contracts.InvoiceWorkDisposeItemRequestSchema.safeParse({ ...input, decision }).success).toBe(false);
    const cancel = { workId: 7, requestId: 'cancel-1', expectedRevision: 4 };
    expect(contracts.InvoiceWorkCancelRequestSchema.parse(cancel)).toEqual(cancel);
    expect(contracts.InvoiceWorkCancelRequestSchema.safeParse({ ...cancel, nativeTaskId: 18 }).success).toBe(false);
  });

  it('separates saved supplementation from execution authorization and allows a queued product attempt without a fictional Run', () => {
    expect(contracts.InvoiceWorkSupplementReceiptSchema).toBeDefined();
    expect(contracts.InvoiceWorkOperationReceiptSchema).toBeDefined();
    const saved = { operation: 'supplement', workId: 7, requestId: 'supplement-1', revision: 4,
      receivedAt: '2026-10-28T00:00:00.000Z', itemId: 71, todoId: 81, inputId: 101, saved: true,
      execution: { kind: 'blocked', authorizationAccepted: false, attempt: null,
        reason: { code: 'provider_auth_failed', category: 'provider', message: 'Credential is unavailable.', retryable: true } } } satisfies contracts.InvoiceWorkSupplementReceipt;
    expect(contracts.InvoiceWorkSupplementReceiptSchema.parse(saved)).toEqual(saved);
    const queued = { ...saved, execution: { kind: 'queued', authorizationAccepted: true, relation: 'new',
      attempt: { attemptId: 21, runId: null, runtimeLinked: false } } } satisfies contracts.InvoiceWorkSupplementReceipt;
    expect(contracts.InvoiceWorkOperationReceiptSchema.parse(queued)).toEqual(queued);
    for (const execution of [
      { ...queued.execution, attempt: null }, { ...queued.execution, authorizationAccepted: false },
      { ...saved.execution, authorizationAccepted: true },
      { ...queued.execution, attempt: { ...queued.execution.attempt, nativeTaskId: 18 } },
    ]) expect(contracts.InvoiceWorkSupplementReceiptSchema.safeParse({ ...saved, execution }).success).toBe(false);
    expect(contracts.InvoiceWorkOperationReceiptSchema.safeParse({ ...saved, currentRevision: 7 }).success).toBe(false);
  });


  it('keeps the default assistant configuration as product references rather than native credentials or runtime handles', () => {
    expect(contracts.PersonalAgentSnapshotSchema).toBeDefined();
    expect(contracts.PersonalAgentUpdateRequestSchema).toBeDefined();
    expect(contracts.PersonalAgentOpenConversationRequestSchema).toBeDefined();
    const snapshot = { personalAgentId: 1, revision: 0, runtimeKind: 'durable', configuration, createdAt: at, updatedAt: at } as const;
    expect(contracts.PersonalAgentSnapshotSchema.parse(snapshot)).toEqual(snapshot);
    const update = { personalAgentId: 1, expectedRevision: 0, configuration } as const;
    expect(contracts.PersonalAgentUpdateRequestSchema.parse(update)).toEqual(update);
    for (const bad of [
      { ...update, nativeConversationId: 2 },
      { ...update, configuration: { ...configuration, apiKey: 'synthetic-forbidden' } },
      { ...update, configuration: { ...configuration, tools: ['Agent', 'Agent'] } },
      { ...update, configuration: { ...configuration, modelId: '../unapproved-model' } },
    ]) expect(contracts.PersonalAgentUpdateRequestSchema.safeParse(bad).success).toBe(false);
    expect(contracts.PersonalAgentOpenConversationRequestSchema.parse({ workId: 7 })).toEqual({ workId: 7 });
    expect(contracts.PersonalAgentOpenConversationRequestSchema.safeParse({ workId: 7, expectedRevision: 3 }).success).toBe(false);
  });

  it('projects work and item facts without treating cancellation, a candidate reference or an enabled action as authority', () => {
    expect(contracts.InvoiceWorkViewSchema).toBeDefined(); expect(contracts.InvoiceWorkItemViewSchema).toBeDefined();
    expect(contracts.InvoiceWorkViewSchema.parse(work)).toEqual(work);
    expect(contracts.InvoiceWorkItemViewSchema.parse(item)).toEqual(item);
    const accepted = { ...item, disposition: 'accepted', disposedAt: at,
      decision: { kind: 'accepted', candidateRef: { id: 44, sequence: 2 }, acceptRequest: {
        operationRef: 'original-accept', jobId: 91, expectedCandidateId: 44, candidateId: 44, expectedRevision: 2, dirty: false,
      } } } satisfies contracts.InvoiceWorkItemView;
    expect(contracts.InvoiceWorkItemViewSchema.parse(accepted)).toEqual(accepted);
    expect(contracts.InvoiceWorkItemViewSchema.safeParse({ ...accepted, jobId: 92 }).success).toBe(false);
    const stopped = { ...work, status: 'cancelled', execution: { ...work.execution, runStatus: 'cancelled',
      attempt: { attemptId: 21, runId: 31, runtimeLinked: true }, stopUnconfirmed: true } } as const;
    expect(contracts.InvoiceWorkViewSchema.parse(stopped)).toEqual(stopped);
    for (const bad of [
      { ...work, status: 'running' }, { ...work, counts: { ...work.counts, total: 3 } },
      { ...work, status: 'completed' }, { ...work, nativeConversationId: 2 },
      { ...work, execution: { ...work.execution, ownedChildRunIds: [21, 22, 23, 24, 25] } },
      { ...work, actions: [{ ...work.actions[0], authorizationAccepted: true }] },
    ]) expect(contracts.InvoiceWorkViewSchema.safeParse(bad).success).toBe(false);
    expect(contracts.InvoiceWorkItemViewSchema.safeParse({ ...item, disposition: 'accepted' }).success).toBe(false);
    expect(contracts.InvoiceWorkItemViewSchema.safeParse({ ...item, fields: {} }).success).toBe(false);
  });

  it('keeps Todo evidence as original references and current applicability without a free-form Todo state or copied quote', () => {
    expect(contracts.InvoiceWorkTodoViewSchema).toBeDefined();
    expect(contracts.InvoiceWorkTodoViewSchema.parse(todo)).toEqual(todo);
    expect(contracts.InvoiceWorkTodoViewSchema.safeParse({ ...todo, applicable: false }).success).toBe(true);
    for (const bad of [
      { ...todo, fieldPath: 'fields.unregistered' }, { ...todo, status: 'completed' },
      { ...todo, basis: { ...todo.basis, sourceRefs: [{ ...todo.basis.sourceRefs[0], quote: 'Copied invoice text.' }] } },
      { ...todo, basis: { origin: 'model', documentRefs: [], sourceRefs: [], inputIds: [], candidateRef: null } },
    ]) expect(contracts.InvoiceWorkTodoViewSchema.safeParse(bad).success).toBe(false);
  });

  it('uses bounded read pages with explicit work/item views and retains parent identity on real subagent references', () => {
    expect(contracts.InvoiceWorkGetRequestSchema).toBeDefined(); expect(contracts.InvoiceWorkGetResultSchema).toBeDefined();
    expect(contracts.InvoiceWorkChildReferenceSchema).toBeDefined();
    expect(contracts.InvoiceWorkGetRequestSchema.parse({ view: 'item', workId: 7, itemId: 71 }))
      .toEqual({ view: 'item', workId: 7, itemId: 71, limit: 50 });
    expect(contracts.InvoiceWorkGetRequestSchema.safeParse({ view: 'item', workId: 7 }).success).toBe(false);
    const page = { view: 'item', work, item, todos: [todo], nextAfterTodoId: null } as const;
    expect(contracts.InvoiceWorkGetResultSchema.parse(page)).toEqual(page);
    expect(contracts.InvoiceWorkGetResultSchema.safeParse({ ...page, item: { ...item, workId: 8 } }).success).toBe(false);
    expect(contracts.InvoiceWorkChildReferenceSchema.parse(child)).toEqual(child);
    for (const bad of [
      { ...child, kind: 'phase' }, { ...child, childRunId: undefined, nativeTaskId: 18 },
      { ...child, pluginAgentId: 'old-plugin-child' }, { ...child, verified: true }, { ...child, stopConfirmed: true },
    ]) expect(contracts.InvoiceWorkChildReferenceSchema.safeParse(bad).success).toBe(false);
  });

  it('exposes service connection facts and rejects arbitrary management targets without granting task execution', () => {
    expect(contracts.BackgroundServiceStateSchema).toBeDefined(); expect(contracts.BackgroundServiceConnectRequestSchema).toBeDefined();
    const state = { state: 'ready', installationId: '10000000-0000-4000-8000-000000000001', protocolVersion: 1, dataVersion: 20, error: null } as const;
    expect(contracts.BackgroundServiceStateSchema.parse(state)).toEqual(state);
    expect(contracts.BackgroundServiceStateSchema.safeParse({ ...state, installationId: null }).success).toBe(false);
    expect(contracts.BackgroundServiceStateSchema.safeParse({ ...state, canRunTask: true }).success).toBe(false);
    const request = { installationId: state.installationId };
    expect(contracts.BackgroundServiceConnectRequestSchema.parse(request)).toEqual(request);
    for (const extra of [{ dataRoot: 'C:/other-data' }, { executable: 'other.exe' }, { password: 'synthetic-forbidden' }])
      expect(contracts.BackgroundServiceConnectRequestSchema.safeParse({ ...request, ...extra }).success).toBe(false);
  });


  it('requires usable navigation targets without turning an action projection into an execution request', () => {
    const action = { kind: 'supplement', enabled: true, reason: null, itemId: 71, todoId: 81 } as const;
    expect(contracts.InvoiceWorkActionSchema.parse(action)).toEqual(action);
    expect(contracts.InvoiceWorkActionSchema.safeParse({ ...action, todoId: null }).success).toBe(false);
    expect(contracts.InvoiceWorkActionSchema.safeParse({ ...action, itemId: null }).success).toBe(false);
    expect(contracts.InvoiceWorkActionSchema.safeParse({ ...action, enabled: false, reason: 'Select a Todo.', itemId: null, todoId: null }).success).toBe(true);
    expect(contracts.InvoiceWorkActionSchema.safeParse({ ...action, enabled: false }).success).toBe(false);
    expect(contracts.InvoiceWorkActionSchema.safeParse({ ...action, kind: 'continue' }).success).toBe(false);
    expect(contracts.InvoiceWorkViewSchema.safeParse({ ...work, execution: { ...work.execution, runStatus: 'pending' } }).success).toBe(false);
  });

  it('keeps attempt reads and original stop receipts product-scoped while paging historical children beyond the live ownership cap', () => {
    const stop = { workId: 7, attemptId: 21, requestId: 'stop-original', expectedRevision: 3 };
    expect(contracts.PersonalTaskStopRequestSchema.parse(stop)).toEqual(stop);
    expect(contracts.PersonalTaskStopRequestSchema.safeParse({ ...stop, nativeTaskId: 18 }).success).toBe(false);
    const receipt = { workId: 7, attemptId: 21, requestId: 'stop-original', receivedAt: at,
      accepted: true, stopConfirmed: false, stoppedAt: null } as const;
    expect(contracts.PersonalTaskStopReceiptSchema.parse(receipt)).toEqual(receipt);
    expect(contracts.PersonalTaskStopReceiptSchema.safeParse({ ...receipt, stopConfirmed: true }).success).toBe(false);
    expect(contracts.PersonalTaskGetRequestSchema.parse({ workId: 7, attemptId: 21, stopRequestId: 'stop-original' }))
      .toEqual({ workId: 7, attemptId: 21, stopRequestId: 'stop-original', limit: 50 });
    expect(contracts.PersonalTaskGetRequestSchema.safeParse({ workId: 7, attemptId: 21, expectedRevision: 3 }).success).toBe(false);
    const task = { workId: 7, sessionId: 70, attempt: { attemptId: 21, runId: 31, runtimeLinked: true },
      runStatus: 'completed', createdAt: at, queued: false, stopRequestedAt: at, stoppedAt: at } as const;
    const page = { task, children: Array.from({ length: 5 }, (_, index) => ({ ...child, childRunId: 22 + index,
      originToolCallId: 100 + index, stopConfirmed: true, stoppedAt: at })), nextAfterChildRunId: null, stopReceipt: receipt };
    expect(contracts.PersonalTaskGetResultSchema.parse(page)).toEqual(page);
    expect(contracts.PersonalTaskGetResultSchema.safeParse({ ...page, children: [{ ...page.children[0], parentAttemptId: 99 }] }).success).toBe(false);
    expect(contracts.PersonalTaskGetResultSchema.safeParse({ ...page, stopReceipt: { ...receipt, attemptId: 99 } }).success).toBe(false);
  });


  it('bounds list navigation by product identities and stable continuation positions', () => {
    const workPage = { items: [{ ...work, workId: 8 }, work], nextBeforeId: 7 };
    expect(contracts.InvoiceWorkListResultSchema.parse(workPage)).toEqual(workPage);
    expect(contracts.InvoiceWorkListResultSchema.safeParse({ ...workPage, items: [work, { ...work, workId: 8 }] }).success).toBe(false);
    expect(contracts.InvoiceWorkListResultSchema.safeParse({ ...workPage, nextBeforeId: 6 }).success).toBe(false);
    const queued = { workId: 7, sessionId: 70, attempt: { attemptId: 22, runId: null, runtimeLinked: false },
      runStatus: null, createdAt: at, queued: true, stopRequestedAt: null, stoppedAt: null } as const;
    const attempts = { workId: 7, items: [queued, { ...queued, attempt: { ...queued.attempt, attemptId: 21 } }], nextBeforeAttemptId: 21 };
    expect(contracts.PersonalTaskListResultSchema.parse(attempts)).toEqual(attempts);
    expect(contracts.PersonalTaskListResultSchema.safeParse({ ...attempts, items: [{ ...queued, workId: 8 }] }).success).toBe(false);
    expect(contracts.PersonalTaskListResultSchema.safeParse({ ...attempts, nextBeforeAttemptId: 22 }).success).toBe(false);
    const largeText = { personalAgentId: 1, expectedAgentRevision: 0, requestId: 'oversized-utf8',
      goal: '票'.repeat(8000), documents: [{ id: 11, version: 'v1' }] };
    expect(contracts.InvoiceWorkCreateRequestSchema.safeParse(largeText).success).toBe(false);
  });

});
