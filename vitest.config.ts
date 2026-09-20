import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['tests/**/*.test.ts'],
    passWithNoTests: false,
    pool: 'forks',
    maxWorkers: 1,
    testTimeout: 20_000,
  },
});
