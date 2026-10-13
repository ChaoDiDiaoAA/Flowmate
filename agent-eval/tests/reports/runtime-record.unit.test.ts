import { judgeResponse } from '../support/judge-response.ts';
import { expect, test } from 'bun:test';
import { mkdtempSync } from '../../../tests/support/resources.ts';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { readFileSync, writeFileSync } from 'node:fs';
import { aggregateTrials } from '../../src/scoring/aggregate.ts';
import { readReport, saveReport } from '../../src/reports/store.ts';
import { reportFixture } from '../support/fixtures.ts';
import { legacyPlainRubric } from '../../src/scoring/judges/packed.ts';
import { runCompactJudge } from '../../src/scoring/judges/harness.ts';
import { compactScores, type CompactPlan } from '../../src/scoring/judges/compact.ts';
import { judgeConfig } from '../../src/scoring/judges/client.ts';
import { hash } from '../../src/dataset-loader/local.ts';

test('new reports aggregate and save actual Trials without an approval record', () => {
    const report = reportFixture(); report.contract = 'flowmate-agent-run/v2';
    report.trials[0]!.metricPlan = [{ metricId: 'task-success', version: 1, unit: 'Trial', denominator: 1 }];
    const file = join(mkdtempSync(join(tmpdir(), 'eval-runtime-record-')), 'report.json');
    saveReport(file, report);
    expect(readReport(file).aggregation!.cases[0]!.planned).toBe(1);
    expect(JSON.parse(readFileSync(file, 'utf8'))).not.toHaveProperty('frozenConditions');
});

test('the previous plain JSON Prompt remains readable with its original scores', async () => {
    const plan: CompactPlan={contract:'flowmate-semantic-plan/v1',criteria:[{metricId:'tool-selection',version:1,unit:'决策点',denominator:1,
        required:false,rule:'One observed decision.',evidence:['answer'],trigger:'started'}]};
    const config=judgeConfig({FLOWMATE_JUDGE_PROVIDER:'openai-compatible',FLOWMATE_JUDGE_API:'openai-completions',FLOWMATE_JUDGE_MODEL:'llama-3.3-70b-versatile',
        FLOWMATE_JUDGE_BASE_URL:'https://unused.invalid/v1',FLOWMATE_JUDGE_API_KEY:'synthetic-legacy-json-key'})!;
    const call=await runCompactJudge(config,plan,{answer:{present:true,actual:'Synthetic answer',source:'synthetic'}},async()=>
        judgeResponse({choices:[{message:{content:'{"v":1,"r":[[1,1,0]],"f":[]}'},finish_reason:'stop'}]}));
    call.request!.system=legacyPlainRubric.prompt;call.request!.hash=hash([call.request!.system,call.request!.data]);
    call.configuration.rubric={id:legacyPlainRubric.id,version:legacyPlainRubric.version,hash:hash(legacyPlainRubric.prompt)};
    const {configHash:_,...parameters}=call.configuration;call.configuration.configHash=hash(parameters);
    const report=reportFixture();report.contract='flowmate-agent-run/v2';report.trials[0]!.metricPlan=[{metricId:'task-success',version:1,unit:'Trial',denominator:1},
        {metricId:'tool-selection',version:1,unit:'决策点',denominator:1}];
    report.trials[0]!.semanticPlan=plan;report.trials[0]!.judgeCalls=[call];report.trials[0]!.scores.push(...compactScores(call));
    report.aggregation=aggregateTrials(report);report.scoringConfiguration.judgeHash=call.configuration.configHash;
    const file=join(mkdtempSync(join(tmpdir(),'eval-previous-json-')),'report.json');writeFileSync(file,JSON.stringify(report));
    expect(readReport(file).trials[0]!.scores.find(s=>s.metricId==='tool-selection')!.value).toBe(1);
});

test('historical report metadata is read-only compatible without becoming a new requirement', () => {
    const report = reportFixture(); report.contract = 'flowmate-agent-run/v2';
    report.trials[0]!.metricPlan = [{ metricId: 'task-success', version: 1, unit: 'Trial', denominator: 1 }];
    const legacy = { ...report, frozenConditions: { configurationHash: 'historical-only', strategyGroup: 'A' } };
    legacy.aggregation = aggregateTrials(legacy);
    const file = join(mkdtempSync(join(tmpdir(), 'eval-historical-record-')), 'report.json');
    const bytes = JSON.stringify(legacy); writeFileSync(file, bytes);
    const restored = readReport(file);
    expect(restored.trials[0]!.status).toBe('PASS');
    expect(restored).not.toHaveProperty('frozenConditions');
    expect(readFileSync(file, 'utf8')).toBe(bytes);
    expect(() => saveReport(file, restored)).toThrow('read-only');
});
