/**
 * The Keycloak user id rides the wire with the account (design F, 5a).
 *
 * After a SASL PLAIN login the ircd introduces the user to its peers with
 * +r account:ts:id, where id is the user's Keycloak id in its compact form
 * and ts is 0: the timestamp field is X3's registration date, stamped by X3
 * when it authenticates a user itself, and the ircd has none of its own to
 * put there (Keycloak's creation time is not that date; user, 2026-09-24)
 * (16 UUID bytes as 22 base64url characters).  The linked server parses the
 * third field (a debug line shows what it took).  A later re-authentication
 * to another account announces AC ... M account ts id, and a second
 * connection to the same account -- a bouncer alias -- is introduced with
 * the primary's id.
 *
 * The re-authentication uses OAUTHBEARER, the one mechanism the ircd allows
 * after registration; its id comes from the client's own token, which on
 * the bed carries "sub".  Wire lines are read from the origin server's
 * debug log (what it sent) and the linked server's (what it parsed); X3
 * logs only what it writes.
 *
 * GATED behind WIRE_KC_ID=1: needs nefarious from fix/wire-keycloak-id on
 * both servers.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { spawnSync } from 'node:child_process';
import { createRawSocketClient, RawSocketClient } from '../helpers/index.js';
import { authenticateSaslPlain, authenticateSaslOAuthBearer } from '../helpers/sasl';
import { getKeycloakAdminToken } from '../helpers/keycloak-sync';

const GATED = process.env.WIRE_KC_ID !== '1';
const KC = process.env.KEYCLOAK_URL || 'http://localhost:8080';
const REALM = 'testnet';

// 'test*' is swept by src/scripts/cleanup-tests.ts.
const tag = Math.random().toString(36).slice(2, 7);
const A = `testwid${tag}a`;
const B = `testwid${tag}b`;
const PASSWORD = 'Wire!2026';
const ID = '[A-Za-z0-9_-]{22}';

let token = '';
let idA = '';
let idB = '';

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
  return (await (await kc(`/users?username=${encodeURIComponent(username)}&exact=true`)).json())[0].id;
}

async function kcDeleteUser(username: string): Promise<void> {
  const id = (await (await kc(`/users?username=${encodeURIComponent(username)}&exact=true`)).json())[0]?.id;
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

/** Compact form of a canonical UUID, as the ircd encodes it. */
function compact(uuid: string): string {
  return Buffer.from(uuid.replace(/-/g, ''), 'hex').toString('base64url');
}

/** The container's log, both streams: the ircd writes its log lines to stderr. */
function logs(container: string): string {
  const r = spawnSync('docker', ['logs', '--since', '3m', container], { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
  return (r.stdout ?? '') + (r.stderr ?? '');
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

const settle = () => new Promise((res) => setTimeout(res, 2000));

describe('Keycloak user id on the wire', () => {
  beforeAll(async () => {
    if (GATED) return;
    token = await getKeycloakAdminToken();
    idA = await kcCreateUser(A);
    idB = await kcCreateUser(B);
  }, 60_000);

  afterAll(async () => {
    if (GATED) return;
    await kcDeleteUser(A);
    await kcDeleteUser(B);
  });

  it.skipIf(GATED)('introduction carries +r account:ts:id, and it is the Keycloak id', async () => {
    const nick = `wid${tag}n`;
    const c = await connectAs(A, nick);
    try {
      await settle();
      const intro = new RegExp(` N ${nick} \\d+ \\d+ \\S+ \\S+ \\+\\S*r\\S* ${A}:0:(${ID})`);
      const sent = intro.exec(logs('nefarious'));
      expect(sent, 'the origin server sent the introduction with a third field').not.toBeNull();
      expect(sent![1]).toBe(compact(idA));

      const parsed = intro.exec(logs('nefarious2'));
      expect(parsed, 'the linked server received it').not.toBeNull();
      expect(logs('nefarious2')).toMatch(new RegExp(`Received account id ${compact(idA)} in user mode`));
    } finally {
      c.close();
    }
  }, 60_000);

  it.skipIf(GATED)('a re-authentication announces AC M with the new id', async () => {
    const nick = `wid${tag}m`;
    const c = await connectAs(A, nick);
    try {
      const r = await authenticateSaslOAuthBearer(c, await kcUserToken(B));
      expect(r.success, `SASL OAUTHBEARER as ${B}: ${r.error}`).toBe(true);
      await settle();

      const ac = new RegExp(` AC \\S+ M ${B} 0 (${ID})`);
      const sent = ac.exec(logs('nefarious'));
      expect(sent, 'the origin server sent AC M with an id').not.toBeNull();
      expect(sent![1]).toBe(compact(idB));
      expect(ac.exec(logs('nefarious2')), 'the linked server received AC M with an id').not.toBeNull();
      expect(logs('nefarious2')).toMatch(new RegExp(`Received account id ${compact(idB)} for account "${B}"`));
    } finally {
      c.close();
    }
  }, 60_000);

  it.skipIf(GATED)('a second connection to the account (an alias) is introduced with the same id', async () => {
    const primary = await connectAs(A, `wid${tag}p`);
    let alias: RawSocketClient | undefined;
    try {
      alias = await connectAs(A, `wid${tag}q`);
      await settle();
      const bx = new RegExp(` BX C \\S+ \\S+ ${A} \\S+ \\+\\S*r\\S* ${A}:0:(${ID})`);
      const sent = bx.exec(logs('nefarious'));
      expect(sent, 'the alias introduction carries a third field').not.toBeNull();
      expect(sent![1]).toBe(compact(idA));
    } finally {
      alias?.close();
      primary.close();
    }
  }, 60_000);
});
