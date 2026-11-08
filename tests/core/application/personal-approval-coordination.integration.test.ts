import { expect, test } from 'bun:test';
import { appError, fail, ok, type CloudNativeResult, type CloudNativeResultReceipt, type ProviderConfig, type Result } from '@flowmate/contracts';
import { createInvoiceWorkApprovalWait } from '../../../packages/core/src/personal-agent/approval-wait.ts';
import { DurableInvoiceGovernor } from '../../../packages/core/src/personal-agent/admission.ts';
import { InvoiceWorkCoordinator } from '../../../packages/core/src/personal-agent/coordination.ts';
import { InvoiceWorkModelService } from '../../../packages/core/src/personal-agent/models.ts';
import { InvoiceWorkPhaseContextService, InvoiceWorkPhaseObserver } from '../../../packages/core/src/personal-agent/phase-context.ts';
import { PersonalTasksService } from '../../../packages/core/src/personal-agent/tasks.ts';
import { createBrowserExecutionTool, createBrowserRequestTool } from '../../../packages/core/src/personal-agent/browser-tools.ts';
import { createDesktopExecutionTool, createDesktopProposalTool } from '../../../packages/core/src/personal-agent/desktop-tools.ts';
import { createInvoiceWorkToolBridge } from '../../../packages/core/src/personal-agent/tool-scope.ts';
import { createToolExecutor } from '../../../packages/core/src/tools/executor.ts';
import { toPiParameters } from '../../../packages/runtime-pi/src/schema.ts';
import { buildInvoiceWorkContext, createDurableRuntime, createDurableSqliteStorage, type DurableRuntimeOptions } from '@flowmate/runtime-durable';
import { invoiceWorkToolsFixture } from '../../support/invoice-work-tools.ts';
import { waitFor } from '../../support/resources.ts';
import { mkdtempSync } from '../../support/resources.ts';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { openCloudRuntimeStore } from '../../../apps/cloud-runtime-storage.ts';
import { createCloudRuntimeRouter } from '../../../apps/cloud-runtime-router.ts';
import { createCloudRuntimeAuthorizer } from '../../../apps/cloud-runtime-authority.ts';
import { CloudNativeResultReceiver } from '../../../apps/cloud-native-result-receiver.ts';
import { CloudModelAttempts } from '../../../packages/core/src/personal-agent/cloud-model-attempts.ts';
import { CloudDeepSeekProxy } from '../../../apps/cloud-deepseek-proxy.ts';

function need<T>(value: Result<T>): T { if (!value.ok) throw Error(`${value.error.code}: ${value.error.message}`); return value.data; }

