import { syntheticNativeModel } from '../support/native-model.ts';
import { expect, test } from 'bun:test';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { readFileSync } from 'node:fs';
import { createHttpProvider, mkdtempSync } from '../../../tests/support/resources.ts';
import { prepareHostTrial } from '../../src/adapters/host-research.ts';
import { REPO_ROOT } from '../../src/dataset-loader/local.ts';
import type { AgentTrial, AgentTrialSession } from '../../src/adapters/agent.ts';
import { executeCase } from '../../src/execution/execute-case.ts';

function reply(text: string, inputTokens = 10) {
    const chunk = (delta: object, finish: string | null = null) => `data: ${JSON.stringify({ id: 'history-fixture',
        choices: [{ index: 0, delta, finish_reason: finish }] })}\n\n`;
    return new Response(chunk({ role: 'assistant', content: text }) + chunk({}, 'stop')
        + `data: ${JSON.stringify({ choices: [], usage: { prompt_tokens: inputTokens, completion_tokens: 2, total_tokens: inputTokens + 2 } })}\n\ndata: [DONE]\n\n`,
        { headers: { 'content-type': 'text/event-stream' } });
}
function trial(port: number, isolation?: undefined): AgentTrial {
    return { identity: { executionId: 'history-engineering', trialId: 'history-1', caseId: 'history-case', caseVersion: 1 },
        directory: mkdtempSync(join(tmpdir(), 'eval-history-host-')), requires: ['agent', 'history'],
        input: { prompt: 'POLICY_V1: use the original policy.', materials: [] },
        configuration: { modelCapabilities: syntheticNativeModel, model: 'history-fixture', baseUrl: `http://${isolation ? '127.0.0.1' : '127.0.0.1'}:${port}/v1`, api: 'openai-completions' } };
}

for (const isolation of [undefined] as const) test
('actual ' + (isolation ?? 'local') + ' Host restart preserves committed corrections and original input identities', async () => {
    const requests: unknown[] = [];
    const server = await createHttpProvider(async request => { requests.push(await request.json()); return reply('Saved answer ' + requests.length); }, isolation ? '0.0.0.0' : undefined);
    const item = trial(server.port, isolation);
    Object.assign(item, { steps: [
        { id: 'first', action: 'user-message', instruction: item.input.prompt },
        { id: 'correct', action: 'user-message', instruction: 'POLICY_V2_CNY: replace the original currency with CNY.' },
        { id: 'restart', action: 'restart-host' },
        { id: 'replay', action: 'input-replay', fromStep: 'first' },
        { id: 'continue', action: 'user-message', instruction: 'CONTINUE_AFTER_RESTART using the latest saved correction.' }
    ] });
    let session: AgentTrialSession | undefined;
    try {
        session = await prepareHostTrial(item, new AbortController().signal, { repo: REPO_ROOT, credential: 'synthetic-restart-key' });
        const result = await session.execute(new AbortController().signal);
        expect(result).toMatchObject({ status: 'completed', endpointReached: true, evidence: { 'history-operations': { present: true } } });
        expect(requests).toHaveLength(3);
        expect(JSON.stringify(requests[0])).not.toContain('POLICY_V2_CNY');
        expect(JSON.stringify(requests[0])).not.toContain('CONTINUE_AFTER_RESTART');
        expect(JSON.stringify(requests[2])).toContain('POLICY_V2_CNY');
        expect(JSON.stringify(requests[2])).toContain(item.input.prompt);
        const operations = result.evidence['history-operations']!.actual as Array<{ action: string; verified: boolean;
            before: Record<string, unknown>; after: Record<string, unknown>; close: { ok: boolean; data: { closed: boolean; stopped: boolean } };
            connectionEpochBefore: number; connectionEpochAfter: number }>;
        expect(operations).toHaveLength(1);
        expect(operations[0]).toMatchObject({ action: 'restart-host', verified: true, close: { ok: true, data: { closed: true, stopped: true } } });
        expect(operations[0]!.after).toEqual(operations[0]!.before);
        expect(operations[0]!.connectionEpochAfter).toBe(operations[0]!.connectionEpochBefore + 1);
        expect(result.evidence.inputs!.actual).toHaveLength(3);
        expect(result.evidence.runs!.actual).toHaveLength(3);
        const receipts = result.evidence['step-results']!.actual as Array<{ stepId: string; result: { data: { inputId: number; runId: number; sessionId: number; requestId: string } } }>;
        const { requestId: firstDeliveryId, ...firstIdentity } = receipts.find(r => r.stepId === 'first')!.result.data;
        const { requestId: replayDeliveryId, ...replayIdentity } = receipts.find(r => r.stepId === 'replay')!.result.data;
        expect(replayIdentity).toEqual(firstIdentity);
        expect(replayDeliveryId).not.toBe(firstDeliveryId);
        expect((await session.snapshot()).evidence['history-operations']).toEqual(result.evidence['history-operations']);
        expect(requests).toHaveLength(3);
    } finally {
        if (session) expect(await session.close()).toMatchObject({ present: true, actual: { stopped: true, closed: true } });
        await server.stop();
    }
}, 45000);

