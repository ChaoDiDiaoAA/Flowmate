import { lstatSync } from 'node:fs';
import { join } from 'node:path';
import { z } from 'zod';
import { directory, json } from '../curation/store.ts';
import { feedbackSchema } from '../curation/schemas.ts';
import { atomicJson, executionVersions, publicVersions } from './files.ts';

export const localFeedbackSchema = z.object({ id: z.string().min(1), kind: z.enum(['case-quality', 'run-feedback']), caseId: z.string().min(1),
    caseVersion: z.number().int().positive(), executionId: z.string().optional(), trialId: z.string().optional(),
    conditions: z.record(z.unknown()).optional(), reviewer: z.string().min(1), at: z.string().datetime(),
    verdict: z.enum(['good', 'bad']), note: z.string().min(1), source: z.string().min(1) }).strict();
export type LocalFeedback = z.infer<typeof localFeedbackSchema>;
export type HumanFeedback = LocalFeedback | z.infer<typeof feedbackSchema>;
export const isLocalFeedback = (record: HumanFeedback): record is LocalFeedback => 'kind' in record;
export function humanFeedbackFile(repo: string, create = false) { return join(directory(repo, ['agent-eval'], create), 'feedback.json'); }
export function readHumanFeedback(repo: string): HumanFeedback[] {
    const file = humanFeedbackFile(repo); if (!lstatSync(file, { throwIfNoEntry: false })) return [];
    const collection = z.object({ version: z.literal('v1'), records: z.array(z.record(z.unknown())) }).strict().parse(json(file));
    const records = collection.records.map(record => {
        if (record.kind === 'case-quality' || record.kind === 'run-feedback') {
            const { caseHash, scoringHash, ...facts } = record;
            return localFeedbackSchema.parse({ ...facts, caseVersion: executionVersions({ caseVersion: facts.caseVersion }).caseVersion });
        }
        return feedbackSchema.parse(record);
    });
    if (new Set(records.map(record => record.id)).size !== records.length) throw Error('Duplicate feedback identity');
    return records;
}
export function writeHumanFeedback(repo: string, records: HumanFeedback[]) {
    if (new Set(records.map(record => record.id)).size !== records.length) throw Error('Duplicate feedback identity');
    atomicJson(humanFeedbackFile(repo, true), { version: 'v1', records: records.map(record => isLocalFeedback(record)
        ? publicVersions(localFeedbackSchema.parse(record)) : feedbackSchema.parse(record)) });
}
