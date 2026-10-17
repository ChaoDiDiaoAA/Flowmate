import { closeSync, fstatSync, lstatSync, openSync, readSync, realpathSync, readdirSync } from 'node:fs';
import { basename, dirname, isAbsolute, relative, resolve, sep } from 'node:path';
import { appError, fail, ok } from '@flowmate/contracts';
import type { Result } from '@flowmate/contracts';

const MAX_ORIGINAL_BYTES = 10 * 1024 * 1024;
const MAX_JSON_BYTES = 2 * 1024 * 1024;
const MAX_METADATA_BYTES = 64 * 1024;

export type Voxel51Files = {
  originalFileName: 'original.jpg' | 'original.png';
  originalMimeType: 'image/jpeg' | 'image/png';
  originalBytes: Uint8Array;
  contentBytes: Uint8Array;
  pagesBytes: Uint8Array;
  metadataBytes: Uint8Array;
  metadata: unknown;
  content: unknown;
  pages: unknown;
};

function within(root: string, target: string): boolean {
  const rel = relative(resolve(root), resolve(target));
  return rel === '' || (rel !== '..' && !rel.startsWith(`..${sep}`) && !isAbsolute(rel));
}

function samePath(left: string, right: string): boolean {
  const a = resolve(left);
  const b = resolve(right);
  return process.platform === 'win32' ? a.toLowerCase() === b.toLowerCase() : a === b;
}

function readBoundedFile(root: string, name: string, limit: number): Result<Uint8Array> {
  const path = resolve(root, name);
  let fd: number | undefined;
  try {
    const info = lstatSync(path);
    const realPath = realpathSync(path);
    if (info.isSymbolicLink() || !info.isFile() || dirname(path) !== root || !within(root, realPath)) {
      return fail(appError('source_invalid', 'input', '来源文件必须是样本目录内的普通文件。'));
    }
    fd = openSync(realPath, 'r');
    const before = fstatSync(fd);
    if (!before.isFile() || before.size < 1) return fail(appError('source_invalid', 'input', '来源文件为空或类型无效。'));
    if (before.size > limit) return fail(appError('source_too_large', 'input', '来源文件超过首版大小限制。'));
    const bytes = Buffer.allocUnsafe(before.size);
    let offset = 0;
    while (offset < bytes.length) {
      const count = readSync(fd, bytes, offset, bytes.length - offset, offset);
      if (count === 0) break;
      offset += count;
    }
    const extra = Buffer.allocUnsafe(1);
    const grew = readSync(fd, extra, 0, 1, offset) > 0;
    const after = fstatSync(fd);
    if (offset !== before.size || grew || after.size !== before.size || after.mtimeMs !== before.mtimeMs) {
      return fail(appError('source_unstable', 'input', '来源文件读取期间发生变化。', true));
    }
    return ok(bytes.subarray(0, offset));
  } catch (error) {
    if (error && typeof error === 'object' && 'code' in error && error.code === 'ENOENT') {
      return fail(appError('source_invalid', 'input', '来源缺少必需文件。'));
    }
    return fail(appError('input_unavailable', 'input', '来源文件当前不可读取。', true));
  } finally {
    if (fd !== undefined) { try { closeSync(fd); } catch { /* preserve the read result */ } }
  }
}

function fileListingMatches(metadata: unknown, expected: Array<{ name: string; bytes: number }>, strict = false): boolean {
  if (!metadata || typeof metadata !== 'object' || Array.isArray(metadata)) return false;
  const files = (metadata as Record<string, unknown>).files;
  if (!Array.isArray(files) || strict && files.length !== expected.length) return false;
  const listed = new Map<string, number>();
  for (const item of files) {
    if (!item || typeof item !== 'object' || Array.isArray(item)) return false;
    const record = item as Record<string, unknown>;
    if (typeof record.path !== 'string' || !Number.isSafeInteger(record.bytes) || Number(record.bytes) <= 0
      || strict && Object.keys(record).sort().join(',') !== 'bytes,path') return false;
    const name = strict ? record.path : basename(record.path);
    if (listed.has(name)) return false;
    listed.set(name, Number(record.bytes));
  }
  return expected.every(({ name, bytes }) => listed.get(name) === bytes);
}

