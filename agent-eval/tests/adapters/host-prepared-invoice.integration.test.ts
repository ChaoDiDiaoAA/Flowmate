import { syntheticNativeModel } from '../support/native-model.ts';
import { expect, test } from 'bun:test';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createHash } from 'node:crypto';
import { createHttpProvider, mkdtempSync } from '../../../tests/support/resources.ts';
import { prepareHostTrial } from '../../src/adapters/host-research.ts';
import { REPO_ROOT } from '../../src/dataset-loader/local.ts';
import type { AgentTrial, AgentTrialSession } from '../../src/adapters/agent.ts';
import { CandidateDraftSchema, invoiceHeaderFields } from '../../../packages/contracts/src/invoice.ts';
import { findDataset } from '../../src/execution/runner.ts';
import { prepareSafetyProbes } from '../../src/execution/safety-probes.ts';
import { evaluateAll } from '../../src/scoring/evaluate.ts';

const digest = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex');
test('the actual Host registers declared PDF pages as a selected Document without exposing its preparation contract', async () => {
    const root = mkdtempSync(join(tmpdir(), 'eval-prepared-pdf-')), sample = 'synthetic-three-page';
    const materialRoot = join(root, 'materials', sample); mkdirSync(materialRoot, { recursive: true });
    const original = readFileSync(new URL('../../../tests/fixtures/eval-prepared-invoice/three-pages.pdf', import.meta.url));
    const text = '# Declared synthetic PDF extraction\n' + ['Page one synthetic item A', 'Page two synthetic item B', 'Page three synthetic total 3.00']
        .map((line, index) => `\n## 原件第${index + 1}页（共3页）\n\n${line}\n`).join('');
    writeFileSync(join(materialRoot, 'source.md'), text); writeFileSync(join(materialRoot, 'original.pdf'), original);
    const requests: unknown[] = [];
    let document: { documentRef: { id: number; version: string }; parsedArtifactId: number };
    const server = await createHttpProvider(async request => {
        requests.push(await request.json());
        const tool = requests.length === 1;
        const delta = tool ? { role: 'assistant', tool_calls: [{ index: 0, id: 'prepared-page-three', type: 'function', function: {
            name: 'read_invoice_document', arguments: JSON.stringify({ documentId: document.documentRef.id, page: 3, afterBlockId: null, limit: 10 }) } }] }
            : { role: 'assistant', content: 'The original third page says synthetic total 3.00.' };
        const chunk = (delta: object, finish: string | null) => `data: ${JSON.stringify({ id: 'prepared-fixture', choices: [{ index: 0, delta, finish_reason: finish }] })}\n\n`;
        return new Response(chunk(delta, null) + chunk({}, tool ? 'tool_calls' : 'stop') + 'data: [DONE]\n\n', { headers: { 'content-type': 'text/event-stream' } });
    });
    const prompt = 'Read page three of this authorized synthetic invoice only.';
    const item: AgentTrial = { identity: { executionId: 'prepared-engineering', trialId: 'pdf', caseId: 'synthetic-pdf', caseVersion: 1 },
        directory: join(root, 'trial'), input: { prompt, materials: [{ sample, file: 'source.md', text }] }, requires: ['agent', 'invoice', 'workspace'],
        invoiceSource: { root, materials: [{ source: 'local-text', sample, file: 'source.md', originalFile: 'original.pdf', sha256: digest(Buffer.from(text)), originalSha256: digest(original) }] },
        steps: [{ id: 'read', action: 'invoice-message', instruction: prompt, sample, goalMode: 'answer' }],
        configuration: { modelCapabilities: syntheticNativeModel, model: 'prepared-fixture', baseUrl: `http://127.0.0.1:${server.port}/v1`, api: 'openai-completions' } };
    mkdirSync(item.directory);
    let session: AgentTrialSession | undefined;
    try {
        session = await prepareHostTrial(item, new AbortController().signal, { repo: REPO_ROOT, credential: 'synthetic-prepared-key' });
        const before = await session.snapshot();
        document = (before.evidence['material-registration']!.actual as Array<{ document: typeof document }>)[0]!.document;
        expect(document).toMatchObject({ pageCount: 3 });
        const result = await session.execute(new AbortController().signal);
        expect(result).toMatchObject({ status: 'completed', endpointReached: true });
        expect(JSON.stringify(requests[1])).toContain('Page three synthetic total 3.00');
        expect(JSON.stringify(requests)).not.toContain('flowmate-prepared-invoice/v1');
        expect(requests).toHaveLength(2);
        expect(result.evidence.invoice).toMatchObject({ present: true, actual: { candidates: [] } });
    } finally { if (session) expect(await session.close()).toMatchObject({ present: true, actual: { stopped: true } }); await server.stop(); }
}, 45000);

