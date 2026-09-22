import { afterAll, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadCases, selectCases } from '../src/datasets/load.ts';
import { executeCase } from '../src/execution/execute-case.ts';
import { evaluateCase } from '../src/evaluators/mechanism.ts';

const datasetUrl = new URL('../stage-evals/P1/v1/cases.json', import.meta.url);
const datasetRoot = dirname(fileURLToPath(datasetUrl));
const trialRoot = mkdtempSync(join(tmpdir(), 'flowmate-eval-fixture-'));

afterAll(() => rmSync(trialRoot, { recursive: true, force: true }));

describe('P1 Fixture cases through the product protocol', () => {
  const cases = selectCases(loadCases(datasetUrl), 'P1', 'fixture');
  for (const [index, caseData] of cases.entries()) {
    test(caseData.id, async () => {
      const result = await executeCase({
        caseData,
        mode: 'fixture',
        executionId: 'fixture-test',
        trialIndex: index + 1,
        trialBaseRoot: trialRoot,
        datasetRoot,
        controlFile: join(datasetRoot, 'fixtures', 'control.json'),
      });
      const grade = evaluateCase(caseData, result);
      expect(result.facilityError).toBeNull();
      expect(grade.status).toBe('PASS');
    }, 20_000);
  }
});
