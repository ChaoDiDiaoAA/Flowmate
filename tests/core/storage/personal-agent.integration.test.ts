import { expect, test } from 'bun:test';
import { z } from 'zod';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { appError, InvoiceWorkOperationReceiptSchema, PersonalAgentConfigurationSchema, type DocumentRef, type InvoiceWorkCreateRequest, type InvoiceWorkSupplementRequest, type Result } from '@flowmate/contracts';
import type { InvoiceWorkAdmission, InvoiceWorkRepository, InvoiceWorkTodoDefinition } from '../../../packages/core/src/personal-agent/repository.ts';
import type { SqlDatabaseStore } from '../../../packages/core/src/storage/database.ts';
import { openTestDatabase } from '../../support/database.ts';
import { mkdtempSync } from '../../support/resources.ts';
import { InvoiceWorkPhaseContextService, InvoiceWorkPhaseObserver } from '../../../packages/core/src/personal-agent/phase-context.ts';
import { buildInvoiceWorkContext } from '../../../packages/runtime-durable/src/context.ts';

const at = '2026-10-28T00:00:00.000Z', later = '2026-10-28T00:01:00.000Z';
const configuration = PersonalAgentConfigurationSchema.parse({ modelId: null, thinkingLevel: 'off',
  resources: { prompt: null, enabledSkills: [] }, extensions: { enabledExtensions: [] }, tools: [],
  workingDirectory: null, preferences: '' });

function need<T>(result: Result<T>): T { if (!result.ok) throw Error(result.error.code); return result.data; }

function registerDocument(store: SqlDatabaseStore, documentId: number): DocumentRef {
  const originalId = documentId * 2 - 1, parsedId = documentId * 2;
  const metadata = { version: 1 as const, sourceKey: 'personal-agent-storage', sourceRecordId: `invoice-${documentId}`, sourceVersion: 'v1' };
  need(store.documents.register({ documentId, sourceKey: metadata.sourceKey, sourceRecordId: metadata.sourceRecordId, version: 'v1',
    originalArtifact: { artifactId: originalId, kind: 'original', relativePath: `artifacts/${originalId}/original.pdf`, bytes: 1,
      mimeType: 'application/pdf', metadata: { ...metadata, files: [{ relativePath: 'original.pdf', bytes: 1, mimeType: 'application/pdf' }] }, createdAt: at },
    parsedArtifact: { artifactId: parsedId, kind: 'parsed', relativePath: `artifacts/${parsedId}/parsed.json`, bytes: 1,
      mimeType: 'application/json', metadata: { ...metadata, files: [{ relativePath: 'parsed.json', bytes: 1, mimeType: 'application/json' }] }, createdAt: at },
    status: 'available', metadata: { version: 2, pageCount: 1, warnings: [], allowedUsesClaim: ['Controlled InvoiceWork storage fixture'],
      licenseVerification: 'not_verified', unavailableReason: null }, createdAt: at, updatedAt: at }));
  return { id: documentId, version: 'v1' };
}

async function fixture(memberCount = 2) {
  const root = mkdtempSync(join(tmpdir(), 'flowmate-personal-agent-storage-'));
  const database = need(openTestDatabase({ root, databaseFile: join(root, 'data/app.sqlite'),
    artifactsDir: join(root, 'artifacts'), runtimeDir: join(root, 'runtime'), logsDir: join(root, 'logs'), outputsDir: join(root, 'outputs') }));
  const seeded = await database.transaction(store => ({
    agent: need(store.personalAgents.ensureDefault(configuration, at)),
    documents: Array.from({ length: memberCount }, (_, index) => registerDocument(store, index + 1)),
  }));
  const command = <T>(operation: (repository: InvoiceWorkRepository, store: SqlDatabaseStore) => T) =>
    database.transaction(store => operation(store.invoiceWorks, store));
  const query = <T>(operation: (repository: InvoiceWorkRepository, store: SqlDatabaseStore) => T) =>
    database.read(store => operation(store.invoiceWorks, store));
  const request: InvoiceWorkCreateRequest = { personalAgentId: seeded.agent.personalAgentId,
    expectedAgentRevision: seeded.agent.revision, requestId: 'create-original', goal: 'Review the selected invoice set.', documents: seeded.documents };
  const create = async (admission: InvoiceWorkAdmission = { kind: 'queued' }) => need(await command(repository => repository.create(request, { at, admission })));
  const work = async (workId: number) => {
    const view = need(await query(repository => repository.get({ view: 'work', workId, limit: 100 })));
    if (view.view !== 'work') throw Error('The work query returned another view.');
    return view;
  };
  return { database, ...seeded, command, query, request, create, work };
}

async function withTodo() {
  const f = await fixture(), receipt = await f.create(), selected = (await f.work(receipt.workId)).items[0]!;
  const definition: InvoiceWorkTodoDefinition = { actor: 'user', fieldPath: null,
    problem: 'The invoice needs an explanation.', needed: 'Provide its original explanation.',
    satisfiedBy: 'A qualified explanation is recorded.', action: 'supplement',
    basis: { origin: 'user', documentRefs: [selected.documentRef], sourceRefs: [], inputIds: [], candidateRef: null } };
  const todos = need(await f.command(repository => repository.replaceTodos({ workId: receipt.workId,
    itemId: selected.itemId, expectedRevision: selected.revision, todos: [definition], at })));
  const todo = todos[0]; if (!todo) throw Error('The original Todo was not saved.');
  const view = await f.work(receipt.workId), item = view.items.find(item => item.itemId === selected.itemId);
  if (!item) throw Error('Replacing Todos removed an original work member.');
  const supplement: InvoiceWorkSupplementRequest = { workId: receipt.workId, itemId: item.itemId, todoId: todo.todoId,
    requestId: 'supplement-original', expectedRevision: view.work.revision, text: 'Original clarification.', materials: [] };
  return { ...f, receipt, item, todo, definition, supplement };
}

