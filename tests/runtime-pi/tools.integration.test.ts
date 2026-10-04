import { describe, expect, it } from 'bun:test';
import { validateToolArguments } from '@earendil-works/pi-ai';
import { InMemoryCredentialStore } from '@earendil-works/pi-ai';
import { AgentSession } from '@earendil-works/pi-coding-agent';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { Database } from 'bun:sqlite';
import { appError, fail } from '@flowmate/contracts';
import type { AgentNativeOutcome, AgentRunEvent, AgentToolBinding, Application, NativeSessionHistory, ProviderConfig, Result, ToolCallSnapshot } from '@flowmate/contracts';
import { createApplication } from '../../apps/composition.ts';
import { PiAgentAdapter } from '../../packages/runtime-pi/src/session.ts';
import { openDatabase } from '../../packages/core/src/storage/database.ts';
import { deferCleanup, mkdtempSync } from '../support/resources.ts';
import { CandidateDraftSchema, INVOICE_TOOL_NAMES, invoiceToolSchemas } from '../../packages/contracts/src/invoice.ts';
import { toPiParameters } from '../../packages/runtime-pi/src/schema.ts';
import { z } from 'zod';

const field = { raw: null, normalized: null, state: 'missing', alternatives: [], sources: [] };
const candidate = {
  fields: Object.fromEntries([
    'invoiceNumber', 'issueDate', 'sellerName', 'sellerTaxId', 'buyerName',
    'buyerTaxId', 'currency', 'netAmount', 'taxAmount', 'totalAmount',
  ].map((name) => [name, field])),
  lines: [],
  notes: [],
};

const examples: Record<(typeof INVOICE_TOOL_NAMES)[number], unknown> = {
  list_invoice_pages: { documentId: 1 },
  read_invoice_document: { documentId: 1, page: 1, afterBlockId: null, limit: 10 },
  search_invoice_document: { documentId: 1, query: 'Tax', page: null, afterBlockId: null, limit: 10 },
  list_invoice_tables: { documentId: 1, page: null, afterBlockId: null, limit: 10 },
  read_invoice_evidence: { documentId: 1, page: 1, kind: 'parsed', blockId: 'b1' },
  check_invoice_sources: { documentId: 1, sources: [{ documentId: 1, version: 'v1', artifactId: 2, page: 1, blockId: 'b1', quote: 'Invoice' }] },
  normalize_invoice_values: { items: [{ kind: 'date', raw: '01/02/2026' }] },
  calculate_invoice_amounts: { operation: 'sum', values: ['0.1', '0.2'], scale: 2 },
  validate_invoice_candidate: { documentId: 1, candidate },
  list_invoice_candidates: { beforeSequence: null, limit: 20 },
  get_invoice_candidate: { candidateId: 2 },
  compare_invoice_candidates: { leftCandidateId: 2, rightCandidateId: 3, afterPath: null, limit: 20 },
  save_invoice_candidate: { documentId: 1, candidate },
  fill_invoice_form: { candidateId: 2 },
};

function writeFaultInvoice(directory: string) {
  mkdirSync(directory, { recursive: true });
  const original = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/a54AAAAASUVORK5CYII=', 'base64');
  const content = JSON.stringify([{ type: 'text', text: 'Synthetic invoice total 100.00', bbox: [0, 0, 1, 1], page_idx: 0 }]);
  const pages = JSON.stringify([{ pageNumber: 1, text: 'Synthetic invoice total 100.00', blockCount: 1 }]);
  writeFileSync(join(directory, 'original.png'), original);
  writeFileSync(join(directory, 'content.json'), content);
  writeFileSync(join(directory, 'pages.json'), pages);
  writeFileSync(join(directory, 'metadata.json'), JSON.stringify({ schemaVersion: 1, sampleId: '000001',
    datasetId: 'voxel51-hq-invoice-ocr', sourceRecordId: 'synthetic-p4-fault', datasetRevision: 'p4-fixture', qualityStatus: 'complete',
    allowedUsesClaim: ['local test'], licenseVerification: 'not_verified', files: [{ path: 'original.png', bytes: original.length },
      { path: 'content.json', bytes: Buffer.byteLength(content) }, { path: 'pages.json', bytes: Buffer.byteLength(pages) }] }));
}

