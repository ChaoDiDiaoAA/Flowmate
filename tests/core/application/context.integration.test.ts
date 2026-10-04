import { saveTestHistory } from '../../support/history.ts';
import { describe, expect, it } from 'bun:test';
import { createContextRepository, createFileStore, openDatabase } from '@flowmate/core';
import { createDocumentService, DocumentService } from '@flowmate/data';
import { appError, CandidateDraftSchema, ContextSnapshotJsonSchema, formatExecutionPrompt, InvoiceFormDraftSchema, invoiceHeaderFields, invoiceFieldDisplayValue } from '@flowmate/contracts';
import { validateHumanInvoiceCandidate } from '@flowmate/employee-invoice';
import type { ContextBuildRequest, Result, WorkspaceSelection } from '@flowmate/contracts';
import { makeSelectedCandidate } from '../../support/selected-candidate.ts';
import { ContextService, formatContextPrompt } from '../../../packages/core/src/context/service.ts';
import { Database } from 'bun:sqlite';
import { InMemoryCredentialStore } from '@earendil-works/pi-ai';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { mkdirSync, writeFileSync } from 'node:fs';
import { createApplication } from '../../../apps/composition.ts';
import { PiAgentAdapter } from '../../../packages/runtime-pi/src/session.ts';
import { deferCleanup, mkdtempSync } from '../../support/resources.ts';
import type { AgentRunEvent } from '@flowmate/contracts';
import type { RuntimeEventStore } from '../../../packages/core/src/events/store.ts';

function writeContextMaterial(directory: string, sampleId: string, text: string) {
  mkdirSync(directory, { recursive: true });
  const original = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/a54AAAAASUVORK5CYII=', 'base64');
  const content = JSON.stringify([{ type: 'text', text, bbox: [0, 0, 1, 1], page_idx: 0 }]);
  const pages = JSON.stringify([{ pageNumber: 1, text, blockCount: 1 }]);
  writeFileSync(join(directory, 'original.png'), original); writeFileSync(join(directory, 'content.json'), content);
  writeFileSync(join(directory, 'pages.json'), pages);
  writeFileSync(join(directory, 'metadata.json'), JSON.stringify({ schemaVersion: 1, sampleId,
    datasetId: 'voxel51-hq-invoice-ocr', sourceRecordId: `t10-material-${sampleId}`, datasetRevision: 't10-fixture', qualityStatus: 'complete',
    allowedUsesClaim: ['local test'], licenseVerification: 'not_verified', files: [{ path: 'original.png', bytes: original.length },
      { path: 'content.json', bytes: Buffer.byteLength(content) }, { path: 'pages.json', bytes: Buffer.byteLength(pages) }] }));
}
function contextReply(tool?: { documentId: number; candidate: unknown }) {
  const delta = tool ? { role: 'assistant', tool_calls: [{ index: 0, id: 't10-material-candidate', type: 'function',
    function: { name: 'save_invoice_candidate', arguments: JSON.stringify(tool) } }] } : { role: 'assistant', content: 'Controlled material answer' };
  const chunk = (value: unknown, reason: string | null) => 'data: ' + JSON.stringify({ choices: [{ index: 0, delta: value, finish_reason: reason }] }) + '\n\n';
  return new Response(chunk(delta, null) + chunk({}, tool ? 'tool_calls' : 'stop') + 'data: [DONE]\n\n', { headers: { 'content-type': 'text/event-stream' } });
}
async function materialApplicationFixture(text = 'FIRST税 total 113.00 LAST税', oldVersion = false) {
  const root = mkdtempSync(join(tmpdir(), 'flowmate-t10-material-'));
  const paths = { root: join(root, 'product'), databaseFile: join(root, 'product/data/app.sqlite'), artifactsDir: join(root, 'product/artifacts'),
    logsDir: join(root, 'product/logs'), outputsDir: join(root, 'product/outputs'), runtimeDir: join(root, 'product/runtime') };
  const sourceRoot = join(root, 'source'), source = join(sourceRoot, '000001'), foreignSource = join(sourceRoot, '000002');
  writeContextMaterial(source, '000001', oldVersion ? 'An actual earlier source version' : text);
  writeContextMaterial(foreignSource, '000002', 'T10 FOREIGN MATERIAL MUST NOT BE SELECTED');
  let http = 0, documentId = 0; let draft: unknown;
  const server = Bun.serve({ hostname: '127.0.0.1', port: 0, async fetch(request) {
    await request.json(); http++; return http === 1 ? contextReply({ documentId, candidate: draft }) : contextReply();
  } });
  deferCleanup(() => server.stop(true));
  const config: import('@flowmate/contracts').ProviderConfig = { version: 1, name: 'T10 materials', revision: 1,
    modelRef: { provider: 't10-material', model: 'fixture' }, native: { authPath: join(root, 'unused.json'), modelsPath: null },
    connection: { baseUrl: `http://127.0.0.1:${server.port}/v1`, api: 'openai-completions', contextWindow: 64000, maxTokens: 16384 },
    parameters: { maxRetries: 0, maxRetryDelayMs: 100 } };
  const open = async () => {
    const app = need(await createApplication({ paths, invoiceSourceRoot: sourceRoot, logger: { write() {}, async close() {} },
      agentFactory: tools => new PiAgentAdapter({ cwd: paths.runtimeDir, agentDir: paths.runtimeDir, tools,
        credentials: new InMemoryCredentialStore(), runtimeApiKey: 'synthetic-t10-material-key' }) }));
    deferCleanup(() => app.close()); return app;
  };
  const app = await open();
  const firstVersion = need(await app.importInvoiceMaterial(source));
  if (oldVersion) writeContextMaterial(source, '000001', text);
  const document = oldVersion ? need(await app.importInvoiceMaterial(source)) : firstVersion;
  const foreign = need(await app.importInvoiceMaterial(foreignSource)); documentId = document.documentRef.id;
  const page = need(await app.readDocumentPage({ documentId, page: 1, afterBlockId: null, limit: 50 }));
  const sourceRef = { documentId, version: document.documentRef.version, artifactId: document.parsedArtifactId,
    page: 1, blockId: page.blocks[0]!.id, quote: 'FIRST税' };
  const missing = { raw: null, normalized: null, state: 'missing', alternatives: [], sources: [] };
  draft = CandidateDraftSchema.parse({ fields: { ...Object.fromEntries(invoiceHeaderFields.map(name => [name, missing])),
    totalAmount: { raw: '113.00', normalized: '113.00', state: 'present', alternatives: [],
      sources: [sourceRef, { ...sourceRef, quote: 'LAST税' }, sourceRef] } }, lines: [], notes: [] });
  const session = need(await app.createSession({ title: 'T10 materials', expectedRevision: need(await app.readWorkspace()).revision }));
  const selected = need(await app.updateWorkspace({ expectedRevision: need(await app.readWorkspace()).revision, change: { kind: 'document', documentId } }));
  const task = need(await app.startTask({ clientSequence: 1, expectedRevision: selected.revision, documentRef: document.documentRef, goal: 'Inspect actual material' }));
  const runInput = async (app: import('@flowmate/contracts').Application, clientSequence: number, goalMode: 'answer' | 'save-candidate') => {
    const workspace = need(await app.readWorkspace()); let finish!: (event: Extract<AgentRunEvent, { type: 'run_finished' }>) => void;
    const terminal = new Promise<Extract<AgentRunEvent, { type: 'run_finished' }>>(resolve => { finish = resolve; });
    const result = await app.submitInput({ sessionId: session.sessionId, clientSequence, mode: 'prompt', goalMode, text: 'Explain the selected amount',
      workspace: { revision: workspace.revision, documentRef: workspace.documentRef, jobId: workspace.jobId,
        candidateRef: workspace.candidateRef, sessionId: session.sessionId }, config, timeoutMs: 5000, stopGraceMs: 500 },
    { onEvent(event) { if (event.type === 'run_finished') finish(event); } });
    return { result, terminal };
  };
  const generated = await runInput(app, 1, 'save-candidate'); need(generated.result);
  expect((await generated.terminal).result).toMatchObject({ ok: true, data: { status: 'completed' } });
  const saved = need(await app.listJobCandidates({ jobId: task.job.jobId })).items[0]!;
  expect(saved.context).toMatchObject({ snapshotId: expect.any(Number), requestSequence: 1 });
  need(await app.selectCandidate({ jobId: task.job.jobId, candidateId: saved.candidateId, expectedCandidateId: null,
    expectedRevision: need(await app.readWorkspace()).revision }));
  need(await app.updateWorkspace({ expectedRevision: need(await app.readWorkspace()).revision, change: { kind: 'selection', selection: {
    formatVersion: 1, kind: 'field', target: 'candidate', targetId: saved.candidateId, targetVersion: saved.sequence, fieldPath: 'fields.totalAmount' } } }));
  expect(http).toBe(2); expect(need(await app.close()).closed).toBe(true);
  return { paths, open, runInput, document, foreign, firstVersion, candidate: saved, sourceRef, http: () => http };
}
function materialRows(db: Database) {
  return Object.fromEntries(['documents', 'artifacts', 'runs', 'session_inputs', 'context_snapshots', 'tool_calls', 'invoice_candidates',
    'business_events', 'runtime_events', 'workspace'].map(table => [table, db.query(`SELECT * FROM ${table} ORDER BY id`).all()]));
}

