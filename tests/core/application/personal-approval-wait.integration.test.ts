import { expect, test } from 'bun:test';
import { appError, ok, type Result, type ToolResult } from '@flowmate/contracts';
import { createInvoiceWorkApprovalWait } from '../../../packages/core/src/personal-agent/approval-wait.ts';
import { InvoiceWorkPhaseContextService } from '../../../packages/core/src/personal-agent/phase-context.ts';
import { createInvoiceWorkToolBridge } from '../../../packages/core/src/personal-agent/tool-scope.ts';
import { createToolExecutor } from '../../../packages/core/src/tools/executor.ts';
import { createBrowserExecutionTool } from '../../../packages/core/src/personal-agent/browser-tools.ts';
import { createDesktopExecutionTool } from '../../../packages/core/src/personal-agent/desktop-tools.ts';
import { DurableInvoiceGovernor } from '../../../packages/core/src/personal-agent/admission.ts';
import { buildInvoiceWorkContext } from '../../../packages/runtime-durable/src/context.ts';
import { invoiceWorkToolsFixture } from '../../support/invoice-work-tools.ts';

function need<T>(value: Result<T>): T { if (!value.ok) throw Error(`${value.error.code}: ${value.error.message}`); return value.data; }
const at = '2026-10-29T00:00:00.000Z';

