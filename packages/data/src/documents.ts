import { randomUUID } from 'node:crypto';
import {
  appError,
  fail,
  ok,
  ParsedBlockSchema,
  MAX_INVOICE_PAGES,
  MAX_INVOICE_BLOCKS_PER_PAGE,
  MAX_INVOICE_VERSION_CHARS,
  DocumentRefSchema,
  ContextMaterialRequestSchema,
  PreparedInvoiceMaterialSchema,
} from '@flowmate/contracts';
import type {
  DocumentSnapshot,
  ProductPaths,
  ProductToolContext,
  Result,
  RunScope,
  DocumentRef,
  WorkspaceMaterialInspection,
  ContextMaterialPort,
  ContextParsedMaterial,
} from '@flowmate/contracts';
import { mapVoxel51ParsedDocument, parseVoxel51Sample } from './parsed-document.ts';
import { isSupportedOriginal, readVoxel51Files } from './source/voxel51.ts';

const MAX_WORKSPACE_ORIGINAL_BYTES = 10 * 1024 * 1024;

export type StoredParsedDocument = {
  formatVersion: 2;
  pages: Array<{ page: number; blocks: Array<ReturnType<typeof ParsedBlockSchema.parse>> }>;
  completeness: { status: 'complete'; checks: string[]; warnings: string[] };
};

type StoredArtifact = {
  artifactId: number;
  kind: 'original' | 'parsed';
  relativePath: string;
  bytes: number;
  mimeType: string;
  metadata: { version: 1; sourceKey: string; sourceRecordId: string; sourceVersion: string;
    files: Array<{ relativePath: string; bytes: number; mimeType: string }> };
};

type PublishedArtifact = StoredArtifact & { createdAt: string };
type PublishArtifactInput = {
  sourceKey: string; sourceRecordId: string; sourceVersion: string; at: string;
  original: { kind: 'original'; primaryName: string; files: Array<{ name: string; bytes: Uint8Array; mimeType: string }> };
  parsed: { kind: 'parsed'; primaryName: string; files: Array<{ name: string; bytes: Uint8Array; mimeType: string }> };
};
type PublishedArtifactPair = { documentId: number; original: PublishedArtifact; parsed: PublishedArtifact };
type NewDocumentRegistration = {
  documentId: number; sourceKey: string; sourceRecordId: string; version: string;
  originalArtifact: PublishedArtifact; parsedArtifact: PublishedArtifact;
  status: 'available' | 'unavailable';
  metadata: { version: 2; sampleId?: string; pageCount: number; warnings: string[];
    allowedUsesClaim: string[]; licenseVerification: string; unavailableReason: string | null };
  createdAt: string; updatedAt: string;
};

export interface DocumentRepository {
  findVersions?(input: { sourceKey: string; sourceRecordId: string }): Result<DocumentSnapshot[]>;
  findBySource(input: { sourceKey: string; sourceRecordId: string; version: string }): Result<DocumentSnapshot | null>;
  get(documentId: number): Result<DocumentSnapshot>;
  getArtifact(artifactId: number): Result<StoredArtifact>;
  register(input: NewDocumentRegistration): Result<DocumentSnapshot>;
  setAvailability(input: { documentId: number; status: 'available' | 'unavailable'; reason: string | null; at: string }): Result<DocumentSnapshot>;
  unhide(documentId: number, at: string): Result<DocumentSnapshot>;
}
export interface FileStore {
  publish(input: PublishArtifactInput): Promise<Result<PublishedArtifactPair>>;
  publish<T>(input: PublishArtifactInput, workflow: {
    findExisting(): Promise<Result<T | null>>;
    register(published: PublishedArtifactPair): Promise<Result<T>>;
  }): Promise<Result<T>>;
  read(artifact: StoredArtifact, fileName?: string): Result<Uint8Array>;
}

function cancelled(signal?: AbortSignal): boolean { return signal?.aborted === true; }

function parseJson(bytes: Uint8Array): unknown {
  return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes)) as unknown;
}

