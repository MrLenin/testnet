/**
 * LOCAL (+L): a break-glass handle never accepts a directory credential.
 *
 * Break-glass accounts exist to use X3 when LDAP or Keycloak is down, so they
 * are deliberately not in the directory (design J,
 * .claude/para/projects/account-timestamp-authority-2026-09.md). That leaves
 * their name free in Keycloak, where self-registration is on. Whoever registers
 * it could then use the break-glass handle -- its channel access, its oper
 * level -- by any path that trusts a directory credential for that name:
 *
 *   - SASL at the ircd, which announces the account to X3 (handle_account);
 *   - `/msg AuthServ AUTH`, which binds to LDAP with their password (cmd_auth);
 *   - X3's own SASL handler (loc_auth; not reachable on this bed, whose ircd
 *     does SASL itself, so it is implemented but not exercised here).
 *
 * +L closes all three. A live account announcement for a +L handle is an
 * impostor by construction -- a genuine break-glass user is not in Keycloak,
 * so SASL never succeeds for them -- and is KILLED, because X3 cannot clear an
 * account the ircd has already set. During a burst the announcement may be a
 * replay for a legitimate user, so it is only refused; certificate auto-login,
 * which X3 performs itself, re-binds them straight afterwards.
 *
 * GATED behind X3_LOCAL_FLAG=1: needs x3 built from feature/local-handle-flag,
 * and the relink case restarts x3.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { run, flushX3Saxdb } from '../helpers/bed-control';
import { CertClient, makeCert } from '../helpers/cert-client';
import { createRawSocketClient, RawSocketClient } from '../helpers/index.js';
import { authenticateSaslPlain } from '../helpers/sasl';
import { createOperClient, createX3Client, NICKSERV_NICK, OPSERV_NICK } from '../helpers/x3-client';
import { getKeycloakAdminToken } from '../helpers/keycloak-sync';

const GATED = process.env.X3_LOCAL_FLAG !== '1';

const KC = process.env.KEYCLOAK_URL || 'http://localhost:8080';
const REALM = 'testnet';

// 'test*' is swept by src/scripts/cleanup-tests.ts.
const tag = Math.random().toString(36).slice(2, 7);
const IMPERSONATED = `testlcl${tag}`;   // break-glass handle an impostor will target
const CERTED = `testlcc${tag}`;         // break-glass handle with a certificate
const OWNER_PASSWORD = 'Owner!2026';
const IMPOSTOR_PASSWORD = 'Impostor!2026';

let token = '';
let certDir = '';

async function kc(p: string, init: RequestInit = {}): Promise<Response> {
  return fetch(`${KC}/admin/realms/${REALM}${p}`, {
    ...init,
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json', ...(init.headers || {}) },
  });
}

async function kcCreateUser(username: string, password: string): Promise<void> {
  const res = await kc('/users', {
    method: 'POST',
    body: JSON.stringify({
      username, enabled: true, emailVerified: true, email: `${username}@example.com`,
      credentials: [{ type: 'password', value: password, temporary: false }],
    }),
  });
  if (!res.ok && res.status !== 409) throw new Error(`create ${username}: ${res.status} ${await res.text()}`);
}

async function kcDeleteUser(username: string): Promise<void> {
  const res = await kc(`/users?username=${encodeURIComponent(username)}&exact=true`);
  const id = (await res.json())[0]?.id;
  if (id) await kc(`/users/${id}`, { method: 'DELETE' });
}

/** Connect, authenticate by SASL PLAIN, finish registration. */
async function saslLogin(account: string, password: string): Promise<{ client: RawSocketClient; ok: boolean }> {
  const client = await createRawSocketClient();
  await client.capLs();
  await client.capReq(['sasl']);
  const res = await authenticateSaslPlain(client, account, password);
  client.capEnd();
  client.register(`lcl${Math.random().toString(36).slice(2, 8)}`);
  await client.waitForNumeric('001', 15000);
  return { client, ok: res.success };
}

/** Make `name` a break-glass handle: in X3, not in Keycloak, flagged +L. */
async function makeBreakGlass(name: string): Promise<void> {
  await kcDeleteUser(name);   // strips it from Keycloak and, via writeback, LDAP
  const op = await createOperClient();
  try {
    // OSET needs security override; without it X3 refuses the command.
    const god = await op.serviceCmd(OPSERV_NICK, 'GOD ON');
    expect(god.join('\n'), 'GOD ON').toMatch(/Security override has been enabled|already have security override enabled/);
    // Assert the flag took: a refused OSET must fail the setup, not pass it
    // (an earlier version checked only for two refusal wordings and missed a
    // third, so every case ran against an unflagged handle).
    // "*name" is the account; a bare name is looked up as an online nick.
    const reply = await op.serviceCmd(NICKSERV_NICK, `OSET *${name} FLAGS +L`);
    expect(reply.join('\n'), `OSET *${name} FLAGS +L did not set L`).toMatch(/FLAGS:\W*[A-Za-z]*L/);
  } finally {
    op.close();
  }
}

