import { judgeResponse } from '../../support/judge-response.ts';
import { expect, test } from 'bun:test';
import { compactPlanSchema, parseCompactJudgment, compactRubric } from '../../../src/scoring/judges/compact.ts';
import { runCompactJudge } from '../../../src/scoring/judges/harness.ts';
import { formalMetric } from '../../../src/scoring/catalog.ts';
import { prepareJudge, requestJudge } from '../../../src/scoring/judges/client.ts';

const criterion = (metricId: string, denominator: number | null) => ({ metricId, denominator,
    version: 1, unit: formalMetric(metricId).unit, required: true, rule: 'Check the original evidence.', evidence: ['original'], trigger: 'started' as const });

test('plain Judge output retains more than eight failures and counts above the old encoding capacity', () => {
    const plan = compactPlanSchema.parse({ contract: 'flowmate-semantic-plan/v1', criteria: [criterion('tool-arguments', 2000)] });
    const result = parseCompactJudgment(JSON.stringify({ v: 1, r: [[1990, 2000, 0]], f: Array.from({ length: 10 }, (_, i) => [0, i, 1]) }), plan);
    expect(result.f).toHaveLength(10);
    expect(result.r).toEqual([[1990, 2000, 0]]);
    expect(() => parseCompactJudgment(JSON.stringify({ ...result, f: [[0, 2000, 1]] }), plan)).toThrow();
    expect(compactRubric.prompt).not.toContain('at most 8');
    expect(compactRubric.prompt).not.toContain('fit the output limit');
});

test('new generation refuses legacy packed plans before any request', async () => {
    const plan = compactPlanSchema.parse({ contract: 'flowmate-semantic-plan/v1', criteria: [criterion('tool-arguments', 1)],
        encoding: { contract: 'flowmate-packed-judgment/v2', research: false, maxFacts: 0, maxLinks: 0, maxChains: 0, maxFailureIndexes: 8 } });
    let requests = 0;
    expect(() => runCompactJudge({ api: 'openai-completions', provider: 'openai-compatible', model: 'llama-3.3-70b-versatile', baseUrl: 'https://unused.invalid/v1', apiKey: 'fake-plain-key', timeoutMs: 180000 },
        plan, {}, async () => { requests++; throw Error('unexpected request'); })).toThrow('read-only');
    expect(requests).toBe(0);
});

test('DeepSeek Anthropic Judge reads native provider metadata and uses the protocol version path', async () => {
    const requests:string[]=[];
    const fetcher=async(url:string,init:RequestInit)=>{
        requests.push(url);
        if(init.method==='GET') {
            expect(url).toBe('https://api.deepseek.com/models');
            return Response.json({data:[{id:'deepseek-flash',owned_by:'deepseek',context_window:1048576,max_output_tokens:393216,effort:{supported_levels:['high','max']}}]});
        }
        expect(url).toBe('https://api.deepseek.com/anthropic/v1/messages?beta=true');
        const body=JSON.parse(String(init.body));expect(body.max_tokens).toBe(393216);expect(body).not.toHaveProperty('temperature');
        return judgeResponse({content:[{type:'text',text:'{}'}],stop_reason:'end_turn'});
    };
    const config=await prepareJudge({api:'anthropic-messages',provider:'anthropic',baseUrl:'https://api.deepseek.com/anthropic',model:'deepseek-flash',apiKey:'fake-deepseek-judge-key',timeoutMs:180000},fetcher);
    await requestJudge(config,'synthetic rubric','synthetic evidence',fetcher);
    expect(requests).toHaveLength(2);expect(config.modelCapabilities?.source).toBe('deepseek-models-api');
});
