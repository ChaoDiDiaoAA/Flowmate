import { expect, spyOn, test } from 'bun:test';
import { Database } from 'bun:sqlite';
import { existsSync, renameSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { z } from 'zod';
import { appError, fail, type Application, type DurableRuntimePort, type DurableSubmissionQuery,
  type InvoiceWorkWorkingContext, type ModelProfile, type Result } from '@flowmate/contracts';
import { defaultProductSettings } from '@flowmate/core';
import * as durable from '@flowmate/runtime-durable';
import * as composition from '../../../apps/composition.ts';
import { createProductCommandDispatcher, type ProductCommandDispatcher } from '../../../apps/host/dispatch.ts';
import { InvoiceWorkPhaseObserver } from '../../../packages/core/src/personal-agent/phase-context.ts';
import { createHttpProvider, deferCleanup, mkdtempSync, waitFor } from '../../support/resources.ts';
import { invoiceWorkCandidateDraft } from '../../support/invoice-work-tools.ts';

function need<T>(result: Result<T>): T { if (!result.ok) throw Error(`${result.error.code}: ${result.error.message}`); return result.data; }
const queryOf = ({ workId, sessionId, attemptId, requestId }: DurableSubmissionQuery): DurableSubmissionQuery =>
  ({ workId, sessionId, attemptId, requestId });
async function observed<T>(promise: Promise<T>): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try { return await Promise.race([promise, new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(Error('The original production boundary was not observed.')), 10_000);
  })]); } finally { clearTimeout(timer); }
}

