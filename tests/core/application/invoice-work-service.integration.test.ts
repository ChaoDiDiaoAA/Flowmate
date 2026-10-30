import { expect, test } from 'bun:test';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { writeFileSync } from 'node:fs';
import { prepareDurableModelBinding } from '@flowmate/runtime-durable';
import { appError, fail, ok, DurableWorkBudgetSchema, PersonalAgentConfigurationSchema, type InvoiceWorkCreateReceipt, type InvoiceWorkCreateRequest,
  type InvoiceWorkOperationReceipt, type InvoiceWorkSupplementRequest, type PersonalAgentConfiguration, type ProviderConfig,
  type RuntimeRequestOverrides, type Result } from '@flowmate/contracts';
import { InvoiceWorkService, type InvoiceWorkExecutionCommand, type InvoiceWorkServiceOptions } from '../../../packages/core/src/personal-agent/invoice-work.ts';
import { InvoiceWorkModelService } from '../../../packages/core/src/personal-agent/models.ts';
import { openTestDatabase } from '../../support/database.ts';
import { mkdtempSync } from '../../support/resources.ts';

const at = '2026-10-29T00:00:00.000Z';
function need<T>(value: Result<T>): T { if (!value.ok) throw Error(`${value.error.code}: ${value.error.message}`); return value.data; }

async function fixture(assess: InvoiceWorkServiceOptions['assessExecution'] = () => ok({ kind: 'queued' }),
  changed?: InvoiceWorkServiceOptions['onChanged'], captureModel?: InvoiceWorkServiceOptions['captureModel'],
  runtimeDefaults?: () => Result<RuntimeRequestOverrides>) {
  const root = mkdtempSync(join(tmpdir(), 'flowmate-invoice-work-service-'));
  const paths = { root, databaseFile: join(root, 'data/app.sqlite'), artifactsDir: join(root, 'artifacts'),
    outputsDir: join(root, 'outputs'), logsDir: join(root, 'logs'), runtimeDir: join(root, 'runtime') };
  const database = need(openTestDatabase(paths));
  await database.transaction(scope => {
    need(scope.personalAgents.ensureDefault(PersonalAgentConfigurationSchema.parse({ modelId: captureModel ? 'original-model' : null, thinkingLevel: 'off',
      resources: { prompt: null, enabledSkills: [] }, extensions: { enabledExtensions: [] }, tools: [], workingDirectory: null, preferences: '' }), at));
    for (let id = 1; id <= 2; id++) {
      const originalId = id * 2 - 1, parsedId = id * 2;
      const metadata = { version: 1 as const, sourceKey: 'work-service', sourceRecordId: `invoice-${id}`, sourceVersion: 'v1' };
      need(scope.documents.register({ documentId: id, sourceKey: metadata.sourceKey, sourceRecordId: metadata.sourceRecordId, version: 'v1',
        originalArtifact: { artifactId: originalId, kind: 'original', relativePath: `artifacts/${originalId}/source.md`, bytes: 1,
          mimeType: 'text/markdown', metadata: { ...metadata, files: [{ relativePath: 'source.md', bytes: 1, mimeType: 'text/markdown' }] }, createdAt: at },
        parsedArtifact: { artifactId: parsedId, kind: 'parsed', relativePath: `artifacts/${parsedId}/parsed.json`, bytes: 1,
          mimeType: 'application/json', metadata: { ...metadata, files: [{ relativePath: 'parsed.json', bytes: 1, mimeType: 'application/json' }] }, createdAt: at },
        status: 'available', metadata: { version: 2, pageCount: 1, warnings: [], allowedUsesClaim: ['Controlled service business records'],
          licenseVerification: 'not_verified', unavailableReason: null }, createdAt: at, updatedAt: at }));
    }
  });
  const assessed: InvoiceWorkExecutionCommand[] = [], notifications: InvoiceWorkOperationReceipt[] = [];
  // Controlled admission tests the facade boundary; it does not prove production qualification or SDK execution.
  const service = new InvoiceWorkService({ database, now: () => at, captureModel, runtimeDefaults,
    assessExecution: command => { assessed.push(structuredClone(command)); return assess(command); },
    onChanged: receipt => { notifications.push(structuredClone(receipt)); changed?.(receipt); } });
  const request: InvoiceWorkCreateRequest = { personalAgentId: 1, expectedAgentRevision: 0, requestId: 'service-create-original',
    goal: 'Review the fixed invoices.', documents: [{ id: 1, version: 'v1' }, { id: 2, version: 'v1' }] };
  const seedWork = () => database.transaction(scope => scope.invoiceWorks.create(request,
    { at, admission: { kind: 'waiting', reason: 'Only the original product record is seeded.' } }));
  const view = async (workId: number) => {
    const result = need(await database.read(scope => scope.invoiceWorks.get({ view: 'work', workId, limit: 100 })));
    if (result.view !== 'work') throw Error('Expected the original fixed member page.'); return result;
  };
  const effects = () => database.read(scope => scope.db.query(`SELECT
    (SELECT COUNT(*) FROM invoice_works) works,(SELECT COUNT(*) FROM sessions) sessions,
    (SELECT COUNT(*) FROM invoice_work_attempts) attempts,(SELECT COUNT(*) FROM invoice_work_inputs) inputs,
    (SELECT COUNT(*) FROM invoice_work_operations) operations,(SELECT COUNT(*) FROM runs) runs,
    (SELECT COUNT(*) FROM tool_calls) tools`).get());
  return { root, paths, database, service, request, assessed, notifications, seedWork, view, effects };
}

