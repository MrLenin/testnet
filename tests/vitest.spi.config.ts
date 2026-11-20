import { defineConfig } from 'vitest/config';

// Config for the throwaway-Keycloak SPI integration tests (src/keycloak-spi).
// Deliberately NO setupFiles: the default config's setup logs into the bed's
// IRC network, which these tests must never touch.
export default defineConfig({
  test: {
    globals: true,
    testTimeout: 60000,
    hookTimeout: 30000,
    include: ['src/keycloak-spi/**/*.test.ts'],
    pool: 'forks',
    poolOptions: { forks: { singleFork: true } },
    fileParallelism: false,
    reporters: ['default'],
  },
});
