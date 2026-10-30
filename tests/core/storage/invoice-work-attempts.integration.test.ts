import { expect, test } from 'bun:test';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { appError, fail, DurableRunConfigSnapshotSchema, DurableRunOutputSchema, DurableWorkBudgetSchema,
  PersonalAgentConfigurationSchema, type CleanupRecord, type DurableAttemptStopResult, type Result,
  type UsageRecord, type DurableRuntimePort, type ProviderConfig, type DurableProductToolCall } from '@flowmate/contracts';
import { createInvoiceWorkAttemptRepository } from '../../../packages/core/src/personal-agent/attempts.ts';
import { InvoiceWorkPhaseContextService, InvoiceWorkPhaseObserver } from '../../../packages/core/src/personal-agent/phase-context.ts';
import { createInvoiceWorkToolBridge } from '../../../packages/core/src/personal-agent/tool-scope.ts';
import { InvoiceWorkModelService } from '../../../packages/core/src/personal-agent/models.ts';
import { DurableInvoiceGovernor } from '../../../packages/core/src/personal-agent/admission.ts';
import { createToolExecutor } from '../../../packages/core/src/tools/executor.ts';
import { toPiParameters } from '../../../packages/runtime-pi/src/schema.ts';
import { buildInvoiceWorkContext } from '../../../packages/runtime-durable/src/context.ts';
import { createDurableRuntime, createDurableSqliteStorage } from '@flowmate/runtime-durable';
import type { DbHandle, SqlDatabaseStore } from '../../../packages/core/src/storage/database.ts';
import type { TerminalWrite } from '../../../packages/core/src/storage/repositories.ts';
import { openTestDatabase } from '../../support/database.ts';
import { mkdtempSync } from '../../support/resources.ts';
import { invoiceWorkToolsFixture, invoiceWorkCandidateDraft } from '../../support/invoice-work-tools.ts';

const at = '2026-10-28T00:00:00.000Z', startedAt = '2026-10-28T00:00:01.000Z', endedAt = '2026-10-28T00:00:02.000Z';
const usage: UsageRecord = { version: 1, source: 'not-requested', reason: 'controlled-attempt', sdkValues: null,
  attempts: 0, attemptsComplete: true, costSource: null, updatedAt: at };
const cleanup: CleanupRecord = { version: 1, stopped: false, stopReason: null, errors: [], lateObservationRequired: false };
function need<T>(value: Result<T>): T { if (!value.ok) throw Error(`${value.error.code}: ${value.error.message}`); return value.data; }

