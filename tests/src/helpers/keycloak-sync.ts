/**
 * Keycloak Synchronization Helpers
 *
 * Provides polling utilities for waiting on Keycloak state changes.
 * Replaces fixed timeouts with proper condition-based waiting.
 */

import { waitForCondition } from './cap-bundles.js';

/** Keycloak API configuration */
const KEYCLOAK_BASE = process.env.KEYCLOAK_URL || 'http://localhost:8080';
const KEYCLOAK_REALM = process.env.KEYCLOAK_REALM || 'irc';

/** Default timeouts for Keycloak operations */
const DEFAULT_TIMEOUTS = {
  /** Time to wait for attribute sync (default 10s) */
  attributeSync: 10000,
  /** Time to wait for group membership changes (default 10s) */
  groupSync: 10000,
  /** Poll interval between checks (default 500ms) */
  pollInterval: 500,
};

/**
 * Keycloak user representation (partial)
 */
interface KeycloakUser {
  id: string;
  username: string;
  email?: string;
  enabled: boolean;
  attributes?: Record<string, string[]>;
  groups?: string[];
}

/**
 * Get a Keycloak user by username.
 *
 * @param adminToken - Admin bearer token
 * @param username - Username to look up
 * @returns User object or null if not found
 */
async function getKeycloakUser(
  adminToken: string,
  username: string
): Promise<KeycloakUser | null> {
  const url = `${KEYCLOAK_BASE}/admin/realms/${KEYCLOAK_REALM}/users?username=${encodeURIComponent(username)}&exact=true`;

  const response = await fetch(url, {
    headers: {
      'Authorization': `Bearer ${adminToken}`,
      'Content-Type': 'application/json',
    },
  });

  if (!response.ok) {
    throw new Error(`Keycloak API error: ${response.status} ${response.statusText}`);
  }

  const users: KeycloakUser[] = await response.json();
  return users[0] || null;
}

/**
 * Get a Keycloak user's group memberships.
 *
 * @param adminToken - Admin bearer token
 * @param userId - User ID (not username)
 * @returns Array of group paths
 */
async function getKeycloakUserGroups(
  adminToken: string,
  userId: string
): Promise<string[]> {
  const url = `${KEYCLOAK_BASE}/admin/realms/${KEYCLOAK_REALM}/users/${userId}/groups`;

  const response = await fetch(url, {
    headers: {
      'Authorization': `Bearer ${adminToken}`,
      'Content-Type': 'application/json',
    },
  });

  if (!response.ok) {
    throw new Error(`Keycloak API error: ${response.status} ${response.statusText}`);
  }

  const groups: { path: string }[] = await response.json();
  return groups.map(g => g.path);
}

/**
 * Wait for a Keycloak user attribute to have an expected value.
 *
 * Replaces fixed timeouts with proper polling:
 * ```typescript
 * // Before:
 * await new Promise(r => setTimeout(r, 2000));
 * const user = await getKeycloakUser(...);
 * expect(user.attributes.irc_account[0]).toBe(account);
 *
 * // After:
 * await waitForKeycloakAttribute(token, username, 'irc_account', account);
 * ```
 *
 * @param adminToken - Keycloak admin bearer token
 * @param username - Keycloak username
 * @param attributeName - Attribute name to check
 * @param expectedValue - Expected value (string for exact match, function for custom check)
 * @param timeout - Optional timeout in ms (default 10000)
 * @throws Error if attribute doesn't match within timeout
 *
 * @example
 * ```typescript
 * // Exact match
 * await waitForKeycloakAttribute(token, 'testuser', 'irc_account', 'ircaccount123');
 *
 * // Predicate match
 * await waitForKeycloakAttribute(token, 'testuser', 'irc_channels',
 *   value => value.includes('#mychannel'));
 *
 * // Check attribute is removed
 * await waitForKeycloakAttribute(token, 'testuser', 'old_attr', undefined);
 * ```
 */
export async function waitForKeycloakAttribute(
  adminToken: string,
  username: string,
  attributeName: string,
  expectedValue: string | undefined | ((value: string | undefined) => boolean),
  timeout: number = DEFAULT_TIMEOUTS.attributeSync
): Promise<void> {
  await waitForCondition(
    async () => {
      const user = await getKeycloakUser(adminToken, username);
      if (!user) return false;

      const values = user.attributes?.[attributeName];
      const currentValue = values?.[0]; // Keycloak stores as array

      if (typeof expectedValue === 'function') {
        return expectedValue(currentValue) ? true : false;
      } else if (expectedValue === undefined) {
        // Expect attribute to not exist or be empty
        return (!values || values.length === 0) ? true : false;
      } else {
        return currentValue === expectedValue ? true : false;
      }
    },
    {
      timeoutMs: timeout,
      pollIntervalMs: DEFAULT_TIMEOUTS.pollInterval,
      description: `Keycloak attribute ${attributeName} for ${username}`,
    }
  );
}

/**
 * Wait for a Keycloak user to be a member of (or not a member of) a group.
 *
 * @param adminToken - Keycloak admin bearer token
 * @param username - Keycloak username
 * @param groupPath - Group path (e.g., '/irc-channels/mychannel')
 * @param shouldBeMember - Whether user should be a member (true) or not (false)
 * @param timeout - Optional timeout in ms (default 10000)
 * @throws Error if membership state doesn't match within timeout
 *
 * @example
 * ```typescript
 * // Wait for user to join group
 * await waitForKeycloakGroup(token, 'testuser', '/irc-channels/test', true);
 *
 * // Wait for user to leave group
 * await waitForKeycloakGroup(token, 'testuser', '/irc-channels/test', false);
 * ```
 */
