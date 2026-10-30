import { expect, test } from 'bun:test';
import { createRequire } from 'node:module';
import { readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { SQLQueryBindings } from 'bun:sqlite';
import { z } from 'zod';
import { appError, DurableRunConfigSnapshotSchema, DurableRunOutputSchema, DurableWorkBudgetSchema, PersonalAgentConfigurationSchema,
  type CleanupRecord, type Result, type UsageRecord } from '@flowmate/contracts';
import type { NewDurableRun, TerminalWrite } from '../../../packages/core/src/storage/repositories.ts';
import type { SqlDatabaseStore } from '../../../packages/core/src/storage/database.ts';
import { openTestDatabase } from '../../support/database.ts';
import { mkdtempSync } from '../../support/resources.ts';
import { InvoiceWorkModelService } from '../../../packages/core/src/personal-agent/models.ts';

const at = '2026-10-29T00:00:00.000Z', startedAt = '2026-10-29T00:00:01.000Z', endedAt = '2026-10-29T00:00:02.000Z';
const requireRuntime = createRequire(new URL('../../../packages/runtime-durable/package.json', import.meta.url));
const installedVersion = (name: string) => z.object({ version: z.string().min(1) }).passthrough()
  .parse(JSON.parse(readFileSync(requireRuntime.resolve(`${name}/package.json`), 'utf8'))).version;
const sdk = { durable: installedVersion('@earendil-works/pi-durable'), ai: installedVersion('@earendil-works/pi-ai'),
  chord: installedVersion('@earendil-works/chord') };
function need<T>(result: Result<T>): T { if (!result.ok) throw Error(result.error.code); return result.data; }
const usage: UsageRecord = { version: 1, source: 'not-requested', reason: 'durable-not-started', sdkValues: null,
  attempts: 0, attemptsComplete: true, costSource: null, updatedAt: at };
const cleanup: CleanupRecord = { version: 1, stopped: false, stopReason: null, errors: [], lateObservationRequired: false };

async function fixture(members = 1) {
  const root = mkdtempSync(join(tmpdir(), 'flowmate-durable-product-run-'));
  const database = need(openTestDatabase({ root, databaseFile: join(root, 'data/app.sqlite'), artifactsDir: join(root, 'artifacts'),
    runtimeDir: join(root, 'runtime'), logsDir: join(root, 'logs'), outputsDir: join(root, 'outputs') }));
  const configuration = PersonalAgentConfigurationSchema.parse({ modelId: 'durable-fixture', thinkingLevel: 'off',
    resources: { prompt: null, enabledSkills: [] }, extensions: { enabledExtensions: [] }, tools: ['read_invoice_document'],
    workingDirectory: null, preferences: '' });
  const receipt = await database.transaction(store => {
    const agent = need(store.personalAgents.ensureDefault(configuration, at));
    const documents = Array.from({ length: members }, (_, index) => {
      const documentId = index + 1, original = documentId * 2 - 1, parsed = documentId * 2;
      const metadata = { version: 1 as const, sourceKey: 'durable-run-storage', sourceRecordId: String(documentId), sourceVersion: 'v1' };
      need(store.documents.register({ documentId, sourceKey: metadata.sourceKey, sourceRecordId: metadata.sourceRecordId, version: 'v1',
        originalArtifact: { artifactId: original, kind: 'original', relativePath: `artifacts/${original}/original.pdf`, bytes: 1, mimeType: 'application/pdf',
          metadata: { ...metadata, files: [{ relativePath: 'original.pdf', bytes: 1, mimeType: 'application/pdf' }] }, createdAt: at },
        parsedArtifact: { artifactId: parsed, kind: 'parsed', relativePath: `artifacts/${parsed}/parsed.json`, bytes: 1, mimeType: 'application/json',
          metadata: { ...metadata, files: [{ relativePath: 'parsed.json', bytes: 1, mimeType: 'application/json' }] }, createdAt: at },
        status: 'available', metadata: { version: 2, pageCount: 1, warnings: [], allowedUsesClaim: ['Controlled Durable Run storage'],
          licenseVerification: 'not_verified', unavailableReason: null }, createdAt: at, updatedAt: at }));
      return { id: documentId, version: 'v1' };
    });
    return need(store.invoiceWorks.create({ personalAgentId: agent.personalAgentId, expectedAgentRevision: agent.revision,
      requestId: 'create-durable-run', goal: 'Review the fixed invoice set.', documents }, { at, admission: { kind: 'ready' } }));
  });
  if (!('attempt' in receipt.execution) || receipt.execution.attempt === null) throw Error('The admitted product attempt is missing.');
  const budget = await database.read(store => {
    const row = store.db.query<{ budget_json: string }, [number]>('SELECT budget_json FROM invoice_works WHERE id=?').get(receipt.workId);
    if (!row) throw Error('The original authorization budget is missing.');
    return DurableWorkBudgetSchema.parse(JSON.parse(row.budget_json));
  });
  const config = DurableRunConfigSnapshotSchema.parse({ version: 3, runtimeKind: 'durable', name: 'Durable product Run', revision: 1,
    requestedModel: { provider: 'durable-fixture', model: 'explicit-model' }, resolvedModel: null, api: null, endpoint: null, sdk,
    parameters: { maxRetries: 0, maxRetryDelayMs: 1000 }, ...budget,
    durable: { workId: receipt.workId, attemptId: receipt.execution.attempt.attemptId, configurationRevision: 0 },
    resources: configuration.resources, extensions: configuration.extensions, workingDirectory: null });
  const request: NewDurableRun = { workId: receipt.workId, attemptId: receipt.execution.attempt.attemptId,
    input: { version: 1, goal: 'Review the fixed invoice set.', text: 'Review the fixed invoice set.', messageTimestamp: Date.parse(at) },
    config, usage, cleanup, createdAt: at };
  return { database, receipt, config, request, configuration };
}

function forbidLegacySql(store: SqlDatabaseStore) {
  const query = store.db.query;
  store.db.query = <Row extends object, Bindings extends SQLQueryBindings | SQLQueryBindings[]>(sql: string) => {
    if (/\b(?:session_inputs|session_native_\w+|native_fork_\w+)\b/i.test(sql)) throw Error('Durable Run touched Pi history or the legacy input Ledger.');
    return query<Row, Bindings>(sql);
  };
}

test('the product saves one fixed model binding and retries never resolve a newer model profile', async () => {
  const f = await fixture(), durable = await import('@flowmate/runtime-durable'), native = await import('@earendil-works/pi-durable');
  const modelId = f.configuration.modelId;
  if (modelId === null) throw Error('The fixture must select its original model.');
  if (!('attempt' in f.receipt.execution) || f.receipt.execution.attempt === null) throw Error('Missing original attempt.');
  const query = { workId: f.receipt.workId, sessionId: f.receipt.sessionId,
    attemptId: f.receipt.execution.attempt.attemptId, requestId: 'prepare-product-model' };
  let credentials = 0, resolutions = 0;
  const runtime = need(await durable.createDurableRuntime({ storage: new native.MemoryStorage(),
    readApiKey: () => { credentials++; return 'model-store-test-key'; }, verifyModelUse: () => ({ ok: true, data: undefined }),
    reserveModelRequest: () => { throw Error('Metadata must not reserve model calls.'); } }));
  const config = { version: 1 as const, name: f.config.name, revision: f.config.revision, modelRef: f.config.requestedModel,
    native: { authPath: 'unused-auth.json', modelsPath: null }, connection: { api: 'openai-completions',
      baseUrl: 'http://127.0.0.1:1/v1', contextWindow: 64000, maxTokens: 8192 }, parameters: f.config.parameters };
  const service = new InvoiceWorkModelService({ database: f.database, runtime, now: () => at,
    resolveConfiguration: selected => { resolutions++; expect(selected).toBe(modelId); return { ok: true, data: config }; } });
  try {
    const first = need(await service.prepare(query));
    const changedProfile = { ...config, revision: 2, connection: { ...config.connection, baseUrl: 'http://127.0.0.1:2/v1' } };
    const reopened = new InvoiceWorkModelService({ database: f.database, runtime, now: () => endedAt,
      resolveConfiguration: () => { resolutions++; return { ok: true, data: changedProfile }; } });
    expect(need(await reopened.prepare({ ...query, requestId: 'later-phase-model' }))).toEqual(first);
    expect(resolutions).toBe(1); expect(credentials).toBe(0);
    const saved = need(await f.database.read(scope => scope.invoiceWorkModelBindings.get({ workId: query.workId, attemptId: query.attemptId })));
    if (!saved) throw Error('The original fixed model binding must be saved.');
    expect(saved?.binding).toEqual(first);
    expect(JSON.stringify(saved)).not.toContain('model-store-test-key');
    expect(need(await f.database.transaction(scope => scope.invoiceWorkAttempts.finish({ workId: query.workId,
      attemptId: query.attemptId, runId: null, at: endedAt, effectsReconciled: true })))).toMatchObject({ closed: true });
    const continued = need(await f.database.transaction(scope => scope.invoiceWorks.continueWork({ workId: query.workId,
      requestId: 'new-attempt-original-model', expectedRevision: f.receipt.revision, expectedAttemptId: query.attemptId },
    { at: endedAt, admission: { kind: 'ready' } })));
    const nextAttemptId = continued.execution.attempt?.attemptId; if (!nextAttemptId) throw Error('Missing continued attempt.');
    expect(nextAttemptId).not.toBe(query.attemptId);
    expect(need(await reopened.prepare({ ...query, attemptId: nextAttemptId, requestId: 'new-attempt-model' }))).toEqual(first);
    expect(need(await f.database.read(scope => scope.invoiceWorkModelBindings.get({ workId: query.workId, attemptId: nextAttemptId })))).toEqual(saved);
    expect(need(await f.database.transaction(scope => scope.invoiceWorkModelBindings.save({ workId: query.workId,
      attemptId: nextAttemptId, modelId, binding: first, at: endedAt })))).toEqual(saved);
    expect(resolutions).toBe(1); expect(credentials).toBe(0);
    expect(await f.database.transaction(scope => scope.invoiceWorkModelBindings.save({ workId: query.workId,
      attemptId: query.attemptId, modelId, binding: { ...first, configuration: changedProfile }, at: endedAt })))
      .toMatchObject({ ok: false, error: { code: 'state_conflict' } });
    expect(await service.prepare({ ...query, sessionId: query.sessionId + 1 })).toMatchObject({ ok: false, error: { code: 'state_conflict' } });
    expect(await f.database.read(scope => scope.db.query('SELECT COUNT(*) count FROM invoice_work_model_bindings').get())).toEqual({ count: 1 });
  } finally { need(await runtime.close()); }
});

test('first model binding save requires the original model and a live current attempt while all reads keep real ownership', async () => {
  const f = await fixture(), durable = await import('@flowmate/runtime-durable');
  const workId = f.receipt.workId, attemptId = f.request.attemptId, modelId = f.configuration.modelId!;
  const binding = need(await durable.prepareDurableModelBinding({ version: 1, name: modelId, revision: 1,
    modelRef: f.config.requestedModel, native: { authPath: 'unused.json', modelsPath: null }, parameters: f.config.parameters,
    connection: { api: 'openai-completions', baseUrl: 'http://127.0.0.1:1/v1', contextWindow: 64000, maxTokens: 8192 } }));
  const save = { workId, attemptId, modelId, binding, at };
  expect(await f.database.transaction(scope => scope.invoiceWorkModelBindings.save({ workId, modelId, binding, at })))
    .toMatchObject({ ok: false, error: { code: 'state_conflict' } });
  expect(await f.database.transaction(scope => scope.invoiceWorkModelBindings.save({ ...save, modelId: 'foreign-model' })))
    .toMatchObject({ ok: false, error: { code: 'source_invalid' } });
  const other = need(await f.database.transaction(scope => scope.invoiceWorks.create({ personalAgentId: 1, expectedAgentRevision: 0,
    requestId: 'other-binding-owner', goal: 'A distinct work.', documents: [{ id: 1, version: 'v1' }] }, { at, admission: { kind: 'ready' } })));
  const foreignAttemptId = other.execution.attempt?.attemptId; if (!foreignAttemptId) throw Error('Missing foreign attempt.');
  expect(await f.database.read(scope => scope.invoiceWorkModelBindings.get({ workId, attemptId: foreignAttemptId })))
    .toMatchObject({ ok: false, error: { code: 'invoice_work_attempt_not_found' } });
  need(await f.database.transaction(scope => scope.invoiceWorkAttempts.requestStop({ workId, attemptId,
    expectedRevision: f.receipt.revision, requestId: 'stop-before-first-binding' }, { at: startedAt })));
  expect(await f.database.transaction(scope => scope.invoiceWorkModelBindings.save(save)))
    .toMatchObject({ ok: false, error: { code: 'state_conflict' } });
  const work = need(await f.database.read(scope => scope.invoiceWorks.get({ view: 'work', workId })));
  need(await f.database.transaction(scope => scope.invoiceWorks.cancelWork({ workId, expectedRevision: work.work.revision,
    requestId: 'cancel-before-first-binding' }, { at: endedAt })));
  expect(await f.database.transaction(scope => scope.invoiceWorkModelBindings.save(save)))
    .toMatchObject({ ok: false, error: { code: 'state_conflict' } });
  expect(need(await f.database.read(scope => scope.invoiceWorkModelBindings.getOriginal({ workId })))).toBeNull();
  expect(await f.database.read(scope => scope.db.query('SELECT COUNT(*) count FROM invoice_work_model_bindings').get())).toEqual({ count: 0 });
});

test('a model binding response lost after COMMIT is recovered by the original attempt without preparing again', async () => {
  const f = await fixture(), durable = await import('@flowmate/runtime-durable'), native = await import('@earendil-works/pi-durable');
  if (!('attempt' in f.receipt.execution) || f.receipt.execution.attempt === null) throw Error('Missing original attempt.');
  const query = { workId: f.receipt.workId, sessionId: f.receipt.sessionId,
    attemptId: f.receipt.execution.attempt.attemptId, requestId: 'prepare-lost-model' };
  let preparations = 0;
  const runtime = need(await durable.createDurableRuntime({ storage: new native.MemoryStorage(), readApiKey: () => { throw Error('No credentials.'); },
    verifyModelUse: () => ({ ok: true, data: undefined }), reserveModelRequest: () => { throw Error('No model calls.'); } }));
  const service = new InvoiceWorkModelService({ database: { read: f.database.read, transaction: async operation => {
    await f.database.transaction(operation); throw Error('controlled outer model receipt loss'); } }, runtime, now: () => at,
    resolveConfiguration: () => { preparations++; return { ok: true, data: { version: 1, name: f.config.name, revision: 1,
      modelRef: f.config.requestedModel, native: { authPath: 'unused.json', modelsPath: null }, parameters: f.config.parameters,
      connection: { api: 'openai-completions', baseUrl: 'http://127.0.0.1:1/v1', contextWindow: 64000, maxTokens: 8192 } } }; } });
  try {
    const first = need(await service.prepare(query));
    expect(need(await service.prepare(query))).toEqual(first);
    expect(preparations).toBe(1);
    expect(await f.database.read(scope => scope.db.query('SELECT COUNT(*) count FROM invoice_work_model_bindings').get())).toEqual({ count: 1 });
    expect(await service.restore(query)).toMatchObject({ ok: false });
  } finally { need(await runtime.close()); }
});

test('creates one genuine Durable product agent Run for 65 fixed members without a fake Pi identity', async () => {
  const f = await fixture(65);
  const runId = need(await f.database.transaction(store => store.runs.createDurable(f.request)));
  const run = need(await f.database.read(store => { forbidLegacySql(store); return store.runs.get(runId); }));
  expect(run).toMatchObject({ kind: 'agent', runtimeKind: 'durable', status: 'created', jobId: null, sessionId: f.receipt.sessionId,
    config: f.config, scope: { version: 4, workId: f.request.workId, attemptId: f.request.attemptId, allowedTools: f.configuration.tools } });
  expect(await f.database.read(store => store.db.query('SELECT run_id FROM invoice_work_attempts WHERE id=?').get(f.request.attemptId)))
    .toEqual({ run_id: runId });
  expect(await f.database.read(store => store.db.query('SELECT native_session_id,durable_conversation_id FROM sessions WHERE id=?').get(f.receipt.sessionId)))
    .toEqual({ native_session_id: null, durable_conversation_id: null });
  expect(await f.database.read(store => store.db.query('SELECT COUNT(*) AS count FROM tool_calls').get())).toEqual({ count: 0 });
});

test('same-attempt creation returns its original Run and rejects another config without rebinding', async () => {
  const f = await fixture(), first = need(await f.database.transaction(store => store.runs.createDurable(f.request)));
  expect(await f.database.transaction(store => store.runs.createDurable(structuredClone(f.request)))).toEqual({ ok: true, data: first });
  expect(await f.database.transaction(store => store.runs.createDurable({ ...f.request, config: { ...f.config, name: 'Changed original configuration' } })))
    .toMatchObject({ ok: false, error: { code: 'state_conflict' } });
  expect(await f.database.read(store => store.db.query('SELECT COUNT(*) AS count FROM runs').get())).toEqual({ count: 1 });
});

test('Durable Run budgets may contract but cannot expand the authorization frozen before any Run', async () => {
  const f = await fixture();
  expect(await f.database.transaction(store => store.runs.createDurable({ ...f.request,
    config: { ...f.config, runtimeBudget: { ...f.config.runtimeBudget, maxModelCalls: f.config.runtimeBudget.maxModelCalls + 1 } } })))
    .toMatchObject({ ok: false, error: { code: 'state_conflict' } });
  expect(await f.database.transaction(store => store.runs.createDurable({ ...f.request,
    config: { ...f.config, limits: { ...f.config.limits, timeoutMs: f.config.limits.timeoutMs + 1 } } })))
    .toMatchObject({ ok: false, error: { code: 'state_conflict' } });
  expect(await f.database.read(store => store.db.query('SELECT COUNT(*) AS count FROM runs').get())).toEqual({ count: 0 });
  const smaller = { ...f.config, runtimeBudget: { ...f.config.runtimeBudget, maxModelCalls: f.config.runtimeBudget.maxModelCalls - 1 } };
  expect(await f.database.transaction(store => store.runs.createDurable({ ...f.request, config: smaller }))).toMatchObject({ ok: true });
});

test('Durable Run config rejects secret-bearing or Pi facts before a product Run is persisted', async () => {
  const f = await fixture();
  const withKey = { ...f.config, apiKey: 'synthetic-must-not-persist' };
  expect(await f.database.transaction(store => store.runs.createDurable({ ...f.request, config: withKey })))
    .toMatchObject({ ok: false, error: { code: 'input_invalid' } });
  expect(DurableRunConfigSnapshotSchema.safeParse({ ...f.config, agent: { nativeSessionId: 'fake-pi-session' } }).success).toBe(false);
  expect(DurableRunConfigSnapshotSchema.safeParse({ ...f.config, endpoint: 'not-a-url' }).success).toBe(false);
  expect(await f.database.read(store => store.db.query('SELECT COUNT(*) AS count FROM runs').get())).toEqual({ count: 0 });
});

test('first Durable Run cannot replace the resources, extensions or directory frozen by Work creation', async () => {
  const f = await fixture();
  const variants = [
    { ...f.config, resources: { prompt: { kind: 'prompt', id: 'unadmitted-prompt', version: 'v1' }, enabledSkills: [] } },
    { ...f.config, extensions: { enabledExtensions: [{ id: 'invoice-assist', version: 'v1' }] } },
    { ...f.config, workingDirectory: join(tmpdir(), 'unadmitted-durable-directory') },
  ].map(value => DurableRunConfigSnapshotSchema.parse(value));
  for (const config of variants) {
    expect(await f.database.transaction(store => store.runs.createDurable({ ...f.request, config })))
      .toMatchObject({ ok: false, error: { code: 'state_conflict' } });
  }
  expect(await f.database.read(store => store.db.query('SELECT COUNT(*) AS count FROM runs').get())).toEqual({ count: 0 });
  expect(await f.database.read(store => store.db.query('SELECT run_id FROM invoice_work_attempts WHERE id=?').get(f.request.attemptId)))
    .toEqual({ run_id: null });
});

test('Durable Run read, start and terminal retain the five-state lifecycle without touching Pi SQL or Workspace', async () => {
  const f = await fixture(), before = await f.database.read(store => store.db.query('SELECT * FROM workspace').get());
  const runId = need(await f.database.transaction(store => store.runs.createDurable(f.request)));
  expect(await f.database.transaction(store => { forbidLegacySql(store); return store.runs.start(runId, f.config, startedAt); })).toEqual({ ok: true, data: undefined });
  const output = DurableRunOutputSchema.parse({ version: 3, text: 'The actual attempt ended.', partial: false, stopReason: 'stop',
    responseId: null, responseModel: null, durable: { workId: f.request.workId, attemptId: f.request.attemptId } });
  const terminal: TerminalWrite = { status: 'completed', output, error: null,
    usage: { ...usage, reason: 'controlled-terminal', updatedAt: endedAt },
    tokens: { inputTokens: 1, outputTokens: 2, totalTokens: 3, cost: null, usageComplete: false },
    cleanup: { ...cleanup, stopped: true, stopReason: 'native-stop' }, endedAt, stoppedAt: endedAt, durationMs: 1000 };
  expect(await f.database.transaction(store => { forbidLegacySql(store); return store.runs.finish(runId, terminal); })).toEqual({ ok: true, data: true });
  const run = need(await f.database.read(store => { forbidLegacySql(store); return store.runs.get(runId); }));
  expect(run).toMatchObject({ kind: 'agent', runtimeKind: 'durable', status: 'completed', output, tokens: { totalTokens: 3 }, cleanup: { stopped: true } });
  expect(await f.database.transaction(store => store.runs.createDurable(f.request))).toEqual({ ok: true, data: runId });
  expect(await f.database.read(store => store.db.query('SELECT * FROM workspace').get())).toEqual(before);
});

test('Durable start rechecks a real material revocation after Run admission', async () => {
  const f = await fixture(), runId = need(await f.database.transaction(store => store.runs.createDurable(f.request)));
  expect(need(await f.database.transaction(store => store.sessions.revokeDocumentUse({ documentId: 1, at: startedAt }))))
    .toEqual({ affectedSessionIds: [f.receipt.sessionId] });
  expect(await f.database.transaction(store => { forbidLegacySql(store); return store.runs.start(runId, f.config, startedAt); }))
    .toMatchObject({ ok: false, error: { code: 'state_conflict' } });
  expect(need(await f.database.read(store => store.runs.get(runId))).status).toBe('created');
});

test('Work cancellation prevents a first Durable Run and stops an admitted Run before start without changing its original identity', async () => {
  const unopened = await fixture();
  need(await unopened.database.transaction(store => store.invoiceWorks.cancelWork({ workId: unopened.receipt.workId,
    requestId: 'cancel-before-run', expectedRevision: unopened.receipt.revision }, { at: startedAt })));
  expect(await unopened.database.transaction(store => store.runs.createDurable(unopened.request)))
    .toMatchObject({ ok: false, error: { code: 'state_conflict' } });
  expect(await unopened.database.read(store => store.db.query('SELECT COUNT(*) AS count FROM runs').get())).toEqual({ count: 0 });
  const f = await fixture(), runId = need(await f.database.transaction(store => store.runs.createDurable(f.request)));
  need(await f.database.transaction(store => store.invoiceWorks.cancelWork({ workId: f.receipt.workId,
    requestId: 'cancel-admitted-run', expectedRevision: f.receipt.revision }, { at: startedAt })));
  expect(await f.database.transaction(store => store.runs.start(runId, f.config, startedAt)))
    .toMatchObject({ ok: false, error: { code: 'state_conflict' } });
  expect(await f.database.transaction(store => store.runs.createDurable(f.request))).toEqual({ ok: true, data: runId });
  const terminal: TerminalWrite = { status: 'cancelled', output: null, error: appError('run_cancelled', 'runtime', 'The user stopped this attempt.'),
    usage, tokens: { inputTokens: null, outputTokens: null, totalTokens: null, cost: null, usageComplete: false },
    cleanup: { ...cleanup, stopped: true, stopReason: 'user' }, endedAt, stoppedAt: endedAt, durationMs: null, cancelRequestedAt: startedAt };
  expect(await f.database.transaction(store => { forbidLegacySql(store); return store.runs.finish(runId, terminal); })).toEqual({ ok: true, data: true });
  expect(need(await f.database.read(store => store.runs.get(runId)))).toMatchObject({ status: 'cancelled', cancelRequestedAt: startedAt });
});

test('a failed attempt binding rolls the genuine Durable Run, event and Session timestamp back together', async () => {
  const f = await fixture(), before = await f.database.read(store => store.db.query('SELECT updated_at FROM sessions WHERE id=?').get(f.receipt.sessionId));
  await f.database.transaction(store => store.db.exec(`CREATE TRIGGER reject_durable_run_binding BEFORE UPDATE OF run_id ON invoice_work_attempts
    WHEN NEW.run_id IS NOT NULL BEGIN SELECT RAISE(ABORT,'controlled-attempt-binding-failure'); END`));
  expect(await f.database.transaction(store => store.runs.createDurable(f.request)))
    .toMatchObject({ ok: false, error: { code: 'storage_write_failed' } });
  expect(await f.database.read(store => store.db.query('SELECT COUNT(*) AS count FROM runs').get())).toEqual({ count: 0 });
  expect(await f.database.read(store => store.db.query('SELECT COUNT(*) AS count FROM runtime_events WHERE run_id IS NOT NULL').get())).toEqual({ count: 0 });
  expect(await f.database.read(store => store.db.query('SELECT run_id FROM invoice_work_attempts WHERE id=?').get(f.request.attemptId)))
    .toEqual({ run_id: null });
  expect(await f.database.read(store => store.db.query('SELECT updated_at FROM sessions WHERE id=?').get(f.receipt.sessionId))).toEqual(before);
});

test('failed Durable output keeps its partial facts and rejects foreign attempt or Pi acknowledgements atomically', async () => {
  const f = await fixture(), runId = need(await f.database.transaction(store => store.runs.createDurable(f.request)));
  need(await f.database.transaction(store => store.runs.start(runId, f.config, startedAt)));
  const output = DurableRunOutputSchema.parse({ version: 3, text: 'The controlled native attempt failed after partial work.', partial: true,
    stopReason: 'error', responseId: null, responseModel: null, durable: { workId: f.request.workId, attemptId: f.request.attemptId } });
  const terminal: TerminalWrite = { status: 'failed', output, error: appError('controlled_native_failure', 'runtime', 'The controlled native attempt failed.'),
    usage, tokens: { inputTokens: 1, outputTokens: null, totalTokens: null, cost: null, usageComplete: false },
    cleanup: { ...cleanup, stopped: true, stopReason: 'error' }, endedAt, stoppedAt: endedAt, durationMs: 1000 };
  expect(await f.database.transaction(store => store.runs.finish(runId, { ...terminal, nativeHistoryUnusable: false })))
    .toMatchObject({ ok: false, error: { code: 'input_invalid' } });
  expect(await f.database.transaction(store => store.runs.finish(runId, { ...terminal,
    output: { ...output, durable: { ...output.durable, attemptId: output.durable.attemptId + 1 } } })))
    .toMatchObject({ ok: false, error: { code: 'state_conflict' } });
  expect(need(await f.database.read(store => store.runs.get(runId))).status).toBe('running');
  expect(await f.database.transaction(store => { forbidLegacySql(store); return store.runs.finish(runId, terminal); })).toEqual({ ok: true, data: true });
  expect(await f.database.transaction(store => store.runs.finish(runId, terminal))).toEqual({ ok: true, data: true });
  expect(need(await f.database.read(store => store.runs.get(runId)))).toMatchObject({ status: 'failed', output,
    error: { code: 'controlled_native_failure' }, cleanup: { stopped: true } });
});