async function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'flowmate-invoice-work-attempt-'));
  const paths = { root, databaseFile: join(root, 'data/app.sqlite'), artifactsDir: join(root, 'artifacts'),
    runtimeDir: join(root, 'runtime'), logsDir: join(root, 'logs'), outputsDir: join(root, 'outputs') };
  const database = need(openTestDatabase(paths));
  const configuration = PersonalAgentConfigurationSchema.parse({ modelId: 'attempt-model', thinkingLevel: 'off',
    resources: { prompt: null, enabledSkills: [] }, extensions: { enabledExtensions: [] }, tools: [], workingDirectory: null, preferences: '' });
  const receipt = await database.transaction(scope => {
    const agent = need(scope.personalAgents.ensureDefault(configuration, at));
    const metadata = { version: 1 as const, sourceKey: 'invoice-work-attempt', sourceRecordId: 'invoice-1', sourceVersion: 'v1' };
    need(scope.documents.register({ documentId: 1, sourceKey: metadata.sourceKey, sourceRecordId: metadata.sourceRecordId, version: 'v1',
      originalArtifact: { artifactId: 1, kind: 'original', relativePath: 'artifacts/1/original.pdf', bytes: 1, mimeType: 'application/pdf',
        metadata: { ...metadata, files: [{ relativePath: 'original.pdf', bytes: 1, mimeType: 'application/pdf' }] }, createdAt: at },
      parsedArtifact: { artifactId: 2, kind: 'parsed', relativePath: 'artifacts/2/parsed.json', bytes: 1, mimeType: 'application/json',
        metadata: { ...metadata, files: [{ relativePath: 'parsed.json', bytes: 1, mimeType: 'application/json' }] }, createdAt: at },
      status: 'available', metadata: { version: 2, pageCount: 1, warnings: [], allowedUsesClaim: ['Controlled attempt lifecycle fixture'],
        licenseVerification: 'not_verified', unavailableReason: null }, createdAt: at, updatedAt: at }));
    return need(scope.invoiceWorks.create({ personalAgentId: agent.personalAgentId, expectedAgentRevision: agent.revision,
      requestId: 'create-work', goal: 'Review the fixed invoice.', documents: [{ id: 1, version: 'v1' }] }, { at, admission: { kind: 'ready' } }));
  });
  if (!receipt.execution.authorizationAccepted) throw Error('Expected the real product attempt.');
  const attemptId = receipt.execution.attempt.attemptId, workId = receipt.workId;
  const view = () => database.read(scope => {
    const result = need(scope.invoiceWorks.get({ view: 'work', workId, limit: 100 }));
    if (result.view !== 'work') throw Error('Expected the original fixed member page.'); return result;
  });
  const item = (await view()).items[0]!;
  const job = need(await database.transaction(scope => scope.invoiceWorks.prepareItemJob({ workId,
    itemId: item.itemId, expectedRevision: item.revision, at })));
  const budget = await database.read(scope => DurableWorkBudgetSchema.parse(JSON.parse(scope.db
    .query<{ budget_json: string }, [number]>('SELECT budget_json FROM invoice_works WHERE id=?').get(workId)!.budget_json)));
  const config = DurableRunConfigSnapshotSchema.parse({ version: 3, runtimeKind: 'durable', name: 'Attempt lifecycle fixture', revision: 1,
    requestedModel: { provider: 'controlled-attempt', model: 'attempt-model' }, resolvedModel: null, api: null, endpoint: null,
    sdk: { durable: '1.4.0', ai: '1.4.0', chord: '1.4.0' }, parameters: { maxRetries: 0, maxRetryDelayMs: 1000 }, ...budget,
    durable: { workId, attemptId, configurationRevision: 0 }, resources: configuration.resources,
    extensions: configuration.extensions, workingDirectory: null });
  const runId = need(await database.transaction(scope => scope.runs.createDurable({ workId, attemptId, config,
    input: { version: 1, goal: 'Review the fixed invoice.', text: 'Review the fixed invoice.', messageTimestamp: Date.parse(at) },
    usage, cleanup, createdAt: at })));
  need(await database.transaction(scope => scope.runs.start(runId, config, startedAt)));
  const read = () => database.read(scope => createInvoiceWorkAttemptRepository(scope.db).get({ workId, attemptId }));
  const stop = async () => database.transaction(scope => createInvoiceWorkAttemptRepository(scope.db).requestStop({ workId, attemptId,
    requestId: 'stop-original', expectedRevision: need(scope.invoiceWorks.get({ view: 'work', workId })).work.revision }, { at: startedAt }));
  const terminal = (status: TerminalWrite['status'], stopped = true): TerminalWrite => ({ status,
    output: status === 'completed' ? DurableRunOutputSchema.parse({ version: 3, text: 'The original attempt ended.', partial: false,
      stopReason: 'stop', responseId: null, responseModel: null, durable: { workId, attemptId } }) : null,
    error: status === 'completed' ? null : appError(status === 'failed' ? 'controlled_native_failure' : 'run_cancelled', 'runtime', 'Original terminal fact.'),
    usage, tokens: { inputTokens: null, outputTokens: null, totalTokens: null, cost: null, usageComplete: false },
    cleanup: { ...cleanup, stopped, stopReason: stopped ? 'native-stop' : 'unknown', lateObservationRequired: !stopped },
    endedAt, stoppedAt: stopped ? endedAt : null, durationMs: 1000, ...(status === 'cancelled' ? { cancelRequestedAt: startedAt } : {}) });
  const finish = (effectsReconciled = true, stopResult?: DurableAttemptStopResult) => database.transaction(scope =>
    createInvoiceWorkAttemptRepository(scope.db).finish({ workId, attemptId, runId, at: endedAt, effectsReconciled,
      ...(stopResult ? { stopResult } : {}) }));
  return { database, paths, receipt, workId, attemptId, runId, config, itemId: item.itemId, job, view, read, stop, terminal, finish };
}

