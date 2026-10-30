import { afterEach, expect, test } from 'bun:test';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { createCurationService } from '../../src/curation/index.ts';
import { readTraceOperation, readTraceState, writeTraceOperation, traceFile } from '../../src/curation/store.ts';
import { relative } from 'node:path';
import type { TraceBundle } from '../../../packages/contracts/src/evaluation-loop.ts';
import { reportFixture } from '../support/fixtures.ts';
import { createArchive, archiveReference, writeArchivePart } from '../../src/reports/archive.ts';
import { saveReport } from '../../src/reports/store.ts';
import { reportTraces } from '../../src/execution/trace.ts';
import { buildObservationTree } from '../../src/langfuse/otel.ts';

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });
function root() { const value = mkdtempSync(join(tmpdir(), 'workflow-')); roots.push(value); return value; }
async function workflow() {
    const modulePath = '../../src/desktop/workflow.ts', module = await import(modulePath).catch(() => ({}));
    expect(module.dispatchWorkflow).toBeFunction(); return module;
}
const trace = (): TraceBundle => ({ id: randomUUID(), revision: 1, source: { kind: 'product' }, entry: 'chats', startedAt: '2026-10-28T00:00:00.000Z',
    endedAt: '2026-10-28T00:01:00.000Z', input: { prompt: 'Exact prompt' }, output: 'Original answer', status: 'completed', complete: true,
    gaps: [], configuration: {}, facts: {}, events: [], materials: [] });

for (const changed of [false, true]) test('Benchmark pull checks the original public observation tree: changed=' + changed, async () => {
    const repo = root(), { dispatchWorkflow } = await workflow(), report = reportFixture();
    const archive = createArchive(repo, { selection: 'smoke' }); report.runId = archive.id;
    saveReport(archiveReference(archive.file, 'executions', report.executionId), report);
    writeArchivePart(archiveReference(archive.file, 'snapshots', report.executionId), { dataset: report.dataset.id, cases: [], materials: [] });
    const original = reportTraces(report)[0]!, nodes = buildObservationTree(report);
    const rows = nodes.map((node, index) => ({ id: 'remote-' + index, traceId: node.traceId, name: node.name, type: node.type.toUpperCase(),
        startTime: node.start, endTime: node.end, input: node.input, output: changed && index === 0 ? 'Changed platform output' : node.output,
        parentObservationId: node.parentId ? 'remote-' + nodes.findIndex(parent => parent.id === node.parentId) : null,
        metadata: { ...node.metadata, localObservationId: node.id } }));
    const pulled = { ...original, output: rows[0]!.output, configuration: { platformProjection: true }, facts: { langfuseObservations: rows } };
    const result = await dispatchWorkflow(repo, { action: 'trace.pull', from: '2026-09-23T00:00:00Z', to: '2026-09-24T00:00:00Z' },
        { connection: { baseUrl: 'http://localhost:3000', publicKey: 'public', secretKey: 'secret' }, pullTraces: async () => [pulled] });
    expect(result.data.gaps).toEqual(changed ? ['local-platform-content-diff:' + original.id] : []);
    expect(createCurationService(repo).readTrace(original.id)).toEqual(original);
    expect(existsSync(join(repo, 'agent-eval/traces'))).toBe(false);
});
test('workflow settings are opt-in, persisted for Host reads, and never expose credentials', async () => {
    const repo = root(), { dispatchWorkflow, readObservabilitySettings } = await workflow();
    const first = await dispatchWorkflow(repo, { action: 'settings.get' }, { env: { LANGFUSE_SECRET_KEY: 'private-workflow-secret' } });
    expect(first.data.settings).toEqual({ capture: false, upload: false, mining: false });
    expect(JSON.stringify(first)).not.toContain('private-workflow-secret'); expect(existsSync(join(repo, 'agent-eval/configs'))).toBe(false);
    await dispatchWorkflow(repo, { action: 'settings.save', settings: { capture: true, upload: false, mining: true } }, { env: {} });
    expect(readObservabilitySettings(repo)).toEqual({ capture: true, upload: false, mining: true });
    expect(JSON.parse(readFileSync(join(repo, 'agent-eval/configs/observability.json'), 'utf8'))).toEqual({ capture: true, upload: false, mining: true });
    await expect(dispatchWorkflow(repo, { action: 'settings.save', settings: { capture: 'yes', upload: false, mining: false } })).rejects.toThrow();
});
test('workflow rejects malformed read ranges before invoking Langfuse', async () => {
    const repo = root(), { dispatchWorkflow } = await workflow(); let calls = 0;
    await expect(dispatchWorkflow(repo, { action: 'trace.pull', from: '2026-10-29T00:00:00Z', to: '2026-10-28T00:00:00Z' },
        { pullTraces: async () => { calls++; return []; } })).rejects.toThrow();
    expect(calls).toBe(0);
});

