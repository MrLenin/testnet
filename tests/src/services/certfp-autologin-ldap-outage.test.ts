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
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { run, isRunning, waitHealthy } from '../helpers/bed-control';
import { CertClient, makeCert } from '../helpers/cert-client';

const GATED = process.env.LDAP_OUTAGE_TESTS !== '1';

const AUTHSERV = process.env.X3_NICKSERV_NICK || 'AuthServ';

// 'test*' is swept by src/scripts/cleanup-tests.ts.
const ACCOUNT = `testcfp${Math.random().toString(36).slice(2, 8)}`;
const PASSWORD = 'CertFp!2026';

const LOGGED_IN = /I recognize you\./;

let certDir = '';

/** Connect with a certificate, send nothing, and report what happened. */
async function connectAndObserve(certName: string, settleMs = 6000) {
  const c = new CertClient(certDir, certName);
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
    makeCert(certDir, 'registered');
    makeCert(certDir, 'stranger');

    const c = new CertClient(certDir, 'registered');
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
