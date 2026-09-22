import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'node',
    include: ['tests/**/*.test.ts'],
    exclude: ['tests/**/*.integration.test.ts', 'tests/runtime-lifecycle.test.ts', 'tests/composition.test.ts', 'tests/cli-main.test.ts'],
  },
});
