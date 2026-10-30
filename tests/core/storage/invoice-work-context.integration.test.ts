import { expect, test } from 'bun:test';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createRequire } from 'node:module';
import { readFileSync } from 'node:fs';
import { appError, ok, DurableRunConfigSnapshotSchema, DurableWorkBudgetSchema, PersonalAgentConfigurationSchema,
  type DocumentRef, type ProviderConfig, type Result, type UsageRecord } from '@flowmate/contracts';
import type { InvoiceWorkWorkingContext } from '../../../packages/contracts/src/personal-context.ts';
import type { SqlDatabaseStore } from '../../../packages/core/src/storage/database.ts';
import { createInvoiceWorkContextRepository } from '../../../packages/core/src/personal-agent/context-repository.ts';
import { InvoiceWorkPhaseContextService, InvoiceWorkPhaseObserver } from '../../../packages/core/src/personal-agent/phase-context.ts';
import { DurableInvoiceGovernor } from '../../../packages/core/src/personal-agent/admission.ts';
import { InvoiceWorkService } from '../../../packages/core/src/personal-agent/invoice-work.ts';
import { resolveInvoiceWorkToolScope, verifyInvoiceWorkToolScope } from '../../../packages/core/src/personal-agent/tool-scope.ts';
import { buildInvoiceWorkContext } from '../../../packages/runtime-durable/src/context.ts';
import { createDurableRuntime } from '../../../packages/runtime-durable/src/runtime.ts';
import { createDurableSqliteStorage } from '../../../packages/runtime-durable/src/storage.ts';
import { openTestDatabase } from '../../support/database.ts';
import { mkdtempSync } from '../../support/resources.ts';

const at = '2026-10-29T00:00:00.000Z', phaseAt = '2026-10-29T00:01:00.000Z', later = '2026-10-29T00:02:00.000Z';
const remainingBudget = { modelCalls: 2, toolCalls: 4, toolFeedbackBytes: 4096, timeoutMs: 30000, childSlots: 1 };
function need<T>(value: Result<T>): T { if (!value.ok) throw Error(value.error.code); return value.data; }
function key(context: InvoiceWorkWorkingContext) {
  return { workId: context.work.workId, attemptId: context.phase.attemptId, requestId: context.phase.requestId };
}
function registerDocument(scope: SqlDatabaseStore, documentId: number): DocumentRef {
  const originalId = documentId * 2 - 1, parsedId = documentId * 2;
  const metadata = { version: 1 as const, sourceKey: 'invoice-work-context', sourceRecordId: `document-${documentId}`, sourceVersion: 'v1' };
  need(scope.documents.register({ documentId, sourceKey: metadata.sourceKey, sourceRecordId: metadata.sourceRecordId, version: 'v1',
    originalArtifact: { artifactId: originalId, kind: 'original', relativePath: `artifacts/${originalId}/original.pdf`, bytes: 1,
      mimeType: 'application/pdf', metadata: { ...metadata, files: [{ relativePath: 'original.pdf', bytes: 1, mimeType: 'application/pdf' }] }, createdAt: at },
    parsedArtifact: { artifactId: parsedId, kind: 'parsed', relativePath: `artifacts/${parsedId}/parsed.json`, bytes: 1,
      mimeType: 'application/json', metadata: { ...metadata, files: [{ relativePath: 'parsed.json', bytes: 1, mimeType: 'application/json' }] }, createdAt: at },
    status: 'available', metadata: { version: 2, pageCount: 1, warnings: [], allowedUsesClaim: ['Controlled phase snapshot storage fixture'],
      licenseVerification: 'not_verified', unavailableReason: null }, createdAt: at, updatedAt: at }));
  return { id: documentId, version: 'v1' };
}