test('the stop action follows the original queued attempt, saved stop intent and actual closure', async () => {
  const f = await fixture(), created = await f.create();
  const initial = await f.work(created.workId), attempt = initial.work.execution.attempt;
  if (!attempt) throw Error('Expected the original queued attempt.');
  expect(initial.work.actions.find(action => action.kind === 'stop')).toMatchObject({ enabled: true, reason: null });
  need(await f.command((_repository, store) => store.invoiceWorkAttempts.requestStop({ workId: created.workId,
    attemptId: attempt.attemptId, requestId: 'stop-original-queued', expectedRevision: initial.work.revision }, { at: later })));
  const requested = await f.work(created.workId);
  expect(requested.work.execution.stopUnconfirmed).toBe(true);
  expect(requested.work.actions.find(action => action.kind === 'stop')).toMatchObject({ enabled: false });
  const closed = need(await f.command((_repository, store) => store.invoiceWorkAttempts.finish({ workId: created.workId,
    attemptId: attempt.attemptId, runId: null, at: later, effectsReconciled: true,
    stopResult: { workId: created.workId, sessionId: initial.work.sessionId, attemptId: attempt.attemptId, stopped: true, reason: 'not-started' } })));
  expect(closed.closed).toBe(true);
  expect((await f.work(created.workId)).work.actions.find(action => action.kind === 'stop')).toMatchObject({ enabled: false });
  expect(need(await f.query((_repository, store) => store.invoiceWorkAttempts.get({ workId: created.workId, attemptId: attempt.attemptId }))).task)
    .toMatchObject({ stoppedAt: later, runStatus: null });
});

async function phaseFixture() {
  const f = await withTodo();
  const received = need(await f.command(repository => repository.supplement(f.supplement, { at: later, admission: { kind: 'ready' } })));
  if (!received.execution.authorizationAccepted) throw Error('The original phase input has not been authorized.');
  const current = await f.work(f.receipt.workId), item = current.items.find(value => value.itemId === f.item.itemId)!;
  const request = { workId: current.work.workId, attemptId: received.execution.attempt.attemptId, itemId: item.itemId,
    requestId: 'frozen-working-context', kind: 'prompt' as const, basis: { contextSnapshotId: null, configurationRevision: 0,
      itemRevision: item.revision, documentRefs: [item.documentRef], inputIds: [received.inputId] },
    remainingBudget: { modelCalls: 8, toolCalls: 8, toolFeedbackBytes: 1024, timeoutMs: 1000, childSlots: 4 } };
  const query = { workId: request.workId, sessionId: current.work.sessionId, attemptId: request.attemptId, requestId: request.requestId };
  return { ...f, received, request, phaseQuery: query };
}

test('phase and frozen working context commit together and replays retain the original whole-work progress', async () => {
  const f = await phaseFixture(); let builds = 0;
  const service = new InvoiceWorkPhaseContextService({ database: f.database, now: () => later,
    buildContext: input => { builds++; return buildInvoiceWorkContext(input); } });
  const saved = need(await service.freeze(f.request));
  expect(saved.context.userInputs[0]?.text).toBe(f.supplement.text);
  expect(saved.context.work.counts.unresolved).toBe(2);
  const current = await f.work(f.receipt.workId), other = current.items.find(item => item.itemId !== f.item.itemId)!;
  need(await f.command(repository => repository.disposeItem({ workId: current.work.workId, itemId: other.itemId,
    expectedRevision: current.work.revision, requestId: 'exclude-other-invoice', decision: { kind: 'excluded', reason: 'Outside this review.' } }, { at: later })));
  expect(need(await service.freeze(f.request))).toEqual(saved);
  expect(need(await service.get(f.phaseQuery))).toEqual(saved.context);
  expect(await service.verify(f.phaseQuery)).toEqual({ ok: true, data: undefined });
  expect(builds).toBe(1);
  expect(await service.get({ ...f.phaseQuery, sessionId: f.phaseQuery.sessionId + 1 })).toMatchObject({ ok: false, error: { code: 'state_conflict' } });
  const changed = await f.work(f.receipt.workId);
  need(await f.command(repository => repository.cancelWork({ workId: changed.work.workId,
    expectedRevision: changed.work.revision, requestId: 'cancel-frozen-context' }, { at: later })));
  expect(await service.get(f.phaseQuery)).toMatchObject({ ok: false, error: { code: 'state_conflict' } });
  expect(need(await f.query((_repository, scope) => scope.invoiceWorkContexts.get({ workId: f.phaseQuery.workId,
    attemptId: f.phaseQuery.attemptId, requestId: f.phaseQuery.requestId })))).toEqual(saved);
});

test('context save failure rolls back its phase instead of leaving an unresolved native submission gap', async () => {
  const f = await phaseFixture();
  await f.command((_repository, scope) => scope.db.exec("CREATE TRIGGER fail_work_context BEFORE INSERT ON invoice_work_context_snapshots BEGIN SELECT RAISE(ABORT,'controlled context failure'); END;"));
  const service = new InvoiceWorkPhaseContextService({ database: f.database, now: () => later, buildContext: buildInvoiceWorkContext });
  expect(await service.freeze(f.request)).toMatchObject({ ok: false, error: { code: 'storage_write_failed' } });
  expect(need(await f.query(repository => repository.getPhase(f.phaseQuery)))).toBeNull();
  expect(need(await f.query((_repository, scope) => scope.invoiceWorkContexts.get({ workId: f.phaseQuery.workId,
    attemptId: f.phaseQuery.attemptId, requestId: f.phaseQuery.requestId })))).toBeNull();
});

test('a context response lost after the product commit is recovered without rebuilding or resubmitting', async () => {
  const f = await phaseFixture(); let commits = 0, builds = 0;
  const service = new InvoiceWorkPhaseContextService({ database: { read: f.database.read,
    transaction: async operation => { const saved = await f.database.transaction(operation); commits++; throw Error('controlled lost outer receipt'); } },
    now: () => later, buildContext: input => { builds++; return buildInvoiceWorkContext(input); } });
  const saved = need(await service.freeze(f.request));
  expect(saved.context.phase.requestId).toBe(f.request.requestId);
  expect(commits).toBe(1);
  expect(builds).toBe(1);
  expect(await f.query((_repository, scope) => scope.db.query('SELECT COUNT(*) count FROM invoice_work_phases').get())).toEqual({ count: 1 });
  expect(await f.query((_repository, scope) => scope.db.query('SELECT COUNT(*) count FROM invoice_work_context_snapshots').get())).toEqual({ count: 1 });
});

