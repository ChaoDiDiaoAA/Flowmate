import { createReadStream } from 'node:fs';
import { lstat, mkdir, open, readFile, rename, stat, unlink, writeFile } from 'node:fs/promises';
import { basename, dirname, join, relative, resolve, sep } from 'node:path';
import type { ArtifactDraft, ControlledFileStore } from '../../../contracts/src/ports.ts';
import { productError } from '../../../contracts/src/errors.ts';
import { sha256Bytes, sha256Text } from '../../../shared/src/index.ts';

const WINDOWS_DEVICE = /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\..*)?$/i;

export type FileStoreFaultPoint = 'after-stage-write' | 'before-content-finalize';

export interface FileStoreFaultInput {
  workspaceId: string;
  kind: string;
  sha256: string;
  sizeBytes: number;
  relativePath: string;
}

export type FileStoreFaultInjector = (point: FileStoreFaultPoint, input: FileStoreFaultInput) => void;

export interface FileStoreOptions {
  sourceRoot: string;
  instanceRoot: string;
  maxFileBytes?: number;
  /** Test-only seam; production composition leaves it undefined. */
  faultInjector?: FileStoreFaultInjector;
  /** Test-only observation immediately before a verified read touches file bytes. */
  observeRead?: (absolutePath: string) => void;
}

export class InstanceFileStore implements ControlledFileStore {
  readonly sourceRoot: string;
  readonly instanceRoot: string;
  readonly maxFileBytes: number;
  private readonly faultInjector?: FileStoreOptions['faultInjector'];
  private readonly observeRead?: FileStoreOptions['observeRead'];

  constructor(options: FileStoreOptions) {
    this.sourceRoot = resolve(options.sourceRoot);
    this.instanceRoot = resolve(options.instanceRoot);
    this.maxFileBytes = options.maxFileBytes ?? 67_108_864;
    this.faultInjector = options.faultInjector;
    this.observeRead = options.observeRead;
  }

  async prepare(): Promise<void> {
    await mkdir(join(this.instanceRoot, 'artifacts'), { recursive: true });
    await mkdir(join(this.instanceRoot, 'staging'), { recursive: true });
    await mkdir(join(this.instanceRoot, 'logs'), { recursive: true });
  }

  async readVerified(input: {
    root: 'source' | 'instance';
    relativePath: string;
    expectedSha256: string;
    expectedBytes: number;
    maxBytes: number;
  }): Promise<Uint8Array> {
    const root = input.root === 'source' ? this.sourceRoot : this.instanceRoot;
    const path = await this.resolveSafe(root, input.relativePath);
    let info;
    try {
      info = await stat(path);
    } catch (error) {
      throw productError({ code: 'FILE_MISSING', category: 'input', source: { component: 'file-store', operation: 'readVerified' }, safeMessage: 'A required input file is missing or unreadable', impactScope: 'call', recoveryAction: 'correct_input', correlation: {} }, { cause: error as Error });
    }
    if (!info.isFile() || info.size !== input.expectedBytes || info.size > Math.min(input.maxBytes, this.maxFileBytes)) {
      throw productError({ code: info.size > Math.min(input.maxBytes, this.maxFileBytes) ? 'INPUT_LIMIT_EXCEEDED' : 'FILE_DIGEST_MISMATCH', category: 'input', source: { component: 'file-store', operation: 'readVerified' }, safeMessage: 'The input file does not match its approved descriptor', impactScope: 'call', recoveryAction: 'correct_input', correlation: {} });
    }
    this.observeRead?.(path);
    const bytes = await readFile(path);
    if (bytes.byteLength !== input.expectedBytes || sha256Bytes(bytes) !== input.expectedSha256) {
      throw productError({ code: 'FILE_DIGEST_MISMATCH', category: 'input', source: { component: 'file-store', operation: 'readVerified' }, safeMessage: 'The input file digest does not match its approved descriptor', impactScope: 'call', recoveryAction: 'correct_input', correlation: {} });
    }
    return bytes;
  }

  async saveImmutable(input: {
    workspaceId: string;
    kind: string;
    bytes: Uint8Array;
    sha256: string;
    mediaType: string;
    sourceRef: string;
  }): Promise<ArtifactDraft> {
    if (input.bytes.byteLength > this.maxFileBytes) {
      throw productError({ code: 'INPUT_LIMIT_EXCEEDED', category: 'input', source: { component: 'file-store', operation: 'saveImmutable' }, safeMessage: 'The content exceeds the configured file limit', impactScope: 'call', recoveryAction: 'correct_input', correlation: {} });
    }
    if (sha256Bytes(input.bytes) !== input.sha256) {
      throw productError({ code: 'FILE_DIGEST_MISMATCH', category: 'input', source: { component: 'file-store', operation: 'saveImmutable' }, safeMessage: 'The content does not match the declared digest', impactScope: 'call', recoveryAction: 'correct_input', correlation: {} });
    }
    const relativePath = join('artifacts', input.workspaceId, input.sha256.slice(0, 2), input.sha256).replaceAll('\\', '/');
    // Only the final artifact is immutable. Create its parent directories after
    // checking each existing component for links or reparse points.
    const parentRelative = dirname(relativePath).replaceAll('\\', '/');
    const parent = await this.resolveSafe(this.instanceRoot, parentRelative, true);
    await mkdir(parent, { recursive: true });
    const target = await this.resolveSafe(this.instanceRoot, relativePath, true);
    try {
      const existing = await readFile(target);
      if (sha256Bytes(existing) !== input.sha256 || existing.byteLength !== input.bytes.byteLength) {
        throw productError({ code: 'IMMUTABLE_ARTIFACT_CONFLICT', category: 'storage', source: { component: 'file-store', operation: 'saveImmutable' }, safeMessage: 'An immutable artifact path contains different bytes', impactScope: 'instance', recoveryAction: 'manual_review', correlation: {} });
      }
    } catch (error) {
      if (!(error instanceof Error && 'code' in error && (error as NodeJS.ErrnoException).code === 'ENOENT')) throw error;
      const temporary = join(this.instanceRoot, 'staging', `${crypto.randomUUID()}.tmp`);
      await writeFile(temporary, input.bytes, { flag: 'wx' });
      try {
        const faultInput: FileStoreFaultInput = { workspaceId: input.workspaceId, kind: input.kind, sha256: input.sha256, sizeBytes: input.bytes.byteLength, relativePath };
        this.faultInjector?.('after-stage-write', faultInput);
        this.faultInjector?.('before-content-finalize', faultInput);
        await rename(temporary, target);
      } catch (renameError) {
        try { await unlink(temporary); } catch { /* best effort; primary error remains */ }
        try {
          const existing = await readFile(target);
          if (sha256Bytes(existing) !== input.sha256) throw renameError;
        } catch { throw renameError; }
      }
    }
    const artifactId = `a_${sha256Text(`${input.workspaceId}|${input.kind}|${input.sha256}`).slice(0, 48)}`;
    return { artifactId, workspaceId: input.workspaceId, kind: input.kind, storageRoot: 'instance', relativePath, sha256: input.sha256, sizeBytes: input.bytes.byteLength, mimeType: input.mediaType, sourceRef: input.sourceRef };
  }

