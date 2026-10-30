import { REPO_ROOT } from '../dataset-loader/local.ts';
import { acquireEvaluationWrite, publicVersions, atomicJson, publicReport } from '../reports/files.ts';
import { join, dirname } from 'node:path';
import { langfuseConfig, langfuseConnection, agentModelCapabilitiesSchema, type LangfuseConnection } from '../configuration.ts';
import { readReport, readExportState, type LocalReport } from '../reports/store.ts';
import { scanEvidence } from '../execution/evidence-safety.ts';
import { z } from 'zod';
import { buildObservationTree, sendObservationTree } from './otel.ts';
import { queryLangfuseObservations, matchObservationTree } from './read.ts';
import { writeExportState } from '../reports/archive.ts';
export type Event = {
    id: string;
    type: string;
    timestamp: string;
    body: Record<string, unknown>;
};
type Receipt = { successes: Array<{ id: string }>; errors: unknown[] };
function receiptIds(batch: Event[], receipt: Receipt) {
    if (!receipt || !Array.isArray(receipt.successes) || !Array.isArray(receipt.errors)) throw new Error('Invalid Langfuse receipt');
    const expected = new Set(batch.map(e => e.id)), seen = new Set<string>();
    if (expected.size !== batch.length) throw new Error('Duplicate export event identity');
    for (const item of [...receipt.successes, ...receipt.errors]) {
        if (!item || typeof item !== 'object' || !('id' in item) || typeof item.id !== 'string' || !expected.has(item.id) || seen.has(item.id))
            throw new Error('Duplicate, foreign or invalid Langfuse receipt identity');
        seen.add(item.id);
    }
    return new Set(receipt.successes.map(i => i.id));
}
export function validateReceipt(batch: Event[], receipt: Receipt) {
    const accepted = receiptIds(batch, receipt);
    if (receipt.errors.length || accepted.size !== batch.length)
        throw new Error('Langfuse ingestion receipt is incomplete or contains rejected records');
}
function usage(value: unknown, omitUnprovenZeros = false) {
    if (!value || typeof value !== 'object') return undefined;
    const allowed = ['input', 'output', 'total', 'inputTokens', 'outputTokens', 'totalTokens', 'cacheReadTokens', 'cacheWriteTokens', 'cacheRead', 'cacheWrite', 'cacheWrite1h', 'reasoning', 'cost'];
    return Object.fromEntries(allowed.flatMap(key => {
        const number = (value as Record<string, unknown>)[key];
        return typeof number === 'number' && Number.isFinite(number) && number >= 0 && (!omitUnprovenZeros || number > 0) ? [[key, number]] : [];
    }));
}
function scoreSummary(score: LocalReport['trials'][number]['scores'][number]) {
    return { metricId: score.metricId, version: score.version, method: score.method, required: score.required, status: score.status, value: score.value,
        evaluatorId:score.evaluatorId,evaluatorVersion:score.evaluatorVersion,category:score.category,applicabilityReason:score.applicabilityReason,
        statistics: score.statistics ? { unit: score.statistics.unit, numerator: score.statistics.numerator, denominator: score.statistics.denominator,
            missing: score.statistics.missing } : undefined, evidenceCount: score.evidence.length };
}
export async function platformClient(repo = REPO_ROOT, connection?: LangfuseConnection) {
    const config = connection === undefined ? langfuseConfig(repo) : langfuseConnection(connection);
    const { LangfuseClient } = await import('@langfuse/client');
    return new LangfuseClient({ ...config, timeout: 10 });
}
export function exportEvents(report: LocalReport): Event[] {
    if(report.history)throw Error('Historical reports are read-only; original content conditions are unavailable');
    const events: Event[] = [];
    const add = (type: string, body: Record<string, unknown>) => events.push({ type, body:publicVersions((body)), id: [report.executionId,type,body.id].join(':'), timestamp: report.startedAt });
    for (const trial of report.trials) {
        if (trial.status === 'NOT_RUN' && trial.execution === null && !trial.scores.length && !trial.judgeCalls.length) continue;
        const execution = trial.execution;
        const configuration = execution?.configuration;
        const capabilities = agentModelCapabilitiesSchema.safeParse(configuration?.modelCapabilities);
        const agent = configuration ? scanEvidence({ model: typeof configuration.model === 'string' ? configuration.model : undefined,
            api: typeof configuration.api === 'string' ? configuration.api : undefined,
            baseUrl: typeof configuration.baseUrl === 'string' ? configuration.baseUrl : undefined,
            ...(capabilities.success ? { modelCapabilities: capabilities.data } : {}) }).value : undefined;
        const metadata = { code: report.code ? { commit: report.code.commit,  release: report.code.release, dirty: report.code.dirty } : undefined,
            executionId: report.executionId, trialId: trial.trialId, dataset: { id: report.dataset.id, version: report.dataset.version },
            caseId: trial.caseId, caseVersion: trial.caseVersion, partition: trial.partition, category: trial.category,
            repetition: trial.repetition, trialIndex: trial.repetition, trialsPerCase: report.repeat,
            status: trial.status, contract: report.contract, scoringVersion: report.scoringConfiguration.version,
             sourceInvalidation:report.sourceInvalidation, agent,
            evaluatorPlan:trial.evaluatorPlan,judgeGenerations:trial.judgeCalls.filter(c=>c.attempts>0).length,
            ...(trial.regressionOrigins ? { executionKind: report.executionKind, regressionOrigins: trial.regressionOrigins.map(({ verification: _, ...identity }) => identity) } : {}) };
        add('trace-create', { id: trial.traceId, name: 'Agent · ' + trial.caseName, timestamp: execution?.startedAt ?? report.startedAt, environment: report.environment,
            sessionId: report.executionId, input: { caseId: trial.caseId, caseVersion: trial.caseVersion },
            output: { status: trial.status, answerAvailable: execution?.answer !== null && execution?.answer !== undefined,
                artifactCount: execution?.artifacts.length ?? 0, endpointReached: execution?.endpointReached ?? false },
            metadata: { ...metadata, usage: usage(execution?.usage), unmeasured: trial.scores.filter(s => s.value === null).map(scoreSummary) } });
        const observationId = (id: string) => [trial.traceId, 'observation', id].join(':');
        if (execution)
            for (const obs of execution.observations) {
                add(obs.kind === 'generation' ? 'generation-create' : 'span-create', { id: observationId(obs.id), traceId: trial.traceId,
                    parentObservationId: obs.parentId ? observationId(obs.parentId) : undefined, name: obs.name, environment: report.environment,
                    startTime: obs.startedAt, endTime: obs.endedAt, model: obs.model, usageDetails: usage(obs.usage),
                    metadata: { ...metadata, kind: obs.kind } });
            }
        for (const score of trial.scores) {
            const id = [trial.traceId, 'score', score.metricId, score.version].join(':');
            add('span-create', { id, traceId: trial.traceId, name: '评分 · ' + score.name, environment: report.environment, startTime: report.startedAt, endTime: report.endedAt, output: scoreSummary(score), metadata: { method: score.method } });
            if (score.value !== null)
                add('score-create', { id: [trial.traceId,score.metricId,score.version].join(':'), traceId: trial.traceId, observationId: id,
                    name: score.name, value: score.value, dataType: 'NUMERIC', environment: report.environment,
                    metadata: { ...metadata, ...scoreSummary(score) } });
        }
        for (const call of trial.judgeCalls) {
            const sdk = call.configuration.sdk !== undefined;
            const historical = call.configuration as {temperature?:number;maxTokens?:number;modelCapabilities?:{maxOutputTokens?:number}};
            const maximum = sdk ? undefined : historical.modelCapabilities?.maxOutputTokens ?? historical.maxTokens;
            add('generation-create', { id: [trial.traceId,call.callId].join(':'), traceId: trial.traceId,
                name: 'Judge · 回答质量', environment: report.environment, startTime: call.startedAt, endTime: call.endedAt, model: call.configuration.model,
                modelParameters: { ...(historical.temperature!==undefined?{temperature:historical.temperature}:{}), ...(maximum!==undefined?{max_tokens:maximum}:{}) },
                // Pi fills absent counters with zero without exposing whether a zero was reported.
                usageDetails: sdk && call.usageSource !== 'sdk' ? undefined : usage(call.usage, sdk),
                metadata: { callId: call.callId, method: 'llm-judge',  attempts: call.attempts,
                    responseComplete: call.responseComplete, finishReason: call.finishReason, stopReason: call.stopReason, rawStopReason: call.rawStopReason,
                    api: call.configuration.api, sdk: call.configuration.sdk, usageSource: call.usageSource, errorOccurred: call.error !== null,
                    judgmentFormat: call.compact?.format, validationErrors: call.compact?.validationErrors,
                    transportStatus:call.transportStatus,parsePolicy:call.compact?.parsePolicy,normalization:call.compact?.normalization,
                    modelCapabilities:call.configuration.modelCapabilities,
                    rubricId: call.configuration.rubric?.id, rubricVersion: call.configuration.rubric?.version } });
        }
    }
    const scanned = scanEvidence(events);
    if ((scanned.fact.actual as {
        leaked: boolean;
    }).leaked)
        throw new Error('Secret detected in export payload; refusing export');
    return events;
}
type ExportOptions = { connection?: LangfuseConnection; queryProjects?: () => Promise<unknown> };
const projectsSchema = z.object({ data: z.array(z.object({ id: z.string().min(1).max(200) }).passthrough()),
    meta: z.object({ totalItems: z.literal(1).optional(), totalPages: z.literal(1).optional() }).passthrough().optional() }).passthrough();
