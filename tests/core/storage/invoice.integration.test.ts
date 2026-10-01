import { mkdirSync } from 'node:fs';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { tmpdir } from 'node:os';
import { Database } from 'bun:sqlite';
import { describe, expect, it } from 'bun:test';
import type { CandidateDraft, InvoiceIssue, P3AgentConfigFacts, Result, SafeConfigSnapshot, UsageRecord, WorkspaceSnapshot } from '@flowmate/contracts';
import { deferCleanup, mkdtempSync } from '../../support/resources.ts';
import { openDatabase } from '../../../packages/core/src/storage/database.ts';

function makePaths(root: string) {
  return {
    root,
    databaseFile: join(root, 'data', 'trial.sqlite'),
    logsDir: join(root, 'logs'),
    artifactsDir: join(root, 'artifacts'),
    outputsDir: join(root, 'outputs'),
    runtimeDir: join(root, 'runtime'),
  };
}

function required<T>(result: Result<T>): T {
  if (!result.ok) throw new Error(`${result.error.code}: ${result.error.message}`);
  return result.data;
}

describe('selected candidate Workspace admission', () => {
  it('allows a caller transaction to roll back nested repository writes as one unit', () => {
    const store = required(openDatabase(makePaths(mkdtempSync(join(tmpdir(), 'flowmate-repository-transaction-')))));
    deferCleanup(() => store.close());
    const operation = store.db.transaction(() => {
      required(store.sessions.create({ nativeSessionId: 'nested-session', title: 'Nested', at: '2026-10-01T00:00:00.000Z' }));
      throw new Error('outer-write-failed');
    });
    expect(() => operation.immediate()).toThrow('outer-write-failed');
    expect(store.db.query('SELECT COUNT(*) AS count FROM sessions').get()).toEqual({ count: 0 });
  });

  it('freezes the candidate saved by a real tool after user selection into the next Run', () => {
    const store = required(openDatabase(makePaths(mkdtempSync(join(tmpdir(), 'flowmate-candidate-admission-')))));
    deferCleanup(() => store.close());
    const stamp = '2026-10-01T00:00:00.000Z';
    const artifactMetadata = { version: 1 as const, sourceKey: 'synthetic', sourceRecordId: 'selected-invoice', sourceVersion: 'v1',
      files: [{ relativePath: 'fixture.json', bytes: 1, mimeType: 'application/json' }] };
    required(store.documents.register({ documentId: 1, sourceKey: 'synthetic', sourceRecordId: 'selected-invoice', version: 'v1',
      originalArtifact: { artifactId: 1, kind: 'original', relativePath: 'artifacts/1/original.pdf', bytes: 1,
        mimeType: 'application/pdf', metadata: artifactMetadata, createdAt: stamp },
      parsedArtifact: { artifactId: 2, kind: 'parsed', relativePath: 'artifacts/2/parsed.json', bytes: 1,
        mimeType: 'application/json', metadata: artifactMetadata, createdAt: stamp },
      status: 'available', metadata: { version: 2, pageCount: 1, warnings: [], allowedUsesClaim: ['synthetic test'],
        licenseVerification: 'not_verified', unavailableReason: null }, createdAt: stamp, updatedAt: stamp }));
    const session = required(store.sessions.create({ nativeSessionId: 'native-candidate-admission', title: 'Selected candidate', at: stamp }));
    let workspace = required(store.workspace.read(stamp));
    workspace = required(store.workspace.update({ expectedRevision: workspace.revision,
      change: { kind: 'session', sessionId: session.sessionId }, at: stamp }));
    workspace = required(store.workspace.update({ expectedRevision: workspace.revision,
      change: { kind: 'document', documentId: 1 }, at: stamp }));
    const task = required(store.jobs.create({ clientSequence: 1, expectedRevision: workspace.revision,
      documentRef: { id: 1, version: 'v1' }, goal: 'Review invoice totals', at: stamp }));
    workspace = task.workspace;
    const agent: P3AgentConfigFacts = { policyVersion: 'p3-invoice-tools-v1', nativeSessionId: session.nativeSessionId,
      systemPrompt: 'Review the selected invoice.', thinkingLevel: 'off', resourcePolicy: 'none', historyPolicy: 'memory-only',
      maxContextBytes: 8_388_608, maxOutputBytes: 262_144, maxAssistantContentBytes: 524_288, maxModelCalls: 12,
      maxToolCalls: 24, toolTimeoutMs: 10_000, sessionRetry: false };
    const config: SafeConfigSnapshot & { agent: P3AgentConfigFacts } = { version: 1, name: 'fixture', revision: 1,
      requestedModel: { provider: 'fixture', model: 'offline' }, resolvedModel: { provider: 'fixture', model: 'offline' },
      api: null, endpoint: null, sdk: { codingAgent: '0.85.1', ai: '0.85.1' }, parameters: { maxRetries: 0, maxRetryDelayMs: 100 },
      limits: { timeoutMs: 60_000, stopGraceMs: 5_000 }, native: { authSource: 'unknown', modelsSelection: null }, agent };
    const usage: UsageRecord = { version: 1, source: 'unknown', reason: 'repository-fixture', sdkValues: null,
      attempts: null, attemptsComplete: false, costSource: null, updatedAt: stamp };
    const cleanup = { version: 1 as const, stopped: false, stopReason: null, errors: [], lateObservationRequired: false };
    const expectation = (snapshot: WorkspaceSnapshot) => ({ revision: snapshot.revision, documentRef: snapshot.documentRef,
      jobId: snapshot.jobId, candidateRef: snapshot.candidateRef, sessionId: session.sessionId });
    const first = required(store.runs.createWorkspaceAgent({ sessionId: session.sessionId, expected: expectation(workspace),
      goalMode: 'save-candidate', text: 'Save a review candidate.', messageTimestamp: 1, goal: task.job.goal, config,
      usage, cleanup, createdAt: stamp }));
    const frozenConfig = { ...config, goalMode: 'save-candidate' as const, workspaceContext: first.workspaceContext };
    required(store.runs.start(first.runId, frozenConfig, stamp));
    const missing = () => ({ raw: null, normalized: null, state: 'missing' as const, alternatives: [], sources: [] });
    const candidate: CandidateDraft = { fields: { invoiceNumber: missing(), issueDate: missing(), sellerName: missing(),
      sellerTaxId: missing(), buyerName: missing(), buyerTaxId: missing(), currency: missing(), netAmount: missing(),
      taxAmount: missing(), totalAmount: { raw: '113.00', normalized: '113.00', state: 'present', alternatives: [],
        sources: [{ documentId: 1, version: 'v1', artifactId: 2, page: 1, blockId: 'b1', quote: 'Total 113.00' }] } },
      lines: [], notes: ['Saved through the authorized tool.'] };
    const issues: InvoiceIssue[] = [{ code: 'missing_invoice_number', severity: 'warning', origin: 'model',
      fieldPaths: ['/fields/invoiceNumber'], message: 'Invoice number was not present in the material.', rule: null }];
    const argumentsValue = { documentId: 1, candidate };
    const call = required(store.toolCalls.request({ runId: first.runId, sessionId: session.sessionId, nativeToolCallId: 'save-selected-1',
      toolName: 'save_invoice_candidate', toolVersion: '1', effect: 'LOCAL_WRITE', rawArguments: argumentsValue, requestedAt: stamp }));
    required(store.toolCalls.fixArguments({ toolCallId: call.toolCallId, finalArguments: argumentsValue }));
    required(store.toolCalls.start({ toolCallId: call.toolCallId, startedAt: stamp }));
    const saved = required(store.candidates.save({ runId: first.runId, sessionId: session.sessionId, nativeToolCallId: 'save-selected-1',
      documentId: 1, candidate, checks: [], issues, at: stamp }));
    required(store.toolCalls.finish({ toolCallId: call.toolCallId,
      result: { version: 1, committedCandidateId: saved.receipt.candidateId, status: 'succeeded', data: saved.receipt },
      cleanup: { version: 1, stopped: true, stopReason: 'tool-completed', errors: [] }, endedAt: stamp, stoppedAt: stamp }));
    required(store.runs.finish(first.runId, { status: 'completed', output: { version: 1, text: 'Candidate saved.', partial: false,
      stopReason: 'stop', responseId: null, responseModel: 'offline', agent: { nativeSessionId: session.nativeSessionId, turnCount: 1, modelCallCount: 1 } },
      error: null, usage, tokens: { inputTokens: null, outputTokens: null, totalTokens: null, cost: null, usageComplete: false },
      cleanup: { ...cleanup, stopped: true, stopReason: 'native-stop' }, endedAt: stamp, stoppedAt: stamp, durationMs: 0 }));
    expect(store.runs.createWorkspaceAgent({ sessionId: session.sessionId, expected: expectation(workspace), goalMode: 'fill-form',
      formTarget: { formInstanceId: 'not-selected', expectedRevision: 0 }, text: 'Fill.', messageTimestamp: 2,
      goal: task.job.goal, config, usage, cleanup, createdAt: stamp }))
      .toMatchObject({ ok: false, error: { code: 'state_conflict' } });
    const selected = required(store.workspace.selectCandidate({ jobId: task.job.jobId, candidateId: saved.receipt.candidateId,
      expectedCandidateId: null, expectedRevision: workspace.revision, at: stamp }));
    const nextRequest = { sessionId: session.sessionId, expected: expectation(selected.workspace),
      goalMode: 'answer' as const, text: 'Explain the selected total.', messageTimestamp: 2, goal: task.job.goal, config, usage, cleanup, createdAt: stamp };
    const target = { formInstanceId: 'form-admission', expectedRevision: 0 };
    expect(store.runs.createWorkspaceAgent({ ...nextRequest, formTarget: target }))
      .toMatchObject({ ok: false, error: { code: 'input_invalid' } });
    expect(store.runs.createWorkspaceAgent({ ...nextRequest, goalMode: 'fill-form' }))
      .toMatchObject({ ok: false, error: { code: 'input_invalid' } });
    expect(store.runs.createWorkspaceAgent({ ...nextRequest, goalMode: 'fill-form', formTarget: { ...target, expectedRevision: -1 } }))
      .toMatchObject({ ok: false, error: { code: 'input_invalid' } });
    const next = store.runs.createWorkspaceAgent({ ...nextRequest, goalMode: 'fill-form', formTarget: target,
      nativeTools: { runtimeDir: join(tmpdir(), 'form-admission-runtime'), allowedTools: ['bash', 'read'] } });

    expect(next).toMatchObject({ ok: true, data: { jobId: task.job.jobId,
      workspaceContext: { candidateRef: { id: saved.receipt.candidateId, sequence: saved.receipt.sequence } },
      workspaceInput: { candidate: { id: saved.receipt.candidateId, sequence: saved.receipt.sequence,
        fields: candidate.fields, lines: candidate.lines, issues } } } });
    if (!next.ok) return;
    expect(next.data.scope.allowedTools).toEqual(['fill_invoice_form']);
    expect(next.data.formTarget).toEqual(target);
    const persisted = required(store.runs.get(next.data.runId));
    expect(persisted.config).toMatchObject({ goalMode: 'fill-form', formTarget: target });
    expect(persisted.config).not.toHaveProperty('workingDirectory');
    expect(next.data.workspaceContext).not.toHaveProperty('formTarget');
    expect(next.data.workspaceInput).not.toHaveProperty('formTarget');
    store.db.query("UPDATE invoice_candidates SET status='rejected' WHERE id=?").run(saved.receipt.candidateId);
    expect(store.runs.createWorkspaceAgent({ ...nextRequest, goalMode: 'fill-form', formTarget: target }))
      .toMatchObject({ ok: false, error: { code: 'state_conflict' } });
    store.db.query("UPDATE invoice_candidates SET status='generated' WHERE id=?").run(saved.receipt.candidateId);
    expect(required(store.runs.get(next.data.runId)).input).toMatchObject({
      workspaceInput: { candidate: { fields: candidate.fields, lines: candidate.lines, issues } },
    });
    expect(required(store.candidates.readByJob({ jobId: task.job.jobId, candidateId: saved.receipt.candidateId })))
      .toMatchObject({ candidate: { fields: candidate.fields, notes: candidate.notes, issues } });
  });
});

