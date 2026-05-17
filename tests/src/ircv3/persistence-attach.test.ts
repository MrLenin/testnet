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
 * draft/persistence — Phase 4 / M2: PERSISTENCE ATTACH + active-profile
 * state.
 *
 * Wire surface under test:
 *   PERSISTENCE ATTACH <profile>          (pre-CAP-END only)
 *
 * Validates:
 *   - ATTACH between SASL success and CAP END pins the active profile
 *   - ATTACH unknown-profile → FAIL INVALID_PARAMETERS
 *   - ATTACH without prior SASL → FAIL ACCOUNT_REQUIRED
 *   - ATTACH after registration (post-CAP-END) → FAIL INVALID_PARAMETERS
 *   - STATUS resolves through the active profile: setting `hold` on the
 *     attached profile via PROFILE SET overrides account-global
 *     bouncer/hold for that connection's reported STATUS
 *   - Active profile is per-connection (a second connection on the
 *     same account without ATTACH sees the default-profile/global state)
 */
describe('draft/persistence — Phase 4 / M2 ATTACH + active profile', () => {
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

  /** Connect, do SASL, but DO NOT send CAP END / NICK / USER yet —
   * leaves the client in the pre-CAP-END window where ATTACH is valid. */
  async function connectSaslOnly(account: string, password: string): Promise<RawSocketClient> {
    const client = await createRawSocketClient(PRIMARY_SERVER.host, PRIMARY_SERVER.port);
    await client.capLs();
    await client.capReq(['sasl', 'draft/persistence']);
    const sasl = await authenticateSaslPlain(client, account, password);
    if (!sasl.success) {
      client.close();
      throw new Error(`SASL failed: ${sasl.error}`);
    }
    return client;
  }

  async function completeRegistration(client: RawSocketClient): Promise<void> {
    client.capEnd();
    client.register(uniqueNick('att'));
    await client.waitForNumeric('001');
  }

  /** Helper: do the full registration in one shot. */
  async function connectFull(account: string, password: string): Promise<RawSocketClient> {
    const client = await connectSaslOnly(account, password);
    await completeRegistration(client);
    return client;
  }

  it('ATTACH pre-CAP-END to existing profile pins the active profile', async () => {
    const account = await getTestAccount();
    poolAccounts.push(account.account);

    // First connection: create a profile.
    const setup = await connectFull(account.account, account.password);
    clients.push(setup);
    setup.send('PERSISTENCE PROFILE CREATE mobile');
    await setup.waitForParsedLine(
      m => m.command === 'PERSISTENCE' && m.params[1] === 'CREATED', 5_000,
    );
    setup.send('QUIT');
    setup.close();
    clients.pop();

    // Second connection: SASL, ATTACH mobile pre-CAP-END.
    const client = await connectSaslOnly(account.account, account.password);
    clients.push(client);
    client.clearRawBuffer();
    client.send('PERSISTENCE ATTACH mobile');
    const ack = await client.waitForParsedLine(
      m => m.command === 'PERSISTENCE' && m.params[0] === 'ATTACH',
      5_000,
    );
    expect(ack.params[1]).toBe('mobile');
    await completeRegistration(client);
  });

  it('ATTACH to a nonexistent profile fails', async () => {
    const account = await getTestAccount();
    poolAccounts.push(account.account);

    const client = await connectSaslOnly(account.account, account.password);
    clients.push(client);
    client.clearRawBuffer();
    client.send('PERSISTENCE ATTACH nope_no_such_profile');
    const fail = await client.waitForParsedLine(
      m => m.command === 'FAIL' && m.params[0] === 'PERSISTENCE',
      5_000,
    );
    expect(fail.params[1]).toBe('INVALID_PARAMETERS');
    await completeRegistration(client);
  });

  it('ATTACH without SASL fails with ACCOUNT_REQUIRED', async () => {
    const client = await createRawSocketClient(PRIMARY_SERVER.host, PRIMARY_SERVER.port);
    clients.push(client);
    await client.capLs();
    await client.capReq(['draft/persistence']);
    client.clearRawBuffer();
    client.send('PERSISTENCE ATTACH default');
    const fail = await client.waitForParsedLine(
      m => m.command === 'FAIL' && m.params[0] === 'PERSISTENCE',
      5_000,
    );
    expect(fail.params[1]).toBe('ACCOUNT_REQUIRED');
    client.capEnd();
    client.register(uniqueNick('att'));
    await client.waitForNumeric('001');
  });

  it('ATTACH after registration is refused (Q1 — no mid-session swap)', async () => {
    const account = await getTestAccount();
    poolAccounts.push(account.account);

    const client = await connectFull(account.account, account.password);
    clients.push(client);
    client.clearRawBuffer();
    client.send('PERSISTENCE ATTACH default');
    const fail = await client.waitForParsedLine(
      m => m.command === 'FAIL' && m.params[0] === 'PERSISTENCE',
      5_000,
    );
    expect(fail.params[1]).toBe('INVALID_PARAMETERS');
  });

  it('STATUS resolves through the active profile (profile hold beats account-global)', async () => {
    const account = await getTestAccount();
    poolAccounts.push(account.account);

    // Setup: create profile "ho", set its hold to "1", set account-global
    // hold to "0".  STATUS on a connection attached to "ho" should
    // report ON (profile chain wins over account-global).
    const setup = await connectFull(account.account, account.password);
    clients.push(setup);
    setup.send('PERSISTENCE PROFILE CREATE ho');
    await setup.waitForParsedLine(
      m => m.command === 'PERSISTENCE' && m.params[1] === 'CREATED', 5_000,
    );
    setup.send('PERSISTENCE PROFILE SET ho hold 1');
    await setup.waitForParsedLine(
      m => m.command === 'PERSISTENCE' && m.params[0] === 'PROFILE'
           && m.params[1] === 'ho' && m.params[2] === 'hold', 5_000,
    );
    setup.send('PERSISTENCE SET OFF');  /* account-global = 0 */
    await setup.waitForParsedLine(
      m => m.command === 'PERSISTENCE' && m.params[0] === 'SET'
           && m.params[1] === 'OFF', 5_000,
    );
    setup.send('QUIT');
    setup.close();
    clients.pop();
    await new Promise(r => setTimeout(r, 300));

    // New connection attached to "ho".  STATUS should be ON.
    const attached = await connectSaslOnly(account.account, account.password);
    clients.push(attached);
    attached.clearRawBuffer();
    attached.send('PERSISTENCE ATTACH ho');
    await attached.waitForParsedLine(
      m => m.command === 'PERSISTENCE' && m.params[0] === 'ATTACH', 5_000,
    );
    await completeRegistration(attached);

    // Unsolicited STATUS at registration end:
    const status = await attached.waitForParsedLine(
      m => m.command === 'PERSISTENCE' && m.params[0] === 'STATUS', 10_000,
    );
    expect(status.params[1]).toBe('ON');
  });

  it('active profile is per-connection (concurrent connection without ATTACH sees account-global)', async () => {
    const account = await getTestAccount();
    poolAccounts.push(account.account);

    // Setup: create profile "iso", set its hold to "1", account-global "0".
    const setup = await connectFull(account.account, account.password);
    clients.push(setup);
    setup.send('PERSISTENCE PROFILE CREATE iso');
    await setup.waitForParsedLine(
      m => m.command === 'PERSISTENCE' && m.params[1] === 'CREATED', 5_000,
    );
    setup.send('PERSISTENCE PROFILE SET iso hold 1');
    await setup.waitForParsedLine(
      m => m.command === 'PERSISTENCE' && m.params[0] === 'PROFILE'
           && m.params[1] === 'iso' && m.params[2] === 'hold', 5_000,
    );
    setup.send('PERSISTENCE SET OFF');
    await setup.waitForParsedLine(
      m => m.command === 'PERSISTENCE' && m.params[0] === 'SET'
           && m.params[1] === 'OFF', 5_000,
    );
    setup.send('QUIT');
    setup.close();
    clients.pop();
    await new Promise(r => setTimeout(r, 300));

    // Connection A: ATTACH iso, expects STATUS ON.
    const a = await connectSaslOnly(account.account, account.password);
    clients.push(a);
    a.send('PERSISTENCE ATTACH iso');
    await a.waitForParsedLine(
      m => m.command === 'PERSISTENCE' && m.params[0] === 'ATTACH', 5_000,
    );
    await completeRegistration(a);
    const sa = await a.waitForParsedLine(
      m => m.command === 'PERSISTENCE' && m.params[0] === 'STATUS', 10_000,
    );
    expect(sa.params[1]).toBe('ON');

    // Connection B: same account, no ATTACH — falls back to default
    // profile (which has nothing set) then account-global (OFF).
    const b = await connectSaslOnly(account.account, account.password);
    clients.push(b);
    await completeRegistration(b);
    const sb = await b.waitForParsedLine(
      m => m.command === 'PERSISTENCE' && m.params[0] === 'STATUS', 10_000,
    );
    expect(sb.params[1]).toBe('OFF');
  });
});