function formalMetadataMatches(metadata: unknown, sampleId: string): boolean {
  if (!metadata || typeof metadata !== 'object' || Array.isArray(metadata)) return false;
  const record = metadata as Record<string, unknown>;
  const expectedKeys = ['allowedUsesClaim', 'datasetId', 'datasetRevision', 'files', 'licenseVerification',
    'qualityStatus', 'sampleId', 'schemaVersion', 'sourceRecordId'].sort();
  return Object.keys(record).sort().join(',') === expectedKeys.join(',') && record.schemaVersion === 1
    && record.sampleId === sampleId && typeof record.datasetId === 'string' && record.datasetId.length > 0;
}

function imageDimensions(bytes: Uint8Array, extension: '.jpg' | '.png'): { width: number; height: number } | null {
  const data = Buffer.from(bytes);
  let dimensions: { width: number; height: number } | null = null;
  if (extension === '.png' && data.length >= 24
    && data.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))
    && data.toString('ascii', 12, 16) === 'IHDR') {
    dimensions = { width: data.readUInt32BE(16), height: data.readUInt32BE(20) };
  } else if (extension === '.jpg' && data.length >= 4 && data[0] === 0xff && data[1] === 0xd8) {
    let offset = 2;
    while (offset + 4 <= data.length) {
      if (data[offset] !== 0xff) return null;
      while (data[offset] === 0xff) offset += 1;
      const marker = data[offset++];
      if (marker === 0xd9 || marker === 0xda) break;
      if (marker === 0x01 || marker >= 0xd0 && marker <= 0xd7) continue;
      if (offset + 2 > data.length) return null;
      const length = data.readUInt16BE(offset);
      if (length < 2 || offset + length > data.length) return null;
      if ([0xc0, 0xc1, 0xc2, 0xc3, 0xc5, 0xc6, 0xc7, 0xc9, 0xca, 0xcb, 0xcd, 0xce, 0xcf].includes(marker)) {
        if (length < 7) return null;
        dimensions = { height: data.readUInt16BE(offset + 3), width: data.readUInt16BE(offset + 5) };
        break;
      }
      offset += length;
    }
  }
  if (!dimensions || dimensions.width < 1 || dimensions.height < 1
    || dimensions.width > 20_000 || dimensions.height > 20_000
    || dimensions.width * dimensions.height > 200_000_000) return null;
  return dimensions;
}

function parseJson(bytes: Uint8Array): unknown {
  return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes)) as unknown;
}

export function isSupportedOriginal(bytes: Uint8Array, fileName: string): boolean {
  return (fileName.endsWith('.jpg') || fileName.endsWith('.png'))
    && imageDimensions(bytes, fileName.endsWith('.jpg') ? '.jpg' : '.png') !== null;
}

