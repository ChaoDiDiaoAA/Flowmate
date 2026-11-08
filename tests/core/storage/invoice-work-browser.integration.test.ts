import { expect, test } from 'bun:test';
import { Database } from 'bun:sqlite';
import { ok, type DurableRuntimePort, type Result } from '@flowmate/contracts';
import { invoiceWorkToolsFixture } from '../../support/invoice-work-tools.ts';
import { openTestDatabase, removeMemorySchemaFromFixture } from '../../support/database.ts';
import { DurableInvoiceGovernor } from '../../../packages/core/src/personal-agent/admission.ts';
import { InvoiceWorkService } from '../../../packages/core/src/personal-agent/invoice-work.ts';
import { readInvoiceWorkToolResult, resolveInvoiceWorkToolScope } from '../../../packages/core/src/personal-agent/tool-scope.ts';
import { buildInvoiceWorkContext } from '../../../packages/runtime-durable/src/context.ts';
import { createToolExecutor } from '../../../packages/core/src/tools/executor.ts';
import { createPersonalAgentRuntime } from '../../../apps/personal-agent.ts';

function need<T>(result: Result<T>): T { if (!result.ok) throw Error(result.error.code); return result.data; }

test.each([24, 27])('upgrading a schema %i database preserves Work and desktop action records', async version => {
  const at = '2026-11-06T00:00:00.000Z';
  const f = await invoiceWorkToolsFixture({ at, configuration: { modelId: null, thinkingLevel: 'off',
    tools: ['desktop_propose_action'], resources: { prompt: null, enabledSkills: [] },
    extensions: { enabledExtensions: [] }, workingDirectory: null, preferences: '' } });
  const proposal = { kind: 'click' as const, observationId: '84c2bb96-6c56-48e0-aab0-f49f059cb1ba', elementIndex: 3 };
  const target = { connectionId: 'b46d9019-f9b0-4cbc-8ccb-a0dd2187a1aa',
    window: { id: 42, app: 'Invoice example', title: 'Draft' }, element: '[3] Submit' };
  await f.database.transaction(scope => {
    const call = need(scope.toolCalls.request({ context: null, invoiceWorkScope: f.product.scope, runId: f.runId,
      sessionId: f.created.sessionId, nativeToolCallId: 'durable-task:browser-migration', toolName: 'desktop_propose_action',
      toolVersion: '1', effect: 'LOCAL_WRITE', rawArguments: proposal, requestedAt: at }));
    need(scope.toolCalls.fixArguments({ toolCallId: call.toolCallId, finalArguments: proposal }));
    need(scope.toolCalls.start({ toolCallId: call.toolCallId, startedAt: at }));
    need(scope.invoiceWorkDesktopActions.propose({ workId: f.created.workId, itemId: f.itemId, proposalToolCallId: call.toolCallId, target, at }));
  });
  const before = await f.database.read(scope => ({
    works: scope.db.query('SELECT * FROM invoice_works').all(), items: scope.db.query('SELECT * FROM invoice_work_items').all(),
    actions: scope.db.query('SELECT * FROM invoice_work_desktop_actions').all(),
  }));
  await f.database.close();
  const legacy = new Database(f.paths.databaseFile);
  if (version === 27) legacy.exec('DROP TABLE IF EXISTS personal_tool_model_sources; DROP TABLE IF EXISTS personal_model_observations; DELETE FROM schema_migrations WHERE version=30; DROP TABLE IF EXISTS invoice_work_feedback; DELETE FROM schema_migrations WHERE version=29; DROP TABLE invoice_work_peer_reviews; DELETE FROM schema_migrations WHERE version=28;');
  else {
    removeMemorySchemaFromFixture(legacy);
    legacy.exec('DROP INDEX invoice_work_phase_one_active; DROP INDEX invoice_work_phase_one_item; ALTER TABLE invoice_work_phases DROP COLUMN scheduler_state; DELETE FROM schema_migrations WHERE version=26; DROP TABLE IF EXISTS invoice_work_browser_reads; DELETE FROM schema_migrations WHERE version=25;');
  }
  legacy.close();
  const migrated = need(openTestDatabase(f.paths));
  try {
    expect(migrated.db.query('SELECT max(version) version FROM schema_migrations').get()).toEqual({ version: 30 });
    expect(migrated.db.query('SELECT * FROM invoice_works').all()).toEqual(before.works);
    expect(migrated.db.query('SELECT * FROM invoice_work_items').all()).toEqual(before.items);
    expect(migrated.db.query('SELECT * FROM invoice_work_desktop_actions').all()).toEqual(before.actions);
    expect(migrated.db.query("SELECT name FROM sqlite_master WHERE type='table' AND name='invoice_work_browser_reads'").get())
      .toEqual({ name: 'invoice_work_browser_reads' });
    expect(migrated.db.query('PRAGMA foreign_key_check').all()).toEqual([]);
  } finally { await migrated.close(); }
});