export async function exportReport(report: LocalReport, path: string, transport?: (events: Event[]) => Promise<void | Receipt>, repo = REPO_ROOT,
    options: ExportOptions = {}) {
    const release = acquireEvaluationWrite(join(dirname(path), 'export.json'));
    try { return await exportOwnedReport(report, path, transport, repo, options); }
    finally { release(); }
}
async function exportOwnedReport(report: LocalReport, path: string, transport: ((events: Event[]) => Promise<void | Receipt>) | undefined, repo: string,
    options: ExportOptions) {
    if (!transport) return exportOtelReport(report, path, repo, options);
    if (!['flowmate-agent-run/v1', 'flowmate-agent-run/v2'].includes(report.contract))
        throw new Error('Historical exports are disabled');
    if (report.endedAt === null || report.scoring !== 'complete')
        throw new Error('Export requires an ended report with completed scoring; running progress cannot be resent');
    const saved = readReport(path);
    if(JSON.stringify(publicReport(saved))!==JSON.stringify(publicReport(report)))throw Error('Export requires the original saved report facts');
    report.export = readExportState(path, saved.export);
    const previous = structuredClone(report.export), accepted = new Set(previous.progress?.acceptedEventIds ?? []), rejected = new Set(previous.progress?.rejectedEventIds ?? []);
    if (!previous.target && (previous.progress || previous.backend === 'langfuse' && ['complete', 'partial', 'error'].includes(previous.status)))
        throw Error('Historical export target is unavailable; original receipts are read-only');
    const events = exportEvents(report), current = new Set(events.map(e => e.id));
    if ([...accepted, ...rejected].some(id => !current.has(id)) || previous.progress && previous.progress.total !== events.length ||
        previous.target && !previous.progress || previous.status === 'complete' && accepted.size !== events.length)
        throw Error('Export progress differs from original event identities');
    const connection = options.connection === undefined ? langfuseConfig(repo) : langfuseConnection(options.connection);
    let client: Awaited<ReturnType<typeof platformClient>> | undefined;
    try {
        if (!transport || !options.queryProjects) client = await platformClient(repo, connection);
        let projects: unknown;
        try { projects = await (options.queryProjects ? options.queryProjects() : client!.api.projects.get({ maxRetries: 0 })); }
        catch { throw Error('Langfuse project query failed; no events sent'); }
        const parsed = projectsSchema.safeParse(projects);
        if (!parsed.success || parsed.data.data.length !== 1) throw Error('Langfuse target requires a unique project');
        const target = { baseUrl: connection.baseUrl, projectId: parsed.data.data[0]!.id };
        if ((scanEvidence(target).fact.actual as { leaked: boolean }).leaked) throw Error('Langfuse target contains a configured secret');
        if (previous.target && (previous.target.baseUrl !== target.baseUrl || previous.target.projectId !== target.projectId))
            throw Error('Langfuse target differs from the original export');
        if (previous.status === 'complete') return report.export;
        const progress = () => ({ total: events.length, acceptedEventIds: events.filter(e => accepted.has(e.id)).map(e => e.id),
            rejectedEventIds: events.filter(e => rejected.has(e.id)).map(e => e.id) });
        const record = (status: LocalReport['export']['status'], error?: string) => {
            const next: LocalReport['export'] = { backend: 'langfuse', status, target, progress: progress(), error, url: target.baseUrl };
            writeExportState(path, next);
            report.export = next;
        };
        if (!previous.target) record('pending');
        const send = transport;
        try {
            for (let i = 0; i < events.length; i += 50) {
                const batch = events.slice(i, i + 50).filter(e => !accepted.has(e.id)); if (!batch.length) continue;
                const receipt = await send(batch), confirmed = receipt ? receiptIds(batch, receipt) : new Set(batch.map(e => e.id));
                for (const id of confirmed) { accepted.add(id); rejected.delete(id); }
                if (receipt) {
                    for (const error of receipt.errors as Array<{ id: string }>) if (!accepted.has(error.id)) rejected.add(error.id);
                    validateReceipt(batch, receipt);
                }
                // Persist each confirmed batch before another send; missing receipts remain unconfirmed.
                record(accepted.size === events.length ? 'complete' : 'partial');
            }
            record('complete');
        } catch (error) {
            record(accepted.size ? 'partial' : 'error', scanEvidence(String(error)).value);
        }
        return report.export;
    } finally {
        try { await client?.shutdown(); }
        catch { throw Error('Langfuse client shutdown failed; query the original saved export state'); }
    }
}

