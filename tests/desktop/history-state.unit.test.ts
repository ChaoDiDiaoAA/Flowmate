import { describe, expect, it } from 'bun:test';
import { existsSync } from 'node:fs';
import { normalizeForkSessionRequest } from '@flowmate/contracts';

describe('P9 T08 History state', () => {
  it('refuses mixed revisions, repeated rows, missing parents and details outside the held page', async () => {
    const h = await import('../../apps/desktop/renderer/src/history-state.ts');
    const session = { sessionId: 1, nativeSessionId: 'native', title: 'Chat', status: 'active' as const, createdAt: '2026-10-04T00:00:00.000Z', updatedAt: '2026-10-04T00:00:00.000Z',
      availability: 'ready' as const, historyState: 'recoverable' as const, activeRunId: null, modelUseBlocked: false, hasBusinessHistory: false, deletePending: false };
    const a = { sequence: 0, entryId: 'A', parentId: null, type: 'message' as const, timestamp: session.createdAt, isCurrentPath: true, isLeaf: false, preview: 'first', truncated: false,
      originSessionId: 7, originRunId: 8, canSelect: true, cannotSelectReason: null };
    const b = { ...a, sequence: 1, entryId: 'B', parentId: 'A', isLeaf: true };
    const first = { session, commit: { commitRevision: 7, entryCount: 2, leafId: 'B' }, items: [a], nextAfterSequence: 0 };
    const last = { ...first, items: [b], nextAfterSequence: null };
    expect(h.mergeHistoryPage(first, last, 0)?.items.map(item => item.entryId)).toEqual(['A', 'B']);
    expect(h.mergeHistoryPage(first, { ...last, commit: { ...last.commit, commitRevision: 9 } }, 0)).toBeNull();
    expect(h.mergeHistoryPage(first, { ...last, items: [{ ...b, entryId: 'A' }] }, 0)).toBeNull();
    expect(h.mergeHistoryPage(first, { ...last, items: [{ ...b, parentId: 'missing' }] }, 0)).toBeNull();
    const detail = { summary: a, commit: first.commit, fields: { type: 'message' as const, role: 'user' as const, toolName: null, callId: null, stopReason: null, isError: null, hasImages: false, imageMimeTypes: [] },
      part: { kind: 'text' as const, text: 'first' }, partIndex: 1, offset: 0, next: null };
    const request = { sessionId: 1, entryId: 'A', expectedCommitRevision: 7 };
    expect(h.matchesHistoryDetail(first, request, detail)).toBe(true);
    expect(h.matchesHistoryDetail(first, { ...request, partIndex: 0, offset: 17 }, detail)).toBe(true);
    expect(h.matchesHistoryDetail(first, { ...request, sessionId: 7 }, detail)).toBe(false);
    expect(h.matchesHistoryDetail(first, request, { ...detail, summary: { ...a, originSessionId: 1 } })).toBe(false);
    expect(h.matchesHistoryDetail(first, { ...request, partIndex: 1, offset: 3 }, detail)).toBe(false);
  });
  it('isolates late success error and finally by session epoch navigation entry and request', async () => {
    const path = '../../apps/desktop/renderer/src/history-state.ts';
    expect(existsSync(new URL(path, import.meta.url))).toBe(true);
    const h = await import(path);
    const identity = { sessionId: 1, hostEpoch: 3, navigationToken: 5, entryId: 'A' };
    const initial = h.createHistoryRead(identity);
    const pending = h.beginHistoryRead(initial, 1, 'page:7:0');
    const lease = h.historyLease(pending);
    const loaded = h.acceptHistoryRead(pending, lease, 'verified A');
    const failed = h.failHistoryRead(loaded, lease, 'unavailable');
    expect(failed).toMatchObject({ data: 'verified A', error: 'unavailable', pending: false });
    const invalidated = h.invalidateHistoryRead(failed, 2);
    expect(invalidated).toMatchObject({ data: 'verified A', error: 'unavailable', pending: false });
    expect(h.acceptHistoryRead(invalidated, lease, 'late detail')).toBe(invalidated);
    expect(h.finishHistoryRead(invalidated, lease)).toBe(invalidated);
    for (const patch of [{ sessionId: 2 }, { hostEpoch: 4 }, { navigationToken: 6 }, { entryId: 'B' }]) {
      const other = h.beginHistoryRead(h.createHistoryRead({ ...identity, ...patch }), 1, 'page:7:0');
      expect(h.acceptHistoryRead(other, lease, 'late A')).toBe(other);
      expect(h.failHistoryRead(other, lease, 'late failure')).toBe(other);
      expect(h.finishHistoryRead(other, lease)).toBe(other);
    }
    const latest = h.beginHistoryRead(loaded, 2, 'page:8:0');
    expect(h.finishHistoryRead(latest, lease)).toBe(latest);
  });
  it('freezes the whole canonical fork request independent of subsequent edits', async () => {
    const path = '../../apps/desktop/renderer/src/history-state.ts';
    expect(existsSync(new URL(path, import.meta.url))).toBe(true);
    const h = await import(path);
    const input = { sourceSessionId: 1, expected: { commitRevision: 7, leafId: 'A', entryCount: 3 }, targetEntryId: 'A', title: '  Child  ',
      clientOperationId: '5D095824-9DBF-4219-BE5B-A85B2BD12A24' };
    const frozen = h.freezeForkRequest(input);
    expect(normalizeForkSessionRequest(input)).toEqual({ ok: true, data: frozen });
    for (const title of ['', '  ', 'x'.repeat(121), '😀'.repeat(121)]) {
      expect(normalizeForkSessionRequest({ ...input, title }).ok).toBe(false);
      expect(() => h.freezeForkRequest({ ...input, title })).toThrow('Session history request is invalid.');
    }
    input.expected.commitRevision = 8; input.targetEntryId = 'B'; input.title = 'Edited';
    expect(frozen).toEqual({ sourceSessionId: 1, expected: { commitRevision: 7, leafId: 'A', entryCount: 3 }, targetEntryId: 'A', title: 'Child',
      clientOperationId: '5d095824-9dbf-4219-be5b-a85b2bd12a24' });
    expect(Object.isFrozen(frozen)).toBe(true); expect(Object.isFrozen(frozen.expected)).toBe(true);
  });
});
