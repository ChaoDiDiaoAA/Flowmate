import { afterEach, expect, test } from 'bun:test';
import { mkdtempSync, mkdirSync, readdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { reportPath } from '../../src/reports/store.ts';
import { addFeedback } from '../../src/review/local.ts';
import { dataset } from '../support/fixtures.ts';

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });
function root() { const value = mkdtempSync(join(tmpdir(), 'eval-paths-')); roots.push(value); return value; }
function saved(repo: string, path: string) {
    const directory = join(repo, 'agent-eval', path); mkdirSync(directory, { recursive: true });
    const file = join(directory, path.startsWith('calibration-runs/') || path.startsWith('runs/calibration/') ? 'summary.json' : 'report.json');
    writeFileSync(file, '{}'); return file;
}

test('ID lookup reaches each workload and new calibration without confusing report kinds', () => {
    const repo = root();
    for (const scope of ['business', 'research', 'mixed', 'calibration']) {
        const expected = saved(repo, `runs/${scope}/sample-${scope}`);
        expect(reportPath(repo, `sample-${scope}`)).toBe(expected);
    }
});

test('legacy flat reports and calibration-runs remain readable by their original ID', () => {
    const repo = root();
    const flat = saved(repo, 'runs/old-agent'), calibration = saved(repo, 'calibration-runs/old-judge');
    expect(reportPath(repo, 'old-agent')).toBe(flat);
    expect(reportPath(repo, 'old-judge')).toBe(calibration);
});

test('duplicate IDs across old and new directories fail rather than choosing an arbitrary report', () => {
    const repo = root(); saved(repo, 'runs/same-id'); saved(repo, 'runs/business/same-id');
    expect(() => reportPath(repo, 'same-id')).toThrow(/conflict|duplicate/i);
});

test('lookup rejects a linked workload directory and traversal without reading outside reports', () => {
    const repo = root(), outside = root(); saved(outside, 'runs/foreign');
    mkdirSync(join(repo, 'agent-eval/runs'), { recursive: true });
    symlinkSync(join(outside, 'agent-eval/runs'), join(repo, 'agent-eval/runs/research'), 'junction');
    expect(() => reportPath(repo, 'foreign')).toThrow(/real|link|escape/i);
    expect(() => reportPath(repo, '../foreign')).toThrow('Invalid execution ID');
});

test('Case review creation rejects a linked result root before creating any outside directory', () => {
    const repo = root(), outside = root(); mkdirSync(join(repo, 'agent-eval'));
    symlinkSync(outside, join(repo, 'agent-eval/runs'), 'junction');
    expect(() => addFeedback(repo, { dataset, caseId: dataset.cases[0]!.id, reviewer: 'synthetic', verdict: 'good', note: 'controlled test' })).toThrow(/link|real|escape/i);
    expect(readdirSync(outside)).toEqual([]);
});