async function fixture(options: { time: { at: string; phaseAt: string }; modelId: string | null; tools: string[] }
  = { time: { at, phaseAt }, modelId: null, tools: [] }) {
  const { at, phaseAt } = options.time;
  const root = mkdtempSync(join(tmpdir(), 'flowmate-invoice-work-context-'));
  const paths = { root, databaseFile: join(root, 'data/app.sqlite'), artifactsDir: join(root, 'artifacts'),
    runtimeDir: join(root, 'runtime'), logsDir: join(root, 'logs'), outputsDir: join(root, 'outputs') };
  const database = need(openTestDatabase(paths));
  const configuration = PersonalAgentConfigurationSchema.parse({ modelId: options.modelId, thinkingLevel: 'off',
    resources: { prompt: null, enabledSkills: [] }, extensions: { enabledExtensions: [] }, tools: options.tools, workingDirectory: null, preferences: '' });
  const seeded = await database.transaction(scope => ({
    agent: need(scope.personalAgents.ensureDefault(configuration, at)),
    documents: [registerDocument(scope, 1), registerDocument(scope, 2)],
  }));
  const created = need(await database.transaction(scope => scope.invoiceWorks.create({ personalAgentId: seeded.agent.personalAgentId,
    expectedAgentRevision: seeded.agent.revision, requestId: 'create-context-work', goal: 'Review this original fixed invoice.',
    documents: [seeded.documents[0]!] }, { at, admission: { kind: 'queued' } })));
  const item = need(await database.read(scope => scope.invoiceWorks.get({ view: 'work', workId: created.workId, limit: 100 })));
  if (item.view !== 'work' || !item.items[0]) throw Error('The real Work did not produce its fixed member.');
  const itemId = item.items[0].itemId;
  const job = need(await database.transaction(scope => scope.invoiceWorks.prepareItemJob({ workId: created.workId,
    itemId, expectedRevision: item.items[0]!.revision, at })));
  const current = need(await database.read(scope => scope.invoiceWorks.get({ view: 'item', workId: created.workId, itemId })));
  if (current.view !== 'item') throw Error('Expected the original item view.');
  const todos = need(await database.transaction(scope => scope.invoiceWorks.replaceTodos({ workId: created.workId, itemId,
    expectedRevision: current.item.revision, at, todos: [{ actor: 'user', fieldPath: null, problem: 'Model reports missing seller details.',
      needed: 'Supply the original clarification.', satisfiedBy: 'The original input is recorded.', action: 'supplement',
      basis: { origin: 'model', documentRefs: [seeded.documents[0]!], sourceRefs: [], inputIds: [], candidateRef: null } }] })));
  const updated = need(await database.read(scope => scope.invoiceWorks.get({ view: 'item', workId: created.workId, itemId })));
  if (updated.view !== 'item' || !todos[0]) throw Error('The real Todo was not produced.');
  const supplement = need(await database.transaction(scope => scope.invoiceWorks.supplement({ workId: created.workId, itemId,
    todoId: todos[0]!.todoId, requestId: 'original-input', expectedRevision: updated.work.revision,
    text: '  This is the original user clarification.  ', materials: [seeded.documents[1]!] }, { at, admission: { kind: 'queued' } })));
  const construct = (scope: SqlDatabaseStore, requestId = 'original-prompt') => {
    const facts = need(scope.invoiceWorks.get({ view: 'item', workId: created.workId, itemId }));
    if (facts.view !== 'item' || !facts.work.execution.attempt) throw Error('The original attempt is unavailable.');
    const phase = need(scope.invoiceWorks.freezePhase({ workId: created.workId, attemptId: facts.work.execution.attempt.attemptId,
      itemId, requestId, kind: 'prompt', basis: { contextSnapshotId: null, inputIds: [supplement.inputId],
        documentRefs: seeded.documents, configurationRevision: seeded.agent.revision, itemRevision: facts.item.revision }, at: phaseAt }));
    return need(buildInvoiceWorkContext(need(scope.invoiceWorks.readContextInput({ workId: created.workId,
      attemptId: phase.attemptId, requestId, remainingBudget }))));
  };
  const freeze = () => database.transaction(scope => construct(scope));
  const save = (context: InvoiceWorkWorkingContext) => database.transaction(scope =>
    createInvoiceWorkContextRepository(scope.db).save({ context, at: phaseAt }));
  const count = () => database.read(scope => scope.db.query<{ count: number }, []>(
    'SELECT COUNT(*) count FROM invoice_work_context_snapshots').get()!.count);
  return { database, paths, configuration, ...seeded, created, itemId, job, supplement, construct, freeze, save, count };
}

