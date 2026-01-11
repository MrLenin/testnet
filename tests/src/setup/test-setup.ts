/**
 * Test Setup (runs in same process as tests)
 *
 * Unlike globalSetup which runs in a separate process,
 * setupFiles run in the same process as tests, so cached
 * state is available to test files.
 */

import { checkKeycloakAvailable } from './keycloak-check.js';
import { getGlobalCookieObserver, shutdownGlobalCookieObserver } from '../helpers/cookie-observer.js';

// Start CookieObserver for capturing activation cookies via #MrSnoopy
// This is preferred over Docker log scraping for reliability
let cookieObserverStarted = false;
try {
  await getGlobalCookieObserver();
  cookieObserverStarted = true;
  console.log('\nCookieObserver: Started (watching #MrSnoopy for cookies)');
} catch (error) {
  const errorMessage = error instanceof Error ? error.message : String(error);
  console.log('\nCookieObserver: Failed to start -', errorMessage);
  console.log('  Cookie capture will fall back to Docker log scraping');
}

// Check Keycloak availability at module load time
// This populates the cache before any tests run
const keycloakAvailable = await checkKeycloakAvailable();

if (keycloakAvailable) {
  console.log('Keycloak: Available (testnet realm configured)');
} else {
  console.log('Keycloak: Not available (auth tests will be skipped)');
}

// Cleanup CookieObserver on process exit
if (cookieObserverStarted) {
  process.on('beforeExit', async () => {
    try {
      await shutdownGlobalCookieObserver();
      console.log('\nCookieObserver: Shut down');
    } catch {
      // Ignore shutdown errors
    }
  });
}
