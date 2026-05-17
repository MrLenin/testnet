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
 * draft/persistence — Phase 4 / M4a: /JOIN auto-grow + /PART
 * auto-shrink for the active profile's channel list.
 *
 * Q7 from the design doc: "/JOIN #x from a client on profile A adds
 * #x to A's channel list (and joins #x at the network level)."  This
 * milestone implements the auto-grow / auto-shrink half; the
 * network-level suppression + HOLD-sticky reconciler is M4b
 * (deferred follow-up).
 *
 * Validates:
 *   - /JOIN on a profile with a non-empty channel list auto-grows
 *     the list AND the joining client now sees the channel's traffic
 *     (which under the M3 filter requires the channel to be in the
 *     list)
 *   - /PART auto-shrinks the list
 *   - /JOIN on the default profile (empty list = no filter) does
 *     NOT grow the list — legacy clients keep working transparently
 */
describe('draft/persistence — Phase 4 / M4a JOIN/PART auto edit', () => {
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
    client.register(uniqueNick('rec'));
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
    client.register(uniqueNick('rec'));
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

  it('/JOIN on filtered profile auto-grows the list AND delivers the JOIN to the joining client', async () => {
    const account = await getTestAccount();
    poolAccounts.push(account.account);

    // Setup: profile "g" with a seed channel so the list is non-empty.
    const seed = `#seed-${Date.now()}`;
    const target = `#grow-${Date.now()}`;
    const setup = await connectFull(account.account, account.password);
    clients.push(setup);
    setup.send('PERSISTENCE PROFILE CREATE g');
    await setup.waitForParsedLine(m => m.command === 'PERSISTENCE' && m.params[1] === 'CREATED', 5_000);
    setup.send(`PERSISTENCE PROFILE SET g channels +${seed}`);
    await setup.waitForParsedLine(
      m => m.command === 'PERSISTENCE' && m.params[1] === 'g' && m.params[2] === 'channels', 5_000,
    );
    setup.send('QUIT');
    setup.close();
    clients.pop();
    await new Promise(r => setTimeout(r, 300));

    // Reconnect attached to "g".  /JOIN target should grow the list.
    const client = await connectAttached(account.account, account.password, 'g');
    clients.push(client);
    client.clearRawBuffer();
    client.send(`JOIN ${target}`);
    const join = await client.waitForParsedLine(
      m => m.command === 'JOIN' && m.params[0] === target, 5_000,
    );
    expect(join).toBeTruthy();

    // Verify the profile's channels list now includes target.
    const channels = await getChannels(client, 'g');
    expect(channels).toMatch(new RegExp(target.replace(/[#$.]/g, '\\$&')));
  });

  it('/PART auto-shrinks the active profile\'s channel list', async () => {
    const account = await getTestAccount();
    poolAccounts.push(account.account);

    const seed = `#sh-seed-${Date.now()}`;
    const target = `#sh-target-${Date.now()}`;
    const setup = await connectFull(account.account, account.password);
    clients.push(setup);
    setup.send('PERSISTENCE PROFILE CREATE sh');
    await setup.waitForParsedLine(m => m.command === 'PERSISTENCE' && m.params[1] === 'CREATED', 5_000);
    setup.send(`PERSISTENCE PROFILE SET sh channels +${seed}`);
    await setup.waitForParsedLine(
      m => m.command === 'PERSISTENCE' && m.params[1] === 'sh' && m.params[2] === 'channels', 5_000,
    );
    setup.send(`PERSISTENCE PROFILE SET sh channels +${target}`);
    await setup.waitForParsedLine(
      m => m.command === 'PERSISTENCE' && m.params[1] === 'sh' && m.params[2] === 'channels', 5_000,
    );
    setup.send('QUIT');
    setup.close();
    clients.pop();
    await new Promise(r => setTimeout(r, 300));

    const client = await connectAttached(account.account, account.password, 'sh');
    clients.push(client);
    client.send(`JOIN ${target}`);
    await client.waitForParsedLine(
      m => m.command === 'JOIN' && m.params[0] === target, 5_000,
    );

    client.clearRawBuffer();
    client.send(`PART ${target}`);
    await client.waitForParsedLine(
      m => m.command === 'PART' && m.params[0] === target, 5_000,
    );

    // The PART should have removed target from the list, but seed remains.
    const channels = await getChannels(client, 'sh');
    expect(channels).not.toMatch(new RegExp(target.replace(/[#$.]/g, '\\$&')));
    expect(channels).toMatch(new RegExp(seed.replace(/[#$.]/g, '\\$&')));
  });

  it('/JOIN on the default profile (empty list) does NOT grow the list (no-filter semantic)', async () => {
    const account = await getTestAccount();
    poolAccounts.push(account.account);

    const target = `#defleg-${Date.now()}`;
    const client = await connectFull(account.account, account.password);
    clients.push(client);

    // Default profile starts with empty channel list.  /JOIN must not
    // grow it — otherwise legacy clients would inadvertently enable
    // filtering on themselves.
    client.send(`JOIN ${target}`);
    await client.waitForParsedLine(
      m => m.command === 'JOIN' && m.params[0] === target, 5_000,
    );

    const channels = await getChannels(client, 'default');
    expect(channels).toBe(''); // still empty
  });
});