for (const isolation of [undefined] as const) test
('actual ' + (isolation ?? 'local') + ' Host fork and branch preserve original origins and change the next request without replay', async () => {
    const requests: unknown[] = [];
    const server = await createHttpProvider(async request => { requests.push(await request.json()); return reply('Saved original answer ' + requests.length); }, isolation ? '0.0.0.0' : undefined);
    const item = trial(server.port, isolation);
    Object.assign(item, { steps: [
        { id: 'first', action: 'user-message', instruction: item.input.prompt },
        { id: 'second', action: 'user-message', instruction: 'POLICY_V2: this later policy is outside the selected fork.' },
        { id: 'fork', action: 'fork-history', fromStep: 'first', target: 'result', title: 'Policy continuation' },
        { id: 'fork-answer', action: 'user-message', instruction: 'Answer only from the selected original policy.' },
        { id: 'fork-correction', action: 'user-message', instruction: 'POLICY_V3: this correction will be on another branch.' },
        { id: 'branch', action: 'branch-history', fromStep: 'fork-answer', target: 'result' },
        { id: 'continued', action: 'user-message', instruction: 'Continue from the selected branch.' },
        { id: 'replay', action: 'input-replay', fromStep: 'continued' }
    ] });
    let session: AgentTrialSession | undefined;
    try {
        session = await prepareHostTrial(item, new AbortController().signal, { repo: REPO_ROOT, credential: 'synthetic-history-key' });
        const result = await session.execute(new AbortController().signal);
        expect(result).toMatchObject({ status: 'completed', endpointReached: true, evidence: {
            history: { present: true }, 'session-histories': { present: true }, 'history-operations': { present: true },
            'interaction-history': { present: true }, 'input-projection': { present: true }
        } });
        expect(requests).toHaveLength(5);
        expect(JSON.stringify(requests[0])).not.toContain('POLICY_V2');
        expect(JSON.stringify(requests[0])).not.toContain('POLICY_V3');
        expect(JSON.stringify(requests[2])).toContain('POLICY_V1');
        expect(JSON.stringify(requests[2])).not.toContain('POLICY_V2');
        expect(JSON.stringify(requests[4])).toContain('POLICY_V1');
        expect(JSON.stringify(requests[4])).not.toContain('POLICY_V2');
        expect(JSON.stringify(requests[4])).not.toContain('POLICY_V3');
        const histories = result.evidence['session-histories']!.actual as Array<{ present: boolean; actual: { sessionId: number; entries: Array<{ summary: { originSessionId: number; originRunId: number | null } }> } }>;
        expect(histories).toHaveLength(2);
        const original = histories[0]!.actual, forked = histories[1]!.actual;
        expect(forked.sessionId).not.toBe(original.sessionId);
        expect(forked.entries.some(e => e.summary.originSessionId === original.sessionId && e.summary.originRunId !== null)).toBe(true);
        expect((result.evidence.runs!.actual as unknown[])).toHaveLength(5);
        expect((result.evidence['interaction-history']!.actual as unknown[])).toHaveLength(5);
        expect(result.usage).toMatchObject({ inputTokens: 50, outputTokens: 10, totalTokens: 60, cost: null });
        const before = requests.length;
        expect((await session.snapshot()).evidence['history-operations']).toEqual(result.evidence['history-operations']);
        expect(requests).toHaveLength(before);
    } finally {
        if (session) expect(await session.close()).toMatchObject({ present: true, actual: { stopped: true, closed: true } });
        await server.stop();
    }
}, 45000);

for (const isolation of [undefined] as const) test
('actual ' + (isolation ?? 'local') + ' manual compaction is saved once and its summary reaches the next model request', async () => {
    const requests: unknown[] = [];
    const server = await createHttpProvider(async request => {
        requests.push(await request.json());
        return reply(requests.length === 5 ? 'SUMMARY_MARKER: preserve the declared original policy.' : 'Answer ' + requests.length);
    }, isolation ? '0.0.0.0' : undefined);
    const item = trial(server.port, isolation); item.requires.push('compaction');
    item.input.prompt = 'Declared original policy. ' + 'x'.repeat(45000);
    Object.assign(item, { steps: [
        ...Array.from({ length: 4 }, (_, i) => ({ id: 'seed-' + i, action: 'user-message',
            instruction: i === 0 ? item.input.prompt : 'Authorized prior turn ' + i + ' ' + 'y'.repeat(45000) })),
        { id: 'compact', action: 'compact-history' },
        { id: 'continue', action: 'user-message', instruction: 'Use the saved summary for this answer.' }
    ] });
    let session: AgentTrialSession | undefined;
    try {
        session = await prepareHostTrial(item, new AbortController().signal, { repo: REPO_ROOT, credential: 'synthetic-compaction-key' });
        const result = await session.execute(new AbortController().signal);
        expect(result).toMatchObject({ status: 'completed', endpointReached: true,
            evidence: { 'history-operations': { present: true }, history: { present: true }, 'interaction-history': { present: true } } });
        const operations = result.evidence['history-operations']!.actual as Array<{ action: string; after: { operation: { generated: boolean; saved: { leafId: string }; stopped: boolean; nativeOutcome: string } } }>;
        expect(operations).toHaveLength(1);
        expect(operations[0]!.action).toBe('compact-history');
        expect(operations[0]!.after.operation.generated).toBe(true);
        expect(operations[0]!.after.operation.stopped).toBe(true);
        expect(operations[0]!.after.operation.nativeOutcome).toBe('succeeded');
        expect(typeof operations[0]!.after.operation.saved.leafId).toBe('string');
        expect(JSON.stringify(result.evidence.history!.actual)).toContain('SUMMARY_MARKER');
        expect(requests).toHaveLength(6);
        expect(JSON.stringify(requests[5])).toContain('SUMMARY_MARKER');
        expect((result.evidence.runs!.actual as unknown[])).toHaveLength(5);
        expect(result.usage).toMatchObject({ inputTokens: 60, outputTokens: 12, totalTokens: 72, cost: null });
        expect((await session.snapshot()).evidence['history-operations']).toEqual(result.evidence['history-operations']);
        expect(requests).toHaveLength(6);
    } finally {
        if (session) expect(await session.close()).toMatchObject({ present: true, actual: { stopped: true, closed: true } });
        await server.stop();
    }
}, 45000);

