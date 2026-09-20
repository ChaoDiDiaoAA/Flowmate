import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import type {
  ArtifactRef,
  DocumentRef,
  DocumentView,
  InspectionReport,
  InputProjection,
  ParsedBlock,
  ParsedDocument,
  ParseSelection,
  Purpose,
} from '../../../contracts/src/index.ts';
import { productError } from '../../../contracts/src/errors.ts';
import type { AuthorizedContext, DataPort, DocumentDraft, FoundationTx, PreparedPublication, ArtifactDraft } from '../../../contracts/src/ports.ts';
import { canonicalJson, nowUtc, sha256Bytes, sha256Canonical } from '../../../shared/src/index.ts';
import { requireSha256 } from '../../../shared/src/index.ts';
import { FoundationDatabase } from '../../../core/src/storage/database.ts';
import { InstanceFileStore, validateRelativePath } from '../../../core/src/storage/file-store.ts';

interface SourceDescriptor { path: string; bytes: number; sha256: string; }
interface SourceSample { sampleId: string; originalSha256: string; metadata: SourceDescriptor; }
interface SourceManifest { schemaVersion: number; datasetVersion: string; status: string; samples: SourceSample[]; aliases?: Record<string, string>; }
interface SampleMetadata {
  schemaVersion: number;
  sampleId: string;
  sourceRecordId: string;
  datasetId?: string;
  datasetRevision?: string;
  sourceUrl?: string;
  parserKey?: string;
  parseAttemptId?: string;
  parseStartedAt?: string;
  originalSha256: string;
  qualityStatus?: string;
  integrityStatus?: string;
  files: SourceDescriptor[];
}

export class Voxel51DataSource implements DataPort {
  constructor(
    private readonly sourceRoot: string,
    private readonly workspaceId: string,
    private readonly db: FoundationDatabase,
    private readonly files: InstanceFileStore,
  ) {}

  async inspect(_ctx: AuthorizedContext, sourceKey: string, manifestHash: string, _purpose: Purpose): Promise<InspectionReport> {
    const manifestBytes = await this.readSourceBytes('manifest.json', 16_777_216);
    if (sha256Bytes(manifestBytes) !== manifestHash) {
      throw productError({ code: 'FILE_DIGEST_MISMATCH', category: 'input', source: { component: 'voxel51', operation: 'inspect' }, safeMessage: 'The source manifest digest does not match the approved configuration', impactScope: 'call', recoveryAction: 'correct_input', correlation: { workspaceId: this.workspaceId } });
    }
    const manifest = parseJson<SourceManifest>(manifestBytes, 'manifest');
    if (!Array.isArray(manifest.samples) || manifest.schemaVersion !== 1) throw this.schemaError('manifest');
    const issues: { sampleId: string; code: string; detail?: string }[] = [];
    const variants = new Map<string, Set<string>>();
    let checkedFiles = 1;
    let inspectedSamples = 0;
    for (const sample of manifest.samples) {
      try {
        const metadata = await this.readMetadata(sample);
        const files = new Map<string, Uint8Array>();
        for (const descriptor of metadata.files ?? []) {
          const bytes = await this.files.readVerified({ root: 'source', relativePath: `${sample.sampleId}/${descriptor.path}`, expectedSha256: descriptor.sha256, expectedBytes: descriptor.bytes, maxBytes: 67_108_864 });
          files.set(descriptor.path, bytes);
          checkedFiles += 1;
          if (isImagePath(descriptor.path)) {
            if (!validImageBytes(bytes, descriptor.path)) issues.push({ sampleId: sample.sampleId, code: 'IMAGE_UNREADABLE', detail: descriptor.path });
          }
        }
        const content = files.get('content.json');
        const pages = files.get('pages.json');
        if (!content || !pages) throw this.inputError('INPUT_INCOMPLETE');
        const parsedContent = parseJson<unknown>(content, `${sample.sampleId}/content.json`);
        const parsedPages = parseJson<unknown>(pages, `${sample.sampleId}/pages.json`);
        if (!Array.isArray(parsedContent) || !Array.isArray(parsedPages)) throw this.schemaError(`${sample.sampleId}/parse`);
        validateParsePair(parsedContent, parsedPages, metadata);
        const parseHash = computeParseHash(metadata, content, pages);
        const set = variants.get(sample.originalSha256) ?? new Set<string>();
        set.add(parseHash); variants.set(sample.originalSha256, set);
        inspectedSamples += 1;
      } catch (error) {
        const code = error instanceof Error && 'descriptor' in error && typeof (error as { descriptor?: { code?: string } }).descriptor?.code === 'string' ? (error as { descriptor: { code: string } }).descriptor.code : 'INPUT_SCHEMA_INVALID';
        issues.push({ sampleId: sample.sampleId, code });
      }
    }
    const reportWithoutHash = { schemaVersion: 'p0-inspection/v1' as const, sourceKey, sourceManifestHash: manifestHash, expectedSamples: manifest.samples.length, inspectedSamples, checkedFiles, excluded: [], variants: [...variants.entries()].map(([originalSha256, parseHashes]) => ({ originalSha256, parseHashes: [...parseHashes].sort() })), issues };
    return { ...reportWithoutHash, reportHash: sha256Canonical(reportWithoutHash) };
  }

  async registerSourceDocument(ctx: AuthorizedContext, input: { sourceKey: string; sampleId: string; manifestSha256: string; purpose: Purpose }): Promise<DocumentView> {
    const prepared = await this.prepareSourceDocument(ctx, input);
    return this.db.transaction(ctx.actor.actorId, this.workspaceId, ctx.request.requestId, (tx) => {
      tx.registerArtifact(prepared.artifactDraft);
      return tx.registerDocument(prepared.documentDraft, 'pending');
    });
  }

