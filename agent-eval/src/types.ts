import type { ProductPaths, ModelRef, RunStatus } from '@flowmate/contracts';

export type EvaluationMode = 'fixture' | 'live';
export type GradeStatus = 'PASS' | 'FAIL' | 'UNJUDGEABLE' | 'ERROR' | 'NOT_RUN';

export type CaseCheck = {
  id: string;
  rule: string;
  required: boolean;
  hard_constraint: boolean;
  applicable_when: string;
  pass_when: string;
  fail_when: string;
  evidence_refs: string[];
  missing_evidence: string;
};

export type CaseDefinition = {
  id: string;
  version: number;
  name: string;
  stage: string;
  capability: string;
  related_capabilities: string[];
  eval_types: string[];
  tags: string[];
  split: string;
  source: { kind: string; record: string; group: string };
  input: {
    goal: string;
    documents: string[];
    setup: { allowed_modes?: EvaluationMode[]; fault_profile?: string; budget_profile?: string; [key: string]: unknown };
  };
  expected: {
    product_terminal: 'completed' | 'failed' | 'cancelled';
    error_code: string | null;
    evidence_required: string[];
    checks: CaseCheck[];
    [key: string]: unknown;
  };
  grader: { name: string; version: number };
  review: { status: 'pending' | 'verified' | 'rejected'; reviewer: string | null; reviewed_at: string | null; evidence: string[]; limitations: string[] };
};

export type ProjectedInput = { goal: string; text: string; documents: Array<{ path: string; sha256: string; text: string }> };
export type EvidenceFact = { present: boolean; actual: unknown; source: string };

export type CaseExecutionResult = {
  executed: boolean;
  identity: { executionId: string; trialId: string; caseId: string; caseVersion: number; requestId: number | null; runId: number | null };
  mode: EvaluationMode;
  input: { goal: string; text: string };
  configuration: { requestedModel: ModelRef; resolvedModel: string | null; responseModel: string | null; overrides: string[] };
  terminal: Exclude<RunStatus, 'created' | 'running'> | null;
  error: { code: string; message: string } | null;
  output: { text: string; partial: boolean } | null;
  usage: { source: string; attempts: number | null; complete: boolean };
  timeline: Array<Record<string, unknown>>;
  queryBeforeLateWindow: Record<string, unknown> | null;
  queryAfterLateWindow: Record<string, unknown> | null;
  close: { stopped: boolean; closed: boolean; errors: unknown[] } | null;
  evidence: Record<string, EvidenceFact>;
  facilityError: { code: string; message: string } | null;
};

export type TrialContext = {
  executionId: string;
  trialId: string;
  caseId: string;
  paths: ProductPaths;
  owner: { version: 1; executionId: string; trialId: string; root: string };
};

export type CheckResult = {
  checkId: string;
  applicable: boolean;
  status: GradeStatus | null;
  expected: unknown;
  actual: unknown;
  reason: string;
  evidenceRefs: string[];
};

export type EvaluationResult = { status: GradeStatus; checks: CheckResult[]; reason: string; productSuccess: boolean };
