import { mkdtempSync, deferCleanup } from '../../support/resources.ts';

import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it, mock } from 'bun:test';
import { createApplication } from '../../../apps/composition.ts';
import type { ProviderPort } from '../../../packages/contracts/src/ports.ts';
import { createFileStore } from '@flowmate/core';
import { openTestDatabase as openDatabase } from '../../support/database.ts';
import { Database } from 'bun:sqlite';

function paths(root: string) {
  return { root, databaseFile: join(root, 'data', 'trial.sqlite'), logsDir: join(root, 'logs'), artifactsDir: join(root, 'artifacts'), outputsDir: join(root, 'outputs'), runtimeDir: join(root, 'runtime') };
}

describe('P1 application composition', () => {
  it('opens the injected ProductPaths and closes database/logger resources', async () => {
    const provider: ProviderPort = {
      prepare: async () => ({ ok: false as const, error: { code: 'provider_auth_failed', category: 'provider' as const, message: '认证失败。', retryable: false } }),
      close: async () => ({ stopped: true, closed: true, errors: [] }),
    };
    const root = mkdtempSync(join(tmpdir(), 'flowmate-composition-'));
    const result = await createApplication({ paths: paths(root), provider, logger: { write: () => undefined, close: async () => undefined } });

    if (result.ok) deferCleanup(() => result.data.close());
    expect(result.ok).toBe(true);
    if (result.ok) await expect(result.data.close()).resolves.toEqual({ ok: true, data: { stopped: true, closed: true, errors: [] } });
  });

  it('reports logger close failures and still closes the database exactly once', async () => {
    const root = mkdtempSync(join(tmpdir(), 'flowmate-composition-close-failure-'));
    const closeLogger = mock(async () => {
      if (closeLogger.mock.calls.length === 1) throw new Error('synthetic private log path');
    });
    const provider: ProviderPort = { prepare: async () => ({ ok: false as const, error: { code: 'unused', category: 'provider' as const, message: 'unused', retryable: false } }), close: async () => ({ stopped: true, closed: true, errors: [] }) };
    const result = await createApplication({ paths: paths(root), provider, logger: { write: () => undefined, close: closeLogger } });
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    const first = await result.data.close();
    const second = await result.data.close();

    expect(first).toMatchObject({ ok: true, data: { stopped: true, closed: false, errors: [{ code: 'logger_close_failed' }] } });
    expect(second).toMatchObject({ ok: true, data: { stopped: true, closed: true, errors: [{ code: 'logger_close_failed' }] } });
    expect(JSON.stringify(first)).not.toContain('synthetic private log path');
    expect(closeLogger).toHaveBeenCalledTimes(2);
    const reopened = await createApplication({ paths: paths(root), provider, logger: { write: () => undefined, close: async () => undefined } });
    expect(reopened.ok).toBe(true);
    if (reopened.ok) await reopened.data.close();
  });
});

it('lists sparse real Workspace page identities through the public application without model requests', async () => {
  const root = mkdtempSync(join(tmpdir(), 'flowmate-workspace-page-index-'));
  const productPaths = paths(root);
  const seeded = openDatabase(productPaths);
  if (!seeded.ok) throw new Error(seeded.error.code);
  const store = seeded.data;
  deferCleanup(() => store.close());
  const files = createFileStore(productPaths, store);
  const at = '2026-10-03T00:00:00.000Z';
  const original = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Y9Zl1sAAAAASUVORK5CYII=', 'base64');
  const parsed = Buffer.from(JSON.stringify({ formatVersion: 1, parser: { key: 'legacy-parser' },
    pages: [2, 5].map(page => ({ page, blocks: [{ id: `b${page}`, kind: 'text', text: 'Synthetic source',
      sourceIndex: 0, sourceType: 'text', bbox: null }] })),
    completeness: { status: 'complete', checks: ['legacy'], warnings: [] } }));
  const published = await files.publish({ sourceKey: 'synthetic', sourceRecordId: 'sparse-pages', sourceVersion: 'legacy-sparse-v1', at,
    original: { kind: 'original', primaryName: 'original.png', files: [{ name: 'original.png', bytes: original, mimeType: 'image/png' }] },
    parsed: { kind: 'parsed', primaryName: 'parsed.json', files: [{ name: 'parsed.json', bytes: parsed, mimeType: 'application/json' }] } });
  if (!published.ok) throw new Error(published.error.code);
  const registered = store.documents.register({ documentId: published.data.documentId, sourceKey: 'synthetic', sourceRecordId: 'sparse-pages',
    version: 'legacy-sparse-v1', originalArtifact: { ...published.data.original, kind: 'original' },
    parsedArtifact: { ...published.data.parsed, kind: 'parsed' }, status: 'available',
    metadata: { version: 2, pageCount: 2, warnings: [], allowedUsesClaim: ['synthetic review'],
      licenseVerification: 'not_verified', unavailableReason: null }, createdAt: at, updatedAt: at });
  if (!registered.ok) throw new Error(registered.error.code);
  const before = { runs: store.db.query('SELECT * FROM runs').all(), inputs: store.db.query('SELECT * FROM session_inputs').all(),
    documents: store.db.query('SELECT * FROM documents').all() };
  await store.close();
  let requests = 0;
  const provider: ProviderPort = { prepare: async () => { requests += 1; return { ok: false,
    error: { code: 'unexpected_request', category: 'provider', message: 'Unexpected request.', retryable: false } }; },
    close: async () => ({ stopped: true, closed: true, errors: [] }) };
  const created = await createApplication({ paths: productPaths, provider, logger: { write: () => undefined, close: async () => undefined } });
  if (!created.ok) throw new Error(created.error.code);
  deferCleanup(() => created.data.close());
  expect(typeof created.data.listDocumentPages).toBe('function');
  const index = await created.data.listDocumentPages({ documentId: registered.data.documentRef.id });
  expect(index).toEqual({ ok: true, data: { documentRef: registered.data.documentRef, parsedArtifactId: registered.data.parsedArtifactId,
    pageCount: 2, pages: [{ page: 2, blockCount: 1, tableCount: 0 }, { page: 5, blockCount: 1, tableCount: 0 }] } });
  expect(await created.data.readDocumentPage({ documentId: registered.data.documentRef.id, page: 5, afterBlockId: null, limit: 1 }))
    .toMatchObject({ ok: true, data: { page: 5, blocks: [{ id: 'b5' }] } });
  expect(await created.data.readDocumentPage({ documentId: registered.data.documentRef.id, page: 1, afterBlockId: null, limit: 1 }))
    .toMatchObject({ ok: false, error: { code: 'tool_invalid_input' } });
  expect(requests).toBe(0);
  await created.data.close();
  const audit = new Database(productPaths.databaseFile, { readonly: true });
  deferCleanup(() => audit.close());
  expect({ runs: audit.query('SELECT * FROM runs').all(), inputs: audit.query('SELECT * FROM session_inputs').all(),
    documents: audit.query('SELECT * FROM documents').all() }).toEqual(before);
});