  async prepareSourceDocument(ctx: AuthorizedContext, input: { sourceKey: string; sampleId: string; manifestSha256: string; purpose: Purpose }): Promise<{ artifactDraft: ArtifactDraft; documentDraft: DocumentDraft }> {
    const manifest = await this.loadManifest(input.manifestSha256);
    const sample = manifest.samples.find((candidate) => candidate.sampleId === input.sampleId);
    if (!sample) throw productError({ code: 'FILE_MISSING', category: 'input', source: { component: 'voxel51', operation: 'register' }, safeMessage: 'The source sample is not present in the approved manifest', impactScope: 'call', recoveryAction: 'correct_input', correlation: { workspaceId: this.workspaceId } });
    const metadata = await this.readMetadata(sample);
    const original = await this.files.readVerified({ root: 'source', relativePath: `${sample.sampleId}/original.jpg`, expectedSha256: sample.originalSha256, expectedBytes: metadata.files.find((file) => file.path === 'original.jpg')?.bytes ?? 0, maxBytes: 67_108_864 });
    const originalDraft = await this.files.saveImmutable({ workspaceId: this.workspaceId, kind: 'source/original', bytes: original, sha256: sample.originalSha256, mediaType: 'image/jpeg', sourceRef: `${input.sourceKey}/${sample.sampleId}/original.jpg` });
    const sourceRevision = metadata.datasetRevision ?? input.manifestSha256;
    const version = sha256Canonical({ sourceKey: input.sourceKey, sourceRecordId: metadata.sourceRecordId, sourceRevision, originalSha256: sample.originalSha256, parseHash: null });
    const draft: DocumentDraft = { documentId: `d_${version.slice(0, 48)}`, workspaceId: this.workspaceId, sourceKey: input.sourceKey, sourceRecordId: metadata.sourceRecordId, version, originalArtifactId: originalDraft.artifactId, parsedArtifactId: null, contentHash: sample.originalSha256, parseHash: null, sourceMetadataJson: JSON.stringify({ ...metadata, sampleId: sample.sampleId, artifactMap: { original: originalDraft.artifactId } }), parserRef: null, parserVersion: null, parentDocumentId: null };
    return { artifactDraft: originalDraft, documentDraft: draft };
  }

