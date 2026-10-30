import { expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { archiveReference, createArchive, finishArchive, readArchive, updateArchive, writeArchivePart } from '../../src/reports/archive.ts';
import { saveReport, type LocalReport } from '../../src/reports/store.ts';
import { retryScoring, readScoringRevision, type ScoringRevision } from '../../src/execution/score-retry.ts';
import { uploadScoringRevisionScores } from '../../src/langfuse/scoring-revision.ts';
import { caseV2Schema } from '../../src/dataset-loader/schema.ts';
import { metricCatalog } from '../../src/scoring/catalog.ts';
import { compileEvaluatorPlan } from '../../src/scoring/evaluator-plan.ts';
import { createRegistry } from '../../src/scoring/registry.ts';
import { evaluateAll } from '../../src/scoring/evaluate.ts';
import { aggregate } from '../../src/scoring/aggregate.ts';
import { judgeConfig } from '../../src/scoring/judges/client.ts';
import { rubricsFor, type CompactPlan } from '../../src/scoring/judges/compact.ts';
import { judgeResponse } from '../support/judge-response.ts';

async function fixture() {
    const repo = mkdtempSync(join(tmpdir(), 'flowmate-revision-upload-')); mkdirSync(join(repo, 'agent-eval'));
    const archive = createArchive(repo, { selection: 'case' });
    const traceId = 'abcdef0123456789abcdef0123456789', startedAt = '2026-10-01T00:00:00Z', endedAt = '2026-10-01T00:00:01Z';
    const plan: CompactPlan = { contract: 'flowmate-semantic-plan/v1', criteria: ['completion-verification', 'false-completion'].map(metricId => {
        const metric = metricCatalog.find(metric => metric.id === metricId)!;
        return { metricId, version: 1, unit: metric.unit, denominator: 1, required: true,
            rule: 'Verify saved independent conditions.', evidence: ['answer', 'task-endpoint', 'gold-task'], trigger: 'completed-endpoint' };
    }) };
    const task = caseV2Schema.parse({ contract: 'flowmate-agent-case/v2', id: 'retry-case', version: 1, name: 'Synthetic saved Trial',
        category: 'synthetic', tags: ['synthetic'], requires: ['agent'], input: { prompt: 'PRIVATE_INPUT', materials: [] },
        expected: { success: ['PRIVATE_GOLD original expected fact'], failure: ['Invent a fact'], checks: [{ metric: 'task-result', required: true }],
            metrics: metricCatalog.map(metric => ({ metricId: metric.id, version: metric.version, unit: metric.unit,
                ...(metric.id === 'task-success' || plan.criteria.some(criterion => criterion.metricId === metric.id) ? { denominator: 1 } : { notApplicable: 'Outside this synthetic task' }) })), semantic: plan },
        review: { status: 'pending' } });
    const execution = { identity: { executionId: 'original-execution', trialId: 'original-trial', caseId: task.id, caseVersion: 1 },
        started: true, status: 'completed' as const, endpointReached: true, input: { prompt: task.input.prompt, materials: [] }, answer: 'PRIVATE_ANSWER',
        artifacts: [], observations: [], evidence: { answer: { present: true, actual: 'PRIVATE_ANSWER', source: 'saved original answer' },
            'task-endpoint': { present: true, actual: true, source: 'saved original endpoint' },
            cleanup: { present: true, actual: { stopped: true, closed: true }, source: 'saved original process exit' } },
        configuration: { model: 'original-agent' }, usage: {}, startedAt, endedAt };
    const judge = judgeConfig({ FLOWMATE_JUDGE_MODEL: 'llama-3.3-70b-versatile', FLOWMATE_JUDGE_API: 'openai-completions',
        FLOWMATE_JUDGE_BASE_URL: 'https://example.invalid/v1', FLOWMATE_JUDGE_API_KEY: 'revision-synthetic-judge-key', FLOWMATE_JUDGE_MAX_OUTPUT_TOKENS: '32768' }, repo)!;
    const scored = await evaluateAll({ task, result: execution, projected: execution.input, judge,
        fetcher: async () => new Response('Synthetic original Judge failure', { status: 402 }) }, task.expected.checks);
    const { rubric: _, ...connectionConfig } = scored.judgeCalls[0]!.configuration;
    const report: LocalReport = { contract: 'flowmate-agent-run/v2', executionId: 'original-execution', runId: archive.id, executionKind: 'model',
        dataset: { id: 'synthetic', version: 1, subject: 'agent' }, selection: 'case', environment: 'offline-synthetic',
        startedAt, endedAt, repeat: 1, executionComplete: true, scoring: 'complete', manualReview: 'none', formalAcceptance: 'not-assessed',
        scoringConfiguration: { version: 1, scoringVersion: 2, judgeMode: 'required', judge: connectionConfig, rubrics: rubricsFor([plan]) },
        export: { backend: 'local', status: 'disabled' }, trials: [{ caseId: task.id, caseVersion: 1,
            caseConditions: { task, scoring: { version: 1, required: [], judges: [] } }, caseName: task.name, category: task.category,
            partition: 'smoke', repetition: 1, trialId: 'original-trial', traceId, ...aggregate(scored.scores, execution),
            execution, scores: scored.scores, judgeCalls: scored.judgeCalls, semanticPlan: plan, metricPlan: task.expected.metrics,
            evaluatorPlan: compileEvaluatorPlan(task, task.expected.checks), feedback: 'none',
        }] };
    writeArchivePart(archiveReference(archive.file, 'snapshots', report.executionId), { dataset: report.dataset.id, cases: [task], judge: connectionConfig,
        scoring: { catalog: metricCatalog, evaluators: createRegistry().list().map(({ id, version, rubric }) => ({ id, version, rubric })) } });
    saveReport(archiveReference(archive.file, 'executions', report.executionId), report);
    finishArchive(archive.file, 'complete');
    const retried = await retryScoring(repo, { runId: archive.id, failedOnly: true }, { judgeConfig: judge, fetcher: async () => judgeResponse({
        choices: [{ message: { content: JSON.stringify({ v: 1, results: [
            { metricId: 'completion-verification', counts: { numerator: 1, denominator: 1, unassessable: 0 }, failures: [] },
            { metricId: 'false-completion', counts: { numerator: 0, denominator: 1, unassessable: 0 }, failures: [] },
        ] }) }, finish_reason: 'stop' }] }) });
    const revisionId = retried.revisionId, timestamp = readScoringRevision(repo, archive.id, revisionId).endedAt!;
    const fact = report.trials[0]!.scores.find(score => score.metricId === 'task-result')!;
    const originalId = traceId + ':task-result:1';
    const state = { posts: [] as any[], rows: [{ id: originalId, name: fact.name, value: 1, timestamp: endedAt,
        traceId, source: 'API', subject: { kind: 'trace', id: traceId } }] as any[], scoreQueries: 0, otelPosts: 0,
        failPost: false, hide: false, projectId: 'synthetic-project' };
    const server = Bun.serve({ hostname: '127.0.0.1', port: 0, async fetch(request) {
        const url = new URL(request.url);
        if (url.pathname.endsWith('/projects')) return Response.json({ data: [{ id: state.projectId }] });
        if (url.pathname.endsWith('/v3/scores')) {
            state.scoreQueries++; expect(url.searchParams.get('traceId')).toBe(traceId);
            return Response.json({ data: state.hide ? [] : state.rows, meta: {} });
        }
        if (url.pathname.endsWith('/scores') && request.method === 'POST') {
            const score = await request.json() as any; state.posts.push(score);
            const receipt = readArchive(archive.file).exports['scores-' + revisionId] as any;
            expect(receipt.submittedIds).toContain(score.id);
            if (state.failPost) return Response.json({ message: 'Synthetic unknown write result' }, { status: 503 });
            state.rows.push({ ...score, source: 'API', subject: { kind: 'trace', id: score.traceId } });
            return Response.json({ id: score.id });
        }
        if (request.method === 'POST') state.otelPosts++;
        return new Response(null, { status: 404 });
    } });
    const connection = { baseUrl: `http://127.0.0.1:${server.port}`, publicKey: 'revision-test-public', secretKey: 'revision-test-secret' };
    updateArchive(archive.file, run => { run.exports[report.executionId] = { backend: 'langfuse', status: 'complete',
        target: { baseUrl: connection.baseUrl, projectId: state.projectId }, progress: { total: 2,
            acceptedEventIds: [traceId + ':root', originalId], rejectedEventIds: [], scoreTimestamp: endedAt, knownScoreIds: [originalId] } }; });
    return { repo, archive, revisionId, timestamp, report, traceId, originalId, connection, state,
        async close() { await server.stop(true); rmSync(repo, { recursive: true, force: true }); } };
}

test('revision upload appends only namespaced semantic and derived scores, never observations or original deterministic scores', async () => {
    const f = await fixture(), before = readArchive(f.archive.file), originalRow = structuredClone(f.state.rows[0]);
    try {
        const result = await uploadScoringRevisionScores(f.repo, { runId: f.archive.id, revisionId: f.revisionId }, { connection: f.connection });
        expect(result).toMatchObject({ revisionId: f.revisionId, status: 'complete', total: 3, verified: 3 });
        expect(f.state.otelPosts).toBe(0); expect(f.state.posts).toHaveLength(3);
        expect(f.state.posts.map(score => score.id)).toEqual(['completion-verification', 'false-completion', 'task-success'].map(metric => `${f.traceId}:${metric}:1:${f.revisionId}`));
        expect(f.state.posts.every(score => score.timestamp === f.timestamp)).toBe(true);
        expect(f.state.posts[0]!.metadata).toMatchObject({ runId: f.archive.id, revisionId: f.revisionId,
            executionId: 'original-execution', trialId: 'original-trial', caseId: 'retry-case', evaluatorId: 'completion-verification', method: 'llm-judge' });
        expect(JSON.stringify(f.state.posts)).not.toContain('PRIVATE_'); expect(JSON.stringify(f.state.posts)).not.toContain('revision-test-secret');
        const after = readArchive(f.archive.file);
        expect(after.executions).toEqual(before.executions); expect(after.scoringRevisions).toEqual(before.scoringRevisions);
        expect(after.exports[f.report.executionId]).toEqual(before.exports[f.report.executionId]); expect(f.state.rows[0]).toEqual(originalRow);
        const queries = f.state.scoreQueries;
        expect((await uploadScoringRevisionScores(f.repo, { runId: f.archive.id, revisionId: f.revisionId }, { connection: f.connection })).status).toBe('complete');
        expect(f.state.posts).toHaveLength(3); expect(f.state.scoreQueries).toBeGreaterThan(queries); expect(f.state.otelPosts).toBe(0);
    } finally { await f.close(); }
});

test('a submitted score with unknown remote outcome is queried again and never blindly posted again', async () => {
    const f = await fixture(); f.state.failPost = true;
    try {
        const first = await uploadScoringRevisionScores(f.repo, { runId: f.archive.id, revisionId: f.revisionId }, { connection: f.connection });
        expect(first.status).not.toBe('complete'); expect(f.state.posts).toHaveLength(1);
        f.state.failPost = false;
        const second = await uploadScoringRevisionScores(f.repo, { runId: f.archive.id, revisionId: f.revisionId }, { connection: f.connection });
        expect(second.status).not.toBe('complete'); expect(f.state.posts).toHaveLength(1);
        const score = f.state.posts[0]!; f.state.rows.push({ ...score, source: 'API', subject: { kind: 'trace', id: f.traceId } });
        const recovered = await uploadScoringRevisionScores(f.repo, { runId: f.archive.id, revisionId: f.revisionId }, { connection: f.connection });
        expect(recovered.status).toBe('complete'); expect(f.state.posts).toHaveLength(3); expect(f.state.otelPosts).toBe(0);
    } finally { await f.close(); }
});

test.each(['value', 'name', 'timestamp', 'trace'] as const)('remote %s drift blocks replacement of a namespaced revision score', async field => {
    const f = await fixture();
    try {
        await uploadScoringRevisionScores(f.repo, { runId: f.archive.id, revisionId: f.revisionId }, { connection: f.connection });
        const row = f.state.rows[1]!;
        if (field === 'value') row.value = 0;
        if (field === 'name') row.name = 'Different score';
        if (field === 'timestamp') row.timestamp = '2026-10-02T00:00:02.000Z';
        if (field === 'trace') row.subject.id = 'another-trace';
        const result = await uploadScoringRevisionScores(f.repo, { runId: f.archive.id, revisionId: f.revisionId }, { connection: f.connection });
        expect(result.status).toBe('blocked'); expect(f.state.posts).toHaveLength(3); expect(f.state.otelPosts).toBe(0);
    } finally { await f.close(); }
});

test.each(['unverified', 'wrong-project'] as const)('an %s original Trace cannot receive revision scores', async condition => {
    const f = await fixture();
    try {
        if (condition === 'unverified') updateArchive(f.archive.file, archive => { (archive.exports[f.report.executionId] as any).status = 'partial'; });
        else f.state.projectId = 'another-project';
        await expect(uploadScoringRevisionScores(f.repo, { runId: f.archive.id, revisionId: f.revisionId }, { connection: f.connection })).rejects.toThrow(/Trace|target|project/);
        expect(f.state.posts).toHaveLength(0); expect(f.state.otelPosts).toBe(0);
    } finally { await f.close(); }
});

test.each(['raw', 'local-fact', 'unfinished-call'] as const)('a revision with forged %s is rejected before any platform score write', async forgery => {
    const f = await fixture();
    try {
        updateArchive(f.archive.file, archive => {
            const trial = (archive.scoringRevisions[f.revisionId] as ScoringRevision).executions[f.report.executionId]!.trials['original-trial']!;
            if (forgery === 'raw') trial.judgeCalls[0]!.raw = '{"v":1,"results":[]}';
            if (forgery === 'local-fact') trial.scores.find(score => score.metricId === 'task-result')!.actual = 'Changed original local result';
            if (forgery === 'unfinished-call') { trial.judgeCalls[0]!.lifecycle = 'submitted'; trial.judgeCalls[0]!.endedAt = ''; }
        });
        await expect(uploadScoringRevisionScores(f.repo, { runId: f.archive.id, revisionId: f.revisionId }, { connection: f.connection })).rejects.toThrow();
        expect(f.state.posts).toHaveLength(0); expect(f.state.otelPosts).toBe(0);
    } finally { await f.close(); }
});
