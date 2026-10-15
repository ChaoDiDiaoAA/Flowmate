import { expect, test } from 'bun:test';
import type { HostClient } from '../../../apps/desktop/main/host-client.ts';
import type { ToolCallSnapshot } from '../../../packages/contracts/src/activity.ts';
import { collectToolEvidence } from '../../src/adapters/tool-evidence.ts';

function fixture(fault?: 'length' | 'foreign' | 'changed' | 'cursor' | 'payload' | 'late') {
    const at = '2026-10-11T00:00:00.000Z', text = '汉😀'.repeat(6000);
    const tool: ToolCallSnapshot = { toolCallId: 8, runId: 21, sessionId: 12, nativeToolCallId: 'original', context: null,
        toolName: 'read', toolVersion: '1', effect: 'READ', status: 'succeeded', args: { version: 1, raw: { path: 'source.md' }, final: { path: 'source.md' } },
        result: { version: 1, status: 'succeeded', committedCandidateId: null, data: { text } },
        delivery: { version: 1, state: 'request_observed', messageObservedAt: at, includedInCallSequence: 2, requestDispatchedAt: at, error: null },
        cleanup: { version: 1, stopReason: null, stopped: true, errors: [] }, runtimeObservation: null,
        requestedAt: at, startedAt: at, endedAt: at, stoppedAt: at };
    if (fault === 'payload') tool.runId = 99;
    const bytes = Buffer.from(JSON.stringify(tool));
    const calls: Array<Parameters<HostClient['request']>[0]> = [];
    const host = { async request(command: Parameters<HostClient['request']>[0]) {
        calls.push(command);
        if (command.type !== 'query_run_tool_evidence') throw new Error('Unexpected write or replay: ' + command.type);
        const start = command.input.offset ?? 0;
        let end = Math.min(bytes.length, start + (command.input.limit ?? 8192));
        while (end < bytes.length && (bytes[end]! & 0xc0) === 0x80) end--;
        return { ok: true, data: { version: 2, evidenceRevision: fault === 'changed' && start > 0 || fault === 'late' && calls.length > 1 && start === 0 ? 2 : 1, runId: fault === 'foreign' ? 99 : 21, sessionId: 12, toolCallId: 8,
             bytes: fault==='length'?bytes.length+1:bytes.length, offset: start,
            chunk: bytes.subarray(start, end).toString('utf8'), nextOffset: end === bytes.length ? null : fault === 'cursor' ? end + 1 : end } };
    } };
    return { host, tool,  calls, identity: { runId: 21, sessionId: 12, toolCallId: 8, toolName: 'read' } };
}

test('original tool evidence joins bounded UTF-8 pages and verifies the complete raw payload and immutable identity', async () => {
    const f = fixture();
    expect(await collectToolEvidence(f.host, [f.identity])).toMatchObject({ present: true, actual: { calls: [{  tool: f.tool }],
        acquisition: 'controller-query', modelUse: 'requires-original-delivery-and-context-evidence' } });
    expect(f.calls.length).toBeGreaterThan(5);
    expect(f.calls.every(c => c.type === 'query_run_tool_evidence')).toBe(true);
});

test.each(['length', 'foreign', 'changed', 'cursor', 'payload', 'late'] as const)('original tool evidence retains a gap for %s and never retries or replays', async fault => {
    const f = fixture(fault);
    expect(await collectToolEvidence(f.host, [f.identity])).toMatchObject({ present: false, actual: { calls: [], gap: expect.any(String) } });
    expect(f.calls.length).toBeLessThan(20);
});
