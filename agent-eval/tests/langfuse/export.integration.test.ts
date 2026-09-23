import { mkdtempSync } from '../../../tests/support/resources.ts';
import { test } from 'bun:test';
import assert from 'node:assert/strict';
import { exportEvents, validateReceipt, exportReport } from '../../src/langfuse/export.ts';
import { reportFixture } from '../support/fixtures.ts';
import { readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
test('optional export preserves hierarchy, API score identity and null absence', () => {
    const report = reportFixture(), execution = report.trials[0]!.execution!;
    execution.observations = [
        { id: 'task', kind: 'span', name: 'Agent task', startedAt: report.startedAt, endedAt: report.endedAt! },
        { id: 'model', parentId: 'task', kind: 'generation', name: 'Agent reasoning', startedAt: report.startedAt, endedAt: report.endedAt!, model: 'actual-model', usage: { input: 10, output: 5 } }
    ];
    report.trials[0]!.scores.push({ ...report.trials[0]!.scores[0]!, metricId: 'missing', value: null, status: 'UNJUDGEABLE' });
    const a = exportEvents(report), b = exportEvents(report);
    assert.deepEqual(a, b);
    const span = a.find(e => e.body.name === 'Agent task')!, generation = a.find(e => e.type === 'generation-create')!;
    assert.equal(generation.body.parentObservationId, span.body.id);
    assert.equal(a.filter(e => e.type === 'score-create').length, 1);
    assert.equal((a[0]!.body.metadata as any).mode, undefined);
    assert.equal((a[0]!.body.metadata as any).judge_enabled, undefined);
    assert.throws(() => validateReceipt(a, { successes: [], errors: [] }));
    validateReceipt(a, { successes: a.map(e => ({ id: e.id })), errors: [] });
});
test('failed export and idempotent resend do not change scores or call models', async () => {
    const report = reportFixture(), scores = structuredClone(report.trials[0]!.scores);
    const file = join(mkdtempSync(join(tmpdir(), 'flowmate-export-')), 'summary.json');
    await exportReport(report, file, async () => { throw new Error('offline'); });
    assert.equal(report.export.status, 'error');
    assert.deepEqual(report.trials[0]!.scores, scores);
    const sent: string[][] = [];
    for (let i = 0; i < 2; i++)
        await exportReport(report, file, async (events) => { sent.push(events.map(e => e.id)); });
    assert.deepEqual(sent[0], sent[1]);
    assert.equal(JSON.parse(readFileSync(file, 'utf8')).export.status, 'complete');
});
