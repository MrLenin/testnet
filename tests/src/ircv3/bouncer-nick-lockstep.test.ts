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
 * Nick lockstep across primary + alias.
 *
 * Design invariant (bouncer-design-intent.md §"Nick lockstep
 * invariant"): "At connection-registration time, an alias may register
 * with any nick.  By registration end (and at all times after), the
 * alias's nick is kept in lockstep with the primary's nick."
 *
 * Concretely: when the primary issues NICK newnick, the alias's
 * cli_name must be re-synced to match.  /CHECK -b's BouncerAlias line
 * should report the new nick on both primary and alias.
 *
 * If lockstep breaks, observers see one nick from the primary's POV
 * and a different one from the alias's POV, and any code that does
 * findUser(primary's old nick) finds a phantom.
 */
describe('Bouncer nick lockstep across primary + alias', () => {
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

  it('primary NICK change syncs to alias on the same server', async () => {
    const account = await getTestAccount();
    poolAccounts.push(account.account);
    const nick = uniqueNick('lks');
    const newNick = uniqueNick('lksn');

    // Primary.
    const primary = await createSaslBouncerClient(
      account.account, account.password, { nick },
    );
    clients.push(primary.client);
    expect(await bouncerEnableHold(primary.client)).toBe(true);

    // Alias.
    const alias = await createSaslBouncerClient(
      account.account, account.password,
      { nick: uniqueNick('lksa') /* will be overridden to primary's nick */ },
    );
    clients.push(alias.client);

    // Settle.
    await new Promise(r => setTimeout(r, 800));

    const oper = await createOperClient();
    clients.push(oper);

    // Before: both report `nick`.
    const before = await runCheck(oper, nick, 10_000);
    expect(before.primary?.nick).toBe(nick);
    expect(before.aliases.length).toBe(1);
    expect(before.aliases[0].nick).toBe(nick);
    const sessid = before.primary!.sessid;

    // Primary changes nick; wait for the self-echo back on the primary.
    primary.client.clearRawBuffer();
    alias.client.clearRawBuffer();
    primary.client.send(`NICK ${newNick}`);
    await primary.client.waitForLine(
      new RegExp(`:${nick}\\b[^ ]* NICK :?${newNick}`),
      5000,
    );

    // Alias should also see :oldnick NICK newnick (lockstep echo).
    // Without this echo, the alias's IRC client keeps the old nick in
    // its UI even though the server's cli_name(alias) is already up to
    // date — violating the lockstep invariant from the alias's POV.
    const aliasEcho = await alias.client.waitForLine(
      new RegExp(`:${nick}\\b[^ ]* NICK :?${newNick}`),
      5000,
    );
    expect(aliasEcho).toContain(newNick);

    // Settle so /CHECK -b reflects the new state.
    await new Promise(r => setTimeout(r, 500));

    // /CHECK -b on the NEW nick: both primary + alias report the new
    // nick, sessid unchanged.
    const after = await runCheck(oper, newNick, 10_000);
    expect(after.primary?.nick).toBe(newNick);
    expect(after.primary?.sessid).toBe(sessid);
    expect(after.aliases.length).toBe(1);
    expect(after.aliases[0].nick).toBe(newNick);
    expect(after.aliases[0].sessid).toBe(sessid);
  });

  it('alias NICK change syncs to primary on the same server', async () => {
    // Same as above but the rename originates from the alias side.  The
    // primary must follow into the new nick.  Both ends agree.
    const account = await getTestAccount();
    poolAccounts.push(account.account);
    const nick = uniqueNick('lka');
    const newNick = uniqueNick('lkan');

    const primary = await createSaslBouncerClient(
      account.account, account.password, { nick },
    );
    clients.push(primary.client);
    expect(await bouncerEnableHold(primary.client)).toBe(true);

    const alias = await createSaslBouncerClient(
      account.account, account.password,
      { nick: uniqueNick('lkax') },
    );
    clients.push(alias.client);

    await new Promise(r => setTimeout(r, 800));

    const oper = await createOperClient();
    clients.push(oper);

    const before = await runCheck(oper, nick, 10_000);
    expect(before.primary?.nick).toBe(nick);
    expect(before.aliases[0]?.nick).toBe(nick);
    const sessid = before.primary!.sessid;

    // Alias issues NICK.
    alias.client.clearRawBuffer();
    alias.client.send(`NICK ${newNick}`);
    await alias.client.waitForLine(
      new RegExp(`:${nick}\\b[^ ]* NICK :?${newNick}`),
      5000,
    );

    // Primary should also see the rename echoed.
    const primaryEcho = await primary.client.waitForLine(
      new RegExp(`:${nick}\\b[^ ]* NICK :?${newNick}`),
      5000,
    );
    expect(primaryEcho).toContain(newNick);

    await new Promise(r => setTimeout(r, 500));

    const after = await runCheck(oper, newNick, 10_000);
    expect(after.primary?.nick).toBe(newNick);
    expect(after.primary?.sessid).toBe(sessid);
    expect(after.aliases[0]?.nick).toBe(newNick);
    expect(after.aliases[0]?.sessid).toBe(sessid);
  });
});
