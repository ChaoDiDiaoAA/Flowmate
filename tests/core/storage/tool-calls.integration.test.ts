import { mkdirSync, mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { prepareTestWorkspaceVerifier } from '../../support/workspace.ts';
import { describe, expect, it } from 'bun:test';
import { Database } from 'bun:sqlite';
import { appError, CandidateDraftSchema, CandidateReceiptSchema, ToolExecutionFailure } from '@flowmate/contracts';
import { z } from 'zod';
import type { InvoiceFormApplicationReceipt, P3AgentConfigFacts, Result, SafeConfigSnapshot, ToolCallDelivery, UsageRecord, ToolRuntimeObservation } from '@flowmate/contracts';
import { deferCleanup } from '../../support/resources.ts';
import { openDatabase } from '../../../packages/core/src/storage/database.ts';
import { createToolRecorder } from '../../../packages/core/src/tools/recorder.ts';
import { createToolExecutor } from '../../../packages/core/src/tools/executor.ts';

function paths(root: string) {
  return { root, databaseFile: join(root, 'data', 'flowmate.sqlite'), logsDir: join(root, 'logs'),
    artifactsDir: join(root, 'artifacts'), outputsDir: join(root, 'outputs'), runtimeDir: join(root, 'runtime') };
}

function makeStore() {
  const opened = openDatabase(paths(mkdtempSync(join(tmpdir(), 'flowmate-tool-calls-'))));
  expect(opened.ok).toBe(true);
  if (!opened.ok) throw new Error(opened.error.code);
  deferCleanup(() => opened.data.close());
  const stamp = '2026-09-28T00:00:00.000Z';
  const session = opened.data.sessions.create({ nativeSessionId: 'native-p3-1', title: 'P3 fixture', at: stamp });
  expect(session.ok).toBe(true);
  if (!session.ok) throw new Error(session.error.code);
  opened.data.db.query(`INSERT INTO runs(kind,session_id,scope_json,status,goal,input_json,config_json,cleanup_json,usage_json,
    created_at,started_at) VALUES ('agent',?,'{"version":2,"allowedTools":[],"allowedDocumentIds":[],"allowedArtifactIds":[],"allowedResourcePaths":[]}',
    'running','fixture','{}','{}','{}','{}',?,?)`).run(session.data.sessionId, stamp, stamp);
  return { ...opened.data, sessionId: session.data.sessionId, runId: 1, stamp };
}

function addRunningInvoiceJob(store: ReturnType<typeof makeStore>) {
  store.db.query(`INSERT INTO artifacts(id,kind,relative_path,bytes,mime_type,metadata_json,created_at) VALUES
    (1,'original','documents/1/original.pdf',1,'application/pdf','{}',?),
    (2,'parsed','documents/1/parsed.json',1,'application/json','{}',?)`).run(store.stamp, store.stamp);
  store.db.query(`INSERT INTO documents(id,source_key,source_record_id,version,original_artifact_id,parsed_artifact_id,
    status,metadata_json,created_at,updated_at) VALUES
    (1,'fixture','doc-1','v1',1,2,'available','{}',?,?)`).run(store.stamp, store.stamp);
  store.db.query(`INSERT INTO jobs(id,document_id,goal,input_json,status,created_at,updated_at) VALUES
    (4,1,'Review','{}','running',?,?)`).run(store.stamp, store.stamp);
  store.db.query(`UPDATE runs SET job_id=4,scope_json=? WHERE id=?`).run(JSON.stringify({ version: 2,
    allowedTools: ['save_invoice_candidate'], allowedDocumentIds: [1], allowedArtifactIds: [1, 2], allowedResourcePaths: [] }), store.runId);
}

function missingField() {
  return { raw: null, normalized: null, state: 'missing' as const, alternatives: [], sources: [] };
}

function required<T>(result: Result<T>): T {
  if (!result.ok) throw new Error(`${result.error.code}: ${result.error.message}`);
  return result.data;
}

const observation: ToolRuntimeObservation = { version: 1, groupKey: 'fixture-read', strategyVersion: 'runtime-v1',
  sampleSource: 'test', beforeOutcome: 'allowed', failureStage: null, diagnosticCode: null,
  afterStructure: 'valid', afterDomain: 'not_applicable', executionDurationMs: 12, timingComplete: true,
  effectiveTimeoutMs: 1000, timeoutSource: 'configured', runDeadlineTruncated: false,
  commit: 'none_confirmed', commitError: null };

function utf8Sized<T>(bytes: number, build: (text: string) => T): T {
  const seed = '票"\n'.repeat(6_000);
  const remaining = bytes - Buffer.byteLength(JSON.stringify(build(seed)), 'utf8');
  if (remaining < 0) throw new Error('Boundary fixture is too small for its multibyte seed.');
  return build(seed + 'x'.repeat(remaining));
}

describe('ToolCall serialized byte boundaries', () => {
  it('counts raw UTF-8 JSON bytes before creating a request or charging its Run', () => {
    const store = makeStore();
    const raw = utf8Sized(262_144, text => ({ text }));
    expect(Buffer.byteLength(JSON.stringify(raw), 'utf8')).toBe(262_144);
    expect(JSON.stringify(raw).length).toBeLessThan(262_144);
    const request = { context: null, runId: store.runId, sessionId: store.sessionId, nativeToolCallId: 'raw-boundary',
      toolName: 'read_fixture', toolVersion: '1', effect: 'READ' as const, rawArguments: raw, requestedAt: store.stamp };
    expect(store.toolCalls.request({ ...request, rawArguments: { text: raw.text + 'x' } }))
      .toMatchObject({ ok: false, error: { code: 'tool_result_too_large' } });
    expect(store.db.query('SELECT COUNT(*) AS count FROM tool_calls').get()).toEqual({ count: 0 });
    expect(store.db.query('SELECT tool_call_count FROM runs WHERE id=?').get(store.runId)).toEqual({ tool_call_count: 0 });
    const saved = required(store.toolCalls.request(request));
    expect(saved.args.raw).toEqual(raw);
    expect(store.toolCalls.request(request)).toEqual({ ok: true, data: saved });
    expect(store.toolCalls.request({ ...request, nativeToolCallId: 'raw-too-large', rawArguments: { text: raw.text + 'x' } }))
      .toMatchObject({ ok: false, error: { code: 'tool_result_too_large' } });
    expect(store.db.query('SELECT COUNT(*) AS count FROM tool_calls').get()).toEqual({ count: 1 });
    expect(store.db.query('SELECT tool_call_count FROM runs WHERE id=?').get(store.runId)).toEqual({ tool_call_count: 1 });
  });

  it('fixes final arguments at 64 KiB and leaves rejected arguments unfixed', () => {
    const store = makeStore();
    const call = required(store.toolCalls.request({ context: null, runId: store.runId, sessionId: store.sessionId,
      nativeToolCallId: 'final-boundary', toolName: 'read_fixture', toolVersion: '1', effect: 'READ',
      rawArguments: {}, requestedAt: store.stamp }));
    const finalArguments = utf8Sized(65_536, text => ({ text }));
    expect(Buffer.byteLength(JSON.stringify(finalArguments), 'utf8')).toBe(65_536);
    expect(JSON.stringify(finalArguments).length).toBeLessThan(65_536);
    expect(store.toolCalls.fixArguments({ toolCallId: call.toolCallId, finalArguments: { text: finalArguments.text + 'x' } }))
      .toMatchObject({ ok: false, error: { code: 'tool_result_too_large' } });
    expect(required(store.toolCalls.getById(call.toolCallId))).toMatchObject({ status: 'requested', args: { raw: {}, final: null } });
    const fixed = required(store.toolCalls.fixArguments({ toolCallId: call.toolCallId, finalArguments }));
    expect(fixed.args.final).toEqual(finalArguments);
    expect(store.toolCalls.fixArguments({ toolCallId: call.toolCallId, finalArguments })).toEqual({ ok: true, data: fixed });
    expect(store.db.query('SELECT tool_call_count FROM runs WHERE id=?').get(store.runId)).toEqual({ tool_call_count: 1 });
  });

  it.each(['finish', 'reject'] as const)('counts the complete %s envelope and preserves open facts when one byte over', mode => {
    const store = makeStore();
    const call = required(store.toolCalls.request({ context: null, runId: store.runId, sessionId: store.sessionId,
      nativeToolCallId: `envelope-${mode}`, toolName: 'read_fixture', toolVersion: '1', effect: 'READ',
      rawArguments: {}, requestedAt: store.stamp }));
    if (mode === 'finish') {
      required(store.toolCalls.fixArguments({ toolCallId: call.toolCallId, finalArguments: {} }));
      required(store.toolCalls.start({ toolCallId: call.toolCallId, startedAt: store.stamp }));
    }
    const result = utf8Sized(262_144, text => mode === 'finish'
      ? { version: 1 as const, status: 'succeeded' as const, data: { text }, committedCandidateId: null }
      : { version: 1 as const, status: 'failed' as const,
        error: appError('tool_invalid_input', 'tool', 'Fixture rejection.'), data: { text }, committedCandidateId: null });
    expect(Buffer.byteLength(JSON.stringify(result), 'utf8')).toBe(262_144);
    expect(Buffer.byteLength(JSON.stringify(result.data), 'utf8')).toBeLessThan(262_144);
    const cleanup = { version: 1 as const, stopReason: 'fixture-completed', stopped: true, errors: [] };
    const facts = { toolCallId: call.toolCallId, cleanup, endedAt: store.stamp,
      runtimeObservation: mode === 'finish' ? observation : { ...observation, beforeOutcome: 'rejected' as const,
        afterStructure: 'not_applicable' as const, executionDurationMs: null, timingComplete: false } };
    const oversized = { ...result, data: { text: result.data.text + 'x' } };
    const denied = mode === 'finish' ? store.toolCalls.finish({ ...facts, result: oversized, stoppedAt: store.stamp })
      : store.toolCalls.reject({ ...facts, result: oversized });
    expect(denied).toMatchObject({ ok: false, error: { code: 'tool_result_too_large' } });
    expect(required(store.toolCalls.getById(call.toolCallId))).toMatchObject({ status: mode === 'finish' ? 'running' : 'requested',
      result: null, runtimeObservation: null, endedAt: null, stoppedAt: null });
    const saved = mode === 'finish' ? store.toolCalls.finish({ ...facts, result, stoppedAt: store.stamp })
      : store.toolCalls.reject({ ...facts, result });
    expect(saved).toMatchObject({ ok: true, data: { result, runtimeObservation: facts.runtimeObservation, endedAt: store.stamp } });
    expect(store.db.query('SELECT COUNT(*) AS count FROM tool_calls').get()).toEqual({ count: 1 });
  });
});

describe('Runtime fixed observations', () => {
  it.each(['throws', 'foreign-receipt', 'terminal-write-fails', 'terminal-event-fails'] as const)('keeps the original candidate commit when execution %s and never repeats its write', async (mode) => {
    const store = makeStore();
    addRunningInvoiceJob(store);
    const candidate = { fields: { invoiceNumber: missingField(), issueDate: missingField(), sellerName: missingField(),
      sellerTaxId: missingField(), buyerName: missingField(), buyerTaxId: missingField(), currency: missingField(),
      netAmount: missingField(), taxAmount: missingField(), totalAmount: missingField() }, lines: [], notes: [] };
    const scope = { version: 2 as const, allowedTools: ['save_invoice_candidate'], allowedDocumentIds: [1], allowedArtifactIds: [1, 2], allowedResourcePaths: [] };
    let executions = 0;
    const recorder = createToolRecorder(store.toolCalls, () => store.stamp);
    const executor = createToolExecutor({ recorder, now: () => store.stamp, definitions: [{ name: 'save_invoice_candidate', version: '1',
      description: 'Commit fault fixture', effect: 'LOCAL_WRITE', executionMode: 'sequential',
      inputSchema: z.object({ documentId: z.number().int(), candidate: CandidateDraftSchema }).strict(), outputSchema: CandidateReceiptSchema,
      execute: async (args, call, context) => {
        executions++;
        const saved = required(store.candidates.save({ runId: context.runId, sessionId: context.sessionId,
          nativeToolCallId: call.nativeToolCallId, documentId: args.documentId, candidate: args.candidate,
          checks: [], issues: [], at: store.stamp }));
        if (mode === 'throws') throw new ToolExecutionFailure(appError('tool_execution_failed', 'tool', 'Failed after commit.'));
        return mode === 'foreign-receipt' ? { ...saved.receipt, jobId: 99 } : saved.receipt;
      },
    }] });
    const context = { runId: 1, sessionId: store.sessionId, nativeToolCallId: 'committed-write', scope, signal: new AbortController().signal };
    if (mode === 'terminal-write-fails') store.db.exec(`CREATE TRIGGER reject_commit_terminal BEFORE UPDATE OF status ON tool_calls
      WHEN NEW.status IN ('succeeded','failed') BEGIN SELECT RAISE(ABORT,'terminal unavailable'); END;`);
    if (mode === 'terminal-event-fails') store.db.exec(`CREATE TRIGGER reject_commit_event BEFORE INSERT ON runtime_events
      WHEN NEW.type IN ('tool_succeeded','tool_failed','tool_cancelled') BEGIN SELECT RAISE(ABORT,'terminal event unavailable'); END;`);
    const executed = await executor.execute('save_invoice_candidate', { documentId: 1, candidate }, context);
    expect(executed).toMatchObject({ fatal: true, result: { status: 'failed', error: {
      code: mode === 'throws' ? 'tool_execution_failed' : mode === 'foreign-receipt' ? 'tool_invalid_output' : 'storage_write_failed',
    } } });
    const original = required(recorder.query({ runId: 1, sessionId: store.sessionId, nativeToolCallId: 'committed-write' }));
    expect(required(recorder.queryCandidateCommit({ toolCallId: original.toolCallId, runId: 1, sessionId: store.sessionId })))
      .toMatchObject({ candidateId: 1, jobId: 4, sequence: 1 });
    expect(original).toMatchObject(mode === 'terminal-write-fails' || mode === 'terminal-event-fails' ? { status: 'running', result: null, runtimeObservation: null }
      : { status: 'failed', result: { committedCandidateId: 1 }, runtimeObservation: { commit: 'committed' } });
    await executor.execute('save_invoice_candidate', { documentId: 1, candidate }, context);
    expect(executions).toBe(1);
    expect(store.db.query('SELECT COUNT(*) AS count FROM invoice_candidates').get()).toEqual({ count: 1 });
    if (mode === 'terminal-event-fails') {
      expect(store.db.query("SELECT COUNT(*) AS count FROM business_events WHERE type='candidate_generated'").get()).toEqual({ count: 1 });
      expect(store.db.query("SELECT COUNT(*) AS count FROM runtime_events WHERE type IN ('tool_succeeded','tool_failed','tool_cancelled')").get()).toEqual({ count: 0 });
      expect(store.db.query("SELECT COUNT(*) AS count FROM tool_calls WHERE tool_name='fill_invoice_form'").get()).toEqual({ count: 0 });
      expect(required(recorder.queryCandidateCommit({ toolCallId: original.toolCallId, runId: 1, sessionId: store.sessionId })))
        .toMatchObject({ candidateId: 1, jobId: 4, sequence: 1 });
    }
  });
  it('migrates an existing database with NULL observations and rolls back failed version registration', () => {
    for (const registrationFails of [false, true]) {
      const root = mkdtempSync(join(tmpdir(), 'flowmate-observation-migration-'));
      mkdirSync(join(root,'data'), {recursive:true});
      const originalDb = new Database(paths(root).databaseFile);
      originalDb.exec('PRAGMA foreign_keys=ON');
      const migrations = ['001_provider','002_agent_sessions','003_invoice_tools','004_parsed_documents','005_native_session_history',
        '006_hidden_processing','007_hidden_chats_invoices','008_native_entry_runs','009_session_inputs','010_human_candidates','011_session_management'];
      for (const [index,name] of migrations.entries()) {
        const sql=readFileSync(new URL(`../../../packages/core/src/storage/migrations/${name}.sql`,import.meta.url),'utf8');
        for (const statement of sql.split(';').map(part=>part.trim()).filter(Boolean)) originalDb.exec(statement);
        if ([4,10,11].includes(index+1)) originalDb.exec('COMMIT');
        originalDb.exec('PRAGMA foreign_keys=ON');
      }
      const stamp = '2026-10-02T00:00:00.000Z';
      originalDb.query("INSERT INTO sessions(id,native_session_id,title,created_at,updated_at) VALUES(1,'observation-migration','Fixture',?,?)").run(stamp,stamp);
      originalDb.query(`INSERT INTO runs(kind,session_id,scope_json,status,goal,input_json,config_json,cleanup_json,usage_json,created_at)
        VALUES ('agent',?,'{"version":2,"allowedTools":[],"allowedDocumentIds":[],"allowedArtifactIds":[],"allowedResourcePaths":[]}',
        'running','fixture','{}','{}','{}','{}',?)`).run(1, stamp);
      originalDb.query(`INSERT INTO tool_calls(id,run_id,session_id,native_tool_call_id,tool_name,args_json,delivery_json,cleanup_json,requested_at)
        VALUES(1,1,1,'old-row','unknown_tool',?,?,?,?)`).run(JSON.stringify({version:1,raw:{},final:null}),
          JSON.stringify({version:1,state:'not_attempted',messageObservedAt:null,includedInCallSequence:null,requestDispatchedAt:null,error:null}),
          JSON.stringify({version:1,stopped:false,stopReason:null,errors:[]}),stamp);
      const call={toolCallId:1};
      if (registrationFails) originalDb.exec(`CREATE TRIGGER reject_migration_registration BEFORE INSERT ON schema_migrations
        WHEN NEW.version=12 BEGIN SELECT RAISE(ABORT,'registration unavailable'); END;`);
      originalDb.close();
      const reopened = openDatabase(paths(root));
      expect(reopened.ok).toBe(!registrationFails);
      const db = reopened.ok ? reopened.data.db : new Database(paths(root).databaseFile);
      deferCleanup(() => reopened.ok ? reopened.data.close() : db.close());
      expect(db.query('SELECT MAX(version) AS version FROM schema_migrations').get()).toEqual({ version: registrationFails ? 11 : 17 });
      const columns = db.query('PRAGMA table_info(tool_calls)').all() as Array<{ name: string }>;
      expect(columns.some(column => column.name === 'runtime_observation_json')).toBe(!registrationFails);
      expect(db.query('SELECT id,native_tool_call_id FROM tool_calls WHERE id=?').get(call.toolCallId))
        .toEqual({ id: call.toolCallId, native_tool_call_id: 'old-row' });
      if (!reopened.ok) continue;
      expect(required(reopened.data.toolCalls.getById(call.toolCallId)).runtimeObservation).toBeNull();
      expect(db.query("SELECT name FROM sqlite_master WHERE type='index' AND name='tool_calls_runtime_observation_recent'").get())
        .toEqual({ name: 'tool_calls_runtime_observation_recent' });
      for (const invalid of ['no-json', '{}', '{"version":2}', '{"version":1.0}', '{"version":"1"}']) {
        expect(() => db.query('UPDATE tool_calls SET runtime_observation_json=? WHERE id=?').run(invalid, call.toolCallId)).toThrow();
      }
      db.query('UPDATE tool_calls SET runtime_observation_json=? WHERE id=?').run('{"version":1}', call.toolCallId);
      expect(reopened.data.toolCalls.getById(call.toolCallId)).toMatchObject({ ok: false, error: { code: 'storage_corrupt' } });
    }
  });
  it('commits terminal and strict observation atomically and preserves them after delivery failure', () => {
    const store = makeStore();
    const call = required(store.toolCalls.request({ context: null, runId: 1, sessionId: store.sessionId, nativeToolCallId: 'atomic-observation',
      toolName: 'read_fixture', toolVersion: '1', effect: 'READ', rawArguments: {}, requestedAt: store.stamp }));
    expect(call.runtimeObservation).toBeNull();
    required(store.toolCalls.fixArguments({ toolCallId: call.toolCallId, finalArguments: {} }));
    required(store.toolCalls.start({ toolCallId: call.toolCallId, startedAt: store.stamp }));
    const facts = { toolCallId: call.toolCallId,
      result: { version: 1 as const, status: 'succeeded' as const, data: {}, committedCandidateId: null },
      cleanup: { version: 1 as const, stopped: true, stopReason: 'settled', errors: [] },
      endedAt: store.stamp, stoppedAt: store.stamp, runtimeObservation: observation };
    expect(store.toolCalls.finish({ ...facts, runtimeObservation: { ...observation, executionDurationMs: -1 } }).ok).toBe(false);
    store.db.exec(`CREATE TRIGGER reject_observation BEFORE UPDATE OF runtime_observation_json ON tool_calls
      WHEN NEW.runtime_observation_json IS NOT NULL BEGIN SELECT RAISE(ABORT,'observation unavailable'); END;`);
    expect(store.toolCalls.finish(facts).ok).toBe(false);
    expect(required(store.toolCalls.getById(call.toolCallId))).toMatchObject({ status: 'running', result: null, runtimeObservation: null });
    store.db.exec('DROP TRIGGER reject_observation');
    expect(required(store.toolCalls.finish(facts)).runtimeObservation).toEqual(observation);
    expect(store.toolCalls.finish(facts).ok).toBe(true);
    expect(store.toolCalls.finish({ ...facts, runtimeObservation: { ...observation, failureStage: 'delivery' } }).ok).toBe(false);
    required(store.toolCalls.recordDelivery({ toolCallId: call.toolCallId, delivery: { version: 1, state: 'failed',
      messageObservedAt: null, includedInCallSequence: null, requestDispatchedAt: null,
      error: appError('delivery_failed', 'runtime', 'Delivery failed.') } }));
    expect(required(store.toolCalls.getById(call.toolCallId)).runtimeObservation).toEqual(observation);
  });

  it('recovers a committed terminal after response loss without generating another end time', () => {
    const store = makeStore();
    const call = required(store.toolCalls.request({ context: null, runId: 1, sessionId: store.sessionId, nativeToolCallId: 'response-loss',
      toolName: 'read_fixture', toolVersion: '1', effect: 'READ', rawArguments: {}, requestedAt: store.stamp }));
    required(store.toolCalls.fixArguments({ toolCallId: call.toolCallId, finalArguments: {} }));
    required(store.toolCalls.start({ toolCallId: call.toolCallId, startedAt: store.stamp }));
    let tick = 0;
    const recorder = createToolRecorder({ ...store.toolCalls, finish(input) {
      const result = store.toolCalls.finish(input);
      if (result.ok) return { ok: false, error: appError('storage_write_failed', 'storage', 'Response lost.') };
      return result;
    } }, () => `2026-10-02T00:00:0${tick++}.000Z`);
    const saved = required(recorder.finish({ toolCallId: call.toolCallId, status: 'succeeded', data: {},
      committedCandidateId: null, cleanup: { version: 1, stopped: true, stopReason: 'settled', errors: [] },
      stoppedAt: store.stamp, runtimeObservation: observation }));
    expect(saved).toMatchObject({ status: 'succeeded', endedAt: '2026-10-02T00:00:00.000Z', runtimeObservation: observation });
    expect(tick).toBe(1);
  });

  it.each(['finish', 'reject'] as const)('recovers the original %s facts when its committed response throws', (operation) => {
    const store = makeStore();
    const call = required(store.toolCalls.request({ context: null, runId: 1, sessionId: store.sessionId, nativeToolCallId: `thrown-${operation}`,
      toolName: 'read_fixture', toolVersion: '1', effect: 'READ', rawArguments: {}, requestedAt: store.stamp }));
    if (operation === 'finish') {
      required(store.toolCalls.fixArguments({ toolCallId: call.toolCallId, finalArguments: {} }));
      required(store.toolCalls.start({ toolCallId: call.toolCallId, startedAt: store.stamp }));
    }
    let saves = 0;
    let ticks = 0;
    const recorder = createToolRecorder({ ...store.toolCalls,
      finish(input) { saves++; required(store.toolCalls.finish(input)); throw new Error('Committed response lost.'); },
      reject(input) { saves++; required(store.toolCalls.reject(input)); throw new Error('Committed response lost.'); },
    }, () => `2026-10-02T00:00:0${ticks++}.000Z`);
    const result = operation === 'finish'
      ? recorder.finish({ toolCallId: call.toolCallId, status: 'succeeded', data: {}, committedCandidateId: null,
        cleanup: { version: 1, stopped: true, stopReason: 'settled', errors: [] }, stoppedAt: store.stamp, runtimeObservation: observation })
      : recorder.reject({ toolCallId: call.toolCallId, error: appError('tool_invalid_input', 'tool', 'SDK rejected.'),
        runtimeObservation: { ...observation, beforeOutcome: 'rejected', failureStage: 'sdk_arguments', diagnosticCode: 'tool_invalid_input',
          afterStructure: 'not_applicable', afterDomain: 'not_applicable', executionDurationMs: null, timingComplete: false,
          effectiveTimeoutMs: null, timeoutSource: null } });
    const saved = required(result);
    expect(saved).toEqual(required(store.toolCalls.getById(call.toolCallId)));
    expect(saved.endedAt).toBe('2026-10-02T00:00:00.000Z');
    expect(saved.status).toBe(operation === 'finish' ? 'succeeded' : 'failed');
    expect(saved.runtimeObservation?.beforeOutcome).toBe(operation === 'finish' ? 'allowed' : 'rejected');
    expect(saves).toBe(1);
    expect(ticks).toBe(1);
    expect(store.db.query('SELECT COUNT(*) AS count FROM tool_calls').get()).toEqual({ count: 1 });
  });

  it.each(['returned', 'thrown'] as const)('keeps terminal response loss unknown when its recovery query is %s', (queryFailure) => {
    const store = makeStore();
    const call = required(store.toolCalls.request({ context: null, runId: 1, sessionId: store.sessionId, nativeToolCallId: `query-${queryFailure}`,
      toolName: 'read_fixture', toolVersion: '1', effect: 'READ', rawArguments: {}, requestedAt: store.stamp }));
    required(store.toolCalls.fixArguments({ toolCallId: call.toolCallId, finalArguments: {} }));
    required(store.toolCalls.start({ toolCallId: call.toolCallId, startedAt: store.stamp }));
    const recorder = createToolRecorder({ ...store.toolCalls,
      finish(input) { required(store.toolCalls.finish(input)); throw new Error('Private transport detail.'); },
      getById() {
        if (queryFailure === 'thrown') throw new Error('Private query detail.');
        return { ok: false, error: appError('storage_corrupt', 'storage', 'Original facts unavailable.') };
      },
    }, () => store.stamp);
    expect(recorder.finish({ toolCallId: call.toolCallId, status: 'succeeded', data: {}, committedCandidateId: null,
      cleanup: { version: 1, stopped: true, stopReason: 'settled', errors: [] }, stoppedAt: store.stamp, runtimeObservation: observation }))
      .toMatchObject({ ok: false, error: { code: 'storage_corrupt', category: 'storage' } });
    expect(required(store.toolCalls.getById(call.toolCallId))).toMatchObject({ status: 'succeeded', runtimeObservation: observation });
  });
});

function makeFormStore(started = true) {
  const root = mkdtempSync(join(tmpdir(), 'flowmate-form-call-'));
  const store = required(openDatabase(paths(root)));
  deferCleanup(() => store.close());
  const stamp = '2026-10-01T00:00:00.000Z';
  const metadata = { version: 1 as const, sourceKey: 'synthetic', sourceRecordId: 'form-invoice', sourceVersion: 'v1',
    files: [{ relativePath: 'fixture.json', bytes: 1, mimeType: 'application/json' }] };
  required(store.documents.register({ documentId: 1, sourceKey: 'synthetic', sourceRecordId: 'form-invoice', version: 'v1',
    originalArtifact: { artifactId: 1, kind: 'original', relativePath: 'artifacts/1/original.pdf', bytes: 1,
      mimeType: 'application/pdf', metadata, createdAt: stamp },
    parsedArtifact: { artifactId: 2, kind: 'parsed', relativePath: 'artifacts/2/parsed.json', bytes: 1,
      mimeType: 'application/json', metadata, createdAt: stamp },
    status: 'available', metadata: { version: 2, pageCount: 1, warnings: [], allowedUsesClaim: ['synthetic test'],
      licenseVerification: 'not_verified', unavailableReason: null }, createdAt: stamp, updatedAt: stamp }));
  const verify = prepareTestWorkspaceVerifier(store);
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
    netAmount: missingField(), taxAmount: missingField(), totalAmount: missingField() }, lines: [], notes: [] };
  const args = { documentId: 1, candidate };
  const saveCall = required(store.toolCalls.request({ context: null, runId: first.runId, sessionId: session.sessionId, nativeToolCallId: 'save-form-candidate',
    toolName: 'save_invoice_candidate', toolVersion: '1', effect: 'LOCAL_WRITE', rawArguments: args, requestedAt: stamp }));
  required(store.toolCalls.fixArguments({ toolCallId: saveCall.toolCallId, finalArguments: args }));
  required(store.toolCalls.start({ toolCallId: saveCall.toolCallId, startedAt: stamp }));
  const saved = required(store.candidates.save({ runId: first.runId, sessionId: session.sessionId, nativeToolCallId: 'save-form-candidate',
    documentId: 1, candidate, checks: [], issues: [], at: stamp }));
  required(store.toolCalls.finish({ toolCallId: saveCall.toolCallId,
    result: { version: 1, committedCandidateId: saved.receipt.candidateId, status: 'succeeded', data: saved.receipt },
    cleanup: { version: 1, stopped: true, stopReason: 'tool-completed', errors: [] }, endedAt: stamp, stoppedAt: stamp }));
  required(store.runs.finish(first.runId, { status: 'completed', output: { version: 1, text: 'Saved.', partial: false,
    stopReason: 'stop', responseId: null, responseModel: 'offline', agent: { nativeSessionId: session.nativeSessionId, turnCount: 1, modelCallCount: 1 } },
    error: null, usage, tokens: { inputTokens: null, outputTokens: null, totalTokens: null, cost: null, usageComplete: false },
    cleanup: { ...cleanup, stopped: true, stopReason: 'native-stop' }, endedAt: stamp, stoppedAt: stamp, durationMs: 0 }));
  const selected = required(store.workspace.selectCandidate({ jobId: task.job.jobId, candidateId: saved.receipt.candidateId,
    expectedCandidateId: null, expectedRevision: workspace.revision, at: stamp })).workspace;
  const target = { formInstanceId: 'form-storage-instance', expectedRevision: 4 };
  // This trusted repository fixture exercises receipt persistence. It does not
  // open a public fill mode or claim that SDK/Renderer application took place.
  const form = required(store.runs.createWorkspaceAgent({ sessionId: session.sessionId,
    expected: { revision: selected.revision, documentRef: selected.documentRef, jobId: selected.jobId,
    candidateRef: selected.candidateRef, sessionId: session.sessionId }, goalMode: 'fill-form', formTarget: target,
    text: 'Store a trusted form receipt.', messageTimestamp: 2, goal: task.job.goal, config, usage, cleanup, createdAt: stamp }, verify));
  const frozenConfig = { ...config, goalMode: 'fill-form' as const, workspaceContext: form.workspaceContext, formTarget: target };
  required(store.runs.start(form.runId, frozenConfig, stamp));
  const call = required(store.toolCalls.request({ context: null, runId: form.runId, sessionId: session.sessionId, nativeToolCallId: 'fill-storage-1',
    toolName: 'fill_invoice_form', toolVersion: '1', effect: 'LOCAL_WRITE', rawArguments: { candidateId: saved.receipt.candidateId }, requestedAt: stamp }));
  required(store.toolCalls.fixArguments({ toolCallId: call.toolCallId, finalArguments: { candidateId: saved.receipt.candidateId } }));
  if (started) required(store.toolCalls.start({ toolCallId: call.toolCallId, startedAt: stamp }));
  const unknown: InvoiceFormApplicationReceipt = { runId: form.runId, toolCallId: call.toolCallId, formInstanceId: target.formInstanceId,
    candidateId: saved.receipt.candidateId, candidateSequence: saved.receipt.sequence, observedAt: stamp, outcome: 'unknown' };
  const applied: InvoiceFormApplicationReceipt = { ...unknown, outcome: 'applied', appliedRevision: target.expectedRevision + 1, appliedAt: stamp };
  return { ...store, root, verify, stamp, runId: form.runId, sessionId: session.sessionId, jobId: task.job.jobId, toolCallId: call.toolCallId, unknown, applied,
    recorder: createToolRecorder(store.toolCalls, () => stamp) };
}

