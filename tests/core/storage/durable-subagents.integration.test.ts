import { expect, test } from 'bun:test';
import { DurableSubagentConfigSnapshotSchema, DurableSubagentRunOutputSchema, DurableSubagentRunScopeSchema,
  PersonalAgentConfigurationSchema, appError, type DurableSubagentObservation, type Result } from '@flowmate/contracts';
import type { NewDurableSubagentRun, TerminalWrite } from '../../../packages/core/src/storage/repositories.ts';
import { invoiceWorkToolsFixture } from '../../support/invoice-work-tools.ts';
import { openTestDatabase } from '../../support/database.ts';

const at = '2026-10-29T00:00:00.000Z', endedAt = '2026-10-29T00:00:01.000Z';
function need<T>(result: Result<T>): T { if (!result.ok) throw Error(`${result.error.code}: ${result.error.message}`); return result.data; }
async function fixture() {
  return invoiceWorkToolsFixture({ configuration: PersonalAgentConfigurationSchema.parse({ modelId: null, thinkingLevel: 'off',
    tools: ['Agent', 'read_invoice_document'], resources: { prompt: null, enabledSkills: [] },
    extensions: { enabledExtensions: [] }, workingDirectory: null, preferences: '' }) });
}
type Fixture = Awaited<ReturnType<typeof fixture>>;
async function request(f: Fixture, nativeToolTaskId = 10): Promise<NewDurableSubagentRun> {
  const args = { prompt: 'Verify the total using the original invoice.', description: 'Check invoice total',
    subagent_type: 'invoice-evidence-checker', run_in_background: false as const };
  const originToolCallId = await f.database.transaction(store => {
    const call = need(store.toolCalls.request({ runId: f.runId, sessionId: f.created.sessionId,
      nativeToolCallId: `durable-task:${nativeToolTaskId}`, toolName: 'Agent', toolVersion: '1.4.0-p18', effect: 'READ',
      invoiceWorkScope: f.product.scope, rawArguments: args, context: null, requestedAt: at }));
    need(store.toolCalls.fixArguments({ toolCallId: call.toolCallId, finalArguments: args }));
    need(store.toolCalls.start({ toolCallId: call.toolCallId, startedAt: at }));
    return call.toolCallId;
  });
  const subagent = { parentRunId: f.runId, originToolCallId, phaseId: f.phase.phaseId, itemId: f.itemId,
    parentRequestId: f.phase.requestId, role: 'invoice-evidence-checker' as const };
  return { parentRunId: f.runId, originToolCallId, nativeToolTaskId, args, at,
    config: DurableSubagentConfigSnapshotSchema.parse({ ...f.config, version: 4, subagent }),
    scope: DurableSubagentRunScopeSchema.parse({ version: 5, workId: f.created.workId, attemptId: f.attemptId, ...subagent,
      allowedTools: ['read_invoice_document'], allowedDocumentIds: [1], allowedArtifactIds: [1, 2], allowedResourcePaths: [] }) };
}
function terminal(input: NewDurableSubagentRun, stopped = true): TerminalWrite {
  return { status: stopped ? 'completed' : 'failed', output: stopped ? DurableSubagentRunOutputSchema.parse({ version: 4,
    text: 'The original total is 113.00; semantic review is still required.', partial: false, stopReason: 'stop',
    responseId: null, responseModel: null, durable: { workId: input.scope.workId, attemptId: input.scope.attemptId },
    subagent: input.config.subagent }) : null, error: stopped ? null : appError('stop_not_confirmed', 'runtime', 'Original child is still owned.'),
    usage: { version: 1, source: 'not-requested', reason: 'controlled-child', sdkValues: null, attempts: 0,
      attemptsComplete: true, costSource: null, updatedAt: endedAt },
    tokens: { inputTokens: null, outputTokens: null, totalTokens: null, cost: null, usageComplete: false },
    cleanup: { version: 1, stopped, stopReason: stopped ? 'native-stop' : 'stop-unconfirmed', errors: [], lateObservationRequired: !stopped },
    endedAt, stoppedAt: stopped ? endedAt : null, durationMs: 1000 };
}

