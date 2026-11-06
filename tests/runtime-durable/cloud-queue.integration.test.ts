import { expect, test } from 'bun:test';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { BACKGROUND_CONTEXT } from '@earendil-works/chord/context';
import { createModels, InMemoryCredentialStore, InMemoryModelsStore } from '@earendil-works/pi-ai';
import { createRegistry, Harness, InboxDoc, type ConversationId, type SubmissionId } from '@earendil-works/pi-durable';
import { appError, fail, ok, type Result } from '@flowmate/contracts';
import { openCloudRuntimeStore } from '../../apps/cloud-runtime-storage.ts';
import { createCloudRuntimeRouter } from '../../apps/cloud-runtime-router.ts';
import { createDurableRuntime } from '../../packages/runtime-durable/src/runtime.ts';
import { createDurableQueueController } from '../../packages/runtime-durable/src/queue.ts';
import { mkdtempSync } from '../support/resources.ts';

function need<T>(result: Result<T>): T { if (!result.ok) throw Error(result.error.code); return result.data; }
const binding = { workspaceId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', cloudRuntimeId: '11111111-1111-4111-8111-111111111111', workId: 1, sessionId: 11 };
const owner = { workId: binding.workId, sessionId: binding.sessionId, attemptId: 7 };
const models = () => createModels({ credentials: new InMemoryCredentialStore(), modelsStore: new InMemoryModelsStore() });

test('queue controls preserve internal writes, original requests and the same receipt after reopen', async () => {
  const root = mkdtempSync(join(tmpdir(), 'flowmate-cloud-queue-')), store = need(await openCloudRuntimeStore(root));
  let session = need(await store.openSession(binding, true));
  const initial = need(await createDurableRuntime({ storage: session.storage, readApiKey: () => undefined,
    verifyModelUse: () => ok(undefined), reserveModelRequest: () => ok(undefined) }));
  const conversationId = need(await initial.openConversation({ workId: owner.workId, sessionId: owner.sessionId })).nativeConversationId as ConversationId;
  need(await initial.close()); need(await session.close()); session = need(await store.openSession(binding, false));
  let harness = await Harness.open(session.storage, { models: models(), registry: createRegistry() }, BACKGROUND_CONTEXT);
  try {
    const ids = await harness.commit(async tx => {
      const inbox = await tx.doc(InboxDoc, conversationId), results: SubmissionId[] = [];
      for (const [requestId, text] of [['first', 'Original first'], ['second', 'Original second']] as const) {
        const submission = await tx.createSubmission({ type: 'input', conversationId, status: 'queued', requestId: JSON.stringify([owner.attemptId, requestId]) });
        inbox.items.push({ id: submission.id, mode: 'followUp', content: text, entry: { kind: 'flowmate.input', data: { ...owner, requestId,
          configName: 'controlled', configRevision: 1, thinkingLevel: 'off', inputText: text } } });
        results.push(submission.id);
        if (requestId === 'first') {
          const write = await tx.createSubmission({ type: 'write', conversationId, status: 'queued', requestId: 'internal-write' });
          inbox.items.push({ id: write.id, mode: 'write', entry: { kind: 'controlled.internal', data: { preserved: true } } });
          results.push(write.id);
        }
      }
      return results;
    }, BACKGROUND_CONTEXT);
    let queue = createDurableQueueController({ harness, resolve: async () => conversationId });
    const before = need(await queue.read(owner));
    expect(before.items.map(item => item.submissionId)).toEqual([ids[0], ids[2]]);
    const request = { ...owner, controlRequestId: 'original-reorder', expectedVersion: before.version,
      action: { kind: 'reorder' as const, submissionIds: [ids[2]!, ids[0]!] } };
    const receipt = need(await queue.apply(request)); expect(receipt.status).toBe('applied');
    expect(need(await queue.apply(request))).toEqual(receipt);
    expect(await queue.apply({ ...request, action: { kind: 'reorder', submissionIds: [ids[0]!, ids[2]!] } })).toMatchObject({ ok: false });
    expect((await harness.snapshot(InboxDoc, conversationId, BACKGROUND_CONTEXT))!.items.map(item => item.id)).toEqual([ids[2], ids[1], ids[0]]);
    await harness.close(BACKGROUND_CONTEXT); need(await session.close()); session = need(await store.openSession(binding, false));
    harness = await Harness.open(session.storage, { models: models(), registry: createRegistry() }, BACKGROUND_CONTEXT);
    queue = createDurableQueueController({ harness, resolve: async () => conversationId });
    expect(need(await queue.queryControl({ ...owner, controlRequestId: request.controlRequestId }))).toEqual(receipt);
    const current = need(await queue.read(owner));
    const edit = need(await queue.apply({ ...owner, controlRequestId: 'original-edit', expectedVersion: current.version,
      action: { kind: 'edit', submissionId: ids[0]!, content: 'Authorized revised first' } }));
    expect(edit.status).toBe('applied');
    const item = (await harness.snapshot(InboxDoc, conversationId, BACKGROUND_CONTEXT))!.items.find(value => value.id === ids[0]);
    expect(item).toMatchObject({ content: 'Authorized revised first', entry: { data: { inputText: 'Original first' } } });
    const changed = need(await queue.read(owner));
    await harness.commit(async tx => { const inbox = await tx.doc(InboxDoc, conversationId);
      const index = inbox.items.findIndex(value => value.id === ids[2]); inbox.items.splice(index, 1);
      tx.settleSubmission(ids[2]!, { status: 'unanswered', reason: 'controlled-placement-race' }); }, BACKGROUND_CONTEXT);
    const conflict = need(await queue.apply({ ...owner, controlRequestId: 'stale-reorder', expectedVersion: changed.version,
      action: { kind: 'reorder', submissionIds: [ids[0]!, ids[2]!] } }));
    expect(conflict.status).toBe('conflict');
    expect((await harness.snapshot(InboxDoc, conversationId, BACKGROUND_CONTEXT))!.items.map(value => value.id)).toEqual([ids[1], ids[0]]);
    const refreshed = need(await queue.read(owner));
    const mode = need(await queue.apply({ ...owner, controlRequestId: 'original-steer', expectedVersion: refreshed.version,
      action: { kind: 'mode', submissionId: ids[0]!, mode: 'steer' } }));
    expect(mode.status).toBe('applied'); expect(need(await queue.read(owner)).items[0]?.mode).toBe('steer');
    const cancelled = need(await queue.apply({ ...owner, controlRequestId: 'original-cancel', expectedVersion: mode.version,
      action: { kind: 'cancel', submissionId: ids[0]! } }));
    expect(cancelled.status).toBe('applied');
    expect(await harness.commit(tx => tx.submissionByRequest(conversationId, JSON.stringify([owner.attemptId, 'first'])), BACKGROUND_CONTEXT))
      .toMatchObject({ status: 'unanswered', reason: 'cloud-queue-cancelled' });
    expect((await harness.snapshot(InboxDoc, conversationId, BACKGROUND_CONTEXT))!.items.map(value => value.id)).toEqual([ids[1]]);
  } finally { await harness.close(BACKGROUND_CONTEXT); need(await session.close()); need(await store.close()); }
}, 15_000);

test('Runtime router reauthorizes the original queue before applying a control', async () => {
  const root = mkdtempSync(join(tmpdir(), 'flowmate-cloud-queue-router-')), store = need(await openCloudRuntimeStore(root));
  let session = need(await store.openSession(binding, true));
  const options = { readApiKey: () => undefined, verifyModelUse: () => ok(undefined), reserveModelRequest: () => ok(undefined) };
  const initial = need(await createDurableRuntime({ ...options, storage: session.storage }));
  const conversationId = need(await initial.openConversation({ workId: owner.workId, sessionId: owner.sessionId })).nativeConversationId as ConversationId;
  need(await initial.close()); need(await session.close()); session = need(await store.openSession(binding, false));
  const harness = await Harness.open(session.storage, { models: models(), registry: createRegistry() }, BACKGROUND_CONTEXT);
  const submissionId = await harness.commit(async tx => {
    const inbox = await tx.doc(InboxDoc, conversationId), submission = await tx.createSubmission({ type: 'input', conversationId,
      status: 'queued', requestId: JSON.stringify([owner.attemptId, 'original']) });
    inbox.items.push({ id: submission.id, mode: 'followUp', content: 'Original input', entry: { kind: 'flowmate.input',
      data: { ...owner, requestId: 'original', configName: 'controlled', configRevision: 1, thinkingLevel: 'off', inputText: 'Original input' } } });
    return submission.id;
  }, BACKGROUND_CONTEXT);
  await harness.close(BACKGROUND_CONTEXT); need(await session.close());
  let allowed = true;
  const router = createCloudRuntimeRouter({ store, runtimeOptions: options, authorize: () => allowed
    ? ok({ binding, state: 'ready' as const, nativeConversationId: conversationId })
    : fail(appError('cloud_access_denied', 'runtime', 'Controlled denial.')) });
  try {
    const before = need(await router.queue.read(owner));
    const command = { ...owner, controlRequestId: 'original-cancel', expectedVersion: before.version,
      action: { kind: 'cancel' as const, submissionId } };
    allowed = false; expect(await router.queue.apply(command)).toMatchObject({ ok: false, error: { code: 'cloud_access_denied' } });
    allowed = true; expect(need(await router.queue.read(owner)).items).toHaveLength(1);
    expect(need(await router.queue.apply(command)).status).toBe('applied');
    expect(need(await router.queue.queryControl({ ...owner, controlRequestId: command.controlRequestId }))).toMatchObject({ status: 'applied' });
    expect(need(await router.queue.read(owner)).items).toHaveLength(0);
  } finally { need(await router.close()); need(await store.close()); }
}, 15_000);

test('an authorized running phase can enqueue one original steer or follow-up without starting a new phase', async () => {
  const root = mkdtempSync(join(tmpdir(), 'flowmate-cloud-queue-input-')), store = need(await openCloudRuntimeStore(root));
  let session = need(await store.openSession(binding, true));
  const initial = need(await createDurableRuntime({ storage: session.storage, readApiKey: () => undefined,
    verifyModelUse: () => ok(undefined), reserveModelRequest: () => ok(undefined) }));
  const conversationId = need(await initial.openConversation({ workId: owner.workId, sessionId: owner.sessionId })).nativeConversationId as ConversationId;
  need(await initial.close()); need(await session.close()); session = need(await store.openSession(binding, false));
  let harness = await Harness.open(session.storage, { models: models(), registry: createRegistry() }, BACKGROUND_CONTEXT), active = true;
  try {
    let queue = createDurableQueueController({ harness, resolve: async () => conversationId, activePhase: async () => active });
    const before = need(await queue.read(owner));
    const command = { ...owner, controlRequestId: 'original-followup', expectedVersion: before.version,
      action: { kind: 'enqueue' as const, phaseRequestId: 'original-phase', mode: 'followUp' as const, content: 'Check the original total.' } };
    const receipt = need(await queue.apply(command)); expect(receipt).toMatchObject({ status: 'applied', submissionId: expect.any(Number) });
    expect(need(await queue.apply(command))).toEqual(receipt);
    expect(await queue.apply({ ...command, action: { ...command.action, content: 'Different original.' } })).toMatchObject({ ok: false });
    expect(need(await queue.read(owner)).items).toMatchObject([{ submissionId: receipt.submissionId, requestId: 'original-phase',
      mode: 'followUp', content: 'Check the original total.' }]);
    active = false;
    const denied = need(await queue.apply({ ...command, controlRequestId: 'late-steer', expectedVersion: receipt.version,
      action: { ...command.action, mode: 'steer', content: 'Too late.' } }));
    expect(denied.status).toBe('conflict'); expect(denied.submissionId).toBeUndefined();
    await harness.close(BACKGROUND_CONTEXT); need(await session.close()); session = need(await store.openSession(binding, false));
    harness = await Harness.open(session.storage, { models: models(), registry: createRegistry() }, BACKGROUND_CONTEXT);
    queue = createDurableQueueController({ harness, resolve: async () => conversationId, activePhase: async () => false });
    expect(need(await queue.queryControl({ ...owner, controlRequestId: command.controlRequestId }))).toEqual(receipt);
    expect(need(await queue.read(owner)).items).toHaveLength(1);
  } finally { await harness.close(BACKGROUND_CONTEXT); need(await session.close()); need(await store.close()); }
}, 15_000);