describe('ToolCall form application facts', () => {
  it('derives the fixed apply request from the original call rather than the current Workspace or candidate lifecycle', () => {
    const store = makeFormStore();
    const expected = { operation: 'apply', runId: store.runId, sessionId: store.sessionId, toolCallId: store.toolCallId,
      nativeToolCallId: 'fill-storage-1', documentRef: { id: 1, version: 'v1' }, jobId: store.jobId,
      candidateId: store.applied.candidateId, candidateSequence: store.applied.candidateSequence,
      target: { formInstanceId: store.applied.formInstanceId, expectedRevision: 4 } };
    const first = required(store.toolCalls.readFormApplicationRequest(store.toolCallId));
    expect(first).toMatchObject(expected);
    expect(first.candidate.fields.invoiceNumber.state).toBe('missing');
    const workspace = required(store.workspace.read(store.stamp));
    required(store.workspace.update({ expectedRevision: workspace.revision, change: { kind: 'document', documentId: null }, at: store.stamp }, store.verify));
    store.db.query("UPDATE invoice_candidates SET status='accepted',accepted_at=? WHERE id=?")
      .run(store.stamp, store.applied.candidateId);
    expect(store.toolCalls.readFormApplicationRequest(store.toolCallId)).toEqual({ ok: true, data: first });
    const saveCall = required(store.toolCalls.list({ runId: store.runId - 1, limit: 10 })).items[0]!;
    expect(store.toolCalls.readFormApplicationRequest(saveCall.toolCallId))
      .toMatchObject({ ok: false, error: { code: 'state_conflict' } });
  });

  it('persists a pending observation without inventing a terminal result and merges it at finish', () => {
    const store = makeFormStore();
    const before = required(store.toolCalls.getById(store.toolCallId));
    expect(store.recorder.recordFormApplication({ toolCallId: store.toolCallId, receipt: store.unknown }))
      .toMatchObject({ ok: true, data: { status: 'running', result: null, formApplication: store.unknown } });
    expect(store.db.query('SELECT result_json FROM tool_calls WHERE id=?').get(store.toolCallId)).toEqual({
      result_json: JSON.stringify({ version: 1, formApplication: store.unknown }),
    });
    const core = { version: 1 as const, committedCandidateId: null, status: 'succeeded' as const,
      data: { candidateId: store.applied.candidateId, candidateSequence: store.applied.candidateSequence, applied: true } };
    const finish = { toolCallId: store.toolCallId, result: core,
      cleanup: { version: 1 as const, stopReason: 'tool-completed', stopped: true, errors: [] }, endedAt: store.stamp, stoppedAt: store.stamp };
    expect(store.toolCalls.finish(finish)).toMatchObject({ ok: true, data: { status: 'succeeded',
      result: { ...core, formApplication: store.unknown }, formApplication: store.unknown, delivery: before.delivery } });
    const completed = required(store.toolCalls.recordFormApplication({ toolCallId: store.toolCallId, receipt: store.applied }));
    expect(completed).toMatchObject({ status: 'succeeded', result: { ...core, formApplication: store.applied }, formApplication: store.applied });
    expect(completed.cleanup).toEqual(finish.cleanup);
    expect(completed.delivery).toEqual(before.delivery);
    expect(store.toolCalls.finish(finish)).toEqual({ ok: true, data: completed });
    expect(store.toolCalls.finish({ ...finish, result: { ...core, data: { ...core.data, candidateSequence: 2 } } }))
      .toMatchObject({ ok: false, error: { code: 'state_conflict' } });
    const unrecognizedCoreField = { ...core, unexpected: 'must remain part of the core comparison' };
    expect(store.toolCalls.finish({ ...finish, result: unrecognizedCoreField }))
      .toMatchObject({ ok: false, error: { code: 'state_conflict' } });
    expect(store.toolCalls.finish({ ...finish, endedAt: '2026-10-01T00:00:01.000Z' }))
      .toMatchObject({ ok: false, error: { code: 'state_conflict' } });
  });

  it('preserves applied evidence when receipt or terminal persistence fails', () => {
    const store = makeFormStore();
    required(store.toolCalls.recordFormApplication({ toolCallId: store.toolCallId, receipt: store.unknown }));
    const pending = store.db.query('SELECT * FROM tool_calls WHERE id=?').get(store.toolCallId);
    store.db.exec("CREATE TRIGGER reject_required_form_save BEFORE UPDATE OF result_json ON tool_calls BEGIN SELECT RAISE(ABORT,'required receipt write failed'); END;");
    expect(store.toolCalls.recordFormApplication({ toolCallId: store.toolCallId, receipt: store.applied }))
      .toMatchObject({ ok: false, error: { code: 'storage_write_failed' } });
    expect(store.db.query('SELECT * FROM tool_calls WHERE id=?').get(store.toolCallId)).toEqual(pending);
    store.db.exec('DROP TRIGGER reject_required_form_save;');
    required(store.toolCalls.recordFormApplication({ toolCallId: store.toolCallId, receipt: store.applied }));
    const applied = store.db.query('SELECT * FROM tool_calls WHERE id=?').get(store.toolCallId);
    store.db.exec("CREATE TRIGGER reject_form_terminal BEFORE UPDATE OF status ON tool_calls BEGIN SELECT RAISE(ABORT,'terminal write failed'); END;");
    expect(store.recorder.finish({ toolCallId: store.toolCallId, status: 'succeeded',
      data: { candidateId: store.applied.candidateId, candidateSequence: store.applied.candidateSequence, applied: true },
      committedCandidateId: null, cleanup: { version: 1, stopped: true, stopReason: 'tool-completed', errors: [] }, stoppedAt: store.stamp }))
      .toMatchObject({ ok: false, error: { code: 'storage_write_failed' } });
    expect(store.db.query('SELECT * FROM tool_calls WHERE id=?').get(store.toolCallId)).toEqual(applied);
    expect(store.toolCalls.getById(store.toolCallId)).toMatchObject({ ok: true, data: {
      status: 'running', result: null, formApplication: store.applied,
    } });
  });

  it('deduplicates verified observations and rejects conflicts or foreign identities without changing core facts', () => {
    const store = makeFormStore();
    const first = required(store.toolCalls.recordFormApplication({ toolCallId: store.toolCallId, receipt: store.applied }));
    const original = store.db.query('SELECT * FROM tool_calls WHERE id=?').get(store.toolCallId);
    store.db.exec("CREATE TRIGGER reject_form_rewrite BEFORE UPDATE OF result_json ON tool_calls BEGIN SELECT RAISE(ABORT,'duplicate receipt write'); END;");
    expect(store.toolCalls.recordFormApplication({ toolCallId: store.toolCallId, receipt: store.applied })).toEqual({ ok: true, data: first });
    for (const receipt of [store.unknown,
      { ...store.applied, appliedAt: '2026-10-01T00:00:01.000Z' },
      { ...store.applied, formInstanceId: 'foreign-instance' }, { ...store.applied, runId: store.runId + 1 },
      { ...store.applied, toolCallId: store.toolCallId + 1 }, { ...store.applied, candidateSequence: 2 },
      { ...store.applied, appliedRevision: 9 }]) {
      expect(store.toolCalls.recordFormApplication({ toolCallId: store.toolCallId, receipt }))
        .toMatchObject({ ok: false, error: { code: 'state_conflict' } });
      expect(store.db.query('SELECT * FROM tool_calls WHERE id=?').get(store.toolCallId)).toEqual(original);
    }
  });

  it('rejects invalid receipt structure and unreadable persisted bindings at every ToolCall read', () => {
    const store = makeFormStore();
    expect(store.toolCalls.recordFormApplication({ toolCallId: store.toolCallId,
      receipt: { ...store.unknown, unexpected: 'not allowed' } as InvoiceFormApplicationReceipt }))
      .toMatchObject({ ok: false, error: { code: 'input_invalid' } });
    expect(required(store.toolCalls.getById(store.toolCallId))).not.toHaveProperty('formApplication');
    const conflictingResult = JSON.stringify({ version: 1, committedCandidateId: null, status: 'succeeded', data: {}, formApplication: store.applied });
    store.db.query("UPDATE tool_calls SET status='failed',ended_at=?,result_json=? WHERE id=?")
      .run(store.stamp, conflictingResult, store.toolCallId);
    expect(store.toolCalls.getById(store.toolCallId)).toMatchObject({ ok: false, error: { code: 'storage_corrupt' } });
    store.db.query("UPDATE tool_calls SET status='running',ended_at=NULL,result_json=NULL WHERE id=?").run(store.toolCallId);
    const corrupted = JSON.stringify({ version: 1, formApplication: { ...store.applied, candidateSequence: 2 } });
    store.db.query('UPDATE tool_calls SET result_json=? WHERE id=?').run(corrupted, store.toolCallId);
    expect(store.toolCalls.getById(store.toolCallId)).toMatchObject({ ok: false, error: { code: 'storage_corrupt' } });
    expect(store.toolCalls.get({ runId: store.runId, sessionId: store.sessionId, nativeToolCallId: 'fill-storage-1' }))
      .toMatchObject({ ok: false, error: { code: 'storage_corrupt' } });
    expect(store.toolCalls.list({ runId: store.runId, limit: 10 })).toMatchObject({ ok: false, error: { code: 'storage_corrupt' } });
    expect(store.db.query('SELECT result_json FROM tool_calls WHERE id=?').get(store.toolCallId)).toEqual({ result_json: corrupted });
  });

  it('preserves a not-applied observation when rejecting a call before execution', () => {
    const store = makeFormStore(false);
    const receipt: InvoiceFormApplicationReceipt = { ...store.unknown, outcome: 'not_applied', reason: 'not_dispatched' };
    required(store.toolCalls.recordFormApplication({ toolCallId: store.toolCallId, receipt }));
    expect(store.recorder.reject({ toolCallId: store.toolCallId, error: appError('run_cancelled', 'runtime', 'Stopped before dispatch.') }))
      .toMatchObject({ ok: true, data: { status: 'failed', result: { status: 'failed', formApplication: receipt }, formApplication: receipt } });
  });

  it.each(['pending', 'terminal'] as const)('preserves the %s receipt through interrupted-process recovery', (phase) => {
    const store = makeFormStore();
    required(store.toolCalls.recordFormApplication({ toolCallId: store.toolCallId, receipt: store.applied }));
    if (phase === 'terminal') required(store.recorder.finish({ toolCallId: store.toolCallId, status: 'succeeded',
      data: { candidateId: store.applied.candidateId, candidateSequence: store.applied.candidateSequence, applied: true },
      committedCandidateId: null, cleanup: { version: 1, stopped: true, stopReason: 'tool-completed', errors: [] }, stoppedAt: store.stamp }));
    store.close();
    const reopened = required(openDatabase(paths(store.root)));
    deferCleanup(() => reopened.close());
    expect(reopened.toolCalls.getById(store.toolCallId)).toMatchObject({ ok: true, data: {
      status: phase === 'pending' ? 'failed' : 'succeeded', formApplication: store.applied,
      result: { status: phase === 'pending' ? 'failed' : 'succeeded', formApplication: store.applied },
    } });
  });
});

