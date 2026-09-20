import type {
  Application,
  ArtifactRef,
  CapturedInput,
  CommandReceipt,
  DocumentRef,
  DocumentStatus,
  DocumentView,
  InputProjection,
  Operation,
  ParseSelection,
  Purpose,
  PublishedDataset,
  Request,
  StateChange,
  WorkspacePolicy,
  WorkspaceStatus,
  WorkspaceView,
} from '../../contracts/src/index.ts';
import { isProductError, productError } from '../../contracts/src/errors.ts';
import type { AuthorizedContext, DataPort, LoggerPort, TrustedActor } from '../../contracts/src/ports.ts';
import { canonicalJson, sha256Bytes } from '../../shared/src/index.ts';
import { FoundationDatabase } from './storage/database.ts';
import { InstanceFileStore } from './storage/file-store.ts';
import { Kernel } from './kernel.ts';

export type ApplicationFaultPoint = 'before-response';
export type ApplicationFaultInjector = (point: ApplicationFaultPoint, operation: Operation) => void;

/**
 * The application layer is the only public entry point used by the CLI and
 * future Agent adapters. It owns authorization, command hashing and the
 * boundary between data adapters and the transactional foundation.
 */
export class ApplicationService implements Application {
  private closed = false;
  constructor(
    private readonly db: FoundationDatabase,
    private readonly files: InstanceFileStore,
    private readonly data: DataPort,
    private readonly kernel: Kernel,
    private readonly actor: TrustedActor,
    private readonly logger: LoggerPort,
    private readonly faultInjector?: ApplicationFaultInjector,
  ) {}

  shutdown(): void { this.closed = true; }

  async getWorkspace(req: Request): Promise<WorkspaceView> {
    this.authorize(req, 'evidence.read', {});
    const workspace = this.db.getWorkspace(req.workspaceId);
    if (!workspace) throw this.unknownWorkspace(req, 'getWorkspace');
    return workspace;
  }

  async inspectSource(req: Request, input: { sourceKey: string; manifestSha256: string; purpose: Purpose }) {
    const ctx = this.authorize(req, 'source.inspect', { sourceKey: input.sourceKey, purpose: input.purpose });
    this.assertManifestApproved(req, input.sourceKey, input.manifestSha256, input.purpose);
    return this.runLogged(req, 'source.inspect', async () => { const report = await this.data.inspect(ctx, input.sourceKey, input.manifestSha256, input.purpose); this.authorize(req, 'source.inspect', { sourceKey: input.sourceKey, purpose: input.purpose }); return report; });
  }

  async registerSourceDocument(req: Request, input: { sourceKey: string; sampleId: string; manifestSha256: string; purpose: Purpose }): Promise<DocumentView> {
    const ctx = this.authorize(req, 'source.register', { sourceKey: input.sourceKey, purpose: input.purpose });
    this.assertManifestApproved(req, input.sourceKey, input.manifestSha256, input.purpose);
    const commandHash = Kernel.commandHash('source.register', input);
    return this.runLogged(req, 'source.register', async () => {
      const existingReceipt = this.db.findReceipt(req.workspaceId, this.actor.actorId, req.requestId);
      if (existingReceipt && existingReceipt.commandHash !== commandHash) throw this.idempotencyConflict(req, 'source.register');
      if (existingReceipt) {
        const existing = this.db.getLatestDocumentById(req.workspaceId, existingReceipt.resultRef.artifactId.replace(/^r_/, ''));
        if (existing) return existing;
      }
      const prepared = await this.data.prepareSourceDocument(ctx, input);
      let document!: DocumentView;
      this.kernel.commit(ctx, commandHash, (tx) => {
        tx.registerArtifact(prepared.artifactDraft);
        document = tx.registerDocument(prepared.documentDraft, 'pending');
        tx.appendCommandAudit(this.receipt(req, 'source.register', commandHash, this.documentResultRef(document.ref)));
        return document;
      });
      return document;
    });
  }

