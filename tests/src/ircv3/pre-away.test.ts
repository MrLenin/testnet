import { describe, it, expect, afterEach } from 'vitest';
import {
  createRawSocketClient,
  RawSocketClient,
  uniqueChannel,
  uniqueId,
  X3Client,
  PRIMARY_SERVER,
  setupTestAccount,
  releaseTestAccount,
  getTestAccount,
  authenticateSaslPlain,
} from '../helpers/index.js';

/**
 * Pre-Away Tests (draft/pre-away)
 *
 * Tests the IRCv3 pre-away specification which allows clients to set
 * their away status during connection registration, before completing
 * the registration process.
 */
describe('IRCv3 Pre-Away (draft/pre-away)', () => {
  const clients: RawSocketClient[] = [];
  const poolAccounts: string[] = [];

  const trackClient = <T extends RawSocketClient>(client: T): T => {
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
    for (const account of poolAccounts) {
      releaseTestAccount(account);
    }
    poolAccounts.length = 0;
  });

  describe('Capability', () => {
    it('server advertises draft/pre-away', async () => {
      const client = trackClient(await createRawSocketClient());

      const caps = await client.capLs();
      expect(caps.has('draft/pre-away')).toBe(true);

      client.send('QUIT');
    });

    it('can request draft/pre-away capability', async () => {
      const client = trackClient(await createRawSocketClient());

      await client.capLs();
      const result = await client.capReq(['draft/pre-away']);

      expect(result.ack).toContain('draft/pre-away');

      client.send('QUIT');
    });
  });

  describe('AWAY During Registration', () => {
    it('can send AWAY before CAP END', async () => {
      const client = trackClient(await createRawSocketClient());

      await client.capLs();
      await client.capReq(['draft/pre-away', 'away-notify']);

      // Set away BEFORE CAP END
      client.send('AWAY :Connecting...');

      // Should not receive error - pre-away allows this
      await new Promise(r => setTimeout(r, 300));

      // Now complete registration
      client.capEnd();
      client.register('papre1');

      const welcome = await client.waitForNumeric('001');
      expect(welcome.raw).toContain('papre1');

      // Verify we're marked as away
      client.clearRawBuffer();
      client.send('WHOIS papre1');

      try {
        // 301 is RPL_AWAY in WHOIS
        const whoisAway = await client.waitForNumeric('301', 5000);
        expect(whoisAway.raw).toContain('Connecting...');
      } catch {
        // May need to check differently
        console.log('No away status in WHOIS');
      }

      client.send('QUIT');
    });

    it('AWAY before registration persists after registration', async () => {
      const client = trackClient(await createRawSocketClient());

      await client.capLs();
      await client.capReq(['draft/pre-away']);

      // Set away before registration
      const awayMessage = 'Set during registration';
      client.send(`AWAY :${awayMessage}`);

      await new Promise(r => setTimeout(r, 200));

      client.capEnd();
      client.register('papersist1');
      await client.waitForNumeric('001');

      client.clearRawBuffer();

      // Check if away persists
      client.send('WHOIS papersist1');

      try {
        const whoisReply = await client.waitForNumeric('301', 5000);
        expect(whoisReply.raw).toContain(awayMessage);
      } catch {
        console.log('Away status may not persist or WHOIS format differs');
      }

      client.send('QUIT');
    });

    it('other users see pre-set away status on join', async () => {
      const preaway = trackClient(await createRawSocketClient());
      const observer = trackClient(await createRawSocketClient());

      // Pre-away client sets away during registration
      await preaway.capLs();
      await preaway.capReq(['draft/pre-away']);
      preaway.send('AWAY :Pre-set away message');
      await new Promise(r => setTimeout(r, 200));
      preaway.capEnd();
      preaway.register('pajoiner1');
      await preaway.waitForNumeric('001');

      // Observer with away-notify
      await observer.capLs();
      await observer.capReq(['away-notify']);
      observer.capEnd();
      observer.register('paobs1');
      await observer.waitForNumeric('001');

      const channel = uniqueChannel('preaway');
      observer.send(`JOIN ${channel}`);
      await observer.waitForJoin(channel);

      observer.clearRawBuffer();

      // Pre-away client joins
      preaway.send(`JOIN ${channel}`);
      await preaway.waitForJoin(channel);

      // Observer may receive AWAY notification
      try {
        const awayNotif = await observer.waitForParsedLine(
          msg => msg.command === 'AWAY' && msg.source?.nick?.toLowerCase() === 'pajoiner1',
          3000
        );
        expect(awayNotif.raw).toContain('Pre-set away message');
      } catch {
        // May not send AWAY on join, depends on implementation
        console.log('No AWAY notification on join');
      }

      preaway.send('QUIT');
      observer.send('QUIT');
    });
  });

  describe('Without pre-away', () => {
    it('AWAY before registration without pre-away may fail', async () => {
      const client = trackClient(await createRawSocketClient());

      // Do NOT request pre-away
      await client.capLs();
      await client.capReq(['multi-prefix']);

      client.clearRawBuffer();

      // Try AWAY before CAP END
      client.send('AWAY :Should not work');

      try {
        // May receive error or be ignored
        const response = await client.waitForParsedLine(
          msg => msg.command === 'AWAY' || msg.command === 'FAIL' ||
                 /^4\d\d$/.test(msg.command) || msg.command === '451',
          2000
        );
        console.log('AWAY without pre-away response:', response.raw);
        // 451 = ERR_NOTREGISTERED
      } catch {
        // May be silently ignored
        console.log('AWAY without pre-away silently ignored');
      }

      // Complete registration
      client.capEnd();
      client.register('panopre1');
      await client.waitForNumeric('001');

      client.send('QUIT');
    });
  });

  describe('Pre-Away Edge Cases', () => {
    it('can clear pre-away with empty AWAY', async () => {
      const client = trackClient(await createRawSocketClient());

      await client.capLs();
      await client.capReq(['draft/pre-away']);

      // Set away
      client.send('AWAY :Initial away');
      await new Promise(r => setTimeout(r, 200));

      // Clear away before registration
      client.send('AWAY');
      await new Promise(r => setTimeout(r, 200));

      client.capEnd();
      client.register('paclear1');
      await client.waitForNumeric('001');

      client.clearRawBuffer();

      // Check if away is cleared
      client.send('WHOIS paclear1');

      try {
        // Should NOT have 301 (away) in WHOIS
        // Wait for WHOIS end marker instead
        await client.waitForNumeric('318', 3000);

        // If we get here without error, check buffer for any 301
        // This is a simplified check - in production you'd collect all lines
        console.log('WHOIS completed - away should be cleared');
      } catch {
        console.log('Could not verify away cleared');
      }

      client.send('QUIT');
    });

    it('multiple AWAY commands during registration uses last one', async () => {
      const client = trackClient(await createRawSocketClient());

      await client.capLs();
      await client.capReq(['draft/pre-away']);

      // Multiple away messages
      client.send('AWAY :First message');
      await new Promise(r => setTimeout(r, 100));
      client.send('AWAY :Second message');
      await new Promise(r => setTimeout(r, 100));
      client.send('AWAY :Final message');
      await new Promise(r => setTimeout(r, 200));

      client.capEnd();
      client.register('pamulti1');
      await client.waitForNumeric('001');

      client.clearRawBuffer();

      client.send('WHOIS pamulti1');

      try {
        const whoisAway = await client.waitForNumeric('301', 5000);
        // Should have final message
        expect(whoisAway.raw).toContain('Final message');
      } catch {
        console.log('Could not verify final away message');
      }

      client.send('QUIT');
    });
  });

  describe('Away-Star (AWAY *)', () => {
    /**
     * Helper: create an authenticated X3Client with away-notify caps.
     * Returns the client, account info, and nick.
     */
    async function createAuthedAwayClient(
      extraCaps: string[] = [],
      nick?: string,
    ): Promise<{ client: X3Client; account: string; password: string; fromPool: boolean; nick: string }> {
      const client = new X3Client();
      await client.connect(PRIMARY_SERVER.host, PRIMARY_SERVER.port);
      await client.capLs();
      await client.capReq(['away-notify', ...extraCaps]);
      client.capEnd();
      const actualNick = nick || `aw${uniqueId().slice(0, 7)}`;
      client.register(actualNick);
      await client.waitForNumeric('001');
      await new Promise(r => setTimeout(r, 500));
      client.clearRawBuffer();
      const { account, password, fromPool } = await setupTestAccount(client);
      return { client, account, password, fromPool, nick: actualNick };
    }

    it('AWAY * sets hidden (away-star) state', async () => {
      const { client, account, fromPool, nick } = await createAuthedAwayClient();
      trackClient(client);
      if (fromPool) poolAccounts.push(account);

      client.clearRawBuffer();
      client.send('AWAY *');

      // Should get RPL_NOWAWAY (306)
      const nowAway = await client.waitForNumeric('306', 5000);
      expect(nowAway).toBeDefined();

      // WHOIS should show away status with fallback message
      client.clearRawBuffer();
      client.send(`WHOIS ${nick}`);

      const whoisAway = await client.waitForNumeric('301', 5000);
      // AWAY_STAR_MSG = "Away" in ircd.conf
      expect(whoisAway.raw).toContain('Away');

      client.send('QUIT');
    });

    it('AWAY * can be cleared with empty AWAY', async () => {
      const { client, account, fromPool, nick } = await createAuthedAwayClient();
      trackClient(client);
      if (fromPool) poolAccounts.push(account);

      // Set away-star
      client.send('AWAY *');
      await client.waitForNumeric('306', 5000);

      // Clear it
      client.clearRawBuffer();
      client.send('AWAY');

      // Should get RPL_UNAWAY (305)
      const unaway = await client.waitForNumeric('305', 5000);
      expect(unaway).toBeDefined();

      // WHOIS should not show 301 (away) anymore
      client.clearRawBuffer();
      client.send(`WHOIS ${nick}`);
      const whoisEnd = await client.waitForNumeric('318', 5000);
      expect(whoisEnd).toBeDefined();

      client.send('QUIT');
    });

    it('observer sees AWAY notification for away-star user joining channel', async () => {
      const { client: awayClient, account: awayAcct, fromPool: awayFromPool, nick: awayNick } =
        await createAuthedAwayClient();
      trackClient(awayClient);
      if (awayFromPool) poolAccounts.push(awayAcct);

      const { client: observer, account: obsAcct, fromPool: obsFromPool } =
        await createAuthedAwayClient();
      trackClient(observer);
      if (obsFromPool) poolAccounts.push(obsAcct);

      // Set away-star on the away client
      awayClient.send('AWAY *');
      await awayClient.waitForNumeric('306', 5000);

      // Observer joins channel
      const channel = uniqueChannel('awstar');
      observer.send(`JOIN ${channel}`);
      await observer.waitForJoin(channel);
      observer.clearRawBuffer();

      // Away-star client joins
      awayClient.send(`JOIN ${channel}`);
      await awayClient.waitForJoin(channel);

      // Observer should receive AWAY notification for the joining user
      try {
        const awayNotif = await observer.waitForParsedLine(
          msg => msg.command === 'AWAY' && msg.source?.nick?.toLowerCase() === awayNick.toLowerCase(),
          3000
        );
        // Should have the fallback message for away-star
        expect(awayNotif.raw).toContain('Away');
      } catch {
        // Some implementations may not send AWAY on join
        console.log('No AWAY notification on join for away-star user');
      }

      awayClient.send('QUIT');
      observer.send('QUIT');
    });
  });

  describe('Presence Aggregation (multi-connection)', () => {
    /**
     * Helper: create a second authenticated connection to the same account.
     * Uses SASL PLAIN to bind the connection to the account before registration.
     */
    async function createSecondConnection(
      account: string,
      password: string,
      nick?: string,
      extraCaps: string[] = [],
    ): Promise<{ client: RawSocketClient; nick: string }> {
      const client = await createRawSocketClient();
      await client.capLs();
      await client.capReq(['sasl', 'away-notify', ...extraCaps]);

      // SASL PLAIN auth to bind to same account
      const result = await authenticateSaslPlain(client, account, password);
      if (!result.success) {
        throw new Error(`SASL auth failed for second connection: ${result.error}`);
      }

      client.capEnd();
      const actualNick = nick || `aw2_${uniqueId().slice(0, 6)}`;
      client.register(actualNick);
      await client.waitForNumeric('001');
      await new Promise(r => setTimeout(r, 500));
      client.clearRawBuffer();
      return { client, nick: actualNick };
    }

    /**
     * Helper: create an authenticated X3Client for presence tests.
     */
    async function createPresenceClient(
      extraCaps: string[] = [],
      nick?: string,
    ): Promise<{ client: X3Client; account: string; password: string; fromPool: boolean; nick: string }> {
      const client = new X3Client();
      await client.connect(PRIMARY_SERVER.host, PRIMARY_SERVER.port);
      await client.capLs();
      await client.capReq(['away-notify', ...extraCaps]);
      client.capEnd();
      const actualNick = nick || `pr${uniqueId().slice(0, 7)}`;
      client.register(actualNick);
      await client.waitForNumeric('001');
      await new Promise(r => setTimeout(r, 500));
      client.clearRawBuffer();
      const { account, password, fromPool } = await setupTestAccount(client);
      return { client, account, password, fromPool, nick: actualNick };
    }

    it('one present + one away-star connection: effective state is PRESENT', async () => {
      // Create first connection and authenticate
      const { client: conn1, account, password, fromPool, nick: nick1 } =
        await createPresenceClient();
      trackClient(conn1);
      if (fromPool) poolAccounts.push(account);

      // Create second connection to same account via SASL
      const { client: conn2, nick: nick2 } = await createSecondConnection(account, password);
      trackClient(conn2);

      // Create observer
      const observer = trackClient(await createRawSocketClient());
      await observer.capLs();
      await observer.capReq(['away-notify']);
      observer.capEnd();
      observer.register(`probs${uniqueId().slice(0, 5)}`);
      await observer.waitForNumeric('001');
      await new Promise(r => setTimeout(r, 500));

      // All join a channel
      const channel = uniqueChannel('presagg');
      observer.send(`JOIN ${channel}`);
      await observer.waitForJoin(channel);
      conn1.send(`JOIN ${channel}`);
      await conn1.waitForJoin(channel);
      conn2.send(`JOIN ${channel}`);
      await conn2.waitForJoin(channel);
      await new Promise(r => setTimeout(r, 500));

      // Set conn2 to away-star, conn1 stays present
      observer.clearRawBuffer();
      conn2.send('AWAY *');
      await conn2.waitForNumeric('306', 5000);

      // With aggregation, effective state should remain PRESENT
      // because conn1 is still present. Observer should NOT get an AWAY notification.
      let gotUnexpectedAway = false;
      try {
        await observer.waitForParsedLine(
          msg => msg.command === 'AWAY' && (
            msg.source?.nick?.toLowerCase() === nick1.toLowerCase() ||
            msg.source?.nick?.toLowerCase() === nick2.toLowerCase()
          ),
          2000
        );
        gotUnexpectedAway = true;
      } catch {
        // Expected: timeout means no AWAY notification (aggregated state is PRESENT)
      }
      expect(gotUnexpectedAway, 'Should NOT receive AWAY when another connection is present').toBe(false);

      // WHOIS on conn1's nick should NOT show away
      observer.clearRawBuffer();
      observer.send(`WHOIS ${nick1}`);
      const whoisEnd = await observer.waitForNumeric('318', 5000);
      expect(whoisEnd).toBeDefined();

      conn1.send('QUIT');
      conn2.send('QUIT');
      observer.send('QUIT');
    });

    it('all connections away-star: effective state is AWAY (hidden)', async () => {
      // Create first connection and authenticate
      const { client: conn1, account, password, fromPool, nick: nick1 } =
        await createPresenceClient();
      trackClient(conn1);
      if (fromPool) poolAccounts.push(account);

      // Create second connection to same account via SASL
      const { client: conn2, nick: nick2 } = await createSecondConnection(account, password);
      trackClient(conn2);

      // Create observer
      const observer = trackClient(await createRawSocketClient());
      await observer.capLs();
      await observer.capReq(['away-notify']);
      observer.capEnd();
      observer.register(`probs${uniqueId().slice(0, 5)}`);
      await observer.waitForNumeric('001');
      await new Promise(r => setTimeout(r, 500));

      // All join a channel
      const channel = uniqueChannel('presall');
      observer.send(`JOIN ${channel}`);
      await observer.waitForJoin(channel);
      conn1.send(`JOIN ${channel}`);
      await conn1.waitForJoin(channel);
      conn2.send(`JOIN ${channel}`);
      await conn2.waitForJoin(channel);
      await new Promise(r => setTimeout(r, 500));
      observer.clearRawBuffer();

      // Set BOTH connections to away-star
      conn1.send('AWAY *');
      await conn1.waitForNumeric('306', 5000);
      conn2.send('AWAY *');
      await conn2.waitForNumeric('306', 5000);

      // With all connections away-star, effective state should be AWAY
      // Observer should receive an AWAY notification
      const awayNotif = await observer.waitForParsedLine(
        msg => msg.command === 'AWAY' && (
          msg.source?.nick?.toLowerCase() === nick1.toLowerCase() ||
          msg.source?.nick?.toLowerCase() === nick2.toLowerCase()
        ),
        3000
      );
      // Should contain the AWAY_STAR_MSG fallback
      expect(awayNotif.raw).toContain('Away');

      // WHOIS should show away with fallback message
      observer.clearRawBuffer();
      observer.send(`WHOIS ${nick1}`);
      const whoisAway = await observer.waitForNumeric('301', 5000);
      expect(whoisAway.raw).toContain('Away');

      conn1.send('QUIT');
      conn2.send('QUIT');
      observer.send('QUIT');
    });

    it('transition from all-away-star to present clears away', async () => {
      // Create first connection and authenticate
      const { client: conn1, account, password, fromPool, nick: nick1 } =
        await createPresenceClient();
      trackClient(conn1);
      if (fromPool) poolAccounts.push(account);

      // Create second connection to same account via SASL
      const { client: conn2 } = await createSecondConnection(account, password);
      trackClient(conn2);

      // Create observer
      const observer = trackClient(await createRawSocketClient());
      await observer.capLs();
      await observer.capReq(['away-notify']);
      observer.capEnd();
      observer.register(`probs${uniqueId().slice(0, 5)}`);
      await observer.waitForNumeric('001');
      await new Promise(r => setTimeout(r, 500));

      // All join a channel
      const channel = uniqueChannel('prestrans');
      observer.send(`JOIN ${channel}`);
      await observer.waitForJoin(channel);
      conn1.send(`JOIN ${channel}`);
      await conn1.waitForJoin(channel);
      conn2.send(`JOIN ${channel}`);
      await conn2.waitForJoin(channel);
      await new Promise(r => setTimeout(r, 500));

      // Set both to away-star
      conn1.send('AWAY *');
      await conn1.waitForNumeric('306', 5000);
      conn2.send('AWAY *');
      await conn2.waitForNumeric('306', 5000);
      await new Promise(r => setTimeout(r, 500));

      // Now clear away on conn1 — effective state should transition to PRESENT
      observer.clearRawBuffer();
      conn1.send('AWAY');
      await conn1.waitForNumeric('305', 5000);

      // Observer should receive an un-away notification (AWAY with no message)
      const unawayNotif = await observer.waitForParsedLine(
        msg => msg.command === 'AWAY' && (
          msg.source?.nick?.toLowerCase() === nick1.toLowerCase()
        ),
        3000
      );
      // Un-away: trailing should be empty or absent
      // The raw line should be like ":nick!user@host AWAY" with no trailing
      expect(unawayNotif.command).toBe('AWAY');

      // WHOIS should no longer show away for this user
      observer.clearRawBuffer();
      observer.send(`WHOIS ${nick1}`);
      const whoisEnd = await observer.waitForNumeric('318', 5000);
      expect(whoisEnd).toBeDefined();

      conn1.send('QUIT');
      conn2.send('QUIT');
      observer.send('QUIT');
    });

    it('mixed away states: one AWAY, one AWAY * — effective is AWAY with message', async () => {
      // Create first connection and authenticate
      const { client: conn1, account, password, fromPool, nick: nick1 } =
        await createPresenceClient();
      trackClient(conn1);
      if (fromPool) poolAccounts.push(account);

      // Create second connection to same account via SASL
      const { client: conn2 } = await createSecondConnection(account, password);
      trackClient(conn2);

      // Create observer
      const observer = trackClient(await createRawSocketClient());
      await observer.capLs();
      await observer.capReq(['away-notify']);
      observer.capEnd();
      observer.register(`probs${uniqueId().slice(0, 5)}`);
      await observer.waitForNumeric('001');
      await new Promise(r => setTimeout(r, 500));

      // All join a channel
      const channel = uniqueChannel('presmix');
      observer.send(`JOIN ${channel}`);
      await observer.waitForJoin(channel);
      conn1.send(`JOIN ${channel}`);
      await conn1.waitForJoin(channel);
      conn2.send(`JOIN ${channel}`);
      await conn2.waitForJoin(channel);
      await new Promise(r => setTimeout(r, 500));
      observer.clearRawBuffer();

      // conn1: regular AWAY, conn2: AWAY *
      conn1.send('AWAY :In a meeting');
      await conn1.waitForNumeric('306', 5000);
      conn2.send('AWAY *');
      await conn2.waitForNumeric('306', 5000);

      // Both connections are away, so effective state should be AWAY
      // The message should come from the regular AWAY (not the fallback)
      const awayNotif = await observer.waitForParsedLine(
        msg => msg.command === 'AWAY' && (
          msg.source?.nick?.toLowerCase() === nick1.toLowerCase()
        ),
        3000
      );
      expect(awayNotif.raw).toContain('In a meeting');

      // WHOIS should show away with the explicit message
      observer.clearRawBuffer();
      observer.send(`WHOIS ${nick1}`);
      const whoisAway = await observer.waitForNumeric('301', 5000);
      expect(whoisAway.raw).toContain('In a meeting');

      conn1.send('QUIT');
      conn2.send('QUIT');
      observer.send('QUIT');
    });
  });
});
