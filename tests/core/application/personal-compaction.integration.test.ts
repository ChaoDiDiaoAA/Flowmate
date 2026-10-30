import { expect, test } from 'bun:test';
import { DurableSubagentConfigSnapshotSchema, DurableSubagentRunScopeSchema, INVOICE_REVIEW_TOOL_NAMES,
  PersonalAgentConfigurationSchema, ok, type DurableCompactionRequest, type DurableSubagentIdentity, type Result } from '@flowmate/contracts';
import { createInvoiceWorkCompactionCallbacks } from '../../../packages/core/src/personal-agent/compaction.ts';
import { DurableInvoiceGovernor } from '../../../packages/core/src/personal-agent/admission.ts';
import { InvoiceWorkPhaseContextService } from '../../../packages/core/src/personal-agent/phase-context.ts';
import { createDurableInvoiceSubagentService } from '../../../packages/core/src/personal-agent/subagents.ts';
import { prepareDurableModelBinding } from '../../../packages/runtime-durable/src/models.ts';
import { buildInvoiceWorkContext } from '../../../packages/runtime-durable/src/context.ts';
import { invoiceWorkToolsFixture } from '../../support/invoice-work-tools.ts';

const at = '2026-10-29T00:00:00.000Z';
function need<T>(result: Result<T>): T { if (!result.ok) throw Error(`${result.error.code}: ${result.error.message}`); return result.data; }

async function fixture() {
  const provider = { version: 1 as const, name: 'original-compaction-model', revision: 1,
    modelRef: { provider: 'controlled-compaction', model: 'original' }, native: { authPath: 'C:/controlled-unused/auth.json', modelsPath: null },
    connection: { baseUrl: 'http://127.0.0.1:1/v1', api: 'openai-completions' as const, contextWindow: 64000, maxTokens: 8192, reasoning: true },
    parameters: { maxRetries: 0, maxRetryDelayMs: 1000 } };
  const configuration = PersonalAgentConfigurationSchema.parse({ modelId: provider.name, thinkingLevel: 'high',
    tools: [...INVOICE_REVIEW_TOOL_NAMES, 'Agent'], resources: { prompt: null, enabledSkills: [] },
    extensions: { enabledExtensions: [] }, workingDirectory: null, preferences: '' });
  const f = await invoiceWorkToolsFixture({ provider, configuration }), binding = need(await prepareDurableModelBinding(provider));
  await f.database.transaction(store => {
    need(store.invoiceWorks.linkPhase({ workId: f.created.workId, attemptId: f.attemptId, phaseId: f.phase.phaseId,
      nativeConversationId: 11, nativeSubmissionId: 12, at }));
    need(store.invoiceWorkModelBindings.save({ workId: f.created.workId, attemptId: f.attemptId,
      modelId: provider.name, binding, at }));
  });
  const governor = new DurableInvoiceGovernor(f.database, () => at, () => false);
  const contexts = new InvoiceWorkPhaseContextService({ database: f.database, now: () => at, buildContext: buildInvoiceWorkContext });
  const subagents = createDurableInvoiceSubagentService({ database: f.database, governor, now: () => at, observeSubagent: async () => ok(null) });
  const callbacks = createInvoiceWorkCompactionCallbacks({ database: f.database, governor, contexts, subagents: subagents.callbacks });
  const request: DurableCompactionRequest = { workId: f.created.workId, sessionId: f.created.sessionId, attemptId: f.attemptId,
    requestId: f.phase.requestId, operationId: 'original-summary', reason: 'threshold', expectedTailEntryId: 20, instructions: null };
  const reservations = () => f.database.read(store => store.db.query<{ count: number }, []>(
    'SELECT COALESCE(SUM(count),0) count FROM invoice_work_model_reservations').get()!.count);
  return { ...f, provider, binding, governor, callbacks, contexts, subagents, request, reservations };
}

