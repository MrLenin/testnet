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
 * Bouncer accounting: resume counter increments on revive.
 *
 * BOUNCER INFO reports a "resumes" key that tracks how many times the
 * session has been resumed from HOLDING (i.e., a new SASL connection
 * landed on a held ghost via bounce_revive).  This counter is part of
 * the dynamic hold-time policy: a heavily-used session gets a longer
 * hold (see bouncer-design-intent.md §"Hold expiry").
 *
 * If the counter doesn't tick, the hold-grows-with-use policy is
 * effectively dead.
 */
describe('Bouncer resume counter via BOUNCER INFO', () => {
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

  // Skip currently because pool-vs-Keycloak sync state in this testnet
  // is intermittently broken — a half-finished cleanup run earlier
  // removed pool accounts from Keycloak but not from X3/LDAP, so
  // pool-init's X3 AUTH succeeds while SASL PLAIN through libkc gets
  // KC_FORBIDDEN ("user_not_found").  Once a SASL failure populates
  // Nefarious's neg-cache, subsequent attempts for the same account
  // fail-fast even after Keycloak is restored.
  //
  // Unskip after either:
  //   - re-running `npm run cleanup -- --include-pool` (full wipe both
  //     sides) so the next pool-init re-creates accounts in BOTH X3
  //     AND Keycloak via the X3 REGISTER → OUNREGISTER → Keycloak sync
  //     path, or
  //   - manually re-creating the missing Keycloak users.
  it.skip('resumes counter goes up by 1 after abrupt disconnect + revive', async () => {
    const account = await getTestAccount();
    poolAccounts.push(account.account);
    const nick = uniqueNick('rsm');

    const { client: first } = await createSaslBouncerClient(
      account.account, account.password, { nick },
    );
    clients.push(first);
    expect(await bouncerEnableHold(first)).toBe(true);

    // Baseline.  Brand-new session should have resumes=0 (or undefined
    // if not present yet — treat as 0).
    const before = await bouncerInfo(first);
    expect(before).not.toBeNull();
    const resumesBefore = before!.resumes ?? 0;

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
    expect(after!.resumes).toBeDefined();
    // Counter ticks by exactly 1 per revive.
    expect(after!.resumes).toBe(resumesBefore + 1);
  });
});
