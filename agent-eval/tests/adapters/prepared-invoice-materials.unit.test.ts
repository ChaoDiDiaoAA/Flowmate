import { expect, test } from 'bun:test';
import { mkdirSync, readFileSync, renameSync, symlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createHash } from 'node:crypto';
import { mkdtempSync } from '../../../tests/support/resources.ts';
import { readPreparedInvoices } from '../../src/adapters/prepared-invoice-materials.ts';
import type { AgentTrial } from '../../src/adapters/agent.ts';

function fixture(pdf = false) {
    const root = mkdtempSync(join(tmpdir(), 'prepared-invoice-boundary-')), sample = 'synthetic';
    const directory = join(root, 'materials', sample); mkdirSync(directory, { recursive: true });
    const text = pdf ? [1, 2, 3].map(page => `## 原件第${page}页（共3页）\nSynthetic page ${page}\n`).join('\n') : 'Synthetic local note.';
    const original = pdf ? readFileSync(new URL('../../../tests/fixtures/eval-prepared-invoice/three-pages.pdf', import.meta.url)) : Buffer.from(text);
    writeFileSync(join(directory, 'source.md'), text); if (pdf) writeFileSync(join(directory, 'original.pdf'), original);
    const hash = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex');
    const material = { source: 'local-text' as const, sample, file: 'source.md', sha256: hash(Buffer.from(text)), originalSha256: hash(original), ...(pdf ? { originalFile: 'original.pdf' } : {}) };
    const trial: AgentTrial = { identity: { executionId: 'synthetic', trialId: 'synthetic', caseId: 'synthetic', caseVersion: 1 }, directory: join(root, 'trial'),
        input: { prompt: 'Read the synthetic material.', materials: [{ sample, file: 'source.md', text }] }, requires: ['agent', 'invoice', 'workspace'],
        invoiceSource: { root, materials: [material] }, configuration: {} };
    return { root, directory, trial, material };
}

test('prepared materials preserve declared PDF page boundaries and reject changed bytes or projection', () => {
    const f = fixture(true);
    expect(readPreparedInvoices(f.trial).invoices[0]!.pages.map(page => page.page)).toEqual([1, 2, 3]);
    f.trial.input.materials[0]!.text += ' changed';
    expect(() => readPreparedInvoices(f.trial)).toThrow('declared source');
    f.trial.input.materials[0]!.text = readFileSync(join(f.directory, 'source.md'), 'utf8');
    writeFileSync(join(f.directory, 'original.pdf'), 'changed');
    expect(() => readPreparedInvoices(f.trial)).toThrow('declared source');
});

test('mixed invoice notes remain visible data and do not create an extra invoice', () => {
    const f = fixture();
    f.trial.invoiceSource!.materials.push({ source: 'voxel51', sample: '000001', file: 'content.json', sha256: 'a'.repeat(64), originalSha256: 'b'.repeat(64) });
    expect(readPreparedInvoices(f.trial)).toEqual({ invoices: [], attachments: f.trial.input.materials });
});

test('material junctions inside the source boundary are rejected before copying their bytes', () => {
    const f = fixture(), original = join(f.root, 'original-materials');
    renameSync(join(f.root, 'materials'), original);
    symlinkSync(original, join(f.root, 'materials'), process.platform === 'win32' ? 'junction' : 'dir');
    expect(() => readPreparedInvoices(f.trial)).toThrow('link');
});
