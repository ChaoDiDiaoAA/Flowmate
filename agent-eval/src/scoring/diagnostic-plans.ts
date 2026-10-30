import {z} from 'zod';
import {diagnosticPlanSchema,diagnosticMetricCatalog} from './diagnostics.ts';
import {formalMetric,metricCatalog,type MetricDefinition} from './catalog.ts';

const count=z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);
export const semanticDiagnosticPlanSchema=z.object({
    evaluatorId:z.enum(['diagnostic-partial-failure-explanation','diagnostic-recovery-strategy','task-judge','tool-use-judge']),required:z.boolean(),reason:z.string().trim().min(1),
    params:z.object({metricId:z.enum(['diagnostic-partial-failure-explanation','diagnostic-recovery-strategy']),
        denominator:count.nullable(),evidence:z.array(z.string().trim().min(1)).min(1).refine(v=>new Set(v).size===v.length,'Duplicate evidence')}).strict()
}).strict().refine(p=>p.evaluatorId===p.params.metricId||p.evaluatorId===(p.params.metricId==='diagnostic-partial-failure-explanation'?'task-judge':'tool-use-judge'),'Diagnostic needs its responsible semantic evaluator');
export const caseDiagnosticsSchema=z.array(z.union([diagnosticPlanSchema,semanticDiagnosticPlanSchema])).refine(
    items=>new Set(items.map(item=>'metricId' in item.params?item.params.metricId:item.evaluatorId)).size===items.length,'Duplicate diagnostic evaluator');
export const semanticDiagnosticCatalog:readonly MetricDefinition[]=[
    {id:'diagnostic-partial-failure-explanation',name:'部分失败说明诚实性',unit:'披露机会'},
    {id:'diagnostic-recovery-strategy',name:'恢复策略合理性',unit:'恢复决策'}
].map(m=>({...m,version:1,group:'diagnostic',direction:'up',numerator:'符合要求机会',denominator:'适用机会',formula:'符合要求机会 / 适用机会'}));
export const scoringMetric=(id:string)=>metricCatalog.some(m=>m.id===id)?formalMetric(id):
    [...diagnosticMetricCatalog,...semanticDiagnosticCatalog].find(m=>m.id===id)??(()=>{throw Error('Unknown scoring metric: '+id);})();