  async preparePublication(_ctx: AuthorizedContext, input: { sourceKey: string; manifestSha256: string; selection: readonly ParseSelection[]; purpose: Purpose }): Promise<PreparedPublication> {
    const manifest = await this.loadManifest(input.manifestSha256);
    const inspection = await this.inspect(_ctx, input.sourceKey, input.manifestSha256, input.purpose);
    if (inspection.issues.length) throw productError({ code: 'INPUT_INCOMPLETE', category: 'input', source: { component: 'voxel51', operation: 'preparePublication' }, safeMessage: 'The approved source set contains files that are not complete or readable', impactScope: 'call', recoveryAction: 'correct_input', correlation: { workspaceId: this.workspaceId } });
    const selectionByOriginal = new Map(input.selection.map((item) => [item.originalSha256, item]));
    for (const selection of input.selection) {
      requireSha256(selection.originalSha256, 'selection.originalSha256');
      requireSha256(selection.selectedParseHash, 'selection.selectedParseHash');
      if (!selection.reason.trim() || !selection.evidenceRef.trim()) throw productError({ code: 'INPUT_SCHEMA_INVALID', category: 'input', source: { component: 'voxel51', operation: 'selection' }, safeMessage: 'A parse selection must include a reason and evidence reference', impactScope: 'call', recoveryAction: 'correct_input', correlation: { workspaceId: this.workspaceId } });
    }
    const drafts: ArtifactDraft[] = [];
    const documents: DocumentDraft[] = [];
    const documentManifest: unknown[] = [];
    const verificationBytes = new TextEncoder().encode(JSON.stringify(inspection));
    const verification = await this.files.saveImmutable({ workspaceId: this.workspaceId, kind: 'verification/inspection', bytes: verificationBytes, sha256: sha256Bytes(verificationBytes), mediaType: 'application/json', sourceRef: `${input.sourceKey}/inspection/${inspection.reportHash}` });
    drafts.push(verification);
    type Candidate = { sample: SourceSample; metadata: SampleMetadata; content: Uint8Array; pages: Uint8Array; parseHash: string };
    const groups = new Map<string, Candidate[]>();
    for (const sample of manifest.samples) {
      const metadata = await this.readMetadata(sample);
      const contentDescriptor = metadata.files.find((file) => file.path === 'content.json');
      const pagesDescriptor = metadata.files.find((file) => file.path === 'pages.json');
      if (!contentDescriptor || !pagesDescriptor) throw this.inputError('INPUT_INCOMPLETE');
      const content = await this.files.readVerified({ root: 'source', relativePath: `${sample.sampleId}/${contentDescriptor.path}`, expectedSha256: contentDescriptor.sha256, expectedBytes: contentDescriptor.bytes, maxBytes: 67_108_864 });
      const pages = await this.files.readVerified({ root: 'source', relativePath: `${sample.sampleId}/${pagesDescriptor.path}`, expectedSha256: pagesDescriptor.sha256, expectedBytes: pagesDescriptor.bytes, maxBytes: 67_108_864 });
      const parsedContent = parseJson<unknown>(content, `${sample.sampleId}/content.json`);
      const parsedPages = parseJson<unknown>(pages, `${sample.sampleId}/pages.json`);
      if (!Array.isArray(parsedContent) || !Array.isArray(parsedPages)) throw this.schemaError(`${sample.sampleId}/parse`);
      validateParsePair(parsedContent, parsedPages, metadata);
      const candidate = { sample, metadata, content, pages, parseHash: computeParseHash(metadata, content, pages) };
      const group = groups.get(sample.originalSha256) ?? [];
      group.push(candidate); groups.set(sample.originalSha256, group);
    }
    for (const group of groups.values()) {
      const distinctParseHashes = [...new Set(group.map((candidate) => candidate.parseHash))];
      let selectedGroup = group;
      if (distinctParseHashes.length > 1) {
        const selected = selectionByOriginal.get(group[0].sample.originalSha256);
        if (!selected || !distinctParseHashes.includes(selected.selectedParseHash)) throw productError({ code: 'PARSE_SELECTION_REQUIRED', category: 'input', source: { component: 'voxel51', operation: 'preparePublication' }, safeMessage: 'A source group has multiple parses and needs an explicit selection', impactScope: 'call', recoveryAction: 'manual_review', correlation: { workspaceId: this.workspaceId } });
        selectedGroup = group.filter((candidate) => candidate.parseHash === selected.selectedParseHash);
      }
      // Same original and same parse is an alias. Publish one immutable logical
      // version and retain every source member in the manifest for traceability.
      const candidate = selectedGroup[0];
      const aliases = group.filter((item) => item.parseHash === candidate.parseHash && item.sample.sampleId !== candidate.sample.sampleId).map((item) => item.sample.sampleId);
      const excluded = group.filter((item) => item.parseHash !== candidate.parseHash).map((item) => ({ sampleId: item.sample.sampleId, parseHash: item.parseHash, reason: 'not selected for this publication' }));
      const sample = candidate.sample;
      const metadata = candidate.metadata;
      const fileBytes = new Map<string, Uint8Array>();
      const fileDrafts = new Map<string, ArtifactDraft>();
      for (const descriptor of metadata.files) {
        const bytes = candidate.content && descriptor.path === 'content.json' ? candidate.content : candidate.pages && descriptor.path === 'pages.json' ? candidate.pages : await this.files.readVerified({ root: 'source', relativePath: `${sample.sampleId}/${descriptor.path}`, expectedSha256: descriptor.sha256, expectedBytes: descriptor.bytes, maxBytes: 67_108_864 });
        fileBytes.set(descriptor.path, bytes);
        const kind = descriptor.path === 'original.jpg' ? 'source/original' : descriptor.path === 'content.json' || descriptor.path === 'pages.json' || descriptor.path === 'content.md' ? 'source/parsed' : 'source/evidence-image';
        const mediaType = mediaTypeFor(descriptor.path);
        const draft = await this.files.saveImmutable({ workspaceId: this.workspaceId, kind, bytes, sha256: descriptor.sha256, mediaType, sourceRef: `${input.sourceKey}/${sample.sampleId}/${descriptor.path}` });
        drafts.push(draft); fileDrafts.set(descriptor.path, draft);
      }
      const content = fileBytes.get('content.json')!;
      const pages = fileBytes.get('pages.json')!;
      const parseHash = candidate.parseHash;
      const originalDraft = fileDrafts.get('original.jpg');
      const parsedDraft = fileDrafts.get('content.json');
      if (!originalDraft || !parsedDraft) throw this.inputError('INPUT_INCOMPLETE');
      const sourceRevision = metadata.datasetRevision ?? input.manifestSha256;
      const version = sha256Canonical({ sourceKey: input.sourceKey, sourceRecordId: metadata.sourceRecordId, sourceRevision, originalSha256: sample.originalSha256, parseHash });
      const documentId = `d_${version.slice(0, 48)}`;
      const artifactMap = Object.fromEntries([...fileDrafts.entries()].map(([path, draft]) => [path, draft.artifactId]));
      const draft: DocumentDraft = { documentId, workspaceId: this.workspaceId, sourceKey: input.sourceKey, sourceRecordId: metadata.sourceRecordId, version, originalArtifactId: originalDraft.artifactId, parsedArtifactId: parsedDraft.artifactId, contentHash: sha256Bytes(content), parseHash, sourceMetadataJson: JSON.stringify({ ...metadata, sampleId: sample.sampleId, artifactMap, pagesPath: 'pages.json', contentPath: 'content.json' }), parserRef: metadata.parserKey ?? null, parserVersion: metadata.parserKey?.split('@')[1]?.split(';')[0] ?? null, parentDocumentId: null };
      documents.push(draft);
      documentManifest.push({ sampleId: sample.sampleId, aliases, excluded, sourceRecordId: metadata.sourceRecordId, documentId, version, originalSha256: sample.originalSha256, parseHash, files: artifactMap });
    }
    const manifestBody = { schemaVersion: 'p0-dataset/v1', sourceKey: input.sourceKey, sourceManifestSha256: input.manifestSha256, purpose: input.purpose, createdAt: nowUtc(), inspectionRef: verification.artifactId, selections: input.selection, documents: documentManifest };
    const manifestBytes = new TextEncoder().encode(canonicalJson(manifestBody));
    const manifestDraft = await this.files.saveImmutable({ workspaceId: this.workspaceId, kind: 'dataset/manifest', bytes: manifestBytes, sha256: sha256Bytes(manifestBytes), mediaType: 'application/json', sourceRef: `${input.sourceKey}/manifest/${input.manifestSha256}` });
    drafts.push(manifestDraft);
    const verificationRef: ArtifactRef = { artifactId: verification.artifactId, workspaceId: verification.workspaceId, sha256: verification.sha256, sizeBytes: verification.sizeBytes, kind: verification.kind };
    return { sourceKey: input.sourceKey, manifest: manifestDraft, verification, verificationRef, artifactDrafts: drafts, documentDrafts: documents, selection: input.selection, policyHash: _ctx.policyHash, purpose: input.purpose };
  }

