import { randomUUID, createHash } from "node:crypto";
import { AssetManifestSchema, type AssetManifest } from "./assets.js";
import { EvalTrialSchema, type EvalCase, type EvalTrial } from "./schema.js";

export type EvalPlanCase = {
  caseDef: EvalCase;
  attempts: number;
  required: boolean;
};

export type EvalPlan = {
  evalRunId: string;
  candidateId: string;
  assetVersion: string;
  live: boolean;
  maxWallTimeMs: number;
  cases: EvalPlanCase[];
};

export type EvalProfile = {
  candidateId: string;
  evalRunId?: string;
  live?: boolean;
  attempts?: number;
  maxWallTimeMs?: number;
};

export type EvalDriverInput = {
  evalRunId: string;
  trialId: string;
  caseDef: EvalCase;
  candidateId: string;
  attemptIndex: number;
  signal: AbortSignal;
  live: boolean;
};

export type EvalDriver = (input: EvalDriverInput) => Promise<EvalTrial>;
export type EvalDrivers = Partial<Record<EvalCase["driverId"], EvalDriver>>;
export type EvalRunResult = { evalRunId: string; trials: EvalTrial[]; cancelled: boolean; timedOut: boolean; errors: string[] };
export type CancelReceipt = { evalRunId: string; status: "requested" | "not-found" | "already-finished" };

const activeRuns = new Map<string, { controller: AbortController; result?: Promise<EvalRunResult> }>();

function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value && typeof value === "object") return `{${Object.entries(value as Record<string, unknown>).sort(([a], [b]) => a.localeCompare(b)).map(([key, item]) => `${JSON.stringify(key)}:${canonical(item)}`).join(",")}}`;
  return JSON.stringify(value);
}

function digest(value: unknown): string {
  return createHash("sha256").update(canonical(value)).digest("hex");
}

export function planEvalRun(manifestValue: AssetManifest, profile: EvalProfile): EvalPlan {
  const manifest = AssetManifestSchema.parse(manifestValue);
  if (!profile.candidateId.trim()) throw new Error("EVAL_CANDIDATE_REQUIRED");
  const attempts = profile.attempts ?? 1;
  if (!Number.isInteger(attempts) || attempts < 1) throw new Error("EVAL_ATTEMPTS_INVALID");
  return {
    evalRunId: profile.evalRunId ?? `eval-${randomUUID()}`,
    candidateId: profile.candidateId,
    assetVersion: manifest.assetVersion,
    live: profile.live === true,
    maxWallTimeMs: profile.maxWallTimeMs ?? 120_000,
    cases: manifest.cases.map((caseDef) => ({ caseDef, attempts, required: caseDef.required })),
  };
}

function blockedTrial(plan: EvalPlan, item: EvalPlanCase, attemptIndex: number, reason: string): EvalTrial {
  const caseHash = digest(item.caseDef);
  const goldHash = digest({ caseId: item.caseDef.caseId, assetVersion: plan.assetVersion });
  const graderHash = digest("flowmate-eval-grader-v1");
  return EvalTrialSchema.parse({
    evalRunId: plan.evalRunId,
    trialId: `${plan.evalRunId}:${item.caseDef.caseId}:${attemptIndex}`,
    caseId: item.caseDef.caseId,
    candidateId: plan.candidateId,
    caseHash,
    goldHash,
    graderHash,
    attemptIndex,
    executionStatus: "NOT_RUN",
    jobId: null,
    runIds: [],
    childRunIds: [],
    startedAt: null,
    endedAt: null,
    usage: { inputTokens: null, outputTokens: null, cost: null, unknown: true },
    assertionResults: [],
    verdict: null,
    errorKind: reason,
    upstreamBlocked: true,
    productReportRefs: [],
  });
}

export async function executeEvalRun(plan: EvalPlan, drivers: EvalDrivers): Promise<EvalRunResult> {
  if (activeRuns.has(plan.evalRunId)) throw new Error("EVAL_RUN_BUSY");
  const controller = new AbortController();
  const state: { controller: AbortController; result?: Promise<EvalRunResult> } = { controller };
  activeRuns.set(plan.evalRunId, state);
  const resultPromise = (async () => {
    const trials: EvalTrial[] = [];
    const errors: string[] = [];
    const deadline = Date.now() + plan.maxWallTimeMs;
    let cancelled = false;
    let timedOut = false;
    const deadlineTimer = setTimeout(() => {
      timedOut = true;
      controller.abort();
    }, Math.max(0, plan.maxWallTimeMs));
    try {
      outer: for (const item of plan.cases) {
        const driver = drivers[item.caseDef.driverId];
        for (let attemptIndex = 1; attemptIndex <= item.attempts; attemptIndex += 1) {
          if (controller.signal.aborted) {
            if (timedOut) trials.push(blockedTrial(plan, item, attemptIndex, "EVAL_WALL_TIME_EXCEEDED"));
            else { cancelled = true; trials.push(blockedTrial(plan, item, attemptIndex, "EVAL_CANCELLED")); }
            break outer;
          }
          if (Date.now() >= deadline) { timedOut = true; controller.abort(); trials.push(blockedTrial(plan, item, attemptIndex, "EVAL_WALL_TIME_EXCEEDED")); break outer; }
          if (!driver) { trials.push(blockedTrial(plan, item, attemptIndex, "DRIVER_NOT_REGISTERED")); continue; }
          const trialId = `${plan.evalRunId}:${item.caseDef.caseId}:${attemptIndex}`;
          try {
            const trial = EvalTrialSchema.parse(await driver({ evalRunId: plan.evalRunId, trialId, caseDef: item.caseDef, candidateId: plan.candidateId, attemptIndex, signal: controller.signal, live: plan.live }));
            trials.push(trial);
            if (trial.executionStatus === "ERROR") errors.push(trial.errorKind ?? "DRIVER_ERROR");
            if (controller.signal.aborted) {
              if (!timedOut) cancelled = true;
              break outer;
            }
          } catch (error) {
            errors.push(error instanceof Error ? error.message : "DRIVER_ERROR");
            trials.push(blockedTrial(plan, item, attemptIndex, "DRIVER_ERROR"));
            if (controller.signal.aborted) {
              if (!timedOut) cancelled = true;
              break outer;
            }
          }
        }
      }
    } finally {
      clearTimeout(deadlineTimer);
      activeRuns.delete(plan.evalRunId);
    }
    return { evalRunId: plan.evalRunId, trials, cancelled, timedOut, errors };
  })();
  state.result = resultPromise;
  return resultPromise;
}

export async function cancelEvalRun(evalRunId: string): Promise<CancelReceipt> {
  const state = activeRuns.get(evalRunId);
  if (!state) return { evalRunId, status: "not-found" };
  if (state.controller.signal.aborted) return { evalRunId, status: "already-finished" };
  state.controller.abort();
  return { evalRunId, status: "requested" };
}
