export type AcquisitionJobStatus =
  | "CREATED"
  | "DISCOVERING_ADAPTER"
  | "FETCHING"
  | "STAGED"
  | "RAW_SAVED"
  | "PARSING"
  | "DEDUPLICATING"
  | "POLICY_CHECKING"
  | "CATALOGING"
  | "COMPLETED"
  | "ADAPTER_NOT_FOUND"
  | "FETCH_FAILED"
  | "PARSER_UNAVAILABLE"
  | "PARSE_FAILED"
  | "RESULT_DOWNLOAD_TLS_FAILED"
  | "BATCH_LIMIT_EXCEEDED"
  | "POLICY_REJECTED"
  | "CATALOG_WRITE_FAILED"
  | "CANCELLED";

export type ArtifactPipelineStatus =
  | "DISCOVERED"
  | "STAGED"
  | "RAW_SAVED"
  | "PARSED"
  | "DEDUPED"
  | "POLICY_PASSED"
  | "CATALOGED"
  | "RELEASED"
  | "DUPLICATE_URL"
  | "DUPLICATE_RAW"
  | "DUPLICATE_CONTENT"
  | "QUARANTINED_LICENSE"
  | "QUARANTINED_PRIVACY"
  | "QUARANTINED_QUALITY"
  | "UNSUPPORTED_FORMAT"
  | "CONTENT_DELETED_BY_POLICY"
  | "WITHDRAWN";

export interface SourcePolicy {
  sourceId: string;
  domain: string;
  sourceType: "public_web" | "internal_business";
  accessStrategy: "public";
  sourcePolicy: "allowed" | "unknown" | "denied";
  rawRetention: "allowed" | "metadata_only" | "denied";
  datasetUsage: "allowed" | "denied";
  synthetic: boolean;
  containsSyntheticIdentifiers: boolean;
  enabled: boolean;
}

export interface AcquisitionJob {
  jobId: string;
  sourceId: string;
  objective: string;
  status: AcquisitionJobStatus;
  startedAt: string;
  finishedAt?: string;
  counts: {
    discovered: number;
    stored: number;
    duplicated: number;
    quarantined: number;
    failed: number;
  };
}

export interface OpenCliCommandDescriptor {
  command: string;
  site: string;
  name: string;
  access: "read" | "write";
  strategy: string;
  browser: boolean;
}

export interface AcquisitionResult {
  jobId: string;
  adapterRef: string;
  strategy: "public";
  retrievedAt: string;
  status: "succeeded" | "failed";
  exitCode: number;
  items: unknown[];
  traceRef?: string;
}

export interface RawArtifactRef {
  artifactId: string;
  sourceIds: string[];
  acquisitionJobIds: string[];
  canonicalUrl?: string;
  rawRef?: string;
  rawSha256: string;
  mimeType: string;
  retentionStatus: "retained" | "metadata_only" | "deleted_by_policy";
}

export interface ParsedDocument {
  artifactId: string;
  parserName: string;
  parserVersion: string;
  parsedAt: string;
  contentRef: string;
  structureRef?: string;
  imageRefs: string[];
  contentSha256: string;
  pageCount?: number;
  warnings: string[];
}

export interface ParseDocumentInput {
  artifact: RawArtifactRef;
  /**
   * A sealed staging handle rather than an arbitrary pathname. Parsers may
   * materialize a private, short-lived copy when an external tool requires a
   * local filename.
   */
  sourceFile: import("./sealed-staged-file.js").SealedStagedFile;
}

export interface DocumentParser {
  readonly name: string;
  parse(input: ParseDocumentInput): Promise<ParsedDocument>;
}

export interface DedupeDecision {
  status: "unique" | "duplicate_url" | "duplicate_raw" | "duplicate_content" | "url_updated";
  canonicalArtifactId: string;
  relatedArtifactIds: string[];
}

export interface PolicyDecision {
  itemId: string;
  licenseStatus: "allowed" | "unknown" | "denied";
  privacyStatus: "passed" | "quarantined" | "delete_content";
  qualityStatus: "passed" | "quarantined";
  action: "catalog" | "quarantine" | "delete_content_keep_metadata";
  reasonCodes: string[];
  policyVersion: "p0-policy-1.0";
  decidedAt: string;
}

export interface CatalogEntryRef {
  entryId: string;
  entryType: "knowledge" | "public_sample" | "business_asset" | "quarantine" | "failure";
  noteRef: string;
  sourceId: string;
  artifactId?: string;
  pipelineStatus: string;
}

export interface DatasetManifestItem {
  itemId: string;
  itemType: "knowledge" | "public_sample" | "business_asset";
  sourceId: string;
  artifactId: string;
  rawRef?: string;
  derivedRef?: string;
  expectedRef?: string;
  rawSha256: string;
  contentSha256?: string;
  parserName?: string;
  parserVersion?: string;
  licenseStatus: "allowed";
  privacyStatus: "passed";
  qualityStatus: "passed";
  scenarios: string[];
}

export interface DatasetManifest {
  schemaVersion: "1.0";
  datasetVersion: string;
  createdAt: string;
  sourcePolicyVersion: string;
  items: DatasetManifestItem[];
  checksumsRef: string;
}
