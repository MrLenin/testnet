/**
 * Account deauth when the event lands on a server that does not own the
 * session, and account kill when it does.
 *
 * The webhook listener runs on every server, but a Keycloak event reaches
 * ONE of them.  That server must still deauth the whole account: it clears
 * its own replica of a remote primary and sends AC U, which the primary's
 * home server applies with the full receiver (B-2 forbids exiting a remote
 * socket from here, not clearing its account).  Before the fix the walk
 * skipped every remote client, so a single listener deauthed only the
 * sessions that happened to live on its own server.
 *
 * The AC U receiver is the same body the webhook uses, so the second case
 * also proves the receiver clears a same-server alias -- the B-1 defect on
 * its second route.
 *
 * KILL_ON_DELETE must end the whole session, the way a network KILL does.
 * A plain socket exit on a primary with an alias elsewhere hands the
 * session to that alias (promotion) -- the deleted account lives on under
 * the promoted connection.
 *
 * Needs the linked bed (nefarious2); skips when the leaf is unreachable.
 */
import { describe, it, expect, beforeAll, afterEach } from 'vitest';
import { createConnection } from 'node:net';
import {
  RawSocketClient,
  uniqueNick,
  getTestAccount,
  releaseTestAccount,
  createSaslBouncerClient,
  createRawSocketClient,
  bouncerEnableHold,
  bouncerDisableHold,
} from '../helpers/index.js';
import { createOperClient } from '../helpers/x3-client';
import {
  postWebhook,
  accountDisabledEvent,
  accountDeletedEvent,
  checkMemberAccount,
  nickPresent,
  whoisAccount,
} from '../helpers/webhook-post';

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Whether the server closed this client's socket within `ms`. */
async function socketGone(c: RawSocketClient, ms: number): Promise<boolean> {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    if ((c as unknown as { socketClosed: boolean }).socketClosed === true) return true;
    await sleep(250);
  }
  return false;
}

