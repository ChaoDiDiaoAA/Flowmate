import type { LocalCase, Check } from '../dataset-loader/local.ts';
import type { CaseExecutionResult, GradeStatus } from '../types.ts';
import type { JudgeConfig, Fetcher } from './judges/client.ts';
import type { runJudge } from './judges/harness.ts';
import type { CompactPlan } from './judges/compact.ts';
import type { CalibrationReport } from './judges/calibration.ts';
import type { EvaluationCalibrationView } from '../../../packages/contracts/src/evaluation.ts';
export type EvaluatorKind = 'deterministic' | 'llm-judge';
type CurrentJudgeCall = Omit<Awaited<ReturnType<typeof runJudge>>, 'transportStatus'> & {transportStatus?:number|null};
type LegacyJudgeCall = Omit<CurrentJudgeCall, 'configuration' | 'stopReason' | 'rawStopReason' | 'usageSource' | 'responseComplete' | 'request' | 'compact'> & {
    configuration: Omit<Extract<CurrentJudgeCall['configuration'], { sdk: unknown }>, 'api' | 'sdk' | 'modelCapabilities' | 'protocolVersion'> & {
        provider: 'anthropic' | 'openai-compatible'; api?: never; sdk?: never;  temperature?: number; maxTokens?: number;
        protocolVersion?: string;
        modelCapabilities?: { modelId: string; maxOutputTokens: number; source: 'anthropic-models-api' | 'deepseek-models-api' };
    };
    stopReason?: never; rawStopReason?: never; usageSource?: never; finishReason?: string | null; responseComplete?: boolean;
    request?: CurrentJudgeCall['request']; compact?: CurrentJudgeCall['compact'];
};
export type JudgeCall = CurrentJudgeCall & { finishReason?: never } | LegacyJudgeCall;
export type MetricStatistics = { unit: string; numerator: number | null; denominator: number | null; missing: number | null };
export type MetricPlan = { metricId: string; version: number; unit: string; denominator?: number | null; notApplicable?: string };
export type EvaluationScore = {
    evaluatorId?: string;
    evaluatorVersion?: number;
    category?: 'formal' | 'diagnostic' | 'guardrail';
    applicabilityReason?: string;
    metricId: string;
    name: string;
    version: number;
    method: EvaluatorKind;
    required: boolean;
    value: number | null;
    status: GradeStatus | 'NOT_APPLICABLE';
    reason: string;
    evidence: string[];
    statistics?: MetricStatistics;
    judge?: { callId: string; criterion: number };
    calibration?: EvaluationCalibrationView;
    actual?: unknown;
    expected?: unknown;
};
export const isRequiredScore=(score:EvaluationScore)=>score.required&&score.status!=='NOT_APPLICABLE'&&
    !(score.statistics?.numerator===0&&score.statistics.denominator===0&&score.statistics.missing===0);
/** Evaluator provenance is additive; original wire/count validators compare the measurement itself. */
export function scoreMeasurement(score:EvaluationScore|undefined){
    if(!score)return score;
    const {evaluatorId:_,evaluatorVersion:__,category:___,applicabilityReason:____,calibration:_____,...measurement}=score;
    return measurement;
}
export type EvaluationContext = {
    gradedScores?: readonly EvaluationScore[];
    task: LocalCase;
    result: CaseExecutionResult;
    projected: CaseExecutionResult['input'];
    judge: JudgeConfig | null;
    fetcher?: Fetcher;
    signal?: AbortSignal;
    semanticRequired?: boolean;
    semanticPlan?: CompactPlan;
    calibration?: CalibrationReport;
};
export type EvaluationValue = {
    value: number | null;
    status: EvaluationScore['status'];
    reason: string;
    actual?: unknown;
    expected?: unknown;
    call?: JudgeCall;
    statistics?: MetricStatistics;
};
export type EvaluatorDefinition = {
    id: string;
    name: string;
    kind: EvaluatorKind;
    version: number;
    outputs?: readonly string[];
    phase?: 'checks' | 'local' | 'semantic' | 'derived' | 'final';
    evaluateMany?: (context: EvaluationContext) => EvaluationScore[] | Promise<EvaluationScore[]>;
    rubric?: { id: string; version: number; instructions: string };
    prepare?: (context: EvaluationContext) => CompactPlan['criteria'];
    parse?: (scores: readonly EvaluationScore[]) => EvaluationScore[];
    appliesTo?: (context: EvaluationContext, check: Check) => boolean;
    evidence: (check: Check, context: EvaluationContext) => string[];
    evaluate: (context: EvaluationContext, check: Check) => EvaluationValue | Promise<EvaluationValue>;
};
export type ScoringFacts = Omit<EvaluationContext, 'judge' | 'fetcher' | 'signal' | 'calibration'>;
/** A definition prepares and validates one metric; only the Trial harness owns transport. */
export type SemanticMetricDefinition = Omit<EvaluatorDefinition, 'kind' | 'outputs' | 'prepare' | 'parse' | 'appliesTo' | 'evaluate' | 'evaluateMany' | 'evidence'> & {
    kind: 'llm-judge';
    domain: string;
    outputs: readonly [string];
    rubric: { id: string; version: number; instructions: string };
    prepare: (facts: ScoringFacts) => CompactPlan['criteria'];
    appliesTo: (facts: ScoringFacts) => boolean;
    parseResult: (score: EvaluationScore) => EvaluationScore;
    evidence: (check: Check, facts: ScoringFacts) => string[];
    evaluateMany: (facts: ScoringFacts) => EvaluationScore[];
    evaluate: (facts: ScoringFacts, check: {metric: string; required: boolean}) => EvaluationValue;
};
export const verdict = (ok: boolean, reason: string, actual?: unknown, expected?: unknown): EvaluationValue => ({ value: ok ? 1 : 0, status: ok ? 'PASS' : 'FAIL', reason, actual, expected });
