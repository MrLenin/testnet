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
} from '../helpers/index.js';

/**
 * User modes survive HOLD / revive transitions.
 *
 * The bouncer is a multiplexer — when a primary disconnects, the
 * session enters HOLDING and the dying Client becomes a ghost.  On
 * revive, the new socket is transplanted onto the ghost (which still
 * carries the umode flags from before).  WHOIS should report the same
 * umode set after revive as before.
 *
 * Concretely tests +i (invisible) — a common, sticky umode that
 * doesn't have side-effects on visibility tests.
 */
describe('Bouncer user mode persistence across HOLD / revive', () => {
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

  it('+i (invisible) umode persists through abrupt disconnect + revive', async () => {
    const account = await getTestAccount();
    poolAccounts.push(account.account);
    const nick = uniqueNick('umd');

    const { client: first } = await createSaslBouncerClient(
      account.account, account.password, { nick },
    );
    clients.push(first);
    expect(await bouncerEnableHold(first)).toBe(true);

    // Set +i.  Wait for the MODE echo back.
    first.clearRawBuffer();
    first.send(`MODE ${nick} +i`);
    await first.waitForLine(
      new RegExp(`\\bMODE\\b\\s+${nick}\\s+[:+]+i`),
      5000,
    );

    // /WHOIS self to confirm before disconnect — RPL_WHOISMODES is 379
    // when present, but +i typically shows in 311's realname-line shape;
    // /MODE <nick> is the authoritative query.
    first.clearRawBuffer();
    first.send(`MODE ${nick}`);
    // 221 = RPL_UMODEIS
    const before = await first.waitForLine(/\s221\s/, 5000);
    expect(before).toMatch(/[+]i/);

    // Abrupt disconnect.
    disconnectAbruptly(first);
    const idx = clients.indexOf(first);
    if (idx >= 0) clients.splice(idx, 1);

    // Settle bouncer transition to HOLDING.
    await new Promise(r => setTimeout(r, 1500));

    // Revive.
    const { client: second } = await createSaslBouncerClient(
      account.account, account.password, { nick },
    );
    clients.push(second);

    // /MODE self on the revived connection — should still report +i.
    second.clearRawBuffer();
    second.send(`MODE ${nick}`);
    const after = await second.waitForLine(/\s221\s/, 5000);
    expect(after).toMatch(/[+]i/);
  });
});