function decodeParsed(value: unknown): StoredParsedDocument {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('invalid_parsed_document');
  const parsed = value as Record<string, unknown>;
  if ((parsed.formatVersion !== 1 && parsed.formatVersion !== 2)
    || (parsed.formatVersion === 2 && 'parser' in parsed)
    || !Array.isArray(parsed.pages) || parsed.pages.length < 1 || parsed.pages.length > MAX_INVOICE_PAGES
    || !parsed.completeness || typeof parsed.completeness !== 'object' || Array.isArray(parsed.completeness)) throw new Error('invalid_parsed_document');
  const completeness = parsed.completeness as Record<string, unknown>;
  if (completeness.status !== 'complete' || !Array.isArray(completeness.checks) || !completeness.checks.every((item) => typeof item === 'string')
    || !Array.isArray(completeness.warnings) || !completeness.warnings.every((item) => typeof item === 'string')) throw new Error('invalid_parsed_document');
  const pages = parsed.pages.map((value) => {
    if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('invalid_parsed_page');
    const page = value as Record<string, unknown>;
    if (!Number.isSafeInteger(page.page) || Number(page.page) < 1 || Number(page.page) > MAX_INVOICE_PAGES || !Array.isArray(page.blocks)
      || page.blocks.length > MAX_INVOICE_BLOCKS_PER_PAGE) throw new Error('invalid_parsed_page');
    return { page: Number(page.page), blocks: page.blocks.map((block) => ParsedBlockSchema.parse(block)) };
  });
  return { formatVersion: 2, pages,
    completeness: completeness as StoredParsedDocument['completeness'] };
}

function newDocumentVersion(): string { return randomUUID(); }

function preparedOriginal(bytes: Uint8Array, name: string): boolean {
  if (bytes.byteLength < 1 || bytes.byteLength > MAX_WORKSPACE_ORIGINAL_BYTES) return false;
  if (name === 'original.pdf') return Buffer.from(bytes).subarray(0, 5).toString('ascii') === '%PDF-'
    && Buffer.from(bytes).subarray(-1024).toString('ascii').includes('%%EOF');
  try { return name === 'source.md' && new TextDecoder('utf-8', { fatal: true }).decode(bytes).trim().length > 0; }
  catch { return false; }
}

function scopeAllows(scope: RunScope, document: DocumentSnapshot): boolean {
  return scope.allowedDocumentIds.includes(document.documentRef.id)
    && scope.allowedArtifactIds.includes(document.parsedArtifactId);
}

export type DocumentServiceOptions = {
  paths: ProductPaths;
  allowedSourceRoot: string;
  files: Pick<FileStore, 'publish'>;
  now: () => string;
  transaction: <T>(operation: (current: MaterialInspectionOptions) => Result<T>) => Promise<Result<T>>;
};
export type MaterialInspectionOptions = { repository: DocumentRepository; files: Pick<FileStore, 'read'> };

export class DocumentService {
  private tail: Promise<void> = Promise.resolve();

  public constructor(private readonly options: DocumentServiceOptions) {}

  private async transaction<T>(operation: (current: MaterialInspectionOptions) => Result<T>): Promise<Result<T>> {
    try { return await this.options.transaction(operation); }
    catch { return fail(appError('storage_write_failed', 'storage', 'Document facts could not be saved or confirmed.', true)); }
  }

  private async registerPublished(input: NewDocumentRegistration, signal?: AbortSignal): Promise<Result<DocumentSnapshot>> {
    const saved = await this.transaction(current => cancelled(signal)
      ? fail(appError('operation_cancelled', 'runtime', '材料导入已取消；已发布文件保留为待核对孤儿。'))
      : current.repository.register(input));
    if (saved.ok || saved.error.code === 'operation_cancelled') return saved;
    const found = await this.transaction(current => current.repository.findBySource({
      sourceKey: input.sourceKey, sourceRecordId: input.sourceRecordId, version: input.version,
    }));
    if (found.ok && found.data && found.data.documentRef.id === input.documentId
      && found.data.originalArtifactId === input.originalArtifact.artifactId && found.data.parsedArtifactId === input.parsedArtifact.artifactId
      && found.data.status === input.status && found.data.pageCount === input.metadata.pageCount
      && found.data.createdAt === input.createdAt && found.data.updatedAt === input.updatedAt) return ok(found.data);
    return saved;
  }

  public importPrepared(raw: unknown, signal?: AbortSignal): Promise<Result<DocumentSnapshot>> {
    try { raw = structuredClone(raw); }
    catch { return Promise.resolve(fail(appError('input_invalid', 'input', 'Prepared invoice source is invalid.'))); }
    const previous = this.tail;
    let release!: () => void;
    this.tail = new Promise<void>(resolve => { release = resolve; });
    return previous.then(() => this.importPreparedLocked(raw, signal)).catch(() =>
      fail(appError('source_invalid', 'input', 'Prepared invoice source is invalid.'))).finally(release);
  }

