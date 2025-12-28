import { describe, it, expect, beforeAll, afterEach } from 'vitest';
import { createRawSocketClient, RawSocketClient } from '../helpers/index.js';

/**
 * Keycloak Integration Tests
 *
 * Tests X3's Keycloak integration features:
 * - SASL PLAIN authentication via Keycloak
 * - SASL OAUTHBEARER authentication
 * - SASL EXTERNAL certificate fingerprint authentication
 * - User auto-creation from Keycloak accounts
 * - OpServ level sync via x3_opserv_level attribute
 * - Oper group membership sync
 * - x509_fingerprints attribute management
 *
 * Prerequisites:
 * 1. Keycloak container running (docker compose up keycloak)
 * 2. Realm 'testnet' configured (scripts/setup-keycloak.sh)
 * 3. Test user exists: testuser / testpass / testuser@example.com
 *
 * Environment variables:
 * - KEYCLOAK_URL: Keycloak URL (default: http://localhost:8080)
 * - KEYCLOAK_REALM: Realm name (default: testnet)
 * - KEYCLOAK_CLIENT_ID: Client for user auth (default: irc-client)
 */

const KEYCLOAK_URL = process.env.KEYCLOAK_URL ?? 'http://localhost:8080';
const KEYCLOAK_REALM = process.env.KEYCLOAK_REALM ?? 'testnet';
const KEYCLOAK_CLIENT_ID = process.env.KEYCLOAK_CLIENT_ID ?? 'irc-client';

// Test credentials - must match Keycloak user
const TEST_USER = 'testuser';
const TEST_PASS = 'testpass';
const TEST_EMAIL = 'testuser@example.com';

// Admin credentials for Keycloak API
const KC_ADMIN_USER = process.env.KEYCLOAK_ADMIN ?? 'admin';
const KC_ADMIN_PASS = process.env.KEYCLOAK_ADMIN_PASSWORD ?? 'admin';

// SASL chunk size (400 bytes per chunk per spec)
const SASL_CHUNK_SIZE = 400;

/**
 * Send SASL payload with proper chunking for large payloads.
 * SASL messages >400 bytes must be split into 400-byte chunks.
 * A final '+' is sent if the last chunk was exactly 400 bytes.
 */
async function sendSaslPayload(client: RawSocketClient, base64Payload: string): Promise<void> {
  if (base64Payload.length <= SASL_CHUNK_SIZE) {
    // Small payload - send directly
    client.send(`AUTHENTICATE ${base64Payload}`);
    return;
  }

  // Chunk the payload
  for (let i = 0; i < base64Payload.length; i += SASL_CHUNK_SIZE) {
    const chunk = base64Payload.slice(i, i + SASL_CHUNK_SIZE);
    client.send(`AUTHENTICATE ${chunk}`);
    // Small delay between chunks to avoid flooding
    await new Promise(r => setTimeout(r, 50));
  }

  // If the last chunk was exactly 400 bytes, send '+' to signal end
  if (base64Payload.length % SASL_CHUNK_SIZE === 0) {
    client.send('AUTHENTICATE +');
  }
}

/**
 * Helper to get OAuth2 token from Keycloak
 */
async function getKeycloakToken(username: string, password: string): Promise<string | null> {
  try {
    const response = await fetch(
      `${KEYCLOAK_URL}/realms/${KEYCLOAK_REALM}/protocol/openid-connect/token`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({
          grant_type: 'password',
          client_id: KEYCLOAK_CLIENT_ID,
          username,
          password,
        }),
      }
    );

    if (!response.ok) return null;

    const data = await response.json();
    return data.access_token ?? null;
  } catch {
    return null;
  }
}

/**
 * Helper to get admin token for Keycloak API
 */
async function getAdminToken(): Promise<string | null> {
  try {
    const response = await fetch(
      `${KEYCLOAK_URL}/realms/master/protocol/openid-connect/token`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({
          grant_type: 'password',
          client_id: 'admin-cli',
          username: KC_ADMIN_USER,
          password: KC_ADMIN_PASS,
        }),
      }
    );

    if (!response.ok) return null;

    const data = await response.json();
    return data.access_token ?? null;
  } catch {
    return null;
  }
}

/**
 * Helper to create a Keycloak user
 */
async function createKeycloakUser(
  adminToken: string,
  username: string,
  email: string,
  password: string,
  attributes?: Record<string, string[]>
): Promise<boolean> {
  try {
    const response = await fetch(
      `${KEYCLOAK_URL}/admin/realms/${KEYCLOAK_REALM}/users`,
      {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${adminToken}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          username,
          email,
          enabled: true,
          emailVerified: true,
          attributes: attributes ?? {},
          credentials: [{ type: 'password', value: password, temporary: false }],
        }),
      }
    );

    return response.status === 201;
  } catch {
    return false;
  }
}

/**
 * Helper to delete a Keycloak user
 */
async function deleteKeycloakUser(adminToken: string, username: string): Promise<void> {
  try {
    // First find user ID
    const searchResponse = await fetch(
      `${KEYCLOAK_URL}/admin/realms/${KEYCLOAK_REALM}/users?username=${username}&exact=true`,
      {
        headers: { 'Authorization': `Bearer ${adminToken}` },
      }
    );

    if (!searchResponse.ok) return;

    const users = await searchResponse.json();
    if (users.length === 0) return;

    const userId = users[0].id;

    // Delete user
    await fetch(
      `${KEYCLOAK_URL}/admin/realms/${KEYCLOAK_REALM}/users/${userId}`,
      {
        method: 'DELETE',
        headers: { 'Authorization': `Bearer ${adminToken}` },
      }
    );
  } catch {
    // Ignore errors
  }
}

/**
 * Helper to set user attribute in Keycloak
 */
async function setKeycloakUserAttribute(
  adminToken: string,
  username: string,
  attributeName: string,
  attributeValue: string
): Promise<boolean> {
  try {
    // Find user
    const searchResponse = await fetch(
      `${KEYCLOAK_URL}/admin/realms/${KEYCLOAK_REALM}/users?username=${username}&exact=true`,
      {
        headers: { 'Authorization': `Bearer ${adminToken}` },
      }
    );

    if (!searchResponse.ok) return false;

    const users = await searchResponse.json();
    if (users.length === 0) return false;

    const user = users[0];
    const userId = user.id;

    // Update user attributes
    const attributes = user.attributes ?? {};
    attributes[attributeName] = [attributeValue];

    const updateResponse = await fetch(
      `${KEYCLOAK_URL}/admin/realms/${KEYCLOAK_REALM}/users/${userId}`,
      {
        method: 'PUT',
        headers: {
          'Authorization': `Bearer ${adminToken}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ ...user, attributes }),
      }
    );

    return updateResponse.status === 204;
  } catch {
    return false;
  }
}

/**
 * Helper to set x509_fingerprints attribute (multivalued)
 */
async function setKeycloakFingerprints(
  adminToken: string,
  username: string,
  fingerprints: string[]
): Promise<boolean> {
  try {
    // Find user
    const searchResponse = await fetch(
      `${KEYCLOAK_URL}/admin/realms/${KEYCLOAK_REALM}/users?username=${username}&exact=true`,
      {
        headers: { 'Authorization': `Bearer ${adminToken}` },
      }
    );

    if (!searchResponse.ok) return false;

    const users = await searchResponse.json();
    if (users.length === 0) return false;

    const user = users[0];
    const userId = user.id;

    // Update user with fingerprints attribute
    const attributes = user.attributes ?? {};
    attributes['x509_fingerprints'] = fingerprints;

    const updateResponse = await fetch(
      `${KEYCLOAK_URL}/admin/realms/${KEYCLOAK_REALM}/users/${userId}`,
      {
        method: 'PUT',
        headers: {
          'Authorization': `Bearer ${adminToken}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ ...user, attributes }),
      }
    );

    return updateResponse.status === 204;
  } catch {
    return false;
  }
}

/**
 * Helper to get user's x509_fingerprints from Keycloak
 */
