import { expect, test } from 'bun:test';
import { mkdirSync, readFileSync, readdirSync } from 'node:fs';
import { Database } from 'bun:sqlite';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { appError, invoiceToolSchemas,
  ok, type DurableRuntimePort, type ProviderConfig, type Result } from '@flowmate/contracts';
import type { DurableProductToolCall, DurableProductToolFeedback } from '../../../packages/contracts/src/durable-runtime.ts';
import { createInvoiceWorkToolBridge, resolveInvoiceWorkToolScope } from '../../../packages/core/src/personal-agent/tool-scope.ts';
import { createToolExecutor } from '../../../packages/core/src/tools/executor.ts';
import { DurableInvoiceGovernor } from '../../../packages/core/src/personal-agent/admission.ts';
import { InvoiceWorkPhaseContextService, InvoiceWorkPhaseObserver } from '../../../packages/core/src/personal-agent/phase-context.ts';
import { InvoiceWorkModelService } from '../../../packages/core/src/personal-agent/models.ts';
import { toPiParameters } from '../../../packages/runtime-pi/src/schema.ts';
import { buildInvoiceWorkContext } from '../../../packages/runtime-durable/src/context.ts';
import { createDurableRuntime } from '../../../packages/runtime-durable/src/runtime.ts';
import { createDurableSqliteStorage } from '../../../packages/runtime-durable/src/storage.ts';
import { openTestDatabase } from '../../support/database.ts';
import { mkdtempSync } from '../../support/resources.ts';
import { invoiceWorkToolsFixture as fixture, invoiceWorkCandidateDraft as draft } from '../../support/invoice-work-tools.ts';

const at = '2026-10-29T00:00:00.000Z';
function need<T>(result: Result<T>): T { if (!result.ok) throw Error(`${result.error.code}: ${result.error.message}`); return result.data; }
test('a genuine Durable root reuses invoice read/save/list/get and records the original candidate receipt without changing Workspace', async () => {
  const f = await fixture(), before = await f.database.read(scope => scope.db.query('SELECT * FROM workspace').get());
  expect(await f.execute('read_invoice_document', { documentId: 1, page: 1, afterBlockId: null, limit: 10 }, 'read-current-invoice'))
    .toMatchObject({ fatal: false, result: { status: 'succeeded', data: { documentRef: { id: 1, version: 'v1' }, blocks: [{ text: 'Total 113.00' }] } } });
  const candidate = draft();
  expect(await f.execute('validate_invoice_candidate', { documentId: 1, candidate }, 'validate-current-invoice'))
    .toMatchObject({ result: { status: 'succeeded', data: { documentRef: { id: 1, version: 'v1' }, saveable: true } } });
  const saved = await f.execute('save_invoice_candidate', { documentId: 1, candidate }, 'save-current-invoice');
  expect(saved).toMatchObject({ fatal: false, result: { status: 'succeeded', data: { jobId: f.jobId, sequence: 1 } } });
  if (saved.result.status !== 'succeeded') throw Error(saved.result.error.code);
  const receipt = invoiceToolSchemas.save_invoice_candidate.output.parse(saved.result.data);
  expect(await f.execute('list_invoice_candidates', { limit: 10, beforeSequence: null }, 'list-current-invoice'))
    .toMatchObject({ result: { status: 'succeeded', data: { jobId: f.jobId, candidates: [{ candidateId: receipt.candidateId }] } } });
  expect(await f.execute('get_invoice_candidate', { candidateId: receipt.candidateId }, 'get-current-invoice'))
    .toMatchObject({ result: { status: 'succeeded', data: { jobId: f.jobId, candidateId: receipt.candidateId, candidate } } });
  expect(need(await f.database.read(scope => scope.toolCalls.queryCandidateCommit({ toolCallId: saved.call.toolCallId,
    runId: f.runId, sessionId: f.created.sessionId })))).toEqual(receipt);
  expect(await f.database.read(scope => scope.db.query('SELECT r.job_id,s.runtime_kind FROM runs r JOIN sessions s ON s.id=r.session_id WHERE r.id=?').get(f.runId)))
    .toEqual({ job_id: null, runtime_kind: 'durable' });
  expect(await f.database.read(scope => scope.db.query('SELECT * FROM workspace').get())).toEqual(before);
  expect(await f.database.read(scope => scope.db.query('SELECT COUNT(*) count FROM runs').get())).toEqual({ count: 1 });
  const item = need(await f.database.read(scope => scope.invoiceWorks.get({ view: 'item', workId: f.created.workId, itemId: f.itemId })));
  expect(item).toMatchObject({ item: { disposition: 'unresolved', candidateRef: { id: receipt.candidateId, sequence: 1 } } });
  expect(need(await f.database.read(scope => scope.jobs.get(f.jobId)))).toMatchObject({ status: 'waiting', currentCandidateId: receipt.candidateId });
  await f.database.close();
  const reopened = need(openTestDatabase(f.paths));
  expect(need(await reopened.read(scope => scope.toolCalls.queryCandidateCommit({ toolCallId: saved.call.toolCallId,
    runId: f.runId, sessionId: f.created.sessionId })))).toEqual(receipt);
});