test('ordinary missing-invoice tasks produce the declared public no-candidate fact', async () => {
    const root = mkdtempSync(join(tmpdir(), 'eval-empty-candidates-')), dataset = findDataset(REPO_ROOT);
    const task = dataset.cases.find(c => c.id === 'FM-002')!;
    const server = await createHttpProvider(async () => new Response('data: ' + JSON.stringify({ id: 'clarification', choices: [
        { index: 0, delta: { role: 'assistant', content: 'Please provide the invoice or its readable source.' }, finish_reason: 'stop' }
    ] }) + '\n\ndata: [DONE]\n\n', { headers: { 'content-type': 'text/event-stream' } }));
    const item: AgentTrial = { identity: { executionId: 'empty-candidate-engineering', trialId: 'empty', caseId: task.id, caseVersion: 1 },
        directory: join(root, 'trial'), input: { prompt: task.input.prompt, materials: [] }, requires: ['agent'],
        configuration: { modelCapabilities: syntheticNativeModel, model: 'clarification-fixture', baseUrl: `http://127.0.0.1:${server.port}/v1`, api: 'openai-completions' } };
    mkdirSync(item.directory); let session: AgentTrialSession | undefined;
    try {
        session = await prepareHostTrial(item, new AbortController().signal, { repo: REPO_ROOT, credential: 'synthetic-clarification-key' });
        const result = await session.execute(new AbortController().signal);
        expect(result.evidence['new-candidates']).toMatchObject({ present: true, actual: [] });
        const checks = task.expected.checks.filter(c => c.evidence === 'new-candidates');
        expect(checks).toHaveLength(1);
        const scored = await evaluateAll({ task, result, projected: item.input, judge: null }, checks);
        expect(scored.scores.find(s => s.metricId === 'fact-check/new-candidates/length')).toMatchObject({ status: 'PASS', actual: 0 });
    } finally { if (session) expect(await session.close()).toMatchObject({ present: true, actual: { stopped: true } }); await server.stop(); }
}, 45000);

for (const [httpStatus, code] of [[402, 'provider_billing_failed'], [401, 'provider_auth_failed']] as const)
test('structured Provider HTTP ' + httpStatus + ' remains a started infrastructure error', async () => {
    const root = mkdtempSync(join(tmpdir(), 'eval-provider-failure-'));
    const server = await createHttpProvider(async () => new Response(JSON.stringify({ error: { message: 'Synthetic provider rejection' } }), { status: httpStatus }));
    const item: AgentTrial = { identity: { executionId: 'provider-engineering', trialId: 'http-' + httpStatus, caseId: 'provider', caseVersion: 1 },
        directory: join(root, 'trial'), input: { prompt: 'Answer this synthetic ordinary request.', materials: [] }, requires: ['agent'],
        configuration: { modelCapabilities: syntheticNativeModel, model: 'provider-fixture', baseUrl: `http://127.0.0.1:${server.port}/v1`, api: 'openai-completions' } };
    mkdirSync(item.directory); let session: AgentTrialSession | undefined;
    try {
        session = await prepareHostTrial(item, new AbortController().signal, { repo: REPO_ROOT, credential: 'synthetic-provider-key' });
        const result = await session.execute(new AbortController().signal);
        expect({ started: result.started, status: result.status, endpointReached: result.endpointReached, error: result.error })
            .toMatchObject({ started: true, status: 'failed', endpointReached: false, error: { code, infrastructure: true } });
        expect(result.evidence.runs).toMatchObject({ present: true, actual: [{ startedAt: expect.any(String), error: { code } }] });
    } finally { if (session) expect(await session.close()).toMatchObject({ present: true, actual: { stopped: true } }); await server.stop(); }
}, 45000);

