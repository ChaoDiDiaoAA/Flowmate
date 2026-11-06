import { expect, test } from 'bun:test';
import { invoiceToolSchemas, ok, type Result } from '@flowmate/contracts';
import { buildInvoiceWorkContext } from '../../../packages/runtime-durable/src/context.ts';
import { createInvoiceWorkToolBridge, readInvoiceWorkToolResult, resolveInvoiceWorkToolScope } from '../../../packages/core/src/personal-agent/tool-scope.ts';
import { createInvoiceFormService } from '../../../packages/core/src/tools/invoice-form.ts';
import * as formTools from '../../../packages/core/src/tools/invoice-form.ts';
import { createToolExecutor } from '../../../packages/core/src/tools/executor.ts';
import { invoiceWorkCandidateDraft, invoiceWorkToolsFixture } from '../../support/invoice-work-tools.ts';

const at = '2026-11-06T00:00:00.000Z';
function need<T>(result: Result<T>): T { if (!result.ok) throw Error(result.error.code); return result.data; }

test('a Durable form request derives its invoice and phase from the original product tool call', async () => {
  const f = await invoiceWorkToolsFixture({ at, configuration: { modelId: 'form-model', thinkingLevel: 'off',
    tools: ['save_invoice_candidate', 'personal_observe_invoice_form', 'personal_fill_invoice_form'], resources: { prompt: null, enabledSkills: [] },
    extensions: { enabledExtensions: [] }, workingDirectory: null, preferences: '' } });
  const saved = await f.execute('save_invoice_candidate', { documentId: 1, candidate: invoiceWorkCandidateDraft() }, 'candidate-original');
  if (saved.result.status !== 'succeeded') throw Error(saved.result.error.code);
  const candidate = invoiceToolSchemas.save_invoice_candidate.output.parse(saved.result.data);
  const result = await f.database.transaction(scope => {
    scope.db.query('UPDATE invoice_work_phases SET closed_at=? WHERE id=?').run(at, f.phase.phaseId);
    const selected = need(scope.invoiceWorks.selectPhaseInput({ workId: f.created.workId, itemId: f.itemId, attemptId: f.attemptId }));
    const phase = need(scope.invoiceWorks.freezePhase({ workId: f.created.workId, itemId: f.itemId, attemptId: f.attemptId,
      requestId: 'personal-form-phase', kind: 'prompt', basis: selected.basis, at }));
    need(scope.invoiceWorks.linkPhase({ workId: f.created.workId, attemptId: f.attemptId, phaseId: phase.phaseId,
      nativeConversationId: 101, nativeSubmissionId: 201, at }));
    const context = need(buildInvoiceWorkContext(need(scope.invoiceWorks.readContextInput({ workId: f.created.workId, attemptId: f.attemptId,
      requestId: phase.requestId, remainingBudget: { modelCalls: 12, toolCalls: 24, toolFeedbackBytes: 65536, timeoutMs: 30000, childSlots: 1 } }))));
    need(scope.invoiceWorkContexts.save({ context, at }));
    const workScope = need(resolveInvoiceWorkToolScope(scope.db, { runId: f.runId, sessionId: f.created.sessionId,
      workId: f.created.workId, attemptId: f.attemptId, requestId: phase.requestId })).scope;
    const args = { candidateId: candidate.candidateId, target: { formInstanceId: 'personal-form-1', expectedRevision: 0 } };
    const call = need(scope.toolCalls.request({ context: null, invoiceWorkScope: workScope, runId: f.runId,
      sessionId: f.created.sessionId, nativeToolCallId: 'durable-task:301', toolName: 'personal_fill_invoice_form', toolVersion: '1',
      effect: 'LOCAL_WRITE', rawArguments: args, requestedAt: at }));
    need(scope.toolCalls.fixArguments({ toolCallId: call.toolCallId, finalArguments: args }));
    need(scope.toolCalls.start({ toolCallId: call.toolCallId, startedAt: at }));
    return { phase, callId: call.toolCallId, scope: workScope, request: scope.toolCalls.readFormApplicationRequest(call.toolCallId) };
  });
  expect(result.request).toMatchObject({ ok: true, data: { operation: 'apply', sessionId: f.created.sessionId,
    jobId: f.jobId, candidateId: candidate.candidateId, candidateSequence: candidate.sequence,
    target: { formInstanceId: 'personal-form-1', expectedRevision: 0 },
    invoiceWork: { workId: f.created.workId, itemId: f.itemId, attemptId: f.attemptId, phaseId: result.phase.phaseId } } });
  let dispatches = 0;
  const service = createInvoiceFormService({ database: f.database, now: () => at, bridge: async request => (dispatches++, {
    runId: request.runId, toolCallId: request.toolCallId, formInstanceId: request.target.formInstanceId,
    candidateId: request.candidateId, candidateSequence: request.candidateSequence, observedAt: at,
    outcome: 'applied', appliedAt: at, appliedRevision: request.target.expectedRevision + 1,
  }) });
  const args = { candidateId: candidate.candidateId, target: { formInstanceId: 'personal-form-1', expectedRevision: 0 } };
  expect(await service.apply(args, { nativeToolCallId: 'durable-task:301', signal: new AbortController().signal },
    { runId: f.runId, sessionId: f.created.sessionId, scope: result.scope }))
    .toEqual({ candidateId: candidate.candidateId, candidateSequence: candidate.sequence, applied: true });
  expect(await service.query({ runId: f.runId, toolCallId: result.callId })).toMatchObject({ ok: true, data: { outcome: 'applied' } });
  expect(await f.database.read(scope => readInvoiceWorkToolResult(scope, { workId: f.created.workId, sessionId: f.created.sessionId,
    attemptId: f.attemptId, requestId: 'personal-form-phase', nativeConversationId: 101, nativeTaskId: 301,
    nativeToolCallId: 'wire-301', name: 'personal_fill_invoice_form', arguments: args })))
    .toEqual({ ok: true, data: { status: 'succeeded', data: { candidateId: candidate.candidateId, candidateSequence: candidate.sequence, applied: true } } });
  const create = Reflect.get(formTools, 'createPersonalInvoiceFormTool');
  expect(typeof create).toBe('function'); if (typeof create !== 'function') return;
  const executor = createToolExecutor({ database: f.database, definitions: [create(service)], now: () => at });
  const bridge = createInvoiceWorkToolBridge({ database: f.database, executor });
  const originalCall = { workId: f.created.workId, sessionId: f.created.sessionId, attemptId: f.attemptId, requestId: 'personal-form-phase',
    nativeConversationId: 101, nativeTaskId: 301, nativeToolCallId: 'wire-301', name: 'personal_fill_invoice_form', arguments: args };
  const recovered = { status: 'succeeded', data: { candidateId: candidate.candidateId, candidateSequence: candidate.sequence, applied: true } };
  expect(await bridge.onToolFeedback({ ...originalCall, nativeEntryId: 401, feedbackJson: JSON.stringify({ role: 'toolResult',
    toolCallId: 'wire-301', toolName: originalCall.name, isError: false, details: recovered, content: [{ type: 'text', text: JSON.stringify(recovered) }] }) }))
    .toEqual({ ok: true, data: undefined });
  await f.database.transaction(scope => {
    const call = need(scope.toolCalls.request({ context: null, invoiceWorkScope: result.scope, runId: f.runId,
      sessionId: f.created.sessionId, nativeToolCallId: 'durable-task:302', toolName: 'personal_fill_invoice_form', toolVersion: '1',
      effect: 'LOCAL_WRITE', rawArguments: args, requestedAt: at }));
    need(scope.toolCalls.fixArguments({ toolCallId: call.toolCallId, finalArguments: args }));
    need(scope.toolCalls.start({ toolCallId: call.toolCallId, startedAt: at }));
  });
  const restarted = createInvoiceWorkToolBridge({ database: f.database,
    executor: createToolExecutor({ database: f.database, definitions: [create(service)], now: () => at }) });
  expect(await restarted.executeTool({ ...originalCall, nativeTaskId: 302, nativeToolCallId: 'wire-302', signal: new AbortController().signal }))
    .toMatchObject({ ok: false, error: { code: 'tool_commit_unconfirmed' } });
  expect(dispatches).toBe(1);
  const executed = await executor.execute('personal_fill_invoice_form', args, { runId: f.runId, sessionId: f.created.sessionId,
    scope: result.scope, nativeToolCallId: 'durable-form-2', signal: new AbortController().signal });
  expect(executed.result).toMatchObject({ status: 'succeeded', data: { candidateId: candidate.candidateId, applied: true } });
  expect(executed.call.formApplication).toMatchObject({ outcome: 'applied', formInstanceId: 'personal-form-1' });
  const observe = Reflect.get(formTools, 'createPersonalInvoiceFormObserveTool');
  expect(typeof observe).toBe('function'); if (typeof observe !== 'function') return;
  const reader = createToolExecutor({ database: f.database, definitions: [observe({ database: f.database,
    observe: async () => ok({ candidateId: candidate.candidateId, candidateSequence: candidate.sequence, target: args.target }) })], now: () => at });
  expect((await reader.execute('personal_observe_invoice_form', {}, { runId: f.runId, sessionId: f.created.sessionId,
    scope: result.scope, nativeToolCallId: 'durable-form-read', signal: new AbortController().signal })).result)
    .toMatchObject({ status: 'succeeded', data: { candidateId: candidate.candidateId, target: args.target } });
  const foreign = createToolExecutor({ database: f.database, definitions: [observe({ database: f.database,
    observe: async () => ok({ candidateId: candidate.candidateId + 1, candidateSequence: candidate.sequence, target: args.target }) })], now: () => at });
  expect((await foreign.execute('personal_observe_invoice_form', {}, { runId: f.runId, sessionId: f.created.sessionId,
    scope: result.scope, nativeToolCallId: 'durable-form-foreign', signal: new AbortController().signal })).result)
    .toMatchObject({ status: 'failed', error: { code: 'state_conflict' } });
  const cancelledCall = await f.database.transaction(scope => {
    const call = need(scope.toolCalls.request({ context: null, invoiceWorkScope: result.scope, runId: f.runId,
      sessionId: f.created.sessionId, nativeToolCallId: 'durable-task:303', toolName: 'personal_fill_invoice_form', toolVersion: '1',
      effect: 'LOCAL_WRITE', rawArguments: args, requestedAt: at }));
    need(scope.toolCalls.fixArguments({ toolCallId: call.toolCallId, finalArguments: args }));
    return need(scope.toolCalls.start({ toolCallId: call.toolCallId, startedAt: at }));
  });
  const controller = new AbortController(); controller.abort(); const beforeCancelled = dispatches;
  await expect(service.apply(args, { nativeToolCallId: 'durable-task:303', signal: controller.signal },
    { runId: f.runId, sessionId: f.created.sessionId, scope: result.scope })).rejects.toMatchObject({ code: 'agent_cancelled' });
  expect(dispatches).toBe(beforeCancelled);
  expect(await service.query({ runId: f.runId, toolCallId: cancelledCall.toolCallId }))
    .toMatchObject({ ok: true, data: { outcome: 'not_applied', reason: 'agent_cancelled' } });
  await f.database.transaction(scope => {
    scope.db.exec('DROP TRIGGER invoice_work_context_immutable');
    scope.db.query("UPDATE invoice_work_context_snapshots SET context_json=json_set(context_json,'$.phase.attemptId',999) WHERE phase_id=?")
      .run(result.phase.phaseId);
  });
  expect(await f.database.read(scope => scope.toolCalls.getById(result.callId))).toMatchObject({ ok: false });
});
