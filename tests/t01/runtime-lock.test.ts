import { describe, expect, it } from "vitest";
import { verifyRuntimeLock } from "../../scripts/verify-runtime-lock.js";

describe("P0 runtime lock", () => {
  it("matches installed packages and the minimum Node version", async () => {
    const report = await verifyRuntimeLock({ cwd: process.cwd() });

    expect(report.nodeSupported).toBe(true);
    expect(report.mismatches).toEqual([]);
    expect(report.checkedPackages).toContain("@earendil-works/pi-coding-agent");
    expect(report.checkedPackages).toContain("@tintinweb/pi-subagents");
  });
});
