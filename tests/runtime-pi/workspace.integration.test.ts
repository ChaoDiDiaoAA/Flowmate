import { describe, expect, it } from 'bun:test';
import { Database } from 'bun:sqlite';
import { InMemoryCredentialStore } from '@earendil-works/pi-ai';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { CandidateDraftSchema, invoiceHeaderFields, invoiceLineFields } from '@flowmate/contracts';
import type { AgentRunEvent, Application, InvoiceFormBridgeRequest, ProviderConfig, Result, SessionInputRequest,
  WorkspaceSnapshot } from '@flowmate/contracts';
import { createApplication } from '../../apps/composition.ts';
import { PiAgentAdapter } from '../../packages/runtime-pi/src/session.ts';
import { deferCleanup, mkdtempSync } from '../support/resources.ts';

function need<T>(result: Result<T>): T { if (!result.ok) throw new Error(`${result.error.code}: ${result.error.message}`); return result.data; }
function barrier() { let release!: () => void; const ready = new Promise<void>(resolve => { release = resolve; }); return { ready, release }; }
const missing = { raw: null, normalized: null, state: 'missing', alternatives: [], sources: [] };
const candidate = CandidateDraftSchema.parse({ fields: Object.fromEntries(invoiceHeaderFields.map(name => [name, missing])),
  lines: [Object.fromEntries(invoiceLineFields.map(name => [name, missing]))], notes: [] });