test.each([['browser', 'approve'], ['browser', 'reject'], ['desktop', 'approve'], ['desktop', 'reject']] as const)(
  'the original %s %s decision releases and reacquires its invoice phase', async (kind, choice) => {
  const names = kind === 'browser' ? ['browser_request_read', 'browser_read_approved'] : ['desktop_propose_action', 'desktop_execute_approved'];
  const f = await invoiceWorkToolsFixture({ itemLane: true, configuration: { modelId: 'controlled', thinkingLevel: 'off', tools: names,
    resources: { prompt: null, enabledSkills: [] }, extensions: { enabledExtensions: [] }, workingDirectory: null, preferences: '' } });
  const browserTarget = { connectionId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
    bindingId: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb', origin: 'https://example.test' };
  const desktopTarget = { connectionId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', window: { id: 42, app: 'Invoice', title: 'Draft' }, element: '[3] Save' };
  const action = { kind: 'click' as const, observationId: '84c2bb96-6c56-48e0-aab0-f49f059cb1ba', elementIndex: 3 };
  try {
    const proposalId = await f.database.transaction(scope => {
      need(scope.sessions.bindDurableConversation(f.created.sessionId, 101, at));
      need(scope.invoiceWorks.linkPhase({ workId: f.created.workId, attemptId: f.attemptId, phaseId: f.phase.phaseId,
        nativeConversationId: 102, nativeSubmissionId: 103, at }));
      const args = kind === 'browser' ? {} : action;
      const call = need(scope.toolCalls.request({ runId: f.runId, sessionId: f.created.sessionId, nativeToolCallId: 'durable-task:71',
        toolName: names[0]!, toolVersion: '1', effect: 'LOCAL_WRITE', invoiceWorkScope: f.product.scope, rawArguments: args, context: null, requestedAt: at }));
      need(scope.toolCalls.fixArguments({ toolCallId: call.toolCallId, finalArguments: args }));
      need(scope.toolCalls.start({ toolCallId: call.toolCallId, startedAt: at }));
      const proposal = kind === 'browser' ? need(scope.invoiceWorkBrowserReads.propose({ workId: f.created.workId, itemId: f.itemId,
        proposalToolCallId: call.toolCallId, target: browserTarget, at })) : need(scope.invoiceWorkDesktopActions.propose({ workId: f.created.workId,
        itemId: f.itemId, proposalToolCallId: call.toolCallId, target: desktopTarget, at }));
      need(scope.toolCalls.finish({ toolCallId: call.toolCallId, result: { version: 1, committedCandidateId: null,
        status: 'succeeded', data: { proposalId: proposal.proposalId } },
        cleanup: { version: 1, stopped: true, stopReason: 'tool-completed', errors: [] }, endedAt: at, stoppedAt: at }));
      return proposal.proposalId;
    });
    const identity = { workId: f.created.workId, sessionId: f.created.sessionId, attemptId: f.attemptId, phaseId: f.phase.phaseId,
      requestId: f.phase.requestId, itemId: f.itemId, nativeConversationId: 102, nativeTaskId: 71, proposalId, kind };
    const waits = createInvoiceWorkApprovalWait({ database: f.database, now: () => at });
    const governor = new DurableInvoiceGovernor(f.database, () => at, () => false);
    expect(await waits.begin({ ...identity, nativeTaskId: 72 })).toMatchObject({ ok: false });
    expect(need(await waits.begin(identity))).toMatchObject({ status: 'waiting', scheduling: 'waiting_approval' });
    expect(need(await waits.begin(identity))).toMatchObject({ status: 'waiting', scheduling: 'waiting_approval' });
    const proposalView = await f.database.read(scope => kind === 'browser'
      ? scope.invoiceWorkBrowserReads.get({ workId: identity.workId, itemId: identity.itemId, proposalId })
      : scope.invoiceWorkDesktopActions.get({ workId: identity.workId, itemId: identity.itemId, proposalId }));
    expect(proposalView).toMatchObject({ ok: true, data: { canDecide: true, resumeOriginal: true } });
    expect(await governor.remainingBudget(f.created.workId)).toMatchObject({ ok: true });
    const workPage = need(await f.database.read(scope => scope.invoiceWorks.get({ view: 'work', workId: f.created.workId })));
    if (workPage.view !== 'work' || !workPage.items[1]) throw Error('Second invoice missing');
    expect(workPage.items[0]).toMatchObject({ execution: { state: 'waiting_approval' } });
    expect(need(await f.database.read(scope => governor.nextItemInStore(scope, f.created.workId))).itemId).toBe(workPage.items[1].itemId);
    const second = await f.database.transaction(scope => {
      const page = need(scope.invoiceWorks.get({ view: 'work', workId: f.created.workId }));
      if (page.view !== 'work' || !page.items[1]) throw Error('Second invoice missing');
      const item = page.items[1];
      return need(scope.invoiceWorks.freezePhase({ workId: f.created.workId, attemptId: f.attemptId, itemId: item.itemId,
        requestId: 'other-invoice', kind: 'prompt', at, basis: { contextSnapshotId: null, inputIds: [], documentRefs: [item.documentRef],
          configurationRevision: 0, itemRevision: item.revision, executionMode: 'item-lane-approval-v1' } }));
    });
    const work = need(await f.database.read(scope => scope.invoiceWorks.get({ view: 'work', workId: f.created.workId })));
    const decision = { workId: f.created.workId, itemId: f.itemId, proposalId, expectedRevision: work.work.revision,
      requestId: 'original-decision', decision: choice };
    const expiredAt = '2026-10-30T00:00:00.000Z';
    const expired = { ...decision, requestId: 'expired-decision' };
    if (kind === 'browser') expect(await f.database.transaction(scope => scope.invoiceWorkBrowserReads.decide({ ...expired, confirmedTarget: browserTarget }, expiredAt))).toMatchObject({ ok: false });
    else expect(await f.database.transaction(scope => scope.invoiceWorkDesktopActions.decide({ ...expired, confirmedTarget: desktopTarget, confirmedAction: action }, expiredAt))).toMatchObject({ ok: false });
    if (kind === 'browser') need(await f.database.transaction(scope => scope.invoiceWorkBrowserReads.decide({ ...decision, confirmedTarget: browserTarget }, at)));
    else need(await f.database.transaction(scope => scope.invoiceWorkDesktopActions.decide({ ...decision, confirmedTarget: desktopTarget, confirmedAction: action }, at)));
    const status = choice === 'approve' ? 'approved' : 'rejected';
    expect(need(await waits.read(identity))).toMatchObject({ status, scheduling: 'ready' });
    expect(need(await f.database.read(scope => scope.invoiceWorks.get({ view: 'item', workId: f.created.workId, itemId: f.itemId }))))
      .toMatchObject({ item: { execution: { state: 'ready' } } });
    expect(need(await f.database.read(scope => governor.nextItemInStore(scope, f.created.workId))).itemId).toBe(second.itemId);
    expect(need(await waits.activate(identity))).toMatchObject({ activated: false });
    await f.database.transaction(scope => scope.db.query('UPDATE invoice_work_phases SET closed_at=? WHERE id=?').run(at, second.phaseId));
    expect(need(await f.database.read(scope => governor.nextItemInStore(scope, f.created.workId))).itemId).toBe(f.itemId);
    expect(need(await waits.activate(identity))).toMatchObject({ activated: true });
    expect(need(await waits.read(identity))).toMatchObject({ status, scheduling: 'active' });
    expect(await waits.read({ ...identity, itemId: f.itemId + 1 })).toMatchObject({ ok: false });
    const expiredWait = createInvoiceWorkApprovalWait({ database: f.database, now: () => expiredAt });
    expect(await expiredWait.read(identity)).toMatchObject({ ok: false, error: { code: 'agent_timeout' } });
    const contexts = new InvoiceWorkPhaseContextService({ database: f.database, now: () => at, buildContext: buildInvoiceWorkContext });
    const query = { workId: identity.workId, sessionId: identity.sessionId, attemptId: identity.attemptId,
      requestId: identity.requestId, itemId: identity.itemId };
    expect(await contexts.verify(query)).toMatchObject({ ok: true });
    let finalResult: ToolResult<unknown> = { status: 'failed', error: appError('approval_rejected', 'runtime', 'The original action was rejected by the user.') };
    let feedbackBridge = createInvoiceWorkToolBridge({ database: f.database, executor: f.executor });
    if (choice === 'approve') {
      let executions = 0;
      const page = { url: 'https://example.test/invoice', title: 'Invoice', text: 'Untrusted page', truncated: false };
      const definition = kind === 'browser' ? createBrowserExecutionTool({ database: f.database, now: () => at,
        resolveTarget: async () => ok(browserTarget), read: async () => {
          executions++; return ok(page);
        } }) : createDesktopExecutionTool({ database: f.database, now: () => at,
        resolveTarget: async () => ok(desktopTarget), dispatch: async () => { executions++; return ok(undefined); } });
      const bridge = createInvoiceWorkToolBridge({ database: f.database, executor: createToolExecutor({ database: f.database, definitions: [definition], now: () => at }) });
      feedbackBridge = bridge;
      const call = { ...query, nativeConversationId: 102, nativeTaskId: 72, parentNativeTaskId: 71,
        nativeToolCallId: 'model-call/approved-execution', name: names[1]!, arguments: kind === 'browser' ? {} : { proposalId } };
      const signal = new AbortController().signal;
      expect(await bridge.executeTool({ ...call, parentNativeTaskId: 999, signal })).toMatchObject({ ok: false });
      const { parentNativeTaskId: _parent, ...direct } = call;
      expect(await bridge.executeTool({ ...direct, signal })).toMatchObject({ ok: false });
      const executed = await bridge.executeTool({ ...call, signal });
      expect(executed).toMatchObject({ ok: true, data: { status: 'succeeded' } });
      finalResult = need(executed);
      expect(await bridge.executeTool({ ...call, signal })).toMatchObject({ ok: true, data: { status: 'succeeded' } });
      expect(executions).toBe(1);
    }
    const parent = { ...query, nativeConversationId: 102, nativeTaskId: 71, nativeToolCallId: 'model-call', name: names[0]!,
      arguments: kind === 'browser' ? {} : action };
    const feedbackJson = JSON.stringify({ role: 'toolResult', toolCallId: parent.nativeToolCallId, toolName: parent.name,
      isError: finalResult.status !== 'succeeded', content: [], details: finalResult });
    expect(await feedbackBridge.onToolFeedback({ ...parent, nativeEntryId: 301, feedbackJson })).toMatchObject({ ok: true });
    expect(await feedbackBridge.onToolFeedback({ ...parent, nativeEntryId: 301, feedbackJson })).toMatchObject({ ok: true });
    if (choice === 'approve') {
      const altered = feedbackJson.replace('succeeded', 'succeedex');
      expect(Buffer.byteLength(altered)).toBe(Buffer.byteLength(feedbackJson));
      expect(await feedbackBridge.onToolFeedback({ ...parent, nativeEntryId: 301, feedbackJson: altered })).toMatchObject({ ok: false });
    }
    expect(await governor.remainingBudget(f.created.workId)).toMatchObject({ ok: true });
    await f.database.transaction(scope => scope.db.query('UPDATE invoice_work_items SET revision=revision+1 WHERE id=?').run(f.itemId));
    expect(await contexts.verify(query)).toMatchObject({ ok: false });
    await f.database.transaction(scope => scope.db.query('UPDATE invoice_work_phases SET closed_at=? WHERE id=?').run(at, f.phase.phaseId));
    expect(await governor.remainingBudget(f.created.workId)).toMatchObject({ ok: true });
  } finally { await f.database.close(); }
});
