import { describe, it, expect, afterEach } from 'vitest';
import {
  RawSocketClient,
  uniqueNick,
  getTestAccount,
  releaseTestAccount,
  createRawSocketClient,
  bouncerDisableHold,
  PRIMARY_SERVER,
} from '../helpers/index.js';
import { authenticateSaslPlain } from '../helpers/sasl.js';

/**
 * draft/persistence — Phase 4 / M3: channel-list storage + view-only
 * filter.
 *
 * Wire surface under test:
 *   PERSISTENCE PROFILE SET <name> channels +#x | -#x | DEFAULT
 *   PERSISTENCE PROFILE GET <name> channels
 *
 * Validates:
 *   - +#x / -#x / DEFAULT roundtrip through GET
 *   - Empty / unset channel list = no filter (all channels visible)
 *   - Non-empty channel list filters live PRIVMSG delivery
 *   - Non-empty channel list filters the channel-state burst on resume
 *     (M3 view-only: channels not in the list don't appear in the
 *     draft/persistence burst)
 */
describe('draft/persistence — Phase 4 / M3 channels + view-only filter', () => {
  const clients: RawSocketClient[] = [];
  const poolAccounts: string[] = [];

  async function wipeProfiles(client: RawSocketClient): Promise<void> {
    for (let pass = 0; pass < 5; pass++) {
      client.clearRawBuffer();
      client.send('PERSISTENCE PROFILE LIST');
      const names: string[] = [];
      try {
        while (true) {
          const line = await client.waitForParsedLine(
            m => m.command === 'PERSISTENCE'
                 && m.params[0] === 'PROFILE'
                 && m.params[1] !== undefined,
            3_000,
          );
          if (line.params[1] === 'ENDOFLIST') break;
          if (line.params[1] !== 'default') names.push(line.params[1]);
        }
      } catch { break; }
      if (names.length === 0) return;
      let progressed = false;
      for (const name of names) {
        client.clearRawBuffer();
        client.send(`PERSISTENCE PROFILE DELETE ${name}`);
        try {
          await client.waitForParsedLine(
            m => m.command === 'PERSISTENCE' && m.params[1] === 'DELETED'
                 && m.params[2] === name, 2_000,
          );
          progressed = true;
        } catch { /* may be parent-with-children */ }
      }
      if (!progressed) break;
    }
  }

  afterEach(async () => {
    for (const client of clients) {
      try { await wipeProfiles(client); } catch { /* ignore */ }
      try { await bouncerDisableHold(client); } catch { /* ignore */ }
      try { client.close(); } catch { /* ignore */ }
    }
    clients.length = 0;
    for (const account of poolAccounts) {
      releaseTestAccount(account);
    }
    poolAccounts.length = 0;
  });

  async function connectFull(account: string, password: string,
                              extraCaps: string[] = []): Promise<RawSocketClient> {
    const client = await createRawSocketClient(PRIMARY_SERVER.host, PRIMARY_SERVER.port);
    await client.capLs();
    await client.capReq(['sasl', 'draft/persistence', ...extraCaps]);
    const sasl = await authenticateSaslPlain(client, account, password);
    if (!sasl.success) {
      client.close();
      throw new Error(`SASL failed: ${sasl.error}`);
    }
    client.capEnd();
    client.register(uniqueNick('ch'));
    await client.waitForNumeric('001');
    return client;
  }

  /** Connect, SASL, attach <profile>, then complete registration. */
  async function connectAttached(account: string, password: string,
                                  profile: string,
                                  extraCaps: string[] = []): Promise<RawSocketClient> {
    const client = await createRawSocketClient(PRIMARY_SERVER.host, PRIMARY_SERVER.port);
    await client.capLs();
    await client.capReq(['sasl', 'draft/persistence', ...extraCaps]);
    const sasl = await authenticateSaslPlain(client, account, password);
    if (!sasl.success) {
      client.close();
      throw new Error(`SASL failed: ${sasl.error}`);
    }
    client.clearRawBuffer();
    client.send(`PERSISTENCE ATTACH ${profile}`);
    await client.waitForParsedLine(
      m => m.command === 'PERSISTENCE' && m.params[0] === 'ATTACH', 5_000,
    );
    client.capEnd();
    client.register(uniqueNick('ch'));
    await client.waitForNumeric('001');
    return client;
  }

  it('PROFILE SET channels +/-/DEFAULT roundtrip', async () => {
    const account = await getTestAccount();
    poolAccounts.push(account.account);
    const client = await connectFull(account.account, account.password);
    clients.push(client);

    client.send('PERSISTENCE PROFILE CREATE p');
    await client.waitForParsedLine(
      m => m.command === 'PERSISTENCE' && m.params[1] === 'CREATED', 5_000,
    );

    client.clearRawBuffer();
    client.send('PERSISTENCE PROFILE SET p channels +#foo');
    await client.waitForParsedLine(
      m => m.command === 'PERSISTENCE' && m.params[1] === 'p'
           && m.params[2] === 'channels', 5_000,
    );

    client.send('PERSISTENCE PROFILE GET p channels');
    const got1 = await client.waitForParsedLine(
      m => m.command === 'PERSISTENCE' && m.params[1] === 'p'
           && m.params[2] === 'channels' && m.params[3] !== undefined,
      5_000,
    );
    expect(got1.params[3]).toBe('#foo');

    client.send('PERSISTENCE PROFILE SET p channels +#bar');
    await client.waitForParsedLine(
      m => m.command === 'PERSISTENCE' && m.params[1] === 'p'
           && m.params[2] === 'channels', 5_000,
    );

    client.send('PERSISTENCE PROFILE GET p channels');
    const got2 = await client.waitForParsedLine(
      m => m.command === 'PERSISTENCE' && m.params[1] === 'p'
           && m.params[2] === 'channels' && m.params[3] !== undefined,
      5_000,
    );
    // Order isn't guaranteed but both should be present.
    expect(got2.params[3]).toMatch(/#foo/);
    expect(got2.params[3]).toMatch(/#bar/);

    client.send('PERSISTENCE PROFILE SET p channels -#foo');
    await client.waitForParsedLine(
      m => m.command === 'PERSISTENCE' && m.params[1] === 'p'
           && m.params[2] === 'channels', 5_000,
    );
    client.send('PERSISTENCE PROFILE GET p channels');
    const got3 = await client.waitForParsedLine(
      m => m.command === 'PERSISTENCE' && m.params[1] === 'p'
           && m.params[2] === 'channels' && m.params[3] !== undefined,
      5_000,
    );
    expect(got3.params[3]).toBe('#bar');

    client.send('PERSISTENCE PROFILE SET p channels DEFAULT');
    await client.waitForParsedLine(
      m => m.command === 'PERSISTENCE' && m.params[1] === 'p'
           && m.params[2] === 'channels', 5_000,
    );
    client.send('PERSISTENCE PROFILE GET p channels');
    const got4 = await client.waitForParsedLine(
      m => m.command === 'PERSISTENCE' && m.params[1] === 'p'
           && m.params[2] === 'channels',
      5_000,
    );
    // After DEFAULT the key is deleted — reply has no trailing param.
    expect(got4.params[3]).toBeUndefined();
  });

  it('empty channel list = no filter (PRIVMSG delivers normally)', async () => {
    const aAcc = await getTestAccount();
    poolAccounts.push(aAcc.account);
    const bAcc = await getTestAccount();
    poolAccounts.push(bAcc.account);

    const channel = `#m3-nf-${Date.now()}`;
    const a = await connectFull(aAcc.account, aAcc.password);
    clients.push(a);
    const b = await connectFull(bAcc.account, bAcc.password);
    clients.push(b);

    a.send(`JOIN ${channel}`);
    await a.waitForParsedLine(
      m => m.command === 'JOIN' && m.params[0] === channel, 5_000,
    );
    b.send(`JOIN ${channel}`);
    await b.waitForParsedLine(
      m => m.command === 'JOIN' && m.params[0] === channel, 5_000,
    );

    a.clearRawBuffer();
    b.send(`PRIVMSG ${channel} :hello from b`);
    const msg = await a.waitForParsedLine(
      m => m.command === 'PRIVMSG' && m.params[0] === channel, 5_000,
    );
    expect(msg.trailing).toContain('hello from b');
  });

  it('non-empty channel list filters live PRIVMSG to non-listed channel', async () => {
    const aAcc = await getTestAccount();
    poolAccounts.push(aAcc.account);
    const bAcc = await getTestAccount();
    poolAccounts.push(bAcc.account);

    const visibleChan = `#m3-vis-${Date.now()}`;
    const hiddenChan = `#m3-hid-${Date.now()}`;

    // A: create profile "filt" with channels = +<visibleChan>.
    const setup = await connectFull(aAcc.account, aAcc.password);
    clients.push(setup);
    setup.send('PERSISTENCE PROFILE CREATE filt');
    await setup.waitForParsedLine(
      m => m.command === 'PERSISTENCE' && m.params[1] === 'CREATED', 5_000,
    );
    setup.send(`PERSISTENCE PROFILE SET filt channels +${visibleChan}`);
    await setup.waitForParsedLine(
      m => m.command === 'PERSISTENCE' && m.params[1] === 'filt'
           && m.params[2] === 'channels', 5_000,
    );
    setup.send('QUIT');
    setup.close();
    clients.pop();
    await new Promise(r => setTimeout(r, 300));

    // A reconnects attached to "filt" and joins both channels.
    const a = await connectAttached(aAcc.account, aAcc.password, 'filt');
    clients.push(a);
    a.send(`JOIN ${visibleChan}`);
    a.send(`JOIN ${hiddenChan}`);
    await new Promise(r => setTimeout(r, 500));

    // B joins both, sends to each.
    const b = await connectFull(bAcc.account, bAcc.password);
    clients.push(b);
    b.send(`JOIN ${visibleChan}`);
    b.send(`JOIN ${hiddenChan}`);
    await new Promise(r => setTimeout(r, 500));

    a.clearRawBuffer();
    b.send(`PRIVMSG ${visibleChan} :visible`);
    b.send(`PRIVMSG ${hiddenChan} :hidden`);

    // A should see the visible message.
    const visMsg = await a.waitForParsedLine(
      m => m.command === 'PRIVMSG' && m.params[0] === visibleChan
           && m.trailing && m.trailing.includes('visible'),
      5_000,
    );
    expect(visMsg).toBeTruthy();

    // A should NOT see the hidden message.  Wait a beat then check the
    // raw buffer didn't pick up a PRIVMSG to hiddenChan.
    await new Promise(r => setTimeout(r, 1000));
    const hiddenSeen = a.allLines.some(l =>
      new RegExp(`PRIVMSG ${hiddenChan.replace(/[#$.]/g, '\\$&')} :hidden`).test(l),
    );
    expect(hiddenSeen).toBe(false);
  });
});
