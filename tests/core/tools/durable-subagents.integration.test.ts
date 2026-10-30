import { expect, test } from 'bun:test';
import { INVOICE_REVIEW_TOOL_NAMES, PersonalAgentConfigurationSchema, appError, fail, ok, type DurableSubagentObservation,
  type DurableSubagentPlan, type Result } from '@flowmate/contracts';
import { createDurableInvoiceSubagentService } from '../../../packages/core/src/personal-agent/subagents.ts';
import { DurableInvoiceGovernor } from '../../../packages/core/src/personal-agent/admission.ts';
import { createInvoiceWorkToolBridge, recordInvoiceWorkToolFeedback } from '../../../packages/core/src/personal-agent/tool-scope.ts';
import { createToolExecutor } from '../../../packages/core/src/tools/executor.ts';
import { invoiceWorkToolsFixture } from '../../support/invoice-work-tools.ts';

const at = '2026-10-29T00:00:00.000Z';
function need<T>(result: Result<T>): T { if (!result.ok) throw Error(`${result.error.code}: ${result.error.message}`); return result.data; }
async function fixture() {
  const configuration = PersonalAgentConfigurationSchema.parse({ modelId: 'controlled', thinkingLevel: 'off',
    resources: { prompt: null, enabledSkills: [] }, extensions: { enabledExtensions: [] },
    tools: [...INVOICE_REVIEW_TOOL_NAMES, 'Agent'], workingDirectory: null, preferences: '' });
  const f = await invoiceWorkToolsFixture({ configuration });
  await f.database.transaction(scope => {
    need(scope.invoiceWorks.linkPhase({ workId: f.created.workId, attemptId: f.attemptId, phaseId: f.phase.phaseId,
      nativeConversationId: 11, nativeSubmissionId: 12, at }));
    need(scope.invoiceWorkModelBindings.save({ workId: f.created.workId, attemptId: f.attemptId, modelId: 'controlled', at,
      binding: { version: 1, configuration: { version: 1, name: 'controlled', revision: 1,
        modelRef: { provider: 'controlled', model: 'offline' }, credentialRef: 'controlled-key-ref-original',
        native: { authPath: 'C:/controlled/auth.json', modelsPath: null }, parameters: { maxRetries: 0, maxRetryDelayMs: 1000 } },
      modelJson: JSON.stringify({ id: 'offline', provider: 'controlled', baseUrl: 'http://127.0.0.1:1/v1' }), request: { authHeader: true, headers: {} } } }));
  });
  let observation: DurableSubagentObservation | null = null;
  const governor = new DurableInvoiceGovernor(f.database, () => at, () => false);
  const service = createDurableInvoiceSubagentService({ database: f.database, governor, now: () => at,
    observeSubagent: async () => ok(observation) });
  const executor = createToolExecutor({ database: f.database, definitions: [...f.definitions, service.tool], now: () => at });
  const bridge = createInvoiceWorkToolBridge({ database: f.database, executor });
  const call = { workId: f.created.workId, sessionId: f.created.sessionId, attemptId: f.attemptId, requestId: f.phase.requestId,
    nativeConversationId: 11, nativeTaskId: 17, nativeToolCallId: 'wire-delegate', name: 'Agent',
    arguments: { prompt: 'Verify only the total on this invoice; return sources and gaps.', description: 'Check original total',
      subagent_type: 'invoice-evidence-checker', run_in_background: false } };
  return { ...f, governor, service, bridge, executor, call, setObservation: (value: DurableSubagentObservation) => { observation = value; } };
}