test('the real Durable model consumes the committed invoice snapshot and reconciles an unlinked native result', async () => {
  const f = await phaseFixture(), durable = await import('@flowmate/runtime-durable');
  const contexts = new InvoiceWorkPhaseContextService({ database: f.database, now: () => new Date().toISOString(), buildContext: buildInvoiceWorkContext });
  const first = need(await contexts.freeze(f.request));
  const payloads: string[] = [];
  const server = Bun.serve({ port: 0, fetch: async request => {
    payloads.push(await request.text());
    const response = { id: 'invoice-phase', object: 'chat.completion.chunk', created: 1, model: 'invoice-test',
      choices: [{ index: 0, delta: { role: 'assistant', content: 'The invoice needs user review.' }, finish_reason: 'stop' }] };
    return new Response(`data: ${JSON.stringify(response)}\n\ndata: [DONE]\n\n`, { headers: { 'content-type': 'text/event-stream' } });
  } });
  // This adapter fixture grants each phase; production continuation gates are checked in personal-admission.
  const runtime = need(await durable.createDurableRuntime({ storage: await durable.createDurableSqliteStorage(f.database.coordinator),
    readApiKey: () => 'controlled-test-key', verifyModelUse: () => ({ ok: true, data: undefined }),
    reserveModelRequest: () => ({ ok: true, data: undefined }), readWorkingContext: query => contexts.get(query),
    verifyWorkingContext: query => contexts.verify(query) }));
  const config = { version: 1 as const, name: 'invoice-sdk-fixture', revision: 1,
    modelRef: { provider: 'invoice-test-provider', model: 'invoice-test' }, native: { authPath: 'unused-auth.json', modelsPath: null },
    connection: { api: 'openai-completions', baseUrl: `http://127.0.0.1:${server.port}/v1`, contextWindow: 64000, maxTokens: 8192 },
    parameters: { maxRetries: 0, maxRetryDelayMs: 1000 } };
  const observer = new InvoiceWorkPhaseObserver({ database: f.database, runtime, now: () => new Date().toISOString() });
  try {
    need(await runtime.openConversation({ workId: f.phaseQuery.workId, sessionId: f.phaseQuery.sessionId }));
    need(await runtime.submit({ ...f.phaseQuery, text: 'Process the frozen invoice phase.', config }));
    expect(need(await runtime.waitForSubmission(f.phaseQuery))).toMatchObject({ status: 'done' });
    expect(payloads).toHaveLength(1);
    expect(payloads[0]).toContain(f.supplement.text);
    expect(payloads[0]).toContain('phase-bound-only');
    expect(payloads[0]).not.toContain('invoice-2');
    const observed = need(await observer.reconcile(f.phaseQuery));
    expect(observed?.consumedAt).toBeString();
    expect(observed?.nativeSubmissionId).toBeNumber();
    expect(observed?.phaseId).toBe(first.context.phase.phaseId);
    expect(need(await f.query(repository => repository.getPhase(f.phaseQuery)))).toEqual(observed);
    const nextRequest = { ...f.request, requestId: 'next-frozen-phase', basis: { ...f.request.basis, inputIds: [] } };
    const next = need(await contexts.freeze(nextRequest));
    expect(next.context.historicalInputReferences).toHaveLength(1);
    expect(next.context.userInputs).toEqual([]);
    const nextQuery = { ...f.phaseQuery, requestId: nextRequest.requestId };
    need(await runtime.submit({ ...nextQuery, text: 'Process the frozen invoice phase.', config }));
    expect(need(await runtime.waitForSubmission(nextQuery))).toMatchObject({ status: 'done' });
    expect(payloads).toHaveLength(2);
    const sent = z.object({ messages: z.array(z.object({ role: z.string(), content: z.string().nullable().optional() }).passthrough()) })
      .passthrough().parse(JSON.parse(payloads[1]!));
    const user = sent.messages.find(message => message.role === 'user');
    if (!user?.content) throw Error('Expected the original phase working set.');
    const projected = z.object({ userInputs: z.array(z.unknown()), historicalInputReferences: z.array(z.unknown()),
      phase: z.object({ requestId: z.string(), basis: z.object({ inputIds: z.array(z.number()) }).passthrough() }).passthrough() })
      .passthrough().parse(JSON.parse(user.content));
    expect(projected.userInputs).toEqual([]);
    expect(projected.phase).toMatchObject({ requestId: nextRequest.requestId, basis: { inputIds: [] } });
    expect(projected.historicalInputReferences).toEqual([...next.context.historicalInputReferences]);
    expect(payloads[1]).not.toContain('The invoice needs user review.');
    expect(need(await observer.reconcile(nextQuery))?.consumedAt).toBeString();
    const before = payloads.length;
    expect(need(await observer.reconcile(f.phaseQuery))).toEqual(observed);
    expect(payloads).toHaveLength(before);
  } finally { need(await runtime.close()); server.stop(true); }
});

