import { Database } from 'bun:sqlite';
import { randomUUID } from 'node:crypto';
import { closeSync, copyFileSync, existsSync, lstatSync, mkdirSync, openSync, readFileSync, readdirSync, readSync, realpathSync, renameSync } from 'node:fs';
import { copyFile, mkdir, open, rename, unlink } from 'node:fs/promises';
import { dirname, isAbsolute, join, relative, resolve } from 'node:path';
import { isDeepStrictEqual } from 'node:util';
import { z } from 'zod';
import { appError, fail, ok, type ProductPaths, type Result } from '@flowmate/contracts';
import { PackagedReleaseSchema, ServiceInstallationSchema, resolveProductPaths, validateProductPaths, type PackagedRelease, type ServiceInstallation } from '@flowmate/shared';
import { validateProductSettings } from '../configuration/settings.ts';
import { writeSynced } from '../skill-hub/resources.ts';
import { readManagedArtifact, readManagedInvoiceExport, readManagedResearchSource } from './file-store.ts';
import { createDocumentRepository, createSessionRepository, inspectRuntimeRecovery } from './repositories.ts';
import { createManagedFileContents } from './managed-file-contents.ts';
import { createResourceBundles } from '../skill-hub/bundle.ts';

export type StoreInspection = { schemaVersion: number | null; settingsVersion: number | null;
  installedReleaseId: string | null; journalMode: string | null };
export type BackupManifest = { version: 1; backupId: string; createdAt: string; productVersion: string | null;
  releaseId: string | null; schemaVersion: number | null; settingsVersion: number | null;
  files: readonly { path: string; byteLength: number }[]; gaps: readonly string[] };
export type BackupReceipt = { directory: string; manifest: BackupManifest };

export const InstalledReleaseSchema = z.object({ version: z.literal(1), releaseId: z.string().uuid(),
  productVersion: z.string().min(1).max(128), schemaVersion: z.number().int().min(1).max(21),
  settingsVersion: z.number().int().min(1).max(7) }).strict();
const backupSchema = z.object({ version: z.literal(1), backupId: z.string().uuid(), createdAt: z.string().datetime(),
  productVersion: z.string().max(128).nullable(), releaseId: z.string().uuid().nullable(),
  schemaVersion: z.number().int().min(1).max(21).nullable(), settingsVersion: z.number().int().min(1).max(7).nullable(),
  files: z.array(z.object({ path: z.string().min(1).max(1024), byteLength: z.number().int().nonnegative().safe() }).strict()).min(1),
  gaps: z.array(z.string().max(256)) }).strict();

function errorResult(code: string) { return fail(appError(code, 'storage', 'Local store maintenance could not be verified. Original data was retained.', true)); }
function safeRelative(path: string): boolean {
  return !isAbsolute(path) && path.split('/').every(part => part && part !== '.' && part !== '..' && !/[\\:\x00-\x1f]/.test(part));
}
function within(root: string, target: string): boolean {
  const path = relative(root, target); return !isAbsolute(path) && path !== '..' && !path.startsWith('..\\') && !path.startsWith('../');
}
function checkedPaths(paths: ProductPaths): ProductPaths {
  const checked = validateProductPaths(paths); if (!checked.ok) throw Error('maintenance_store_incompatible'); return checked.data;
}
function ownedFile(root: string, path: string): string {
  if (!safeRelative(path)) throw Error('maintenance_reference_missing');
  let target = root;
  for (const part of path.split('/')) {
    target = join(target, part);
    if (lstatSync(target).isSymbolicLink()) throw Error('maintenance_reference_missing');
  }
  if (!within(root, realpathSync(target)) || !lstatSync(target).isFile()) throw Error('maintenance_reference_missing');
  return target;
}
function jsonFile(root: string, path: string): unknown { return JSON.parse(readFileSync(ownedFile(root, path), 'utf8')); }
function marker(paths: ProductPaths) {
  return existsSync(join(paths.root, 'data/installed-release.json'))
    ? InstalledReleaseSchema.parse(jsonFile(paths.root, 'data/installed-release.json')) : null;
}
function inspectDatabase(db: Database): { schemaVersion: number | null; journalMode: string } {
  if (db.query('PRAGMA integrity_check').all().some(row => Object.values(row as object)[0] !== 'ok')
    || db.query('PRAGMA foreign_key_check').all().length) throw Error('maintenance_store_incompatible');
  const nativeTables = db.query<{ name: string }, []>("SELECT name FROM sqlite_master WHERE type='table' AND name GLOB 'fm_durable_*'").all();
  if (nativeTables.length) {
    if (!nativeTables.some(row => row.name === 'fm_durable_durable_schema')) throw Error('maintenance_store_incompatible');
    // Pi Durable 1.4.0 uses its own schema2 marker; this is independent of product schema21.
    z.array(z.object({ singleton: z.literal(1), version: z.literal(2) }).strict()).length(1)
      .parse(db.query('SELECT singleton,version FROM fm_durable_durable_schema').all());
  }
  const migrationTable = db.query("SELECT name FROM sqlite_master WHERE type='table' AND name='schema_migrations'").get();
  let schemaVersion: number | null = null;
  if (migrationTable) {
    const rows = db.query('SELECT version FROM schema_migrations ORDER BY version').all() as { version: number }[];
    if (!rows.length || rows.length > 21 || rows.some((row, index) => row.version !== index + 1)) throw Error('maintenance_store_incompatible');
    schemaVersion = rows.length;
  } else if (db.query("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'").get())
    throw Error('maintenance_store_incompatible');
  return { schemaVersion, journalMode: Object.values(db.query('PRAGMA journal_mode').get() as object)[0] as string };
}

