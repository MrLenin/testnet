/**
 * Every server receives every Keycloak event and acts on what it owns;
 * one relay per event, deduped by the event id, covers the servers the
 * SPI could not reach (webhook plan 4, D1-D4, D6).
 *
 * Needs the linked bed (nefarious2); skips when the leaf is unreachable.
 * The helper posts to either listener (the leaf's is 9091, from
 * data/ircd2.conf).  Every case reads the counters `STATS webhook`
 * reports on both servers in one request (webhookCounts) and asserts the
 * observable a user cares about first: the account is gone from the
 * client that carried it, once.
 */
import { describe, it, expect, beforeAll, afterEach } from 'vitest';
import { createConnection } from 'node:net';
import {
  RawSocketClient,
  uniqueNick,
  getTestAccount,
  releaseTestAccount,
  createSaslBouncerClient,
  bouncerDisableHold,
} from '../helpers/index.js';
import { createOperClient, X3Client, IRC_OPER } from '../helpers/x3-client';
import {
  postWebhook, accountDisabledEvent, accountEventById, whoisAccount, webhookCounts, WebhookCounts,
} from '../helpers/webhook-post';
import { getKeycloakAdminToken } from '../helpers/keycloak-sync';

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const KC = process.env.KEYCLOAK_URL || 'http://localhost:8080';

/** An oper on the leaf (createOperClient only knows the primary). */
async function createLeafOperClient(host: string, port: number): Promise<X3Client> {
  const c = new X3Client();
  await c.connect(host, port);
  await c.capLs();
  c.capEnd();
  c.register(uniqueNick('lop'));
  await c.waitForLine(/ 001 /, 15000);
  await sleep(1000);
  c.send(`OPER ${IRC_OPER.name} ${IRC_OPER.password}`);
  await c.waitForLine(/ 381 /, 5000);
  return c;
}

/** Poll WHOIS until the nick shows no account, or give up. */
async function loggedOutWithin(c: RawSocketClient, nick: string, ms: number): Promise<boolean> {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    if ((await whoisAccount(c, nick)) === '') return true;
    await sleep(500);
  }
  return false;
}

const applied = (c: WebhookCounts) => c.direct + c.relay + c.catchup;
const dropped = (c: WebhookCounts) => c.alreadyDirect + c.alreadyRelay;

