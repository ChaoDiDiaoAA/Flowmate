import { REPO_ROOT } from '../dataset-loader/local.ts';
import { publicVersions, atomicJson, publicReport } from '../reports/files.ts';
import { join, dirname } from 'node:path';
import { langfuseConfig, agentModelCapabilitiesSchema } from '../configuration.ts';
import { readReport, type LocalReport } from '../reports/store.ts';
import { scanEvidence } from '../execution/evidence-safety.ts';
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
export async function platformClient(repo = REPO_ROOT) {
    const config = langfuseConfig(repo);
    const { LangfuseClient } = await import('@langfuse/client');
    return new LangfuseClient({ ...config, timeout: 10 });
}
export function exportEvents(report: LocalReport): Event[] {
    if(report.history)throw Error('Historical reports are read-only; original content conditions are unavailable');
    const events: Event[] = [];
    const add = (type: string, body: Record<string, unknown>) => events.push({ type, body:publicVersions((body)), id: [report.executionId,type,body.id].join(':'), timestamp: report.startedAt });
    for (const trial of report.trials) {
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
export async function exportReport(report: LocalReport, path: string, transport?: (events: Event[]) => Promise<void | Receipt>, repo = REPO_ROOT) {
    if (!['flowmate-agent-run/v1', 'flowmate-agent-run/v2'].includes(report.contract))
        throw new Error('Historical exports are disabled');
    if (report.endedAt === null || report.scoring !== 'complete')
        throw new Error('Export requires an ended report with completed scoring; running progress cannot be resent');
    if(JSON.stringify(publicReport(readReport(path)))!==JSON.stringify(publicReport(report)))throw Error('Export requires the original saved report facts');
    const previous = structuredClone(report.export), accepted = new Set(previous.progress?.acceptedEventIds ?? []), rejected = new Set(previous.progress?.rejectedEventIds ?? []);
    let events: Event[] = [], platformUrl = process.env.LANGFUSE_BASE_URL;
    const record = (error?: string) => {
        report.export = { backend: 'langfuse', status: error ? (accepted.size ? 'partial' : 'error') : 'complete',
            progress: { total: events.length, acceptedEventIds: events.filter(e => accepted.has(e.id)).map(e => e.id), rejectedEventIds: events.filter(e => rejected.has(e.id)).map(e => e.id) },
            error, url: platformUrl };
        if (error && previous.status === 'complete') report.export = previous;
        atomicJson(join(dirname(path),'export.json'),publicVersions(report.export));
    };
    try {
        if (!transport) platformUrl = langfuseConfig(repo).baseUrl;
        events = exportEvents(report);
        const current = new Set(events.map(e => e.id));
        if ([...accepted, ...rejected].some(id => !current.has(id)) || previous.progress && previous.progress.total !== events.length)
            throw new Error('Export progress differs from original event identities');
        const send = transport ?? (async (batch: Event[]) => {
            const client = await platformClient(repo);
            platformUrl = langfuseConfig(repo).baseUrl;
            try {
                return await client.api.ingestion.batch({ batch: batch as Parameters<typeof client.api.ingestion.batch>[0]['batch'] });
            }
            finally {
                await client.shutdown();
            }
        });
        for (let i = 0; i < events.length; i += 50) {
            const batch = events.slice(i, i + 50).filter(e=>!accepted.has(e.id));if(!batch.length)continue;const receipt = await send(batch);
            const confirmed = receipt ? receiptIds(batch, receipt) : new Set(batch.map(e => e.id));
            for (const id of confirmed) { accepted.add(id); rejected.delete(id); }
            for (const event of batch) if (!confirmed.has(event.id) && !accepted.has(event.id)) rejected.add(event.id);
            if (receipt) validateReceipt(batch, receipt);
            // Save confirmed batches before the next network request; a failed resend cannot erase them.
            record(accepted.size === events.length ? undefined : 'Export batches remain pending');
        }
        record();
    }
    catch (error) {
        record(scanEvidence(String(error)).value);
    }
    return report.export;
}
