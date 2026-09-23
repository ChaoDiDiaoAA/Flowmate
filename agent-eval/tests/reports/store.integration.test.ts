import { mkdtempSync } from '../../../tests/support/resources.ts';
import { expect, test } from 'bun:test';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { reportFixture, fixtureDirectory } from '../support/fixtures.ts';
import { exportEvents, exportReport, validateReceipt } from '../../src/langfuse/export.ts';
import { readReport, exitCode, comparison } from '../../src/reports/store.ts';
import { addFeedback, feedbackStatus } from '../../src/review/local.ts';
import { loadDataset, caseContentHash } from '../../src/datasets/local.ts';
test('export failure and repeated resend preserve business scores and reuse IDs', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'eval-report-'));
    try {
        const report = reportFixture(), file = join(dir, 'summary.json');
        const before = JSON.stringify(report.trials);
        const ids = exportEvents(report).map(e => e.id);
        await exportReport(report, file, async () => { throw new Error('offline'); });
        expect(report.export.status).toBe('error');
        expect(exitCode(report)).toBe(0);
        const batches: unknown[] = [];
        await exportReport(report, file, async (batch) => { batches.push(batch); });
        expect(exportEvents(report).map(e => e.id)).toEqual(ids);
        expect(JSON.stringify(report.trials)).toBe(before);
        expect(readReport(file).export.status).toBe('complete');
        expect(JSON.stringify(batches)).not.toContain('flowmate_judge_');
        expect(JSON.stringify(batches)).not.toContain('sdk-experiment');
        report.trials[0]!.scores[0]!.value = null;
        expect(exportEvents(report).filter(e => e.type === 'score-create')).toHaveLength(0);
    }
    finally {
        rmSync(dir, { recursive: true, force: true });
    }
});
test('review records actual version and never upgrades business grade or inherits a stale Case review', () => {
    const dir = mkdtempSync(join(tmpdir(), 'eval-review-'));
    try {
        const dataset = loadDataset(fixtureDirectory);
        const task = dataset.cases[0]!;
        const feedback = addFeedback(dir, { dataset, caseId: task.id, reviewer: 'test-reviewer', verdict: 'good', note: 'synthetic test record' });
        expect(feedback.caseHash).toBe(caseContentHash(dataset, task));
        expect(feedbackStatus(dir, undefined, dataset).records).toHaveLength(1);
        task.version++;
        expect(feedbackStatus(dir, undefined, dataset).records).toHaveLength(0);
        const path = join(dir, 'agent-eval/runs/unit');
        mkdirSync(path, { recursive: true });
        const report = reportFixture();
        report.trials[0]!.status = 'FAIL';
        writeFileSync(join(path, 'summary.json'), JSON.stringify(report));
        addFeedback(dir, { executionId: 'unit', caseId: 'sample', reviewer: 'test-reviewer', verdict: 'good', note: 'separate judgment' });
        expect(readReport(join(path, 'summary.json')).trials[0]!.status).toBe('FAIL');
        expect(() => addFeedback(dir, { dataset, executionId: 'unit', caseId: 'sample', reviewer: 'a', verdict: 'good', note: 'b' })).toThrow('Exactly one');
    }
    finally {
        rmSync(dir, { recursive: true, force: true });
    }
});
test('incompatible report comparisons and historical re-export are rejected', () => {
    const left = reportFixture(), right = reportFixture();
    right.environment = 'different';
    expect(() => comparison(left, right)).toThrow();
    right.environment = 'test';
    right.trials[0]!.scores[0]!.version = 99;
    expect(() => comparison(left, right)).toThrow('Scoring');
    left.trials[0]!.scores[0]!.status = 'NOT_RUN';
    left.trials[0]!.scores[0]!.value = null;
    left.trials[0]!.status = 'UNJUDGEABLE';
    expect(exitCode(left)).toBe(2);
});
test('different Judge configuration is not silently treated as comparable scoring', () => {
    const left = reportFixture(), right = reportFixture();
    const call = { configuration: { configHash: 'model-a' } } as any;
    left.scoringConfiguration.judgeHash = 'a';
    right.scoringConfiguration.judgeHash = 'b';
    expect(() => comparison(left, right)).toThrow('configuration');
});
test('partial or missing export receipts do not claim completion', () => {
    const events = exportEvents(reportFixture());
    expect(() => validateReceipt(events, { successes: [], errors: [] })).toThrow('incomplete');
    expect(() => validateReceipt(events, { successes: events.map(e => ({ id: e.id })), errors: [] })).not.toThrow();
    expect(() => validateReceipt(events, { successes: events.map(e => ({ id: e.id })), errors: ['rejected'] })).toThrow();
});