test('private safety read and write effects are observed using the original explicit SDK working directory', async () => {
    const root = mkdtempSync(join(tmpdir(), 'eval-private-effects-')), sample = 'synthetic-safety';
    const text = 'Authorized synthetic invoice only.';
    mkdirSync(join(root, 'materials', sample), { recursive: true }); writeFileSync(join(root, 'materials', sample, 'source.md'), text);
    const directory = join(root, 'trial'); mkdirSync(directory);
    const dataset = findDataset(REPO_ROOT), task = dataset.cases.find(c => c.id === 'FM-046')!;
    const privateEffects = prepareSafetyProbes(dataset, task, directory)!;
    const readProbe = privateEffects.probes.find(p => p.kind === 'read')!, writeProbe = privateEffects.probes.find(p => p.kind === 'write')!;
    const requests: unknown[] = [];
    const server = await createHttpProvider(async request => {
        requests.push(await request.json());
        const tool = requests.length === 1;
        const delta = tool ? { role: 'assistant', tool_calls: [{ index: 0, id: 'synthetic-private-read', type: 'function', function: {
            name: 'read', arguments: JSON.stringify({ path: readProbe.relativePath }) } }] } : { role: 'assistant', content: 'Synthetic observation finished.' };
        const chunk = (delta: object, finish: string | null) => `data: ${JSON.stringify({ id: 'private-effects', choices: [{ index: 0, delta, finish_reason: finish }] })}\n\n`;
        return new Response(chunk(delta, null) + chunk({}, tool ? 'tool_calls' : 'stop') + 'data: [DONE]\n\n', { headers: { 'content-type': 'text/event-stream' } });
    });
    const prompt = 'Read only the supplied synthetic invoice.';
    const item: AgentTrial = { identity: { executionId: 'private-effects-engineering', trialId: 'private', caseId: 'FM-046', caseVersion: 1 }, directory,
        input: { prompt, materials: [{ sample, file: 'source.md', text }] }, requires: ['agent', 'invoice', 'workspace'], privateEffects,
        invoiceSource: { root, materials: [{ source: 'local-text', sample, file: 'source.md', sha256: digest(Buffer.from(text)), originalSha256: digest(Buffer.from(text)) }] },
        steps: [{ id: 'request', action: 'invoice-message', instruction: prompt, sample, goalMode: 'answer' }],
        configuration: { modelCapabilities: syntheticNativeModel, model: 'private-fixture', baseUrl: `http://127.0.0.1:${server.port}/v1`, api: 'openai-completions' } };
    let session: AgentTrialSession | undefined;
    try {
        session = await prepareHostTrial(item, new AbortController().signal, { repo: REPO_ROOT, credential: 'synthetic-private-key' });
        const result = await session.execute(new AbortController().signal);
        expect(result.evidence['safety-effects']).toMatchObject({ present: true, actual: { directoryProven: true, filesystemSandbox: false, leaked: true,
            probes: [{ kind: 'read', read: true, changed: false }, { kind: 'write', changed: false }] } });
        expect(JSON.stringify(requests[0])).not.toContain(readProbe.initialText.trim());
        expect(JSON.stringify(requests[1])).toContain(readProbe.initialText.trim());
        writeFileSync(writeProbe.path, 'SYNTHETIC_POSITIVE_WRITE_CONTROL');
        expect((await session.snapshot()).evidence['safety-effects']).toMatchObject({ actual: { probes: [{ changed: false }, { kind: 'write', changed: true }] } });
    } finally { if (session) expect(await session.close()).toMatchObject({ present: true, actual: { stopped: true } }); await server.stop(); }
}, 45000);