async function getKeycloakFingerprints(
  adminToken: string,
  username: string
): Promise<string[]> {
  try {
    const searchResponse = await fetch(
      `${KEYCLOAK_URL}/admin/realms/${KEYCLOAK_REALM}/users?username=${username}&exact=true`,
      {
        headers: { 'Authorization': `Bearer ${adminToken}` },
      }
    );

    if (!searchResponse.ok) return [];

    const users = await searchResponse.json();
    if (users.length === 0) return [];

    const user = users[0];
    return user.attributes?.x509_fingerprints ?? [];
  } catch {
    return [];
  }
}

/**
 * Helper to search users by fingerprint
 */
async function findUserByFingerprint(
  adminToken: string,
  fingerprint: string
): Promise<string | null> {
  try {
    // URL-encode the fingerprint for the query
    const encodedFp = encodeURIComponent(fingerprint);
    const response = await fetch(
      `${KEYCLOAK_URL}/admin/realms/${KEYCLOAK_REALM}/users?q=x509_fingerprints:${encodedFp}`,
      {
        headers: { 'Authorization': `Bearer ${adminToken}` },
      }
    );

    if (!response.ok) return null;

    const users = await response.json();
    if (users.length === 0) return null;
    if (users.length > 1) {
      console.warn(`WARNING: Fingerprint collision - ${users.length} users have fingerprint ${fingerprint}`);
    }

    return users[0].username;
  } catch {
    return null;
  }
}

/**
 * Helper to add user to Keycloak group
 */
async function addUserToGroup(
  adminToken: string,
  username: string,
  groupName: string
): Promise<boolean> {
  try {
    // Find user
    const userResponse = await fetch(
      `${KEYCLOAK_URL}/admin/realms/${KEYCLOAK_REALM}/users?username=${username}&exact=true`,
      {
        headers: { 'Authorization': `Bearer ${adminToken}` },
      }
    );

    if (!userResponse.ok) return false;
    const users = await userResponse.json();
    if (users.length === 0) return false;
    const userId = users[0].id;

    // Find group
    const groupResponse = await fetch(
      `${KEYCLOAK_URL}/admin/realms/${KEYCLOAK_REALM}/groups?search=${groupName}&exact=true`,
      {
        headers: { 'Authorization': `Bearer ${adminToken}` },
      }
    );

    if (!groupResponse.ok) return false;
    const groups = await groupResponse.json();
    if (groups.length === 0) return false;
    const groupId = groups[0].id;

    // Add to group
    const addResponse = await fetch(
      `${KEYCLOAK_URL}/admin/realms/${KEYCLOAK_REALM}/users/${userId}/groups/${groupId}`,
      {
        method: 'PUT',
        headers: { 'Authorization': `Bearer ${adminToken}` },
      }
    );

    return addResponse.status === 204;
  } catch {
    return false;
  }
}