test('one original Durable Agent call owns one real child Run and Durable Session across reopen', async () => {
  const f = await fixture(), input = await request(f);
  const child = need(await f.database.transaction(store => store.runs.createDurableSubagent(input)));
  expect(await f.database.transaction(store => store.runs.createDurableSubagent(structuredClone(input)))).toEqual({ ok: true, data: child });
  const saved = need(await f.database.read(store => store.runs.get(child.runId)));
  expect(saved).toMatchObject({ kind: 'subagent', runtimeKind: 'durable', jobId: null, sessionId: child.sessionId,
    parentRunId: f.runId, originToolCallId: input.originToolCallId, config: input.config, scope: input.scope, status: 'created' });
  expect('pluginAgentId' in saved).toBe(false);
  expect(await f.database.read(store => store.db.query('SELECT native_session_id,durable_conversation_id FROM sessions WHERE id=?').get(child.sessionId)))
    .toEqual({ native_session_id: null, durable_conversation_id: null });
  expect(await f.database.read(store => store.db.query('SELECT COUNT(*) count FROM session_inputs WHERE run_id=?').get(child.runId))).toEqual({ count: 0 });
  expect(await f.database.transaction(store => store.runs.start(child.runId, input.config, at))).toMatchObject({ ok: false });
  need(await f.database.transaction(store => store.sessions.bindDurableConversation(child.sessionId, 81, at)));
  need(await f.database.transaction(store => store.runs.start(child.runId, input.config, at)));
  expect(await f.database.transaction(store => store.runs.finish(child.runId, terminal(input)))).toEqual({ ok: true, data: true });
  expect(need(await f.database.read(store => store.toolCalls.getById(input.originToolCallId))))
    .toMatchObject({ status: 'running', result: null, delivery: { state: 'not_attempted' } });
  expect(await f.database.read(store => store.runs.listSubagents({ parentRunId: f.runId, limit: 20 }))).toMatchObject({ ok: false });
  expect(await f.database.read(store => store.runs.querySubagent({ parentRunId: f.runId, parentSessionId: f.created.sessionId, childRunId: child.runId })))
    .toMatchObject({ ok: false });
  await f.database.close();
  const reopened = need(openTestDatabase(f.paths));
  expect(need(await reopened.read(store => store.runs.get(child.runId))))
    .toMatchObject({ runtimeKind: 'durable', status: 'completed', output: { text: expect.stringContaining('113.00') } });
  expect(need(await reopened.read(store => store.sessions.get(child.sessionId))))
    .toMatchObject({ runtimeKind: 'durable', durableConversationId: 81 });
  await reopened.close();
});

test('Durable child admission rejects another creator, changed arguments, model or material expansion', async () => {
  const f = await fixture(), input = await request(f);
  for (const changed of [
    { ...input, nativeToolTaskId: 11 },
    { ...input, args: { ...input.args, prompt: 'A different delegation' } },
    { ...input, config: { ...input.config, requestedModel: { provider: 'controlled', model: 'different' } } },
    { ...input, scope: { ...input.scope, allowedDocumentIds: [1, 2], allowedArtifactIds: [1, 2, 3, 4] } },
    { ...input, config: { ...input.config, runtimeBudget: { ...input.config.runtimeBudget, maxModelCalls: input.config.runtimeBudget.maxModelCalls + 1 } } },
  ]) expect(await f.database.transaction(store => store.runs.createDurableSubagent(changed))).toMatchObject({ ok: false });
  expect(await f.database.read(store => store.db.query("SELECT COUNT(*) count FROM runs WHERE kind='subagent'").get())).toEqual({ count: 0 });
  const child = need(await f.database.transaction(store => store.runs.createDurableSubagent(input)));
  expect(await f.database.transaction(store => store.runs.createDurableSubagent({ ...input, args: { ...input.args, prompt: 'Replace original' } })))
    .toMatchObject({ ok: false });
  expect(need(await f.database.read(store => store.runs.get(child.runId))).input.text).toBe(input.args.prompt);
  await f.database.close();
});

test('four unknown or unconfirmed Durable children retain capacity after their creator returns', async () => {
  const f = await fixture(), children = [];
  for (const taskId of [10, 11, 12, 13]) {
    const input = await request(f, taskId);
    children.push({ input, child: need(await f.database.transaction(store => store.runs.createDurableSubagent(input))) });
  }
  const fifth = await request(f, 14);
  expect(await f.database.transaction(store => store.runs.createDurableSubagent(fifth))).toMatchObject({ ok: false, error: { code: 'subagent_busy' } });
  const first = children[0]!;
  need(await f.database.transaction(store => store.sessions.bindDurableConversation(first.child.sessionId, 81, at)));
  need(await f.database.transaction(store => store.runs.start(first.child.runId, first.input.config, at)));
  need(await f.database.transaction(store => store.runs.finish(first.child.runId, terminal(first.input, false))));
  expect(await f.database.transaction(store => store.runs.createDurableSubagent(fifth))).toMatchObject({ ok: false, error: { code: 'subagent_busy' } });
  expect(await f.database.read(store => store.db.query("SELECT COUNT(*) count FROM runs WHERE kind='subagent'").get())).toEqual({ count: 4 });
  await f.database.close();
});

