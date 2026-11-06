import { isDeepStrictEqual } from 'node:util';
import { z } from 'zod';
import { appError, CLOUD_MATERIAL_CHUNK_BYTES, CloudMaterialChunkSchema, CloudMaterialKeySchema, CloudMaterialManifestSchema, CloudMaterialReceiptSchema,
  fail, ok, type AppError, type CloudMaterialManifest, type CloudMaterialReceipt, type CloudMaterialStatus, type DocumentRef,
  type Result, type WorkspaceMaterialInspection } from '@flowmate/contracts';
import { decodeStoredParsedDocument, isPreparedInvoiceOriginal } from '@flowmate/data';
import { isSupportedOriginal } from '../packages/data/src/source/voxel51.ts';
import type { DbHandle, SqlDatabaseStore } from '../packages/core/src/storage/database.ts';
import type { createFileStore } from '../packages/core/src/storage/file-store.ts';

type Options = { database: Pick<DbHandle, 'read' | 'transaction'>; files: Pick<ReturnType<typeof createFileStore>, 'publish' | 'read'>;
  inspect(ref: DocumentRef, scope: SqlDatabaseStore): Result<WorkspaceMaterialInspection>; now(): string };
type Row = { manifest_json: string; state: 'receiving' | 'completed'; receipt_json: string | null };
class UploadFault extends Error { constructor(readonly detail: AppError) { super(detail.code); } }
function need<T>(value: Result<T>): T { if (!value.ok) throw new UploadFault(value.error); return value.data; }
function reject(code: string, message: string): never { throw new UploadFault(appError(code, 'input', message)); }
const mime: Record<string, string> = { 'original.jpg': 'image/jpeg', 'original.png': 'image/png', 'original.pdf': 'application/pdf',
  'source.md': 'text/markdown', 'source.txt': 'text/plain', 'parsed.json': 'application/json', 'raw-content.json': 'application/json',
  'raw-pages.json': 'application/json', 'source.json': 'application/json' };

/** Original material chunks and the publication receipt use the same stable Workspace upload ID. */
export class CloudMaterialUpload {
  constructor(private readonly options: Options) {}
  private async run<T>(action: () => Promise<T>): Promise<Result<T>> {
    try { return ok(await action()); }
    catch (error) { return fail(error instanceof UploadFault ? error.detail
      : appError('cloud_material_unavailable', 'storage', 'The original cloud material could not be confirmed.', true)); }
  }
  private row(scope: SqlDatabaseStore, workspaceId: string, uploadId: string): Row | null {
    return scope.db.query<Row, [string, string]>('SELECT manifest_json,state,receipt_json FROM cloud_material_uploads WHERE workspace_id=? AND upload_id=?')
      .get(workspaceId, uploadId);
  }
  private manifest(row: Row): CloudMaterialManifest { return CloudMaterialManifestSchema.parse(JSON.parse(row.manifest_json)); }
  private receipt(row: Row): CloudMaterialReceipt | null { return row.receipt_json === null ? null : CloudMaterialReceiptSchema.parse(JSON.parse(row.receipt_json)); }

  async begin(raw: unknown): Promise<Result<{ status: 'receiving' | 'completed'; receipt: CloudMaterialReceipt | null }>> {
    const parsed = CloudMaterialManifestSchema.safeParse(raw);
    if (!parsed.success || parsed.data.files.some(file => mime[file.name] !== file.mimeType)
      || parsed.data.sourceKey === 'prepared-invoice' && !['source.md', 'original.pdf'].includes(parsed.data.originalName)
      || parsed.data.sourceKey !== 'prepared-invoice' && !['original.jpg', 'original.png'].includes(parsed.data.originalName))
      return fail(appError('input_invalid', 'input', 'The original material manifest is invalid.'));
    const manifest = parsed.data;
    return this.run(() => this.options.database.transaction(scope => {
      const existing = this.row(scope, manifest.workspaceId, manifest.uploadId);
      if (existing) {
        if (!isDeepStrictEqual(this.manifest(existing), manifest)) reject('state_conflict', 'The upload ID already belongs to different material facts.');
        return { status: existing.state, receipt: this.receipt(existing) };
      }
      const at = z.string().datetime({ offset: true }).parse(this.options.now());
      scope.db.query("INSERT INTO cloud_material_uploads(workspace_id,upload_id,manifest_json,state,created_at) VALUES(?,?,?,'receiving',?)")
        .run(manifest.workspaceId, manifest.uploadId, JSON.stringify(manifest), at);
      return { status: 'receiving' as const, receipt: null };
    }));
  }