test.each(['success', 'registration failure'] as const)('item-lane migration preserves original Work and AgentSession history on %s', async mode => {
  const at = '2026-11-06T00:00:00.000Z', f = await invoiceWorkToolsFixture();
  const history = { storageVersion: 1 as const,
    header: { type: 'session' as const, version: 3, id: 'item-lane-migration-session', timestamp: at, cwd: f.paths.runtimeDir },
    entries: [{ type: 'message', id: 'item-lane-user', parentId: null, timestamp: at,
      message: { role: 'user', content: 'Original AgentSession input.', timestamp: 1 } }],
    leafId: 'item-lane-user', unusable: false };
  const session = need(await f.database.transaction(scope => scope.sessions.create({ nativeSessionId: history.header.id,
    title: 'Original AgentSession', at, nativeHistory: history })));
  const phaseColumns = 'id,work_id,attempt_id,item_id,request_id,kind,basis_json,native_conversation_id,native_submission_id,created_at,consumed_at,closed_at,durable_runtime_id';
  const before = await f.database.read(scope => ({ works: scope.db.query('SELECT * FROM invoice_works').all(),
    items: scope.db.query('SELECT * FROM invoice_work_items').all(), phases: scope.db.query(`SELECT ${phaseColumns} FROM invoice_work_phases`).all(),
    session: scope.db.query('SELECT * FROM sessions WHERE id=?').get(session.sessionId),
    history: scope.db.query('SELECT * FROM session_native_history WHERE session_id=?').get(session.sessionId),
    entries: scope.db.query('SELECT * FROM session_native_entries WHERE session_id=? ORDER BY sequence').all(session.sessionId) }));
  await f.database.close();
  const legacy = new Database(f.paths.databaseFile);
  removeMemorySchemaFromFixture(legacy);
  if (legacy.query<{ name: string }, []>('PRAGMA table_info(invoice_work_phases)').all().some(column => column.name === 'scheduler_state')) {
    legacy.exec('DROP INDEX IF EXISTS invoice_work_phase_one_active; DROP INDEX IF EXISTS invoice_work_phase_one_item; ALTER TABLE invoice_work_phases DROP COLUMN scheduler_state; DELETE FROM schema_migrations WHERE version=26;');
  }
  if (mode === 'registration failure') legacy.exec("CREATE TRIGGER reject_schema26 BEFORE INSERT ON schema_migrations WHEN NEW.version=26 BEGIN SELECT RAISE(ABORT,'controlled schema26 failure'); END");
  legacy.close();
  const opened = openTestDatabase(f.paths);
  if (mode === 'registration failure') {
    if (opened.ok) await opened.data.close();
    expect(opened).toMatchObject({ ok: false, error: { code: 'storage_open_failed' } });
    const after = new Database(f.paths.databaseFile, { readonly: true });
    try {
      expect(after.query('SELECT max(version) version FROM schema_migrations').get()).toEqual({ version: 25 });
      expect(after.query<{ name: string }, []>('PRAGMA table_info(invoice_work_phases)').all().some(column => column.name === 'scheduler_state')).toBe(false);
      expect(after.query('SELECT * FROM invoice_works').all()).toEqual(before.works);
      expect(after.query('SELECT * FROM invoice_work_items').all()).toEqual(before.items);
      expect(after.query(`SELECT ${phaseColumns} FROM invoice_work_phases`).all()).toEqual(before.phases);
      expect(after.query('SELECT * FROM sessions WHERE id=?').get(session.sessionId)).toEqual(before.session);
      expect(after.query('SELECT * FROM session_native_history WHERE session_id=?').get(session.sessionId)).toEqual(before.history);
      expect(after.query('SELECT * FROM session_native_entries WHERE session_id=? ORDER BY sequence').all(session.sessionId)).toEqual(before.entries);
    } finally { after.close(); }
  } else {
    const current = need(opened);
    try {
      expect(await current.read(scope => scope.db.query('SELECT max(version) version FROM schema_migrations').get())).toEqual({ version: 30 });
      expect(await current.read(scope => scope.db.query(`SELECT ${phaseColumns} FROM invoice_work_phases`).all())).toEqual(before.phases);
      expect(await current.read(scope => scope.db.query('SELECT scheduler_state FROM invoice_work_phases').all())).toEqual([{ scheduler_state: 'legacy' }]);
      expect(await current.read(scope => scope.db.query('SELECT * FROM invoice_works').all())).toEqual(before.works);
      expect(await current.read(scope => scope.db.query('SELECT * FROM invoice_work_items').all())).toEqual(before.items);
      expect(await current.read(scope => scope.sessions.loadHistory(session.sessionId))).toEqual(ok(history));
      expect(await current.read(scope => scope.db.query('PRAGMA foreign_key_check').all())).toEqual([]);
    } finally { await current.close(); }
  }
});