test('new Work freezes explicit runtime defaults once and later settings or reopening cannot replace its budget', async () => {
  let defaults: RuntimeRequestOverrides = { budget: { maxModelCalls: 32, maxToolCalls: 80, toolTimeoutMs: 15000 },
    timeoutMs: 300000, stopGraceMs: 1000 }, reads = 0;
  const f = await fixture(undefined, undefined, undefined, () => { reads++; return ok(defaults); });
  const readBudget = (database: typeof f.database, workId: number) => database.read(scope => DurableWorkBudgetSchema.parse(JSON.parse(scope.db
    .query<{ budget_json: string }, [number]>('SELECT budget_json FROM invoice_works WHERE id=?').get(workId)!.budget_json)));
  const created = need(await f.service.create(f.request)), original = await readBudget(f.database, created.workId);
  expect(original).toEqual({ runtimeBudget: { maxModelCalls: 32, maxToolCalls: 80, toolTimeoutMs: 15000,
    maxToolFeedbackBytes: 8 * 1024 * 1024 }, limits: { timeoutMs: 300000, stopGraceMs: 1000 } });
  defaults.budget!.maxModelCalls = 64;
  defaults = { budget: { maxModelCalls: 24 }, timeoutMs: 240000 };
  expect(await f.service.create(f.request)).toEqual(ok(created)); expect(reads).toBe(1);
  const newer = need(await f.service.create({ ...f.request, requestId: 'new-work-with-explicit-settings' }));
  expect(await readBudget(f.database, newer.workId)).toEqual({ runtimeBudget: { maxModelCalls: 24, maxToolCalls: 24,
    toolTimeoutMs: 10000, maxToolFeedbackBytes: 8 * 1024 * 1024 }, limits: { timeoutMs: 240000, stopGraceMs: 5000 } });
  expect(await readBudget(f.database, created.workId)).toEqual(original); expect(reads).toBe(2);
  await f.database.close();
  const reopened = need(openTestDatabase(f.paths)), service = new InvoiceWorkService({ database: reopened, now: () => at,
    runtimeDefaults: () => { throw Error('Original Work receipt lookup cannot read current runtime defaults.'); },
    assessExecution: () => { throw Error('Original Work receipt lookup cannot admit execution.'); }, onChanged: () => {} });
  expect(await service.create(f.request)).toEqual(ok(created));
  expect(await readBudget(reopened, created.workId)).toEqual(original);
});

test('Work reads current runtime defaults inside admission after asynchronous qualification', async () => {
  const entered = Promise.withResolvers<void>(), release = Promise.withResolvers<void>();
  let defaults: RuntimeRequestOverrides = { budget: { maxModelCalls: 24 } }, reads = 0;
  const f = await fixture(async () => { entered.resolve(); await release.promise; return ok({ kind: 'queued' }); },
    undefined, undefined, () => { reads++; return ok(defaults); });
  const creating = f.service.create(f.request);
  try {
    await entered.promise; expect(reads).toBe(0);
    defaults = { budget: { maxModelCalls: 32 }, timeoutMs: 300000 }; release.resolve();
    const created = need(await creating);
    const budget = await f.database.read(scope => DurableWorkBudgetSchema.parse(JSON.parse(scope.db
      .query<{ budget_json: string }, [number]>('SELECT budget_json FROM invoice_works WHERE id=?').get(created.workId)!.budget_json)));
    expect(budget.runtimeBudget.maxModelCalls).toBe(32); expect(budget.limits.timeoutMs).toBe(300000); expect(reads).toBe(1);
  } finally { release.resolve(); await creating; }
});

