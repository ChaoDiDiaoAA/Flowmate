import { expect, test } from 'bun:test';
import { createRequire } from 'node:module';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { appError, DurableRunConfigSnapshotSchema, DurableWorkBudgetSchema, PersonalAgentConfigurationSchema,
  type CleanupRecord, type DurableAttemptIdentity, type InvoiceWorkCreateReceipt, type InvoiceWorkCreateRequest,
  type Result, type RuntimeRequestOverrides, type UsageRecord } from '@flowmate/contracts';
import { DurableInvoiceGovernor } from '../../../packages/core/src/personal-agent/admission.ts';
import { InvoiceWorkService } from '../../../packages/core/src/personal-agent/invoice-work.ts';
import { createInvoiceWorkAttemptRepository } from '../../../packages/core/src/personal-agent/attempts.ts';
import { createDurableModels } from '../../../packages/runtime-durable/src/models.ts';
import { buildInvoiceWorkContext } from '../../../packages/runtime-durable/src/context.ts';
import { createInvoiceWorkToolBridge } from '../../../packages/core/src/personal-agent/tool-scope.ts';
import { createToolExecutor } from '../../../packages/core/src/tools/executor.ts';
import { createFileStore } from '../../../packages/core/src/storage/file-store.ts';
import { createDocumentService } from '@flowmate/data';
import { createInvoiceTools } from '@flowmate/employee-invoice';
import { openTestDatabase } from '../../support/database.ts';
import { mkdtempSync } from '../../support/resources.ts';

const at = '2026-10-29T00:00:00.000Z';
const requireRuntime = createRequire(new URL('../../../packages/runtime-durable/package.json', import.meta.url));
const installedVersion = (name: string): string => JSON.parse(readFileSync(requireRuntime.resolve(`${name}/package.json`), 'utf8')).version;
const sdk = { durable: installedVersion('@earendil-works/pi-durable'), ai: installedVersion('@earendil-works/pi-ai'),
  chord: installedVersion('@earendil-works/chord') };
const usage: UsageRecord = { version: 1, source: 'not-requested', reason: 'durable-not-started', sdkValues: null,
  attempts: 0, attemptsComplete: true, costSource: null, updatedAt: at };
const cleanup: CleanupRecord = { version: 1, stopped: false, stopReason: null, errors: [], lateObservationRequired: false };
function need<T>(result: Result<T>): T { if (!result.ok) throw Error(`${result.error.code}: ${result.error.message}`); return result.data; }
function identity(receipt: InvoiceWorkCreateReceipt): DurableAttemptIdentity {
  if (receipt.execution.attempt === null) throw Error('Expected the real admitted product attempt.');
  return { workId: receipt.workId, sessionId: receipt.sessionId, attemptId: receipt.execution.attempt.attemptId };
}

