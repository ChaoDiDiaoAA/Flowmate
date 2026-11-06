import { expect, test } from 'bun:test';
import { Database } from 'bun:sqlite';
import { buildInvoiceWorkContext } from '../../../packages/runtime-durable/src/context.ts';
import { createInvoiceWorkToolBridge, readInvoiceWorkToolResult, resolveInvoiceWorkToolScope } from '../../../packages/core/src/personal-agent/tool-scope.ts';
import { InvoiceWorkService } from '../../../packages/core/src/personal-agent/invoice-work.ts';
import { DurableInvoiceGovernor } from '../../../packages/core/src/personal-agent/admission.ts';
import { createToolExecutor } from '../../../packages/core/src/tools/executor.ts';
import { openTestDatabase } from '../../support/database.ts';
import { invoiceWorkToolsFixture } from '../../support/invoice-work-tools.ts';
import { appError, fail, ok, type Result, type RunScope } from '@flowmate/contracts';

const at = '2026-11-06T00:00:00.000Z';
const proposal = { kind: 'click', observationId: '84c2bb96-6c56-48e0-aab0-f49f059cb1ba', elementIndex: 3 } as const;
const target = { connectionId: 'b46d9019-f9b0-4cbc-8ccb-a0dd2187a1aa',
  window: { id: 42, app: 'Invoice example', title: 'Draft invoice' }, element: '[3] Submit' };
function need<T>(result: Result<T>): T { if (!result.ok) throw Error(result.error.code); return result.data; }

test.each(['success', 'registration failure'] as const)('schema24 migration preserves existing invoice and AgentSession history on %s', async mode => {
  const f = await invoiceWorkToolsFixture();
  const history = { storageVersion: 1 as const,
    header: { type: 'session' as const, version: 3, id: 'schema24-agent-session', timestamp: at, cwd: f.paths.runtimeDir },
    entries: [{ type: 'message', id: 'schema24-user', parentId: null, timestamp: at,
      message: { role: 'user', content: 'Original AgentSession input.', timestamp: 1 } }],
    leafId: 'schema24-user', unusable: false };
  const session = need(await f.database.transaction(scope => scope.sessions.create({ nativeSessionId: history.header.id,
    title: 'Original AgentSession', at, nativeHistory: history })));
  const before = await f.database.read(scope => ({ works: scope.db.query('SELECT * FROM invoice_works').all(),
    items: scope.db.query('SELECT * FROM invoice_work_items').all(),
    session: scope.db.query('SELECT * FROM sessions WHERE id=?').get(session.sessionId),
    history: scope.db.query('SELECT * FROM session_native_history WHERE session_id=?').get(session.sessionId),
    entries: scope.db.query('SELECT * FROM session_native_entries WHERE session_id=? ORDER BY sequence').all(session.sessionId) }));
  await f.database.close();
  const old = new Database(f.paths.databaseFile);
  old.exec(`DROP TRIGGER invoice_work_desktop_action_immutable; DROP TRIGGER invoice_work_desktop_action_preserved;
    DROP TABLE invoice_work_desktop_actions; DELETE FROM schema_migrations WHERE version=24;`);
  if (mode === 'registration failure') old.exec("CREATE TRIGGER reject_schema24 BEFORE INSERT ON schema_migrations WHEN NEW.version=24 BEGIN SELECT RAISE(ABORT,'controlled schema24 failure'); END");
  old.close();
  const opened = openTestDatabase(f.paths);
  if (mode === 'registration failure') {
    expect(opened).toMatchObject({ ok: false, error: { code: 'storage_open_failed' } });
    const after = new Database(f.paths.databaseFile, { readonly: true });
    try {
      expect(after.query('SELECT max(version) version FROM schema_migrations').get()).toEqual({ version: 23 });
      expect(after.query("SELECT name FROM sqlite_master WHERE name='invoice_work_desktop_actions'").get()).toBeNull();
      expect(after.query('SELECT * FROM invoice_works').all()).toEqual(before.works);
      expect(after.query('SELECT * FROM invoice_work_items').all()).toEqual(before.items);
      expect(after.query('SELECT * FROM sessions WHERE id=?').get(session.sessionId)).toEqual(before.session);
      expect(after.query('SELECT * FROM session_native_history WHERE session_id=?').get(session.sessionId)).toEqual(before.history);
      expect(after.query('SELECT * FROM session_native_entries WHERE session_id=? ORDER BY sequence').all(session.sessionId)).toEqual(before.entries);
    } finally { after.close(); }
  } else {
    const current = need(opened);
    expect(await current.read(scope => scope.db.query('SELECT max(version) version FROM schema_migrations').get())).toEqual({ version: 24 });
    expect(await current.read(scope => scope.db.query('SELECT * FROM invoice_works').all())).toEqual(before.works);
    expect(await current.read(scope => scope.db.query('SELECT * FROM invoice_work_items').all())).toEqual(before.items);
    expect(await current.read(scope => scope.sessions.get(session.sessionId))).toMatchObject({ ok: true,
      data: { runtimeKind: 'agent_session', nativeSessionId: history.header.id, title: 'Original AgentSession' } });
    expect(await current.read(scope => scope.sessions.loadHistory(session.sessionId))).toEqual(ok(history));
    expect(await current.read(scope => scope.db.query('PRAGMA foreign_key_check').all())).toEqual([]);
    await current.close();
  }
});

