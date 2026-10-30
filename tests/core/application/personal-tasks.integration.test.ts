import { expect, test } from 'bun:test';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createRegistry, defineTool } from '@earendil-works/pi-durable';
import { Type } from '@earendil-works/pi-ai';
import { appError, DurableRunConfigSnapshotSchema, DurableWorkBudgetSchema, PersonalAgentConfigurationSchema, ok,
  type CleanupRecord, type ProviderConfig, type Result, type UsageRecord } from '@flowmate/contracts';
import { PersonalTasksService } from '../../../packages/core/src/personal-agent/tasks.ts';
import { DurableInvoiceGovernor } from '../../../packages/core/src/personal-agent/admission.ts';
import { InvoiceWorkModelService } from '../../../packages/core/src/personal-agent/models.ts';
import { InvoiceWorkPhaseContextService, InvoiceWorkPhaseObserver } from '../../../packages/core/src/personal-agent/phase-context.ts';
import { buildInvoiceWorkContext, createDurableRuntime, createDurableSqliteStorage } from '@flowmate/runtime-durable';
import { openTestDatabase } from '../../support/database.ts';
import { deferCleanup, mkdtempSync } from '../../support/resources.ts';

function need<T>(result: Result<T>): T { if (!result.ok) throw Error(`${result.error.code}: ${result.error.message}`); return result.data; }
const now = () => new Date().toISOString();
const cleanup: CleanupRecord = { version: 1, stopped: false, stopReason: null, errors: [], lateObservationRequired: false };