async function nativeToolFixture(cause: 'tool-cleanup' | 'unknown-effect' | 'committed-candidate' | 'READ' | 'PURE') {
  const now = () => new Date().toISOString(), nativeCalls: DurableProductToolCall[] = [];
  const name = cause === 'PURE' ? 'calculate_invoice_amounts'
    : cause === 'unknown-effect' || cause === 'committed-candidate' ? 'save_invoice_candidate' : 'read_invoice_document';
  const args = name === 'calculate_invoice_amounts' ? { operation: 'sum', values: ['100.00', '13.00'], scale: 2 }
    : name === 'save_invoice_candidate' ? { documentId: 1, candidate: invoiceWorkCandidateDraft() }
      : { documentId: 1, page: 1, afterBlockId: null, limit: 10 };
  let modelCalls = 0, runtime: DurableRuntimePort | undefined;
  const server = Bun.serve({ port: 0, fetch: () => {
    const tool = modelCalls++ === 0;
    const delta = tool ? { role: 'assistant', tool_calls: [{ index: 0, id: 'original-wire-call', type: 'function',
      function: { name, arguments: JSON.stringify(args) } }] } : { role: 'assistant', content: 'Original tool result received.' };
    const message = { id: `original-model-${modelCalls}`, object: 'chat.completion.chunk', created: 1, model: 'attempt-local-model',
      choices: [{ index: 0, delta, finish_reason: tool ? 'tool_calls' : 'stop' }] };
    return new Response(`data: ${JSON.stringify(message)}\n\ndata: [DONE]\n\n`, { headers: { 'content-type': 'text/event-stream' } });
  } });
  try {
    const provider: ProviderConfig = { version: 1, name: 'attempt-local-profile', revision: 1,
      modelRef: { provider: 'attempt-local-provider', model: 'attempt-local-model' }, native: { authPath: 'unused-auth.json', modelsPath: null },
      connection: { api: 'openai-completions', baseUrl: `http://127.0.0.1:${server.port}/v1`, contextWindow: 64000, maxTokens: 8192 },
      parameters: { maxRetries: 0, maxRetryDelayMs: 1000 } };
    const f = await invoiceWorkToolsFixture({ provider, at: new Date(Date.now() - 1000).toISOString() });
    let queryFailed = false;
    const decorate = (scope: SqlDatabaseStore): SqlDatabaseStore => ({ ...scope, toolCalls: { ...scope.toolCalls,
      queryCandidateCommit: input => {
        if (!queryFailed && (cause === 'unknown-effect' || cause === 'committed-candidate')) {
          queryFailed = true;
          return fail(appError('storage_read_failed', 'storage', 'Controlled loss of the first original candidate commit query.', true));
        }
        return scope.toolCalls.queryCandidateCommit(input);
      },
      finish: input => scope.toolCalls.finish(cause === 'READ' || cause === 'PURE' ? { ...input,
        runtimeObservation: input.runtimeObservation ? { ...input.runtimeObservation, commit: 'unknown', failureStage: 'commit',
          commitError: appError('operation_result_unknown', 'storage', 'Controlled loss of original commit observation.', true) } : undefined } : input),
    } });
    const storage: Pick<DbHandle, 'read' | 'transaction'> = {
      read: action => f.database.read(scope => action(decorate(scope))),
      transaction: action => f.database.transaction(scope => action(decorate(scope))),
    };
    const definitions = f.definitions.map(tool => tool.name === name && (cause === 'tool-cleanup' || cause === 'unknown-effect')
      ? { ...tool, execute: async () => { throw appError(cause === 'tool-cleanup' ? 'stop_not_confirmed' : 'controlled_write_failure',
        'runtime', 'The original controlled tool did not confirm a business write.'); } } : tool);
    const executor = createToolExecutor({ database: storage, definitions, now });
    const bridge = createInvoiceWorkToolBridge({ database: f.database, executor });
    const governor = new DurableInvoiceGovernor(f.database, now, () => false);
    const contexts = new InvoiceWorkPhaseContextService({ database: f.database, now, buildContext: buildInvoiceWorkContext });
    const identity = { workId: f.created.workId, sessionId: f.created.sessionId, attemptId: f.attemptId },
      query = { ...identity, requestId: f.phase.requestId };
    let observer: InvoiceWorkPhaseObserver;
    runtime = need(await createDurableRuntime({ storage: await createDurableSqliteStorage(f.database.coordinator),
      readApiKey: () => 'controlled-local-key', verifyModelUse: input => governor.verifyModelUse(input),
      reserveModelRequest: input => governor.reserveModelRequest(input), readWorkingContext: input => contexts.get(input),
      verifyWorkingContext: input => contexts.verify(input), tools: definitions.filter(tool => tool.name === name).map(tool => ({
        name: tool.name, description: tool.description, executionMode: tool.executionMode, inputSchema: { ...toPiParameters(tool.inputSchema) } })),
      executeTool: async input => {
        const { signal: _signal, ...original } = input; nativeCalls.push(original);
        const observed = await observer.reconcile(query); if (!observed.ok) return observed;
        return bridge.executeTool(input);
      }, readToolResult: input => bridge.readToolResult(input), onToolFeedback: input => bridge.onToolFeedback(input) }));
    observer = new InvoiceWorkPhaseObserver({ database: f.database, runtime, now });
    const models = new InvoiceWorkModelService({ database: f.database, runtime, now, resolveConfiguration: () => ({ ok: true, data: provider }) });
    need(await runtime.openConversation({ workId: identity.workId, sessionId: identity.sessionId }));
    const binding = need(await models.prepare(query));
    const submitted = need(await runtime.submit({ ...query, text: 'Execute the original invoice tool once.', config: binding.configuration, binding }));
    await runtime.waitForSubmission(query);
    const stopped = need(await runtime.stopAttempt({ ...identity, stopGraceMs: 1000 }));
    expect(stopped.stopped).toBe(true);
    const observed = need(await observer.reconcile(query));
    expect(observed?.nativeSubmissionId).toBe(submitted.nativeSubmissionId); expect(observed?.consumedAt).toBeString();
    expect(nativeCalls).toHaveLength(1);
    const calls = need(await f.database.read(scope => scope.toolCalls.list({ runId: f.runId, limit: 100 })));
    expect(calls.items).toHaveLength(1);
    const call = calls.items[0]!;
    const run = need(await f.database.read(scope => scope.runs.get(f.runId))), ended = now();
    need(await f.database.transaction(scope => scope.runs.finish(f.runId, { status: 'failed', output: null,
      error: appError('tool_commit_unconfirmed', 'runtime', 'The original attempt retained its tool observation failure.'),
      usage: run.usage, tokens: run.tokens, cleanup: { ...cleanup, stopped: true, stopReason: 'native-stop' },
      endedAt: ended, stoppedAt: ended, durationMs: Math.max(0, Date.parse(ended) - Date.parse(run.startedAt ?? ended)) })));
    const finish = () => f.database.transaction(scope => scope.invoiceWorkAttempts.finish({ workId: identity.workId,
      attemptId: identity.attemptId, runId: f.runId, at: now(), effectsReconciled: true, stopResult: stopped }));
    return { ...f, call, nativeCall: nativeCalls[0]!, finish, bridge, modelCalls };
  } finally { if (runtime) need(await runtime.close()); server.stop(true); }
}

