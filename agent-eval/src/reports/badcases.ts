import { isDeepStrictEqual } from 'node:util';
import { basename, dirname, join } from 'node:path';
import type { LocalReport } from './store.ts';
import type { Feedback } from '../review/local.ts';
import { scanEvidence } from '../execution/evidence-safety.ts';
import type { EvaluationScore } from '../scoring/types.ts';
import { atomicJson, atomicText } from './files.ts';
import { archiveFile, archiveReference, isArchiveReference, writeArchivePart } from './archive.ts';
import type { CalibrationReport } from '../scoring/judges/calibration.ts';
import { compactScores } from '../scoring/judges/compact.ts';

type Node = 'task-input' | 'context-delivery' | 'provider-runtime' | 'tool-execution' | 'commit-output' | 'evidence-scoring' | 'summary-review-export';
type EvidenceRef = { file: string; jsonPointer: string; nodeId?: string };
type Signal = { kind: string; node: Node; reason: string; metricIds: string[]; evidence: EvidenceRef[] };
type Candidate = {
    id: string; caseId?: string; caseVersion?: number; trialId?: string; repetition?: number; sampleId?: string;
    originalStatus: string; status: 'pending-review'; primaryCause: null;
    scores: Array<Pick<EvaluationScore, 'metricId' | 'status' | 'required'>>; signals: Signal[]; gaps: string[];
};
export type BadcaseIndex = {
    contract: 'flowmate-badcase-index/v1';
    source: { kind: 'execution' | 'calibration'; executionId: string; file: string; datasetId?: string };
    summary: { candidates: number; confirmed: 0 }; candidates: Candidate[];
};
const short = (value: string) => scanEvidence(value).value.replace(/[\r\n\t]/g, ' ').slice(0, 240);
const pointer = (value: string) => value.replace(/~/g, '~0').replace(/\//g, '~1');
function metricNode(metric: string): Node {
    if (/input|material/.test(metric)) return 'task-input';
    if (/context|skill|history|compaction/.test(metric)) return 'context-delivery';
    if (/tool|retry|cancellation|subtask/.test(metric)) return 'tool-execution';
    if (/judge|DR0[1-6]/.test(metric)) return 'evidence-scoring';
    return 'commit-output';
}
export function deriveBadcases(report: LocalReport, options: {
    file?: string; feedback?: Feedback[];
    comparison?: { executionId: string; trials: Array<{ caseId: string; repetition: number; before: string; after: string }> };
} = {}): BadcaseIndex {
    const inline = !!options.file && isArchiveReference(options.file);
    const file = basename(archiveFile(options.file ?? 'report.json')), candidates: Candidate[] = [];
    for (const [index, trial] of report.trials.entries()) {
        if (trial.status === 'NOT_RUN' && trial.reason === 'Planned' && !trial.execution) continue;
        const prefix = `evidence/${trial.trialId}/`, observation = prefix + 'observation.json';
        const signal = (kind: string, node: Node, reason: string, metricIds: string[] = [], evidence: EvidenceRef[] = [{ file, jsonPointer: `/trials/${index}` }]) =>
            signals.push({ kind, node, reason: short(reason), metricIds, evidence });
        const signals: Signal[] = [], execution = trial.execution;
        if (['FAIL', 'ERROR', 'UNJUDGEABLE', 'NOT_RUN'].includes(trial.status))
            signal(trial.status === 'NOT_RUN' ? 'blocked-trial' : 'trial-' + trial.status.toLowerCase(),
                trial.status === 'ERROR' || trial.status === 'UNJUDGEABLE' ? 'evidence-scoring' : 'commit-output', trial.reason);
        const gaps = [...new Set(trial.scores.flatMap(score => score.evidence.filter(key =>
            !key.startsWith('gold-') && key !== 'research-frame' && !key.startsWith('judge-') && execution && !execution.evidence[key]?.present)))];
        for (const [scoreIndex,score] of trial.scores.entries()) if (['FAIL', 'ERROR', 'UNJUDGEABLE'].includes(score.status))
            signal(score.method === 'llm-judge' && score.status === 'ERROR' ? 'judge-error' : 'metric-' + score.status.toLowerCase(),
                score.method === 'llm-judge' && score.status === 'ERROR' ? 'evidence-scoring' : metricNode(score.metricId), score.reason, [score.metricId],
                [{ file: observation, jsonPointer: '/scoringFacts/'+scoreIndex, nodeId: 'metric:' + score.metricId },
                    ...score.evidence.filter(key => execution?.evidence[key]).map(key => ({ file: observation, jsonPointer: '/evidence/' + pointer(key) }))]);
        for (const [callIndex, call] of trial.judgeCalls.entries()) if (call.error || Object.keys(call.compact?.validationErrors ?? {}).length)
            signal('judge-error', 'evidence-scoring', call.error ?? 'Judge metric validation failed',
                Object.keys(call.compact?.validationErrors ?? {}), [{ file: observation, jsonPointer: `/judgeCalls/${callIndex}`, nodeId: 'judgeCall:' + call.callId }]);
        if (execution?.error)
            signal(execution.error.infrastructure ? 'infrastructure-error' : 'execution-error', 'provider-runtime', execution.error.code,
                [], [{ file: prefix + 'trial.json', jsonPointer: '/error' }]);
        if (execution?.status === 'completed' && !execution.endpointReached)
            signal('endpoint-not-reached', 'commit-output', 'Run completed; required business endpoint was not reached', [], [{ file: prefix + 'trial.json', jsonPointer: '/endpointReached' }]);
        if (execution?.evidence['capture-gaps']?.present === false) {
            gaps.push('capture-gaps'); signal('capture-gap', 'evidence-scoring', 'Collection has recorded gaps', [], [{ file: observation, jsonPointer: '/evidence/capture-gaps' }]);
        }
        const tools = execution?.evidence.tools;
        if (tools?.present && Array.isArray(tools.actual)) for (const [toolIndex, tool] of tools.actual.entries()) {
            if (!tool || tool.status !== 'failed' || typeof tool.toolName !== 'string') continue;
            const recovered = tools.actual.slice(toolIndex + 1).some(next => next?.status === 'succeeded' && next.toolName === tool.toolName && next.runId === tool.runId);
            signal(recovered ? 'tool-recovery' : 'tool-failure', 'tool-execution',
                recovered ? 'A failed tool was followed by a successful same-name call in the same Run; recovery needs verification' : 'A tool failure was recorded; check whether it was expected',
                [], [{ file: observation, jsonPointer: `/evidence/tools/actual/${toolIndex}`, nodeId: 'toolCall:' + tool.toolCallId }]);
        }
        if (trial.status === 'PASS' && (trial.scores.some(score => score.required && ['FAIL', 'ERROR', 'UNJUDGEABLE', 'NOT_RUN'].includes(score.status)) || execution && !execution.endpointReached))
            signal('status-contradiction', 'summary-review-export', 'PASS conflicts with a required score or business endpoint');
        for (const feedback of options.feedback ?? []) if (feedback.kind === 'run-feedback' && feedback.executionId === report.executionId && feedback.trialId === trial.trialId &&
            feedback.caseId === trial.caseId && feedback.caseVersion === trial.caseVersion &&
            ((feedback.verdict === 'bad') === (trial.status === 'PASS')))
            signal('human-disagreement', 'summary-review-export', 'Actual bound feedback differs from automatic outcome', [], [{ file: 'review.json', jsonPointer: '/records', nodeId: feedback.id }]);
        if (options.comparison?.trials.some(row => row.caseId === trial.caseId && row.repetition === trial.repetition && row.before === 'PASS' && row.after === trial.status && row.after !== 'PASS'))
            signal('version-regression', 'summary-review-export', 'Comparable prior execution ' + options.comparison.executionId + ' passed');
        const siblings = report.trials.filter(other => other.caseId === trial.caseId && other.caseVersion === trial.caseVersion && other.reason !== 'Planned');
        if (siblings.some(other => other.status !== trial.status || !isDeepStrictEqual(other.scores.map(score => [score.metricId, score.status, score.value]), trial.scores.map(score => [score.metricId, score.status, score.value]))))
            signal('repeat-difference', 'summary-review-export', 'Repeated attempts under this execution differ; retain every attempt');
        if (report.sourceInvalidation)
            signal('source-invalidated', 'summary-review-export', report.sourceInvalidation.reason, [], [{ file, jsonPointer: '/sourceInvalidation' }]);
        if (inline) for (const item of signals) for (const evidence of item.evidence) {
            const root = '/executions/' + pointer(report.executionId), trialRoot = root + '/trials/' + index;
            if (evidence.file === observation) {
                evidence.file = file;
                evidence.jsonPointer = trialRoot + (evidence.jsonPointer.startsWith('/scoringFacts/') ? evidence.jsonPointer.replace('/scoringFacts/','/scores/') :
                    (evidence.jsonPointer.startsWith('/evidence') ? '/execution' : '') + evidence.jsonPointer);
            } else if (evidence.file === prefix + 'trial.json') {
                evidence.file = file; evidence.jsonPointer = trialRoot + '/execution' + evidence.jsonPointer;
            } else if (evidence.file === prefix + 'events.jsonl') {
                evidence.file = file; evidence.jsonPointer = trialRoot + '/execution/observations' + evidence.jsonPointer;
            } else if (evidence.file === 'review.json') evidence.file = '../../feedback.json';
            else if (evidence.file === file) evidence.jsonPointer = root + evidence.jsonPointer;
        }
        if (signals.length) candidates.push({ id: trial.trialId, caseId: trial.caseId, caseVersion: trial.caseVersion, trialId: trial.trialId, repetition: trial.repetition,
            originalStatus: trial.status, status: 'pending-review', primaryCause: null,
            scores: trial.scores.map(({ metricId, status, required }) => ({ metricId, status, required })), signals, gaps: [...new Set(gaps)] });
    }
    return { contract: 'flowmate-badcase-index/v1', source: { kind: 'execution', executionId: report.executionId, datasetId: report.dataset.id, file },
        summary: { candidates: candidates.length, confirmed: 0 }, candidates };
}

const markdown = (text: string) => short(text).replace(/[\\`*_{}[\]<>|]/g, '\\$&');
export function deriveCalibrationBadcases(report: CalibrationReport, file = 'summary.json'): BadcaseIndex {
    const candidates: Candidate[] = [];
    for (const [sampleIndex, sample] of report.samples.entries()) {
        if (!sample.call && report.endedAt === null) continue;
        const scores = sample.call ? compactScores(sample.call) : [], signals: Signal[] = [];
        const add = (kind: string, reason: string, metricIds: string[] = []) => signals.push({ kind, node: 'evidence-scoring', reason: short(reason), metricIds,
            evidence: [{ file: basename(file), jsonPointer: `/samples/${sampleIndex}`, nodeId: sample.call ? 'judgeCall:' + sample.call.callId : sample.id }] });
        if (!sample.call) add('blocked-calibration', 'Calibration ended before this reference was judged');
        else if (sample.call.error) add('judge-error', sample.call.error);
        for (const reference of sample.reference.references) {
            if(!(sample.plan??sample.reference.plan).criteria.some(c=>c.metricId===reference.metricId))continue;
            const score = scores.find(row => row.metricId === reference.metricId);
            if (!score) { if (sample.call) add('judge-error', 'Judge result omitted the reference metric', [reference.metricId]); continue; }
            if (score.status === 'ERROR') { add('judge-error', score.reason, [reference.metricId]); continue; }
            const statistics = score.statistics, values = statistics ? [statistics.numerator, statistics.denominator, statistics.missing] : null;
            const counts = values?.every(value => value === null) ? null : values;
            if (!isDeepStrictEqual(counts, reference.counts)) add('reference-count-mismatch', 'Judged counts differ from the independent reference', [reference.metricId]);
        }
        if (signals.length) candidates.push({ id: sample.id, sampleId: sample.id, originalStatus: !sample.call ? 'NOT_RUN' : sample.call.error || scores.some(score => score.status === 'ERROR') ? 'ERROR' :
            scores.some(score => score.status === 'FAIL') ? 'FAIL' : scores.some(score => score.status === 'UNJUDGEABLE') ? 'UNJUDGEABLE' : 'PASS',
            status: 'pending-review', primaryCause: null, scores: scores.map(({ metricId, status, required }) => ({ metricId, status, required })), signals, gaps: [] });
    }
    return { contract: 'flowmate-badcase-index/v1', source: { kind: 'calibration', executionId: report.executionId, file: basename(file) },
        summary: { candidates: candidates.length, confirmed: 0 }, candidates };
}
export function badcaseMarkdown(index: BadcaseIndex) {
    return [`# Badcase 待核验索引：${markdown(index.source.executionId)}`, '',
        `待核验记录 ${index.summary.candidates} 条；自动确认 Badcase 0 条。原成绩不变，信号及疑似节点需结合原证据核验。`, '',
        `来源：[${index.source.file}](${index.source.file})`, '',
        ...index.candidates.flatMap(candidate => [`## ${markdown(candidate.caseId ?? candidate.sampleId ?? candidate.id)} / ${markdown(candidate.trialId ?? candidate.id)}`, '',
            `原状态：${candidate.originalStatus}；复核状态：pending-review；主因：尚未确认。`, '',
            ...candidate.signals.map(signal => `- ${markdown(signal.kind)} · ${signal.node}：${markdown(signal.reason)}${signal.metricIds.length ? `（${signal.metricIds.join(', ')}）` : ''}\n  证据：${signal.evidence.map(ref => `[${ref.file}](${ref.file}) \`${ref.jsonPointer}\`${ref.nodeId ? ` (${markdown(ref.nodeId)})` : ''}`).join('；')}`), '',
            ...(candidate.gaps.length ? [`缺口：${candidate.gaps.map(markdown).join('、')}`, ''] : [])])].join('\n') + '\n';
}
export function saveBadcases(file: string, index: BadcaseIndex):
    { saved: true; json: string; markdown: string; count: number } | { saved: false; error: string } {
    try {
        if (isArchiveReference(file)) {
            const reference = archiveReference(archiveFile(file), 'diagnostics', index.source.executionId), scanned = scanEvidence(index);
            if ((scanned.fact.actual as { leaked: boolean }).leaked) throw Error('Diagnostic index contains protected data');
            writeArchivePart(reference, scanned.value);
            return { saved: true, json: reference, markdown: join(dirname(file), 'README.md'), count: index.summary.candidates };
        }
        const directory = dirname(file), json = join(directory, 'badcases.json'), markdown = join(directory, 'badcases.md');
        const scanned = scanEvidence(index);
        if ((scanned.fact.actual as { leaked: boolean }).leaked) throw Error('Diagnostic index contains protected data');
        atomicJson(json, scanned.value); atomicText(markdown, badcaseMarkdown(index));
        return { saved: true, json, markdown, count: index.summary.candidates };
    } catch (error) { return { saved: false, error: short(error instanceof Error ? error.message : 'Diagnostic write failed') }; }
}
