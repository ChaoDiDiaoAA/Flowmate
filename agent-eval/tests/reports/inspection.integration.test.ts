import { test, expect } from 'bun:test';
import { readFileSync, readdirSync, unlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { mkdtempSync } from '../../../tests/support/resources.ts';
import { reportFixture } from '../support/fixtures.ts';
import * as reports from '../../src/reports/store.ts';

const inspect = reports.inspectReport;
function saved() {
    const root = mkdtempSync(join(tmpdir(), 'eval-inspection-')), file = join(root, 'report.json');
    const report = reportFixture(); reports.saveReport(file, report);
    return { root, file, report, original: readFileSync(file, 'utf8'), evidence: join(root, 'evidence/trial-1') };
}

test('a missing observation retains original score metadata and other evidence without fabricating an execution', () => {
    const p = saved(); unlinkSync(join(p.evidence, 'observation.json'));
    expect(() => reports.readReport(p.file)).toThrow();
    const view = inspect(p.file);
    expect(view).toMatchObject({ fullReport: null, metadata: { executionId: 'unit', scoring: 'complete',
        trials: [{ trialId: 'trial-1', scores: [{ metricId: 'task-result', value: 1 }] }] },
        gaps: [{ trialId: 'trial-1', kind: 'observation', reference: 'evidence/trial-1/observation.json', reason: 'missing' }] });
    expect(view.metadata.trials[0]).not.toHaveProperty('execution');
    expect(view.parts.some((part: { kind: string }) => part.kind === 'artifact')).toBe(true);
    expect(view.sources).toContainEqual({ reference: 'evidence/trial-1/observation.json', content: null });
    expect(readFileSync(p.file, 'utf8')).toBe(p.original);
});

test('invalid associated JSON is a specific evidence gap while available facts remain readable', () => {
    const p = saved(); writeFileSync(join(p.evidence, 'observation.json'), '{');
    const view = inspect(p.file);
    expect(view).toMatchObject({ fullReport: null, gaps: [{ kind: 'observation', reason: 'invalid' }] });
    expect(view.parts.some((part: { kind: string }) => part.kind === 'trial')).toBe(true);
    expect(() => reports.readReport(p.file)).toThrow();
    expect(readFileSync(p.file, 'utf8')).toBe(p.original);
});

test('identity conflicts and corrupt report metadata cannot become a partial successful view', () => {
    const p = saved(), trial = join(p.evidence, 'trial.json'), originalTrial = readFileSync(trial, 'utf8');
    const foreign = JSON.parse(originalTrial); foreign.identity.executionId = 'foreign'; writeFileSync(trial, JSON.stringify(foreign));
    expect(() => inspect(p.file)).toThrow(/identity|foreign/i);
    writeFileSync(trial, originalTrial);
    const raw = JSON.parse(p.original); raw.trials[0].scores[0].value = 2; writeFileSync(p.file, JSON.stringify(raw));
    expect(() => inspect(p.file)).toThrow();
});

test('inspection rejects unowned evidence references before reading them', () => {
    const p = saved(), raw = JSON.parse(p.original);
    raw.trials[0].evidence.observation = '../outside.json'; writeFileSync(p.file, JSON.stringify(raw));
    expect(() => inspect(p.file)).toThrow(/evidence reference/i);
});

test('complete inspection uses original strict validation and tracks every read source for paging', () => {
    const p = saved(), before = readdirSync(p.root), view = inspect(p.file);
    expect(view).toMatchObject({ gaps: [], fullReport: { executionId: 'unit', trials: [{ execution: { started: true } }] } });
    expect(view.sources).toContainEqual({ reference: 'report.json', content: p.original });
    expect(view.sources).toContainEqual({ reference: 'export.json', content: null });
    expect(view.parts.filter(part => part.kind === 'events')[0]!.data).toEqual([]);
    expect(readdirSync(p.root)).toEqual(before); expect(readFileSync(p.file, 'utf8')).toBe(p.original);
});

test('a legacy inline report stays readable without creating synthetic evidence files', () => {
    const root = mkdtempSync(join(tmpdir(), 'eval-inspection-legacy-')), file = join(root, 'summary.json');
    const original = JSON.stringify(reportFixture()); writeFileSync(file, original);
    expect(inspect(file)).toMatchObject({ gaps: [], fullReport: { executionId: 'unit' }, metadata: { executionId: 'unit' } });
    expect(readdirSync(root)).toEqual(['summary.json']); expect(readFileSync(file, 'utf8')).toBe(original);
});
