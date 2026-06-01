/**
 * Verifies do_shun (the retroactive shun-apply loop run at SHUN add time)
 * does not spuriously match clients whose username doesn't match the
 * shun's specific ident.
 *
 * Background:
 *
 *   - Upstream evilnet/nefarious2 has a 7-year-old regression at
 *     ircd/shun.c:221-223 introduced in commit f3179734 (2019).  The
 *     guard `if (*(cli_user(acptr)->username) && match(...) != 0)
 *     continue` was added to skip match() on an empty username, but it
 *     also short-circuits the WHOLE check when username is empty —
 *     meaning the ident match is bypassed entirely for clients
 *     mid-registration (cli_user allocated but USER not yet processed).
 *     For a shun like `dreamsreal@*`, the wildcard host then matches
 *     any IP, the wrong client matches, and the server emits a
 *     `SNO_GLINE` "Shun active for <victim>" notice to opers — wrongly
 *     attributing the shun to a user whose ident doesn't match.
 *
 *   - The fix unifies do_shun and shun_lookup against a single
 *     shun_matches() helper that defers (returns no-match) when the
 *     shun has a specific ident and the client's username is unknown.
 *
 * What we observe:
 *
 *   - `FEAT_HIS_SHUN_REASON` defaults TRUE, so the *victim* never sees
 *     the `:You are shunned:` NOTICE.  The user-facing manifestation
 *     of the bug is therefore the SNO_GLINE oper notice on the oper's
 *     side, which is unconditional in shun.c (no HIS_SHUN_REASON
 *     gating).  We check the oper's received-lines buffer for the
 *     `*** Notice -- Shun active for <victim>` line.
 *
 * Test asserts:
 *   1. Pre-USER false-positive — a client with NICK sent but USER held
 *      does not appear in any "Shun active for" oper notice when a
 *      shun is added for a different ident@*.
 *   2. Post-registration with non-matching ident — fully registered
 *      client does not appear in any "Shun active for" oper notice.
 *   3. Positive — fully registered client with matching ident DOES
 *      appear in a "Shun active for" oper notice (sanity-check that
 *      do_shun's matching path still fires for the right clients).
 */

import { describe, it, expect, afterEach } from 'vitest';
import {
  createRawSocketClient,
  createOperClient,
  RawSocketClient,
  X3Client,
} from '../helpers/index.js';
import { uniqueNick } from '../helpers/cap-bundles.js';

