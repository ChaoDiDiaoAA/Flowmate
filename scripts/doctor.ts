import { access, mkdtemp, readFile, rm } from "node:fs/promises";
import { constants } from "node:fs";
import { execFile } from "node:child_process";
import { join, dirname } from "node:path";
import { tmpdir } from "node:os";
import { pathToFileURL } from "node:url";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

export type CheckStatus = "ready" | "warning" | "blocked";

export type EnvironmentCheck = {
  id: string;
  status: CheckStatus;
  message: string;
};

export type EnvironmentReport = {
  node: { version: string; supported: boolean };
  npm: { version: string; available: boolean };
  electron: { version: string | null; available: boolean };
  sqlite: { driverVersion: string | null; sqliteVersion: string | null; available: boolean };
  dependencies: Record<string, string | null>;
  checks: EnvironmentCheck[];
};

export type DoctorOptions = {
  cwd?: string;
  env?: NodeJS.ProcessEnv;
};

async function commandVersion(command: string, args: string[], env: NodeJS.ProcessEnv): Promise<string | null> {
  try {
    const result = await execFileAsync(command, args, {
      env,
      windowsHide: true,
      timeout: 5_000,
    });
    const version = result.stdout.trim();
    return version.length > 0 ? version : null;
  } catch {
    return null;
  }
}

async function readable(path: string): Promise<boolean> {
  try {
    await access(path, constants.R_OK);
    return true;
  } catch {
    return false;
  }
}

async function packageVersion(cwd: string, packageName: string): Promise<string | null> {
  try {
    const manifest = JSON.parse(await readFile(join(cwd, "node_modules", ...packageName.split("/"), "package.json"), "utf8")) as { version?: unknown };
    return typeof manifest.version === "string" ? manifest.version : null;
  } catch {
    return null;
  }
}

async function probeSqlite(cwd: string): Promise<{ driverVersion: string | null; sqliteVersion: string | null; available: boolean }> {
  let root: string | undefined;
  try {
    root = await mkdtemp(join(tmpdir(), "flowmate-doctor-"));
    const core = await import("@flowmate/core");
    const db = core.openDatabase(root);
    try {
      const row = db.prepare("SELECT sqlite_version() AS version").get() as { version?: unknown } | undefined;
      return {
        driverVersion: await packageVersion(cwd, "better-sqlite3"),
        sqliteVersion: typeof row?.version === "string" ? row.version : null,
        available: true,
      };
    } finally {
      db.close();
    }
  } catch {
    return { driverVersion: await packageVersion(cwd, "better-sqlite3"), sqliteVersion: null, available: false };
  } finally {
    if (root) await rm(root, { recursive: true, force: true });
  }
}

export async function inspectEnvironment(options: DoctorOptions = {}): Promise<EnvironmentReport> {
  const cwd = options.cwd ?? process.cwd();
  const env = { ...process.env, ...(options.env ?? {}) };
  const nodeVersion = process.version;
  const nodeMajor = Number.parseInt(nodeVersion.slice(1).split(".")[0] ?? "0", 10);
  const npmCommand = process.platform === "win32" ? "npm.cmd" : "npm";
  const npmCli = join(dirname(process.execPath), "node_modules", "npm", "bin", "npm-cli.js");
  const npmVersion = await commandVersion(
    process.platform === "win32" && await readable(npmCli) ? process.execPath : npmCommand,
    process.platform === "win32" && await readable(npmCli) ? [npmCli, "--version"] : ["--version"],
    env,
  );
  const checks: EnvironmentCheck[] = [];
  const dependencyNames = [
    "@earendil-works/pi-ai",
    "@earendil-works/pi-coding-agent",
    "@earendil-works/pi-tui",
    "@tintinweb/pi-subagents",
    "better-sqlite3",
    "electron",
    "electron-vite",
    "typescript",
    "tsx",
    "vitest",
    "zod",
    "typebox",
  ];
  const dependencies = Object.fromEntries(await Promise.all(dependencyNames.map(async (name) => [name, await packageVersion(cwd, name)] as const)));
  const electronVersion = dependencies.electron;
  const sqlite = await probeSqlite(cwd);
  let runtimeCompatibility: { packages: Record<string, string | null>; errors: string[] } | null = null;
  try {
    const runtime = await import("@flowmate/runtime-pi");
    runtimeCompatibility = runtime.inspectPiCompatibility();
  } catch (error) {
    runtimeCompatibility = { packages: {}, errors: [error instanceof Error ? error.message : "runtime compatibility probe failed"] };
  }

  checks.push({
    id: "workspace",
    status: await readable(`${cwd}/package.json`) ? "ready" : "blocked",
    message: await readable(`${cwd}/package.json`)
      ? "workspace package manifest is readable"
      : "workspace package.json is missing",
  });
  checks.push({
    id: "lockfile",
    status: await readable(`${cwd}/package-lock.json`) ? "ready" : "warning",
    message: await readable(`${cwd}/package-lock.json`)
      ? "npm lockfile is readable"
      : "npm lockfile is not present yet",
  });

  const manifestPath = `${cwd}/package.json`;
  let manifestValid = false;
  try {
    const manifest = JSON.parse(await readFile(manifestPath, "utf8")) as {
      workspaces?: unknown;
      scripts?: Record<string, unknown>;
    };
    manifestValid = Array.isArray(manifest.workspaces) && typeof manifest.scripts === "object";
  } catch {
    manifestValid = false;
  }
  checks.push({
    id: "manifest",
    status: manifestValid ? "ready" : "blocked",
    message: manifestValid ? "workspace and scripts are declared" : "package manifest is invalid",
  });
  checks.push({
    id: "electron",
    status: electronVersion ? "ready" : "blocked",
    message: electronVersion ? `Electron package ${electronVersion} is readable` : "Electron package is unavailable",
  });
  checks.push({
    id: "sqlite",
    status: sqlite.available ? "ready" : "blocked",
    message: sqlite.available
      ? `better-sqlite3 ${sqlite.driverVersion ?? "unknown"} opened SQLite ${sqlite.sqliteVersion ?? "unknown"}`
      : "better-sqlite3 could not open an isolated database",
  });
  checks.push({
    id: "pi-runtime",
    status: runtimeCompatibility && runtimeCompatibility.errors.length === 0 ? "ready" : "blocked",
    message: runtimeCompatibility && runtimeCompatibility.errors.length === 0
      ? "Pi SDK and native subagent package are resolvable"
      : `Pi runtime compatibility probe failed: ${runtimeCompatibility?.errors.join(", ") ?? "unavailable"}`,
  });

  return {
    node: { version: nodeVersion, supported: nodeMajor >= 22 },
    npm: { version: npmVersion ?? "unavailable", available: npmVersion !== null },
    electron: { version: electronVersion ?? null, available: electronVersion !== null },
    sqlite,
    dependencies,
    checks,
  };
}

function printReport(report: EnvironmentReport): void {
  console.log(`Node: ${report.node.version} (${report.node.supported ? "supported" : "unsupported"})`);
  console.log(`npm: ${report.npm.version}`);
  console.log(`Electron: ${report.electron.version ?? "unavailable"}`);
  console.log(`SQLite: ${report.sqlite.sqliteVersion ?? "unavailable"} (better-sqlite3 ${report.sqlite.driverVersion ?? "unavailable"})`);
  for (const check of report.checks) {
    console.log(`[${check.status}] ${check.id}: ${check.message}`);
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const report = await inspectEnvironment();
  printReport(report);
  if (!report.node.supported || !report.npm.available || report.checks.some((check) => check.status === "blocked")) {
    process.exitCode = 1;
  }
}
