/** P0 evidence binding helpers only. Importing this module never starts a product. */
import { execFileSync } from 'node:child_process';
import { lstat, readFile, writeFile } from 'node:fs/promises';
import { isAbsolute, relative, resolve, sep } from 'node:path';
import { sha256Bytes, sha256Canonical } from '../../../packages/shared/src/index.ts';

export type SnapshotFile = { path: string; sha256: string };
export type StageCaseSet = { schemaVersion: 'p0-stage-cases/v1'; stage: 'P0'; version: number; cases: Array<{ id: string; scope: 'product' | 'asset' | 'facility'; required: boolean; oracle: Record<string, unknown> }> };

export async function readCases(path: string): Promise<{ value: StageCaseSet; sha256: string; oracleSha256: string; bytes: Uint8Array }> {
  const bytes = await readFile(path);
  const value = JSON.parse(bytes.toString('utf8')) as StageCaseSet;
  if (value.schemaVersion !== 'p0-stage-cases/v1' || value.stage !== 'P0' || !Number.isSafeInteger(value.version) || !Array.isArray(value.cases) || !value.cases.length) throw new Error('Invalid P0 stage case set');
  const ids = new Set<string>();
  for (const c of value.cases) {
    if (typeof c.id !== 'string' || ids.has(c.id) || !['product', 'asset', 'facility'].includes(c.scope) || typeof c.required !== 'boolean' || !c.oracle || !Object.keys(c.oracle).length) throw new Error('Invalid or duplicate P0 case');
    ids.add(c.id);
  }
  return { value, sha256: sha256Bytes(bytes), oracleSha256: sha256Canonical(value.cases.map(c => ({ id: c.id, oracle: c.oracle }))), bytes };
}

export async function snapshotCode(root: string): Promise<{ files: SnapshotFile[]; sha256: string }> {
  // Include untracked source contents, not just git status paths. Runtime/data output is excluded.
  const roots = ['apps', 'packages', 'scripts', 'tests', 'agent-eval/src', 'agent-eval/tools', 'agent-eval/tests', 'docs/spec', 'agent-eval/docs/spec', 'package.json', 'bun.lock', 'tsconfig.json', 'vitest.config.ts'];
  const paths = [...new Set(execFileSync('git', ['ls-files', '-co', '--exclude-standard', '-z', '--', ...roots], { cwd: root, encoding: 'utf8', windowsHide: true }).split('\0').filter(Boolean))].sort();
  const files: SnapshotFile[] = [];
  for (const path of paths) {
    if (/(__pycache__|\.pyc$|\.pytest_cache)/.test(path)) continue;
    const absolute = resolve(root, path);
    if ((await lstat(absolute)).isSymbolicLink()) throw new Error(`Code snapshot forbids linked file: ${path}`);
    files.push({ path, sha256: sha256Bytes(await readFile(absolute)) });
  }
  return { files, sha256: sha256Canonical(files) };
}

export async function writeNewJson(path: string, value: unknown): Promise<void> {
  await writeFile(path, `${JSON.stringify(value, null, 2)}\n`, { encoding: 'utf8', flag: 'wx' });
}

export function requireBindingMatch(expected: Record<string, unknown>, actual: Record<string, unknown>): void {
  if (sha256Canonical(expected) !== sha256Canonical(actual)) throw new Error('Frozen code/config/input/Case binding drift; do not open a stale restore');
}

export function requireSeparateRoots(instanceRoot: string, outputRoot: string): void {
  const inside = (a: string, b: string) => { const rel = relative(a, b); return rel === '' || (!isAbsolute(rel) && rel !== '..' && !rel.startsWith(`..${sep}`)); };
  if (inside(instanceRoot, outputRoot) || inside(outputRoot, instanceRoot)) throw new Error('Product instance and quality output must be disjoint');
  if (resolve(instanceRoot).split(/[\\/]/).some(part => part.toLowerCase() === 'agent-eval')) throw new Error('Product instance cannot be in quality root');
}

export function publicationCoverage(sampleIds: string[], documents: Array<{ sampleId: string; aliases: string[]; excluded: Array<{ sampleId: string }> }>) {
  const represented = documents.flatMap(d => [d.sampleId, ...d.aliases, ...d.excluded.map(e => e.sampleId)]);
  const expected = new Set(sampleIds), actual = new Set(represented);
  const missing = [...expected].filter(id => !actual.has(id));
  const unexpected = [...actual].filter(id => !expected.has(id));
  return { expectedSamples: sampleIds.length, representedSamples: represented.length, missing, unexpected,
    complete: sampleIds.length > 0 && expected.size === sampleIds.length && represented.length === actual.size && !missing.length && !unexpected.length };
}

/** New local development F policy; absence retains legacy rules for other purposes. */
export function p0AssessmentBinding(purpose: string): { assessmentPolicy?: 'p0-local-f/v2' } {
  return purpose === 'development' ? { assessmentPolicy: 'p0-local-f/v2' } : {};
}
