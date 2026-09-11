import type { ExtensionDiagnostics } from "./load.js";

export type ExtensionProbeResult = {
  ready: boolean;
  approvedIds: string[];
  loadedIds: string[];
  registeredTools: string[];
  hooks: string[];
  failures: ExtensionDiagnostics["failed"];
};

/** Convert native loader diagnostics into a stable probe record for reports. */
export function summarizeExtensionProbe(diagnostics: ExtensionDiagnostics, approvedIds: string[]): ExtensionProbeResult {
  const approved = [...new Set(approvedIds)].sort();
  const loadedIds = diagnostics.loaded.map((item) => item.id).sort();
  const ready = diagnostics.ready && loadedIds.length === approved.length && loadedIds.every((id, index) => id === approved[index]);
  return {
    ready,
    approvedIds: approved,
    loadedIds,
    registeredTools: [...new Set(diagnostics.registeredTools)].sort(),
    hooks: [...new Set(diagnostics.hooks)].sort(),
    failures: diagnostics.failed.map((failure) => ({ ...failure })),
  };
}