  async reverifyDocument(_ctx: AuthorizedContext, ref: DocumentRef): Promise<ArtifactDraft> {
    const record = this.db.getDocumentRecord(ref);
    if (!record || record.status !== 'unavailable' || !record.parsed_artifact_id || !record.parse_hash) throw productError({ code: 'DOCUMENT_UNAVAILABLE', category: 'state', source: { component: 'voxel51', operation: 'reverify' }, safeMessage: 'The document is not eligible for verified recovery', impactScope: 'call', recoveryAction: 'manual_review', correlation: { workspaceId: ref.workspaceId, documentId: ref.documentId } });
    let metadata: SampleMetadata & { artifactMap: Record<string, string>; sampleId: string };
    try { metadata = JSON.parse(record.source_metadata_json) as SampleMetadata & { artifactMap: Record<string, string>; sampleId: string }; } catch (error) { throw this.schemaError('stored metadata'); }
    const originalArtifact = this.db.getArtifact(ref.workspaceId, record.original_artifact_id);
    const contentArtifact = this.db.getArtifact(ref.workspaceId, metadata.artifactMap['content.json']);
    const pagesArtifact = this.db.getArtifact(ref.workspaceId, metadata.artifactMap['pages.json']);
    if (!originalArtifact || !contentArtifact || !pagesArtifact) throw this.inputError('INPUT_INCOMPLETE');
    const original = await this.files.readInstanceArtifact(originalArtifact.relative_path, originalArtifact.sha256, originalArtifact.size_bytes, 67_108_864);
    if (sha256Bytes(original) !== record.original_sha256) throw productError({ code: 'FILE_DIGEST_MISMATCH', category: 'storage', source: { component: 'voxel51', operation: 'reverify' }, safeMessage: 'The stored original artifact failed integrity verification', impactScope: 'call', recoveryAction: 'manual_review', correlation: { workspaceId: ref.workspaceId, documentId: ref.documentId, artifactId: originalArtifact.artifact_id } });
    const content = await this.files.readInstanceArtifact(contentArtifact.relative_path, contentArtifact.sha256, contentArtifact.size_bytes, 67_108_864);
    const pages = await this.files.readInstanceArtifact(pagesArtifact.relative_path, pagesArtifact.sha256, pagesArtifact.size_bytes, 67_108_864);
    const parsedContent = parseJson<unknown>(content, 'stored content');
    const parsedPages = parseJson<unknown>(pages, 'stored pages');
    if (!Array.isArray(parsedContent) || !Array.isArray(parsedPages)) throw this.schemaError('stored parse');
    validateParsePair(parsedContent, parsedPages, metadata);
    if (sha256Bytes(content) !== record.content_hash || computeParseHash(metadata, content, pages) !== record.parse_hash) throw productError({ code: 'FILE_DIGEST_MISMATCH', category: 'storage', source: { component: 'voxel51', operation: 'reverify' }, safeMessage: 'The stored parsed artifact no longer matches its document version', impactScope: 'call', recoveryAction: 'manual_review', correlation: { workspaceId: ref.workspaceId, documentId: ref.documentId } });
    for (const [path, artifactId] of Object.entries(metadata.artifactMap)) {
      const artifact = this.db.getArtifact(ref.workspaceId, artifactId);
      if (!artifact) throw this.inputError('INPUT_INCOMPLETE');
      const bytes = await this.files.readInstanceArtifact(artifact.relative_path, artifact.sha256, artifact.size_bytes, 67_108_864);
      if (isImagePath(path) && !validImageBytes(bytes, path)) throw productError({ code: 'IMAGE_UNREADABLE', category: 'storage', source: { component: 'voxel51', operation: 'reverify' }, safeMessage: 'A stored image artifact is not structurally readable', impactScope: 'call', recoveryAction: 'manual_review', correlation: { workspaceId: ref.workspaceId, documentId: ref.documentId } });
    }
    const body = canonicalJson({ schemaVersion: 'p0-reverification/v1', documentId: ref.documentId, version: ref.version, originalSha256: record.original_sha256, parseHash: record.parse_hash, artifactIds: Object.values(metadata.artifactMap).sort() });
    const bytes = new TextEncoder().encode(body);
    return this.files.saveImmutable({ workspaceId: ref.workspaceId, kind: 'verification/recovery', bytes, sha256: sha256Bytes(bytes), mediaType: 'application/json', sourceRef: `${ref.documentId}/${ref.version}/reverification` });
  }

  commitPublication(tx: FoundationTx, prepared: PreparedPublication, verificationRef: ArtifactRef) {
    const refs = new Map<string, ArtifactRef>();
    for (const draft of prepared.artifactDrafts) refs.set(draft.artifactId, tx.registerArtifact(draft));
    const manifest = refs.get(prepared.manifest.artifactId)!;
    const documentRefs = [] as DocumentRef[];
    for (const draft of prepared.documentDrafts) {
      const view = tx.registerDocument(draft, 'pending');
      if (view.status === 'withdrawn') throw productError({ code: 'DOCUMENT_WITHDRAWN', category: 'state', source: { component: 'voxel51', operation: 'commitPublication' }, safeMessage: 'A previously withdrawn document version cannot be silently republished', impactScope: 'call', recoveryAction: 'manual_review', correlation: { workspaceId: view.ref.workspaceId, documentId: view.ref.documentId } });
      const available = view.status === 'available'
        ? view
        : tx.compareAndSetDocument(view.ref, { expectedStatus: 'pending', expectedRevision: view.stateRevision, targetStatus: 'available', reason: 'published source with complete immutable files' }, verificationRef);
      if (available.ref.parseHash === null) throw this.inputError('INPUT_INCOMPLETE');
      documentRefs.push(available.ref);
    }
    return { manifest, sourceKey: prepared.sourceKey, documentRefs: documentRefs as any, publicationRequestId: '' };
  }

