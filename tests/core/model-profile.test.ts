import { describe, expect, it } from "vitest";
import { hashModelProfile, parseModelProfile } from "../../packages/core/src/configuration/model-profile.ts";

const input = {
  profileId: "llm-main",
  version: "1",
  modelRef: { provider: "flowmate-provider", modelId: "invoice-model" },
  api: "openai-completions",
  baseUrl: "https://provider.example.invalid/v1",
  capabilities: {
    contextWindow: 32_000,
    maxOutputTokens: 2_048,
    inputTypes: ["text"],
    toolCalling: true,
    streaming: true,
  },
  generation: { temperature: 0, topP: 1, thinking: "none" },
  credential: { profileId: "llm-env", source: "env", envVar: "FLOWMATE_LLM_API_KEY" },
  budget: {
    maxModelRequests: 6,
    maxToolCalls: 12,
    wallTimeMs: 120_000,
    maxKnownTokens: null,
    maxKnownCost: null,
    unknownUsagePolicy: "stop",
  },
  purpose: { environment: "local-test", roles: ["invoice-extractor"], allowedSampleIds: ["SYN-001"] },
};

describe("ModelProfile", () => {
  it("validates the provider contract and hashes only non-secret settings", () => {
    const profile = parseModelProfile(input);
    const first = hashModelProfile(profile);
    const second = hashModelProfile(parseModelProfile({ ...input, credential: { ...input.credential, envVar: "FLOWMATE_LLM_API_KEY" } }));
    expect(first).toMatch(/^[a-f0-9]{64}$/);
    expect(second).toBe(first);
    expect(JSON.stringify(profile)).not.toContain("test-key");
  });

  it("requires an environment variable reference for env credentials", () => {
    expect(() => parseModelProfile({ ...input, credential: { profileId: "bad", source: "env" } })).toThrow("MODEL_PROFILE_INVALID");
  });

  it("does not accept API keys in the product-owned profile", () => {
    expect(() => parseModelProfile({ ...input, apiKey: "secret-value" })).toThrow("MODEL_PROFILE_INVALID");
  });
});
