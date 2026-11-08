import { link, lstat, open, rm } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { appError, fail, ok, type Result } from '@flowmate/contracts';
import {
  CLOUD_OPENVIKING_CHUNK_BYTES as chunkBytes, CloudOpenVikingDownloadChunkSchema, CloudOpenVikingDownloadStatusSchema,
  CloudOpenVikingUploadManifestSchema, CloudOpenVikingUploadStatusSchema, type CloudOpenVikingManagementCommand,
} from '../../../packages/contracts/src/cloud-openviking-management.ts';

export type CloudOpenVikingCall = (command: CloudOpenVikingManagementCommand) => Promise<Result<unknown>>;
const invalid = () => fail(appError('state_conflict', 'storage', 'The original OpenViking file or offset could not be confirmed.'));
const unavailable = () => fail(appError('cloud_openviking_transfer_unavailable', 'storage', 'The file transfer stopped. Check the original transfer to resume.', true));
const missing = (error: unknown) => error instanceof Error && 'code' in error && error.code === 'ENOENT';

async function retryChunk(call: CloudOpenVikingCall, command: Exclude<CloudOpenVikingManagementCommand, { type: 'execute' }>) {
  let result = await call(command);
  if (!result.ok && result.error.code === 'cloud_openviking_transport_lost') result = await call(command);
  return result;
}

export async function uploadCloudOpenVikingFile(call: CloudOpenVikingCall, input: {
  operationId: string; uploadId: string; name: string; body: Blob;
}): Promise<Result<void>> {
  const { operationId, uploadId, name, body } = input;
  const manifest = CloudOpenVikingUploadManifestSchema.safeParse({ operationId, uploadId, name, bytes: body.size });
  if (!manifest.success) return invalid();
  function status(value: unknown) {
    const parsed = CloudOpenVikingUploadStatusSchema.safeParse(value);
    if (!parsed.success) return null;
    const item = parsed.data;
    return item.operationId === operationId && item.uploadId === uploadId && item.name === name && item.bytes === body.size
      && item.offset <= body.size && (item.offset === body.size || item.offset % chunkBytes === 0)
      && (!item.finished || item.offset === body.size) ? item : null;
  }
  try {
    const started = await retryChunk(call, { type: 'upload_begin', input: manifest.data });
    if (!started.ok) return started;
    const progress = status(started.data);
    if (!progress) return invalid();
    const key = { operationId, uploadId };
    for (let offset = progress.offset; offset < body.size; offset += chunkBytes) {
      const chunk = Buffer.from(await body.slice(offset, offset + chunkBytes).arrayBuffer());
      const appended = await retryChunk(call, { type: 'upload_append', input: { ...key, offset, base64: chunk.toString('base64') } });
      if (!appended.ok) return appended;
      if (status(appended.data)?.offset !== offset + chunk.length) return invalid();
    }
    const finished = await retryChunk(call, { type: 'upload_finish', input: key });
    if (!finished.ok) return finished;
    return status(finished.data)?.finished ? ok(undefined) : invalid();
  } catch { return unavailable(); }
}

const temporaryPath = (path: string, operationId: string) => join(dirname(path), '.flowmate-openviking-' + operationId + '.partial');
export async function removeCloudOpenVikingPartial(path: string, operationId: string): Promise<void> {
  await rm(temporaryPath(path, operationId), { force: true });
}

export async function downloadCloudOpenVikingFile(call: CloudOpenVikingCall, operationId: string, path: string): Promise<Result<void>> {
  const partial = temporaryPath(path, operationId);
  try {
    const response = await retryChunk(call, { type: 'download_status', input: { operationId } });
    if (!response.ok) return response;
    const status = CloudOpenVikingDownloadStatusSchema.safeParse(response.data);
    if (!status.success || status.data.operationId !== operationId) return invalid();
    const { name, bytes } = status.data;
    let staged;
    try { staged = await lstat(partial); } catch (error) { if (!missing(error)) throw error; }
    if (staged && (!staged.isFile() || staged.isSymbolicLink() || staged.size > bytes)) return invalid();
    try {
      const destination = await lstat(path);
      return staged && destination.isFile() && !destination.isSymbolicLink() && staged.ino !== 0
        && staged.dev === destination.dev && staged.ino === destination.ino && staged.size === bytes ? ok(undefined) : invalid();
    } catch (error) { if (!missing(error)) throw error; }
    const file = await open(partial, staged ? 'r+' : 'wx', 0o600);
    try {
      let offset = staged?.size ?? 0;
      if (offset < bytes && offset % chunkBytes) {
        offset -= offset % chunkBytes;
        await file.truncate(offset);
      }
      while (offset < bytes) {
        const read = await retryChunk(call, { type: 'download_read', input: { operationId, offset } });
        if (!read.ok) return read;
        const responseChunk = CloudOpenVikingDownloadChunkSchema.safeParse(read.data);
        if (!responseChunk.success || responseChunk.data.operationId !== operationId || responseChunk.data.name !== name
          || responseChunk.data.bytes !== bytes || responseChunk.data.offset !== offset) return invalid();
        const chunk = Buffer.from(responseChunk.data.base64, 'base64');
        if (chunk.length !== Math.min(chunkBytes, bytes - offset) || chunk.toString('base64') !== responseChunk.data.base64) return invalid();
        try {
          if ((await file.write(chunk, 0, chunk.length, offset)).bytesWritten !== chunk.length) throw Error('partial_transfer_write');
          await file.sync();
        } catch (error) { await file.truncate(offset); throw error; }
        offset += chunk.length;
      }
      await file.sync();
    } finally { await file.close(); }
    await link(partial, path);
    return ok(undefined);
  } catch { return unavailable(); }
}
