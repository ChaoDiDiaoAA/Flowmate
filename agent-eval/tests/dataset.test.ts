import { afterEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { loadCases, projectCaseInput, selectCases } from '../src/datasets/load.ts';

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe('P1 dataset loading', () => {
  test('loads unique v1 cases and selects fixture/live without mixing modes', () => {
    const cases = loadCases(new URL('../stage-evals/P1/v1/cases.json', import.meta.url));
    expect(cases).toHaveLength(8);
    expect(new Set(cases.map((item) => `${item.id}/${item.version}`)).size).toBe(8);
    expect(selectCases(cases, 'P1', 'fixture')).toHaveLength(7);
    expect(selectCases(cases, 'P1', 'live').map((item) => item.id)).toEqual(['provider-invoice-text']);
  });

  test('projects only goal and readable document contents', () => {
    const root = mkdtempSync(join(tmpdir(), 'flowmate-eval-dataset-'));
    roots.push(root);
    mkdirSync(join(root, 'fixtures'));
    writeFileSync(join(root, 'fixtures', 'input.txt'), 'visible input', 'utf8');
    const projected = projectCaseInput({
      id: 'sample', version: 1, name: 'sample', stage: 'P1', capability: 'provider',
      related_capabilities: [], eval_types: ['F'], tags: [], split: 'development',
      source: { kind: 'hand-authored', record: 'sample', group: 'sample' },
      input: { goal: 'do it', documents: ['fixtures/input.txt'], setup: { secret: 'controller-only' } },
      expected: { product_terminal: 'completed', error_code: null, evidence_required: [], checks: [] },
      grader: { name: 'p1-provider-mechanism', version: 1 },
      review: { status: 'pending', reviewer: null, reviewed_at: null, evidence: [], limitations: [] },
    }, root);
    expect(projected.goal).toBe('do it');
    expect(projected.text).toContain('visible input');
    expect(JSON.stringify(projected)).not.toContain('controller-only');
  });
});
