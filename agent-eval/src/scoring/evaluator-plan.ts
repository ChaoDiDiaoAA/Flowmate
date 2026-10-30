import type {LocalCase,Check} from '../dataset-loader/local.ts';
import {metricCatalog} from './catalog.ts';
import {semanticEvaluatorDefinitions, semanticEvaluator} from './judges/evaluators.ts';
import {diagnosticApplicable,diagnosticEvaluatorIds} from './diagnostics.ts';

const localOwners:Record<string,string>={
    'task-success':'task-result','tool-execution':'tool-error-rate','retry-compliance':'failure-recovery',
    'cancellation-compliance':'closed','runtime-admission':'runtime-admission','result-delivery':'result-delivery',
    'candidate-idempotency':'candidate-idempotency','context-delivery':'context-delivery',
    'subtask-scope':'subagent-contract','subtask-stop':'subagent-contract','DR03':'research-f1'};
export const formalEvaluatorOwners:Readonly<Record<string,string>>=Object.freeze(Object.fromEntries(metricCatalog.map(m=>{
    const owner=localOwners[m.id]??semanticEvaluatorDefinitions.find(d=>d.outputs?.includes(m.id))?.id;
    if(!owner)throw Error('Formal metric has no evaluator: '+m.id);
    return[m.id,owner];
})));
export function evaluatorForMetric(task:LocalCase,metricId:string):string{
    if(task.expected.maxToolCalls===0){
        if(metricId==='tool-selection')return'tool-precision';
        if(['skill-selection','progressive-reading'].includes(metricId))return'fact-check';
    }
    if(metricId.startsWith('diagnostic-')){
        if(semanticEvaluatorDefinitions.some(d=>d.id===metricId))return metricId;
        return metricId.slice('diagnostic-'.length);
    }
    if(metricId==='fact-check/required-subagent-roles')return'subagent-contract';
    if(metricId.startsWith('fact-check/'))return'fact-check';
    return formalEvaluatorOwners[metricId]??({'case-max-tool-calls':'max-tool-calls','case-required-capabilities':'tool-recall',
        'case-forbidden-capabilities':'tool-precision','case-evidence-required':'evidence-presence',
        'fact-check/required-subagent-roles':'subagent-contract'}[metricId]??metricId);
}
export type EvaluatorPlanEntry={evaluatorId:string;version:number;kind:'deterministic'|'llm-judge';applicable:boolean;reason:string;
    outputs:Array<{metricId:string;category:'formal'|'diagnostic'|'guardrail';applicable:boolean;reason:string;required:boolean;denominator?:number|null}>};
export function compileEvaluatorPlan(task:LocalCase,checks:readonly Check[]=task.expected.checks):EvaluatorPlanEntry[]{
    const entries=new Map<string,EvaluatorPlanEntry>();
    const add=(owner:string,output:EvaluatorPlanEntry['outputs'][number])=>{
        const semantic=semanticEvaluatorDefinitions.find(d=>d.id===owner);
        const entry=entries.get(owner)??{evaluatorId:owner,version:semantic?.version??1,kind:semantic?'llm-judge' as const:'deterministic' as const,
            applicable:false,reason:'No applicable requirements',outputs:[]};
        if(!entry.outputs.some(o=>o.metricId===output.metricId))entry.outputs.push(output);
        entry.applicable ||= output.applicable;
        if(entry.applicable)entry.reason='Selected by declared Case requirements';
        entries.set(owner,entry);
    };
    if('contract'in task)for(const plan of task.expected.metrics){
        if(!Object.hasOwn(formalEvaluatorOwners,plan.metricId))throw Error('Unknown formal metric: '+plan.metricId);
        const criterion=task.expected.semantic?.criteria.find(c=>c.metricId===plan.metricId);
        add(evaluatorForMetric(task,plan.metricId),{metricId:plan.metricId,category:'formal',applicable:!plan.notApplicable,
            reason:plan.notApplicable??criterion?.rule??'Declared formal metric opportunity',required:plan.metricId==='task-success'||!!criterion?.required,
            ...(!plan.notApplicable?{denominator:plan.denominator??null}:{})});
    }
    for(const check of checks)add(evaluatorForMetric(task,check.metric),{metricId:check.metric,category:'guardrail',applicable:true,
        reason:check.description??'Declared independent check',required:check.required});
    const constraints:Array<[boolean,string]>=[
        [task.expected.maxToolCalls!==undefined,'case-max-tool-calls'],[!!task.expected.requiredCapabilities?.length,'case-required-capabilities'],
        [!!task.expected.forbiddenCapabilities?.length,'case-forbidden-capabilities'],[!!task.expected.mustHaveEvidence,'case-evidence-required'],
        [!!task.expected.requiredSkills?.length,'fact-check/required-skills'],[!!task.expected.forbiddenSkills?.length,'fact-check/forbidden-skills'],
        [!!task.expected.requiredSubagentRoles?.length,'fact-check/required-subagent-roles']];
    for(const [selected,metricId]of constraints)if(selected)add(evaluatorForMetric(task,metricId),{metricId,category:'guardrail',applicable:true,reason:'Declared Case hard constraint',required:true});
    for(const id of diagnosticEvaluatorIds)if(diagnosticApplicable({task} as Parameters<typeof diagnosticApplicable>[0],id)){
        const declared=task.expected.diagnostics?.find(d=>d.evaluatorId===id);
        add(id,{metricId:'diagnostic-'+id,category:'diagnostic',applicable:true,reason:declared?.reason??'Declared Case constraint',required:declared?.required??false});
    }
    for(const diagnostic of task.expected.diagnostics??[])if('metricId'in diagnostic.params)
        add(semanticEvaluator(diagnostic.params.metricId).id,{metricId:diagnostic.params.metricId,category:'diagnostic',applicable:true,reason:diagnostic.reason,
            required:diagnostic.required,denominator:diagnostic.params.denominator});
    return[...entries.values()];
}
