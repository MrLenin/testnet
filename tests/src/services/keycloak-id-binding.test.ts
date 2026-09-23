/**
 * A handle is bound to its Keycloak user id on first login, and a later
 * login as a DIFFERENT Keycloak user with the same name is refused
 * (design F, 5b).  Deleting a name in Keycloak and recreating it makes a
 * new user id: that is the case this catches.
 *
 * After the recreate, the test delivers the Keycloak delete event to the
 * ircd's webhook listener (with the ircd's own secret; the bed's SPI secret
 * does not match), as the SPI would: it clears the ircd's positive SASL
 * cache, which would otherwise answer the same name and password with the
 * previous user's id for five minutes.
 *
 * GATED behind KC_ID_BIND=1: needs nefarious from fix/wire-keycloak-id and
 * x3 from feature/keycloak-id-binding.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import * as fs from 'node:fs';
import { run, flushX3Saxdb } from '../helpers/bed-control';
import { createRawSocketClient, RawSocketClient } from '../helpers/index.js';
import { authenticateSaslPlain } from '../helpers/sasl';
import { NICKSERV_NICK } from '../helpers/x3-client';
import { getKeycloakAdminToken } from '../helpers/keycloak-sync';

const GATED = process.env.KC_ID_BIND !== '1';
const KC = process.env.KEYCLOAK_URL || 'http://localhost:8080';
const REALM = 'testnet';

// 'test*' is swept by src/scripts/cleanup-tests.ts.
const tag = Math.random().toString(36).slice(2, 7);
const NAME = `testkid${tag}`;
const PASSWORD = 'Ident!2026';

let token = '';

async function kc(p: string, init: RequestInit = {}): Promise<Response> {
  return fetch(`${KC}/admin/realms/${REALM}${p}`, {
    ...init,
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json', ...(init.headers || {}) },
  });
}

async function kcCreate(): Promise<string> {
  const res = await kc('/users', {
    method: 'POST',
    body: JSON.stringify({
      username: NAME, enabled: true, emailVerified: true, email: `${NAME}@example.com`,
      credentials: [{ type: 'password', value: PASSWORD, temporary: false }],
    }),
  });
  if (!res.ok && res.status !== 409) throw new Error(`create: ${res.status} ${await res.text()}`);
  return (await (await kc(`/users?username=${NAME}&exact=true`)).json())[0].id;
}

async function kcDelete(): Promise<string> {
  const id = (await (await kc(`/users?username=${NAME}&exact=true`)).json())[0]?.id;
  if (id) await kc(`/users/${id}`, { method: 'DELETE' });
  return id ?? '';
}

function ircdIp(): string {
  return run('docker', ['inspect', '-f', '{{range .NetworkSettings.Networks}}{{.IPAddress}}{{end}}', 'nefarious']).trim();
}

function ircdWebhookSecret(): string {
  const m = /"WEBHOOK_SECRET"\s*=\s*"([^"]+)"/.exec(fs.readFileSync('../data/ircd.conf', 'utf8'));
  if (!m) throw new Error('WEBHOOK_SECRET not in data/ircd.conf');
  return m[1];
}

/** The admin event the Keycloak SPI sends when a user is deleted; the ircd clears its caches for the name. */
async function tellIrcdUserDeleted(userId: string): Promise<void> {
  const body = JSON.stringify({
    resourceType: 'USER', operationType: 'DELETE', resourcePath: `users/${userId}`,
    username: NAME, realmId: REALM, time: Date.now(),
  });
  const res = await fetch(`http://${ircdIp()}:9090/keycloak-webhook`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-Webhook-Secret': ircdWebhookSecret() },
    body,
  });
  expect(res.status, 'ircd webhook accepted the delete event').toBeLessThan(300);
}

async function login(nick: string): Promise<{ c: RawSocketClient; ok: boolean; killed: boolean }> {
  const c = await createRawSocketClient();
  await c.capLs();
  await c.capReq(['sasl']);
  const r = await authenticateSaslPlain(c, NAME, PASSWORD);
  c.capEnd();
  c.register(nick);
  const killed = await c.waitForLine(/ KILL \S+ :|ERROR :Closing Link/, 12000).then(() => true, () => false);
  if (!killed) await c.waitForNumeric('001', 12000).catch(() => {});
  return { c, ok: r.success, killed };
}

/** X3's view of who a client is: the account name, or '' when X3 has no binding. */
async function boundAccount(c: RawSocketClient): Promise<string> {
  c.clearRawBuffer();
  c.send(`PRIVMSG ${NICKSERV_NICK} :ACCOUNTINFO`);
  const line = await c.waitForLine(/Account Information for|must be authenticated/, 8000).catch(() => '');
  return /Account Information for \x02?([^\x02\s]+)/.exec(line)?.[1] ?? '';
}

describe('a handle binds to its Keycloak user id', () => {
  beforeAll(async () => {
    if (GATED) return;
    token = await getKeycloakAdminToken();
    await kcCreate();
  }, 60_000);

  afterAll(async () => {
    if (GATED) return;
    await kcDelete();
  });

  it.skipIf(GATED)('adopts the id on first login and keeps the same id across logins', async () => {
    const first = await login(`kid${tag}a`);
    try {
      expect(first.ok && !first.killed, 'first login bound').toBe(true);
      expect(await boundAccount(first.c)).toBe(NAME);
    } finally {
      first.c.close();
    }

    const again = await login(`kid${tag}b`);          // same Keycloak user, same id
    try {
      expect(again.killed, 'the rightful owner is not disconnected').toBe(false);
      expect(await boundAccount(again.c)).toBe(NAME);
    } finally {
      again.c.close();
    }
  }, 90_000);

  it.skipIf(GATED)('refuses a different Keycloak user who took the name back', async () => {
    // The binding from the first test is on disk; persist it, then recreate
    // the Keycloak user so the name resolves to a new id.
    await flushX3Saxdb(NAME);
    const oldId = await kcDelete();
    await tellIrcdUserDeleted(oldId);
    await kcCreate();                                  // new user id for the same name

    const other = await login(`kid${tag}c`);
    try {
      expect(other.killed, 'the new-id login is refused and disconnected').toBe(true);
    } finally {
      other.c.close();
    }
  }, 120_000);
});
