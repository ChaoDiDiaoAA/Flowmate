import { hash } from '../datasets/local.ts';
import { saveReport, type LocalReport } from '../reports/store.ts';
import { scanEvidence } from '../execution/evidence-safety.ts';
export type Event = {
    id: string;
    type: string;
    timestamp: string;
    body: Record<string, unknown>;
};
export function validateReceipt(batch: Event[], receipt: {
    successes: Array<{
        id: string;
    }>;
    errors: unknown[];
}) {
    const accepted = new Set(receipt.successes.map(i => i.id));
    if (receipt.errors.length || batch.some(e => !accepted.has(e.id)))
        throw new Error('Langfuse ingestion receipt is incomplete or contains rejected records');
}
export async function platformClient() {
    for (const key of ['LANGFUSE_BASE_URL', 'LANGFUSE_PUBLIC_KEY', 'LANGFUSE_SECRET_KEY'])
        if (!process.env[key])
            throw new Error(key + ' required for Langfuse backend');
    const { LangfuseClient } = await import('@langfuse/client');
    return new LangfuseClient({ timeout: 10 });
}
export function exportEvents(report: LocalReport): Event[] {
    const events: Event[] = [];
    const add = (type: string, body: Record<string, unknown>) => events.push({ type, body, id: hash([report.executionId, type, body.id]).slice(0, 32), timestamp: report.startedAt });
    for (const trial of report.trials) {
        const execution = trial.execution;
        const metadata = { code: report.code, executionId: report.executionId, dataset: report.dataset, caseId: trial.caseId, caseVersion: trial.caseVersion,
            caseHash: trial.caseHash, partition: trial.partition, category: trial.category, repetition: trial.repetition, status: trial.status, contract: report.contract };
        add('trace-create', { id: trial.traceId, name: 'Agent · ' + trial.caseName, timestamp: execution?.startedAt ?? report.startedAt, environment: report.environment,
            sessionId: report.executionId, input: execution?.input ?? null, output: { status: trial.status, answer: execution?.answer, artifacts: execution?.artifacts },
            metadata: { ...metadata, unmeasured: trial.scores.filter(s => s.value === null) } });
        const observationId = (id: string) => hash([trial.traceId, 'observation', id]).slice(0, 16);
        if (execution)
            for (const obs of execution.observations) {
                add(obs.kind === 'generation' ? 'generation-create' : 'span-create', { id: observationId(obs.id), traceId: trial.traceId,
                    parentObservationId: obs.parentId ? observationId(obs.parentId) : undefined, name: obs.name, environment: report.environment,
                    startTime: obs.startedAt, endTime: obs.endedAt, input: obs.input, output: obs.output, model: obs.model, modelParameters: obs.parameters, usageDetails: obs.usage,
                    metadata: { ...metadata, kind: obs.kind } });
            }
        for (const score of trial.scores) {
            const id = hash([trial.traceId, 'score', score.metricId, score.version]).slice(0, 16);
            add('span-create', { id, traceId: trial.traceId, name: '评分 · ' + score.name, environment: report.environment, startTime: report.startedAt, endTime: report.endedAt, output: score, metadata: { method: score.method } });
            if (score.value !== null)
                add('score-create', { id: hash([trial.traceId, score.metricId, score.version]), traceId: trial.traceId, observationId: id,
                    name: score.name, value: score.value, dataType: 'NUMERIC', environment: report.environment, comment: score.reason,
                    metadata: { metricId: score.metricId, version: score.version, method: score.method, required: score.required, caseHash: trial.caseHash } });
        }
        for (const call of trial.judgeCalls)
            add('generation-create', { id: hash([trial.traceId, call.callId]).slice(0, 16), traceId: trial.traceId,
                name: 'Judge · 回答质量', environment: report.environment, startTime: call.startedAt, endTime: call.endedAt, model: call.configuration.model,
                modelParameters: { temperature: call.configuration.temperature, max_tokens: call.configuration.maxTokens }, output: call.raw, metadata: { ...call, method: 'llm-judge' } });
    }
    const scanned = scanEvidence(events);
    if ((scanned.fact.actual as {
        leaked: boolean;
    }).leaked)
        throw new Error('Secret detected in export payload; refusing export');
    return events;
}
export async function exportReport(report: LocalReport, path: string, transport?: (events: Event[]) => Promise<void>) {
    if (report.contract !== 'flowmate-agent-run/v1')
        throw new Error('Historical exports are disabled');
    try {
        const events = exportEvents(report);
        const send = transport ?? (async (batch: Event[]) => {
            const client = await platformClient();
            try {
                validateReceipt(batch, await client.api.ingestion.batch({ batch: batch as Parameters<typeof client.api.ingestion.batch>[0]['batch'] }));
            }
            finally {
                await client.shutdown();
            }
        });
        for (let i = 0; i < events.length; i += 50)
            await send(events.slice(i, i + 50));
        report.export = { backend: 'langfuse', status: 'complete', url: process.env.LANGFUSE_BASE_URL };
    }
    catch (error) {
        report.export = { backend: 'langfuse', status: 'error', error: scanEvidence(String(error)).value };
    }
    saveReport(path, report);
    return report.export;
}
