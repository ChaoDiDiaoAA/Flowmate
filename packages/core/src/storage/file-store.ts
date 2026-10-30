import { existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, renameSync, rmSync, rmdirSync, writeFileSync, linkSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import type { Dirent } from 'node:fs';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { appError, fail, ok, invoiceExportName } from '@flowmate/contracts';
import type { DbId, ProductPaths, Result, ExportInvoiceCandidateRequest, InvoiceExportReference, SourceSnapshot, ManagedFileContents, ResearchMaterial } from '@flowmate/contracts';
import type { DocumentRepository, StoredArtifact } from './repositories.ts';
import type { DbHandle } from './database.ts';

export const MAX_INVOICE_EXPORT_BYTES = 64 * 1024 * 1024;

export type ArtifactPayload = {
  kind: 'original' | 'parsed';
  primaryName: string;
  files: Array<{ name: string; bytes: Uint8Array; mimeType: string }>;
};

export type PublishedArtifact = StoredArtifact & { createdAt: string };
export type PublishedArtifactPair = { documentId: DbId; original: PublishedArtifact; parsed: PublishedArtifact };
type ResearchMaterialInput = { title: string; format: 'text' | 'markdown'; text: string; at: string };
type ResearchMaterialWorkflow = {
  findExisting(): Promise<Result<ResearchMaterial | null>>;
  register(published: PublishedArtifact): Promise<Result<ResearchMaterial>>;
};

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
  if (name === 'original.pdf') return 'application/pdf';
  if (name === 'source.md') return 'text/markdown';
  if (name === 'source.txt') return 'text/plain';
  return 'application/json';
}

