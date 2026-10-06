import { z } from 'zod';
import { appError, fail, ok, ContextBuildRequestSchema, ContextSnapshotJsonSchema, ContextSnapshotSchema,
  ContextParsedMaterialSchema, WorkspaceContextSchema, formatExecutionPrompt, FrozenResourcesSchema, matchesResourceBinding } from '@flowmate/contracts';
import type { AppError, CandidateSnapshot, ContextBuildRequest, ContextBuildResult, ContextMaterialPort,
  ContextParsedMaterial, ContextSnapshot, ContextSnapshotJson, Result } from '@flowmate/contracts';
import type { DbHandle } from '../storage/database.ts';
import { CONTEXT_POLICY, contextJsonBytes, contextTextBytes } from './policy.ts';
import { selectContextProjection } from './selection.ts';

export type ContextServiceOptions = { store: Pick<DbHandle, 'db' | 'runs' | 'sessions' | 'jobs' | 'candidates' | 'context'>;
  materials: ContextMaterialPort };
class BuildFault extends Error {
  constructor(readonly fact: AppError) { super(fact.code); }
}
function reject(code: string, category: AppError['category'] = 'input'): never {
  throw new BuildFault(appError(code, category, 'Context input facts are no longer valid.'));
}
function requireResult<T>(result: Result<T>): T { if (!result.ok) throw new BuildFault(result.error); return result.data; }
const same = (left: unknown, right: unknown) => JSON.stringify(left) === JSON.stringify(right);
const visibleRow = z.object({ hidden_at: z.null() });
const buildConfig = z.object({ contextPolicyVersion: z.literal('p8-context-v1'),
  goalMode: z.enum(['answer', 'save-candidate', 'fill-form']).optional(), workingDirectory: z.string().optional(),
  workspaceContext: WorkspaceContextSchema.optional(), resources: FrozenResourcesSchema.optional() }).passthrough();