test('explicit continue reuses a still-needed clarification after real model consumption and failure without consuming it again', async () => {
  const now = () => new Date().toISOString(), startedAt = now();
  const f = await fixture({ time: { at: startedAt, phaseAt: startedAt }, modelId: 'history-model', tools: ['read_invoice_document'] });
  const requests: string[] = [];
  const server = Bun.serve({ port: 0, fetch: async request => {
    requests.push(JSON.stringify(await request.json()));
    if (requests.length === 2) return new Response(JSON.stringify({ error: { message: 'Failure before saving the candidate or updating the Todo.' } }), { status: 503 });
    const first = requests.length === 1;
    const delta = first ? { role: 'assistant', tool_calls: [{ index: 0, id: 'read-before-failure', type: 'function',
      function: { name: 'read_invoice_document', arguments: '{"documentId":1}' } }] }
      : { role: 'assistant', content: 'The original clarification remains available for this invoice.' };
    const chunk = { id: 'history-response', object: 'chat.completion.chunk', created: 1, model: 'history-model',
      choices: [{ index: 0, delta, finish_reason: first ? 'tool_calls' : 'stop' }] };
    return new Response(`data: ${JSON.stringify(chunk)}\n\ndata: [DONE]\n\n`, { headers: { 'content-type': 'text/event-stream' } });
  } });
  const provider: ProviderConfig = { version: 1, name: 'history-model', revision: 1,
    modelRef: { provider: 'controlled-history', model: 'history-model' }, native: { authPath: 'unused-auth.json', modelsPath: null },
    connection: { api: 'openai-completions', baseUrl: `http://127.0.0.1:${server.port}/v1`, contextWindow: 64000, maxTokens: 8192 },
    parameters: { maxRetries: 0, maxRetryDelayMs: 1000 } };
  const requireRuntime = createRequire(new URL('../../../packages/runtime-durable/package.json', import.meta.url));
  const installed = (name: string): string => JSON.parse(readFileSync(requireRuntime.resolve(`${name}/package.json`), 'utf8')).version;
  const sdk = { durable: installed('@earendil-works/pi-durable'), ai: installed('@earendil-works/pi-ai'), chord: installed('@earendil-works/chord') };
  const governor = new DurableInvoiceGovernor(f.database, now, () => false);
  const service = new InvoiceWorkService({ database: f.database, now, assessExecution: command => governor.assess(command), onChanged: () => {} });
  const contexts = new InvoiceWorkPhaseContextService({ database: f.database, now, buildContext: buildInvoiceWorkContext });
  const start = (attemptId: number) => f.database.transaction(scope => {
    const budget = DurableWorkBudgetSchema.parse(JSON.parse(scope.db.query<{ budget_json: string }, [number]>(
      'SELECT budget_json FROM invoice_works WHERE id=?').get(f.created.workId)!.budget_json));
    const config = DurableRunConfigSnapshotSchema.parse({ version: 3, runtimeKind: 'durable', name: provider.name, revision: provider.revision,
      requestedModel: provider.modelRef, resolvedModel: null, api: provider.connection!.api, endpoint: provider.connection!.baseUrl, sdk,
      parameters: provider.parameters, ...budget, durable: { workId: f.created.workId, attemptId, configurationRevision: f.agent.revision },
      resources: f.configuration.resources, extensions: f.configuration.extensions, workingDirectory: null });
    const usage: UsageRecord = { version: 1, source: 'not-requested', reason: 'not-started', sdkValues: null,
      attempts: 0, attemptsComplete: true, costSource: null, updatedAt: now() };
    const runId = need(scope.runs.createDurable({ workId: f.created.workId, attemptId, config, usage,
      cleanup: { version: 1, stopped: false, stopReason: null, errors: [], lateObservationRequired: false },
      input: { version: 1, goal: original.work.goal, text: original.work.goal, messageTimestamp: Date.now() }, createdAt: now() }));
    need(scope.runs.start(runId, config, now())); return runId;
  });
  const original = await f.database.transaction(scope => {
    const context = f.construct(scope); return need(scope.invoiceWorkContexts.save({ context, at: now() })).context;
  });
  const foreignInvoice = await f.database.transaction(scope => {
    const foreignDocument = registerDocument(scope, 3);
    const foreign = need(scope.invoiceWorks.create({ personalAgentId: f.agent.personalAgentId, expectedAgentRevision: f.agent.revision,
      requestId: 'other-invoice-work', goal: 'A separate invoice must not leak into this phase.', documents: [foreignDocument] },
    { at: now(), admission: { kind: 'queued' } }));
    const page = need(scope.invoiceWorks.get({ view: 'work', workId: foreign.workId }));
    if (page.view !== 'work' || !page.items[0]) throw Error('Expected the other invoice.');
    const todo = need(scope.invoiceWorks.replaceTodos({ workId: foreign.workId, itemId: page.items[0].itemId,
      expectedRevision: page.items[0].revision, at: now(), todos: [{ actor: 'user', fieldPath: null,
        problem: 'Other invoice question.', needed: 'Other invoice explanation.', satisfiedBy: 'Its own explanation is supplied.', action: 'supplement',
        basis: { origin: 'user', documentRefs: [foreignDocument], sourceRefs: [], inputIds: [], candidateRef: null } }] }))[0]!;
    const current = need(scope.invoiceWorks.get({ view: 'work', workId: foreign.workId }));
    need(scope.invoiceWorks.supplement({ workId: foreign.workId, itemId: todo.itemId, todoId: todo.todoId,
      requestId: 'other-invoice-private-input', expectedRevision: current.work.revision, text: 'PRIVATE-OTHER-INVOICE-CLARIFICATION', materials: [] },
    { at: now(), admission: { kind: 'waiting', reason: 'Only this other invoice needs its own later action.' } }));
    return { workId: foreign.workId, sessionId: foreign.sessionId, documentRef: foreignDocument };
  });
  const owner = { workId: f.created.workId, sessionId: f.created.sessionId, attemptId: original.phase.attemptId };
  const firstRunId = await start(owner.attemptId), first = { ...owner, requestId: original.phase.requestId };
  const runtime = need(await createDurableRuntime({ storage: await createDurableSqliteStorage(f.database.coordinator),
    readApiKey: () => 'controlled-history-key', verifyModelUse: identity => governor.verifyModelUse(identity),
    reserveModelRequest: identity => governor.reserveModelRequest(identity), readWorkingContext: query => contexts.get(query),
    verifyWorkingContext: query => contexts.verify(query), tools: [{ name: 'read_invoice_document', description: 'Read this invoice before preparing its candidate.',
      executionMode: 'parallel', inputSchema: { type: 'object', properties: { documentId: { type: 'integer' } }, required: ['documentId'], additionalProperties: false } }],
    executeTool: () => ok({ status: 'succeeded', data: { documentId: 1 } }), readToolResult: () => ok(null) }));
  try {
    need(await runtime.openConversation({ workId: owner.workId, sessionId: owner.sessionId }));
    need(await runtime.submit({ ...first, text: 'Process this saved invoice clarification.', config: provider }));
    expect(need(await runtime.waitForSubmission(first)).status).toBe('unanswered');
    const observer = new InvoiceWorkPhaseObserver({ database: f.database, runtime, now });
    const consumed = need(await observer.reconcile(first));
    expect(consumed?.consumedAt).toBeString(); expect(requests).toHaveLength(2);
    const stopped = need(await runtime.stopAttempt({ ...owner, stopGraceMs: 1000 })); expect(stopped.stopped).toBe(true);
    const run = need(await f.database.read(scope => scope.runs.get(firstRunId))), endedAt = now();
    need(await f.database.transaction(scope => scope.runs.finish(firstRunId, { status: 'failed', output: null,
      error: appError('agent_failed', 'runtime', 'The actual next model request failed before the business write.'), usage: run.usage, tokens: run.tokens,
      cleanup: { version: 1, stopped: true, stopReason: 'confirmed-native-stop', errors: [], lateObservationRequired: false }, endedAt, stoppedAt: endedAt,
      durationMs: Date.parse(endedAt) - Date.parse(run.startedAt!) })));
    expect(need(await f.database.transaction(scope => scope.invoiceWorkAttempts.finish({ workId: owner.workId, attemptId: owner.attemptId, runId: firstRunId,
      at: now(), effectsReconciled: true, stopResult: stopped })))).toMatchObject({ closed: true });
    const before = need(await f.database.read(scope => scope.invoiceWorks.get({ view: 'item', workId: owner.workId, itemId: f.itemId })));
    if (before.view !== 'item') throw Error('Expected the original invoice Todo.');
    expect(before.todos).toMatchObject([{ todoId: f.supplement.todoId, actor: 'user' }]);
    expect(before.item.candidateRef).toBeNull();
    expect(need(await governor.assess(owner.workId)).kind).toBe('waiting');
    const continued = need(await service.continueWork({ workId: owner.workId, requestId: 'explicit-history-continue',
      expectedRevision: before.work.revision, expectedAttemptId: owner.attemptId }));
    expect(continued.execution).toMatchObject({ authorizationAccepted: true, relation: 'new' });
    if (!continued.execution.attempt) throw Error('Expected the explicitly authorized successor.');
    const next = { ...owner, attemptId: continued.execution.attempt.attemptId, requestId: 'history-successor-phase' };
    expect(next.attemptId).not.toBe(owner.attemptId); expect(need(await governor.assess(owner.workId)).kind).toBe('ready');
    const nextRunId = await start(next.attemptId);
    const freezeInput = { workId: next.workId, attemptId: next.attemptId, requestId: next.requestId,
      itemId: f.itemId, kind: 'prompt', basis: { contextSnapshotId: null,
      inputIds: [], documentRefs: f.documents, configurationRevision: f.agent.revision, itemRevision: before.item.revision }, remainingBudget } as const;
    await f.database.transaction(scope => scope.db.query("UPDATE documents SET version='v2' WHERE id=2").run());
    expect(await contexts.freeze(freezeInput)).toMatchObject({ ok: false, error: { code: 'input_unavailable' } });
    await f.database.transaction(scope => scope.db.query("UPDATE documents SET version='v1' WHERE id=2").run());
    const draft = await f.database.transaction(scope => {
      const { remainingBudget: _remainingBudget, ...phaseInput } = freezeInput;
      need(scope.invoiceWorks.freezePhase({ ...phaseInput, at: now() }));
      return need(buildInvoiceWorkContext(need(scope.invoiceWorks.readContextInput({ ...next, remainingBudget }))));
    });
    const rewritten = { ...draft, historicalInputReferences: draft.historicalInputReferences.map(value => ({ ...value,
      content: { provenance: 'user-provided' as const, text: 'Invented replacement for the original clarification.', documentRefs: [f.documents[1]!] } })) };
    expect(await f.database.transaction(scope => scope.invoiceWorkContexts.save({ context: rewritten, at: now() })))
      .toMatchObject({ ok: false, error: { code: 'source_invalid' } });
    const snapshot = need(await contexts.freeze(freezeInput));
    expect(snapshot.context.userInputs).toEqual([]); expect(snapshot.context.phase.basis.inputIds).toEqual([]);
    expect(snapshot.context.historicalInputReferences).toMatchObject([{ inputId: f.supplement.inputId,
      attemptId: owner.attemptId, content: { provenance: 'user-provided', text: '  This is the original user clarification.  ', documentRefs: [f.documents[1]] } }]);
    const toolIdentity = { ...next, runId: nextRunId };
    const resolved = need(await f.database.read(scope => resolveInvoiceWorkToolScope(scope.db, toolIdentity)));
    expect(resolved.scope.allowedDocumentIds).toEqual([1, 2]);
    expect(resolved.scope.allowedArtifactIds).toEqual([1, 2, 3, 4]);
    expect(resolved.scope.allowedDocumentIds).not.toContain(foreignInvoice.documentRef.id);
    expect(await f.database.read(scope => verifyInvoiceWorkToolScope(scope.db, { runId: nextRunId, sessionId: next.sessionId,
      scope: { ...resolved.scope, allowedDocumentIds: [...resolved.scope.allowedDocumentIds, foreignInvoice.documentRef.id] } })))
      .toMatchObject({ ok: false, error: { code: 'tool_access_denied' } });
    expect(await f.database.read(scope => resolveInvoiceWorkToolScope(scope.db,
      { ...toolIdentity, workId: foreignInvoice.workId, sessionId: foreignInvoice.sessionId })))
      .toMatchObject({ ok: false, error: { code: 'tool_access_denied' } });
    await f.database.transaction(scope => scope.db.query("UPDATE documents SET version='v2' WHERE id=2").run());
    expect(await f.database.read(scope => resolveInvoiceWorkToolScope(scope.db, toolIdentity)))
      .toMatchObject({ ok: false, error: { code: 'input_unavailable' } });
    await f.database.transaction(scope => scope.db.query("UPDATE documents SET version='v1' WHERE id=2").run());
    need(await runtime.submit({ ...next, text: 'Continue the original invoice with its still-needed clarification.', config: provider }));
    expect(need(await runtime.waitForSubmission(next)).status).toBe('done');
    expect(requests).toHaveLength(3); expect(requests[2]).toContain('This is the original user clarification.');
    expect(requests[2]).not.toContain('read-before-failure');
    expect(JSON.stringify(requests)).not.toContain('PRIVATE-OTHER-INVOICE-CLARIFICATION');
    expect(need(await observer.reconcile(next))?.consumedAt).toBeString();
    expect(need(await governor.assess(owner.workId)).kind).toBe('waiting');
    expect(need(await f.database.read(scope => scope.invoiceWorks.getPhase(first)))).toEqual(consumed);
    expect(need(await f.database.read(scope => scope.invoiceWorks.queryOperation({ operation: 'supplement', workId: owner.workId,
      requestId: f.supplement.requestId })))).toEqual(f.supplement);
    expect(need(await f.database.read(scope => scope.runs.get(firstRunId))).status).toBe('failed');
    expect(await f.database.read(scope => scope.db.query('SELECT COUNT(*) count FROM invoice_candidates').get())).toEqual({ count: 0 });
  } finally { need(await runtime.close()); server.stop(true); await f.database.close(); }
}, 15_000);

