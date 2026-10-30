import { expect, it, spyOn } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { defaultProductSettings } from '@flowmate/core';
import type { DocumentSnapshot, ProductSettings, Result } from '@flowmate/contracts';
import { PersonalHistoryPageSchema, PersonalHistoryEntrySchema, InvoiceWorkTimelinePageSchema } from '@flowmate/contracts';
import * as P from '../../packages/contracts/src/personal-agent.ts';
import * as personalComposition from '../../apps/personal-agent.ts';
import * as composition from '../../apps/composition.ts';
import { createProductCommandDispatcher, type ProductCommandDispatcher } from '../../apps/host/dispatch.ts';
import type { HostOutput } from '../../apps/host/protocol.ts';
import { deferCleanup, mkdtemp, waitFor } from '../support/resources.ts';

function need<T>(result: Result<T>): T { if (!result.ok) throw new Error(result.error.code); return result.data; }

async function fixture(readGate?: () => Promise<void>) {
  const root = await mkdtemp(join(tmpdir(), 'flowmate-service-dispatch-'));
  const outputs: HostOutput[] = [], requests: unknown[] = [], credentialReads: string[] = [];
  const credentialRef = '00000000000000000000000000000091';
  const server = Bun.serve({ hostname: '127.0.0.1', port: 0, async fetch(request) {
    expect(request.headers.get('authorization')).toBe('Bearer synthetic-dispatch-key');
    requests.push(await request.json());
    const response = { id: `dispatch-${requests.length}`, object: 'chat.completion.chunk', created: 1,
      model: 'dispatch-local-model', choices: [{ index: 0, delta: { role: 'assistant',
        content: 'Review the original invoice before accepting the result.' }, finish_reason: 'stop' }] };
    return new Response(`data: ${JSON.stringify(response)}\n\ndata: [DONE]\n\n`, { headers: { 'content-type': 'text/event-stream' } });
  } });
  deferCleanup(() => server.stop(true));
  let owner: ProductCommandDispatcher;
  const open = async () => {
    owner = need(await createProductCommandDispatcher({ userDataRoot: root, invoiceSourceRoot: root,
      send: async output => { outputs.push(output); }, credentials: {
        async read(reference) { credentialReads.push(reference); if (reference !== credentialRef) throw new Error('wrong_credential_reference');
          await readGate?.(); return { type: 'api_key', key: 'synthetic-dispatch-key' }; },
        async write() { throw new Error('unexpected_credential_write'); }, async delete() { throw new Error('unexpected_credential_delete'); },
      } }));
    return owner;
  };
  await open();
  deferCleanup(() => owner.close());
  const call = async <T = unknown>(command: Record<string, unknown>): Promise<Result<T>> => {
    const requestId = randomUUID();
    await owner.dispatch({ version: 1, ...command, requestId });
    const response = outputs.find(value => value.type === 'response' && value.requestId === requestId);
    if (!response || response.type !== 'response') throw new Error('missing_dispatch_response');
    return response.value as Result<T>;
  };
  const profile = { id: 'dispatch-local', name: 'Dispatch local', credentialRef, kind: 'custom' as const, providerId: null,
    baseUrl: `http://127.0.0.1:${server.port}/v1`, model: 'dispatch-local-model', api: 'openai-completions',
    contextWindow: 64000, maxTokens: 8192, reasoning: false };
  need(await call({ type: 'save_settings', settings: { ...defaultProductSettings(), version: 6, revision: 0,
    profile: { displayName: 'P18 dispatcher', theme: 'system' }, models: [profile], defaultModelId: profile.id,
    updatedAt: '2026-10-29T00:00:00.000Z' } }));
  const sourceText = 'Controlled invoice total 113.00';
  const document = need(await call<DocumentSnapshot>({ type: 'import_prepared_invoice_material', input: {
    contract: 'flowmate-prepared-invoice/v1', sample: 'service-dispatch-controlled', sourceText,
    original: { name: 'source.md', base64: Buffer.from(sourceText).toString('base64') },
    pages: [{ page: 1, blocks: [{ id: 'b1', kind: 'text', text: sourceText, sourceIndex: 0, sourceType: 'prepared-text', bbox: null }] }],
  } }));
  const original = P.PersonalAgentSnapshotSchema.parse(need(await call({ type: 'personal_agent_get', input: {} })));
  const agent = P.PersonalAgentSnapshotSchema.parse(need(await call({ type: 'personal_agent_update', input: {
    personalAgentId: original.personalAgentId, expectedRevision: original.revision, configuration: { ...original.configuration,
      modelId: profile.id, resources: { prompt: null, enabledSkills: [] }, extensions: { enabledExtensions: [] }, tools: ['read_invoice_document'] },
  } })));
  return { root, outputs, requests, credentialReads, call, open, owner: () => owner, document, agent };
}

