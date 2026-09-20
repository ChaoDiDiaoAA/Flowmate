import type {
  ArtifactRef,
  CapturedInput,
  CommandReceipt,
  DocumentRef,
  DocumentStatus,
  DocumentView,
  InspectionReport,
  InputProjection,
  Operation,
  ParseSelection,
  Purpose,
  PublishedDataset,
  Request,
  StateChange,
  WorkspacePolicy,
  WorkspaceView,
} from './foundation.ts';
import type { ErrorDescriptor } from './errors.ts';
import type { LoggerPort } from './logging.ts';

export interface TrustedActor {
  actorId: string;
  instanceId: string;
  osBindingHash: string;
}

export interface AuthorizedContext {
  request: Request;
  actor: TrustedActor;
  operation: Operation;
  workspaceVersion: number;
  policyHash: string;
  scope: { sourceKey?: string; document?: DocumentRef; purpose?: Purpose };
}

export interface ArtifactDraft {
  artifactId: string;
  workspaceId: string;
  kind: string;
  storageRoot: 'instance';
  relativePath: string;
  sha256: string;
  sizeBytes: number;
  mimeType: string;
  sourceRef: string;
}

export interface DocumentDraft {
  documentId: string;
  workspaceId: string;
  sourceKey: string;
  sourceRecordId: string;
  version: string;
  originalArtifactId: string;
  parsedArtifactId: string | null;
  contentHash: string;
  parseHash: string | null;
  sourceMetadataJson: string;
  parserRef: string | null;
  parserVersion: string | null;
  parentDocumentId: string | null;
}

export interface PreparedPublication {
  sourceKey: string;
  manifest: ArtifactDraft;
  verification: ArtifactDraft;
  artifactDrafts: readonly ArtifactDraft[];
  documentDrafts: readonly DocumentDraft[];
  verificationRef: ArtifactRef;
  selection: readonly ParseSelection[];
  policyHash: string;
  purpose: Purpose;
}

export interface FoundationTx {
  getWorkspace(workspaceId: string): WorkspaceView | null;
  findReceipt(workspaceId: string, actorId: string, requestId: string): CommandReceipt | null;
  registerArtifact(draft: ArtifactDraft): ArtifactRef;
  registerDocument(draft: DocumentDraft, status?: DocumentStatus): DocumentView;
  compareAndSetDocument(
    ref: DocumentRef,
    change: StateChange<DocumentStatus>,
    verificationRef?: ArtifactRef,
  ): DocumentView;
  compareAndSetWorkspace(workspaceId: string, change: StateChange<'active' | 'paused' | 'archived'>): WorkspaceView;
  updatePolicy(workspaceId: string, expectedVersion: number, policyJson: string, policyHash: string): WorkspaceView;
  appendCommandAudit(input: CommandReceipt, beforeRef?: ArtifactRef): void;
  addAudit(input: {
    actorId: string;
    action: string;
    entityType: string;
    entityId: string;
    requestId: string;
    afterRef: unknown;
    reason?: string;
  }): string;
}

export interface DataPort {
  inspect(ctx: AuthorizedContext, sourceKey: string, manifestHash: string, purpose: Purpose): Promise<InspectionReport>;
  prepareSourceDocument(
    ctx: AuthorizedContext,
    input: { sourceKey: string; sampleId: string; manifestSha256: string; purpose: Purpose },
  ): Promise<{ artifactDraft: ArtifactDraft; documentDraft: DocumentDraft }>;
  reverifyDocument(ctx: AuthorizedContext, ref: DocumentRef): Promise<ArtifactDraft>;
  registerSourceDocument(
    ctx: AuthorizedContext,
    input: { sourceKey: string; sampleId: string; manifestSha256: string; purpose: Purpose },
  ): Promise<DocumentView>;
  preparePublication(
    ctx: AuthorizedContext,
    input: { sourceKey: string; manifestSha256: string; selection: readonly ParseSelection[]; purpose: Purpose },
  ): Promise<PreparedPublication>;
  commitPublication(tx: FoundationTx, prepared: PreparedPublication, verificationRef: ArtifactRef): PublishedDataset;
  read(ctx: AuthorizedContext, ref: DocumentRef, manifest: ArtifactRef, purpose: Purpose): Promise<InputProjection>;
}

export interface ControlledFileStore {
  readVerified(input: {
    root: 'source' | 'instance';
    relativePath: string;
    expectedSha256: string;
    expectedBytes: number;
    maxBytes: number;
  }): Promise<Uint8Array>;
  saveImmutable(input: {
    workspaceId: string;
    kind: string;
    bytes: Uint8Array;
    sha256: string;
    mediaType: string;
    sourceRef: string;
  }): Promise<ArtifactDraft>;
}

export interface Application {
  getWorkspace(req: Request): Promise<WorkspaceView>;
  inspectSource(req: Request, input: { sourceKey: string; manifestSha256: string; purpose: Purpose }): Promise<InspectionReport>;
  registerSourceDocument(
    req: Request,
    input: { sourceKey: string; sampleId: string; manifestSha256: string; purpose: Purpose },
  ): Promise<DocumentView>;
  publishDataset(
    req: Request,
    input: { sourceKey: string; manifestSha256: string; selection: readonly ParseSelection[]; purpose: Purpose },
  ): Promise<PublishedDataset>;
  readDocument(
    req: Request,
    input: { document: DocumentRef; manifest: ArtifactRef; purpose: Purpose },
  ): Promise<InputProjection>;
  captureInput(
    req: Request,
    input: { document: DocumentRef; manifest: ArtifactRef; purpose: Purpose },
  ): Promise<CapturedInput>;
  readCapturedInput(req: Request, input: { projection: ArtifactRef; purpose: Purpose }): Promise<InputProjection>;
  setDocumentStatus(req: Request, input: { document: DocumentRef; change: StateChange<DocumentStatus> }): Promise<DocumentView>;
  setWorkspaceStatus(req: Request, change: StateChange<'active' | 'paused' | 'archived'>): Promise<WorkspaceView>;
  publishPolicy(req: Request, input: { expectedRevision: number; policy: WorkspacePolicy }): Promise<WorkspaceView>;
  findReceipt(req: Request, input: { originalRequestId: string }): Promise<CommandReceipt | null>;
  readEvidence(req: Request, input: { artifact: ArtifactRef }): Promise<Uint8Array>;
}

export type { ErrorDescriptor, LoggerPort };
