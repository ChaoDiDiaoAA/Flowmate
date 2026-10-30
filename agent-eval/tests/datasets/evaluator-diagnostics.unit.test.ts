import {expect,test} from 'bun:test';
import {caseV2Schema} from '../../src/dataset-loader/schema.ts';
import {formalFixture} from '../support/formal.ts';
import {compileFormalSemanticPlan} from '../../src/scoring/formal-rules.ts';
import {judgeSelection} from '../../src/dataset-loader/local.ts';
import {dataset} from '../support/fixtures.ts';
import {caseDiagnosticsSchema} from '../../src/scoring/diagnostic-plans.ts';

test('specialist check declarations stay separate from 39 formal metrics and reject unknown parameters',()=>{
    const task=structuredClone(formalFixture().task);
    const diagnostics=[{evaluatorId:'latency-budget',required:true,reason:'Explicit Agent execution budget',params:{maxMs:1200}}];
    const parsed=caseV2Schema.safeParse({...task,expected:{...task.expected,diagnostics}});
    expect(parsed.success).toBe(true);
    if(parsed.success)expect(parsed.data.expected.metrics).toHaveLength(39);
    expect(caseV2Schema.safeParse({...task,expected:{...task.expected,diagnostics:[{...diagnostics[0],params:{maxMs:1200,guess:true}}]}}).success).toBe(false);
});

test('a legacy group alias and a Metric declaration cannot select the same diagnostic twice',()=>{
    const diagnostic={evaluatorId:'task-judge',required:true,reason:'Explain the observed fault',
        params:{metricId:'diagnostic-partial-failure-explanation',denominator:1,evidence:['answer']}};
    expect(caseDiagnosticsSchema.safeParse([{...diagnostic,evaluatorId:diagnostic.params.metricId}]).success).toBe(true);
    expect(caseDiagnosticsSchema.safeParse([diagnostic,{...diagnostic,evaluatorId:diagnostic.params.metricId}]).success).toBe(false);
});

test('a required semantic diagnostic schedules Judge without adding a formal metric',()=>{
    const task=structuredClone(formalFixture().task);
    const expected={...task.expected,diagnostics:[{evaluatorId:'task-judge' as const,required:true,reason:'Disclose every material partial failure',
        params:{metricId:'diagnostic-partial-failure-explanation' as const,denominator:1,evidence:['answer','tool-evidence']}}]};
    const plan=compileFormalSemanticPlan({...task,expected});
    expect(plan?.criteria.map(c=>c.metricId)).toEqual(['diagnostic-partial-failure-explanation']);
    const parsed=caseV2Schema.parse({...task,expected:{...expected,semantic:plan}});
    const manifest={...dataset.manifest,contract:'flowmate-agent-dataset/v2' as const,environment:{...dataset.manifest.environment,profile:'isolated-agent/v2' as const},
        scoring:{...dataset.manifest.scoring,judges:[{id:'semantic-batch' as const,required:false}]}};
    expect(judgeSelection({manifest,cases:[parsed]},true)).toEqual({needed:true,required:true});
    expect(parsed.expected.metrics).toHaveLength(39);
});

test('an existing semantic plan cannot silently omit a newly declared necessary specialist criterion',()=>{
    const task=formalFixture('clarification-decision').task;
    const semantic=compileFormalSemanticPlan(task);
    const diagnostics=[{evaluatorId:'task-judge',required:true,reason:'Disclose the material failure',
        params:{metricId:'diagnostic-partial-failure-explanation',denominator:1,evidence:['answer']}}];
    expect(caseV2Schema.safeParse({...task,expected:{...task.expected,semantic,diagnostics}}).success).toBe(false);
});
