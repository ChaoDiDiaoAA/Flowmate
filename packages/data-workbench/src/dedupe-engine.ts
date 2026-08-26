import { randomUUID } from "node:crypto";
import { mkdir, readFile, rename, rmdir, writeFile } from "node:fs/promises";
import path from "node:path";
import type { DedupeDecision } from "./types.js";

interface ArtifactFingerprint {
  artifactId: string;
  canonicalUrl?: string;
  rawSha256: string;
  contentSha256?: string;
}

interface DedupeIndex {
  urls: Record<string, ArtifactFingerprint>;
  raws: Record<string, ArtifactFingerprint>;
  contents: Record<string, ArtifactFingerprint>;
}

const lockRetryDelayMs = 10;
const lockRetryLimit = 100;

export class DedupeEngine {
  public constructor(private readonly dataRoot: string) {}

  public async decide(input: {
    artifactId: string;
    canonicalUrl?: string;
    rawSha256: string;
    contentSha256?: string;
  }): Promise<DedupeDecision> {
    const indexPath = path.join(this.dataRoot, "manifests", "dedupe-index.json");
    return withExclusiveLock(path.join(this.dataRoot, "manifests", "dedupe-index.lock"), async () => {
      const index = await readIndex(indexPath);
      const byUrl = input.canonicalUrl === undefined ? undefined : index.urls[input.canonicalUrl];
      if (byUrl) {
        if (hasSameCanonicalContent(byUrl, input)) {
          if (byUrl.rawSha256 !== input.rawSha256) {
            index.raws[input.rawSha256] = newFingerprint({
              ...input,
              artifactId: byUrl.artifactId,
            });
            await writeJsonAtomically(indexPath, index);
          }
          const canonicalArtifactId = byUrl.rawSha256 === input.rawSha256
            ? await reconcileRawArtifactIdentity(indexPath, index, byUrl, input)
            : byUrl.artifactId;
          return duplicate("duplicate_url", canonicalArtifactId);
        }
        const fingerprint = newFingerprint(input);
        index.urls[input.canonicalUrl!] = fingerprint;
        index.raws[input.rawSha256] = fingerprint;
        if (input.contentSha256) {
          index.contents[input.contentSha256] = fingerprint;
        }
        await writeJsonAtomically(indexPath, index);
        return {
          status: "url_updated",
          canonicalArtifactId: fingerprint.artifactId,
          relatedArtifactIds: [byUrl.artifactId],
        };
      }

      const byRaw = index.raws[input.rawSha256];
      if (byRaw) {
        return duplicate("duplicate_raw", byRaw.artifactId);
      }
      const byContent = input.contentSha256 === undefined ? undefined : index.contents[input.contentSha256];
      if (byContent) {
        return duplicate("duplicate_content", byContent.artifactId);
      }

      const fingerprint = newFingerprint(input);
      if (input.canonicalUrl) {
        index.urls[input.canonicalUrl] = fingerprint;
      }
      index.raws[input.rawSha256] = fingerprint;
      if (input.contentSha256) {
        index.contents[input.contentSha256] = fingerprint;
      }
      await writeJsonAtomically(indexPath, index);
      return { status: "unique", canonicalArtifactId: fingerprint.artifactId, relatedArtifactIds: [] };
    });
  }
}

function hasSameCanonicalContent(
  existing: ArtifactFingerprint,
  input: { rawSha256: string; contentSha256?: string },
): boolean {
  if (existing.contentSha256 !== undefined && input.contentSha256 !== undefined) {
    return existing.contentSha256 === input.contentSha256;
  }
  return existing.rawSha256 === input.rawSha256;
}

export function normalizeContent(value: string): string {
  return value
    .replace(/\r\n?/g, "\n")
    .split("\n")
    .map((line) => line.replace(/[ \t]+$/g, ""))
    .join("\n")
    .replace(/\n{3,}/g, "\n\n");
}

function duplicate(status: Extract<DedupeDecision["status"], "duplicate_url" | "duplicate_raw" | "duplicate_content">, artifactId: string): DedupeDecision {
  return { status, canonicalArtifactId: artifactId, relatedArtifactIds: [] };
}

function newFingerprint(input: {
  artifactId: string;
  canonicalUrl?: string;
  rawSha256: string;
  contentSha256?: string;
}): ArtifactFingerprint {
  return {
    artifactId: input.artifactId,
    ...(input.canonicalUrl === undefined ? {} : { canonicalUrl: input.canonicalUrl }),
    rawSha256: input.rawSha256,
    ...(input.contentSha256 === undefined ? {} : { contentSha256: input.contentSha256 }),
  };
}

async function reconcileRawArtifactIdentity(
  indexPath: string,
  index: DedupeIndex,
  fingerprint: ArtifactFingerprint,
  input: { artifactId: string; rawSha256: string },
): Promise<string> {
  if (fingerprint.artifactId === input.artifactId) {
    return fingerprint.artifactId;
  }

  const corrected = { ...fingerprint, artifactId: input.artifactId };
  replaceFingerprint(index.urls, fingerprint, corrected);
  replaceFingerprint(index.raws, fingerprint, corrected);
  replaceFingerprint(index.contents, fingerprint, corrected);
  await writeJsonAtomically(indexPath, index);
  return corrected.artifactId;
}

function replaceFingerprint(
  entries: Record<string, ArtifactFingerprint>,
  expected: ArtifactFingerprint,
  replacement: ArtifactFingerprint,
): void {
  for (const [key, value] of Object.entries(entries)) {
    if (value.artifactId === expected.artifactId && value.rawSha256 === expected.rawSha256) {
      entries[key] = replacement;
    }
  }
}

async function readIndex(indexPath: string): Promise<DedupeIndex> {
  try {
    const parsed: unknown = JSON.parse(await readFile(indexPath, "utf8"));
    if (!isDedupeIndex(parsed)) {
      throw new Error("dedupe-index.json has invalid contents");
    }
    return parsed;
  } catch (error: unknown) {
    if (hasErrorCode(error, "ENOENT")) {
      return { urls: {}, raws: {}, contents: {} };
    }
    throw error;
  }
}

function isDedupeIndex(value: unknown): value is DedupeIndex {
  return typeof value === "object" && value !== null && !Array.isArray(value) &&
    "urls" in value && "raws" in value && "contents" in value &&
    [value.urls, value.raws, value.contents].every(
      (entries) => typeof entries === "object" && entries !== null && !Array.isArray(entries),
    );
}

async function writeJsonAtomically(filePath: string, value: unknown): Promise<void> {
  await mkdir(path.dirname(filePath), { recursive: true });
  const temporaryPath = `${filePath}.${randomUUID()}.tmp`;
  await writeFile(temporaryPath, `${JSON.stringify(value, null, 2)}\n`, "utf8");
  await rename(temporaryPath, filePath);
}

async function withExclusiveLock<T>(lockPath: string, operation: () => Promise<T>): Promise<T> {
  await mkdir(path.dirname(lockPath), { recursive: true });
  for (let attempt = 0; attempt < lockRetryLimit; attempt += 1) {
    try {
      await mkdir(lockPath);
      try {
        return await operation();
      } finally {
        await rmdir(lockPath);
      }
    } catch (error: unknown) {
      if (!hasErrorCode(error, "EEXIST")) {
        throw error;
      }
      await new Promise((resolve) => setTimeout(resolve, lockRetryDelayMs));
    }
  }
  throw new Error("Timed out acquiring dedupe index lock; operator recovery is required");
}

function hasErrorCode(error: unknown, code: string): boolean {
  return typeof error === "object" && error !== null && "code" in error && error.code === code;
}