describe('P4 real candidate commit and message persistence failures', () => {
  it.each(['toolResult-save', 'assistant-save', 'delivery-conflict', 'blocking-write-failure', 'job-terminal-write-failure', 'sdk-after-receipt', 'sdk-after-sources'] as const)
    ('preserves the committed candidate and actual tool facts after %s', async (fault) => {
    const root = mkdtempSync(join(tmpdir(), 'flowmate-p4-tool-fault-'));
    const product = join(root, 'product');
    const paths = { root: product, databaseFile: join(product, 'data', 'app.sqlite'), logsDir: join(product, 'logs'),
      artifactsDir: join(product, 'artifacts'), outputsDir: join(product, 'outputs'), runtimeDir: join(product, 'runtime') };
    const sourceRoot = join(root, 'source');
    const source = join(sourceRoot, '000001');
    writeFaultInvoice(source);
    const terminalWriteFailed = fault === 'blocking-write-failure' || fault === 'job-terminal-write-failure';
    const afterFault = fault.startsWith('sdk-after-');
    const toolResultSaveFailed = fault !== 'assistant-save' && fault !== 'delivery-conflict';
    if (terminalWriteFailed) {
      const seeded = openDatabase(paths);
      if (!seeded.ok) throw new Error(seeded.error.code);
      if (fault === 'job-terminal-write-failure') {
        seeded.data.db.exec("CREATE TRIGGER reject_job_terminal BEFORE UPDATE OF status ON jobs WHEN OLD.status='running' AND NEW.status!='running' BEGIN SELECT RAISE(ABORT,'job terminal failed'); END;");
      } else {
        seeded.data.db.exec("CREATE TRIGGER reject_unsafe_marker BEFORE UPDATE OF unusable ON session_native_history WHEN NEW.unusable=1 BEGIN SELECT RAISE(ABORT,'unsafe marker failed'); END;");
        seeded.data.db.exec("CREATE TRIGGER reject_failed_terminal BEFORE UPDATE ON runs WHEN NEW.status='failed' BEGIN SELECT RAISE(ABORT,'terminal failed'); END;");
      }
      seeded.data.close();
    }
    const callId = `p4-save-${fault}`;
    let documentId = 0;
    const requests: Array<{ messages: Array<{ role: string; content?: unknown; tool_call_id?: string }> }> = [];
    const server = Bun.serve({ hostname: '127.0.0.1', port: 0, async fetch(request) {
      requests.push(await request.json());
      const chunk = (delta: Record<string, unknown>, finishReason: string | null = null) =>
        `data: ${JSON.stringify({ id: `candidate-fault-${requests.length}`, model: 'p4-fault-model',
          choices: [{ index: 0, delta, finish_reason: finishReason }] })}\n\n`;
      const response = requests.length === 1
        ? `${chunk({ role: 'assistant', tool_calls: [{ index: 0, id: callId, type: 'function',
          function: { name: 'save_invoice_candidate', arguments: JSON.stringify({ documentId, candidate }) } }] })}${chunk({}, 'tool_calls')}`
        : `${chunk({ role: 'assistant', content: 'The candidate was saved for review.' })}${chunk({}, 'stop')}`;
      return new Response(`${response}data: [DONE]\n\n`, { headers: { 'content-type': 'text/event-stream' } });
    } });
    deferCleanup(() => server.stop(true));
    let adapter!: PiAgentAdapter;
    let outcome: AgentNativeOutcome | undefined;
    let executions = 0;
    let prepareCount = 0;
    let injected = false;
    let queryCall: AgentToolBinding['queryCall'];
    let fixedFacts: Pick<ToolCallSnapshot, 'result' | 'runtimeObservation' | 'endedAt' | 'stoppedAt'> | undefined;
    let priorPrefix: NativeSessionHistory | undefined;
    let prefixAtFailure: NativeSessionHistory | undefined;
    let failedEntryId: string | undefined;
    const deliveries: Array<{ state: string; result: Result<void> }> = [];
    let repeatedDeliveries = 0;
    let failureRevision: number | null = null;
    let aborts = 0;
    const originalAbort = AgentSession.prototype.abort;
    AgentSession.prototype.abort = function(...args) { aborts += 1; return originalAbort.apply(this, args); };
    deferCleanup(() => { AgentSession.prototype.abort = originalAbort; });
    const opened = await createApplication({ paths, invoiceSourceRoot: sourceRoot,
      logger: { write: () => undefined, close: async () => undefined }, agentFactory: (tools) => {
        adapter = new PiAgentAdapter({ cwd: paths.runtimeDir, agentDir: paths.runtimeDir, tools,
          credentials: new InMemoryCredentialStore(), runtimeApiKey: 'synthetic-p4-fault-key',
          ...(afterFault ? { sessionSetup(session) {
            const originalAfter = session.agent.afterToolCall;
            session.agent.afterToolCall = async (...call) => {
              const saved = queryCall?.(call[0].toolCall.id);
              if (!saved?.ok) throw new Error('Missing saved candidate ToolCall before SDK after.');
              fixedFacts = { result: saved.data.result, runtimeObservation: saved.data.runtimeObservation,
                endedAt: saved.data.endedAt, stoppedAt: saved.data.stoppedAt };
              const original = await originalAfter?.(...call);
              injected = true;
              Reflect.set(call[0].result.details as object, fault === 'sdk-after-receipt' ? 'candidateId' : 'sources',
                fault === 'sdk-after-receipt' ? 999 : [{ documentId: 999, quote: 'Forged source.' }]);
              return original;
            };
          } } : {}) });
        const watch = adapter.watchSession.bind(adapter);
        adapter.watchSession = (nativeId, commit, seed, save) => watch(nativeId, commit, seed, write => {
          const history = write.history; const context = write.contexts[0];
          const entry = history.entries.at(-1);
          const message = entry?.type === 'message' ? entry.message as Record<string, unknown> : null;
          const target = fault === 'assistant-save' ? message?.role === 'assistant' && message.stopReason === 'stop'
            : message?.role === 'toolResult';
          if (!afterFault && fault !== 'delivery-conflict' && context && target && !injected) {
            injected = true;
            failureRevision = write.expected.commitRevision;
            prefixAtFailure = priorPrefix && structuredClone(priorPrefix);
            failedEntryId = context.entryId;
            return fail(appError('storage_write_failed', 'storage', 'Controlled native message save failure.', true));
          }
          const result = save(write);
          if (result.ok) priorPrefix = structuredClone(history);
          return result;
        });
        const prepare = adapter.prepare.bind(adapter);
        adapter.prepare = async (...args) => {
          prepareCount += 1;
          const result = await prepare(...args);
          if (!result.ok) return result;
          const nativeExecute = result.data.execute.bind(result.data);
          return { ...result, data: { ...result.data, execute: async (input, signal, observe) => {
            const binding = input.toolBinding!;
            queryCall = binding.queryCall;
            outcome = await nativeExecute({ ...input, toolBinding: { ...binding,
              execute: async (...call) => { executions += 1; return binding.execute(...call); },
              recordDelivery: (id, delivery) => {
                const actual = binding.recordDelivery(id, delivery);
                deliveries.push({ state: delivery.state, result: actual });
                if (delivery.state === 'message_observed' && actual.ok) {
                  const repeated = binding.recordDelivery(id, structuredClone(delivery));
                  expect(repeated).toEqual(actual);
                  repeatedDeliveries += 1;
                  deliveries.push({ state: 'repeated', result: repeated });
                }
                if (fault === 'delivery-conflict' && delivery.state === 'message_observed' && actual.ok && !injected) {
                  injected = true;
                  const conflict = binding.recordDelivery(id, { ...delivery, messageObservedAt: '2000-01-01T00:00:00.000Z' });
                  deliveries.push({ state: 'conflict', result: conflict });
                  return conflict;
                }
                return actual;
              },
            } }, signal, observe);
            return outcome;
          } } };
        };
        return adapter;
      } });
    if (!opened.ok) throw new Error(opened.error.code);
    const app = opened.data;
    deferCleanup(() => app.close());
    const imported = await app.importInvoiceMaterial(source);
    expect(imported.ok).toBe(true);
    if (!imported.ok) return;
    documentId = imported.data.documentRef.id;
    const session = await app.createSession({ title: 'Candidate failure' });
    expect(session.ok).toBe(true);
    if (!session.ok) return;
    const sessionId = session.data.sessionId;
    expect(await app.updateWorkspace({ expectedRevision: 0, change: { kind: 'session', sessionId } })).toMatchObject({ ok: true, data: { revision: 1 } });
    const selected = await app.updateWorkspace({ expectedRevision: 1, change: { kind: 'document', documentId } });
    expect(selected.ok).toBe(true);
    if (!selected.ok) return;
    const task = await app.startTask({ clientSequence: 1, expectedRevision: selected.data.revision,
      documentRef: imported.data.documentRef, goal: 'Save a synthetic candidate' });
    expect(task.ok).toBe(true);
    if (!task.ok) return;
    const jobId = task.data.job.jobId;
    const current = task.data.workspace;
    const workspace = { revision: current.revision, sessionId, documentRef: current.documentRef,
      jobId: current.jobId, candidateRef: current.candidateRef };
    const config: ProviderConfig = { version: 1, name: 'P4 fault model', revision: 1,
      modelRef: { provider: 'p4-fault-fixture', model: 'p4-fault-model' },
      native: { authPath: join(root, 'unused-auth.json'), modelsPath: null },
      connection: { baseUrl: `http://127.0.0.1:${server.port}/v1`, api: 'openai-completions', contextWindow: 64_000, maxTokens: 16_384 },
      parameters: { maxRetries: 0, maxRetryDelayMs: 1000 } };
    const events: AgentRunEvent[] = [];
    let finish!: (event: Extract<AgentRunEvent, { type: 'run_finished' }>) => void;
    const completion = new Promise<Extract<AgentRunEvent, { type: 'run_finished' }>>((resolve) => { finish = resolve; });
    const request = { sessionId, text: 'Save the supplied candidate for review.', config, workspace, goalMode: 'save-candidate' as const };
    const accepted = await app.startRun(request, { onEvent: (event) => { events.push(event); if (event.type === 'run_finished') finish(event); } });
    expect(accepted.ok).toBe(true);
    if (!accepted.ok) return;
    const terminal = await completion;
    if (afterFault) {
      expect(terminal.result).toMatchObject({ ok: true, data: { status: 'failed', stopped: true, error: { code: 'tool_feedback_conflict' } } });
      expect(injected).toBe(true);
      expect(executions).toBe(1);
      expect(requests).toHaveLength(1);
      expect(await app.queryJobCandidate({ jobId, candidateId: 1 })).toMatchObject({ ok: true, data: { candidate } });
      expect(await app.close()).toMatchObject({ ok: true, data: { closed: true } });
      const db = new Database(paths.databaseFile, { readonly: true });
      try {
        const row = db.query('SELECT status,result_json,runtime_observation_json,ended_at,stopped_at,delivery_json FROM tool_calls').get() as {
          status: string; result_json: string; runtime_observation_json: string; ended_at: string; stopped_at: string; delivery_json: string };
        expect(row.status).toBe('succeeded');
        expect(fixedFacts).toEqual({ result: JSON.parse(row.result_json), runtimeObservation: JSON.parse(row.runtime_observation_json),
          endedAt: row.ended_at, stoppedAt: row.stopped_at });
        expect(JSON.parse(row.result_json)).toMatchObject({ status: 'succeeded', committedCandidateId: 1, data: { candidateId: 1 } });
        expect(JSON.parse(row.delivery_json)).toMatchObject({ state: 'failed', includedInCallSequence: null, requestDispatchedAt: null });
        expect(db.query('SELECT COUNT(*) AS count FROM invoice_candidates').get()).toEqual({ count: 1 });
      } finally { db.close(); }
      return;
    }
    expect(terminal.result).toMatchObject(terminalWriteFailed
      ? { ok: false, error: { code: 'storage_write_failed' } }
      : { ok: true, data: { status: 'failed', stopped: true, error: { code: 'storage_write_failed' } } });
    expect(injected).toBe(true);
    expect(executions).toBe(1);
    expect(repeatedDeliveries).toBe(fault === 'assistant-save' || fault === 'delivery-conflict' ? 1 : 0);
    expect(outcome?.stopped).toBe(true);
    expect(aborts).toBeGreaterThan(0);
    expect(adapter.inspect(session.data.nativeSessionId)).toEqual({ availability: 'unusable' });
    const callsExpected = fault === 'assistant-save' ? 2 : 1;
    expect(requests).toHaveLength(callsExpected);
    if (fault === 'assistant-save') {
      const toolMessage = requests[1]!.messages.find((message) => message.role === 'tool');
      expect(toolMessage?.tool_call_id).toBe(callId);
      expect(JSON.parse(String(toolMessage?.content))).toMatchObject({ candidateId: 1, jobId, sequence: 1 });
    }
    const candidates = await app.listJobCandidates({ jobId, limit: 20 });
    expect(candidates).toMatchObject({ ok: true, data: { items: [{ candidateId: 1, jobId, sequence: 1 }] } });
    expect(await app.queryJobCandidate({ jobId, candidateId: 1 })).toMatchObject({ ok: true });
    const jobBeforeRestart = await app.queryJob(jobId);
    expect(jobBeforeRestart).toMatchObject({ ok: true, data: { jobId,
      status: terminalWriteFailed ? 'running' : 'failed', reason: terminalWriteFailed ? null : 'storage_write_failed',
      currentCandidateId: null, acceptedCandidateId: null } });
    const page = await app.listSessionMessages({ sessionId, limit: 100 });
    expect(page.ok).toBe(true);
    if (!page.ok) return;
    expect(page.data.session.availability).toBe('unusable');
    expect(page.data.items.map((message) => message.role)).toEqual(toolResultSaveFailed
      ? ['user', 'assistant'] : fault === 'delivery-conflict'
        ? ['user', 'assistant', 'toolResult', 'assistant'] : ['user', 'assistant', 'toolResult']);
    if (fault === 'delivery-conflict') expect(page.data.items.at(-1)).toMatchObject({ role: 'assistant', stopReason: 'aborted' });
    if (fault !== 'delivery-conflict') {
      expect(page.data.items.some((message) => message.entryId === failedEntryId)).toBe(false);
      expect(events.some((event) => event.type === 'message_upsert' && event.message.persistence === 'failed')).toBe(true);
      expect(events.some((event) => event.type === 'message_upsert' && event.message.entryId === failedEntryId && event.message.persistence === 'saved')).toBe(false);
    } else expect(deliveries.find((delivery) => delivery.state === 'conflict')?.result).toMatchObject({ ok: false, error: { code: 'state_conflict' } });
    if (terminalWriteFailed) {
      expect(await app.queryRuntimeState()).toMatchObject({ ok: true, data: { blocked: true } });
      expect(await app.queryRun(accepted.data.runId)).toMatchObject({ ok: true, data: {
        status: 'running', output: null, error: null, endedAt: null, stoppedAt: null } });
      expect(await app.startRun(request)).toMatchObject({ ok: false, error: { code: 'runtime_unusable' } });
    }
    else {
      expect(await app.queryRun(accepted.data.runId)).toMatchObject({ ok: true, data: { status: 'failed', cleanup: { stopped: true }, stoppedAt: expect.any(String) } });
      expect(await app.startRun(request)).toMatchObject({ ok: false, error: { code: 'agent_session_unusable' } });
    }
    expect(requests).toHaveLength(callsExpected);
    expect(await app.close()).toMatchObject({ ok: true, data: { closed: true } });
    const db = new Database(paths.databaseFile);
    let dbClosed = false;
    const closeDb = () => { if (!dbClosed) { dbClosed = true; db.close(); } };
    deferCleanup(closeDb);
    const committedEntries = db.query('SELECT entry_id,entry_json,run_id FROM session_native_entries WHERE session_id=? ORDER BY sequence').all(sessionId);
    const head = db.query('SELECT leaf_id,entry_count,unusable,commit_revision,header_json FROM session_native_history WHERE session_id=?').get(sessionId) as { leaf_id: string | null; entry_count: number; unusable: number; commit_revision: number; header_json: string };
    expect(head.unusable).toBe(fault === 'blocking-write-failure' ? 0 : 1);
    expect(head.entry_count).toBe(committedEntries.length);
    expect(head.leaf_id).toBe((committedEntries.at(-1) as { entry_id: string } | undefined)?.entry_id ?? null);
    if (fault !== 'delivery-conflict') {
      if (!prefixAtFailure) throw new Error('Missing actual committed prefix at the save failure.');
      expect(committedEntries.map((entry) => (entry as { entry_id: string }).entry_id)).not.toContain(failedEntryId);
      expect(head.leaf_id).toBe(prefixAtFailure.leafId);
      expect(committedEntries.map((entry) => (entry as { entry_json: string }).entry_json))
        .toEqual(prefixAtFailure.entries.map((entry) => JSON.stringify(entry)));
    }
    expect(db.query('SELECT COUNT(*) AS count FROM invoice_candidates').get()).toEqual({ count: 1 });
    expect(db.query('SELECT COUNT(*) AS count FROM tool_calls').get()).toEqual({ count: 1 });
    expect(db.query("SELECT COUNT(*) AS count FROM business_events WHERE type='candidate_generated'").get()).toEqual({ count: 1 });
    expect(db.query(`SELECT run.status AS runStatus,job.status AS jobStatus,job.status_reason AS reason,
      job.current_candidate_id AS currentCandidateId FROM runs run JOIN jobs job ON job.id=run.job_id WHERE run.id=?`)
      .get(accepted.data.runId)).toEqual({ runStatus: terminalWriteFailed ? 'running' : 'failed',
        jobStatus: terminalWriteFailed ? 'running' : 'failed', reason: terminalWriteFailed ? null : 'storage_write_failed',
        currentCandidateId: null });
    if (fault === 'job-terminal-write-failure') {
      // A real Job UPDATE aborts after the Run UPDATE in the same transaction.
      // Both objects retain their last committed running facts.
      expect(db.query('SELECT output_json,error_json,ended_at,stopped_at FROM runs WHERE id=?').get(accepted.data.runId))
        .toEqual({ output_json: null, error_json: null, ended_at: null, stopped_at: null });
      expect(head.commit_revision).toBe(failureRevision! + 1);
      expect(head.header_json).toBe(JSON.stringify(prefixAtFailure!.header));
      expect(db.query("SELECT type FROM runtime_events WHERE run_id=? AND type IN ('run_completed','run_failed','run_cancelled')").all(accepted.data.runId)).toEqual([]);
      expect(db.query('SELECT status,processing_status,result_entry_id FROM session_inputs WHERE run_id=?').all(accepted.data.runId))
        .toEqual([{ status: 'consumed', processing_status: 'pending', result_entry_id: null }]);
      db.exec('DROP TRIGGER reject_job_terminal;');
    }
    const tool = db.query('SELECT status,result_json,delivery_json FROM tool_calls WHERE native_tool_call_id=?').get(callId) as { status: string; result_json: string; delivery_json: string };
    expect(tool.status).toBe('succeeded');
    expect(JSON.parse(tool.result_json)).toMatchObject({ status: 'succeeded', committedCandidateId: 1 });
    expect(JSON.parse(tool.delivery_json).state).toBe(fault === 'assistant-save' ? 'request_observed'
      : fault === 'delivery-conflict' ? 'message_observed' : 'not_attempted');
    if (toolResultSaveFailed) expect(deliveries).toEqual([]);
    if (fault === 'blocking-write-failure') {
      expect(failureRevision).not.toBeNull(); expect(head.commit_revision).toBe(failureRevision!);
      expect(head.header_json).toBe(JSON.stringify(prefixAtFailure!.header));
      expect(db.query("SELECT type FROM runtime_events WHERE run_id=? AND type IN ('run_completed','run_failed','run_cancelled')").all(accepted.data.runId)).toEqual([]);
      expect(db.query('SELECT status FROM runs WHERE id=?').get(accepted.data.runId)).toEqual({ status: 'running' });
      db.exec('DROP TRIGGER reject_unsafe_marker;');
      db.exec('DROP TRIGGER reject_failed_terminal;');
    }
    expect(db.query('PRAGMA foreign_key_check').all()).toEqual([]);
    closeDb();
    let recoveredPrepareCount = 0;
    const recovered = await createApplication({ paths, invoiceSourceRoot: sourceRoot,
      logger: { write: () => undefined, close: async () => undefined }, agentFactory: (tools) => {
        const restored = new PiAgentAdapter({ cwd: paths.runtimeDir, agentDir: paths.runtimeDir, tools,
          credentials: new InMemoryCredentialStore(), runtimeApiKey: 'synthetic-p4-fault-key' });
        const prepare = restored.prepare.bind(restored);
        restored.prepare = async (...args) => { recoveredPrepareCount += 1; return prepare(...args); };
        return restored;
      } });
    expect(recovered.ok).toBe(true);
    if (!recovered.ok) return;
    deferCleanup(() => recovered.data.close());
    const recoveredPage = await recovered.data.listSessionMessages({ sessionId, limit: 100 });
    expect(recoveredPage).toMatchObject({ ok: true, data: { session: { availability: 'unusable' },
      items: page.data.items.map((message) => ({ ...message, liveOrdinal: null })) } });
    expect(await recovered.data.queryRuntimeState()).toMatchObject(terminalWriteFailed
      ? { ok: true, data: { active: null, blocked: true, error: {
        code: 'runtime_recovery_blocked', runId: accepted.data.runId, sessionId,
      } } }
      : { ok: true, data: { active: null, blocked: false, error: null } });
    expect(await recovered.data.startRun(request)).toMatchObject({ ok: false, error: {
      code: terminalWriteFailed ? 'runtime_unusable' : 'agent_session_unusable',
    } });
    expect(await recovered.data.queryRun(accepted.data.runId)).toMatchObject({ ok: true, data: {
      runId: accepted.data.runId, sessionId, status: 'failed',
      ...(terminalWriteFailed
        ? { error: { code: 'runtime_interrupted' }, stoppedAt: null,
          cleanup: { stopped: false, stopReason: 'process-exit', lateObservationRequired: true } }
        : { stoppedAt: expect.any(String), cleanup: { stopped: true, lateObservationRequired: false } }),
    } });
    expect(await recovered.data.queryJob(jobId)).toMatchObject({ ok: true, data: { jobId, status: 'failed',
      reason: terminalWriteFailed ? 'runtime_interrupted' : 'storage_write_failed',
      currentCandidateId: null, acceptedCandidateId: null } });
    if (!terminalWriteFailed) expect(await recovered.data.queryJob(jobId)).toEqual(jobBeforeRestart);
    expect(await recovered.data.listJobCandidates({ jobId, limit: 20 })).toEqual(candidates);
    expect(recoveredPrepareCount).toBe(0);
    expect(prepareCount).toBe(1);
    expect(requests).toHaveLength(callsExpected);
    expect(executions).toBe(1);
    expect(priorPrefix?.entries.map((entry) => entry.id)).toEqual(committedEntries.map((entry) => (entry as { entry_id: string }).entry_id));
    expect(await recovered.data.close()).toMatchObject({ ok: true, data: { closed: true } });
    const recoveredDb = new Database(paths.databaseFile, { readonly: true });
    try {
      expect(recoveredDb.query(`SELECT run.status AS runStatus,job.status AS jobStatus,job.status_reason AS reason,
        job.current_candidate_id AS currentCandidateId FROM runs run JOIN jobs job ON job.id=run.job_id WHERE run.id=?`)
        .get(accepted.data.runId)).toEqual({ runStatus: 'failed', jobStatus: 'failed',
          reason: terminalWriteFailed ? 'runtime_interrupted' : 'storage_write_failed', currentCandidateId: null });
    } finally { recoveredDb.close(); }
  }, 30_000);
});

