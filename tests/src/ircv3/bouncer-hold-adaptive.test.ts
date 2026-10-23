import { describe, it, expect, afterEach, beforeAll, afterAll } from 'vitest';
import {
  RawSocketClient, uniqueNick, getTestAccount, releaseTestAccount,
  createSaslBouncerClient, bouncerEnableHold, bouncerDisableHold,
  disconnectAbruptly, createOperClient,
} from '../helpers/index.js';
import { runCheck } from '../helpers/check-parser.js';

/**
 * Adaptive hold (spec: .claude/para/resources/bouncer-adaptive-hold-spec.md;
 * report 2026-10-20).  A session earns hold time: base + base/4 per
 * connection, + 1 h per 24 h attached, capped.  Once holding, after
 * DECAY_PERCENT of that has passed idle, the remaining part halves per
 * quarter of it, never below base.  Until 2026-10-20 the live hold path
 * armed the flat base and nothing ever accrued or decayed.
 *
 * Numbers here: base 8 s, five connections (create + four revives) ->
 * 8 + 8*5/4 = 18 s.  Decay 50 %: grace 9 s, unit 4 s, so at 13 s idle the
 * remaining 9 s has halved to 4 s and the hold is 13 s: it expires then.
 */
const RUN = process.env.RUN_HOLD_EXPIRY_TESTS === '1';
const BASE = 8;
const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));

async function set(oper: RawSocketClient, feat: string, v: number) {
  oper.send(`SET ${feat} ${v}`); await sleep(300);
}

(RUN ? describe : describe.skip)('Bouncer adaptive hold', () => {
  const clients: RawSocketClient[] = [];
  const pool: string[] = [];
  let oper: RawSocketClient | null = null;

  beforeAll(async () => { oper = await createOperClient(); await set(oper, 'BOUNCER_SESSION_HOLD', BASE); }, 30_000);
  afterAll(async () => {
    if (oper) {
      try { await set(oper, 'BOUNCER_SESSION_HOLD', 14400); await set(oper, 'BOUNCER_HOLD_DECAY_PERCENT', 50); } catch { /* */ }
      try { oper.send('QUIT'); oper.close(); } catch { /* */ }
    }
  });
  afterEach(async () => {
    for (const c of clients) { try { await bouncerDisableHold(c); } catch { /* */ } try { c.close(); } catch { /* */ } }
    clients.length = 0;
    for (const a of pool) releaseTestAccount(a);
    pool.length = 0;
  });

  /** Create a held session with `connects` connections (create + revives). */
  async function earn(connects: number) {
    const acc = await getTestAccount(); if (acc.fromPool) pool.push(acc.account);
    let { client, nick } = await createSaslBouncerClient(acc.account, acc.password, { nick: uniqueNick('ahold') });
    expect(await bouncerEnableHold(client)).toBe(true);
    for (let i = 1; i < connects; i++) {
      disconnectAbruptly(client);
      await sleep(1500);
      // The revive hands back the ghost's nick; keep whatever it is.
      ({ client, nick } = await createSaslBouncerClient(acc.account, acc.password, { nick }));
      await sleep(300);
    }
    clients.push(client);
    const check = await runCheck(oper!, nick, 10_000);
    expect(check.primary?.sessid, "a session exists").toBeTruthy();
    return { client, nick };
  }

  async function held(nick: string): Promise<{ held: boolean; remaining?: number }> {
    try {
      const c = await runCheck(oper!, nick, 5_000);
      const line = c.rawLines.find(l => /Hold expires/.test(l));
      const m = line && /\((\d+)m (\d+)s remaining\)/.exec(line);
      return { held: !!c.primary, remaining: m ? Number(m[1]) * 60 + Number(m[2]) : undefined };
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      expect(msg).toMatch(/ERR_SEARCHNOMATCH|no-match|292/);
      return { held: false };
    }
  }

  it('five connections earn 18 s of hold where one earns 8 s (decay off)', async () => {
    await set(oper!, 'BOUNCER_HOLD_DECAY_PERCENT', 0);
    const { client, nick } = await earn(5);
    const t0 = Date.now();
    disconnectAbruptly(client); clients.splice(clients.indexOf(client), 1);
    await sleep(2000);
    const early = await held(nick);
    expect(early.held, 'holding 2 s after the drop').toBe(true);
    expect(early.remaining, 'CHECK reports the earned hold, not the base').toBeGreaterThan(BASE + 2);
    await sleep(10_000 - (Date.now() - t0));
    expect((await held(nick)).held, 'still holding at 10 s: the base hold would have expired at 8 s').toBe(true);
    await sleep(21_000 - (Date.now() - t0));
    expect((await held(nick)).held, 'gone by 21 s: 18 s earned').toBe(false);
  }, 90_000);

  it('idle decay shortens an earned hold after the grace, never below base', async () => {
    await set(oper!, 'BOUNCER_HOLD_DECAY_PERCENT', 50);
    const { client, nick } = await earn(5);
    const t0 = Date.now();
    disconnectAbruptly(client); clients.splice(clients.indexOf(client), 1);
    await sleep(10_000 - (Date.now() - t0));
    expect((await held(nick)).held, 'held at 10 s: inside the earned 18 s, past the base 8 s').toBe(true);
    await sleep(16_000 - (Date.now() - t0));
    expect((await held(nick)).held, 'gone by 16 s: after 13 s idle the remaining 9 s had halved to 4 s').toBe(false);
  }, 90_000);
});