test('queued create stores one product attempt and fixed members without inventing a Run or native identity', async () => {
  const f = await fixture(), receipt = await f.create();
  expect(receipt).toMatchObject({ operation: 'create', personalAgentId: f.agent.personalAgentId, execution: {
    kind: 'queued', authorizationAccepted: true, relation: 'new', attempt: { runId: null, runtimeLinked: false },
  } });
  const view = await f.work(receipt.workId);
  expect(view.work).toMatchObject({ status: 'open', sessionId: receipt.sessionId, runtimeKind: 'durable',
    counts: { total: 2, unresolved: 2, accepted: 0, rejected: 0, excluded: 0 },
    execution: { queued: true, attempt: receipt.execution.attempt } });
  expect(view.items.map(item => item.documentRef)).toEqual(f.documents);
  expect(view.items.every(item => item.disposition === 'unresolved' && item.decision === null)).toBe(true);
  expect(await f.query((_repository, store) => store.db.query('SELECT COUNT(*) AS count FROM runs').get())).toEqual({ count: 0 });
  expect(await f.query((_repository, store) => store.db.query('SELECT runtime_kind,native_session_id,durable_conversation_id FROM sessions WHERE id=?')
    .get(receipt.sessionId))).toEqual({ runtime_kind: 'durable', native_session_id: null, durable_conversation_id: null });
});

test('a frozen phase assembles only its invoice, original authorized input and submitted Todo facts', async () => {
  const f = await withTodo();
  const received = need(await f.command(repository => repository.supplement(f.supplement, { at: later, admission: { kind: 'ready' } })));
  if (!received.execution.authorizationAccepted) throw Error('The input was not authorized for execution.');
  const attemptId = received.execution.attempt.attemptId;
  const current = await f.work(f.receipt.workId), item = current.items.find(value => value.itemId === f.item.itemId)!;
  const frozen = need(await f.command(repository => repository.freezePhase({ workId: current.work.workId,
    attemptId, itemId: item.itemId, requestId: 'invoice-phase-original', kind: 'prompt',
    basis: { contextSnapshotId: null, configurationRevision: 0, itemRevision: item.revision,
      documentRefs: [item.documentRef], inputIds: [received.inputId] }, at: later })));
  const remainingBudget = { modelCalls: 8, toolCalls: 8, toolFeedbackBytes: 1024, timeoutMs: 1000, childSlots: 4 };
  const input = need(await f.query(repository => repository.readContextInput({ workId: current.work.workId,
    attemptId: frozen.attemptId, requestId: frozen.requestId, remainingBudget })));
  expect(input.phase).toEqual(frozen);
  expect(input.item).toEqual(item);
  expect(input.work.counts.total).toBe(2);
  expect(input.authorizedInputs.map(value => value.request.text)).toEqual([f.supplement.text]);
  expect(input.authorizedInputs[0]?.receipt).toEqual(received);
  expect(input.todos.map(value => value.todoId)).toEqual([f.todo.todoId]);
  expect(input.historicalInputReferences).toEqual([]);
  expect(input.confirmedBusinessReferences).toEqual([]);
  expect(input.allowedTools).toEqual(configuration.tools);
  expect(input.remainingBudget).toEqual(remainingBudget);
  expect(need(await f.query(repository => repository.getPhase({ workId: current.work.workId,
    attemptId: frozen.attemptId, requestId: frozen.requestId })))).toEqual(frozen);
  expect(need(await f.query(repository => repository.getPhase({ workId: current.work.workId,
    attemptId: frozen.attemptId, requestId: 'never-submitted' })))).toBeNull();
  need(await f.command(repository => repository.cancelWork({ workId: current.work.workId,
    expectedRevision: current.work.revision, requestId: 'cancel-before-context-read' }, { at: later })));
  expect(await f.query(repository => repository.readContextInput({ workId: current.work.workId,
    attemptId: frozen.attemptId, requestId: frozen.requestId, remainingBudget }))).toMatchObject({ ok: false, error: { code: 'state_conflict' } });
  expect(need(await f.query(repository => repository.getPhase({ workId: current.work.workId,
    attemptId: frozen.attemptId, requestId: frozen.requestId })))).toEqual(frozen);
});

test('unknown original operation queries return null without creating work or execution', async () => {
  const f = await fixture();
  expect(await f.query(repository => repository.queryOperation({ operation: 'create', personalAgentId: f.agent.personalAgentId, requestId: 'not-received' })))
    .toEqual({ ok: true, data: null });
  expect(need(await f.query(repository => repository.list({ personalAgentId: f.agent.personalAgentId }))).items).toEqual([]);
  expect(await f.query((_repository, store) => store.db.query('SELECT COUNT(*) AS count FROM sessions').get())).toEqual({ count: 0 });
  expect(await f.query((_repository, store) => store.db.query('SELECT COUNT(*) AS count FROM runs').get())).toEqual({ count: 0 });
});

test('a mismatched create receipt cannot return another real Work or Session from a valid operation row', async () => {
  const f = await fixture(), original = await f.create();
  const foreign = need(await f.command(repository => repository.create({ ...f.request, requestId: 'create-another', goal: 'Another real work.' },
    { at: later, admission: { kind: 'queued' } })));
  const request = { ...f.request, requestId: 'mismatched-create' };
  const receipt = InvoiceWorkOperationReceiptSchema.parse({ ...foreign, requestId: request.requestId });
  await f.command((_repository, store) => store.db.query(`INSERT INTO invoice_work_operations
    (personal_agent_id,work_id,kind,request_id,request_json,receipt_json,received_at) VALUES(?,?,'create',?,?,?,?)`)
    .run(f.agent.personalAgentId, original.workId, request.requestId, JSON.stringify(request), JSON.stringify(receipt), receipt.receivedAt));
  const results = await Promise.all([
    f.query(repository => repository.queryOperation({ operation: 'create', personalAgentId: f.agent.personalAgentId, requestId: request.requestId })),
    f.command(repository => repository.create(request, { at: later, admission: { kind: 'ready' } })),
  ]);
  for (const result of results) expect(result).toMatchObject({ ok: false, error: { code: 'storage_corrupt' } });
  expect(await f.query((_repository, store) => store.db.query('SELECT COUNT(*) AS count FROM invoice_works').get())).toEqual({ count: 2 });
  expect(await f.query((_repository, store) => store.db.query('SELECT COUNT(*) AS count FROM invoice_work_attempts').get())).toEqual({ count: 2 });
  expect(await f.query((_repository, store) => store.db.query('SELECT COUNT(*) AS count FROM runs').get())).toEqual({ count: 0 });
});

