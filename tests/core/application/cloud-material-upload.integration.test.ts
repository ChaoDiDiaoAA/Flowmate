import { expect, test } from 'bun:test';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import type { ChildProcessWithoutNullStreams } from 'node:child_process';
import { createFileStore } from '../../../packages/core/src/storage/file-store.ts';
import { createDocumentService } from '@flowmate/data';
import { CloudMaterialUpload } from '../../../apps/cloud-material-upload.ts';
import { CloudMaterialExport } from '../../../apps/cloud-material-export.ts';
import { uploadCloudMaterial } from '../../../apps/desktop/main/cloud-material-transfer.ts';
import { CloudSshSession } from '../../../apps/desktop/main/cloud-ssh-session.ts';
import { runCloudDesktopBridge } from '../../../apps/cloud-desktop-bridge.ts';
import { createCloudDesktopHandler } from '../../../apps/cloud-desktop-gateway.ts';
import { openTestDatabase } from '../../support/database.ts';
import { mkdtempSync } from '../../support/resources.ts';
import { appError, DocumentRefSchema, fail, ok, type Result } from '@flowmate/contracts';

function need<T>(value: Result<T>): T { if (!value.ok) throw Error(value.error.code); return value.data; }

test('cloud material chunks preserve original bytes, versions and one receipt across a retry and reopen', async () => {
  const root = mkdtempSync(join(tmpdir(), 'flowmate-cloud-material-'));
  const paths = { root, databaseFile: join(root, 'data/app.sqlite'), artifactsDir: join(root, 'artifacts'),
    outputsDir: join(root, 'outputs'), runtimeDir: join(root, 'runtime'), logsDir: join(root, 'logs') };
  let database = need(openTestDatabase(paths));
  const sourceText = 'Original invoice total 113.00', pages = [{ page: 1, blocks: [{ id: 'b1', kind: 'text', text: sourceText,
    sourceIndex: 0, sourceType: 'prepared-text', bbox: null }] }];
  const files = [
    { kind: 'original' as const, name: 'source.md' as const, mimeType: 'text/markdown', content: Buffer.from(sourceText + ' '.repeat(262_144)) },
    { kind: 'parsed' as const, name: 'parsed.json' as const, mimeType: 'application/json', content: Buffer.from(JSON.stringify({ formatVersion: 2, pages,
      completeness: { status: 'complete', checks: ['frozen-prepared-source', 'sequential-pages-and-blocks'], warnings: [] } })) },
    { kind: 'parsed' as const, name: 'raw-content.json' as const, mimeType: 'application/json', content: Buffer.from(JSON.stringify(sourceText)) },
    { kind: 'parsed' as const, name: 'raw-pages.json' as const, mimeType: 'application/json', content: Buffer.from(JSON.stringify(pages)) },
    { kind: 'parsed' as const, name: 'source.json' as const, mimeType: 'application/json', content: Buffer.from(JSON.stringify({ contract: 'flowmate-prepared-invoice/v1',
      sample: 'controlled-cloud-invoice', original: { name: 'source.md' } })) },
  ];
  const manifest = { version: 1 as const, workspaceId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
    uploadId: '11111111-1111-4111-8111-111111111111', sourceDocumentRef: { id: 7, version: 'v1' },
    sourceKey: 'prepared-invoice', sourceRecordId: 'controlled-cloud-invoice', sourceVersion: 'v1', originalName: 'source.md',
    metadata: { version: 2 as const, pageCount: 1, warnings: [], allowedUsesClaim: ['caller-supplied'], licenseVerification: 'caller-supplied', unavailableReason: null },
    files: files.map(({ content, ...file }) => ({ ...file, bytes: content.length })) };
  const create = (loseReceipt = false) => {
    const store = createFileStore(paths, database), documents = createDocumentService({ paths, files: store, allowedSourceRoot: root,
      now: () => '2026-11-05T00:00:00.000Z', transaction: action => database.transaction(scope => action({ repository: scope.documents,
        files: { read: (artifact, name) => store.read(artifact, name, scope.contents) } })) });
    if (loseReceipt) {
      const publish = store.publish.bind(store);
      store.publish = (async (input, workflow) => { const result = await publish(input, workflow);
        if (result.ok) throw Error('Controlled lost publication receipt.'); return result; }) as typeof store.publish;
    }
    return new CloudMaterialUpload({ database, files: store, now: () => '2026-11-05T00:00:00.000Z',
      inspect: (ref, scope) => documents.inspectForWorkspace(ref, { repository: scope.documents,
        files: { read: (artifact, name) => store.read(artifact, name, scope.contents) } }) });
  };
  let upload = create();
  try {
    expect(need(await upload.begin(manifest))).toMatchObject({ status: 'receiving' });
    const identity = { workspaceId: manifest.workspaceId, uploadId: manifest.uploadId };
    expect(need(await upload.status(identity))).toEqual({ ...identity, status: 'receiving', receipt: null,
      files: files.map(file => ({ kind: file.kind, name: file.name, offset: 0 })) });
    expect(await upload.status({ ...identity, workspaceId: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb' })).toMatchObject({ ok: false });
    expect(await upload.finish({ workspaceId: manifest.workspaceId, uploadId: manifest.uploadId })).toMatchObject({ ok: false });
    expect(await upload.append({ ...identity, kind: 'original', name: 'source.md', offset: 0,
      base64: files[0]!.content.subarray(0, 3).toString('base64') })).toMatchObject({ ok: false });
    for (const file of files) {
      const half = Math.min(262_144, file.content.length);
      const chunk = { workspaceId: manifest.workspaceId, uploadId: manifest.uploadId, kind: file.kind, name: file.name,
        offset: 0, base64: file.content.subarray(0, half).toString('base64') };
      need(await upload.append(chunk)); need(await upload.append(chunk));
      expect(need(await upload.status(identity)).files.find(item => item.kind === file.kind && item.name === file.name)?.offset).toBe(half);
      expect(await upload.append({ ...chunk, base64: Buffer.from('changed').toString('base64') })).toMatchObject({ ok: false });
      if (half < file.content.length) need(await upload.append({ ...chunk, offset: half, base64: file.content.subarray(half).toString('base64') }));
    }
    const receipt = need(await upload.finish({ workspaceId: manifest.workspaceId, uploadId: manifest.uploadId }));
    expect(need(await upload.status(identity))).toEqual({ ...identity, status: 'completed', receipt,
      files: files.map(file => ({ kind: file.kind, name: file.name, offset: file.content.length })) });
    expect(receipt).toEqual({ workspaceId: manifest.workspaceId, uploadId: manifest.uploadId, sourceDocumentRef: manifest.sourceDocumentRef,
      cloudDocumentRef: { id: 1, version: 'v1' } });
    expect(need(await upload.finish({ workspaceId: manifest.workspaceId, uploadId: manifest.uploadId }))).toEqual(receipt);
    expect(receipt.cloudDocumentRef).toEqual({ id: 1, version: 'v1' });
    expect(DocumentRefSchema.safeParse(receipt.cloudDocumentRef).success).toBe(true);
    await database.close(); database = need(openTestDatabase(paths)); upload = create();
    expect(need(await upload.finish({ workspaceId: manifest.workspaceId, uploadId: manifest.uploadId }))).toEqual(receipt);
    const store = createFileStore(paths, database), documents = createDocumentService({ paths, files: store, allowedSourceRoot: root,
      now: () => '2026-11-05T00:00:00.000Z', transaction: action => database.transaction(scope => action({ repository: scope.documents,
        files: { read: (artifact, name) => store.read(artifact, name, scope.contents) } })) });
    const inspected = need(await database.read(scope => documents.inspectForWorkspace(receipt.cloudDocumentRef, { repository: scope.documents,
      files: { read: (artifact, name) => store.read(artifact, name, scope.contents) } })));
    expect(inspected).toMatchObject({ kind: 'valid', pages: [{ page: 1, blockIds: ['b1'] }] });
    let exporter = new CloudMaterialExport({ database, files: store, now: () => '2026-11-05T00:00:00.000Z',
      inspect: (ref, scope) => documents.inspectForWorkspace(ref, { repository: scope.documents,
        files: { read: (artifact, name) => store.read(artifact, name, scope.contents) } }) });
    const prepared = need(await exporter.prepare({ workspaceId: manifest.workspaceId, documentRef: receipt.cloudDocumentRef }));
    expect(prepared.manifest.sourceDocumentRef).toEqual(receipt.cloudDocumentRef);
    expect(prepared.receipt).toBeNull();
    const exportId = prepared.manifest.uploadId;
    const first = need(await exporter.chunk({ workspaceId: manifest.workspaceId, uploadId: exportId, kind: 'original', name: 'source.md', offset: 0 }));
    expect(Buffer.from(first.base64, 'base64').equals(files[0]!.content.subarray(0, 262_144))).toBe(true);
    expect(await exporter.chunk({ workspaceId: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb', uploadId: exportId,
      kind: 'original', name: 'source.md', offset: 0 })).toMatchObject({ ok: false });
    expect(await exporter.prepare({ workspaceId: manifest.workspaceId, documentRef: { ...receipt.cloudDocumentRef, version: 'changed' } })).toMatchObject({ ok: false });
    const exportReceipt = { workspaceId: manifest.workspaceId, uploadId: exportId, sourceDocumentRef: receipt.cloudDocumentRef,
      cloudDocumentRef: { id: 3, version: 'v1' } };
    need(await exporter.complete(exportReceipt));
    expect(await exporter.complete({ ...exportReceipt, cloudDocumentRef: { id: 4, version: 'v1' } })).toMatchObject({ ok: false });
    await database.close(); database = need(openTestDatabase(paths));
    const reopenedStore = createFileStore(paths, database);
    const reopenedDocuments = createDocumentService({ paths, files: reopenedStore, allowedSourceRoot: root,
      now: () => '2026-11-05T00:00:00.000Z', transaction: action => database.transaction(scope => action({ repository: scope.documents,
        files: { read: (artifact, name) => reopenedStore.read(artifact, name, scope.contents) } })) });
    exporter = new CloudMaterialExport({ database, files: reopenedStore, now: () => '2026-11-05T00:00:00.000Z',
      inspect: (ref, scope) => reopenedDocuments.inspectForWorkspace(ref, { repository: scope.documents,
        files: { read: (artifact, name) => reopenedStore.read(artifact, name, scope.contents) } }) });
    expect(need(await exporter.prepare({ workspaceId: manifest.workspaceId, documentRef: receipt.cloudDocumentRef })))
      .toEqual({ manifest: prepared.manifest, receipt: exportReceipt });
    const transferWorkspace = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
    const gateway = createCloudDesktopHandler({ workspaceId: transferWorkspace, authorize: async () => ok(undefined),
      dispatch: async () => fail(appError('source_invalid', 'input', 'Unavailable.')), material: create() });
    const stdin = new PassThrough(), stdout = new PassThrough(), stderr = new PassThrough(); let lost = false;
    const child = Object.assign(new EventEmitter(), { stdin, stdout, stderr, kill: () => { stdin.end(); return true; } });
    const bridge = runCloudDesktopBridge(stdin, stdout, async envelope => {
      const result = await gateway(envelope);
      if (envelope.command.type === 'cloud_material_append' && result.ok && !lost) {
        lost = true; return fail(appError('cloud_transport_result_unknown', 'runtime', 'Controlled response loss.', true));
      }
      return ok(result);
    });
    bridge.then(() => child.emit('close', 0, null));
    const session = new CloudSshSession(child as unknown as ChildProcessWithoutNullStreams, transferWorkspace);
    try {
      const input = { workspaceId: transferWorkspace, documentRef: receipt.cloudDocumentRef };
      expect(await uploadCloudMaterial(input, exporter, session)).toMatchObject({ ok: false, error: { code: 'operation_result_unknown' } });
      const changed = { prepare: exporter.prepare.bind(exporter), complete: exporter.complete.bind(exporter),
        chunk: async (request: unknown) => {
          const chunk = await exporter.chunk(request); if (!chunk.ok || chunk.data.kind !== 'original' || chunk.data.offset !== 0) return chunk;
          const bytes = Buffer.from(chunk.data.base64, 'base64'); bytes[0] = bytes[0]! ^ 1;
          return ok({ ...chunk.data, base64: bytes.toString('base64') });
        } };
      expect(await uploadCloudMaterial(input, changed, session)).toMatchObject({ ok: false, error: { code: 'state_conflict' } });
      const completed = need(await uploadCloudMaterial(input, exporter, session));
      expect(completed.sourceDocumentRef).toEqual(receipt.cloudDocumentRef);
      expect(completed.cloudDocumentRef).toEqual(receipt.cloudDocumentRef);
      expect(need(await exporter.prepare(input)).receipt).toEqual(completed);
    } finally { expect(await session.close()).toEqual(ok(undefined)); expect(await bridge).toEqual(ok(undefined)); }
    const second = { ...manifest, uploadId: '22222222-2222-4222-8222-222222222222', sourceDocumentRef: { id: 8, version: 'v1' } };
    upload = create(true); need(await upload.begin(second));
    for (const file of files) for (let offset = 0; offset < file.content.length; offset += 262_144)
      need(await upload.append({ workspaceId: second.workspaceId, uploadId: second.uploadId, kind: file.kind, name: file.name,
        offset, base64: file.content.subarray(offset, offset + 262_144).toString('base64') }));
    expect(await upload.finish({ workspaceId: second.workspaceId, uploadId: second.uploadId })).toMatchObject({ ok: false });
    upload = create();
    const recovered = need(await upload.finish({ workspaceId: second.workspaceId, uploadId: second.uploadId }));
    expect(recovered).toEqual({ workspaceId: second.workspaceId, uploadId: second.uploadId, sourceDocumentRef: second.sourceDocumentRef,
      cloudDocumentRef: receipt.cloudDocumentRef });
    expect(await database.read(scope => scope.db.query('SELECT COUNT(*) count FROM documents').get())).toEqual({ count: 1 });
  } finally { await database.close(); }
});