it('revokes pending foreground admission after a credential wait without cancelling a saved Personal Agent authorization', async () => {
  let release!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  const f = await fixture(() => gate), controller = new AbortController();
  try {
    const session = need(await f.call<{ sessionId: number }>({ type: 'create_session', input: { title: 'Disconnected foreground' } }));
    const pending = f.owner().dispatch({ version: 1, requestId: 'disconnected-start', type: 'start_run',
      input: { sessionId: session.sessionId, text: 'Must not execute after disconnect', modelId: 'dispatch-local', goalMode: 'answer' },
      expectedSettingsRevision: 1, expectedCredentialRef: '00000000000000000000000000000091' }, { signal: controller.signal });
    await waitFor(async () => f.credentialReads.length === 1);
    controller.abort('shutdown'); release(); await pending;
    expect(f.outputs.find(output => output.type === 'response' && output.requestId === 'disconnected-start'))
      .toMatchObject({ value: { ok: false, error: { code: 'runtime_shutdown' } } });
    expect(await f.call({ type: 'list_session_runs', input: { sessionId: session.sessionId } }))
      .toMatchObject({ ok: true, data: { items: [] } });
    expect(f.requests).toHaveLength(0);
    const input = { personalAgentId: f.agent.personalAgentId, expectedAgentRevision: f.agent.revision,
      requestId: 'detached-original-create', goal: 'Keep the saved background authorization.', documents: [f.document.documentRef] };
    await f.owner().dispatch({ version: 1, requestId: 'detached-business-command', type: 'invoice_work_create', input }, { signal: controller.signal });
    expect(f.outputs.find(output => output.type === 'response' && output.requestId === 'detached-business-command'))
      .toMatchObject({ value: { ok: true, data: { execution: { authorizationAccepted: true } } } });
    expect(f.requests).toHaveLength(0);
  } finally { release(); }
}, 30_000);

it('uses the original serialized configuration authority for private service settings and raw Host settings', async () => {
  const f = await fixture();
  const authority = f.owner().settingsAuthority;
  const original = need(await authority.readSettings());
  const saved = need(await authority.withSettingsWrite(scope => scope.save({ ...scope.current,
    profile: { ...scope.current.profile, displayName: 'Private service authority' } })));
  expect(saved.revision).toBe(original.revision + 1);
  expect(await f.call({ type: 'save_settings', settings: { ...original, profile: { ...original.profile, displayName: 'Stale raw authority' } } }))
    .toMatchObject({ ok: false, error: { code: 'config_revision_conflict' } });
  expect(await authority.readSettings()).toMatchObject({ ok: true, data: { revision: saved.revision,
    profile: { displayName: 'Private service authority' } } });
  expect(f.requests).toHaveLength(0);
});

it('checks credential publication recovery inside the original settings queue before another mutation', async () => {
  const f = await fixture(), authority = f.owner().settingsAuthority;
  let blocked = true, hookCalls = 0;
  authority.setCredentialRecoveryHook(async scope => {
    hookCalls++; expect(scope.current.revision).toBe(1);
    return blocked ? { ok: false, error: { code: 'credential_publication_unconfirmed', category: 'storage',
      retryable: true, message: 'The original credential publication is not confirmed.' } } : { ok: true, data: undefined };
  });
  const before = need(await authority.readSettings());
  expect(hookCalls).toBe(0);
  expect(await f.call({ type: 'save_settings', settings: { ...before, profile: { ...before.profile, displayName: 'Blocked mutation' } } }))
    .toMatchObject({ ok: false, error: { code: 'credential_publication_unconfirmed' } });
  expect(need(await authority.readSettings()).revision).toBe(1);
  blocked = false;
  expect(await f.call({ type: 'save_settings', settings: before })).toMatchObject({ ok: true, data: { revision: 2 } });
  expect(hookCalls).toBe(2);
});