test('stop intent and original receipt persist without claiming a running product Run has stopped', async () => {
  const f = await fixture(), before = await f.view();
  const stopped = need(await f.stop());
  expect(stopped).toMatchObject({ accepted: true, stopConfirmed: false, stoppedAt: null, receivedAt: startedAt });
  const after = await f.view();
  expect(after.work.status).toBe('open'); expect(after.work.revision).toBe(before.work.revision + 1);
  expect(after.work.execution).toMatchObject({ runStatus: 'running', requiresContinue: true, stopUnconfirmed: true });
  expect(need(await f.finish())).toMatchObject({ closed: false, reason: 'run-active', task: { stoppedAt: null } });
  expect(need(await f.database.read(scope => scope.runs.get(f.runId))).status).toBe('running');
  expect(need(await f.database.read(scope => createInvoiceWorkAttemptRepository(scope.db).get({ workId: f.workId,
    attemptId: f.attemptId, stopRequestId: stopped.requestId })))).toMatchObject({ stopReceipt: stopped });
  expect(await f.database.transaction(scope => createInvoiceWorkAttemptRepository(scope.db).requestStop({ workId: f.workId,
    attemptId: f.attemptId, requestId: 'stop-original', expectedRevision: before.work.revision }, { at: endedAt }))).toEqual({ ok: true, data: stopped });
  expect(await f.stop()).toMatchObject({ ok: false, error: { code: 'request_conflict' } });
  expect((await f.view()).work.revision).toBe(after.work.revision);
});