async function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'flowmate-personal-tasks-'));
  const database = need(openTestDatabase({ root, databaseFile: join(root, 'data/app.sqlite'), artifactsDir: join(root, 'artifacts'),
    runtimeDir: join(root, 'runtime'), logsDir: join(root, 'logs'), outputsDir: join(root, 'outputs') }));
  const at = now(), configuration = PersonalAgentConfigurationSchema.parse({ modelId: 'task-local-model', thinkingLevel: 'off',
    resources: { prompt: null, enabledSkills: [] }, extensions: { enabledExtensions: [] }, tools: ['read_invoice_document'],
    workingDirectory: null, preferences: '' });
  const created = await database.transaction(scope => {
    const agent = need(scope.personalAgents.ensureDefault(configuration, at));
    const metadata = { version: 1 as const, sourceKey: 'personal-tasks', sourceRecordId: 'invoice-1', sourceVersion: 'v1' };
    need(scope.documents.register({ documentId: 1, sourceKey: metadata.sourceKey, sourceRecordId: metadata.sourceRecordId, version: 'v1',
      originalArtifact: { artifactId: 1, kind: 'original', relativePath: 'artifacts/1/original.pdf', bytes: 1, mimeType: 'application/pdf',
        metadata: { ...metadata, files: [{ relativePath: 'original.pdf', bytes: 1, mimeType: 'application/pdf' }] }, createdAt: at },
      parsedArtifact: { artifactId: 2, kind: 'parsed', relativePath: 'artifacts/2/parsed.json', bytes: 1, mimeType: 'application/json',
        metadata: { ...metadata, files: [{ relativePath: 'parsed.json', bytes: 1, mimeType: 'application/json' }] }, createdAt: at },
      status: 'available', metadata: { version: 2, pageCount: 1, warnings: [], allowedUsesClaim: ['Controlled PersonalTasks integration fixture'],
        licenseVerification: 'not_verified', unavailableReason: null }, createdAt: at, updatedAt: at }));
    return need(scope.invoiceWorks.create({ personalAgentId: agent.personalAgentId, expectedAgentRevision: agent.revision,
      requestId: 'create-task-work', goal: 'Review the fixed invoice.', documents: [{ id: 1, version: 'v1' }] },
    { at, admission: { kind: 'queued' } }));
  });
  if (!created.execution.authorizationAccepted) throw Error('The original Work attempt was not admitted.');
  const taskIdentity = { workId: created.workId, attemptId: created.execution.attempt.attemptId };
  const identity = { ...taskIdentity, sessionId: created.sessionId };
  const query = { ...identity, requestId: 'task-original-phase' };
  const governor = new DurableInvoiceGovernor(database, now, () => false);
  const contexts = new InvoiceWorkPhaseContextService({ database, now, buildContext: buildInvoiceWorkContext });
  const entered = Promise.withResolvers<void>(), release = Promise.withResolvers<void>();
  const counts = { model: 0, sdk: 0, restores: 0, changes: 0 };
  const server = Bun.serve({ port: 0, fetch: () => {
    counts.model++;
    const response = { id: 'personal-task', object: 'chat.completion.chunk', created: 1, model: 'task-local-model',
      choices: [{ index: 0, delta: { role: 'assistant', tool_calls: [{ index: 0, id: 'owned-evidence-tool', type: 'function',
        function: { name: 'read_invoice_document', arguments: '{}' } }] }, finish_reason: 'tool_calls' }] };
    return new Response(`data: ${JSON.stringify(response)}\n\ndata: [DONE]\n\n`, { headers: { 'content-type': 'text/event-stream' } });
  } });
  const registry = createRegistry();
  registry.install({ name: 'controlled-existing-task-tool', tools: [defineTool({ name: 'read_invoice_document',
    description: 'Hold this original native tool until its actual completion.', parameters: Type.Object({}), replay: 'unsafe',
    execute: async () => { entered.resolve(); await release.promise; return { output: [{ type: 'text', text: 'Original invoice evidence.' }] }; } })] });
  const runtime = need(await createDurableRuntime({ storage: await createDurableSqliteStorage(database.coordinator), registry,
    readApiKey: () => 'controlled-local-key', verifyModelUse: value => governor.verifyModelUse(value),
    reserveModelRequest: value => governor.reserveModelRequest(value), readWorkingContext: value => contexts.get(value),
    verifyWorkingContext: value => contexts.verify(value) }));
  deferCleanup(async () => { release.resolve(); await runtime.close(); server.stop(true); });
  const provider: ProviderConfig = { version: 1, name: 'task-local-model', revision: 1,
    modelRef: { provider: 'controlled-task-provider', model: 'task-local-model' }, native: { authPath: 'unused-auth.json', modelsPath: null },
    connection: { api: 'openai-completions', baseUrl: `http://127.0.0.1:${server.port}/v1`, contextWindow: 64000, maxTokens: 8192 },
    parameters: { maxRetries: 0, maxRetryDelayMs: 1000 } };
  const models = new InvoiceWorkModelService({ database, runtime, now, resolveConfiguration: () => ok(provider) });
  const observer = new InvoiceWorkPhaseObserver({ database, runtime, now });
  const options = { database, now, runtime: {
    stopAttempt: (input: Parameters<typeof runtime.stopAttempt>[0]) => { counts.sdk++; return runtime.stopAttempt(input); },
    resumeAttempt: (input: Parameters<typeof runtime.resumeAttempt>[0]) => { counts.sdk++; return runtime.resumeAttempt(input); },
    getSubmission: runtime.getSubmission,
  }, phaseObserver: observer, restoreAttempt: async () => { counts.restores++; return models.restore(query); },
  verifyModelUse: (input: typeof identity) => governor.verifyModelUse(input), onChanged: () => { counts.changes++; } };
  const service = new PersonalTasksService(options);
  const work = async () => need(await database.read(scope => scope.invoiceWorks.get({ view: 'work', workId: identity.workId })));
  const task = () => service.get({ workId: identity.workId, attemptId: identity.attemptId });
  const stopRequest = async () => ({ workId: identity.workId, attemptId: identity.attemptId, requestId: 'stop-original-task',
    expectedRevision: (await work()).work.revision });
  const usage: UsageRecord = { version: 1, source: 'not-requested', reason: 'controlled-personal-task', sdkValues: null,
    attempts: 0, attemptsComplete: true, costSource: null, updatedAt: at };
  const start = async () => {
    const budget = await database.read(scope => DurableWorkBudgetSchema.parse(JSON.parse(scope.db
      .query<{ budget_json: string }, [number]>('SELECT budget_json FROM invoice_works WHERE id=?').get(identity.workId)!.budget_json)));
    const config = DurableRunConfigSnapshotSchema.parse({ version: 3, runtimeKind: 'durable', name: provider.name, revision: 1,
      requestedModel: provider.modelRef, resolvedModel: null, api: provider.connection?.api ?? null, endpoint: provider.connection?.baseUrl ?? null,
      sdk: { durable: '1.4.0', ai: '1.4.0', chord: '1.4.0' }, parameters: provider.parameters, ...budget,
      durable: { workId: identity.workId, attemptId: identity.attemptId, configurationRevision: 0 }, resources: configuration.resources,
      extensions: configuration.extensions, workingDirectory: null });
    const runId = need(await database.transaction(scope => scope.runs.createDurable({ workId: identity.workId,
      attemptId: identity.attemptId, config, input: { version: 1, goal: 'Review the fixed invoice.', text: 'Review the fixed invoice.',
        messageTimestamp: Date.parse(at) }, usage, cleanup, createdAt: now() })));
    need(await database.transaction(scope => scope.runs.start(runId, config, now()))); return runId;
  };
  const freeze = async () => {
    const view = await work(); if (view.view !== 'work' || !view.items[0]) throw Error('Expected the original member.');
    need(await database.transaction(scope => scope.invoiceWorks.prepareItemJob({ workId: identity.workId,
      itemId: view.items[0]!.itemId, expectedRevision: view.items[0]!.revision, at: now() })));
    const after = await work(); if (after.view !== 'work' || !after.items[0]) throw Error('Expected the prepared original member.');
    return need(await contexts.freeze({ ...taskIdentity, requestId: query.requestId, itemId: after.items[0].itemId, kind: 'prompt', basis: { contextSnapshotId: null,
      documentRefs: [after.items[0].documentRef], configurationRevision: 0, itemRevision: after.items[0].revision, inputIds: [] },
      remainingBudget: need(await governor.remainingBudget(identity.workId)) }));
  };
  const submit = async () => {
    await freeze(); need(await runtime.openConversation({ workId: identity.workId, sessionId: identity.sessionId })); const binding = need(await models.prepare(query));
    need(await runtime.submit({ ...query, config: binding.configuration, binding, text: 'Process the frozen original invoice.' }));
    await entered.promise;
  };
  return { database, identity, taskIdentity, query, runtime, observer, service, options, work, task, stopRequest, start, freeze, submit, release, counts, usage };
}

