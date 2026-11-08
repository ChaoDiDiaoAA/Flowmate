import { randomUUID } from 'node:crypto';
import { lstatSync, mkdirSync, realpathSync } from 'node:fs';
import { link, lstat, open, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { join, relative, resolve } from 'node:path';
import { isDeepStrictEqual } from 'node:util';
import { appError, fail, ok, type Result } from '@flowmate/contracts';
import {
  CLOUD_OPENVIKING_CHUNK_BYTES as chunkBytes, CLOUD_OPENVIKING_FILE_LIMIT as fileLimit,
  CloudOpenVikingDownloadStatusSchema, CloudOpenVikingFileNameSchema,
  CloudOpenVikingManagementCommandSchema, CloudOpenVikingManagementExecuteInputSchema, CloudOpenVikingUploadManifestSchema,
  type CloudOpenVikingManagementCommand, type CloudOpenVikingManagementExecuteInput,
} from '../packages/contracts/src/cloud-openviking-management.ts';
import type { OpenVikingManagementFiles } from '../packages/core/src/openviking/management.ts';

const missing = (error: unknown) => error instanceof Error && 'code' in error && error.code === 'ENOENT';
const invalid = () => fail(appError('input_invalid', 'input', 'The OpenViking file transfer request is invalid.'));
const conflict = () => fail(appError('state_conflict', 'storage', 'The original OpenViking file or offset could not be confirmed.'));
const unavailable = () => fail(appError('cloud_openviking_transfer_unavailable', 'storage', 'The original OpenViking file transfer could not be confirmed.', true));

async function publishManifest(path: string, value: unknown): Promise<void> {
  const staged = path + '.' + randomUUID() + '.tmp';
  try {
    await writeFile(staged, JSON.stringify(value), { flag: 'wx', mode: 0o600 });
    await link(staged, path);
  } finally { await rm(staged, { force: true }); }
}

/** The Authority creates one private root per authenticated role and identity. */
export function createCloudOpenVikingTransfer(directory: string) {
  const root = resolve(directory);
  try { mkdirSync(root, { mode: 0o700 }); }
  catch (error) { if (!(error instanceof Error && 'code' in error && error.code === 'EEXIST')) throw error; }
  const metadata = lstatSync(root);
  if (!metadata.isDirectory() || metadata.isSymbolicLink() || relative(root, realpathSync(root)) !== ''
    || process.platform === 'linux' && (metadata.uid !== process.getuid?.() || (metadata.mode & 0o077) !== 0))
    throw Error('OpenViking transfer directory is unsafe.');
  const maxFiles = 8;
  let busy = false;
  const paths = (operationId: string, direction: 'upload' | 'download') => {
    const base = join(root, operationId + '.' + direction);
    return { manifest: base + '.json', data: base + '.data', ready: base + '.ready' };
  };
  async function readJson(path: string): Promise<unknown> {
    const info = await lstat(path);
    if (!info.isFile() || info.isSymbolicLink() || info.size > 4096) throw Error('invalid_transfer_manifest');
    return JSON.parse(await readFile(path, 'utf8'));
  }
  async function payloadLength(path: string): Promise<number> {
    try {
      const info = await lstat(path);
      if (!info.isFile() || info.isSymbolicLink() || info.size > fileLimit) throw Error('invalid_transfer_data');
      return info.size;
    } catch (error) { if (missing(error)) return 0; throw error; }
  }
  async function room(): Promise<boolean> {
    return (await readdir(root)).filter(name => name.endsWith('.json')).length < maxFiles;
  }
  async function handleTransfer(raw: CloudOpenVikingManagementCommand): Promise<Result<unknown>> {
    const checked = CloudOpenVikingManagementCommandSchema.safeParse(raw);
    if (!checked.success) return invalid();
    const command = checked.data;
    if (command.type === 'execute' || command.type === 'outcome' || command.type === 'info') return invalid();
    if (busy) return unavailable();
    busy = true;
    try {
      const input = command.input, { operationId } = input;
      if ('uploadId' in input) {
        const target = paths(operationId, 'upload');
        let manifest;
        try { manifest = CloudOpenVikingUploadManifestSchema.parse(await readJson(target.manifest)); }
        catch (error) {
          if (!missing(error)) throw error;
          if (command.type === 'upload_release') return ok(null);
          if (command.type !== 'upload_begin') return conflict();
          if (!await room()) return unavailable();
          manifest = command.input;
          await publishManifest(target.manifest, manifest);
        }
        if (manifest.operationId !== operationId || manifest.uploadId !== input.uploadId
          || command.type === 'upload_begin' && !isDeepStrictEqual(manifest, command.input)) return conflict();
        if (command.type === 'upload_release') {
          await rm(target.ready, { force: true });
          await rm(target.data, { force: true });
          await rm(target.manifest, { force: true });
          return ok(null);
        }
        let offset = await payloadLength(target.data);
        if (offset > manifest.bytes) return conflict();
        if (offset < manifest.bytes && offset % chunkBytes) {
          offset -= offset % chunkBytes;
          const file = await open(target.data, 'r+');
          try { await file.truncate(offset); await file.sync(); }
          finally { await file.close(); }
        }
        let finished = false;
        try { finished = (await lstat(target.ready)).isFile() && offset === manifest.bytes; }
        catch (error) { if (!missing(error)) throw error; }
        if (command.type === 'upload_append') {
          const { offset: start, base64 } = command.input, chunk = Buffer.from(base64, 'base64');
          if (chunk.length !== Math.min(chunkBytes, manifest.bytes - start) || chunk.toString('base64') !== base64
            || start > offset) return conflict();
          if (start < offset) {
            const original = Buffer.alloc(chunk.length), file = await open(target.data, 'r');
            try {
              const read = await file.read(original, 0, original.length, start);
              if (read.bytesRead !== chunk.length || !original.equals(chunk)) return conflict();
            } finally { await file.close(); }
          } else {
            if (finished) return conflict();
            let file;
            try { file = await open(target.data, 'r+'); }
            catch (error) { if (!missing(error)) throw error; file = await open(target.data, 'wx', 0o600); }
            try {
              if ((await file.write(chunk, 0, chunk.length, offset)).bytesWritten !== chunk.length) throw Error('partial_transfer_write');
              await file.sync();
            } catch (error) { await file.truncate(offset); throw error; }
            finally { await file.close(); }
            offset += chunk.length;
          }
        }
        if (command.type === 'upload_finish' && !finished) {
          if (offset !== manifest.bytes) return conflict();
          await writeFile(target.ready, '', { flag: 'wx', mode: 0o600 });
          finished = true;
        }
        return ok({ ...manifest, offset, finished });
      }
      const target = paths(operationId, 'download');
      if (command.type === 'download_release') {
        await rm(target.data, { force: true });
        await rm(target.manifest, { force: true });
        return ok(null);
      }
      const manifest = CloudOpenVikingDownloadStatusSchema.parse(await readJson(target.manifest));
      if (manifest.operationId !== operationId || await payloadLength(target.data) !== manifest.bytes) return conflict();
      if (command.type === 'download_status') return ok(manifest);
      if (command.type !== 'download_read' || command.input.offset >= manifest.bytes) return invalid();
      const offset = command.input.offset, chunk = Buffer.alloc(Math.min(chunkBytes, manifest.bytes - offset));
      const file = await open(target.data, 'r');
      try {
        if ((await file.read(chunk, 0, chunk.length, offset)).bytesRead !== chunk.length) return conflict();
        return ok({ ...manifest, offset, base64: chunk.toString('base64') });
      } finally { await file.close(); }
    } catch (error) { return missing(error) ? conflict() : unavailable(); }
    finally { busy = false; }
  }
  function files(raw: CloudOpenVikingManagementExecuteInput): OpenVikingManagementFiles {
    const input = CloudOpenVikingManagementExecuteInputSchema.parse(raw);
    const { operationId } = input;
    return {
      async selectUpload() {
        if (!input.uploadId) return null;
        const status = await handleTransfer({ type: 'upload_status', input: { operationId, uploadId: input.uploadId } });
        if (!status.ok) return null;
        const data = status.data as { name: string; bytes: number; finished: boolean };
        if (!data.finished) return null;
        return { name: data.name, body: data.bytes ? Bun.file(paths(operationId, 'upload').data) : new Blob() };
      },
      async selectOutput(name) {
        if (!input.output || !CloudOpenVikingFileNameSchema.safeParse(name).success || !await room()) return null;
        return async stream => {
          const target = paths(operationId, 'download');
          const file = await open(target.data, 'wx', 0o600), reader = stream.getReader();
          let bytes = 0, published = false;
          try {
            for (;;) {
              const next = await reader.read(); if (next.done) break;
              bytes += next.value.byteLength;
              if (bytes > fileLimit) throw Error('OpenViking download exceeds the file limit.');
              await file.writeFile(next.value);
            }
            await file.sync();
            await publishManifest(target.manifest, { operationId, name, bytes });
            published = true;
          } finally {
            try { if (!published) await reader.cancel(); }
            finally {
              reader.releaseLock();
              await file.close();
              if (!published) await rm(target.data, { force: true });
            }
          }
        };
      },
      async selectPrivateOptions() { return input.privateOptions ?? null; },
    };
  }
  return { handleTransfer, files };
}