  async read(_ctx: AuthorizedContext, ref: DocumentRef, manifest: ArtifactRef, _purpose: Purpose): Promise<InputProjection> {
    const manifestRecord = this.db.getArtifact(ref.workspaceId, manifest.artifactId);
    if (!manifestRecord || manifestRecord.kind !== 'dataset/manifest' || manifestRecord.sha256 !== manifest.sha256 || manifestRecord.size_bytes !== manifest.sizeBytes) throw productError({ code: 'EVIDENCE_NOT_FOUND', category: 'state', source: { component: 'voxel51', operation: 'read' }, safeMessage: 'The dataset manifest is not registered for this workspace', impactScope: 'call', recoveryAction: 'correct_input', correlation: { workspaceId: ref.workspaceId, artifactId: manifest.artifactId } });
    const manifestBytes = await this.files.readInstanceArtifact(manifestRecord.relative_path, manifestRecord.sha256, manifestRecord.size_bytes, 16_777_216);
    const manifestValue = parseJson<{ documents?: Array<{ documentId: string; version: string }> }>(manifestBytes, 'dataset manifest');
    if (!manifestValue.documents?.some((item) => item.documentId === ref.documentId && item.version === ref.version)) throw productError({ code: 'DOCUMENT_UNAVAILABLE', category: 'state', source: { component: 'voxel51', operation: 'read' }, safeMessage: 'The document is not a member of the supplied dataset manifest', impactScope: 'call', recoveryAction: 'correct_input', correlation: { workspaceId: ref.workspaceId, documentId: ref.documentId } });
    const record = this.db.getDocumentRecord(ref);
    if (!record || record.status !== 'available') throw productError({ code: record?.status === 'withdrawn' ? 'DOCUMENT_WITHDRAWN' : 'DOCUMENT_UNAVAILABLE', category: 'state', source: { component: 'voxel51', operation: 'read' }, safeMessage: 'The document is not currently available for reading', impactScope: 'call', recoveryAction: 'manual_review', correlation: { workspaceId: ref.workspaceId, documentId: ref.documentId } });
    if (record.original_sha256 !== ref.originalSha256 || record.parse_hash !== ref.parseHash) throw productError({ code: 'VERSION_CONFLICT', category: 'state', source: { component: 'voxel51', operation: 'read' }, safeMessage: 'The supplied document identity does not match the stored version', impactScope: 'call', recoveryAction: 'correct_input', correlation: { workspaceId: ref.workspaceId, documentId: ref.documentId } });
    const metadata = JSON.parse(record.source_metadata_json) as SampleMetadata & { artifactMap: Record<string, string>; sampleId: string };
    const contentArtifact = this.db.getArtifact(ref.workspaceId, metadata.artifactMap['content.json']);
    const pagesArtifact = this.db.getArtifact(ref.workspaceId, metadata.artifactMap['pages.json']);
    const originalArtifact = this.db.getArtifact(ref.workspaceId, record.original_artifact_id);
    if (!contentArtifact || !pagesArtifact || !originalArtifact || !record.parsed_artifact_id) throw this.inputError('INPUT_INCOMPLETE');
    const originalBytes = await this.files.readInstanceArtifact(originalArtifact.relative_path, originalArtifact.sha256, originalArtifact.size_bytes, 67_108_864);
    if (!validImageBytes(originalBytes, 'original.jpg')) throw productError({ code: 'IMAGE_UNREADABLE', category: 'storage', source: { component: 'voxel51', operation: 'read' }, safeMessage: 'The stored original image is not structurally readable', impactScope: 'call', recoveryAction: 'manual_review', correlation: { workspaceId: ref.workspaceId, documentId: ref.documentId } });
    const content = await this.files.readInstanceArtifact(contentArtifact.relative_path, contentArtifact.sha256, contentArtifact.size_bytes, 67_108_864);
    const pages = await this.files.readInstanceArtifact(pagesArtifact.relative_path, pagesArtifact.sha256, pagesArtifact.size_bytes, 67_108_864);
    const verificationRef = record.verification_ref ? JSON.parse(record.verification_ref) as ArtifactRef : manifest;
    const parsed = mapParsed(ref, metadata, content, pages, this.db, this.files, verificationRef);
    const evidence: ArtifactRef[] = [];
    const loadedArtifacts = new Set([originalArtifact.artifact_id, contentArtifact.artifact_id, pagesArtifact.artifact_id]);
    for (const [path, artifactId] of Object.entries(metadata.artifactMap)) {
      const artifact = this.db.getArtifact(ref.workspaceId, artifactId);
      if (!artifact) throw this.inputError('INPUT_INCOMPLETE');
      if (!loadedArtifacts.has(artifact.artifact_id)) {
        const bytes = await this.files.readInstanceArtifact(artifact.relative_path, artifact.sha256, artifact.size_bytes, 67_108_864);
        if (isImagePath(path) && !validImageBytes(bytes, path)) throw productError({ code: 'IMAGE_UNREADABLE', category: 'storage', source: { component: 'voxel51', operation: 'read' }, safeMessage: 'A referenced image artifact is not structurally readable', impactScope: 'call', recoveryAction: 'manual_review', correlation: { workspaceId: ref.workspaceId, documentId: ref.documentId } });
      }
      if (path.startsWith('assets/')) {
        evidence.push({ artifactId: artifact.artifact_id, workspaceId: artifact.workspace_id, sha256: artifact.sha256, sizeBytes: artifact.size_bytes, kind: artifact.kind });
      }
    }
    return { schemaVersion: 'p0-input/v1', document: ref as import('../../../contracts/src/index.ts').ReadableDocumentRef, manifest, parsed, evidence };
  }

