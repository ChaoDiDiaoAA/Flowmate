import { expect, it } from 'bun:test';
import { Database } from 'bun:sqlite';
import { copyFileSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, symlinkSync, writeFileSync, unlinkSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { mkdtempSync, deferCleanup } from '../../support/resources.ts';
import { openDatabase } from '../../../packages/core/src/storage/database.ts';
import { createFileStore } from '../../../packages/core/src/storage/file-store.ts';
import { defaultProductSettings } from '../../../packages/core/src/configuration/settings.ts';
import { acquireProductControllerLock, resolveProductPaths } from '../../../packages/shared/src/index.ts';
import { PACKAGED_REQUIRED_FILES, type PackagedRelease } from '../../../packages/shared/src/runtime-layout.ts';
import { inspectStore, backupStore, prepareStoreUpgrade, verifyRestoredStore, type BackupReceipt } from '../../../packages/core/src/storage/maintenance.ts';
import { createApplication } from '../../../apps/composition.ts';
import { makeSelectedCandidate } from '../../support/selected-candidate.ts';
import { createInvoiceEditService } from '../../../packages/core/src/invoice-edit/service.ts';
import { createManagedFileContents } from '../../../packages/core/src/storage/managed-file-contents.ts';
import { createResourceBundles } from '../../../packages/core/src/skill-hub/bundle.ts';
import { FrozenResourcesSchema } from '@flowmate/contracts';
import { researchFixture, researchPlan, researchNeed as need } from '../../support/research.ts';

const release: PackagedRelease = { version: 1, releaseId: '43f163a3-b56f-4133-b04d-8bbf92eb1e52', productVersion: '0.1.0',
  platform: 'win32', arch: 'x64', bunVersion: '1.4.0',
  electronVersion: '44.4.5', sdkVersion: '0.85.1', pluginVersion: '0.19.0', schemaVersion: 20, settingsVersion: 7,
  files: PACKAGED_REQUIRED_FILES };

for (const unusable of [false, true]) it('checks an entirely missing referenced bundle without clearing unusable history, unusable=' + unusable, async () => {
  const store = makeSelectedCandidate(), paths = resolveProductPaths(store.root); if (!paths.ok) throw Error(paths.error.code);
  const bundles = createResourceBundles(join(store.root, 'runtime/resource-bundles'), createManagedFileContents(store.db));
  const bundleId = bundles.publish([], { entries: [] });
  const frozen = FrozenResourcesSchema.parse({ version: 2, policyVersion: 'p11-resources-v1', settingsRevision: 1,
    bundleId, bundleDirectory: join(store.root, 'runtime/resource-bundles', bundleId), prompt: null,
    manifests: [], selectedSkills: [], discoveredSkills: [], excludedSkills: [], skillIndex: { entries: [] } });
  store.db.query("UPDATE runs SET config_json=json_set(config_json,'$.resources',json(?)) WHERE id=?")
    .run(JSON.stringify(frozen), store.runId);
  if (unusable) store.db.query(`INSERT INTO session_native_history(session_id,storage_version,header_json,leaf_id,entry_count,unusable)
    VALUES(?,1,?,NULL,0,1) ON CONFLICT(session_id) DO UPDATE SET unusable=1`).run(store.session.sessionId,
      JSON.stringify({ type: 'session', version: 3, id: store.session.nativeSessionId, timestamp: store.stamp, cwd: store.root }));
  unlinkSync(join(frozen.bundleDirectory, 'bundle.json'));
  store.db.query("DELETE FROM managed_file_contents WHERE owner_kind='resource-bundle' AND owner_id=?").run(bundleId);
  store.db.close(); copyFileSync(join(store.root, 'data/flowmate.sqlite'), paths.data.databaseFile);
  writeFileSync(join(store.root, 'data/settings.json'), JSON.stringify(defaultProductSettings()));
  const lease = await acquireProductControllerLock(paths.data); if (!lease.ok) throw Error(lease.error.code);
  try {
    const parent = mkdtempSync(join(tmpdir(), 'flowmate-missing-bundle-'));
    const backup = await backupStore(paths.data, join(parent, 'snapshot'));
    if (unusable) {
      expect(backup.ok).toBe(true); if (!backup.ok) throw Error(backup.error.code);
      expect(backup.data.manifest.gaps).toContain('resource_bundle_unavailable_for_unusable_history:' + bundleId);
      const original = new Database(paths.data.databaseFile, { readonly: true });
      try { expect(original.query('SELECT unusable FROM session_native_history WHERE session_id=?').get(store.session.sessionId)).toEqual({ unusable: 1 }); }
      finally { original.close(); }
    } else expect(backup).toMatchObject({ ok: false, error: { code: 'maintenance_reference_missing' } });
  } finally { await lease.data.release(); }
});

it('backs up actual accepted invoice exports through their original managed-byte reader', async () => {
  const store = makeSelectedCandidate(), resolved = resolveProductPaths(store.root); if (!resolved.ok) throw Error(resolved.error.code);
  const files = createFileStore(resolved.data, store.documents);
  const edits = createInvoiceEditService({ candidates: store.candidates, files, now: () => store.stamp,
    validate: () => ({ ok: true, data: { checks: [], issues: [] } }) });
  const accepted = edits.accept({ operationRef: 'p17-accept-export', jobId: store.jobId, candidateId: store.candidateId,
    expectedCandidateId: store.candidateId, expectedRevision: store.selectedWorkspace.revision, dirty: false });
  expect(accepted.ok).toBe(true);
  const exported = edits.export({ operationRef: 'p17-export', candidateId: store.candidateId, format: 'json' });
  expect(exported.ok).toBe(true); if (!exported.ok) throw Error(exported.error.code);
  store.db.close(); copyFileSync(join(store.root, 'data/flowmate.sqlite'), resolved.data.databaseFile);
  writeFileSync(join(store.root, 'data/settings.json'), JSON.stringify(defaultProductSettings()));
  const lease = await acquireProductControllerLock(resolved.data); if (!lease.ok) throw Error(lease.error.code);
  try {
    const parent = mkdtempSync(join(tmpdir(), 'flowmate-export-backup-'));
    const backup = await backupStore(resolved.data, join(parent, 'snapshot'));
    expect(backup.ok).toBe(true); if (!backup.ok) throw Error(backup.error.code);
    expect(readFileSync(join(backup.data.directory, exported.data.relativePath))).toEqual(readFileSync(join(store.root, exported.data.relativePath)));
  } finally { await lease.data.release(); }
});

for (const missing of [false, true]) it('backs up a real saved research source using its database identities, missing=' + missing, async () => {
  const body = 'Independent installed research evidence.';
  const f = await researchFixture((_request, index) => index === 1
    ? { tool: 'save_research_plan', args: { ...researchPlan, sourcePolicy: f.task.sourcePolicy }, id: 'plan' }
    : index === 3 ? { tool: 'read_research_local', args: { artifactId: f.task.sourcePolicy.artifactIds[0], documentId: null }, id: 'read' }
      : { text: 'The selected evidence was saved.' }, undefined, { material: body });
  await f.run(f.request(1));
  const task = need(await f.app.queryResearchTask(f.task.researchId));
  const plan = need(await f.app.queryResearchPlan({ researchId: task.researchId, planId: task.currentPlanId! }));
  await f.run(f.request(2, { researchId: task.researchId, phase: 'researching', plan: { planId: plan.planId, revision: plan.revision } }));
  const source = need(await f.app.listResearchSources({ researchId: task.researchId })).items[0]!;
  expect(need(await f.app.close())).toMatchObject({ closed: true, stopped: true });
  const db = new Database(f.paths.databaseFile, { readonly: true });
  try {
    const row = db.query('SELECT research_id,tool_call_id,body_json FROM research_sources WHERE id=?').get(source.sourceSnapshotId) as {
      research_id: number; tool_call_id: number; body_json: string };
    expect(row.research_id).toBe(source.researchId); expect(row.tool_call_id).toBe(source.toolCallId);
    expect(JSON.parse(row.body_json)).not.toHaveProperty('researchId');
    expect(JSON.parse(row.body_json)).not.toHaveProperty('toolCallId');
  } finally { db.close(); }
  writeFileSync(join(f.paths.root, 'data/settings.json'), JSON.stringify(defaultProductSettings()));
  if (missing) unlinkSync(join(f.paths.root, source.relativePath));
  const original = readFileSync(f.paths.databaseFile), calls = f.requests.length;
  const lease = need(await acquireProductControllerLock(f.paths));
  try {
    const destination = join(mkdtempSync(join(tmpdir(), 'flowmate-research-backup-')), 'snapshot');
    const backed = await backupStore(f.paths, destination);
    if (missing) expect(backed).toMatchObject({ ok: false, error: { code: 'maintenance_reference_missing' } });
    else {
      expect(backed).toMatchObject({ ok: true });
      if (!backed.ok) throw Error(backed.error.code);
      expect(readFileSync(join(destination, source.relativePath), 'utf8')).toBe(body);
      expect(backed.data.manifest.gaps).not.toContain('unpublished_managed_content:research-source:' + source.toolCallId);
      expect(await verifyRestoredStore(restoreCopy(backed.data), backed.data, release)).toMatchObject({ ok: true, data: { readable: true } });
      expect(await prepareStoreUpgrade(f.paths, release)).toMatchObject({ ok: true });
    }
    expect(readFileSync(f.paths.databaseFile).equals(original)).toBe(true);
    expect(f.requests).toHaveLength(calls);
  } finally { await lease.release(); }
});

it('preserves unpublished managed content as a gap and copies registered resource filenames ending in tmp', async () => {
  const { root, paths, destination } = await fixture();
  const db = openDatabase(paths); if (!db.ok) throw Error(db.error.code);
  const content = Buffer.from('Preserved resource body'), relativePath = 'skills/example/v1/reference.tmp';
  mkdirSync(dirname(join(root, 'runtime/resource-bundles/historical-bundle', relativePath)), { recursive: true });
  writeFileSync(join(root, 'runtime/resource-bundles/historical-bundle', relativePath), content);
  db.data.contents.remember({ ownerKind: 'resource-bundle', ownerId: 'historical-bundle', relativePath }, content);
  db.data.contents.remember({ ownerKind: 'resource-bundle', ownerId: 'failed-publication', relativePath: 'bundle.json' }, Buffer.from('{}'));
  db.data.contents.remember({ ownerKind: 'research-source', ownerId: '999', relativePath: 'artifacts/research/999/source-999.txt' }, Buffer.from('Unpublished source'));
  db.data.contents.remember({ ownerKind: 'invoice-export', ownerId: '999', relativePath: 'outputs/invoice-999-result-1.json' }, Buffer.from('{}'));
  db.data.close();
  const backup = await backupStore(paths, destination);
  expect(backup.ok).toBe(true); if (!backup.ok) throw Error(backup.error.code);
  expect(readFileSync(join(destination, 'runtime/resource-bundles/historical-bundle', relativePath))).toEqual(content);
  expect(backup.data.manifest.gaps).toContain('unpublished_managed_content:resource-bundle:failed-publication');
  expect(existsSync(join(destination, 'outputs/invoice-999-result-1.json'))).toBe(false);
});

async function fixture(populated = true) {
  const root = mkdtempSync(join(tmpdir(), 'flowmate-maintenance-')), paths = resolveProductPaths(root);
  if (!paths.ok) throw Error(paths.error.code);
  const lease = await acquireProductControllerLock(paths.data); if (!lease.ok) throw Error(lease.error.code);
  deferCleanup(() => lease.data.release());
  if (populated) {
    const store = openDatabase(paths.data); if (!store.ok) throw Error(store.error.code);
    const files = createFileStore(paths.data, store.data.documents);
    const material = files.publishResearchMaterial({ title: 'Synthetic maintenance material', format: 'text', text: 'Original synthetic body',
      at: '2026-10-17T00:00:00.000Z' });
    if (!material.ok) throw Error(material.error.code);
    const registered = store.data.research.registerMaterial(material.data); if (!registered.ok) throw Error(registered.error.code);
    const bundlePath = 'skills/example/v1/SKILL.md';
    const bundle = join(root, 'runtime/resource-bundles/historical-bundle', bundlePath);
    mkdirSync(dirname(bundle), { recursive: true }); writeFileSync(bundle, 'Historical synthetic Skill');
    store.data.contents.remember({ ownerKind: 'resource-bundle', ownerId: 'historical-bundle', relativePath: bundlePath }, Buffer.from('Historical synthetic Skill'));
    store.data.contents.remember({ ownerKind: 'resource-author', ownerId: 'skill:example:v1', relativePath: 'SKILL.md' }, Buffer.from('Original author body retained only in SQLite'));
    store.data.close();
    writeFileSync(join(root, 'data/settings.json'), JSON.stringify(defaultProductSettings()));
    mkdirSync(join(root, 'security/credentials'), { recursive: true });
    writeFileSync(join(root, 'security/credentials/synthetic-ref.json'), JSON.stringify({ version: 1, ciphertext: Buffer.from('synthetic encrypted bytes').toString('base64') }));
    mkdirSync(join(root, 'runtime/temporary-run'), { recursive: true }); writeFileSync(join(root, 'runtime/temporary-run/transient.txt'), 'not persistent');
    mkdirSync(join(root, 'outputs'), { recursive: true }); writeFileSync(join(root, 'outputs/receipt.json'), '{"synthetic":true}');
  }
  const parent = mkdtempSync(join(tmpdir(), 'flowmate-backups-'));
  return { root, paths: paths.data, destination: join(parent, 'snapshot'), lease: lease.data };
}

function restoreCopy(backup: BackupReceipt) {
  const root = mkdtempSync(join(tmpdir(), 'flowmate-restored-'));
  for (const file of backup.manifest.files) {
    const target = join(root, file.path); mkdirSync(dirname(target), { recursive: true });
    copyFileSync(join(backup.directory, file.path), target);
  }
  const paths = resolveProductPaths(root); if (!paths.ok) throw Error(paths.error.code); return paths.data;
}

it('inspects an empty root without creating a database or inventing an old backup', async () => {
  const { paths, root } = await fixture(false);
  writeFileSync(join(root, 'Local State'), JSON.stringify({ os_crypt: { encrypted_key: 'synthetic-new-platform-key' } }));
  expect(inspectStore(paths)).toEqual({ ok: true, data: { schemaVersion: null, settingsVersion: null, installedReleaseId: null, journalMode: null } });
  expect(await prepareStoreUpgrade(paths, release)).toEqual({ ok: true, data: null });
  expect(existsSync(paths.databaseFile)).toBe(false); expect(existsSync(join(root, 'backups'))).toBe(false);
});

it('backs up committed SQLite and all persistent references, then verifies an isolated copy without changing the source', async () => {
  const { root, paths, destination } = await fixture();
  const original = readFileSync(paths.databaseFile), settings = readFileSync(join(root, 'data/settings.json'));
  const backed = await backupStore(paths, destination); expect(backed.ok).toBe(true); if (!backed.ok) return;
  expect(backed.data.manifest.schemaVersion).toBe(20); expect(backed.data.manifest.settingsVersion).toBe(7);
  expect(backed.data.manifest.files.map(file => file.path)).toContain('security/credentials/synthetic-ref.json');
  expect(backed.data.manifest.files.map(file => file.path)).toContain('runtime/resource-bundles/historical-bundle/skills/example/v1/SKILL.md');
  expect(backed.data.manifest.files.some(file => file.path.includes('temporary-run') || file.path.endsWith('.lock'))).toBe(false);
  expect(readFileSync(paths.databaseFile).equals(original)).toBe(true); expect(readFileSync(join(root, 'data/settings.json')).equals(settings)).toBe(true);
  const restored = restoreCopy(backed.data), before = readFileSync(restored.databaseFile);
  expect(await verifyRestoredStore(restored, backed.data, release)).toMatchObject({ ok: true, data: { readable: true } });
  expect(readFileSync(restored.databaseFile).equals(before)).toBe(true);
  const db = new Database(restored.databaseFile, { readonly: true });
  try { expect(db.query('SELECT COUNT(*) AS count FROM managed_file_contents').get()).toEqual({ count: 3 }); }
  finally { db.close(); }
});

it('backs up Electron Local State with encrypted credentials and rejects a restore missing its original key state', async () => {
  const { root, paths, destination } = await fixture();
  const localState = JSON.stringify({ os_crypt: { encrypted_key: 'synthetic-platform-protected-key', audit_enabled: true } });
  writeFileSync(join(root, 'Local State'), localState);
  const backed = await backupStore(paths, destination); expect(backed.ok).toBe(true); if (!backed.ok) throw Error(backed.error.code);
  expect(backed.data.manifest.files.map(file => file.path)).toContain('Local State');
  expect(readFileSync(join(destination, 'Local State'), 'utf8')).toBe(localState);
  const restored = restoreCopy(backed.data);
  expect(await verifyRestoredStore(restored, backed.data, release)).toMatchObject({ ok: true, data: { readable: true } });
  unlinkSync(join(restored.root, 'Local State'));
  expect(await verifyRestoredStore(restored, backed.data, release)).toMatchObject({ ok: false, error: { code: 'maintenance_restore_failed' } });
  expect(readFileSync(join(root, 'Local State'), 'utf8')).toBe(localState);
});

it('detects a same-length edit in a restored file instead of trusting manifest lengths', async () => {
  const { paths, destination } = await fixture(), backed = await backupStore(paths, destination);
  if (!backed.ok) throw Error(backed.error.code);
  const restored = restoreCopy(backed.data), target = join(restored.root, 'outputs/receipt.json');
  const bytes = readFileSync(target); bytes[bytes.indexOf('true')] = 'f'.charCodeAt(0); writeFileSync(target, bytes);
  expect((await verifyRestoredStore(restored, backed.data, release)).ok).toBe(false);
  expect(readFileSync(join(backed.data.directory, 'outputs/receipt.json'), 'utf8')).toBe('{"synthetic":true}');
});

it('rejects a restored root mixed with persistent files that do not belong to the selected backup', async () => {
  const { paths, destination } = await fixture(), backed = await backupStore(paths, destination);
  if (!backed.ok) throw Error(backed.error.code);
  const restored = restoreCopy(backed.data); writeFileSync(join(restored.root, 'outputs/unrelated.json'), '{"other":true}');
  expect((await verifyRestoredStore(restored, backed.data, release)).ok).toBe(false);
});

it('backs up before Settings migration, records only a successful installed open, and does not repeat that backup on reopen', async () => {
  const { paths, root, lease } = await fixture(); await lease.release();
  const settingsFile = join(root, 'data/settings.json'); writeFileSync(settingsFile, JSON.stringify({ ...defaultProductSettings(), version: 6 }));
  const options = { paths, installedRelease: release, resourceRoot: fileURLToPath(new URL('../../../resources', import.meta.url)) };
  const opened = await createApplication(options);
  expect(opened.ok).toBe(true); if (!opened.ok) return;
  try {
    const backups = readdirSync(join(root, 'backups')); expect(backups).toHaveLength(1);
    expect(JSON.parse(readFileSync(join(root, 'backups', backups[0]!, 'data/settings.json'), 'utf8')).version).toBe(6);
    expect(JSON.parse(readFileSync(settingsFile, 'utf8')).version).toBe(7);
    expect(JSON.parse(readFileSync(join(root, 'data/installed-release.json'), 'utf8'))).toEqual({ version: 1,
      releaseId: release.releaseId, productVersion: release.productVersion, schemaVersion: 20, settingsVersion: 7 });
  } finally { await opened.data.close(); }
  const again = await createApplication(options); expect(again.ok).toBe(true);
  if (again.ok) await again.data.close();
  expect(readdirSync(join(root, 'backups'))).toHaveLength(1);
});

it('retains a complete pre-upgrade snapshot and original Settings when a real SQLite migration fails', async () => {
  const { root, paths, lease } = await fixture(false);
  const db = new Database(paths.databaseFile, { create: true });
  db.exec(readFileSync(new URL('../../../packages/core/src/storage/migrations/001_provider.sql', import.meta.url), 'utf8'));
  db.exec("CREATE TRIGGER fail_upgrade BEFORE INSERT ON schema_migrations WHEN NEW.version=2 BEGIN SELECT RAISE(ABORT,'synthetic migration failure'); END;"); db.close();
  const settings = JSON.stringify({ ...defaultProductSettings(), version: 6 }); writeFileSync(join(root, 'data/settings.json'), settings);
  await lease.release();
  const opened = await createApplication({ paths, installedRelease: release });
  if (opened.ok) await opened.data.close();
  expect(opened.ok).toBe(false);
  const backups = readdirSync(join(root, 'backups')); expect(backups).toHaveLength(1);
  expect(existsSync(join(root, 'backups', backups[0]!, 'manifest.json'))).toBe(true);
  expect(readFileSync(join(root, 'data/settings.json'), 'utf8')).toBe(settings);
  expect(existsSync(join(root, 'data/installed-release.json'))).toBe(false);
  const retryLease = await acquireProductControllerLock(paths); expect(retryLease.ok).toBe(true);
  if (retryLease.ok) await retryLease.data.release();
});

it('refuses upgrading with a missing required artifact and leaves the original database and Settings intact', async () => {
  const { paths, root } = await fixture(), before = readFileSync(paths.databaseFile), settings = readFileSync(join(root, 'data/settings.json'));
  const db = new Database(paths.databaseFile, { readonly: true });
  const artifact = db.query('SELECT relative_path FROM artifacts LIMIT 1').get() as { relative_path: string }; db.close();
  rmSync(join(root, artifact.relative_path));
  const result = await prepareStoreUpgrade(paths, release);
  expect(result).toMatchObject({ ok: false, error: { code: 'maintenance_reference_missing' } });
  expect(readFileSync(paths.databaseFile).equals(before)).toBe(true); expect(readFileSync(join(root, 'data/settings.json')).equals(settings)).toBe(true);
});

it('refuses linked references and unsafe or existing destinations without copying outside owned paths', async () => {
  const { paths, root, destination } = await fixture(), outside = mkdtempSync(join(tmpdir(), 'flowmate-outside-maintenance-'));
  for (const target of [root, join(root, 'artifacts/backup'), outside]) expect((await backupStore(paths, target)).ok).toBe(false);
  symlinkSync(outside, join(root, 'outputs/escape'), 'junction');
  expect((await backupStore(paths, destination)).ok).toBe(false);
  expect(existsSync(join(destination, 'manifest.json'))).toBe(false); expect(readdirSync(outside)).toEqual([]);
});

it('backs up a different release even at the same Schema and skips only the matching successful release', async () => {
  const { root, paths } = await fixture();
  writeFileSync(join(root, 'data/installed-release.json'), JSON.stringify({ version: 1, releaseId: release.releaseId,
    productVersion: release.productVersion, schemaVersion: 20, settingsVersion: 7 }));
  expect(await prepareStoreUpgrade(paths, release)).toEqual({ ok: true, data: null });
  const next = { ...release, releaseId: '54ec481d-a0d9-4cf9-8143-3600e67f77b9' };
  const backed = await prepareStoreUpgrade(paths, next); expect(backed.ok).toBe(true);
  if (backed.ok) { expect(backed.data?.manifest.releaseId).toBe(release.releaseId); expect(backed.data?.manifest.schemaVersion).toBe(20); }
  expect(readdirSync(join(root, 'backups'))).toHaveLength(1);
  expect(JSON.parse(readFileSync(join(root, 'data/installed-release.json'), 'utf8')).releaseId).toBe(release.releaseId);
});

it('rejects future or nonconsecutive Schema and corrupt Settings before any upgrade writes', async () => {
  for (const kind of ['future', 'gap', 'settings']) {
    const { root, paths } = await fixture();
    if (kind === 'settings') writeFileSync(join(root, 'data/settings.json'), '{"version":8}');
    else {
      const db = new Database(paths.databaseFile);
      if (kind === 'future') db.query('INSERT INTO schema_migrations(version,applied_at) VALUES(21,?)').run('2026-10-17T00:00:00.000Z');
      else db.query('DELETE FROM schema_migrations WHERE version=19').run(); db.close();
    }
    const before = readFileSync(paths.databaseFile), settings = readFileSync(join(root, 'data/settings.json'));
    expect((await prepareStoreUpgrade(paths, release)).ok).toBe(false);
    expect(existsSync(join(root, 'backups'))).toBe(false);
    expect(readFileSync(paths.databaseFile).equals(before)).toBe(true); expect(readFileSync(join(root, 'data/settings.json')).equals(settings)).toBe(true);
  }
});

it('checks old contiguous data physically but does not migrate it or claim direct readability', async () => {
  const { root, paths, destination } = await fixture(false);
  mkdirSync(dirname(paths.databaseFile), { recursive: true });
  const db = new Database(paths.databaseFile, { create: true });
  db.exec(readFileSync(new URL('../../../packages/core/src/storage/migrations/001_provider.sql', import.meta.url), 'utf8')); db.close();
  writeFileSync(join(root, 'data/settings.json'), JSON.stringify({ ...defaultProductSettings(), version: 6 }));
  const backed = await backupStore(paths, destination); if (!backed.ok) throw Error(backed.error.code);
  const restored = restoreCopy(backed.data), before = readFileSync(restored.databaseFile);
  expect(await verifyRestoredStore(restored, backed.data, release)).toMatchObject({ ok: true, data: { readable: false } });
  expect(readFileSync(restored.databaseFile).equals(before)).toBe(true);
  expect(JSON.parse(readFileSync(join(restored.root, 'data/settings.json'), 'utf8')).version).toBe(6);
});

it('checkpoints a committed crash WAL before copying and preserves its committed rows', async () => {
  const { paths, root, destination } = await fixture();
  const program = `import {Database} from 'bun:sqlite'; const db=new Database(process.argv[1]);
    db.exec('PRAGMA journal_mode=WAL; PRAGMA wal_autocheckpoint=0; CREATE TABLE wal_probe(value TEXT);');
    db.query('INSERT INTO wal_probe VALUES(?)').run('committed'); console.log('committed'); setInterval(()=>{},1000);`;
  const child = Bun.spawn([process.execPath, '--no-env-file', '-e', program, paths.databaseFile],
    { cwd: root, stdout: 'pipe', stderr: 'pipe', env: {} });
  deferCleanup(async () => { if (child.exitCode === null) child.kill(); await child.exited; });
  const reader = child.stdout.getReader(); await reader.read(); reader.releaseLock();
  child.kill(); await child.exited;
  expect(existsSync(paths.databaseFile + '-wal')).toBe(true);
  const backed = await backupStore(paths, destination); expect(backed.ok).toBe(true); if (!backed.ok) return;
  const db = new Database(join(backed.data.directory, 'data/app.sqlite'), { readonly: true });
  try { expect(db.query('SELECT * FROM wal_probe').all()).toEqual([{ value: 'committed' }]); }
  finally { db.close(); }
});

it('recovers a real crash rollback journal before installed upgrade inspection without retaining uncommitted rows', async () => {
  const { paths, root, lease } = await fixture();
  const program = `import {Database} from 'bun:sqlite'; const db=new Database(process.argv[1]);
    db.exec('PRAGMA journal_mode=DELETE; PRAGMA cache_size=1; CREATE TABLE rollback_probe(value BLOB);');
    db.exec('BEGIN IMMEDIATE'); for(let index=0;index<10;index++)db.exec('INSERT INTO rollback_probe VALUES(zeroblob(100000))');
    console.log('uncommitted pages spilled'); setInterval(()=>{},1000);`;
  const child = Bun.spawn([process.execPath, '--no-env-file', '-e', program, paths.databaseFile],
    { cwd: root, stdout: 'pipe', stderr: 'pipe', env: {} });
  deferCleanup(async () => { if (child.exitCode === null) child.kill(); await child.exited; });
  const reader = child.stdout.getReader(); await reader.read(); reader.releaseLock(); child.kill(); await child.exited;
  expect(existsSync(paths.databaseFile + '-journal')).toBe(true);
  expect(inspectStore(paths).ok).toBe(false);
  await lease.release();
  const opened = await createApplication({ paths, installedRelease: release,
    resourceRoot: fileURLToPath(new URL('../../../resources', import.meta.url)) });
  if (opened.ok) await opened.data.close();
  expect(opened.ok).toBe(true);
  const db = new Database(paths.databaseFile, { readonly: true });
  try { expect(db.query('SELECT COUNT(*) AS count FROM rollback_probe').get()).toEqual({ count: 0 }); }
  finally { db.close(); }
  const snapshots = readdirSync(join(root, 'backups'));
  expect(snapshots).toHaveLength(1); expect(existsSync(join(root, 'backups', snapshots[0]!, 'manifest.json'))).toBe(true);
  const backed = new Database(join(root, 'backups', snapshots[0]!, 'data/app.sqlite'), { readonly: true });
  try { expect(backed.query('SELECT COUNT(*) AS count FROM rollback_probe').get()).toEqual({ count: 0 }); }
  finally { backed.close(); }
});

it('does not create an empty database when persisted business files have lost their SQLite controller facts', async () => {
  const { root, paths } = await fixture(); rmSync(paths.databaseFile);
  expect(await prepareStoreUpgrade(paths, release)).toMatchObject({ ok: false, error: { code: 'maintenance_store_incompatible' } });
  expect(existsSync(paths.databaseFile)).toBe(false); expect(existsSync(join(root, 'backups'))).toBe(false);
});

it.each([
  { file: 'data/settings.json', content: JSON.stringify(defaultProductSettings()) },
  { file: 'security/credentials/preserved.json', content: JSON.stringify({ version: 1, ciphertext: 'synthetic-encrypted-configuration' }) },
])('does not treat retained product configuration without its database as a first empty root: $file', async ({ file, content }) => {
  const { root, paths } = await fixture(false);
  mkdirSync(dirname(join(root, file)), { recursive: true }); writeFileSync(join(root, file), content);
  expect(await prepareStoreUpgrade(paths, release)).toMatchObject({ ok: false, error: { code: 'maintenance_store_incompatible' } });
  expect(existsSync(paths.databaseFile)).toBe(false); expect(existsSync(join(root, 'backups'))).toBe(false);
  expect(readFileSync(join(root, file), 'utf8')).toBe(content);
});

it('refuses a new controller when only historical resource or subagent files remain without SQLite', async () => {
  for (const file of ['runtime/resource-bundles/retained/bundle.json', 'runtime/subagents/retained.md']) {
    const { root, paths } = await fixture(false);
    mkdirSync(dirname(join(root, file)), { recursive: true }); writeFileSync(join(root, file), 'Retained history');
    expect(await prepareStoreUpgrade(paths, release)).toMatchObject({ ok: false, error: { code: 'maintenance_store_incompatible' } });
    expect(existsSync(paths.databaseFile)).toBe(false); expect(existsSync(join(root, 'backups'))).toBe(false);
  }
});

it('refuses a backup while the application still holds its exclusive database connection', async () => {
  const { paths, destination } = await fixture(), opened = openDatabase(paths);
  if (!opened.ok) throw Error(opened.error.code);
  try { expect((await backupStore(paths, destination)).ok).toBe(false); expect(existsSync(destination)).toBe(false); }
  finally { opened.data.close(); }
});

async function maintenanceExecutable() {
  const root = mkdtempSync(join(tmpdir(), 'flowmate-maintenance 中文-')), runtime = join(root, 'resources/flowmate-runtime');
  for (const file of PACKAGED_REQUIRED_FILES) {
    const path = join(runtime, file); mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, file === 'sdk/package.json' ? '{"version":"0.85.1"}' : 'synthetic asset, never executed');
  }
  writeFileSync(join(runtime, 'release.json'), JSON.stringify({ ...release, files: [...PACKAGED_REQUIRED_FILES] }));
  const built = await Bun.build({ entrypoints: [fileURLToPath(new URL('../../../apps/maintenance/main.ts', import.meta.url))],
    outdir: join(runtime, 'apps'), target: 'bun', format: 'esm', splitting: false, sourcemap: 'none',
    naming: { entry: 'maintenance.js', chunk: '[name].js', asset: '[name].[ext]' }, metafile: true });
  if (!built.success) throw Error('Maintenance fixture did not build');
  expect(Object.keys(built.metafile?.inputs ?? {}).some(path => /node_modules[\\/]@earendil-works/.test(path))).toBe(false);
  return join(runtime, 'apps/maintenance.js');
}

