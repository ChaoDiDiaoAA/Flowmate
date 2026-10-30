import { defineConfig } from '@playwright/test';
import { join } from 'node:path';

// Only the explicit console runner selects this file; daily discovery does not.
export default defineConfig({
  testDir: import.meta.dirname,
  testMatch: 'windows-service.acceptance.ts',
  fullyParallel: false,
  workers: 1,
  retries: 0,
  timeout: 240_000,
  globalTimeout: 600_000,
  reporter: 'line',
  outputDir: join(import.meta.dirname, '../../test-results/windows-service-acceptance'),
  use: { trace: 'off', screenshot: 'off', video: 'off' },
});