test('invalid or unavailable Work runtime defaults reject new admission without changing an original receipt', async () => {
  let configured: Result<RuntimeRequestOverrides> = ok({ budget: { maxModelCalls: 65 } });
  const f = await fixture(undefined, undefined, undefined, () => configured);
  expect(await f.service.create(f.request)).toMatchObject({ ok: false, error: { code: 'config_settings_invalid' } });
  expect(await f.effects()).toMatchObject({ works: 0, sessions: 0, attempts: 0, operations: 0 });
  const unavailable = fail(appError('config_settings_unavailable', 'input', 'Explicit runtime defaults are unavailable.'));
  configured = unavailable;
  expect(await f.service.create(f.request)).toEqual(unavailable); expect(f.notifications).toEqual([]);
  configured = ok({}); const created = need(await f.service.create(f.request)); configured = unavailable;
  expect(await f.service.create(f.request)).toEqual(ok(created));
  expect(await f.service.create({ ...f.request, requestId: 'new-work-with-unavailable-settings' })).toEqual(unavailable);
  expect(await f.effects()).toMatchObject({ works: 1, sessions: 1, attempts: 1, operations: 1 });
});

async function capturedFixture(assess?: InvoiceWorkServiceOptions['assessExecution'], changed?: InvoiceWorkServiceOptions['onChanged'],
  beforeCapture?: () => Promise<void>) {
  const captures: PersonalAgentConfiguration[] = [], captureScopes: unknown[] = [];
  let database: Awaited<ReturnType<typeof fixture>>['database'], profile: ProviderConfig;
  const f = await fixture(assess, changed, async configuration => {
    captures.push(structuredClone(configuration));
    captureScopes.push(await database.read(scope => ({ inTransaction: scope.db.inTransaction,
      works: scope.db.query<{ count: number }, []>('SELECT COUNT(*) count FROM invoice_works').get()!.count })));
    await beforeCapture?.();
    return prepareDurableModelBinding(profile);
  });
  database = f.database;
  const modelsPath = join(f.root, 'models.json');
  profile = { version: 1, name: 'original-model', revision: 3, modelRef: { provider: 'captured-provider', model: 'captured-model' },
    native: { authPath: join(f.root, 'unused-auth.json'), modelsPath }, parameters: { maxRetries: 0, maxRetryDelayMs: 1000 } };
  const catalog = (port: number, label: string) => writeFileSync(modelsPath, JSON.stringify({ providers: { 'captured-provider': {
    api: 'openai-completions', baseUrl: `http://127.0.0.1:${port}/v1`, apiKey: 'synthetic-file-credential',
    authHeader: true, headers: { 'X-Catalog': label }, models: [{ id: 'captured-model', name: label, input: ['text'], reasoning: false,
      contextWindow: 96000, maxTokens: 4096, cost: { input: 0.25, output: 0.5, cacheRead: 0, cacheWrite: 0 } }] } } }));
  catalog(1, 'original');
  const modelService = () => new InvoiceWorkModelService({ database, now: () => at,
    resolveConfiguration: () => { throw Error('An admitted work must never resolve the latest model profile.'); },
    runtime: { prepareModel: async () => { throw Error('The original binding was already captured by the real SDK parser.'); },
      restoreModel: async () => ok(undefined) } });
  return { ...f, captures, captureScopes, profile, modelsPath, catalog, modelService };
}

