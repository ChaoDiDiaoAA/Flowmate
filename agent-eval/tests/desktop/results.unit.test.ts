import { expect, test } from 'bun:test';
import { existsSync, mkdirSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { mkdtempSync } from '../../../tests/support/resources.ts';
import { createEvaluationService } from '../../src/desktop/service.ts';
import { saveReport } from '../../src/reports/store.ts';
import { reportFixture, comparisonFacts } from '../support/fixtures.ts';
import { registerSecrets } from '../../src/execution/evidence-safety.ts';
import { createArchive, archiveReference, snapshotReference, writeArchivePart } from '../../src/reports/archive.ts';

function service(root: string) {
    return createEvaluationService(root, { sessionId: 'synthetic-results-session', prepareAgent: async () => { throw Error('Unexpected model preparation'); } });
}
function saved(root: string, executionId: string) {
    const directory = join(root, 'agent-eval/runs/business', executionId); mkdirSync(directory, { recursive: true });
    const report = reportFixture(); report.executionId = executionId; report.trials[0]!.execution!.identity.executionId = executionId;
    const file = join(directory, 'report.json'); saveReport(file, report); return { report, file, directory };
}
const call = (s: ReturnType<typeof service>, method: string, input: unknown) => Reflect.get(s, method)?.(input);

test('inline native Judge conditions remain readable without an HTTP API or Base URL', () => {
    const root = mkdtempSync(join(tmpdir(), 'eval-native-conditions-')), archive = createArchive(root, { selection: 'full' });
    const report = reportFixture(); report.scoringConfiguration.judge = { provider: 'codex-cli', transport: 'codex-cli', model: 'gpt-6.1-terra',
        reasoningEffort: 'medium', timeoutMs: 180000, protocolVersion: 'flowmate-judge/v2' };
    const ref = archiveReference(archive.file, 'executions', report.executionId), facts = comparisonFacts();
    writeArchivePart(snapshotReference(ref), { ...facts, dataset: report.dataset.id, repeat: 1, cases: [{ id: 'sample', version: 1 }],
        scoring: {}, judge: report.scoringConfiguration.judge });
    saveReport(ref, report);
    expect(call(service(root), 'result', { executionId: report.executionId, view: 'summary' })).toMatchObject({ ok: true,
        data: { summary: { conditionsIssue: null, conditions: { judge: { api: null, baseUrl: null, model: 'gpt-6.1-terra',
            transport: 'codex-cli', reasoningEffort: 'medium' } } } } });
});

test('a read-only execution list needs neither Dataset nor model configuration and creates no result directory', () => {
    const root = mkdtempSync(join(tmpdir(), 'eval-result-empty-')), s = service(root);
    expect(call(s, 'listExecutions', {})).toMatchObject({ ok: true, data: { version: 1, sessionId: 'synthetic-results-session',
        items: [], page: { total: 0, offset: 0, nextOffset: null, complete: true } } });
    expect(existsSync(join(root, 'agent-eval'))).toBe(false);
});

test('corrupt and duplicate report entries remain visible and list pages bind the same discovery facts', () => {
    const root = mkdtempSync(join(tmpdir(), 'eval-result-list-')), a = saved(root, 'a-run'), b = saved(root, 'b-run'), s = service(root);
    const originalB = readFileSync(b.file, 'utf8'); writeFileSync(b.file, '{');
    const first = call(s, 'listExecutions', { limit: 1 });
    expect(first).toMatchObject({ ok: true, data: { items: [{ executionId: 'a-run', error: null }], page: { nextOffset: 1, complete: false } } });
    const second = call(s, 'listExecutions', { viewId: first.data.viewId, offset: 1, limit: 1 });
    expect(second).toMatchObject({ ok: true, data: { items: [{ executionId: 'b-run', summary: null }], page: { complete: true } } });
    expect(second.data.items[0].error).toContain('report');
    writeFileSync(b.file, originalB);
    expect(call(s, 'listExecutions', { viewId: first.data.viewId, offset: 1, limit: 1 })).toMatchObject({ ok: false, error: { code: 'evaluation_view_changed' } });
    saved(root, 'c-run');
    expect(call(s, 'listExecutions', { viewId: first.data.viewId, offset: 1, limit: 1 })).toMatchObject({ ok: false, error: { code: 'evaluation_view_changed' } });
    expect(readFileSync(a.file, 'utf8')).not.toBe('');
});

test('partial evidence preserves original scores and known usage while unknown Judge generations stay unknown', () => {
    const root = mkdtempSync(join(tmpdir(), 'eval-result-gap-')), p = saved(root, 'partial-run'), s = service(root);
    unlinkSync(join(p.directory, 'evidence/trial-1/observation.json'));
    const result = call(s, 'result', { executionId: 'partial-run', view: 'summary' });
    expect(result).toMatchObject({ ok: true, data: { summary: { evidenceComplete: false, scoring: 'complete' },
        trials: [{ trialId: 'trial-1', executionStatus: 'completed', judgeGenerations: null, usage: { inputTokens: 10, outputTokens: 5 } }],
        gaps: [{ kind: 'observation', reason: 'missing' }] } });
    const scores = call(s, 'result', { executionId: 'partial-run', trialId: 'trial-1', view: 'scores' });
    expect(scores).toMatchObject({ ok: true, data: { scores: [{ trialId: 'trial-1', metricId: 'task-result', value: 1, method: 'deterministic' }] } });
    expect(result.data.trials[0].usage).not.toHaveProperty('cost');
});

test('known zero Judge calls differ from unavailable observations and do not create generation evidence', () => {
    const root = mkdtempSync(join(tmpdir(), 'eval-result-zero-')), p = saved(root, 'zero-run'), s = service(root), before = readFileSync(p.file, 'utf8');
    expect(call(s, 'result', { executionId: 'zero-run', view: 'summary' })).toMatchObject({ ok: true, data: {
        summary: { evidenceComplete: true }, trials: [{ judgeGenerations: 0 }], gaps: [] } });
    expect(readFileSync(p.file, 'utf8')).toBe(before);
});

test('formal aggregates preserve original opportunity counts and exclude internal source arrays from the public DTO', () => {
    const root = mkdtempSync(join(tmpdir(), 'eval-result-formal-')), directory = join(root, 'agent-eval/runs/business/formal-run'); mkdirSync(directory, { recursive: true });
    const report = reportFixture(); report.executionId = 'formal-run'; report.trials[0]!.execution!.identity.executionId = 'formal-run';
    report.contract = 'flowmate-agent-run/v2'; report.trials[0]!.metricPlan = [{ metricId: 'task-success', version: 1, unit: 'Trial', denominator: 1 }];
    saveReport(join(directory, 'report.json'), report);
    const result = call(service(root), 'result', { executionId: 'formal-run', view: 'summary' });
    expect(result).toMatchObject({ ok: true });
    expect(result.data.metrics).toHaveLength(39);
    expect(result.data.metrics.find((metric: { metricId: string }) => metric.metricId === 'task-success'))
        .toMatchObject({ numerator: 1, denominator: 1, missing: 0, value: 1, unit: 'Trial' });
    expect(result.data.metrics[0]).not.toHaveProperty('sources');
});

test('text pages preserve one view and refuse changed sources, foreign Trials or arbitrary paths', () => {
    const root = mkdtempSync(join(tmpdir(), 'eval-result-page-')), p = saved(root, 'paged-run'), s = service(root);
    const first = call(s, 'result', { executionId: 'paged-run', trialId: 'trial-1', view: 'observations', limit: 30 });
    expect(first).toMatchObject({ ok: true, data: { page: { unit: 'characters', nextOffset: 30, complete: false } } });
    const second = call(s, 'result', { executionId: 'paged-run', trialId: 'trial-1', view: 'observations', viewId: first.data.viewId, offset: 30, limit: 30 });
    expect(second).toMatchObject({ ok: true, data: { viewId: first.data.viewId, page: { offset: 30 } } });
    expect(call(s, 'result', { executionId: 'paged-run', trialId: 'foreign-trial', view: 'scores' })).toMatchObject({ ok: false });
    expect(call(s, 'result', { executionId: 'paged-run', view: 'events', path: '../outside' })).toMatchObject({ ok: false, error: { code: 'input_invalid' } });
    const events = call(s, 'result', { executionId: 'paged-run', trialId: 'trial-1', view: 'events', limit: 1 });
    writeFileSync(join(p.directory, 'evidence/trial-1/events.jsonl'), '\n');
    expect(call(s, 'result', { executionId: 'paged-run', trialId: 'trial-1', view: 'events', viewId: events.data.viewId, offset: 1, limit: 1 }))
        .toMatchObject({ ok: false, error: { code: 'evaluation_view_changed' } });
});

test('configured secrets are redacted in public text without rewriting the original evidence', () => {
    const root = mkdtempSync(join(tmpdir(), 'eval-result-safe-')), p = saved(root, 'safe-run'), s = service(root);
    const file = join(p.directory, 'evidence/trial-1/artifacts/artifact-1.json'), original = readFileSync(file, 'utf8');
    const artifact = JSON.parse(original); artifact.content = 'synthetic-private-result-secret'; writeFileSync(file, JSON.stringify(artifact));
    registerSecrets(['synthetic-private-result-secret']);
    const result = call(s, 'result', { executionId: 'safe-run', trialId: 'trial-1', view: 'artifacts' });
    expect(result).toMatchObject({ ok: true }); expect(result.data.text).toContain('[REDACTED]');
    expect(JSON.stringify(result)).not.toContain('synthetic-private-result-secret');
    expect(readFileSync(file, 'utf8')).toContain('synthetic-private-result-secret');
});

test('comparison uses original saved conditions and refuses changed scoring instead of inventing a quality delta', () => {
    const root = mkdtempSync(join(tmpdir(), 'eval-result-compare-')), a = saved(root, 'left-run'), b = saved(root, 'right-run'), s = service(root);
    const facts = JSON.stringify(comparisonFacts()); writeFileSync(join(a.directory, 'snapshot.json'), facts); writeFileSync(join(b.directory, 'snapshot.json'), facts);
    expect(call(s, 'compare', { left: 'left-run', right: 'right-run' })).toMatchObject({ ok: true, data: {
        left: 'left-run', right: 'right-run', rows: [{ caseId: 'sample', repetition: 1, before: 'PASS', after: 'PASS' }] } });
    const raw = JSON.parse(readFileSync(b.file, 'utf8')); raw.scoringConfiguration.judgeMode = 'required'; writeFileSync(b.file, JSON.stringify(raw));
    expect(call(s, 'compare', { left: 'left-run', right: 'right-run' })).toMatchObject({ ok: false, error: { code: 'evaluation_not_comparable' } });
});

test('historical conditions expose only original declared fields and invalidate pages when their snapshot changes', () => {
    const root = mkdtempSync(join(tmpdir(), 'eval-result-conditions-')), p = saved(root, 'conditions-run'), s = service(root);
    const snapshot = join(p.directory, 'snapshot.json'), facts = comparisonFacts();
    writeFileSync(snapshot, JSON.stringify({ ...facts, version: 'v1', dataset: 'test', repeat: 1,
        configuration: { ...facts.configuration, timeoutMs: 120000, stopGraceMs: 5000, budget: { maxToolCalls: 8 },
            credentialRef: 'private-reference', apiKey: 'synthetic-unused-secret' }, judge: null, gold: { private: 'hidden-gold' } }));
    const result = call(s, 'result', { executionId: 'conditions-run', view: 'summary', limit: 1 });
    expect(result).toMatchObject({ ok: true, data: { summary: { conditions: { agent: { model: 'test', api: 'openai-completions',
        baseUrl: 'https://example.invalid' }, run: { timeoutMs: 120000, stopGraceMs: 5000, budget: { maxToolCalls: 8 } }, judge: null,
        scoring: { judgeMode: 'off' } }, conditionsIssue: null } } });
    expect(result.data.summary.conditions.source.fileCount).toBeGreaterThan(0);
    for (const hidden of ['synthetic-unused-secret', 'private-reference', 'hidden-gold', 'contentBase64', '"runtimeSource"'])
        expect(JSON.stringify(result)).not.toContain(hidden);
    expect(result.data.summary.conditions.source).not.toHaveProperty('files');
    writeFileSync(snapshot, readFileSync(snapshot, 'utf8').replace('"model":"test"', '"model":"next"'));
    expect(call(s, 'result', { executionId: 'conditions-run', view: 'summary', viewId: result.data.viewId, offset: 1, limit: 1 }))
        .toMatchObject({ ok: false, error: { code: 'evaluation_view_changed' } });
    expect(call(s, 'result', { executionId: 'conditions-run', view: 'summary' }).data.summary.conditions.agent.model).toBe('next');
});

test('missing or invalid original conditions preserve saved results and never require current model settings', () => {
    const root = mkdtempSync(join(tmpdir(), 'eval-result-condition-gap-')), p = saved(root, 'old-run'), s = service(root), original = readFileSync(p.file, 'utf8');
    expect(call(s, 'result', { executionId: 'old-run', view: 'summary' })).toMatchObject({ ok: true,
        data: { summary: { conditions: null, conditionsIssue: 'missing', evidenceComplete: true }, trials: [{ judgeGenerations: 0 }] } });
    const snapshot = join(p.directory, 'snapshot.json'); writeFileSync(snapshot, '{');
    expect(call(s, 'result', { executionId: 'old-run', view: 'summary' })).toMatchObject({ ok: true,
        data: { summary: { conditions: null, conditionsIssue: 'invalid', evidenceComplete: true } } });
    writeFileSync(snapshot, JSON.stringify({ ...comparisonFacts(), dataset: 'foreign-dataset' }));
    expect(call(s, 'result', { executionId: 'old-run', view: 'summary' })).toMatchObject({ ok: true,
        data: { summary: { conditions: null, conditionsIssue: 'invalid' } } });
    expect(readFileSync(p.file, 'utf8')).toBe(original);
});
