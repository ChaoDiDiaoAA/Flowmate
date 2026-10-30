import { expect, test } from 'bun:test';
import { resolveEvaluationBudgets, resolveTrialBudget } from '../../src/execution/budgets.ts';
import { parseRunConfig } from '../../src/execution/plan.ts';

test('business and research use explicit evaluation budgets without changing tool permissions', () => {
  const profiles = resolveEvaluationBudgets({});
  expect(resolveTrialBudget(['invoice'], {}, profiles)).toMatchObject({ profile: 'business', trialTimeoutMs: 600000,
    runTimeoutMs: 180000, maxModelCalls: 16, prepareTimeoutMs: 60000, captureTimeoutMs: 60000, stopGraceMs: 5000 });
  expect(resolveTrialBudget(['research'], {}, profiles)).toMatchObject({ profile: 'research', trialTimeoutMs: 900000,
    runTimeoutMs: 300000, maxModelCalls: 24 });
  expect(resolveTrialBudget(['invoice'], { budget: { maxToolCalls: 0 } }, profiles)).not.toHaveProperty('maxToolCalls');
});

test('budget environment overrides are validated before any trial starts', () => {
  const profiles = resolveEvaluationBudgets({ FLOWMATE_EVAL_BUSINESS_TRIAL_TIMEOUT_MS: '700000', FLOWMATE_EVAL_RESEARCH_MAX_MODEL_CALLS: '30' });
  expect(profiles.business.trialTimeoutMs).toBe(700000);
  expect(profiles.research.maxModelCalls).toBe(30);
  expect(() => resolveEvaluationBudgets({ FLOWMATE_EVAL_BUSINESS_RUN_TIMEOUT_MS: 'not-a-number' })).toThrow();
  expect(() => resolveEvaluationBudgets({ FLOWMATE_EVAL_RESEARCH_MAX_MODEL_CALLS: '65' })).toThrow();
});

test('explicit old timeout remains bounded while separated run and trial limits are supported', () => {
  const profiles = resolveEvaluationBudgets({});
  expect(resolveTrialBudget(['invoice'], { timeoutMs: 100 }, profiles)).toMatchObject({ trialTimeoutMs: 100, runTimeoutMs: 100 });
  const config = parseRunConfig({ timeoutMs: 300000, trialTimeoutMs: 900000, budget: { maxModelCalls: 7 } });
  expect(resolveTrialBudget(['research'], config, profiles)).toMatchObject({ trialTimeoutMs: 900000, runTimeoutMs: 300000, maxModelCalls: 7 });
});
