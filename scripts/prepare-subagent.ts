import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const PACKAGE_NAME = "@tintinweb/pi-subagents";
const EXPECTED_VERSION = "0.19.0";
const require = createRequire(import.meta.url);

function sha256(value: Buffer): string {
  return createHash("sha256").update(value).digest("hex");
}

export type PreparedSubagentPackage = {
  packageName: typeof PACKAGE_NAME;
  version: string;
  packagePath: string;
  entryPath: string;
  entrySha256: string;
  patched: false;
};

/**
 * Verify the locked native plugin without modifying node_modules.
 *
 * The previous implementation patched an unrelated spawn based package at
 * install time. The selected plugin is loaded through Pi's native extension
 * loader, so preparation is intentionally a read-only integrity check.
 */
export async function prepareSubagentPackage(root = process.cwd()): Promise<PreparedSubagentPackage> {
  const entryPath = resolve(root, require.resolve(`${PACKAGE_NAME}/dist/index.js`));
  const packagePath = join(dirname(entryPath), "..", "package.json");
  const manifest = JSON.parse(await readFile(packagePath, "utf8")) as { name?: unknown; version?: unknown };
  if (manifest.name !== PACKAGE_NAME) {
    throw new Error(`PI_SUBAGENT_PACKAGE_MISMATCH: expected ${PACKAGE_NAME}, got ${String(manifest.name)}`);
  }
  if (manifest.version !== EXPECTED_VERSION) {
    throw new Error(`PI_SUBAGENT_VERSION_MISMATCH: expected ${EXPECTED_VERSION}, got ${String(manifest.version)}`);
  }
  const entry = await readFile(entryPath);
  return {
    packageName: PACKAGE_NAME,
    version: manifest.version,
    packagePath,
    entryPath,
    entrySha256: sha256(entry),
    patched: false,
  };
}

if (process.argv[1] && resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url))) {
  console.log(JSON.stringify(await prepareSubagentPackage(), null, 2));
}