  private async importPreparedLocked(raw: unknown, signal?: AbortSignal): Promise<Result<DocumentSnapshot>> {
    const checked = PreparedInvoiceMaterialSchema.safeParse(raw);
    if (!checked.success) return fail(appError('input_invalid', 'input', 'Prepared invoice source is invalid.'));
    if (cancelled(signal)) return fail(appError('operation_cancelled', 'runtime', '材料导入已取消。'));
    const input = checked.data, originalBytes = Buffer.from(input.original.base64, 'base64');
    if (!preparedOriginal(originalBytes, input.original.name) || originalBytes.toString('base64') !== input.original.base64
      || input.original.name === 'source.md' && new TextDecoder('utf-8', { fatal: true }).decode(originalBytes) !== input.sourceText)
      return fail(appError('source_invalid', 'input', 'Prepared original differs from its frozen bytes or text.'));
    const sourceKey = 'prepared-invoice', sourceRecordId = input.sample;
    const parsed: StoredParsedDocument = { formatVersion: 2, pages: input.pages,
      completeness: { status: 'complete', checks: ['frozen-prepared-source', 'sequential-pages-and-blocks'], warnings: [] } };
    const parsedBytes = Buffer.from(JSON.stringify(parsed)), contentBytes = Buffer.from(JSON.stringify(input.sourceText));
    const pagesBytes = Buffer.from(JSON.stringify(input.pages)), sourceBytes = Buffer.from(JSON.stringify({
      contract: input.contract, sample: input.sample, original: { name: input.original.name } }));
    const version = newDocumentVersion();
    const now = this.options.now();
    return this.options.files.publish({ sourceKey, sourceRecordId, sourceVersion: version, at: now,
      original: { kind: 'original', primaryName: input.original.name, files: [{ name: input.original.name, bytes: originalBytes,
        mimeType: input.original.name === 'original.pdf' ? 'application/pdf' : 'text/markdown' }] },
      parsed: { kind: 'parsed', primaryName: 'parsed.json', files: [
        { name: 'parsed.json', bytes: parsedBytes, mimeType: 'application/json' },
        { name: 'raw-content.json', bytes: contentBytes, mimeType: 'application/json' },
        { name: 'raw-pages.json', bytes: pagesBytes, mimeType: 'application/json' },
        { name: 'source.json', bytes: sourceBytes, mimeType: 'application/json' }
      ] } }, {
      findExisting: () => this.transaction(current => {
        if (cancelled(signal)) return fail(appError('operation_cancelled', 'runtime', '材料导入已取消。'));
        const versions = current.repository.findVersions?.({ sourceKey, sourceRecordId });
        if (versions && !versions.ok) return versions;
        for (const prior of versions?.ok ? versions.data : []) {
          const same = this.sameVersion(prior, originalBytes, contentBytes, pagesBytes, parsedBytes, sourceBytes, input.original.name, current);
          if (same.ok || same.error.code !== 'document_version_conflict') return same;
        }
        const existing = current.repository.findBySource({ sourceKey, sourceRecordId, version });
        if (!existing.ok) return existing;
        return existing.data ? this.sameVersion(existing.data, originalBytes, contentBytes, pagesBytes, parsedBytes, sourceBytes, input.original.name, current) : ok(null);
      }),
      register: published => this.registerPublished({ documentId: published.documentId, sourceKey, sourceRecordId, version: published.original.metadata.sourceVersion,
        originalArtifact: published.original, parsedArtifact: published.parsed, status: 'available',
        metadata: { version: 2, pageCount: input.pages.length, warnings: [], allowedUsesClaim: ['frozen-prepared-material'],
          licenseVerification: 'caller-supplied', unavailableReason: null }, createdAt: now, updatedAt: now }, signal),
    });
  }

  public importVoxel51(input: { sourceDirectory: string }, signal?: AbortSignal): Promise<Result<DocumentSnapshot>> {
    input = { ...input };
    const previous = this.tail;
    let release!: () => void;
    this.tail = new Promise<void>((resolveLock) => { release = resolveLock; });
    return previous.then(() => this.importVoxel51Locked(input, signal)).catch(() =>
      fail(appError('source_invalid', 'input', '来源材料结构无效。')),
    ).finally(release);
  }

