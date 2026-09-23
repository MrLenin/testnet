/**
 * Account deauth on the server that owns the session.
 *
 * B-1: a LOCAL bouncer alias must lose its account when the account is
 * deauthed.  bounce_emit_alias_update()'s local-apply pass handled seven
 * of the nine BX U fields; `account` was not one of them.  The S2S
 * broadcast skips the primary's own server for loop prevention, so an
 * alias sharing a server with its primary was the one case nothing
 * cleared -- it kept FLAG_ACCOUNT and the account string indefinitely.
 * Remote aliases were always fine, which is why a single-server bed never
 * showed it.  A second defect hid behind the first: the deauth body
 * destroyed the sessions before telling the aliases, and the emit walks
 * the session roster, so it found nothing to tell.
 *
 * B-6: a held session's ghost is an IsUser client carrying the account.
 * Deauthing the account must take the session AND the ghost with it;
 * destroying the record alone leaves a ghost with no timer and no
 * session -- it holds the nick forever.
 *
 * Aliases share the primary's nick, WHOIS by nick answers for the primary,
 * and an alias's JOIN is applied to the primary, so neither can see an
 * alias's own state.  Oper CHECK on a channel can: it lists every member,
 * aliases marked "~", each with its own account as the last field.
 *
 * Driven through the Keycloak webhook's account-disable branch, which is
 * reachable with a synthetic payload carrying a root-level `username`,
 * posted to the ircd container with the ircd's own secret.  A disable only
 * deauths (WEBHOOK_KILL_ON_DISABLE is off by default), which is what leaves
 * the connections around to be inspected.
 */
import { describe, it, expect, afterEach } from 'vitest';
import {
  RawSocketClient,
  uniqueNick,
  getTestAccount,
  releaseTestAccount,
  createSaslBouncerClient,
  bouncerEnableHold,
  bouncerDisableHold,
} from '../helpers/index.js';
import { createOperClient } from '../helpers/x3-client';
import { postWebhook, accountDisabledEvent, checkMemberAccount, nickPresent } from '../helpers/webhook-post';

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

describe('Bouncer deauth on the owning server', () => {
  const clients: RawSocketClient[] = [];
  const poolAccounts: string[] = [];

  afterEach(async () => {
    for (const client of clients) {
      try { await bouncerDisableHold(client); } catch { /* ignore */ }
      try { client.close(); } catch { /* ignore */ }
    }
    clients.length = 0;
    for (const account of poolAccounts) releaseTestAccount(account);
    poolAccounts.length = 0;
  });

  it('clears the account on both the primary and its same-server alias', async () => {
    const { account, password } = await getTestAccount();
    poolAccounts.push(account);

    // Primary and alias on the SAME server -- the local-alias case -- both
    // in a channel, where CHECK lists each connection separately.
    const primary = await createSaslBouncerClient(account, password, { nick: uniqueNick('deauthp') });
    clients.push(primary.client);
    const alias = await createSaslBouncerClient(account, password, { nick: uniqueNick('deautha') });
    clients.push(alias.client);
    const channel = `#deauth${Math.random().toString(36).slice(2, 7)}`;
    primary.client.clearRawBuffer();
    primary.client.send(`JOIN ${channel}`);
    await primary.client.waitForLine(new RegExp(` JOIN :?${channel}\\b`), 8000);
    await sleep(1000);                                          // the alias's mirrored membership

    const op = await createOperClient();
    clients.push(op);

    // Precondition: CHECK shows the account on the primary (@) and the alias (~).
    expect(await checkMemberAccount(op, channel, '@', primary.nick), 'primary logged in').toBe(account);
    expect(await checkMemberAccount(op, channel, '~', primary.nick), 'alias logged in').toBe(account);

    expect(await postWebhook(accountDisabledEvent(account))).toBe(200);
    await sleep(1500);

    // Both connections must have lost the account.  Before the fix the
    // alias row still carried it while the primary's was cleared.
    expect(await checkMemberAccount(op, channel, '@', primary.nick), 'primary lost the account').toBe('');
    expect(await checkMemberAccount(op, channel, '~', primary.nick), 'the same-server alias lost the account').toBe('');
  }, 45_000);

  it('tears down a held session and its ghost', async () => {
    const { account, password } = await getTestAccount();
    poolAccounts.push(account);
    const nick = uniqueNick('dghost');

    // Hold on, then drop the socket: the session goes HOLDING and a ghost
    // keeps the nick on the network.
    const primary = await createSaslBouncerClient(account, password, { nick });
    expect(await bouncerEnableHold(primary.client), 'hold enabled').toBe(true);
    primary.client.close();
    await sleep(1500);

    const op = await createOperClient();
    clients.push(op);
    expect(await nickPresent(op, nick), 'the ghost holds the nick before the deauth').toBe(true);

    expect(await postWebhook(accountDisabledEvent(account))).toBe(200);
    await sleep(1500);

    // The account is gone, so there is nothing for the session to revive
    // into: the ghost leaves with it.  Before the fix only the record was
    // destroyed and the ghost stayed, with no timer to ever remove it.
    expect(await nickPresent(op, nick), 'the ghost is gone with its session').toBe(false);

    // Leave the pool account without the hold preference.
    const again = await createSaslBouncerClient(account, password, { nick: uniqueNick('dgoff') });
    clients.push(again.client);
    expect(await bouncerDisableHold(again.client)).toBe(true);
  }, 60_000);
});
