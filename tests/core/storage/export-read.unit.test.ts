import { test, expect } from 'bun:test';
import * as core from '../../../packages/core/src/index.ts';
import { ok } from '../../../packages/contracts/src/index.ts';

test('export pages preserve original bytes and reject out-of-range reads', async () => {
  const create = Reflect.get(core, 'createInvoiceEditService');
  const original = Buffer.from('12345678');
  const reference = { artifactId: 7, candidateId: 3, format: 'json', relativePath: 'outputs/invoice-2-result-1.json',
    bytes: original.length, createdAt: '2026-10-15T00:00:00.000Z' };
  const scope = { candidates: { findExport: () => ok(reference) }, contents: { read: () => original } };
  const service = Reflect.apply(create, undefined, [{
    database: { read: async (operation: (current: typeof scope) => unknown) => operation(scope) },
    files: { readInvoiceExport: () => ok(original) },
  }]);
  const read = Reflect.get(service, 'readExport');
  expect(typeof read).toBe('function');
  const result = await read.call(service, { operationRef: 'export-one', candidateId: 3, format: 'json', offset: 4, limit: 4 });
  expect(result.ok).toBe(true);
  expect(result.data).toMatchObject({ artifactId: 7, candidateId: 3, offset: 4, bytes: 8, chunkBase64: 'NTY3OA==', nextOffset: null });
  expect((await read.call(service, { operationRef: 'export-one', candidateId: 3, format: 'json', offset: 8, limit: 4 })).ok).toBe(false);
});