const legacyRunColumns = [
  'id', 'kind', 'session_id', 'scope_json', 'status', 'goal', 'input_json', 'config_json', 'output_json',
  'error_json', 'cleanup_json', 'usage_json', 'input_tokens', 'output_tokens', 'total_tokens', 'cost',
  'duration_ms', 'tool_call_count', 'usage_complete', 'created_at', 'started_at', 'ended_at',
  'cancel_requested_at', 'stopped_at',
].join(',');

function createVersion2Database(paths: ReturnType<typeof makePaths>) {
  mkdirSync(dirname(paths.databaseFile), { recursive: true });
  const db = new Database(paths.databaseFile, { create: true });
  db.exec('PRAGMA foreign_keys=ON; PRAGMA busy_timeout=1000; PRAGMA journal_mode=DELETE; PRAGMA locking_mode=EXCLUSIVE;');
  db.exec(readFileSync(new URL('../../../packages/core/src/storage/migrations/001_provider.sql', import.meta.url), 'utf8'));
  db.exec(readFileSync(new URL('../../../packages/core/src/storage/migrations/002_agent_sessions.sql', import.meta.url), 'utf8'));
  const stamp = '2026-09-28T00:00:00.000Z';
  db.query('INSERT INTO sessions(id,native_session_id,title,created_at,updated_at) VALUES(?,?,?,?,?)')
    .run(7, 'native-session-7', 'Legacy Session', stamp, stamp);
  const insert = db.query(`INSERT INTO runs(
    id,kind,session_id,scope_json,status,goal,input_json,config_json,output_json,error_json,cleanup_json,usage_json,
    input_tokens,output_tokens,total_tokens,cost,duration_ms,tool_call_count,usage_complete,
    created_at,started_at,ended_at,cancel_requested_at,stopped_at
  ) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`);
  const input = JSON.stringify({ version: 1, goal: 'legacy goal', text: 'legacy input', messageTimestamp: 1 });
  const config = JSON.stringify({ version: 1, name: 'legacy', revision: 1, requestedModel: { provider: 'p', model: 'm' },
    resolvedModel: { provider: 'p', model: 'm' }, api: null, endpoint: null, sdk: { codingAgent: '0.85.1', ai: '0.85.1' },
    parameters: { maxRetries: 0, maxRetryDelayMs: 2000 }, limits: { timeoutMs: 60000, stopGraceMs: 5000 },
    native: { authSource: 'pi-native', modelsSelection: null },
    ...(false ? { agent: {} } : {}),
  });
  const cleanup = JSON.stringify({ version: 1, stopped: true, stopReason: 'native-stop', errors: [], lateObservationRequired: false });
  const usage = JSON.stringify({ version: 1, source: 'unknown', reason: 'legacy', sdkValues: null, attempts: 1,
    attemptsComplete: true, costSource: null, updatedAt: stamp });
  const output = JSON.stringify({ version: 1, text: 'completed output', partial: false, stopReason: 'stop', responseId: 'r1', responseModel: 'm' });
  const p2Config = JSON.stringify({ ...JSON.parse(config), agent: {
    policyVersion: 'p2-invoice-chat-v1', nativeSessionId: 'native-session-7', systemPrompt: 'old policy',
    thinkingLevel: 'off', resourcePolicy: 'none', historyPolicy: 'memory-only', maxContextBytes: 524288,
    maxOutputBytes: 262144, maxAssistantContentBytes: 524288, maxModelCalls: 1, sessionRetry: false,
  } });
  const p2Output = JSON.stringify({ ...JSON.parse(output), agent: { nativeSessionId: 'native-session-7', turnCount: 1, modelCallCount: 1 } });
  const scope = JSON.stringify({ version: 1, mode: 'chat-text', toolNames: [], resourcePaths: [] });
  insert.run(31, 'provider', null, null, 'completed', 'provider goal', input, config, output, null, cleanup, usage,
    10, 3, 13, '0.01', 100, 0, 1, stamp, stamp, stamp, null, stamp);
  insert.run(32, 'agent', 7, scope, 'failed', 'agent goal', input, p2Config, p2Output,
    JSON.stringify({ version: 1, code: 'agent_failed', category: 'runtime', message: 'old failure', retryable: false, runId: 32 }),
    JSON.stringify({ version: 1, stopped: false, stopReason: null, errors: [], lateObservationRequired: false }), usage,
    null, null, null, null, null, 0, 0, stamp, stamp, stamp, null, null);
  db.close();
}