async function fixture(members = 1, runtimeDefaults?: () => Result<RuntimeRequestOverrides>) {
  const root = mkdtempSync(join(tmpdir(), 'flowmate-personal-admission-'));
  const paths = { root, databaseFile: join(root, 'data/app.sqlite'), artifactsDir: join(root, 'artifacts'),
    outputsDir: join(root, 'outputs'), logsDir: join(root, 'logs'), runtimeDir: join(root, 'runtime') };
  const database = need(openTestDatabase(paths));
  let time = at, foreground = false;
  const configuration = PersonalAgentConfigurationSchema.parse({ modelId: 'admission-fixture', thinkingLevel: 'off',
    resources: { prompt: null, enabledSkills: [] }, extensions: { enabledExtensions: [] }, tools: ['read_invoice_document'],
    workingDirectory: null, preferences: '' });
  await database.transaction(store => {
    need(store.personalAgents.ensureDefault(configuration, at));
    for (let documentId = 1; documentId <= members; documentId++) {
      const original = documentId * 2 - 1, parsed = documentId * 2;
      const originalContent = Buffer.from('Controlled invoice original');
      const parsedContent = Buffer.from(JSON.stringify({ formatVersion: 2, pages: [{ page: 1,
        blocks: [{ id: 'b1', kind: 'text', text: '总金额 113.00', sourceIndex: 0, sourceType: 'controlled', bbox: null }] }],
        completeness: { status: 'complete', checks: [], warnings: [] } }));
      for (const [artifactId, name, content] of [[original, 'original.pdf', originalContent], [parsed, 'parsed.json', parsedContent]] as const) {
        mkdirSync(join(paths.artifactsDir, String(artifactId)), { recursive: true });
        writeFileSync(join(paths.artifactsDir, String(artifactId), name), content);
        store.contents.remember({ ownerKind: 'artifact', ownerId: String(artifactId), relativePath: name }, content);
      }
      const metadata = { version: 1 as const, sourceKey: 'personal-admission', sourceRecordId: String(documentId), sourceVersion: 'v1' };
      need(store.documents.register({ documentId, sourceKey: metadata.sourceKey, sourceRecordId: metadata.sourceRecordId, version: 'v1',
        originalArtifact: { artifactId: original, kind: 'original', relativePath: `artifacts/${original}/original.pdf`, bytes: originalContent.length,
          mimeType: 'application/pdf', metadata: { ...metadata, files: [{ relativePath: 'original.pdf', bytes: originalContent.length, mimeType: 'application/pdf' }] }, createdAt: at },
        parsedArtifact: { artifactId: parsed, kind: 'parsed', relativePath: `artifacts/${parsed}/parsed.json`, bytes: parsedContent.length,
          mimeType: 'application/json', metadata: { ...metadata, files: [{ relativePath: 'parsed.json', bytes: parsedContent.length, mimeType: 'application/json' }] }, createdAt: at },
        status: 'available', metadata: { version: 2, pageCount: 1, warnings: [], allowedUsesClaim: ['Controlled product admission'],
          licenseVerification: 'not_verified', unavailableReason: null }, createdAt: at, updatedAt: at }));
    }
  });
  const governor = new DurableInvoiceGovernor(database, () => time, () => foreground);
  const service = new InvoiceWorkService({ database, now: () => time, runtimeDefaults,
    assessExecution: command => governor.assess(command), onChanged: () => {} });
  const request = (requestId: string): InvoiceWorkCreateRequest => ({ personalAgentId: 1, expectedAgentRevision: 0, requestId,
    goal: 'Review the fixed invoice set.', documents: Array.from({ length: members }, (_, index) => ({ id: index + 1, version: 'v1' })) });
  const create = (requestId = 'first-work') => service.create(request(requestId)).then(need);
  const view = async (workId: number) => {
    const page = need(await service.get({ view: 'work', workId, limit: 100 }));
    if (page.view !== 'work') throw Error('Expected the real Work page.'); return page;
  };
  const start = async (owner: DurableAttemptIdentity, initialUsage = usage, modelLimit?: number) => database.transaction(store => {
    expect(governor.assessInStore(store, owner.workId)).toEqual({ ok: true, data: { kind: 'ready' } });
    const row = store.db.query<{ budget_json: string }, [number]>('SELECT budget_json FROM invoice_works WHERE id=?').get(owner.workId)!;
    const budget = DurableWorkBudgetSchema.parse(JSON.parse(row.budget_json));
    const config = DurableRunConfigSnapshotSchema.parse({ version: 3, runtimeKind: 'durable', name: 'Governor production Run', revision: 1,
      requestedModel: { provider: 'admission-fixture', model: 'explicit-model' }, resolvedModel: null, api: null, endpoint: null, sdk,
      parameters: { maxRetries: 0, maxRetryDelayMs: 1000 }, ...budget,
      ...(modelLimit === undefined ? {} : { runtimeBudget: { ...budget.runtimeBudget, maxModelCalls: modelLimit } }),
      durable: { workId: owner.workId, attemptId: owner.attemptId, configurationRevision: 0 }, resources: configuration.resources,
      extensions: configuration.extensions, workingDirectory: null });
    const runId = need(store.runs.createDurable({ workId: owner.workId, attemptId: owner.attemptId, config, usage: initialUsage, cleanup,
      input: { version: 1, goal: 'Review the fixed invoice set.', text: 'Review the fixed invoice set.', messageTimestamp: Date.parse(at) }, createdAt: time }));
    need(store.runs.start(runId, config, time));
    return runId;
  });
  const finish = async (owner: DurableAttemptIdentity, runId: number, stopped = true, staleUsage?: UsageRecord,
    status: 'failed' | 'completed' = 'failed') => database.transaction(store => {
    const run = need(store.runs.get(runId));
    need(store.runs.finish(runId, { status, output: status === 'completed' ? { version: 3, text: 'The original phase settled.',
      partial: false, stopReason: 'stop', responseId: null, responseModel: null,
      durable: { workId: owner.workId, attemptId: owner.attemptId } } : null,
      error: status === 'completed' ? null : appError('agent_failed', 'runtime', 'Controlled root outcome.'),
      usage: staleUsage ?? run.usage, tokens: { inputTokens: null, outputTokens: null, totalTokens: null, cost: null, usageComplete: false },
      cleanup: { ...cleanup, stopped, stopReason: stopped ? 'confirmed-native-stop' : null }, endedAt: time,
      stoppedAt: stopped ? time : null, durationMs: Date.parse(time) - Date.parse(run.startedAt!) }));
    return need(createInvoiceWorkAttemptRepository(store.db).finish({ workId: owner.workId, attemptId: owner.attemptId,
      runId, at: time, effectsReconciled: true }));
  });
  const effects = () => database.read(store => store.db.query(`SELECT
    (SELECT COUNT(*) FROM invoice_work_attempts) attempts,(SELECT COUNT(*) FROM invoice_work_phases) phases,
    (SELECT COUNT(*) FROM runs) runs,(SELECT COUNT(*) FROM tool_calls) tools,
    (SELECT COALESCE(SUM(count),0) FROM invoice_work_model_reservations) modelReservations`).get());
  const reservations = (runId: number) => database.read(store => store.db.query<{ count: number }, [number]>(
    'SELECT count FROM invoice_work_model_reservations WHERE run_id=?').get(runId)?.count ?? 0);
  return { database, paths, governor, service, create, request, view, start, finish, effects, reservations,
    setTime: (value: string) => { time = value; }, setForeground: (value: boolean) => { foreground = value; } };
}

async function humanTodo(f: Awaited<ReturnType<typeof fixture>>, workId: number, itemIndex: number) {
  const page = await f.view(workId), item = page.items[itemIndex]!;
  return need(await f.database.transaction(store => store.invoiceWorks.replaceTodos({ workId, itemId: item.itemId,
    expectedRevision: item.revision, at, todos: [{ actor: 'user', fieldPath: null, problem: 'The original invoice needs clarification.',
      needed: 'Provide the original explanation.', satisfiedBy: 'A clarification is supplied.', action: 'supplement',
      basis: { origin: 'user', documentRefs: [item.documentRef], sourceRefs: [], inputIds: [], candidateRef: null } }] })))[0]!;
}

