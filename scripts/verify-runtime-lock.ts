import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { execFile } from "node:child_process";
import { parseConfigFileTextToJson } from "typescript";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

type RuntimeLock = {
  schemaVersion: "1";
  bun?: { minimumVersion: string };
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
  bunSupported: boolean;
  bunVersion: string;
  checkedPackages: string[];
  mismatches: RuntimeLockMismatch[];
};

type VerifyOptions = { cwd?: string; lockPath?: string };

async function readJson(path: string): Promise<unknown> {
  return JSON.parse(await readFile(path, "utf8")) as unknown;
}

function readBunLock(text: string, path: string): { packages: Record<string, unknown> } {
  const parsed = parseConfigFileTextToJson(path, text);
  if (parsed.error || !parsed.config || typeof parsed.config !== "object") {
    throw new Error("bun.lock is not valid JSONC");
  }
  const packages = (parsed.config as { packages?: unknown }).packages;
  if (!packages || typeof packages !== "object" || Array.isArray(packages)) {
    throw new Error("bun.lock does not contain a package table");
  }
  return { packages: packages as Record<string, unknown> };
}

function lockedBunVersion(packages: Record<string, unknown>, packageName: string): string | null {
  const entry = packages[packageName];
  if (!Array.isArray(entry) || typeof entry[0] !== "string") return null;
  const spec = entry[0];
  const prefix = `${packageName}@`;
  if (!spec.startsWith(prefix)) return null;
  const version = spec.slice(prefix.length);
  return version && !version.startsWith("workspace:") ? version : null;
}

export async function verifyRuntimeLock(options: VerifyOptions = {}): Promise<RuntimeLockReport> {
  const cwd = options.cwd ?? process.cwd();
  const lockPath = options.lockPath ?? join(cwd, "config", "runtime-lock.json");
  const lock = (await readJson(lockPath)) as RuntimeLock;
  const nodeVersion = process.version;
  const nodeMajor = Number.parseInt(nodeVersion.slice(1).split(".")[0] ?? "0", 10);
  let bunVersion = "unavailable";
  try {
    const result = await execFileAsync(process.platform === "win32" ? "bun.exe" : "bun", ["--version"], { windowsHide: true, timeout: 5_000 });
    bunVersion = result.stdout.trim() || "unavailable";
  } catch {
    // The mismatch below remains actionable and does not expose environment values.
  }
  const mismatches: RuntimeLockMismatch[] = [];
  const checkedPackages = Object.keys(lock.packages);
  const bunLockPath = join(cwd, "bun.lock");
  const bunLock = readBunLock(await readFile(bunLockPath, "utf8"), bunLockPath);

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
    const locked = lockedBunVersion(bunLock.packages, packageName);
    if (locked !== expected) {
      mismatches.push({ packageName, expected, actual: locked ?? null, reason: "lock-version" });
    }
  }

  const minimumBun = lock.bun?.minimumVersion;
  const bunSupported = minimumBun ? compareVersions(bunVersion, minimumBun) >= 0 : bunVersion !== "unavailable";
  if (!bunSupported) {
    mismatches.push({ packageName: "bun", expected: minimumBun ?? "available", actual: bunVersion === "unavailable" ? null : bunVersion, reason: "version" });
  }

  return {
    nodeSupported: nodeMajor >= lock.node.minimumMajor,
    nodeVersion,
    bunSupported,
    bunVersion,
    checkedPackages,
    mismatches,
  };
}

function compareVersions(actual: string, expected: string): number {
  const parse = (value: string) => value.split(".").map((part) => Number.parseInt(part, 10)).map((part) => Number.isFinite(part) ? part : 0);
  const left = parse(actual);
  const right = parse(expected);
  for (let index = 0; index < 3; index += 1) {
    if ((left[index] ?? 0) !== (right[index] ?? 0)) return (left[index] ?? 0) - (right[index] ?? 0);
  }
  return 0;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const report = await verifyRuntimeLock();
  console.log(JSON.stringify(report, null, 2));
  if (!report.nodeSupported || !report.bunSupported || report.mismatches.length > 0) {
    process.exitCode = 1;
  }
}