test('Langfuse readback preserves the original local Trace and stores the remote projection separately', async () => {
    const repo = root(), bundle = trace(), { dispatchWorkflow } = await workflow(), curation = createCurationService(repo);
    curation.saveTrace(bundle);
    const remote = { ...bundle, output: 'Different platform output', facts: { langfuseObservations: [] } };
    const result = await dispatchWorkflow(repo, { action: 'trace.pull', from: bundle.startedAt, to: '2026-10-29T00:00:00.000Z' },
        { connection: { baseUrl: 'http://localhost:3000', publicKey: 'public', secretKey: 'secret' }, pullTraces: async () => [remote] });
    expect(curation.readTrace(bundle.id)).toEqual(bundle);
    expect(result.data.items[0]).toEqual(bundle);
    expect(result.data.gaps).toContain('local-platform-content-diff:' + bundle.id);
    expect(readTraceState(repo, bundle.id).platformSnapshot!.trace.output).toBe('Different platform output');
});
test('automatic mining is off by default and an explicit request uses the independent native Luna configuration', async () => {
    const repo = root(), bundle = trace(), { dispatchWorkflow } = await workflow(); createCurationService(repo).saveTrace(bundle);
    let calls = 0;
    const nativeRunner = async (_executable: string, args: string[]) => {
        calls++; if (args[0] === '--version') return { code: 0, stdout: 'codex-test', stderr: '' };
        expect(args).toContain('gpt-6-luna'); expect(args).toContain('model_reasoning_effort="max"');
        const draft = { reason: 'Original output requires independent source review.', sourceLabels: ['source-review-pending'], bindings: [] };
        return { code: 0, stderr: '', stdout: JSON.stringify({ type: 'item.completed', item: { type: 'agent_message', text: JSON.stringify({ draftJson: JSON.stringify(draft) }) } }) + '\n' +
            JSON.stringify({ type: 'turn.completed', usage: { input_tokens: 1, output_tokens: 1 } }) };
    };
    const input = { action: 'mine', operationId: randomUUID(), traceId: bundle.id, expectedRevision: 1, kind: 'bad' };
    await dispatchWorkflow(repo, { action: 'trace.process', traceId: bundle.id }, { nativeRunner, env: {} }); expect(calls).toBe(0);
    const result = await dispatchWorkflow(repo, input, { nativeRunner, env: {} });
    expect(result.data.operation.status).toBe('completed'); expect(calls).toBe(2);
    const call = readTraceOperation(repo, bundle.id, 'models', input.operationId) as any;
    expect(call.configuration).toMatchObject({ provider: 'codex-cli', model: 'gpt-6-luna', reasoningEffort: 'max' });
    expect(call.observed).toMatchObject({ cliVersion: 'codex-test', responseModel: null, usage: { input_tokens: 1, output_tokens: 1 }, usageSource: 'codex-cli' });
    expect(call.status).toBe('completed'); expect(call.error).toBeNull();
    expect((await dispatchWorkflow(repo, input, { nativeRunner, env: {} })).data.operation.candidateId).toBe(result.data.operation.candidateId); expect(calls).toBe(2);
});
test('unknown Trace upload is recorded before transport and never automatically submitted twice', async () => {
    const repo = root(), bundle = trace(), { dispatchWorkflow } = await workflow(); createCurationService(repo).saveTrace(bundle);
    await dispatchWorkflow(repo, { action: 'settings.save', settings: { capture: false, upload: true, mining: false } }, { env: {} });
    let sends = 0; const operationId = randomUUID(), deps = { env: {}, connection: { baseUrl: 'https://example.com', publicKey: 'public', secretKey: 'secret' },
        queryProjects: async () => ({ data: [{ id: 'controlled-project' }] }),
        sendTrace: async () => { sends++; expect(readTraceOperation(repo, bundle.id, 'uploads', operationId)).toMatchObject({ status: 'unknown' }); throw Error('Remote outcome unknown'); },
        pullTraces: async () => [] };
    const input = { action: 'trace.upload', traceId: bundle.id, expectedRevision: 1, operationId };
    const first = await dispatchWorkflow(repo, input, deps); expect(first.data.operation.status).toBe('unknown'); expect(first.exitCode).toBe(2);
    expect((await dispatchWorkflow(repo, input, deps)).data.operation).toEqual(first.data.operation); expect(sends).toBe(1);
});
for (const status of ['verified', 'unknown'] as const) for (const change of ['project', 'address'] as const)
test('Trace upload ' + status + ' receipt rejects a changed ' + change + ' without resending or rewriting', async () => {
    const repo = root(), bundle = trace(), { dispatchWorkflow } = await workflow(); createCurationService(repo).saveTrace(bundle);
    let sends = 0, project = 'project-original';
    const input = { action: 'trace.upload', traceId: bundle.id, expectedRevision: 1, operationId: randomUUID() };
    const deps = { env: {}, connection: { baseUrl: 'https://original.example.com', publicKey: 'public-original', secretKey: 'secret-original' },
        queryProjects: async () => ({ data: [{ id: project }] }),
        sendTrace: async () => { sends++; if (status === 'unknown') throw Error('Remote outcome unknown');
            return { traceIds: [bundle.id.replaceAll('-', '')], observationIds: ['saved-root'] }; },
        pullTraces: async () => status === 'unknown' ? [] : [{ ...bundle, facts: { langfuseObservations: [{ id: 'saved-root', traceId: bundle.id.replaceAll('-', ''),
            name: 'Flowmate · chats', type: 'AGENT', startTime: bundle.startedAt, endTime: bundle.endedAt, input: bundle.input, output: bundle.output,
            metadata: { localObservationId: bundle.id.replaceAll('-', '') + ':root', configuration: {}, flowmate: true,
                sourceKind: 'product', kind: 'product', entry: 'chats', revision: 1, materials: [], status: 'completed' } }] } }] };
    const first = await dispatchWorkflow(repo, input, deps); expect(first.data.operation.status).toBe(status);
    const path = traceFile(repo, bundle.id);
    const original = readFileSync(path, 'utf8');
    expect(JSON.parse(original).operations.uploads[input.operationId].target).toEqual({ baseUrl: 'https://original.example.com', projectId: 'project-original' });
    expect(original).not.toContain('public-original'); expect(original).not.toContain('secret-original');
    await expect(dispatchWorkflow(repo, { ...input, operationId: randomUUID() }, deps)).rejects.toThrow('original upload operation');
    expect(readFileSync(path, 'utf8')).toBe(original);
    if (change === 'project') project = 'project-other'; else deps.connection.baseUrl = 'https://other.example.com';
    await expect(dispatchWorkflow(repo, input, deps)).rejects.toThrow('target differs');
    expect(sends).toBe(1); expect(readFileSync(path, 'utf8')).toBe(original);
});
test('Trace upload requires one actual project before recording or sending', async () => {
    const repo = root(), bundle = trace(), { dispatchWorkflow } = await workflow();
    createCurationService(repo).saveTrace(bundle); let sends = 0;
    const request = { action: 'trace.upload', traceId: bundle.id, expectedRevision: 1, operationId: randomUUID() };
    await expect(dispatchWorkflow(repo, request, { env: {}, connection: { baseUrl: 'https://example.com', publicKey: 'public', secretKey: 'secret' },
        queryProjects: async () => ({ data: [{ id: 'project-a' }, { id: 'project-b' }] }),
        sendTrace: async () => { sends++; return { traceIds: [], observationIds: [] }; } })).rejects.toThrow('unique project');
    expect(sends).toBe(0); expect(readTraceOperation(repo, bundle.id, 'uploads', request.operationId)).toBeUndefined();
});
for (const revision of [1, 2]) test('a fresh operation cannot resubmit an already attempted Trace at revision ' + revision, async () => {
    const repo = root(), bundle = trace(), { dispatchWorkflow } = await workflow(), curation = createCurationService(repo); curation.saveTrace(bundle);
    let sends = 0;
    const deps = { env: {}, connection: { baseUrl: 'https://original.example.com', publicKey: 'public', secretKey: 'secret' },
        queryProjects: async () => ({ data: [{ id: 'original-project' }] }),
        sendTrace: async () => { sends++; throw Error('Remote outcome unknown'); }, pullTraces: async () => [] };
    const input = { action: 'trace.upload', traceId: bundle.id, expectedRevision: 1, operationId: randomUUID() };
    await dispatchWorkflow(repo, input, deps);
    const receipt = () => JSON.stringify(readTraceOperation(repo, bundle.id, 'uploads', input.operationId)), original = receipt();
    if (revision === 2) curation.saveTrace({ ...bundle, revision: 2, output: 'Later original output' });
    const next = { ...input, expectedRevision: revision, operationId: randomUUID() };
    await expect(dispatchWorkflow(repo, next, deps)).rejects.toThrow('original upload operation');
    expect(sends).toBe(1); expect(receipt()).toBe(original);
    expect(readTraceOperation(repo, bundle.id, 'uploads', next.operationId)).toBeUndefined();
    const { createWorkflowRecordReader } = await import('../../src/desktop/workflow-records.ts');
    const shown = await dispatchWorkflow(repo, { action: 'trace.show', traceId: bundle.id }, { desktopReader: createWorkflowRecordReader(repo) });
    expect(shown.data.trace.uploadEligible).toBe(false); expect(shown.data.trace.uploadReason).toContain(input.operationId);
});
test('missing Gate evidence is blocked with exit code 2 and read actions stay available during work', async () => {
    const repo = root(), { dispatchWorkflow, isWorkflowReadOnly } = await workflow();
    expect(isWorkflowReadOnly('experiment.show')).toBe(true); expect(isWorkflowReadOnly('experiment.run')).toBe(false);
    const gate = await dispatchWorkflow(repo, { action: 'gate.check', baselineId: 'missing', experimentId: 'missing', armId: 'candidate', fullRelease: true });
    expect(gate.exitCode).toBe(2); expect(gate.data.gate.status).toBe('blocked');
});
test('a requested replay cannot bypass missing independent proof or fabricate a passing replay', async () => {
    const repo = root(), bundle = trace(), { dispatchWorkflow } = await workflow(), curation = createCurationService(repo);
    curation.saveTrace(bundle);
    const candidate = curation.saveCandidate({ id: randomUUID(), revision: 1, kind: 'bad', traceRef: { id: bundle.id, revision: 1 },
        reason: 'Unverified original output', sourceLabels: ['independent-proof-pending'] });
    let replays = 0;
    const result = await dispatchWorkflow(repo, { action: 'candidate.validate', candidateId: candidate.id, expectedRevision: 1, replay: true },
        { replay: async () => { replays++; return { status: 'PASS', kind: 'controlled', reason: 'Must never run' }; } });
    expect(result.exitCode).toBe(2); expect(result.data.validation.replay.status).toBe('NOT_RUN'); expect(replays).toBe(0);
});
test('a normally completed wrong answer can produce linked blocked Bad and Regression candidates once', async () => {
    const repo = root(), bundle = trace(), { dispatchWorkflow } = await workflow(), curation = createCurationService(repo);
    bundle.input.prompt = 'What is 2 + 2?'; bundle.output = '5'; curation.saveTrace(bundle);
    await dispatchWorkflow(repo, { action: 'settings.save', settings: { capture: true, upload: false, mining: true } }, { env: {} });
    let generations = 0;
    const deps = { env: {}, generateJSON: async (request: { system: string }) => {
        generations++;
        if (request.system.startsWith('Triage')) return { quality: 'suspected-failure', failureKind: 'business', reason: 'The completed answer contradicts the requested arithmetic.', evidence: ['Original prompt and answer'] };
        return { reason: 'Suspected quality failure; independent Case proof is still missing.', sourceLabels: ['original-prompt-output'] };
    } };
    await dispatchWorkflow(repo, { action: 'trace.process', traceId: bundle.id }, deps);
    const items = curation.listCandidates(); expect(items.map(item => item.kind).sort()).toEqual(['bad', 'regression']);
    expect(items.every(item => item.status === 'blocked')).toBe(true); expect(generations).toBe(2);
    const bad = items.find(item => item.kind === 'bad')!, regression = items.find(item => item.kind === 'regression')!;
    expect(regression.review!.parentCandidateId).toBe(bad.id);
    await dispatchWorkflow(repo, { action: 'trace.process', traceId: bundle.id }, deps); expect(generations).toBe(2);
});

