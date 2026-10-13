import { expect, test } from 'bun:test';
import { ToolEvidenceRequestSchema, ToolEvidencePageSchema, ToolEvidenceResultSchema, ToolCallSnapshotSchema } from '../../packages/contracts/src/tool-evidence.ts';
import type { ToolCallSnapshot } from '../../packages/contracts/src/activity.ts';

const at = '2026-10-11T00:00:00.000Z';
const snapshot: ToolCallSnapshot = { toolCallId: 8, runId: 21, sessionId: 12, nativeToolCallId: 'original', context: null,
    toolName: 'read', toolVersion: '1', effect: 'READ', status: 'succeeded', args: { version: 1, raw: { path: 'material.md' }, final: { path: 'material.md' } },
    result: { version: 1, status: 'succeeded', committedCandidateId: null, data: { text: '汉😀' } },
    delivery: { version: 1, state: 'request_observed', messageObservedAt: at, includedInCallSequence: 2, requestDispatchedAt: at, error: null },
    cleanup: { version: 1, stopReason: null, stopped: true, errors: [] }, runtimeObservation: null,
    requestedAt: at, startedAt: at, endedAt: at, stoppedAt: at };

test('tool evidence preserves original arguments/results and rejects incomplete or contradictory snapshots', () => {
    expect(ToolCallSnapshotSchema.parse(snapshot)).toEqual(snapshot);
    for (const invalid of [{ ...snapshot, unexpected: 'quality' }, { ...snapshot, args: { version: 1, final: null } },
        { ...snapshot, result: null }, { ...snapshot, result: { ...snapshot.result, status: 'failed' } },
        { ...snapshot, stoppedAt: null }, { ...snapshot, cleanup: { ...snapshot.cleanup, errors: ['unknown'] } },
        { ...snapshot, args: { ...snapshot.args, raw: { nested: Infinity } } }, { ...snapshot, args: { ...snapshot.args, raw: NaN } }])
        expect(ToolCallSnapshotSchema.safeParse(invalid).success).toBe(false);
    const circular: Record<string, unknown> = {}; circular.self = circular;
    expect(ToolCallSnapshotSchema.safeParse({ ...snapshot, args: { ...snapshot.args, raw: circular } }).success).toBe(false);
});

test('tool evidence continuation binds a hash, UTF-8 length, exact end and a bounded strict page', () => {
    const identity = { runId: 21, sessionId: 12, toolCallId: 8 };
    expect(ToolEvidenceRequestSchema.parse(identity)).toMatchObject({ offset: 0, limit: 8192 });
    expect(ToolEvidenceRequestSchema.safeParse({ ...identity, offset: 1 }).success).toBe(false);
    expect(ToolEvidenceRequestSchema.safeParse({ ...identity, offset: 1, expectedHash: 'a'.repeat(64) }).success).toBe(true);
    const page = { version: 1, ...identity, sha256: 'a'.repeat(64), bytes: 17, offset: 10, chunk: '汉😀', nextOffset: null };
    expect(ToolEvidencePageSchema.safeParse(page).success).toBe(true);
    for (const invalid of [{ ...page, bytes: 16 }, { ...page, nextOffset: 17 }, { ...page, chunk: '' },
        { ...page, chunk: 'a'.repeat(32769), bytes: 32779 }, { ...page, extra: 'hidden' },
        { ...page, offset: 0, bytes: 3, chunk: '\ud800' }])
        expect(ToolEvidencePageSchema.safeParse(invalid).success).toBe(false);
    expect(ToolEvidenceResultSchema.safeParse({ ok: false, error: { code: 'storage_read_failed', category: 'storage',
        retryable: true, message: 'x'.repeat(262144) } }).success).toBe(false);
});