async function exportOtelReport(report: LocalReport, path: string, repo: string, options: ExportOptions) {
    const endedAt = report.endedAt;
    if (report.history || !endedAt || report.scoring !== 'complete') throw Error('Export requires complete original saved report facts');
    const saved = readReport(path);
    if (JSON.stringify(publicReport(saved)) !== JSON.stringify(publicReport(report))) throw Error('Export requires the original saved report facts');
    report.export = readExportState(path, saved.export);
    const previous = structuredClone(report.export), nodes = buildObservationTree(report);
    const scoreTimestamp = previous.progress?.scoreTimestamp ?? (!previous.target ? endedAt : undefined);
    if (scoreTimestamp && Date.parse(scoreTimestamp) !== Date.parse(endedAt)) throw Error('Score timestamp differs from its original execution');
    const scores = report.trials.flatMap(trial => trial.scores.filter(score => score.value !== null).map(score => ({
        id: [trial.traceId, score.metricId, score.version].join(':'), traceId: trial.traceId, name: score.name, value: score.value!,
        timestamp: new Date(scoreTimestamp ?? endedAt),
        dataType: 'NUMERIC' as const, source: 'API' as const, environment: report.environment, metadata: { executionId: report.executionId,
            trialId: trial.trialId, caseId: trial.caseId, caseVersion: trial.caseVersion, ...scoreSummary(score) } })));
    const identities = [...nodes.map(node => node.id), ...scores.map(score => score.id)], accepted = new Set(previous.progress?.acceptedEventIds ?? []);
    const knownScores = new Set(previous.progress?.knownScoreIds ?? [...accepted].filter(id => scores.some(score => score.id === id)));
    const submittedScores = new Set(previous.progress?.submittedScoreIds ?? []);
    if (!previous.target && (previous.progress || previous.backend === 'langfuse' && previous.status !== 'pending')) throw Error('Historical export target is unavailable; original receipts are read-only');
    if (previous.target && (!previous.progress || previous.progress.total !== identities.length) ||
        [...accepted].some(id => !identities.includes(id)) || [...knownScores, ...submittedScores].some(id => !scores.some(score => score.id === id)))
        throw Error('Export progress differs from original OTEL observation identities');
    const connection = options.connection === undefined ? langfuseConfig(repo) : langfuseConnection(options.connection);
    const client = await platformClient(repo, connection);
    try {
        const projects = projectsSchema.safeParse(await (options.queryProjects ? options.queryProjects() : client.api.projects.get({ maxRetries: 0 })));
        if (!projects.success || projects.data.data.length !== 1) throw Error('Langfuse target requires a unique project');
        const target = { baseUrl: connection.baseUrl, projectId: projects.data.data[0]!.id };
        if (previous.target && (previous.target.baseUrl !== target.baseUrl || previous.target.projectId !== target.projectId))
            throw Error('Langfuse target differs from the original export');
        const record = (status: LocalReport['export']['status'], error?: string) => {
            const next: LocalReport['export'] = { backend: 'langfuse', status, target, url: target.baseUrl, error,
                progress: { total: identities.length, acceptedEventIds: identities.filter(id => accepted.has(id)), rejectedEventIds: [],
                    ...(scoreTimestamp ? { scoreTimestamp } : {}), knownScoreIds: scores.filter(score => knownScores.has(score.id)).map(score => score.id),
                    submittedScoreIds: [...submittedScores] } };
            writeExportState(path, next); report.export = next;
        };
        // Persist before sending: after any interruption, query visibility instead of duplicating v4 observations.
        if (!previous.target) record('pending', 'OTEL submission started; remote visibility unconfirmed');
        let failure: string | undefined;
        if (!previous.target) {
            try {
                await sendObservationTree(nodes, connection);
            } catch (error) { failure = scanEvidence(String(error)).value; }
        }
        const readScores = async () => {
            for (const score of scores) accepted.delete(score.id);
            for (const trial of report.trials) {
                let cursor: string | undefined; const cursors = new Set<string>();
                do {
                    const page = await client.api.scoresV3.getManyV3({ traceId: trial.traceId, fields: 'subject', source: 'API', limit: 100, cursor }, { maxRetries: 0 });
                    for (const row of page.data) {
                        if (row.source !== 'API' || row.subject?.kind !== 'trace') continue;
                        const expected = scores.find(score => score.id === row.id && score.traceId === row.subject!.id);
                        if (!expected) continue;
                        knownScores.add(row.id);
                        const at = new Date(row.timestamp).getTime();
                        if (expected.name === row.name && expected.value === row.value && (!scoreTimestamp || at === Date.parse(scoreTimestamp))) accepted.add(row.id);
                    }
                    cursor = page.meta.cursor ?? undefined;
                    if (cursor && cursors.has(cursor)) throw Error('Repeated Langfuse score cursor');
                    if (cursor) cursors.add(cursor);
                } while (cursor);
            }
        };
        try {
            const observations = await queryLangfuseObservations(connection, { from: new Date(Math.min(...nodes.map(node => Date.parse(node.start))) - 1).toISOString(),
                to: new Date(Math.max(...nodes.map(node => Date.parse(node.end))) + 1).toISOString(), traceIds: [...new Set(nodes.map(node => node.traceId))] });
            const observationsMatch = matchObservationTree(nodes, observations);
            for (const node of nodes) accepted.delete(node.id);
            for (const id of observationsMatch.matchedIds) accepted.add(id);
            failure = observationsMatch.complete ? undefined : observationsMatch.gaps.join('; ');
            await readScores();
            const unresolved = [...submittedScores].some(id => !knownScores.has(id));
            const missing = scoreTimestamp && !unresolved ? scores.filter(score => !knownScores.has(score.id) && !submittedScores.has(score.id)) : [];
            if (missing.length) {
                // Score identity also includes name and timestamp; never overwrite a remotely observed drift.
                try { for (const score of missing) {
                    submittedScores.add(score.id);
                    record('partial', 'Score submission started; remote visibility unconfirmed');
                    await client.api.scores.create(score, { maxRetries: 0 });
                } }
                catch (error) { failure = scanEvidence(String(error)).value; }
                await readScores();
            }
        } catch (error) { failure = scanEvidence(String(error)).value; }
        const complete = accepted.size === identities.length && !failure;
        record(complete ? 'complete' : accepted.size ? 'partial' : 'pending', complete ? undefined :
            'Remote visibility unconfirmed; recheck the saved target without resending observations' + (failure ? ': ' + failure : ''));
        return report.export;
    } finally { await client.shutdown(); }
}
