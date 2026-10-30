import { expect, it } from 'bun:test';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { Database } from 'bun:sqlite';
import { z } from 'zod';
import { defaultProductSettings } from '@flowmate/core';
import { prepareDurableModelBinding } from '@flowmate/runtime-durable';
import { RUNTIME_CONFIG, type Result, type DocumentSnapshot, type ProviderConfig } from '@flowmate/contracts';
import * as P from '../../packages/contracts/src/personal-agent.ts';
import { HostClient } from '../../apps/desktop/main/host-client.ts';
import { PersonalAgentSnapshotSchema, PersonalHistoryPageSchema, PersonalHistoryEntrySchema, InvoiceWorkTimelinePageSchema } from '@flowmate/contracts';
import { parsePersonalAgentHostResult } from '../../apps/host/protocol.ts';
import { deferCleanup, mkdtempSync, waitFor } from '../support/resources.ts';
import { openTestDatabase } from '../support/database.ts';

function need<T>(result: Result<T>): T { if (!result.ok) throw Error(`${result.error.code}: ${result.error.message}`); return result.data; }
type Command = Parameters<HostClient['request']>[0];
async function invoke<S extends z.ZodTypeAny>(client: HostClient, command: Command, schema: S): Promise<z.infer<S>> {
  return z.object({ ok: z.literal(true), data: schema }).strict().parse(await client.request(command, 5_000)).data;
}

async function controlledHost() {
  const root = mkdtempSync(join(tmpdir(), 'flowmate-personal-host-commands-')), client = new HostClient();
  const wire: Array<{ authorization: string | null; body: unknown }> = [], credentials: string[] = [];
  const key = 'synthetic-personal-host-key', credentialRef = '00000000000000000000000000000081';
  const server = Bun.serve({ hostname: '127.0.0.1', port: 0, async fetch(request) {
    wire.push({ authorization: request.headers.get('authorization'), body: await request.json() });
    const response = { id: `personal-host-${wire.length}`, object: 'chat.completion.chunk', created: 1, model: 'personal-local-model',
      choices: [{ index: 0, delta: { role: 'assistant', content: 'Review the original invoice and supply clarification before continuing.' }, finish_reason: 'stop' }] };
    return new Response(`data: ${JSON.stringify(response)}\n\ndata: [DONE]\n\n`, { headers: { 'content-type': 'text/event-stream' } });
  } });
  deferCleanup(() => server.stop(true)); deferCleanup(() => client.close());
  const credentialHandler = async (request: { operation: string; credentialRef: string }) => {
    expect(request.operation).toBe('read'); expect(request.credentialRef).toBe(credentialRef);
    credentials.push(request.credentialRef); return { ok: true, credential: { type: 'api_key', key } };
  };
  client.setCredentialHandler(credentialHandler);
  expect(await client.start(root, '0.1.0', resolve(import.meta.dir, '../..'))).toMatchObject({ ok: true, data: { ready: true } });
  const profile = { id: 'personal-local', name: 'Personal local', credentialRef, kind: 'custom' as const, providerId: null,
    baseUrl: `http://127.0.0.1:${server.port}/v1`, model: 'personal-local-model', api: 'openai-completions',
    contextWindow: 64000, maxTokens: 8192, reasoning: false };
  expect(await client.request({ type: 'save_settings', settings: { ...defaultProductSettings(), version: 6, revision: 0,
    profile: { displayName: 'P18 controlled Host', theme: 'system' }, models: [profile], defaultModelId: profile.id,
    updatedAt: '2026-10-29T00:00:00.000Z' } })).toMatchObject({ ok: true, data: { revision: 1 } });
  const sourceText = 'Controlled invoice total 113.00';
  const document = need(await client.request({ type: 'import_prepared_invoice_material', input: {
    contract: 'flowmate-prepared-invoice/v1', sample: 'personal-host-controlled', sourceText,
    original: { name: 'source.md', base64: Buffer.from(sourceText).toString('base64') },
    pages: [{ page: 1, blocks: [{ id: 'b1', kind: 'text', text: sourceText, sourceIndex: 0, sourceType: 'prepared-text', bbox: null }] }],
  } }) as Result<DocumentSnapshot>);
  const original = await invoke(client, { type: 'personal_agent_get', input: {} }, P.PersonalAgentSnapshotSchema);
  const agent = await invoke(client, { type: 'personal_agent_update', input: { personalAgentId: original.personalAgentId,
    expectedRevision: original.revision, configuration: { ...original.configuration, modelId: profile.id,
      resources: { prompt: null, enabledSkills: [] }, extensions: { enabledExtensions: [] }, tools: ['read_invoice_document'] } } }, P.PersonalAgentSnapshotSchema);
  expect(wire).toHaveLength(0); expect(credentials).toHaveLength(0);
  const provider: ProviderConfig = { version: 1, name: `desktop-${profile.name}`, revision: 1,
    modelRef: { provider: `flowmate-profile-${profile.id}`, model: profile.model }, credentialRef,
    native: { authPath: join(root, 'runtime/pi-desktop/auth.json'), modelsPath: null },
    connection: { baseUrl: profile.baseUrl, api: profile.api, contextWindow: profile.contextWindow,
      maxTokens: profile.maxTokens, reasoning: profile.reasoning }, parameters: { ...RUNTIME_CONFIG.provider } };
  return { root, client, document, agent, wire, credentials, key, provider, credentialHandler };
}