test('compaction reads the original phase model and thinking without reserving or following later defaults', async () => {
  const f = await fixture();
  try {
    const plan = need(await f.callbacks.readPlan(f.request));
    expect(plan).toEqual({ ...f.request, binding: f.binding, thinkingLevel: 'high' });
    expect(await f.reservations()).toBe(0);
    await f.database.transaction(store => {
      const agent = need(store.personalAgents.getDefault()); if (!agent) throw Error('Expected original agent.');
      need(store.personalAgents.update({ personalAgentId: agent.personalAgentId, expectedRevision: agent.revision, at,
        configuration: { ...agent.configuration, modelId: 'different-later-default', thinkingLevel: 'off' } }));
    });
    expect(need(await f.callbacks.readPlan(f.request))).toEqual(plan);
    expect(await f.callbacks.verify({ ...plan, thinkingLevel: 'off' })).toMatchObject({ ok: false });
    expect(await f.callbacks.reserveModelRequest({ ...plan, binding: { ...plan.binding,
      configuration: { ...plan.binding.configuration, revision: 2 } } })).toMatchObject({ ok: false });
    for (const changed of [{ requestId: 'foreign-phase' }, { attemptId: f.attemptId + 1 }, { sessionId: f.created.sessionId + 1 }])
      expect(await f.callbacks.readPlan({ ...f.request, ...changed })).toMatchObject({ ok: false });
    expect(await f.reservations()).toBe(0);
  } finally { await f.database.close(); }
});

test('separate summary operations consume the original Work quota and cannot reserve beyond it', async () => {
  const f = await fixture();
  try {
    const before = need(await f.governor.remainingBudget(f.created.workId)), first = need(await f.callbacks.readPlan(f.request));
    need(await f.callbacks.reserveModelRequest(first));
    const second = need(await f.callbacks.readPlan({ ...f.request, operationId: 'second-summary' }));
    need(await f.callbacks.reserveModelRequest(second));
    expect(await f.reservations()).toBe(2);
    expect(need(await f.governor.remainingBudget(f.created.workId)).modelCalls).toBe(before.modelCalls - 2);
    for (let index = 2; index < before.modelCalls; index++) need(await f.callbacks.reserveModelRequest(second));
    expect(await f.reservations()).toBe(before.modelCalls);
    expect(await f.callbacks.reserveModelRequest(second)).toMatchObject({ ok: false, error: { code: 'agent_model_call_budget' } });
    expect(await f.reservations()).toBe(before.modelCalls);
  } finally { await f.database.close(); }
});

test('a lost reservation receipt returns a safe failure while preserving the committed budget debit', async () => {
  const f = await fixture();
  try {
    const callbacks = createInvoiceWorkCompactionCallbacks({ database: f.database, contexts: f.contexts, governor: {
      verifyModelUse: identity => f.governor.verifyModelUse(identity),
      reserveModelRequest: async identity => { need(await f.governor.reserveModelRequest(identity)); throw Error('PRIVATE_RESERVATION_RECEIPT'); },
    } });
    const plan = need(await callbacks.readPlan(f.request)), result = await callbacks.reserveModelRequest(plan);
    expect(result).toMatchObject({ ok: false, error: { code: 'storage_write_failed', retryable: true } });
    expect(JSON.stringify(result)).not.toContain('PRIVATE_RESERVATION_RECEIPT');
    expect(await f.reservations()).toBe(1);
  } finally { await f.database.close(); }
});

test('a user stop or cancelled Work prevents further summary use without changing the prior reservation', async () => {
  for (const cancelledWork of [false, true]) {
    const f = await fixture();
    try {
      const plan = need(await f.callbacks.readPlan(f.request)); need(await f.callbacks.reserveModelRequest(plan));
      await f.database.transaction(store => {
        if (!cancelledWork) need(store.runs.recordCancel(f.runId, at));
        else {
          const work = need(store.invoiceWorks.get({ view: 'work', workId: f.created.workId, limit: 1 }));
          need(store.invoiceWorks.cancelWork({ workId: f.created.workId, requestId: 'cancel-original-work', expectedRevision: work.work.revision }, { at }));
        }
      });
      expect(await f.callbacks.verify(plan)).toMatchObject({ ok: false });
      expect(await f.callbacks.reserveModelRequest(plan)).toMatchObject({ ok: false });
      expect(await f.reservations()).toBe(1);
      expect(need(await f.database.read(store => store.runs.get(f.runId))).status).toBe('running');
    } finally { await f.database.close(); }
  }
});