describe('T10 real managed material evidence', () => {
  it('T10 F8-02 selects real Unicode quote windows and audits only the frozen document inspection tuple', async () => {
    const text = '😀'.repeat(400) + 'FIRST税' + '"\\\n\u0000' + '😀'.repeat(1500) + 'LAST税' + '😀'.repeat(400) + 'FIRST税';
    const f = await materialApplicationFixture(text);
    expect(f.foreign.documentRef.id).not.toBe(f.document.documentRef.id);
    expect(f.foreign.documentRef.version).not.toBe(f.document.documentRef.version);
    expect(f.foreign.parsedArtifactId).not.toBe(f.document.parsedArtifactId);
    const baseline = new Database(f.paths.databaseFile, { readonly: true });
    const before = materialRows(baseline); baseline.close();
    const app = await f.open();
    const attempted: Array<{ id: number; version: string }> = [];
    const inspections: Array<{ documentId: number; version: string; parsedArtifactId: number }> = [];
    const inspect = DocumentService.prototype.inspectParsedForContext;
    DocumentService.prototype.inspectParsedForContext = function (this: DocumentService, input) {
      attempted.push(structuredClone(input.documentRef));
      const result = inspect.call(this, input);
      if (result.ok) inspections.push({ documentId: input.documentRef.id, version: input.documentRef.version,
        parsedArtifactId: result.data.document.parsedArtifactId });
      return result;
    };
    try {
      const run = await f.runInput(app, 2, 'answer'); const accepted = need(run.result);
      expect((await run.terminal).result).toMatchObject({ ok: true, data: { status: 'completed' } });
      expect(attempted).toEqual([f.document.documentRef]);
      expect(inspections).toEqual([{ documentId: f.document.documentRef.id, version: f.document.documentRef.version,
        parsedArtifactId: f.document.parsedArtifactId }]);
      const input = need(await app.querySessionInput({ sessionId: accepted.sessionId, inputId: accepted.inputId })).input!;
      const detail = need(await app.queryContextSnapshot({ sessionId: accepted.sessionId, runId: accepted.runId, snapshotId: input.contextSnapshotId! }));
      const projection = detail.snapshot.json.modelProjection, fragment = projection.fragments[0]!;
      expect(fragment).toMatchObject({ documentRef: f.document.documentRef, artifactId: f.document.parsedArtifactId, page: 1,
        blockId: f.sourceRef.blockId, reasons: ['candidate-source'], originalBytes: Buffer.byteLength(text), truncated: true });
      expect(fragment.sources).toEqual([f.sourceRef, { ...f.sourceRef, quote: 'LAST税' }]);
      expect(fragment.windows.some(window => window.start <= text.indexOf('FIRST税') && window.end >= text.indexOf('FIRST税') + 'FIRST税'.length)).toBe(true);
      for (const quote of ['FIRST税', 'LAST税']) expect(fragment.windows.some(window => window.text.includes(quote))).toBe(true);
      for (const [index, window] of fragment.windows.entries()) {
        expect(window.text).toBe(text.slice(window.start, window.end));
        expect(/^[\uDC00-\uDFFF]/.test(window.text)).toBe(false); expect(/[\uD800-\uDBFF]$/.test(window.text)).toBe(false);
        if (index) expect(window.start).toBeGreaterThanOrEqual(fragment.windows[index - 1]!.end);
      }
      expect(fragment.includedBytes).toBe(fragment.windows.reduce((sum, window) => sum + Buffer.byteLength(window.text), 0));
      expect(fragment.includedBytes).toBeLessThanOrEqual(4096);
      expect(Buffer.byteLength(JSON.stringify(projection))).toBeLessThanOrEqual(65536);
      expect(JSON.stringify(detail.snapshot)).not.toContain('T10 FOREIGN');
      expect(need(await app.close()).closed).toBe(true);
      const db = new Database(f.paths.databaseFile, { readonly: true });
      try {
        const snapshot = db.query<{ snapshot_json: string }, [number]>('SELECT snapshot_json FROM context_snapshots WHERE id=?').get(input.contextSnapshotId!)!;
        expect(Buffer.byteLength(snapshot.snapshot_json)).toBeLessThanOrEqual(262144);
        const saved = ContextSnapshotJsonSchema.parse(JSON.parse(snapshot.snapshot_json));
        expect(saved.modelProjection).toEqual(projection); expect(snapshot.snapshot_json).not.toContain('T10 FOREIGN');
        const after = materialRows(db); expect(after.documents).toEqual(before.documents); expect(after.artifacts).toEqual(before.artifacts);
        expect(after.invoice_candidates).toEqual(before.invoice_candidates); expect(after.workspace).toEqual(before.workspace);
        expect(after.business_events).toEqual(before.business_events); expect(db.query('PRAGMA foreign_key_check').all()).toEqual([]);
      } finally { db.close(); }
    } finally { DocumentService.prototype.inspectParsedForContext = inspect; }
    expect(f.http()).toBe(3);
  });

  it.each(['cross-document', 'old-version', 'wrong-artifact', 'forged-quote'] as const)
    ('T10 F8-03 refuses historical source corruption through actual Application: %s', async cause => {
      const f = await materialApplicationFixture(undefined, cause === 'old-version');
      const db = new Database(f.paths.databaseFile);
      let before: ReturnType<typeof materialRows>;
      try {
        const row = db.query<{ fields_json: string }, [number]>('SELECT fields_json FROM invoice_candidates WHERE id=?').get(f.candidate.candidateId)!;
        const fields = JSON.parse(row.fields_json);
        const altered = cause === 'cross-document' ? { ...f.sourceRef, documentId: f.foreign.documentRef.id,
          version: f.foreign.documentRef.version, artifactId: f.foreign.parsedArtifactId }
          : cause === 'old-version' ? { ...f.sourceRef, version: f.firstVersion.documentRef.version }
          : cause === 'wrong-artifact' ? { ...f.sourceRef, artifactId: f.document.originalArtifactId }
          : { ...f.sourceRef, quote: 'T10 forged quotation absent from actual block' };
        if (cause === 'old-version') expect(f.firstVersion.documentRef.version).not.toBe(f.document.documentRef.version);
        fields.values.totalAmount.sources = [altered];
        // Controlled corrupt historical input: preserve all production guards and the actual model candidate pair.
        expect(db.query('UPDATE invoice_candidates SET fields_json=? WHERE id=?').run(JSON.stringify(fields), f.candidate.candidateId).changes).toBe(1);
        before = materialRows(db); expect(db.query('PRAGMA foreign_key_check').all()).toEqual([]);
      } finally { db.close(); }
      const app = await f.open(); const httpBefore = f.http();
      const run = await f.runInput(app, 2, 'answer');
      expect(run.result).toMatchObject({ ok: false, error: { code: 'source_invalid', category: 'input', retryable: false } });
      expect(f.http()).toBe(httpBefore); expect(httpBefore).toBe(2);
      expect(need(await app.close()).closed).toBe(true);
      const after = new Database(f.paths.databaseFile, { readonly: true });
      try { expect(materialRows(after)).toEqual(before!); expect(after.query('PRAGMA foreign_key_check').all()).toEqual([]); }
      finally { after.close(); }
    });
});

