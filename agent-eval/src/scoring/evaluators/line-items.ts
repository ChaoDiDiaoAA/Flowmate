import { verdict, type EvaluatorDefinition } from '../types.ts';
import { candidateValues, invoiceValueEquals } from './invoice-values.ts';
const normalize = (value: unknown) => {
    if (typeof value !== 'string')
        return value;
    return value.trim().replace(/\s+/g, ' ');
};
export const definition: EvaluatorDefinition = {
    id: 'line-items', name: '明细一对一完整性', kind: 'deterministic', version: 1,
    evidence: (_,context) => ['candidate-line-items',...(context.result.evidence['candidate-values']?['candidate-values']:[])],
    evaluate: (context) => {
        const {task,result}=context;
        const gold = task.expected.reference?.lineItems;
        if (task.expected.reference?.status !== 'verified' || !gold?.length)
            return { value: null, status: 'UNJUDGEABLE', reason: '逐行参考未核验' };
        const rows = result.evidence['candidate-line-items']!.actual;
        if (!Array.isArray(rows) || rows.some(r => !r || typeof r !== 'object'))
            return { value: null, status: 'UNJUDGEABLE', reason: '明细证据结构缺失' };
        const used = new Set<number>();
        const original=candidateValues(context);
        if(original&&(original.lines.length!==rows.length||gold.some(wanted=>Object.keys(wanted).some(key=>
            original.lines.some(line=>!Object.hasOwn(line,key))))))
            return {value:null,status:'UNJUDGEABLE',reason:'原始明细状态证据与显示行或字段不对应'};
        let tp = 0;
        for (const wanted of gold) {
            const at = rows.findIndex((row, i) => !used.has(i) && Object.entries(wanted).every(([key, v]) =>
                invoiceValueEquals(key,normalize(row[key]),normalize(v),original?.lines[i]?.[key as keyof typeof original.lines[number]])));
            if (at >= 0) {
                used.add(at);
                tp++;
            }
        }
        const fp = rows.length - tp, fn = gold.length - tp;
        return verdict(fp === 0 && fn === 0, '逐行唯一匹配；漏行和重复行不能抵消', { tp, fp, fn, precision: rows.length ? tp / rows.length : null, recall: tp / gold.length }, gold);
    }
};
