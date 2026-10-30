import { isDeepStrictEqual } from 'node:util';
import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { candidateSchema, mineRequestSchema } from './schemas.ts';
import { readTrace, readTraceOperation, writeTraceOperation, updateTraceState, saveCandidate } from './store.ts';
import { scanEvidence } from '../execution/evidence-safety.ts';

export type GenerateJSON = (request: { system: string; prompt: string; schema: z.ZodTypeAny; signal?: AbortSignal;
    operation?: { traceId: string; operationId: string } }) => Promise<unknown>;
const operationSchema = z.object({ request: mineRequestSchema, status: z.enum(['completed', 'rejected', 'unknown']), at: z.string().datetime(),
    reason: z.string(), candidateId: z.string().uuid().optional(), stopConfirmed: z.boolean().optional() }).strict();
export type MiningOperation = z.infer<typeof operationSchema>;
const draftSchema = candidateSchema.omit({ id: true, revision: true, contract: true, status: true, traceRef: true, kind: true, createdAt: true, updatedAt: true, validation: true });
function previousOperation(value: unknown, request: z.infer<typeof mineRequestSchema>) {
    if (value === undefined) return undefined;
    const previous = operationSchema.parse(value);
    if (!isDeepStrictEqual(previous.request, request)) throw Error('Mining operation differs from its original request'); return previous;
}
export async function mine(repo: string, value: unknown, generateJSON?: GenerateJSON, signal?: AbortSignal): Promise<MiningOperation> {
    const request = mineRequestSchema.parse(value), trace = readTrace(repo, request.traceId);
    const previous = previousOperation(readTraceOperation(repo, trace.id, 'mining', request.operationId), request); if (previous) return previous;
    let operation: MiningOperation = { request, status: 'unknown', at: new Date().toISOString(), reason: 'Model call outcome has not been confirmed; never automatically retry this operation.' };
    if (trace.revision !== request.expectedRevision) throw Error('Stale trace revision');
    if (!generateJSON) throw Error('Mining text model is not configured');
    let existing: MiningOperation | undefined;
    updateTraceState(repo, trace.id, state => {
        existing = previousOperation(state.operations.mining?.[request.operationId], request);
        if (!existing) { signal?.throwIfAborted(); (state.operations.mining ??= {})[request.operationId] = operation; }
    });
    if (existing) return existing;
    let response: unknown;
    try {
        response = await generateJSON!({ system: 'Draft one evaluation candidate as JSON data. Preserve original prompt, language, whitespace and turn order. Never invent an FM id. Use independent source materials and exact quote bindings; model output and original scores are observations, not Gold. Missing proof must remain a blocked draft. Only kind=gold requires an independently supported successful original trace. For kind=bad or kind=regression, derive the correct positive control and expected results from independent materials and the business contract; no prior successful model run is required. Never use the Agent answer as the sole Gold source. Bad signals may be infrastructure or judge failures, not necessarily Agent bugs. Regression constraints must derive from business requirements and material evidence. Do not create scripts or propose real form/external writes. Never claim replay or human approval.',
            prompt: JSON.stringify({ kind: request.kind, trace }), schema: draftSchema, signal, operation: { traceId: trace.id, operationId: request.operationId } });
    } catch (error) {
        if (error && typeof error === 'object' && 'stopConfirmed' in error && typeof error.stopConfirmed === 'boolean') operation.stopConfirmed = error.stopConfirmed;
        operation.reason = 'Model outcome unknown: ' + scanEvidence(error instanceof Error ? error.message : String(error)).value;
        writeTraceOperation(repo, trace.id, 'mining', request.operationId, operation); return operation;
    }
    try {
        const draft = draftSchema.parse(response);
        const candidate = saveCandidate(repo, { ...draft, id: randomUUID(), revision: 1, kind: request.kind, traceRef: { id: trace.id, revision: trace.revision },
            review: draft.review ? { ...draft.review, source: 'agent' } : { source: 'agent', reviewer: 'mining-model', humanReview: 'pending' } });
        operation = { ...operation, status: 'completed', candidateId: candidate.id, reason: 'Draft saved; independent validation and current human approval are required before publication.' };
    } catch (error) { operation = { ...operation, status: 'rejected', reason: scanEvidence(error instanceof Error ? error.message : String(error)).value }; }
    writeTraceOperation(repo, trace.id, 'mining', request.operationId, operation); return operation;
}
