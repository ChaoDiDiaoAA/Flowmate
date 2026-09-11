import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const require = createRequire(import.meta.url);

export type PiCapabilitySupport = {
  nativeAgentTool: "verified" | "unknown";
  toolCallHook: "verified" | "unknown";
  childSession: "verified" | "unknown";
  rpcExtensionBinding: "verified" | "unknown";
  resourceAllowlist: "verified" | "unknown";
};

export type PiCompatibilityReport = {
  packages: Record<string, string | null>;
  nodeVersion: string;
  capabilities: PiCapabilitySupport;
  errors: string[];
};

function packageVersion(packageName: string): string | null {
  try {
    // These ESM packages expose only an `import` condition for their package
    // root. `import.meta.resolve` follows that condition; the explicit entry
    // fallback handles the plugin, whose package does not export its root.
    const resolved = (() => {
      try { return fileURLToPath(import.meta.resolve(packageName)); } catch { return require.resolve(`${packageName}/dist/index.js`); }
    })();
    const entry = resolved;
    let directory = dirname(entry);
    for (;;) {
      try {
        const manifest = JSON.parse(readFileSync(join(directory, "package.json"), "utf8")) as { name?: unknown; version?: unknown };
        if (manifest.name === packageName && typeof manifest.version === "string") return manifest.version;
      } catch {
        // Keep walking until the package root is reached.
      }
      const parent = dirname(directory);
      if (parent === directory) return null;
      directory = parent;
    }
  } catch {
    return null;
  }
}

/**
 * Report the versions and capability evidence available to this process. The
 * report is diagnostic metadata; it does not claim a capability merely because
 * a package can be resolved.
 */
export function inspectPiCompatibility(): PiCompatibilityReport {
  const packages = {
    "@earendil-works/pi-ai": packageVersion("@earendil-works/pi-ai"),
    "@earendil-works/pi-coding-agent": packageVersion("@earendil-works/pi-coding-agent"),
    "@tintinweb/pi-subagents": packageVersion("@tintinweb/pi-subagents"),
  };
  const errors: string[] = [];
  for (const [name, version] of Object.entries(packages)) if (!version) errors.push(`PACKAGE_UNAVAILABLE:${name}`);
  return {
    packages,
    nodeVersion: process.version,
    capabilities: {
      nativeAgentTool: packages["@tintinweb/pi-subagents"] ? "verified" : "unknown",
      toolCallHook: packages["@earendil-works/pi-coding-agent"] ? "verified" : "unknown",
      childSession: packages["@tintinweb/pi-subagents"] ? "verified" : "unknown",
      rpcExtensionBinding: packages["@earendil-works/pi-coding-agent"] ? "verified" : "unknown",
      resourceAllowlist: packages["@earendil-works/pi-coding-agent"] ? "verified" : "unknown",
    },
    errors,
  };
}
