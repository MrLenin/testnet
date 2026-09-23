/**
 * Oper CHECK on a channel shows each member's account.
 *
 * m_check.c stored the result of IsAccount() in an int.  The flag test
 * returns the member's flag word masked, and on this tree the account flag
 * sits beyond bit 31, so the int was always zero: CHECK printed no account
 * for anyone and counted "0 authed".  WHOIS was right all along; only the
 * oper tool lied.
 */
import { describe, it, expect, afterEach } from 'vitest';
import { RawSocketClient, createRawSocketClient, getTestAccount, releaseTestAccount } from '../helpers/index.js';
import { authenticateSaslPlain } from '../helpers/sasl';
import { createOperClient } from '../helpers/x3-client';

describe('CHECK shows member accounts', () => {
  const clients: RawSocketClient[] = [];
  const poolAccounts: string[] = [];

  afterEach(() => {
    for (const c of clients) { try { c.close(); } catch { /* ignore */ } }
    clients.length = 0;
    for (const a of poolAccounts) releaseTestAccount(a);
    poolAccounts.length = 0;
  });

  it('prints the account of a logged-in member and counts it as authed', async () => {
    const { account, password } = await getTestAccount();
    poolAccounts.push(account);
    const c = await createRawSocketClient();
    clients.push(c);
    await c.capLs();
    await c.capReq(['sasl']);
    const r = await authenticateSaslPlain(c, account, password);
    expect(r.success, `SASL PLAIN as ${account}: ${r.error}`).toBe(true);
    const nick = `chk${Math.random().toString(36).slice(2, 7)}`;
    c.capEnd();
    c.register(nick);
    await c.waitForNumeric('001', 15000);
    const channel = `#chk${Math.random().toString(36).slice(2, 7)}`;
    c.send(`JOIN ${channel}`);
    await c.waitForLine(new RegExp(` JOIN :?${channel}\\b`), 8000);

    // WHOIS is the reference: 330 names the account.
    c.clearRawBuffer();
    c.send(`WHOIS ${nick}`);
    expect(await c.waitForLine(new RegExp(` (330|318) ${nick} `), 5000)).toMatch(new RegExp(` 330 ${nick} ${nick} ${account} `));

    const op = await createOperClient();
    clients.push(op);
    op.clearRawBuffer();
    op.send(`CHECK ${channel}`);
    // RPL_CHANUSER (287): ": <oplvl> <status><nick> (<user>@<host>)   (<info>) <account>"
    const row = await op.waitForLine(new RegExp(` 287 \\S+ :.*@${nick} \\(`), 8000);
    expect(row, 'the member row ends with the account').toMatch(new RegExp(`\\) ${account}\\s*$`));
    const total = await op.waitForLine(/Total users::/, 8000);
    expect(total, 'the member is counted as authed').toMatch(/ 1 authed,/);
  }, 60_000);
});
