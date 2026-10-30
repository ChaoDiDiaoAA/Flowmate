import { afterEach, expect, it, spyOn } from 'bun:test';
import { copyFileSync, existsSync, mkdirSync, readFileSync, readdirSync, renameSync, symlinkSync, writeFileSync } from 'node:fs';
import { Database } from 'bun:sqlite';
import { randomUUID } from 'node:crypto';
import { basename, dirname, extname, join } from 'node:path';
import { windowsSystemDirectory } from '../../packages/shared/src/windows-identity.ts';
import type { ServiceInstallation } from '../../packages/shared/src/service-layout.ts';
import { cleanupResources, deferCleanup } from '../support/resources.ts';
import { acquireProductControllerLock, resolveProductPaths } from '../../packages/shared/src/index.ts';
import { openTestDatabase } from '../support/database.ts';
import { createFileStore } from '../../packages/core/src/storage/file-store.ts';
import { createDocumentService } from '@flowmate/data';
import { BACKGROUND_CONTEXT } from '@earendil-works/chord/context';
import { createModels, InMemoryCredentialStore, InMemoryModelsStore } from '@earendil-works/pi-ai';
import { createRegistry, Harness } from '@earendil-works/pi-durable';
import { createDurableSqliteStorage } from '@flowmate/runtime-durable';

afterEach(cleanupResources);
async function fixture() {
  const api = await import('../../packages/shared/src/service-layout.ts').catch(() => null);
  expect(api, 'Service publication API and its account producer must be available').not.toBeNull();
  if (!api) throw Error('Service configuration publication is unavailable.');
  expect(typeof api.publishServiceConfiguration).toBe('function'); expect(typeof api.readPublishedServiceConfiguration).toBe('function');
  const { packageOwnerFixture, removeOwnerFixture } = await import('../service/owner-fixture.ts');
  const packaged = await packageOwnerFixture(); deferCleanup(() => removeOwnerFixture(packaged.root));
  const dataRoot = join(packaged.root, '原账户 data & review'); mkdirSync(dataRoot);
  const prepared = await api.prepareServiceInstallation({ runtimeRoot: packaged.runtimeRoot, dataRoot });
  if (!prepared.ok) throw Error(prepared.error.code);
  const spawn = spyOn(Bun, 'spawn').mockImplementation(() => { throw Error('Configuration publication must not launch a process.'); });
  const spawnSync = spyOn(Bun, 'spawnSync').mockImplementation(() => { throw Error('Configuration publication must not launch a process.'); });
  deferCleanup(() => { spawn.mockRestore(); spawnSync.mockRestore(); });
  const record = join(dataRoot, 'service-installation.json'), originalRecord = readFileSync(record);
  const originalRelease = readFileSync(join(packaged.runtimeRoot, 'release.json'));
  return { api, ...packaged, dataRoot, installation: prepared.data, record, originalRecord, originalRelease,
    assertReadOnlyPreparation() {
      expect(existsSync(join(dataRoot, 'data/app.sqlite'))).toBe(false);
      expect(readdirSync(dataRoot)).toEqual(['service-installation.json']);
      expect(readFileSync(record).equals(originalRecord)).toBe(true);
      expect(readFileSync(join(packaged.runtimeRoot, 'release.json')).equals(originalRelease)).toBe(true);
      expect(spawn).not.toHaveBeenCalled(); expect(spawnSync).not.toHaveBeenCalled();
    } };
}
function xmlText(xml: string, tag: string): string {
  const match = new RegExp(`<${tag}>([^<]*)</${tag}>`).exec(xml);
  expect(match, `Expected the original ${tag} field`).not.toBeNull();
  return match![1]!.replaceAll('&quot;', '"').replaceAll('&apos;', "'").replaceAll('&gt;', '>').replaceAll('&lt;', '<').replaceAll('&amp;', '&');
}
async function accountSid(account: string): Promise<string> {
  const directory = await windowsSystemDirectory(), { CString, dlopen } = await import('bun:ffi');
  const kernel = dlopen(join(directory, 'kernel32.dll'), { LocalFree: { args: ['u64'], returns: 'u64' } });
  const security = dlopen(join(directory, 'advapi32.dll'), {
    LookupAccountNameW: { args: ['ptr', 'ptr', 'ptr', 'ptr', 'ptr', 'ptr', 'ptr'], returns: 'i32' },
    ConvertSidToStringSidA: { args: ['ptr', 'ptr'], returns: 'i32' },
  });
  const sid = new BigUint64Array(32), sidBytes = new Uint32Array([sid.byteLength]), domain = new Uint16Array(32768);
  const domainChars = new Uint32Array([domain.length]), use = new Uint32Array(1), text = new BigUint64Array(1);
  try {
    // Independent inverse lookup binds the rendered SAM account to the saved owner SID.
    expect(security.symbols.LookupAccountNameW(null, Buffer.from(account + '\0', 'utf16le'), sid, sidBytes, domain, domainChars, use)).not.toBe(0);
    expect(security.symbols.ConvertSidToStringSidA(sid, text)).not.toBe(0);
    return new CString(text[0]!).toString();
  } finally { if (text[0]) kernel.symbols.LocalFree(text[0]); security.close(); kernel.close(); }
}

