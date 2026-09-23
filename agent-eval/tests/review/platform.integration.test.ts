import { mkdtempSync } from '../../../tests/support/resources.ts';
import { expect, test } from 'bun:test';
import { mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { reportFixture } from '../support/fixtures.ts';
import { platformReview } from '../../src/langfuse/human.ts';
import { feedbackStatus } from '../../src/review/local.ts';
import type { LangfuseClient } from '@langfuse/client';
test('platform import binds current exported Trace, author and completed item; pagination and repeated imports are safe', async () => {
    const repo = mkdtempSync(join(tmpdir(), 'eval-human-'));
    try {
        const report = reportFixture();
        report.export = { backend: 'langfuse', status: 'complete' };
        const dir = join(repo, 'agent-eval/runs/unit');
        mkdirSync(dir, { recursive: true });
        writeFileSync(join(dir, 'summary.json'), JSON.stringify(report));
        const score = { id: 'annotation-1', name: 'Flowmate local run feedback', value: 'good', source: 'ANNOTATION', queueId: 'queue', authorUserId: 'human-author', timestamp: '2026-09-23T01:00:00Z', subject: { kind: 'trace', id: report.trials[0]!.traceId } };
        const requested: string[] = [];
        const client = { api: { annotationQueues: { listQueues: async () => ({ data: [{ id: 'queue', name: 'Flowmate local run feedback' }], meta: { totalPages: 1 } }), listQueueItems: async () => ({ data: [{ objectId: report.trials[0]!.traceId, status: 'COMPLETED' }], meta: { totalPages: 1 } }) }, scoresV3: { getManyV3: async ({ cursor }: {
                        cursor?: string;
                    }) => { requested.push(cursor ?? 'first'); return cursor ? { data: [score, { ...score, id: 'foreign', subject: { kind: 'trace', id: 'old-trace' } }, { ...score, id: 'no-author', authorUserId: null }], meta: {} } : { data: [], meta: { cursor: 'next' } }; } } }, shutdown: async () => { } } as unknown as LangfuseClient;
        await platformReview(repo, 'import', 'unit', client);
        await platformReview(repo, 'import', 'unit', client);
        expect(requested).toEqual(['first', 'next', 'first', 'next']);
        const records = feedbackStatus(repo, 'unit').records;
        expect(records).toHaveLength(1);
        expect(records[0]!.caseHash).toBe(report.trials[0]!.caseHash);
        expect(records[0]!.reviewer).toBe('langfuse:human-author');
    }
    finally {
        rmSync(repo, { recursive: true, force: true });
    }
});
