import { describe, it, expect, afterEach } from 'vitest';
import {
  RawSocketClient,
  uniqueNick,
  getTestAccount,
  releaseTestAccount,
  createSaslBouncerClient,
  bouncerEnableHold,
  bouncerDisableHold,
  createRawSocketClient,
  uniqueChannel,
} from '../helpers/index.js';

/**
 * User-visible behavior of bouncer-managed clients from an observer's POV.
 *
 * Tests that bouncer-attach doesn't break basic IRC operations for OTHER
 * clients interacting with the bouncer user.  Specifically:
 *
 *   - /WHOIS resolves cleanly
 *   - Channel join/part visible normally
 *   - PRIVMSG round-trips
 *
 * These are integration smoke tests — if bouncer state corrupts client
 * representation (cli_name desync, hash miss, etc.), these will fail
 * with obvious symptoms (no-such-nick, missing JOIN events, etc.).
 */
describe('Bouncer client visible to other users', () => {
  const clients: RawSocketClient[] = [];
  const poolAccounts: string[] = [];

  afterEach(async () => {
    for (const client of clients) {
      try { await bouncerDisableHold(client); } catch { /* ignore */ }
      try { client.close(); } catch { /* ignore */ }
    }
    clients.length = 0;
    for (const account of poolAccounts) {
      releaseTestAccount(account);
    }
    poolAccounts.length = 0;
  });

  it('/WHOIS on bouncer-managed user returns RPL_WHOISUSER (311)', async () => {
    const account = await getTestAccount();
    poolAccounts.push(account.account);
    const target = uniqueNick('whb');

    const { client: bouncer } = await createSaslBouncerClient(
      account.account, account.password, { nick: target },
    );
    clients.push(bouncer);
    expect(await bouncerEnableHold(bouncer)).toBe(true);

    // Observer (plain client, no SASL).
    const observer = await createRawSocketClient();
    clients.push(observer);
    await observer.capLs();
    observer.capEnd();
    observer.register(uniqueNick('obs'));
    await observer.waitForNumeric('001');

    observer.clearRawBuffer();
    observer.send(`WHOIS ${target}`);
    // RPL_WHOISUSER = 311, RPL_ENDOFWHOIS = 318.
    const userLine = await observer.waitForLine(/\s311\s/, 5000);
    expect(userLine).toContain(target);
    await observer.waitForLine(/\s318\s/, 3000);
  });

  it('channel JOIN by bouncer user is visible to other channel members', async () => {
    const account = await getTestAccount();
    poolAccounts.push(account.account);
    const target = uniqueNick('chj');
    const channel = uniqueChannel('chj');

    const { client: bouncer } = await createSaslBouncerClient(
      account.account, account.password, { nick: target },
    );
    clients.push(bouncer);
    expect(await bouncerEnableHold(bouncer)).toBe(true);

    // Observer joins channel first.
    const observer = await createRawSocketClient();
    clients.push(observer);
    await observer.capLs();
    observer.capEnd();
    observer.register(uniqueNick('obs'));
    await observer.waitForNumeric('001');
    observer.send(`JOIN ${channel}`);
    await observer.waitForJoin(channel);

    // Bouncer joins.
    observer.clearRawBuffer();
    bouncer.send(`JOIN ${channel}`);

    // Observer should see :target!user@host JOIN #channel.
    const joinLine = await observer.waitForLine(
      new RegExp(`:${target}![^ ]+ JOIN ${channel.replace('#', '\\#')}`),
      5000,
    );
    expect(joinLine).toContain('JOIN');
    expect(joinLine).toContain(target);
  });
});
