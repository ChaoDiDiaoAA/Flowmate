import { afterAll, expect, test } from 'bun:test';
import { join } from 'node:path';
import { defaultProductSettings } from '@flowmate/core';
import { InvoiceWorkWorkingContextSchema, type DocumentSnapshot, type InvoiceWorkWorkingContext, type Result } from '@flowmate/contracts';
import * as P from '../../packages/contracts/src/personal-agent.ts';
import { createCredentialStore } from '../../packages/shared/src/secure-credential-store.ts';
import { createServiceSecureStorage } from '../../packages/shared/src/service-secure-storage.ts';
import { invoiceWorkCandidateDraft } from '../support/invoice-work-tools.ts';
import { waitFor } from '../support/resources.ts';
import { installOwnerFixture, ownerClient, packageOwnerFixture, removeOwnerFixture, spawnOwnerFixture } from './owner-fixture.ts';

type Body = { model: string; messages: Array<{ role: string; content: string }>; tools?: Array<{ function: { name: string } }> };
type Reply = { text: string; tool?: { name: string; arguments: unknown } };
type Receipt = P.InvoiceWorkCreateReceipt | P.InvoiceWorkContinueReceipt;
const key = 'synthetic-owner-matrix-key', credentialRef = 'owner_matrix_original_key_01';
let packaged: Awaited<ReturnType<typeof packageOwnerFixture>> | undefined;
afterAll(() => { if (packaged) removeOwnerFixture(packaged.root); });
function need<T>(result: Result<T>): T { if (!result.ok) throw Error(result.error.code + ': ' + result.error.message); return result.data; }
function attempt(receipt: Receipt) {
  if (!('attempt' in receipt.execution) || !receipt.execution.attempt) throw Error('Expected the original accepted attempt.');
  return { workId: receipt.workId, attemptId: receipt.execution.attempt.attemptId };
}