test('the current invoice phase rejects another fixed invoice and Candidate access without its phase identity', async () => {
  const f = await fixture();
  expect(await f.database.read(scope => scope.candidates.listForRun({ runId: f.runId, beforeSequence: null, limit: 10 })))
    .toMatchObject({ ok: false, error: { code: 'tool_access_denied' } });
  expect(await f.execute('read_invoice_document', { documentId: 2, page: 1, afterBlockId: null, limit: 10 }, 'read-other-fixed-invoice'))
    .toMatchObject({ result: { status: 'failed', error: { code: 'tool_access_denied' } } });
  expect(await f.database.read(scope => scope.db.query('SELECT COUNT(*) count FROM invoice_candidates').get())).toEqual({ count: 0 });
});

test('a closed phase cannot borrow its successor on the identical invoice and Job, while original receipts stay readable', async () => {
  const f = await fixture();
  const original = await f.execute('read_invoice_document', { documentId: 1, page: 1, afterBlockId: null, limit: 10 }, 'old-phase-read');
  const next = await f.database.transaction(scope => {
    scope.db.query('UPDATE invoice_work_phases SET closed_at=? WHERE id=?').run(at, f.phase.phaseId);
    const current = need(scope.invoiceWorks.get({ view: 'item', workId: f.created.workId, itemId: f.itemId }));
    if (current.view !== 'item') throw Error('Expected the same owned invoice.');
    const phase = need(scope.invoiceWorks.freezePhase({ workId: f.created.workId, attemptId: f.attemptId, itemId: f.itemId,
      requestId: 'invoice-phase-2', kind: 'prompt', basis: { contextSnapshotId: null, inputIds: [], documentRefs: [current.item.documentRef],
        configurationRevision: 0, itemRevision: current.item.revision }, at }));
    need(scope.invoiceWorkContexts.save({ context: need(buildInvoiceWorkContext(need(scope.invoiceWorks.readContextInput({ workId: f.created.workId,
      attemptId: f.attemptId, requestId: phase.requestId,
      remainingBudget: { modelCalls: 12, toolCalls: 24, toolFeedbackBytes: 65536, timeoutMs: 30000, childSlots: 1 } })))), at }));
    return need(resolveInvoiceWorkToolScope(scope.db, { runId: f.runId, sessionId: f.created.sessionId,
      workId: f.created.workId, attemptId: f.attemptId, requestId: phase.requestId }));
  });
  expect(next.jobId).toBe(f.jobId);
  expect(next.scope.invoiceWork?.phaseId).not.toBe(f.phase.phaseId);
  expect(await f.database.read(scope => scope.toolCalls.verifyUse(f.product))).toMatchObject({ ok: false, error: { code: 'run_state_invalid' } });
  expect(await f.executor.execute('read_invoice_document', { documentId: 1, page: 1, afterBlockId: null, limit: 10 },
    { ...f.product, scope: next.scope, nativeToolCallId: 'new-phase-read', signal: new AbortController().signal }))
    .toMatchObject({ result: { status: 'succeeded' } });
  const recovered = await f.execute('read_invoice_document', { documentId: 1, page: 1, afterBlockId: null, limit: 10 }, 'old-phase-read');
  expect(recovered.call).toEqual(original.call);
  expect(recovered.result).toMatchObject(original.result);
  expect(await f.execute('read_invoice_document', { documentId: 1, page: 1, afterBlockId: null, limit: 10 }, 'late-old-phase-read'))
    .toMatchObject({ result: { status: 'failed', error: { code: 'run_state_invalid' } } });
  expect(await f.database.read(scope => scope.db.query('SELECT COUNT(*) count FROM tool_calls').get())).toEqual({ count: 2 });
});