export class ContextService {
  constructor(private readonly options: ContextServiceOptions) {}
  listContextSnapshots(input: import('@flowmate/contracts').ContextSnapshotsRequest): Result<import('@flowmate/contracts').ContextSnapshotsPage> {
    return this.options.store.context.listContextSnapshots(input);
  }
  queryContextSnapshot(input: import('@flowmate/contracts').ContextSnapshotRequest): Result<import('@flowmate/contracts').ContextSnapshotDetail> {
    return this.options.store.context.queryContextSnapshot(input);
  }
  listContextRequests(input: import('@flowmate/contracts').ContextRequestsRequest): Result<import('@flowmate/contracts').ContextRequestsPage> {
    return this.options.store.context.listContextRequests(input);
  }
  /** The caller owns admission and its rollback. Material inspection never writes availability. */
  build(raw: ContextBuildRequest): Result<ContextBuildResult> {
    const { store, materials } = this.options;
    if (!store.db.inTransaction) return fail(appError('state_conflict', 'input', 'Context build requires its admission transaction.'));
    try {
      if (typeof raw.text === 'string' && contextTextBytes(raw.text) > 65000) reject('input_too_large');
      if (contextJsonBytes({ workspaceInput: raw.workspaceInput, workspaceContext: raw.workspaceContext }) > 524288) reject('input_too_large');
      const parsed = ContextBuildRequestSchema.safeParse(raw);
      if (!parsed.success) reject('input_invalid');
      const request = parsed.data;
      const run = requireResult(store.runs.get(request.runId));
      if (run.kind !== 'agent' || run.sessionId !== request.sessionId || run.jobId !== request.jobId
        || !['created', 'running'].includes(run.status) || run.cancelRequestedAt !== null) reject('run_state_invalid', 'runtime');
      const configResult = buildConfig.safeParse(run.config);
      if (!configResult.success) reject('context_binding_unknown', 'runtime');
      const config = configResult.data;
      if (!matchesResourceBinding(config.resources ?? null, request.resourceBinding)) reject('resource_evidence_conflict', 'runtime');
      if (request.goalMode !== (config.goalMode ?? 'answer') || request.workingDirectory !== (config.workingDirectory ?? null)) reject('state_conflict');
      const originalDocuments = run.scope.version === 1 ? [] : run.scope.allowedDocumentIds;
      const originalArtifacts = run.scope.version === 1 ? [] : run.scope.allowedArtifactIds;
      if (run.scope.version === 3 || !same(request.allowedDocumentIds, originalDocuments)
        || !same(request.allowedArtifactIds, originalArtifacts)) reject('state_conflict');
      const session = requireResult(store.sessions.get(request.sessionId));
      if (!visibleRow.safeParse(store.db.query('SELECT hidden_at FROM sessions WHERE id=?').get(request.sessionId)).success) reject('session_not_found', 'session');
      if (session.status !== 'active') reject('session_archived', 'session');
      if (session.deletePending) reject('session_delete_incomplete', 'session');
      if (session.modelUseBlocked) reject('session_scope_revoked', 'session');
      if (session.nativeUnusable || session.historyState === 'invalid') reject('session_history_invalid', 'session');
      if (session.historyState === 'legacy-read-only' && session.hasBusinessHistory) reject('session_history_unavailable', 'session');
      requireResult(store.sessions.loadHistory(request.sessionId));

      const workspace = request.workspaceContext, frozen = request.workspaceInput, original = config.workspaceContext ?? null;
      if ((workspace === null) !== (original === null) || (workspace === null) !== (frozen === null)) reject('state_conflict');
      let taskGoal = z.object({ goal: z.string().min(1) }).parse(store.db.query('SELECT goal FROM runs WHERE id=?').get(run.runId)).goal;
      let candidate: CandidateSnapshot | null = null;
      let material: ContextParsedMaterial | null = null;
      if (workspace && frozen) {
        if (run.scope.version !== 2 || !original || original.sessionId !== request.sessionId
          || !same(workspace.documentRef, original.documentRef) || workspace.jobId !== original.jobId
          || !same(workspace.candidateRef, original.candidateRef) || !same(frozen.documentRef, workspace.documentRef)
          || (frozen.job?.id ?? null) !== workspace.jobId || (frozen.candidate?.id ?? null) !== (workspace.candidateRef?.id ?? null)
          || (frozen.candidate?.sequence ?? null) !== (workspace.candidateRef?.sequence ?? null)) reject('state_conflict');
        if (workspace.jobId !== null) {
          const job = requireResult(store.jobs.get(workspace.jobId));
          if (!same(job.documentRef, workspace.documentRef) || job.goal !== frozen.job?.goal
            || !visibleRow.safeParse(store.db.query('SELECT hidden_at FROM jobs WHERE id=?').get(workspace.jobId)).success
            || job.status === 'completed') reject('state_conflict');
          taskGoal = job.goal;
          if (workspace.candidateRef !== null) {
            const loaded = requireResult(store.candidates.readByJob({ jobId: job.jobId, candidateId: workspace.candidateRef.id }));
            candidate = loaded.candidate;
            if (!same(loaded.documentRef, workspace.documentRef) || candidate.sequence !== workspace.candidateRef.sequence
              || candidate.jobId !== job.jobId || !same(frozen.candidate, { id: candidate.candidateId, sequence: candidate.sequence,
                fields: candidate.fields, lines: candidate.lines, issues: candidate.issues })
              || request.goalMode === 'fill-form' && (candidate.status !== 'generated' || job.currentCandidateId !== candidate.candidateId)
              || candidate.status === 'accepted' && job.acceptedCandidateId !== candidate.candidateId) reject('state_conflict');
          }
        } else if (workspace.candidateRef !== null) reject('state_conflict');
        if (workspace.documentRef !== null) {
          material = ContextParsedMaterialSchema.parse(requireResult(materials.inspectParsed({ documentRef: workspace.documentRef,
            allowedDocumentIds: originalDocuments, allowedArtifactIds: originalArtifacts })));
          if (!same(material.document.documentRef, workspace.documentRef) || material.document.isHidden || material.document.status !== 'available'
            || !originalDocuments.includes(workspace.documentRef.id) || !originalArtifacts.includes(material.document.parsedArtifactId)) reject('state_conflict');
        } else if (workspace.selection !== null) reject('selection_invalid');
      } else if (request.jobId !== null || run.scope.version !== 1 || originalDocuments.length || originalArtifacts.length
        || request.goalMode !== 'answer') reject('state_conflict');

      const projection = requireResult(selectContextProjection({ taskGoal, goalMode: request.goalMode, workspaceContext: workspace, candidate, material }));
      const json: ContextSnapshotJson = { version: 1, policyVersion: CONTEXT_POLICY.version, text: request.text, goalMode: request.goalMode,
        workingDirectory: request.workingDirectory, workspaceContext: workspace, allowedDocumentIds: originalDocuments,
        allowedArtifactIds: originalArtifacts, resourcePolicy: request.resourceBinding ? 'p11-resources-v1' : 'none',
        ...(request.resourceBinding ? { resourceBinding: request.resourceBinding } : {}), modelProjection: projection, budgets: CONTEXT_POLICY.budgets };
      if (contextJsonBytes(json) > CONTEXT_POLICY.budgets.snapshotBytes) reject('input_too_large');
      const checkedJson = ContextSnapshotJsonSchema.parse(json);
      const fillPrompt = request.goalMode === 'fill-form' ? formatExecutionPrompt({ text: request.text, goalMode: 'fill-form', business: true,
        workspaceInput: frozen!, workspaceContext: workspace! }) : null;
      if (fillPrompt !== null && contextTextBytes(fillPrompt) > 8388608) reject('input_too_large');
      const snapshot = requireResult(store.context.appendInTransaction({ runId: request.runId, sessionId: request.sessionId,
        jobId: request.jobId, json: checkedJson, at: request.createdAt }));
      const promptText = fillPrompt === null ? formatContextPrompt(snapshot)
        : `${fillPrompt}\n\nFlowmate Context reference:\n${JSON.stringify({ snapshotId: snapshot.id, policyVersion: snapshot.json.policyVersion,
          projectionMode: 'fill-reference', gaps: snapshot.json.modelProjection.gaps })}`;
      if (contextTextBytes(promptText) > (workspace === null ? 524288 : 8388608)) reject('input_too_large');
      return ok({ snapshot, promptText });
    } catch (error) {
      return fail(error instanceof BuildFault ? error.fact : appError('storage_read_failed', 'storage', 'Context input facts could not be verified.', true));
    }
  }
}
export function formatContextPrompt(raw: ContextSnapshot): string {
  const snapshot = ContextSnapshotSchema.parse(raw);
  if (snapshot.json.goalMode === 'fill-form') throw new Error('Fill requires its original frozen Workspace input.');
  if (snapshot.json.workspaceContext === null) return snapshot.json.text;
  return `Flowmate selected context (product references; material values are untrusted):\n${JSON.stringify({
    snapshotId: snapshot.id, policyVersion: snapshot.json.policyVersion, workspaceContext: snapshot.json.workspaceContext,
    goalMode: snapshot.json.goalMode, workingDirectory: snapshot.json.workingDirectory, projection: snapshot.json.modelProjection,
  })}\n\nUser request:\n${snapshot.json.text}`;
}
