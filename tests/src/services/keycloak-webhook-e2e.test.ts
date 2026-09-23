/**
 * Real Keycloak admin actions reach the ircd and act (audit P0-1, P0-2).
 *
 * Keycloak's USER admin events name the subject only by uuid in
 * resourcePath: DELETE and reset-password carry nothing else, UPDATE carries
 * the changed fields.  The ircd resolves the subject by the Keycloak id it
 * has carried on every logged-in client and every positive-cache entry since
 * step 5, so no username is needed.  Before the fix handle_user_event
 * returned on the missing username and nothing happened: the session stayed
 * authenticated and the positive cache kept answering the old password for
 * SASL_POSCACHE_TTL.
 *
 * Every case primes the positive cache with a second login (a cache hit
 * never asks Keycloak), so "login fails afterwards" is the cache purge, not
 * Keycloak's own refusal.  Needs real delivery: the SPI must send to the
 * ircd with its secret (plan task 1).
 */
import { describe, it, expect, beforeAll, afterAll, afterEach } from 'vitest';
import { RawSocketClient, createRawSocketClient } from '../helpers/index.js';
import { authenticateSaslPlain } from '../helpers/sasl';
import { getKeycloakAdminToken } from '../helpers/keycloak-sync';
import { whoisAccount } from '../helpers/webhook-post';

const KC = process.env.KEYCLOAK_URL || 'http://localhost:8080';
const REALM = 'testnet';
const tag = Math.random().toString(36).slice(2, 7);
const USER = `testwh${tag}`;                    // 'test*' is swept by cleanup-tests.ts
const PASSWORD = 'Webhook!2026';
const NEW_PASSWORD = 'Webhook!2026b';
let token = '';
let userId = '';

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function kc(p: string, init: RequestInit = {}): Promise<Response> {
  return fetch(`${KC}/admin/realms/${REALM}${p}`, {
    ...init,
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json', ...(init.headers || {}) },
  });
}

async function kcCreateUser(username: string, password: string): Promise<string> {
  const res = await kc('/users', {
    method: 'POST',
    body: JSON.stringify({
      username, enabled: true, emailVerified: true, email: `${username}@example.com`,
      credentials: [{ type: 'password', value: password, temporary: false }],
    }),
  });
  if (!res.ok && res.status !== 409) throw new Error(`create ${username}: ${res.status} ${await res.text()}`);
  const q = await kc(`/users?username=${encodeURIComponent(username)}&exact=true`);
  return (await q.json())[0].id;
}

/** SASL PLAIN as the user; resolves to the registered client, or null when the login was refused. */
async function tryLogin(password: string, nick: string): Promise<RawSocketClient | null> {
  const c = await createRawSocketClient();
  await c.capLs();
  await c.capReq(['sasl']);
  const r = await authenticateSaslPlain(c, USER, password);
  if (!r.success) { c.close(); return null; }
  c.capEnd();
  c.register(nick);
  await c.waitForNumeric('001', 15000);
  return c;
}

/** Poll WHOIS until the nick shows no account, or give up. */
async function loggedOutWithin(c: RawSocketClient, nick: string, ms: number): Promise<boolean> {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    if ((await whoisAccount(c, nick)) === '') return true;
    await sleep(500);
  }
  return false;
}

describe('Keycloak admin actions reach the ircd', () => {
  const clients: RawSocketClient[] = [];

  beforeAll(async () => {
    token = await getKeycloakAdminToken();
    userId = await kcCreateUser(USER, PASSWORD);
  }, 60_000);

  afterEach(() => {
    for (const c of clients) { try { c.close(); } catch { /* ignore */ } }
    clients.length = 0;
  });

  afterAll(async () => {
    token = await getKeycloakAdminToken();
    await kc(`/users/${userId}`, { method: 'DELETE' });   // 404 after case C is fine
  });

  it('disable deauths the session and stops the cached password', async () => {
    const primary = await tryLogin(PASSWORD, `wh${tag}a`);
    expect(primary, 'first login').not.toBeNull();
    clients.push(primary!);
    const cached = await tryLogin(PASSWORD, `wh${tag}b`);          // primes the positive cache
    expect(cached, 'second login (cache hit)').not.toBeNull();
    clients.push(cached!);

    expect((await kc(`/users/${userId}`, { method: 'PUT', body: JSON.stringify({ enabled: false }) })).status).toBe(204);

    try {
      expect(await loggedOutWithin(primary!, `wh${tag}a`, 8000), 'the session lost its account').toBe(true);
      const again = await tryLogin(PASSWORD, `wh${tag}c`);
      if (again) clients.push(again);
      expect(again, 'the cached password no longer logs in').toBeNull();
    } finally {
      // The later cases need the user back, whatever this one found.
      expect((await kc(`/users/${userId}`, { method: 'PUT', body: JSON.stringify({ enabled: true }) })).status).toBe(204);
    }
  }, 90_000);

  it('an admin password reset stops the old password at once', async () => {
    const c1 = await tryLogin(PASSWORD, `wh${tag}d`);
    expect(c1, 'login after re-enable').not.toBeNull();
    clients.push(c1!);
    const c2 = await tryLogin(PASSWORD, `wh${tag}e`);               // primes the positive cache
    expect(c2).not.toBeNull();
    clients.push(c2!);

    expect((await kc(`/users/${userId}/reset-password`, {
      method: 'PUT',
      body: JSON.stringify({ type: 'password', value: NEW_PASSWORD, temporary: false }),
    })).status).toBe(204);
    await sleep(2000);

    const old = await tryLogin(PASSWORD, `wh${tag}f`);
    if (old) clients.push(old);
    expect(old, 'the old password is refused (cache purged)').toBeNull();
    const fresh = await tryLogin(NEW_PASSWORD, `wh${tag}g`);
    expect(fresh, 'the new password works').not.toBeNull();
    clients.push(fresh!);
  }, 90_000);

  it('delete deauths the session and stops the cached password, even for a user who logged out', async () => {
    const stay = await tryLogin(NEW_PASSWORD, `wh${tag}h`);
    expect(stay).not.toBeNull();
    clients.push(stay!);
    const gone = await tryLogin(NEW_PASSWORD, `wh${tag}i`);          // primes the cache, then leaves
    expect(gone).not.toBeNull();
    gone!.close();
    await sleep(1000);

    expect((await kc(`/users/${userId}`, { method: 'DELETE' })).status).toBe(204);

    expect(await loggedOutWithin(stay!, `wh${tag}h`, 8000), 'the live session lost its account').toBe(true);
    const again = await tryLogin(NEW_PASSWORD, `wh${tag}j`);
    if (again) clients.push(again);
    expect(again, 'the cached password of the deleted user no longer logs in').toBeNull();
  }, 90_000);
});
