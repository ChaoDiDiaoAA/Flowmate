import { describe, expect, it } from "vitest";
import { resolve } from "node:path";
import { parseRuntimeProfile } from "../../packages/core/src/configuration/profile.ts";

const hash = "a".repeat(64);

describe("runtime profile configuration", () => {
  it("resolves Pi-native credential and model paths from the profile directory", () => {
    const profile = parseRuntimeProfile({
      profileId: "live-main",
      mode: "live",
      environment: "local-test",
      available: true,
      modelRef: { provider: "flowmate-provider", modelId: "model-1" },
      modelConfigHash: hash,
      authPath: "private/auth.json",
      modelsPath: "private/models.json",
      allowedSampleIds: ["SYN-001"],
    }, "D:/flowmate/config/profiles");

    expect(profile).toMatchObject({
      authPath: resolve("D:/flowmate/config/profiles", "private/auth.json"),
      modelsPath: resolve("D:/flowmate/config/profiles", "private/models.json"),
      modelRef: { provider: "flowmate-provider", modelId: "model-1" },
      modelConfigHash: hash,
    });
  });

  it("allows an internal Pi provider to use native environment authentication", () => {
    expect(parseRuntimeProfile({
      profileId: "built-in",
      mode: "live",
      environment: "local-test",
      available: true,
      modelRef: { provider: "anthropic", modelId: "claude-test" },
    }, "D:/flowmate/config")).toMatchObject({ modelRef: { provider: "anthropic", modelId: "claude-test" } });
  });

  it("reads an inline profile from the unified Flowmate config shape", () => {
    expect(parseRuntimeProfile({
      manifestRoot: "frozen",
      profile: {
        profileId: "unified",
        mode: "controlled",
        environment: "local-test",
        available: true,
        modelRef: { provider: "flowmate-controlled", modelId: "controlled" },
        authPath: "private/auth.json",
      },
    }, "D:/flowmate/config")).toMatchObject({
      profileId: "unified",
      authPath: resolve("D:/flowmate/config", "private/auth.json"),
    });
  });

  it("rejects unknown fields and a live profile without a model reference", () => {
    expect(() => parseRuntimeProfile({
      profileId: "bad",
      mode: "live",
      environment: "local-test",
      available: true,
      modelConfigHash: hash,
      unexpected: true,
    }, "D:/flowmate/config")).toThrow("RUNTIME_PROFILE_INVALID");
    expect(() => parseRuntimeProfile({
      profileId: "missing-model",
      mode: "live",
      environment: "local-test",
      available: true,
    }, "D:/flowmate/config")).toThrow("RUNTIME_PROFILE_INCOMPLETE");
  });
});