test('a mismatched Work command receipt cannot borrow another attempt during query or identical retry', async () => {
  const f = await fixture(), original = await f.create();
  const other = need(await f.command(repository => repository.create({ ...f.request, requestId: 'create-another', goal: 'Another real work.' },
    { at: later, admission: { kind: 'queued' } })));
  if (!('attempt' in original.execution) || original.execution.attempt === null
    || !('attempt' in other.execution) || other.execution.attempt === null) throw Error('The real queued attempts are missing.');
  const otherAttemptId = other.execution.attempt.attemptId;
  const foreign = need(await f.command(repository => repository.continueWork({ workId: other.workId, requestId: 'continue-another',
    expectedRevision: other.revision, expectedAttemptId: otherAttemptId }, { at: later, admission: { kind: 'ready' } })));
  const request = { workId: original.workId, requestId: 'mismatched-continue', expectedRevision: original.revision,
    expectedAttemptId: original.execution.attempt.attemptId };
  const receipt = InvoiceWorkOperationReceiptSchema.parse({ ...foreign, requestId: request.requestId });
  await f.command((_repository, store) => store.db.query(`INSERT INTO invoice_work_operations
    (personal_agent_id,work_id,kind,request_id,request_json,receipt_json,received_at) VALUES(?,?,'continueWork',?,?,?,?)`)
    .run(f.agent.personalAgentId, original.workId, request.requestId, JSON.stringify(request), JSON.stringify(receipt), receipt.receivedAt));
  const results = await Promise.all([
    f.query(repository => repository.queryOperation({ operation: 'continueWork', workId: original.workId, requestId: request.requestId })),
    f.command(repository => repository.continueWork(request, { at: later, admission: { kind: 'ready' } })),
  ]);
  for (const result of results) expect(result).toMatchObject({ ok: false, error: { code: 'storage_corrupt' } });
  expect(await f.query((_repository, store) => store.db.query('SELECT COUNT(*) AS count FROM invoice_work_attempts').get())).toEqual({ count: 2 });
  expect(await f.query((_repository, store) => store.db.query('SELECT COUNT(*) AS count FROM runs').get())).toEqual({ count: 0 });
});

test('create retries recover the immutable receipt before new Agent CAS and reject a changed intent', async () => {
  const f = await fixture(), receipt = await f.create();
  need(await f.command((_repository, store) => store.personalAgents.update({
    personalAgentId: f.agent.personalAgentId, expectedRevision: f.agent.revision,
    configuration: { ...configuration, preferences: 'A later configuration.' }, at: later,
  })));
  const blocked = { kind: 'blocked' as const, reason: appError('provider_auth_failed', 'provider', 'Current execution is blocked.') };
  expect(await f.command(repository => repository.create(structuredClone(f.request), { at: later, admission: blocked }))).toEqual({ ok: true, data: receipt });
  expect(await f.query(repository => repository.queryOperation({ operation: 'create', personalAgentId: f.agent.personalAgentId, requestId: f.request.requestId })))
    .toEqual({ ok: true, data: receipt });
  expect(await f.command(repository => repository.create({ ...f.request, goal: 'A different goal.' }, { at: later, admission: blocked })))
    .toMatchObject({ ok: false, error: { code: 'state_conflict' } });
  expect(need(await f.query(repository => repository.list({ personalAgentId: f.agent.personalAgentId }))).items).toHaveLength(1);
  expect(await f.query((_repository, store) => store.db.query('SELECT COUNT(*) AS count FROM sessions').get())).toEqual({ count: 1 });
});

test('a committed create is recovered by its original request when the caller never received a work ID', async () => {
  const f = await fixture(), transaction = f.database.transaction;
  f.database.transaction = async operation => {
    f.database.transaction = transaction;
    await transaction(operation); throw Error('Controlled create response loss after actual COMMIT');
  };
  await expect(f.command(repository => repository.create(f.request, { at, admission: { kind: 'queued' } })))
    .rejects.toThrow('Controlled create response loss after actual COMMIT');
  const original = need(await f.query(repository => repository.queryOperation({ operation: 'create',
    personalAgentId: f.agent.personalAgentId, requestId: f.request.requestId })));
  if (original === null || original.operation !== 'create') throw Error('The original create receipt was not recovered.');
  expect(await f.command(repository => repository.create(f.request, { at: later, admission: { kind: 'ready' } })))
    .toEqual({ ok: true, data: original });
  expect(await f.query((_repository, store) => store.db.query('SELECT COUNT(*) AS count FROM invoice_works').get())).toEqual({ count: 1 });
  expect(await f.query((_repository, store) => store.db.query('SELECT COUNT(*) AS count FROM invoice_work_attempts').get())).toEqual({ count: 1 });
  expect(await f.query((_repository, store) => store.db.query('SELECT COUNT(*) AS count FROM runs').get())).toEqual({ count: 0 });
});

test('new create enforces the expected Agent revision and leaves no partial business identity', async () => {
  const f = await fixture();
  expect(await f.command(repository => repository.create({ ...f.request, expectedAgentRevision: f.agent.revision + 1 }, { at, admission: { kind: 'ready' } })))
    .toMatchObject({ ok: false, error: { code: 'state_conflict' } });
  expect(need(await f.query(repository => repository.list({ personalAgentId: f.agent.personalAgentId }))).items).toEqual([]);
  expect(await f.query((_repository, store) => store.db.query('SELECT COUNT(*) AS count FROM sessions').get())).toEqual({ count: 0 });
});

test('fixed membership can exceed a Context stage and does not grow when another document arrives', async () => {
  const f = await fixture(65), receipt = await f.create();
  await f.command((_repository, store) => registerDocument(store, 66));
  const view = await f.work(receipt.workId);
  expect(view.work.counts.total).toBe(65); expect(view.items).toHaveLength(65);
  expect(view.items.map(item => item.documentRef)).toEqual(f.documents);
  expect(view.items.some(item => item.documentRef.id === 66)).toBe(false);
});