async function fixture(resources = false) {
  const root = mkdtempSync(join(tmpdir(), 'flowmate-personal-trigger-recovery-'));
  const databaseFile = join(root, 'data/app.sqlite'), bundleRoot = join(root, 'runtime/resource-bundles');
  const contexts: InvoiceWorkWorkingContext[] = [], submissions: DurableSubmissionQuery[] = [], rejected: DurableSubmissionQuery[] = [], errors: string[] = [];
  const failWorkIds = new Set<number>(), parsedIds = new Map<number, number>();
  let app: Application | undefined, native: DurableRuntimePort | undefined, owner: ProductCommandDispatcher | undefined;
  let held: { entered: ReturnType<typeof Promise.withResolvers<void>>; release: ReturnType<typeof Promise.withResolvers<void>> } | null = null;
  let interruptedLink: DurableSubmissionQuery | null = null;
  let gap: { kind: 'native-receipt' | 'product-link'; previousAttemptId: number;
    reached: ReturnType<typeof Promise.withResolvers<{ query: DurableSubmissionQuery; nativeSubmissionId: number }>> } | null = null;
  const currentApp = () => { if (!app) throw Error('The original Application is unavailable.'); return app; };
  const currentNative = () => { if (!native) throw Error('The original Durable port is unavailable.'); return native; };
  const currentOwner = () => { if (!owner) throw Error('The production settings authority is unavailable.'); return owner; };
  const recordGap = async (query: DurableSubmissionQuery) => {
    const original = gap;
    if (!original) throw Error('The original fault boundary is unavailable.');
    const receipt = need(await currentNative().getSubmission(queryOf(query)));
    if (!receipt) throw Error('The real SDK did not commit the original submission.');
    interruptedLink = queryOf(query);
    gap = null; original.reached.resolve({ query: queryOf(query), nativeSubmissionId: receipt.nativeSubmissionId });
  };
  const openNative = durable.createDurableRuntime;
  const nativeSpy = spyOn(durable, 'createDurableRuntime').mockImplementation(async options => {
    const result = await openNative(options);
    if (result.ok) {
      native = result.data;
      const submit = native.submit.bind(native);
      native.submit = async input => {
        submissions.push(queryOf(input));
        const submitted = await submit(input);
        if (submitted.ok && gap?.kind === 'native-receipt' && input.attemptId !== gap.previousAttemptId) {
          await recordGap(input);
          return fail(appError('storage_write_failed', 'storage', 'Controlled lost response after the real SDK submission committed.', true));
        }
        return submitted;
      };
    }
    return result;
  });
  deferCleanup(() => nativeSpy.mockRestore());
  const reconcile = InvoiceWorkPhaseObserver.prototype.reconcile;
  const linkSpy = spyOn(InvoiceWorkPhaseObserver.prototype, 'reconcile').mockImplementation(async function (this: InvoiceWorkPhaseObserver, input) {
    // Keep this exact link unavailable until cold reopening; the real SDK submission already exists.
    if (interruptedLink && input.workId === interruptedLink.workId && input.sessionId === interruptedLink.sessionId
      && input.attemptId === interruptedLink.attemptId && input.requestId === interruptedLink.requestId)
      return fail(appError('storage_write_failed', 'storage', 'The original product linkage response remains unavailable until reopening.', true));
    const result = await reconcile.call(this, input);
    if (result.ok && gap?.kind === 'product-link' && input.attemptId !== gap.previousAttemptId
      && need(await currentNative().getSubmission(input)) !== null) {
      await recordGap(input);
      return fail(appError('storage_write_failed', 'storage', 'Controlled lost response after the real product linkage committed.', true));
    }
    return result;
  });
  deferCleanup(() => linkSpy.mockRestore());
  const createApplication = composition.createApplication;
  const appSpy = spyOn(composition, 'createApplication').mockImplementation(async options => {
    if (options.logger) {
      const logger = options.logger, write = logger.write.bind(logger);
      const logSpy = spyOn(logger, 'write').mockImplementation(event => {
        if (event.level === 'error') errors.push(event.code ?? event.event);
        write(event);
      });
      deferCleanup(() => logSpy.mockRestore());
    }
    const result = await createApplication(options);
    if (result.ok) app = result.data;
    return result;
  });
  deferCleanup(() => appSpy.mockRestore());
  const server = await createHttpProvider(async request => {
    const body = await request.json() as { messages: Array<{ role: string; content: string }> };
    const context = JSON.parse(body.messages.find(message => message.role === 'user')!.content) as InvoiceWorkWorkingContext;
    contexts.push(context);
    if (held) { const original = held; held = null; original.entered.resolve(); await original.release.promise; }
    if (failWorkIds.has(context.work.workId)) {
      rejected.push({ workId: context.work.workId, sessionId: context.work.sessionId,
        attemptId: context.phase.attemptId, requestId: context.phase.requestId });
      return new Response('Controlled original model rejection.', { status: 400 });
    }
    const documentId = context.item.documentRef.id, ordinal = body.messages.filter(message => message.role === 'tool').length;
    const candidate = invoiceWorkCandidateDraft();
    candidate.fields.totalAmount.sources = [{ documentId, version: context.item.documentRef.version,
      artifactId: parsedIds.get(documentId)!, page: 1, blockId: 'b1', quote: 'Total 113.00' }];
    let tool: { name: string; arguments: unknown } | null = null;
    if (ordinal === 0) tool = { name: 'read_invoice_document', arguments: { documentId, page: 1, afterBlockId: null, limit: 10 } };
    else if (ordinal === 1) tool = { name: 'save_invoice_candidate', arguments: { documentId, candidate } };
    const delta = tool ? { role: 'assistant', tool_calls: [{ index: 0, id: `trigger-tool-${contexts.length}`, type: 'function',
      function: { name: tool.name, arguments: JSON.stringify(tool.arguments) } }] }
      : { role: 'assistant', content: 'The original candidate requires human review.' };
    return new Response(`data: ${JSON.stringify({ id: `trigger-response-${contexts.length}`, object: 'chat.completion.chunk', created: 1,
      model: 'trigger-local-model', choices: [{ index: 0, delta, finish_reason: tool ? 'tool_calls' : 'stop' }] })}\n\ndata: [DONE]\n\n`,
    { headers: { 'content-type': 'text/event-stream' } });
  });
  deferCleanup(() => server.stop(true));
  const credentialRef = '00000000000000000000000000000092';
  const profile: ModelProfile = { id: 'trigger-local', name: 'Trigger local', credentialRef, kind: 'custom', providerId: null,
    baseUrl: `http://127.0.0.1:${server.port}/v1`, model: 'trigger-local-model', api: 'openai-completions',
    contextWindow: 64000, maxTokens: 8192, reasoning: false };
  const open = async () => {
    interruptedLink = null;
    owner = need(await createProductCommandDispatcher({ userDataRoot: root, invoiceSourceRoot: root, send: async () => {}, credentials: {
      read: async reference => {
        if (reference !== credentialRef) throw Error('The original credential reference changed.');
        return { type: 'api_key', key: 'controlled-trigger-key' };
      }, write: async () => { throw Error('No credential writes are authorized by this fixture.'); },
      delete: async () => { throw Error('No credential deletion is authorized by this fixture.'); },
    } }));
  };
  const close = async () => { const original = owner; owner = undefined; if (original) need(await original.close()); };
  deferCleanup(async () => { held?.release.resolve(); await close(); });
  await open();
  need(await currentOwner().settingsAuthority.withSettingsWrite(scope => scope.save({ ...defaultProductSettings(), revision: scope.current.revision,
    models: [profile], defaultModelId: profile.id })));
  const document = need(await currentApp().importPreparedInvoiceMaterial({ contract: 'flowmate-prepared-invoice/v1',
    sample: 'trigger-recovery-original', sourceText: 'Total 113.00', original: { name: 'source.md', base64: Buffer.from('Total 113.00').toString('base64') },
    pages: [{ page: 1, blocks: [{ id: 'b1', kind: 'text', text: 'Total 113.00', sourceIndex: 0, sourceType: 'prepared-text', bbox: null }] }] }));
  parsedIds.set(document.documentRef.id, document.parsedArtifactId);
  const originalAgent = need(await currentApp().personalAgent.get());
  const agent = need(await currentApp().personalAgent.update({ personalAgentId: originalAgent.personalAgentId, expectedRevision: originalAgent.revision,
    configuration: { ...originalAgent.configuration, modelId: profile.id, tools: ['read_invoice_document', 'save_invoice_candidate'],
      resources: { prompt: resources ? { kind: 'prompt', id: 'invoice', version: 'v1' } : null, enabledSkills: [] },
      extensions: { enabledExtensions: [] } } }));
  const create = (requestId: string) => currentApp().invoiceWorks.create({ personalAgentId: agent.personalAgentId,
    expectedAgentRevision: agent.revision, requestId, goal: 'Prepare the original fixed invoice for human review.', documents: [document.documentRef] }).then(need);
  const work = async (workId: number) => {
    const page = need(await currentApp().invoiceWorks.get({ view: 'work', workId, limit: 100 }));
    if (page.view !== 'work') throw Error('Expected the original fixed invoice.'); return page;
  };
  const supplement = async (workId: number, requestId: string, text: string) => {
    const current = await work(workId), selected = current.items[0]!;
    const page = need(await currentApp().invoiceWorks.get({ view: 'item', workId, itemId: selected.itemId }));
    if (page.view !== 'item') throw Error('Expected the original invoice Todo.');
    const todo = page.todos.find(value => value.applicable && value.action === 'supplement');
    if (!todo) throw Error('Expected the original required-field clarification.');
    return currentApp().invoiceWorks.supplement({ workId, itemId: selected.itemId, todoId: todo.todoId,
      expectedRevision: current.work.revision, requestId, text, materials: [] }).then(need);
  };
  const settled = async (workId: number, attemptId: number) => {
    await waitFor(async () => need(await currentApp().personalTasks.get({ workId, attemptId })).task.stoppedAt !== null, 20_000);
    return need(await currentApp().personalTasks.get({ workId, attemptId }));
  };
  const holdNext = () => {
    const next = { entered: Promise.withResolvers<void>(), release: Promise.withResolvers<void>() };
    held = next; deferCleanup(() => next.release.resolve()); return next;
  };
  const armGap = (kind: 'native-receipt' | 'product-link', previousAttemptId: number) => {
    const reached = Promise.withResolvers<{ query: DurableSubmissionQuery; nativeSubmissionId: number }>();
    gap = { kind, previousAttemptId, reached }; return reached.promise;
  };
  const notify = () => currentOwner().settingsAuthority.withSettingsWrite(scope => scope.save({ ...scope.current,
    profile: { ...scope.current.profile, displayName: `Committed condition notification ${scope.current.revision}` } })).then(need);
  const modelsAvailable = (available: boolean) => currentOwner().settingsAuthority.withSettingsWrite(scope => scope.save({ ...scope.current,
    models: available ? [profile] : [], defaultModelId: available ? profile.id : null })).then(need);
  return { root, databaseFile, bundleRoot, agent, document, contexts, submissions, rejected, errors, failWorkIds,
    app: currentApp, native: currentNative, owner: currentOwner, open, close, create, work, supplement, settled, holdNext, armGap, notify, modelsAvailable };
}

