import { isDeepStrictEqual } from 'node:util';
import { verdict, type EvaluatorDefinition } from '../types.ts';
/** Paths address trusted snapshots only, never files or scripts. Undefined != false. */
export const definition: EvaluatorDefinition = {
    id: 'fact-check', name: '任务必要事实', kind: 'deterministic', version: 2,
    evidence: c => [...(c.evidence ? [c.evidence] : []), ...(c.compareTo ? [c.compareTo.evidence] : [])],
    evaluate: ({ result }, check) => {
        const read = (evidence: string, path: (string | number)[]) => {
            let value = result.evidence[evidence]?.actual;
            for (const key of path) {
                if (value === null || typeof value !== 'object' || !Object.prototype.hasOwnProperty.call(value, key)) return undefined;
                value = (value as Record<string, unknown>)[key];
            }
            return value;
        };
        const actual = read(check.evidence!, check.path ?? []);
        const wanted = check.compareTo ? read(check.compareTo.evidence, check.compareTo.path) : check.equals;
        if (actual === undefined || wanted === undefined || (check.compareTo && (actual === null || wanted === null)))
            return { value: null, status: 'UNJUDGEABLE', reason: '必要事实值或比较对象未采集' };
        if (check.operator === 'includes' && !Array.isArray(actual))
            return { value: null, status: 'UNJUDGEABLE', reason: '集合证据结构缺失' };
        const matches = check.operator === 'includes' ? (actual as unknown[]).some(v => isDeepStrictEqual(v, wanted)) : isDeepStrictEqual(actual, wanted);
        return verdict(matches, check.description ?? '比较可信产物/状态快照中的必要事实', actual, wanted);
    }
};
