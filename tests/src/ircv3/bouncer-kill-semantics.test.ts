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
 * KILL semantics on bouncer sessions.
 *
 * Design intent (bouncer-design-intent.md §Session lifecycle):
 *   "Network KILL of any session connection (primary OR alias) → entire
 *    session ends.  All other connections of the session are also
 *    terminated; aliases do not 'get a pass' by virtue of being on a
 *    different server.  KILL is an oper assertion that this user should
 *    not be on the network — applies to the whole session."
 *
 *   "KILL on the primary should just kill the whole session.  Your
 *    aliases shouldn't get a pass, and the consequences should be
 *    equal to anyone else."
 *
 * This is invariant #12 in the bouncer design.  Tests pin two cases:
 *   1. KILL on the primary in a multi-attach session terminates the
 *      alias too and destroys the session.
 *   2. /CHECK -b after KILL returns no-match — session is gone.
 */
describe('Bouncer KILL semantics: KILL ends the entire session', () => {
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

  it('KILL on primary terminates alias and destroys session', async () => {
    const account = await getTestAccount();
    poolAccounts.push(account.account);
    const nick = uniqueNick('kil');

    const primary = await createSaslBouncerClient(
      account.account, account.password, { nick },
    );
    clients.push(primary.client);
    expect(await bouncerEnableHold(primary.client)).toBe(true);

    const alias = await createSaslBouncerClient(
      account.account, account.password,
      { nick: uniqueNick('kila') },
    );
    clients.push(alias.client);

    await new Promise(r => setTimeout(r, 800));

    const oper = await createOperClient();
    clients.push(oper);

    // Baseline.
    const before = await runCheck(oper, nick, 10_000);
    expect(before.primary).toBeDefined();
    expect(before.aliases.length).toBe(1);

    // KILL the primary.
    alias.client.clearRawBuffer();
    oper.send(`KILL ${nick} :test-kill`);
    // Wait for the KILL acknowledgement on the oper side (any error or
    // confirmation line settles the path).
    await oper.waitForLine(/\b(KILL|NOTICE|341|481)\b/, 5000);

    // Settle: KILL cascade + session destroy + BX X for alias.
    await new Promise(r => setTimeout(r, 1500));

    // The alias's socket should be terminated.  A PING/PONG round-trip
    // either fails outright or the socket reads EOF.
    let aliasStillResponsive = false;
    try {
      alias.client.send('PING :post-kill');
      await alias.client.waitForLine(/\bPONG\b.*post-kill/, 2000);
      aliasStillResponsive = true;
    } catch {
      // Expected — alias should have been terminated.
    }
    expect(aliasStillResponsive).toBe(false);

    // /CHECK -b on the nick should now report no-match (session gone).
    let stillFound = false;
    try {
      await runCheck(oper, nick, 5_000);
      stillFound = true;
    } catch (err) {
      // runCheck throws on ERR_SEARCHNOMATCH (292) — that's exactly
      // what we want here.
      const msg = err instanceof Error ? err.message : String(err);
      expect(msg).toMatch(/ERR_SEARCHNOMATCH|no-match|292/);
    }
    expect(stillFound).toBe(false);
  });
});
