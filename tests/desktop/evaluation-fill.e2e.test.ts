import { expect, test } from '@playwright/test';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createHash } from 'node:crypto';
import { cleanupResources, createHttpProvider, mkdtempSync } from '../support/resources.ts';
import { prepareHostTrial } from '../../agent-eval/src/adapters/host-research.ts';
import { REPO_ROOT } from '../../agent-eval/src/dataset-loader/local.ts';
import { controllerStepsSchema } from '../../agent-eval/src/dataset-loader/schema.ts';
import { CandidateDraftSchema, invoiceHeaderFields } from '../../packages/contracts/src/invoice.ts';
import type { AgentTrial, AgentTrialSession } from '../../agent-eval/src/adapters/agent.ts';
import { syntheticNativeModel } from '../../agent-eval/tests/support/native-model.ts';
import { ElectronInvoiceControls } from '../../agent-eval/src/adapters/electron-fill.ts';
import { fillRunSchema, fillResponseSchema } from '../../agent-eval/src/adapters/fill-controls/protocol.ts';
import type { ChildProcess } from 'node:child_process';

test.afterEach(cleanupResources);
for (const isolation of [undefined] as const) test('evaluation Fill uses actual Electron controls and the original Trial Host: ' + (isolation ?? 'loopback'), async () => {
    test.setTimeout(90000);
    const root = mkdtempSync(join(tmpdir(), 'eval-electron-fill-')), sample = 'synthetic-fill', text = 'Invoice INV-CONTROL-1';
    mkdirSync(join(root, 'materials', sample), { recursive: true }); writeFileSync(join(root, 'materials', sample, 'source.md'), text);
    const sha256 = createHash('sha256').update(text).digest('hex');
    let source: { documentRef: { id: number; version: string }; parsedArtifactId: number };
    const requests: unknown[] = [];
    const server = await createHttpProvider(async request => {
        requests.push(await request.json()); const index = requests.length;
        const missing = { raw: null, normalized: null, state: 'missing', alternatives: [], sources: [] };
        const candidate = CandidateDraftSchema.parse({ fields: Object.fromEntries(invoiceHeaderFields.map(name => [name, name === 'invoiceNumber'
            ? { raw: 'INV-CONTROL-1', normalized: 'INV-CONTROL-1', state: 'present', alternatives: [], sources: [{ documentId: source.documentRef.id,
                version: source.documentRef.version, artifactId: source.parsedArtifactId, page: 1, blockId: 'b1', quote: 'INV-CONTROL-1' }] } : missing])), lines: [], notes: [] });
        const call = index === 1 ? { name: 'read_invoice_document', args: { documentId: source.documentRef.id, page: 1, afterBlockId: null, limit: 10 } }
            : index === 2 ? { name: 'save_invoice_candidate', args: { documentId: source.documentRef.id, candidate } }
            : index === 4 ? { name: 'fill_invoice_form', args: { candidateId: 1 } } : null;
        const delta = call ? { role: 'assistant', tool_calls: [{ index: 0, id: 'fill-engineering-' + index, type: 'function',
            function: { name: call.name, arguments: JSON.stringify(call.args) } }] } : { role: 'assistant', content: 'Original controlled operation completed.' };
        const chunk = (delta: object, finish: string | null) => `data: ${JSON.stringify({ id: 'fill-engineering', choices: [{ index: 0, delta, finish_reason: finish }] })}\n\n`;
        return new Response(chunk(delta, null) + chunk({}, call ? 'tool_calls' : 'stop') + 'data: [DONE]\n\n', { headers: { 'content-type': 'text/event-stream' } });
    }, isolation ? '0.0.0.0' : '127.0.0.1');
    const prompt = 'Read this synthetic invoice and save its candidate.';
    const item: AgentTrial = { identity: { executionId: 'fill-engineering', trialId: 'actual-controls', caseId: 'synthetic-fill', caseVersion: 1 },
        directory: join(root, 'trial'), requires: ['agent', 'invoice', 'workspace'], input: { prompt, materials: [{ sample, file: 'source.md', text }] },
        invoiceSource: { root, materials: [{ source: 'local-text', sample, file: 'source.md', sha256, originalSha256: sha256 }] },
        configuration: { model: 'fill-engineering', baseUrl: `http://${isolation ? '127.0.0.1' : '127.0.0.1'}:${server.port}/v1`, api: 'openai-completions', modelCapabilities: syntheticNativeModel },
        steps: controllerStepsSchema.parse([{ id: 'save', action: 'invoice-message', instruction: prompt, sample, goalMode: 'save-candidate' },
            { id: 'select', action: 'select-candidate', fromStep: 'save', ordinal: 1 }, { id: 'fill', action: 'fill-form' }]) };
    mkdirSync(item.directory); let session: AgentTrialSession | undefined;
    try {
        session = await prepareHostTrial(item, new AbortController().signal, { repo: REPO_ROOT, credential: 'synthetic-controls-key' });
        source = ((await session.snapshot()).evidence['material-registration']!.actual as Array<{ document: typeof source }>)[0]!.document;
        const result = await session.execute(new AbortController().signal);
        expect(result).toMatchObject({ status: 'completed', endpointReached: true });
        expect(result.evidence['invoice-form']).toMatchObject({ present: true, actual: [{ inspection: { revision: 1,
            draft: { fields: { invoiceNumber: 'INV-CONTROL-1' } } }, receipt: { outcome: 'applied' } }] });
        expect(result.evidence.invoice).toMatchObject({ present: true, actual: { candidates: [{ candidateId: 1, sequence: 1 }] } });
        expect(requests).toHaveLength(5);
    } finally { if (session) expect(await session.close()).toMatchObject({ present: true, actual: { stopped: true } }); await server.stop(); }
});