test.each(['native-receipt', 'product-link'] as const)('a real %s unknown result followed by legal clarification cold-recovers the original input and consumes the new input separately', async kind => {
  const f = await fixture(), created = await f.create('original-trigger-work');
  const initialAttempt = created.execution.attempt;
  if (!initialAttempt) throw Error('Expected the original accepted attempt.');
  need(await f.owner().startRecovery());
  expect((await f.settled(created.workId, initialAttempt.attemptId)).task.runStatus).toBe('completed');
  const gate = f.holdNext(), unknown = f.armGap(kind, initialAttempt.attemptId);
  const first = await f.supplement(created.workId, 'first-original-clarification', 'FIRST_ORIGINAL_PHASE_INPUT');
  if (!first.execution.authorizationAccepted) throw Error('Expected the original clarification authorization.');
  const original = await observed(unknown); await observed(gate.entered.promise);
  expect(original.query.attemptId).toBe(first.execution.attempt.attemptId);
  expect(need(await f.native().getSubmission(original.query))).toMatchObject({ nativeSubmissionId: original.nativeSubmissionId });
  const originalHttp = f.contexts.find(context => context.phase.requestId === original.query.requestId
    && context.phase.attemptId === original.query.attemptId);
  expect(originalHttp?.userInputs).toMatchObject([{ inputId: first.inputId, text: 'FIRST_ORIGINAL_PHASE_INPUT' }]);
  const second = await f.supplement(created.workId, 'second-original-clarification', 'SECOND_INPUT_AFTER_UNKNOWN_RECEIPT');
  expect(second.execution).toMatchObject({ kind: 'pending-boundary', authorizationAccepted: true,
    attempt: { attemptId: original.query.attemptId }, relation: 'original' });
  expect(originalHttp?.userInputs.some(input => input.inputId === second.inputId)).toBe(false);
  await f.close(); gate.release.resolve();
  const before = new Database(f.databaseFile, { readonly: true });
  let originalContext: string, originalEntry: string, originalEntryId: number;
  try {
    const phase = before.query<{ context_json: string; native_submission_id: number | null }, [number, string]>(`SELECT c.context_json,p.native_submission_id FROM invoice_work_phases p
      JOIN invoice_work_context_snapshots c ON c.phase_id=p.id WHERE p.attempt_id=? AND p.request_id=?`)
      .get(original.query.attemptId, original.query.requestId);
    if (!phase) throw Error('Expected the original immutable phase snapshot.'); originalContext = phase.context_json;
    expect(phase.native_submission_id).toBe(kind === 'native-receipt' ? null : original.nativeSubmissionId);
    const submission = before.query<{ record: string }, [number]>('SELECT record FROM fm_durable_submissions WHERE id=?').get(original.nativeSubmissionId);
    if (!submission) throw Error('Expected the real original SDK submission.');
    originalEntryId = z.object({ entry: z.number().int().positive() }).passthrough().parse(JSON.parse(submission.record)).entry;
    const entry = before.query<{ record: string }, [number]>('SELECT record FROM fm_durable_entries WHERE id=?').get(originalEntryId);
    if (!entry) throw Error('Expected the original committed SDK input Entry.'); originalEntry = entry.record;
    expect(originalContext).toContain('FIRST_ORIGINAL_PHASE_INPUT'); expect(originalContext).not.toContain('SECOND_INPUT_AFTER_UNKNOWN_RECEIPT');
  } finally { before.close(); }
  await f.open();
  expect(need(await f.app().invoiceWorks.queryOperation({ operation: 'supplement', workId: created.workId, requestId: second.requestId }))).toEqual(second);
  need(await f.owner().startRecovery());
  const final = await f.settled(created.workId, original.query.attemptId);
  expect(final.task).toMatchObject({ runStatus: 'completed', stopRequestedAt: null, attempt: { attemptId: original.query.attemptId } });
  expect(f.submissions.filter(query => query.attemptId === original.query.attemptId && query.requestId === original.query.requestId)).toHaveLength(1);
  const newer = f.contexts.filter(context => context.phase.attemptId === original.query.attemptId
    && context.phase.requestId !== original.query.requestId && context.userInputs.some(input => input.inputId === second.inputId));
  expect(newer.length).toBeGreaterThan(0);
  expect(newer.every(context => context.userInputs.some(input => input.text === 'SECOND_INPUT_AFTER_UNKNOWN_RECEIPT'))).toBe(true);
  expect(need(await f.app().invoiceWorks.queryOperation({ operation: 'supplement', workId: created.workId, requestId: first.requestId }))).toEqual(first);
  expect(need(await f.app().invoiceWorks.queryOperation({ operation: 'supplement', workId: created.workId, requestId: second.requestId }))).toEqual(second);
  await f.close();
  const after = new Database(f.databaseFile, { readonly: true });
  try {
    expect(after.query('SELECT record FROM fm_durable_entries WHERE id=?').get(originalEntryId!)).toEqual({ record: originalEntry! });
    expect(after.query(`SELECT c.context_json FROM invoice_work_phases p JOIN invoice_work_context_snapshots c ON c.phase_id=p.id
      WHERE p.attempt_id=? AND p.request_id=?`).get(original.query.attemptId, original.query.requestId)).toEqual({ context_json: originalContext! });
    const phases = after.query<{ request_id: string; native_submission_id: number | null; consumed_at: string | null; basis_json: string }, [number]>(
      'SELECT request_id,native_submission_id,consumed_at,basis_json FROM invoice_work_phases WHERE attempt_id=? ORDER BY id').all(original.query.attemptId);
    expect(phases.find(phase => phase.request_id === original.query.requestId)?.native_submission_id).toBe(original.nativeSubmissionId);
    const consumed = phases.filter(phase => z.object({ inputIds: z.array(z.number()) }).passthrough().parse(JSON.parse(phase.basis_json)).inputIds.includes(second.inputId));
    expect(consumed).toHaveLength(1); expect(consumed[0]!.request_id).not.toBe(original.query.requestId); expect(consumed[0]!.consumed_at).not.toBeNull();
    const originalTools = after.query<{ tool_name: string; result_json: string }, [number, string]>(
      `SELECT t.tool_name,t.result_json FROM tool_calls t JOIN invoice_work_tool_calls b ON b.tool_call_id=t.id
       JOIN invoice_work_phases p ON p.id=b.phase_id WHERE p.attempt_id=? AND p.request_id=? ORDER BY t.id`)
      .all(original.query.attemptId, original.query.requestId);
    expect(originalTools.map(tool => ({ name: tool.tool_name, result: JSON.parse(tool.result_json) }))).toMatchObject([
      { name: 'read_invoice_document', result: { status: 'succeeded' } },
      { name: 'save_invoice_candidate', result: { status: 'failed', error: { code: 'state_conflict' } } },
    ]);
    const successorSave = after.query<{ result_json: string }, [number, string]>(
      `SELECT t.result_json FROM tool_calls t JOIN invoice_work_tool_calls b ON b.tool_call_id=t.id
       JOIN invoice_work_phases p ON p.id=b.phase_id WHERE p.attempt_id=? AND p.request_id=? AND t.tool_name='save_invoice_candidate'`)
      .get(original.query.attemptId, consumed[0]!.request_id);
    if (!successorSave) throw Error('Expected the authorized successor candidate save.');
    expect(JSON.parse(successorSave.result_json)).toMatchObject({ status: 'succeeded' });
    expect(after.query('SELECT COUNT(*) count FROM invoice_work_attempts WHERE work_id=?').get(created.workId)).toEqual({ count: 2 });
  } finally { after.close(); }
}, 45_000);