it('assembles the independent Personal Agent through the actual Host and keeps queries passive', async () => {
  const root = mkdtempSync(join(tmpdir(), 'flowmate-personal-host-')), client = new HostClient();
  let credentialRequests = 0;
  client.setCredentialHandler(async () => { credentialRequests++; return { ok: false }; });
  expect(await client.start(root, '0.1.0', resolve(import.meta.dir, '../..'))).toMatchObject({ ok: true });
  try {
    const read = parsePersonalAgentHostResult('personal_agent_get', await client.request({ type: 'personal_agent_get', input: {} }, 2_000));
    expect(read).toMatchObject({ ok: true, data: { runtimeKind: 'durable' } });
    const original = PersonalAgentSnapshotSchema.parse(read?.ok ? read.data : undefined);
    const configuration = { ...original.configuration, preferences: '逐票整理，保留待人工复核的来源。' };
    expect(await client.request({ type: 'personal_agent_update', input: {
      personalAgentId: original.personalAgentId, expectedRevision: original.revision, configuration,
    } })).toMatchObject({ ok: true, data: { configuration } });
    expect(await client.request({ type: 'invoice_work_list', input: { personalAgentId: original.personalAgentId, limit: 10 } }))
      .toMatchObject({ ok: true, data: { items: [] } });
    expect(await client.request({ type: 'invoice_work_query_operation', input: {
      operation: 'create', personalAgentId: original.personalAgentId, requestId: 'never-submitted',
    } })).toEqual({ ok: true, data: null });
    expect(credentialRequests).toBe(0);
  } finally { expect(await client.close()).toMatchObject({ ok: true, data: { closed: true, stopped: true } }); }
  const db = new Database(join(root, 'data/app.sqlite'), { readonly: true });
  try {
    for (const table of ['runs', 'session_inputs', 'tool_calls', 'invoice_works'])
      expect(db.query(`SELECT count(*) AS count FROM ${table}`).get()).toEqual({ count: 0 });
  } finally { db.close(); }
}, 30_000);

