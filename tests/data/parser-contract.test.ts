import { createHash } from "node:crypto";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { describe, expect, it } from "vitest";
import { parseOriginal, type ParserInputRef } from "../../packages/data/src/parser/mineru.ts";

const hash = (value: Buffer | string) => createHash("sha256").update(value).digest("hex");

async function fixtureRoot(scriptBody: string) {
  const root = await mkdtemp(join(tmpdir(), "flowmate-parser-"));
  const inputPath = join(root, "invoice.jpg");
  const scriptPath = join(root, "parser.cjs");
  const bytes = Buffer.from("synthetic original invoice");
  await writeFile(inputPath, bytes);
  await writeFile(scriptPath, scriptBody, "utf8");
  const input: ParserInputRef = { assetId: "original:fixture:SYN-001", sha256: hash(bytes), mediaType: "image/jpeg", path: inputPath, sampleId: "SYN-001", sourceId: "fixture" };
  return { root, input, scriptPath };
}

describe("Parser contract", () => {
  it("maps a fresh Parser output into ParsedDocument with input evidence", async () => {
    const script = "const fs = require('node:fs'); const out = process.argv[process.argv.indexOf('-o') + 1]; fs.mkdirSync(out, { recursive: true }); fs.writeFileSync(require('node:path').join(out, 'content_list.json'), JSON.stringify([{ type: 'text', text: 'Invoice No: SYN-001', page_idx: 0 }]));";
    const fixture = await fixtureRoot(script);
    try {
      const result = await parseOriginal(fixture.input, { executable: process.execPath, parserName: "mineru-fixture", parserVersion: "fixture-1", outputRoot: join(fixture.root, "attempts"), args: [fixture.scriptPath], timeoutMs: 5_000 });
      expect(result.error).toBeNull();
      expect(result.exitCode).toBe(0);
      expect(result.document?.blocks[0]).toMatchObject({ text: "Invoice No: SYN-001", evidence: { assetId: fixture.input.assetId, page: 1 } });
      expect(result.outputRefs[0]?.assetId).toMatch(/^parser-output:/);
    } finally {
      await rm(fixture.root, { recursive: true, force: true });
    }
  });

  it("rejects zero exit without usable output and nonzero parser exits", async () => {
    const empty = await fixtureRoot("process.exit(0);");
    const failure = await fixtureRoot("process.stderr.write('bad parser'); process.exit(7);");
    try {
      const emptyResult = await parseOriginal(empty.input, { executable: process.execPath, parserName: "fixture", parserVersion: "1", outputRoot: join(empty.root, "attempts"), args: [empty.scriptPath], timeoutMs: 5_000 });
      expect(emptyResult.error?.code).toBe("PARSER_OUTPUT_INVALID");
      const failureResult = await parseOriginal(failure.input, { executable: process.execPath, parserName: "fixture", parserVersion: "1", outputRoot: join(failure.root, "attempts"), args: [failure.scriptPath], timeoutMs: 5_000 });
      expect(failureResult.error?.code).toBe("PARSER_EXIT_NONZERO");
      expect(failureResult.stderr).toContain("bad parser");
    } finally {
      await rm(empty.root, { recursive: true, force: true });
      await rm(failure.root, { recursive: true, force: true });
    }
  });

  it("rejects input hash drift and supports cancellation", async () => {
    const fixture = await fixtureRoot("setTimeout(() => {}, 5_000);");
    const changed = { ...fixture.input, sha256: "f".repeat(64) };
    try {
      const mismatch = await parseOriginal(changed, { executable: process.execPath, parserName: "fixture", parserVersion: "1", outputRoot: join(fixture.root, "attempts-mismatch"), args: [fixture.scriptPath], timeoutMs: 5_000 });
      expect(mismatch.error?.code).toBe("PARSER_INPUT_HASH_MISMATCH");
      const controller = new AbortController();
      const pending = parseOriginal(fixture.input, { executable: process.execPath, parserName: "fixture", parserVersion: "1", outputRoot: join(fixture.root, "attempts-cancel"), args: [fixture.scriptPath], timeoutMs: 5_000 }, controller.signal);
      setTimeout(() => controller.abort(), 50);
      await expect(pending).resolves.toMatchObject({ error: { code: "PARSER_CANCELLED" } });
    } finally {
      await rm(fixture.root, { recursive: true, force: true });
    }
  });
});
