import { expect, test } from 'bun:test';
import { existsSync, mkdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { mkdtempSync } from '../../../tests/support/resources.ts';
import { createEvaluationService } from '../../src/desktop/service.ts';
import { saveReport, readReport } from '../../src/reports/store.ts';
import { reportFixture } from '../support/fixtures.ts';
import { observationRowsFromOtlp } from '../langfuse/otlp-fixture.ts';

function setup() {
  const repo = mkdtempSync(join(tmpdir(), 'eval-desktop-export-')), directory = join(repo, 'agent-eval/runs/business/unit');
  mkdirSync(directory, { recursive: true });
  const report = reportFixture(), file = join(directory, 'report.json'); saveReport(file, report);
  const state = { projects: 0, projectId: 'synthetic-desktop-project', partial: false, query: async () => {} };
  const sends: Array<{ ids: string[]; targetSaved: boolean }> = [];
  const observations: any[] = [], scores: any[] = [];
  const server = Bun.serve({ hostname: '127.0.0.1', port: 0, async fetch(request) {
    if (new URL(request.url).pathname.endsWith('/projects')) {
      state.projects++; await state.query();
      return Response.json({ data: [{ id: state.projectId, name: 'Synthetic', organization: { id: 'synthetic-org', name: 'Synthetic' }, metadata: {} }] });
    }
    const path = new URL(request.url).pathname;
    if (path.endsWith('/v2/observations')) return Response.json({
      data: state.partial ? observations.filter(row => !row.parentObservationId) : observations, meta: {} });
    if (path.endsWith('/v3/scores')) return Response.json({ data: state.partial ? [] : scores, meta: {} });
    if (path.endsWith('/scores') && request.method === 'POST') {
      const score = await request.json() as any; scores.push({ ...score, subject: { kind: 'trace', id: score.traceId } });
      return Response.json({ id: score.id });
    }
    if (!path.endsWith('/otel/v1/traces')) return new Response(null, { status: 404 });
    const rows = observationRowsFromOtlp(await request.json()); observations.push(...rows);
    sends.push({ ids: rows.map(row => row.metadata.localObservationId), targetSaved: existsSync(join(directory, 'export.json')) });
    return Response.json({});
  } });
  const connection = { baseUrl: `http://127.0.0.1:${server.port}`, publicKey: 'desktop-synthetic-langfuse-public', secretKey: 'desktop-synthetic-langfuse-secret' };
  return { repo, report, file, original: readFileSync(file, 'utf8'), state, sends, observations, scores, server, connection };
}
function upload(service: ReturnType<typeof createEvaluationService>, input: unknown, connection: unknown) {
  const method = Reflect.get(service, 'export'); expect(method).toBeFunction(); return method(input, connection);
}

test('desktop export is explicit, retains its report and request identity, and does not resend a completed upload', async () => {
  const p = setup(), service = createEvaluationService(p.repo, { sessionId: 'synthetic-export-session' });
  try {
    service.listExecutions({}); service.result({ executionId: 'unit', view: 'summary' });
    expect(p.state.projects).toBe(0); expect(p.sends).toEqual([]);
    const input = { executionId: 'unit', operationId: 'synthetic-upload-1' };
    const first = await upload(service, input, p.connection);
    expect(first).toMatchObject({ ok: true, data: { ...input, export: { status: 'complete',
      target: { baseUrl: p.connection.baseUrl, projectId: p.state.projectId }, progress: { total: 2, accepted: 2, rejected: 0, unconfirmed: 0 } } } });
    expect(p.sends).toHaveLength(1); expect(p.scores).toHaveLength(1); expect(p.sends[0]!.targetSaved).toBe(true);
    const duplicate = await upload(service, input, p.connection);
    expect(duplicate).toEqual(first); expect(p.state.projects).toBe(1);
    expect(await upload(service, { ...input, executionId: 'different-report' }, p.connection)).toMatchObject({ ok: false });
    expect(await upload(service, { ...input, operationId: 'synthetic-confirm-complete' }, p.connection)).toMatchObject({ ok: true, data: { export: { status: 'complete' } } });
    expect(p.state.projects).toBe(2); expect(p.sends).toHaveLength(1); expect(p.scores).toHaveLength(1);
    expect(readFileSync(p.file, 'utf8')).toBe(p.original);
    expect(JSON.stringify(first)).not.toContain(p.connection.secretKey);
  } finally { await service.shutdown(); await p.server.stop(true); }
});

test('desktop rechecks visible original observations and scores without resending and refuses another project', async () => {
  const p = setup(), service = createEvaluationService(p.repo); p.state.partial = true;
  try {
    expect(await upload(service, { executionId: 'unit', operationId: 'synthetic-partial' }, p.connection))
      .toMatchObject({ ok: true, data: { export: { status: 'partial', progress: { total: 2, accepted: 1, rejected: 0, unconfirmed: 1 } } } });
    const root = p.observations.find(row => !row.parentObservationId)!;
    expect(root.type).toBe('AGENT');
    const rootId = root.metadata.localObservationId, originalTarget = p.state.projectId;
    p.state.projectId = 'another-synthetic-project';
    expect(await upload(service, { executionId: 'unit', operationId: 'synthetic-wrong-project' }, p.connection)).toMatchObject({ ok: false });
    expect(p.sends).toHaveLength(1); expect(readReport(p.file).export.progress?.acceptedEventIds).toEqual([rootId]);
    p.state.projectId = originalTarget; p.state.partial = false;
    expect(await upload(service, { executionId: 'unit', operationId: 'synthetic-resend' }, p.connection))
      .toMatchObject({ ok: true, data: { export: { status: 'complete', progress: { total: 2, accepted: 2, rejected: 0, unconfirmed: 0 } } } });
    expect(p.sends).toHaveLength(1); expect(p.scores).toHaveLength(1);
    expect(readFileSync(p.file, 'utf8')).toBe(p.original);
  } finally { await service.shutdown(); await p.server.stop(true); }
});

test('an in-flight export blocks new execution and feedback while shutdown waits for the actual saved receipt', async () => {
  const p = setup(), service = createEvaluationService(p.repo);
  let release!: () => void, entered!: () => void;
  const gate = new Promise<void>(done => { release = done; }), querying = new Promise<void>(done => { entered = done; });
  p.state.query = async () => { entered(); await gate; };
  let pending: Promise<unknown> | undefined, stopped: Promise<unknown> | undefined;
  try {
    pending = upload(service, { executionId: 'unit', operationId: 'synthetic-inflight' }, p.connection); await querying;
    const start = service.start({ previewId: 'not-started-preview', requestId: 'blocked-by-export' }, { batchId: 'blocked-batch',
      settings: { revision: 0, agent: null, judge: null, credentials: { agent: 'missing', judge: 'missing' } },
      credentials: { agent: 'synthetic-unused-agent-secret', judge: null } });
    expect(start).toMatchObject({ ok: false, error: { code: 'evaluation_busy' } });
    expect(service.addFeedback({})).toMatchObject({ ok: false, error: { code: 'evaluation_busy' } });
    let closed = false;
    stopped = service.shutdown().then(result => { closed = true; return result; }); await Promise.resolve();
    expect(closed).toBe(false); release();
    expect(await pending).toMatchObject({ ok: true, data: { export: { status: 'complete' } } });
    expect(await stopped).toMatchObject({ ok: true, data: { closed: true, stopped: true } });
    expect(service.control()).toMatchObject({ ok: true, data: { state: 'idle', executionIds: [] } });
  } finally { release?.(); await pending; await stopped; await p.server.stop(true); }
});
