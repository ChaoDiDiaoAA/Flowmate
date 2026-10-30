import { test, expect, spyOn } from 'bun:test';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { mkdtempSync } from '../../../tests/support/resources.ts';
import { exportEvents, exportReport } from '../../src/langfuse/export.ts';
import { readReport, saveReport } from '../../src/reports/store.ts';
import { reportFixture } from '../support/fixtures.ts';
import * as reportFiles from '../../src/reports/files.ts';
import { observationRowsFromOtlp } from './otlp-fixture.ts';

async function platform() {
    const root = mkdtempSync(join(tmpdir(), 'eval-target-')), report = reportFixture();
    const file = join(root, 'report.json'), sidecar = join(root, 'export.json');
    saveReport(file, report);
    const original = readFileSync(file, 'utf8');
    const state = { projectId: 'synthetic-project', projects: 0, partial: false, unavailable: false,
        queryStatus: 200, extraProjects: false, multiplePages: false, afterQuery: () => {}, afterSend: () => {} };
    const sends: Array<{ ids: string[]; auth: string | null; saved: unknown }> = [], observations: any[] = [], scores: any[] = [];
    const server = Bun.serve({ hostname: '127.0.0.1', port: 0, async fetch(request) {
        if (new URL(request.url).pathname.endsWith('/projects')) {
            state.projects++; state.afterQuery();
            if (state.queryStatus !== 200) return Response.json({ message: 'synthetic unavailable' }, { status: state.queryStatus });
            const project = { id: state.projectId, name: 'Synthetic', organization: { id: 'synthetic-org', name: 'Synthetic' }, metadata: {} };
            return Response.json({ data: state.extraProjects ? [project, { ...project, id: 'another-project' }] : [project],
                ...(state.multiplePages ? { meta: { page: 1, limit: 1, totalItems: 2, totalPages: 2 } } : {}) });
        }
        const pathname = new URL(request.url).pathname;
        if (pathname.endsWith('/v2/observations')) return Response.json({ data: state.unavailable ? [] : observations, meta: {} });
        if (pathname.endsWith('/v3/scores')) return Response.json({ data: state.partial || state.unavailable ? [] : scores, meta: {} });
        if (pathname.endsWith('/scores') && request.method === 'POST') {
            const score = await request.json() as any; scores.push({ ...score, subject: { kind: 'trace', id: score.traceId } });
            return Response.json({ id: score.id });
        }
        if (!pathname.endsWith('/otel/v1/traces')) return new Response(null, { status: 404 });
        const body = await request.json() as any, rows = observationRowsFromOtlp(body), ids = rows.map(row => row.metadata.localObservationId);
        observations.push(...rows);
        sends.push({ ids, auth: request.headers.get('authorization'),
            saved: existsSync(sidecar) ? JSON.parse(readFileSync(sidecar, 'utf8')) : null });
        state.afterSend();
        return Response.json({});
    } });
    const connection = { baseUrl: `http://127.0.0.1:${server.port}`, publicKey: 'synthetic-public', secretKey: 'synthetic-secret' };
    const before = Object.fromEntries(['LANGFUSE_BASE_URL', 'LANGFUSE_PUBLIC_KEY', 'LANGFUSE_SECRET_KEY'].map(key => [key, process.env[key]]));
    // A red run of the old environment adapter must also stay on the controlled server.
    Object.assign(process.env, { LANGFUSE_BASE_URL: connection.baseUrl, LANGFUSE_PUBLIC_KEY: connection.publicKey, LANGFUSE_SECRET_KEY: connection.secretKey });
    return { root, report, file, sidecar, original, state, sends, connection,
        async close() { await server.stop(true); for (const [key, value] of Object.entries(before)) {
            if (value === undefined) delete process.env[key]; else process.env[key] = value;
        } } };
}