function createVersion3InvoiceDatabase(paths: ReturnType<typeof makePaths>) {
  createVersion2Database(paths);
  const db = new Database(paths.databaseFile);
  db.exec('PRAGMA foreign_keys=ON;');
  db.exec(readFileSync(new URL('../../../packages/core/src/storage/migrations/003_invoice_tools.sql', import.meta.url), 'utf8'));
  const stamp = '2026-09-28T00:00:00.000Z';
  db.query(`INSERT INTO artifacts(id,kind,relative_path,bytes,mime_type,metadata_json,created_at) VALUES
    (41,'original','artifacts/41/original.png',1,'image/png','{}',?),
    (42,'parsed','artifacts/42/parsed.json',1,'application/json','{}',?)`).run(stamp, stamp);
  const metadata = JSON.stringify({ version: 1, pageCount: 1, parserConfiguration: 'legacy-private-setting',
    warnings: [], allowedUsesClaim: ['review'], licenseVerification: 'not_verified', unavailableReason: null });
  db.query(`INSERT INTO documents(id,source_key,source_record_id,version,original_artifact_id,parsed_artifact_id,
    parser_name,parser_version,status,metadata_json,created_at,updated_at)
    VALUES (43,'voxel51','legacy-invoice','legacy-v1',41,42,'legacy-parser','1','available',?,?,?)`).run(metadata, stamp, stamp);
  db.query(`INSERT INTO jobs(id,document_id,goal,input_json,status,created_at,updated_at)
    VALUES (44,43,'Review','{}','pending',?,?)`).run(stamp, stamp);
  db.close();
}