type Payload = { messages: Array<{ role: string; content?: unknown; tool_call_id?: string }> };
function reply(tool?: { name: string; args: unknown; id: string }) {
  const delta = tool ? { role: 'assistant', tool_calls: [{ index: 0, id: tool.id, type: 'function',
    function: { name: tool.name, arguments: JSON.stringify(tool.args) } }] } : { role: 'assistant', content: 'Controlled answer.' };
  const chunk = (value: unknown, finish: string | null) => 'data: ' + JSON.stringify({ id: 'p7-fixture',
    choices: [{ index: 0, delta: value, finish_reason: finish }] }) + '\n\n';
  return new Response(chunk(delta, null) + chunk({}, tool ? 'tool_calls' : 'stop') + 'data: [DONE]\n\n',
    { headers: { 'content-type': 'text/event-stream' } });
}
function writeSource(directory: string, sampleId = '000001') {
  mkdirSync(directory, { recursive: true });
  const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/a54AAAAASUVORK5CYII=', 'base64');
  const content = JSON.stringify([1, 2].map(block => ({ type: 'text', text: `Synthetic invoice${sampleId === '000001' ? '' : ` ${sampleId}`} block ${block}`,
    bbox: [0, 0, 1, 1], page_idx: 0 })));
  const pages = JSON.stringify([{ pageNumber: 1, text: 'Synthetic invoice blocks', blockCount: 2 }]);
  writeFileSync(join(directory, 'original.png'), png);
  writeFileSync(join(directory, 'content.json'), content);
  writeFileSync(join(directory, 'pages.json'), pages);
  writeFileSync(join(directory, 'metadata.json'), JSON.stringify({ schemaVersion: 1, sampleId,
    datasetId: 'voxel51-hq-invoice-ocr', sourceRecordId: sampleId === '000001' ? 'p7-synthetic' : `p7-synthetic-${sampleId}`, datasetRevision: 'p7-fixture', qualityStatus: 'complete',
    allowedUsesClaim: ['local test'], licenseVerification: 'not_verified', files: [{ path: 'original.png', bytes: png.length },
      { path: 'content.json', bytes: Buffer.byteLength(content) }, { path: 'pages.json', bytes: Buffer.byteLength(pages) }] }));
}
function expected(workspace: WorkspaceSnapshot) {
  if (workspace.sessionId === null) throw new Error('A selected Session is required.');
  return { revision: workspace.revision, sessionId: workspace.sessionId, documentRef: workspace.documentRef,
    jobId: workspace.jobId, candidateRef: workspace.candidateRef };
}
async function begin(app: Application, input: SessionInputRequest) {
  let finish!: (event: AgentRunEvent & { type: 'run_finished' }) => void;
  const terminal = new Promise<AgentRunEvent & { type: 'run_finished' }>(resolve => { finish = resolve; });
  const accepted = need(await app.submitInput(input, { onEvent(event) { if (event.type === 'run_finished') finish(event); } }));
  return { accepted, terminal };
}
async function fixture(onRequest: (ordinal: number, app: Application) => Promise<Response> | Response,
  bridgeCalls: InvoiceFormBridgeRequest[] = []) {
  const root = mkdtempSync(join(tmpdir(), 'flowmate-p7-sdk-'));
  const product = join(root, 'product');
  const paths = { root: product, databaseFile: join(product, 'data', 'app.sqlite'), logsDir: join(product, 'logs'),
    artifactsDir: join(product, 'artifacts'), outputsDir: join(product, 'outputs'), runtimeDir: join(product, 'runtime') };
  const sourceRoot = join(root, 'source'); const source = join(sourceRoot, '000001'); writeSource(source);
  let app!: Application;
  let documentId = 0;
  const payloads: Payload[] = [];
  const server = Bun.serve({ hostname: '127.0.0.1', port: 0, async fetch(request) {
    payloads.push(await request.json());
    return payloads.length === 1 ? reply({ name: 'save_invoice_candidate', args: { documentId, candidate }, id: 'p7-save' })
      : payloads.length === 2 ? reply() : onRequest(payloads.length, app);
  } });
  deferCleanup(() => server.stop(true));
  const config: ProviderConfig = { version: 1, name: 'P7 controlled SDK', revision: 1,
    modelRef: { provider: 'p7-sdk-fixture', model: 'p7-model' }, native: { authPath: join(root, 'unused.json'), modelsPath: null },
    connection: { baseUrl: `http://127.0.0.1:${server.port}/v1`, api: 'openai-completions', contextWindow: 64_000, maxTokens: 16_384 },
    parameters: { maxRetries: 0, maxRetryDelayMs: 100 } };
  app = need(await createApplication({ paths, invoiceSourceRoot: sourceRoot, logger: { write() {}, async close() {} },
    invoiceFormBridge: async request => {
      bridgeCalls.push(structuredClone(request));
      return { runId: request.runId, toolCallId: request.toolCallId, candidateId: request.candidateId,
        candidateSequence: request.candidateSequence, formInstanceId: request.target.formInstanceId,
        observedAt: new Date().toISOString(), outcome: 'applied', appliedRevision: request.target.expectedRevision + 1,
        appliedAt: new Date().toISOString() };
    }, agentFactory: tools => new PiAgentAdapter({ cwd: paths.runtimeDir, agentDir: paths.runtimeDir, tools,
      credentials: new InMemoryCredentialStore(), runtimeApiKey: 'synthetic-p7-key' }) }));
  deferCleanup(() => app.close());
  const document = need(await app.importInvoiceMaterial(source)); documentId = document.documentRef.id;
  const session = need(await app.createSession({ title: 'P7 positioning', expectedRevision: need(await app.readWorkspace()).revision }));
  const selectedDocument = need(await app.updateWorkspace({ expectedRevision: need(await app.readWorkspace()).revision,
    change: { kind: 'document', documentId } }));
  const task = need(await app.startTask({ clientSequence: 1, expectedRevision: selectedDocument.revision,
    documentRef: document.documentRef, goal: 'Review selected invoice' }));
  const saved = await begin(app, { sessionId: session.sessionId, clientSequence: 1, mode: 'prompt', text: 'Save candidate.',
    goalMode: 'save-candidate', workspace: expected(task.workspace), config, timeoutMs: 5000, stopGraceMs: 500 });
  expect((await saved.terminal).result).toMatchObject({ ok: true, data: { status: 'completed' } });
  const candidateId = need(await app.listJobCandidates({ jobId: task.job.jobId })).items[0]!.candidateId;
  const selected = need(await app.selectCandidate({ jobId: task.job.jobId, candidateId, expectedCandidateId: null,
    expectedRevision: need(await app.readWorkspace()).revision }));
  const tax = { formatVersion: 1 as const, kind: 'field' as const, target: 'candidate' as const,
    targetId: candidateId, targetVersion: 1, fieldPath: 'fields.taxAmount' };
  const workspace = need(await app.updateWorkspace({ expectedRevision: selected.workspace.revision, change: { kind: 'selection', selection: tax } }));
  return { app, paths, payloads, config, session, document, candidateId, workspace, tax, bridgeCalls };
}

