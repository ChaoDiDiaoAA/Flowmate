import { randomUUID } from "node:crypto";
import {
  mkdir,
  readFile,
  rename,
  rm,
  rmdir,
  writeFile,
} from "node:fs/promises";
import path from "node:path";
import type { DataPaths } from "./filesystem-layout.js";
import type { IdAllocator } from "./ids.js";
import { SealedStagedFile } from "./sealed-staged-file.js";
import { assertAcquisitionJobId, assertSourceId } from "./stable-ids.js";
import type { RawArtifactRef } from "./types.js";

interface RawArtifactIndex {
  artifactsBySha256: Record<string, RawArtifactRef>;
}

const lockRetryDelayMs = 10;
const lockRetryLimit = 100;

export class RawArtifactStore {
  public constructor(
    private readonly paths: DataPaths,
    private readonly idAllocator: IdAllocator,
  ) {}

  public async ingest(input: {
    sourceId: string;
    jobId: string;
    canonicalUrl?: string;
    stagedFile: SealedStagedFile;
    mimeType: string;
    retentionStatus: RawArtifactRef["retentionStatus"];
  }): Promise<RawArtifactRef> {
    const sourceId = assertSourceId(input.sourceId);
    const jobId = assertAcquisitionJobId(input.jobId);
    const stagedFile = input.stagedFile;
    if (stagedFile.jobId !== jobId) {
      throw new Error("Sealed staged file does not belong to the current acquisition job");
    }
    const canonicalUrl = input.canonicalUrl === undefined
      ? undefined
      : canonicalizeUrl(input.canonicalUrl);
    const rawSha256 = await stagedFile.sha256();

    return withExclusiveLock(path.join(this.paths.manifests, "raw-artifact-index.lock"), async () => {
      const indexPath = path.join(this.paths.manifests, "raw-artifact-index.json");
      const index = await readIndex(indexPath);
      const existing = index.artifactsBySha256[rawSha256];
      if (existing) {
        const updated = associate(existing, sourceId, jobId);
        index.artifactsBySha256[rawSha256] = updated;
        await writeArtifactMetadata(updated, artifactDirectoryFor(this.paths.webRaw, updated));
        await writeJsonAtomically(indexPath, index);
        await stagedFile.dispose();
        return updated;
      }

      const artifactId = await this.idAllocator.next("artifact");
      const domain = canonicalUrl ? new URL(canonicalUrl).hostname : "unknown";
      const artifactDirectory = path.join(this.paths.webRaw, domain, jobId, artifactId);
      const stagedArtifactDirectory = `${artifactDirectory}.${randomUUID()}.tmp`;
      const retained = input.retentionStatus === "retained";
      const fileName = stagedFile.fileName;
      const rawRef = retained ? path.join(artifactDirectory, "files", fileName) : undefined;
      const artifact: RawArtifactRef = {
        artifactId,
        sourceIds: [sourceId],
        acquisitionJobIds: [jobId],
        ...(canonicalUrl === undefined ? {} : { canonicalUrl }),
        ...(rawRef === undefined ? {} : { rawRef }),
        rawSha256,
        mimeType: input.mimeType,
        retentionStatus: input.retentionStatus,
      };

      try {
        await mkdir(path.join(stagedArtifactDirectory, "files"), { recursive: true });
        if (retained) {
          await stagedFile.copyTo(path.join(stagedArtifactDirectory, "files", fileName));
        } else {
          // The sealed temporary body is discarded after its audit hash is recorded.
        }
        await writeArtifactMetadata(artifact, stagedArtifactDirectory, fileName);
        await mkdir(path.dirname(artifactDirectory), { recursive: true });
        await rename(stagedArtifactDirectory, artifactDirectory);
      } catch (error) {
        await rm(stagedArtifactDirectory, { recursive: true, force: true });
        throw error;
      } finally {
        await stagedFile.dispose();
      }

      index.artifactsBySha256[rawSha256] = artifact;
      await writeJsonAtomically(indexPath, index);
      return artifact;
    });
  }
}

function associate(existing: RawArtifactRef, sourceId: string, jobId: string): RawArtifactRef {
  return {
    ...existing,
    sourceIds: uniqueAppend(existing.sourceIds, sourceId),
    acquisitionJobIds: uniqueAppend(existing.acquisitionJobIds, jobId),
  };
}

function uniqueAppend(values: string[], value: string): string[] {
  return values.includes(value) ? values : [...values, value];
}

function canonicalizeUrl(value: string): string {
  const url = new URL(value);
  url.search = "";
  url.hash = "";
  return url.toString();
}

async function readIndex(indexPath: string): Promise<RawArtifactIndex> {
  try {
    const parsed: unknown = JSON.parse(await readFile(indexPath, "utf8"));
    if (!isRawArtifactIndex(parsed)) {
      throw new Error("raw-artifact-index.json has invalid contents");
    }
    return parsed;
  } catch (error: unknown) {
    if (hasErrorCode(error, "ENOENT")) {
      return { artifactsBySha256: {} };
    }
    throw error;
  }
}

function isRawArtifactIndex(value: unknown): value is RawArtifactIndex {
  return typeof value === "object" && value !== null && !Array.isArray(value) &&
    "artifactsBySha256" in value && typeof value.artifactsBySha256 === "object" &&
    value.artifactsBySha256 !== null && !Array.isArray(value.artifactsBySha256);
}

async function writeArtifactMetadata(
  artifact: RawArtifactRef,
  directory: string,
  fileName = artifact.rawRef ? path.basename(artifact.rawRef) : undefined,
): Promise<void> {
  await writeJsonAtomically(path.join(directory, "source.json"), {
    artifactId: artifact.artifactId,
    sourceIds: artifact.sourceIds,
    acquisitionJobIds: artifact.acquisitionJobIds,
    ...(artifact.canonicalUrl === undefined ? {} : { canonicalUrl: artifact.canonicalUrl }),
  });
  await writeJsonAtomically(path.join(directory, "request.json"), {
    ...(artifact.canonicalUrl === undefined ? {} : { canonicalUrl: artifact.canonicalUrl }),
  });
  await writeJsonAtomically(path.join(directory, "response.json"), {
    rawSha256: artifact.rawSha256,
    mimeType: artifact.mimeType,
    retentionStatus: artifact.retentionStatus,
  });
  const checksumTarget = fileName && artifact.retentionStatus === "retained"
    ? `files/${fileName}`
    : "metadata-only";
  await writeFile(
    path.join(directory, "checksums.sha256"),
    `${artifact.rawSha256}  ${checksumTarget}\n`,
    "utf8",
  );
}

function artifactDirectoryFor(webRaw: string, artifact: RawArtifactRef): string {
  const domain = artifact.canonicalUrl ? new URL(artifact.canonicalUrl).hostname : "unknown";
  const initialJobId = artifact.acquisitionJobIds[0];
  if (!initialJobId) {
    throw new Error("Raw artifact has no acquisition job association");
  }
  return path.join(webRaw, domain, initialJobId, artifact.artifactId);
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
  throw new Error("Timed out acquiring raw artifact index lock; operator recovery is required");
}

function hasErrorCode(error: unknown, code: string): boolean {
  return typeof error === "object" && error !== null && "code" in error && error.code === code;
}
