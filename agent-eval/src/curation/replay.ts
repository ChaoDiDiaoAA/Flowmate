import { randomUUID } from 'node:crypto';
import { candidateSchema } from './schemas.ts';
import { readTrace, candidateDirectory } from './store.ts';
import { expandCandidate } from './expansion.ts';
import { resolveCandidateCase } from './publication.ts';
import { runLocal } from '../execution/runner.ts';
import type { Replay } from './validation.ts';
import { isRequiredScore } from '../scoring/types.ts';

type ReplayDependencies = Pick<NonNullable<Parameters<typeof runLocal>[2]>, 'preparedAgent' | 'preparedJudge' | 'fetcher'>;
export function createControlledReplay(repo: string, env?: NodeJS.ProcessEnv, dependencies: ReplayDependencies = {}): Replay {
  return async ({ candidate: value, signal }) => {
    const candidate = candidateSchema.parse(value);
    if (!candidate.scenario || !candidate.case || candidate.scenario.setup || candidate.scenario.selection.enabledExtensions.length)
      throw Error('Controlled replay requires a validated isolated data scenario');
    const actions = new Set(['user-message', 'invoice-message', 'select-candidate', 'research-plan', 'research-confirm', 'research-replay']);
    if (candidate.scenario.steps.some(step => !actions.has(step.action))) throw Error('External effects cannot be replayed');
    const trace = readTrace(repo, candidate.traceRef.id);
    if (trace.revision !== candidate.traceRef.revision || !trace.complete || trace.gaps.length) throw Error('Replay source is incomplete or stale');
    const target = resolveCandidateCase(repo, candidate, trace);
    const dataset = expandCandidate(repo, candidate, trace, target.caseId ?? 'FM-063', 'candidate-replay', 1,
      candidateDirectory(repo, candidate.kind, candidate.id), false, target.caseVersion, target.goldFiles, target.formalCase);
    const { report, file, stopped } = await runLocal(repo, { dataset, backend: 'local', judge: 'required', repeat: 1,
      executionId: 'candidate-replay-' + randomUUID(), config: { controlledReplay: true } }, { ...dependencies, env, signal });
    const trial = report.trials[0], execution = trial?.execution, required = trial?.scores.filter(isRequiredScore) ?? [];
    let status: 'PASS' | 'FAIL' | 'ERROR' | 'NOT_RUN';
    if (report.trials.length !== 1 || !execution?.started) status = 'NOT_RUN';
    else if (stopped || !report.executionComplete || report.scoring !== 'complete' || report.sourceInvalidation || execution.error?.infrastructure ||
      ['cancelled', 'timeout', 'error', 'not-started'].includes(execution.status) || ['ERROR', 'UNJUDGEABLE'].includes(trial.status)) status = 'ERROR';
    else if (trial.status === 'NOT_RUN') status = 'NOT_RUN';
    else if (required.some(score => !['PASS', 'FAIL'].includes(score.status))) status = 'ERROR';
    else if (execution.status === 'completed' && trial.status === 'PASS') status = 'PASS';
    else if (execution.status === 'completed' && trial.status === 'FAIL' && required.some(score => score.status === 'FAIL')) status = 'FAIL';
    else status = 'ERROR';
    return { status, kind: 'controlled',
      reason: status === 'PASS' ? 'Actual isolated Host replay passed required assertions.' : status === 'FAIL' ? 'Actual started replay reproduced a measured quality failure.' :
        (status === 'NOT_RUN' ? 'Replay was not executed: ' : 'Replay execution or scoring is incomplete: ') + (trial?.reason ?? 'No original Trial'),
      evidence: { executionId: report.executionId, report: file, stopped, executionComplete: report.executionComplete, scoring: report.scoring,
        sourceInvalidation: report.sourceInvalidation ?? null, trials: report.trials.map(trial => ({ trialId: trial.trialId, status: trial.status,
          started: trial.execution?.started ?? false, executionStatus: trial.execution?.status ?? null, error: trial.execution?.error ?? null, reason: trial.reason,
          requiredScores: trial.scores.filter(isRequiredScore).map(score => ({ metricId: score.metricId, status: score.status })) })) } };
  };
}
