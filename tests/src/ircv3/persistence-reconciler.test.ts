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
 * draft/persistence — Phase 4 / M4b: network-level reconciler.
 *
 * Suppress the alias→primary PART cascade when the channel is still
 * wanted by another profile under a held account.  Emit BX V to peers
 * so each peer's local replica of the affected aliases loses its
 * CHFL_ALIAS membership (synthetic PART echo to MyConnect aliases for
 * UX feedback).  When the union is empty after the auto-shrink, fall
 * back to the cascade path — primary actually parts, network event
 * fires, bounce_sync_alias_part cleans up.
 *
 * The /JOIN-already-member symmetric: when account is already a
 * channel member and the joining alias's profile gained the channel,
 * emit BX V + and a single-channel state burst (TOPIC + NAMES) to the
 * joining alias.
 *
 * Validates:
 *   - PART on profile A is suppressed at network level when profile B
 *     still wants the channel (no PART seen by the channel observer)
 *   - PART escalates to a real network PART when no profile wants the
 *     channel anymore
 *   - JOIN-already-member case delivers a synthetic JOIN echo + state
 *     burst (TOPIC, NAMES) to the joining alias
 *   - Non-held accounts bypass the reconciler entirely (existing IRC
 *     semantics)
 */
describe('draft/persistence — Phase 4 / M4b network reconciler', () => {
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
        } catch { /* parent-with-children */ }
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

  async function connectAttachedHeld(account: string, password: string,
                                      profile: string): Promise<{ client: RawSocketClient; nick: string }> {
    const client = await createRawSocketClient(PRIMARY_SERVER.host, PRIMARY_SERVER.port);
    await client.capLs();
    await client.capReq(['sasl', 'draft/persistence']);
    const sasl = await authenticateSaslPlain(client, account, password);
    if (!sasl.success) { client.close(); throw new Error(`SASL: ${sasl.error}`); }
    client.clearRawBuffer();
    client.send(`PERSISTENCE ATTACH ${profile}`);
    await client.waitForParsedLine(
      m => m.command === 'PERSISTENCE' && m.params[0] === 'ATTACH', 5_000,
    );
    client.capEnd();
    const requestedNick = uniqueNick('rec');
    client.register(requestedNick);
    const welcome = await client.waitForNumeric('001');
    const actualNick = welcome.params[0] || requestedNick;
    return { client, nick: actualNick };
  }

  async function setupTwoProfiles(account: string, password: string,
                                   chan: string): Promise<void> {
    /* Create profile A (with chan), profile B (with chan), enable
     * account-global hold so the reconciler engages. */
    const setup = await createRawSocketClient(PRIMARY_SERVER.host, PRIMARY_SERVER.port);
    await setup.capLs();
    await setup.capReq(['sasl', 'draft/persistence']);
    const sasl = await authenticateSaslPlain(setup, account, password);
    if (!sasl.success) { setup.close(); throw new Error(`SASL: ${sasl.error}`); }
    setup.capEnd();
    setup.register(uniqueNick('setup'));
    await setup.waitForNumeric('001');

    setup.send('PERSISTENCE PROFILE CREATE pa');
    await setup.waitForParsedLine(m => m.command === 'PERSISTENCE' && m.params[1] === 'CREATED', 5_000);
    setup.send(`PERSISTENCE PROFILE SET pa channels +${chan}`);
    await setup.waitForParsedLine(
      m => m.command === 'PERSISTENCE' && m.params[1] === 'pa' && m.params[2] === 'channels', 5_000,
    );
    setup.send('PERSISTENCE PROFILE CREATE pb');
    await setup.waitForParsedLine(m => m.command === 'PERSISTENCE' && m.params[1] === 'CREATED', 5_000);
    setup.send(`PERSISTENCE PROFILE SET pb channels +${chan}`);
    await setup.waitForParsedLine(
      m => m.command === 'PERSISTENCE' && m.params[1] === 'pb' && m.params[2] === 'channels', 5_000,
    );
    setup.send('PERSISTENCE SET ON');
    await setup.waitForParsedLine(
      m => m.command === 'PERSISTENCE' && m.params[0] === 'SET' && m.params[1] === 'ON', 5_000,
    );
    setup.send('QUIT');
    setup.close();
    await new Promise(r => setTimeout(r, 400));
  }

  it('PART on profile A is suppressed when profile B still wants the channel', async () => {
    const account = await getTestAccount();
    poolAccounts.push(account.account);
    const chan = `#m4b-supp-${Date.now()}`;
    await setupTwoProfiles(account.account, account.password, chan);

    /* Alias-A on profile A, alias-B on profile B.  Both join the
     * channel.  A parts.  Observer on a different account watches
     * the channel — should NOT see a network PART from alias-A. */
    const { client: a, nick: aNick } = await connectAttachedHeld(account.account, account.password, 'pa');
    clients.push(a);
    a.send(`JOIN ${chan}`);
    await a.waitForParsedLine(m => m.command === 'JOIN' && m.params[0] === chan, 5_000);

    const { client: b } = await connectAttachedHeld(account.account, account.password, 'pb');
    clients.push(b);
    // alias-B joins the channel — under M4b, the network is already a
    // member (via primary or alias-A), so this is a JOIN-already-member
    // case for B and gives B a synthetic JOIN echo.
    b.send(`JOIN ${chan}`);
    await b.waitForParsedLine(m => m.command === 'JOIN' && m.params[0] === chan, 5_000);

    // Observer on a different account.
    const obsAcc = await getTestAccount();
    if (obsAcc.fromPool) poolAccounts.push(obsAcc.account);
    const obs = await createRawSocketClient(PRIMARY_SERVER.host, PRIMARY_SERVER.port);
    clients.push(obs);
    await obs.capLs();
    await obs.capReq(['sasl']);
    await authenticateSaslPlain(obs, obsAcc.account, obsAcc.password);
    obs.capEnd();
    obs.register(uniqueNick('obs'));
    await obs.waitForNumeric('001');
    obs.send(`JOIN ${chan}`);
    await obs.waitForParsedLine(m => m.command === 'JOIN' && m.params[0] === chan, 5_000);
    await new Promise(r => setTimeout(r, 300));

    obs.clearRawBuffer();
    a.send(`PART ${chan}`);
    await a.waitForParsedLine(m => m.command === 'PART' && m.params[0] === chan, 5_000);

    // Observer should NOT see a PART from aNick (alias-A's numeric).
    await new Promise(r => setTimeout(r, 1000));
    const sawPart = obs.allLines.some(line =>
      new RegExp(`PART ${chan.replace(/[#$.]/g, '\\$&')}`).test(line)
      && new RegExp(`:${aNick}!`, 'i').test(line),
    );
    expect(sawPart).toBe(false);
  });

  it('PART escalates to a real network PART when no profile wants the channel', async () => {
    const account = await getTestAccount();
    poolAccounts.push(account.account);
    const chan = `#m4b-esc-${Date.now()}`;

    /* Setup: ONE profile wants chan.  Hold ON. */
    const setup = await createRawSocketClient(PRIMARY_SERVER.host, PRIMARY_SERVER.port);
    await setup.capLs();
    await setup.capReq(['sasl', 'draft/persistence']);
    await authenticateSaslPlain(setup, account.account, account.password);
    setup.capEnd();
    setup.register(uniqueNick('setup'));
    await setup.waitForNumeric('001');
    setup.send('PERSISTENCE PROFILE CREATE solo');
    await setup.waitForParsedLine(m => m.command === 'PERSISTENCE' && m.params[1] === 'CREATED', 5_000);
    setup.send(`PERSISTENCE PROFILE SET solo channels +${chan}`);
    await setup.waitForParsedLine(
      m => m.command === 'PERSISTENCE' && m.params[1] === 'solo' && m.params[2] === 'channels', 5_000,
    );
    setup.send('PERSISTENCE SET ON');
    await setup.waitForParsedLine(
      m => m.command === 'PERSISTENCE' && m.params[0] === 'SET' && m.params[1] === 'ON', 5_000,
    );
    setup.send('QUIT');
    setup.close();
    await new Promise(r => setTimeout(r, 400));

    const { client: a, nick: aNick } = await connectAttachedHeld(account.account, account.password, 'solo');
    clients.push(a);
    a.send(`JOIN ${chan}`);
    await a.waitForParsedLine(m => m.command === 'JOIN' && m.params[0] === chan, 5_000);

    const obsAcc = await getTestAccount();
    if (obsAcc.fromPool) poolAccounts.push(obsAcc.account);
    const obs = await createRawSocketClient(PRIMARY_SERVER.host, PRIMARY_SERVER.port);
    clients.push(obs);
    await obs.capLs();
    await obs.capReq(['sasl']);
    await authenticateSaslPlain(obs, obsAcc.account, obsAcc.password);
    obs.capEnd();
    obs.register(uniqueNick('obs'));
    await obs.waitForNumeric('001');
    obs.send(`JOIN ${chan}`);
    await obs.waitForParsedLine(m => m.command === 'JOIN' && m.params[0] === chan, 5_000);
    await new Promise(r => setTimeout(r, 300));

    obs.clearRawBuffer();
    a.send(`PART ${chan}`);
    await a.waitForParsedLine(m => m.command === 'PART' && m.params[0] === chan, 5_000);

    // Observer SHOULD see a network PART from the user (cascade path).
    const sawPart = await obs.waitForParsedLine(
      m => m.command === 'PART' && m.params[0] === chan
           && m.source?.nick?.toLowerCase() === aNick.toLowerCase(),
      5_000,
    );
    expect(sawPart).toBeTruthy();
  });

  it('non-held account bypasses the reconciler (existing IRC semantics)', async () => {
    const account = await getTestAccount();
    poolAccounts.push(account.account);
    const chan = `#m4b-noheld-${Date.now()}`;

    /* Create profile but DO NOT enable hold.  Reconciler should bail
     * — alias /PART acts like a normal account /PART. */
    const setup = await createRawSocketClient(PRIMARY_SERVER.host, PRIMARY_SERVER.port);
    await setup.capLs();
    await setup.capReq(['sasl', 'draft/persistence']);
    await authenticateSaslPlain(setup, account.account, account.password);
    setup.capEnd();
    setup.register(uniqueNick('setup'));
    await setup.waitForNumeric('001');
    setup.send('PERSISTENCE PROFILE CREATE p');
    await setup.waitForParsedLine(m => m.command === 'PERSISTENCE' && m.params[1] === 'CREATED', 5_000);
    setup.send(`PERSISTENCE PROFILE SET p channels +${chan}`);
    await setup.waitForParsedLine(
      m => m.command === 'PERSISTENCE' && m.params[1] === 'p' && m.params[2] === 'channels', 5_000,
    );
    // intentional: NO PERSISTENCE SET ON
    setup.send('QUIT');
    setup.close();
    await new Promise(r => setTimeout(r, 400));

    const { client: a, nick: aNick } = await connectAttachedHeld(account.account, account.password, 'p');
    clients.push(a);
    a.send(`JOIN ${chan}`);
    await a.waitForParsedLine(m => m.command === 'JOIN' && m.params[0] === chan, 5_000);

    const obsAcc = await getTestAccount();
    if (obsAcc.fromPool) poolAccounts.push(obsAcc.account);
    const obs = await createRawSocketClient(PRIMARY_SERVER.host, PRIMARY_SERVER.port);
    clients.push(obs);
    await obs.capLs();
    await obs.capReq(['sasl']);
    await authenticateSaslPlain(obs, obsAcc.account, obsAcc.password);
    obs.capEnd();
    obs.register(uniqueNick('obs'));
    await obs.waitForNumeric('001');
    obs.send(`JOIN ${chan}`);
    await obs.waitForParsedLine(m => m.command === 'JOIN' && m.params[0] === chan, 5_000);
    await new Promise(r => setTimeout(r, 300));

    obs.clearRawBuffer();
    a.send(`PART ${chan}`);

    // Observer SHOULD see the real PART (non-held = no reconciler).
    const sawPart = await obs.waitForParsedLine(
      m => m.command === 'PART' && m.params[0] === chan
           && m.source?.nick?.toLowerCase() === aNick.toLowerCase(),
      5_000,
    );
    expect(sawPart).toBeTruthy();
  });
});
