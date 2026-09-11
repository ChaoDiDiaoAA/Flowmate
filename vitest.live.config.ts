import { defineConfig, mergeConfig } from "vitest/config";
import base from "./vitest.config.js";

export default mergeConfig(base, defineConfig({
  test: {
    include: ["tests/live/**/*.test.ts"],
    exclude: [],
  },
}));
