import { verdict, type EvaluatorDefinition } from '../types.ts';
import { candidateValues, invoiceValueEquals } from './invoice-values.ts';
export const definition: EvaluatorDefinition = {
    id: 'reference-fields', name: '核验字段一致性', kind: 'deterministic', version: 1,
    evidence: (_,context) => ['candidate-fields',...(context.result.evidence['candidate-values']?['candidate-values']:[])],
    evaluate: (context) => {
        const {task,result}=context;
        if (task.expected.reference?.status !== 'verified')
            return { value: null, status: 'UNJUDGEABLE', reason: '参考字段尚未独立核验，不能作为 Gold' };
        const actual = result.evidence['candidate-fields']!.actual as Record<string, unknown>;
        const original=candidateValues(context);
        if(original&&Object.keys(task.expected.reference.fields).some(key=>!Object.hasOwn(original.fields,key)))
            return {value:null,status:'UNJUDGEABLE',reason:'原始字段状态证据未覆盖参考字段'};
        return verdict(!!actual && Object.entries(task.expected.reference.fields).every(([k, v]) => invoiceValueEquals(k,actual[k],v,original?.fields[k as keyof typeof original.fields])),
            '按可见材料与字段状态核验；合法十进制精确等价', actual, task.expected.reference.fields);
    }
};
