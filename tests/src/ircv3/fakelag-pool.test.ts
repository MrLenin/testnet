import { describe, it, expect, afterAll, afterEach, beforeAll } from 'vitest';
import {
  createRawSocketClient, RawSocketClient, PRIMARY_SERVER,
  uniqueNick, getTestAccount, releaseTestAccount,
  createSaslBouncerClient, bouncerEnableHold, bouncerDisableHold,
  disconnectAbruptly, reconnectBouncer, createOperClient,
} from '../helpers/index.js';

/**
 * evilnet/nefarious2 #158: a shared fake-lag pool behind POSTREG_GRACE.
 * FAKELAG_POOL is a server-wide pool of lag seconds; for 30 s after
 * registration a logged-in connection may draw on it once its grace is spent,
 * up to FAKELAG_BORROW per account per minute.
 *
 * Port 6675 has the default fake lag (2 s + bytes/120): about 15 back-to-back
 * PINGs are answered at once, then one per 2 s.  BORROW 60 is about 30 more.
 *
 * Pending: #158 is still being reworked (branch claude/project-thread-wpt8as).
 * Run with NEF_PR_158=1 against it once its features are settled.  The burst
 * bounds below come from the branch's doc/readme.features.  On 6aac8eb4 the
 * "pool on" cases still saw the plain burst (about 16 PONGs), so these bodies
 * are unproven until someone checks them against the settled design.
 */
const GATED = process.env.NEF_PR_158 !== '1';
const LAG_PORT = 6675;
const BURST = 80;
/** A fresh burst without the pool: 15 at once plus the 3 s we watch, with room. */
const PLAIN_BURST_MAX = 21;
/** With BORROW 60: about 30 more than the plain burst. */
const POOLED_BURST_MIN = 30;
const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));

async function pongsInThreeSeconds(c: RawSocketClient): Promise<number> {
  const tag = Math.random().toString(36).slice(2, 7);
  const start = c.allLines.length;
  for (let i = 0; i < BURST; i++) c.send(`PING :${tag}-${i}`);
  await sleep(3000);
  return c.allLines.slice(start).filter(l => / PONG /.test(l) && l.includes(tag)).length;
}

