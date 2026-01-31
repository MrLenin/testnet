import { describe, it, expect, afterEach } from 'vitest';
import {
  createRawSocketClient,
  RawSocketClient,
  uniqueChannel,
  uniqueId,
  getTestAccount,
  releaseTestAccount,
  authenticateSaslPlain,
  bouncerEnableHold,
  bouncerDisableHold,
} from '../helpers/index.js';

/**
 * Shadow CAP Tag Filtering Tests
 *
 * Tests that outbound messages duplicated to shadow connections have
 * IRCv3 tags filtered according to each shadow's negotiated CAP set.
 *
 * Architecture:
 * - Primary connection negotiates certain caps (e.g., server-time)
 * - Shadow connection (second SASL login to same account) negotiates different caps
 * - Channel messages sent to the primary are duplicated to all shadows
 * - Each shadow should only receive tags matching its own CAP state
 *
 * This validates Phase I of the multi-client bouncer shadow architecture:
 * per-shadow tag filtering via mb_cache passthrough (channel sends) and
 * exact per-tag filtering fallback (non-channel sends).
 */
describe('Shadow CAP Tag Filtering', () => {
  const clients: RawSocketClient[] = [];
  const poolAccounts: string[] = [];

  const trackClient = (client: RawSocketClient): RawSocketClient => {
    clients.push(client);
    return client;
  };

  afterEach(async () => {
    for (const client of clients) {
      try { client.close(); } catch { /* ignore */ }
    }
    clients.length = 0;
    for (const account of poolAccounts) {
      releaseTestAccount(account);
    }
    poolAccounts.length = 0;
  });

  /**
   * Helper: create a SASL-authenticated connection with specific caps.
   * If enableHold is true, enables bouncer hold (creates session).
   * The second SASL connection to the same account auto-attaches as shadow.
   */
  async function createSaslConnection(
    account: string,
    password: string,
    options: { nick?: string; extraCaps?: string[]; enableHold?: boolean; clearBuffer?: boolean } = {},
  ): Promise<{ client: RawSocketClient; nick: string }> {
    const { nick, extraCaps = [], enableHold = false, clearBuffer = true } = options;
    const client = await createRawSocketClient();
    await client.capLs();
    await client.capReq(['sasl', ...extraCaps]);

    const result = await authenticateSaslPlain(client, account, password);
    if (!result.success) {
      throw new Error(`SASL auth failed for ${account}: ${result.error}`);
    }

    client.capEnd();
    const actualNick = nick || `sf${uniqueId().slice(0, 6)}`;
    client.register(actualNick);
    await client.waitForNumeric('001');
    await new Promise(r => setTimeout(r, 500));

    if (enableHold) {
      await bouncerEnableHold(client);
    }

    if (clearBuffer) {
      client.clearRawBuffer();
    }
    return { client, nick: actualNick };
  }

  /**
   * Helper: create a plain observer client (no SASL, separate identity).
   */
  async function createObserver(caps: string[] = []): Promise<{ client: RawSocketClient; nick: string }> {
    const client = await createRawSocketClient();
    await client.capLs();
    if (caps.length > 0) {
      await client.capReq(caps);
    }
    client.capEnd();
    const nick = `obs${uniqueId().slice(0, 5)}`;
    client.register(nick);
    await client.waitForNumeric('001');
    await new Promise(r => setTimeout(r, 300));
    client.clearRawBuffer();
    return { client, nick };
  }

  describe('Channel message tag filtering', () => {
    it('shadow without server-time does not receive @time tags', async () => {
      const { account, password, fromPool } = await getTestAccount();
      if (fromPool) poolAccounts.push(account);

      // Primary: WITH server-time cap
      const { client: primary } = await createSaslConnection(account, password, {
        extraCaps: ['server-time'],
        enableHold: true,
      });
      trackClient(primary);

      // Primary joins channel
      const channel = uniqueChannel('shdtime');
      primary.send(`JOIN ${channel}`);
      await primary.waitForJoin(channel);
      await new Promise(r => setTimeout(r, 300));

      // Shadow: WITHOUT server-time cap (only sasl)
      const { client: shadow } = await createSaslConnection(account, password, {
        extraCaps: [],
      });
      trackClient(shadow);
      await new Promise(r => setTimeout(r, 500));

      // Observer: joins channel and sends message
      const { client: observer, nick: obsNick } = await createObserver();
      trackClient(observer);
      observer.send(`JOIN ${channel}`);
      await observer.waitForJoin(channel);
      await new Promise(r => setTimeout(r, 300));

      // Clear buffers before test message
      primary.clearRawBuffer();
      shadow.clearRawBuffer();

      // Observer sends message to channel
      const testMsg = `timetest-${uniqueId()}`;
      observer.send(`PRIVMSG ${channel} :${testMsg}`);

      // Primary should receive with @time tag
      const primaryMsg = await primary.waitForParsedLine(
        msg => msg.command === 'PRIVMSG' && msg.trailing?.includes(testMsg),
        5000,
      );
      expect(primaryMsg.tags).toHaveProperty('time');

      // Shadow should receive WITHOUT @time tag
      const shadowMsg = await shadow.waitForParsedLine(
        msg => msg.command === 'PRIVMSG' && msg.trailing?.includes(testMsg),
        5000,
      );
      expect(shadowMsg.tags).not.toHaveProperty('time');

      // Cleanup
      await bouncerDisableHold(primary);
      primary.send('QUIT');
      observer.send('QUIT');
    });

    it('shadow without account-tag does not receive @account tags', async () => {
      const { account, password, fromPool } = await getTestAccount();
      if (fromPool) poolAccounts.push(account);

      // Primary: WITH account-tag cap
      const { client: primary } = await createSaslConnection(account, password, {
        extraCaps: ['account-tag', 'server-time'],
        enableHold: true,
      });
      trackClient(primary);

      // Primary joins channel
      const channel = uniqueChannel('shdacct');
      primary.send(`JOIN ${channel}`);
      await primary.waitForJoin(channel);
      await new Promise(r => setTimeout(r, 300));

      // Shadow: WITH server-time but WITHOUT account-tag
      const { client: shadow } = await createSaslConnection(account, password, {
        extraCaps: ['server-time'],
      });
      trackClient(shadow);
      await new Promise(r => setTimeout(r, 500));

      // Observer: authenticated so messages carry account tag
      const obsAccount = await getTestAccount();
      if (obsAccount.fromPool) poolAccounts.push(obsAccount.account);
      const { client: observer } = await createSaslConnection(
        obsAccount.account, obsAccount.password,
        { extraCaps: ['server-time', 'account-tag'] },
      );
      trackClient(observer);
      observer.send(`JOIN ${channel}`);
      await observer.waitForJoin(channel);
      await new Promise(r => setTimeout(r, 300));

      // Clear buffers
      primary.clearRawBuffer();
      shadow.clearRawBuffer();

      // Observer sends message
      const testMsg = `accttest-${uniqueId()}`;
      observer.send(`PRIVMSG ${channel} :${testMsg}`);

      // Primary should receive with both @time and @account tags
      const primaryMsg = await primary.waitForParsedLine(
        msg => msg.command === 'PRIVMSG' && msg.trailing?.includes(testMsg),
        5000,
      );
      expect(primaryMsg.tags).toHaveProperty('time');
      expect(primaryMsg.tags).toHaveProperty('account');

      // Shadow should receive @time but NOT @account
      const shadowMsg = await shadow.waitForParsedLine(
        msg => msg.command === 'PRIVMSG' && msg.trailing?.includes(testMsg),
        5000,
      );
      expect(shadowMsg.tags).toHaveProperty('time');
      expect(shadowMsg.tags).not.toHaveProperty('account');

      // Cleanup
      await bouncerDisableHold(primary);
      primary.send('QUIT');
      observer.send('QUIT');
    });

    it('shadow with same caps as primary receives identical tags', async () => {
      const { account, password, fromPool } = await getTestAccount();
      if (fromPool) poolAccounts.push(account);

      // Primary: with server-time
      const { client: primary } = await createSaslConnection(account, password, {
        extraCaps: ['server-time'],
        enableHold: true,
      });
      trackClient(primary);

      // Primary joins channel
      const channel = uniqueChannel('shdsame');
      primary.send(`JOIN ${channel}`);
      await primary.waitForJoin(channel);
      await new Promise(r => setTimeout(r, 300));

      // Shadow: ALSO with server-time (same caps)
      const { client: shadow } = await createSaslConnection(account, password, {
        extraCaps: ['server-time'],
      });
      trackClient(shadow);
      await new Promise(r => setTimeout(r, 500));

      // Observer
      const { client: observer } = await createObserver();
      trackClient(observer);
      observer.send(`JOIN ${channel}`);
      await observer.waitForJoin(channel);
      await new Promise(r => setTimeout(r, 300));

      // Clear buffers
      primary.clearRawBuffer();
      shadow.clearRawBuffer();

      // Observer sends message
      const testMsg = `sametest-${uniqueId()}`;
      observer.send(`PRIVMSG ${channel} :${testMsg}`);

      // Primary should receive with @time tag
      const primaryMsg = await primary.waitForParsedLine(
        msg => msg.command === 'PRIVMSG' && msg.trailing?.includes(testMsg),
        5000,
      );
      expect(primaryMsg.tags).toHaveProperty('time');

      // Shadow should ALSO receive @time tag (same caps as primary)
      const shadowMsg = await shadow.waitForParsedLine(
        msg => msg.command === 'PRIVMSG' && msg.trailing?.includes(testMsg),
        5000,
      );
      expect(shadowMsg.tags).toHaveProperty('time');

      // Cleanup
      await bouncerDisableHold(primary);
      primary.send('QUIT');
      observer.send('QUIT');
    });

    it('shadow with no tag caps receives messages without any tags', async () => {
      const { account, password, fromPool } = await getTestAccount();
      if (fromPool) poolAccounts.push(account);

      // Primary: with server-time and account-tag
      const { client: primary } = await createSaslConnection(account, password, {
        extraCaps: ['server-time', 'account-tag'],
        enableHold: true,
      });
      trackClient(primary);

      // Primary joins channel
      const channel = uniqueChannel('shdnotag');
      primary.send(`JOIN ${channel}`);
      await primary.waitForJoin(channel);
      await new Promise(r => setTimeout(r, 300));

      // Shadow: NO tag-related caps at all (only sasl)
      const { client: shadow } = await createSaslConnection(account, password, {
        extraCaps: [],
      });
      trackClient(shadow);
      await new Promise(r => setTimeout(r, 500));

      // Observer
      const { client: observer } = await createObserver();
      trackClient(observer);
      observer.send(`JOIN ${channel}`);
      await observer.waitForJoin(channel);
      await new Promise(r => setTimeout(r, 300));

      // Clear buffers
      primary.clearRawBuffer();
      shadow.clearRawBuffer();

      // Observer sends message
      const testMsg = `notagtest-${uniqueId()}`;
      observer.send(`PRIVMSG ${channel} :${testMsg}`);

      // Primary should receive with tags
      const primaryMsg = await primary.waitForParsedLine(
        msg => msg.command === 'PRIVMSG' && msg.trailing?.includes(testMsg),
        5000,
      );
      expect(primaryMsg.tags).toHaveProperty('time');

      // Shadow should receive with NO tags at all
      const shadowMsg = await shadow.waitForParsedLine(
        msg => msg.command === 'PRIVMSG' && msg.trailing?.includes(testMsg),
        5000,
      );
      // No tag-related caps means no tags should be present
      expect(Object.keys(shadowMsg.tags).length).toBe(0);

      // Cleanup
      await bouncerDisableHold(primary);
      primary.send('QUIT');
      observer.send('QUIT');
    });

    it('shadow with more caps than primary receives additional tags', async () => {
      const { account, password, fromPool } = await getTestAccount();
      if (fromPool) poolAccounts.push(account);

      // Primary: WITHOUT server-time
      const { client: primary } = await createSaslConnection(account, password, {
        extraCaps: [],
        enableHold: true,
      });
      trackClient(primary);

      // Primary joins channel
      const channel = uniqueChannel('shdmore');
      primary.send(`JOIN ${channel}`);
      await primary.waitForJoin(channel);
      await new Promise(r => setTimeout(r, 300));

      // Shadow: WITH server-time (more caps than primary)
      const { client: shadow } = await createSaslConnection(account, password, {
        extraCaps: ['server-time'],
      });
      trackClient(shadow);
      await new Promise(r => setTimeout(r, 500));

      // Observer
      const { client: observer } = await createObserver();
      trackClient(observer);
      observer.send(`JOIN ${channel}`);
      await observer.waitForJoin(channel);
      await new Promise(r => setTimeout(r, 300));

      // Clear buffers
      primary.clearRawBuffer();
      shadow.clearRawBuffer();

      // Observer sends message
      const testMsg = `moretest-${uniqueId()}`;
      observer.send(`PRIVMSG ${channel} :${testMsg}`);

      // Primary should receive WITHOUT @time tag
      const primaryMsg = await primary.waitForParsedLine(
        msg => msg.command === 'PRIVMSG' && msg.trailing?.includes(testMsg),
        5000,
      );
      expect(primaryMsg.tags).not.toHaveProperty('time');

      // Shadow SHOULD receive @time tag (it has the cap)
      const shadowMsg = await shadow.waitForParsedLine(
        msg => msg.command === 'PRIVMSG' && msg.trailing?.includes(testMsg),
        5000,
      );
      expect(shadowMsg.tags).toHaveProperty('time');

      // Cleanup
      await bouncerDisableHold(primary);
      primary.send('QUIT');
      observer.send('QUIT');
    });
  });

  describe('Content format filtering (CapRecipientHas)', () => {
    it('shadow with extended-join receives extended JOIN format, primary without does not', async () => {
      const { account, password, fromPool } = await getTestAccount();
      if (fromPool) poolAccounts.push(account);

      // Primary: WITHOUT extended-join
      const { client: primary } = await createSaslConnection(account, password, {
        extraCaps: ['server-time'],
        enableHold: true,
      });
      trackClient(primary);

      // Primary joins channel
      const channel = uniqueChannel('shdext');
      primary.send(`JOIN ${channel}`);
      await primary.waitForJoin(channel);
      await new Promise(r => setTimeout(r, 300));

      // Shadow: WITH extended-join
      const { client: shadow } = await createSaslConnection(account, password, {
        extraCaps: ['server-time', 'extended-join'],
      });
      trackClient(shadow);
      await new Promise(r => setTimeout(r, 500));

      // Observer joins — both primary and shadow should see the JOIN
      const { client: observer, nick: obsNick } = await createObserver();
      trackClient(observer);

      primary.clearRawBuffer();
      shadow.clearRawBuffer();

      observer.send(`JOIN ${channel}`);
      await observer.waitForJoin(channel);

      // Primary should get standard JOIN (no account/realname)
      const primaryJoin = await primary.waitForParsedLine(
        msg => msg.command === 'JOIN' && msg.source?.nick === obsNick,
        5000,
      );
      // Standard JOIN: params[0] is the channel, no account/realname fields
      expect(primaryJoin.params.length).toBe(1);

      // Shadow should get extended JOIN (with account and realname)
      const shadowJoin = await shadow.waitForParsedLine(
        msg => msg.command === 'JOIN' && msg.source?.nick === obsNick,
        5000,
      );
      // Extended JOIN: params[0] is channel, params[1] is account (or "*"), trailing is realname
      expect(shadowJoin.params.length).toBeGreaterThanOrEqual(2);

      // Cleanup
      await bouncerDisableHold(primary);
      primary.send('QUIT');
      observer.send('QUIT');
    });

    it('shadow receives channel state replay with correct format per its own caps', async () => {
      const { account, password, fromPool } = await getTestAccount();
      if (fromPool) poolAccounts.push(account);

      // Primary: minimal caps
      const { client: primary } = await createSaslConnection(account, password, {
        extraCaps: [],
        enableHold: true,
      });
      trackClient(primary);

      // Primary joins channel and sets topic
      const channel = uniqueChannel('shdrepl');
      primary.send(`JOIN ${channel}`);
      await primary.waitForJoin(channel);
      primary.send(`TOPIC ${channel} :Cap filtering replay test`);
      await primary.waitForCommand('TOPIC', 3000);
      await new Promise(r => setTimeout(r, 300));

      // Shadow: WITH extended-join — should get extended JOIN in channel state replay
      // Don't clear buffer — shadow needs to see channel state replay messages
      const { client: shadow } = await createSaslConnection(account, password, {
        extraCaps: ['extended-join'],
        clearBuffer: false,
      });
      trackClient(shadow);

      // Shadow should receive channel state replay with extended JOIN format
      const joinMsg = await shadow.waitForJoin(channel, undefined, 5000);
      // Extended JOIN: has account and realname params
      expect(joinMsg.params.length).toBeGreaterThanOrEqual(2);

      // Shadow should receive TOPIC
      const topicMsg = await shadow.waitForNumeric('332', 3000);
      expect(topicMsg.raw).toContain('Cap filtering replay test');

      // Shadow should receive NAMES
      await shadow.waitForNumeric('353', 3000);
      await shadow.waitForNumeric('366', 3000);

      // Cleanup
      await bouncerDisableHold(primary);
      primary.send('QUIT');
    });
  });

  describe('Multiple messages and consistency', () => {
    it('tag filtering is consistent across multiple messages', async () => {
      const { account, password, fromPool } = await getTestAccount();
      if (fromPool) poolAccounts.push(account);

      // Primary: with server-time
      const { client: primary } = await createSaslConnection(account, password, {
        extraCaps: ['server-time'],
        enableHold: true,
      });
      trackClient(primary);

      // Primary joins channel
      const channel = uniqueChannel('shdmulti');
      primary.send(`JOIN ${channel}`);
      await primary.waitForJoin(channel);
      await new Promise(r => setTimeout(r, 300));

      // Shadow: without server-time
      const { client: shadow } = await createSaslConnection(account, password, {
        extraCaps: [],
      });
      trackClient(shadow);
      await new Promise(r => setTimeout(r, 500));

      // Observer
      const { client: observer } = await createObserver();
      trackClient(observer);
      observer.send(`JOIN ${channel}`);
      await observer.waitForJoin(channel);
      await new Promise(r => setTimeout(r, 300));

      // Send 3 messages and verify filtering is consistent
      for (let i = 0; i < 3; i++) {
        primary.clearRawBuffer();
        shadow.clearRawBuffer();

        const testMsg = `multi-${i}-${uniqueId()}`;
        observer.send(`PRIVMSG ${channel} :${testMsg}`);

        const primaryMsg = await primary.waitForParsedLine(
          msg => msg.command === 'PRIVMSG' && msg.trailing?.includes(testMsg),
          5000,
        );
        expect(primaryMsg.tags).toHaveProperty('time');

        const shadowMsg = await shadow.waitForParsedLine(
          msg => msg.command === 'PRIVMSG' && msg.trailing?.includes(testMsg),
          5000,
        );
        expect(shadowMsg.tags).not.toHaveProperty('time');

        // Small delay between messages
        await new Promise(r => setTimeout(r, 200));
      }

      // Cleanup
      await bouncerDisableHold(primary);
      primary.send('QUIT');
      observer.send('QUIT');
    });
  });
});
