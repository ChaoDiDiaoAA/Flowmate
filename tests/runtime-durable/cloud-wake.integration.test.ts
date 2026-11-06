import { expect, test } from 'bun:test';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { BACKGROUND_CONTEXT } from '@earendil-works/chord/context';
import { createModels, InMemoryCredentialStore, InMemoryModelsStore } from '@earendil-works/pi-ai';
import { createRegistry, defineTask, Harness } from '@earendil-works/pi-durable';
import { appError, fail, ok, type Result } from '@flowmate/contracts';
import { openCloudRuntimeStore } from '../../apps/cloud-runtime-storage.ts';
import { CloudWakeScheduler } from '../../apps/cloud-wake-scheduler.ts';
import { mkdtempSync, waitFor } from '../support/resources.ts';

function need<T>(result: Result<T>): T { if (!result.ok) throw Error(result.error.code); return result.data; }
const binding = { workspaceId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', cloudRuntimeId: '11111111-1111-4111-8111-111111111111', workId: 1, sessionId: 2 };

test('a saved wake survives Runtime restart and resumes only its original attempt', async () => {
  const root = mkdtempSync(join(tmpdir(), 'flowmate-cloud-wake-')), store = need(await openCloudRuntimeStore(root));
  let session = need(await store.openSession(binding, true));
  const first = new CloudWakeScheduler(async () => { throw Error('The first owner must stop before the due time.'); });
  need(await first.register(binding, session)); need(await first.arm(binding, session, { attemptId: 7, requestId: 'original-phase' }));
  const due = Date.now() + 700; first.observe(binding, { active: false, at: due });
  await waitFor(async () => (need(await session.readWake()))?.at === due, 3000);
  need(await first.close()); need(await session.close()); session = need(await store.openSession(binding, false));
  const calls: number[] = [], second = new CloudWakeScheduler(async (_owner, attemptId) => { calls.push(attemptId); return ok(undefined); });
  try {
    need(await second.register(binding, session));
    await waitFor(async () => calls.length === 1, 5000);
    await waitFor(async () => (need(await session.readWake()))?.at === null, 3000);
    expect(calls).toEqual([7]);
  } finally { need(await second.close()); need(await session.close()); need(await store.close()); }
});

test('concurrent wake intents retain the latest revision when the first receipt is delayed', async () => {
  const root = mkdtempSync(join(tmpdir(), 'flowmate-cloud-wake-race-')), store = need(await openCloudRuntimeStore(root));
  const session = need(await store.openSession(binding, true)), firstSaved = Promise.withResolvers<void>(),
    secondSaved = Promise.withResolvers<void>(), release = Promise.withResolvers<void>();
  const delayed = { ...session, armWake: async (input: { attemptId: number; requestId?: string }) => {
    const saved = await session.armWake(input);
    if (input.requestId === 'first') { firstSaved.resolve(); await release.promise; }
    if (input.requestId === 'second') secondSaved.resolve();
    return saved;
  } };
  const scheduler = new CloudWakeScheduler(async () => ok(undefined));
  try {
    need(await scheduler.register(binding, delayed));
    const first = scheduler.arm(binding, delayed, { attemptId: 7, requestId: 'first' }); await firstSaved.promise;
    const second = scheduler.arm(binding, delayed, { attemptId: 7, requestId: 'second' });
    await Promise.race([secondSaved.promise, new Promise<void>(resolve => setTimeout(resolve, 100))]);
    release.resolve(); need(await first); need(await second);
    const due = Date.now() + 10_000; scheduler.observe(binding, { active: false, at: due });
    await waitFor(async () => (need(await session.readWake()))?.at === due, 1000);
    expect(need(await session.readWake())).toMatchObject({ requestId: 'second', at: due });
  } finally { release.resolve(); need(await scheduler.close()); need(await session.close()); need(await store.close()); }
});

test('a late wake observed during a newer intent cannot acquire its revision', async () => {
  const root = mkdtempSync(join(tmpdir(), 'flowmate-cloud-wake-stale-')), store = need(await openCloudRuntimeStore(root));
  const session = need(await store.openSession(binding, true)), saved = Promise.withResolvers<void>(), release = Promise.withResolvers<void>(),
    recorded = Promise.withResolvers<void>();
  const delayed = { ...session, armWake: async (input: { attemptId: number; requestId?: string }) => {
    const result = await session.armWake(input);
    if (input.requestId === 'second') { saved.resolve(); await release.promise; } return result;
  }, recordWake: async (input: Parameters<typeof session.recordWake>[0]) => {
    const result = await session.recordWake(input); recorded.resolve(); return result;
  } };
  const scheduler = new CloudWakeScheduler(async () => ok(undefined));
  try {
    need(await scheduler.register(binding, delayed)); need(await scheduler.arm(binding, delayed, { attemptId: 7, requestId: 'first' }));
    const second = scheduler.arm(binding, delayed, { attemptId: 8, requestId: 'second' }); await saved.promise;
    scheduler.observe(binding, { active: false, at: Date.now() + 10_000 }); release.resolve(); need(await second); await recorded.promise;
    expect(need(await session.readWake())).toMatchObject({ attemptId: 8, requestId: 'second', at: null });
  } finally { release.resolve(); need(await scheduler.close()); need(await session.close()); need(await store.close()); }
});

test('a denied wake is preserved as blocked without repeatedly resuming the attempt', async () => {
  const root = mkdtempSync(join(tmpdir(), 'flowmate-cloud-wake-denied-')), store = need(await openCloudRuntimeStore(root));
  const session = need(await store.openSession(binding, true)); let calls = 0;
  const scheduler = new CloudWakeScheduler(async () => { calls++; return fail(appError('cloud_runtime_forbidden', 'runtime', 'Controlled denial.')); });
  try {
    need(await scheduler.register(binding, session)); need(await scheduler.arm(binding, session, { attemptId: 9 }));
    scheduler.observe(binding, { active: false, at: Date.now() + 50 });
    await waitFor(async () => (need(await session.readWake()))?.blocked === true, 3000);
    await new Promise(resolve => setTimeout(resolve, 150));
    expect(calls).toBe(1); expect(need(await session.readWake())).toMatchObject({ attemptId: 9, at: null, blocked: true });
  } finally { need(await scheduler.close()); need(await session.close()); need(await store.close()); }
});

test('a transient Authority outage leaves a retryable wake that survives another Runtime restart', async () => {
  const root = mkdtempSync(join(tmpdir(), 'flowmate-cloud-wake-retry-')), store = need(await openCloudRuntimeStore(root));
  let session = need(await store.openSession(binding, true)), failures = 0;
  const first = new CloudWakeScheduler(async () => { failures++; return fail(appError('cloud_authorization_unavailable', 'runtime', 'Controlled outage.', true)); });
  need(await first.register(binding, session)); need(await first.arm(binding, session, { attemptId: 10, requestId: 'original-phase' }));
  const due = Date.now() + 50; first.observe(binding, { active: false, at: due });
  await waitFor(async () => failures === 1 && (need(await session.readWake()))?.at !== due, 3000);
  const pending = need(await session.readWake()); expect(pending).toMatchObject({ attemptId: 10, blocked: false });
  expect(pending?.at).not.toBeNull();
  need(await first.close()); need(await session.close()); session = need(await store.openSession(binding, false));
  const resumed: number[] = [], second = new CloudWakeScheduler(async (_owner, attemptId) => { resumed.push(attemptId); return ok(undefined); });
  try {
    need(await second.register(binding, session)); await waitFor(async () => resumed.length === 1, 5000);
    await waitFor(async () => (need(await session.readWake()))?.at === null, 3000);
    expect(resumed).toEqual([10]);
  } finally { need(await second.close()); need(await session.close()); need(await store.close()); }
});

test('native idle discovered during startup clears a stale deadline before it can resume', async () => {
  const root = mkdtempSync(join(tmpdir(), 'flowmate-cloud-wake-reconcile-')), store = need(await openCloudRuntimeStore(root));
  const session = need(await store.openSession(binding, true));
  const revision = need(await session.armWake({ attemptId: 11, requestId: 'original-phase' }));
  need(await session.recordWake({ revision, active: false, at: Date.now() + 500 }));
  const release = Promise.withResolvers<void>(); let resumes = 0;
  const delayed = { ...session, readWake: async () => { await release.promise; return session.readWake(); } };
  const scheduler = new CloudWakeScheduler(async () => { resumes++; return ok(undefined); });
  const registered = scheduler.register(binding, delayed);
  try {
    scheduler.observe(binding, { active: false }); release.resolve(); need(await registered);
    await waitFor(async () => (need(await session.readWake()))?.at === null, 3000);
    await new Promise(resolve => setTimeout(resolve, 600)); expect(resumes).toBe(0);
  } finally { release.resolve(); need(await scheduler.close()); need(await session.close()); need(await store.close()); }
});

test('a real sleeping Durable task resumes through the saved and authorized wake', async () => {
  const root = mkdtempSync(join(tmpdir(), 'flowmate-cloud-native-wake-')), store = need(await openCloudRuntimeStore(root));
  const session = need(await store.openSession(binding, true)), finished = Promise.withResolvers<void>();
  let harness!: Harness, resumes = 0;
  const scheduler = new CloudWakeScheduler(async (_owner, attemptId) => {
    expect(attemptId).toBe(7); resumes++; harness.resume(); return ok(undefined);
  });
  need(await scheduler.register(binding, session)); need(await scheduler.arm(binding, session, { attemptId: 7, requestId: 'phase' }));
  const registry = createRegistry(), task = defineTask<Record<string, never>, { phase: 'sleep' } | { phase: 'done' }, null>({
    name: 'controlled.cloud-sleep', version: 1, initial: () => ({ phase: 'sleep' }), phases: {
      sleep: async (_task, api, context) => { await api.sleepUntil(Date.now() + 300, { phase: 'done' }, context); },
      done: async (_task, api, context) => { await api.commit(() => ({ status: 'terminal', outcome: { status: 'completed', result: null } }), context); finished.resolve(); },
    }, abort: (_task, api, context) => api.commit(() => ({ status: 'terminal', outcome: { status: 'aborted' } }), context) });
  registry.install({ name: 'controlled-cloud-sleep', tasks: [task] });
  const models = createModels({ credentials: new InMemoryCredentialStore(), modelsStore: new InMemoryModelsStore() });
  harness = await Harness.open(session.storage, { models, registry, onWake: wake => scheduler.observe(binding, wake) }, BACKGROUND_CONTEXT);
  try {
    await harness.commit(async tx => { const conversation = await tx.createConversation({ ownership: { kind: 'ownerless' } });
      await tx.createTask(task, {}, { conversationId: conversation.id, ownership: { kind: 'conversation' }, background: true }); }, BACKGROUND_CONTEXT);
    harness.resume();
    await waitFor(async () => (need(await session.readWake()))?.at !== null, 3000);
    await Promise.race([finished.promise, new Promise<never>((_, reject) => setTimeout(() => reject(Error('Native wake did not finish.')), 5000))]);
    expect(resumes).toBe(1);
  } finally { need(await scheduler.close()); await harness.close(BACKGROUND_CONTEXT); need(await session.close()); need(await store.close()); }
});
