import { expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { discoverDatasets, REPO_ROOT } from '../../src/dataset-loader/local.ts';
import { findDataset } from '../../src/execution/plan.ts';

test('removed supplemental registrations cannot start and do not replace the original baseline Cases', () => {
    for (const id of ['flowmate-badcase-business-v1', 'flowmate-badcase-research-v1']) expect(() => findDataset(REPO_ROOT, { dataset: id })).toThrow();
    const baseline = discoverDatasets(join(REPO_ROOT, 'agent-eval/src/datasets'), REPO_ROOT);
    expect(baseline.map(d => [d.manifest.id, d.cases.length, d.manifest.smoke.length])).toEqual([
        ['flowmate-agent-v1', 50, 5], ['flowmate-research-v1', 12, 2]
    ]);
    expect(baseline.flatMap(d => d.cases).filter(c => ['FM-045', 'FM-051'].includes(c.id))).toHaveLength(2);
});
test('candidate JSON collections are not executable dataset discovery roots', () => {
    const root = mkdtempSync(join(tmpdir(), 'candidate-discovery-'));
    try {
        for (const kind of ['gold', 'bad', 'regression']) {
            const directory = join(root, kind + '-candidates'); mkdirSync(directory);
            writeFileSync(join(directory, 'dataset.json'), '{"id":"not-published"}');
        }
        expect(discoverDatasets(root, root)).toEqual([]);
    } finally { rmSync(root, { recursive: true, force: true }); }
});