test('the product database exposes desktop-action queries through its scoped store', async () => {
  const f = await invoiceWorkToolsFixture();
  const result = await f.database.read(scope => scope.invoiceWorkDesktopActions.get({
    workId: f.created.workId, itemId: f.itemId, proposalId: 123,
  }));
  expect(result).toMatchObject({ ok: false, error: { code: 'desktop_action_not_found' } });
  const cloud = new InvoiceWorkService({ database: f.database, now: () => at, cloudWorkspaceId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
    assessExecution: () => ok({ kind: 'queued' }), onChanged: () => {} });
  expect(await cloud.listDesktopActions({ workId: f.created.workId, itemId: f.itemId }))
    .toMatchObject({ ok: false, error: { code: 'cloud_workspace_forbidden' } });
});

test('cloud desktop actions belong only to their original cloud workspace', async () => {
  const workspaceId = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
  const f = await invoiceWorkToolsFixture({ at, durableRuntimeId: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb', configuration: {
    modelId: 'desktop-model', thinkingLevel: 'off', tools: ['desktop_propose_action'], resources: { prompt: null, enabledSkills: [] },
    extensions: { enabledExtensions: [] }, workingDirectory: null, preferences: '' } });
  const saved = await f.database.transaction(scope => {
    const call = need(scope.toolCalls.request({ context: null, invoiceWorkScope: f.product.scope, runId: f.runId,
      sessionId: f.created.sessionId, nativeToolCallId: 'durable-task:301', toolName: 'desktop_propose_action',
      toolVersion: '1', effect: 'LOCAL_WRITE', rawArguments: proposal, requestedAt: at }));
    need(scope.toolCalls.fixArguments({ toolCallId: call.toolCallId, finalArguments: proposal }));
    need(scope.toolCalls.start({ toolCallId: call.toolCallId, startedAt: at }));
    return scope.invoiceWorkDesktopActions.propose({ workId: f.created.workId, itemId: f.itemId, proposalToolCallId: call.toolCallId, target, at });
  });
  expect(saved).toMatchObject({ ok: true, data: { status: 'waiting', workId: f.created.workId, itemId: f.itemId } });
  const service = (id: string) => new InvoiceWorkService({ database: f.database, now: () => at, cloudWorkspaceId: id,
    assessExecution: () => ok({ kind: 'queued' }), onChanged: () => {} });
  expect(await service(workspaceId).listDesktopActions({ workId: f.created.workId, itemId: f.itemId }))
    .toMatchObject({ ok: true, data: { items: [{ status: 'waiting' }] } });
  expect(await service('cccccccc-cccc-4ccc-8ccc-cccccccccccc').listDesktopActions({ workId: f.created.workId, itemId: f.itemId }))
    .toMatchObject({ ok: false, error: { code: 'cloud_workspace_forbidden' } });
});