test('an actual original HTTP failure after pending clarification does not authorize a successor phase', async () => {
  const f = await fixture(), created = await f.create('original-failing-recovery-work');
  if (!created.execution.attempt) throw Error('Expected the original accepted attempt.');
  need(await f.owner().startRecovery()); await f.settled(created.workId, created.execution.attempt.attemptId);
  const gate = f.holdNext(), unknown = f.armGap('native-receipt', created.execution.attempt.attemptId);
  const first = await f.supplement(created.workId, 'before-genuine-model-failure', 'FIRST_ORIGINAL_INPUT_BEFORE_FAILURE');
  if (!first.execution.authorizationAccepted) throw Error('Expected the original admitted clarification.');
  const original = await observed(unknown); await observed(gate.entered.promise);
  const second = await f.supplement(created.workId, 'pending-before-genuine-model-failure', 'PENDING_INPUT_REQUIRES_CONTINUE_AFTER_FAILURE');
  expect(second.execution).toMatchObject({ kind: 'pending-boundary', authorizationAccepted: true,
    attempt: { attemptId: original.query.attemptId }, relation: 'original' });
  await f.close(); gate.release.resolve(); f.failWorkIds.add(created.workId);
  await f.open(); need(await f.owner().startRecovery());
  const final = await f.settled(created.workId, original.query.attemptId);
  expect(f.rejected).toContainEqual(original.query);
  expect(final.task.runStatus).toBe('failed');
  expect(f.contexts.filter(context => context.phase.attemptId === original.query.attemptId
    && context.phase.requestId !== original.query.requestId)).toHaveLength(0);
  expect(need(await f.app().invoiceWorks.queryOperation({ operation: 'supplement', workId: created.workId, requestId: second.requestId }))).toEqual(second);
  await f.close();
  const audit = new Database(f.databaseFile, { readonly: true });
  try {
    expect(audit.query(`SELECT COUNT(*) count FROM invoice_work_phases p,json_each(p.basis_json,'$.inputIds') input
      WHERE p.attempt_id=? AND input.value=?`).get(original.query.attemptId, second.inputId)).toEqual({ count: 0 });
  } finally { audit.close(); }
  f.failWorkIds.delete(created.workId); await f.open(); need(await f.owner().startRecovery());
  const current = await f.work(created.workId);
  const continued = need(await f.app().invoiceWorks.continueWork({ workId: created.workId, requestId: 'explicit-continue-after-real-failure',
    expectedRevision: current.work.revision, expectedAttemptId: original.query.attemptId }));
  if (!continued.execution.authorizationAccepted) throw Error('Expected the explicitly authorized new attempt.');
  const continuedAttempt = continued.execution.attempt;
  expect(continuedAttempt.attemptId).not.toBe(original.query.attemptId);
  expect((await f.settled(created.workId, continuedAttempt.attemptId)).task.runStatus).toBe('completed');
  expect(need(await f.app().personalTasks.get({ workId: created.workId, attemptId: original.query.attemptId })).task.runStatus).toBe('failed');
  expect(f.contexts.some(context => context.phase.attemptId === continuedAttempt.attemptId
    && context.userInputs.some(input => input.inputId === second.inputId))).toBe(true);
}, 45_000);