function validArtifactName(name: string): boolean {
  return ['original.jpg', 'original.png', 'original.pdf', 'parsed.json', 'raw-content.json', 'raw-pages.json', 'source.json', 'source.txt', 'source.md'].includes(name);
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

export function readManagedInvoiceExport(paths: Pick<ProductPaths, 'root' | 'outputsDir'>, reference: InvoiceExportReference, expectedContent: Uint8Array): Result<Uint8Array> {
  try {
    if (!(expectedContent instanceof Uint8Array) || !Number.isSafeInteger(reference.bytes) || reference.bytes < 1
      || reference.bytes > MAX_INVOICE_EXPORT_BYTES) throw new Error('invalid_export_reference');
    const path = invoiceExportPath(paths, reference.relativePath);
    const stat = lstatSync(path);
    if (!stat.isFile() || stat.isSymbolicLink() || stat.size !== reference.bytes) throw new Error('invalid_export_file');
    const bytes = readFileSync(path);
    if (bytes.length !== reference.bytes || !Buffer.from(bytes).equals(Buffer.from(expectedContent))) throw new Error('export_content_mismatch');
    return ok(bytes);
  } catch { return fail(appError('artifact_unavailable', 'storage', '已导出文件缺失或变化，需按原事实核对。')); }
}

export function readManagedArtifact(paths: Pick<ProductPaths, 'root' | 'artifactsDir'>, artifact: StoredArtifact,
  fileName: string | undefined, contents: Pick<ManagedFileContents, 'read'>): Result<Uint8Array> {
  const rootPath = resolve(paths.root), artifactRoot = resolve(paths.artifactsDir);
  let rootsVerified = false;
  let verifiedRoots: Array<{ path: string; real: string; dev: number; ino: number; ctimeMs: number }> = [];
  try {
    const root = realpathSync(rootPath);
    const managedArtifactRoot = realpathSync(artifactRoot);
    if (!within(root, managedArtifactRoot)) throw new Error('path_outside_root');
    const rootInfo = lstatSync(root), artifactRootInfo = lstatSync(managedArtifactRoot);
    if (!rootInfo.isDirectory() || !artifactRootInfo.isDirectory()) throw new Error('managed_root_unavailable');
    verifiedRoots = [{ path: rootPath, real: root, ...rootInfo }, { path: artifactRoot, real: managedArtifactRoot, ...artifactRootInfo }];
    rootsVerified = true;
    const artifactDirectory = resolve(rootPath, dirname(artifact.relativePath));
    const expectedDirectory = resolve(artifactRoot, String(artifact.artifactId));
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
    const expected = contents?.read({ ownerKind: 'artifact', ownerId: String(artifact.artifactId), relativePath: name });
    if (!expected || !Buffer.from(expected).equals(bytes)) throw new Error('artifact_size_mismatch');
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
        if (readdirSync(artifactRoot).includes(artifactName)) {
          const directory = join(artifactRoot, artifactName);
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

function managedResearchSourcePath(paths: Pick<ProductPaths, 'root' | 'artifactsDir'>, researchId: number, toolCallId: number, create: boolean): string {
  if (!Number.isSafeInteger(researchId) || researchId < 1 || !Number.isSafeInteger(toolCallId) || toolCallId < 1) throw new Error('research_source_reference');
  const root = realpathSync(resolve(paths.root)), artifactRoot = resolve(paths.artifactsDir);
  for (const directory of [artifactRoot, join(artifactRoot, 'research'), join(artifactRoot, 'research', String(researchId))]) {
    if (!within(root, directory)) throw new Error('research_source_directory');
    if (create && !existsSync(directory)) mkdirSync(directory);
    const stat = lstatSync(directory);
    if (!stat.isDirectory() || stat.isSymbolicLink() || !within(root, directory) || realpathSync(directory) !== resolve(directory)) throw new Error('research_source_directory');
  }
  return join(artifactRoot, 'research', String(researchId), `source-${toolCallId}.txt`);
}

export function readManagedResearchSource(paths: Pick<ProductPaths, 'root' | 'artifactsDir'>, reference: Pick<SourceSnapshot, 'researchId' | 'toolCallId' | 'relativePath' | 'bytes' | 'characters'>,
  contents: Pick<ManagedFileContents, 'read'>): Result<string> {
  try {
    if (reference.relativePath !== `artifacts/research/${reference.researchId}/source-${reference.toolCallId}.txt`
      || !Number.isSafeInteger(reference.bytes) || reference.bytes < 1 || reference.bytes > 2_000_000) throw new Error('research_source_reference');
    const original = contents.read({ ownerKind: 'research-source', ownerId: String(reference.toolCallId), relativePath: reference.relativePath });
    const path = managedResearchSourcePath(paths, reference.researchId, reference.toolCallId, false), stat = lstatSync(path);
    if (!stat.isFile() || stat.isSymbolicLink() || stat.size !== reference.bytes) throw new Error('research_source_file');
    const bytes = readFileSync(path);
    if (bytes.length !== reference.bytes || !Buffer.from(original ?? []).equals(bytes)) throw new Error('research_source_content');
    const text = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes);
    if (text.length !== reference.characters) throw new Error('research_source_characters');
    return ok(text);
  } catch { return fail(appError('research_source_unavailable', 'tool', 'Saved research evidence is missing or changed.')); }
}

export class FileStore {
  private tail: Promise<void> = Promise.resolve();
  private readonly root: string;
  private readonly artifactRoot: string;

  public constructor(private readonly paths: ProductPaths, private readonly owner: Pick<DbHandle, 'read' | 'transaction'>) {
    this.root = resolve(paths.root);
    this.artifactRoot = resolve(paths.artifactsDir);
  }

  public async publishResearchSource(input: { researchId: number; toolCallId: number; text: string }): Promise<Result<Pick<SourceSnapshot, 'relativePath' | 'bytes' | 'characters'>>> {
    input = { ...input };
    try {
      const data = Buffer.from(input.text, 'utf8');
      if (data.length < 1 || data.length > 2_000_000 || data.toString('utf8') !== input.text) throw new Error('research_source_size');
      const relativePath = `artifacts/research/${input.researchId}/source-${input.toolCallId}.txt`;
      const owner = { ownerKind: 'research-source', ownerId: String(input.toolCallId), relativePath };
      const original = await this.readDocuments(documents => ok(documents.contents!.read(owner)));
      if (!original.ok || original.data !== null && !Buffer.from(original.data).equals(data)) throw new Error('research_source_conflict');
      const target = this.researchSourcePath(input.researchId, input.toolCallId, true);
      if (existsSync(target)) {
        const stat = lstatSync(target);
        if (!stat.isFile() || stat.isSymbolicLink() || !readFileSync(target).equals(data)) throw new Error('research_source_conflict');
      } else {
        const temporary = join(dirname(target), `.source-${randomUUID()}.tmp`);
        try { writeFileSync(temporary, data, { flag: 'wx' }); linkSync(temporary, target); }
        finally { if (existsSync(temporary)) rmSync(temporary); }
      }
      const remembered = await this.writeDocuments(documents => { documents.contents!.remember(owner, data); return ok(undefined); });
      if (!remembered.ok) throw new Error('research_source_original_unconfirmed');
      return ok({ relativePath, bytes: data.length, characters: input.text.length });
    } catch { return fail(appError('research_source_unavailable', 'storage', 'Research source could not be published.', true)); }
  }

  public publishResearchMaterial(input: ResearchMaterialInput): Promise<Result<PublishedArtifact>>;
  public publishResearchMaterial(input: ResearchMaterialInput, workflow: ResearchMaterialWorkflow): Promise<Result<ResearchMaterial>>;
  public publishResearchMaterial(input: ResearchMaterialInput, workflow?: ResearchMaterialWorkflow): Promise<Result<PublishedArtifact | ResearchMaterial>> {
    input = { ...input };
    const bytes = Buffer.from(input.text, 'utf8'), name = input.format === 'markdown' ? 'source.md' : 'source.txt';
    if (bytes.length < 1 || bytes.length > 2_000_000 || bytes.toString('utf8') !== input.text)
      return Promise.resolve(fail(appError('input_invalid', 'input', 'Selected text is invalid.')));
    return this.enqueuePublication<PublishedArtifact | ResearchMaterial>(async () => {
      let staging: string | null = null;
      try {
        if (workflow) {
          const existing = await workflow.findExisting();
          if (!existing.ok) return existing;
          if (existing.data !== null) return ok(existing.data);
        }
        const known = await this.readDocuments(documents => documents.listArtifactIds()); if (!known.ok) return known;
        if (!within(realpathSync(this.root), this.artifactRoot) || lstatSync(this.artifactRoot).isSymbolicLink()
          || realpathSync(this.artifactRoot) !== this.artifactRoot) throw new Error('research_material_root');
        const occupied = new Set([...known.data, ...readdirSync(this.artifactRoot).filter(value => /^[1-9]\d*$/.test(value)).map(Number)]);
        let artifactId = 1; while (occupied.has(artifactId)) artifactId++;
        if (!Number.isSafeInteger(artifactId)) throw new Error('artifact_id_exhausted');
        const mimeType = input.format === 'markdown' ? 'text/markdown' : 'text/plain';
        const metadata = { version: 1 as const, sourceKey: 'research-local-v1', sourceRecordId: input.title,
          sourceVersion: randomUUID(), files: [{ relativePath: name, bytes: bytes.length, mimeType }] };
        staging = mkdtempSync(join(this.artifactRoot, '.research-material-'));
        writeFileSync(join(staging, name), bytes, { flag: 'wx' });
        writeFileSync(join(staging, 'manifest.json'), jsonBytes({ ...metadata, kind: 'original', files: [{ name, bytes: bytes.length, mimeType }] }), { flag: 'wx' });
        if (!readFileSync(join(staging, name)).equals(bytes)) throw new Error('research_material_publication');
        renameSync(staging, join(this.artifactRoot, String(artifactId))); staging = null;
        const remembered = await this.writeDocuments(documents => {
          documents.contents!.remember({ ownerKind: 'artifact', ownerId: String(artifactId), relativePath: name }, bytes); return ok(undefined);
        });
        if (!remembered.ok) return remembered;
        const published: PublishedArtifact = { artifactId, kind: 'original', relativePath: `artifacts/${artifactId}/${name}`,
          bytes: bytes.length, mimeType, metadata, createdAt: input.at };
        return workflow ? await workflow.register(published) : ok(published);
      } catch { return fail(appError('storage_write_failed', 'storage', 'Research material publication failed.', true)); }
      finally {
        if (staging) try { for (const name of ['source.md', 'source.txt', 'manifest.json']) if (existsSync(join(staging, name))) rmSync(join(staging, name)); rmdirSync(staging); }
        catch { /* keep owned staging for inspection */ }
      }
    }).catch(() => fail(appError('storage_write_failed', 'storage', 'Research material publication failed.', true)));
  }

  public async readResearchSource(reference: Pick<SourceSnapshot, 'researchId' | 'toolCallId' | 'relativePath' | 'bytes' | 'characters'>): Promise<Result<string>> {
    reference = { ...reference };
    try {
      const owner = { ownerKind: 'research-source', ownerId: String(reference.toolCallId), relativePath: reference.relativePath };
      const original = await this.readDocuments(documents => ok(documents.contents!.read(owner)));
      if (!original.ok) throw new Error('research_source_original_unavailable');
      return this.inspectResearchSource(reference, { read: current => current.ownerKind === owner.ownerKind
        && current.ownerId === owner.ownerId && current.relativePath === owner.relativePath ? original.data : null });
    } catch { return fail(appError('research_source_unavailable', 'tool', 'Saved research evidence is missing or changed.')); }
  }

  public inspectResearchSource(reference: Pick<SourceSnapshot, 'researchId' | 'toolCallId' | 'relativePath' | 'bytes' | 'characters'>,
    contents: Pick<ManagedFileContents, 'read'>): Result<string> {
    return readManagedResearchSource({ root: this.root, artifactsDir: this.artifactRoot }, reference, contents);
  }

  private researchSourcePath(researchId: number, toolCallId: number, create: boolean): string {
    return managedResearchSourcePath({ root: this.root, artifactsDir: this.artifactRoot }, researchId, toolCallId, create);
  }

  public publishInvoiceExport(input: { candidateId: DbId; jobId: DbId; sequence: number;
    format: ExportInvoiceCandidateRequest['format']; bytes: Uint8Array }): Result<{ relativePath: string; bytes: number }> {
    if (![input.candidateId, input.jobId, input.sequence].every(value => Number.isSafeInteger(value) && value > 0)
      || !['json', 'csv', 'markdown'].includes(input.format) || input.bytes.byteLength < 1 || input.bytes.byteLength > MAX_INVOICE_EXPORT_BYTES) {
      return fail(appError('input_invalid', 'input', '导出文件参数无效。'));
    }
    const relativePath = invoiceExportName(input, input.format);
    let temporary: string | null = null;
    try {
      const target = this.invoiceExportPath(relativePath);
      if (existsSync(target)) {
        if (!lstatSync(target).isFile() || lstatSync(target).isSymbolicLink()
          || !Buffer.from(readFileSync(target)).equals(Buffer.from(input.bytes))) {
          return fail(appError('state_conflict', 'input', '导出目标存在不同内容，不能覆盖。'));
        }
        return ok({ relativePath, bytes: input.bytes.byteLength });
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
      return ok({ relativePath, bytes: input.bytes.byteLength });
    } catch { return fail(appError('storage_write_failed', 'storage', '导出文件发布失败；已发布内容保留供核对。', true)); }
    finally { if (temporary !== null) try { rmSync(temporary); } catch { /* preserve publication result */ } }
  }

  public readInvoiceExport(reference: InvoiceExportReference, expectedContent: Uint8Array): Result<Uint8Array> {
    return readManagedInvoiceExport(this.paths, reference, expectedContent);
  }

  private invoiceExportPath(relativePath: string): string {
    return invoiceExportPath(this.paths, relativePath);
  }

  private enqueuePublication<T>(operation: () => Promise<Result<T>>): Promise<Result<T>> {
    const previous = this.tail;
    let release!: () => void;
    this.tail = new Promise<void>((resolveLock) => { release = resolveLock; });
    return previous.then(operation).finally(release);
  }

  private async readDocuments<T>(operation: (documents: DocumentRepository) => Result<T>): Promise<Result<T>> {
    try { return await this.owner.read(scope => operation(scope.documents)); }
    catch { return fail(appError('storage_read_failed', 'storage', 'Managed file metadata could not be read.', true)); }
  }

  private async writeDocuments<T>(operation: (documents: DocumentRepository) => Result<T>): Promise<Result<T>> {
    try { return await this.owner.transaction(scope => operation(scope.documents)); }
    catch { return fail(appError('storage_write_failed', 'storage', 'Managed file content could not be saved.', true)); }
  }

  public publish(input: PublishArtifactInput): Promise<Result<PublishedArtifactPair>>;
  public publish<T>(input: PublishArtifactInput, workflow: {
    findExisting(): Promise<Result<T | null>>;
    register(published: PublishedArtifactPair): Promise<Result<T>>;
  }): Promise<Result<T>>;
  public publish<T>(input: PublishArtifactInput, workflow?: {
    findExisting(): Promise<Result<T | null>>;
    register(published: PublishedArtifactPair): Promise<Result<T>>;
  }): Promise<Result<PublishedArtifactPair | T>> {
    try { input = structuredClone(input); }
    catch { return Promise.resolve(fail(appError('artifact_publish_failed', 'storage', '受管文件发布失败。', true))); }
    return this.enqueuePublication<PublishedArtifactPair | T>(async () => {
      if (workflow) {
        const existing = await workflow.findExisting();
        if (!existing.ok) return existing;
        if (existing.data !== null) return ok(existing.data);
      }
      const published = await this.publishLocked(input);
      return published.ok && workflow ? workflow.register(published.data) : published;
    }).catch(() => fail(appError('artifact_publish_failed', 'storage', '受管文件发布失败。', true)));
  }

  public read(artifact: StoredArtifact, fileName: string | undefined, contents: Pick<ManagedFileContents, 'read'>): Result<Uint8Array> {
    return readManagedArtifact({ root: this.root, artifactsDir: this.artifactRoot }, artifact, fileName, contents);
  }

  private async publishLocked(input: PublishArtifactInput): Promise<Result<PublishedArtifactPair>> {
    let stagingPaths: string[] = [];
    let publishedPaths: string[] = [];
    try {
      const allocated = await this.readDocuments(documents => {
        const artifacts = documents.listArtifactIds(); if (!artifacts.ok) return artifacts;
        const documentsIds = documents.listDocumentIds(); if (!documentsIds.ok) return documentsIds;
        return ok({ artifactIds: artifacts.data, documentIds: documentsIds.data });
      });
      if (!allocated.ok) return allocated;
      mkdirSync(this.artifactRoot, { recursive: true });
      if (!within(realpathSync(this.root), realpathSync(this.artifactRoot))) throw new Error('path_outside_root');
      const occupiedDocuments = new Set(allocated.data.documentIds);
      const allocateDocument = () => {
        let candidate = 1;
        while (occupiedDocuments.has(candidate)) candidate += 1;
        if (!Number.isSafeInteger(candidate)) throw new Error('document_id_exhausted');
        occupiedDocuments.add(candidate);
        return candidate;
      };
      const known = new Set(allocated.data.artifactIds);
      const dirs = readdirSync(this.artifactRoot, { withFileTypes: true });
      const existingDirs = new Set(dirs.filter((entry) => entry.isDirectory() && /^[1-9]\d*$/.test(entry.name)).map((entry) => Number(entry.name)));
      const orphan = this.findOrphan(input, known, dirs);
      if (orphan === 'conflict') return fail(appError('document_version_conflict', 'input', '同一来源版本存在无法核验的孤儿文件。'));
      if (orphan) {
        const reused = this.readPublishedPair(orphan, input, allocateDocument());
        return reused.ok ? this.rememberPublished(input, reused.data) : reused;
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
      return this.rememberPublished(input, {
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
    if (kind === 'original' && (files.length !== 1 || !['original.jpg', 'original.png', 'original.pdf', 'source.md'].includes(input.primaryName))) throw new Error('invalid_original_artifact');
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

  private rememberPublished(input: PublishArtifactInput, pair: PublishedArtifactPair): Promise<Result<PublishedArtifactPair>> {
    return this.writeDocuments(documents => {
      for (const [artifact, payload] of [[pair.original, input.original], [pair.parsed, input.parsed]] as const) {
        for (const file of payload.files) documents.contents!.remember({ ownerKind: 'artifact', ownerId: String(artifact.artifactId), relativePath: file.name }, file.bytes);
      }
      return ok(pair);
    });
  }

  private findOrphan(input: PublishArtifactInput, known: Set<number>, dirs: Dirent[]): number[] | 'conflict' | null {
    const expected = [this.normalizePayload(input.original, 'original'), this.normalizePayload(input.parsed, 'parsed')];
    const groups = new Map<string, Array<{ id: number; manifest: Manifest }>>();
    for (const entry of dirs) {
      if (!entry.isDirectory() || !/^[1-9]\d*$/.test(entry.name)) continue;
      const id = Number(entry.name);
      if (known.has(id)) continue;
      const manifest = decodeManifest(join(this.artifactRoot, entry.name, 'publish.json'));
      if (manifest?.sourceKey !== input.sourceKey || manifest.sourceRecordId !== input.sourceRecordId) continue;
      const group = groups.get(manifest.sourceVersion) ?? [];
      group.push({ id, manifest }); groups.set(manifest.sourceVersion, group);
    }
    for (const [version, found] of groups) {
      if (found.length !== 2 || !['original', 'parsed'].every(kind => found.filter(entry => entry.manifest.kind === kind).length === 1)) {
        if (version === input.sourceVersion) return 'conflict';
        continue;
      }
      const matches = expected.every(payload => {
        const entry = found.find(candidate => candidate.manifest.kind === payload.kind)!;
        const manifestFiles = entry.manifest.files.slice().sort((a, b) => a.name.localeCompare(b.name));
        const payloadFiles = this.manifestFiles(payload).slice().sort((a, b) => a.name.localeCompare(b.name));
        if (JSON.stringify(manifestFiles) !== JSON.stringify(payloadFiles)) return false;
        return payload.files.every(file => {
          try {
            const directory = join(this.artifactRoot, String(entry.id)), path = join(directory, file.name);
            if (lstatSync(directory).isSymbolicLink() || !within(this.artifactRoot, realpathSync(directory))
              || lstatSync(path).isSymbolicLink() || !lstatSync(path).isFile()) return false;
            return readFileSync(path).equals(Buffer.from(file.bytes));
          } catch { return false; }
        });
      });
      if (matches) return found.map(entry => entry.id);
      if (version === input.sourceVersion) return 'conflict';
    }
    return null;
  }

  private readPublishedPair(ids: number[], input: PublishArtifactInput, documentId: DbId): Result<PublishedArtifactPair> {
    try {
      const output = ids.map(id => {
        const manifest = decodeManifest(join(this.artifactRoot, String(id), 'publish.json'));
        if (!manifest) throw new Error('invalid_orphan_manifest');
        const payload = manifest.kind === 'original' ? input.original : input.parsed;
        return this.published(id, manifest.kind, payload, { ...input, sourceVersion: manifest.sourceVersion }, input.at);
      });
      const original = output.find(item => item.kind === 'original'), parsed = output.find(item => item.kind === 'parsed');
      if (!original || !parsed || original.metadata.sourceVersion !== parsed.metadata.sourceVersion) throw new Error('orphan_pair_incomplete');
      return ok({ documentId, original, parsed });
    } catch {
      return fail(appError('document_version_conflict', 'input', '同一来源版本存在无法核验的孤儿文件。'));
    }
  }
}

export function createFileStore(paths: ProductPaths, owner: Pick<DbHandle, 'read' | 'transaction'>): FileStore {
  if (!isAbsolute(paths.root) || !isAbsolute(paths.artifactsDir) || !within(paths.root, paths.artifactsDir)) {
    throw new Error('invalid_product_artifacts_path');
  }
  return new FileStore(paths, owner);
}