test('task list and detail read persisted facts without native scheduling or model calls', async () => {
  const f = await fixture();
  expect(need(await f.service.list({ workId: f.identity.workId })).items).toHaveLength(1);
  expect(need(await f.task())).toMatchObject({ task: { queued: true, runStatus: null }, children: [], stopReceipt: null });
  expect(f.counts).toEqual({ model: 0, sdk: 0, restores: 0, changes: 0 });
});

test('stopping a never-submitted queued attempt closes it without inventing a Run or calling native stop', async () => {
  const f = await fixture(), request = await f.stopRequest(), receipt = need(await f.service.stop(request));
  expect(receipt).toMatchObject({ accepted: true, stopConfirmed: false, stoppedAt: null });
  expect(need(await f.task()).task).toMatchObject({ runStatus: null, stopRequestedAt: receipt.receivedAt });
  expect(need(await f.task()).task.stoppedAt).toBeString();
  expect((await f.work()).work).toMatchObject({ status: 'open', execution: { requiresContinue: true, stopUnconfirmed: false } });
  expect(f.counts.sdk).toBe(0); expect(f.counts.model).toBe(0);
  const committedSignals = f.counts.changes;
  expect(await f.service.stop(request)).toEqual(ok(receipt));
  expect(f.counts.changes).toBe(committedSignals);
  expect(await f.database.read(scope => scope.db.query('SELECT COUNT(*) count FROM runs').get())).toEqual({ count: 0 });
});

test('an admitted Run without any phase records a real cancellation and preserves its stop receipt', async () => {
  const f = await fixture(), runId = await f.start(), request = await f.stopRequest();
  const receipt = need(await f.service.stop(request));
  expect(need(await f.database.read(scope => scope.runs.get(runId)))).toMatchObject({ status: 'cancelled',
    cancelRequestedAt: receipt.receivedAt, cleanup: { stopped: true } });
  expect(need(await f.service.get({ ...f.taskIdentity, stopRequestId: request.requestId }))).toMatchObject({ stopReceipt: receipt });
  expect(need(await f.task()).task.stoppedAt).toBeString(); expect(f.counts.sdk).toBe(0);
});

