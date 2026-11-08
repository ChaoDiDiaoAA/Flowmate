import { expect, test } from 'bun:test';
import { createRequire } from 'node:module';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { appError, fail, ok, DurableRunConfigSnapshotSchema, DurableSubagentConfigSnapshotSchema, DurableWorkBudgetSchema,
  InvoiceWorkContextBuildInputSchema, RuntimeRequestOverridesSchema, PersonalAgentConfigurationSchema,
  type CleanupRecord, type DurableAttemptIdentity, type InvoiceWorkCreateReceipt, type InvoiceWorkCreateRequest,
  type Result, type RuntimeRequestOverrides, type UsageRecord } from '@flowmate/contracts';
import { DurableInvoiceGovernor } from '../../../packages/core/src/personal-agent/admission.ts';
import { createPersonalAgentRuntime } from '../../../apps/personal-agent.ts';
import { startCloudAuthorityEndpoints } from '../../../apps/cloud-authority-service.ts';
import { CloudQueueAuthority } from '../../../apps/cloud-queue-authority.ts';
import { CloudResourceUpload } from '../../../apps/cloud-resource-upload.ts';
import { CloudDeliveryAuthority } from '../../../apps/cloud-delivery-authority.ts';
import { CloudDesktopReview } from '../../../apps/cloud-desktop-review.ts';
import { createCloudDesktopHandler } from '../../../apps/cloud-desktop-gateway.ts';
import { PersonalAgentCommandSchema } from '../../../packages/contracts/src/personal-agent-commands.ts';
import { CloudModelAttempts } from '../../../packages/core/src/personal-agent/cloud-model-attempts.ts';
import { CloudDeepSeekProxy } from '../../../apps/cloud-deepseek-proxy.ts';
import { callCloudModelSocket, listenCloudModelSocket } from '../../../apps/cloud-model-socket.ts';
import { createCloudRuntimeAuthorizer } from '../../../apps/cloud-runtime-authority.ts';
import { CloudNativeResultReceiver } from '../../../apps/cloud-native-result-receiver.ts';
import { createCloudDesktopAuthorizer, createCloudProgressReader } from '../../../apps/cloud-desktop-authority.ts';
import { CloudProgressHub } from '../../../apps/cloud-progress.ts';
import { createCloudAuthorityCallbacksClient, createCloudAuthorityRpcClient, createCloudAuthorityRpcHandler } from '../../../apps/cloud-authority-rpc.ts';
import { callCloudUnixRpc, listenCloudUnixRpc } from '../../../apps/cloud-unix-rpc.ts';
import { InvoiceWorkService } from '../../../packages/core/src/personal-agent/invoice-work.ts';
import { createInvoiceWorkAttemptRepository } from '../../../packages/core/src/personal-agent/attempts.ts';
import { createDurableModels } from '../../../packages/runtime-durable/src/models.ts';
import { buildInvoiceWorkContext } from '../../../packages/runtime-durable/src/context.ts';
import { formatInvoiceWorkContext } from '../../../packages/runtime-durable/src/context.ts';
import { InvoiceWorkPhaseContextService, InvoiceWorkPhaseObserver } from '../../../packages/core/src/personal-agent/phase-context.ts';
import { InvoiceWorkCoordinator } from '../../../packages/core/src/personal-agent/coordination.ts';
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
  const start = async (owner: DurableAttemptIdentity, initialUsage = usage, modelLimit?: number, admission = governor) => database.transaction(store => {
    expect(admission.assessInStore(store, owner.workId)).toEqual({ ok: true, data: { kind: 'ready' } });
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

test('cloud Work creation persists one owner and lists or reads only its original workspace', async () => {
  const f = await fixture(), workspaceA = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', workspaceB = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
  await f.database.transaction(scope => {
    for (const [workspace, upload] of [[workspaceA, '11111111-1111-4111-8111-111111111111'], [workspaceB, '22222222-2222-4222-8222-222222222222']])
      scope.db.query('INSERT INTO cloud_workspace_documents(workspace_id,upload_id,document_id,document_version) VALUES(?,?,?,?)').run(workspace, upload, 1, 'v1');
  });
  const service = (cloudWorkspaceId: string) => new InvoiceWorkService({ database: f.database, now: () => at, cloudWorkspaceId,
    assessExecution: () => ({ ok: true, data: { kind: 'queued' } }), onChanged: () => {} });
  const first = service(workspaceA), second = service(workspaceB), request = f.request('cloud-workspace-a');
  const created = need(await first.create(request));
  expect(need(await first.create(request))).toEqual(created);
  const session = need(await f.database.read(store => store.sessions.get(created.sessionId)));
  expect(session).toMatchObject({ runtimeKind: 'durable', durableRuntimeId: expect.any(String), cloudWorkspaceId: workspaceA });
  expect(session.runtimeKind === 'durable' && session.durableRuntimeId).not.toBe('local');
  const other = need(await second.create(f.request('cloud-workspace-b')));
  expect((need(await first.list({ personalAgentId: 1, limit: 50 }))).items.map(value => value.workId)).toEqual([created.workId]);
  expect(await first.get({ view: 'work', workId: other.workId, limit: 10 })).toMatchObject({ ok: false, error: { code: 'cloud_workspace_forbidden' } });
  expect(await first.queryOperation({ operation: 'create', personalAgentId: 1, requestId: 'cloud-workspace-b' })).toEqual({ ok: true, data: null });
  expect(await second.create(request)).toMatchObject({ ok: false });
});

test('cloud original invoice review is bound to its Work, document version, and current permission', async () => {
  const { f, work, request } = await cloudModelFixture(), page = await f.view(work.workId), item = page.items[0]!;
  const started = Promise.withResolvers<void>(), release = Promise.withResolvers<void>(); let reads = 0, hold = false;
  const review = new CloudDesktopReview({ database: f.database, workspaceId: request.workspaceId, readOriginal: async () => {
    reads++; if (hold) { started.resolve(); await release.promise; }
    return ok({ documentRef: item.documentRef, mimeType: 'image/png' as const, base64: 'iVBORw0KGgo=' });
  } });
  const handler = createCloudDesktopHandler({ workspaceId: request.workspaceId, authorize: async () => ok(undefined),
    dispatch: async () => fail(appError('unused', 'input', 'Unused.')), review });
  const command = { type: 'cloud_review_original' as const, input: { workId: work.workId, itemId: item.itemId,
    documentRef: item.documentRef, page: 1 as const } };
  const envelope = { version: 1 as const, workspaceId: request.workspaceId,
    requestId: '22222222-2222-4222-8222-222222222222', command };
  try {
    expect(await handler(envelope)).toEqual({ ok: true, data: { workId: work.workId, itemId: item.itemId,
      documentRef: item.documentRef, mimeType: 'image/png', base64: 'iVBORw0KGgo=' } });
    expect(await handler({ ...envelope, command: { ...command, input: { ...command.input, documentRef: { ...item.documentRef, version: 'other' } } } }))
      .toMatchObject({ ok: false });
    expect(await handler({ ...envelope, command: { ...command, input: { ...command.input, workId: work.workId + 100 } } }))
      .toMatchObject({ ok: false });
    expect(reads).toBe(1);
    hold = true; const pending = handler(envelope); await started.promise;
    need(await f.database.transaction(scope => scope.documents.setAvailability({ documentId: item.documentRef.id,
      status: 'unavailable', reason: 'controlled-read-unavailable', at })));
    release.resolve(); expect(await pending).toMatchObject({ ok: false });
  } finally { release.resolve(); await f.database.close(); }
});

test('cloud parsed invoice pages retain their Work and document identity', async () => {
  const { f, work, request } = await cloudModelFixture(), item = (await f.view(work.workId)).items[0]!; let reads = 0;
  const saved = { documentRef: item.documentRef, parsedArtifactId: 2, page: 1, pageCount: 1,
    blocks: [], nextAfterBlockId: null, completePage: true };
  const review = new CloudDesktopReview({ database: f.database, workspaceId: request.workspaceId,
    readOriginal: async () => fail(appError('unused', 'input', 'Unused.')),
    readPage: async () => { reads++; return ok(saved); } });
  const handler = createCloudDesktopHandler({ workspaceId: request.workspaceId, authorize: async () => ok(undefined),
    dispatch: async () => fail(appError('unused', 'input', 'Unused.')), review });
  const command = { type: 'cloud_review_page' as const, input: { workId: work.workId, itemId: item.itemId,
    documentRef: item.documentRef, page: 1, afterBlockId: null, limit: 10 } };
  const envelope = { version: 1 as const, workspaceId: request.workspaceId,
    requestId: '22222222-2222-4222-8222-222222222222', command };
  try {
    expect(await handler(envelope)).toEqual({ ok: true, data: { workId: work.workId, itemId: item.itemId, page: saved } });
    expect(await handler({ ...envelope, command: { ...command, input: { ...command.input, itemId: item.itemId + 100 } } }))
      .toMatchObject({ ok: false });
    expect(reads).toBe(1);
  } finally { await f.database.close(); }
});

test('cloud Personal Agent assembly uses the supplied runtime and persists cloud ownership without opening local native storage', async () => {
  const f = await fixture(), workspaceId = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'; let closed = 0;
  const remote = { close: async () => { closed++; return { ok: true as const, data: undefined }; } } as import('@flowmate/contracts').DurableRuntimePort;
  const config = { version: 1 as const, name: 'controlled-cloud', revision: 1,
    modelRef: { provider: 'deepseek', model: 'fixture' }, native: { authPath: 'unused', modelsPath: null },
    connection: { api: 'openai-completions' as const, baseUrl: 'https://api.deepseek.com', contextWindow: 64000, maxTokens: 8192 },
    parameters: { maxRetries: 0, maxRetryDelayMs: 1000 } };
  const runtime = need(await createPersonalAgentRuntime({ database: f.database, definitions: [], resourceRoot: f.paths.root,
    bundleRoot: f.paths.runtimeDir, resolveConfiguration: () => ({ ok: true, data: config }), readApiKey: () => 'synthetic',
    foregroundBusy: () => true, now: () => at, cloud: { workspaceId, runtime: remote } }));
  try {
    await f.database.transaction(scope => scope.db.query('INSERT INTO cloud_workspace_documents(workspace_id,upload_id,document_id,document_version) VALUES(?,?,?,?)')
      .run(workspaceId, '11111111-1111-4111-8111-111111111111', 1, 'v1'));
    const created = need(await runtime.personal.works.create(f.request('assembled-cloud')));
    expect(created.execution.kind).toBe('accepted');
    const second = need(await runtime.personal.works.create(f.request('assembled-cloud-second')));
    const third = need(await runtime.personal.works.create(f.request('assembled-cloud-third')));
    expect(second.execution.kind).toBe('accepted'); expect(third.execution.kind).toBe('queued');
    const session = need(await f.database.read(scope => scope.sessions.get(created.sessionId)));
    expect(session).toMatchObject({ runtimeKind: 'durable', cloudWorkspaceId: workspaceId });
    expect(session.runtimeKind === 'durable' && session.durableRuntimeId).not.toBe('local');
    expect(await f.database.read(scope => scope.db.query("SELECT name FROM sqlite_master WHERE name GLOB 'fm_durable_*' LIMIT 1").get())).toBeNull();
  } finally { need(await runtime.close()); await f.database.close(); }
  expect(closed).toBe(1);
});

test.skipIf(process.platform !== 'linux')('Authority endpoints route authorized desktop Work to the cloud business owner', async () => {
  const f = await fixture(), workspaceId = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
  const port = { close: async () => ({ ok: true as const, data: undefined }) } as import('@flowmate/contracts').DurableRuntimePort;
  const config = { version: 1 as const, name: 'controlled-cloud', revision: 1, modelRef: { provider: 'deepseek', model: 'fixture' },
    native: { authPath: 'unused', modelsPath: null }, connection: { api: 'openai-completions' as const,
      baseUrl: 'https://api.deepseek.com', contextWindow: 64000, maxTokens: 8192 }, parameters: { maxRetries: 0, maxRetryDelayMs: 1000 } };
  const personal = need(await createPersonalAgentRuntime({ database: f.database, definitions: [], resourceRoot: f.paths.root,
    bundleRoot: f.paths.runtimeDir, resolveConfiguration: () => ({ ok: true, data: config }), readApiKey: () => 'synthetic',
    foregroundBusy: () => false, now: () => at, cloud: { workspaceId, runtime: port } }));
  if (!personal.cloudAuthority) throw Error('Cloud callbacks are missing.');
  let contextCalls = 0;
  personal.cloudAuthority.callbacks.readWorkingContext = async () => { contextCalls++; return fail(appError('source_invalid', 'input', 'Controlled.')); };
  await f.database.transaction(scope => scope.db.query(`INSERT INTO cloud_workspace_documents(workspace_id,upload_id,document_id,document_version)
    VALUES(?,?,?,?)`).run(workspaceId, '11111111-1111-4111-8111-111111111111', 1, 'v1'));
  const desktopSocket = join(f.paths.root, 'desktop.sock'), authoritySocket = join(f.paths.root, 'authority.sock'), modelSocket = join(f.paths.root, 'model.sock');
  const endpoints = need(await startCloudAuthorityEndpoints({ workspaceId, database: f.database, personal, runtime: port,
    files: createFileStore(f.paths, f.database), inspect: () => fail(appError('source_invalid', 'input', 'Unused.')),
    now: () => at, readApiKey: () => 'synthetic', desktopSocket, authoritySocket, modelSocket }));
  try {
    const envelope = { version: 1, workspaceId, requestId: '22222222-2222-4222-8222-222222222222' };
    expect(await callCloudUnixRpc(desktopSocket, { ...envelope, command: { type: 'personal_agent_get', input: {} } }))
      .toMatchObject({ ok: true, data: { ok: true, data: { personalAgentId: 1 } } });
    const created = await callCloudUnixRpc(desktopSocket, { ...envelope, command: { type: 'invoice_work_create', input: f.request('endpoint-work') } });
    expect(created).toMatchObject({ ok: true, data: { ok: true, data: { operation: 'create' } } });
    if (!created.ok || !(created.data as { ok: boolean }).ok) throw Error('Cloud Work creation failed.');
    const sessionId = (created.data as { data: { sessionId: number } }).data.sessionId;
    expect(need(await f.database.read(scope => scope.sessions.get(sessionId)))).toMatchObject({ cloudWorkspaceId: workspaceId });
    const otherWorkspace = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
    await f.database.transaction(scope => scope.db.query(`INSERT INTO cloud_workspace_documents(workspace_id,upload_id,document_id,document_version)
      VALUES(?,?,?,?)`).run(otherWorkspace, '33333333-3333-4333-8333-333333333333', 1, 'v1'));
    const other = new InvoiceWorkService({ database: f.database, now: () => at, cloudWorkspaceId: otherWorkspace,
      assessExecution: () => ({ ok: true, data: { kind: 'queued' } }), onChanged: () => {} });
    const foreign = need(await other.create(f.request('foreign-endpoint-work')));
    const attemptId = foreign.execution.attempt?.attemptId; if (!attemptId) throw Error('Missing foreign attempt.');
    expect(await callCloudUnixRpc(authoritySocket, { version: 1, method: 'readWorkingContext', request: {
      workId: foreign.workId, sessionId: foreign.sessionId, attemptId, requestId: 'foreign-phase' } })).toMatchObject({ ok: true, data: { ok: false } });
    expect(contextCalls).toBe(0);
    expect(await callCloudUnixRpc(desktopSocket, { ...envelope, workspaceId: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
      command: { type: 'personal_agent_get', input: {} } })).toMatchObject({ ok: true, data: { ok: false } });
  } finally { need(await endpoints.close()); need(await personal.close()); await f.database.close(); }
});

test('cloud desktop authorization accepts only Workspace-owned Work and approved invoice versions', async () => {
  const f = await fixture(2), workspaceId = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
  const service = new InvoiceWorkService({ database: f.database, now: () => at, cloudWorkspaceId: workspaceId,
    assessExecution: () => ({ ok: true, data: { kind: 'queued' } }), onChanged: () => {} });
  await f.database.transaction(store => store.db.query(`INSERT INTO cloud_workspace_documents(workspace_id,upload_id,document_id,document_version)
    VALUES(?,?,?,?)`).run(workspaceId, '11111111-1111-4111-8111-111111111111', 1, 'v1'));
  expect(await service.create({ ...f.request('unapproved-service-work'), documents: [{ id: 2, version: 'v1' }] })).toMatchObject({ ok: false });
  const work = need(await service.create({ ...f.request('cloud-scoped-work'), documents: [{ id: 1, version: 'v1' }] }));
  const local = await f.create('local-not-cloud'), authorize = createCloudDesktopAuthorizer(f.database, workspaceId);
  expect(await authorize({ type: 'invoice_work_get', input: { view: 'work', workId: work.workId, limit: 10 } })).toEqual({ ok: true, data: undefined });
  expect(await authorize({ type: 'invoice_work_get', input: { view: 'work', workId: local.workId, limit: 10 } })).toMatchObject({ ok: false });
  for (const command of [
    { type: 'invoice_work_desktop_list', input: { workId: work.workId, itemId: 1, limit: 10 } },
    { type: 'invoice_work_desktop_decide', input: { workId: work.workId, itemId: 1, proposalId: 1, expectedRevision: 0, requestId: 'approval', decision: 'approve' } },
    { type: 'invoice_work_desktop_query_decision', input: { workId: work.workId, itemId: 1, proposalId: 1, requestId: 'approval' } },
  ] as const) {
    expect(await authorize(command)).toEqual({ ok: true, data: undefined });
    expect(await authorize(PersonalAgentCommandSchema.parse({ ...command, input: { ...command.input, workId: local.workId } })))
      .toMatchObject({ ok: false, error: { code: 'cloud_workspace_forbidden' } });
  }
  expect(await authorize({ type: 'invoice_work_create', input: { ...f.request('approved-upload'), documents: [{ id: 1, version: 'v1' }] } }))
    .toEqual({ ok: true, data: undefined });
  expect(await authorize({ type: 'invoice_work_create', input: { ...f.request('unapproved-upload'), documents: [{ id: 2, version: 'v1' }] } }))
    .toMatchObject({ ok: false });
  expect(await authorize({ type: 'invoice_work_create', input: { ...f.request('wrong-version'), documents: [{ id: 1, version: 'v2' }] } }))
    .toMatchObject({ ok: false });
});

test('cloud configuration accepts only resource versions uploaded to its original workspace', async () => {
  const f = await fixture(), workspaceId = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
  const agent = need(await f.database.read(scope => scope.personalAgents.getDefault())); if (!agent) throw Error('The original assistant is unavailable.');
  const ref = { kind: 'prompt' as const, id: 'invoice', version: 'v1' };
  const configuration = { ...agent.configuration, resources: { prompt: ref, enabledSkills: [] } };
  const command = { type: 'personal_agent_update' as const, input: { personalAgentId: agent.personalAgentId,
    expectedRevision: agent.revision, configuration } };
  const authorize = createCloudDesktopAuthorizer(f.database, workspaceId);
  try {
    expect(await authorize(command)).toMatchObject({ ok: false });
    await f.database.transaction(scope => scope.db.query('INSERT INTO cloud_workspace_resources(workspace_id,upload_id,kind,resource_id,resource_version) VALUES(?,?,?,?,?)')
      .run('bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb', '11111111-1111-4111-8111-111111111111', ref.kind, ref.id, ref.version));
    expect(await authorize(command)).toMatchObject({ ok: false });
    await f.database.transaction(scope => scope.db.query('INSERT INTO cloud_workspace_resources(workspace_id,upload_id,kind,resource_id,resource_version) VALUES(?,?,?,?,?)')
      .run(workspaceId, '11111111-1111-4111-8111-111111111111', ref.kind, ref.id, ref.version));
    expect(await authorize(command)).toMatchObject({ ok: false });
    const body = Buffer.from('Original uploaded prompt.'), manifest = { schemaVersion: 2 as const, ...ref, bodyFile: 'prompt.md' as const,
      keywords: [], requires: [], files: [{ path: 'prompt.md', bytes: body.length }] };
    const upload = new CloudResourceUpload({ database: f.database, resourceRoot: join(f.paths.root, 'builtins'),
      importedResourceRoot: join(f.paths.root, 'cloud-resources'), now: () => at });
    const key = { workspaceId, uploadId: '22222222-2222-4222-8222-222222222222' };
    need(await upload.begin({ version: 1, ...key, ref, manifest, manifestBase64: Buffer.from(JSON.stringify(manifest)).toString('base64') }));
    need(await upload.append({ ...key, path: 'prompt.md', offset: 0, base64: body.toString('base64') }));
    need(await upload.finish(key));
    expect(await authorize(command)).toEqual({ ok: true, data: undefined });
    expect(await authorize({ ...command, input: { ...command.input, configuration: { ...configuration,
      resources: { ...configuration.resources, prompt: { ...ref, version: 'v2' } } } } })).toMatchObject({ ok: false });
  } finally { await f.database.close(); }
});

test('Authority records the original queue control and recovers a lost Runtime receipt without reapplying it', async () => {
  const { f, owner, request } = await cloudModelFixture(), workspaceId = request.workspaceId;
  const item = { submissionId: request.nativeSubmissionId, requestId: request.requestId,
    mode: 'followUp' as const, content: 'Original controlled input' };
  let applied = 0, wakes = 0, foreign = false, receipt: import('@flowmate/contracts').CloudQueueReceipt | null = null;
  const runtime: import('@flowmate/contracts').CloudQueuePort = {
    read: async () => ({ ok: true, data: { ...owner, version: 3, items: [foreign ? { ...item, submissionId: item.submissionId + 1 } : item] } }),
    queryControl: async () => ({ ok: true, data: receipt }),
    apply: async input => { applied++; receipt = { ...owner, controlRequestId: input.controlRequestId, status: 'applied', version: 4 };
      return fail(appError('cloud_transport_result_unknown', 'runtime', 'Controlled lost receipt.', true)); },
  };
  const authority = new CloudQueueAuthority({ database: f.database, workspaceId, runtime, now: () => at, onChanged: () => { wakes++; },
    authorize: (_input, queue) => queue.items[0]?.requestId === item.requestId ? { ok: true, data: undefined }
      : fail(appError('source_invalid', 'input', 'The original queue is unavailable.')) });
  const input = { ...owner, controlRequestId: 'original-queue-cancel', expectedVersion: 3,
    action: { kind: 'cancel' as const, submissionId: item.submissionId } };
  const expected = { ...owner, controlRequestId: input.controlRequestId, status: 'applied' as const, version: 4 };
  try {
    foreign = true; expect(await authority.read(owner)).toMatchObject({ ok: false }); foreign = false;
    expect(await authority.apply(input)).toMatchObject({ ok: false, error: { code: 'operation_result_unknown' } });
    expect(applied).toBe(1);
    expect(need(await authority.queryControl({ ...owner, controlRequestId: input.controlRequestId }))).toEqual(expected);
    expect(wakes).toBe(1);
    expect(need(await authority.apply(input))).toEqual(expected);
    expect(await authority.apply({ ...input, action: { kind: 'cancel', submissionId: 99 } })).toMatchObject({ ok: false });
    expect(applied).toBe(1);
  } finally { await f.database.close(); }
});

test('Authority keeps queue controls and receipts bound to the selected invoice', async () => {
  const { f, owner, request, work } = await cloudModelFixture(2);
  try {
    const items = (await f.view(work.workId)).items;
    await f.database.transaction(store => store.db.query('UPDATE invoice_work_phases SET closed_at=? WHERE id=?').run(at, request.phaseId));
    const phases = await f.database.transaction(store => items.map((item, index) => {
      if (index === 1) store.db.query("UPDATE invoice_work_phases SET scheduler_state='waiting_approval' WHERE request_id='invoice-queue-one'").run();
      const phase = need(store.invoiceWorks.freezePhase({ workId: work.workId, attemptId: owner.attemptId, itemId: item.itemId,
        requestId: index === 0 ? 'invoice-queue-one' : 'invoice-queue-two', kind: 'prompt', at,
        basis: { contextSnapshotId: null, inputIds: [], documentRefs: [item.documentRef], configurationRevision: 0,
          itemRevision: item.revision, executionMode: 'item-lane-approval-v1' } }));
      need(store.invoiceWorks.linkPhase({ workId: work.workId, attemptId: owner.attemptId, phaseId: phase.phaseId,
        nativeConversationId: 45 + index, nativeSubmissionId: 55 + index, at }));
      return phase;
    }));
    let applied = 0, foreign = false;
    const runtime: import('@flowmate/contracts').CloudQueuePort = {
      read: async input => { const index = items.findIndex(item => item.itemId === input.itemId);
        return ok({ ...input, ...(foreign ? { itemId: items[1]!.itemId } : {}), version: 3, items: index < 0 ? [] : [{
          submissionId: 55 + index, requestId: phases[index]!.requestId, mode: 'followUp', content: 'Original invoice input.' }] }); },
      queryControl: async () => ok(null),
      apply: async input => { applied++; return ok({ workId: input.workId, sessionId: input.sessionId, attemptId: input.attemptId,
        ...(input.itemId === undefined ? {} : { itemId: input.itemId }), controlRequestId: input.controlRequestId, status: 'applied', version: 4 }); },
    };
    const authority = new CloudQueueAuthority({ database: f.database, workspaceId: request.workspaceId, runtime, now: () => at,
      authorize: () => ok(undefined) });
    const first = { ...owner, itemId: items[0]!.itemId }, second = { ...owner, itemId: items[1]!.itemId };
    expect(need(await authority.read(first))).toMatchObject({ itemId: first.itemId, activePhaseRequestId: phases[0]!.requestId });
    expect(need(await authority.read(second))).toMatchObject({ itemId: second.itemId, activePhaseRequestId: phases[1]!.requestId });
    foreign = true; expect(await authority.read(first)).toMatchObject({ ok: false }); foreign = false;
    const input = { ...first, controlRequestId: 'item-cancel', expectedVersion: 3, action: { kind: 'cancel' as const, submissionId: 55 } };
    expect(need(await authority.apply(input))).toMatchObject({ itemId: first.itemId, status: 'applied' });
    expect(await authority.queryControl({ ...second, controlRequestId: input.controlRequestId })).toMatchObject({ ok: false });
    expect(need(await authority.queryControl({ ...first, controlRequestId: input.controlRequestId }))).toMatchObject({ itemId: first.itemId });
    expect(applied).toBe(1);
    let retried = 0;
    const delivery = new CloudDeliveryAuthority({ database: f.database, workspaceId: request.workspaceId, runtime: {
      status: async () => ok({ ...owner, runtimeGeneration: '11111111-1111-4111-8111-111111111111', observationRevision: 1,
        native: { conversationId: 17, tasks: [], moreTasks: false, submissions: [], moreSubmissions: false }, wake: null,
        results: { items: [{ requestId: phases[0]!.requestId, itemId: first.itemId, nativeSubmissionId: 55,
          state: 'blocked', attempts: 8, nextAt: at, nativeStatus: 'done' }], nextAfterSubmissionId: null } }),
      retry: async input => { retried++; return ok({ ...input, state: 'pending' }); },
    } });
    expect(await delivery.status({ ...owner, limit: 10 })).toMatchObject({ ok: true, data: { results: { items: [{ itemId: first.itemId }] } } });
    const retry = { ...first, requestId: phases[0]!.requestId, nativeSubmissionId: 55 };
    expect(await delivery.retry({ ...retry, itemId: second.itemId })).toMatchObject({ ok: false });
    expect(await delivery.retry(retry)).toMatchObject({ ok: true, data: { itemId: first.itemId, state: 'pending' } });
    expect(retried).toBe(1);
  } finally { await f.database.close(); }
});

test('Authority links an authorized follow-up to its original phase only after the native receipt is recovered', async () => {
  const { f, owner, request } = await cloudModelFixture();
  let receipt: import('@flowmate/contracts').CloudQueueReceipt | null = null, applied = 0, foreign = false;
  const runtime: import('@flowmate/contracts').CloudQueuePort = {
    read: async () => ({ ok: true, data: { ...owner, version: receipt ? 4 : 3, items: receipt ? [{ submissionId: foreign ? 999 : 25,
      requestId: request.requestId, mode: 'followUp', content: 'Check the original total.' }] : [] } }),
    queryControl: async () => ({ ok: true, data: receipt }),
    apply: async input => { applied++; receipt = { ...owner, controlRequestId: input.controlRequestId, status: 'applied', version: 4, submissionId: 25 };
      return fail(appError('cloud_transport_result_unknown', 'runtime', 'Controlled lost receipt.', true)); },
  };
  const authority = new CloudQueueAuthority({ database: f.database, workspaceId: request.workspaceId, runtime, now: () => at,
    authorize: () => ({ ok: true, data: undefined }) });
  const input = { ...owner, controlRequestId: 'original-followup-control', expectedVersion: 3,
    action: { kind: 'enqueue' as const, phaseRequestId: request.requestId, mode: 'followUp' as const, content: 'Check the original total.' } };
  try {
    expect(await authority.apply(input)).toMatchObject({ ok: false, error: { code: 'operation_result_unknown' } });
    expect(need(await authority.queryControl({ ...owner, controlRequestId: input.controlRequestId }))).toEqual(receipt);
    expect(need(await authority.read(owner)).items).toMatchObject([{ submissionId: 25, requestId: request.requestId }]);
    foreign = true; expect(await authority.read(owner)).toMatchObject({ ok: false });
    expect(applied).toBe(1);
  } finally { await f.database.close(); }
});

test('cloud delivery status and manual retry stay bound to the original Work phase', async () => {
  const { f, owner, request } = await cloudModelFixture(); let wrong = false, wrongConversation = false, retries = 0;
  const runtime: import('@flowmate/contracts').CloudRuntimeDeliveryPort = {
    status: async () => ok({ ...owner, runtimeGeneration: '11111111-1111-4111-8111-111111111111', observationRevision: 1,
      native: { conversationId: wrongConversation ? 18 : 17, tasks: [], moreTasks: false, submissions: [], moreSubmissions: false },
      wake: { requestId: request.requestId, revision: 1, active: false, at: null, blocked: true },
      results: { items: [{ requestId: request.requestId, nativeSubmissionId: wrong ? 99 : request.nativeSubmissionId,
        state: 'blocked', attempts: 8, nextAt: at, nativeStatus: 'done' }], nextAfterSubmissionId: null } }),
    retry: async input => { retries++; return ok({ ...input, state: 'pending' }); },
  };
  const authority = new CloudDeliveryAuthority({ database: f.database, workspaceId: request.workspaceId, runtime });
  const key = { ...owner, requestId: request.requestId, nativeSubmissionId: request.nativeSubmissionId };
  try {
    expect(await authority.status({ ...owner, limit: 10 })).toMatchObject({ ok: true, data: { wake: { blocked: true }, results: { items: [{ state: 'blocked', attempts: 8 }] } } });
    wrong = true; expect(await authority.status({ ...owner, limit: 10 })).toMatchObject({ ok: false }); wrong = false;
    wrongConversation = true; expect(await authority.status({ ...owner, limit: 10 })).toMatchObject({ ok: false }); wrongConversation = false;
    expect(await authority.retry({ ...key, requestId: 'different-phase' })).toMatchObject({ ok: false });
    expect(await authority.retry({ ...key, nativeSubmissionId: key.nativeSubmissionId + 1 })).toMatchObject({ ok: false });
    expect(await authority.retry(key)).toEqual({ ok: true, data: { ...key, state: 'pending' } }); expect(retries).toBe(1);
  } finally { await f.database.close(); }
});

test('Authority projects only confirmed queued instructions and their confirmed edits into the original phase', async () => {
  const { f, owner, request } = await cloudModelFixture(), receipts = new Map<string, import('@flowmate/contracts').CloudQueueReceipt>();
  let content = '', version = 3;
  const runtime: import('@flowmate/contracts').CloudQueuePort = {
    read: async () => ({ ok: true, data: { ...owner, version, items: content ? [{ submissionId: 25,
      requestId: request.requestId, mode: 'followUp', content }] : [] } }),
    queryControl: async input => ({ ok: true, data: receipts.get(input.controlRequestId) ?? null }),
    apply: async input => {
      if (input.action.kind === 'enqueue' || input.action.kind === 'edit') content = input.action.content;
      const receipt = { ...owner, controlRequestId: input.controlRequestId, status: 'applied' as const, version: ++version,
        ...(input.action.kind === 'enqueue' ? { submissionId: 25 } : {}) };
      receipts.set(input.controlRequestId, receipt); return { ok: true, data: receipt };
    },
  };
  const authority = new CloudQueueAuthority({ database: f.database, workspaceId: request.workspaceId, runtime, now: () => at,
    authorize: () => ({ ok: true, data: undefined }) });
  const original = { ...owner, controlRequestId: 'authorized-followup', expectedVersion: 3,
    action: { kind: 'enqueue' as const, phaseRequestId: request.requestId, mode: 'followUp' as const, content: 'Original instruction.' } };
  try {
    need(await authority.apply(original));
    need(await authority.apply({ ...owner, controlRequestId: 'authorized-edit', expectedVersion: 4,
      action: { kind: 'edit', submissionId: 25, content: 'Revised original instruction.' } }));
    const input = { ...owner, requestId: request.requestId, items: [{ controlRequestId: original.controlRequestId,
      submissionId: 25, entryId: 31, content: 'Revised original instruction.' }] };
    expect(need(await authority.verifyInputs(input))).toEqual([{ provenance: 'user-provided', controlRequestId: original.controlRequestId,
      submissionId: 25, content: 'Revised original instruction.' }]);
    expect(await authority.verifyInputs({ ...input, items: [{ ...input.items[0]!, content: 'Original instruction.' }] })).toMatchObject({ ok: false });
    expect(await authority.verifyInputs({ ...input, items: [{ ...input.items[0]!, submissionId: 99 }] })).toMatchObject({ ok: false });
  } finally { await f.database.close(); }
});

test('a placed follow-up waits for an in-flight edit receipt before entering model context', async () => {
  const { f, owner, request } = await cloudModelFixture(), started = Promise.withResolvers<void>(), release = Promise.withResolvers<void>();
  const receipts = new Map<string, import('@flowmate/contracts').CloudQueueReceipt>(); let content = '', version = 3;
  const runtime: import('@flowmate/contracts').CloudQueuePort = {
    read: async () => ({ ok: true, data: { ...owner, version, items: content ? [{ submissionId: 25,
      requestId: request.requestId, mode: 'followUp', content }] : [] } }),
    queryControl: async input => ({ ok: true, data: receipts.get(input.controlRequestId) ?? null }),
    apply: async input => {
      if (input.action.kind === 'edit') { content = input.action.content; started.resolve(); await release.promise; }
      else if (input.action.kind === 'enqueue') content = input.action.content;
      const receipt = { ...owner, controlRequestId: input.controlRequestId, status: 'applied' as const, version: ++version,
        ...(input.action.kind === 'enqueue' ? { submissionId: 25 } : {}) };
      receipts.set(input.controlRequestId, receipt); return { ok: true, data: receipt };
    },
  };
  const authority = new CloudQueueAuthority({ database: f.database, workspaceId: request.workspaceId, runtime, now: () => at,
    authorize: () => ({ ok: true, data: undefined }) });
  try {
    need(await authority.apply({ ...owner, controlRequestId: 'original-followup', expectedVersion: 3,
      action: { kind: 'enqueue', phaseRequestId: request.requestId, mode: 'followUp', content: 'Original instruction.' } }));
    const changing = authority.apply({ ...owner, controlRequestId: 'inflight-edit', expectedVersion: 4,
      action: { kind: 'edit', submissionId: 25, content: 'Edited instruction.' } });
    await started.promise; let finished = false;
    const verifying = authority.verifyInputs({ ...owner, requestId: request.requestId, items: [{ controlRequestId: 'original-followup',
      submissionId: 25, entryId: 31, content: 'Edited instruction.' }] }).then(value => { finished = true; return value; });
    await new Promise<void>(resolve => setImmediate(resolve)); expect(finished).toBe(false);
    release.resolve(); need(await changing);
    expect(need(await verifying)).toMatchObject([{ content: 'Edited instruction.' }]);
  } finally { release.resolve(); await f.database.close(); }
});

test('a queued edit is withheld from model context until its original native receipt is confirmed', async () => {
  const { f, owner, request } = await cloudModelFixture(), started = Promise.withResolvers<void>(), release = Promise.withResolvers<void>();
  let receipt: import('@flowmate/contracts').CloudQueueReceipt | null = null, sends = 0;
  const runtime: import('@flowmate/contracts').CloudQueuePort = {
    read: async () => ({ ok: true, data: { ...owner, version: 3, items: [{ submissionId: request.nativeSubmissionId,
      requestId: request.requestId, mode: 'followUp', content: 'Original controlled input' }] } }),
    queryControl: async () => ({ ok: true, data: receipt }),
    apply: async input => { sends++; started.resolve(); await release.promise; receipt = { ...owner, controlRequestId: input.controlRequestId,
      status: 'applied', version: 4 }; return { ok: true, data: receipt }; },
  };
  const authority = new CloudQueueAuthority({ database: f.database, workspaceId: request.workspaceId, runtime, now: () => at,
    authorize: () => ({ ok: true, data: undefined }) });
  const input = { ...owner, controlRequestId: 'original-queue-edit', expectedVersion: 3,
    action: { kind: 'edit' as const, submissionId: request.nativeSubmissionId, content: 'Review the original total carefully.' } };
  try {
    const pending = authority.apply(input); await started.promise;
    const duplicate = authority.apply(input);
    expect(await authority.apply({ ...input, action: { ...input.action, content: 'Different instruction.' } })).toMatchObject({ ok: false });
    let readFinished = false;
    const context = authority.currentEdit({ ...owner, requestId: request.requestId }).then(value => { readFinished = true; return value; });
    await new Promise<void>(resolve => setImmediate(resolve)); expect(readFinished).toBe(false);
    release.resolve(); expect(need(await pending)).toMatchObject({ status: 'applied' });
    expect(need(await duplicate)).toMatchObject({ status: 'applied' }); expect(sends).toBe(1);
    expect(need(await context)).toEqual({ controlRequestId: input.controlRequestId, content: input.action.content });
    expect(need(await authority.currentEdit({ ...owner, requestId: request.requestId })))
      .toEqual({ controlRequestId: input.controlRequestId, content: input.action.content });
  } finally { release.resolve(); await f.database.close(); }
});

test('queue cancellation waits for the original control receipt and rejects another submission', async () => {
  const { f, owner, request } = await cloudModelFixture(), started = Promise.withResolvers<void>(), release = Promise.withResolvers<void>();
  let receipt: import('@flowmate/contracts').CloudQueueReceipt | null = null;
  const runtime: import('@flowmate/contracts').CloudQueuePort = {
    read: async () => ({ ok: true, data: { ...owner, version: 3, items: [{ submissionId: request.nativeSubmissionId,
      requestId: request.requestId, mode: 'followUp', content: 'Original controlled input' }] } }),
    queryControl: async () => ({ ok: true, data: receipt }),
    apply: async () => { started.resolve(); await release.promise;
      return fail(appError('cloud_transport_result_unknown', 'runtime', 'Controlled lost receipt.', true)); },
  };
  const authority = new CloudQueueAuthority({ database: f.database, workspaceId: request.workspaceId, runtime, now: () => at,
    authorize: () => ({ ok: true, data: undefined }) });
  const query = { ...owner, requestId: request.requestId, nativeSubmissionId: request.nativeSubmissionId };
  const input = { ...owner, controlRequestId: 'original-cancellation', expectedVersion: 3,
    action: { kind: 'cancel' as const, submissionId: request.nativeSubmissionId } };
  try {
    expect(need(await authority.wasCancelled(query))).toBe(false);
    expect(await authority.wasCancelled({ ...query, nativeSubmissionId: query.nativeSubmissionId + 1 })).toMatchObject({ ok: false });
    const pending = authority.apply(input); await started.promise;
    let checked = false;
    const checking = authority.wasCancelled(query).then(value => { checked = true; return value; });
    await new Promise<void>(resolve => setImmediate(resolve)); expect(checked).toBe(false);
    release.resolve(); expect(await pending).toMatchObject({ ok: false });
    expect(await checking).toMatchObject({ ok: false, error: { code: 'operation_result_unknown' } });
    receipt = { ...owner, controlRequestId: input.controlRequestId, status: 'applied', version: 4 };
    expect(need(await authority.wasCancelled(query))).toBe(true);
  } finally { release.resolve(); await f.database.close(); }
});

test('the cloud model context includes only the confirmed queue edit while preserving the frozen invoice scope', async () => {
  const { f, owner, request, cloud } = await cloudModelFixture();
  const phase = need(await f.database.read(scope => scope.invoiceWorks.getPhase({ workId: owner.workId, attemptId: owner.attemptId, requestId: request.requestId })));
  if (!phase || phase.itemId === null) throw Error('The original phase is unavailable.');
  const contexts = new InvoiceWorkPhaseContextService({ database: f.database, now: () => at, buildContext: buildInvoiceWorkContext });
  const frozen = need(await contexts.freeze({ workId: owner.workId, attemptId: owner.attemptId, itemId: phase.itemId,
    requestId: request.requestId, kind: 'prompt', basis: phase.basis, remainingBudget: need(await cloud.remainingBudget(owner.workId)) }));
  let receipt: import('@flowmate/contracts').CloudQueueReceipt | null = null;
  const queuePort: import('@flowmate/contracts').CloudQueuePort = {
    read: async () => ({ ok: true, data: { ...owner, version: 3, items: [{ submissionId: request.nativeSubmissionId,
      requestId: request.requestId, mode: 'followUp', content: 'Original controlled input' }] } }),
    queryControl: async () => ({ ok: true, data: receipt }),
    apply: async input => { receipt = { ...owner, controlRequestId: input.controlRequestId, status: 'applied', version: 4 };
      return { ok: true, data: receipt }; },
  };
  const queue = new CloudQueueAuthority({ database: f.database, workspaceId: request.workspaceId, runtime: queuePort,
    now: () => at, authorize: () => ({ ok: true, data: undefined }) });
  const port = { close: async () => ({ ok: true as const, data: undefined }) } as import('@flowmate/contracts').DurableRuntimePort;
  const personal = need(await createPersonalAgentRuntime({ database: f.database, definitions: [], resourceRoot: f.paths.root,
    bundleRoot: f.paths.runtimeDir, resolveConfiguration: () => fail(appError('unused', 'input', 'Unused.')), readApiKey: () => undefined,
    foregroundBusy: () => false, now: () => at, cloud: { workspaceId: request.workspaceId, runtime: port } }));
  try {
    if (!personal.cloudAuthority) throw Error('The cloud callbacks are unavailable.');
    personal.cloudAuthority.attachQueue(queue);
    need(await queue.apply({ ...owner, controlRequestId: 'approved-edit', expectedVersion: 3,
      action: { kind: 'edit', submissionId: request.nativeSubmissionId, content: 'Review the original total carefully.' } }));
    const context = need(await personal.cloudAuthority.callbacks.readWorkingContext({ ...owner, requestId: request.requestId }));
    expect(context.queueInstruction).toEqual({ provenance: 'user-provided', controlRequestId: 'approved-edit', content: 'Review the original total carefully.' });
    expect(context.actions).toEqual(frozen.context.actions); expect(context.phase).toEqual(frozen.context.phase);
    expect(JSON.parse(need(formatInvoiceWorkContext(context))).queueInstruction).toEqual(context.queueInstruction);
    expect(await f.database.transaction(scope => scope.invoiceWorkContexts.save({ context, at }))).toMatchObject({ ok: false });
  } finally { need(await personal.close()); await f.database.close(); }
});

test.each([true, false])('only an Authority-confirmed queue cancellation leaves the invoice waiting: %s', async confirmed => {
  const { f, owner, work, request, cloud } = await cloudModelFixture();
  const query = { ...owner, requestId: request.requestId };
  let receipt: import('@flowmate/contracts').CloudQueueReceipt | null = null;
  const queue = new CloudQueueAuthority({ database: f.database, workspaceId: request.workspaceId, now: () => at,
    authorize: () => ({ ok: true, data: undefined }), runtime: {
      read: async () => ({ ok: true, data: { ...owner, version: 3, items: [{ submissionId: request.nativeSubmissionId,
        requestId: request.requestId, mode: 'followUp', content: 'Original controlled input' }] } }),
      queryControl: async () => ({ ok: true, data: receipt }),
      apply: async input => { receipt = { ...owner, controlRequestId: input.controlRequestId, status: 'applied', version: 4 };
        return { ok: true, data: receipt }; },
    } });
  if (confirmed) need(await queue.apply({ ...owner, controlRequestId: 'confirmed-cancellation', expectedVersion: 3,
    action: { kind: 'cancel', submissionId: request.nativeSubmissionId } }));
  const observation = { ...query, nativeConversationId: request.nativeConversationId, nativeSubmissionId: request.nativeSubmissionId,
    nativeEntryId: null, status: 'unanswered' as const, consumedAt: null, execution: 'closed' as const };
  need(await f.database.transaction(scope => scope.invoiceWorks.recordPhaseObservation({ observation, at })));
  const port = { getSubmission: async () => ({ ok: true as const, data: { ...query, nativeConversationId: request.nativeConversationId,
    nativeSubmissionId: request.nativeSubmissionId, status: 'unanswered' as const, answer: null, reason: 'cloud-queue-cancelled' } }),
    observeSubmission: async () => ({ ok: true as const, data: observation }),
    stopAttempt: async () => ({ ok: true as const, data: { ...owner, stopped: true, reason: 'stopped' as const } }) } as unknown as import('@flowmate/contracts').DurableRuntimePort;
  const observer = new InvoiceWorkPhaseObserver({ database: f.database, runtime: port, now: () => at });
  const contexts = new InvoiceWorkPhaseContextService({ database: f.database, now: () => at, buildContext: buildInvoiceWorkContext });
  const coordinator = new InvoiceWorkCoordinator({ database: f.database, runtime: port,
    modelService: {} as never, contexts, phaseObserver: observer, governor: cloud,
    tasks: { reconcileChildren: async () => ({ ok: true, data: undefined }), reconcileStop: async () => fail(appError('unused', 'input', 'Unused.')) },
    runtimeScope: 'cloud', now: () => at, sdk, verifyResources: () => ({ ok: true, data: undefined }),
    queueCancelled: input => queue.wasCancelled(input) });
  try {
    coordinator.wake(); need(await coordinator.drain());
    const view = await f.view(work.workId);
    expect(view.work.execution.runStatus).toBe(confirmed ? 'completed' : 'failed');
    const run = need(await f.database.read(scope => scope.runs.get(view.work.execution.attempt!.runId!)));
    if (!confirmed) { expect(run.error).toMatchObject({ code: 'durable_phase_unanswered' }); return; }
    expect(run.output)
      .toMatchObject({ text: 'The queued invoice input was cancelled before execution.', stopReason: 'cloud-queue-cancelled' });
    const item = need(await f.service.get({ view: 'item', workId: work.workId, itemId: view.items[0]!.itemId, limit: 10 }));
    if (item.view !== 'item') throw Error('Expected the original invoice item.');
    expect(item.todos).toMatchObject([{ actor: 'user', action: 'continue', problem: 'The queued invoice input was cancelled before execution.' }]);
  } finally { need(await coordinator.close()); await f.database.close(); }
});

test('cloud admission preserves two transactional Work slots until original stops are confirmed', async () => {
  const f = await fixture(), local = await f.create('local-independent');
  const workspaceId = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
  const runtimes = ['11111111-1111-4111-8111-111111111111', '22222222-2222-4222-8222-222222222222',
    '33333333-3333-4333-8333-333333333333'];
  const clouds = await Promise.all(runtimes.map((cloudRuntimeId, index) => f.database.transaction(store =>
    need(store.invoiceWorks.create(f.request(`cloud-${index}`), { at, admission: { kind: 'queued' },
      runtimeOwner: { workspaceId, cloudRuntimeId } })) )));
  const cloud = new DurableInvoiceGovernor(f.database, () => at, () => true, 'cloud');
  expect(await f.governor.assess(clouds[0]!.workId)).toMatchObject({ ok: true, data: { kind: 'blocked' } });
  expect(await cloud.assess(local.workId)).toMatchObject({ ok: true, data: { kind: 'blocked' } });
  expect(await cloud.assess(clouds[0]!.workId)).toEqual({ ok: true, data: { kind: 'ready' } });
  expect(await cloud.assess(clouds[1]!.workId)).toEqual({ ok: true, data: { kind: 'ready' } });
  expect(await cloud.assess(clouds[2]!.workId)).toEqual({ ok: true, data: { kind: 'queued' } });
  const first = identity(clouds[0]!), second = identity(clouds[1]!);
  const [firstRun] = await Promise.all([f.start(first, usage, undefined, cloud), f.start(second, usage, undefined, cloud)]);
  expect(await cloud.assess(clouds[2]!.workId)).toEqual({ ok: true, data: { kind: 'queued' } });
  expect(await f.finish(first, firstRun!, false)).toMatchObject({ closed: false, reason: 'root-stop-unconfirmed' });
  await f.database.close();
  const reopened = need(openTestDatabase(f.paths));
  try {
    const recovered = new DurableInvoiceGovernor(reopened, () => at, () => true, 'cloud');
    expect(await recovered.assess(clouds[2]!.workId)).toEqual({ ok: true, data: { kind: 'queued' } });
    await reopened.transaction(store => {
      store.db.query('UPDATE runs SET stopped_at=?,cleanup_json=? WHERE id=?')
        .run(at, JSON.stringify({ ...cleanup, stopped: true, stopReason: 'confirmed-native-stop' }), firstRun);
      expect(need(createInvoiceWorkAttemptRepository(store.db).finish({ workId: first.workId, attemptId: first.attemptId,
        runId: firstRun!, at, effectsReconciled: true })))
        .toMatchObject({ closed: true });
    });
    expect(await recovered.assess(clouds[2]!.workId)).toEqual({ ok: true, data: { kind: 'ready' } });
  } finally { await reopened.close(); }
});

test('a human-waiting cloud Work does not occupy one of the two queued positions', async () => {
  const f = await fixture();
  const workspaceId = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
  const runtimes = ['11111111-1111-4111-8111-111111111111', '22222222-2222-4222-8222-222222222222',
    '33333333-3333-4333-8333-333333333333'];
  const works = await Promise.all(runtimes.map((cloudRuntimeId, index) => f.database.transaction(store =>
    need(store.invoiceWorks.create(f.request(`cloud-wait-${index}`), { at, admission: { kind: 'queued' },
      runtimeOwner: { workspaceId, cloudRuntimeId } })) )));
  const cloud = new DurableInvoiceGovernor(f.database, () => at, () => false, 'cloud');
  await humanTodo(f, works[0]!.workId, 0);
  expect(await cloud.assess(works[0]!.workId)).toMatchObject({ ok: true, data: { kind: 'waiting' } });
  expect(await cloud.assess(works[1]!.workId)).toEqual({ ok: true, data: { kind: 'ready' } });
  expect(await cloud.assess(works[2]!.workId)).toEqual({ ok: true, data: { kind: 'ready' } });
});

test('cloud Work keeps its explicitly authorized 24-hour budget through Run, child and context without widening local limits', async () => {
  const f = await fixture(1, () => ({ ok: true, data: { timeoutMs: 300_000 } }));
  const workspaceId = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
  const owner = (cloudRuntimeId: string) => ({ runtimeOwner: { workspaceId, cloudRuntimeId }, at,
    admission: { kind: 'queued' as const }, runtimeDefaults: { timeoutMs: 300_000 } });
  const defaults = need(await f.database.transaction(store => store.invoiceWorks.create(f.request('cloud-default'),
    owner('11111111-1111-4111-8111-111111111111'))));
  const request = { ...f.request('cloud-24h'), cloudTimeoutMs: 86_400_000 };
  const settings = owner('22222222-2222-4222-8222-222222222222');
  const created = need(await f.database.transaction(store => store.invoiceWorks.create(request, settings)));
  const readBudget = (workId: number) => f.database.read(store => JSON.parse(store.db.query<{ budget_json: string }, [number]>(
    'SELECT budget_json FROM invoice_works WHERE id=?').get(workId)!.budget_json));
  expect((await readBudget(defaults.workId)).limits).toMatchObject({ timeoutMs: 120_000, cloud: true });
  expect((await readBudget(created.workId)).limits).toMatchObject({ timeoutMs: 86_400_000, cloud: true });
  expect(need(await f.database.transaction(store => store.invoiceWorks.create(request, settings)))).toEqual(created);
  expect(await f.database.transaction(store => store.invoiceWorks.create({ ...request, cloudTimeoutMs: 1_800_000 }, settings)))
    .toMatchObject({ ok: false, error: { code: 'state_conflict' } });
  expect(await f.database.transaction(store => store.invoiceWorks.create({ ...f.request('local-24h'), cloudTimeoutMs: 86_400_000 },
    { at, admission: { kind: 'queued' } }))).toMatchObject({ ok: false, error: { code: 'input_invalid' } });
  expect(await f.database.transaction(store => store.invoiceWorks.create({ ...f.request('cloud-too-long'), cloudTimeoutMs: 86_400_001 },
    owner('33333333-3333-4333-8333-333333333333')))).toMatchObject({ ok: false, error: { code: 'input_invalid' } });
  expect(RuntimeRequestOverridesSchema.safeParse({ timeoutMs: 1_800_001 }).success).toBe(false);
  expect(DurableWorkBudgetSchema.safeParse({ ...(await readBudget(created.workId)),
    limits: { timeoutMs: 86_400_000, stopGraceMs: 5000 } }).success).toBe(false);
  const cloud = new DurableInvoiceGovernor(f.database, () => at, () => false, 'cloud'), original = identity(created);
  const runId = await f.start(original, usage, undefined, cloud);
  const run = need(await f.database.read(store => store.runs.get(runId)));
  const config = DurableRunConfigSnapshotSchema.parse(run.config);
  expect(config.limits).toMatchObject({ timeoutMs: 86_400_000, cloud: true });
  expect(DurableSubagentConfigSnapshotSchema.safeParse({ ...config, version: 4,
    subagent: { parentRunId: runId, originToolCallId: 1, phaseId: 1, itemId: 1, parentRequestId: 'p',
      role: 'invoice-evidence-checker' } }).success).toBe(true);
  const remaining = need(await cloud.remainingBudget(created.workId));
  expect(remaining.timeoutMs).toBe(86_400_000);
  expect(InvoiceWorkContextBuildInputSchema.unwrap().shape.remainingBudget.safeParse(remaining).success).toBe(true);
});

async function cloudModelFixture(members = 1) {
  const f = await fixture(members), workspaceId = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
  const cloudRuntimeId = '11111111-1111-4111-8111-111111111111';
  const work = need(await f.database.transaction(store => store.invoiceWorks.create(f.request('cloud-model-reservation'),
    { at, admission: { kind: 'queued' }, runtimeOwner: { workspaceId, cloudRuntimeId } })));
  const owner = identity(work), cloud = new DurableInvoiceGovernor(f.database, () => at, () => false, 'cloud');
  const runId = await f.start(owner, usage, undefined, cloud), item = (await f.view(work.workId)).items[0]!;
  const phase = need(await f.database.transaction(store => store.invoiceWorks.freezePhase({ workId: work.workId, attemptId: owner.attemptId,
    itemId: item.itemId, requestId: 'cloud-model-phase', kind: 'prompt', at,
    basis: { contextSnapshotId: null, inputIds: [], documentRefs: [item.documentRef], configurationRevision: 0, itemRevision: item.revision } })));
  need(await f.database.transaction(store => store.invoiceWorks.linkPhase({ workId: work.workId, attemptId: owner.attemptId,
    phaseId: phase.phaseId, nativeConversationId: 17, nativeSubmissionId: 19, at })));
  const request = { workspaceId, cloudRuntimeId, ...owner, phaseId: phase.phaseId, requestId: phase.requestId,
    nativeConversationId: 17, nativeSubmissionId: 19, nativeTaskId: 23, checkpointEntryId: 29, transportOrdinal: 0,
    modelAttemptId: '99999999-9999-4999-8999-999999999999', model: 'explicit-model', body: '{"model":"explicit-model","messages":[]}' };
  return { f, cloud, owner, work, runId, request, ledger: new CloudModelAttempts(f.database, cloud, () => at) };
}

test('cloud model attempt reserves once and an uncertain send cannot be replayed or reassigned after restart', async () => {
  const { f, runId, request, ledger } = await cloudModelFixture();
  const reservations = await Promise.all(Array.from({ length: 5 }, () => ledger.reserve(request)));
  expect(reservations).toEqual(Array.from({ length: 5 }, () => ({ ok: true, data: { state: 'reserved' } })));
  expect(await f.reservations(runId)).toBe(1);
  expect(await ledger.reserve({ ...request, body: '{"model":"changed","messages":[]}' })).toMatchObject({ ok: false });
  expect(await ledger.reserve({ ...request, modelAttemptId: '88888888-8888-4888-8888-888888888888' })).toMatchObject({ ok: false });
  expect(await ledger.begin(request)).toEqual({ ok: true, data: undefined });
  expect(await ledger.begin(request)).toMatchObject({ ok: false, error: { code: 'cloud_model_result_unknown' } });
  await f.database.close();
  const reopened = need(openTestDatabase(f.paths));
  try {
    const recovered = new CloudModelAttempts(reopened, new DurableInvoiceGovernor(reopened, () => at, () => false, 'cloud'), () => at);
    need(await recovered.recoverSending());
    expect(await recovered.reserve(request)).toEqual({ ok: true, data: { state: 'uncertain' } });
    expect(await recovered.begin(request)).toMatchObject({ ok: false, error: { code: 'cloud_model_result_unknown' } });
    expect(await reopened.read(store => store.db.query('SELECT count FROM invoice_work_model_reservations WHERE run_id=?').get(runId)))
      .toEqual({ count: 1 });
  } finally { await reopened.close(); }
});

test('cloud model reservation belongs to the original invoice phase rather than the root conversation', async () => {
  const { f, work, owner, request, ledger } = await cloudModelFixture();
  try {
    const item = (await f.view(work.workId)).items[0]!;
    await f.database.transaction(store => store.db.query('UPDATE invoice_work_phases SET closed_at=? WHERE id=?').run(at, request.phaseId));
    const phase = need(await f.database.transaction(store => store.invoiceWorks.freezePhase({ workId: work.workId, attemptId: owner.attemptId,
      itemId: item.itemId, requestId: 'invoice-model', kind: 'prompt', at, basis: { contextSnapshotId: null, inputIds: [],
        documentRefs: [item.documentRef], configurationRevision: 0, itemRevision: item.revision, executionMode: 'item-lane-approval-v1' } })));
    need(await f.database.transaction(store => store.invoiceWorks.linkPhase({ workId: work.workId, attemptId: owner.attemptId,
      phaseId: phase.phaseId, nativeConversationId: 45, nativeSubmissionId: 46, at })));
    const original = { ...request, itemId: item.itemId, phaseId: phase.phaseId, requestId: phase.requestId,
      nativeConversationId: 45, nativeSubmissionId: 46 };
    expect(await ledger.reserve({ ...original, itemId: item.itemId + 999 })).toMatchObject({ ok: false });
    expect(await ledger.reserve({ ...original, nativeConversationId: 17 })).toMatchObject({ ok: false });
    expect(await ledger.reserve(original)).toEqual({ ok: true, data: { state: 'reserved' } });
    expect(await ledger.reserve(original)).toEqual({ ok: true, data: { state: 'reserved' } });
    expect(await ledger.begin(original)).toEqual({ ok: true, data: undefined });
  } finally { await f.database.close(); }
});

test('cloud model retry needs a confirmed retryable response and reserves a new request only once', async () => {
  const { f, runId, request, ledger } = await cloudModelFixture();
  const retry = { ...request, modelAttemptId: '88888888-8888-4888-8888-888888888888', transportOrdinal: 1 };
  expect(await ledger.reserve(retry)).toMatchObject({ ok: false, error: { code: 'state_conflict' } });
  need(await ledger.reserve(request)); need(await ledger.begin(request));
  expect(await ledger.reserve(retry)).toMatchObject({ ok: false, error: { code: 'state_conflict' } });
  need(await ledger.settle(request, { kind: 'confirmed', httpStatus: 503 }));
  const retried = await Promise.all([ledger.reserve(retry), ledger.reserve(retry)]);
  expect(retried).toEqual([{ ok: true, data: { state: 'reserved' } }, { ok: true, data: { state: 'reserved' } }]);
  expect(await f.reservations(runId)).toBe(2);
  expect(await ledger.reserve({ ...retry, body: '{"model":"explicit-model","messages":["changed"]}' }))
    .toMatchObject({ ok: false, error: { code: 'state_conflict' } });
  need(await ledger.begin(retry)); need(await ledger.settle(retry, { kind: 'confirmed', httpStatus: 200 }));
  expect(await ledger.reserve({ ...retry, modelAttemptId: '77777777-7777-4777-8777-777777777777', transportOrdinal: 2 }))
    .toMatchObject({ ok: false, error: { code: 'state_conflict' } });
  expect(await f.reservations(runId)).toBe(2);
});

test('cloud model request cannot begin after its original Work is cancelled', async () => {
  const { f, work, runId, request, ledger } = await cloudModelFixture();
  need(await ledger.reserve(request));
  const page = await f.view(work.workId);
  need(await f.service.cancelWork({ workId: work.workId, requestId: 'cancel-before-cloud-send', expectedRevision: page.work.revision }));
  expect(await ledger.begin(request)).toMatchObject({ ok: false });
  expect(await f.reservations(runId)).toBe(1);
  expect(await ledger.reserve(request)).toEqual({ ok: true, data: { state: 'reserved' } });
});

test('Authority grants only the original cloud Work and stops scheduling it after cancellation', async () => {
  const { f, work, owner, request } = await cloudModelFixture();
  const authorize = createCloudRuntimeAuthorizer(f.database);
  const query = { ...owner, requestId: request.requestId };
  expect(await authorize('submit', query)).toMatchObject({ ok: true, data: { state: 'ready', nativeConversationId: 17,
    binding: { workspaceId: request.workspaceId, cloudRuntimeId: request.cloudRuntimeId, workId: work.workId, sessionId: work.sessionId } } });
  expect(await authorize('submit', { ...query, sessionId: owner.sessionId + 1 })).toMatchObject({ ok: false });
  expect(await authorize('submit', { ...query, requestId: 'another-phase' })).toMatchObject({ ok: false });
  const page = await f.view(work.workId);
  need(await f.service.cancelWork({ workId: work.workId, requestId: 'cancel-cloud-authority', expectedRevision: page.work.revision }));
  expect(await authorize('submit', query)).toMatchObject({ ok: false });
  expect(await authorize('getSubmission', query)).toMatchObject({ ok: true, data: { state: 'ready' } });
  expect(await authorize('queryHistory', { workId: work.workId, sessionId: work.sessionId })).toMatchObject({ ok: true });
});

test('Authority checks invoice and phase ownership for item-scoped cloud operations', async () => {
  const { f, work, owner, request } = await cloudModelFixture();
  try {
    const authorize = createCloudRuntimeAuthorizer(f.database), itemId = (await f.view(work.workId)).items[0]!.itemId;
    const root = { workId: work.workId, sessionId: work.sessionId }, phase = { ...owner, requestId: request.requestId };
    expect(await authorize('queryHistoryPage', { ...root, itemId })).toMatchObject({ ok: true });
    expect(await authorize('queryHistoryPage', { ...root, itemId: 999999 })).toMatchObject({ ok: false });
    expect(await authorize('submit', { ...phase, itemId })).toMatchObject({ ok: false });
    await f.database.transaction(store => store.db.query("UPDATE invoice_work_phases SET scheduler_state='active' WHERE id=?").run(request.phaseId));
    expect(await authorize('submit', phase)).toMatchObject({ ok: false });
    expect(await authorize('submit', { ...phase, itemId })).toMatchObject({ ok: true });
    expect(await authorize('submit', { ...phase, itemId: 999999 })).toMatchObject({ ok: false });
    expect(await authorize('submit', { ...phase, itemId, participant: 'reviewer' })).toMatchObject({ ok: false });
    expect(await authorize('openConversation', { ...root, itemId, participant: 'reviewer' })).toMatchObject({ ok: false });
    expect(await authorize('queryHistoryPage', { ...root, itemId, participant: 'reviewer' })).toMatchObject({ ok: false });
  } finally { await f.database.close(); }
});

test('Authority accepts and deduplicates only the original invoice native result', async () => {
  const { f, work, owner, request } = await cloudModelFixture();
  try {
    const item = (await f.view(work.workId)).items[0]!;
    await f.database.transaction(store => store.db.query('UPDATE invoice_work_phases SET closed_at=? WHERE id=?').run(at, request.phaseId));
    const phase = need(await f.database.transaction(store => store.invoiceWorks.freezePhase({ workId: work.workId, attemptId: owner.attemptId,
      itemId: item.itemId, requestId: 'invoice-result', kind: 'prompt', at, basis: { contextSnapshotId: null, inputIds: [],
        documentRefs: [item.documentRef], configurationRevision: 0, itemRevision: item.revision, executionMode: 'item-lane-approval-v1' } })));
    need(await f.database.transaction(store => store.invoiceWorks.linkPhase({ workId: work.workId, attemptId: owner.attemptId,
      phaseId: phase.phaseId, nativeConversationId: 45, nativeSubmissionId: 46, at })));
    const query = { ...owner, itemId: item.itemId, requestId: phase.requestId };
    const event = { version: 1 as const, workspaceId: request.workspaceId, cloudRuntimeId: request.cloudRuntimeId, ...query,
      nativeConversationId: 45, nativeSubmissionId: 46, nativeInputEntryId: null, nativeAnswerEntryId: null, consumedAt: null,
      status: 'unanswered' as const, answer: null, reason: 'aborted' };
    const received: unknown[] = [];
    const native = { getSubmission: async (value: unknown) => { received.push(value); return ok({ ...query,
      nativeConversationId: 45, nativeSubmissionId: 46, status: 'unanswered' as const, answer: null, reason: 'aborted' }); },
      observeSubmission: async (value: unknown) => { received.push(value); return ok({ ...query, nativeConversationId: 45,
        nativeSubmissionId: 46, nativeEntryId: null, status: 'unanswered' as const, consumedAt: null, execution: 'closed' as const }); },
      queryHistoryEntry: async () => fail(appError('unused', 'runtime', 'Unused.')) };
    const receiver = new CloudNativeResultReceiver(f.database, native, () => at);
    expect(await receiver.receive({ ...event, itemId: item.itemId + 999 })).toMatchObject({ ok: false });
    const receipt = need(await receiver.receive(event));
    expect(receipt).toMatchObject({ itemId: item.itemId, nativeConversationId: 45, nativeSubmissionId: 46 });
    expect(need(await receiver.receive(event))).toEqual(receipt);
    expect(received).toHaveLength(2); expect(received[0]).toMatchObject({ itemId: item.itemId });
    expect(await receiver.receive({ ...event, nativeConversationId: 47 })).toMatchObject({ ok: false });
  } finally { await f.database.close(); }
});

test.skipIf(process.platform !== 'linux')('Runtime obtains and rechecks the original Authority grant over a Unix socket', async () => {
  const { f, work, owner, request } = await cloudModelFixture();
  const root = mkdtempSync(join(tmpdir(), 'flowmate-authority-socket-')), socketPath = join(root, 'authority.sock');
  const server = need(await listenCloudUnixRpc({ socketPath, handle: createCloudAuthorityRpcHandler(createCloudRuntimeAuthorizer(f.database)) }));
  const authorize = createCloudAuthorityRpcClient(socketPath), query = { ...owner, requestId: request.requestId };
  try {
    expect(await authorize('submit', query)).toMatchObject({ ok: true, data: { state: 'ready', nativeConversationId: 17 } });
    const page = await f.view(work.workId);
    need(await f.service.cancelWork({ workId: work.workId, requestId: 'cancel-cloud-socket-authority', expectedRevision: page.work.revision }));
    expect(await authorize('submit', query)).toMatchObject({ ok: false, error: { code: 'cloud_runtime_forbidden' } });
    expect(await authorize('getSubmission', query)).toMatchObject({ ok: true, data: { state: 'ready' } });
  } finally { need(await server.close()); }
});

test.skipIf(process.platform !== 'linux')('Runtime change notifications wake only their original Authority Work', async () => {
  const { f, request } = await cloudModelFixture(), root = mkdtempSync(join(tmpdir(), 'flowmate-authority-wake-'));
  const socketPath = join(root, 'authority.sock'), seen: number[] = [];
  const binding = { workspaceId: request.workspaceId, cloudRuntimeId: request.cloudRuntimeId, workId: request.workId, sessionId: request.sessionId };
  const server = need(await listenCloudUnixRpc({ socketPath, handle: createCloudAuthorityRpcHandler(createCloudRuntimeAuthorizer(f.database), undefined,
    async value => { seen.push(value.workId); return { ok: true, data: undefined }; }) }));
  const client = createCloudAuthorityCallbacksClient(socketPath);
  try {
    const notice = { ...binding, runtimeGeneration: '33333333-3333-4333-8333-333333333333', observationRevision: 1 };
    expect(await client.notifyRuntimeChanged(notice)).toEqual({ ok: true, data: undefined });
    expect(await client.notifyRuntimeChanged({ ...notice, cloudRuntimeId: '22222222-2222-4222-8222-222222222222' })).toMatchObject({ ok: false });
    expect(seen).toEqual([binding.workId]);
  } finally { need(await server.close()); }
});

test('cloud progress subscriptions authorize the original workspace and Session', async () => {
  const { f, request } = await cloudModelFixture(), hub = new CloudProgressHub(1000);
  const owner = { workId: request.workId, sessionId: request.sessionId };
  const read = createCloudProgressReader(f.database, request.workspaceId, hub);
  try {
    expect(await read({ ...owner, cursor: null })).toMatchObject({ ok: true, data: { ...owner, resync: true } });
    expect(await read({ ...owner, sessionId: owner.sessionId + 1, cursor: null })).toMatchObject({ ok: false });
    const foreign = createCloudProgressReader(f.database, 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb', hub);
    expect(await foreign({ ...owner, cursor: null })).toMatchObject({ ok: false });
  } finally { hub.close(); }
});

test('a failed cloud model attempt insert rolls back its quota reservation in the same transaction', async () => {
  const { f, runId, request, ledger } = await cloudModelFixture();
  await f.database.transaction(store => store.db.exec("CREATE TRIGGER reject_cloud_model_insert BEFORE INSERT ON cloud_model_attempts BEGIN SELECT RAISE(ABORT,'controlled failure'); END"));
  expect(await ledger.reserve(request)).toMatchObject({ ok: false, error: { code: 'cloud_model_storage_unavailable' } });
  expect(await f.reservations(runId)).toBe(0);
  expect(await f.database.read(store => store.db.query('SELECT COUNT(*) count FROM cloud_model_attempts').get())).toEqual({ count: 0 });
});

test('cloud DeepSeek proxy keeps its credential in Authority and never resends an uncertain transport', async () => {
  const { f, runId, request, ledger } = await cloudModelFixture();
  const calls: Array<{ url: string; headers: Headers; body: string | null }> = [];
  let failTransport = false;
  const proxy = new CloudDeepSeekProxy({ ledger, readApiKey: () => 'synthetic-authority-key', fetch: async (url, init) => {
    calls.push({ url, headers: new Headers(init.headers), body: typeof init.body === 'string' ? init.body : null });
    if (failTransport) throw Error('Controlled lost transport result.');
    return new Response('data: {"choices":[]}\n\ndata: [DONE]\n\n', { status: 200, headers: { 'content-type': 'text/event-stream' } });
  } });
  const response = need(await proxy.send(request));
  expect(await response.text()).toContain('[DONE]');
  expect(calls).toHaveLength(1);
  expect(calls[0]!.url).toBe('https://api.deepseek.com/chat/completions');
  expect(calls[0]!.headers.get('authorization')).toBe('Bearer synthetic-authority-key');
  expect(calls[0]!.body).toBe(request.body);
  expect(await ledger.reserve(request)).toEqual({ ok: true, data: { state: 'confirmed' } });
  expect(await proxy.send(request)).toMatchObject({ ok: false, error: { code: 'cloud_model_result_unknown' } });
  const uncertain = { ...request, modelAttemptId: '88888888-8888-4888-8888-888888888888', nativeTaskId: 24 };
  failTransport = true;
  expect(await proxy.send(uncertain)).toMatchObject({ ok: false, error: { code: 'cloud_model_result_unknown' } });
  expect(await ledger.reserve(uncertain)).toEqual({ ok: true, data: { state: 'uncertain' } });
  expect(await proxy.send(uncertain)).toMatchObject({ ok: false, error: { code: 'cloud_model_result_unknown' } });
  expect(calls).toHaveLength(2); expect(await f.reservations(runId)).toBe(2);
});

test('cloud model proxy sends the original authorized bytes even if its caller mutates the request while awaiting a credential', async () => {
  const { request, ledger } = await cloudModelFixture();
  const original = request.body, entered = Promise.withResolvers<void>(), release = Promise.withResolvers<void>();
  let sent: BodyInit | null | undefined;
  const proxy = new CloudDeepSeekProxy({ ledger, async readApiKey() { entered.resolve(); await release.promise; return 'synthetic-authority-key'; },
    fetch: async (_url, init) => { sent = init.body; return new Response('ok', { status: 200 }); } });
  const pending = proxy.send(request); await entered.promise;
  request.body = '{"model":"explicit-model","messages":["changed"]}'; release.resolve();
  const response = need(await pending); await response.text();
  expect(sent).toBe(original);
});

test.each([401, 402, 429, 503])('confirmed DeepSeek HTTP %s only permits a new attempt for retryable failures', async status => {
  const { f, runId, request, ledger } = await cloudModelFixture(); let calls = 0;
  const proxy = new CloudDeepSeekProxy({ ledger, readApiKey: () => 'synthetic-authority-key', fetch: async () => {
    calls++; return new Response('{"error":"controlled"}', { status, headers: { 'content-type': 'application/json' } });
  } });
  const response = need(await proxy.send(request)); expect(response.status).toBe(status); await response.text();
  expect(await ledger.reserve(request)).toEqual({ ok: true, data: { state: 'confirmed' } });
  const recovered = await proxy.send(request);
  expect(need(recovered).status).toBe(status);
  const next = { ...request, modelAttemptId: '88888888-8888-4888-8888-888888888888', transportOrdinal: 1 };
  const retry = await ledger.reserve(next);
  if (status === 429 || status === 503) expect(retry).toMatchObject({ ok: true, data: { state: 'reserved' } });
  else expect(retry).toMatchObject({ ok: false });
  expect(calls).toBe(1); expect(await f.reservations(runId)).toBe(status === 429 || status === 503 ? 2 : 1);
});

test('a cancelled Work cannot reserve a new model attempt after a confirmed 503', async () => {
  const { f, work, request, ledger } = await cloudModelFixture();
  const proxy = new CloudDeepSeekProxy({ ledger, readApiKey: () => 'synthetic-authority-key',
    fetch: async () => new Response('controlled', { status: 503, headers: { 'content-type': 'application/json' } }) });
  await need(await proxy.send(request)).text();
  const page = await f.view(work.workId);
  need(await f.service.cancelWork({ workId: work.workId, requestId: 'cancel-before-cloud-retry', expectedRevision: page.work.revision }));
  expect(await ledger.reserve({ ...request, modelAttemptId: '88888888-8888-4888-8888-888888888888', transportOrdinal: 1 }))
    .toMatchObject({ ok: false });
});

test('a broken cloud model response stream remains uncertain and is never sent again', async () => {
  const { f, runId, request, ledger } = await cloudModelFixture();
  let calls = 0;
  const proxy = new CloudDeepSeekProxy({ ledger, readApiKey: () => 'synthetic-authority-key', fetch: async () => {
    calls++;
    return new Response(new ReadableStream({ start(controller) { controller.error(Error('Controlled lost response.')); } }),
      { status: 200, headers: { 'content-type': 'text/event-stream' } });
  } });
  const response = need(await proxy.send(request));
  await expect(response.text()).rejects.toThrow();
  expect(await ledger.reserve(request)).toEqual({ ok: true, data: { state: 'uncertain' } });
  expect(await proxy.send(request)).toMatchObject({ ok: false, error: { code: 'cloud_model_result_unknown' } });
  expect(calls).toBe(1); expect(await f.reservations(runId)).toBe(1);
});

test('the authorized DeepSeek stream exposes bounded original text fragments across split UTF-8 events', async () => {
  const { request, ledger } = await cloudModelFixture(), fragments: Array<{ workId: number; attemptId: number; text: string }> = [];
  const content = '票据🙂', event = JSON.stringify({ choices: [{ index: 0, delta: { content } }] });
  const raw = Buffer.from(`data: ${event}\r\n\r\ndata: [DONE]\r\n\r\n`), split = raw.indexOf(Buffer.from('票')) + 1;
  const proxy = new CloudDeepSeekProxy({ ledger, readApiKey: () => 'synthetic-authority-key',
    onText: (owner, text) => { fragments.push({ workId: owner.workId, attemptId: owner.attemptId, text }); },
    fetch: async () => new Response(new ReadableStream<Uint8Array>({ start(controller) {
      controller.enqueue(raw.subarray(0, split)); controller.enqueue(raw.subarray(split)); controller.close();
    } }), { status: 200, headers: { 'content-type': 'text/event-stream' } }) });
  expect(await need(await proxy.send(request)).text()).toBe(raw.toString());
  expect(fragments).toEqual([{ workId: request.workId, attemptId: request.attemptId, text: content }]);
  expect(await ledger.reserve(request)).toEqual({ ok: true, data: { state: 'confirmed' } });
});

test('failure of an unpersisted live preview does not change the original model stream outcome', async () => {
  const { request, ledger } = await cloudModelFixture(); let gaps = 0;
  const raw = `data: ${JSON.stringify({ choices: [{ index: 0, delta: { content: 'preview' } }] })}\n\ndata: [DONE]\n\n`;
  const proxy = new CloudDeepSeekProxy({ ledger, readApiKey: () => 'synthetic-authority-key', onText: () => { throw Error('Preview unavailable.'); },
    onTextGap: () => { gaps++; }, fetch: async () => new Response(raw, { status: 200, headers: { 'content-type': 'text/event-stream' } }) });
  expect(await need(await proxy.send(request)).text()).toBe(raw); expect(gaps).toBe(1);
  expect(await ledger.reserve(request)).toEqual({ ok: true, data: { state: 'confirmed' } });
});

test('an oversized live SSE event invalidates only its temporary preview', async () => {
  const { request, ledger } = await cloudModelFixture(); let gaps = 0, fragments = 0;
  const raw = `data: ${JSON.stringify({ choices: [{ index: 0, delta: { content: 'x'.repeat(70_000) } }] })}\n\ndata: [DONE]\n\n`;
  const proxy = new CloudDeepSeekProxy({ ledger, readApiKey: () => 'synthetic-authority-key', onText: () => { fragments++; },
    onTextGap: () => { gaps++; }, fetch: async () => new Response(raw, { status: 200, headers: { 'content-type': 'text/event-stream' } }) });
  expect(await need(await proxy.send(request)).text()).toBe(raw); expect(gaps).toBe(1); expect(fragments).toBe(0);
  expect(await ledger.reserve(request)).toEqual({ ok: true, data: { state: 'confirmed' } });
});

test('a complete DeepSeek SSE remains confirmed when the consumer closes after its split terminal event', async () => {
  const { request, ledger } = await cloudModelFixture(); let sent = 0;
  const parts = ['data: {"text":"[DONE]"}\r\n\r\nda', 'ta: [DO', 'NE]\r\n\r\n'];
  let upstream!: ReadableStreamDefaultController<Uint8Array>;
  const proxy = new CloudDeepSeekProxy({ ledger, readApiKey: () => 'synthetic-authority-key', fetch: async () => {
    sent++; return new Response(new ReadableStream<Uint8Array>({ start(controller) {
      upstream = controller; for (const part of parts.slice(0, 2)) controller.enqueue(new TextEncoder().encode(part));
    } }), { status: 200, headers: { 'content-type': 'text/event-stream' } });
  } });
  const response = need(await proxy.send(request)), reader = response.body!.getReader();
  await reader.read(); await reader.read();
  expect(await ledger.reserve(request)).toEqual({ ok: true, data: { state: 'sending' } });
  upstream.enqueue(new TextEncoder().encode(parts[2]!));
  await reader.read(); await reader.cancel();
  expect(await ledger.reserve(request)).toEqual({ ok: true, data: { state: 'confirmed' } });
  expect(await proxy.send(request)).toMatchObject({ ok: false, error: { code: 'cloud_model_result_unknown' } });
  expect(sent).toBe(1);
});

test.each(['data: [DONE]\ndata: another line\n\n', 'data\ndata: [DONE]\n\n'])('an incomplete multi-line SSE event remains uncertain', async body => {
  const { request, ledger } = await cloudModelFixture();
  const proxy = new CloudDeepSeekProxy({ ledger, readApiKey: () => 'synthetic-authority-key', fetch: async () =>
    new Response(body, { status: 200, headers: { 'content-type': 'text/event-stream' } }) });
  const response = need(await proxy.send(request));
  await expect(response.text()).rejects.toThrow();
  expect(await ledger.reserve(request)).toEqual({ ok: true, data: { state: 'uncertain' } });
});

test.skipIf(process.platform !== 'linux')('the real Unix model socket streams one Authority response and preserves an unknown retry', async () => {
  const { f, runId, request, ledger } = await cloudModelFixture(), root = mkdtempSync(join(tmpdir(), 'flowmate-model-socket-'));
  const socketPath = join(root, 'model.sock'); let calls = 0;
  const proxy = new CloudDeepSeekProxy({ ledger, readApiKey: () => 'synthetic-authority-key', fetch: async (_url, init) => {
    calls++; expect(new Headers(init.headers).get('authorization')).toBe('Bearer synthetic-authority-key');
    return new Response(new ReadableStream({ start(controller) {
      controller.enqueue(new TextEncoder().encode('data: first\n\n'));
      controller.enqueue(new TextEncoder().encode('data: [DONE]\n\n')); controller.close();
    } }), { status: 200, headers: { 'content-type': 'text/event-stream' } });
  } });
  const server = need(await listenCloudModelSocket({ socketPath, proxy }));
  try {
    const response = need(await callCloudModelSocket(socketPath, request));
    expect(await response.text()).toBe('data: first\n\ndata: [DONE]\n\n');
    expect(response.headers.get('authorization')).toBeNull();
    expect(await callCloudModelSocket(socketPath, request)).toMatchObject({ ok: false, error: { code: 'cloud_model_result_unknown' } });
    expect(calls).toBe(1); expect(await f.reservations(runId)).toBe(1);
  } finally { need(await server.close()); }
});

test.skipIf(process.platform !== 'linux')('Authority reconciles the native submission before reserving or sending a model request', async () => {
  const { f, runId, request, ledger } = await cloudModelFixture(), root = mkdtempSync(join(tmpdir(), 'flowmate-model-prepare-'));
  const socketPath = join(root, 'model.sock'); let calls = 0, checks = 0;
  const proxy = new CloudDeepSeekProxy({ ledger, readApiKey: () => 'synthetic-authority-key', fetch: async () => { calls++; return new Response('ok'); } });
  const server = need(await listenCloudModelSocket({ socketPath, proxy, prepare: async () => { checks++;
    return fail(appError('source_invalid', 'runtime', 'Controlled missing submission.')); } }));
  try {
    const result = await callCloudModelSocket(socketPath, request);
    expect(checks).toBe(1); expect(result).toMatchObject({ ok: false, error: { code: 'source_invalid' } });
    expect(calls).toBe(0); expect(await f.reservations(runId)).toBe(0);
  } finally { need(await server.close()); }
});

test.skipIf(process.platform !== 'linux')('closing the Unix model socket stops an in-flight stream and keeps its outcome uncertain', async () => {
  const { request, ledger } = await cloudModelFixture(), root = mkdtempSync(join(tmpdir(), 'flowmate-model-socket-stop-'));
  const socketPath = join(root, 'model.sock'); let upstream: ReadableStreamDefaultController<Uint8Array> | undefined;
  const proxy = new CloudDeepSeekProxy({ ledger, readApiKey: () => 'synthetic-authority-key', fetch: async () =>
    new Response(new ReadableStream<Uint8Array>({ start(controller) { upstream = controller; controller.enqueue(new TextEncoder().encode('first')); } }),
      { status: 200, headers: { 'content-type': 'text/event-stream' } }) });
  const server = need(await listenCloudModelSocket({ socketPath, proxy }));
  const response = need(await callCloudModelSocket(socketPath, request)), reader = response.body!.getReader();
  expect(new TextDecoder().decode((await reader.read()).value)).toBe('first');
  const closing = server.close(); let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const ended = await Promise.race([closing.then(() => true), new Promise<boolean>(resolve => { timer = setTimeout(() => resolve(false), 3000); })]);
    expect(ended).toBe(true);
    expect(await ledger.reserve(request)).toEqual({ ok: true, data: { state: 'uncertain' } });
  } finally { if (timer) clearTimeout(timer); try { upstream?.close(); } catch {} await reader.cancel().catch(() => {}); await closing; }
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
