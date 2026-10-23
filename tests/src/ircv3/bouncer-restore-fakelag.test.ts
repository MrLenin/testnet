import { describe, it, expect, afterEach } from 'vitest';
import { execSync } from 'node:child_process';
import {
  createRawSocketClient, RawSocketClient, PRIMARY_SERVER,
  uniqueNick, getTestAccount, releaseTestAccount,
} from '../helpers/index.js';
import { IRC_OPER } from '../helpers/x3-client.js';
import {
  createSaslBouncerClient, bouncerEnableHold, bouncerDisableHold, disconnectAbruptly,
} from '../helpers/bouncer.js';

/**
 * A bouncer session restored from the DB after a restart must be fake-lagged
 * like any other connection (review 2026-10-21, after rdrake reported
 * "authed users with a single session are exempt").
 *
 * The class lag values are cached per Connection, and a cached 0 means
 * "fake lag off".  A ghost restored by bounce_create_ghost() has a zeroed
 * Connection and never registers; bounce_revive() moved the reviving
 * socket and its confs onto that Connection without resetting the cache,
 * so the revived session was never charged.
 *
 * Port 6675 (class RequireSASL) has the default fake lag (2 s + bytes/120;
 * the Users class on 6667 has it off).  An authenticated connection gets
 * POSTREG_GRACE (20 s) of credit plus the 10 s window: about 15 back-to-back
 * PINGs are answered at once, then one per 2 s.  Unthrottled, all 25 are.
 */
const RUN = process.env.RUN_RESTART_TESTS === '1';
const LAG_PORT = 6675;
const BURST = 25;
const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));
const T0 = Date.now();
const phase = (what: string) => console.log(`[restore-fakelag +${((Date.now() - T0) / 1000).toFixed(1)}s] ${what}`);

async function waitForNefariousReady(timeoutMs = 180_000): Promise<void> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    try {
      const status = execSync("docker inspect -f '{{.State.Health.Status}}' nefarious",
        { encoding: 'utf8' }).trim();
      if (status === 'healthy') {
        let probe: RawSocketClient | null = null;
        try {
          probe = await createRawSocketClient(PRIMARY_SERVER.host, PRIMARY_SERVER.port);
          await Promise.race([probe.capLs(),
            new Promise<never>((_, rej) => setTimeout(() => rej(new Error('cap ls timeout')), 3000))]);
          probe.capEnd(); probe.send('QUIT'); probe.close();
          return;
        } catch { if (probe) probe.close(); }
      }
    } catch { /* mid-restart */ }
    await sleep(500);
  }
  throw new Error(`nefarious did not become ready within ${timeoutMs}ms`);
}

/** A plain IRC-oper connection: OPER only, no AuthServ login (which is
 * exactly what is missing right after the restart). */
async function ircOper(): Promise<RawSocketClient> {
  const c = await createRawSocketClient();
  await c.capLs(); c.capEnd(); c.register(uniqueNick('rlnk'));
  await c.waitForNumeric('001');
  await sleep(1000);
  c.send(`OPER ${IRC_OPER.name} ${IRC_OPER.password}`);
  await c.waitForLine(/ 381 /, 5000);
  return c;
}

/** Server names the primary can see. */
async function linkedServers(oper: RawSocketClient): Promise<Set<string>> {
  const start = oper.allLines.length;
  oper.send('LINKS');
  await oper.waitForLine(/ 365 /, 10_000);
  return new Set(oper.allLines.slice(start)
    .map(l => / 364 \S+ (\S+) /.exec(l)?.[1]?.toLowerCase())
    .filter((n): n is string => !!n));
}

/** Put back the links the restart broke.  On a bed whose services hang
 * off another server, restarting the primary drops that branch, and its
 * autoconnect is not guaranteed to bring it back (2026-10-21: the
 * upstream slot with X3 behind it stayed split for half an hour, and
 * every later test lost AuthServ). */
