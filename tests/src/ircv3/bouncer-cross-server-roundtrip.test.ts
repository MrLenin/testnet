import { describe, it, expect, afterEach } from 'vitest';
import {
  RawSocketClient,
  getTestAccount,
  releaseTestAccount,
  createBouncerClient,
  createSaslBouncerClient,
  bouncerInfo,
  bouncerDisableHold,
  disconnectAbruptly,
  PRIMARY_SERVER,
  SECONDARY_SERVER,
  uniqueNick,
} from '../helpers/index.js';

/**
 * Regression sentinel for the 2026-05-19 BS A / BS D handler bug
 * (commit 514ae39): cross-server bouncer S2S handlers in
 * `bouncer_session.c` were constructing the full P10 numeric for the
 * peer-side client via `session->hs_origin + parv[4]` instead of
 * `cli_yxx(sptr) + parv[4]`.
 *
 * `hs_origin` is recorded at session-create time and is intentionally
 * preserved across cross-server rebind (it remains historical context,
 * not a live owner field).  After a rebind, the session lives on a new
 * server but its `hs_origin` still points at the original server's
 * prefix, so building a numeric from `hs_origin + suffix` resolves to
 * a stranger client (whoever happens to occupy that suffix on the old
 * server) and poisons `session->hs_client`.
 *
 * In the production incident the misresolved numeric pointed at a held
 * ghost belonging to a different account; the user's later reconnect
 * triggered `bounce_revive` against the poisoned `hs_client`, which
 * transplanted the user's socket onto the wrong ghost (different nick,
 * different channels).
 *
 * This test stresses the BS A code path on BOTH servers by doing a
 * round-trip rebind (PRIMARY → SECONDARY → PRIMARY).  Each cross-server
 * hop triggers a BS A emission on the new owner and BS A handling on
 * the peer.  We don't try to engineer the exact suffix collision that
 * caused the observed corruption (suffix assignment is server-local
 * and racy with other test traffic), so this is a sentinel rather than
 * a deterministic reproducer: it exercises the code path repeatedly
 * and asserts continuity of the session record.
 *
 * Pre-fix expectation: at least one of the rebinds corrupts
 * `session->hs_client` (deterministically when suffix collides,
 * probabilistically otherwise) — observable as a sessid change, a
 * dropped session, or a nick mismatch on the round-trip.
 *
 * Post-fix expectation: sessid + nick survive the full round-trip,
 * and BOUNCER INFO reports an active session at each step.
 */
const linkedAvailable = process.env.IRC_HOST2 || PRIMARY_SERVER.host === 'localhost';

describe.skipIf(!linkedAvailable)('bouncer cross-server rebind round-trip (BS A handler integrity)', () => {
  const clients: RawSocketClient[] = [];
  const poolAccounts: string[] = [];

  const track = (c: RawSocketClient): RawSocketClient => {
    clients.push(c);
    return c;
  };

  afterEach(async () => {
    for (const c of clients) {
      try { c.close(); } catch { /* ignore */ }
    }
    clients.length = 0;
    for (const acc of poolAccounts) {
      releaseTestAccount(acc);
    }
    poolAccounts.length = 0;
  });

  it('preserves session continuity across PRIMARY → SECONDARY → PRIMARY rebind', async () => {
    const account = await getTestAccount();
    if (account.fromPool) poolAccounts.push(account.account);
    const nick = uniqueNick('roundtrip');

    // Phase 1: Establish session on PRIMARY.  If the pool account had
    // a leftover held session from a prior test, first.nick will be
    // the surviving ghost's nick (not our requested `nick`).  That's
    // fine — we anchor subsequent assertions to first.nick, which is
    // the canonical identity for the rest of this test.
    const first = await createBouncerClient(account.account, account.password, {
      nick,
      host: PRIMARY_SERVER.host,
      port: PRIMARY_SERVER.port,
    });
    track(first.client);

    const firstInfo = await bouncerInfo(first.client);
    expect(firstInfo, 'BOUNCER INFO on PRIMARY').toBeTruthy();
    expect(firstInfo!.state).toBe('active');
    const sessid = firstInfo!.sessionId;
    const anchoredNick = first.nick;
    expect(sessid, 'first session must have a sessid').toBeTruthy();

    // Phase 2: Drop → held ghost on PRIMARY.
    disconnectAbruptly(first.client);
    await new Promise(r => setTimeout(r, 1500));

    // Phase 3: Reconnect on SECONDARY (first rebind: PRIMARY → SECONDARY).
    // SECONDARY emits BS A; PRIMARY handles it.  Pre-fix on PRIMARY: any
    // suffix-collision corrupts `session->hs_client`.
    const second = await createSaslBouncerClient(account.account, account.password, {
      nick,
      host: SECONDARY_SERVER.host,
      port: SECONDARY_SERVER.port,
    });
    track(second.client);
    await new Promise(r => setTimeout(r, 1500));

    const secondInfo = await bouncerInfo(second.client);
    expect(secondInfo, 'BOUNCER INFO on SECONDARY after first rebind').toBeTruthy();
    expect(secondInfo!.state, 'session must remain active after PRIMARY → SECONDARY').toBe('active');
    expect(
      secondInfo!.sessionId,
      `sessid continuity (PRIMARY → SECONDARY): expected ${sessid}, got ${secondInfo!.sessionId}`,
    ).toBe(sessid);

    // Phase 4: Drop SECONDARY → held ghost on SECONDARY.
    disconnectAbruptly(second.client);
    await new Promise(r => setTimeout(r, 1500));

    // Phase 5: Reconnect on PRIMARY (reverse rebind: SECONDARY → PRIMARY).
    // PRIMARY emits BS A; SECONDARY handles it.  This exercises the
    // sibling code path — the bug was symmetric across BS A / BS D on
    // either server.
    const third = await createSaslBouncerClient(account.account, account.password, {
      nick,
      host: PRIMARY_SERVER.host,
      port: PRIMARY_SERVER.port,
    });
    track(third.client);
    await new Promise(r => setTimeout(r, 1500));

    const thirdInfo = await bouncerInfo(third.client);
    expect(thirdInfo, 'BOUNCER INFO on PRIMARY after reverse rebind').toBeTruthy();
    expect(thirdInfo!.state, 'session must remain active after SECONDARY → PRIMARY').toBe('active');
    expect(
      thirdInfo!.sessionId,
      `sessid continuity (SECONDARY → PRIMARY): expected ${sessid}, got ${thirdInfo!.sessionId}`,
    ).toBe(sessid);

    // Nick continuity: if BS A poisoned hs_client mid-rebind, the
    // subsequent revive would have transplanted onto a wrong ghost,
    // producing a different nick (the ghost's original owner).
    // BouncerClientResult.nick reflects the actual post-registration
    // nick as read from the 001 line, which is the ghost's nick on a
    // revive.  Post-fix: round-trip preserves the anchor identity.
    expect(
      third.nick,
      `nick continuity across round-trip: expected ${anchoredNick}, got ${third.nick}`,
    ).toBe(anchoredNick);

    await bouncerDisableHold(third.client);
  });
});