test('target is saved before ingestion; completed repeats verify the target without resending', async () => {
    const p = await platform();
    try {
        await exportReport(p.report, p.file, undefined, p.root, { connection: p.connection });
        expect(p.report.export).toMatchObject({ status: 'complete', target: { baseUrl: p.connection.baseUrl, projectId: 'synthetic-project' } });
        expect(p.sends).toHaveLength(1);
        expect(p.sends[0]!.saved).toMatchObject({ status: 'pending', target: { baseUrl: p.connection.baseUrl, projectId: 'synthetic-project' },
            progress: { total: 2, acceptedEventIds: [], rejectedEventIds: [] } });
        const completed = readFileSync(p.sidecar, 'utf8');
        await exportReport(p.report, p.file, undefined, p.root, { connection: p.connection });
        expect(p.state.projects).toBe(2); expect(p.sends).toHaveLength(1);
        expect(readFileSync(p.sidecar, 'utf8')).toBe(completed);
        expect(readFileSync(p.file, 'utf8')).toBe(p.original);
        expect(JSON.stringify(readReport(p.file))).not.toContain('synthetic-secret');
    } finally { await p.close(); }
});

test('project query failures leave the original local export state and send no events', async () => {
    const p = await platform();
    try {
        p.state.queryStatus = 503;
        await expect(exportReport(p.report, p.file, undefined, p.root, { connection: p.connection })).rejects.toThrow();
        expect(p.state.projects).toBe(1); expect(p.sends).toHaveLength(0);
        expect(existsSync(p.sidecar)).toBe(false);
        expect(readReport(p.file).export).toEqual({ backend: 'local', status: 'disabled' });
        p.state.queryStatus = 200;
        await exportReport(p.report, p.file, undefined, p.root, { connection: p.connection });
        expect(readReport(p.file).export.status).toBe('complete');
    } finally { await p.close(); }
});

test('ambiguous projects and partial project pages cannot establish an upload target', async () => {
    const p = await platform();
    try {
        p.state.extraProjects = true;
        await expect(exportReport(p.report, p.file, undefined, p.root, { connection: p.connection })).rejects.toThrow('unique');
        p.state.extraProjects = false; p.state.multiplePages = true;
        await expect(exportReport(p.report, p.file, undefined, p.root, { connection: p.connection })).rejects.toThrow('unique');
        expect(p.sends).toHaveLength(0); expect(existsSync(p.sidecar)).toBe(false);
    } finally { await p.close(); }
});

test('target persistence failure prevents ingestion', async () => {
    const p = await platform();
    try {
        p.state.afterQuery = () => mkdirSync(p.sidecar);
        await expect(exportReport(p.report, p.file, undefined, p.root, { connection: p.connection })).rejects.toThrow();
        expect(p.state.projects).toBe(1); expect(p.sends).toHaveLength(0);
        expect(readFileSync(p.file, 'utf8')).toBe(p.original);
    } finally { await p.close(); }
});

test('project or address changes preserve prior receipts; the same project permits key rotation', async () => {
    const p = await platform();
    try {
        p.state.partial = true;
        await exportReport(p.report, p.file, undefined, p.root, { connection: p.connection });
        const partial = readFileSync(p.sidecar, 'utf8');
        p.state.partial = false; p.state.projectId = 'different-project';
        await expect(exportReport(p.report, p.file, undefined, p.root, { connection: p.connection })).rejects.toThrow('target');
        expect(p.sends).toHaveLength(1); expect(readFileSync(p.sidecar, 'utf8')).toBe(partial);
        p.state.projectId = 'synthetic-project';
        await expect(exportReport(p.report, p.file, undefined, p.root, { connection: { ...p.connection, baseUrl: p.connection.baseUrl + '/other' } })).rejects.toThrow('target');
        expect(p.sends).toHaveLength(1); expect(readFileSync(p.sidecar, 'utf8')).toBe(partial);
        await exportReport(p.report, p.file, undefined, p.root, { connection: { ...p.connection, secretKey: 'rotated-synthetic-secret' } });
        expect(p.sends).toHaveLength(1);
        expect(readReport(p.file).export.status).toBe('complete');
    } finally { await p.close(); }
});

test('one upload keeps its initial connection through all event batches', async () => {
    const p = await platform();
    try {
        p.report.trials[0]!.execution!.observations = Array.from({ length: 55 }, (_, i) => ({ id: `synthetic-span-${i}`,
            kind: 'span', name: 'Synthetic', startedAt: p.report.startedAt, endedAt: p.report.endedAt }));
        // A separate report is needed because completed original evidence cannot be overwritten.
        const file = join(p.root, 'large', 'report.json'); saveReport(file, p.report);
        p.state.afterSend = () => { process.env.LANGFUSE_BASE_URL = 'http://127.0.0.1:1'; process.env.LANGFUSE_SECRET_KEY = 'changed-ambient-secret'; };
        await exportReport(p.report, file, undefined, p.root, { connection: p.connection });
        expect(readReport(file).export.status).toBe('complete');
        expect(p.state.projects).toBe(1); expect(p.sends).toHaveLength(1);
        expect(p.sends[0]!.auth).toBe('Basic ' + Buffer.from('synthetic-public:synthetic-secret').toString('base64'));
    } finally { await p.close(); }
});

