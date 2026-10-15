import { isDeepStrictEqual } from 'node:util';
import { z } from 'zod';
import type { HostClient } from '../../../apps/desktop/main/host-client.ts';
import { ResearchSessionResultSchema, ResearchPlanResultSchema, ResearchSourcesResultSchema, ResearchClaimsResultSchema,
    ResearchReportsResultSchema, ResearchEvidenceResultSchema, ResearchTaskSchema, ResearchPlanSchema, SourceSnapshotSchema,
    ClaimSchema, ResearchReportSchema } from '../../../packages/contracts/src/research.ts';
import type { EvidenceFact } from '../types.ts';

type HostReader = Pick<HostClient, 'request'>;
type Command = Parameters<HostClient['request']>[0];
const id = z.number().int().positive().max(Number.MAX_SAFE_INTEGER);
export const collectedResearchSchema = z.object({ task: ResearchTaskSchema.nullable(), plans: z.array(ResearchPlanSchema),
    discoveredPlanIds: z.array(id), sources: z.array(SourceSnapshotSchema), claims: z.array(ClaimSchema), reports: z.array(ResearchReportSchema),
    sourceTexts: z.array(z.object({ sourceSnapshotId: id, runId: id, toolCallId: id, text: z.string(),
        acquisition: z.literal('controller-query'), modelUse: z.literal('requires-original-tool-and-context-evidence') }).strict()),
    reportCount: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER), gap: z.string().optional() }).strict();
type ResearchEvidence = z.infer<typeof collectedResearchSchema>;

async function read<T>(host: HostReader, command: Command,
    schema: z.ZodType<{ ok: true; data: T } | { ok: false; error: unknown }, z.ZodTypeDef, unknown>): Promise<T> {
    const result = schema.parse(await host.request(command));
    if (!result.ok) throw new Error(command.type + ' failed');
    return result.data;
}
async function pages<T>(readPage: (beforeId?: number) => Promise<{ items: T[]; nextBeforeId: number | null }>,
    identity: (item: T) => number, accept: (item: T) => void) {
    let beforeId: number | undefined;
    const seen = new Set<number>();
    for (let pageCount = 0; pageCount < 10000; pageCount++) {
        const page = await readPage(beforeId);
        let previous = beforeId ?? Infinity;
        for (const item of page.items) {
            const id = identity(item);
            if (seen.has(id) || id >= previous) throw new Error('Repeated or unordered research page identity');
            seen.add(id); previous = id; accept(item);
        }
        if (page.nextBeforeId === null) return;
        if (!page.items.length || page.nextBeforeId !== previous) throw new Error('Research cursor made no progress');
        beforeId = page.nextBeforeId;
    }
    throw new Error('Research page safety bound exceeded');
}

/** Public queries acquire stored evidence; they never count as model reads or adoption. */
export async function collectResearchEvidence(host: HostReader, input: { sessionId: number; observedPlanIds?: number[]; pageSize?: number }): Promise<EvidenceFact> {
    const actual: ResearchEvidence = { task: null, plans: [], discoveredPlanIds: [], sources: [], claims: [], reports: [], sourceTexts: [], reportCount: 0 };
    const source = 'Host research queries: original Run/ToolCall, immutable Plan and source snapshot';
    try {
        const limit = z.number().int().min(1).max(100).parse(input.pageSize ?? 100);
        actual.task = await read(host, { type: 'query_research_for_session', input: { sessionId: input.sessionId } }, ResearchSessionResultSchema);
        if (actual.task === null) return { present: true, actual: null, source };
        if (actual.task.sessionId !== input.sessionId) throw new Error('Research task belongs to another Session');
        const researchId = actual.task.researchId;
        await pages(beforeId => read(host, { type: 'list_research_sources', input: { researchId, limit, beforeId } }, ResearchSourcesResultSchema),
            s => s.sourceSnapshotId, item => {
                if (item.researchId !== researchId) throw new Error('Foreign research source');
                actual.sources.push(item);
            });
        await pages(beforeId => read(host, { type: 'list_research_reports', input: { researchId, limit, beforeId } }, ResearchReportsResultSchema),
            r => r.reportId, item => {
                if (item.researchId !== researchId) throw new Error('Foreign research report');
                actual.reports.push(item); actual.reportCount++;
            });
        actual.discoveredPlanIds = [...new Set([...(input.observedPlanIds ?? []), ...actual.reports.map(r => r.planId),
            ...(actual.task.currentPlanId === null ? [] : [actual.task.currentPlanId])])].sort((a, b) => a - b);
        for (const planId of actual.discoveredPlanIds) {
            const plan = await read(host, { type: 'query_research_plan', input: { researchId, planId } }, ResearchPlanResultSchema);
            if (plan.researchId !== researchId || plan.planId !== planId) throw new Error('Foreign research Plan');
            actual.plans.push(plan);
            await pages(beforeId => read(host, { type: 'list_research_claims', input: { researchId, planId, limit, beforeId } }, ResearchClaimsResultSchema),
                c => c.claimId, item => {
                    if (item.researchId !== researchId || item.planId !== planId || item.revision !== plan.revision) throw new Error('Foreign research Claim');
                    actual.claims.push(item);
                });
        }
        for (const report of actual.reports) {
            if (!actual.plans.some(p => p.planId === report.planId && p.revision === report.revision)) throw new Error('Report Plan version missing');
            const claimIds = new Set(actual.claims.filter(c => c.planId === report.planId && c.revision === report.revision).map(c => c.claimId));
            if ([...report.sections, ...report.coverage].some(section => section.claimIds.some(id => !claimIds.has(id)))) throw new Error('Report references unavailable Claims');
        }
        for (const snapshot of actual.sources) {
            let offset = 0, text = '';
            for (;;) {
                const page = await read(host, { type: 'query_research_evidence', input: { researchId, sourceSnapshotId: snapshot.sourceSnapshotId, offset, limit: 4000 } }, ResearchEvidenceResultSchema);
                if (!isDeepStrictEqual(page.source,snapshot)) throw new Error('Research source changed during continuation');
                if (page.excerpt.start !== offset || page.excerpt.end > snapshot.characters ||
                    /[\uDC00-\uDFFF]/.test(page.excerpt.quote[0]!) || /[\uD800-\uDBFF]/.test(page.excerpt.quote.at(-1)!))
                    throw new Error('Research source continuation has a gap or splits UTF-16');
                text += page.excerpt.quote;
                if (page.nextOffset === null) break;
                if (page.nextOffset !== page.excerpt.end || page.nextOffset <= offset) throw new Error('Research source continuation made no progress');
                offset = page.nextOffset;
            }
            if (text.length !== snapshot.characters || Buffer.byteLength(text) !== snapshot.bytes)
                throw new Error('Research source text differs from saved size');
            actual.sourceTexts.push({ sourceSnapshotId: snapshot.sourceSnapshotId, runId: snapshot.runId, toolCallId: snapshot.toolCallId, text,
                acquisition: 'controller-query', modelUse: 'requires-original-tool-and-context-evidence' });
        }
        return { present: true, actual, source };
    } catch (error) {
        return { present: false, actual: { ...actual, gap: String(error) }, source };
    }
}