test('first Goal admission captures real SDK model facts outside SQL and later default changes cannot alter the original work', async () => {
  const f = await capturedFixture(), created = need(await f.service.create(f.request));
  const saved = need(await f.database.read(scope => scope.invoiceWorkModelBindings.getOriginal({ workId: created.workId })));
  expect(f.captureScopes).toEqual([{ inTransaction: false, works: 0 }]);
  expect(saved).toMatchObject({ workId: created.workId, modelId: 'original-model', binding: { configuration: { revision: 3 },
    request: { authHeader: true, headers: { 'X-Catalog': 'original' } } } });
  expect(JSON.parse(saved!.binding.modelJson)).toMatchObject({ baseUrl: 'http://127.0.0.1:1/v1', name: 'original', contextWindow: 96000 });
  expect(JSON.stringify(saved)).not.toContain('synthetic-file-credential');
  f.profile.revision = 4; f.catalog(2, 'latest');
  await f.database.transaction(scope => {
    const current = need(scope.personalAgents.getDefault()); if (!current) throw Error('Missing Personal Agent.');
    need(scope.personalAgents.update({ personalAgentId: current.personalAgentId, expectedRevision: current.revision,
      configuration: { ...current.configuration, preferences: 'Current defaults apply only to a new Goal.' }, at }));
  });
  expect(await f.service.create(f.request)).toEqual(ok(created));
  expect(f.captures).toHaveLength(1);
  const attemptId = created.execution.attempt?.attemptId; if (!attemptId) throw Error('Missing admitted attempt.');
  expect(need(await f.modelService().prepare({ workId: created.workId, sessionId: created.sessionId, attemptId, requestId: 'first-phase' })))
    .toEqual(saved!.binding);
  const newer = need(await f.service.create({ ...f.request, expectedAgentRevision: 1, requestId: 'new-goal-with-latest-default' }));
  const latest = need(await f.database.read(scope => scope.invoiceWorkModelBindings.getOriginal({ workId: newer.workId })));
  expect(latest!.binding.configuration.revision).toBe(4);
  expect(JSON.parse(latest!.binding.modelJson).baseUrl).toBe('http://127.0.0.1:2/v1');
  expect(need(await f.database.read(scope => scope.invoiceWorkModelBindings.getOriginal({ workId: created.workId })))).toEqual(saved);
  expect(await f.effects()).toMatchObject({ works: 2, attempts: 2, runs: 0, tools: 0 });
});

test('the expected Personal Agent revision is checked before capture and checked again when creating the Goal', async () => {
  const entered = Promise.withResolvers<void>(), release = Promise.withResolvers<void>();
  const f = await capturedFixture(undefined, undefined, async () => { entered.resolve(); await release.promise; });
  expect(await f.service.create({ ...f.request, expectedAgentRevision: 1 })).toMatchObject({ ok: false, error: { code: 'state_conflict' } });
  expect(f.captures).toEqual([]);
  const creating = f.service.create(f.request);
  try {
    await entered.promise;
    await f.database.transaction(scope => {
      const current = need(scope.personalAgents.getDefault()); if (!current) throw Error('Missing original Personal Agent.');
      need(scope.personalAgents.update({ personalAgentId: current.personalAgentId, expectedRevision: current.revision,
        configuration: { ...current.configuration, preferences: 'Changed while model capture was outside SQL.' }, at }));
    });
    release.resolve();
    expect(await creating).toMatchObject({ ok: false, error: { code: 'state_conflict' } });
    expect(await f.effects()).toMatchObject({ works: 0, sessions: 0, attempts: 0, operations: 0, runs: 0 });
    expect(await f.database.read(scope => scope.db.query('SELECT COUNT(*) count FROM invoice_work_model_bindings').get())).toEqual({ count: 0 });
    expect(f.notifications).toEqual([]);
  } finally { release.resolve(); await creating; }
});

test('a successfully captured model survives blocked admission without an attempt and is reused by explicit continue', async () => {
  let ready = false;
  const f = await capturedFixture(() => ready ? ok({ kind: 'queued' })
    : fail(appError('provider_auth_failed', 'provider', 'Execution authorization is unavailable.')));
  const created = need(await f.service.create(f.request));
  expect(created.execution).toMatchObject({ kind: 'blocked', authorizationAccepted: false, attempt: null });
  const original = need(await f.database.read(scope => scope.invoiceWorkModelBindings.getOriginal({ workId: created.workId })));
  expect(original).toMatchObject({ workId: created.workId, attemptId: null, binding: { configuration: { revision: 3 } } });
  writeFileSync(f.modelsPath, '{ unavailable later file'); ready = true;
  const continued = need(await f.service.continueWork({ workId: created.workId, requestId: 'continue-original-captured-model',
    expectedRevision: created.revision, expectedAttemptId: null }));
  const attemptId = continued.execution.attempt?.attemptId; if (!attemptId) throw Error('Missing explicitly continued attempt.');
  expect(need(await f.modelService().prepare({ workId: created.workId, sessionId: created.sessionId, attemptId, requestId: 'continued-phase' })))
    .toEqual(original!.binding);
  expect(need(await f.database.read(scope => scope.invoiceWorkModelBindings.get({ workId: created.workId, attemptId })))).toEqual(original);
  expect(f.captures).toHaveLength(1);
  expect(await f.database.read(scope => scope.db.query('SELECT COUNT(*) count FROM invoice_work_model_bindings').get())).toEqual({ count: 1 });
  expect(await f.effects()).toMatchObject({ works: 1, attempts: 1, runs: 0 });
});

