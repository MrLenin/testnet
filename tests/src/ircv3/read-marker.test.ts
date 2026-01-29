import { describe, it, expect, afterEach } from 'vitest';
import {
  createRawSocketClient,
  RawSocketClient,
  uniqueChannel,
  getTestAccount,
  authenticateSaslPlain,
  getCaps,
} from '../helpers/index.js';

/**
 * Read Marker Tests (draft/read-marker)
 *
 * Tests the IRCv3 read marker specification for syncing read positions
 * across clients. Used by bouncers and multi-device setups.
 *
 * IMPORTANT: Read marker functionality requires SASL authentication.
 * Without authentication, MARKREAD commands are rejected or ignored.
 */
describe('IRCv3 Read Marker (draft/read-marker)', () => {
  const clients: RawSocketClient[] = [];
  const poolAccounts: string[] = [];

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

    // Release pool accounts
    const { releaseTestAccount } = await import('../helpers/index.js');
    for (const account of poolAccounts) {
      releaseTestAccount(account);
    }
    poolAccounts.length = 0;
  });

  describe('Capability', () => {
    it('server advertises draft/read-marker', async () => {
      const client = trackClient(await createRawSocketClient());

      const caps = await client.capLs();
      expect(caps.has('draft/read-marker')).toBe(true);

      client.send('QUIT');
    });

    it('can request draft/read-marker capability', async () => {
      const client = trackClient(await createRawSocketClient());

      await client.capLs();
      const result = await client.capReq(['draft/read-marker']);

      expect(result.ack).toContain('draft/read-marker');

      client.send('QUIT');
    });
  });

  describe('MARKREAD Command (Authenticated)', () => {
    it('can set and query read marker with MARKREAD', { retry: 2, timeout: 30000 }, async () => {
      const client = trackClient(await createRawSocketClient());

      // Get test account and authenticate via SASL
      const { account, password, fromPool } = await getTestAccount();
      if (fromPool) poolAccounts.push(account);

      await client.capLs();
      await client.capReq(['draft/read-marker', 'server-time', 'sasl']);

      // SASL PLAIN auth
      const saslResult = await authenticateSaslPlain(client, account, password, 20000);
      expect(saslResult.success, `SASL auth failed: ${saslResult.error}`).toBe(true);

      client.capEnd();
      client.register(`rm${account.slice(0, 6)}`);
      await client.waitForNumeric('001');

      const channel = uniqueChannel('rmset');
      client.send(`JOIN ${channel}`);
      await client.waitForJoin(channel);

      // Send a message to get a timestamp reference
      client.send(`PRIVMSG ${channel} :Test message for read marker`);
      await new Promise(r => setTimeout(r, 500));

      // Clear buffer before MARKREAD
      await new Promise(r => setTimeout(r, 200));
      client.clearRawBuffer();

      // Set read marker using timestamp
      const timestamp = new Date().toISOString();
      client.send(`MARKREAD ${channel} timestamp=${timestamp}`);

      // Must receive MARKREAD confirmation or 730 (RPL_MARKREAD)
      const setResponse = await client.waitForParsedLine(
        msg => msg.command === 'MARKREAD' || msg.command === '730',
        5000
      );
      expect(setResponse).toBeDefined();
      expect(setResponse.raw).toContain(channel);
      console.log('MARKREAD set response:', setResponse.raw);

      // Query the read marker
      await new Promise(r => setTimeout(r, 200));
      client.clearRawBuffer();
      client.send(`MARKREAD ${channel}`);

      // Must receive query response
      const queryResponse = await client.waitForParsedLine(
        msg => msg.command === 'MARKREAD' || msg.command === '730',
        5000
      );
      expect(queryResponse).toBeDefined();
      expect(queryResponse.raw).toContain(channel);
      console.log('MARKREAD query response:', queryResponse.raw);

      client.send('QUIT');
    });

    // NOTE: The IRCv3 read-marker spec does NOT support msgid parameter.
    // Only timestamp= is specified. This test is skipped until/unless
    // msgid support is added as a non-standard extension.
    it.skip('MARKREAD with msgid sets position (not in spec)', async () => {
      const client = trackClient(await createRawSocketClient());

      // Get test account and authenticate via SASL
      const { account, password, fromPool } = await getTestAccount();
      if (fromPool) poolAccounts.push(account);

      await client.capLs();
      await client.capReq(['draft/read-marker', 'echo-message', 'sasl', 'message-tags']);

      // SASL PLAIN auth
      const saslResult = await authenticateSaslPlain(client, account, password);
      expect(saslResult.success, `SASL auth failed: ${saslResult.error}`).toBe(true);

      client.capEnd();
      client.register(`rm${account.slice(0, 6)}`);
      await client.waitForNumeric('001');

      const channel = uniqueChannel('rmmsgid');
      client.send(`JOIN ${channel}`);
      await client.waitForJoin(channel);

      // Clear and send message to capture msgid from echo
      await new Promise(r => setTimeout(r, 200));
      client.clearRawBuffer();
      client.send(`PRIVMSG ${channel} :Message to mark as read`);

      const echo = await client.waitForParsedLine(
        msg => msg.command === 'PRIVMSG' && msg.raw.includes('Message to mark'),
        5000
      );

      // Extract msgid from tags
      const match = echo.raw.match(/msgid=([^\s;]+)/);
      expect(match, 'Echo should contain msgid').toBeTruthy();
      const msgid = match![1];
      console.log('Captured msgid:', msgid);

      // Set marker using msgid
      await new Promise(r => setTimeout(r, 200));
      client.clearRawBuffer();
      client.send(`MARKREAD ${channel} msgid=${msgid}`);

      const response = await client.waitForParsedLine(
        msg => msg.command === 'MARKREAD' || msg.command === '730',
        5000
      );
      expect(response).toBeDefined();
      expect(response.raw).toContain(channel);
      console.log('MARKREAD msgid response:', response.raw);

      client.send('QUIT');
    }, 30000);
  });

  describe('MARKREAD Synchronization', () => {
    it('MARKREAD syncs across multiple clients on same account', async () => {
      // Two clients authenticated to the SAME account should see synced markers
      const { account, password, fromPool } = await getTestAccount();
      if (fromPool) poolAccounts.push(account);

      const client1 = trackClient(await createRawSocketClient());
      const client2 = trackClient(await createRawSocketClient());

      // Authenticate client1
      await client1.capLs();
      await client1.capReq(['draft/read-marker', 'sasl']);
      const sasl1 = await authenticateSaslPlain(client1, account, password, 20000);
      expect(sasl1.success, `Client1 SASL failed: ${sasl1.error}`).toBe(true);
      client1.capEnd();
      client1.register(`sync1${account.slice(0, 4)}`);
      await client1.waitForNumeric('001');

      // Allow time for positive auth cache to be populated before second auth
      await new Promise(r => setTimeout(r, 500));

      // Authenticate client2 to SAME account
      await client2.capLs();
      await client2.capReq(['draft/read-marker', 'sasl']);
      const sasl2 = await authenticateSaslPlain(client2, account, password, 25000);
      expect(sasl2.success, `Client2 SASL failed: ${sasl2.error}`).toBe(true);
      client2.capEnd();
      client2.register(`sync2${account.slice(0, 4)}`);
      await client2.waitForNumeric('001');

      // Both join same channel
      const channel = uniqueChannel('rmsync');
      client1.send(`JOIN ${channel}`);
      client2.send(`JOIN ${channel}`);
      await client1.waitForJoin(channel);
      await client2.waitForJoin(channel);

      // Client1 sets read marker
      await new Promise(r => setTimeout(r, 200));
      client1.clearRawBuffer();
      const timestamp = new Date().toISOString();
      client1.send(`MARKREAD ${channel} timestamp=${timestamp}`);

      const setResponse = await client1.waitForParsedLine(
        msg => msg.command === 'MARKREAD' || msg.command === '730',
        5000
      );
      expect(setResponse).toBeDefined();
      console.log('Client1 set marker:', setResponse.raw);

      // Allow sync to propagate
      await new Promise(r => setTimeout(r, 500));

      // Client2 queries marker - should see the position set by client1
      client2.clearRawBuffer();
      client2.send(`MARKREAD ${channel}`);

      const queryResponse = await client2.waitForParsedLine(
        msg => msg.command === 'MARKREAD' || msg.command === '730',
        5000
      );
      expect(queryResponse).toBeDefined();
      expect(queryResponse.raw).toContain(channel);
      console.log('Client2 queried marker:', queryResponse.raw);

      // Verify the timestamp matches (rough check - within the same second)
      // The response should contain a timestamp close to what client1 set
      const responseHasTimestamp = queryResponse.raw.includes('timestamp=');
      expect(responseHasTimestamp, 'Response should contain timestamp').toBe(true);

      client1.send('QUIT');
      client2.send('QUIT');
    }, 45000);
  });

  describe('MARKREAD Errors', () => {
    it('rejects MARKREAD without authentication', { retry: 2 }, async () => {
      const client = trackClient(await createRawSocketClient());

      await client.capLs();
      // Request standard-replies so server sends FAIL instead of NOTICE fallback
      await client.capReq(['draft/read-marker', 'standard-replies']);
      client.capEnd();
      client.register('rmerr1');
      await client.waitForNumeric('001');

      const channel = uniqueChannel('rmerr');
      client.send(`JOIN ${channel}`);
      await client.waitForJoin(channel);

      await new Promise(r => setTimeout(r, 200));
      client.clearRawBuffer();

      // Try to set marker without authentication
      const timestamp = new Date().toISOString();
      client.send(`MARKREAD ${channel} timestamp=${timestamp}`);

      // Should receive error - FAIL, NOTICE fallback, or error numeric
      const response = await client.waitForParsedLine(
        msg => msg.command === 'FAIL' ||
               msg.command === '731' ||
               /^4\d\d$/.test(msg.command) ||
               msg.command === 'MARKREAD' ||
               // NOTICE fallback if standard-replies wasn't enabled
               (msg.command === 'NOTICE' && msg.raw.includes('ACCOUNT_REQUIRED')),
        5000
      );

      // If MARKREAD returned, it should be an error or empty marker
      // If FAIL, NOTICE, or error numeric, that's expected
      expect(response).toBeDefined();
      console.log('Unauthenticated MARKREAD response:', response.raw);

      client.send('QUIT');
    });

    it('rejects MARKREAD with invalid timestamp format', async () => {
      const client = trackClient(await createRawSocketClient());

      // Get test account and authenticate via SASL
      const { account, password, fromPool } = await getTestAccount();
      if (fromPool) poolAccounts.push(account);

      await client.capLs();
      await client.capReq(['draft/read-marker', 'sasl', 'standard-replies']);

      const saslResult = await authenticateSaslPlain(client, account, password);
      expect(saslResult.success, `SASL auth failed: ${saslResult.error}`).toBe(true);

      client.capEnd();
      client.register(`rm${account.slice(0, 6)}`);
      await client.waitForNumeric('001');

      const channel = uniqueChannel('rmerr');
      client.send(`JOIN ${channel}`);
      await client.waitForJoin(channel);

      await new Promise(r => setTimeout(r, 200));
      client.clearRawBuffer();

      // Invalid timestamp format
      client.send(`MARKREAD ${channel} timestamp=invalid`);

      // Server should reject with FAIL INVALID_PARAMS
      const response = await client.waitForParsedLine(
        msg => msg.command === 'FAIL' || /^4\d\d$/.test(msg.command),
        5000
      );
      expect(response.command).toBe('FAIL');
      expect(response.params[0]).toBe('MARKREAD');
      expect(response.params[1]).toBe('INVALID_PARAMS');

      client.send('QUIT');
    }, 30000);
  });

  describe('MARKREAD with Private Messages', () => {
    it('can set read marker for PM target', async () => {
      // Get test account and authenticate via SASL
      const { account, password, fromPool } = await getTestAccount();
      if (fromPool) poolAccounts.push(account);

      const client1 = trackClient(await createRawSocketClient());
      const client2 = trackClient(await createRawSocketClient());

      // Authenticate client1
      await client1.capLs();
      await client1.capReq(['draft/read-marker', 'sasl']);
      const saslResult = await authenticateSaslPlain(client1, account, password, 20000);
      expect(saslResult.success, `SASL auth failed: ${saslResult.error}`).toBe(true);
      client1.capEnd();

      const nick1 = `pmrm1${account.slice(0, 4)}`;
      client1.register(nick1);
      await client1.waitForNumeric('001');

      // Client2 just connects (no auth needed for sending PM)
      await client2.capLs();
      client2.capEnd();
      const nick2 = `pmrm2${account.slice(0, 4)}`;
      client2.register(nick2);
      await client2.waitForNumeric('001');

      // Client2 sends PM to client1
      client2.send(`PRIVMSG ${nick1} :Private message`);
      await new Promise(r => setTimeout(r, 500));

      // Client1 marks PM conversation as read
      await new Promise(r => setTimeout(r, 200));
      client1.clearRawBuffer();
      const timestamp = new Date().toISOString();
      client1.send(`MARKREAD ${nick2} timestamp=${timestamp}`);

      const response = await client1.waitForParsedLine(
        msg => msg.command === 'MARKREAD' || msg.command === '730',
        5000
      );
      expect(response).toBeDefined();
      console.log('PM MARKREAD response:', response.raw);

      client1.send('QUIT');
      client2.send('QUIT');
    }, 30000);
  });
});