  async publishDataset(req: Request, input: { sourceKey: string; manifestSha256: string; selection: readonly ParseSelection[]; purpose: Purpose }): Promise<PublishedDataset> {
    const ctx = this.authorize(req, 'source.publish', { sourceKey: input.sourceKey, purpose: input.purpose });
    this.assertManifestApproved(req, input.sourceKey, input.manifestSha256, input.purpose);
    return this.runLogged(req, 'source.publish', async () => {
      const commandHash = Kernel.commandHash('source.publish', input);
      const existingReceipt = this.db.findReceipt(req.workspaceId, this.actor.actorId, req.requestId);
      if (existingReceipt) {
        if (existingReceipt.commandHash !== commandHash) throw this.idempotencyConflict(req, 'source.publish');
        return this.loadPublishedDataset(existingReceipt.resultRef, req.requestId);
      }
      const prepared = await this.data.preparePublication(ctx, input);
      let result!: PublishedDataset;
      this.kernel.commit(ctx, commandHash, (tx) => {
        result = this.data.commitPublication(tx, prepared, prepared.verificationRef);
        const receipt = this.receipt(req, 'source.publish', commandHash, result.manifest);
        tx.appendCommandAudit(receipt);
        return result;
      });
      this.faultInjector?.('before-response', 'source.publish');
      return { ...result, publicationRequestId: req.requestId };
    });
  }

  async readDocument(req: Request, input: { document: DocumentRef; manifest: ArtifactRef; purpose: Purpose }): Promise<InputProjection> {
    const record = this.db.getDocumentRecord(input.document);
    const ctx = this.authorize(req, 'document.read', { sourceKey: record?.source_key, document: input.document, purpose: input.purpose });
    this.assertWorkspaceRef(req.workspaceId, input.manifest);
    return this.runLogged(req, 'document.read', async () => { const projection = await this.data.read(ctx, input.document, input.manifest, input.purpose); this.authorize(req, 'document.read', { sourceKey: record?.source_key, document: input.document, purpose: input.purpose }); return projection; });
  }

  async captureInput(req: Request, input: { document: DocumentRef; manifest: ArtifactRef; purpose: Purpose }): Promise<CapturedInput> {
    const record = this.db.getDocumentRecord(input.document);
    const ctx = this.authorize(req, 'input.capture', { sourceKey: record?.source_key, document: input.document, purpose: input.purpose });
    // Capturing is a stateful read: the caller must be allowed to read the
    // document as well as to create a projection.
    this.authorize(req, 'document.read', { sourceKey: record?.source_key, document: input.document, purpose: input.purpose });
    this.assertWorkspaceRef(req.workspaceId, input.manifest);
    const commandHash = Kernel.commandHash('input.capture', input);
    return this.runLogged(req, 'input.capture', async () => {
      const existingReceipt = this.db.findReceipt(req.workspaceId, this.actor.actorId, req.requestId);
      if (existingReceipt) {
        if (existingReceipt.commandHash !== commandHash) throw this.idempotencyConflict(req, 'input.capture');
        const artifact = this.db.getArtifact(req.workspaceId, existingReceipt.resultRef.artifactId);
        if (!artifact) throw this.evidenceNotFound(req, existingReceipt.resultRef);
        const bytes = await this.files.readInstanceArtifact(artifact.relative_path, artifact.sha256, artifact.size_bytes, this.files.maxFileBytes);
        const projection = JSON.parse(new TextDecoder().decode(bytes)) as InputProjection;
        return { projection: existingReceipt.resultRef, document: projection.document };
      }
      const projection = await this.data.read(ctx, input.document, input.manifest, input.purpose);
      const bytes = new TextEncoder().encode(canonicalJson(projection));
      const draft = await this.files.saveImmutable({
        workspaceId: req.workspaceId,
        kind: 'input/projection',
        bytes,
        sha256: sha256Bytes(bytes),
        mediaType: 'application/json',
        sourceRef: `${input.document.documentId}/${input.document.version}`,
      });
      let ref!: ArtifactRef;
      this.kernel.commit(ctx, commandHash, (tx) => {
        ref = tx.registerArtifact(draft);
        tx.appendCommandAudit(this.receipt(req, 'input.capture', commandHash, ref));
        return ref;
      });
      return { projection: ref, document: input.document };
    });
  }

