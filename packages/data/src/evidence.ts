import { appError, fail, ok, SourceRefSchema } from '@flowmate/contracts';
import type {
  DocumentSnapshot,
  InvoiceToolInput,
  InvoiceToolOutput,
  ProductToolContext,
  Result,
  SourceRef,
  ToolExecutionContext,
} from '@flowmate/contracts';
import type { DocumentRepository, DocumentService, FileStore, StoredParsedDocument } from './documents.ts';

const MAX_MODEL_IMAGE_BYTES = 2 * 1024 * 1024;

export type DeliveredImage = { mimeType: 'image/jpeg' | 'image/png'; bytes: Uint8Array };

export type EvidenceServiceOptions = {
  documents: DocumentService;
  repository: DocumentRepository;
  files: FileStore;
  now: () => string;
  originalWasDelivered?: (sessionId: number, source: SourceRef) => Result<boolean>;
};

function denied(context: ProductToolContext) {
  return fail(appError('tool_access_denied', 'runtime', '当前 Run 无权读取该材料。', false, context.runId, context.sessionId));
}

function ref(document: DocumentSnapshot, artifactId: number, page: number, blockId: string | null, quote: string | null): SourceRef {
  return { documentId: document.documentRef.id, version: document.documentRef.version,
    artifactId, page, blockId, quote: quote ? quote.slice(0, 1024) : null };
}

export class EvidenceService {
  public constructor(private readonly options: EvidenceServiceOptions) {}

  public read(input: InvoiceToolInput<'read_invoice_evidence'>, context: ToolExecutionContext): Result<InvoiceToolOutput<'read_invoice_evidence'>> {
    if (context.signal.aborted) return fail(appError('tool_cancelled', 'runtime', '证据读取已取消。', true, context.runId, context.sessionId, context.nativeToolCallId));
    if (input.kind === 'parsed') {
      if (input.blockId === null) return fail(appError('tool_invalid_input', 'input', '解析证据必须指定 BlockId。'));
      const loaded = this.options.documents.readParsedForRun(input.documentId, context);
      if (!loaded.ok) return loaded;
      const page = loaded.data.parsed.pages.find((item) => item.page === input.page);
      const block = page?.blocks.find((item) => item.id === input.blockId);
      if (!page || !block) return fail(appError('tool_invalid_input', 'input', '解析证据引用不存在。'));
      return ok({ kind: 'parsed', source: ref(loaded.data.document, loaded.data.document.parsedArtifactId,
        page.page, block.id, block.text), text: block.text, sourceType: block.sourceType }) as Result<InvoiceToolOutput<'read_invoice_evidence'>>;
    }
    if (input.blockId !== null) return fail(appError('tool_invalid_input', 'input', '原图证据不接受 BlockId。'));
    const authorized = this.documentForArtifact(input.documentId, context, 'original');
    if (!authorized.ok) return authorized;
    if (input.page !== 1) return fail(appError('tool_invalid_input', 'input', '当前导入器只提供第 1 页原图。'));
    const artifact = this.options.repository.getArtifact(authorized.data.originalArtifactId);
    if (!artifact.ok) return artifact;
    const primaryName = artifact.data.relativePath.slice(artifact.data.relativePath.lastIndexOf('/') + 1);
    const bytes = this.options.files.read(artifact.data, primaryName);
    if (!bytes.ok) return bytes.error.code === 'artifact_unavailable'
      ? this.unavailable(input.documentId, 'original_artifact_missing_or_corrupt') : bytes;
    if (bytes.data.byteLength > MAX_MODEL_IMAGE_BYTES) return fail(appError('tool_result_too_large', 'runtime', '原图超过模型回送大小限制。'));
    const mimeType = artifact.data.mimeType;
    if (mimeType !== 'image/jpeg' && mimeType !== 'image/png') return fail(appError('input_unavailable', 'input', '原图格式当前不可读取。', true));
    return ok({ kind: 'original', source: ref(authorized.data, artifact.data.artifactId, input.page, null, null), mimeType,
      bytes: bytes.data.byteLength }) as Result<InvoiceToolOutput<'read_invoice_evidence'>>;
  }

  public checkSources(input: InvoiceToolInput<'check_invoice_sources'>, context: ToolExecutionContext): Result<InvoiceToolOutput<'check_invoice_sources'>> {
    if (!context.scope.allowedDocumentIds.includes(input.documentId)) return denied(context);
    const base = this.options.repository.get(input.documentId);
    if (!base.ok) return base.error.code === 'document_not_found' ? denied(context) : base;
    if (base.data.status !== 'available') return fail(appError('input_unavailable', 'input', '材料当前不可读取。', true, context.runId, context.sessionId));
    if (!context.scope.allowedArtifactIds.includes(base.data.parsedArtifactId)
      && !context.scope.allowedArtifactIds.includes(base.data.originalArtifactId)) return denied(context);
    if (input.sources.some((source) => source.documentId !== input.documentId
      || !context.scope.allowedDocumentIds.includes(source.documentId)
      || !context.scope.allowedArtifactIds.includes(source.artifactId))) return denied(context);

    const parsed = context.scope.allowedArtifactIds.includes(base.data.parsedArtifactId)
      ? this.options.documents.readParsedForRun(input.documentId, context) : null;
    if (parsed && !parsed.ok) return parsed;
    const results = [];
    for (const [index, source] of input.sources.entries()) {
      const checked = this.checkSource(source, base.data, parsed?.ok ? parsed.data.parsed : null, context.sessionId);
      if (!checked.ok) return checked;
      results.push({ index, ...checked.data });
    }
    return ok({ documentRef: base.data.documentRef, results }) as Result<InvoiceToolOutput<'check_invoice_sources'>>;
  }

