import { describe, it, expect, afterEach } from 'vitest';
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
 * Bouncer HOLDING-state validation via /CHECK -b.
 *
 * After an abrupt disconnect of a bouncer-managed primary, the session
 * transitions to HOLDING and the dying Client becomes a ghost
 * (IsBouncerHold).  The ghost stays in the nick hash so /CHECK finds
 * it; it stays in channel rosters via SetMemberHolding.  These tests
 * validate /CHECK -b's view of that state.
 */
describe('Bouncer HOLDING state via /CHECK -b', () => {
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

  it('/CHECK -b after abrupt disconnect: ghost still reports as primary', async () => {
    const account = await getTestAccount();
    poolAccounts.push(account.account);
    const nick = uniqueNick('hld');

    const { client } = await createSaslBouncerClient(
      account.account, account.password, { nick },
    );
    clients.push(client);
    expect(await bouncerEnableHold(client)).toBe(true);

    const oper = await createOperClient();
    clients.push(oper);

    // Before disconnect — primary is the live client.
    const before = await runCheck(oper, nick, 10_000);
    expect(before.primary).toBeDefined();
    const liveNumeric = before.primary!.numeric;
    const liveSessid = before.primary!.sessid;

    // Abrupt disconnect — session transitions to HOLDING; the dying
    // Client becomes a ghost (IsBouncerHold) and stays hashed under
    // its old nick.
    disconnectAbruptly(client);
    const idx = clients.indexOf(client);
    if (idx >= 0) clients.splice(idx, 1);

    // Give bouncer time to detect dead socket and transition.
    await new Promise(r => setTimeout(r, 1500));

    // After: /CHECK -b should still find the ghost under the same nick.
    // The ghost keeps the same numeric (no SetLocalNumNick re-roll on
    // transition to HOLDING).  Sessid likewise stable across the
    // transition.
    const after = await runCheck(oper, nick, 10_000);
    expect(after.primary).toBeDefined();
    expect(after.primary?.numeric).toBe(liveNumeric);
    expect(after.primary?.sessid).toBe(liveSessid);
    // Ghost is still local on this server.
    expect(after.primary?.locality).toBe('local');
  });
});