async function fixture(respond: (body: Body, context: InvoiceWorkWorkingContext) => Promise<Reply>) {
  packaged ??= await packageOwnerFixture();
  const installation = await installOwnerFixture(packaged.runtimeRoot);
  let owner = await spawnOwnerFixture(installation), client = await ownerClient(installation);
  const children = new Set([owner.child]), wires: Array<{ body: Body; context: InvoiceWorkWorkingContext }> = [];
  const server = Bun.serve({ hostname: '127.0.0.1', port: 0, async fetch(request) {
    expect(request.headers.get('authorization')).toBe('Bearer ' + key);
    const body = await request.json() as Body;
    const context = InvoiceWorkWorkingContextSchema.parse(JSON.parse(body.messages.filter(message => message.role === 'user').at(-1)!.content));
    wires.push({ body, context });
    const reply = await respond(body, context);
    const delta = reply.tool ? { role: 'assistant', content: reply.text, tool_calls: [{ index: 0,
      id: 'owner-matrix-call-' + wires.length, type: 'function',
      function: { name: reply.tool.name, arguments: JSON.stringify(reply.tool.arguments) } }] } : { role: 'assistant', content: reply.text };
    return new Response('data: ' + JSON.stringify({ id: 'owner-matrix-response-' + wires.length, object: 'chat.completion.chunk',
      created: 1, model: body.model, choices: [{ index: 0, delta, finish_reason: reply.tool ? 'tool_calls' : 'stop' }] })
      + '\n\ndata: [DONE]\n\n', { headers: { 'content-type': 'text/event-stream' } });
  } });
  async function dispose() {
    client.socket.destroy();
    try {
      if (owner.child.exitCode === null) {
        const closed = await owner.close();
        if (!closed.ok || !closed.data.closed) {
          const child = owner.child;
          if (!children.has(child) || !Number.isSafeInteger(child.pid) || child.pid <= 0 || child.pid === process.pid)
            throw Error('The matrix fixture does not own this child process.');
          child.kill('SIGKILL'); // Fixture cleanup is not product stop confirmation.
        }
        await owner.child.exited;
      }
    } finally {
      server.stop(true);
      if (owner.child.exitCode !== null) removeOwnerFixture(installation.dataRoot);
    }
  }
  try {
    need(await createCredentialStore(join(installation.dataRoot, 'security/service-credentials', credentialRef + '.json'),
      createServiceSecureStorage(installation.ownerSid)).write(JSON.stringify({ type: 'api_key', key })));
    const profile = { id: 'owner-matrix', name: 'Owner matrix', credentialRef, kind: 'custom', providerId: null,
      baseUrl: 'http://127.0.0.1:' + server.port + '/v1', model: 'owner-matrix', api: 'openai-completions',
      contextWindow: 64000, maxTokens: 8192, reasoning: false };
    need(await client.call({ type: 'save_settings', settings: { ...defaultProductSettings(), revision: 0,
      models: [profile, { ...profile, id: 'owner-matrix-missing', name: 'Missing original key',
        credentialRef: 'owner_matrix_missing_key_01' }], defaultModelId: profile.id } }));
    const sourceText = 'Controlled invoice total 113.00';
    const document = need(await client.call<DocumentSnapshot>({ type: 'import_prepared_invoice_material', input: {
      contract: 'flowmate-prepared-invoice/v1', sample: 'owner-recovery-matrix', sourceText,
      original: { name: 'source.md', base64: Buffer.from(sourceText).toString('base64') },
      pages: [{ page: 1, blocks: [{ id: 'b1', kind: 'text', text: sourceText, sourceIndex: 0, sourceType: 'prepared-text', bbox: null }] }],
    } }));
    async function useModel(modelId: string) {
      const original = P.PersonalAgentSnapshotSchema.parse(need(await client.call({ type: 'personal_agent_get', input: {} })));
      return P.PersonalAgentSnapshotSchema.parse(need(await client.call({ type: 'personal_agent_update', input: {
        personalAgentId: original.personalAgentId, expectedRevision: original.revision, configuration: { ...original.configuration, modelId,
          tools: ['Agent', 'read_invoice_document', 'save_invoice_candidate'], resources: { prompt: null, enabledSkills: [] },
          extensions: { enabledExtensions: [] }, preferences: '' },
      } })));
    }
    await useModel(profile.id);
    async function create(requestId: string, goal: string) {
      const agent = P.PersonalAgentSnapshotSchema.parse(need(await client.call({ type: 'personal_agent_get', input: {} })));
      return P.InvoiceWorkCreateReceiptSchema.parse(need(await client.call({ type: 'invoice_work_create', input: {
        personalAgentId: agent.personalAgentId, expectedAgentRevision: agent.revision, requestId, goal, documents: [document.documentRef],
      } })));
    }
    async function work(workId: number) {
      const value = P.InvoiceWorkGetResultSchema.parse(need(await client.call({ type: 'invoice_work_get', input: { view: 'work', workId, limit: 20 } })));
      if (value.view !== 'work') throw Error('Expected the original Work view.'); return value;
    }
    async function task(receipt: Receipt) {
      return P.PersonalTaskGetResultSchema.parse(need(await client.call({ type: 'personal_task_get', input: { ...attempt(receipt), limit: 20 } })));
    }
    async function ended(receipt: Receipt) {
      await waitFor(async () => (await task(receipt)).task.stoppedAt !== null, 20_000); return task(receipt);
    }
    return { installation, document, wires, get client() { return client; }, create, work, task, ended, useModel, dispose,
      async restart() {
        client.socket.destroy();
        expect(await owner.close()).toMatchObject({ ok: true, data: { stopped: true, closed: true } });
        expect(await owner.child.exited).toBe(0);
        owner = await spawnOwnerFixture(installation); children.add(owner.child); client = await ownerClient(installation);
      } };
  } catch (error) { await dispose(); throw error; }
}