test('an actual offline model parse failure stays blocked on replay and does not roll back a later lawful supplement', async () => {
  const f = await capturedFixture(() => fail(appError('original_model_binding_unavailable', 'runtime', 'The original binding is unavailable.')));
  writeFileSync(f.modelsPath, '{ invalid at admission');
  const created = need(await f.service.create(f.request));
  expect(created.execution).toMatchObject({ kind: 'blocked', authorizationAccepted: false, attempt: null,
    reason: { code: 'provider_model_configuration_unavailable' } });
  expect(f.assessed).toEqual([]); expect(f.captures).toHaveLength(1);
  f.catalog(2, 'repaired-latest');
  expect(await f.service.create(f.request)).toEqual(ok(created));
  const input = await clarification(f, created, 'clarify-model-blocked-goal'), saved = need(await f.service.supplement(input));
  expect(saved).toMatchObject({ saved: true, execution: { kind: 'blocked', authorizationAccepted: false, attempt: null } });
  expect(await f.database.read(scope => scope.db.query('SELECT text FROM invoice_work_inputs WHERE id=?').get(saved.inputId)))
    .toEqual({ text: input.text });
  expect(f.captures).toHaveLength(1);
  expect(await f.database.read(scope => scope.db.query('SELECT COUNT(*) count FROM invoice_work_model_bindings').get())).toEqual({ count: 0 });
  expect(await f.effects()).toMatchObject({ works: 1, attempts: 0, inputs: 1, runs: 0, tools: 0 });
});

async function clarification(f: Awaited<ReturnType<typeof fixture>>, created: InvoiceWorkCreateReceipt, requestId: string): Promise<InvoiceWorkSupplementRequest> {
  const initial = await f.view(created.workId), selected = initial.items[0];
  if (!selected) throw Error('Expected the original fixed item.');
  const todos = need(await f.database.transaction(scope => scope.invoiceWorks.replaceTodos({ workId: created.workId,
    itemId: selected.itemId, expectedRevision: selected.revision, at, todos: [{ actor: 'user', fieldPath: null,
      problem: 'The amount needs an explanation.', needed: 'Provide the original explanation.', satisfiedBy: 'An explanation is saved.', action: 'supplement',
      basis: { origin: 'user', documentRefs: [selected.documentRef], sourceRefs: [], inputIds: [], candidateRef: null } }] })));
  const current = await f.view(created.workId), todo = todos[0]; if (!todo) throw Error('Expected the original saved Todo.');
  return { workId: created.workId, itemId: selected.itemId, todoId: todo.todoId, requestId,
    expectedRevision: current.work.revision, text: 'Original user clarification.', materials: [] };
}

test('all read APIs return original product facts with zero assessment, notification or execution', async () => {
  const f = await fixture(), original = need(await f.seedWork()), before = await f.effects();
  expect(await f.service.queryOperation({ operation: 'create', personalAgentId: 1, requestId: f.request.requestId }))
    .toEqual({ ok: true, data: original });
  expect(await f.service.queryOperation({ operation: 'create', personalAgentId: 1, requestId: 'never-received' }))
    .toEqual({ ok: true, data: null });
  expect(await f.service.list({ personalAgentId: 1 })).toMatchObject({ ok: true, data: { items: [{ workId: original.workId }] } });
  expect(await f.service.get({ view: 'work', workId: original.workId })).toMatchObject({ ok: true, data: {
    view: 'work', work: { workId: original.workId, sessionId: original.sessionId }, items: [expect.any(Object), expect.any(Object)],
  } });
  expect(f.assessed).toEqual([]); expect(f.notifications).toEqual([]);
  expect(await f.effects()).toEqual(before);
  expect(before).toMatchObject({ works: 1, sessions: 1, attempts: 0, runs: 0, tools: 0 });
});

test('exact original retries skip assessment and changed intent conflicts without another notification', async () => {
  const f = await fixture(), original = need(await f.service.create(f.request)), before = await f.effects();
  expect(await f.service.create(f.request)).toEqual({ ok: true, data: original });
  expect(await f.service.create({ ...f.request, goal: 'A different intent with the original identity.' }))
    .toMatchObject({ ok: false, error: { code: 'state_conflict' } });
  expect(f.assessed).toHaveLength(1); expect(f.notifications).toEqual([original]);
  expect(await f.effects()).toEqual(before);
});

