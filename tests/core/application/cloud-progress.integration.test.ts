import { expect, test } from 'bun:test';
import { CloudProgressHub } from '../../../apps/cloud-progress.ts';
import type { Result } from '@flowmate/contracts';

function need<T>(result: Result<T>): T { if (!result.ok) throw Error(result.error.code); return result.data; }

test('cloud progress wakes only the original Session and requests a snapshot after restart', async () => {
  const hub = new CloudProgressHub(1000), owner = { workId: 7, sessionId: 8 };
  const notice = { ...owner, workspaceId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', cloudRuntimeId: '11111111-1111-4111-8111-111111111111',
    runtimeGeneration: '22222222-2222-4222-8222-222222222222', observationRevision: 1 };
  try {
    const initial = need(await hub.wait({ ...owner, cursor: null })); expect(initial.resync).toBe(true);
    let settled = false;
    const pending = hub.wait({ ...owner, cursor: initial.cursor }).then(value => { settled = true; return value; });
    hub.publish({ ...notice, workId: 9, sessionId: 10 }); await Promise.resolve(); expect(settled).toBe(false);
    hub.publish(notice);
    const first = need(await pending); expect(first).toMatchObject({ ...owner, changed: true, resync: false,
      runtimeGeneration: notice.runtimeGeneration, observationRevision: 1 });
    hub.publish({ ...notice, observationRevision: 2 }); hub.publish({ ...notice, observationRevision: 3 });
    const missed = need(await hub.wait({ ...owner, cursor: first.cursor }));
    expect(missed).toMatchObject({ changed: true, resync: false, snapshotChanged: true, observationRevision: 3 });
    const restarted = new CloudProgressHub(1000);
    try { expect(need(await restarted.wait({ ...owner, cursor: missed.cursor })).resync).toBe(true); }
    finally { restarted.close(); }
  } finally { hub.close(); }
});

test('bounded live output retains its original phase and discards fragments when a reader falls behind', async () => {
  const hub = new CloudProgressHub(1000), owner = { workId: 7, sessionId: 8 };
  const source = { ...owner, attemptId: 9, requestId: 'original-phase', modelAttemptId: '22222222-2222-4222-8222-222222222222' };
  try {
    const initial = need(await hub.wait({ ...owner, cursor: null }));
    hub.publishText(source, '发票🙂'.repeat(400));
    const live = need(await hub.wait({ ...owner, cursor: initial.cursor }));
    expect(live.resync).toBe(false); expect(live.snapshotChanged).toBe(false);
    expect(live.fragments.map(fragment => fragment.text).join('')).toBe('发票🙂'.repeat(400));
    expect(live.fragments.every(fragment => fragment.attemptId === source.attemptId && fragment.requestId === source.requestId
      && fragment.modelAttemptId === source.modelAttemptId && new TextEncoder().encode(fragment.text).byteLength <= 1024)).toBe(true);
    hub.discardText(owner);
    const reset = need(await hub.wait({ ...owner, cursor: live.cursor })); expect(reset.resync).toBe(true); expect(reset.fragments).toEqual([]);
    for (let index = 0; index < 70; index++) hub.publishText(source, 'next');
    const lagged = need(await hub.wait({ ...owner, cursor: reset.cursor }));
    expect(lagged.resync).toBe(true); expect(lagged.fragments).toEqual([]);
  } finally { hub.close(); }
});

test('a new Runtime process generation discards old live output and requires a snapshot', async () => {
  const hub = new CloudProgressHub(1000), owner = { workId: 7, sessionId: 8 };
  const notice = { ...owner, workspaceId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', cloudRuntimeId: '11111111-1111-4111-8111-111111111111',
    runtimeGeneration: '22222222-2222-4222-8222-222222222222', observationRevision: 1 };
  const source = { ...owner, attemptId: 9, requestId: 'original-phase', modelAttemptId: '33333333-3333-4333-8333-333333333333' };
  try {
    hub.publish(notice); const first = need(await hub.wait({ ...owner, cursor: null })); hub.publishText(source, 'old preview');
    const live = need(await hub.wait({ ...owner, cursor: first.cursor })); expect(live.fragments).toHaveLength(1);
    hub.publish({ ...notice, runtimeGeneration: '44444444-4444-4444-8444-444444444444', observationRevision: 2 });
    const restarted = need(await hub.wait({ ...owner, cursor: live.cursor }));
    expect(restarted).toMatchObject({ resync: true, fragments: [], runtimeGeneration: '44444444-4444-4444-8444-444444444444' });
  } finally { hub.close(); }
});
