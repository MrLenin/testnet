import { describe, it, expect, afterEach } from 'vitest';
import {
  createRawSocketClient,
  RawSocketClient,
  uniqueChannel,
  uniqueNick,
  getTestAccount,
  releaseTestAccount,
  createSaslBouncerClient,
  createBouncerClient,
  bouncerEnableHold,
  bouncerDisableHold,
  bouncerInfo,
  disconnectAbruptly,
  reconnectBouncer,
  assertBouncerActive,
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

      // Connect with hold, join channel, set topic
      const { client: conn1 } = await createBouncerClient(account, password);
      trackClient(conn1);
      conn1.send(`JOIN ${channel}`);
      await conn1.waitForJoin(channel);
      conn1.send(`TOPIC ${channel} :Resume test topic`);
      await conn1.waitForNumeric('332', 3000);

      // Send a message so the channel has history
      conn1.send(`PRIVMSG ${channel} :Before disconnect`);
      await new Promise(r => setTimeout(r, 300));

      // Disconnect
      disconnectAbruptly(conn1);
      await new Promise(r => setTimeout(r, 2000));

      // Reconnect — should auto-resume with channel membership AND receive state replay
      const { client: conn2 } = await reconnectBouncer(account, password);
      trackClient(conn2);

      // After held session resume, server should replay channel state:
      // JOIN, TOPIC (332+333), NAMES (353+366)
      const joinMsg = await conn2.waitForJoin(channel, undefined, 5000);
      expect(joinMsg.command).toBe('JOIN');

      const topicMsg = await conn2.waitForNumeric('332', 3000);
      expect(topicMsg.params).toContain(channel);

      const namesMsg = await conn2.waitForNumeric('353', 3000);
      expect(namesMsg.raw).toContain(channel);

      const endNames = await conn2.waitForNumeric('366', 3000);
      expect(endNames.params).toContain(channel);

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

  describe('Shadow Multi-Attach', () => {
    it('second SASL connection to active session attaches as shadow', async () => {
      const { account, password, fromPool } = await getTestAccount();
      if (fromPool) poolAccounts.push(account);

      // Primary: connect with hold
      const { client: primary } = await createBouncerClient(account, password);
      trackClient(primary);

      // Second connection: SASL to same account → should auto-attach as shadow
      const { client: shadow } = await createSaslBouncerClient(account, password, {
        nick: uniqueNick('shd'),
      });
      trackClient(shadow);

      // Shadow should receive welcome and get the session nick
      // The shadow's registered nick is overridden by the session identity
      await new Promise(r => setTimeout(r, 500));

      // BOUNCER INFO from primary should still show active
      const info = await assertBouncerActive(primary, 'primary with shadow');
      expect(info.state).toBe('active');

      // Cleanup
      shadow.send('QUIT');
      await bouncerDisableHold(primary);
      primary.send('QUIT');
    });

    it('shadow gets same nick as primary (shared identity)', async () => {
      const { account, password, fromPool } = await getTestAccount();
      if (fromPool) poolAccounts.push(account);

      const { client: primary, nick: nick1 } = await createBouncerClient(account, password);
      trackClient(primary);

      // Shadow connects with a DIFFERENT nick
      const shadowNick = uniqueNick('shd');
      const { client: shadow } = await createSaslBouncerClient(account, password, {
        nick: shadowNick,
      });
      trackClient(shadow);

      await new Promise(r => setTimeout(r, 500));

      // Shadow should be using the session nick, not its registration nick.
      // Verify by sending PRIVMSG to a channel — the message source should be nick1.
      const channel = uniqueChannel('shdnick');
      primary.send(`JOIN ${channel}`);
      await primary.waitForJoin(channel);

      // Observer watches the channel
      const observer = trackClient(await createRawSocketClient());
      await observer.capLs();
      observer.capEnd();
      observer.register(uniqueNick('obs'));
      await observer.waitForNumeric('001');
      observer.send(`JOIN ${channel}`);
      await observer.waitForJoin(channel);
      await new Promise(r => setTimeout(r, 300));

      observer.clearRawBuffer();

      // Shadow sends message — should appear from nick1 (the session identity)
      const testMsg = `identity-test-${Date.now()}`;
      shadow.send(`PRIVMSG ${channel} :${testMsg}`);

      const observed = await observer.waitForParsedLine(
        msg => msg.command === 'PRIVMSG' && msg.trailing?.includes(testMsg) === true,
        5000,
      );
      expect(
        observed.source?.nick?.toLowerCase(),
        'Message from shadow should appear from session nick',
      ).toBe(nick1.toLowerCase());

      // Cleanup
      shadow.send('QUIT');
      observer.send('QUIT');
      await bouncerDisableHold(primary);
      primary.send('QUIT');
    });
  });

  describe('Shadow Channel Traffic Duplication', () => {
    it('both primary and shadow receive channel messages', async () => {
      const { account, password, fromPool } = await getTestAccount();
      if (fromPool) poolAccounts.push(account);

      const { client: primary } = await createBouncerClient(account, password);
      trackClient(primary);

      const channel = uniqueChannel('shddup');
      primary.send(`JOIN ${channel}`);
      await primary.waitForJoin(channel);
      await new Promise(r => setTimeout(r, 300));

      // Shadow attaches to active session
      const { client: shadow } = await createSaslBouncerClient(account, password);
      trackClient(shadow);
      await new Promise(r => setTimeout(r, 500));

      // Observer sends a message to the channel
      const observer = trackClient(await createRawSocketClient());
      await observer.capLs();
      observer.capEnd();
      observer.register(uniqueNick('obs'));
      await observer.waitForNumeric('001');
      observer.send(`JOIN ${channel}`);
      await observer.waitForJoin(channel);
      await new Promise(r => setTimeout(r, 300));

      primary.clearRawBuffer();
      shadow.clearRawBuffer();

      const testMsg = `dup-test-${Date.now()}`;
      observer.send(`PRIVMSG ${channel} :${testMsg}`);

      // Primary should receive it
      const primaryMsg = await primary.waitForParsedLine(
        msg => msg.command === 'PRIVMSG' && msg.trailing?.includes(testMsg) === true,
        5000,
      );
      expect(primaryMsg.command, 'Primary should receive channel PRIVMSG').toBe('PRIVMSG');
      expect(primaryMsg.trailing).toContain(testMsg);

      // Shadow should also receive it (message duplication)
      const shadowMsg = await shadow.waitForParsedLine(
        msg => msg.command === 'PRIVMSG' && msg.trailing?.includes(testMsg) === true,
        5000,
      );
      expect(shadowMsg.command, 'Shadow should receive duplicated channel PRIVMSG').toBe('PRIVMSG');
      expect(shadowMsg.trailing).toContain(testMsg);

      // Cleanup
      shadow.send('QUIT');
      observer.send('QUIT');
      await bouncerDisableHold(primary);
      primary.send('QUIT');
    });

    it('shadow inherits channel membership from primary', async () => {
      const { account, password, fromPool } = await getTestAccount();
      if (fromPool) poolAccounts.push(account);

      const { client: primary } = await createBouncerClient(account, password);
      trackClient(primary);

      // Primary joins BEFORE shadow attaches
      const channel = uniqueChannel('shdinh');
      primary.send(`JOIN ${channel}`);
      await primary.waitForJoin(channel);

      primary.send(`PRIVMSG ${channel} :Primary was here`);
      await new Promise(r => setTimeout(r, 300));

      // Shadow attaches — should share channel membership
      const { client: shadow } = await createSaslBouncerClient(account, password);
      trackClient(shadow);
      await new Promise(r => setTimeout(r, 500));

      // Shadow should be able to send to the channel (inherited membership)
      shadow.clearRawBuffer();
      shadow.send(`PRIVMSG ${channel} :Shadow here too`);

      // If NOT in the channel, we'd get ERR_CANNOTSENDTOCHAN (404)
      let gotError = false;
      try {
        await shadow.waitForNumeric(['404', '442'], 2000);
        gotError = true;
      } catch {
        // Expected: no error means shadow has channel membership
      }
      expect(gotError, 'Shadow should inherit channel membership from primary').toBe(false);

      // Cleanup
      shadow.send('QUIT');
      await bouncerDisableHold(primary);
      primary.send('QUIT');
    });

    it('shadow receives channel state replay (JOIN, TOPIC, NAMES) on attachment', async () => {
      const { account, password, fromPool } = await getTestAccount();
      if (fromPool) poolAccounts.push(account);

      const { client: primary } = await createBouncerClient(account, password);
      trackClient(primary);

      // Primary joins a channel and sets a topic
      const channel = uniqueChannel('shreplay');
      primary.send(`JOIN ${channel}`);
      await primary.waitForJoin(channel);
      primary.send(`TOPIC ${channel} :Shadow replay test topic`);
      await primary.waitForNumeric('332', 3000);
      await new Promise(r => setTimeout(r, 300));

      // Shadow attaches — should receive channel state replay
      const { client: shadow } = await createSaslBouncerClient(account, password);
      trackClient(shadow);

      // Wait for the full welcome + channel state to arrive
      // The shadow should receive: JOIN, 332 (TOPIC), 333 (TOPICWHOTIME), 353 (NAMES), 366 (ENDOFNAMES)
      const joinMsg = await shadow.waitForJoin(channel, undefined, 5000);
      expect(joinMsg.command).toBe('JOIN');
      expect(joinMsg.params[0].toLowerCase()).toBe(channel.toLowerCase());

      // Verify TOPIC (332)
      const topicMsg = await shadow.waitForNumeric('332', 3000);
      expect(topicMsg.params).toContain(channel);
      expect(topicMsg.trailing || topicMsg.params[topicMsg.params.length - 1]).toContain('Shadow replay test topic');

      // Verify NAMES (353 + 366)
      const namesMsg = await shadow.waitForNumeric('353', 3000);
      expect(namesMsg.raw).toContain(channel);
      const endNames = await shadow.waitForNumeric('366', 3000);
      expect(endNames.params).toContain(channel);

      // Cleanup
      shadow.send('QUIT');
      await bouncerDisableHold(primary);
      primary.send('QUIT');
    });
  });

  describe('Shadow Command Forwarding', () => {
    it('shadow PRIVMSG appears from session nick', async () => {
      const { account, password, fromPool } = await getTestAccount();
      if (fromPool) poolAccounts.push(account);

      const { client: primary, nick: nick1 } = await createBouncerClient(account, password);
      trackClient(primary);

      const channel = uniqueChannel('shdfwd');
      primary.send(`JOIN ${channel}`);
      await primary.waitForJoin(channel);
      await new Promise(r => setTimeout(r, 300));

      // Shadow attaches
      const { client: shadow } = await createSaslBouncerClient(account, password);
      trackClient(shadow);
      await new Promise(r => setTimeout(r, 500));

      // Observer watches channel
      const observer = trackClient(await createRawSocketClient());
      await observer.capLs();
      observer.capEnd();
      observer.register(uniqueNick('obs'));
      await observer.waitForNumeric('001');
      observer.send(`JOIN ${channel}`);
      await observer.waitForJoin(channel);
      await new Promise(r => setTimeout(r, 300));

      observer.clearRawBuffer();

      // Shadow sends a message — should be forwarded through primary
      const testMsg = `fwd-test-${Date.now()}`;
      shadow.send(`PRIVMSG ${channel} :${testMsg}`);

      const observed = await observer.waitForParsedLine(
        msg => msg.command === 'PRIVMSG' && msg.trailing?.includes(testMsg) === true,
        5000,
      );
      expect(observed.source?.nick?.toLowerCase()).toBe(nick1.toLowerCase());

      // Cleanup
      shadow.send('QUIT');
      observer.send('QUIT');
      await bouncerDisableHold(primary);
      primary.send('QUIT');
    });

    it('shadow reply routing sends responses to originating shadow', async () => {
      const { account, password, fromPool } = await getTestAccount();
      if (fromPool) poolAccounts.push(account);

      const { client: primary } = await createBouncerClient(account, password);
      trackClient(primary);
      await new Promise(r => setTimeout(r, 300));

      // Shadow attaches
      const { client: shadow } = await createSaslBouncerClient(account, password);
      trackClient(shadow);
      await new Promise(r => setTimeout(r, 500));

      // Shadow issues a WHO command — reply should go to shadow, not primary
      primary.clearRawBuffer();
      shadow.clearRawBuffer();

      shadow.send('WHO shadow-reply-test-nonexistent');

      // Shadow should get the RPL_ENDOFWHO (315)
      const shadowReply = await shadow.waitForParsedLine(
        msg => msg.command === '315',
        5000,
      );
      expect(shadowReply.command, 'Shadow should receive RPL_ENDOFWHO for its own WHO query').toBe('315');

      // Primary should NOT receive the WHO reply (it didn't request it)
      let primaryGotReply = false;
      try {
        await primary.waitForParsedLine(
          msg => msg.command === '315' && msg.raw.includes('shadow-reply-test-nonexistent'),
          2000,
        );
        primaryGotReply = true;
      } catch {
        // Expected: timeout means primary didn't get the reply
      }
      expect(primaryGotReply, 'WHO reply should NOT go to primary (reply routing)').toBe(false);

      // Cleanup
      shadow.send('QUIT');
      await bouncerDisableHold(primary);
      primary.send('QUIT');
    });
  });

  describe('Primary Promotion on Disconnect', () => {
    it('shadow is promoted to primary when primary disconnects', async () => {
      const { account, password, fromPool } = await getTestAccount();
      if (fromPool) poolAccounts.push(account);

      const { client: primary } = await createBouncerClient(account, password);
      trackClient(primary);

      const channel = uniqueChannel('promo');
      primary.send(`JOIN ${channel}`);
      await primary.waitForJoin(channel);
      await new Promise(r => setTimeout(r, 300));

      // Shadow attaches
      const { client: shadow } = await createSaslBouncerClient(account, password);
      trackClient(shadow);
      await new Promise(r => setTimeout(r, 500));

      // Observer to verify no QUIT happens
      const observer = trackClient(await createRawSocketClient());
      await observer.capLs();
      await observer.capReq(['away-notify']);
      observer.capEnd();
      observer.register(uniqueNick('obs'));
      await observer.waitForNumeric('001');
      observer.send(`JOIN ${channel}`);
      await observer.waitForJoin(channel);
      await new Promise(r => setTimeout(r, 300));

      observer.clearRawBuffer();

      // Primary disconnects abruptly — shadow should be promoted
      disconnectAbruptly(primary);
      await new Promise(r => setTimeout(r, 2000));

      // Observer should NOT see a QUIT (shadow was promoted, session stays ACTIVE)
      let gotQuit = false;
      try {
        await observer.waitForParsedLine(
          msg => msg.command === 'QUIT',
          2000,
        );
        gotQuit = true;
      } catch {
        // Expected: no QUIT because shadow was promoted
      }
      expect(gotQuit, 'No QUIT should occur when shadow is promoted to primary').toBe(false);

      // Shadow (now promoted primary) should still be able to send to channel
      shadow.clearRawBuffer();
      observer.clearRawBuffer();

      const testMsg = `promoted-${Date.now()}`;
      shadow.send(`PRIVMSG ${channel} :${testMsg}`);

      const observed = await observer.waitForParsedLine(
        msg => msg.command === 'PRIVMSG' && msg.trailing?.includes(testMsg) === true,
        5000,
      );
      expect(observed.command, 'Promoted shadow should still send to channel').toBe('PRIVMSG');
      expect(observed.trailing).toContain(testMsg);

      // Session should still be active
      const info = await bouncerInfo(shadow);
      expect(info, 'Promoted shadow should have bouncer info').not.toBeNull();
      expect(info!.state).toBe('active');

      // Cleanup
      await bouncerDisableHold(shadow);
      shadow.send('QUIT');
      observer.send('QUIT');
    });

    it('session enters HOLDING when last connection (promoted shadow) disconnects', async () => {
      const { account, password, fromPool } = await getTestAccount();
      if (fromPool) poolAccounts.push(account);

      const { client: primary } = await createBouncerClient(account, password);
      trackClient(primary);

      const channel = uniqueChannel('lastdc');
      primary.send(`JOIN ${channel}`);
      await primary.waitForJoin(channel);
      await new Promise(r => setTimeout(r, 300));

      // Shadow attaches
      const { client: shadow } = await createSaslBouncerClient(account, password);
      trackClient(shadow);
      await new Promise(r => setTimeout(r, 500));

      // Primary disconnects → shadow promoted
      disconnectAbruptly(primary);
      await new Promise(r => setTimeout(r, 2000));

      // Now shadow (promoted) disconnects → should enter HOLDING
      disconnectAbruptly(shadow);
      await new Promise(r => setTimeout(r, 2000));

      // Reconnect to verify session was held
      const { client: conn3 } = await reconnectBouncer(account, password);
      trackClient(conn3);

      const info = await bouncerInfo(conn3);
      expect(info, 'Session should be resumable after all connections dropped').not.toBeNull();
      expect(info!.state).toBe('active');

      // Verify channel membership persisted
      conn3.clearRawBuffer();
      conn3.send(`PRIVMSG ${channel} :After full reconnect`);
      let gotError = false;
      try {
        await conn3.waitForNumeric(['404', '442'], 2000);
        gotError = true;
      } catch {
        // Expected: no error means channel was preserved
      }
      expect(gotError, 'Channel should be preserved through shadow promotion + hold').toBe(false);

      // Cleanup
      await bouncerDisableHold(conn3);
      conn3.send('QUIT');
    });
  });

  describe('BOUNCER LISTCLIENTS', () => {
    it('lists primary connection', async () => {
      const { account, password, fromPool } = await getTestAccount();
      if (fromPool) poolAccounts.push(account);

      const { client: primary } = await createBouncerClient(account, password);
      trackClient(primary);

      primary.clearRawBuffer();
      primary.send('BOUNCER LISTCLIENTS');

      // Collect responses until end marker
      const lines: string[] = [];
      const collectTimeout = 5000;
      const start = Date.now();
      while (Date.now() - start < collectTimeout) {
        try {
          const msg = await primary.waitForParsedLine(
            m => m.command === 'NOTE' || m.raw.includes('BOUNCER') || m.raw.includes('end of'),
            2000,
          );
          lines.push(msg.raw);
          // Check for end-of-list marker
          if (msg.raw.toLowerCase().includes('end of') || msg.raw.includes('LISTCLIENTS_END')) {
            break;
          }
        } catch {
          break;
        }
      }

      // Should have at least one connection listed (the primary)
      const hasClient = lines.some(l => l.includes('id=') || l.includes('primary'));
      expect(hasClient, 'LISTCLIENTS should show at least the primary connection').toBe(true);

      // Cleanup
      await bouncerDisableHold(primary);
      primary.send('QUIT');
    });

    it('lists both primary and shadow connections', async () => {
      const { account, password, fromPool } = await getTestAccount();
      if (fromPool) poolAccounts.push(account);

      const { client: primary } = await createBouncerClient(account, password);
      trackClient(primary);
      await new Promise(r => setTimeout(r, 300));

      // Shadow attaches
      const { client: shadow } = await createSaslBouncerClient(account, password);
      trackClient(shadow);
      await new Promise(r => setTimeout(r, 500));

      primary.clearRawBuffer();
      primary.send('BOUNCER LISTCLIENTS');

      // Collect responses
      const lines: string[] = [];
      const start = Date.now();
      while (Date.now() - start < 5000) {
        try {
          const msg = await primary.waitForParsedLine(
            m => m.command === 'NOTE' || m.raw.includes('BOUNCER') || m.raw.includes('end of'),
            2000,
          );
          lines.push(msg.raw);
          if (msg.raw.toLowerCase().includes('end of') || msg.raw.includes('LISTCLIENTS_END')) {
            break;
          }
        } catch {
          break;
        }
      }

      // Should list at least 2 connections
      const clientLines = lines.filter(l => l.includes('id='));
      expect(
        clientLines.length,
        'LISTCLIENTS should show primary + shadow',
      ).toBeGreaterThanOrEqual(2);

      // Should show both primary and shadow types
      const hasPrimary = clientLines.some(l => l.includes('primary'));
      const hasShadow = clientLines.some(l => l.includes('shadow'));
      expect(hasPrimary, 'LISTCLIENTS should show a primary connection').toBe(true);
      expect(hasShadow, 'LISTCLIENTS should show a shadow connection').toBe(true);

      // Cleanup
      shadow.send('QUIT');
      await bouncerDisableHold(primary);
      primary.send('QUIT');
    });
  });

  describe('BOUNCER INFO Connection Count', () => {
    it('BOUNCER INFO shows connection count with shadows', async () => {
      const { account, password, fromPool } = await getTestAccount();
      if (fromPool) poolAccounts.push(account);

      const { client: primary } = await createBouncerClient(account, password);
      trackClient(primary);

      // Check info with just primary
      const info1 = await assertBouncerActive(primary, 'primary only');
      console.log('INFO with primary only:', info1.raw);

      // Attach shadow
      const { client: shadow } = await createSaslBouncerClient(account, password);
      trackClient(shadow);
      await new Promise(r => setTimeout(r, 500));

      // Check info with primary + shadow
      const info2 = await assertBouncerActive(primary, 'primary + shadow');
      console.log('INFO with shadow:', info2.raw);

      // The raw response should contain connections=2 (or similar)
      const connectionsMatch = info2.raw.match(/connections=(\d+)/);
      if (connectionsMatch) {
        expect(parseInt(connectionsMatch[1], 10)).toBeGreaterThanOrEqual(2);
      }

      // Cleanup
      shadow.send('QUIT');
      await bouncerDisableHold(primary);
      primary.send('QUIT');
    });
  });
});
