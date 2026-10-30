import type { SemanticMetricDefinition, ScoringFacts, EvaluationScore } from '../types.ts';
import { evaluateFormalMetrics } from '../evaluators/formal.ts';
import { scoringMetric } from '../diagnostic-plans.ts';

export function defineSemanticMetric(id: string, domain: string, version: number, instructions: string): SemanticMetricDefinition {
    const metric = scoringMetric(id);
    const prepare = (facts: ScoringFacts) => {
        const plan = facts.semanticPlan ?? ('contract' in facts.task ? facts.task.expected.semantic : undefined);
        return plan?.criteria.filter(c => c.metricId === id && (!('contract' in facts.task) ||
            !facts.task.expected.metrics.find(m => m.metricId === id)?.notApplicable)) ?? [];
    };
    const parseResult = (score: EvaluationScore): EvaluationScore => {
        if (score.metricId !== id || score.version !== metric.version) throw Error('Result does not belong to evaluator: ' + id);
        return { ...score, evaluatorId: id, evaluatorVersion: version };
    };
    const evaluateMany = (facts: ScoringFacts): EvaluationScore[] => {
        if (facts.gradedScores?.some(s => s.metricId === id)) return [];
        const ordinary = evaluateFormalMetrics({ ...facts, judge: null }).filter(s => s.metricId === id);
        if (ordinary.length) return ordinary.map(parseResult);
        const declared = 'contract' in facts.task ? facts.task.expected.metrics.find(m => m.metricId === id) : undefined;
        const diagnostic = facts.task.expected.diagnostics?.find(d => 'metricId' in d.params && d.params.metricId === id);
        if (!declared && !diagnostic) return [];
        const plan = prepare(facts)[0];
        const denominator = declared?.denominator ?? (diagnostic && 'denominator' in diagnostic.params ? diagnostic.params.denominator : null);
        return [parseResult({ metricId: id, name: metric.name, version: metric.version, method: 'llm-judge',
            required: declared ? !declared.notApplicable : diagnostic?.required ?? plan?.required ?? false, value: null,
            status: declared?.notApplicable ? 'NOT_APPLICABLE' : facts.result.error?.infrastructure ? 'ERROR' : 'NOT_RUN',
            reason: declared?.notApplicable ?? 'Declared semantic metric has not been executed by the Trial harness',
            evidence: plan?.evidence ?? (diagnostic && 'evidence' in diagnostic.params ? diagnostic.params.evidence : ['research', 'gold-research']),
            statistics: { unit: metric.unit, numerator: null, denominator: denominator ?? null, missing: denominator ?? null } })];
    };
    return { id, name: metric.name, domain, kind: 'llm-judge', version, outputs: [id], phase: 'semantic',
        rubric: { id, version, instructions }, prepare, parseResult, evaluateMany,
        appliesTo: facts => prepare(facts).length > 0,
        evidence: (_check, facts) => [...new Set(prepare(facts).flatMap(c => c.evidence))],
        evaluate: (facts, check) => facts.gradedScores?.find(s => s.metricId === id) ?? evaluateMany(facts)[0] ??
            { value: null, status: 'NOT_APPLICABLE', reason: 'Metric not selected by the Case: ' + check.metric } };
}