  async readCapturedInput(req: Request, input: { projection: ArtifactRef; purpose: Purpose }): Promise<InputProjection> {
    this.authorize(req, 'document.read', { purpose: input.purpose });
    this.assertWorkspaceRef(req.workspaceId, input.projection);
    return this.runLogged(req, 'evidence.read', async () => {
      const artifact = this.db.getArtifact(req.workspaceId, input.projection.artifactId);
      if (!artifact || artifact.kind !== 'input/projection') throw this.evidenceNotFound(req, input.projection);
      const bytes = await this.files.readInstanceArtifact(artifact.relative_path, artifact.sha256, artifact.size_bytes, this.files.maxFileBytes);
      let captured: InputProjection;
      try { captured = JSON.parse(new TextDecoder().decode(bytes)) as InputProjection; } catch (error) {
        throw productError({ code: 'INPUT_SCHEMA_INVALID', category: 'input', source: { component: 'application', operation: 'readCapturedInput' }, safeMessage: 'The captured input projection is not readable', impactScope: 'call', recoveryAction: 'manual_review', correlation: { requestId: req.requestId, workspaceId: req.workspaceId, artifactId: input.projection.artifactId } }, { cause: error as Error });
      }
      const currentRecord = this.db.getDocumentRecord(captured.document);
      const ctx = this.authorize(req, 'document.read', { sourceKey: currentRecord?.source_key, document: captured.document, purpose: input.purpose });
      const current = await this.data.read(ctx, captured.document, captured.manifest, input.purpose);
      if (current.parsed.contentHash !== captured.parsed.contentHash || current.document.version !== captured.document.version) throw productError({ code: 'INPUT_PROJECTION_STALE', category: 'state', source: { component: 'application', operation: 'readCapturedInput' }, safeMessage: 'The captured input no longer matches the current document version', impactScope: 'call', recoveryAction: 'retry_read', correlation: { requestId: req.requestId, workspaceId: req.workspaceId, documentId: captured.document.documentId } });
      this.authorize(req, 'document.read', { sourceKey: currentRecord?.source_key, document: captured.document, purpose: input.purpose });
      return current;
    });
  }

  async setDocumentStatus(req: Request, input: { document: DocumentRef; change: StateChange<DocumentStatus> }): Promise<DocumentView> {
    const ctx = this.authorize(req, 'document.setStatus', { document: input.document });
    const recoveryDraft = input.change.targetStatus === 'available' && input.change.expectedStatus === 'unavailable'
      ? await this.data.reverifyDocument(ctx, input.document)
      : undefined;
    validateDocumentTransition(input.change, Boolean(recoveryDraft));
    const commandHash = Kernel.commandHash('document.setStatus', input);
    return this.runLogged(req, 'document.setStatus', async () => {
      const existingReceipt = this.db.findReceipt(req.workspaceId, this.actor.actorId, req.requestId);
      if (existingReceipt) {
        if (existingReceipt.commandHash !== commandHash) throw this.idempotencyConflict(req, 'document.setStatus');
        const current = this.db.getDocument(input.document);
        if (current) return current;
      }
      let result!: DocumentView;
      this.kernel.commit(ctx, commandHash, (tx) => {
        const verificationRef = recoveryDraft ? tx.registerArtifact(recoveryDraft) : undefined;
        result = tx.compareAndSetDocument(input.document, input.change, verificationRef);
        tx.appendCommandAudit(this.receipt(req, 'document.setStatus', commandHash, this.documentResultRef(result.ref)));
        return result;
      });
      return result;
    });
  }

  async setWorkspaceStatus(req: Request, change: StateChange<WorkspaceStatus>): Promise<WorkspaceView> {
    const ctx = this.authorize(req, 'workspace.setStatus', {});
    validateWorkspaceTransition(change);
    const commandHash = Kernel.commandHash('workspace.setStatus', change);
    return this.runLogged(req, 'workspace.setStatus', async () => {
      const existingReceipt = this.db.findReceipt(req.workspaceId, this.actor.actorId, req.requestId);
      if (existingReceipt) {
        if (existingReceipt.commandHash !== commandHash) throw this.idempotencyConflict(req, 'workspace.setStatus');
        const current = this.db.getWorkspace(req.workspaceId);
        if (current) return current;
      }
      let result!: WorkspaceView;
      this.kernel.commit(ctx, commandHash, (tx) => {
        result = tx.compareAndSetWorkspace(req.workspaceId, change);
        tx.appendCommandAudit(this.receipt(req, 'workspace.setStatus', commandHash, this.workspaceResultRef(result)));
        return result;
      });
      return result;
    });
  }