test.each(['cancel', 'stop', 'version', 'revoke'] as const)('%s blocks new invoice business writes at the original phase boundary', async action => {
  const f = await fixture();
  await f.database.transaction(scope => {
    if (action === 'cancel') {
      const current = need(scope.invoiceWorks.get({ view: 'item', workId: f.created.workId, itemId: f.itemId }));
      need(scope.invoiceWorks.cancelWork({ workId: f.created.workId, expectedRevision: current.work.revision, requestId: 'cancel-current-work' }, { at }));
    } else if (action === 'stop') scope.db.query('UPDATE invoice_work_attempts SET stop_requested_at=? WHERE id=?').run(at, f.attemptId);
    else if (action === 'version') scope.db.query("UPDATE documents SET version='v2' WHERE id=1").run();
    else need(scope.sessions.revokeDocumentUse({ documentId: 1, at }));
  });
  expect((await f.execute('save_invoice_candidate', { documentId: 1, candidate: draft() }, 'write-after-boundary')).result.status).toBe('failed');
  expect(await f.database.read(scope => scope.db.query('SELECT COUNT(*) count FROM invoice_candidates').get())).toEqual({ count: 0 });
});

test('a human Todo revision after the frozen phase rejects its stale candidate save', async () => {
  const f = await fixture();
  const original = need(await f.database.read(scope => scope.invoiceWorkContexts.get({ workId: f.created.workId,
    attemptId: f.attemptId, requestId: f.phase.requestId })));
  if (!original) throw Error('Expected the original saved phase.');
  need(await f.database.transaction(scope => scope.invoiceWorks.replaceTodos({ workId: f.created.workId, itemId: f.itemId,
    expectedRevision: original.context.item.revision, at, todos: [{ actor: 'user', action: 'supplement', fieldPath: null,
      problem: 'A human supplied a new review question.', needed: 'Answer the human question.', satisfiedBy: 'A new clarification is recorded.',
      basis: { origin: 'user', documentRefs: [original.context.item.documentRef], sourceRefs: [], inputIds: [], candidateRef: null } }] })));
  expect((await f.execute('save_invoice_candidate', { documentId: 1, candidate: draft() }, 'stale-save-after-human-todo')).result)
    .toMatchObject({ status: 'failed', error: { code: 'state_conflict' } });
  expect(await f.database.read(scope => scope.db.query('SELECT COUNT(*) count FROM invoice_candidates').get())).toEqual({ count: 0 });
  expect(need(await f.database.read(scope => scope.invoiceWorkContexts.get({ workId: f.created.workId,
    attemptId: f.attemptId, requestId: f.phase.requestId })))).toEqual(original);
});

test('the Core bridge recovers the original native Task receipt and counts only its exact committed native feedback', async () => {
  const f = await fixture();
  need(await f.database.transaction(scope => scope.invoiceWorks.linkPhase({ workId: f.created.workId, attemptId: f.attemptId,
    phaseId: f.phase.phaseId, nativeConversationId: 11, nativeSubmissionId: 12, at })));
  const bridge = createInvoiceWorkToolBridge({ database: f.database, executor: f.executor });
  const call = { workId: f.created.workId, sessionId: f.created.sessionId, attemptId: f.attemptId, requestId: f.phase.requestId,
    nativeConversationId: 11, nativeTaskId: 23, nativeToolCallId: 'provider-wire-id', name: 'save_invoice_candidate',
    arguments: { documentId: 1, candidate: draft() } };
  const saved = need(await bridge.executeTool({ ...call, signal: new AbortController().signal }));
  expect(saved).toMatchObject({ status: 'succeeded', data: { jobId: f.jobId, sequence: 1 } });
  expect(need(await bridge.readToolResult(call))).toEqual(saved);
  expect(need(await bridge.executeTool({ ...call, signal: new AbortController().signal }))).toEqual(saved);
  expect(await bridge.readToolResult({ ...call, arguments: { documentId: 2, candidate: draft() } }))
    .toMatchObject({ ok: false, error: { code: 'state_conflict' } });
  const feedbackJson = JSON.stringify({ role: 'toolResult', toolCallId: call.nativeToolCallId, toolName: call.name, isError: false,
    details: saved, content: [{ type: 'text', text: JSON.stringify(saved) }], timestamp: 1, durationMs: 7 });
  const feedback = { ...call, nativeEntryId: 24, feedbackJson };
  expect(await bridge.onToolFeedback(feedback)).toEqual({ ok: true, data: undefined });
  expect(await bridge.onToolFeedback(feedback)).toEqual({ ok: true, data: undefined });
  expect(await bridge.onToolFeedback({ ...feedback, nativeEntryId: 25 })).toMatchObject({ ok: false, error: { code: 'state_conflict' } });
  expect(await f.database.read(scope => scope.db.query('SELECT feedback_native_entry_id,feedback_bytes FROM invoice_work_tool_calls').all()))
    .toEqual([{ feedback_native_entry_id: 24, feedback_bytes: Buffer.byteLength(feedbackJson, 'utf8') }]);
  expect(await f.database.read(scope => scope.db.query('SELECT COUNT(*) count FROM invoice_candidates').get())).toEqual({ count: 1 });
});