describe('P7 frozen positioning through real Pi and loopback HTTP', () => {
  it('blocks a queued frozen source before native user and HTTP when its original parsed material is corrupt', async () => {
    const entered = barrier(), release = barrier();
    deferCleanup(() => release.release());
    const f = await fixture(async ordinal => { if (ordinal === 3) { entered.release(); await release.ready; } return reply(); });
    const initial = await begin(f.app, { sessionId: f.session.sessionId, clientSequence: 2, mode: 'prompt', text: 'Check original invoice.',
      workspace: expected(f.workspace), config: f.config, timeoutMs: 5000, stopGraceMs: 500 });
    await entered.ready;
    const source = { formatVersion: 1 as const, kind: 'source' as const, target: 'document' as const,
      targetId: f.document.documentRef.id, targetVersion: f.document.documentRef.version, artifactId: f.document.parsedArtifactId, page: 1, block: 'b2' };
    const atSource = need(await f.app.updateWorkspace({ expectedRevision: f.workspace.revision, change: { kind: 'selection', selection: source } }));
    const request = { sessionId: f.session.sessionId, clientSequence: 3, mode: 'steer' as const, runId: initial.accepted.runId,
      text: 'Check the saved original source.', workspace: expected(atSource) };
    const queued = need(await f.app.submitInput(request));
    const before = need(await f.app.querySessionInput({ sessionId: f.session.sessionId, inputId: queued.inputId })).input!;
    expect(before).toMatchObject({ status: 'queued', processingStatus: 'pending', nativeEntryId: null, resultEntryId: null,
      content: { workspaceContext: { documentRef: f.document.documentRef, selection: source },
        allowedDocumentIds: [f.document.documentRef.id], allowedArtifactIds: [f.document.parsedArtifactId] } });
    const otherSource = join(f.paths.root, '..', 'source', '000002'); writeSource(otherSource, '000002');
    const otherDocument = need(await f.app.importInvoiceMaterial(otherSource));
    expect(otherDocument.documentRef.id).not.toBe(f.document.documentRef.id);
    expect(otherDocument.documentRef.version).not.toBe(f.document.documentRef.version);
    const switched = need(await f.app.updateWorkspace({ expectedRevision: atSource.revision,
      change: { kind: 'document', documentId: otherDocument.documentRef.id } }));
    const storedPath = join(f.paths.artifactsDir, String(f.document.parsedArtifactId), 'parsed.json');
    const originalBytes = readFileSync(storedPath);
    const damagedBytes = Buffer.from(originalBytes.toString('utf8').replace('Synthetic', 'Corrupted'));
    expect(damagedBytes.equals(originalBytes)).toBe(false);
    expect(damagedBytes.byteLength).toBe(originalBytes.byteLength);
    writeFileSync(storedPath, damagedBytes);
    expect(need(await f.app.listDocumentPages({ documentId: otherDocument.documentRef.id })).documentRef).toEqual(otherDocument.documentRef);
    expect(need(await f.app.readWorkspace())).toMatchObject({ documentRef: otherDocument.documentRef,
      revision: switched.revision, selection: null, invalidReferences: [] });
    expect(f.payloads).toHaveLength(3);
    release.release();
    expect((await initial.terminal).result).toMatchObject({ ok: true, data: { status: 'failed' } });
    const after = need(await f.app.querySessionInput({ sessionId: f.session.sessionId, inputId: queued.inputId })).input!;
    expect(after).toMatchObject({ status: 'failed', processingStatus: 'failed', nativeEntryId: null, resultEntryId: null,
      error: { code: 'input_unavailable' } });
    expect(after.content).toEqual(before.content);
    expect(f.payloads).toHaveLength(3);
    expect(need(await f.app.queryRun(initial.accepted.runId))).toMatchObject({ config: { workspaceContext: { selection: f.tax } },
      scope: { allowedDocumentIds: [f.document.documentRef.id], allowedArtifactIds: [f.document.parsedArtifactId] } });
    expect(await f.app.submitInput(request)).toEqual({ ok: true, data: queued });
    expect(f.payloads).toHaveLength(3);
    expect(need(await f.app.listSessionInputs({ sessionId: f.session.sessionId, runId: initial.accepted.runId })).items).toHaveLength(2);
    need(await f.app.close());
    const db = new Database(f.paths.databaseFile, { readonly: true });
    try {
      const rows = db.query<{ entry_json: string }, [number]>('SELECT entry_json FROM session_native_entries WHERE run_id=?').all(initial.accepted.runId);
      const users = rows.map(row => JSON.parse(row.entry_json).message).filter(message => message?.role === 'user');
      expect(users).toHaveLength(1);
      const saved = db.query<{ content_json: string; native_entry_id: string | null }, [number]>('SELECT content_json,native_entry_id FROM session_inputs WHERE id=?').get(queued.inputId)!;
      expect(JSON.parse(saved.content_json)).toEqual(before.content);
      expect(saved.native_entry_id).toBeNull();
    } finally { db.close(); }
  });

  it('freezes initial, steer and follow-up selections before native consumption without expanding Scope', async () => {
    const entered = barrier(), release = barrier();
    deferCleanup(() => release.release());
    const f = await fixture(async ordinal => { if (ordinal === 3) { entered.release(); await release.ready; } return reply(); });
    const prompt = { sessionId: f.session.sessionId, clientSequence: 2, mode: 'prompt' as const, text: 'Check selected tax.',
      workspace: expected(f.workspace), config: f.config, timeoutMs: 5000, stopGraceMs: 500 };
    const initial = await begin(f.app, prompt);
    await entered.ready;
    const frozen = need(await f.app.querySessionInput({ sessionId: f.session.sessionId, inputId: initial.accepted.inputId })).input!;
    expect(frozen.content).toMatchObject({ workspaceContext: { selection: f.tax }, promptText: expect.stringContaining('fields.taxAmount') });
    expect(need(await f.app.queryRun(initial.accepted.runId))).toMatchObject({ config: { workspaceContext: { selection: f.tax } },
      scope: { allowedDocumentIds: [f.document.documentRef.id], allowedArtifactIds: [f.document.parsedArtifactId] } });
    const line = { formatVersion: 1 as const, kind: 'line' as const, target: 'candidate' as const,
      targetId: f.candidateId, targetVersion: 1, lineIndex: 0 };
    const atLine = need(await f.app.updateWorkspace({ expectedRevision: f.workspace.revision, change: { kind: 'selection', selection: line } }));
    const steer = need(await f.app.submitInput({ sessionId: f.session.sessionId, clientSequence: 3, mode: 'steer', runId: initial.accepted.runId,
      text: 'Check selected line.', workspace: expected(atLine) }));
    const source = { formatVersion: 1 as const, kind: 'source' as const, target: 'document' as const,
      targetId: f.document.documentRef.id, targetVersion: f.document.documentRef.version, artifactId: f.document.parsedArtifactId, page: 1, block: 'b2' };
    const atSource = need(await f.app.updateWorkspace({ expectedRevision: atLine.revision, change: { kind: 'selection', selection: source } }));
    const follow = need(await f.app.submitInput({ sessionId: f.session.sessionId, clientSequence: 4, mode: 'followUp', runId: initial.accepted.runId,
      text: 'Check selected source.', workspace: expected(atSource) }));
    const changed = need(await f.app.updateWorkspace({ expectedRevision: atSource.revision, change: { kind: 'document', documentId: null } }));
    expect(await f.app.submitInput({ sessionId: f.session.sessionId, clientSequence: 5, mode: 'steer', runId: initial.accepted.runId,
      text: 'Different object.', workspace: expected(changed) })).toMatchObject({ ok: false, error: { code: 'state_conflict' } });
    expect(await f.app.submitInput(prompt)).toEqual({ ok: true, data: initial.accepted });
    expect(f.payloads).toHaveLength(3);
    release.release();
    expect((await initial.terminal).result).toMatchObject({ ok: true, data: { status: 'completed' } });
    expect(f.payloads).toHaveLength(5);
    const inputs = need(await f.app.listSessionInputs({ sessionId: f.session.sessionId })).items;
    for (const [inputId, selection, ordinal] of [[initial.accepted.inputId, f.tax, 2], [steer.inputId, line, 3], [follow.inputId, source, 4]] as const) {
      const input = inputs.find(item => item.inputId === inputId)!;
      expect(input).toMatchObject({ status: 'consumed', processingStatus: 'completed', nativeEntryId: expect.any(String),
        content: { workspaceContext: { selection }, allowedArtifactIds: [f.document.parsedArtifactId] } });
      if (input.content.version !== 2) throw new Error('Frozen V2 input is required.');
      expect(f.payloads[ordinal]!.messages.filter(message => message.role === 'user').at(-1)?.content)
        .toEqual([{ type: 'text', text: input.content.promptText }]);
    }
    expect(inputs.find(item => item.inputId === initial.accepted.inputId)?.content).toEqual(frozen.content);
    expect(need(await f.app.queryRun(initial.accepted.runId))).toMatchObject({ config: { workspaceContext: { selection: f.tax } },
      scope: { allowedArtifactIds: [f.document.parsedArtifactId] } });
    need(await f.app.close());
    const db = new Database(f.paths.databaseFile, { readonly: true });
    try {
      const entries = db.query<{ entry_json: string }, [number]>('SELECT entry_json FROM session_native_entries WHERE run_id=?').all(initial.accepted.runId);
      const users = entries.map(row => JSON.parse(row.entry_json).message).filter(message => message?.role === 'user');
      expect(users).toHaveLength(3);
      expect(users.map(message => message.content[0].text)).toEqual([initial.accepted.inputId, steer.inputId, follow.inputId]
        .map(id => inputs.find(item => item.inputId === id)!.content).map(content => content.version === 2 ? content.promptText : ''));
    } finally { db.close(); }
  });

  it.each(['view', 'selection'] as const)('retains the original Fill target when only %s changes and refuses application', async changeKind => {
    const calls: InvoiceFormBridgeRequest[] = [];
    let candidateId = 0;
    const f = await fixture(async (ordinal, app) => {
      if (ordinal === 3) {
        const current = need(await app.readWorkspace());
        need(await app.updateWorkspace({ expectedRevision: current.revision, change: changeKind === 'view' ? { kind: 'view', view: 'parsed' }
          : { kind: 'selection', selection: { formatVersion: 1, kind: 'field', target: 'candidate', targetId: candidateId,
            targetVersion: 1, fieldPath: 'fields.totalAmount' } } }));
        return reply({ name: 'fill_invoice_form', args: { candidateId }, id: 'p7-fill' });
      }
      return reply();
    }, calls);
    candidateId = f.candidateId;
    const request = { sessionId: f.session.sessionId, clientSequence: 2, mode: 'prompt' as const, goalMode: 'fill-form' as const,
      text: 'Apply this candidate.', workspace: expected(f.workspace), config: f.config,
      formTarget: { formInstanceId: 'p7-private-form', expectedRevision: 7 }, timeoutMs: 5000, stopGraceMs: 500 };
    const fill = await begin(f.app, request);
    expect((await fill.terminal).result).toMatchObject({ ok: true, data: { status: 'failed' } });
    expect(calls).toHaveLength(0);
    expect(f.payloads).toHaveLength(4);
    const savedRun = need(await f.app.queryRun(fill.accepted.runId));
    expect(savedRun).toMatchObject({ config: { workspaceContext: { revision: f.workspace.revision, selection: f.tax },
      formTarget: request.formTarget }, scope: { allowedTools: ['fill_invoice_form'] } });
    expect(need(await f.app.querySessionInput({ sessionId: f.session.sessionId, inputId: fill.accepted.inputId })).input)
      .toMatchObject({ content: { workspaceContext: { revision: f.workspace.revision, selection: f.tax } } });
    expect(await f.app.submitInput(request)).toEqual({ ok: true, data: fill.accepted });
    expect(calls).toHaveLength(0); expect(f.payloads).toHaveLength(4);
    expect(need(await f.app.readWorkspace()).revision).toBe(f.workspace.revision + 1);
  });
});
