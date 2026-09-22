import { afterEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { prepareTrial } from '../src/execution/trial.ts';
import { evaluateCase } from '../src/evaluators/mechanism.ts';
import type { CaseDefinition, CaseExecutionResult } from '../src/types.ts';

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

const sampleCase: CaseDefinition = {
  id: 'provider-sample', version: 1, name: 'sample', stage: 'P1', capability: 'provider',
  related_capabilities: [], eval_types: ['F'], tags: [], split: 'development',
  source: { kind: 'fixture', record: 'sample', group: 'sample' },
  input: { goal: 'do it', documents: [], setup: { allowed_modes: ['fixture'], fault_profile: 'none', budget_profile: 'normal' } },
  expected: {
    product_terminal: 'completed', error_code: null,
    evidence_required: ['run-query'],
    checks: [{ id: 'terminal', rule: 'terminal', required: true, hard_constraint: true, applicable_when: 'executed', pass_when: 'completed', fail_when: 'other', evidence_refs: ['run-query'], missing_evidence: 'UNJUDGEABLE' }],
  },
  grader: { name: 'p1-provider-mechanism', version: 1 },
  review: { status: 'pending', reviewer: null, reviewed_at: null, evidence: [], limitations: [] },
};

function observation(overrides: Partial<CaseExecutionResult> = {}): CaseExecutionResult {
  return {
    executed: true,
    identity: { executionId: 'exec', trialId: 'trial', caseId: sampleCase.id, caseVersion: 1, requestId: 1, runId: 1 },
    mode: 'fixture',
    input: { goal: 'do it', text: '' },
    configuration: { requestedModel: { provider: 'fixture', model: 'fixture-model' }, resolvedModel: 'fixture-model', responseModel: 'fixture-model', overrides: [] },
    terminal: 'completed', error: null, output: { text: 'ok', partial: false }, usage: { source: 'fixture', attempts: 1, complete: true },
    timeline: [], queryBeforeLateWindow: {}, queryAfterLateWindow: {}, close: { stopped: true, closed: true, errors: [] },
    evidence: { 'run-query': { present: true, actual: { status: 'completed' }, source: 'query' } },
    facilityError: null,
    ...overrides,
  };
}

describe('Trial isolation and five-state evaluation', () => {
  test('creates one isolated database and owner marker per trial', () => {
    const base = mkdtempSync(join(tmpdir(), 'flowmate-eval-trial-'));
    roots.push(base);
    const trial = prepareTrial({ baseRoot: base, executionId: 'exec-1', caseId: 'provider-sample', trialIndex: 1 });
    expect(trial.paths.databaseFile.endsWith('data\\trial-1.sqlite') || trial.paths.databaseFile.endsWith('data/trial-1.sqlite')).toBe(true);
    expect(trial.paths.root).toBe(join(base, 'provider-sample', 'trial-1'));
    expect(trial.paths.root).toStartWith(base);
    expect(trial.owner.executionId).toBe('exec-1');
  });

  test('keeps NOT_RUN, ERROR, UNJUDGEABLE, FAIL and PASS distinct', () => {
    expect(evaluateCase(sampleCase, observation({ executed: false })).status).toBe('NOT_RUN');
    expect(evaluateCase(sampleCase, observation({ facilityError: { code: 'protocol_error', message: 'bad frame' } })).status).toBe('ERROR');
    expect(evaluateCase(sampleCase, observation({ evidence: {} })).status).toBe('UNJUDGEABLE');
    expect(evaluateCase(sampleCase, observation({ terminal: 'failed' })).status).toBe('FAIL');
    const passed = evaluateCase(sampleCase, observation());
    expect(passed.status).toBe('PASS');
    expect(passed.checks).toHaveLength(1);
    expect(passed.checks[0]?.actual).toEqual({ terminal: 'completed', errorCode: null });
  });
});