it('requires the original persisted stop stamp and cleanup proof rather than a finished Run alone', async () => {
  const create = composition.createApplication;
  let observation: 'actual' | 'no-stamp' | 'no-proof' = 'actual';
  const intercepted = spyOn(composition, 'createApplication').mockImplementation(async options => {
    const created = await create(options);
    if (created.ok) {
      const query = created.data.queryRun;
      created.data.queryRun = async runId => {
        const result = await query(runId);
        if (!result.ok || observation === 'actual') return result;
        return { ok: true, data: { ...result.data, ...(observation === 'no-stamp' ? { stoppedAt: null }
          : { cleanup: { ...result.data.cleanup, stopped: false } }) } };
      };
    }
    return created;
  });
  try {
    const f = await fixture();
    const session = need(await f.call<{ sessionId: number }>({ type: 'create_session', input: { title: 'Original stop proof' } }));
    const accepted = need(await f.call<{ runId: number }>({ type: 'start_run', input: { sessionId: session.sessionId,
      text: 'Controlled original foreground.', modelId: 'dispatch-local', goalMode: 'answer' }, expectedSettingsRevision: 1,
      expectedCredentialRef: '00000000000000000000000000000091' }));
    await waitFor(async () => f.outputs.some(value => value.type === 'event' && value.event.type === 'agent_run_event'
      && value.event.value.runId === accepted.runId && value.event.value.type === 'run_finished'));
    const reference = { kind: 'run' as const, runId: accepted.runId, sessionId: session.sessionId };
    expect(await f.owner().readForegroundStop(reference)).toEqual({ ok: true, data: true });
    observation = 'no-stamp'; expect(await f.owner().readForegroundStop(reference)).toEqual({ ok: true, data: false });
    observation = 'no-proof'; expect(await f.owner().readForegroundStop(reference)).toEqual({ ok: true, data: false });
    observation = 'actual'; expect(await f.owner().readForegroundStop({ ...reference, sessionId: session.sessionId + 1 }))
      .toMatchObject({ ok: false, error: { code: 'state_conflict' } });
  } finally { intercepted.mockRestore(); }
}, 30_000);

it('keeps admission passive until explicit recovery and recovers the original accepted Work through direct credentials', async () => {
  const f = await fixture();
  const input = { personalAgentId: f.agent.personalAgentId, expectedAgentRevision: f.agent.revision,
    requestId: 'dispatch-original-create', goal: 'Organize the original invoice.', documents: [f.document.documentRef] };
  const created = P.InvoiceWorkCreateReceiptSchema.parse(need(await f.call({ type: 'invoice_work_create', input })));
  expect(created.execution.authorizationAccepted).toBe(true);
  expect(created.execution.attempt).not.toBeNull();
  expect(await f.call({ type: 'invoice_work_create', input })).toEqual({ ok: true, data: created });
  expect(f.requests).toHaveLength(0);
  expect(f.outputs.some(output => output.type === 'credential_request')).toBe(false);
  expect(await f.owner().close()).toMatchObject({ ok: true, data: { closed: true, stopped: true } });
  await f.open();
  const before = f.credentialReads.length;
  expect(await f.call({ type: 'invoice_work_query_operation', input: { operation: 'create',
    personalAgentId: f.agent.personalAgentId, requestId: input.requestId } })).toEqual({ ok: true, data: created });
  need(await f.call({ type: 'personal_task_list', input: { workId: created.workId, limit: 10 } }));
  expect(f.requests).toHaveLength(0);
  expect(f.credentialReads).toHaveLength(before);
  expect(await f.owner().startRecovery()).toEqual({ ok: true, data: undefined });
  await waitFor(async () => {
    const tasks = P.PersonalTaskListResultSchema.parse(need(await f.call({ type: 'personal_task_list', input: { workId: created.workId, limit: 10 } })));
    return tasks.items.some(task => task.attempt.attemptId === created.execution.attempt?.attemptId
      && task.stoppedAt !== null && task.runStatus === 'completed');
  });
  expect(f.requests).toHaveLength(1);
  expect(await f.owner().startRecovery()).toEqual({ ok: true, data: undefined });
  const settled = f.requests.length, credentialCount = f.credentialReads.length;
  need(await f.call({ type: 'invoice_work_list', input: { personalAgentId: f.agent.personalAgentId, limit: 10 } }));
  expect(f.requests).toHaveLength(settled);
  expect(f.credentialReads).toHaveLength(credentialCount);
}, 30_000);

