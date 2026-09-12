import { describe, expect, it } from "vitest";
import { inspectEnvironment } from "../../scripts/doctor.js";

describe("P0 environment doctor", () => {
  it("reports the running Node and Bun versions without exposing secrets", async () => {
    const report = await inspectEnvironment({
      cwd: process.cwd(),
      env: { FLOWMATE_TEST_SECRET: "do-not-print" },
    });

    expect(report.node.version).toMatch(/^v\d+\.\d+\.\d+$/);
    expect(report.bun.version).toMatch(/^\d+\.\d+\.\d+/);
    expect(JSON.stringify(report)).not.toContain("do-not-print");
    expect(report.checks.some((check) => check.id === "workspace")).toBe(true);
  });
});
