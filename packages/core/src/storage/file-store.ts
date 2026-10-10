import { existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, renameSync, rmSync, rmdirSync, writeFileSync, linkSync } from 'node:fs';
import { createHash, randomUUID } from 'node:crypto';
import type { Dirent } from 'node:fs';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { appError, fail, ok } from '@flowmate/contracts';
import type { DbId, ProductPaths, Result, ExportInvoiceCandidateRequest, InvoiceExportReference, SourceSnapshot } from '@flowmate/contracts';
import type { DocumentRepository, StoredArtifact } from './repositories.ts';

export type ArtifactPayload = {
  kind: 'original' | 'parsed';
  primaryName: string;
  files: Array<{ name: string; bytes: Uint8Array; mimeType: string }>;
};

export type PublishedArtifact = StoredArtifact & { createdAt: string };
export type PublishedArtifactPair = { documentId: DbId; original: PublishedArtifact; parsed: PublishedArtifact };

export type PublishArtifactInput = {
  sourceKey: string;
  sourceRecordId: string;
  sourceVersion: string;
  original: ArtifactPayload;
  parsed: ArtifactPayload;
  at: string;
};

type Manifest = {
  version: 1;
  sourceKey: string;
  sourceRecordId: string;
  sourceVersion: string;
  kind: 'original' | 'parsed';
  files: Array<{ name: string; bytes: number; mimeType: string }>;
};

function within(root: string, target: string): boolean {
  const rel = relative(resolve(root), resolve(target));
  return rel === '' || (rel !== '..' && !rel.startsWith(`..${sep}`) && !isAbsolute(rel));
}

function jsonBytes(value: unknown): Uint8Array { return Buffer.from(JSON.stringify(value), 'utf8'); }
function decodeManifest(path: string): Manifest | null {
  try {
    const stat = lstatSync(path);
    if (!stat.isFile() || stat.size > 64 * 1024) return null;
    const value = JSON.parse(readFileSync(path, 'utf8')) as unknown;
    if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
    const item = value as Record<string, unknown>;
    if (item.version !== 1 || typeof item.sourceKey !== 'string' || typeof item.sourceRecordId !== 'string'
      || typeof item.sourceVersion !== 'string' || !['original', 'parsed'].includes(String(item.kind))
      || !Array.isArray(item.files)) return null;
    const files = item.files.map((entry) => {
      if (!entry || typeof entry !== 'object' || Array.isArray(entry)) throw new Error('invalid_manifest');
      const file = entry as Record<string, unknown>;
      if (typeof file.name !== 'string' || typeof file.mimeType !== 'string'
        || !Number.isSafeInteger(file.bytes) || Number(file.bytes) <= 0) throw new Error('invalid_manifest');
      return { name: file.name, bytes: Number(file.bytes), mimeType: file.mimeType };
    });
    return { version: 1, sourceKey: item.sourceKey, sourceRecordId: item.sourceRecordId,
      sourceVersion: item.sourceVersion, kind: item.kind as Manifest['kind'], files };
  } catch { return null; }
}

function fileMime(name: string): string {
  if (name.endsWith('.jpg')) return 'image/jpeg';
  if (name.endsWith('.png')) return 'image/png';
  return 'application/json';
}

function validArtifactName(name: string): boolean {
  return ['original.jpg', 'original.png', 'parsed.json', 'raw-content.json', 'raw-pages.json', 'source.json', 'source.txt', 'source.md'].includes(name);
}

function invoiceExportPath(paths: Pick<ProductPaths, 'root' | 'outputsDir'>, relativePath: string): string {
  if (!/^outputs\/invoice-[1-9]\d*-result-[1-9]\d*\.(json|csv|md)$/.test(relativePath)) throw new Error('invalid_export_path');
  const outputRoot = resolve(paths.outputsDir);
  if (!within(paths.root, outputRoot) || lstatSync(outputRoot).isSymbolicLink()
    || !lstatSync(outputRoot).isDirectory() || relative(outputRoot, realpathSync(outputRoot)) !== '') throw new Error('invalid_export_root');
  const target = join(outputRoot, relativePath.slice('outputs/'.length));
  if (!within(outputRoot, target)) throw new Error('invalid_export_target');
  return target;
}

