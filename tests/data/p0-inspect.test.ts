import { describe, expect, it } from "vitest";
import { parseP0Args, runP0Command } from "../../scripts/p0.ts";
import { withSourceFixture } from "../support/workspace.js";
import { readFile } from "node:fs/promises";
import { join } from "node:path";

describe("P0 source inspection command", () => {
  it("returns the inspected source report when a role map is supplied", async () => {
    await withSourceFixture("normal", async ({ root, roleMap }) => {
      const result = await runP0Command(parseP0Args(["inspect", "--root", root]), {
        cwd: process.cwd(),
        roleMap,
      });
      expect(result).toMatchObject({ code: "READY", exitCode: 0 });
      expect(result.details).toMatchObject({ validEntries: 1, quarantinedEntries: 0 });
    });
  });

  it("does not report a source as ready when its role map is missing", async () => {
    const result = await runP0Command(parseP0Args(["inspect", "--root", "missing-source"]), { cwd: process.cwd() });
    expect(result).toMatchObject({ code: "CAPABILITY_NOT_READY", exitCode: 1 });
  });

  it("freezes only explicitly purposed samples and writes a reopenable manifest", async () => {
    await withSourceFixture("normal", async ({ root, roleMap }) => {
      const outputRoot = join(root, "frozen-cli");
      const result = await runP0Command(parseP0Args(["freeze", "--root", root, "--output", outputRoot, "--purpose", "SYN-001=test"]), {
        cwd: process.cwd(),
        roleMap,
      });
      expect(result).toMatchObject({ code: "READY", exitCode: 0, details: { validEntries: 1 } });
      await expect(readFile(join(outputRoot, "manifest.json"), "utf8")).resolves.toContain("SYN-001");
    });
  });

  it("requires an explicit purpose instead of silently freezing every entry", async () => {
    await withSourceFixture("normal", async ({ root, roleMap }) => {
      const result = await runP0Command(parseP0Args(["freeze", "--root", root]), { cwd: process.cwd(), roleMap });
      expect(result).toMatchObject({ code: "INVALID_COMMAND", exitCode: 2 });
    });
  });
});