test('a real product phase and its bounded working context commit together and survive reopening without Pi identities', async () => {
  const f = await fixture();
  const frozen = await f.database.transaction(scope => {
    const context = f.construct(scope);
    return need(createInvoiceWorkContextRepository(scope.db).save({ context, at: phaseAt }));
  });
  expect(frozen.context).toMatchObject({ runtimeKind: 'durable', inputUse: 'phase-bound-only',
    phase: { basis: { contextSnapshotId: null } }, item: { jobId: f.job.jobId },
    todos: [{ provenance: 'model-self-report' }], userInputs: [{ provenance: 'user-provided',
      inputId: f.supplement.inputId, text: '  This is the original user clarification.  ' }], confirmedBusinessReferences: [],
    actions: { authorizesExecution: false } });
  expect(frozen.contextId).toBeGreaterThan(0);
  expect(await f.database.read(scope => scope.db.query(`SELECT
    (SELECT COUNT(*) FROM runs) runs,(SELECT COUNT(*) FROM context_snapshots) legacyContexts,
    (SELECT COUNT(*) FROM sessions WHERE native_session_id IS NOT NULL OR durable_conversation_id IS NOT NULL) nativeIdentities`).get()))
    .toEqual({ runs: 0, legacyContexts: 0, nativeIdentities: 0 });
  await f.database.close();
  const reopened = need(openTestDatabase(f.paths));
  expect(await reopened.read(scope => createInvoiceWorkContextRepository(scope.db).get(key(frozen.context))))
    .toEqual({ ok: true, data: frozen });
});