test('failed Run cleanup stays occupied until exact native stop and effects are confirmed without rewriting the Run', async () => {
  const f = await fixture();
  need(await f.database.transaction(scope => scope.runs.finish(f.runId, f.terminal('failed', false))));
  const original = need(await f.database.read(scope => scope.runs.get(f.runId)));
  expect(need(await f.finish())).toMatchObject({ closed: false, reason: 'root-stop-unconfirmed' });
  const stopped: DurableAttemptStopResult = { workId: f.workId, sessionId: f.receipt.sessionId, attemptId: f.attemptId,
    stopped: true, reason: 'stopped' };
  expect(need(await f.finish(false, stopped))).toMatchObject({ closed: false, reason: 'effects-unconfirmed' });
  expect(need(await f.finish(true, { ...stopped, stopped: false, reason: 'stop-unconfirmed' })))
    .toMatchObject({ closed: false, reason: 'root-stop-unconfirmed' });
  expect(await f.finish(true, { ...stopped, attemptId: f.attemptId + 1 })).toMatchObject({ ok: false, error: { code: 'source_invalid' } });
  expect(need(await f.finish(true, stopped))).toMatchObject({ closed: true, reason: null, task: { runStatus: 'failed', stoppedAt: endedAt } });
  expect(need(await f.database.read(scope => scope.runs.get(f.runId)))).toEqual(original);
  const current = await f.view();
  expect(current.work.execution).toMatchObject({ requiresContinue: true, stopUnconfirmed: false, runStatus: 'failed' });
  const next = need(await f.database.transaction(scope => scope.invoiceWorks.continueWork({ workId: f.workId, requestId: 'explicit-after-failure',
    expectedRevision: current.work.revision, expectedAttemptId: f.attemptId }, { at: endedAt, admission: { kind: 'queued' } })));
  expect(next.execution).toMatchObject({ authorizationAccepted: true, relation: 'new', attempt: { runId: null } });
  const page = need(await f.database.read(scope => createInvoiceWorkAttemptRepository(scope.db).list({ workId: f.workId, limit: 1 })));
  expect(page.items[0]?.attempt.attemptId).not.toBe(f.attemptId); expect(page.nextBeforeAttemptId).not.toBeNull();
  const earlier = need(await f.database.read(scope => createInvoiceWorkAttemptRepository(scope.db).list({ workId: f.workId,
    beforeAttemptId: page.nextBeforeAttemptId!, limit: 1 })));
  expect(earlier).toMatchObject({ items: [{ attempt: { attemptId: f.attemptId }, runStatus: 'failed' }], nextBeforeAttemptId: null });
});

test('normal completion preserves the real Run outcome and cannot reopen its original terminal Run', async () => {
  const f = await fixture();
  need(await f.database.transaction(scope => scope.runs.finish(f.runId, f.terminal('completed'))));
  expect(need(await f.finish())).toMatchObject({ closed: true, task: { runStatus: 'completed', stopRequestedAt: null, stoppedAt: endedAt } });
  expect(need(await f.read())).toMatchObject({ task: { runStatus: 'completed', attempt: { runId: f.runId } }, children: [], stopReceipt: null });
  expect(await f.database.transaction(scope => scope.runs.start(f.runId, f.config, endedAt))).toMatchObject({ ok: false });
  expect((await f.view()).work).toMatchObject({ status: 'open', execution: { requiresContinue: false } });
  expect(need(await f.finish())).toMatchObject({ closed: true, task: { stoppedAt: endedAt } });
});

test('a never-started native proof closes the failed original attempt without rewriting its diagnosis', async () => {
  const f = await fixture(); need(await f.stop());
  need(await f.database.transaction(scope => scope.runs.finish(f.runId, f.terminal('failed', false))));
  const original = need(await f.database.read(scope => scope.runs.get(f.runId)));
  const proof: DurableAttemptStopResult = { workId: f.workId, sessionId: f.receipt.sessionId, attemptId: f.attemptId,
    stopped: true, reason: 'not-started' };
  expect(await f.finish(true, { ...proof, stopped: false })).toMatchObject({ ok: false, error: { code: 'input_invalid' } });
  for (const field of ['workId', 'sessionId', 'attemptId'] as const)
    expect(await f.finish(true, { ...proof, [field]: proof[field] + 1 })).toMatchObject({ ok: false, error: { code: 'source_invalid' } });
  expect(need(await f.finish(true, proof))).toMatchObject({ closed: true, task: { runStatus: 'failed', stoppedAt: endedAt } });
  expect(need(await f.database.read(scope => scope.runs.get(f.runId)))).toEqual(original);
});

