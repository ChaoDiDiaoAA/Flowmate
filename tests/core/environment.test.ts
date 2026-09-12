import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, describe, expect, it } from "vitest";
import { loadDotEnv } from "../../packages/core/src/index.ts";

const keys = ["FLOWMATE_ENV_TEST", "FLOWMATE_ENV_EXISTING"];

afterEach(() => {
  for (const key of keys) delete process.env[key];
});

describe("explicit project environment loading", () => {
  it("loads simple values and never overrides the process environment", async () => {
    const root = await mkdtemp(join(tmpdir(), "flowmate-env-"));
    try {
      process.env.FLOWMATE_ENV_EXISTING = "process-value";
      await writeFile(join(root, ".env"), "FLOWMATE_ENV_TEST=loaded\nFLOWMATE_ENV_EXISTING=dotenv-value\n# ignored\ninvalid\n", "utf8");
      await expect(loadDotEnv(join(root, ".env"))).resolves.toEqual([join(root, ".env")]);
      expect(process.env.FLOWMATE_ENV_TEST).toBe("loaded");
      expect(process.env.FLOWMATE_ENV_EXISTING).toBe("process-value");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
