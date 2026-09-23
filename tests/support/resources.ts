import { afterEach } from 'bun:test';
import { mkdtempSync as createTemp, rmSync } from 'node:fs';
import { isAbsolute, relative, resolve } from 'node:path';
import { tmpdir } from 'node:os';

const cleanup: Array<() => unknown | Promise<unknown>> = [];
export function deferCleanup(fn: () => unknown | Promise<unknown>) { cleanup.push(fn); }
export function mkdtempSync(prefix: string): string {
  const root = createTemp(prefix);
  const rel = relative(resolve(tmpdir()), resolve(root));
  if (!rel || rel.startsWith('..') || isAbsolute(rel)) throw new Error('Test resource must be owned under temp');
  deferCleanup(() => rmSync(root, { recursive: true, force: true }));
  return root;
}
export async function mkdtemp(prefix: string) { return mkdtempSync(prefix); }
afterEach(async () => {
  const errors: unknown[] = [];
  for (const close of cleanup.splice(0).reverse()) {
    try { await close(); } catch (error) { errors.push(error); }
  }
  if (errors.length) throw new AggregateError(errors, 'Test resource cleanup failed');
});