test('a nominal root stop retains an outstanding native late-observation obligation', async () => {
  const f = await fixture(), terminal = f.terminal('failed');
  need(await f.database.transaction(scope => scope.runs.finish(f.runId,
    { ...terminal, cleanup: { ...terminal.cleanup, lateObservationRequired: true } })));
  expect(need(await f.finish())).toMatchObject({ closed: false, reason: 'root-stop-unconfirmed', task: { stoppedAt: null } });
  const stopResult: DurableAttemptStopResult = { workId: f.workId, sessionId: f.receipt.sessionId, attemptId: f.attemptId,
    stopped: true, reason: 'stopped' };
  expect(need(await f.finish(true, stopResult)).closed).toBe(true);
});

test('cancelled business work still permits cleanup and forbids continuing', async () => {
  const f = await fixture(), before = await f.view();
  need(await f.database.transaction(scope => scope.invoiceWorks.cancelWork({ workId: f.workId,
    expectedRevision: before.work.revision, requestId: 'cancel-business' }, { at: startedAt })));
  need(await f.database.transaction(scope => scope.runs.finish(f.runId, f.terminal('cancelled'))));
  expect(need(await f.finish())).toMatchObject({ closed: true, task: { runStatus: 'cancelled', stopRequestedAt: startedAt } });
  const current = await f.view(); expect(current.work.status).toBe('cancelled');
  expect(await f.database.transaction(scope => scope.invoiceWorks.continueWork({ workId: f.workId,
    requestId: 'cannot-revive-cancelled', expectedRevision: current.work.revision, expectedAttemptId: f.attemptId },
  { at: endedAt, admission: { kind: 'ready' } }))).toMatchObject({ ok: false, error: { code: 'state_conflict' } });
});

test('stale and foreign stop commands cannot alter the original attempt or save a stop receipt', async () => {
  const f = await fixture(), original = await f.view();
  const request = { workId: f.workId, attemptId: f.attemptId, requestId: 'not-accepted-stop', expectedRevision: original.work.revision };
  expect(await f.database.transaction(scope => createInvoiceWorkAttemptRepository(scope.db).requestStop({ ...request,
    expectedRevision: original.work.revision + 1 }, { at: startedAt }))).toMatchObject({ ok: false, error: { code: 'state_conflict' } });
  expect(await f.database.transaction(scope => createInvoiceWorkAttemptRepository(scope.db).requestStop({ ...request,
    workId: f.workId + 1 }, { at: startedAt }))).toMatchObject({ ok: false, error: { code: 'invoice_work_not_found' } });
  expect(await f.view()).toEqual(original); expect(need(await f.read()).task.stopRequestedAt).toBeNull();
});

test('the stop request survives reopening and retains its original unconfirmed receipt after actual cleanup', async () => {
  const f = await fixture(), before = await f.view();
  const request = { workId: f.workId, attemptId: f.attemptId, requestId: 'stop-original', expectedRevision: before.work.revision };
  const receipt = need(await f.stop());
  need(await f.database.transaction(scope => scope.runs.recordCancel(f.runId, startedAt)));
  need(await f.database.transaction(scope => scope.runs.finish(f.runId, f.terminal('cancelled'))));
  expect(need(await f.finish()).closed).toBe(true);
  await f.database.close();
  const reopened = need(openTestDatabase(f.paths));
  const current = need(await reopened.read(scope => scope.invoiceWorkAttempts.get({ workId: f.workId,
    attemptId: f.attemptId, stopRequestId: request.requestId })));
  expect(current).toMatchObject({ task: { runStatus: 'cancelled', stopRequestedAt: startedAt, stoppedAt: endedAt },
    stopReceipt: { stopConfirmed: false, stoppedAt: null } });
  expect(current.stopReceipt).toEqual(receipt);
  expect(await reopened.transaction(scope => scope.invoiceWorkAttempts.requestStop(request, { at: endedAt }))).toEqual({ ok: true, data: receipt });
  const work = need(await reopened.read(scope => scope.invoiceWorks.get({ view: 'work', workId: f.workId })));
  expect(work.work).toMatchObject({ status: 'open', execution: { requiresContinue: true, stopUnconfirmed: false } });
});

