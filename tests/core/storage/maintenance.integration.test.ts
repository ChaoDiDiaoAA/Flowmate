import { expect, it, spyOn } from 'bun:test';
import * as filesystem from 'node:fs/promises';
import { Database } from 'bun:sqlite';
import { copyFileSync, existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, symlinkSync, writeFileSync, unlinkSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { dirname, join } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { mkdtempSync, deferCleanup } from '../../support/resources.ts';
import { openTestDatabase as openDatabase } from '../../support/database.ts';
import { openDatabase as openProductDatabase } from '../../../packages/core/src/storage/database.ts';
import { createFileStore } from '../../../packages/core/src/storage/file-store.ts';
import { defaultProductSettings } from '../../../packages/core/src/configuration/settings.ts';
import { acquireProductControllerLock, resolveProductPaths } from '../../../packages/shared/src/index.ts';
import { ServiceInstallationSchema } from '../../../packages/shared/src/service-layout.ts';
import { BACKGROUND_CONTEXT } from '@earendil-works/chord/context';
import { createModels, InMemoryCredentialStore, InMemoryModelsStore } from '@earendil-works/pi-ai';
import { createRegistry, Harness } from '@earendil-works/pi-durable';
import { createDurableSqliteStorage } from '@flowmate/runtime-durable';
import { PACKAGED_REQUIRED_FILES, type PackagedRelease } from '../../../packages/shared/src/runtime-layout.ts';
import { inspectStore, backupStore, prepareStoreUpgrade, verifyBackupSnapshot, verifyRestoredStore, type BackupReceipt } from '../../../packages/core/src/storage/maintenance.ts';
import { createApplication } from '../../../apps/composition.ts';
import { makeSelectedCandidate, makeCurrentSelectedCandidate } from '../../support/selected-candidate.ts';
import { createInvoiceEditService } from '../../../packages/core/src/invoice-edit/service.ts';
import { createManagedFileContents } from '../../../packages/core/src/storage/managed-file-contents.ts';
import { createResourceBundles } from '../../../packages/core/src/skill-hub/bundle.ts';
import { FrozenResourcesSchema } from '@flowmate/contracts';
import { researchFixture, researchPlan, researchNeed as need } from '../../support/research.ts';

const release: PackagedRelease = { version: 1, releaseId: '43f163a3-b56f-4133-b04d-8bbf92eb1e52', productVersion: '0.1.0',
  platform: 'win32', arch: 'x64', bunVersion: '1.4.4',
  electronVersion: '44.4.5', sdkVersion: '1.4.0', pluginVersion: '0.19.0', schemaVersion: 21, settingsVersion: 7,
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
  const store = await makeCurrentSelectedCandidate(), resolved = resolveProductPaths(store.root); if (!resolved.ok) throw Error(resolved.error.code);
  const files = createFileStore(resolved.data, store);
  const edits = createInvoiceEditService({ database: store, files, now: () => store.stamp,
    validate: () => ({ ok: true, data: { checks: [], issues: [] } }) });
  const accepted = await edits.accept({ operationRef: 'p17-accept-export', jobId: store.jobId, candidateId: store.candidateId,
    expectedCandidateId: store.candidateId, expectedRevision: store.selectedWorkspace.revision, dirty: false });
  expect(accepted.ok).toBe(true);
  const exported = await edits.export({ operationRef: 'p17-export', candidateId: store.candidateId, format: 'json' });
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
  await db.data.close();
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
    const files = createFileStore(paths.data, store.data);
    const material = await files.publishResearchMaterial({ title: 'Synthetic maintenance material', format: 'text', text: 'Original synthetic body',
      at: '2026-10-17T00:00:00.000Z' });
    if (!material.ok) throw Error(material.error.code);
    const registered = store.data.research.registerMaterial(material.data); if (!registered.ok) throw Error(registered.error.code);
    const bundlePath = 'skills/example/v1/SKILL.md';
    const bundle = join(root, 'runtime/resource-bundles/historical-bundle', bundlePath);
    mkdirSync(dirname(bundle), { recursive: true }); writeFileSync(bundle, 'Historical synthetic Skill');
    store.data.contents.remember({ ownerKind: 'resource-bundle', ownerId: 'historical-bundle', relativePath: bundlePath }, Buffer.from('Historical synthetic Skill'));
    store.data.contents.remember({ ownerKind: 'resource-author', ownerId: 'skill:example:v1', relativePath: 'SKILL.md' }, Buffer.from('Original author body retained only in SQLite'));
    await store.data.close();
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

it('verifies the original activation backup snapshot after live data advances without treating it as a restore target', async () => {
  const api = await import('../../../packages/core/src/storage/maintenance.ts');
  expect(typeof api.verifyBackupSnapshot).toBe('function');
  const f = await fixture(), parent = join(f.root, 'backups'); mkdirSync(parent);
  const backed = await backupStore(f.paths, join(parent, 'service-activation-83a55902-5494-4daf-a3c0-072d8b1c7ec6'));
  expect(backed.ok).toBe(true); if (!backed.ok) throw Error(backed.error.code);
  const copied = readFileSync(join(backed.data.directory, 'outputs/receipt.json'));
  writeFileSync(join(f.root, 'outputs/receipt.json'), '{"synthetic":false}');
  expect(await api.verifyBackupSnapshot(backed.data.directory)).toEqual({ ok: true, data: backed.data });
  expect(readFileSync(join(backed.data.directory, 'outputs/receipt.json'))).toEqual(copied);
  expect(readFileSync(join(f.root, 'outputs/receipt.json'), 'utf8')).toBe('{"synthetic":false}');
  unlinkSync(join(backed.data.directory, 'outputs/receipt.json'));
  expect(await api.verifyBackupSnapshot(backed.data.directory)).toMatchObject({ ok: false, error: { code: 'maintenance_backup_invalid' } });
  expect(existsSync(join(backed.data.directory, 'outputs/receipt.json'))).toBe(false);
});

it('rejects a backup manifest claiming another release than its actual installed record without changing snapshot bytes', async () => {
  const f = await fixture();
  writeFileSync(join(f.root, 'data/installed-release.json'), JSON.stringify({ version: 1, releaseId: release.releaseId,
    productVersion: release.productVersion, schemaVersion: release.schemaVersion, settingsVersion: release.settingsVersion }));
  const backed = await backupStore(f.paths, f.destination); if (!backed.ok) throw Error(backed.error.code);
  const changed = { ...backed.data.manifest, releaseId: 'b94764f6-c14b-44da-a2e8-5e7c3214a303' };
  writeFileSync(join(f.destination, 'manifest.json'), JSON.stringify(changed));
  const original = readFileSync(join(f.destination, 'data/app.sqlite')), marker = readFileSync(join(f.destination, 'data/installed-release.json'));
  expect(await verifyBackupSnapshot(f.destination)).toMatchObject({ ok: false, error: { code: 'maintenance_backup_invalid' } });
  const restored = restoreCopy(backed.data);
  expect(await verifyRestoredStore(restored, { directory: f.destination, manifest: changed }, release))
    .toMatchObject({ ok: false, error: { code: 'maintenance_restore_failed' } });
  expect(readFileSync(join(f.destination, 'data/app.sqlite')).equals(original)).toBe(true);
  expect(readFileSync(join(f.destination, 'data/installed-release.json')).equals(marker)).toBe(true);
  expect(JSON.parse(readFileSync(join(f.destination, 'manifest.json'), 'utf8'))).toEqual(changed);
});

it('refuses unlisted WAL transactions and WAL-mode snapshots before opening SQLite or creating sidecars', async () => {
  const api = await import('../../../packages/core/src/storage/maintenance.ts');
  for (const holdWriter of [true, false]) {
    const f = await fixture(), backed = await backupStore(f.paths, f.destination);
    if (!backed.ok) throw Error(backed.error.code);
    const file = join(backed.data.directory, 'data/app.sqlite'), writer = new Database(file, { readwrite: true, create: false });
    let open = true;
    try {
      writer.exec('PRAGMA journal_mode=WAL; PRAGMA wal_autocheckpoint=0; CREATE TABLE snapshot_unlisted_wal(value TEXT);');
      writer.query('INSERT INTO snapshot_unlisted_wal(value) VALUES(?)').run('outside-manifest');
      if (!holdWriter) { writer.close(); open = false; }
      const before = readdirSync(dirname(file)).sort(), bytes = readFileSync(file);
      expect(backed.data.manifest.files.some(member => /app\.sqlite-(wal|shm)$/.test(member.path))).toBe(false);
      expect(await api.verifyBackupSnapshot(backed.data.directory)).toMatchObject({ ok: false, error: { code: 'maintenance_backup_invalid' } });
      expect(readdirSync(dirname(file)).sort()).toEqual(before);
      expect(readFileSync(file)).toEqual(bytes);
    } finally { if (open) writer.close(); }
  }
});

it('rejects an invalid snapshot manifest without creating a backup database or repairing its files', async () => {
  const api = await import('../../../packages/core/src/storage/maintenance.ts');
  expect(typeof api.verifyBackupSnapshot).toBe('function');
  const root = mkdtempSync(join(tmpdir(), 'flowmate-invalid-backup-snapshot-'));
  writeFileSync(join(root, 'manifest.json'), '{invalid');
  expect(await api.verifyBackupSnapshot(root)).toMatchObject({ ok: false, error: { code: 'maintenance_backup_invalid' } });
  expect(existsSync(join(root, 'data/app.sqlite'))).toBe(false);
  expect(readFileSync(join(root, 'manifest.json'), 'utf8')).toBe('{invalid');
});

it('inspects an empty root without creating a database or inventing an old backup', async () => {
  const { paths, root } = await fixture(false);
  writeFileSync(join(root, 'Local State'), JSON.stringify({ os_crypt: { encrypted_key: 'synthetic-new-platform-key' } }));
  expect(inspectStore(paths)).toEqual({ ok: true, data: { schemaVersion: null, settingsVersion: null, installedReleaseId: null, journalMode: null } });
  expect(await prepareStoreUpgrade(paths, release)).toEqual({ ok: true, data: null });
  expect(existsSync(paths.databaseFile)).toBe(false); expect(existsSync(join(root, 'backups'))).toBe(false);
});

for (const enabled of [false, true]) it('refuses to replace the missing original database of an activated service selection, enabled=' + enabled, async () => {
  const { root, paths } = await fixture(false);
  writeFileSync(join(root, 'service-installation.json'), JSON.stringify({ version: 1,
    installationId: '3d6c17f7-782b-4f44-a56a-5e67407c899a', serviceName: 'FlowmateRuntime3d6c17f7782b4f44a56a5e67407c899a',
    ownerSid: 'S-1-5-21-1-2-3-1001', runtimeRoot: join(root, 'installed'), dataRoot: root,
    releaseId: release.releaseId, enabled, activationOperationId: 'a5e4273e-7654-43b6-82ad-218359d8ec35' }));
  expect(inspectStore(paths)).toMatchObject({ ok: false, error: { code: 'maintenance_store_incompatible' } });
  expect(await prepareStoreUpgrade(paths, release)).toMatchObject({ ok: false, error: { code: 'maintenance_store_incompatible' } });
  expect(existsSync(paths.databaseFile)).toBe(false);
});

it('backs up committed SQLite and all persistent references, then verifies an isolated copy without changing the source', async () => {
  const { root, paths, destination } = await fixture();
  const original = readFileSync(paths.databaseFile), settings = readFileSync(join(root, 'data/settings.json'));
  const backed = await backupStore(paths, destination); expect(backed.ok).toBe(true); if (!backed.ok) return;
  expect(backed.data.manifest.schemaVersion).toBe(21); expect(backed.data.manifest.settingsVersion).toBe(7);
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

it('backs up service selection and staged credential receipts verbatim and requires service identity recheck after restore', async () => {
  const { root, paths, destination } = await fixture();
  const files = {
    'service-installation.json': JSON.stringify({ version: 1, installationId: '3d6c17f7-782b-4f44-a56a-5e67407c899a',
      serviceName: 'FlowmateRuntime3d6c17f7782b4f44a56a5e67407c899a', ownerSid: 'S-1-5-21-1-2-3-1001', runtimeRoot: join(root, 'installed'),
      dataRoot: root, releaseId: release.releaseId, enabled: true, activationOperationId: 'a5e4273e-7654-43b6-82ad-218359d8ec35' }),
    'security/service-credentials/service_ref_123456.json': JSON.stringify({ version: 1, ciphertext: 'synthetic-protected-key',
      servicePublication: { operationId: 'a5e4273e-7654-43b6-82ad-218359d8ec35' } }),
    'security/service-credentials/operations/a5e4273e-7654-43b6-82ad-218359d8ec35.json': JSON.stringify({ version: 1,
      sealedIntent: 'synthetic-protected-original-intent', receipt: { phase: 'prepared' } }),
    'security/service-credentials/operations/a5e4273e-7654-43b6-82ad-218359d8ec35/service_ref_123456.json': JSON.stringify({ version: 1, ciphertext: 'synthetic-protected-stage' }),
  };
  for (const [path, content] of Object.entries(files)) { mkdirSync(dirname(join(root, path)), { recursive: true }); writeFileSync(join(root, path), content); }
  const backed = await backupStore(paths, destination); expect(backed.ok).toBe(true); if (!backed.ok) throw Error(backed.error.code);
  for (const [path, content] of Object.entries(files)) {
    expect(backed.data.manifest.files.map(file => file.path)).toContain(path);
    expect(readFileSync(join(destination, path), 'utf8')).toBe(content);
  }
  const restored = restoreCopy(backed.data);
  expect(await verifyRestoredStore(restored, backed.data, release)).toMatchObject({ ok: true, data: { readable: true,
    gaps: expect.arrayContaining(['service_installation_identity_and_activation_recheck', 'service_installation_original_root_mismatch']) } });
  const originalDatabase = readFileSync(restored.databaseFile), originalInstallation = readFileSync(join(restored.root, 'service-installation.json'));
  expect(await verifyRestoredStore(restored, backed.data, { ...release, releaseId: '538df86d-30ee-4c85-9549-303c7f3b327c' }))
    .toMatchObject({ ok: false, error: { code: 'maintenance_service_release_mismatch' } });
  expect(readFileSync(restored.databaseFile).equals(originalDatabase)).toBe(true);
  expect(readFileSync(join(restored.root, 'service-installation.json')).equals(originalInstallation)).toBe(true);
  unlinkSync(join(restored.root, 'security/service-credentials/operations/a5e4273e-7654-43b6-82ad-218359d8ec35/service_ref_123456.json'));
  expect(await verifyRestoredStore(restored, backed.data, release)).toMatchObject({ ok: false, error: { code: 'maintenance_restore_failed' } });
  expect(readFileSync(join(root, 'service-installation.json'), 'utf8')).toBe(files['service-installation.json']);
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
      releaseId: release.releaseId, productVersion: release.productVersion, schemaVersion: 21, settingsVersion: 7 });
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
    productVersion: release.productVersion, schemaVersion: 21, settingsVersion: 7 }));
  expect(await prepareStoreUpgrade(paths, release)).toEqual({ ok: true, data: null });
  const next = { ...release, releaseId: '54ec481d-a0d9-4cf9-8143-3600e67f77b9' };
  const backed = await prepareStoreUpgrade(paths, next); expect(backed.ok).toBe(true);
  if (backed.ok) { expect(backed.data?.manifest.releaseId).toBe(release.releaseId); expect(backed.data?.manifest.schemaVersion).toBe(21); }
  expect(readdirSync(join(root, 'backups'))).toHaveLength(1);
  expect(JSON.parse(readFileSync(join(root, 'data/installed-release.json'), 'utf8')).releaseId).toBe(release.releaseId);
});