async function restoreLinks(before: Set<string>): Promise<void> {
  const oper = await ircOper();
  try {
    for (let attempt = 0; attempt < 8; attempt++) {
      const now = await linkedServers(oper);
      const missing = [...before].filter(n => !now.has(n));
      phase(`restore attempt ${attempt}: missing ${missing.join(' ') || 'none'}`);
      if (missing.length === 0) return;
      for (const n of missing) oper.send(`CONNECT ${n}`);
      await sleep(5000);
    }
    const finalLinks = await linkedServers(oper);
    const missing = [...before].filter(n => !finalLinks.has(n));
    if (missing.length) throw new Error(`could not restore links after the restart: ${missing.join(', ')}`);
  } finally { try { oper.send('QUIT'); oper.close(); } catch { /* */ } }
}

/** Send BURST PINGs at once and count the PONGs that come back in 3 s. */
async function pongsInThreeSeconds(c: RawSocketClient): Promise<number> {
  const tag = Math.random().toString(36).slice(2, 7);
  const start = c.allLines.length;
  for (let i = 0; i < BURST; i++) c.send(`PING :${tag}-${i}`);
  await sleep(3000);
  return c.allLines.slice(start).filter(l => / PONG /.test(l) && l.includes(tag)).length;
}

(RUN ? describe : describe.skip)('Fake lag applies to a session restored after a restart', () => {
  const clients: RawSocketClient[] = [];
  const pool: string[] = [];
  afterEach(async () => {
    for (const c of clients) { try { await bouncerDisableHold(c); } catch { /* */ } try { c.close(); } catch { /* */ } }
    clients.length = 0;
    for (const a of pool) releaseTestAccount(a);
    pool.length = 0;
  });

  it('control: a fresh authenticated connection on the lagged port is throttled', async () => {
    const acc = await getTestAccount(); if (acc.fromPool) pool.push(acc.account);
    const { client } = await createSaslBouncerClient(acc.account, acc.password,
      { nick: uniqueNick('flc'), host: PRIMARY_SERVER.host, port: LAG_PORT });
    clients.push(client);
    await sleep(1000);
    expect(await pongsInThreeSeconds(client), 'fake lag stalls the burst').toBeLessThan(21);
  }, 60_000);

  it('a session restored from the DB and revived is throttled the same way', async () => {
    const acc = await getTestAccount(); if (acc.fromPool) pool.push(acc.account);
    const first = await createSaslBouncerClient(acc.account, acc.password,
      { nick: uniqueNick('flr'), host: PRIMARY_SERVER.host, port: LAG_PORT });
    expect(await bouncerEnableHold(first.client)).toBe(true);
    phase('session held-capable');
    await sleep(8000);                      // let the session reach the DB
    disconnectAbruptly(first.client);
    await sleep(500);

    const linksBefore = await (async () => {
      const o = await ircOper();
      try { return await linkedServers(o); } finally { o.send('QUIT'); o.close(); }
    })();
    phase(`links before: ${[...linksBefore].join(' ')}`);
    execSync('docker restart nefarious', { encoding: 'utf8' });
    phase('restarted');
    await waitForNefariousReady();
    phase('ready');
    await sleep(35_000);                    // same settling pad as the other restart tests
    phase('settled');
    await restoreLinks(linksBefore);
    phase('links restored');

    const revived = await createSaslBouncerClient(acc.account, acc.password,
      { nick: uniqueNick('flr2'), host: PRIMARY_SERVER.host, port: LAG_PORT });
    clients.push(revived.client);
    phase(`revived as ${revived.nick}`);
    expect(revived.nick.toLowerCase(), 'revived the restored ghost').toBe(first.nick.toLowerCase());
    await sleep(1000);
    expect(await pongsInThreeSeconds(revived.client),
      'a restored-then-revived session must be fake-lagged').toBeLessThan(21);
  }, 300_000);
});
