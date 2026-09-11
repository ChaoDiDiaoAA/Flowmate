import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

type RuntimeLock = {
  schemaVersion: "1";
  node: { minimumMajor: number };
  packages: Record<string, string>;
  entrypoints: Record<string, string>;
};

export type RuntimeLockMismatch = {
  packageName: string;
  expected: string;
  actual: string | null;
  reason: "missing" | "version" | "lock-version";
};

export type RuntimeLockReport = {
  nodeSupported: boolean;
  nodeVersion: string;
  checkedPackages: string[];
  mismatches: RuntimeLockMismatch[];
};

type VerifyOptions = { cwd?: string; lockPath?: string };

async function readJson(path: string): Promise<unknown> {
  return JSON.parse(await readFile(path, "utf8")) as unknown;
}

export async function verifyRuntimeLock(options: VerifyOptions = {}): Promise<RuntimeLockReport> {
  const cwd = options.cwd ?? process.cwd();
  const lockPath = options.lockPath ?? join(cwd, "config", "runtime-lock.json");
  const lock = (await readJson(lockPath)) as RuntimeLock;
  const nodeVersion = process.version;
  const nodeMajor = Number.parseInt(nodeVersion.slice(1).split(".")[0] ?? "0", 10);
  const mismatches: RuntimeLockMismatch[] = [];
  const checkedPackages = Object.keys(lock.packages);
  const packageLockPath = join(cwd, "package-lock.json");
  const packageLock = (await readJson(packageLockPath)) as {
    packages?: Record<string, { version?: string }>;
  };

  for (const [packageName, expected] of Object.entries(lock.packages)) {
    const packageJsonPath = join(cwd, "node_modules", ...packageName.split("/"), "package.json");
    let actual: string | null = null;
    try {
      const manifest = (await readJson(packageJsonPath)) as { version?: unknown };
      actual = typeof manifest.version === "string" ? manifest.version : null;
    } catch {
      mismatches.push({ packageName, expected, actual: null, reason: "missing" });
      continue;
    }
    if (actual !== expected) {
      mismatches.push({ packageName, expected, actual, reason: "version" });
    }
    const locked = packageLock.packages?.[`node_modules/${packageName}`]?.version;
    if (locked !== expected) {
      mismatches.push({ packageName, expected, actual: locked ?? null, reason: "lock-version" });
    }
  }

  return {
    nodeSupported: nodeMajor >= lock.node.minimumMajor,
    nodeVersion,
    checkedPackages,
    mismatches,
  };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const report = await verifyRuntimeLock();
  console.log(JSON.stringify(report, null, 2));
  if (!report.nodeSupported || report.mismatches.length > 0) {
    process.exitCode = 1;
  }
}
