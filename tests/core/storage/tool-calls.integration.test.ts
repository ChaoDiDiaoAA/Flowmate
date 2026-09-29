import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'bun:test';
import { appError } from '@flowmate/contracts';
import { deferCleanup } from '../../support/resources.ts';
import { openDatabase } from '../../../packages/core/src/storage/database.ts';

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
    parser_name,parser_version,status,metadata_json,created_at,updated_at) VALUES
    (1,'fixture','doc-1','v1',1,2,'fixture','1','available','{}',?,?)`).run(store.stamp, store.stamp);
  store.db.query(`INSERT INTO jobs(id,document_id,goal,input_json,status,created_at,updated_at) VALUES
    (4,1,'Review','{}','running',?,?)`).run(store.stamp, store.stamp);
  store.db.query(`UPDATE runs SET job_id=4,scope_json=? WHERE id=?`).run(JSON.stringify({ version: 2,
    allowedTools: ['save_invoice_candidate'], allowedDocumentIds: [1], allowedArtifactIds: [1, 2], allowedResourcePaths: [] }), store.runId);
}

function missingField() {
  return { raw: null, normalized: null, state: 'missing' as const, alternatives: [], sources: [] };
}

describe('ToolCall and business event storage', () => {
  it('deduplicates only the same native request and preserves fixed arguments and terminal facts', () => {
    const store = makeStore();
    const request = { runId: store.runId, sessionId: store.sessionId, nativeToolCallId: 'native-call-1',
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
    const first = store.toolCalls.request({ runId: store.runId, sessionId: store.sessionId, nativeToolCallId: 'native-call-1',
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
    const second = store.toolCalls.request({ runId: store.runId, sessionId: store.sessionId, nativeToolCallId: 'native-call-2',
      toolName: 'list_invoice_pages', toolVersion: '1', effect: 'READ', rawArguments: {}, requestedAt: store.stamp });
    expect(second.ok).toBe(true);
    expect(store.toolCalls.list({ runId: store.runId, limit: 1 })).toMatchObject({ ok: true, data: { items: [{ nativeToolCallId: 'native-call-2' }], nextBeforeId: 2 } });
    expect(store.toolCalls.list({ runId: store.runId, beforeId: 2, limit: 1 })).toMatchObject({ ok: true, data: { items: [{ nativeToolCallId: 'native-call-1' }], nextBeforeId: null } });

    const db = store.db;
    db.query(`INSERT INTO artifacts(id,kind,relative_path,bytes,mime_type,metadata_json,created_at) VALUES
      (1,'original','documents/1/original.pdf',1,'application/pdf','{}',?),
      (2,'parsed','documents/1/parsed.json',1,'application/json','{}',?)`).run(store.stamp, store.stamp);
    db.query(`INSERT INTO documents(id,source_key,source_record_id,version,original_artifact_id,parsed_artifact_id,
      parser_name,parser_version,status,metadata_json,created_at,updated_at) VALUES
      (1,'fixture','doc-1','v1',1,2,'fixture','1','available','{}',?,?)`).run(store.stamp, store.stamp);
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
    const call = store.toolCalls.request({ runId: store.runId, sessionId: store.sessionId, nativeToolCallId: 'save-call-1',
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

  it('proves original evidence reached a later model request before accepting its source reference', () => {
    const store = makeStore();
    store.db.query(`INSERT INTO artifacts(id,kind,relative_path,bytes,mime_type,metadata_json,created_at) VALUES
      (1,'original','documents/1/original.png',1,'image/png','{}',?),
      (2,'parsed','documents/1/parsed.json',1,'application/json','{}',?)`).run(store.stamp, store.stamp);
    store.db.query(`INSERT INTO documents(id,source_key,source_record_id,version,original_artifact_id,parsed_artifact_id,
      parser_name,parser_version,status,metadata_json,created_at,updated_at) VALUES
      (1,'fixture','doc-1','v1',1,2,'fixture','1','available','{}',?,?)`).run(store.stamp, store.stamp);
    const source = { documentId: 1, version: 'v1', artifactId: 1, page: 1, blockId: null, quote: null };
    const call = store.toolCalls.request({ runId: store.runId, sessionId: store.sessionId,
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
    expect(store.toolCalls.wasOriginalEvidenceDelivered({ sessionId: store.sessionId, source })).toEqual({ ok: true, data: false });
    expect(store.toolCalls.recordDelivery({ toolCallId: call.data.toolCallId, delivery: { version: 1, state: 'message_observed',
      messageObservedAt: store.stamp, includedInCallSequence: 2, requestDispatchedAt: null, error: null } }).ok).toBe(true);
    expect(store.toolCalls.recordDelivery({ toolCallId: call.data.toolCallId, delivery: { version: 1, state: 'request_observed',
      messageObservedAt: store.stamp, includedInCallSequence: 2, requestDispatchedAt: store.stamp, error: null } }).ok).toBe(true);
    expect(store.toolCalls.wasOriginalEvidenceDelivered({ sessionId: store.sessionId, source })).toEqual({ ok: true, data: true });
    expect(store.toolCalls.wasOriginalEvidenceDelivered({ sessionId: store.sessionId,
      source: { ...source, quote: 'INV-123' } })).toEqual({ ok: true, data: true });
    expect(store.toolCalls.wasOriginalEvidenceDelivered({ sessionId: store.sessionId,
      source: { ...source, version: 'v2' } })).toEqual({ ok: true, data: false });
    expect(store.toolCalls.wasOriginalEvidenceDelivered({ sessionId: store.sessionId + 1, source })).toEqual({ ok: true, data: false });
  });
});
