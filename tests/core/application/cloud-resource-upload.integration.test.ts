import { expect, test } from 'bun:test';
import { appError, CloudResourceManifestSchema, CloudResourceChunkSchema, fail, ok, resourceRefKey } from '@flowmate/contracts';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { inspectNativeResources } from '@flowmate/runtime-pi';
import { createResourceService } from '@flowmate/core';
import { CloudResourceExport } from '../../../apps/cloud-resource-export.ts';
import { CloudResourceUpload } from '../../../apps/cloud-resource-upload.ts';
import { uploadCloudResource } from '../../../apps/desktop/main/cloud-resource-transfer.ts';
import { CloudSshSession } from '../../../apps/desktop/main/cloud-ssh-session.ts';
import { runCloudDesktopBridge } from '../../../apps/cloud-desktop-bridge.ts';
import { createCloudDesktopHandler } from '../../../apps/cloud-desktop-gateway.ts';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import type { ChildProcessWithoutNullStreams } from 'node:child_process';
import { openTestDatabase } from '../../support/database.ts';
import { mkdtempSync } from '../../support/resources.ts';

test('cloud resource transfer binds a safe resource version and listed relative files', () => {
  const ref = { kind: 'prompt' as const, id: 'invoice', version: 'v1' };
  const manifest = { schemaVersion: 2 as const, ...ref, bodyFile: 'prompt.md' as const,
    keywords: [], requires: [], files: [{ path: 'prompt.md', bytes: 4 }] };
  const input = { version: 1 as const, workspaceId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
    uploadId: '11111111-1111-4111-8111-111111111111', ref, manifest, manifestBase64: Buffer.from(JSON.stringify(manifest)).toString('base64') };
  expect(CloudResourceManifestSchema.safeParse(input).success).toBe(true);
  expect(CloudResourceManifestSchema.safeParse({ ...input, ref: { ...ref, version: 'v2' } }).success).toBe(false);
  expect(CloudResourceManifestSchema.safeParse({ ...input, manifest: { ...manifest, files: [{ path: '../escape', bytes: 4 }] } }).success).toBe(false);
  expect(CloudResourceChunkSchema.safeParse({ workspaceId: input.workspaceId, uploadId: input.uploadId,
    path: '../escape', offset: 0, base64: 'AAAA' }).success).toBe(false);
});

