import { expect, test } from 'bun:test';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { discoverDatasets, REPO_ROOT, resolveCase } from '../../src/dataset-loader/local.ts';
import { findDataset, runLocal } from '../../src/execution/runner.ts';
import { flowmateAgentV1Dataset } from '../../src/datasets/cases.ts';
import { goldByCaseId } from '../../src/datasets/gold.ts';
import { reviewByCaseId } from '../../src/datasets/review.ts';

test('explicit supplemental datasets admit unambiguous references without promoting disputed task scope', () => {
    const business = findDataset(REPO_ROOT, { dataset: 'flowmate-badcase-business-v1' });
    const research = findDataset(REPO_ROOT, { dataset: 'flowmate-badcase-research-v1' });
    expect(business.cases.map(c => c.id)).toEqual(['FM-045']);
    expect(research.cases.map(c => c.id)).toEqual(['FM-051']);
    expect(business.manifest).toMatchObject({ suite: 'badcase', smoke: [] });
    const baseline = findDataset(REPO_ROOT, { dataset: 'flowmate-agent-v1' });
    expect(business.cases[0]).toEqual(baseline.cases.find(c => c.id === 'FM-045')!);
    expect(business).toHaveProperty('regressionOrigins.FM-045.0.sourceCaseId', 'FM-045');
    const projected = resolveCase(business, business.cases[0]!, REPO_ROOT).projected;
    expect(JSON.stringify(projected)).not.toContain('BC-12');
    expect(JSON.stringify(projected)).not.toContain('sourceExecutionId');
});

test('baseline discovery and default partitions stay at fifty plus twelve and ten plus four', () => {
    const baseline = discoverDatasets(join(REPO_ROOT, 'agent-eval/src/datasets'), REPO_ROOT);
    expect(baseline.map(d => [d.manifest.id, d.cases.length, d.manifest.smoke.length])).toEqual([
        ['flowmate-agent-v1', 50, 10], ['flowmate-research-v1', 12, 4]
    ]);
});

test('supplemental smoke and holdout are rejected before preparing a model or creating an Execution', async () => {
    const data = findDataset(REPO_ROOT, { dataset: 'flowmate-badcase-business-v1' }); let preparations = 0;
    for (const selection of ['smoke', 'holdout'] as const) await expect(runLocal(REPO_ROOT, { dataset: data, selection, backend: 'local', judge: 'off' }, {
        env: {}, kernel: { readiness: () => ({ ready: true, reason: 'controlled' }), prepare: async () => { preparations++; throw Error('must not prepare'); } }
    })).rejects.toThrow('full');
    expect(preparations).toBe(0);
});

test('supplemental authoring rejects changed reference identities and accepts a separate globally new case', () => {
    const root = mkdtempSync(join(tmpdir(), 'badcase-authoring-'));
    const source = structuredClone(flowmateAgentV1Dataset.cases[0]!);
    const origin = { batch: 'controlled-batch', issueId: 'BC-1', sourceExecutionId: 'original', sourceTrialId: 'original-trial',
        sourceCaseId: 'FM-001', sourceCaseVersion: 1, metricIds: ['reference-fields'],
        verification: { kind: 'engineering', reviewer: 'controlled test', at: '2026-10-14T00:00:00Z', basis: 'Independent controlled reference test.' } };
    const write = (c: typeof source) => {
        writeFileSync(join(root, 'cases.ts'), 'export const flowmateBadcaseDataset=' + JSON.stringify({ version: 'v1', suite: 'badcase', cases: [c], regressionOrigins: { [c.id]: [origin] } }));
        writeFileSync(join(root, 'gold.ts'), 'export const goldByCaseId=' + JSON.stringify({ [c.id]: goldByCaseId['FM-001'] }));
        writeFileSync(join(root, 'review.ts'), 'export const reviewByCaseId=' + JSON.stringify({ [c.id]: reviewByCaseId['FM-001'] }));
    };
    try {
        source.input.prompt = 'A changed task must not keep a referenced Case identity.'; write(source);
        expect(() => discoverDatasets(root, REPO_ROOT)).toThrow('Referenced Case');
        source.id = 'FM-063'; write(source);
        const data = discoverDatasets(root, REPO_ROOT); expect(data[0]!.cases.map(c => c.id)).toEqual(['FM-063']);
        writeFileSync(join(root, 'gold.ts'), 'export const goldByCaseId={"FM-063":undefined}');
        expect(() => discoverDatasets(root, REPO_ROOT)).toThrow('pairing'); write(source);
        writeFileSync(join(root, 'cases.ts'), 'export const flowmateBadcaseDataset=' + JSON.stringify({ version: 'v1', suite: 'badcase', cases: [source], regressionOrigins: { [source.id]: [{ ...origin, metricIds: ['invented-score'] }] } }));
        expect(() => discoverDatasets(root, REPO_ROOT)).toThrow('Unselected regression metric'); write(source);
        source.id = 'FM-065'; write(source);
        expect(() => discoverDatasets(root, REPO_ROOT)).toThrow('consecutive');
        writeFileSync(join(root, 'cases.ts'), 'export const flowmateBadcaseDataset=' + JSON.stringify({ version: 'v1', suite: 'badcase', cases: [], regressionOrigins: {} }));
        writeFileSync(join(root, 'gold.ts'), 'export const goldByCaseId={}'); writeFileSync(join(root, 'review.ts'), 'export const reviewByCaseId={}');
        expect(discoverDatasets(root, REPO_ROOT)).toEqual([]);
    } finally { rmSync(root, { recursive: true, force: true }); }
});
