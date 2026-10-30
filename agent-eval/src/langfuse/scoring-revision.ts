import { isDeepStrictEqual } from 'node:util';
import { z } from 'zod';
import { langfuseConfig, langfuseConnection, type LangfuseConnection } from '../configuration.ts';
import { readScoringRevision, readScoringRevisionReport } from '../execution/score-retry.ts';
import { scanEvidence } from '../execution/evidence-safety.ts';
import { archiveReference, findArchive, readArchive, updateArchive } from '../reports/archive.ts';
import { readReport } from '../reports/store.ts';
import { platformClient } from './export.ts';

const text = z.string().min(1);
const receiptSchema = z.object({ runId: text, revisionId: text, timestamp: z.string().datetime(), total: z.number().int().nonnegative(),
    status: z.enum(['pending', 'partial', 'complete', 'blocked']), target: z.object({ baseUrl: text, projectId: text }).strict(),
    scoreIds: z.array(text), submittedIds: z.array(text), knownIds: z.array(text), verifiedIds: z.array(text), error: z.string().max(240).optional() }).strict();
type ScoreUploadReceipt = z.infer<typeof receiptSchema>;
export type ScoringRevisionUploadSummary = { revisionId: string; status: ScoreUploadReceipt['status']; total: number; verified: number;
    submitted: number; unknown: number; error?: string };
const summarize = (receipt: ScoreUploadReceipt): ScoringRevisionUploadSummary => ({ revisionId: receipt.revisionId,
    status: receipt.status, total: receipt.total, verified: receipt.verifiedIds.length, submitted: receipt.submittedIds.length,
    unknown: receipt.submittedIds.filter(id => !receipt.verifiedIds.includes(id)).length, ...(receipt.error ? { error: receipt.error } : {}) });

