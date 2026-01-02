/**
 * Global Test Setup
 *
 * Runs once before all tests to check external dependencies.
 */

import { checkKeycloakAvailable } from './keycloak-check.js';

export async function setup(): Promise<void> {
  console.log('\n=== Test Environment Check ===\n');

  // Check Keycloak availability
  const keycloakAvailable = await checkKeycloakAvailable();
  if (keycloakAvailable) {
    console.log('Keycloak: Available (testnet realm configured)');
  } else {
    console.log('Keycloak: Not available (auth tests will be skipped)');
  }

  // Check for IRC server
  const ircHost = process.env.IRC_HOST ?? 'localhost';
  const ircPort = process.env.IRC_PORT ?? '6667';
  console.log(`IRC Server: ${ircHost}:${ircPort}`);

  console.log('\n==============================\n');
}

export async function teardown(): Promise<void> {
  // Cleanup if needed
}