export async function waitForKeycloakGroup(
  adminToken: string,
  username: string,
  groupPath: string,
  shouldBeMember: boolean,
  timeout: number = DEFAULT_TIMEOUTS.groupSync
): Promise<void> {
  await waitForCondition(
    async () => {
      const user = await getKeycloakUser(adminToken, username);
      if (!user) return false;

      const groups = await getKeycloakUserGroups(adminToken, user.id);
      const isMember = groups.includes(groupPath);

      return isMember === shouldBeMember ? true : false;
    },
    {
      timeoutMs: timeout,
      pollIntervalMs: DEFAULT_TIMEOUTS.pollInterval,
      description: `Keycloak group ${groupPath} membership for ${username}`,
    }
  );
}

/**
 * Wait for a Keycloak user to exist.
 *
 * Useful when testing auto-provisioning via SASL OAUTHBEARER.
 *
 * @param adminToken - Keycloak admin bearer token
 * @param username - Keycloak username to check for
 * @param timeout - Optional timeout in ms (default 10000)
 * @returns The user object once found
 *
 * @example
 * ```typescript
 * // Perform SASL auth that creates user
 * await authenticateSaslOAuthBearer(client, newUserToken);
 *
 * // Wait for user to be created in Keycloak
 * const user = await waitForKeycloakUser(token, 'newuser');
 * expect(user.enabled).toBe(true);
 * ```
 */
export async function waitForKeycloakUser(
  adminToken: string,
  username: string,
  timeout: number = DEFAULT_TIMEOUTS.attributeSync
): Promise<KeycloakUser> {
  return waitForCondition(
    async () => {
      const user = await getKeycloakUser(adminToken, username);
      return user || false;
    },
    {
      timeoutMs: timeout,
      pollIntervalMs: DEFAULT_TIMEOUTS.pollInterval,
      description: `Keycloak user ${username} to exist`,
    }
  );
}

/**
 * Wait for a Keycloak user to have a specific enabled state.
 *
 * @param adminToken - Keycloak admin bearer token
 * @param username - Keycloak username
 * @param enabled - Expected enabled state
 * @param timeout - Optional timeout in ms (default 10000)
 *
 * @example
 * ```typescript
 * // Wait for user to be disabled
 * await waitForKeycloakEnabled(token, 'testuser', false);
 * ```
 */
export async function waitForKeycloakEnabled(
  adminToken: string,
  username: string,
  enabled: boolean,
  timeout: number = DEFAULT_TIMEOUTS.attributeSync
): Promise<void> {
  await waitForCondition(
    async () => {
      const user = await getKeycloakUser(adminToken, username);
      return user?.enabled === enabled ? true : false;
    },
    {
      timeoutMs: timeout,
      pollIntervalMs: DEFAULT_TIMEOUTS.pollInterval,
      description: `Keycloak user ${username} enabled=${enabled}`,
    }
  );
}

/**
 * Get an admin token for Keycloak API access.
 *
 * Uses client credentials flow with the configured admin client.
 *
 * @returns Admin bearer token
 * @throws Error if authentication fails
 */
export async function getKeycloakAdminToken(): Promise<string> {
  const clientId = process.env.KEYCLOAK_ADMIN_CLIENT || 'admin-cli';
  const clientSecret = process.env.KEYCLOAK_ADMIN_SECRET;
  const adminUser = process.env.KEYCLOAK_ADMIN_USER || 'admin';
  const adminPass = process.env.KEYCLOAK_ADMIN_PASS || 'admin';

  const tokenUrl = `${KEYCLOAK_BASE}/realms/master/protocol/openid-connect/token`;

  // Try client credentials first, fall back to password grant
  let body: string;
  if (clientSecret) {
    body = new URLSearchParams({
      grant_type: 'client_credentials',
      client_id: clientId,
      client_secret: clientSecret,
    }).toString();
  } else {
    body = new URLSearchParams({
      grant_type: 'password',
      client_id: clientId,
      username: adminUser,
      password: adminPass,
    }).toString();
  }

  const response = await fetch(tokenUrl, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded',
    },
    body,
  });

  if (!response.ok) {
    throw new Error(`Failed to get Keycloak admin token: ${response.status}`);
  }

  const data: { access_token: string } = await response.json();
  return data.access_token;
}

/**
 * Get an OAuth token for a Keycloak user (for SASL OAUTHBEARER).
 *
 * @param username - Keycloak username
 * @param password - Keycloak password
 * @returns Bearer token for the user
 * @throws Error if authentication fails
 */
export async function getKeycloakUserToken(
  username: string,
  password: string
): Promise<string> {
  const clientId = process.env.KEYCLOAK_IRC_CLIENT || 'irc-client';
  const tokenUrl = `${KEYCLOAK_BASE}/realms/${KEYCLOAK_REALM}/protocol/openid-connect/token`;

  const body = new URLSearchParams({
    grant_type: 'password',
    client_id: clientId,
    username,
    password,
  }).toString();

  const response = await fetch(tokenUrl, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded',
    },
    body,
  });

  if (!response.ok) {
    const text = await response.text();
    throw new Error(`Failed to get Keycloak user token: ${response.status} - ${text}`);
  }

  const data: { access_token: string } = await response.json();
  return data.access_token;
}