/** Caller holds the existing controller lease. Never creates a database, migrates or repairs Run facts. */
export function inspectStore(input: ProductPaths): Result<StoreInspection> {
  let db: Database | undefined;
  try {
    const paths = checkedPaths(input), installed = marker(paths);
    let schemaVersion: number | null = null, journalMode: string | null = null, settingsVersion: number | null = null;
    if (existsSync(paths.databaseFile)) {
      db = new Database(ownedFile(paths.root, 'data/app.sqlite'), { readonly: true });
      ({ schemaVersion, journalMode } = inspectDatabase(db));
    }
    if (existsSync(join(paths.root, 'data/settings.json'))) {
      const value = jsonFile(paths.root, 'data/settings.json');
      if (!value || typeof value !== 'object' || !('version' in value) || !Number.isInteger(value.version)
        || Number(value.version) < 1 || Number(value.version) > 7 || !validateProductSettings(value).ok) throw Error('maintenance_store_incompatible');
      settingsVersion = Number(value.version);
    }
    if (existsSync(join(paths.root, 'service-installation.json'))) {
      const service = ServiceInstallationSchema.parse(jsonFile(paths.root, 'service-installation.json'));
      // Offline copies retain the original absolute installation identity; execution rebind checks are separate.
      if (schemaVersion === null && (service.enabled === true
        || service.activationOperationId !== null && service.activationOperationId !== undefined))
        throw Error('maintenance_store_incompatible');
    }
    if (installed && (schemaVersion === null || installed.schemaVersion > schemaVersion
      || settingsVersion !== null && installed.settingsVersion > settingsVersion)) throw Error('maintenance_store_incompatible');
    return ok({ schemaVersion, settingsVersion, journalMode, installedReleaseId: installed?.releaseId ?? null });
  } catch { return errorResult('maintenance_store_incompatible'); }
  finally { db?.close(); }
}

function persistentFiles(paths: ProductPaths): string[] {
  const names = new Set<string>();
  function visit(path: string) {
    const target = join(paths.root, path), stat = lstatSync(target);
    if (stat.isSymbolicLink() || !within(paths.root, realpathSync(target))) throw Error('maintenance_reference_missing');
    if (stat.isDirectory()) for (const name of readdirSync(target).sort()) visit(`${path}/${name}`);
    else if (stat.isFile()) {
      if (/^\.env(?:\.|$)/i.test(path.split('/').at(-1)!)) return;
      ownedFile(paths.root, path); names.add(path);
    } else throw Error('maintenance_reference_missing');
  }
  // Electron's Windows DPAPI provider needs the original encrypted key in Local State after restoring credentials.
  for (const path of ['Local State', 'service-installation.json', 'data/app.sqlite', 'data/settings.json', 'data/installed-release.json',
    'data/desktop-service-settings-request.json', 'artifacts', 'outputs',
    'runtime/resource-bundles', 'runtime/subagents', 'security/credentials', 'security/service-credentials', 'imports/invoices',
    'evaluation/agent-eval/runs', 'evaluation/agent-eval/calibration-runs']) {
    if (existsSync(join(paths.root, path))) visit(path);
  }
  return [...names].sort();
}