test('a triaged business failure saves a blocked Bad signal before the sole Regression generation and retains it after timeout', async () => {
    const repo = root(), bundle = trace(), { dispatchWorkflow } = await workflow(), curation = createCurationService(repo);
    curation.saveTrace(bundle);
    await dispatchWorkflow(repo, { action: 'settings.save', settings: { capture: true, upload: false, mining: true } }, { env: {} });
    let calls = 0;
    const deps = { env: {}, generateJSON: async (request: { system: string; prompt: string }) => {
        calls++;
        if (request.system.startsWith('Triage')) return { quality: 'suspected-failure', failureKind: 'business', reason: 'Seller name includes a separately labelled address.', evidence: ['/facts/scores/0', '/output'] };
        expect(JSON.parse(request.prompt).kind).toBe('regression');
        expect(curation.listCandidates('bad')).toHaveLength(1);
        throw Object.assign(Error('Controlled Regression deadline expired'), { stopConfirmed: true });
    } };
    const first = await dispatchWorkflow(repo, { action: 'trace.process', traceId: bundle.id }, deps);
    expect(first.data.mining.status).toBe('unknown'); expect(calls).toBe(2);
    const bad = curation.listCandidates('bad'); expect(bad).toHaveLength(1);
    expect(bad[0]).toMatchObject({ kind: 'bad', status: 'blocked', review: { source: 'agent', classification: 'suspected' } });
    expect(bad[0]!.case).toBeUndefined(); expect(bad[0]!.gold).toBeUndefined();
    expect(bad[0]!.reason).toContain('Seller name'); expect(curation.listCandidates('regression')).toEqual([]);
    const second = await dispatchWorkflow(repo, { action: 'trace.process', traceId: bundle.id }, deps);
    expect(second.data.mining.status).toBe('unknown'); expect(calls).toBe(2);
    expect(curation.listCandidates('bad').map(item => item.id)).toEqual([bad[0]!.id]);
});