test('the same business request recovers its original frozen context after later product changes and rejects different text', async () => {
  const f = await fixture(), context = await f.freeze(), frozen = need(await f.save(context));
  const current = need(await f.database.read(scope => scope.invoiceWorks.get({ view: 'item', workId: f.created.workId, itemId: f.itemId })));
  need(await f.database.transaction(scope => scope.invoiceWorks.cancelWork({ workId: f.created.workId,
    expectedRevision: current.work.revision, requestId: 'cancel-after-context' }, { at: later })));
  expect(await f.save(context)).toEqual({ ok: true, data: frozen });
  expect(await f.database.read(scope => createInvoiceWorkContextRepository(scope.db).get(key(context))))
    .toEqual({ ok: true, data: frozen });
  expect(await f.save({ ...context, userInputs: [{ ...context.userInputs[0]!, text: 'Rewritten after the model request.' }] }))
    .toMatchObject({ ok: false, error: { code: 'context_binding_conflict' } });
  expect(await f.count()).toBe(1);
});

test('unpersisted phases, foreign ownership and altered frozen bases cannot save a context', async () => {
  const f = await fixture(), context = await f.freeze();
  const invalid: InvoiceWorkWorkingContext[] = [
    { ...context, phase: { ...context.phase, phaseId: context.phase.phaseId + 1 } },
    { ...context, phase: { ...context.phase, attemptId: context.phase.attemptId + 1 } },
    { ...context, phase: { ...context.phase, requestId: 'another-request' } },
    { ...context, work: { ...context.work, workId: context.work.workId + 1 } },
    { ...context, work: { ...context.work, sessionId: context.work.sessionId + 1 } },
    { ...context, item: { ...context.item, itemId: context.item.itemId + 1 } },
    { ...context, phase: { ...context.phase, basis: { ...context.phase.basis, configurationRevision: 1 } } },
    { ...context, phase: { ...context.phase, basis: { ...context.phase.basis, itemRevision: context.item.revision + 1 } } },
    { ...context, phase: { ...context.phase, basis: { ...context.phase.basis, documentRefs: [f.documents[0]!] } } },
    { ...context, phase: { ...context.phase, basis: { ...context.phase.basis, contextSnapshotId: 1 } } },
  ];
  for (const changed of invalid) expect((await f.save(changed)).ok).toBe(false);
  expect(await f.count()).toBe(0);
  expect(need(await f.database.read(scope => createInvoiceWorkContextRepository(scope.db).get({ ...key(context), requestId: 'missing' })))).toBeNull();
  expect(need(await f.database.read(scope => createInvoiceWorkContextRepository(scope.db).get({ ...key(context), workId: context.work.workId + 1 })))).toBeNull();
});

