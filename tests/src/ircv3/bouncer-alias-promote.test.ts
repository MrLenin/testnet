import { describe, it, expect, afterEach } from 'vitest';
import {
  RawSocketClient,
  uniqueNick,
  getTestAccount,
  releaseTestAccount,
  createSaslBouncerClient,
  bouncerEnableHold,
  bouncerDisableHold,
  createOperClient,
} from '../helpers/index.js';
import { runCheck } from '../helpers/check-parser.js';

/**
 * Primary clean-QUIT path with an alias remaining.
 *
 * Design intent (bouncer-design-intent.md §Session lifecycle):
 *   "Primary disconnects (clean) with at least one alias remaining →
 *    an alias takes its place via BX P (numeric swap, original
 *    primary silently killed by the internal bouncer mechanism)."
 *
 * Current implementation (m_quit.c around line 125):
 *   "No immediate-promote shortcut: a primary QUIT with aliases attached
 *    holds first (same reasoning as s_bsd.c — promote and a concurrent
 *    BX X for the chosen alias race on the wire).  Promotion runs only
 *    from bounce_hold_expire after the network has settled."
 *
 * So the implementation chose to defer promotion to hold-expiry to
 * avoid the BX P / BX X race window.  Test captures the current
 * observed behavior: primary clean QUIT → session HOLDING with the
 * original primary as a ghost; alias remains in alias position;
 * promotion will happen later at hold-expiry.
 *
 * If the design is tightened to immediate promote (closing the race
 * some other way), update this test to assert the alias's numeric
 * swap into the primary slot.  [[bouncer-alias-promote-deferred]]
 */
describe('Bouncer alias-on-primary-QUIT (deferred-promote semantics)', () => {
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

  it('primary clean QUIT with alias remaining: session HOLDING, ghost retained, alias intact', async () => {
    const account = await getTestAccount();
    poolAccounts.push(account.account);
    const nick = uniqueNick('prm');

    const primary = await createSaslBouncerClient(
      account.account, account.password, { nick },
    );
    clients.push(primary.client);
    expect(await bouncerEnableHold(primary.client)).toBe(true);

    const alias = await createSaslBouncerClient(
      account.account, account.password,
      { nick: uniqueNick('prma') },
    );
    clients.push(alias.client);

    await new Promise(r => setTimeout(r, 800));

    const oper = await createOperClient();
    clients.push(oper);

    const before = await runCheck(oper, nick, 10_000);
    expect(before.primary).toBeDefined();
    expect(before.aliases.length).toBe(1);
    const sessidBefore = before.primary!.sessid;
    const primaryNumericBefore = before.primary!.numeric;
    const aliasNumericBefore = before.aliases[0].numeric;

    // Clean QUIT of the primary.
    primary.client.send('QUIT :primary leaving');
    primary.client.close();
    const idx = clients.indexOf(primary.client);
    if (idx >= 0) clients.splice(idx, 1);

    // Settle: hold-client path + propagation.
    await new Promise(r => setTimeout(r, 1500));

    // The alias's TCP connection is unaffected — confirm with a
    // PING/PONG round-trip.
    alias.client.send('PING :still-here');
    await alias.client.waitForLine(/\bPONG\b.*still-here/, 5000);

    const after = await runCheck(oper, nick, 10_000);

    expect(after.primary).toBeDefined();
    // Sessid unchanged.
    expect(after.primary!.sessid).toBe(sessidBefore);
    // The original primary numeric is retained on the ghost — peers
    // continue to see the primary at the same numeric until hold-expiry
    // promotes the alias and swaps its numeric in via BX P.
    expect(after.primary!.numeric).toBe(primaryNumericBefore);
    // Alias is still listed as an alias (no promote yet).
    expect(after.aliases.length).toBe(1);
    expect(after.aliases[0].numeric).toBe(aliasNumericBefore);
    expect(after.aliases[0].sessid).toBe(sessidBefore);
    // The /CHECK -b rawLines include "Session state:: HOLDING".
    expect(after.rawLines.some(l => /Session state:: HOLDING/.test(l))).toBe(true);
    // And "Connections:: 0 (holding)" — the bouncer counts the alias as
    // a session connection only when promotion happens; until then the
    // session is "holding" from the session's POV even though the alias
    // socket is still live.
    expect(after.rawLines.some(l => /Connections:: 0 \(holding\)/.test(l))).toBe(true);
  });
});