test('real durable admissions retain stable creation/id order after reopening the owner without read side effects', async () => {
  const f = await fixture(), first = await f.create(), second = await f.create('second-work');
  expect(first.execution.kind).toBe('accepted'); expect(second.execution.kind).toBe('queued');
  expect(await f.governor.assess(first.workId)).toEqual({ ok: true, data: { kind: 'ready' } });
  expect(await f.governor.assess(second.workId)).toEqual({ ok: true, data: { kind: 'queued' } });
  const before = await f.effects();
  for (let index = 0; index < 3; index++) {
    need(await f.service.list({ personalAgentId: 1, limit: 1 })); await f.view(first.workId);
    expect(await f.service.queryOperation({ operation: 'create', personalAgentId: 1, requestId: 'first-work' })).toEqual({ ok: true, data: first });
    expect(need(await f.governor.remainingBudget(first.workId)).modelCalls).toBe(16);
  }
  expect(await f.effects()).toEqual(before); expect(before).toMatchObject({ attempts: 2, runs: 0, tools: 0, modelReservations: 0 });
  await f.database.close();
  const reopened = need(openTestDatabase(f.paths)), governor = new DurableInvoiceGovernor(reopened, () => at, () => false);
  expect(await governor.assess(second.workId)).toEqual({ ok: true, data: { kind: 'queued' } });
  expect(await governor.assess(first.workId)).toEqual({ ok: true, data: { kind: 'ready' } });
});

test('actual transport reservations persist exactly the shared Work limit under concurrent callers and reads consume zero', async () => {
  const f = await fixture(), created = await f.create(), owner = identity(created), runId = await f.start(owner);
  const before = await f.effects();
  expect(await f.governor.verifyModelUse(owner)).toEqual({ ok: true, data: undefined });
  need(await f.governor.remainingBudget(owner.workId)); await f.view(owner.workId);
  expect(await f.effects()).toEqual(before);
  const reservations = await Promise.all(Array.from({ length: 24 }, () => f.governor.reserveModelRequest(owner)));
  expect(reservations.filter(result => result.ok)).toHaveLength(16);
  expect(reservations.filter(result => !result.ok)).toHaveLength(8);
  expect(await f.reservations(runId)).toBe(16);
  expect(need(await f.database.read(store => store.runs.get(runId))).usage).toMatchObject({ attempts: null, attemptsComplete: false });
  expect(need(await f.governor.remainingBudget(owner.workId)).modelCalls).toBe(0);
  expect(await f.governor.reserveModelRequest(owner)).toMatchObject({ ok: false, error: { code: 'agent_model_call_budget' } });
});

test('failure and explicit successor keep used request counts and elapsed time across the same Work', async () => {
  const f = await fixture(), created = await f.create(), first = identity(created), firstRun = await f.start(first);
  for (let index = 0; index < 5; index++) need(await f.governor.reserveModelRequest(first));
  f.setTime('2026-10-29T00:00:01.000Z');
  expect(await f.finish(first, firstRun)).toMatchObject({ closed: true });
  expect(need(await f.governor.remainingBudget(first.workId))).toMatchObject({ modelCalls: 11, timeoutMs: 119_000 });
  expect(await f.governor.assess(first.workId)).toMatchObject({ ok: true, data: { kind: 'waiting' } });
  const current = await f.view(first.workId), continued = need(await f.service.continueWork({ workId: first.workId,
    requestId: 'explicit-after-root-failure', expectedRevision: current.work.revision, expectedAttemptId: first.attemptId }));
  if (continued.execution.attempt === null) throw Error('Expected the genuine successor attempt.');
  const next = { ...first, attemptId: continued.execution.attempt.attemptId };
  expect(next.attemptId).not.toBe(first.attemptId);
  const secondRun = await f.start(next);
  const remaining = await Promise.all(Array.from({ length: 15 }, () => f.governor.reserveModelRequest(next)));
  expect(remaining.filter(result => result.ok)).toHaveLength(11);
  expect(await f.reservations(firstRun)).toBe(5);
  expect(await f.reservations(secondRun)).toBe(11);
  expect(await f.governor.reserveModelRequest(first)).toMatchObject({ ok: false, error: { code: 'state_conflict' } });
});

test('explicitly configured Work limits survive failure and continue without adopting larger current defaults', async () => {
  let defaults: RuntimeRequestOverrides = { budget: { maxModelCalls: 24 }, timeoutMs: 300000 };
  const f = await fixture(1, () => ({ ok: true, data: defaults })), created = await f.create(), first = identity(created), firstRun = await f.start(first);
  for (let index = 0; index < 5; index++) need(await f.governor.reserveModelRequest(first));
  f.setTime('2026-10-29T00:00:01.000Z'); expect(await f.finish(first, firstRun)).toMatchObject({ closed: true });
  defaults = { budget: { maxModelCalls: 64 }, timeoutMs: 600000 };
  const current = await f.view(first.workId), continued = need(await f.service.continueWork({ workId: first.workId,
    requestId: 'continue-with-original-explicit-budget', expectedRevision: current.work.revision, expectedAttemptId: first.attemptId }));
  if (continued.execution.attempt === null) throw Error('Expected the original Work successor attempt.');
  const next = { ...first, attemptId: continued.execution.attempt.attemptId }, runId = await f.start(next);
  expect(need(await f.governor.remainingBudget(first.workId))).toMatchObject({ modelCalls: 19, timeoutMs: 299000 });
  const reservations = await Promise.all(Array.from({ length: 20 }, () => f.governor.reserveModelRequest(next)));
  expect(reservations.filter(result => result.ok)).toHaveLength(19); expect(await f.reservations(runId)).toBe(19);
  expect(reservations.filter(result => !result.ok)).toEqual([expect.objectContaining({ error: expect.objectContaining({ code: 'agent_model_call_budget' }) })]);
});