export function readManagedInvoiceExport(paths: Pick<ProductPaths, 'root' | 'outputsDir'>, reference: InvoiceExportReference): Result<Uint8Array> {
  try {
    if (!/^[0-9a-f]{64}$/.test(reference.sha256) || !Number.isSafeInteger(reference.bytes) || reference.bytes < 1
      || reference.bytes > 64 * 1024 * 1024) throw new Error('invalid_export_reference');
    const path = invoiceExportPath(paths, reference.relativePath);
    const stat = lstatSync(path);
    if (!stat.isFile() || stat.isSymbolicLink() || stat.size !== reference.bytes) throw new Error('invalid_export_file');
    const bytes = readFileSync(path);
    if (bytes.length !== reference.bytes || createHash('sha256').update(bytes).digest('hex') !== reference.sha256) throw new Error('export_hash_mismatch');
    return ok(bytes);
  } catch { return fail(appError('artifact_unavailable', 'storage', '已导出文件缺失或变化，需按原事实核对。')); }
}

export class FileStore {
  private tail: Promise<void> = Promise.resolve();
  private readonly root: string;
  private readonly artifactRoot: string;

  public constructor(private readonly paths: ProductPaths, private readonly documents: DocumentRepository) {
    this.root = resolve(paths.root);
    this.artifactRoot = resolve(paths.artifactsDir);
  }

