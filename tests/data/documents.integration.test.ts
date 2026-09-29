import { copyFileSync, cpSync, mkdirSync, readFileSync, readdirSync, renameSync, symlinkSync, unlinkSync, writeFileSync } from 'node:fs';
import { basename, join } from 'node:path';
import { tmpdir } from 'node:os';
import { describe, expect, it } from 'bun:test';
import { ok } from '@flowmate/contracts';
import { createDocumentService } from '../../packages/data/src/documents.ts';
import { readInvoiceEvidence } from '../../packages/employee-invoice/src/tools/read_invoice_evidence.ts';
import { checkInvoiceSourcesResult } from '../../packages/employee-invoice/src/tools/check_invoice_sources.ts';
import { listInvoicePages } from '../../packages/employee-invoice/src/tools/list_invoice_pages.ts';
import { readInvoiceDocument, projectInvoiceDocumentPage } from '../../packages/employee-invoice/src/tools/read_invoice_document.ts';
import { searchInvoiceDocument } from '../../packages/employee-invoice/src/tools/search_invoice_document.ts';
import { listInvoiceTables } from '../../packages/employee-invoice/src/tools/list_invoice_tables.ts';
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
  const pages = JSON.stringify([{ pageNumber: 1, text: 'Page text', blockCount: 4 }]);
  const originalName = 'original.png';
  const originalBytes = onePixelPng;
  const metadata = JSON.stringify({
    schemaVersion: 1, sampleId: basename(sourceDirectory), datasetId: 'voxel51-hq-invoice-ocr',
    sourceRecordId: 'synthetic-1', datasetRevision: 'rev-1', qualityStatus: 'complete',
    allowedUsesClaim: ['local review'], licenseVerification: 'not_verified',
    files: [
      { path: originalName, bytes: originalBytes.length },
      { path: 'content.json', bytes: Buffer.byteLength(content) },
      { path: 'pages.json', bytes: Buffer.byteLength(pages) },
    ],
  });
  writeFileSync(join(sourceDirectory, originalName), originalBytes);
  writeFileSync(join(sourceDirectory, 'content.json'), content);
  writeFileSync(join(sourceDirectory, 'pages.json'), pages);
  writeFileSync(join(sourceDirectory, 'metadata.json'), metadata);
}

function serviceFor(root: string, allowedSourceRoot = join(root, 'source')) {
  const productPaths = paths(join(root, 'product'));
  const opened = openDatabase(productPaths);
  if (!opened.ok) throw new Error('test_database_open_failed');
  deferCleanup(() => opened.data.close());
  const files = createFileStore(productPaths, opened.data.documents);
  const service = createDocumentService({ paths: productPaths, repository: opened.data.documents, files,
    allowedSourceRoot, now: () => '2026-09-28T00:00:00.000Z' });
  return { opened: opened.data, files, service, productPaths };
}

