import { closeSync, fstatSync, fsyncSync, lstatSync, openSync, readSync, realpathSync, writeFileSync } from 'node:fs';
import { isAbsolute, join, relative, resolve, sep } from 'node:path';
import { AppErrorSchema, appError, fail, ok, CONTEXT_ERROR_FACTS, RESOURCE_LIMITS } from '@flowmate/contracts';
import type { ResourceErrorCode, ResourceFilePage, ResourceFileRequest, ResourceRef, Result } from '@flowmate/contracts';

export const decoder = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true });
export const compare = (a: string, b: string) => a < b ? -1 : a > b ? 1 : 0;
// Frozen bundles retain their original versioned layout independently of author packages.
export const versionPath = (ref: Pick<ResourceRef, 'kind' | 'id' | 'version'>) => `${ref.kind === 'prompt' ? 'prompts' : 'skills'}/${ref.id}/${ref.version}`;
const samePath = (a: string, b: string) => process.platform === 'win32' ? a.toLowerCase() === b.toLowerCase() : a === b;
export function reject(code: ResourceErrorCode, message: string): never {
  const [category, retryable] = CONTEXT_ERROR_FACTS[code]!;
  throw appError(code, category, message, retryable);
}
export function checked<T>(action: () => T, code: ResourceErrorCode = 'resource_manifest_invalid'): Result<T> {
  try { return ok(action()); } catch (error) {
    const product = AppErrorSchema.safeParse(error);
    return product.success ? fail(product.data) : fail(appError(code, ...errorFacts(code)));
  }
}
export function errorFacts(code: ResourceErrorCode): [import('@flowmate/contracts').ErrorCategory, string, boolean] {
  const [category, retryable] = CONTEXT_ERROR_FACTS[code]!;
  return [category, 'Managed resource files could not be verified.', retryable];
}
export function directory(path: string) {
  const info = lstatSync(path);
  if (!info.isDirectory() || info.isSymbolicLink() || !samePath(resolve(path), realpathSync(path)))
    reject('resource_file_unavailable', 'Managed resource directories cannot be links or aliases.');
}
export function safePath(root: string, path: string, checkedDirectories?: Set<string>): string {
  const verifyDirectory = (path: string) => {
    if (checkedDirectories?.has(path)) return;
    directory(path); checkedDirectories?.add(path);
  };
  verifyDirectory(root);
  const target = resolve(root, path), rel = relative(root, target);
  if (!rel || rel === '..' || rel.startsWith(`..${sep}`) || isAbsolute(rel))
    reject('resource_file_unavailable', 'Resource file lies outside its registered root.');
  let current = root;
  for (const part of rel.split(sep).slice(0, -1)) { current = join(current, part); verifyDirectory(current); }
  const info = lstatSync(target);
  if (!info.isFile() || info.isSymbolicLink() || !samePath(target, realpathSync(target)))
    reject('resource_file_unavailable', 'Resource content must be an ordinary registered file.');
  return target;
}
export function bytes(path: string, maximum: number): Buffer {
  const info = lstatSync(path);
  if (!info.isFile() || info.isSymbolicLink()) reject('resource_file_unavailable', 'Resource content must be an ordinary file.');
  if (info.size > maximum) reject('resource_content_too_large', 'Resource content exceeds its byte budget.');
  const fd = openSync(path, 'r');
  try {
    const before = fstatSync(fd);
    if (before.ino !== info.ino || before.dev !== info.dev || before.size !== info.size)
      reject('resource_version_changed', 'Resource changed while it was being opened.');
    const data = Buffer.alloc(info.size + 1);
    let size = 0;
    while (size < data.length) {
      const count = readSync(fd, data, size, data.length - size, null);
      if (!count) break; size += count;
    }
    const after = fstatSync(fd), current = lstatSync(path);
    if (size !== info.size || after.size !== info.size || after.mtimeMs !== before.mtimeMs
      || current.ino !== info.ino || current.dev !== info.dev || current.isSymbolicLink())
      reject('resource_version_changed', 'Resource changed during its bounded read.');
    return data.subarray(0, size);
  } finally { closeSync(fd); }
}
export function writeSynced(path: string, content: string | Uint8Array) {
  const fd = openSync(path, 'wx', 0o600);
  try { writeFileSync(fd, content); fsyncSync(fd); } finally { closeSync(fd); }
}

export function page(input: ResourceFileRequest, ref: ResourceRef, content: Buffer): ResourceFilePage {
  const text = decoder.decode(content); // Binary or invalid UTF-8 is never replaced with a guessed preview.
  if (/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(text))
    reject('resource_file_unavailable', 'Resource content must be UTF-8 text without binary control characters.');
  const offset = input.offset ?? 0, limit = input.limit ?? RESOURCE_LIMITS.pageBytes;
  if (offset > content.length || offset < content.length && (content[offset]! & 0xc0) === 0x80)
    reject('resource_file_unavailable', 'Text offset must be an existing UTF-8 character boundary.');
  let end = Math.min(content.length, offset + limit);
  while (end < content.length && (content[end]! & 0xc0) === 0x80) end--;
  return { ref, path: input.path, offset, text: end === content.length && offset === 0 ? text : decoder.decode(content.subarray(offset, end)),
    nextOffset: end === content.length ? null : end, totalBytes: content.length };
}