test('a failed original stop receipt commit rolls its intent and business revision back together', async () => {
  const f = await fixture(), before = await f.view();
  await f.database.transaction(scope => scope.db.exec(`CREATE TRIGGER fail_attempt_stop_receipt
    BEFORE INSERT ON invoice_work_attempt_stop_requests BEGIN SELECT RAISE(ABORT,'controlled stop receipt failure'); END`));
  expect(await f.stop()).toMatchObject({ ok: false, error: { code: 'storage_write_failed' } });
  expect(await f.view()).toEqual(before);
  expect(need(await f.read()).task.stopRequestedAt).toBeNull();
  expect(need(await f.database.read(scope => scope.invoiceWorkAttempts.get({ workId: f.workId,
    attemptId: f.attemptId, stopRequestId: 'stop-original' }))).stopReceipt).toBeNull();
});

test.each(['tool-cleanup', 'unknown-effect'] as const)('%s cannot be bypassed by the coordinator effects flag', async cause => {
  const f = await nativeToolFixture(cause);
  expect(f.call.cleanup.stopped).toBe(cause !== 'tool-cleanup'); expect(f.call.runtimeObservation?.commit).toBe('unknown');
  expect(need(await f.finish())).toMatchObject({ closed: false,
    reason: cause === 'tool-cleanup' ? 'tool-execution-unclosed' : 'effects-unconfirmed', task: { stoppedAt: null } });
  expect(need(await f.database.read(scope => scope.invoiceWorks.get({ view: 'work', workId: f.created.workId }))).work.execution.stopUnconfirmed).toBe(true);
});

test('the original candidate commit proves closure without rewriting an unknown observation or failed Run', async () => {
  const f = await nativeToolFixture('committed-candidate');
  const original = need(await f.database.read(scope => scope.toolCalls.getById(f.call.toolCallId)));
  expect(original).toMatchObject({ effect: 'LOCAL_WRITE', result: { status: 'failed' }, cleanup: { stopped: true },
    runtimeObservation: { commit: 'unknown' } });
  const proof = need(await f.database.read(scope => scope.toolCalls.queryCandidateCommit({ toolCallId: original.toolCallId,
    runId: original.runId, sessionId: original.sessionId })));
  expect(proof).toMatchObject({ jobId: f.jobId, sequence: 1 });
  expect(await f.bridge.readToolResult(f.nativeCall)).toMatchObject({ ok: true, data: { status: 'succeeded', data: proof } });
  const run = need(await f.database.read(scope => scope.runs.get(f.runId)));
  expect(need(await f.finish())).toMatchObject({ closed: true, reason: null });
  expect(need(await f.database.read(scope => scope.toolCalls.getById(original.toolCallId)))).toEqual(original);
  expect(need(await f.database.read(scope => scope.runs.get(f.runId)))).toEqual(run);
  expect(need(await f.database.read(scope => scope.invoiceWorks.get({ view: 'work', workId: f.created.workId }))).work.execution)
    .toMatchObject({ requiresContinue: true, stopUnconfirmed: false });
  expect(await f.database.read(scope => scope.db.query('SELECT COUNT(*) count FROM invoice_candidates').get())).toEqual({ count: 1 });
});

test.each(['READ', 'PURE'] as const)('a stopped %s tool has no unknown business write to retain after its phase closes', async effect => {
  const f = await nativeToolFixture(effect);
  const original = need(await f.database.read(scope => scope.toolCalls.getById(f.call.toolCallId)));
  expect(original).toMatchObject({ effect, cleanup: { stopped: true }, runtimeObservation: { commit: 'unknown' } });
  expect(original.stoppedAt).toBeString();
  expect(need(await f.finish())).toMatchObject({ closed: true, reason: null });
  expect(need(await f.database.read(scope => scope.toolCalls.getById(original.toolCallId)))).toEqual(original);
});

