import { expect, it } from 'bun:test';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { createFileStore, FileStore, openDatabase } from '@flowmate/core';
import { researchNeed as need } from '../../support/research.ts';
import { deferCleanup, mkdtempSync } from '../../support/resources.ts';

function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'flowmate-research-files-'));
  const paths = { root, databaseFile: join(root, 'data/app.sqlite'), artifactsDir: join(root, 'artifacts'),
    runtimeDir: join(root, 'runtime'), logsDir: join(root, 'logs'), outputsDir: join(root, 'outputs') };
  const db = need(openDatabase(paths)); deferCleanup(() => db.close());
  const files = createFileStore(paths, db.documents);
  const publish = Reflect.get(files, 'publishResearchSource');
  const read = Reflect.get(files, 'readResearchSource');
  expect(publish).toBeFunction(); expect(read).toBeFunction();
  return { root, files, documents: db.documents, publish: publish.bind(files), read: read.bind(files) };
}

it('atomically publishes immutable UTF-8 evidence and validates hash, bytes and exact character offsets on read', () => {
  const f = fixture(), text = 'Source evidence 原文😀\nA deployment constraint.';
  const source = need<any>(f.publish({ researchId: 7, text }));
  expect(source.contentHash).toBe(createHash('sha256').update(text).digest('hex'));
  expect(source.relativePath).toBe(`artifacts/research/7/${source.contentHash}.txt`);
  expect(source.bytes).toBe(Buffer.byteLength(text)); expect(source.characters).toBe(text.length);
  expect(need(f.read({ ...source, researchId: 7 }))).toBe(text);
  expect(f.publish({ researchId: 7, text })).toEqual({ ok: true, data: source });
  expect(readFileSync(join(f.root, source.relativePath), 'utf8')).toBe(text);
  writeFileSync(join(f.root, source.relativePath), 'Changed evidence');
  expect(f.read({ ...source, researchId: 7 })).toMatchObject({ ok: false, error: { code: 'research_source_unavailable' } });
  expect(f.publish({ researchId: 7, text })).toMatchObject({ ok: false });
});

it('does not create directories outside the managed root on publication failure', () => {
  const f = fixture(), root = join(f.root, 'managed'); mkdirSync(root);
  const outside = join(f.root, 'outside');
  const files = new FileStore({ root, artifactsDir: outside, databaseFile: '', outputsDir: '', runtimeDir: '', logsDir: '' }, f.documents);
  expect(files.publishResearchSource({ researchId: 1, text: 'Evidence' })).toMatchObject({ ok: false });
  expect(existsSync(outside)).toBe(false);
});

it('rejects invalid identity, malformed UTF-8, empty/oversize bodies and foreign source paths', () => {
  const f = fixture();
  for (const input of [{ researchId: -1, text: 'Evidence' }, { researchId: 1, text: '' },
    { researchId: 1, text: '\ud800' }, { researchId: 1, text: 'x'.repeat(2_000_001) }]) expect(f.publish(input)).toMatchObject({ ok: false });
  const source = need<any>(f.publish({ researchId: 1, text: 'Evidence' }));
  for (const altered of [{ researchId: 2 }, { relativePath: '../secret.txt' }, { contentHash: '0'.repeat(64) }, { bytes: source.bytes + 1 }, { characters: 999 }]) {
    expect(f.read({ researchId: 1, ...source, ...altered })).toMatchObject({ ok: false });
  }
});

it('preserves a leading UTF-8 BOM as part of the saved body and locator offsets', () => {
  const f = fixture(), text = '\ufeffFirst character is part of the evidence.';
  const source = need<any>(f.publish({ researchId: 1, text }));
  expect(need(f.read({ ...source, researchId: 1 }))).toBe(text);
  expect(source.characters).toBe(text.length);
});
