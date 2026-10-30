import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { Database } from 'bun:sqlite';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { P3AgentConfigFacts, Result, SafeConfigSnapshot, UsageRecord } from '@flowmate/contracts';
import { deferCleanup, mkdtempSync } from './resources.ts';
import { openTestDatabase as openDatabase } from './database.ts';
import { createCandidateRepository, createDocumentRepository, createJobRepository, createRunRepository,
  createSessionRepository, createToolCallRepository, createWorkspaceRepository } from '../../packages/core/src/storage/repositories.ts';
import { createTestWorkspaceVerifier } from './workspace.ts';
import { createSessionInputLedger } from '../../packages/core/src/sessions/input-ledger.ts';

function paths(root: string) {
  return { root, databaseFile: join(root, 'data', 'flowmate.sqlite'), logsDir: join(root, 'logs'),
    artifactsDir: join(root, 'artifacts'), outputsDir: join(root, 'outputs'), runtimeDir: join(root, 'runtime') };
}
function missingField() {
  return { raw: null, normalized: null, state: 'missing' as const, alternatives: [], sources: [] };
}

function required<T>(result: Result<T>): T {
  if (!result.ok) throw new Error(`${result.error.code}: ${result.error.message}`);
  return result.data;
}
function legacyStore(input: ReturnType<typeof paths>) {
  mkdirSync(join(input.root, 'data'), { recursive: true });
  const db = new Database(input.databaseFile, { create: true });
  db.exec('PRAGMA foreign_keys=ON');
  const migrations = ['001_provider', '002_agent_sessions', '003_invoice_tools', '004_parsed_documents',
    '005_native_session_history', '006_hidden_processing', '007_hidden_chats_invoices', '008_native_entry_runs', '009_session_inputs'];
  for (const name of migrations) {
    const sql = readFileSync(new URL(`../../packages/core/src/storage/migrations/${name}.sql`, import.meta.url), 'utf8');
    for (const statement of sql.split(';').map(item => item.trim()).filter(Boolean)) db.exec(statement);
    if (name === '004_parsed_documents') db.exec('COMMIT');
  }
  db.exec('CREATE TEMP TABLE managed_file_contents(owner_kind TEXT,owner_id TEXT,relative_path TEXT,content BLOB,PRIMARY KEY(owner_kind,owner_id,relative_path))');
  let closed = false;
  return { db, candidates: createCandidateRepository(db), documents: createDocumentRepository(db), jobs: createJobRepository(db),
    runs: createRunRepository(db), sessions: createSessionRepository(db), sessionInputs: createSessionInputLedger(db), toolCalls: createToolCallRepository(db),
    workspace: createWorkspaceRepository(db), close: () => { if (!closed) { db.close(); closed = true; } } };
}
export function makeSelectedCandidate(schema9 = false, withSource = false) {
  const root = mkdtempSync(join(tmpdir(), 'flowmate-form-call-'));
  const currentStore = schema9 ? null : required(openDatabase(paths(root)));
  const store = currentStore ?? legacyStore(paths(root));
  deferCleanup(() => store.close());
  const stamp = '2026-10-01T00:00:00.000Z';
  const originalBytes = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Y9Zl1sAAAAASUVORK5CYII=', 'base64');
  const metadata = { version: 1 as const, sourceKey: 'synthetic', sourceRecordId: 'form-invoice', sourceVersion: 'v1',
    files: [{ relativePath: 'original.png', bytes: originalBytes.byteLength, mimeType: 'image/png' }] };
  const parsedBytes = Buffer.from(JSON.stringify({ formatVersion: 2, pages: [{ page: 1, blocks: [{ id: 'b1', kind: 'text',
    text: 'Total 113.00', sourceIndex: 0, sourceType: 'synthetic', bbox: null }] }],
    completeness: { status: 'complete', checks: [], warnings: [] } }));
  mkdirSync(join(root,'artifacts','2'), { recursive: true });
  mkdirSync(join(root,'artifacts','1'), { recursive: true });
  writeFileSync(join(root,'artifacts','1','original.png'), originalBytes);
  writeFileSync(join(root,'artifacts','2','parsed.json'), parsedBytes);
  store.documents.contents!.remember({ ownerKind: 'artifact', ownerId: '1', relativePath: 'original.png' }, originalBytes);
  store.documents.contents!.remember({ ownerKind: 'artifact', ownerId: '2', relativePath: 'parsed.json' }, parsedBytes);
  required(store.documents.register({ documentId: 1, sourceKey: 'synthetic', sourceRecordId: 'form-invoice', version: 'v1',
    originalArtifact: { artifactId: 1, kind: 'original', relativePath: 'artifacts/1/original.png', bytes: originalBytes.byteLength,
      mimeType: 'image/png', metadata, createdAt: stamp },
    parsedArtifact: { artifactId: 2, kind: 'parsed', relativePath: 'artifacts/2/parsed.json', bytes: parsedBytes.byteLength,
      mimeType: 'application/json', metadata: { ...metadata, files: [{ relativePath: 'parsed.json', bytes: parsedBytes.byteLength,
        mimeType: 'application/json' }] }, createdAt: stamp },
    status: 'available', metadata: { version: 2, pageCount: 1, warnings: [], allowedUsesClaim: ['synthetic test'],
      licenseVerification: 'not_verified', unavailableReason: null }, createdAt: stamp, updatedAt: stamp }));
  const verify = createTestWorkspaceVerifier(store, root);
  const session = required(store.sessions.create({ nativeSessionId: 'native-form-storage', title: 'Form storage', at: stamp }));
  let workspace = required(store.workspace.read(stamp));
  workspace = required(store.workspace.update({ expectedRevision: workspace.revision,
    change: { kind: 'session', sessionId: session.sessionId }, at: stamp }, verify));
  workspace = required(store.workspace.update({ expectedRevision: workspace.revision,
    change: { kind: 'document', documentId: 1 }, at: stamp }, verify));
  const task = required(store.jobs.create({ clientSequence: 1, expectedRevision: workspace.revision,
    documentRef: { id: 1, version: 'v1' }, goal: 'Review form fixture', at: stamp }));
  workspace = task.workspace;
  const agent: P3AgentConfigFacts = { policyVersion: 'p3-invoice-tools-v1', nativeSessionId: session.nativeSessionId,
    systemPrompt: 'Form storage fixture.', thinkingLevel: 'off', resourcePolicy: 'none', historyPolicy: 'memory-only',
    maxContextBytes: 8_388_608, maxOutputBytes: 262_144, maxAssistantContentBytes: 524_288, maxModelCalls: 12,
    maxToolCalls: 24, toolTimeoutMs: 10_000, sessionRetry: false };
  const config: SafeConfigSnapshot & { agent: P3AgentConfigFacts } = { version: 1, name: 'fixture', revision: 1,
    requestedModel: { provider: 'fixture', model: 'offline' }, resolvedModel: { provider: 'fixture', model: 'offline' },
    api: null, endpoint: null, sdk: { codingAgent: '0.85.1', ai: '0.85.1' }, parameters: { maxRetries: 0, maxRetryDelayMs: 100 },
    limits: { timeoutMs: 60_000, stopGraceMs: 5_000 }, native: { authSource: 'unknown', modelsSelection: null }, agent };
  const usage: UsageRecord = { version: 1, source: 'unknown', reason: 'form-storage-fixture', sdkValues: null,
    attempts: null, attemptsComplete: false, costSource: null, updatedAt: stamp };
  const cleanup = { version: 1 as const, stopped: false, stopReason: null, errors: [], lateObservationRequired: false };
  const first = required(store.runs.createWorkspaceAgent({ sessionId: session.sessionId,
    expected: { revision: workspace.revision, documentRef: workspace.documentRef, jobId: workspace.jobId,
      candidateRef: workspace.candidateRef, sessionId: session.sessionId }, goalMode: 'save-candidate',
    text: 'Save fixture candidate.', messageTimestamp: 1, goal: task.job.goal, config, usage, cleanup, createdAt: stamp }, verify));
  const firstConfig = { ...config, goalMode: 'save-candidate' as const, workspaceContext: first.workspaceContext };
  required(store.runs.start(first.runId, firstConfig, stamp));
  const candidate = { fields: { invoiceNumber: missingField(), issueDate: missingField(), sellerName: missingField(),
    sellerTaxId: missingField(), buyerName: missingField(), buyerTaxId: missingField(), currency: missingField(),
    netAmount: missingField(), taxAmount: missingField(), totalAmount: withSource ? { raw: '113.00', normalized: '113.00',
      state: 'present' as const, alternatives: [], sources: [{ documentId: 1, version: 'v1', artifactId: 2, page: 1,
        blockId: 'b1', quote: 'Total 113.00' }] } : missingField() }, lines: [], notes: [] };
  const args = { documentId: 1, candidate };
  // Migration-only builder: current writers require 015 columns, while this database is physically schema 9.
  const historical = schema9 ? store.db.transaction(() => {
    const toolCallId = Number(store.db.query(`INSERT INTO tool_calls(run_id,session_id,native_tool_call_id,tool_name,tool_version,effect,
      args_json,status,delivery_json,cleanup_json,requested_at,started_at) VALUES(?,?,'save-form-candidate','save_invoice_candidate','1',
      'LOCAL_WRITE',?,'running',?,?,?,?)`).run(first.runId, session.sessionId, JSON.stringify({ version: 1, raw: args, final: args }),
        JSON.stringify({ version: 1, state: 'not_attempted', messageObservedAt: null, includedInCallSequence: null, requestDispatchedAt: null, error: null }),
        JSON.stringify({ version: 1, stopReason: null, stopped: false, errors: [] }), stamp, stamp).lastInsertRowid);
    store.db.query('UPDATE runs SET tool_call_count=tool_call_count+1 WHERE id=?').run(first.runId);
    const candidateId = Number(store.db.query(`INSERT INTO invoice_candidates(job_id,run_id,tool_call_id,sequence,origin,status,
      fields_json,lines_json,issues_json,created_at) VALUES(?,?,?,1,'model','generated',?,?,?,?)`).run(task.job.jobId, first.runId, toolCallId,
        JSON.stringify({ version: 1, values: candidate.fields }), JSON.stringify({ version: 1, items: candidate.lines }),
        JSON.stringify({ version: 1, notes: candidate.notes, checks: [], items: [] }), stamp).lastInsertRowid);
    store.db.query(`INSERT INTO business_events(type,occurred_at,actor_source,operation_ref,document_id,job_id,candidate_id,run_id,result,safe_summary)
      VALUES('candidate_generated',?,'agent',?,1,?,?,?,'succeeded','Invoice candidate generated')`)
      .run(stamp, `tool-call-id:${toolCallId}`, task.job.jobId, candidateId, first.runId);
    return { toolCallId, receipt: { candidateId, jobId: task.job.jobId, sequence: 1, issueCount: 0, checks: [] } };
  })() : null;
  const saveCall = historical ?? required(store.toolCalls.request({ context: null, runId: first.runId, sessionId: session.sessionId, nativeToolCallId: 'save-form-candidate',
    toolName: 'save_invoice_candidate', toolVersion: '1', effect: 'LOCAL_WRITE', rawArguments: args, requestedAt: stamp }));
  if (!schema9) {
    required(store.toolCalls.fixArguments({ toolCallId: saveCall.toolCallId, finalArguments: args }));
    required(store.toolCalls.start({ toolCallId: saveCall.toolCallId, startedAt: stamp }));
  }
  const saved = historical ?? required(store.candidates.save({ runId: first.runId, sessionId: session.sessionId, nativeToolCallId: 'save-form-candidate',
    documentId: 1, candidate, checks: [], issues: [], at: stamp }));
  const terminal: Parameters<typeof store.toolCalls.finish>[0] = { toolCallId: saveCall.toolCallId,
    result: { version: 1, committedCandidateId: saved.receipt.candidateId, status: 'succeeded', data: saved.receipt },
    cleanup: { version: 1, stopped: true, stopReason: 'tool-completed', errors: [] }, endedAt: stamp, stoppedAt: stamp };
  if (schema9) {
    // Seed historical bytes without calling the current Repository against a pre-012 schema.
    const changed = store.db.query(`UPDATE tool_calls SET status=?,result_json=?,cleanup_json=?,ended_at=?,stopped_at=?
      WHERE id=? AND status='running'`).run(terminal.result.status, JSON.stringify(terminal.result), JSON.stringify(terminal.cleanup),
      terminal.endedAt, terminal.stoppedAt, terminal.toolCallId).changes;
    if (changed !== 1) throw new Error('schema9_tool_terminal_fixture_failed');
  } else required(store.toolCalls.finish(terminal));
  required(store.runs.finish(first.runId, { status: 'completed', output: { version: 1, text: 'Saved.', partial: false,
    stopReason: 'stop', responseId: null, responseModel: 'offline', agent: { nativeSessionId: session.nativeSessionId, turnCount: 1, modelCallCount: 1 } },
    error: null, usage, tokens: { inputTokens: null, outputTokens: null, totalTokens: null, cost: null, usageComplete: false },
    cleanup: { ...cleanup, stopped: true, stopReason: 'native-stop' }, endedAt: stamp, stoppedAt: stamp, durationMs: 0 }));
  const selected = required(store.workspace.selectCandidate({ jobId: task.job.jobId, candidateId: saved.receipt.candidateId,
    expectedCandidateId: null, expectedRevision: workspace.revision, at: stamp })).workspace;
  return { ...store, currentStore, root, verify, stamp, config, usage, cleanup, session, jobId: task.job.jobId, candidateId: saved.receipt.candidateId, runId: first.runId, toolCallId: saveCall.toolCallId, selectedWorkspace: selected };
}

export async function makeCurrentSelectedCandidate(withSource = false) {
  const selected = makeSelectedCandidate(false, withSource);
  await selected.close();
  const database = required(openDatabase(paths(selected.root)));
  deferCleanup(() => database.close());
  return { ...selected, ...database, currentStore: database, verify: createTestWorkspaceVerifier(database, selected.root) };
}
