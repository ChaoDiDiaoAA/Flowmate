import { readdir, readFile, stat } from "node:fs/promises";
import { join, relative } from "node:path";

export type BoundaryViolation = {
  rule: "contracts-no-pi" | "core-no-pi" | "renderer-no-node";
  file: string;
  dependency: string;
};

export type BoundaryReport = { violations: BoundaryViolation[] };

async function filesUnder(directory: string): Promise<string[]> {
  const result: string[] = [];
  for (const entry of await readdir(directory)) {
    const absolute = join(directory, entry);
    const details = await stat(absolute);
    if (details.isDirectory()) {
      result.push(...await filesUnder(absolute));
    } else if (/\.(?:ts|tsx|mts|cts)$/.test(entry)) {
      result.push(absolute);
    }
  }
  return result;
}

function dependenciesIn(source: string): string[] {
  const dependencies = new Set<string>();
  const pattern = /(?:from\s+|import\s*\(|require\s*\()(["'])([^"']+)\1/g;
  for (const match of source.matchAll(pattern)) {
    const dependency = match[2];
    if (dependency) dependencies.add(dependency);
  }
  return [...dependencies];
}

function isPiDependency(dependency: string): boolean {
  return dependency.startsWith("@earendil-works/pi-") || dependency === "pi" || dependency.startsWith("pi/");
}

export async function checkBoundaries(root: string): Promise<BoundaryReport> {
  const candidates = [join(root, "packages"), join(root, "apps")];
  const violations: BoundaryViolation[] = [];
  for (const directory of candidates) {
    try {
      for (const file of await filesUnder(directory)) {
        const rel = relative(root, file).replaceAll("\\", "/");
        const source = await readFile(file, "utf8");
        for (const dependency of dependenciesIn(source)) {
          if (rel.startsWith("packages/contracts/") && (isPiDependency(dependency) || dependency === "electron")) {
            violations.push({ rule: "contracts-no-pi", file: rel, dependency });
          } else if (rel.startsWith("packages/core/") && (isPiDependency(dependency) || dependency === "electron")) {
            violations.push({ rule: "core-no-pi", file: rel, dependency });
          } else if (rel.startsWith("apps/desktop/src/renderer/") && (
            dependency.startsWith("node:") || dependency === "electron" || dependency === "better-sqlite3" || dependency === "@flowmate/runtime-pi"
          )) {
            violations.push({ rule: "renderer-no-node", file: rel, dependency });
          }
        }
      }
    } catch {
      // A workspace segment may not exist while the corresponding implementation task is pending.
    }
  }
  const ruleOrder = { "contracts-no-pi": 0, "core-no-pi": 1, "renderer-no-node": 2 } as const;
  violations.sort((left, right) => ruleOrder[left.rule] - ruleOrder[right.rule] || left.file.localeCompare(right.file) || left.dependency.localeCompare(right.dependency));
  return { violations };
}

if (process.argv[1] && import.meta.url === new URL(`file://${process.argv[1].replaceAll("\\", "/")}`).href) {
  const report = await checkBoundaries(process.cwd());
  for (const violation of report.violations) {
    console.error(`${violation.rule}: ${violation.file} imports ${violation.dependency}`);
  }
  if (report.violations.length > 0) process.exitCode = 1;
}
