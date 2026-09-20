import { afterEach, describe, expect, it } from 'vitest';
import { execFileSync } from 'node:child_process';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { p0AssessmentBinding, requireBindingMatch, readCases, requireSeparateRoots, snapshotCode, writeNewJson, publicationCoverage } from '../../agent-eval/src/runner/p0-binding.ts';

const roots: string[] = [];
afterEach(async () => { for (const r of roots.splice(0)) await rm(r, { recursive: true, force: true }); });
describe('P0 quality binding facility', () => {
  it('freezes the local policy only for development and rejects later policy changes', () => {
    const binding = { purpose: 'development', ...p0AssessmentBinding('development') };
    expect(binding.assessmentPolicy).toBe('p0-local-f/v2');
    expect(p0AssessmentBinding('regression')).toEqual({});
    expect(() => requireBindingMatch(binding, { purpose: 'development' })).toThrow();
    expect(() => requireBindingMatch(binding, { ...binding, assessmentPolicy: 'unknown' })).toThrow();
    expect(() => requireBindingMatch(binding, { ...binding })).not.toThrow();
  });
  it('does not accept partial duplicate or unexpected publication coverage', () => {
    const doc = { sampleId: 'a', aliases: ['b'], excluded: [{ sampleId: 'c' }] };
    expect(publicationCoverage(['a', 'b', 'c'], [doc]).complete).toBe(true);
    expect(publicationCoverage(['a', 'b', 'c', 'd'], [doc]).complete).toBe(false);
    expect(publicationCoverage(['a', 'b'], [doc]).complete).toBe(false);
    expect(publicationCoverage(['a', 'b', 'c'], [doc, doc]).complete).toBe(false);
    expect(publicationCoverage([], []).complete).toBe(false);
  });
  it('checks the Python stage reviewer with synthetic evidence', () => {
    execFileSync('python', ['-B', '-m', 'pytest', 'agent-eval/tests/p0/test_p0_stage.py', 'agent-eval/tests/p0/test_review_p0_report.py', '-q', '-p', 'no:cacheprovider'], { windowsHide: true, timeout: 30_000 });
  });
  it('binds untracked code bytes and refuses output overwrite', async () => {
    const root = await mkdtemp(join(tmpdir(), 'p0-facility-')); roots.push(root);
    execFileSync('git', ['init', '--quiet', root], { windowsHide: true });
    await mkdir(join(root, 'apps'));
    const file = join(root, 'apps', 'sample.ts');
    await writeFile(file, 'export const value = 1;');
    const first = await snapshotCode(root);
    await writeFile(file, 'export const value = 2;');
    expect((await snapshotCode(root)).sha256).not.toBe(first.sha256);
    const output = join(root, 'evidence.json');
    await writeNewJson(output, { ok: true });
    await expect(writeNewJson(output, { ok: false })).rejects.toMatchObject({ code: 'EEXIST' });
  });
  it('rejects overlapping product and evidence roots', () => {
    expect(() => requireSeparateRoots('/tmp/instance', '/tmp/instance/evidence')).toThrow();
    expect(() => requireSeparateRoots('/tmp/quality/instance', '/tmp/quality')).toThrow();
    expect(() => requireSeparateRoots('/tmp/instance', '/tmp/results')).not.toThrow();
  });
  it('rejects empty and duplicate stage cases', async () => {
    const root = await mkdtemp(join(tmpdir(), 'p0-case-facility-')); roots.push(root);
    const file = join(root, 'cases.json');
    await writeFile(file, JSON.stringify({ schemaVersion: 'p0-stage-cases/v1', stage: 'P0', version: 1, cases: [] }));
    await expect(readCases(file)).rejects.toThrow();
    const c = { id: 'P0-F01', scope: 'product', required: true, oracle: { assertions: [] } };
    await writeFile(file, JSON.stringify({ schemaVersion: 'p0-stage-cases/v1', stage: 'P0', version: 1, cases: [c, c] }));
    await expect(readCases(file)).rejects.toThrow();
  });
});
