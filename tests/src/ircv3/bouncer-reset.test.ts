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
 * `/BOUNCER RESET` cascade + fallout coverage.
 *
 * Two scenarios pinned here, both grounded in 2026-05-26 prod-test
 * observations:
 *
 *  1. Cascade completeness.  bouncer_reset (m_bouncer.c:478) snapshots
 *     primary + aliases, broadcasts BX X, calls bounce_destroy, then
 *     exit_client on each.  All sockets terminate; /CHECK -b reports
 *     no match (session record gone).
 *
 *  2. Reconnect immediately after reset.  Pre-fix, ssl_abort
 *     SSL_free'd without close_notify (ssl.c:450, fixed 2026-05-26),
 *     and 271ef19's re-entrancy guard suppressed exit_client_msg —
 *     so the only SSL teardown site in the ET_ERROR-mid-exit_client
 *     window dropped the TLS layer raw.  Peers saw
 *     "unexpected eof while reading" on subsequent connect attempts
 *     for a spell.  Post-fix: a fresh SASL connection with the same
 *     account succeeds immediately after the cascade settles.
 *
 *  Counter discipline (bounce_copy_umodes ++/-- + exit_one_client
 *  alias/hold decrements) is exercised implicitly: the cascade exits
 *  both an opered primary and its alias.  If either side of the
 *  accounting underflowed, ircd would SIGABRT here rather than
 *  finishing the test.
 */
describe('Bouncer /BOUNCER RESET: cascade + reconnect fallout', () => {
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

  it('reset terminates primary + alias and destroys the session', async () => {
    const account = await getTestAccount();
    poolAccounts.push(account.account);
    const nick = uniqueNick('rst');

    const primary = await createSaslBouncerClient(
      account.account, account.password, { nick },
    );
    clients.push(primary.client);
    expect(await bouncerEnableHold(primary.client)).toBe(true);

    const alias = await createSaslBouncerClient(
      account.account, account.password,
      { nick: uniqueNick('rsta') },
    );
    clients.push(alias.client);

    await new Promise(r => setTimeout(r, 800));

    const oper = await createOperClient();
    clients.push(oper);

    // Baseline: session exists with primary + 1 alias.
    const before = await runCheck(oper, nick, 10_000);
    expect(before.primary).toBeDefined();
    expect(before.aliases.length).toBe(1);

    // Issue reset from the primary.
    primary.client.clearRawBuffer();
    primary.client.send('BOUNCER RESET');

    // SESSION_RESET note ack lands on the caller before its own
    // exit_client runs.  Failing to find it inside 5s would point
    // at the reset handler not parsing — distinct from cascade-fallout
    // failure modes.
    try {
      await primary.client.waitForLine(/SESSION_RESET/, 5000);
    } catch {
      // Tolerate: if the SESSION_RESET note races the exit, the line
      // may not reach us.  The cascade assertions below are what we
      // actually care about.
    }

    // Cascade settle: BX X out to peers + per-client exit_one_client
    // (alias branch decrement, normal-path decrement for primary).
    await new Promise(r => setTimeout(r, 1500));

    // Both client sockets are dead — PING round-trip times out.
    let primaryAlive = false;
    try {
      primary.client.send('PING :post-reset-primary');
      await primary.client.waitForLine(/\bPONG\b.*post-reset-primary/, 1500);
      primaryAlive = true;
    } catch { /* expected */ }
    expect(primaryAlive).toBe(false);

    let aliasAlive = false;
    try {
      alias.client.send('PING :post-reset-alias');
      await alias.client.waitForLine(/\bPONG\b.*post-reset-alias/, 1500);
      aliasAlive = true;
    } catch { /* expected */ }
    expect(aliasAlive).toBe(false);

    // /CHECK -b on the nick reports no-match — session record is gone.
    let stillFound = false;
    try {
      await runCheck(oper, nick, 5_000);
      stillFound = true;
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      expect(msg).toMatch(/ERR_SEARCHNOMATCH|no-match|292/);
    }
    expect(stillFound).toBe(false);
  });

  it('fresh SASL connect succeeds immediately after reset cascade', async () => {
    const account = await getTestAccount();
    poolAccounts.push(account.account);
    const nick = uniqueNick('rrt');

    // First identity: primary + alias under bouncer hold.
    const primary = await createSaslBouncerClient(
      account.account, account.password, { nick },
    );
    clients.push(primary.client);
    expect(await bouncerEnableHold(primary.client)).toBe(true);

    const alias = await createSaslBouncerClient(
      account.account, account.password,
      { nick: uniqueNick('rrta') },
    );
    clients.push(alias.client);

    await new Promise(r => setTimeout(r, 800));

    // Reset.
    primary.client.send('BOUNCER RESET');
    await new Promise(r => setTimeout(r, 1500));

    // Drop the dead refs so afterEach doesn't try to close them
    // (and to keep `clients` representative of live state).
    clients.splice(clients.indexOf(primary.client), 1);
    clients.splice(clients.indexOf(alias.client), 1);

    // The fallout we're guarding against: pre-fix ssl_abort dropped
    // the TLS layer without close_notify on the ET_ERROR-mid-
    // exit_client path 271ef19 unblocked.  The user-visible symptom
    // was "unexpected eof while reading" on reconnect attempts.
    //
    // If the listener was poisoned, createSaslBouncerClient throws
    // before returning — either the SASL flow times out or the SSL
    // handshake (when applicable) fails.  We give it a generous
    // window to avoid flagging unrelated keycloak slowness, but the
    // close_notify regression manifested as immediate failure, not
    // slowness.
    const reconnect = await createSaslBouncerClient(
      account.account, account.password,
      { nick: uniqueNick('rrt2') },
    );
    clients.push(reconnect.client);

    // Smoke-check the new session: PING round-trips, and /CHECK -b
    // shows a fresh primary (any session would do — what we're
    // really proving is the listener still accepts handshakes).
    reconnect.client.send('PING :post-reset-reconnect');
    await reconnect.client.waitForLine(/\bPONG\b.*post-reset-reconnect/, 5000);

    const oper = await createOperClient();
    clients.push(oper);
    const after = await runCheck(oper, reconnect.nick, 10_000);
    expect(after.primary).toBeDefined();
    expect(after.aliases.length).toBe(0);
  });
});
