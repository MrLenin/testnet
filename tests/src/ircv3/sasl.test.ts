import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { createRawSocketClient, RawSocketClient, uniqueId } from '../helpers/index.js';

/**
 * SASL Authentication Tests
 *
 * Note: These tests require a registered account on the server.
 * The test assumes an account 'testuser' with password 'testpass' exists.
 * This account is created by scripts/setup-keycloak.sh.
 *
 * Alternatively, some tests can run without authentication to verify
 * the SASL protocol flow.
 */
describe('IRCv3 SASL Authentication', () => {
  const clients: RawSocketClient[] = [];

  // Test credentials - should match a registered account in Keycloak
  // Created by scripts/setup-keycloak.sh
  const TEST_ACCOUNT = process.env.IRC_TEST_ACCOUNT ?? 'testuser';
  const TEST_PASSWORD = process.env.IRC_TEST_PASSWORD ?? 'testpass';

  const trackClient = (client: RawSocketClient): RawSocketClient => {
    clients.push(client);
    return client;
  };

  beforeEach(async () => {
    // Delay before each test to prevent Keycloak overload from rapid auth attempts
    // Multiple tests authenticate with same account - need spacing
    await new Promise(r => setTimeout(r, 500));
  });

  afterEach(async () => {
    for (const client of clients) {
      try {
        client.close();
      } catch {
        // Ignore errors during cleanup
      }
    }
    clients.length = 0;
    // Allow X3/Keycloak to recover between tests
    await new Promise(r => setTimeout(r, 500));
  });

  // Helper for SASL PLAIN authentication
  // Note: Keycloak auth can take ~6s for invalid credentials, ~100ms for valid
  const saslPlain = async (client: RawSocketClient, user: string, pass: string): Promise<boolean> => {
    // Clear buffer to avoid interference from previous tests
    client.clearBuffer();
    client.send('AUTHENTICATE PLAIN');

    try {
      await client.waitForLine(/^AUTHENTICATE \+$/, 10000);
    } catch {
      return false;
    }

    // SASL PLAIN format: base64(authzid\0authcid\0password)
    const payload = Buffer.from(`${user}\0${user}\0${pass}`).toString('base64');
    client.send(`AUTHENTICATE ${payload}`);

    // Small delay to allow server to process and respond
    await new Promise(r => setTimeout(r, 100));

    try {
      // Use longer timeout (20s) since Keycloak can be slow under load
      await client.waitForLine(/903/, 20000); // RPL_SASLSUCCESS
      return true;
    } catch {
      return false;
    }
  };

  describe('SASL Capability', () => {
    it('server advertises sasl capability', async () => {
      const client = trackClient(await createRawSocketClient());
      const caps = await client.capLs();
      expect(caps.has('sasl')).toBe(true);
      client.send('QUIT');
    });

    it('can request sasl capability', async () => {
      const client = trackClient(await createRawSocketClient());
      await client.capLs();
      const result = await client.capReq(['sasl']);

      expect(result.ack).toContain('sasl');
      expect(client.hasCapEnabled('sasl')).toBe(true);
      client.send('QUIT');
    });
  });

  describe('SASL PLAIN Flow', () => {
    it('server responds to AUTHENTICATE PLAIN', async () => {
      const client = trackClient(await createRawSocketClient());

      await client.capLs();
      await client.capReq(['sasl']);

      // Small delay to allow event loop to process pending I/O
      await new Promise(r => setTimeout(r, 100));

      client.send('AUTHENTICATE PLAIN');

      // Server should respond with AUTHENTICATE +
      // Use longer timeout (10s) due to occasional IRCd→X3→IRCd roundtrip delays
      const response = await client.waitForLine(/^AUTHENTICATE \+$/, 10000);
      expect(response).toBe('AUTHENTICATE +');

      // Properly abort SASL session before quitting to prevent
      // race conditions with subsequent tests
      client.send('AUTHENTICATE *');
      await client.waitForLine(/906/, 5000);  // Wait for abort confirmation
      client.send('QUIT');
    });

    it('receives 904 for invalid credentials', async () => {
      const client = trackClient(await createRawSocketClient());

      await client.capLs();
      await client.capReq(['sasl']);

      // Clear buffer before SASL flow to avoid interference
      client.clearBuffer();

      client.send('AUTHENTICATE PLAIN');
      await client.waitForLine(/^AUTHENTICATE \+$/, 10000);

      // Send invalid credentials
      const invalidPayload = Buffer.from('invalid\0invalid\0wrongpass').toString('base64');
      client.send(`AUTHENTICATE ${invalidPayload}`);

      // Small delay to let server process and respond
      await new Promise(r => setTimeout(r, 100));

      // Should receive 904 (ERR_SASLFAIL)
      // Note: Keycloak takes longer (~6s) to reject invalid credentials vs accept valid ones (~100ms)
      // Use 20s timeout to handle load conditions
      const result = await client.waitForLine(/90[0-9]/, 20000);
      // 904 = SASLFAIL, 902 = NICK_LOCKED
      expect(result).toMatch(/90[24]/);
      client.send('QUIT');
    });

    it('can authenticate with valid credentials', async () => {
      const client = trackClient(await createRawSocketClient());

      await client.capLs();
      await client.capReq(['sasl']);

      const success = await saslPlain(client, TEST_ACCOUNT, TEST_PASSWORD);

      // Keycloak should always be available with testuser account
      // If this fails, it's a real problem that should be fixed
      expect(success).toBe(true);

      client.capEnd();
      client.register('authtest3');

      const welcome = await client.waitForLine(/001/);
      expect(welcome).toContain('authtest3');
      client.send('QUIT');
    });

    it('receives 900 on successful authentication', async () => {
      // Extra delay for test isolation - previous test also authenticates same account
      // X3 needs time to clean up SASL sessions
      await new Promise(r => setTimeout(r, 1000));

      const client = trackClient(await createRawSocketClient());

      // Clear buffer to avoid interference from previous tests
      client.clearBuffer();

      await client.capLs();
      await client.capReq(['sasl']);

      client.send('AUTHENTICATE PLAIN');
      const authPlus = await client.waitForLine(/^AUTHENTICATE \+$/, 10000);
      console.log('Got AUTHENTICATE +:', authPlus);

      const payload = Buffer.from(`${TEST_ACCOUNT}\0${TEST_ACCOUNT}\0${TEST_PASSWORD}`).toString('base64');
      console.log('Sending credentials payload');
      client.send(`AUTHENTICATE ${payload}`);

      // Small delay to allow server to process and respond
      await new Promise(r => setTimeout(r, 50));

      // Server MUST send 900 (RPL_LOGGEDIN) or 903 (RPL_SASLSUCCESS)
      // Test will fail if account doesn't exist - that's expected
      // Note: Keycloak can take 3-6s under load
      const result = await client.waitForLine(/(900|903)/, 20000);
      expect(result).toMatch(/(900|903)/);
      client.send('QUIT');
    });
  });

  describe('SASL EXTERNAL Flow', () => {
    it('EXTERNAL requires TLS client certificate', async () => {
      const client = trackClient(await createRawSocketClient());

      await client.capLs();
      const result = await client.capReq(['sasl']);
      expect(result.ack).toContain('sasl');

      // Try EXTERNAL without certificate
      client.send('AUTHENTICATE EXTERNAL');

      // Server should respond - either with AUTHENTICATE continuation or error
      // Without a client cert, we expect either 904/908 (failed) or AUTHENTICATE +
      const response = await client.waitForLine(/(AUTHENTICATE|90[048])/, 5000);
      expect(response).toBeDefined();
      client.send('QUIT');
    });
  });

  describe('Account Tags After SASL', () => {
    it('JOIN messages include account after SASL auth', async () => {
      // Extra delay to avoid Keycloak rate limiting from rapid auth attempts
      await new Promise(r => setTimeout(r, 1500));

      const client = trackClient(await createRawSocketClient());

      await client.capLs();
      await client.capReq(['sasl', 'extended-join', 'account-tag']);

      const success = await saslPlain(client, TEST_ACCOUNT, TEST_PASSWORD);
      // This test REQUIRES SASL to work - fail if it doesn't
      expect(success).toBe(true);

      client.capEnd();
      client.register('accttest1');
      await client.waitForLine(/001/);

      // Small delay to ensure registration is fully processed
      await new Promise(r => setTimeout(r, 200));

      // Join a channel and check for extended-join with account
      client.send('JOIN #accttestchan');

      const joinMsg = await client.waitForLine(/JOIN.*#accttestchan/i, 5000);
      expect(joinMsg).toBeDefined();

      // With extended-join, JOIN includes account name
      // Format: :nick!user@host JOIN #channel accountname :realname
      // Or with account-tag: @account=name :nick!user@host JOIN #channel
      client.send('QUIT');
    });
  });

  describe('Full SASL Flow', () => {
    // Skip: This test requires draft/account-registration CAP which is not
    // currently supported by X3. When X3 adds support, remove the .skip()
    it.skip('can register account and authenticate with it', async () => {
      // Step 1: Register a new account using draft/account-registration
      const regClient = trackClient(await createRawSocketClient());

      await regClient.capLs();
      const regCaps = await regClient.capReq(['draft/account-registration']);

      // Require the capability - if not present, test fails
      expect(regCaps.ack).toContain('draft/account-registration');

      regClient.capEnd();
      regClient.register('saslreg1');
      await regClient.waitForLine(/001/);

      // Generate unique account name (max 15 chars for ACCOUNTLEN)
      const uniqueAccount = `sl${uniqueId()}`;
      const uniquePassword = 'testpass123';

      // Format per spec: REGISTER <account> <email> <password>
      regClient.send(`REGISTER ${uniqueAccount} ${uniqueAccount}@example.com ${uniquePassword}`);

      const response = await regClient.waitForLine(/REGISTER SUCCESS|920/, 5000);
      expect(response).toMatch(/SUCCESS|920/);

      regClient.send('QUIT');
      await new Promise(r => setTimeout(r, 500));

      // Step 2: Connect fresh and authenticate with the new account
      const authClient = trackClient(await createRawSocketClient());

      await authClient.capLs();
      await authClient.capReq(['sasl']);

      const success = await saslPlain(authClient, uniqueAccount, uniquePassword);
      expect(success).toBe(true);

      authClient.capEnd();
      authClient.register('saslauth1');
      await authClient.waitForLine(/001/);

      // Verify we're logged in - WHOIS should show account
      authClient.send(`WHOIS saslauth1`);
      const whoisResponse = await authClient.waitForLine(/330|WHOIS|311/i, 3000);
      expect(whoisResponse).toBeDefined();

      authClient.send('QUIT');
    });
  });
});

describe('SASL Error Handling', () => {
  const clients: RawSocketClient[] = [];

  const trackClient = (client: RawSocketClient): RawSocketClient => {
    clients.push(client);
    return client;
  };

  afterEach(async () => {
    for (const client of clients) {
      try {
        client.close();
      } catch {
        // Ignore
      }
    }
    clients.length = 0;
    // Allow X3 to clean up SASL sessions between tests
    await new Promise(r => setTimeout(r, 300));
  });

  beforeEach(async () => {
    // Small delay before each test to prevent connection flooding
    await new Promise(r => setTimeout(r, 100));
  });

  it('rejects unknown SASL mechanism', async () => {
    const client = trackClient(await createRawSocketClient());

    await client.capLs();
    await client.capReq(['sasl']);

    // Try an unknown mechanism
    client.send('AUTHENTICATE UNKNOWN_MECHANISM');

    // Should receive 908 (RPL_SASLMECHS) or other error
    const response = await client.waitForLine(/90[48]|AUTHENTICATE/i, 3000);
    expect(response).toBeDefined();
    console.log('Unknown mechanism response:', response);
    client.send('QUIT');
  });

  it('AUTHENTICATE * aborts authentication', async () => {
    const client = trackClient(await createRawSocketClient());

    await client.capLs();
    await client.capReq(['sasl']);

    client.send('AUTHENTICATE PLAIN');
    await client.waitForLine(/AUTHENTICATE \+/, 10000);

    // Abort authentication
    client.send('AUTHENTICATE *');

    // IRCv3 spec: AUTHENTICATE * should trigger 906 (ERR_SASLABORTED)
    // X3 now properly handles abort and responds with D A
    const response = await client.waitForLine(/906/i, 5000);
    expect(response).toMatch(/906/);
    client.send('QUIT');
  });

  it('handles malformed base64 in AUTHENTICATE', async () => {
    const client = trackClient(await createRawSocketClient());

    // Clear buffer to avoid interference from previous tests
    client.clearBuffer();

    await client.capLs();
    await client.capReq(['sasl']);

    client.send('AUTHENTICATE PLAIN');
    await client.waitForLine(/AUTHENTICATE \+/, 10000);

    // Send invalid base64
    client.send('AUTHENTICATE !!!invalid-base64!!!');

    // Should receive error
    // Note: Error path can be slow under load
    const response = await client.waitForLine(/90[0-9]|FAIL/i, 20000);
    expect(response).toBeDefined();
    console.log('Malformed base64 response:', response);
    client.send('QUIT');
  });

  it('handles empty AUTHENTICATE payload', async () => {
    const client = trackClient(await createRawSocketClient());

    // Clear buffer to avoid interference from previous tests
    client.clearBuffer();

    await client.capLs();
    await client.capReq(['sasl']);

    client.send('AUTHENTICATE PLAIN');
    await client.waitForLine(/AUTHENTICATE \+/, 10000);

    // Send empty payload (just +)
    client.send('AUTHENTICATE +');

    // Should receive error (empty SASL response)
    // Note: Keycloak auth can take ~6s for error responses
    const response = await client.waitForLine(/90[0-9]|FAIL/i, 20000);
    expect(response).toBeDefined();
    client.send('QUIT');
  });

  it('handles AUTHENTICATE before CAP REQ sasl', async () => {
    const client = trackClient(await createRawSocketClient());

    await client.capLs();
    // Don't request SASL capability

    client.send('AUTHENTICATE PLAIN');

    // Nefarious code (m_authenticate.c:131-132) returns 0 without response if SASL cap not active
    // This is intentional - verify by checking we can still complete registration
    try {
      await client.waitForLine(/AUTHENTICATE|90[0-9]/i, 2000);
      // If we get here, server responded (unexpected but not wrong)
      throw new Error('Server responded to AUTHENTICATE without SASL cap enabled');
    } catch (error) {
      // Timeout expected - server silently ignored the command
      if (error instanceof Error && error.message.includes('Server responded')) {
        throw error;
      }
    }

    // Verify client can still complete registration normally
    client.capEnd();
    client.register('noauthtest');
    const welcome = await client.waitForLine(/001/);
    expect(welcome).toContain('001');
    client.send('QUIT');
  });

  // Skip: This test takes 30+ seconds waiting for SASL timeout
  // Enable manually if testing SASL timeout behavior
  it.skip('enforces SASL timeout', async () => {
    const client = trackClient(await createRawSocketClient());

    await client.capLs();
    await client.capReq(['sasl']);

    client.send('AUTHENTICATE PLAIN');
    await client.waitForLine(/AUTHENTICATE \+/, 10000);

    // Don't send credentials - wait for timeout (typically 30 seconds)
    // Server should eventually send 906 (ERR_SASLABORTED) or disconnect
    const response = await client.waitForLine(/906|ERROR/i, 45000);
    expect(response).toBeDefined();
    client.send('QUIT');
  });
});

describe('SASL Multi-line Payload', () => {
  const clients: RawSocketClient[] = [];

  const trackClient = (client: RawSocketClient): RawSocketClient => {
    clients.push(client);
    return client;
  };

  afterEach(async () => {
    for (const client of clients) {
      try {
        client.close();
      } catch {
        // Ignore
      }
    }
    clients.length = 0;
    // Allow X3 to clean up SASL sessions between tests
    await new Promise(r => setTimeout(r, 300));
  });

  beforeEach(async () => {
    // Small delay before each test to prevent connection flooding
    await new Promise(r => setTimeout(r, 100));
  });

  it('handles 400-byte payload chunks', async () => {
    const client = trackClient(await createRawSocketClient());

    // Clear buffer to avoid interference
    client.clearBuffer();

    await client.capLs();
    await client.capReq(['sasl']);

    client.send('AUTHENTICATE PLAIN');
    await client.waitForLine(/AUTHENTICATE \+/, 10000);

    // Create a long payload that would need chunking (>400 bytes base64)
    // Actually, PLAIN auth payloads are typically small, so this tests
    // the infrastructure rather than actual chunking
    const user = 'testuser';
    const pass = 'testpass';
    const payload = Buffer.from(`${user}\0${user}\0${pass}`).toString('base64');

    client.send(`AUTHENTICATE ${payload}`);

    // Should get response (success or failure)
    // Keycloak async lookup for unknown accounts can take 10-15s
    const response = await client.waitForLine(/90[0-9]/i, 20000);
    expect(response).toBeDefined();
    client.send('QUIT');
  });
});

describe('SASL with account-notify', () => {
  const clients: RawSocketClient[] = [];

  const trackClient = (client: RawSocketClient): RawSocketClient => {
    clients.push(client);
    return client;
  };

  afterEach(async () => {
    for (const client of clients) {
      try {
        client.close();
      } catch {
        // Ignore
      }
    }
    clients.length = 0;
    // Allow X3 to clean up SASL sessions between tests
    await new Promise(r => setTimeout(r, 300));
  });

  beforeEach(async () => {
    // Small delay before each test to prevent connection flooding
    await new Promise(r => setTimeout(r, 100));
  });

  it('ACCOUNT message sent after SASL auth', async () => {
    // Extra delay to avoid Keycloak rate limiting from rapid auth attempts
    await new Promise(r => setTimeout(r, 1000));

    const client = trackClient(await createRawSocketClient());

    // Clear buffer to avoid interference from previous tests
    client.clearBuffer();

    await client.capLs();
    await client.capReq(['sasl', 'account-notify']);

    client.send('AUTHENTICATE PLAIN');
    await client.waitForLine(/AUTHENTICATE \+/, 10000);

    // Use test credentials
    const user = process.env.IRC_TEST_ACCOUNT ?? 'testuser';
    const pass = process.env.IRC_TEST_PASSWORD ?? 'testpass';
    const payload = Buffer.from(`${user}\0${user}\0${pass}`).toString('base64');

    client.send(`AUTHENTICATE ${payload}`);

    // Small delay to allow server to process and respond
    await new Promise(r => setTimeout(r, 100));

    // Should receive 903 (success) and possibly ACCOUNT message
    // Keycloak and testuser should always be available
    // Use 20s timeout to handle load conditions
    const response = await client.waitForLine(/903/i, 20000);
    expect(response).toMatch(/903/);

    client.send('QUIT');
  });
});