test('raw context cannot replace original input, invent product references or promote model notes into facts', async () => {
  const f = await fixture(), context = await f.freeze();
  const invalid: InvoiceWorkWorkingContext[] = [
    { ...context, userInputs: [{ ...context.userInputs[0]!, text: 'An attacker supplied different text.' }] },
    { ...context, userInputs: [{ ...context.userInputs[0]!, todoId: context.userInputs[0]!.todoId + 1 }] },
    { ...context, userInputs: [{ ...context.userInputs[0]!, requestId: 'invented-input-command' }] },
    { ...context, userInputs: [{ ...context.userInputs[0]!, documentRefs: [] }] },
    { ...context, todos: [{ ...context.todos[0]!, provenance: 'business-rule' }] },
    { ...context, confirmedBusinessReferences: [{ kind: 'candidate', provenance: 'business-record-reference', workId: context.work.workId,
      itemId: context.item.itemId, documentRef: context.item.documentRef, jobId: f.job.jobId, candidateRef: { id: 1, sequence: 1 } }] },
    { ...context, evidenceRefs: [{ documentId: 1, version: 'v1', artifactId: 2, page: 1, blockId: 'invented-original-reference' }] },
    { ...context, actions: { ...context.actions, tools: ['read_invoice_document'] } },
    { ...context, delegation: { childRunId: 101, childSessionId: 102, parentRunId: 103, originToolCallId: 104,
      role: 'invoice-evidence-checker', prompt: 'A child projection cannot replace its parent snapshot.', description: 'Child-only projection' } },
    { ...context, instructions: { version: 1, role: 'invoice-evidence-checker', provenance: 'phase-instructions',
      preferences: '', resources: null } },
  ];
  for (const changed of invalid) expect((await f.save(changed)).ok).toBe(false);
  expect(await f.count()).toBe(0);
  expect((await f.save(context)).ok).toBe(true);
});

