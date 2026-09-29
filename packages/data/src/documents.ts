import {
  appError,
  fail,
  ok,
  ParsedBlockSchema,
} from '@flowmate/contracts';
import type {
  DocumentSnapshot,
  InvoiceToolInput,
  InvoiceToolOutput,
  ProductPaths,
  ProductToolContext,
  Result,
  RunScope,
  SourceRef,
} from '@flowmate/contracts';
import { parseVoxel51Sample } from './parsed-document.ts';
import { isSupportedOriginal, readVoxel51Files } from './source/voxel51.ts';

const MAX_RESULT_BYTES = 128 * 1024;
const MAX_WORKSPACE_ORIGINAL_BYTES = 10 * 1024 * 1024;

export type StoredParsedDocument = {
  formatVersion: 1;
  parser: { name: string; version: string; configuration: string };
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
  originalArtifact: PublishedArtifact; parsedArtifact: PublishedArtifact; parserName: string; parserVersion: string;
  status: 'available' | 'unavailable';
  metadata: { version: 1; pageCount: number; parserConfiguration: string; warnings: string[];
    allowedUsesClaim: string[]; licenseVerification: string; unavailableReason: string | null };
  createdAt: string; updatedAt: string;
};

export interface DocumentRepository {
  findBySource(input: { sourceKey: string; sourceRecordId: string; version: string }): Result<DocumentSnapshot | null>;
  get(documentId: number): Result<DocumentSnapshot>;
  getArtifact(artifactId: number): Result<StoredArtifact>;
  register(input: NewDocumentRegistration): Result<DocumentSnapshot>;
  setAvailability(input: { documentId: number; status: 'available' | 'unavailable'; reason: string | null; at: string }): Result<DocumentSnapshot>;
}
export interface FileStore {
  publish(input: PublishArtifactInput): Promise<Result<PublishedArtifactPair>>;
  read(artifact: StoredArtifact, fileName?: string): Result<Uint8Array>;
}

function cancelled(signal?: AbortSignal): boolean { return signal?.aborted === true; }

function parseJson(bytes: Uint8Array): unknown {
  return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes)) as unknown;
}

function decodeParsed(value: unknown): StoredParsedDocument {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('invalid_parsed_document');
  const parsed = value as Record<string, unknown>;
  if (parsed.formatVersion !== 1 || !parsed.parser || typeof parsed.parser !== 'object' || Array.isArray(parsed.parser)
    || !Array.isArray(parsed.pages) || parsed.pages.length < 1 || parsed.pages.length > 20
    || !parsed.completeness || typeof parsed.completeness !== 'object' || Array.isArray(parsed.completeness)) throw new Error('invalid_parsed_document');
  const parser = parsed.parser as Record<string, unknown>;
  const completeness = parsed.completeness as Record<string, unknown>;
  if (typeof parser.name !== 'string' || typeof parser.version !== 'string' || typeof parser.configuration !== 'string'
    || completeness.status !== 'complete' || !Array.isArray(completeness.checks) || !completeness.checks.every((item) => typeof item === 'string')
    || !Array.isArray(completeness.warnings) || !completeness.warnings.every((item) => typeof item === 'string')) throw new Error('invalid_parsed_document');
  const pages = parsed.pages.map((value) => {
    if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('invalid_parsed_page');
    const page = value as Record<string, unknown>;
    if (!Number.isSafeInteger(page.page) || Number(page.page) < 1 || Number(page.page) > 20 || !Array.isArray(page.blocks)
      || page.blocks.length > 2_000) throw new Error('invalid_parsed_page');
    return { page: Number(page.page), blocks: page.blocks.map((block) => ParsedBlockSchema.parse(block)) };
  });
  return { formatVersion: 1, parser: parser as StoredParsedDocument['parser'], pages,
    completeness: completeness as StoredParsedDocument['completeness'] };
}

function scopeAllows(scope: RunScope, document: DocumentSnapshot): boolean {
  return scope.allowedDocumentIds.includes(document.documentRef.id)
    && scope.allowedArtifactIds.includes(document.parsedArtifactId);
}

