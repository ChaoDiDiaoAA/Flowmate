import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { describe, expect, it } from "vitest";
import { SettingsManager } from "@earendil-works/pi-coding-agent";
import { createP0ResourceLoader, inspectPiCompatibility, runtimeEventType, summarizeExtensionProbe } from "../../packages/runtime-pi/src/index.ts";

describe("runtime-pi boundaries", () => {
  it("creates a resource loader with no ambient resources", async () => {
    const root = await mkdtemp(join(tmpdir(), "flowmate-resources-boundary-"));
    try {
      const loader = createP0ResourceLoader({
        cwd: join(root, "cwd"),
        agentDir: join(root, "agent"),
        settingsManager: SettingsManager.inMemory({ defaultTools: [] }, { projectTrusted: true }),
        systemPrompt: "P0 prompt",
      });
      await loader.reload();
      expect(loader.getExtensions().extensions).toHaveLength(0);
      expect(loader.getSkills().skills).toHaveLength(0);
      expect(loader.getSystemPrompt()).toBe("P0 prompt");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("maps Pi event names and keeps extension probe output stable", () => {
    expect(runtimeEventType({ type: "tool_execution_start", toolCallId: "t", toolName: "read" } as never)).toBe("tool.started");
    const summary = summarizeExtensionProbe({
      loader: {} as never,
      loaded: [{ id: "probe-good", packageName: "fixture", version: "1", path: "probe", entryHash: "a", registeredTools: ["flowmate_probe"], hooks: ["session_start"] }],
      failed: [],
      registeredTools: ["flowmate_probe"],
      hooks: ["session_start"],
      ready: true,
    }, ["probe-good"]);
    expect(summary).toMatchObject({ ready: true, approvedIds: ["probe-good"], loadedIds: ["probe-good"] });
  });

  it("reports installed Pi package versions without crossing into business types", () => {
    const report = inspectPiCompatibility();
    expect(report.nodeVersion).toMatch(/^v\d+/);
    expect(report.packages["@earendil-works/pi-coding-agent"]).toBe("0.85.1");
    expect(report.capabilities.nativeAgentTool).toBe("verified");
  });
});
