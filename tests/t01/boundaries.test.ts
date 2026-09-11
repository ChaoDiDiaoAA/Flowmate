import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { checkBoundaries } from "../../scripts/check-boundaries.js";

describe("P0 dependency boundaries", () => {
  it("reports SDK imports leaking into contracts and Node imports leaking into Renderer", async () => {
    const root = await mkdtemp(join(tmpdir(), "flowmate-boundaries-"));
    try {
      await mkdir(join(root, "packages", "contracts", "src"), { recursive: true });
      await mkdir(join(root, "apps", "desktop", "src", "renderer"), { recursive: true });
      await writeFile(join(root, "packages", "contracts", "src", "bad.ts"),
        'import { createAgentSession } from "@earendil-works/pi-coding-agent";\n');
      await writeFile(join(root, "apps", "desktop", "src", "renderer", "bad.ts"),
        'import Database from "better-sqlite3";\n');

      const report = await checkBoundaries(root);
      expect(report.violations).toHaveLength(2);
      expect(report.violations.map((item) => item.rule)).toEqual([
        "contracts-no-pi",
        "renderer-no-node",
      ]);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