function sourceFor(document: DocumentSnapshot, page: number, blockId: string | null, quote: string | null): SourceRef {
  return { documentId: document.documentRef.id, version: document.documentRef.version,
    artifactId: document.parsedArtifactId, page, blockId, quote: quote ? quote.slice(0, 1024) : null };
}

export type DocumentServiceOptions = {
  paths: ProductPaths;
  repository: DocumentRepository;
  files: FileStore;
  now: () => string;
};

export class DocumentService {
  private tail: Promise<void> = Promise.resolve();

  public constructor(private readonly options: DocumentServiceOptions) {}

  public importVoxel51(input: { sourceDirectory: string }, signal?: AbortSignal): Promise<Result<DocumentSnapshot>> {
    const previous = this.tail;
    let release!: () => void;
    this.tail = new Promise<void>((resolveLock) => { release = resolveLock; });
    return previous.then(() => this.importVoxel51Locked(input, signal)).catch(() =>
      fail(appError('source_invalid', 'input', '来源材料结构无效。')),
    ).finally(release);
  }

  private async importVoxel51Locked(input: { sourceDirectory: string }, signal?: AbortSignal): Promise<Result<DocumentSnapshot>> {
    if (cancelled(signal)) return fail(appError('operation_cancelled', 'runtime', '材料导入已取消。'));
    const source = readVoxel51Files(input.sourceDirectory, this.options.paths.root, signal);
    if (!source.ok) return source;
    const { originalFileName, originalMimeType, originalBytes, contentBytes, pagesBytes } = source.data;
    const parsed = parseVoxel51Sample(source.data);
    if (!parsed.ok) return parsed;
    const existing = this.options.repository.findBySource({ sourceKey: parsed.data.sourceKey,
      sourceRecordId: parsed.data.sourceRecordId, version: parsed.data.version });
    if (!existing.ok) return existing;
    const sourceRecord = {
      version: 1,
      sourceKey: parsed.data.sourceKey,
      sourceRecordId: parsed.data.sourceRecordId,
      datasetRevision: parsed.data.datasetRevision,
      parserKey: parsed.data.parserKey,
      allowedUsesClaim: parsed.data.allowedUsesClaim,
      licenseVerification: parsed.data.licenseVerification,
      original: { fileName: originalFileName, bytes: originalBytes.byteLength },
      files: [
        { name: 'content.json', bytes: contentBytes.byteLength },
        { name: 'pages.json', bytes: pagesBytes.byteLength },
      ],
    };
    const parsedBytes = Buffer.from(JSON.stringify(parsed.data.parsed), 'utf8');
    const sourceBytes = Buffer.from(JSON.stringify(sourceRecord), 'utf8');
    if (existing.data) {
      return this.sameVersion(existing.data, originalBytes, contentBytes, pagesBytes, parsedBytes, sourceBytes, originalFileName);
    }
    if (cancelled(signal)) return fail(appError('operation_cancelled', 'runtime', '材料导入已取消。'));
    const now = this.options.now();
    const publish: PublishArtifactInput = {
      sourceKey: parsed.data.sourceKey, sourceRecordId: parsed.data.sourceRecordId, sourceVersion: parsed.data.version, at: now,
      original: { kind: 'original', primaryName: originalFileName,
        files: [{ name: originalFileName, bytes: originalBytes, mimeType: originalMimeType }] },
      parsed: { kind: 'parsed', primaryName: 'parsed.json', files: [
        { name: 'parsed.json', bytes: parsedBytes, mimeType: 'application/json' },
        { name: 'raw-content.json', bytes: contentBytes, mimeType: 'application/json' },
        { name: 'raw-pages.json', bytes: pagesBytes, mimeType: 'application/json' },
        { name: 'source.json', bytes: sourceBytes, mimeType: 'application/json' },
      ] },
    };
    const published = await this.options.files.publish(publish);
    if (!published.ok) return published;
    if (cancelled(signal)) return fail(appError('operation_cancelled', 'runtime', '材料导入已取消；已发布文件保留为待核对孤儿。'));
    const result = this.options.repository.register({
      documentId: published.data.documentId,
      sourceKey: parsed.data.sourceKey, sourceRecordId: parsed.data.sourceRecordId, version: parsed.data.version,
      originalArtifact: published.data.original, parsedArtifact: published.data.parsed,
      parserName: parsed.data.parsed.parser.name, parserVersion: parsed.data.parsed.parser.version,
      status: 'available', metadata: {
        version: 1, pageCount: parsed.data.parsed.pages.length,
        parserConfiguration: parsed.data.parsed.parser.configuration,
        warnings: parsed.data.parsed.completeness.warnings,
        allowedUsesClaim: parsed.data.allowedUsesClaim,
        licenseVerification: parsed.data.licenseVerification,
        unavailableReason: null,
      },
      createdAt: now, updatedAt: now,
    });
    return result;
  }

