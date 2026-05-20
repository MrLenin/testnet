import { describe, it, expect, afterEach, beforeAll, afterAll } from 'vitest';
import {
  RawSocketClient,
  uniqueNick,
  getTestAccount,
  releaseTestAccount,
  createSaslBouncerClient,
  bouncerEnableHold,
  bouncerDisableHold,
  disconnectAbruptly,
  createOperClient,
} from '../helpers/index.js';
import { runCheck } from '../helpers/check-parser.js';

/**
 * Hold-expiry timer behaviour (race-survey #7 in
 * project_bouncer_race_scenarios_survey.md).
 *
 * When a bouncer session's hold timer fires, bounce_hold_expire takes
 * one of two paths:
 *   - No aliases: mark session BOUNCE_DESTROYING, exit ghost, free
 *     session record on the deferred ET_DESTROY tick.
 *   - With aliases: promote an alias to primary, exit ghost with
 *     BouncerInternalDestroy on the promote-succeeded path.
 *
 * Neither path is exercised by the rest of the bouncer test suite —
 * those drop hold (cleanly destroys, no timer involved) or
 * disconnect+revive within the default 4h hold window (timer never
 * fires).
 *
 * This file gates itself behind RUN_HOLD_EXPIRY_TESTS=1 because the
 * test mechanism is to SET FEAT_BOUNCER_SESSION_HOLD short network-
 * wide for the file's lifetime — concurrent bouncer tests that
 * abrupt-disconnect a primary and then revive will see fast expiry,
 * which is fine in isolation but can race against the post-suite
 * revive in poorly-timed parallel runs.
 *
 *   RUN_HOLD_EXPIRY_TESTS=1 IRC_HOST=localhost \
 *     npm test -- src/ircv3/bouncer-hold-expiry.test.ts
 */
const RUN = process.env.RUN_HOLD_EXPIRY_TESTS === '1';

/** Short hold window for the expiry path.  Must be >0 (feature is
 * an integer, 0 may be coerced to default) and short enough that
 * waiting for expiry doesn't bloat the test runtime.  */
const SHORT_HOLD_SECS = 2;
const DEFAULT_HOLD_SECS = 14400;

async function setHoldSeconds(oper: RawSocketClient, secs: number): Promise<void> {
  oper.send(`SET BOUNCER_SESSION_HOLD ${secs}`);
  await new Promise(r => setTimeout(r, 300));
}

