import { describe, it, expect, afterEach } from 'vitest';
import * as tls from 'node:tls';
import {
  RawSocketClient,
  createRawSocketClient,
  SECONDARY_SERVER,
  IRC_OPER,
  uniqueNick,
  getTestAccount,
  releaseTestAccount,
} from '../helpers/index.js';
import type { IRCMessage } from '../helpers/index.js';
import { createBouncerClient, createSaslBouncerClient, bouncerDisableHold } from '../helpers/bouncer.js';

/**
 * A user mode change on one connection of a bouncer session is told to the
 * session's other connections, each its own change, once.
 *
 * bounce_sync_session_umodes() copied the modes across silently: a device
 * already attached when another device ran OPER (or X3 opered the session)
 * never learned it was an oper (deferred-items, Rubin's #124 review).  And
 * the copy took the TLS flag (+z) across too, so a plaintext connection's
 * mode change took +z from a TLS alias.
 */

const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));

/** MODE lines for @a nick among @a lines that turn @a letter on (or off). */
function modeLines(lines: IRCMessage[], nick: string, letter: string, on: boolean): IRCMessage[] {
  return lines.filter(m => {
    if (m.command !== 'MODE' || m.params[0] !== nick)
      return false;
    let adding = true;
    for (const ch of m.params.slice(1).join('')) {
      if (ch === '+') adding = true;
      else if (ch === '-') adding = false;
      else if (ch === letter && adding === on) return true;
    }
    return false;
  });
}

/** A TLS connection (6697) that logs in with SASL PLAIN: the TLS alias. */
async function tlsSaslClient(account: string, password: string, nick: string) {
  const lines: string[] = [];
  let buf = '';
  const sock = tls.connect({ host: '127.0.0.1', port: 6697, rejectUnauthorized: false });
  const send = (l: string) => sock.write(l + '\r\n');
  sock.on('data', d => {
    buf += d.toString();
    let i: number;
    while ((i = buf.indexOf('\r\n')) >= 0) {
      const line = buf.slice(0, i);
      buf = buf.slice(i + 2);
      if (line.startsWith('PING')) { send('PONG' + line.slice(4)); continue; }
      lines.push(line);
    }
  });
  await new Promise<void>((res, rej) => { sock.once('secureConnect', () => res()); sock.once('error', rej); });
  const waitFor = async (re: RegExp, from = 0, ms = 10_000) => {
    const end = Date.now() + ms;
    while (Date.now() < end) {
      const hit = lines.slice(from).find(l => re.test(l));
      if (hit) return hit;
      await sleep(100);
    }
    throw new Error(`timed out waiting for ${re}; since ${from}: ${JSON.stringify(lines.slice(from))}`);
  };
  send('CAP REQ :sasl');
  send(`NICK ${nick}`);
  send(`USER ${nick} 0 * :tls alias`);
  await waitFor(/ CAP .* ACK /);
  send('AUTHENTICATE PLAIN');
  await waitFor(/^AUTHENTICATE/);
  send('AUTHENTICATE ' + Buffer.from(`${account}\0${account}\0${password}`).toString('base64'));
  await waitFor(/ 903 /);
  send('CAP END');
  await waitFor(/ 001 /, 0, 15_000);
  await sleep(1500);
  return { sock, send, lines, waitFor };
}

async function umodes(c: RawSocketClient, nick: string): Promise<string> {
  c.clearRawBuffer();
  c.send(`MODE ${nick}`);
  const r = await c.waitForParsedLine(m => m.command === '221', 5000);
  return r.params[1] ?? '';
}

describe('Bouncer session mode changes are told to the other connections', () => {
  const clients: RawSocketClient[] = [];
  const poolAccounts: string[] = [];
  const track = <T extends RawSocketClient>(c: T): T => { clients.push(c); return c; };

  afterEach(async () => {
    for (const c of clients) { try { c.close(); } catch { /* */ } }
    clients.length = 0;
    for (const a of poolAccounts) releaseTestAccount(a);
    poolAccounts.length = 0;
  });

  async function pair(tag: string, onLeaf: boolean) {
    const { account, password, fromPool } = await getTestAccount();
    if (fromPool) poolAccounts.push(account);
    const { client: a, nick } = await createBouncerClient(account, password, { nick: uniqueNick(tag) });
    track(a);
    const opts = onLeaf
      ? { nick: uniqueNick(tag + 'l'), host: SECONDARY_SERVER.host, port: SECONDARY_SERVER.port }
      : { nick: uniqueNick(tag + 'b') };
    const { client: b, nick: bnick } = await createSaslBouncerClient(account, password, opts);
    track(b);
    expect(bnick, 'setup: the second connection joined the session').toBe(nick);
    await sleep(1500);
    return { a, b, nick };
  }

  async function done(a: RawSocketClient, b: RawSocketClient, nick: string) {
    a.send(`MODE ${nick} -o`);
    await sleep(300);
    b.send('QUIT');
    await sleep(300);
    await bouncerDisableHold(a);
    a.send('QUIT');
  }

  for (const onLeaf of [false, true]) {
    const where = onLeaf ? 'on the leaf' : 'on the same server';
    it(`OPER on the other device ${where} is told: MODE +o`, async () => {
      const { a, b, nick } = await pair(onLeaf ? 'uaol' : 'uaos', onLeaf);
      const mark = a.allParsedLines.length;
      b.send(`OPER ${IRC_OPER.name} ${IRC_OPER.password}`);
      await b.waitForNumeric('381', 5000);
      await sleep(2000);
      expect(modeLines(a.allParsedLines.slice(mark), nick, 'o', true).length,
        'the first device is told +o').toBeGreaterThanOrEqual(1);
      await done(a, b, nick);
    }, 60_000);

    it(`a mode change ${where} reaches each connection exactly once`, async () => {
      const { a, b, nick } = await pair(onLeaf ? 'uawl' : 'uaws', onLeaf);
      const am = a.allParsedLines.length;
      const bm = b.allParsedLines.length;
      a.send(`MODE ${nick} +w`);
      await sleep(1000);
      a.send(`MODE ${nick} -w`);
      await sleep(2500);
      expect(modeLines(a.allParsedLines.slice(am), nick, 'w', false).length,
        'the device that changed it sees -w once').toBe(1);
      expect(modeLines(b.allParsedLines.slice(bm), nick, 'w', false).length,
        'the other device sees -w once').toBe(1);
      await done(a, b, nick);
    }, 60_000);
  }

  it('a TLS alias keeps +z when the plaintext primary changes a mode', async () => {
    const { account, password, fromPool } = await getTestAccount();
    if (fromPool) poolAccounts.push(account);
    const { client: a, nick } = await createBouncerClient(account, password, { nick: uniqueNick('uaz') });
    track(a);
    const b = await tlsSaslClient(account, password, uniqueNick('uazt'));
    try {
      const tlsModes = async () => {
        const from = b.lines.length;
        b.send(`MODE ${nick}`);
        const r = await b.waitFor(/ 221 /, from);
        return r.split(' ').slice(-1)[0];
      };
      expect(await tlsModes(), 'setup: the TLS alias has +z').toContain('z');
      a.send(`MODE ${nick} +w`);
      await sleep(1500);
      expect(await tlsModes(), 'the TLS alias still has +z').toContain('z');
    } finally {
      b.send('QUIT');
      b.sock.end();
    }
    await sleep(300);
    await bouncerDisableHold(a);
    a.send('QUIT');
  }, 60_000);
});