test.each([['browser', 'live'], ['browser', 'restart'], ['browser', 'stop'], ['browser', 'timeout'], ['browser', 'revoked'], ['browser', 'twice'], ['browser', 'twice-restart'], ['browser', 'twice-reject'], ['browser', 'twice-reject-restart'], ['browser', 'projection-loss'],
  ['browser', 'unknown'], ['browser', 'cloud'], ['browser', 'cloud-restart'], ['browser', 'cloud-lost'], ['browser', 'cloud-revoked'],
  ['desktop', 'live'], ['desktop', 'restart'], ['desktop', 'stop'], ['desktop', 'timeout'], ['desktop', 'revoked'], ['desktop', 'twice'], ['desktop', 'twice-restart'], ['desktop', 'twice-reject'], ['desktop', 'unknown'], ['desktop', 'cloud-revoked']] as const)(
  'a Work continues another invoice and handles its original %s tool after %s', async (kind, mode) => {
  const now = () => new Date().toISOString(), started = now();
  const cloudMode = mode === 'cloud' || mode === 'cloud-restart' || mode === 'cloud-lost' || mode === 'cloud-revoked';
  const cloudRuntimeId = '11111111-1111-4111-8111-111111111111', workspaceId = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
  const f = await invoiceWorkToolsFixture({ at: started, itemLane: true, ...(mode === 'timeout' ? { timeoutMs: 3000 } : {}),
    ...(cloudMode ? { durableRuntimeId: cloudRuntimeId } : {}), configuration: { modelId: 'controlled', thinkingLevel: 'off',
    tools: kind === 'browser' ? ['browser_request_read', 'browser_read_approved'] : ['desktop_propose_action', 'desktop_execute_approved'],
    resources: { prompt: null, enabledSkills: [] },
    extensions: { enabledExtensions: [] }, workingDirectory: null, preferences: '' } });
  const target = { connectionId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', bindingId: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb', origin: 'https://example.test' };
  const desktopTarget = { connectionId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', window: { id: 42, app: 'Invoice', title: 'Draft' }, element: '[3] Save' };
  const action = { kind: 'click' as const, observationId: '84c2bb96-6c56-48e0-aab0-f49f059cb1ba', elementIndex: 3 };
  let reads = 0; const requests: number[] = [];
  const server = Bun.serve({ port: 0, fetch: async request => {
    const body = await request.json() as { messages: Array<{ role: string; content: string }> };
    const context = JSON.parse(body.messages.find(message => message.role === 'user')!.content) as { item: { itemId: number } };
    requests.push(context.item.itemId);
    const feedbackCount = body.messages.filter(message => message.role === 'tool').length;
    const proposed = context.item.itemId === f.itemId && feedbackCount < (mode.startsWith('twice') ? 2 : 1);
    const delta = proposed ? { role: 'assistant', tool_calls: [{ index: 0, id: feedbackCount ? `original-browser-${feedbackCount}` : 'original-browser', type: 'function',
      function: { name: kind === 'browser' ? 'browser_request_read' : 'desktop_propose_action', arguments: kind === 'browser' ? '{}' : JSON.stringify(action) } }] }
      : { role: 'assistant', content: context.item.itemId === f.itemId ? 'Original page reviewed.' : 'Other invoice reviewed.' };
    const chunk = { id: 'coordinated-approval', object: 'chat.completion.chunk', created: 1, model: 'controlled-model',
      choices: [{ index: 0, delta, finish_reason: proposed ? 'tool_calls' : 'stop' }] };
    return new Response(`data: ${JSON.stringify(chunk)}\n\ndata: [DONE]\n\n`, { headers: { 'content-type': 'text/event-stream' } });
  } });
  const provider: ProviderConfig = { version: 1, name: 'controlled', revision: 1, modelRef: { provider: 'controlled', model: 'offline' },
    native: { authPath: 'unused-auth.json', modelsPath: null }, connection: { api: 'openai-completions',
      baseUrl: `http://127.0.0.1:${server.port}/v1`, contextWindow: 64_000, maxTokens: 8_192 }, parameters: { maxRetries: 0, maxRetryDelayMs: 1000 } };
  if (cloudMode) await f.database.transaction(scope => {
    for (const id of [1, 2]) scope.db.query('INSERT INTO cloud_workspace_documents(workspace_id,upload_id,document_id,document_version) VALUES(?,?,?,?)')
      .run(workspaceId, `00000000-0000-4000-8000-00000000000${id}`, id, 'v1');
  });
  const governor = new DurableInvoiceGovernor(f.database, now, () => false, cloudMode ? 'cloud' : 'local');
  const contexts = new InvoiceWorkPhaseContextService({ database: f.database, now, buildContext: buildInvoiceWorkContext });
  let coordinator!: InvoiceWorkCoordinator, observer!: InvoiceWorkPhaseObserver, tasks!: PersonalTasksService;
  const originalWait = createInvoiceWorkApprovalWait({ database: f.database, now, onChanged: () => coordinator?.wake() });
  let waitEntries = 0;
  let waitIdentity: Parameters<typeof originalWait.begin>[0] | undefined;
  const wait = { ...originalWait, begin: async (input: Parameters<typeof originalWait.begin>[0]) => {
    waitEntries++; waitIdentity = input; return originalWait.begin(input);
  } };
  const definitions = kind === 'browser' ? [createBrowserRequestTool({ database: f.database, now, resolveTarget: async () => ok(target) }),
    createBrowserExecutionTool({ database: f.database, now, resolveTarget: async () => ok(target), read: async () => {
      reads++; return mode === 'unknown' ? fail(appError('browser_result_unknown', 'runtime', 'Controlled lost page receipt.', true))
        : ok({ url: 'https://example.test/invoice', title: 'Invoice', text: 'Untrusted page', truncated: false });
    } })] : [createDesktopProposalTool({ database: f.database, now, resolveTarget: async () => ok(desktopTarget) }),
    createDesktopExecutionTool({ database: f.database, now, resolveTarget: async () => ok(desktopTarget), dispatch: async () => {
      reads++; return mode === 'unknown' ? fail(appError('desktop_result_unknown', 'runtime', 'Controlled lost action receipt.', true)) : ok(undefined);
    } })];
  const bridge = createInvoiceWorkToolBridge({ database: f.database, executor: createToolExecutor({ database: f.database, definitions, now }) });
  const runtimeOptions: Omit<DurableRuntimeOptions, 'storage'> = { readApiKey: () => 'synthetic-key',
    verifyModelUse: input => governor.verifyModelUse(input), verifySchedulingUse: (input, pending) => governor.verifySchedulingUse(input, pending),
    reserveModelRequest: input => governor.reserveModelRequest(input), readWorkingContext: input => contexts.get(input), verifyWorkingContext: input => contexts.verify(input),
    tools: definitions.map(tool => ({ name: tool.name, description: tool.description, effect: tool.effect, executionMode: tool.executionMode,
      inputSchema: { ...toPiParameters(tool.inputSchema) } })), approvalWait: wait,
    executeTool: async input => { const { workId, sessionId, itemId, attemptId, requestId } = input;
      const linked = await observer.reconcile({ workId, sessionId, itemId, attemptId, requestId }); return linked.ok ? bridge.executeTool(input) : linked; },
    readToolResult: input => bridge.readToolResult(input), onToolFeedback: input => bridge.onToolFeedback(input), onChanged: () => coordinator?.wake() };
  const errors: string[] = [];
  const cloudStore = cloudMode ? need(await openCloudRuntimeStore(mkdtempSync(join(tmpdir(), 'flowmate-item-cloud-')))) : null;
  const binding = { workspaceId, cloudRuntimeId, workId: f.created.workId, sessionId: f.created.sessionId };
  const proxy = cloudMode ? new CloudDeepSeekProxy({ ledger: new CloudModelAttempts(f.database, governor, now), readApiKey: () => 'synthetic-key',
    fetch: (_url, init) => fetch(`http://127.0.0.1:${server.port}/v1/chat/completions`, init) }) : null;
  let deliveries = 0, lost: { event: CloudNativeResult; receipt: CloudNativeResultReceipt } | null = null;
  async function connect() {
    let runtime: import('@flowmate/contracts').DurableRuntimePort;
    if (cloudStore && proxy) {
      const router = createCloudRuntimeRouter({ store: cloudStore, authorize: createCloudRuntimeAuthorizer(f.database), runtimeOptions: (_binding, session) => ({
        ...runtimeOptions, readApiKey: () => undefined, cloudModel: { binding, send: async (input, signal) => {
          const linked = await observer.reconcile({ workId: input.workId, sessionId: input.sessionId, itemId: input.itemId,
            attemptId: input.attemptId, requestId: input.requestId });
          return linked.ok ? proxy.send(input, signal) : linked;
        } }, onNativeResult: async event => {
          const saved = await session.enqueueResult(event); if (!saved.ok) return saved;
          const receipt = await new CloudNativeResultReceiver(f.database, runtime, now).receive(event);
          if (receipt.ok) {
            if (mode === 'cloud-lost' && event.itemId === f.itemId && !lost) {
              lost = { event, receipt: receipt.data }; return fail(appError('operation_result_unknown', 'runtime', 'Controlled lost receipt.', true));
            }
            deliveries++; return session.acknowledgeResult(event, receipt.data);
          }
          return receipt;
        } }) });
      runtime = router;
    } else runtime = need(await createDurableRuntime({ ...runtimeOptions, storage: await createDurableSqliteStorage(f.database.coordinator) }));
    observer = new InvoiceWorkPhaseObserver({ database: f.database, runtime, now });
    const models = new InvoiceWorkModelService({ database: f.database, runtime, now, resolveConfiguration: () => ok(provider) });
    tasks = new PersonalTasksService({ database: f.database, runtime, phaseObserver: observer, now,
      verifyModelUse: input => governor.verifyModelUse(input), restoreAttempt: async () => ok(undefined), onChanged: () => coordinator?.wake() });
    coordinator = new InvoiceWorkCoordinator({ database: f.database, runtime, modelService: models, contexts, phaseObserver: observer, governor,
      tasks, now, sdk: f.config.sdk, runtimeScope: cloudMode ? 'cloud' : 'local', verifyResources: () => ok(undefined), onError: error => errors.push(error.code) });
    return runtime;
  }
  let runtime = await connect();
  const root = need(await runtime.openConversation({ workId: f.created.workId, sessionId: f.created.sessionId }));
  need(await f.database.transaction(scope => scope.sessions.bindDurableConversation(f.created.sessionId, root.nativeConversationId, now())));
  try {
    coordinator.wake();
    await waitFor(async () => {
      const rows = await f.database.read(scope => scope.db.query<{ item_id: number; scheduler_state: string; closed_at: string | null }, [number]>(
        'SELECT item_id,scheduler_state,closed_at FROM invoice_work_phases WHERE work_id=? ORDER BY id').all(f.created.workId));
      return rows.some(row => row.item_id === f.itemId && row.scheduler_state === 'waiting_approval')
        && rows.some(row => row.item_id !== f.itemId && row.closed_at !== null);
    }, 5_000);
    const page = need(await f.database.read(scope => scope.invoiceWorks.get({ view: 'work', workId: f.created.workId })));
    const proposal = kind === 'browser' ? need(await f.database.read(scope => scope.invoiceWorkBrowserReads.list({ workId: f.created.workId, itemId: f.itemId, limit: 20 }))).items[0]!
      : need(await f.database.read(scope => scope.invoiceWorkDesktopActions.list({ workId: f.created.workId, itemId: f.itemId, limit: 20 }))).items[0]!;
    expect(proposal).toMatchObject({ status: 'waiting', canDecide: true }); expect(reads).toBe(0);
    if (mode === 'revoked' || mode === 'cloud-revoked') {
      await f.database.transaction(scope => scope.db.query('UPDATE sessions SET metadata_json=? WHERE id=?').run(
        JSON.stringify({ version: 1, model_use_blocked: { documentIds: [1], at: now(), reason: 'document_use_revoked' } }), f.created.sessionId));
      coordinator.wake();
      await waitFor(async () => {
        const task = await f.database.read(scope => scope.invoiceWorkAttempts.get({ workId: f.created.workId, attemptId: f.attemptId }));
        return task.ok && task.data.task.stoppedAt !== null;
      }, 3000);
      expect(need(await f.database.read(scope => scope.runs.get(f.runId)))).toMatchObject({ status: 'failed', error: { code: 'session_scope_revoked' } });
      const late = { workId: f.created.workId, itemId: f.itemId, proposalId: proposal.proposalId,
        expectedRevision: page.work.revision, requestId: 'revoked-approval', decision: 'approve' as const };
      const result = kind === 'browser' ? await f.database.transaction(scope => scope.invoiceWorkBrowserReads.decide({ ...late, confirmedTarget: target }, now()))
        : await f.database.transaction(scope => scope.invoiceWorkDesktopActions.decide({ ...late, confirmedTarget: desktopTarget, confirmedAction: action }, now()));
      expect(result).toMatchObject({ ok: false });
      expect(reads).toBe(0); return;
    }
    if (mode === 'stop') {
      const stopped = need(await tasks.stop({ workId: f.created.workId, attemptId: f.attemptId,
        expectedRevision: page.work.revision, requestId: 'stop-original-attempt' }));
      expect(stopped).toMatchObject({ accepted: true });
      await waitFor(async () => (await f.database.read(scope => scope.invoiceWorkAttempts.get({ workId: f.created.workId, attemptId: f.attemptId })))
        .ok && need(await f.database.read(scope => scope.invoiceWorkAttempts.get({ workId: f.created.workId, attemptId: f.attemptId }))).task.stoppedAt !== null, 5_000);
      const late = { workId: f.created.workId, itemId: f.itemId, proposalId: proposal.proposalId,
        expectedRevision: page.work.revision, requestId: 'late-approval', decision: 'approve' as const };
      const result = kind === 'browser' ? await f.database.transaction(scope => scope.invoiceWorkBrowserReads.decide({ ...late, confirmedTarget: target }, now()))
        : await f.database.transaction(scope => scope.invoiceWorkDesktopActions.decide({ ...late, confirmedTarget: desktopTarget, confirmedAction: action }, now()));
      expect(result).toMatchObject({ ok: false });
      expect(reads).toBe(0); return;
    }
    if (mode === 'timeout') {
      await waitFor(async () => {
        const task = await f.database.read(scope => scope.invoiceWorkAttempts.get({ workId: f.created.workId, attemptId: f.attemptId }));
        return task.ok && task.data.task.stoppedAt !== null;
      }, 7_000);
      const late = { workId: f.created.workId, itemId: f.itemId, proposalId: proposal.proposalId,
        expectedRevision: page.work.revision, requestId: 'late-timeout-approval', decision: 'approve' as const };
      const result = kind === 'browser' ? await f.database.transaction(scope => scope.invoiceWorkBrowserReads.decide({ ...late, confirmedTarget: target }, now()))
        : await f.database.transaction(scope => scope.invoiceWorkDesktopActions.decide({ ...late, confirmedTarget: desktopTarget, confirmedAction: action }, now()));
      expect(result).toMatchObject({ ok: false });
      expect(reads).toBe(0); return;
    }
    if (mode === 'restart' || mode === 'cloud-restart') {
      if (!waitIdentity) throw Error('Original approval task was not entered.');
      const owner = { workId: waitIdentity.workId, sessionId: waitIdentity.sessionId, attemptId: waitIdentity.attemptId };
      const pending = { ...owner, itemId: waitIdentity.itemId, requestId: waitIdentity.requestId, nativeConversationId: waitIdentity.nativeConversationId,
        nativeTaskId: waitIdentity.nativeTaskId, nativeToolCallId: 'original-browser', name: kind === 'browser' ? 'browser_request_read' : 'desktop_propose_action',
        arguments: kind === 'browser' ? {} : action };
      expect(await governor.verifyModelUse(owner)).toMatchObject({ ok: false, error: { code: 'invoice_work_admission_waiting' } });
      expect(await governor.verifySchedulingUse(owner, [])).toMatchObject({ ok: false });
      expect(await governor.verifySchedulingUse(owner, [pending])).toMatchObject({ ok: true });
      expect(await governor.verifySchedulingUse(owner, [{ ...pending, itemId: f.itemId + 1 }])).toMatchObject({ ok: false });
      const before = waitEntries;
      const stopping = coordinator.close(); need(await runtime.close()); need(await stopping);
      runtime = await connect(); need(await coordinator.recover());
      const recovered = kind === 'browser' ? await f.database.read(scope => scope.invoiceWorkBrowserReads.get({ workId: f.created.workId, itemId: f.itemId, proposalId: proposal.proposalId }))
        : await f.database.read(scope => scope.invoiceWorkDesktopActions.get({ workId: f.created.workId, itemId: f.itemId, proposalId: proposal.proposalId }));
      expect(recovered).toMatchObject({ ok: true, data: { status: 'waiting', canDecide: true } });
      await waitFor(async () => waitEntries > before, 2000);
    }
    const decision = { workId: f.created.workId, itemId: f.itemId, proposalId: proposal.proposalId,
      expectedRevision: page.work.revision, requestId: 'original-approval', decision: mode.startsWith('twice-reject') ? 'reject' as const : 'approve' as const };
    const transaction = f.database.transaction;
    let projectionFailed = false;
    if (mode === 'projection-loss') f.database.transaction = operation => transaction(scope => operation({ ...scope, invoiceWorks: { ...scope.invoiceWorks,
      replaceTodos: input => input.itemId === f.itemId ? (projectionFailed = true, fail(appError('storage_write_failed', 'storage', 'Controlled projection outage.')))
        : scope.invoiceWorks.replaceTodos(input) } }));
    if (kind === 'browser') need(await f.database.transaction(scope => scope.invoiceWorkBrowserReads.decide({ ...decision, confirmedTarget: target }, now())));
    else need(await f.database.transaction(scope => scope.invoiceWorkDesktopActions.decide({ ...decision, confirmedTarget: desktopTarget, confirmedAction: action }, now())));
    coordinator.wake();
    if (mode === 'projection-loss') {
      await waitFor(async () => projectionFailed && errors.includes('storage_write_failed'), 10_000);
      f.database.transaction = transaction;
      need(await coordinator.recover());
      const item = need(await f.database.read(scope => scope.invoiceWorks.get({ view: 'item', workId: f.created.workId, itemId: f.itemId })));
      expect(item.view === 'item' && item.todos.some(todo => todo.problem === 'The completed model phase saved no invoice candidate.')).toBe(true);
    }
    if (mode.startsWith('twice')) {
      await waitFor(async () => {
        const listed = kind === 'browser' ? await f.database.read(scope => scope.invoiceWorkBrowserReads.list({ workId: f.created.workId, itemId: f.itemId, limit: 20 }))
          : await f.database.read(scope => scope.invoiceWorkDesktopActions.list({ workId: f.created.workId, itemId: f.itemId, limit: 20 }));
        return listed.ok && listed.data.items.length === 2 && listed.data.items[1]!.canDecide;
      }, 10_000);
      if (mode === 'twice-restart' || mode === 'twice-reject-restart') {
        const before = waitEntries, closing = coordinator.close(); need(await runtime.close()); need(await closing);
        runtime = await connect(); need(await coordinator.recover()); await waitFor(async () => waitEntries > before, 2000);
      }
      const listed = kind === 'browser' ? need(await f.database.read(scope => scope.invoiceWorkBrowserReads.list({ workId: f.created.workId, itemId: f.itemId, limit: 20 })))
        : need(await f.database.read(scope => scope.invoiceWorkDesktopActions.list({ workId: f.created.workId, itemId: f.itemId, limit: 20 })));
      const current = need(await f.database.read(scope => scope.invoiceWorks.get({ view: 'work', workId: f.created.workId })));
      const next = { ...decision, decision: 'approve' as const, proposalId: listed.items[1]!.proposalId, expectedRevision: current.work.revision, requestId: 'second-approval' };
      if (kind === 'browser') need(await f.database.transaction(scope => scope.invoiceWorkBrowserReads.decide({ ...next, confirmedTarget: target }, now())));
      else need(await f.database.transaction(scope => scope.invoiceWorkDesktopActions.decide({ ...next, confirmedTarget: desktopTarget, confirmedAction: action }, now())));
      coordinator.wake();
    }
    if (mode === 'unknown') {
      await waitFor(async () => {
        const result = kind === 'browser' ? await f.database.read(scope => scope.invoiceWorkBrowserReads.get({ workId: f.created.workId, itemId: f.itemId, proposalId: proposal.proposalId }))
          : await f.database.read(scope => scope.invoiceWorkDesktopActions.get({ workId: f.created.workId, itemId: f.itemId, proposalId: proposal.proposalId }));
        return result.ok && result.data.status === 'unknown';
      }, 10_000);
      coordinator.wake(); coordinator.wake();
      await new Promise(resolve => setTimeout(resolve, 300));
      expect(reads).toBe(1); expect(requests.filter(id => id === f.itemId)).toHaveLength(1); return;
    }
    await waitFor(async () => (await f.database.read(scope => scope.db.query<{ closed_at: string | null }, [number]>(
      'SELECT closed_at FROM invoice_work_phases WHERE id=?').get(f.phase.phaseId)))?.closed_at !== null, 10_000);
    await waitFor(async () => (await f.database.read(scope => scope.invoiceWorkAttempts.get({ workId: f.created.workId, attemptId: f.attemptId })))
      .ok && need(await f.database.read(scope => scope.invoiceWorkAttempts.get({ workId: f.created.workId, attemptId: f.attemptId }))).task.stoppedAt !== null, 5000);
    expect(need(await f.database.read(scope => scope.runs.get(f.runId))).output).toMatchObject({ text: 'Original page reviewed.' });
    const twice = mode.startsWith('twice');
    expect(reads).toBe(twice && !mode.startsWith('twice-reject') ? 2 : 1); expect(requests.filter(id => id === f.itemId)).toHaveLength(twice ? 3 : 2);
    expect(requests.filter(id => id !== f.itemId)).toHaveLength(1);
    if (mode === 'cloud' || mode === 'cloud-restart') await waitFor(async () => deliveries >= 2, 5_000);
    if (mode === 'cloud-lost') {
      await waitFor(async () => lost !== null, 5_000);
      const original = lost! as { event: CloudNativeResult; receipt: CloudNativeResultReceipt };
      const receiver = new CloudNativeResultReceiver(f.database, runtime, now);
      expect(need(await receiver.receive(original.event))).toEqual(original.receipt);
      const session = need(await cloudStore!.openSession(binding, false));
      need(await session.acknowledgeResult(original.event, original.receipt));
      expect(await f.database.read(scope => scope.db.query('SELECT COUNT(*) count FROM cloud_native_result_receipts WHERE native_submission_id=?')
        .get(original.event.nativeSubmissionId))).toEqual({ count: 1 });
      expect(reads).toBe(1); expect(requests.filter(id => id === f.itemId)).toHaveLength(2);
    }
    expect(errors).toEqual(mode === 'projection-loss' ? ['storage_write_failed'] : []);
  } finally { const closing = coordinator.close(); need(await runtime.close()); await closing; if (cloudStore) need(await cloudStore.close());
    await f.database.close(); server.stop(true); }
}, 35_000);