test('input is captured before assessment and owner waiting, and notification waits for real COMMIT', async () => {
  const assessing = Promise.withResolvers<void>(), assessmentRelease = Promise.withResolvers<void>();
  const f = await capturedFixture(async () => { assessing.resolve(); await assessmentRelease.promise; return ok({ kind: 'queued' }); });
  const input = structuredClone(f.request), original = structuredClone(input);
  let settled = false;
  const creating = f.service.create(input).then(value => { settled = true; return value; });
  await assessing.promise;
  input.goal = 'Changed after assessment began.'; input.documents[0]!.version = 'wrong-version'; input.requestId = 'changed-after-await';
  const entered = Promise.withResolvers<void>(), release = Promise.withResolvers<void>();
  const transaction = f.database.transaction;
  const holding = transaction(async () => { entered.resolve(); await release.promise; });
  await entered.promise;
  const commitEntered = Promise.withResolvers<void>(), commitRelease = Promise.withResolvers<void>();
  f.database.transaction = operation => {
    f.database.transaction = transaction;
    return transaction(async scope => {
      const value = await operation(scope);
      expect(scope.db.query(`SELECT (SELECT COUNT(*) FROM invoice_works) works,
        (SELECT COUNT(*) FROM invoice_work_operations) operations,(SELECT COUNT(*) FROM invoice_work_model_bindings) bindings`).get())
        .toEqual({ works: 1, operations: 1, bindings: 1 });
      commitEntered.resolve(); await commitRelease.promise; return value;
    });
  };
  try {
    assessmentRelease.resolve(); await new Promise<void>(resolve => setImmediate(resolve));
    expect(settled).toBe(false); expect(f.notifications).toEqual([]);
    release.resolve(); await holding; await commitEntered.promise;
    expect(settled).toBe(false); expect(f.notifications).toEqual([]);
    commitRelease.resolve(); const receipt = need(await creating);
    expect((await f.view(receipt.workId)).work.goal).toBe(original.goal);
    expect((await f.view(receipt.workId)).items.map(item => item.documentRef)).toEqual(original.documents);
    expect(f.assessed).toEqual([{ kind: 'create', request: original }]);
    expect(f.notifications).toEqual([receipt]);
    expect(f.captures).toHaveLength(1);
    expect(need(await f.database.read(scope => scope.invoiceWorkModelBindings.getOriginal({ workId: receipt.workId })))).not.toBeNull();
  } finally { assessmentRelease.resolve(); release.resolve(); commitRelease.resolve(); await holding; await creating; }
});

test('concurrent duplicate assessments produce one receipt, one admission and one committed notification', async () => {
  const bothAssessing = Promise.withResolvers<void>(), release = Promise.withResolvers<void>(); let assessments = 0;
  const f = await fixture(async () => { if (++assessments === 2) bothAssessing.resolve(); await release.promise; return ok({ kind: 'queued' }); });
  const first = f.service.create(f.request), second = f.service.create(structuredClone(f.request));
  try {
    await bothAssessing.promise; release.resolve();
    const original = need(await first);
    expect(await second).toEqual({ ok: true, data: original });
    expect(f.assessed).toHaveLength(2); expect(f.notifications).toEqual([original]);
    expect(await f.effects()).toEqual({ works: 1, sessions: 1, attempts: 1, inputs: 0, operations: 1, runs: 0, tools: 0 });
  } finally { release.resolve(); await first; await second; }
});

test('a response lost after actual owner COMMIT recovers the saved original receipt without recreating or renotifying', async () => {
  const f = await capturedFixture(), transaction = f.database.transaction;
  f.database.transaction = async operation => {
    f.database.transaction = transaction;
    await transaction(operation); throw Error('Controlled response loss after actual COMMIT.');
  };
  const recovered = need(await f.service.create(f.request));
  expect(await f.service.queryOperation({ operation: 'create', personalAgentId: 1, requestId: f.request.requestId }))
    .toEqual({ ok: true, data: recovered });
  expect(await f.service.create(f.request)).toEqual({ ok: true, data: recovered });
  expect(f.assessed).toHaveLength(1); expect(f.notifications).toEqual([recovered]);
  expect(f.captures).toHaveLength(1);
  expect(need(await f.database.read(scope => scope.invoiceWorkModelBindings.getOriginal({ workId: recovered.workId })))).not.toBeNull();
  expect(await f.effects()).toEqual({ works: 1, sessions: 1, attempts: 1, inputs: 0, operations: 1, runs: 0, tools: 0 });
});