function need<T>(result: Result<T>): T { if (!result.ok) throw new Error(result.error.code); return result.data; }
function fixture(selection: WorkspaceSelection | null = null, fill = false, human = false, workingDirectory?: string) {
  const base = makeSelectedCandidate(false, true);
  const store = { ...base, context: createContextRepository({ db: base.db, loadHistory: id => base.sessions.loadHistory(id) }) };
  need(saveTestHistory(store.db, 'runtimeEventStore' in store ? store.runtimeEventStore as RuntimeEventStore : undefined, store.session.sessionId, { storageVersion: 1,
    header: { type: 'session', id: store.session.nativeSessionId, timestamp: store.stamp, cwd: store.root, version: 3 },
    entries: [], leafId: null, unusable: false }));
  let workspace = store.selectedWorkspace;
  if (selection) workspace = need(store.workspace.update({ expectedRevision: workspace.revision,
    change: { kind: 'selection', selection }, at: store.stamp }, store.verify));
  const paths = { root: store.root, databaseFile: '', artifactsDir: `${store.root}/artifacts`, logsDir: `${store.root}/logs`,
    outputsDir: `${store.root}/outputs`, runtimeDir: `${store.root}/runtime` };
  const files = createFileStore(paths, store.documents);
  const documents = createDocumentService({ paths, repository: store.documents, files, allowedSourceRoot: store.root, now: () => store.stamp });
  if (human) {
    const basis = need(store.candidates.readByJob({ jobId: store.jobId, candidateId: store.candidateId })).candidate;
    const draft = InvoiceFormDraftSchema.parse({ fields: Object.fromEntries(invoiceHeaderFields.map(name =>
      [name, invoiceFieldDisplayValue(name, basis.fields[name])])), lines: [], notes: [] });
    draft.fields.invoiceNumber = 'Human invoice';
    workspace = need(store.candidates.saveHuman({ operationRef: 'context-human', jobId: store.jobId, basedOnCandidateId: basis.candidateId,
      expectedCandidateId: basis.candidateId, expectedRevision: workspace.revision, draft, at: store.stamp,
      validate: (draft, ref) => validateHumanInvoiceCandidate(draft, ref, documents) })).workspace;
  }
  let reads = 0;
  const service = new ContextService({ store, materials: { inspectParsed: input => { reads++; return documents.inspectParsedForContext(input); } } });
  const admitted = need(store.runs.createWorkspaceAgent({ sessionId: store.session.sessionId,
    expected: { revision: workspace.revision, documentRef: workspace.documentRef, jobId: workspace.jobId,
      candidateRef: workspace.candidateRef, sessionId: store.session.sessionId }, goalMode: fill ? 'fill-form' : 'answer', text: 'Explain the tax amount.',
    goal: 'Review form fixture', messageTimestamp: 2, config: store.config, usage: store.usage, cleanup: store.cleanup,
    ...(fill ? { formTarget: { formInstanceId: 'form-1', expectedRevision: 3 } } : {}),
    ...(workingDirectory ? { nativeTools: { runtimeDir: `${store.root}/runtime`, allowedTools: ['read'], workingDirectory } } : {}),
    createdAt: store.stamp }, store.verify));
  // T04 will set this when creating new Runs. This fixture activates only the new admitted Run, before any Input insertion.
  const config = need(store.runs.get(admitted.runId)).config;
  store.db.query('UPDATE runs SET config_json=?,context_observations_json=? WHERE id=?')
    .run(JSON.stringify({ ...config, contextPolicyVersion: 'p8-context-v1' }), JSON.stringify({ version: 1, requests: [] }), admitted.runId);
  store.db.exec('BEGIN IMMEDIATE');
  const request: ContextBuildRequest = { runId: admitted.runId, sessionId: store.session.sessionId, jobId: store.jobId,
    text: 'Explain the tax amount.', goalMode: fill ? 'fill-form' : 'answer', workspaceContext: admitted.workspaceContext,
    workspaceInput: admitted.workspaceInput, allowedDocumentIds: admitted.scope.allowedDocumentIds,
    allowedArtifactIds: admitted.scope.allowedArtifactIds, workingDirectory: workingDirectory ?? null, createdAt: store.stamp };
  return { store, documents, service, request, reads: () => reads };
}
function count(f: ReturnType<typeof fixture>) { return f.store.db.query('SELECT * FROM context_snapshots').all().length; }

