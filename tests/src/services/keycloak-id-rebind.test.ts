/**
 * REBIND: an oper sets or clears the Keycloak user id a handle is bound to
 * (design F, 5b).  The case it exists for: a name legitimately deleted and
 * recreated in Keycloak has a new id, so its logins are refused until an
 * oper re-binds the handle -- to the new id from the admin console, or to
 * nothing, so the next login adopts one.
 *
 * After the recreate, the test delivers the Keycloak delete event to the
 * ircd's webhook listener (with the ircd's own secret), as the SPI would,
 * so the ircd's positive SASL cache does not answer with the previous id.
 *
 * GATED behind KC_ID_BIND=1: needs nefarious from fix/wire-keycloak-id and
 * x3 from feature/keycloak-id-binding.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import * as fs from 'node:fs';
import { run } from '../helpers/bed-control';
import { createRawSocketClient, RawSocketClient } from '../helpers/index.js';
import { authenticateSaslPlain } from '../helpers/sasl';
import { createOperClient, NICKSERV_NICK, OPSERV_NICK } from '../helpers/x3-client';
import { getKeycloakAdminToken } from '../helpers/keycloak-sync';

const GATED = process.env.KC_ID_BIND !== '1';
const KC = process.env.KEYCLOAK_URL || 'http://localhost:8080';
const REALM = 'testnet';

// 'test*' is swept by src/scripts/cleanup-tests.ts.
const tag = Math.random().toString(36).slice(2, 7);
const NAME = `testreb${tag}`;
const PASSWORD = 'Rebind!2026';

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

async function login(nick: string): Promise<{ c: RawSocketClient; ok: boolean; closed: boolean }> {
  const c = await createRawSocketClient();
  await c.capLs();
  await c.capReq(['sasl']);
  const r = await authenticateSaslPlain(c, NAME, PASSWORD);
  c.capEnd();
  c.register(nick);
  const closed = await c.waitForLine(/ KILL \S+ :|ERROR :Closing Link/, 12000).then(() => true, () => false);
  if (!closed) await c.waitForNumeric('001', 12000).catch(() => {});
  return { c, ok: r.success, closed };
}

/** X3's view of who a client is: the account name, or '' when X3 has no binding. */
async function boundAccount(c: RawSocketClient): Promise<string> {
  c.clearRawBuffer();
  c.send(`PRIVMSG ${NICKSERV_NICK} :ACCOUNTINFO`);
  const line = await c.waitForLine(/Account Information for|must be authenticated/, 8000).catch(() => '');
  return /Account Information for \x02?([^\x02\s]+)/.exec(line)?.[1] ?? '';
}

/** Run one service command as an oper with the security override on; returns the reply lines. */
async function asOper(command: string, service: string = NICKSERV_NICK): Promise<string> {
  const op = await createOperClient();
  try {
    const god = await op.serviceCmd(OPSERV_NICK, 'GOD ON');
    expect(god.join('\n'), 'GOD ON').toMatch(/Security override has been enabled|already have security override enabled/);
    return (await op.serviceCmd(service, command)).join('\n');
  } finally {
    op.close();
  }
}

/**
 * Bind the command to AuthServ.  X3 keeps a service's command bindings in
 * its database, and a service that already has some does not pick up a
 * module's new commands on restart, so an operator binds them once:
 * /msg O3 BIND AuthServ REBIND *nickserv.rebind.  Idempotent here.
 */
async function bindRebind(): Promise<void> {
  const reply = await asOper(`BIND ${NICKSERV_NICK} REBIND *nickserv.rebind`, OPSERV_NICK);
  expect(reply, 'REBIND bound to AuthServ').toMatch(/bound|already/i);
}

describe('REBIND re-binds or clears a handle\'s Keycloak id', () => {
  let newId = '';

  beforeAll(async () => {
    if (GATED) return;
    token = await getKeycloakAdminToken();
    await kcCreate();
    await bindRebind();
  }, 60_000);

  afterAll(async () => {
    if (GATED) return;
    await kcDelete();
  });

  it.skipIf(GATED)('a recreated Keycloak user is let back in by REBIND to the new id, and by clearing', async () => {
    const first = await login(`reb${tag}a`);
    try {
      expect(first.ok && !first.closed, 'first login bound').toBe(true);
      expect(await boundAccount(first.c)).toBe(NAME);
    } finally {
      first.c.close();
    }

    const oldId = await kcDelete();
    await tellIrcdUserDeleted(oldId);
    newId = await kcCreate();                          // the same name, a new user id

    const refused = await login(`reb${tag}b`);
    refused.c.close();
    expect(refused.closed, 'the new-id login is refused until an oper re-binds').toBe(true);

    // Re-bind to the new id, as an oper would with the UUID from the admin console.
    expect(await asOper(`REBIND *${NAME} ${newId}`)).toMatch(/Keycloak id set for account/i);
    const back = await login(`reb${tag}c`);
    try {
      expect(back.closed, 'after REBIND to the new id the login is accepted').toBe(false);
      expect(await boundAccount(back.c)).toBe(NAME);
    } finally {
      back.c.close();
    }

    // Clearing works too: the next login adopts whatever id it carries.
    expect(await asOper(`REBIND *${NAME} *`)).toMatch(/binding cleared/i);
    const adopted = await login(`reb${tag}d`);
    try {
      expect(adopted.closed, 'after clearing, the login is accepted and adopts').toBe(false);
      expect(await boundAccount(adopted.c)).toBe(NAME);
    } finally {
      adopted.c.close();
    }
  }, 180_000);

  it.skipIf(GATED)('refuses a value that is not a Keycloak UUID', async () => {
    expect(await asOper(`REBIND *${NAME} not-an-id`)).toMatch(/Keycloak ID/i);
  }, 60_000);
});