it('F6-04 preserves the actual SDK candidate and Activity when its Tool settlement event INSERT fails', async () => {
  const root = mkdtempSync(join(tmpdir(), 'flowmate-p6-sdk-candidate-event-'));
  const product = join(root, 'product');
  const paths = { root: product, databaseFile: join(product, 'data', 'app.sqlite'), logsDir: join(product, 'logs'),
    artifactsDir: join(product, 'artifacts'), outputsDir: join(product, 'outputs'), runtimeDir: join(product, 'runtime') };
  const sourceRoot = join(root, 'source');
  const source = join(sourceRoot, '000001');
  writeFaultInvoice(source);
  const seeded = openDatabase(paths);
  if (!seeded.ok) throw new Error(seeded.error.message);
  // This fault can fire only after the real candidate and its matching business Activity exist.
  seeded.data.db.exec(`CREATE TRIGGER reject_saved_candidate_terminal_event BEFORE INSERT ON runtime_events
    WHEN NEW.type IN ('tool_succeeded','tool_failed','tool_cancelled') AND EXISTS (
      SELECT 1 FROM invoice_candidates candidate JOIN business_events activity ON activity.candidate_id=candidate.id
      WHERE candidate.tool_call_id=NEW.tool_call_id AND activity.type='candidate_generated' AND activity.result='succeeded')
    BEGIN SELECT RAISE(ABORT,'candidate Tool settlement event unavailable'); END;`);
  seeded.data.close();
  let documentId = 0;
  const callId = 'p6-save-event-failure';
  let httpCalls = 0;
  let executorCalls = 0;
  let saves = 0;
  let applies = 0;
  let deliveries = 0;
  const deliveryAttempts: Array<{ state: string; result: Result<void> }> = [];
  let prepares = 0;
  let invocation: Awaited<ReturnType<AgentToolBinding['execute']>> | undefined;
  let savedCall: ToolCallSnapshot | undefined;
  const server = Bun.serve({ hostname: '127.0.0.1', port: 0, async fetch(request) {
    await request.json();
    httpCalls += 1;
    const chunk = (delta: Record<string, unknown>, finishReason: string | null = null) =>
      `data: ${JSON.stringify({ id: `p6-candidate-${httpCalls}`, model: 'p6-candidate-model',
        choices: [{ index: 0, delta, finish_reason: finishReason }] })}\n\n`;
    return new Response(`${chunk({ role: 'assistant', tool_calls: [{ index: 0, id: callId, type: 'function',
      function: { name: 'save_invoice_candidate', arguments: JSON.stringify({ documentId, candidate }) } }] })}${chunk({}, 'tool_calls')}data: [DONE]\n\n`,
      { headers: { 'content-type': 'text/event-stream' } });
  } });
  deferCleanup(() => server.stop(true));
  const opened = await createApplication({ paths, invoiceSourceRoot: sourceRoot,
    logger: { write: () => undefined, close: async () => undefined },
    invoiceFormBridge: async () => { applies += 1; throw new Error('Unexpected form application after candidate event failure.'); },
    toolDefinitions: definitions => definitions.map(definition => definition.name === 'save_invoice_candidate'
      ? { ...definition, execute: async (...args) => { saves += 1; return definition.execute(...args); } } : definition),
    agentFactory: tools => {
      const adapter = new PiAgentAdapter({ cwd: paths.runtimeDir, agentDir: paths.runtimeDir, tools,
        credentials: new InMemoryCredentialStore(), runtimeApiKey: 'synthetic-p6-candidate-key' });
      const prepare = adapter.prepare.bind(adapter);
      adapter.prepare = async (...args) => {
        prepares += 1;
        const prepared = await prepare(...args);
        if (!prepared.ok) return prepared;
        const execute = prepared.data.execute.bind(prepared.data);
        return { ...prepared, data: { ...prepared.data, execute: (input, signal, observe) => {
          const binding = input.toolBinding!;
          return execute({ ...input, toolBinding: { ...binding,
            execute: async (...call) => {
              executorCalls += 1;
              invocation = await binding.execute(...call);
              const queried = binding.queryCall?.(call[2].nativeToolCallId);
              if (!queried?.ok) throw new Error('Missing original ToolCall after settlement rollback.');
              savedCall = queried.data;
              return invocation;
            },
            recordDelivery: (...call) => {
              const result = binding.recordDelivery(...call);
              if (result.ok) deliveries += 1;
              deliveryAttempts.push({ state: call[1].state, result });
              return result;
            },
          } }, signal, observe);
        } } };
      };
      return adapter;
    } });
  if (!opened.ok) throw new Error(opened.error.message);
  const app = opened.data;
  deferCleanup(() => app.close());
  const imported = await app.importInvoiceMaterial(source);
  if (!imported.ok) throw new Error(imported.error.message);
  documentId = imported.data.documentRef.id;
  const session = await app.createSession({ title: 'Candidate event failure' });
  if (!session.ok) throw new Error(session.error.message);
  const sessionId = session.data.sessionId;
  expect(await app.updateWorkspace({ expectedRevision: 0, change: { kind: 'session', sessionId } })).toMatchObject({ ok: true });
  const selected = await app.updateWorkspace({ expectedRevision: 1, change: { kind: 'document', documentId } });
  if (!selected.ok) throw new Error(selected.error.message);
  const task = await app.startTask({ clientSequence: 1, expectedRevision: selected.data.revision,
    documentRef: imported.data.documentRef, goal: 'Save candidate before settlement failure' });
  if (!task.ok) throw new Error(task.error.message);
  const jobId = task.data.job.jobId;
  const current = task.data.workspace;
  const workspace = { revision: current.revision, sessionId, documentRef: current.documentRef,
    jobId: current.jobId, candidateRef: current.candidateRef };
  const config: ProviderConfig = { version: 1, name: 'P6 candidate fixture', revision: 1,
    modelRef: { provider: 'p6-candidate-fixture', model: 'p6-candidate-model' },
    native: { authPath: join(root, 'unused-auth.json'), modelsPath: null },
    connection: { baseUrl: `http://127.0.0.1:${server.port}/v1`, api: 'openai-completions', contextWindow: 64_000, maxTokens: 16_384 },
    parameters: { maxRetries: 0, maxRetryDelayMs: 1000 } };
  const request = { sessionId, text: 'Save the supplied candidate for review.', config, workspace, goalMode: 'save-candidate' as const };
  let finish!: (event: Extract<AgentRunEvent, { type: 'run_finished' }>) => void;
  const completion = new Promise<Extract<AgentRunEvent, { type: 'run_finished' }>>(resolve => { finish = resolve; });
  const accepted = await app.startRun(request, { onEvent: event => { if (event.type === 'run_finished') finish(event); } });
  if (!accepted.ok) throw new Error(accepted.error.message);
  const runId = accepted.data.runId;
  expect((await completion).result).toMatchObject({ ok: true, data: {
    status: 'failed', stopped: false, error: { code: 'storage_write_failed' } } });
  expect(invocation).toMatchObject({ fatal: true, result: { status: 'failed', error: { code: 'storage_write_failed' } } });
  expect(savedCall).toMatchObject({ runId, sessionId, nativeToolCallId: callId, status: 'running',
    result: null, runtimeObservation: null, endedAt: null, stoppedAt: null, delivery: { state: 'not_attempted' } });
  expect(savedCall).toBeDefined();
  const toolCallId = savedCall!.toolCallId;
  const candidateQuery = { jobId, candidateId: 1 };
  expect(await app.queryJobCandidate(candidateQuery)).toMatchObject({ ok: true, data: { candidate: {
    ...candidate, candidateId: 1, jobId, runId, toolCallId, sequence: 1, status: 'generated' } } });
  const activity = await app.listActivity({ jobId, limit: 20 });
  if (!activity.ok) throw new Error(activity.error.message);
  expect(activity.data.items.filter(event => event.type === 'candidate_generated')).toEqual([
    expect.objectContaining({ runId, jobId, candidateId: 1, operationRef: `tool-call-id:${toolCallId}`, result: 'succeeded' }),
  ]);
  expect(await app.queryJob(jobId)).toMatchObject({ ok: true, data: { status: 'failed', reason: 'storage_write_failed',
    currentCandidateId: null, acceptedCandidateId: null } });
  expect(await app.queryRun(runId)).toMatchObject({ ok: true, data: { status: 'failed', stoppedAt: null,
    cleanup: { stopped: false, lateObservationRequired: true }, error: { code: 'storage_write_failed' } } });
  expect(await app.queryRuntimeState()).toMatchObject({ ok: true, data: { active: null, blocked: true } });
  const counters = () => ({ httpCalls, executorCalls, saves, applies, deliveries, prepares });
  expect(counters()).toEqual({ httpCalls: 1, executorCalls: 1, saves: 1, applies: 0, deliveries: 1, prepares: 1 });
  expect(deliveryAttempts).toEqual([
    { state: 'failed', result: { ok: true, data: undefined } },
    { state: 'message_observed', result: expect.objectContaining({ ok: false, error: expect.objectContaining({ code: 'state_conflict' }) }) },
  ]);
  const beforeQueries = counters();
  const page = await app.queryRuntimeEvents({ runId, sessionId, cursor: { runId, lastPersistedSequence: 0 }, limit: 100 });
  if (!page.ok) throw new Error(page.error.message);
  expect(page.data.items.filter(event => event.toolCallId === toolCallId).map(event => event.type))
    .toEqual(['tool_requested', 'tool_started']);
  expect(page.data.items.some(event => event.type === 'run_failed')).toBe(true);
  expect(await app.queryRunToolCall({ runId, sessionId, toolCallId })).toMatchObject({ ok: true, data: {
    status: 'running', endedAt: null, stoppedAt: null, committedCandidateId: null, deliveryState: 'failed' } });
  expect(await app.queryRuntimeEvents({ runId, sessionId, cursor: page.data.nextCursor })).toMatchObject({ ok: true, data: { items: [] } });
  expect(await app.queryJobCandidate(candidateQuery)).toMatchObject({ ok: true, data: { candidate } });
  expect(await app.startRun(request)).toMatchObject({ ok: false, error: { code: 'runtime_unusable' } });
  expect(counters()).toEqual(beforeQueries);
  expect(await app.close()).toMatchObject({ ok: true, data: { closed: true } });
  expect(counters()).toEqual(beforeQueries);
  const db = new Database(paths.databaseFile, { readonly: true });
  try {
    expect(db.query('SELECT run_id,tool_call_id,sequence,status FROM invoice_candidates').all())
      .toEqual([{ run_id: runId, tool_call_id: toolCallId, sequence: 1, status: 'generated' }]);
    expect(db.query("SELECT COUNT(*) AS count FROM business_events WHERE type='candidate_generated'").get()).toEqual({ count: 1 });
    expect(db.query('SELECT status,result_json,runtime_observation_json,ended_at,stopped_at FROM tool_calls WHERE id=?').get(toolCallId))
      .toEqual({ status: 'running', result_json: null, runtime_observation_json: null, ended_at: null, stopped_at: null });
    expect(db.query("SELECT COUNT(*) AS count FROM runtime_events WHERE type IN ('tool_succeeded','tool_failed','tool_cancelled')").get())
      .toEqual({ count: 0 });
    expect(db.query("SELECT COUNT(*) AS count FROM tool_calls WHERE tool_name='fill_invoice_form'").get()).toEqual({ count: 0 });
    expect(db.query('PRAGMA foreign_key_check').all()).toEqual([]);
  } finally { db.close(); }
}, 30_000);