describe('ToolCall and business event storage', () => {
  it.each(['message_observed', 'request_observed', 'failed', 'unknown'] as const)('does not write an equivalent repeated %s delivery observation', (state) => {
    const store = makeStore();
    const requested = store.toolCalls.request({ context: null, runId: store.runId, sessionId: store.sessionId, nativeToolCallId: 'delivery-idempotent',
      toolName: 'list_invoice_pages', toolVersion: '1', effect: 'READ', rawArguments: {}, requestedAt: store.stamp });
    expect(requested.ok).toBe(true);
    if (!requested.ok) return;
    const toolCallId = requested.data.toolCallId;
    expect(store.toolCalls.fixArguments({ toolCallId, finalArguments: {} }).ok).toBe(true);
    expect(store.toolCalls.start({ toolCallId, startedAt: store.stamp }).ok).toBe(true);
    expect(store.toolCalls.finish({ toolCallId, result: { version: 1, committedCandidateId: null, status: 'succeeded', data: { pages: [] } },
      cleanup: { version: 1, stopReason: 'tool-completed', stopped: true, errors: [] }, endedAt: store.stamp, stoppedAt: store.stamp }).ok).toBe(true);
    const message: ToolCallDelivery = { version: 1, state: 'message_observed', messageObservedAt: store.stamp,
      includedInCallSequence: 2, requestDispatchedAt: null, error: null };
    expect(store.toolCalls.recordDelivery({ toolCallId, delivery: message }).ok).toBe(true);
    const delivery: ToolCallDelivery = { ...message, state, requestDispatchedAt: state === 'request_observed' ? store.stamp : null,
      error: state === 'failed' || state === 'unknown' ? appError('tool_result_delivery_failed', 'runtime', 'Fixture delivery failed.', true) : null };
    const observed = store.toolCalls.recordDelivery({ toolCallId, delivery });
    expect(observed.ok).toBe(true);
    const before = store.db.query('SELECT delivery_json,status,result_json FROM tool_calls WHERE id=?').get(toolCallId);
    store.db.exec("CREATE TRIGGER reject_delivery_rewrite BEFORE UPDATE OF delivery_json ON tool_calls BEGIN SELECT RAISE(ABORT,'duplicate delivery write'); END;");
    const equivalent = { error: delivery.error === null ? null : { retryable: delivery.error.retryable, message: delivery.error.message,
      category: delivery.error.category, code: delivery.error.code }, requestDispatchedAt: delivery.requestDispatchedAt,
      includedInCallSequence: delivery.includedInCallSequence, messageObservedAt: delivery.messageObservedAt, state, version: 1 as const };
    expect(store.toolCalls.recordDelivery({ toolCallId, delivery: equivalent })).toEqual(observed);
    expect(store.db.query('SELECT delivery_json,status,result_json FROM tool_calls WHERE id=?').get(toolCallId)).toEqual(before);
  });

  it.each(['messageObservedAt', 'includedInCallSequence', 'requestDispatchedAt', 'error'] as const)('rejects same-state delivery with conflicting %s and preserves its first fact', (field) => {
    const store = makeStore();
    const requested = store.toolCalls.request({ context: null, runId: store.runId, sessionId: store.sessionId, nativeToolCallId: 'delivery-conflict',
      toolName: 'list_invoice_pages', toolVersion: '1', effect: 'READ', rawArguments: {}, requestedAt: store.stamp });
    expect(requested.ok).toBe(true);
    if (!requested.ok) return;
    const toolCallId = requested.data.toolCallId;
    const message: ToolCallDelivery = { version: 1, state: 'message_observed', messageObservedAt: store.stamp,
      includedInCallSequence: 2, requestDispatchedAt: null, error: null };
    expect(store.toolCalls.recordDelivery({ toolCallId, delivery: message }).ok).toBe(true);
    const observed: ToolCallDelivery = { ...message, state: 'failed', error: appError('tool_result_delivery_failed', 'runtime', 'First failure.', true) };
    expect(store.toolCalls.recordDelivery({ toolCallId, delivery: observed }).ok).toBe(true);
    const before = store.db.query('SELECT delivery_json FROM tool_calls WHERE id=?').get(toolCallId);
    const values = { messageObservedAt: '2026-09-28T00:00:01.000Z', includedInCallSequence: 3,
      requestDispatchedAt: '2026-09-28T00:00:01.000Z', error: { ...observed.error!, message: 'Different failure.' } };
    expect(store.toolCalls.recordDelivery({ toolCallId, delivery: { ...observed, [field]: values[field] } }))
      .toMatchObject({ ok: false, error: { code: 'state_conflict' } });
    expect(store.db.query('SELECT delivery_json FROM tool_calls WHERE id=?').get(toolCallId)).toEqual(before);
    for (const state of ['request_observed', 'unknown'] as const) expect(store.toolCalls.recordDelivery({ toolCallId, delivery: { ...observed, state } }))
      .toMatchObject({ ok: false, error: { code: 'state_conflict' } });
    expect(store.toolCalls.recordDelivery({ toolCallId, delivery: { ...observed, version: 2 as unknown as 1 } }))
      .toMatchObject({ ok: false, error: { code: 'input_invalid' } });
    expect(store.db.query('SELECT delivery_json FROM tool_calls WHERE id=?').get(toolCallId)).toEqual(before);
  });

  it('deduplicates only the same native request and preserves fixed arguments and terminal facts', () => {
    const store = makeStore();
    const request = { context: null, runId: store.runId, sessionId: store.sessionId, nativeToolCallId: 'native-call-1',
      toolName: 'list_invoice_pages', toolVersion: '1', effect: 'READ' as const,
      rawArguments: { documentId: 3, page: null }, requestedAt: store.stamp };
    const created = store.toolCalls.request(request);
    expect(created).toMatchObject({ ok: true, data: { status: 'requested', args: { raw: request.rawArguments, final: null } } });
    if (!created.ok) return;
    expect(store.toolCalls.request(request)).toEqual(created);
    expect(store.toolCalls.request({ ...request, toolName: 'search_invoice_text' })).toMatchObject({
      ok: false, error: { code: 'state_conflict' },
    });
    expect(store.toolCalls.fixArguments({ toolCallId: created.data.toolCallId, finalArguments: { documentId: 3, page: 1 } }))
      .toMatchObject({ ok: true, data: { args: { raw: request.rawArguments, final: { documentId: 3, page: 1 } } } });
    expect(store.toolCalls.start({ toolCallId: created.data.toolCallId, startedAt: store.stamp }))
      .toMatchObject({ ok: true, data: { status: 'running' } });
    const success = { version: 1 as const, committedCandidateId: null, status: 'succeeded' as const, data: { pageCount: 1 } };
    const cleanup = { version: 1 as const, stopReason: 'tool-completed', stopped: true, errors: [] };
    const terminal = store.toolCalls.finish({ toolCallId: created.data.toolCallId, result: success, cleanup,
      endedAt: store.stamp, stoppedAt: store.stamp });
    expect(terminal).toMatchObject({ ok: true, data: { status: 'succeeded', result: success } });
    expect(store.toolCalls.finish({ toolCallId: created.data.toolCallId, result: success, cleanup,
      endedAt: store.stamp, stoppedAt: store.stamp })).toEqual(terminal);
    expect(store.toolCalls.finish({ toolCallId: created.data.toolCallId,
      result: { ...success, data: { pageCount: 2 } }, cleanup, endedAt: store.stamp, stoppedAt: store.stamp }))
      .toMatchObject({ ok: false, error: { code: 'state_conflict' } });
    expect(store.toolCalls.get({ runId: store.runId, sessionId: store.sessionId, nativeToolCallId: 'native-call-1' }))
      .toMatchObject({ ok: true, data: { toolCallId: created.data.toolCallId, runId: store.runId, sessionId: store.sessionId } });
  });

  it('records a failed call, monotonic delivery observations, Run pagination, and job Activity', () => {
    const store = makeStore();
    const first = store.toolCalls.request({ context: null, runId: store.runId, sessionId: store.sessionId, nativeToolCallId: 'native-call-1',
      toolName: 'get_invoice_candidate', toolVersion: '1', effect: 'READ', rawArguments: { jobId: 4 }, requestedAt: store.stamp });
    expect(first.ok).toBe(true);
    if (!first.ok) return;
    const messageSeen = { version: 1 as const, state: 'message_observed' as const, messageObservedAt: store.stamp,
      includedInCallSequence: 2, requestDispatchedAt: null, error: null };
    expect(store.toolCalls.recordDelivery({ toolCallId: first.data.toolCallId, delivery: messageSeen })).toMatchObject({
      ok: true, data: { delivery: { state: 'message_observed' } },
    });
    expect(store.toolCalls.recordDelivery({ toolCallId: first.data.toolCallId,
      delivery: { ...messageSeen, state: 'not_attempted', messageObservedAt: null, includedInCallSequence: null } }))
      .toMatchObject({ ok: false, error: { code: 'state_conflict' } });
    expect(store.toolCalls.fixArguments({ toolCallId: first.data.toolCallId, finalArguments: { jobId: 4 } }).ok).toBe(true);
    expect(store.toolCalls.start({ toolCallId: first.data.toolCallId, startedAt: store.stamp }).ok).toBe(true);
    const failure = { version: 1 as const, committedCandidateId: null, status: 'failed' as const,
      error: appError('document_not_found', 'input', 'Document 不存在。') };
    expect(store.toolCalls.finish({ toolCallId: first.data.toolCallId, result: failure,
      cleanup: { version: 1, stopReason: 'tool-error', stopped: true, errors: [] }, endedAt: store.stamp, stoppedAt: store.stamp }))
      .toMatchObject({ ok: true, data: { status: 'failed', result: failure } });
    const second = store.toolCalls.request({ context: null, runId: store.runId, sessionId: store.sessionId, nativeToolCallId: 'native-call-2',
      toolName: 'list_invoice_pages', toolVersion: '1', effect: 'READ', rawArguments: {}, requestedAt: store.stamp });
    expect(second.ok).toBe(true);
    expect(store.toolCalls.list({ runId: store.runId, limit: 1 })).toMatchObject({ ok: true, data: { items: [{ nativeToolCallId: 'native-call-2' }], nextBeforeId: 2 } });
    expect(store.toolCalls.list({ runId: store.runId, beforeId: 2, limit: 1 })).toMatchObject({ ok: true, data: { items: [{ nativeToolCallId: 'native-call-1' }], nextBeforeId: null } });

    const db = store.db;
    db.query(`INSERT INTO artifacts(id,kind,relative_path,bytes,mime_type,metadata_json,created_at) VALUES
      (1,'original','documents/1/original.pdf',1,'application/pdf','{}',?),
      (2,'parsed','documents/1/parsed.json',1,'application/json','{}',?)`).run(store.stamp, store.stamp);
    db.query(`INSERT INTO documents(id,source_key,source_record_id,version,original_artifact_id,parsed_artifact_id,
      status,metadata_json,created_at,updated_at) VALUES
      (1,'fixture','doc-1','v1',1,2,'available','{}',?,?)`).run(store.stamp, store.stamp);
    db.query(`INSERT INTO jobs(id,document_id,goal,input_json,status,created_at,updated_at) VALUES
      (4,1,'Review','{}','pending',?,?)`).run(store.stamp, store.stamp);
    db.query(`INSERT INTO business_events(type,occurred_at,actor_source,operation_ref,document_id,job_id,result,safe_summary,error_code)
      VALUES ('task_started',?,'user','start:1',1,4,'succeeded','Started fixture',NULL),
             ('candidate_generated',?,'agent','tool-call:native-call-1',1,4,'failed','Candidate rejected','validation_failed'),
             ('candidate_generated',?,'agent','tool-call:native-call-2',1,4,'succeeded','Candidate saved',NULL)`)
      .run(store.stamp, store.stamp, store.stamp);
    expect(store.businessEvents.list({ jobId: 4, limit: 2 })).toMatchObject({
      ok: true, data: { items: [{ operationRef: 'tool-call:native-call-2' }, { operationRef: 'tool-call:native-call-1' }], nextBeforeId: 2 },
    });
    expect(store.businessEvents.list({ documentId: 1, beforeId: 2, limit: 2 })).toMatchObject({
      ok: true, data: { items: [{ operationRef: 'start:1' }], nextBeforeId: null },
    });
    expect(store.businessEvents.getByOperation({ type: 'candidate_generated', operationRef: 'tool-call:native-call-1' }))
      .toMatchObject({ ok: true, data: { result: 'failed', errorCode: 'validation_failed' } });
  });

  it('commits a candidate and its Activity once under the authorized running tool identity', () => {
    const store = makeStore();
    addRunningInvoiceJob(store);
    const candidate = { fields: { invoiceNumber: missingField(), issueDate: missingField(), sellerName: missingField(),
      sellerTaxId: missingField(), buyerName: missingField(), buyerTaxId: missingField(), currency: missingField(),
      netAmount: missingField(), taxAmount: missingField(), totalAmount: missingField() }, lines: [], notes: ['Draft from model'] };
    const args = { documentId: 1, candidate };
    const call = store.toolCalls.request({ context: null, runId: store.runId, sessionId: store.sessionId, nativeToolCallId: 'save-call-1',
      toolName: 'save_invoice_candidate', toolVersion: '1', effect: 'LOCAL_WRITE', rawArguments: args, requestedAt: store.stamp });
    expect(call.ok).toBe(true);
    if (!call.ok) return;
    expect(store.toolCalls.fixArguments({ toolCallId: call.data.toolCallId, finalArguments: args }).ok).toBe(true);
    expect(store.toolCalls.start({ toolCallId: call.data.toolCallId, startedAt: store.stamp }).ok).toBe(true);
    const input = { runId: store.runId, sessionId: store.sessionId, nativeToolCallId: 'save-call-1', documentId: 1, candidate,
      checks: [], issues: [{ code: 'missing_invoice_number', severity: 'warning' as const, origin: 'model' as const,
        fieldPaths: ['/fields/invoiceNumber'], message: 'Invoice number was not present in the supplied material.', rule: null }], at: store.stamp };
    const saved = store.candidates.save(input);
    expect(saved).toMatchObject({ ok: true, data: { created: true, receipt: { candidateId: 1, jobId: 4, sequence: 1, issueCount: 1 } } });
    if (!saved.ok) return;
    expect(store.candidates.save(input)).toMatchObject({ ok: true, data: { created: false, receipt: saved.data.receipt } });
    expect(store.db.query('SELECT COUNT(*) AS count FROM invoice_candidates').get()).toEqual({ count: 1 });
    expect(store.db.query("SELECT COUNT(*) AS count FROM business_events WHERE type='candidate_generated'").get()).toEqual({ count: 1 });
    expect(store.db.query('SELECT current_candidate_id FROM jobs WHERE id=4').get()).toEqual({ current_candidate_id: null });
    expect(store.candidates.listForRun({ runId: store.runId, beforeSequence: null, limit: 10 }))
      .toMatchObject({ ok: true, data: { jobId: 4, candidates: [{ candidateId: 1, sequence: 1, issueCount: 1 }] } });
    expect(store.candidates.readForRun({ runId: store.runId, candidateId: 1 })).toMatchObject({
      ok: true, data: { documentRef: { id: 1, version: 'v1' }, candidate: { notes: ['Draft from model'] } },
    });
    expect(store.candidates.save({ ...input, candidate: { ...candidate, notes: ['Different draft'] } }))
      .toMatchObject({ ok: false, error: { code: 'state_conflict' } });
  });

  it('keeps historical original-evidence ToolCalls readable without making them available to new Runs', () => {
    const store = makeStore();
    store.db.query(`INSERT INTO artifacts(id,kind,relative_path,bytes,mime_type,metadata_json,created_at) VALUES
      (1,'original','documents/1/original.png',1,'image/png','{}',?),
      (2,'parsed','documents/1/parsed.json',1,'application/json','{}',?)`).run(store.stamp, store.stamp);
    store.db.query(`INSERT INTO documents(id,source_key,source_record_id,version,original_artifact_id,parsed_artifact_id,
      status,metadata_json,created_at,updated_at) VALUES
      (1,'fixture','doc-1','v1',1,2,'available','{}',?,?)`).run(store.stamp, store.stamp);
    const source = { documentId: 1, version: 'v1', artifactId: 1, page: 1, blockId: null, quote: null };
    const call = store.toolCalls.request({ context: null, runId: store.runId, sessionId: store.sessionId,
      nativeToolCallId: 'original-evidence-1', toolName: 'read_invoice_evidence', toolVersion: '1', effect: 'READ',
      rawArguments: { documentId: 1, page: 1, kind: 'original', blockId: null }, requestedAt: store.stamp });
    expect(call.ok).toBe(true);
    if (!call.ok) return;
    expect(store.toolCalls.fixArguments({ toolCallId: call.data.toolCallId,
      finalArguments: { documentId: 1, page: 1, kind: 'original', blockId: null } }).ok).toBe(true);
    expect(store.toolCalls.start({ toolCallId: call.data.toolCallId, startedAt: store.stamp }).ok).toBe(true);
    expect(store.toolCalls.finish({ toolCallId: call.data.toolCallId,
      result: { version: 1, committedCandidateId: null, status: 'succeeded',
        data: { kind: 'original', source, mimeType: 'image/png', bytes: 1 } },
      cleanup: { version: 1, stopReason: 'tool-completed', stopped: true, errors: [] },
      endedAt: store.stamp, stoppedAt: store.stamp }).ok).toBe(true);
    expect(store.toolCalls.recordDelivery({ toolCallId: call.data.toolCallId, delivery: { version: 1, state: 'message_observed',
      messageObservedAt: store.stamp, includedInCallSequence: 2, requestDispatchedAt: null, error: null } }).ok).toBe(true);
    expect(store.toolCalls.recordDelivery({ toolCallId: call.data.toolCallId, delivery: { version: 1, state: 'request_observed',
      messageObservedAt: store.stamp, includedInCallSequence: 2, requestDispatchedAt: store.stamp, error: null } }).ok).toBe(true);
    expect(store.toolCalls.get({ runId: store.runId, sessionId: store.sessionId, nativeToolCallId: 'original-evidence-1' }))
      .toMatchObject({ ok: true, data: { result: { status: 'succeeded', data: { kind: 'original', source } },
        delivery: { state: 'request_observed', includedInCallSequence: 2 } } });
  });
});
