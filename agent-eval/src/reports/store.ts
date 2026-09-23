import { readFileSync, writeFileSync, renameSync } from 'node:fs';
import { join } from 'node:path';
import type { CaseExecutionResult, GradeStatus } from '../types.ts';
import type { EvaluationScore, JudgeCall } from '../scoring/types.ts';
export type TrialReport = {
    caseId: string;
    caseVersion: number;
    caseHash: string;
    caseName: string;
    category: string;
    partition: 'smoke' | 'holdout';
    repetition: number;
    trialId: string;
    traceId: string;
    status: GradeStatus;
    reason: string;
    counts: Record<string, number>;
    execution: CaseExecutionResult | null;
    scores: EvaluationScore[];
    judgeCalls: JudgeCall[];
    feedback: 'none';
};
export type LocalReport = {
    contract: 'flowmate-agent-run/v1';
    executionId: string;
    code?: {
        commit: string;
        workspaceHash: string;
        release: string;
        dirty: boolean;
    };
    userId?: string;
    dataset: {
        id: string;
        version: number;
        hash: string;
        subject: 'agent';
    };
    selection: 'smoke' | 'full' | 'case';
    environment: string;
    startedAt: string;
    endedAt: string | null;
    repeat: number;
    executionComplete: boolean;
    scoring: 'pending' | 'complete';
    manualReview: 'none';
    formalAcceptance: 'not-assessed';
    scoringConfiguration: {
        version: number;
        judgeMode: 'off' | 'auto' | 'required';
        judgeHash: string | null;
    };
    trials: TrialReport[];
    export: {
        backend: 'local' | 'langfuse';
        status: 'disabled' | 'pending' | 'complete' | 'error';
        error?: string;
        url?: string;
    };
};
export function safeId(value: string) {
    if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(value))
        throw new Error('Invalid execution ID');
    return value;
}
export function reportPath(repo: string, id: string) { return join(repo, 'agent-eval/runs', safeId(id), 'summary.json'); }
export function saveReport(path: string, report: LocalReport) { writeFileSync(path + '.tmp', JSON.stringify(report, null, 2) + '\n'); renameSync(path + '.tmp', path); }
export function readReport(path: string): LocalReport {
    const report = JSON.parse(readFileSync(path, 'utf8'));
    if (report.contract !== 'flowmate-agent-run/v1')
        throw new Error('Historical report is read-only; no regrading or new export');
    return report;
}
export function exitCode(report: LocalReport) {
    if (report.trials.some(t => ['FAIL', 'ERROR', 'NOT_RUN'].includes(t.status)))
        return 1;
    if (report.scoring === 'pending' || report.trials.some(t => t.scores.some(s => s.required && s.status === 'NOT_RUN')))
        return 2;
    return !report.executionComplete || !report.trials.length || report.trials.some(t => t.status !== 'PASS') ? 1 : 0;
}
export function summary(report: LocalReport) {
    const count = (trials: TrialReport[]) => ({ planned: trials.length, started: trials.filter(t => t.execution?.started).length,
        completed: trials.filter(t => t.execution?.status === 'completed' && t.execution.endpointReached).length,
        statuses: Object.fromEntries(['PASS', 'FAIL', 'UNJUDGEABLE', 'ERROR', 'NOT_RUN'].map(s => [s, trials.filter(t => t.status === s).length])) });
    return { all: count(report.trials), smoke: count(report.trials.filter(t => t.partition === 'smoke')), holdout: count(report.trials.filter(t => t.partition === 'holdout')) };
}
export function comparison(left: LocalReport, right: LocalReport) {
    if (left.dataset.hash !== right.dataset.hash || left.repeat !== right.repeat || left.environment !== right.environment ||
        JSON.stringify(left.scoringConfiguration) !== JSON.stringify(right.scoringConfiguration))
        throw new Error('Comparison requires identical data, scoring configuration, environment and repeat plan');
    const signature = (r: LocalReport) => r.trials.map(t => [t.caseId, t.caseHash, t.repetition, t.scores.map(s => [s.metricId, s.version, s.required, s.method])]);
    if (JSON.stringify(signature(left)) !== JSON.stringify(signature(right)))
        throw new Error('Scoring versions or members differ');
    return left.trials.map((t, i) => ({ caseId: t.caseId, repetition: t.repetition, before: t.status, after: right.trials[i]!.status }));
}