test('a Durable delegation owns one read-only child and reuses its original Run and receipt', async () => {
  const f = await fixture(); let plan: DurableSubagentPlan | null = null;
  const result = need(await f.bridge.executeTool({ ...f.call, signal: new AbortController().signal,
    nativeDelegate: async (original, _signal) => {
      plan = original;
      need(await f.service.callbacks.adopt({ ...original, nativeConversationId: 31 }));
      expect(original.allowedTools).toContain('read_invoice_document');
      expect(original.allowedTools).not.toContain('Agent'); expect(original.allowedTools).not.toContain('save_invoice_candidate');
      const observed: DurableSubagentObservation = { ...original, creation: 'created', nativeConversationId: 31,
        nativeSubmissionId: 32, status: 'done', answer: 'The total is 113.00; original evidence still requires parent review.', reason: null,
        consumedAt: at, execution: 'closed', creatorExecution: 'active', parentToolResultEntryId: null, parentModelTaskId: null, parentModelReceivedAt: null };
      f.setObservation(observed); return ok(observed);
    } }));
  expect(result.status).toBe('succeeded'); expect(plan).not.toBeNull();
  expect(await f.database.read(scope => scope.db.query('SELECT kind,status FROM runs ORDER BY id').all()))
    .toEqual([{ kind: 'agent', status: 'running' }, { kind: 'subagent', status: 'completed' }]);
  expect(need(await f.bridge.readToolResult(f.call))).toEqual(result);
  expect(need(await f.bridge.executeTool({ ...f.call, signal: new AbortController().signal }))).toEqual(result);
  expect(await f.database.read(scope => scope.db.query('SELECT COUNT(*) count FROM runs').get())).toEqual({ count: 2 });
  expect(await f.database.read(scope => scope.db.query('SELECT COUNT(*) count FROM invoice_candidates').get())).toEqual({ count: 0 });
});

test('child failure returns an explicit evidence gap without failing the original root', async () => {
  const f = await fixture();
  expect(await f.bridge.executeTool({ ...f.call, signal: new AbortController().signal,
    nativeDelegate: async plan => { need(await f.service.callbacks.adopt({ ...plan, nativeConversationId: 41 })); return ok({ ...plan, creation: 'created', nativeConversationId: 41, nativeSubmissionId: 42,
      status: 'unanswered', answer: null, reason: 'controlled child failure', consumedAt: at, execution: 'closed', creatorExecution: 'active',
      parentToolResultEntryId: null, parentModelTaskId: null, parentModelReceivedAt: null }); } }))
    .toMatchObject({ ok: true, data: { status: 'succeeded', data: { details: { outcome: 'gap' } } } });
  expect(await f.database.read(scope => scope.db.query('SELECT kind,status FROM runs ORDER BY id').all()))
    .toEqual([{ kind: 'agent', status: 'running' }, { kind: 'subagent', status: 'failed' }]);
});