  async readInstanceArtifact(relativePath: string, expectedSha256: string, expectedBytes: number, maxBytes: number): Promise<Uint8Array> {
    return this.readVerified({ root: 'instance', relativePath, expectedSha256, expectedBytes, maxBytes });
  }

  private async resolveSafe(root: string, relativePath: string, allowMissingLeaf = false): Promise<string> {
    const normalized = validateRelativePath(relativePath);
    const candidate = resolve(root, normalized);
    const rootResolved = resolve(root);
    // Check the approved root and its ancestors as well as the relative suffix.
    // A real leaf directory below a junction must not bypass the path boundary.
    await assertNoLinkedAncestors(rootResolved);
    const rel = relative(rootResolved, candidate);
    if (rel === '..' || rel.startsWith(`..${sep}`) || resolve(rootResolved, rel) !== candidate) {
      throw productError({ code: 'PATH_FORBIDDEN', category: 'authorization', source: { component: 'file-store', operation: 'resolvePath' }, safeMessage: 'The requested path is outside the approved root', impactScope: 'call', recoveryAction: 'correct_input', correlation: {} });
    }
    const parts = normalized.split('/');
    let current = rootResolved;
    for (let index = 0; index < parts.length; index += 1) {
      current = join(current, parts[index]);
      try {
        const entry = await lstat(current);
        const attrs = (entry as unknown as { st_file_attributes?: number }).st_file_attributes ?? 0;
        if (entry.isSymbolicLink() || (attrs & 0x400) !== 0) {
          throw productError({ code: 'REPARSE_POINT_DENIED', category: 'authorization', source: { component: 'file-store', operation: 'resolvePath' }, safeMessage: 'Links and reparse points are not allowed in an approved path', impactScope: 'call', recoveryAction: 'correct_input', correlation: {} });
        }
      } catch (error) {
        if (allowMissingLeaf && error instanceof Error && 'code' in error && (error as NodeJS.ErrnoException).code === 'ENOENT') break;
        if (error instanceof Error && 'code' in error && (error as NodeJS.ErrnoException).code === 'ENOENT') throw productError({ code: 'FILE_MISSING', category: 'input', source: { component: 'file-store', operation: 'resolvePath' }, safeMessage: 'A required path is missing', impactScope: 'call', recoveryAction: 'correct_input', correlation: {} }, { cause: error });
        throw error;
      }
    }
    return candidate;
  }
}

export async function assertNoLinkedAncestors(path: string): Promise<void> {
  let current = resolve(path);
  while (true) {
    try {
      if ((await lstat(current)).isSymbolicLink()) throw productError({ code: 'REPARSE_POINT_DENIED', category: 'authorization', source: { component: 'file-store', operation: 'resolvePath' }, safeMessage: 'Approved paths and their ancestors cannot be links', impactScope: 'call', recoveryAction: 'correct_input', correlation: {} });
    } catch (error) {
      if (!(error instanceof Error && 'code' in error && (error as NodeJS.ErrnoException).code === 'ENOENT')) throw error;
    }
    const parent = dirname(current);
    if (parent === current) return;
    current = parent;
  }
}

export function validateRelativePath(value: string): string {
  if (!value || value.includes('\\') || value.includes('\0') || value.startsWith('/') || /^[A-Za-z]:/.test(value) || value.startsWith('//')) {
    throw productError({ code: 'PATH_FORBIDDEN', category: 'authorization', source: { component: 'file-store', operation: 'validateRelativePath' }, safeMessage: 'Only approved relative paths are allowed', impactScope: 'call', recoveryAction: 'correct_input', correlation: {} });
  }
  const parts = value.split('/');
  if (parts.some((part) => !part || part === '.' || part === '..' || part.endsWith(' ') || part.endsWith('.') || WINDOWS_DEVICE.test(part) || part.includes(':'))) {
    throw productError({ code: 'PATH_FORBIDDEN', category: 'authorization', source: { component: 'file-store', operation: 'validateRelativePath' }, safeMessage: 'The path contains a forbidden component', impactScope: 'call', recoveryAction: 'correct_input', correlation: {} });
  }
  return parts.join('/');
}