  async append(raw: unknown): Promise<Result<void>> {
    const parsed = CloudMaterialChunkSchema.safeParse(raw); if (!parsed.success) return fail(appError('input_invalid', 'input', 'The material chunk is invalid.'));
    const input = parsed.data, content = Buffer.from(input.base64, 'base64');
    if (!content.length || content.length > CLOUD_MATERIAL_CHUNK_BYTES || content.toString('base64') !== input.base64)
      return fail(appError('input_invalid', 'input', 'The material chunk bytes are invalid.'));
    return this.run(() => this.options.database.transaction(scope => {
      const row = this.row(scope, input.workspaceId, input.uploadId); if (!row) reject('source_invalid', 'The original upload does not exist.');
      const manifest = this.manifest(row), file = manifest.files.find(value => value.kind === input.kind && value.name === input.name);
      if (!file || input.offset >= file.bytes || input.offset % CLOUD_MATERIAL_CHUNK_BYTES !== 0
        || content.length !== Math.min(CLOUD_MATERIAL_CHUNK_BYTES, file.bytes - input.offset))
        reject('source_invalid', 'The chunk does not match its original file boundary.');
      const prior = scope.db.query<{ content: Uint8Array }, [string, string, string, string, number]>(`SELECT content FROM cloud_material_chunks
        WHERE workspace_id=? AND upload_id=? AND kind=? AND name=? AND byte_offset=?`)
        .get(input.workspaceId, input.uploadId, input.kind, input.name, input.offset);
      if (prior) { if (!Buffer.from(prior.content).equals(content)) reject('state_conflict', 'The original chunk bytes differ.'); return; }
      if (row.state !== 'receiving') reject('state_conflict', 'The original upload has already completed.');
      const received = scope.db.query<{ count: number }, [string, string, string, string]>(`SELECT COALESCE(SUM(length(content)),0) count FROM cloud_material_chunks
        WHERE workspace_id=? AND upload_id=? AND kind=? AND name=?`).get(input.workspaceId, input.uploadId, input.kind, input.name)!.count;
      if (received !== input.offset) reject('state_conflict', 'Material chunks must continue at the original offset.');
      scope.db.query('INSERT INTO cloud_material_chunks(workspace_id,upload_id,kind,name,byte_offset,content) VALUES(?,?,?,?,?,?)')
        .run(input.workspaceId, input.uploadId, input.kind, input.name, input.offset, content);
    }));
  }

  async status(raw: unknown): Promise<Result<CloudMaterialStatus>> {
    const parsed = CloudMaterialKeySchema.safeParse(raw);
    if (!parsed.success) return fail(appError('input_invalid', 'input', 'The cloud upload identity is invalid.'));
    const { workspaceId, uploadId } = parsed.data;
    return this.run(() => this.options.database.read(scope => {
      const row = this.row(scope, workspaceId, uploadId);
      if (!row) reject('source_invalid', 'The original upload does not exist.');
      const manifest = this.manifest(row), receipt = this.receipt(row);
      if ((row.state === 'completed') !== (receipt !== null)) reject('state_conflict', 'The original upload receipt is inconsistent.');
      const files = manifest.files.map(file => {
        const offset = scope.db.query<{ count: number }, [string, string, string, string]>(`SELECT COALESCE(SUM(length(content)),0) count
          FROM cloud_material_chunks WHERE workspace_id=? AND upload_id=? AND kind=? AND name=?`)
          .get(workspaceId, uploadId, file.kind, file.name)!.count;
        if (offset > file.bytes || offset < file.bytes && offset % CLOUD_MATERIAL_CHUNK_BYTES !== 0
          || row.state === 'completed' && offset !== file.bytes)
          reject('state_conflict', 'The original upload offsets are inconsistent.');
        return { kind: file.kind, name: file.name, offset };
      });
      return { workspaceId, uploadId, status: row.state, receipt, files };
    }));
  }

