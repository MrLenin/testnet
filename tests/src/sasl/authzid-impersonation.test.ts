/**
 * SASL authzid impersonation regression test (F-A1).
 *
 * Runs at maintainer's Docker rebuild; validates F-A1.
 *
 * SASL PLAIN's wire format is base64(authzid \0 authcid \0 password): the
 * client authenticates as `authcid` but may separately request to be
 * *authorized* as `authzid`. Nefarious previously honored a client-asserted
 * authzid unconditionally whenever it was non-empty and differed from the
 * authcid, so a client holding valid credentials for `attacker` could set
 * authzid=`victim` and be logged in AS `victim` -- a full account takeover
 * requiring no knowledge of the victim's password.
 *
 * The fix gates this behind a new (default-empty) FEAT_SASL_TRUSTED_AUTHZID
 * allowlist: a client-asserted authzid is only honored when the
 * Keycloak-verified authcid is on that allowlist. By default the allowlist
 * is empty, so authzid is always ignored and the server authenticates as
 * the verified authcid.
 *
 * This suite asserts:
 *   (a) authzid=victim / authcid=attacker / attacker's own password never
 *       results in a victim login (either the server logs the client in as
 *       `attacker` -- ignoring the untrusted authzid -- or it fails the
 *       authentication outright; either is acceptable, a victim login is
 *       not).
 *   (b) a normal authzid === authcid login (no impersonation attempt) still
 *       succeeds, i.e. the allowlist gate does not regress the common case.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { createRawSocketClient, RawSocketClient, uniqueId } from '../helpers/index.js';
import { getTestAccount, releaseTestAccount } from '../helpers/x3-client.js';

describe('SASL authzid impersonation (F-A1)', () => {
  const clients: RawSocketClient[] = [];
  const poolAccounts: Array<{ account: string; fromPool: boolean }> = [];

  const trackClient = (client: RawSocketClient): RawSocketClient => {
    clients.push(client);
    return client;
  };

  const trackAccount = (account: string, fromPool: boolean): void => {
    poolAccounts.push({ account, fromPool });
  };

  beforeEach(async () => {
    // Multiple tests authenticate against the same shared Keycloak backend
    // in quick succession -- space out attempts to avoid overload (mirrors
    // ircv3/sasl.test.ts).
    await new Promise(r => setTimeout(r, 500));
  });

  afterEach(async () => {
    for (const client of clients) {
      try {
        client.close();
      } catch {
        // Ignore errors during cleanup
      }
    }
    clients.length = 0;
    for (const { account, fromPool } of poolAccounts) {
      if (fromPool) releaseTestAccount(account);
    }
    poolAccounts.length = 0;
    await new Promise(r => setTimeout(r, 500));
  });

  /**
   * SASL PLAIN with independently-controlled authzid/authcid/password.
   *
   * Unlike helpers/sasl.ts's authenticateSaslPlain() -- which hardcodes
   * authzid === authcid === account and so cannot express an impersonation
   * attempt -- this sends an arbitrary base64(authzid\0authcid\0password)
   * payload. Modeled on the local `saslPlain` closure in
   * ircv3/sasl.test.ts, generalized to a distinct authzid.
   */
  async function saslPlainAs(
    client: RawSocketClient,
    authzid: string,
    authcid: string,
    password: string,
  ): Promise<{ command: string; raw: string; params: string[] }> {
    client.clearBuffer();
    client.send('AUTHENTICATE PLAIN');
    await client.waitForParsedLine(
      msg => msg.command === 'AUTHENTICATE' && msg.params[0] === '+',
      10000,
    );

    const payload = Buffer.from(`${authzid}\0${authcid}\0${password}`).toString('base64');
    client.send(`AUTHENTICATE ${payload}`);

    // Keycloak can take several seconds to reject invalid/mismatched
    // credentials under load (see ircv3/sasl.test.ts comments) -- use the
    // same generous 20s timeout as the rest of the suite.
    return client.waitForNumeric(
      ['900', '901', '902', '903', '904', '905', '906', '907', '908', '909'],
      20000,
    );
  }

  it('AUTHENTICATE PLAIN with mismatched authzid does not log in as the victim', { retry: 2 }, async () => {
    // Two distinct, real accounts. The victim never supplies credentials
    // anywhere in this test -- the attacker authenticates with its OWN
    // valid password and merely *asserts* authzid=victim.
    const victim = await getTestAccount();
    trackAccount(victim.account, victim.fromPool);
    const attacker = await getTestAccount();
    trackAccount(attacker.account, attacker.fromPool);
    expect(victim.account).not.toBe(attacker.account);

    const client = trackClient(await createRawSocketClient());
    await client.capLs();
    await client.capReq(['sasl']);

    const result = await saslPlainAs(client, victim.account, attacker.account, attacker.password);

    if (result.command === '900') {
      // RPL_LOGGEDIN: <nick> 900 <nick> <nick>!<user>@<host> <account> :...
      // params[2] carries the account name (per helpers/sasl.ts).
      const loggedInAccount = result.params[2];
      expect(
        loggedInAccount,
        `900 must never report the victim account; got: ${result.raw}`,
      ).not.toBe(victim.account);
      expect(loggedInAccount).toBe(attacker.account);
    } else if (result.command === '903') {
      // RPL_SASLSUCCESS carries no account param -- confirm identity via
      // WHOIS after completing registration.
      client.capEnd();
      const nick = `fa1${uniqueId()}`;
      client.register(nick);
      await client.waitForNumeric('001', 10000);

      client.send(`WHOIS ${nick}`);
      const whois = await client.waitForNumeric(['330', '311'], 5000);
      expect(
        whois.raw,
        `WHOIS must never show the victim account; got: ${whois.raw}`,
      ).not.toContain(victim.account);
      if (whois.command === '330') {
        expect(whois.raw).toContain(attacker.account);
      }
    } else {
      // Any other 9xx (typically 904 ERR_SASLFAIL) is an acceptable
      // "rejected outright" outcome per the fix's uniform ignore-and-
      // authenticate-as-verified semantics -- the only forbidden outcome
      // is a victim login.
      expect(result.command, `unexpected SASL result: ${result.raw}`).toMatch(/^90\d$/);
    }

    client.send('QUIT');
  });

  it('a normal authzid === authcid login still succeeds', { retry: 2 }, async () => {
    const attacker = await getTestAccount();
    trackAccount(attacker.account, attacker.fromPool);

    const client = trackClient(await createRawSocketClient());
    await client.capLs();
    await client.capReq(['sasl']);

    const result = await saslPlainAs(client, attacker.account, attacker.account, attacker.password);
    expect(result.command, `expected SASL success, got: ${result.raw}`).toMatch(/^90[03]$/);

    client.send('QUIT');
  });
});