  public listPages(input: InvoiceToolInput<'list_invoice_pages'>, context: ProductToolContext): Result<InvoiceToolOutput<'list_invoice_pages'>> {
    const loaded = this.loadParsed(input.documentId, context);
    if (!loaded.ok) return loaded;
    const pages = loaded.data.parsed.pages.map((page) => ({
      page: page.page,
      blockCount: page.blocks.length,
      tableCount: page.blocks.filter((block) => block.kind === 'table').length,
    }));
    return ok({ documentRef: loaded.data.document.documentRef, parsedArtifactId: loaded.data.document.parsedArtifactId,
      pageCount: pages.length, pages }) as Result<InvoiceToolOutput<'list_invoice_pages'>>;
  }

  public readPage(input: InvoiceToolInput<'read_invoice_document'>, context: ProductToolContext): Result<InvoiceToolOutput<'read_invoice_document'>> {
    const loaded = this.loadParsed(input.documentId, context);
    if (!loaded.ok) return loaded;
    return this.readPageFromParsed(input, loaded.data);
  }

  public readPageForWorkspace(input: InvoiceToolInput<'read_invoice_document'>): Result<InvoiceToolOutput<'read_invoice_document'>> {
    const loaded = this.readParsedForWorkspace(input.documentId);
    if (!loaded.ok) return loaded;
    return this.readPageFromParsed(input, loaded.data);
  }

  public readOriginalForWorkspace(documentId: number, page: number): Result<{ documentRef: DocumentSnapshot['documentRef']; mimeType: 'image/jpeg' | 'image/png'; bytes: Uint8Array }> {
    if (!Number.isSafeInteger(documentId) || documentId < 1 || page !== 1) return fail(appError('input_invalid', 'input', '原图引用无效。'));
    const document = this.options.repository.get(documentId);
    if (!document.ok) return document;
    if (document.data.status !== 'available') return fail(appError('input_unavailable', 'input', '材料当前不可读取。', true));
    const artifact = this.options.repository.getArtifact(document.data.originalArtifactId);
    if (!artifact.ok) return artifact;
    const fileName = artifact.data.relativePath.slice(artifact.data.relativePath.lastIndexOf('/') + 1);
    const bytes = this.options.files.read(artifact.data, fileName);
    if (!bytes.ok) return bytes.error.code === 'artifact_unavailable'
      ? this.unavailableDocument(documentId, 'original_artifact_missing_or_corrupt') : bytes;
    if (bytes.data.byteLength > MAX_WORKSPACE_ORIGINAL_BYTES) return fail(appError('tool_result_too_large', 'runtime', '原图超过桌面读取大小限制。'));
    const mimeType = artifact.data.mimeType;
    if ((mimeType !== 'image/jpeg' && mimeType !== 'image/png') || !isSupportedOriginal(bytes.data, fileName)) {
      return this.unavailableDocument(documentId, 'original_artifact_invalid');
    }
    return ok({ documentRef: document.data.documentRef, mimeType, bytes: bytes.data });
  }