async function checkReferences(paths: ProductPaths, version: number | null): Promise<string[]> {
  const gaps: string[] = [];
  if (version !== 20 && version !== 21) { if (version !== null) gaps.push('matching_old_program_or_explicit_upgrade_required'); return gaps; }
  const db = new Database(paths.databaseFile, { readonly: true });
  try {
    const documents = createDocumentRepository(db), contentsReader = createManagedFileContents(db);
    const exports = db.query("SELECT id,relative_path,bytes,metadata_json,created_at FROM artifacts WHERE kind='export'").all() as {
      id: number; relative_path: string; bytes: number; metadata_json: string; created_at: string }[];
    for (const row of exports) {
      const metadata = z.object({ version: z.literal(1), candidateId: z.number().int().positive(), format: z.enum(['json', 'csv', 'markdown']) })
        .parse(JSON.parse(row.metadata_json));
      const expected = contentsReader.read({ ownerKind: 'invoice-export', ownerId: String(metadata.candidateId), relativePath: row.relative_path });
      if (!expected || !readManagedInvoiceExport(paths, { artifactId: row.id, candidateId: metadata.candidateId, format: metadata.format,
        relativePath: row.relative_path, bytes: row.bytes, createdAt: row.created_at }, expected).ok) throw Error('maintenance_reference_missing');
    }
    for (const row of db.query("SELECT id FROM artifacts WHERE kind IN ('original','parsed') ORDER BY id").all() as { id: number }[]) {
      const artifact = documents.getArtifact(row.id); if (!artifact.ok) throw Error('maintenance_reference_missing');
      const legacy = db.query(`SELECT metadata_json FROM documents WHERE (original_artifact_id=? OR parsed_artifact_id=?) AND status='unavailable'`)
        .all(row.id, row.id) as { metadata_json: string }[];
      if (artifact.data.metadata.verificationGap === 'legacy-original-unavailable'
        || legacy.some(item => JSON.parse(item.metadata_json).unavailableReason === 'Legacy file content has no preserved original bytes. Re-import this document to use it again.')) {
        gaps.push(`legacy_artifact_unavailable:${row.id}`); continue;
      }
      for (const file of artifact.data.metadata.files) if (!readManagedArtifact(paths, artifact.data, file.relativePath, contentsReader).ok) throw Error('maintenance_reference_missing');
    }
    const contents = db.query('SELECT owner_kind,owner_id,relative_path,content FROM managed_file_contents').all() as {
      owner_kind: string; owner_id: string; relative_path: string; content: Uint8Array }[];
    const references = db.query(`SELECT json_extract(config_json,'$.resources.bundleId') AS id,session_id FROM runs
      UNION SELECT json_extract(content_json,'$.resourceBinding.bundleId'),session_id FROM session_inputs
      UNION SELECT json_extract(snapshot_json,'$.resourceBinding.bundleId'),session_id FROM context_snapshots`).all() as { id: unknown; session_id: number | null }[];
    const referencedBundles = new Set(references.map(row => row.id).filter((id): id is string => typeof id === 'string'));
    const bundles = createResourceBundles(join(paths.runtimeDir, 'resource-bundles'), createManagedFileContents(db));
    for (const id of referencedBundles) {
      if (!z.string().uuid().safeParse(id).success) throw Error('maintenance_reference_missing');
      if (bundles.verifyPublished(id).ok) continue;
      const owners = references.filter(row => row.id === id);
      const unusable = owners.every(row => row.session_id !== null && (db.query('SELECT unusable FROM session_native_history WHERE session_id=?')
        .get(row.session_id) as { unusable: number } | null)?.unusable === 1);
      if (!unusable) throw Error('maintenance_reference_missing');
      gaps.push(`resource_bundle_unavailable_for_unusable_history:${id}`);
    }
    const sources = (db.query('SELECT research_id,tool_call_id,body_json FROM research_sources').all() as {
      research_id: number; tool_call_id: number; body_json: string }[])
      .map(row => ({ ...JSON.parse(row.body_json), researchId: row.research_id, toolCallId: row.tool_call_id }));
    for (const row of contents) {
      if (!safeRelative(row.relative_path) || !(row.content instanceof Uint8Array)) throw Error('maintenance_reference_missing');
      // Historical author keys are resource identities; their original body lives in SQLite, not the current installation.
      if (row.owner_kind === 'resource-author') continue;
      if (!row.owner_id || !safeRelative(row.owner_id) || row.owner_id.includes('/')) throw Error('maintenance_reference_missing');
      if (row.owner_kind === 'artifact') continue;
      const path = row.owner_kind === 'resource-bundle' ? `runtime/resource-bundles/${row.owner_id}/${row.relative_path}`
        : ['research-source', 'invoice-export'].includes(row.owner_kind) ? row.relative_path : null;
      if (!path) throw Error('maintenance_reference_missing');
      const published = row.owner_kind === 'resource-bundle' ? referencedBundles.has(row.owner_id)
        : row.owner_kind === 'research-source' ? sources.some(source => String(source.toolCallId) === row.owner_id && source.relativePath === row.relative_path)
          : exports.some(file => file.relative_path === row.relative_path);
      // Content is registered before publication. Preserve a failed publication in SQLite without inventing its file.
      if (!published) { gaps.push(`unpublished_managed_content:${row.owner_kind}:${row.owner_id}`); continue; }
      if (!readFileSync(ownedFile(paths.root, path)).equals(Buffer.from(row.content))) throw Error('maintenance_reference_missing');
    }
    for (const source of sources) {
      if (source.verificationGap === 'legacy-original-unavailable') { gaps.push('legacy_research_source_unavailable'); continue; }
      if (!readManagedResearchSource(paths, source, contentsReader).ok) throw Error('maintenance_reference_missing');
    }
    const sessions = createSessionRepository(db);
    for (const row of db.query('SELECT id FROM sessions ORDER BY id').all() as { id: number }[]) {
      const session = sessions.get(row.id); if (!session.ok) throw Error('maintenance_store_incompatible');
      if (session.data.runtimeKind === 'durable') {
        if (session.data.durableConversationId !== null
          && !db.query('SELECT id FROM fm_durable_conversations WHERE id=?').get(session.data.durableConversationId))
          throw Error('maintenance_reference_missing');
        continue;
      }
      const history = sessions.readHistoryForDisplay(row.id);
      if (!history.ok && !session.data.nativeUnusable && session.data.historyState === 'recoverable') throw Error('maintenance_store_incompatible');
      if (!history.ok || session.data.nativeUnusable || session.data.modelUseBlocked) gaps.push(`session_execution_requires_recheck:${row.id}`);
    }
    if (inspectRuntimeRecovery(db)) gaps.push('runtime_stop_or_required_observation_unconfirmed');
    return [...new Set(gaps)];
  } catch (error) {
    if (error instanceof Error && error.message === 'maintenance_store_incompatible') throw error;
    throw Error('maintenance_reference_missing');
  } finally { db.close(); }
}

