import { expect, test } from 'bun:test';
import { BACKGROUND_CONTEXT } from '@earendil-works/chord/context';
import type { TaskId } from '@earendil-works/pi-durable';
import { appError, fail, ok, type DurableAttemptIdentity, type DurableRuntimePort, type ProviderConfig, type Result } from '@flowmate/contracts';
import type { DurableProductToolCall, DurableProductToolFeedback } from '../../packages/contracts/src/durable-runtime.ts';
import { DurableInvoiceGovernor } from '../../packages/core/src/personal-agent/admission.ts';
import { InvoiceWorkModelService } from '../../packages/core/src/personal-agent/models.ts';
import { InvoiceWorkPhaseContextService, InvoiceWorkPhaseObserver } from '../../packages/core/src/personal-agent/phase-context.ts';
import { createInvoiceWorkToolBridge } from '../../packages/core/src/personal-agent/tool-scope.ts';
import { createToolExecutor } from '../../packages/core/src/tools/executor.ts';
import { buildInvoiceWorkContext } from '../../packages/runtime-durable/src/context.ts';
import { createDurableRuntime } from '../../packages/runtime-durable/src/runtime.ts';
import { createDurableSqliteStorage } from '../../packages/runtime-durable/src/storage.ts';
import { toPiParameters } from '../../packages/runtime-pi/src/schema.ts';
import { invoiceWorkCandidateDraft, invoiceWorkToolsFixture } from '../support/invoice-work-tools.ts';

function need<T>(value: Result<T>): T { if (!value.ok) throw Error(`${value.error.code}: ${value.error.message}`); return value.data; }

