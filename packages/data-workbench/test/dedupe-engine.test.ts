import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { DedupeEngine, normalizeContent } from "../src/dedupe-engine.js";
import type { IdAllocator } from "../src/ids.js";

const temporaryRoots: string[] = [];
const hashA = "a".repeat(64);
const hashB = "b".repeat(64);
const hashC = "c".repeat(64);
const hashD = "d".repeat(64);

class FixedIdAllocator implements IdAllocator {
  private nextArtifact = 1;

  async next(kind: "source" | "artifact" | "knowledge" | "sample" | "business" | "acquisition"): Promise<string> {
    if (kind !== "artifact") {
      throw new Error(`Unexpected ID kind: ${kind}`);
    }
    const id = `ART-${this.nextArtifact.toString().padStart(6, "0")}`;
    this.nextArtifact += 1;
    return id;
  }
}

async function createEngine(): Promise<{ root: string; engine: DedupeEngine }> {
  const root = await mkdtemp(path.join(os.tmpdir(), "flowmate-dedupe-"));
  temporaryRoots.push(root);
  return { root, engine: new DedupeEngine(root, new FixedIdAllocator()) };
}

afterEach(async () => {
  await Promise.all(temporaryRoots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("DedupeEngine", () => {
  it("classifies unique, duplicate URL, updated URL, duplicate raw, and duplicate content", async () => {
    const { root, engine } = await createEngine();

    await expect(engine.decide({ canonicalUrl: "https://example.com/a", rawSha256: hashA, contentSha256: hashB }))
      .resolves.toEqual({ status: "unique", canonicalArtifactId: "ART-000001", relatedArtifactIds: [] });
    await expect(engine.decide({ canonicalUrl: "https://example.com/a", rawSha256: hashA, contentSha256: hashB }))
      .resolves.toEqual({ status: "duplicate_url", canonicalArtifactId: "ART-000001", relatedArtifactIds: [] });
    await expect(engine.decide({ canonicalUrl: "https://example.com/a", rawSha256: hashC, contentSha256: hashD }))
      .resolves.toEqual({ status: "url_updated", canonicalArtifactId: "ART-000002", relatedArtifactIds: ["ART-000001"] });
    await expect(engine.decide({ canonicalUrl: "https://example.com/b", rawSha256: hashA, contentSha256: hashB }))
      .resolves.toEqual({ status: "duplicate_raw", canonicalArtifactId: "ART-000001", relatedArtifactIds: [] });
    await expect(engine.decide({ canonicalUrl: "https://example.com/c", rawSha256: hashD, contentSha256: hashB }))
      .resolves.toEqual({ status: "duplicate_content", canonicalArtifactId: "ART-000001", relatedArtifactIds: [] });
    await expect(readFile(path.join(root, "manifests", "dedupe-index.json"), "utf8"))
      .resolves.toContain("ART-000002");
  });

  it("normalizes only line endings, trailing whitespace, and repeated blank lines before UTF-8 hashing", () => {
    expect(normalizeContent("line one  \r\n\r\n\r\nline two\t\r\n")).toBe("line one\n\nline two\n");
    expect(normalizeContent("Cat")).not.toBe(normalizeContent("Feline"));
  });
});
