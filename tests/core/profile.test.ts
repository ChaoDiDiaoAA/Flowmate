import { describe, expect, it } from "vitest";
import { resolve } from "node:path";
import { parseRuntimeProfile } from "../../packages/core/src/configuration/profile.ts";

const hash = "a".repeat(64);
const modelProfile = {
  profileId: "llm-main",
  version: "1",
  modelRef: { provider: "flowmate-provider", modelId: "model-1" },
  api: "openai-completions",
  baseUrl: "https://provider.example.invalid/v1",
  capabilities: { contextWindow: 32_000, maxOutputTokens: 2_048, inputTypes: ["text"], toolCalling: true, streaming: true },
  generation: { temperature: 0, topP: 1, thinking: "none" },
  credential: { profileId: "llm-env", source: "env", envVar: "FLOWMATE_LLM_API_KEY" },
  budget: { maxModelRequests: 6, maxToolCalls: 12, wallTimeMs: 120_000, maxKnownTokens: null, maxKnownCost: null, unknownUsagePolicy: "stop" },
  purpose: { environment: "local-test", roles: ["invoice-extractor"], allowedSampleIds: ["SYN-001"] },
} as const;

describe("runtime profile configuration", () => {
  it("resolves credential and models paths from the profile directory", () => {
    const profile = parseRuntimeProfile({
      profileId: "live-main",
      mode: "live",
      environment: "local-test",
      available: true,
      modelProfileHash: hash,
      modelRef: { provider: "flowmate-provider", modelId: "model-1" },
      authPath: "private/auth.json",
      modelsPath: "private/models.json",
      allowedSampleIds: ["SYN-001"],
    }, "D:/flowmate/config/profiles");

    expect(profile).toMatchObject({
      authPath: resolve("D:/flowmate/config/profiles", "private/auth.json"),
      modelsPath: resolve("D:/flowmate/config/profiles", "private/models.json"),
      modelRef: { provider: "flowmate-provider", modelId: "model-1" },
    });
  });

  it("rejects unknown fields and incomplete live credentials", () => {
    expect(() => parseRuntimeProfile({
      profileId: "bad",
      mode: "live",
      environment: "local-test",
      available: true,
      modelProfileHash: hash,
      modelRef: { provider: "p", modelId: "m" },
      unexpected: true,
    }, "D:/flowmate/config")).toThrow("RUNTIME_PROFILE_INVALID");
  });

  it("uses the embedded model profile as the effective model reference and verifies its hash", () => {
    const parsed = parseRuntimeProfile({
      profileId: "live-main",
      mode: "live",
      environment: "local-test",
      available: false,
      modelProfile,
      modelsPath: "private/models.json",
    }, "D:/flowmate/config");
    expect(parsed.modelRef).toEqual(modelProfile.modelRef);
    expect(parsed.modelProfile?.baseUrl).toBe(modelProfile.baseUrl);
    expect(parsed.modelProfileHash).toMatch(/^[a-f0-9]{64}$/);
    expect(() => parseRuntimeProfile({
      profileId: "live-main",
      mode: "live",
      environment: "local-test",
      available: false,
      modelProfileHash: hash,
      modelProfile,
      modelsPath: "private/models.json",
    }, "D:/flowmate/config")).toThrow("RUNTIME_PROFILE_MODEL_HASH_MISMATCH");
  });
});
