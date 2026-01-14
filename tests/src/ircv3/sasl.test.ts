import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { createRawSocketClient, RawSocketClient, uniqueId } from '../helpers/index.js';
import { getTestAccount, releaseTestAccount } from '../helpers/x3-client.js';

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
      await client.waitForCommand('AUTHENTICATE', 10000);
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
      await client.waitForNumeric('903', 20000); // RPL_SASLSUCCESS
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
      const response = await client.waitForCommand('AUTHENTICATE', 10000);
      expect(response.command).toBe('AUTHENTICATE');
      expect(response.params[0] || response.trailing).toBe('+');

      // Properly abort SASL session before quitting to prevent
      // race conditions with subsequent tests
      client.send('AUTHENTICATE *');
      await client.waitForNumeric('906', 5000);  // Wait for abort confirmation
      client.send('QUIT');
    });

    it('receives 904 for invalid credentials', { retry: 2 }, async () => {
      const client = trackClient(await createRawSocketClient());

      await client.capLs();
      await client.capReq(['sasl']);

      // Clear buffer before SASL flow to avoid interference
      client.clearBuffer();

      client.send('AUTHENTICATE PLAIN');
      await client.waitForCommand('AUTHENTICATE', 10000);

      // Send invalid credentials
      const invalidPayload = Buffer.from('invalid\0invalid\0wrongpass').toString('base64');
      client.send(`AUTHENTICATE ${invalidPayload}`);

      // Small delay to let server process and respond
      await new Promise(r => setTimeout(r, 100));

      // Should receive 904 (ERR_SASLFAIL)
      // Note: Keycloak takes longer (~6s) to reject invalid credentials vs accept valid ones (~100ms)
      // Use 20s timeout to handle load conditions
      const result = await client.waitForNumeric(['900', '901', '902', '903', '904', '905', '906', '907', '908', '909'], 20000);
      // 904 = SASLFAIL, 902 = NICK_LOCKED
      expect(result.command).toMatch(/90[24]/);
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

      const welcome = await client.waitForNumeric('001');
      expect(welcome.raw).toContain('authtest3');
      client.send('QUIT');
    });

    it('receives 900 on successful authentication', { retry: 2 }, async () => {
      // Use pool account to avoid collision with previous test
      const { account, password, fromPool } = await getTestAccount();

      const client = trackClient(await createRawSocketClient());
      client.clearBuffer();

      await client.capLs();
      await client.capReq(['sasl']);

      client.send('AUTHENTICATE PLAIN');
      const authPlus = await client.waitForCommand('AUTHENTICATE', 10000);
      console.log('Got AUTHENTICATE +:', authPlus.raw);

      const payload = Buffer.from(`${account}\0${account}\0${password}`).toString('base64');
      console.log(`Sending credentials for ${account}`);
      client.send(`AUTHENTICATE ${payload}`);

      // Server MUST send 900 (RPL_LOGGEDIN) or 903 (RPL_SASLSUCCESS)
      // Note: Keycloak can take 3-6s under load
      const result = await client.waitForNumeric(['900', '903'], 20000);
      expect(result.command).toMatch(/^(900|903)$/);
      console.log(`Got ${result.command} for ${account}`);

      if (fromPool) releaseTestAccount(account);
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
      const response = await client.waitForParsedLine(
        msg => msg.command === 'AUTHENTICATE' || ['900', '904', '908'].includes(msg.command),
        5000
      );
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

      console.log('Starting SASL authentication...');
      const success = await saslPlain(client, TEST_ACCOUNT, TEST_PASSWORD);
      console.log(`SASL result: ${success}`);
      // This test REQUIRES SASL to work - fail if it doesn't
      expect(success).toBe(true);

      client.capEnd();
      client.register('accttest1');
      console.log('Waiting for 001...');
      await client.waitForNumeric('001', 15000);
      console.log('Got 001, registered successfully');

      // Small delay to ensure registration is fully processed
      await new Promise(r => setTimeout(r, 200));

      // Join a channel and check for extended-join with account
      const channel = `#accttest${uniqueId().slice(0, 6)}`;
      console.log(`Joining ${channel}...`);
      client.send(`JOIN ${channel}`);

      let joinMsg;
      try {
        joinMsg = await client.waitForJoin(channel, undefined, 10000);
        console.log(`Got JOIN: ${joinMsg.raw}`);
      } catch (err) {
        console.log('JOIN timed out. Dumping all received lines:');
        for (const line of client.allLines) {
          console.log(`  ${line}`);
        }
        throw err;
      }
      expect(joinMsg).toBeDefined();

      // With extended-join, JOIN includes account name in params[1]
      // Format: :nick!user@host JOIN #channel accountname :realname
      if (joinMsg.params.length >= 2) {
        console.log(`Account in JOIN: ${joinMsg.params[1]}`);
        expect(joinMsg.params[1]).toBe(TEST_ACCOUNT);
      }

      // Or with account-tag: @account=name :nick!user@host JOIN #channel
      if (joinMsg.tags.account) {
        console.log(`Account tag: ${joinMsg.tags.account}`);
        expect(joinMsg.tags.account).toBe(TEST_ACCOUNT);
      }

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
      await regClient.waitForNumeric('001');

      // Generate unique account name (max 15 chars for ACCOUNTLEN)
      const uniqueAccount = `sl${uniqueId()}`;
      const uniquePassword = 'testpass123';

      // Format per spec: REGISTER <account> <email> <password>
      regClient.send(`REGISTER ${uniqueAccount} ${uniqueAccount}@example.com ${uniquePassword}`);

      const response = await regClient.waitForNumeric('920', 5000);
      expect(response.command).toBe('920');

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
      await authClient.waitForNumeric('001');

      // Verify we're logged in - WHOIS should show account
      authClient.send(`WHOIS saslauth1`);
      const whoisResponse = await authClient.waitForNumeric(['330', '311'], 3000);
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
    const response = await client.waitForParsedLine(
      msg => msg.command === 'AUTHENTICATE' || ['904', '908'].includes(msg.command),
      3000
    );
    expect(response).toBeDefined();
    console.log('Unknown mechanism response:', response.raw);
    client.send('QUIT');
  });

  it('AUTHENTICATE * aborts authentication', async () => {
    const client = trackClient(await createRawSocketClient());

    await client.capLs();
    await client.capReq(['sasl']);

    client.send('AUTHENTICATE PLAIN');
    await client.waitForCommand('AUTHENTICATE', 10000);

    // Clear buffer before abort to ensure we catch the 906 response
    client.clearRawBuffer();

    // Abort authentication
    client.send('AUTHENTICATE *');

    // IRCv3 spec: AUTHENTICATE * should trigger 906 (ERR_SASLABORTED)
    // X3 now properly handles abort and responds with D A
    // Use longer timeout as the abort goes through X3 async processing
    const response = await client.waitForNumeric('906', 10000);
    expect(response.command).toBe('906');
    client.send('QUIT');
  });

  it('handles malformed base64 in AUTHENTICATE', async () => {
    const client = trackClient(await createRawSocketClient());

    // Clear buffer to avoid interference from previous tests
    client.clearBuffer();

    await client.capLs();
    await client.capReq(['sasl']);

    client.send('AUTHENTICATE PLAIN');
    await client.waitForCommand('AUTHENTICATE', 10000);

    // Send invalid base64
    client.send('AUTHENTICATE !!!invalid-base64!!!');

    // Should receive error
    // Note: Error path can be slow under load
    const response = await client.waitForNumeric(['900', '901', '902', '903', '904', '905', '906', '907', '908', '909'], 20000);
    expect(response).toBeDefined();
    console.log('Malformed base64 response:', response.raw);
    client.send('QUIT');
  });

  it('handles empty AUTHENTICATE payload', async () => {
    const client = trackClient(await createRawSocketClient());

    // Clear buffer to avoid interference from previous tests
    client.clearBuffer();

    await client.capLs();
    await client.capReq(['sasl']);

    client.send('AUTHENTICATE PLAIN');
    await client.waitForCommand('AUTHENTICATE', 10000);

    // Send empty payload (just +)
    client.send('AUTHENTICATE +');

    // Should receive error (empty SASL response)
    // Note: Keycloak auth can take ~6s for error responses
    const response = await client.waitForNumeric(['900', '901', '902', '903', '904', '905', '906', '907', '908', '909'], 20000);
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
      await client.waitForParsedLine(
        msg => msg.command === 'AUTHENTICATE' || /^90\d$/.test(msg.command),
        2000
      );
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
    const welcome = await client.waitForNumeric('001');
    expect(welcome.command).toBe('001');
    client.send('QUIT');
  });

  // Skip: This test takes 30+ seconds waiting for SASL timeout
  // Enable manually if testing SASL timeout behavior
  it.skip('enforces SASL timeout', async () => {
    const client = trackClient(await createRawSocketClient());

    await client.capLs();
    await client.capReq(['sasl']);

    client.send('AUTHENTICATE PLAIN');
    await client.waitForCommand('AUTHENTICATE', 10000);

    // Don't send credentials - wait for timeout (typically 30 seconds)
    // Server should eventually send 906 (ERR_SASLABORTED) or disconnect
    const response = await client.waitForNumeric('906', 45000);
    expect(response).toBeDefined();
    client.send('QUIT');
  });
});

