/**
 * SASL re-authentication after registration.
 *
 * m_authenticate.c lets a registered client authenticate again with
 * OAUTHBEARER only (token refresh or a change of account); every other
 * mechanism gets ERR_SASLALREADY (907).  Until now the command table sent a
 * registered client's AUTHENTICATE to the already-registered handler (462),
 * so that block was unreachable and the ircd could never announce an
 * account change (AC M) for a client action.
 *
 * Tokens are minted to the public irc-client; the bed's ircd skips the
 * issuing-client check (insecure_token_validation).
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { createRawSocketClient, RawSocketClient } from '../helpers/index.js';
import { authenticateSaslPlain, authenticateSaslOAuthBearer } from '../helpers/sasl';
import { getKeycloakAdminToken } from '../helpers/keycloak-sync';

const KC = process.env.KEYCLOAK_URL || 'http://localhost:8080';
const REALM = 'testnet';

// 'test*' is swept by src/scripts/cleanup-tests.ts.
const tag = Math.random().toString(36).slice(2, 7);
const FIRST = `testrea${tag}a`;
const SECOND = `testrea${tag}b`;
const PASSWORD = 'Change!2026';

let token = '';

async function kc(p: string, init: RequestInit = {}): Promise<Response> {
  return fetch(`${KC}/admin/realms/${REALM}${p}`, {
    ...init,
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json', ...(init.headers || {}) },
  });
}

async function kcCreateUser(username: string): Promise<void> {
  const res = await kc('/users', {
    method: 'POST',
    body: JSON.stringify({
      username, enabled: true, emailVerified: true, email: `${username}@example.com`,
      credentials: [{ type: 'password', value: PASSWORD, temporary: false }],
    }),
  });
  if (!res.ok && res.status !== 409) throw new Error(`create ${username}: ${res.status} ${await res.text()}`);
}

async function kcDeleteUser(username: string): Promise<void> {
  const q = await kc(`/users?username=${encodeURIComponent(username)}&exact=true`);
  const id = (await q.json())[0]?.id;
  if (id) await kc(`/users/${id}`, { method: 'DELETE' });
}

/** A bearer token for a realm user, minted to the public irc-client. */
async function kcUserToken(username: string): Promise<string> {
  const res = await fetch(`${KC}/realms/${REALM}/protocol/openid-connect/token`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ grant_type: 'password', client_id: 'irc-client', username, password: PASSWORD }),
  });
  if (!res.ok) throw new Error(`token for ${username}: ${res.status} ${await res.text()}`);
  return (await res.json()).access_token;
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

/** The account WHOIS reports for the client's own nick (330), or '' when none. */
async function whoisAccount(c: RawSocketClient, nick: string): Promise<string> {
  c.clearRawBuffer();
  c.send(`WHOIS ${nick}`);
  const end = await c.waitForLine(new RegExp(` (330|318) ${nick} `), 10000);
  const m = new RegExp(` 330 ${nick} ${nick} (\\S+) `).exec(end);
  return m ? m[1] : '';
}

describe('SASL re-authentication after registration', () => {
  beforeAll(async () => {
    token = await getKeycloakAdminToken();
    await kcCreateUser(FIRST);
    await kcCreateUser(SECOND);
  }, 60_000);

  afterAll(async () => {
    await kcDeleteUser(FIRST);
    await kcDeleteUser(SECOND);
  });

  it('OAUTHBEARER changes the account of a registered client', async () => {
    const nick = `rea${tag}o`;
    const c = await connectAs(FIRST, nick);
    try {
      expect(await whoisAccount(c, nick)).toBe(FIRST);

      const r = await authenticateSaslOAuthBearer(c, await kcUserToken(SECOND));
      expect(r.success, `SASL OAUTHBEARER as ${SECOND}: ${r.error}`).toBe(true);
      expect(r.account).toBe(SECOND);

      expect(await whoisAccount(c, nick)).toBe(SECOND);
    } finally {
      c.close();
    }
  }, 60_000);

  it('PLAIN is still refused with ERR_SASLALREADY once SASL has completed', async () => {
    const nick = `rea${tag}p`;
    const c = await connectAs(FIRST, nick);
    try {
      c.clearRawBuffer();
      c.send('AUTHENTICATE PLAIN');
      const line = await c.waitForLine(/ (907|462|AUTHENTICATE) /, 10000);
      expect(line, 'the re-auth guard answers, not the already-registered handler').toMatch(/ 907 /);
      expect(await whoisAccount(c, nick)).toBe(FIRST);
    } finally {
      c.close();
    }
  }, 60_000);
});
