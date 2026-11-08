import { expect, spyOn, test } from 'bun:test';
import { chmodSync, existsSync, mkdirSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import { Database } from 'bun:sqlite';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { BACKGROUND_CONTEXT } from '@earendil-works/chord/context';
import { createModels, InMemoryCredentialStore, InMemoryModelsStore } from '@earendil-works/pi-ai';
import { createRegistry, defineDoc, defineTask, Harness, type ConversationId } from '@earendil-works/pi-durable';
import { SqliteStorage } from '@earendil-works/pi-durable/storage/sqlite';
import { appError, fail, ok, type DurableRuntimePort, type Result } from '@flowmate/contracts';
import { openCloudRuntimeStore } from '../../apps/cloud-runtime-storage.ts';
import { createDurableRuntime } from '../../packages/runtime-durable/src/runtime.ts';
import { mkdtempSync, waitFor } from '../support/resources.ts';

function need<T>(result: Result<T>): T { if (!result.ok) throw Error(result.error.code); return result.data; }
const workspaceId = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const owner = (cloudRuntimeId: string, workId: number, sessionId: number) => ({ workspaceId, cloudRuntimeId, workId, sessionId });
const first = owner('11111111-1111-4111-8111-111111111111', 1, 11);
const second = owner('22222222-2222-4222-8222-222222222222', 2, 22);
const models = () => createModels({ credentials: new InMemoryCredentialStore(), modelsStore: new InMemoryModelsStore(),
  authContext: { env: async () => undefined, fileExists: async () => false } });

test('cloud sessions keep independent real Durable databases and reopen only their original binding', async () => {
  const root = mkdtempSync(join(tmpdir(), 'flowmate-cloud-storage-'));
  const store = need(await openCloudRuntimeStore(root));
  try {
    const [a, b] = await Promise.all([store.openSession(first, true), store.openSession(second, true)]);
    const one = need(a), two = need(b);
    const exposed = (one as { binding?: object }).binding;
    if (exposed) Reflect.set(exposed, 'workId', 9);
    expect(need(await store.openSession(first, false))).toBe(one);
    expect(await store.openSession({ ...first, workId: 9 }, false)).toMatchObject({ ok: false, error: { code: 'cloud_runtime_owner_conflict' } });
    const options = { readApiKey: () => undefined, verifyModelUse: () => ok(undefined), reserveModelRequest: () => ok(undefined) };
    const firstRuntime = need(await createDurableRuntime({ ...options, storage: one.storage }));
    const secondRuntime = need(await createDurableRuntime({ ...options, storage: two.storage }));
    const aConversation = need(await firstRuntime.openConversation({ workId: first.workId, sessionId: first.sessionId }));
    const bConversation = need(await secondRuntime.openConversation({ workId: second.workId, sessionId: second.sessionId }));
    expect(aConversation.nativeConversationId).toBe(bConversation.nativeConversationId);
    need(await firstRuntime.close()); need(await secondRuntime.close());
    need(await one.close()); need(await two.close());
    const reopened = need(await store.openSession(first, false));
    expect(await reopened.storage.conversation(aConversation.nativeConversationId as ConversationId, BACKGROUND_CONTEXT))
      .toMatchObject({ id: aConversation.nativeConversationId });
    expect(await store.openSession({ ...first, workspaceId: second.cloudRuntimeId }, false))
      .toMatchObject({ ok: false, error: { code: 'cloud_runtime_owner_conflict' } });
    need(await reopened.close());
  } finally { need(await store.close()); }
});

test('cloud storage reopens the original Work and its separate invoice conversations', async () => {
  const root = mkdtempSync(join(tmpdir(), 'flowmate-cloud-item-owners-')), store = need(await openCloudRuntimeStore(root));
  let session = need(await store.openSession(first, true));
  const options = { readApiKey: () => undefined, verifyModelUse: () => ok(undefined), reserveModelRequest: () => ok(undefined) };
  let runtime = need(await createDurableRuntime({ ...options, storage: session.storage }));
  try {
    const original = { workId: first.workId, sessionId: first.sessionId };
    const rootConversation = need(await runtime.openConversation(original));
    const a = need(await runtime.openConversation({ ...original, itemId: 101 }));
    const b = need(await runtime.openConversation({ ...original, itemId: 102 }));
    need(await runtime.close()); need(await session.close());
    session = need(await store.openSession(first, false));
    runtime = need(await createDurableRuntime({ ...options, storage: session.storage }));
    expect(need(await runtime.openConversation(original))).toEqual(rootConversation);
    expect(need(await runtime.openConversation({ ...original, itemId: 101 }))).toEqual(a);
    expect(need(await runtime.openConversation({ ...original, itemId: 102 }))).toEqual(b);
  } finally { await runtime.close(); need(await session.close()); need(await store.close()); }
});

test('cloud storage reopens distinct primary and reviewer native conversations for the same invoice', async () => {
  const root = mkdtempSync(join(tmpdir(), 'flowmate-cloud-review-owner-')), store = need(await openCloudRuntimeStore(root));
  const session = need(await store.openSession(first, true));
  const harness = await Harness.open(session.storage, { models: models(), registry: createRegistry() }, BACKGROUND_CONTEXT);
  const binding = defineDoc({ kind: 'flowmate.runtime.binding', version: 3, scope: 'conversation', history: 'latest', fork: 'initial',
    initial: (): { workId: number; sessionId: number; itemId: number | null; participant: 'reviewer' | null; attemptId: null; requestKey: null } =>
      ({ workId: first.workId, sessionId: first.sessionId, itemId: null, participant: null, attemptId: null, requestKey: null }), checkpointWhen: () => true });
  try {
    await harness.commit(async tx => {
      for (const participant of [null, 'reviewer'] as const) {
        const conversation = await tx.createConversation({ ownership: { kind: 'ownerless' } });
        const saved = await tx.doc(binding, conversation.id);
        saved.itemId = 101; saved.participant = participant;
      }
    }, BACKGROUND_CONTEXT);
    await harness.close(BACKGROUND_CONTEXT); need(await session.close());
    expect(await store.openSession(first, false)).toMatchObject({ ok: true });
  } finally { await harness.close(BACKGROUND_CONTEXT); await session.close(); need(await store.close()); }
});
test('cloud storage rejects an unsupported native owner binding version', async () => {
  const root = mkdtempSync(join(tmpdir(), 'flowmate-cloud-future-item-owner-')), store = need(await openCloudRuntimeStore(root));
  const session = need(await store.openSession(first, true));
  const harness = await Harness.open(session.storage, { models: models(), registry: createRegistry() }, BACKGROUND_CONTEXT);
  const future = defineDoc({ kind: 'flowmate.runtime.binding', version: 3, scope: 'conversation', history: 'latest', fork: 'initial',
    initial: () => ({ workId: first.workId, sessionId: first.sessionId, itemId: null, attemptId: null, requestKey: null }), checkpointWhen: () => true });
  try {
    await harness.commit(async tx => { const conversation = await tx.createConversation({ ownership: { kind: 'ownerless' } });
      await tx.doc(future, conversation.id); }, BACKGROUND_CONTEXT);
    await harness.close(BACKGROUND_CONTEXT); need(await session.close());
    expect(await store.openSession(first, false)).toMatchObject({ ok: false, error: { code: 'cloud_runtime_owner_conflict' } });
  } finally { await harness.close(BACKGROUND_CONTEXT); await session.close(); need(await store.close()); }
});

test('a wake intent survives reopening and rejects stale scheduling callbacks', async () => {
  const root = mkdtempSync(join(tmpdir(), 'flowmate-cloud-wake-store-')), store = need(await openCloudRuntimeStore(root));
  let session = need(await store.openSession(first, true));
  try {
    const revision = need(await session.armWake({ attemptId: 7, requestId: 'original-phase' }));
    expect(need(await session.recordWake({ revision, active: false, at: 1_800_000_000_000 }))).toBe(true);
    need(await session.close()); session = need(await store.openSession(first, false));
    expect(need(await session.readWake())).toEqual({ attemptId: 7, requestId: 'original-phase', revision,
      active: false, at: 1_800_000_000_000, blocked: false });
    const next = need(await session.armWake({ attemptId: 8, requestId: 'next-phase' }));
    expect(next).toBeGreaterThan(revision);
    expect(need(await session.recordWake({ revision, active: true }))).toBe(false);
    expect(need(await session.finishWake({ revision, at: 1_800_000_000_000, nextAt: null, blocked: false }))).toBe(false);
    expect(need(await session.readWake())).toEqual({ attemptId: 8, requestId: 'next-phase', revision: next,
      active: false, at: null, blocked: false });
  } finally { need(await session.close()); need(await store.close()); }
});

test('native observation revision survives reopening and remains scoped to its Session', async () => {
  const root = mkdtempSync(join(tmpdir(), 'flowmate-cloud-observation-')), store = need(await openCloudRuntimeStore(root));
  let one = need(await store.openSession(first, true)); const two = need(await store.openSession(second, true));
  try {
    expect(need(await one.readObservation())).toBe(0);
    expect(need(await one.bumpObservation())).toBe(1);
    expect(need(await one.bumpObservation())).toBe(2);
    expect(need(await two.readObservation())).toBe(0);
    need(await one.close()); one = need(await store.openSession(first, false));
    expect(need(await one.readObservation())).toBe(2);
  } finally { need(await one.close()); need(await two.close()); need(await store.close()); }
});

test('the Durable adapter exposes the native wake state to its cloud host', async () => {
  const root = mkdtempSync(join(tmpdir(), 'flowmate-cloud-wake-hook-')), store = need(await openCloudRuntimeStore(root));
  const session = need(await store.openSession(first, true)), observed: Array<{ active: boolean; at?: number }> = [];
  const runtime = need(await createDurableRuntime({ storage: session.storage, readApiKey: () => undefined,
    verifyModelUse: () => ok(undefined), reserveModelRequest: () => ok(undefined), onWake: wake => { observed.push(wake); } }));
  try {
    await waitFor(async () => observed.length > 0, 3000);
    expect(observed.at(-1)).toMatchObject({ active: expect.any(Boolean) });
  } finally { need(await runtime.close()); need(await session.close()); need(await store.close()); }
});

test('an unanswered input cancelled before placement enters the native outbox without an invented entry', async () => {
  const root = mkdtempSync(join(tmpdir(), 'flowmate-cloud-unplaced-result-')), store = need(await openCloudRuntimeStore(root));
  let session = need(await store.openSession(first, true));
  const runtime = need(await createDurableRuntime({ storage: session.storage, readApiKey: () => undefined,
    verifyModelUse: () => ok(undefined), reserveModelRequest: () => ok(undefined) }));
  const conversation = need(await runtime.openConversation({ workId: first.workId, sessionId: first.sessionId }));
  need(await runtime.close()); need(await session.close()); session = need(await store.openSession(first, false));
  let harness: Harness | undefined = await Harness.open(session.storage, { models: models(), registry: createRegistry() }, BACKGROUND_CONTEXT);
  let reopened: DurableRuntimePort | undefined;
  try {
    const unrelated = defineTask<Record<string, never>, { phase: 'wait' }, null>({ name: 'controlled.unrelated', version: 1,
      initial: () => ({ phase: 'wait' }), phases: { wait: async () => {} }, abort: async () => {} });
    const submission = await harness.commit(async tx => {
      await tx.createTask(unrelated, {}, { conversationId: conversation.nativeConversationId as ConversationId, ownership: { kind: 'conversation' } });
      const saved = await tx.createSubmission({ type: 'input', conversationId: conversation.nativeConversationId as ConversationId,
        requestId: JSON.stringify([3, 'original-queued']), status: 'queued' });
      tx.settleSubmission(saved.id, { status: 'unanswered', reason: 'aborted' }); return saved.id;
    }, BACKGROUND_CONTEXT);
    const event = { version: 1 as const, ...first, attemptId: 3, requestId: 'original-queued',
      nativeConversationId: conversation.nativeConversationId, nativeSubmissionId: submission, nativeInputEntryId: null,
      nativeAnswerEntryId: null, consumedAt: null, status: 'unanswered' as const, answer: null, reason: 'aborted' };
    await harness.close(BACKGROUND_CONTEXT); harness = undefined;
    need(await session.close()); session = need(await store.openSession(first, false));
    reopened = need(await createDurableRuntime({ storage: session.storage, readApiKey: () => undefined,
      verifyModelUse: () => ok(undefined), reserveModelRequest: () => ok(undefined),
      cloudModel: { binding: first, send: async () => fail(appError('cloud_model_transport_unavailable', 'runtime', 'No model is requested.')) },
      onNativeResult: value => session.enqueueResult(value) }));
    await waitFor(async () => need(await session.pendingResults()).length === 1, 3_000);
    expect(need(await session.pendingResults())).toMatchObject([{ event }]);
    expect(await session.enqueueResult({ ...event, reason: 'different' })).toMatchObject({ ok: false });
  } finally { if (harness) await harness.close(BACKGROUND_CONTEXT); if (reopened) need(await reopened.close());
    need(await session.close()); need(await store.close()); }
});

test('a finished invoice can enter the outbox while another invoice owns an active task', async () => {
  const root = mkdtempSync(join(tmpdir(), 'flowmate-cloud-item-outbox-active-')), store = need(await openCloudRuntimeStore(root));
  let session = need(await store.openSession(first, true));
  const runtime = need(await createDurableRuntime({ storage: session.storage, readApiKey: () => undefined,
    verifyModelUse: () => ok(undefined), reserveModelRequest: () => ok(undefined) }));
  const owner = { workId: first.workId, sessionId: first.sessionId }, a = { ...owner, itemId: 101 }, b = { ...owner, itemId: 102 };
  const firstConversation = need(await runtime.openConversation(a)), secondConversation = need(await runtime.openConversation(b));
  need(await runtime.close()); need(await session.close()); session = need(await store.openSession(first, false));
  const harness = await Harness.open(session.storage, { models: models(), registry: createRegistry() }, BACKGROUND_CONTEXT);
  const waiting = defineTask<Record<string, never>, { phase: 'wait' }, null>({ name: 'controlled.other-invoice', version: 1,
    initial: () => ({ phase: 'wait' }), phases: { wait: async () => {} }, abort: async () => {} });
  const saved = await harness.commit(async tx => {
    await tx.createTask(waiting, {}, { conversationId: secondConversation.nativeConversationId as ConversationId, ownership: { kind: 'conversation' } });
    const entry = await tx.appendEntry(firstConversation.nativeConversationId as ConversationId, { kind: 'flowmate.input',
      data: { ...a, attemptId: 3, requestId: 'completed-invoice' }, model: [{ role: 'user', content: 'Original invoice.', timestamp: 1 }] });
    const submission = await tx.createSubmission({ type: 'input', conversationId: firstConversation.nativeConversationId as ConversationId,
      requestId: JSON.stringify([3, 'completed-invoice']), status: 'queued' });
    tx.placeSubmission(submission.id, entry.id); tx.settleSubmission(submission.id, { status: 'unanswered', reason: 'aborted' });
    return { entry: entry.id, submission: submission.id };
  }, BACKGROUND_CONTEXT);
  await harness.close(BACKGROUND_CONTEXT); need(await session.close()); session = need(await store.openSession(first, false));
  const event = { version: 1 as const, ...first, itemId: a.itemId, attemptId: 3, requestId: 'completed-invoice',
    nativeConversationId: firstConversation.nativeConversationId, nativeSubmissionId: saved.submission, nativeInputEntryId: saved.entry,
    nativeAnswerEntryId: null, consumedAt: null, status: 'unanswered' as const, answer: null, reason: 'aborted' };
  try {
    expect(await session.enqueueResult(event)).toEqual({ ok: true, data: undefined });
    expect(need(await session.pendingResults())).toMatchObject([{ event }]);
  } finally { need(await session.close()); need(await store.close()); }
});

test('a terminal invoice submission enters the original cloud outbox after restart', async () => {
  const root = mkdtempSync(join(tmpdir(), 'flowmate-cloud-item-outbox-')), store = need(await openCloudRuntimeStore(root));
  let session = need(await store.openSession(first, true));
  const runtime = need(await createDurableRuntime({ storage: session.storage, readApiKey: () => undefined,
    verifyModelUse: () => ok(undefined), reserveModelRequest: () => ok(undefined) }));
  const owner = { workId: first.workId, sessionId: first.sessionId, itemId: 101 };
  const conversation = need(await runtime.openConversation(owner));
  need(await runtime.close()); need(await session.close()); session = need(await store.openSession(first, false));
  const harness = await Harness.open(session.storage, { models: models(), registry: createRegistry() }, BACKGROUND_CONTEXT);
  const submission = await harness.commit(async tx => {
    const saved = await tx.createSubmission({ type: 'input', conversationId: conversation.nativeConversationId as ConversationId,
      requestId: JSON.stringify([3, 'invoice-queued']), status: 'queued' });
    tx.settleSubmission(saved.id, { status: 'unanswered', reason: 'aborted' }); return saved.id;
  }, BACKGROUND_CONTEXT);
  await harness.close(BACKGROUND_CONTEXT); need(await session.close()); session = need(await store.openSession(first, false));
  const reopened = need(await createDurableRuntime({ storage: session.storage, readApiKey: () => undefined,
    verifyModelUse: () => ok(undefined), reserveModelRequest: () => ok(undefined),
    cloudModel: { binding: first, send: async () => fail(appError('cloud_model_transport_unavailable', 'runtime', 'No model is requested.')) },
    onNativeResult: value => session.enqueueResult(value) }));
  try {
    await waitFor(async () => need(await session.pendingResults()).length === 1, 3_000);
    const event = need(await session.pendingResults())[0]!.event;
    expect(event).toMatchObject({ ...owner, attemptId: 3, requestId: 'invoice-queued', nativeConversationId: conversation.nativeConversationId,
      nativeSubmissionId: submission, status: 'unanswered' });
    expect(await session.enqueueResult({ ...event, itemId: 102 })).toMatchObject({ ok: false });
  } finally { need(await reopened.close()); need(await session.close()); need(await store.close()); }
});

test('an oversized unanswered reason stays in its original submission and is shown as blocked', async () => {
  const root = mkdtempSync(join(tmpdir(), 'flowmate-cloud-oversized-reason-')), store = need(await openCloudRuntimeStore(root));
  let session = need(await store.openSession(first, true));
  const runtime = need(await createDurableRuntime({ storage: session.storage, readApiKey: () => undefined,
    verifyModelUse: () => ok(undefined), reserveModelRequest: () => ok(undefined) }));
  const conversation = need(await runtime.openConversation({ workId: first.workId, sessionId: first.sessionId }));
  need(await runtime.close()); need(await session.close()); session = need(await store.openSession(first, false));
  const harness = await Harness.open(session.storage, { models: models(), registry: createRegistry() }, BACKGROUND_CONTEXT);
  const reason = 'x'.repeat(8193);
  const submissionId = await harness.commit(async tx => {
    const saved = await tx.createSubmission({ type: 'input', conversationId: conversation.nativeConversationId as ConversationId,
      requestId: JSON.stringify([3, 'oversized-reason']), status: 'queued' });
    tx.settleSubmission(saved.id, { status: 'unanswered', reason }); return saved.id;
  }, BACKGROUND_CONTEXT);
  await harness.close(BACKGROUND_CONTEXT); need(await session.close()); session = need(await store.openSession(first, false));
  const reopened = need(await createDurableRuntime({ storage: session.storage, readApiKey: () => undefined,
    verifyModelUse: () => ok(undefined), reserveModelRequest: () => ok(undefined),
    cloudModel: { binding: first, send: async () => fail(appError('cloud_model_transport_unavailable', 'runtime', 'No model is requested.')) },
    onNativeResult: value => session.enqueueResult(value), onNativeResultOversized: value => session.enqueueOversizedResult(value) }));
  try {
    await waitFor(async () => need(await session.listResults({ attemptId: 3 })).items.some(item => item.blockedReason === 'size_limit'), 3_000);
    expect(need(await session.listResults({ attemptId: 3 })).items).toMatchObject([{ nativeSubmissionId: submissionId, nativeStatus: 'unanswered', state: 'blocked' }]);
    expect(await session.storage.submission(submissionId, BACKGROUND_CONTEXT)).toMatchObject({ status: 'unanswered', reason });
    expect(need(await session.pendingResults())).toEqual([]);
  } finally { need(await reopened.close()); need(await session.close()); need(await store.close()); }
});

test('cloud runtime root has one controller and does not create missing sessions while reading', async () => {
  const root = mkdtempSync(join(tmpdir(), 'flowmate-cloud-lease-'));
  const store = need(await openCloudRuntimeStore(root));
  expect(await openCloudRuntimeStore(root)).toMatchObject({ ok: false, error: { code: 'runtime_already_owned' } });
  expect(await store.openSession(first, false)).toMatchObject({ ok: false, error: { code: 'cloud_runtime_session_not_found' } });
  expect(existsSync(join(root, 'sessions', first.cloudRuntimeId))).toBe(false);
  need(await store.close());
  const reopened = need(await openCloudRuntimeStore(root)); need(await reopened.close());
});

test('a session cannot be reacquired while its original storage is closing', async () => {
  const root = mkdtempSync(join(tmpdir(), 'flowmate-cloud-close-'));
  const store = need(await openCloudRuntimeStore(root));
  try {
    const session = need(await store.openSession(first, true));
    const closing = session.close();
    expect(await store.openSession(first, false)).toMatchObject({ ok: false, error: { code: 'cloud_runtime_session_closing' } });
    need(await closing);
    const reopened = need(await store.openSession(first, false));
    expect(reopened).not.toBe(session);
    need(await reopened.close());
  } finally { need(await store.close()); }
});

test('cloud session identifiers cannot escape or redirect the controlled runtime root', async () => {
  const root = mkdtempSync(join(tmpdir(), 'flowmate-cloud-path-'));
  const outside = mkdtempSync(join(tmpdir(), 'flowmate-cloud-outside-'));
  const store = need(await openCloudRuntimeStore(root));
  try {
    expect(await store.openSession({ ...first, cloudRuntimeId: '../outside' }, true)).toMatchObject({ ok: false });
    mkdirSync(join(root, 'sessions'), { recursive: true, mode: 0o700 });
    symlinkSync(outside, join(root, 'sessions', first.cloudRuntimeId), process.platform === 'win32' ? 'junction' : 'dir');
    expect(await store.openSession(first, true)).toMatchObject({ ok: false, error: { code: 'cloud_runtime_path_invalid' } });
    expect(existsSync(join(outside, 'runtime.sqlite'))).toBe(false);
  } finally { need(await store.close()); }
});

test.skipIf(process.platform !== 'linux')('cloud storage refuses directories or native databases accessible by other service users', async () => {
  const root = mkdtempSync(join(tmpdir(), 'flowmate-cloud-mode-'));
  const store = need(await openCloudRuntimeStore(root));
  try {
    const session = need(await store.openSession(first, true)); need(await session.close());
    const directory = join(root, 'sessions', first.cloudRuntimeId), file = join(directory, 'runtime.sqlite');
    chmodSync(directory, 0o770);
    expect(await store.openSession(first, false)).toMatchObject({ ok: false, error: { code: 'cloud_runtime_path_invalid' } });
    chmodSync(directory, 0o700); chmodSync(file, 0o640);
    expect(await store.openSession(first, false)).toMatchObject({ ok: false, error: { code: 'cloud_runtime_path_invalid' } });
    chmodSync(file, 0o600);
    const reopened = need(await store.openSession(first, false)); need(await reopened.close());
  } finally { need(await store.close()); }
});

test.skipIf(process.platform !== 'linux')('cloud storage refuses an unsafe root before creating its lease directory', async () => {
  const root = mkdtempSync(join(tmpdir(), 'flowmate-cloud-unsafe-root-')); chmodSync(root, 0o777);
  try {
    const attempted = await openCloudRuntimeStore(root); if (attempted.ok) need(await attempted.data.close());
    expect(attempted).toMatchObject({ ok: false, error: { code: 'cloud_runtime_path_invalid' } });
    expect(existsSync(join(root, 'data'))).toBe(false);
  } finally { chmodSync(root, 0o700); }
});

test.skipIf(process.platform !== 'linux')('cloud storage refuses a private root that another user could replace through its parent', async () => {
  const parent = mkdtempSync(join(tmpdir(), 'flowmate-cloud-unsafe-parent-')); chmodSync(parent, 0o777);
  try {
    const root = join(parent, 'private'); mkdirSync(root, { mode: 0o700 });
    const attempted = await openCloudRuntimeStore(root); if (attempted.ok) need(await attempted.data.close());
    expect(attempted).toMatchObject({ ok: false, error: { code: 'cloud_runtime_path_invalid' } });
    expect(existsSync(join(root, 'data'))).toBe(false);
  } finally { chmodSync(parent, 0o700); }
});

test('an interrupted empty initialization can be retried while an unrelated database is retained', async () => {
  const root = mkdtempSync(join(tmpdir(), 'flowmate-cloud-init-'));
  const store = need(await openCloudRuntimeStore(root));
  try {
    const directory = join(root, 'sessions', first.cloudRuntimeId);
    mkdirSync(directory, { recursive: true, mode: 0o700 }); writeFileSync(join(directory, 'runtime.sqlite'), '', { mode: 0o600 });
    expect(await store.openSession(first, false)).toMatchObject({ ok: false });
    expect(statSync(join(directory, 'runtime.sqlite')).size).toBe(0);
    const session = need(await store.openSession(first, true)); need(await session.close());
    const original = new Database(join(directory, 'runtime.sqlite'));
    try { expect(() => original.query("UPDATE flowmate_cloud_binding SET work_id=9").run()).toThrow(); }
    finally { original.close(); }
    const other = join(root, 'sessions', second.cloudRuntimeId); mkdirSync(other, { mode: 0o700 });
    const unrelated = new Database(join(other, 'runtime.sqlite'));
    unrelated.exec("CREATE TABLE unrelated(value TEXT); INSERT INTO unrelated VALUES('keep')"); unrelated.close();
    if (process.platform === 'linux') chmodSync(join(other, 'runtime.sqlite'), 0o600);
    expect(await store.openSession(second, true)).toMatchObject({ ok: false, error: { code: 'cloud_runtime_storage_unavailable' } });
    const retained = new Database(join(other, 'runtime.sqlite'), { readonly: true });
    try { expect(retained.query('SELECT value FROM unrelated').get()).toEqual({ value: 'keep' }); }
    finally { retained.close(); }
  } finally { need(await store.close()); }
});

test('a previously ready cloud session never recreates missing native history as a new database', async () => {
  const root = mkdtempSync(join(tmpdir(), 'flowmate-cloud-lost-native-'));
  const store = need(await openCloudRuntimeStore(root));
  try {
    const session = need(await store.openSession(first, true));
    const harness = await Harness.open(session.storage, { models: models(), registry: createRegistry() }, BACKGROUND_CONTEXT);
    await harness.commit(tx => tx.createConversation({ ownership: { kind: 'ownerless' } }), BACKGROUND_CONTEXT);
    await harness.close(BACKGROUND_CONTEXT); need(await session.close());
    const path = join(root, 'sessions', first.cloudRuntimeId, 'runtime.sqlite'), db = new Database(path);
    const tables = db.query<{ name: string }, []>("SELECT name FROM sqlite_master WHERE type='table' AND name GLOB 'fm_durable_*'").all();
    for (const table of tables) db.exec(`DROP TABLE "${table.name}"`);
    db.close();
    expect(await store.openSession(first, true)).toMatchObject({ ok: false, error: { code: 'cloud_runtime_storage_unavailable' } });
    const retained = new Database(path, { readonly: true });
    try { expect(retained.query("SELECT name FROM sqlite_master WHERE type='table' AND name GLOB 'fm_durable_*'").all()).toEqual([]); }
    finally { retained.close(); }
  } finally { need(await store.close()); }
});

test('unfinished native initialization resumes only when its committed schema is complete', async () => {
  const root = mkdtempSync(join(tmpdir(), 'flowmate-cloud-init-state-'));
  const store = need(await openCloudRuntimeStore(root));
  try {
    const initial = need(await store.openSession(first, true)); need(await initial.close());
    const path = join(root, 'sessions', first.cloudRuntimeId, 'runtime.sqlite');
    function simulateInterruptedInitialization(removeEntries: boolean) {
      const db = new Database(path);
      db.exec('DROP TRIGGER cloud_binding_state_forward');
      db.exec("UPDATE flowmate_cloud_binding SET state='allocated'");
      db.exec("CREATE TRIGGER cloud_binding_state_forward BEFORE UPDATE OF state ON flowmate_cloud_binding WHEN OLD.state!='allocated' OR NEW.state!='ready' BEGIN SELECT RAISE(ABORT,'cloud_binding_state_invalid'); END");
      if (removeEntries) db.exec('DROP TABLE fm_durable_entries');
      db.close();
    }
    simulateInterruptedInitialization(false);
    expect(await store.openSession(first, false)).toMatchObject({ ok: false });
    const recovered = need(await store.openSession(first, true)); need(await recovered.close());
    simulateInterruptedInitialization(true);
    expect(await store.openSession(first, true)).toMatchObject({ ok: false });
    const retained = new Database(path, { readonly: true });
    try { expect(retained.query('SELECT state FROM flowmate_cloud_binding').get()).toEqual({ state: 'allocated' }); }
    finally { retained.close(); }
  } finally { need(await store.close()); }
});

test('a cloud session is not returned when its ready marker was not committed', async () => {
  const root = mkdtempSync(join(tmpdir(), 'flowmate-cloud-ready-'));
  const store = need(await openCloudRuntimeStore(root));
  try {
    const session = need(await store.openSession(first, true)); need(await session.close());
    const path = join(root, 'sessions', first.cloudRuntimeId, 'runtime.sqlite'), db = new Database(path);
    db.exec('DROP TRIGGER cloud_binding_state_forward');
    db.exec("UPDATE flowmate_cloud_binding SET state='allocated'");
    db.exec("CREATE TRIGGER cloud_binding_state_forward BEFORE UPDATE OF state ON flowmate_cloud_binding WHEN OLD.state!='allocated' OR NEW.state!='ready' BEGIN SELECT RAISE(ABORT,'cloud_binding_state_invalid'); END");
    db.exec("CREATE TRIGGER reject_ready BEFORE UPDATE OF state ON flowmate_cloud_binding BEGIN SELECT RAISE(IGNORE); END");
    db.close();
    expect(await store.openSession(first, true)).toMatchObject({ ok: false, error: { code: 'cloud_runtime_storage_unavailable' } });
    const retained = new Database(path, { readonly: true });
    try { expect(retained.query('SELECT state FROM flowmate_cloud_binding').get()).toEqual({ state: 'allocated' }); }
    finally { retained.close(); }
  } finally { need(await store.close()); }
});

test('a pre-existing ownerless native conversation without the original Work binding blocks reopening', async () => {
  const root = mkdtempSync(join(tmpdir(), 'flowmate-cloud-orphan-'));
  const store = need(await openCloudRuntimeStore(root));
  try {
    const session = need(await store.openSession(first, true));
    const harness = await Harness.open(session.storage, { models: models(), registry: createRegistry() }, BACKGROUND_CONTEXT);
    const orphan = await harness.commit(tx => tx.createConversation({ ownership: { kind: 'ownerless' } }), BACKGROUND_CONTEXT);
    await harness.close(BACKGROUND_CONTEXT); need(await session.close());
    expect(await store.openSession(first, false)).toMatchObject({ ok: false, error: { code: 'cloud_runtime_owner_conflict' } });
    const db = new Database(join(root, 'sessions', first.cloudRuntimeId, 'runtime.sqlite'), { readonly: true });
    try { expect(db.query('SELECT id FROM fm_durable_conversations').get()).toEqual({ id: orphan.id }); }
    finally { db.close(); }
  } finally { need(await store.close()); }
});

test('a native conversation bound to another Work is not opened under the claimed cloud owner', async () => {
  const root = mkdtempSync(join(tmpdir(), 'flowmate-cloud-foreign-'));
  const store = need(await openCloudRuntimeStore(root));
  try {
    const session = need(await store.openSession(first, true));
    const runtime = need(await createDurableRuntime({ storage: session.storage, readApiKey: () => undefined,
      verifyModelUse: () => ok(undefined), reserveModelRequest: () => ok(undefined) }));
    need(await runtime.openConversation({ workId: 99, sessionId: first.sessionId }));
    need(await runtime.close()); need(await session.close());
    expect(await store.openSession(first, false)).toMatchObject({ ok: false, error: { code: 'cloud_runtime_owner_conflict' } });
  } finally { need(await store.close()); }
});

test('a failed native facade close still closes its database after an owner mismatch', async () => {
  const root = mkdtempSync(join(tmpdir(), 'flowmate-cloud-failed-close-'));
  const store = need(await openCloudRuntimeStore(root));
  try {
    const session = need(await store.openSession(first, true));
    const harness = await Harness.open(session.storage, { models: models(), registry: createRegistry() }, BACKGROUND_CONTEXT);
    await harness.commit(tx => tx.createConversation({ ownership: { kind: 'ownerless' } }), BACKGROUND_CONTEXT);
    await harness.close(BACKGROUND_CONTEXT); need(await session.close());
    const close = spyOn(SqliteStorage.prototype, 'close').mockImplementationOnce(async () => { throw Error('controlled facade close failure'); });
    try { expect(await store.openSession(first, false)).toMatchObject({ ok: false, error: { code: 'cloud_runtime_owner_conflict' } }); }
    finally { close.mockRestore(); }
    expect(await store.openSession(first, false)).toMatchObject({ ok: false, error: { code: 'cloud_runtime_owner_conflict' } });
  } finally { need(await store.close()); }
});

test('a native Task whose original Conversation is missing blocks opening before any Harness recovery', async () => {
  const root = mkdtempSync(join(tmpdir(), 'flowmate-cloud-orphan-task-'));
  const store = need(await openCloudRuntimeStore(root));
  try {
    const session = need(await store.openSession(first, true)); need(await session.close());
    const path = join(root, 'sessions', first.cloudRuntimeId, 'runtime.sqlite'), db = new Database(path);
    db.exec("INSERT INTO fm_durable_tasks(id,conversation_id,kind,status,abort_requested,background,record) VALUES(500,999,'controlled','pending',0,0,'{}')");
    db.close();
    expect(await store.openSession(first, false)).toMatchObject({ ok: false, error: { code: 'cloud_runtime_storage_unavailable' } });
    const retained = new Database(path, { readonly: true });
    try { expect(retained.query('SELECT id,conversation_id,status FROM fm_durable_tasks').get()).toEqual({ id: 500, conversation_id: 999, status: 'pending' }); }
    finally { retained.close(); }
  } finally { need(await store.close()); }
});