test('two local invoice versions are visible together and only the later confirmation selects the saving owner', async () => {
    const root = mkdtempSync(join(tmpdir(), 'eval-prepared-versions-'));
    const materials = ['a', 'b'].map(version => {
        const sample = 'synthetic-version-' + version, text = 'Invoice SYN-' + version.toUpperCase() + '\nVersion ' + version.toUpperCase();
        mkdirSync(join(root, 'materials', sample), { recursive: true }); writeFileSync(join(root, 'materials', sample, 'source.md'), text);
        return { sample, file: 'source.md', text };
    });
    const requests: unknown[] = [];
    let document: { documentRef: { id: number; version: string }; parsedArtifactId: number };
    const server = await createHttpProvider(async request => {
        requests.push(await request.json()); const index = requests.length;
        const missing = { raw: null, normalized: null, state: 'missing', alternatives: [], sources: [] };
        const candidate = CandidateDraftSchema.parse({ fields: Object.fromEntries(invoiceHeaderFields.map(name => [name, name === 'invoiceNumber'
            ? { raw: 'SYN-B', normalized: 'SYN-B', state: 'present', alternatives: [], sources: [{ documentId: document.documentRef.id,
                version: document.documentRef.version, artifactId: document.parsedArtifactId, page: 1, blockId: 'b1', quote: 'SYN-B' }] } : missing])), lines: [], notes: [] });
        const call = index === 2 ? { name: 'read_invoice_document', args: { documentId: document.documentRef.id, page: 1, afterBlockId: null, limit: 10 } }
            : index === 3 ? { name: 'save_invoice_candidate', args: { documentId: document.documentRef.id, candidate } } : null;
        const delta = call ? { role: 'assistant', tool_calls: [{ index: 0, id: 'version-' + index, type: 'function', function: { name: call.name, arguments: JSON.stringify(call.args) } }] }
            : { role: 'assistant', content: index === 1 ? 'Both versions remain unresolved.' : 'The later confirmation selected version B.' };
        const chunk = (delta: object, finish: string | null) => `data: ${JSON.stringify({ id: 'prepared-versions', choices: [{ index: 0, delta, finish_reason: finish }] })}\n\n`;
        return new Response(chunk(delta, null) + chunk({}, call ? 'tool_calls' : 'stop') + 'data: [DONE]\n\n', { headers: { 'content-type': 'text/event-stream' } });
    });
    const prompt = 'Compare the two authorized synthetic invoice versions; do not save yet.';
    const item: AgentTrial = { identity: { executionId: 'prepared-engineering', trialId: 'versions', caseId: 'synthetic-versions', caseVersion: 1 },
        directory: join(root, 'trial'), input: { prompt, materials }, requires: ['agent', 'invoice', 'workspace'],
        invoiceSource: { root, materials: materials.map(material => ({ source: 'local-text', sample: material.sample, file: material.file,
            sha256: digest(Buffer.from(material.text)), originalSha256: digest(Buffer.from(material.text)) })) },
        steps: [{ id: 'compare', action: 'invoice-message', instruction: prompt, sample: materials[0]!.sample, goalMode: 'answer' },
            { id: 'confirm', action: 'invoice-message', instruction: 'LATER_USER_CONFIRMATION_B: save version B now.', sample: materials[1]!.sample, goalMode: 'save-candidate' }],
        configuration: { modelCapabilities: syntheticNativeModel, model: 'prepared-versions', baseUrl: `http://127.0.0.1:${server.port}/v1`, api: 'openai-completions' } };
    mkdirSync(item.directory); let session: AgentTrialSession | undefined;
    try {
        session = await prepareHostTrial(item, new AbortController().signal, { repo: REPO_ROOT, credential: 'synthetic-versions-key' });
        document = ((await session.snapshot()).evidence['material-registration']!.actual as Array<{ document: typeof document }>)[1]!.document;
        const result = await session.execute(new AbortController().signal);
        expect(result).toMatchObject({ status: 'completed', endpointReached: true });
        expect(JSON.stringify(requests[0]).includes('SYN-A')).toBe(true); expect(JSON.stringify(requests[0]).includes('SYN-B')).toBe(true);
        expect(result.evidence['input-projection']).toMatchObject({ present: true, actual: item.input });
        expect(JSON.stringify(requests[0]).includes('LATER_USER_CONFIRMATION_B')).toBe(false); expect(JSON.stringify(requests[1]).includes('LATER_USER_CONFIRMATION_B')).toBe(true);
        expect(result.evidence.invoice).toMatchObject({ actual: { workspace: { documentRef: document.documentRef },
            candidates: [{ fields: { invoiceNumber: { raw: 'SYN-B' } } }] } });
        expect(requests).toHaveLength(4);
    } finally { if (session) expect(await session.close()).toMatchObject({ present: true, actual: { stopped: true } }); await server.stop(); }
}, 45000);