  private readPageFromParsed(input: InvoiceToolInput<'read_invoice_document'>,
    loadedValue: { document: DocumentSnapshot; parsed: StoredParsedDocument }): Result<InvoiceToolOutput<'read_invoice_document'>> {
    const loaded = { ok: true as const, data: loadedValue };
    const page = loaded.data.parsed.pages.find((candidate) => candidate.page === input.page);
    if (!page) return fail(appError('tool_invalid_input', 'input', '指定页码不存在。'));
    let start = 0;
    if (input.afterBlockId !== null) {
      const cursor = page.blocks.findIndex((block) => block.id === input.afterBlockId);
      if (cursor < 0) return fail(appError('tool_invalid_input', 'input', '分页游标不属于指定页。'));
      start = cursor + 1;
    }
    const available = page.blocks.slice(start);
    const selected: Array<ReturnType<typeof ParsedBlockSchema.parse> & { source: SourceRef }> = [];
    const maxItems = Math.min(input.limit, 50);
    let completePage = false;
    for (const block of available.slice(0, maxItems)) {
      const candidate = { ...block, source: sourceFor(loaded.data.document, page.page, block.id, block.text) };
      const attempt = [...selected, candidate];
      const response = {
        documentRef: loaded.data.document.documentRef, parsedArtifactId: loaded.data.document.parsedArtifactId,
        page: page.page, pageCount: loaded.data.parsed.pages.length, blocks: attempt,
        nextAfterBlockId: null, completePage: false,
      };
      if (Buffer.byteLength(JSON.stringify(response), 'utf8') > MAX_RESULT_BYTES) {
        if (selected.length === 0) return fail(appError('tool_result_too_large', 'runtime', '完整解析块超过结果大小限制。'));
        break;
      }
      selected.push(candidate);
    }
    completePage = start + selected.length >= page.blocks.length;
    const response = {
      documentRef: loaded.data.document.documentRef, parsedArtifactId: loaded.data.document.parsedArtifactId,
      page: page.page, pageCount: loaded.data.parsed.pages.length, blocks: selected,
      nextAfterBlockId: completePage ? null : selected.at(-1)?.id ?? input.afterBlockId,
      completePage,
    };
    return ok(response) as Result<InvoiceToolOutput<'read_invoice_document'>>;
  }

  public search(input: InvoiceToolInput<'search_invoice_document'>, context: ProductToolContext): Result<InvoiceToolOutput<'search_invoice_document'>> {
    if (!input.query.trim()) return fail(appError('tool_invalid_input', 'input', '搜索内容不能为空。'));
    const loaded = this.loadParsed(input.documentId, context);
    if (!loaded.ok) return loaded;
    if (input.page !== null && !loaded.data.parsed.pages.some((page) => page.page === input.page)) {
      return fail(appError('tool_invalid_input', 'input', '指定页码不存在。'));
    }
    const flattened = loaded.data.parsed.pages.flatMap((page) => page.blocks.map((block) => ({ page: page.page, block })))
      .filter((item) => input.page === null || item.page === input.page);
    const cursorIndex = input.afterBlockId === null ? -1 : flattened.findIndex((item) => item.block.id === input.afterBlockId);
    if (input.afterBlockId !== null && cursorIndex < 0) return fail(appError('tool_invalid_input', 'input', '分页游标无效。'));
    const remaining = flattened.slice(cursorIndex + 1);
    const matches = remaining.flatMap(({ page, block }) => {
      const index = block.text.indexOf(input.query);
      if (index < 0) return [];
      const excerpt = block.text.slice(index, index + 512);
      return [{ page, blockId: block.id, kind: block.kind, excerpt, source: sourceFor(loaded.data.document, page, block.id, excerpt) }];
    });
    const items = matches.slice(0, input.limit);
    const response = { documentRef: loaded.data.document.documentRef, parsedArtifactId: loaded.data.document.parsedArtifactId,
      query: input.query, matches: items, nextAfterBlockId: matches.length > items.length ? items.at(-1)?.blockId ?? null : null,
      complete: matches.length <= items.length };
    if (Buffer.byteLength(JSON.stringify(response), 'utf8') > MAX_RESULT_BYTES) return fail(appError('tool_result_too_large', 'runtime', '搜索结果超过大小限制。'));
    return ok(response) as Result<InvoiceToolOutput<'search_invoice_document'>>;
  }