test('real service RPC stops one attempt without cancelling its Work, then cancels the same Work without replacing its original stop receipt', async () => {
  let release = () => {};
  let gate = new Promise<void>(resolve => { release = resolve; });
  const f = await fixture(async () => { await gate; return { text: 'The original invoice needs human review.' }; });
  try {
    const created = await f.create('matrix-stop-create', 'Compare explicit stop and business cancellation.');
    await waitFor(async () => f.wires.length === 1, 15_000);
    const first = await f.task(created), current = await f.work(created.workId), requestId = 'matrix-original-stop';
    const stopped = P.PersonalTaskStopReceiptSchema.parse(need(await f.client.call({ type: 'personal_task_stop',
      input: { ...attempt(created), expectedRevision: current.work.revision, requestId } })));
    release(); await f.ended(created);
    const open = await f.work(created.workId);
    expect(open.work).toMatchObject({ status: 'open', counts: { unresolved: 1 }, execution: { requiresContinue: true } });
    const stopQuery = P.PersonalTaskGetResultSchema.parse(need(await f.client.call({ type: 'personal_task_get',
      input: { ...attempt(created), stopRequestId: requestId, limit: 20 } })));
    expect(stopQuery.stopReceipt).toMatchObject({ requestId: stopped.requestId, workId: created.workId, attemptId: first.task.attempt.attemptId });
    const originalTerminal = stopQuery.task;
    gate = new Promise<void>(resolve => { release = resolve; });
    const continued = P.InvoiceWorkContinueReceiptSchema.parse(need(await f.client.call({ type: 'invoice_work_continue', input: {
      workId: created.workId, expectedRevision: open.work.revision, expectedAttemptId: first.task.attempt.attemptId, requestId: 'matrix-original-continue',
    } })));
    await waitFor(async () => f.wires.length === 2, 15_000);
    expect(attempt(continued).attemptId).not.toBe(first.task.attempt.attemptId);
    const running = await f.work(created.workId);
    const cancelled = P.InvoiceWorkCancelReceiptSchema.parse(need(await f.client.call({ type: 'invoice_work_cancel', input: {
      workId: created.workId, expectedRevision: running.work.revision, requestId: 'matrix-original-cancel',
    } })));
    expect((await f.work(created.workId)).work.status).toBe('cancelled');
    release(); await f.ended(continued);
    expect((await f.task(created)).task).toEqual(originalTerminal);
    expect(await f.client.call({ type: 'invoice_work_query_operation', input: {
      operation: 'cancelWork', workId: created.workId, requestId: cancelled.requestId,
    } })).toEqual({ ok: true, data: cancelled });
    expect((await f.work(created.workId)).work.counts.accepted).toBe(0);
    expect(f.wires).toHaveLength(2);
  } finally { release(); await f.dispose(); }
}, 90_000);

test('a real service Master and child retain their original report, delivery and history through disconnect and owner reopen without new model requests', async () => {
  const report = 'OWNER_CHILD_REPORT: the original total is 113.00 and still requires human review.';
  const f = await fixture(async (body, context) => {
    const ordinal = body.messages.filter(message => message.role === 'tool').length;
    if (context.delegation) {
      if (ordinal === 0) return { text: '', tool: { name: 'read_invoice_document',
        arguments: { documentId: context.item.documentRef.id, page: 1, afterBlockId: null, limit: 10 } } };
      return { text: report };
    }
    if (ordinal === 0) return { text: '', tool: { name: 'Agent', arguments: { subagent_type: 'invoice-evidence-checker',
      run_in_background: false, description: 'Check this original invoice source', prompt: 'Check the current invoice total against its original source and report uncertainty.' } } };
    expect(body.messages.some(message => message.role === 'tool' && message.content.includes(report))).toBe(true);
    return { text: 'The original child report is available for human review.' };
  });
  try {
    const created = await f.create('matrix-parent-child-create', 'Verify this invoice with one read-only evidence checker.');
    const before = await f.ended(created);
    expect(before.children).toHaveLength(1);
    const child = before.children[0]!;
    expect(child).toMatchObject({ runStatus: 'completed', resultRecorded: true, stopConfirmed: true,
      delivery: { state: 'message_observed' }, parentModelReceivedAt: expect.any(String) });
    const childRun = need(await f.client.call({ type: 'query_run', runId: child.childRunId }));
    const history = need(await f.client.call({ type: 'personal_task_history', input: { target: { workId: created.workId, childRunId: child.childRunId }, limit: 100 } }));
    const timeline = need(await f.client.call({ type: 'invoice_work_timeline', input: { workId: created.workId, limit: 100 } }));
    const count = f.wires.length;
    expect(f.wires.filter(value => value.context.delegation)).toHaveLength(2);
    expect(f.wires.filter(value => !value.context.delegation)).toHaveLength(2);
    await f.restart();
    expect(await f.task(created)).toEqual(before);
    expect(await f.client.call({ type: 'query_run', runId: child.childRunId })).toEqual({ ok: true, data: childRun });
    expect(await f.client.call({ type: 'personal_task_history', input: { target: { workId: created.workId, childRunId: child.childRunId }, limit: 100 } }))
      .toEqual({ ok: true, data: history });
    expect(await f.client.call({ type: 'invoice_work_timeline', input: { workId: created.workId, limit: 100 } })).toEqual({ ok: true, data: timeline });
    expect((await f.work(created.workId)).work).toMatchObject({ status: 'open', counts: { accepted: 0, unresolved: 1 } });
    expect(f.wires).toHaveLength(count);
  } finally { await f.dispose(); }
}, 90_000);