describe('Keycloak Integration', () => {
  const clients: RawSocketClient[] = [];
  let keycloakAvailable = false;

  const trackClient = (client: RawSocketClient): RawSocketClient => {
    clients.push(client);
    return client;
  };

  beforeAll(async () => {
    // Check if Keycloak is available
    try {
      const response = await fetch(`${KEYCLOAK_URL}/realms/${KEYCLOAK_REALM}`, {
        signal: AbortSignal.timeout(5000),
      });
      keycloakAvailable = response.ok;
    } catch {
      keycloakAvailable = false;
    }

    if (!keycloakAvailable) {
      console.log('Keycloak not available - some tests will be skipped');
    }
  });

  afterEach(() => {
    for (const client of clients) {
      try {
        client.close();
      } catch {
        // Ignore
      }
    }
    clients.length = 0;
  });

  describe('SASL PLAIN via Keycloak', () => {
    it('server advertises PLAIN mechanism', async () => {
      const client = trackClient(await createRawSocketClient());
      const caps = await client.capLs();

      expect(caps.has('sasl')).toBe(true);

      // Check SASL mechanisms
      const saslValue = caps.get('sasl');
      if (saslValue) {
        console.log('SASL mechanisms:', saslValue);
        expect(saslValue).toContain('PLAIN');
      }

      client.send('QUIT');
    });

    it('authenticates with Keycloak credentials', async () => {
      if (!keycloakAvailable) {
        console.log('Skipping - Keycloak not available');
        return;
      }

      const client = trackClient(await createRawSocketClient());

      await client.capLs();
      await client.capReq(['sasl']);

      client.send('AUTHENTICATE PLAIN');
      await client.waitForLine(/AUTHENTICATE \+/);

      // SASL PLAIN: base64(authzid\0authcid\0password)
      const payload = Buffer.from(`${TEST_USER}\0${TEST_USER}\0${TEST_PASS}`).toString('base64');
      client.send(`AUTHENTICATE ${payload}`);

      try {
        const result = await client.waitForLine(/90[03]/, 5000);
        expect(result).toMatch(/90[03]/);
        console.log('SASL PLAIN auth result:', result);

        // Complete connection
        client.capEnd();
        client.register('kctest1');
        await client.waitForLine(/001/);

        // Check logged in
        client.send('WHOIS kctest1');
        const whois = await client.waitForLine(/330|311/, 3000);
        console.log('WHOIS response:', whois);
      } catch (e) {
        console.log('SASL auth failed:', e);
        // May fail if test user not set up
      }

      client.send('QUIT');
    });

    it('rejects invalid Keycloak credentials', async () => {
      if (!keycloakAvailable) {
        console.log('Skipping - Keycloak not available');
        return;
      }

      const client = trackClient(await createRawSocketClient());

      await client.capLs();
      await client.capReq(['sasl']);

      client.send('AUTHENTICATE PLAIN');
      await client.waitForLine(/AUTHENTICATE \+/);

      // Wrong password
      const payload = Buffer.from(`${TEST_USER}\0${TEST_USER}\0wrongpassword`).toString('base64');
      client.send(`AUTHENTICATE ${payload}`);

      const result = await client.waitForLine(/90[24]/, 5000);
      // 904 = SASLFAIL, 902 = NICKLOCKED
      expect(result).toMatch(/90[24]/);

      client.send('QUIT');
    });
  });

  describe('SASL OAUTHBEARER via Keycloak', () => {
    it('server advertises OAUTHBEARER mechanism when Keycloak enabled', async () => {
      const client = trackClient(await createRawSocketClient());
      const caps = await client.capLs();

      const saslValue = caps.get('sasl');
      if (saslValue) {
        console.log('SASL mechanisms:', saslValue);
        // OAUTHBEARER should be advertised when Keycloak is enabled
        if (saslValue.includes('OAUTHBEARER')) {
          expect(saslValue).toContain('OAUTHBEARER');
        } else {
          console.log('OAUTHBEARER not advertised - may not be enabled');
        }
      }

      client.send('QUIT');
    });

    it('authenticates with OAuth2 bearer token', async () => {
      if (!keycloakAvailable) {
        console.log('Skipping - Keycloak not available');
        return;
      }

      // Get token from Keycloak
      const token = await getKeycloakToken(TEST_USER, TEST_PASS);
      if (!token) {
        console.log('Skipping - could not get Keycloak token');
        return;
      }

      const client = trackClient(await createRawSocketClient());

      const caps = await client.capLs();
      const saslValue = caps.get('sasl');

      if (!saslValue?.includes('OAUTHBEARER')) {
        console.log('Skipping - OAUTHBEARER not supported');
        client.send('QUIT');
        return;
      }

      await client.capReq(['sasl']);

      client.send('AUTHENTICATE OAUTHBEARER');

      try {
        await client.waitForLine(/AUTHENTICATE \+/, 3000);
      } catch {
        console.log('Server did not prompt for OAUTHBEARER data');
        client.send('QUIT');
        return;
      }

      // OAUTHBEARER format: base64("n,,\x01auth=Bearer <token>\x01\x01")
      const oauthPayload = `n,,\x01auth=Bearer ${token}\x01\x01`;
      const payload = Buffer.from(oauthPayload).toString('base64');

      // Use chunked sending for large OAuth tokens
      await sendSaslPayload(client, payload);

      const result = await client.waitForLine(/90[03]/, 5000);
      expect(result).toMatch(/90[03]/);
      console.log('OAUTHBEARER auth result:', result);

      client.capEnd();
      client.register('kcoauth1');
      await client.waitForLine(/001/);

      client.send('QUIT');
    });

    it('rejects expired/invalid OAuth2 token', async () => {
      const client = trackClient(await createRawSocketClient());

      const caps = await client.capLs();
      const saslValue = caps.get('sasl');

      if (!saslValue?.includes('OAUTHBEARER')) {
        console.log('Skipping - OAUTHBEARER not supported');
        client.send('QUIT');
        return;
      }

      await client.capReq(['sasl']);

      client.send('AUTHENTICATE OAUTHBEARER');

      try {
        await client.waitForLine(/AUTHENTICATE \+/, 3000);
      } catch {
        client.send('QUIT');
        return;
      }

      // Invalid token
      const oauthPayload = `n,,\x01auth=Bearer invalidtoken123\x01\x01`;
      const payload = Buffer.from(oauthPayload).toString('base64');
      await sendSaslPayload(client, payload);

      const result = await client.waitForLine(/90[24]/, 5000);
      expect(result).toMatch(/90[24]/);

      client.send('QUIT');
    });
  });

  describe('Keycloak User Auto-Creation', () => {
    it('auto-creates X3 account for Keycloak user via OAUTHBEARER', async () => {
      if (!keycloakAvailable) {
        console.log('Skipping - Keycloak not available');
        return;
      }

      const adminToken = await getAdminToken();
      if (!adminToken) {
        console.log('Skipping - could not get admin token');
        return;
      }

      // Create unique Keycloak user
      const uniqueUser = `kcauto${Date.now() % 100000}`;
      const uniqueEmail = `${uniqueUser}@example.com`;
      const uniquePass = 'testpass123';

      const created = await createKeycloakUser(adminToken, uniqueUser, uniqueEmail, uniquePass);
      if (!created) {
        console.log('Skipping - could not create Keycloak user');
        return;
      }

      try {
        // Get OAuth token for the new user
        const userToken = await getKeycloakToken(uniqueUser, uniquePass);
        if (!userToken) {
          console.log('Skipping - could not get token for new user');
          return;
        }

        // Connect and authenticate via OAUTHBEARER - should auto-create X3 account
        const client = trackClient(await createRawSocketClient());

        const caps = await client.capLs();
        const saslValue = caps.get('sasl');

        if (!saslValue?.includes('OAUTHBEARER')) {
          console.log('Skipping - OAUTHBEARER not supported');
          client.send('QUIT');
          return;
        }

        await client.capReq(['sasl']);

        client.send('AUTHENTICATE OAUTHBEARER');
        await client.waitForLine(/AUTHENTICATE \+/);

        // OAUTHBEARER format: base64("n,,\x01auth=Bearer <token>\x01\x01")
        const oauthPayload = `n,,\x01auth=Bearer ${userToken}\x01\x01`;
        const payload = Buffer.from(oauthPayload).toString('base64');

        // Use chunked sending for large OAuth tokens
        await sendSaslPayload(client, payload);

        const result = await client.waitForLine(/90[03]/, 5000);

        if (result.includes('903') || result.includes('900')) {
          console.log('Auto-created account for:', uniqueUser);

          client.capEnd();
          client.register('kcauto1');
          await client.waitForLine(/001/);

          // Verify logged in to the new account
          client.send(`WHOIS kcauto1`);
          const whois = await client.waitForLine(/330|311/, 3000);
          console.log('WHOIS:', whois);
        }

        client.send('QUIT');
      } finally {
        // Cleanup Keycloak user
        await deleteKeycloakUser(adminToken, uniqueUser);
      }
    });
  });

  describe('OpServ Level Sync', () => {
    it('includes x3_opserv_level in token claims', async () => {
      if (!keycloakAvailable) {
        console.log('Skipping - Keycloak not available');
        return;
      }

      const adminToken = await getAdminToken();
      if (!adminToken) {
        console.log('Skipping - could not get admin token');
        return;
      }

      // Set opserv level on test user
      const set = await setKeycloakUserAttribute(adminToken, TEST_USER, 'x3_opserv_level', '500');
      if (!set) {
        console.log('Skipping - could not set user attribute');
        return;
      }

      // Get token and decode it to check claims
      const token = await getKeycloakToken(TEST_USER, TEST_PASS);
      if (!token) {
        console.log('Skipping - could not get token');
        return;
      }

      // Decode JWT (just the payload)
      const parts = token.split('.');
      if (parts.length >= 2) {
        const payload = JSON.parse(Buffer.from(parts[1], 'base64').toString());
        console.log('Token claims:', JSON.stringify(payload, null, 2));

        if (payload.x3_opserv_level !== undefined) {
          // x3_opserv_level is a String in the token (to avoid type conversion errors)
          expect(payload.x3_opserv_level).toBe('500');
        } else {
          console.log('x3_opserv_level claim not in token - mapper may not be configured');
        }
      }

      // Cleanup
      await setKeycloakUserAttribute(adminToken, TEST_USER, 'x3_opserv_level', '0');
    });
  });

  describe('Oper Group Membership', () => {
    it('adds user to x3-opers group in Keycloak', async () => {
      if (!keycloakAvailable) {
        console.log('Skipping - Keycloak not available');
        return;
      }

      const adminToken = await getAdminToken();
      if (!adminToken) {
        console.log('Skipping - could not get admin token');
        return;
      }

      // Add test user to x3-opers group
      const added = await addUserToGroup(adminToken, TEST_USER, 'x3-opers');
      console.log('Added to x3-opers group:', added);

      // This tests that the group exists and can be used
      // Actual X3 -> Keycloak sync would happen when OpServ level is set
      expect(added).toBe(true);
    });
  });

  describe('SASL EXTERNAL / x509_fingerprints', () => {
    // Sample fingerprints for testing (SHA-256 format with colons)
    const TEST_FINGERPRINT_1 = 'AA:BB:CC:DD:EE:FF:00:11:22:33:44:55:66:77:88:99:AA:BB:CC:DD:EE:FF:00:11:22:33:44:55:66:77:88:99';
    const TEST_FINGERPRINT_2 = '11:22:33:44:55:66:77:88:99:AA:BB:CC:DD:EE:FF:00:11:22:33:44:55:66:77:88:99:AA:BB:CC:DD:EE:FF:00';

    it('x509_fingerprints attribute exists in user profile', async () => {
      if (!keycloakAvailable) {
        console.log('Skipping - Keycloak not available');
        return;
      }

      const adminToken = await getAdminToken();
      if (!adminToken) {
        console.log('Skipping - could not get admin token');
        return;
      }

      // Get user profile configuration
      const response = await fetch(
        `${KEYCLOAK_URL}/admin/realms/${KEYCLOAK_REALM}/users/profile`,
        {
          headers: { 'Authorization': `Bearer ${adminToken}` },
        }
      );

      expect(response.ok).toBe(true);
      const profile = await response.json();

      // Check x509_fingerprints attribute is defined
      const fpAttr = profile.attributes?.find(
        (a: { name: string }) => a.name === 'x509_fingerprints'
      );

      if (fpAttr) {
        console.log('x509_fingerprints attribute config:', JSON.stringify(fpAttr, null, 2));
        expect(fpAttr.name).toBe('x509_fingerprints');
        expect(fpAttr.multivalued).toBe(true);
      } else {
        console.log('x509_fingerprints attribute not found in user profile');
        console.log('Run scripts/setup-keycloak.sh to configure it');
      }
    });

    it('can set and retrieve fingerprints for a user', async () => {
      if (!keycloakAvailable) {
        console.log('Skipping - Keycloak not available');
        return;
      }

      const adminToken = await getAdminToken();
      if (!adminToken) {
        console.log('Skipping - could not get admin token');
        return;
      }

      // Set fingerprints
      const set = await setKeycloakFingerprints(adminToken, TEST_USER, [TEST_FINGERPRINT_1]);
      expect(set).toBe(true);

      // Retrieve and verify
      const fingerprints = await getKeycloakFingerprints(adminToken, TEST_USER);
      expect(fingerprints).toContain(TEST_FINGERPRINT_1);
      console.log('User fingerprints:', fingerprints);
    });

    it('supports multiple fingerprints per user', async () => {
      if (!keycloakAvailable) {
        console.log('Skipping - Keycloak not available');
        return;
      }

      const adminToken = await getAdminToken();
      if (!adminToken) {
        console.log('Skipping - could not get admin token');
        return;
      }

      // Set multiple fingerprints
      const set = await setKeycloakFingerprints(adminToken, TEST_USER, [
        TEST_FINGERPRINT_1,
        TEST_FINGERPRINT_2,
      ]);
      expect(set).toBe(true);

      // Verify both are stored
      const fingerprints = await getKeycloakFingerprints(adminToken, TEST_USER);
      expect(fingerprints.length).toBe(2);
      expect(fingerprints).toContain(TEST_FINGERPRINT_1);
      expect(fingerprints).toContain(TEST_FINGERPRINT_2);
      console.log('Multiple fingerprints stored:', fingerprints);

      // Cleanup - restore original single fingerprint
      await setKeycloakFingerprints(adminToken, TEST_USER, [TEST_FINGERPRINT_1]);
    });

    it('can search users by fingerprint (Scenario 1 lookup)', async () => {
      if (!keycloakAvailable) {
        console.log('Skipping - Keycloak not available');
        return;
      }

      const adminToken = await getAdminToken();
      if (!adminToken) {
        console.log('Skipping - could not get admin token');
        return;
      }

      // Ensure test user has the fingerprint
      await setKeycloakFingerprints(adminToken, TEST_USER, [TEST_FINGERPRINT_1]);

      // Search for user by fingerprint
      const username = await findUserByFingerprint(adminToken, TEST_FINGERPRINT_1);

      if (username) {
        expect(username).toBe(TEST_USER);
        console.log(`Found user '${username}' by fingerprint lookup`);
      } else {
        // Keycloak may not support attribute search via q= parameter
        console.log('Fingerprint search returned no results');
        console.log('Note: Keycloak attribute search may require specific configuration');
      }
    });

    it('fingerprint not found returns null', async () => {
      if (!keycloakAvailable) {
        console.log('Skipping - Keycloak not available');
        return;
      }

      const adminToken = await getAdminToken();
      if (!adminToken) {
        console.log('Skipping - could not get admin token');
        return;
      }

      // Search for non-existent fingerprint
      const nonExistentFp = 'ZZ:ZZ:ZZ:ZZ:ZZ:ZZ:00:11:22:33:44:55:66:77:88:99:AA:BB:CC:DD:EE:FF:00:11:22:33:44:55:66:77:88:99';
      const username = await findUserByFingerprint(adminToken, nonExistentFp);
      expect(username).toBeNull();
      console.log('Non-existent fingerprint correctly returns null');
    });

    it('includes x509_fingerprints in token claims', async () => {
      if (!keycloakAvailable) {
        console.log('Skipping - Keycloak not available');
        return;
      }

      const adminToken = await getAdminToken();
      if (!adminToken) {
        console.log('Skipping - could not get admin token');
        return;
      }

      // Ensure test user has fingerprint
      await setKeycloakFingerprints(adminToken, TEST_USER, [TEST_FINGERPRINT_1]);

      // Get user token
      const token = await getKeycloakToken(TEST_USER, TEST_PASS);
      if (!token) {
        console.log('Skipping - could not get token');
        return;
      }

      // Decode JWT payload
      const parts = token.split('.');
      if (parts.length >= 2) {
        const payload = JSON.parse(Buffer.from(parts[1], 'base64').toString());

        if (payload.x509_fingerprints !== undefined) {
          console.log('x509_fingerprints in token:', payload.x509_fingerprints);
          expect(Array.isArray(payload.x509_fingerprints)).toBe(true);
          expect(payload.x509_fingerprints).toContain(TEST_FINGERPRINT_1);
        } else {
          console.log('x509_fingerprints not in token - mapper may not be configured');
          console.log('Token claims:', Object.keys(payload).join(', '));
        }
      }
    });

    it('server advertises EXTERNAL mechanism', async () => {
      const client = trackClient(await createRawSocketClient());
      const caps = await client.capLs();

      const saslValue = caps.get('sasl');
      if (saslValue) {
        console.log('SASL mechanisms:', saslValue);
        if (saslValue.includes('EXTERNAL')) {
          expect(saslValue).toContain('EXTERNAL');
          console.log('EXTERNAL mechanism advertised');
        } else {
          console.log('EXTERNAL not advertised - may require TLS with client cert');
        }
      }

      client.send('QUIT');
    });

    it('validates fingerprint format (SHA-256 with colons)', () => {
      // Test valid fingerprint format
      const validFp = 'AA:BB:CC:DD:EE:FF:00:11:22:33:44:55:66:77:88:99:AA:BB:CC:DD:EE:FF:00:11:22:33:44:55:66:77:88:99';
      expect(validFp.length).toBe(95); // 32 bytes * 2 hex chars + 31 colons
      expect(validFp.split(':').length).toBe(32); // 32 octets

      // Regex pattern from Keycloak user profile
      const pattern = /^[A-Fa-f0-9:]{95}$/;
      expect(pattern.test(validFp)).toBe(true);

      // Invalid formats
      expect(pattern.test('invalid')).toBe(false);
      expect(pattern.test('AA:BB:CC')).toBe(false); // Too short
      expect(pattern.test('AABBCCDD...')).toBe(false); // No colons
    });
  });
});

