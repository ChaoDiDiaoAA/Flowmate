import { randomUUID } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import { z } from 'zod';
import { appError, CLOUD_MATERIAL_CHUNK_BYTES, CloudMaterialChunkSchema, CloudMaterialExportChunkSchema, CloudMaterialExportPrepareSchema,
  CloudMaterialManifestSchema, CloudMaterialReceiptSchema, fail, ok, type AppError, type CloudMaterialManifest, type CloudMaterialReceipt,
  type DocumentRef, type Result, type WorkspaceMaterialInspection } from '@flowmate/contracts';
import type { DbHandle, SqlDatabaseStore } from '../packages/core/src/storage/database.ts';
import type { createFileStore } from '../packages/core/src/storage/file-store.ts';

type Options = { database: Pick<DbHandle, 'read' | 'transaction'>; files: Pick<ReturnType<typeof createFileStore>, 'read'>;
  inspect(ref: DocumentRef, scope: SqlDatabaseStore): Result<WorkspaceMaterialInspection>; now(): string };
type Row = { upload_id: string; manifest_json: string; receipt_json: string | null };
class ExportFault extends Error { constructor(readonly detail: AppError) { super(detail.code); } }
function need<T>(value: Result<T>): T { if (!value.ok) throw new ExportFault(value.error); return value.data; }
function reject(code: string, message: string): never { throw new ExportFault(appError(code, 'input', message)); }

/** The local product database owns the upload ID; original material remains in its managed store. */
export class CloudMaterialExport {
  constructor(private readonly options: Options) {}
  private async run<T>(action: () => Promise<T>): Promise<Result<T>> {
    try { return ok(await action()); }
    catch (error) { return fail(error instanceof ExportFault ? error.detail
      : appError('cloud_material_unavailable', 'storage', 'The original local material could not be confirmed.', true)); }
  }
  private manifest(scope: SqlDatabaseStore, workspaceId: string, uploadId: string, ref: DocumentRef): CloudMaterialManifest {
    if (need(this.options.inspect(ref, scope)).kind !== 'valid') reject('source_invalid', 'The local material is unavailable or changed.');
    const document = need(scope.documents.get(ref.id));
    const original = need(scope.documents.getArtifact(document.originalArtifactId));
    const parsed = need(scope.documents.getArtifact(document.parsedArtifactId));
    const raw = scope.db.query<{ metadata_json: string }, [number]>('SELECT metadata_json FROM documents WHERE id=?').get(ref.id);
    if (!raw) reject('source_invalid', 'The local material metadata is unavailable.');
    return CloudMaterialManifestSchema.parse({ version: 1, workspaceId, uploadId, sourceDocumentRef: ref,
      sourceKey: original.metadata.sourceKey, sourceRecordId: original.metadata.sourceRecordId, sourceVersion: original.metadata.sourceVersion,
      originalName: original.relativePath.slice(original.relativePath.lastIndexOf('/') + 1), metadata: JSON.parse(raw.metadata_json),
      files: [original, parsed].flatMap(artifact => artifact.metadata.files.map(file => ({ kind: artifact.kind,
        name: file.relativePath, mimeType: file.mimeType, bytes: file.bytes }))) });
  }
  private receipt(row: Row): CloudMaterialReceipt | null {
    return row.receipt_json === null ? null : CloudMaterialReceiptSchema.parse(JSON.parse(row.receipt_json));
  }