it('repairs original credential publication before recovery and retries only the failed explicit start after reopening', async () => {
  const f = await fixture();
  const input = { personalAgentId: f.agent.personalAgentId, expectedAgentRevision: f.agent.revision,
    requestId: 'original-startup-publication', goal: 'Keep the original accepted Work behind its publication recovery.', documents: [f.document.documentRef] };
  const created = P.InvoiceWorkCreateReceiptSchema.parse(need(await f.call({ type: 'invoice_work_create', input })));
  expect(f.requests).toHaveLength(0);
  expect(await f.owner().close()).toMatchObject({ ok: true, data: { stopped: true, closed: true } });
  await f.open();
  let publicationConfirmed = false, hookCalls = 0;
  f.owner().settingsAuthority.setCredentialRecoveryHook(async () => {
    hookCalls++;
    return publicationConfirmed ? { ok: true, data: undefined } : { ok: false, error: {
      code: 'service_credential_publication_pending', category: 'storage', retryable: true,
      message: 'The original credential publication is not yet confirmed.' } };
  });
  const before = f.credentialReads.length;
  expect(await f.owner().startRecovery()).toMatchObject({ ok: false, error: { code: 'service_credential_publication_pending' } });
  expect(hookCalls).toBe(1); expect(f.requests).toHaveLength(0); expect(f.credentialReads).toHaveLength(before);
  expect(await f.call({ type: 'invoice_work_query_operation', input: { operation: 'create',
    personalAgentId: f.agent.personalAgentId, requestId: input.requestId } })).toEqual({ ok: true, data: created });
  publicationConfirmed = true;
  expect(await f.owner().startRecovery()).toEqual({ ok: true, data: undefined });
  await waitFor(async () => P.PersonalTaskListResultSchema.parse(need(await f.call({ type: 'personal_task_list',
    input: { workId: created.workId, limit: 10 } }))).items.some(task => task.attempt.attemptId === created.execution.attempt?.attemptId
      && task.runStatus === 'completed' && task.stoppedAt !== null));
  expect(hookCalls).toBe(2); expect(f.requests).toHaveLength(1);
  const reads = f.credentialReads.length;
  expect(await f.owner().startRecovery()).toEqual({ ok: true, data: undefined });
  expect(hookCalls).toBe(2); expect(f.requests).toHaveLength(1); expect(f.credentialReads).toHaveLength(reads);
}, 30_000);

it('checks the original activation revision after the serialized credential recovery hook', async () => {
  const f = await fixture();
  const input = { personalAgentId: f.agent.personalAgentId, expectedAgentRevision: f.agent.revision,
    requestId: 'original-recovery-settings-revision', goal: 'Preserve the original accepted Work.', documents: [f.document.documentRef] };
  const created = P.InvoiceWorkCreateReceiptSchema.parse(need(await f.call({ type: 'invoice_work_create', input })));
  let recovered = false;
  f.owner().settingsAuthority.setCredentialRecoveryHook(async scope => {
    if (!recovered) {
      const saved = await scope.save({ ...scope.current, profile: { ...scope.current.profile, displayName: 'Recovered publication' } },
        { notifyConditionsChanged: false });
      if (!saved.ok) return saved;
      recovered = true;
    }
    return { ok: true, data: undefined };
  });
  expect(await f.owner().startRecovery(1)).toMatchObject({ ok: false, error: { code: 'config_revision_conflict' } });
  expect(f.requests).toHaveLength(0);
  expect(await f.call({ type: 'invoice_work_query_operation', input: { operation: 'create',
    personalAgentId: f.agent.personalAgentId, requestId: input.requestId } })).toEqual({ ok: true, data: created });
  expect(await f.owner().startRecovery(2)).toEqual({ ok: true, data: undefined });
  await waitFor(async () => P.PersonalTaskListResultSchema.parse(need(await f.call({ type: 'personal_task_list',
    input: { workId: created.workId, limit: 10 } }))).items.some(task => task.attempt.attemptId === created.execution.attempt?.attemptId
      && task.runStatus === 'completed' && task.stoppedAt !== null));
  expect(f.requests).toHaveLength(1);
}, 30_000);

