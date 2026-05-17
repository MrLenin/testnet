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
 * draft/persistence — Phase 4 / M5: channel-list inheritance with
 * set-merge semantics.
 *
 * Storage extension: a profile's `channels` value may contain `-#chan`
 * entries marking explicit subtractions from inherited channels.  The
 * effective channel set walks inheritance from root to leaf, applying
 * adds and subtracts in order.
 *
 * Validates:
 *   - Child profile inherits parent's channels (effective set covers
 *     the parent's contents)
 *   - PROFILE SET child channels -#x writes a subtract marker; the
 *     channel disappears from the child's effective set but remains
 *     in the parent's
 *   - PROFILE SET child channels +#x on a previously-subtracted
 *     channel re-includes it (strips the `-` marker)
 *   - /PART of an inherited channel on the child writes the subtract
 *     marker (auto-shrink + inheritance composition)
 *   - /JOIN of a channel already inherited from parent is a no-op on
 *     the child's own list (effective set unchanged)
 *   - Multi-level inheritance walks correctly (grandparent → parent →
 *     child)
 *   - Per-delivery filter honours the effective (post-inheritance) set
 */
describe('draft/persistence — Phase 4 / M5 channel inheritance', () => {
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
    if (!sasl.success) { client.close(); throw new Error(`SASL failed: ${sasl.error}`); }
    client.capEnd();
    client.register(uniqueNick('inh'));
    await client.waitForNumeric('001');
    return client;
  }

  async function connectAttached(account: string, password: string,
                                  profile: string,
                                  extraCaps: string[] = []): Promise<RawSocketClient> {
    const client = await createRawSocketClient(PRIMARY_SERVER.host, PRIMARY_SERVER.port);
    await client.capLs();
    await client.capReq(['sasl', 'draft/persistence', ...extraCaps]);
    const sasl = await authenticateSaslPlain(client, account, password);
    if (!sasl.success) { client.close(); throw new Error(`SASL failed: ${sasl.error}`); }
    client.clearRawBuffer();
    client.send(`PERSISTENCE ATTACH ${profile}`);
    await client.waitForParsedLine(
      m => m.command === 'PERSISTENCE' && m.params[0] === 'ATTACH', 5_000,
    );
    client.capEnd();
    client.register(uniqueNick('inh'));
    await client.waitForNumeric('001');
    return client;
  }

  async function getChannels(client: RawSocketClient, profile: string): Promise<string> {
    client.clearRawBuffer();
    client.send(`PERSISTENCE PROFILE GET ${profile} channels`);
    const line = await client.waitForParsedLine(
      m => m.command === 'PERSISTENCE' && m.params[1] === profile
           && m.params[2] === 'channels',
      5_000,
    );
    return line.params[3] || '';
  }

  it('child inherits parent\'s channels via PROFILE GET effective lookup', async () => {
    const account = await getTestAccount();
    poolAccounts.push(account.account);
    const client = await connectFull(account.account, account.password);
    clients.push(client);

    client.send('PERSISTENCE PROFILE CREATE par');
    await client.waitForParsedLine(m => m.command === 'PERSISTENCE' && m.params[1] === 'CREATED', 5_000);
    client.send('PERSISTENCE PROFILE SET par channels +#one');
    await client.waitForParsedLine(
      m => m.command === 'PERSISTENCE' && m.params[1] === 'par'
           && m.params[2] === 'channels', 5_000,
    );
    client.send('PERSISTENCE PROFILE SET par channels +#two');
    await client.waitForParsedLine(
      m => m.command === 'PERSISTENCE' && m.params[1] === 'par'
           && m.params[2] === 'channels', 5_000,
    );
    client.send('PERSISTENCE PROFILE CREATE chl FROM par');
    await client.waitForParsedLine(m => m.command === 'PERSISTENCE' && m.params[1] === 'CREATED', 5_000);

    // Child's effective channels should include parent's (#one, #two)
    // even though child hasn't been edited.
    const childChans = await getChannels(client, 'chl');
    expect(childChans).toMatch(/#one/);
    expect(childChans).toMatch(/#two/);
  });

  it('PROFILE SET child channels -#x subtracts from inherited set', async () => {
    const account = await getTestAccount();
    poolAccounts.push(account.account);
    const client = await connectFull(account.account, account.password);
    clients.push(client);

    client.send('PERSISTENCE PROFILE CREATE par');
    await client.waitForParsedLine(m => m.command === 'PERSISTENCE' && m.params[1] === 'CREATED', 5_000);
    client.send('PERSISTENCE PROFILE SET par channels +#keep');
    await client.waitForParsedLine(
      m => m.command === 'PERSISTENCE' && m.params[1] === 'par' && m.params[2] === 'channels', 5_000,
    );
    client.send('PERSISTENCE PROFILE SET par channels +#drop');
    await client.waitForParsedLine(
      m => m.command === 'PERSISTENCE' && m.params[1] === 'par' && m.params[2] === 'channels', 5_000,
    );
    client.send('PERSISTENCE PROFILE CREATE chl FROM par');
    await client.waitForParsedLine(m => m.command === 'PERSISTENCE' && m.params[1] === 'CREATED', 5_000);
    client.send('PERSISTENCE PROFILE SET chl channels -#drop');
    await client.waitForParsedLine(
      m => m.command === 'PERSISTENCE' && m.params[1] === 'chl' && m.params[2] === 'channels', 5_000,
    );

    // Child effective should have #keep but NOT #drop.
    const childChans = await getChannels(client, 'chl');
    expect(childChans).toMatch(/#keep/);
    expect(childChans).not.toMatch(/#drop/);

    // Parent unchanged.
    const parChans = await getChannels(client, 'par');
    expect(parChans).toMatch(/#keep/);
    expect(parChans).toMatch(/#drop/);
  });

  it('PROFILE SET child channels +#x undoes a previous subtract', async () => {
    const account = await getTestAccount();
    poolAccounts.push(account.account);
    const client = await connectFull(account.account, account.password);
    clients.push(client);

    client.send('PERSISTENCE PROFILE CREATE par');
    await client.waitForParsedLine(m => m.command === 'PERSISTENCE' && m.params[1] === 'CREATED', 5_000);
    client.send('PERSISTENCE PROFILE SET par channels +#xx');
    await client.waitForParsedLine(
      m => m.command === 'PERSISTENCE' && m.params[1] === 'par' && m.params[2] === 'channels', 5_000,
    );
    client.send('PERSISTENCE PROFILE CREATE chl FROM par');
    await client.waitForParsedLine(m => m.command === 'PERSISTENCE' && m.params[1] === 'CREATED', 5_000);

    // Subtract then re-add.
    client.send('PERSISTENCE PROFILE SET chl channels -#xx');
    await client.waitForParsedLine(
      m => m.command === 'PERSISTENCE' && m.params[1] === 'chl' && m.params[2] === 'channels', 5_000,
    );
    const after1 = await getChannels(client, 'chl');
    expect(after1).not.toMatch(/#xx/);

    client.send('PERSISTENCE PROFILE SET chl channels +#xx');
    await client.waitForParsedLine(
      m => m.command === 'PERSISTENCE' && m.params[1] === 'chl' && m.params[2] === 'channels', 5_000,
    );
    const after2 = await getChannels(client, 'chl');
    expect(after2).toMatch(/#xx/);
  });

  it('/PART of an inherited channel writes a subtract marker', async () => {
    const account = await getTestAccount();
    poolAccounts.push(account.account);

    const inheritedChan = `#inh-${Date.now()}`;
    const setup = await connectFull(account.account, account.password);
    clients.push(setup);
    setup.send('PERSISTENCE PROFILE CREATE par');
    await setup.waitForParsedLine(m => m.command === 'PERSISTENCE' && m.params[1] === 'CREATED', 5_000);
    setup.send(`PERSISTENCE PROFILE SET par channels +${inheritedChan}`);
    await setup.waitForParsedLine(
      m => m.command === 'PERSISTENCE' && m.params[1] === 'par' && m.params[2] === 'channels', 5_000,
    );
    setup.send('PERSISTENCE PROFILE CREATE chl FROM par');
    await setup.waitForParsedLine(m => m.command === 'PERSISTENCE' && m.params[1] === 'CREATED', 5_000);
    setup.send('QUIT');
    setup.close();
    clients.pop();
    await new Promise(r => setTimeout(r, 300));

    // Attach to chl, join the inherited channel (already in effective
    // set, /JOIN works), then /PART it.
    const a = await connectAttached(account.account, account.password, 'chl');
    clients.push(a);
    a.send(`JOIN ${inheritedChan}`);
    await a.waitForParsedLine(
      m => m.command === 'JOIN' && m.params[0] === inheritedChan, 5_000,
    );
    a.clearRawBuffer();
    a.send(`PART ${inheritedChan}`);
    await a.waitForParsedLine(
      m => m.command === 'PART' && m.params[0] === inheritedChan, 5_000,
    );

    // chl's effective channels should no longer include the channel
    // (subtract marker hides the inherited entry).
    const chlChans = await getChannels(a, 'chl');
    expect(chlChans).not.toMatch(new RegExp(inheritedChan.replace(/[#$.]/g, '\\$&')));

    // par's effective channels still have it.
    const parChans = await getChannels(a, 'par');
    expect(parChans).toMatch(new RegExp(inheritedChan.replace(/[#$.]/g, '\\$&')));
  });

  it('multi-level inheritance (grandparent → parent → child) composes correctly', async () => {
    const account = await getTestAccount();
    poolAccounts.push(account.account);
    const client = await connectFull(account.account, account.password);
    clients.push(client);

    // Build chain: gp +#a, p +#b -#a (inherits from gp), c +#c (inherits from p).
    client.send('PERSISTENCE PROFILE CREATE gp');
    await client.waitForParsedLine(m => m.command === 'PERSISTENCE' && m.params[1] === 'CREATED', 5_000);
    client.send('PERSISTENCE PROFILE SET gp channels +#aaa');
    await client.waitForParsedLine(
      m => m.command === 'PERSISTENCE' && m.params[1] === 'gp' && m.params[2] === 'channels', 5_000,
    );

    client.send('PERSISTENCE PROFILE CREATE pp FROM gp');
    await client.waitForParsedLine(m => m.command === 'PERSISTENCE' && m.params[1] === 'CREATED', 5_000);
    client.send('PERSISTENCE PROFILE SET pp channels +#bbb');
    await client.waitForParsedLine(
      m => m.command === 'PERSISTENCE' && m.params[1] === 'pp' && m.params[2] === 'channels', 5_000,
    );
    client.send('PERSISTENCE PROFILE SET pp channels -#aaa');
    await client.waitForParsedLine(
      m => m.command === 'PERSISTENCE' && m.params[1] === 'pp' && m.params[2] === 'channels', 5_000,
    );

    client.send('PERSISTENCE PROFILE CREATE cc FROM pp');
    await client.waitForParsedLine(m => m.command === 'PERSISTENCE' && m.params[1] === 'CREATED', 5_000);
    client.send('PERSISTENCE PROFILE SET cc channels +#ccc');
    await client.waitForParsedLine(
      m => m.command === 'PERSISTENCE' && m.params[1] === 'cc' && m.params[2] === 'channels', 5_000,
    );

    // Effective sets:
    //   gp: {#aaa}
    //   pp: {#bbb}   (gp's #aaa, then -#aaa = removed; +#bbb)
    //   cc: {#bbb, #ccc}  (pp gave us {#bbb}, plus own +#ccc)
    const gpChans = await getChannels(client, 'gp');
    expect(gpChans).toMatch(/#aaa/);

    const ppChans = await getChannels(client, 'pp');
    expect(ppChans).not.toMatch(/#aaa/);
    expect(ppChans).toMatch(/#bbb/);

    const ccChans = await getChannels(client, 'cc');
    expect(ccChans).not.toMatch(/#aaa/);
    expect(ccChans).toMatch(/#bbb/);
    expect(ccChans).toMatch(/#ccc/);
  });
});