test('another real Work, attempt, session and member cannot be attached to the original phase', async () => {
  const f = await fixture(), context = await f.freeze();
  const foreign = need(await f.database.transaction(scope => scope.invoiceWorks.create({ personalAgentId: f.agent.personalAgentId,
    expectedAgentRevision: f.agent.revision, requestId: 'create-foreign-context-work', goal: 'Another explicitly created invoice Work.',
    documents: [f.documents[1]!] }, { at, admission: { kind: 'queued' } })));
  const foreignView = need(await f.database.read(scope => scope.invoiceWorks.get({ view: 'work', workId: foreign.workId })));
  if (foreignView.view !== 'work' || !foreignView.items[0] || !foreignView.work.execution.attempt) throw Error('Expected a real other Work.');
  const invalid: InvoiceWorkWorkingContext[] = [
    { ...context, work: { ...context.work, workId: foreign.workId, sessionId: foreign.sessionId } },
    { ...context, work: { ...context.work, sessionId: foreign.sessionId } },
    { ...context, item: foreignView.items[0] },
    { ...context, phase: { ...context.phase, attemptId: foreignView.work.execution.attempt.attemptId } },
  ];
  for (const changed of invalid) expect((await f.save(changed)).ok).toBe(false);
  expect(await f.count()).toBe(0);
});

test('a current item revision change rejects the unsaved phase snapshot', async () => {
  const f = await fixture(), context = await f.freeze();
  need(await f.database.transaction(scope => scope.invoiceWorks.replaceTodos({ workId: f.created.workId,
    itemId: f.itemId, expectedRevision: context.item.revision, at: later, todos: [] })));
  expect(await f.save(context)).toMatchObject({ ok: false, error: { code: 'state_conflict' } });
  expect(await f.count()).toBe(0);
});