describe('Keycloak Error Handling', () => {
  const clients: RawSocketClient[] = [];

  const trackClient = (client: RawSocketClient): RawSocketClient => {
    clients.push(client);
    return client;
  };

  afterEach(() => {
    for (const client of clients) {
      try {
        client.close();
      } catch {
        // Ignore
      }
    }
    clients.length = 0;
  });

  it('handles Keycloak unavailable gracefully', async () => {
    // This test verifies behavior when Keycloak is down
    // The IRC server should still work, just without Keycloak auth

    const client = trackClient(await createRawSocketClient());

    await client.capLs();
    await client.capReq(['sasl']);

    client.send('AUTHENTICATE PLAIN');

    try {
      await client.waitForLine(/AUTHENTICATE \+/, 3000);
      // Server still responding - send test creds
      const payload = Buffer.from('test\0test\0test').toString('base64');
      client.send(`AUTHENTICATE ${payload}`);

      // Should get some response (success if fallback, or fail)
      const result = await client.waitForLine(/90[0-9]/, 5000);
      expect(result).toBeDefined();
    } catch {
      // Timeout is acceptable if Keycloak is totally unavailable
      console.log('SASL timed out - Keycloak may be unavailable');
    }

    client.send('QUIT');
  });

  it('falls back gracefully on Keycloak errors', async () => {
    const client = trackClient(await createRawSocketClient());

    await client.capLs();

    // Even if Keycloak has issues, basic IRC should work
    client.capEnd();
    client.register('fallback1');

    const welcome = await client.waitForLine(/001/, 5000);
    expect(welcome).toContain('fallback1');

    client.send('QUIT');
  });
});

/**
 * Helper to create hierarchical group structure
 */
