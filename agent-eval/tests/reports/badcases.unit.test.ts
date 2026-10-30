import { afterEach, expect, test } from 'bun:test';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import * as badcases from '../../src/reports/badcases.ts';
import { reportFixture } from '../support/fixtures.ts';
import {createArchive,archiveReference,writeArchivePart} from '../../src/reports/archive.ts';

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });
function saved() {
    const directory = mkdtempSync(join(tmpdir(), 'eval-badcases-')); roots.push(directory);
    const file = join(directory, 'report.json'), report = reportFixture();
    report.trials[0]!.status = 'UNJUDGEABLE'; report.trials[0]!.scores[0]!.status = 'UNJUDGEABLE'; report.trials[0]!.scores[0]!.value = null;
    writeFileSync(file, JSON.stringify(report)); return { file, directory, report };
}

test('diagnostic sidecars share a stable index and never rewrite original scores or source files', () => {
    expect(badcases.saveBadcases).toBeFunction();
    const { file, directory, report } = saved(), before = readFileSync(file);
    const index = badcases.deriveBadcases(report, { file });
    const first = badcases.saveBadcases(file, index);
    expect(first.saved).toBe(true);
    expect(JSON.parse(readFileSync(join(directory, 'badcases.json'), 'utf8'))).toEqual(index);
    expect(readFileSync(join(directory, 'badcases.md'), 'utf8')).toContain('待核验记录 1 条');
    const bytes = readFileSync(join(directory, 'badcases.json'));
    expect(badcases.saveBadcases(file, badcases.deriveBadcases(report, { file })).saved).toBe(true);
    expect(readFileSync(join(directory, 'badcases.json'))).toEqual(bytes); expect(readFileSync(file)).toEqual(before);
});

test('inline metric diagnostics resolve to the original score in the actual Run JSON',()=>{
    const {directory,report}=saved(),archive=createArchive(directory,{selection:'smoke'});
    const ref=archiveReference(archive.file,'executions',report.executionId);writeArchivePart(ref,report);
    const signal=badcases.deriveBadcases(report,{file:ref}).candidates[0]!.signals.find(s=>s.kind==='metric-unjudgeable')!;
    const evidence=signal.evidence.find(e=>e.nodeId==='metric:'+report.trials[0]!.scores[0]!.metricId)!;
    const original=JSON.parse(readFileSync(archive.file,'utf8'));
    const pointed=evidence.jsonPointer.slice(1).split('/').map(p=>p.replace(/~1/g,'/').replace(/~0/g,'~')).reduce((value,key)=>value?.[key],original);
    expect(pointed).toBeDefined();
    expect(pointed.metricId).toBe(report.trials[0]!.scores[0]!.metricId);
});

test('sidecar write failures are separate from the original report and its grade', () => {
    expect(badcases.saveBadcases).toBeFunction();
    const { file, directory, report } = saved(), before = readFileSync(file);
    mkdirSync(join(directory, 'badcases.json'));
    const result = badcases.saveBadcases(file, badcases.deriveBadcases(report));
    expect(result.saved).toBe(false); expect(result).toHaveProperty('error');
    expect(readFileSync(file)).toEqual(before); expect(report.trials[0]!.status).toBe('UNJUDGEABLE');
});

test('bound human disagreement and comparable regressions are observations, never automatic confirmation', () => {
    const report = reportFixture();
    const feedback = { id: 'actual-feedback', kind: 'run-feedback' as const, caseId: 'sample', caseVersion: 1, executionId: 'unit', trialId: 'trial-1',
        reviewer: 'synthetic-reviewer', verdict: 'bad' as const, at: '2026-10-14T00:00:00Z', note: 'synthetic test disagreement', source: 'local' };
    const index = badcases.deriveBadcases(report, { feedback: [feedback, { ...feedback, id: 'foreign', trialId: 'foreign' }] });
    expect(index.summary).toEqual({ candidates: 1, confirmed: 0 });
    expect(index.candidates[0]!.signals.map(signal => signal.kind)).toEqual(['human-disagreement']);
    expect(index.candidates[0]!.primaryCause).toBeNull(); expect(report.trials[0]!.status).toBe('PASS');
});

test('a comparison cannot invent a regression which conflicts with the original after status', () => {
    const index = badcases.deriveBadcases(reportFixture(), { comparison: { executionId: 'prior',
        trials: [{ caseId: 'sample', repetition: 1, before: 'PASS', after: 'FAIL' }] } });
    expect(index.summary.candidates).toBe(0);
});