it('persists real material revocation between conversion and fetch while saved history remains readable', async () => {
  const root = mkdtempSync(join(tmpdir(), 'flowmate-p4-revoke-'));
  const product = join(root, 'product');
  const paths = { root: product, databaseFile: join(product, 'data', 'app.sqlite'), logsDir: join(product, 'logs'),
    artifactsDir: join(product, 'artifacts'), outputsDir: join(product, 'outputs'), runtimeDir: join(product, 'runtime') };
  const sourceRoot = join(root, 'source');
  const source = join(sourceRoot, '000001');
  writeFaultInvoice(source);
  let requestCount = 0;
  const server = Bun.serve({ hostname: '127.0.0.1', port: 0, async fetch(request) {
    await request.json(); requestCount += 1;
    const chunks = [{ role: 'assistant', content: 'Synthetic invoice saved conversation.' }, {}].map((delta, index) =>
      `data: ${JSON.stringify({ id: 'revocation-fixture', model: 'p4-revoke', choices: [{ index: 0, delta, finish_reason: index ? 'stop' : null }] })}\n\n`);
    return new Response(`${chunks.join('')}data: [DONE]\n\n`, { headers: { 'content-type': 'text/event-stream' } });
  } });
  deferCleanup(() => server.stop(true));
  let app!: Application;
  let documentId = 0;
  let revokeOnDispatch = false;
  let revocation: ReturnType<typeof app.revokeDocumentUse> | undefined;
  let prepares = 0;
  const opened = await createApplication({ paths, invoiceSourceRoot: sourceRoot,
    logger: { write: () => undefined, close: async () => undefined }, agentFactory: (tools) => {
      const adapter = new PiAgentAdapter({ cwd: paths.runtimeDir, agentDir: paths.runtimeDir, tools,
        credentials: new InMemoryCredentialStore(), runtimeApiKey: 'synthetic-revoke-key' });
      const prepare = adapter.prepare.bind(adapter);
      adapter.prepare = async (...args) => {
        prepares += 1;
        const result = await prepare(...args);
        if (!result.ok) return result;
        const execute = result.data.execute.bind(result.data);
        return { ...result, data: { ...result.data, execute: (input, signal, observe) => execute(input, signal, (event) => {
          observe(event);
          if (revokeOnDispatch && event.type === 'request_budget' && !revocation) revocation = app.revokeDocumentUse(documentId);
        }) } };
      };
      return adapter;
    } });
  if (!opened.ok) throw new Error(opened.error.message);
  app = opened.data;
  deferCleanup(() => app.close());
  const imported = await app.importInvoiceMaterial(source);
  if (!imported.ok) throw new Error(imported.error.message);
  documentId = imported.data.documentRef.id;
  const session = await app.createSession({ title: 'Revoked native memory' });
  if (!session.ok) throw new Error(session.error.message);
  const sessionId = session.data.sessionId;
  await app.updateWorkspace({ expectedRevision: 0, change: { kind: 'session', sessionId } });
  const selected = await app.updateWorkspace({ expectedRevision: 1, change: { kind: 'document', documentId } });
  if (!selected.ok) throw new Error(selected.error.message);
  const workspace = { revision: selected.data.revision, sessionId, documentRef: selected.data.documentRef,
    jobId: selected.data.jobId, candidateRef: selected.data.candidateRef };
  const config: ProviderConfig = { version: 1, name: 'Revocation fixture', revision: 1,
    modelRef: { provider: 'p4-revoke-fixture', model: 'p4-revoke' }, native: { authPath: join(root, 'unused-auth.json'), modelsPath: null },
    connection: { baseUrl: `http://127.0.0.1:${server.port}/v1`, api: 'openai-completions', contextWindow: 64000, maxTokens: 16384 },
    parameters: { maxRetries: 0, maxRetryDelayMs: 1000 } };
  const request = { sessionId, text: 'Use the selected synthetic material.', config, workspace, goalMode: 'answer' as const };
  const run = async () => {
    let finish!: (event: Extract<AgentRunEvent, { type: 'run_finished' }>) => void;
    const completion = new Promise<Extract<AgentRunEvent, { type: 'run_finished' }>>((resolve) => { finish = resolve; });
    const accepted = await app.startRun(request, { onEvent: (event) => { if (event.type === 'run_finished') finish(event); } });
    if (!accepted.ok) throw new Error(accepted.error.message);
    return completion;
  };
  expect((await run()).result).toMatchObject({ ok: true, data: { status: 'completed' } });
  const first = await app.listSessionMessages({ sessionId });
  if (!first.ok) throw new Error(first.error.message);
  expect(first.data.items).toHaveLength(2);
  revokeOnDispatch = true;
  expect((await run()).result).toMatchObject({ ok: true, data: { status: 'cancelled', stopped: true } });
  expect(await revocation).toMatchObject({ ok: true, data: { affectedSessionIds: [sessionId], stopRequested: true } });
  expect(requestCount).toBe(1);
  const history = await app.listSessionMessages({ sessionId });
  expect(history.ok).toBe(true);
  if (!history.ok) throw new Error(history.error.message);
  expect(history.data.session.modelUseBlocked).toBe(true);
  expect(history.data.items.slice(0, 2)).toEqual(first.data.items);
  expect(await app.startRun(request)).toMatchObject({ ok: false, error: { code: 'session_scope_revoked' } });
  expect(prepares).toBe(2);
  expect(requestCount).toBe(1);
  expect(await app.close()).toMatchObject({ ok: true, data: { closed: true } });
  const db = new Database(paths.databaseFile, { readonly: true });
  try {
    expect(db.query("SELECT json_extract(metadata_json,'$.model_use_blocked.reason') AS reason, json_extract(metadata_json,'$.model_use_blocked.documentIds[0]') AS documentId FROM sessions WHERE id=?")
      .get(sessionId)).toEqual({ reason: 'document_use_revoked', documentId });
  }
  finally { db.close(); }
});

