import type { EvalPlan } from "./runner.js";
import type { EvalTrial, Verdict } from "./schema.js";

export const P0_RUNTIME_MODULES = [
  "configuration",
  "loop",
  "tools",
  "memory",
  "session",
  "resources",
  "extensions",
  "control",
  "events",
  "rpc",
  "subagent",
  "stability",
] as const;

export type SummaryBucket = {
  planned: number;
  executed: number;
  scoreable: number;
  pass: number;
  fail: number;
  unjudgeable: number;
  error: number;
  notRun: number;
};

export type Summary = {
  planned: number;
  executed: number;
  scoreable: number;
  pass: number;
  fail: number;
  unjudgeable: number;
  error: number;
  notRun: number;
  scoreablePassRate: number | null;
  confirmedPlanPassRate: number | null;
  firstAttempt: { planned: number; pass: number; fail: number; scoreablePassRate: number | null };
  byModule: Record<string, SummaryBucket>;
  byScope: Record<string, SummaryBucket>;
  byLevel: Record<string, SummaryBucket>;
  bySourceKind: Record<string, SummaryBucket>;
  byCase: Record<string, SummaryBucket>;
};

function verdictCount(trials: EvalTrial[], verdict: Verdict): number {
  return trials.filter((trial) => trial.verdict === verdict).length;
}

function emptyBucket(): SummaryBucket {
  return { planned: 0, executed: 0, scoreable: 0, pass: 0, fail: 0, unjudgeable: 0, error: 0, notRun: 0 };
}

function addTrial(bucket: SummaryBucket, trial: EvalTrial): void {
  if (trial.executionStatus === "COMPLETED") bucket.executed += 1;
  if (trial.verdict === "PASS") bucket.pass += 1;
  if (trial.verdict === "FAIL") bucket.fail += 1;
  if (trial.verdict === "UNJUDGEABLE") bucket.unjudgeable += 1;
  if (trial.executionStatus === "ERROR") bucket.error += 1;
  if (trial.executionStatus === "NOT_RUN") bucket.notRun += 1;
  bucket.scoreable = bucket.pass + bucket.fail;
}

function addPlanned(bucket: SummaryBucket, attempts: number): void {
  bucket.planned += attempts;
}

export type SummaryOptions = { moduleUniverse?: readonly string[] };

export function summarize(trialsValue: EvalTrial[], plan: EvalPlan, options: SummaryOptions = {}): Summary {
  const trials = [...new Map(trialsValue.map((trial) => [trial.trialId, trial])).values()];
  const planned = plan.cases.reduce((total, item) => total + item.attempts, 0);
  const pass = verdictCount(trials, "PASS");
  const fail = verdictCount(trials, "FAIL");
  const unjudgeable = verdictCount(trials, "UNJUDGEABLE");
  const error = trials.filter((trial) => trial.executionStatus === "ERROR").length;
  const notRun = trials.filter((trial) => trial.executionStatus === "NOT_RUN").length;
  const scoreable = pass + fail;
  const firstAttempt = trials.filter((trial) => trial.attemptIndex === 1);
  const firstPass = verdictCount(firstAttempt, "PASS");
  const firstFail = verdictCount(firstAttempt, "FAIL");
  const byModule: Summary["byModule"] = {};
  const byScope: Summary["byScope"] = {};
  const byLevel: Summary["byLevel"] = {};
  const bySourceKind: Summary["bySourceKind"] = {};
  const byCase: Summary["byCase"] = {};
  for (const module of options.moduleUniverse ?? []) byModule[module] = emptyBucket();
  for (const item of plan.cases) {
    const dimensions: Array<[Record<string, SummaryBucket>, string]> = [
      [byModule, item.caseDef.primaryModule],
      [byScope, item.caseDef.scope],
      [byLevel, item.caseDef.level],
      [bySourceKind, item.caseDef.sourceKind],
      [byCase, item.caseDef.caseId],
    ];
    for (const [buckets, key] of dimensions) addPlanned(buckets[key] ?? (buckets[key] = emptyBucket()), item.attempts);
    const moduleTrials = trials.filter((trial) => trial.caseId === item.caseDef.caseId);
    for (const trial of moduleTrials) {
      for (const [buckets, key] of dimensions) addTrial(buckets[key]!, trial);
    }
  }
  return {
    planned,
    executed: trials.filter((trial) => trial.executionStatus === "COMPLETED").length,
    scoreable,
    pass,
    fail,
    unjudgeable,
    error,
    notRun,
    scoreablePassRate: scoreable === 0 ? null : pass / scoreable,
    confirmedPlanPassRate: planned === 0 ? null : pass / planned,
    firstAttempt: { planned: plan.cases.length, pass: firstPass, fail: firstFail, scoreablePassRate: firstPass + firstFail === 0 ? null : firstPass / (firstPass + firstFail) },
    byModule,
    byScope,
    byLevel,
    bySourceKind,
    byCase,
  };
}