test('cloud resource publication resumes the original chunks and never replaces another version of the same bytes', async () => {
  const root = mkdtempSync(join(tmpdir(), 'flowmate-cloud-resource-owner-')), resourceRoot = join(root, 'builtins'), importedRoot = join(root, 'imported');
  const paths = { root, databaseFile: join(root, 'data/app.sqlite'), artifactsDir: join(root, 'artifacts'), outputsDir: join(root, 'outputs'),
    runtimeDir: join(root, 'runtime'), logsDir: join(root, 'logs') };
  let opened = openTestDatabase(paths); if (!opened.ok) throw Error(opened.error.code);
  let database = opened.data;
  const ref = { kind: 'prompt' as const, id: 'invoice', version: 'v1' }, body = Buffer.from('Review the original invoice.'), extra = Buffer.alloc(262145, 65);
  const manifest = { schemaVersion: 2 as const, ...ref, bodyFile: 'prompt.md' as const, keywords: [], requires: [],
    files: [{ path: 'prompt.md', bytes: body.length }, { path: 'references/original.txt', bytes: extra.length }] };
  const originalManifest = Buffer.from(JSON.stringify(manifest, null, 2) + '\n');
  const input = { version: 1 as const, workspaceId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
    uploadId: '11111111-1111-4111-8111-111111111111', ref, manifest, manifestBase64: originalManifest.toString('base64') };
  const make = () => new CloudResourceUpload({ database, resourceRoot, importedResourceRoot: importedRoot, now: () => '2026-10-29T00:00:00.000Z' });
  let upload = make();
  const key = { workspaceId: input.workspaceId, uploadId: input.uploadId };
  const chunk = (path: string, bytes: Buffer, offset: number) => ({ ...key, path, offset, base64: bytes.subarray(offset, offset + 262144).toString('base64') });
  try {
    expect(await upload.begin(input)).toMatchObject({ ok: true, data: { status: 'receiving' } });
    expect(await upload.begin(input)).toMatchObject({ ok: true, data: { status: 'receiving' } });
    expect(await upload.finish(key)).toMatchObject({ ok: false });
    expect(await upload.append(chunk('prompt.md', body, 0))).toMatchObject({ ok: true });
    expect(await upload.append(chunk('references/original.txt', extra, 0))).toMatchObject({ ok: true });
    expect(await upload.append(chunk('references/original.txt', extra, 0))).toMatchObject({ ok: true });
    expect(await upload.append({ ...chunk('references/original.txt', extra, 0), base64: Buffer.alloc(262144, 66).toString('base64') })).toMatchObject({ ok: false });
    expect(await upload.append(chunk('references/original.txt', extra, 262144))).toMatchObject({ ok: true });
    const interrupted = join(importedRoot, 'prompts', 'invoice', 'v1'); mkdirSync(interrupted, { recursive: true });
    const temporary = join(interrupted, `.flowmate-${input.uploadId}-0.tmp`); writeFileSync(temporary, body.subarray(0, 2));
    const receipt = await upload.finish(key); expect(receipt).toEqual({ ok: true, data: { ...key, ref } });
    await expect(database.transaction(scope => scope.db.query("UPDATE cloud_resource_uploads SET receipt_json='{}' WHERE workspace_id=? AND upload_id=?")
      .run(key.workspaceId, key.uploadId))).rejects.toThrow();
    const dir = join(importedRoot, 'prompts', 'invoice', 'v1');
    expect(readFileSync(join(dir, 'resource.json')).equals(originalManifest)).toBe(true);
    expect(readFileSync(join(dir, 'prompt.md')).equals(body)).toBe(true);
    expect(readFileSync(join(dir, 'references/original.txt')).equals(extra)).toBe(true);
    expect(existsSync(temporary)).toBe(false);
    const hub = createResourceService({ resourceRoot, importedResourceRoot: importedRoot, bundleRoot: join(root, 'bundles'),
      contents: database.contents, registeredToolNames: [], inspectNativeResources });
    const freeze = () => hub.freeze({ selection: { prompt: ref, enabledSkills: [] }, settingsRevision: 1, activeToolNames: [], requiredSkill: null });
    writeFileSync(join(dir, 'prompt.md'), Buffer.alloc(body.length, 88));
    expect(freeze()).toMatchObject({ ok: false });
    writeFileSync(join(dir, 'prompt.md'), body);
    writeFileSync(join(dir, 'resource.json'), JSON.stringify(manifest));
    expect(freeze()).toMatchObject({ ok: false });
    writeFileSync(join(dir, 'resource.json'), originalManifest);
    expect(freeze()).toMatchObject({ ok: true });
    const ownerId = resourceRefKey(ref);
    await database.transaction(scope => scope.db.query("DELETE FROM managed_file_contents WHERE owner_kind='cloud-resource-manifest' AND owner_id=? AND relative_path='resource.json'").run(ownerId));
    expect(freeze()).toMatchObject({ ok: false });
    await database.transaction(scope => scope.contents.remember({ ownerKind: 'cloud-resource-manifest', ownerId, relativePath: 'resource.json' }, originalManifest));
    await database.transaction(scope => scope.db.query("DELETE FROM managed_file_contents WHERE owner_kind='resource-author' AND owner_id=? AND relative_path='prompt.md'").run(ownerId));
    expect(freeze()).toMatchObject({ ok: false });
    await database.transaction(scope => scope.contents.remember({ ownerKind: 'resource-author', ownerId, relativePath: 'prompt.md' }, body));
    await database.close(); opened = openTestDatabase(paths); if (!opened.ok) throw Error(opened.error.code); database = opened.data; upload = make();
    expect(await upload.finish(key)).toEqual(receipt);
    expect(await database.read(scope => scope.db.query('SELECT kind,resource_id,resource_version FROM cloud_workspace_resources WHERE workspace_id=?').get(input.workspaceId)))
      .toEqual({ kind: 'prompt', resource_id: 'invoice', resource_version: 'v1' });
    const otherKey = { ...key, uploadId: '22222222-2222-4222-8222-222222222222' };
    expect(await upload.begin({ ...input, ...otherKey })).toMatchObject({ ok: true });
    for (const [path, value] of [['prompt.md', Buffer.alloc(body.length, 88)], ['references/original.txt', extra]] as const)
      for (let offset = 0; offset < value.length; offset += 262144)
        expect(await upload.append({ ...otherKey, path, offset, base64: value.subarray(offset, offset + 262144).toString('base64') })).toMatchObject({ ok: true });
    expect(await upload.finish(otherKey)).toMatchObject({ ok: false });
    expect(readFileSync(join(dir, 'prompt.md')).equals(body)).toBe(true);
    const thirdKey = { ...key, uploadId: '33333333-3333-4333-8333-333333333333' }, added = Buffer.from('New file.');
    const different = { ...manifest, files: [...manifest.files, { path: 'new-file.txt', bytes: added.length }] };
    expect(await upload.begin({ ...input, ...thirdKey, manifest: different, manifestBase64: Buffer.from(JSON.stringify(different)).toString('base64') }))
      .toMatchObject({ ok: true });
    for (const [path, value] of [['prompt.md', body], ['references/original.txt', extra], ['new-file.txt', added]] as const)
      for (let offset = 0; offset < value.length; offset += 262144)
        expect(await upload.append({ ...thirdKey, path, offset, base64: value.subarray(offset, offset + 262144).toString('base64') })).toMatchObject({ ok: true });
    expect(await upload.finish(thirdKey)).toMatchObject({ ok: false });
    expect(existsSync(join(dir, 'new-file.txt'))).toBe(false);
  } finally { await database.close(); }
});