async function publicContextFixture(state: 'active' | 'archived' | 'blocked' | 'bad-journal' | 'unsafe-error' | 'legacy' | 'empty' | 'directory' = 'active') {
  const root = mkdtempSync(join(tmpdir(), 'flowmate-p8-public-context-'));
  const paths = { root, databaseFile: join(root, 'data', 'app.sqlite'), artifactsDir: join(root, 'artifacts'),
    logsDir: join(root, 'logs'), outputsDir: join(root, 'outputs'), runtimeDir: join(root, 'runtime') };
  let http = 0; const counts = { restore: 0, leaf: 0, watch: 0, prepare: 0, enqueue: 0, build: 0 };
  const preparations: import('@flowmate/contracts').PreparedAgent['snapshot'][] = [];
  const server = Bun.serve({ hostname: '127.0.0.1', port: 0, fetch() { http++;
    return new Response('data: ' + JSON.stringify({ choices: [{ index: 0, delta: { role: 'assistant', content: 'Public context answer' }, finish_reason: null }] })
      + '\n\ndata: ' + JSON.stringify({ choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] }) + '\n\ndata: [DONE]\n\n',
      { headers: { 'content-type': 'text/event-stream' } }); } });
  deferCleanup(() => server.stop(true));
  const create = async () => need(await createApplication({ paths, logger: { write() {}, async close() {} }, agentFactory: tools => {
    const agent = new PiAgentAdapter({ cwd: paths.runtimeDir, agentDir: paths.runtimeDir, tools,
      credentials: new InMemoryCredentialStore(), runtimeApiKey: 'synthetic-public-context-key' });
    const restore = agent.restoreSession.bind(agent), leaf = agent.restoreSessionLeaf.bind(agent), watch = agent.watchSession.bind(agent),
      prepare = agent.prepare.bind(agent), enqueue = agent.enqueueInput.bind(agent);
    agent.restoreSession = (...args) => { counts.restore++; return restore(...args); };
    agent.restoreSessionLeaf = (...args) => { counts.leaf++; return leaf(...args); };
    agent.watchSession = (...args) => { counts.watch++; return watch(...args); };
    agent.prepare = async (...args) => { counts.prepare++; const result = await prepare(...args); if (result.ok) preparations.push(result.data.snapshot); return result; };
    agent.enqueueInput = (...args) => { counts.enqueue++; return enqueue(...args); };
    return agent;
  } }));
  const first = await create(); deferCleanup(() => first.close());
  const session = need(await first.createSession({ title: 'Public context', expectedRevision: need(await first.readWorkspace()).revision }));
  let finished!: (event: AgentRunEvent & { type: 'run_finished' }) => void;
  const terminal = new Promise<AgentRunEvent & { type: 'run_finished' }>(resolve => { finished = resolve; });
  const workspace = need(await first.readWorkspace());
  const accepted = need(await first.submitInput({ sessionId: session.sessionId, clientSequence: 1, mode: 'prompt', text: 'User path C:/user/invoice.txt',
    ...(state === 'directory' ? { workingDirectory: mkdtempSync(join(tmpdir(), 'flowmate-p8-managed-work-')),
      workspace: { revision: workspace.revision, documentRef: workspace.documentRef, jobId: workspace.jobId,
        candidateRef: workspace.candidateRef, sessionId: session.sessionId } } : {}),
    config: { version: 1, name: 'Public context', revision: 1, modelRef: { provider: 'public-context', model: 'fixture' },
      native: { authPath: join(root, 'unused.json'), modelsPath: null }, connection: { baseUrl: `http://127.0.0.1:${server.port}/v1`,
        api: 'openai-completions', contextWindow: 64000, maxTokens: 16384 }, parameters: { maxRetries: 0, maxRetryDelayMs: 100 } },
    timeoutMs: 5000, stopGraceMs: 500 }, { onEvent(event) { if (event.type === 'run_finished') finished(event); } }));
  expect((await terminal).result).toMatchObject({ ok: true, data: { status: 'completed' } });
  const input = need(await first.querySessionInput({ sessionId: session.sessionId, inputId: accepted.inputId })).input!;
  const originalRun = need(await first.queryRun(accepted.runId));
  const otherSession = need(await first.createSession({ title: 'Other owner', expectedRevision: need(await first.readWorkspace()).revision }));
  if (input.contextSnapshotId === null) throw new Error('P8 snapshot required.');
  need(await first.close());
  let readRunId = accepted.runId;
  if (state === 'legacy' || state === 'empty') {
    const prepared = preparations[0];
    if (originalRun.kind !== 'agent' || originalRun.scope.version !== 1 || !prepared) throw new Error('Actual chat Agent fixture required.');
    const opened = need(openDatabase(paths));
    try {
      const { contextPolicyVersion: _marker, ...legacyConfig } = prepared;
      const cleanup = { version: 1 as const, stopped: true, stopReason: 'not-started', lateObservationRequired: false, errors: [] };
      readRunId = need(opened.runs.createAgent({ goal: 'Never dispatched query fixture', sessionId: session.sessionId,
        scope: originalRun.scope, input: originalRun.input,
        config: { ...legacyConfig,
          ...(prepared.agent.policyVersion === 'runtime-v1' ? { version: 2 as const,
            runtimeBudget: { maxToolCalls: prepared.agent.maxToolCalls, maxModelCalls: prepared.agent.maxModelCalls,
              toolTimeoutMs: prepared.agent.toolTimeoutMs } } : {}),
          ...(state === 'empty' ? { contextPolicyVersion: 'p8-context-v1' as const } : {}) },
        usage: originalRun.usage, cleanup, createdAt: originalRun.createdAt }));
      need(opened.runs.finish(readRunId, { status: 'failed', output: null,
        error: appError('runtime_not_started', 'runtime', 'This fixture was never dispatched.'), usage: originalRun.usage, tokens: originalRun.tokens,
        cleanup, endedAt: originalRun.endedAt!, stoppedAt: originalRun.stoppedAt, durationMs: null }));
    } finally { opened.close(); }
  }
  const db = new Database(paths.databaseFile);
  deferCleanup(() => db.close());
  if (state === 'archived') db.query("UPDATE sessions SET status='archived' WHERE id=?").run(session.sessionId);
  if (state === 'blocked') db.query("UPDATE sessions SET metadata_json=json_set(metadata_json,'$.model_use_blocked',json(?)) WHERE id=?")
    .run(JSON.stringify({ documentIds: [1], at: new Date().toISOString(), reason: 'document_use_revoked' }), session.sessionId);
  if (state === 'bad-journal') db.query('UPDATE runs SET context_observations_json=? WHERE id=?')
    .run(JSON.stringify({ version: 1, requests: {} }), accepted.runId);
  if (state === 'unsafe-error') db.query("UPDATE session_inputs SET processing_status='failed',error_json=? WHERE id=?")
    .run(JSON.stringify({ code: 'unknown_sdk_failure', category: 'runtime', retryable: true, message: 'private/raw/SDK exception' }), accepted.inputId);
  const facts = () => Object.fromEntries(['runs', 'session_inputs', 'context_snapshots', 'tool_calls', 'sessions', 'workspace']
    .map(table => [table, db.query(`SELECT * FROM ${table}`).all()]));
  const before = facts(); db.close();
  const app = await create(); deferCleanup(() => app.close());
  for (const key of Object.keys(counts)) Reflect.set(counts, key, 0);
  const originalBuild = ContextService.prototype.build;
  ContextService.prototype.build = function (...args) { counts.build++; return originalBuild.apply(this, args); };
  deferCleanup(() => { ContextService.prototype.build = originalBuild; });
  return { app, paths, session, otherSession, accepted, readRunId, input, before, counts, http: () => http };
}

