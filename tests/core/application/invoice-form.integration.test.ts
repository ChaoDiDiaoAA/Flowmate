import { describe, expect, it } from 'bun:test';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { Database } from 'bun:sqlite';
import { InMemoryCredentialStore } from '@earendil-works/pi-ai';
import { appError, fail, InvoiceFormDraftSchema } from '@flowmate/contracts';
import type { AgentRunEvent, AgentRunRequest, Application, InvoiceFormApplicationReceipt, InvoiceFormBridgeRequest,
  ProviderConfig, Result, SessionInputRequest, WorkspaceSnapshot } from '@flowmate/contracts';
import { createApplication } from '../../../apps/composition.ts';
import { PiAgentAdapter } from '../../../packages/runtime-pi/src/session.ts';
import { deferCleanup, mkdtempSync } from '../../support/resources.ts';

function need<T>(result: Result<T>): T {
  if (!result.ok) throw new Error(`${result.error.code}: ${result.error.message}`);
  return result.data;
}
function productPaths(root: string) {
  return { root, databaseFile: join(root, 'data', 'app.sqlite'), logsDir: join(root, 'logs'),
    artifactsDir: join(root, 'artifacts'), outputsDir: join(root, 'outputs'), runtimeDir: join(root, 'runtime') };
}
function unknownReceipt(request: InvoiceFormBridgeRequest): InvoiceFormApplicationReceipt {
  return { runId: request.runId, toolCallId: request.toolCallId, candidateId: request.candidateId,
    candidateSequence: request.candidateSequence, formInstanceId: request.target.formInstanceId,
    observedAt: new Date().toISOString(), outcome: 'unknown' };
}
const missing = { raw: null, normalized: null, state: 'missing', alternatives: [], sources: [] };
const candidate = { fields: Object.fromEntries(['invoiceNumber', 'issueDate', 'sellerName', 'sellerTaxId', 'buyerName',
  'buyerTaxId', 'currency', 'netAmount', 'taxAmount', 'totalAmount'].map(name => [name, missing])), lines: [], notes: [] };
function writeInvoice(directory: string) {
  mkdirSync(directory, { recursive: true });
  const original = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/a54AAAAASUVORK5CYII=', 'base64');
  const content = JSON.stringify([{ type: 'text', text: 'Synthetic invoice total 100.00', bbox: [0, 0, 1, 1], page_idx: 0 }]);
  const pages = JSON.stringify([{ pageNumber: 1, text: 'Synthetic invoice total 100.00', blockCount: 1 }]);
  writeFileSync(join(directory, 'original.png'), original);
  writeFileSync(join(directory, 'content.json'), content);
  writeFileSync(join(directory, 'pages.json'), pages);
  writeFileSync(join(directory, 'metadata.json'), JSON.stringify({ schemaVersion: 1, sampleId: '000001',
    datasetId: 'voxel51-hq-invoice-ocr', sourceRecordId: 'synthetic-form', datasetRevision: 'form-fixture', qualityStatus: 'complete',
    allowedUsesClaim: ['local test'], licenseVerification: 'not_verified', files: [{ path: 'original.png', bytes: original.length },
      { path: 'content.json', bytes: Buffer.byteLength(content) }, { path: 'pages.json', bytes: Buffer.byteLength(pages) }] }));
}
function expectation(workspace: WorkspaceSnapshot) {
  if (workspace.sessionId === null) throw new Error('The fixture requires a selected Session.');
  return { revision: workspace.revision, sessionId: workspace.sessionId, documentRef: workspace.documentRef,
    jobId: workspace.jobId, candidateRef: workspace.candidateRef };
}
async function run(app: Application, request: AgentRunRequest | SessionInputRequest, fill = false) {
  let finish!: (event: AgentRunEvent & { type: 'run_finished' }) => void;
  const terminal = new Promise<AgentRunEvent & { type: 'run_finished' }>(resolve => { finish = resolve; });
  const control = { onEvent(event: AgentRunEvent) { if (event.type === 'run_finished') finish(event); } };
  const accepted = need(await (fill ? app.submitInput(request as SessionInputRequest, control) : app.startRun(request, control)));
  return { accepted, finished: await terminal };
}

