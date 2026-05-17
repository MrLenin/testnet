import { describe, it, expect, afterEach } from 'vitest';
import {
  RawSocketClient,
  uniqueNick,
  getTestAccount,
  releaseTestAccount,
  createRawSocketClient,
  createSaslBouncerClient,
  bouncerDisableHold,
  PRIMARY_SERVER,
} from '../helpers/index.js';
import { authenticateSaslPlain } from '../helpers/sasl.js';

/**
 * draft/persistence — Phase 1 wire surface.
 *
 * - CAP advertisement of `draft/persistence`
 * - Unsolicited `:server PERSISTENCE STATUS ON|OFF` at end of registration
 *   when the client has negotiated the cap AND is authenticated
 * - `PERSISTENCE STATUS|GET` query
 * - `PERSISTENCE SET ON|OFF|DEFAULT`
 * - `FAIL PERSISTENCE ACCOUNT_REQUIRED` for unauthenticated clients
 * - `FAIL PERSISTENCE INVALID_PARAMETERS` for malformed SET argument
 *
 * Server-managed metadata carve-out (lands with Phase 1):
 * - `METADATA SET bouncer/...` is rejected on the client surface
 * - `bouncer/...` keys are not counted toward the MAX_KEYS budget
 *   (covered by SET-rejection — full count behaviour is exercised in
 *   the metadata test suite once the carve-out lands.)
 */
