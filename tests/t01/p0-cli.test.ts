import { describe, expect, it } from "vitest";
import { parseP0Args, runP0Command } from "../../scripts/p0.js";

describe("P0 command entry", () => {
  it("does not turn absent option indexes into positional arguments", () => {
    expect(parseP0Args(["inspect", "sample-A"]).positional).toEqual(["sample-A"]);
    expect(parseP0Args(["inspect", "--root", "source", "sample-A"]).positional).toEqual(["sample-A"]);
  });

  it("requires an explicit profile for live runs", async () => {
    const command = parseP0Args(["run", "--live"]);
    const result = await runP0Command(command, { cwd: process.cwd() });

    expect(result.code).toBe("LIVE_PROFILE_REQUIRED");
    expect(result.exitCode).toBe(2);
  });

  it("keeps parser and model execution behind explicit profiles", async () => {
    await expect(runP0Command(parseP0Args(["parser"]), { cwd: process.cwd() })).resolves.toMatchObject({ code: "LIVE_PROFILE_REQUIRED", exitCode: 2 });
    await expect(runP0Command(parseP0Args(["run", "--profile", "live-main"]), { cwd: process.cwd() })).resolves.toMatchObject({ code: "CAPABILITY_NOT_READY", exitCode: 1 });
  });

  it("runs the native Agent plugin probe without business data", async () => {
    const command = parseP0Args(["plugin-probe"]);
    const result = await runP0Command(command, { cwd: process.cwd() });

    expect(result.code).toBe("READY");
    expect(result.exitCode).toBe(0);
  });
});