  async prepare(raw: unknown): Promise<Result<{ manifest: CloudMaterialManifest; receipt: CloudMaterialReceipt | null }>> {
    const parsed = CloudMaterialExportPrepareSchema.safeParse(raw);
    if (!parsed.success) return fail(appError('input_invalid', 'input', 'The local upload request is invalid.'));
    const { workspaceId, documentRef } = parsed.data;
    return this.run(() => this.options.database.transaction(scope => {
      const row = scope.db.query<Row, [string, number, string]>(`SELECT upload_id,manifest_json,receipt_json FROM cloud_desktop_material_uploads
        WHERE workspace_id=? AND document_id=? AND document_version=?`).get(workspaceId, documentRef.id, documentRef.version);
      const manifest = this.manifest(scope, workspaceId, row?.upload_id ?? randomUUID(), documentRef);
      if (row) {
        if (!isDeepStrictEqual(CloudMaterialManifestSchema.parse(JSON.parse(row.manifest_json)), manifest))
          reject('state_conflict', 'The original local material facts have changed.');
        return { manifest, receipt: this.receipt(row) };
      }
      const at = z.string().datetime({ offset: true }).parse(this.options.now());
      scope.db.query(`INSERT INTO cloud_desktop_material_uploads(workspace_id,upload_id,document_id,document_version,manifest_json,created_at)
        VALUES(?,?,?,?,?,?)`).run(workspaceId, manifest.uploadId, documentRef.id, documentRef.version, JSON.stringify(manifest), at);
      return { manifest, receipt: null };
    }));
  }

  async chunk(raw: unknown): Promise<Result<z.infer<typeof CloudMaterialChunkSchema>>> {
    const parsed = CloudMaterialExportChunkSchema.safeParse(raw);
    if (!parsed.success) return fail(appError('input_invalid', 'input', 'The local material chunk request is invalid.'));
    const request = parsed.data;
    return this.run(() => this.options.database.read(scope => {
      const row = scope.db.query<Row, [string, string]>(`SELECT upload_id,manifest_json,receipt_json FROM cloud_desktop_material_uploads
        WHERE workspace_id=? AND upload_id=?`).get(request.workspaceId, request.uploadId);
      if (!row) reject('source_invalid', 'The original local upload does not exist.');
      const saved = CloudMaterialManifestSchema.parse(JSON.parse(row.manifest_json));
      const current = this.manifest(scope, request.workspaceId, request.uploadId, saved.sourceDocumentRef);
      if (!isDeepStrictEqual(saved, current)) reject('state_conflict', 'The original local material facts have changed.');
      const file = saved.files.find(value => value.kind === request.kind && value.name === request.name);
      if (!file || request.offset >= file.bytes || request.offset % CLOUD_MATERIAL_CHUNK_BYTES !== 0)
        reject('source_invalid', 'The requested chunk is outside the original file.');
      const document = need(scope.documents.get(saved.sourceDocumentRef.id));
      const artifact = need(scope.documents.getArtifact(request.kind === 'original' ? document.originalArtifactId : document.parsedArtifactId));
      const bytes = need(this.options.files.read(artifact, request.name, scope.contents));
      return { ...request, base64: Buffer.from(bytes).subarray(request.offset, request.offset + CLOUD_MATERIAL_CHUNK_BYTES).toString('base64') };
    }));
  }

  async complete(raw: unknown): Promise<Result<CloudMaterialReceipt>> {
    const parsed = CloudMaterialReceiptSchema.safeParse(raw);
    if (!parsed.success) return fail(appError('input_invalid', 'input', 'The cloud material receipt is invalid.'));
    const receipt = parsed.data;
    return this.run(() => this.options.database.transaction(scope => {
      const row = scope.db.query<Row, [string, string]>(`SELECT upload_id,manifest_json,receipt_json FROM cloud_desktop_material_uploads
        WHERE workspace_id=? AND upload_id=?`).get(receipt.workspaceId, receipt.uploadId);
      if (!row) reject('source_invalid', 'The original local upload does not exist.');
      const manifest = CloudMaterialManifestSchema.parse(JSON.parse(row.manifest_json));
      if (!isDeepStrictEqual(manifest.sourceDocumentRef, receipt.sourceDocumentRef)
        || receipt.cloudDocumentRef.version !== manifest.sourceVersion) reject('state_conflict', 'The cloud receipt refers to different material.');
      const prior = this.receipt(row);
      if (prior && !isDeepStrictEqual(prior, receipt)) reject('state_conflict', 'The original cloud material receipt differs.');
      if (!prior) scope.db.query('UPDATE cloud_desktop_material_uploads SET receipt_json=? WHERE workspace_id=? AND upload_id=? AND receipt_json IS NULL')
        .run(JSON.stringify(receipt), receipt.workspaceId, receipt.uploadId);
      return prior ?? receipt;
    }));
  }
}
