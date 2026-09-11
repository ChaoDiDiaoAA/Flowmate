import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import type { TestCandidate } from "@flowmate/contracts";

/**
 * The registry is deliberately a small, immutable allowlist. It is the
 * boundary between a candidate configuration and Pi's native extension
 * loader; arbitrary paths never come from a model or an IPC request.
 */
export type ExtensionDescriptor = {
  id: string;
  packageName: string;
  version: string;
  entryPath: string;
  entryHash: string;
  roles: string[];
  resourceDependencies?: string[];
};

export type ResolvedExtension = ExtensionDescriptor & {
  approvedRole: string;
};

export type ExtensionResolutionInput = Pick<TestCandidate, "extensionVersions"> & {
  role?: string;
};

export class ExtensionResolutionError extends Error {
  constructor(readonly code: "EXTENSION_NOT_REGISTERED" | "EXTENSION_VERSION_MISMATCH" | "EXTENSION_ROLE_NOT_APPROVED", message: string) {
    super(`${code}: ${message}`);
    this.name = "ExtensionResolutionError";
  }
}

export function resolveExtensions(input: ExtensionResolutionInput, catalog: ExtensionDescriptor[]): ResolvedExtension[] {
  const byId = new Map(catalog.map((item) => [item.id, item]));
  const role = input.role ?? "extractor";
  const resolved: ResolvedExtension[] = [];
  for (const [id, version] of Object.entries(input.extensionVersions)) {
    const descriptor = byId.get(id);
    if (!descriptor) throw new ExtensionResolutionError("EXTENSION_NOT_REGISTERED", `Extension is not registered: ${id}`);
    if (descriptor.version !== version) {
      throw new ExtensionResolutionError("EXTENSION_VERSION_MISMATCH", `Extension ${id} requires ${descriptor.version}, got ${version}`);
    }
    if (!descriptor.roles.includes(role)) {
      throw new ExtensionResolutionError("EXTENSION_ROLE_NOT_APPROVED", `Extension ${id} is not approved for role ${role}`);
    }
    resolved.push({ ...descriptor, entryPath: resolve(descriptor.entryPath), approvedRole: role });
  }
  return resolved;
}

export async function hashExtensionEntry(entryPath: string): Promise<string> {
  const content = await readFile(entryPath);
  return createHash("sha256").update(content).digest("hex");
}