test('a lost product response is recovered from its original committed candidate without executing another save', async () => {
  const f = await fixture();
  need(await f.database.transaction(scope => scope.invoiceWorks.linkPhase({ workId: f.created.workId, attemptId: f.attemptId,
    phaseId: f.phase.phaseId, nativeConversationId: 31, nativeSubmissionId: 32, at })));
  let executed = 0;
  const bridge = createInvoiceWorkToolBridge({ database: f.database, executor: { ...f.executor, execute: async (...args) => {
    executed++; await f.executor.execute(...args); throw Error('Controlled response loss after the real product COMMIT.');
  } } });
  const call = { workId: f.created.workId, sessionId: f.created.sessionId, attemptId: f.attemptId, requestId: f.phase.requestId,
    nativeConversationId: 31, nativeTaskId: 33, nativeToolCallId: 'lost-wire-id', name: 'save_invoice_candidate',
    arguments: { documentId: 1, candidate: draft() } };
  expect(await bridge.executeTool({ ...call, signal: new AbortController().signal }))
    .toMatchObject({ ok: false, error: { code: 'tool_commit_unconfirmed' } });
  expect(await bridge.readToolResult(call)).toMatchObject({ ok: true, data: { status: 'succeeded', data: { jobId: f.jobId, sequence: 1 } } });
  expect(await bridge.executeTool({ ...call, signal: new AbortController().signal }))
    .toMatchObject({ ok: true, data: { status: 'succeeded', data: { jobId: f.jobId, sequence: 1 } } });
  expect(executed).toBe(1);
  expect(await f.database.read(scope => scope.db.query('SELECT COUNT(*) count FROM invoice_candidates').get())).toEqual({ count: 1 });
});

test('a stored failure with an unknown write outcome stays unknown instead of becoming a confirmed failed tool result', async () => {
  const f = await fixture();
  need(await f.database.transaction(scope => scope.invoiceWorks.linkPhase({ workId: f.created.workId, attemptId: f.attemptId,
    phaseId: f.phase.phaseId, nativeConversationId: 41, nativeSubmissionId: 42, at })));
  const bridge = createInvoiceWorkToolBridge({ database: f.database, executor: f.executor });
  const call = { workId: f.created.workId, sessionId: f.created.sessionId, attemptId: f.attemptId, requestId: f.phase.requestId,
    nativeConversationId: 41, nativeTaskId: 43, nativeToolCallId: 'unconfirmed-wire-id', name: 'save_invoice_candidate',
    arguments: { documentId: 2, candidate: draft() } };
  expect(await bridge.executeTool({ ...call, signal: new AbortController().signal })).toMatchObject({ ok: true, data: { status: 'failed' } });
  await f.database.transaction(scope => scope.db.query("UPDATE tool_calls SET runtime_observation_json=json_set(runtime_observation_json,'$.commit','unknown','$.commitError',json(?)) WHERE native_tool_call_id='durable-task:43'")
    .run(JSON.stringify(appError('storage_read_failed', 'storage', 'Controlled original write receipt query failure.', true))));
  expect(await bridge.readToolResult(call)).toEqual({ ok: true, data: null });
  expect(await bridge.executeTool({ ...call, signal: new AbortController().signal }))
    .toMatchObject({ ok: false, error: { code: 'tool_commit_unconfirmed' } });
  expect(await f.database.read(scope => scope.db.query('SELECT COUNT(*) count FROM invoice_candidates').get())).toEqual({ count: 0 });
});

