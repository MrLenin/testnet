/**
 * B-1 regression: a LOCAL bouncer alias must lose its account when the
 * account is deauthed.
 *
 * bounce_emit_alias_update()'s local-apply pass handled seven of the nine
 * BX U fields; `account` was not one of them.  The S2S broadcast skips
 * the primary's own server for loop prevention, so an alias sharing a
 * server with its primary was the one case nothing cleared -- it kept
 * FLAG_ACCOUNT and the account string indefinitely.  Remote aliases were
 * always fine, which is why a single-server bed never showed it.
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
 * both connections around to be inspected.
 */
import { describe, it, expect, afterEach } from 'vitest';
import * as fs from 'node:fs';
import { run } from '../helpers/bed-control';
import {
  RawSocketClient,
  uniqueNick,
  getTestAccount,
  releaseTestAccount,
  createSaslBouncerClient,
  bouncerDisableHold,
} from '../helpers/index.js';
import { createOperClient } from '../helpers/x3-client';

function ircdIp(): string {
  return run('docker', ['inspect', '-f', '{{range .NetworkSettings.Networks}}{{.IPAddress}}{{end}}', 'nefarious']).trim();
}

function ircdWebhookSecret(): string {
  const m = /"WEBHOOK_SECRET"\s*=\s*"([^"]+)"/.exec(fs.readFileSync('../data/ircd.conf', 'utf8'));
  if (!m) throw new Error('WEBHOOK_SECRET not in data/ircd.conf');
  return m[1];
}

/** POST a Keycloak-shaped webhook event to the ircd; resolves to the status code. */
async function postWebhook(body: unknown): Promise<number> {
  const res = await fetch(`http://${ircdIp()}:9090/keycloak-webhook`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-Webhook-Secret': ircdWebhookSecret() },
    body: JSON.stringify(body),
  });
  return res.status;
}

/**
 * The account CHECK shows for one member of a channel.  `marker` is the
 * status character before the nick: '~' for an alias, '@' for the op.
 * RPL_CHANUSER (287): ": <oplvl> <status><nick> (<user>@<host>)   (<info>) <account>"
 */
async function checkAccount(op: RawSocketClient, channel: string, marker: string, nick: string): Promise<string> {
  op.clearRawBuffer();
  op.send(`CHECK ${channel}`);
  const escaped = marker.replace(/[~@+%<!]/g, (c) => `\\${c}`);
  const row = await op.waitForLine(new RegExp(` 287 \\S+ :.*${escaped}${nick} \\(`), 8000);
  const m = /\)\s+\(.*\) ?(\S*)\s*$/.exec(row);
  return m ? m[1] : '';
}

describe('Bouncer deauth clears LOCAL alias accounts', () => {
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
    await new Promise((r) => setTimeout(r, 1000));            // the alias's mirrored membership

    const op = await createOperClient();
    clients.push(op);

    // Precondition: CHECK shows the account on the primary (@) and the alias (~).
    expect(await checkAccount(op, channel, '@', primary.nick), 'primary logged in').toBe(account);
    expect(await checkAccount(op, channel, '~', primary.nick), 'alias logged in').toBe(account);

    // Disable the account via the webhook's USER/UPDATE branch.
    const status = await postWebhook({
      id: 'test-deauth-1',
      time: Date.now(),
      realmId: 'testnet',
      resourceType: 'USER',
      operationType: 'UPDATE',
      username: account,
      representation: JSON.stringify({ enabled: false }),
    });
    expect(status).toBe(200);
    await new Promise((r) => setTimeout(r, 1500));

    // Both connections must have lost the account.  Before the fix the
    // alias row still carried it while the primary's was cleared.
    expect(await checkAccount(op, channel, '@', primary.nick), 'primary lost the account').toBe('');
    expect(await checkAccount(op, channel, '~', primary.nick), 'the same-server alias lost the account').toBe('');
  }, 45_000);
});