test('restoring an admitted Work original resource bundle and publishing conditions starts only its existing authorization without continue', async () => {
  const f = await fixture(true), warm = await f.create('prepare-original-resource-version');
  if (!warm.execution.attempt) throw Error('Expected the original resource preparation attempt.');
  need(await f.owner().startRecovery()); await f.settled(warm.workId, warm.execution.attempt.attemptId);
  expect(existsSync(f.bundleRoot)).toBe(true);
  const heldBundle = join(f.root, 'held-original-resource-bundles'); renameSync(f.bundleRoot, heldBundle);
  const beforeErrors = f.errors.length, beforeRequests = f.contexts.length, created = await f.create('accepted-resource-blocked-work');
  expect(created.execution).toMatchObject({ authorizationAccepted: true, attempt: { runId: null } });
  const attempt = created.execution.attempt;
  if (!attempt) throw Error('Expected the already accepted original attempt.');
  await waitFor(async () => f.errors.length > beforeErrors);
  expect(f.errors.slice(beforeErrors)).toContain('resource_bundle_unavailable');
  expect(f.contexts).toHaveLength(beforeRequests);
  expect(need(await f.app().personalTasks.get({ workId: created.workId, attemptId: attempt.attemptId })).task)
    .toMatchObject({ attempt, stopRequestedAt: null, stoppedAt: null });
  renameSync(heldBundle, f.bundleRoot);
  await f.notify();
  const final = await f.settled(created.workId, attempt.attemptId);
  expect(final.task).toMatchObject({ runStatus: 'completed', attempt: { attemptId: attempt.attemptId }, stopRequestedAt: null });
  expect(need(await f.app().personalTasks.list({ workId: created.workId })).items).toHaveLength(1);
  expect(f.contexts.filter(context => context.work.workId === created.workId)).toHaveLength(3);
  expect(need(await f.app().invoiceWorks.queryOperation({ operation: 'create', personalAgentId: created.personalAgentId, requestId: created.requestId }))).toEqual(created);
}, 45_000);