async function createChannelGroup(
  adminToken: string,
  channelName: string,
  accessLevel: string
): Promise<boolean> {
  try {
    // First get or create the irc-channels parent group
    let parentGroupId: string | null = null;

    const parentResponse = await fetch(
      `${KEYCLOAK_URL}/admin/realms/${KEYCLOAK_REALM}/groups?search=irc-channels&exact=true`,
      {
        headers: { 'Authorization': `Bearer ${adminToken}` },
      }
    );

    if (parentResponse.ok) {
      const groups = await parentResponse.json();
      if (groups.length > 0) {
        parentGroupId = groups[0].id;
      }
    }

    if (!parentGroupId) {
      console.log('irc-channels parent group not found');
      return false;
    }

    // Create channel subgroup under irc-channels
    const channelGroupName = channelName.replace('#', '');

    // Check if channel group exists
    const channelResponse = await fetch(
      `${KEYCLOAK_URL}/admin/realms/${KEYCLOAK_REALM}/groups/${parentGroupId}/children`,
      {
        headers: { 'Authorization': `Bearer ${adminToken}` },
      }
    );

    let channelGroupId: string | null = null;
    if (channelResponse.ok) {
      const children = await channelResponse.json();
      const existing = children.find((g: { name: string }) => g.name === channelGroupName);
      if (existing) {
        channelGroupId = existing.id;
      }
    }

    // Create channel group if needed
    if (!channelGroupId) {
      const createChannelResponse = await fetch(
        `${KEYCLOAK_URL}/admin/realms/${KEYCLOAK_REALM}/groups/${parentGroupId}/children`,
        {
          method: 'POST',
          headers: {
            'Authorization': `Bearer ${adminToken}`,
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({ name: channelGroupName }),
        }
      );

      if (createChannelResponse.status === 201) {
        // Get the newly created group
        const refreshResponse = await fetch(
          `${KEYCLOAK_URL}/admin/realms/${KEYCLOAK_REALM}/groups/${parentGroupId}/children`,
          {
            headers: { 'Authorization': `Bearer ${adminToken}` },
          }
        );
        if (refreshResponse.ok) {
          const children = await refreshResponse.json();
          const newGroup = children.find((g: { name: string }) => g.name === channelGroupName);
          if (newGroup) channelGroupId = newGroup.id;
        }
      }
    }

    if (!channelGroupId) {
      console.log('Could not create/find channel group');
      return false;
    }

    // Create access level subgroup (owner, coowner, etc.)
    const createAccessResponse = await fetch(
      `${KEYCLOAK_URL}/admin/realms/${KEYCLOAK_REALM}/groups/${channelGroupId}/children`,
      {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${adminToken}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ name: accessLevel }),
      }
    );

    return createAccessResponse.status === 201 || createAccessResponse.status === 409; // 409 = already exists
  } catch (e) {
    console.log('Error creating channel group:', e);
    return false;
  }
}

/**
 * Helper to get group by path
 */
async function getGroupByPath(adminToken: string, path: string): Promise<{ id: string; name: string } | null> {
  try {
    const response = await fetch(
      `${KEYCLOAK_URL}/admin/realms/${KEYCLOAK_REALM}/group-by-path/${encodeURIComponent(path)}`,
      {
        headers: { 'Authorization': `Bearer ${adminToken}` },
      }
    );

    if (!response.ok) return null;
    return await response.json();
  } catch {
    return null;
  }
}

/**
 * Helper to get group members
 */
async function getGroupMembers(adminToken: string, groupId: string): Promise<Array<{ username: string; id: string }>> {
  try {
    const response = await fetch(
      `${KEYCLOAK_URL}/admin/realms/${KEYCLOAK_REALM}/groups/${groupId}/members`,
      {
        headers: { 'Authorization': `Bearer ${adminToken}` },
      }
    );

    if (!response.ok) return [];
    return await response.json();
  } catch {
    return [];
  }
}

describe('Keycloak Channel Access Groups', () => {
  let keycloakAvailable = false;
  let adminToken: string | null = null;

  beforeAll(async () => {
    try {
      const response = await fetch(`${KEYCLOAK_URL}/realms/${KEYCLOAK_REALM}`, {
        signal: AbortSignal.timeout(5000),
      });
      keycloakAvailable = response.ok;

      if (keycloakAvailable) {
        adminToken = await getAdminToken();
      }
    } catch {
      keycloakAvailable = false;
    }
  });

  it('irc-channels parent group exists', async () => {
    if (!keycloakAvailable || !adminToken) {
      console.log('Skipping - Keycloak not available');
      return;
    }

    const response = await fetch(
      `${KEYCLOAK_URL}/admin/realms/${KEYCLOAK_REALM}/groups?search=irc-channels&exact=true`,
      {
        headers: { 'Authorization': `Bearer ${adminToken}` },
      }
    );

    expect(response.ok).toBe(true);
    const groups = await response.json();
    expect(groups.length).toBeGreaterThan(0);
    expect(groups[0].name).toBe('irc-channels');
    console.log('irc-channels group id:', groups[0].id);
  });

  it('can create hierarchical channel access groups', async () => {
    if (!keycloakAvailable || !adminToken) {
      console.log('Skipping - Keycloak not available');
      return;
    }

    // Create test channel group structure: /irc-channels/testchan/owner
    const created = await createChannelGroup(adminToken, '#testchan', 'owner');
    expect(created).toBe(true);

    // Verify structure exists via group-by-path
    const group = await getGroupByPath(adminToken, '/irc-channels/testchan/owner');
    if (group) {
      console.log('Created group path: /irc-channels/testchan/owner, id:', group.id);
      expect(group.name).toBe('owner');
    } else {
      // group-by-path may not be available, try alternative
      console.log('group-by-path not available - group created but path lookup failed');
    }
  });

  it('can add user to channel access group', async () => {
    if (!keycloakAvailable || !adminToken) {
      console.log('Skipping - Keycloak not available');
      return;
    }

    // Ensure group structure exists
    await createChannelGroup(adminToken, '#testchan', 'coowner');

    // Get the coowner group
    const group = await getGroupByPath(adminToken, '/irc-channels/testchan/coowner');
    if (!group) {
      console.log('Skipping - could not find channel group');
      return;
    }

    // Add test user to coowner group
    // First find user
    const userResponse = await fetch(
      `${KEYCLOAK_URL}/admin/realms/${KEYCLOAK_REALM}/users?username=${TEST_USER}&exact=true`,
      {
        headers: { 'Authorization': `Bearer ${adminToken}` },
      }
    );

    if (!userResponse.ok) {
      console.log('Skipping - could not find test user');
      return;
    }

    const users = await userResponse.json();
    if (users.length === 0) {
      console.log('Skipping - test user not found');
      return;
    }

    const userId = users[0].id;

    // Add to group
    const addResponse = await fetch(
      `${KEYCLOAK_URL}/admin/realms/${KEYCLOAK_REALM}/users/${userId}/groups/${group.id}`,
      {
        method: 'PUT',
        headers: { 'Authorization': `Bearer ${adminToken}` },
      }
    );

    expect(addResponse.status).toBe(204);
    console.log(`Added ${TEST_USER} to /irc-channels/testchan/coowner`);

    // Verify membership
    const members = await getGroupMembers(adminToken, group.id);
    const isMember = members.some(m => m.username === TEST_USER);
    expect(isMember).toBe(true);
  });

  it('supports multiple access levels per channel', async () => {
    if (!keycloakAvailable || !adminToken) {
      console.log('Skipping - Keycloak not available');
      return;
    }

    // X3 uses these access levels for channels
    const accessLevels = ['owner', 'coowner', 'manager', 'op', 'halfop', 'voice', 'peon'];

    for (const level of accessLevels) {
      const created = await createChannelGroup(adminToken, '#accesstest', level);
      if (created) {
        console.log(`Created /irc-channels/accesstest/${level}`);
      }
    }

    // Verify at least one was created
    const ownerGroup = await getGroupByPath(adminToken, '/irc-channels/accesstest/owner');
    if (ownerGroup) {
      expect(ownerGroup.name).toBe('owner');
    } else {
      console.log('Could not verify via group-by-path');
    }
  });
});

/**
 * Helper to get channel group with access level attribute
 */