it('acknowledges recovery scheduling before the original background execution completes', async () => {
  let held = false, entered = false, release!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  const f = await fixture(async () => { if (held) { entered = true; await gate; } });
  const input = { personalAgentId: f.agent.personalAgentId, expectedAgentRevision: f.agent.revision,
    requestId: 'original-long-background-recovery', goal: 'Continue the original background invoice.', documents: [f.document.documentRef] };
  const created = P.InvoiceWorkCreateReceiptSchema.parse(need(await f.call({ type: 'invoice_work_create', input })));
  held = true;
  const starting = f.owner().startRecovery(1); let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const acknowledged = await Promise.race([starting,
      new Promise<null>(resolve => { timer = setTimeout(() => resolve(null), 1500); })]);
    expect(acknowledged).toEqual({ ok: true, data: undefined });
    await waitFor(async () => entered);
    expect(f.requests).toHaveLength(0);
    expect(await f.call({ type: 'invoice_work_query_operation', input: { operation: 'create',
      personalAgentId: f.agent.personalAgentId, requestId: input.requestId } })).toEqual({ ok: true, data: created });
    release();
    await waitFor(async () => P.PersonalTaskListResultSchema.parse(need(await f.call({ type: 'personal_task_list',
      input: { workId: created.workId, limit: 10 } }))).items.some(task => task.attempt.attemptId === created.execution.attempt?.attemptId
        && task.runStatus === 'completed' && task.stoppedAt !== null));
    expect(f.requests).toHaveLength(1);
  } finally { clearTimeout(timer); release(); await starting; }
}, 30_000);

it('does not begin business recovery when close finishes during the original credential recovery hook', async () => {
  const f = await fixture();
  const input = { personalAgentId: f.agent.personalAgentId, expectedAgentRevision: f.agent.revision,
    requestId: 'original-close-before-recovery', goal: 'Preserve the original acceptance during close.', documents: [f.document.documentRef] };
  const created = P.InvoiceWorkCreateReceiptSchema.parse(need(await f.call({ type: 'invoice_work_create', input })));
  let release!: () => void, entered = false;
  const gate = new Promise<void>(resolve => { release = resolve; });
  f.owner().settingsAuthority.setCredentialRecoveryHook(async () => { entered = true; await gate; return { ok: true, data: undefined }; });
  const starting = f.owner().startRecovery();
  try {
    await waitFor(async () => entered);
    expect(await f.owner().close()).toMatchObject({ ok: true, data: { stopped: true, closed: true } });
    release();
    expect(await starting).toMatchObject({ ok: false, error: { code: 'host_closing' } });
    expect(f.requests).toHaveLength(0);
    await f.open();
    expect(await f.call({ type: 'invoice_work_query_operation', input: { operation: 'create',
      personalAgentId: f.agent.personalAgentId, requestId: input.requestId } })).toEqual({ ok: true, data: created });
    expect(f.requests).toHaveLength(0);
  } finally { release(); await starting; }
}, 30_000);

it('validates raw commands before writes and observer release does not release the product owner', async () => {
  const f = await fixture(), before = f.outputs.length;
  for (const invalid of [
    { version: 2, requestId: 'wrong-version', type: 'create_session', input: { title: 'must not exist' } },
    { version: 1, requestId: 'root-injection', type: 'get_state', dataRoot: 'C:/other-user' },
    { version: 1, requestId: 'unknown-management', type: 'install', executable: 'cmd.exe' },
  ]) await f.owner().dispatch(invalid);
  expect(f.outputs).toHaveLength(before);
  expect(need(await f.call<{ items: unknown[] }>({ type: 'list_sessions', input: { limit: 10 } })).items).toHaveLength(0);
  f.owner().releaseRuntimeObservations();
  const other = await createProductCommandDispatcher({ userDataRoot: f.root, invoiceSourceRoot: f.root, send: async () => {} });
  expect(other).toMatchObject({ ok: false, error: { code: 'runtime_already_owned' } });
  expect(await f.call({ type: 'get_state' })).toMatchObject({ ok: true, data: { ready: true, userDataPath: f.root } });
  expect(await f.owner().close()).toMatchObject({ ok: true, data: { closed: true, stopped: true } });
  expect(await f.owner().startRecovery()).toMatchObject({ ok: false, error: { code: 'host_closing' } });
  await f.open();
  expect(f.requests).toHaveLength(0);
  expect(need(await f.call<{ items: unknown[] }>({ type: 'list_sessions', input: { limit: 10 } })).items).toHaveLength(0);
}, 30_000);