test.each(['authorized', 'saved-only'] as const)('a saved phase reads its original payload across only %s pending input progress', async state => {
  const f = await fixture(), context = await f.freeze(); await f.save(context);
  const current = need(await f.database.read(scope => scope.invoiceWorks.get({ view: 'item', workId: f.created.workId, itemId: f.itemId })));
  const received = need(await f.database.transaction(scope => scope.invoiceWorks.supplement({ workId: f.created.workId, itemId: f.itemId,
    todoId: f.supplement.todoId, requestId: `later-${state}-input`, expectedRevision: current.work.revision,
    text: 'A later input must not rewrite the original model payload.', materials: [] }, { at: later,
    admission: state === 'authorized' ? { kind: 'queued' } : { kind: 'blocked', reason: appError('provider_model_not_found', 'input', 'The original model is unavailable.') } })));
  expect(received.execution.authorizationAccepted).toBe(state === 'authorized');
  const phases = new InvoiceWorkPhaseContextService({ database: f.database, now: () => later, buildContext: buildInvoiceWorkContext });
  const query = { ...key(context), sessionId: context.work.sessionId };
  if (state === 'authorized') {
    expect(await phases.get(query)).toEqual({ ok: true, data: context });
    const facts = need(await f.database.read(scope => scope.invoiceWorks.readContextInput({ ...key(context), remainingBudget })));
    expect(facts.item.latestInputId).toBe(received.inputId);
    expect(buildInvoiceWorkContext(facts)).toMatchObject({ ok: false, error: { code: 'state_conflict' } });
  } else expect(await phases.get(query)).toMatchObject({ ok: false, error: { code: 'state_conflict' } });
  expect(need(await f.database.read(scope => scope.invoiceWorkContexts.get(key(context))))?.context).toEqual(context);
});

test('a document version change or stop rejects a new save, while a saved snapshot stays readable', async () => {
  const f = await fixture(), context = await f.freeze();
  await f.database.transaction(scope => scope.db.query("UPDATE documents SET version='v2' WHERE id=1").run());
  expect((await f.save(context)).ok).toBe(false);
  await f.database.transaction(scope => scope.db.query("UPDATE documents SET version='v1' WHERE id=1").run());
  const current = need(await f.database.read(scope => scope.invoiceWorks.get({ view: 'item', workId: f.created.workId, itemId: f.itemId })));
  need(await f.database.transaction(scope => scope.invoiceWorks.cancelWork({ workId: f.created.workId,
    expectedRevision: current.work.revision, requestId: 'cancel-before-context' }, { at: later })));
  expect((await f.save(context)).ok).toBe(false);
  expect(await f.count()).toBe(0);
});

test('save requires the product transaction and a failed save rolls back its new phase in that same transaction', async () => {
  const f = await fixture();
  await f.database.transaction(scope => scope.db.exec(`CREATE TRIGGER fail_context_insert BEFORE INSERT ON invoice_work_context_snapshots
    BEGIN SELECT RAISE(ABORT,'controlled context insert failure'); END`));
  await expect(f.database.transaction(scope => {
    const context = f.construct(scope);
    need(createInvoiceWorkContextRepository(scope.db).save({ context, at: phaseAt }));
  })).rejects.toThrow('storage_write_failed');
  expect(await f.database.read(scope => scope.db.query('SELECT COUNT(*) count FROM invoice_work_phases').get())).toEqual({ count: 0 });
  expect(await f.count()).toBe(0);
  const context = await f.freeze();
  expect(await f.database.read(scope => createInvoiceWorkContextRepository(scope.db).save({ context, at: phaseAt })))
    .toMatchObject({ ok: false, error: { code: 'state_conflict' } });
});

test('SQL preserves the frozen snapshot and readback rejects malformed or foreign structured contents', async () => {
  const f = await fixture(), context = await f.freeze(), frozen = need(await f.save(context));
  await expect(f.database.transaction(scope => scope.db.query('UPDATE invoice_work_context_snapshots SET context_json=? WHERE id=?')
    .run(JSON.stringify(context), frozen.contextId))).rejects.toThrow('invoice_work_context_immutable');
  await expect(f.database.transaction(scope => scope.db.query('DELETE FROM invoice_work_context_snapshots WHERE id=?')
    .run(frozen.contextId))).rejects.toThrow('invoice_work_context_preserved');
  await f.database.transaction(scope => scope.db.exec('DROP TRIGGER invoice_work_context_immutable'));
  for (const corrupt of [{ version: 1 }, { ...context, phase: { ...context.phase, phaseId: context.phase.phaseId + 1 } },
    { ...context, todos: [{ ...context.todos[0]!, provenance: 'business-rule' }] },
    { ...context, work: { ...context.work, personalAgentId: 2 } },
    { ...context, todos: [{ ...context.todos[0]!, todo: { ...context.todos[0]!.todo, itemId: context.item.itemId + 1 } }] }]) {
    await f.database.transaction(scope => scope.db.query('UPDATE invoice_work_context_snapshots SET context_json=? WHERE id=?')
      .run(JSON.stringify(corrupt), frozen.contextId));
    expect(await f.database.read(scope => createInvoiceWorkContextRepository(scope.db).get(key(context))))
      .toMatchObject({ ok: false, error: { code: 'storage_corrupt' } });
  }
});
