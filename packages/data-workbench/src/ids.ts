import { mkdir, readFile, rename, rmdir, unlink, writeFile } from "node:fs/promises";
import path from "node:path";
import type { DataWorkbenchConfig } from "./config.js";

type IdKind = "source" | "artifact" | "knowledge" | "sample" | "business" | "acquisition";
type SequentialIdKind = Exclude<IdKind, "acquisition">;

interface IdCounters {
  source: number;
  artifact: number;
  knowledge: number;
  sample: number;
  business: number;
  acquisition: Record<string, number>;
}

export interface IdAllocator {
  next(kind: IdKind): Promise<string>;
}

const prefixes: Record<SequentialIdKind, string> = {
  source: "SRC",
  artifact: "ART",
  knowledge: "KNOW",
  sample: "SAMPLE",
  business: "BIZ",
};

const lockRetryDelayMs = 10;
const lockRetryLimit = 100;

function hasErrorCode(error: unknown, code: string): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    error.code === code
  );
}

function waitForLockRetry(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, lockRetryDelayMs));
}

async function acquireDataRootLock(lockPath: string): Promise<void> {
  for (let attempt = 0; attempt < lockRetryLimit; attempt += 1) {
    try {
      await mkdir(lockPath);
      await writeFile(
        path.join(lockPath, "owner.json"),
        `${JSON.stringify({ pid: process.pid, createdAt: new Date().toISOString() })}\n`,
        "utf8",
      );
      return;
    } catch (error: unknown) {
      if (!hasErrorCode(error, "EEXIST")) {
        throw error;
      }
      await waitForLockRetry();
    }
  }
  throw new Error(
    `Timed out acquiring ID counter lock at ${lockPath}. ` +
      `Confirm no Flowmate allocation is running, then manually remove ${lockPath} and retry.`,
  );
}

async function releaseDataRootLock(lockPath: string): Promise<void> {
  try {
    await unlink(path.join(lockPath, "owner.json"));
  } catch (error: unknown) {
    if (!hasErrorCode(error, "ENOENT")) {
      throw error;
    }
  }
  try {
    await rmdir(lockPath);
  } catch (error: unknown) {
    if (!hasErrorCode(error, "ENOENT")) {
      throw error;
    }
  }
}

function emptyCounters(): IdCounters {
  return {
    source: 0,
    artifact: 0,
    knowledge: 0,
    sample: 0,
    business: 0,
    acquisition: {},
  };
}

function parseCounters(value: unknown): IdCounters {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error("id-counters.json must contain an object");
  }
  const counters = value as Record<string, unknown>;
  const acquisition = counters.acquisition;
  const sequentialKinds: SequentialIdKind[] = [
    "source",
    "artifact",
    "knowledge",
    "sample",
    "business",
  ];

  if (
    typeof acquisition !== "object" ||
    acquisition === null ||
    Array.isArray(acquisition) ||
    sequentialKinds.some(
      (kind) => typeof counters[kind] !== "number" || !Number.isInteger(counters[kind]),
    ) ||
    Object.values(acquisition).some(
      (count) => typeof count !== "number" || !Number.isInteger(count),
    )
  ) {
    throw new Error("id-counters.json has invalid counters");
  }

  return {
    source: counters.source as number,
    artifact: counters.artifact as number,
    knowledge: counters.knowledge as number,
    sample: counters.sample as number,
    business: counters.business as number,
    acquisition: acquisition as Record<string, number>,
  };
}

function acquisitionDate(now: Date): string {
  const parts = new Intl.DateTimeFormat("en", {
    timeZone: "Asia/Shanghai",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(now);
  const valueFor = (type: Intl.DateTimeFormatPartTypes): string => {
    const value = parts.find((part) => part.type === type)?.value;
    if (value === undefined) {
      throw new Error(`Missing ${type} in acquisition date`);
    }
    return value;
  };
  return `${valueFor("year")}${valueFor("month")}${valueFor("day")}`;
}

class FileIdAllocator implements IdAllocator {
  private pending: Promise<void> = Promise.resolve();

  public constructor(private readonly dataRoot: string) {}

  public next(kind: IdKind): Promise<string> {
    const allocation = this.pending.then(() => this.allocate(kind));
    this.pending = allocation.then(
      () => undefined,
      () => undefined,
    );
    return allocation;
  }

  private async allocate(kind: IdKind): Promise<string> {
    const manifestsDirectory = path.join(this.dataRoot, "manifests");
    const countersPath = path.join(manifestsDirectory, "id-counters.json");
    await mkdir(manifestsDirectory, { recursive: true });
    const lockPath = path.join(manifestsDirectory, "id-counters.lock");
    await acquireDataRootLock(lockPath);

    try {
      let counters = emptyCounters();
      try {
        counters = parseCounters(JSON.parse(await readFile(countersPath, "utf8")));
      } catch (error: unknown) {
        if (!hasErrorCode(error, "ENOENT")) {
          throw error;
        }
      }

      let id: string;
      if (kind === "acquisition") {
        const date = acquisitionDate(new Date());
        const next = (counters.acquisition[date] ?? 0) + 1;
        counters.acquisition[date] = next;
        id = `ACQ-${date}-${next.toString().padStart(4, "0")}`;
      } else {
        const next = counters[kind] + 1;
        counters[kind] = next;
        id = `${prefixes[kind]}-${next.toString().padStart(6, "0")}`;
      }

      const temporaryPath = path.join(
        manifestsDirectory,
        `id-counters.${process.pid}.${Date.now()}.tmp`,
      );
      await writeFile(temporaryPath, `${JSON.stringify(counters, null, 2)}\n`, "utf8");
      await rename(temporaryPath, countersPath);
      return id;
    } finally {
      await releaseDataRootLock(lockPath);
    }
  }
}

export function createIdAllocator(config: DataWorkbenchConfig): IdAllocator {
  return new FileIdAllocator(config.dataRoot);
}