test('child invoice reads retain their own Run and Session while parent consumption needs the exact native feedback', async () => {
  const f = await fixture(); let child: DurableSubagentPlan | null = null;
  const before = need(await f.governor.remainingBudget(f.created.workId));
  const signal = new AbortController().signal;
  const saved = need(await f.bridge.executeTool({ ...f.call, signal, nativeDelegate: async plan => {
    child = plan;
    need(await f.service.callbacks.adopt({ ...plan, nativeConversationId: 51 }));
    const active: DurableSubagentObservation = { ...plan, creation: 'created', nativeConversationId: 51, nativeSubmissionId: 52,
      status: 'placed', answer: null, reason: null, consumedAt: at, execution: 'active', creatorExecution: 'active', parentToolResultEntryId: null,
      parentModelTaskId: null, parentModelReceivedAt: null };
    f.setObservation(active);
    need(await f.service.callbacks.verify(plan));
    need(await f.service.callbacks.reserveModelRequest(plan));
    const owner = { childRunId: plan.childRunId, childSessionId: plan.childSessionId, originToolCallId: plan.originToolCallId };
    const projected = need(await f.service.readWorkingContext({ workId: plan.workId, sessionId: plan.sessionId,
      attemptId: plan.attemptId, requestId: plan.requestId, child: owner }));
    expect(projected.instructions?.role).toBe('invoice-evidence-checker');
    expect(projected.delegation).toMatchObject({ ...owner, prompt: plan.prompt });
    expect(projected.actions.tools).not.toContain('save_invoice_candidate');
    const call = { ...f.call, child: owner, nativeConversationId: 51, nativeTaskId: 53, nativeToolCallId: 'child-wire-read',
      name: 'read_invoice_document', arguments: { documentId: 1, page: 1, afterBlockId: null, limit: 10 } };
    const read = need(await f.bridge.executeTool({ ...call, signal }));
    expect(read).toMatchObject({ status: 'succeeded', data: { documentRef: { id: 1, version: 'v1' }, blocks: [{ text: 'Total 113.00' }] } });
    const feedbackJson = JSON.stringify({ role: 'toolResult', toolCallId: call.nativeToolCallId, toolName: call.name,
      isError: false, content: [{ type: 'text', text: JSON.stringify(read) }], details: read });
    need(await f.bridge.onToolFeedback({ ...call, feedbackJson, nativeEntryId: 54 }));
    const deniedCall = { ...call, nativeTaskId: 55, nativeToolCallId: 'child-wire-denied', name: 'Agent', arguments: f.call.arguments };
    const denied = need(await f.bridge.executeTool({ ...deniedCall, signal }));
    expect(denied).toMatchObject({ status: 'failed', error: { code: 'tool_access_denied' } });
    need(await f.bridge.onToolFeedback({ ...deniedCall, nativeEntryId: 56, feedbackJson: JSON.stringify({ role: 'toolResult',
      toolCallId: deniedCall.nativeToolCallId, toolName: 'Agent', isError: true, content: [], details: denied }) }));
    return ok({ ...active, status: 'done', answer: 'Original total evidence read; parent must review.', execution: 'closed' });
  } }));
  expect(child).not.toBeNull(); const identity = child!;
  expect(await f.service.callbacks.onParentConsumed({ ...identity, nativeToolResultEntryId: 61, nativeModelTaskId: 62, observedAt: at }))
    .toMatchObject({ ok: false, error: { code: 'source_invalid' } });
  const feedbackJson = JSON.stringify({ role: 'toolResult', toolCallId: f.call.nativeToolCallId, toolName: 'Agent', isError: false,
    content: [{ type: 'text', text: JSON.stringify(saved) }], details: saved });
  need(await f.bridge.onToolFeedback({ ...f.call, nativeEntryId: 61, feedbackJson }));
  need(await f.service.callbacks.onParentConsumed({ ...identity, nativeToolResultEntryId: 61, nativeModelTaskId: 62, observedAt: at }));
  expect(need(await f.database.read(scope => scope.invoiceWorkAttempts.get({ workId: f.created.workId, attemptId: f.attemptId }))).children)
    .toMatchObject([{ childRunId: identity.childRunId, parentModelReceivedAt: at }]);
  const after = need(await f.governor.remainingBudget(f.created.workId));
  expect(after.modelCalls).toBe(before.modelCalls - 1);
  expect(await f.database.read(scope => scope.db.query('SELECT run_id,session_id FROM tool_calls WHERE native_tool_call_id=?').get('durable-task:53')))
    .toEqual({ run_id: identity.childRunId, session_id: identity.childSessionId });
});

test('four unknown native child creations keep all slots occupied and an original stop blocks late adoption', async () => {
  const f = await fixture(); const plans: DurableSubagentPlan[] = [];
  for (let index = 0; index < 4; index++) {
    const call = { ...f.call, nativeTaskId: 70 + index, nativeToolCallId: `wire-unknown-${index}` };
    const result = need(await f.bridge.executeTool({ ...call, signal: new AbortController().signal, nativeDelegate: async plan => {
      plans.push(plan); return ok({ ...plan, creation: 'unknown', nativeConversationId: null, nativeSubmissionId: null,
        status: null, answer: null, reason: 'Creation response is unknown.', consumedAt: null, execution: 'unknown', creatorExecution: 'active',
        parentToolResultEntryId: null, parentModelTaskId: null, parentModelReceivedAt: null });
    } }));
    expect(result).toMatchObject({ status: 'succeeded', data: { details: { outcome: 'gap' } } });
    need(await f.bridge.onToolFeedback({ ...call, nativeEntryId: 80 + index, feedbackJson: JSON.stringify({ role: 'toolResult',
      toolCallId: call.nativeToolCallId, toolName: 'Agent', isError: false, content: [{ type: 'text', text: 'Unknown creation' }], details: result }) }));
  }
  expect(await f.bridge.executeTool({ ...f.call, nativeTaskId: 75, nativeToolCallId: 'fifth-child', signal: new AbortController().signal,
    nativeDelegate: async () => { throw Error('The fifth child must never enter native creation.'); } }))
    .toMatchObject({ ok: true, data: { status: 'failed', error: { code: 'subagent_capacity_exceeded' } } });
  await f.database.transaction(scope => { scope.db.query('UPDATE invoice_work_attempts SET stop_requested_at=? WHERE id=?').run(at, f.attemptId); });
  expect(await f.service.callbacks.adopt({ ...plans[0]!, nativeConversationId: 99 })).toMatchObject({ ok: false });
  expect(await f.database.read(scope => scope.db.query("SELECT COUNT(*) count FROM runs WHERE kind='subagent'").get())).toEqual({ count: 4 });
  expect(await f.database.read(scope => scope.db.query('SELECT durable_conversation_id FROM sessions WHERE id=?').get(plans[0]!.childSessionId)))
    .toEqual({ durable_conversation_id: null });
});