describe('Pi argument schema conversion', () => {
  it('preserves all supported strict Zod constraints through the installed Pi validator', async () => {
    for (const name of INVOICE_TOOL_NAMES) {
      const schema = invoiceToolSchemas[name].input;
      const parameters = toPiParameters(schema);
      expect((parameters as { type?: unknown }).type).toBe('object');
      const piTool = { name, description: name, parameters } as Parameters<typeof validateToolArguments>[0];
      const valid = examples[name];
      expect(schema.safeParse(valid).success).toBe(true);
      expect(validateToolArguments(piTool, { name, arguments: structuredClone(valid) } as never)).toEqual(valid);

      const invalid = { ...(valid as Record<string, unknown>), untrustedExtra: true };
      expect(schema.safeParse(invalid).success).toBe(false);
      expect(() => validateToolArguments(piTool, { name, arguments: invalid } as never)).toThrow();
    }
  });

  it('refuses defaults, coercion, effects and unsupported checks instead of weakening schemas', async () => {
    expect(() => toPiParameters(z.object({ id: z.number().default(1) }).strict()))
      .toThrow('tool_schema_unsupported');
    expect(() => toPiParameters(z.object({ id: z.coerce.number() }).strict()))
      .toThrow('tool_schema_unsupported');
    expect(() => toPiParameters(z.object({ id: z.string().transform(Number) }).strict()))
      .toThrow('tool_schema_unsupported');
    expect(() => toPiParameters(z.object({ id: z.string().email() }).strict()))
      .toThrow('tool_schema_unsupported');
    expect(() => toPiParameters(z.object({ id: z.string().regex(/^a/).regex(/z$/) }).strict()))
      .toThrow('tool_schema_unsupported');
  });

  it('keeps the strongest repeated string bounds when producing Pi parameters', () => {
    const schema = z.object({ value: z.string().min(5).min(2).max(6).max(10) }).strict();
    const piTool = {
      name: 'bounded', description: 'bounded', parameters: toPiParameters(schema),
    } as Parameters<typeof validateToolArguments>[0];
    expect(() => validateToolArguments(piTool, { name: 'bounded', arguments: { value: 'abc' } } as never)).toThrow();
    expect(() => validateToolArguments(piTool, { name: 'bounded', arguments: { value: '1234567' } } as never)).toThrow();
    expect(validateToolArguments(piTool, { name: 'bounded', arguments: { value: '12345' } } as never)).toEqual({ value: '12345' });
  });
});