test.each(['confirmed', 'recovered-original-commit', 'recovered-before-tool-settlement'] as const)('the real Durable SDK reads, saves with original evidence and reaches its third model request through the product context and governor: %s', async outcome => {
  const requests: Array<{ messages: Array<{ role: string; content?: unknown }> }> = [];
  const calls: DurableProductToolCall[] = [], feedback: DurableProductToolFeedback[] = [];
  const server = Bun.serve({ port: 0, fetch: async request => {
    requests.push(await request.json() as typeof requests[number]);
    const tool = requests.length === 1 ? { name: 'read_invoice_document', arguments: { documentId: 1, page: 1, afterBlockId: null, limit: 10 } }
      : requests.length === 2 ? { name: 'save_invoice_candidate', arguments: { documentId: 1, candidate: draft() } } : null;
    const delta = tool ? { role: 'assistant', tool_calls: [{ index: 0, id: `invoice-wire-${requests.length}`, type: 'function',
      function: { name: tool.name, arguments: JSON.stringify(tool.arguments) } }] }
      : { role: 'assistant', content: 'A candidate with the original invoice evidence is prepared for human review.' };
    const chunk = { id: `invoice-model-${requests.length}`, object: 'chat.completion.chunk', created: 1, model: 'invoice-local-model',
      choices: [{ index: 0, delta, finish_reason: tool ? 'tool_calls' : 'stop' }] };
    return new Response(`data: ${JSON.stringify(chunk)}\n\ndata: [DONE]\n\n`, { headers: { 'content-type': 'text/event-stream' } });
  } });
  let runtime: DurableRuntimePort | undefined;
  try {
    const provider: ProviderConfig = { version: 1, name: 'invoice-local-profile', revision: 1,
      modelRef: { provider: 'controlled-invoice-provider', model: 'invoice-local-model' },
      native: { authPath: 'unused-auth.json', modelsPath: null },
      connection: { api: 'openai-completions', baseUrl: `http://127.0.0.1:${server.port}/v1`, contextWindow: 64000, maxTokens: 8192 },
      parameters: { maxRetries: 0, maxRetryDelayMs: 1000 } };
    const f = await fixture({ provider, at: new Date(Date.now() - 1000).toISOString() });
    const now = () => new Date().toISOString();
    const identity = { workId: f.created.workId, sessionId: f.created.sessionId, attemptId: f.attemptId };
    const query = { ...identity, requestId: f.phase.requestId };
    const before = await f.database.read(scope => scope.db.query('SELECT * FROM workspace').get());
    const governor = new DurableInvoiceGovernor(f.database, now, () => false);
    const contexts = new InvoiceWorkPhaseContextService({ database: f.database, now, buildContext: buildInvoiceWorkContext });
    const originalContext = need(await contexts.get(query));
    let lostCommitQuery = false, rejectedSettlement = false;
    const decorate = (scope: import('../../../packages/core/src/storage/database.ts').SqlDatabaseStore) => ({ ...scope,
      toolCalls: { ...scope.toolCalls, queryCandidateCommit: (input: Parameters<typeof scope.toolCalls.queryCandidateCommit>[0]) => {
        const original = scope.toolCalls.getById(input.toolCallId);
        if (!original.ok) return original;
        if (outcome === 'recovered-original-commit' && !lostCommitQuery && original.data.toolName === 'save_invoice_candidate') {
          lostCommitQuery = true;
          return { ok: false as const, error: appError('storage_read_failed', 'storage', 'Controlled loss of the original candidate commit query.', true) };
        }
        return scope.toolCalls.queryCandidateCommit(input);
      }, finish: (input: Parameters<typeof scope.toolCalls.finish>[0]) => {
        const original = scope.toolCalls.getById(input.toolCallId);
        if (!original.ok) return original;
        if (outcome === 'recovered-before-tool-settlement' && original.data.toolName === 'save_invoice_candidate') {
          rejectedSettlement = true;
          return { ok: false as const, error: appError('storage_write_failed', 'storage', 'Controlled tool settlement failure after the original candidate committed.', true) };
        }
        return scope.toolCalls.finish(input);
      } } });
    const executor = createToolExecutor({ database: {
      read: operation => f.database.read(scope => operation(decorate(scope))),
      transaction: operation => f.database.transaction(scope => operation(decorate(scope))),
    }, definitions: f.definitions, now });
    const bridge = createInvoiceWorkToolBridge({ database: f.database, executor });
    const originalSaveBytes: { value: { result_json: string | null; runtime_observation_json: string | null } | null } = { value: null };
    let observer: InvoiceWorkPhaseObserver;
    runtime = need(await createDurableRuntime({ storage: await createDurableSqliteStorage(f.database.coordinator),
      readApiKey: () => 'controlled-local-key', verifyModelUse: input => governor.verifyModelUse(input),
      reserveModelRequest: input => governor.reserveModelRequest(input), readWorkingContext: input => contexts.get(input),
      verifyWorkingContext: input => contexts.verify(input), tools: f.definitions.filter(tool =>
        ['read_invoice_document', 'save_invoice_candidate'].includes(tool.name)).map(tool => ({ name: tool.name,
          description: tool.description, executionMode: tool.executionMode, inputSchema: { ...toPiParameters(tool.inputSchema) } })),
      executeTool: async input => {
        const { signal: _signal, ...original } = input;
        calls.push(original);
        const phase = await observer.reconcile({ workId: input.workId, sessionId: input.sessionId,
          attemptId: input.attemptId, requestId: input.requestId });
        if (!phase.ok) return phase;
        const result = await bridge.executeTool(input);
        if (input.name === 'save_invoice_candidate') originalSaveBytes.value = await f.database.read(scope => scope.db
          .query<{ result_json: string | null; runtime_observation_json: string | null }, [string]>(
            'SELECT result_json,runtime_observation_json FROM tool_calls WHERE native_tool_call_id=?').get(`durable-task:${input.nativeTaskId}`));
        return result;
      }, readToolResult: input => bridge.readToolResult(input), onToolFeedback: input => {
        feedback.push(input); return bridge.onToolFeedback(input);
      } }));
    observer = new InvoiceWorkPhaseObserver({ database: f.database, runtime, now });
    const models = new InvoiceWorkModelService({ database: f.database, runtime, now,
      resolveConfiguration: modelId => { expect(modelId).toBe(provider.name); return ok(provider); } });
    need(await runtime.openConversation({ workId: identity.workId, sessionId: identity.sessionId }));
    const binding = need(await models.prepare(query));
    const submission = { ...query, config: binding.configuration, binding, text: 'Read the original invoice and save its sourced candidate.' };
    const submitted = need(await runtime.submit(submission));
    const settled = need(await runtime.waitForSubmission(query));
    if (outcome !== 'confirmed') {
      expect(originalSaveBytes.value).not.toBeNull();
      if (outcome === 'recovered-original-commit') {
        expect(lostCommitQuery).toBe(true);
        expect(JSON.parse(originalSaveBytes.value!.result_json!)).toMatchObject({ status: 'failed' });
        expect(JSON.parse(originalSaveBytes.value!.runtime_observation_json!)).toMatchObject({ commit: 'unknown' });
      } else {
        expect(rejectedSettlement).toBe(true);
        expect(originalSaveBytes.value).toEqual({ result_json: null, runtime_observation_json: null });
      }
      expect(JSON.parse(feedback.find(item => item.name === 'save_invoice_candidate')!.feedbackJson))
        .toMatchObject({ isError: false, details: { status: 'succeeded', data: { jobId: f.jobId, sequence: 1 } } });
    }
    expect(settled).toMatchObject({ status: 'done', answer: 'A candidate with the original invoice evidence is prepared for human review.' });
    expect(requests).toHaveLength(3);
    expect(calls.map(call => call.name)).toEqual(['read_invoice_document', 'save_invoice_candidate']);
    expect(feedback).toHaveLength(2);
    expect(need(await contexts.get(query))).toEqual(originalContext);
    const current = need(await f.database.read(scope => scope.invoiceWorks.get({ view: 'item', workId: identity.workId, itemId: f.itemId })));
    expect(current).toMatchObject({ work: { status: 'open' }, item: { disposition: 'unresolved', revision: originalContext.item.revision + 1,
      candidateRef: { sequence: 1 } } });
    expect(await f.database.read(scope => scope.db.query('SELECT COUNT(*) count FROM runs').get())).toEqual({ count: 1 });
    expect(await f.database.read(scope => scope.db.query('SELECT job_id FROM runs WHERE id=?').get(f.runId))).toEqual({ job_id: null });
    expect(await f.database.read(scope => scope.db.query('SELECT COUNT(*) count FROM invoice_candidates').get())).toEqual({ count: 1 });
    expect(await f.database.read(scope => scope.db.query('SELECT * FROM workspace').get())).toEqual(before);
    const nativeHistory = need(await runtime.queryHistory({ workId: identity.workId, sessionId: identity.sessionId, limit: 100 }));
    const bytes = await f.database.read(scope => scope.db.query<{ feedback_native_entry_id: number; feedback_bytes: number }, []>(
      'SELECT feedback_native_entry_id,feedback_bytes FROM invoice_work_tool_calls ORDER BY tool_call_id').all());
    for (const [index, saved] of feedback.entries()) {
      const original = nativeHistory.entries.find(entry => entry.nativeEntryId === saved.nativeEntryId);
      expect(original).toBeDefined();
      expect(saved.feedbackJson).toBe(JSON.stringify(JSON.parse(original!.json).model[0]));
      expect(bytes[index]).toEqual({ feedback_native_entry_id: saved.nativeEntryId, feedback_bytes: Buffer.byteLength(saved.feedbackJson, 'utf8') });
    }
    const remaining = need(await governor.remainingBudget(identity.workId));
    expect(remaining.modelCalls).toBe(f.config.runtimeBudget.maxModelCalls - 3);
    expect(remaining.toolCalls).toBe(f.config.runtimeBudget.maxToolCalls - 2);
    expect(remaining.toolFeedbackBytes).toBe(f.config.runtimeBudget.maxToolFeedbackBytes - bytes.reduce((sum, row) => sum + row.feedback_bytes, 0));
    need(await observer.reconcile(query));
    expect(need(await runtime.submit(submission)).nativeSubmissionId).toBe(submitted.nativeSubmissionId);
    const originalSave = calls.find(call => call.name === 'save_invoice_candidate');
    if (!originalSave) throw Error('The actual native save Tool Task was not observed.');
    expect(await bridge.executeTool({ ...originalSave, signal: new AbortController().signal }))
      .toMatchObject({ ok: true, data: { status: 'succeeded', data: { jobId: f.jobId, sequence: 1 } } });
    expect(need(await runtime.stopAttempt({ ...identity, stopGraceMs: 1000 })).stopped).toBe(true);
    expect(await bridge.readToolResult(originalSave)).toMatchObject({ ok: true, data: { status: 'succeeded' } });
    expect(requests).toHaveLength(3);
    expect(await f.database.read(scope => scope.db.query('SELECT COUNT(*) count FROM invoice_candidates').get())).toEqual({ count: 1 });
    expect(await f.database.read(scope => scope.db
      .query<{ result_json: string | null; runtime_observation_json: string | null }, [string]>(
        'SELECT result_json,runtime_observation_json FROM tool_calls WHERE native_tool_call_id=?').get(`durable-task:${originalSave.nativeTaskId}`)))
      .toEqual(originalSaveBytes.value);
  } finally { if (runtime) need(await runtime.close()); server.stop(true); }
}, 20_000);