  private attach(scope: SqlDatabaseStore, manifest: CloudMaterialManifest, document: { documentRef: DocumentRef }): CloudMaterialReceipt {
    const existing = this.row(scope, manifest.workspaceId, manifest.uploadId); if (!existing || !isDeepStrictEqual(this.manifest(existing), manifest))
      reject('state_conflict', 'The original upload changed before publication.');
    const prior = this.receipt(existing); if (prior) return prior;
    const mapped = scope.db.query<{ document_id: number; document_version: string }, [string, string]>(
      'SELECT document_id,document_version FROM cloud_workspace_documents WHERE workspace_id=? AND upload_id=?').get(manifest.workspaceId, manifest.uploadId);
    if (mapped && (mapped.document_id !== document.documentRef.id || mapped.document_version !== document.documentRef.version))
      reject('state_conflict', 'The original upload already refers to another cloud document.');
    const sameDocument = scope.db.query('SELECT document_id FROM cloud_workspace_documents WHERE workspace_id=? AND document_id=? AND document_version=?')
      .get(manifest.workspaceId, document.documentRef.id, document.documentRef.version);
    if (!mapped && !sameDocument) scope.db.query('INSERT INTO cloud_workspace_documents(workspace_id,upload_id,document_id,document_version) VALUES(?,?,?,?)')
      .run(manifest.workspaceId, manifest.uploadId, document.documentRef.id, document.documentRef.version);
    const receipt = CloudMaterialReceiptSchema.parse({ workspaceId: manifest.workspaceId, uploadId: manifest.uploadId,
      sourceDocumentRef: manifest.sourceDocumentRef, cloudDocumentRef: document.documentRef });
    if (scope.db.query("UPDATE cloud_material_uploads SET state='completed',receipt_json=? WHERE workspace_id=? AND upload_id=? AND state='receiving'")
      .run(JSON.stringify(receipt), manifest.workspaceId, manifest.uploadId).changes !== 1) reject('state_conflict', 'The original upload receipt could not be saved.');
    return receipt;
  }

