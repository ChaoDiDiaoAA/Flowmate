import { expect, test } from 'bun:test';
import { mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { appError, fail } from '@flowmate/contracts';
import type { PreparedInvoiceMaterial, Result } from '@flowmate/contracts';
import { createFileStore } from '@flowmate/core';
import { createDocumentService } from '../../packages/data/src/documents.ts';
import type { MaterialInspectionOptions } from '../../packages/data/src/documents.ts';
import { openTestDatabase } from '../support/database.ts';
import { mkdtempSync } from '../support/resources.ts';

const at = '2026-10-28T00:00:00.000Z';
const tick = () => new Promise<void>(resolve => setImmediate(resolve));
function need<T>(result: Result<T>): T { if (!result.ok) throw Error(result.error.code); return result.data; }

function prepared(sample = 'owner-invoice'): PreparedInvoiceMaterial {
  const sourceText = 'Controlled invoice total 1.00';
  return { contract: 'flowmate-prepared-invoice/v1', sample,
    original: { name: 'source.md', base64: Buffer.from(sourceText).toString('base64') }, sourceText,
    pages: [{ page: 1, blocks: [{ id: 'b1', kind: 'text', text: sourceText,
      sourceIndex: 0, sourceType: 'prepared-text', bbox: null }] }] };
}

function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'flowmate-document-owner-'));
  const paths = { root: join(root, 'product'), databaseFile: join(root, 'product/data/app.sqlite'),
    logsDir: join(root, 'product/logs'), artifactsDir: join(root, 'product/artifacts'),
    outputsDir: join(root, 'product/outputs'), runtimeDir: join(root, 'product/runtime') };
  const store = need(openTestDatabase(paths)), files = createFileStore(paths, store);
  const service = () => createDocumentService({ paths, files,
    allowedSourceRoot: join(root, 'source'), now: () => at,
    transaction<T>(operation: (current: MaterialInspectionOptions) => Result<T>): Promise<Result<T>> {
      return store.transaction(scope => operation({ repository: scope.documents,
        files: { read: (artifact, name) => files.read(artifact, name, scope.contents) } }));
    } });
  return { root, paths, store, files, service };
}

function writeVoxelSample(directory: string) {
  mkdirSync(directory, { recursive: true });
  const original = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/a54AAAAASUVORK5CYII=', 'base64');
  const content = JSON.stringify([{ type: 'text', text: 'Controlled total 1.00', bbox: null, page_idx: 0 }]);
  const pages = JSON.stringify([{ pageNumber: 1, text: 'Controlled total 1.00', blockCount: 1 }]);
  writeFileSync(join(directory, 'original.png'), original);
  writeFileSync(join(directory, 'content.json'), content);
  writeFileSync(join(directory, 'pages.json'), pages);
  writeFileSync(join(directory, 'metadata.json'), JSON.stringify({ schemaVersion: 1, sampleId: '000001',
    datasetId: 'voxel51-hq-invoice-ocr', sourceRecordId: 'owner-voxel', datasetRevision: 'v1',
    qualityStatus: 'complete', allowedUsesClaim: ['controlled fixture'], licenseVerification: 'not_verified',
    files: [{ path: 'original.png', bytes: original.length }, { path: 'content.json', bytes: Buffer.byteLength(content) },
      { path: 'pages.json', bytes: Buffer.byteLength(pages) }] }));
}

test.each(['prepared', 'voxel51'] as const)('%s import waits for its SQL owner before publishing files', async kind => {
  const f = fixture(), service = f.service(), entered = Promise.withResolvers<void>(), release = Promise.withResolvers<void>();
  const sourceDirectory = join(f.root, 'source/000001'); writeVoxelSample(sourceDirectory);
  const holding = f.store.transaction(async () => { entered.resolve(); await release.promise; });
  await entered.promise;
  let settled = false;
  const importing = (kind === 'prepared' ? service.importPrepared(prepared()) : service.importVoxel51({ sourceDirectory }))
    .then(result => { settled = true; return result; });
  try {
    await tick(); expect(settled).toBe(false); expect(readdirSync(f.paths.artifactsDir)).toEqual([]);
    release.resolve(); await holding;
    expect(await importing).toMatchObject({ ok: true, data: { status: 'available', pageCount: 1 } });
  } finally { release.resolve(); await holding; await importing; }
});

