/**
 * During a burst, a different Keycloak id is refused but nobody is
 * disconnected (design F, ruling D2): the announcement may be a replay of a
 * legitimate login, so X3 leaves the user unbound and logs it.  The same run
 * shows the id surviving a hop (the client sits on nefarious2, X3 links to
 * nefarious) and a relink re-sending the id.
 *
 * DISRUPTIVE: stops and starts the x3 container.  GATED behind KC_ID_BIND=1:
 * needs nefarious from fix/wire-keycloak-id and x3 from
 * feature/keycloak-id-binding.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import * as fs from 'node:fs';
import { spawnSync } from 'node:child_process';
import { run, flushX3Saxdb } from '../helpers/bed-control';
import { createRawSocketClient, createClientOnServer, SECONDARY_SERVER, RawSocketClient } from '../helpers/ircv3-client.js';
import { authenticateSaslPlain } from '../helpers/sasl';
import { NICKSERV_NICK } from '../helpers/x3-client';
import { getKeycloakAdminToken } from '../helpers/keycloak-sync';

const GATED = process.env.KC_ID_BIND !== '1';
const KC = process.env.KEYCLOAK_URL || 'http://localhost:8080';
const REALM = 'testnet';

// 'test*' is swept by src/scripts/cleanup-tests.ts.
const tag = Math.random().toString(36).slice(2, 7);
const NAME = `testbst${tag}`;
const PASSWORD = 'Burst!2026';

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

/** Log in by SASL PLAIN and finish registration on the given client. */
async function loginOn(c: RawSocketClient, nick: string): Promise<void> {
  await c.capLs();
  await c.capReq(['sasl']);
  const r = await authenticateSaslPlain(c, NAME, PASSWORD);
  expect(r.success, `SASL PLAIN as ${NAME}: ${r.error}`).toBe(true);
  c.capEnd();
  c.register(nick);
  await c.waitForNumeric('001', 15000);
}

/** X3's view of who a client is: the account name, or '' when X3 has no binding. */
async function boundAccount(c: RawSocketClient): Promise<string> {
  c.clearRawBuffer();
  c.send(`PRIVMSG ${NICKSERV_NICK} :ACCOUNTINFO`);
  const line = await c.waitForLine(/Account Information for|must be authenticated/, 8000).catch(() => '');
  return /Account Information for \x02?([^\x02\s]+)/.exec(line)?.[1] ?? '';
}

function x3Logs(since: string): string {
  const r = spawnSync('docker', ['logs', '--since', since, 'x3'], { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
  return (r.stdout ?? '') + (r.stderr ?? '');
}

/** Start x3 and wait until it has finished bursting with the ircd. */
async function startX3AndWaitForLink(): Promise<void> {
  run('docker', ['start', 'x3']);
  const deadline = Date.now() + 90_000;
  while (Date.now() < deadline) {
    if (/End of burst|W: DH EB|W: DH Z/.test(x3Logs('120s'))) return;
    await new Promise((res) => setTimeout(res, 3000));
  }
  throw new Error('x3 did not relink within 90s');
}

describe('a different Keycloak id during a burst', () => {
  beforeAll(async () => {
    if (GATED) return;
    token = await getKeycloakAdminToken();
    await kcCreate();
  }, 60_000);

  afterAll(async () => {
    if (GATED) return;
    try { run('docker', ['start', 'x3']); } catch { /* already running */ }
    await kcDelete();
  });

  it.skipIf(GATED)('is refused without a disconnect, and the id crosses the hop and the relink', async () => {
    // Bind the handle to the current user's id, and get it on disk.
    const owner = await createRawSocketClient();
    try {
      await loginOn(owner, `bst${tag}a`);
      expect(await boundAccount(owner)).toBe(NAME);
    } finally {
      owner.close();
    }
    await flushX3Saxdb(NAME);

    // A new user with the same name, while X3 is away.
    const oldId = await kcDelete();
    await tellIrcdUserDeleted(oldId);
    await kcCreate();
    run('docker', ['stop', 'x3']);

    const c = await createClientOnServer(SECONDARY_SERVER);   // nefarious2: one hop from X3
    try {
      await loginOn(c, `bst${tag}b`);

      // X3 comes back and receives the client in the burst with the new id.
      await startX3AndWaitForLink();
      await new Promise((res) => setTimeout(res, 5000));

      expect(x3Logs('180s'), 'X3 refused the announcement during the burst')
        .toMatch(new RegExp(`announced account ${NAME} with a different Keycloak id during a burst: refused`));

      c.clearRawBuffer();
      c.send('PING :still-here');
      await c.waitForLine(/PONG/, 8000);                       // not disconnected
      expect(await boundAccount(c), 'X3 left the user unbound').toBe('');
    } finally {
      c.close();
    }
  }, 240_000);
});