  private async importVoxel51Locked(input: { sourceDirectory: string }, signal?: AbortSignal): Promise<Result<DocumentSnapshot>> {
    if (cancelled(signal)) return fail(appError('operation_cancelled', 'runtime', '材料导入已取消。'));
    const source = readVoxel51Files(input.sourceDirectory, this.options.paths.root, signal, this.options.allowedSourceRoot);
    if (!source.ok) return source;
    const { originalFileName, originalMimeType, originalBytes, contentBytes, pagesBytes, metadataBytes } = source.data;
    const parsed = parseVoxel51Sample(source.data);
    if (!parsed.ok) return parsed;
    const version = newDocumentVersion();
    if (version.length > MAX_INVOICE_VERSION_CHARS) return fail(appError('source_invalid', 'input', '来源版本超过支持范围。'));
    const sourceRecord = {
      version: 2,
      sourceKey: parsed.data.sourceKey,
      sampleId: parsed.data.sampleId,
      sourceRecordId: parsed.data.sourceRecordId,
      datasetRevision: parsed.data.datasetRevision,
      allowedUsesClaim: parsed.data.allowedUsesClaim,
      licenseVerification: parsed.data.licenseVerification,
      metadataBytes: Buffer.from(metadataBytes).toString('base64'),
      original: { fileName: originalFileName, bytes: originalBytes.byteLength },
      files: [
        { name: 'content.json', bytes: contentBytes.byteLength },
        { name: 'pages.json', bytes: pagesBytes.byteLength },
      ],
    };
    const parsedBytes = Buffer.from(JSON.stringify(parsed.data.parsed), 'utf8');
    const sourceBytes = Buffer.from(JSON.stringify(sourceRecord), 'utf8');
    if (cancelled(signal)) return fail(appError('operation_cancelled', 'runtime', '材料导入已取消。'));
    const now = this.options.now();
    const publish: PublishArtifactInput = {
      sourceKey: parsed.data.sourceKey, sourceRecordId: parsed.data.sourceRecordId, sourceVersion: version, at: now,
      original: { kind: 'original', primaryName: originalFileName,
        files: [{ name: originalFileName, bytes: originalBytes, mimeType: originalMimeType }] },
      parsed: { kind: 'parsed', primaryName: 'parsed.json', files: [
        { name: 'parsed.json', bytes: parsedBytes, mimeType: 'application/json' },
        { name: 'raw-content.json', bytes: contentBytes, mimeType: 'application/json' },
        { name: 'raw-pages.json', bytes: pagesBytes, mimeType: 'application/json' },
        { name: 'source.json', bytes: sourceBytes, mimeType: 'application/json' },
      ] },
    };
    return this.options.files.publish(publish, {
      findExisting: () => this.transaction(current => {
        if (cancelled(signal)) return fail(appError('operation_cancelled', 'runtime', '材料导入已取消。'));
        const existing = current.repository.findBySource({ sourceKey: parsed.data.sourceKey, sourceRecordId: parsed.data.sourceRecordId, version });
        if (!existing.ok) return existing;
        const versions = current.repository.findVersions?.({ sourceKey: parsed.data.sourceKey, sourceRecordId: parsed.data.sourceRecordId });
        if (versions && !versions.ok) return versions;
        for (const prior of versions?.ok ? versions.data : []) {
          const same = this.sameVersion(prior, originalBytes, contentBytes, pagesBytes, parsedBytes, sourceBytes, originalFileName, current);
          if (same.ok || same.error.code !== 'document_version_conflict') return same;
        }
        return existing.data ? this.sameVersion(existing.data, originalBytes, contentBytes, pagesBytes, parsedBytes, sourceBytes, originalFileName, current) : ok(null);
      }),
      register: published => this.registerPublished({
      documentId: published.documentId,
      sourceKey: parsed.data.sourceKey, sourceRecordId: parsed.data.sourceRecordId, version: published.original.metadata.sourceVersion,
      originalArtifact: published.original, parsedArtifact: published.parsed,
      status: 'available', metadata: {
        version: 2, sampleId: parsed.data.sampleId, pageCount: parsed.data.parsed.pages.length,
        warnings: parsed.data.parsed.completeness.warnings,
        allowedUsesClaim: parsed.data.allowedUsesClaim,
        licenseVerification: parsed.data.licenseVerification,
        unavailableReason: null,
      },
      createdAt: now, updatedAt: now,
      }, signal),
    });
  }