test('cancelled Work rejects a real admitted identity immediately and unconfirmed stop keeps its root capacity', async () => {
  const f = await fixture(), created = await f.create(), owner = identity(created), runId = await f.start(owner), other = await f.create('other-work');
  need(await f.governor.reserveModelRequest(owner));
  const current = await f.view(owner.workId);
  need(await f.service.cancelWork({ workId: owner.workId, requestId: 'cancel-original', expectedRevision: current.work.revision }));
  expect(await f.governor.verifyModelUse(owner)).toMatchObject({ ok: false, error: { code: 'invoice_work_closed' } });
  expect(await f.governor.reserveModelRequest(owner)).toMatchObject({ ok: false, error: { code: 'invoice_work_closed' } });
  expect(await f.governor.assess(other.workId)).toEqual({ ok: true, data: { kind: 'queued' } });
  expect(await f.finish(owner, runId, false)).toMatchObject({ closed: false, reason: 'root-stop-unconfirmed' });
  expect(await f.governor.assess(other.workId)).toEqual({ ok: true, data: { kind: 'queued' } });
  expect(await f.reservations(runId)).toBe(1);
});

test('unknown prior request accounting blocks execution rather than resetting its count', async () => {
  for (const uncertain of [{ ...usage, attempts: null, attemptsComplete: false }, { ...usage, attemptsComplete: false }]) {
    const f = await fixture(), created = await f.create(), owner = identity(created), runId = await f.start(owner, uncertain);
    expect(await f.governor.verifyModelUse(owner)).toMatchObject({ ok: false, error: { code: 'invoice_work_budget_unknown' } });
    expect(await f.governor.reserveModelRequest(owner)).toMatchObject({ ok: false, error: { code: 'invoice_work_budget_unknown' } });
    expect(need(await f.database.read(store => store.runs.get(runId))).usage).toEqual(uncertain);
  }
});

test('one human-waiting invoice does not block another invoice and all-human waiting releases only unused admission', async () => {
  const f = await fixture(2), first = await f.create(), second = await f.create('second-work');
  await humanTodo(f, first.workId, 0);
  expect(await f.governor.assess(first.workId)).toEqual({ ok: true, data: { kind: 'ready' } });
  await humanTodo(f, first.workId, 1);
  expect(await f.governor.assess(first.workId)).toMatchObject({ ok: true, data: { kind: 'waiting' } });
  expect(await f.governor.assess(second.workId)).toEqual({ ok: true, data: { kind: 'ready' } });
  expect(await f.effects()).toMatchObject({ attempts: 2, runs: 0, tools: 0, modelReservations: 0 });
});

test('a persisted unresolved phase never releases its business root merely because all remaining Todos are human', async () => {
  const f = await fixture(), first = await f.create(), owner = identity(first), page = await f.view(first.workId), item = page.items[0]!;
  need(await f.database.transaction(store => store.invoiceWorks.freezePhase({ workId: owner.workId, attemptId: owner.attemptId,
    itemId: item.itemId, requestId: 'original-stage',
    kind: 'prompt', basis: { contextSnapshotId: null, inputIds: [], documentRefs: [item.documentRef],
      configurationRevision: 0, itemRevision: item.revision }, at })));
  await humanTodo(f, first.workId, 0);
  const second = await f.create('second-work');
  expect(second.execution.kind).toBe('queued');
  expect(await f.governor.assess(second.workId)).toEqual({ ok: true, data: { kind: 'queued' } });
  expect(await f.effects()).toMatchObject({ attempts: 2, phases: 1, runs: 0, modelReservations: 0 });
});

test('foreground execution causes admission waiting without request consumption or root failure', async () => {
  const f = await fixture(); f.setForeground(true);
  const created = await f.create(), owner = identity(created);
  expect(created.execution.kind).toBe('queued');
  expect(await f.governor.assess(owner.workId)).toEqual({ ok: true, data: { kind: 'queued' } });
  f.setForeground(false); const runId = await f.start(owner);
  f.setForeground(true);
  expect(await f.governor.verifyModelUse(owner)).toMatchObject({ ok: false, error: { code: 'invoice_work_admission_waiting', retryable: true } });
  expect(await f.governor.reserveModelRequest(owner)).toMatchObject({ ok: false, error: { code: 'invoice_work_admission_waiting' } });
  expect(need(await f.database.read(store => store.runs.get(runId)))).toMatchObject({ status: 'running', usage: { attempts: 0 } });
  f.setForeground(false); need(await f.governor.reserveModelRequest(owner));
  expect(await f.reservations(runId)).toBe(1);
  expect(need(await f.database.read(store => store.runs.get(runId)))).toMatchObject({ status: 'running', usage: { attempts: null } });
});

