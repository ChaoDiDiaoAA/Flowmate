import { isDeepStrictEqual } from 'node:util';
import { CurationTargetSchema } from '../../../packages/contracts/src/evaluation-loop.ts';
import { acquireEvaluationWrite } from '../reports/files.ts';
import { humanFeedbackFile, isLocalFeedback, readHumanFeedback, writeHumanFeedback } from '../reports/feedback.ts';
import { candidateConditions, readCandidate, readTrace } from './store.ts';
import { feedbackRequestSchema, feedbackSchema, type CurationFeedback } from './schemas.ts';

export function feedbackConditions(repo: string, value: unknown) {
    const target = CurationTargetSchema.parse(value), record = target.kind === 'trace-feedback' ? readTrace(repo, target.id) : readCandidate(repo, target.id);
    if (record.revision !== target.revision) throw Error('Feedback target revision changed');
    return target.kind === 'trace-feedback' ? record : candidateConditions(repo, record as ReturnType<typeof readCandidate>);
}
export function listFeedback(repo: string, value: unknown): CurationFeedback[] {
    const target = CurationTargetSchema.parse(value);
    return readHumanFeedback(repo).filter((record): record is CurationFeedback => !isLocalFeedback(record) && record.target.kind === target.kind && record.target.id === target.id);
}
export function addFeedback(repo: string, value: unknown): CurationFeedback {
    const request = feedbackRequestSchema.parse(value);
    const release = acquireEvaluationWrite(humanFeedbackFile(repo, true));
    try {
        const records = readHumanFeedback(repo), old = records.find(item => item.id === request.operationId);
        if (old) {
            if (isLocalFeedback(old)) throw Error('Feedback operation differs from its original target');
            const { id, at, conditions, ...prior } = old;
            if (!isDeepStrictEqual({ ...prior, operationId: id }, request)) throw Error('Feedback operation differs from its original request');
            return old;
        }
        const { operationId, ...content } = request;
        const record = feedbackSchema.parse({ ...content, id: operationId, at: new Date().toISOString(), conditions: feedbackConditions(repo, request.target) });
        records.push(record); writeHumanFeedback(repo, records); return record;
    } finally { release(); }
}