async function command(entry: string, argv: string[]) {
  const child = Bun.spawn([process.execPath, '--no-env-file', entry, ...argv], { stdout: 'pipe', stderr: 'pipe', env: {} });
  deferCleanup(async () => { if (child.exitCode === null) child.kill(); await child.exited; });
  const [stdout, stderr, code] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
  expect(stderr).toBe(''); expect(Buffer.byteLength(stdout)).toBeLessThanOrEqual(65_536);
  return { code, output: JSON.parse(stdout) };
}

it('runs the bundled offline CLI against the same controller lease, then saves a complete backup without loading Pi', async () => {
  const { paths, destination, lease } = await fixture(), entry = await maintenanceExecutable();
  const args = ['backup', '--user-data-root', paths.root, '--destination', destination];
  const blocked = await command(entry, args);
  expect(blocked.code).toBe(1); expect(blocked.output.result).toMatchObject({ ok: false, error: { code: 'runtime_already_owned' } });
  expect(existsSync(destination)).toBe(false); await lease.release();
  const saved = await command(entry, args);
  expect(saved.code).toBe(0); expect(saved.output.result).toMatchObject({ ok: true, data: { directory: destination, schemaVersion: 20, settingsVersion: 7 } });
  expect(saved.output.result.data.fileCount).toBeGreaterThan(3); expect(existsSync(join(destination, 'manifest.json'))).toBe(true);
});

it('reports malformed backup data as an offline restore failure and never repairs or overwrites the isolated copy', async () => {
  const { paths, destination } = await fixture(), backed = await backupStore(paths, destination);
  if (!backed.ok) throw Error(backed.error.code);
  const restored = restoreCopy(backed.data), before = readFileSync(restored.databaseFile), entry = await maintenanceExecutable();
  writeFileSync(join(destination, 'manifest.json'), '{malformed');
  const checked = await command(entry, ['verify-restore', '--user-data-root', restored.root, '--backup', destination]);
  expect(checked.code).toBe(1); expect(checked.output.result).toMatchObject({ ok: false, error: { code: 'maintenance_restore_failed' } });
  expect(readFileSync(restored.databaseFile).equals(before)).toBe(true);
});