it('keeps original receipts and history readable while real Application close is draining, without reopening writes or releasing the owner', async () => {
  const original = personalComposition.createPersonalAgentRuntime;
  let release!: () => void, entered = false;
  const barrier = new Promise<void>(resolve => { release = resolve; });
  const wrapped = spyOn(personalComposition, 'createPersonalAgentRuntime').mockImplementation(async options => {
    const result = await original(options);
    if (result.ok) {
      const close = result.data.close;
      result.data.close = async () => { entered = true; await barrier; return close(); };
    }
    return result;
  });
  let closing: ReturnType<ProductCommandDispatcher['close']> | undefined;
  try {
    const f = await fixture();
    const legacy = need(await f.call<{ sessionId: number }>({ type: 'create_session', input: { title: 'Original Legacy Session' } }));
    const input = { personalAgentId: f.agent.personalAgentId, expectedAgentRevision: f.agent.revision,
      requestId: 'dispatch-closing-original', goal: 'Organize this invoice.', documents: [f.document.documentRef] };
    const created = P.InvoiceWorkCreateReceiptSchema.parse(need(await f.call({ type: 'invoice_work_create', input })));
    const attemptId = created.execution.attempt!.attemptId;
    need(await f.owner().startRecovery());
    await waitFor(async () => P.PersonalTaskListResultSchema.parse(need(await f.call({ type: 'personal_task_list',
      input: { workId: created.workId, limit: 10 } }))).items.some(task => task.attempt.attemptId === attemptId
        && task.stoppedAt !== null && task.runStatus === 'completed'));
    const before = { requests: f.requests.length, credentials: f.credentialReads.length };
    closing = f.owner().close();
    await waitFor(async () => entered);
    expect(await f.call({ type: 'invoice_work_query_operation', input: { operation: 'create',
      personalAgentId: f.agent.personalAgentId, requestId: input.requestId } })).toEqual({ ok: true, data: created });
    const work = P.InvoiceWorkGetResultSchema.parse(need(await f.call({ type: 'invoice_work_get',
      input: { view: 'work', workId: created.workId, limit: 10 } })));
    expect(work.work.workId).toBe(created.workId);
    need(await f.call({ type: 'personal_agent_get', input: {} }));
    expect(await f.call({ type: 'personal_agent_open_conversation', input: { workId: created.workId } }))
      .toMatchObject({ ok: true, data: { workId: created.workId, sessionId: created.sessionId } });
    need(await f.call({ type: 'invoice_work_list', input: { personalAgentId: f.agent.personalAgentId, limit: 10 } }));
    need(await f.call({ type: 'personal_task_get', input: { workId: created.workId, attemptId, limit: 10 } }));
    const history = PersonalHistoryPageSchema.parse(need(await f.call({ type: 'personal_task_history',
      input: { target: { workId: created.workId }, limit: 10 } })));
    expect(history.entries.length).toBeGreaterThan(0);
    PersonalHistoryEntrySchema.parse(need(await f.call({ type: 'personal_task_history_entry', input: {
      target: { workId: created.workId }, throughEntryId: history.throughEntryId, entryId: history.entries[0]!.entryId, limit: 100 } })));
    InvoiceWorkTimelinePageSchema.parse(need(await f.call({ type: 'invoice_work_timeline', input: { workId: created.workId, limit: 10 } })));
    for (const query of [
      { type: 'get_state' }, { type: 'list_documents', input: { limit: 10 } }, { type: 'query_session', sessionId: legacy.sessionId },
      { type: 'query_runtime_state' }, { type: 'read_workspace' }, { type: 'list_model_catalog', refresh: false },
    ]) expect(await f.call(query)).toMatchObject({ ok: true });
    for (const mutation of [
      { type: 'create_session', input: { title: 'must not be created during close' } },
      { type: 'save_settings', settings: defaultProductSettings() }, { type: 'restore_workspace' },
      { type: 'list_model_catalog', providerId: 'openai', refresh: true },
      { type: 'personal_agent_update', input: { personalAgentId: f.agent.personalAgentId, expectedRevision: f.agent.revision,
        configuration: { ...f.agent.configuration, preferences: 'must not be saved during close' } } },
      { type: 'invoice_work_continue', input: { workId: created.workId, expectedRevision: work.work.revision,
        expectedAttemptId: attemptId, requestId: 'must-not-continue-during-close' } },
    ]) expect(await f.call(mutation)).toMatchObject({ ok: false, error: { code: 'host_closing' } });
    expect({ requests: f.requests.length, credentials: f.credentialReads.length }).toEqual(before);
    const other = await createProductCommandDispatcher({ userDataRoot: f.root, invoiceSourceRoot: f.root, send: async () => {} });
    expect(other).toMatchObject({ ok: false, error: { code: 'runtime_already_owned' } });
    release();
    expect(await closing).toMatchObject({ ok: true, data: { closed: true, stopped: true } });
  } finally {
    release();
    if (closing) await closing;
    wrapped.mockRestore();
  }
}, 30_000);