it('routes all 17 Personal Agent commands through the actual Host with isolated local SSE and synthetic credentials', async () => {
  const f = await controlledHost(), seen = new Set<string>();
  const call = <S extends z.ZodTypeAny>(command: Command, schema: S) => { seen.add(command.type); return invoke(f.client, command, schema); };
  const getWork = (workId: number) => call({ type: 'invoice_work_get', input: { view: 'work', workId, limit: 10 } }, P.InvoiceWorkGetResultSchema);
  const getTask = (workId: number, attemptId: number) => call({ type: 'personal_task_get', input: { workId, attemptId, limit: 10 } }, P.PersonalTaskGetResultSchema);
  const settle = async (workId: number, attemptId: number) => waitFor(async () => (await getTask(workId, attemptId)).task.stoppedAt !== null, 10_000);
  try {
    const current = await call({ type: 'personal_agent_get', input: {} }, P.PersonalAgentSnapshotSchema);
    const agent = await call({ type: 'personal_agent_update', input: { personalAgentId: current.personalAgentId,
      expectedRevision: current.revision, configuration: { ...current.configuration, preferences: 'Keep the original invoice evidence.' } } }, P.PersonalAgentSnapshotSchema);
    const input = { personalAgentId: agent.personalAgentId, expectedAgentRevision: agent.revision, requestId: 'host-create-original',
      goal: 'Organize the original controlled invoice.', documents: [f.document.documentRef] };
    const created = await call({ type: 'invoice_work_create', input }, P.InvoiceWorkCreateReceiptSchema);
    expect(created.execution).toMatchObject({ authorizationAccepted: true });
    const firstAttempt = created.execution.attempt?.attemptId; if (!firstAttempt) throw Error('Missing accepted product attempt.');
    expect(await call({ type: 'personal_agent_open_conversation', input: { workId: created.workId } }, P.PersonalAgentConversationSchema))
      .toEqual({ workId: created.workId, sessionId: created.sessionId, runtimeKind: 'durable' });
    await settle(created.workId, firstAttempt);
    expect(await call({ type: 'personal_task_list', input: { workId: created.workId, limit: 10 } }, P.PersonalTaskListResultSchema))
      .toMatchObject({ workId: created.workId, items: [{ attempt: { attemptId: firstAttempt }, runStatus: 'completed' }] });
    let page = await getWork(created.workId);
    const stopped = await call({ type: 'personal_task_stop', input: { workId: created.workId, attemptId: firstAttempt,
      requestId: 'host-stop-completed-attempt', expectedRevision: page.work.revision } }, P.PersonalTaskStopReceiptSchema);
    expect(stopped).toMatchObject({ accepted: false, stopConfirmed: true });
    expect(await call({ type: 'personal_task_get', input: { workId: created.workId, attemptId: firstAttempt,
      stopRequestId: stopped.requestId, limit: 10 } }, P.PersonalTaskGetResultSchema)).toMatchObject({ stopReceipt: stopped });
    if (page.view !== 'work' || !page.items[0]) throw Error('Missing original invoice member.');
    const itemId = page.items[0].itemId;
    const detail = await call({ type: 'invoice_work_get', input: { view: 'item', workId: created.workId, itemId, limit: 10 } }, P.InvoiceWorkGetResultSchema);
    if (detail.view !== 'item' || !detail.todos[0]) throw Error('The actual completed model phase must expose its rule Todo.');
    const supplement = { workId: created.workId, itemId, todoId: detail.todos[0].todoId, requestId: 'host-supplement-original',
      expectedRevision: detail.work.revision, text: 'The original invoice total is 113.00.', materials: [] };
    const saved = await call({ type: 'invoice_work_supplement', input: supplement }, P.InvoiceWorkSupplementReceiptSchema);
    expect(saved).toMatchObject({ saved: true });
    const secondAttempt = saved.execution.attempt?.attemptId; if (!secondAttempt) throw Error('Missing supplemented product attempt.');
    await settle(created.workId, secondAttempt);
    page = await getWork(created.workId);
    const continuation = { workId: created.workId, expectedRevision: page.work.revision, expectedAttemptId: secondAttempt, requestId: 'host-explicit-continue' };
    const continued = await call({ type: 'invoice_work_continue', input: continuation }, P.InvoiceWorkContinueReceiptSchema);
    const thirdAttempt = continued.execution.attempt?.attemptId; if (!thirdAttempt) throw Error('Missing explicitly continued attempt.');
    await settle(created.workId, thirdAttempt);
    page = await getWork(created.workId);
    const disposed = await call({ type: 'invoice_work_dispose_item', input: { workId: created.workId, itemId,
      requestId: 'host-exclude-original', expectedRevision: page.work.revision,
      decision: { kind: 'excluded', reason: 'The user explicitly excluded this controlled invoice.' } } }, P.InvoiceWorkDisposeItemReceiptSchema);
    expect(disposed).toMatchObject({ disposition: 'excluded', itemId });
    expect((await getWork(created.workId)).work.status).toBe('completed');
    const latest = await call({ type: 'personal_agent_get', input: {} }, P.PersonalAgentSnapshotSchema);
    const withoutModel = await call({ type: 'personal_agent_update', input: { personalAgentId: latest.personalAgentId,
      expectedRevision: latest.revision, configuration: { ...latest.configuration, modelId: null } } }, P.PersonalAgentSnapshotSchema);
    const blocked = await call({ type: 'invoice_work_create', input: { ...input, requestId: 'host-create-cancellable',
      expectedAgentRevision: withoutModel.revision } }, P.InvoiceWorkCreateReceiptSchema);
    expect(blocked.execution).toMatchObject({ kind: 'blocked', authorizationAccepted: false, attempt: null });
    const cancelled = await call({ type: 'invoice_work_cancel', input: { workId: blocked.workId, requestId: 'host-cancel-original',
      expectedRevision: blocked.revision } }, P.InvoiceWorkCancelReceiptSchema);
    expect(cancelled).toMatchObject({ cancelled: true, workId: blocked.workId });
    const before = { requests: f.wire.length, credentials: f.credentials.length };
    expect(before.requests).toBe(3); expect(before.credentials).toBeGreaterThan(0);
    for (const [operation, requestId, receipt] of [
      ['create', input.requestId, created], ['supplement', supplement.requestId, saved],
      ['continueWork', continuation.requestId, continued], ['disposeItem', 'host-exclude-original', disposed],
      ['cancelWork', 'host-cancel-original', cancelled],
    ] as const) {
      const input = operation === 'create' ? { operation, personalAgentId: agent.personalAgentId, requestId }
        : { operation, workId: receipt.workId, requestId };
      expect(await call({ type: 'invoice_work_query_operation', input }, P.InvoiceWorkOperationReceiptSchema.nullable())).toEqual(receipt);
    }
    expect(await call({ type: 'invoice_work_list', input: { personalAgentId: agent.personalAgentId, limit: 10 } }, P.InvoiceWorkListResultSchema))
      .toMatchObject({ items: [{ workId: blocked.workId, status: 'cancelled' }, { workId: created.workId, status: 'completed' }] });
    await getTask(created.workId, thirdAttempt); await getWork(created.workId);
    await call({ type: 'personal_agent_open_conversation', input: { workId: created.workId } }, P.PersonalAgentConversationSchema);
    const history = await call({ type: 'personal_task_history', input: { target: { workId: created.workId }, limit: 10 } }, PersonalHistoryPageSchema);
    expect(history.owner).toMatchObject({ workId: created.workId, childRunId: null }); expect(history.entries.length).toBeGreaterThan(0);
    const entry = history.entries[0]!;
    expect(await call({ type: 'personal_task_history_entry', input: { target: { workId: created.workId },
      throughEntryId: history.throughEntryId, entryId: entry.entryId, offset: 0, limit: 100 } }, PersonalHistoryEntrySchema))
      .toMatchObject({ entryId: entry.entryId, totalBytes: entry.byteLength, owner: history.owner });
    const timeline = await call({ type: 'invoice_work_timeline', input: { workId: created.workId, limit: 100 } }, InvoiceWorkTimelinePageSchema);
    expect(timeline.entries.some(entry => entry.kind === 'item_disposed')).toBe(true);
    expect({ requests: f.wire.length, credentials: f.credentials.length }).toEqual(before);
    expect(f.wire.every(request => request.authorization === `Bearer ${f.key}`)).toBe(true);
    expect([...seen].sort()).toEqual(['personal_agent_get', 'personal_agent_update', 'personal_agent_open_conversation',
      'invoice_work_create', 'invoice_work_list', 'invoice_work_get', 'invoice_work_supplement', 'invoice_work_dispose_item',
      'invoice_work_continue', 'invoice_work_cancel', 'invoice_work_query_operation', 'personal_task_list', 'personal_task_get', 'personal_task_stop',
      'personal_task_history', 'personal_task_history_entry', 'invoice_work_timeline'].sort());
  } finally { expect(await f.client.close()).toMatchObject({ ok: true, data: { closed: true, stopped: true } }); }
  const db = new Database(join(f.root, 'data/app.sqlite'), { readonly: true });
  try {
    expect(db.query('SELECT count(*) count FROM runs').get()).toEqual({ count: 3 });
    expect(db.query('SELECT count(*) count FROM session_inputs').get()).toEqual({ count: 0 });
    expect(db.query('SELECT count(*) count FROM invoice_work_inputs').get()).toEqual({ count: 1 });
    expect(db.query('SELECT count(*) count FROM invoice_work_model_bindings').get()).toEqual({ count: 1 });
    expect(JSON.stringify(db.query('SELECT binding_json FROM invoice_work_model_bindings').all())).not.toContain(f.key);
  } finally { db.close(); }
}, 30_000);