  async publishPolicy(req: Request, input: { expectedRevision: number; policy: WorkspacePolicy }): Promise<WorkspaceView> {
    const ctx = this.authorize(req, 'policy.publish', {});
    if (input.policy.schemaVersion !== 'p0-policy/v1' || input.policy.version < 1) {
      throw productError({ code: 'CONFIG_LOCK_MISMATCH', category: 'configuration', source: { component: 'application', operation: 'publishPolicy' }, safeMessage: 'The policy version is not accepted by this product', impactScope: 'workspace', recoveryAction: 'manual_review', correlation: { requestId: req.requestId, workspaceId: req.workspaceId } });
    }
    validatePolicyForP0(input.policy, this.actor.actorId);
    const commandHash = Kernel.commandHash('policy.publish', input);
    return this.runLogged(req, 'policy.publish', async () => {
      const existingReceipt = this.db.findReceipt(req.workspaceId, this.actor.actorId, req.requestId);
      if (existingReceipt) {
        if (existingReceipt.commandHash !== commandHash) throw this.idempotencyConflict(req, 'policy.publish');
        const current = this.db.getWorkspace(req.workspaceId);
        if (current) return current;
      }
      const policyJson = canonicalJson(input.policy);
      const policyHash = sha256Bytes(new TextEncoder().encode(policyJson));
      let result!: WorkspaceView;
      this.kernel.commit(ctx, commandHash, (tx) => {
        result = tx.updatePolicy(req.workspaceId, input.expectedRevision, policyJson, policyHash);
        tx.appendCommandAudit(this.receipt(req, 'policy.publish', commandHash, this.workspaceResultRef(result)));
        return result;
      });
      return result;
    });
  }

  async findReceipt(req: Request, input: { originalRequestId: string }): Promise<CommandReceipt | null> {
    this.kernel.authorize(req, 'evidence.read', {});
    return this.db.findReceipt(req.workspaceId, this.actor.actorId, input.originalRequestId);
  }

  async readEvidence(req: Request, input: { artifact: ArtifactRef }): Promise<Uint8Array> {
    this.kernel.authorize(req, 'evidence.read', {});
    this.assertWorkspaceRef(req.workspaceId, input.artifact);
    const artifact = this.db.getArtifact(req.workspaceId, input.artifact.artifactId);
    if (!artifact || artifact.sha256 !== input.artifact.sha256 || artifact.size_bytes !== input.artifact.sizeBytes) throw this.evidenceNotFound(req, input.artifact);
    return this.runLogged(req, 'evidence.read', async () => { const bytes = await this.files.readInstanceArtifact(artifact.relative_path, artifact.sha256, artifact.size_bytes, this.files.maxFileBytes); this.authorize(req, 'evidence.read', {}); return bytes; });
  }

  private authorize(req: Request, operation: Operation, scope: { sourceKey?: string; document?: DocumentRef; purpose?: Purpose }): AuthorizedContext {
    if (this.closed) throw productError({ code: 'PRODUCT_CLOSED', category: 'lifecycle', source: { component: 'application', operation }, safeMessage: 'The Flowmate product has already been closed', impactScope: 'call', recoveryAction: 'manual_review', correlation: { requestId: req.requestId, workspaceId: req.workspaceId } });
    return this.kernel.authorize(req, operation, scope);
  }

  private async runLogged<T>(req: Request, operation: string, work: () => Promise<T>): Promise<T> {
    try { return await work(); } catch (error) {
      try {
        this.logger.write({ level: 'error', component: 'application', eventCode: 'operation.failed', safeMessage: isProductError(error) ? error.descriptor.safeMessage : 'The operation failed', requestId: req.requestId, workspaceId: req.workspaceId, attributes: { operation } });
      } catch { /* diagnostics must not replace the primary product error */ }
      throw error;
    }
  }

  private receipt(req: Request, operation: Operation, commandHash: string, resultRef: ArtifactRef): CommandReceipt {
    return { schemaVersion: 'p0-receipt/v1', requestId: req.requestId, actorId: this.actor.actorId, operation, commandHash, committedAt: new Date().toISOString(), resultRef, auditId: crypto.randomUUID() };
  }