describe('Shun ident matching at add-time (do_shun)', () => {
  type TrackedClient = RawSocketClient | X3Client;
  const tracked: TrackedClient[] = [];
  function track<T extends TrackedClient>(c: T): T { tracked.push(c); return c; }

  afterEach(async () => {
    for (const c of tracked.splice(0)) {
      try { (c as { close?: () => void }).close?.(); } catch { /* ignore */ }
    }
  });

  async function addShun(oper: X3Client, mask: string, duration: string, reason: string): Promise<string[]> {
    return await (oper as unknown as {
      serviceCmd(svc: string, cmd: string, timeout?: number): Promise<string[]>;
    }).serviceCmd('O3', `SHUN ${mask} ${duration} ${reason}`, 5000);
  }

  async function unshun(oper: X3Client, mask: string): Promise<void> {
    try {
      await (oper as unknown as {
        serviceCmd(svc: string, cmd: string, timeout?: number): Promise<string[]>;
      }).serviceCmd('O3', `UNSHUN ${mask}`, 5000);
    } catch { /* best-effort cleanup */ }
  }

  /** Drive a raw socket through full registration with explicit ident control. */
  async function registerVictim(nick: string, username: string): Promise<RawSocketClient> {
    const c = track(await createRawSocketClient());
    c.send(`NICK ${nick}`);
    c.send(`USER ${username} 0 * :Shun Test`);
    await c.waitForLine(/ 001 /, 5000);
    return c;
  }

  /**
   * Did the oper receive a SNO_GLINE "Shun active for <name>" notice
   * naming the given victim nick during the window?  The oper is an
   * X3Client which inherits RawSocketClient's `allLines` accessor.
   */
  function operSawShunActiveFor(oper: X3Client, victimNick: string): string | undefined {
    const re = new RegExp(`Shun active for ${victimNick}`, 'i');
    return (oper as unknown as { allLines: string[] }).allLines.find(l => re.test(l));
  }

  it('does NOT emit "Shun active for" for a mid-registration client (NICK sent, USER held)', async () => {
    const oper = track(await createOperClient());
    const victimNick = uniqueNick('preuser');

    // Raw socket — NICK only, USER deliberately held back so cli_user
    // is allocated but username is still empty.
    const victim = track(await createRawSocketClient());
    victim.send(`NICK ${victimNick}`);
    await new Promise(r => setTimeout(r, 500));

    // Ident must fit in USERLEN (10 chars) — the IRCd silently truncates
    // longer usernames, which would make our shun mask not actually match
    // what's stored on the client.
    const shunIdent = `n${uniqueNick('').slice(0, 5).toLowerCase()}`;
    const shunMask = `${shunIdent}@*`;

    try {
      await addShun(oper, shunMask, '5m', 'pre-user defer test');
      await new Promise(r => setTimeout(r, 1500));
      expect(
        operSawShunActiveFor(oper, victimNick),
        `Pre-USER client ${victimNick} must not appear in a "Shun active for" oper notice when ${shunMask} is added`,
      ).toBeUndefined();
    } finally {
      await unshun(oper, shunMask);
    }
  }, 30_000);

  it('does NOT emit "Shun active for" for a fully-registered client whose ident does not match', async () => {
    const oper = track(await createOperClient());

    // Idents must fit USERLEN (10 chars) — see test 1 note.
    const victimIdent = `i${uniqueNick('').slice(0, 5).toLowerCase()}`;
    const victimNick = uniqueNick('inn');
    await registerVictim(victimNick, victimIdent);

    const shunIdent = `t${uniqueNick('').slice(0, 5).toLowerCase()}`;
    const shunMask = `${shunIdent}@*`;

    try {
      await addShun(oper, shunMask, '5m', 'non-matching-ident test');
      await new Promise(r => setTimeout(r, 1500));
      expect(
        operSawShunActiveFor(oper, victimNick),
        `Registered client ${victimNick} (ident ${victimIdent}) must not appear in a "Shun active for" oper notice when ${shunMask} is added`,
      ).toBeUndefined();
    } finally {
      await unshun(oper, shunMask);
    }
  }, 30_000);

  it('DOES emit "Shun active for" for a registered client whose ident matches (sanity check)', async () => {
    const oper = track(await createOperClient());

    // Ident must fit USERLEN (10 chars) — see test 1 note.
    const targetIdent = `t${uniqueNick('').slice(0, 5).toLowerCase()}`;
    const victimNick = uniqueNick('match');
    await registerVictim(victimNick, targetIdent);

    // Give register_user a comfortable margin to finish wiring up
    // cli_user->username — do_shun reads it directly and we've seen
    // races where the SHUN arrives back from O3 inside the same
    // millisecond as RPL_WELCOME on the victim's socket.
    await new Promise(r => setTimeout(r, 1000));

    const shunMask = `${targetIdent}@*`;

    try {
      await addShun(oper, shunMask, '5m', 'positive sanity test');
      await new Promise(r => setTimeout(r, 1500));
      expect(
        operSawShunActiveFor(oper, victimNick),
        `Registered client ${victimNick} (ident ${targetIdent}) must appear in a "Shun active for" oper notice when ${shunMask} is added`,
      ).toBeDefined();
    } finally {
      await unshun(oper, shunMask);
    }
  }, 30_000);

  /**
   * Non-bare-star mask edge cases per Rubin's review:
   *
   *   - `*foo` is "ends with foo" — NOT match-everything.
   *   - `?bob` is "any single char then bob" — NOT match-everything.
   *
   * Both must defer pre-USER (the naive `sh_user[0] != '*'` check
   * would let the first through; the correct "literal bare * only"
   * shortcut must not).
   *
   * The complementary "DOES still apply for literal `*@host`" case
   * (Jobe's original intent) can't be cleanly tested in this docker
   * topology because the oper and the pre-USER victim share the
   * 172.29.0.1 bridge IP — a `*@172.29.0.1` shun would silence the
   * oper too, breaking the cleanup phase.  Verified instead by
   * inspection: the code at shun.c only exempts
   * `sh_user[0] == '*' && sh_user[1] == '\0'`, and tests below
   * confirm anything that doesn't match that exact shape defers.
   */

  it('does NOT emit "Shun active for" for a pre-USER client when the shun ident starts with * but is not bare (e.g. *foo@*)', async () => {
    const oper = track(await createOperClient());
    const victimNick = uniqueNick('preusst');

    const victim = track(await createRawSocketClient());
    victim.send(`NICK ${victimNick}`);
    await new Promise(r => setTimeout(r, 500));

    // `*foo` is "ends with foo" — NOT match-everything.  Pre-USER
    // client must be deferred even though the mask leads with `*`.
    const shunIdent = `*f${uniqueNick('').slice(0, 4).toLowerCase()}`;
    const shunMask = `${shunIdent}@*`;

    try {
      await addShun(oper, shunMask, '5m', 'star-prefix non-bare test');
      await new Promise(r => setTimeout(r, 1500));
      expect(
        operSawShunActiveFor(oper, victimNick),
        `Pre-USER client ${victimNick} must not be matched when shun ident ${shunIdent} starts with * but is not bare (it is "ends with ${shunIdent.slice(1)}")`,
      ).toBeUndefined();
    } finally {
      await unshun(oper, shunMask);
    }
  }, 30_000);

  it('does NOT emit "Shun active for" for a pre-USER client when the shun ident uses a single-char wildcard (?bob@*)', async () => {
    const oper = track(await createOperClient());
    const victimNick = uniqueNick('preuqm');

    const victim = track(await createRawSocketClient());
    victim.send(`NICK ${victimNick}`);
    await new Promise(r => setTimeout(r, 500));

    // `?bob` is "any single char then bob" — NOT match-everything.
    // The naive `sh_user[0] != '*'` check would let this through;
    // the correct "bare * shortcut only" check must not.
    const shunIdent = `?b${uniqueNick('').slice(0, 4).toLowerCase()}`;
    const shunMask = `${shunIdent}@*`;

    try {
      await addShun(oper, shunMask, '5m', 'single-char wildcard ident test');
      await new Promise(r => setTimeout(r, 1500));
      expect(
        operSawShunActiveFor(oper, victimNick),
        `Pre-USER client ${victimNick} must not be matched when shun ident ${shunIdent} uses single-char wildcard (the bare-* shortcut must not apply here)`,
      ).toBeUndefined();
    } finally {
      await unshun(oper, shunMask);
    }
  }, 30_000);
});
