import { describe, it, expect, afterEach } from 'vitest';
import {
  createRawSocketClient,
  RawSocketClient,
  uniqueChannel,
  uniqueNick,
  PRIMARY_SERVER,
  getTestAccount,
  releaseTestAccount,
  authenticateSaslPlain,
  createSaslBouncerClient,
  createBouncerClient,
  bouncerEnableHold,
  bouncerDisableHold,
  bouncerInfo,
  disconnectAbruptly,
  reconnectBouncer,
  assertBouncerActive,
  assertNoBouncerSession,
} from '../helpers/index.js';

/**
 * Bouncer Feature Tests
 *
 * Tests the built-in bouncer system using per-account hold toggle:
 * - BOUNCER SET HOLD on → sets preference + auto-creates session
 * - BOUNCER INFO → read-only status check
 * - Hold on disconnect (ghost client preserves presence)
 * - Auto-resume on SASL reconnect (nick + channel preservation)
 * - BOUNCER SET HOLD off → opt-out of hold behavior
 * - Adaptive hold time (attach count tracking)
 *
 * Config assumptions:
 * - BOUNCER_ENABLE = TRUE
 * - BOUNCER_DEFAULT_HOLD = FALSE (no auto-creation for all SASL users)
 * - BOUNCER_AUTO_RESUME = TRUE (reconnecting with SASL resumes held sessions)
 */
