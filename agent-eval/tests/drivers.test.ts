import { describe, expect, it } from "vitest";
import { createProductDriver } from "../src/drivers.js";
import type { EvalDriverInput } from "../src/runner.js";
import type { EvalCase } from "../src/schema.js";

const caseDef: EvalCase = {
  caseId: "PRODUCT-CASE",
  version: "1",
  primaryModule: "tools",
  relatedModules: [],
  runtimeRefs: [],
  benchmarkRefs: [],
  scope: "integration",
  level: "F",
  sourceKind: "synthetic",
  sourceGroup: "driver",
  purpose: "development",
  inputRef: { id: "input", sha256: "a".repeat(64), source: "synthetic/input" },
  fixtureVersion: null,
  goldRef: { id: "gold", sha256: "b".repeat(64), source: "synthetic/gold" },
  rubricVersion: "1",
  required: true,
  assertions: ["run-observed"],
  driverId: "product-f",
};

const input = (signal: AbortSignal): EvalDriverInput => ({ evalRunId: "eval", trialId: "trial", caseDef, attemptIndex: 1, signal, live: false, candidateId: "candidate" });

describe("product evaluation driver", () => {
  it("observes product completion without assigning a quality verdict", async () => {
    const driver = createProductDriver({
      candidateId: "candidate",
      sampleIdForCase: () => "SYN-001",
      application: {
        async start() { return { jobId: "job", runId: "run" }; },
        async wait() { return { kind: "completed", sessionId: "session" }; },
        getJob() { return { candidates: [{ id: "candidate" }] }; },
        async cancel() { return { status: "complete" }; },
      },
    });
    const controller = new AbortController();
    await expect(driver(input(controller.signal))).resolves.toMatchObject({ executionStatus: "COMPLETED", jobId: "job", runIds: ["run"], verdict: null });
  });
});
