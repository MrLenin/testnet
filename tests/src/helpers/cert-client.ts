/**
 * A minimal IRC client over TLS that presents a client certificate. The shared
 * clients speak plain TCP only, and for certificate login the certificate is
 * the whole point.
 *
 * It keeps every line since connect and never clears them. X3's certificate
 * auto-login notice arrives unprompted right after registration; a buffer
 * cleared at the wrong moment loses it -- which is exactly how the first
 * version of the auto-login test went wrong.
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as tls from 'node:tls';
import { run } from './bed-control';

const HOST = process.env.IRC_HOST || 'localhost';
const TLS_PORT = Number(process.env.IRC_TLS_PORT || 6697);

/** A throwaway self-signed client certificate, <dir>/<name>.{crt,key}. */
export function makeCert(dir: string, name: string): void {
  run('openssl', ['req', '-x509', '-newkey', 'ec', '-pkeyopt', 'ec_paramgen_curve:prime256v1',
    '-nodes', '-days', '1', '-subj', `/CN=${name}`,
    '-keyout', path.join(dir, `${name}.key`), '-out', path.join(dir, `${name}.crt`)]);
}

export class CertClient {
  readonly nick = `cfp${Math.random().toString(36).slice(2, 9)}`;
  readonly lines: string[] = [];
  closed = false;
  private sock!: tls.TLSSocket;
  private buf = '';

  constructor(private readonly certDir: string, private readonly certName: string) {}

  async connect(): Promise<void> {
    await new Promise<void>((resolve, reject) => {
      this.sock = tls.connect({
        host: HOST,
        port: TLS_PORT,
        cert: fs.readFileSync(path.join(this.certDir, `${this.certName}.crt`)),
        key: fs.readFileSync(path.join(this.certDir, `${this.certName}.key`)),
        // The bed serves its own self-signed chain; this client exercises X3's
        // handling of *its* certificate, not the server's identity. Same as
        // tls-accept.test.ts. Never copy this into anything that talks to prod.
        rejectUnauthorized: false,
      }, () => resolve());
      this.sock.once('error', reject);
      this.sock.on('data', (d) => this.onData(d.toString()));
      this.sock.on('close', () => { this.closed = true; });
    });
    this.send(`NICK ${this.nick}`);
    this.send('USER cfp 0 * :certfp test');
    await this.waitFor(/ 001 /, 0, 15000);
  }

  private onData(chunk: string): void {
    this.buf += chunk;
    let i: number;
    while ((i = this.buf.indexOf('\n')) >= 0) {
      const line = this.buf.slice(0, i).replace(/\r$/, '');
      this.buf = this.buf.slice(i + 1);
      const ping = /^PING :?(\S+)/.exec(line);
      if (ping) { this.send(`PONG :${ping[1]}`); continue; }  // cookie and keepalive
      this.lines.push(line);
    }
  }

  send(line: string): void { if (!this.closed) this.sock.write(line + '\r\n'); }

  /** First line at or after index `from` matching `re`. */
  async waitFor(re: RegExp, from = 0, timeout = 10000): Promise<string> {
    const deadline = Date.now() + timeout;
    while (Date.now() < deadline) {
      const hit = this.lines.slice(from).find((l) => re.test(l));
      if (hit) return hit;
      await new Promise((r) => setTimeout(r, 100));
    }
    throw new Error(`timed out waiting for ${re}; saw:\n${this.lines.slice(-12).join('\n')}`);
  }

  /** The account the ircd reports for this connection (WHOIS 330), or null. */
  async whoisAccount(): Promise<string | null> {
    const from = this.lines.length;
    this.send(`WHOIS ${this.nick}`);
    await this.waitFor(new RegExp(` 318 \\S+ ${this.nick} `), from);   // end of WHOIS
    const acct = this.lines.slice(from).find((l) => new RegExp(` 330 \\S+ ${this.nick} `).test(l));
    return acct ? acct.split(' ')[4] : null;
  }

  close(): void {
    if (this.closed) return;
    try { this.send('QUIT'); this.sock.end(); } catch { /* */ }
  }
}