describe('Webhook fan-out: every server receives, one relay per event', () => {
  const clients: RawSocketClient[] = [];
  const poolAccounts: string[] = [];
  let leafHost = 'localhost';
  let leafPort = 6668;
  let leafReachable = false;

  beforeAll(async () => {
    leafHost = process.env.IRC_HOST2 ?? (process.env.IRC_HOST === 'localhost' ? 'localhost' : 'nefarious2');
    leafPort = parseInt(process.env.IRC_PORT2 ?? (leafHost === 'localhost' ? '6668' : '6667'), 10);
    leafReachable = await new Promise<boolean>((resolve) => {
      const sock = createConnection({ host: leafHost, port: leafPort });
      const cleanup = (ok: boolean) => { sock.removeAllListeners(); sock.destroy(); resolve(ok); };
      sock.once('connect', () => cleanup(true));
      sock.once('error', () => cleanup(false));
      setTimeout(() => cleanup(false), 2000);
    });
  });

  afterEach(async () => {
    for (const c of clients) {
      try { await bouncerDisableHold(c); } catch { /* ignore */ }
      try { c.close(); } catch { /* ignore */ }
    }
    clients.length = 0;
    for (const a of poolAccounts) releaseTestAccount(a);
    poolAccounts.length = 0;
  });

  /** A logged-in pool account on the primary or the leaf. */
  async function loggedIn(prefix: string, where: 'primary' | 'leaf') {
    const { account, password } = await getTestAccount();
    poolAccounts.push(account);
    const nick = uniqueNick(prefix);
    const opts = where === 'leaf' ? { nick, host: leafHost, port: leafPort } : { nick };
    const c = await createSaslBouncerClient(account, password, opts);
    clients.push(c.client);
    expect(await whoisAccount(c.client, nick), `logged in on the ${where}`).toBe(account);
    return { client: c.client, nick, account };
  }

  async function opers() {
    const primary = await createOperClient();
    const leaf = await createLeafOperClient(leafHost, leafPort);
    clients.push(primary, leaf);
    return { primary, leaf };
  }

  it('the leaf acts on its own delivery', async () => {
    if (!leafReachable) { console.warn(`Skipping: leaf at ${leafHost}:${leafPort} not reachable`); return; }
    const { client, nick, account } = await loggedIn('fnleaf', 'leaf');
    const { primary } = await opers();
    expect(await postWebhook(accountDisabledEvent(account), 'nefarious2')).toBe(200);
    expect(await loggedOutWithin(client, nick, 5000), 'the leaf client lost its account').toBe(true);
    // The leaf's own AC U crosses the link a moment later.
    expect(await loggedOutWithin(primary, nick, 5000), "the primary's replica agrees").toBe(true);
  }, 60_000);

  it('an event delivered to one server reaches the other through the relay', async () => {
    if (!leafReachable) { console.warn('Skipping: leaf not reachable'); return; }
    const { client, nick, account } = await loggedIn('fnrly', 'primary');
    const { primary, leaf } = await opers();
    const p0 = await webhookCounts(primary);
    const l0 = await webhookCounts(leaf);
    expect(await postWebhook(accountDisabledEvent(account), 'nefarious2'), 'posted to the leaf only').toBe(200);
    expect(await loggedOutWithin(client, nick, 5000), 'the primary client lost its account').toBe(true);
    const p1 = await webhookCounts(primary);
    const l1 = await webhookCounts(leaf);
    expect(p1.relay, 'the primary applied the relay').toBe(p0.relay + 1);
    expect(p1.deauths, 'the primary deauthed its own client').toBe(p0.deauths + 1);
    expect(l1.direct, 'the leaf applied the delivery').toBe(l0.direct + 1);
    expect(l1.deauths, 'the leaf owned no client of that account').toBe(l0.deauths);
  }, 60_000);

  // Review focus 4: two direct receivers, no loop.
  it('delivered to both servers: applied once per server, relays do not loop', async () => {
    if (!leafReachable) { console.warn('Skipping: leaf not reachable'); return; }
    const { client, nick, account } = await loggedIn('fnboth', 'primary');
    const { primary, leaf } = await opers();
    const p0 = await webhookCounts(primary);
    const l0 = await webhookCounts(leaf);
    const event = { ...accountDisabledEvent(account), id: `fanout-${Date.now()}` };
    expect(await postWebhook(event, 'nefarious')).toBe(200);
    expect(await postWebhook(event, 'nefarious2')).toBe(200);
    expect(await loggedOutWithin(client, nick, 5000), 'the client lost its account').toBe(true);
    await sleep(2000);
    const p1 = await webhookCounts(primary);
    const l1 = await webhookCounts(leaf);
    for (const [name, before, after] of [['primary', p0, p1], ['leaf', l0, l1]] as const) {
      expect(applied(after) - applied(before), `${name}: applied exactly once`).toBe(1);
      expect(dropped(after) - dropped(before), `${name}: the other copy was dropped`).toBe(1);
      expect(after.userEvents - before.userEvents, `${name}: the handler ran once`).toBe(1);
    }
    await sleep(10000);
    const p2 = await webhookCounts(primary);
    const l2 = await webhookCounts(leaf);
    expect(applied(p2) + dropped(p2), 'primary: nothing moved afterwards').toBe(applied(p1) + dropped(p1));
    expect(applied(l2) + dropped(l2), 'leaf: nothing moved afterwards').toBe(applied(l1) + dropped(l1));
  }, 60_000);

  // Bouncer pass H1: the relay carries the names the sender resolved, so a
  // peer that owns a session it can match only by name (authenticated
  // through X3, no Keycloak id on the client) still deauths it.  The primary
  // learns the name from its positive cache (a SASL login and logout), the
  // event names the subject only by uuid, and it is posted to the primary
  // alone.
  it('a real-shaped event reaches a name-only session on the other server through the relay', async () => {
    if (!leafReachable) { console.warn('Skipping: leaf not reachable'); return; }
    const { account, password } = await getTestAccount();
    poolAccounts.push(account);
    let uuid = '';
    try {
      const token = await getKeycloakAdminToken();
      const res = await fetch(`${KC}/admin/realms/testnet/users?username=${encodeURIComponent(account)}&exact=true`,
        { headers: { Authorization: `Bearer ${token}` } });
      const users = res.ok ? await res.json() as { id: string }[] : [];
      uuid = users[0]?.id ?? '';
    } catch (e) { console.warn(`Keycloak lookup failed: ${(e as Error).message}`); }
    if (!uuid) { console.warn(`Skipping: ${account} has no Keycloak user`); return; }

    // The leaf owns a session authenticated through X3 (AuthServ), by name.
    const leafNick = uniqueNick('fnx3');
    const leaf = new X3Client();
    await leaf.connect(leafHost, leafPort);
    await leaf.capLs();
    leaf.capEnd();
    leaf.register(leafNick);
    await leaf.waitForLine(/ 001 /, 15000);
    await sleep(1000);
    clients.push(leaf);
    const auth = await leaf.auth(account, password, 15000);
    expect(auth.success, 'AuthServ login on the leaf').toBe(true);
    expect(await whoisAccount(leaf, leafNick), 'the leaf session carries the account').toBe(account);

    // The primary knows the name only through its positive cache: a SASL
    // login (id and name cached) that then leaves without a held session.
    const cacheNick = uniqueNick('fncache');
    const cached = await createSaslBouncerClient(account, password, { nick: cacheNick });
    expect(await bouncerDisableHold(cached.client), 'hold off for the cache login').toBe(true);
    cached.client.close();
    await sleep(1500);

    const { primary, leaf: leafOp } = await opers();
    const p0 = await webhookCounts(primary);
    const l0 = await webhookCounts(leafOp);
    expect(await postWebhook(accountEventById('disable', uuid), 'nefarious'), 'posted to the primary only').toBe(200);
    expect(await loggedOutWithin(leaf, leafNick, 8000), 'the leaf session lost its account').toBe(true);
    const p1 = await webhookCounts(primary);
    const l1 = await webhookCounts(leafOp);
    expect(p1.relaysSent, 'the primary relayed the event').toBe(p0.relaysSent + 1);
    expect(l1.relay, 'the leaf applied the relay').toBe(l0.relay + 1);
    expect(l1.deauths, 'the leaf deauthed its own session').toBe(l0.deauths + 1);
  }, 90_000);

  // Review focus 1: an id the log cannot hold is applied without dedupe and never stored.
  it('a delivery whose event id cannot travel the wire is applied but not logged', async () => {
    if (!leafReachable) { console.warn('Skipping: leaf not reachable'); return; }
    const { primary } = await opers();
    const p0 = await webhookCounts(primary);
    const junk = { ...accountDisabledEvent('nobody'), id: 'x'.repeat(60) };
    expect(await postWebhook(junk, 'nefarious')).toBe(200);
    await sleep(1500);
    const p1 = await webhookCounts(primary);
    expect(p1.direct, 'applied (no dedupe possible)').toBe(p0.direct + 1);
    expect(p1.logEntries, 'not recorded').toBe(p0.logEntries);
  }, 60_000);
});