  public readOriginalForWorkspace(documentId: number, page: number): Promise<Result<{ documentRef: DocumentSnapshot['documentRef']; mimeType: 'image/jpeg' | 'image/png'; bytes: Uint8Array }>> {
    return this.transaction(options => {
    if (!Number.isSafeInteger(documentId) || documentId < 1 || page !== 1) return fail(appError('input_invalid', 'input', '原图引用无效。'));
    const document = options.repository.get(documentId);
    if (!document.ok) return document;
    if (document.data.status !== 'available') return fail(appError('input_unavailable', 'input', '材料当前不可读取。', true));
    const artifact = options.repository.getArtifact(document.data.originalArtifactId);
    if (!artifact.ok) return artifact;
    const fileName = artifact.data.relativePath.slice(artifact.data.relativePath.lastIndexOf('/') + 1);
    const bytes = options.files.read(artifact.data, fileName);
    if (!bytes.ok) return bytes.error.code === 'artifact_unavailable'
      ? this.unavailableDocument(documentId, 'original_artifact_missing_or_corrupt', undefined, options.repository) : bytes;
    if (bytes.data.byteLength > MAX_WORKSPACE_ORIGINAL_BYTES) return fail(appError('tool_result_too_large', 'runtime', '原图超过桌面读取大小限制。'));
    const mimeType = artifact.data.mimeType;
    if (artifact.data.metadata.sourceKey === 'prepared-invoice' && preparedOriginal(bytes.data, fileName))
      return fail(appError('input_unavailable', 'input', 'This prepared original has no image preview; its parsed pages remain available.'));
    if ((mimeType !== 'image/jpeg' && mimeType !== 'image/png') || !isSupportedOriginal(bytes.data, fileName)) {
      return this.unavailableDocument(documentId, 'original_artifact_invalid', undefined, options.repository);
    }
    return ok({ documentRef: document.data.documentRef, mimeType, bytes: bytes.data });
    });
  }

  public restoreDocument(documentId: number): Promise<Result<DocumentSnapshot>> {
    return this.transaction(options => {
    const document = options.repository.get(documentId);
    if (!document.ok) return document;
    const original = options.repository.getArtifact(document.data.originalArtifactId);
    const parsed = options.repository.getArtifact(document.data.parsedArtifactId);
    if (!original.ok) return original;
    if (!parsed.ok) return parsed;
    const originalName = original.data.relativePath.slice(original.data.relativePath.lastIndexOf('/') + 1);
    const originalBytes = options.files.read(original.data, originalName);
    if (!originalBytes.ok) return originalBytes.error.code === 'artifact_unavailable'
      ? this.unavailableDocument(documentId, 'original_artifact_missing_or_corrupt', undefined, options.repository) : originalBytes;
    if (!(original.data.metadata.sourceKey === 'prepared-invoice' ? preparedOriginal(originalBytes.data, originalName)
      : isSupportedOriginal(originalBytes.data, originalName))) return this.unavailableDocument(documentId, 'original_artifact_invalid', undefined, options.repository);
    const decoded = this.readStoredParsed(document.data, parsed.data, undefined, options);
    if (!decoded.ok) return decoded;
    try {
      if (decoded.data.pages.length !== document.data.pageCount) {
        return this.unavailableDocument(documentId, 'parsed_document_mismatch', undefined, options.repository);
      }
      for (const file of parsed.data.metadata.files) {
        if (file.relativePath === 'parsed.json') continue;
        const sidecar = options.files.read(parsed.data, file.relativePath);
        if (!sidecar.ok) return sidecar.error.code === 'artifact_unavailable'
          ? this.unavailableDocument(documentId, 'parsed_sidecar_missing_or_corrupt', undefined, options.repository) : sidecar;
      }
      return options.repository.setAvailability({ documentId, status: 'available', reason: null, at: this.options.now() });
    } catch {
      return this.unavailableDocument(documentId, 'parsed_document_invalid', undefined, options.repository);
    }
    });
  }

  public readParsedForRun(documentId: number, context: ProductToolContext,
    options: MaterialInspectionOptions): Result<{ document: DocumentSnapshot; parsed: StoredParsedDocument }> {
    if (!Number.isSafeInteger(documentId) || documentId < 1 || !context.scope.allowedDocumentIds.includes(documentId)) {
      return fail(appError('tool_access_denied', 'runtime', '当前 Run 无权读取该材料。', false, context.runId, context.sessionId));
    }
    const document = options.repository.get(documentId);
    if (!document.ok) return document.error.code === 'document_not_found'
      ? fail(appError('tool_access_denied', 'runtime', '当前 Run 无权读取该材料。', false, context.runId, context.sessionId))
      : document;
    if (!scopeAllows(context.scope, document.data)) return fail(appError('tool_access_denied', 'runtime', '当前 Run 无权读取该材料。', false, context.runId, context.sessionId));
    if (document.data.status !== 'available' || document.data.isHidden) return fail(appError('input_unavailable', 'input', '材料当前不可读取。', true, context.runId, context.sessionId));
    const artifact = options.repository.getArtifact(document.data.parsedArtifactId);
    if (!artifact.ok) return artifact;
    const parsed = this.readStoredParsed(document.data, artifact.data, context, options);
    return parsed.ok ? ok({ document: document.data, parsed: parsed.data }) : parsed;
  }

