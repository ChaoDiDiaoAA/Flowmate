export type Id = string;
export type Sha256 = string;
export type Utc = string;

export type WorkspaceStatus = 'active' | 'paused' | 'archived';
export type DocumentStatus = 'pending' | 'available' | 'unavailable' | 'withdrawn';
export type Purpose = 'development' | 'regression';

export type Operation =
  | 'source.inspect'
  | 'source.register'
  | 'source.publish'
  | 'document.read'
  | 'input.capture'
  | 'document.setStatus'
  | 'workspace.setStatus'
  | 'policy.publish'
  | 'evidence.read';

export interface Request {
  requestId: Id;
  workspaceId: Id;
}

export interface ArtifactRef {
  artifactId: Id;
  workspaceId: Id;
  sha256: Sha256;
  sizeBytes: number;
  kind: string;
}

export interface DocumentRef {
  documentId: Id;
  workspaceId: Id;
  version: Sha256;
  originalSha256: Sha256;
  parseHash: Sha256 | null;
}

export interface ReadableDocumentRef extends DocumentRef {
  parseHash: Sha256;
}

export interface PublishedDataset {
  manifest: ArtifactRef;
  sourceKey: string;
  documentRefs: readonly ReadableDocumentRef[];
  publicationRequestId: Id;
}

export interface WorkspaceView {
  workspaceId: Id;
  ownerActorId: Id;
  status: WorkspaceStatus;
  version: number;
  policyHash: Sha256;
}

export interface DocumentView {
  ref: DocumentRef;
  status: DocumentStatus;
  stateRevision: number;
  verificationRef?: ArtifactRef;
  availabilityReason?: string;
}

export interface StateChange<S extends string> {
  expectedStatus: S;
  expectedRevision: number;
  targetStatus: S;
  reason: string;
}

export interface CloseReport {
  closed: boolean;
  primaryError?: import('./errors.ts').ErrorDescriptor;
  cleanupErrors: readonly import('./errors.ts').ErrorDescriptor[];
}

export interface FileDescriptor {
  relativePath: string;
  bytes: number;
  sha256: Sha256;
  mediaType: 'image/jpeg' | 'image/png' | 'application/json' | 'text/markdown';
}

export interface ParseSelection {
  originalSha256: Sha256;
  selectedParseHash: Sha256;
  reason: string;
  evidenceRef: string;
}

export interface InspectionReport {
  schemaVersion: 'p0-inspection/v1';
  sourceKey: string;
  sourceManifestHash: Sha256;
  expectedSamples: number;
  inspectedSamples: number;
  checkedFiles: number;
  excluded: readonly { path: string; reason: string }[];
  variants: readonly { originalSha256: Sha256; parseHashes: readonly Sha256[] }[];
  issues: readonly { sampleId: string; code: string; detail?: string }[];
  reportHash: Sha256;
}

export interface ParsedBlock {
  kind: 'text' | 'table' | 'image';
  text?: string;
  tableHtml?: string;
  image?: ArtifactRef;
  sourcePointer: string;
  bbox?: readonly [number, number, number, number];
}

export interface ParsedDocument {
  schemaVersion: 'parsed-document/v1';
  document: ReadableDocumentRef;
  sourceRecordId: string;
  sourceRef: { sourceKey: string; sourceRevision: string };
  originalHash: Sha256;
  parser: { key: string; version?: string };
  contentHash: Sha256;
  integrity: { status: 'verified'; verificationRef: ArtifactRef };
  warnings: readonly { code: string; blocking: boolean }[];
  pages: readonly {
    pageNumber: number;
    blocks: readonly ParsedBlock[];
  }[];
}

export interface InputProjection {
  schemaVersion: 'p0-input/v1';
  document: ReadableDocumentRef;
  manifest: ArtifactRef;
  parsed: ParsedDocument;
  evidence: readonly ArtifactRef[];
}

export interface CapturedInput {
  projection: ArtifactRef;
  document: DocumentRef;
}

export interface WorkspacePolicy {
  schemaVersion: 'p0-policy/v1';
  version: number;
  grants: readonly {
    actorId: Id;
    operations: readonly Operation[];
    sourceKeys: readonly string[];
    purposes: readonly Purpose[];
  }[];
  sources: readonly {
    sourceKey: string;
    rootRef: string;
    manifestSha256: Sha256;
    allowedPurposes: readonly Purpose[];
    useAuthorizationRef: string;
  }[];
}

export interface CommandReceipt {
  schemaVersion: 'p0-receipt/v1';
  requestId: Id;
  actorId: Id;
  operation: Operation;
  commandHash: Sha256;
  committedAt: Utc;
  resultRef: ArtifactRef;
  auditId: Id;
}

export interface StartOptions {
  instanceRoot: string;
  configPath?: string;
  mode: 'create' | 'open';
}

export interface StartedProduct {
  application: import('./ports.ts').Application;
  instanceId: Id;
  workspaceId: Id;
  processInstanceId: Id;
  close(): Promise<CloseReport>;
}
