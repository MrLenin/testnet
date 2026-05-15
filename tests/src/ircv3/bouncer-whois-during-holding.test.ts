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
  createRawSocketClient,
} from '../helpers/index.js';

/**
 * Observer's view of a HOLDING bouncer session.
 *
 * Design intent (bouncer-design-intent.md §"Legacy peer's view of a
 * HELD session"):
 *   "A HELD session is visible to legacy peers as a normal connected
 *    user — it has a nick, a numeric, normal routing.  The 'held'
 *    nature is internal to bouncer-aware servers."
 *
 *   "Possible refinement: a tweaked /WHOIS line annotating that the
 *    user is in HELD state.  Otherwise the legacy view is unchanged
 *    from a regular client."
 *
 * Concretely: a fresh observer connecting AFTER the bouncer user has
 * dropped (session HOLDING) should still see the held nick in WHOIS,
 * with RPL_WHOISUSER (311) and RPL_ENDOFWHOIS (318) — not ERR_NOSUCHNICK
 * (401).
 */
describe('Bouncer HOLDING ghost visible to observer WHOIS', () => {
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

  it('/WHOIS on a HOLDING ghost returns 311 + 318, not 401', async () => {
    const account = await getTestAccount();
    poolAccounts.push(account.account);
    const target = uniqueNick('wsh');

    // Bouncer user connects + enables hold.
    const { client: bouncer } = await createSaslBouncerClient(
      account.account, account.password, { nick: target },
    );
    clients.push(bouncer);
    expect(await bouncerEnableHold(bouncer)).toBe(true);

    // Abrupt disconnect — session transitions to HOLDING.
    disconnectAbruptly(bouncer);
    const idx = clients.indexOf(bouncer);
    if (idx >= 0) clients.splice(idx, 1);

    // Give bouncer time to detect dead socket and transition.
    await new Promise(r => setTimeout(r, 1500));

    // Fresh observer connects AFTER the bouncer dropped.  This observer
    // never saw the bouncer user alive; they should still see the held
    // ghost via WHOIS.
    const observer = await createRawSocketClient();
    clients.push(observer);
    await observer.capLs();
    observer.capEnd();
    observer.register(uniqueNick('obs'));
    await observer.waitForNumeric('001');

    observer.clearRawBuffer();
    observer.send(`WHOIS ${target}`);

    // RPL_WHOISUSER (311) should appear — the ghost is in the nick hash
    // and resolves normally.
    const userLine = await observer.waitForLine(/\s311\s/, 5000);
    expect(userLine).toContain(target);
    // RPL_ENDOFWHOIS (318) closes the WHOIS response cleanly.
    await observer.waitForLine(/\s318\s/, 3000);

    // ERR_NOSUCHNICK (401) must NOT appear — the held ghost is
    // explicitly NOT supposed to look "gone" to observers.
    const buf = observer.getUnconsumedLines().join('\n');
    expect(buf).not.toMatch(/\s401\s/);
  });
});
