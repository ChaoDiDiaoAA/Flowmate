import {definitions} from './index.ts';
import {evaluateFormalMetrics} from './formal.ts';
import {evaluateCaseConstraints} from '../case-constraints.ts';
import {deriveResearchF1} from '../research-f1.ts';
import {diagnosticApplicable,diagnosticEvaluatorIds,evaluateDiagnostic} from '../diagnostics.ts';
import {formalEvaluatorOwners,evaluatorForMetric,compileEvaluatorPlan} from '../evaluator-plan.ts';
import {formalRules} from '../formal-rules.ts';
import type {EvaluationContext,EvaluatorDefinition,EvaluationScore} from '../types.ts';
import {formalMetric} from '../catalog.ts';

export function formalScoresFor(context:EvaluationContext,outputs:readonly string[],owner?:string):EvaluationScore[]{
    return evaluateFormalMetrics(context).filter(s=>outputs.includes(s.metricId)&&(!owner||evaluatorForMetric(context.task,s.metricId)===owner)&&!context.gradedScores?.some(g=>g.metricId===s.metricId));
}
const applies=(context:EvaluationContext,id:string)=>compileEvaluatorPlan(context.task).some(p=>p.evaluatorId===id&&p.applicable);
const formalEvidence=(outputs:readonly string[])=>[...new Set(formalRules.filter(r=>outputs.includes(r.metricId)).flatMap(r=>r.evidence))];
const constraintsFor=(context:EvaluationContext,id:string)=>evaluateCaseConstraints(context).filter(s=>evaluatorForMetric(context.task,s.metricId)===id);
const formalOutputs=(id:string)=>Object.entries(formalEvaluatorOwners).filter(([,owner])=>owner===id).map(([metric])=>metric);
const extraOutputs:Record<string,string[]>={
    'tool-recall':['case-required-capabilities'],'tool-precision':['case-forbidden-capabilities','tool-selection'],
    'max-tool-calls':['case-max-tool-calls'],'evidence-presence':['case-evidence-required'],
    'fact-check':['fact-check/required-skills','fact-check/forbidden-skills','skill-selection','progressive-reading'],
    'subagent-contract':['fact-check/required-subagent-roles']};

export const deterministicEvaluatorDefinitions:EvaluatorDefinition[]=[
    ...definitions.map(def=>({...def,outputs:[def.id,...formalOutputs(def.id),...(extraOutputs[def.id]??[])],
        phase:(def.id==='task-result'?'final':'local') as 'final'|'local',
        appliesTo:def.appliesTo??(()=>true),
        evaluateMany:(context:EvaluationContext)=>[...constraintsFor(context,def.id),...formalScoresFor(context,[...formalOutputs(def.id),...(extraOutputs[def.id]??[])],def.id)]})),
    ...diagnosticEvaluatorIds.map(id=>({id,name:id,kind:'deterministic' as const,version:1,phase:'local' as const,
        outputs:['diagnostic-'+id,...formalOutputs(id),...(extraOutputs[id]??[])],
        appliesTo:(context:EvaluationContext)=>applies(context,id),
        evidence:()=>id==='latency-budget'?['execution.startedAt','execution.endedAt']:['tool-evidence','runs',...formalEvidence(formalOutputs(id))],
        evaluate:(context:EvaluationContext)=>evaluateDiagnostic(context,id)??{value:null,status:'NOT_APPLICABLE' as const,reason:'No declared diagnostic requirement'},
        evaluateMany:(context:EvaluationContext)=>{
            const diagnostic=evaluateDiagnostic(context,id);
            return[...(diagnostic?[diagnostic]:[]),...constraintsFor(context,id),...formalScoresFor(context,[...formalOutputs(id),...(extraOutputs[id]??[])],id)];
        }})),
    ...['runtime-admission','result-delivery','candidate-idempotency','context-delivery','subagent-contract','research-f1'].map(id=>{
        const evaluateMany=(context:EvaluationContext)=>{
            if(id==='research-f1'){
                const plan='contract'in context.task?context.task.expected.metrics.find(m=>m.metricId==='DR03'):undefined;
                if(plan?.notApplicable){const metric=formalMetric('DR03');return[{metricId:metric.id,name:metric.name,version:metric.version,
                    method:'deterministic' as const,required:false,value:null,status:'NOT_APPLICABLE' as const,reason:plan.notApplicable,
                    evidence:['research','gold-research'],statistics:{unit:metric.unit,numerator:null,denominator:null,missing:null}}];}
                const score=deriveResearchF1('contract'in context.task?context.task.expected.metrics:undefined,context.gradedScores??[],context.result);
                return score?[score]:[];
            }
            return[...constraintsFor(context,id),...formalScoresFor(context,formalOutputs(id),id)];
        };
        return{id,name:id,kind:'deterministic' as const,version:1,phase:(id==='research-f1'?'derived':'local') as 'derived'|'local',
            outputs:[...formalOutputs(id),...(extraOutputs[id]??[])],appliesTo:(context:EvaluationContext)=>applies(context,id),
            evidence:()=>id==='research-f1'?['score:DR01','score:DR02']:formalEvidence(formalOutputs(id)),evaluateMany,
            evaluate(context:EvaluationContext,check:Parameters<EvaluatorDefinition['evaluate']>[1]){
                const scores=evaluateMany(context),score=scores.find(s=>s.metricId===check.metric)??scores[0];
                return score??{value:null,status:'NOT_APPLICABLE' as const,reason:'No declared metric for this evaluator'};
            }};
    })
];
