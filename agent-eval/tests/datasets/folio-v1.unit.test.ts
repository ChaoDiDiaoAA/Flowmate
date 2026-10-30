import { expect, test } from 'bun:test';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

const root = join(import.meta.dir, '../../src/datasets');
test('baseline declarations remain three modules and old supplemental code is absent', () => {
  expect(readdirSync(root, { withFileTypes: true }).filter(entry => entry.isFile()).map(entry => entry.name).sort()).toEqual(['cases.ts', 'gold.ts', 'review.ts']);
  for (const name of ['cases.ts', 'gold.ts', 'members.ts', 'review.ts']) expect(existsSync(join(root, 'badcase', name))).toBe(false);
});
test('all audited cases are short English declarations with independent gold', async () => {
  expect(existsSync(join(root, 'cases.ts'))).toBe(true);
  const { flowmateAgentV1Dataset: dataset } = await import('../../src/datasets/cases.ts');
  const { goldByCaseId: gold } = await import('../../src/datasets/gold.ts');
  const { reviewByCaseId: review } = await import('../../src/datasets/review.ts');
  const { scenariosByName } = await import('../../src/testing/scenarios.ts');
  expect(dataset.version).toBe('v1');
  expect(dataset.cases).toHaveLength(62);
  expect(new Set(dataset.cases.map((c: any) => c.id)).size).toBe(62);
  expect(dataset.cases.every(c => Number(c.id.slice(3)) <= 62)).toBe(true);
  for (const c of dataset.cases) {
    expect(JSON.stringify(c)).not.toMatch(/\p{Script=Han}/u);
    expect(c.input.prompt.length).toBeGreaterThan(15);
    expect(c.expected.success.length).toBeGreaterThan(0);
    expect(c.expected.failure.length).toBeGreaterThan(0);
    expect(c.risks.length).toBeGreaterThan(0);
    expect(gold[c.id]).toBeDefined();
    expect(review[c.id].humanReview).toBe('pending');
    expect(scenariosByName[c.input.fixture.name]).toBeDefined();
  }
  const source = readFileSync(join(root, 'cases.ts'), 'utf8');
  expect(source).not.toMatch(/\p{Script=Han}/u);
  const declarations = source.split('    id: ').slice(1);
  expect(declarations.every(c => c.startsWith('"FM-025"') || c.split('\n').length <= 40)).toBe(true);
  expect(JSON.stringify({ dataset, gold, review })).not.toMatch(/"[^" ]*(?:hash|fingerprint|digest)[^" ]*"\s*:|\b[a-f0-9]{64}\b/i);
});

test('all declarations have matching contiguous Harness groups, without renumbering', async () => {
  const { flowmateAgentV1Dataset: dataset } = await import('../../src/datasets/cases.ts');
  const categories = ['task','tools','context','memory','compaction','skills','extensions','subagents','runtime','safety','research'];
  expect([...new Set<string>(dataset.cases.map(c => c.category))]).toEqual(categories);
  for (const module of ['cases.ts','gold.ts','review.ts']) {
    const source = readFileSync(join(root,module),'utf8');
    const headings = [...source.matchAll(/\/\/ ── (\w+):/g)].map(m => m[1]!.toLowerCase());
    expect(headings).toEqual(categories);
    const ids = [...source.matchAll(/(?:id: |^  )"(FM-\d{3})"/gm)].map(m => m[1]);
    expect(ids).toEqual(dataset.cases.map(c => c.id));
  }
});