describe('P3 invoice storage migration', () => {
  it('removes legacy parser fields while preserving document identity and job references', () => {
    const root = mkdtempSync(join(tmpdir(), 'flowmate-parser-migration-'));
    const paths = makePaths(root);
    createVersion3InvoiceDatabase(paths);
    const opened = openDatabase(paths);
    expect(opened.ok).toBe(true);
    if (!opened.ok) return;
    deferCleanup(() => opened.data.close());
    const db = opened.data.db;
    expect(db.query('SELECT version FROM schema_migrations ORDER BY version').all()).toEqual([
      { version: 1 }, { version: 2 }, { version: 3 }, { version: 4 }, { version: 5 }, { version: 6 }, { version: 7 }, { version: 8 }, { version: 9 }, { version: 10 },
    ]);
    expect((db.query('PRAGMA table_info(documents)').all() as Array<{ name: string }>).map((row) => row.name))
      .not.toContain('parser_name');
    expect((db.query('PRAGMA table_info(documents)').all() as Array<{ name: string }>).map((row) => row.name))
      .not.toContain('parser_version');
    expect(db.query('SELECT id,document_id FROM jobs WHERE id=44').get()).toEqual({ id: 44, document_id: 43 });
    expect(opened.data.documents.get(43)).toMatchObject({ ok: true,
      data: { documentRef: { id: 43, version: 'legacy-v1' }, pageCount: 1, displayName: 'Invoice imported Sep 28, 2026' } });
    expect(opened.data.documents.get(43)).not.toHaveProperty('data.parser');
    const row = db.query('SELECT metadata_json FROM documents WHERE id=43').get() as { metadata_json: string };
    expect(JSON.parse(row.metadata_json)).toEqual({ version: 2, pageCount: 1,
      warnings: [], allowedUsesClaim: ['review'], licenseVerification: 'not_verified', unavailableReason: null });
    expect(db.query('PRAGMA foreign_key_check').all()).toEqual([]);
  });

  it('rolls back migration 004 if a legacy document cannot be updated', () => {
    const root = mkdtempSync(join(tmpdir(), 'flowmate-parser-migration-failure-'));
    const paths = makePaths(root);
    createVersion3InvoiceDatabase(paths);
    const db = new Database(paths.databaseFile);
    db.exec("CREATE TRIGGER reject_004 BEFORE UPDATE ON documents BEGIN SELECT RAISE(ABORT,'blocked'); END;");
    expect(db.query('SELECT COUNT(*) AS count FROM documents').get()).toEqual({ count: 1 });
    expect(() => db.exec('UPDATE documents SET metadata_json=metadata_json WHERE id=43')).toThrow();
    db.close();
    const attempted = openDatabase(paths);
    if (attempted.ok) {
      attempted.data.close();
    }
    expect(attempted).toMatchObject({ ok: false, error: { code: 'storage_open_failed' } });
    const after = new Database(paths.databaseFile);
    expect(after.query('SELECT version FROM schema_migrations ORDER BY version').all()).toEqual([
      { version: 1 }, { version: 2 }, { version: 3 },
    ]);
    expect((after.query('PRAGMA table_info(documents)').all() as Array<{ name: string }>).map((row) => row.name))
      .toContain('parser_name');
    expect((after.query('SELECT metadata_json FROM documents WHERE id=43').get() as { metadata_json: string }).metadata_json)
      .toContain('legacy-private-setting');
    expect(after.query('SELECT id,document_id FROM jobs WHERE id=44').get()).toEqual({ id: 44, document_id: 43 });
    after.close();
  });

  it('rolls back migration 007 when its visibility index cannot be created', () => {
    const root = mkdtempSync(join(tmpdir(), 'flowmate-visibility-migration-failure-'));
    const paths = makePaths(root);
    createVersion3InvoiceDatabase(paths);
    const db = new Database(paths.databaseFile);
    for (const version of ['004_parsed_documents.sql', '005_native_session_history.sql', '006_hidden_processing.sql']) {
      db.exec(readFileSync(new URL(`../../../packages/core/src/storage/migrations/${version}`, import.meta.url), 'utf8'));
    }
    db.exec('CREATE INDEX sessions_visible_recent ON sessions(id);');
    db.close();
    expect(openDatabase(paths)).toMatchObject({ ok: false, error: { code: 'storage_open_failed' } });
    const after = new Database(paths.databaseFile);
    expect(after.query('SELECT version FROM schema_migrations ORDER BY version').all()).toEqual([
      { version: 1 }, { version: 2 }, { version: 3 }, { version: 4 }, { version: 5 }, { version: 6 },
    ]);
    expect((after.query('PRAGMA table_info(sessions)').all() as Array<{ name: string }>).map((row) => row.name)).not.toContain('hidden_at');
    expect((after.query('PRAGMA table_info(documents)').all() as Array<{ name: string }>).map((row) => row.name)).not.toContain('hidden_at');
    expect(after.query('SELECT id FROM documents WHERE id=43').get()).toEqual({ id: 43 });
    expect(after.query('PRAGMA foreign_key_check').all()).toEqual([]);
    after.close();
  });
  it('migrates schema 2 through 10 without changing existing Provider, Agent, or Session facts', () => {
    const root = mkdtempSync(join(tmpdir(), 'flowmate-invoice-migration-'));
    const paths = makePaths(root);
    createVersion2Database(paths);
    const before = new Database(paths.databaseFile);
    const oldRows = before.query(`SELECT ${legacyRunColumns} FROM runs ORDER BY id`).all();
    before.close();

    const opened = openDatabase(paths);
    expect(opened.ok).toBe(true);
    if (!opened.ok) return;
    deferCleanup(() => opened.data.close());
    const db = opened.data.db;
    expect(db.query('SELECT version FROM schema_migrations ORDER BY version').all()).toEqual([
      { version: 1 }, { version: 2 }, { version: 3 }, { version: 4 }, { version: 5 }, { version: 6 }, { version: 7 }, { version: 8 }, { version: 9 }, { version: 10 },
    ]);
    expect((db.query('PRAGMA table_info(documents)').all() as Array<{ name: string }>).map((row) => row.name))
      .not.toContain('parser_name');
    expect(db.query(`SELECT ${legacyRunColumns} FROM runs ORDER BY id`).all()).toEqual(oldRows);
    expect(db.query('SELECT job_id FROM runs ORDER BY id').all()).toEqual([{ job_id: null }, { job_id: null }]);
    expect(db.query('PRAGMA foreign_key_check').all()).toEqual([]);
    expect(db.query("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name").all())
      .toHaveLength(13);
    expect(db.query('PRAGMA table_info(runs)').all()).toHaveLength(25);
    expect(db.query('SELECT metadata_json FROM sessions WHERE id=7').get()).toEqual({
      metadata_json: '{"version":1,"model_use_blocked":null}',
    });
  });

  it('rolls back schema 3 completely when a migration object already exists', () => {
    const root = mkdtempSync(join(tmpdir(), 'flowmate-invoice-migration-failure-'));
    const paths = makePaths(root);
    createVersion2Database(paths);
    const before = new Database(paths.databaseFile);
    before.exec('CREATE TABLE artifacts(id INTEGER PRIMARY KEY);');
    const oldRows = before.query(`SELECT ${legacyRunColumns} FROM runs ORDER BY id`).all();
    before.close();

    expect(openDatabase(paths)).toMatchObject({ ok: false, error: { code: 'storage_open_failed' } });
    const after = new Database(paths.databaseFile);
    expect(after.query('SELECT version FROM schema_migrations ORDER BY version').all()).toEqual([{ version: 1 }, { version: 2 }]);
    expect(after.query(`SELECT ${legacyRunColumns} FROM runs ORDER BY id`).all()).toEqual(oldRows);
    expect(after.query("SELECT name FROM sqlite_master WHERE type='table' AND name='jobs'").get()).toBeNull();
    expect((after.query('PRAGMA table_info(sessions)').all() as Array<{ name: string }>).some((row) => row.name === 'metadata_json')).toBe(false);
    after.close();
  });

  it('registers both Artifacts, the Document, and its Activity as one validated transaction', () => {
    const root = mkdtempSync(join(tmpdir(), 'flowmate-document-repository-'));
    const opened = openDatabase(makePaths(root));
    expect(opened.ok).toBe(true);
    if (!opened.ok) return;
    deferCleanup(() => opened.data.close());
    const metadata = {
      version: 1 as const, sourceKey: 'voxel51', sourceRecordId: 'fixture-1', sourceVersion: 'source-v1',
      files: [{ relativePath: 'original.pdf', bytes: 10, mimeType: 'application/pdf' }],
    };
    const input = {
      documentId: 1, sourceKey: 'voxel51', sourceRecordId: 'fixture-1', version: 'source-v1',
      originalArtifact: { artifactId: 1, kind: 'original' as const, relativePath: 'documents/1/original.pdf', bytes: 10, mimeType: 'application/pdf', metadata, createdAt: '2026-09-28T00:00:00.000Z' },
      parsedArtifact: { artifactId: 2, kind: 'parsed' as const, relativePath: 'documents/1/parsed.json', bytes: 12, mimeType: 'application/json', metadata, createdAt: '2026-09-28T00:00:00.000Z' },
      status: 'available' as const,
      metadata: { version: 2 as const, pageCount: 1, warnings: [], allowedUsesClaim: ['review'], licenseVerification: 'unverified', unavailableReason: null },
      createdAt: '2026-09-28T00:00:00.000Z', updatedAt: '2026-09-28T00:00:00.000Z',
    };
    const registered = opened.data.documents.register(input);
    expect(registered).toMatchObject({ ok: true, data: { documentRef: { id: 1, version: 'source-v1' }, originalArtifactId: 1, parsedArtifactId: 2 } });
    expect(opened.data.documents.findBySource({ sourceKey: 'voxel51', sourceRecordId: 'fixture-1', version: 'source-v1' })).toMatchObject({
      ok: true, data: { documentRef: { id: 1 }, pageCount: 1 },
    });
    expect(opened.data.documents.getArtifact(2)).toMatchObject({ ok: true, data: { kind: 'parsed', bytes: 12 } });
    expect(opened.data.db.query("SELECT type,operation_ref FROM business_events WHERE document_id=1").get()).toEqual({
      type: 'document_imported', operation_ref: 'document:1',
    });
    expect(opened.data.documents.register({ ...input, documentId: 2,
      originalArtifact: { ...input.originalArtifact, artifactId: 3 },
      parsedArtifact: { ...input.parsedArtifact, artifactId: 4 },
    })).toMatchObject({ ok: false, error: { code: 'storage_write_failed' } });
    expect(opened.data.db.query('SELECT COUNT(*) AS count FROM artifacts').get()).toEqual({ count: 2 });
    expect(opened.data.db.query('SELECT COUNT(*) AS count FROM documents').get()).toEqual({ count: 1 });
    expect(opened.data.db.query('SELECT COUNT(*) AS count FROM business_events').get()).toEqual({ count: 1 });

    const initialWorkspace = opened.data.workspace.read('2026-09-28T00:01:00.000Z');
    expect(initialWorkspace).toMatchObject({ ok: true, data: { revision: 0, nextTaskSequence: 1, selection: null } });
    if (!initialWorkspace.ok) return;
    const selectedDocument = opened.data.workspace.update({ expectedRevision: 0, at: '2026-09-28T00:01:01.000Z',
      change: { kind: 'document', documentId: 1 } });
    expect(selectedDocument).toMatchObject({ ok: true, data: { revision: 1, documentRef: { id: 1, version: 'source-v1' } } });
    const startTask = { clientSequence: 1, expectedRevision: 1, documentRef: { id: 1, version: 'source-v1' },
      goal: 'Review this invoice', at: '2026-09-28T00:01:02.000Z' };
    const createdJob = opened.data.jobs.create(startTask);
    expect(createdJob).toMatchObject({ ok: true, data: { job: { jobId: 1, status: 'pending' }, workspace: { jobId: 1, revision: 2 } } });
    expect(opened.data.jobs.queryOperation(1, '2026-09-28T00:01:03.000Z')).toMatchObject({
      ok: true, data: { job: { jobId: 1, goal: 'Review this invoice' }, workspace: { jobId: 1 } },
    });
    expect(opened.data.jobs.create(startTask)).toMatchObject({ ok: true, data: { job: { jobId: 1 }, workspace: { revision: 2 } } });
    expect(opened.data.jobs.create({ ...startTask, goal: 'Different request' })).toMatchObject({
      ok: false, error: { code: 'state_conflict' },
    });
    expect(opened.data.jobs.create({ ...startTask, clientSequence: 2, expectedRevision: 1 })).toMatchObject({
      ok: false, error: { code: 'state_conflict' },
    });
    expect(opened.data.workspace.update({ expectedRevision: 2, at: '2026-09-28T00:01:04.000Z', change: { kind: 'job', jobId: 1 } }))
      .toMatchObject({ ok: true, data: { revision: 2, jobId: 1 } });
    expect(opened.data.db.query('SELECT COUNT(*) AS count FROM jobs').get()).toEqual({ count: 1 });
    const persistedInput = opened.data.db.query('SELECT input_json FROM jobs WHERE id=1').get() as { input_json: string };
    expect(JSON.parse(persistedInput.input_json)).toEqual({ version: 1, clientSequence: 1, expectedRevision: 1,
      documentRef: { id: 1, version: 'source-v1' }, goal: 'Review this invoice' });

    const selectedSession = opened.data.sessions.create({ nativeSessionId: 'selection-session', title: 'Selection', at: '2026-09-28T00:01:05.000Z' });
    expect(selectedSession.ok).toBe(true);
    if (!selectedSession.ok) return;
    const sessionWorkspace = opened.data.workspace.update({ expectedRevision: 2, at: '2026-09-28T00:01:06.000Z',
      change: { kind: 'session', sessionId: selectedSession.data.sessionId } });
    expect(sessionWorkspace).toMatchObject({ ok: true, data: { revision: 3, jobId: 1 } });
    opened.data.db.exec(`
      UPDATE jobs SET status='waiting',status_reason='review_candidate' WHERE id=1;
      INSERT INTO runs(id,kind,session_id,job_id,scope_json,status,goal,input_json,config_json,error_json,cleanup_json,usage_json,
        created_at,started_at,ended_at,stopped_at)
        VALUES (100,'agent',${selectedSession.data.sessionId},1,'{}','failed','review fixture','{}','{}','{}',
          '{"version":1,"stopped":true,"stopReason":"provider-error","errors":[],"lateObservationRequired":false}',
          '{"version":2,"source":"unknown","reason":"fixture","sdkValues":null,"attempts":0,"attemptsComplete":false,
            "costSource":null,"updatedAt":"2026-09-28T00:01:07.000Z","calls":[]}',
          '2026-09-28T00:01:07.000Z','2026-09-28T00:01:07.000Z','2026-09-28T00:01:08.000Z','2026-09-28T00:01:08.000Z');
      INSERT INTO tool_calls(id,run_id,session_id,native_tool_call_id,tool_name,tool_version,effect,args_json,status,result_json,
        delivery_json,cleanup_json,requested_at,started_at,ended_at,stopped_at)
        VALUES (200,100,${selectedSession.data.sessionId},'selection-call','save_invoice_candidate','1','LOCAL_WRITE','{}','succeeded','{}',
          '{"version":1,"state":"request_observed","messageObservedAt":"2026-09-28T00:01:08.000Z","includedInCallSequence":1,
            "requestDispatchedAt":"2026-09-28T00:01:08.000Z","error":null}',
          '{"version":1,"stopReason":"tool-returned","stopped":true,"errors":[]}',
          '2026-09-28T00:01:07.000Z','2026-09-28T00:01:07.000Z','2026-09-28T00:01:08.000Z','2026-09-28T00:01:08.000Z');
      INSERT INTO invoice_candidates(id,job_id,run_id,tool_call_id,sequence,origin,status,fields_json,lines_json,issues_json,created_at)
        VALUES (300,1,100,200,1,'model','generated','{"version":1,"values":{}}','{"version":1,"items":[]}',
          '{"version":1,"notes":[],"checks":[],"items":[]}','2026-09-28T00:01:08.000Z');
    `);
    const selectionRequest = { jobId: 1, candidateId: 300, expectedCandidateId: null, expectedRevision: 3 };
    expect(opened.data.workspace.selectCandidate({ ...selectionRequest, at: '2026-09-28T00:01:09.000Z' }))
      .toMatchObject({ ok: true, data: { jobId: 1, candidateId: 300, workspace: { revision: 4, jobId: 1, candidateRef: { id: 300, sequence: 1 } } } });
    expect(opened.data.workspace.update({ expectedRevision: 4, at: '2026-09-28T00:01:10.000Z', change: { kind: 'view', view: 'parsed' } }))
      .toMatchObject({ ok: true, data: { revision: 5, activeView: 'parsed', candidateRef: { id: 300 } } });
    expect(opened.data.workspace.selectCandidate({ ...selectionRequest, at: '2026-09-28T00:01:11.000Z' }))
      .toMatchObject({ ok: true, data: { workspace: { revision: 5, activeView: 'parsed', candidateRef: { id: 300 } } } });
    expect(opened.data.workspace.selectCandidate({ jobId: 1, candidateId: 300, expectedCandidateId: 300,
      expectedRevision: 5, at: '2026-09-28T00:01:12.000Z' }))
      .toMatchObject({ ok: true, data: { workspace: { revision: 5, candidateRef: { id: 300 } } } });
    expect(opened.data.db.query("SELECT COUNT(*) AS count FROM business_events WHERE type='candidate_selected'").get())
      .toEqual({ count: 1 });
    opened.data.db.query(`INSERT INTO runs(id,kind,session_id,job_id,scope_json,status,goal,input_json,config_json,cleanup_json,usage_json,created_at)
      VALUES (101,'agent',?,1,'{}','created','active fixture','{}','{}','{}','{}','2026-09-28T00:01:12.000Z')`)
      .run(selectedSession.data.sessionId);
    expect(opened.data.jobs.hide(1, '2026-09-28T00:01:12.000Z'))
      .toMatchObject({ ok: false, error: { code: 'run_state_invalid' } });
    expect(opened.data.documents.hide(1, '2026-09-28T00:01:12.000Z'))
      .toMatchObject({ ok: false, error: { code: 'document_busy' } });
    opened.data.db.query('DELETE FROM runs WHERE id=101').run();
    expect(opened.data.jobs.hide(1, '2026-09-28T00:01:13.000Z'))
      .toMatchObject({ ok: true, data: { jobId: 1 } });
    expect(opened.data.jobs.list({ limit: 20 })).toMatchObject({ ok: true, data: { items: [] } });
    expect(opened.data.jobs.get(1)).toMatchObject({ ok: true, data: { jobId: 1 } });
    expect(opened.data.workspace.read('2026-09-28T00:01:14.000Z'))
      .toMatchObject({ ok: true, data: { jobId: null, candidateRef: null, revision: 6 } });
    expect(opened.data.db.query('SELECT COUNT(*) AS count FROM invoice_candidates WHERE job_id=1').get())
      .toEqual({ count: 1 });
    expect(opened.data.db.query('SELECT COUNT(*) AS count FROM business_events WHERE job_id=1').get())
      .toEqual({ count: 2 });
    opened.data.db.exec("CREATE TRIGGER fail_document_hide BEFORE UPDATE OF hidden_at ON documents BEGIN SELECT RAISE(ABORT,'fixture failure'); END;");
    expect(opened.data.documents.hide(1, '2026-09-28T00:01:15.000Z'))
      .toMatchObject({ ok: false, error: { code: 'storage_write_failed' } });
    expect(opened.data.sessions.get(selectedSession.data.sessionId)).toMatchObject({ ok: true, data: { modelUseBlocked: false } });
    expect(opened.data.workspace.read('2026-09-28T00:01:15.000Z'))
      .toMatchObject({ ok: true, data: { documentRef: { id: 1 }, revision: 6 } });
    opened.data.db.exec('DROP TRIGGER fail_document_hide;');
    expect(opened.data.documents.hide(1, '2026-09-28T00:01:16.000Z'))
      .toEqual({ ok: true, data: { documentId: 1, affectedChatCount: 1 } });
    expect(opened.data.documents.hide(1, '2026-09-28T00:01:17.000Z'))
      .toEqual({ ok: true, data: { documentId: 1, affectedChatCount: 0 } });
    expect(opened.data.documents.list({ limit: 10 })).toMatchObject({ ok: true, data: { items: [] } });
    expect(opened.data.documents.get(1)).toMatchObject({ ok: true, data: { isHidden: true } });
    expect(opened.data.sessions.get(selectedSession.data.sessionId)).toMatchObject({ ok: true, data: { modelUseBlocked: true } });
    expect(opened.data.workspace.read('2026-09-28T00:01:18.000Z'))
      .toMatchObject({ ok: true, data: { documentRef: null, jobId: null, revision: 7 } });
    expect(opened.data.workspace.update({ expectedRevision: 7, at: '2026-09-28T00:01:18.000Z',
      change: { kind: 'document', documentId: 1 } })).toMatchObject({ ok: false, error: { code: 'document_not_found' } });
    expect(opened.data.jobs.create({ clientSequence: 2, expectedRevision: 7, documentRef: { id: 1, version: 'source-v1' },
      goal: 'Try again', at: '2026-09-28T00:01:19.000Z' })).toMatchObject({ ok: false, error: { code: 'state_conflict' } });
    expect(opened.data.jobs.get(1)).toMatchObject({ ok: true, data: { jobId: 1 } });
    expect(opened.data.db.query('SELECT COUNT(*) AS count FROM invoice_candidates WHERE job_id=1').get())
      .toEqual({ count: 1 });
    expect(opened.data.documents.unhide(1, '2026-09-28T00:01:20.000Z'))
      .toMatchObject({ ok: true, data: { isHidden: false } });
    expect(opened.data.documents.list({ limit: 10 })).toMatchObject({ ok: true, data: { items: [{ documentRef: { id: 1 } }] } });
    expect(opened.data.sessions.get(selectedSession.data.sessionId)).toMatchObject({ ok: true, data: { modelUseBlocked: true } });
    expect(opened.data.db.query('PRAGMA foreign_key_check').all()).toEqual([]);
  });

  it('repairs interrupted invoice work atomically and preserves business history when deleting Sessions', () => {
    const root = mkdtempSync(join(tmpdir(), 'flowmate-invoice-recovery-'));
    const paths = makePaths(root);
    createVersion2Database(paths);
    const migrated = openDatabase(paths);
    expect(migrated.ok).toBe(true);
    if (!migrated.ok) return;
    migrated.data.close();

    const seed = new Database(paths.databaseFile);
    seed.exec(`
      PRAGMA foreign_keys=ON;
      INSERT INTO artifacts(id,kind,relative_path,bytes,mime_type,metadata_json,created_at)
        VALUES (1,'original','documents/3/original.pdf',10,'application/pdf','{}','2026-09-28T00:00:00.000Z'),
               (2,'parsed','documents/3/parsed.json',10,'application/json','{}','2026-09-28T00:00:00.000Z');
      INSERT INTO documents(id,source_key,source_record_id,version,original_artifact_id,parsed_artifact_id,
        status,metadata_json,created_at,updated_at)
        VALUES (3,'voxel51','fixture','v1',1,2,'available','{}','2026-09-28T00:00:00.000Z','2026-09-28T00:00:00.000Z');
      INSERT INTO jobs(id,document_id,goal,input_json,status,created_at,updated_at)
        VALUES (4,3,'review fixture','{}','running','2026-09-28T00:00:00.000Z','2026-09-28T00:00:00.000Z');
      INSERT INTO runs(id,kind,session_id,job_id,scope_json,status,goal,input_json,config_json,cleanup_json,usage_json,tool_call_count,created_at,started_at)
        VALUES (50,'agent',7,4,'{"version":2,"allowedTools":["save_invoice_candidate"],"allowedDocumentIds":[3],"allowedArtifactIds":[1,2],"allowedResourcePaths":[]}',
          'running','review fixture','{}','{}','{"version":1,"stopped":false,"stopReason":null,"errors":[],"lateObservationRequired":false}',
          '{"version":2,"source":"unknown","reason":"fixture","sdkValues":null,"attempts":0,"attemptsComplete":false,"costSource":null,"updatedAt":"2026-09-28T00:00:00.000Z","calls":[]}',
          1,'2026-09-28T00:00:00.000Z','2026-09-28T00:00:00.000Z');
      INSERT INTO tool_calls(id,run_id,session_id,native_tool_call_id,tool_name,tool_version,effect,args_json,status,
        delivery_json,cleanup_json,requested_at,started_at)
        VALUES (60,50,7,'native-call-60','save_invoice_candidate','1','LOCAL_WRITE','{"version":1,"raw":{},"final":{}}','running',
          '{"version":1,"state":"not_attempted","messageObservedAt":null,"includedInCallSequence":null,"requestDispatchedAt":null,"error":null}',
          '{"version":1,"stopReason":null,"stopped":false,"errors":[]}','2026-09-28T00:00:00.000Z','2026-09-28T00:00:00.000Z');
      INSERT INTO invoice_candidates(id,job_id,run_id,tool_call_id,sequence,origin,status,fields_json,lines_json,issues_json,created_at)
        VALUES (70,4,50,60,1,'model','generated','{}','[]','{}','2026-09-28T00:00:00.000Z');
      INSERT INTO business_events(type,occurred_at,actor_source,operation_ref,document_id,job_id,candidate_id,run_id,result,safe_summary)
        VALUES ('candidate_generated','2026-09-28T00:00:00.000Z','agent','tool-call:native-call-60',3,4,70,50,'succeeded','Candidate generated');
    `);
    seed.query("INSERT INTO sessions(id,native_session_id,title,created_at,updated_at) VALUES (8,'native-session-8','Other','2026-09-28T00:00:00.000Z','2026-09-28T00:00:00.000Z')").run();
    seed.query("INSERT INTO jobs(id,document_id,goal,input_json,status,created_at,updated_at) VALUES (5,3,'other job','{}','pending','2026-09-28T00:00:00.000Z','2026-09-28T00:00:00.000Z')").run();
    expect(() => seed.query(`INSERT INTO tool_calls(id,run_id,session_id,native_tool_call_id,tool_name,args_json,delivery_json,cleanup_json,requested_at)
      VALUES (61,50,8,'wrong-session-call','list_invoice_pages','{}','{}','{}','2026-09-28T00:00:00.000Z')`).run()).toThrow();
    seed.query(`INSERT INTO tool_calls(id,run_id,session_id,native_tool_call_id,tool_name,args_json,delivery_json,cleanup_json,requested_at)
      VALUES (61,50,7,'native-call-61','list_invoice_pages','{}','{}','{}','2026-09-28T00:00:00.000Z')`).run();
    expect(() => seed.query(`INSERT INTO invoice_candidates(id,job_id,run_id,tool_call_id,sequence,origin,fields_json,lines_json,issues_json,created_at)
      VALUES (71,5,50,61,1,'model','{}','[]','{}','2026-09-28T00:00:00.000Z')`).run()).toThrow();
    expect(() => seed.query(`INSERT INTO invoice_candidates(id,job_id,run_id,tool_call_id,sequence,origin,fields_json,lines_json,issues_json,created_at)
      VALUES (72,4,50,60,2,'model','{}','[]','{}','2026-09-28T00:00:00.000Z')`).run()).toThrow();
    expect(() => seed.query(`INSERT INTO business_events(type,occurred_at,actor_source,operation_ref,document_id,job_id,candidate_id,run_id,result,safe_summary)
      VALUES ('candidate_generated','2026-09-28T00:00:00.000Z','agent','tool-call:native-call-60',3,4,70,50,'succeeded','Candidate generated')`).run()).toThrow();
    seed.close();

    const recovered = openDatabase(paths);
    expect(recovered.ok).toBe(true);
    if (!recovered.ok) return;
    let recoveredClosed = false;
    const closeRecovered = () => {
      if (recoveredClosed) return;
      recoveredClosed = true;
      recovered.data.close();
    };
    deferCleanup(closeRecovered);
    const db = recovered.data.db;
    expect(db.query('SELECT status,error_json FROM runs WHERE id=50').get()).toMatchObject({ status: 'failed' });
    expect(db.query('SELECT status,result_json,stopped_at FROM tool_calls WHERE id=60').get()).toMatchObject({
      status: 'failed', stopped_at: null,
      result_json: expect.stringContaining('"committedCandidateId":70'),
    });
    expect(db.query('SELECT status,status_reason FROM jobs WHERE id=4').get()).toMatchObject({ status: 'failed' });
    expect(db.query('SELECT id FROM invoice_candidates WHERE id=70').get()).toEqual({ id: 70 });
    expect(db.query('SELECT id FROM business_events WHERE candidate_id=70').get()).toMatchObject({ id: expect.any(Number) });
    const nativeHistory = { storageVersion: 1 as const,
      header: { type: 'session' as const, version: 3, id: 'native-session-7', timestamp: '2026-09-28T00:00:00.000Z', cwd: paths.runtimeDir },
      entries: [], leafId: null, unusable: false };
    expect(recovered.data.sessions.saveHistory(7, nativeHistory)).toEqual({ ok: true, data: undefined });
    expect(recovered.data.sessions.prepareDelete(7, '2026-09-28T00:01:00.000Z').ok).toBe(true);
    expect(recovered.data.sessions.delete(7, '2026-09-28T00:01:00.000Z')).toEqual({ ok: true, data: 'hidden' });
    expect(recovered.data.sessions.list({ limit: 10 })).toMatchObject({ ok: true, data: { items: [{ sessionId: 8 }] } });
    expect(recovered.data.sessions.get(7)).toMatchObject({ ok: true, data: { status: 'archived', hasBusinessHistory: true } });
    expect(recovered.data.sessions.loadHistory(7)).toEqual({ ok: true, data: nativeHistory });
    expect(db.query('SELECT session_id,job_id FROM runs WHERE id=50').get()).toEqual({ session_id: 7, job_id: 4 });
    expect(db.query('SELECT id FROM invoice_candidates WHERE id=70').get()).toEqual({ id: 70 });

    const emptySession = recovered.data.sessions.create({ nativeSessionId: 'native-empty', title: 'Empty', at: '2026-09-28T00:02:00.000Z' });
    expect(emptySession.ok).toBe(true);
    if (!emptySession.ok) return;
    db.query(`INSERT INTO workspace(id,active_session_id,created_at,updated_at,revision)
      VALUES (1,?,'2026-09-28T00:02:00.000Z','2026-09-28T00:02:00.000Z',4)`).run(emptySession.data.sessionId);
    expect(recovered.data.sessions.prepareDelete(emptySession.data.sessionId, '2026-09-28T00:03:00.000Z').ok).toBe(true);
    expect(recovered.data.sessions.delete(emptySession.data.sessionId, '2026-09-28T00:04:00.000Z')).toEqual({ ok: true, data: 'permanent' });
    expect(db.query('SELECT active_session_id,revision FROM workspace WHERE id=1').get()).toEqual({ active_session_id: null, revision: 5 });
    const terminalBefore = db.query('SELECT status,ended_at,result_json,stopped_at FROM tool_calls WHERE id=60').get();
    closeRecovered();
    const secondOpen = openDatabase(paths);
    expect(secondOpen.ok).toBe(true);
    let secondOpenClosed = false;
    const closeSecondOpen = () => {
      if (!secondOpen.ok || secondOpenClosed) return;
      secondOpenClosed = true;
      secondOpen.data.close();
    };
    deferCleanup(closeSecondOpen);
    if (secondOpen.ok) {
      expect(secondOpen.data.db.query('SELECT status,ended_at,result_json,stopped_at FROM tool_calls WHERE id=60').get()).toEqual(terminalBefore);
      expect(secondOpen.data.sessions.list({ limit: 10 })).toMatchObject({ ok: true, data: { items: [{ sessionId: 8 }] } });
      expect(secondOpen.data.sessions.loadHistory(7)).toEqual({ ok: true, data: nativeHistory });
    }
    closeSecondOpen();

    const interrupted = new Database(paths.databaseFile);
    interrupted.exec(`
      UPDATE jobs SET status='running',status_reason=NULL WHERE id=4;
      INSERT INTO runs(id,kind,session_id,job_id,scope_json,status,goal,input_json,config_json,cleanup_json,usage_json,tool_call_count,created_at,started_at)
        VALUES (51,'agent',7,4,'{"version":2,"allowedTools":["list_invoice_pages"],"allowedDocumentIds":[3],"allowedArtifactIds":[1,2],"allowedResourcePaths":[]}',
          'running','review fixture','{}','{}','{"version":1,"stopped":false,"stopReason":null,"errors":[],"lateObservationRequired":false}',
          '{"version":2,"source":"unknown","reason":"fixture","sdkValues":null,"attempts":0,"attemptsComplete":false,"costSource":null,"updatedAt":"2026-09-28T00:00:00.000Z","calls":[]}',
          1,'2026-09-28T00:00:00.000Z','2026-09-28T00:00:00.000Z');
      INSERT INTO tool_calls(id,run_id,session_id,native_tool_call_id,tool_name,tool_version,effect,args_json,status,delivery_json,cleanup_json,requested_at,started_at)
        VALUES (62,51,7,'native-call-62','list_invoice_pages','1','READ','{"version":1,"raw":{},"final":{}}','running',
          '{"version":1,"state":"not_attempted","messageObservedAt":null,"includedInCallSequence":null,"requestDispatchedAt":null,"error":null}',
          '{"version":1,"stopReason":null,"stopped":false,"errors":[]}','2026-09-28T00:00:00.000Z','2026-09-28T00:00:00.000Z');
      CREATE TRIGGER fail_tool_call_recovery BEFORE UPDATE ON tool_calls WHEN OLD.id=62
        BEGIN SELECT RAISE(ABORT,'fixture recovery failure'); END;
    `);
    interrupted.close();
    expect(openDatabase(paths)).toMatchObject({ ok: false, error: { code: 'storage_open_failed' } });
    const afterFailedRecovery = new Database(paths.databaseFile);
    expect(afterFailedRecovery.query('SELECT status FROM runs WHERE id=51').get()).toEqual({ status: 'running' });
    expect(afterFailedRecovery.query('SELECT status FROM jobs WHERE id=4').get()).toEqual({ status: 'running' });
    expect(afterFailedRecovery.query('SELECT status FROM tool_calls WHERE id=62').get()).toEqual({ status: 'running' });
    afterFailedRecovery.exec('DROP TRIGGER fail_tool_call_recovery;');
    afterFailedRecovery.close();
    const recoveredAgain = openDatabase(paths);
    expect(recoveredAgain.ok).toBe(true);
    if (recoveredAgain.ok) {
      deferCleanup(() => recoveredAgain.data.close());
      expect(recoveredAgain.data.db.query('SELECT status FROM runs WHERE id=51').get()).toEqual({ status: 'failed' });
      expect(recoveredAgain.data.db.query('SELECT status FROM jobs WHERE id=4').get()).toEqual({ status: 'failed' });
      expect(recoveredAgain.data.db.query('SELECT status FROM tool_calls WHERE id=62').get()).toEqual({ status: 'failed' });
    }
  });
});