test('a response lost after the stop commit recovers the original accepted request and completes cleanup', async () => {
  const f = await fixture(), request = await f.stopRequest(); let lost = false;
  const service = new PersonalTasksService({ ...f.options, database: { read: f.database.read,
    transaction: async action => {
      const saved = await f.database.transaction(action);
      if (!lost) { lost = true; throw Error('Controlled response loss after the original commit.'); }
      return saved;
    } } });
  const receipt = need(await service.stop(request));
  expect(receipt.accepted).toBe(true);
  const current = need(await service.get({ ...f.taskIdentity, stopRequestId: request.requestId }));
  expect(current.stopReceipt).toEqual(receipt); expect(current.task.stoppedAt).toBeString();
  expect(f.counts.model).toBe(0); expect(f.counts.sdk).toBe(0);
});

test('a frozen phase confirmed never-submitted by the native barrier closes without inventing a receipt', async () => {
  const f = await fixture(), runId = await f.start(); await f.freeze();
  const receipt = need(await f.service.stop(await f.stopRequest()));
  expect(receipt.accepted).toBe(true);
  expect(need(await f.task()).task).toMatchObject({ stopRequestedAt: receipt.receivedAt, runStatus: 'cancelled',
    attempt: { runtimeLinked: false } });
  expect(need(await f.task()).task.stoppedAt).toBeString();
  expect(need(await f.database.read(scope => scope.runs.get(runId)))).toMatchObject({ status: 'cancelled', cancelRequestedAt: receipt.receivedAt });
  const phase = need(await f.database.read(scope => scope.invoiceWorks.getPhase(f.query)));
  expect(phase).toMatchObject({ nativeConversationId: null, nativeSubmissionId: null, consumedAt: null });
  expect(await f.database.read(scope => scope.db.query('SELECT closed_at FROM invoice_work_phases WHERE work_id=? AND attempt_id=? AND request_id=?')
    .get(f.identity.workId, f.identity.attemptId, f.query.requestId))).toEqual({ closed_at: expect.any(String) });
  expect(need(await f.runtime.getSubmission(f.query))).toBeNull();
  expect((await f.work()).work.execution.stopUnconfirmed).toBe(false); expect(f.counts.model).toBe(0); expect(f.counts.sdk).toBe(1);
  expect(await f.service.resume(f.taskIdentity)).toMatchObject({ ok: false });
});

test('a confirmed native stop without its original observation keeps the product Run occupied', async () => {
  const f = await fixture(), runId = await f.start(); await f.submit(); f.release.resolve();
  const observer = new InvoiceWorkPhaseObserver({ database: f.database, now,
    runtime: { observeSubmission: async () => ok(null) } });
  const service = new PersonalTasksService({ ...f.options, phaseObserver: observer });
  const receipt = need(await service.stop(await f.stopRequest()));
  expect(need(await service.reconcileStop(f.taskIdentity))).toMatchObject({ closed: false, reason: 'phase-unclosed' });
  expect(need(await f.database.read(scope => scope.runs.get(runId)))).toMatchObject({ status: 'running', cancelRequestedAt: receipt.receivedAt });
  expect(need(await f.task()).task.stoppedAt).toBeNull();
  expect((await f.work()).work.execution.stopUnconfirmed).toBe(true);
  expect(need(await f.service.reconcileStop(f.taskIdentity)).closed).toBe(true);
}, 15_000);

test('not-started cleanup preserves the original failed Run and stop diagnostics', async () => {
  const f = await fixture(), runId = await f.start(); await f.freeze();
  const at = now(), stopError = appError('stop_unconfirmed', 'runtime', 'The original stop failed to confirm cleanup.', true);
  need(await f.database.transaction(scope => scope.runs.finish(runId, { status: 'failed', output: null,
    error: appError('original_failure', 'runtime', 'The original execution failed.'), usage: f.usage,
    tokens: { inputTokens: null, outputTokens: null, totalTokens: null, cost: null, usageComplete: false },
    cleanup: { ...cleanup, errors: [stopError], stopReason: 'stop-unconfirmed', lateObservationRequired: true },
    endedAt: at, stoppedAt: null, durationMs: 0 })));
  const original = need(await f.database.read(scope => scope.runs.get(runId)));
  need(await f.service.stop(await f.stopRequest()));
  expect(need(await f.task()).task).toMatchObject({ runStatus: 'failed' });
  expect(need(await f.task()).task.stoppedAt).toBeString();
  expect(need(await f.database.read(scope => scope.runs.get(runId)))).toEqual(original);
  expect(f.counts.model).toBe(0);
});