describe('draft/persistence — Phase 1', () => {
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

  async function connectWithPersistence(
    account: string,
    password: string,
    nick: string,
  ): Promise<RawSocketClient> {
    const client = await createRawSocketClient(
      PRIMARY_SERVER.host,
      PRIMARY_SERVER.port,
    );
    await client.capLs();
    await client.capReq(['sasl', 'draft/persistence']);
    const saslResult = await authenticateSaslPlain(client, account, password);
    if (!saslResult.success) {
      client.close();
      throw new Error(`SASL failed: ${saslResult.error}`);
    }
    client.capEnd();
    client.register(nick);
    await client.waitForNumeric('001');
    return client;
  }

  it('advertises draft/persistence in CAP LS', async () => {
    const client = await createRawSocketClient(
      PRIMARY_SERVER.host,
      PRIMARY_SERVER.port,
    );
    clients.push(client);

    const caps = await client.capLs();
    expect(caps.has('draft/persistence')).toBe(true);
  });

  it('emits unsolicited PERSISTENCE STATUS after registration when cap negotiated', async () => {
    const account = await getTestAccount();
    poolAccounts.push(account.account);
    const nick = uniqueNick('prs');

    const client = await connectWithPersistence(account.account, account.password, nick);
    clients.push(client);

    // Unsolicited STATUS lands between 005 and MOTD-END.  Wait for the
    // PERSISTENCE line; bound it by MOTD end (376/422) so we fail fast
    // if the server forgot to emit it.
    const line = await client.waitForParsedLine(
      m => m.command === 'PERSISTENCE' || m.command === '376' || m.command === '422',
      10_000,
    );
    expect(line.command).toBe('PERSISTENCE');
    expect(line.params[0]).toBe('STATUS');
    expect(['ON', 'OFF']).toContain(line.params[1]);
  });

  it('PERSISTENCE STATUS returns current effective state on demand', async () => {
    const account = await getTestAccount();
    poolAccounts.push(account.account);
    const nick = uniqueNick('prs');

    const client = await connectWithPersistence(account.account, account.password, nick);
    clients.push(client);

    // Drain the unsolicited STATUS so we don't conflate it with the reply.
    await client.waitForParsedLine(m => m.command === 'PERSISTENCE', 10_000);

    client.clearRawBuffer();
    client.send('PERSISTENCE STATUS');
    const reply = await client.waitForParsedLine(
      m => m.command === 'PERSISTENCE' && m.params[0] === 'STATUS',
      5_000,
    );
    expect(reply.params[0]).toBe('STATUS');
    expect(['ON', 'OFF']).toContain(reply.params[1]);
  });

  it('PERSISTENCE GET is an alias for STATUS', async () => {
    const account = await getTestAccount();
    poolAccounts.push(account.account);
    const nick = uniqueNick('prs');

    const client = await connectWithPersistence(account.account, account.password, nick);
    clients.push(client);

    await client.waitForParsedLine(m => m.command === 'PERSISTENCE', 10_000);

    client.clearRawBuffer();
    client.send('PERSISTENCE GET');
    const reply = await client.waitForParsedLine(
      m => m.command === 'PERSISTENCE' && m.params[0] === 'STATUS',
      5_000,
    );
    expect(reply.params[0]).toBe('STATUS');
    expect(['ON', 'OFF']).toContain(reply.params[1]);
  });

  it('PERSISTENCE SET ON enables hold, STATUS reflects ON', async () => {
    const account = await getTestAccount();
    poolAccounts.push(account.account);
    const nick = uniqueNick('prs');

    const client = await connectWithPersistence(account.account, account.password, nick);
    clients.push(client);

    await client.waitForParsedLine(m => m.command === 'PERSISTENCE', 10_000);

    client.clearRawBuffer();
    client.send('PERSISTENCE SET ON');
    const setReply = await client.waitForParsedLine(
      m => m.command === 'PERSISTENCE' && m.params[0] === 'SET',
      5_000,
    );
    expect(setReply.params[1]).toBe('ON');

    const statusReply = await client.waitForParsedLine(
      m => m.command === 'PERSISTENCE' && m.params[0] === 'STATUS',
      5_000,
    );
    expect(statusReply.params[1]).toBe('ON');
  });

  it('PERSISTENCE SET OFF disables hold, STATUS reflects OFF', async () => {
    const account = await getTestAccount();
    poolAccounts.push(account.account);
    const nick = uniqueNick('prs');

    const client = await connectWithPersistence(account.account, account.password, nick);
    clients.push(client);

    await client.waitForParsedLine(m => m.command === 'PERSISTENCE', 10_000);

    // First enable hold so OFF has something to toggle off.
    client.clearRawBuffer();
    client.send('PERSISTENCE SET ON');
    await client.waitForParsedLine(
      m => m.command === 'PERSISTENCE' && m.params[0] === 'SET' && m.params[1] === 'ON',
      5_000,
    );

    client.clearRawBuffer();
    client.send('PERSISTENCE SET OFF');
    const setReply = await client.waitForParsedLine(
      m => m.command === 'PERSISTENCE' && m.params[0] === 'SET',
      5_000,
    );
    expect(setReply.params[1]).toBe('OFF');

    const statusReply = await client.waitForParsedLine(
      m => m.command === 'PERSISTENCE' && m.params[0] === 'STATUS',
      5_000,
    );
    expect(statusReply.params[1]).toBe('OFF');
  });

  it('PERSISTENCE SET DEFAULT clears preference', async () => {
    const account = await getTestAccount();
    poolAccounts.push(account.account);
    const nick = uniqueNick('prs');

    const client = await connectWithPersistence(account.account, account.password, nick);
    clients.push(client);

    await client.waitForParsedLine(m => m.command === 'PERSISTENCE', 10_000);

    // Set OFF first so DEFAULT has something to clear.
    client.clearRawBuffer();
    client.send('PERSISTENCE SET OFF');
    await client.waitForParsedLine(
      m => m.command === 'PERSISTENCE' && m.params[0] === 'SET' && m.params[1] === 'OFF',
      5_000,
    );

    client.clearRawBuffer();
    client.send('PERSISTENCE SET DEFAULT');
    const setReply = await client.waitForParsedLine(
      m => m.command === 'PERSISTENCE' && m.params[0] === 'SET',
      5_000,
    );
    expect(setReply.params[1]).toBe('DEFAULT');

    // Effective state after DEFAULT is whatever the server default is —
    // ON or OFF depending on FEAT_BOUNCER_DEFAULT_HOLD.  Both are valid.
    const statusReply = await client.waitForParsedLine(
      m => m.command === 'PERSISTENCE' && m.params[0] === 'STATUS',
      5_000,
    );
    expect(['ON', 'OFF']).toContain(statusReply.params[1]);
  });

  it('PERSISTENCE SET BADARG → FAIL INVALID_PARAMETERS', async () => {
    const account = await getTestAccount();
    poolAccounts.push(account.account);
    const nick = uniqueNick('prs');

    const client = await connectWithPersistence(account.account, account.password, nick);
    clients.push(client);

    await client.waitForParsedLine(m => m.command === 'PERSISTENCE', 10_000);

    client.clearRawBuffer();
    client.send('PERSISTENCE SET BOGUS');
    const fail = await client.waitForParsedLine(
      m => m.command === 'FAIL' && m.params[0] === 'PERSISTENCE',
      5_000,
    );
    expect(fail.params[1]).toBe('INVALID_PARAMETERS');
  });

  it('unauthenticated PERSISTENCE → FAIL ACCOUNT_REQUIRED', async () => {
    // Connect WITHOUT SASL so the client is unauthenticated.
    const client = await createRawSocketClient(
      PRIMARY_SERVER.host,
      PRIMARY_SERVER.port,
    );
    clients.push(client);
    await client.capLs();
    await client.capReq(['draft/persistence']);
    client.capEnd();
    client.register(uniqueNick('prs'));
    await client.waitForNumeric('001');

    client.clearRawBuffer();
    client.send('PERSISTENCE STATUS');
    const fail = await client.waitForParsedLine(
      m => m.command === 'FAIL' && m.params[0] === 'PERSISTENCE',
      5_000,
    );
    expect(fail.params[1]).toBe('ACCOUNT_REQUIRED');
  });

  it('client METADATA SET on a server-managed key is rejected', async () => {
    const account = await getTestAccount();
    poolAccounts.push(account.account);
    const nick = uniqueNick('prs');

    // Use the standard bouncer-client helper (negotiates draft/metadata-2 via
    // extraCaps so METADATA SET is even legal on the wire).
    const { client } = await createSaslBouncerClient(
      account.account, account.password,
      { nick, extraCaps: ['draft/metadata-2'] },
    );
    clients.push(client);

    client.clearRawBuffer();
    client.send(`METADATA * SET bouncer/hold :1`);
    const fail = await client.waitForParsedLine(
      m => m.command === 'FAIL' && m.params[0] === 'METADATA',
      5_000,
    );
    // KEY_NO_PERMISSION is the existing error code reused for the
    // server-managed carve-out.
    expect(fail.params[1]).toBe('KEY_NO_PERMISSION');
  });
});
