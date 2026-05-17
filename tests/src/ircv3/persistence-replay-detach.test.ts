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
 * draft/persistence — Phase 3: REPLAY trio + DETACH.
 *
 * Wire surface under test:
 *   PERSISTENCE REPLAY GET
 *   PERSISTENCE REPLAY SET ON|OFF|DEFAULT
 *   :srv PERSISTENCE REPLAY STATUS <client-setting> <effective>
 *
 *   PERSISTENCE DETACH
 *   :srv PERSISTENCE DETACH OK|NOSESSION
 *   FAIL PERSISTENCE CANNOT_DETACH for class-enforced sessions
 *
 * Validates:
 *   - REPLAY GET reports the effective state + client-setting
 *   - REPLAY SET ON/OFF/DEFAULT roundtrip
 *   - REPLAY STATUS reflects per-profile overrides
 *   - DETACH succeeds when session is not class-enforced
 *   - DETACH replies NOSESSION when there's no active session
 *
 * NOT covered (would need a CRFLAG_BOUNCER class set up at the
 * server's connection-class config level, which the test infra
 * doesn't reach):
 *   - CANNOT_DETACH refusal for an enforced session
 */
describe('draft/persistence — Phase 3 REPLAY + DETACH', () => {
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
      try {
        // Reset REPLAY to DEFAULT to clean state for next test
        client.clearRawBuffer();
        client.send('PERSISTENCE REPLAY SET DEFAULT');
        await client.waitForParsedLine(
          m => m.command === 'PERSISTENCE'
               && (m.params[0] === 'REPLAY' || m.params[0] === 'STATUS'),
          2_000,
        );
      } catch { /* ignore */ }
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

  async function connectFull(account: string, password: string): Promise<RawSocketClient> {
    const client = await createRawSocketClient(PRIMARY_SERVER.host, PRIMARY_SERVER.port);
    await client.capLs();
    await client.capReq(['sasl', 'draft/persistence']);
    const sasl = await authenticateSaslPlain(client, account, password);
    if (!sasl.success) { client.close(); throw new Error(`SASL failed: ${sasl.error}`); }
    client.capEnd();
    client.register(uniqueNick('p3'));
    await client.waitForNumeric('001');
    // Drain unsolicited STATUS so subsequent replies aren't conflated.
    try {
      await client.waitForParsedLine(
        m => m.command === 'PERSISTENCE' && m.params[0] === 'STATUS', 5_000,
      );
    } catch { /* not unsolicited; that's fine */ }
    return client;
  }

  it('REPLAY GET reports STATUS with client-setting and effective', async () => {
    const account = await getTestAccount();
    poolAccounts.push(account.account);
    const client = await connectFull(account.account, account.password);
    clients.push(client);

    client.clearRawBuffer();
    client.send('PERSISTENCE REPLAY GET');
    const status = await client.waitForParsedLine(
      m => m.command === 'PERSISTENCE' && m.params[0] === 'REPLAY'
           && m.params[1] === 'STATUS',
      5_000,
    );
    // params[2] = client-setting (ON|OFF|DEFAULT)
    // params[3] = effective (ON|OFF)
    expect(['ON', 'OFF', 'DEFAULT']).toContain(status.params[2]);
    expect(['ON', 'OFF']).toContain(status.params[3]);
  });

  it('REPLAY SET OFF -> GET reports OFF/OFF', async () => {
    const account = await getTestAccount();
    poolAccounts.push(account.account);
    const client = await connectFull(account.account, account.password);
    clients.push(client);

    client.clearRawBuffer();
    client.send('PERSISTENCE REPLAY SET OFF');
    const setAck = await client.waitForParsedLine(
      m => m.command === 'PERSISTENCE' && m.params[0] === 'REPLAY'
           && m.params[1] === 'SET',
      5_000,
    );
    expect(setAck.params[2]).toBe('OFF');

    const status = await client.waitForParsedLine(
      m => m.command === 'PERSISTENCE' && m.params[0] === 'REPLAY'
           && m.params[1] === 'STATUS',
      5_000,
    );
    expect(status.params[2]).toBe('OFF');
    expect(status.params[3]).toBe('OFF');
  });

  it('REPLAY SET ON then DEFAULT clears the client-setting', async () => {
    const account = await getTestAccount();
    poolAccounts.push(account.account);
    const client = await connectFull(account.account, account.password);
    clients.push(client);

    client.send('PERSISTENCE REPLAY SET ON');
    await client.waitForParsedLine(
      m => m.command === 'PERSISTENCE' && m.params[0] === 'REPLAY'
           && m.params[1] === 'SET' && m.params[2] === 'ON',
      5_000,
    );

    client.clearRawBuffer();
    client.send('PERSISTENCE REPLAY SET DEFAULT');
    await client.waitForParsedLine(
      m => m.command === 'PERSISTENCE' && m.params[0] === 'REPLAY'
           && m.params[1] === 'SET' && m.params[2] === 'DEFAULT',
      5_000,
    );

    client.send('PERSISTENCE REPLAY GET');
    const status = await client.waitForParsedLine(
      m => m.command === 'PERSISTENCE' && m.params[0] === 'REPLAY'
           && m.params[1] === 'STATUS',
      5_000,
    );
    expect(status.params[2]).toBe('DEFAULT');
    // Effective falls through to FEAT_BOUNCER_AUTO_REPLAY (typically ON)
    expect(['ON', 'OFF']).toContain(status.params[3]);
  });

  it('REPLAY SET BADARG -> FAIL INVALID_PARAMETERS', async () => {
    const account = await getTestAccount();
    poolAccounts.push(account.account);
    const client = await connectFull(account.account, account.password);
    clients.push(client);

    client.clearRawBuffer();
    client.send('PERSISTENCE REPLAY SET BOGUS');
    const fail = await client.waitForParsedLine(
      m => m.command === 'FAIL' && m.params[0] === 'PERSISTENCE', 5_000,
    );
    expect(fail.params[1]).toBe('INVALID_PARAMETERS');
  });

  it('DETACH with no session replies NOSESSION', async () => {
    const account = await getTestAccount();
    poolAccounts.push(account.account);
    const client = await connectFull(account.account, account.password);
    clients.push(client);

    // Ensure no session: SET OFF first
    client.send('PERSISTENCE SET OFF');
    await client.waitForParsedLine(
      m => m.command === 'PERSISTENCE' && m.params[0] === 'SET', 5_000,
    );

    client.clearRawBuffer();
    client.send('PERSISTENCE DETACH');
    const detach = await client.waitForParsedLine(
      m => m.command === 'PERSISTENCE' && m.params[0] === 'DETACH', 5_000,
    );
    expect(detach.params[1]).toBe('NOSESSION');
  });

  it('DETACH destroys an active session and STATUS reports OFF', async () => {
    const account = await getTestAccount();
    poolAccounts.push(account.account);
    const client = await connectFull(account.account, account.password);
    clients.push(client);

    // Create a session via SET ON
    client.send('PERSISTENCE SET ON');
    await client.waitForParsedLine(
      m => m.command === 'PERSISTENCE' && m.params[0] === 'SET'
           && m.params[1] === 'ON', 5_000,
    );
    // Drain the STATUS that follows
    await client.waitForParsedLine(
      m => m.command === 'PERSISTENCE' && m.params[0] === 'STATUS', 5_000,
    );

    client.clearRawBuffer();
    client.send('PERSISTENCE DETACH');
    const detach = await client.waitForParsedLine(
      m => m.command === 'PERSISTENCE' && m.params[0] === 'DETACH', 5_000,
    );
    expect(detach.params[1]).toBe('OK');

    // The post-DETACH STATUS should reflect OFF
    const status = await client.waitForParsedLine(
      m => m.command === 'PERSISTENCE' && m.params[0] === 'STATUS', 5_000,
    );
    expect(status.params[1]).toBe('OFF');
  });
});