test('one real service root classifies saved human-waiting, stopped, cancelled, credential-blocked, recovering and queued Work without query-triggered scheduling', async () => {
  let release = () => {}, gate = new Promise<void>(resolve => { release = resolve; });
  let hold = false, document: DocumentSnapshot;
  const f = await fixture(async (body, context) => {
    if (hold && ['matrix-stopped', 'matrix-recovering'].includes(context.work.goal)) await gate;
    if (context.work.goal === 'matrix-human-review' && body.messages.every(message => message.role !== 'tool')) {
      const candidate = invoiceWorkCandidateDraft();
      candidate.fields.totalAmount.sources = [{ documentId: document.documentRef.id, version: document.documentRef.version,
        artifactId: document.parsedArtifactId, page: 1, blockId: 'b1', quote: '113.00' }];
      return { text: '', tool: { name: 'save_invoice_candidate', arguments: { documentId: document.documentRef.id, candidate } } };
    }
    return { text: 'Retain the original invoice until an explicit human decision.' };
  });
  document = f.document;
  try {
    const review = await f.create('matrix-human-review', 'matrix-human-review'); await f.ended(review);
    expect((await f.work(review.workId)).items[0]!.candidateRef).not.toBeNull();
    hold = true;
    const stopped = await f.create('matrix-stopped', 'matrix-stopped');
    await waitFor(async () => f.wires.some(value => value.context.work.workId === stopped.workId), 15_000);
    need(await f.client.call({ type: 'personal_task_stop', input: { ...attempt(stopped),
      expectedRevision: (await f.work(stopped.workId)).work.revision, requestId: 'matrix-persisted-stop' } }));
    release(); await f.ended(stopped); hold = false;
    const cancelled = await f.create('matrix-cancelled', 'matrix-cancelled'); await f.ended(cancelled);
    need(await f.client.call({ type: 'invoice_work_cancel', input: { workId: cancelled.workId,
      expectedRevision: (await f.work(cancelled.workId)).work.revision, requestId: 'matrix-persisted-cancel' } }));
    await f.useModel('owner-matrix-missing');
    const blocked = await f.create('matrix-credential-blocked', 'matrix-credential-blocked');
    expect(blocked.execution).toMatchObject({ kind: 'blocked', authorizationAccepted: false, reason: { code: 'model_credential_missing' } });
    await f.useModel('owner-matrix');
    gate = new Promise<void>(resolve => { release = resolve; }); hold = true;
    const recovering = await f.create('matrix-recovering', 'matrix-recovering');
    await waitFor(async () => f.wires.some(value => value.context.work.workId === recovering.workId), 15_000);
    const queued = await f.create('matrix-queued', 'matrix-queued');
    expect(queued.execution).toMatchObject({ kind: 'queued', authorizationAccepted: true });
    const preserved = await Promise.all([f.work(review.workId), f.work(stopped.workId), f.work(cancelled.workId), f.work(blocked.workId)]);
    const runningTask = await f.task(recovering), queuedTask = await f.task(queued), before = f.wires.length;
    expect(queuedTask.task).toMatchObject({ queued: true, attempt: { runId: null } });
    await f.restart();
    await waitFor(async () => f.wires.length === before + 1, 20_000);
    for (let index = 0; index < 3; index++) {
      expect(await Promise.all([f.work(review.workId), f.work(stopped.workId), f.work(cancelled.workId), f.work(blocked.workId)])).toEqual(preserved);
      expect((await f.task(recovering)).task.attempt).toEqual(runningTask.task.attempt);
      expect((await f.task(queued)).task).toEqual(queuedTask.task);
      expect(await f.client.call({ type: 'invoice_work_query_operation', input: { operation: 'create',
        personalAgentId: blocked.personalAgentId, requestId: blocked.requestId } })).toEqual({ ok: true, data: blocked });
    }
    expect(preserved[0]!.work).toMatchObject({ status: 'open', execution: { requiresContinue: false, runStatus: 'completed' } });
    expect(preserved[1]!.work).toMatchObject({ status: 'open', execution: { requiresContinue: true } });
    expect(preserved[2]!.work.status).toBe('cancelled');
    expect(preserved[3]!.work).toMatchObject({ status: 'open', execution: { attempt: null } });
    expect(f.wires).toHaveLength(before + 1);
    release(); await f.ended(recovering); await f.ended(queued);
    expect(f.wires).toHaveLength(before + 2);
  } finally { release(); await f.dispose(); }
}, 90_000);