test('a child model reservation uses the original Work total and cannot reset it for another delegation', async () => {
  const f = await fixture(); const remaining = need(await f.governor.remainingBudget(f.created.workId));
  const saved = need(await f.bridge.executeTool({ ...f.call, signal: new AbortController().signal, nativeDelegate: async plan => {
    need(await f.service.callbacks.adopt({ ...plan, nativeConversationId: 101 }));
    for (let index = 0; index < remaining.modelCalls; index++) need(await f.service.callbacks.reserveModelRequest(plan));
    expect(await f.service.callbacks.reserveModelRequest(plan)).toMatchObject({ ok: false, error: { code: 'agent_model_call_budget' } });
    return ok({ ...plan, creation: 'created', nativeConversationId: 101, nativeSubmissionId: 102, status: 'unanswered',
      answer: null, reason: 'The authorized model request budget ended.', consumedAt: at, execution: 'closed', creatorExecution: 'active',
      parentToolResultEntryId: null, parentModelTaskId: null, parentModelReceivedAt: null });
  } }));
  need(await f.bridge.onToolFeedback({ ...f.call, nativeEntryId: 103, feedbackJson: JSON.stringify({ role: 'toolResult',
    toolCallId: f.call.nativeToolCallId, toolName: 'Agent', isError: false, content: [], details: saved }) }));
  expect(need(await f.governor.remainingBudget(f.created.workId)).modelCalls).toBe(0);
  expect(await f.bridge.executeTool({ ...f.call, nativeTaskId: 104, nativeToolCallId: 'another-delegation', signal: new AbortController().signal,
    nativeDelegate: async () => { throw Error('A new child cannot reset the Work model budget.'); } }))
    .toMatchObject({ ok: true, data: { status: 'failed', error: { code: 'agent_model_call_budget' } } });
  expect(await f.database.read(scope => scope.db.query("SELECT COUNT(*) count FROM runs WHERE kind='subagent'").get())).toEqual({ count: 1 });
});

test('recreating a tool executor does not reset the persisted Work tool total', async () => {
  const f = await fixture();
  const remaining = need(await f.governor.remainingBudget(f.created.workId));
  for (let index = 0; index < remaining.toolCalls; index++) {
    const executor = createToolExecutor({ database: f.database, definitions: f.definitions, now: () => at });
    const bridge = createInvoiceWorkToolBridge({ database: f.database, executor });
    const call = { ...f.call, nativeTaskId: 200 + index, nativeToolCallId: `recreated-read-${index}`, name: 'read_invoice_document',
      arguments: { documentId: 1, page: 1, afterBlockId: null, limit: 10 } };
    const result = need(await bridge.executeTool({ ...call, signal: new AbortController().signal })); expect(result.status).toBe('succeeded');
    need(await bridge.onToolFeedback({ ...call, nativeEntryId: 300 + index, feedbackJson: JSON.stringify({ role: 'toolResult',
      toolCallId: call.nativeToolCallId, toolName: call.name, isError: false, content: [], details: result }) }));
  }
  const executor = createToolExecutor({ database: f.database, definitions: f.definitions, now: () => at });
  expect(await createInvoiceWorkToolBridge({ database: f.database, executor }).executeTool({ ...f.call, nativeTaskId: 400,
    nativeToolCallId: 'read-over-work-total', name: 'read_invoice_document', arguments: { documentId: 1, page: 1, afterBlockId: null, limit: 10 },
    signal: new AbortController().signal })).toMatchObject({ ok: false, error: { code: 'tool_budget_exceeded' } });
  expect(await f.database.read(scope => scope.db.query('SELECT COUNT(*) count FROM tool_calls').get())).toEqual({ count: remaining.toolCalls });
});