test('real material revocation after admission is checked again immediately before every model request', async () => {
  const f = await fixture(), created = await f.create(), owner = identity(created), runId = await f.start(owner);
  need(await f.database.transaction(store => store.sessions.revokeDocumentUse({ documentId: 1, at })));
  expect(await f.governor.verifyModelUse(owner)).toMatchObject({ ok: false, error: { code: 'session_scope_revoked' } });
  expect(await f.governor.reserveModelRequest(owner)).toMatchObject({ ok: false, error: { code: 'session_scope_revoked' } });
  expect(need(await f.database.read(store => store.runs.get(runId))).usage.attempts).toBe(0);
});

test('models require the original running Run and cannot borrow another real Work or Session identity', async () => {
  const f = await fixture(), created = await f.create(), owner = identity(created), other = await f.create('other-work');
  expect(await f.governor.verifyModelUse(owner)).toMatchObject({ ok: false, error: { code: 'state_conflict' } });
  await f.start(owner);
  expect(await f.governor.reserveModelRequest({ ...owner, sessionId: other.sessionId })).toMatchObject({ ok: false, error: { code: 'state_conflict' } });
  expect(await f.governor.reserveModelRequest({ ...owner, workId: other.workId })).toMatchObject({ ok: false, error: { code: 'state_conflict' } });
  expect(await f.effects()).toMatchObject({ modelReservations: 0 });
});

test('the actual Durable Models transport can spend its last one-request reservation and rejects the next transport', async () => {
  const f = await fixture(), created = await f.create(), owner = identity(created), runId = await f.start(owner, usage, 1);
  let requests = 0;
  const prepared = need(await createDurableModels({ version: 1, name: 'admission-model', revision: 1,
    modelRef: { provider: 'admission-fixture', model: 'explicit-model' }, native: { authPath: 'unused-auth.json', modelsPath: null },
    connection: { api: 'openai-completions', baseUrl: 'http://127.0.0.1:1/v1', contextWindow: 64_000, maxTokens: 8192 },
    parameters: { maxRetries: 0, maxRetryDelayMs: 1000 } }, {
    readApiKey: async () => 'controlled-product-key', verifyModelUse: () => f.governor.verifyModelUse(owner),
    reserveModelRequest: () => f.governor.reserveModelRequest(owner), fetch: async () => {
      requests++;
      expect(await f.reservations(runId)).toBe(1);
      expect(need(await f.database.read(store => store.runs.get(runId))).usage).toMatchObject({ attempts: null, attemptsComplete: false });
      const chunk = (delta: unknown, finish_reason: string | null) => `data: ${JSON.stringify({ id: 'admission',
        choices: [{ index: 0, delta, finish_reason }] })}\n\n`;
      return new Response(chunk({ role: 'assistant', content: 'The authorized request reached transport.' }, null)
        + chunk({}, 'stop') + 'data: [DONE]\n\n', { headers: { 'content-type': 'text/event-stream' } });
    } }));
  const model = prepared.models.getModel(prepared.modelRef.provider, prepared.modelRef.modelId);
  if (!model) throw Error('The explicit controlled model was not registered.');
  const context = { messages: [{ role: 'user' as const, content: 'Review the authorized invoice.', timestamp: 1 }] };
  expect((await prepared.models.completeSimple(model, context)).stopReason).toBe('stop');
  expect(requests).toBe(1);
  expect(await f.governor.verifyModelUse(owner)).toEqual({ ok: true, data: undefined });
  expect((await prepared.models.completeSimple(model, context)).stopReason).toBe('error');
  expect(requests).toBe(1);
  expect(await f.reservations(runId)).toBe(1);
});

test('the actual shared foreground Run blocks admission until its persisted execution has stopped', async () => {
  const f = await fixture(), created = await f.create();
  const provider = need(await f.database.transaction(store => store.runs.create({ goal: 'Controlled foreground execution',
    input: { version: 1, goal: 'Controlled foreground execution', text: 'Controlled input', messageTimestamp: Date.parse(at) },
    config: { version: 1, name: 'foreground-provider', revision: 1, requestedModel: { provider: 'fixture', model: 'fixture' },
      resolvedModel: null, api: 'openai-completions', endpoint: null, sdk: { codingAgent: '1.4.0', ai: '1.4.0' },
      parameters: { maxRetries: 0, maxRetryDelayMs: 1000 }, limits: { timeoutMs: 60_000, stopGraceMs: 5000 },
      native: { authSource: 'pi-native', modelsSelection: null } }, usage, cleanup, createdAt: at })));
  expect(await f.governor.assess(created.workId)).toEqual({ ok: true, data: { kind: 'queued' } });
  need(await f.database.transaction(store => store.runs.finish(provider, { status: 'failed', output: null,
    error: appError('run_cancelled', 'runtime', 'The controlled foreground execution ended.'), usage,
    tokens: { inputTokens: null, outputTokens: null, totalTokens: null, cost: null, usageComplete: false },
    cleanup: { ...cleanup, stopped: true, stopReason: 'confirmed-native-stop' }, endedAt: at, stoppedAt: at, durationMs: null })));
  expect(await f.governor.assess(created.workId)).toEqual({ ok: true, data: { kind: 'ready' } });
  expect(await f.effects()).toMatchObject({ attempts: 1, runs: 1, modelReservations: 0 });
});

