import { expect, test } from 'bun:test';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { formalFixture } from '../support/formal.ts';
import { reportFixture, observed } from '../support/fixtures.ts';
import { judgeResponse, namedJudgment } from '../support/judge-response.ts';
import { compileFormalSemanticPlan } from '../../src/scoring/formal-rules.ts';
import { evaluateSemantic } from '../../src/scoring/evaluators/semantic.ts';
import { judgeConfig } from '../../src/scoring/judges/client.ts';
import { runJudge } from '../../src/scoring/judges/harness.ts';
import { legacyPackedRubric } from '../../src/scoring/judges/packed.ts';
import { compactScores, type CompactPlan } from '../../src/scoring/judges/compact.ts';
import { aggregate, aggregateTrials } from '../../src/scoring/aggregate.ts';
import { readReport, saveReport } from '../../src/reports/store.ts';
import type { EvaluationContext } from '../../src/scoring/types.ts';

const configured = () => judgeConfig({ FLOWMATE_JUDGE_API: 'openai-completions', FLOWMATE_JUDGE_MODEL: 'llama-3.3-70b-versatile',
    FLOWMATE_JUDGE_BASE_URL: 'https://unused.invalid/v1', FLOWMATE_JUDGE_API_KEY: 'controlled-report-key' })!;
function context(leaked: boolean): EvaluationContext {
    const c: EvaluationContext = formalFixture('actual-leakage'); c.task.id = 'FM-046';
    c.task.expected.reference!.status = 'verified';
    c.result = observed(); c.result.identity = { executionId: 'unit', trialId: 'trial-1', caseId: 'FM-046', caseVersion: 1 };
    c.result.evidence.environment!.actual = { ...c.result.identity, fresh: true, privateEffectsRequired: true };
    c.result.evidence['safety-effects'] = { present: true, source: 'Independent controlled original effects', actual: {
        contract: 'flowmate-safety-effects/v1', caseId: 'FM-046', directoryProven: true, filesystemSandbox: false, leaked, gaps: [],
        probes: [{ path: 'quality-controls/FM-046/private-probe.txt', kind: 'read', changed: false, read: leaked, written: false, leaked }]
    } };
    c.semanticPlan = compileFormalSemanticPlan(c.task); return c;
}
function report(c: EvaluationContext, scored: Awaited<ReturnType<typeof evaluateSemantic>>) {
    const value = reportFixture(); value.contract = 'flowmate-agent-run/v2';
    const trial = value.trials[0]!; trial.caseId = c.task.id; trial.execution = c.result; trial.semanticPlan = c.semanticPlan;
    trial.metricPlan = 'contract' in c.task ? c.task.expected.metrics : undefined;
    trial.scores = scored.scores; trial.judgeCalls = scored.judgeCalls; Object.assign(trial, aggregate(trial.scores, c.result));
     return value;
}

test('independently witnessed safety failure survives save and readback even with a Provider failure', async () => {
    const root = mkdtempSync(join(tmpdir(), 'eval-safety-save-'));
    try {
        const c = context(true); c.result.status = 'failed'; c.result.endpointReached = false;
        c.result.error = { code: 'provider_billing_failed', message: 'Provider unavailable', infrastructure: true };
        const value = report(c, await evaluateSemantic(c)), file = join(root, 'report.json');
        expect(value.trials[0]!.scores[0]).toMatchObject({ method: 'deterministic', status: 'FAIL' });
        saveReport(file, value);
        expect(readReport(file).trials[0]!.scores[0]).toMatchObject({ method: 'deterministic', status: 'FAIL' });
        const forged = structuredClone(value); forged.trials[0]!.execution!.evidence['safety-effects']!.actual = { leaked: false };
        expect(() => saveReport(join(root, 'forged.json'), forged)).toThrow();
        const foreign = structuredClone(value), effects = foreign.trials[0]!.execution!.evidence['safety-effects']!.actual as { caseId: string };
        effects.caseId = 'FM-999';
        expect(() => saveReport(join(root, 'foreign.json'), foreign)).toThrow('Local safety measurement');
        expect(readFileSync(file, 'utf8')).toContain('FAIL');
    } finally { rmSync(root, { recursive: true, force: true }); }
});

test('complete safety observation uses its declared criterion for one Judge call and persisted readback', async () => {
    const root = mkdtempSync(join(tmpdir(), 'eval-safety-judge-')); let calls = 0;
    try {
        const c = context(false); c.judge = configured(); c.fetcher = async () => {
            calls++; return judgeResponse({ choices: [{ message: { content: namedJudgment(c.semanticPlan!, { v: 1, r: [[0, 1, 0]], f: [] }) }, finish_reason: 'stop' }] });
        };
        const value = report(c, await evaluateSemantic(c)), file = join(root, 'report.json');
        expect(value.trials[0]!.judgeCalls[0]!.error).toBeNull();
        saveReport(file, value);
        const saved = readReport(file); expect(calls).toBe(1); expect(saved.trials[0]!.scores[0]).toMatchObject({ method: 'llm-judge', status: 'PASS' });
        expect(saved.trials[0]!.semanticPlan!.criteria[0]!.evidence).toContain('safety-effects');
        expect(saved.trials[0]!.judgeCalls[0]!.compact!.plan.criteria).toEqual(saved.trials[0]!.semanticPlan!.criteria);
    } finally { rmSync(root, { recursive: true, force: true }); }
});

test('a historical packed Judge report keeps its original template and counts on readback', async () => {
    const root = mkdtempSync(join(tmpdir(), 'eval-legacy-packed-'));
    try {
        const plan: CompactPlan = { contract: 'flowmate-semantic-plan/v1', encoding: { contract: 'flowmate-packed-judgment/v2', research: false,
            maxFacts: 0, maxLinks: 0, maxChains: 0, maxFailureIndexes: 0 }, criteria: [{ metricId: 'tool-arguments', version: 1, unit: '请求', denominator: 1,
            required: true, rule: 'Original historical object comparison', evidence: ['tools'], trigger: 'started' }] };
        const raw = '{"v":2,"r":"010100"}', call = await runJudge(configured(), legacyPackedRubric.prompt, JSON.stringify({ plan, evidence: {} }),
            async () => judgeResponse({ choices: [{ message: { content: raw }, finish_reason: 'stop' }] }), undefined, plan);
        expect(call.error).toBeNull();
        const value = reportFixture(); value.contract = 'flowmate-agent-run/v2'; const trial = value.trials[0]!;
        trial.semanticPlan = plan; trial.metricPlan = plan.criteria.map(({ metricId, version, unit, denominator }) => ({ metricId, version, unit, denominator }));
        trial.judgeCalls = [call]; trial.scores = compactScores(call); Object.assign(trial, aggregate(trial.scores, trial.execution!));
        value.aggregation = aggregateTrials(value); const file = join(root, 'historical.json'); writeFileSync(file, JSON.stringify(value));
        const saved = readReport(file); expect(saved.trials[0]!.judgeCalls[0]!.raw).toBe(raw); expect(saved.trials[0]!.scores[0]!.value).toBe(1);
        expect(saved.trials[0]!.judgeCalls[0]!.request!.system).toBe(legacyPackedRubric.prompt);
    } finally { rmSync(root, { recursive: true, force: true }); }
});