describe('Fill backend through the public Application', () => {
  it.each([false, true])('registers Fill only when a trusted bridge is present: %s', async bridgePresent => {
    const root = mkdtempSync(join(tmpdir(), 'flowmate-form-manifest-'));
    let names: readonly string[] = [];
    const app = need(await createApplication({ paths: productPaths(root), logger: { write() {}, async close() {} },
      ...(bridgePresent ? { invoiceFormBridge: async (request: InvoiceFormBridgeRequest) => unknownReceipt(request) } : {}),
      agentFactory: tools => {
        names = tools.map(tool => tool.name);
        return { createSession: () => { throw new Error('No Session is needed.'); }, inspect: () => ({ availability: 'ready' }),
          async prepare() { throw new Error('No model call is allowed.'); },
          async releaseSession() { return { stopped: true, closed: true, errors: [] }; },
          async close() { return { stopped: true, closed: true, errors: [] }; } };
      } }));
    try {
      expect(names).toHaveLength(bridgePresent ? 22 : 21);
      expect(names.includes('fill_invoice_form')).toBe(bridgePresent);
      expect(names.slice(0, 13)).not.toContain('fill_invoice_form');
      expect(await app.saveInvoiceCandidate({} as never)).toMatchObject({ ok: false, error: { code: 'input_invalid' } });
      expect(await app.acceptInvoiceCandidate({} as never)).toMatchObject({ ok: false, error: { code: 'input_invalid' } });
      expect(await app.rejectInvoiceCandidate({} as never)).toMatchObject({ ok: false, error: { code: 'input_invalid' } });
      expect(await app.exportInvoiceCandidate({} as never)).toMatchObject({ ok: false, error: { code: 'input_invalid' } });
      expect(await app.queryInvoiceCandidateOperation({ kind: 'save', request: {} } as never))
        .toMatchObject({ ok: false, error: { code: 'input_invalid' } });
    } finally { need(await app.close()); }
  });

  it.each(['applied', 'not_applied', 'unknown', 'not-called', 'late-applied', 'invalid-receipt', 'workspace-changed', 'toolResult-save-failure'] as const)
    ('uses real SDK, Executor and SQLite for %s; query never applies again', async outcome => {
    const root = mkdtempSync(join(tmpdir(), 'flowmate-form-chain-'));
    const paths = productPaths(join(root, 'product'));
    const sourceRoot = join(root, 'source'); const source = join(sourceRoot, '000001'); writeInvoice(source);
    const requests: Array<{ messages: Array<{ role: string; content?: unknown; tool_call_id?: string }>; tools?: Array<{ function: { name: string } }> }> = [];
    const bridgeCalls: InvoiceFormBridgeRequest[] = [];
    let documentId = 0; let candidateId = 0;
    let lateReceipt!: (receipt: InvoiceFormApplicationReceipt) => void;
    let lateAppliedAt = '';
    let app!: Application;
    const server = Bun.serve({ hostname: '127.0.0.1', port: 0, async fetch(request) {
      requests.push(await request.json());
      const ordinal = requests.length;
      if (ordinal === 3 && outcome === 'workspace-changed') {
        const current = need(await app.readWorkspace());
        need(await app.updateWorkspace({ expectedRevision: current.revision, change: { kind: 'document', documentId: null } }));
      }
      const tool = ordinal === 1 ? { name: 'save_invoice_candidate', input: { documentId, candidate } }
        : ordinal === 3 && outcome !== 'not-called' ? { name: 'fill_invoice_form', input: { candidateId } } : null;
      const delta = tool ? { role: 'assistant', tool_calls: [{ index: 0, id: `form-call-${ordinal}`, type: 'function',
        function: { name: tool.name, arguments: JSON.stringify(tool.input) } }] } : { role: 'assistant', content: 'Controlled final response.' };
      const chunk = (value: unknown, reason: string | null) => `data: ${JSON.stringify({ id: `form-response-${ordinal}`,
        model: 'form-model', choices: [{ index: 0, delta: value, finish_reason: reason }] })}\n\n`;
      return new Response(`${chunk(delta, null)}${chunk({}, tool ? 'tool_calls' : 'stop')}data: [DONE]\n\n`, { headers: { 'content-type': 'text/event-stream' } });
    } });
    deferCleanup(() => server.stop(true));
    const config: ProviderConfig = { version: 1, name: 'Controlled form model', revision: 1,
      modelRef: { provider: 'form-fixture', model: 'form-model' }, native: { authPath: join(root, 'unused.json'), modelsPath: null },
      connection: { baseUrl: `http://127.0.0.1:${server.port}/v1`, api: 'openai-completions', contextWindow: 64_000, maxTokens: 16_384 },
      parameters: { maxRetries: 0, maxRetryDelayMs: 100 } };
    app = need(await createApplication({ paths, invoiceSourceRoot: sourceRoot, logger: { write() {}, async close() {} },
      invoiceFormBridge: async request => {
        bridgeCalls.push(structuredClone(request));
        const base = unknownReceipt(request);
        if (request.operation === 'apply' && outcome === 'late-applied') {
          lateAppliedAt = base.observedAt;
          return new Promise<InvoiceFormApplicationReceipt>(resolve => { lateReceipt = resolve; });
        }
        if (request.operation === 'apply' && outcome === 'invalid-receipt') return { ...base, outcome: 'applied',
          candidateId: request.candidateId + 1, appliedRevision: request.target.expectedRevision + 1, appliedAt: base.observedAt };
        if (request.operation === 'query' && outcome === 'late-applied') return base;
        if (request.operation === 'query' || outcome === 'applied' || outcome === 'toolResult-save-failure') return { ...base, outcome: 'applied',
          appliedRevision: request.target.expectedRevision + 1, appliedAt: base.observedAt };
        return outcome === 'not_applied' ? { ...base, outcome: 'not_applied', reason: 'fixture-target-unavailable' } : base;
      },
      agentFactory: tools => {
        const adapter = new PiAgentAdapter({ cwd: paths.runtimeDir, agentDir: paths.runtimeDir, tools,
          credentials: new InMemoryCredentialStore(), runtimeApiKey: 'synthetic-form-key' });
        if (outcome === 'toolResult-save-failure') {
          const watch = adapter.watchSession.bind(adapter);
          adapter.watchSession = (nativeId, save) => watch(nativeId, (history, context) => {
            const entry = history.entries.at(-1);
            const message = entry?.type === 'message' ? entry.message as { role?: string; toolCallId?: string } : null;
            return context && message?.role === 'toolResult' && message.toolCallId === 'form-call-3'
              ? fail(appError('storage_write_failed', 'storage', 'Fixture rejects the actual Fill toolResult save.')) : save(history, context);
          });
        }
        return adapter;
      } }));
    let fillRunId = 0; let fillToolId = 0;
    try {
      const doc = need(await app.importInvoiceMaterial(source)); documentId = doc.documentRef.id;
      const initial = need(await app.readWorkspace());
      const session = need(await app.createSession({ title: 'Fill chain', expectedRevision: initial.revision }));
      let current = need(await app.readWorkspace());
      current = need(await app.updateWorkspace({ expectedRevision: current.revision, change: { kind: 'document', documentId } }));
      const task = need(await app.startTask({ clientSequence: 1, expectedRevision: current.revision,
        documentRef: doc.documentRef, goal: 'Create a candidate then fill the controlled form.' }));
      const generated = await run(app, { sessionId: session.sessionId, goalMode: 'save-candidate', text: 'Save the candidate for review.',
        workspace: expectation(task.workspace), config, timeoutMs: 5000, stopGraceMs: 500 });
      expect(generated.finished.result).toMatchObject({ ok: true, data: { status: 'completed' } });
      const list = need(await app.listJobCandidates({ jobId: task.job.jobId })); candidateId = list.items[0]!.candidateId;
      current = need(await app.readWorkspace());
      const selected = need(await app.selectCandidate({ jobId: task.job.jobId, candidateId,
        expectedCandidateId: current.candidateRef?.id ?? null, expectedRevision: current.revision }));
      const fillInput: SessionInputRequest = { sessionId: session.sessionId, clientSequence: 1, mode: 'prompt', goalMode: 'fill-form',
        text: 'Apply the selected candidate.', workspace: expectation(selected.workspace), config,
        formTarget: { formInstanceId: 'private-form-target', expectedRevision: 4 }, timeoutMs: outcome === 'late-applied' ? 500 : 5000, stopGraceMs: 500 };
      const filled = await run(app, fillInput, true); fillRunId = filled.accepted.runId;
      expect(filled.finished.result).toMatchObject({ ok: true, data: { status: outcome === 'applied' ? 'completed' : 'failed' } });
      const completedRun = need(await app.queryRun(fillRunId));
      expect(completedRun.output?.agent).toMatchObject({ candidateIds: [] });
      expect(need(await app.queryJob(task.job.jobId))).toMatchObject({ status: outcome === 'applied' ? 'waiting' : 'failed',
        ...(outcome === 'applied' ? { reason: 'review_form' } : {}), currentCandidateId: candidateId, acceptedCandidateId: null });
      if (outcome === 'workspace-changed') {
        expect(bridgeCalls).toHaveLength(0);
        expect(requests).toHaveLength(4);
        expect(need(await app.queryJob(task.job.jobId)).currentCandidateId).toBe(candidateId);
        expect(need(await app.readWorkspace())).toMatchObject({ documentRef: null, jobId: null, candidateRef: null });
        return;
      }
      if (outcome === 'not-called') {
        expect(completedRun.error?.code).toBe('agent_goal_not_met');
        expect(bridgeCalls).toHaveLength(0);
        expect(requests).toHaveLength(3);
        expect(await app.submitInput(fillInput)).toEqual({ ok: true, data: filled.accepted });
        expect(requests).toHaveLength(3);
        return;
      }
      expect(bridgeCalls.filter(call => call.operation === 'apply')).toHaveLength(1);
      fillToolId = bridgeCalls[0]!.toolCallId;
      expect(bridgeCalls[0]).toMatchObject({ operation: 'apply', runId: fillRunId, candidateId, candidateSequence: 1,
        target: fillInput.formTarget, candidate: { lines: [], notes: [] } });
      const resultMissing = outcome === 'late-applied' || outcome === 'toolResult-save-failure';
      expect(requests).toHaveLength(resultMissing ? 3 : 4);
      expect(requests[2]!.tools?.map(tool => tool.function.name)).toEqual(['fill_invoice_form']);
      const result = requests[3]?.messages.find(message => message.role === 'tool' && message.tool_call_id === 'form-call-3');
      if (!resultMissing) expect(result).toBeDefined();
      if (outcome === 'applied') expect(JSON.parse(String(result?.content))).toEqual({ candidateId, candidateSequence: 1, applied: true });
      else expect(String(result?.content)).not.toContain('"applied":true');
      expect(JSON.stringify(requests)).not.toContain('private-form-target');
      expect(JSON.stringify(requests)).not.toContain('expectedRevision');
      expect(need(await app.querySessionInput({ sessionId: session.sessionId, clientSequence: 1 })).input)
        .toMatchObject({ inputId: filled.accepted.inputId, runId: fillRunId, status: 'consumed',
          processingStatus: outcome === 'applied' ? 'completed' : 'failed', nativeEntryId: expect.any(String) });
      const before = need(await app.queryRun(fillRunId));
      let receipt = need(await app.queryInvoiceFormApplication({ runId: fillRunId, toolCallId: fillToolId }));
      if (outcome === 'late-applied') {
        expect(receipt.outcome).toBe('unknown');
        const original = bridgeCalls[0]!; const base = unknownReceipt(original);
        lateReceipt({ ...base, outcome: 'applied', appliedRevision: original.target.expectedRevision + 1, appliedAt: lateAppliedAt });
        await new Promise<void>(resolve => setTimeout(resolve, 0));
        receipt = need(await app.queryInvoiceFormApplication({ runId: fillRunId, toolCallId: fillToolId }));
      }
      expect(receipt.outcome).toBe(outcome === 'not_applied' ? 'not_applied' : 'applied');
      expect(await app.queryRun(fillRunId)).toEqual({ ok: true, data: before });
      expect(bridgeCalls.filter(call => call.operation === 'apply')).toHaveLength(1);
      expect(bridgeCalls.filter(call => call.operation === 'query')).toHaveLength(['unknown', 'late-applied', 'invalid-receipt'].includes(outcome) ? 1 : 0);
      const query = bridgeCalls.find(call => call.operation === 'query');
      if (query) expect(query).not.toHaveProperty('candidate');
      expect(requests).toHaveLength(resultMissing ? 3 : 4);
      expect(await app.queryInvoiceFormApplication({ runId: generated.accepted.runId, toolCallId: fillToolId }))
        .toMatchObject({ ok: false, error: { code: 'state_conflict' } });
      expect(await app.submitInput(fillInput)).toEqual({ ok: true, data: filled.accepted });
      expect(requests).toHaveLength(resultMissing ? 3 : 4);
      expect(bridgeCalls.filter(call => call.operation === 'apply')).toHaveLength(1);
      if (outcome === 'applied') {
        const workspace = need(await app.readWorkspace());
        const unchangedDraft = InvoiceFormDraftSchema.parse({ fields: Object.fromEntries(Object.keys(candidate.fields).map(name => [name, ''])),
          lines: [], notes: [] });
        const noDiff = { operationRef: 'form-no-diff', jobId: task.job.jobId, expectedCandidateId: candidateId,
          expectedRevision: workspace.revision, basedOnCandidateId: candidateId, draft: unchangedDraft };
        expect(need(await app.saveInvoiceCandidate(noDiff))).toMatchObject({ changed: false, candidate: { candidateId } });
        expect(await app.queryInvoiceCandidateOperation({ kind: 'save', request: noDiff })).toEqual({ ok: true, data: null });
        const edit = { ...noDiff, operationRef: 'form-human-edit', draft: { ...unchangedDraft,
          fields: { ...unchangedDraft.fields, sellerName: 'Human corrected seller' }, notes: ['Human correction'] } };
        expect(await app.queryInvoiceCandidateOperation({ kind: 'save', request: edit })).toEqual({ ok: true, data: null });
        const saved = need(await app.saveInvoiceCandidate(edit));
        expect(saved).toMatchObject({ changed: true, candidate: { origin: 'human_edit', basedOnCandidateId: candidateId,
          runId: null, toolCallId: null, status: 'generated', fields: { sellerName: { valueOrigin: 'user-provided', sources: [] } } } });
        expect(need(await app.queryInvoiceCandidateOperation({ kind: 'save', request: edit }))).toMatchObject({ changed: true,
          candidate: { candidateId: saved.candidate.candidateId } });
        expect(need(await app.saveInvoiceCandidate(edit)).candidate.candidateId).toBe(saved.candidate.candidateId);
        expect(await app.queryInvoiceCandidateOperation({ kind: 'save', request: { ...edit, draft: { ...edit.draft,
          fields: { ...edit.draft.fields, sellerName: 'Conflicting content' } } } }))
          .toMatchObject({ ok: false, error: { code: 'state_conflict' } });
        const accept = { operationRef: 'form-human-accept', jobId: task.job.jobId,
          expectedCandidateId: saved.candidate.candidateId, expectedRevision: saved.workspace.revision,
          candidateId: saved.candidate.candidateId, dirty: false as const };
        const accepted = need(await app.acceptInvoiceCandidate(accept));
        expect(accepted).toMatchObject({ candidate: { status: 'accepted' }, job: { status: 'completed',
          reason: 'user_accepted', acceptedCandidateId: saved.candidate.candidateId } });
        expect(need(await app.queryInvoiceCandidateOperation({ kind: 'accept', request: accept })))
          .toMatchObject({ candidate: { candidateId: saved.candidate.candidateId, status: 'accepted' } });
        for (const format of ['json', 'csv', 'markdown'] as const) {
          const exportRequest = { operationRef: `form-export-${format}`, candidateId: saved.candidate.candidateId, format };
          const exported = need(await app.exportInvoiceCandidate(exportRequest));
          const bytes = readFileSync(join(paths.root, exported.relativePath));
          expect(exported.sha256).toBe(createHash('sha256').update(bytes).digest('hex'));
          expect(bytes.toString()).toContain('Human corrected seller');
          expect(bytes.toString()).toContain('human_edit');
          expect(need(await app.queryInvoiceCandidateOperation({ kind: 'export', request: exportRequest }))).toEqual(exported);
          expect(need(await app.exportInvoiceCandidate(exportRequest))).toEqual(exported);
        }
        expect(requests).toHaveLength(4);
        expect(bridgeCalls.filter(call => call.operation === 'apply')).toHaveLength(1);
      }
    } finally { need(await app.close()); }
    const db = new Database(paths.databaseFile, { readonly: true });
    try {
      const call = db.query('SELECT status,result_json,delivery_json FROM tool_calls WHERE id=?').get(fillToolId) as {
        status: string; result_json: string; delivery_json: string };
      if (outcome === 'late-applied') expect(['cancelled', 'failed']).toContain(call.status);
      else expect(call.status).toBe(['applied', 'toolResult-save-failure'].includes(outcome) ? 'succeeded' : 'failed');
      const storedResult = JSON.parse(call.result_json);
      expect(storedResult.status).toBe(call.status);
      expect(storedResult.committedCandidateId).toBeNull();
      if (call.status === 'succeeded') expect(storedResult.data).toEqual({ candidateId, candidateSequence: 1, applied: true });
      else expect(storedResult.data).toBeUndefined();
      if (outcome === 'unknown') expect(storedResult.error.code).toBe('operation_result_unknown');
      if (outcome === 'invalid-receipt') expect(storedResult.error.code).toBe('state_conflict');
      expect(storedResult.formApplication.outcome).toBe(outcome === 'not_applied' ? 'not_applied' : 'applied');
      if (outcome === 'late-applied' || outcome === 'toolResult-save-failure') expect(JSON.parse(call.delivery_json).state).not.toBe('request_observed');
      else expect(JSON.parse(call.delivery_json).state).toBe('request_observed');
      expect(db.query('SELECT status FROM invoice_candidates WHERE id=?').get(candidateId)).toEqual({ status: 'generated' });
      expect(db.query('SELECT COUNT(*) AS count FROM runs').get()).toEqual({ count: 2 });
      expect(db.query('SELECT COUNT(*) AS count FROM tool_calls').get()).toEqual({ count: 2 });
      expect(db.query('SELECT COUNT(*) AS count FROM invoice_candidates').get()).toEqual({ count: outcome === 'applied' ? 2 : 1 });
    } finally { db.close(); }
  }, 15_000);
});