test('a proposal whose original tool failed can be discarded but never approved', async () => {
  const f = await invoiceWorkToolsFixture({ at, configuration: { modelId: 'desktop-model', thinkingLevel: 'off',
    tools: ['desktop_propose_action'], resources: { prompt: null, enabledSkills: [] }, extensions: { enabledExtensions: [] },
    workingDirectory: null, preferences: '' } });
  const action = await f.database.transaction(scope => {
    const call = need(scope.toolCalls.request({ context: null, invoiceWorkScope: f.product.scope, runId: f.runId,
      sessionId: f.created.sessionId, nativeToolCallId: 'durable-task:301', toolName: 'desktop_propose_action',
      toolVersion: '1', effect: 'LOCAL_WRITE', rawArguments: proposal, requestedAt: at }));
    need(scope.toolCalls.fixArguments({ toolCallId: call.toolCallId, finalArguments: proposal }));
    need(scope.toolCalls.start({ toolCallId: call.toolCallId, startedAt: at }));
    const saved = need(scope.invoiceWorkDesktopActions.propose({ workId: f.created.workId, itemId: f.itemId,
      proposalToolCallId: call.toolCallId, target, at }));
    need(scope.toolCalls.finish({ toolCallId: call.toolCallId, result: { version: 1, committedCandidateId: null, status: 'failed',
      error: { version: 1, code: 'tool_execution_failed', category: 'tool', message: 'The proposal result was lost.', retryable: false } },
      cleanup: { version: 1, stopped: true, stopReason: 'tool-completed', errors: [] }, endedAt: at, stoppedAt: at }));
    scope.db.query('UPDATE invoice_work_phases SET closed_at=? WHERE id=?').run(at, f.phase.phaseId);
    return saved;
  });
  expect(need(await f.database.read(scope => scope.invoiceWorkDesktopActions.get({ workId: f.created.workId, itemId: f.itemId,
    proposalId: action.proposalId })))).toMatchObject({ canDecide: false, canReject: true });
  const work = need(await f.database.read(scope => scope.invoiceWorks.get({ view: 'work', workId: f.created.workId })));
  const decision = { workId: f.created.workId, itemId: f.itemId, proposalId: action.proposalId,
    expectedRevision: work.work.revision, requestId: 'discard-failed-proposal' };
  expect(await f.database.transaction(scope => scope.invoiceWorkDesktopActions.decide({ ...decision, decision: 'approve' }, at))).toMatchObject({ ok: false });
  expect(await f.database.transaction(scope => scope.invoiceWorkDesktopActions.decide({ ...decision, decision: 'reject' }, at)))
    .toMatchObject({ ok: true, data: { decision: 'reject' } });
});

