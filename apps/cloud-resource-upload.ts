import { existsSync, linkSync, lstatSync, mkdirSync, realpathSync, unlinkSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';
import { isDeepStrictEqual } from 'node:util';
import { z } from 'zod';
import { appError, CLOUD_RESOURCE_CHUNK_BYTES, CloudResourceChunkSchema, CloudResourceKeySchema, CloudResourceManifestSchema,
  CloudResourceReceiptSchema, RESOURCE_LIMITS, ResourceManifestSchema, canonicalResourceManifest, resourceRefKey, fail, ok, type AppError, type CloudResourceManifest,
  type CloudResourceReceipt, type Result } from '@flowmate/contracts';
import { bytes, safePath, writeSynced } from '../packages/core/src/skill-hub/resources.ts';
import type { DbHandle, SqlDatabaseStore } from '../packages/core/src/storage/database.ts';

type Row = { manifest_json: string; state: 'receiving' | 'completed'; receipt_json: string | null };
class ResourceFault extends Error { constructor(readonly detail: AppError) { super(detail.code); } }
function reject(code: string, message: string): never { throw new ResourceFault(appError(code, 'input', message)); }
function sameDirectory(path: string): void {
  const info = lstatSync(path);
  if (!info.isDirectory() || info.isSymbolicLink() || relative(resolve(path), realpathSync(path)) !== '')
    reject('source_invalid', 'The cloud resource directory is unavailable or unsafe.');
}
function ensureDirectory(path: string): void {
  try { mkdirSync(path, { mode: 0o700 }); }
  catch (error) { if (!(error instanceof Error && 'code' in error && error.code === 'EEXIST')) throw error; }
  sameDirectory(path);
}
function checkedManifest(value: CloudResourceManifest): Buffer {
  const raw = Buffer.from(value.manifestBase64, 'base64');
  if (raw.length < 1 || raw.length > RESOURCE_LIMITS.manifestBytes || raw.toString('base64') !== value.manifestBase64)
    reject('input_invalid', 'The original resource manifest bytes are invalid.');
  let parsed: unknown;
  try { parsed = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(raw)); }
  catch { return reject('input_invalid', 'The original resource manifest is invalid.'); }
  if (!isDeepStrictEqual(ResourceManifestSchema.parse(parsed), value.manifest)) reject('state_conflict', 'The original resource manifest differs.');
  return raw;
}