  async finish(raw: unknown): Promise<Result<CloudMaterialReceipt>> {
    const parsed = CloudMaterialKeySchema.safeParse(raw); if (!parsed.success) return fail(appError('input_invalid', 'input', 'The cloud upload identity is invalid.'));
    const { workspaceId, uploadId } = parsed.data;
    return this.run(async () => {
      const snapshot = await this.options.database.read(scope => {
        const row = this.row(scope, workspaceId, uploadId); if (!row) reject('source_invalid', 'The original upload does not exist.');
        const manifest = this.manifest(row), receipt = this.receipt(row);
        if (receipt) return { manifest, receipt, payload: null };
        const payload = manifest.files.map(file => {
          const chunks = scope.db.query<{ byte_offset: number; content: Uint8Array }, [string, string, string, string]>(`SELECT byte_offset,content
            FROM cloud_material_chunks WHERE workspace_id=? AND upload_id=? AND kind=? AND name=? ORDER BY byte_offset`)
            .all(workspaceId, uploadId, file.kind, file.name);
          let offset = 0; const pieces: Buffer[] = [];
          for (const chunk of chunks) { if (chunk.byte_offset !== offset) reject('state_conflict', 'The original material is incomplete.');
            const content = Buffer.from(chunk.content); offset += content.length; pieces.push(content); }
          if (offset !== file.bytes) reject('state_conflict', 'The original material is incomplete.');
          return { ...file, content: Buffer.concat(pieces, offset) };
        });
        return { manifest, receipt: null, payload };
      });
      if (snapshot.receipt) return snapshot.receipt;
      const { manifest } = snapshot, payload = snapshot.payload!;
      const original = payload.find(file => file.kind === 'original' && file.name === manifest.originalName)!, parsedFile = payload.find(file => file.kind === 'parsed' && file.name === 'parsed.json')!;
      const originalValid = manifest.sourceKey === 'prepared-invoice' ? isPreparedInvoiceOriginal(original.content, original.name)
        : isSupportedOriginal(original.content, original.name);
      if (!originalValid) reject('source_invalid', 'The original invoice file is invalid.');
      const decoded = decodeStoredParsedDocument(JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(parsedFile.content)));
      if (decoded.pages.length !== manifest.metadata.pageCount || new Set(decoded.pages.map(page => page.page)).size !== decoded.pages.length
        || decoded.pages.some(page => new Set(page.blocks.map(block => block.id)).size !== page.blocks.length))
        reject('source_invalid', 'The parsed invoice pages do not match their original metadata.');
      const at = z.string().datetime({ offset: true }).parse(this.options.now());
      const material = { sourceKey: manifest.sourceKey, sourceRecordId: manifest.sourceRecordId, sourceVersion: manifest.sourceVersion, at,
        original: { kind: 'original' as const, primaryName: manifest.originalName,
          files: payload.filter(file => file.kind === 'original').map(file => ({ name: file.name, bytes: file.content, mimeType: file.mimeType })) },
        parsed: { kind: 'parsed' as const, primaryName: 'parsed.json',
          files: payload.filter(file => file.kind === 'parsed').map(file => ({ name: file.name, bytes: file.content, mimeType: file.mimeType })) } };
      const published = await this.options.files.publish(material, {
        findExisting: () => this.options.database.transaction(scope => {
          const found = need(scope.documents.findBySource({ sourceKey: manifest.sourceKey, sourceRecordId: manifest.sourceRecordId, version: manifest.sourceVersion }));
          if (!found) return ok(null);
          const raw = scope.db.query<{ metadata_json: string }, [number]>('SELECT metadata_json FROM documents WHERE id=?').get(found.documentRef.id);
          if (!raw || !isDeepStrictEqual(JSON.parse(raw.metadata_json), manifest.metadata)) reject('state_conflict', 'The existing material metadata differs.');
          for (const kind of ['original', 'parsed'] as const) {
            const artifact = need(scope.documents.getArtifact(kind === 'original' ? found.originalArtifactId : found.parsedArtifactId));
            const expected = payload.filter(file => file.kind === kind);
            if (artifact.metadata.files.length !== expected.length) reject('state_conflict', 'The existing material files differ.');
            for (const file of expected) if (!Buffer.from(need(this.options.files.read(artifact, file.name, scope.contents))).equals(file.content))
              reject('state_conflict', 'The existing material bytes differ.');
          }
          if (need(this.options.inspect(found.documentRef, scope)).kind !== 'valid') reject('source_invalid', 'The original cloud document is unavailable.');
          return ok(this.attach(scope, manifest, found));
        }),
        register: pair => this.options.database.transaction(scope => {
          if (pair.original.kind !== 'original' || pair.parsed.kind !== 'parsed') reject('source_invalid', 'The published artifact kinds differ.');
          const document = need(scope.documents.register({ documentId: pair.documentId, sourceKey: manifest.sourceKey,
            sourceRecordId: manifest.sourceRecordId, version: manifest.sourceVersion,
            originalArtifact: { ...pair.original, kind: 'original' }, parsedArtifact: { ...pair.parsed, kind: 'parsed' },
            status: 'available', metadata: manifest.metadata, createdAt: at, updatedAt: at }));
          if (need(this.options.inspect(document.documentRef, scope)).kind !== 'valid') reject('source_invalid', 'The published cloud document is invalid.');
          return ok(this.attach(scope, manifest, document));
        }),
      });
      return need(published);
    });
  }
}
