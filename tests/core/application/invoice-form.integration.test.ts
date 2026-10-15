import { describe, expect, it } from 'bun:test';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { Database } from 'bun:sqlite';
import { InMemoryCredentialStore } from '@earendil-works/pi-ai';
import { appError, fail, InvoiceFormDraftSchema, CandidateDraftSchema, ContextSnapshotJsonSchema, ContextObservationsSchema, invoiceLineFields, formatExecutionPrompt, RESEARCH_PLANNING_TOOL_NAMES, RESEARCH_INVESTIGATION_TOOL_NAMES } from '@flowmate/contracts';
import type { AgentRunEvent, AgentRunRequest, Application, InvoiceFormApplicationReceipt, InvoiceFormBridgeRequest,
  ProviderConfig, Result, FillInputRequest, WorkspaceSnapshot } from '@flowmate/contracts';
import { createApplication } from '../../../apps/composition.ts';
import { PiAgentAdapter } from '../../../packages/runtime-pi/src/session.ts';
import { openDatabase } from '../../../packages/core/src/storage/database.ts';
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
async function run(app: Application, request: AgentRunRequest | FillInputRequest, fill = false) {
  let finish!: (event: AgentRunEvent & { type: 'run_finished' }) => void;
  const terminal = new Promise<AgentRunEvent & { type: 'run_finished' }>(resolve => { finish = resolve; });
  const control = { onEvent(event: AgentRunEvent) { if (event.type === 'run_finished') finish(event); } };
  const accepted = need(await (fill ? app.submitInput(request as FillInputRequest, control) : app.startRun(request, control)));
  if (accepted.inputId === undefined) throw new Error('P5 Run requires a durable input ID.');
  return { accepted: { ...accepted, inputId: accepted.inputId }, finished: await terminal };
}