  private documentResultRef(ref: DocumentRef): ArtifactRef { return { artifactId: `r_${ref.documentId}`, workspaceId: ref.workspaceId, sha256: ref.originalSha256, sizeBytes: 0, kind: 'command/document' }; }
  private workspaceResultRef(workspace: WorkspaceView): ArtifactRef { return { artifactId: `r_${workspace.workspaceId}_${workspace.version}`, workspaceId: workspace.workspaceId, sha256: workspace.policyHash, sizeBytes: 0, kind: 'command/workspace' }; }
  private assertWorkspaceRef(workspaceId: string, ref: ArtifactRef): void { if (ref.workspaceId !== workspaceId) throw productError({ code: 'OWNERSHIP_MISMATCH', category: 'authorization', source: { component: 'application', operation: 'checkOwnership' }, safeMessage: 'The requested artifact belongs to another workspace', impactScope: 'call', recoveryAction: 'correct_input', correlation: { workspaceId, artifactId: ref.artifactId } }); }
  private unknownWorkspace(req: Request, operation: string) { return productError({ code: 'WORKSPACE_UNKNOWN', category: 'authorization', source: { component: 'application', operation }, safeMessage: 'Workspace is not registered for this instance', impactScope: 'call', recoveryAction: 'correct_input', correlation: { requestId: req.requestId, workspaceId: req.workspaceId } }); }
  private idempotencyConflict(req: Request, operation: string) { return productError({ code: 'IDEMPOTENCY_CONFLICT', category: 'state', source: { component: 'application', operation }, safeMessage: 'The request ID was already used with different input', impactScope: 'call', recoveryAction: 'query_action', correlation: { requestId: req.requestId, workspaceId: req.workspaceId } }); }
  private evidenceNotFound(req: Request, artifact: ArtifactRef) { return productError({ code: 'EVIDENCE_NOT_FOUND', category: 'authorization', source: { component: 'application', operation: 'readEvidence' }, safeMessage: 'The requested evidence is not available in this workspace', impactScope: 'call', recoveryAction: 'correct_input', correlation: { requestId: req.requestId, workspaceId: req.workspaceId, artifactId: artifact.artifactId } }); }
  private async loadPublishedDataset(manifest: ArtifactRef, requestId: string): Promise<PublishedDataset> {
    const artifact = this.db.getArtifact(manifest.workspaceId, manifest.artifactId);
    if (!artifact || artifact.kind !== 'dataset/manifest') throw this.evidenceNotFound({ requestId, workspaceId: manifest.workspaceId }, manifest);
    const bytes = await this.files.readInstanceArtifact(artifact.relative_path, artifact.sha256, artifact.size_bytes, 16_777_216);
    const value = JSON.parse(new TextDecoder().decode(bytes)) as { sourceKey: string; documents: Array<{ documentId: string; version: string; originalSha256: string; parseHash: string }> };
    const documentRefs = value.documents.map((entry) => {
      const view = this.db.getDocument({ documentId: entry.documentId, workspaceId: manifest.workspaceId, version: entry.version, originalSha256: entry.originalSha256, parseHash: entry.parseHash });
      if (!view || view.status !== 'available' || !view.ref.parseHash) throw productError({ code: 'DOCUMENT_UNAVAILABLE', category: 'state', source: { component: 'application', operation: 'replayPublication' }, safeMessage: 'The recorded publication is no longer fully available', impactScope: 'call', recoveryAction: 'manual_review', correlation: { workspaceId: manifest.workspaceId, documentId: entry.documentId } });
      return view.ref as import('../../contracts/src/index.ts').ReadableDocumentRef;
    });
    return { manifest, sourceKey: value.sourceKey, documentRefs, publicationRequestId: requestId };
  }
  private assertManifestApproved(req: Request, sourceKey: string, manifestSha256: string, purpose: Purpose): void {
    let policy: WorkspacePolicy;
    try { policy = JSON.parse(this.db.policy(req.workspaceId).json) as WorkspacePolicy; } catch (error) { throw productError({ code: 'CONFIG_LOCK_MISMATCH', category: 'configuration', source: { component: 'application', operation: 'manifestPolicy' }, safeMessage: 'The active source policy is invalid', impactScope: 'workspace', recoveryAction: 'manual_review', correlation: { requestId: req.requestId, workspaceId: req.workspaceId } }, { cause: error as Error }); }
    const source = policy.sources.find((candidate) => candidate.sourceKey === sourceKey);
    if (!source || source.manifestSha256 !== manifestSha256 || !source.allowedPurposes.includes(purpose)) throw productError({ code: 'CONFIG_LOCK_MISMATCH', category: 'configuration', source: { component: 'application', operation: 'manifestPolicy' }, safeMessage: 'The requested source version is not approved by the active policy', impactScope: 'workspace', recoveryAction: 'manual_review', correlation: { requestId: req.requestId, workspaceId: req.workspaceId } });
  }
}

