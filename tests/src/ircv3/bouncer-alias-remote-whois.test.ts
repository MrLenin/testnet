import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import net from 'node:net';
import {
  createRawSocketClient,
  RawSocketClient,
  uniqueNick,
  getTestAccount,
  releaseTestAccount,
  createSaslBouncerClient,
  bouncerEnableHold,
  bouncerDisableHold,
  PRIMARY_SERVER,
} from '../helpers/index.js';

/**
 * Field report (2026-09-02): a bouncer user's routed `WHOIS nick nick`
 * toward a user on a legacy server returned NOTHING -- no numerics, no
 * error -- while a fresh non-bouncer client on the same server got the
 * full reply.  Bouncer invariant #10: an alias numeric is introduced
 * only via BX C, which legacy peers never learn, so a routed command
 * sourced from the alias is an unknown source at the first legacy hop
 * and is dropped silently.  hunt_server_cmd lacked the alias->primary
 * rewrite the PM relay already had; and since a reply addressed to the
 * primary reaches only the primary's socket, the numeric relay now
 * mirrors S2S replies to the session's local aliases too.
 *
 * Needs the bed's legacy comparison slot (nefarious-upstream, unmodified
 * evilnet master, client port 6671) linked to the primary; skips when
 * it is not up.
 */

const LEGACY_PORT = 6671;
const rawOf = (c: unknown): string[] =>
  (c as { lines: { raw: string }[] }).lines.map(l => l.raw);

async function legacySlotUp(): Promise<boolean> {
  return new Promise(resolve => {
    const s = net.connect(LEGACY_PORT, PRIMARY_SERVER.host);
    const done = (v: boolean) => { try { s.destroy(); } catch { /* */ } resolve(v); };
    s.once('connect', () => done(true));
    s.once('error', () => done(false));
    setTimeout(() => done(false), 2000);
  });
}

let up = false;
let legacy: RawSocketClient | null = null;
let legacyNick = '';
let primary: RawSocketClient | null = null;
let alias: RawSocketClient | null = null;
let poolAccount: string | null = null;

beforeAll(async () => {
  up = await legacySlotUp();
  if (!up) return;

  legacy = await createRawSocketClient(PRIMARY_SERVER.host, LEGACY_PORT);
  await legacy.capLs();
  legacy.capEnd();
  legacyNick = uniqueNick('lgcy');
  legacy.register(legacyNick);
  // The legacy slot's ident/DNS lookups make registration slow.
  await legacy.waitForNumeric('001', 25000);

  const account = await getTestAccount();
  poolAccount = account.account;
  const p = await createSaslBouncerClient(account.account, account.password,
    { nick: uniqueNick('bprm'), extraCaps: ['message-tags'] });
  primary = p.client;
  expect(await bouncerEnableHold(primary)).toBe(true);
  const a = await createSaslBouncerClient(account.account, account.password,
    { nick: uniqueNick('bals'), extraCaps: ['message-tags'] });
  alias = a.client;
  await new Promise(r => setTimeout(r, 1500));
}, 60000);

afterAll(async () => {
  // Hold was enabled on the primary for the alias to form; disable it
  // before closing, or the pool account keeps a held ghost that the next
  // test drawing this account would revive into (inheriting our nick).
  if (primary) { try { await bouncerDisableHold(primary); } catch { /* */ } }
  for (const c of [alias, primary, legacy]) { try { c?.close(); } catch { /* */ } }
  if (poolAccount) await releaseTestAccount(poolAccount);
});

describe('bouncer alias routed WHOIS toward a legacy server', () => {
  it('the alias that asks receives the reply (not silence, not only the other device)', async () => {
    if (!up) { console.warn('legacy slot (6671) not up - skipping'); return; }
    alias!.clearRawBuffer();
    primary!.clearRawBuffer();
    alias!.send(`WHOIS ${legacyNick} ${legacyNick}`);
    const end = await alias!.waitForLine(new RegExp(` 318 \\S+ ${legacyNick} `), 6000)
      .catch(() => null);
    expect(end, 'routed WHOIS from the alias must be answered on the alias').toBeTruthy();
    const got = rawOf(alias!).filter(l => new RegExp(` 31[1278] \\S+ ${legacyNick} `).test(l));
    expect(got.length, 'expected the 311/317/318 sequence on the alias').toBeGreaterThanOrEqual(2);
  }, 20000);

  it('control: the primary itself gets a routed reply too', async () => {
    if (!up) { console.warn('legacy slot (6671) not up - skipping'); return; }
    primary!.clearRawBuffer();
    primary!.send(`WHOIS ${legacyNick} ${legacyNick}`);
    const end = await primary!.waitForLine(new RegExp(` 318 \\S+ ${legacyNick} `), 6000)
      .catch(() => null);
    expect(end).toBeTruthy();
  }, 20000);
});
