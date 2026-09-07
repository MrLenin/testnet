import { describe, it, expect, afterEach } from 'vitest';
import {
  uniqueNick,
  uniqueChannel,
  X3Client,
  RawSocketClient,
  PRIMARY_SERVER,
  SECONDARY_SERVER,
  IRC_OPER,
  getTestAccount,
  releaseTestAccount,
  createBouncerClient,
  createSaslBouncerClient,
  bouncerDisableHold,
  createRawSocketClient,
} from '../helpers/index.js';

/**
 * Bouncer per-connection activity replication (2026-09-03).
 *
 * Every connection of a session carries a last-activity stamp (primary:
 * hs_last_active, aliases: ba_last_active).  They used to cross servers
 * only in the link burst, so anything reading a REMOTE connection's
 * activity — promotion, session idle, webpush attention — saw a value
 * frozen at link time.  Now a connection's first message after 5 minutes
 * of quiet puts `BX U <numeric> la=<ts>` on the wire.
 *
 * Consumers exercised here:
 *   - oper CHECK <nick> lists every connection with its idle;
 *   - WHOIS idle is session-wide (most recent activity on any connection);
 *   - promotion on primary loss picks the most recently ACTIVE alias,
 *     not the oldest connection.
 */

function parseConnections(lines: string[]): { role: string; numeric: string; server: string; idle: number }[] {
  const out: { role: string; numeric: string; server: string; idle: number }[] = [];
  for (const l of lines) {
    const m = /(Primary|Alias):: (\S+) on (\S+), idle (\d+)s/.exec(l);
    if (m) out.push({ role: m[1], numeric: m[2], server: m[3], idle: parseInt(m[4], 10) });
  }
  return out;
}

async function operUp(): Promise<RawSocketClient> {
  const o = await createRawSocketClient();
  await o.capLs();
  o.capEnd();
  o.register(uniqueNick('acop'));
  await o.waitForNumeric('001');
  await new Promise(r => setTimeout(r, 300));
  o.send(`OPER ${IRC_OPER.name} ${IRC_OPER.password}`);
  await o.waitForNumeric('381', 20000);
  return o;
}

/** CHECK <nick> as oper; returns the RPL_DATASTR (290) payloads up to RPL_ENDOFCHECK (291). */
async function check(o: RawSocketClient, nick: string): Promise<string[]> {
  o.clearRawBuffer();
  o.send(`CHECK ${nick}`);
  const lines: string[] = [];
  for (;;) {
    const m = await o.waitForParsedLine(x => x.command === '290' || x.command === '291', 5000);
    if (m.command === '291') break;
    lines.push(m.params[m.params.length - 1]);
  }
  return lines;
}

async function whoisIdle(o: RawSocketClient, nick: string): Promise<number> {
  o.clearRawBuffer();
  o.send(`WHOIS ${nick} ${nick}`);
  const m = await o.waitForParsedLine(x => x.command === '317', 5000);
  return parseInt(m.params[2], 10);
}

