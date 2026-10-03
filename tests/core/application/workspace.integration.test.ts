import { describe, expect, it } from 'bun:test';
import { appError, fail, ok, invoiceHeaderFields, InvoiceFormDraftSchema, formatExecutionPrompt } from '@flowmate/contracts';
import { WorkspaceService } from '../../../packages/core/src/workspace/service.ts';
import { makeSelectedCandidate } from '../../support/selected-candidate.ts';
import { mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { ProviderConfig, Result, WorkspaceExpectation } from '@flowmate/contracts';

function need<T>(result: Result<T>): T { if (!result.ok) throw new Error(result.error.code); return result.data; }
function chooseTaxSelection(f: ReturnType<typeof makeSelectedCandidate>) {
  return { formatVersion: 1 as const, kind: 'field' as const, target: 'candidate' as const,
    targetId: f.candidateId, targetVersion: 1, fieldPath: 'fields.taxAmount' };
}
function chooseTax(f: ReturnType<typeof makeSelectedCandidate>) {
  return need(f.workspace.update({ expectedRevision: f.selectedWorkspace.revision, at: f.stamp, change: { kind: 'selection',
    selection: chooseTaxSelection(f) } }, f.verify));
}
function runRequest(f: ReturnType<typeof makeSelectedCandidate>, workspace = need(f.workspace.read(f.stamp))) {
  return { sessionId: f.session.sessionId, expected: { revision: workspace.revision, documentRef: workspace.documentRef,
    jobId: workspace.jobId, candidateRef: workspace.candidateRef, sessionId: f.session.sessionId }, goalMode: 'save-candidate' as const,
    text: 'Save another controlled candidate.', messageTimestamp: 2, goal: 'Review form fixture', config: f.config,
    usage: f.usage, cleanup: f.cleanup, createdAt: f.stamp };
}

function registerOtherMaterial(f: ReturnType<typeof makeSelectedCandidate>, sameSource: boolean) {
  const original = need(f.documents.getArtifact(1)), parsed = need(f.documents.getArtifact(2));
  const sourceRecordId = sameSource ? original.metadata.sourceRecordId : 'independent-invoice';
  const version = sameSource ? 'v2' : 'v1';
  const copyArtifact = (artifact: typeof original, artifactId: number) => {
    const name = artifact.kind === 'original' ? 'original.png' : 'parsed.json';
    const relativePath = `artifacts/${artifactId}/${name}`;
    mkdirSync(join(f.root, 'artifacts', String(artifactId)), { recursive: true });
    writeFileSync(join(f.root, relativePath), readFileSync(join(f.root, artifact.relativePath)));
    return { ...artifact, artifactId, relativePath, createdAt: f.stamp,
      metadata: { ...artifact.metadata, sourceRecordId, sourceVersion: version } };
  };
  return need(f.documents.register({ documentId: 2, sourceKey: original.metadata.sourceKey, sourceRecordId, version,
    originalArtifact: { ...copyArtifact(original, 3), kind: 'original' },
    parsedArtifact: { ...copyArtifact(parsed, 4), kind: 'parsed' }, status: 'available',
    metadata: { version: 2, pageCount: 1, warnings: [], allowedUsesClaim: ['synthetic test'],
      licenseVerification: 'not_verified', unavailableReason: null }, createdAt: f.stamp, updatedAt: f.stamp }));
}

describe('P7 Workspace authority and recovery', () => {
  it('reads persisted versioned selection and preserves it on view and Session changes', () => {
    const fixture = makeSelectedCandidate();
    const selection = { formatVersion: 1, kind: 'field', target: 'candidate', targetId: fixture.candidateId,
      targetVersion: 1, fieldPath: 'fields.taxAmount' };
    fixture.db.query('UPDATE workspace SET selection_json=?').run(JSON.stringify(selection));
    const service = new WorkspaceService(fixture.workspace, () => fixture.stamp, fixture.verify);
    expect(service.read()).toMatchObject({ ok: true, data: { selection } });
    expect(service.update({ expectedRevision: fixture.selectedWorkspace.revision,
      change: { kind: 'view', view: 'parsed' } })).toMatchObject({ ok: true, data: { selection } });
  });

  it('persists a valid source selection and treats key order as the same value', () => {
    const fixture = makeSelectedCandidate();
    const service = new WorkspaceService(fixture.workspace, () => fixture.stamp, fixture.verify);
    const selection = { formatVersion: 1, kind: 'source', target: 'document', targetId: 1,
      targetVersion: 'v1', artifactId: 2, page: 1, block: 'b1' };
    const saved = service.update({ expectedRevision: fixture.selectedWorkspace.revision, change: { kind: 'selection', selection } });
    expect(saved).toMatchObject({ ok: true, data: { selection, revision: fixture.selectedWorkspace.revision + 1 } });
    if (!saved.ok) return;
    const same = service.update({ expectedRevision: saved.data.revision, change: { kind: 'selection',
      selection: { block: 'b1', page: 1, artifactId: 2, targetVersion: 'v1', targetId: 1,
        target: 'document', kind: 'source', formatVersion: 1 } } });
    expect(same).toEqual(saved);
    expect(service.update({ expectedRevision: fixture.selectedWorkspace.revision,
      change: { kind: 'selection', selection } })).toMatchObject({ ok: false, error: { code: 'state_conflict' } });
  });

  it('restores a stale supported locator and reports only committed cleanup', () => {
    const fixture = makeSelectedCandidate();
    fixture.db.query('UPDATE workspace SET selection_json=?').run(JSON.stringify({ formatVersion: 1, kind: 'line',
      target: 'candidate', targetId: fixture.candidateId, targetVersion: 1, lineIndex: 0 }));
    const service = new WorkspaceService(fixture.workspace, () => fixture.stamp, fixture.verify);
    expect(typeof service.restore).toBe('function');
    if (typeof service.restore !== 'function') return;
    expect(service.restore()).toMatchObject({ ok: true, data: { workspace: { selection: null,
      revision: fixture.selectedWorkspace.revision + 1, invalidReferences: [] }, clearedReferences: ['selection_location_missing'] } });
  });

  it('rejects a shaped locator outside the actual candidate without any write', () => {
    const f = makeSelectedCandidate();
    const before = f.db.query('SELECT * FROM workspace').get();
    const service = new WorkspaceService(f.workspace, () => f.stamp, f.verify);
    expect(service.update({ expectedRevision: f.selectedWorkspace.revision, change: { kind: 'selection', selection: {
      formatVersion: 1, kind: 'line', target: 'candidate', targetId: f.candidateId, targetVersion: 1, lineIndex: 0 } } }))
      .toMatchObject({ ok: false, error: { code: 'selection_invalid' } });
    expect(f.db.query('SELECT * FROM workspace').get()).toEqual(before);
  });

  it('preserves diagnostics on read and allows a new scene to clear the stale selection', () => {
    const f = makeSelectedCandidate();
    f.db.query('UPDATE workspace SET selection_json=?').run(JSON.stringify({ formatVersion: 1, kind: 'line',
      target: 'candidate', targetId: f.candidateId, targetVersion: 1, lineIndex: 0 }));
    const service = new WorkspaceService(f.workspace, () => f.stamp, f.verify);
    expect(service.read()).toMatchObject({ ok: true, data: { invalidReferences: ['selection_location_missing'] } });
    expect(service.update({ expectedRevision: f.selectedWorkspace.revision, change: { kind: 'view', view: 'parsed' } }))
      .toMatchObject({ ok: false, error: { code: 'selection_invalid' } });
    expect(service.update({ expectedRevision: f.selectedWorkspace.revision, change: { kind: 'document', documentId: null } }))
      .toMatchObject({ ok: true, data: { documentRef: null, jobId: null, selection: null } });
  });

  it('preserves selection for New Session, and clears only the current Session when archiving', () => {
    const f = makeSelectedCandidate();
    const selection = { formatVersion: 1, kind: 'field', target: 'candidate', targetId: f.candidateId,
      targetVersion: 1, fieldPath: 'fields.taxAmount' };
    f.db.query('UPDATE workspace SET selection_json=?').run(JSON.stringify(selection));
    const created = f.sessions.create({ nativeSessionId: 'p7-second', title: 'Second', at: f.stamp, expectedRevision: f.selectedWorkspace.revision });
    expect(created.ok).toBe(true);
    if (!created.ok) return;
    expect(f.workspace.read(f.stamp, f.verify)).toMatchObject({ ok: true, data: { selection, revision: f.selectedWorkspace.revision + 1 } });
    expect(f.sessions.setStatus({ sessionId: f.session.sessionId, expectedStatus: 'active', status: 'archived', at: f.stamp }).ok).toBe(true);
    expect(f.workspace.read(f.stamp)).toMatchObject({ ok: true, data: { sessionId: created.data.sessionId, revision: f.selectedWorkspace.revision + 1 } });
    expect(f.sessions.setStatus({ sessionId: created.data.sessionId, expectedStatus: 'active', status: 'archived', at: f.stamp }).ok).toBe(true);
    expect(f.workspace.read(f.stamp, f.verify)).toMatchObject({ ok: true, data: { sessionId: null, selection, revision: f.selectedWorkspace.revision + 2 } });
  });

  it('repairs only availability with valid material without advancing Workspace revision or time', () => {
    const f = makeSelectedCandidate();
    expect(f.documents.setAvailability({ documentId: 1, status: 'unavailable', reason: 'parsed_document_mismatch', at: f.stamp }).ok).toBe(true);
    const before = f.db.query('SELECT * FROM workspace').get();
    const later = '2026-10-03T01:00:00.000Z';
    const service = new WorkspaceService(f.workspace, () => later, f.verify);
    expect(service.read()).toMatchObject({ ok: true, data: { documentRef: { id: 1 }, invalidReferences: ['document_unavailable'] } });
    expect(service.update({ expectedRevision: f.selectedWorkspace.revision, change: { kind: 'view', view: 'parsed' } }))
      .toMatchObject({ ok: false, error: { code: 'input_unavailable' } });
    expect(service.restore()).toMatchObject({ ok: true, data: { clearedReferences: [], workspace: { invalidReferences: [] } } });
    expect(f.db.query('SELECT * FROM workspace').get()).toEqual(before);
    expect(f.documents.get(1)).toMatchObject({ ok: true, data: { status: 'available', unavailableReason: null, updatedAt: later } });
  });

  it('rolls availability repair and locator cleanup back when the final projection fails', () => {
    const f = makeSelectedCandidate();
    f.documents.setAvailability({ documentId: 1, status: 'unavailable', reason: 'artifact_missing_or_invalid', at: f.stamp });
    f.db.query('UPDATE workspace SET selection_json=?').run(JSON.stringify({ formatVersion: 1, kind: 'line', target: 'candidate',
      targetId: f.candidateId, targetVersion: 1, lineIndex: 0 }));
    const before = f.db.query('SELECT * FROM workspace').get(), document = f.documents.get(1);
    let inspections = 0;
    const verify: typeof f.verify = input => ++inspections === 2 ? fail(appError('input_unavailable', 'input', 'Fixture read fault.', true)) : f.verify(input);
    expect(f.workspace.restore({ expectedRevision: f.selectedWorkspace.revision, at: '2026-10-03T01:00:00.000Z' }, verify))
      .toMatchObject({ ok: false, error: { code: 'storage_write_failed' } });
    expect(f.db.query('SELECT * FROM workspace').get()).toEqual(before);
    expect(f.documents.get(1)).toEqual(document);
  });

  it('keeps references on temporary root failure and clears definite missing material on restore', () => {
    const f = makeSelectedCandidate();
    const before = f.db.query('SELECT * FROM workspace').get();
    const service = new WorkspaceService(f.workspace, () => f.stamp, f.verify);
    renameSync(join(f.root, 'artifacts'), join(f.root, 'artifacts-away'));
    expect(service.restore()).toMatchObject({ ok: false, error: { code: 'input_unavailable' } });
    expect(f.db.query('SELECT * FROM workspace').get()).toEqual(before);
    renameSync(join(f.root, 'artifacts-away'), join(f.root, 'artifacts'));
    unlinkSync(join(f.root, 'artifacts', '2', 'parsed.json'));
    expect(service.restore()).toMatchObject({ ok: true, data: { workspace: { documentRef: null, jobId: null, selection: null,
      sessionId: f.session.sessionId, activeView: 'original', revision: f.selectedWorkspace.revision + 1 }, clearedReferences: ['artifact_missing_or_invalid'] } });
  });

  it('CAS refuses stale recovery after a normal scene update', () => {
    const f = makeSelectedCandidate();
    const revision = f.selectedWorkspace.revision;
    expect(f.workspace.update({ expectedRevision: revision, change: { kind: 'view', view: 'parsed' }, at: f.stamp }, f.verify).ok).toBe(true);
    const before = f.db.query('SELECT * FROM workspace').get();
    expect(f.workspace.restore({ expectedRevision: revision, at: f.stamp }, f.verify))
      .toMatchObject({ ok: false, error: { code: 'state_conflict' } });
    expect(f.db.query('SELECT * FROM workspace').get()).toEqual(before);
  });

  it('treats corrupt candidate authority as blocked facts and never clears it', () => {
    const f = makeSelectedCandidate();
    f.db.exec('PRAGMA foreign_keys=OFF');
    f.db.query('UPDATE jobs SET current_candidate_id=999 WHERE id=?').run(f.jobId);
    f.db.exec('PRAGMA foreign_keys=ON');
    const before = f.db.query('SELECT * FROM workspace').get();
    expect(f.workspace.read(f.stamp, f.verify)).toMatchObject({ ok: false, error: { code: 'storage_corrupt' } });
    expect(f.workspace.restore({ expectedRevision: f.selectedWorkspace.revision, at: f.stamp }, f.verify))
      .toMatchObject({ ok: false, error: { code: 'storage_corrupt' } });
    expect(f.db.query('SELECT * FROM workspace').get()).toEqual(before);
  });

  it('does not cross the safe revision limit through update or current Session archive', () => {
    const f = makeSelectedCandidate();
    f.db.query('UPDATE workspace SET revision=?').run(Number.MAX_SAFE_INTEGER);
    const before = f.db.query('SELECT * FROM workspace').get();
    expect(f.workspace.update({ expectedRevision: Number.MAX_SAFE_INTEGER, change: { kind: 'view', view: 'parsed' }, at: f.stamp }, f.verify))
      .toMatchObject({ ok: false, error: { code: 'state_conflict' } });
    expect(f.sessions.setStatus({ sessionId: f.session.sessionId, expectedStatus: 'active', status: 'archived', at: f.stamp }))
      .toMatchObject({ ok: false, error: { code: 'state_conflict' } });
    expect(f.db.query('SELECT * FROM workspace').get()).toEqual(before);
    expect(f.sessions.get(f.session.sessionId)).toMatchObject({ ok: true, data: { status: 'active' } });
  });

  it.each(['save', 'accept', 'reject'] as const)('%s commits candidate facts, selection cleanup, revision and Activity together', operation => {
    const f = makeSelectedCandidate(), selected = chooseTax(f);
    const request = { operationRef: `p7-${operation}`, jobId: f.jobId, candidateId: f.candidateId,
      expectedCandidateId: f.candidateId, expectedRevision: selected.revision, at: f.stamp };
    const draft = InvoiceFormDraftSchema.parse({ fields: Object.fromEntries(invoiceHeaderFields.map(name => [name, name === 'taxAmount' ? '1.00' : ''])), lines: [], notes: [] });
    const apply = () => operation === 'save' ? f.candidates.saveHuman({ operationRef: request.operationRef, jobId: f.jobId,
      expectedCandidateId: f.candidateId, expectedRevision: selected.revision, basedOnCandidateId: f.candidateId, draft,
      at: f.stamp, validate: () => ok({ checks: [], issues: [] }) }) : operation === 'accept' ? f.candidates.accept({ ...request,
      dirty: false, validate: () => ok({ checks: [], issues: [] }) }) : f.candidates.reject({ ...request, reason: 'Controlled rejection.' });
    const before = { workspace: f.db.query('SELECT * FROM workspace').get(), job: f.db.query('SELECT * FROM jobs').all(),
      candidates: f.db.query('SELECT * FROM invoice_candidates').all(), events: f.db.query('SELECT * FROM business_events').all() };
    f.db.exec("CREATE TRIGGER fail_p7_workspace BEFORE UPDATE ON workspace BEGIN SELECT RAISE(ABORT,'fixture workspace failure'); END;");
    expect(apply()).toMatchObject({ ok: false, error: { code: 'storage_write_failed' } });
    expect({ workspace: f.db.query('SELECT * FROM workspace').get(), job: f.db.query('SELECT * FROM jobs').all(),
      candidates: f.db.query('SELECT * FROM invoice_candidates').all(), events: f.db.query('SELECT * FROM business_events').all() }).toEqual(before);
    f.db.exec('DROP TRIGGER fail_p7_workspace');
    expect(apply()).toMatchObject({ ok: true, data: { workspace: { selection: null, revision: selected.revision + 1 } } });
    expect(f.db.query('SELECT COUNT(*) AS count FROM business_events').get()).toEqual({ count: before.events.length + 1 });
    if (operation === 'save') expect(f.jobs.get(f.jobId)).toMatchObject({ ok: true, data: { currentCandidateId: f.candidateId + 1 } });
    else expect(f.jobs.get(f.jobId)).toMatchObject({ ok: true, data: { currentCandidateId: operation === 'reject' ? null : f.candidateId } });
  });

  it('a model candidate does not grab selection, and explicit candidate selection is atomic and idempotent', () => {
    const f = makeSelectedCandidate(), selected = chooseTax(f), before = f.db.query('SELECT * FROM workspace').get();
    const admitted = need(f.runs.createWorkspaceAgent(runRequest(f, selected), f.verify));
    const startedConfig = { ...f.config, goalMode: 'save-candidate', workspaceContext: admitted.workspaceContext };
    need(f.runs.start(admitted.runId, startedConfig, f.stamp));
    const saved = need(f.candidates.readByJob({ jobId: f.jobId, candidateId: f.candidateId })).candidate;
    const candidate = { fields: saved.fields, lines: saved.lines, notes: [] };
    const call = need(f.toolCalls.request({ runId: admitted.runId, sessionId: f.session.sessionId, nativeToolCallId: 'p7-second-model',
      toolName: 'save_invoice_candidate', toolVersion: '1', effect: 'LOCAL_WRITE', rawArguments: { documentId: 1, candidate }, requestedAt: f.stamp }));
    need(f.toolCalls.fixArguments({ toolCallId: call.toolCallId, finalArguments: { documentId: 1, candidate } }));
    need(f.toolCalls.start({ toolCallId: call.toolCallId, startedAt: f.stamp }));
    const generated = need(f.candidates.save({ runId: admitted.runId, sessionId: f.session.sessionId, nativeToolCallId: 'p7-second-model',
      documentId: 1, candidate, checks: [], issues: [], at: f.stamp }));
    need(f.toolCalls.finish({ toolCallId: call.toolCallId, result: { version: 1, committedCandidateId: generated.receipt.candidateId,
      status: 'succeeded', data: generated.receipt }, cleanup: { version: 1, stopped: true, stopReason: 'tool-completed', errors: [] }, endedAt: f.stamp, stoppedAt: f.stamp }));
    need(f.runs.finish(admitted.runId, { status: 'completed', output: { version: 1, text: 'Saved controlled candidate.', partial: false,
      stopReason: 'stop', responseId: null, responseModel: 'offline', agent: { nativeSessionId: f.session.nativeSessionId, turnCount: 1, modelCallCount: 1 } }, error: null, usage: f.usage,
      tokens: { inputTokens: null, outputTokens: null, totalTokens: null, cost: null, usageComplete: false },
      cleanup: { ...f.cleanup, stopped: true, stopReason: 'native-stop' }, endedAt: f.stamp, stoppedAt: f.stamp, durationMs: 0 }));
    expect(f.db.query('SELECT * FROM workspace').get()).toEqual(before);
    const request = { jobId: f.jobId, candidateId: generated.receipt.candidateId, expectedCandidateId: f.candidateId,
      expectedRevision: selected.revision, at: f.stamp };
    f.db.exec("CREATE TRIGGER fail_p7_selection BEFORE UPDATE ON workspace BEGIN SELECT RAISE(ABORT,'fixture selection failure'); END;");
    expect(f.workspace.selectCandidate(request)).toMatchObject({ ok: false, error: { code: 'storage_write_failed' } });
    expect(f.jobs.get(f.jobId)).toMatchObject({ ok: true, data: { currentCandidateId: f.candidateId } });
    f.db.exec('DROP TRIGGER fail_p7_selection');
    const next = need(f.workspace.selectCandidate(request));
    expect(next.workspace).toMatchObject({ selection: null, revision: selected.revision + 1, candidateRef: { id: generated.receipt.candidateId } });
    expect(f.workspace.selectCandidate(request)).toEqual(ok(next));
    expect(f.workspace.selectCandidate({ ...request, expectedCandidateId: generated.receipt.candidateId, expectedRevision: next.workspace.revision })).toEqual(ok(next));
  });

  it('requires empty invalid diagnostics in update, admission, active freeze and saved delivery', () => {
    const f = makeSelectedCandidate(), selected = chooseTax(f);
    const invalid: typeof f.verify = input => {
      const actual = f.verify(input);
      return actual.ok ? ok({ ...actual.data, invalidReferences: ['selection_location_missing'] }) : actual;
    };
    const before = f.db.query('SELECT * FROM workspace').get(), count = f.db.query('SELECT COUNT(*) AS count FROM runs').get();
    expect(f.workspace.update({ expectedRevision: selected.revision, at: f.stamp, change: { kind: 'view', view: 'parsed' } }, invalid))
      .toMatchObject({ ok: false, error: { code: 'selection_invalid' } });
    expect(f.runs.createWorkspaceAgent(runRequest(f, selected), invalid)).toMatchObject({ ok: false, error: { code: 'selection_invalid' } });
    expect(f.db.query('SELECT * FROM workspace').get()).toEqual(before);
    expect(f.db.query('SELECT COUNT(*) AS count FROM runs').get()).toEqual(count);
    const admitted = need(f.runs.createWorkspaceAgent(runRequest(f, selected), f.verify));
    expect(f.runs.freezeInput({ runId: admitted.runId, sessionId: f.session.sessionId, text: 'Follow up.', expected: runRequest(f, selected).expected, at: f.stamp }, invalid))
      .toMatchObject({ ok: false, error: { code: 'selection_invalid' } });
    const frozen = need(f.runs.freezeInput({ runId: admitted.runId, sessionId: f.session.sessionId, text: 'Follow up.', expected: runRequest(f, selected).expected, at: f.stamp }, f.verify));
    expect(f.runs.verifyInputUse(frozen.content, invalid)).toMatchObject({ ok: false, error: { code: 'selection_invalid' } });
  });

  it.each(['document', 'version', 'job', 'candidate', 'session'] as const)
    ('rejects a different %s on active freeze without changing the original Run, Input or Scope', kind => {
      const f = makeSelectedCandidate();
      let selected = chooseTax(f);
      let otherCandidate: typeof selected.candidateRef = null;
      if (kind === 'candidate') {
        const draft = InvoiceFormDraftSchema.parse({ fields: Object.fromEntries(invoiceHeaderFields
          .map(name => [name, name === 'taxAmount' ? '2.00' : ''])), lines: [], notes: [] });
        const saved = need(f.candidates.saveHuman({ operationRef: 'p7-matrix-second-candidate', jobId: f.jobId,
          expectedCandidateId: f.candidateId, expectedRevision: selected.revision, basedOnCandidateId: f.candidateId,
          draft, at: f.stamp, validate: () => ok({ checks: [], issues: [] }) }));
        expect(saved.changed).toBe(true);
        const secondScene = need(f.workspace.read(f.stamp, f.verify));
        otherCandidate = secondScene.candidateRef;
        expect(otherCandidate).toEqual({ id: saved.candidate.candidateId, sequence: 2 });
        selected = need(f.workspace.selectCandidate({ jobId: f.jobId, candidateId: f.candidateId,
          expectedCandidateId: saved.candidate.candidateId, expectedRevision: secondScene.revision, at: f.stamp })).workspace;
        selected = need(f.workspace.update({ expectedRevision: selected.revision,
          change: { kind: 'selection', selection: chooseTaxSelection(f) }, at: f.stamp }, f.verify));
      }
      const initialRequest = runRequest(f, selected);
      const provider: ProviderConfig = { version: 1, name: 'fixture', revision: 1,
        modelRef: { provider: 'fixture', model: 'offline' }, native: { authPath: join(f.root, 'auth.json'), modelsPath: null },
        parameters: { maxRetries: 0, maxRetryDelayMs: 100 } };
      const ledger = f.sessionInputs;
      const initial = need(ledger.admit({ sessionId: f.session.sessionId, clientSequence: 1, mode: 'prompt',
        text: initialRequest.text, config: provider, goalMode: 'save-candidate', workspace: initialRequest.expected }, () => {
        const admission = f.runs.createWorkspaceAgent(initialRequest, f.verify);
        if (!admission.ok) return admission;
        return ok({ runId: admission.data.runId, content: { version: 2, text: initialRequest.text,
          workspaceContext: admission.data.workspaceContext, workspaceInput: admission.data.workspaceInput,
          allowedDocumentIds: [...admission.data.scope.allowedDocumentIds], allowedArtifactIds: [...admission.data.scope.allowedArtifactIds],
          promptText: formatExecutionPrompt({ text: initialRequest.text, business: true, goalMode: 'save-candidate',
            workspaceInput: admission.data.workspaceInput, workspaceContext: admission.data.workspaceContext }) } });
      }, f.stamp)).input;
      if (initial.runId === null) throw new Error('The initial input must bind a real Run.');
      const originalRun = need(f.runs.get(initial.runId));
      const originalInput = need(ledger.get(initial.inputId));
      expect(originalRun.scope).toMatchObject({ version: 2, allowedDocumentIds: [1], allowedArtifactIds: [2] });
      expect(originalInput?.content).toMatchObject({ workspaceContext: { selection: selected.selection },
        promptText: expect.stringContaining('fields.taxAmount') });
      let scene = selected;
      let expected: WorkspaceExpectation;
      if (kind === 'document' || kind === 'version') {
        const document = registerOtherMaterial(f, kind === 'version');
        scene = need(f.workspace.update({ expectedRevision: scene.revision,
          change: { kind: 'document', documentId: document.documentRef.id }, at: f.stamp }, f.verify));
        expect(scene.documentRef).toEqual({ id: 2, version: kind === 'version' ? 'v2' : 'v1' });
        expected = runRequest(f, scene).expected;
      } else if (kind === 'job') {
        scene = need(f.jobs.create({ clientSequence: 2, expectedRevision: scene.revision,
          documentRef: { id: 1, version: 'v1' }, goal: 'Independent active task', at: f.stamp })).workspace;
        expect(scene.jobId).not.toBe(f.jobId);
        expected = runRequest(f, scene).expected;
      } else if (kind === 'session') {
        const session = need(f.sessions.create({ nativeSessionId: 'p7-matrix-other-session', title: 'Other Session', at: f.stamp }));
        scene = need(f.workspace.update({ expectedRevision: scene.revision,
          change: { kind: 'session', sessionId: session.sessionId }, at: f.stamp }, f.verify));
        expect(scene.sessionId).toBe(session.sessionId);
        expect(f.runs.freezeInput({ runId: initial.runId, sessionId: f.session.sessionId, text: 'Another Session.',
          expected: { ...runRequest(f, scene).expected, sessionId: session.sessionId }, at: f.stamp }, f.verify))
          .toMatchObject({ ok: false, error: { code: 'state_conflict' } });
        // A valid ledger request retains its original Session; the actual current Scene now belongs to another one.
        expected = runRequest(f, scene).expected;
      } else {
        if (!otherCandidate) throw new Error('The second candidate must be a saved actual version.');
        expect(f.workspace.selectCandidate({ jobId: f.jobId, candidateId: otherCandidate.id,
          expectedCandidateId: f.candidateId, expectedRevision: scene.revision, at: f.stamp }))
          .toMatchObject({ ok: false, error: { code: 'state_conflict' } });
        expected = { ...initialRequest.expected, candidateRef: otherCandidate };
      }
      const beforeScene = need(f.workspace.read(f.stamp, f.verify));
      const reject = (expectation: WorkspaceExpectation, sequence: number) => {
        expect(ledger.admit({ sessionId: f.session.sessionId, clientSequence: sequence, mode: 'followUp', runId: initial.runId!,
          text: 'Append against another fixed object.', workspace: expectation }, () => f.runs.freezeInput({ runId: initial.runId!,
          sessionId: f.session.sessionId, text: 'Append against another fixed object.', expected: expectation, at: f.stamp }, f.verify), f.stamp))
          .toMatchObject({ ok: false, error: { code: 'state_conflict' } });
      };
      reject(expected, 2);
      if (kind === 'version') reject({ ...initialRequest.expected, revision: scene.revision, documentRef: { id: 1, version: 'v2' } }, 3);
      if (kind === 'candidate') reject({ ...initialRequest.expected, candidateRef: { id: f.candidateId, sequence: 2 } }, 3);
      expect(need(f.workspace.read(f.stamp, f.verify))).toEqual(beforeScene);
      expect(need(f.runs.get(initial.runId))).toEqual(originalRun);
      expect(need(ledger.get(initial.inputId))).toEqual(originalInput);
      expect(f.db.query('SELECT id FROM session_inputs').all()).toEqual([{ id: initial.inputId }]);
      expect(f.db.query('SELECT COUNT(*) AS count FROM runs WHERE status IN (\'created\',\'running\')').get()).toEqual({ count: 1 });
    });

  it('rolls a selection update back if its second material read fails after the SQL write', () => {
    const f = makeSelectedCandidate(), before = f.db.query('SELECT * FROM workspace').get();
    let reads = 0;
    const verify: typeof f.verify = input => ++reads === 2 ? fail(appError('input_unavailable', 'input', 'Fixture final read fault.', true)) : f.verify(input);
    expect(f.workspace.update({ expectedRevision: f.selectedWorkspace.revision, at: f.stamp, change: { kind: 'view', view: 'parsed' } }, verify))
      .toMatchObject({ ok: false, error: { code: 'storage_write_failed' } });
    expect(f.db.query('SELECT * FROM workspace').get()).toEqual(before);
  });

  it('restores a raw missing Document reference and all dependent references once', () => {
    const f = makeSelectedCandidate(); chooseTax(f);
    f.db.exec('PRAGMA foreign_keys=OFF');
    f.db.query('DELETE FROM documents WHERE id=1').run();
    f.db.exec('PRAGMA foreign_keys=ON');
    const service = new WorkspaceService(f.workspace, () => f.stamp, f.verify);
    const revision = f.selectedWorkspace.revision + 1;
    expect(service.read()).toMatchObject({ ok: true, data: { invalidReferences: expect.arrayContaining(['document_missing']) } });
    expect(service.restore()).toMatchObject({ ok: true, data: { workspace: { documentRef: null, jobId: null, selection: null,
      sessionId: f.session.sessionId, revision: revision + 1 }, clearedReferences: ['document_missing'] } });
  });

  it('restores hidden Job while retaining its valid Document source locator and business pointer', () => {
    const f = makeSelectedCandidate();
    const selection = { formatVersion: 1 as const, kind: 'source' as const, target: 'document' as const, targetId: 1, targetVersion: 'v1', artifactId: 2, page: 1, block: 'b1' };
    f.db.query('UPDATE workspace SET selection_json=?').run(JSON.stringify(selection));
    f.db.query('UPDATE jobs SET hidden_at=? WHERE id=?').run(f.stamp, f.jobId);
    const service = new WorkspaceService(f.workspace, () => f.stamp, f.verify);
    expect(service.restore()).toMatchObject({ ok: true, data: { workspace: { documentRef: { id: 1 }, jobId: null, candidateRef: null,
      selection, revision: f.selectedWorkspace.revision + 1 }, clearedReferences: ['job_hidden'] } });
    expect(f.jobs.get(f.jobId)).toMatchObject({ ok: true, data: { currentCandidateId: f.candidateId } });
  });

  it.each(['archived', 'hidden', 'delete_pending'] as const)('clears only the unavailable %s Session using its raw reference', state => {
    const f = makeSelectedCandidate(), selected = chooseTax(f);
    if (state === 'archived') f.db.query("UPDATE sessions SET status='archived' WHERE id=?").run(f.session.sessionId);
    if (state === 'hidden') f.db.query('UPDATE sessions SET hidden_at=? WHERE id=?').run(f.stamp, f.session.sessionId);
    if (state === 'delete_pending') f.db.query("UPDATE sessions SET metadata_json=? WHERE id=?")
      .run(JSON.stringify({ version: 1, model_use_blocked: null, delete_pending: true }), f.session.sessionId);
    const restored = need(f.workspace.restore({ expectedRevision: selected.revision, at: f.stamp }, f.verify));
    expect(restored).toMatchObject({ workspace: { sessionId: null, documentRef: { id: 1 }, jobId: f.jobId,
      candidateRef: { id: f.candidateId }, selection: selected.selection, revision: selected.revision + 1 }, clearedReferences: ['session_unavailable'] });
    expect(f.workspace.restore({ expectedRevision: restored.workspace.revision, at: f.stamp }, f.verify))
      .toEqual(ok({ workspace: restored.workspace, clearedReferences: [] }));
  });

  it.each(['format', 'json', 'candidate_body'] as const)('blocks %s corruption without cleanup or invalid-reference fallback', kind => {
    const f = makeSelectedCandidate();
    if (kind === 'candidate_body') f.db.query('UPDATE invoice_candidates SET fields_json=? WHERE id=?').run('{"version":1,"values":{}}', f.candidateId);
    else {
      f.db.exec('PRAGMA ignore_check_constraints=ON');
      f.db.query('UPDATE workspace SET selection_json=?').run(kind === 'format' ? '{"formatVersion":2}' : 'invalid-json');
      f.db.exec('PRAGMA ignore_check_constraints=OFF');
    }
    const before = f.db.query('SELECT * FROM workspace').get();
    const service = new WorkspaceService(f.workspace, () => f.stamp, f.verify);
    expect(service.read()).toMatchObject({ ok: false, error: { code: 'storage_corrupt' } });
    expect(service.restore()).toMatchObject({ ok: false, error: { code: 'storage_corrupt' } });
    expect(f.workspace.restore({ expectedRevision: f.selectedWorkspace.revision, at: f.stamp }, f.verify))
      .toMatchObject({ ok: false, error: { code: 'storage_corrupt' } });
    expect(f.db.query('SELECT * FROM workspace').get()).toEqual(before);
  });

  it('opens an existing Job without stealing a candidate and preserves only a compatible Document source', () => {
    const f = makeSelectedCandidate();
    const next = need(f.jobs.create({ clientSequence: 2, expectedRevision: f.selectedWorkspace.revision,
      documentRef: { id: 1, version: 'v1' }, goal: 'Independent task', at: f.stamp }));
    const selection = { formatVersion: 1 as const, kind: 'source' as const, target: 'document' as const, targetId: 1, targetVersion: 'v1', artifactId: 2, page: 1 };
    const selected = need(f.workspace.update({ expectedRevision: next.workspace.revision, at: f.stamp,
      change: { kind: 'selection', selection } }, f.verify));
    expect(f.workspace.update({ expectedRevision: selected.revision, at: f.stamp, change: { kind: 'job', jobId: f.jobId } }, f.verify))
      .toMatchObject({ ok: true, data: { selection, jobId: f.jobId, candidateRef: { id: f.candidateId } } });
    expect(f.jobs.get(next.job.jobId)).toMatchObject({ ok: true, data: { currentCandidateId: null } });
    expect(f.jobs.get(f.jobId)).toMatchObject({ ok: true, data: { currentCandidateId: f.candidateId } });
  });

  it('permits an explicit empty scene without inspecting unrelated unavailable old material', () => {
    const f = makeSelectedCandidate(), selected = chooseTax(f);
    renameSync(join(f.root, 'artifacts'), join(f.root, 'artifacts-away'));
    expect(f.workspace.update({ expectedRevision: selected.revision, at: f.stamp, change: { kind: 'document', documentId: null } }, f.verify))
      .toMatchObject({ ok: true, data: { documentRef: null, jobId: null, candidateRef: null, selection: null,
        sessionId: f.session.sessionId, revision: selected.revision + 1 } });
    renameSync(join(f.root, 'artifacts-away'), join(f.root, 'artifacts'));
  });

  it('allows explicit undefined verification for a proved pure Chat freeze and saved use', () => {
    const f = makeSelectedCandidate();
    const runId = need(f.runs.createAgent({ sessionId: f.session.sessionId, scope: { version: 1, mode: 'chat-text', toolNames: [], resourcePaths: [] },
      goal: 'Chat fixture', input: { version: 1, goal: 'Chat fixture', text: 'Chat', messageTimestamp: 2 },
      config: f.config, usage: f.usage, cleanup: f.cleanup, createdAt: f.stamp }));
    const frozen = need(f.runs.freezeInput({ runId, sessionId: f.session.sessionId, text: 'Chat follow up.', at: f.stamp }, undefined));
    expect(frozen.content).toMatchObject({ workspaceContext: null, workspaceInput: null, allowedDocumentIds: [], allowedArtifactIds: [] });
    expect(f.runs.verifyInputUse(frozen.content, undefined)).toEqual(ok(undefined));
    expect(f.runs.verifyInputUse({ ...frozen.content, allowedDocumentIds: [1] }, undefined))
      .toMatchObject({ ok: false, error: { code: 'storage_corrupt' } });
  });

  it('reports database unreadability without claiming missing or clearing references', () => {
    const f = makeSelectedCandidate(); f.close();
    expect(f.workspace.read(f.stamp, f.verify)).toMatchObject({ ok: false, error: { code: 'storage_read_failed' } });
  });
});
