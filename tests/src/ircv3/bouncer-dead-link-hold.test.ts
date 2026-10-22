import { describe, it, expect, afterEach } from 'vitest';
import { spawn, ChildProcess } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  RawSocketClient,
  createRawSocketClient,
  PRIMARY_SERVER,
  IRC_OPER,
  uniqueNick,
  uniqueChannel,
  getTestAccount,
  releaseTestAccount,
} from '../helpers/index.js';
import type { IRCMessage } from '../helpers/index.js';
import { createSaslBouncerClient, bouncerDisableHold } from '../helpers/bouncer.js';

/**
 * A bouncer primary whose socket the server gives up on -- here a client
 * that stops reading until its sendQ overflows ("Max sendQ exceeded") --
 * is held like a dropped connection, and its realname survives.
 *
 * Before 2026-10-22 (deferred-items: the realname clobber, rdrake 10-02):
 * dead_link() wrote the reason into the realname (cli_info), and the dead
 * client was exited by the parse loop or check_pings() without asking the
 * bouncer -- the session ended (user decision: it holds); when the socket
 * callback did hold it, the session kept "Max sendQ exceeded" / "Write
 * error: ..." as the user's realname, persisted and replayed it.
 */

const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));
const HERE = path.dirname(fileURLToPath(import.meta.url));
const STALL = path.resolve(HERE, '../helpers/stall_reader.py');
const REALNAME = 'A Real Name';

async function client(nick: string, channel: string): Promise<RawSocketClient> {
  const c = await createRawSocketClient();
  await c.capLs();
  c.capEnd();
  c.register(nick);
  await c.waitForNumeric('001');
  await sleep(300);
  c.send(`JOIN ${channel}`);
  await c.waitForNumeric('366', 5000);
  return c;
}

/** Start a client that joins @a channel and then stops reading. */
function stallReader(nick: string, channel: string, account?: string, password?: string):
  Promise<{ proc: ChildProcess; nick: string }> {
  const args = [STALL, PRIMARY_SERVER.host, String(PRIMARY_SERVER.port), '4096',
    nick, REALNAME, channel, ...(account ? [account, password!] : [])];
  const proc = spawn('python3', args, { stdio: ['pipe', 'pipe', 'pipe'] });
  return new Promise((resolve, reject) => {
    let out = '';
    const timer = setTimeout(() => reject(new Error(`stall reader not ready: ${out}`)), 20_000);
    proc.stdout!.on('data', d => {
      out += d.toString();
      const m = /READY (\S+)/.exec(out);
      if (m) { clearTimeout(timer); resolve({ proc, nick: m[1] }); }
    });
    proc.on('exit', code => { clearTimeout(timer); reject(new Error(`stall reader exited ${code}: ${out}`)); });
  });
}

/** The flooder joins @a channel first (so it is its op) and sets +P: the
 * flood is not stored in chathistory -- 16000 rows a run made the store's
 * periodic full-scan purge stall the bed's event loop (deferred-items). */
async function flooderClient(nick: string, channel: string): Promise<RawSocketClient> {
  const c = await client(nick, channel);
  c.send(`MODE ${channel} +P`);
  await c.waitForParsedLine(m => m.command === 'MODE' && m.params[0] === channel
    && /\+[^-]*P/.test(m.params[1] ?? ''), 5000);
  return c;
}

/** Flood @a channel from @a c with long lines: enough to overflow a
 * 160000-byte sendQ behind a 4 KB receive window AND the kernel's send
 * buffer, which autotunes to megabytes over loopback (~5.8 MB here). */
async function flood(c: RawSocketClient, channel: string, lines = 16000) {
  const text = 'x'.repeat(300);
  for (let i = 0; i < lines; i++) {
    c.send(`PRIVMSG ${channel} :${i} ${text}`);
    if (i % 2000 === 1999)
      await sleep(300);
  }
}

function quitOf(lines: IRCMessage[], nick: string): IRCMessage | undefined {
  return lines.find(m => m.command === 'QUIT' && m.source?.nick === nick);
}

/** Oper connection for CHECK. */
async function operClient(): Promise<RawSocketClient> {
  const op = await createRawSocketClient();
  await op.capLs();
  op.capEnd();
  op.register(uniqueNick('dlop'));
  await op.waitForNumeric('001');
  op.send(`OPER ${IRC_OPER.name} ${IRC_OPER.password}`);
  await op.waitForNumeric('381', 5000);
  return op;
}