test('executeCase cancellation saves the original manual compaction stop and never sends the future message', async () => {
    let entered!: () => void, release!: () => void;
    const atSummary = new Promise<void>(resolve => { entered = resolve; });
    const barrier = new Promise<void>(resolve => { release = resolve; });
    let requests = 0, transportStoppedAt: number | null = null;
    const server = await createHttpProvider(async request => {
        await request.json(); requests++;
        if (requests === 5) {
            request.signal.addEventListener('abort', () => { transportStoppedAt = Date.now(); release(); }, { once: true });
            return new Response(new ReadableStream({ async start(controller) {
                entered(); await barrier;
                try { controller.enqueue(new TextEncoder().encode(await reply('Controlled summary').text())); controller.close(); }
                catch { /* The cancelled transport has already closed its response. */ }
            } }), { headers: { 'content-type': 'text/event-stream' } });
        }
        return reply('Controlled answer ' + requests);
    });
    const item = trial(server.port); item.requires.push('compaction');
    item.input.prompt = 'Authorized history. ' + 'x'.repeat(45000);
    Object.assign(item, { steps: [
        ...Array.from({ length: 4 }, (_, i) => ({ id: 'seed-' + i, action: 'user-message',
            instruction: i === 0 ? item.input.prompt : 'Prior turn ' + i + ' ' + 'y'.repeat(45000) })),
        { id: 'compact', action: 'compact-history' },
        { id: 'future', action: 'user-message', instruction: 'FUTURE_AFTER_CANCEL' }
    ] });
    let session: AgentTrialSession | undefined;
    const abort = new AbortController();
    try {
        const running = executeCase({ readiness: () => ({ ready: true, reason: 'Controlled engineering only' }),
            async prepare(trial, signal) {
                session = await prepareHostTrial(trial, signal, { repo: REPO_ROOT, credential: 'synthetic-cancel-key' });
                return session;
            } }, item, 30000, 10000, abort.signal);
        await Promise.race([atSummary, running.then(() => { throw new Error('Compaction did not request its original summary'); })]);
        abort.abort(); const completed = await running, result = completed.execution;
        expect(completed.stopFailed).toBe(false);
        expect(result.status).toBe('cancelled');
        expect(result.error?.code).toBe('cancelled');
        expect(transportStoppedAt).not.toBeNull();
        expect(Date.parse(result.endedAt!)).toBeGreaterThanOrEqual(transportStoppedAt!);
        expect(result.endpointReached).toBe(false);
        const operations = result.evidence['history-operations']!.actual as Array<{ after: { operation: { nativeOutcome: string; stopped: boolean; saved: unknown; stopRequested: boolean; error: { code: string } } } }>;
        expect(operations[0]!.after.operation).toMatchObject({ stopped: true, saved: null, stopRequested: true, error: { code: 'compaction_cancelled' } });
        expect(['failed', 'cancelled']).toContain(operations[0]!.after.operation.nativeOutcome);
        expect(result.evidence['history-operations']!.present).toBe(true);
        expect(result.evidence.cleanup).toMatchObject({ present: true, actual: { closed: true, stopped: true } });
        expect(result.usage).toMatchObject({ inputTokens: null, outputTokens: null, totalTokens: null, cost: null });
        expect(JSON.parse(readFileSync(join(item.directory, 'execution.json'), 'utf8')).evidence['history-operations'].actual[0].after.operation.stopped).toBe(true);
        expect(requests).toBe(5);
        expect((result.evidence.runs!.actual as unknown[])).toHaveLength(4);
    } finally {
        release();
        if (session) expect(await session.close()).toMatchObject({ present: true, actual: { stopped: true, closed: true } });
        await server.stop();
    }
}, 45000);