function validateDocumentTransition(change: StateChange<DocumentStatus>, hasRecoveryVerification = false): void {
  if (change.expectedStatus === change.targetStatus) throw productError({ code: 'STATE_NO_CHANGE', category: 'state', source: { component: 'application', operation: 'document.setStatus' }, safeMessage: 'The requested document state is already current', impactScope: 'call', recoveryAction: 'query_action', correlation: {} });
  if (change.targetStatus === 'available' && !(change.expectedStatus === 'unavailable' && hasRecoveryVerification)) throw productError({ code: 'STATE_TRANSITION_INVALID', category: 'state', source: { component: 'application', operation: 'document.setStatus' }, safeMessage: 'Only a complete publication or verified recovery can make a document available', impactScope: 'call', recoveryAction: 'manual_review', correlation: {} });
  const allowed: Record<DocumentStatus, readonly DocumentStatus[]> = { pending: ['unavailable', 'withdrawn'], available: ['unavailable', 'withdrawn'], unavailable: ['withdrawn'], withdrawn: [] };
  if (change.targetStatus === 'available' && change.expectedStatus === 'unavailable' && hasRecoveryVerification) return;
  if (!allowed[change.expectedStatus].includes(change.targetStatus)) throw productError({ code: 'STATE_TRANSITION_INVALID', category: 'state', source: { component: 'application', operation: 'document.setStatus' }, safeMessage: 'The document state transition is not permitted', impactScope: 'call', recoveryAction: 'correct_input', correlation: {} });
}

function validateWorkspaceTransition(change: StateChange<WorkspaceStatus>): void {
  if (change.expectedStatus === change.targetStatus) throw productError({ code: 'STATE_NO_CHANGE', category: 'state', source: { component: 'application', operation: 'workspace.setStatus' }, safeMessage: 'The requested workspace state is already current', impactScope: 'call', recoveryAction: 'query_action', correlation: {} });
  // The P0 lifecycle follows the product contract: active can only be
  // paused; archiving requires an already-paused workspace, and reopening an
  // archived workspace lands in paused before a separate resume check.
  const allowed: Record<WorkspaceStatus, readonly WorkspaceStatus[]> = { active: ['paused'], paused: ['active', 'archived'], archived: ['paused'] };
  if (!allowed[change.expectedStatus].includes(change.targetStatus)) throw productError({ code: 'STATE_TRANSITION_INVALID', category: 'state', source: { component: 'application', operation: 'workspace.setStatus' }, safeMessage: 'The workspace state transition is not permitted', impactScope: 'call', recoveryAction: 'correct_input', correlation: {} });
}

function validatePolicyForP0(policy: WorkspacePolicy, ownerActorId: string): void {
  const operations = new Set(['source.inspect', 'source.register', 'source.publish', 'document.read', 'input.capture', 'document.setStatus', 'workspace.setStatus', 'policy.publish', 'evidence.read']);
  if (!Number.isSafeInteger(policy.version) || policy.version < 1 || policy.grants.length === 0 || policy.sources.length === 0) throw productError({ code: 'CONFIG_LOCK_MISMATCH', category: 'configuration', source: { component: 'application', operation: 'validatePolicy' }, safeMessage: 'The policy must contain a version, grant and source', impactScope: 'workspace', recoveryAction: 'correct_input', correlation: {} });
  for (const grant of policy.grants) {
    if (grant.actorId !== ownerActorId || grant.operations.some((operation) => !operations.has(operation)) || grant.sourceKeys.some((sourceKey) => !policy.sources.some((source) => source.sourceKey === sourceKey)) || grant.purposes.some((purpose) => purpose !== 'development' && purpose !== 'regression')) throw productError({ code: 'CONFIG_LOCK_MISMATCH', category: 'configuration', source: { component: 'application', operation: 'validatePolicy' }, safeMessage: 'The policy contains an unregistered identity, operation or source', impactScope: 'workspace', recoveryAction: 'correct_input', correlation: {} });
  }
  for (const source of policy.sources) {
    if (!source.sourceKey || !source.rootRef || source.rootRef.split(/[\\/]+/).some((part) => part.toLowerCase() === 'agent-eval') || !/^[0-9a-f]{64}$/.test(source.manifestSha256) || source.allowedPurposes.length === 0 || source.allowedPurposes.some((purpose) => purpose !== 'development' && purpose !== 'regression')) throw productError({ code: 'CONFIG_LOCK_MISMATCH', category: 'configuration', source: { component: 'application', operation: 'validatePolicy' }, safeMessage: 'The policy contains an invalid source binding', impactScope: 'workspace', recoveryAction: 'correct_input', correlation: {} });
  }
}