test.each(['completed', 'failed'] as const)('new invoice clarification after %s preserves the correct successor authorization', async status => {
  const f = await fixture(), created = await f.create(), first = identity(created), runId = await f.start(first);
  const todo = await humanTodo(f, first.workId, 0);
  expect(await f.finish(first, runId, true, undefined, status)).toMatchObject({ closed: true });
  const current = await f.view(first.workId);
  const received = need(await f.service.supplement({ workId: first.workId, itemId: todo.itemId, todoId: todo.todoId,
    requestId: 'new-clarification', expectedRevision: current.work.revision, text: 'The original explanation.', materials: [] }));
  if (status === 'completed') {
    expect(received.execution).toMatchObject({ kind: 'accepted', authorizationAccepted: true, relation: 'new' });
    expect(received.execution.attempt?.attemptId).not.toBe(first.attemptId);
    expect(await f.governor.assess(first.workId)).toEqual({ ok: true, data: { kind: 'ready' } });
  } else {
    expect(received.execution).toMatchObject({ kind: 'waiting', authorizationAccepted: false });
    expect(received.execution.attempt?.attemptId).toBe(first.attemptId);
    expect(await f.governor.assess(first.workId)).toMatchObject({ ok: true, data: { kind: 'waiting' } });
    expect(await f.effects()).toMatchObject({ attempts: 1, modelReservations: 0 });
  }
});

test('withdrawal after a real Models reservation causes zero transports while conservatively retaining its quota', async () => {
  const f = await fixture(), created = await f.create(), owner = identity(created), runId = await f.start(owner, usage, 1);
  let requests = 0;
  const prepared = need(await createDurableModels({ version: 1, name: 'post-reservation-withdrawal', revision: 1,
    modelRef: { provider: 'admission-fixture', model: 'explicit-model' }, native: { authPath: 'unused-auth.json', modelsPath: null },
    connection: { api: 'openai-completions', baseUrl: 'http://127.0.0.1:1/v1', contextWindow: 64_000, maxTokens: 8192 },
    parameters: { maxRetries: 0, maxRetryDelayMs: 1000 } }, {
    readApiKey: async () => 'controlled-product-key', verifyModelUse: () => f.governor.verifyModelUse(owner),
    reserveModelRequest: async () => {
      const reserved = await f.governor.reserveModelRequest(owner);
      if (reserved.ok) need(await f.database.transaction(store => store.sessions.revokeDocumentUse({ documentId: 1, at })));
      return reserved;
    }, fetch: async () => { requests++; throw Error('Revoked transport must not execute.'); } }));
  const model = prepared.models.getModel(prepared.modelRef.provider, prepared.modelRef.modelId);
  if (!model) throw Error('The explicit controlled model was not registered.');
  const result = await prepared.models.completeSimple(model, { messages: [{ role: 'user', content: 'Review.', timestamp: 1 }] });
  expect(result.stopReason).toBe('error'); expect(requests).toBe(0);
  expect(await f.reservations(runId)).toBe(1);
  expect(need(await f.governor.remainingBudget(owner.workId)).modelCalls).toBe(15);
  expect(need(await f.database.read(store => store.runs.get(runId))).usage).toMatchObject({
    attempts: null, attemptsComplete: false, source: 'unknown', reason: 'model-request-reserved' });
});

test('exact native tool feedback admits the next model, deducts its UTF-8 bytes once and keeps missing proof blocked', async () => {
  const f = await fixture(), created = await f.create(), owner = identity(created), runId = await f.start(owner);
  const remaining = need(await f.governor.remainingBudget(owner.workId));
  const phase = await f.database.transaction(store => {
    const before = need(store.invoiceWorks.get({ view: 'work', workId: owner.workId }));
    if (before.view !== 'work' || !before.items[0]) throw Error('Expected the original invoice item.');
    const itemId = before.items[0].itemId;
    need(store.invoiceWorks.prepareItemJob({ workId: owner.workId, itemId, expectedRevision: before.items[0].revision, at }));
    const current = need(store.invoiceWorks.get({ view: 'item', workId: owner.workId, itemId }));
    if (current.view !== 'item') throw Error('Expected the original invoice item.');
    const frozen = need(store.invoiceWorks.freezePhase({ workId: owner.workId, attemptId: owner.attemptId, itemId,
      requestId: 'governed-tool-phase', kind: 'prompt', basis: { contextSnapshotId: null, inputIds: [],
        documentRefs: [current.item.documentRef], configurationRevision: 0, itemRevision: current.item.revision }, at }));
    const context = need(buildInvoiceWorkContext(need(store.invoiceWorks.readContextInput({ workId: owner.workId,
      attemptId: owner.attemptId, requestId: frozen.requestId, remainingBudget: remaining }))));
    need(store.invoiceWorkContexts.save({ context, at }));
    return need(store.invoiceWorks.linkPhase({ workId: owner.workId, attemptId: owner.attemptId,
      phaseId: frozen.phaseId, nativeConversationId: 101, nativeSubmissionId: 102, at }));
  });
  const files = createFileStore(f.paths, f.database), documents = createDocumentService({ paths: f.paths, files,
    allowedSourceRoot: f.paths.root, now: () => at, transaction: operation => f.database.transaction(store => operation({ repository: store.documents,
      files: { read: (artifact, name) => files.read(artifact, name, store.contents) } })) });
  const definitions = createInvoiceTools({ documents: { readParsedForRun: (id, context) => f.database.read(store =>
    documents.readParsedForRun(id, context, { repository: store.documents, files: { read: (artifact, name) => files.read(artifact, name, store.contents) } })) },
    documentRepository: { get: id => f.database.read(store => store.documents.get(id)) },
    candidates: { save: input => f.database.transaction(store => store.candidates.save(input)),
      listForRun: input => f.database.read(store => store.candidates.listForRun(input)),
      readForRun: input => f.database.read(store => store.candidates.readForRun(input)) }, now: () => at });
  const bridge = createInvoiceWorkToolBridge({ database: f.database, executor: createToolExecutor({ database: f.database, definitions, now: () => at }) });
  const call = { ...owner, requestId: phase.requestId, nativeConversationId: phase.nativeConversationId!, nativeTaskId: 103,
    nativeToolCallId: 'governed-native-tool', name: 'read_invoice_document', arguments: { documentId: 1, page: 1, afterBlockId: null, limit: 10 } };
  const result = need(await bridge.executeTool({ ...call, signal: new AbortController().signal }));
  expect(result.status).toBe('succeeded');
  expect(await f.governor.remainingBudget(owner.workId)).toMatchObject({ ok: false, error: { code: 'invoice_work_budget_unknown' } });
  expect(await f.governor.verifyModelUse(owner)).toMatchObject({ ok: false, error: { code: 'invoice_work_budget_unknown' } });
  const feedbackJson = JSON.stringify({ role: 'toolResult', toolCallId: call.nativeToolCallId, toolName: call.name,
    isError: false, content: [{ type: 'text', text: JSON.stringify(result) }], details: result, timestamp: 1, durationMs: 1 });
  const bytes = Buffer.byteLength(feedbackJson, 'utf8');
  expect(bytes).toBeGreaterThan(feedbackJson.length);
  const feedback = { ...call, nativeEntryId: 104, feedbackJson };
  expect(await bridge.onToolFeedback(feedback)).toEqual({ ok: true, data: undefined });
  expect(need(await f.governor.remainingBudget(owner.workId))).toMatchObject({
    toolCalls: remaining.toolCalls - 1, toolFeedbackBytes: remaining.toolFeedbackBytes - bytes });
  expect(await f.governor.verifyModelUse(owner)).toEqual({ ok: true, data: undefined });
  need(await bridge.onToolFeedback(feedback));
  expect(need(await bridge.readToolResult(call))).toEqual(result);
  expect(need(await f.governor.remainingBudget(owner.workId)).toolFeedbackBytes).toBe(remaining.toolFeedbackBytes - bytes);
  expect(need(await f.database.read(store => store.runs.get(runId))).toolCallCount).toBe(1);
});

