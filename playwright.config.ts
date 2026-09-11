import { defineConfig } from "@playwright/test";

/**
 * Desktop tests are opt-in: they launch a built Electron application and
 * provide their own isolated data/configuration roots. Keeping the project
 * separate from the default Vitest suite prevents a browser runner from
 * silently becoming part of offline unit verification.
 */
export default defineConfig({
  testDir: "./tests/desktop",
  testMatch: "**/*.spec.ts",
  timeout: 60_000,
  expect: { timeout: 10_000 },
  fullyParallel: false,
  workers: 1,
  reporter: process.env.CI ? "line" : "list",
  use: {
    trace: "retain-on-failure",
  },
});