test('historical upload receipts without a target remain readable but cannot be resent', async () => {
    const p = await platform();
    try {
        writeFileSync(p.sidecar, JSON.stringify({ backend: 'langfuse', status: 'error', error: 'Historical upload failure' }));
        const original = readFileSync(p.sidecar, 'utf8'), report = readReport(p.file);
        await expect(exportReport(report, p.file, undefined, p.root, { connection: p.connection })).rejects.toThrow('target');
        expect(readFileSync(p.sidecar, 'utf8')).toBe(original); expect(p.sends).toHaveLength(0);
    } finally { await p.close(); }
});

test('a supported inline report cannot lose its saved sidecar target when the project changes', async () => {
    const p = await platform();
    try {
        const directory = join(p.root, 'inline'); mkdirSync(directory);
        const file = join(directory, 'summary.json'), report = reportFixture(), original = JSON.stringify(report);
        writeFileSync(file, original);
        await exportReport(report, file, undefined, p.root, { connection: p.connection });
        const receipt = readFileSync(join(directory, 'export.json'), 'utf8');
        p.state.projectId = 'different-project';
        await expect(exportReport(readReport(file), file, undefined, p.root, { connection: p.connection })).rejects.toThrow('target');
        expect(p.sends).toHaveLength(1); expect(readFileSync(join(directory, 'export.json'), 'utf8')).toBe(receipt);
        expect(readFileSync(file, 'utf8')).toBe(original);
    } finally { await p.close(); }
});

test('unconfirmed OTEL visibility is rechecked without resending original observations', async () => {
    const p = await platform();
    try {
        p.state.unavailable = true;
        await exportReport(p.report, p.file, undefined, p.root, { connection: p.connection });
        expect(p.sends).toHaveLength(1);
        expect(readReport(p.file).export).toMatchObject({ status: 'pending', target: { projectId: 'synthetic-project' },
            progress: { acceptedEventIds: [], rejectedEventIds: [] } });
        p.state.unavailable = false;
        await exportReport(p.report, p.file, undefined, p.root, { connection: p.connection });
        expect(p.sends).toHaveLength(1);
        expect(readReport(p.file).export.status).toBe('complete');
    } finally { await p.close(); }
});

test('incomplete receipts do not invent rejected IDs for events without a receipt', async () => {
    const p = await platform();
    try {
        const first = exportEvents(p.report)[0]!.id;
        await exportReport(p.report, p.file, async () => ({ successes: [{ id: first }], errors: [] }), p.root, { connection: p.connection });
        expect(readReport(p.file).export).toMatchObject({ status: 'partial', progress: { acceptedEventIds: [first], rejectedEventIds: [] } });
    } finally { await p.close(); }
});

test('a confirmation save failure retains the pre-send target and rechecks without a second OTEL send', async () => {
    const p = await platform(), atomicJson = reportFiles.atomicJson;
    let writes = 0;
    const writing = spyOn(reportFiles, 'atomicJson').mockImplementation((file, value) => {
        if (file === p.sidecar && writes++ > 0) throw Error('Synthetic receipt save unavailable');
        atomicJson(file, value);
    });
    try {
        await expect(exportReport(p.report, p.file, undefined, p.root, { connection: p.connection })).rejects.toThrow('receipt save unavailable');
        expect(p.sends).toHaveLength(1);
        expect(readReport(p.file).export).toMatchObject({ status: 'pending', target: { projectId: 'synthetic-project' },
            progress: { acceptedEventIds: [], rejectedEventIds: [] } });
        writing.mockRestore();
        await exportReport(p.report, p.file, undefined, p.root, { connection: p.connection });
        expect(p.sends).toHaveLength(1);
        expect(readReport(p.file).export.status).toBe('complete');
        expect(readFileSync(p.file, 'utf8')).toBe(p.original);
    } finally { writing.mockRestore(); await p.close(); }
});