  private async loadManifest(expectedHash: string): Promise<SourceManifest> {
    const bytes = await this.readSourceBytes('manifest.json', 16_777_216);
    requireSha256(expectedHash, 'manifestSha256');
    if (sha256Bytes(bytes) !== expectedHash) throw productError({ code: 'FILE_DIGEST_MISMATCH', category: 'input', source: { component: 'voxel51', operation: 'manifest' }, safeMessage: 'The source manifest is not the approved version', impactScope: 'call', recoveryAction: 'correct_input', correlation: { workspaceId: this.workspaceId } });
    return parseJson<SourceManifest>(bytes, 'manifest');
  }

  private async readMetadata(sample: SourceSample): Promise<SampleMetadata> {
    const bytes = await this.files.readVerified({ root: 'source', relativePath: sample.metadata.path, expectedSha256: sample.metadata.sha256, expectedBytes: sample.metadata.bytes, maxBytes: 16_777_216 });
    const metadata = parseJson<SampleMetadata>(bytes, `${sample.sampleId}/metadata`);
    if (metadata.sampleId !== sample.sampleId || metadata.originalSha256 !== sample.originalSha256 || !Array.isArray(metadata.files)) throw this.schemaError(`${sample.sampleId}/metadata`);
    const paths = new Set<string>();
    for (const file of metadata.files) {
      try { validateRelativePath(file.path); } catch { throw productError({ code: 'PATH_FORBIDDEN', category: 'authorization', source: { component: 'voxel51', operation: 'metadata' }, safeMessage: 'The source metadata contains a forbidden file path', impactScope: 'call', recoveryAction: 'correct_input', correlation: { workspaceId: this.workspaceId } }); }
      if (paths.has(file.path) || !isAllowedSourceFile(file.path)) throw this.schemaError(`${sample.sampleId}/metadata/files`);
      paths.add(file.path);
      requireSha256(file.sha256, `${sample.sampleId}/${file.path}`);
      if (!Number.isSafeInteger(file.bytes) || file.bytes < 0) throw this.schemaError(`${sample.sampleId}/metadata/files`);
    }
    if (!paths.has('original.jpg') || !paths.has('content.json') || !paths.has('pages.json')) throw this.inputError('INPUT_INCOMPLETE');
    return metadata;
  }

  private async readSourceBytes(relativePath: string, maxBytes: number): Promise<Uint8Array> {
    const bytes = await readFile(join(this.sourceRoot, relativePath));
    if (bytes.byteLength > maxBytes) throw productError({ code: 'INPUT_LIMIT_EXCEEDED', category: 'input', source: { component: 'voxel51', operation: 'readSource' }, safeMessage: 'The source manifest exceeds the configured limit', impactScope: 'call', recoveryAction: 'correct_input', correlation: { workspaceId: this.workspaceId } });
    return bytes;
  }

  private schemaError(detail: string) { return productError({ code: 'PARSE_SCHEMA_INVALID', category: 'input', source: { component: 'voxel51', operation: 'validate' }, safeMessage: `The approved parsed input is not valid: ${detail}`, impactScope: 'call', recoveryAction: 'correct_input', correlation: { workspaceId: this.workspaceId } }); }
  private inputError(code: string) { return productError({ code, category: 'input', source: { component: 'voxel51', operation: 'input' }, safeMessage: 'The approved input is incomplete', impactScope: 'call', recoveryAction: 'correct_input', correlation: { workspaceId: this.workspaceId } }); }
}

function parseJson<T>(bytes: Uint8Array, detail: string): T {
  try { return JSON.parse(new TextDecoder().decode(bytes)) as T; } catch (error) { throw productError({ code: 'PARSE_SCHEMA_INVALID', category: 'input', source: { component: 'voxel51', operation: 'json' }, safeMessage: `The approved JSON could not be read: ${detail}`, impactScope: 'call', recoveryAction: 'correct_input', correlation: {} }, { cause: error as Error }); }
}

function mediaTypeFor(path: string): string { const lower = path.toLowerCase(); return lower.endsWith('.jpg') || lower.endsWith('.jpeg') ? 'image/jpeg' : lower.endsWith('.png') ? 'image/png' : lower.endsWith('.md') ? 'text/markdown' : 'application/json'; }

function isAllowedSourceFile(path: string): boolean {
  if (path === 'original.jpg' || path === 'content.json' || path === 'content.md' || path === 'pages.json') return true;
  return /^assets\/images\/[^/]+\.(?:jpg|jpeg|png)$/i.test(path);
}

function isImagePath(path: string): boolean { return /\.(?:jpg|jpeg|png)$/i.test(path); }

