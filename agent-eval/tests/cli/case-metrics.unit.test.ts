import { expect, test } from 'bun:test';
import { createProgressReporter } from '../../src/cli.ts';
import { reportFixture } from '../support/fixtures.ts';
import { deriveTrialStatistics } from '../../src/reports/trial-statistics.ts';

test('global Trial progress and per-Case Trial index are distinct and all Case summaries are printed once',()=>{
    const report=reportFixture();report.contract='flowmate-agent-run/v2';
    const first=report.trials[0]!;
    first.metricPlan=[{metricId:'task-success',version:1,unit:'Trial',denominator:1},
        {metricId:'tool-arguments',version:1,unit:'请求',denominator:2},
        {metricId:'DR06',version:1,unit:'必需链',notApplicable:'No chain'}];
    first.scores.push({metricId:'tool-arguments',version:1,name:'参数正确率',method:'llm-judge',required:false,
        status:'ERROR',value:null,reason:'Controlled fault',evidence:[],statistics:{unit:'请求',numerator:0,denominator:2,missing:2}});
    const other=structuredClone(first);other.caseId='other';other.trialId='other-1';other.metricPlan=[first.metricPlan[0]!];
    other.scores=[];if(other.execution)Object.assign(other.execution.identity,{caseId:'other',trialId:'other-1'});
    report.trials.push(other);
    const lines:string[]=[],reporter=createProgressReporter(line=>lines.push(line));
    reporter.onProgress({type:'plan',selection:'full',caseCount:2,trialsPerCase:3,total:6,datasets:[{id:'test',caseCount:2,total:6}]});
    reporter.onProgress({type:'trial-phase',index:4,total:6,caseId:'sample',trialId:'sample-2',trialIndex:2,trialsPerCase:3,phase:'scoring'});
    const event={type:'dataset-end' as const,datasetId:'test',executionId:'unit',reportPath:'D:/synthetic/report.json',stopped:false,
        counts:{PASS:2},statistics:deriveTrialStatistics(report)};
    reporter.onProgress(event);reporter.onProgress(event);reporter.close();
    const text=lines.join('');expect(text).toContain('2个Case，每Case 3个Trial，共6个Trial');
    expect(text).toContain('[4/6] sample · Trial 2/3：评分');
    expect(lines.filter(line=>line.includes('sample：指标汇总'))).toHaveLength(1);
    expect(lines.filter(line=>line.includes('other：指标汇总'))).toHaveLength(1);
    expect(text).toContain('task-success');expect(text).toContain('参数正确率');expect(text).toContain('评分错误');
    expect(text).not.toContain('DR06');expect(text).not.toContain('runtime-admission');
    expect(text.slice(text.indexOf('other：指标汇总'))).not.toContain('tool-arguments');
    expect(text).toContain('不可计算');expect(text).not.toContain('"trialStatistics"');
});

test('a failing stderr writer cannot interrupt Case statistics or cleanup',()=>{
    const report=reportFixture();report.contract='flowmate-agent-run/v2';report.trials[0]!.metricPlan=[{metricId:'task-success',version:1,unit:'Trial',denominator:1}];
    const reporter=createProgressReporter(()=>{throw Error('Closed terminal');});
    expect(()=>reporter.onProgress({type:'dataset-end',datasetId:'test',executionId:'unit',reportPath:'D:/synthetic/report.json',stopped:false,
        counts:{PASS:1},statistics:deriveTrialStatistics(report)})).not.toThrow();reporter.close();
});
