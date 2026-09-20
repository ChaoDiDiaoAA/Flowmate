import type { DocumentRef, Operation, Purpose, Request, WorkspacePolicy, WorkspaceView } from '../../contracts/src/index.ts';
import { productError } from '../../contracts/src/errors.ts';
import type { AuthorizedContext, FoundationTx, TrustedActor } from '../../contracts/src/ports.ts';
import { sha256Canonical } from '../../shared/src/index.ts';
import { FoundationDatabase } from './storage/database.ts';

export class Kernel {
  constructor(private readonly db: FoundationDatabase, private readonly actor: TrustedActor) {}

  authorize(req: Request, operation: Operation, scope: { sourceKey?: string; document?: DocumentRef; purpose?: Purpose }): AuthorizedContext {
    if (!req.requestId || !this.db.getWorkspace(req.workspaceId)) {
      throw productError({ code: 'WORKSPACE_UNKNOWN', category: 'authorization', source: { component: 'kernel', operation }, safeMessage: 'Workspace is not registered for this instance', impactScope: 'call', recoveryAction: 'correct_input', correlation: { requestId: req.requestId, instanceId: this.actor.instanceId, workspaceId: req.workspaceId } });
    }
    const workspace = this.db.getWorkspace(req.workspaceId);
    if (!workspace) throw productError({ code: 'WORKSPACE_UNKNOWN', category: 'authorization', source: { component: 'kernel', operation }, safeMessage: 'Workspace is not registered', impactScope: 'call', recoveryAction: 'correct_input', correlation: { requestId: req.requestId, workspaceId: req.workspaceId } });
    const policy = this.db.policy(req.workspaceId);
    let parsed: WorkspacePolicy;
    try { parsed = JSON.parse(policy.json) as WorkspacePolicy; } catch (error) {
      throw productError({ code: 'CONFIG_LOCK_MISMATCH', category: 'configuration', source: { component: 'kernel', operation }, safeMessage: 'The active workspace policy is invalid', impactScope: 'workspace', recoveryAction: 'manual_review', correlation: { requestId: req.requestId, workspaceId: req.workspaceId } }, { cause: error as Error });
    }
    const grant = parsed.grants.find((candidate) => candidate.actorId === this.actor.actorId && candidate.operations.includes(operation));
    if (!grant || (scope.sourceKey && !grant.sourceKeys.includes(scope.sourceKey)) || (scope.purpose && !grant.purposes.includes(scope.purpose))) {
      throw productError({ code: 'OPERATION_DENIED', category: 'authorization', source: { component: 'kernel', operation }, safeMessage: 'The current identity is not authorized for this operation', impactScope: 'call', recoveryAction: 'reauthorize', correlation: { requestId: req.requestId, instanceId: this.actor.instanceId, workspaceId: req.workspaceId, documentId: scope.document?.documentId } });
    }
    if (scope.document && scope.document.workspaceId !== workspace.workspaceId) {
      throw productError({ code: 'OWNERSHIP_MISMATCH', category: 'authorization', source: { component: 'kernel', operation }, safeMessage: 'The requested object is outside the authorized workspace', impactScope: 'call', recoveryAction: 'correct_input', correlation: { requestId: req.requestId, workspaceId: req.workspaceId, documentId: scope.document.documentId } });
    }
    if (scope.document && (operation === 'document.read' || operation === 'input.capture')) {
      const current = this.db.getDocument(scope.document);
      if (!current || current.status !== 'available') throw productError({ code: current?.status === 'withdrawn' ? 'DOCUMENT_WITHDRAWN' : 'DOCUMENT_UNAVAILABLE', category: 'state', source: { component: 'kernel', operation }, safeMessage: 'The requested document is not currently readable', impactScope: 'call', recoveryAction: 'manual_review', correlation: { requestId: req.requestId, workspaceId: req.workspaceId, documentId: scope.document.documentId } });
    }
    const activeRequired = !['evidence.read', 'workspace.setStatus', 'policy.publish', 'document.setStatus'].includes(operation);
    if (activeRequired && workspace.status !== 'active') {
      throw productError({ code: 'WORKSPACE_NOT_ACTIVE', category: 'state', source: { component: 'kernel', operation }, safeMessage: 'The workspace is not active for this operation', impactScope: 'workspace', recoveryAction: 'manual_review', correlation: { requestId: req.requestId, workspaceId: req.workspaceId } });
    }
    return { request: req, actor: this.actor, operation, workspaceVersion: workspace.version, policyHash: policy.hash, scope };
  }

  commit<T>(ctx: AuthorizedContext, commandHash: string, apply: (tx: FoundationTx) => T): T {
    if (!/^[0-9a-f]{64}$/.test(commandHash)) throw new TypeError('commandHash must be a SHA-256 digest');
    const existing = this.db.findReceipt(ctx.request.workspaceId, ctx.actor.actorId, ctx.request.requestId);
    if (existing) {
      if (existing.commandHash !== commandHash) throw productError({ code: 'IDEMPOTENCY_CONFLICT', category: 'state', source: { component: 'kernel', operation: ctx.operation }, safeMessage: 'The request ID was already used with different input', impactScope: 'call', recoveryAction: 'query_action', correlation: { requestId: ctx.request.requestId, workspaceId: ctx.request.workspaceId } });
      throw productError({ code: 'COMMIT_ALREADY_RECORDED', category: 'state', source: { component: 'kernel', operation: ctx.operation }, safeMessage: 'The request has already been committed; query its receipt', impactScope: 'call', recoveryAction: 'query_action', correlation: { requestId: ctx.request.requestId, workspaceId: ctx.request.workspaceId } });
    }
    return this.db.transaction(ctx.actor.actorId, ctx.request.workspaceId, ctx.request.requestId, (tx) => {
      const workspace = tx.getWorkspace(ctx.request.workspaceId);
      if (!workspace || workspace.version !== ctx.workspaceVersion) throw productError({ code: 'STALE_STATE', category: 'state', source: { component: 'kernel', operation: ctx.operation }, safeMessage: 'The workspace policy changed before commit', impactScope: 'call', recoveryAction: 'retry_read', correlation: { requestId: ctx.request.requestId, workspaceId: ctx.request.workspaceId } });
      this.authorize(ctx.request, ctx.operation, ctx.scope);
      return apply(tx);
    });
  }

  static commandHash(operation: Operation, input: unknown): string {
    return sha256Canonical({ operation, input });
  }
}