describe('T08 real Application readonly Context', () => {
  it('publishes only registered failure facts from actual saved Input evidence', async () => {
    const f = await publicContextFixture('unsafe-error');
    const detail = need(await f.app.queryContextSnapshot({ sessionId: f.session.sessionId, runId: f.accepted.runId, snapshotId: f.input.contextSnapshotId! }));
    expect(detail.input.error).toEqual({ code: 'internal_error', category: 'internal', retryable: false });
    expect(JSON.stringify(detail)).not.toContain('private/raw'); expect(JSON.stringify(detail)).not.toContain('unknown_sdk_failure');
    expect(f.counts).toEqual({ restore: 0, leaf: 0, watch: 0, prepare: 0, enqueue: 0, build: 0 }); expect(f.http()).toBe(1);
  });
  it.each(['legacy', 'empty'] as const)('returns explicit %s collection without inventing a snapshot or request', async state => {
    const f = await publicContextFixture(state);
    expect(await f.app.listContextSnapshots({ sessionId: f.session.sessionId, runId: f.readRunId }))
      .toEqual({ ok: true, data: { sessionId: f.session.sessionId, runId: f.readRunId, items: [], nextBeforeId: null } });
    expect(await f.app.listContextRequests({ sessionId: f.session.sessionId, runId: f.readRunId }))
      .toEqual({ ok: true, data: { sessionId: f.session.sessionId, runId: f.readRunId,
        collection: state === 'legacy' ? 'not-collected' : 'collected', items: [], nextBeforeRequestSequence: null } });
    expect(f.counts).toEqual({ restore: 0, leaf: 0, watch: 0, prepare: 0, enqueue: 0, build: 0 }); expect(f.http()).toBe(1);
  });
  it('checks original Run and Session ownership for empty lists and snapshot detail', async () => {
    const f = await publicContextFixture(), owner = { sessionId: f.otherSession.sessionId, runId: f.accepted.runId };
    for (const result of [await f.app.listContextSnapshots(owner), await f.app.listContextRequests(owner),
      await f.app.queryContextSnapshot({ ...owner, snapshotId: f.input.contextSnapshotId! })])
      expect(result).toMatchObject({ ok: false, error: { code: 'state_conflict', category: 'runtime', retryable: false } });
    expect(await f.app.listContextRequests({ sessionId: f.session.sessionId, runId: 999999 }))
      .toMatchObject({ ok: false, error: { code: 'run_not_found', category: 'runtime', retryable: false } });
    expect(f.counts).toEqual({ restore: 0, leaf: 0, watch: 0, prepare: 0, enqueue: 0, build: 0 }); expect(f.http()).toBe(1);
  });
  it('projects an actual saved working directory to a flag and preserves user text paths', async () => {
    const f = await publicContextFixture('directory');
    const detail = need(await f.app.queryContextSnapshot({ sessionId: f.session.sessionId, runId: f.accepted.runId, snapshotId: f.input.contextSnapshotId! }));
    expect(detail.snapshot.json.hasWorkingDirectory).toBe(true);
    expect(detail.snapshot.json.text).toBe('User path C:/user/invoice.txt');
    const serialized = JSON.stringify(detail);
    for (const forbidden of ['workingDirectory', 'allowedDocumentIds', 'allowedArtifactIds', 'promptText', 'requestHash', 'managed-work-'])
      expect(serialized).not.toContain(forbidden);
    expect(Object.keys(detail.input)).not.toContain('content');
    expect(f.counts).toEqual({ restore: 0, leaf: 0, watch: 0, prepare: 0, enqueue: 0, build: 0 }); expect(f.http()).toBe(1);
  });
  it.each(['active', 'archived', 'blocked'] as const)('reads committed no-Job original context from %s without restoring or executing', async state => {
    const f = await publicContextFixture(state);
    const page = need(await f.app.listContextSnapshots({ sessionId: f.session.sessionId, runId: f.accepted.runId }));
    expect(page.items).toHaveLength(1); expect(page.items[0]).toMatchObject({ id: f.input.contextSnapshotId, jobId: null });
    const detail = need(await f.app.queryContextSnapshot({ sessionId: f.session.sessionId, runId: f.accepted.runId, snapshotId: f.input.contextSnapshotId! }));
    expect(detail.snapshot.json.text).toBe('User path C:/user/invoice.txt'); expect(detail.snapshot.json.hasWorkingDirectory).toBe(false);
    expect(Object.keys(detail.input).sort()).not.toContain('content'); expect(JSON.stringify(detail)).not.toContain('requestHash');
    expect(need(await f.app.listContextRequests({ sessionId: f.session.sessionId, runId: f.accepted.runId })).items).toHaveLength(1);
    expect(await f.app.queryContextSnapshot({ sessionId: f.session.sessionId, runId: f.accepted.runId, snapshotId: 999999 }))
      .toMatchObject({ ok: false, error: { code: 'context_snapshot_not_found' } });
    expect(f.counts).toEqual({ restore: 0, leaf: 0, watch: 0, prepare: 0, enqueue: 0, build: 0 }); expect(f.http()).toBe(1);
    need(await f.app.close()); const db = new Database(f.paths.databaseFile, { readonly: true });
    try { expect(Object.fromEntries(Object.keys(f.before).map(table => [table, db.query(`SELECT * FROM ${table}`).all()]))).toEqual(f.before); }
    finally { db.close(); }
  });
  it('rejects actual corrupt journal instead of returning empty success or restoring a native Session', async () => {
    const f = await publicContextFixture('bad-journal');
    expect(await f.app.listContextRequests({ sessionId: f.session.sessionId, runId: f.accepted.runId }))
      .toMatchObject({ ok: false, error: { code: 'storage_corrupt' } });
    expect(f.counts).toEqual({ restore: 0, leaf: 0, watch: 0, prepare: 0, enqueue: 0, build: 0 }); expect(f.http()).toBe(1);
  });
});

