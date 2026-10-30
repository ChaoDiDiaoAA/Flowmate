import { afterAll, expect, test } from 'bun:test';
import { mkdtempSync, mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { createArchive, archiveReference, readArchive, writeArchivePart, finishArchive, updateArchive } from '../../src/reports/archive.ts';
import { readReport, saveReport, type LocalReport } from '../../src/reports/store.ts';
import { caseV2Schema } from '../../src/dataset-loader/schema.ts';
import { metricCatalog } from '../../src/scoring/catalog.ts';
import { evaluateAll, prepareLocalEvaluation } from '../../src/scoring/evaluate.ts';
import { aggregate } from '../../src/scoring/aggregate.ts';
import { judgeConfig, judgeConnection, type Fetcher } from '../../src/scoring/judges/client.ts';
import { rubricsFor, type CompactPlan } from '../../src/scoring/judges/compact.ts';
import { createRegistry, EvaluatorRegistry } from '../../src/scoring/registry.ts';
import { compileEvaluatorPlan } from '../../src/scoring/evaluator-plan.ts';
import { judgeResponse } from '../support/judge-response.ts';
import { retryScoring, readScoringRevisionReport, listScoringRevisions, readScoringRevision, type ScoringRevision } from '../../src/execution/score-retry.ts';

const roots: string[] = [];
afterAll(() => { for (const root of roots) rmSync(root, { recursive: true, force: true }); });
const success = () => judgeResponse({ choices: [{ message: { content: JSON.stringify({ v: 1, results: [
    { metricId: 'completion-verification', counts: { numerator: 1, denominator: 1, unassessable: 0 }, failures: [] },
    { metricId: 'false-completion', counts: { numerator: 0, denominator: 1, unassessable: 0 }, failures: [] },
] }) }, finish_reason: 'stop' }] });
async function saved(options: { success?: boolean; unfinished?: boolean; partial?: boolean; planned?: boolean; repeated?: boolean; historicalRepeated?: boolean; closedCheck?: boolean; legacyCeiling?: boolean } = {}) {
    const repo = mkdtempSync(join(tmpdir(), 'flowmate-score-retry-')); roots.push(repo);
    mkdirSync(join(repo, 'agent-eval'));
    const judge = judgeConfig({ FLOWMATE_JUDGE_MODEL: 'llama-3.3-70b-versatile', FLOWMATE_JUDGE_API: 'openai-completions',
        FLOWMATE_JUDGE_BASE_URL: 'https://example.invalid/v1', FLOWMATE_JUDGE_API_KEY: 'retry-synthetic-key' }, repo)!;
    const plan: CompactPlan = { contract: 'flowmate-semantic-plan/v1', criteria: ['completion-verification', 'false-completion'].map(id => {
        const metric = metricCatalog.find(m => m.id === id)!;
        return { metricId: id, version: 1, unit: metric.unit, denominator: 1, required: true,
            rule: 'Verify the original saved answer against independent task facts.', evidence: ['answer', 'task-endpoint', 'gold-task'], trigger: 'completed-endpoint' };
    }) };
    const task = caseV2Schema.parse({ contract: 'flowmate-agent-case/v2', id: 'retry-sample', version: 1, name: 'Synthetic saved task',
        category: 'synthetic', tags: ['synthetic'], requires: ['agent'], input: { prompt: 'Return the saved original fact.', materials: [] },
        expected: { success: ['Return the original fact.'], failure: ['Invent a replacement fact.'], checks: [{ metric: 'task-result', required: true },
            ...(options.closedCheck ? [{ metric: 'closed', required: true }] : [])],
            metrics: metricCatalog.map(m => ({ metricId: m.id, version: m.version, unit: m.unit,
                ...(m.id === 'task-success' || plan.criteria.some(c => c.metricId === m.id) ? { denominator: 1 } : { notApplicable: 'Outside this synthetic task.' }) })), semantic: plan },
        review: { status: 'pending' } });
    const archive = createArchive(repo, { selection: 'case' }), ref = archiveReference(archive.file, 'executions', 'saved-execution');
    const execution = { identity: { executionId: 'saved-execution', trialId: 'saved-trial', caseId: task.id, caseVersion: 1 }, started: true,
        status: 'completed' as const, endpointReached: true, input: { prompt: task.input.prompt, materials: [] }, answer: 'Original fact. 金额😀',
        artifacts: [], observations: [], configuration: { model: 'original-agent' }, usage: { inputTokens: 11, outputTokens: 7 },
        startedAt: '2026-10-01T00:00:00Z', endedAt: '2026-10-01T00:00:01Z', evidence: {
            answer: { present: true, actual: 'Original fact. 金额😀', source: 'saved actual answer' },
            'task-endpoint': { present: true, actual: true, source: 'saved actual endpoint' },
            cleanup: { present: true, actual: { stopped: true, closed: true }, source: 'saved process exit and close receipt' },
        } };
    const scored = await evaluateAll({ task, result: execution, projected: execution.input, judge,
        fetcher: async () => options.success ? success() : options.partial ? judgeResponse({ choices: [{ message: { content: JSON.stringify({ v: 1,
            results: [{ metricId: 'completion-verification', counts: { numerator: 1, denominator: 1, unassessable: 0 }, failures: [] }] }) }, finish_reason: 'stop' }] })
            : new Response('Synthetic Judge unavailable', { status: 402 }) }, task.expected.checks);
    if (options.legacyCeiling) Reflect.deleteProperty(scored.judgeCalls[0]!.configuration, 'maxOutputTokens');
    const report: LocalReport = { contract: 'flowmate-agent-run/v2', executionId: 'saved-execution', runId: archive.id, executionKind: 'model',
        dataset: { id: 'synthetic-retry', version: 1, subject: 'agent' }, selection: 'case', environment: 'synthetic',
        startedAt: execution.startedAt, endedAt: options.unfinished ? null : execution.endedAt, repeat: 1,
        executionComplete: !options.unfinished, scoring: options.unfinished ? 'pending' : 'complete', manualReview: 'none', formalAcceptance: 'not-assessed',
        scoringConfiguration: { version: 1, scoringVersion: 2, judgeMode: 'required', judge: scored.judgeCalls[0]!.configuration,
            rubrics: rubricsFor([plan]) }, export: { backend: 'local', status: 'disabled' }, trials: [{
                caseId: task.id, caseVersion: 1, caseConditions: { task, scoring: { version: 1, required: [], judges: [] } },
                caseName: task.name, category: task.category, partition: 'smoke', repetition: 1, trialId: 'saved-trial',
                traceId: 'abcdef0123456789abcdef0123456789', execution, semanticPlan: plan, metricPlan: task.expected.metrics,
                evaluatorPlan: compileEvaluatorPlan(task, task.expected.checks),
                ...aggregate(scored.scores, execution), scores: options.unfinished ? [] : scored.scores,
                judgeCalls: options.unfinished ? [] : scored.judgeCalls, ...(options.unfinished ? { scoringState: 'pending' as const } : {}), feedback: 'none',
            }] };
    if (options.planned) {
        report.repeat = 2; report.executionComplete = false;
        report.trials.push({ ...structuredClone(report.trials[0]!), repetition: 2, trialId: 'never-started-trial',
            traceId: '1234567890abcdef1234567890abcdef', execution: null, scores: [], judgeCalls: [], status: 'NOT_RUN', reason: 'Planned', counts: {} });
    }
    if (options.repeated) {
        report.repeat = 2;
        const other = structuredClone(report.trials[0]!);
        other.repetition = 2; other.trialId = 'other-trial'; other.traceId = '1234567890abcdef1234567890abcdef';
        other.execution!.identity.trialId = other.trialId;
        const callId = randomUUID(); other.judgeCalls[0]!.callId = callId;
        if (options.historicalRepeated) delete other.judgeCalls[0]!.capacity;
        for (const score of other.scores) if (score.judge) score.judge.callId = callId;
        report.trials.push(other);
    }
    const { rubric: _, ...connection } = report.scoringConfiguration.judge!; report.scoringConfiguration.judge = connection;
    writeArchivePart(archiveReference(archive.file, 'snapshots', report.executionId), { dataset: report.dataset.id, cases: [task],
        judge: connection, scoring: { catalog: metricCatalog, evaluators: createRegistry().list().map(({ id, version, rubric }) => ({ id, version, rubric })) } });
    saveReport(ref, report);
    if (!options.unfinished) finishArchive(archive.file, 'complete');
    return { repo, archive, ref, report: readReport(ref), judge };
}

test('an explicit retry submits one whole saved semantic batch and leaves original Agent and scoring facts untouched', async () => {
    const fixture = await saved(), original = readArchive(fixture.archive.file);
    const originalReport = readReport(fixture.ref), updates: string[] = []; let requests = 0;
    const result = await retryScoring(fixture.repo, { runId: fixture.archive.id, operationId: 'repair-one', failedOnly: true }, {
        judgeConfig: fixture.judge, fetcher: async (_url, init) => {
            requests++;
            const data = JSON.parse(String(JSON.parse(String(init.body)).messages[1].content));
            expect(data.plan.criteria.map((c: { metricId: string }) => c.metricId)).toEqual(['completion-verification', 'false-completion']);
            expect(data.evidence.outcome.answer).toBe('Original fact. 金额😀');
            expect(updates).toEqual(['prepared', 'submitted']);
            return success();
        }, onProgress: event => { if (event.lifecycle) updates.push(event.lifecycle); },
    });
    expect(requests).toBe(1); expect(updates).toEqual(['prepared', 'submitted', 'ended']);
    expect(result).toMatchObject({ selectedTrials: 1, completedTrials: 1, blockedTrials: 0, judgeCalls: 1, status: 'complete' });
    const after = readArchive(fixture.archive.file);
    expect(after.executions).toEqual(original.executions); expect(after.snapshots).toEqual(original.snapshots);
    expect(after.caseSnapshots).toEqual(original.caseSnapshots); expect(after.scoring).toEqual(original.scoring);
    expect(readReport(fixture.ref)).toEqual(originalReport);
    const revised = readScoringRevisionReport(fixture.repo, fixture.archive.id, result.revisionId, fixture.report.executionId);
    expect(revised.statisticsPolicyVersion).toBe(2);
    expect(revised.trials[0]!.execution).toEqual(originalReport.trials[0]!.execution);
    const localFacts = (report: LocalReport) => report.trials[0]!.scores.filter(s => s.method === 'deterministic' && !['DR03', 'task-success'].includes(s.metricId));
    expect(localFacts(revised)).toEqual(localFacts(originalReport));
    expect(revised.trials[0]!.judgeCalls).toHaveLength(1);
    expect(revised.trials[0]!.judgeCalls[0]!.callId).not.toBe(originalReport.trials[0]!.judgeCalls[0]!.callId);
    expect(revised.trials[0]!.scores.find(s => s.metricId === 'completion-verification')!.status).toBe('PASS');
    expect(revised.trials[0]!.scores.find(s => s.metricId === 'false-completion')!.status).toBe('PASS');
    expect(JSON.stringify(result)).not.toContain('retry-synthetic-key');
    expect(JSON.stringify(result)).not.toContain('Original fact.');
});

test('a per-metric batch error retries all originally judged siblings, including a previously passing sibling', async () => {
    const fixture = await saved({ partial: true });
    expect(fixture.report.trials[0]!.scores.find(s => s.metricId === 'completion-verification')!.status).toBe('PASS');
    const result = await retryScoring(fixture.repo, { runId: fixture.archive.id, failedOnly: true }, { judgeConfig: fixture.judge,
        fetcher: async () => judgeResponse({ choices: [{ message: { content: JSON.stringify({ v: 1, results: [
            { metricId: 'completion-verification', counts: { numerator: 0, denominator: 1, unassessable: 0 }, failures: [{ opportunityIndex: 0, code: 1 }] },
            { metricId: 'false-completion', counts: { numerator: 0, denominator: 1, unassessable: 0 }, failures: [] },
        ] }) }, finish_reason: 'stop' }] }) });
    const revised = readScoringRevisionReport(fixture.repo, fixture.archive.id, result.revisionId, fixture.report.executionId);
    expect(revised.trials[0]!.scores.find(s => s.metricId === 'completion-verification')!.status).toBe('FAIL');
    expect(revised.trials[0]!.scores.find(s => s.metricId === 'false-completion')!.status).toBe('PASS');
    expect(readReport(fixture.ref).trials[0]!.scores.find(s => s.metricId === 'completion-verification')!.status).toBe('PASS');
});

test('planned unstarted Trials are excluded while the saved actual failed Judge is retried', async () => {
    const fixture = await saved({ planned: true }); let requests = 0;
    const result = await retryScoring(fixture.repo, { runId: fixture.archive.id, failedOnly: true }, { judgeConfig: fixture.judge,
        fetcher: async () => { requests++; return success(); } });
    expect(requests).toBe(1); expect(result.selectedTrials).toBe(1);
    const revised = readScoringRevisionReport(fixture.repo, fixture.archive.id, result.revisionId, fixture.report.executionId);
    expect(revised.trials[1]).toEqual(fixture.report.trials[1]);
});

test('a different saved Judge configuration blocks the explicit operation before a request', async () => {
    const fixture = await saved(); let requests = 0;
    await expect(retryScoring(fixture.repo, { runId: fixture.archive.id, failedOnly: true }, {
        judgeConfig: { ...fixture.judge, timeoutMs: fixture.judge.timeoutMs + 1 }, fetcher: async () => { requests++; return success(); },
    })).rejects.toThrow('configuration differs');
    expect(requests).toBe(0);
});

test('new operations append independent revisions and explicit listing never changes an earlier revision', async () => {
    const fixture = await saved(), deps = { judgeConfig: fixture.judge, fetcher: (async () => success()) satisfies Fetcher };
    const first = await retryScoring(fixture.repo, { runId: fixture.archive.id, operationId: 'first', failedOnly: true }, deps);
    const savedFirst = readScoringRevision(fixture.repo, fixture.archive.id, first.revisionId);
    const second = await retryScoring(fixture.repo, { runId: fixture.archive.id, operationId: 'second', failedOnly: true }, deps);
    expect(listScoringRevisions(fixture.repo, fixture.archive.id).map(revision => revision.revisionId)).toEqual([first.revisionId, second.revisionId]);
    expect(readScoringRevision(fixture.repo, fixture.archive.id, first.revisionId)).toEqual(savedFirst);
});

test('the same operation returns its saved revision without another request and rejects a conflicting target', async () => {
    const fixture = await saved(); let requests = 0;
    const deps = { judgeConfig: fixture.judge, fetcher: (async () => { requests++; return success(); }) satisfies Fetcher };
    const input = { runId: fixture.archive.id, operationId: 'same-operation', failedOnly: true as const };
    const first = await retryScoring(fixture.repo, input, deps), second = await retryScoring(fixture.repo, input, deps);
    expect(second).toEqual(first); expect(requests).toBe(1);
    await expect(retryScoring(fixture.repo, { ...input, trialId: 'saved-trial' }, deps)).rejects.toThrow('target');
    expect(requests).toBe(1);
});

test('a complete original Judge has no failed-only target and requires no configured Judge', async () => {
    const fixture = await saved({ success: true }); let requests = 0;
    const result = await retryScoring(fixture.repo, { runId: fixture.archive.id, failedOnly: true }, { env: {},
        fetcher: async () => { requests++; return success(); } });
    expect(result.selectedTrials).toBe(0); expect(result.judgeCalls).toBe(0); expect(requests).toBe(0);
});

test('an original persisted stopped execution whose scoring never started can finish scoring without running an Agent', async () => {
    const fixture = await saved({ unfinished: true }); let requests = 0;
    const result = await retryScoring(fixture.repo, { runId: fixture.archive.id, failedOnly: true }, { judgeConfig: fixture.judge,
        fetcher: async () => { requests++; return success(); } });
    expect(requests).toBe(1); expect(result.completedTrials).toBe(1);
    expect(readReport(fixture.ref).trials[0]!.scores).toEqual([]);
    const revised = readScoringRevisionReport(fixture.repo, fixture.archive.id, result.revisionId, fixture.report.executionId);
    expect(revised.trials[0]!.scores.some(s => s.metricId === 'task-result' && s.status === 'PASS')).toBe(true);
});

test.each(['unconfirmed-stop', 'historical'] as const)('%s evidence cannot be rescored', async kind => {
    const fixture = await saved();
    updateArchive(fixture.archive.file, archive => {
        if (kind === 'historical') delete (archive.executions['saved-execution'] as any).trials[0].caseConditionsRef;
        else (archive.executions['saved-execution'] as any).trials[0].execution.evidence.cleanup.actual.stopped = false;
    });
    let requests = 0;
    await expect(retryScoring(fixture.repo, { runId: fixture.archive.id, failedOnly: true }, { judgeConfig: fixture.judge,
        fetcher: async () => { requests++; return success(); } })).rejects.toThrow(kind === 'historical' ? 'original' : 'stop');
    expect(requests).toBe(0);
});

test('an interruption after a saved submitted checkpoint remains submission-unknown and the same operation never retries', async () => {
    const fixture = await saved(); let requests = 0;
    const input = { runId: fixture.archive.id, operationId: 'interrupted', failedOnly: true as const };
    await expect(retryScoring(fixture.repo, input, { judgeConfig: fixture.judge,
        fetcher: async () => { requests++; return success(); }, onProgress: event => {
            if (event.lifecycle === 'submitted') throw Error('Synthetic interruption after checkpoint');
        } })).rejects.toThrow('Synthetic interruption');
    const result = await retryScoring(fixture.repo, input, { judgeConfig: fixture.judge, fetcher: async () => { requests++; return success(); } });
    expect(requests).toBe(0); expect(result).toMatchObject({ status: 'blocked', blockedTrials: 1 });
    expect(result.states).toEqual({ 'submission-unknown': 1 });
    const revision = readArchive(fixture.archive.file).scoringRevisions[result.revisionId] as any;
    expect(revision.executions['saved-execution'].trials['saved-trial'].judgeCalls[0]).toMatchObject({ lifecycle: 'submitted', attempts: 1, endedAt: '' });
});

test.each(['raw', 'counts', 'configuration', 'evaluator', 'local-fact', 'grade', 'grade-counts', 'unfinished-call', 'request-evidence'] as const)(
    'a forged revision %s cannot become a final scoring view', async forgery => {
        const fixture = await saved();
        const result = await retryScoring(fixture.repo, { runId: fixture.archive.id, failedOnly: true }, { judgeConfig: fixture.judge, fetcher: async () => success() });
        updateArchive(fixture.archive.file, archive => {
            const trial = (archive.scoringRevisions[result.revisionId] as ScoringRevision).executions['saved-execution']!.trials['saved-trial']!;
            const call = trial.judgeCalls[0]!;
            if (forgery === 'raw') call.raw = '{"v":1,"results":[]}';
            if (forgery === 'counts') {
                const score = trial.scores.find(score => score.metricId === 'completion-verification')!;
                score.value = 0; score.status = 'FAIL'; score.statistics!.numerator = 0;
                (score.actual as { row: number[]; failures: number[][] }).row = [0, 1, 0];
                (score.actual as { failures: number[][] }).failures = [[0, 0, 1]];
                call.compact!.judgment!.r[0] = [0, 1, 0]; call.compact!.judgment!.f = [[0, 0, 1]];
            }
            if (forgery === 'configuration') call.configuration.model = 'different-judge';
            if (forgery === 'evaluator') trial.scores.find(score => score.metricId === 'completion-verification')!.evaluatorVersion = 2;
            if (forgery === 'local-fact') trial.scores.find(score => score.metricId === 'task-result')!.actual = 'Replaced original deterministic fact';
            if (forgery === 'grade') { trial.status = 'FAIL'; trial.reason = 'Forged final outcome'; }
            if (forgery === 'grade-counts') trial.counts = { PASS: 999 };
            if (forgery === 'unfinished-call') { call.endedAt = ''; call.lifecycle = 'submitted'; }
            if (forgery === 'request-evidence') {
                const data = JSON.parse(call.request!.data); data.evidence.outcome.answer = 'Changed original evidence'; call.request!.data = JSON.stringify(data);
            }
        });
        expect(() => { readScoringRevisionReport(fixture.repo, fixture.archive.id, result.revisionId, fixture.report.executionId); }).toThrow();
    });

test('a still-running revision cannot expose a complete final scoring report', async () => {
    const fixture = await saved();
    const result = await retryScoring(fixture.repo, { runId: fixture.archive.id, failedOnly: true }, { judgeConfig: fixture.judge, fetcher: async () => success() });
    updateArchive(fixture.archive.file, archive => {
        const revision = archive.scoringRevisions[result.revisionId] as ScoringRevision; revision.status = 'running'; revision.endedAt = null;
    });
    expect(readScoringRevisionReport(fixture.repo, fixture.archive.id, result.revisionId, fixture.report.executionId).scoring).toBe('pending');
});

test.each(['original-fact', 'gold-task', 'local-fact', 'unplanned-local'] as const)('unscored recovery validates the saved %s against original evidence and checks', async forgery => {
    const fixture = await saved({ unfinished: true });
    const result = await retryScoring(fixture.repo, { runId: fixture.archive.id, failedOnly: true }, { judgeConfig: fixture.judge, fetcher: async () => success() });
    updateArchive(fixture.archive.file, archive => {
        const trial = (archive.scoringRevisions[result.revisionId] as ScoringRevision).executions['saved-execution']!.trials['saved-trial']!;
        const call = trial.judgeCalls[0]!, data = JSON.parse(call.request!.data);
        if (forgery === 'original-fact') data.evidence.facts.answer.actual = 'Coherently replaced original fact';
        if (forgery === 'gold-task') data.evidence.facts['gold-task'].actual.success = ['Replaced independent task Gold'];
        if (forgery === 'local-fact') trial.scores.find(score => score.metricId === 'task-result')!.actual = 'Replaced original local endpoint fact';
        if (forgery === 'unplanned-local') {
            trial.scores.push({ ...structuredClone(trial.scores.find(score => score.metricId === 'task-result')!), metricId: 'unplanned-local' });
            trial.counts.PASS = (trial.counts.PASS ?? 0) + 1;
        }
        call.request!.data = JSON.stringify(data);
    });
    expect(() => { readScoringRevisionReport(fixture.repo, fixture.archive.id, result.revisionId, fixture.report.executionId); }).toThrow();
});

test('unscored recovery rejects changed original local Evaluator versions before invoking the Judge', async () => {
    const fixture = await saved({ unfinished: true }); let requests = 0;
    updateArchive(fixture.archive.file, archive => {
        const snapshot = archive.scoring[fixture.report.dataset.id] as { evaluators: Array<{ id: string; version: number }> };
        snapshot.evaluators.find(definition => definition.id === 'task-result')!.version = 2;
    });
    await expect(retryScoring(fixture.repo, { runId: fixture.archive.id, failedOnly: true }, { judgeConfig: fixture.judge,
        fetcher: async () => { requests++; return success(); } })).rejects.toThrow(/Evaluator|version/);
    expect(requests).toBe(0);
});

test('unsupported v1 semantic retry is rejected before model preparation or submission', async () => {
    const fixture = await saved({ unfinished: true }); let requests = 0;
    updateArchive(fixture.archive.file, archive => {
        const report = archive.executions['saved-execution'] as any;
        report.contract = 'flowmate-agent-run/v1'; delete report.aggregation; delete report.trials[0].semanticPlan;
    });
    await expect(retryScoring(fixture.repo, { runId: fixture.archive.id, failedOnly: true }, { judgeConfig: fixture.judge,
        fetcher: async () => { requests++; return success(); } })).rejects.toThrow(/v2|unsupported/);
    expect(requests).toBe(0);
});

test('the revision view records its actual new Judge ceiling without inventing an original missing ceiling', async () => {
    const fixture = await saved({ legacyCeiling: true });
    const result = await retryScoring(fixture.repo, { runId: fixture.archive.id, failedOnly: true }, {
        judgeConfig: judgeConnection({ ...fixture.judge, maxOutputTokens: 32768 }), fetcher: async () => success(),
    });
    const revised = readScoringRevisionReport(fixture.repo, fixture.archive.id, result.revisionId, fixture.report.executionId);
    expect(revised.scoringConfiguration.judge).toHaveProperty('maxOutputTokens', 32768);
    expect(revised.scoringRevision).toEqual({ id: result.revisionId, conditionsComplete: true });
    expect(readReport(fixture.ref).scoringConfiguration.judge).not.toHaveProperty('maxOutputTokens');
});

test('an untouched original semantic call with unknown output ceiling keeps revision comparison conditions incomplete', async () => {
    const fixture = await saved({ repeated: true, historicalRepeated: true, legacyCeiling: true });
    const result = await retryScoring(fixture.repo, { runId: fixture.archive.id, trialId: 'saved-trial', failedOnly: true }, {
        judgeConfig: judgeConnection({ ...fixture.judge, maxOutputTokens: 32768 }), fetcher: async () => success(),
    });
    const revised = readScoringRevisionReport(fixture.repo, fixture.archive.id, result.revisionId, fixture.report.executionId);
    expect(revised.scoringConfiguration.judge).toHaveProperty('maxOutputTokens', 32768);
    expect(revised.scoringRevision).toEqual({ id: result.revisionId, conditionsComplete: false });
    expect(revised.trials[1]).toEqual(fixture.report.trials[1]);
});

test('fresh partial retry can prove the actual output ceiling from saved wire metadata when the optional config ceiling was omitted', async () => {
    const fixture = await saved({ repeated: true, legacyCeiling: true });
    const result = await retryScoring(fixture.repo, { runId: fixture.archive.id, trialId: 'saved-trial', failedOnly: true }, {
        judgeConfig: fixture.judge, fetcher: async () => success(),
    });
    const revised = readScoringRevisionReport(fixture.repo, fixture.archive.id, result.revisionId, fixture.report.executionId);
    expect(revised.scoringConfiguration.judge).toHaveProperty('maxOutputTokens', 32768);
    expect(revised.scoringRevision).toEqual({ id: result.revisionId, conditionsComplete: true });
    expect(readReport(fixture.ref).scoringConfiguration.judge).not.toHaveProperty('maxOutputTokens');
    expect(revised.trials[1]).toEqual(fixture.report.trials[1]);
});

test('local replay preserves a saved closed check whose optional actual and expected fields were omitted by JSON storage', async () => {
    const fixture = await saved({ unfinished: true, closedCheck: true });
    const result = await retryScoring(fixture.repo, { runId: fixture.archive.id, failedOnly: true }, { judgeConfig: fixture.judge, fetcher: async () => success() });
    const revised = readScoringRevisionReport(fixture.repo, fixture.archive.id, result.revisionId, fixture.report.executionId);
    expect(revised.trials[0]!.scores.find(score => score.metricId === 'closed')!.status).toBe('PASS');
    expect(readReport(fixture.ref).trials[0]!.scores).toEqual([]);
});

test('synchronous local verification rejects an asynchronous Evaluator while ordinary evaluation still awaits it', async () => {
    const fixture = await saved({ unfinished: true }), trial = fixture.report.trials[0]!;
    const task = caseV2Schema.parse(trial.caseConditions!.task), registry = new EvaluatorRegistry();
    for (const definition of createRegistry().list()) registry.register(definition.id === 'task-result' ? { ...definition,
        evaluate: async (context, check) => definition.evaluate(context, check) } : definition);
    const context = { task, result: trial.execution!, projected: trial.execution!.input, judge: null, semanticPlan: trial.semanticPlan };
    expect(() => { prepareLocalEvaluation(context, task.expected.checks, registry); }).toThrow('Asynchronous local scoring');
    const evaluated = await evaluateAll(context, task.expected.checks, registry);
    expect(evaluated.scores.find(score => score.metricId === 'task-result')!.status).toBe('PASS');
    expect(evaluated.judgeCalls).toEqual([]);
});

test.each([
    ['task-result', 'evaluator-id'], ['task-result', 'evaluator-version'], ['task-result', 'category'], ['task-result', 'applicability'],
    ['closed', 'evaluator-id'], ['closed', 'evaluator-version'], ['closed', 'category'], ['closed', 'applicability'],
] as const)('unscored recovery rejects forged %s %s metadata', async (metricId, field) => {
    const fixture = await saved({ unfinished: true, closedCheck: true });
    const result = await retryScoring(fixture.repo, { runId: fixture.archive.id, failedOnly: true }, { judgeConfig: fixture.judge, fetcher: async () => success() });
    updateArchive(fixture.archive.file, archive => {
        const trial = (archive.scoringRevisions[result.revisionId] as ScoringRevision).executions['saved-execution']!.trials['saved-trial']!;
        const score = trial.scores.find(score => score.metricId === metricId)!;
        if (field === 'evaluator-id') score.evaluatorId = 'foreign-evaluator';
        if (field === 'evaluator-version') score.evaluatorVersion = 999;
        if (field === 'category') score.category = 'diagnostic';
        if (field === 'applicability') score.applicabilityReason = 'Foreign applicability declaration';
    });
    expect(() => { readScoringRevisionReport(fixture.repo, fixture.archive.id, result.revisionId, fixture.report.executionId); }).toThrow();
});
