import { legacyCompactRubric } from '../../src/scoring/judges/packed.ts';
import { publicJudgeConfig } from '../../src/scoring/judges/client.ts';
import { mkdtempSync } from '../../../tests/support/resources.ts';
import { expect, test } from 'bun:test';
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { reportFixture, fixtureDirectory } from '../support/fixtures.ts';
import { exportEvents, exportReport, validateReceipt } from '../../src/langfuse/export.ts';
import { readReport, saveReport, exitCode, comparison } from '../../src/reports/store.ts';
import { addFeedback, feedbackStatus } from '../../src/review/local.ts';
import { loadDataset, caseContentHash, hash } from '../../src/dataset-loader/local.ts';
import { judgeConfig } from '../../src/scoring/judges/client.ts';
import { runJudge, runCompactJudge } from '../../src/scoring/judges/harness.ts';
import { compactScores } from '../../src/scoring/judges/compact.ts';
import { aggregate, aggregateTrials } from '../../src/scoring/aggregate.ts';
import { deriveResearchF1 } from '../../src/scoring/research-f1.ts';
import {formalMetric} from '../../src/scoring/catalog.ts';
import {loadCalibration} from '../../src/scoring/judges/calibration.ts';

test('plain research witnesses, independent counts and derived F1 survive report readback and reject changed originals',async()=>{
 const dir=mkdtempSync(join(tmpdir(),'eval-packed-report-')),file=join(dir,'summary.json');
 try{
  const reference=loadCalibration(join(import.meta.dir,'../fixtures/judge-calibration')).samples.find(s=>s.id==='dr06-validation')!.document;
  const frame=(reference.evidence as any).researchFrame,plan={...reference.plan,criteria:['DR01','DR02','DR04','DR05','DR06'].map(metricId=>({
   ...reference.plan.criteria[0],metricId,unit:formalMetric(metricId).unit,
   denominator:metricId==='DR02'?frame.gold.claims.filter((c:any)=>c.required).length:metricId==='DR06'?frame.gold.chains.length:null}))};
  const config=judgeConfig({FLOWMATE_JUDGE_PROVIDER:'openai-compatible',FLOWMATE_JUDGE_MODEL:'synthetic',FLOWMATE_JUDGE_BASE_URL:'https://unused.invalid/v1',FLOWMATE_JUDGE_API_KEY:'synthetic-judge-key'})!;
  let requests=0;const call=await runCompactJudge(config,plan,{researchFrame:frame},async()=>{requests++;return new Response(JSON.stringify({choices:[{message:{content:JSON.stringify({...JSON.parse(reference.referenceWire!),r:plan.criteria.map(()=>null)})},finish_reason:'stop'}]}));});
  expect(call.error).toBeNull();expect(requests).toBe(1);
  const report=reportFixture();report.contract='flowmate-agent-run/v2';
  const trial=report.trials[0]!;trial.semanticPlan=plan;trial.judgeCalls=[call];trial.scores.push(...compactScores(call));
  trial.metricPlan=[{metricId:'task-success',version:1,unit:'Trial',denominator:1},...plan.criteria.map(({metricId,version,unit,denominator}:any)=>({metricId,version,unit,denominator})),
   {metricId:'DR03',version:1,unit:formalMetric('DR03').unit,denominator:null}];
  trial.scores.push(deriveResearchF1(trial.metricPlan,trial.scores,trial.execution)!);Object.assign(trial,aggregate(trial.scores,trial.execution!));
  report.scoringConfiguration.judgeHash=call.configuration.configHash;saveReport(file,report);
  const stored=readReport(file);expect(stored.trials[0]!.scores.filter(s=>s.metricId.startsWith('DR')).map(s=>s.value)).toEqual([1,1,1,1,1,1]);
  const partial=structuredClone(stored),partialFrame=structuredClone(frame);partialFrame.complete=false;partialFrame.links[0].valid=false;
  const partialCall=await runCompactJudge(config,plan,{researchFrame:partialFrame},async()=>new Response(JSON.stringify({choices:[{
   message:{content:JSON.stringify({v:1,r:plan.criteria.map(()=>null),f:[],research:{atoms:[],links:[],chains:[],unavailable:true}})},finish_reason:'stop'}]})));
  const partialTrial=partial.trials[0]!;partialTrial.judgeCalls=[partialCall];partialTrial.scores=partialTrial.scores.filter(s=>!s.metricId.startsWith('DR'));
  partialTrial.scores.push(...compactScores(partialCall));partialTrial.scores.push(deriveResearchF1(partialTrial.metricPlan,partialTrial.scores,partialTrial.execution)!);
  Object.assign(partialTrial,aggregate(partialTrial.scores,partialTrial.execution!));
  const partialFile=join(dir,'partial.json');saveReport(partialFile,partial);
  expect(readReport(partialFile).trials[0]!.scores.find(s=>s.metricId==='DR04')).toMatchObject({status:'FAIL',value:null,statistics:{denominator:null,missing:null}});
  for(const change of ['span','source','count']as const){const forged=JSON.parse(JSON.stringify(stored)),t=forged.trials[0];
   if(change==='count')t.scores.find((s:any)=>s.metricId==='DR02').statistics.numerator=0;
   else if(change==='span')t.judgeCalls[0].compact.judgment.research.atoms[0].start++;
   else{const data=JSON.parse(t.judgeCalls[0].request.data);data.evidence.researchFrame.blocks[0].text='Changed original assertion';t.judgeCalls[0].request.data=JSON.stringify(data);}
   writeFileSync(file,JSON.stringify(forged));expect(()=>readReport(file)).toThrow();
  }
 }finally{rmSync(dir,{recursive:true,force:true});}
});
test('export failure and repeated resend preserve business scores and reuse IDs', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'eval-report-'));
    try {
        const report = reportFixture(), file = join(dir, 'summary.json');
        saveReport(file,report);
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
        expect(feedback.caseVersion).toBe(task.version);
        expect(feedback.caseHash).toBeUndefined();
        expect(feedbackStatus(dir, undefined, dataset).records).toHaveLength(1);
        task.input.prompt += ' Changed input under the same public version.';
        expect(feedbackStatus(dir, undefined, dataset).records).toHaveLength(0);
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

test('v2 stores both aggregation layers, rejects stale counts and preserves old v1 reports', () => {
    const dir = mkdtempSync(join(tmpdir(), 'eval-v2-report-'));
    try {
        const report = reportFixture(), file = join(dir, 'summary.json');
        report.contract = 'flowmate-agent-run/v2';

        report.trials[0]!.metricPlan = [{ metricId: 'task-success', version: 1, unit: 'Trial', denominator: 1 }];
        saveReport(file, report);
        const stored = readReport(file);
        expect(stored.aggregation?.cases).toHaveLength(1);
        expect(stored.aggregation?.metrics.find(m => m.metricId === 'task-success')).toMatchObject({ numerator: 1, denominator: 1, value: 1 });
        expect(exportEvents(stored).length).toBeGreaterThan(0);
        stored.trials[0]!.status = 'FAIL';
        writeFileSync(file, JSON.stringify(stored));
        expect(() => readReport(file)).toThrow('aggregation');
        const legacy = join(dir, 'legacy-summary.json');
        saveReport(legacy, reportFixture());
        expect(readReport(legacy).contract).toBe('flowmate-agent-run/v1');
        expect(readReport(legacy).aggregation).toBeUndefined();
    } finally {
        rmSync(dir, { recursive: true, force: true });
    }
});

test('report readback rejects corrupt structures, score states and original identity conflicts before reuse', () => {
    const dir = mkdtempSync(join(tmpdir(), 'eval-report-validation-')), file = join(dir, 'summary.json');
    try {
        const mutations = [
            (r: any) => { delete r.trials; },
            (r: any) => { r.trials[0].status = 'SUCCESS'; },
            (r: any) => { r.trials[0].scores[0].value = 2; },
            (r: any) => { r.trials[0].scores[0].status = 'ERROR'; },
            (r: any) => { r.trials[0].execution.identity.trialId = 'foreign-trial'; },
            (r: any) => { r.trials[0].execution.identity.caseId = 'foreign-case'; },
            (r: any) => { r.trials.push(structuredClone(r.trials[0])); },
            (r: any) => { r.trials[0].repetition = 2; },
            (r: any) => { r.trials[0].execution.usage.inputTokens = -1; }
        ];
        for (const mutate of mutations) {
            const report = reportFixture(); mutate(report);
            writeFileSync(file, JSON.stringify(report));
            expect(() => readReport(file)).toThrow();
        }
        writeFileSync(file, JSON.stringify(reportFixture()).replace('"inputTokens":10', '"inputTokens":1e309'));
        expect(() => readReport(file)).toThrow();
    } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('atomic report saving preserves unrelated temporary files and rejects invalid replacement before writing', () => {
    const dir = mkdtempSync(join(tmpdir(), 'eval-report-atomic-')), file = join(dir, 'summary.json');
    try {
        const report = reportFixture();
        writeFileSync(file + '.tmp', 'UNRELATED_OLD_TEMP');
        const stored = saveReport(file, report);
        expect(stored).toEqual(readReport(file));
        expect(readFileSync(file + '.tmp', 'utf8')).toBe('UNRELATED_OLD_TEMP');
        const before = readFileSync(file, 'utf8');
        report.trials[0]!.scores[0]!.value = NaN;
        expect(() => saveReport(file, report)).toThrow();
        expect(readFileSync(file, 'utf8')).toBe(before);
        expect(readdirSync(dir).sort()).toEqual(['evidence','summary.json', 'summary.json.tmp']);
    } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('report updates preserve the declared plan and completed facts while allowing export metadata', () => {
    const dir = mkdtempSync(join(tmpdir(), 'eval-report-declared-')), file = join(dir, 'summary.json');
    try {
        const report = reportFixture(); report.endedAt = null; report.executionComplete = false; report.scoring = 'pending';
        saveReport(file, report);
        const before = readFileSync(file, 'utf8');
        for (const field of ['executionId', 'environment'] as const) {
            const changed = structuredClone(report); changed[field] = 'changed';
            expect(() => saveReport(file, changed)).toThrow();
            expect(readFileSync(file, 'utf8')).toBe(before);
        }
        report.endedAt = '2026-09-23T00:00:02Z'; report.executionComplete = true; report.scoring = 'complete';
        saveReport(file, report);
        const changed = structuredClone(report); changed.trials[0]!.scores[0]!.value = 0; changed.trials[0]!.scores[0]!.status = 'FAIL';
        expect(() => saveReport(file, changed)).toThrow('Completed');
        report.export = { backend: 'langfuse', status: 'error', error: 'Synthetic offline receipt' };
        expect(saveReport(file, report)?.export.status).toBe('disabled');
        expect(existsSync(file + '.tmp')).toBe(false);
    } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('stale open reports cannot overwrite newer progress and cannot be sent to the platform', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'eval-report-stale-')), file = join(dir, 'summary.json');
    try {
        const report = reportFixture(); report.endedAt = null; report.executionComplete = false; report.scoring = 'pending';
        saveReport(file, report);
        const stale = readReport(file);
        report.trials[0]!.status = 'ERROR'; report.trials[0]!.reason = 'Newer actual Trial failure';
        saveReport(file, report);
        stale.export = { backend: 'langfuse', status: 'complete' };
        expect(() => saveReport(file, stale)).toThrow('Stale');
        expect(readReport(file).trials[0]!.reason).toBe('Newer actual Trial failure');
        let requests = 0;
        await expect(exportReport(stale, file, async () => { requests++; })).rejects.toThrow('ended');
        expect(requests).toBe(0);
    } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('stored modern Judge identity and completion are verified while legacy metadata remains absent', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'eval-report-judge-')), file = join(dir, 'summary.json');
    try {
        const report = reportFixture(); report.contract = 'flowmate-agent-run/v2';

        report.trials[0]!.metricPlan = [{ metricId: 'task-success', version: 1, unit: 'Trial', denominator: 1 }];
        const { timeoutMs, ...parameters } = judgeConfig({ FLOWMATE_JUDGE_PROVIDER: 'openai-compatible', FLOWMATE_JUDGE_MODEL: 'synthetic',
            FLOWMATE_JUDGE_BASE_URL: 'https://unused.invalid/v1', FLOWMATE_JUDGE_API_KEY: 'synthetic-judge-key' })!;
        const config = { timeoutMs, ...parameters };
        report.trials[0]!.judgeCalls = [await runJudge(config, 'rubric', 'data', async () => new Response(JSON.stringify({
            choices: [{ message: { content: '{"score":1,"reason":"Synthetic record."}' }, finish_reason: 'stop' }] })))];
        report.scoringConfiguration.judgeHash = report.trials[0]!.judgeCalls[0]!.configuration.configHash;
        saveReport(file, report);
        expect(readReport(file).trials[0]!.judgeCalls[0]!.judgment?.score).toBe(1);
        for (const mutate of [
            (c: any) => { c.configuration.model = 'different-model'; },
            (c: any) => { c.responseComplete = false; c.finishReason = 'length'; },
            (c: any) => { delete c.finishReason; delete c.responseComplete; },
            (c: any) => { c.raw = '{"score":0,"reason":"Contradictory original."}'; }
        ]) {
            const changed = JSON.parse(JSON.stringify(report)); mutate(changed.trials[0].judgeCalls[0]);
            writeFileSync(file, JSON.stringify(changed));
            expect(() => readReport(file)).toThrow();
        }
        const contradictoryScore = JSON.parse(JSON.stringify(report));
        Object.assign(contradictoryScore.trials[0].scores[0], { method: 'llm-judge', value: 0, status: 'FAIL' });
        writeFileSync(file, JSON.stringify(contradictoryScore));
        expect(() => readReport(file)).toThrow('Semantic score');
        const legacy = JSON.parse(JSON.stringify(report)); legacy.contract = 'flowmate-agent-run/v1'; delete legacy.aggregation;
        const call = legacy.trials[0].judgeCalls[0]; delete call.finishReason; delete call.responseComplete; delete call.configuration.protocolVersion;
        const { configHash, ...legacyParameters } = call.configuration; call.configuration.configHash = hash(legacyParameters);
        legacy.scoringConfiguration.judgeHash = call.configuration.configHash;
        const legacyFile = join(dir, 'legacy-summary.json'); saveReport(legacyFile, legacy);
        expect(readReport(legacyFile).trials[0]!.judgeCalls[0]).not.toHaveProperty('responseComplete');
    } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('one compact Judge record binds distinct semantic counts to their original criterion and survives atomic report readback', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'eval-report-compact-')), file = join(dir, 'summary.json');
    const report = reportFixture(); report.contract = 'flowmate-agent-run/v2';

    const plan = { contract: 'flowmate-semantic-plan/v1' as const, criteria: [
        { metricId: 'tool-selection', version: 1, unit: '决策点', denominator: 3, required: true, rule: 'Three decisions.', evidence: ['original'], trigger: 'started' as const },
        { metricId: 'tool-arguments', version: 1, unit: '请求', denominator: 4, required: true, rule: 'Four requests.', evidence: ['original'], trigger: 'started' as const }
    ] };
    const config = judgeConfig({ FLOWMATE_JUDGE_PROVIDER: 'openai-compatible', FLOWMATE_JUDGE_MODEL: 'synthetic',
        FLOWMATE_JUDGE_BASE_URL: 'https://unused.invalid/v1', FLOWMATE_JUDGE_API_KEY: 'synthetic-judge-key' })!;
    const call = await runCompactJudge(config, plan, { original: 'synthetic' }, async () => new Response(JSON.stringify({
        choices: [{ message: { content: '{"v":1,"r":[[2,3,0],[1,4,1]],"f":[[1,2,1]]}' }, finish_reason: 'stop' }] })));
    const trial = report.trials[0]!;
    trial.semanticPlan = structuredClone(plan);
    trial.judgeCalls = [call]; trial.scores.push(...compactScores(call));
    trial.metricPlan = [{ metricId: 'task-success', version: 1, unit: 'Trial', denominator: 1 },
        ...plan.criteria.map(({ metricId, version, unit, denominator }) => ({ metricId, version, unit, denominator }))];
    Object.assign(trial, aggregate(trial.scores, trial.execution!));
    report.scoringConfiguration.judgeHash = call.configuration.configHash;
    saveReport(file, report);
    expect(readReport(file).trials[0]!.scores.slice(1)).toEqual(compactScores(call));
    expect(readReport(file).trials[0]!.status).toBe('FAIL');
    const open = structuredClone(report), openFile = join(dir, 'open.json');
    open.endedAt = null; open.executionComplete = false; open.scoring = 'pending';
    open.trials[0]!.scores = []; open.trials[0]!.judgeCalls = [];
    saveReport(openFile, open);
    const changedPlan = readReport(openFile); changedPlan.trials[0]!.semanticPlan!.criteria[0]!.rule = 'A different valid rule.';
    expect(() => saveReport(openFile, changedPlan)).toThrow('Declared report identity');
    expect(() => comparison(report, { ...report, trials: changedPlan.trials })).toThrow('Scoring versions');
    for (const mutate of [
        (r: typeof report) => { r.trials[0]!.scores[1]!.value = 1 / 4; },
        (r: typeof report) => { r.trials[0]!.scores[1]!.judge!.criterion = 1; },
        (r: typeof report) => { r.trials[0]!.scores[2]!.status = 'UNJUDGEABLE'; },
        (r: typeof report) => { r.trials[0]!.scores[1]!.statistics!.numerator = 3; },
        (r: typeof report) => { r.trials[0]!.judgeCalls[0]!.raw = '{"v":1,"r":[[3,3,0],[4,4,0]],"f":[]}'; },
        (r: typeof report) => { r.trials[0]!.judgeCalls[0]!.request.data += ' '; },
        (r: typeof report) => { r.trials[0]!.judgeCalls[0]!.compact!.plan.criteria[0]!.denominator = 4; },
        (r: typeof report) => { r.trials[0]!.judgeCalls[0]!.request.redacted = true; },
        (r: typeof report) => {
            const c = r.trials[0]!.judgeCalls[0]!; c.configuration.rubric!.version++;
            const { configHash: _, ...parameters } = c.configuration;
            c.configuration.configHash = hash(parameters); r.scoringConfiguration.judgeHash = c.configuration.configHash;
        },
        ...['rule', 'evidence', 'trigger', 'required'].map(field => (r: typeof report) => {
            const c = r.trials[0]!.judgeCalls[0]!, criterion = c.compact!.plan.criteria[0]!;
            Object.assign(criterion, { [field]: field === 'rule' ? 'Another valid rule.' : field === 'evidence' ? ['another-original'] : field === 'trigger' ? 'completed-endpoint' : false });
            const input = JSON.parse(c.request.data); input.plan = c.compact!.plan;
            c.request.data = JSON.stringify(input); c.request.hash = hash([c.request.system, c.request.data]);
            r.trials[0]!.scores.splice(1, 2, ...compactScores(c));
            Object.assign(r.trials[0]!, aggregate(r.trials[0]!.scores, r.trials[0]!.execution!));
            r.aggregation = aggregateTrials(r);
        }),
        (r: typeof report) => { r.trials[0]!.scores.pop(); },
        (r: typeof report) => { r.trials[0]!.judgeCalls.push(structuredClone(call)); }
    ]) {
        const changed = structuredClone(report); mutate(changed);
        writeFileSync(file, JSON.stringify(changed));
        expect(() => readReport(file)).toThrow();
    }
    for (const reason of ['length', 'stop']) {
        const failed = await runCompactJudge(config, plan, { original: 'synthetic' }, async () => new Response(JSON.stringify({
            choices: [{ message: { content: 'incomplete-json' }, finish_reason: reason }] })));
        const damaged = structuredClone(report), t = damaged.trials[0]!;
        t.judgeCalls = [failed]; t.scores = [t.scores[0]!, ...compactScores(failed)];
        Object.assign(t, aggregate(t.scores, t.execution!));
        const failureFile = join(dir, reason + '.json'); saveReport(failureFile, damaged);
        expect(readReport(failureFile).trials[0]!.scores.slice(1)).toMatchObject([{ status: 'ERROR', value: null }, { status: 'ERROR', value: null }]);
        expect(readReport(failureFile).trials[0]!.judgeCalls[0]!.raw).toBe('incomplete-json');
    }
});

test('report readback rederives same-Trial F1 and rejects copied values or a dropped derived score', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'eval-report-f1-')), file = join(dir, 'summary.json');
    const report = reportFixture(); report.contract = 'flowmate-agent-run/v2';

    const plan = { contract: 'flowmate-semantic-plan/v1' as const, criteria: [
        { metricId: 'DR01', version: 1, unit: '事实Claim', denominator: 3, required: true, rule: 'Synthetic precision matching.', evidence: ['original'], trigger: 'started' as const },
        { metricId: 'DR02', version: 1, unit: 'Gold Claim', denominator: 2, required: true, rule: 'Synthetic recall matching.', evidence: ['original'], trigger: 'started' as const }
    ] };
    const config = judgeConfig({ FLOWMATE_JUDGE_PROVIDER: 'openai-compatible', FLOWMATE_JUDGE_MODEL: 'synthetic',
        FLOWMATE_JUDGE_BASE_URL: 'https://unused.invalid/v1', FLOWMATE_JUDGE_API_KEY: 'synthetic-f1-key' })!;
    const reference=loadCalibration(join(import.meta.dir,'../fixtures/judge-calibration')).samples.find(s=>s.id==='dr06-validation')!.document;
    const frame=structuredClone((reference.evidence as any).researchFrame);
    frame.gold.claims=frame.gold.claims.filter((c:any)=>c.required).slice(0,2);frame.gold.chains=[];
    frame.blocks=Array.from({length:3},(_,i)=>({...frame.blocks[0],key:'synthetic-f1-'+i,text:'Synthetic original factual statement '+i}));
    const research={atoms:frame.blocks.map((_:unknown,i:number)=>({block:i,start:0,length:10,correct:i===0?1:0,needsCitation:true,covered:i===0?1:0,gold:i<2?i+1:0,matchUncertain:false})),
        links:frame.links.map(()=>({atom:0,state:1})),chains:[]};
    const call=await runCompactJudge(config,plan,{researchFrame:frame},async()=>Response.json({choices:[{message:{content:JSON.stringify({v:1,r:[null,null],f:[],research})},finish_reason:'stop'}]}));
    const trial = report.trials[0]!; trial.semanticPlan = structuredClone(plan); trial.judgeCalls = [call];
    trial.metricPlan = [{ metricId: 'task-success', version: 1, unit: 'Trial', denominator: 1 },
        ...plan.criteria.map(({ metricId, version, unit, denominator }) => ({ metricId, version, unit, denominator })),
        { metricId: 'DR03', version: 1, unit: '派生F1', denominator: null }];
    trial.scores.push(...compactScores(call)); trial.scores.push(deriveResearchF1(trial.metricPlan, trial.scores, trial.execution)!);
    Object.assign(trial, aggregate(trial.scores, trial.execution!)); report.scoringConfiguration.judgeHash = call.configuration.configHash;
    saveReport(file, report);
    expect(readReport(file).trials[0]!.scores.find(s => s.metricId === 'DR03')?.value).toBe(0.4);
    for (const mutate of [
        (t: typeof trial) => { t.scores.find(s => s.metricId === 'DR03')!.value = 1; },
        (t: typeof trial) => { t.scores.find(s => s.metricId === 'DR03')!.required = false; },
        (t: typeof trial) => { t.scores.find(s => s.metricId === 'DR03')!.evidence = ['another-Trial']; },
        (t: typeof trial) => { t.scores.find(s => s.metricId === 'DR03')!.actual = { contract: 'flowmate-research-f1/v1', operands: [] }; },
        (t: typeof trial) => { t.scores = t.scores.filter(s => s.metricId !== 'DR03'); }
    ]) {
        const changed = structuredClone(report); mutate(changed.trials[0]!);
        writeFileSync(file, JSON.stringify(changed));
        expect(() => readReport(file)).toThrow('F1');
    }
});

