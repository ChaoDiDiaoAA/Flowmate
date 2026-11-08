import { expect, test } from 'bun:test';
import { assessCases, passingAssertionCount } from './report.ts';

const selected = [{ id: 'save', version: 1, checks: ['committed'] }];
const result = { id: 'save', version: 1, state: 'passed', checks: [{ id: 'committed', expected: 1, actual: 1 }] };

test('requires one trustworthy record of every critical assertion', () => {
  expect(assessCases(selected, [result]).ok).toBe(true);
  expect(assessCases(selected, []).ok).toBe(false);
  expect(assessCases(selected, [result, result]).ok).toBe(false);
  expect(assessCases(selected, [{ ...result, version: 2 }]).ok).toBe(false);
  expect(assessCases(selected, [{ ...result, checks: [{ id: 'committed', expected: 1, actual: 2 }] }]).ok).toBe(false);
  expect(assessCases(selected, [{ ...result, checks: [result.checks[0], result.checks[0]] }]).ok).toBe(false);
  expect(assessCases(selected, [{ ...result, checks: [{ id: 'committed' }] }]).ok).toBe(false);
  expect(assessCases(selected, [{ ...result, state: 'failed' }]).ok).toBe(false);
});

test('rejects a skipped, duplicate, or failed regression instead of counting a report as a pass', () => {
  const success = '<testcase name="the regression" assertions="4" />';
  expect(passingAssertionCount(success, 'the regression')).toBe(4);
  expect(passingAssertionCount(success + success, 'the regression')).toBe(0);
  expect(passingAssertionCount(success, 'wrong regression')).toBe(0);
  expect(passingAssertionCount('<testcase name="the regression" assertions="4"><failure /></testcase>', 'the regression')).toBe(0);
  expect(passingAssertionCount('<testcase name="the regression" assertions="0"><skipped /></testcase>', 'the regression')).toBe(0);
});