test('a failed delivery observation rolls back its feedback accounting so the original feedback can retry', async () => {
  const f = await fixture();
  const call = { ...f.call, name: 'read_invoice_document', arguments: { documentId: 1, page: 1, afterBlockId: null, limit: 10 } };
  const result = need(await f.bridge.executeTool({ ...call, signal: new AbortController().signal }));
  const feedback = { ...call, nativeEntryId: 501, feedbackJson: JSON.stringify({ role: 'toolResult', toolCallId: call.nativeToolCallId,
    toolName: call.name, isError: false, content: [], details: result }) };
  expect(await f.database.transaction(scope => recordInvoiceWorkToolFeedback(scope.db, feedback, {
    getById: scope.toolCalls.getById, queryCandidateCommit: scope.toolCalls.queryCandidateCommit,
    recordDelivery: () => fail(appError('storage_write_failed', 'storage', 'Controlled delivery commit failure.')) })))
    .toMatchObject({ ok: false, error: { code: 'storage_write_failed' } });
  expect(await f.database.read(scope => scope.db.query('SELECT feedback_native_entry_id,feedback_bytes FROM invoice_work_tool_calls').get()))
    .toEqual({ feedback_native_entry_id: null, feedback_bytes: null });
  need(await f.bridge.onToolFeedback(feedback));
  expect(await f.database.read(scope => scope.db.query('SELECT feedback_native_entry_id FROM invoice_work_tool_calls').get()))
    .toEqual({ feedback_native_entry_id: 501 });
});

test('native service suspension preserves the running original Agent and resumes its same owned child', async () => {
  const f = await fixture(); let original: DurableSubagentPlan | null = null;
  const suspended = await f.bridge.executeTool({ ...f.call, signal: new AbortController().signal, nativeDelegate: async plan => {
    original = plan; need(await f.service.callbacks.adopt({ ...plan, nativeConversationId: 601 }));
    f.setObservation({ ...plan, creation: 'created', nativeConversationId: 601, nativeSubmissionId: 602, status: 'placed',
      answer: null, reason: null, consumedAt: at, execution: 'active', creatorExecution: 'active',
      parentToolResultEntryId: null, parentModelTaskId: null, parentModelReceivedAt: null });
    return fail(appError('durable_delegation_suspended', 'runtime', 'The native service is closing without a user stop.', true));
  } });
  expect(suspended).toMatchObject({ ok: false, error: { code: 'durable_delegation_suspended' } });
  expect(await f.database.read(scope => scope.db.query('SELECT status,result_json,stopped_at FROM tool_calls').get()))
    .toEqual({ status: 'running', result_json: null, stopped_at: null });
  expect(await f.database.read(scope => scope.db.query('SELECT kind,status FROM runs ORDER BY id').all()))
    .toEqual([{ kind: 'agent', status: 'running' }, { kind: 'subagent', status: 'running' }]);
  const executor = createToolExecutor({ database: f.database, definitions: [...f.definitions, f.service.tool], now: () => at });
  const bridge = createInvoiceWorkToolBridge({ database: f.database, executor });
  expect(await bridge.executeTool({ ...f.call, signal: new AbortController().signal, nativeDelegate: async plan => {
    if (original === null) throw Error('Expected the original suspended child plan.');
    expect(plan).toEqual(original);
    return ok({ ...plan, creation: 'created', nativeConversationId: 601, nativeSubmissionId: 602, status: 'done',
      answer: 'The original child recovered its evidence result.', reason: null, consumedAt: at, execution: 'closed', creatorExecution: 'active',
      parentToolResultEntryId: null, parentModelTaskId: null, parentModelReceivedAt: null });
  } })).toMatchObject({ ok: true, data: { status: 'succeeded', data: { details: { outcome: 'reported' } } } });
  expect(await f.database.read(scope => scope.db.query('SELECT COUNT(*) count FROM tool_calls').get())).toEqual({ count: 1 });
  expect(await f.database.read(scope => scope.db.query('SELECT COUNT(*) count FROM runs').get())).toEqual({ count: 2 });
});

