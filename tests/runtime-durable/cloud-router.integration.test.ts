import { expect, test } from 'bun:test';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createRegistry } from '@earendil-works/pi-durable';
import { appError, fail, ok, type Result } from '@flowmate/contracts';
import { openCloudRuntimeStore } from '../../apps/cloud-runtime-storage.ts';
import { createCloudRuntimeRouter } from '../../apps/cloud-runtime-router.ts';
import { mkdtempSync } from '../support/resources.ts';

function need<T>(result: Result<T>): T { if (!result.ok) throw Error(result.error.code); return result.data; }
const workspaceId = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const first = { workspaceId, cloudRuntimeId: '11111111-1111-4111-8111-111111111111', workId: 1, sessionId: 11 };
const second = { workspaceId, cloudRuntimeId: '22222222-2222-4222-8222-222222222222', workId: 2, sessionId: 22 };
const options = { readApiKey: () => undefined, verifyModelUse: () => ok(undefined), reserveModelRequest: () => ok(undefined) };

test('the cloud router authorizes before opening a Session and keeps one native owner per binding', async () => {
  const root = mkdtempSync(join(tmpdir(), 'flowmate-cloud-router-')), store = need(await openCloudRuntimeStore(root));
  let denied = true, ready: number | null = null, opens = 0;
  const router = createCloudRuntimeRouter({ store: { ...store, openSession: (binding, create) => { opens++; return store.openSession(binding, create); } },
    runtimeOptions: options, authorize: (_operation, identity) => {
      if (denied) return fail(appError('cloud_access_denied', 'runtime', 'Controlled denial.'));
      const binding = identity.workId === first.workId ? first : second;
      return ok(ready === null ? { binding, state: 'allocated' as const } : { binding, state: 'ready' as const, nativeConversationId: ready });
    } });
  try {
    expect(await router.openConversation({ workId: first.workId, sessionId: first.sessionId }))
      .toMatchObject({ ok: false, error: { code: 'cloud_access_denied' } });
    expect(opens).toBe(0); expect(existsSync(join(root, 'sessions'))).toBe(false);
    denied = false;
    const [a, repeated] = await Promise.all([router.openConversation({ workId: first.workId, sessionId: first.sessionId }),
      router.openConversation({ workId: first.workId, sessionId: first.sessionId })]);
    const original = need(a); expect(need(repeated)).toEqual(original); expect(opens).toBe(1);
    const other = need(await router.openConversation({ workId: second.workId, sessionId: second.sessionId }));
    expect(other.nativeConversationId).toBe(original.nativeConversationId); expect(opens).toBe(2);
    const query = { workId: first.workId, sessionId: first.sessionId, attemptId: 1, requestId: 'original' };
    expect(await router.getSubmission(query)).toMatchObject({ ok: false, error: { code: 'cloud_runtime_not_ready' } });
    ready = original.nativeConversationId;
    expect(await router.getSubmission(query)).toEqual({ ok: true, data: null });
    ready += 1;
    expect(await router.getSubmission(query)).toMatchObject({ ok: false, error: { code: 'cloud_runtime_owner_conflict' } });
    denied = true;
    expect(await router.openConversation({ workId: first.workId, sessionId: first.sessionId }))
      .toMatchObject({ ok: false, error: { code: 'cloud_access_denied' } });
  } finally { need(await router.close()); need(await store.close()); }
});

test('revocation while opening storage is checked again before any Harness or native conversation is opened', async () => {
  const root = mkdtempSync(join(tmpdir(), 'flowmate-cloud-router-revoke-')), store = need(await openCloudRuntimeStore(root));
  const entered = Promise.withResolvers<void>(), release = Promise.withResolvers<void>();
  let denied = false;
  const router = createCloudRuntimeRouter({ store: { ...store, async openSession(binding, create) {
    entered.resolve(); await release.promise; return store.openSession(binding, create);
  } }, runtimeOptions: options, authorize: () => denied ? fail(appError('cloud_access_denied', 'runtime', 'Controlled denial.'))
    : ok({ binding: first, state: 'allocated' as const }) });
  try {
    const opening = router.openConversation({ workId: first.workId, sessionId: first.sessionId });
    await entered.promise; denied = true; release.resolve();
    expect(await opening).toMatchObject({ ok: false, error: { code: 'cloud_access_denied' } });
    const session = need(await store.openSession(first, false));
    try {
      const page = await session.storage.scanConversations({}, 1, undefined, (await import('@earendil-works/chord/context')).BACKGROUND_CONTEXT);
      expect(page.items).toEqual([]);
    } finally { need(await session.close()); }
  } finally { release.resolve(); need(await router.close()); need(await store.close()); }
});