test('an ended Root or closed original phase cannot authorize another summary reservation', async () => {
  for (const closePhase of [false, true]) {
    const f = await fixture();
    try {
      const plan = need(await f.callbacks.readPlan(f.request));
      await f.database.transaction(store => {
        if (closePhase) need(store.invoiceWorks.recordPhaseObservation({ observation: { workId: f.created.workId,
          sessionId: f.created.sessionId, attemptId: f.attemptId, requestId: f.phase.requestId, nativeConversationId: 11,
          nativeSubmissionId: 12, nativeEntryId: null, status: 'done', consumedAt: null, execution: 'closed' }, at }));
        else {
          const original = need(store.runs.get(f.runId));
          need(store.runs.finish(f.runId, { status: 'completed', output: { version: 3, text: 'The original Root ended.', partial: false,
            stopReason: 'stop', responseId: null, responseModel: null, durable: { workId: f.created.workId, attemptId: f.attemptId } },
          error: null, usage: original.usage, tokens: { inputTokens: null, outputTokens: null, totalTokens: null, cost: null, usageComplete: false },
          cleanup: { version: 1, errors: [], stopped: true, stopReason: 'controlled-native-stop', lateObservationRequired: false },
          endedAt: at, stoppedAt: at, durationMs: 0 }));
        }
      });
      expect(await f.callbacks.readPlan(f.request)).toMatchObject({ ok: false });
      expect(await f.callbacks.verify(plan)).toMatchObject({ ok: false });
      expect(await f.callbacks.reserveModelRequest(plan)).toMatchObject({ ok: false });
      expect(await f.reservations()).toBe(0);
      expect(await f.database.read(store => store.db.query('SELECT COUNT(*) count FROM runs').get())).toEqual({ count: 1 });
    } finally { await f.database.close(); }
  }
});

test('a real read-only child summary uses its original parent phase and the same shared Work quota', async () => {
  const f = await fixture();
  try {
    const child: DurableSubagentIdentity = await f.database.transaction(store => {
      const args = { subagent_type: 'invoice-evidence-checker', description: 'Check total', prompt: 'Verify only the original total.', run_in_background: false as const };
      const call = need(store.toolCalls.request({ runId: f.runId, sessionId: f.created.sessionId, nativeToolCallId: 'durable-task:91',
        toolName: 'Agent', toolVersion: '1.4.0-p18', effect: 'READ', invoiceWorkScope: f.product.scope, rawArguments: args, context: null, requestedAt: at }));
      need(store.toolCalls.fixArguments({ toolCallId: call.toolCallId, finalArguments: args }));
      need(store.toolCalls.start({ toolCallId: call.toolCallId, startedAt: at }));
      const source = { parentRunId: f.runId, originToolCallId: call.toolCallId, phaseId: f.phase.phaseId, itemId: f.itemId,
        parentRequestId: f.phase.requestId, role: 'invoice-evidence-checker' as const };
      const made = need(store.runs.createDurableSubagent({ parentRunId: f.runId, originToolCallId: call.toolCallId, nativeToolTaskId: 91,
        args, at, config: DurableSubagentConfigSnapshotSchema.parse({ ...f.config, version: 4, subagent: source }),
        scope: DurableSubagentRunScopeSchema.parse({ ...source, version: 5, workId: f.created.workId, attemptId: f.attemptId,
          allowedTools: ['read_invoice_document'], allowedDocumentIds: [1], allowedArtifactIds: [1, 2], allowedResourcePaths: [] }) }));
      return { workId: f.created.workId, sessionId: f.created.sessionId, attemptId: f.attemptId, requestId: f.phase.requestId,
        childRunId: made.runId, childSessionId: made.sessionId, originToolCallId: call.toolCallId, nativeToolTaskId: 91 };
    });
    need(await f.subagents.callbacks.adopt({ ...child, nativeConversationId: 31 }));
    const before = need(await f.governor.remainingBudget(f.created.workId));
    const rootPlan = need(await f.callbacks.readPlan(f.request)); need(await f.callbacks.reserveModelRequest(rootPlan));
    const childPlan = need(await f.callbacks.readPlan({ ...f.request, operationId: 'original-child-summary', child }));
    expect(childPlan.binding).toEqual(f.binding); expect(childPlan.thinkingLevel).toBe('high');
    need(await f.callbacks.reserveModelRequest(childPlan));
    expect(need(await f.governor.remainingBudget(f.created.workId)).modelCalls).toBe(before.modelCalls - 2);
    const counts = await f.database.read(store => store.db.query<{ run_id: number; count: number }, []>(
      'SELECT run_id,count FROM invoice_work_model_reservations ORDER BY run_id').all());
    expect(counts).toEqual([{ run_id: f.runId, count: 1 }, { run_id: child.childRunId, count: 1 }]);
    expect(await f.callbacks.reserveModelRequest({ ...childPlan, child: { ...child, nativeToolTaskId: 92 } })).toMatchObject({ ok: false });
    need(await f.database.transaction(store => store.runs.recordCancel(child.childRunId, at)));
    expect(await f.callbacks.verify(childPlan)).toMatchObject({ ok: false });
    expect(await f.callbacks.reserveModelRequest(childPlan)).toMatchObject({ ok: false });
    expect(await f.reservations()).toBe(2);
  } finally { await f.database.close(); }
});