test.each(['unknown receipt', 'interrupted claim', 'conflicting approval', 'conflicting continuation', 'altered target', 'rejected decision',
  'tool dispatch', 'stale tool target', 'stale target error', 'cancel before claim', 'uncertain tool dispatch', 'stale invoice', 'stale after approval'] as const)(
  'a desktop action is claimed once after approval and remains unknown after %s', async outcome => {
  const f = await invoiceWorkToolsFixture({ at, configuration: { modelId: 'desktop-model', thinkingLevel: 'off',
    tools: ['desktop_list_windows', 'desktop_observe_window', 'desktop_propose_action', 'desktop_execute_approved'],
    resources: { prompt: null, enabledSkills: [] }, extensions: { enabledExtensions: [] }, workingDirectory: null, preferences: '' } });

  const createCall = (scope: Parameters<Parameters<typeof f.database.transaction>[0]>[0], name: string,
    rawArguments: unknown, nativeToolCallId: string, runScope: RunScope) => {
    const call = need(scope.toolCalls.request({ context: null, invoiceWorkScope: runScope, runId: f.runId,
      sessionId: f.created.sessionId, nativeToolCallId, toolName: name, toolVersion: '1', effect: 'LOCAL_WRITE', rawArguments, requestedAt: at }));
    need(scope.toolCalls.fixArguments({ toolCallId: call.toolCallId, finalArguments: rawArguments }));
    return need(scope.toolCalls.start({ toolCallId: call.toolCallId, startedAt: at }));
  };
  const original = await f.database.transaction(scope => createCall(scope, 'desktop_propose_action', proposal, 'durable-task:201', f.product.scope));
  const created = need(await f.database.transaction(scope => scope.invoiceWorkDesktopActions.propose({ workId: f.created.workId, itemId: f.itemId,
    proposalToolCallId: original.toolCallId, target, at })));
  expect(created).toMatchObject({ workId: f.created.workId, itemId: f.itemId, status: 'waiting', canDecide: false, target });
  const duplicate = await f.database.transaction(scope => createCall(scope, 'desktop_propose_action', proposal, 'durable-task:199', f.product.scope));
  expect(await f.database.transaction(scope => scope.invoiceWorkDesktopActions.propose({ workId: f.created.workId, itemId: f.itemId,
    proposalToolCallId: duplicate.toolCallId, target, at }))).toMatchObject({ ok: false, error: { code: 'state_conflict' } });
  const listed = await f.database.read(scope => scope.invoiceWorkDesktopActions.list({
    workId: f.created.workId, itemId: f.itemId, limit: 1,
  }));
  expect(listed).toMatchObject({ ok: true, data: { items: [{ proposalId: created.proposalId }], nextAfterProposalId: null } });
  const premature = await f.database.transaction(scope => createCall(scope, 'desktop_execute_approved',
    { proposalId: created.proposalId }, 'durable-task:200', f.product.scope));
  expect(await f.database.transaction(scope => scope.invoiceWorkDesktopActions.claim({ workId: f.created.workId, itemId: f.itemId,
    proposalId: created.proposalId, executionToolCallId: premature.toolCallId, at }))).toMatchObject({ ok: false });
  const work = need(await f.database.read(scope => scope.invoiceWorks.get({ view: 'work', workId: f.created.workId })));
  const decision = { workId: f.created.workId, itemId: f.itemId, proposalId: created.proposalId,
    expectedRevision: work.work.revision, requestId: 'approve-once', decision: 'approve' as const, confirmedAction: proposal, confirmedTarget: target };
  expect(await f.database.transaction(scope => scope.invoiceWorkDesktopActions.decide(decision, at))).toMatchObject({ ok: false });

  await f.database.transaction(scope => {
    need(scope.toolCalls.finish({ toolCallId: duplicate.toolCallId,
      result: { version: 1, committedCandidateId: null, status: 'failed', error: { version: 1, code: 'state_conflict',
        category: 'input', message: 'Another action awaits a decision.', retryable: false } },
      cleanup: { version: 1, stopped: true, stopReason: 'tool-completed', errors: [] }, endedAt: at, stoppedAt: at }));
    need(scope.toolCalls.finish({ toolCallId: premature.toolCallId,
      result: { version: 1, committedCandidateId: null, status: 'failed', error: { version: 1, code: 'approval_required',
        category: 'tool', message: 'The action has not been approved.', retryable: false } },
      cleanup: { version: 1, stopped: true, stopReason: 'tool-completed', errors: [] }, endedAt: at, stoppedAt: at }));
    need(scope.toolCalls.finish({ toolCallId: original.toolCallId,
      result: { version: 1, committedCandidateId: null, status: 'succeeded', data: { proposalId: created.proposalId } },
      cleanup: { version: 1, stopped: true, stopReason: 'tool-completed', errors: [] }, endedAt: at, stoppedAt: at }));
    need(scope.invoiceWorks.linkPhase({ workId: f.created.workId, attemptId: f.attemptId, phaseId: f.phase.phaseId,
      nativeConversationId: 101, nativeSubmissionId: 201, at }));
    scope.db.query('UPDATE invoice_work_tool_calls SET feedback_native_entry_id=?,feedback_bytes=? WHERE tool_call_id=?')
      .run(301, 100, original.toolCallId);
    scope.db.query('UPDATE invoice_work_tool_calls SET feedback_native_entry_id=?,feedback_bytes=? WHERE tool_call_id=?')
      .run(302, 100, premature.toolCallId);
    scope.db.query('UPDATE invoice_work_tool_calls SET feedback_native_entry_id=?,feedback_bytes=? WHERE tool_call_id=?')
      .run(303, 100, duplicate.toolCallId);
    scope.db.query('UPDATE invoice_work_phases SET closed_at=? WHERE id=?').run(at, f.phase.phaseId);
  });
  expect(need(await f.database.read(scope => scope.invoiceWorkDesktopActions.get({ workId: f.created.workId,
    itemId: f.itemId, proposalId: created.proposalId })))).toMatchObject({ status: 'waiting', canDecide: true });
  const otherItem = work.view === 'work' ? work.items.find(item => item.itemId !== f.itemId)?.itemId : undefined;
  expect(otherItem).toBeDefined();
  const governor = new DurableInvoiceGovernor(f.database, () => at, () => false);
  expect(await f.database.transaction(scope => governor.nextItemInStore(scope, f.created.workId)))
    .toMatchObject({ ok: true, data: { admission: { kind: 'ready' }, itemId: otherItem } });
  expect(await f.database.transaction(scope => scope.invoiceWorkDesktopActions.decide({ ...decision, expectedRevision: decision.expectedRevision + 1 }, at)))
    .toMatchObject({ ok: false, error: { code: 'state_conflict' } });
  let notified = 0;
  const service = new InvoiceWorkService({ database: f.database, now: () => at,
    assessExecution: command => governor.assess(command), onChanged: () => {}, onDesktopChanged: () => { notified++; } });
  if (outcome === 'stale invoice') {
    await f.database.transaction(scope => scope.db.query('UPDATE invoice_work_items SET revision=revision+1 WHERE work_id=? AND id=?')
      .run(f.created.workId, f.itemId));
    expect(need(await f.database.read(scope => scope.invoiceWorkDesktopActions.get({ workId: f.created.workId,
      itemId: f.itemId, proposalId: created.proposalId })))).toMatchObject({ canDecide: false, canReject: true });
    expect(await service.decideDesktopAction(decision)).toMatchObject({ ok: false, error: { code: 'state_conflict' } });
    expect(await service.decideDesktopAction({ ...decision, decision: 'reject' })).toMatchObject({ ok: true, data: { decision: 'reject' } });
    return;
  }
  if (outcome === 'rejected decision') {
    const rejected = need(await service.decideDesktopAction({ ...decision, decision: 'reject' }));
    expect(await f.database.transaction(scope => governor.nextItemInStore(scope, f.created.workId)))
      .toMatchObject({ ok: true, data: { admission: { kind: 'ready' }, itemId: otherItem } });
    const continued = need(await service.continueWork({ workId: f.created.workId, expectedRevision: rejected.revision,
      expectedAttemptId: f.attemptId, requestId: 'continue-after-rejection' }));
    expect(continued.execution).toMatchObject({ authorizationAccepted: true });
    expect(await f.database.transaction(scope => governor.nextItemInStore(scope, f.created.workId)))
      .toMatchObject({ ok: true, data: { admission: { kind: 'ready' }, itemId: f.itemId } });
    await f.database.transaction(scope => {
      const selected = need(scope.invoiceWorks.selectPhaseInput({ workId: f.created.workId, itemId: f.itemId, attemptId: f.attemptId }));
      expect(Reflect.get(selected.basis, 'desktopRejectedProposalId')).toBe(created.proposalId);
      const successor = need(scope.invoiceWorks.freezePhase({ workId: f.created.workId, itemId: f.itemId, attemptId: f.attemptId,
        requestId: 'rejection-successor', kind: 'prompt', basis: selected.basis, at }));
      scope.db.query('UPDATE invoice_work_phases SET closed_at=? WHERE id=?').run(at, successor.phaseId);
      const current = need(scope.invoiceWorks.get({ view: 'item', workId: f.created.workId, itemId: f.itemId }));
      if (current.view !== 'item') throw Error('invoice item unavailable');
      need(scope.invoiceWorks.replaceTodos({ workId: f.created.workId, itemId: f.itemId, expectedRevision: current.item.revision, at,
        todos: [{ actor: 'user', action: 'review', fieldPath: null, problem: 'Review this invoice.', needed: 'Human review.',
          satisfiedBy: 'An explicit decision.', basis: { origin: 'rule', documentRefs: [current.item.documentRef], sourceRefs: [], inputIds: [], candidateRef: null } }] }));
    });
    expect(await f.database.transaction(scope => governor.nextItemInStore(scope, f.created.workId)))
      .toMatchObject({ ok: true, data: { admission: { kind: 'ready' }, itemId: otherItem } });
    await f.database.transaction(scope => scope.db.query(`INSERT INTO invoice_work_desktop_actions(work_id,item_id,item_revision,proposal_tool_call_id,target_json,status,created_at,updated_at)
      VALUES(?,?,?,?,?,'invalidated',?,?)`).run(f.created.workId, f.itemId, 1, duplicate.toolCallId, JSON.stringify(target), at, at));
    expect(await f.database.transaction(scope => governor.nextItemInStore(scope, f.created.workId)))
      .toMatchObject({ ok: true, data: { admission: { kind: 'ready' }, itemId: otherItem } });
    return;
  }
  if (outcome === 'unknown receipt')
    expect(await service.decideDesktopAction({ ...decision, confirmedTarget: { ...target, window: { ...target.window, title: 'Changed' } } }))
      .toMatchObject({ ok: false, error: { code: 'state_conflict' } });
  const approved = need(await service.decideDesktopAction(decision));
  expect(approved).toMatchObject({ proposalId: created.proposalId, decision: 'approve', requestId: 'approve-once' });
  const originalItemRevision = work.view === 'work' ? work.items.find(item => item.itemId === f.itemId)?.revision : undefined;
  const afterApproval = need(await f.database.read(scope => scope.invoiceWorks.get({ view: 'item', workId: f.created.workId, itemId: f.itemId })));
  expect(afterApproval.view === 'item' && afterApproval.item.revision).toBe((originalItemRevision ?? -1) + 1);
  expect(need(await service.decideDesktopAction(decision))).toEqual(approved);
  expect(notified).toBe(1);
  expect(await f.database.transaction(scope => governor.nextItemInStore(scope, f.created.workId)))
    .toMatchObject({ ok: true, data: { admission: { kind: 'ready' }, itemId: otherItem } });
  const recovered = await service.queryDesktopDecision({
    workId: decision.workId, itemId: decision.itemId, proposalId: decision.proposalId, requestId: decision.requestId,
  });
  expect(recovered).toEqual({ ok: true, data: approved });
  expect(await f.database.transaction(scope => scope.invoiceWorkDesktopActions.decide({ ...decision, decision: 'reject' }, at))).toMatchObject({ ok: false });

  const preApprovalExecution = await f.database.transaction(scope => {
    const current = need(scope.invoiceWorks.get({ view: 'item', workId: f.created.workId, itemId: f.itemId }));
    if (current.view !== 'item') throw Error('Expected the original invoice item.');
    const phase = need(scope.invoiceWorks.freezePhase({ workId: f.created.workId, attemptId: f.attemptId, itemId: f.itemId,
      requestId: 'desktop-successor', kind: 'prompt', basis: { contextSnapshotId: null, inputIds: [], documentRefs: [current.item.documentRef],
        configurationRevision: 0, itemRevision: current.item.revision }, at }));
    need(scope.invoiceWorks.linkPhase({ workId: f.created.workId, attemptId: f.attemptId, phaseId: phase.phaseId,
      nativeConversationId: 101, nativeSubmissionId: 202, at }));
    const context = need(buildInvoiceWorkContext(need(scope.invoiceWorks.readContextInput({ workId: f.created.workId, attemptId: f.attemptId,
      requestId: phase.requestId, remainingBudget: { modelCalls: 12, toolCalls: 24, toolFeedbackBytes: 65536, timeoutMs: 30000, childSlots: 1 } }))));
    need(scope.invoiceWorkContexts.save({ context, at }));
    const resolved = need(resolveInvoiceWorkToolScope(scope.db, { runId: f.runId, sessionId: f.created.sessionId,
      workId: f.created.workId, attemptId: f.attemptId, requestId: phase.requestId }));
    return { call: createCall(scope, 'desktop_execute_approved', { proposalId: created.proposalId }, 'durable-task:202', resolved.scope), scope: resolved.scope };
  });
  const preApprovalClaim = { workId: f.created.workId, itemId: f.itemId, proposalId: created.proposalId, executionToolCallId: preApprovalExecution.call.toolCallId, at };
  expect(await f.database.transaction(scope => scope.invoiceWorkDesktopActions.claim(preApprovalClaim))).toMatchObject({ ok: false });
  const continuation = need(await service.continueWork({ workId: f.created.workId, expectedRevision: approved.revision,
    expectedAttemptId: f.attemptId, requestId: 'continue-approved-action' }));
  expect(continuation.execution).toMatchObject({ authorizationAccepted: true, attempt: { attemptId: f.attemptId } });
  const selectedPhase = need(await f.database.read(scope => scope.invoiceWorks.selectPhaseInput({
    workId: f.created.workId, attemptId: f.attemptId, itemId: f.itemId,
  })));
  expect(Reflect.get(selectedPhase.basis, 'desktopProposalId')).toBe(created.proposalId);
  expect(await f.database.transaction(scope => scope.invoiceWorkDesktopActions.claim(preApprovalClaim)))
    .toMatchObject({ ok: false, error: { code: 'tool_access_denied' } });
  expect(await f.database.transaction(scope => governor.nextItemInStore(scope, f.created.workId)))
    .toMatchObject({ ok: true, data: { admission: { kind: 'ready' }, itemId: f.itemId } });
  const execution = await f.database.transaction(scope => {
    need(scope.toolCalls.finish({ toolCallId: preApprovalExecution.call.toolCallId,
      result: { version: 1, committedCandidateId: null, status: 'failed', error: { version: 1, code: 'tool_access_denied',
        category: 'tool', message: 'The earlier unapproved call was not dispatched.', retryable: false } },
      cleanup: { version: 1, stopped: true, stopReason: 'tool-completed', errors: [] }, endedAt: at, stoppedAt: at }));
    scope.db.query('UPDATE invoice_work_tool_calls SET feedback_native_entry_id=?,feedback_bytes=? WHERE tool_call_id=?')
      .run(304, 100, preApprovalExecution.call.toolCallId);
    scope.db.query('UPDATE invoice_work_phases SET closed_at=? WHERE attempt_id=? AND request_id=?').run(at, f.attemptId, 'desktop-successor');
    const phase = need(scope.invoiceWorks.freezePhase({ workId: f.created.workId, attemptId: f.attemptId, itemId: f.itemId,
      requestId: 'desktop-approved', kind: 'prompt', basis: selectedPhase.basis, at }));
    need(scope.invoiceWorks.linkPhase({ workId: f.created.workId, attemptId: f.attemptId, phaseId: phase.phaseId,
      nativeConversationId: 101, nativeSubmissionId: 205, at }));
    const context = need(buildInvoiceWorkContext(need(scope.invoiceWorks.readContextInput({ workId: f.created.workId, attemptId: f.attemptId,
      requestId: phase.requestId, remainingBudget: { modelCalls: 12, toolCalls: 24, toolFeedbackBytes: 65536, timeoutMs: 30000, childSlots: 1 } }))));
    expect(context.phase.basis.desktopProposalId).toBe(created.proposalId);
    need(scope.invoiceWorkContexts.save({ context, at }));
    const resolved = need(resolveInvoiceWorkToolScope(scope.db, { runId: f.runId, sessionId: f.created.sessionId,
      workId: f.created.workId, attemptId: f.attemptId, requestId: phase.requestId }));
    return { call: createCall(scope, 'desktop_execute_approved', { proposalId: created.proposalId }, 'durable-task:204', resolved.scope), scope: resolved.scope };
  });
  const claim = { ...preApprovalClaim, executionToolCallId: execution.call.toolCallId };
  if (outcome === 'stale after approval') {
    await f.database.transaction(scope => scope.db.query('UPDATE invoice_work_items SET revision=revision+1 WHERE work_id=? AND id=?')
      .run(f.created.workId, f.itemId));
    expect(await f.database.transaction(scope => scope.invoiceWorkDesktopActions.claim(claim)))
      .toMatchObject({ ok: false, error: { code: 'desktop_item_changed' } });
    const discard = Reflect.get(service, 'discardDesktopAction');
    expect(typeof discard).toBe('function');
    if (typeof discard !== 'function') return;
    const input = { workId: f.created.workId, itemId: f.itemId, proposalId: created.proposalId };
    expect(await discard.call(service, input)).toMatchObject({ ok: true, data: { status: 'invalidated' } });
    expect(await discard.call(service, input)).toMatchObject({ ok: true, data: { status: 'invalidated' } });
    expect(await service.queryDesktopDecision({ ...input, requestId: decision.requestId })).toEqual({ ok: true, data: approved });
    return;
  }
  if (outcome === 'tool dispatch' || outcome === 'stale tool target' || outcome === 'stale target error' || outcome === 'cancel before claim' || outcome === 'uncertain tool dispatch') {
    await f.database.transaction(scope => need(scope.toolCalls.finish({ toolCallId: execution.call.toolCallId,
      result: { version: 1, committedCandidateId: null, status: 'failed', error: { version: 1, code: 'tool_access_denied',
        category: 'tool', message: 'The earlier call was not dispatched.', retryable: false } },
      cleanup: { version: 1, stopped: true, stopReason: 'tool-completed', errors: [] }, endedAt: at, stoppedAt: at })));
    const module = await import('../../../packages/core/src/personal-agent/desktop-tools.ts');
    const create = Reflect.get(module, 'createDesktopExecutionTool');
    expect(typeof create).toBe('function');
    if (typeof create !== 'function') return;
    let dispatches = 0;
    const entered = Promise.withResolvers<void>(), release = Promise.withResolvers<void>();
    const tool = create({ database: f.database, now: () => at,
      resolveTarget: async () => { if (outcome === 'cancel before claim') { entered.resolve(); await release.promise; }
        return outcome === 'stale target error' ? fail(appError('desktop_target_changed', 'runtime', 'The control changed.'))
          : ok(outcome === 'stale tool target' ? { ...target, window: { ...target.window, title: 'Changed' } } : target); },
      dispatch: async (action: unknown, actual: unknown) => { dispatches++; expect(action).toEqual(proposal); expect(actual).toEqual(target);
        if (outcome === 'uncertain tool dispatch') throw Error('The input receipt was lost.'); return ok(undefined); } });
    const executor = createToolExecutor({ database: f.database, definitions: [tool], now: () => at });
    const context = { ...f.product, scope: execution.scope, nativeToolCallId: 'durable-task:205', signal: new AbortController().signal };
    const pending = executor.execute('desktop_execute_approved', { proposalId: created.proposalId }, context);
    if (outcome === 'cancel before claim') {
      await entered.promise;
      const current = need(await service.get({ view: 'work', workId: f.created.workId }));
      need(await service.cancelWork({ workId: f.created.workId, expectedRevision: current.work.revision, requestId: 'cancel-during-desktop-check' }));
      release.resolve();
    }
    const first = await pending;
    if (outcome === 'cancel before claim') {
      expect(first.result.status).toBe('failed'); expect(dispatches).toBe(0);
      return;
    }
    if (outcome === 'stale tool target' || outcome === 'stale target error') expect(first.result).toMatchObject({ status: 'failed', error: { code: 'desktop_target_changed' } });
    else if (outcome === 'uncertain tool dispatch') expect(first.result).toMatchObject({ status: 'failed', error: { code: 'desktop_action_unconfirmed' } });
    else expect(first.result).toMatchObject({ status: 'succeeded', data: { proposalId: created.proposalId, outcome: 'dispatched' } });
    expect((await executor.execute('desktop_execute_approved', { proposalId: created.proposalId }, context)).result).toMatchObject(first.result);
    expect(dispatches).toBe(outcome === 'stale tool target' || outcome === 'stale target error' ? 0 : 1);
    expect(need(await f.database.read(scope => scope.invoiceWorkDesktopActions.get({ workId: f.created.workId,
      itemId: f.itemId, proposalId: created.proposalId })))).toMatchObject({ status: outcome === 'stale tool target' || outcome === 'stale target error' ? 'invalidated'
        : outcome === 'uncertain tool dispatch' ? 'unknown' : 'dispatched' });
    if (outcome === 'uncertain tool dispatch') {
      const original = { workId: f.created.workId, sessionId: f.created.sessionId, attemptId: f.attemptId, requestId: 'desktop-approved',
        nativeConversationId: 101, nativeTaskId: 205, nativeToolCallId: 'wire-205', name: 'desktop_execute_approved',
        arguments: { proposalId: created.proposalId } };
      expect(await f.database.read(scope => readInvoiceWorkToolResult(scope, original))).toEqual({ ok: true, data: null });
      const bridge = createInvoiceWorkToolBridge({ database: f.database, executor });
      expect(await bridge.executeTool({ ...original, signal: new AbortController().signal }))
        .toMatchObject({ ok: false, error: { code: 'tool_commit_unconfirmed' } });
      expect(dispatches).toBe(1);
    }
    return;
  }
  if (outcome === 'altered target') {
    await expect(f.database.transaction(scope => scope.db.query("UPDATE invoice_work_desktop_actions SET target_json=json_set(target_json,'$.window.title','Different window') WHERE id=?")
      .run(created.proposalId))).rejects.toThrow();
    expect(need(await f.database.read(scope => scope.invoiceWorkDesktopActions.get({ workId: f.created.workId, itemId: f.itemId,
      proposalId: created.proposalId })))).toMatchObject({ status: 'approved', target });
    return;
  }
  if (outcome === 'conflicting approval') {
    await f.database.transaction(scope => {
      scope.db.exec('DROP TRIGGER invoice_work_desktop_action_immutable');
      scope.db.query("UPDATE invoice_work_desktop_actions SET decision_request_json=json_set(decision_request_json,'$.decision','reject') WHERE id=?")
        .run(created.proposalId);
    });
    expect(await f.database.transaction(scope => scope.invoiceWorkDesktopActions.claim(claim))).toMatchObject({ ok: false });
    return;
  }
  if (outcome === 'conflicting continuation') {
    await f.database.transaction(scope => {
      scope.db.exec('DROP TRIGGER invoice_work_operation_immutable');
      scope.db.query("UPDATE invoice_work_operations SET receipt_json=json_set(receipt_json,'$.requestId','different') WHERE work_id=? AND kind='continueWork'")
        .run(f.created.workId);
    });
    expect(await f.database.transaction(scope => scope.invoiceWorkDesktopActions.claim(claim))).toMatchObject({ ok: false });
    return;
  }
  expect(need(await f.database.transaction(scope => scope.invoiceWorkDesktopActions.claim(claim)))).toMatchObject({ status: 'claimed' });
  expect(await f.database.transaction(scope => scope.invoiceWorkDesktopActions.claim(claim))).toMatchObject({ ok: false });
  if (outcome === 'unknown receipt') need(await f.database.transaction(scope => scope.invoiceWorkDesktopActions.finish({ ...claim, outcome: 'unknown' })));
  await f.database.close();
  const reopened = need(openTestDatabase(f.paths));
  expect(need(await reopened.read(scope => scope.invoiceWorkDesktopActions.get({ workId: f.created.workId, itemId: f.itemId,
    proposalId: created.proposalId })))).toMatchObject({ status: 'unknown' });
});
