/**
 * Keycloak Availability Check
 *
 * This module provides utilities for tests to check Keycloak availability
 * and skip auth-related tests when Keycloak is not configured.
 *
 * Usage in tests:
 *   import { isKeycloakAvailable, KEYCLOAK_SKIP_REASON } from '../setup/keycloak-check.js';
 *
 *   describe.skipIf(!isKeycloakAvailable())('SASL OAUTHBEARER', () => {
 *     // Tests that require Keycloak
 *   });
 */

// Cache the result to avoid repeated network calls
let keycloakAvailable: boolean | null = null;
let keycloakChecked = false;

/**
 * Check if Keycloak is available and configured with the testnet realm.
 * Result is cached after first check.
 */
export async function checkKeycloakAvailable(): Promise<boolean> {
  if (keycloakChecked) {
    return keycloakAvailable ?? false;
  }

  const keycloakUrl = process.env.KEYCLOAK_URL ?? 'http://localhost:8080';

  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 5000);

    const res = await fetch(`${keycloakUrl}/realms/testnet`, {
      signal: controller.signal,
    });

    clearTimeout(timeout);
    keycloakAvailable = res.ok;

    if (!res.ok) {
      console.warn(`Keycloak testnet realm not configured (status: ${res.status})`);
      console.warn('Run: docker compose up -d keycloak keycloak-setup');
    }
  } catch (error) {
    keycloakAvailable = false;
    if (error instanceof Error && error.name === 'AbortError') {
      console.warn('Keycloak connection timed out');
    } else {
      console.warn('Keycloak not reachable:', (error as Error).message);
    }
    console.warn('Auth tests will be skipped. To enable:');
    console.warn('  1. Start Keycloak: docker compose up -d keycloak keycloak-setup');
    console.warn('  2. Wait for setup to complete: docker compose logs -f keycloak-setup');
  }

  keycloakChecked = true;
  return keycloakAvailable;
}

/**
 * Synchronous check for Keycloak availability.
 * Returns cached result, or false if not yet checked.
 * Call checkKeycloakAvailable() first to populate the cache.
 */
export function isKeycloakAvailable(): boolean {
  return keycloakAvailable ?? false;
}

/**
 * Skip reason for tests that require Keycloak.
 */
export const KEYCLOAK_SKIP_REASON = 'Keycloak not available - run: docker compose up -d keycloak keycloak-setup';

/**
 * Reset the cached state (useful for testing).
 */
export function resetKeycloakCheck(): void {
  keycloakAvailable = null;
  keycloakChecked = false;
}
