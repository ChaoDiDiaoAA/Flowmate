import { expect, test } from 'bun:test';
import { Database } from 'bun:sqlite';
import { existsSync, statSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { defaultProductSettings } from '@flowmate/core';
import { InvoiceWorkWorkingContextSchema, type DocumentSnapshot, type Result } from '@flowmate/contracts';
import * as P from '../../packages/contracts/src/personal-agent.ts';
import { createCredentialStore } from '../../packages/shared/src/secure-credential-store.ts';
import { createServiceSecureStorage } from '../../packages/shared/src/service-secure-storage.ts';
import { createHttpProvider } from '../support/resources.ts';
import { CHILD_STOP_FAILURE, CHILD_STOP_TRIGGER, spawnOwnerChildStopFixture, type ChildStopSnapshot, type ChildStopTarget } from '../support/owner-child-stop-fixture.ts';
import { installOwnerFixture, ownerClient, packageOwnerFixture, removeOwnerFixture, waitOwner } from './owner-fixture.ts';

function need<T>(value: Result<T>): T { if (!value.ok) throw Error(value.error.code + ': ' + value.error.message); return value.data; }

test.skipIf(process.platform !== 'win32' || process.arch !== 'x64')('a real Owner retains root and child occupancy after a child terminal SQLite commit fails, then a new Owner proves its original abort before releasing the saved queue', async () => {
  const runtimeRoot = process.env.FLOWMATE_OWNER_CHILD_STOP_RUNTIME_ROOT;
  const packaged = runtimeRoot ? { root: null, runtimeRoot: resolve(runtimeRoot) } : await packageOwnerFixture();
  let installation: Awaited<ReturnType<typeof installOwnerFixture>> | undefined;
  let faultOwner: Awaited<ReturnType<typeof spawnOwnerChildStopFixture>> | undefined;
  let recoveredOwner: Awaited<ReturnType<typeof spawnOwnerChildStopFixture>> | undefined;
  type Child = Awaited<ReturnType<typeof spawnOwnerChildStopFixture>>['child'];
  const children = new Set<Child>(), sockets: Array<{ destroy(): void }> = [];
  const releaseChild = Promise.withResolvers<void>();
  const requests: Array<{ workId: number; child: boolean }> = [];
  let target: ChildStopTarget | undefined;
  let databaseFile = '';
  function proof() {
    if (!target) throw Error('The original owned child stop target is unavailable.');
    const db = new Database(databaseFile, { readonly: true });
    try {
      const task = db.query<{ record: string; status: string; abort_requested: number }, [number]>(
        'SELECT record,status,abort_requested FROM fm_durable_tasks WHERE id=?').get(target.nativeTaskId);
      const attempt = db.query<{ stop_requested_at: string | null; stopped_at: string | null }, [number, number]>(
        'SELECT stop_requested_at,stopped_at FROM invoice_work_attempts WHERE work_id=? AND id=?').get(target.workId, target.attemptId);
      const runs = db.query<{ id: number; status: string; stopped_at: string | null; cleanup_json: string }, [number, number]>(
        'SELECT id,status,stopped_at,cleanup_json FROM runs WHERE id IN (?,?) ORDER BY id').all(target.rootRunId, target.childRunId);
      const phases = db.query<ChildStopSnapshot['phases'][number], [number, number]>(
        'SELECT id,request_id,native_conversation_id,native_submission_id,closed_at FROM invoice_work_phases WHERE work_id=? AND attempt_id=? ORDER BY id')
        .all(target.workId, target.attemptId);
      if (!task || !attempt || runs.length !== 2) throw Error('The original root, child or native task disappeared.');
      return { task, attempt, runs, phases };
    } finally { db.close(); }
  }
  function stopped(value: ReturnType<typeof proof>) {
    expect(value.attempt.stopped_at).not.toBeNull(); expect(value.task.status).toBe('terminal');
    expect(JSON.parse(value.task.record).state.outcome.status).toBe('aborted');
    for (const run of value.runs) {
      expect(run.stopped_at).not.toBeNull(); expect(JSON.parse(run.cleanup_json)).toMatchObject({ stopped: true, lateObservationRequired: false });
    }
  }
  async function exitOwned(child: Child, kill: boolean) {
    expect(children.has(child)).toBe(true);
    const pid = child.pid; expect(Number.isSafeInteger(pid) && pid > 0 && pid !== process.pid).toBe(true);
    if (kill && child.exitCode === null) { expect(child.pid).toBe(pid); child.kill('SIGKILL'); }
    let timer: ReturnType<typeof setTimeout> | undefined;
    try { return await Promise.race([child.exited, new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(Error('The actual owned Bun exit remains unconfirmed.')), 10000);
    })]); } finally { clearTimeout(timer); }
  }
  const firstGoal = 'Delegate the bounded source check for the original first Work.';
  const secondGoal = 'Review the independently authorized queued Work after the first stop is proven.';
  const server = await createHttpProvider(async request => {
    expect(request.headers.get('authorization')).toBe('Bearer synthetic-owner-child-stop-key');
    const body = await request.json() as { messages: Array<{ role: string; content: string }> };
    const context = InvoiceWorkWorkingContextSchema.parse(JSON.parse(body.messages.find(message => message.role === 'user')!.content));
    const child = context.delegation !== undefined; requests.push({ workId: context.work.workId, child });
    if (child) {
      await Promise.race([releaseChild.promise, new Promise<void>(resolve => {
        if (request.signal.aborted) resolve(); else request.signal.addEventListener('abort', () => resolve(), { once: true });
      })]);
    }
    const delegate = context.work.goal === firstGoal && !child && body.messages.every(message => message.role !== 'tool');
    const delta = delegate ? { role: 'assistant', tool_calls: [{ index: 0, id: 'original-owner-agent', type: 'function', function: { name: 'Agent',
      arguments: JSON.stringify({ subagent_type: 'invoice-evidence-checker', run_in_background: false,
        description: 'Bounded original source check', prompt: 'Read only the original invoice and report its source gap.' }) } }] }
      : { role: 'assistant', content: 'The original invoice still requires human review.' };
    return new Response('data: ' + JSON.stringify({ id: 'owner-child-stop-' + requests.length, model: 'owner-child-stop-model',
      choices: [{ index: 0, delta, finish_reason: delegate ? 'tool_calls' : 'stop' }] }) + '\n\ndata: [DONE]\n\n',
    { headers: { 'content-type': 'text/event-stream' } });
  });
  try {
    installation = await installOwnerFixture(packaged.runtimeRoot); databaseFile = join(installation.dataRoot, 'data/app.sqlite');
    faultOwner = await spawnOwnerChildStopFixture(installation); children.add(faultOwner.child); await faultOwner.ready;
    const ref = 'owner_child_stop_unknown_key_01';
    need(await createCredentialStore(join(installation.dataRoot, 'security/service-credentials', ref + '.json'),
      createServiceSecureStorage(installation.ownerSid)).write(JSON.stringify({ type: 'api_key', key: 'synthetic-owner-child-stop-key' })));
    const first = await ownerClient(installation); sockets.push(first.socket);
    const profile = { id: 'owner-child-stop', name: 'Owner child stop', credentialRef: ref, kind: 'custom', providerId: null,
      baseUrl: `http://127.0.0.1:${server.port}/v1`, model: 'owner-child-stop-model', api: 'openai-completions', contextWindow: 64000, maxTokens: 8192, reasoning: false };
    need(await first.call({ type: 'save_settings', settings: { ...defaultProductSettings(), revision: 0, models: [profile], defaultModelId: profile.id } }));
    const sourceText = 'Original owner invoice total 113.00';
    const document = need(await first.call<DocumentSnapshot>({ type: 'import_prepared_invoice_material', input: {
      contract: 'flowmate-prepared-invoice/v1', sample: 'owner-child-stop', sourceText,
      original: { name: 'source.md', base64: Buffer.from(sourceText).toString('base64') },
      pages: [{ page: 1, blocks: [{ id: 'b1', kind: 'text', text: sourceText, sourceIndex: 0, sourceType: 'prepared-text', bbox: null }] }],
    } }));
    const initial = P.PersonalAgentSnapshotSchema.parse(need(await first.call({ type: 'personal_agent_get', input: {} })));
    const agent = P.PersonalAgentSnapshotSchema.parse(need(await first.call({ type: 'personal_agent_update', input: {
      personalAgentId: initial.personalAgentId, expectedRevision: initial.revision, configuration: { ...initial.configuration,
        modelId: profile.id, tools: ['Agent', 'read_invoice_document'], resources: { prompt: null, enabledSkills: [] }, extensions: { enabledExtensions: [] } },
    } })));
    const create = (requestId: string, goal: string) => ({ personalAgentId: agent.personalAgentId, expectedAgentRevision: agent.revision,
      requestId, goal, documents: [document.documentRef] });
    const firstInput = create('original-child-stop-work', firstGoal);
    const original = P.InvoiceWorkCreateReceiptSchema.parse(need(await first.call({ type: 'invoice_work_create', input: firstInput })));
    if (!original.execution.attempt) throw Error('Expected the original admitted attempt.');
    await waitOwner(() => requests.some(value => value.child && value.workId === original.workId));
    const before = P.PersonalTaskGetResultSchema.parse(need(await first.call({ type: 'personal_task_get', input: { workId: original.workId, attemptId: original.execution.attempt.attemptId } })));
    expect(before.children).toHaveLength(1); expect(before.children[0]!.stopConfirmed).toBe(false);
    if (before.task.attempt.runId === null) throw Error('The real original root Run was not linked.');
    target = await faultOwner.arm({ workId: original.workId, attemptId: before.task.attempt.attemptId, childRunId: before.children[0]!.childRunId });
    expect(target.rootRunId).toBe(before.task.attempt.runId); expect(target.childRunId).toBe(before.children[0]!.childRunId);
    const secondInput = create('original-queued-behind-unconfirmed-child', secondGoal);
    const queued = P.InvoiceWorkCreateReceiptSchema.parse(need(await first.call({ type: 'invoice_work_create', input: secondInput })));
    expect(queued.execution).toMatchObject({ authorizationAccepted: true, kind: 'queued', attempt: { runId: null } });
    const current = P.InvoiceWorkGetResultSchema.parse(need(await first.call({ type: 'invoice_work_get', input: { view: 'work', workId: original.workId } })));
    const stopInput = { workId: original.workId, attemptId: before.task.attempt.attemptId, requestId: 'stop-original-real-child', expectedRevision: current.work.revision };
    const stop = P.PersonalTaskStopReceiptSchema.parse(need(await first.call({ type: 'personal_task_stop', input: stopInput })));
    expect(stop).toMatchObject({ accepted: true, stopConfirmed: false, stoppedAt: null });
    await waitOwner(() => faultOwner!.messages.some(message => message.type === 'fixture_native_commit_failed'), () => faultOwner!.stderr());
    const failed = faultOwner.messages.find(message => message.type === 'fixture_native_commit_failed') as unknown as {
      taskId: number; attemptedStatus: string; message: string; code: string };
    expect(failed.taskId).toBe(target.nativeTaskId); expect(['completing', 'terminal']).toContain(failed.attemptedStatus);
    expect(failed.message).toContain(CHILD_STOP_FAILURE); expect(failed.code).toBe('SQLITE_CONSTRAINT_TRIGGER');
    await waitOwner(() => faultOwner!.messages.some(message => message.type === 'fixture_native_storage_closed'
      && message.value === target!.nativeTaskId), () => faultOwner!.stderr());
    const unconfirmed = P.PersonalTaskGetResultSchema.parse(need(await first.call({ type: 'personal_task_get', input: { workId: original.workId,
      attemptId: before.task.attempt.attemptId, stopRequestId: stopInput.requestId } })));
    expect(unconfirmed.stopReceipt).toEqual(stop); expect(unconfirmed.task.stoppedAt).toBeNull();
    expect(unconfirmed.children[0]).toMatchObject({ childRunId: target.childRunId, stopConfirmed: false, stoppedAt: null });
    const occupied = P.InvoiceWorkGetResultSchema.parse(need(await first.call({ type: 'invoice_work_get', input: { view: 'work', workId: original.workId } })));
    expect(occupied.work.execution).toMatchObject({ stopUnconfirmed: true, ownedChildRunIds: [target.childRunId] });
    const snapshot = await faultOwner.snapshot();
    expect(snapshot.task.status).not.toBe('terminal'); expect(snapshot.task.abort_requested).toBe(1);
    expect(snapshot.attempt.stop_requested_at).toBe(stop.receivedAt); expect(snapshot.attempt.stopped_at).toBeNull(); expect(snapshot.faultInstalled).toBe(true);
    for (let index = 0; index < 3; index++) {
      expect(need(await first.call({ type: 'invoice_work_query_operation', input: { operation: 'create', personalAgentId: agent.personalAgentId, requestId: firstInput.requestId } }))).toEqual(original);
      expect(P.PersonalTaskGetResultSchema.parse(need(await first.call({ type: 'personal_task_get', input: { workId: original.workId, attemptId: before.task.attempt.attemptId } }))).task.stoppedAt).toBeNull();
      const waiting = P.InvoiceWorkGetResultSchema.parse(need(await first.call({ type: 'invoice_work_get', input: { view: 'work', workId: queued.workId } })));
      expect(waiting.work.execution).toMatchObject({ queued: true, attempt: { runId: null } });
    }
    expect(await faultOwner.snapshot()).toEqual(snapshot);
    expect(requests.filter(value => value.workId === original.workId)).toHaveLength(2); expect(requests.filter(value => value.workId === queued.workId)).toHaveLength(0);
    expect(faultOwner.messages.some(message => message.type === 'fixture_close')).toBe(false);
    expect(await exitOwned(faultOwner.child, true)).not.toBe(0); first.socket.destroy(); releaseChild.resolve();
    const preserved = proof(); expect(preserved.task.status).not.toBe('terminal'); expect(preserved.attempt.stopped_at).toBeNull();
    const repair = new Database(databaseFile);
    try { repair.exec(`DROP TRIGGER ${CHILD_STOP_TRIGGER}`); } finally { repair.close(); }
    expect(proof()).toEqual(preserved);
    await waitOwner(() => !existsSync(databaseFile + '.lock') || Date.now() - statSync(databaseFile + '.lock').mtimeMs > 15000);
    recoveredOwner = await spawnOwnerChildStopFixture(installation, { target, queuedWorkId: queued.workId });
    children.add(recoveredOwner.child); await recoveredOwner.ready;
    const next = await ownerClient(installation); sockets.push(next.socket);
    let recovered: P.PersonalTaskGetResult | undefined, finished: P.PersonalTaskListResult | undefined;
    const deadline = Date.now() + 20000;
    while (Date.now() < deadline) {
      recovered = P.PersonalTaskGetResultSchema.parse(need(await next.call({ type: 'personal_task_get', input: { workId: original.workId,
        attemptId: before.task.attempt.attemptId, stopRequestId: stopInput.requestId } })));
      finished = P.PersonalTaskListResultSchema.parse(need(await next.call({ type: 'personal_task_list', input: { workId: queued.workId, limit: 10 } })));
      if (recovered.task.stoppedAt !== null && finished.items[0]?.stoppedAt !== null && finished.items[0]?.runStatus === 'completed') break;
      await Bun.sleep(30);
    }
    expect(recovered?.task).toMatchObject({ attempt: before.task.attempt, runStatus: 'cancelled', stoppedAt: expect.any(String) });
    expect(recovered?.children[0]).toMatchObject({ childRunId: target.childRunId, stopConfirmed: true, stoppedAt: expect.any(String) });
    expect(recovered?.children).toHaveLength(1);
    expect(recovered?.stopReceipt).toEqual(stop); expect(finished?.items).toHaveLength(1);
    expect(finished?.items[0]).toMatchObject({ attempt: { attemptId: queued.execution.attempt!.attemptId }, runStatus: 'completed', stoppedAt: expect.any(String) });
    await waitOwner(() => recoveredOwner!.messages.some(message => message.type === 'fixture_before_queued_fetch'), () => recoveredOwner!.stderr());
    const captured = recoveredOwner.messages.filter(message => message.type === 'fixture_before_queued_fetch');
    expect(captured).toHaveLength(1);
    const beforeTransport = captured[0]!.value as ChildStopSnapshot;
    expect(beforeTransport.target).toEqual(target); expect(beforeTransport.faultInstalled).toBe(false); stopped(beforeTransport);
    expect(requests.filter(value => value.workId === original.workId)).toHaveLength(2); expect(requests.filter(value => value.workId === queued.workId)).toHaveLength(1);
    expect(need(await next.call({ type: 'invoice_work_query_operation', input: { operation: 'create', personalAgentId: agent.personalAgentId, requestId: secondInput.requestId } }))).toEqual(queued);
    expect(need(await next.call({ type: 'invoice_work_query_operation', input: { operation: 'create', personalAgentId: agent.personalAgentId, requestId: firstInput.requestId } }))).toEqual(original);
    const originalAttempts = P.PersonalTaskListResultSchema.parse(need(await next.call({ type: 'personal_task_list', input: { workId: original.workId, limit: 10 } })));
    expect(originalAttempts.items).toHaveLength(1);
    expect(await recoveredOwner.close()).toMatchObject({ ok: true, data: { stopped: true, closed: true } });
    expect(await exitOwned(recoveredOwner.child, false)).toBe(0);
    const restored = proof(); stopped(restored);
    expect(JSON.parse(restored.task.record).id).toBe(target.nativeTaskId);
    expect(JSON.parse(restored.task.record).input).toEqual(JSON.parse(preserved.task.record).input);
    const phaseIdentity = (phases: ChildStopSnapshot['phases']) => phases.map(({ closed_at: _closed, ...identity }) => identity);
    expect(phaseIdentity(restored.phases)).toEqual(phaseIdentity(snapshot.phases));
    console.info('Original Owner child stop persistence recovery: ' + JSON.stringify({ target, originalStop: stop,
      failedCommit: failed, originalPhases: snapshot.phases, queuedWorkId: queued.workId, requests }));
  } finally {
    releaseChild.resolve(); for (const socket of sockets) socket.destroy(); server.stop(true);
    const errors: unknown[] = [];
    for (const child of children) { try { await exitOwned(child, child.exitCode === null); } catch (error) { errors.push(error); } }
    if (errors.length === 0 && installation) {
      removeOwnerFixture(installation.dataRoot); if (packaged.root) removeOwnerFixture(packaged.root);
    }
    else if (errors.length) throw new AggregateError(errors, 'Owned fixture exit is unconfirmed; original data is preserved.');
  }
}, 180000);