  public readParsedForWorkspace(documentId: number,
    options: MaterialInspectionOptions): Result<{ document: DocumentSnapshot; parsed: StoredParsedDocument }> {
    if (!Number.isSafeInteger(documentId) || documentId < 1) return fail(appError('input_invalid', 'input', 'Document ID 无效。'));
    const document = options.repository.get(documentId);
    if (!document.ok) return document;
    if (document.data.status !== 'available') return fail(appError('input_unavailable', 'input', '材料当前不可读取。', true));
    const artifact = options.repository.getArtifact(document.data.parsedArtifactId);
    if (!artifact.ok) return artifact;
    const parsed = this.readStoredParsed(document.data, artifact.data, undefined, options);
    return parsed.ok ? ok({ document: document.data, parsed: parsed.data }) : parsed;
  }

  public inspectForWorkspace(ref: DocumentRef, options: MaterialInspectionOptions): Result<WorkspaceMaterialInspection> {
    const inspected = this.inspectMaterial(ref, options);
    if (!inspected.ok) return inspected;
    if (inspected.data.kind === 'invalid') return ok(inspected.data);
    return ok({ kind: 'valid', document: inspected.data.document,
      pages: inspected.data.parsed.pages.map(page => ({ page: page.page, blockIds: page.blocks.map(block => block.id) })) });
  }

  public inspectParsedForContext(input: Parameters<ContextMaterialPort['inspectParsed']>[0],
    options: MaterialInspectionOptions): Result<ContextParsedMaterial> {
    const parsed = ContextMaterialRequestSchema.safeParse(input);
    if (!parsed.success) return fail(appError('input_invalid', 'input', 'Context material reference is invalid.'));
    const request = parsed.data;
    if (!request.allowedDocumentIds.includes(request.documentRef.id)) return fail(appError('tool_access_denied', 'runtime', 'Context material is outside the Run scope.'));
    try {
      const document = options.repository.get(request.documentRef.id);
      if (!document.ok) return document;
      if (document.data.documentRef.version !== request.documentRef.version) return fail(appError('state_conflict', 'input', 'Context material version changed.'));
      if (document.data.isHidden || document.data.status !== 'available') return fail(appError('input_unavailable', 'input', 'Context material is unavailable.', true));
      if (!request.allowedArtifactIds.includes(document.data.parsedArtifactId)) return fail(appError('tool_access_denied', 'runtime', 'Context Artifact is outside the Run scope.'));
      const inspected = this.inspectMaterial(request.documentRef, options);
      if (!inspected.ok) return inspected;
      if (inspected.data.kind === 'invalid') return fail(appError('artifact_unavailable', 'storage', 'Context managed material could not be verified.'));
      return ok({ document: inspected.data.document, parsed: inspected.data.parsed });
    } catch { return fail(appError('storage_read_failed', 'storage', 'Context material inspection could not be completed.', true)); }
  }

