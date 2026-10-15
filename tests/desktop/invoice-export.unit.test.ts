import { expect, it } from 'bun:test';
import { mkdirSync, readFileSync, writeFileSync, readdirSync, symlinkSync, lstatSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { mkdtempSync } from '../support/resources.ts';
import { publishInvoiceExportCopy } from '../../apps/desktop/main/invoice-export.ts';

it('publishes complete bytes, reuses the same file and never overwrites a different Native destination', () => {
  const root = mkdtempSync(join(tmpdir(), 'flowmate-export-copy-'));
  const destination = join(root, 'invoice.json'); const bytes = Buffer.from('{"total":"9007199254740993.000001"}');
  expect(publishInvoiceExportCopy(destination, bytes)).toEqual({ ok: true, data: { destinationPath: destination, bytes: bytes.length } });
  expect(readFileSync(destination)).toEqual(bytes);
  expect(publishInvoiceExportCopy(destination, bytes)).toMatchObject({ ok: true });
  expect(publishInvoiceExportCopy(destination, Buffer.from('different'))).toMatchObject({ ok: false, error: { code: 'state_conflict' } });
  expect(readFileSync(destination)).toEqual(bytes);
  expect(readdirSync(root)).toEqual(['invoice.json']);
  expect(publishInvoiceExportCopy(join(root, 'absent', 'invoice.json'), bytes)).toMatchObject({ ok: false, error: { code: 'storage_write_failed' } });
  expect(publishInvoiceExportCopy(destination, new Uint8Array())).toMatchObject({ ok: false, error: { code: 'input_invalid' } });
  expect(publishInvoiceExportCopy(destination, new Uint8Array(64 * 1024 * 1024 + 1))).toMatchObject({ ok: false, error: { code: 'input_invalid' } });
});

it('rejects directories and links while preserving their real contents', () => {
  const root = mkdtempSync(join(tmpdir(), 'flowmate-export-link-'));
  const directory = join(root, 'real'); mkdirSync(directory); writeFileSync(join(directory, 'keep'), 'retained');
  const link = join(root, 'linked.json'); symlinkSync(directory, link, process.platform === 'win32' ? 'junction' : 'dir');
  expect(lstatSync(link).isSymbolicLink()).toBe(true);
  for (const path of [directory, link]) expect(publishInvoiceExportCopy(path, Buffer.from('bytes')))
    .toMatchObject({ ok: false, error: { code: 'state_conflict' } });
  expect(readFileSync(join(directory, 'keep'), 'utf8')).toBe('retained');
  expect(readdirSync(root).sort()).toEqual(['linked.json', 'real']);
});
