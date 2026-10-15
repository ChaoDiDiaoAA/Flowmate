import { runtimeSourceConditions } from '../../src/execution/source.ts';
import { syntheticNativeModel } from './native-model.ts';
import type { CaseExecutionResult } from '../../src/types.ts';
import type { LocalReport } from '../../src/reports/store.ts';
import { loadDataset, resolveCase, REPO_ROOT } from '../../src/dataset-loader/local.ts';
import { afterAll } from 'bun:test';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { tasks, manifest, material } from '../fixtures/minimal-dataset.ts';
export const fixtureRepo = mkdtempSync(join(tmpdir(), 'flowmate-facilities-'));
export const fixtureDirectory = join(fixtureRepo, 'agent-eval/src/datasets/facility-test');
mkdirSync(join(fixtureDirectory, 'cases'), { recursive: true });
writeFileSync(join(fixtureRepo, '.gitignore'), 'agent-eval/runs/\n');
for (const t of tasks) writeFileSync(join(fixtureDirectory, 'cases', t.id + '.json'), JSON.stringify(t));
writeFileSync(join(fixtureDirectory, 'dataset.json'), JSON.stringify(manifest));
const materials = join(fixtureRepo, 'data/invoices/voxel51/000001');
mkdirSync(materials, { recursive: true });
writeFileSync(join(materials, 'content.md'), material);
writeFileSync(join(materials, 'metadata.json'), JSON.stringify({  }));
// Runner source snapshots operate on this small, isolated repository, never the user's data.
execFileSync('git', ['init', '-q', fixtureRepo]);
execFileSync('git', ['-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid', '-c', 'commit.gpgsign=false', 'commit', '--allow-empty', '-qm', 'synthetic'], { cwd: fixtureRepo });
afterAll(() => rmSync(fixtureRepo, { recursive: true, force: true }));
export const dataset = loadDataset(fixtureDirectory,fixtureRepo), task = dataset.cases[0]!, projected = resolveCase(dataset, task, fixtureRepo).projected;
export function observed(): CaseExecutionResult {
    const identity = { executionId: 'unit', trialId: 'trial-1', caseId: task.id, caseVersion: task.version };
    return { identity, started: true, status: 'completed', endpointReached: true, input: structuredClone(projected), answer: 'Answer with sources',
        artifacts: [{ id: 'candidate-1', kind: 'candidate', content: { invoiceNumber: task.expected.reference?.fields.invoiceNumber } }],
        observations: [], configuration: { model: 'test' }, usage: { inputTokens: 10, outputTokens: 5 }, startedAt: '2026-09-23T00:00:00Z', endedAt: '2026-09-23T00:00:01Z',
        evidence: {
            'task-endpoint': { present: true, actual: true, source: 'product-query' },
            'input-projection': { present: true, actual: structuredClone(projected), source: 'input-boundary' },
            environment: { present: true, actual: { ...identity, fresh: true }, source: 'owned-workspace' },
            cleanup: { present: true, actual: { closed: true, stopped: true }, source: 'process-exit' },
            'redaction-scan': { present: true, actual: { leaked: false }, source: 'scanner' },
            answer: { present: true, actual: 'Answer with sources', source: 'query' },
            'task-facts': { present: true, actual: { saved: true }, source: 'candidate-query' }
        } };
}
export function reportFixture(): LocalReport {
    const execution = observed();
    execution.identity = { executionId: 'unit', trialId: 'trial-1', caseId: 'sample', caseVersion: 1 };
    return { contract: 'flowmate-agent-run/v1', executionId: 'unit', dataset: { id: 'test', version: 1,  subject: 'agent' },
        selection: 'full', environment: 'test', startedAt: '2026-09-23T00:00:00Z', endedAt: '2026-09-23T00:00:01Z', repeat: 1, executionComplete: true, scoring: 'complete',
        manualReview: 'none', formalAcceptance: 'not-assessed', scoringConfiguration: { version: 1, judgeMode: 'off' }, export: { backend: 'local', status: 'disabled' },
        trials: [{ caseId: 'sample', caseVersion: 1, caseConditions: {task:{id:'sample',version:1}}, caseName: 'Sample', category: 'invoice-quality', partition: 'smoke', repetition: 1, trialId: 'trial-1',
                traceId: 'abcdef0123456789abcdef0123456789', status: 'PASS', reason: 'checks passed', counts: { PASS: 1 }, execution,
                scores: [{ metricId: 'task-result', name: '任务终点', version: 1, method: 'deterministic', required: true, value: 1, status: 'PASS', reason: 'matches', evidence: ['task-endpoint'] }], judgeCalls: [], feedback: 'none' }] };
}

/** Actual checked-in source bodies with the explicitly declared synthetic model connection. */
export function comparisonFacts(){
    return {configuration:{model:'test',api:'openai-completions',baseUrl:'https://example.invalid',modelCapabilities:syntheticNativeModel},
        runtimeSource:runtimeSourceConditions(REPO_ROOT)};
}