test('local resource export retains original manifest and bytes under one workspace upload identity', async () => {
  const root = mkdtempSync(join(tmpdir(), 'flowmate-cloud-resource-export-')), resourceRoot = join(root, 'author');
  const paths = { root, databaseFile: join(root, 'data/app.sqlite'), artifactsDir: join(root, 'artifacts'), outputsDir: join(root, 'outputs'),
    runtimeDir: join(root, 'runtime'), logsDir: join(root, 'logs') };
  let opened = openTestDatabase(paths); if (!opened.ok) throw Error(opened.error.code);
  let database = opened.data;
  const ref = { kind: 'prompt' as const, id: 'invoice', version: 'v1' }, body = Buffer.from('Review the original invoice.'), dir = join(resourceRoot, 'prompts', ref.id);
  const manifest = { schemaVersion: 2, ...ref, bodyFile: 'prompt.md', keywords: [], requires: [], files: [{ path: 'prompt.md', bytes: body.length }] };
  const originalManifest = Buffer.from(JSON.stringify(manifest, null, 2) + '\n');
  mkdirSync(dir, { recursive: true }); writeFileSync(join(dir, 'resource.json'), originalManifest); writeFileSync(join(dir, 'prompt.md'), body);
  const workspaceId = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', now = () => '2026-10-29T00:00:00.000Z';
  const make = () => new CloudResourceExport({ database, resourceRoot, inspectNativeResources, now });
  let exporter = make();
  try {
    const first = await exporter.prepare({ workspaceId, ref }); if (!first.ok) throw Error(first.error.code);
    expect(Buffer.from(first.data.manifest.manifestBase64, 'base64').equals(originalManifest)).toBe(true);
    expect(await exporter.prepare({ workspaceId, ref })).toEqual(first);
    const key = { workspaceId, uploadId: first.data.manifest.uploadId };
    const chunk = await exporter.chunk({ ...key, path: 'prompt.md', offset: 0 });
    if (!chunk.ok) throw Error(chunk.error.code);
    expect(Buffer.from(chunk.data.base64, 'base64').equals(body)).toBe(true);
    writeFileSync(join(dir, 'prompt.md'), Buffer.alloc(body.length, 88));
    expect(await exporter.chunk({ ...key, path: 'prompt.md', offset: 0 })).toMatchObject({ ok: false });
    writeFileSync(join(dir, 'prompt.md'), body);
    const receipt = { ...key, ref };
    expect(await exporter.complete(receipt)).toEqual({ ok: true, data: receipt });
    expect(await exporter.complete({ ...receipt, ref: { ...ref, version: 'v2' } })).toMatchObject({ ok: false });
    await database.close(); opened = openTestDatabase(paths); if (!opened.ok) throw Error(opened.error.code); database = opened.data;
    exporter = make(); expect(await exporter.prepare({ workspaceId, ref })).toEqual({ ok: true, data: { manifest: first.data.manifest, receipt } });
  } finally { await database.close(); }
});