describe('Bouncer deauth across servers', () => {
  const clients: RawSocketClient[] = [];
  const poolAccounts: string[] = [];
  let killSet = false;

  let leafHost: string;
  let leafPort: number;
  let leafReachable = false;

  beforeAll(async () => {
    leafHost = process.env.IRC_HOST2
      ?? (process.env.IRC_HOST === 'localhost' ? 'localhost' : 'nefarious2');
    leafPort = parseInt(
      process.env.IRC_PORT2 ?? (leafHost === 'localhost' ? '6668' : '6667'),
      10,
    );
    leafReachable = await new Promise<boolean>((resolve) => {
      const sock = createConnection({ host: leafHost, port: leafPort });
      const cleanup = (ok: boolean) => {
        sock.removeAllListeners();
        sock.destroy();
        resolve(ok);
      };
      sock.once('connect', () => cleanup(true));
      sock.once('error', () => cleanup(false));
      setTimeout(() => cleanup(false), 2000);
    });
  });

  afterEach(async () => {
    if (killSet) {
      // Put the kill switch back before anything else runs against the bed.
      try {
        const op = await createOperClient();
        op.send('RESET WEBHOOK_KILL_ON_DELETE');
        await sleep(500);
        op.close();
      } catch { /* ignore */ }
      killSet = false;
    }
    for (const client of clients) {
      try { await bouncerDisableHold(client); } catch { /* ignore */ }
      try { client.close(); } catch { /* ignore */ }
    }
    clients.length = 0;
    for (const account of poolAccounts) releaseTestAccount(account);
    poolAccounts.length = 0;
  });

  it('deauths a primary on the leaf when the event lands on testnet', async () => {
    if (!leafReachable) { console.warn(`Skipping: leaf at ${leafHost}:${leafPort} not reachable`); return; }
    const { account, password } = await getTestAccount();
    poolAccounts.push(account);
    const nick = uniqueNick('dxleaf');

    const primary = await createSaslBouncerClient(account, password, { nick, host: leafHost, port: leafPort });
    clients.push(primary.client);
    expect(await whoisAccount(primary.client, nick), 'logged in on the leaf').toBe(account);

    expect(await postWebhook(accountDisabledEvent(account), 'nefarious')).toBe(200);
    await sleep(2000);

    // The leaf applied the AC U testnet sent; testnet's own replica agrees.
    expect(await whoisAccount(primary.client, nick), 'the leaf primary lost the account').toBe('');
    const op = await createOperClient();
    clients.push(op);
    expect(await whoisAccount(op, nick), "testnet's replica lost it too").toBe('');
  }, 60_000);

  it('clears a same-server alias on testnet through AC U when the event lands on the leaf', async () => {
    if (!leafReachable) { console.warn(`Skipping: leaf at ${leafHost}:${leafPort} not reachable`); return; }
    const { account, password } = await getTestAccount();
    poolAccounts.push(account);

    const primary = await createSaslBouncerClient(account, password, { nick: uniqueNick('dxprim') });
    clients.push(primary.client);
    const alias = await createSaslBouncerClient(account, password, { nick: uniqueNick('dxalia') });
    clients.push(alias.client);
    const channel = `#dxac${Math.random().toString(36).slice(2, 7)}`;
    primary.client.clearRawBuffer();
    primary.client.send(`JOIN ${channel}`);
    await primary.client.waitForLine(new RegExp(` JOIN :?${channel}\\b`), 8000);
    await sleep(1000);

    const op = await createOperClient();
    clients.push(op);
    expect(await checkMemberAccount(op, channel, '@', primary.nick), 'primary logged in').toBe(account);
    expect(await checkMemberAccount(op, channel, '~', primary.nick), 'alias logged in').toBe(account);

    // The event reaches the leaf, which owns neither connection.
    expect(await postWebhook(accountDisabledEvent(account), 'nefarious2')).toBe(200);
    await sleep(2000);

    expect(await checkMemberAccount(op, channel, '@', primary.nick), 'primary lost the account').toBe('');
    expect(await checkMemberAccount(op, channel, '~', primary.nick), 'the same-server alias lost the account').toBe('');
  }, 60_000);

  it('kill on delete ends the whole session: the leaf alias is disconnected, not promoted', async () => {
    if (!leafReachable) { console.warn(`Skipping: leaf at ${leafHost}:${leafPort} not reachable`); return; }
    const { account, password } = await getTestAccount();
    poolAccounts.push(account);
    const nick = uniqueNick('dxkill');

    const primary = await createSaslBouncerClient(account, password, { nick });
    clients.push(primary.client);
    expect(await bouncerEnableHold(primary.client), 'hold enabled').toBe(true);
    const alias = await createSaslBouncerClient(account, password, { nick, host: leafHost, port: leafPort });
    clients.push(alias.client);
    await sleep(1500);

    const op = await createOperClient();
    clients.push(op);
    op.send('SET WEBHOOK_KILL_ON_DELETE TRUE');
    killSet = true;
    op.clearRawBuffer();
    op.send('STATS f');
    await op.waitForLine(/WEBHOOK_KILL_ON_DELETE/, 8000);          // STATS f lists non-default features

    expect(await postWebhook(accountDeletedEvent(account), 'nefarious')).toBe(200);

    // Every socket of the session goes: the primary's here, the alias's on
    // the leaf through the session teardown.
    expect(await socketGone(primary.client, 8000), 'the primary was disconnected').toBe(true);
    expect(await socketGone(alias.client, 8000), 'the leaf alias was disconnected').toBe(true);

    // Nothing was promoted and no ghost holds the nick.
    const probe = await createRawSocketClient(leafHost, leafPort);
    clients.push(probe);
    await probe.capLs();
    probe.capEnd();
    probe.register(uniqueNick('dxprobe'));
    await probe.waitForNumeric('001', 15000);
    expect(await nickPresent(probe, nick), 'the nick is gone on the leaf').toBe(false);
    expect(await nickPresent(op, nick), 'the nick is gone on testnet').toBe(false);
  }, 90_000);
});
