/**
 * Test Setup (runs in same process as tests)
 *
 * Unlike globalSetup which runs in a separate process,
 * setupFiles run in the same process as tests, so cached
 * state is available to test files.
 */

import { checkKeycloakAvailable } from './keycloak-check.js';

// Check Keycloak availability at module load time
// This populates the cache before any tests run
const keycloakAvailable = await checkKeycloakAvailable();

if (keycloakAvailable) {
  console.log('\nKeycloak: Available (testnet realm configured)');
} else {
  console.log('\nKeycloak: Not available (auth tests will be skipped)');
}
