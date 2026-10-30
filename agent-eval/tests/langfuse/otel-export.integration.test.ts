import { test, expect } from 'bun:test';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { readFileSync, writeFileSync } from 'node:fs';
import { mkdtempSync } from '../../../tests/support/resources.ts';
import { reportFixture } from '../support/fixtures.ts';
import { saveReport, readReport } from '../../src/reports/store.ts';
import { exportReport } from '../../src/langfuse/export.ts';
import { observationRowsFromOtlp } from './otlp-fixture.ts';

for (const scoreRead of ['empty', 'drift', 'timestamp-drift'] as const) test(`production OTEL export rechecks ${scoreRead} score pages after complete without resending`, async () => {
  const root = mkdtempSync(join(tmpdir(), 'flowmate-otel-')), file = join(root, 'report.json'), report = reportFixture();
  const endedAt = report.endedAt;
  if (endedAt === null) throw Error('Completed report fixture requires its original end timestamp');
  saveReport(file, report); const original = readFileSync(file, 'utf8'), originalGrades = structuredClone(report.trials[0]!.scores);
  const state = { visible: false, project: 'test-project', sends: 0, queries: 0, scores: [] as any[], observations: [] as any[],
    scoreRead: 'current' as 'current' | 'empty' | 'drift' | 'timestamp-drift' };
  const server = Bun.serve({ hostname: '127.0.0.1', port: 0, async fetch(request) {
    const url = new URL(request.url);
    if (url.pathname.endsWith('/projects')) return Response.json({ data: [{ id: state.project }] });
    if (url.pathname.endsWith('/otel/v1/traces')) {
      expect(JSON.parse(readFileSync(join(root, 'export.json'), 'utf8'))).toMatchObject({ status: 'pending', target: { projectId: 'test-project' } });
      state.sends++;
      expect(request.headers.get('x-langfuse-ingestion-version')).toBe('4');
      const body = await request.json() as any;
      state.observations.push(...observationRowsFromOtlp(body));
      return Response.json({});
    }
    if (url.pathname.endsWith('/v2/observations')) { state.queries++; return Response.json({ data: state.visible ? state.observations : [], meta: {} }); }
    if (url.pathname.endsWith('/scores') && request.method === 'POST') { const score = await request.json(); state.scores.push(score); return Response.json({ id: (score as any).id }); }
    if (url.pathname.endsWith('/v3/scores')) return Response.json({ data: state.scoreRead === 'empty' ? [] : state.scores.map(s => ({ ...s,
      timestamp: state.scoreRead === 'timestamp-drift' ? new Date(Date.parse(s.timestamp) + 1).toISOString() : s.timestamp,
      value: state.scoreRead === 'drift' ? 0 : s.value, subject: { kind: 'trace', id: s.traceId } })), meta: {} });
    throw Error('Unexpected legacy endpoint: ' + url.pathname);
  } });
  const options = { connection: { baseUrl: `http://127.0.0.1:${server.port}`, publicKey: 'test-public', secretKey: 'test-secret' } };
  try {
    await exportReport(report, file, undefined, root, options);
    expect(report.export.status).toBe('partial'); expect(report.export.error).toContain('unconfirmed'); expect(state.sends).toBe(1);
    await exportReport(readReport(file), file, undefined, root, options); expect(state.sends).toBe(1);
    state.visible = true;
    await exportReport(report, file, undefined, root, options); expect(report.export.status).toBe('complete'); expect(state.sends).toBe(1);
    expect(state.scores).toHaveLength(1); expect(state.queries).toBeGreaterThan(1);
    expect(readFileSync(file, 'utf8')).toBe(original);
    const output = state.observations[0].output; state.observations[0].output = '{"drifted":true}';
    await exportReport(report, file, undefined, root, options);
    expect(report.export.status).toBe('partial'); expect(report.export.error).toContain('input/output'); expect(state.sends).toBe(1);
    state.observations[0].output = output;
    await exportReport(report, file, undefined, root, options); expect(report.export.status).toBe('complete'); expect(state.sends).toBe(1);
    expect(readReport(file).export.status).toBe('complete');
    state.scoreRead = scoreRead;
    await exportReport(report, file, undefined, root, options);
    expect(report.export.status).toBe('partial');
    expect(report.export.progress).toMatchObject({ total: 2, acceptedEventIds: [state.observations[0].metadata.localObservationId], rejectedEventIds: [] });
    expect(report.export.progress?.scoreTimestamp).toBe(endedAt);
    expect(report.export.error).toContain('unconfirmed'); expect(state.sends).toBe(1); expect(state.scores).toHaveLength(1);
    expect(report.trials[0]!.scores).toEqual(originalGrades); expect(readFileSync(file, 'utf8')).toBe(original);
    state.scoreRead = 'current';
    await exportReport(report, file, undefined, root, options);
    expect(report.export.status).toBe('complete'); expect(state.sends).toBe(1); expect(state.scores).toHaveLength(1);
    const legacyExport = JSON.parse(readFileSync(join(root, 'export.json'), 'utf8'));
    delete legacyExport.progress.scoreTimestamp;
    writeFileSync(join(root, 'export.json'), JSON.stringify(legacyExport));
    state.scoreRead = 'empty';
    await exportReport(report, file, undefined, root, options);
    expect(report.export.status).toBe('partial'); expect(report.export.progress?.scoreTimestamp).toBeUndefined();
    expect(state.sends).toBe(1); expect(state.scores).toHaveLength(1);
    state.scoreRead = 'current';
    await exportReport(report, file, undefined, root, options);
    expect(report.export.status).toBe('complete'); expect(report.export.progress?.scoreTimestamp).toBeUndefined();
    expect(readFileSync(file, 'utf8')).toBe(original);
    state.project = 'other'; await expect(exportReport(report, file, undefined, root, options)).rejects.toThrow('target');
  } finally { await server.stop(true); }
});

