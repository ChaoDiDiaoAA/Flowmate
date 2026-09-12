import { describe, expect, it } from "vitest";
import { createControlledProvider, hashPiModelConfig, modelConfigEvidence, snapshotPiModel } from "../../packages/runtime-pi/src/index.ts";

describe("Pi model configuration evidence", () => {
  it("projects the resolved model without credentials or URL query secrets", () => {
    const provider = createControlledProvider([{ text: "done" }]);
    try {
      const model = { ...provider.model, baseUrl: "https://user:secret@example.test/v1?api_key=hidden#fragment", headers: { authorization: "Bearer hidden" } };
      const snapshot = snapshotPiModel(model);
      expect(snapshot.baseUrl).toBe("https://example.test/v1");
      expect(JSON.stringify(snapshot)).not.toContain("hidden");
      expect(snapshot.session).toEqual({ autoCompactionEnabled: false, autoRetryEnabled: false });
      expect(hashPiModelConfig(snapshot)).toMatch(/^[a-f0-9]{64}$/);
    } finally {
      provider.close();
    }
  });

  it("removes nested credential-shaped fields from optional Pi metadata", () => {
    const provider = createControlledProvider([{ text: "done" }]);
    try {
      const model = {
        ...provider.model,
        compat: { headers: { authorization: "Bearer nested-secret" }, endpointUrl: "https://example.test/v1?token=nested-secret", keep: "safe" },
        samplingParams: { apiKey: "nested-secret", temperature: 0.1 },
      };
      const snapshot = snapshotPiModel(model);
      expect(JSON.stringify(snapshot)).not.toContain("nested-secret");
      expect(snapshot.compat).toMatchObject({ keep: "safe" });
      expect(snapshot.samplingParams).toMatchObject({ temperature: 0.1 });
    } finally {
      provider.close();
    }
  });

  it("changes only when the sanitized Pi model snapshot changes", () => {
    const provider = createControlledProvider([{ text: "done" }]);
    try {
      const first = modelConfigEvidence(provider.model);
      const second = modelConfigEvidence({ ...provider.model, maxTokens: provider.model.maxTokens + 1 });
      expect(first.hash).not.toBe(second.hash);
      expect(first.snapshot.provider).toBe(provider.model.provider);
      expect(first.snapshot.modelId).toBe(provider.model.id);
    } finally {
      provider.close();
    }
  });
});