test('a page read proposal requires its completed phase and exact user-confirmed target', async () => {
  const at = '2026-11-06T00:00:00.000Z';
  const f = await invoiceWorkToolsFixture({ at, configuration: { modelId: null, thinkingLevel: 'off',
    tools: ['browser_request_read', 'browser_read_approved'], resources: { prompt: null, enabledSkills: [] },
    extensions: { enabledExtensions: [] }, workingDirectory: null, preferences: '' } });
  const target = { connectionId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
    bindingId: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb', origin: 'https://example.test' };
  const original = await f.database.transaction(scope => {
    const call = need(scope.toolCalls.request({ context: null, invoiceWorkScope: f.product.scope, runId: f.runId,
      sessionId: f.created.sessionId, nativeToolCallId: 'durable-task:browser-proposal', toolName: 'browser_request_read',
      toolVersion: '1', effect: 'LOCAL_WRITE', rawArguments: {}, requestedAt: at }));
    need(scope.toolCalls.fixArguments({ toolCallId: call.toolCallId, finalArguments: {} }));
    return need(scope.toolCalls.start({ toolCallId: call.toolCallId, startedAt: at }));
  });
  const created = await f.database.transaction(scope => {
    const repository = Reflect.get(scope, 'invoiceWorkBrowserReads');
    expect(repository).toBeDefined();
    return repository.propose({ workId: f.created.workId, itemId: f.itemId, proposalToolCallId: original.toolCallId, target, at });
  });
  expect(created).toMatchObject({ ok: true, data: { status: 'waiting', canDecide: false } });
  if (!created.ok) return;
  const proposalId = created.data.proposalId;
  const work = need(await f.database.read(scope => scope.invoiceWorks.get({ view: 'work', workId: f.created.workId })));
  const decision = { workId: f.created.workId, itemId: f.itemId, proposalId, expectedRevision: work.work.revision,
    requestId: 'approve-browser-once', decision: 'approve' as const, confirmedTarget: target };
  expect(await f.database.transaction(scope => Reflect.get(scope, 'invoiceWorkBrowserReads').decide(decision, at))).toMatchObject({ ok: false });
  await f.database.transaction(scope => {
    need(scope.toolCalls.finish({ toolCallId: original.toolCallId,
      result: { version: 1, committedCandidateId: null, status: 'succeeded', data: { proposalId } },
      cleanup: { version: 1, stopped: true, stopReason: 'tool-completed', errors: [] }, endedAt: at, stoppedAt: at }));
    scope.db.query('UPDATE invoice_work_phases SET closed_at=? WHERE id=?').run(at, f.phase.phaseId);
  });
  expect(await f.database.transaction(scope => Reflect.get(scope, 'invoiceWorkBrowserReads').decide({
    ...decision, confirmedTarget: { ...target, origin: 'https://other.test' } }, at))).toMatchObject({ ok: false });
  const competitor = { ...decision, requestId: 'competing-browser-approval' };
  const [first, second] = await Promise.all([f.database.transaction(scope => scope.invoiceWorkBrowserReads.decide(decision, at)),
    f.database.transaction(scope => scope.invoiceWorkBrowserReads.decide(competitor, at))]);
  expect([first, second].filter(result => result.ok)).toHaveLength(1);
  const approved = first.ok ? first : second, winner = first.ok ? decision : competitor;
  expect(approved).toMatchObject({ ok: true, data: { proposalId, decision: 'approve', revision: decision.expectedRevision + 1 } });
  expect(await f.database.transaction(scope => scope.invoiceWorkBrowserReads.decide(winner, at))).toEqual(approved);
  expect(await f.database.transaction(scope => scope.invoiceWorkBrowserReads.decide({ ...winner, decision: 'reject' }, at)))
    .toMatchObject({ ok: false });
});

async function approvedBrowserFixture() {
  const at = '2026-11-06T00:00:00.000Z';
  const f = await invoiceWorkToolsFixture({ at, configuration: { modelId: 'browser-model', thinkingLevel: 'off',
    tools: ['browser_request_read', 'browser_read_approved'], resources: { prompt: null, enabledSkills: [] },
    extensions: { enabledExtensions: [] }, workingDirectory: null, preferences: '' } });
  const target = { connectionId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
    bindingId: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb', origin: 'https://example.test' };
  const proposal = await f.database.transaction(scope => {
    const call = need(scope.toolCalls.request({ context: null, invoiceWorkScope: f.product.scope, runId: f.runId,
      sessionId: f.created.sessionId, nativeToolCallId: 'durable-task:browser-request', toolName: 'browser_request_read',
      toolVersion: '1', effect: 'LOCAL_WRITE', rawArguments: {}, requestedAt: at }));
    need(scope.toolCalls.fixArguments({ toolCallId: call.toolCallId, finalArguments: {} }));
    need(scope.toolCalls.start({ toolCallId: call.toolCallId, startedAt: at }));
    const created = need(scope.invoiceWorkBrowserReads.propose({ workId: f.created.workId, itemId: f.itemId,
      proposalToolCallId: call.toolCallId, target, at }));
    need(scope.toolCalls.finish({ toolCallId: call.toolCallId, result: { version: 1, committedCandidateId: null,
      status: 'succeeded', data: { proposalId: created.proposalId } },
      cleanup: { version: 1, stopped: true, stopReason: 'tool-completed', errors: [] }, endedAt: at, stoppedAt: at }));
    need(scope.invoiceWorks.linkPhase({ workId: f.created.workId, attemptId: f.attemptId, phaseId: f.phase.phaseId,
      nativeConversationId: 101, nativeSubmissionId: 201, at }));
    scope.db.query('UPDATE invoice_work_tool_calls SET feedback_native_entry_id=?,feedback_bytes=? WHERE tool_call_id=?').run(301, 100, call.toolCallId);
    scope.db.query('UPDATE invoice_work_phases SET closed_at=? WHERE id=?').run(at, f.phase.phaseId);
    return created;
  });
  const work = need(await f.database.read(scope => scope.invoiceWorks.get({ view: 'work', workId: f.created.workId })));
  const approved = need(await f.database.transaction(scope => scope.invoiceWorkBrowserReads.decide({ workId: f.created.workId, itemId: f.itemId,
    proposalId: proposal.proposalId, expectedRevision: work.work.revision, requestId: 'approve-browser', decision: 'approve', confirmedTarget: target }, at)));
  const governor = new DurableInvoiceGovernor(f.database, () => at, () => false);
  const service = new InvoiceWorkService({ database: f.database, now: () => at,
    assessExecution: command => governor.assess(command), onChanged: () => {} });
  const continued = need(await service.continueWork({ workId: f.created.workId, expectedRevision: approved.revision,
    expectedAttemptId: f.attemptId, requestId: 'continue-browser' }));
  expect(continued.execution).toMatchObject({ authorizationAccepted: true });
  const selected = need(await f.database.read(scope => scope.invoiceWorks.selectPhaseInput({ workId: f.created.workId,
    attemptId: f.attemptId, itemId: f.itemId })));
  expect(selected.basis.browserProposalId).toBe(proposal.proposalId);
  const scoped = await f.database.transaction(scope => {
    const phase = need(scope.invoiceWorks.freezePhase({ workId: f.created.workId, itemId: f.itemId, attemptId: f.attemptId,
      requestId: 'browser-successor', kind: 'prompt', basis: selected.basis, at }));
    need(scope.invoiceWorks.linkPhase({ workId: f.created.workId, attemptId: f.attemptId, phaseId: phase.phaseId,
      nativeConversationId: 101, nativeSubmissionId: 202, at }));
    const context = need(buildInvoiceWorkContext(need(scope.invoiceWorks.readContextInput({ workId: f.created.workId, attemptId: f.attemptId,
      requestId: phase.requestId, remainingBudget: { modelCalls: 12, toolCalls: 24, toolFeedbackBytes: 65536, timeoutMs: 30000, childSlots: 1 } }))));
    need(scope.invoiceWorkContexts.save({ context, at }));
    const resolved = need(resolveInvoiceWorkToolScope(scope.db, { runId: f.runId, sessionId: f.created.sessionId,
      workId: f.created.workId, attemptId: f.attemptId, requestId: phase.requestId }));
    expect(resolved.scope.allowedTools).toEqual(['browser_read_approved']);
    return resolved.scope;
  });
  return { f, target, proposal, scoped, at };
}

test('an approved browser read requires explicit continuation and can be claimed once', async () => {
  const { f, target, proposal, scoped, at } = await approvedBrowserFixture();
  const execution = await f.database.transaction(scope => {
    const call = need(scope.toolCalls.request({ context: null, invoiceWorkScope: scoped, runId: f.runId,
      sessionId: f.created.sessionId, nativeToolCallId: 'durable-task:browser-read', toolName: 'browser_read_approved',
      toolVersion: '1', effect: 'LOCAL_WRITE', rawArguments: {}, requestedAt: at }));
    need(scope.toolCalls.fixArguments({ toolCallId: call.toolCallId, finalArguments: {} }));
    return need(scope.toolCalls.start({ toolCallId: call.toolCallId, startedAt: at }));
  });
  const claim = { workId: f.created.workId, itemId: f.itemId, proposalId: proposal.proposalId, executionToolCallId: execution.toolCallId, at };
  expect(await f.database.transaction(scope => scope.invoiceWorkBrowserReads.claim(claim))).toMatchObject({ ok: true, data: { status: 'claimed' } });
  expect(await f.database.transaction(scope => scope.invoiceWorkBrowserReads.claim(claim))).toMatchObject({ ok: false });
  const revoked = await f.database.transaction(scope => {
    const revoke = Reflect.get(scope.invoiceWorkBrowserReads, 'revoke'); expect(typeof revoke).toBe('function');
    return revoke({ workId: claim.workId, itemId: claim.itemId, proposalId: claim.proposalId, at });
  });
  expect(revoked).toMatchObject({ ok: true, data: { status: 'unknown' } });
  expect(await f.database.transaction(scope => {
    const accept = Reflect.get(scope.invoiceWorkBrowserReads, 'accept'); expect(typeof accept).toBe('function');
    return accept({ ...claim, page: { url: 'https://example.test/report', title: 'Invoice', text: 'secret', truncated: false } });
  })).toMatchObject({ ok: false });
});

test('a rejected browser proposal never becomes an approved read', async () => {
  const at = '2026-11-06T00:00:00.000Z';
  const f = await invoiceWorkToolsFixture({ at, configuration: { modelId: null, thinkingLevel: 'off',
    tools: ['browser_request_read', 'browser_read_approved'], resources: { prompt: null, enabledSkills: [] },
    extensions: { enabledExtensions: [] }, workingDirectory: null, preferences: '' } });
  const target = { connectionId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', bindingId: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb', origin: 'https://example.test' };
  const proposal = await f.database.transaction(scope => {
    const call = need(scope.toolCalls.request({ context: null, invoiceWorkScope: f.product.scope, runId: f.runId, sessionId: f.created.sessionId,
      nativeToolCallId: 'durable-task:rejected-browser', toolName: 'browser_request_read', toolVersion: '1', effect: 'LOCAL_WRITE', rawArguments: {}, requestedAt: at }));
    need(scope.toolCalls.fixArguments({ toolCallId: call.toolCallId, finalArguments: {} }));
    need(scope.toolCalls.start({ toolCallId: call.toolCallId, startedAt: at }));
    const created = need(scope.invoiceWorkBrowserReads.propose({ workId: f.created.workId, itemId: f.itemId, proposalToolCallId: call.toolCallId, target, at }));
    need(scope.toolCalls.finish({ toolCallId: call.toolCallId, result: { version: 1, committedCandidateId: null,
      status: 'succeeded', data: { proposalId: created.proposalId } }, cleanup: { version: 1, stopped: true, stopReason: 'tool-completed', errors: [] }, endedAt: at, stoppedAt: at }));
    scope.db.query('UPDATE invoice_work_phases SET closed_at=? WHERE id=?').run(at, f.phase.phaseId);
    return created;
  });
  const work = need(await f.database.read(scope => scope.invoiceWorks.get({ view: 'work', workId: f.created.workId })));
  const rejected = await f.database.transaction(scope => scope.invoiceWorkBrowserReads.decide({ workId: f.created.workId, itemId: f.itemId,
    proposalId: proposal.proposalId, expectedRevision: work.work.revision, requestId: 'reject-browser', decision: 'reject' }, at));
  expect(rejected).toMatchObject({ ok: true, data: { decision: 'reject' } });
  expect(need(await f.database.read(scope => scope.invoiceWorkBrowserReads.get({ workId: f.created.workId, itemId: f.itemId,
    proposalId: proposal.proposalId }))).status).toBe('rejected');
  expect(await f.database.transaction(scope => scope.invoiceWorkBrowserReads.claim({ workId: f.created.workId, itemId: f.itemId,
    proposalId: proposal.proposalId, executionToolCallId: 999, at }))).toMatchObject({ ok: false });
});

test.each(['accepted', 'revoked', 'cancelled'] as const)('browser result is %s at the authorization boundary', async decision => {
  const { f, target, proposal, scoped, at } = await approvedBrowserFixture();
  const module = await import('../../../packages/core/src/personal-agent/browser-tools.ts');
  const create = Reflect.get(module, 'createBrowserExecutionTool');
  expect(typeof create).toBe('function');
  if (typeof create !== 'function') return;
  const entered = Promise.withResolvers<void>(), release = Promise.withResolvers<void>();
  const page = { url: 'https://example.test/report', title: 'Invoice', text: 'secret', truncated: false };
  const tool = create({ database: f.database, now: () => at, resolveTarget: async () => ok(target),
    read: async () => { entered.resolve(); await release.promise; return ok(page); } });
  const executor = createToolExecutor({ database: f.database, definitions: [tool], now: () => at });
  const controller = new AbortController();
  const execution = executor.execute('browser_read_approved', {}, { ...f.product, scope: scoped,
    nativeToolCallId: 'durable-task:browser-execution', signal: controller.signal });
  try {
    await entered.promise;
    const current = need(await f.database.read(scope => scope.invoiceWorkBrowserReads.get({
      workId: f.created.workId, itemId: f.itemId, proposalId: proposal.proposalId })));
    expect(current.status).toBe('claimed');
    if (decision === 'revoked') need(await f.database.transaction(scope => scope.invoiceWorkBrowserReads.revoke({
      workId: f.created.workId, itemId: f.itemId, proposalId: proposal.proposalId, at })));
    if (decision === 'cancelled') controller.abort();
  } finally { release.resolve(); }
  const result = await execution;
  const saved = await f.database.read(scope => ({
    read: need(scope.invoiceWorkBrowserReads.get({ workId: f.created.workId, itemId: f.itemId, proposalId: proposal.proposalId })),
    call: scope.db.query<{ result_json: string | null }, [string]>('SELECT result_json FROM tool_calls WHERE native_tool_call_id=?')
      .get('durable-task:browser-execution'),
  }));
  if (decision === 'accepted') {
    expect(result.result).toEqual({ status: 'succeeded', data: page });
    expect(saved.read.status).toBe('completed');
    expect(saved.call?.result_json).toContain('secret');
  } else {
    expect(result.result.status).not.toBe('succeeded');
    expect(JSON.stringify(result.result)).not.toContain('secret');
    expect(saved.read.status).toBe('unknown');
    expect(saved.call?.result_json).not.toContain('secret');
  }
});

test('concurrent executions cannot consume one browser approval twice', async () => {
  const { f, target, proposal, scoped, at } = await approvedBrowserFixture();
  const { createBrowserExecutionTool } = await import('../../../packages/core/src/personal-agent/browser-tools.ts');
  const entered = Promise.withResolvers<void>(), release = Promise.withResolvers<void>(); let reads = 0;
  const tool = createBrowserExecutionTool({ database: f.database, now: () => at, resolveTarget: async () => ok(target),
    read: async () => { reads++; entered.resolve(); await release.promise; return ok({ url: 'https://example.test/page', title: 'Page', text: 'page', truncated: false }); } });
  const executor = createToolExecutor({ database: f.database, definitions: [tool], now: () => at });
  const context = { ...f.product, scope: scoped, signal: new AbortController().signal };
  const first = executor.execute('browser_read_approved', {}, { ...context, nativeToolCallId: 'durable-task:browser-first' });
  try {
    await entered.promise;
    const second = await executor.execute('browser_read_approved', {}, { ...context, nativeToolCallId: 'durable-task:browser-second' });
    expect(second.result.status).not.toBe('succeeded');
  } finally { release.resolve(); }
  expect((await first).result.status).toBe('succeeded');
  expect(reads).toBe(1);
  expect(need(await f.database.read(scope => scope.invoiceWorkBrowserReads.get({ workId: f.created.workId, itemId: f.itemId,
    proposalId: proposal.proposalId }))).status).toBe('completed');
});

test('cancellation before a browser approval is claimed requires a new confirmation', async () => {
  const { f, target, proposal, scoped, at } = await approvedBrowserFixture();
  const { createBrowserExecutionTool } = await import('../../../packages/core/src/personal-agent/browser-tools.ts');
  const entered = Promise.withResolvers<void>(), release = Promise.withResolvers<void>(); let reads = 0;
  const tool = createBrowserExecutionTool({ database: f.database, now: () => at,
    resolveTarget: async () => { entered.resolve(); await release.promise; return ok(target); },
    read: async () => { reads++; return ok({ url: 'https://example.test/page', title: 'Page', text: 'secret', truncated: false }); } });
  const executor = createToolExecutor({ database: f.database, definitions: [tool], now: () => at }), controller = new AbortController();
  const execution = executor.execute('browser_read_approved', {}, { ...f.product, scope: scoped,
    nativeToolCallId: 'durable-task:before-claim-cancel', signal: controller.signal });
  try { await entered.promise; controller.abort(); } finally { release.resolve(); }
  expect((await execution).result.status).not.toBe('succeeded');
  expect(reads).toBe(0);
  expect(need(await f.database.read(scope => scope.invoiceWorkBrowserReads.get({ workId: f.created.workId, itemId: f.itemId,
    proposalId: proposal.proposalId }))).status).toBe('invalidated');
});

test.each(['stop', 'cancel'] as const)('a Work %s invalidates its unclaimed browser approval', async action => {
  const { f, proposal, at } = await approvedBrowserFixture();
  const work = need(await f.database.read(scope => scope.invoiceWorks.get({ view: 'work', workId: f.created.workId })));
  const result = await f.database.transaction(scope => action === 'stop'
    ? scope.invoiceWorkAttempts.requestStop({ workId: f.created.workId, attemptId: f.attemptId, expectedRevision: work.work.revision,
      requestId: 'stop-browser-work' }, { at })
    : scope.invoiceWorks.cancelWork({ workId: f.created.workId, expectedRevision: work.work.revision, requestId: 'cancel-browser-work' }, { at }));
  expect(result.ok).toBe(true);
  expect(need(await f.database.read(scope => scope.invoiceWorkBrowserReads.get({ workId: f.created.workId, itemId: f.itemId,
    proposalId: proposal.proposalId }))).status).toBe('invalidated');
});

test.each(['stop', 'cancel'] as const)('a Work %s suppresses an already claimed browser result', async action => {
  const { f, target, proposal, scoped, at } = await approvedBrowserFixture();
  const { createBrowserExecutionTool } = await import('../../../packages/core/src/personal-agent/browser-tools.ts');
  const entered = Promise.withResolvers<void>(), release = Promise.withResolvers<void>();
  const tool = createBrowserExecutionTool({ database: f.database, now: () => at, resolveTarget: async () => ok(target),
    read: async () => { entered.resolve(); await release.promise; return ok({ url: 'https://example.test/page', title: 'Page', text: 'late secret', truncated: false }); } });
  const executor = createToolExecutor({ database: f.database, definitions: [tool], now: () => at });
  const execution = executor.execute('browser_read_approved', {}, { ...f.product, scope: scoped,
    nativeToolCallId: 'durable-task:stop-in-flight-browser', signal: new AbortController().signal });
  try {
    await entered.promise;
    const work = need(await f.database.read(scope => scope.invoiceWorks.get({ view: 'work', workId: f.created.workId })));
    const result = await f.database.transaction(scope => action === 'stop'
      ? scope.invoiceWorkAttempts.requestStop({ workId: f.created.workId, attemptId: f.attemptId, expectedRevision: work.work.revision,
        requestId: 'stop-browser-in-flight' }, { at })
      : scope.invoiceWorks.cancelWork({ workId: f.created.workId, expectedRevision: work.work.revision, requestId: 'cancel-browser-in-flight' }, { at }));
    expect(result.ok).toBe(true);
  } finally { release.resolve(); }
  const result = await execution;
  expect(result.result.status).not.toBe('succeeded'); expect(JSON.stringify(result.result)).not.toContain('late secret');
  const saved = await f.database.read(scope => ({ read: need(scope.invoiceWorkBrowserReads.get({ workId: f.created.workId, itemId: f.itemId,
    proposalId: proposal.proposalId })), call: scope.db.query<{ result_json: string }, [string]>('SELECT result_json FROM tool_calls WHERE native_tool_call_id=?')
    .get('durable-task:stop-in-flight-browser') }));
  expect(saved.read.status).toBe('unknown'); expect(saved.call?.result_json).not.toContain('late secret');
});

test('restart marks a claimed browser read unknown and does not dispatch it again', async () => {
  const { f, proposal, scoped, at } = await approvedBrowserFixture();
  await f.database.transaction(scope => {
    const call = need(scope.toolCalls.request({ context: null, invoiceWorkScope: scoped, runId: f.runId, sessionId: f.created.sessionId,
      nativeToolCallId: 'durable-task:restart-read', toolName: 'browser_read_approved', toolVersion: '1', effect: 'LOCAL_WRITE', rawArguments: {}, requestedAt: at }));
    need(scope.toolCalls.fixArguments({ toolCallId: call.toolCallId, finalArguments: {} }));
    need(scope.toolCalls.start({ toolCallId: call.toolCallId, startedAt: at }));
    need(scope.invoiceWorkBrowserReads.claim({ workId: f.created.workId, itemId: f.itemId, proposalId: proposal.proposalId,
      executionToolCallId: call.toolCallId, at }));
  });
  await f.database.close();
  const reopened = need(openTestDatabase(f.paths));
  try {
    const read = need(await reopened.read(scope => scope.invoiceWorkBrowserReads.get({ workId: f.created.workId, itemId: f.itemId, proposalId: proposal.proposalId })));
    expect(read.status).toBe('unknown');
    expect(await reopened.transaction(scope => scope.invoiceWorkBrowserReads.claim({ workId: f.created.workId, itemId: f.itemId,
      proposalId: proposal.proposalId, executionToolCallId: read.executionToolCallId!, at }))).toMatchObject({ ok: false });
  } finally { await reopened.close(); }
});

test('revoking a received page prevents its recovery from the original Durable tool call', async () => {
  const { f, target, proposal, scoped, at } = await approvedBrowserFixture();
  const module = await import('../../../packages/core/src/personal-agent/browser-tools.ts');
  const create = Reflect.get(module, 'createBrowserExecutionTool');
  expect(typeof create).toBe('function'); if (typeof create !== 'function') return;
  const page = { url: 'https://example.test/report', title: 'Invoice', text: 'secret', truncated: false };
  const tool = create({ database: f.database, now: () => at, resolveTarget: async () => ok(target), read: async () => ok(page) });
  const executor = createToolExecutor({ database: f.database, definitions: [tool], now: () => at });
  expect((await executor.execute('browser_read_approved', {}, { ...f.product, scope: scoped,
    nativeToolCallId: 'durable-task:303', signal: new AbortController().signal })).result).toEqual({ status: 'succeeded', data: page });
  const call = { workId: f.created.workId, sessionId: f.created.sessionId, attemptId: f.attemptId, requestId: 'browser-successor',
    nativeConversationId: 101, nativeTaskId: 303, nativeToolCallId: 'wire-303', name: 'browser_read_approved', arguments: {} };
  expect(await f.database.read(scope => readInvoiceWorkToolResult(scope, call))).toEqual({ ok: true, data: { status: 'succeeded', data: page } });
  need(await f.database.transaction(scope => scope.invoiceWorkBrowserReads.revoke({ workId: f.created.workId, itemId: f.itemId,
    proposalId: proposal.proposalId, at })));
  const recovered = await f.database.read(scope => readInvoiceWorkToolResult(scope, call));
  expect(JSON.stringify(recovered)).not.toContain('secret');
  expect(recovered.ok && recovered.data?.status === 'succeeded').toBe(false);
});

test('the Work service exposes browser approval state only to its owning workspace', async () => {
  const { f, proposal, at } = await approvedBrowserFixture();
  let changed = 0;
  const service = new InvoiceWorkService({ database: f.database, now: () => at,
    assessExecution: () => ok({ kind: 'ready' }), onChanged: () => {}, onDesktopChanged: () => { changed++; } });
  const list = Reflect.get(service, 'listBrowserReads'), query = Reflect.get(service, 'queryBrowserDecision'), revoke = Reflect.get(service, 'revokeBrowserRead');
  expect([list, query, revoke].every(value => typeof value === 'function')).toBe(true);
  if (typeof list !== 'function' || typeof query !== 'function' || typeof revoke !== 'function') return;
  const owner = { workId: f.created.workId, itemId: f.itemId };
  expect(await list.call(service, owner)).toMatchObject({ ok: true, data: { items: [{ proposalId: proposal.proposalId, status: 'approved' }] } });
  expect(await query.call(service, { ...owner, proposalId: proposal.proposalId, requestId: 'approve-browser' }))
    .toMatchObject({ ok: true, data: { decision: 'approve' } });
  const foreign = new InvoiceWorkService({ database: f.database, now: () => at, cloudWorkspaceId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
    assessExecution: () => ok({ kind: 'ready' }), onChanged: () => {} });
  expect(await list.call(foreign, owner)).toMatchObject({ ok: false });
  expect(await revoke.call(service, { ...owner, proposalId: proposal.proposalId })).toMatchObject({ ok: true, data: { status: 'invalidated' } });
  expect(changed).toBe(1);
});

test('the runtime refuses a saved page when the local browser binding has changed', async () => {
  const { f, target, scoped, at } = await approvedBrowserFixture();
  const { createBrowserExecutionTool } = await import('../../../packages/core/src/personal-agent/browser-tools.ts');
  const page = { url: 'https://example.test/report', title: 'Invoice', text: 'secret', truncated: false };
  let current = target;
  const browser = { resolveTarget: async () => ok(current), read: async () => ok(page) };
  const tool = createBrowserExecutionTool({ database: f.database, now: () => at, ...browser });
  const executor = createToolExecutor({ database: f.database, definitions: [tool], now: () => at });
  expect((await executor.execute('browser_read_approved', {}, { ...f.product, scope: scoped,
    nativeToolCallId: 'durable-task:304', signal: new AbortController().signal })).result).toEqual({ status: 'succeeded', data: page });
  const native = { close: async () => ok(undefined) } as unknown as DurableRuntimePort;
  const runtime = need(await createPersonalAgentRuntime({ database: f.database, definitions: f.definitions, browser,
    resourceRoot: f.paths.root, bundleRoot: f.paths.root, resolveConfiguration: () => { throw Error('unused'); }, readApiKey: () => undefined,
    foregroundBusy: () => false, now: () => at, cloud: { workspaceId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', runtime: native } }));
  try {
    const call = { workId: f.created.workId, sessionId: f.created.sessionId, attemptId: f.attemptId, requestId: 'browser-successor',
      nativeConversationId: 101, nativeTaskId: 304, nativeToolCallId: 'wire-304', name: 'browser_read_approved', arguments: {} };
    expect(await runtime.cloudAuthority!.callbacks.readToolResult(call)).toEqual({ ok: true, data: { status: 'succeeded', data: page } });
    current = { ...target, bindingId: 'cccccccc-cccc-4ccc-8ccc-cccccccccccc' };
    const recovered = await runtime.cloudAuthority!.callbacks.readToolResult(call);
    expect(JSON.stringify(recovered)).not.toContain('secret');
    expect(recovered.ok && recovered.data?.status === 'succeeded').toBe(false);
  } finally { need(await runtime.close()); }
});