test('cancelled work preserves its original attempt and cannot acquire a new continue authorization', async () => {
  const f = await fixture(), receipt = await f.create();
  if (!('attempt' in receipt.execution) || receipt.execution.attempt === null) throw Error('Queued creation has no product attempt.');
  const attemptId = receipt.execution.attempt.attemptId;
  const existing = need(await f.command(repository => repository.continueWork({ workId: receipt.workId,
    requestId: 'continue-original', expectedRevision: receipt.revision, expectedAttemptId: attemptId }, { at, admission: { kind: 'ready' } })));
  expect(existing.execution).toMatchObject({ kind: 'existing', authorizationAccepted: false, relation: 'original', attempt: { attemptId, runId: null } });
  const current = await f.work(receipt.workId);
  const cancelled = need(await f.command(repository => repository.cancelWork({ workId: receipt.workId, requestId: 'cancel-original', expectedRevision: current.work.revision }, { at: later })));
  expect(await f.query(repository => repository.queryOperation({ operation: 'cancelWork', workId: receipt.workId, requestId: 'cancel-original' })))
    .toEqual({ ok: true, data: cancelled });
  const continued = await f.command(repository => repository.continueWork({ workId: receipt.workId, requestId: 'continue-after-cancel',
    expectedRevision: cancelled.revision, expectedAttemptId: attemptId }, { at: later, admission: { kind: 'ready' } }));
  expect(continued.ok).toBe(false);
  if (!continued.ok) expect(continued.error.category).not.toBe('storage');
  expect((await f.work(receipt.workId)).work).toMatchObject({ status: 'cancelled', execution: { requiresContinue: false } });
  expect(await f.query((_repository, store) => store.db.query('SELECT COUNT(*) AS count FROM runs').get())).toEqual({ count: 0 });
});

test('a phase keeps its original basis and native linkage cannot rewrite admission or claim consumption', async () => {
  const f = await fixture(), receipt = await f.create({ kind: 'ready' });
  if (!('attempt' in receipt.execution) || receipt.execution.attempt === null) throw Error('Ready creation has no product attempt.');
  const item = (await f.work(receipt.workId)).items[0]!;
  const input = { workId: receipt.workId, attemptId: receipt.execution.attempt.attemptId, itemId: item.itemId,
    requestId: 'fixed-phase', kind: 'prompt' as const, at,
    basis: { contextSnapshotId: null, inputIds: [], documentRefs: [item.documentRef], configurationRevision: f.agent.revision, itemRevision: item.revision } };
  const phase = need(await f.command(repository => repository.freezePhase(input)));
  expect(phase).toMatchObject({ workId: receipt.workId, attemptId: input.attemptId, itemId: item.itemId, basis: input.basis,
    nativeConversationId: null, nativeSubmissionId: null, consumedAt: null });
  expect(await f.command(repository => repository.freezePhase({ ...input, at: later }))).toEqual({ ok: true, data: phase });
  expect(await f.command(repository => repository.freezePhase({ ...input,
    basis: { ...input.basis, documentRefs: [{ ...item.documentRef, version: 'another-version' }] } })))
    .toMatchObject({ ok: false, error: { code: 'state_conflict' } });
  need(await f.command((_repository, store) => store.sessions.bindDurableConversation(receipt.sessionId, 41, later)));
  const linked = need(await f.command(repository => repository.linkPhase({ workId: receipt.workId, attemptId: input.attemptId,
    phaseId: phase.phaseId, nativeConversationId: 41, nativeSubmissionId: 101, at: later })));
  expect(linked).toMatchObject({ phaseId: phase.phaseId, basis: input.basis, nativeConversationId: 41, nativeSubmissionId: 101, consumedAt: null });
  expect(await f.query(repository => repository.queryOperation({ operation: 'create', personalAgentId: f.agent.personalAgentId, requestId: f.request.requestId })))
    .toEqual({ ok: true, data: receipt });
});

test('supplement persists the original Todo input and immutable authorization separately from native linkage', async () => {
  const f = await withTodo(), material = await f.command((_repository, store) => registerDocument(store, 3));
  const request = { ...f.supplement, materials: [material] };
  const saved = need(await f.command(repository => repository.supplement(request, { at: later, admission: { kind: 'ready' } })));
  const original = structuredClone(saved);
  expect(saved).toMatchObject({ operation: 'supplement', saved: true, itemId: f.item.itemId, todoId: f.todo.todoId,
    execution: { authorizationAccepted: true, relation: 'original', attempt: { runId: null, runtimeLinked: false } } });
  expect(await f.query((_repository, store) => store.db.query('SELECT item_id,todo_id,text,materials_json FROM invoice_work_inputs WHERE id=?').get(saved.inputId)))
    .toEqual({ item_id: f.item.itemId, todo_id: f.todo.todoId, text: request.text, materials_json: JSON.stringify([material]) });
  const itemView = need(await f.query(repository => repository.get({ view: 'item', workId: saved.workId, itemId: f.item.itemId })));
  if (itemView.view !== 'item') throw Error('The item query returned another view.');
  expect(itemView.item.latestInputId).toBe(saved.inputId);
  expect(itemView.todos).toMatchObject([{ todoId: f.todo.todoId, applicable: true, problem: f.definition.problem }]);
  expect(itemView.work.counts.total).toBe(2);
  if (!('attempt' in saved.execution) || saved.execution.attempt === null) throw Error('The supplement lost its original attempt.');
  const attemptId = saved.execution.attempt.attemptId;
  const phase = need(await f.command(repository => repository.freezePhase({ workId: saved.workId,
    attemptId, itemId: f.item.itemId, requestId: 'supplement-phase', kind: 'prompt', at: later,
    basis: { contextSnapshotId: null, inputIds: [saved.inputId], documentRefs: [f.item.documentRef, material],
      configurationRevision: f.agent.revision, itemRevision: itemView.item.revision } })));
  const linked = need(await f.command(repository => repository.linkPhase({ workId: saved.workId,
    attemptId: phase.attemptId, phaseId: phase.phaseId, nativeConversationId: 51, nativeSubmissionId: 101, at: later })));
  expect(linked.consumedAt).toBeNull();
  expect(await f.query(repository => repository.queryOperation({ operation: 'supplement', workId: saved.workId, requestId: saved.requestId })))
    .toEqual({ ok: true, data: original });
  expect(await f.command(repository => repository.supplement(request, { at: later,
    admission: { kind: 'blocked', reason: appError('provider_auth_failed', 'provider', 'A later execution blocker.') } })))
    .toEqual({ ok: true, data: original });
  expect(await f.query((_repository, store) => store.db.query('SELECT COUNT(*) AS count FROM invoice_work_inputs').get())).toEqual({ count: 1 });
});

