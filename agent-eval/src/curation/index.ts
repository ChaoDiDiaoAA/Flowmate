import { z } from 'zod';
import { candidateSchema } from './schemas.ts';
import { readCandidate, readTrace, saveCandidate, saveTrace, listCandidates, listTraces, writeCandidate, acquireCandidateWrite } from './store.ts';
import { addFeedback, listFeedback } from './feedback.ts';
import { publish, listPublishedBenchmarks, loadPublishedBenchmark } from './publication.ts';
import { mine, type GenerateJSON } from './mining.ts';
import { validateCandidate, type Replay } from './validation.ts';

const editSchema = candidateSchema.pick({ case: true, gold: true, review: true, scenario: true, bindings: true, controls: true, controlBindings: true, reason: true, sourceLabels: true, reuseCaseId: true, reviseCase: true })
    .partial().extend({ expectedRevision: z.number().int().positive(), reuseCaseId: candidateSchema.shape.reuseCaseId.nullable().optional(),
        reviseCase: candidateSchema.shape.reviseCase.nullable().optional() }).strict();
export function createCurationService(repo: string, deps: { generateJSON?: GenerateJSON; replay?: Replay } = {}) {
    return {
        saveTrace: (value: unknown) => saveTrace(repo, value), readTrace: (id: string) => readTrace(repo, id), listTraces: () => listTraces(repo),
        saveCandidate: (value: unknown) => saveCandidate(repo, value), readCandidate: (id: string) => readCandidate(repo, id),
        listCandidates: (kind?: 'gold' | 'bad' | 'regression') => listCandidates(repo, kind),
        editCandidate: (id: string, value: unknown) => {
            const { expectedRevision, ...patch } = editSchema.parse(value), release = acquireCandidateWrite(repo, id);
            try {
                const candidate = readCandidate(repo, id);
                if (candidate.revision !== expectedRevision) throw Error('Stale candidate revision');
                const { reuseCaseId, reviseCase, ...content } = patch;
                return writeCandidate(repo, { ...candidate, ...content,
                    ...('reuseCaseId'in patch?{reuseCaseId:patch.reuseCaseId??undefined}:{}),
                    ...('reviseCase'in patch?{reviseCase:patch.reviseCase??undefined}:{}),
                    revision: candidate.revision + 1, updatedAt: new Date().toISOString(), status: 'draft', validation: undefined });
            } finally { release(); }
        },
        validateCandidate: (id: string, input: { expectedRevision: number; replay?: boolean; signal?: AbortSignal }) => validateCandidate(repo, id, input, deps.replay),
        addFeedback: (value: unknown) => addFeedback(repo, value), listFeedback: (target: unknown) => listFeedback(repo, target),
        publish: (value: unknown) => publish(repo, value), listPublishedBenchmarks: () => listPublishedBenchmarks(repo),
        loadPublishedBenchmark: (id: string, revision?: number) => loadPublishedBenchmark(repo, id, revision),
        mine: (input: unknown, signal?: AbortSignal) => mine(repo, input, deps.generateJSON, signal),
    };
}
export { loadPublishedBenchmark, listPublishedBenchmarks } from './publication.ts';
export type { Candidate, Validation, Publication, CurationFeedback } from './schemas.ts';
export type { GenerateJSON, MiningOperation } from './mining.ts';
export type { Replay, ReplayResult } from './validation.ts';