function schema20Candidates(rejectUpgrade = false) {
  const root = mkdtempSync(join(tmpdir(), 'flowmate-invoice-candidate-migration-'));
  const paths = { root, databaseFile: join(root, 'data/app.sqlite'), artifactsDir: join(root, 'artifacts'),
    runtimeDir: join(root, 'runtime'), logsDir: join(root, 'logs'), outputsDir: join(root, 'outputs') };
  mkdirSync(join(root, 'data'), { recursive: true });
  const db = new Database(paths.databaseFile); db.exec('PRAGMA foreign_keys=ON');
  const directory = new URL('../../../packages/core/src/storage/migrations/', import.meta.url);
  for (const name of readdirSync(directory).filter(name => /^\d{3}_.*\.sql$/.test(name) && Number(name.slice(0, 3)) <= 20).sort()) {
    const version = Number(name.slice(0, 3));
    if (version === 17) db.exec('PRAGMA foreign_keys=OFF; PRAGMA legacy_alter_table=ON');
    for (const statement of readFileSync(new URL(name, directory), 'utf8').split(/^\s*-- statement\s*$/m).filter(part => part.trim())) db.exec(statement);
    if (db.inTransaction) db.exec('COMMIT');
    if (version === 10 || version === 17) db.exec('PRAGMA foreign_keys=ON; PRAGMA legacy_alter_table=OFF');
  }
  db.query('INSERT INTO sessions(id,native_session_id,title,created_at,updated_at) VALUES(1,?,?,?,?)').run('original-agent-session', 'Original', at, at);
  for (const [id, kind] of [[1, 'original'], [2, 'parsed']] as const)
    db.query('INSERT INTO artifacts(id,kind,relative_path,bytes,mime_type,metadata_json,created_at) VALUES(?,?,?,1,?,?,?)')
      .run(id, kind, `artifacts/${id}/original`, 'application/octet-stream', '{}', at);
  db.query('INSERT INTO documents(id,source_key,source_record_id,version,original_artifact_id,parsed_artifact_id,status,metadata_json,created_at,updated_at) VALUES(1,?,?,?,1,2,?,?,?,?)')
    .run('original', 'invoice', 'v1', 'available', '{}', at, at);
  for (const jobId of [1, 2]) db.query("INSERT INTO jobs(id,document_id,goal,input_json,status,created_at,updated_at) VALUES(?,1,'Original invoice','{}','waiting',?,?)")
    .run(jobId, at, at);
  const scope = JSON.stringify({ version: 2, allowedTools: ['save_invoice_candidate'], allowedDocumentIds: [1], allowedArtifactIds: [1, 2], allowedResourcePaths: [] });
  db.query("INSERT INTO runs(id,kind,session_id,job_id,scope_json,status,goal,input_json,config_json,cleanup_json,usage_json,created_at,started_at) VALUES(1,'agent',1,1,?,'running','Original invoice','{}','{}','{}','{}',?,?)")
    .run(scope, at, at);
  db.query("INSERT INTO tool_calls(id,run_id,session_id,native_tool_call_id,tool_name,tool_version,effect,args_json,status,delivery_json,cleanup_json,requested_at,started_at) VALUES(1,1,1,'original-model-save','save_invoice_candidate','1','LOCAL_WRITE',?,'running',?,?,?,?)")
    .run(JSON.stringify({ version: 1, raw: {}, final: {} }), JSON.stringify({ version: 1, state: 'not_attempted', messageObservedAt: null,
      includedInCallSequence: null, requestDispatchedAt: null, error: null }), JSON.stringify({ version: 1, stopped: false, stopReason: null, errors: [] }), at, at);
  const candidate = draft();
  for (const [id, origin] of [[1, 'model'], [2, 'human_edit']] as const)
    db.query("INSERT INTO invoice_candidates(id,job_id,run_id,tool_call_id,sequence,origin,based_on_candidate_id,status,fields_json,lines_json,issues_json,created_at) VALUES(?,1,?,?,?,?,?,'generated',?,?,?,?)")
      .run(id, origin === 'model' ? 1 : null, origin === 'model' ? 1 : null, id, origin, origin === 'human_edit' ? 1 : null,
        JSON.stringify({ version: 1, values: candidate.fields, ...(origin === 'human_edit' ? { editRequestFacts: null } : {}) }),
        JSON.stringify({ version: 1, items: [] }), JSON.stringify({ version: 1, notes: [], checks: [], items: [] }), at);
  const candidates = db.query<Record<string, unknown>, []>('SELECT * FROM invoice_candidates ORDER BY id').all();
  const triggers = db.query<Record<string, unknown>, []>("SELECT name,sql FROM sqlite_master WHERE tbl_name='invoice_candidates' AND sql IS NOT NULL AND type!='table' ORDER BY name").all();
  if (rejectUpgrade) db.exec("CREATE TRIGGER reject_candidate_upgrade AFTER INSERT ON schema_migrations WHEN NEW.version=21 BEGIN SELECT RAISE(ABORT,'controlled_upgrade_failure'); END;");
  db.close(); return { paths, candidates, triggers };
}

