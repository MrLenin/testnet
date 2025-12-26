import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    globals: true,
    testTimeout: 30000, // IRC operations can be slow
    hookTimeout: 30000,
    include: ['src/**/*.test.ts'],
    reporters: ['verbose'],
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
