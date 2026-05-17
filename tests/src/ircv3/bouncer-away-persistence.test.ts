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
 * AWAY status persistence across HOLD / revive.
 *
 * Setting /AWAY adds away text to the user record; WHOIS reports
 * RPL_AWAY (301) when querying the user.  After a bouncer session
 * enters HOLDING and is revived, the AWAY text should still be in
 * effect on the revived connection (because the ghost retains it
 * through the transplant).
 */
describe('Bouncer AWAY status persistence across HOLD / revive', () => {
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

  it('AWAY text survives abrupt disconnect + revive', async () => {
    const account = await getTestAccount();
    poolAccounts.push(account.account);
    const requestedNick = uniqueNick('awy');
    const awayText = 'bouncer-hold persistence test';

    const { client: first, nick: target } = await createSaslBouncerClient(
      account.account, account.password, { nick: requestedNick },
    );
    clients.push(first);
    expect(await bouncerEnableHold(first)).toBe(true);

    // Set AWAY.  RPL_NOWAWAY = 306.
    first.clearRawBuffer();
    first.send(`AWAY :${awayText}`);
    await first.waitForLine(/\s306\s/, 5000);

    // Confirm visible to an observer via WHOIS (RPL_AWAY = 301).
    const observer1 = await createRawSocketClient();
    clients.push(observer1);
    await observer1.capLs();
    observer1.capEnd();
    observer1.register(uniqueNick('obs'));
    await observer1.waitForNumeric('001');
    observer1.send(`WHOIS ${target}`);
    const awayLineBefore = await observer1.waitForLine(/\s301\s/, 5000);
    expect(awayLineBefore).toContain(awayText);

    // Abrupt disconnect of the bouncer user.
    disconnectAbruptly(first);
    const idx = clients.indexOf(first);
    if (idx >= 0) clients.splice(idx, 1);
    await new Promise(r => setTimeout(r, 1500));

    // Revive.
    const { client: second } = await createSaslBouncerClient(
      account.account, account.password, { nick: target },
    );
    clients.push(second);

    // Observer queries WHOIS again — RPL_AWAY (301) should still appear
    // with the same text.
    const observer2 = await createRawSocketClient();
    clients.push(observer2);
    await observer2.capLs();
    observer2.capEnd();
    observer2.register(uniqueNick('obs2'));
    await observer2.waitForNumeric('001');
    observer2.send(`WHOIS ${target}`);
    const awayLineAfter = await observer2.waitForLine(/\s301\s/, 5000);
    expect(awayLineAfter).toContain(awayText);
  });
});
