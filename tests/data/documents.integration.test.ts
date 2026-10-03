import { copyFileSync, cpSync, mkdirSync, readFileSync, readdirSync, renameSync, symlinkSync, unlinkSync, writeFileSync } from 'node:fs';
import { basename, join } from 'node:path';
import { tmpdir } from 'node:os';
import { describe, expect, it } from 'bun:test';
import { appError, fail, ok } from '@flowmate/contracts';
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
    if (changed.ok) {
      expect(changed.data.documentRef.version).not.toBe(imported.data.documentRef.version);
      expect(opened.documents.list({ limit: 1 })).toMatchObject({ ok: true,
        data: { items: [{ documentRef: { id: changed.data.documentRef.id } }], nextBeforeId: changed.data.documentRef.id } });
      expect(opened.documents.hide(changed.data.documentRef.id, '2026-09-28T00:01:00.000Z').ok).toBe(true);
      expect(opened.documents.list({ limit: 1 })).toMatchObject({ ok: true,
        data: { items: [{ documentRef: { id: imported.data.documentRef.id } }], nextBeforeId: null } });
    }
  });

  it('restores a hidden invoice only after its managed files match the formal input', async () => {
    const root = mkdtempSync(join(tmpdir(), 'flowmate-reimport-hidden-'));
    const sourceDirectory = join(root, 'source', '000001');
    writeSample(sourceDirectory);
    const { opened, service, productPaths } = serviceFor(root);
    const imported = await service.importVoxel51({ sourceDirectory });
    expect(imported.ok).toBe(true);
    if (!imported.ok) return;
    const documentId = imported.data.documentRef.id;
    expect(opened.documents.hide(documentId, '2026-09-28T00:01:00.000Z'))
      .toEqual({ ok: true, data: { documentId, affectedChatCount: 0 } });
    expect(opened.documents.list({ limit: 10 })).toMatchObject({ ok: true, data: { items: [] } });
    const context = { runId: 1, sessionId: 1, scope: { version: 2 as const, allowedTools: ['read_invoice_document'],
      allowedDocumentIds: [documentId], allowedArtifactIds: [imported.data.parsedArtifactId], allowedResourcePaths: [] } };
    expect(service.readParsedForRun(documentId, context)).toMatchObject({ ok: false, error: { code: 'input_unavailable' } });
    const managedPath = join(productPaths.artifactsDir, String(imported.data.parsedArtifactId), 'parsed.json');
    const saved = readFileSync(managedPath);
    const tampered = Buffer.from(saved);
    tampered[0] = tampered[0] === 123 ? 91 : 123;
    writeFileSync(managedPath, tampered);
    expect(await service.importVoxel51({ sourceDirectory })).toMatchObject({ ok: false, error: { code: 'document_version_conflict' } });
    expect(opened.documents.get(documentId)).toMatchObject({ ok: true, data: { isHidden: true } });
    writeFileSync(managedPath, saved);
    expect(await service.importVoxel51({ sourceDirectory })).toMatchObject({ ok: true,
      data: { documentRef: { id: documentId }, isHidden: false } });
    expect(opened.documents.list({ limit: 10 })).toMatchObject({ ok: true, data: { items: [{ documentRef: { id: documentId } }] } });
  });
  for (const access of ['run', 'workspace', 'restore', 'sources'] as const) {
    it(`rejects equal-length managed text drift through ${access} and restores only matching stored content`, async () => {
      const root = mkdtempSync(join(tmpdir(), 'flowmate-parsed-consistency-'));
      const sourceDirectory = join(root, 'source', '000001');
      writeSample(sourceDirectory);
      const { opened, service, productPaths } = serviceFor(root);
      const imported = await service.importVoxel51({ sourceDirectory });
      expect(imported.ok).toBe(true);
      if (!imported.ok) return;
      const document = imported.data;
      const documentId = document.documentRef.id;
      const context = { runId: 1, sessionId: 1, scope: { version: 2 as const,
        allowedTools: ['read_invoice_document', 'check_invoice_sources'], allowedDocumentIds: [documentId],
        allowedArtifactIds: [document.parsedArtifactId], allowedResourcePaths: [] } };
      const managedPath = join(productPaths.artifactsDir, String(document.parsedArtifactId), 'parsed.json');
      const saved = readFileSync(managedPath);
      const changed = Buffer.from(saved.toString('utf8').replace('Header text', 'Header edit'));
      expect(changed.byteLength).toBe(saved.byteLength);
      expect(changed.equals(saved)).toBe(false);
      writeFileSync(managedPath, changed);
      const changedSource = { documentId, version: document.documentRef.version,
        artifactId: document.parsedArtifactId, page: 1, blockId: 'b1', quote: 'Header edit' };
      if (access === 'restore') {
        expect(opened.documents.setAvailability({ documentId, status: 'unavailable', reason: 'fixture',
          at: '2026-09-28T00:01:00.000Z' }).ok).toBe(true);
      }
      const result = access === 'run' ? service.readParsedForRun(documentId, context)
        : access === 'workspace' ? service.readParsedForWorkspace(documentId)
        : access === 'restore' ? service.restoreDocument(documentId)
        : checkInvoiceSourcesResult({ documentId, sources: [changedSource] }, context, service, opened.documents);
      expect(result).toMatchObject({ ok: false, error: { code: 'input_unavailable' } });
      expect(opened.documents.get(documentId)).toMatchObject({ ok: true,
        data: { documentRef: document.documentRef, status: 'unavailable', unavailableReason: 'parsed_document_mismatch' } });
      expect(checkInvoiceSourcesResult({ documentId, sources: [changedSource] }, context, service, opened.documents))
        .toMatchObject({ ok: false, error: { code: 'input_unavailable' } });
      expect(service.restoreDocument(documentId)).toMatchObject({ ok: false, error: { code: 'input_unavailable' } });

      writeFileSync(managedPath, saved);
      for (const name of ['original.png', 'content.json', 'pages.json', 'metadata.json']) unlinkSync(join(sourceDirectory, name));
      expect(service.restoreDocument(documentId)).toMatchObject({ ok: true,
        data: { documentRef: document.documentRef, status: 'available' } });
      const restoredRead = service.readParsedForWorkspace(documentId);
      expect(restoredRead.ok).toBe(true);
      if (restoredRead.ok) expect(restoredRead.data.parsed.pages[0]?.blocks[0])
        .toMatchObject({ id: 'b1', text: 'Header text' });
      expect(checkInvoiceSourcesResult({ documentId, sources: [{ ...changedSource, quote: 'Header text' }] }, context, service, opened.documents))
        .toMatchObject({ ok: true, data: { results: [{ status: 'valid', code: 'parsed_quote_matched' }] } });
    });
  }

  for (const [fileName, attempt] of [['original.png', 1], ['raw-content.json', 2], ['source.json', 1]] as const) {
    it(`preserves availability on a transient restore read of ${fileName} at attempt ${attempt}`, async () => {
      const root = mkdtempSync(join(tmpdir(), 'flowmate-restore-transient-'));
      const sourceDirectory = join(root, 'source', '000001');
      writeSample(sourceDirectory);
      const { opened, files, service } = serviceFor(root);
      const imported = await service.importVoxel51({ sourceDirectory });
      expect(imported.ok).toBe(true);
      if (!imported.ok) return;
      const read = files.read.bind(files);
      let matchedReads = 0;
      const temporaryFailure = fail(appError('input_unavailable', 'input', 'Temporarily unreadable.', true));
      files.read = (artifact, name) => name === fileName && ++matchedReads === attempt
        ? temporaryFailure : read(artifact, name);
      const restored = service.restoreDocument(imported.data.documentRef.id);
      expect(matchedReads).toBe(attempt);
      expect(restored).toEqual(temporaryFailure);
      expect(opened.documents.get(imported.data.documentRef.id)).toMatchObject({ ok: true,
        data: { status: 'available', unavailableReason: null } });
      files.read = read;
      expect(service.restoreDocument(imported.data.documentRef.id)).toMatchObject({ ok: true,
        data: { status: 'available', unavailableReason: null } });
    });
  }

  it('reads and restores legacy managed parsed files without requiring new raw sidecars', async () => {
    const root = mkdtempSync(join(tmpdir(), 'flowmate-legacy-parsed-'));
    const { opened, files, service } = serviceFor(root);
    const at = '2026-09-28T00:00:00.000Z';
    const parsedBytes = Buffer.from(JSON.stringify({ formatVersion: 1, parser: { key: 'legacy-parser' },
      pages: [{ page: 1, blocks: [{ id: 'b1', kind: 'text', text: 'Legacy text',
        sourceIndex: 0, sourceType: 'text', bbox: null }] }],
      completeness: { status: 'complete', checks: ['legacy'], warnings: [] } }));
    const published = await files.publish({ sourceKey: 'voxel51', sourceRecordId: 'legacy-1', sourceVersion: 'legacy-v1', at,
      original: { kind: 'original', primaryName: 'original.png',
        files: [{ name: 'original.png', bytes: onePixelPng, mimeType: 'image/png' }] },
      parsed: { kind: 'parsed', primaryName: 'parsed.json',
        files: [{ name: 'parsed.json', bytes: parsedBytes, mimeType: 'application/json' }] } });
    expect(published.ok).toBe(true);
    if (!published.ok) return;
    const registered = opened.documents.register({ documentId: published.data.documentId,
      sourceKey: 'voxel51', sourceRecordId: 'legacy-1', version: 'legacy-v1',
      originalArtifact: { ...published.data.original, kind: 'original' },
      parsedArtifact: { ...published.data.parsed, kind: 'parsed' }, status: 'available',
      metadata: { version: 2, pageCount: 1, warnings: [], allowedUsesClaim: ['local review'],
        licenseVerification: 'not_verified', unavailableReason: null }, createdAt: at, updatedAt: at });
    expect(registered.ok).toBe(true);
    if (!registered.ok) return;
    const document = registered.data;
    const context = { runId: 1, sessionId: 1, scope: { version: 2 as const,
      allowedTools: ['read_invoice_document'], allowedDocumentIds: [document.documentRef.id],
      allowedArtifactIds: [document.parsedArtifactId], allowedResourcePaths: [] } };
    expect(service.readParsedForRun(document.documentRef.id, context)).toMatchObject({ ok: true,
      data: { parsed: { pages: [{ blocks: [{ id: 'b1', text: 'Legacy text' }] }] } } });
    const workspaceRead = service.readParsedForWorkspace(document.documentRef.id);
    expect(workspaceRead.ok).toBe(true);
    if (workspaceRead.ok) expect(workspaceRead.data.parsed).not.toHaveProperty('parser');
    expect(opened.documents.setAvailability({ documentId: document.documentRef.id, status: 'unavailable',
      reason: 'fixture', at }).ok).toBe(true);
    expect(service.restoreDocument(document.documentRef.id)).toMatchObject({ ok: true,
      data: { documentRef: document.documentRef, status: 'available' } });
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

describe('P7 Workspace material inspection', () => {
  it('distinguishes an unavailable managed root from a missing artifact under a verified root', async () => {
    const root = mkdtempSync(join(tmpdir(), 'flowmate-workspace-root-'));
    const sourceDirectory = join(root, 'source', '000001');
    writeSample(sourceDirectory);
    const { opened, files, service, productPaths } = serviceFor(root);
    const imported = await service.importVoxel51({ sourceDirectory });
    expect(imported.ok).toBe(true);
    if (!imported.ok) return;
    const artifact = opened.documents.getArtifact(imported.data.parsedArtifactId);
    expect(artifact.ok).toBe(true);
    if (!artifact.ok) return;
    const inaccessibleRoot = join(root, 'not-mounted');
    const absentRoot = createFileStore({ ...productPaths, root: inaccessibleRoot,
      artifactsDir: join(inaccessibleRoot, 'artifacts') }, opened.documents);
    expect(absentRoot.read(artifact.data)).toMatchObject({ ok: false,
      error: { code: 'input_unavailable', retryable: true } });
    const absentArtifactRoot = createFileStore({ ...productPaths, artifactsDir: join(productPaths.root, 'not-mounted') }, opened.documents);
    expect(absentArtifactRoot.read(artifact.data)).toMatchObject({ ok: false,
      error: { code: 'input_unavailable', retryable: true } });
    unlinkSync(join(productPaths.artifactsDir, String(artifact.data.artifactId), 'parsed.json'));
    expect(files.read(artifact.data)).toMatchObject({ ok: false, error: { code: 'artifact_unavailable' } });
  });

  it('returns real page and block identities without changing unavailable material or workspace facts', async () => {
    const root = mkdtempSync(join(tmpdir(), 'flowmate-workspace-inspection-'));
    const sourceDirectory = join(root, 'source', '000001');
    writeSample(sourceDirectory);
    const { opened, service } = serviceFor(root);
    const imported = await service.importVoxel51({ sourceDirectory });
    expect(imported.ok).toBe(true);
    if (!imported.ok) return;
    const changed = opened.documents.setAvailability({ documentId: imported.data.documentRef.id,
      status: 'unavailable', reason: 'previous_read_failure', at: '2026-10-03T00:00:00.000Z' });
    expect(changed.ok).toBe(true);
    opened.workspace.read('2026-10-03T00:00:00.000Z');
    const before = {
      documents: opened.db.query('SELECT * FROM documents').all(),
      workspace: opened.db.query('SELECT * FROM workspace').all(),
      activities: opened.db.query('SELECT * FROM business_events').all(),
    };
    expect(typeof service.inspectForWorkspace).toBe('function');
    const inspected = service.inspectForWorkspace(imported.data.documentRef);
    expect(inspected).toMatchObject({ ok: true, data: { kind: 'valid',
      document: { status: 'unavailable' }, pages: [{ page: 1, blockIds: ['b1', 'b2', 'b3', 'b4'] }] } });
    if (inspected.ok) expect(inspected.data).not.toHaveProperty('parsed');
    expect({
      documents: opened.db.query('SELECT * FROM documents').all(),
      workspace: opened.db.query('SELECT * FROM workspace').all(),
      activities: opened.db.query('SELECT * FROM business_events').all(),
    }).toEqual(before);
  });

  it('reports a confirmed missing target or version without persisting unavailability', async () => {
    const root = mkdtempSync(join(tmpdir(), 'flowmate-workspace-inspect-missing-'));
    const sourceDirectory = join(root, 'source', '000001');
    writeSample(sourceDirectory);
    const { opened, service, productPaths } = serviceFor(root);
    const imported = await service.importVoxel51({ sourceDirectory });
    expect(imported.ok).toBe(true);
    if (!imported.ok) return;
    expect(typeof service.inspectForWorkspace).toBe('function');
    expect(service.inspectForWorkspace({ ...imported.data.documentRef, version: 'another-version' }))
      .toEqual({ ok: true, data: { kind: 'invalid', reason: 'document_version_mismatch' } });
    expect(service.inspectForWorkspace({ id: 90001, version: 'missing-version' }))
      .toEqual({ ok: true, data: { kind: 'invalid', reason: 'document_missing' } });
    const before = opened.db.query('SELECT * FROM documents').all();
    unlinkSync(join(productPaths.artifactsDir, String(imported.data.parsedArtifactId), 'parsed.json'));
    expect(service.inspectForWorkspace(imported.data.documentRef))
      .toEqual({ ok: true, data: { kind: 'invalid', reason: 'artifact_missing_or_invalid' } });
    expect(opened.db.query('SELECT * FROM documents').all()).toEqual(before);
  });

  it('rejects mutually matching Artifacts whose source identity no longer belongs to their Document', async () => {
    const root = mkdtempSync(join(tmpdir(), 'flowmate-workspace-inspect-source-'));
    const sourceDirectory = join(root, 'source', '000001');
    writeSample(sourceDirectory);
    const { opened, service } = serviceFor(root);
    const imported = await service.importVoxel51({ sourceDirectory });
    if (!imported.ok) throw new Error(imported.error.code);
    opened.db.query('UPDATE documents SET source_record_id=? WHERE id=?').run('different-persistent-source', imported.data.documentRef.id);
    const before = { documents: opened.db.query('SELECT * FROM documents').all(), workspace: opened.db.query('SELECT * FROM workspace').all() };
    expect(service.inspectForWorkspace(imported.data.documentRef))
      .toEqual({ ok: true, data: { kind: 'invalid', reason: 'artifact_missing_or_invalid' } });
    expect({ documents: opened.db.query('SELECT * FROM documents').all(), workspace: opened.db.query('SELECT * FROM workspace').all() }).toEqual(before);
  });

  it('preserves read failures as unknown inspection results for every transient file code', async () => {
    const root = mkdtempSync(join(tmpdir(), 'flowmate-workspace-inspect-transient-'));
    const sourceDirectory = join(root, 'source', '000001');
    writeSample(sourceDirectory);
    const { opened, files, service, productPaths } = serviceFor(root);
    const imported = await service.importVoxel51({ sourceDirectory });
    expect(imported.ok).toBe(true);
    if (!imported.ok) return;
    const before = opened.db.query('SELECT * FROM documents').all();
    for (const code of ['EACCES', 'EPERM', 'EBUSY', 'EIO']) {
      const error = appError('input_unavailable', 'input', code, true);
      const unavailable = createDocumentService({ paths: productPaths, repository: opened.documents,
        files: { publish: input => files.publish(input), read: () => fail(error) },
        allowedSourceRoot: join(root, 'source'), now: () => '2026-10-03T00:00:00.000Z' });
      expect(typeof unavailable.inspectForWorkspace).toBe('function');
      expect(unavailable.inspectForWorkspace(imported.data.documentRef)).toEqual({ ok: false, error });
    }
    expect(opened.db.query('SELECT * FROM documents').all()).toEqual(before);
  });

  async function legacy(pages: unknown[]) {
    const root = mkdtempSync(join(tmpdir(), 'flowmate-workspace-inspect-legacy-'));
    const fixture = serviceFor(root);
    const at = '2026-10-03T00:00:00.000Z';
    const bytes = Buffer.from(JSON.stringify({ formatVersion: 1, parser: { key: 'legacy-parser' },
      pages, completeness: { status: 'complete', checks: ['legacy'], warnings: [] } }));
    const published = await fixture.files.publish({ sourceKey: 'voxel51', sourceRecordId: 'legacy-1',
      sourceVersion: 'legacy-v1', at, original: { kind: 'original', primaryName: 'original.png',
        files: [{ name: 'original.png', bytes: onePixelPng, mimeType: 'image/png' }] },
      parsed: { kind: 'parsed', primaryName: 'parsed.json',
        files: [{ name: 'parsed.json', bytes, mimeType: 'application/json' }] } });
    if (!published.ok) throw new Error('legacy_publication_failed');
    const registered = fixture.opened.documents.register({ documentId: published.data.documentId,
      sourceKey: 'voxel51', sourceRecordId: 'legacy-1', version: 'legacy-v1',
      originalArtifact: { ...published.data.original, kind: 'original' },
      parsedArtifact: { ...published.data.parsed, kind: 'parsed' }, status: 'available',
      metadata: { version: 2, pageCount: pages.length, warnings: [], allowedUsesClaim: ['local review'],
        licenseVerification: 'not_verified', unavailableReason: null }, createdAt: at, updatedAt: at });
    if (!registered.ok) throw new Error('legacy_registration_failed');
    return { ...fixture, document: registered.data };
  }
  const block = { id: 'b1', kind: 'text', text: 'Synthetic', sourceIndex: 0, sourceType: 'text', bbox: null };
  it('rejects duplicate page or within-page block identities and retains legitimate per-page block IDs', async () => {
    for (const pages of [
      [{ page: 1, blocks: [block] }, { page: 1, blocks: [block] }],
      [{ page: 1, blocks: [block, block] }],
    ]) {
      const fixture = await legacy(pages);
      expect(typeof fixture.service.inspectForWorkspace).toBe('function');
      expect(fixture.service.inspectForWorkspace(fixture.document.documentRef))
        .toEqual({ ok: true, data: { kind: 'invalid', reason: 'artifact_missing_or_invalid' } });
      expect(fixture.opened.documents.get(fixture.document.documentRef.id)).toMatchObject({ ok: true, data: { status: 'available' } });
    }
    const fixture = await legacy([{ page: 1, blocks: [block] }, { page: 2, blocks: [block] }]);
    expect(fixture.service.inspectForWorkspace(fixture.document.documentRef)).toMatchObject({ ok: true,
      data: { kind: 'valid', pages: [{ page: 1, blockIds: ['b1'] }, { page: 2, blockIds: ['b1'] }] } });
  });
});