function sameBytes(left: string, right: string): boolean {
  const a = openSync(left, 'r'), first = Buffer.alloc(65_536), second = Buffer.alloc(65_536);
  let b: number | undefined;
  try {
    b = openSync(right, 'r');
    while (true) {
      const n = readSync(a, first, 0, first.length, null), m = readSync(b, second, 0, second.length, null);
      if (n !== m || !first.subarray(0, n).equals(second.subarray(0, m))) return false;
      if (n === 0) return true;
    }
  } finally { closeSync(a); if (b !== undefined) closeSync(b); }
}

/** Under the caller's controller lease, SQLite alone rolls back uncommitted crash pages. */
function recoverRollbackJournal(paths: ProductPaths): void {
  if (!existsSync(paths.databaseFile + '-journal')) return;
  ownedFile(paths.root, 'data/app.sqlite-journal');
  const db = new Database(ownedFile(paths.root, 'data/app.sqlite'), { readwrite: true, create: false });
  try {
    db.exec('PRAGMA busy_timeout=1000'); db.exec('PRAGMA locking_mode=EXCLUSIVE');
    db.query('PRAGMA schema_version').get();
  } finally { db.close(); }
}

/** All business controllers/connections are closed; the caller retains its controller lease throughout. */
export async function backupStore(input: ProductPaths, destination: string): Promise<Result<BackupReceipt>> {
  let db: Database | undefined;
  try {
    const paths = checkedPaths(input);
    if (!isAbsolute(destination) || existsSync(destination)) throw Error('maintenance_backup_failed');
    const parent = realpathSync(dirname(destination)), target = join(parent, destination.slice(dirname(destination).length + 1));
    if (target !== resolve(destination) || within(paths.root, target) && relative(paths.root, parent).replaceAll('\\', '/') !== 'backups')
      throw Error('maintenance_backup_failed');
    recoverRollbackJournal(paths);
    const initial = inspectStore(paths); if (!initial.ok) return initial;
    if (existsSync(paths.databaseFile)) {
      db = new Database(ownedFile(paths.root, 'data/app.sqlite'), { readwrite: true, create: false });
      db.exec('PRAGMA busy_timeout=1000; PRAGMA locking_mode=EXCLUSIVE; BEGIN EXCLUSIVE; COMMIT;');
      const checkpoint = db.query('PRAGMA wal_checkpoint(TRUNCATE)').get() as { busy: number };
      if (checkpoint.busy !== 0) throw Error('maintenance_backup_failed');
      db.exec('PRAGMA journal_mode=DELETE'); inspectDatabase(db); db.close(); db = undefined;
    }
    const inspection = inspectStore(paths); if (!inspection.ok) return inspection;
    const gaps = await checkReferences(paths, inspection.data.schemaVersion), selected = persistentFiles(paths);
    if (!selected.some(path => path !== 'Local State')) throw Error('maintenance_backup_failed');
    for (const path of selected.filter(path => path.startsWith('security/credentials/'))) {
      const envelope = jsonFile(paths.root, path);
      if (!envelope || typeof envelope !== 'object' || Object.keys(envelope).sort().join(',') !== 'ciphertext,version'
        || !('version' in envelope) || envelope.version !== 1 || !('ciphertext' in envelope)
        || typeof envelope.ciphertext !== 'string' || !envelope.ciphertext) throw Error('maintenance_backup_failed');
    }
    if (selected.some(path => path.startsWith('evaluation/'))) gaps.push('external_evaluation_datasets_not_included');
    if (selected.some(path => path.startsWith('evaluation/') && path.endsWith('.write-lock'))) gaps.push('evaluation_write_ownership_requires_recheck');
    mkdirSync(target, { mode: 0o700 });
    const members: Array<{ path: string; byteLength: number }> = [];
    for (const path of selected) {
      const source = ownedFile(paths.root, path), copy = join(target, path); mkdirSync(dirname(copy), { recursive: true });
      copyFileSync(source, copy, 1);
      if (!sameBytes(ownedFile(paths.root, path), ownedFile(target, path))) throw Error('maintenance_backup_failed');
      members.push({ path, byteLength: lstatSync(copy).size });
    }
    if (!isDeepStrictEqual(persistentFiles(paths), selected)) throw Error('maintenance_backup_failed');
    for (const file of members) if (!sameBytes(ownedFile(paths.root, file.path), ownedFile(target, file.path))) throw Error('maintenance_backup_failed');
    const copiedPaths = checkedPaths({ ...paths, root: target, databaseFile: join(target, 'data/app.sqlite'),
      artifactsDir: join(target, 'artifacts'), outputsDir: join(target, 'outputs'), runtimeDir: join(target, 'runtime'), logsDir: join(target, 'logs') });
    const copied = inspectStore(copiedPaths);
    if (!copied.ok || !isDeepStrictEqual(copied.data, inspection.data)) throw Error('maintenance_backup_failed');
    await checkReferences(copiedPaths, copied.data.schemaVersion);
    const installed = marker(paths);
    const manifest = backupSchema.parse({ version: 1, backupId: randomUUID(), createdAt: new Date().toISOString(),
      productVersion: installed?.productVersion ?? null, releaseId: installed?.releaseId ?? null,
      schemaVersion: inspection.data.schemaVersion, settingsVersion: inspection.data.settingsVersion, files: members, gaps });
    const temporary = join(target, `.manifest-${manifest.backupId}.tmp`);
    writeSynced(temporary, `${JSON.stringify(manifest, null, 2)}\n`); renameSync(temporary, join(target, 'manifest.json'));
    return ok({ directory: target, manifest });
  } catch (error) {
    return errorResult(error instanceof Error && error.message === 'maintenance_reference_missing' ? error.message : 'maintenance_backup_failed');
  } finally { db?.close(); }
}