it('publishes the original account configuration beside the real pinned wrapper and preserves identical bytes on repeat', async () => {
  const f = await fixture();
  const first = await f.api.publishServiceConfiguration(f.installation);
  expect(first).toMatchObject({ ok: true }); if (!first.ok) throw Error(first.error.code);
  const { wrapperExecutable, configurationFile, workingDirectory } = first.data;
  expect(first.data.installation).toEqual(f.installation);
  expect(dirname(configurationFile)).toBe(dirname(wrapperExecutable));
  expect(basename(configurationFile, extname(configurationFile))).toBe(basename(wrapperExecutable, extname(wrapperExecutable)));
  expect(workingDirectory).toBe(dirname(wrapperExecutable));
  expect(wrapperExecutable).toBe(join(f.runtimeRoot, 'service/FlowmateRuntime.exe'));
  const bytes = readFileSync(configurationFile), xml = bytes.toString('utf8');
  expect(xml).not.toMatch(/<password(?:\s|>)|FlowmateAccountNotConfigured|\{\{|\}\}|%[^%]+%/i);
  expect(xmlText(xml, 'id')).toBe(f.installation.serviceName);
  expect(xmlText(xml, 'executable')).toBe(join(f.runtimeRoot, 'bin/bun.exe'));
  expect(xmlText(xml, 'arguments')).toBe(`--no-env-file "${join(f.runtimeRoot, 'apps/service.js')}" --installation-file "${f.record}"`);
  expect(xmlText(xml, 'workingdirectory')).toBe(f.runtimeRoot);
  expect(xmlText(xml, 'allowservicelogon')).toBe('false');
  const domain = xmlText(xml, 'domain'), user = xmlText(xml, 'user'); expect(domain.trim()).not.toBe(''); expect(user.trim()).not.toBe('');
  expect(await accountSid(domain + '\\' + user)).toBe(f.installation.ownerSid);
  expect(await f.api.readPublishedServiceConfiguration(f.installation)).toEqual(first);
  expect(await f.api.publishServiceConfiguration(f.installation)).toEqual(first);
  expect(readFileSync(configurationFile).equals(bytes)).toBe(true);
  expect(readdirSync(dirname(configurationFile)).some(name => name.endsWith('.tmp'))).toBe(false);
  f.assertReadOnlyPreparation();
}, 30000);

it('does not overwrite the first installation XML for a second saved installation using the same runtime', async () => {
  const f = await fixture(), first = await f.api.publishServiceConfiguration(f.installation);
  if (!first.ok) throw Error(first.error.code); const original = readFileSync(first.data.configurationFile);
  const secondRoot = join(f.root, '第二份 data'); mkdirSync(secondRoot);
  const second = await f.api.prepareServiceInstallation({ runtimeRoot: f.runtimeRoot, dataRoot: secondRoot });
  if (!second.ok) throw Error(second.error.code);
  expect(second.data.installationId).not.toBe(f.installation.installationId);
  expect(await f.api.publishServiceConfiguration(second.data)).toMatchObject({ ok: false });
  expect(await f.api.readPublishedServiceConfiguration(second.data)).toMatchObject({ ok: false });
  expect(readFileSync(first.data.configurationFile).equals(original)).toBe(true);
  expect(existsSync(join(secondRoot, 'data/app.sqlite'))).toBe(false); f.assertReadOnlyPreparation();
}, 30000);

it('rejects modified published XML without repairing or replacing those bytes', async () => {
  const f = await fixture(), published = await f.api.publishServiceConfiguration(f.installation);
  if (!published.ok) throw Error(published.error.code);
  const changed = Buffer.concat([readFileSync(published.data.configurationFile), Buffer.from('\n<!-- changed publication -->\n')]);
  writeFileSync(published.data.configurationFile, changed);
  expect(await f.api.readPublishedServiceConfiguration(f.installation)).toMatchObject({ ok: false });
  expect(await f.api.publishServiceConfiguration(f.installation)).toMatchObject({ ok: false });
  expect(readFileSync(published.data.configurationFile).equals(changed)).toBe(true); f.assertReadOnlyPreparation();
}, 30000);