  public publishResearchSource(input: { researchId: number; text: string }): Result<Pick<SourceSnapshot, 'relativePath' | 'contentHash' | 'bytes' | 'characters'>> {
    const bytes = Buffer.from(input.text, 'utf8');
    if (!Number.isSafeInteger(input.researchId) || input.researchId < 1 || bytes.length < 1 || bytes.length > 2_000_000
      || new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes) !== input.text) return fail(appError('input_invalid', 'input', 'Research source body is invalid.'));
    const contentHash = createHash('sha256').update(bytes).digest('hex');
    const value = { relativePath: `artifacts/research/${input.researchId}/${contentHash}.txt`, contentHash, bytes: bytes.length, characters: input.text.length };
    let temporary: string | null = null;
    try {
      const target = this.researchSourcePath(input.researchId, contentHash, true);
      if (existsSync(target)) return this.readResearchSource({ ...value, researchId: input.researchId }).ok
        ? ok(value) : fail(appError('research_source_conflict', 'storage', 'Existing research evidence cannot be overwritten.'));
      temporary = join(dirname(target), `.research-source-${randomUUID()}.tmp`);
      writeFileSync(temporary, bytes, { flag: 'wx' });
      if (!readFileSync(temporary).equals(bytes)) throw new Error('research_publish_check');
      try { linkSync(temporary, target); }
      catch (error) { if (!(error instanceof Error && 'code' in error && error.code === 'EEXIST')) throw error; }
      return this.readResearchSource({ ...value, researchId: input.researchId }).ok ? ok(value)
        : fail(appError('research_source_conflict', 'storage', 'Published research evidence differs from its receipt.'));
    } catch { return fail(appError('storage_write_failed', 'storage', 'Research evidence publication failed.', true)); }
    finally { if (temporary) try { rmSync(temporary); } catch { /* keep the publication result */ } }
  }

  public publishResearchMaterial(input: { title: string; format: 'text' | 'markdown'; text: string; at: string }): Result<PublishedArtifact> {
    const bytes = Buffer.from(input.text, 'utf8'), name = input.format === 'markdown' ? 'source.md' : 'source.txt';
    if (bytes.length < 1 || bytes.length > 2_000_000 || bytes.toString('utf8') !== input.text) return fail(appError('input_invalid', 'input', 'Selected text is invalid.'));
    let staging: string | null = null;
    try {
      if (!within(realpathSync(this.root), this.artifactRoot) || lstatSync(this.artifactRoot).isSymbolicLink()
        || realpathSync(this.artifactRoot) !== this.artifactRoot) throw new Error('research_material_root');
      const known = this.documents.listArtifactIds(); if (!known.ok) return known;
      const occupied = new Set([...known.data, ...readdirSync(this.artifactRoot).filter(value => /^[1-9]\d*$/.test(value)).map(Number)]);
      let artifactId = 1; while (occupied.has(artifactId)) artifactId++;
      if (!Number.isSafeInteger(artifactId)) throw new Error('artifact_id_exhausted');
      const mimeType = input.format === 'markdown' ? 'text/markdown' : 'text/plain';
      const metadata = { version: 1 as const, sourceKey: 'research-local-v1', sourceRecordId: input.title,
        sourceVersion: createHash('sha256').update(bytes).digest('hex'), files: [{ relativePath: name, bytes: bytes.length, mimeType }] };
      staging = mkdtempSync(join(this.artifactRoot, '.research-material-'));
      writeFileSync(join(staging, name), bytes, { flag: 'wx' });
      writeFileSync(join(staging, 'manifest.json'), jsonBytes({ ...metadata, kind: 'original', files: [{ name, bytes: bytes.length, mimeType }] }), { flag: 'wx' });
      if (!readFileSync(join(staging, name)).equals(bytes)) throw new Error('research_material_publication');
      renameSync(staging, join(this.artifactRoot, String(artifactId))); staging = null;
      return ok({ artifactId, kind: 'original', relativePath: `artifacts/${artifactId}/${name}`, bytes: bytes.length, mimeType, metadata, createdAt: input.at });
    } catch { return fail(appError('storage_write_failed', 'storage', 'Research material publication failed.', true)); }
    finally {
      if (staging) try { for (const name of ['source.md', 'source.txt', 'manifest.json']) if (existsSync(join(staging, name))) rmSync(join(staging, name)); rmdirSync(staging); }
      catch { /* keep owned staging for inspection */ }
    }
  }

  public readResearchSource(reference: Pick<SourceSnapshot, 'researchId' | 'relativePath' | 'contentHash' | 'bytes' | 'characters'>): Result<string> {
    try {
      if (reference.relativePath !== `artifacts/research/${reference.researchId}/${reference.contentHash}.txt`
        || !Number.isSafeInteger(reference.bytes) || reference.bytes < 1 || reference.bytes > 2_000_000) throw new Error('research_source_reference');
      const path = this.researchSourcePath(reference.researchId, reference.contentHash, false), stat = lstatSync(path);
      if (!stat.isFile() || stat.isSymbolicLink() || stat.size !== reference.bytes) throw new Error('research_source_file');
      const bytes = readFileSync(path);
      if (bytes.length !== reference.bytes || createHash('sha256').update(bytes).digest('hex') !== reference.contentHash) throw new Error('research_source_hash');
      const text = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes);
      if (text.length !== reference.characters) throw new Error('research_source_characters');
      return ok(text);
    } catch { return fail(appError('research_source_unavailable', 'tool', 'Saved research evidence is missing or changed.')); }
  }

  private researchSourcePath(researchId: number, hash: string, create: boolean): string {
    if (!Number.isSafeInteger(researchId) || researchId < 1 || !/^[0-9a-f]{64}$/.test(hash)) throw new Error('research_source_reference');
    const root = realpathSync(this.root);
    for (const directory of [this.artifactRoot, join(this.artifactRoot, 'research'), join(this.artifactRoot, 'research', String(researchId))]) {
      if (!within(root, directory)) throw new Error('research_source_directory');
      if (create && !existsSync(directory)) mkdirSync(directory);
      const stat = lstatSync(directory);
      if (!stat.isDirectory() || stat.isSymbolicLink() || !within(root, directory) || realpathSync(directory) !== resolve(directory)) throw new Error('research_source_directory');
    }
    return join(this.artifactRoot, 'research', String(researchId), `${hash}.txt`);
  }

  public publishInvoiceExport(input: { candidateId: DbId; jobId: DbId; sequence: number;
    format: ExportInvoiceCandidateRequest['format']; bytes: Uint8Array }): Result<{ relativePath: string; bytes: number; sha256: string }> {
    if (![input.candidateId, input.jobId, input.sequence].every(value => Number.isSafeInteger(value) && value > 0)
      || !['json', 'csv', 'markdown'].includes(input.format) || input.bytes.byteLength < 1 || input.bytes.byteLength > 64 * 1024 * 1024) {
      return fail(appError('input_invalid', 'input', '导出文件参数无效。'));
    }
    const relativePath = `outputs/invoice-${input.jobId}-result-${input.sequence}.${input.format === 'markdown' ? 'md' : input.format}`;
    let temporary: string | null = null;
    try {
      const target = this.invoiceExportPath(relativePath);
      const sha256 = createHash('sha256').update(input.bytes).digest('hex');
      if (existsSync(target)) {
        if (!lstatSync(target).isFile() || lstatSync(target).isSymbolicLink()
          || !Buffer.from(readFileSync(target)).equals(Buffer.from(input.bytes))) {
          return fail(appError('state_conflict', 'input', '导出目标存在不同内容，不能覆盖。'));
        }
        return ok({ relativePath, bytes: input.bytes.byteLength, sha256 });
      }
      temporary = join(dirname(target), `.invoice-export-${randomUUID()}.tmp`);
      writeFileSync(temporary, input.bytes, { flag: 'wx' });
      if (!Buffer.from(readFileSync(temporary)).equals(Buffer.from(input.bytes))) throw new Error('export_content_check_failed');
      // A same-directory hard link publishes the complete file atomically and
      // fails if another writer created the target, unlike rename-overwrite.
      try { linkSync(temporary, target); }
      catch (error) {
        if (!(error instanceof Error && 'code' in error && error.code === 'EEXIST')) throw error;
        if (!lstatSync(target).isFile() || lstatSync(target).isSymbolicLink()
          || !Buffer.from(readFileSync(target)).equals(Buffer.from(input.bytes))) {
          return fail(appError('state_conflict', 'input', '导出目标在发布期间变化，不能覆盖。'));
        }
      }
      return ok({ relativePath, bytes: input.bytes.byteLength, sha256 });
    } catch { return fail(appError('storage_write_failed', 'storage', '导出文件发布失败；已发布内容保留供核对。', true)); }
    finally { if (temporary !== null) try { rmSync(temporary); } catch { /* preserve publication result */ } }
  }

  public readInvoiceExport(reference: InvoiceExportReference): Result<Uint8Array> {
    return readManagedInvoiceExport(this.paths, reference);
  }

  private invoiceExportPath(relativePath: string): string {
    return invoiceExportPath(this.paths, relativePath);
  }

  public publish(input: PublishArtifactInput): Promise<Result<PublishedArtifactPair>> {
    const previous = this.tail;
    let release!: () => void;
    this.tail = new Promise<void>((resolveLock) => { release = resolveLock; });
    return previous.then(() => this.publishLocked(input)).catch(() =>
      fail(appError('artifact_publish_failed', 'storage', '受管文件发布失败。', true)),
    ).finally(release);
  }

  public read(artifact: StoredArtifact, fileName?: string): Result<Uint8Array> {
    let rootsVerified = false;
    let verifiedRoots: Array<{ path: string; real: string; dev: number; ino: number; ctimeMs: number }> = [];
    try {
      const root = realpathSync(this.root);
      const managedArtifactRoot = realpathSync(this.artifactRoot);
      if (!within(root, managedArtifactRoot)) throw new Error('path_outside_root');
      const rootInfo = lstatSync(root), artifactRootInfo = lstatSync(managedArtifactRoot);
      if (!rootInfo.isDirectory() || !artifactRootInfo.isDirectory()) throw new Error('managed_root_unavailable');
      verifiedRoots = [{ path: this.root, real: root, ...rootInfo }, { path: this.artifactRoot, real: managedArtifactRoot, ...artifactRootInfo }];
      rootsVerified = true;
      const artifactDirectory = resolve(this.root, dirname(artifact.relativePath));
      const expectedDirectory = resolve(this.artifactRoot, String(artifact.artifactId));
      if (!within(root, artifactDirectory) || artifactDirectory !== expectedDirectory) throw new Error('path_outside_root');
      const directory = realpathSync(artifactDirectory);
      if (!within(managedArtifactRoot, directory)) throw new Error('path_outside_root');
      const name = fileName ?? artifact.relativePath.slice(artifact.relativePath.lastIndexOf('/') + 1);
      if (!validArtifactName(name) || !artifact.metadata.files.some((file) => file.relativePath === name)) throw new Error('artifact_file_not_registered');
      const path = join(directory, name);
      const info = lstatSync(path);
      if (info.isSymbolicLink() || !info.isFile() || !within(directory, realpathSync(path))) throw new Error('path_outside_root');
      const file = artifact.metadata.files.find((entry) => entry.relativePath === name)!;
      if (info.size !== file.bytes || info.size > 10 * 1024 * 1024) throw new Error('artifact_size_mismatch');
      const bytes = readFileSync(path);
      if (bytes.byteLength !== file.bytes) throw new Error('artifact_size_mismatch');
      return ok(bytes);
    } catch (error) {
      const code = error && typeof error === 'object' && 'code' in error ? error.code : undefined;
      if (code === 'ENOENT' && rootsVerified) {
        // An earlier root check cannot classify a later missing-path error: a
        // mount may have disappeared or returned while this read was in flight.
        // These probes are conservative evidence, not a filesystem snapshot.
        try {
          const rootsUnchanged = () => verifiedRoots.every(previous => {
            const current = lstatSync(previous.path);
            return current.isDirectory() && !current.isSymbolicLink() && realpathSync(previous.path) === previous.real
              && current.dev === previous.dev && current.ino === previous.ino && current.ctimeMs === previous.ctimeMs;
          });
          if (!rootsUnchanged()) throw new Error('managed_root_changed');
          const name = fileName ?? artifact.relativePath.slice(artifact.relativePath.lastIndexOf('/') + 1);
          if (!validArtifactName(name) || !artifact.metadata.files.some(file => file.relativePath === name))
            throw new Error('artifact_read_transient');
          // ENOENT does not identify the absent path component. A successful
          // parent listing must itself lack the expected child before absence
          // can be durable; a temporarily absent parent only yields a retry.
          const artifactName = String(artifact.artifactId);
          if (readdirSync(this.artifactRoot).includes(artifactName)) {
            const directory = join(this.artifactRoot, artifactName);
            const info = lstatSync(directory);
            if (!info.isDirectory() || info.isSymbolicLink() || !within(verifiedRoots[1]!.real, realpathSync(directory)))
              throw new Error('artifact_read_transient');
            if (readdirSync(directory).includes(name)) throw new Error('artifact_read_transient');
          }
          // Retain the root checks around the observation; this still does not
          // promise a cross-process filesystem snapshot.
          if (!rootsUnchanged()) throw new Error('managed_root_changed');
          return fail(appError('artifact_unavailable', 'storage', '受管文件缺失或格式损坏。'));
        } catch { return fail(appError('input_unavailable', 'input', '受管材料当前不可读取。', true)); }
      }
      if (error instanceof Error && ['path_outside_root', 'artifact_file_not_registered', 'artifact_size_mismatch'].includes(error.message)) {
        return fail(appError('artifact_unavailable', 'storage', '受管文件缺失或格式损坏。'));
      }
      return fail(appError('input_unavailable', 'input', '受管材料当前不可读取。', true));
    }
  }

  private async publishLocked(input: PublishArtifactInput): Promise<Result<PublishedArtifactPair>> {
    let stagingPaths: string[] = [];
    let publishedPaths: string[] = [];
    try {
      mkdirSync(this.artifactRoot, { recursive: true });
      if (!within(realpathSync(this.root), realpathSync(this.artifactRoot))) throw new Error('path_outside_root');
      const artifactIds = this.documents.listArtifactIds();
      if (!artifactIds.ok) return artifactIds;
      const documentIds = this.documents.listDocumentIds();
      if (!documentIds.ok) return documentIds;
      const occupiedDocuments = new Set(documentIds.data);
      const allocateDocument = () => {
        let candidate = 1;
        while (occupiedDocuments.has(candidate)) candidate += 1;
        if (!Number.isSafeInteger(candidate)) throw new Error('document_id_exhausted');
        occupiedDocuments.add(candidate);
        return candidate;
      };
      const known = new Set(artifactIds.data);
      const dirs = readdirSync(this.artifactRoot, { withFileTypes: true });
      const existingDirs = new Set(dirs.filter((entry) => entry.isDirectory() && /^[1-9]\d*$/.test(entry.name)).map((entry) => Number(entry.name)));
      const orphan = this.findOrphan(input, known, dirs);
      if (orphan === 'conflict') return fail(appError('document_version_conflict', 'input', '同一来源版本存在无法核验的孤儿文件。'));
      if (orphan) {
        const reused = this.readPublishedPair(orphan, input.at, allocateDocument());
        return reused;
      }
      const occupied = new Set([...known, ...existingDirs]);
      const allocate = () => {
        let candidate = 1;
        while (occupied.has(candidate)) candidate += 1;
        occupied.add(candidate);
        return candidate;
      };
      const originalId = allocate();
      const parsedId = allocate();
      const documentId = allocateDocument();
      const original = this.normalizePayload(input.original, 'original');
      const parsed = this.normalizePayload(input.parsed, 'parsed');
      const originalManifest: Manifest = { version: 1, sourceKey: input.sourceKey, sourceRecordId: input.sourceRecordId,
        sourceVersion: input.sourceVersion, kind: 'original', files: this.manifestFiles(original) };
      const parsedManifest: Manifest = { version: 1, sourceKey: input.sourceKey, sourceRecordId: input.sourceRecordId,
        sourceVersion: input.sourceVersion, kind: 'parsed', files: this.manifestFiles(parsed) };
      const pairs: Array<{ id: number; payload: ArtifactPayload; manifest: Manifest }> = [
        { id: originalId, payload: original, manifest: originalManifest },
        { id: parsedId, payload: parsed, manifest: parsedManifest },
      ];
      for (const pair of pairs) {
        const stage = mkdtempSync(join(this.artifactRoot, '.stage-'));
        stagingPaths.push(stage);
        for (const file of pair.payload.files) writeFileSync(join(stage, file.name), file.bytes, { flag: 'wx' });
        writeFileSync(join(stage, 'publish.json'), jsonBytes(pair.manifest), { flag: 'wx' });
        const final = join(this.artifactRoot, String(pair.id));
        if (existsSync(final)) throw new Error('artifact_id_raced');
        renameSync(stage, final);
        stagingPaths = stagingPaths.filter((entry) => entry !== stage);
        publishedPaths.push(final);
      }
      return ok({
        documentId,
        original: this.published(originalId, 'original', original, input, input.at),
        parsed: this.published(parsedId, 'parsed', parsed, input, input.at),
      });
    } catch {
      for (const path of stagingPaths) { try { rmSync(path, { recursive: true, force: true }); } catch { /* preserve publication error */ } }
      if (publishedPaths.length < 2) {
        for (const path of publishedPaths) { try { rmSync(path, { recursive: true, force: true }); } catch { /* preserve publication error */ } }
      }
      return fail(appError('artifact_publish_failed', 'storage', '受管文件发布失败。', true));
    }
  }

  private normalizePayload(input: ArtifactPayload, kind: ArtifactPayload['kind']): ArtifactPayload {
    if (input.kind !== kind || !validArtifactName(input.primaryName) || !input.files.some((file) => file.name === input.primaryName)
      || input.files.length < 1 || input.files.length > 5) throw new Error('invalid_artifact_payload');
    const seen = new Set<string>();
    const files = input.files.map((file) => {
      if (!validArtifactName(file.name) || seen.has(file.name) || file.mimeType !== fileMime(file.name)
        || !(file.bytes instanceof Uint8Array) || file.bytes.byteLength < 1 || file.bytes.byteLength > 10 * 1024 * 1024) {
        throw new Error('invalid_artifact_file');
      }
      seen.add(file.name);
      return { ...file, bytes: Uint8Array.from(file.bytes) };
    });
    if (kind === 'original' && (files.length !== 1 || !/^original\.(jpg|png)$/.test(input.primaryName))) throw new Error('invalid_original_artifact');
    if (kind === 'parsed' && input.primaryName !== 'parsed.json') throw new Error('invalid_parsed_artifact');
    return { ...input, files };
  }

  private manifestFiles(payload: ArtifactPayload): Manifest['files'] {
    return payload.files.map((file) => ({ name: file.name, bytes: file.bytes.byteLength, mimeType: file.mimeType }));
  }

  private published(id: number, kind: ArtifactPayload['kind'], payload: ArtifactPayload, input: PublishArtifactInput, at: string): PublishedArtifact {
    const primary = payload.files.find((file) => file.name === payload.primaryName)!;
    return {
      artifactId: id, kind, relativePath: `artifacts/${id}/${payload.primaryName}`,
      bytes: primary.bytes.byteLength, mimeType: primary.mimeType,
      metadata: { version: 1, sourceKey: input.sourceKey, sourceRecordId: input.sourceRecordId,
        sourceVersion: input.sourceVersion, files: payload.files.map((file) => ({
          relativePath: file.name, bytes: file.bytes.byteLength, mimeType: file.mimeType,
        })) },
      createdAt: at,
    };
  }

  private findOrphan(input: PublishArtifactInput, known: Set<number>, dirs: Dirent[]): number[] | 'conflict' | null {
    const expected = [this.normalizePayload(input.original, 'original'), this.normalizePayload(input.parsed, 'parsed')];
    const found: Array<{ id: number; manifest: Manifest }> = [];
    for (const entry of dirs) {
      if (!entry.isDirectory() || !/^[1-9]\d*$/.test(entry.name)) continue;
      const id = Number(entry.name);
      if (known.has(id)) continue;
      const manifest = decodeManifest(join(this.artifactRoot, entry.name, 'publish.json'));
      if (manifest?.sourceKey === input.sourceKey && manifest.sourceRecordId === input.sourceRecordId
        && manifest.sourceVersion === input.sourceVersion) found.push({ id, manifest });
    }
    if (!found.length) return null;
    if (found.length !== 2 || !['original', 'parsed'].every((kind) => found.filter((entry) => entry.manifest.kind === kind).length === 1)) return 'conflict';
    const matches = expected.every((payload) => {
      const entry = found.find((candidate) => candidate.manifest.kind === payload.kind)!;
      const manifestFiles = entry.manifest.files.slice().sort((a, b) => a.name.localeCompare(b.name));
      const payloadFiles = this.manifestFiles(payload).slice().sort((a, b) => a.name.localeCompare(b.name));
      if (JSON.stringify(manifestFiles) !== JSON.stringify(payloadFiles)) return false;
      return payload.files.every((file) => {
        try { return Buffer.compare(readFileSync(join(this.artifactRoot, String(entry.id), file.name)), Buffer.from(file.bytes)) === 0; }
        catch { return false; }
      });
    });
    return matches ? found.map((entry) => entry.id) : 'conflict';
  }

  private readPublishedPair(ids: number[], at: string, documentId: DbId): Result<PublishedArtifactPair> {
    try {
      const output = ids.map((id) => {
        const manifest = decodeManifest(join(this.artifactRoot, String(id), 'publish.json'));
        if (!manifest) throw new Error('invalid_orphan_manifest');
        const primaryName = manifest.kind === 'original'
          ? manifest.files.find((file) => file.name === 'original.jpg' || file.name === 'original.png')?.name
          : 'parsed.json';
        if (!primaryName) throw new Error('orphan_primary_missing');
        const primary = manifest.files.find((file) => file.name === primaryName)!;
        return {
          artifactId: id, kind: manifest.kind, relativePath: `artifacts/${id}/${primaryName}`,
          bytes: primary.bytes, mimeType: primary.mimeType,
          metadata: { version: 1 as const, sourceKey: manifest.sourceKey, sourceRecordId: manifest.sourceRecordId,
            sourceVersion: manifest.sourceVersion, files: manifest.files.map((file) => ({ relativePath: file.name,
              bytes: file.bytes, mimeType: file.mimeType })) },
          createdAt: at,
        };
      });
      const original = output.find((item) => item.kind === 'original');
      const parsed = output.find((item) => item.kind === 'parsed');
      if (!original || !parsed) throw new Error('orphan_pair_incomplete');
      return ok({ documentId, original, parsed });
    } catch {
      return fail(appError('document_version_conflict', 'input', '同一来源版本存在无法核验的孤儿文件。'));
    }
  }
}

export function createFileStore(paths: ProductPaths, documents: DocumentRepository): FileStore {
  if (!isAbsolute(paths.root) || !isAbsolute(paths.artifactsDir) || !within(paths.root, paths.artifactsDir)) {
    throw new Error('invalid_product_artifacts_path');
  }
  return new FileStore(paths, documents);
}