function validImageBytes(bytes: Uint8Array, path: string): boolean {
  if (/\.png$/i.test(path)) {
    const signature = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
    if (bytes.length < 33 || !signature.every((value, index) => bytes[index] === value)) return false;
    let offset = 8;
    let hasHeader = false;
    let hasData = false;
    while (offset + 12 <= bytes.length) {
      const length = new DataView(bytes.buffer, bytes.byteOffset + offset, 4).getUint32(0);
      const type = String.fromCharCode(bytes[offset + 4], bytes[offset + 5], bytes[offset + 6], bytes[offset + 7]);
      const end = offset + 12 + length;
      if (end > bytes.length) return false;
      if (type === 'IHDR') hasHeader = length >= 13;
      if (type === 'IDAT' && length > 0) hasData = true;
      if (type === 'IEND') return hasHeader && hasData && length === 0;
      offset = end;
    }
    return false;
  }
  if (!/\.(?:jpg|jpeg)$/i.test(path) || bytes.length < 4 || bytes[0] !== 0xff || bytes[1] !== 0xd8) return false;
  for (let index = bytes.length - 2; index >= 2; index -= 1) if (bytes[index] === 0xff && bytes[index + 1] === 0xd9) return true;
  return false;
}

function computeParseHash(metadata: SampleMetadata, content: Uint8Array, pages: Uint8Array): string {
  return sha256Canonical({ parserKey: metadata.parserKey ?? null, parseAttemptId: metadata.parseAttemptId ?? null, contentSha256: sha256Bytes(content), pagesSha256: sha256Bytes(pages) });
}

function validateParsePair(content: unknown[], pages: unknown[], metadata: SampleMetadata): void {
  if (content.length === 0 || pages.length === 0) throw productError({ code: 'INPUT_INCOMPLETE', category: 'input', source: { component: 'voxel51', operation: 'validatePair' }, safeMessage: 'The approved parse contains no pages or content blocks', impactScope: 'call', recoveryAction: 'correct_input', correlation: {} });
  const supportedBlockTypes = new Set(['text', 'header', 'footer', 'page_footnote', 'page_number', 'table', 'image']);
  const pageNumbers = new Set<number>();
  const counts = new Map<number, number>();
  for (const page of pages) {
    const value = page as { pageNumber?: unknown; blockCount?: unknown };
    if (!Number.isInteger(value.pageNumber) || Number(value.pageNumber) < 1 || pageNumbers.has(Number(value.pageNumber))) throw productError({ code: 'INPUT_PAIR_MISMATCH', category: 'input', source: { component: 'voxel51', operation: 'validatePair' }, safeMessage: 'The parse page descriptors are not a unique sequence', impactScope: 'call', recoveryAction: 'correct_input', correlation: {} });
    pageNumbers.add(Number(value.pageNumber));
    counts.set(Number(value.pageNumber), 0);
    if (value.blockCount !== undefined && (!Number.isInteger(value.blockCount) || Number(value.blockCount) < 0)) throw productError({ code: 'PARSE_SCHEMA_INVALID', category: 'input', source: { component: 'voxel51', operation: 'validatePair' }, safeMessage: 'The parse page block count is invalid', impactScope: 'call', recoveryAction: 'correct_input', correlation: {} });
  }
  for (const block of content) {
    const value = block as { type?: unknown; page_idx?: unknown; text?: unknown; table_body?: unknown; img_path?: unknown };
    if (typeof value.type !== 'string' || !supportedBlockTypes.has(value.type)) throw productError({ code: 'PARSE_SCHEMA_INVALID', category: 'input', source: { component: 'voxel51', operation: 'validateParsePair' }, safeMessage: 'The parsed content contains an unsupported block type', impactScope: 'call', recoveryAction: 'correct_input', correlation: {} });
    if (['text', 'header', 'footer', 'page_footnote', 'page_number'].includes(value.type) && typeof value.text !== 'string') throw productError({ code: 'PARSE_SCHEMA_INVALID', category: 'input', source: { component: 'voxel51', operation: 'validateParsePair' }, safeMessage: 'A text-like parsed block has no text value', impactScope: 'call', recoveryAction: 'correct_input', correlation: {} });
    if (value.type === 'table' && typeof value.table_body !== 'string') throw productError({ code: 'PARSE_SCHEMA_INVALID', category: 'input', source: { component: 'voxel51', operation: 'validateParsePair' }, safeMessage: 'A table parsed block has no table body', impactScope: 'call', recoveryAction: 'correct_input', correlation: {} });
    if ((value.type === 'table' || value.type === 'image') && typeof value.img_path !== 'string') throw productError({ code: 'INPUT_PAIR_MISMATCH', category: 'input', source: { component: 'voxel51', operation: 'validateParsePair' }, safeMessage: 'A visual parsed block has no approved image reference', impactScope: 'call', recoveryAction: 'correct_input', correlation: {} });
    const page = Number(value.page_idx) + 1;
    if (!Number.isInteger(page) || !pageNumbers.has(page)) throw productError({ code: 'INPUT_PAIR_MISMATCH', category: 'input', source: { component: 'voxel51', operation: 'validatePair' }, safeMessage: 'A parse block refers to a missing page', impactScope: 'call', recoveryAction: 'correct_input', correlation: {} });
    counts.set(page, (counts.get(page) ?? 0) + 1);
    if (typeof value.img_path === 'string' && !metadata.files.some((file) => file.path === value.img_path)) throw productError({ code: 'INPUT_PAIR_MISMATCH', category: 'input', source: { component: 'voxel51', operation: 'validatePair' }, safeMessage: 'A parse block refers to an unlisted image', impactScope: 'call', recoveryAction: 'correct_input', correlation: {} });
  }
  for (const page of pages) {
    const value = page as { pageNumber: number; blockCount?: number };
    if (value.blockCount !== undefined && value.blockCount !== counts.get(value.pageNumber)) throw productError({ code: 'INPUT_PAIR_MISMATCH', category: 'input', source: { component: 'voxel51', operation: 'validatePair' }, safeMessage: 'Page block counts do not match parsed content', impactScope: 'call', recoveryAction: 'correct_input', correlation: {} });
  }
}