test('a real COMMIT rejection stays unknown and recovery never recreates an absent original key', async () => {
  const f = await capturedFixture();
  await f.database.transaction(scope => scope.db.exec(`CREATE TABLE work_commit_parent(id INTEGER PRIMARY KEY);
    CREATE TABLE work_commit_child(id INTEGER PRIMARY KEY,parent_id INTEGER REFERENCES work_commit_parent(id) DEFERRABLE INITIALLY DEFERRED)`));
  const transaction = f.database.transaction;
  f.database.transaction = operation => {
    f.database.transaction = transaction;
    return transaction(async scope => { const value = await operation(scope);
      scope.db.query('INSERT INTO work_commit_child VALUES(1,404)').run(); return value; });
  };
  expect(await f.service.create(f.request)).toMatchObject({ ok: false, error: { code: 'storage_write_failed' } });
  expect(await f.service.queryOperation({ operation: 'create', personalAgentId: 1, requestId: f.request.requestId }))
    .toEqual({ ok: true, data: null });
  expect(f.assessed).toHaveLength(1); expect(f.notifications).toEqual([]);
  expect(f.captures).toHaveLength(1);
  expect(await f.database.read(scope => scope.db.query('SELECT COUNT(*) count FROM invoice_work_model_bindings').get())).toEqual({ count: 0 });
  expect(await f.effects()).toEqual({ works: 0, sessions: 0, attempts: 0, inputs: 0, operations: 0, runs: 0, tools: 0 });
});

test('a throwing notification preserves the committed business receipt and retries remain silent', async () => {
  const f = await capturedFixture(() => ok({ kind: 'queued' }), () => { throw Error('Controlled coordinator notification failure.'); });
  const original = need(await f.service.create(f.request));
  expect(await f.service.create(f.request)).toEqual({ ok: true, data: original });
  expect(await f.service.queryOperation({ operation: 'create', personalAgentId: 1, requestId: f.request.requestId }))
    .toEqual({ ok: true, data: original });
  expect(f.assessed).toHaveLength(1); expect(f.notifications).toEqual([original]);
  expect(f.captures).toHaveLength(1);
  expect(need(await f.database.read(scope => scope.invoiceWorkModelBindings.getOriginal({ workId: original.workId })))).not.toBeNull();
  expect(await f.effects()).toMatchObject({ works: 1, attempts: 1, runs: 0, tools: 0 });
});

test('saving a supplement can notify a fact without granting execution, and explicit continue has its own receipt', async () => {
  const f = await fixture(command => ok(command.kind === 'continueWork' ? { kind: 'queued' }
    : { kind: 'waiting', reason: 'The required execution qualification is still unavailable.' }));
  const created = need(await f.service.create(f.request)), request = await clarification(f, created, 'save-clarification-only');
  const saved = need(await f.service.supplement(request));
  expect(saved).toMatchObject({ saved: true, execution: { kind: 'waiting', authorizationAccepted: false, attempt: null } });
  expect(await f.service.supplement(request)).toEqual({ ok: true, data: saved });
  expect(await f.effects()).toMatchObject({ attempts: 0, inputs: 1, runs: 0, tools: 0 });
  expect(f.notifications).toEqual([created, saved]);
  const continuing = { workId: created.workId, requestId: 'explicit-continue-after-saving', expectedRevision: saved.revision, expectedAttemptId: null };
  const continued = need(await f.service.continueWork(continuing));
  expect(continued).toMatchObject({ execution: { kind: 'queued', authorizationAccepted: true, relation: 'new' } });
  expect(await f.service.continueWork(continuing)).toEqual({ ok: true, data: continued });
  expect(f.assessed.map(command => command.kind)).toEqual(['create', 'supplement', 'continueWork']);
  expect(f.notifications).toEqual([created, saved, continued]);
  expect(await f.effects()).toMatchObject({ attempts: 1, inputs: 1, runs: 0, tools: 0 });
});

