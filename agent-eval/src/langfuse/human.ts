import { platformClient } from './export.ts';
import { readReport, reportPath } from '../reports/store.ts';
import { addFeedback, feedbackStatus } from '../review/local.ts';
import { hash } from '../dataset-loader/local.ts';
import type { LangfuseClient } from '@langfuse/client';
const NAME = 'Flowmate local run feedback';
export async function platformReview(repo: string, action: string, executionId?: string, providedClient?: LangfuseClient) {
    const client = providedClient ?? await platformClient(repo);
    try {
        const queues = [] as Awaited<ReturnType<typeof client.api.annotationQueues.listQueues>>['data'];
        for (let page = 1;; page++) {
            const res = await client.api.annotationQueues.listQueues({ page, limit: 100 });
            queues.push(...res.data);
            if (page >= res.meta.totalPages)
                break;
        }
        let queue = queues.find(q => q.name === NAME);
        if (action === 'setup') {
            if (!queue) {
                const config = await client.api.scoreConfigs.create({ name: NAME, dataType: 'CATEGORICAL', categories: [{ label: 'good', value: 1 }, { label: 'bad', value: 0 }] });
                queue = await client.api.annotationQueues.createQueue({ name: NAME, scoreConfigIds: [config.id], description: 'Run feedback only. Does not approve Case quality or formal acceptance.' });
            }
            return { queueId: queue.id };
        }
        if (!executionId)
            throw new Error('execution-id required');
        const report = readReport(reportPath(repo, executionId));
        if (report.executionId !== executionId) throw new Error('Execution identity mismatch');
        if (report.export.status !== 'complete')
            throw new Error('Export this execution successfully before platform review');
        if (action === 'sync') {
            const feedback = feedbackStatus(repo, executionId);
            if (feedback.stale) throw new Error('Feedback version mismatch');
            for (const record of feedback.records) {
                const trial = report.trials.find(t => t.caseId === record.caseId && t.trialId === record.trialId && t.caseVersion===record.caseVersion && (!record.caseHash||t.caseHash === record.caseHash));
                if (!trial)
                    throw new Error('Feedback version mismatch');
                client.score.create({ id: ['human', report.executionId, record.id].join(':'), traceId: trial.traceId, name: '人工反馈 · 运行结果', dataType: 'CATEGORICAL', value: record.verdict, comment: record.note,
                    metadata: { feedbackId: record.id, executionId: report.executionId, trialId: trial.trialId, caseId: trial.caseId, caseVersion: 'v1',
                        reviewer: record.reviewer, at: record.at, method: 'human', source: 'local-feedback' } });
            }
            await client.flush();
            return { synced: true };
        }
        if (!queue)
            throw new Error('Run review setup --backend langfuse first');
        const items = [] as Awaited<ReturnType<typeof client.api.annotationQueues.listQueueItems>>['data'];
        for (let page = 1;; page++) {
            const res = await client.api.annotationQueues.listQueueItems(queue.id, { page, limit: 100 });
            items.push(...res.data);
            if (page >= res.meta.totalPages)
                break;
        }
        if (action === 'enqueue') {
            let added = 0;
            for (const trial of report.trials)
                if (!items.some(i => i.objectId === trial.traceId)) {
                    await client.api.annotationQueues.createQueueItem(queue.id, { objectId: trial.traceId, objectType: 'TRACE' });
                    added++;
                }
            return { queueId: queue.id, added };
        }
        if (action !== 'import')
            throw new Error('Unknown platform review action');
        const imported = [];
        let cursor: string | undefined;
        const cursors = new Set<string>();
        do {
            const response = await client.api.scoresV3.getManyV3({ limit: 100, cursor, fields: 'details,subject,annotation', source: 'ANNOTATION', queueId: queue.id });
            for (const raw of response.data) {
                const score = raw as unknown as {
                    id: string;
                    name: string;
                    value: unknown;
                    stringValue?: string;
                    source: string;
                    queueId?: string;
                    authorUserId?: string;
                    timestamp: string;
                    comment?: string;
                    subject?: {
                        kind: string;
                        id: string;
                    };
                };
                if (score.name !== NAME || score.source !== 'ANNOTATION' || score.queueId !== queue.id || !score.authorUserId || score.subject?.kind !== 'trace')
                    continue;
                const trial = report.trials.find(t => t.traceId === score.subject!.id);
                if (!trial || !items.some(i => i.objectId === trial.traceId && i.status === 'COMPLETED'))
                    continue;
                const verdict = score.stringValue ?? score.value;
                if (verdict !== 'good' && verdict !== 'bad')
                    continue;
                imported.push(addFeedback(repo, { executionId, caseId: trial.caseId, trialId: trial.trialId, reviewer: `langfuse:${score.authorUserId}`, verdict, note: score.comment || `Platform annotation ${score.id}`, source: `langfuse:${score.id}`, id: `langfuse:${score.id}`, at: score.timestamp }));
            }
            cursor = response.meta.cursor ?? undefined;
            if (cursor) {
                if (cursors.has(cursor))
                    throw new Error('Repeated platform pagination cursor');
                cursors.add(cursor);
            }
        } while (cursor);
        return { imported, formalAcceptance: 'pending' };
    }
    finally {
        await client.shutdown();
    }
}
