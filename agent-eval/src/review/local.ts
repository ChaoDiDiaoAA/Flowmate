import { mkdirSync, readFileSync, readdirSync, writeFileSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { randomUUID } from 'node:crypto';
import { hash, caseContentHash, type LocalDataset } from '../datasets/local.ts';
import { readReport, reportPath } from '../reports/store.ts';
import { scanEvidence } from '../execution/evidence-safety.ts';
export type Feedback = {
    id: string;
    kind: 'case-quality' | 'run-feedback';
    caseId: string;
    caseVersion: number;
    caseHash: string;
    executionId?: string;
    trialId?: string;
    reviewer: string;
    at: string;
    verdict: 'good' | 'bad';
    note: string;
    source: string;
};
export function feedbackDirectory(repo: string, executionId?: string) { return executionId ? join(dirname(reportPath(repo, executionId)), 'reviews') : join(repo, 'agent-eval/runs/case-reviews'); }
export function addFeedback(repo: string, input: {
    dataset?: LocalDataset;
    executionId?: string;
    caseId: string;
    trialId?: string;
    reviewer: string;
    verdict: 'good' | 'bad';
    note: string;
    source?: string;
    id?: string;
    at?: string;
}) {
    if (Boolean(input.dataset) === Boolean(input.executionId))
        throw new Error('Exactly one Dataset or execution review target required');
    if (!input.reviewer.trim() || !input.note.trim() || !['good', 'bad'].includes(input.verdict))
        throw new Error('Reviewer, verdict and note required');
    let caseVersion: number, caseHash: string, trialId: string | undefined;
    if (input.dataset) {
        const task = input.dataset.cases.find(c => c.id === input.caseId);
        if (!task)
            throw new Error('Unknown Case');
        caseVersion = task.version;
        caseHash = caseContentHash(input.dataset, task);
    }
    else {
        const report = readReport(reportPath(repo, input.executionId!));
        const trials = report.trials.filter(t => t.caseId === input.caseId && (!input.trialId || t.trialId === input.trialId));
        if (trials.length !== 1)
            throw new Error('Select a unique Trial with --trial');
        const trial = trials[0]!;
        caseVersion = trial.caseVersion;
        caseHash = trial.caseHash;
        trialId = trial.trialId;
    }
    const record: Feedback = { id: input.id ?? randomUUID(), kind: input.dataset ? 'case-quality' : 'run-feedback', caseId: input.caseId, caseVersion, caseHash, executionId: input.executionId, trialId, reviewer: input.reviewer, at: input.at ?? new Date().toISOString(), verdict: input.verdict, note: input.note, source: input.source ?? 'local' };
    if ((scanEvidence(record).fact.actual as {
        leaked: boolean;
    }).leaked)
        throw new Error('Feedback contains configured secret');
    const directory = feedbackDirectory(repo, input.executionId);
    mkdirSync(directory, { recursive: true });
    const file = join(directory, hash(record.id) + '.json');
    if (existsSync(file)) {
        const old = JSON.parse(readFileSync(file, 'utf8'));
        if (JSON.stringify(old) !== JSON.stringify(record))
            throw new Error('Conflicting imported feedback identity');
        return old as Feedback;
    }
    writeFileSync(file, JSON.stringify(record, null, 2) + '\n', { flag: 'wx' });
    return record;
}
export function feedbackStatus(repo: string, executionId?: string, dataset?: LocalDataset) {
    const directory = feedbackDirectory(repo, executionId);
    const records: Feedback[] = existsSync(directory) ? readdirSync(directory).filter(f => f.endsWith('.json')).map(f => JSON.parse(readFileSync(join(directory, f), 'utf8'))) : [];
    const current = dataset ? records.filter(r => dataset.cases.some(c => c.id === r.caseId && caseContentHash(dataset, c) === r.caseHash)) : records;
    return { formalAcceptance: 'pending', records: current, stale: records.length - current.length };
}