test('selected resource resumes its original upload through the desktop bridge after a lost chunk receipt', async () => {
  const localRoot = mkdtempSync(join(tmpdir(), 'flowmate-cloud-resource-local-')), cloudRoot = mkdtempSync(join(tmpdir(), 'flowmate-cloud-resource-remote-'));
  const paths = (root: string) => ({ root, databaseFile: join(root, 'data/app.sqlite'), artifactsDir: join(root, 'artifacts'),
    outputsDir: join(root, 'outputs'), runtimeDir: join(root, 'runtime'), logsDir: join(root, 'logs') });
  const local = openTestDatabase(paths(localRoot)), remote = openTestDatabase(paths(cloudRoot));
  if (!local.ok || !remote.ok) throw Error('The controlled resource stores are unavailable.');
  const author = join(localRoot, 'author'), imported = join(cloudRoot, 'imported'), dir = join(author, 'prompts', 'invoice');
  mkdirSync(join(dir, 'references'), { recursive: true });
  const ref = { kind: 'prompt' as const, id: 'invoice', version: 'v1' }, body = Buffer.from('Original selected prompt.'), extra = Buffer.alloc(262145, 65);
  const manifest = { schemaVersion: 2, ...ref, bodyFile: 'prompt.md', keywords: [], requires: [],
    files: [{ path: 'prompt.md', bytes: body.length }, { path: 'references/notes.txt', bytes: extra.length }] };
  const raw = Buffer.from(JSON.stringify(manifest, null, 2));
  writeFileSync(join(dir, 'resource.json'), raw); writeFileSync(join(dir, 'prompt.md'), body); writeFileSync(join(dir, 'references/notes.txt'), extra);
  const workspaceId = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', now = () => '2026-10-29T00:00:00.000Z';
  const exporter = new CloudResourceExport({ database: local.data, resourceRoot: author, inspectNativeResources, now });
  const resources = new CloudResourceUpload({ database: remote.data, resourceRoot: join(cloudRoot, 'builtins'), importedResourceRoot: imported, now });
  const handler = createCloudDesktopHandler({ workspaceId, authorize: async () => ok(undefined),
    dispatch: async () => fail(appError('unused', 'input', 'Unused.')), resources });
  const stdin = new PassThrough(), stdout = new PassThrough(), stderr = new PassThrough(); let lost = false, lostFinish = false;
  const child = Object.assign(new EventEmitter(), { stdin, stdout, stderr, kill: () => { stdin.end(); return true; } });
  const bridge = runCloudDesktopBridge(stdin, stdout, async envelope => {
    const result = await handler(envelope);
    if (envelope.command.type === 'cloud_resource_append' && result.ok && !lost) {
      lost = true; return fail(appError('cloud_transport_result_unknown', 'runtime', 'Controlled loss.', true));
    }
    if (envelope.command.type === 'cloud_resource_finish' && result.ok && !lostFinish) {
      lostFinish = true; return fail(appError('cloud_transport_result_unknown', 'runtime', 'Controlled lost publication receipt.', true));
    }
    return ok(result);
  });
  bridge.then(() => child.emit('close', 0, null));
  const session = new CloudSshSession(child as unknown as ChildProcessWithoutNullStreams, workspaceId);
  try {
    expect(await uploadCloudResource({ workspaceId, ref }, exporter, session)).toMatchObject({ ok: false, error: { code: 'operation_result_unknown' } });
    const prepared = await exporter.prepare({ workspaceId, ref }); if (!prepared.ok) throw Error(prepared.error.code);
    expect(await uploadCloudResource({ workspaceId, ref }, exporter, session)).toMatchObject({ ok: false, error: { code: 'operation_result_unknown' } });
    const completed = await uploadCloudResource({ workspaceId, ref }, exporter, session);
    expect(completed).toEqual({ ok: true, data: { workspaceId, uploadId: prepared.data.manifest.uploadId, ref } });
    expect(readFileSync(join(imported, 'prompts', 'invoice', 'v1', 'resource.json')).equals(raw)).toBe(true);
    expect(readFileSync(join(imported, 'prompts', 'invoice', 'v1', 'references/notes.txt')).equals(extra)).toBe(true);
  } finally { expect(await session.close()).toEqual(ok(undefined)); expect(await bridge).toEqual(ok(undefined));
    await local.data.close(); await remote.data.close(); }
});