  private inspectMaterial(ref: DocumentRef, options: MaterialInspectionOptions): Result<{ kind: 'invalid'; reason: string }
    | { kind: 'valid'; document: DocumentSnapshot; parsed: StoredParsedDocument }> {
    if (!DocumentRefSchema.safeParse(ref).success) return fail(appError('input_invalid', 'input', '材料引用无效。'));
    const invalid = (reason: string): Result<{ kind: 'invalid'; reason: string }> => ok({ kind: 'invalid', reason });
    try {
      const document = options.repository.get(ref.id);
      if (!document.ok) return document.error.code === 'document_not_found' ? invalid('document_missing') : document;
      if (document.data.documentRef.version !== ref.version) return invalid('document_version_mismatch');
      if (document.data.isHidden) return invalid('document_hidden');
      const original = options.repository.getArtifact(document.data.originalArtifactId);
      const parsed = options.repository.getArtifact(document.data.parsedArtifactId);
      if (!original.ok) return original.error.code === 'artifact_not_found' ? invalid('artifact_missing_or_invalid') : original;
      if (!parsed.ok) return parsed.error.code === 'artifact_not_found' ? invalid('artifact_missing_or_invalid') : parsed;
      if (original.data.kind !== 'original' || parsed.data.kind !== 'parsed'
        || original.data.artifactId === parsed.data.artifactId
        || original.data.metadata.sourceVersion !== ref.version || parsed.data.metadata.sourceVersion !== ref.version
        || original.data.metadata.sourceKey !== parsed.data.metadata.sourceKey
        || original.data.metadata.sourceRecordId !== parsed.data.metadata.sourceRecordId) return invalid('artifact_missing_or_invalid');
      const owner = options.repository.findBySource({ sourceKey: original.data.metadata.sourceKey,
        sourceRecordId: original.data.metadata.sourceRecordId, version: original.data.metadata.sourceVersion });
      if (!owner.ok) return owner;
      if (owner.data?.documentRef.id !== ref.id || owner.data.documentRef.version !== ref.version)
        return invalid('artifact_missing_or_invalid');
      const originalName = original.data.relativePath.slice(original.data.relativePath.lastIndexOf('/') + 1);
      const originalBytes = options.files.read(original.data, originalName);
      if (!originalBytes.ok) return originalBytes.error.code === 'artifact_unavailable' ? invalid('artifact_missing_or_invalid') : originalBytes;
      if (original.data.metadata.sourceKey === 'prepared-invoice'
        ? !preparedOriginal(originalBytes.data, originalName) || original.data.mimeType !== (originalName === 'original.pdf' ? 'application/pdf' : 'text/markdown')
        : (originalName !== 'original.png' && originalName !== 'original.jpg')
        || original.data.mimeType !== (originalName.endsWith('.png') ? 'image/png' : 'image/jpeg')
        || !isSupportedOriginal(originalBytes.data, originalName)) return invalid('artifact_missing_or_invalid');
      // Check every registered file, including sidecars, without altering availability.
      for (const artifact of [original.data, parsed.data]) {
        for (const file of artifact.metadata.files) {
          const bytes = options.files.read(artifact, file.relativePath);
          if (!bytes.ok) return bytes.error.code === 'artifact_unavailable' ? invalid('artifact_missing_or_invalid') : bytes;
        }
      }
      const decoded = this.inspectStoredParsed(document.data, parsed.data, options);
      if (!decoded.ok) return decoded.error.code === 'artifact_unavailable' ? invalid('artifact_missing_or_invalid') : decoded;
      if (decoded.data.pages.length !== document.data.pageCount) return invalid('artifact_missing_or_invalid');
      const seenPages = new Set<number>();
      for (const page of decoded.data.pages) {
        if (seenPages.has(page.page)) return invalid('artifact_missing_or_invalid');
        seenPages.add(page.page);
        if (new Set(page.blocks.map(block => block.id)).size !== page.blocks.length) return invalid('artifact_missing_or_invalid');
      }
      return ok({ kind: 'valid', document: document.data, parsed: decoded.data });
    } catch {
      return fail(appError('storage_read_failed', 'storage', '材料核验暂时无法完成。', true));
    }
  }

  private readStoredParsed(document: DocumentSnapshot, artifact: StoredArtifact,
    context: ProductToolContext | undefined, options: MaterialInspectionOptions): Result<StoredParsedDocument> {
    const inspected = this.inspectStoredParsed(document, artifact, options);
    return !inspected.ok && inspected.error.code === 'artifact_unavailable'
      ? this.unavailableDocument(document.documentRef.id, inspected.error.message, context, options.repository) : inspected;
  }

