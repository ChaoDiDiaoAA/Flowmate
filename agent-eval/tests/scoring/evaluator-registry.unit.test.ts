import {expect,test} from 'bun:test';
import {createRegistry} from '../../src/scoring/registry.ts';
import {metricCatalog} from '../../src/scoring/catalog.ts';
import {formalEvaluatorOwners,compileEvaluatorPlan} from '../../src/scoring/evaluator-plan.ts';
import {discoverDatasets,REPO_ROOT} from '../../src/dataset-loader/local.ts';
import {join} from 'node:path';
import {formalFixture} from '../support/formal.ts';

test('every formal requirement resolves to an executable registered evaluator without counting compatibility judges',()=>{
    const registry=createRegistry(), definitions=registry.list();
    expect(definitions.filter(d=>d.kind==='deterministic')).toHaveLength(25);
    expect(definitions.filter(d=>d.kind==='llm-judge')).toHaveLength(10);
    expect(definitions.some(d=>d.id==='answer-relevance')).toBe(false);
    for(const metric of metricCatalog){
        const owner=registry.get(formalEvaluatorOwners[metric.id]!);
        expect(owner.outputs).toContain(metric.id);
        expect(typeof owner.appliesTo).toBe('function');
    }
    expect(registry.get('answer-relevance').kind).toBe('llm-judge');
});

test('registered runtime evaluators can independently judge their declared original metrics',async()=>{
    const context=formalFixture('runtime-admission');
    const score=await createRegistry().get('runtime-admission').evaluate(context,{metric:'task-result',required:true});
    expect(score).toMatchObject({metricId:'runtime-admission',status:'UNJUDGEABLE',value:null});
});

test('compiled plans preserve all 39 original declarations and do not assign a Judge to the zero-tool control',()=>{
    const datasets=discoverDatasets(join(REPO_ROOT,'agent-eval/src/datasets'));
    const cases=datasets.flatMap(d=>d.cases);
    expect(cases).toHaveLength(62);
    for(const task of cases){
        const plan=compileEvaluatorPlan(task);
        const formal=plan.flatMap(p=>p.outputs.filter(o=>o.category==='formal'));
        expect(formal).toHaveLength(39);
        expect(new Set(formal.map(m=>m.metricId)).size).toBe(39);
    }
    const control=cases.find(c=>c.id==='FM-028')!;
    expect(compileEvaluatorPlan(control).some(p=>p.kind==='llm-judge'&&p.applicable)).toBe(false);
});
