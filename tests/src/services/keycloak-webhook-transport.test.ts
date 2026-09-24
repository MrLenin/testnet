/**
 * The webhook listener acts only on a delivery that is signed with the
 * shared secret, fresh, not a replay, and from the ircd's own realm; every
 * refusal is visible to an oper (audit P0-3, P0-4).
 *
 * The helper posts what the SPI posts: the plain secret header plus
 * X-Webhook-Signature (t=<unix>,v1=<hex HMAC-SHA256(secret, "<t>." + body)>)
 * and a realmName.  Each case bends one thing and asserts the status and
 * that the logged-in account is untouched; the replay case is the one that
 * acts, so it comes last.  Before the fix the listener checked only the
 * plain secret header, so every bent delivery was accepted.
 */
import { describe, it, expect, afterEach } from 'vitest';
import {
  RawSocketClient,
  uniqueNick,
  getTestAccount,
  releaseTestAccount,
  createSaslBouncerClient,
  bouncerDisableHold,
} from '../helpers/index.js';
import { createOperClient } from '../helpers/x3-client';
import { postWebhook, accountDisabledEvent, whoisAccount, withoutRealmCount } from '../helpers/webhook-post';

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** The "bad or missing signature" count STATS webhook reports to an oper. */
async function refusedSignatures(op: RawSocketClient): Promise<number> {
  op.clearRawBuffer();
  op.send('STATS webhook');
  const line = await op.waitForLine(/Refused: \d+ bad or missing signature/, 8000);
  return parseInt(/Refused: (\d+) bad or missing signature/.exec(line)![1], 10);
}

describe('Webhook transport: signature, freshness, replay, realm', () => {
  const clients: RawSocketClient[] = [];
  const poolAccounts: string[] = [];

  afterEach(async () => {
    for (const c of clients) {
      try { await bouncerDisableHold(c); } catch { /* ignore */ }
      try { c.close(); } catch { /* ignore */ }
    }
    clients.length = 0;
    for (const a of poolAccounts) releaseTestAccount(a);
    poolAccounts.length = 0;
  });

  /** A logged-in pool account whose WHOIS shows the account. */
  async function loggedIn(prefix: string): Promise<{ client: RawSocketClient; nick: string; account: string }> {
    const { account, password } = await getTestAccount();
    poolAccounts.push(account);
    const nick = uniqueNick(prefix);
    const c = await createSaslBouncerClient(account, password, { nick });
    clients.push(c.client);
    expect(await whoisAccount(c.client, nick), 'logged in').toBe(account);
    return { client: c.client, nick, account };
  }

  async function stillLoggedIn(client: RawSocketClient, nick: string, account: string, why: string): Promise<void> {
    await sleep(1500);
    expect(await whoisAccount(client, nick), why).toBe(account);
  }

  it('refuses an unsigned event and does not act', async () => {
    const { client, nick, account } = await loggedIn('wtuns');
    expect(await postWebhook(accountDisabledEvent(account), 'nefarious', { unsigned: true })).toBe(401);
    await stillLoggedIn(client, nick, account, 'an unsigned disable did nothing');
  }, 45_000);

  it('refuses a stale signature', async () => {
    const { client, nick, account } = await loggedIn('wtstal');
    expect(await postWebhook(accountDisabledEvent(account), 'nefarious', { t: Math.floor(Date.now() / 1000) - 400 })).toBe(401);
    await stillLoggedIn(client, nick, account, 'a stale disable did nothing');
  }, 45_000);

  it('refuses a signature made with another secret', async () => {
    const { client, nick, account } = await loggedIn('wtsec');
    expect(await postWebhook(accountDisabledEvent(account), 'nefarious', { secret: 'nope' })).toBe(401);
    await stillLoggedIn(client, nick, account, 'a wrongly signed disable did nothing');
  }, 45_000);

  it('refuses an event from another realm', async () => {
    const { client, nick, account } = await loggedIn('wtrlm');
    expect(await postWebhook({ ...accountDisabledEvent(account), realmName: 'other' })).toBe(403);
    await stillLoggedIn(client, nick, account, "another realm's disable did nothing");
  }, 45_000);

  it('refuses a replay of a valid event, after acting on the original', async () => {
    const { client, nick, account } = await loggedIn('wtrpl');
    const event = { ...accountDisabledEvent(account), id: `replay-${Date.now()}` };
    const t = Math.floor(Date.now() / 1000);
    expect(await postWebhook(event, 'nefarious', { t }), 'the original').toBe(200);
    await sleep(1500);
    expect(await whoisAccount(client, nick), 'the original acted').toBe('');
    expect(await postWebhook(event, 'nefarious', { t }), 'the same event again').toBe(401);
  }, 45_000);

  it('STATS webhook shows the refusals to an oper', async () => {
    const op = await createOperClient();
    clients.push(op);
    const before = await refusedSignatures(op);
    expect(await postWebhook(accountDisabledEvent('nobody'), 'nefarious', { unsigned: true })).toBe(401);
    expect(await refusedSignatures(op), 'one more refusal counted').toBe(before + 1);
  }, 45_000);

  // Review finding 2: the entry's flags used to send a non-oper through
  // feature_bool(FEAT_LAST_F), whose type assert aborted the server.
  it("refuses a non-oper's STATS webhook with 481", async () => {
    const { client } = await loggedIn('wtnop');
    client.clearRawBuffer();
    client.send('STATS webhook');
    await client.waitForLine(/ 481 /, 8000);
  }, 45_000);

  // Review finding 4 (decision 4): a payload without realmName is accepted and counted.
  it('accepts a payload without realmName and counts it', async () => {
    const op = await createOperClient();
    clients.push(op);
    const before = await withoutRealmCount(op);
    const bare: Record<string, unknown> = { ...accountDisabledEvent('nobody') };
    delete bare.realmName;
    expect(await postWebhook(bare, 'nefarious')).toBe(200);
    expect(await withoutRealmCount(op), 'one more counted').toBe(before + 1);
  }, 45_000);
});