test('service shutdown without a user stop leaves the original task intent and Run unchanged', async () => {
  const f = await fixture(), runId = await f.start(); await f.freeze();
  const original = need(await f.database.read(scope => scope.runs.get(runId)));
  need(await f.runtime.close());
  expect(await f.service.reconcileStop(f.taskIdentity)).toMatchObject({ ok: false, error: { code: 'state_conflict' } });
  expect(need(await f.task()).task).toMatchObject({ stopRequestedAt: null, stoppedAt: null, runStatus: 'running' });
  expect(need(await f.database.read(scope => scope.runs.get(runId)))).toEqual(original);
  expect(await f.database.read(scope => scope.db.query('SELECT closed_at FROM invoice_work_phases WHERE work_id=? AND attempt_id=? AND request_id=?')
    .get(f.identity.workId, f.identity.attemptId, f.query.requestId))).toEqual({ closed_at: null });
  expect(f.counts.sdk).toBe(0); expect(f.counts.model).toBe(0);
});

test('a real native owned tool keeps the root occupied until stop and its original phase are actually closed', async () => {
  const f = await fixture(), runId = await f.start(); await f.submit();
  expect(f.counts.model).toBe(1);
  const request = await f.stopRequest(), receipt = need(await f.service.stop(request));
  expect(receipt).toMatchObject({ accepted: true, stopConfirmed: false });
  expect(need(await f.task()).task.stoppedAt).toBeNull();
  expect((await f.work()).work.execution.stopUnconfirmed).toBe(true);
  f.release.resolve();
  expect(need(await f.service.reconcileStop(f.taskIdentity)).closed).toBe(true);
  expect(need(await f.database.read(scope => scope.runs.get(runId)))).toMatchObject({ status: 'cancelled',
    usage: { attemptsComplete: false }, cleanup: { stopped: true } });
  expect(need(await f.service.get({ ...f.taskIdentity, stopRequestId: request.requestId }))).toMatchObject({
    task: { runStatus: 'cancelled' }, stopReceipt: receipt });
  expect(need(await f.task()).task.stoppedAt).toBeString(); expect(f.counts.model).toBe(1);
}, 15_000);

test('internal resume restores the original binding and keeps the same real live attempt', async () => {
  const f = await fixture(); await f.start(); await f.submit();
  expect(await f.service.resume(f.taskIdentity)).toMatchObject({ ok: false, error: { code: 'state_conflict' } });
  expect(f.counts.restores).toBe(0);
  need(await f.observer.reconcile(f.query));
  expect(await f.service.resume(f.taskIdentity)).toEqual(ok(undefined));
  expect(f.counts.restores).toBe(1); expect(f.counts.model).toBe(1);
  const page = need(await f.service.list({ workId: f.identity.workId }));
  expect(page.items).toHaveLength(1); expect(page.items[0]?.attempt.attemptId).toBe(f.identity.attemptId);
  need(await f.service.stop(await f.stopRequest())); f.release.resolve(); need(await f.service.reconcileStop(f.taskIdentity));
}, 15_000);

test('failed Runs cannot use internal resume to bypass explicit continue authorization', async () => {
  const f = await fixture(), runId = await f.start(), at = now();
  need(await f.database.transaction(scope => scope.runs.finish(runId, { status: 'failed', output: null,
    error: appError('controlled_failure', 'runtime', 'The actual product attempt failed.'), usage: f.usage,
    tokens: { inputTokens: null, outputTokens: null, totalTokens: null, cost: null, usageComplete: false },
    cleanup: { ...cleanup, stopped: true }, endedAt: at, stoppedAt: at, durationMs: 0 })));
  expect(await f.service.resume(f.taskIdentity)).toMatchObject({ ok: false, error: { code: 'state_conflict' } });
  expect(f.counts.restores).toBe(0); expect(f.counts.sdk).toBe(0); expect(f.counts.model).toBe(0);
  expect(need(await f.service.list({ workId: f.identity.workId })).items).toHaveLength(1);
});