it('rejects future or nonconsecutive Schema and corrupt Settings before any upgrade writes', async () => {
  for (const kind of ['future', 'gap', 'settings']) {
    const { root, paths } = await fixture();
    if (kind === 'settings') writeFileSync(join(root, 'data/settings.json'), '{"version":8}');
    else {
      const db = new Database(paths.databaseFile);
      if (kind === 'future') db.query('INSERT INTO schema_migrations(version,applied_at) VALUES(22,?)').run('2026-10-17T00:00:00.000Z');
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
  // Keep the connection reachable so GC cannot checkpoint WAL before the crash.
  const program = `import {Database} from 'bun:sqlite'; const db=new Database(process.argv[1]);
    db.exec('PRAGMA journal_mode=WAL; PRAGMA wal_autocheckpoint=0; CREATE TABLE wal_probe(value TEXT);');
    db.query('INSERT INTO wal_probe VALUES(?)').run('committed'); console.log('committed'); setInterval(()=>{if(db.inTransaction)throw Error('WAL fixture unexpectedly has a transaction')},1000);`;
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
  // Keep the uncommitted connection reachable until the owning process is killed.
  const program = `import {Database} from 'bun:sqlite'; const db=new Database(process.argv[1]);
    db.exec('PRAGMA journal_mode=DELETE; PRAGMA cache_size=1; CREATE TABLE rollback_probe(value BLOB);');
    db.exec('BEGIN IMMEDIATE'); for(let index=0;index<10;index++)db.exec('INSERT INTO rollback_probe VALUES(zeroblob(100000))');
    console.log('uncommitted pages spilled'); setInterval(()=>{if(!db.inTransaction)throw Error('rollback fixture lost its transaction')},1000);`;
  const child = Bun.spawn([process.execPath, '--no-env-file', '-e', program, paths.databaseFile],
    { cwd: root, stdout: 'pipe', stderr: 'pipe', env: {} });
  deferCleanup(async () => { if (child.exitCode === null) child.kill(); await child.exited; });
  const stderrRead = new Response(child.stderr).text();
  const reader = child.stdout.getReader(), decoder = new TextDecoder(); let ready = '';
  try {
    while (!ready.includes('\n')) {
      const chunk = await reader.read();
      if (chunk.done) throw Error('rollback fixture exited before ready: ' + JSON.stringify({
        stdout: ready, stderr: await stderrRead, exit: await child.exited, signalCode: child.signalCode }));
      ready += decoder.decode(chunk.value, { stream: true });
    }
  } finally { reader.releaseLock(); }
  expect(ready).toBe('uncommitted pages spilled\n');
  expect(child.exitCode).toBeNull();
  expect(existsSync(paths.databaseFile + '-journal')).toBe(true);
  child.kill(); const exit = await child.exited;
  expect(exit).not.toBe(0); expect(await stderrRead).toBe('');
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
  finally { await opened.data.close(); }
});

async function maintenanceExecutable() {
  const root = mkdtempSync(join(tmpdir(), 'flowmate-maintenance 中文-')), runtime = join(root, 'resources/flowmate-runtime');
  for (const file of PACKAGED_REQUIRED_FILES) {
    const path = join(runtime, file); mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, file === 'sdk/package.json' ? JSON.stringify({ version: release.sdkVersion }) : 'synthetic asset, never executed');
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
  expect(saved.code).toBe(0); expect(saved.output.result).toMatchObject({ ok: true, data: { directory: destination, schemaVersion: 21, settingsVersion: 7 } });
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

it('blocks product database creation for every unfinished service restore marker including malformed bytes', async () => {
  for (const content of ['{unfinished', JSON.stringify({ version: 1, backupId: 'an-unverified-intent' })]) {
    const f = await fixture(false), file = join(f.root, 'data/service-restore.json'); writeFileSync(file, content);
    const before = readdirSync(f.root).sort(), opened = openProductDatabase(f.paths);
    if (opened.ok) await opened.data.close();
    expect(opened).toMatchObject({ ok: false, error: { code: 'maintenance_restore_pending' } });
    expect(await prepareStoreUpgrade(f.paths, release)).toMatchObject({ ok: false, error: { code: 'maintenance_restore_pending' } });
    expect(existsSync(f.paths.databaseFile)).toBe(false); expect(readFileSync(file, 'utf8')).toBe(content);
    expect(readdirSync(f.root).sort()).toEqual(before);
  }
});

it('treats a restore marker directory or dangling junction as pending before opening SQLite', async () => {
  for (const kind of ['directory', 'dangling-junction']) {
    const f = await fixture(false), file = join(f.root, 'data/service-restore.json');
    if (kind === 'directory') mkdirSync(file); else symlinkSync(join(f.root, 'absent-restore-control'), file, 'junction');
    expect(openProductDatabase(f.paths)).toMatchObject({ ok: false, error: { code: 'maintenance_restore_pending' } });
    expect(await prepareStoreUpgrade(f.paths, release)).toMatchObject({ ok: false, error: { code: 'maintenance_restore_pending' } });
    expect(existsSync(f.paths.databaseFile)).toBe(false); expect(lstatSync(file).isDirectory() || lstatSync(file).isSymbolicLink()).toBe(true);
  }
});

async function serviceRestoreFixture() {
  const f = await fixture(), installationId = randomUUID();
  const originalInstallation = ServiceInstallationSchema.parse({ version: 1, installationId,
    serviceName: 'FlowmateRuntime' + installationId.replaceAll('-', ''), ownerSid: 'S-1-5-21-1-2-3-1001',
    dataRoot: f.root, runtimeRoot: join(f.root, 'old-program'), releaseId: release.releaseId,
    enabled: true, activationOperationId: randomUUID(), activationSettingsRevision: 3 });
  writeFileSync(join(f.root, 'service-installation.json'), JSON.stringify(originalInstallation));
  const installed = (releaseId: string) => writeFileSync(join(f.root, 'data/installed-release.json'), JSON.stringify({ version: 1,
    releaseId, productVersion: release.productVersion, schemaVersion: 21, settingsVersion: 7 }));
  installed(release.releaseId);
  const addNative = async (title: string) => {
    const database = need(openDatabase(f.paths)), storage = await createDurableSqliteStorage(database.coordinator);
    const harness = await Harness.open(storage, { models: createModels({ credentials: new InMemoryCredentialStore(),
      modelsStore: new InMemoryModelsStore(), authContext: { env: async () => undefined, fileExists: async () => false } }), registry: createRegistry() }, BACKGROUND_CONTEXT);
    try {
      const conversation = await harness.commit(tx => tx.createConversation({ ownership: { kind: 'ownerless' } }), BACKGROUND_CONTEXT);
      await database.transaction(scope => {
        const session = need(scope.sessions.create({ runtimeKind: 'durable', nativeSessionId: null, title, at: new Date().toISOString() }));
        need(scope.sessions.bindDurableConversation(session.sessionId, conversation.id, new Date().toISOString()));
      });
    } finally { await harness.close(BACKGROUND_CONTEXT); await database.close(); }
  };
  await addNative('Original native snapshot');
  const backups = join(f.root, 'backups'); mkdirSync(backups);
  const backup = need(await backupStore(f.paths, join(backups, 'original-service-data')));
  await addNative('Later native state');
  const current = { ...originalInstallation, runtimeRoot: join(f.root, 'current-program'), releaseId: randomUUID() };
  const authorityFile = join(f.root, 'service-installation.json'); writeFileSync(authorityFile, JSON.stringify(current, null, 3) + '\n'); installed(current.releaseId);
  writeFileSync(join(f.root, 'outputs/receipt.json'), '{"later":true}'); writeFileSync(join(f.root, 'outputs/extra-managed.txt'), 'Later managed output');
  writeFileSync(join(f.root, 'keep-user-file.txt'), 'User file outside maintenance contract');
  writeFileSync(join(f.root, 'logs/keep.log'), 'Original diagnostics');
  const safety = need(await backupStore(f.paths, join(backups, 'before-restore')));
  return { ...f, backup, safety, current, authorityFile, authority: readFileSync(authorityFile), originalInstallation };
}

it('restores original real product/native data under the same lock and keeps enabled authority guarded until explicit publication finish', async () => {
  const f = await serviceRestoreFixture(), api = await import('../../../packages/core/src/storage/maintenance.ts');
  expect(typeof api.restoreServiceStore).toBe('function'); expect(typeof api.finishServiceRestore).toBe('function');
  const lock = join(f.root, 'data/app.sqlite.lock'), lockBefore = lstatSync(lock);
  const restored = await api.restoreServiceStore(f.paths, f.backup, f.current, release);
  expect(restored).toMatchObject({ ok: true, data: { backupId: f.backup.manifest.backupId } });
  expect(readFileSync(f.authorityFile)).toEqual(f.authority); expect(existsSync(join(f.root, 'data/service-restore.json'))).toBe(true);
  expect(openProductDatabase(f.paths)).toMatchObject({ ok: false, error: { code: 'maintenance_restore_pending' } });
  for (const file of f.backup.manifest.files.filter(file => file.path !== 'service-installation.json'))
    expect(readFileSync(join(f.root, file.path))).toEqual(readFileSync(join(f.backup.directory, file.path)));
  const database = new Database(f.paths.databaseFile, { readonly: true });
  try { expect(database.query('SELECT title FROM sessions ORDER BY id').all()).toEqual([{ title: 'Original native snapshot' }]);
    expect(database.query('SELECT COUNT(*) count FROM fm_durable_conversations').get()).toEqual({ count: 1 }); }
  finally { database.close(); }
  expect(existsSync(join(f.root, 'outputs/extra-managed.txt'))).toBe(false);
  expect(readFileSync(join(f.root, 'keep-user-file.txt'), 'utf8')).toBe('User file outside maintenance contract');
  expect(readFileSync(join(f.root, 'logs/keep.log'), 'utf8')).toBe('Original diagnostics');
  expect(existsSync(join(f.safety.directory, 'manifest.json'))).toBe(true); expect(lstatSync(lock).ino).toBe(lockBefore.ino);
  const target = { ...f.current, runtimeRoot: f.originalInstallation.runtimeRoot, releaseId: release.releaseId };
  expect(await api.finishServiceRestore(f.paths, f.backup, target, release)).toMatchObject({ ok: false });
  writeFileSync(f.authorityFile, JSON.stringify(target, null, 2) + '\n'); const published = readFileSync(f.authorityFile);
  expect(await api.restoreServiceStore(f.paths, f.backup, f.current, release)).toEqual(restored);
  expect(readFileSync(f.authorityFile)).toEqual(published);
  expect(await api.finishServiceRestore(f.paths, f.backup, target, release)).toMatchObject({ ok: true });
  expect(existsSync(join(f.root, 'data/service-restore.json'))).toBe(false); expect(readFileSync(f.authorityFile)).toEqual(published);
  expect(await api.finishServiceRestore(f.paths, f.backup, target, release)).toMatchObject({ ok: true });
  writeFileSync(join(f.root, 'outputs/receipt.json'), '{"modified-after-finish":true}');
  expect((await api.finishServiceRestore(f.paths, f.backup, target, release)).ok).toBe(false);
  expect(existsSync(join(f.root, 'data/service-restore.json'))).toBe(false);
  copyFileSync(join(f.backup.directory, 'outputs/receipt.json'), join(f.root, 'outputs/receipt.json'));
  const reopened = need(openProductDatabase(f.paths)); await reopened.close();
}, 20000);

it('rejects another restore identity, backup receipt or release before creating an intent or changing current data', async () => {
  const f = await serviceRestoreFixture(), api = await import('../../../packages/core/src/storage/maintenance.ts'), before = readFileSync(f.paths.databaseFile);
  for (const result of [
    await api.restoreServiceStore(f.paths, { ...f.backup, manifest: { ...f.backup.manifest, backupId: randomUUID() } }, f.current, release),
    await api.restoreServiceStore(f.paths, f.backup, { ...f.current, ownerSid: 'S-1-5-21-1-2-3-1002' }, release),
    await api.restoreServiceStore(f.paths, f.backup, { ...f.current, activationSettingsRevision: 4 }, release),
    await api.restoreServiceStore(f.paths, f.backup, f.current, { ...release, releaseId: randomUUID() }),
  ]) expect(result.ok).toBe(false);
  expect(readFileSync(f.paths.databaseFile)).toEqual(before); expect(readFileSync(f.authorityFile)).toEqual(f.authority);
  expect(existsSync(join(f.root, 'data/service-restore.json'))).toBe(false);
  const sourceRecord = join(f.backup.directory, 'service-installation.json'), sourceBytes = readFileSync(sourceRecord);
  try {
    const changed = JSON.parse(sourceBytes.toString('utf8')); changed.activationOperationId = randomUUID(); writeFileSync(sourceRecord, JSON.stringify(changed));
    expect((await api.restoreServiceStore(f.paths, f.backup, f.current, release)).ok).toBe(false);
    expect(readFileSync(f.paths.databaseFile)).toEqual(before); expect(readFileSync(f.authorityFile)).toEqual(f.authority);
  } finally { writeFileSync(sourceRecord, sourceBytes); }
});

it('retains a mixed failed restore guard and its authority, then repeats the same backup while the original lock heartbeat stays live', async () => {
  const f = await serviceRestoreFixture(), api = await import('../../../packages/core/src/storage/maintenance.ts'), actualRename = filesystem.rename;
  const failure = spyOn(filesystem, 'rename').mockImplementation(async (from, to) => {
    if (String(to) === join(f.root, 'outputs/receipt.json')) throw Object.assign(Error('Controlled file publication failure'), { code: 'EACCES' });
    return actualRename(from, to);
  });
  try { expect((await api.restoreServiceStore(f.paths, f.backup, f.current, release)).ok).toBe(false); }
  finally { failure.mockRestore(); }
  expect(readFileSync(f.paths.databaseFile)).toEqual(readFileSync(join(f.backup.directory, 'data/app.sqlite')));
  expect(readFileSync(join(f.root, 'outputs/receipt.json'), 'utf8')).toBe('{"later":true}');
  const guardFile = join(f.root, 'data/service-restore.json'), guarded = readFileSync(guardFile);
  expect(api.ServiceRestoreIntentSchema.parse(JSON.parse(guarded.toString('utf8')))).toMatchObject({ backupId: f.backup.manifest.backupId, original: f.current });
  expect(openProductDatabase(f.paths)).toMatchObject({ ok: false, error: { code: 'maintenance_restore_pending' } });
  expect((await api.restoreServiceStore(f.paths, f.safety, f.current, { ...release, releaseId: f.current.releaseId })).ok).toBe(false);
  expect(readFileSync(guardFile)).toEqual(guarded); expect(readFileSync(f.authorityFile)).toEqual(f.authority);
  const entered = Promise.withResolvers<void>(), released = Promise.withResolvers<void>(), actualCopy = filesystem.copyFile;
  let held = false;
  const hold = spyOn(filesystem, 'copyFile').mockImplementation(async (...args) => {
    if (!held) { held = true; entered.resolve(); await released.promise; }
    return actualCopy(...args);
  });
  const restoring = api.restoreServiceStore(f.paths, f.backup, f.current, release);
  try {
    await entered.promise; const lock = join(f.root, 'data/app.sqlite.lock'), before = lstatSync(lock).mtimeMs;
    await Bun.sleep(3400); expect(lstatSync(lock).mtimeMs).toBeGreaterThan(before);
    expect(await acquireProductControllerLock(f.paths)).toMatchObject({ ok: false, error: { code: 'runtime_already_owned' } });
    released.resolve(); expect(await restoring).toMatchObject({ ok: true, data: { backupId: f.backup.manifest.backupId } });
  } finally { released.resolve(); await restoring; hold.mockRestore(); }
  expect(readFileSync(f.authorityFile)).toEqual(f.authority); expect(readFileSync(guardFile)).toEqual(guarded);
}, 20000);

it('requires the copy comparison and finish to reject unlisted SQLite sidecars without repairing or clearing their restore intent', async () => {
  const f = await serviceRestoreFixture(), api = await import('../../../packages/core/src/storage/maintenance.ts');
  expect((await api.verifyServiceStoreCopy(f.paths, f.backup, f.current)).ok).toBe(false);
  need(await api.restoreServiceStore(f.paths, f.backup, f.current, release));
  const target = { ...f.current, runtimeRoot: f.originalInstallation.runtimeRoot, releaseId: release.releaseId };
  writeFileSync(f.authorityFile, JSON.stringify(target));
  const sidecar = f.paths.databaseFile + '-wal'; writeFileSync(sidecar, Buffer.alloc(0));
  const before = readdirSync(join(f.root, 'data')).sort(), database = readFileSync(f.paths.databaseFile), guard = readFileSync(join(f.root, 'data/service-restore.json'));
  expect((await api.verifyServiceStoreCopy(f.paths, f.backup, target)).ok).toBe(false);
  expect((await api.finishServiceRestore(f.paths, f.backup, target, release)).ok).toBe(false);
  expect(readdirSync(join(f.root, 'data')).sort()).toEqual(before); expect(readFileSync(f.paths.databaseFile)).toEqual(database);
  expect(readFileSync(join(f.root, 'data/service-restore.json'))).toEqual(guard);
  unlinkSync(sidecar); expect(await api.verifyServiceStoreCopy(f.paths, f.backup, target)).toMatchObject({ ok: true });
});

it('rejects a linked managed target before creating an intent or copying files through that link', async () => {
  const f = await serviceRestoreFixture(), api = await import('../../../packages/core/src/storage/maintenance.ts');
  const outside = mkdtempSync(join(tmpdir(), 'flowmate-restore-outside-')), output = join(f.root, 'outputs'), retained = join(f.root, 'outputs-before-link');
  expect(dirname(output)).toBe(f.root); expect(dirname(retained)).toBe(f.root);
  writeFileSync(join(outside, 'receipt.json'), 'Outside files must remain unchanged');
  renameSync(output, retained); symlinkSync(outside, output, 'junction');
  expect((await api.restoreServiceStore(f.paths, f.backup, f.current, release)).ok).toBe(false);
  expect(readFileSync(join(outside, 'receipt.json'), 'utf8')).toBe('Outside files must remain unchanged');
  expect(readFileSync(f.authorityFile)).toEqual(f.authority); expect(existsSync(join(f.root, 'data/service-restore.json'))).toBe(false);
});

it('retains an existing unowned restore stage when real exclusive copy reports EEXIST', async () => {
  const f = await serviceRestoreFixture(), api = await import('../../../packages/core/src/storage/maintenance.ts'), actualCopy = filesystem.copyFile;
  let stage: string | undefined;
  const collision = spyOn(filesystem, 'copyFile').mockImplementationOnce(async (...args) => {
    stage = String(args[1]); writeFileSync(stage, 'A different owner already published this path.');
    return actualCopy(...args);
  });
  try { expect((await api.restoreServiceStore(f.paths, f.backup, f.current, release)).ok).toBe(false); }
  finally { collision.mockRestore(); }
  expect(stage).toBeDefined(); expect(existsSync(stage!)).toBe(true);
  expect(readFileSync(stage!, 'utf8')).toBe('A different owner already published this path.');
  expect(readFileSync(f.authorityFile)).toEqual(f.authority);
  expect(openProductDatabase(f.paths)).toMatchObject({ ok: false, error: { code: 'maintenance_restore_pending' } });
});

it('retains a later owner at the old stage pathname after actual rename succeeds but its receipt is lost', async () => {
  const f = await serviceRestoreFixture(), api = await import('../../../packages/core/src/storage/maintenance.ts'), actualRename = filesystem.rename;
  let stage: string | undefined;
  const lost = spyOn(filesystem, 'rename').mockImplementationOnce(async (from, to) => {
    stage = String(from); await actualRename(from, to); writeFileSync(stage, 'A later owner reused the renamed stage path.');
    throw Error('Controlled loss of the actual rename receipt.');
  });
  try { expect((await api.restoreServiceStore(f.paths, f.backup, f.current, release)).ok).toBe(false); }
  finally { lost.mockRestore(); }
  expect(stage).toBeDefined(); expect(existsSync(stage!)).toBe(true);
  expect(readFileSync(stage!, 'utf8')).toBe('A later owner reused the renamed stage path.');
  expect(readFileSync(f.authorityFile)).toEqual(f.authority);
  expect(openProductDatabase(f.paths)).toMatchObject({ ok: false, error: { code: 'maintenance_restore_pending' } });
});
