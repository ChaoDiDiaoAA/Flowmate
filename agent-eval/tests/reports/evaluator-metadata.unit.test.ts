import {test,expect} from 'bun:test';
import {reportFixture,fixtureRepo} from '../support/fixtures.ts';
import {saveReport,readReport} from '../../src/reports/store.ts';
import {exportEvents} from '../../src/langfuse/export.ts';
import {join} from 'node:path';

test('Evaluator identity survives report round trip and export without fabricating Judge usage',()=>{
    const report=reportFixture(),score=report.trials[0]!.scores[0]!;
    Object.assign(score,{evaluatorId:'task-result',evaluatorVersion:1,category:'guardrail',applicabilityReason:'Declared task endpoint'});
    const path=join(fixtureRepo,'evaluator-metadata','report.json');
    saveReport(path,report);
    const read=readReport(path);
    expect(read.trials[0]!.scores[0]!.evaluatorId).toBe('task-result');
    const events=exportEvents(read);
    const value=events.find(e=>e.type==='score-create')!;
    expect(value.body.metadata).toMatchObject({evaluatorId:'task-result',category:'guardrail',applicabilityReason:'Declared task endpoint'});
    expect(events.some(e=>e.type==='generation-create')).toBe(false);
});

test('Diagnostic ratios survive report storage and export separately from their pass status',()=>{
    const report=reportFixture();
    report.trials[0]!.scores.push({metricId:'diagnostic-tool-recall',name:'必需工具召回率',version:1,method:'deterministic',
        required:false,value:0.5,status:'FAIL',reason:'One of two required tools was called',evidence:['tool-evidence'],
        statistics:{unit:'检查机会',numerator:1,denominator:2,missing:0},evaluatorId:'tool-recall',evaluatorVersion:1,
        category:'diagnostic',applicabilityReason:'Two required tools'});
    const path=join(fixtureRepo,'evaluator-ratio','report.json');
    saveReport(path,report);
    const read=readReport(path),score=read.trials[0]!.scores.find(score=>score.metricId==='diagnostic-tool-recall')!;
    expect(score).toMatchObject({value:0.5,status:'FAIL',statistics:{numerator:1,denominator:2,missing:0}});
    const exported=exportEvents(read).find(event=>event.type==='score-create'&&event.body.name===score.name);
    expect(exported?.body.value).toBe(0.5);
});
