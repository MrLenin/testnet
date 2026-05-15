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
 * Bouncer hold ON/OFF lifecycle validation via /CHECK -b.
 *
 * The existing bouncer.test.ts covers the BOUNCER SET HOLD on/off
 * commands' immediate responses (NOTE BOUNCER SETTINGS_UPDATED etc.).
 * These scenarios cross-check the resulting bouncer state from /CHECK -b.
 */
describe('Bouncer hold lifecycle', () => {
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

  it('BOUNCER SET HOLD off removes session — /CHECK -b returns no-match', async () => {
    const account = await getTestAccount();
    poolAccounts.push(account.account);
    const nick = uniqueNick('lif');

    const { client } = await createSaslBouncerClient(
      account.account, account.password, { nick },
    );
    clients.push(client);

    expect(await bouncerEnableHold(client)).toBe(true);

    const oper = await createOperClient();
    clients.push(oper);

    // Before HOLD off: session exists, BouncerPrimary present.
    const before = await runCheck(oper, nick, 10_000);
    expect(before.primary).toBeDefined();
    expect(before.primary?.sessid).toMatch(/^AZ[A-Za-z0-9]+/);

    // Disable hold → session destroyed.
    expect(await bouncerDisableHold(client)).toBe(true);
    // Settle for destroy + hRem from any bouncer-specific state.
    await new Promise(r => setTimeout(r, 500));

    // After HOLD off: client is now a regular non-bouncer user.  The
    // user struct still exists (they're connected), but they no longer
    // have a bouncer session.  /CHECK -b should not report a
    // BouncerPrimary line (the Bouncer Session block is skipped when
    // bounce_get_session returns NULL).
    const after = await runCheck(oper, nick, 10_000);
    expect(after.primary).toBeUndefined();
  });

  it('repeated HOLD on → off → on cycles preserve the same sessid', async () => {
    // Documents the intentional session-identity continuity at
    // bounce_create (bouncer_session.c:1135-1143): when a client toggles
    // HOLD off then on, the new session adopts the client's existing
    // cli_session_id rather than minting a fresh one.  This anchors the
    // chathistory replay / read-marker view to the same logical session
    // across the toggle.
    //
    // Regression test: if a future change makes sessid fresh-each-cycle,
    // session-anchored state (chathistory presence windows, etc.) would
    // silently break.
    const account = await getTestAccount();
    poolAccounts.push(account.account);
    const nick = uniqueNick('cyc');

    const { client } = await createSaslBouncerClient(
      account.account, account.password, { nick },
    );
    clients.push(client);

    const oper = await createOperClient();
    clients.push(oper);

    const sessids: string[] = [];

    for (let i = 0; i < 3; i++) {
      expect(await bouncerEnableHold(client)).toBe(true);
      await new Promise(r => setTimeout(r, 300));

      const state = await runCheck(oper, nick, 10_000);
      expect(state.primary?.sessid).toMatch(/^AZ[A-Za-z0-9]+/);
      sessids.push(state.primary!.sessid);

      expect(await bouncerDisableHold(client)).toBe(true);
      await new Promise(r => setTimeout(r, 300));
    }

    // All cycles should yield the same sessid — identity-continuous.
    expect(new Set(sessids).size).toBe(1);
  });
});
