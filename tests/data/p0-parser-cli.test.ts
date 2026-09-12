import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { describe, expect, it } from "vitest";
import { parseP0Args, runP0Command } from "../../scripts/p0.ts";

const hash = (value: Buffer | string) => createHash("sha256").update(value).digest("hex");

describe("P0 Parser command", () => {
  it("runs an explicit Parser Profile against an original and returns a contract summary", async () => {
    const root = await mkdtemp(join(tmpdir(), "flowmate-p0-parser-cli-"));
    const inputPath = join(root, "invoice.jpg");
    const scriptPath = join(root, "parser.cjs");
    const profilePath = join(root, "parser-profile.json");
    const bytes = Buffer.from("synthetic original");
    await writeFile(inputPath, bytes);
    await writeFile(scriptPath, "const fs=require('node:fs'); const path=require('node:path'); const out=process.argv[process.argv.indexOf('-o')+1]; fs.mkdirSync(out,{recursive:true}); fs.writeFileSync(path.join(out,'content_list.json'),JSON.stringify([{type:'text',text:'Invoice No: SYN-CLI',page_idx:0}]));", "utf8");
    await writeFile(profilePath, JSON.stringify({
      profileId: "parser-fixture",
      mode: "live",
      environment: "local-test",
      available: true,
      executable: process.execPath,
      parserName: "fixture-parser",
      parserVersion: "fixture-1",
      outputRoot: join(root, "attempts"),
      args: [scriptPath],
      timeoutMs: 5_000,
    }), "utf8");
    try {
      const result = await runP0Command(parseP0Args([
        "parser", "--profile", profilePath, "--input", inputPath, "--sample", "SYN-CLI", "--source-id", "fixture",
      ]), { cwd: root });
      expect(result).toMatchObject({ code: "READY", exitCode: 0 });
      expect(result.details?.attemptId).toMatch(/^parse-/);
      expect(result.details?.inputHash).toBe(hash(bytes));
      expect(result.details?.outputRefs).toBe(1);
      const attemptRoot = result.details?.outputRoot;
      expect(attemptRoot).toBeTruthy();
      await expect(readFile(join(attemptRoot!, "content_list.json"), "utf8")).resolves.toContain("SYN-CLI");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("keeps Parser execution behind an explicit input and Profile", async () => {
    const result = await runP0Command(parseP0Args(["parser", "--profile", "parser-fixture"]), { cwd: process.cwd() });
    expect(result).toMatchObject({ code: "INVALID_COMMAND", exitCode: 2 });
  });
});
