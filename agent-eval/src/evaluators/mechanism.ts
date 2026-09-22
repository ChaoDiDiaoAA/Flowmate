import type { CaseCheck, CaseDefinition, CaseExecutionResult, CheckResult, EvaluationResult, GradeStatus } from '../types.ts';

function actualTerminal(result: CaseExecutionResult): { terminal: CaseExecutionResult['terminal']; errorCode: string | null } {
  return { terminal: result.terminal, errorCode: result.error?.code ?? null };
}

function evaluateRule(check: CaseCheck, expectedCase: CaseDefinition, result: CaseExecutionResult): CheckResult {
  const actual = actualTerminal(result);
  let passed = true;
  switch (check.rule) {
    case 'terminal':
      passed = result.terminal === expectedCase.expected.product_terminal
        && (expectedCase.expected.error_code === null || result.error?.code === expectedCase.expected.error_code);
      break;
    case 'run-binding':
      passed = result.identity.requestId !== null && result.identity.runId !== null;
      break;
    case 'input-isolation':
      passed = !JSON.stringify(result.input).includes('fault_profile') && !JSON.stringify(result.input).includes('budget_profile');
      break;
    case 'stopped':
      passed = result.close?.stopped === true;
      break;
    case 'closed':
      passed = result.close?.closed === true && (result.close.errors.length === 0);
      break;
    case 'no-late-terminal-change':
      passed = JSON.stringify(result.queryBeforeLateWindow) === JSON.stringify(result.queryAfterLateWindow);
      break;
    case 'usage-unknown':
      passed = result.usage.complete === false && result.usage.source === 'unknown';
      break;
    case 'attempt-count':
      passed = typeof result.usage.attempts === 'number' && result.usage.attempts === 2;
      break;
    case 'output':
      passed = Boolean(result.output?.text.trim()) && result.output?.partial === false;
      break;
    default:
      passed = check.evidence_refs.every((ref) => result.evidence[ref]?.present === true);
      if (check.id === 'no-secret') passed &&= (result.evidence['redaction-scan']?.actual as { leaked?: boolean } | undefined)?.leaked === false;
      if (check.id === 'requested-model-retained') passed &&= result.configuration.resolvedModel === null && result.configuration.requestedModel.model.includes('intentionally-absent');
      if (check.id === 'partial-fact-retained') passed &&= result.output?.partial === true;
  }
  return {
    checkId: check.id,
    applicable: true,
    status: passed ? 'PASS' : 'FAIL',
    expected: { terminal: expectedCase.expected.product_terminal, errorCode: expectedCase.expected.error_code },
    actual,
    reason: passed ? check.pass_when : check.fail_when,
    evidenceRefs: check.evidence_refs,
  };
}

export function evaluateCase(caseData: CaseDefinition, result: CaseExecutionResult): EvaluationResult {
  if (!result.executed) return { status: 'NOT_RUN', checks: [], reason: 'Case was not executed', productSuccess: false };
  if (result.facilityError) return { status: 'ERROR', checks: [], reason: `${result.facilityError.code}: ${result.facilityError.message}`, productSuccess: false };
  if (result.identity.caseId !== caseData.id || result.identity.caseVersion !== caseData.version) {
    return { status: 'ERROR', checks: [], reason: 'Observed result belongs to a different case identity', productSuccess: false };
  }
  const missing = caseData.expected.evidence_required.filter((ref) => result.evidence[ref]?.present !== true);
  if (missing.length > 0) return { status: 'UNJUDGEABLE', checks: [], reason: `Missing required evidence: ${missing.join(', ')}`, productSuccess: result.terminal === 'completed' };
  const checks = caseData.expected.checks.map((check) => evaluateRule(check, caseData, result));
  const failed = checks.find((check) => check.status === 'FAIL');
  const status: GradeStatus = failed ? 'FAIL' : 'PASS';
  return { status, checks, reason: failed ? `Failed check: ${failed.checkId}` : 'All applicable deterministic checks passed', productSuccess: result.terminal === 'completed' };
}
