import { expect, test } from 'bun:test';
import type { HostClient } from '../../../apps/desktop/main/host-client.ts';
import { collectHistoryEvidence } from '../../src/adapters/history-evidence.ts';

function fixture(fault?: 'revision' | 'cursor' | 'missing' | 'foreign') {
    const session = { sessionId: 1, nativeSessionId: 'native', title: 'Synthetic', status: 'active', createdAt: '2026-10-11T00:00:00.000Z', updatedAt: '2026-10-11T00:00:00.000Z',
        availability: 'ready', historyState: 'recoverable', activeRunId: null, modelUseBlocked: false, hasBusinessHistory: false, deletePending: false };
    const commit = { commitRevision: 7, entryCount: 2, leafId: 'B' };
    const summary = { sequence: 0, entryId: 'A', parentId: null, type: 'message', timestamp: session.createdAt, isCurrentPath: true, isLeaf: false,
        preview: '汉', truncated: true, originSessionId: 3, originRunId: 4, canSelect: true, cannotSelectReason: null };
    const second = { ...summary, sequence: 1, entryId: 'B', parentId: 'A', isLeaf: true, type: 'model_change', preview: '', truncated: false };
    const text = '汉'.repeat(21845) + '😀tail';
    const calls: Array<Parameters<HostClient['request']>[0]> = [];
    const host = { async request(command: Parameters<HostClient['request']>[0]) {
        calls.push(command);
        if (command.type === 'query_session_history') {
            const after = command.input.afterSequence;
            return { ok: true, data: { session: { ...session, sessionId: fault === 'foreign' ? 99 : 1 },
                commit: { ...commit, commitRevision: fault === 'revision' && after !== undefined ? 8 : 7 },
                items: after === undefined ? [summary] : fault === 'missing' ? [] : [second], nextAfterSequence: after === undefined ? 0 : null } };
        }
        if (command.type === 'query_session_history_entry') {
            const offset = command.input.offset ?? 0;
            if (command.input.entryId === 'B') return { ok: true, data: { summary: second, commit,
                fields: { type: 'model_change', provider: { text: 'fixture', truncated: false }, modelId: { text: 'fixture', truncated: false } }, part: null, partIndex: 0, offset: 0, next: null } };
            const chunk = offset === 0 ? '汉'.repeat(21845) : '😀tail';
            return { ok: true, data: { summary, commit, fields: { type: 'message', role: 'user', toolName: null, callId: null, stopReason: null, isError: null, hasImages: false, imageMimeTypes: [] },
                part: { kind: 'text', text: chunk }, partIndex: 0, offset, next: offset === 0 ? { partIndex: 0, offset: fault === 'cursor' ? 65536 : 65535 } : null } };
        }
        throw new Error('Unexpected write or replay: ' + command.type);
    } };
    return { host, calls, text };
}

test('history evidence pins one commit and joins UTF-8 byte continuations, preserving fork origins', async () => {
    const f = fixture();
    expect(await collectHistoryEvidence(f.host, { sessionId: 1, pageSize: 1 })).toMatchObject({ present: true, actual: {
        commit: { commitRevision: 7, entryCount: 2, leafId: 'B' }, entries: [
            { summary: { entryId: 'A', originSessionId: 3, originRunId: 4 }, parts: [{ index: 0, kind: 'text', text: f.text }] },
            { summary: { entryId: 'B' }, parts: [] }
        ], acquisition: 'controller-query', modelUse: 'requires-original-context-evidence' } });
    const details = f.calls.filter(c => c.type === 'query_session_history_entry');
    expect(details.map(c => c.input.offset ?? 0)).toEqual([0, 65535, 0]);
    expect(f.calls.slice(1).every(c => 'input' in c && c.input && 'expectedCommitRevision' in c.input && c.input.expectedCommitRevision === 7)).toBe(true);
});

test.each(['revision', 'cursor', 'missing', 'foreign'] as const)('history evidence records a gap for %s without replay or silently retrying', async fault => {
    const f = fixture(fault), result = await collectHistoryEvidence(f.host, { sessionId: 1, pageSize: 1 });
    expect(result).toMatchObject({ present: false, actual: { gap: expect.any(String) } });
    expect(f.calls.every(c => c.type.startsWith('query_session_history'))).toBe(true);
    expect(f.calls.length).toBeLessThanOrEqual(6);
});