/** Upload only explicit revision scores to already verified original Traces; observations are never submitted. */
export async function uploadScoringRevisionScores(repo: string, input: { runId: string; revisionId: string },
    options: { connection?: LangfuseConnection } = {}): Promise<ScoringRevisionUploadSummary> {
    const revision = readScoringRevision(repo, input.runId, input.revisionId);
    if (!revision.endedAt || revision.status === 'running') throw Error('Only an ended scoring revision can upload scores');
    const file = findArchive(repo, input.runId), before = readArchive(file), receiptId = 'scores-' + input.revisionId;
    const reports = Object.keys(revision.executions).map(executionId => ({ executionId,
        original: readReport(archiveReference(file, 'executions', executionId)),
        revised: readScoringRevisionReport(repo, input.runId, input.revisionId, executionId) }));
    const timestamp = new Date(revision.endedAt).toISOString();
    const scores = reports.flatMap(({ executionId, revised }) => revised.trials.flatMap(trial => {
        const selected = revision.executions[executionId]!.trials[trial.trialId];
        if (!selected || selected.scoringState !== 'complete') return [];
        const jobs = new Set<string>(selected.judgeCalls.filter(call => call.lifecycle === 'ended' && call.endedAt && call.attempts === 1 &&
            !call.submissionUnknown && call.responseComplete && call.error === null).map(call => call.callId));
        if (!jobs.size) return [];
        return trial.scores.filter(score => score.value !== null && Number.isFinite(score.value) && ['PASS', 'FAIL'].includes(score.status) &&
            (score.method === 'llm-judge' && !!score.judge && jobs.has(score.judge.callId) ||
                score.method === 'deterministic' && ['DR03', 'task-success'].includes(score.metricId))).map(score => ({
            id: [trial.traceId, score.metricId, score.version, input.revisionId].join(':'), traceId: trial.traceId, name: score.name,
            value: score.value!, timestamp: new Date(timestamp), dataType: 'NUMERIC' as const, source: 'API' as const, environment: revised.environment,
            metadata: { runId: input.runId, revisionId: input.revisionId, executionId, trialId: trial.trialId, caseId: trial.caseId,
                caseVersion: trial.caseVersion, metricId: score.metricId, version: score.version, evaluatorId: score.evaluatorId,
                evaluatorVersion: score.evaluatorVersion, method: score.method, counts: score.statistics ?? null, judgeCallId: score.judge?.callId },
        }));
    }));
    const scoreIds = scores.map(score => score.id);
    if (new Set(scoreIds).size !== scores.length) throw Error('Duplicate scoring revision score identity');
    if ((scanEvidence(scores).fact.actual as { leaked: boolean }).leaked) throw Error('Configured secret detected in revision score metadata');
    if (!scores.length) return { revisionId: input.revisionId, status: 'complete', total: 0, verified: 0, submitted: 0, unknown: 0 };
    const connection = options.connection === undefined ? langfuseConfig(repo) : langfuseConnection(options.connection);
    for (const { original } of reports) {
        const exported = original.export, accepted = new Set(exported.progress?.acceptedEventIds ?? []);
        if (original.history || exported.backend !== 'langfuse' || exported.status !== 'complete' || !exported.target ||
            exported.target.baseUrl !== connection.baseUrl || !exported.progress || exported.progress.total !== accepted.size ||
            exported.progress.rejectedEventIds.length || original.trials.some(trial => scores.some(score => score.traceId === trial.traceId) &&
                !accepted.has(trial.traceId + ':root')))
            throw Error('Original Trace export must be verified complete on the same Langfuse target');
    }
    const client = await platformClient(repo, connection);
    try {
        let projects: unknown;
        try { projects = await client.api.projects.get({ maxRetries: 0 }); }
        catch { throw Error('Langfuse project query failed; no revision scores sent'); }
        const project = z.object({ data: z.array(z.object({ id: text }).passthrough()).length(1),
            meta: z.object({ totalItems: z.literal(1).optional(), totalPages: z.literal(1).optional() }).passthrough().optional() }).passthrough().parse(projects);
        const target = { baseUrl: connection.baseUrl, projectId: project.data[0]!.id };
        if (reports.some(({ original }) => !isDeepStrictEqual(original.export.target, target))) throw Error('Langfuse project differs from original Trace target');
        const initial: ScoreUploadReceipt = { runId: input.runId, revisionId: input.revisionId, timestamp, total: scores.length, target,
            status: 'pending', scoreIds, submittedIds: [], knownIds: [], verifiedIds: [] };
        let receipt = initial;
        const update = (change: (current: ScoreUploadReceipt) => void) => {
            updateArchive(file, archive => {
                if (!isDeepStrictEqual(archive.scoringRevisions[input.revisionId], revision) ||
                    reports.some(({ executionId }) => !isDeepStrictEqual(archive.exports[executionId], before.exports[executionId])))
                    throw Error('Original revision or verified Trace export changed while uploading scores');
                const current = archive.exports[receiptId] === undefined ? structuredClone(initial) : receiptSchema.parse(archive.exports[receiptId]);
                if (!isDeepStrictEqual([current.runId, current.revisionId, current.timestamp, current.target, current.total, current.scoreIds],
                    [initial.runId, initial.revisionId, initial.timestamp, initial.target, initial.total, initial.scoreIds]) ||
                    [current.submittedIds, current.knownIds, current.verifiedIds].some(ids => new Set(ids).size !== ids.length || ids.some(id => !scoreIds.includes(id))))
                    throw Error('Saved revision upload receipt differs from original score identities');
                change(current); receiptSchema.parse(current); archive.exports[receiptId] = current; receipt = current;
            });
        };
        update(() => {});
        const query = async () => {
            const known = new Set<string>(), verified = new Set<string>(); let drift = false;
            for (const traceId of new Set(scores.map(score => score.traceId))) {
                let cursor: string | undefined; const cursors = new Set<string>();
                do {
                    const page = await client.api.scoresV3.getManyV3({ traceId, source: 'API', fields: 'subject', limit: 100, cursor }, { maxRetries: 0 });
                    for (const row of page.data) {
                        const expected = scores.find(score => score.id === row.id);
                        if (!expected) continue;
                        if (known.has(row.id)) throw Error('Duplicate remote revision score identity');
                        known.add(row.id);
                        const matches = row.source === 'API' && row.subject?.kind === 'trace' && row.subject.id === expected.traceId &&
                            row.name === expected.name && row.value === expected.value && Date.parse(String(row.timestamp)) === Date.parse(timestamp);
                        if (matches) verified.add(row.id); else drift = true;
                    }
                    cursor = page.meta.cursor ?? undefined;
                    if (cursor && cursors.has(cursor)) throw Error('Repeated Langfuse revision score cursor');
                    if (cursor) cursors.add(cursor);
                } while (cursor);
            }
            update(current => {
                current.knownIds = scoreIds.filter(id => current.knownIds.includes(id) || known.has(id));
                current.verifiedIds = scoreIds.filter(id => verified.has(id));
            });
            return { known, verified, drift };
        };
        const record = (error?: string) => {
            update(current => {
                current.status = !error && current.verifiedIds.length === scores.length ? 'complete' : error ? 'blocked' : current.verifiedIds.length ? 'partial' : 'pending';
                if (error) current.error = error; else delete current.error;
            });
            return summarize(receipt);
        };
        let observed: Awaited<ReturnType<typeof query>>;
        try { observed = await query(); }
        catch { return record('Revision score query failed; no scores sent'); }
        if (observed.drift) return record('Remote revision score identity or value differs; no scores overwritten');
        if (receipt.submittedIds.some(id => !observed.known.has(id))) return record('Submitted score visibility is unconfirmed; no scores resent');
        let failed = false;
        for (const score of scores.filter(score => !observed.known.has(score.id))) {
            let claimed = false;
            update(current => {
                if (!current.submittedIds.includes(score.id) && !current.knownIds.includes(score.id)) { current.submittedIds.push(score.id); claimed = true; }
            });
            if (!claimed) continue;
            try { await client.api.scores.create(score, { maxRetries: 0 }); }
            catch { failed = true; break; }
        }
        try { observed = await query(); }
        catch { return record('Revision score visibility query failed; submission results remain unconfirmed'); }
        return record(observed.drift ? 'Remote revision score identity or value differs; no scores overwritten' :
            observed.verified.size === scores.length ? undefined : failed || receipt.submittedIds.some(id => !observed.known.has(id))
                ? 'Submitted score visibility is unconfirmed; no scores resent' : undefined);
    } finally {
        try { await client.shutdown(); }
        catch { throw Error('Langfuse client shutdown failed; inspect the saved revision score receipt'); }
    }
}
