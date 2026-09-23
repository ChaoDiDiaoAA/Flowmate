import { verdict, type EvaluatorDefinition } from '../types.ts';
const normalize = (key: string, value: unknown) => {
    if (typeof value !== 'string')
        return value;
    const text = value.trim().replace(/\s+/g, ' ');
    // This first rubric uses declared decimal strings; it never rounds binary floats.
    return ['quantity', 'unitPrice', 'netAmount', 'grossAmount'].includes(key) ? text.replace(/ /g, '').replace(',', '.') : text;
};
export const definition: EvaluatorDefinition = {
    id: 'line-items', name: '明细一对一完整性', kind: 'deterministic', version: 1, evidence: () => ['candidate-line-items'],
    evaluate: ({ task, result }) => {
        const gold = task.expected.reference?.lineItems;
        if (task.expected.reference?.status !== 'verified' || !gold?.length)
            return { value: null, status: 'UNJUDGEABLE', reason: '逐行参考未核验' };
        const rows = result.evidence['candidate-line-items']!.actual;
        if (!Array.isArray(rows) || rows.some(r => !r || typeof r !== 'object'))
            return { value: null, status: 'UNJUDGEABLE', reason: '明细证据结构缺失' };
        const used = new Set<number>();
        let tp = 0;
        for (const wanted of gold) {
            const at = rows.findIndex((row, i) => !used.has(i) && Object.entries(wanted).every(([key, v]) => normalize(key, row[key]) === normalize(key, v)));
            if (at >= 0) {
                used.add(at);
                tp++;
            }
        }
        const fp = rows.length - tp, fn = gold.length - tp;
        return verdict(fp === 0 && fn === 0, '逐行唯一匹配；漏行和重复行不能抵消', { tp, fp, fn, precision: rows.length ? tp / rows.length : null, recall: tp / gold.length }, gold);
    }
};
