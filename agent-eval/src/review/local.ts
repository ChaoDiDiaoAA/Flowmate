import { acquireEvaluationWrite, atomicJson, publicVersions } from '../reports/files.ts';
import { readFileSync, readdirSync, writeFileSync, existsSync, lstatSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { randomUUID } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import { caseFiles, inside, type LocalDataset } from '../dataset-loader/local.ts';
import { inspectCaseDeclaration } from '../dataset-loader/declarations.ts';
import { findDataset } from '../execution/plan.ts';
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
const feedbackRecordsSchema = z.array(feedbackSchema).refine(records => new Set(records.map(record => record.id)).size === records.length, 'Duplicate feedback identity');
function parseFeedbackRecords(records: unknown): Feedback[] {
    const rows = z.array(z.record(z.unknown())).parse(records);
    return feedbackRecordsSchema.parse(rows.map(record => ({ ...legacyFeedback(record), caseVersion: record.caseVersion === 'v1' ? 1 : record.caseVersion })));
}
function scoringConditions(report: LocalReport, trial: TrialReport) {
    return publicVersions(({ contract: report.contract, scoring: report.scoringConfiguration,
        metricPlan: trial.metricPlan, semanticPlan: trial.semanticPlan,
        checks: trial.scores.map(s => [s.metricId, s.version, s.required, s.method]).sort((a, b) => String(a[0]).localeCompare(String(b[0]))) }));
}
export function caseFeedbackConditions(dataset:LocalDataset,caseId:string) {
    const task=dataset.cases.find(c=>c.id===caseId);
    const authored=dataset.embedded?.authored, declaration=authored?.cases.find(c=>c.id===caseId), fixture=declaration?.input.fixture?.name;
    return publicVersions(({dataset:{id:dataset.manifest.id,version:dataset.manifest.version},task,files:task?caseFiles(dataset,task):[],
        gold:authored?.gold[caseId]??null,fixture:fixture?authored!.fixtures[fixture]:null,
        environment:dataset.manifest.environment,scoring:dataset.manifest.scoring}));
}
export function feedbackDirectory(repo: string, executionId?: string) { return executionId ? dirname(reportPath(repo, executionId)) : caseReviewDirectory(repo); }
export function readFeedbackRecords(repo: string, executionId?: string): Feedback[] {
    const directory = feedbackDirectory(repo, executionId), file = join(directory, 'review.json');
    const records = lstatSync(file, { throwIfNoEntry: false })
        ? parseFeedbackRecords(JSON.parse(readFileSync(inside(directory, 'review.json'), 'utf8')).records) : [];
    if (executionId && records.some(record => record.kind !== 'run-feedback' || record.executionId !== executionId))
        throw Error('Feedback execution identity mismatch');
    return records;
}
export function addFeedback(repo: string, input: {
    dataset?: LocalDataset;
    datasetId?: string;
    executionId?: string;
    caseId: string;
    trialId?: string;
    reviewer: string;
    verdict: 'good' | 'bad';
    note: string;
    source?: string;
    id?: string;
    at?: string;
}, expectedCaseConditions?: ReturnType<typeof inspectCaseDeclaration>['conditions']) {
    if ([input.dataset, input.datasetId, input.executionId].filter(value => value !== undefined).length !== 1)
        throw new Error('Exactly one Dataset or execution review target required');
    if (!input.reviewer.trim() || !input.note.trim() || !['good', 'bad'].includes(input.verdict))
        throw new Error('Reviewer, verdict and note required');
    const isCase = input.dataset !== undefined || input.datasetId !== undefined;
    if (isCase && input.trialId !== undefined) throw Error('Case quality feedback cannot target a Trial');
    if (expectedCaseConditions && input.datasetId === undefined) throw Error('Inspection conditions require a registered Case target');
    const directory=input.executionId?feedbackDirectory(repo,input.executionId):caseReviewDirectory(repo,true);
    const file=join(directory,'review.json');
    const release=acquireEvaluationWrite(file);
    try {
        const saved=lstatSync(file, { throwIfNoEntry: false })?JSON.parse(readFileSync(inside(directory,'review.json'),'utf8')).records:[];
        const records = parseFeedbackRecords(saved);
        const prior=input.id?records.find(r=>r.id===input.id):undefined;
        if(prior){
            const originalDataset=prior.conditions?.dataset as {id?:unknown}|undefined;
            const target=prior.kind===(isCase?'case-quality':'run-feedback')&&prior.caseId===input.caseId&&prior.executionId===input.executionId&&
                (isCase?originalDataset?.id===(input.datasetId??input.dataset!.manifest.id):!input.trialId||prior.trialId===input.trialId);
            if(!target||prior.reviewer!==input.reviewer||prior.verdict!==input.verdict||prior.note!==input.note||prior.source!==(input.source??'local')||
                input.at!==undefined&&prior.at!==input.at)throw Error('Conflicting imported feedback identity');
            return prior;
        }
        if(records.some(r=>!r.conditions))throw Error('Historical feedback is read-only; original content conditions are unavailable');
        let caseVersion:number,trialId:string|undefined,conditions:Record<string,unknown>;
        if(input.datasetId !== undefined){
            const inspected = inspectCaseDeclaration(repo, input.datasetId, input.caseId);
            caseVersion = inspected.declaration.caseVersion; conditions = publicVersions(inspected.conditions);
            if (expectedCaseConditions && !isDeepStrictEqual(conditions, publicVersions(expectedCaseConditions)))
                throw Error('Case inspection changed; refresh the Case view');
        }else if(input.dataset){
            const task=input.dataset.cases.find(c=>c.id===input.caseId);if(!task)throw Error('Unknown Case');
            caseVersion=task.version;conditions=caseFeedbackConditions(input.dataset,task.id);
        }else{
            const report=readReport(reportPath(repo,input.executionId!));
            if(report.executionId!==input.executionId)throw Error('Execution identity mismatch');
            if(report.endedAt===null||report.scoring!=='complete')throw Error('Feedback requires original completed scoring');
            const trials=report.trials.filter(t=>t.caseId===input.caseId&&(!input.trialId||t.trialId===input.trialId));
            if(trials.length!==1)throw Error('Select a unique Trial with --trial');
            const trial=trials[0]!;caseVersion=trial.caseVersion;trialId=trial.trialId;conditions=scoringConditions(report,trial);
        }
        const record:Feedback={id:input.id??randomUUID(),kind:isCase?'case-quality':'run-feedback',caseId:input.caseId,caseVersion,
            executionId:input.executionId,trialId,reviewer:input.reviewer,at:input.at??new Date().toISOString(),verdict:input.verdict,note:input.note,source:input.source??'local',conditions};
        feedbackSchema.parse(record);
        if((scanEvidence(record).fact.actual as {leaked:boolean}).leaked)throw Error('Feedback contains configured secret');
        atomicJson(file,publicVersions({version:'v1',records:[...saved,record]}));return record;
    } finally { release(); }
}

export function feedbackStatus(repo: string, executionId?: string, dataset?: LocalDataset | string) {
    const records = readFeedbackRecords(repo, executionId);
    const report = executionId ? readReport(reportPath(repo, executionId)) : undefined;
    if (report && report.executionId !== executionId) throw new Error('Execution identity mismatch');
    const unverified = new Set(records.filter(record => !record.conditions).map(record => record.id));
    const datasetId = typeof dataset === 'string' ? dataset : dataset?.manifest.id;
    const current = datasetId ? records.filter(record => {
        const original = record.conditions?.dataset as { id?: unknown } | undefined;
        if (record.kind !== 'case-quality' || !record.conditions || original?.id !== datasetId) return false;
        try {
            if (record.conditions.contract === 'flowmate-case-inspection/v1') {
                const inspected = inspectCaseDeclaration(repo, datasetId, record.caseId);
                return inspected.declaration.caseVersion === record.caseVersion &&
                    isDeepStrictEqual(publicVersions(inspected.conditions), record.conditions);
            }
            const actual = typeof dataset === 'string' ? findDataset(repo, { dataset: datasetId }) : dataset!;
            return actual.cases.some(task => task.id === record.caseId && task.version === record.caseVersion &&
                isDeepStrictEqual(caseFeedbackConditions(actual, task.id), record.conditions));
        } catch {
            // An unreadable current source cannot verify or rewrite a saved review.
            unverified.add(record.id); return false;
        }
    }) : report ? records.filter(r => r.kind === 'run-feedback' && r.executionId === report.executionId && report.trials.some(t =>
            t.trialId === r.trialId && t.caseId === r.caseId && t.caseVersion === r.caseVersion && (!!r.conditions&&JSON.stringify(scoringConditions(report,t))===JSON.stringify(r.conditions)))) : records;
    return { formalAcceptance: 'pending', records: current, stale: records.length - current.length,unverified:records.filter(r=>unverified.has(r.id)) };
}
