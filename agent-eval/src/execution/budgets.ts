import { EvaluationBudgetProfilesSchema, ResolvedEvaluationBudgetSchema, type EvaluationBudgetProfiles } from '../../../packages/contracts/src/evaluation-budget.ts';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { parseEnv } from 'node:util';

/** Preview reads budget fields without requiring unrelated model credentials to be valid. */
export function readEvaluationBudgets(repo: string, env: NodeJS.ProcessEnv = process.env) {
  const file = join(repo, 'agent-eval/configs/.env');
  return resolveEvaluationBudgets({ ...(existsSync(file) ? parseEnv(readFileSync(file, 'utf8')) : {}), ...env });
}

export function resolveEvaluationBudgets(env: NodeJS.ProcessEnv): EvaluationBudgetProfiles {
  const profile = (kind: 'BUSINESS' | 'RESEARCH', defaults: [number, number, number]) => ({
    trialTimeoutMs: Number(env['FLOWMATE_EVAL_' + kind + '_TRIAL_TIMEOUT_MS'] ?? defaults[0]),
    runTimeoutMs: Number(env['FLOWMATE_EVAL_' + kind + '_RUN_TIMEOUT_MS'] ?? defaults[1]),
    maxModelCalls: Number(env['FLOWMATE_EVAL_' + kind + '_MAX_MODEL_CALLS'] ?? defaults[2]),
    prepareTimeoutMs: 60000, captureTimeoutMs: 60000, stopGraceMs: 5000,
  });
  return EvaluationBudgetProfilesSchema.parse({
    business: profile('BUSINESS', [600000, 180000, 16]), research: profile('RESEARCH', [900000, 300000, 24]),
  });
}

export function resolveTrialBudget(requires: readonly string[], configuration: {
  timeoutMs?: number; trialTimeoutMs?: number; stopGraceMs?: number; budget?: { maxModelCalls?: number; maxToolCalls?: number; toolTimeoutMs?: number };
}, profiles: EvaluationBudgetProfiles) {
  const profile = requires.includes('research') ? 'research' : 'business', selected = profiles[profile];
  const legacyTimeout = configuration.trialTimeoutMs === undefined ? configuration.timeoutMs : undefined;
  return ResolvedEvaluationBudgetSchema.parse({ ...selected, profile,
    prepareTimeoutMs: Math.min(selected.prepareTimeoutMs, legacyTimeout ?? selected.prepareTimeoutMs),
    captureTimeoutMs: Math.min(selected.captureTimeoutMs, legacyTimeout ?? selected.captureTimeoutMs),
    // An explicit legacy timeout remains a whole-task bound unless the caller supplies a separate Trial limit.
    trialTimeoutMs: configuration.trialTimeoutMs ?? configuration.timeoutMs ?? selected.trialTimeoutMs,
    runTimeoutMs: configuration.timeoutMs ?? selected.runTimeoutMs,
    maxModelCalls: configuration.budget?.maxModelCalls ?? selected.maxModelCalls,
    stopGraceMs: configuration.stopGraceMs ?? selected.stopGraceMs,
    source: configuration.timeoutMs !== undefined || configuration.trialTimeoutMs !== undefined ||
      configuration.budget?.maxModelCalls !== undefined || configuration.stopGraceMs !== undefined ? 'explicit-override' : 'evaluation-profile',
  });
}
