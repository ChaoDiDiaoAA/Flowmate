import { mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { describe, expect, it } from 'bun:test';
import { deferCleanup, mkdtempSync } from '../support/resources.ts';

const onePixelPng = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/a54AAAAASUVORK5CYII=', 'base64');

function writeSample(sourceDirectory: string, sampleId: string) {
  mkdirSync(sourceDirectory, { recursive: true });
  const content = Buffer.from(JSON.stringify([
    { type: 'text', text: 'Invoice no: 123', bbox: [0, 0, 10, 10], page_idx: 0 },
  ]));
  const pages = Buffer.from(JSON.stringify([{ pageNumber: 1, text: 'Invoice no: 123', blockCount: 1 }]));
  const original = onePixelPng;
  const metadata = Buffer.from(JSON.stringify({
    schemaVersion: 1,
    sampleId,
    datasetId: 'voxel51-hq-invoice-ocr',
    sourceRecordId: `source-${sampleId}`,
    datasetRevision: 'revision-1',
    parserKey: 'mineru@3.4.5;model=pipeline',
    qualityStatus: 'not_checked',
    allowedUsesClaim: ['development'],
    licenseVerification: 'not_verified',
    files: [
      { path: 'original.png', bytes: original.length },
      { path: 'content.json', bytes: content.length },
      { path: 'pages.json', bytes: pages.length },
      { path: 'content.md', bytes: 20 },
    ],
  }));
  writeFileSync(join(sourceDirectory, 'original.png'), original);
  writeFileSync(join(sourceDirectory, 'content.json'), content);
  writeFileSync(join(sourceDirectory, 'pages.json'), pages);
  writeFileSync(join(sourceDirectory, 'metadata.json'), metadata);
  writeFileSync(join(sourceDirectory, 'content.md'), 'not copied');
}

describe('prepare invoice input directory', () => {
  it('copies only validated source files, reports rejected/conflicting samples, and reuses identical output', async () => {
    const root = mkdtempSync(join(tmpdir(), 'flowmate-agent-input-'));
    deferCleanup(() => rmSync(root, { recursive: true, force: true }));
    const sourceRoot = join(root, 'voxel51');
    const targetRoot = join(root, 'agent-input');
    const reportPath = join(root, 'agent-input-report.json');
    for (const sampleId of ['000001', '000002', '000003', '000004']) writeSample(join(sourceRoot, sampleId), sampleId);
    const sourceBytes = readFileSync(join(sourceRoot, '000001', 'content.json'));
    rmSync(join(sourceRoot, '000003', 'pages.json'));
    mkdirSync(join(targetRoot, '000002'), { recursive: true });
    for (const name of ['original.png', 'content.json', 'pages.json', 'metadata.json']) {
      writeFileSync(join(targetRoot, '000002', name), name === 'original.png' ? 'different content' : 'existing user file');
    }
    mkdirSync(join(targetRoot, '000004'), { recursive: true });
    writeFileSync(join(targetRoot, '000004', 'original.png'), onePixelPng);
    writeFileSync(join(targetRoot, '000004', 'unrelated.txt'), 'preserve');

    const scriptPath = resolve(import.meta.dir, '../../scripts/prepare-invoice-input.ts');
    const loaded = await import(scriptPath).catch(() => null);
    const api = (loaded ?? {}) as { prepareInvoiceInput?: (options: {
      sourceRoot: string; targetRoot: string; reportPath: string; now?: () => string;
    }) => { totalSamples: number; counts: Record<string, number>; samples: Array<{ sampleId: string; status: string; reason: string | null }> } };
    const run = api.prepareInvoiceInput;
    const first = run?.({ sourceRoot, targetRoot, reportPath, now: () => '2026-09-29T00:00:00.000Z' }) ?? null;

    expect(first).not.toBeNull();
    if (first === null) return;
    expect(first).toMatchObject({ totalSamples: 4, counts: { included: 1, reused: 0, rejected: 1, conflict: 2 } });
    expect(first?.samples).toEqual([
      { sampleId: '000001', status: 'included', reason: null },
      { sampleId: '000002', status: 'conflict', reason: 'target_content_conflict:original.png' },
      { sampleId: '000003', status: 'rejected', reason: expect.any(String) },
      { sampleId: '000004', status: 'conflict', reason: 'target_file_set_conflict' },
    ]);
    expect(readdirSync(join(targetRoot, '000001')).sort()).toEqual(['content.json', 'metadata.json', 'original.png', 'pages.json']);
    expect(readFileSync(join(targetRoot, '000001', 'content.json'))).toEqual(sourceBytes);
    expect(readFileSync(join(targetRoot, '000002', 'original.png'), 'utf8')).toBe('different content');
    expect(readFileSync(join(targetRoot, '000004', 'unrelated.txt'), 'utf8')).toBe('preserve');
    expect(() => readFileSync(join(targetRoot, '000003', 'metadata.json'))).toThrow();
    expect(readFileSync(join(targetRoot, '000001', 'original.png'))).toEqual(readFileSync(join(sourceRoot, '000001', 'original.png')));
    expect(readFileSync(join(targetRoot, '000001', 'pages.json'))).toEqual(readFileSync(join(sourceRoot, '000001', 'pages.json')));
    const preparedMetadata = JSON.parse(readFileSync(join(targetRoot, '000001', 'metadata.json'), 'utf8')) as Record<string, unknown>;
    expect(Object.keys(preparedMetadata).sort()).toEqual([
      'allowedUsesClaim', 'datasetId', 'datasetRevision', 'files', 'licenseVerification',
      'qualityStatus', 'sampleId', 'schemaVersion', 'sourceRecordId',
    ].sort());
    expect(preparedMetadata.files).toEqual([
      { path: 'original.png', bytes: onePixelPng.length },
      { path: 'content.json', bytes: sourceBytes.length },
      { path: 'pages.json', bytes: readFileSync(join(sourceRoot, '000001', 'pages.json')).length },
    ]);
    expect(readFileSync(reportPath, 'utf8')).toContain('2026-09-29T00:00:00.000Z');

    const second = run?.({ sourceRoot, targetRoot, reportPath, now: () => '2026-09-29T00:01:00.000Z' });
    expect(second).toMatchObject({ totalSamples: 4, counts: { included: 0, reused: 1, rejected: 1, conflict: 2 } });
    const archiveMetadataPath = join(sourceRoot, '000001', 'metadata.json');
    const archiveMetadata = JSON.parse(readFileSync(archiveMetadataPath, 'utf8')) as Record<string, unknown>;
    archiveMetadata.parserKey = 'other-parser-config';
    writeFileSync(archiveMetadataPath, JSON.stringify(archiveMetadata));
    const afterParserChange = run?.({ sourceRoot, targetRoot, reportPath, now: () => '2026-09-29T00:02:00.000Z' });
    expect(afterParserChange).toMatchObject({ counts: { included: 0, reused: 1, rejected: 1, conflict: 2 } });
    expect(readFileSync(join(sourceRoot, '000001', 'content.json'))).toEqual(sourceBytes);
  });
});
