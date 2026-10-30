import { expect, test } from 'bun:test';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { mkdtempSync } from '../../../tests/support/resources.ts';
import { reportFixture } from '../support/fixtures.ts';
import { createArchive, archiveReference, writeArchivePart } from '../../src/reports/archive.ts';
import { saveReport } from '../../src/reports/store.ts';
import { createBenchmarkPlan, finalizeBenchmark } from '../../src/execution/benchmark.ts';
import { observationRowsFromOtlp } from '../langfuse/otlp-fixture.ts';

test('Benchmark finalization waits for remote visibility without rerunning Trials or resending observations', async () => {
    const repo = mkdtempSync(join(tmpdir(), 'benchmark-visible-')), archive = createArchive(repo, { selection: 'smoke', compare: true });
    const connection = { api: 'openai-completions' as const, baseUrl: 'http://127.0.0.1:8767/v1', reasoning: 'max' as const };
    const ids = ['control', 'candidate'];
    for (const [index, id] of ids.entries()) {
        const report = reportFixture(); report.executionId = id; report.runId = archive.id;
        const trial = report.trials[0]!; trial.trialId = id + '-trial'; trial.traceId = (index ? 'b' : 'a').repeat(32);
        trial.execution!.identity = { ...trial.execution!.identity, executionId: id, trialId: trial.trialId };
        saveReport(archiveReference(archive.file, 'executions', id), report);
        writeArchivePart(archiveReference(archive.file, 'snapshots', id), { dataset: 'test', cases: [], materials: [] });
    }
    writeArchivePart(archiveReference(archive.file, 'experiment'), { contract: 'flowmate-experiment/v1', id: archive.id,
        createdAt: new Date().toISOString(), status: 'blocked', attribution: 'single-axis',
        plan: createBenchmarkPlan('smoke', { ...connection, model: 'gpt-6-luna' }, { ...connection, model: 'gpt-6.1-sol' }),
        arms: [{ id: 'sol', status: 'blocked', executionIds: ['control'] }, { id: 'luna', status: 'blocked', executionIds: ['candidate'] }] });
    const state = { sends: 0, delayed: false, observations: [] as any[], scores: [] as any[] };
    const server = Bun.serve({ hostname: '127.0.0.1', port: 0, async fetch(request) {
        const url = new URL(request.url);
        if (url.pathname.endsWith('/projects')) return Response.json({ data: [{ id: 'controlled-project' }] });
        if (url.pathname.endsWith('/otel/v1/traces')) {
            state.sends++; state.delayed = true;
            state.observations.push(...observationRowsFromOtlp(await request.json())); return Response.json({});
        }
        if (url.pathname.endsWith('/v2/observations')) {
            const delayed = state.delayed; state.delayed = false;
            return Response.json({ data: delayed ? [] : state.observations, meta: {} });
        }
        if (url.pathname.endsWith('/scores') && request.method === 'POST') {
            const score = await request.json() as any; state.scores.push(score); return Response.json({ id: score.id });
        }
        if (url.pathname.endsWith('/v3/scores')) return Response.json({ data: state.scores.map(score => ({ ...score,
            subject: { kind: 'trace', id: score.traceId } })), meta: {} });
        return new Response(null, { status: 404 });
    } });
    try {
        const summary = await finalizeBenchmark(repo, archive.id, { connection: { baseUrl: `http://127.0.0.1:${server.port}`, publicKey: 'public', secretKey: 'secret' } });
        expect(summary.exportComplete).toBe(true); expect(summary.observedTrials).toBe(2);
        expect(summary.executionComplete).toBe(false); expect(summary.exitCode).toBe(2);
        expect(state.sends).toBe(2); expect(state.scores).toHaveLength(2);
    } finally { await server.stop(true); }
});

test('project query failure before submission stays retryable without replacing original report facts', async () => {
    const repo = mkdtempSync(join(tmpdir(), 'benchmark-project-retry-')), archive = createArchive(repo, { selection: 'smoke', compare: true });
    const report = reportFixture(); report.executionId = 'control'; report.runId = archive.id;
    report.trials[0]!.trialId = 'control-trial'; report.trials[0]!.execution!.identity = { ...report.trials[0]!.execution!.identity, executionId: 'control', trialId: 'control-trial' };
    saveReport(archiveReference(archive.file, 'executions', 'control'), report);
    writeArchivePart(archiveReference(archive.file, 'snapshots', 'control'), { dataset: 'test', cases: [], materials: [] });
    const connection = { api: 'openai-completions' as const, baseUrl: 'http://127.0.0.1:8767/v1', reasoning: 'max' as const };
    writeArchivePart(archiveReference(archive.file, 'experiment'), { contract: 'flowmate-experiment/v1', id: archive.id,
        createdAt: new Date().toISOString(), status: 'blocked', attribution: 'single-axis',
        plan: createBenchmarkPlan('smoke', { ...connection, model: 'gpt-6-luna' }, { ...connection, model: 'gpt-6.1-sol' }),
        arms: [{ id: 'sol', status: 'blocked', executionIds: ['control'] }, { id: 'luna', status: 'blocked', executionIds: [] }] });
    const original = structuredClone(report.trials), state = { offline: true, sends: 0, observations: [] as any[], scores: [] as any[] };
    const server = Bun.serve({ hostname: '127.0.0.1', port: 0, async fetch(request) {
        const url = new URL(request.url);
        if (url.pathname.endsWith('/projects')) return state.offline ? new Response(null, { status: 503 }) : Response.json({ data: [{ id: 'controlled-project' }] });
        if (url.pathname.endsWith('/otel/v1/traces')) { state.sends++; state.observations.push(...observationRowsFromOtlp(await request.json())); return Response.json({}); }
        if (url.pathname.endsWith('/v2/observations')) return Response.json({ data: state.observations, meta: {} });
        if (url.pathname.endsWith('/scores') && request.method === 'POST') { const score = await request.json() as any; state.scores.push(score); return Response.json({ id: score.id }); }
        if (url.pathname.endsWith('/v3/scores')) return Response.json({ data: state.scores.map(score => ({ ...score, subject: { kind: 'trace', id: score.traceId } })), meta: {} });
        return new Response(null, { status: 404 });
    } });
    try {
        const options = { connection: { baseUrl: `http://127.0.0.1:${server.port}`, publicKey: 'public', secretKey: 'secret' } };
        const failed = await finalizeBenchmark(repo, archive.id, options);
        expect(failed.exportComplete).toBe(false); expect(state.sends).toBe(0);
        const { readReport } = await import('../../src/reports/store.ts');
        const saved = readReport(archiveReference(archive.file, 'executions', 'control'));
        expect(saved.export.backend).toBe('local'); expect(saved.export.status).toBe('disabled');
        expect(saved.export.target).toBeUndefined(); expect(saved.export.progress).toBeUndefined();
        expect(saved.trials).toEqual(original);
        state.offline = false;
        expect((await finalizeBenchmark(repo, archive.id, options)).exportComplete).toBe(true);
        expect(state.sends).toBe(1); expect(state.scores).toHaveLength(1);
    } finally { await server.stop(true); }
}, 30000);
