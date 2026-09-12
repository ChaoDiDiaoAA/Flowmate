import { describe, expect, it } from "vitest";
import { freezeAssets } from "../src/assets.js";
import { cancelEvalRun, executeEvalRun, planEvalRun } from "../src/runner.js";
import type { EvalTrial } from "../src/schema.js";

const hash = (value: string) => "a".repeat(64).slice(0, 64 - value.length) + value;
const ref = (id: string) => ({ id, sha256: "b".repeat(64), source: `synthetic/${id}` });
function manifest() {
  return freezeAssets({ schemaVersion: "1", batchId: "runner", author: "a", reviewer: "r", cases: [{ caseId: "CASE-1", version: "1", primaryModule: "tool", relatedModules: [], runtimeRefs: [], benchmarkRefs: [], scope: "eval-infra", level: "F", sourceKind: "synthetic", sourceGroup: "runner", purpose: "development", inputRef: ref("input"), fixtureVersion: null, goldRef: ref("gold"), rubricVersion: "1", required: true, assertions: ["ok"], driverId: "native-f", gold: [{ fieldPath: "x", sourceValue: "1", sourceNormalized: "1", sourceStatus: "present", normalized: "1", valueStatus: "present", inputAvailability: "available", evidence: [], comparison: "text", reviewStatus: "verified" }] }] });
}
function trial(input: { evalRunId: string; trialId: string; caseId: string; candidateId: string; attemptIndex: number }): EvalTrial {
  return { evalRunId: input.evalRunId, trialId: input.trialId, caseId: input.caseId, candidateId: input.candidateId, caseHash: hash("c"), goldHash: hash("g"), graderHash: hash("r"), attemptIndex: input.attemptIndex, executionStatus: "COMPLETED", jobId: null, runIds: [], childRunIds: [], startedAt: new Date().toISOString(), endedAt: new Date().toISOString(), usage: { inputTokens: 1, outputTokens: 1, cost: null, unknown: true }, assertionResults: [], verdict: "PASS", errorKind: null, upstreamBlocked: false, productReportRefs: [] };
}

describe("bounded evaluation runner", () => {
  it("keeps blocked cases NOT_RUN and never calls an absent driver", async () => {
    const plan = planEvalRun(manifest(), { candidateId: "candidate", evalRunId: "eval-blocked" });
    const result = await executeEvalRun(plan, {});
    expect(result.trials[0]).toMatchObject({ executionStatus: "NOT_RUN", upstreamBlocked: true });
  });

  it("runs cases sequentially and exposes cancellation through the driver signal", async () => {
    const plan = planEvalRun(manifest(), { candidateId: "candidate", evalRunId: "eval-cancel" });
    let observedAbort = false;
    const promise = executeEvalRun(plan, { "native-f": async (input) => {
      await new Promise<void>((resolve) => input.signal.addEventListener("abort", () => { observedAbort = true; resolve(); }, { once: true }));
      return trial({ evalRunId: input.evalRunId, trialId: input.trialId, caseId: input.caseDef.caseId, candidateId: "candidate", attemptIndex: input.attemptIndex });
    } });
    await cancelEvalRun("eval-cancel");
    const result = await promise;
    expect(observedAbort).toBe(true);
    expect(result.cancelled).toBe(true);
  });

  it("aborts an overlong evaluation at the plan deadline and keeps it distinct from user cancel", async () => {
    const source = manifest();
    const plan = planEvalRun({ ...source, cases: [{ ...source.cases[0]!, required: true }] }, { candidateId: "candidate", evalRunId: "eval-timeout", maxWallTimeMs: 20 });
    const result = await executeEvalRun(plan, { "native-f": async (input) => {
      await new Promise<void>((resolve) => input.signal.addEventListener("abort", () => resolve(), { once: true }));
      return trial({ evalRunId: input.evalRunId, trialId: input.trialId, caseId: input.caseDef.caseId, candidateId: "candidate", attemptIndex: input.attemptIndex });
    } });
    expect(result).toMatchObject({ cancelled: false, timedOut: true });
  });
});