describe('#158 fake-lag pool', () => {
  let oper: RawSocketClient;
  const clients: RawSocketClient[] = [];
  const pool: string[] = [];

  const setPool = async (cap: number, borrow: number) => {
    oper.send(`SET FAKELAG_POOL ${cap}`);
    oper.send(`SET FAKELAG_BORROW ${borrow}`);
    await sleep(500);
  };

  /** The pool starts empty, begins to fill at the first logged-in registration
   * that could draw on it, and takes 60 s to refill to its cap. */
  const fillPool = async (cap: number, borrow: number) => {
    await setPool(cap, borrow);
    const acc = await getTestAccount();
    const { client } = await createSaslBouncerClient(acc.account, acc.password,
      { nick: uniqueNick('flf'), host: PRIMARY_SERVER.host, port: LAG_PORT });
    await sleep(500);
    try { client.send('QUIT'); client.close(); } catch { /* */ }
    if (acc.fromPool) releaseTestAccount(acc.account);
    await sleep(65_000);
  };

  const fresh = async (extraCaps: string[] = []) => {
    const acc = await getTestAccount();
    if (acc.fromPool) pool.push(acc.account);
    const r = await createSaslBouncerClient(acc.account, acc.password,
      { nick: uniqueNick('flp'), host: PRIMARY_SERVER.host, port: LAG_PORT, extraCaps });
    clients.push(r.client);
    return r;
  };

  beforeAll(async () => {
    if (GATED) return;
    oper = await createOperClient();
  }, 30_000);

  afterEach(async () => {
    for (const c of clients) { try { await bouncerDisableHold(c); } catch { /* */ } try { c.close(); } catch { /* */ } }
    clients.length = 0;
    for (const a of pool) releaseTestAccount(a);
    pool.length = 0;
    if (!GATED) {
      await setPool(0, 0);
      /* The pool is per account per minute and refills over 60 s. */
      await sleep(1000);
    }
  });

  afterAll(() => { try { oper?.send('QUIT'); oper?.close(); } catch { /* */ } });

  it.skipIf(GATED)('with the features off, the post-001 burst on fresh, revive and alias paths matches today', async () => {
    await setPool(0, 0);
    const first = await fresh();
    expect(await bouncerEnableHold(first.client)).toBe(true);
    expect(await pongsInThreeSeconds(first.client), 'fresh').toBeLessThan(PLAIN_BURST_MAX);

    const alias = await createSaslBouncerClient(first.account, first.password,
      { nick: uniqueNick('flq'), host: PRIMARY_SERVER.host, port: LAG_PORT });
    clients.push(alias.client);
    expect(await pongsInThreeSeconds(alias.client), 'alias').toBeLessThan(PLAIN_BURST_MAX);

    alias.client.close();
    clients.splice(clients.indexOf(alias.client), 1);
    await sleep(500);
    disconnectAbruptly(first.client);
    clients.splice(clients.indexOf(first.client), 1);
    await sleep(1000);
    const revived = await reconnectBouncer(first.account, first.password,
      { host: PRIMARY_SERVER.host, port: LAG_PORT });
    clients.push(revived.client);
    expect(await pongsInThreeSeconds(revived.client), 'revive').toBeLessThan(PLAIN_BURST_MAX);
  }, 120_000);

  it.skipIf(GATED)('with them on, the burst grows as designed', async () => {
    await fillPool(600, 60);
    const { client } = await fresh();
    const pongs = await pongsInThreeSeconds(client);
    expect(pongs, 'grace plus the borrow').toBeGreaterThanOrEqual(POOLED_BURST_MIN);
    expect(pongs, 'still bounded').toBeLessThan(BURST);
  }, 180_000);

  it.skipIf(GATED)('two devices share one allowance', async () => {
    await fillPool(600, 60);
    const first = await fresh();
    expect(await bouncerEnableHold(first.client)).toBe(true);
    expect(await pongsInThreeSeconds(first.client)).toBeGreaterThanOrEqual(POOLED_BURST_MIN);
    const second = await createSaslBouncerClient(first.account, first.password,
      { nick: uniqueNick('flq'), host: PRIMARY_SERVER.host, port: LAG_PORT });
    clients.push(second.client);
    expect(await pongsInThreeSeconds(second.client), 'the account has spent its borrow')
      .toBeLessThan(PLAIN_BURST_MAX);
  }, 180_000);

  it.skipIf(GATED)('an anonymous client gets nothing', async () => {
    /* 6675 requires SASL, so an anonymous client is on 6667.  The pool is
     * capped at one borrow, so a draw of any size leaves the logged-in client
     * short.  LIMIT: 6667 is unlagged on this bed, so the anonymous client
     * may never reach the draw path at all; a real check needs a lagged
     * class without require_sasl in the bed's ircd.conf. */
    await fillPool(60, 60);
    const anon = await createRawSocketClient(PRIMARY_SERVER.host, PRIMARY_SERVER.port);
    clients.push(anon);
    await anon.capLs();
    anon.capEnd();
    anon.register(uniqueNick('fla'));
    await anon.waitForNumeric('001');
    await pongsInThreeSeconds(anon);
    const { client } = await fresh();
    expect(await pongsInThreeSeconds(client), 'the pool is untouched')
      .toBeGreaterThanOrEqual(POOLED_BURST_MIN);
  }, 180_000);

  it.skipIf(GATED)('nothing is borrowed after the window', async () => {
    await fillPool(600, 60);
    const { client } = await fresh();
    await sleep(35_000);   // past the 30 s window, and the idle grace has run down
    expect(await pongsInThreeSeconds(client)).toBeLessThan(PLAIN_BURST_MAX);
  }, 180_000);

  it.skipIf(GATED)('multiline lines draw nothing', async () => {
    await fillPool(600, 60);
    const { client } = await fresh(['batch', 'draft/multiline', 'message-tags']);
    const chan = `#flm${Math.random().toString(36).slice(2, 7)}`;
    client.send(`JOIN ${chan}`);
    await sleep(500);
    const id = 'ml1';
    client.send(`BATCH +${id} draft/multiline ${chan}`);
    for (let i = 0; i < 20; i++) client.send(`@batch=${id} PRIVMSG ${chan} :line ${i}`);
    client.send(`BATCH -${id}`);
    await sleep(500);
    expect(await pongsInThreeSeconds(client), 'the borrow is still there')
      .toBeGreaterThanOrEqual(POOLED_BURST_MIN);
  }, 180_000);
});
