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
 * draft/persistence — Phase 4 / M1: profile CRUD + inheritance.
 *
 * Wire surface under test:
 *   PERSISTENCE PROFILE LIST
 *   PERSISTENCE PROFILE CREATE <name> [FROM <parent>]
 *   PERSISTENCE PROFILE DELETE <name>
 *   PERSISTENCE PROFILE RENAME <old> <new>
 *   PERSISTENCE PROFILE GET <name> <key>
 *   PERSISTENCE PROFILE SET <name> <key> <value>|DEFAULT
 *
 * Validates:
 *   - default profile is implicit and always listed
 *   - CREATE / DELETE / RENAME roundtrip
 *   - Inheritance walk: GET on a profile resolves through parent chain
 *   - Cycle refusal when SET parent would create a cycle
 *   - DELETE refused when other profiles inherit from the target
 *   - default profile cannot be deleted or renamed
 *
 * No channels yet (M3 work).  No ATTACH yet (M2 work).  These tests
 * exercise the data layer through the wire surface only.
 */
describe('draft/persistence — Phase 4 / M1 profile CRUD', () => {
  const clients: RawSocketClient[] = [];
  const poolAccounts: string[] = [];

  /** Wipe all custom (non-default) profiles for the account behind
   * `client`.  Pool accounts are reused across tests, so profile state
   * leaks between runs unless we clean up.  Loops up to 5 passes to
   * cope with inheritance — children must be deleted before parents. */
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
      } catch { /* abort pass */ break; }
      if (names.length === 0) return;
      let progressed = false;
      for (const name of names) {
        client.clearRawBuffer();
        client.send(`PERSISTENCE PROFILE DELETE ${name}`);
        try {
          await client.waitForParsedLine(
            m => m.command === 'PERSISTENCE' && m.params[1] === 'DELETED'
                 && m.params[2] === name,
            2_000,
          );
          progressed = true;
        } catch { /* may be parent-with-children; retry next pass */ }
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

  async function connectAuth(account: string, password: string): Promise<RawSocketClient> {
    const client = await createRawSocketClient(PRIMARY_SERVER.host, PRIMARY_SERVER.port);
    await client.capLs();
    await client.capReq(['sasl', 'draft/persistence']);
    const sasl = await authenticateSaslPlain(client, account, password);
    if (!sasl.success) {
      client.close();
      throw new Error(`SASL failed: ${sasl.error}`);
    }
    client.capEnd();
    client.register(uniqueNick('prf'));
    await client.waitForNumeric('001');
    return client;
  }

  /** Drain any unsolicited PERSISTENCE lines so a follow-up command's
   * reply isn't ambiguous with them. */
  async function drainUnsolicited(client: RawSocketClient) {
    try {
      await client.waitForParsedLine(
        m => m.command === 'PERSISTENCE' && m.params[0] === 'STATUS',
        5_000,
      );
    } catch { /* none arrived */ }
  }

  async function listProfiles(client: RawSocketClient): Promise<{ name: string; raw: string }[]> {
    client.clearRawBuffer();
    client.send('PERSISTENCE PROFILE LIST');
    const profiles: { name: string; raw: string }[] = [];
    while (true) {
      const line = await client.waitForParsedLine(
        m => m.command === 'PERSISTENCE'
             && (m.params[0] === 'PROFILE')
             && (m.params[1] !== undefined),
        5_000,
      );
      if (line.params[1] === 'ENDOFLIST') break;
      profiles.push({ name: line.params[1], raw: line.raw });
    }
    return profiles;
  }

  it('PROFILE LIST always includes the implicit default', async () => {
    const account = await getTestAccount();
    poolAccounts.push(account.account);
    const client = await connectAuth(account.account, account.password);
    clients.push(client);
    await drainUnsolicited(client);

    const profiles = await listProfiles(client);
    expect(profiles.find(p => p.name === 'default')).toBeTruthy();
  });

  it('CREATE + LIST + DELETE roundtrip', async () => {
    const account = await getTestAccount();
    poolAccounts.push(account.account);
    const client = await connectAuth(account.account, account.password);
    clients.push(client);
    await drainUnsolicited(client);

    client.clearRawBuffer();
    client.send('PERSISTENCE PROFILE CREATE mobile');
    const created = await client.waitForParsedLine(
      m => m.command === 'PERSISTENCE' && m.params[0] === 'PROFILE'
           && m.params[1] === 'CREATED',
      5_000,
    );
    expect(created.params[2]).toBe('mobile');

    const after = await listProfiles(client);
    expect(after.find(p => p.name === 'mobile')).toBeTruthy();
    expect(after.find(p => p.name === 'mobile')?.raw).toContain('parent=default');

    client.clearRawBuffer();
    client.send('PERSISTENCE PROFILE DELETE mobile');
    const deleted = await client.waitForParsedLine(
      m => m.command === 'PERSISTENCE' && m.params[0] === 'PROFILE'
           && m.params[1] === 'DELETED',
      5_000,
    );
    expect(deleted.params[2]).toBe('mobile');

    const final = await listProfiles(client);
    expect(final.find(p => p.name === 'mobile')).toBeUndefined();
  });

  it('CREATE FROM <parent> records the explicit parent', async () => {
    const account = await getTestAccount();
    poolAccounts.push(account.account);
    const client = await connectAuth(account.account, account.password);
    clients.push(client);
    await drainUnsolicited(client);

    client.clearRawBuffer();
    client.send('PERSISTENCE PROFILE CREATE base');
    await client.waitForParsedLine(
      m => m.command === 'PERSISTENCE' && m.params[1] === 'CREATED', 5_000,
    );
    client.send('PERSISTENCE PROFILE CREATE child FROM base');
    const created = await client.waitForParsedLine(
      m => m.command === 'PERSISTENCE' && m.params[1] === 'CREATED'
           && m.params[2] === 'child',
      5_000,
    );
    expect(created.raw).toContain('parent=base');

    // Cleanup
    client.send('PERSISTENCE PROFILE DELETE child');
    await client.waitForParsedLine(m => m.command === 'PERSISTENCE' && m.params[1] === 'DELETED', 5_000);
    client.send('PERSISTENCE PROFILE DELETE base');
    await client.waitForParsedLine(m => m.command === 'PERSISTENCE' && m.params[1] === 'DELETED', 5_000);
  });

  it('GET resolves through inheritance chain', async () => {
    const account = await getTestAccount();
    poolAccounts.push(account.account);
    const client = await connectAuth(account.account, account.password);
    clients.push(client);
    await drainUnsolicited(client);

    // Create base, set hold on base; create child inheriting from base.
    client.send('PERSISTENCE PROFILE CREATE base');
    await client.waitForParsedLine(m => m.command === 'PERSISTENCE' && m.params[1] === 'CREATED', 5_000);
    client.send('PERSISTENCE PROFILE SET base hold 1');
    await client.waitForParsedLine(
      m => m.command === 'PERSISTENCE' && m.params[0] === 'PROFILE'
           && m.params[1] === 'base' && m.params[2] === 'hold',
      5_000,
    );
    client.send('PERSISTENCE PROFILE CREATE child FROM base');
    await client.waitForParsedLine(m => m.command === 'PERSISTENCE' && m.params[1] === 'CREATED', 5_000);

    // GET on child should walk to base and find hold=1.
    client.clearRawBuffer();
    client.send('PERSISTENCE PROFILE GET child hold');
    const got = await client.waitForParsedLine(
      m => m.command === 'PERSISTENCE' && m.params[0] === 'PROFILE'
           && m.params[1] === 'child' && m.params[2] === 'hold',
      5_000,
    );
    expect(got.params[3]).toBe('1');

    // Cleanup
    client.send('PERSISTENCE PROFILE DELETE child');
    await client.waitForParsedLine(m => m.command === 'PERSISTENCE' && m.params[1] === 'DELETED', 5_000);
    client.send('PERSISTENCE PROFILE DELETE base');
    await client.waitForParsedLine(m => m.command === 'PERSISTENCE' && m.params[1] === 'DELETED', 5_000);
  });

  it('SET parent that would create a cycle is refused', async () => {
    const account = await getTestAccount();
    poolAccounts.push(account.account);
    const client = await connectAuth(account.account, account.password);
    clients.push(client);
    await drainUnsolicited(client);

    client.send('PERSISTENCE PROFILE CREATE a');
    await client.waitForParsedLine(m => m.command === 'PERSISTENCE' && m.params[1] === 'CREATED', 5_000);
    client.send('PERSISTENCE PROFILE CREATE b FROM a');
    await client.waitForParsedLine(m => m.command === 'PERSISTENCE' && m.params[1] === 'CREATED', 5_000);

    // Now try to make a inherit from b — that's a cycle (a -> b -> a).
    client.clearRawBuffer();
    client.send('PERSISTENCE PROFILE SET a parent b');
    const fail = await client.waitForParsedLine(
      m => m.command === 'FAIL' && m.params[0] === 'PERSISTENCE',
      5_000,
    );
    expect(fail.params[1]).toBe('INTERNAL_ERROR');

    // Cleanup
    client.send('PERSISTENCE PROFILE DELETE b');
    await client.waitForParsedLine(m => m.command === 'PERSISTENCE' && m.params[1] === 'DELETED', 5_000);
    client.send('PERSISTENCE PROFILE DELETE a');
    await client.waitForParsedLine(m => m.command === 'PERSISTENCE' && m.params[1] === 'DELETED', 5_000);
  });

  it('DELETE refused when other profiles inherit from the target', async () => {
    const account = await getTestAccount();
    poolAccounts.push(account.account);
    const client = await connectAuth(account.account, account.password);
    clients.push(client);
    await drainUnsolicited(client);

    client.send('PERSISTENCE PROFILE CREATE parent_p');
    await client.waitForParsedLine(m => m.command === 'PERSISTENCE' && m.params[1] === 'CREATED', 5_000);
    client.send('PERSISTENCE PROFILE CREATE child_p FROM parent_p');
    await client.waitForParsedLine(m => m.command === 'PERSISTENCE' && m.params[1] === 'CREATED', 5_000);

    client.clearRawBuffer();
    client.send('PERSISTENCE PROFILE DELETE parent_p');
    const fail = await client.waitForParsedLine(
      m => m.command === 'FAIL' && m.params[0] === 'PERSISTENCE',
      5_000,
    );
    expect(fail.params[1]).toBe('INTERNAL_ERROR');

    // Cleanup (in dependency order)
    client.send('PERSISTENCE PROFILE DELETE child_p');
    await client.waitForParsedLine(m => m.command === 'PERSISTENCE' && m.params[1] === 'DELETED', 5_000);
    client.send('PERSISTENCE PROFILE DELETE parent_p');
    await client.waitForParsedLine(m => m.command === 'PERSISTENCE' && m.params[1] === 'DELETED', 5_000);
  });

  it('default profile cannot be deleted or renamed', async () => {
    const account = await getTestAccount();
    poolAccounts.push(account.account);
    const client = await connectAuth(account.account, account.password);
    clients.push(client);
    await drainUnsolicited(client);

    client.clearRawBuffer();
    client.send('PERSISTENCE PROFILE DELETE default');
    const failDel = await client.waitForParsedLine(
      m => m.command === 'FAIL' && m.params[0] === 'PERSISTENCE',
      5_000,
    );
    expect(failDel.params[1]).toBe('INVALID_PARAMETERS');

    client.clearRawBuffer();
    client.send('PERSISTENCE PROFILE RENAME default mobile');
    const failRen = await client.waitForParsedLine(
      m => m.command === 'FAIL' && m.params[0] === 'PERSISTENCE',
      5_000,
    );
    expect(failRen.params[1]).toBe('INVALID_PARAMETERS');
  });

  it('RENAME moves keys and fixes up child profile parent references', async () => {
    const account = await getTestAccount();
    poolAccounts.push(account.account);
    const client = await connectAuth(account.account, account.password);
    clients.push(client);
    await drainUnsolicited(client);

    client.send('PERSISTENCE PROFILE CREATE old_name');
    await client.waitForParsedLine(m => m.command === 'PERSISTENCE' && m.params[1] === 'CREATED', 5_000);
    client.send('PERSISTENCE PROFILE SET old_name hold 1');
    await client.waitForParsedLine(
      m => m.command === 'PERSISTENCE' && m.params[1] === 'old_name' && m.params[2] === 'hold',
      5_000,
    );
    client.send('PERSISTENCE PROFILE CREATE under_old FROM old_name');
    await client.waitForParsedLine(m => m.command === 'PERSISTENCE' && m.params[1] === 'CREATED', 5_000);

    client.clearRawBuffer();
    client.send('PERSISTENCE PROFILE RENAME old_name new_name');
    const ren = await client.waitForParsedLine(
      m => m.command === 'PERSISTENCE' && m.params[1] === 'RENAMED',
      5_000,
    );
    expect(ren.params[2]).toBe('old_name');
    expect(ren.params[3]).toBe('new_name');

    // hold should now be on new_name.
    client.clearRawBuffer();
    client.send('PERSISTENCE PROFILE GET new_name hold');
    const got = await client.waitForParsedLine(
      m => m.command === 'PERSISTENCE' && m.params[1] === 'new_name' && m.params[2] === 'hold',
      5_000,
    );
    expect(got.params[3]).toBe('1');

    // under_old should now point at new_name via inheritance.
    client.clearRawBuffer();
    client.send('PERSISTENCE PROFILE GET under_old hold');
    const childGet = await client.waitForParsedLine(
      m => m.command === 'PERSISTENCE' && m.params[1] === 'under_old' && m.params[2] === 'hold',
      5_000,
    );
    expect(childGet.params[3]).toBe('1');

    // Cleanup
    client.send('PERSISTENCE PROFILE DELETE under_old');
    await client.waitForParsedLine(m => m.command === 'PERSISTENCE' && m.params[1] === 'DELETED', 5_000);
    client.send('PERSISTENCE PROFILE DELETE new_name');
    await client.waitForParsedLine(m => m.command === 'PERSISTENCE' && m.params[1] === 'DELETED', 5_000);
  });
});