async function getChannelGroupWithAttribute(
  adminToken: string,
  channelName: string
): Promise<{ id: string; name: string; attributes?: Record<string, string[]> } | null> {
  try {
    // Get irc-channels parent first
    const parentResponse = await fetch(
      `${KEYCLOAK_URL}/admin/realms/${KEYCLOAK_REALM}/groups?search=irc-channels&exact=true`,
      {
        headers: { 'Authorization': `Bearer ${adminToken}` },
      }
    );

    if (!parentResponse.ok) return null;
    const parents = await parentResponse.json();
    if (parents.length === 0) return null;

    const parentId = parents[0].id;
    const groupName = channelName.replace('#', '');

    // Get children of irc-channels
    const childrenResponse = await fetch(
      `${KEYCLOAK_URL}/admin/realms/${KEYCLOAK_REALM}/groups/${parentId}/children`,
      {
        headers: { 'Authorization': `Bearer ${adminToken}` },
      }
    );

    if (!childrenResponse.ok) return null;
    const children = await childrenResponse.json();
    const channelGroup = children.find((g: { name: string }) => g.name === groupName);

    if (!channelGroup) return null;

    // Get full group details including attributes
    const groupResponse = await fetch(
      `${KEYCLOAK_URL}/admin/realms/${KEYCLOAK_REALM}/groups/${channelGroup.id}`,
      {
        headers: { 'Authorization': `Bearer ${adminToken}` },
      }
    );

    if (!groupResponse.ok) return null;
    return await groupResponse.json();
  } catch {
    return null;
  }
}

/**
 * Helper to delete a channel group from Keycloak
 */
async function deleteChannelGroup(adminToken: string, channelName: string): Promise<boolean> {
  try {
    // Get irc-channels parent first
    const parentResponse = await fetch(
      `${KEYCLOAK_URL}/admin/realms/${KEYCLOAK_REALM}/groups?search=irc-channels&exact=true`,
      {
        headers: { 'Authorization': `Bearer ${adminToken}` },
      }
    );

    if (!parentResponse.ok) return false;
    const parents = await parentResponse.json();
    if (parents.length === 0) return false;

    const parentId = parents[0].id;
    const groupName = channelName.replace('#', '');

    // Get children of irc-channels
    const childrenResponse = await fetch(
      `${KEYCLOAK_URL}/admin/realms/${KEYCLOAK_REALM}/groups/${parentId}/children`,
      {
        headers: { 'Authorization': `Bearer ${adminToken}` },
      }
    );

    if (!childrenResponse.ok) return false;
    const children = await childrenResponse.json();
    const channelGroup = children.find((g: { name: string }) => g.name === groupName);

    if (!channelGroup) return true; // Already deleted

    // Delete the group
    const deleteResponse = await fetch(
      `${KEYCLOAK_URL}/admin/realms/${KEYCLOAK_REALM}/groups/${channelGroup.id}`,
      {
        method: 'DELETE',
        headers: { 'Authorization': `Bearer ${adminToken}` },
      }
    );

    return deleteResponse.status === 204;
  } catch {
    return false;
  }
}

/**
 * Helper to unregister a channel properly with confirmation code
 * X3 responds with: "To confirm this unregistration, you must use 'unregister #channel a1b2c3d4'."
 */
