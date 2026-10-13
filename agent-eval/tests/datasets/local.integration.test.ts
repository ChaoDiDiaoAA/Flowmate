import { mkdtempSync } from '../../../tests/support/resources.ts';
import { test, expect } from 'bun:test';
import { writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { dataset, task, fixtureRepo } from '../support/fixtures.ts';
import { caseSchema, loadDataset, resolveCase, selectCases } from '../../src/dataset-loader/local.ts';
test('independent facility dataset resolves synthetic materials and unique smoke references', () => {
    expect(dataset.cases).toHaveLength(3);
    expect(selectCases(dataset, 'smoke')).toHaveLength(2);
    for (const c of dataset.cases) {
        const resolved = resolveCase(dataset, c, fixtureRepo);
        expect(resolved.projected.materials.length).toBe(c.input.materials.length);
        for (const m of resolved.projected.materials) expect(m.text.length).toBeGreaterThan(0);
        expect(c.review.status).toBe('pending');
    }
    expect(dataset.cases.some(c => !c.input.materials.length && !c.expected.reference)).toBe(true);
    const materialIds = dataset.cases.flatMap(c => c.input.materials.map(m => m.originalSha256));
    expect(new Set(materialIds).size).toBe(materialIds.length);
});
test('strict Case contract rejects extra fields, missing standards, bad materials and leakage', () => {
    expect(() => caseSchema.parse({ ...task, stage: 'P1' })).toThrow();
    expect(() => caseSchema.parse({ ...task, expected: { ...task.expected, success: [] } })).toThrow();
    const corrupt = structuredClone(task);
    corrupt.input.materials[0]!.sha256 = '0'.repeat(64);
    expect(() => resolveCase(dataset, corrupt, fixtureRepo)).toThrow('hash');
    const root = mkdtempSync(join(tmpdir(), 'flowmate-dataset-'));
    mkdirSync(join(root, 'cases'));
    const other = { ...task, id: 'duplicate-source' };
    writeFileSync(join(root, 'cases', task.id + '.json'), JSON.stringify(task));
    writeFileSync(join(root, 'cases', other.id + '.json'), JSON.stringify(other));
    const manifest = { ...dataset.manifest, members: ['cases/' + task.id + '.json', 'cases/' + other.id + '.json'], smoke: [task.id] };
    writeFileSync(join(root, 'dataset.json'), JSON.stringify(manifest));
    expect(() => loadDataset(root)).toThrow('required Judge Case references');
    manifest.scoring = { ...manifest.scoring, judges: [{ id: 'answer-relevance', required: false }] };
    writeFileSync(join(root, 'dataset.json'), JSON.stringify(manifest));
    expect(() => loadDataset(root)).toThrow('leakage');
});
