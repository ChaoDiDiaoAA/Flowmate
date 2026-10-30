import { expect, test } from 'bun:test';
import { mkdtempSync } from '../../../tests/support/resources.ts';
import { readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { reportFixture } from '../support/fixtures.ts';
import { judgeResponse } from '../support/judge-response.ts';
import { judgeConfig } from '../../src/scoring/judges/client.ts';
import { runJudge, runCompactJudge } from '../../src/scoring/judges/harness.ts';
import { compactScores, compactRubricFor } from '../../src/scoring/judges/compact.ts';
import { aggregate } from '../../src/scoring/aggregate.ts';
import { saveReport, readReport } from '../../src/reports/store.ts';
import { exportEvents } from '../../src/langfuse/export.ts';

const config = () => judgeConfig({ FLOWMATE_JUDGE_PROVIDER: 'anthropic', FLOWMATE_JUDGE_API: 'anthropic-messages', FLOWMATE_JUDGE_MODEL: 'claude-haiku-4-5',
    FLOWMATE_JUDGE_BASE_URL: 'https://example.com', FLOWMATE_JUDGE_API_KEY: 'sdk-report-judge-key' }, join(tmpdir(), 'no-judge-report-config'))!;
const sdkCall = (usage?: unknown) => runJudge(config(), 'rubric', 'data', async () => judgeResponse({ content: [{ type: 'text', text: '{"score":1,"reason":"Original SDK result"}' }], stop_reason: 'end_turn', usage }));
test('a final scoring report rejects an unterminated or submitted-only Judge call', async () => {
    const call = await sdkCall();
    for (const state of ['missing-end', 'submitted-only']) {
        const report = modernReport(), altered = structuredClone(call);
        if (state === 'missing-end') altered.endedAt = '';
        else altered.lifecycle = 'submitted';
        report.trials[0]!.judgeCalls = [altered];
        expect(() => saveReport(join(mkdtempSync(join(tmpdir(), 'judge-final-state-')), 'report.json'), report)).toThrow();
    }
});
function modernReport() {
    const report = reportFixture(); report.contract = 'flowmate-agent-run/v2';
    report.trials[0]!.metricPlan = [{ metricId: 'task-success', version: 1, unit: 'Trial', denominator: 1 }];
    return report;
}

test('named protocol round-trips valid metrics and individual errors with frozen templates and export diagnostics', async () => {
    const plan = { contract: 'flowmate-semantic-plan/v1' as const, criteria: [
        { metricId: 'tool-selection', version: 1, unit: '决策点', denominator: 1, required: true, rule: 'One decision.', evidence: ['original'], trigger: 'started' as const },
        { metricId: 'tool-arguments', version: 1, unit: '请求', denominator: 1, required: true, rule: 'One request.', evidence: ['original'], trigger: 'started' as const }
    ] };
    const call = await runCompactJudge(config(), plan, {}, async () => judgeResponse({ content: [{ type: 'text', text: JSON.stringify({v:1,
        results:[{metricId:'tool-selection',counts:{numerator:1,denominator:1,unassessable:0},failures:[]},
            {metricId:'tool-arguments',counts:{numerator:1,denominator:1,unassessable:0},failures:[],unknownField:'original protocol error'}]}) }], stop_reason:'end_turn' }));
    const report = modernReport(), trial = report.trials[0]!;
    trial.semanticPlan = plan; trial.judgeCalls = [call]; trial.scores.push(...compactScores(call));
    trial.metricPlan!.push(...plan.criteria.map(({metricId,version,unit,denominator})=>({metricId,version,unit,denominator})));
    Object.assign(trial, aggregate(trial.scores, trial.execution!));
    const declared=structuredClone(call.configuration);delete declared.rubric;

    report.scoringConfiguration.judge=declared;report.scoringConfiguration.rubrics=[compactRubricFor(plan)];
    const file = join(mkdtempSync(join(tmpdir(), 'judge-metric-report-')), 'report.json');
    saveReport(file, report);
    expect(readReport(file).trials[0]!.scores.filter(s=>s.judge)).toMatchObject([{status:'PASS'}, {status:'ERROR'}]);
    expect(JSON.parse(readReport(file).trials[0]!.judgeCalls[0]!.raw!).results[1]).toHaveProperty('unknownField','original protocol error');
    const event = exportEvents(report).find(e=>e.body.name==='Judge · 回答质量')!;
    expect(event.body.metadata).toHaveProperty('validationErrors.tool-arguments');
    const forged = structuredClone(report);
    forged.trials[0]!.judgeCalls[0]!.compact!.validationErrors!['tool-arguments'] = 'changed';
    expect(()=>saveReport(join(mkdtempSync(join(tmpdir(), 'judge-metric-forged-')), 'report.json'),forged)).toThrow();
    for(const mutate of [
        (r:any)=>{r.scoringConfiguration.judge.model='different-model';},
        (r:any)=>{r.scoringConfiguration.judge.apiKey='must-not-be-stored';},
        (r:any)=>{r.scoringConfiguration.rubrics[0].prompt='different template';},
        (r:any)=>{r.scoringConfiguration.rubrics.push(r.scoringConfiguration.rubrics[0]);},
        (r:any)=>{delete r.trials[0].judgeCalls[0].compact.format;}
    ]){
        const changed=structuredClone(report);mutate(changed);
        expect(()=>saveReport(join(mkdtempSync(join(tmpdir(), 'judge-freeze-forged-')), 'report.json'),changed)).toThrow();
    }
});

test('public v1 artifacts round-trip SDK API, native capabilities and normalized stop reasons without runtime or credentials', async () => {
    const report = modernReport(), call = await sdkCall({ input_tokens: 12, output_tokens: 8, cache_read_input_tokens: 3, cache_creation_input_tokens: 2 });
    report.trials[0]!.judgeCalls = [call];
    const directory = mkdtempSync(join(tmpdir(), 'judge-sdk-report-')), file = join(directory, 'report.json');
    saveReport(file, report);
    const observation = readFileSync(join(directory, 'evidence', report.trials[0]!.trialId, 'observation.json'), 'utf8');
    expect(JSON.parse(readFileSync(file, 'utf8')).artifactFormat).toBe('flowmate-eval-public/v1');
    expect(JSON.parse(observation).judgeCalls[0].configuration.protocolVersion).toBe('flowmate-judge/v1');
    expect(observation).not.toContain('sdk-report-judge-key');
    expect(observation).not.toContain('runtime');
    const restored = readReport(file).trials[0]!.judgeCalls[0]!;
    expect(restored).toMatchObject({ stopReason: 'stop', rawStopReason: 'end_turn', usageSource: 'sdk', responseComplete: true,
        configuration: { api: 'anthropic-messages', sdk: { ai: '1.4.0', codingAgent: '1.4.0' }, modelCapabilities: { maxTokens: 64000 } } });
    expect(restored).not.toHaveProperty('finishReason');
    const event = exportEvents(report).find(event => event.body.name === 'Judge · 回答质量')!;
    expect(event.body.usageDetails).toMatchObject({ input: 12, output: 8, cacheRead: 3, cacheWrite: 2, totalTokens: 25 });
    expect(event.body.metadata).toMatchObject({ api: 'anthropic-messages', sdk: { ai: '1.4.0' }, stopReason: 'stop', rawStopReason: 'end_turn', usageSource: 'sdk' });
});

test('SDK zero placeholders do not become known usage in Langfuse', async () => {
    const report = modernReport(); report.trials[0]!.judgeCalls = [await sdkCall()];
    const event = exportEvents(report).find(event => event.body.name === 'Judge · 回答质量')!;
    expect(event.body.usageDetails).toBeUndefined();
    expect(event.body.metadata).toMatchObject({ usageSource: 'unknown' });
});

test('partially reported SDK usage leaves unproven zero token fields unknown in Langfuse', async () => {
    const report = modernReport(); report.trials[0]!.judgeCalls = [await sdkCall({ output_tokens: 8 })];
    const event = exportEvents(report).find(event => event.body.name === 'Judge · 回答质量')!;
    expect(event.body.usageDetails).toEqual({ output: 8, totalTokens: 8 });
    expect(report.trials[0]!.judgeCalls[0]!.usage).toMatchObject({ input: 0, output: 8 });
});

test('old HTTP reports retain provider finishReason validation and never acquire SDK completion metadata', () => {
    for (const provider of ['anthropic', 'openai-compatible'] as const) {
        const report = modernReport(), raw = '{"score":1,"reason":"Original HTTP result"}';
        report.trials[0]!.judgeCalls = [{ callId: 'legacy-http', configuration: { provider, model: 'legacy-model', baseUrl: 'https://example.com',
            timeoutMs: 30000, protocolVersion: 'flowmate-judge/v2' }, startedAt: report.startedAt, endedAt: report.endedAt!, attempts: 1,
            usage: { output_tokens: 8 }, responseModel: null, raw, error: null, judgment: { score: 1, reason: 'Original HTTP result' },
            responseComplete: true, finishReason: provider === 'anthropic' ? 'end_turn' : 'stop' }] as any;
        const file = join(mkdtempSync(join(tmpdir(), 'judge-http-report-')), 'report.json');
        saveReport(file, report);
        const restored = readReport(file).trials[0]!.judgeCalls[0]!;
        expect(restored.finishReason).toBe(provider === 'anthropic' ? 'end_turn' : 'stop');
        expect(restored).not.toHaveProperty('stopReason');
        expect(restored.configuration).not.toHaveProperty('sdk');
        (report.trials[0]!.judgeCalls[0] as any).finishReason = provider === 'anthropic' ? 'stop' : 'end_turn';
        expect(() => saveReport(join(mkdtempSync(join(tmpdir(), 'judge-http-invalid-')), 'report.json'), report)).toThrow();
    }
});

test('SDK records reject normalized completion contradictions or a removed SDK discriminator', async () => {
    const report = modernReport(); report.trials[0]!.judgeCalls = [await sdkCall()];
    for (const mutate of [
        (call: any) => { call.stopReason = 'length'; },
        (call: any) => { delete call.configuration.sdk; },
        (call: any) => { delete call.stopReason; },
        (call: any) => { call.finishReason = 'end_turn'; }
    ]) {
        const changed = structuredClone(report); mutate(changed.trials[0]!.judgeCalls[0]);
        expect(() => saveReport(join(mkdtempSync(join(tmpdir(), 'judge-sdk-invalid-')), 'report.json'), changed)).toThrow();
    }
});

test('current parsing policy, normalization and HTTP status round-trip without trusting forged parse metadata', async () => {
    const plan={contract:'flowmate-semantic-plan/v1' as const,criteria:[{metricId:'tool-arguments',version:1,unit:'请求',denominator:1,
        required:true,rule:'One authorized request.',evidence:['original'],trigger:'started' as const}]};
    const call=await runCompactJudge(config(),plan,{},async()=>judgeResponse({content:[{type:'text',text:JSON.stringify({v:1,
        results:[{metricId:'tool-arguments',counts:{numerator:1,denominator:1,unassessable:0},failures:[]}]})}],stop_reason:'end_turn'}));
    Object.assign(call.compact!,{parsePolicy:'metric-json-independent/v1',normalization:'none'});
    Object.assign(call,{transportStatus:200});
    const report=modernReport(),trial=report.trials[0]!;
    trial.semanticPlan=plan;trial.judgeCalls=[call];trial.scores.push(...compactScores(call));
    trial.metricPlan!.push({metricId:'tool-arguments',version:1,unit:'请求',denominator:1});
    Object.assign(trial,aggregate(trial.scores,trial.execution!));
    const declared=structuredClone(call.configuration);delete declared.rubric;

    report.scoringConfiguration.judge=declared;report.scoringConfiguration.rubrics=[compactRubricFor(plan)];
    const file=join(mkdtempSync(join(tmpdir(),'judge-policy-report-')),'report.json');
    saveReport(file,report);
    expect(readReport(file).trials[0]!.judgeCalls[0]).toMatchObject({transportStatus:200,compact:{
        parsePolicy:'metric-json-independent/v1',normalization:'none'}});
    const event=exportEvents(report).find(e=>e.body.name==='Judge · 回答质量')!;
    expect(event.body.metadata).toMatchObject({transportStatus:200,parsePolicy:'metric-json-independent/v1',normalization:'none'});
    for(const mutate of [
        (c:any)=>{delete c.compact.parsePolicy;},
        (c:any)=>{c.compact.parsePolicy='unknown-policy';},
        (c:any)=>{c.compact.normalization='markdown-fence';},
        (c:any)=>{c.transportStatus=402;}
    ]){
        const changed=structuredClone(report);mutate(changed.trials[0]!.judgeCalls[0]);
        expect(()=>saveReport(join(mkdtempSync(join(tmpdir(),'judge-policy-forged-')),'report.json'),changed)).toThrow();
    }
});