test('final disposition and cancellation notify new saved facts without invoking an assessor', async () => {
  const f = await fixture(() => { throw Error('Final business decisions do not assess execution.'); });
  const created = need(await f.seedWork()), initial = await f.view(created.workId), item = initial.items[0];
  if (!item) throw Error('Expected the fixed invoice member.');
  const input = { workId: created.workId, itemId: item.itemId, requestId: 'explicit-disposition', expectedRevision: initial.work.revision,
    decision: { kind: 'excluded' as const, reason: 'Explicitly outside this Work.' } };
  const disposed = need(await f.service.disposeItem(input));
  const cancelling = { workId: created.workId, requestId: 'explicit-cancellation', expectedRevision: disposed.revision };
  const cancelled = need(await f.service.cancelWork(cancelling));
  expect(await f.service.disposeItem(input)).toEqual({ ok: true, data: disposed });
  expect(await f.service.cancelWork(cancelling)).toEqual({ ok: true, data: cancelled });
  expect(f.assessed).toEqual([]); expect(f.notifications).toEqual([disposed, cancelled]);
  expect((await f.view(created.workId)).work).toMatchObject({ status: 'cancelled', counts: { excluded: 1, unresolved: 1 } });
  expect(await f.effects()).toMatchObject({ attempts: 0, inputs: 0, runs: 0, tools: 0 });
});

test('assessment error Results persist blocked create and continue decisions without authorizing execution', async () => {
  const reason = appError('controlled_admission_denied', 'input', 'The current product qualification is unavailable.'), rejected = fail(reason);
  const f = await fixture(() => rejected), created = need(await f.service.create(f.request));
  expect(created).toMatchObject({ execution: { kind: 'blocked', authorizationAccepted: false, attempt: null, reason } });
  const continuing = { workId: created.workId, requestId: 'blocked-continue', expectedRevision: created.revision, expectedAttemptId: null };
  const continued = need(await f.service.continueWork(continuing));
  expect(continued).toMatchObject({ execution: { kind: 'blocked', authorizationAccepted: false, attempt: null, reason } });
  expect(await f.service.create(f.request)).toEqual({ ok: true, data: created });
  expect(await f.service.continueWork(continuing)).toEqual({ ok: true, data: continued });
  expect(f.assessed.map(command => command.kind)).toEqual(['create', 'continueWork']);
  expect(f.notifications).toEqual([created, continued]);
  expect(await f.effects()).toEqual({ works: 1, sessions: 1, attempts: 0, inputs: 0, operations: 2, runs: 0, tools: 0 });
});

for (const qualification of ['provider_auth_failed', 'throw'] as const) {
  test(`a legal supplement is saved with blocked authorization when execution qualification returns ${qualification}`, async () => {
    const f = await fixture(() => {
      if (qualification === 'throw') throw Error('SYNTHETIC_PRIVATE_QUALIFICATION_ERROR');
      return fail(appError('provider_auth_failed', 'provider', 'The selected provider credential is unavailable.'));
    });
    const created = need(await f.seedWork()), request = await clarification(f, created, `supplement-${qualification}`);
    const saved = need(await f.service.supplement(request));
    expect(saved).toMatchObject({ saved: true, execution: { kind: 'blocked', authorizationAccepted: false, attempt: null,
      reason: { code: qualification === 'throw' ? 'invoice_work_assessment_unavailable' : 'provider_auth_failed' } } });
    expect(await f.database.read(scope => scope.db.query('SELECT text,materials_json FROM invoice_work_inputs WHERE id=?').get(saved.inputId)))
      .toEqual({ text: request.text, materials_json: '[]' });
    expect(await f.service.queryOperation({ operation: 'supplement', workId: created.workId, requestId: request.requestId }))
      .toEqual({ ok: true, data: saved });
    expect(await f.service.supplement(request)).toEqual({ ok: true, data: saved });
    expect(f.assessed).toHaveLength(1); expect(f.notifications).toEqual([saved]);
    expect(JSON.stringify(saved)).not.toContain('SYNTHETIC_PRIVATE_QUALIFICATION_ERROR');
    expect(await f.effects()).toEqual({ works: 1, sessions: 1, attempts: 0, inputs: 1, operations: 2, runs: 0, tools: 0 });
  });
}

test('blocked execution qualification never bypasses the original supplement ownership checks', async () => {
  const f = await fixture(() => fail(appError('provider_auth_failed', 'provider', 'The selected credential is unavailable.')));
  const created = need(await f.seedWork()), original = await clarification(f, created, 'invalid-todo-ownership'), before = await f.effects();
  expect(await f.service.supplement({ ...original, todoId: 404 }))
    .toMatchObject({ ok: false, error: { code: 'state_conflict' } });
  expect(await f.service.queryOperation({ operation: 'supplement', workId: created.workId, requestId: original.requestId }))
    .toEqual({ ok: true, data: null });
  expect(f.notifications).toEqual([]);
  expect(await f.effects()).toEqual(before);
});