export function readVoxel51Files(sourceDirectory: string, productRoot: string, signal?: AbortSignal,
  allowedSourceRoot?: string): Result<Voxel51Files> {
  if (signal?.aborted) return fail(appError('operation_cancelled', 'runtime', '材料导入已取消。'));
  let directory: string;
  let canonicalAllowedRoot: string | undefined;
  try {
    if (!sourceDirectory || typeof sourceDirectory !== 'string') throw new Error('invalid_source_directory');
    const supplied = resolve(sourceDirectory);
    const info = lstatSync(supplied);
    if (info.isSymbolicLink() || !info.isDirectory()) throw new Error('invalid_source_directory');
    directory = realpathSync(supplied);
    const productDirectory = realpathSync(productRoot);
    // Installed intake is explicit staging, separate from managed artifacts and business state.
    if (within(productDirectory, directory) && (allowedSourceRoot === undefined
      || !samePath(allowedSourceRoot, resolve(productDirectory, 'imports/invoices')))) throw new Error('product_root_not_source');
  } catch {
    return fail(appError('source_invalid', 'input', '来源目录无效或位于产品受管目录内。'));
  }
  if (allowedSourceRoot !== undefined) {
    try {
      const suppliedRoot = resolve(allowedSourceRoot);
      const rootInfo = lstatSync(suppliedRoot);
      if (rootInfo.isSymbolicLink() || !rootInfo.isDirectory()) throw new Error('invalid_invoice_source_root');
      canonicalAllowedRoot = realpathSync(suppliedRoot);
      if (!samePath(suppliedRoot, canonicalAllowedRoot)) throw new Error('invoice_source_root_linked');
    } catch (error) {
      if (error && typeof error === 'object' && 'code' in error && error.code === 'ENOENT') {
        return fail(appError('input_unavailable', 'input', '正式发票材料目录当前不可用。', true));
      }
      return fail(appError('source_invalid', 'input', '正式发票材料目录无效。'));
    }
    if (!samePath(resolve(sourceDirectory), directory) || !within(canonicalAllowedRoot, directory)
      || !samePath(dirname(directory), canonicalAllowedRoot) || !/^\d{6}$/.test(basename(directory))) {
      return fail(appError('source_invalid', 'input', '只能导入正式目录中的直接样本子目录。'));
    }
  }
  const jpg = existsOriginal(directory, 'original.jpg');
  const png = existsOriginal(directory, 'original.png');
  if (jpg === png) return fail(appError('source_invalid', 'input', '来源必须恰有一个 original.jpg 或 original.png。'));
  const originalFileName = jpg ? 'original.jpg' : 'original.png';
  if (canonicalAllowedRoot !== undefined) {
    const expectedNames = [originalFileName, 'content.json', 'pages.json', 'metadata.json'].sort();
    const entries = readdirSync(directory, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name, 'en'));
    if (entries.length !== expectedNames.length || entries.some((entry, index) => entry.name !== expectedNames[index]
      || !entry.isFile() || entry.isSymbolicLink())) {
      return fail(appError('source_invalid', 'input', '正式样本目录必须只包含白名单中的四个普通文件。'));
    }
  }
  const originalBytes = readBoundedFile(directory, originalFileName, MAX_ORIGINAL_BYTES);
  if (!originalBytes.ok) return originalBytes;
  if (!isSupportedOriginal(originalBytes.data, originalFileName)) return fail(appError('source_invalid', 'input', '原图格式或尺寸无效。'));
  if (signal?.aborted) return fail(appError('operation_cancelled', 'runtime', '材料导入已取消。'));
  const contentBytes = readBoundedFile(directory, 'content.json', MAX_JSON_BYTES);
  if (!contentBytes.ok) return contentBytes;
  if (signal?.aborted) return fail(appError('operation_cancelled', 'runtime', '材料导入已取消。'));
  const pagesBytes = readBoundedFile(directory, 'pages.json', MAX_JSON_BYTES);
  if (!pagesBytes.ok) return pagesBytes;
  if (signal?.aborted) return fail(appError('operation_cancelled', 'runtime', '材料导入已取消。'));
  const metadataBytes = readBoundedFile(directory, 'metadata.json', MAX_METADATA_BYTES);
  if (!metadataBytes.ok) return metadataBytes;
  if (signal?.aborted) return fail(appError('operation_cancelled', 'runtime', '材料导入已取消。'));
  let metadata: unknown;
  let content: unknown;
  let pages: unknown;
  try {
    metadata = parseJson(metadataBytes.data);
    content = parseJson(contentBytes.data);
    pages = parseJson(pagesBytes.data);
  } catch {
    return fail(appError('source_invalid', 'input', '来源 JSON 格式无效。'));
  }
  if (canonicalAllowedRoot !== undefined && !formalMetadataMatches(metadata, basename(directory))) {
    return fail(appError('source_invalid', 'input', '正式样本元数据不符合精简白名单。'));
  }
  if (!fileListingMatches(metadata, [
    { name: originalFileName, bytes: originalBytes.data.byteLength },
    { name: 'content.json', bytes: contentBytes.data.byteLength },
    { name: 'pages.json', bytes: pagesBytes.data.byteLength },
  ], canonicalAllowedRoot !== undefined)) return fail(appError('source_invalid', 'input', '来源文件清单与实际文件不一致。'));
  return ok({ originalFileName, originalMimeType: jpg ? 'image/jpeg' : 'image/png',
    originalBytes: originalBytes.data, contentBytes: contentBytes.data, pagesBytes: pagesBytes.data,
    metadataBytes: metadataBytes.data, metadata, content, pages });
}

function existsOriginal(directory: string, name: string): boolean {
  try { return lstatSync(resolve(directory, name)).isFile(); }
  catch { return false; }
}