test('an unknown Score upload is queried before unsent scores resume with stable identities', async () => {
  const root = mkdtempSync(join(tmpdir(), 'flowmate-score-recovery-')), file = join(root, 'report.json'), report = reportFixture();
  report.trials[0]!.scores.push({ ...report.trials[0]!.scores[0]!, metricId: 'fact-check', name: 'Second assertion' });
  report.trials[0]!.counts = { PASS: 2 }; saveReport(file, report);
  const state = { fail: true, sends: 0, attempts: 0, observations: [] as any[], scores: [] as any[], pending: [] as any[], timestamps: [] as unknown[] };
  const server = Bun.serve({ hostname: '127.0.0.1', port: 0, async fetch(request) {
    const url = new URL(request.url);
    if (url.pathname.endsWith('/projects')) return Response.json({ data: [{ id: 'controlled-project' }] });
    if (url.pathname.endsWith('/otel/v1/traces')) {
      state.sends++; state.observations.push(...observationRowsFromOtlp(await request.json())); return Response.json({});
    }
    if (url.pathname.endsWith('/v2/observations')) return Response.json({ data: state.observations, meta: {} });
    if (url.pathname.endsWith('/scores') && request.method === 'POST') {
      state.attempts++; const score = await request.json() as any; state.timestamps.push(score.timestamp);
      if (state.fail) { state.pending.push(score); return Response.json({ message: 'Controlled Score visibility unknown' }, { status: 503 }); }
      const previous = state.scores.find(value => value.id === score.id && value.name === score.name && value.timestamp === score.timestamp);
      if (previous) Object.assign(previous, score); else state.scores.push(score);
      return Response.json({ id: score.id });
    }
    if (url.pathname.endsWith('/v3/scores')) {
      if (!state.fail) state.scores.push(...state.pending.splice(0));
      return Response.json({ data: state.scores.map(score => ({ ...score,
        subject: { kind: 'trace', id: score.traceId } })), meta: {} });
    }
    return new Response(null, { status: 404 });
  } });
  const options = { connection: { baseUrl: `http://127.0.0.1:${server.port}`, publicKey: 'public', secretKey: 'secret' } };
  try {
    await exportReport(report, file, undefined, root, options);
    expect(report.export.status).toBe('partial'); expect(state.attempts).toBe(1);
    await exportReport(readReport(file), file, undefined, root, options);
    expect(state.attempts).toBe(1);
    state.fail = false;
    await exportReport(readReport(file), file, undefined, root, options);
    expect(readReport(file).export.status).toBe('complete'); expect(state.sends).toBe(1);
    expect(state.scores).toHaveLength(2); expect(state.attempts).toBe(2);
    expect(state.timestamps).toEqual(['2026-09-23T00:00:01.000Z', '2026-09-23T00:00:01.000Z']);
  } finally { await server.stop(true); }
});