describe('LOCAL (+L) break-glass handles refuse directory credentials', () => {
  beforeAll(async () => {
    // Guard the hook itself: it creates accounts and deletes Keycloak users.
    if (GATED) return;
    token = await getKeycloakAdminToken();
    certDir = fs.mkdtempSync(path.join(os.tmpdir(), 'lclflag-'));
    makeCert(certDir, 'owner');

    // CERTED: registered over a certificate connection, certificate attached.
    const c = new CertClient(certDir, 'owner');
    await c.connect();
    let from = c.lines.length;
    c.send(`PRIVMSG ${NICKSERV_NICK} :REGISTER ${CERTED} ${OWNER_PASSWORD} ${CERTED}@example.com`);
    await c.waitFor(/has been registered/, from, 20000);
    from = c.lines.length;
    c.send(`PRIVMSG ${NICKSERV_NICK} :ADDCERTFP`);
    await c.waitFor(/Client certificate fingerprint .* added/, from, 20000);
    c.close();

    // IMPERSONATED: an ordinary registration, over a PLAIN connection. Not the
    // certificate one: that certificate now belongs to CERTED, so X3 would
    // auto-login the connection as CERTED and the REGISTER would be refused.
    const x = await createX3Client();
    const reg = await x.registerAccount(IMPERSONATED, OWNER_PASSWORD, `${IMPERSONATED}@example.com`);
    x.close();
    expect(reg.success, `registering ${IMPERSONATED} failed: ${JSON.stringify(reg)}`).toBe(true);

    await makeBreakGlass(CERTED);
    await makeBreakGlass(IMPERSONATED);

    // The impostor claims the free name in Keycloak.
    await kcCreateUser(IMPERSONATED, IMPOSTOR_PASSWORD);
  }, 120_000);

  afterAll(async () => {
    if (GATED) return;
    try { await kcDeleteUser(IMPERSONATED); } catch { /* */ }
    if (certDir) fs.rmSync(certDir, { recursive: true, force: true });
  });

  it.skipIf(GATED)('kills an impostor who logs in by SASL with the break-glass name', async () => {
    // Retry until Keycloak accepts the new user: this also PROVES the impostor's
    // credential is valid, so a later refusal can only be +L's doing.
    let login: { client: RawSocketClient; ok: boolean } | null = null;
    for (let i = 0; i < 12; i++) {
      login = await saslLogin(IMPERSONATED, IMPOSTOR_PASSWORD);
      if (login.ok) break;
      login.client.close();
      await new Promise((r) => setTimeout(r, 5000));
    }
    expect(login?.ok, 'impostor SASL never succeeded; test did not reach the path').toBe(true);
    const killed = await login!.client
      .waitForLine(/ KILL \S+ :|ERROR :Closing Link/, 15000)
      .then(() => true, () => false);
    login!.client.close();
    expect(killed, 'impostor bound to the break-glass handle instead of being killed').toBe(true);
  }, 120_000);

  it.skipIf(GATED)('refuses the impostor\'s password at AuthServ AUTH', async () => {
    const c = await createRawSocketClient();
    c.register(`lcl${Math.random().toString(36).slice(2, 8)}`);
    await c.waitForNumeric('001', 15000);
    c.clearRawBuffer();
    c.send(`PRIVMSG ${NICKSERV_NICK} :AUTH ${IMPERSONATED} ${IMPOSTOR_PASSWORD}`);
    const reply = await c.waitForLine(/I recognize you|Incorrect password|problem in contacting/, 20000);
    c.close();
    // Generic refusal on purpose: nothing tells the caller the name is break-glass.
    expect(reply).toMatch(/Incorrect password/);
  }, 60_000);

  it.skipIf(GATED)('keeps a certificate user bound, and alive, across an X3 relink', async () => {
    const c = new CertClient(certDir, 'owner');
    await c.connect();
    await c.waitFor(/I recognize you\./, 0, 10000);   // certificate auto-login
    // X3 must come back knowing the handle: a restart does not save saxdb.
    await flushX3Saxdb(CERTED);
    run('docker', ['restart', 'x3']);

    // Poll X3's own view until it answers: after the relink, the burst's
    // announcement is refused (not killed) and auto-login re-binds.
    const deadline = Date.now() + 90_000;
    let view = '';
    while (Date.now() < deadline && !c.closed) {
      const from = c.lines.length;
      c.send(`PRIVMSG ${NICKSERV_NICK} :ACCOUNTINFO`);
      try {
        view = await c.waitFor(/Account Information for|You must be authenticated first/, from, 3000);
        break;
      } catch { /* X3 not back yet */ }
    }
    const killed = c.closed || c.lines.some((l) => / KILL \S+ :|ERROR :Closing Link/.test(l));
    c.close();
    expect(killed, 'the legitimate certificate user was killed on relink').toBe(false);
    expect(view, 'X3 did not re-bind the certificate user after the relink').toMatch(/Account Information for/);
  }, 240_000);
});