test('persisted root stop closes child creation and the original reserved child start', async () => {
  const f = await fixture(), input = await request(f);
  const child = need(await f.database.transaction(store => store.runs.createDurableSubagent(input)));
  expect(await f.database.read(store => store.runs.verifyDurableSubagentAdmission(child.runId))).toEqual({ ok: true, data: undefined });
  const another = await request(f, 11);
  need(await f.database.transaction(store => store.runs.recordCancel(f.runId, endedAt)));
  expect(await f.database.read(store => store.runs.verifyDurableSubagentAdmission(child.runId))).toMatchObject({ ok: false });
  need(await f.database.transaction(store => store.sessions.bindDurableConversation(child.sessionId, 81, at)));
  expect(await f.database.transaction(store => store.runs.start(child.runId, input.config, endedAt))).toMatchObject({ ok: false });
  expect(await f.database.transaction(store => store.runs.createDurableSubagent(another))).toMatchObject({ ok: false });
  expect(need(await f.database.read(store => store.runs.get(child.runId))).status).toBe('created');
  await f.database.close();
});

test('real child tool calls retain their own Run while binding the original parent invoice phase', async () => {
  const f = await fixture(), input = await request(f);
  const child = need(await f.database.transaction(store => store.runs.createDurableSubagent(input)));
  need(await f.database.transaction(store => store.sessions.bindDurableConversation(child.sessionId, 81, at)));
  need(await f.database.transaction(store => store.runs.start(child.runId, input.config, at)));
  const call = need(await f.database.transaction(store => store.toolCalls.request({ runId: child.runId, sessionId: child.sessionId,
    nativeToolCallId: 'durable-task:91', toolName: 'read_invoice_document', toolVersion: '1.0.0', effect: 'READ',
    invoiceWorkScope: { ...f.product.scope, allowedTools: ['read_invoice_document'] }, rawArguments: { documentId: 1 }, context: null, requestedAt: at })));
  expect(call).toMatchObject({ runId: child.runId, sessionId: child.sessionId, status: 'requested', context: null });
  expect(await f.database.read(store => store.db.query('SELECT phase_id FROM invoice_work_tool_calls WHERE tool_call_id=?').get(call.toolCallId)))
    .toEqual({ phase_id: f.phase.phaseId });
  expect(need(await f.database.read(store => store.runs.get(child.runId))).toolCallCount).toBe(1);
  expect(need(await f.database.read(store => store.runs.get(f.runId))).toolCallCount).toBe(1);
  await f.database.close();
});

test('a late native closed observation confirms stop without replacing the original failed child outcome', async () => {
  const f = await fixture(), input = await request(f);
  const child = need(await f.database.transaction(store => store.runs.createDurableSubagent(input)));
  need(await f.database.transaction(store => store.sessions.bindDurableConversation(child.sessionId, 81, at)));
  need(await f.database.transaction(store => store.runs.start(child.runId, input.config, at)));
  need(await f.database.transaction(store => store.runs.finish(child.runId, terminal(input, false))));
  const before = need(await f.database.read(store => store.runs.get(child.runId)));
  const observation: DurableSubagentObservation = { workId: f.created.workId, sessionId: f.created.sessionId, attemptId: f.attemptId,
    requestId: f.phase.requestId, childRunId: child.runId, childSessionId: child.sessionId,
    originToolCallId: input.originToolCallId, nativeToolTaskId: input.nativeToolTaskId, creation: 'created', nativeConversationId: 81,
    nativeSubmissionId: 82, status: 'unanswered', answer: null, reason: 'aborted', consumedAt: null, execution: 'closed', creatorExecution: 'active',
    parentToolResultEntryId: null, parentModelTaskId: null, parentModelReceivedAt: null };
  for (const changed of [{ ...observation, execution: 'unknown' as const }, { ...observation, nativeConversationId: 99 },
    { ...observation, nativeToolTaskId: 99 }]) expect(await f.database.transaction(store => store.runs.confirmDurableSubagentStop({ observation: changed, at: endedAt })))
    .toMatchObject({ ok: false });
  expect(await f.database.transaction(store => store.runs.confirmDurableSubagentStop({ observation, at: endedAt }))).toEqual({ ok: true, data: true });
  const after = need(await f.database.read(store => store.runs.get(child.runId)));
  expect(after).toMatchObject({ status: 'failed', output: before.output, error: before.error, endedAt: before.endedAt,
    stoppedAt: endedAt, cleanup: { stopped: true, lateObservationRequired: false } });
  expect(await f.database.transaction(store => store.runs.confirmDurableSubagentStop({ observation, at: '2026-10-29T00:00:02.000Z' })))
    .toEqual({ ok: true, data: true });
  expect(need(await f.database.read(store => store.runs.get(child.runId))).stoppedAt).toBe(endedAt);
  await f.database.close();
});