  public listTables(input: InvoiceToolInput<'list_invoice_tables'>, context: ProductToolContext): Result<InvoiceToolOutput<'list_invoice_tables'>> {
    const loaded = this.loadParsed(input.documentId, context);
    if (!loaded.ok) return loaded;
    if (input.page !== null && !loaded.data.parsed.pages.some((page) => page.page === input.page)) {
      return fail(appError('tool_invalid_input', 'input', '指定页码不存在。'));
    }
    const blocks = loaded.data.parsed.pages.filter((page) => input.page === null || page.page === input.page)
      .flatMap((page) => page.blocks.map((block) => ({ page: page.page, block })));
    const cursorIndex = input.afterBlockId === null ? -1 : blocks.findIndex(({ block }) => block.id === input.afterBlockId);
    if (input.afterBlockId !== null && cursorIndex < 0) {
      return fail(appError('tool_invalid_input', 'input', '分页游标无效。'));
    }
    const tables = blocks.slice(cursorIndex + 1).filter(({ block }) => block.kind === 'table');
    const items = tables.slice(0, input.limit).map(({ page, block }) => ({
      page, blockId: block.id, sourceType: block.sourceType, textLength: block.text.length,
      preview: block.text.slice(0, 256), source: sourceFor(loaded.data.document, page, block.id, block.text),
    }));
    const response = { documentRef: loaded.data.document.documentRef, parsedArtifactId: loaded.data.document.parsedArtifactId,
      tables: items, nextAfterBlockId: tables.length > items.length ? items.at(-1)?.blockId ?? null : null,
      complete: tables.length <= items.length };
    if (Buffer.byteLength(JSON.stringify(response), 'utf8') > MAX_RESULT_BYTES) return fail(appError('tool_result_too_large', 'runtime', '表格目录超过大小限制。'));
    return ok(response) as Result<InvoiceToolOutput<'list_invoice_tables'>>;
  }

  public restoreDocument(documentId: number): Result<DocumentSnapshot> {
    const document = this.options.repository.get(documentId);
    if (!document.ok) return document;
    const original = this.options.repository.getArtifact(document.data.originalArtifactId);
    const parsed = this.options.repository.getArtifact(document.data.parsedArtifactId);
    if (!original.ok) return original;
    if (!parsed.ok) return parsed;
    const originalName = original.data.relativePath.slice(original.data.relativePath.lastIndexOf('/') + 1);
    const originalBytes = this.options.files.read(original.data, originalName);
    if (!originalBytes.ok) return this.unavailableDocument(documentId, 'original_artifact_missing_or_corrupt');
    const extension = originalName.endsWith('.jpg') ? '.jpg' : originalName.endsWith('.png') ? '.png' : '';
    if (!extension || !isSupportedOriginal(originalBytes.data, originalName)) return this.unavailableDocument(documentId, 'original_artifact_invalid');
    const parsedBytes = this.options.files.read(parsed.data, 'parsed.json');
    if (!parsedBytes.ok) return this.unavailableDocument(documentId, 'parsed_artifact_missing_or_corrupt');
    try {
      const decoded = decodeParsed(parseJson(parsedBytes.data));
      if (decoded.parser.name !== document.data.parser.name || decoded.parser.version !== document.data.parser.version
        || decoded.parser.configuration !== document.data.parser.configuration || decoded.pages.length !== document.data.pageCount) {
        return this.unavailableDocument(documentId, 'parsed_document_mismatch');
      }
      for (const file of parsed.data.metadata.files) {
        if (file.relativePath === 'parsed.json') continue;
        const sidecar = this.options.files.read(parsed.data, file.relativePath);
        if (!sidecar.ok) return this.unavailableDocument(documentId, 'parsed_sidecar_missing_or_corrupt');
      }
      return this.options.repository.setAvailability({ documentId, status: 'available', reason: null, at: this.options.now() });
    } catch {
      return this.unavailableDocument(documentId, 'parsed_document_invalid');
    }
  }

