import { expect, test } from 'bun:test';
import type { HostClient } from '../../../apps/desktop/main/host-client.ts';
import { collectSubagentEvidence } from '../../src/adapters/subagent-evidence.ts';

test('child evidence queries each original root once, and an empty list is an observed fact', async () => {
    const calls: Array<Parameters<HostClient['request']>[0]> = [];
    const host = { async request(command: Parameters<HostClient['request']>[0]) {
        calls.push(command);
        return { ok: true, data: { items: [], nextBeforeRunId: null,
            totals: { inputTokens: 0, outputTokens: 0, totalTokens: 0, cost: '0', usageComplete: true } } };
    } };
    expect(await collectSubagentEvidence(host, [{ runId: 1, sessionId: 3 }, { runId: 2, sessionId: 3 }]))
        .toMatchObject({ present: true, actual: { children: [], stopUnconfirmed: [] } });
    expect(calls.map(c => c.type)).toEqual(['list_subagents', 'list_subagents']);
    expect(await collectSubagentEvidence(host, [{ runId: 1, sessionId: 3 }, { runId: 1, sessionId: 3 }]))
        .toMatchObject({ present: false, actual: { gap: 'Duplicate parent Run' } });
    expect(calls).toHaveLength(2);
});

test('foreign child ownership is a gap and cannot trigger a detail read or model replay', async () => {
    const calls: string[] = [], at = '2026-10-11T00:00:00.000Z';
    const host = { async request(command: Parameters<HostClient['request']>[0]) {
        calls.push(command.type);
        return { ok: true, data: { items: [{ childRunId: 2, childSessionId: 4, childNativeSessionId: 'child', parentRunId: 99, parentSessionId: 3,
            originToolCallId: 5, parentNativeToolCallId: 'call', pluginAgentId: 'child-plugin', role: 'research-investigator', description: 'Synthetic',
            status: 'completed', createdAt: at, startedAt: at, endedAt: at, cancelRequestedAt: null, stoppedAt: at }], nextBeforeRunId: null,
            totals: { inputTokens: null, outputTokens: null, totalTokens: null, cost: null, usageComplete: false } } };
    } };
    expect(await collectSubagentEvidence(host, [{ runId: 1, sessionId: 3 }]))
        .toMatchObject({ present: false, actual: { children: [], gap: expect.stringContaining('Foreign') } });
    expect(calls).toEqual(['list_subagents']);
});