test('invoice import waits for its registration COMMIT and returns the committed receipt once', async () => {
  const f = fixture(), transaction = f.store.transaction, release = Promise.withResolvers<void>();
  let paused = false, settled = false, registrations = 0;
  f.store.transaction = operation => transaction(async scope => {
    let registered = false;
    const register = scope.documents.register;
    scope.documents.register = input => { registered = true; registrations++; return register(input); };
    const result = await operation(scope);
    if (registered) { paused = true; await release.promise; }
    return result;
  });
  const importing = f.service().importPrepared(prepared()).then(result => { settled = true; return result; });
  try {
    await tick(); expect(paused).toBe(true); expect(settled).toBe(false);
    release.resolve(); const imported = need(await importing);
    expect(imported).toMatchObject({ documentRef: { id: 1 }, status: 'available' });
    expect(registrations).toBe(1);
    expect(await f.store.read(scope => scope.documents.get(imported.documentRef.id))).toEqual({ ok: true, data: imported });
  } finally { release.resolve(); await importing; }
});

test('two Document services sharing one FileStore finish registration before the next ID allocation', async () => {
  const f = fixture();
  const results = await Promise.all([f.service().importPrepared(prepared('first-invoice')),
    f.service().importPrepared(prepared('second-invoice'))]);
  expect(results.every(result => result.ok)).toBe(true);
  const imported = results.map(need);
  expect(imported.map(document => document.documentRef.id).sort()).toEqual([1, 2]);
  expect(await f.store.read(scope => scope.db.query('SELECT COUNT(*) AS count FROM artifacts').get())).toEqual({ count: 4 });
  expect(await f.store.read(scope => scope.db.query("SELECT COUNT(*) AS count FROM business_events WHERE type='document_imported'").get())).toEqual({ count: 2 });
});

test('concurrent identical imports share the original receipt without publishing a second pair', async () => {
  const f = fixture(), input = prepared();
  const results = await Promise.all([f.service().importPrepared(input), f.service().importPrepared(input)]);
  expect(results[0]).toMatchObject({ ok: true }); expect(results[1]).toEqual(results[0]);
  expect(readdirSync(f.paths.artifactsDir).sort()).toEqual(['1', '2']);
  expect(await f.store.read(scope => scope.db.query('SELECT COUNT(*) AS count FROM documents').get())).toEqual({ count: 1 });
});

test('a lost registration response queries its original committed receipt without registering again', async () => {
  const f = fixture(), transaction = f.store.transaction;
  let registrations = 0, lost = false;
  f.store.transaction = async operation => {
    let registered = false;
    const result = await transaction(scope => {
      const register = scope.documents.register;
      scope.documents.register = input => { registered = true; registrations++; return register(input); };
      return operation(scope);
    });
    if (registered && !lost) { lost = true; throw Error('Controlled registration response loss after COMMIT'); }
    return result;
  };
  const service = f.service(), imported = await service.importPrepared(prepared());
  expect(imported).toMatchObject({ ok: true, data: { documentRef: { id: 1 } } });
  expect(lost).toBe(true); expect(registrations).toBe(1);
  expect(await service.importPrepared(prepared())).toEqual(imported);
  expect(registrations).toBe(1);
  expect(await f.store.read(scope => scope.db.query("SELECT COUNT(*) AS count FROM business_events WHERE type='document_imported'").get())).toEqual({ count: 1 });
});

test('document restoration reads current managed content and commits a same-length corruption diagnosis', async () => {
  const f = fixture(), service = f.service(), imported = need(await service.importPrepared(prepared()));
  f.store.documents.get = () => fail(appError('storage_read_failed', 'storage', 'Expired root Document repository'));
  f.store.documents.contents!.read = () => { throw Error('Expired root managed contents'); };
  expect(await service.restoreDocument(imported.documentRef.id)).toMatchObject({ ok: true, data: { status: 'available' } });
  const artifact = need(await f.store.read(scope => scope.documents.getArtifact(imported.originalArtifactId)));
  const path = join(f.paths.root, artifact.relativePath), original = readFileSync(path), changed = Buffer.from(original);
  changed[0] = changed[0] === 67 ? 99 : 67; writeFileSync(path, changed);
  expect(changed.length).toBe(original.length);
  expect(await service.restoreDocument(imported.documentRef.id)).toMatchObject({ ok: false, error: { code: 'input_unavailable' } });
  expect(await f.store.read(scope => scope.documents.get(imported.documentRef.id)))
    .toMatchObject({ ok: true, data: { status: 'unavailable', unavailableReason: 'original_artifact_missing_or_corrupt' } });
  expect(await f.store.read(scope => scope.contents.read({ ownerKind: 'artifact', ownerId: String(imported.originalArtifactId), relativePath: 'source.md' }))).toEqual(original);
});
