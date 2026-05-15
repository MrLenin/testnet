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
 * Single-server multi-attach (shadow / local alias) /CHECK -b validation.
 *
 * The existing bouncer.test.ts covers that a second SASL connection to
 * an active session attaches as an alias on the same server.  These
 * tests validate the bouncer state from a /CHECK -b perspective:
 *
 *   - /CHECK -b shows the primary
 *   - /CHECK -b shows the alias as a BouncerAlias entry with
 *     primaryNumeric pointing at the primary's numeric
 *   - Sessid agreement across primary and alias
 *   - Locality is "local" for both (same server)
 */
describe('Bouncer single-server multi-attach', () => {
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

  it('/CHECK -b reports primary + 1 alias for two-client multi-attach', async () => {
    const account = await getTestAccount();
    poolAccounts.push(account.account);
    const nick = uniqueNick('mat');

    // First client → primary.
    const primary = await createSaslBouncerClient(
      account.account, account.password, { nick },
    );
    clients.push(primary.client);
    expect(await bouncerEnableHold(primary.client)).toBe(true);

    // Second client, same account → alias (per bounce_setup_local_alias).
    // The alias inherits the primary's nick at attach time, so we don't
    // care what nick we requested — server picks the primary's.
    const aliasSide = await createSaslBouncerClient(
      account.account, account.password,
      { nick: uniqueNick('mat') /* will be overridden to primary's nick */ },
    );
    clients.push(aliasSide.client);

    // Settle for BX C cross-server (no-op here, single server) + alias
    // table update.
    await new Promise(r => setTimeout(r, 800));

    const oper = await createOperClient();
    clients.push(oper);

    const state = await runCheck(oper, nick, 10_000);

    // Primary side.
    expect(state.primary).toBeDefined();
    expect(state.primary?.nick).toBe(nick);
    expect(state.primary?.locality).toBe('local');

    // Exactly one alias.
    expect(state.aliases.length).toBe(1);
    const alias = state.aliases[0];
    // Alias is on this server (locality=local), and points at the
    // primary's numeric.
    expect(alias.locality).toBe('local');
    expect(alias.primaryNumeric).toBe(state.primary!.numeric);
    // Alias and primary agree on sessid.
    expect(alias.sessid).toBe(state.primary!.sessid);
    // Alias inherits primary's nick (alias-aware identity routing).
    expect(alias.nick).toBe(nick);
  });

  it('multi-attach preserves alias sessid + locality after primary keeps connection', async () => {
    // Re-runs the multi-attach setup and validates that, when the
    // primary stays connected, the alias remains in BouncerAlias listing
    // across a fresh /CHECK -b — i.e., state is stable, not a momentary
    // artifact.
    const account = await getTestAccount();
    poolAccounts.push(account.account);
    const nick = uniqueNick('mat');

    const primary = await createSaslBouncerClient(
      account.account, account.password, { nick },
    );
    clients.push(primary.client);
    expect(await bouncerEnableHold(primary.client)).toBe(true);

    const aliasSide = await createSaslBouncerClient(
      account.account, account.password,
      { nick: uniqueNick('mat') },
    );
    clients.push(aliasSide.client);

    await new Promise(r => setTimeout(r, 800));

    const oper = await createOperClient();
    clients.push(oper);

    // Two queries 1s apart — state should be identical (modulo
    // ba_last_active which we don't expose in BouncerAlias).
    const first = await runCheck(oper, nick, 10_000);
    await new Promise(r => setTimeout(r, 1000));
    const second = await runCheck(oper, nick, 10_000);

    expect(first.primary?.numeric).toBe(second.primary?.numeric);
    expect(first.primary?.sessid).toBe(second.primary?.sessid);
    expect(first.aliases.length).toBe(second.aliases.length);
    expect(first.aliases.length).toBe(1);
    expect(first.aliases[0].numeric).toBe(second.aliases[0].numeric);
    expect(first.aliases[0].sessid).toBe(second.aliases[0].sessid);
    // All cli_session_id values consistent across primary and alias —
    // exercises the ce933dc + bounce_attach sync.
    expect(first.primary?.sessid).toBe(first.aliases[0].sessid);
  });
});
