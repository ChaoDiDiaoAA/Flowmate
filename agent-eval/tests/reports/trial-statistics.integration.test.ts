import { expect, spyOn, test } from 'bun:test';
import { mkdtempSync } from '../../../tests/support/resources.ts';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { readFileSync, writeFileSync } from 'node:fs';
import { reportFixture } from '../support/fixtures.ts';
import { deriveTrialStatistics } from '../../src/reports/trial-statistics.ts';
import { readReport, saveReport } from '../../src/reports/store.ts';
import { main } from '../../src/cli.ts';
import { randomUUID } from 'node:crypto';
import { mkdirSync } from 'node:fs';

test('saved Trial statistics round-trip and any contradictory derived field is rejected',()=>{
    const report=reportFixture();report.contract='flowmate-agent-run/v2';
    report.trials[0]!.metricPlan=[{metricId:'task-success',version:1,unit:'Trial',denominator:1}];
    report.trialStatistics=deriveTrialStatistics(report);
    const file=join(mkdtempSync(join(tmpdir(),'trial-statistics-')),'report.json');
    expect(()=>saveReport(file,report)).not.toThrow();
    expect(readReport(file).trialStatistics).toEqual(report.trialStatistics);
    const original=readFileSync(file,'utf8'),raw=JSON.parse(original);
    raw.trialStatistics.cases[0].probabilities[0].passAtK=0.123;
    writeFileSync(file,JSON.stringify(raw));
    expect(()=>readReport(file)).toThrow('Trial statistics');
    writeFileSync(file,original);
    raw.trialStatistics.cases[0].probabilities[0].passAtK=1;
    raw.trialStatistics.extra='unsupported';writeFileSync(file,JSON.stringify(raw));
    expect(()=>readReport(file)).toThrow('Trial statistics');
});

test('legacy reports without diagnostics can be derived without being written back',()=>{
    const report=reportFixture(),file=join(mkdtempSync(join(tmpdir(),'trial-statistics-legacy-')),'report.json');
    saveReport(file,report);const before=readFileSync(file);
    const saved=readReport(file);expect(saved.trialStatistics).toBeUndefined();
    const stats=deriveTrialStatistics(saved);
    expect(stats.cases[0]!.reasons).toContain('缺少原始正式指标计划');
    expect(readFileSync(file).equals(before)).toBe(true);
});

test('not-started lifecycle failures preserve diagnostics across the existing saved-record projection',()=>{
    const report=reportFixture();report.contract='flowmate-agent-run/v2';
    const trial=report.trials[0]!;trial.metricPlan=[{metricId:'task-success',version:1,unit:'Trial',denominator:1}];
    trial.status='NOT_RUN';trial.reason='Lifecycle timeout';trial.scores=[];
    Object.assign(trial.execution!,{started:false,status:'not-started',endpointReached:false,
        error:{code:'execution_error',message:'Lifecycle timeout',infrastructure:true}});
    report.trialStatistics=deriveTrialStatistics(report);
    const file=join(mkdtempSync(join(tmpdir(),'trial-statistics-not-started-')),'report.json');
    expect(()=>saveReport(file,report)).not.toThrow();
    const saved=readReport(file);expect(saved.trialStatistics).toEqual(report.trialStatistics);
    expect(saved.trials[0]!.reason).toBe('Lifecycle timeout');
    expect(saved.trialStatistics!.cases[0]!.valid).toBe(false);
});

test('cancelled hard FAIL facts and ineligible statistics survive report persistence',()=>{
    const report=reportFixture();report.contract='flowmate-agent-run/v2';report.executionComplete=false;
    const trial=report.trials[0]!;trial.metricPlan=[{metricId:'task-success',version:1,unit:'Trial',denominator:1}];
    trial.status='FAIL';trial.reason='Known task failure before cancellation';trial.counts={FAIL:1};
    Object.assign(trial.execution!,{status:'cancelled',endpointReached:false});
    Object.assign(trial.scores[0]!,{status:'FAIL',value:0,reason:trial.reason});
    report.trialStatistics=deriveTrialStatistics(report);
    const file=join(mkdtempSync(join(tmpdir(),'trial-statistics-cancelled-')),'report.json');
    saveReport(file,report);
    const saved=readReport(file);
    expect(saved.trials[0]!.status).toBe('FAIL');expect(saved.trials[0]!.execution!.status).toBe('cancelled');
    expect(saved.trialStatistics).toEqual(report.trialStatistics);
    expect(saved.trialStatistics!.cases[0]).toMatchObject({complete:false,valid:false});
    expect(saved.trialStatistics!.dataset.probabilities[0]!.passAtK).toBeNull();
});

test('status emits explicit saved or read-only-derived statistics as JSON without mutating old files',async()=>{
    const repo=mkdtempSync(join(tmpdir(),'trial-statistics-status-'));
    const output=spyOn(console,'log').mockImplementation(()=>{}),exit=process.exitCode;
    const originalFetch=globalThis.fetch;let requests=0;
    globalThis.fetch=Object.assign(async()=>{requests++;throw Error('Network forbidden');},originalFetch);
    try {
        for(const withStats of [false,true]){
            const report=reportFixture();report.executionId='status-'+randomUUID();report.contract='flowmate-agent-run/v2';
            report.trials[0]!.execution!.identity.executionId=report.executionId;
            report.trials[0]!.metricPlan=[{metricId:'task-success',version:1,unit:'Trial',denominator:1}];
            if(withStats)report.trialStatistics=deriveTrialStatistics(report);
            const directory=join(repo,'agent-eval/runs/business',report.executionId);mkdirSync(directory,{recursive:true});
            const file=join(directory,'report.json');saveReport(file,report);const before=readFileSync(file);
            await main(['status','--execution-id',report.executionId],repo);
            const value=JSON.parse(String(output.mock.calls.at(-1)![0]));
            expect(value.trialStatisticsOrigin).toBe(withStats?'saved':'derived');
            expect(value.trialStatistics.cases[0].trials[0].trialIndex).toBe(1);
            expect(readFileSync(file).equals(before)).toBe(true);
        }
        expect(requests).toBe(0);
    } finally {output.mockRestore();globalThis.fetch=originalFetch;process.exitCode=exit??0;}
});