describe('Fill backend through the public Application', () => {
  it('T10 F8-06 sends a complete real 64-line large candidate Fill prompt to HTTP and the trusted form bridge', async () => {
    const root = mkdtempSync(join(tmpdir(), 'flowmate-t10-large-fill-'));
    const paths = productPaths(join(root, 'product'));
    const sourceRoot = join(root, 'source'), source = join(sourceRoot, '000001'); writeInvoice(source);
    const values = Array.from({ length: 64 }, (_, index) => `T10-line-${index}:` + '😀'.repeat(256));
    const modelCandidate = CandidateDraftSchema.parse(candidate);
    const requests: Array<{ messages: Array<{ role: string; content?: unknown }>; tools?: Array<{ function: { name: string } }> }> = [];
    const bridgeCalls: InvoiceFormBridgeRequest[] = []; let documentId = 0, candidateId = 0;
    const server = Bun.serve({ hostname: '127.0.0.1', port: 0, async fetch(request) {
      requests.push(await request.json()); const ordinal = requests.length;
      const tool = ordinal === 1 ? { name: 'save_invoice_candidate', input: { documentId, candidate: modelCandidate } }
        : ordinal === 3 ? { name: 'fill_invoice_form', input: { candidateId } } : null;
      const delta = tool ? { role: 'assistant', tool_calls: [{ index: 0, id: `t10-fill-${ordinal}`, type: 'function',
        function: { name: tool.name, arguments: JSON.stringify(tool.input) } }] } : { role: 'assistant', content: 'Controlled completed Fill.' };
      const chunk = (value: unknown, reason: string | null) => 'data: ' + JSON.stringify({ choices: [{ index: 0, delta: value, finish_reason: reason }] }) + '\n\n';
      return new Response(chunk(delta, null) + chunk({}, tool ? 'tool_calls' : 'stop') + 'data: [DONE]\n\n', { headers: { 'content-type': 'text/event-stream' } });
    } });
    deferCleanup(() => server.stop(true));
    const config: ProviderConfig = { version: 1, name: 'T10 large Fill', revision: 1, modelRef: { provider: 't10-fill', model: 'fixture' },
      native: { authPath: join(root, 'unused.json'), modelsPath: null }, connection: { baseUrl: `http://127.0.0.1:${server.port}/v1`,
        api: 'openai-completions', contextWindow: 64000, maxTokens: 16384 }, parameters: { maxRetries: 0, maxRetryDelayMs: 100 } };
    const app = need(await createApplication({ paths, invoiceSourceRoot: sourceRoot, logger: { write() {}, async close() {} },
      invoiceFormBridge: async request => { bridgeCalls.push(structuredClone(request)); const base = unknownReceipt(request);
        return { ...base, outcome: 'applied', appliedRevision: request.target.expectedRevision + 1, appliedAt: base.observedAt }; },
      agentFactory: (tools, resourceContents) => new PiAgentAdapter({ cwd: paths.runtimeDir, agentDir: paths.runtimeDir, tools, resourceContents,
        credentials: new InMemoryCredentialStore(), runtimeApiKey: 'synthetic-large-fill-key' }) }));
    deferCleanup(() => app.close());
    const doc = need(await app.importInvoiceMaterial(source)); documentId = doc.documentRef.id;
    const session = need(await app.createSession({ title: 'Large Fill', expectedRevision: need(await app.readWorkspace()).revision }));
    const current = need(await app.updateWorkspace({ expectedRevision: need(await app.readWorkspace()).revision, change: { kind: 'document', documentId } }));
    const task = need(await app.startTask({ clientSequence: 1, expectedRevision: current.revision, documentRef: doc.documentRef, goal: 'Review complete large candidate' }));
    const generated = await run(app, { sessionId: session.sessionId, goalMode: 'save-candidate', text: 'Save every line.', workspace: expectation(task.workspace), config, timeoutMs: 5000, stopGraceMs: 500 });
    expect(generated.finished.result).toMatchObject({ ok: true, data: { status: 'completed' } });
    const saved = need(await app.listJobCandidates({ jobId: task.job.jobId })).items[0]!; candidateId = saved.candidateId;
    expect(saved.context).toMatchObject({ snapshotId: expect.any(Number), requestSequence: 1 });
    const selected = need(await app.selectCandidate({ jobId: task.job.jobId, candidateId, expectedCandidateId: null, expectedRevision: need(await app.readWorkspace()).revision }));
    const formDraft = InvoiceFormDraftSchema.parse({ fields: Object.fromEntries(Object.keys(candidate.fields).map(name => [name, ''])),
      lines: values.map(description => ({ ...Object.fromEntries(invoiceLineFields.map(name => [name, ''])), description })), notes: [] });
    const human = need(await app.saveInvoiceCandidate({ operationRef: 't10-large-human-edit', jobId: task.job.jobId,
      expectedCandidateId: candidateId, expectedRevision: selected.workspace.revision, basedOnCandidateId: candidateId, draft: formDraft,
      lineOrigins: formDraft.lines.map(() => null) }));
    const large = { fields: human.candidate.fields, lines: human.candidate.lines, notes: human.candidate.notes };
    expect(human.candidate).toMatchObject({ origin: 'human_edit', basedOnCandidateId: candidateId, runId: null, toolCallId: null, context: null });
    candidateId = human.candidate.candidateId;
    expect(Buffer.byteLength(JSON.stringify(large))).toBeGreaterThan(65536);
    expect(Buffer.byteLength(JSON.stringify(large))).toBeLessThan(262144);
    const filled = await run(app, { sessionId: session.sessionId, clientSequence: 2, mode: 'prompt', goalMode: 'fill-form', text: 'Apply every complete line.',
      workspace: expectation(human.workspace), config, formTarget: { formInstanceId: 'private-t10-form', expectedRevision: 4 }, timeoutMs: 5000, stopGraceMs: 500 }, true);
    expect(filled.finished.result).toMatchObject({ ok: true, data: { status: 'completed' } });
    const input = need(await app.querySessionInput({ sessionId: session.sessionId, inputId: filled.accepted.inputId })).input!;
    const content = input.content;
    if (content.version !== 2 || input.mode !== 'prompt' || !content.workspaceInput) throw new Error('Real frozen V2 Fill required.');
    const wire = requests[2]!;
    expect(wire.messages.filter(message => message.role === 'user').at(-1)?.content).toEqual([{ type: 'text', text: content.promptText }]);
    expect(Buffer.byteLength(content.promptText)).toBeGreaterThan(65536);
    expect(content.promptText.startsWith(formatExecutionPrompt({ text: content.text, business: true, goalMode: 'fill-form',
      workspaceInput: content.workspaceInput, ...(content.workspaceContext ? { workspaceContext: content.workspaceContext } : {}) }))).toBe(true);
    for (const value of values) expect(content.promptText).toContain(value);
    expect(wire.tools?.map(tool => tool.function.name)).toEqual(['fill_invoice_form']);
    expect(JSON.stringify(wire)).not.toContain('private-t10-form');
    const apply = bridgeCalls[0]!; expect(bridgeCalls).toHaveLength(1);
    expect(apply.operation).toBe('apply');
    if (apply.operation !== 'apply') throw new Error('Real apply bridge required.');
    expect(apply.target).toEqual({ formInstanceId: 'private-t10-form', expectedRevision: 4 });
    expect(apply.candidate.lines).toEqual(large.lines);
    const detail = need(await app.queryContextSnapshot({ sessionId: session.sessionId, runId: filled.accepted.runId, snapshotId: input.contextSnapshotId! }));
    expect(detail.snapshot.json.modelProjection.candidate).toMatchObject({ id: candidateId, sequence: human.candidate.sequence, origin: 'human_edit', values: [] });
    expect(detail.snapshot.json.modelProjection.fragments).toEqual([]);
    expect(requests).toHaveLength(4); expect(need(await app.close()).closed).toBe(true);
    const db = new Database(paths.databaseFile, { readonly: true });
    try {
      const snapshot = db.query<{ snapshot_json: string }, [number]>('SELECT snapshot_json FROM context_snapshots WHERE id=?').get(input.contextSnapshotId!)!;
      const savedSnapshot = ContextSnapshotJsonSchema.parse(JSON.parse(snapshot.snapshot_json));
      expect(savedSnapshot.modelProjection).toEqual(detail.snapshot.json.modelProjection);
      expect(savedSnapshot).toMatchObject({ goalMode: 'fill-form', workingDirectory: null, workspaceContext: { candidateRef: { id: candidateId, sequence: human.candidate.sequence } } });
      expect(Buffer.byteLength(snapshot.snapshot_json)).toBeLessThanOrEqual(262144);
      const row = db.query<{ context_observations_json: string }, [number]>('SELECT context_observations_json FROM runs WHERE id=?').get(filled.accepted.runId)!;
      const journal = ContextObservationsSchema.parse(JSON.parse(row.context_observations_json));
      expect(journal.requests).toHaveLength(2);
      expect(journal.requests[0]).toMatchObject({ binding: { inputId: input.inputId, snapshotId: input.contextSnapshotId },
        sdkPayload: { inclusion: 'confirmed' }, attempts: [expect.objectContaining({ wireInclusion: 'confirmed', responseStatus: 200 })] });
      expect(db.query('PRAGMA foreign_key_check').all()).toEqual([]);
    } finally { db.close(); }
  });
  it('blocks a queued input when its frozen document becomes unavailable', async () => {
    const root = mkdtempSync(join(tmpdir(), 'flowmate-p5-unavailable-input-'));
    const paths = productPaths(join(root, 'product'));
    const sourceRoot = join(root, 'source'); const source = join(sourceRoot, '000001'); writeInvoice(source);
    let entered!: () => void; const firstRequest = new Promise<void>(resolve => { entered = resolve; });
    let release!: () => void; const barrier = new Promise<void>(resolve => { release = resolve; });
    const requests: unknown[] = [];
    const server = Bun.serve({ hostname: '127.0.0.1', port: 0, async fetch(request) {
      requests.push(await request.json());
      if (requests.length === 1) { entered(); await barrier; }
      const chunk = (delta: unknown, reason: string | null) => `data: ${JSON.stringify({ id: `unavailable-${requests.length}`,
        model: 'unavailable-model', choices: [{ index: 0, delta, finish_reason: reason }] })}\n\n`;
      return new Response(`${chunk({ role: 'assistant', content: 'Controlled answer.' }, null)}${chunk({}, 'stop')}data: [DONE]\n\n`,
        { headers: { 'content-type': 'text/event-stream' } });
    } });
    deferCleanup(() => server.stop(true));
    const config: ProviderConfig = { version: 1, name: 'Controlled unavailable input', revision: 1,
      modelRef: { provider: 'unavailable-fixture', model: 'unavailable-model' }, native: { authPath: join(root, 'unused.json'), modelsPath: null },
      connection: { baseUrl: `http://127.0.0.1:${server.port}/v1`, api: 'openai-completions', contextWindow: 64_000, maxTokens: 16_384 },
      parameters: { maxRetries: 0, maxRetryDelayMs: 100 } };
    const app = need(await createApplication({ paths, invoiceSourceRoot: sourceRoot, logger: { write() {}, async close() {} },
      agentFactory: (tools, resourceContents) => new PiAgentAdapter({ cwd: paths.runtimeDir, agentDir: paths.runtimeDir, tools, resourceContents,
        credentials: new InMemoryCredentialStore(), runtimeApiKey: 'synthetic-unavailable-key' }) }));
    deferCleanup(async () => { await app.close(); });
    deferCleanup(() => release());
    const document = need(await app.importInvoiceMaterial(source));
    const current = need(await app.readWorkspace());
    const session = need(await app.createSession({ title: 'Frozen material', expectedRevision: current.revision }));
    const workspace = need(await app.updateWorkspace({ expectedRevision: need(await app.readWorkspace()).revision,
      change: { kind: 'document', documentId: document.documentRef.id } }));
    let finished!: (event: AgentRunEvent & { type: 'run_finished' }) => void;
    const terminal = new Promise<AgentRunEvent & { type: 'run_finished' }>(resolve => { finished = resolve; });
    const accepted = need(await app.submitInput({ sessionId: session.sessionId, clientSequence: 1, mode: 'prompt',
      text: 'Read this invoice.', workspace: expectation(workspace), config, timeoutMs: 5000, stopGraceMs: 500 },
    { onEvent(event) { if (event.type === 'run_finished') finished(event); } }));
    await firstRequest;
    const queued = need(await app.submitInput({ sessionId: session.sessionId, clientSequence: 2, mode: 'followUp', runId: accepted.runId,
      text: 'Continue reading the same invoice.', workspace: expectation(workspace) }));
    const frozen = need(await app.querySessionInput({ sessionId: session.sessionId, inputId: queued.inputId })).input;
    writeFileSync(join(paths.artifactsDir, String(document.originalArtifactId), 'original.png'), 'corrupt-original');
    expect(await app.readDocumentOriginal(document.documentRef.id, 1)).toMatchObject({ ok: false, error: { code: 'input_unavailable' } });
    expect(need(await app.queryDocument(document.documentRef.id)).status).toBe('unavailable');
    release();
    expect((await terminal).result).toMatchObject({ ok: true, data: { status: 'failed', error: { code: 'input_unavailable' } } });
    expect(requests).toHaveLength(1);
    const saved = need(await app.querySessionInput({ sessionId: session.sessionId, inputId: queued.inputId })).input!;
    expect(saved.content).toEqual(frozen!.content);
    expect(saved.processingStatus).toBe('failed');
    expect(saved.nativeEntryId).toBeNull();
    expect(need(await app.querySession(session.sessionId)).availability).toBe('unusable');
  });

  it.each(['schema', 'ambiguity', 'source'] as const)('delivers actionable %s failure feedback before a corrected candidate is saved', async scenario => {
    const root = mkdtempSync(join(tmpdir(), 'flowmate-candidate-feedback-'));
    const paths = productPaths(join(root, 'product'));
    const sourceRoot = join(root, 'source'); const sourcePath = join(sourceRoot, '000001'); writeInvoice(sourcePath);
    const requests: { messages: { role: string; tool_call_id?: string; content?: unknown }[] }[] = [];
    let bad: unknown; let corrected: unknown;
    const expected = scenario === 'schema' ? 'candidate.notes' : scenario === 'ambiguity' ? 'ambiguous_alternatives_missing' : 'source_invalid';
    const server = Bun.serve({ hostname: '127.0.0.1', port: 0, async fetch(request) {
      requests.push(await request.json());
      const ordinal = requests.length;
      const feedback = String(requests.at(-1)?.messages.find(message => message.tool_call_id === 'feedback-bad')?.content ?? '');
      const args = ordinal === 1 ? bad : ordinal === 2 && feedback.includes(expected) ? corrected : null;
      const delta = args ? { role: 'assistant', tool_calls: [{ index: 0, id: ordinal === 1 ? 'feedback-bad' : 'feedback-fixed', type: 'function',
        function: { name: 'save_invoice_candidate', arguments: JSON.stringify(args) } }] }
        : { role: 'assistant', content: 'Controlled repair finished.' };
      const chunk = (value: unknown, reason: string | null) => `data: ${JSON.stringify({ id: `feedback-${ordinal}`,
        model: 'feedback-model', choices: [{ index: 0, delta: value, finish_reason: reason }] })}\n\n`;
      return new Response(`${chunk(delta, null)}${chunk({}, args ? 'tool_calls' : 'stop')}data: [DONE]\n\n`,
        { headers: { 'content-type': 'text/event-stream' } });
    } });
    deferCleanup(() => server.stop(true));
    const config: ProviderConfig = { version: 1, name: 'Controlled candidate feedback', revision: 1,
      modelRef: { provider: 'feedback-fixture', model: 'feedback-model' }, native: { authPath: join(root, 'unused.json'), modelsPath: null },
      connection: { baseUrl: `http://127.0.0.1:${server.port}/v1`, api: 'openai-completions', contextWindow: 64_000, maxTokens: 16_384 },
      parameters: { maxRetries: 0, maxRetryDelayMs: 100 } };
    const app = need(await createApplication({ paths, invoiceSourceRoot: sourceRoot, logger: { write() {}, async close() {} },
      agentFactory: (tools, resourceContents) => new PiAgentAdapter({ cwd: paths.runtimeDir, agentDir: paths.runtimeDir, tools, resourceContents,
        credentials: new InMemoryCredentialStore(), runtimeApiKey: 'synthetic-feedback-key' }) }));
    deferCleanup(async () => { await app.close(); });
    const doc = need(await app.importInvoiceMaterial(sourcePath));
    corrected = { documentId: doc.documentRef.id, candidate };
    if (scenario === 'schema') {
      const { notes: _notes, ...withoutNotes } = candidate;
      bad = { documentId: doc.documentRef.id, candidate: { ...withoutNotes, unexpected: 'PRIVATE_DIAGNOSTIC_SENTINEL' } };
    } else if (scenario === 'ambiguity') {
      bad = { documentId: doc.documentRef.id, candidate: { ...candidate, fields: { ...candidate.fields,
        currency: { ...missing, raw: '$', state: 'ambiguous', alternatives: ['USD'] } } } };
    } else {
      const field = { raw: '100.00', normalized: '100.00', state: 'present', alternatives: [],
        sources: [{ documentId: doc.documentRef.id, version: doc.documentRef.version, artifactId: doc.parsedArtifactId,
          page: 1, blockId: 'b1', quote: '100.00' }] };
      corrected = { documentId: doc.documentRef.id, candidate: { ...candidate, fields: { ...candidate.fields, totalAmount: field } } };
      bad = { documentId: doc.documentRef.id, candidate: { ...candidate, fields: { ...candidate.fields,
        totalAmount: { ...field, sources: [{ ...field.sources[0], version: 'incorrect-version' }] } } } };
    }
    const initial = need(await app.readWorkspace());
    const session = need(await app.createSession({ title: 'Candidate feedback', expectedRevision: initial.revision }));
    let workspace = need(await app.readWorkspace());
    workspace = need(await app.updateWorkspace({ expectedRevision: workspace.revision, change: { kind: 'document', documentId: doc.documentRef.id } }));
    const task = need(await app.startTask({ clientSequence: 1, expectedRevision: workspace.revision, documentRef: doc.documentRef, goal: 'Save a candidate.' }));
    const generated = await run(app, { sessionId: session.sessionId, goalMode: 'save-candidate', text: 'Save a candidate.',
      workspace: expectation(task.workspace), config, timeoutMs: 5000, stopGraceMs: 500 });
    const feedback = String(requests[1]?.messages.find(message => message.tool_call_id === 'feedback-bad')?.content ?? '');
    expect(feedback).toContain(expected);
    expect(feedback).not.toContain('PRIVATE_DIAGNOSTIC_SENTINEL');
    expect(new TextEncoder().encode(feedback).byteLength).toBeLessThan(4096);
    if (scenario !== 'schema') expect(feedback).toContain(scenario === 'source' ? '/fields/totalAmount' : '/fields/currency');
    if (scenario === 'source') expect(feedback).toContain(doc.documentRef.version);
    expect(generated.finished.result).toMatchObject({ ok: true, data: { status: 'completed' } });
    expect(requests).toHaveLength(3);
    expect(need(await app.listJobCandidates({ jobId: task.job.jobId })).items).toHaveLength(1);
    expect(need(await app.querySessionInput({ sessionId: session.sessionId, inputId: generated.accepted.inputId })).input)
      .toMatchObject({ status: 'consumed', processingStatus: 'completed' });
    need(await app.close());
    const db = new Database(paths.databaseFile, { readonly: true });
    try {
      const rows = db.query('SELECT status,result_json FROM tool_calls WHERE run_id=? ORDER BY id').all(generated.accepted.runId) as
        { status: string; result_json: string }[];
      expect(rows.map(row => row.status)).toEqual(['failed', 'succeeded']);
      expect(JSON.parse(rows[0]!.result_json).committedCandidateId).toBeNull();
      expect(JSON.parse(rows[1]!.result_json).committedCandidateId).toBeNumber();
      const entries = db.query('SELECT entry_json FROM session_native_entries WHERE run_id=?').all(generated.accepted.runId) as { entry_json: string }[];
      expect(entries.map(row => JSON.parse(row.entry_json).message).find(message => message?.toolCallId === 'feedback-bad'))
        .toMatchObject({ role: 'toolResult', isError: true });
    } finally { db.close(); }
  });

  it('finishes the saved candidate and input when saving uses the twelfth model call and the receipt needs the thirteenth', async () => {
    const root = mkdtempSync(join(tmpdir(), 'flowmate-late-save-budget-'));
    const paths = productPaths(join(root, 'product'));
    const sourceRoot = join(root, 'source'); const source = join(sourceRoot, '000001'); writeInvoice(source);
    let documentId = 0;
    const requests: { messages: { role: string; content?: unknown; tool_call_id?: string }[] }[] = [];
    const server = Bun.serve({ hostname: '127.0.0.1', port: 0, async fetch(request) {
      requests.push(await request.json());
      const ordinal = requests.length;
      const tool = ordinal <= 12 ? { name: ordinal === 12 ? 'save_invoice_candidate' : 'validate_invoice_candidate',
        arguments: { documentId, candidate } } : null;
      const delta = tool ? { role: 'assistant', tool_calls: [{ index: 0, id: `budget-call-${ordinal}`, type: 'function',
        function: { name: tool.name, arguments: JSON.stringify(tool.arguments) } }] }
        : { role: 'assistant', content: 'The candidate was saved for review.' };
      const chunk = (value: unknown, reason: string | null) => `data: ${JSON.stringify({ id: `budget-response-${ordinal}`,
        model: 'budget-model', choices: [{ index: 0, delta: value, finish_reason: reason }] })}\n\n`;
      return new Response(`${chunk(delta, null)}${chunk({}, tool ? 'tool_calls' : 'stop')}data: [DONE]\n\n`,
        { headers: { 'content-type': 'text/event-stream' } });
    } });
    deferCleanup(() => server.stop(true));
    const config: ProviderConfig = { version: 1, name: 'Controlled late save', revision: 1,
      modelRef: { provider: 'budget-fixture', model: 'budget-model' }, native: { authPath: join(root, 'unused.json'), modelsPath: null },
      connection: { baseUrl: `http://127.0.0.1:${server.port}/v1`, api: 'openai-completions', contextWindow: 64_000, maxTokens: 16_384 },
      parameters: { maxRetries: 0, maxRetryDelayMs: 100 } };
    const app = need(await createApplication({ paths, invoiceSourceRoot: sourceRoot, logger: { write() {}, async close() {} },
      agentFactory: (tools, resourceContents) => new PiAgentAdapter({ cwd: paths.runtimeDir, agentDir: paths.runtimeDir, tools, resourceContents,
        credentials: new InMemoryCredentialStore(), runtimeApiKey: 'synthetic-budget-key' }) }));
    deferCleanup(async () => { await app.close(); });
    const doc = need(await app.importInvoiceMaterial(source)); documentId = doc.documentRef.id;
    const initial = need(await app.readWorkspace());
    const session = need(await app.createSession({ title: 'Late save budget', expectedRevision: initial.revision }));
    let workspace = need(await app.readWorkspace());
    workspace = need(await app.updateWorkspace({ expectedRevision: workspace.revision, change: { kind: 'document', documentId } }));
    const task = need(await app.startTask({ clientSequence: 1, expectedRevision: workspace.revision,
      documentRef: doc.documentRef, goal: 'Save a candidate for review.' }));
    const generated = await run(app, { sessionId: session.sessionId, goalMode: 'save-candidate', text: 'Save a candidate.',
      workspace: expectation(task.workspace), config, timeoutMs: 30000, stopGraceMs: 500 });
    expect(need(await app.listJobCandidates({ jobId: task.job.jobId })).items).toHaveLength(1);
    expect(generated.finished.result).toMatchObject({ ok: true, data: { status: 'completed', text: 'The candidate was saved for review.' } });
    expect(requests).toHaveLength(13);
    expect(requests[12]!.messages.find(message => message.role === 'tool' && message.tool_call_id === 'budget-call-12')).toBeDefined();
    expect(need(await app.queryRun(generated.accepted.runId))).toMatchObject({ status: 'completed', config: { agent: { maxModelCalls: 16 } } });
    expect(need(await app.querySessionInput({ sessionId: session.sessionId, inputId: generated.accepted.inputId })).input)
      .toMatchObject({ status: 'consumed', processingStatus: 'completed', nativeEntryId: expect.any(String), resultEntryId: expect.any(String) });
    expect(need(await app.queryJob(task.job.jobId))).toMatchObject({ status: 'waiting', reason: 'review_candidate', acceptedCandidateId: null });
    need(await app.close());
    const proof = new Database(paths.databaseFile, { readonly: true });
    try {
      const savedTool = proof.query('SELECT result_json,delivery_json FROM tool_calls WHERE run_id=? AND native_tool_call_id=?')
        .get(generated.accepted.runId, 'budget-call-12') as { result_json: string; delivery_json: string };
      expect(JSON.parse(savedTool.result_json)).toMatchObject({ status: 'succeeded', committedCandidateId: expect.any(Number) });
      expect(JSON.parse(savedTool.delivery_json)).toMatchObject({ state: 'request_observed', includedInCallSequence: 13 });
    } finally { proof.close(); }
  });

  it.each(['normal', 'failure-save', 'workspace-change', 'revoke'] as const)('keeps an unmet initial save goal failed when a later FollowUp saves a candidate, and freezes each compatible Workspace: %s', async scenario => {
    const rejectFailureSave = scenario === 'failure-save';
    const root = mkdtempSync(join(tmpdir(), 'flowmate-p5-late-candidate-'));
    const paths = productPaths(join(root, 'product'));
    const sourceRoot = join(root, 'source'); const source = join(sourceRoot, '000001'); writeInvoice(source);
    let documentId = 0;
    let entered!: () => void; const firstRequest = new Promise<void>(resolve => { entered = resolve; });
    let release!: () => void; const barrier = new Promise<void>(resolve => { release = resolve; });
    const requests: { messages: { role: string; content?: unknown }[] }[] = [];
    const server = Bun.serve({ hostname: '127.0.0.1', port: 0, async fetch(request) {
      requests.push(await request.json());
      const ordinal = requests.length;
      if (ordinal === 1) { entered(); await barrier; }
      const delta = ordinal === 2 ? { role: 'assistant', tool_calls: [{ index: 0, id: 'late-candidate-tool', type: 'function',
        function: { name: 'save_invoice_candidate', arguments: JSON.stringify({ documentId, candidate }) } }] }
        : { role: 'assistant', content: ordinal === 1 ? 'Initial reply without a saved candidate.' : 'Later candidate delivered.' };
      const chunk = (value: unknown, reason: string | null) => `data: ${JSON.stringify({ id: `late-candidate-${ordinal}`,
        model: 'late-model', choices: [{ index: 0, delta: value, finish_reason: reason }] })}\n\n`;
      return new Response(`${chunk(delta, null)}${chunk({}, ordinal === 2 ? 'tool_calls' : 'stop')}data: [DONE]\n\n`,
        { headers: { 'content-type': 'text/event-stream' } });
    } });
    deferCleanup(() => server.stop(true));
    const config: ProviderConfig = { version: 1, name: 'Controlled late candidate', revision: 1,
      modelRef: { provider: 'late-fixture', model: 'late-model' }, native: { authPath: join(root, 'unused.json'), modelsPath: null },
      connection: { baseUrl: `http://127.0.0.1:${server.port}/v1`, api: 'openai-completions', contextWindow: 64_000, maxTokens: 16_384 },
      parameters: { maxRetries: 0, maxRetryDelayMs: 100 } };
    if (rejectFailureSave) {
      const fault = need(openDatabase(paths));
      try { fault.db.exec("CREATE TRIGGER reject_goal_failure BEFORE UPDATE OF processing_status ON session_inputs WHEN NEW.processing_status='failed' AND json_extract(NEW.error_json,'$.code')='agent_goal_not_met' BEGIN SELECT RAISE(ABORT,'goal failure save rejected'); END;"); }
      finally { fault.close(); }
    }
    const app = need(await createApplication({ paths, invoiceSourceRoot: sourceRoot, logger: { write() {}, async close() {} },
      agentFactory: (tools, resourceContents) => new PiAgentAdapter({ cwd: paths.runtimeDir, agentDir: paths.runtimeDir, tools, resourceContents,
        credentials: new InMemoryCredentialStore(), runtimeApiKey: 'synthetic-late-candidate-key' }) }));
    deferCleanup(async () => { await app.close(); });
    deferCleanup(() => release());
    const doc = need(await app.importInvoiceMaterial(source)); documentId = doc.documentRef.id;
    const initial = need(await app.readWorkspace());
    const session = need(await app.createSession({ title: 'Late candidate', expectedRevision: initial.revision }));
    let workspace = need(await app.readWorkspace());
    workspace = need(await app.updateWorkspace({ expectedRevision: workspace.revision, change: { kind: 'document', documentId } }));
    const task = need(await app.startTask({ clientSequence: 1, expectedRevision: workspace.revision, documentRef: doc.documentRef, goal: 'Save candidate.' }));
    const originalWorkspace = expectation(task.workspace);
    let finished!: (event: AgentRunEvent & { type: 'run_finished' }) => void;
    const terminal = new Promise<AgentRunEvent & { type: 'run_finished' }>(resolve => { finished = resolve; });
    const prompt = { sessionId: session.sessionId, clientSequence: 1, mode: 'prompt' as const, goalMode: 'save-candidate' as const,
      text: 'Initially save a candidate.', workspace: originalWorkspace, config, timeoutMs: 5000, stopGraceMs: 500 };
    const accepted = need(await app.submitInput(prompt, { onEvent(event) { if (event.type === 'run_finished') finished(event); } }));
    await firstRequest;
    const changedView = need(await app.updateWorkspace({ expectedRevision: task.workspace.revision, change: { kind: 'view', view: 'parsed' } }));
    const compatibleWorkspace = expectation(changedView);
    const follow = need(await app.submitInput({ sessionId: session.sessionId, clientSequence: 2, mode: 'followUp', runId: accepted.runId,
      text: 'Now save the candidate in this later response.', workspace: compatibleWorkspace }));
    expect(await app.submitInput({ sessionId: session.sessionId, clientSequence: 3, mode: 'steer', runId: accepted.runId,
      text: 'Cross another document.', workspace: { ...compatibleWorkspace, documentRef: { id: documentId + 100, version: 'other' } } }))
      .toMatchObject({ ok: false, error: { code: 'state_conflict' } });
    expect(await app.submitInput(prompt)).toEqual({ ok: true, data: accepted });
    const frozen = need(await app.listSessionInputs({ sessionId: session.sessionId })).items;
    expect(frozen).toHaveLength(2);
    expect(frozen.find(input => input.inputId === accepted.inputId)?.content.workspaceContext?.revision).toBe(originalWorkspace.revision);
    expect(frozen.find(input => input.inputId === follow.inputId)?.content.workspaceContext?.revision).toBe(compatibleWorkspace.revision);
    expect(frozen.every(input => JSON.stringify(input.content.allowedDocumentIds) === JSON.stringify([documentId]))).toBe(true);
    const frozenFollow = frozen.find(input => input.inputId === follow.inputId)!;
    expect(frozenFollow).toMatchObject({ status: 'queued', processingStatus: 'pending', nativeEntryId: null, runId: accepted.runId });
    if (scenario === 'workspace-change') {
      const otherSession = need(await app.createSession({ title: 'Selected while input is queued', expectedRevision: changedView.revision }));
      const current = need(await app.readWorkspace());
      const changed = need(await app.updateWorkspace({ expectedRevision: current.revision, change: { kind: 'document', documentId: null } }));
      expect(changed).toMatchObject({ sessionId: otherSession.sessionId, documentRef: null, jobId: null, candidateRef: null });
      expect(need(await app.querySessionInput({ sessionId: session.sessionId, inputId: follow.inputId })).input?.content).toEqual(frozenFollow.content);
      expect(need(await app.queryRun(accepted.runId))).toMatchObject({ sessionId: session.sessionId,
        scope: { allowedDocumentIds: [documentId] }, config: { workspaceContext: { sessionId: session.sessionId, documentRef: doc.documentRef, jobId: task.job.jobId } } });
    }
    if (scenario === 'revoke') {
      expect(await app.revokeDocumentUse(documentId)).toEqual({ ok: true, data: { affectedSessionIds: [session.sessionId], stopRequested: true } });
      expect(need(await app.querySession(session.sessionId)).modelUseBlocked).toBe(true);
    }
    release();
    const end = await terminal;
    if (scenario === 'revoke') {
      expect(end.result).toMatchObject({ ok: true, data: { status: 'cancelled', stopped: true } });
      const inputs = need(await app.listSessionInputs({ sessionId: session.sessionId })).items;
      expect(inputs.find(input => input.inputId === follow.inputId)).toMatchObject({ status: 'cancelled', processingStatus: 'cancelled',
        nativeEntryId: null, resultEntryId: null, content: frozenFollow.content });
      expect(inputs.find(input => input.inputId === accepted.inputId)).toMatchObject({ status: 'consumed', processingStatus: 'cancelled',
        nativeEntryId: expect.any(String), resultEntryId: null });
      expect(await app.submitInput(prompt)).toEqual({ ok: true, data: accepted });
      expect(await app.submitInput({ ...prompt, clientSequence: 4 })).toMatchObject({ ok: false, error: { code: 'session_scope_revoked' } });
      expect(requests).toHaveLength(1);
      expect(need(await app.listJobCandidates({ jobId: task.job.jobId })).items).toEqual([]);
      return;
    }
    if (rejectFailureSave) {
      expect(need(await app.queryRuntimeState()).blocked).toBe(true);
      expect(end.result).toMatchObject({ ok: false, error: { code: 'storage_write_failed' } });
      expect(need(await app.querySessionInput({ sessionId: session.sessionId, inputId: accepted.inputId })).input)
        .toMatchObject({ status: 'consumed', processingStatus: 'failed', nativeEntryId: expect.any(String), resultEntryId: expect.any(String) });
      expect(need(await app.queryRun(accepted.runId)).status).toBe('failed');
      expect(await app.submitInput(prompt)).toEqual({ ok: true, data: accepted });
      expect(await app.submitInput({ ...prompt, clientSequence: 4 })).toMatchObject({ ok: false, error: { code: 'runtime_unusable' } });
      expect(requests).toHaveLength(1);
      expect(need(await app.listJobCandidates({ jobId: task.job.jobId })).items).toEqual([]);
      return;
    }
    expect(end.result).toMatchObject({ ok: true, data: { status: 'failed', error: { code: 'agent_goal_not_met' } } });
    const inputs = need(await app.listSessionInputs({ sessionId: session.sessionId })).items;
    const firstInput = inputs.find(input => input.inputId === accepted.inputId)!;
    const followInput = inputs.find(input => input.inputId === follow.inputId)!;
    expect(firstInput).toMatchObject({ status: 'consumed', processingStatus: 'failed', resultEntryId: expect.any(String), error: { code: 'agent_goal_not_met' } });
    expect(followInput).toMatchObject({ status: 'consumed', processingStatus: 'completed', resultEntryId: expect.any(String), error: null });
    expect(followInput.content).toEqual(frozenFollow.content);
    expect(firstInput.resultEntryId).not.toBe(followInput.resultEntryId);
    expect(need(await app.listJobCandidates({ jobId: task.job.jobId })).items).toHaveLength(1);
    expect(requests).toHaveLength(3);
    if (frozenFollow.content.version !== 2) throw new Error('P5 fixture must freeze the exact V2 prompt.');
    expect(requests[1]!.messages.filter(message => message.role === 'user').at(-1)!.content)
      .toEqual([{ type: 'text', text: frozenFollow.content.promptText }]);
  });
  it.each([false, true])('registers Fill only when a trusted bridge is present: %s', async bridgePresent => {
    const root = mkdtempSync(join(tmpdir(), 'flowmate-form-manifest-'));
    let names: readonly string[] = [];
    const app = need(await createApplication({ paths: productPaths(root), logger: { write() {}, async close() {} },
      ...(bridgePresent ? { invoiceFormBridge: async (request: InvoiceFormBridgeRequest) => unknownReceipt(request) } : {}),
      agentFactory: (tools, resourceContents) => {
        names = tools.map(tool => tool.name);
        return { createSession: () => { throw new Error('No Session is needed.'); }, inspect: () => ({ availability: 'ready' }),
          async prepare() { throw new Error('No model call is allowed.'); },
          async releaseSession() { return { stopped: true, closed: true, errors: [] }; },
          async close() { return { stopped: true, closed: true, errors: [] }; } };
      } }));
    try {
      const researchNames = new Set<string>([...RESEARCH_PLANNING_TOOL_NAMES, ...RESEARCH_INVESTIGATION_TOOL_NAMES]);
      expect(names.filter(name => !researchNames.has(name))).toHaveLength(bridgePresent ? 25 : 24);
      expect(new Set(names).size).toBe(names.length);
      expect(names.filter(name => name === 'Agent')).toHaveLength(1);
      expect(names.filter(name => name === 'list_skill_resources')).toHaveLength(1);
      expect(names.filter(name => name === 'read_skill_resource')).toHaveLength(1);
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

  it.each(['applied', 'applied-then-failed', 'applied-then-cancelled', 'not_applied', 'unknown', 'not-called', 'late-applied', 'invalid-receipt', 'workspace-changed', 'toolResult-save-failure'] as const)
    ('uses real SDK, Executor and SQLite for %s; query never applies again', async outcome => {
    const formApplied = outcome === 'applied' || outcome === 'applied-then-failed' || outcome === 'applied-then-cancelled';
    const root = mkdtempSync(join(tmpdir(), 'flowmate-form-chain-'));
    const paths = productPaths(join(root, 'product'));
    const sourceRoot = join(root, 'source'); const source = join(sourceRoot, '000001'); writeInvoice(source);
    const requests: Array<{ messages: Array<{ role: string; content?: unknown; tool_call_id?: string }>; tools?: Array<{ function: { name: string } }> }> = [];
    const bridgeCalls: InvoiceFormBridgeRequest[] = [];
    let documentId = 0; let candidateId = 0;
    let lateReceipt!: (receipt: InvoiceFormApplicationReceipt) => void;
    let lateAppliedAt = '';
    let app!: Application;
    let observeLaterRequest!: () => void;
    const laterRequest = new Promise<void>(resolve => { observeLaterRequest = resolve; });
    let releaseLaterResponse!: () => void;
    const laterResponse = new Promise<void>(resolve => { releaseLaterResponse = resolve; });
    const server = Bun.serve({ hostname: '127.0.0.1', port: 0, async fetch(request) {
      requests.push(await request.json());
      const ordinal = requests.length;
      if (ordinal === 5 && outcome === 'applied-then-failed') {
        return Response.json({ error: { type: 'invalid_request_error', message: 'Controlled later request failure.' } }, { status: 400 });
      }
      if (ordinal === 5 && outcome === 'applied-then-cancelled') {
        observeLaterRequest();
        await laterResponse;
      }
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
    const open = () => createApplication({ paths, invoiceSourceRoot: sourceRoot, logger: { write() {}, async close() {} },
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
        if (request.operation === 'query' || formApplied || outcome === 'toolResult-save-failure') return { ...base, outcome: 'applied',
          appliedRevision: request.target.expectedRevision + 1, appliedAt: base.observedAt };
        return outcome === 'not_applied' ? { ...base, outcome: 'not_applied', reason: 'fixture-target-unavailable' } : base;
      },
      agentFactory: (tools, resourceContents) => {
        const adapter = new PiAgentAdapter({ cwd: paths.runtimeDir, agentDir: paths.runtimeDir, tools, resourceContents,
          credentials: new InMemoryCredentialStore(), runtimeApiKey: 'synthetic-form-key' });
        if (outcome === 'toolResult-save-failure') {
          const watch = adapter.watchSession.bind(adapter);
          adapter.watchSession = (nativeId, commit, seed, save) => watch(nativeId, commit, seed, write => {
            const history = write.history;
            const entry = history.entries.at(-1);
            const message = entry?.type === 'message' ? entry.message as { role?: string; toolCallId?: string } : null;
            return write.contexts.length > 0 && message?.role === 'toolResult' && message.toolCallId === 'form-call-3'
              ? fail(appError('storage_write_failed', 'storage', 'Fixture rejects the actual Fill toolResult save.')) : save(write);
          });
        }
        return adapter;
      } });
    app = need(await open());
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
      const nextSequence = need(await app.querySessionInput({ sessionId: session.sessionId })).nextClientSequence!;
      const fillInput: FillInputRequest = { sessionId: session.sessionId, clientSequence: nextSequence, mode: 'prompt', goalMode: 'fill-form',
        text: 'Apply the selected candidate.', workspace: expectation(selected.workspace), config,
        formTarget: { formInstanceId: 'private-form-target', expectedRevision: 4 }, timeoutMs: outcome === 'late-applied' ? 3000 : 5000, stopGraceMs: 500 };
      const filled = await run(app, fillInput, true); fillRunId = filled.accepted.runId;
      expect(filled.finished.result).toMatchObject({ ok: true, data: { status: formApplied ? 'completed' : 'failed' } });
      const completedRun = need(await app.queryRun(fillRunId));
      expect(completedRun.output?.agent).toMatchObject({ candidateIds: [] });
      expect(need(await app.queryJob(task.job.jobId))).toMatchObject({ status: formApplied ? 'waiting' : 'failed',
        ...(formApplied ? { reason: 'review_form' } : {}), currentCandidateId: candidateId, acceptedCandidateId: null });
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
      // An unconfirmed external commit closes the Run before another model request.
      const resultMissing = outcome === 'unknown' || outcome === 'late-applied' || outcome === 'toolResult-save-failure';
      expect(requests).toHaveLength(resultMissing ? 3 : 4);
      expect(requests[2]!.tools?.map(tool => tool.function.name)).toEqual(['fill_invoice_form']);
      const result = requests[3]?.messages.find(message => message.role === 'tool' && message.tool_call_id === 'form-call-3');
      if (!resultMissing) expect(result).toBeDefined();
      if (formApplied) expect(JSON.parse(String(result?.content))).toEqual({ candidateId, candidateSequence: 1, applied: true });
      else expect(String(result?.content)).not.toContain('"applied":true');
      expect(JSON.stringify(requests)).not.toContain('private-form-target');
      expect(JSON.stringify(requests)).not.toContain('expectedRevision');
      expect(need(await app.querySessionInput({ sessionId: session.sessionId, clientSequence: nextSequence })).input)
        .toMatchObject({ inputId: filled.accepted.inputId, runId: fillRunId, status: 'consumed',
          processingStatus: formApplied ? 'completed' : 'failed', nativeEntryId: expect.any(String) });
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
      if (outcome === 'applied-then-failed' || outcome === 'applied-then-cancelled') {
        const originalInput = need(await app.querySessionInput({ sessionId: session.sessionId, clientSequence: nextSequence })).input;
        expect(originalInput).toMatchObject({ processingStatus: 'completed', resultEntryId: expect.any(String) });
        const savedFacts = () => {
          const db = new Database(paths.databaseFile, { readonly: true });
          try {
            return { call: db.query('SELECT * FROM tool_calls WHERE id=?').get(fillToolId),
              entries: db.query('SELECT entry_id,entry_json FROM session_native_entries WHERE run_id=? ORDER BY sequence').all(fillRunId) };
          } finally { db.close(); }
        };
        need(await app.close());
        const originalFacts = savedFacts();
        app = need(await open());
        const laterSession = need(await app.createSession({ title: 'Another conversation for the same Job',
          expectedRevision: need(await app.readWorkspace()).revision }));
        let finishLater!: (event: AgentRunEvent & { type: 'run_finished' }) => void;
        const laterFinished = new Promise<AgentRunEvent & { type: 'run_finished' }>(resolve => { finishLater = resolve; });
        const later = need(await app.startRun({ sessionId: laterSession.sessionId,
          goalMode: 'answer', text: 'A later independent request.',
          workspace: expectation(need(await app.readWorkspace())), config, timeoutMs: 5000, stopGraceMs: 500 },
        { onEvent(event) { if (event.type === 'run_finished') finishLater(event); } }));
        if (outcome === 'applied-then-cancelled') {
          await laterRequest;
          need(await app.cancelRun(later.runId));
          releaseLaterResponse();
        }
        const laterStatus = outcome === 'applied-then-failed' ? 'failed' : 'cancelled';
        expect((await laterFinished).result).toMatchObject({ ok: true, data: { status: laterStatus } });
        expect(need(await app.queryRun(later.runId))).toMatchObject({ jobId: task.job.jobId, cleanup: { stopped: true } });
        expect(need(await app.queryJob(task.job.jobId)).status).toBe(laterStatus);
        expect(need(await app.querySession(session.sessionId)).availability).toBe('ready');
        expect(need(await app.querySession(laterSession.sessionId)).availability).toBe('unusable');
        need(await app.close());
        expect(savedFacts()).toEqual(originalFacts);
        app = need(await open());
        expect(need(await app.querySession(session.sessionId))).toMatchObject({ availability: 'ready', historyState: 'recoverable' });
        expect(need(await app.querySession(laterSession.sessionId)).availability).toBe('unusable');
        expect(need(await app.querySessionInput({ sessionId: session.sessionId, clientSequence: nextSequence })).input).toEqual(originalInput);
        expect(need(await app.queryRun(fillRunId))).toEqual(before);
        expect(need(await app.queryInvoiceFormApplication({ runId: fillRunId, toolCallId: fillToolId }))).toEqual(receipt);
        expect(await app.submitInput(fillInput)).toEqual({ ok: true, data: filled.accepted });
        expect(requests).toHaveLength(5);
        expect(bridgeCalls.filter(call => call.operation === 'apply')).toHaveLength(1);
        need(await app.updateWorkspace({ expectedRevision: need(await app.readWorkspace()).revision,
          change: { kind: 'session', sessionId: session.sessionId } }));
        const continued = await run(app, { sessionId: session.sessionId, goalMode: 'answer', text: 'Continue after reopening.',
          workspace: expectation(need(await app.readWorkspace())), config, timeoutMs: 5000, stopGraceMs: 500 });
        expect(continued.finished.result).toMatchObject({ ok: true, data: { status: 'completed' } });
        expect(requests).toHaveLength(6);
        need(await app.close());
        expect(savedFacts()).toEqual(originalFacts);
        expect(bridgeCalls.filter(call => call.operation === 'apply')).toHaveLength(1);
        return;
      }
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
          expect(exported.bytes).toBe(bytes.byteLength);
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
      if (['unknown', 'late-applied', 'toolResult-save-failure'].includes(outcome)) expect(JSON.parse(call.delivery_json).state).not.toBe('request_observed');
      else expect(JSON.parse(call.delivery_json).state).toBe('request_observed');
      expect(db.query('SELECT status FROM invoice_candidates WHERE id=?').get(candidateId)).toEqual({ status: 'generated' });
      expect(db.query('SELECT COUNT(*) AS count FROM runs').get()).toEqual({ count: 2 });
      expect(db.query('SELECT COUNT(*) AS count FROM tool_calls').get()).toEqual({ count: 2 });
      expect(db.query('SELECT COUNT(*) AS count FROM invoice_candidates').get()).toEqual({ count: outcome === 'applied' ? 2 : 1 });
    } finally { db.close(); }
  }, 15_000);
});
