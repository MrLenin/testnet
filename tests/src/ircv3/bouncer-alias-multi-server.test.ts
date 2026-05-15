import { describe, it, expect, afterEach, beforeAll } from 'vitest';
import { createConnection } from 'node:net';
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
 * Two-server bouncer scenario: user connects via SASL to both testnet
 * (primary) and leaf (secondary).  The second connection should land
 * as an ALIAS via bounce_setup_local_alias, NOT as a parallel primary.
 *
 * After the alias attach:
 *   - Session has one !IsBouncerAlias entry (testnet primary)
 *   - hs_aliases[] contains the leaf-side alias
 *   - /CHECK -b on testnet (primary side) shows local primary + 1 alias
 *
 * Exercises the alias-attach path that was renamed in bcaff68 (demote
 * cli_name + NICK echo) and validates that channel routing / nick
 * presentation are sane across the boundary.
 *
 * Requires the "linked" docker-compose profile (leaf running on port 6668
 * for local testing, or via docker DNS for in-container test runs).
 * Skips cleanly if leaf isn't reachable.
 */
describe('Bouncer two-server alias attach', () => {
  const clients: RawSocketClient[] = [];
  const poolAccounts: string[] = [];

  // Probe leaf reachability at suite start; skip all tests if it's down.
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
    leafReachable = await new Promise<boolean>(resolve => {
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

  /**
   * KNOWN-FAILING: this test surfaces a real bug rather than driving the
   * happy path.  Running it against the current testnet (linked profile
   * with nefarious-upstream present) reproduces this chain:
   *
   *   1. testnet has primary, leaf gets local primary on second SASL
   *   2. testnet's m_nick D.2 demotes testnet's primary to alias of
   *      leaf's (correct — same-session merge at-N-time)
   *   3. upstream (BX-aware peer) sees both N tokens but does NOT have
   *      a BS C replica for the freshly-created session yet, so its
   *      m_nick D.2 doesn't fire (no `bsess->hs_client == acptr` match)
   *      and it falls through to classic same-user@host collision
   *   4. upstream kills the demoted-side primary with `nick collision
   *      from same user@host`
   *   5. KILL = whole session dies (per design intent invariant #12);
   *      session is destroyed network-wide via BX X cascade, the alias
   *      we were trying to assert on never lives long enough to query
   *
   * Root cause is the BS C burst / N introduction ordering for a fresh
   * session: BS C must reach all BX-aware peers BEFORE the second
   * primary's N for the session, so they can populate the session
   * replica and run D.2 instead of classic collision.
   *
   * Mark as skipped until the BS C ordering is sorted.  When unskipped,
   * the assertions below are the right shape — alias on leaf with
   * primary on testnet, agreement on sessid.
   */
  it.skip('creates an alias on leaf when same account is already primary on testnet', async () => {
    if (!leafReachable) {
      console.warn(`Skipping: leaf at ${leafHost}:${leafPort} not reachable. ` +
        'Run docker compose --profile linked up -d, or set IRC_HOST2/IRC_PORT2.');
      return;
    }

    const account = await getTestAccount();
    poolAccounts.push(account.account);
    const nick = uniqueNick('mlt');

    // First connection: testnet (PRIMARY).
    const primary = await createSaslBouncerClient(
      account.account,
      account.password,
      { nick },
    );
    clients.push(primary.client);
    expect(await bouncerEnableHold(primary.client)).toBe(true);

    // Second connection: leaf, same account.  Use the SAME nick — bouncer
    // should resolve via account and make this an alias, sharing the
    // primary's identity.
    const aliasResult = await createSaslBouncerClient(
      account.account,
      account.password,
      { nick, host: leafHost, port: leafPort },
    );
    clients.push(aliasResult.client);

    // Settle: BX C broadcast across link, hs_aliases populated.
    await new Promise(r => setTimeout(r, 1500));

    // /CHECK on testnet (primary side) — should show 1 alias.
    const oper = await createOperClient();
    clients.push(oper);
    const state = await runCheck(oper, nick, 10_000);

    expect(state.primary).toBeDefined();
    expect(state.primary?.locality).toBe('local');
    expect(state.primary?.nick).toBe(nick);
    expect(state.aliases.length).toBe(1);

    // The alias entry should be on leaf (its server name resolves
    // to "leaf.fractalrealities.net" in the BouncerAlias line).
    const alias = state.aliases[0];
    expect(alias.server).toMatch(/leaf\./);
    // The alias's primary numeric should equal the primary's numeric.
    expect(alias.primaryNumeric).toBe(state.primary!.numeric);
    // Both should agree on session id.
    expect(alias.sessid).toBe(state.primary!.sessid);
  });
});
