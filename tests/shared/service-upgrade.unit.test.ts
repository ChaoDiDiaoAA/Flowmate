import { afterAll, afterEach, beforeAll, expect, it, mock, spyOn } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { cp, open, rename } from 'node:fs/promises';
import * as files from 'node:fs/promises';
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { basename, join } from 'node:path';
import { appError, fail, ok } from '@flowmate/contracts';
import { prepareServiceInstallation, type ServiceInstallation } from '../../packages/shared/src/service-layout.ts';
import * as identity from '../../packages/shared/src/windows-identity.ts';
import { packageOwnerFixture, removeOwnerFixture } from '../service/owner-fixture.ts';

const sid = 'S-1-5-21-1000-1001-1002-1003';
const actualOpen = open, actualRename = rename;
let packaged: Awaited<ReturnType<typeof packageOwnerFixture>>, targetRuntimeRoot: string, targetReleaseId: string, releaseBytes: string;
beforeAll(async () => {
  packaged = await packageOwnerFixture(); targetRuntimeRoot = join(packaged.root, 'next/resources/flowmate-runtime');
  await cp(packaged.runtimeRoot, targetRuntimeRoot, { recursive: true });
  const releaseFile = join(targetRuntimeRoot, 'release.json'); targetReleaseId = randomUUID();
  const release = JSON.parse(readFileSync(releaseFile, 'utf8')); release.releaseId = targetReleaseId;
  releaseBytes = JSON.stringify(release, null, 2) + '\n'; writeFileSync(releaseFile, releaseBytes);
}, 90000);
afterAll(() => { if (packaged) removeOwnerFixture(packaged.root); });
afterEach(() => { mock.restore(); writeFileSync(join(targetRuntimeRoot, 'release.json'), releaseBytes); });

async function fixture() {
  const owner = spyOn(identity, 'readCurrentWindowsSid').mockResolvedValue(ok(sid));
  const processLaunch = spyOn(Bun, 'spawn').mockImplementation(() => { throw Error('No process or SCM operation is permitted in publication unit tests.'); });
  const dataRoot = join(packaged.root, 'data-' + randomUUID()); mkdirSync(dataRoot);
  const prepared = await prepareServiceInstallation({ runtimeRoot: packaged.runtimeRoot, dataRoot });
  if (!prepared.ok) throw Error(prepared.error.code);
  // Metadata fixture only; the maintenance caller separately verifies database and SCM stop facts.
  const original: ServiceInstallation = { ...prepared.data, enabled: true, activationOperationId: randomUUID(), activationSettingsRevision: 7 };
  const installationFile = join(dataRoot, 'service-installation.json'), bytes = JSON.stringify(original, null, 2) + '\n';
  writeFileSync(installationFile, bytes); writeFileSync(join(dataRoot, 'original-business.txt'), 'Keep the original business bytes.');
  const request = { installationFile, original, targetRuntimeRoot };
  return { owner, processLaunch, request, installationFile, dataRoot, bytes,
    expected: { ...original, runtimeRoot: targetRuntimeRoot, releaseId: targetReleaseId },
    assertRetained(temporaryFiles: readonly string[] = []) { expect(readFileSync(join(dataRoot, 'original-business.txt'), 'utf8')).toBe('Keep the original business bytes.');
      expect(existsSync(join(dataRoot, 'data/app.sqlite'))).toBe(false); expect(processLaunch).not.toHaveBeenCalled();
      expect(readdirSync(dataRoot).filter(name => name.endsWith('.tmp')).sort()).toEqual(temporaryFiles.map(file => basename(file)).sort()); } };
}

it('publishes only the two release fields and preserves the original owner, data root and complete activation tuple', async () => {
  const f = await fixture(), { publishServiceRelease } = await import('../../packages/shared/src/service-upgrade.ts');
  expect(await publishServiceRelease(f.request)).toEqual(ok(f.expected));
  expect(JSON.parse(readFileSync(f.installationFile, 'utf8'))).toEqual(f.expected); f.assertRetained();
});

