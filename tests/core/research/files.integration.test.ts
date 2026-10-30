import { expect, it } from 'bun:test';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { createFileStore, FileStore } from '@flowmate/core';
import { openTestDatabase as openDatabase } from '../../support/database.ts';
import { researchNeed as need } from '../../support/research.ts';
import { deferCleanup, mkdtempSync } from '../../support/resources.ts';

function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'flowmate-research-files-'));
  const paths = { root, databaseFile: join(root, 'data/app.sqlite'), artifactsDir: join(root, 'artifacts'),
    runtimeDir: join(root, 'runtime'), logsDir: join(root, 'logs'), outputsDir: join(root, 'outputs') };
  const db = need(openDatabase(paths)); deferCleanup(() => db.close());
  const files = createFileStore(paths, db);
  const publish = files.publishResearchSource, read = files.readResearchSource;
  expect(publish).toBeFunction(); expect(read).toBeFunction();
  return { root, files, owner: db, publish: publish.bind(files), read: read.bind(files) };
}

it('atomically publishes immutable UTF-8 evidence and validates original content, bytes and exact character offsets on read', async () => {
  const f = fixture(), text = 'Source evidence 原文😀\nA deployment constraint.';
  const source = need(await f.publish({ researchId: 7, toolCallId: 11, text }));
  expect(source.relativePath).toBe('artifacts/research/7/source-11.txt');
  expect(source.bytes).toBe(Buffer.byteLength(text)); expect(source.characters).toBe(text.length);
  expect(need(await f.read({ ...source, researchId: 7, toolCallId: 11 }))).toBe(text);
  expect(await f.publish({ researchId: 7, toolCallId: 11, text })).toEqual({ ok: true, data: source });
  expect(readFileSync(join(f.root, source.relativePath), 'utf8')).toBe(text);
  writeFileSync(join(f.root, source.relativePath), Buffer.alloc(source.bytes, 0x78));
  expect(await f.read({ ...source, researchId: 7, toolCallId: 11 })).toMatchObject({ ok: false, error: { code: 'research_source_unavailable' } });
  expect(await f.publish({ researchId: 7, toolCallId: 11, text })).toMatchObject({ ok: false });
});

it('does not create directories outside the managed root on publication failure', async () => {
  const f = fixture(), root = join(f.root, 'managed'); mkdirSync(root);
  const outside = join(f.root, 'outside');
  const files = new FileStore({ root, artifactsDir: outside, databaseFile: '', outputsDir: '', runtimeDir: '', logsDir: '' }, f.owner);
  expect(await files.publishResearchSource({ researchId: 1, toolCallId: 11, text: 'Evidence' })).toMatchObject({ ok: false });
  expect(existsSync(outside)).toBe(false);
});

it('rejects invalid identity, malformed UTF-8, empty/oversize bodies and foreign source paths', async () => {
  const f = fixture();
  for (const input of [{ researchId: -1, toolCallId: 11, text: 'Evidence' }, { researchId: 1, toolCallId: 11, text: '' },
    { researchId: 1, toolCallId: 11, text: '\ud800' }, { researchId: 1, toolCallId: 11, text: 'x'.repeat(2_000_001) }]) expect(await f.publish(input)).toMatchObject({ ok: false });
  const source = need(await f.publish({ researchId: 1, toolCallId: 11, text: 'Evidence' }));
  for (const altered of [{ researchId: 2 }, { relativePath: '../secret.txt' }, { toolCallId: 12 }, { bytes: source.bytes + 1 }, { characters: 999 }]) {
    expect(await f.read({ researchId: 1, toolCallId: 11, ...source, ...altered })).toMatchObject({ ok: false });
  }
});

it('preserves a leading UTF-8 BOM as part of the saved body and locator offsets', async () => {
  const f = fixture(), text = '\ufeffFirst character is part of the evidence.';
  const source = need(await f.publish({ researchId: 1, toolCallId: 11, text }));
  expect(need(await f.read({ ...source, researchId: 1, toolCallId: 11 }))).toBe(text);
  expect(source.characters).toBe(text.length);
});
