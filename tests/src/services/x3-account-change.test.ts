/**
 * X3 follows the ircd's account changes.
 *
 * The ircd is the account authority for SASL logins.  When a registered
 * client re-authenticates to another account it sends AC M; when a Keycloak
 * event logs a client out it sends AC U.  X3 must rebind, or unbind, to
 * match -- until now it did neither (proto-p10.c passed the letter "M"/"U"
 * to handle_account as an account name).
 *
 * The AC M case re-authenticates with OAUTHBEARER: it is the one mechanism
 * the ircd accepts after a completed SASL exchange (m_authenticate.c), and
 * the bed's ircd skips the issuing-client check (insecure_token_validation),
 * so a token minted to the public irc-client works.
 *
 * The AC U case posts the event the Keycloak SPI would send when an account
 * is disabled straight to the ircd's webhook listener, with the ircd's own
 * secret (the bed's SPI secret does not match it).  A disable only deauths
 * the client; a delete would disconnect it (WEBHOOK_KILL_ON_DELETE defaults
 * on), leaving nothing to ask X3 about.  Each case has its own account: a
 * second connection to an account already logged in becomes a bouncer alias,
 * and the deauth walk deliberately skips aliases.
 *
 * GATED behind X3_AC_CHANGE=1: needs x3 from fix/ac-account-change.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import * as fs from 'node:fs';
import { run } from '../helpers/bed-control';
import { createRawSocketClient, RawSocketClient } from '../helpers/index.js';
import { authenticateSaslPlain, authenticateSaslOAuthBearer } from '../helpers/sasl';
import { NICKSERV_NICK } from '../helpers/x3-client';
import { getKeycloakAdminToken } from '../helpers/keycloak-sync';

const GATED = process.env.X3_AC_CHANGE !== '1';
const KC = process.env.KEYCLOAK_URL || 'http://localhost:8080';
const REALM = 'testnet';

// 'test*' is swept by src/scripts/cleanup-tests.ts.
const tag = Math.random().toString(36).slice(2, 7);
const FIRST = `testacc${tag}a`;    // AC M case: logs in here ...
const SECOND = `testacc${tag}b`;   // ... then re-authenticates here
const THIRD = `testacc${tag}c`;    // AC U case
const PASSWORD = 'Change!2026';

let token = '';

async function kc(p: string, init: RequestInit = {}): Promise<Response> {
  return fetch(`${KC}/admin/realms/${REALM}${p}`, {
    ...init,
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json', ...(init.headers || {}) },
  });
}

async function kcCreateUser(username: string): Promise<string> {
  const res = await kc('/users', {
    method: 'POST',
    body: JSON.stringify({
      username, enabled: true, emailVerified: true, email: `${username}@example.com`,
      credentials: [{ type: 'password', value: PASSWORD, temporary: false }],
    }),
  });
  if (!res.ok && res.status !== 409) throw new Error(`create ${username}: ${res.status} ${await res.text()}`);
  const q = await kc(`/users?username=${encodeURIComponent(username)}&exact=true`);
  return (await q.json())[0].id;
}

async function kcDeleteUser(username: string): Promise<void> {
  const q = await kc(`/users?username=${encodeURIComponent(username)}&exact=true`);
  const id = (await q.json())[0]?.id;
  if (id) await kc(`/users/${id}`, { method: 'DELETE' });
}

/** A bearer token for a realm user, minted to the public irc-client (what a real client would hold). */
async function kcUserToken(username: string): Promise<string> {
  const res = await fetch(`${KC}/realms/${REALM}/protocol/openid-connect/token`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ grant_type: 'password', client_id: 'irc-client', username, password: PASSWORD }),
  });
  if (!res.ok) throw new Error(`token for ${username}: ${res.status} ${await res.text()}`);
  return (await res.json()).access_token;
}

/** X3's view of who a client is: the account name, or '' when X3 has no binding. */
async function x3Account(c: RawSocketClient): Promise<string> {
  c.clearRawBuffer();
  c.send(`PRIVMSG ${NICKSERV_NICK} :ACCOUNTINFO`);
  const line = await c.waitForLine(/Account Information for|You must be authenticated first/, 10000);
  const m = /Account Information for \x02?([^\x02\s]+)/.exec(line);
  return m ? m[1] : '';
}

/** Connect, log in by SASL PLAIN, finish registration. */
async function connectAs(account: string, nick: string): Promise<RawSocketClient> {
  const c = await createRawSocketClient();
  await c.capLs();
  await c.capReq(['sasl']);
  const r = await authenticateSaslPlain(c, account, PASSWORD);
  expect(r.success, `SASL PLAIN as ${account}: ${r.error}`).toBe(true);
  c.capEnd();
  c.register(nick);
  await c.waitForNumeric('001', 15000);
  return c;
}

function ircdIp(): string {
  return run('docker', ['inspect', '-f', '{{range .NetworkSettings.Networks}}{{.IPAddress}}{{end}}', 'nefarious']).trim();
}

function ircdWebhookSecret(): string {
  const m = /"WEBHOOK_SECRET"\s*=\s*"([^"]+)"/.exec(fs.readFileSync('../data/ircd.conf', 'utf8'));
  if (!m) throw new Error('WEBHOOK_SECRET not in data/ircd.conf');
  return m[1];
}

describe('X3 follows the ircd account changes', () => {
  let thirdId = '';

  beforeAll(async () => {
    if (GATED) return;
    token = await getKeycloakAdminToken();
    await kcCreateUser(FIRST);
    await kcCreateUser(SECOND);
    thirdId = await kcCreateUser(THIRD);
    // Keycloak-created users reach X3 by LDAP autocreate on first login; nothing to register.
  }, 60_000);

  afterAll(async () => {
    if (GATED) return;
    await kcDeleteUser(FIRST);
    await kcDeleteUser(SECOND);
    await kcDeleteUser(THIRD);
  });

  it.skipIf(GATED)('rebinds when a client re-authenticates to another account (AC M)', async () => {
    const c = await connectAs(FIRST, `acc${tag}m`);
    try {
      expect(await x3Account(c)).toBe(FIRST);

      const bearer = await kcUserToken(SECOND);
      const r = await authenticateSaslOAuthBearer(c, bearer);   // post-registration re-auth -> AC M
      expect(r.success, `SASL OAUTHBEARER as ${SECOND}: ${r.error}`).toBe(true);

      expect(await x3Account(c)).toBe(SECOND);                  // X3 followed
    } finally {
      c.close();
    }
  }, 60_000);

  it.skipIf(GATED)('unbinds when the ircd removes the account (AC U)', async () => {
    const c = await connectAs(THIRD, `acc${tag}u`);
    try {
      expect(await x3Account(c)).toBe(THIRD);

      // The admin event the Keycloak SPI sends when the account is disabled, with the ircd's secret.
      const body = JSON.stringify({
        resourceType: 'USER', operationType: 'UPDATE', resourcePath: `users/${thirdId}`,
        representation: JSON.stringify({ enabled: false }),
        username: THIRD, realmId: REALM, time: Date.now(),
      });
      const res = await fetch(`http://${ircdIp()}:9090/keycloak-webhook`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-Webhook-Secret': ircdWebhookSecret() },
        body,
      });
      expect(res.status, 'ircd webhook accepted the event').toBeLessThan(300);

      await c.waitForLine(/Account disabled/, 15000);   // the ircd deauthed us and sent AC U
      expect(await x3Account(c)).toBe('');              // X3 unbound
    } finally {
      c.close();
    }
  }, 60_000);
});