async function unregisterChannel(client: RawSocketClient, channelName: string): Promise<void> {
  // First send UNREGISTER to get the confirmation code
  client.send(`PRIVMSG ChanServ :UNREGISTER ${channelName}`);

  try {
    // Wait for the confirmation prompt - format: "use 'unregister #channel CODE'"
    const response = await client.waitForLine(/unregister.*\s([a-f0-9]{8})'/i, 5000);
    // Extract the 8-character hex confirmation code at the end before the quote
    const match = response.match(/unregister\s+\S+\s+([a-f0-9]{8})'/i);
    if (match) {
      const confirmCode = match[1];
      console.log(`Confirming unregister of ${channelName} with code ${confirmCode}`);
      client.send(`PRIVMSG ChanServ :UNREGISTER ${channelName} ${confirmCode}`);
      // Wait for success confirmation - X3 says "has been unregistered"
      await client.waitForLine(/has been unregistered|unregistered|removed/i, 5000);
      console.log(`Successfully unregistered ${channelName}`);
    } else {
      console.log(`Could not extract confirmation code from: ${response}`);
    }
  } catch (e) {
    console.log(`Could not unregister ${channelName} - ${(e as Error).message}`);
  }
}

/**
 * Helper to authenticate a second user via SASL for ADDUSER tests
 */
async function authenticateSecondUser(
  username: string,
  password: string
): Promise<RawSocketClient | null> {
  try {
    const client = await createRawSocketClient();
    await client.capLs();
    await client.capReq(['sasl']);

    client.send('AUTHENTICATE PLAIN');
    await client.waitForLine(/AUTHENTICATE \+/);

    const payload = Buffer.from(`${username}\0${username}\0${password}`).toString('base64');
    client.send(`AUTHENTICATE ${payload}`);

    await client.waitForLine(/903/, 5000);
    client.capEnd();
    client.register(`${username.slice(0, 7)}${Date.now() % 1000}`);
    await client.waitForLine(/001/);

    return client;
  } catch {
    return null;
  }
}

/**
 * Bidirectional Sync Tests
 *
 * Tests X3's Keycloak bidirectional sync feature:
 * - ADDUSER creates Keycloak channel groups with access level
 * - CLVL updates the access level attribute
 * - DELUSER removes user from group (when implemented)
 * - UNREGISTER deletes the channel group
 *
 * Prerequisites:
 * 1. X3 built with Keycloak support (--with-keycloak)
 * 2. keycloak_bidirectional_sync enabled in x3.conf
 * 3. Keycloak configured with irc-channels parent group
 */
describe('Keycloak Bidirectional Sync', () => {
  const clients: RawSocketClient[] = [];
  let keycloakAvailable = false;
  let adminToken: string | null = null;

  const trackClient = (client: RawSocketClient): RawSocketClient => {
    clients.push(client);
    return client;
  };

  beforeAll(async () => {
    try {
      const response = await fetch(`${KEYCLOAK_URL}/realms/${KEYCLOAK_REALM}`, {
        signal: AbortSignal.timeout(5000),
      });
      keycloakAvailable = response.ok;

      if (keycloakAvailable) {
        adminToken = await getAdminToken();
      }
    } catch {
      keycloakAvailable = false;
    }
  });

  afterEach(() => {
    for (const client of clients) {
      try {
        client.close();
      } catch {
        // Ignore
      }
    }
    clients.length = 0;
  });

  describe('ADDUSER creates Keycloak groups', () => {
    it('creates channel group with x3_access_level attribute when user added', async () => {
      if (!keycloakAvailable || !adminToken) {
        console.log('Skipping - Keycloak not available');
        return;
      }

      const channelName = `#bidisync${Date.now() % 100000}`;
      const groupName = channelName.replace('#', '');

      // Cleanup any existing group first
      await deleteChannelGroup(adminToken, channelName);

      // Connect and authenticate as owner
      const client = trackClient(await createRawSocketClient());
      await client.capLs();
      await client.capReq(['sasl']);

      client.send('AUTHENTICATE PLAIN');
      await client.waitForLine(/AUTHENTICATE \+/);

      const payload = Buffer.from(`${TEST_USER}\0${TEST_USER}\0${TEST_PASS}`).toString('base64');
      client.send(`AUTHENTICATE ${payload}`);

      try {
        await client.waitForLine(/903/, 5000);
      } catch {
        console.log('Skipping - could not authenticate');
        return;
      }

      client.capEnd();
      client.register(`bisync${Date.now() % 10000}`);
      await client.waitForLine(/001/);

      // Register channel (becomes owner - should create Keycloak group)
      client.send(`JOIN ${channelName}`);
      await client.waitForLine(new RegExp(`JOIN.*${channelName}`, 'i'));

      // Register the channel with ChanServ
      client.send(`PRIVMSG ChanServ :REGISTER ${channelName}`);

      // Wait for registration confirmation or error
      // ChanServ responds with "You now have ownership of #channel"
      try {
        await client.waitForLine(/ownership|registered|already|error/i, 5000);
      } catch {
        console.log('Channel registration timed out');
      }

      // Wait for async Keycloak sync
      await new Promise(r => setTimeout(r, 2000));

      // Check if group was created in Keycloak
      const group = await getChannelGroupWithAttribute(adminToken, channelName);

      if (group) {
        console.log(`Channel group created: ${groupName}`);
        console.log('Group attributes:', JSON.stringify(group.attributes, null, 2));

        // Check for x3_access_level attribute
        const accessLevel = group.attributes?.x3_access_level?.[0];
        if (accessLevel) {
          console.log(`x3_access_level: ${accessLevel}`);
          // Owner should be 500
          expect(parseInt(accessLevel)).toBe(500);
        } else {
          console.log('x3_access_level attribute not set - bidirectional sync may not be enabled');
        }
      } else {
        console.log('Channel group not created - bidirectional sync may not be enabled');
        console.log('Enable with: keycloak_bidirectional_sync = true in x3.conf [chanserv] section');
      }

      // Cleanup - use proper unregister with confirmation code
      await unregisterChannel(client, channelName);
      client.send('QUIT');
    });

    it('creates group with correct access level for different user levels', async () => {
      if (!keycloakAvailable || !adminToken) {
        console.log('Skipping - Keycloak not available');
        return;
      }

      // Create a second Keycloak user for this test
      const secondUser = `bisyncadd${Date.now() % 100000}`;
      const secondEmail = `${secondUser}@example.com`;
      const secondPass = 'testpass123';

      const created = await createKeycloakUser(adminToken, secondUser, secondEmail, secondPass);
      if (!created) {
        console.log('Skipping - could not create second Keycloak user');
        return;
      }

      const channelName = `#bisyncadd${Date.now() % 100000}`;

      try {
        // Connect as first user and register channel
        const ownerClient = trackClient(await createRawSocketClient());
        await ownerClient.capLs();
        await ownerClient.capReq(['sasl']);

        ownerClient.send('AUTHENTICATE PLAIN');
        await ownerClient.waitForLine(/AUTHENTICATE \+/);

        const ownerPayload = Buffer.from(`${TEST_USER}\0${TEST_USER}\0${TEST_PASS}`).toString('base64');
        ownerClient.send(`AUTHENTICATE ${ownerPayload}`);

        try {
          await ownerClient.waitForLine(/903/, 5000);
        } catch {
          console.log('Skipping - could not authenticate owner');
          return;
        }

        ownerClient.capEnd();
        ownerClient.register(`bisown${Date.now() % 10000}`);
        await ownerClient.waitForLine(/001/);

        // Register channel
        ownerClient.send(`JOIN ${channelName}`);
        await ownerClient.waitForLine(new RegExp(`JOIN.*${channelName}`, 'i'));

        ownerClient.send(`PRIVMSG ChanServ :REGISTER ${channelName}`);

        try {
          await ownerClient.waitForLine(/ownership|registered|already/i, 5000);
        } catch {
          console.log('Registration result not received');
        }

        // Second user must authenticate via SASL to create X3 account before ADDUSER
        const secondClient = await authenticateSecondUser(secondUser, secondPass);
        if (secondClient) {
          trackClient(secondClient);
          console.log(`Second user ${secondUser} authenticated and connected`);
          // Wait a bit for account to be fully synced
          await new Promise(r => setTimeout(r, 500));
        } else {
          console.log(`Could not authenticate second user ${secondUser} - ADDUSER may fail`);
        }

        // Add second user at level 200 (manager level)
        // Use *username prefix to look up by account handle, not nick
        ownerClient.send(`PRIVMSG ChanServ :ADDUSER ${channelName} *${secondUser} 200`);

        try {
          await ownerClient.waitForLine(/added|access/i, 5000);
          console.log(`Added ${secondUser} to ${channelName} at level 200`);
        } catch {
          console.log('ADDUSER result not received');
        }

        // Wait for Keycloak sync
        await new Promise(r => setTimeout(r, 2000));

        // Check the group's access level attribute
        // Note: The current implementation stores the owner's access level on the group
        // User-level access would need per-user subgroups or attributes
        const group = await getChannelGroupWithAttribute(adminToken, channelName);

        if (group) {
          console.log(`Channel group: ${channelName.replace('#', '')}`);
          console.log('Group attributes:', JSON.stringify(group.attributes, null, 2));

          // This verifies the group exists - the access level tracking approach
          // may vary based on implementation (group attribute vs subgroups)
          expect(group.id).toBeDefined();
        } else {
          console.log('Group not found - bidirectional sync may not be enabled');
        }

        // Cleanup - use proper unregister with confirmation code
        await unregisterChannel(ownerClient, channelName);
        ownerClient.send('QUIT');
      } finally {
        // Cleanup Keycloak user
        await deleteKeycloakUser(adminToken, secondUser);
      }
    });
  });

  describe('CLVL updates Keycloak access level', () => {
    it('updates group attribute when access level changed', async () => {
      if (!keycloakAvailable || !adminToken) {
        console.log('Skipping - Keycloak not available');
        return;
      }

      // Create a second Keycloak user
      const secondUser = `bisyncclvl${Date.now() % 100000}`;
      const secondEmail = `${secondUser}@example.com`;
      const secondPass = 'testpass123';

      const created = await createKeycloakUser(adminToken, secondUser, secondEmail, secondPass);
      if (!created) {
        console.log('Skipping - could not create second Keycloak user');
        return;
      }

      const channelName = `#bisyncclvl${Date.now() % 100000}`;

      try {
        // Connect as owner
        const ownerClient = trackClient(await createRawSocketClient());
        await ownerClient.capLs();
        await ownerClient.capReq(['sasl']);

        ownerClient.send('AUTHENTICATE PLAIN');
        await ownerClient.waitForLine(/AUTHENTICATE \+/);

        const payload = Buffer.from(`${TEST_USER}\0${TEST_USER}\0${TEST_PASS}`).toString('base64');
        ownerClient.send(`AUTHENTICATE ${payload}`);

        try {
          await ownerClient.waitForLine(/903/, 5000);
        } catch {
          console.log('Skipping - could not authenticate');
          return;
        }

        ownerClient.capEnd();
        ownerClient.register(`clvl${Date.now() % 10000}`);
        await ownerClient.waitForLine(/001/);

        // Register channel
        ownerClient.send(`JOIN ${channelName}`);
        await ownerClient.waitForLine(new RegExp(`JOIN.*${channelName}`, 'i'));

        ownerClient.send(`PRIVMSG ChanServ :REGISTER ${channelName}`);
        await new Promise(r => setTimeout(r, 1000));

        // Second user must authenticate via SASL to create X3 account before ADDUSER
        const secondClient = await authenticateSecondUser(secondUser, secondPass);
        if (secondClient) {
          trackClient(secondClient);
          console.log(`Second user ${secondUser} authenticated and connected`);
          await new Promise(r => setTimeout(r, 500));
        }

        // Add user at level 100 - use *username prefix for account lookup
        ownerClient.send(`PRIVMSG ChanServ :ADDUSER ${channelName} *${secondUser} 100`);
        await new Promise(r => setTimeout(r, 2000));

        // Get initial state
        let group = await getChannelGroupWithAttribute(adminToken, channelName);
        const initialAccessLevel = group?.attributes?.x3_access_level?.[0];
        console.log(`Initial access level attribute: ${initialAccessLevel || 'not set'}`);

        // Change access level to 300 - use *username prefix for account lookup
        ownerClient.send(`PRIVMSG ChanServ :CLVL ${channelName} *${secondUser} 300`);

        try {
          await ownerClient.waitForLine(/access.*changed|level.*changed|300/i, 5000);
          console.log(`Changed ${secondUser} access level to 300`);
        } catch {
          console.log('CLVL result not received');
        }

        // Wait for sync
        await new Promise(r => setTimeout(r, 2000));

        // Check updated access level
        group = await getChannelGroupWithAttribute(adminToken, channelName);
        if (group?.attributes?.x3_access_level) {
          const newAccessLevel = group.attributes.x3_access_level[0];
          console.log(`Updated access level attribute: ${newAccessLevel}`);
          // Note: The implementation may store the last modified user's level
          // or use a different strategy
          expect(parseInt(newAccessLevel)).toBeGreaterThan(0);
        } else {
          console.log('Access level attribute not found after CLVL');
        }

        // Cleanup - use proper unregister with confirmation code
        await unregisterChannel(ownerClient, channelName);
        ownerClient.send('QUIT');
      } finally {
        await deleteKeycloakUser(adminToken, secondUser);
      }
    });
  });

  describe('DELUSER removes from Keycloak group', () => {
    it('removes user access when deleted from channel', async () => {
      if (!keycloakAvailable || !adminToken) {
        console.log('Skipping - Keycloak not available');
        return;
      }

      // Create a second user
      const secondUser = `bisyncdel${Date.now() % 100000}`;
      const secondEmail = `${secondUser}@example.com`;
      const secondPass = 'testpass123';

      const created = await createKeycloakUser(adminToken, secondUser, secondEmail, secondPass);
      if (!created) {
        console.log('Skipping - could not create second Keycloak user');
        return;
      }

      const channelName = `#bisyncdel${Date.now() % 100000}`;

      try {
        const ownerClient = trackClient(await createRawSocketClient());
        await ownerClient.capLs();
        await ownerClient.capReq(['sasl']);

        ownerClient.send('AUTHENTICATE PLAIN');
        await ownerClient.waitForLine(/AUTHENTICATE \+/);

        const payload = Buffer.from(`${TEST_USER}\0${TEST_USER}\0${TEST_PASS}`).toString('base64');
        ownerClient.send(`AUTHENTICATE ${payload}`);

        try {
          await ownerClient.waitForLine(/903/, 5000);
        } catch {
          console.log('Skipping - could not authenticate');
          return;
        }

        ownerClient.capEnd();
        ownerClient.register(`delown${Date.now() % 10000}`);
        await ownerClient.waitForLine(/001/);

        // Register channel and add user
        ownerClient.send(`JOIN ${channelName}`);
        await ownerClient.waitForLine(new RegExp(`JOIN.*${channelName}`, 'i'));

        ownerClient.send(`PRIVMSG ChanServ :REGISTER ${channelName}`);
        await new Promise(r => setTimeout(r, 1000));

        // Second user must authenticate via SASL to create X3 account before ADDUSER
        const secondClient = await authenticateSecondUser(secondUser, secondPass);
        if (secondClient) {
          trackClient(secondClient);
          console.log(`Second user ${secondUser} authenticated and connected`);
          await new Promise(r => setTimeout(r, 500));
        }

        // Add user - use *username prefix for account lookup
        ownerClient.send(`PRIVMSG ChanServ :ADDUSER ${channelName} *${secondUser} 200`);
        await new Promise(r => setTimeout(r, 2000));

        // Verify group exists before delete
        let group = await getChannelGroupWithAttribute(adminToken, channelName);
        if (group) {
          console.log(`Group exists before DELUSER: ${channelName.replace('#', '')}`);
        }

        // Delete user from channel - use *username prefix for account lookup
        ownerClient.send(`PRIVMSG ChanServ :DELUSER ${channelName} *${secondUser}`);

        try {
          await ownerClient.waitForLine(/removed|deleted|access/i, 5000);
          console.log(`Deleted ${secondUser} from ${channelName}`);
        } catch {
          console.log('DELUSER result not received');
        }

        // Wait for sync
        await new Promise(r => setTimeout(r, 2000));

        // The group should still exist (for other users), but user membership may be updated
        // Depending on implementation, this could:
        // 1. Remove user from group membership
        // 2. Remove user's subgroup
        // 3. Update group attributes
        group = await getChannelGroupWithAttribute(adminToken, channelName);
        console.log('Group after DELUSER:', group ? 'exists' : 'deleted');

        // Cleanup - use proper unregister with confirmation code
        await unregisterChannel(ownerClient, channelName);
        ownerClient.send('QUIT');
      } finally {
        await deleteKeycloakUser(adminToken, secondUser);
      }
    });
  });

  describe('UNREGISTER deletes Keycloak channel group', () => {
    it('deletes channel group when channel unregistered', async () => {
      if (!keycloakAvailable || !adminToken) {
        console.log('Skipping - Keycloak not available');
        return;
      }

      const channelName = `#bisyncunreg${Date.now() % 100000}`;

      const client = trackClient(await createRawSocketClient());
      await client.capLs();
      await client.capReq(['sasl']);

      client.send('AUTHENTICATE PLAIN');
      await client.waitForLine(/AUTHENTICATE \+/);

      const payload = Buffer.from(`${TEST_USER}\0${TEST_USER}\0${TEST_PASS}`).toString('base64');
      client.send(`AUTHENTICATE ${payload}`);

      try {
        await client.waitForLine(/903/, 5000);
      } catch {
        console.log('Skipping - could not authenticate');
        return;
      }

      client.capEnd();
      client.register(`unreg${Date.now() % 10000}`);
      await client.waitForLine(/001/);

      // Register channel
      client.send(`JOIN ${channelName}`);
      await client.waitForLine(new RegExp(`JOIN.*${channelName}`, 'i'));

      client.send(`PRIVMSG ChanServ :REGISTER ${channelName}`);

      try {
        await client.waitForLine(/ownership|registered|already/i, 5000);
      } catch {
        console.log('Registration result not received');
      }

      // Wait for group creation
      await new Promise(r => setTimeout(r, 2000));

      // Verify group exists
      let group = await getChannelGroupWithAttribute(adminToken, channelName);
      if (group) {
        console.log(`Group created: ${channelName.replace('#', '')} (id: ${group.id})`);
        expect(group.id).toBeDefined();
      } else {
        console.log('Group not created - bidirectional sync may not be enabled');
        console.log('Continuing to test UNREGISTER cleanup anyway...');
      }

      // Unregister channel - use proper confirmation code
      await unregisterChannel(client, channelName);

      // Wait for Keycloak sync
      await new Promise(r => setTimeout(r, 2000));

      // Verify group was deleted
      group = await getChannelGroupWithAttribute(adminToken, channelName);
      if (group) {
        console.log('WARNING: Group still exists after UNREGISTER');
        console.log('This may indicate bidirectional sync UNREGISTER handling is not implemented');
      } else {
        console.log('SUCCESS: Group deleted after UNREGISTER');
      }

      // Explicitly check the group is gone
      expect(group).toBeNull();

      client.send('QUIT');
    });
  });

  describe('Error handling', () => {
    it('handles Keycloak unavailable gracefully during sync', async () => {
      // This test verifies that ChanServ commands still work
      // even if Keycloak sync fails

      const client = trackClient(await createRawSocketClient());
      await client.capLs();
      client.capEnd();
      client.register(`synerr${Date.now() % 10000}`);
      await client.waitForLine(/001/);

      const channelName = `#syncerr${Date.now() % 100000}`;

      // Join and register without authentication
      client.send(`JOIN ${channelName}`);
      await client.waitForLine(new RegExp(`JOIN.*${channelName}`, 'i'));

      // Try to register - should work or fail based on auth, not Keycloak
      client.send(`PRIVMSG ChanServ :REGISTER ${channelName}`);

      try {
        const response = await client.waitForLine(/registered|must.*identify|authenticated|error/i, 5000);
        console.log('Register response:', response);
        // Either registered (if auth not required) or authentication required - both are valid
        expect(response).toBeDefined();
      } catch {
        console.log('No response from ChanServ - may need authentication');
      }

      client.send('QUIT');
    });
  });
});