it('rejects published XML reached through a linked wrapper directory without following or replacing its publication', async () => {
  const f = await fixture(), published = await f.api.publishServiceConfiguration(f.installation);
  if (!published.ok) throw Error(published.error.code);
  const directory = dirname(published.data.configurationFile), moved = join(f.runtimeRoot, 'service-original');
  const original = readFileSync(published.data.configurationFile);
  expect(dirname(directory)).toBe(f.runtimeRoot); expect(dirname(moved)).toBe(f.runtimeRoot);
  renameSync(directory, moved); symlinkSync(moved, directory, 'junction');
  expect(await f.api.readPublishedServiceConfiguration(f.installation)).toMatchObject({ ok: false });
  expect(await f.api.publishServiceConfiguration(f.installation)).toMatchObject({ ok: false });
  expect(readFileSync(join(moved, basename(published.data.configurationFile))).equals(original)).toBe(true); f.assertReadOnlyPreparation();
}, 30000);

it('rejects changed saved owner, record version and release identity while retaining the original published XML', async () => {
  const f = await fixture(), published = await f.api.publishServiceConfiguration(f.installation);
  if (!published.ok) throw Error(published.error.code); const original = readFileSync(published.data.configurationFile);
  for (const change of [{ ownerSid: 'S-1-5-21-100-200-300-1002' }, { version: 2 }, { releaseId: randomUUID() }]) {
    const changed = JSON.stringify({ ...f.installation, ...change }); writeFileSync(f.record, changed);
    expect(await f.api.readPublishedServiceConfiguration(f.installation)).toMatchObject({ ok: false });
    expect(await f.api.publishServiceConfiguration(f.installation)).toMatchObject({ ok: false });
    expect(readFileSync(published.data.configurationFile).equals(original)).toBe(true);
    expect(readFileSync(f.record, 'utf8')).toBe(changed);
  }
  writeFileSync(f.record, f.originalRecord); f.assertReadOnlyPreparation();
}, 30000);

async function maintenanceFixture() {
  const { packageOwnerFixture, installOwnerFixture, removeOwnerFixture } = await import('../service/owner-fixture.ts');
  const packaged = await packageOwnerFixture(); deferCleanup(() => removeOwnerFixture(packaged.root));
  const installation = await installOwnerFixture(packaged.runtimeRoot); deferCleanup(() => removeOwnerFixture(installation.dataRoot));
  const { publishServiceConfiguration } = await import('../../packages/shared/src/service-layout.ts');
  const published = await publishServiceConfiguration(installation); if (!published.ok) throw Error(published.error.code);
  return { ...packaged, installation };
}

async function offlineCommand(root: string, installation: ServiceInstallation, status: string, args: string[]) {
  const preload = join(root, 'maintenance-status-preload.js'), callsFile = join(root, 'maintenance-status-calls.jsonl');
  writeFileSync(callsFile, '');
  writeFileSync(preload, `import { appendFileSync } from 'node:fs';
    Bun.spawn = (command, options) => {
      if (!Array.isArray(command) || command.length !== 2 || command[0] !== ${JSON.stringify(join(installation.runtimeRoot, 'service/FlowmateRuntime.exe'))}
        || command[1] !== 'status' || options.cwd !== ${JSON.stringify(join(installation.runtimeRoot, 'service'))})
        throw Error('Only the fixed status command may be intercepted by this isolated fixture.');
      appendFileSync(${JSON.stringify(callsFile)}, JSON.stringify({command, cwd: options.cwd}) + '\\n');
      return { exited: Promise.resolve(0), stdout: new Response(${JSON.stringify(status)}).body, killed: false, signalCode: null };
    };`);
  const child = Bun.spawn([process.execPath, '--no-env-file', '--preload', preload, join(installation.runtimeRoot, 'apps/maintenance.js'), ...args],
    { stdout: 'pipe', stderr: 'pipe', env: {}, timeout: 25000 });
  const [stdout, stderr, code] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
  expect(stderr).toBe('');
  const calls = readFileSync(callsFile, 'utf8').trim();
  return { code, output: JSON.parse(stdout), calls: calls ? calls.split('\n').map(line => JSON.parse(line)) : [] };
}