it('recovery of a persisted accepted attempt can round-trip synthetic credentials after the real Host reader is ready', async () => {
  const f = await controlledHost();
  expect(await f.client.close()).toMatchObject({ ok: true, data: { closed: true, stopped: true } });
  const paths = { root: f.root, databaseFile: join(f.root, 'data/app.sqlite'), artifactsDir: join(f.root, 'artifacts'),
    runtimeDir: join(f.root, 'runtime'), logsDir: join(f.root, 'logs'), outputsDir: join(f.root, 'outputs') };
  const database = need(openTestDatabase(paths)), binding = need(await prepareDurableModelBinding(f.provider));
  const at = new Date().toISOString();
  // Seed committed product authorization only; the actual Host must recheck it and perform all native execution.
  const original = await database.transaction(scope => {
    const receipt = need(scope.invoiceWorks.create({ personalAgentId: f.agent.personalAgentId, expectedAgentRevision: f.agent.revision,
      requestId: 'host-startup-original-authorization', goal: 'Resume the original authorized controlled invoice.',
      documents: [f.document.documentRef] }, { at, admission: { kind: 'ready' } }));
    const attemptId = receipt.execution.attempt?.attemptId; if (!attemptId) throw Error('Missing original queued attempt.');
    need(scope.invoiceWorkModelBindings.save({ workId: receipt.workId, attemptId, modelId: f.agent.configuration.modelId!, binding, at }));
    expect(scope.db.query('SELECT count(*) count FROM runs').get()).toEqual({ count: 0 });
    return receipt;
  });
  await database.close();
  const client = new HostClient(); client.setCredentialHandler(f.credentialHandler); deferCleanup(() => client.close());
  try {
    expect(await client.start(f.root, '0.1.0', resolve(import.meta.dir, '../..'))).toMatchObject({ ok: true, data: { ready: true } });
    const attemptId = original.execution.attempt!.attemptId;
    await waitFor(async () => (await invoke(client, { type: 'personal_task_get', input: { workId: original.workId, attemptId, limit: 10 } },
      P.PersonalTaskGetResultSchema)).task.stoppedAt !== null, 10_000);
    expect(f.wire).toHaveLength(1); expect(f.credentials.length).toBeGreaterThan(0);
    const before = { requests: f.wire.length, credentials: f.credentials.length };
    expect(await invoke(client, { type: 'invoice_work_query_operation', input: { operation: 'create', personalAgentId: f.agent.personalAgentId,
      requestId: original.requestId } }, P.InvoiceWorkOperationReceiptSchema.nullable())).toEqual(original);
    expect(await invoke(client, { type: 'personal_task_get', input: { workId: original.workId, attemptId, limit: 10 } }, P.PersonalTaskGetResultSchema))
      .toMatchObject({ task: { runStatus: 'completed', stoppedAt: expect.any(String) } });
    expect({ requests: f.wire.length, credentials: f.credentials.length }).toEqual(before);
  } finally { expect(await client.close()).toMatchObject({ ok: true, data: { closed: true, stopped: true } }); }
}, 30_000);
