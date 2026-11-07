/**
 * A TLS connection (6697) for tests where the TLS flag is the point: +Z and
 * plaintext bouncer devices.  The shared clients speak plain TCP only.  It
 * keeps every line since connect, like RawSocketClient's allLines.
 *
 * With an account it logs in with SASL PLAIN; without one it stays anonymous.
 */
import * as tls from 'node:tls';
import { PRIMARY_SERVER } from './ircv3-client.js';

const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));

export interface TlsClient {
  nick: string;
  lines: string[];
  send: (line: string) => void;
  waitFor: (re: RegExp, from?: number, ms?: number) => Promise<string>;
  close: () => void;
}

export async function createTlsClient(nick: string, options: {
  account?: string;
  password?: string;
  caps?: string[];
  host?: string;
  port?: number;
} = {}): Promise<TlsClient> {
  const { account, password, caps = [], host = PRIMARY_SERVER.host, port = 6697 } = options;
  const lines: string[] = [];
  let buf = '';
  // The bed serves its own chain; these tests are about the TLS flag, not
  // the server's identity.
  const sock = tls.connect({ host, port, rejectUnauthorized: false });
  const send = (l: string) => { sock.write(l + '\r\n'); };
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
  sock.on('error', () => { /* a closing test socket */ });
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

  const req = [...(account ? ['sasl'] : []), ...caps];
  if (req.length) send(`CAP REQ :${req.join(' ')}`);
  send(`NICK ${nick}`);
  send(`USER ${nick} 0 * :tls client`);
  if (req.length) await waitFor(/ CAP .* ACK /);
  if (account) {
    send('AUTHENTICATE PLAIN');
    await waitFor(/^AUTHENTICATE/);
    send('AUTHENTICATE ' + Buffer.from(`${account}\0${account}\0${password}`).toString('base64'));
    await waitFor(/ 903 /);
  }
  if (req.length) send('CAP END');
  const welcome = await waitFor(/ 001 /, 0, 15_000);
  await sleep(1000);
  return {
    nick: welcome.split(' ')[2] ?? nick,
    lines,
    send,
    waitFor,
    close: () => { try { sock.destroy(); } catch { /* */ } },
  };
}

/** BOUNCER SET HOLD on, for a TLS connection (bouncerEnableHold's job). */
export async function tlsEnableHold(c: TlsClient): Promise<void> {
  const start = c.lines.length;
  c.send('BOUNCER SET HOLD on');
  await c.waitFor(/SETTINGS_UPDATED|SESSION_CREATED| NOTE /, start, 5000);
}
