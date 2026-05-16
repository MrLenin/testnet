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
 * Immediate alias-promotion on primary clean QUIT (local alias).
 *
 * Design intent (bouncer-design-intent.md §Session lifecycle):
 *   "Primary disconnects (clean) with at least one alias remaining →
 *    an alias takes its place via BX P (numeric swap, original
 *    primary silently killed by the internal bouncer mechanism)."
 *
 * Implementation (nefarious e64d10c): m_quit.c now calls
 * bounce_promote_alias(session, /* local_only *\/ 1) before
 * bounce_hold_client.  When the session has a local-server alias,
 * we promote it immediately via BX P — same-server alias state is
 * synchronously authoritative, so the broadcast can't race a
 * concurrent BX X from the alias's home server (we ARE that server).
 *
 * Cross-server case (only remote alias) still falls through to
 * bounce_hold_client; the hold-expire path promotes once the network
 * settles.  That's a separate scenario tracked by future work — this
 * test covers the local-alias case.
 */
describe('Bouncer immediate-promote on primary clean QUIT (local alias)', () => {
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

  it('local alias is promoted in place: numeric swap, no HOLDING, sessid stable', async () => {
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

    // Settle: bounce_promote_alias inline + BX P broadcast + channel
    // strip on the old primary.  Sub-millisecond on the implementation
    // side; give a comfortable wait for any S2S settling.
    await new Promise(r => setTimeout(r, 1000));

    // Alias's TCP connection is unaffected.
    alias.client.send('PING :still-here');
    await alias.client.waitForLine(/\bPONG\b.*still-here/, 5000);

    const after = await runCheck(oper, nick, 10_000);

    expect(after.primary).toBeDefined();
    // Sessid is stable across promote — same session, just a different
    // primary connection.
    expect(after.primary!.sessid).toBe(sessidBefore);
    // BX P swapped: the new primary's numeric is the OLD ALIAS's
    // numeric.  Peers continue to see THIS session, but at the alias's
    // numeric (now-primary's numeric).
    expect(after.primary!.numeric).toBe(aliasNumericBefore);
    // The old primary numeric is gone — released back to the local
    // numeric pool when the old primary client exited.
    expect(after.primary!.numeric).not.toBe(primaryNumericBefore);
    // No aliases remain (only one existed, and it just became primary).
    expect(after.aliases.length).toBe(0);
    // Session state is ACTIVE — no HOLDING transition.
    expect(after.rawLines.some(l => /Session state:: ACTIVE/.test(l))).toBe(true);
    // At least one live connection (the promoted alias).
    expect(after.rawLines.some(l => /Connections:: \d+ \(active\)/.test(l))).toBe(true);
  });
});