/** CHECK -b's "Session state" for @a nick. */
async function sessionState(op: RawSocketClient, nick: string): Promise<string> {
  const mark = op.allParsedLines.length;
  op.send(`CHECK ${nick} -b`);
  await sleep(1500);
  return op.allParsedLines.slice(mark)
    .map(m => m.params[m.params.length - 1] ?? '').find(t => /Session state::/.test(t)) ?? '';
}

async function whoisRealname(c: RawSocketClient, nick: string): Promise<string | null> {
  c.clearRawBuffer();
  c.send(`WHOIS ${nick}`);
  const r = await c.waitForParsedLine(m => m.command === '311' || m.command === '401', 6000);
  return r.command === '311' ? r.params[r.params.length - 1] : null;
}

describe('A bouncer primary whose socket dies by sendQ overflow', () => {
  const clients: RawSocketClient[] = [];
  const procs: ChildProcess[] = [];
  const poolAccounts: string[] = [];
  const track = <T extends RawSocketClient>(c: T): T => { clients.push(c); return c; };

  afterEach(async () => {
    for (const p of procs) { try { p.stdin!.end(); p.kill(); } catch { /* */ } }
    procs.length = 0;
    for (const c of clients) { try { c.close(); } catch { /* */ } }
    clients.length = 0;
    for (const a of poolAccounts) releaseTestAccount(a);
    poolAccounts.length = 0;
  });

  it('is held, not exited, and keeps its realname through the revive', async () => {
    const { account, password, fromPool } = await getTestAccount();
    if (fromPool) poolAccounts.push(account);
    // The flood goes to one channel; the observer shares only a quiet one
    // with the victim, so it sees a QUIT without taking the flood itself.
    const channel = uniqueChannel();
    const quiet = uniqueChannel();
    const observer = track(await client(uniqueNick('dlo'), quiet));
    const flooder = track(await flooderClient(uniqueNick('dlf'), channel));
    const { proc, nick } = await stallReader(uniqueNick('dlv'), `${channel},${quiet}`, account, password);
    procs.push(proc);
    await sleep(500);

    const op = track(await operClient());
    const mark = observer.allParsedLines.length;
    await flood(flooder, channel);
    // The sendQ overflows at once; check_pings() acts on the dead socket at
    // its next sweep (the class ping interval, 90 s on the bed).
    let state = '';
    let quit: IRCMessage | undefined;
    for (let i = 0; i < 55 && !quit && !/HOLDING/.test(state); i++) {
      await sleep(2000);
      quit = quitOf(observer.allParsedLines.slice(mark), nick);
      if (!quit)
        state = await sessionState(op, nick);
    }
    expect(quit?.params[0], 'no QUIT: the session holds instead of ending').toBeUndefined();
    expect(state, 'the session is held').toMatch(/HOLDING/);

    expect(await whoisRealname(observer, nick), 'the held ghost keeps its realname').toBe(REALNAME);

    proc.stdin!.end();
    const back = await createSaslBouncerClient(account, password, { nick: uniqueNick('dlb') });
    track(back.client);
    expect(back.nick, 'setup: the reconnect revived the held session').toBe(nick);
    expect(await whoisRealname(observer, nick), 'the revived session keeps its realname').toBe(REALNAME);
    await bouncerDisableHold(back.client);
    back.client.send('QUIT');
  }, 200_000);

  it('a client without a session still quits with the reason', async () => {
    const channel = uniqueChannel();
    const quiet = uniqueChannel();
    const observer = track(await client(uniqueNick('dpo'), quiet));
    const flooder = track(await flooderClient(uniqueNick('dpf'), channel));
    const { proc, nick } = await stallReader(uniqueNick('dpv'), `${channel},${quiet}`);
    procs.push(proc);
    await sleep(500);
    const mark = observer.allParsedLines.length;
    await flood(flooder, channel);
    let quit: IRCMessage | undefined;
    for (let i = 0; i < 115 && !quit; i++) {   // up to the next check_pings sweep
      await sleep(1000);
      quit = quitOf(observer.allParsedLines.slice(mark), nick);
    }
    expect(quit, 'the stalled client quits').toBeDefined();
    expect(quit!.params[0], 'with the reason, not a realname').toMatch(/Max sendQ exceeded/);
  }, 160_000);
});
