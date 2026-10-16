import { expect, test } from 'bun:test';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import * as runner from '../../src/execution/runner.ts';
import { dataset, fixtureDirectory, fixtureRepo } from '../support/fixtures.ts';

const create = Reflect.get(runner, 'createEvaluationPlan') as ((repo: string, input: unknown) => unknown) | undefined;
const same = Reflect.get(runner, 'sameEvaluationPlan') as ((left: unknown, right: unknown) => boolean) | undefined;
const selection = { datasetId: 'facility-test', selection: 'smoke', repeat: 2, judge: 'off', configuration: {} };

test('preview selects real members, retains required unmeasured semantics and creates no run or model runtime', () => {
  mkdirSync(join(fixtureRepo, 'agent-eval/configs'), { recursive: true });
  writeFileSync(join(fixtureRepo, 'agent-eval/configs/.env'), 'UNSUPPORTED_VARIABLE=synthetic-do-not-read\n');
  const plan = create?.(fixtureRepo, selection);
  expect(plan).toMatchObject({ summary: { caseCount: 2, total: 4, judgeMaxGenerations: 0,
    unmeasuredRequiredCaseIds: ['test-clarification'], datasets: [{ id: 'facility-test', caseCount: 2, total: 4,
      cases: [{ caseId: 'test-fields' }, { caseId: 'test-clarification' }] }] } });
  expect(same?.(plan, create?.(fixtureRepo, selection))).toBe(true);
  expect(existsSync(join(fixtureRepo, 'agent-eval/runs'))).toBe(false);
});

test('required mode on a truly deterministic selection has zero Judge demand', () => {
  const file = join(fixtureDirectory, 'dataset.json'), before = readFileSync(file, 'utf8');
  try {
    writeFileSync(file, JSON.stringify({ ...dataset.manifest, scoring: { ...dataset.manifest.scoring, judges: [] } }));
    expect(create?.(fixtureRepo, { ...selection, selection: 'case', caseId: 'test-lines', judge: 'required', repeat: 3 }))
      .toMatchObject({ summary: { caseCount: 1, total: 3, judgeMaxGenerations: 0, judgeRequired: false,
        datasets: [{ cases: [{ caseId: 'test-lines', judge: { applicable: false, enabled: false } }] }] } });
  } finally { writeFileSync(file, before); }
});

test('a Case requirement changed without a version bump invalidates the old preview', () => {
  const file = join(fixtureDirectory, 'cases/test-fields.json'), before = readFileSync(file, 'utf8');
  const first = create?.(fixtureRepo, selection);
  try {
    const changed = JSON.parse(before); changed.expected.success = ['Read another required synthetic field.'];
    writeFileSync(file, JSON.stringify(changed));
    expect(same?.(first, create?.(fixtureRepo, selection))).toBe(false);
  } finally { writeFileSync(file, before); }
});

test('same-length material edits invalidate the old preview by actual content', () => {
  const file = join(fixtureRepo, 'data/invoices/voxel51/000001/content.md'), before = readFileSync(file, 'utf8');
  const first = create?.(fixtureRepo, selection);
  try {
    writeFileSync(file, before.replace('TEST-001', 'TEST-009'));
    expect(same?.(first, create?.(fixtureRepo, selection))).toBe(false);
  } finally { writeFileSync(file, before); }
});

test('a declared Skill guardrail retains its original metric identity in the desktop preview', () => {
  const file = join(fixtureDirectory, 'cases/test-fields.json'), before = readFileSync(file, 'utf8');
  try {
    const changed = JSON.parse(before); changed.expected.requiredSkills = ['eval-date-guide-long']; writeFileSync(file, JSON.stringify(changed));
    const plan = runner.createEvaluationPlan(fixtureRepo, selection), task = plan.summary.datasets[0]!.cases.find(item => item.caseId === 'test-fields');
    expect(task?.evaluators).toEqual(expect.arrayContaining([expect.objectContaining({ evaluatorId: 'fact-check', outputs: expect.arrayContaining([
      expect.objectContaining({ metricId: 'fact-check/required-skills', category: 'guardrail', applicable: true, required: true }),
    ]) })]));
  } finally { writeFileSync(file, before); }
});