async function consumedClarification() {
  const f = await fixture(), created = await f.create(), owner = identity(created), todo = await humanTodo(f, owner.workId, 0);
  const received = need(await f.service.supplement({ workId: owner.workId, itemId: todo.itemId, todoId: todo.todoId,
    requestId: 'original-clarification', expectedRevision: (await f.view(owner.workId)).work.revision,
    text: 'The invoice total includes the stated tax.', materials: [] }));
  expect(received.execution.authorizationAccepted).toBe(true);
  const runId = await f.start(owner);
  for (let index = 0; index < 3; index++) need(await f.governor.reserveModelRequest(owner));
  const freeze = async (currentOwner: DurableAttemptIdentity, requestId: string, inputIds: number[]) => {
    const budget = need(await f.governor.remainingBudget(owner.workId));
    return f.database.transaction(store => {
      const current = need(store.invoiceWorks.get({ view: 'item', workId: owner.workId, itemId: todo.itemId }));
      if (current.view !== 'item') throw Error('Expected the original invoice item.');
      const phase = need(store.invoiceWorks.freezePhase({ workId: owner.workId, attemptId: currentOwner.attemptId, itemId: todo.itemId,
        requestId, kind: 'prompt', basis: { contextSnapshotId: null, inputIds, documentRefs: [current.item.documentRef],
          configurationRevision: 0, itemRevision: current.item.revision }, at }));
      const context = need(buildInvoiceWorkContext(need(store.invoiceWorks.readContextInput({ workId: owner.workId,
        attemptId: currentOwner.attemptId, requestId, remainingBudget: budget }))));
      need(store.invoiceWorkContexts.save({ context, at }));
      return { context, phase: need(store.invoiceWorks.linkPhase({ workId: owner.workId, attemptId: currentOwner.attemptId,
        phaseId: phase.phaseId, nativeConversationId: 301, nativeSubmissionId: phase.phaseId + 400, at })) };
    });
  };
  const observe = (currentOwner: DurableAttemptIdentity, phase: Awaited<ReturnType<typeof freeze>>['phase'], closed = true) =>
    f.database.transaction(store => store.invoiceWorks.recordPhaseObservation({ observation: { ...currentOwner, requestId: phase.requestId,
      nativeConversationId: phase.nativeConversationId!, nativeSubmissionId: phase.nativeSubmissionId!, nativeEntryId: phase.phaseId + 500,
      status: closed ? 'unanswered' : 'placed', consumedAt: at, execution: closed ? 'closed' : 'active' }, at }));
  const original = await freeze(owner, 'original-consumed-clarification', [received.inputId]);
  need(await observe(owner, original.phase));
  expect(await f.finish(owner, runId)).toMatchObject({ closed: true });
  return { ...f, owner, runId, todo, received, freeze, observe };
}