it('recovers a repeated original-to-target intent without rewriting its committed record bytes', async () => {
  const f = await fixture(), { publishServiceRelease } = await import('../../packages/shared/src/service-upgrade.ts');
  expect(await publishServiceRelease(f.request)).toEqual(ok(f.expected));
  const bytes = readFileSync(f.installationFile, 'utf8'), publish = spyOn(files, 'rename');
  expect(await publishServiceRelease(f.request)).toEqual(ok(f.expected));
  expect(publish).not.toHaveBeenCalled(); expect(readFileSync(f.installationFile, 'utf8')).toBe(bytes); f.assertRetained();
});

it('rejects a changed original record instead of replacing a newer activation basis', async () => {
  const f = await fixture(), { publishServiceRelease } = await import('../../packages/shared/src/service-upgrade.ts');
  const changed = JSON.stringify({ ...f.request.original, activationSettingsRevision: 8 }); writeFileSync(f.installationFile, changed);
  expect(await publishServiceRelease(f.request)).toMatchObject({ ok: false, error: { code: 'service_upgrade_record_changed' } });
  expect(readFileSync(f.installationFile, 'utf8')).toBe(changed); f.assertRetained();
});

it('refuses disabled or incomplete activation and a different record path before publication', async () => {
  const f = await fixture(), { publishServiceRelease } = await import('../../packages/shared/src/service-upgrade.ts');
  for (const original of [{ ...f.request.original, enabled: false }, { ...f.request.original, activationOperationId: null },
    { ...f.request.original, activationSettingsRevision: null }]) expect(await publishServiceRelease({ ...f.request, original }))
    .toMatchObject({ ok: false, error: { code: 'service_upgrade_request_invalid' } });
  expect(await publishServiceRelease({ ...f.request, installationFile: join(packaged.root, 'service-installation.json') })).toMatchObject({ ok: false });
  expect(readFileSync(f.installationFile, 'utf8')).toBe(f.bytes); f.assertRetained();
});

it('refuses another actual process SID or an unavailable identity without changing original bytes', async () => {
  const f = await fixture(), { publishServiceRelease } = await import('../../packages/shared/src/service-upgrade.ts');
  f.owner.mockResolvedValue(ok(sid + '-9'));
  expect(await publishServiceRelease(f.request)).toMatchObject({ ok: false, error: { code: 'service_account_mismatch' } });
  f.owner.mockResolvedValue(fail(appError('windows_identity_unavailable', 'runtime', 'Controlled unavailable identity.')));
  expect(await publishServiceRelease(f.request)).toMatchObject({ ok: false, error: { code: 'windows_identity_unavailable' } });
  expect(readFileSync(f.installationFile, 'utf8')).toBe(f.bytes); f.assertRetained();
});

it('rejects missing or incompatible target releases and preserves the original record', async () => {
  const f = await fixture(), { publishServiceRelease } = await import('../../packages/shared/src/service-upgrade.ts');
  expect(await publishServiceRelease({ ...f.request, targetRuntimeRoot: 'relative-runtime' })).toMatchObject({ ok: false });
  expect(await publishServiceRelease({ ...f.request, targetRuntimeRoot: join(packaged.root, 'missing/flowmate-runtime') })).toMatchObject({ ok: false });
  const releaseFile = join(targetRuntimeRoot, 'release.json');
  for (const patch of [{ schemaVersion: 20 }, { settingsVersion: 6 }, { sdkVersion: '1.3.0' }, { service: undefined }]) {
    writeFileSync(releaseFile, JSON.stringify({ ...JSON.parse(releaseBytes), ...patch }));
    expect(await publishServiceRelease(f.request)).toMatchObject({ ok: false });
    expect(readFileSync(f.installationFile, 'utf8')).toBe(f.bytes);
  }
  f.assertRetained();
});