describe('T03 Context build on real frozen storage and material', () => {
  it('saves a real bounded snapshot and Run pointer inside the caller transaction without inserting an Input', () => {
    const f = fixture(), before = f.store.db.query('SELECT * FROM documents').all();
    try {
      const built = need(f.service.build(f.request));
      expect(built.snapshot.json.modelProjection.taskGoal).toBe('Review form fixture');
      expect(built.snapshot.json.modelProjection.candidate).toMatchObject({ id: f.store.candidateId, sequence: 1, origin: 'model', statusAtSelection: 'generated' });
      expect(built.snapshot.json.modelProjection.fragments[0]?.windows[0]?.text).toBe('Total 113.00');
      expect(built.promptText).toContain('Flowmate selected context');
      expect(built.promptText).not.toContain('"workspace":');
      expect(need(f.store.runs.get(f.request.runId)).currentContextSnapshotId).toBe(built.snapshot.id);
      expect(f.store.db.query('SELECT * FROM session_inputs').all()).toEqual([]);
      expect(f.store.db.query('SELECT * FROM documents').all()).toEqual(before);
      expect(f.reads()).toBe(1); expect(f.store.db.inTransaction).toBe(true);
      f.store.db.exec('ROLLBACK'); expect(count(f)).toBe(0);
    } finally { if (f.store.db.inTransaction) f.store.db.exec('ROLLBACK'); }
  });
  it('refuses missing outer transaction before reading managed materials', () => {
    const f = fixture(); f.store.db.exec('COMMIT');
    expect(f.service.build(f.request)).toMatchObject({ ok: false, error: { code: 'state_conflict' } });
    expect(f.reads()).toBe(0); expect(count(f)).toBe(0);
  });
  it.each(['scope', 'snapshot-owner', 'candidate-sequence', 'directory', 'cancelled', 'revoked', 'job-hidden'] as const)
    ('rejects %s changes before any snapshot can be saved', cause => {
      const f = fixture(); let request = f.request;
      try {
        if (cause === 'scope') request = { ...request, allowedArtifactIds: [2, 999] };
        if (cause === 'snapshot-owner') request = { ...request, sessionId: 999 };
        if (cause === 'candidate-sequence') request = { ...request, workspaceContext: { ...request.workspaceContext!, candidateRef: { id: f.store.candidateId, sequence: 999 } } };
        if (cause === 'directory') request = { ...request, workingDirectory: 'C:/other' };
        if (cause === 'cancelled') f.store.db.query('UPDATE runs SET cancel_requested_at=? WHERE id=?').run(f.store.stamp, request.runId);
        if (cause === 'revoked') f.store.db.query("UPDATE sessions SET metadata_json=json_set(metadata_json,'$.model_use_blocked',json(?)) WHERE id=?")
          .run(JSON.stringify({ documentIds: [1], at: f.store.stamp, reason: 'document_use_revoked' }), request.sessionId);
        if (cause === 'job-hidden') f.store.db.query('UPDATE jobs SET hidden_at=? WHERE id=?').run(f.store.stamp, f.store.jobId);
        expect(f.service.build(request).ok).toBe(false); expect(count(f)).toBe(0); expect(f.reads()).toBe(0);
      } finally { f.store.db.exec('ROLLBACK'); }
    });
  it('rejects forged selected quote and oversize snapshot with no pointer or snapshot partial write', () => {
    for (const kind of ['quote', 'snapshot'] as const) {
      const f = fixture();
      try {
        let request = f.request;
        if (kind === 'quote') {
          f.store.db.query("UPDATE invoice_candidates SET fields_json=json_set(fields_json,'$.values.totalAmount.sources[0].quote','Forged quote') WHERE id=?").run(f.store.candidateId);
          const actual = need(f.store.candidates.readByJob({ jobId: f.store.jobId, candidateId: f.store.candidateId })).candidate;
          request = { ...request, workspaceInput: { ...request.workspaceInput!, candidate: { id: actual.candidateId, sequence: actual.sequence,
            fields: actual.fields, lines: actual.lines, issues: actual.issues } } };
        } else request = { ...request, text: '\u0000'.repeat(65000) };
        expect(f.service.build(request)).toMatchObject({ ok: false, error: { code: kind === 'quote' ? 'source_invalid' : 'input_too_large' } });
        expect(count(f)).toBe(0); expect(need(f.store.runs.get(request.runId)).currentContextSnapshotId).toBe(null);
      } finally { f.store.db.exec('ROLLBACK'); }
    }
  });
  it('uses original complete Fill material and fixed target while the snapshot and formatter stay reference-only', () => {
    const f = fixture(null, true);
    try {
      const built = need(f.service.build(f.request));
      expect(built.snapshot.json.modelProjection.candidate?.values).toEqual([]);
      expect(built.snapshot.json.modelProjection.fragments).toEqual([]);
      const original = formatExecutionPrompt({ text: f.request.text, workspaceInput: f.request.workspaceInput!, workspaceContext: f.request.workspaceContext!,
        goalMode: 'fill-form', business: true });
      expect(built.promptText.startsWith(original)).toBe(true);
      expect(built.promptText).toContain('"projectionMode":"fill-reference"');
      expect(built.promptText).toContain('"totalAmount"');
      expect(need(f.store.runs.get(f.request.runId)).config.formTarget).toEqual({ formInstanceId: 'form-1', expectedRevision: 3 });
      expect(() => formatContextPrompt(built.snapshot)).toThrow();
    } finally { f.store.db.exec('ROLLBACK'); }
  });

  it('rechecks the original generated candidate qualification for Fill after freezing', () => {
    const f = fixture(null, true);
    try {
      f.store.db.query("UPDATE invoice_candidates SET status='rejected' WHERE id=?").run(f.store.candidateId);
      expect(f.service.build(f.request)).toMatchObject({ ok: false, error: { code: 'state_conflict' } });
      expect(count(f)).toBe(0); expect(f.reads()).toBe(0);
    } finally { f.store.db.exec('ROLLBACK'); }
  });
  it('formats ordinary user text and frozen directories without copying the full frozen candidate', () => {
    const f = fixture(null, false, false, 'C:/verified');
    try {
      const built = need(f.service.build(f.request));
      const snapshot = built.snapshot;
      expect(need(f.store.runs.get(f.request.runId)).config.workingDirectory).toBe('C:/verified');
      expect(formatContextPrompt(snapshot)).toContain('"workingDirectory":"C:/verified"');
      expect(formatContextPrompt(snapshot).endsWith(f.request.text)).toBe(true);
      const chat = { ...snapshot, json: ContextSnapshotJsonSchema.parse({ ...snapshot.json, workspaceContext: null, workingDirectory: null, text: 'Keep\nexact 😀 bytes' }) };
      expect(formatContextPrompt(chat)).toBe('Keep\nexact 😀 bytes');
    } finally { f.store.db.exec('ROLLBACK'); }
  });

  it('preserves exact chat bytes and the actual Run goal without opening business materials', () => {
    const f = fixture(); f.store.db.exec('COMMIT');
    need(f.store.runs.recordCancel(f.request.runId, f.store.stamp));
    need(f.store.runs.finish(f.request.runId, { status: 'cancelled', output: null, error: appError('agent_cancelled', 'runtime', 'Fixture stopped.'),
      usage: f.store.usage, tokens: { inputTokens: null, outputTokens: null, totalTokens: null, cost: null, usageComplete: false },
      cleanup: { ...f.store.cleanup, stopped: true, stopReason: 'native-stop' }, endedAt: f.store.stamp, stoppedAt: f.store.stamp, durationMs: 0 }));
    const nativeId = 'context-chat-native';
    const session = need(f.store.sessions.create({ nativeSessionId: nativeId, title: 'Context chat', at: f.store.stamp,
      nativeHistory: { storageVersion: 1, header: { type: 'session', version: 3, id: nativeId, timestamp: f.store.stamp, cwd: f.store.root },
        entries: [], leafId: null, unusable: false } }));
    const text = 'Keep\nexact 😀 bytes';
    const config = { ...f.store.config, agent: { policyVersion: 'p5-session-inputs-v1' as const, nativeSessionId: nativeId,
      systemPrompt: 'Chat fixture', thinkingLevel: 'off', resourcePolicy: 'none' as const, historyPolicy: 'memory-only' as const,
      maxContextBytes: 524288 as const, maxOutputBytes: 262144 as const, maxAssistantContentBytes: 524288 as const,
      maxModelCalls: 12 as const, sessionRetry: false as const } };
    const runId = need(f.store.runs.createAgent({ sessionId: session.sessionId, goal: 'Original chat goal',
      input: { version: 1, goal: 'Original chat goal', text, messageTimestamp: 3 }, config,
      scope: { version: 1, mode: 'chat-text', toolNames: [], resourcePaths: [] }, usage: f.store.usage,
      cleanup: f.store.cleanup, createdAt: f.store.stamp }));
    f.store.db.query('UPDATE runs SET config_json=?,context_observations_json=? WHERE id=?')
      .run(JSON.stringify({ ...config, contextPolicyVersion: 'p8-context-v1' }), JSON.stringify({ version: 1, requests: [] }), runId);
    f.store.db.exec('BEGIN IMMEDIATE');
    try {
      const built = need(f.service.build({ runId, sessionId: session.sessionId, jobId: null, text, goalMode: 'answer',
        workspaceContext: null, workspaceInput: null, allowedDocumentIds: [], allowedArtifactIds: [], workingDirectory: null, createdAt: f.store.stamp }));
      expect(built.promptText).toBe(text); expect(built.snapshot.json.text).toBe(text);
      expect(built.snapshot.json.modelProjection.taskGoal).toBe('Original chat goal'); expect(f.reads()).toBe(0);
    } finally { f.store.db.exec('ROLLBACK'); }
  });

  it('rolls back the inserted snapshot when Run pointer persistence fails and the caller throws its failed Result', () => {
    const f = fixture(); f.store.db.exec('COMMIT');
    const before = { runs: f.store.db.query('SELECT * FROM runs').all(), documents: f.store.db.query('SELECT * FROM documents').all() };
    f.store.db.exec("CREATE TRIGGER t03_reject_pointer BEFORE UPDATE OF current_context_snapshot_id ON runs WHEN NEW.current_context_snapshot_id IS NOT NULL BEGIN SELECT RAISE(ABORT,'t03_pointer_failure'); END");
    expect(() => f.store.db.transaction(() => {
      const built = f.service.build(f.request);
      if (!built.ok) throw new Error(built.error.code);
      throw new Error('expected injected pointer failure');
    }).immediate()).toThrow('storage_write_failed');
    expect(count(f)).toBe(0);
    expect({ runs: f.store.db.query('SELECT * FROM runs').all(), documents: f.store.db.query('SELECT * FROM documents').all() }).toEqual(before);
  });

  it('derives human origin from its real saved row and keeps preserved model evidence and new manual values distinct', () => {
    const f = fixture(null, false, true);
    try {
      const built = need(f.service.build(f.request));
      expect(built.snapshot.json.modelProjection.candidate).toMatchObject({ sequence: 2, origin: 'human_edit', statusAtSelection: 'generated' });
      expect(built.snapshot.json.modelProjection.candidate?.values.find(value => value.fieldPath === 'fields.invoiceNumber')?.value)
        .toMatchObject({ raw: 'Human invoice', valueOrigin: 'user-provided', sources: [] });
      expect(built.snapshot.json.modelProjection.candidate?.values.find(value => value.fieldPath === 'fields.totalAmount')?.value.sources)
        .toEqual([{ documentId: 1, version: 'v1', artifactId: 2, page: 1, blockId: 'b1', quote: 'Total 113.00' }]);
      const actual = need(f.store.candidates.readByJob({ jobId: f.store.jobId, candidateId: f.request.workspaceContext!.candidateRef!.id })).candidate;
      expect(actual.issues.length).toBeGreaterThan(0);
      expect(built.snapshot.json.modelProjection.issues).toEqual(actual.issues.filter(issue => issue.fieldPaths.length > 0));
    } finally { f.store.db.exec('ROLLBACK'); }
  });

  it.each(['archived', 'hidden', 'delete-pending', 'unusable-history', 'legacy-history', 'invalid-history'] as const)
    ('rechecks %s qualification in the admission transaction before material reads', cause => {
      const f = fixture();
      try {
        if (cause === 'archived') f.store.db.query("UPDATE sessions SET status='archived' WHERE id=?").run(f.request.sessionId);
        if (cause === 'hidden') f.store.db.query('UPDATE sessions SET hidden_at=? WHERE id=?').run(f.store.stamp, f.request.sessionId);
        if (cause === 'delete-pending') f.store.db.query("UPDATE sessions SET metadata_json=json_set(metadata_json,'$.delete_pending',json('true')) WHERE id=?").run(f.request.sessionId);
        if (cause === 'unusable-history') f.store.db.query('UPDATE session_native_history SET unusable=1 WHERE session_id=?').run(f.request.sessionId);
        if (cause === 'legacy-history') f.store.db.query('DELETE FROM session_native_history WHERE session_id=?').run(f.request.sessionId);
        if (cause === 'invalid-history') f.store.db.query('UPDATE session_native_history SET entry_count=1 WHERE session_id=?').run(f.request.sessionId);
        const codes = { archived: 'session_archived', hidden: 'session_not_found', 'delete-pending': 'session_delete_incomplete',
          'unusable-history': 'session_history_invalid', 'legacy-history': 'session_history_unavailable', 'invalid-history': 'session_history_invalid' };
        expect(f.service.build(f.request)).toMatchObject({ ok: false, error: { code: codes[cause] } });
        expect(count(f)).toBe(0); expect(f.reads()).toBe(0);
      } finally { f.store.db.exec('ROLLBACK'); }
    });

  it('blocks Accept while the original Run is active, then keeps the generated snapshot immutable after a real Accept', () => {
    const f = fixture();
    const accept = () => f.store.candidates.accept({ operationRef: 'context-accept', jobId: f.store.jobId, candidateId: f.store.candidateId,
      expectedCandidateId: f.store.candidateId, expectedRevision: f.store.selectedWorkspace.revision, dirty: false, at: f.store.stamp,
      validate: (draft, ref) => validateHumanInvoiceCandidate(draft, ref, f.documents) });
    try {
      const built = need(f.service.build(f.request));
      expect(accept()).toMatchObject({ ok: false, error: { code: 'state_conflict' } });
      f.store.db.exec('COMMIT');
      expect(f.store.db.inTransaction).toBe(false);
      expect(need(f.store.jobs.get(f.store.jobId)).status).toBe('running');
      need(f.store.runs.recordCancel(f.request.runId, f.store.stamp));
      need(f.store.runs.finish(f.request.runId, { status: 'cancelled', output: null, error: appError('agent_cancelled', 'runtime', 'Fixture stopped.'),
        usage: f.store.usage, tokens: { inputTokens: null, outputTokens: null, totalTokens: null, cost: null, usageComplete: false },
        cleanup: { ...f.store.cleanup, stopped: true, stopReason: 'native-stop' }, endedAt: f.store.stamp, stoppedAt: f.store.stamp, durationMs: 0 }));
      const accepted = need(accept());
      expect(accepted.candidate.status).toBe('accepted'); expect(accepted.job.acceptedCandidateId).toBe(f.store.candidateId);
      expect(f.store.db.query('SELECT snapshot_json FROM context_snapshots WHERE id=?').get(built.snapshot.id))
        .toEqual({ snapshot_json: JSON.stringify(built.snapshot.json) });
      expect(built.snapshot.json.modelProjection.candidate?.statusAtSelection).toBe('generated');
      expect(f.store.runs.createWorkspaceAgent({ sessionId: f.request.sessionId, expected: {
        revision: accepted.workspace.revision, documentRef: accepted.workspace.documentRef, jobId: accepted.workspace.jobId,
        candidateRef: accepted.workspace.candidateRef, sessionId: f.request.sessionId }, goalMode: 'answer', text: 'After Accept',
        messageTimestamp: 3, goal: 'Review form fixture', config: f.store.config, usage: f.store.usage, cleanup: f.store.cleanup,
        createdAt: f.store.stamp }, f.store.verify)).toMatchObject({ ok: false, error: { code: 'job_completed' } });
    } finally { if (f.store.db.inTransaction) f.store.db.exec('ROLLBACK'); }
  });
});