/** The Authority keeps the exact upload intent and publishes a complete version without overwriting another. */
export class CloudResourceUpload {
  private tail: Promise<void> = Promise.resolve();
  constructor(private readonly options: { database: Pick<DbHandle, 'read' | 'transaction'>;
    resourceRoot: string; importedResourceRoot: string; now(): string }) {}
  private async run<T>(action: () => Promise<T>): Promise<Result<T>> {
    try { return ok(await action()); }
    catch (error) { return fail(error instanceof ResourceFault ? error.detail
      : appError('cloud_resource_unavailable', 'storage', 'The original cloud resource could not be confirmed.', true)); }
  }
  private row(scope: SqlDatabaseStore, workspaceId: string, uploadId: string): Row | null {
    return scope.db.query<Row, [string, string]>('SELECT manifest_json,state,receipt_json FROM cloud_resource_uploads WHERE workspace_id=? AND upload_id=?')
      .get(workspaceId, uploadId);
  }
  private manifest(row: Row): CloudResourceManifest { return CloudResourceManifestSchema.parse(JSON.parse(row.manifest_json)); }
  private receipt(row: Row): CloudResourceReceipt | null { return row.receipt_json === null ? null : CloudResourceReceiptSchema.parse(JSON.parse(row.receipt_json)); }
  async begin(raw: unknown): Promise<Result<{ status: 'receiving' | 'completed'; receipt: CloudResourceReceipt | null }>> {
    const parsed = CloudResourceManifestSchema.safeParse(raw); if (!parsed.success) return fail(appError('input_invalid', 'input', 'The resource upload is invalid.'));
    const manifest = parsed.data;
    return this.run(() => this.options.database.transaction(scope => {
      checkedManifest(manifest);
      const row = this.row(scope, manifest.workspaceId, manifest.uploadId);
      if (row) {
        if (!isDeepStrictEqual(this.manifest(row), manifest)) reject('state_conflict', 'The original resource upload differs.');
        return { status: row.state, receipt: this.receipt(row) };
      }
      const at = z.string().datetime({ offset: true }).parse(this.options.now());
      scope.db.query("INSERT INTO cloud_resource_uploads(workspace_id,upload_id,manifest_json,state,created_at) VALUES(?,?,?,'receiving',?)")
        .run(manifest.workspaceId, manifest.uploadId, JSON.stringify(manifest), at);
      return { status: 'receiving' as const, receipt: null };
    }));
  }
  async append(raw: unknown): Promise<Result<void>> {
    const parsed = CloudResourceChunkSchema.safeParse(raw); if (!parsed.success) return fail(appError('input_invalid', 'input', 'The resource chunk is invalid.'));
    const input = parsed.data, content = Buffer.from(input.base64, 'base64');
    if (!content.length || content.length > CLOUD_RESOURCE_CHUNK_BYTES || content.toString('base64') !== input.base64)
      return fail(appError('input_invalid', 'input', 'The resource chunk bytes are invalid.'));
    return this.run(() => this.options.database.transaction(scope => {
      const row = this.row(scope, input.workspaceId, input.uploadId); if (!row) reject('source_invalid', 'The original resource upload does not exist.');
      const file = this.manifest(row).manifest.files.find(value => value.path === input.path);
      if (!file || input.offset >= file.bytes || input.offset % CLOUD_RESOURCE_CHUNK_BYTES !== 0
        || content.length !== Math.min(CLOUD_RESOURCE_CHUNK_BYTES, file.bytes - input.offset)) reject('source_invalid', 'The original resource chunk boundary differs.');
      const prior = scope.db.query<{ content: Uint8Array }, [string, string, string, number]>(`SELECT content FROM cloud_resource_chunks
        WHERE workspace_id=? AND upload_id=? AND path=? AND byte_offset=?`).get(input.workspaceId, input.uploadId, input.path, input.offset);
      if (prior) { if (!Buffer.from(prior.content).equals(content)) reject('state_conflict', 'The original resource chunk differs.'); return; }
      if (row.state !== 'receiving') reject('state_conflict', 'The original resource upload has completed.');
      const received = scope.db.query<{ count: number }, [string, string, string]>(`SELECT COALESCE(SUM(length(content)),0) count FROM cloud_resource_chunks
        WHERE workspace_id=? AND upload_id=? AND path=?`).get(input.workspaceId, input.uploadId, input.path)!.count;
      if (received !== input.offset) reject('state_conflict', 'The original resource chunk is out of order.');
      scope.db.query('INSERT INTO cloud_resource_chunks(workspace_id,upload_id,path,byte_offset,content) VALUES(?,?,?,?,?)')
        .run(input.workspaceId, input.uploadId, input.path, input.offset, content);
    }));
  }
  async status(raw: unknown) {
    const parsed = CloudResourceKeySchema.safeParse(raw); if (!parsed.success) return fail(appError('input_invalid', 'input', 'The resource upload identity is invalid.'));
    const { workspaceId, uploadId } = parsed.data;
    return this.run(() => this.options.database.read(scope => {
      const row = this.row(scope, workspaceId, uploadId); if (!row) reject('source_invalid', 'The original resource upload does not exist.');
      const manifest = this.manifest(row), receipt = this.receipt(row);
      if ((row.state === 'completed') !== (receipt !== null)) reject('state_conflict', 'The original resource receipt is inconsistent.');
      const files = manifest.manifest.files.map(file => {
        const offset = scope.db.query<{ count: number }, [string, string, string]>(`SELECT COALESCE(SUM(length(content)),0) count FROM cloud_resource_chunks
          WHERE workspace_id=? AND upload_id=? AND path=?`).get(workspaceId, uploadId, file.path)!.count;
        if (offset > file.bytes || offset < file.bytes && offset % CLOUD_RESOURCE_CHUNK_BYTES !== 0 || row.state === 'completed' && offset !== file.bytes)
          reject('state_conflict', 'The original resource upload offsets differ.');
        return { path: file.path, offset };
      });
      return { workspaceId, uploadId, status: row.state, receipt, files };
    }));
  }
  private publish(manifest: CloudResourceManifest, payload: Array<{ path: string; content: Buffer }>): void {
    const rawManifest = checkedManifest(manifest), group = manifest.ref.kind === 'prompt' ? 'prompts' : 'skills';
    const builtin = resolve(this.options.resourceRoot), builtinRelative = `${group}/${manifest.ref.id}`;
    if (existsSync(join(builtin, builtinRelative, 'resource.json'))) {
      const previous = bytes(safePath(builtin, `${builtinRelative}/resource.json`), RESOURCE_LIMITS.manifestBytes);
      const known = ResourceManifestSchema.parse(JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(previous)));
      if (known.version === manifest.ref.version) {
        if (!previous.equals(rawManifest) || payload.some(file => !bytes(safePath(join(builtin, builtinRelative), file.path), RESOURCE_LIMITS.fileBytes).equals(file.content)))
          reject('state_conflict', 'The registered resource version has different original bytes.');
        return;
      }
    }
    const root = resolve(this.options.importedResourceRoot);
    mkdirSync(root, { recursive: true, mode: 0o700 }); sameDirectory(root);
    let directory = root;
    for (const segment of [group, manifest.ref.id, manifest.ref.version]) { directory = join(directory, segment); ensureDirectory(directory); }
    if (existsSync(join(directory, 'resource.json'))) {
      if (!bytes(safePath(directory, 'resource.json'), RESOURCE_LIMITS.manifestBytes).equals(rawManifest)
        || payload.some(file => !bytes(safePath(directory, file.path), RESOURCE_LIMITS.fileBytes).equals(file.content)))
        reject('state_conflict', 'The imported resource version has different original bytes.');
      return;
    }
    const put = (path: string, content: Buffer, index: number) => {
      const segments = path.split('/'); let parent = directory;
      for (const segment of segments.slice(0, -1)) { parent = join(parent, segment); ensureDirectory(parent); }
      const file = join(parent, segments.at(-1)!), temporary = join(parent, `.flowmate-${manifest.uploadId}-${index}.tmp`);
      const temporaryPath = relative(directory, temporary), maximum = Math.max(RESOURCE_LIMITS.fileBytes, RESOURCE_LIMITS.manifestBytes);
      if (!existsSync(file)) {
        if (existsSync(temporary) && !bytes(safePath(directory, temporaryPath), maximum).equals(content)) unlinkSync(temporary);
        if (!existsSync(temporary)) writeSynced(temporary, content);
        try { linkSync(temporary, file); }
        catch (error) { if (!(error instanceof Error && 'code' in error && error.code === 'EEXIST')) throw error; }
      }
      if (!bytes(safePath(directory, path), maximum).equals(content))
        reject('state_conflict', 'The imported resource version has different original bytes.');
      if (existsSync(temporary)) { safePath(directory, temporaryPath); unlinkSync(temporary); }
    };
    for (const [index, file] of payload.entries()) put(file.path, file.content, index);
    put('resource.json', rawManifest, payload.length);
  }
  async finish(raw: unknown): Promise<Result<CloudResourceReceipt>> {
    const parsed = CloudResourceKeySchema.safeParse(raw); if (!parsed.success) return fail(appError('input_invalid', 'input', 'The resource upload identity is invalid.'));
    const previous = this.tail; let release!: () => void; this.tail = new Promise(resolveTail => { release = resolveTail; });
    return previous.then(() => this.run(async () => {
      const { workspaceId, uploadId } = parsed.data;
      const snapshot = await this.options.database.read(scope => {
        const row = this.row(scope, workspaceId, uploadId); if (!row) reject('source_invalid', 'The original resource upload does not exist.');
        const manifest = this.manifest(row), receipt = this.receipt(row); if (receipt) return { manifest, receipt, payload: null };
        const payload = manifest.manifest.files.map(file => {
          const chunks = scope.db.query<{ byte_offset: number; content: Uint8Array }, [string, string, string]>(`SELECT byte_offset,content FROM cloud_resource_chunks
            WHERE workspace_id=? AND upload_id=? AND path=? ORDER BY byte_offset`).all(workspaceId, uploadId, file.path);
          let offset = 0; const pieces: Buffer[] = [];
          for (const chunk of chunks) { if (chunk.byte_offset !== offset) reject('state_conflict', 'The original resource is incomplete.');
            const content = Buffer.from(chunk.content); offset += content.length; pieces.push(content); }
          if (offset !== file.bytes) reject('state_conflict', 'The original resource is incomplete.');
          return { path: file.path, content: Buffer.concat(pieces, offset) };
        });
        return { manifest, receipt: null, payload };
      });
      if (snapshot.receipt) return snapshot.receipt;
      this.publish(snapshot.manifest, snapshot.payload!);
      return this.options.database.transaction(scope => {
        const row = this.row(scope, workspaceId, uploadId);
        if (!row || !isDeepStrictEqual(this.manifest(row), snapshot.manifest)) reject('state_conflict', 'The original resource upload changed.');
        const prior = this.receipt(row); if (prior) return prior;
        const ref = snapshot.manifest.ref;
        const ownerId = resourceRefKey(ref);
        scope.contents.remember({ ownerKind: 'cloud-resource-manifest', ownerId, relativePath: 'resource.json' }, checkedManifest(snapshot.manifest));
        scope.contents.remember({ ownerKind: 'resource-author', ownerId, relativePath: 'resource.json' }, Buffer.from(canonicalResourceManifest(snapshot.manifest.manifest)));
        for (const file of snapshot.payload!) scope.contents.remember({ ownerKind: 'resource-author', ownerId, relativePath: file.path }, file.content);
        scope.db.query('INSERT INTO cloud_workspace_resources(workspace_id,upload_id,kind,resource_id,resource_version) VALUES(?,?,?,?,?)')
          .run(workspaceId, uploadId, ref.kind, ref.id, ref.version);
        const receipt = CloudResourceReceiptSchema.parse({ workspaceId, uploadId, ref });
        if (scope.db.query("UPDATE cloud_resource_uploads SET state='completed',receipt_json=? WHERE workspace_id=? AND upload_id=? AND state='receiving'")
          .run(JSON.stringify(receipt), workspaceId, uploadId).changes !== 1) reject('state_conflict', 'The original resource receipt could not be saved.');
        return receipt;
      });
    })).finally(release);
  }
}