describe('bouncer per-connection activity', () => {
  const clients: (X3Client | RawSocketClient)[] = [];
  const poolAccounts: string[] = [];
  const track = <T extends X3Client | RawSocketClient>(c: T): T => { clients.push(c); return c; };

  afterEach(async () => {
    for (const c of clients) {
      try { await bouncerDisableHold(c as X3Client); } catch { /* */ }
      try { c.send('QUIT'); } catch { /* */ }
      try { c.close(); } catch { /* */ }
    }
    clients.length = 0;
    for (const a of poolAccounts) releaseTestAccount(a);
    poolAccounts.length = 0;
  });

  it('a remote alias speaking updates the session idle seen on the primary server (CHECK + WHOIS)', async () => {
    const acc = await getTestAccount();
    if (acc.fromPool) poolAccounts.push(acc.account);
    const chan = uniqueChannel('act');

    const p = await createBouncerClient(acc.account, acc.password, { nick: uniqueNick('actp') });
    track(p.client);
    const nick = p.nick;
    p.client.send(`JOIN ${chan}`);
    await new Promise(r => setTimeout(r, 1000));

    // Alias on the SECOND server.
    const a = await createSaslBouncerClient(acc.account, acc.password, {
      host: SECONDARY_SERVER.host, port: SECONDARY_SERVER.port,
    });
    track(a.client);
    await new Promise(r => setTimeout(r, 1500));

    // Let the primary go quiet well past what we will assert against.
    await new Promise(r => setTimeout(r, 8000));

    const o = track(await operUp());
    const before = parseConnections(await check(o, nick));
    expect(before.length, `expected primary + alias in CHECK: ${before.length}`).toBeGreaterThanOrEqual(2);
    const remoteBefore = before.find(c => c.role === 'Alias' && !c.server.startsWith('testnet'));
    expect(remoteBefore, 'remote alias missing from CHECK').toBeTruthy();

    // The remote alias speaks: its first message after quiet puts la= on the wire.
    a.client.send(`PRIVMSG ${chan} :active on the leaf`);
    await new Promise(r => setTimeout(r, 2500));

    const after = parseConnections(await check(o, nick));
    const primary = after.find(c => c.role === 'Primary')!;
    const remote = after.find(c => c.role === 'Alias' && !c.server.startsWith('testnet'))!;
    expect(remote, 'remote alias missing after activity').toBeTruthy();
    expect(remote.idle, `remote alias idle should be fresh: ${JSON.stringify(after)}`).toBeLessThanOrEqual(5);
    expect(primary.idle, `primary should still be idle: ${JSON.stringify(after)}`).toBeGreaterThanOrEqual(8);

    // WHOIS idle is session-wide: it follows the alias.
    const idle = await whoisIdle(o, nick);
    expect(idle, 'WHOIS idle should reflect the remote alias activity').toBeLessThanOrEqual(6);
  }, 60000);

  it('promotion on primary loss picks the most recently active alias over the oldest one', async () => {
    const acc = await getTestAccount();
    if (acc.fromPool) poolAccounts.push(acc.account);
    const chan = uniqueChannel('prm');

    const p = await createBouncerClient(acc.account, acc.password, { nick: uniqueNick('prmp') });
    track(p.client);
    const nick = p.nick;
    p.client.send(`JOIN ${chan}`);
    await new Promise(r => setTimeout(r, 1000));

    // Older alias, never speaks.
    const older = await createSaslBouncerClient(acc.account, acc.password);
    track(older.client);
    await new Promise(r => setTimeout(r, 2000));
    // Newer alias, speaks last.
    const newer = await createSaslBouncerClient(acc.account, acc.password);
    track(newer.client);
    await new Promise(r => setTimeout(r, 1500));
    newer.client.send(`PRIVMSG ${chan} :I am the one in use`);
    await new Promise(r => setTimeout(r, 1500));

    const o = track(await operUp());
    const before = parseConnections(await check(o, nick));
    expect(before.filter(c => c.role === 'Alias').length).toBe(2);

    // A clean QUIT promotes immediately (local aliases); an abrupt drop
    // holds the session and promotes only when the hold expires.
    p.client.send('QUIT :switching devices');
    await new Promise(r => setTimeout(r, 4000));

    const after = parseConnections(await check(o, nick));
    const primary = after.find(c => c.role === 'Primary');
    expect(primary, `no primary after promotion: ${JSON.stringify(after)}`).toBeTruthy();
    // The winner is the alias that spoke: its idle is the short one.
    expect(primary!.idle, `promoted the idle alias instead of the active one: ${JSON.stringify(after)}`)
      .toBeLessThanOrEqual(8);
    const alias = after.find(c => c.role === 'Alias');
    expect(alias, 'the other alias should remain').toBeTruthy();
    expect(alias!.idle).toBeGreaterThan(primary!.idle);
  }, 60000);
});
