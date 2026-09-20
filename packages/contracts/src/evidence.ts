import type { Id, Purpose, Sha256, Utc } from './foundation.ts';

export type CheckStatus = 'PASS' | 'FAIL' | 'UNJUDGEABLE' | 'ERROR' | 'NOT_RUN';

export interface EvidenceFile {
  path: string;
  sha256: Sha256;
  bytes: number;
  kind: 'binding' | 'process' | 'input-check' | 'facts' | 'fault' | 'logs' | 'access' | 'review';
}

export interface CheckObservation {
  checkId: string;
  caseVariantId: string;
  capabilityIds: readonly string[];
  metricIds: readonly string[];
  required: boolean;
  applicable: boolean;
  applicabilityReason?: string;
  status?: CheckStatus;
  reason: string;
  evidencePaths: readonly string[];
  reviewedBy?: string;
  reviewedAt?: Utc;
}

export interface ProductBinding {
  /** Omitted in legacy evidence; this policy covers only local development technical F. */
  assessmentPolicy?: 'p0-local-f/v2';
  codeCommit: string;
  dirtyDiffSha256: Sha256 | null;
  lockSha256: Sha256;
  configSha256: Sha256;
  policySha256: Sha256;
  inputManifestSha256: Sha256;
  productSpecSha256: Sha256;
  evalSpecSha256: Sha256;
  caseSetSha256: Sha256;
  oracleSha256: Sha256;
  mapperVersion: string;
  migrationChecksums: readonly Sha256[];
  os: string;
  architecture: string;
  bunVersion: string;
  nodeVersion: string;
  instanceId: Id;
  workspaceId: Id;
  processInstanceIds: readonly Id[];
  purpose: Purpose;
}

export interface PreparationBinding {
  codeCommit: string;
  dirtyDiffSha256: Sha256 | null;
  toolVersionHash: Sha256;
  assetManifestSha256: Sha256;
  caseSetSha256: Sha256;
  oracleSha256: Sha256;
  productSpecSha256: Sha256;
  evalSpecSha256: Sha256;
  os: string;
  pythonVersion: string;
  scopeDescription: string;
}

export interface P0CheckCounts {
  unit: 'check';
  plannedApplicable: number;
  executed: number;
  judgeable: number;
  pass: number;
  fail: number;
  unjudgeable: number;
  error: number;
  notRun: number;
  notApplicable: number;
  confirmedPass: number;
}

export interface P0FReport {
  schemaVersion: 'p0-f-evidence/v1';
  executionId: string;
  phase: 'P0';
  evidenceKind: 'F';
  scope: 'product' | 'asset' | 'facility';
  executionEligibility: 'ready' | 'blocked';
  blockers: readonly string[];
  window: { startedAt: Utc; endedAt: Utc };
  files: readonly EvidenceFile[];
  checks: readonly CheckObservation[];
  counts: P0CheckCounts;
  caseCounts: { planned: number; applicable: number; executed: number; confirmedPass: number };
  binding: ProductBinding | PreparationBinding;
}

export function summarizeChecks(checks: readonly CheckObservation[]): P0CheckCounts {
  const applicable = checks.filter((check) => check.applicable);
  const executed = applicable.filter((check) => check.status && check.status !== 'NOT_RUN');
  const pass = applicable.filter((check) => check.status === 'PASS');
  const fail = applicable.filter((check) => check.status === 'FAIL');
  const unjudgeable = applicable.filter((check) => check.status === 'UNJUDGEABLE');
  const error = applicable.filter((check) => check.status === 'ERROR');
  const notRun = applicable.filter((check) => !check.status || check.status === 'NOT_RUN');
  return { unit: 'check', plannedApplicable: applicable.length, executed: executed.length, judgeable: pass.length + fail.length, pass: pass.length, fail: fail.length, unjudgeable: unjudgeable.length, error: error.length, notRun: notRun.length, notApplicable: checks.length - applicable.length, confirmedPass: pass.filter((check) => Boolean(check.reviewedBy && check.reviewedAt)).length };
}

export function buildP0FReport(input: Omit<P0FReport, 'schemaVersion' | 'counts'>): P0FReport {
  const counts = summarizeChecks(input.checks);
  const blockers = [...input.blockers];
  for (const check of input.checks) {
    if (check.applicable && !check.status) blockers.push(`missing status: ${check.checkId}/${check.caseVariantId}`);
    if (!check.applicable && check.status) blockers.push(`N/A check has status: ${check.checkId}/${check.caseVariantId}`);
  }
  return { schemaVersion: 'p0-f-evidence/v1', ...input, executionEligibility: blockers.length === 0 ? input.executionEligibility : 'blocked', blockers, counts };
}
