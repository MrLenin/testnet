import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    globals: true,
    testTimeout: 30000, // IRC operations can be slow
    hookTimeout: 30000,
    include: ['src/**/*.test.ts'],
    // Setup files run in the same process as tests (unlike globalSetup)
    // This ensures the Keycloak availability check is shared with test files
    setupFiles: ['./src/setup/test-setup.ts'],
    // Use custom readable reporter by default, verbose for debugging
    reporters: process.env.VITEST_VERBOSE ? ['verbose'] : ['./src/reporters/readable-reporter.ts'],
    // Run tests sequentially to avoid IRC server connection throttling
    pool: 'forks',
    poolOptions: {
      forks: {
        singleFork: true,
      },
    },
    // Also run test files sequentially
    fileParallelism: false,
  },
});