test('a late creator closure confirms only the original terminal Agent cleanup and preserves its diagnostic and delivery', async () => {
  const f = await fixture(), input = await request(f);
  const child = need(await f.database.transaction(store => store.runs.createDurableSubagent(input)));
  need(await f.database.transaction(store => store.sessions.bindDurableConversation(child.sessionId, 81, at)));
  need(await f.database.transaction(store => store.runs.start(child.runId, input.config, at)));
  need(await f.database.transaction(store => store.runs.finish(child.runId, terminal(input, false))));
  const error = appError('stop_not_confirmed', 'runtime', 'The original creator has not confirmed termination.');
  need(await f.database.transaction(store => store.toolCalls.finish({ toolCallId: input.originToolCallId,
    result: { version: 1, status: 'failed', error, committedCandidateId: null },
    cleanup: { version: 1, stopped: false, stopReason: 'stop-grace-exhausted', errors: [error] }, endedAt, stoppedAt: null })));
  const before = need(await f.database.read(store => store.toolCalls.getById(input.originToolCallId)));
  const observation: DurableSubagentObservation = { workId: f.created.workId, sessionId: f.created.sessionId, attemptId: f.attemptId,
    requestId: f.phase.requestId, childRunId: child.runId, childSessionId: child.sessionId,
    originToolCallId: input.originToolCallId, nativeToolTaskId: input.nativeToolTaskId, creation: 'created', nativeConversationId: 81,
    nativeSubmissionId: 82, status: 'unanswered', answer: null, reason: 'aborted', consumedAt: null, execution: 'closed', creatorExecution: 'active',
    parentToolResultEntryId: null, parentModelTaskId: null, parentModelReceivedAt: null };
  need(await f.database.transaction(store => store.runs.confirmDurableSubagentStop({ observation, at: endedAt })));
  expect(await f.database.transaction(store => store.runs.confirmDurableDelegationStop({ observation, at: endedAt }))).toMatchObject({ ok: false });
  expect(need(await f.database.read(store => store.toolCalls.getById(input.originToolCallId))).cleanup.stopped).toBe(false);
  expect(await f.database.transaction(store => store.runs.confirmDurableDelegationStop({ observation: { ...observation, creatorExecution: 'closed' }, at: endedAt })))
    .toEqual({ ok: true, data: true });
  expect(need(await f.database.read(store => store.toolCalls.getById(input.originToolCallId))))
    .toMatchObject({ status: 'failed', result: before.result, delivery: before.delivery, endedAt: before.endedAt,
      stoppedAt: endedAt, cleanup: { stopped: true, errors: [error] } });
  expect(need(await f.database.read(store => store.runs.get(f.runId)))).toMatchObject({ status: 'running', stoppedAt: null });
  await f.database.close();
});

test('actual parent consumption requires a committed feedback entry and preserves the first positive receipt', async () => {
  const f = await fixture(), input = await request(f);
  await expect(f.database.transaction(store => store.db.query(`UPDATE invoice_work_tool_calls SET
    parent_received_model_task_id=31,parent_received_at=? WHERE tool_call_id=?`).run(endedAt, input.originToolCallId))).rejects.toThrow();
  await expect(f.database.transaction(store => store.db.query(`UPDATE invoice_work_tool_calls SET
    parent_received_model_task_id=31 WHERE tool_call_id=?`).run(input.originToolCallId))).rejects.toThrow();
  await f.database.transaction(store => store.db.query(`UPDATE invoice_work_tool_calls SET
    feedback_native_entry_id=21,feedback_bytes=80,parent_received_model_task_id=31,parent_received_at=? WHERE tool_call_id=?`)
    .run(endedAt, input.originToolCallId));
  expect(await f.database.read(store => store.db.query(`SELECT parent_received_model_task_id,parent_received_at
    FROM invoice_work_tool_calls WHERE tool_call_id=?`).get(input.originToolCallId)))
    .toEqual({ parent_received_model_task_id: 31, parent_received_at: endedAt });
  await expect(f.database.transaction(store => store.db.query(`UPDATE invoice_work_tool_calls SET
    parent_received_model_task_id=32 WHERE tool_call_id=?`).run(input.originToolCallId))).rejects.toThrow();
  await f.database.close();
});