test('real phase consumption and native closure are required before a fully disposed Work can complete', async () => {
  const f = await fixture(), durable = await import('@flowmate/runtime-durable'), now = () => new Date().toISOString();
  const contexts = new InvoiceWorkPhaseContextService({ database: f.database, now, buildContext: buildInvoiceWorkContext });
  const current = await f.view(), selected = current.items[0]!;
  const phase = need(await contexts.freeze({ workId: f.workId, attemptId: f.attemptId, itemId: f.itemId,
    requestId: 'real-attempt-phase', kind: 'prompt', basis: { contextSnapshotId: null, inputIds: [],
      documentRefs: [selected.documentRef], configurationRevision: 0, itemRevision: selected.revision },
    remainingBudget: { modelCalls: 2, toolCalls: 2, toolFeedbackBytes: 4096, timeoutMs: 30_000, childSlots: 1 } }));
  let modelCalls = 0;
  const server = Bun.serve({ port: 0, fetch: () => {
    modelCalls++;
    const response = { id: 'attempt-phase', object: 'chat.completion.chunk', created: 1, model: 'attempt-model',
      choices: [{ index: 0, delta: { role: 'assistant', content: 'The invoice needs user disposition.' }, finish_reason: 'stop' }] };
    return new Response(`data: ${JSON.stringify(response)}\n\ndata: [DONE]\n\n`, { headers: { 'content-type': 'text/event-stream' } });
  } });
  const runtime = need(await durable.createDurableRuntime({ storage: await durable.createDurableSqliteStorage(f.database.coordinator),
    readApiKey: () => 'controlled-local-key', verifyModelUse: () => ({ ok: true, data: undefined }),
    reserveModelRequest: () => ({ ok: true, data: undefined }), readWorkingContext: query => contexts.get(query),
    verifyWorkingContext: query => contexts.verify(query) }));
  const query = { workId: f.workId, sessionId: f.receipt.sessionId, attemptId: f.attemptId, requestId: 'real-attempt-phase' };
  const observer = new InvoiceWorkPhaseObserver({ database: f.database, runtime, now });
  try {
    need(await runtime.openConversation({ workId: f.workId, sessionId: f.receipt.sessionId }));
    need(await runtime.submit({ ...query, text: 'Process the frozen original invoice.', config: { version: 1, name: 'local-attempt', revision: 1,
      modelRef: { provider: 'controlled-attempt', model: 'attempt-model' }, native: { authPath: 'unused-auth.json', modelsPath: null },
      connection: { api: 'openai-completions', baseUrl: `http://127.0.0.1:${server.port}/v1`, contextWindow: 64000, maxTokens: 8192 },
      parameters: { maxRetries: 0, maxRetryDelayMs: 1000 } } }));
    expect(need(await runtime.waitForSubmission(query)).status).toBe('done');
    const terminal = { ...f.terminal('completed'), endedAt: now(), stoppedAt: now() };
    need(await f.database.transaction(scope => scope.runs.finish(f.runId, terminal)));
    const closure = () => f.database.transaction(scope => scope.invoiceWorkAttempts.finish({ workId: f.workId,
      attemptId: f.attemptId, runId: f.runId, at: now(), effectsReconciled: true }));
    expect(need(await closure())).toMatchObject({ closed: false, reason: 'phase-unclosed' });
    const observed = need(await observer.reconcile(query));
    expect(observed).toMatchObject({ phaseId: phase.context.phase.phaseId }); expect(observed?.consumedAt).toBeString();
    const original = await f.view();
    need(await f.database.transaction(scope => scope.invoiceWorks.disposeItem({ workId: f.workId, itemId: f.itemId,
      requestId: 'exclude-original-after-review', expectedRevision: original.work.revision,
      decision: { kind: 'excluded', reason: 'The user explicitly excluded this original invoice.' } }, { at: now() })));
    expect((await f.view()).work.status).toBe('open');
    const closed = await f.database.transaction(scope => {
      const result = need(scope.invoiceWorkAttempts.finish({ workId: f.workId, attemptId: f.attemptId,
        runId: f.runId, at: now(), effectsReconciled: true }));
      if (result.closed) need(scope.invoiceWorks.reconcile({ workId: f.workId, at: now() }));
      return result;
    });
    expect(closed.closed).toBe(true);
    expect((await f.view()).work).toMatchObject({ status: 'completed', counts: { unresolved: 0, excluded: 1 } });
    expect(modelCalls).toBe(1);
    expect(await f.database.read(scope => scope.db.query('SELECT native_session_id FROM sessions WHERE id=?').get(f.receipt.sessionId)))
      .toEqual({ native_session_id: null });
  } finally { need(await runtime.close()); server.stop(true); }
}, 10_000);
