import { fileURLToPath } from "node:url";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { bindChildTools } from "./child-tools.js";
import { claimPendingChildScope } from "./registry.js";
import { attachMemory } from "../memory/index.js";

/**
 * Extension loaded by the real tintinweb child Session. The parent reserves a
 * scope before the native Agent tool executes; this extension claims only the
 * exact cwd + extension path pair and then registers the two read-only tools.
 */
export default function flowmateChildExtension(pi: ExtensionAPI): void {
  let bound = false;
  pi.on("session_start", (_event, ctx) => {
    if (bound) return;
    const scope = claimPendingChildScope({
      cwd: ctx.cwd,
      extensionPath: fileURLToPath(import.meta.url),
    });
    if (!scope) return;
    const childSessionId = ctx.sessionManager.getSessionId();
    const bindings = bindChildTools({ sessionId: childSessionId, abort: () => ctx.abort() }, scope);
    const memory = attachMemory({
      sessionId: childSessionId,
      sessionManager: ctx.sessionManager,
      model: ctx.model,
      getContextUsage: () => ctx.getContextUsage(),
      setAutoCompactionEnabled: undefined,
      setAutoRetryEnabled: undefined,
    }, {
      scopeId: `child:${scope.parentIdentity.runId}:${childSessionId}`,
      kind: "child",
      jobId: scope.parentIdentity.jobId,
      runId: scope.parentIdentity.runId,
      generation: scope.parentIdentity.generation,
      candidateId: scope.parentIdentity.candidateId,
      parentScopeId: `parent:${scope.parentIdentity.runId}`,
    });
    scope.bindChildMemory(memory);
    for (const tool of bindings.tools) pi.registerTool(tool);
    pi.on("turn_start", () => {
      try {
        scope.reserveChildModelRequest();
      } catch {
        scope.revoke("child model request budget exceeded");
        ctx.abort();
      }
    });
    bound = true;
    pi.on("session_shutdown", () => {
      memory.dispose();
      scope.markChildShutdown();
    });
  });
}