test('reconciles native parent consumption after its first Core write failed without repeating execution', async () => {
  const f = await fixture(), observations: DurableSubagentObservation[] = []; let executions = 0;
  const result = need(await f.bridge.executeTool({ ...f.call, signal: new AbortController().signal, nativeDelegate: async plan => {
    executions++; need(await f.service.callbacks.adopt({ ...plan, nativeConversationId: 701 }));
    const observed: DurableSubagentObservation = { ...plan, creation: 'created', nativeConversationId: 701, nativeSubmissionId: 702, status: 'done',
      answer: 'Original evidence report.', reason: null, consumedAt: at, execution: 'closed', creatorExecution: 'active',
      parentToolResultEntryId: null, parentModelTaskId: null, parentModelReceivedAt: null };
    observations.push(observed); return ok(observed);
  } }));
  const observed = observations[0];
  if (observed === undefined) throw Error('Expected the original native child observation.');
  const observation: DurableSubagentObservation = { ...observed, creatorExecution: 'closed',
    parentToolResultEntryId: 703, parentModelTaskId: 704, parentModelReceivedAt: at };
  need(await f.bridge.onToolFeedback({ ...f.call, nativeEntryId: 703, feedbackJson: JSON.stringify({ role: 'toolResult',
    toolCallId: f.call.nativeToolCallId, toolName: 'Agent', isError: false, content: [], details: result }) }));
  await f.database.transaction(scope => scope.db.exec(`CREATE TEMP TRIGGER reject_parent_consumption BEFORE UPDATE OF parent_received_model_task_id
    ON invoice_work_tool_calls BEGIN SELECT RAISE(ABORT,'controlled_parent_consumption_commit_failure'); END;`));
  expect(await f.service.callbacks.onParentConsumed({ ...observation, nativeToolResultEntryId: 703, nativeModelTaskId: 704, observedAt: at }))
    .toMatchObject({ ok: false });
  await f.database.transaction(scope => scope.db.exec('DROP TRIGGER reject_parent_consumption'));
  expect(need(await f.database.read(scope => scope.invoiceWorkAttempts.get({ workId: f.created.workId, attemptId: f.attemptId }))).children[0]?.parentModelReceivedAt)
    .toBeNull();
  f.setObservation(observation);
  need(await f.service.reconcileAttempt({ workId: f.created.workId, sessionId: f.created.sessionId, attemptId: f.attemptId }));
  expect(need(await f.database.read(scope => scope.invoiceWorkAttempts.get({ workId: f.created.workId, attemptId: f.attemptId }))).children[0]?.parentModelReceivedAt)
    .toBe(at);
  f.setObservation({ ...observation, parentModelTaskId: 705, parentModelReceivedAt: '2026-10-29T00:00:01.000Z' });
  need(await f.service.reconcileAttempt({ workId: f.created.workId, sessionId: f.created.sessionId, attemptId: f.attemptId }));
  expect(await f.database.read(scope => scope.db.query('SELECT parent_received_model_task_id,parent_received_at FROM invoice_work_tool_calls').get()))
    .toEqual({ parent_received_model_task_id: 704, parent_received_at: at });
  f.setObservation({ ...observation, parentToolResultEntryId: 706 });
  expect(await f.service.reconcileAttempt({ workId: f.created.workId, sessionId: f.created.sessionId, attemptId: f.attemptId }))
    .toMatchObject({ ok: false, error: { code: 'source_invalid' } });
  expect(executions).toBe(1);
  expect(await f.database.read(scope => scope.db.query('SELECT COUNT(*) count FROM tool_calls').get())).toEqual({ count: 1 });
});
