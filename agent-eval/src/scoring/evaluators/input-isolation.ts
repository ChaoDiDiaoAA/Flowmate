import { isDeepStrictEqual } from 'node:util';
import { verdict, type EvaluatorDefinition } from '../types.ts';
export const definition: EvaluatorDefinition = {
    id: 'input-isolation', name: '实际输入与投影一致', kind: 'deterministic', version: 1, evidence: () => ['input-projection'],
    evaluate: ({ result, projected }) => verdict(isDeepStrictEqual(result.input, projected) && isDeepStrictEqual(result.evidence['input-projection']!.actual, projected), '核对实际投递；Gold/控制/未来消息不可提前投递')
};