test.each([true, false])('legacy unknown Bad model operation only recovers its signal and never dispatches another model (stopConfirmed=%s)', async stopConfirmed => {
    const repo = root(), bundle = trace(), { dispatchWorkflow } = await workflow(), curation = createCurationService(repo);
    curation.saveTrace(bundle);
    await dispatchWorkflow(repo, { action: 'settings.save', settings: { capture: true, upload: false, mining: true } }, { env: {} });
    const operations = { uploadOperationId: randomUUID(), triageOperationId: randomUUID(), miningOperationIds: { gold: randomUUID(), bad: randomUUID(), regression: randomUUID() } };
    writeTraceOperation(repo, bundle.id, 'processing', '1', operations);
    writeTraceOperation(repo, bundle.id, 'triage', operations.triageOperationId, { operationId: operations.triageOperationId, traceId: bundle.id, revision: 1,
        at: bundle.startedAt, source: 'agent', status: 'completed', reason: 'Observed triage classification', conditions: curation.readTrace(bundle.id),
        classification: { quality: 'suspected-failure', failureKind: 'business', reason: 'Name includes unrelated address.', evidence: ['/output', '/facts/scores'] } });
    writeTraceOperation(repo, bundle.id, 'mining', operations.miningOperationIds.bad, { request: { operationId: operations.miningOperationIds.bad, traceId: bundle.id, expectedRevision: 1, kind: 'bad' },
        status: 'unknown', at: bundle.startedAt, reason: 'Original Bad draft deadline expired; outcome unknown.', stopConfirmed });
    const receipt = () => JSON.stringify(readTraceOperation(repo, bundle.id, 'mining', operations.miningOperationIds.bad)), original = receipt(); let calls = 0;
    const deps = { env: {}, generateJSON: async () => { calls++; return { reason: 'Must not dispatch', sourceLabels: ['pending'] }; } };
    for (let i = 0; i < 2; i++) {
        const result = await dispatchWorkflow(repo, { action: 'trace.process', traceId: bundle.id }, deps);
        expect(result.data.mining.status).toBe('unknown'); expect(result.data.mining.stopConfirmed).toBe(stopConfirmed);
    }
    expect(calls).toBe(0); expect(receipt()).toBe(original);
    expect(curation.listCandidates()).toHaveLength(1);
    expect(curation.readCandidate(operations.miningOperationIds.bad)).toMatchObject({ kind: 'bad', status: 'blocked', review: { source: 'agent',
        originalPointer: { path: relative(repo, traceFile(repo, bundle.id)).replaceAll('\\', '/'), revision: 1 } } });
    expect(readTraceOperation(repo, bundle.id, 'mining', operations.miningOperationIds.regression)).toBeUndefined();
});
test('unknown automatic triage retains unconfirmed termination and never starts another model call', async () => {
    const repo = root(), bundle = trace(), { dispatchWorkflow } = await workflow(); createCurationService(repo).saveTrace(bundle);
    await dispatchWorkflow(repo, { action: 'settings.save', settings: { capture: true, upload: false, mining: true } }, { env: {} });
    let calls = 0; const deps = { env: {}, generateJSON: async () => { calls++; throw Object.assign(Error('termination unconfirmed'), { stopConfirmed: false }); } };
    const first = await dispatchWorkflow(repo, { action: 'trace.process', traceId: bundle.id }, deps);
    expect(first.exitCode).toBe(2); expect(first.data.mining.stopConfirmed).toBe(false);
    await dispatchWorkflow(repo, { action: 'trace.process', traceId: bundle.id }, deps); expect(calls).toBe(1);
});
test('explicit upload is verified by matching original observations and never sends the same operation again', async () => {
    const repo = root(), bundle = trace(), { dispatchWorkflow } = await workflow(); createCurationService(repo).saveTrace(bundle);
    let sends = 0, correctName = false;
    const deps = { env: {}, connection: { baseUrl: 'https://example.com', publicKey: 'public', secretKey: 'secret' },
        queryProjects: async () => ({ data: [{ id: 'controlled-project' }] }),
        sendTrace: async () => { sends++; return { traceIds: [bundle.id.replaceAll('-', '')], observationIds: ['saved-root'] }; },
        pullTraces: async () => [{ ...bundle, facts: { langfuseObservations: [{ id: 'saved-root', traceId: bundle.id.replaceAll('-', ''),
            name: correctName ? 'Flowmate · chats' : 'Wrong observation', type: 'AGENT', startTime: bundle.startedAt, endTime: bundle.endedAt,
            metadata: { localObservationId: bundle.id.replaceAll('-', '') + ':root', configuration: {}, flowmate: true,
                sourceKind: 'product', kind: 'product', entry: 'chats', revision: 1, materials: [], status: 'completed' }, input: bundle.input, output: bundle.output }] } }] };
    const input = { action: 'trace.upload', traceId: bundle.id, expectedRevision: 1, operationId: randomUUID() };
    const first = await dispatchWorkflow(repo, input, deps); expect(first.exitCode).toBe(2); expect(first.data.operation.status).toBe('submitted');
    correctName = true;
    const result = await dispatchWorkflow(repo, input, deps); expect(result.exitCode).toBe(0); expect(result.data.operation.status).toBe('verified');
    expect((await dispatchWorkflow(repo, input, deps)).data.operation.status).toBe('verified'); expect(sends).toBe(1);
});