test('saved-only supplement receipts cannot silently become accepted execution authorization', async () => {
  const f = await withTodo();
  const saved = need(await f.command(repository => repository.supplement(f.supplement, { at: later,
    admission: { kind: 'blocked', reason: appError('provider_auth_failed', 'provider', 'Credentials are unavailable.') } })));
  expect(saved).toMatchObject({ saved: true, execution: { kind: 'blocked', authorizationAccepted: false,
    reason: { code: 'provider_auth_failed' } } });
  expect(await f.command(repository => repository.supplement(f.supplement, { at: later, admission: { kind: 'ready' } })))
    .toEqual({ ok: true, data: saved });
  expect(await f.query(repository => repository.queryOperation({ operation: 'supplement', workId: saved.workId, requestId: saved.requestId })))
    .toEqual({ ok: true, data: saved });
  expect(await f.query((_repository, store) => store.db.query('SELECT COUNT(*) AS count FROM invoice_work_attempts').get())).toEqual({ count: 1 });
  expect(await f.query((_repository, store) => store.db.query('SELECT COUNT(*) AS count FROM runs').get())).toEqual({ count: 0 });
});

test('saved-only input needs a separately accepted continue operation before phase authorization', async () => {
  const f = await withTodo(), material = await f.command((_repository, store) => registerDocument(store, 3));
  const saved = need(await f.command(repository => repository.supplement({ ...f.supplement, materials: [material] }, { at: later,
    admission: { kind: 'blocked', reason: appError('provider_auth_failed', 'provider', 'Credentials are unavailable.') } })));
  expect(saved.execution.authorizationAccepted).toBe(false);
  if (!('attempt' in f.receipt.execution) || f.receipt.execution.attempt === null) throw Error('The original queued attempt is missing.');
  const attemptId = f.receipt.execution.attempt.attemptId;
  const itemView = need(await f.query(repository => repository.get({ view: 'item', workId: saved.workId, itemId: f.item.itemId })));
  if (itemView.view !== 'item') throw Error('The item query returned another view.');
  const phaseInput = { workId: saved.workId, attemptId, itemId: f.item.itemId, requestId: 'blocked-input-phase',
    kind: 'prompt' as const, at: later, basis: { contextSnapshotId: null, inputIds: [saved.inputId],
      documentRefs: [f.item.documentRef, material], configurationRevision: f.agent.revision, itemRevision: itemView.item.revision } };
  const refused = await f.command(repository => repository.freezePhase(phaseInput));
  expect(refused.ok).toBe(false); if (!refused.ok) expect(refused.error.category).toBe('input');
  const unboundMaterial = await f.command(repository => repository.freezePhase({ ...phaseInput, requestId: 'blocked-material-phase',
    basis: { ...phaseInput.basis, inputIds: [] } }));
  expect(unboundMaterial.ok).toBe(false); if (!unboundMaterial.ok) expect(unboundMaterial.error.category).toBe('input');
  expect(await f.query((_repository, store) => store.db.query('SELECT COUNT(*) AS count FROM invoice_work_phases').get())).toEqual({ count: 0 });
  const continued = need(await f.command(repository => repository.continueWork({ workId: saved.workId,
    requestId: 'continue-saved-input', expectedRevision: saved.revision, expectedAttemptId: attemptId }, { at: later, admission: { kind: 'ready' } })));
  expect(continued.execution).toMatchObject({ authorizationAccepted: true, relation: 'original', attempt: { attemptId } });
  const allowed = need(await f.command(repository => repository.freezePhase({ ...phaseInput, requestId: 'accepted-continue-phase' })));
  expect(allowed.basis.inputIds).toEqual([saved.inputId]); expect(allowed.consumedAt).toBeNull();
  expect(await f.query(repository => repository.queryOperation({ operation: 'supplement', workId: saved.workId, requestId: saved.requestId })))
    .toEqual({ ok: true, data: saved });
  expect(await f.query((_repository, store) => store.db.query('SELECT COUNT(*) AS count FROM invoice_work_attempts').get())).toEqual({ count: 1 });
});

test('supplement rejects stale material versions and another item Todo without saving half an operation', async () => {
  const f = await withTodo(), other = (await f.work(f.receipt.workId)).items.find(item => item.itemId !== f.item.itemId)!;
  expect(await f.command(repository => repository.supplement({ ...f.supplement,
    materials: [{ ...f.item.documentRef, version: 'stale-version' }] }, { at: later, admission: { kind: 'ready' } })))
    .toMatchObject({ ok: false, error: { code: 'input_unavailable' } });
  const misplaced = await f.command(repository => repository.supplement({ ...f.supplement, itemId: other.itemId }, { at: later, admission: { kind: 'ready' } }));
  expect(misplaced.ok).toBe(false); if (!misplaced.ok) expect(misplaced.error.category).toBe('input');
  expect(await f.query((_repository, store) => store.db.query('SELECT COUNT(*) AS count FROM invoice_work_inputs').get())).toEqual({ count: 0 });
  expect(await f.query(repository => repository.queryOperation({ operation: 'supplement', workId: f.receipt.workId, requestId: f.supplement.requestId })))
    .toEqual({ ok: true, data: null });
});