test('a reopened cloud router checks the Authority native binding before opening a Harness', async () => {
  const root = mkdtempSync(join(tmpdir(), 'flowmate-cloud-router-reopen-')), store = need(await openCloudRuntimeStore(root));
  let expected: number | null = null;
  const authorize = () => ok(expected === null ? { binding: first, state: 'allocated' as const }
    : { binding: first, state: 'ready' as const, nativeConversationId: expected });
  const router = createCloudRuntimeRouter({ store, runtimeOptions: options, authorize });
  const original = need(await router.openConversation({ workId: first.workId, sessionId: first.sessionId }));
  need(await router.close()); expected = original.nativeConversationId + 1;
  const reopened = createCloudRuntimeRouter({ store, runtimeOptions: options, authorize });
  try {
    const query = { workId: first.workId, sessionId: first.sessionId, attemptId: 1, requestId: 'original' };
    expect(await reopened.getSubmission(query)).toMatchObject({ ok: false, error: { code: 'cloud_runtime_owner_conflict' } });
    expected = original.nativeConversationId;
    expect(await reopened.getSubmission(query)).toEqual({ ok: true, data: null });
  } finally { need(await reopened.close()); need(await store.close()); }
});

test('cold history reads inspect native storage without opening a Harness', async () => {
  const root = mkdtempSync(join(tmpdir(), 'flowmate-cloud-cold-history-')), store = need(await openCloudRuntimeStore(root));
  let nativeId: number | null = null, opened = 0;
  const authorize = () => ok(nativeId === null ? { binding: first, state: 'allocated' as const }
    : { binding: first, state: 'ready' as const, nativeConversationId: nativeId });
  const original = createCloudRuntimeRouter({ store, runtimeOptions: options, authorize });
  nativeId = need(await original.openConversation({ workId: first.workId, sessionId: first.sessionId })).nativeConversationId;
  need(await original.close());
  const cold = createCloudRuntimeRouter({ store, runtimeOptions: () => { opened++; return options; }, authorize });
  try {
    expect(need(await cold.queryHistory({ workId: first.workId, sessionId: first.sessionId, limit: 10 })).entries).toEqual([]);
    expect(need(await cold.queryHistoryPage({ workId: first.workId, sessionId: first.sessionId, limit: 10 })).entries).toEqual([]);
    expect(await cold.queryHistoryEntry({ workId: first.workId, sessionId: first.sessionId, throughEntryId: 0, entryId: 1, offset: 0, limit: 32 }))
      .toMatchObject({ ok: false });
    expect(opened).toBe(0);
    expect(await cold.getSubmission({ workId: first.workId, sessionId: first.sessionId, attemptId: 1, requestId: 'original' })).toEqual({ ok: true, data: null });
    expect(opened).toBe(1);
  } finally { need(await cold.close()); need(await store.close()); }
});

test('scheduling requires a persisted wake intent and rechecks authorization afterwards', async () => {
  const root = mkdtempSync(join(tmpdir(), 'flowmate-cloud-wake-gate-')), store = need(await openCloudRuntimeStore(root));
  const entered = Promise.withResolvers<void>(), release = Promise.withResolvers<void>();
  let nativeId: number | null = null, allowed = true, failIntent = true, calls = 0;
  const router = createCloudRuntimeRouter({ store, runtimeOptions: options, authorize: () => allowed
    ? ok(nativeId === null ? { binding: first, state: 'allocated' as const } : { binding: first, state: 'ready' as const, nativeConversationId: nativeId })
    : fail(appError('cloud_access_denied', 'runtime', 'Controlled denial.')),
  beforeSchedule: async (_binding, _session, request) => {
    calls++; expect(request.attemptId).toBe(7);
    if (failIntent) return fail(appError('cloud_wake_unavailable', 'storage', 'Controlled write failure.'));
    entered.resolve(); await release.promise; return ok(undefined);
  } });
  try {
    nativeId = need(await router.openConversation({ workId: first.workId, sessionId: first.sessionId })).nativeConversationId;
    const request = { workId: first.workId, sessionId: first.sessionId, attemptId: 7 };
    expect(await router.resumeAttempt(request)).toMatchObject({ ok: false, error: { code: 'cloud_wake_unavailable' } });
    failIntent = false;
    const pending = router.resumeAttempt(request); await entered.promise; allowed = false; release.resolve();
    expect(await pending).toMatchObject({ ok: false, error: { code: 'cloud_access_denied' } });
    expect(calls).toBe(2);
  } finally { release.resolve(); need(await router.close()); need(await store.close()); }
});

test('different cloud Sessions cannot share a mutable native registry', async () => {
  const root = mkdtempSync(join(tmpdir(), 'flowmate-cloud-router-registry-')), store = need(await openCloudRuntimeStore(root));
  const registry = createRegistry();
  const router = createCloudRuntimeRouter({ store, runtimeOptions: { ...options, registry }, authorize: (_operation, identity) =>
    ok({ binding: identity.workId === first.workId ? first : second, state: 'allocated' as const }) });
  try {
    need(await router.openConversation({ workId: first.workId, sessionId: first.sessionId }));
    expect(await router.openConversation({ workId: second.workId, sessionId: second.sessionId }))
      .toMatchObject({ ok: false, error: { code: 'cloud_runtime_registry_conflict' } });
  } finally { need(await router.close()); need(await store.close()); }
});
