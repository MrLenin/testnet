import { describe, it, expect, afterEach } from 'vitest';
import {
  RawSocketClient,
  uniqueNick,
  getTestAccount,
  releaseTestAccount,
  createSaslBouncerClient,
  bouncerEnableHold,
  bouncerDisableHold,
  bouncerInfo,
  disconnectAbruptly,
} from '../helpers/index.js';

/**
 * Bouncer accounting: connects counter increments on each new attach.
 *
 * BOUNCER INFO's `connects=N` field is the cumulative count of times a
 * connection landed on this session — initial create + each successful
 * revive.  This counter is what the dynamic hold-time policy uses to
 * lengthen the hold for heavily-used sessions (see
 * bouncer-design-intent.md §"Hold expiry").
 *
 * If the counter doesn't tick on revive, the hold-grows-with-use
 * policy is effectively dead.
 */
describe('Bouncer connects counter via BOUNCER INFO', () => {
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

  it('connects counter goes up by 1 after abrupt disconnect + revive', async () => {
    const account = await getTestAccount();
    poolAccounts.push(account.account);
    const nick = uniqueNick('rsm');

    const { client: first } = await createSaslBouncerClient(
      account.account, account.password, { nick },
    );
    clients.push(first);
    expect(await bouncerEnableHold(first)).toBe(true);

    // Baseline — connects is at least 1 (this connection).
    const before = await bouncerInfo(first);
    expect(before).not.toBeNull();
    expect(before!.connects).toBeDefined();
    const connectsBefore = before!.connects!;
    expect(connectsBefore).toBeGreaterThanOrEqual(1);

    // Abrupt disconnect → HOLDING.
    disconnectAbruptly(first);
    const idx = clients.indexOf(first);
    if (idx >= 0) clients.splice(idx, 1);
    await new Promise(r => setTimeout(r, 1500));

    // Revive.
    const { client: second } = await createSaslBouncerClient(
      account.account, account.password, { nick },
    );
    clients.push(second);

    const after = await bouncerInfo(second);
    expect(after).not.toBeNull();
    expect(after!.connects).toBeDefined();
    // Counter ticks by exactly 1 per revive — independent connect events
    // accumulate against the session's lifetime total.
    expect(after!.connects).toBe(connectsBefore + 1);
  });
});