it('refuses an enabled original service backup while its fixed SCM status is Started before changing database or installation bytes', async () => {
  const f = await maintenanceFixture(), installationFile = join(f.installation.dataRoot, 'service-installation.json');
  const databaseFile = join(f.installation.dataRoot, 'data/app.sqlite'), original = readFileSync(databaseFile), saved = readFileSync(installationFile);
  const destination = join(f.root, 'blocked-running-backup');
  const result = await offlineCommand(f.root, f.installation, 'Started', ['backup', '--user-data-root', f.installation.dataRoot, '--destination', destination]);
  expect(result.code).toBe(1);
  expect(result.output.result).toMatchObject({ ok: false, error: { code: 'service_stop_unconfirmed' } });
  expect(result.calls).toEqual([{ command: [join(f.installation.runtimeRoot, 'service/FlowmateRuntime.exe'), 'status'], cwd: join(f.installation.runtimeRoot, 'service') }]);
  expect(existsSync(destination)).toBe(false); expect(readFileSync(databaseFile).equals(original)).toBe(true);
  expect(readFileSync(installationFile).equals(saved)).toBe(true);
}, 45000);

async function savedOfflineFacts(installation: ServiceInstallation) {
  const resolved = resolveProductPaths(installation.dataRoot); if (!resolved.ok) throw Error(resolved.error.code);
  const paths = resolved.data, lease = await acquireProductControllerLock(paths); if (!lease.ok) throw Error(lease.error.code);
  deferCleanup(() => lease.data.release());
  const opened = openTestDatabase(paths); if (!opened.ok) { await lease.data.release(); throw Error(opened.error.code); }
  const database = opened.data;
  const files = createFileStore(paths, database), now = () => new Date().toISOString();
  const documents = createDocumentService({ paths, files, allowedSourceRoot: paths.root, now,
    transaction: action => database.transaction(scope => action({ repository: scope.documents,
      files: { read: (artifact, name) => files.read(artifact, name, scope.contents) } })) });
  const storage = await createDurableSqliteStorage(database.coordinator), harness = await Harness.open(storage, {
    models: createModels({ credentials: new InMemoryCredentialStore(), modelsStore: new InMemoryModelsStore(),
      authContext: { env: async () => undefined, fileExists: async () => false } }), registry: createRegistry() }, BACKGROUND_CONTEXT);
  try {
    const text = 'Original offline maintenance invoice total 113.00';
    const material = await documents.importPrepared({ contract: 'flowmate-prepared-invoice/v1', sample: 'offline-maintenance-original', sourceText: text,
      original: { name: 'source.md', base64: Buffer.from(text).toString('base64') },
      pages: [{ page: 1, blocks: [{ id: 'b1', kind: 'text', text, sourceIndex: 0, sourceType: 'prepared-text', bbox: null }] }] });
    if (!material.ok) throw Error(material.error.code);
    const conversation = await harness.commit(tx => tx.createConversation({ ownership: { kind: 'ownerless' } }), BACKGROUND_CONTEXT);
    await database.transaction(scope => {
      const session = scope.sessions.create({ runtimeKind: 'durable', nativeSessionId: null, title: 'Original native maintenance binding', at: now() });
      if (!session.ok) throw Error(session.error.code);
      const bound = scope.sessions.bindDurableConversation(session.data.sessionId, conversation.id, now()); if (!bound.ok) throw Error(bound.error.code);
      const agent = scope.personalAgents.getDefault(); if (!agent.ok || !agent.data) throw Error('Expected the original service Personal Agent.');
      const work = scope.invoiceWorks.create({ personalAgentId: agent.data.personalAgentId, expectedAgentRevision: agent.data.revision,
        requestId: 'original-offline-maintenance-work', goal: 'Retain the original fixed invoice through offline maintenance.', documents: [material.data.documentRef] },
      { at: now(), admission: { kind: 'waiting', reason: 'Original offline business record has no execution authorization.' } });
      if (!work.ok) throw Error(work.error.code);
    });
  } finally { await harness.close(BACKGROUND_CONTEXT); await database.close(); await lease.data.release(); }
  return paths;
}

function databaseFacts(file: string) {
  const database = new Database(file, { readonly: true });
  try {
    const tables = database.query<{ name: string }, []>("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name").all();
    return Object.fromEntries(tables.map(table => [table.name, database.query('SELECT * FROM "' + table.name.replaceAll('"', '""') + '"').all()]));
  } finally { database.close(); }
}

