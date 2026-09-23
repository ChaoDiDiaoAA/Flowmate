import type { LocalCase, Check } from '../datasets/local.ts';
import type { CaseExecutionResult, GradeStatus } from '../types.ts';
import type { JudgeConfig, Fetcher } from './judges/client.ts';
import type { runJudge } from './judges/harness.ts';
export type EvaluatorKind = 'deterministic' | 'llm-judge';
export type JudgeCall = Awaited<ReturnType<typeof runJudge>>;
export type EvaluationScore = {
    metricId: string;
    name: string;
    version: number;
    method: EvaluatorKind;
    required: boolean;
    value: number | null;
    status: GradeStatus | 'NOT_APPLICABLE';
    reason: string;
    evidence: string[];
    actual?: unknown;
    expected?: unknown;
};
export type EvaluationContext = {
    task: LocalCase;
    result: CaseExecutionResult;
    projected: CaseExecutionResult['input'];
    judge: JudgeConfig | null;
    fetcher?: Fetcher;
};
export type EvaluationValue = {
    value: number | null;
    status: EvaluationScore['status'];
    reason: string;
    actual?: unknown;
    expected?: unknown;
    call?: JudgeCall;
};
export type EvaluatorDefinition = {
    id: string;
    name: string;
    kind: EvaluatorKind;
    version: number;
    appliesTo?: (context: EvaluationContext, check: Check) => boolean;
    evidence: (check: Check, context: EvaluationContext) => string[];
    evaluate: (context: EvaluationContext, check: Check) => EvaluationValue | Promise<EvaluationValue>;
};
export const verdict = (ok: boolean, reason: string, actual?: unknown, expected?: unknown): EvaluationValue => ({ value: ok ? 1 : 0, status: ok ? 'PASS' : 'FAIL', reason, actual, expected });