for (const copy of ['evaluation', 'platform-import'] as const) test('generic upload refuses ' + copy + ' before any submission', async () => {
    const repo = root(), bundle = trace(), { dispatchWorkflow } = await workflow();
    if (copy === 'evaluation') bundle.source = { kind: 'evaluation', executionId: 'controlled-execution', trialId: 'controlled-trial' };
    else bundle.facts.langfuseObservations = [];
    if (copy === 'evaluation') { expect(() => createCurationService(repo).saveTrace(bundle)).toThrow('derived'); return; }
    createCurationService(repo).saveTrace(bundle); let sends = 0;
    const request = { action: 'trace.upload', traceId: bundle.id, expectedRevision: 1, operationId: randomUUID() };
    await expect(dispatchWorkflow(repo, request, { env: {}, connection: { baseUrl: 'https://example.com', publicKey: 'public', secretKey: 'secret' },
        sendTrace: async () => { sends++; return { traceIds: [], observationIds: [] }; }, pullTraces: async () => [] })).rejects.toThrow();
    expect(sends).toBe(0); expect(readTraceState(repo, bundle.id).operations.uploads).toBeUndefined();
});
test('successful completion may draft Gold while infrastructure failures never create automatic business regressions', async () => {
    const repo = root(), { dispatchWorkflow } = await workflow(), curation = createCurationService(repo), successful = trace(), failed = trace();
    failed.status = 'error'; failed.facts = { error: { infrastructure: true } } as any;
    curation.saveTrace(successful); curation.saveTrace(failed);
    await dispatchWorkflow(repo, { action: 'settings.save', settings: { capture: true, upload: false, mining: true } }, { env: {} });
    const deps = { env: {}, generateJSON: async (request: { system: string }) => request.system.startsWith('Triage')
        ? { quality: 'supported-success', failureKind: 'unknown', reason: 'Independently supported candidate for review', evidence: ['Source material'] }
        : { reason: 'Independent expectations are pending', sourceLabels: ['source-review-pending'] } };
    await dispatchWorkflow(repo, { action: 'trace.process', traceId: successful.id }, deps);
    await dispatchWorkflow(repo, { action: 'trace.process', traceId: failed.id }, deps);
    expect(curation.listCandidates().filter(candidate => candidate.traceRef.id === successful.id).map(candidate => candidate.kind)).toEqual(['gold']);
    expect(curation.listCandidates().filter(candidate => candidate.traceRef.id === failed.id).map(candidate => candidate.kind)).toEqual(['bad']);
});
test('show returns persisted Trace and Candidate feedback without changing original status or needing another review', async () => {
    const repo = root(), bundle = trace(), { dispatchWorkflow } = await workflow(), curation = createCurationService(repo); curation.saveTrace(bundle);
    const candidate = curation.saveCandidate({ id: randomUUID(), revision: 1, kind: 'bad', traceRef: { id: bundle.id, revision: 1 },
        reason: 'Original result needs review', sourceLabels: ['source-review-pending'] });
    const operationId = randomUUID();
    await dispatchWorkflow(repo, { action: 'candidate.review', operationId, target: { kind: 'candidate-review', id: candidate.id, revision: 1 },
        reviewer: 'Human', source: 'human', verdict: 'needs-work', note: 'Independent proof is missing.' });
    const shown = await dispatchWorkflow(repo, { action: 'candidate.show', candidateId: candidate.id });
    expect(shown.data.feedback[0].id).toBe(operationId); expect(shown.data.candidate.revision).toBe(1);
    await dispatchWorkflow(repo, { action: 'trace.feedback', operationId: randomUUID(), target: { kind: 'trace-feedback', id: bundle.id, revision: 1 },
        reviewer: 'Human', source: 'human', verdict: 'bad', note: 'The original answer needs correction.' });
    const traceView = await dispatchWorkflow(repo, { action: 'trace.show', traceId: bundle.id });
    expect(traceView.data.feedback[0].verdict).toBe('bad'); expect(traceView.data.trace).toEqual(bundle);
});
test('automatic triage and mining preserve separate actual native model metadata', async () => {
    const repo = root(), bundle = trace(), { dispatchWorkflow } = await workflow(); createCurationService(repo).saveTrace(bundle);
    await dispatchWorkflow(repo, { action: 'settings.save', settings: { capture: true, upload: false, mining: true } }, { env: {} });
    const nativeRunner = async (_executable: string, args: string[], options: { stdin: string }) => {
        if (args[0] === '--version') return { code: 0, stdout: 'codex-observed', stderr: '' };
        const input = JSON.parse(options.stdin);
        const value = 'source' in input ? { quality: 'supported-success', failureKind: 'unknown', reason: 'Supported signal; still needs independent validation', evidence: ['Original input and output'] }
            : { draftJson: JSON.stringify({ reason: 'Independent case proof is pending', sourceLabels: ['source-review-pending'] }) };
        return { code: 0, stderr: '', stdout: JSON.stringify({ type: 'item.completed', item: { type: 'agent_message', text: JSON.stringify(value), model: 'actual-response-model' } }) + '\n' +
            JSON.stringify({ type: 'turn.completed', usage: { input_tokens: 10, output_tokens: 3 } }) };
    };
    await dispatchWorkflow(repo, { action: 'trace.process', traceId: bundle.id }, { env: {}, nativeRunner });
    const calls = Object.values(readTraceState(repo, bundle.id).operations.models ?? {}) as any[];
    expect(calls.map(call => call.role).sort()).toEqual(['mining', 'triage']);
    expect(calls.every(call => call.status === 'completed' && call.observed.responseModel === 'actual-response-model' && call.observed.cliVersion === 'codex-observed')).toBe(true);
});
test('native mining errors retain observed CLI metadata and never persist configured credentials or retry', async () => {
    const repo = root(), bundle = trace(), { dispatchWorkflow } = await workflow(); createCurationService(repo).saveTrace(bundle);
    const secret = 'workflow-private-subject-key-for-error-control'; let calls = 0;
    const nativeRunner = async (_executable: string, args: string[]) => {
        calls++;
        return args[0] === '--version' ? { code: 0, stdout: 'codex-error-observed', stderr: '' }
            : { code: 1, stdout: '', stderr: 'Synthetic transport diagnostic ' + secret };
    };
    const input = { action: 'mine', traceId: bundle.id, expectedRevision: 1, operationId: randomUUID(), kind: 'bad' };
    const deps = { env: { FLOWMATE_EVAL_AGENT_API_KEY: secret }, nativeRunner };
    const result = await dispatchWorkflow(repo, input, deps); expect(result.data.operation.status).toBe('unknown');
    const text = JSON.stringify(readTraceOperation(repo, bundle.id, 'models', input.operationId)), call = JSON.parse(text);
    expect(call.status).toBe('error'); expect(call.observed).toMatchObject({ cliVersion: 'codex-error-observed', responseModel: null, usage: null, usageSource: 'unknown' });
    expect(call.error.message).toContain('Native model exit 1'); expect(call.stopConfirmed).toBe(true);
    expect(text).not.toContain(secret); expect(result.data.operation.reason).not.toContain(secret);
    await dispatchWorkflow(repo, input, deps); expect(calls).toBe(2);
});
test('native miner receives runtime contract domains and real material references instead of inventing metric or tool names', async () => {
    const repo = root(), bundle = trace(), { dispatchWorkflow } = await workflow();
    bundle.materials = [{ id: 'independent-source', path: 'materials/sample-a/source.md', text: 'An independent user material.' }];
    createCurationService(repo).saveTrace(bundle);
    let checked = false;
    const nativeRunner = async (_executable: string, args: string[], options: { stdin: string }) => {
        if (args[0] === '--version') return { code: 0, stdout: 'contract-provider', stderr: '' };
        const data = JSON.parse(options.stdin);
        expect(data.contract.registeredToolNames).toContain('read_invoice_document');
        expect(data.contract.taskCheckMetrics).toEqual(['fact-check', 'reference-fields', 'line-items']);
        expect(data.contract.judgeMetricIds).not.toContain('answer');
        expect(data.contract.schema.properties.case.properties.expected.properties.maxToolCalls.type).toBe('integer');
        expect(data.contract.materials[0]).toMatchObject({ materialId: 'independent-source', path: 'materials/sample-a/source.md',
            replayReference: { source: 'local-text', sample: 'sample-a', file: 'source.md' } });
        expect(data.contract.rules.factCheckPath).toContain('array');
        expect(data.contract.example.gold.checks[0]).toMatchObject({ metric: 'fact-check', path: [], equals: 'EXAMPLE_VALUE' });
        expect(data.task.trace.input.prompt).toBe(bundle.input.prompt); checked = true;
        const value = { draftJson: JSON.stringify({ reason: 'Independent expectations are pending', sourceLabels: ['user-source'] }) };
        return { code: 0, stderr: '', stdout: JSON.stringify({ type: 'item.completed', item: { type: 'agent_message', text: JSON.stringify(value) } }) + '\n' + JSON.stringify({ type: 'turn.completed' }) };
    };
    const result = await dispatchWorkflow(repo, { action: 'mine', traceId: bundle.id, expectedRevision: 1, operationId: randomUUID(), kind: 'gold' }, { env: {}, nativeRunner });
    expect(result.data.operation.status).toBe('completed'); expect(checked).toBe(true);
});
test('native maintenance summaries upload normally while automatic triage and candidate mining are skipped', async () => {
    const repo = root(), bundle = trace(), { dispatchWorkflow } = await workflow();
    bundle.entry = 'evaluation'; bundle.source = { kind: 'product', sessionId: '1' };
    bundle.configuration = { purpose: 'native-maintenance' }; bundle.facts = { compaction: { operation: { id: 1, kind: 'manual' } } };
    createCurationService(repo).saveTrace(bundle);
    await dispatchWorkflow(repo, { action: 'settings.save', settings: { capture: true, upload: true, mining: true } }, { env: {} });
    let uploads = 0, miningCalls = 0;
    const result = await dispatchWorkflow(repo, { action: 'trace.process', traceId: bundle.id }, { env: {},
        connection: { baseUrl: 'https://example.com', publicKey: 'public', secretKey: 'secret' },
        queryProjects: async () => ({ data: [{ id: 'controlled-project' }] }),
        sendTrace: async (value: TraceBundle) => { uploads++; expect(value).toEqual(bundle); return { traceIds: [bundle.id.replaceAll('-', '')], observationIds: ['native-summary'] }; },
        pullTraces: async () => [], generateJSON: async () => { miningCalls++; throw Error('Maintenance must not invoke the business miner'); } });
    expect(uploads).toBe(1); expect(miningCalls).toBe(0);
    expect(result.data.mining).toMatchObject({ enabled: true, status: 'skipped' }); expect(result.data.mining.reason).toContain('maintenance');
});
test('incomplete terminal traces create one blocked Bad evidence-gap clue without upload, model calls or business regression', async () => {
    const repo = root(), bundle = trace(), { dispatchWorkflow } = await workflow(), curation = createCurationService(repo);
    bundle.complete = false; bundle.gaps = ['Tool output could not be captured']; curation.saveTrace(bundle);
    await dispatchWorkflow(repo, { action: 'settings.save', settings: { capture: true, upload: true, mining: true } }, { env: {} });
    let uploads = 0, models = 0;
    const deps = { env: {}, sendTrace: async () => { uploads++; throw Error('Incomplete traces must not be uploaded'); },
        generateJSON: async () => { models++; throw Error('A capture gap needs no model inference'); } };
    for (let i = 0; i < 2; i++) await dispatchWorkflow(repo, { action: 'trace.process', traceId: bundle.id }, deps);
    const items = curation.listCandidates(); expect(items).toHaveLength(1);
    expect(items[0]).toMatchObject({ kind: 'bad', status: 'blocked', traceRef: { id: bundle.id, revision: 1 },
        review: { source: 'execution-facts', sourceGaps: ['Tool output could not be captured'] } });
    expect(items[0]!.validation!.issues).toContain('Source trace is incomplete'); expect(uploads).toBe(0); expect(models).toBe(0);
    expect(curation.readTrace(bundle.id)).toEqual(bundle);
    const running = { ...bundle, id: randomUUID(), endedAt: null, status: 'running' as const }; curation.saveTrace(running);
    await dispatchWorkflow(repo, { action: 'trace.process', traceId: running.id }, deps); expect(curation.listCandidates()).toHaveLength(1);
});
test('triage and all candidate miners use the identical bounded Trace view and record actual requested bytes', async () => {
    const repo = root(), bundle = trace(), { dispatchWorkflow } = await workflow(), curation = createCurationService(repo);
    bundle.events = [{ id: 'tool', kind: 'tool', name: 'save_invoice_candidate', input: { raw: { amount: 1 }, final: { amount: 2 } }, output: { status: 'succeeded', candidateId: 1 } },
        { id: 'generation', kind: 'generation', name: 'Model', input: { messages: [{ content: 'FULL_SDK_COPY'.repeat(50000) }] }, output: { content: 'Original observed reply' } }];
    bundle.facts = { scores: [{ metricId: 'reference-fields', status: 'FAIL', required: true }] }; curation.saveTrace(bundle);
    await dispatchWorkflow(repo, { action: 'settings.save', settings: { capture: true, upload: false, mining: true } }, { env: {} });
    const requests: any[] = [];
    const nativeRunner = async (_executable: string, args: string[], options: { stdin: string }) => {
        if (args[0] === '--version') return { code: 0, stdout: 'view-provider', stderr: '' };
        const input = JSON.parse(options.stdin); requests.push(input);
        const value = 'source' in input ? { quality: 'suspected-failure', failureKind: 'business', reason: 'Actual required field failure', evidence: ['Original required score and tool parameters'] }
            : { draftJson: JSON.stringify({ reason: 'Original failure signal; independent expectations pending', sourceLabels: ['original-score'] }) };
        return { code: 0, stderr: '', stdout: JSON.stringify({ type: 'item.completed', item: { type: 'agent_message', text: JSON.stringify(value) } }) + '\n' + JSON.stringify({ type: 'turn.completed' }) };
    };
    await dispatchWorkflow(repo, { action: 'trace.process', traceId: bundle.id }, { env: {}, nativeRunner });
    expect(requests).toHaveLength(2); expect(requests[1].task.trace).toEqual(requests[0]);
    expect(JSON.stringify(requests).includes('FULL_SDK_COPY')).toBe(false); expect(requests[0].audit.omitted.length).toBeGreaterThan(0);
    const models = Object.values(readTraceState(repo, bundle.id).operations.models ?? {}) as any[];
    expect(models).toHaveLength(2); expect(models.every(model => model.requestedInput.dataUtf8Bytes > 0 && model.requestedInput.view.viewJsonBytes <= 192 * 1024)).toBe(true);
    expect(curation.readTrace(bundle.id)).toEqual(bundle);
});