(RUN ? describe : describe.skip)(
  'Bouncer hold-expiry timer (race-survey #7)',
  () => {
    const clients: RawSocketClient[] = [];
    const poolAccounts: string[] = [];
    let oper: RawSocketClient | null = null;

    beforeAll(async () => {
      oper = await createOperClient();
      await setHoldSeconds(oper, SHORT_HOLD_SECS);
    }, 30_000);

    afterAll(async () => {
      if (oper) {
        try { await setHoldSeconds(oper, DEFAULT_HOLD_SECS); } catch { /* */ }
        try { oper.send('QUIT'); } catch { /* */ }
        try { oper.close(); } catch { /* */ }
        oper = null;
      }
    });

    afterEach(async () => {
      for (const c of clients) {
        try { await bouncerDisableHold(c); } catch { /* */ }
        try { c.close(); } catch { /* */ }
      }
      clients.length = 0;
      for (const a of poolAccounts) releaseTestAccount(a);
      poolAccounts.length = 0;
    });

    it('no-alias path: session destroyed when hold timer fires', async () => {
      const { account, password, fromPool } = await getTestAccount();
      if (fromPool) poolAccounts.push(account);
      const nick = uniqueNick('hexp');

      const { client } = await createSaslBouncerClient(account, password, { nick });
      clients.push(client);
      expect(await bouncerEnableHold(client)).toBe(true);

      // Baseline: session exists per /CHECK.
      const before = await runCheck(oper!, nick, 10_000);
      expect(before.primary).toBeDefined();
      expect(before.primary?.sessid).toMatch(/^AZ[A-Za-z0-9]+/);

      // Abrupt drop → HOLDING; hold timer armed at SHORT_HOLD_SECS.
      disconnectAbruptly(client);
      const idx = clients.indexOf(client);
      if (idx >= 0) clients.splice(idx, 1);

      // Wait past the hold deadline + ET_DESTROY tick + propagation
      // (the bouncer_session.c expiry path frees the record on a
      // deferred ET_DESTROY callback, not on ET_EXPIRE itself).
      await new Promise(r => setTimeout(r, (SHORT_HOLD_SECS + 2) * 1000));

      // /CHECK should now report no-match — session destroyed.
      let stillFound = false;
      try {
        await runCheck(oper!, nick, 5_000);
        stillFound = true;
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        expect(msg).toMatch(/ERR_SEARCHNOMATCH|no-match|292/);
      }
      expect(stillFound,
        `after ${SHORT_HOLD_SECS}s + grace, session for ${nick} must be ` +
        `destroyed by bounce_hold_expire's no-alias path`,
      ).toBe(false);
    }, 60_000);

    it('with-alias path: alias promoted, ghost exits when hold timer fires', async () => {
      const { account, password, fromPool } = await getTestAccount();
      if (fromPool) poolAccounts.push(account);
      const primaryNick = uniqueNick('hexp');
      const aliasNick = uniqueNick('hexa');

      const primary = await createSaslBouncerClient(account, password,
        { nick: primaryNick });
      clients.push(primary.client);
      expect(await bouncerEnableHold(primary.client)).toBe(true);

      const alias = await createSaslBouncerClient(account, password,
        { nick: aliasNick });
      clients.push(alias.client);
      // Give the alias attach + BX C broadcast time to settle.
      await new Promise(r => setTimeout(r, 800));

      // Baseline: primary + 1 alias.  Capture numerics so we can
      // assert post-promote BX P numeric swap (new primary's numeric
      // == old alias's numeric).
      const before = await runCheck(oper!, primaryNick, 10_000);
      expect(before.primary).toBeDefined();
      expect(before.aliases.length,
        'baseline: primary should have exactly one alias').toBe(1);
      const sessidBefore = before.primary!.sessid;
      const aliasNumericBefore = before.aliases[0].numeric;

      // Drop the primary; the alias remains.  Hold timer arms for the
      // primary's ghost; expiry will fire bounce_promote_alias because
      // hs_alias_count > 0.
      disconnectAbruptly(primary.client);
      const idx = clients.indexOf(primary.client);
      if (idx >= 0) clients.splice(idx, 1);

      await new Promise(r => setTimeout(r, (SHORT_HOLD_SECS + 2) * 1000));

      // The surviving alias's TCP socket must still be alive.  This is
      // the most important assertion — invariant #12 says aliases
      // don't get terminated on session lifecycle events other than
      // explicit KILL or session destroy.
      alias.client.send('PING :post-expiry');
      await alias.client.waitForLine(/\bPONG\b.*post-expiry/, 5000);

      // bounce_promote_alias renames the alias to the primary's nick
      // (see project_alias_nick_echo_gap.md — the lockstep fix sends
      // a NICK echo to the alias socket so the client knows its new
      // nick).  /CHECK the PRIMARY's nick to find the now-promoted
      // session.
      const after = await runCheck(oper!, primaryNick, 10_000);
      expect(after.primary,
        'after hold-expiry + promote, the session should be reachable ' +
        'under the primary\'s nick (the promoted alias takes that nick)',
      ).toBeDefined();
      expect(after.primary?.sessid,
        `sessid continuity through hold-expiry promote: expected ` +
        `${sessidBefore}, got ${after.primary?.sessid}`,
      ).toBe(sessidBefore);
      // BX P numeric-swap: the new primary's numeric is the OLD
      // alias's numeric — same shape as the clean-QUIT immediate
      // promote (bouncer-alias-promote.test.ts), just driven by the
      // hold-expiry timer instead.
      expect(after.primary?.numeric,
        `numeric swap: post-promote primary numeric should equal ` +
        `pre-promote alias numeric (${aliasNumericBefore})`,
      ).toBe(aliasNumericBefore);
      // No aliases remain — the one alias just became primary.
      expect(after.aliases.length,
        'after promote, no aliases remain (the only alias was promoted)',
      ).toBe(0);
    }, 60_000);
  }
);
