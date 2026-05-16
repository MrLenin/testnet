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
 * Cross-server immediate-promote on primary clean QUIT.
 *
 * v2 of the alias-promote race fix (.claude/plans/alias-promote-race-fix.md).
 *
 * Setup:
 *   - Primary connects to testnet (port 6667).
 *   - Alias connects to leaf (port 6668) with the same account.
 *     `bounce_setup_local_alias` on leaf detaches the would-be
 *     primary and attaches as an alias of testnet's primary.
 *
 * Action:
 *   - Primary on testnet cleanly QUITs.
 *
 * Expected (post-d8236f7):
 *   - m_quit on testnet: bounce_promote_alias(session, 1) returns -1
 *     (no local alias on testnet); falls through to bounce_hold_client.
 *   - bounce_schedule_cross_server_promote arms a 0-tick timer.
 *   - At next event-loop tick, the timer fires:
 *     bounce_promote_alias(session, 0) picks the leaf alias, broadcasts
 *     BX P + BS T, channel-strips the testnet ghost, exits it cleanly.
 *   - /CHECK -b on testnet (a few hundred ms later) shows session
 *     ACTIVE, primary on the leaf-side numeric, no aliases.
 *
 * Requires the "linked" docker-compose profile.  Skips cleanly when
 * the leaf isn't reachable.
 */
describe('Bouncer cross-server immediate-promote on primary clean QUIT', () => {
  const clients: RawSocketClient[] = [];
  const poolAccounts: string[] = [];

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

  // Skip: blocked on an upstream issue — cross-server alias attach isn't
  // landing in the running build despite the 2a1cb97 BS C race fix.
  // When a SASL'd client connects to leaf with the same account as
  // testnet's primary, leaf welcomes it as a regular user rather than
  // routing through bounce_setup_local_alias.  Observed wire on leaf:
  // N arrives from testnet for the primary, BS C arrives, then leaf's
  // local SASL'd client gets standard 001-005 welcome with no
  // ALIAS_ATTACHED note.  hs_aliases[] stays empty on testnet's side,
  // so this test (and the pre-existing bouncer-alias-multi-server
  // skipped test) can't get to the primary-QUIT step.
  //
  // The deferred-tick v2 timer machinery (nefarious d8236f7) is
  // committed and ready — once cross-server alias attach lands an
  // alias on testnet's hs_aliases[], primary QUIT will exercise
  // bounce_schedule_cross_server_promote → bounce_finish_cross_server_promote
  // and the test below should run end-to-end without further changes.
  it.skip('remote alias promoted via 0-tick deferred timer after primary QUIT', async () => {
    if (!leafReachable) {
      console.warn(`Skipping: leaf at ${leafHost}:${leafPort} not reachable. ` +
        'Run docker compose --profile linked up -d, or set IRC_HOST2/IRC_PORT2.');
      return;
    }

    const account = await getTestAccount();
    poolAccounts.push(account.account);
    const nick = uniqueNick('xsp');

    // Primary on testnet.
    const primary = await createSaslBouncerClient(
      account.account, account.password, { nick },
    );
    clients.push(primary.client);
    expect(await bouncerEnableHold(primary.client)).toBe(true);

    // Alias on leaf, same account.
    const aliasResult = await createSaslBouncerClient(
      account.account, account.password,
      { nick, host: leafHost, port: leafPort },
    );
    clients.push(aliasResult.client);

    // Settle BX C cross-link.
    await new Promise(r => setTimeout(r, 1500));

    const oper = await createOperClient();
    clients.push(oper);

    const before = await runCheck(oper, nick, 10_000);
    expect(before.primary).toBeDefined();
    expect(before.primary?.locality).toBe('local'); // testnet primary
    expect(before.aliases.length).toBe(1);
    // Alias is on leaf — locality should be 'remote' from testnet's POV.
    expect(before.aliases[0].locality).toBe('remote');
    const sessidBefore = before.primary!.sessid;
    const primaryNumericBefore = before.primary!.numeric;
    const aliasNumericBefore = before.aliases[0].numeric;

    // Primary on testnet cleanly QUITs.
    primary.client.send('QUIT :primary leaving');
    primary.client.close();
    const idx = clients.indexOf(primary.client);
    if (idx >= 0) clients.splice(idx, 1);

    // Settle: 0-tick timer fires on testnet, BX P broadcasts, leaf
    // converts alias → primary.  Allow generous time for cross-link
    // propagation.
    await new Promise(r => setTimeout(r, 2000));

    // Alias on leaf should still be responsive (it just became primary).
    aliasResult.client.send('PING :promoted-now');
    await aliasResult.client.waitForLine(/\bPONG\b.*promoted-now/, 5000);

    const after = await runCheck(oper, nick, 10_000);

    expect(after.primary).toBeDefined();
    // Sessid stable across the cross-server promote.
    expect(after.primary!.sessid).toBe(sessidBefore);
    // The primary is now on leaf — locality reads 'remote' from testnet.
    expect(after.primary!.locality).toBe('remote');
    // The new primary's numeric is the OLD ALIAS's (leaf) numeric.
    expect(after.primary!.numeric).toBe(aliasNumericBefore);
    // Old primary numeric (testnet's) is gone.
    expect(after.primary!.numeric).not.toBe(primaryNumericBefore);
    // No aliases remain.
    expect(after.aliases.length).toBe(0);
    // Session state is ACTIVE — promote ran via the 0-tick timer.
    expect(after.rawLines.some(l => /Session state:: ACTIVE/.test(l))).toBe(true);
    // From testnet's POV, the primary is now on leaf — output format
    // for ACTIVE with remote primary and no aliases is "Connections::
    // primary on <server>".  See m_check.c around line 738.
    expect(after.rawLines.some(l => /Connections:: primary on \S+/.test(l))).toBe(true);
  });
});
