import { atomicJson, publicVersions } from '../reports/files.ts';
import { readFileSync, readdirSync, writeFileSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { randomUUID } from 'node:crypto';
import { caseFiles, type LocalDataset } from '../dataset-loader/local.ts';
import { readReport, reportPath, type LocalReport, type TrialReport } from '../reports/store.ts';
import { z } from 'zod';
import { scanEvidence } from '../execution/evidence-safety.ts';
import { artifactJson } from '../artifacts.ts';
import { caseReviewDirectory } from '../reports/paths.ts';
export type Feedback = {
    id: string;
    kind: 'case-quality' | 'run-feedback';
    caseId: string;
    caseVersion: number;
    executionId?: string;
    trialId?: string;

    conditions?: Record<string,unknown>;
    reviewer: string;
    at: string;
    verdict: 'good' | 'bad';
    note: string;
    source: string;
};
function legacyFeedback(record:any){const {caseHash,scoringHash,...facts}=record;return facts;}
const feedbackSchema = z.object({ id: z.string().min(1), kind: z.enum(['case-quality', 'run-feedback']), caseId: z.string().min(1),
    caseVersion: z.number().int().positive(), executionId: z.string().optional(), trialId: z.string().optional(),
     conditions:z.record(z.unknown()).optional(), reviewer: z.string().min(1), at: z.string().datetime(),
    verdict: z.enum(['good', 'bad']), note: z.string().min(1), source: z.string().min(1) }).strict();
function scoringConditions(report: LocalReport, trial: TrialReport) {
    return publicVersions(({ contract: report.contract, scoring: report.scoringConfiguration,
        metricPlan: trial.metricPlan, semanticPlan: trial.semanticPlan,
        checks: trial.scores.map(s => [s.metricId, s.version, s.required, s.method]).sort((a, b) => String(a[0]).localeCompare(String(b[0]))) }));
}
function caseConditions(dataset:LocalDataset,caseId:string) {
    const task=dataset.cases.find(c=>c.id===caseId);
    return publicVersions(({task,files:task?caseFiles(dataset,task):[],environment:dataset.manifest.environment,scoring:dataset.manifest.scoring}));
}
export function feedbackDirectory(repo: string, executionId?: string) { return executionId ? dirname(reportPath(repo, executionId)) : caseReviewDirectory(repo); }
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
    let caseVersion: number, trialId: string | undefined, conditions:Record<string,unknown>|undefined;
    if (input.dataset) {
        const task = input.dataset.cases.find(c => c.id === input.caseId);
        if (!task)
            throw new Error('Unknown Case');
        caseVersion = task.version;
        conditions=caseConditions(input.dataset,task.id);
    }
    else {
        const report = readReport(reportPath(repo, input.executionId!));
        if (report.executionId !== input.executionId) throw new Error('Execution identity mismatch');
        if (report.endedAt === null || report.scoring !== 'complete') throw new Error('Feedback requires original completed scoring');
        const trials = report.trials.filter(t => t.caseId === input.caseId && (!input.trialId || t.trialId === input.trialId));
        if (trials.length !== 1)
            throw new Error('Select a unique Trial with --trial');
        const trial = trials[0]!;
        caseVersion = trial.caseVersion;
        trialId = trial.trialId;
        conditions=scoringConditions(report,trial);
    }
    const record: Feedback = { id: input.id ?? randomUUID(), kind: input.dataset ? 'case-quality' : 'run-feedback', caseId: input.caseId, caseVersion, executionId: input.executionId, trialId, reviewer: input.reviewer, at: input.at ?? new Date().toISOString(), verdict: input.verdict, note: input.note, source: input.source ?? 'local',...(conditions?{conditions}:{}) };
    feedbackSchema.parse(record);
    if ((scanEvidence(record).fact.actual as {
        leaked: boolean;
    }).leaked)
        throw new Error('Feedback contains configured secret');
    const directory=input.executionId?feedbackDirectory(repo,input.executionId):caseReviewDirectory(repo,true);
    const file=join(directory,'review.json');
    const records:Feedback[]=existsSync(file)?JSON.parse(readFileSync(file,'utf8')).records.map((r:any)=>({...legacyFeedback(r),caseVersion:1})):[];
    if(records.some(r=>!r.conditions))throw Error('Historical feedback is read-only; original content conditions are unavailable');
    const prior=records.find(r=>r.id===record.id);
    if(prior){if(JSON.stringify(prior)!==JSON.stringify(record))throw Error('Conflicting imported feedback identity');return prior;}
    records.push(record);atomicJson(file,publicVersions({version:'v1',records}));return record;
}

export function feedbackStatus(repo: string, executionId?: string, dataset?: LocalDataset) {
    const directory = feedbackDirectory(repo, executionId);
    const file=join(directory,'review.json');
    const records:Feedback[]=existsSync(file)?JSON.parse(readFileSync(file,'utf8')).records.map((r:any)=>feedbackSchema.parse({...legacyFeedback(r),caseVersion:r.caseVersion==='v1'?1:r.caseVersion})):[];
    const report = executionId ? readReport(reportPath(repo, executionId)) : undefined;
    if (report && report.executionId !== executionId) throw new Error('Execution identity mismatch');
    const current = dataset ? records.filter(r => r.kind === 'case-quality' && dataset.cases.some(c => c.id === r.caseId && c.version === r.caseVersion && (!!r.conditions&&JSON.stringify(caseConditions(dataset,c.id))===JSON.stringify(r.conditions))))
        : report ? records.filter(r => r.kind === 'run-feedback' && r.executionId === report.executionId && report.trials.some(t =>
            t.trialId === r.trialId && t.caseId === r.caseId && t.caseVersion === r.caseVersion && (!!r.conditions&&JSON.stringify(scoringConditions(report,t))===JSON.stringify(r.conditions)))) : records;
    return { formalAcceptance: 'pending', records: current, stale: records.length - current.length,unverified:records.filter(r=>!r.conditions) };
}