test('actual evaluation controls reject stale owners and recover only the original lost application receipt', async () => {
    test.setTimeout(45000);
    const root = mkdtempSync(join(tmpdir(), 'eval-electron-controls-'));
    const controls = await ElectronInvoiceControls.start(REPO_ROOT, root);
    const workspace = { revision: 2, documentRef: { id: 4, version: 'synthetic-v1' }, jobId: 7, candidateRef: { id: 9, sequence: 1 }, sessionId: 12 };
    try {
        const opened = await controls.request({ action: 'open', workspace, epoch: 1 });
        const target = opened.target!;
        const missing = { raw: null, normalized: null, state: 'missing', alternatives: [], sources: [] };
        const candidate = CandidateDraftSchema.parse({ fields: Object.fromEntries(invoiceHeaderFields.map(name => [name, missing])), lines: [], notes: ['Actual controlled note'] });
        const request = { operation: 'apply' as const, sessionId: 12, runId: 101, toolCallId: 21, nativeToolCallId: 'synthetic-original-call',
            documentRef: workspace.documentRef, jobId: 7, candidateId: 9, candidateSequence: 1, target, candidate };
        const run = fillRunSchema.parse({ kind: 'agent', runId: 101, jobId: 7, sessionId: 12, status: 'running', cancelRequestedAt: null,
            config: { goalMode: 'fill-form', formTarget: target, workspaceContext: { ...workspace, formatVersion: 1, activeView: 'candidate', selection: null } },
            scope: { version: 2, allowedTools: ['fill_invoice_form'], allowedDocumentIds: [4], allowedArtifactIds: [], allowedResourcePaths: [] } });
        for (const change of [{ candidateId: 10 }, { documentRef: { id: 4, version: 'foreign-version' } }, { target: { ...target, expectedRevision: 1 } }])
            await expect(controls.request({ action: 'request', request: { ...request, ...change }, run, epoch: 1 })).rejects.toThrow('owner or Run changed');
        await expect(controls.request({ action: 'request', request, run, epoch: 2 })).rejects.toThrow('owner or Run changed');
        expect((await controls.request({ action: 'inspect' })).inspection).toMatchObject({ revision: 0, draft: { notes: [] } });
        const child = Reflect.get(controls, 'child') as ChildProcess, emit = child.emit;
        let dropped = 0;
        child.emit = function (event: string | symbol, ...args: unknown[]): boolean {
            const value = fillResponseSchema.safeParse(args[0]);
            if (event === 'message' && value.success && value.data.result?.receipt?.outcome === 'applied' && !dropped) { dropped++; return true; }
            return Reflect.apply(emit, this, [event, ...args]);
        };
        await expect(controls.request({ action: 'request', request, run, epoch: 1 })).rejects.toThrow('receipt is unknown');
        child.emit = emit;
        expect(dropped).toBe(1);
        const { candidate: _candidate, operation: _operation, ...identity } = request;
        const recovered = await controls.request({ action: 'request', request: { ...identity, operation: 'query' }, run: { ...run, status: 'completed' }, epoch: 1 });
        expect(recovered).toMatchObject({ receipt: { outcome: 'applied', appliedRevision: 1 }, inspection: { revision: 1, draft: { notes: ['Actual controlled note'] } } });
        expect((await controls.request({ action: 'request', request, run, epoch: 1 })).receipt).toEqual(recovered.receipt);
        await controls.request({ action: 'cancel' });
        expect((await controls.request({ action: 'request', request: { ...request, toolCallId: 22, nativeToolCallId: 'synthetic-new-call' }, run, epoch: 1 })).receipt)
            .toMatchObject({ outcome: 'not_applied', reason: 'cancelled' });
        expect((await controls.request({ action: 'request', request: { ...identity, operation: 'query' }, run: { ...run, status: 'cancelled' }, epoch: 1 })).receipt).toEqual(recovered.receipt);
    } finally { expect(await controls.close()).toMatchObject({ closed: true, stopped: true }); }
});
