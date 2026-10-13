import { dataset } from '../support/fixtures.ts';
import { test, expect } from 'bun:test';
import { resolve } from 'node:path';
import { loadDataset } from '../../src/dataset-loader/local.ts';
import * as scoring from '../../src/scoring/evaluate.ts';
import { HELP } from '../../src/cli.ts';
test('facility selection references unique bodies, independently of business drafts', () => {
    expect(dataset.cases).toHaveLength(3);
    expect(dataset.manifest.smoke).toHaveLength(2);
    expect(new Set(dataset.cases.map(c => c.id)).size).toBe(3);
});

test('shared scoring exposes an async registry pipeline', () => {
    expect(typeof (scoring as any).evaluateAll).toBe('function');
});
test('public help removes stage and model simulation modes', () => {
    expect(HELP).not.toContain('--stage');
    expect(HELP).not.toMatch(/--mode(?:\s|$)/);
    expect(HELP).toContain('--selection smoke|holdout|full');
});