describe('Built-in Bouncer', () => {
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
        // Ignore cleanup errors
      }
    }
    clients.length = 0;
    for (const account of poolAccounts) {
      releaseTestAccount(account);
    }
    poolAccounts.length = 0;
  });

  describe('Session Creation via SET HOLD', () => {
    it('BOUNCER SET HOLD on creates a session', async () => {
      const { account, password, fromPool } = await getTestAccount();
      if (fromPool) poolAccounts.push(account);

      const { client } = await createSaslBouncerClient(account, password);
      trackClient(client);

      // Before enabling hold, INFO should show no session
      const infoBefore = await bouncerInfo(client);
      // May be null or state=none before hold is enabled
      if (infoBefore) {
        expect(infoBefore.state).toBe('none');
      }

      // Enable hold → should create session
      const holdResult = await bouncerEnableHold(client);
      expect(holdResult, 'BOUNCER SET HOLD on should succeed').toBe(true);

      // INFO should now show an active session
      const info = await bouncerInfo(client);
      expect(info, 'BOUNCER INFO should return data after hold enabled').not.toBeNull();
      expect(info!.state).toBe('active');
      expect(info!.hold).toBe('on');

      // Cleanup: disable hold
      await bouncerDisableHold(client);
      client.send('QUIT');
    });

    it('SASL connection without SET HOLD does not create a session', async () => {
      const { account, password, fromPool } = await getTestAccount();
      if (fromPool) poolAccounts.push(account);

      // Connect with SASL but do NOT enable hold
      const { client } = await createSaslBouncerClient(account, password);
      trackClient(client);

      // INFO should show no session (DEFAULT_HOLD = FALSE)
      const info = await bouncerInfo(client);
      if (info) {
        expect(info.state, 'No session should exist without SET HOLD on').toBe('none');
      }

      client.send('QUIT');
    });

    it('non-SASL connection has no bouncer functionality', async () => {
      const client = trackClient(await createRawSocketClient());
      await client.capLs();
      await client.capReq(['away-notify']);
      client.capEnd();
      client.register(uniqueNick('nobnc'));
      await client.waitForNumeric('001');
      await new Promise(r => setTimeout(r, 300));

      // BOUNCER INFO should fail or return nothing for unauthenticated users
      const info = await bouncerInfo(client);
      expect(info, 'Non-SASL client should have no bouncer info').toBeNull();

      client.send('QUIT');
    });
  });

  describe('BOUNCER INFO', () => {
    it('shows session state, hold preference, and session ID', async () => {
      const { account, password, fromPool } = await getTestAccount();
      if (fromPool) poolAccounts.push(account);

      const { client } = await createBouncerClient(account, password);
      trackClient(client);

      const info = await assertBouncerActive(client, 'SASL+hold client');

      // Session should have a valid ID format
      expect(info.sessionId).toMatch(/^[A-Za-z0-9]+-\d+$/);
      expect(info.state).toBe('active');
      expect(info.hold).toBe('on');
      expect(info.holdSource).toBe('account');

      // Cleanup
      await bouncerDisableHold(client);
      client.send('QUIT');
    });

    it('shows hold=off for accounts without hold preference', async () => {
      const { account, password, fromPool } = await getTestAccount();
      if (fromPool) poolAccounts.push(account);

      const { client } = await createSaslBouncerClient(account, password);
      trackClient(client);

      const info = await bouncerInfo(client);
      if (info) {
        // Without explicit SET HOLD on, hold should be off (using default)
        expect(info.hold).toBe('off');
        expect(info.holdSource).toBe('default');
      }

      client.send('QUIT');
    });
  });

  describe('Hold on Disconnect', () => {
    it('abrupt disconnect puts session into HOLDING state', async () => {
      const { account, password, fromPool } = await getTestAccount();
      if (fromPool) poolAccounts.push(account);

      // Create client with hold enabled (creates session)
      const { client: conn1 } = await createBouncerClient(account, password);
      trackClient(conn1);

      const channel = uniqueChannel('hold');
      conn1.send(`JOIN ${channel}`);
      await conn1.waitForJoin(channel);

      // Disconnect abruptly — should enter HOLDING
      disconnectAbruptly(conn1);

      // Wait for hold to take effect
      await new Promise(r => setTimeout(r, 2000));

      // Reconnect with SASL — auto-resume picks up held session
      const { client: conn2 } = await reconnectBouncer(account, password);
      trackClient(conn2);

      // After auto-resume, session should be ACTIVE again
      const info = await bouncerInfo(conn2);
      expect(info, 'Should have bouncer info after reconnect').not.toBeNull();
      expect(info!.state, 'Session should be ACTIVE after auto-resume').toBe('active');

      // Cleanup
      await bouncerDisableHold(conn2);
      conn2.send('QUIT');
    });

    it('ghost client preserves channel membership during HOLDING', async () => {
      const { account, password, fromPool } = await getTestAccount();
      if (fromPool) poolAccounts.push(account);

      // Create an observer to monitor channel activity
      const observer = trackClient(await createRawSocketClient());
      await observer.capLs();
      await observer.capReq(['away-notify']);
      observer.capEnd();
      observer.register(uniqueNick('obs'));
      await observer.waitForNumeric('001');

      const channel = uniqueChannel('ghost');
      observer.send(`JOIN ${channel}`);
      await observer.waitForJoin(channel);

      // Create bouncer client and join the channel
      const { client: conn1, nick: nick1 } = await createBouncerClient(account, password);
      trackClient(conn1);
      conn1.send(`JOIN ${channel}`);
      await conn1.waitForJoin(channel);

      // Observer should see the join
      await observer.waitForJoin(channel, nick1);

      observer.clearRawBuffer();

      // Disconnect abruptly — ghost should hold, NOT QUIT
      disconnectAbruptly(conn1);

      // Wait for the hold to process
      await new Promise(r => setTimeout(r, 2000));

      // Observer should NOT see a QUIT from nick1 (ghost holds the channel)
      let gotQuit = false;
      try {
        await observer.waitForParsedLine(
          msg => msg.command === 'QUIT' && msg.source?.nick?.toLowerCase() === nick1.toLowerCase(),
          2000,
        );
        gotQuit = true;
      } catch {
        // Expected: timeout means no QUIT (ghost is holding)
      }
      expect(gotQuit, `Ghost should NOT quit channel — expected HOLDING state for ${nick1}`).toBe(false);

      // Reconnect to clean up the session
      const { client: conn2 } = await reconnectBouncer(account, password);
      trackClient(conn2);
      await bouncerDisableHold(conn2);
      conn2.send('QUIT');
      observer.send('QUIT');
    });
  });

  describe('Auto-Resume', () => {
    it('SASL reconnect resumes held session with same nick', async () => {
      const { account, password, fromPool } = await getTestAccount();
      if (fromPool) poolAccounts.push(account);

      // Connect with hold enabled, note the nick
      const { client: conn1, nick: nick1 } = await createBouncerClient(account, password);
      trackClient(conn1);

      // Disconnect to enter HOLDING
      disconnectAbruptly(conn1);
      await new Promise(r => setTimeout(r, 2000));

      // Reconnect with a different nick — auto-resume should swap to ghost's nick
      const { client: conn2 } = await reconnectBouncer(account, password, {
        nick: uniqueNick('tmp'),
      });
      trackClient(conn2);

      // Session should be ACTIVE after resume
      const info = await assertBouncerActive(conn2, 'resumed client');
      expect(info.state).toBe('active');

      // Attach count should be >= 1 (resumed at least once)
      if (info.resumes !== undefined) {
        expect(info.resumes, 'Resume count should increment after resume').toBeGreaterThanOrEqual(1);
      }

      // Cleanup
      await bouncerDisableHold(conn2);
      conn2.send('QUIT');
    });

    it('auto-resume preserves channel membership', async () => {
      const { account, password, fromPool } = await getTestAccount();
      if (fromPool) poolAccounts.push(account);

      const channel = uniqueChannel('resume');

      // Connect with hold, join channel
      const { client: conn1 } = await createBouncerClient(account, password);
      trackClient(conn1);
      conn1.send(`JOIN ${channel}`);
      await conn1.waitForJoin(channel);

      // Send a message so the channel has history
      conn1.send(`PRIVMSG ${channel} :Before disconnect`);
      await new Promise(r => setTimeout(r, 300));

      // Disconnect
      disconnectAbruptly(conn1);
      await new Promise(r => setTimeout(r, 2000));

      // Reconnect — should auto-resume with channel membership
      const { client: conn2 } = await reconnectBouncer(account, password);
      trackClient(conn2);

      // Verify we're in the channel by sending a message (no error = we're in)
      conn2.clearRawBuffer();
      conn2.send(`PRIVMSG ${channel} :After resume`);

      // If we're NOT in the channel, we'd get ERR_CANNOTSENDTOCHAN (404)
      let gotError = false;
      try {
        await conn2.waitForNumeric(['404', '442'], 2000);
        gotError = true;
      } catch {
        // Expected: no error means we're in the channel
      }
      expect(gotError, `Should be in ${channel} after auto-resume`).toBe(false);

      // Cleanup
      await bouncerDisableHold(conn2);
      conn2.send('QUIT');
    });
  });

  describe('Hold Opt-Out', () => {
    it('BOUNCER SET HOLD off disables session holding', async () => {
      const { account, password, fromPool } = await getTestAccount();
      if (fromPool) poolAccounts.push(account);

      // Create client with hold enabled
      const { client } = await createBouncerClient(account, password);
      trackClient(client);

      // Verify hold is on
      const infoBefore = await bouncerInfo(client);
      expect(infoBefore).not.toBeNull();
      expect(infoBefore!.hold).toBe('on');

      // Opt out of hold
      const result = await bouncerDisableHold(client);
      expect(result, 'BOUNCER SET HOLD off should succeed').toBe(true);

      // Verify hold is now off
      const infoAfter = await bouncerInfo(client);
      expect(infoAfter).not.toBeNull();
      expect(infoAfter!.hold).toBe('off');

      client.send('QUIT');
    });

    it('after HOLD off, disconnect does not preserve session', async () => {
      const { account, password, fromPool } = await getTestAccount();
      if (fromPool) poolAccounts.push(account);

      // Create observer
      const observer = trackClient(await createRawSocketClient());
      await observer.capLs();
      await observer.capReq(['away-notify']);
      observer.capEnd();
      observer.register(uniqueNick('obs'));
      await observer.waitForNumeric('001');

      const channel = uniqueChannel('nohold');
      observer.send(`JOIN ${channel}`);
      await observer.waitForJoin(channel);

      // Create bouncer client, enable hold, then disable it
      const { client: conn1, nick: nick1 } = await createBouncerClient(account, password);
      trackClient(conn1);
      conn1.send(`JOIN ${channel}`);
      await conn1.waitForJoin(channel);
      await observer.waitForJoin(channel, nick1);

      // Disable hold
      await bouncerDisableHold(conn1);
      await new Promise(r => setTimeout(r, 300));

      observer.clearRawBuffer();

      // Disconnect — without hold, should QUIT normally
      disconnectAbruptly(conn1);

      // Observer SHOULD see a QUIT (no ghost holding)
      let gotQuit = false;
      try {
        await observer.waitForParsedLine(
          msg => msg.command === 'QUIT' && msg.source?.nick?.toLowerCase() === nick1.toLowerCase(),
          5000,
        );
        gotQuit = true;
      } catch {
        // Timeout — ghost might still be holding
      }
      expect(gotQuit, `${nick1} should QUIT normally when hold is off`).toBe(true);

      observer.send('QUIT');
    });
  });

  describe('Adaptive Hold Time', () => {
    it('new session has base hold time', async () => {
      const { account, password, fromPool } = await getTestAccount();
      if (fromPool) poolAccounts.push(account);

      const { client } = await createBouncerClient(account, password);
      trackClient(client);

      const info = await assertBouncerActive(client, 'new session');

      // New session (0 resumes) should have base hold time (BOUNCER_SESSION_HOLD = 14400s = 4h)
      if (info.holdTime !== undefined) {
        expect(info.holdTime, 'New session should have base hold time (14400s)').toBe(14400);
      }

      // Cleanup
      await bouncerDisableHold(client);
      client.send('QUIT');
    });

    it('resumed session has increased hold time', async () => {
      const { account, password, fromPool } = await getTestAccount();
      if (fromPool) poolAccounts.push(account);

      // Connect with hold, disconnect, reconnect (simulate resume cycle)
      const { client: conn1 } = await createBouncerClient(account, password);
      trackClient(conn1);

      disconnectAbruptly(conn1);
      await new Promise(r => setTimeout(r, 2000));

      // Reconnect — auto-resume increments attach count
      const { client: conn2 } = await reconnectBouncer(account, password);
      trackClient(conn2);

      const info = await assertBouncerActive(conn2, 'resumed session');

      // After 1 resume, hold time should be base + 25% = 18000s
      if (info.holdTime !== undefined && info.resumes !== undefined) {
        expect(info.holdTime, 'Resumed session should have increased hold time')
          .toBeGreaterThan(14400);
      }

      // Cleanup
      await bouncerDisableHold(conn2);
      conn2.send('QUIT');
    });
  });

  describe('draft/bouncer CAP', () => {
    it('server advertises draft/bouncer capability', async () => {
      const client = trackClient(await createRawSocketClient());
      const caps = await client.capLs();

      expect(caps.has('draft/bouncer'), 'Server should advertise draft/bouncer').toBe(true);

      client.send('QUIT');
    });
  });
});
