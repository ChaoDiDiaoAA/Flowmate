import { describe, expect, it } from 'bun:test';
import { createContextRepository, createFileStore } from '@flowmate/core';
import { createDocumentService } from '@flowmate/data';
import { appError, ContextSnapshotJsonSchema, formatExecutionPrompt, InvoiceFormDraftSchema, invoiceHeaderFields, invoiceFieldDisplayValue } from '@flowmate/contracts';
import { validateHumanInvoiceCandidate } from '@flowmate/employee-invoice';
import type { ContextBuildRequest, Result, WorkspaceSelection } from '@flowmate/contracts';
import { makeSelectedCandidate } from '../../support/selected-candidate.ts';
import { ContextService, formatContextPrompt } from '../../../packages/core/src/context/service.ts';

function need<T>(result: Result<T>): T { if (!result.ok) throw new Error(result.error.code); return result.data; }
function fixture(selection: WorkspaceSelection | null = null, fill = false, human = false, workingDirectory?: string) {
  const base = makeSelectedCandidate(false, true);
  const store = { ...base, context: createContextRepository({ db: base.db, loadHistory: id => base.sessions.loadHistory(id) }) };
  need(store.sessions.saveHistory(store.session.sessionId, { storageVersion: 1,
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