test.each(['saved-only', 'stopped', 'failed'] as const)('a real production condition publication does not authorize a %s clarification while another accepted Work proceeds', async state => {
  const f = await fixture(true), created = await f.create(`original-${state}-work`);
  if (!created.execution.attempt) throw Error('Expected the original accepted attempt.');
  need(await f.owner().startRecovery()); await f.settled(created.workId, created.execution.attempt.attemptId);
  if (state === 'stopped') {
    const gate = f.holdNext(), admitted = await f.supplement(created.workId, 'before-original-stop', 'Original input before user stop.');
    if (!admitted.execution.authorizationAccepted) throw Error('Expected the original admitted clarification.');
    await observed(gate.entered.promise);
    const current = await f.work(created.workId);
    need(await f.app().personalTasks.stop({ workId: created.workId, attemptId: admitted.execution.attempt.attemptId,
      requestId: 'original-user-stop', expectedRevision: current.work.revision }));
    gate.release.resolve(); await f.settled(created.workId, admitted.execution.attempt.attemptId);
  } else if (state === 'failed') {
    f.failWorkIds.add(created.workId);
    const admitted = await f.supplement(created.workId, 'before-original-failure', 'Original input before actual HTTP failure.');
    if (!admitted.execution.authorizationAccepted) throw Error('Expected the original admitted clarification.');
    expect((await f.settled(created.workId, admitted.execution.attempt.attemptId)).task.runStatus).toBe('failed');
    f.failWorkIds.delete(created.workId);
  } else await f.modelsAvailable(false);
  const heldBundle = join(f.root, `held-${state}-resource-bundles`); renameSync(f.bundleRoot, heldBundle);
  const saved = await f.supplement(created.workId, `saved-${state}-clarification`, `SAVED_WITHOUT_NEW_AUTHORIZATION_${state}`);
  expect(saved.saved).toBe(true); expect(saved.execution.authorizationAccepted).toBe(false);
  const before = need(await f.app().personalTasks.list({ workId: created.workId })), requestCount = f.contexts.filter(context => context.work.workId === created.workId).length;
  if (state === 'saved-only') await f.modelsAvailable(true);
  const control = await f.create(`accepted-control-after-${state}`);
  if (!control.execution.attempt) throw Error('Expected the independently accepted control Work.');
  renameSync(heldBundle, f.bundleRoot); await f.notify();
  expect((await f.settled(control.workId, control.execution.attempt.attemptId)).task.runStatus).toBe('completed');
  expect(f.contexts.filter(context => context.work.workId === created.workId)).toHaveLength(requestCount);
  expect(need(await f.app().personalTasks.list({ workId: created.workId }))).toEqual(before);
  expect(need(await f.app().invoiceWorks.queryOperation({ operation: 'supplement', workId: created.workId, requestId: saved.requestId }))).toEqual(saved);
  expect(f.contexts.filter(context => context.work.workId === control.workId)).toHaveLength(3);
}, 45_000);