  public readForDelivery(source: SourceRef, context: ProductToolContext, signal?: AbortSignal): Result<DeliveredImage> {
    if (signal?.aborted) return fail(appError('tool_cancelled', 'runtime', '原图回送已取消。', true, context.runId, context.sessionId));
    const parsed = SourceRefSchema.safeParse(source);
    if (!parsed.success || !context.scope.allowedDocumentIds.includes(source.documentId)
      || !context.scope.allowedArtifactIds.includes(source.artifactId)) return denied(context);
    const document = this.options.repository.get(source.documentId);
    if (!document.ok) return document.error.code === 'document_not_found' ? denied(context) : document;
    if (document.data.status !== 'available') return fail(appError('input_unavailable', 'input', '原图当前不可读取。', true, context.runId, context.sessionId));
    if (source.artifactId !== document.data.originalArtifactId || source.page !== 1 || source.blockId !== null || source.quote !== null) return denied(context);
    const artifact = this.options.repository.getArtifact(document.data.originalArtifactId);
    if (!artifact.ok) return artifact;
    const fileName = artifact.data.relativePath.slice(artifact.data.relativePath.lastIndexOf('/') + 1);
    const bytes = this.options.files.read(artifact.data, fileName);
    if (!bytes.ok) return bytes.error.code === 'artifact_unavailable'
      ? this.unavailable(source.documentId, 'original_artifact_missing_or_corrupt') : bytes;
    if (bytes.data.byteLength > MAX_MODEL_IMAGE_BYTES) return fail(appError('tool_result_too_large', 'runtime', '原图超过模型回送大小限制。'));
    if (artifact.data.mimeType !== 'image/jpeg' && artifact.data.mimeType !== 'image/png') return fail(appError('input_unavailable', 'input', '原图格式当前不可读取。', true));
    return ok({ mimeType: artifact.data.mimeType, bytes: bytes.data });
  }

  private documentForArtifact(documentId: number, context: ProductToolContext, kind: 'original' | 'parsed'): Result<DocumentSnapshot> {
    if (!context.scope.allowedDocumentIds.includes(documentId)) return denied(context);
    const document = this.options.repository.get(documentId);
    if (!document.ok) return document.error.code === 'document_not_found' ? denied(context) : document;
    const artifactId = kind === 'original' ? document.data.originalArtifactId : document.data.parsedArtifactId;
    if (!context.scope.allowedArtifactIds.includes(artifactId)) return denied(context);
    if (document.data.status !== 'available') return fail(appError('input_unavailable', 'input', '材料当前不可读取。', true, context.runId, context.sessionId));
    return document;
  }

  private checkSource(source: SourceRef, document: DocumentSnapshot,
    parsed: StoredParsedDocument | null,
    sessionId: number): Result<{ status: 'valid' | 'invalid' | 'unverified'; code: 'parsed_quote_matched' | 'reference_mismatch' | 'block_not_found' | 'quote_mismatch' | 'original_not_delivered' | 'visual_truth_unverified' }> {
    const validReference = source.documentId === document.documentRef.id && source.version === document.documentRef.version;
    if (!validReference) return ok({ status: 'invalid', code: 'reference_mismatch' });
    if (source.artifactId === document.originalArtifactId) {
      if (source.page !== 1 || source.blockId !== null) return ok({ status: 'invalid', code: 'reference_mismatch' });
      const delivered = this.options.originalWasDelivered?.(sessionId, source) ?? ok(false);
      if (!delivered.ok) return delivered;
      return ok(delivered.data
        ? { status: 'unverified', code: 'visual_truth_unverified' }
        : { status: 'invalid', code: 'original_not_delivered' });
    }
    if (source.artifactId !== document.parsedArtifactId) return ok({ status: 'invalid', code: 'reference_mismatch' });
    const page = parsed?.pages.find((item) => item.page === source.page);
    const block = page?.blocks.find((item) => item.id === source.blockId);
    if (!block) return ok({ status: 'invalid', code: 'block_not_found' });
    if (!source.quote || !block.text.includes(source.quote)) return ok({ status: 'invalid', code: 'quote_mismatch' });
    return ok({ status: 'valid', code: 'parsed_quote_matched' });
  }

  private unavailable(documentId: number, reason: string) {
    const updated = this.options.repository.setAvailability({ documentId, status: 'unavailable', reason, at: this.options.now() });
    return updated.ok ? fail(appError('input_unavailable', 'input', '材料缺失或损坏，需先恢复后再读取。', true)) : updated;
  }
}

export function createEvidenceService(options: EvidenceServiceOptions): EvidenceService {
  return new EvidenceService(options);
}