test.each(['READ', 'PURE', 'receipt', 'receipt-resume', 'receipt-unassembled', 'receipt-model-unknown', 'receipt-other-unknown',
  'receipt-version', 'receipt-revoked', 'receipt-stop', 'receipt-feedback-limit', 'receipt-model-limit',
  'missing-effect', 'LOCAL_WRITE', 'read-error', 'version', 'revoked', 'budget', 'running-read'] as const)(
  'SQLite recovery after a committed native invocation memo preserves product authority: %s', async scenario => {
  let requests = 0, executions = 0, recovering = false, recoveredChecks = 0, recoveredExecutions = 0;
  let original: DurableProductToolCall | undefined, runtime: DurableRuntimePort | undefined;
  const hasReceipt = scenario.startsWith('receipt');
  let name = 'read_invoice_document';
  if (scenario === 'PURE') name = 'validate_invoice_candidate';
  if (scenario === 'LOCAL_WRITE') name = 'save_invoice_candidate';
  const args = name === 'read_invoice_document' ? { documentId: 1, page: 1, afterBlockId: null, limit: 10 }
    : { documentId: 1, candidate: invoiceWorkCandidateDraft() };
  const entered = Promise.withResolvers<void>(), feedback: DurableProductToolFeedback[] = [];
  const server = Bun.serve({ port: 0, fetch: () => {
    const tool = ++requests === 1;
    const delta = tool ? { role: 'assistant', tool_calls: [{ index: 0, id: 'first-invoice-read', type: 'function',
      function: { name, arguments: JSON.stringify(args) } }] }
      : { role: 'assistant', content: 'The original invoice was read.' };
    const chunk = { id: 'invoice-read-recovery', object: 'chat.completion.chunk', created: 1, model: 'invoice-local-model',
      choices: [{ index: 0, delta, finish_reason: tool ? 'tool_calls' : 'stop' }] };
    return new Response(`data: ${JSON.stringify(chunk)}\n\ndata: [DONE]\n\n`, { headers: { 'content-type': 'text/event-stream' } });
  } });
  const provider: ProviderConfig = { version: 1, name: 'invoice-local-profile', revision: 1,
    modelRef: { provider: 'controlled-invoice-provider', model: 'invoice-local-model' },
    native: { authPath: 'unused-auth.json', modelsPath: null },
    connection: { api: 'openai-completions', baseUrl: `http://127.0.0.1:${server.port}/v1`, contextWindow: 64000, maxTokens: 8192 },
    parameters: { maxRetries: 0, maxRetryDelayMs: 1000 } };
  try {
    const f = await invoiceWorkToolsFixture({ provider, at: new Date(Date.now() - 1000).toISOString(),
      ...(scenario === 'receipt-feedback-limit' ? { maxToolFeedbackBytes: 1 } : {}) });
    const now = () => new Date().toISOString(), governor = new DurableInvoiceGovernor(f.database, now, () => false);
    const contexts = new InvoiceWorkPhaseContextService({ database: f.database, now, buildContext: buildInvoiceWorkContext });
    const definitions = f.definitions.map(tool => ({ ...tool, execute: async (...input: Parameters<typeof tool.execute>) => {
      executions++; return tool.execute(...input);
    } }));
    let bridge = createInvoiceWorkToolBridge({ database: f.database,
      executor: createToolExecutor({ database: f.database, definitions, now }) });
    const query = { workId: f.created.workId, sessionId: f.created.sessionId, attemptId: f.attemptId, requestId: f.phase.requestId };
    let observer: InvoiceWorkPhaseObserver;
    const options = {
      readApiKey: () => 'controlled-local-key', verifyModelUse: (input: DurableAttemptIdentity) => governor.verifyModelUse(input),
      verifySchedulingUse: scenario === 'receipt-unassembled' ? undefined
        : (input: DurableAttemptIdentity, pendingFeedback: readonly DurableProductToolCall[]) => governor.verifySchedulingUse(input, pendingFeedback),
      reserveModelRequest: (input: DurableAttemptIdentity) => governor.reserveModelRequest(input),
      readWorkingContext: (input: typeof query) => contexts.get(input), verifyWorkingContext: (input: typeof query) => {
        if (recovering) recoveredChecks++; return contexts.verify(input);
      }, tools: definitions.filter(tool => tool.name === name).map(tool => ({ name: tool.name,
        description: tool.description, executionMode: tool.executionMode,
        ...(scenario === 'missing-effect' ? {} : { effect: tool.effect }), inputSchema: { ...toPiParameters(tool.inputSchema) } })),
      executeTool: async (input: Parameters<typeof bridge.executeTool>[0]) => {
        need(await observer.reconcile(query));
        if (!recovering) {
          const { signal, ...call } = input; original = call; entered.resolve();
          await new Promise<never>((_resolve, reject) => {
            if (signal.aborted) reject(signal.reason);
            else signal.addEventListener('abort', () => reject(signal.reason), { once: true });
          });
        }
        recoveredExecutions++; return bridge.executeTool(input);
      }, readToolResult: (input: DurableProductToolCall) => scenario === 'read-error' && recovering
        ? fail(appError('storage_read_failed', 'storage', 'The original receipt query failed.')) : bridge.readToolResult(input),
      onToolFeedback: (input: DurableProductToolFeedback) => { feedback.push(input); return bridge.onToolFeedback(input); },
    };
    let storage = await createDurableSqliteStorage(f.database.coordinator);
    runtime = need(await createDurableRuntime({ ...options, storage }));
    observer = new InvoiceWorkPhaseObserver({ database: f.database, runtime, now });
    const models = new InvoiceWorkModelService({ database: f.database, runtime, now, resolveConfiguration: () => ok(provider) });
    need(await runtime.openConversation({ workId: query.workId, sessionId: query.sessionId }));
    const binding = need(await models.prepare(query));
    need(await runtime.submit({ ...query, binding, config: provider, text: 'Read the original invoice.' }));
    await entered.promise;
    expect((await storage.task(original!.nativeTaskId as TaskId, BACKGROUND_CONTEXT))?.memos)
      .toMatchObject({ 'flowmate.product-tool.invoked': true });
    expect(await f.database.read(scope => scope.db.query('SELECT COUNT(*) count FROM tool_calls').get())).toEqual({ count: 0 });
    if (hasReceipt) need(await bridge.executeTool({ ...original!, signal: new AbortController().signal }));
    if (scenario === 'receipt') {
      const identity = { workId: query.workId, sessionId: query.sessionId, attemptId: query.attemptId };
      expect(await governor.verifyModelUse(identity)).toMatchObject({ ok: false, error: { code: 'invoice_work_budget_unknown' } });
      expect(await governor.verifySchedulingUse(identity, [original!])).toEqual({ ok: true, data: undefined });
      expect(await governor.verifySchedulingUse(identity, [])).toMatchObject({ ok: false, error: { code: 'invoice_work_budget_unknown' } });
      expect(await governor.verifySchedulingUse(identity, [{ ...original!, arguments: { documentId: 2 } }]))
        .toMatchObject({ ok: false, error: { code: 'state_conflict' } });
    }
    if (scenario === 'receipt-other-unknown') need(await bridge.executeTool({ ...original!, nativeTaskId: original!.nativeTaskId + 100,
      nativeToolCallId: 'unconfirmed-peer', signal: new AbortController().signal }));
    if (scenario === 'LOCAL_WRITE' || scenario === 'running-read') await f.database.transaction(scope => {
      const executor = createToolExecutor({ database: f.database, definitions, now });
      const call = need(executor.observeRequest(name, args, { ...f.product, nativeToolCallId: `durable-task:${original!.nativeTaskId}`,
        signal: new AbortController().signal }, scope));
      need(scope.toolCalls.fixArguments({ toolCallId: call.toolCallId, finalArguments: args }));
      need(scope.toolCalls.start({ toolCallId: call.toolCallId, startedAt: now() }));
    });
    if (scenario === 'budget') await f.database.transaction(scope => {
      const executor = createToolExecutor({ database: f.database, definitions, now });
      for (let index = 0; index < f.config.runtimeBudget.maxToolCalls; index++) need(executor.observeRequest(name, args,
        { ...f.product, nativeToolCallId: `budget-peer-${index}`, signal: new AbortController().signal }, scope));
    });
    const unsettled = await f.database.read(scope => scope.db.query('SELECT status,started_at,result_json,cleanup_json,stopped_at FROM tool_calls').all());
    need(await runtime.close()); runtime = undefined; recovering = true;
    await f.database.transaction(scope => {
      if (scenario === 'version' || scenario === 'receipt-version') scope.db.query("UPDATE documents SET version='v2' WHERE id=1").run();
      if (scenario === 'revoked' || scenario === 'receipt-revoked') need(scope.sessions.revokeDocumentUse({ documentId: 1, at: now() }));
      if (scenario === 'receipt-stop') scope.db.query('UPDATE invoice_work_attempts SET stop_requested_at=? WHERE id=?').run(now(), query.attemptId);
      if (scenario === 'receipt-model-unknown') scope.db.query('DELETE FROM invoice_work_model_reservations WHERE run_id=?').run(f.runId);
      if (scenario === 'receipt-model-limit') scope.db.query('UPDATE invoice_work_model_reservations SET count=? WHERE run_id=?')
        .run(f.config.runtimeBudget.maxModelCalls, f.runId);
    });
    bridge = createInvoiceWorkToolBridge({ database: f.database,
      executor: createToolExecutor({ database: f.database, definitions, now }) });
    storage = await createDurableSqliteStorage(f.database.coordinator);
    expect((await storage.task(original!.nativeTaskId as TaskId, BACKGROUND_CONTEXT))?.memos)
      .toMatchObject({ 'flowmate.product-tool.invoked': true });
    runtime = need(await createDurableRuntime({ ...options, storage }));
    observer = new InvoiceWorkPhaseObserver({ database: f.database, runtime, now });
    need(await runtime.restoreModel({ ...query, binding }));
    if (scenario === 'receipt-resume') need(await runtime.resumeAttempt({ workId: query.workId, sessionId: query.sessionId, attemptId: query.attemptId }));
    const settled = await runtime.waitForSubmission(query), succeeds = ['READ', 'PURE', 'receipt', 'receipt-resume'].includes(scenario);
    if (succeeds) {
      expect(need(settled)).toMatchObject({ status: 'done', answer: 'The original invoice was read.' });
      expect(executions).toBe(1); expect(requests).toBe(2); expect(feedback).toHaveLength(1);
      expect(JSON.parse(feedback[0]!.feedbackJson)).toMatchObject({ isError: false, details: { status: 'succeeded', data: {
        documentRef: { id: 1, version: 'v1' }, ...(scenario === 'PURE' ? { saveable: true } : { blocks: [{ text: 'Total 113.00' }] }) } } });
      expect(await f.database.read(scope => scope.db.query('SELECT COUNT(*) count FROM tool_calls').get())).toEqual({ count: 1 });
      expect(recoveredExecutions).toBe(hasReceipt ? 0 : 1);
      const remaining = need(await governor.remainingBudget(query.workId));
      expect(remaining.toolFeedbackBytes).toBe(f.config.runtimeBudget.maxToolFeedbackBytes - Buffer.byteLength(feedback[0]!.feedbackJson, 'utf8'));
      expect(await governor.verifyModelUse({ workId: query.workId, sessionId: query.sessionId, attemptId: query.attemptId })).toEqual({ ok: true, data: undefined });
    } else {
      expect(settled.ok && settled.data.status === 'done').toBe(false);
      const originalExecutions = hasReceipt ? 1 : 0;
      expect(executions).toBe(scenario === 'receipt-other-unknown' ? 2 : originalExecutions); expect(requests).toBe(1);
      expect(await f.database.read(scope => scope.db.query('SELECT status,started_at,result_json,cleanup_json,stopped_at FROM tool_calls').all())).toEqual(unsettled);
      if (hasReceipt || ['missing-effect', 'LOCAL_WRITE', 'read-error'].includes(scenario)) expect(recoveredExecutions).toBe(0);
      if (scenario === 'receipt-feedback-limit') {
        expect(settled).toMatchObject({ ok: false, error: { code: 'tool_context_limit' } });
        expect(feedback).toHaveLength(1);
        expect(await governor.remainingBudget(query.workId)).toMatchObject({ ok: false, error: { code: 'tool_context_limit' } });
      }
    }
    if (scenario === 'READ' || scenario === 'PURE') expect(recoveredChecks).toBeGreaterThan(0);
    expect(await f.database.read(scope => scope.db.query('SELECT COUNT(*) count FROM invoice_candidates').get())).toEqual({ count: 0 });
  } finally { if (runtime) need(await runtime.close()); server.stop(true); }
}, 15_000);
