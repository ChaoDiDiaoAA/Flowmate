import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

const piCodingAgentEntry = fileURLToPath(new URL("./node_modules/@earendil-works/pi-coding-agent/dist/index.js", import.meta.url));

export default defineConfig({
  resolve: {
    // The locked Pi package exposes a conditional `types`/`import` export.
    // Vite's dependency scanner can select the declaration branch on Windows;
    // point tests at the executable ESM entry so native Pi tests exercise the
    // same SDK that the application imports at runtime.
    alias: {
      "@earendil-works/pi-coding-agent": piCodingAgentEntry,
    },
  },
  test: {
    include: ["tests/**/*.test.ts", "agent-eval/tests/**/*.test.ts"],
    exclude: ["tests/live/**"],
    passWithNoTests: true,
    environment: "node",
  },
});