  private inspectStoredParsed(document: DocumentSnapshot, artifact: StoredArtifact,
    options: MaterialInspectionOptions): Result<StoredParsedDocument> {
    const invalid = (reason: string) => fail<StoredParsedDocument>(appError('artifact_unavailable', 'storage', reason));
    const bytes = options.files.read(artifact, 'parsed.json');
    if (!bytes.ok) return bytes.error.code === 'artifact_unavailable' ? invalid('parsed_artifact_missing_or_corrupt') : bytes;
    let decoded: StoredParsedDocument;
    try { decoded = decodeParsed(parseJson(bytes.data)); }
    catch { return invalid('parsed_document_invalid'); }
    if (artifact.metadata.sourceKey === 'prepared-invoice') {
      const original = options.repository.getArtifact(document.originalArtifactId);
      if (!original.ok) return original;
      const originalName = original.data.relativePath.slice(original.data.relativePath.lastIndexOf('/') + 1);
      const originalBytes = options.files.read(original.data, originalName), source = options.files.read(artifact, 'source.json');
      const content = options.files.read(artifact, 'raw-content.json'), pages = options.files.read(artifact, 'raw-pages.json');
      if (!originalBytes.ok || !source.ok || !content.ok || !pages.ok) return invalid('prepared_sidecar_missing_or_corrupt');
      try {
        const input = PreparedInvoiceMaterialSchema.safeParse({ ...parseJson(source.data) as object,
          original: { ...(parseJson(source.data) as { original: object }).original, base64: Buffer.from(originalBytes.data).toString('base64') },
          sourceText: parseJson(content.data), pages: parseJson(pages.data) });
        if (!input.success || input.data.sample !== artifact.metadata.sourceRecordId || input.data.original.name !== originalName
          || JSON.stringify(decoded.pages) !== JSON.stringify(input.data.pages) || decoded.pages.length !== document.pageCount)
          return invalid('prepared_document_mismatch');
        return ok(decoded);
      } catch { return invalid('prepared_sidecar_invalid'); }
    }
    if (!/:parsed-v3:[a-f0-9]{64}$/.test(document.documentRef.version)) return ok(decoded);

    const content = options.files.read(artifact, 'raw-content.json');
    if (!content.ok) return content.error.code === 'artifact_unavailable' ? invalid('parsed_sidecar_missing_or_corrupt') : content;
    const pages = options.files.read(artifact, 'raw-pages.json');
    if (!pages.ok) return pages.error.code === 'artifact_unavailable' ? invalid('parsed_sidecar_missing_or_corrupt') : pages;
    try {
      const mapped = mapVoxel51ParsedDocument({ content: parseJson(content.data), pages: parseJson(pages.data) });
      if (!mapped.ok || decoded.pages.length !== document.pageCount
        || JSON.stringify(decoded.pages) !== JSON.stringify(mapped.data.pages)) {
        return invalid('parsed_document_mismatch');
      }
    } catch {
      return invalid('parsed_sidecar_invalid');
    }
    return ok(decoded);
  }

  private unavailableDocument(documentId: number, reason: string, context: ProductToolContext | undefined,
    repository: DocumentRepository): Result<never> {
    const changed = repository.setAvailability({ documentId, status: 'unavailable', reason, at: this.options.now() });
    if (!changed.ok) return changed;
    return fail(appError('input_unavailable', 'input', '材料缺失或损坏，需先恢复后再读取。', true,
      context?.runId, context?.sessionId));
  }

  private sameVersion(document: DocumentSnapshot, original: Uint8Array, content: Uint8Array, pages: Uint8Array,
    parsed: Uint8Array, source: Uint8Array, originalName: 'original.jpg' | 'original.png' | 'original.pdf' | 'source.md',
    options: MaterialInspectionOptions): Result<DocumentSnapshot> {
    if (document.status === 'unavailable' && document.unavailableReason === 'Legacy file content has no preserved original bytes. Re-import this document to use it again.')
      return fail(appError('document_version_conflict', 'input', 'Legacy source bytes cannot prove equivalence; import a new version.'));
    const originalArtifact = options.repository.getArtifact(document.originalArtifactId);
    const parsedArtifact = options.repository.getArtifact(document.parsedArtifactId);
    if (!originalArtifact.ok) return originalArtifact;
    if (!parsedArtifact.ok) return parsedArtifact;
    const savedOriginal = options.files.read(originalArtifact.data, originalName);
    const savedParsed = options.files.read(parsedArtifact.data, 'parsed.json');
    const savedContent = options.files.read(parsedArtifact.data, 'raw-content.json');
    const savedPages = options.files.read(parsedArtifact.data, 'raw-pages.json');
    const savedSource = options.files.read(parsedArtifact.data, 'source.json');
    if (!savedOriginal.ok) return savedOriginal;
    if (!savedParsed.ok) return savedParsed;
    if (!savedContent.ok) return savedContent;
    if (!savedPages.ok) return savedPages;
    if (!savedSource.ok) return savedSource;
    return Buffer.compare(Buffer.from(savedOriginal.data), Buffer.from(original)) === 0
      && Buffer.compare(Buffer.from(savedParsed.data), Buffer.from(parsed)) === 0
      && Buffer.compare(Buffer.from(savedContent.data), Buffer.from(content)) === 0
      && Buffer.compare(Buffer.from(savedPages.data), Buffer.from(pages)) === 0
      && Buffer.compare(Buffer.from(savedSource.data), Buffer.from(source)) === 0
      ? document.isHidden ? options.repository.unhide(document.documentRef.id, this.options.now()) : ok(document)
      : fail(appError('document_version_conflict', 'input', '同一来源版本对应了不同材料内容。'));
  }
}

export function createDocumentService(options: DocumentServiceOptions): DocumentService {
  return new DocumentService(options);
}
