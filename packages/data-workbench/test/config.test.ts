import { describe, expect, it } from "vitest";
import { resolveConfig } from "../src/config.js";

describe("resolveConfig", () => {
  it("uses the approved FlowmateData root", () => {
    expect(resolveConfig({}).dataRoot).toBe(
      "D:\\code\\agent-learn\\agent\\Flowmate\\FlowmateData",
    );
  });

  it("never allows a MinerU batch above 200", () => {
    expect(() =>
      resolveConfig({ FLOWMATE_MINERU_MAX_FILES_PER_RUN: "201" }),
    ).toThrow(/between 1 and 200/);
  });
});
