import { expect, test } from 'bun:test';
import { cpSync, mkdirSync, readFileSync, writeFileSync, symlinkSync, unlinkSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { mkdtempSync } from '../../../tests/support/resources.ts';
import { fixtureDirectory, fixtureRepo } from '../support/fixtures.ts';
import { findDataset } from '../../src/execution/plan.ts';
import { REPO_ROOT } from '../../src/dataset-loader/local.ts';
import * as declarations from '../../src/dataset-loader/declarations.ts';

const discover = declarations.discoverCaseDeclarations;
const inspect = declarations.inspectCaseDeclaration;
function authored() {
    const root = mkdtempSync(join(tmpdir(), 'eval-author-inspect-')), directory = join(root, 'agent-eval/src/datasets');
    mkdirSync(directory, { recursive: true }); mkdirSync(join(root, 'agent-eval/src/testing/fixtures'), { recursive: true });
    for (const file of ['cases.ts', 'gold.ts', 'review.ts']) writeFileSync(join(directory, file), readFileSync(join(REPO_ROOT, 'agent-eval/src/datasets', file)));
    writeFileSync(join(root, 'agent-eval/src/testing/scenarios.ts'), readFileSync(join(REPO_ROOT, 'agent-eval/src/testing/scenarios.ts')));
    // Case turns import this declaration input; the execution material corpus remains absent.
    writeFileSync(join(root, 'agent-eval/src/testing/fixtures/manual-compaction-user-history.json'),
        readFileSync(join(REPO_ROOT, 'agent-eval/src/testing/fixtures/manual-compaction-user-history.json')));
    return { root, directory };
}

test('authored Case discovery reads registered declarations without requiring the invoice or execution material corpus', () => {
    const p = authored(), cases = discover(p.root);
    expect(cases).toHaveLength(62);
    expect(cases.filter((item: { datasetId: string }) => item.datasetId === 'flowmate-agent-v1')).toHaveLength(50);
    expect(cases.filter((item: { datasetId: string }) => item.datasetId === 'flowmate-research-v1')).toHaveLength(12);
    expect(cases.filter((item: { smoke: boolean }) => item.smoke)).toHaveLength(14);
    expect(cases.find((item: { caseId: string }) => item.caseId === 'FM-028')).toMatchObject({ caseVersion: 1, task: { id: 'FM-028' } });
    expect(() => findDataset(p.root, { dataset: 'flowmate-agent-v1' })).toThrow();
});

test('missing declaration inputs remain a source error and cannot become an empty or invented Case', () => {
    const p = authored(); unlinkSync(join(p.root, 'agent-eval/src/testing/fixtures/manual-compaction-user-history.json'));
    expect(() => discover(p.root)).toThrow(/manual-compaction-user-history/);
});

test('legacy registered Case declarations also stay inspectable when their material source is absent', () => {
    const root = mkdtempSync(join(tmpdir(), 'eval-flat-inspect-')), directory = join(root, 'agent-eval/src/datasets/facility-test');
    cpSync(fixtureDirectory, directory, { recursive: true });
    const cases = discover(root);
    expect(cases).toHaveLength(3);
    expect(cases.find((item: { caseId: string }) => item.caseId === 'test-lines')).toMatchObject({ datasetId: 'facility-test', caseVersion: 1 });
    expect(() => findDataset(root, { dataset: 'facility-test' })).toThrow();
});

test('declaration inspection preserves duplicate identity validation rather than inventing a usable Case', () => {
    const p = authored(), file = join(p.directory, 'cases.ts'), original = readFileSync(file, 'utf8');
    writeFileSync(file, original.replace('id: "FM-002"', 'id: "FM-001"'));
    expect(() => discover(p.root)).toThrow(/Duplicate Case|pairing/);
});

test('discovery uses only the original registered directory rule and never follows a linked Dataset folder', () => {
    const root = mkdtempSync(join(tmpdir(), 'eval-inspect-root-')), directory = join(root, 'agent-eval/src/datasets');
    mkdirSync(directory, { recursive: true }); symlinkSync(fixtureDirectory, join(directory, 'linked'), 'junction');
    cpSync(fixtureDirectory, join(directory, 'unregistered/nested'), { recursive: true });
    expect(discover(root)).toEqual([]);
});

test('Case inspection preserves original requirements and identifies missing execution materials without making a runnable Dataset', () => {
    expect(inspect).toBeFunction();
    const p = authored(), declared = discover(p.root).find(item => item.caseId === 'FM-001')!;
    const result = inspect(p.root, declared.datasetId, declared.caseId);
    expect(result.declaration.task).toEqual(declared.task);
    expect(result.declaration.gold).toEqual(declared.gold);
    expect(result.gaps.some((gap: { reason: string }) => gap.reason === 'missing')).toBe(true);
    expect(result.conditions.gaps).toEqual(result.gaps);
    expect(() => findDataset(p.root, { dataset: declared.datasetId })).toThrow();
    expect(existsSync(join(p.root, 'agent-eval/runs'))).toBe(false);
    expect(existsSync(join(p.root, 'agent-eval/records'))).toBe(false);
});

test('filling a missing material changes Case inspection conditions while preserving its declared requirements', () => {
    expect(inspect).toBeFunction();
    const p = authored(), before = inspect(p.root, 'flowmate-agent-v1', 'FM-001');
    const missing = before.gaps.find((gap: { path: string }) => gap.path.startsWith('voxel51/') && gap.path.endsWith('/content.md'))!;
    expect(missing).toBeDefined();
    const file = join(p.root, 'data/invoices', missing.path);
    mkdirSync(join(file, '..'), { recursive: true }); writeFileSync(file, 'Synthetic material supplied after inspection.');
    const after = inspect(p.root, 'flowmate-agent-v1', 'FM-001');
    expect(after.conditions).not.toEqual(before.conditions);
    expect(after.declaration.task).toEqual(before.declaration.task);
    expect(after.gaps.some((gap: { path: string }) => gap.path === missing.path)).toBe(false);
    const material = after.files.find((item: { path: string }) => item.path === missing.path)!;
    expect(Buffer.from(material.content, 'base64').toString('utf8')).toBe('Synthetic material supplied after inspection.');
});

test('legacy Case inspection distinguishes available, missing and invalid material facts', () => {
    expect(inspect).toBeFunction();
    const root = mkdtempSync(join(tmpdir(), 'eval-case-facts-')), directory = join(root, 'agent-eval/src/datasets/facility-test');
    cpSync(fixtureDirectory, directory, { recursive: true });
    const declared = discover(root).find(item => item.caseId === 'test-fields')!;
    expect(inspect(root, declared.datasetId, declared.caseId).gaps.some((gap: { reason: string }) => gap.reason === 'missing')).toBe(true);
    cpSync(join(fixtureRepo, 'data'), join(root, 'data'), { recursive: true });
    const complete = inspect(root, declared.datasetId, declared.caseId);
    expect(complete.gaps).toEqual([]);
    expect(complete.files.some((file: { path: string }) => file.path.endsWith('/content.md'))).toBe(true);
    writeFileSync(join(root, 'data/invoices/voxel51/000001/metadata.json'), '{broken');
    const invalid = inspect(root, declared.datasetId, declared.caseId);
    expect(invalid.gaps).toContainEqual({ path: 'voxel51/000001/metadata.json', reason: 'invalid' });
    expect(invalid.files.some((file: { path: string }) => file.path.endsWith('/content.md'))).toBe(true);
    expect(invalid.conditions).not.toEqual(complete.conditions);
});

test('Case inspection rejects linked invoice ancestry and does not expose the outside material', () => {
    expect(inspect).toBeFunction();
    const root = mkdtempSync(join(tmpdir(), 'eval-case-linked-')), directory = join(root, 'agent-eval/src/datasets/facility-test');
    cpSync(fixtureDirectory, directory, { recursive: true });
    mkdirSync(join(root, 'data'), { recursive: true }); symlinkSync(join(fixtureRepo, 'data/invoices'), join(root, 'data/invoices'), 'junction');
    const declared = discover(root).find(item => item.caseId === 'test-fields')!, result = inspect(root, declared.datasetId, declared.caseId);
    expect(result.files).toEqual([]);
    expect(result.gaps.some((gap: { reason: string }) => gap.reason === 'invalid')).toBe(true);
    expect(result.gaps.some((gap: { reason: string }) => gap.reason === 'missing')).toBe(false);
});

test('Case inspection rejects unknown selection and keeps missing declaration inputs as source failures', () => {
    expect(inspect).toBeFunction();
    const p = authored();
    expect(() => inspect(p.root, 'flowmate-agent-v1', 'unregistered-case')).toThrow(/Unknown registered Case/);
    unlinkSync(join(p.root, 'agent-eval/src/testing/fixtures/manual-compaction-user-history.json'));
    expect(() => inspect(p.root, 'flowmate-agent-v1', 'FM-001')).toThrow(/manual-compaction-user-history/);
});

test('strict Dataset loading also rejects a linked invoice ancestor before reading external material', () => {
    const root = mkdtempSync(join(tmpdir(), 'eval-run-linked-')), directory = join(root, 'agent-eval/src/datasets/facility-test');
    cpSync(fixtureDirectory, directory, { recursive: true });
    mkdirSync(join(root, 'data'), { recursive: true }); symlinkSync(join(fixtureRepo, 'data/invoices'), join(root, 'data/invoices'), 'junction');
    expect(() => findDataset(root, { dataset: 'facility-test' })).toThrow(/Linked/);
});

test('changed static declaration input is reread instead of reusing the previously imported JSON', () => {
    const p = authored(), before = inspect(p.root, 'flowmate-agent-v1', 'FM-024');
    const file = join(p.root, 'agent-eval/src/testing/fixtures/manual-compaction-user-history.json');
    const turns = JSON.parse(readFileSync(file, 'utf8'));
    turns[0].content += ' Synthetic updated user instruction.';
    writeFileSync(file, JSON.stringify(turns));
    const after = inspect(p.root, 'flowmate-agent-v1', 'FM-024');
    expect(JSON.stringify(after.declaration.task).includes('Synthetic updated user instruction.')).toBe(true);
    expect(after.conditions).not.toEqual(before.conditions);
});