function mapParsed(ref: DocumentRef, metadata: SampleMetadata & { artifactMap: Record<string, string> }, contentBytes: Uint8Array, pagesBytes: Uint8Array, db: FoundationDatabase, _files: InstanceFileStore, verificationRef: ArtifactRef): ParsedDocument {
  const content = parseJson<unknown[]>(contentBytes, 'content');
  const pages = parseJson<unknown[]>(pagesBytes, 'pages');
  const byPage = new Map<number, ParsedBlock[]>();
  for (const page of pages) {
    const p = page as { pageNumber?: number; text?: string };
    if (!Number.isInteger(p.pageNumber) || (p.pageNumber as number) < 1) throw productError({ code: 'PARSE_SCHEMA_INVALID', category: 'input', source: { component: 'voxel51', operation: 'pages' }, safeMessage: 'The parsed page numbering is invalid', impactScope: 'call', recoveryAction: 'correct_input', correlation: { documentId: ref.documentId } });
    byPage.set(p.pageNumber as number, []);
  }
  for (let index = 0; index < content.length; index += 1) {
    const block = content[index] as Record<string, unknown>;
    const pageNumber = Number(block.page_idx) + 1;
    if (!Number.isInteger(pageNumber) || pageNumber < 1) throw productError({ code: 'PARSE_SCHEMA_INVALID', category: 'input', source: { component: 'voxel51', operation: 'content' }, safeMessage: 'The parsed block page index is invalid', impactScope: 'call', recoveryAction: 'correct_input', correlation: { documentId: ref.documentId } });
    const blocks = byPage.get(pageNumber);
    if (!blocks) throw productError({ code: 'INPUT_INCOMPLETE', category: 'input', source: { component: 'voxel51', operation: 'content' }, safeMessage: 'A parsed block refers to a missing page', impactScope: 'call', recoveryAction: 'correct_input', correlation: { documentId: ref.documentId } });
    const bbox = Array.isArray(block.bbox) && block.bbox.length === 4 && block.bbox.every((item) => typeof item === 'number' && Number.isFinite(item)) ? block.bbox as [number, number, number, number] : undefined;
    if (block.type === 'text' || block.type === 'header' || block.type === 'footer' || block.type === 'page_footnote' || block.type === 'page_number') {
      // MinerU emits layout-specific text block types in addition to `text`.
      // They share the public P0 text projection while retaining their source
      // pointer, so the product does not discard valid prepared input.
      blocks.push({ kind: 'text', text: typeof block.text === 'string' ? block.text : '', sourcePointer: `/content/${index}`, ...(bbox ? { bbox } : {}) });
    }
    else if (block.type === 'table') {
      const image = typeof block.img_path === 'string' ? artifactFromPath(metadata, block.img_path, db, ref.workspaceId) : undefined;
      blocks.push({ kind: 'table', tableHtml: typeof block.table_body === 'string' ? block.table_body : '', sourcePointer: `/content/${index}`, ...(image ? { image } : {}), ...(bbox ? { bbox } : {}) });
    }
    else if (block.type === 'image') {
      const imagePath = typeof block.img_path === 'string' ? block.img_path : typeof block.image_path === 'string' ? block.image_path : undefined;
      const image = imagePath ? artifactFromPath(metadata, imagePath, db, ref.workspaceId) : undefined;
      if (!image) throw productError({ code: 'INPUT_PAIR_MISMATCH', category: 'input', source: { component: 'voxel51', operation: 'content' }, safeMessage: 'An image block has no approved image artifact', impactScope: 'call', recoveryAction: 'correct_input', correlation: { documentId: ref.documentId } });
      blocks.push({ kind: 'image', image, sourcePointer: `/content/${index}`, ...(bbox ? { bbox } : {}) });
    }
    else throw productError({ code: 'PARSE_SCHEMA_INVALID', category: 'input', source: { component: 'voxel51', operation: 'content' }, safeMessage: 'The parsed content contains an unsupported block type', impactScope: 'call', recoveryAction: 'correct_input', correlation: { documentId: ref.documentId } });
  }
  return { schemaVersion: 'parsed-document/v1', document: ref as import('../../../contracts/src/index.ts').ReadableDocumentRef, sourceRecordId: metadata.sourceRecordId, sourceRef: { sourceKey: 'voxel51', sourceRevision: metadata.datasetRevision ?? 'unknown' }, originalHash: metadata.originalSha256, parser: { key: metadata.parserKey ?? 'unknown' }, contentHash: sha256Bytes(contentBytes), integrity: { status: 'verified', verificationRef }, warnings: [], pages: [...byPage.entries()].sort(([a], [b]) => a - b).map(([pageNumber, blocks]) => ({ pageNumber, blocks })) };
}

function artifactFromPath(metadata: SampleMetadata & { artifactMap: Record<string, string> }, path: string, db: FoundationDatabase, workspaceId: string): ArtifactRef {
  const artifactId = metadata.artifactMap[path];
  const artifact = artifactId ? db.getArtifact(workspaceId, artifactId) : null;
  if (!artifact) throw productError({ code: 'INPUT_PAIR_MISMATCH', category: 'input', source: { component: 'voxel51', operation: 'imageRef' }, safeMessage: 'A parsed image reference is not in the approved artifact set', impactScope: 'call', recoveryAction: 'correct_input', correlation: { workspaceId } });
  return { artifactId: artifact.artifact_id, workspaceId: artifact.workspace_id, sha256: artifact.sha256, sizeBytes: artifact.size_bytes, kind: artifact.kind };
}
