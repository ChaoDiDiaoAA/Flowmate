import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { describe, expect, it } from "vitest";
import { SettingsManager } from "@earendil-works/pi-coding-agent";
import { createControlledProvider, createPiRuntime, hashExtensionEntry, loadApprovedExtensions, resolveExtensions } from "../../packages/runtime-pi/src/index.ts";

const identity = { jobId: "job-extension", runId: "run-extension", generation: 1, candidateId: "candidate-extension" };

async function makeExtension(root: string, id: string, markerPath: string, toolName = "flowmate_probe"): Promise<string> {
  const path = join(root, `${id}.mjs`);
  const source = `import { appendFileSync } from "node:fs";
import { Type } from "typebox";
export default function ${id.replace(/[^a-zA-Z0-9_$]/g, "_")}(pi) {
  pi.on("session_start", () => appendFileSync(${JSON.stringify(markerPath)}, "start\\n"));
  pi.on("session_shutdown", () => appendFileSync(${JSON.stringify(markerPath)}, "shutdown\\n"));
  pi.registerTool({
    name: ${JSON.stringify(toolName)}, label: "Flowmate probe", description: "Returns a synthetic probe result.",
    parameters: Type.Object({}),
    async execute() { return { content: [{ type: "text", text: "probe-ok" }], details: { probe: true } }; },
  });
}`;
  await writeFile(path, source, "utf8");
  return path;
}

async function loaderOptions(root: string) {
  return {
    cwd: join(root, "cwd"),
    agentDir: join(root, "agent"),
    settingsManager: SettingsManager.inMemory({ defaultTools: [] }, { projectTrusted: true }),
    noSkills: true,
    noPromptTemplates: true,
    noThemes: true,
    noContextFiles: true,
  } as const;
}

describe("Pi native extension boundary", () => {
  it("loads only the approved entry and runs its native tool and lifecycle hooks", async () => {
    const root = await mkdtemp(join(tmpdir(), "flowmate-pi-extension-"));
    const marker = join(root, "lifecycle.log");
    try {
      const goodPath = await makeExtension(root, "probe_good", marker);
      const forbiddenPath = await makeExtension(root, "probe_forbidden", marker, "forbidden_probe");
      const catalog = [
        { id: "probe-good", packageName: "fixture/probe-good", version: "1.0.0", entryPath: goodPath, entryHash: await hashExtensionEntry(goodPath), roles: ["extractor"] },
        { id: "probe-forbidden", packageName: "fixture/probe-forbidden", version: "1.0.0", entryPath: forbiddenPath, entryHash: await hashExtensionEntry(forbiddenPath), roles: ["extractor"] },
      ];
      const resolved = resolveExtensions({ extensionVersions: { "probe-good": "1.0.0" } }, catalog);
      const diagnostics = await loadApprovedExtensions(await loaderOptions(root), resolved);
      expect(diagnostics.ready).toBe(true);
      expect(diagnostics.loaded.map((item) => item.id)).toEqual(["probe-good"]);
      expect(diagnostics.registeredTools).toContain("flowmate_probe");
      expect(diagnostics.registeredTools).not.toContain("forbidden_probe");
      expect(diagnostics.hooks).toEqual(expect.arrayContaining(["session_start", "session_shutdown"]));

      const provider = createControlledProvider([{ toolCall: { name: "flowmate_probe", arguments: {} } }, { text: "done" }]);
      const runtime = await createPiRuntime({ cwd: join(root, "runtime"), agentDir: join(root, "runtime-agent"), identity, provider, resourceLoader: diagnostics.loader });
      try {
        expect(runtime.toolNames()).toContain("flowmate_probe");
        expect(runtime.toolNames()).not.toContain("forbidden_probe");
        await expect(runtime.run({ taskPrompt: "Run the probe." })).resolves.toMatchObject({ kind: "completed" });
      } finally {
        await runtime.close();
        provider.close();
      }
      const lifecycle = await readFile(marker, "utf8");
      expect(lifecycle).toContain("start");
      expect(lifecycle).toContain("shutdown");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("rejects an unregistered or role-incompatible extension before loading", () => {
    const descriptor = { id: "probe-good", packageName: "fixture/probe-good", version: "1.0.0", entryPath: "probe.mjs", entryHash: "a".repeat(64), roles: ["extractor"] };
    expect(() => resolveExtensions({ extensionVersions: { unknown: "1.0.0" } }, [descriptor])).toThrow("EXTENSION_NOT_REGISTERED");
    expect(() => resolveExtensions({ extensionVersions: { "probe-good": "2.0.0" } }, [descriptor])).toThrow("EXTENSION_VERSION_MISMATCH");
    expect(() => resolveExtensions({ role: "reviewer", extensionVersions: { "probe-good": "1.0.0" } }, [descriptor])).toThrow("EXTENSION_ROLE_NOT_APPROVED");
  });

  it("reports an entry digest mismatch and never passes that path to Pi", async () => {
    const root = await mkdtemp(join(tmpdir(), "flowmate-pi-extension-bad-"));
    try {
      const path = await makeExtension(root, "probe_bad", join(root, "lifecycle.log"));
      const resolved = resolveExtensions({ extensionVersions: { "probe-bad": "1.0.0" } }, [{ id: "probe-bad", packageName: "fixture/probe-bad", version: "1.0.0", entryPath: path, entryHash: createHash("sha256").update("wrong").digest("hex"), roles: ["extractor"] }]);
      const diagnostics = await loadApprovedExtensions(await loaderOptions(root), resolved);
      expect(diagnostics.ready).toBe(false);
      expect(diagnostics.loaded).toHaveLength(0);
      expect(diagnostics.failed[0]?.code).toBe("EXTENSION_HASH_MISMATCH");
      expect(diagnostics.loader.getExtensions().extensions).toHaveLength(0);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