function sample() {
  return {
    metadata: {
      sampleId: '000001', sourceRecordId: 'synthetic-1', datasetRevision: 'rev-1', parserKey: 'mineru@3.4.5;model=pipeline', qualityStatus: 'complete',
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
    pages: [{ pageNumber: 1, text: 'Page text', blockCount: 4 }],
    originalFileName: 'original.jpg',
  };
}

describe('P3 controlled document input', () => {
  it('imports parser-free formal input and versions changes to formal bytes', async () => {
    const root = mkdtempSync(join(tmpdir(), 'flowmate-parser-free-'));
    const sourceDirectory = join(root, 'source', '000001');
    writeSample(sourceDirectory);
    const metadataPath = join(sourceDirectory, 'metadata.json');
    const metadata = JSON.parse(readFileSync(metadataPath, 'utf8')) as Record<string, unknown>;
    expect(metadata).not.toHaveProperty('parserKey');
    writeFileSync(metadataPath, JSON.stringify(metadata));
    const { opened, files, service } = serviceFor(root);
    const imported = await service.importVoxel51({ sourceDirectory });
    expect(imported.ok).toBe(true);
    if (!imported.ok) return;
    expect(imported.data.documentRef.version).toMatch(/^rev-1:parsed-v3:[a-f0-9]{64}$/);
    expect(imported.data.displayName).toBe('Invoice 000001');
    expect(imported.data).not.toHaveProperty('parser');
    const artifact = opened.documents.getArtifact(imported.data.parsedArtifactId);
    expect(artifact.ok).toBe(true);
    if (!artifact.ok) return;
    for (const name of ['parsed.json', 'source.json']) {
      const bytes = files.read(artifact.data, name);
      expect(bytes.ok).toBe(true);
      if (bytes.ok) expect(JSON.parse(Buffer.from(bytes.data).toString('utf8'))).not.toHaveProperty('parserKey');
    }
    metadata.qualityStatus = 'reviewed';
    writeFileSync(metadataPath, JSON.stringify(metadata));
    const changed = await service.importVoxel51({ sourceDirectory });
    expect(changed.ok).toBe(true);
    if (changed.ok) expect(changed.data.documentRef.version).not.toBe(imported.data.documentRef.version);
  });
  it('maps existing parsed content to stable one-based pages and source-index block IDs', () => {
    const result = parseVoxel51Sample(sample());
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.data.parsed.formatVersion).toBe(2);
    expect(JSON.stringify(result.data)).not.toContain('parserKey');
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

  it('maps page arrays and ordered caption arrays without projecting external parser metadata', () => {
    const base = sample();
    const parserKey = 'mineru@3.4.5;model=pipeline;table=true';
    const input = {
      ...base,
      metadata: { ...base.metadata, parserKey },
      pages: base.pages,
      content: [
        base.content[0],
        { ...base.content[1], table_caption: ['Totals', 'As reported'], table_footnote: ['Tax included', 'Printed summary'] },
        { ...base.content[2], image_caption: ['Signature', 'Seller mark'], image_footnote: ['Visual only', 'Not verified'] },
        base.content[3],
      ],
    };

    const result = parseVoxel51Sample(input);

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.data.parsed.formatVersion).toBe(2);
    expect(JSON.stringify(result.data)).not.toContain(parserKey);
    expect(result.data.parsed.pages[0]?.blocks[1]?.text).toBe(
      'Caption: Totals\n\nCaption: As reported\n\n<tr><td>20.00</td><td>20.00</td></tr>\n\nFootnote: Tax included\n\nFootnote: Printed summary',
    );
    expect(result.data.parsed.pages[0]?.blocks[2]?.text).toBe(
      'Caption: Signature\n\nCaption: Seller mark\n\nFootnote: Visual only\n\nFootnote: Not verified',
    );
  });

  it('rejects partial, missing-page, empty, malformed, and unknown source shapes', () => {
    const base = sample();
    expect(parseVoxel51Sample({ ...base, metadata: { ...base.metadata, qualityStatus: 'partial' } }).ok).toBe(false);
    expect(parseVoxel51Sample({ ...base, pages: [{ ...base.pages[0], pageNumber: 2 }] }).ok).toBe(false);
    expect(parseVoxel51Sample({ ...base, content: [] }).ok).toBe(false);
    expect(parseVoxel51Sample({ ...base, content: [{ ...base.content[0], bbox: [0, 1, 2] }] }).ok).toBe(false);
    expect(parseVoxel51Sample({ ...base, content: [{ ...base.content[0], type: 'unexpected' }] }).ok).toBe(false);
  });

  it('rejects invalid page arrays, malformed captions, and overlong dataset revisions', () => {
    const base = sample();
    expect(parseVoxel51Sample({ ...base, pages: [] }).ok).toBe(false);
    expect(parseVoxel51Sample({ ...base, pages: [base.pages[0], base.pages[0]] }).ok).toBe(false);
    expect(parseVoxel51Sample({ ...base, pages: [{ ...base.pages[0], blockCount: 3 }] }).ok).toBe(false);
    expect(parseVoxel51Sample({ ...base, content: [base.content[0], { ...base.content[1], table_caption: ['valid', 7] }, ...base.content.slice(2)] }).ok).toBe(false);
    expect(parseVoxel51Sample({ ...base, metadata: { ...base.metadata, parserKey: 'other@3.4.5;model=pipeline' } }).ok).toBe(true);
    expect(parseVoxel51Sample({ ...base, metadata: { ...base.metadata, datasetRevision: 'r'.repeat(257) } }).ok).toBe(false);
  });

  it('accepts only a direct four-file sample in the injected root with no archive fallback', async () => {
    const root = mkdtempSync(join(tmpdir(), 'flowmate-source-root-'));
    const allowedRoot = join(root, 'agent-input');
    const allowedSample = join(allowedRoot, '000001');
    writeSample(allowedSample);
    const { service } = serviceFor(root, allowedRoot);

    expect(await service.importVoxel51({ sourceDirectory: allowedSample })).toMatchObject({ ok: true });
    const archivedSample = join(root, 'voxel51', '000002');
    writeSample(archivedSample);
    expect(await service.importVoxel51({ sourceDirectory: archivedSample })).toMatchObject({
      ok: false, error: { code: 'source_invalid' },
    });
    writeFileSync(join(allowedSample, 'extra.json'), '{}');
    expect(await service.importVoxel51({ sourceDirectory: allowedSample })).toMatchObject({
      ok: false, error: { code: 'source_invalid' },
    });
    expect(await service.importVoxel51({ sourceDirectory: join(allowedSample, 'nested') })).toMatchObject({
      ok: false, error: { code: 'source_invalid' },
    });
    symlinkSync(allowedSample, join(allowedRoot, '000005'), 'junction');
    expect(await service.importVoxel51({ sourceDirectory: join(allowedRoot, '000005') })).toMatchObject({
      ok: false, error: { code: 'source_invalid' },
    });
    const missingRoot = join(root, 'missing-root');
    const missingRootService = serviceFor(join(root, 'missing-root-product'), missingRoot).service;
    expect(await missingRootService.importVoxel51({ sourceDirectory: archivedSample })).toMatchObject({
      ok: false, error: { code: 'input_unavailable' },
    });
  });

  it('publishes versions from changed formal bytes and serves bounded read tools', async () => {
    const root = mkdtempSync(join(tmpdir(), 'flowmate-document-import-'));
    const sourceDirectory = join(root, 'source', '000001');
    writeSample(sourceDirectory);
    const { opened, files, service, productPaths } = serviceFor(root);
    const imported = await service.importVoxel51({ sourceDirectory });
    expect(imported).toMatchObject({ ok: true, data: { documentRef: { id: 1, version: expect.stringMatching(/^rev-1:parsed-v3:[a-f0-9]{64}$/) }, pageCount: 1, status: 'available' } });
    if (!imported.ok) return;
    const context = { runId: 100, sessionId: 7, scope: { version: 2 as const, allowedTools: ['list_invoice_pages', 'read_invoice_document', 'search_invoice_document', 'list_invoice_tables'],
      allowedDocumentIds: [imported.data.documentRef.id], allowedArtifactIds: [imported.data.parsedArtifactId], allowedResourcePaths: [] } };
    const call = { nativeToolCallId: 'read-document', signal: new AbortController().signal };
    const listPages = listInvoicePages(service);
    const readPage = readInvoiceDocument(service);
    const search = searchInvoiceDocument(service);
    const listTables = listInvoiceTables(service);
    expect(await listPages.execute({ documentId: imported.data.documentRef.id }, call, context)).toMatchObject({
      pageCount: 1, pages: [{ page: 1, blockCount: 4, tableCount: 1 }],
    });
    const firstPage = await readPage.execute({ documentId: imported.data.documentRef.id, page: 1, afterBlockId: null, limit: 1 }, call, context);
    expect(firstPage).toMatchObject({ blocks: [{ id: 'b1' }], nextAfterBlockId: 'b1', completePage: false });
    const workspaceParsed = service.readParsedForWorkspace(imported.data.documentRef.id);
    expect(workspaceParsed.ok).toBe(true);
    if (!workspaceParsed.ok) return;
    expect(projectInvoiceDocumentPage({ documentId: imported.data.documentRef.id, page: 1, afterBlockId: null, limit: 1 }, workspaceParsed.data))
      .toMatchObject({ ok: true, data: { documentRef: imported.data.documentRef, blocks: [{ id: 'b1' }] } });
    const workspaceOriginal = service.readOriginalForWorkspace(imported.data.documentRef.id, 1);
    expect(workspaceOriginal).toMatchObject({ ok: true, data: { mimeType: 'image/png', bytes: onePixelPng } });
    expect(service.readOriginalForWorkspace(imported.data.documentRef.id, 2)).toMatchObject({ ok: false, error: { code: 'input_invalid' } });
    expect(await readPage.execute({ documentId: imported.data.documentRef.id, page: 1, afterBlockId: 'b1', limit: 1 }, call, context))
      .toMatchObject({ blocks: [{ id: 'b2', kind: 'table' }], nextAfterBlockId: 'b2' });
    expect(await readPage.execute({ documentId: imported.data.documentRef.id, page: 1, afterBlockId: 'b2', limit: 10 }, call, context))
      .toMatchObject({ blocks: [{ id: 'b3' }, { id: 'b4' }], nextAfterBlockId: null, completePage: true });
    expect(await search.execute({ documentId: imported.data.documentRef.id, query: '20.00', page: null, afterBlockId: null, limit: 10 }, call, context))
      .toMatchObject({ matches: [{ page: 1, blockId: 'b2', excerpt: expect.stringContaining('20.00') }], complete: true });
    expect(await search.execute({ documentId: imported.data.documentRef.id, query: 'totals', page: null, afterBlockId: null, limit: 10 }, call, context))
      .toMatchObject({ matches: [], complete: true });
    expect(await listTables.execute({ documentId: imported.data.documentRef.id, page: null, afterBlockId: null, limit: 10 }, call, context))
      .toMatchObject({ tables: [{ blockId: 'b2', sourceType: 'table' }], complete: true });
    await expect(listPages.execute({ documentId: imported.data.documentRef.id }, call,
      { ...context, scope: { ...context.scope, allowedDocumentIds: [] } })).rejects.toMatchObject({ code: 'tool_access_denied' });
    const evidence = readInvoiceEvidence(service);
    const execution = { ...context, scope: { ...context.scope,
      allowedTools: [...context.scope.allowedTools, 'read_invoice_evidence', 'check_invoice_sources'],
      allowedArtifactIds: [imported.data.parsedArtifactId, imported.data.originalArtifactId] },
      nativeToolCallId: 'native-call-evidence', signal: new AbortController().signal };
    const parsedEvidence = await evidence.execute({ documentId: imported.data.documentRef.id, page: 1, kind: 'parsed', blockId: 'b2' },
      { nativeToolCallId: execution.nativeToolCallId, signal: execution.signal }, execution);
    expect(parsedEvidence).toMatchObject({ kind: 'parsed', text: expect.stringContaining('20.00') });
    const validSource = { ...parsedEvidence.source, quote: '20.00' };
    const falseSource = { ...validSource, quote: 'not on this page' };
    expect(checkInvoiceSourcesResult({ documentId: imported.data.documentRef.id, sources: [validSource, falseSource] }, execution, service, opened.documents))
      .toMatchObject({ ok: true, data: { results: [
        { index: 0, status: 'valid', code: 'parsed_quote_matched' },
        { index: 1, status: 'invalid', code: 'quote_mismatch' },
      ] } });
    const originalSource = { documentId: imported.data.documentRef.id, version: imported.data.documentRef.version,
      artifactId: imported.data.originalArtifactId, page: 1, blockId: null, quote: null };
    await expect(evidence.execute({ documentId: imported.data.documentRef.id, page: 1, kind: 'original', blockId: null } as never,
      { nativeToolCallId: execution.nativeToolCallId, signal: execution.signal }, execution))
      .rejects.toMatchObject({ code: 'tool_invalid_input' });
    expect(checkInvoiceSourcesResult({ documentId: imported.data.documentRef.id, sources: [originalSource] }, execution, service, opened.documents))
      .toMatchObject({ ok: false, error: { code: 'tool_access_denied' } });
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
    const changedContent = await service.importVoxel51({ sourceDirectory });
    expect(changedContent.ok).toBe(true);
    if (changedContent.ok) expect(changedContent.data.documentRef.version).not.toBe(imported.data.documentRef.version);
    writeFileSync(contentPath, originalContent);
    const changed = Buffer.from(onePixelPng);
    changed[25] ^= 1;
    writeFileSync(join(sourceDirectory, 'original.png'), changed);
    const changedOriginal = await service.importVoxel51({ sourceDirectory });
    expect(changedOriginal.ok).toBe(true);
    if (changedOriginal.ok) expect(changedOriginal.data.documentRef.version).not.toBe(imported.data.documentRef.version);
    expect(opened.db.query('SELECT COUNT(*) AS count FROM documents').get()).toEqual({ count: 3 });
    expect(productPaths.artifactsDir).toContain('artifacts');
  });

  it('keeps complete published files as an orphan after a failed registration and reuses the verified orphan', async () => {
    const root = mkdtempSync(join(tmpdir(), 'flowmate-document-orphan-'));
    const sourceDirectory = join(root, 'source', '000001');
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
    opened.db.exec('DROP TRIGGER fail_document_activity;');
    const retried = await service.importVoxel51({ sourceDirectory });
    expect(retried).toMatchObject({ ok: true, data: { documentRef: { id: 1 }, originalArtifactId: 1, parsedArtifactId: 2 } });
    expect(opened.db.query('SELECT COUNT(*) AS count FROM business_events WHERE type=\'document_imported\'').get()).toEqual({ count: 1 });
    expect(readdirSync(productPaths.artifactsDir).filter((name) => /^[1-9]\d*$/.test(name)).sort()).toEqual(['1', '2']);
  });

  it('marks missing parsed files unavailable and restores only after the complete stored pair validates', async () => {
    const root = mkdtempSync(join(tmpdir(), 'flowmate-document-restore-'));
    const sourceDirectory = join(root, 'source', '000001');
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
    const tool = listInvoicePages(service);
    const call = { nativeToolCallId: 'missing-parsed', signal: new AbortController().signal };
    await expect(tool.execute({ documentId: imported.data.documentRef.id }, call, context)).rejects.toMatchObject({ code: 'input_unavailable' });
    expect(opened.documents.get(imported.data.documentRef.id)).toMatchObject({ ok: true, data: { status: 'unavailable' } });
    copyFileSync(backupPath, parsedPath);
    expect(service.restoreDocument(imported.data.documentRef.id)).toMatchObject({ ok: true, data: { status: 'available' } });
    expect(await tool.execute({ documentId: imported.data.documentRef.id }, call, context)).toMatchObject({ pageCount: 1 });
  });

  it('rejects an artifact tree redirected outside the product root', async () => {
    const root = mkdtempSync(join(tmpdir(), 'flowmate-artifact-root-link-'));
    const sourceDirectory = join(root, 'source', '000001');
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

  it('rejects product-managed input roots and keeps large original images local-only', async () => {
    const root = mkdtempSync(join(tmpdir(), 'flowmate-document-boundaries-'));
    const { opened, files, service, productPaths } = serviceFor(root, join(root, 'external-source'));
    const productSource = join(productPaths.root, 'source', '000001');
    writeSample(productSource);
    expect(await service.importVoxel51({ sourceDirectory: productSource }))
      .toMatchObject({ ok: false, error: { code: 'source_invalid' } });

    const sourceDirectory = join(root, 'external-source', '000001');
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
    const evidence = readInvoiceEvidence(service);
    await expect(evidence.execute({ documentId: imported.data.documentRef.id, page: 1, kind: 'original', blockId: null } as never,
      { nativeToolCallId: context.nativeToolCallId, signal: context.signal }, context))
      .rejects.toMatchObject({ code: 'tool_invalid_input' });
    const artifact = opened.documents.getArtifact(imported.data.originalArtifactId);
    expect(artifact.ok).toBe(true);
    if (artifact.ok) expect(files.read(artifact.data, 'original.png')).toMatchObject({ ok: true });
  });
});
