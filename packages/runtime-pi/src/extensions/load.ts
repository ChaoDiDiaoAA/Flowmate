import { lstat } from "node:fs/promises";
import { DefaultResourceLoader, type ResourceLoader } from "@earendil-works/pi-coding-agent";
import { hashExtensionEntry, type ResolvedExtension } from "./registry.js";

export type ExtensionLoadRecord = {
  id: string;
  packageName: string;
  version: string;
  path: string;
  entryHash: string;
  registeredTools: string[];
  hooks: string[];
};

export type ExtensionFailure = {
  id: string;
  path: string;
  code: "EXTENSION_ENTRY_INVALID" | "EXTENSION_HASH_MISMATCH" | "EXTENSION_LOAD_FAILED";
  message: string;
};

export type ExtensionDiagnostics = {
  loader: ResourceLoader;
  loaded: ExtensionLoadRecord[];
  failed: ExtensionFailure[];
  registeredTools: string[];
  hooks: string[];
  ready: boolean;
};

export type ApprovedExtensionSessionOptions = Omit<ConstructorParameters<typeof DefaultResourceLoader>[0], "additionalExtensionPaths" | "extensionFactories">;

/**
 * Load only registry-approved entries using Pi's DefaultResourceLoader. The
 * loader still performs the native module import and ExtensionAPI factory
 * initialization; this function only supplies the trusted path set and
 * verifies the entry digest before Pi sees it.
 */
export async function loadApprovedExtensions(
  sessionOptions: ApprovedExtensionSessionOptions,
  resolved: ResolvedExtension[],
): Promise<ExtensionDiagnostics> {
  const failures: ExtensionFailure[] = [];
  const verified: ResolvedExtension[] = [];
  for (const item of resolved) {
    try {
      const stats = await lstat(item.entryPath);
      if (!stats.isFile() || stats.isSymbolicLink()) {
        failures.push({ id: item.id, path: item.entryPath, code: "EXTENSION_ENTRY_INVALID", message: "Extension entry must be a regular file" });
        continue;
      }
      const actual = await hashExtensionEntry(item.entryPath);
      if (actual !== item.entryHash) {
        failures.push({ id: item.id, path: item.entryPath, code: "EXTENSION_HASH_MISMATCH", message: `Expected ${item.entryHash}, got ${actual}` });
        continue;
      }
      verified.push(item);
    } catch (error) {
      failures.push({ id: item.id, path: item.entryPath, code: "EXTENSION_ENTRY_INVALID", message: error instanceof Error ? error.message : "Extension entry cannot be read" });
    }
  }

  const loader = new DefaultResourceLoader({
    ...sessionOptions,
    // `noExtensions` makes additionalExtensionPaths the complete set. It
    // prevents user/global/project settings from silently adding extensions.
    noExtensions: true,
    additionalExtensionPaths: verified.map((item) => item.entryPath),
  });
  await loader.reload();
  const result = loader.getExtensions();
  const byPath = new Map(verified.map((item) => [item.entryPath, item]));
  const loaded: ExtensionLoadRecord[] = [];
  for (const extension of result.extensions) {
    const descriptor = byPath.get(extension.resolvedPath);
    if (!descriptor) {
      failures.push({ id: extension.path, path: extension.resolvedPath, code: "EXTENSION_LOAD_FAILED", message: "Loaded extension is outside the approved registry" });
      continue;
    }
    loaded.push({
      id: descriptor.id,
      packageName: descriptor.packageName,
      version: descriptor.version,
      path: extension.resolvedPath,
      entryHash: descriptor.entryHash,
      registeredTools: [...extension.tools.keys()],
      hooks: [...extension.handlers.keys()],
    });
  }
  for (const error of result.errors) {
    const descriptor = verified.find((item) => item.entryPath === error.path);
    failures.push({ id: descriptor?.id ?? error.path, path: error.path, code: "EXTENSION_LOAD_FAILED", message: error.error });
  }
  const registeredTools = loaded.flatMap((item) => item.registeredTools);
  const hooks = loaded.flatMap((item) => item.hooks);
  return { loader, loaded, failed: failures, registeredTools, hooks, ready: failures.length === 0 && loaded.length === verified.length };
}