it('backs up all real product/native tables and assets only after Stopped and verifies an unchanged identity copy without operating the live service', async () => {
  const f = await maintenanceFixture(), paths = await savedOfflineFacts(f.installation), destination = join(f.root, 'stopped-complete-backup');
  const record = readFileSync(join(paths.root, 'service-installation.json'));
  const backed = await offlineCommand(f.root, f.installation, 'Stopped', ['backup', '--user-data-root', paths.root, '--destination', destination]);
  expect(backed.code).toBe(0); expect(backed.output.result).toMatchObject({ ok: true, data: { schemaVersion: 22, settingsVersion: 7 } });
  expect(backed.calls).toHaveLength(1);
  const original = databaseFacts(paths.databaseFile), copied = databaseFacts(join(destination, 'data/app.sqlite'));
  expect(copied).toEqual(original); expect(copied.fm_durable_durable_schema).toEqual([{ singleton: 1, version: 2 }]);
  expect(copied.fm_durable_conversations).toHaveLength(1); expect(copied.invoice_works).toHaveLength(1);
  const manifest = JSON.parse(readFileSync(join(destination, 'manifest.json'), 'utf8')) as { files: Array<{ path: string; byteLength: number }> };
  expect(manifest.files.some(file => file.path.startsWith('artifacts/'))).toBe(true);
  const restored = join(f.root, 'restored-copy'); mkdirSync(restored);
  for (const file of manifest.files) {
    const target = join(restored, file.path); mkdirSync(dirname(target), { recursive: true }); copyFileSync(join(destination, file.path), target);
    expect(readFileSync(target)).toEqual(readFileSync(join(paths.root, file.path)));
  }
  expect(readFileSync(join(restored, 'service-installation.json'))).toEqual(record);
  const { spawnOwnerFixture } = await import('../service/owner-fixture.ts'), owner = await spawnOwnerFixture(f.installation);
  try {
    const checked = await offlineCommand(f.root, f.installation, 'Started', ['verify-restore', '--user-data-root', restored, '--backup', destination]);
    expect(checked.code).toBe(0); expect(checked.output.result).toMatchObject({ ok: true, data: { readable: true,
      runtimeValidation: 'pending', gaps: expect.arrayContaining(['service_installation_identity_and_activation_recheck', 'service_installation_original_root_mismatch']) } });
    expect(checked.calls).toEqual([]); expect(databaseFacts(join(restored, 'data/app.sqlite'))).toEqual(copied);
    expect(readFileSync(join(restored, 'service-installation.json'))).toEqual(record);
    expect(owner.child.exitCode).toBeNull();
  } finally {
    expect(await owner.close()).toMatchObject({ ok: true, data: { closed: true, stopped: true } }); expect(await owner.child.exited).toBe(0);
  }
}, 60000);

it('keeps enabled maintenance blocked on absent or unknown SCM state, original live ownership and another installed release', async () => {
  const f = await maintenanceFixture(), paths = resolveProductPaths(f.installation.dataRoot); if (!paths.ok) throw Error(paths.error.code);
  const args = (destination: string) => ['backup', '--user-data-root', paths.data.root, '--destination', destination];
  for (const [status, code] of [['NonExistent', 'service_stop_unconfirmed'], ['StopPending', 'service_management_result_unknown']]) {
    const destination = join(f.root, 'refused-' + status), before = readFileSync(paths.data.databaseFile);
    const checked = await offlineCommand(f.root, f.installation, status!, args(destination));
    expect(checked.code).toBe(1); expect(checked.output.result).toMatchObject({ ok: false, error: { code } });
    expect(existsSync(destination)).toBe(false); expect(readFileSync(paths.data.databaseFile)).toEqual(before);
  }
  const { spawnOwnerFixture } = await import('../service/owner-fixture.ts'), owner = await spawnOwnerFixture(f.installation);
  try {
    const checked = await offlineCommand(f.root, f.installation, 'Stopped', args(join(f.root, 'refused-owned')));
    expect(checked.output.result).toMatchObject({ ok: false, error: { code: 'runtime_already_owned' } }); expect(checked.calls).toEqual([]);
  } finally { expect(await owner.close()).toMatchObject({ ok: true, data: { stopped: true, closed: true } }); expect(await owner.child.exited).toBe(0); }
  const releaseFile = join(f.runtimeRoot, 'release.json'), originalRelease = readFileSync(releaseFile), originalRecord = readFileSync(join(paths.data.root, 'service-installation.json'));
  try {
    writeFileSync(releaseFile, JSON.stringify({ ...JSON.parse(originalRelease.toString('utf8')), releaseId: randomUUID() }));
    const destination = join(f.root, 'refused-release'), checked = await offlineCommand(f.root, f.installation, 'Stopped', args(destination));
    expect(checked.output.result).toMatchObject({ ok: false, error: { code: 'service_installation_incompatible' } });
    expect(checked.calls).toEqual([]); expect(existsSync(destination)).toBe(false);
    expect(readFileSync(join(paths.data.root, 'service-installation.json'))).toEqual(originalRecord);
  } finally { writeFileSync(releaseFile, originalRelease); }
}, 60000);
