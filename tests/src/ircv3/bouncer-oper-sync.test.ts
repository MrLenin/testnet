import { describe, it, expect, afterEach } from 'vitest';
import {
  RawSocketClient,
  SECONDARY_SERVER,
  IRC_OPER,
  uniqueNick,
  getTestAccount,
  releaseTestAccount,
} from '../helpers/index.js';
import {
  createBouncerClient,
  createSaslBouncerClient,
  bouncerDisableHold,
} from '../helpers/bouncer.js';

/**
 * Oper state across a bouncer session's connections.
 *
 * bounce_sync_session_umodes copied oper privileges and OPER_HANDLER onto
 * the other connections of a session when one opered, and never took them
 * away when it deopered (deferred-items B2, bouncer-analyst 2026-10-21).
 * The -o cleared the mode flags everywhere but left the other connections'
 * privileges and handler: they still ran oper commands, and the ones that
 * assert IsAnOper (KILL, CLOSE, CONNECT ...) would abort the server.  CHECK
 * tests privileges only, so it shows the leak without the abort: an
 * ex-oper's CHECK must be refused (481).  Never use KILL here.
 */

const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));

/** CHECK <nick> from @a c: 'refused' (481) or 'allowed' (any CHECK reply). */
async function checkAllowed(c: RawSocketClient, nick: string): Promise<'refused' | 'allowed'> {
  c.clearRawBuffer();
  c.send(`CHECK ${nick}`);
  const reply = await c.waitForParsedLine(
    m => m.command === '481' || /^(28[6-9]|290|291)$/.test(m.command), 6000);
  return reply.command === '481' ? 'refused' : 'allowed';
}

describe('Bouncer session oper state', () => {
  const clients: RawSocketClient[] = [];
  const poolAccounts: string[] = [];
  const track = <T extends RawSocketClient>(c: T): T => { clients.push(c); return c; };

  afterEach(async () => {
    for (const c of clients) {
      try { c.close(); } catch { /* */ }
    }
    clients.length = 0;
    for (const a of poolAccounts) releaseTestAccount(a);
    poolAccounts.length = 0;
  });

  async function pair(tag: string, aliasOnLeaf = false) {
    const { account, password, fromPool } = await getTestAccount();
    if (fromPool) poolAccounts.push(account);
    const { client: primary, nick } = await createBouncerClient(account, password,
      { nick: uniqueNick(tag) });
    track(primary);
    const { client: alias, nick: anick } = await createSaslBouncerClient(account, password,
      aliasOnLeaf
        ? { nick: uniqueNick(tag + 'l'), host: SECONDARY_SERVER.host, port: SECONDARY_SERVER.port }
        : { nick: uniqueNick(tag + 'a') });
    track(alias);
    expect(anick, 'setup: the second connection joined the session').toBe(nick);
    await sleep(1000);
    return { primary, alias, nick };
  }

  async function operUp(c: RawSocketClient) {
    c.send(`OPER ${IRC_OPER.name} ${IRC_OPER.password}`);
    await c.waitForNumeric('381', 5000);
    await sleep(1500);
  }

  async function done(primary: RawSocketClient, alias: RawSocketClient) {
    alias.send('QUIT');
    await sleep(300);
    await bouncerDisableHold(primary);
    primary.send('QUIT');
  }

  it('the primary\'s -o takes oper away from its alias on the same server', async () => {
    const { primary, alias, nick } = await pair('opsa');
    await operUp(primary);
    expect(await checkAllowed(alias, nick), 'setup: the alias is an oper with the primary').toBe('allowed');
    primary.send(`MODE ${nick} -o`);
    await sleep(1500);
    expect(await checkAllowed(alias, nick), 'after the primary\'s -o the alias is no oper').toBe('refused');
    await done(primary, alias);
  }, 60_000);

  it('the alias\'s -o takes oper away from the primary', async () => {
    const { primary, alias, nick } = await pair('opsb');
    await operUp(alias);
    expect(await checkAllowed(primary, nick), 'setup: the primary is an oper with the alias').toBe('allowed');
    alias.send(`MODE ${nick} -o`);
    await sleep(1500);
    expect(await checkAllowed(primary, nick), 'after the alias\'s -o the primary is no oper').toBe('refused');
    expect(await checkAllowed(alias, nick), 'nor is the alias').toBe('refused');
    await done(primary, alias);
  }, 60_000);

  it('the primary\'s -o takes oper away from its alias on another server', async () => {
    const { primary, alias, nick } = await pair('opsc', true);
    await operUp(primary);
    expect(await checkAllowed(alias, nick), 'setup: the leaf alias is an oper with the primary').toBe('allowed');
    primary.send(`MODE ${nick} -o`);
    await sleep(2000);
    expect(await checkAllowed(alias, nick), 'after the primary\'s -o the leaf alias is no oper').toBe('refused');
    await done(primary, alias);
  }, 60_000);
});
