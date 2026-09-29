import { copyFileSync, cpSync, mkdirSync, readFileSync, readdirSync, renameSync, symlinkSync, unlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { describe, expect, it } from 'bun:test';
import { ok } from '@flowmate/contracts';
import { createDocumentService } from '../../packages/data/src/documents.ts';
import { createEvidenceService } from '../../packages/data/src/evidence.ts';
import { parseVoxel51Sample } from '../../packages/data/src/parsed-document.ts';
import { createFileStore, openDatabase } from '@flowmate/core';
import { deferCleanup, mkdtempSync } from '../support/resources.ts';

function paths(root: string) {
  return { root, databaseFile: join(root, 'data', 'app.sqlite'), logsDir: join(root, 'logs'),
    artifactsDir: join(root, 'artifacts'), outputsDir: join(root, 'outputs'), runtimeDir: join(root, 'runtime') };
}

const onePixelPng = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/a54AAAAASUVORK5CYII=', 'base64');

function writeSample(sourceDirectory: string) {
  mkdirSync(sourceDirectory, { recursive: true });
  const content = JSON.stringify([
    { type: 'header', text: 'Header text', bbox: [0, 0, 10, 10], page_idx: 0 },
    { type: 'table', table_body: '<tr><td>20.00</td><td>20.00</td></tr>', table_caption: 'Totals', table_footnote: 'As printed',
      bbox: [1, 2, 9, 8], page_idx: 0, img_path: 'untrusted/path.jpg' },
    { type: 'image', image_caption: 'Signature image', image_footnote: 'Not verified', bbox: null, page_idx: 0,
      img_path: 'outside.png' },
    { type: 'footer', text: 'Footer text', bbox: null, page_idx: 0 },
  ]);
  const pages = JSON.stringify({ pageNumber: 1, text: 'Page text', blockCount: 4 });
  const originalName = 'original.png';
  const originalBytes = onePixelPng;
  const metadata = JSON.stringify({
    sourceRecordId: 'synthetic-1', datasetRevision: 'rev-1', parserKey: 'parse-1', qualityStatus: 'complete',
    allowedUsesClaim: ['local review'], licenseVerification: 'not_verified',
    originalSha256: 'must-not-copy', files: [
      { path: originalName, bytes: originalBytes.length, sha256: 'must-not-copy' },
      { path: 'content.json', bytes: Buffer.byteLength(content), sha256: 'must-not-copy' },
      { path: 'pages.json', bytes: Buffer.byteLength(pages), sha256: 'must-not-copy' },
      { path: 'annotation.json', bytes: 100, sha256: 'must-not-copy' },
    ],
  });
  writeFileSync(join(sourceDirectory, originalName), originalBytes);
  writeFileSync(join(sourceDirectory, 'content.json'), content);
  writeFileSync(join(sourceDirectory, 'pages.json'), pages);
  writeFileSync(join(sourceDirectory, 'metadata.json'), metadata);
  writeFileSync(join(sourceDirectory, 'annotation.json'), 'must not be imported');
}

function serviceFor(root: string) {
  const productPaths = paths(join(root, 'product'));
  const opened = openDatabase(productPaths);
  if (!opened.ok) throw new Error('test_database_open_failed');
  deferCleanup(() => opened.data.close());
  const files = createFileStore(productPaths, opened.data.documents);
  const service = createDocumentService({ paths: productPaths, repository: opened.data.documents, files,
    now: () => '2026-09-28T00:00:00.000Z' });
  return { opened: opened.data, files, service, productPaths };
}

function sample() {
  return {
    metadata: {
      sourceRecordId: 'synthetic-1', datasetRevision: 'rev-1', parserKey: 'parse-1', qualityStatus: 'complete',
      allowedUsesClaim: ['local review'], licenseVerification: 'not_verified',
      files: [
        { path: 'original.jpg', bytes: 10, sha256: 'must-not-copy' },
        { path: 'content.json', bytes: 200, sha256: 'must-not-copy' },
        { path: 'pages.json', bytes: 20, sha256: 'must-not-copy' },
      ],
    },
    content: [
      { type: 'header', text: 'Header text', bbox: [0, 0, 10, 10], page_idx: 0 },
      { type: 'table', table_body: '<tr><td>20.00</td><td>20.00</td></tr>', table_caption: 'Totals', table_footnote: 'As printed',
        bbox: [1, 2, 9, 8], page_idx: 0, img_path: 'untrusted/path.jpg' },
      { type: 'image', image_caption: 'Signature image', image_footnote: 'Not verified', bbox: null, page_idx: 0,
        img_path: 'outside.png' },
      { type: 'footer', text: 'Footer text', bbox: null, page_idx: 0 },
    ],
    pages: { pageNumber: 1, text: 'Page text', blockCount: 4 },
    originalFileName: 'original.jpg',
  };
}

describe('P3 controlled document input', () => {
  it('maps only whitelisted parser facts to stable one-based pages and source-index block IDs', () => {
    const result = parseVoxel51Sample(sample());
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.data.version).toBe('rev-1:parse-1');
    expect(result.data.sourceRecordId).toBe('synthetic-1');
    expect(result.data.parsed.pages).toEqual([{
      page: 1,
      blocks: [
        { id: 'b1', kind: 'text', text: 'Header text', sourceIndex: 0, sourceType: 'header', bbox: [0, 0, 10, 10] },
        { id: 'b2', kind: 'table', text: 'Caption: Totals\n\n<tr><td>20.00</td><td>20.00</td></tr>\n\nFootnote: As printed', sourceIndex: 1, sourceType: 'table', bbox: [1, 2, 9, 8] },
        { id: 'b3', kind: 'image', text: 'Caption: Signature image\n\nFootnote: Not verified', sourceIndex: 2, sourceType: 'image', bbox: null },
        { id: 'b4', kind: 'text', text: 'Footer text', sourceIndex: 3, sourceType: 'footer', bbox: null },
      ],
    }]);
    expect(JSON.stringify(result.data)).not.toContain('must-not-copy');
    expect(JSON.stringify(result.data)).not.toContain('untrusted/path.jpg');
    expect(JSON.stringify(result.data)).not.toContain('outside.png');
  });

  it('rejects partial, missing-page, empty, malformed, and unknown source shapes', () => {
    const base = sample();
    expect(parseVoxel51Sample({ ...base, metadata: { ...base.metadata, qualityStatus: 'partial' } }).ok).toBe(false);
    expect(parseVoxel51Sample({ ...base, pages: { ...base.pages, pageNumber: 2 } }).ok).toBe(false);
    expect(parseVoxel51Sample({ ...base, content: [] }).ok).toBe(false);
    expect(parseVoxel51Sample({ ...base, content: [{ ...base.content[0], bbox: [0, 1, 2] }] }).ok).toBe(false);
    expect(parseVoxel51Sample({ ...base, content: [{ ...base.content[0], type: 'unexpected' }] }).ok).toBe(false);
  });

  it('publishes and registers one version, serves bounded read tools, and rejects a changed same-version original', async () => {
    const root = mkdtempSync(join(tmpdir(), 'flowmate-document-import-'));
    const sourceDirectory = join(root, 'source', 'sample');
    writeSample(sourceDirectory);
    const { opened, files, service, productPaths } = serviceFor(root);
    const imported = await service.importVoxel51({ sourceDirectory });
    expect(imported).toMatchObject({ ok: true, data: { documentRef: { id: 1, version: 'rev-1:parse-1' }, pageCount: 1, status: 'available' } });
    if (!imported.ok) return;
    const context = { runId: 100, sessionId: 7, scope: { version: 2 as const, allowedTools: ['list_invoice_pages', 'read_invoice_document', 'search_invoice_document', 'list_invoice_tables'],
      allowedDocumentIds: [imported.data.documentRef.id], allowedArtifactIds: [imported.data.parsedArtifactId], allowedResourcePaths: [] } };
    expect(service.listPages({ documentId: imported.data.documentRef.id }, context)).toMatchObject({
      ok: true, data: { pageCount: 1, pages: [{ page: 1, blockCount: 4, tableCount: 1 }] },
    });
    const firstPage = service.readPage({ documentId: imported.data.documentRef.id, page: 1, afterBlockId: null, limit: 1 }, context);
    expect(firstPage).toMatchObject({ ok: true, data: { blocks: [{ id: 'b1' }], nextAfterBlockId: 'b1', completePage: false } });
    expect(service.readPageForWorkspace({ documentId: imported.data.documentRef.id, page: 1, afterBlockId: null, limit: 1 }))
      .toMatchObject({ ok: true, data: { documentRef: imported.data.documentRef, blocks: [{ id: 'b1' }] } });
    const workspaceOriginal = service.readOriginalForWorkspace(imported.data.documentRef.id, 1);
    expect(workspaceOriginal).toMatchObject({ ok: true, data: { mimeType: 'image/png', bytes: onePixelPng } });
    expect(service.readOriginalForWorkspace(imported.data.documentRef.id, 2)).toMatchObject({ ok: false, error: { code: 'input_invalid' } });
    expect(service.readPage({ documentId: imported.data.documentRef.id, page: 1, afterBlockId: 'b1', limit: 1 }, context))
      .toMatchObject({ ok: true, data: { blocks: [{ id: 'b2', kind: 'table' }], nextAfterBlockId: 'b2' } });
    expect(service.readPage({ documentId: imported.data.documentRef.id, page: 1, afterBlockId: 'b2', limit: 10 }, context))
      .toMatchObject({ ok: true, data: { blocks: [{ id: 'b3' }, { id: 'b4' }], nextAfterBlockId: null, completePage: true } });
    expect(service.search({ documentId: imported.data.documentRef.id, query: '20.00', page: null, afterBlockId: null, limit: 10 }, context))
      .toMatchObject({ ok: true, data: { matches: [{ page: 1, blockId: 'b2', excerpt: expect.stringContaining('20.00') }], complete: true } });
    expect(service.search({ documentId: imported.data.documentRef.id, query: 'totals', page: null, afterBlockId: null, limit: 10 }, context))
      .toMatchObject({ ok: true, data: { matches: [], complete: true } });
    expect(service.listTables({ documentId: imported.data.documentRef.id, page: null, afterBlockId: null, limit: 10 }, context))
      .toMatchObject({ ok: true, data: { tables: [{ blockId: 'b2', sourceType: 'table' }], complete: true } });
    expect(service.search({ documentId: imported.data.documentRef.id, query: '20.00', page: null, afterBlockId: null, limit: 10 }, context))
      .toMatchObject({ ok: true, data: { matches: [{ blockId: 'b2' }] } });
    expect(service.listPages({ documentId: imported.data.documentRef.id }, { ...context, scope: { ...context.scope, allowedDocumentIds: [] } }))
      .toMatchObject({ ok: false, error: { code: 'tool_access_denied' } });
    const evidence = createEvidenceService({ documents: service, repository: opened.documents, files,
      now: () => '2026-09-28T00:00:00.000Z', originalWasDelivered: () => ok(false) });
    const execution = { ...context, scope: { ...context.scope,
      allowedTools: [...context.scope.allowedTools, 'read_invoice_evidence', 'check_invoice_sources'],
      allowedArtifactIds: [imported.data.parsedArtifactId, imported.data.originalArtifactId] },
      nativeToolCallId: 'native-call-evidence', signal: new AbortController().signal };
    const parsedEvidence = evidence.read({ documentId: imported.data.documentRef.id, page: 1, kind: 'parsed', blockId: 'b2' }, execution);
    expect(parsedEvidence).toMatchObject({ ok: true, data: { kind: 'parsed', text: expect.stringContaining('20.00') } });
    if (!parsedEvidence.ok || parsedEvidence.data.kind !== 'parsed') return;
    const validSource = { ...parsedEvidence.data.source, quote: '20.00' };
    const falseSource = { ...validSource, quote: 'not on this page' };
    expect(evidence.checkSources({ documentId: imported.data.documentRef.id, sources: [validSource, falseSource] }, execution))
      .toMatchObject({ ok: true, data: { results: [
        { index: 0, status: 'valid', code: 'parsed_quote_matched' },
        { index: 1, status: 'invalid', code: 'quote_mismatch' },
      ] } });
    const originalEvidence = evidence.read({ documentId: imported.data.documentRef.id, page: 1, kind: 'original', blockId: null }, execution);
    expect(originalEvidence).toMatchObject({ ok: true, data: { kind: 'original', bytes: onePixelPng.length, mimeType: 'image/png' } });
    if (!originalEvidence.ok || originalEvidence.data.kind !== 'original') return;
    expect(evidence.checkSources({ documentId: imported.data.documentRef.id, sources: [originalEvidence.data.source] }, execution))
      .toMatchObject({ ok: true, data: { results: [{ status: 'invalid', code: 'original_not_delivered' }] } });
    const observedEvidence = createEvidenceService({ documents: service, repository: opened.documents, files,
      now: () => '2026-09-28T00:00:00.000Z', originalWasDelivered: () => ok(true) });
    expect(observedEvidence.checkSources({ documentId: imported.data.documentRef.id, sources: [originalEvidence.data.source] }, execution))
      .toMatchObject({ ok: true, data: { results: [{ status: 'unverified', code: 'visual_truth_unverified' }] } });
    const quotedOriginal = { ...originalEvidence.data.source, quote: 'INV-123' };
    expect(observedEvidence.checkSources({ documentId: imported.data.documentRef.id, sources: [quotedOriginal] }, execution))
      .toMatchObject({ ok: true, data: { results: [{ status: 'unverified', code: 'visual_truth_unverified' }] } });
    const delivered = evidence.readForDelivery(originalEvidence.data.source, execution);
    expect(delivered).toMatchObject({ ok: true, data: { mimeType: 'image/png' } });
    if (delivered.ok) expect(Buffer.compare(Buffer.from(delivered.data.bytes), onePixelPng)).toBe(0);
    const parsedArtifact = opened.documents.getArtifact(imported.data.parsedArtifactId);
    expect(parsedArtifact.ok).toBe(true);
    if (!parsedArtifact.ok) return;
    expect(files.read(parsedArtifact.data, 'source.json').ok).toBe(true);
    expect(files.read(parsedArtifact.data, 'raw-content.json').ok).toBe(true);
    expect(opened.db.query('SELECT COUNT(*) AS count FROM artifacts').get()).toEqual({ count: 2 });
    expect(opened.db.query('SELECT COUNT(*) AS count FROM business_events WHERE type=\'document_imported\'').get()).toEqual({ count: 1 });
    expect(await service.importVoxel51({ sourceDirectory })).toMatchObject({ ok: true, data: { documentRef: { id: imported.data.documentRef.id } } });
    expect(opened.db.query('SELECT COUNT(*) AS count FROM business_events WHERE type=\'document_imported\'').get()).toEqual({ count: 1 });
    const contentPath = join(sourceDirectory, 'content.json');
    const originalContent = readFileSync(contentPath);
    writeFileSync(contentPath, originalContent.toString('utf8').replace('untrusted/path.jpg', 'different/path.jpg'));
    expect(await service.importVoxel51({ sourceDirectory })).toMatchObject({ ok: false, error: { code: 'document_version_conflict' } });
    writeFileSync(contentPath, originalContent);
    const changed = Buffer.from(onePixelPng);
    changed[25] ^= 1;
    writeFileSync(join(sourceDirectory, 'original.png'), changed);
    const conflict = await service.importVoxel51({ sourceDirectory });
    expect(conflict).toMatchObject({ ok: false, error: { code: 'document_version_conflict' } });
    expect(opened.db.query('SELECT COUNT(*) AS count FROM documents').get()).toEqual({ count: 1 });
    expect(productPaths.artifactsDir).toContain('artifacts');
  });

  it('keeps complete published files as an orphan after a failed registration and reuses the verified orphan', async () => {
    const root = mkdtempSync(join(tmpdir(), 'flowmate-document-orphan-'));
    const sourceDirectory = join(root, 'source', 'sample');
    writeSample(sourceDirectory);
    const { opened, service, productPaths } = serviceFor(root);
    opened.db.exec(`CREATE TRIGGER fail_document_activity BEFORE INSERT ON business_events WHEN NEW.type='document_imported'
      BEGIN SELECT RAISE(ABORT,'fixture failure'); END;`);
    expect(await service.importVoxel51({ sourceDirectory })).toMatchObject({ ok: false, error: { code: 'storage_write_failed' } });
    expect(opened.db.query('SELECT COUNT(*) AS count FROM artifacts').get()).toEqual({ count: 0 });
    expect(opened.db.query('SELECT COUNT(*) AS count FROM documents').get()).toEqual({ count: 0 });
    expect(opened.db.query('SELECT COUNT(*) AS count FROM business_events').get()).toEqual({ count: 0 });
    const orphanIds = readdirSync(productPaths.artifactsDir).filter((name) => /^[1-9]\d*$/.test(name)).sort();
    expect(orphanIds).toEqual(['1', '2']);
    const originalPath = join(sourceDirectory, 'original.png');
    const changedOriginal = Buffer.from(onePixelPng);
    changedOriginal[25] ^= 1;
    writeFileSync(originalPath, changedOriginal);
    expect(await service.importVoxel51({ sourceDirectory })).toMatchObject({ ok: false, error: { code: 'document_version_conflict' } });
    expect(opened.db.query('SELECT COUNT(*) AS count FROM documents').get()).toEqual({ count: 0 });
    writeFileSync(originalPath, onePixelPng);
    opened.db.exec('DROP TRIGGER fail_document_activity;');
    const retried = await service.importVoxel51({ sourceDirectory });
    expect(retried).toMatchObject({ ok: true, data: { documentRef: { id: 1 }, originalArtifactId: 1, parsedArtifactId: 2 } });
    expect(opened.db.query('SELECT COUNT(*) AS count FROM business_events WHERE type=\'document_imported\'').get()).toEqual({ count: 1 });
    expect(readdirSync(productPaths.artifactsDir).filter((name) => /^[1-9]\d*$/.test(name)).sort()).toEqual(['1', '2']);
  });

  it('marks missing parsed files unavailable and restores only after the complete stored pair validates', async () => {
    const root = mkdtempSync(join(tmpdir(), 'flowmate-document-restore-'));
    const sourceDirectory = join(root, 'source', 'sample');
    writeSample(sourceDirectory);
    const { opened, service } = serviceFor(root);
    const imported = await service.importVoxel51({ sourceDirectory });
    expect(imported.ok).toBe(true);
    if (!imported.ok) return;
    const context = { runId: 100, sessionId: 7, scope: { version: 2 as const, allowedTools: ['list_invoice_pages'],
      allowedDocumentIds: [imported.data.documentRef.id], allowedArtifactIds: [imported.data.parsedArtifactId], allowedResourcePaths: [] } };
    const artifact = opened.documents.getArtifact(imported.data.parsedArtifactId);
    expect(artifact.ok).toBe(true);
    if (!artifact.ok) return;
    const parsedPath = join(root, 'product', artifact.data.relativePath);
    const backupPath = join(root, 'parsed-backup.json');
    copyFileSync(parsedPath, backupPath);
    unlinkSync(parsedPath);
    expect(service.listPages({ documentId: imported.data.documentRef.id }, context))
      .toMatchObject({ ok: false, error: { code: 'input_unavailable' } });
    expect(opened.documents.get(imported.data.documentRef.id)).toMatchObject({ ok: true, data: { status: 'unavailable' } });
    copyFileSync(backupPath, parsedPath);
    expect(service.restoreDocument(imported.data.documentRef.id)).toMatchObject({ ok: true, data: { status: 'available' } });
    expect(service.listPages({ documentId: imported.data.documentRef.id }, context)).toMatchObject({ ok: true });
  });

  it('rejects an artifact tree redirected outside the product root', async () => {
    const root = mkdtempSync(join(tmpdir(), 'flowmate-artifact-root-link-'));
    const sourceDirectory = join(root, 'source', 'sample');
    writeSample(sourceDirectory);
    const { opened, files, service, productPaths } = serviceFor(root);
    const imported = await service.importVoxel51({ sourceDirectory });
    expect(imported.ok).toBe(true);
    if (!imported.ok) return;
    const original = opened.documents.getArtifact(imported.data.originalArtifactId);
    expect(original.ok).toBe(true);
    if (!original.ok) return;
    const backup = join(root, 'artifact-backup');
    const foreign = join(root, 'foreign-artifacts');
    cpSync(productPaths.artifactsDir, foreign, { recursive: true });
    renameSync(productPaths.artifactsDir, backup);
    symlinkSync(foreign, productPaths.artifactsDir, 'junction');
    try {
      expect(files.read(original.data, 'original.png'))
        .toMatchObject({ ok: false, error: { code: 'artifact_unavailable' } });
    } finally {
      unlinkSync(productPaths.artifactsDir);
      renameSync(backup, productPaths.artifactsDir);
    }
  });

  it('rejects product-managed input roots and keeps the model image cap below local storage limits', async () => {
    const root = mkdtempSync(join(tmpdir(), 'flowmate-document-boundaries-'));
    const { opened, files, service, productPaths } = serviceFor(root);
    const productSource = join(productPaths.root, 'source', 'sample');
    writeSample(productSource);
    expect(await service.importVoxel51({ sourceDirectory: productSource }))
      .toMatchObject({ ok: false, error: { code: 'source_invalid' } });

    const sourceDirectory = join(root, 'external-source', 'sample');
    writeSample(sourceDirectory);
    const largeOriginal = Buffer.alloc(2 * 1024 * 1024 + 1);
    onePixelPng.copy(largeOriginal);
    writeFileSync(join(sourceDirectory, 'original.png'), largeOriginal);
    const metadataPath = join(sourceDirectory, 'metadata.json');
    const metadata = JSON.parse(readFileSync(metadataPath, 'utf8')) as { files: Array<{ path: string; bytes: number }> };
    metadata.files.find((file) => file.path === 'original.png')!.bytes = largeOriginal.byteLength;
    writeFileSync(metadataPath, JSON.stringify(metadata));
    const imported = await service.importVoxel51({ sourceDirectory });
    expect(imported.ok).toBe(true);
    if (!imported.ok) return;
    const context = { runId: 101, sessionId: 8, nativeToolCallId: 'oversized-image', signal: new AbortController().signal,
      scope: { version: 2 as const, allowedTools: ['read_invoice_evidence'], allowedDocumentIds: [imported.data.documentRef.id],
        allowedArtifactIds: [imported.data.originalArtifactId], allowedResourcePaths: [] } };
    const evidence = createEvidenceService({ documents: service, repository: opened.documents, files,
      now: () => '2026-09-28T00:00:00.000Z' });
    expect(evidence.read({ documentId: imported.data.documentRef.id, page: 1, kind: 'original', blockId: null }, context))
      .toMatchObject({ ok: false, error: { code: 'tool_result_too_large' } });
    const artifact = opened.documents.getArtifact(imported.data.originalArtifactId);
    expect(artifact.ok).toBe(true);
    if (artifact.ok) expect(files.read(artifact.data, 'original.png')).toMatchObject({ ok: true });
  });
});
