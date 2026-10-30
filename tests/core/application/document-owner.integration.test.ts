import { expect, spyOn, test } from 'bun:test';
import { InMemoryCredentialStore } from '@earendil-works/pi-ai';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import * as bootstrap from '../../../packages/core/src/storage/bootstrap.ts';
import { appError, fail } from '@flowmate/contracts';
import type { PreparedInvoiceMaterial, Result } from '@flowmate/contracts';
import { testDatabase, type TestDbHandle } from '../../support/database.ts';
import { createApplication } from '../../../apps/composition.ts';
import { PiAgentAdapter } from '../../../packages/runtime-pi/src/session.ts';
import { deferCleanup, mkdtempSync } from '../../support/resources.ts';

function need<T>(value: Result<T>): T { if (!value.ok) throw Error(value.error.code); return value.data; }
const tick = () => new Promise<void>(resolve => setImmediate(resolve));
function prepared(): PreparedInvoiceMaterial {
  const sourceText = 'Formal invoice total 1.00';
  return { contract: 'flowmate-prepared-invoice/v1', sample: 'formal-document-owner',
    original: { name: 'source.md', base64: Buffer.from(sourceText).toString('base64') }, sourceText,
    pages: [{ page: 1, blocks: [{ id: 'b1', kind: 'text', text: sourceText, sourceIndex: 0, sourceType: 'prepared-text', bbox: null }] }] };
}

async function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'flowmate-formal-document-owner-'));
  const paths = { root, databaseFile: join(root, 'data/app.sqlite'), artifactsDir: join(root, 'artifacts'),
    runtimeDir: join(root, 'runtime'), logsDir: join(root, 'logs'), outputsDir: join(root, 'outputs') };
  let models = 0, database: TestDbHandle | undefined;
  const agent = new PiAgentAdapter({ cwd: paths.runtimeDir, agentDir: paths.runtimeDir,
    credentials: new InMemoryCredentialStore(), runtimeApiKey: 'synthetic-document-owner' });
  agent.prepare = async () => { models++; throw Error('Document work must not start models.'); };
  const original = bootstrap.bootstrapDatabase;
  const opening = spyOn(bootstrap, 'bootstrapDatabase').mockImplementation(input => {
    const value = original(input); if (value.ok) database = testDatabase(value.data); return value;
  });
  let app;
  try { app = need(await createApplication({ paths, agent, provider: {
    async prepare() { models++; throw Error('Document work must not start Providers.'); },
    async close() { return { stopped: true, closed: true, errors: [] }; },
  }, logger: { write() {}, async close() {} } })); }
  finally { opening.mockRestore(); }
  deferCleanup(() => app.close());
  if (!database) throw Error('The formal application database owner was not captured.');
  return { app, database, paths, models: () => models };
}

test('formal invoice import waits for its current owner and registration COMMIT', async () => {
  const f = await fixture(), entered = Promise.withResolvers<void>(), release = Promise.withResolvers<void>();
  const transaction = f.database.transaction;
  const holding = transaction(async () => { entered.resolve(); await release.promise; });
  await entered.promise;
  const commitRelease = Promise.withResolvers<void>();
  let registered = false, settled = false;
  f.database.transaction = operation => transaction(async scope => {
    const register = scope.documents.register; let writing = false;
    scope.documents.register = input => { writing = true; return register(input); };
    const result = await operation(scope);
    if (writing) { registered = true; await commitRelease.promise; }
    return result;
  });
  const importing = f.app.importPreparedInvoiceMaterial(prepared()).then(value => { settled = true; return value; });
  try {
    await tick(); expect(settled).toBe(false);
    release.resolve(); await holding; await tick();
    expect(registered).toBe(true); expect(settled).toBe(false);
    commitRelease.resolve();
    expect(await importing).toMatchObject({ ok: true, data: { status: 'available', pageCount: 1 } });
    expect(f.models()).toBe(0);
  } finally { release.resolve(); commitRelease.resolve(); await holding; await importing; }
});

test('formal Document metadata and page reads wait for the current owner without using root aliases', async () => {
  const f = await fixture(), document = need(await f.app.importPreparedInvoiceMaterial(prepared()));
  const expired = () => fail(appError('storage_read_failed', 'storage', 'Expired root Document alias'));
  f.database.documents.list = expired; f.database.documents.get = expired; f.database.documents.getArtifact = expired;
  f.database.documents.contents!.read = () => { throw Error('Expired root Document contents'); };
  const entered = Promise.withResolvers<void>(), release = Promise.withResolvers<void>();
  const holding = f.database.transaction(async () => { entered.resolve(); await release.promise; });
  await entered.promise;
  let settled = 0;
  const id = document.documentRef.id, page = { limit: 1 };
  const reading = Promise.all([f.app.listDocuments(page), f.app.queryDocument(id),
    f.app.listDocumentPages({ documentId: id }),
    f.app.readDocumentPage({ documentId: id, page: 1, afterBlockId: null, limit: 10 }),
    f.app.readDocumentOriginal(id, 1)].map(pending => pending.then(value => { settled++; return value; })));
  page.limit = 1000;
  try {
    await tick(); expect(settled).toBe(0);
    release.resolve(); await holding;
    const results = await reading;
    expect(results[0]).toEqual({ ok: true, data: { items: [document], nextBeforeId: null } });
    expect(results[1]).toEqual({ ok: true, data: document });
    expect(results[2]).toMatchObject({ ok: true, data: { pageCount: 1, pages: [{ page: 1, blockCount: 1 }] } });
    expect(results[3]).toMatchObject({ ok: true, data: { blocks: [{ id: 'b1', text: 'Formal invoice total 1.00' }] } });
    expect(results[4]).toMatchObject({ ok: false, error: { code: 'input_unavailable' } });
    expect(f.models()).toBe(0);
  } finally { release.resolve(); await holding; await reading; }
});

test('formal Document hiding waits for its actual owner COMMIT', async () => {
  const f = await fixture(), document = need(await f.app.importPreparedInvoiceMaterial(prepared()));
  const transaction = f.database.transaction, release = Promise.withResolvers<void>();
  let paused = false, settled = false;
  f.database.transaction = operation => transaction(async scope => {
    let hiding = false; const hide = scope.documents.hide;
    scope.documents.hide = (...input) => { hiding = true; return hide(...input); };
    const result = await operation(scope);
    if (hiding) { paused = true; await release.promise; }
    return result;
  });
  const hiding = f.app.hideDocument(document.documentRef.id).then(value => { settled = true; return value; });
  try {
    await tick(); expect(paused).toBe(true); expect(settled).toBe(false);
    release.resolve(); expect(await hiding).toMatchObject({ ok: true, data: { documentId: document.documentRef.id } });
    expect(await f.app.queryDocument(document.documentRef.id)).toMatchObject({ ok: true, data: { isHidden: true } });
    expect(f.models()).toBe(0);
  } finally { release.resolve(); await hiding; }
});
