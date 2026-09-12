import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { join } from "node:path";
import { tmpdir } from "node:os";
import type { SourceRoleMap } from "../../packages/data/src/source/role-map.ts";

export type SourceFixtureKind =
  | "normal"
  | "empty"
  | "missing-original"
  | "hash-mismatch"
  | "missing-page"
  | "unstable"
  | "mixed-label"
  | "array-parsed"
  | "unsupported-format";

export type SourceFixture = {
  root: string;
  roleMap: SourceRoleMap;
  addSample(sampleId: string): Promise<void>;
};

function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

async function writeSample(root: string, sampleId: string, options: { empty?: boolean; hashMismatch?: boolean; missingPage?: boolean; mixedLabel?: boolean; arrayParsed?: boolean; unsupported?: boolean } = {}): Promise<void> {
  const original = `RAW INVOICE ${sampleId}`;
  const originalPath = join(root, "original", `${sampleId}.pdf`);
  const parsedExtension = options.unsupported ? "txt" : "json";
  const parsedPath = join(root, "parsed", `${sampleId}.${parsedExtension}`);
  await writeFile(originalPath, original, "utf8");
  if (options.empty) {
    await writeFile(parsedPath, "", "utf8");
    return;
  }
  if (options.unsupported) {
    await writeFile(parsedPath, "unsupported parsed output", "utf8");
    return;
  }
  const originalHash = options.hashMismatch ? "f".repeat(64) : sha256(original);
  const document: Record<string, unknown> = {
    schemaVersion: "1",
    sampleId,
    sourceId: "fixture-source",
    original: { assetId: "untrusted-original-id", sha256: originalHash, mediaType: "application/pdf" },
    parser: { name: "fixture-parser", version: "1" },
    blocks: [{
      id: "b1",
      kind: "text",
      text: `Invoice No: ${sampleId}`,
      evidence: { assetId: "untrusted-original-id", blockId: "b1", page: 1, quote: `Invoice No: ${sampleId}`, bbox: null },
    }],
  };
  if (options.missingPage) {
    await writeFile(join(root, "metadata", `${sampleId}.json`), JSON.stringify({ pageCount: 2, pages: [1] }), "utf8");
  }
  if (options.mixedLabel) {
    document.json_annotation = { answer: "GOLD_SENTINEL_71", source_locator: "labels/SYN-001.json" };
  }
  const parsed = options.arrayParsed
    ? [{ type: "text", text: `Invoice No: ${sampleId}`, bbox: [1, 2, 30, 40], page_idx: 0 }]
    : document;
  await writeFile(parsedPath, JSON.stringify(parsed), "utf8");
  if (options.mixedLabel) {
    await writeFile(join(root, "labels", `${sampleId}.json`), JSON.stringify({ answer: "GOLD_SENTINEL_71" }), "utf8");
  }
}

export async function withSourceFixture<T>(kind: SourceFixtureKind, fn: (fixture: SourceFixture) => Promise<T>): Promise<T> {
  const root = await mkdtemp(join(tmpdir(), "flowmate-source-"));
  await Promise.all([
    mkdir(join(root, "original"), { recursive: true }),
    mkdir(join(root, "parsed"), { recursive: true }),
    mkdir(join(root, "metadata"), { recursive: true }),
    mkdir(join(root, "labels"), { recursive: true }),
  ]);
  await writeSample(root, "SYN-001", {
    empty: kind === "empty",
    hashMismatch: kind === "hash-mismatch",
    missingPage: kind === "missing-page",
    mixedLabel: kind === "mixed-label",
    arrayParsed: kind === "array-parsed",
    unsupported: kind === "unsupported-format",
  });
  if (kind === "missing-original") {
    await rm(join(root, "original", "SYN-001.pdf"), { force: true });
  }
  const roleMap: SourceRoleMap = {
    sourceId: "fixture-source",
    parserVersion: "fixture-1",
    encoding: "utf8",
    sampleIdRegex: "(?:^|/)(?<sampleId>[^/]+)\\.[^.]+$",
    roles: {
      original: { patterns: ["original/*.pdf"] },
      parsed: { patterns: ["parsed/*.{json,txt}"] },
      metadata: { patterns: ["metadata/*.json"] },
      labels: { patterns: ["labels/*.json"] },
    },
  };
  const fixture: SourceFixture = {
    root,
    roleMap,
    addSample: (sampleId) => writeSample(root, sampleId),
  };
  try {
    return await fn(fixture);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}