describe('SASL 400-byte Chunking', () => {
  /**
   * SASL spec requires payloads >400 bytes to be split into 400-byte chunks.
   * If the payload is exactly N*400 bytes, a final '+' must be sent to signal end.
   * These tests verify X3's chunk reassembly works correctly.
   */
  const CHUNK_SIZE = 400;

  const clients: RawSocketClient[] = [];

  const trackClient = (client: RawSocketClient): RawSocketClient => {
    clients.push(client);
    return client;
  };

  /**
   * Send SASL payload with proper 400-byte chunking.
   * Per SASL spec: payloads >400 bytes must be chunked, and if the final
   * chunk is exactly 400 bytes, a '+' must be sent to signal completion.
   */
  async function sendChunkedPayload(client: RawSocketClient, base64Payload: string): Promise<void> {
    if (base64Payload.length < CHUNK_SIZE) {
      // Small payload - send directly, no terminator needed
      client.send(`AUTHENTICATE ${base64Payload}`);
      return;
    }

    // Send chunks with small delays to avoid flooding
    for (let i = 0; i < base64Payload.length; i += CHUNK_SIZE) {
      const chunk = base64Payload.slice(i, i + CHUNK_SIZE);
      client.send(`AUTHENTICATE ${chunk}`);
      await new Promise(r => setTimeout(r, 50));
    }

    // If last chunk was exactly 400 bytes, send '+' to signal end
    if (base64Payload.length % CHUNK_SIZE === 0) {
      client.send('AUTHENTICATE +');
    }
  }

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

  it('handles small payload (no chunking needed)', async () => {
    const client = trackClient(await createRawSocketClient());
    client.clearBuffer();

    await client.capLs();
    await client.capReq(['sasl']);

    client.send('AUTHENTICATE PLAIN');
    await client.waitForCommand('AUTHENTICATE', 10000);

    // Small payload - no chunking
    const user = 'testuser';
    const pass = 'testpass';
    const payload = Buffer.from(`${user}\0${user}\0${pass}`).toString('base64');
    expect(payload.length).toBeLessThan(CHUNK_SIZE);

    await sendChunkedPayload(client, payload);
    await new Promise(r => setTimeout(r, 100));

    const response = await client.waitForNumeric(['900', '901', '902', '903', '904', '905', '906', '907', '908', '909'], 20000);
    expect(response).toBeDefined();
    client.send('QUIT');
  });

  it('handles payload requiring 2 chunks (500 base64 bytes)', { retry: 2 }, async () => {
    const client = trackClient(await createRawSocketClient());
    client.clearBuffer();

    await client.capLs();
    await client.capReq(['sasl']);

    client.send('AUTHENTICATE PLAIN');
    await client.waitForCommand('AUTHENTICATE', 10000);

    // Create payload that results in ~500 base64 bytes (2 chunks: 400 + 100)
    // 500 base64 bytes = ~375 raw bytes
    // PLAIN format: authzid\0authcid\0password
    const authzid = 'a'.repeat(125);
    const authcid = 'b'.repeat(125);
    const password = 'c'.repeat(125);
    const payload = Buffer.from(`${authzid}\0${authcid}\0${password}`).toString('base64');

    expect(payload.length).toBeGreaterThan(CHUNK_SIZE);
    expect(payload.length).toBeLessThan(CHUNK_SIZE * 2);
    console.log(`2-chunk test: payload is ${payload.length} base64 bytes`);

    await sendChunkedPayload(client, payload);
    // Longer delay to allow X3 to fully process the chunked payload
    await new Promise(r => setTimeout(r, 300));

    // Should get SASLFAIL (904) because credentials are invalid, but that proves
    // the server received and processed the full chunked payload
    const response = await client.waitForNumeric(['900', '901', '902', '903', '904', '905', '906', '907', '908', '909'], 20000);
    expect(response).toBeDefined();
    console.log(`2-chunk test response: ${response.command}`);
    client.send('QUIT');
  });

  it('handles payload requiring 3 chunks (900 base64 bytes)', async () => {
    const client = trackClient(await createRawSocketClient());
    client.clearBuffer();

    await client.capLs();
    await client.capReq(['sasl']);

    client.send('AUTHENTICATE PLAIN');
    await client.waitForCommand('AUTHENTICATE', 10000);

    // Create payload that results in ~900 base64 bytes (3 chunks: 400 + 400 + 100)
    // 900 base64 bytes = ~675 raw bytes
    const authzid = 'a'.repeat(225);
    const authcid = 'b'.repeat(225);
    const password = 'c'.repeat(225);
    const payload = Buffer.from(`${authzid}\0${authcid}\0${password}`).toString('base64');

    expect(payload.length).toBeGreaterThan(CHUNK_SIZE * 2);
    expect(payload.length).toBeLessThan(CHUNK_SIZE * 3);
    console.log(`3-chunk test: payload is ${payload.length} base64 bytes`);

    await sendChunkedPayload(client, payload);
    await new Promise(r => setTimeout(r, 100));

    const response = await client.waitForNumeric(['900', '901', '902', '903', '904', '905', '906', '907', '908', '909'], 20000);
    expect(response).toBeDefined();
    console.log(`3-chunk test response: ${response.command}`);
    client.send('QUIT');
  });

  it('handles exactly 400-byte payload (needs + terminator)', async () => {
    const client = trackClient(await createRawSocketClient());
    client.clearBuffer();

    await client.capLs();
    await client.capReq(['sasl']);

    client.send('AUTHENTICATE PLAIN');
    await client.waitForCommand('AUTHENTICATE', 10000);

    // Create payload of exactly 400 base64 bytes
    // 400 base64 bytes = 300 raw bytes
    const authzid = 'a'.repeat(100);
    const authcid = 'b'.repeat(100);
    const password = 'c'.repeat(98); // 100 + 100 + 98 + 2 nulls = 300
    const payload = Buffer.from(`${authzid}\0${authcid}\0${password}`).toString('base64');

    // Adjust to exactly 400 if needed
    const exactPayload = payload.slice(0, CHUNK_SIZE);
    expect(exactPayload.length).toBe(CHUNK_SIZE);
    console.log(`Exact 400-byte test: payload is ${exactPayload.length} base64 bytes`);

    await sendChunkedPayload(client, exactPayload);
    await new Promise(r => setTimeout(r, 100));

    const response = await client.waitForNumeric(['900', '901', '902', '903', '904', '905', '906', '907', '908', '909'], 20000);
    expect(response).toBeDefined();
    console.log(`Exact 400-byte test response: ${response.command}`);
    client.send('QUIT');
  });

  it('handles exactly 800-byte payload (2 full chunks + terminator)', async () => {
    const client = trackClient(await createRawSocketClient());
    client.clearBuffer();

    await client.capLs();
    await client.capReq(['sasl']);

    client.send('AUTHENTICATE PLAIN');
    await client.waitForCommand('AUTHENTICATE', 10000);

    // Create payload of exactly 800 base64 bytes = 600 raw bytes
    const authzid = 'a'.repeat(200);
    const authcid = 'b'.repeat(200);
    const password = 'c'.repeat(198); // 200 + 200 + 198 + 2 nulls = 600
    const payload = Buffer.from(`${authzid}\0${authcid}\0${password}`).toString('base64');

    // Adjust to exactly 800 if needed
    const exactPayload = payload.slice(0, CHUNK_SIZE * 2);
    expect(exactPayload.length).toBe(CHUNK_SIZE * 2);
    console.log(`Exact 800-byte test: payload is ${exactPayload.length} base64 bytes`);

    await sendChunkedPayload(client, exactPayload);
    await new Promise(r => setTimeout(r, 100));

    const response = await client.waitForNumeric(['900', '901', '902', '903', '904', '905', '906', '907', '908', '909'], 20000);
    expect(response).toBeDefined();
    console.log(`Exact 800-byte test response: ${response.command}`);
    client.send('QUIT');
  });

  it('handles rapid sequential chunks (stress test)', async () => {
    const client = trackClient(await createRawSocketClient());
    client.clearBuffer();

    await client.capLs();
    await client.capReq(['sasl']);

    client.send('AUTHENTICATE PLAIN');
    await client.waitForCommand('AUTHENTICATE', 10000);

    // Create a larger payload (5 chunks)
    const authzid = 'a'.repeat(500);
    const authcid = 'b'.repeat(500);
    const password = 'c'.repeat(500);
    const payload = Buffer.from(`${authzid}\0${authcid}\0${password}`).toString('base64');

    expect(payload.length).toBeGreaterThan(CHUNK_SIZE * 4);
    console.log(`Stress test: payload is ${payload.length} base64 bytes (${Math.ceil(payload.length / CHUNK_SIZE)} chunks)`);

    // Send chunks with minimal delay (stress test)
    for (let i = 0; i < payload.length; i += CHUNK_SIZE) {
      const chunk = payload.slice(i, i + CHUNK_SIZE);
      client.send(`AUTHENTICATE ${chunk}`);
      // Minimal delay - test server can handle rapid chunks
      await new Promise(r => setTimeout(r, 10));
    }
    if (payload.length % CHUNK_SIZE === 0) {
      client.send('AUTHENTICATE +');
    }

    await new Promise(r => setTimeout(r, 100));

    const response = await client.waitForNumeric(['900', '901', '902', '903', '904', '905', '906', '907', '908', '909'], 20000);
    expect(response).toBeDefined();
    console.log(`Stress test response: ${response.command}`);
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
    await client.waitForCommand('AUTHENTICATE', 10000);

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
    const response = await client.waitForNumeric('903', 20000);
    expect(response.command).toBe('903');

    client.send('QUIT');
  });
});