it('checks original bytes again after preparing the synced publication and preserves a concurrent formatting change', async () => {
  const f = await fixture(), { publishServiceRelease } = await import('../../packages/shared/src/service-upgrade.ts');
  const changed = f.bytes + '\n', publication = spyOn(files, 'rename');
  spyOn(files, 'open').mockImplementation(async (...args: Parameters<typeof open>) => {
    expect(args[1]).toBe('wx'); const handle = await actualOpen(...args); writeFileSync(f.installationFile, changed); return handle;
  });
  expect(await publishServiceRelease(f.request)).toMatchObject({ ok: false, error: { code: 'service_upgrade_record_changed' } });
  expect(publication).not.toHaveBeenCalled(); expect(readFileSync(f.installationFile, 'utf8')).toBe(changed); f.assertRetained();
});

for (const point of ['before', 'after'] as const) it('retains actual publication facts when rename fails ' + point + ' its real commit', async () => {
  const f = await fixture(), { publishServiceRelease } = await import('../../packages/shared/src/service-upgrade.ts');
  let staged = '';
  const publication = spyOn(files, 'rename').mockImplementation(async (...args: Parameters<typeof rename>) => {
    staged = String(args[0]);
    if (point === 'after') await actualRename(...args);
    throw Object.assign(Error('Controlled publication acknowledgement failure.'), { code: 'EIO' });
  });
  expect(await publishServiceRelease(f.request)).toMatchObject({ ok: false, error: { code: 'service_upgrade_write_unconfirmed' } });
  if (point === 'before') expect(readFileSync(f.installationFile, 'utf8')).toBe(f.bytes);
  else expect(JSON.parse(readFileSync(f.installationFile, 'utf8'))).toEqual(f.expected);
  publication.mockRestore(); expect(await publishServiceRelease(f.request)).toEqual(ok(f.expected));
  f.assertRetained(point === 'before' ? [staged] : []);
});

it('never removes a temporary path it did not create exclusively', async () => {
  const f = await fixture(), { publishServiceRelease } = await import('../../packages/shared/src/service-upgrade.ts');
  let temporary = '';
  spyOn(files, 'open').mockImplementation(async (...args: Parameters<typeof open>) => {
    expect(args[1]).toBe('wx'); temporary = String(args[0]); writeFileSync(temporary, 'Unowned collision bytes.');
    throw Object.assign(Error('Controlled exclusive-create collision.'), { code: 'EEXIST' });
  });
  expect(await publishServiceRelease(f.request)).toMatchObject({ ok: false, error: { code: 'service_upgrade_write_unconfirmed' } });
  expect(readFileSync(temporary, 'utf8')).toBe('Unowned collision bytes.'); expect(readFileSync(f.installationFile, 'utf8')).toBe(f.bytes);
  expect(f.processLaunch).not.toHaveBeenCalled();
});

it('preserves a later source-path replacement when rename committed but its acknowledgement is unknown', async () => {
  const f = await fixture(), { publishServiceRelease } = await import('../../packages/shared/src/service-upgrade.ts');
  let replacement = '';
  const publication = spyOn(files, 'rename').mockImplementation(async (...args: Parameters<typeof rename>) => {
    await actualRename(...args); replacement = String(args[0]); writeFileSync(replacement, 'Later source-path replacement.');
    throw Object.assign(Error('Controlled lost acknowledgement after the real commit.'), { code: 'EIO' });
  });
  expect(await publishServiceRelease(f.request)).toMatchObject({ ok: false, error: { code: 'service_upgrade_write_unconfirmed' } });
  expect(existsSync(replacement)).toBe(true); expect(readFileSync(replacement, 'utf8')).toBe('Later source-path replacement.');
  expect(JSON.parse(readFileSync(f.installationFile, 'utf8'))).toEqual(f.expected);
  publication.mockRestore(); expect(await publishServiceRelease(f.request)).toEqual(ok(f.expected)); f.assertRetained([replacement]);
});