test('comparison aligns actual Case and repetition and rejects different scoring conditions', () => {
    const left=reportFixture(), right=reportFixture();
    right.trials=structuredClone(left.trials).reverse();
    expect(comparison(left,right)).toHaveLength(1);
    right.scoringConfiguration.judgeMode='required';
    expect(()=>comparison(left,right)).toThrow('scoring configuration');
});

test('historical compact scalar research reports remain readable without inventing witnesses or new scores', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'eval-report-f1-')), file = join(dir, 'summary.json');
    const report = reportFixture(); report.contract = 'flowmate-agent-run/v2';

    const plan = { contract: 'flowmate-semantic-plan/v1' as const, criteria: [
        { metricId: 'DR01', version: 1, unit: '事实Claim', denominator: 3, required: true, rule: 'Synthetic precision matching.', evidence: ['original'], trigger: 'started' as const },
        { metricId: 'DR02', version: 1, unit: 'Gold Claim', denominator: 2, required: true, rule: 'Synthetic recall matching.', evidence: ['original'], trigger: 'started' as const }
    ] };
    const config = judgeConfig({ FLOWMATE_JUDGE_PROVIDER: 'openai-compatible', FLOWMATE_JUDGE_MODEL: 'synthetic',
        FLOWMATE_JUDGE_BASE_URL: 'https://unused.invalid/v1', FLOWMATE_JUDGE_API_KEY: 'synthetic-f1-key' })!;
    const raw=JSON.stringify({v:1,r:[[1,3,0],[1,2,0]],f:[]});
    const data=JSON.stringify({plan,evidence:{original:'historical scalar grading record'}});
    const call:Parameters<typeof compactScores>[0]={callId:'00000000-0000-4000-8000-000000000001',configuration:publicJudgeConfig(config,legacyCompactRubric),
        startedAt:report.startedAt,endedAt:report.endedAt!,attempts:1,usage:null,responseModel:'synthetic',finishReason:'stop',responseComplete:true,
        raw,error:null,judgment:null,request:{system:legacyCompactRubric.prompt,data,redacted:false,hash:hash([legacyCompactRubric.prompt,data])},
        compact:{plan,judgment:{v:1,r:[[1,3,0],[1,2,0]],f:[]}}};
    const trial = report.trials[0]!; trial.semanticPlan = structuredClone(plan); trial.judgeCalls = [call];
    trial.metricPlan = [{ metricId: 'task-success', version: 1, unit: 'Trial', denominator: 1 },
        ...plan.criteria.map(({ metricId, version, unit, denominator }) => ({ metricId, version, unit, denominator })),
        { metricId: 'DR03', version: 1, unit: '派生F1', denominator: null }];
    trial.scores.push(...compactScores(call)); trial.scores.push(deriveResearchF1(trial.metricPlan, trial.scores, trial.execution)!);
    Object.assign(trial, aggregate(trial.scores, trial.execution!)); report.scoringConfiguration.judgeHash = call.configuration.configHash;
    saveReport(file, report);
    expect(readReport(file).trials[0]!.scores.find(s => s.metricId === 'DR03')?.value).toBe(0.4);
    for (const mutate of [
        (t: typeof trial) => { t.scores.find(s => s.metricId === 'DR03')!.value = 1; },
        (t: typeof trial) => { t.scores.find(s => s.metricId === 'DR03')!.required = false; },
        (t: typeof trial) => { t.scores.find(s => s.metricId === 'DR03')!.evidence = ['another-Trial']; },
        (t: typeof trial) => { t.scores.find(s => s.metricId === 'DR03')!.actual = { contract: 'flowmate-research-f1/v1', operands: [] }; },
        (t: typeof trial) => { t.scores = t.scores.filter(s => s.metricId !== 'DR03'); }
    ]) {
        const changed = structuredClone(report); mutate(changed.trials[0]!);
        writeFileSync(file, JSON.stringify(changed));
        expect(() => readReport(file)).toThrow('F1');
    }
});