export async function prepareStoreUpgrade(input: ProductPaths, rawRelease: PackagedRelease): Promise<Result<BackupReceipt | null>> {
  try {
    const release = PackagedReleaseSchema.parse(rawRelease), paths = checkedPaths(input);
    try {
      lstatSync(join(paths.root, 'data/service-restore.json'));
      return fail(appError('maintenance_restore_pending', 'storage', 'The original service data restore must finish before opening the installed store.', true));
    } catch (cause) {
      if (!cause || typeof cause !== 'object' || !('code' in cause) || cause.code !== 'ENOENT')
        return fail(appError('maintenance_restore_pending', 'storage', 'The original service data restore must finish before opening the installed store.', true));
    }
    recoverRollbackJournal(paths);
    const inspection = inspectStore(paths);
    if (!inspection.ok) return inspection;
    const selected = persistentFiles(paths);
    if (!selected.some(path => path !== 'Local State')) return ok(null);
    if (inspection.data.schemaVersion === null && selected.some(path => path === 'data/settings.json'
      || /^(artifacts|outputs|security\/credentials|runtime\/(resource-bundles|subagents))\//.test(path)))
      return errorResult('maintenance_store_incompatible');
    if (inspection.data.installedReleaseId === release.releaseId && inspection.data.schemaVersion === release.schemaVersion
      && inspection.data.settingsVersion === release.settingsVersion) { await checkReferences(paths, inspection.data.schemaVersion); return ok(null); }
    const backups = join(paths.root, 'backups');
    if (existsSync(backups) && (lstatSync(backups).isSymbolicLink() || realpathSync(backups) !== backups)) throw Error('maintenance_backup_failed');
    mkdirSync(backups, { recursive: true, mode: 0o700 });
    return await backupStore(paths, join(backups, randomUUID()));
  } catch (error) {
    return errorResult(error instanceof Error && error.message === 'maintenance_reference_missing' ? error.message : 'maintenance_backup_failed');
  }
}

function requireStandaloneDatabase(paths: ProductPaths): void {
  for (const suffix of ['-wal', '-shm', '-journal']) {
    try { lstatSync(paths.databaseFile + suffix); throw Error('maintenance_unlisted_sqlite_state'); }
    catch (cause) { if (!cause || typeof cause !== 'object' || !('code' in cause) || cause.code !== 'ENOENT') throw cause; }
  }
}

/** Verify the saved snapshot itself, independently of later live data; never repairs or decrypts credentials. */
export async function verifyBackupSnapshot(directory: string): Promise<Result<BackupReceipt>> {
  try {
    if (!isAbsolute(directory) || lstatSync(directory).isSymbolicLink() || realpathSync(directory) !== resolve(directory))
      throw Error('maintenance_backup_invalid');
    const resolved = resolveProductPaths(directory); if (!resolved.ok) throw Error('maintenance_backup_invalid');
    const paths = checkedPaths(resolved.data), manifest = backupSchema.parse(jsonFile(paths.root, 'manifest.json'));
    // The producer commits a standalone DELETE image; SQLite must not consult or create unlisted journal state.
    requireStandaloneDatabase(paths);
    if (existsSync(paths.databaseFile)) {
      const descriptor = openSync(ownedFile(paths.root, 'data/app.sqlite'), 'r'), header = Buffer.alloc(100);
      try {
        if (readSync(descriptor, header, 0, header.length, 0) !== header.length
          || !header.subarray(0, 16).equals(Buffer.from('SQLite format 3\0')) || header[18] !== 1 || header[19] !== 1)
          throw Error('maintenance_backup_invalid');
      } finally { closeSync(descriptor); }
    }
    if (new Set(manifest.files.map(file => file.path)).size !== manifest.files.length
      || !isDeepStrictEqual(persistentFiles(paths), manifest.files.map(file => file.path).sort())) throw Error('maintenance_backup_invalid');
    for (const file of manifest.files) if (lstatSync(ownedFile(paths.root, file.path)).size !== file.byteLength)
      throw Error('maintenance_backup_invalid');
    const inspection = inspectStore(paths);
    if (!inspection.ok || inspection.data.schemaVersion !== manifest.schemaVersion || inspection.data.settingsVersion !== manifest.settingsVersion
      || inspection.data.installedReleaseId !== manifest.releaseId)
      throw Error('maintenance_backup_invalid');
    await checkReferences(paths, inspection.data.schemaVersion);
    return ok({ directory: paths.root, manifest });
  } catch { return errorResult('maintenance_backup_invalid'); }
}

export async function verifyRestoredStore(input: ProductPaths, backup: BackupReceipt, rawRelease: PackagedRelease): Promise<Result<{ readable: boolean; gaps: readonly string[] }>> {
  try {
    const paths = checkedPaths(input), release = PackagedReleaseSchema.parse(rawRelease), source = realpathSync(backup.directory);
    if (within(source, paths.root) || within(paths.root, source)) throw Error('maintenance_restore_failed');
    const manifest = backupSchema.parse(jsonFile(source, 'manifest.json'));
    if (!isDeepStrictEqual(manifest, backup.manifest) || new Set(manifest.files.map(file => file.path)).size !== manifest.files.length)
      throw Error('maintenance_restore_failed');
    if (!isDeepStrictEqual(persistentFiles(paths), manifest.files.map(file => file.path).sort())) throw Error('maintenance_restore_failed');
    for (const file of manifest.files) {
      const original = ownedFile(source, file.path), restored = ownedFile(paths.root, file.path);
      if (lstatSync(original).size !== file.byteLength || lstatSync(restored).size !== file.byteLength || !sameBytes(original, restored))
        throw Error('maintenance_restore_failed');
    }
    const installation = existsSync(join(paths.root, 'service-installation.json'))
      ? ServiceInstallationSchema.parse(jsonFile(paths.root, 'service-installation.json')) : null;
    if (installation && (installation.enabled === true || installation.activationOperationId !== null && installation.activationOperationId !== undefined)
      && installation.releaseId !== release.releaseId)
      return errorResult('maintenance_service_release_mismatch');
    const inspection = inspectStore(paths);
    if (!inspection.ok || inspection.data.schemaVersion !== manifest.schemaVersion || inspection.data.settingsVersion !== manifest.settingsVersion
      || inspection.data.installedReleaseId !== manifest.releaseId)
      throw Error('maintenance_restore_failed');
    const gaps = [...manifest.gaps, ...await checkReferences(paths, inspection.data.schemaVersion), 'credential_account_check_and_explicit_new_run_pending'];
    if (installation) {
      gaps.push('service_installation_identity_and_activation_recheck');
      if (installation.dataRoot !== paths.root) gaps.push('service_installation_original_root_mismatch');
    }
    const readable = inspection.data.schemaVersion === release.schemaVersion && inspection.data.settingsVersion === release.settingsVersion;
    if (!readable) gaps.push('matching_old_program_or_explicit_upgrade_required');
    return ok({ readable, gaps: [...new Set(gaps)] });
  } catch { return errorResult('maintenance_restore_failed'); }
}

const restorableService = ServiceInstallationSchema.refine(value => value.enabled === true
  && value.activationOperationId !== null && value.activationOperationId !== undefined
  && value.activationSettingsRevision !== null && value.activationSettingsRevision !== undefined,
'Service restoration requires the original enabled activation facts.');
export const ServiceRestoreIntentSchema = z.object({ version: z.literal(1), backupId: z.string().uuid(),
  backupDirectory: z.string().min(1).refine(value => isAbsolute(value) && resolve(value) === value),
  original: restorableService, targetReleaseId: z.string().uuid() }).strict();
export type ServiceRestoreIntent = z.infer<typeof ServiceRestoreIntentSchema>;
const restoreControl = 'data/service-restore.json';
function restoreFailure(cause: unknown) {
  const code = cause instanceof Error && ['maintenance_service_restore_conflict', 'maintenance_backup_invalid', 'maintenance_service_release_mismatch'].includes(cause.message)
    ? cause.message : 'maintenance_service_restore_failed';
  return fail(appError(code, 'storage', 'Service data restoration is incomplete or unconfirmed. The installation authority and source backup were retained; do not start the service.', true));
}
function dataIdentity(value: ServiceInstallation) {
  const { runtimeRoot: _runtimeRoot, releaseId: _releaseId, ...identity } = value; return identity;
}
function serviceRecord(root: string) {
  const file = ownedFile(root, 'service-installation.json');
  if (lstatSync(file).size > 16384) throw Error('maintenance_service_restore_conflict');
  const bytes = readFileSync(file), installation = restorableService.parse(JSON.parse(bytes.toString('utf8')));
  return { bytes, installation };
}
function restoreIntent(paths: ProductPaths): { intent: ServiceRestoreIntent; bytes: Buffer } | null {
  try { lstatSync(join(paths.root, restoreControl)); }
  catch (cause) { if (cause && typeof cause === 'object' && 'code' in cause && cause.code === 'ENOENT') return null; throw cause; }
  const file = ownedFile(paths.root, restoreControl); if (lstatSync(file).size > 65536) throw Error('maintenance_service_restore_conflict');
  const bytes = readFileSync(file); return { intent: ServiceRestoreIntentSchema.parse(JSON.parse(bytes.toString('utf8'))), bytes };
}
async function serviceCopySource(input: ProductPaths, backup: BackupReceipt, expectedInstallation: ServiceInstallation) {
  const paths = checkedPaths(input), expected = restorableService.parse(expectedInstallation), manifest = backupSchema.parse(backup.manifest);
  const directory = backup.directory, authority = serviceRecord(paths.root);
  if (expected.dataRoot !== paths.root || !isDeepStrictEqual(authority.installation, expected)) throw Error('maintenance_service_restore_conflict');
  const verified = await verifyBackupSnapshot(directory); if (!verified.ok) throw Error('maintenance_backup_invalid');
  const source = verified.data.directory;
  if (source === paths.root || within(source, paths.root)
    || within(paths.root, source) && relative(paths.root, source).replaceAll('\\', '/').split('/')[0] !== 'backups'
    || !isDeepStrictEqual(verified.data.manifest, manifest)) throw Error('maintenance_backup_invalid');
  const snapshot = serviceRecord(source).installation;
  if (!isDeepStrictEqual(dataIdentity(snapshot), dataIdentity(expected))) throw Error('maintenance_service_restore_conflict');
  return { paths, source, manifest, expected, authority: authority.bytes, snapshot };
}
type ServiceCopySource = Awaited<ReturnType<typeof serviceCopySource>>;
function unchangedAuthority(source: ServiceCopySource): void {
  checkedPaths(source.paths);
  if (!serviceRecord(source.paths.root).bytes.equals(source.authority)) throw Error('maintenance_service_restore_conflict');
}
async function verifyServiceMembers(source: ServiceCopySource): Promise<readonly string[]> {
  requireStandaloneDatabase(source.paths);
  const files = source.manifest.files.filter(file => file.path !== 'service-installation.json');
  if (!isDeepStrictEqual(persistentFiles(source.paths).filter(path => path !== 'service-installation.json'), files.map(file => file.path).sort()))
    throw Error('maintenance_service_restore_failed');
  for (const file of files) {
    unchangedAuthority(source);
    const original = ownedFile(source.source, file.path), restored = ownedFile(source.paths.root, file.path);
    if (lstatSync(original).size !== file.byteLength || lstatSync(restored).size !== file.byteLength || !sameBytes(original, restored))
      throw Error('maintenance_service_restore_failed');
  }
  const inspection = inspectStore(source.paths);
  if (!inspection.ok || inspection.data.schemaVersion !== source.manifest.schemaVersion || inspection.data.settingsVersion !== source.manifest.settingsVersion
    || inspection.data.installedReleaseId !== source.manifest.releaseId) throw Error('maintenance_service_restore_failed');
  const gaps = await checkReferences(source.paths, inspection.data.schemaVersion); unchangedAuthority(source);
  if (!isDeepStrictEqual(backupSchema.parse(jsonFile(source.source, 'manifest.json')), source.manifest)) throw Error('maintenance_backup_invalid');
  return [...new Set([...source.manifest.gaps, ...gaps, 'credential_account_check_and_explicit_new_run_pending', 'service_installation_identity_and_activation_recheck'])];
}

/** The caller retains the original Root lease; this is a pure comparison, including after record publication. */
export async function verifyServiceStoreCopy(input: ProductPaths, backup: BackupReceipt, expectedInstallation: ServiceInstallation): Promise<Result<void>> {
  try { await verifyServiceMembers(await serviceCopySource(input, backup, expectedInstallation)); return ok(undefined); }
  catch (cause) { return restoreFailure(cause); }
}

/** SCM is stopped/unregistered and all SQLite/native handles are closed; the caller keeps the original Root lease. */
export async function restoreServiceStore(input: ProductPaths, backup: BackupReceipt, original: ServiceInstallation,
  targetRelease: PackagedRelease): Promise<Result<{ backupId: string; gaps: readonly string[] }>> {
  try {
    const expected = restorableService.parse(original), release = PackagedReleaseSchema.parse(targetRelease), paths = checkedPaths(input);
    const current = serviceRecord(paths.root), source = await serviceCopySource(paths, backup, current.installation);
    if (source.snapshot.releaseId !== release.releaseId || source.manifest.releaseId !== release.releaseId
      || source.manifest.schemaVersion !== release.schemaVersion || source.manifest.settingsVersion !== release.settingsVersion)
      throw Error('maintenance_service_release_mismatch');
    const target = { ...expected, runtimeRoot: source.snapshot.runtimeRoot, releaseId: release.releaseId };
    const intent = ServiceRestoreIntentSchema.parse({ version: 1, backupId: source.manifest.backupId,
      backupDirectory: source.source, original: expected, targetReleaseId: release.releaseId });
    let guarded = restoreIntent(paths);
    if (guarded && !isDeepStrictEqual(guarded.intent, intent)
      || !isDeepStrictEqual(current.installation, expected) && (!guarded || !isDeepStrictEqual(current.installation, target)))
      throw Error('maintenance_service_restore_conflict');
    const files = source.manifest.files.filter(file => file.path !== 'service-installation.json'), before = persistentFiles(paths);
    requireStandaloneDatabase(paths);
    if (!guarded) {
      const handle = await open(join(paths.root, restoreControl), 'wx', 0o600);
      try { await handle.writeFile(JSON.stringify(intent, null, 2) + '\n'); await handle.sync(); }
      finally { await handle.close(); }
      guarded = restoreIntent(paths);
    }
    if (!guarded || !isDeepStrictEqual(guarded.intent, intent)) throw Error('maintenance_service_restore_conflict');
    const guardBytes = guarded.bytes;
    const check = () => {
      unchangedAuthority(source);
      if (!restoreIntent(paths)?.bytes.equals(guardBytes)) throw Error('maintenance_service_restore_conflict');
    };
    const targetFile = (name: string): string => {
      if (!safeRelative(name)) throw Error('maintenance_service_restore_failed');
      let targetPath = paths.root;
      const parts = name.split('/');
      for (const [index, part] of parts.entries()) {
        targetPath = join(targetPath, part);
        try {
          const stat = lstatSync(targetPath);
          if (stat.isSymbolicLink() || realpathSync(targetPath) !== targetPath
            || (index === parts.length - 1 ? !stat.isFile() : !stat.isDirectory())) throw Error('maintenance_service_restore_failed');
        } catch (cause) { if (!cause || typeof cause !== 'object' || !('code' in cause) || cause.code !== 'ENOENT') throw cause; }
      }
      return targetPath;
    };
    for (const file of files) {
      const parts = file.path.split('/');
      for (let count = 1; count < parts.length; count++) {
        check(); targetFile(file.path);
        const directory = join(paths.root, ...parts.slice(0, count));
        if (!existsSync(directory)) await mkdir(directory, { mode: 0o700 });
      }
      check(); const destination = targetFile(file.path), temporary = file.path + '.restore-' + randomUUID() + '.tmp';
      let ownsTemporary = false;
      try {
        await copyFile(ownedFile(source.source, file.path), targetFile(temporary), 1);
        ownsTemporary = true;
        const handle = await open(ownedFile(paths.root, temporary), 'r+'); try { await handle.sync(); } finally { await handle.close(); }
        if (!sameBytes(ownedFile(source.source, file.path), ownedFile(paths.root, temporary))) throw Error('maintenance_service_restore_failed');
        check(); targetFile(file.path); ownsTemporary = false; await rename(ownedFile(paths.root, temporary), destination);
      } finally {
        if (ownsTemporary && existsSync(join(paths.root, temporary))) await unlink(ownedFile(paths.root, temporary));
      }
    }
    const selected = new Set(source.manifest.files.map(file => file.path));
    for (const name of before.filter(name => name !== 'service-installation.json' && !selected.has(name))) { check(); await unlink(ownedFile(paths.root, name)); }
    check(); const gaps = await verifyServiceMembers(source);
    return ok({ backupId: source.manifest.backupId, gaps });
  } catch (cause) { return restoreFailure(cause); }
}

/** Only after matching record/XML publication; absence is idempotent only when the same snapshot still fully matches. */
export async function finishServiceRestore(input: ProductPaths, backup: BackupReceipt, expectedTarget: ServiceInstallation,
  targetRelease: PackagedRelease): Promise<Result<void>> {
  try {
    const release = PackagedReleaseSchema.parse(targetRelease), source = await serviceCopySource(input, backup, expectedTarget), guarded = restoreIntent(source.paths);
    if (source.expected.releaseId !== release.releaseId || source.expected.runtimeRoot !== source.snapshot.runtimeRoot
      || source.snapshot.releaseId !== release.releaseId || source.manifest.releaseId !== release.releaseId)
      throw Error('maintenance_service_release_mismatch');
    if (guarded) {
      const target = { ...guarded.intent.original, runtimeRoot: source.snapshot.runtimeRoot, releaseId: release.releaseId };
      if (guarded.intent.backupId !== source.manifest.backupId || guarded.intent.backupDirectory !== source.source
        || guarded.intent.targetReleaseId !== release.releaseId || !isDeepStrictEqual(target, source.expected)) throw Error('maintenance_service_restore_conflict');
    }
    await verifyServiceMembers(source);
    if (guarded) {
      if (!restoreIntent(source.paths)?.bytes.equals(guarded.bytes)) throw Error('maintenance_service_restore_conflict');
      unchangedAuthority(source); await unlink(ownedFile(source.paths.root, restoreControl));
    }
    return ok(undefined);
  } catch (cause) { return restoreFailure(cause); }
}
