import { expect, test } from 'bun:test';
import { invoiceHeaderFields, invoiceLineFields } from '@flowmate/contracts';
import { findDataset } from '../../src/execution/runner.ts';
import { REPO_ROOT, resolveCase } from '../../src/dataset-loader/local.ts';
import { decodeFile } from '../../src/dataset-loader/flat.ts';
import { evaluateAll } from '../../src/scoring/evaluate.ts';
import { deriveResearchCounts, unavailableResearchCounts } from '../../src/scoring/research-judgment.ts';
import { observed } from '../support/fixtures.ts';

// Transcribed from source000005, independently of the Gold/score implementation.
const rows = [
    { description: 'Microsoft Xbox One 1 - 500 GB Console - Black w/ Controller & Power Supply GOOD', quantity: '1', unit: 'each', unitPrice: '175', netAmount: '175', taxRate: '10', totalAmount: '192.50' },
    { description: 'Nintendo DSOriginal NTR-001 Console - Camouflage - Tested Works', quantity: '3', unit: 'each', unitPrice: '0.99', netAmount: '2.97', taxRate: '10', totalAmount: '3.27' },
    { description: 'Nintendo 2DS Console Blue Japan model Combine Shipping available 2', quantity: '5', unit: 'each', unitPrice: '54.99', netAmount: '274.95', taxRate: '10', totalAmount: '302.45' }
];
test('FM-045 independent correct lines pass while missing normalization, wrong tax units and missing rows fail', async () => {
    const data = findDataset(REPO_ROOT, { dataset: 'flowmate-badcase-business-v1' }), task = data.cases[0]!;
    const result = observed(), projected = resolveCase(data, task, REPO_ROOT).projected;
    const field = (value: string | null) => ({ raw: value, normalized: value, state: value === null ? 'missing' : 'present', alternatives: [], sources: [] });
    const values = { fields: Object.fromEntries(invoiceHeaderFields.map(key => [key, field(null)])),
        lines: rows.map(row => Object.fromEntries(invoiceLineFields.map(key => [key, field(row[key as keyof typeof row] ?? null)]))) };
    result.evidence['candidate-line-items'] = { present: true, actual: rows, source: 'Independent reference prediction from original invoice table' };
    result.evidence['candidate-values'] = { present: true, actual: values, source: 'Controlled complete field-state reference' };
    const grade = async () => (await evaluateAll({ task, result, projected, judge: null }, [{ metric: 'line-items', required: true }])).scores.find(s => s.metricId === 'line-items')!;
    expect(await grade()).toMatchObject({ status: 'PASS', actual: { tp: 3, fp: 0, fn: 0 } });
    values.lines[0]!.quantity!.normalized = null; expect((await grade()).status).toBe('FAIL');
    values.lines[0]!.quantity!.normalized = '1';
    const wrong = structuredClone(rows); wrong[0]!.taxRate = '0.1'; result.evidence['candidate-line-items'].actual = wrong;
    expect((await grade()).status).toBe('FAIL');
    result.evidence['candidate-line-items'].actual = rows.slice(0, 2); values.lines = values.lines.slice(0, 2);
    expect((await grade()).status).toBe('FAIL');
});

test('FM-051 source-bound reference Report covers twelve required facts; no Report preserves twelve omissions', () => {
    const data = findDataset(REPO_ROOT, { dataset: 'flowmate-badcase-research-v1' }), task = data.cases[0]!;
    if (!('contract' in task) || !task.expected.research) throw Error('Research Gold missing');
    const facts = ['Landsat 9 quantitatively characterizes global land-surface change.', 'Landsat 9 carries OLI-2.', 'Landsat 9 carries TIRS-2.',
        'OLI-2 measures visible, near-infrared and shortwave infrared wavelengths.', 'OLI-2 panchromatic resolution is15m.', 'OLI-2 multispectral resolution is30m.',
        'TIRS measures two thermal bands.', 'TIRS thermal native resolution is100m.', 'TIRS100m observations are resampled to a30m grid.',
        'Landsat 9 single-satellite nominal repeat period is16days.', 'Level-2 products include surface reflectance.', 'Level-2 products include surface temperature.'];
    const gold = task.expected.research, sources = [...new Set(gold.claims.flatMap(c => c.evidence.map(e => e.sample)))].map((sample, index) => {
        const text = decodeFile(data.embedded!.files[`materials/${sample}/source.md`]).bytes.toString('utf8');
        return { sourceSnapshotId: index + 1, text, modelRead: false, binding: { sourceSnapshotId: index + 1, sample, file: 'source.md' } };
    });
    const links = gold.claims.map((claim, index) => {
        const evidence = claim.evidence[0]!, source = sources.find(s => s.binding.sample === evidence.sample)!;
        expect(source.text.slice(evidence.start, evidence.end)).toBe(evidence.quote);
        return { key: 'reference-citation-' + index, claimId: null, evidenceIndex: null, relation: 'supports', valid: true, display: evidence.quote,
            ref: { researchId: 1, planId: 1, revision: 1, runId: 1, toolCallId: 1, sourceSnapshotId: source.sourceSnapshotId,
                locator: { start: evidence.start, end: evidence.end, quote: evidence.quote } } };
    });
    const frame = { contract: 'flowmate-research-frame/v1', complete: true, reportId: 1,
        blocks: facts.map((text, index) => ({ kind: 'report-section', key: 'reference-section-' + index, claimId: null, text })), links,
        integrity: { valid: true, issues: [], links: [], sourceBindings: sources.map(s => s.binding) }, gold, sources, rule: 'Source-bound engineering reference, not an actual model run.' };
    const proof = { atoms: facts.map((text, block) => ({ block, start: 0, length: text.length, correct: 1, needsCitation: true, covered: 1, gold: block + 1, matchUncertain: false })),
        links: facts.map((_, atom) => ({ atom, state: 1 })), chains: [] };
    expect(deriveResearchCounts(frame, proof).DR02!.row).toEqual([12, 12, 0]);
    expect(deriveResearchCounts(frame, proof).DR05!.row).toEqual([12, 12, 0]);
    expect(unavailableResearchCounts({ ...frame, reportId: null, blocks: [], links: [] }).DR02).toMatchObject({ row: [0, 12, 0], knownFailure: true });
});