  public readParsedForRun(documentId: number, context: ProductToolContext): Result<{ document: DocumentSnapshot; parsed: StoredParsedDocument }> {
    if (!Number.isSafeInteger(documentId) || documentId < 1 || !context.scope.allowedDocumentIds.includes(documentId)) {
      return fail(appError('tool_access_denied', 'runtime', '当前 Run 无权读取该材料。', false, context.runId, context.sessionId));
    }
    const document = this.options.repository.get(documentId);
    if (!document.ok) return document.error.code === 'document_not_found'
      ? fail(appError('tool_access_denied', 'runtime', '当前 Run 无权读取该材料。', false, context.runId, context.sessionId))
      : document;
    if (!scopeAllows(context.scope, document.data)) return fail(appError('tool_access_denied', 'runtime', '当前 Run 无权读取该材料。', false, context.runId, context.sessionId));
    if (document.data.status !== 'available') return fail(appError('input_unavailable', 'input', '材料当前不可读取。', true, context.runId, context.sessionId));
    const artifact = this.options.repository.getArtifact(document.data.parsedArtifactId);
    if (!artifact.ok) return artifact;
    const bytes = this.options.files.read(artifact.data, 'parsed.json');
    if (!bytes.ok) return bytes.error.code === 'artifact_unavailable'
      ? this.unavailableDocument(documentId, 'parsed_artifact_missing_or_corrupt', context)
      : bytes;
    try {
      return ok({ document: document.data, parsed: decodeParsed(parseJson(bytes.data)) });
    } catch {
      return this.unavailableDocument(documentId, 'parsed_document_invalid', context);
    }
  }

  public readParsedForWorkspace(documentId: number): Result<{ document: DocumentSnapshot; parsed: StoredParsedDocument }> {
    if (!Number.isSafeInteger(documentId) || documentId < 1) return fail(appError('input_invalid', 'input', 'Document ID 无效。'));
    const document = this.options.repository.get(documentId);
    if (!document.ok) return document;
    if (document.data.status !== 'available') return fail(appError('input_unavailable', 'input', '材料当前不可读取。', true));
    const artifact = this.options.repository.getArtifact(document.data.parsedArtifactId);
    if (!artifact.ok) return artifact;
    const bytes = this.options.files.read(artifact.data, 'parsed.json');
    if (!bytes.ok) return bytes.error.code === 'artifact_unavailable'
      ? this.unavailableDocument(documentId, 'parsed_artifact_missing_or_corrupt') : bytes;
    try { return ok({ document: document.data, parsed: decodeParsed(parseJson(bytes.data)) }); }
    catch { return this.unavailableDocument(documentId, 'parsed_document_invalid'); }
  }

  private loadParsed(documentId: number, context: ProductToolContext): Result<{ document: DocumentSnapshot; parsed: StoredParsedDocument }> {
    return this.readParsedForRun(documentId, context);
  }

  private unavailableDocument(documentId: number, reason: string, context?: ProductToolContext): Result<never> {
    const changed = this.options.repository.setAvailability({ documentId, status: 'unavailable', reason, at: this.options.now() });
    if (!changed.ok) return changed;
    return fail(appError('input_unavailable', 'input', '材料缺失或损坏，需先恢复后再读取。', true,
      context?.runId, context?.sessionId));
  }

  private sameVersion(document: DocumentSnapshot, original: Uint8Array, content: Uint8Array, pages: Uint8Array,
    parsed: Uint8Array, source: Uint8Array, originalName: 'original.jpg' | 'original.png'): Result<DocumentSnapshot> {
    const originalArtifact = this.options.repository.getArtifact(document.originalArtifactId);
    const parsedArtifact = this.options.repository.getArtifact(document.parsedArtifactId);
    if (!originalArtifact.ok) return originalArtifact;
    if (!parsedArtifact.ok) return parsedArtifact;
    const savedOriginal = this.options.files.read(originalArtifact.data, originalName);
    const savedParsed = this.options.files.read(parsedArtifact.data, 'parsed.json');
    const savedContent = this.options.files.read(parsedArtifact.data, 'raw-content.json');
    const savedPages = this.options.files.read(parsedArtifact.data, 'raw-pages.json');
    const savedSource = this.options.files.read(parsedArtifact.data, 'source.json');
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
      ? ok(document)
      : fail(appError('document_version_conflict', 'input', '同一来源版本对应了不同材料内容。'));
  }
}

export function createDocumentService(options: DocumentServiceOptions): DocumentService {
  return new DocumentService(options);
}
