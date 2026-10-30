import { mkdtempSync } from '../../../tests/support/resources.ts';
import { expect, test } from 'bun:test';
import { mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { reportFixture } from '../support/fixtures.ts';
import { platformReview } from '../../src/langfuse/human.ts';
import { addFeedback, feedbackStatus } from '../../src/review/local.ts';
import type { LangfuseClient } from '@langfuse/client';
const connection = { baseUrl: 'https://platform.example.invalid', publicKey: 'test-public', secretKey: 'test-secret' };
const target = { baseUrl: connection.baseUrl, projectId: 'project' };

test('feedback is bound to the original scoring versions; changed or foreign reports cannot sync', async () => {
    const repo = mkdtempSync(join(tmpdir(), 'eval-feedback-version-')), report = reportFixture();
    const directory = join(repo, 'agent-eval/runs/unit'); mkdirSync(directory, { recursive: true });
    report.export = { backend: 'langfuse', status: 'complete', target };
    const file = join(directory, 'summary.json'); writeFileSync(file, JSON.stringify(report));
    const record = addFeedback(repo, { executionId: 'unit', caseId: 'sample', trialId: 'trial-1', reviewer: 'fixture', verdict: 'good', note: 'synthetic feedback', id: 'fixed', at: report.startedAt });
    expect(record.conditions).toBeDefined();
    expect(feedbackStatus(repo, 'unit').stale).toBe(0);
    report.trials[0]!.scores[0]!.required=false; writeFileSync(file, JSON.stringify(report));
    expect(feedbackStatus(repo, 'unit').stale).toBe(1);
    let scores = 0;
    const client = { api: { projects: { get: async () => ({ data: [{ id: 'project' }] }) }, annotationQueues: { listQueues: async () => ({ data: [], meta: { totalPages: 1 } }) } }, score: { create: () => { scores++; } }, shutdown: async () => {} } as unknown as LangfuseClient;
    await expect(platformReview(repo, 'sync', 'unit', client, connection)).rejects.toThrow('Feedback version'); expect(scores).toBe(0);
    report.executionId = 'foreign'; report.trials[0]!.execution!.identity.executionId = 'foreign'; writeFileSync(file, JSON.stringify(report));
    expect(() => addFeedback(repo, { executionId: 'unit', caseId: 'sample', trialId: 'trial-1', reviewer: 'fixture', verdict: 'bad', note: 'must refuse' })).toThrow('Execution identity');
    rmSync(repo, { recursive: true, force: true });
});
test('platform import binds current exported Trace, author and completed item; pagination and repeated imports are safe', async () => {
    const repo = mkdtempSync(join(tmpdir(), 'eval-human-'));
    try {
        const report = reportFixture();
        report.export = { backend: 'langfuse', status: 'complete', target };
        const dir = join(repo, 'agent-eval/runs/unit');
        mkdirSync(dir, { recursive: true });
        writeFileSync(join(dir, 'summary.json'), JSON.stringify(report));
        const score = { id: 'annotation-1', name: 'Flowmate local run feedback', value: 'good', source: 'ANNOTATION', queueId: 'queue', authorUserId: 'human-author', timestamp: '2026-09-23T01:00:00Z', subject: { kind: 'trace', id: report.trials[0]!.traceId } };
        const requested: string[] = [];
        let projectId = 'project';
        const client = { api: { projects: { get: async () => ({ data: [{ id: projectId }] }) }, annotationQueues: { listQueues: async () => ({ data: [{ id: 'queue', name: 'Flowmate local run feedback' }], meta: { totalPages: 1 } }), listQueueItems: async () => ({ data: [{ objectId: report.trials[0]!.traceId, status: 'COMPLETED' }], meta: { totalPages: 1 } }) }, scoresV3: { getManyV3: async ({ cursor }: {
                        cursor?: string;
                    }) => { requested.push(cursor ?? 'first'); return cursor ? { data: [score, { ...score, id: 'foreign', subject: { kind: 'trace', id: 'old-trace' } }, { ...score, id: 'no-author', authorUserId: null }], meta: {} } : { data: [], meta: { cursor: 'next' } }; } } }, shutdown: async () => { } } as unknown as LangfuseClient;
        await platformReview(repo, 'import', 'unit', client, connection);
        await platformReview(repo, 'import', 'unit', client, connection);
        expect(requested).toEqual(['first', 'next', 'first', 'next']);
        const records = feedbackStatus(repo, 'unit').records;
        expect(records).toHaveLength(1);
        expect(records[0]!).not.toHaveProperty('caseConditions');
        expect(records[0]!.reviewer).toBe('langfuse:human-author');
        projectId = 'foreign-project';
        await expect(platformReview(repo, 'import', 'unit', client, connection)).rejects.toThrow('target');
        expect(feedbackStatus(repo, 'unit').records).toHaveLength(1);
    }
    finally {
        rmSync(repo, { recursive: true, force: true });
    }
});
