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
 * Pins the bouncer-rebind auth-gate fix from
 * `.claude/para/projects/bouncer-burst-rebind-sessid-gap.md` (Option B).
 *
 * Pre-fix: when a held bouncer ghost exists on PRIMARY for an account,
 * and a new SASL'd client for that account connects to SECONDARY, the
 * burst-time N forwarded from SECONDARY to PRIMARY lacks a `,S<sessid>`
 * compact tag (only relays preserve it; originating bursts don't add
 * one).  `bounce_rebind_ghost_to_remote_primary`'s auth gate then sees
 * neither origin_match nor sessid_match, refuses the rebind, falls
 * through to standard collision logic — KILL of the held ghost,
 * session destroyed, fresh session for the new client (different
 * sessid).
 *
 * Post-fix: the auth gate also accepts acc_create_match (incoming
 * account TS == held ghost's cli_user->acc_create).  Rebind succeeds,
 * session continuity preserved, same sessid on both connections.
 *
 * Skip when SECONDARY isn't available (single-server profile).
 */
const linkedAvailable = process.env.IRC_HOST2 || PRIMARY_SERVER.host === 'localhost';

describe.skipIf(!linkedAvailable)('bouncer cross-server rebind (sessid auth-gate)', () => {
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

  it('preserves session continuity when same account reconnects on the other server', async () => {
    const account = await getTestAccount();
    if (account.fromPool) poolAccounts.push(account.account);
    const nick = uniqueNick('rebind');

    // Phase 1: Connect on PRIMARY, enable hold, record sessid.
    const first = await createBouncerClient(account.account, account.password, {
      nick,
      host: PRIMARY_SERVER.host,
      port: PRIMARY_SERVER.port,
    });
    track(first.client);

    const firstInfo = await bouncerInfo(first.client);
    expect(firstInfo, 'BOUNCER INFO on PRIMARY').toBeTruthy();
    expect(firstInfo!.state).toBe('active');
    const sessidPrimary = firstInfo!.sessionId;
    expect(sessidPrimary, 'first session must have a sessid').toBeTruthy();

    // Phase 2: Abrupt disconnect → held ghost on PRIMARY.
    disconnectAbruptly(first.client);
    // Give the network a moment to propagate the BS D (session HOLDING) state.
    await new Promise(r => setTimeout(r, 1500));

    // Phase 3: Reconnect via SECONDARY (leaf).  Same account.  The burst-N
    // forwarded from SECONDARY → PRIMARY won't carry ,S<sessid> (originating
    // burst), so the rebind must accept on acc_create_match.
    const second = await createSaslBouncerClient(account.account, account.password, {
      nick,
      host: SECONDARY_SERVER.host,
      port: SECONDARY_SERVER.port,
    });
    track(second.client);

    // Give the cross-server BX C / rebind a moment to settle.
    await new Promise(r => setTimeout(r, 1500));

    const secondInfo = await bouncerInfo(second.client);
    expect(secondInfo, 'BOUNCER INFO on SECONDARY after reconnect').toBeTruthy();
    expect(secondInfo!.state, 'session must remain active across server-switch').toBe('active');
    expect(
      secondInfo!.sessionId,
      `sessid continuity: expected ${sessidPrimary}, got ${secondInfo!.sessionId} ` +
      `(differing sessid means the rebind was refused — held ghost was killed ` +
      `and a fresh session was created)`,
    ).toBe(sessidPrimary);

    await bouncerDisableHold(second.client);
  });
});
