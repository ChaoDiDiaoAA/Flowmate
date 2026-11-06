import { randomUUID } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import { z } from 'zod';
import { appError, CLOUD_RESOURCE_CHUNK_BYTES, CloudResourceChunkSchema, CloudResourceExportChunkSchema, CloudResourceExportPrepareSchema,
  CloudResourceManifestSchema, CloudResourceReceiptSchema, fail, ok, type AppError, type CloudResourceManifest,
  type CloudResourceReceipt, type InspectNativeResources, type ResourceRef, type Result } from '@flowmate/contracts';
import { createResourceLoader } from '../packages/core/src/skill-hub/loader.ts';
import type { DbHandle, SqlDatabaseStore } from '../packages/core/src/storage/database.ts';

type Row = { upload_id: string; manifest_json: string; receipt_json: string | null };
class ResourceFault extends Error { constructor(readonly detail: AppError) { super(detail.code); } }
function need<T>(value: Result<T>): T { if (!value.ok) throw new ResourceFault(value.error); return value.data; }
function reject(code: string, message: string): never { throw new ResourceFault(appError(code, 'input', message)); }

/** The local product owner fixes one upload identity and verifies the selected author bytes on every chunk. */
export class CloudResourceExport {
  private readonly loader: ReturnType<typeof createResourceLoader>;
  constructor(private readonly options: { database: Pick<DbHandle, 'read' | 'transaction'>; resourceRoot: string;
    inspectNativeResources: InspectNativeResources; now(): string }) {
    this.loader = createResourceLoader({ resourceRoot: options.resourceRoot, inspectNativeResources: options.inspectNativeResources });
  }
  private async run<T>(action: () => Promise<T>): Promise<Result<T>> {
    try { return ok(await action()); }
    catch (error) { return fail(error instanceof ResourceFault ? error.detail
      : appError('cloud_resource_unavailable', 'storage', 'The original local resource could not be confirmed.', true)); }
  }
  private snapshot(scope: SqlDatabaseStore, workspaceId: string, uploadId: string, ref: ResourceRef) {
    const pack = need(this.loader.author(ref, scope.contents));
    const manifest = CloudResourceManifestSchema.parse({ version: 1, workspaceId, uploadId, ref, manifest: pack.manifest,
      manifestBase64: pack.manifestBytes.toString('base64') });
    return { manifest, contents: pack.contents };
  }
  private receipt(row: Row): CloudResourceReceipt | null {
    return row.receipt_json === null ? null : CloudResourceReceiptSchema.parse(JSON.parse(row.receipt_json));
  }
  async prepare(raw: unknown): Promise<Result<{ manifest: CloudResourceManifest; receipt: CloudResourceReceipt | null }>> {
    const parsed = CloudResourceExportPrepareSchema.safeParse(raw); if (!parsed.success) return fail(appError('input_invalid', 'input', 'The local resource request is invalid.'));
    const { workspaceId, ref } = parsed.data;
    return this.run(() => this.options.database.transaction(scope => {
      const row = scope.db.query<Row, [string, string, string, string]>(`SELECT upload_id,manifest_json,receipt_json FROM cloud_desktop_resource_uploads
        WHERE workspace_id=? AND kind=? AND resource_id=? AND resource_version=?`).get(workspaceId, ref.kind, ref.id, ref.version);
      const { manifest } = this.snapshot(scope, workspaceId, row?.upload_id ?? randomUUID(), ref);
      if (row) {
        if (!isDeepStrictEqual(CloudResourceManifestSchema.parse(JSON.parse(row.manifest_json)), manifest)) reject('state_conflict', 'The original resource manifest changed.');
        return { manifest, receipt: this.receipt(row) };
      }
      const at = z.string().datetime({ offset: true }).parse(this.options.now());
      scope.db.query(`INSERT INTO cloud_desktop_resource_uploads(workspace_id,upload_id,kind,resource_id,resource_version,manifest_json,created_at)
        VALUES(?,?,?,?,?,?,?)`).run(workspaceId, manifest.uploadId, ref.kind, ref.id, ref.version, JSON.stringify(manifest), at);
      return { manifest, receipt: null };
    }));
  }
  async chunk(raw: unknown): Promise<Result<z.infer<typeof CloudResourceChunkSchema>>> {
    const parsed = CloudResourceExportChunkSchema.safeParse(raw); if (!parsed.success) return fail(appError('input_invalid', 'input', 'The resource chunk request is invalid.'));
    const input = parsed.data;
    return this.run(() => this.options.database.transaction(scope => {
      const row = scope.db.query<Row, [string, string]>('SELECT upload_id,manifest_json,receipt_json FROM cloud_desktop_resource_uploads WHERE workspace_id=? AND upload_id=?')
        .get(input.workspaceId, input.uploadId);
      if (!row) reject('source_invalid', 'The original local resource upload does not exist.');
      const saved = CloudResourceManifestSchema.parse(JSON.parse(row.manifest_json)), current = this.snapshot(scope, input.workspaceId, input.uploadId, saved.ref);
      if (!isDeepStrictEqual(saved, current.manifest)) reject('state_conflict', 'The original resource manifest changed.');
      const file = saved.manifest.files.find(value => value.path === input.path), bytes = current.contents.get(input.path);
      if (!file || !bytes || input.offset >= file.bytes || input.offset % CLOUD_RESOURCE_CHUNK_BYTES !== 0)
        reject('source_invalid', 'The resource chunk is outside the original file.');
      return { ...input, base64: bytes.subarray(input.offset, input.offset + CLOUD_RESOURCE_CHUNK_BYTES).toString('base64') };
    }));
  }
  async complete(raw: unknown): Promise<Result<CloudResourceReceipt>> {
    const parsed = CloudResourceReceiptSchema.safeParse(raw); if (!parsed.success) return fail(appError('input_invalid', 'input', 'The cloud resource receipt is invalid.'));
    const receipt = parsed.data;
    return this.run(() => this.options.database.transaction(scope => {
      const row = scope.db.query<Row, [string, string]>('SELECT upload_id,manifest_json,receipt_json FROM cloud_desktop_resource_uploads WHERE workspace_id=? AND upload_id=?')
        .get(receipt.workspaceId, receipt.uploadId);
      if (!row) reject('source_invalid', 'The original local resource upload does not exist.');
      const saved = CloudResourceManifestSchema.parse(JSON.parse(row.manifest_json));
      const current = this.snapshot(scope, receipt.workspaceId, receipt.uploadId, saved.ref);
      if (!isDeepStrictEqual(saved, current.manifest) || !isDeepStrictEqual(saved.ref, receipt.ref)) reject('state_conflict', 'The original resource receipt differs.');
      const prior = this.receipt(row); if (prior && !isDeepStrictEqual(prior, receipt)) reject('state_conflict', 'The original cloud receipt differs.');
      if (!prior) scope.db.query('UPDATE cloud_desktop_resource_uploads SET receipt_json=? WHERE workspace_id=? AND upload_id=? AND receipt_json IS NULL')
        .run(JSON.stringify(receipt), receipt.workspaceId, receipt.uploadId);
      return prior ?? receipt;
    }));
  }
}