test('021 preserves real schema20 model and human candidates, their original triggers and legacy Job ownership', async () => {
  const f = schema20Candidates(), database = need(openTestDatabase(f.paths));
  expect(await database.read(scope => scope.db.query('SELECT * FROM invoice_candidates ORDER BY id').all())).toEqual(f.candidates);
  expect(await database.read(scope => scope.db.query("SELECT name,sql FROM sqlite_master WHERE name IN ('candidate_one_accepted','context_candidate_insert_guard','context_candidate_owner_guard','context_candidate_immutable_guard') ORDER BY name").all()))
    .toEqual(f.triggers);
  expect(await database.read(scope => scope.db.query('PRAGMA foreign_key_check').all())).toEqual([]);
  await database.transaction(scope => {
    expect(() => scope.db.query('UPDATE invoice_candidates SET job_id=2 WHERE id=1').run()).toThrow('invoice_candidate_owner_invalid');
    expect(() => scope.db.query("INSERT INTO invoice_candidates(job_id,run_id,tool_call_id,sequence,origin,status,fields_json,lines_json,issues_json,created_at) SELECT 2,run_id,tool_call_id,3,'model',status,fields_json,lines_json,issues_json,created_at FROM invoice_candidates WHERE id=1").run())
      .toThrow('invoice_candidate_owner_invalid');
  });
});

test('a failure after the old Candidate table was replaced rolls back schema20 and both original rows', () => {
  const f = schema20Candidates(true);
  expect(openTestDatabase(f.paths)).toMatchObject({ ok: false, error: { code: 'storage_open_failed' } });
  const original = new Database(f.paths.databaseFile);
  try {
    expect(original.query('SELECT max(version) version FROM schema_migrations').get()).toEqual({ version: 20 });
    expect(original.query('SELECT * FROM invoice_candidates ORDER BY id').all()).toEqual(f.candidates);
    expect(original.query("SELECT name FROM sqlite_master WHERE name='invoice_candidates_p18_previous'").get()).toBeNull();
    expect(original.query('PRAGMA foreign_key_list(invoice_candidates)').all())
      .toEqual(expect.arrayContaining([expect.objectContaining({ table: 'runs', from: 'job_id', to: 'job_id' })]));
  } finally { original.close(); }
});
