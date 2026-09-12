import { describe, expect, it } from "vitest";
import { P0_RUNTIME_MODULES, summarize } from "../src/statistics.js";
import { renderReport } from "../src/report.js";
import type { EvalPlan } from "../src/runner.js";
import type { EvalTrial } from "../src/schema.js";

const plan = { evalRunId: "eval", candidateId: "candidate", assetVersion: "p0", live: false, maxWallTimeMs: 1_000, cases: ["PASS", "FAIL", "UNJUDGEABLE", "ERROR", "NOT_RUN"].map((verdict, index) => ({ caseDef: { caseId: `CASE-${index}`, version: "1", primaryModule: "module", relatedModules: [], runtimeRefs: [], benchmarkRefs: [], scope: "eval-infra", level: "F", sourceKind: "synthetic", sourceGroup: `group-${index}`, purpose: "development", inputRef: { id: `input-${index}`, sha256: "a".repeat(64), source: "synthetic" }, fixtureVersion: null, goldRef: { id: `gold-${index}`, sha256: "b".repeat(64), source: "synthetic" }, rubricVersion: "1", required: true, assertions: [], driverId: "native-f" } as any, attempts: 1, required: true })) } satisfies EvalPlan;
const trial = (index: number, status: EvalTrial["executionStatus"], verdict: EvalTrial["verdict"]): EvalTrial => ({ evalRunId: "eval", trialId: `trial-${index}`, caseId: `CASE-${index}`, candidateId: "candidate", caseHash: "a".repeat(64), goldHash: "b".repeat(64), graderHash: "c".repeat(64), attemptIndex: 1, executionStatus: status, jobId: null, runIds: [], childRunIds: [], startedAt: null, endedAt: null, usage: { inputTokens: null, outputTokens: null, cost: null, unknown: true }, assertionResults: [], verdict, errorKind: null, upstreamBlocked: status !== "COMPLETED", productReportRefs: [] });

describe("evaluation statistics", () => {
  it("uses planned items as the denominator and does not turn errors into passes", () => {
    const summary = summarize([trial(0, "COMPLETED", "PASS"), trial(1, "COMPLETED", "FAIL"), trial(2, "COMPLETED", "UNJUDGEABLE"), trial(3, "ERROR", null), trial(4, "NOT_RUN", null)], plan);
    expect(summary).toMatchObject({ planned: 5, scoreable: 2, pass: 1, fail: 1, unjudgeable: 1, error: 1, notRun: 1, scoreablePassRate: 0.5, confirmedPlanPassRate: 0.2 });
    expect(summary.byScope["eval-infra"]).toMatchObject({ planned: 5, pass: 1, fail: 1, notRun: 1 });
    expect(renderReport(summary)).toContain("UNJUDGEABLE");
  });

  it("can keep the complete P0 runtime module denominator visible", () => {
    const summary = summarize([], { ...plan, cases: [] }, { moduleUniverse: P0_RUNTIME_MODULES });
    expect(Object.keys(summary.byModule)).toEqual([...P0_RUNTIME_MODULES]);
    expect(summary.byModule.memory).toMatchObject({ planned: 0, executed: 0, scoreable: 0 });
  });
});
