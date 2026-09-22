/**
 * A registered client certificate logs its user in on connect -- even while
 * LDAP is down.
 *
 * This is the property certificate-based break-glass accounts rely on (design
 * J in .claude/para/projects/account-timestamp-authority-2026-09.md): an
 * account usable when the identity stack is not. Nothing guarded it before.
 *
 * How it works: when a client presents a certificate, the ircd announces its
 * fingerprint to services (`MARK <nick> SSLCLIFP <fp>`). X3's
 * nickserv_do_autoauth() then finds the handle by fingerprint and binds it,
 * checking hostmask, suspension and max-logins -- and making no LDAP call at
 * all. The user never sends AUTH.
 *
 * The negative case matters as much as the positive ones: an unregistered
 * certificate must NOT log anyone in. Without it, auto-login breaking open would
 * still pass.
 *
 * GATED behind LDAP_OUTAGE_TESTS=1. It passes on current code; the gate exists
 * because the outage case stops OpenLDAP, which takes Keycloak's federation --
 * and so every SASL login on the bed -- down with it for the duration. It
 * restarts it, but it must never run casually or alongside anything else.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { execFileSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import * as tls from 'node:tls';

const GATED = process.env.LDAP_OUTAGE_TESTS !== '1';

const HOST = process.env.IRC_HOST || 'localhost';
const TLS_PORT = Number(process.env.IRC_TLS_PORT || 6697);
const AUTHSERV = process.env.X3_NICKSERV_NICK || 'AuthServ';

// 'test*' is swept by src/scripts/cleanup-tests.ts.
const ACCOUNT = `testcfp${Math.random().toString(36).slice(2, 8)}`;
const PASSWORD = 'CertFp!2026';

const LOGGED_IN = /I recognize you\./;

let certDir = '';

/** Run a program with an argument array -- no shell, so nothing is interpolated. */
function run(file: string, args: string[]): string {
  return execFileSync(file, args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
}

function makeCert(name: string): void {
  run('openssl', ['req', '-x509', '-newkey', 'ec', '-pkeyopt', 'ec_paramgen_curve:prime256v1',
    '-nodes', '-days', '1', '-subj', `/CN=${name}`,
    '-keyout', path.join(certDir, `${name}.key`), '-out', path.join(certDir, `${name}.crt`)]);
}

/**
 * Minimal IRC client over TLS that presents a client certificate; the shared
 * helpers speak plain TCP only. It keeps every line since connect and never
 * clears them: the auto-login notice arrives unprompted right after
 * registration, and a buffer cleared at the wrong moment would lose it.
 */
class CertClient {
  readonly nick = `cfp${Math.random().toString(36).slice(2, 9)}`;
  private sock!: tls.TLSSocket;
  private buf = '';
  readonly lines: string[] = [];

  constructor(private readonly certName: string) {}

  async connect(): Promise<void> {
    await new Promise<void>((resolve, reject) => {
      this.sock = tls.connect({
        host: HOST,
        port: TLS_PORT,
        cert: fs.readFileSync(path.join(certDir, `${this.certName}.crt`)),
        key: fs.readFileSync(path.join(certDir, `${this.certName}.key`)),
        // The bed serves its own self-signed chain; this client is testing X3's
        // handling of *its* certificate, not the server's identity. Same as
        // tls-accept.test.ts. Never copy this into anything that talks to prod.
        rejectUnauthorized: false,
      }, () => resolve());
      this.sock.once('error', reject);
      this.sock.on('data', (d) => this.onData(d.toString()));
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
      if (ping) { this.send(`PONG :${ping[1]}`); continue; }  // registration cookie
      this.lines.push(line);
    }
  }

  send(line: string): void { this.sock.write(line + '\r\n'); }

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

  /** The account the server reports for this connection, or null. */
  async whoisAccount(): Promise<string | null> {
    const from = this.lines.length;
    this.send(`WHOIS ${this.nick}`);
    await this.waitFor(new RegExp(` 318 \\S+ ${this.nick} `), from);   // end of WHOIS
    const acct = this.lines.slice(from).find((l) => new RegExp(` 330 \\S+ ${this.nick} `).test(l));
    return acct ? acct.split(' ')[4] : null;
  }

  close(): void { try { this.send('QUIT'); this.sock.end(); } catch { /* */ } }
}

function waitHealthy(container: string, timeoutMs: number): void {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const state = run('docker', ['inspect', '--format', '{{.State.Health.Status}}', container]).trim();
    if (state === 'healthy') return;
    run('sleep', ['2']);
  }
  throw new Error(`${container} did not become healthy within ${timeoutMs}ms`);
}

function isRunning(container: string): boolean {
  return run('docker', ['inspect', '--format', '{{.State.Running}}', container]).trim() === 'true';
}

/** Connect with a certificate, send nothing, and report what happened. */
async function connectAndObserve(certName: string, settleMs = 6000) {
  const c = new CertClient(certName);
  await c.connect();
  let notice: string | null = null;
  try { notice = await c.waitFor(LOGGED_IN, 0, settleMs); } catch { /* none arrived */ }
  const account = await c.whoisAccount();
  c.close();
  return { notice, account };
}

describe('client-certificate auto-login on connect', () => {
  beforeAll(async () => {
    // Guard the hook itself: it creates an account and certificates.
    if (GATED) return;
    certDir = fs.mkdtempSync(path.join(os.tmpdir(), 'certfp-'));
    makeCert('registered');
    makeCert('stranger');

    const c = new CertClient('registered');
    await c.connect();
    let from = c.lines.length;
    // E-mail verification is off on the bed, so REGISTER also authenticates.
    c.send(`PRIVMSG ${AUTHSERV} :REGISTER ${ACCOUNT} ${PASSWORD} ${ACCOUNT}@example.com`);
    await c.waitFor(/has been registered/, from, 20000);
    from = c.lines.length;
    // With no argument, ADDCERTFP registers the certificate this connection
    // presented, as the ircd announced it to X3.
    c.send(`PRIVMSG ${AUTHSERV} :ADDCERTFP`);
    await c.waitFor(/Client certificate fingerprint .* added/, from, 20000);
    c.close();
  }, 60_000);

  afterAll(() => {
    if (GATED) return;
    // Belt and braces: never leave the bed without its directory.
    try { run('docker', ['start', 'openldap']); waitHealthy('openldap', 60_000); } catch { /* */ }
    if (certDir) fs.rmSync(certDir, { recursive: true, force: true });
  }, 90_000);

  it.skipIf(GATED)('logs in a registered certificate on connect, without AUTH', async () => {
    const r = await connectAndObserve('registered');
    expect(r.notice, 'no auto-login notice').toMatch(LOGGED_IN);
    expect(r.account).toBe(ACCOUNT);
  }, 60_000);

  it.skipIf(GATED)('does NOT log in an unregistered certificate', async () => {
    const r = await connectAndObserve('stranger');
    expect(r.notice).toBeNull();
    expect(r.account).toBeNull();
  }, 60_000);

  it.skipIf(GATED)('still logs in a registered certificate while LDAP is down', async () => {
    run('docker', ['stop', 'openldap']);
    try {
      // Bracket the login inside the outage: a stop that silently did nothing
      // would otherwise let this pass for the wrong reason.
      expect(isRunning('openldap'), 'openldap still running before connect').toBe(false);
      const r = await connectAndObserve('registered');
      expect(isRunning('openldap'), 'openldap came back during the login').toBe(false);
      expect(r.notice, 'no auto-login notice with LDAP down').toMatch(LOGGED_IN);
      expect(r.account).toBe(ACCOUNT);
    } finally {
      run('docker', ['start', 'openldap']);
      waitHealthy('openldap', 60_000);
    }
  }, 120_000);
});