test('explicit continuation can finish a consumed clarification once without turning history into a recurring trigger', async () => {
  const f = await consumedClarification();
  expect(await f.governor.assess(f.owner.workId)).toMatchObject({ ok: true, data: { kind: 'waiting' } });
  const before = await f.effects();
  await f.service.list({ personalAgentId: 1 }); await f.view(f.owner.workId);
  expect(await f.effects()).toEqual(before);
  const continued = need(await f.service.continueWork({ workId: f.owner.workId, requestId: 'continue-unfinished-clarification',
    expectedRevision: (await f.view(f.owner.workId)).work.revision, expectedAttemptId: f.owner.attemptId }));
  expect(continued.execution).toMatchObject({ kind: 'accepted', authorizationAccepted: true, relation: 'new' });
  if (!continued.execution.attempt) throw Error('Expected the newly authorized attempt.');
  const next = { ...f.owner, attemptId: continued.execution.attempt.attemptId };
  expect(await f.governor.assess(next.workId)).toEqual({ ok: true, data: { kind: 'ready' } });
  expect(need(await f.governor.remainingBudget(next.workId)).modelCalls).toBe(13);
  const nextRun = await f.start(next);
  await expect(f.freeze(next, 'must-not-consume-old-input-again', [f.received.inputId])).rejects.toThrow('source_invalid');
  const resumed = await f.freeze(next, 'unfinished-business-using-historical-evidence', []);
  expect(resumed.context.phase.basis.inputIds).toEqual([]);
  expect(resumed.context.historicalInputReferences[0]).toMatchObject({ inputId: f.received.inputId,
    content: { provenance: 'user-provided', text: 'The invoice total includes the stated tax.' } });
  need(await f.governor.reserveModelRequest(next));
  need(await f.observe(next, resumed.phase, false));
  expect(await f.governor.assess(next.workId)).toEqual({ ok: true, data: { kind: 'ready' } });
  need(await f.observe(next, resumed.phase));
  for (let index = 0; index < 2; index++)
    expect(await f.governor.assess(next.workId)).toMatchObject({ ok: true, data: { kind: 'waiting' } });
  expect(need(await f.governor.remainingBudget(next.workId)).modelCalls).toBe(12);
  expect(await f.service.queryOperation({ operation: 'supplement', workId: next.workId, requestId: 'original-clarification' }))
    .toEqual({ ok: true, data: f.received });
  expect(await f.database.read(store => store.db.query(`SELECT COUNT(*) count FROM invoice_work_phases p,json_each(p.basis_json,'$.inputIds') used
    WHERE p.work_id=? AND p.consumed_at IS NOT NULL AND used.value=?`).get(next.workId, f.received.inputId))).toEqual({ count: 1 });
  expect(await f.finish(next, nextRun)).toMatchObject({ closed: true });
  const retried = need(await f.service.continueWork({ workId: next.workId, requestId: 'explicitly-retry-the-second-failure',
    expectedRevision: (await f.view(next.workId)).work.revision, expectedAttemptId: next.attemptId }));
  expect(retried.execution).toMatchObject({ kind: 'accepted', authorizationAccepted: true, relation: 'new' });
  expect(need(await f.governor.remainingBudget(next.workId)).modelCalls).toBe(12);
});

test.each(['review', 'already-insufficient'] as const)('consumed history cannot restart a %s Todo without new material', async state => {
  const f = await consumedClarification(), item = (await f.view(f.owner.workId)).items[0]!;
  need(await f.database.transaction(store => store.invoiceWorks.replaceTodos({ workId: f.owner.workId, itemId: item.itemId,
    expectedRevision: item.revision, at, todos: [{ actor: 'user', fieldPath: null, action: state === 'review' ? 'review' : 'supplement',
      problem: 'The supplied clarification was checked.', needed: 'A different original document is still required.',
      satisfiedBy: 'A user supplies new evidence or completes review.', basis: { origin: 'model', documentRefs: [item.documentRef],
        sourceRefs: [], inputIds: [f.received.inputId], candidateRef: null } }] })));
  const request = { workId: f.owner.workId, requestId: 'continue-without-new-evidence',
    expectedRevision: (await f.view(f.owner.workId)).work.revision, expectedAttemptId: f.owner.attemptId };
  const before = await f.effects(), receipt = need(await f.service.continueWork(request));
  expect(receipt.execution).toMatchObject({ kind: 'waiting', authorizationAccepted: false });
  expect(await f.service.continueWork(request)).toEqual({ ok: true, data: receipt });
  expect(await f.governor.assess(f.owner.workId)).toMatchObject({ ok: true, data: { kind: 'waiting' } });
  expect(await f.effects()).toEqual(before);
});

test('saving a new clarification after failure and reopening the owner does not grant historical execution', async () => {
  const f = await consumedClarification();
  const saved = need(await f.service.supplement({ workId: f.owner.workId, itemId: f.todo.itemId, todoId: f.todo.todoId,
    requestId: 'saved-only-after-failure', expectedRevision: (await f.view(f.owner.workId)).work.revision,
    text: 'Additional material saved after stopping.', materials: [] }));
  expect(saved.execution).toMatchObject({ kind: 'waiting', authorizationAccepted: false });
  expect(await f.governor.assess(f.owner.workId)).toMatchObject({ ok: true, data: { kind: 'waiting' } });
  await f.database.close();
  const reopened = need(openTestDatabase(f.paths)), governor = new DurableInvoiceGovernor(reopened, () => at, () => false);
  expect(await governor.assess(f.owner.workId)).toMatchObject({ ok: true, data: { kind: 'waiting' } });
  expect(need(await governor.remainingBudget(f.owner.workId)).modelCalls).toBe(13);
});