test('supplement rejects a stale Work revision and remains closed after cancellation', async () => {
  const f = await withTodo();
  expect(await f.command(repository => repository.supplement({ ...f.supplement, expectedRevision: f.receipt.revision },
    { at: later, admission: { kind: 'ready' } }))).toMatchObject({ ok: false, error: { code: 'state_conflict' } });
  const cancelled = need(await f.command(repository => repository.cancelWork({ workId: f.receipt.workId,
    requestId: 'cancel-before-supplement', expectedRevision: f.supplement.expectedRevision }, { at: later })));
  const ended = await f.command(repository => repository.supplement({ ...f.supplement, expectedRevision: cancelled.revision },
    { at: later, admission: { kind: 'ready' } }));
  expect(ended.ok).toBe(false); if (!ended.ok) expect(ended.error.category).toBe('input');
  expect(await f.query((_repository, store) => store.db.query('SELECT COUNT(*) AS count FROM invoice_work_inputs').get())).toEqual({ count: 0 });
});

test('Todo applicability and counts follow current material evidence without changing stored definitions or execution', async () => {
  for (const change of ['version', 'parsed-artifact'] as const) {
    const f = await withTodo();
    const definition = { ...f.definition, basis: { ...f.definition.basis, sourceRefs: [{
      documentId: f.item.documentRef.id, version: f.item.documentRef.version, artifactId: f.item.documentRef.id * 2, page: 1, blockId: 'b1',
    }] } };
    const current = need(await f.command(repository => repository.replaceTodos({ workId: f.receipt.workId,
      itemId: f.item.itemId, expectedRevision: f.item.revision, todos: [definition], at: later })))[0]!;
    await f.command((_repository, store) => {
      if (change === 'version') return store.db.query('UPDATE documents SET version=? WHERE id=?').run('v2', f.item.documentRef.id);
      const replacement = store.db.query("INSERT INTO artifacts(kind,relative_path,bytes,mime_type,metadata_json,created_at) SELECT kind,relative_path||'.replacement',bytes,mime_type,metadata_json,created_at FROM artifacts WHERE id=?")
        .run(f.item.documentRef.id * 2);
      return store.db.query('UPDATE documents SET parsed_artifact_id=? WHERE id=?').run(Number(replacement.lastInsertRowid), f.item.documentRef.id);
    });
    const before = await f.query((_repository, store) => store.db.query('SELECT total_changes() AS count').get());
    const view = need(await f.query(repository => repository.get({ view: 'item', workId: f.receipt.workId, itemId: f.item.itemId })));
    if (view.view !== 'item') throw Error('Expected the original invoice item.');
    expect(view.todos.find(todo => todo.todoId === current.todoId)).toMatchObject({ applicable: false, problem: definition.problem });
    expect(view.item.todoCount).toBe(0); expect(view.item.disposition).toBe('unresolved'); expect(view.work.status).toBe('open');
    expect(await f.query((_repository, store) => store.db.query('SELECT total_changes() AS count').get())).toEqual(before);
    expect(await f.query((_repository, store) => store.db.query('SELECT definition_json FROM invoice_work_todos WHERE id=?').get(current.todoId)))
      .toEqual({ definition_json: JSON.stringify(definition) });
  }
});

test('replacing Todos preserves the original definition and rejects supplements addressed to the superseded Todo', async () => {
  const f = await withTodo();
  const next = need(await f.command(repository => repository.replaceTodos({ workId: f.receipt.workId,
    itemId: f.item.itemId, expectedRevision: f.item.revision,
    todos: [{ ...f.definition, problem: 'A later qualified question.' }], at: later })));
  expect(next).toHaveLength(1); expect(next[0]!.todoId).not.toBe(f.todo.todoId);
  const original = await f.query((_repository, store) => store.db.query<{ definition_json: string; superseded_at: string | null }, [number]>(
    'SELECT definition_json,superseded_at FROM invoice_work_todos WHERE id=?').get(f.todo.todoId));
  if (!original) throw Error('The original Todo definition was deleted.');
  expect(JSON.parse(original.definition_json)).toEqual(f.definition); expect(original.superseded_at).toBe(later);
  const view = await f.work(f.receipt.workId);
  const refused = await f.command(repository => repository.supplement({ ...f.supplement, expectedRevision: view.work.revision },
    { at: later, admission: { kind: 'ready' } }));
  expect(refused.ok).toBe(false); if (!refused.ok) expect(refused.error.category).toBe('input');
  expect(await f.query((_repository, store) => store.db.query('SELECT COUNT(*) AS count FROM invoice_work_inputs').get())).toEqual({ count: 0 });
});

test('a supplement receipt failure rolls back its input, authorization and business revisions together', async () => {
  const f = await withTodo(), before = await f.work(f.receipt.workId);
  const todos = need(await f.query(repository => repository.get({ view: 'item', workId: f.receipt.workId, itemId: f.item.itemId })));
  await f.command((_repository, store) => store.db.exec("CREATE TRIGGER reject_supplement_receipt BEFORE INSERT ON invoice_work_operations WHEN NEW.kind='supplement' BEGIN SELECT RAISE(ABORT,'controlled supplement receipt failure'); END;"));
  expect(await f.command(repository => repository.supplement(f.supplement, { at: later, admission: { kind: 'ready' } })))
    .toMatchObject({ ok: false, error: { code: 'storage_write_failed' } });
  expect(await f.work(f.receipt.workId)).toEqual(before);
  expect(await f.query(repository => repository.get({ view: 'item', workId: f.receipt.workId, itemId: f.item.itemId })))
    .toEqual({ ok: true, data: todos });
  expect(await f.query(repository => repository.queryOperation({ operation: 'supplement', workId: f.receipt.workId, requestId: f.supplement.requestId })))
    .toEqual({ ok: true, data: null });
  expect(await f.query((_repository, store) => store.db.query('SELECT COUNT(*) AS count FROM invoice_work_inputs').get())).toEqual({ count: 0 });
  expect(await f.query((_repository, store) => store.db.query('SELECT COUNT(*) AS count FROM invoice_work_attempts').get())).toEqual({ count: 1 });
});
