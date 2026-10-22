/**
 * ACCOUNTINFO shows an account's bound Keycloak user id to an oper
 * (design F, 5b): the value REBIND sets or clears, in the compact form the
 * ircd announces (22 base64url characters).  Only to an oper: the account's
 * owner passes the same gate as staff and saw it too until 2026-10-22
 * (deferred-items C10; the plan said opers).
 *
 * GATED behind KC_ID_BIND=1: needs nefarious from fix/wire-keycloak-id and
 * x3 from feature/keycloak-id-binding.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { createRawSocketClient } from '../helpers/index.js';
import { authenticateSaslPlain } from '../helpers/sasl';
import { createOperClient, NICKSERV_NICK, OPSERV_NICK } from '../helpers/x3-client';
import { getKeycloakAdminToken } from '../helpers/keycloak-sync';

const GATED = process.env.KC_ID_BIND !== '1';
const KC = process.env.KEYCLOAK_URL || 'http://localhost:8080';
const REALM = 'testnet';

// 'test*' is swept by src/scripts/cleanup-tests.ts.
const tag = Math.random().toString(36).slice(2, 7);
const NAME = `testinf${tag}`;
const PASSWORD = 'Info!2026';

let token = '';

async function kc(p: string, init: RequestInit = {}): Promise<Response> {
  return fetch(`${KC}/admin/realms/${REALM}${p}`, {
    ...init,
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json', ...(init.headers || {}) },
  });
}

async function kcCreate(): Promise<void> {
  const res = await kc('/users', {
    method: 'POST',
    body: JSON.stringify({
      username: NAME, enabled: true, emailVerified: true, email: `${NAME}@example.com`,
      credentials: [{ type: 'password', value: PASSWORD, temporary: false }],
    }),
  });
  if (!res.ok && res.status !== 409) throw new Error(`create: ${res.status} ${await res.text()}`);
}

async function kcDelete(): Promise<void> {
  const id = (await (await kc(`/users?username=${NAME}&exact=true`)).json())[0]?.id;
  if (id) await kc(`/users/${id}`, { method: 'DELETE' });
}

/** Log in by SASL PLAIN once, so the handle exists and has adopted its id, then disconnect. */
async function loginOnce(nick: string): Promise<void> {
  const c = await createRawSocketClient();
  try {
    await c.capLs();
    await c.capReq(['sasl']);
    const r = await authenticateSaslPlain(c, NAME, PASSWORD);
    expect(r.success, `SASL PLAIN as ${NAME}: ${r.error}`).toBe(true);
    c.capEnd();
    c.register(nick);
    await c.waitForNumeric('001', 15000);
  } finally {
    c.close();
  }
}

/** Run one AuthServ command as an oper with the security override on; returns the reply lines. */
async function asOper(command: string): Promise<string> {
  const op = await createOperClient();
  try {
    const god = await op.serviceCmd(OPSERV_NICK, 'GOD ON');
    expect(god.join('\n'), 'GOD ON').toMatch(/Security override has been enabled|already have security override enabled/);
    return (await op.serviceCmd(NICKSERV_NICK, command)).join('\n');
  } finally {
    op.close();
  }
}

describe('ACCOUNTINFO shows the bound Keycloak id', () => {
  beforeAll(async () => {
    if (GATED) return;
    token = await getKeycloakAdminToken();
    await kcCreate();
  }, 60_000);

  afterAll(async () => {
    if (GATED) return;
    await kcDelete();
  });

  it.skipIf(GATED)('an oper sees the id an account is bound to', async () => {
    await loginOnce(`inf${tag}a`);
    const info = await asOper(`ACCOUNTINFO *${NAME}`);
    expect(info, 'the account is known').toMatch(new RegExp(`Account Information for \\x02?${NAME}`));
    expect(info, 'oper ACCOUNTINFO shows a Keycloak id').toMatch(/Keycloak ID:\s*[A-Za-z0-9_-]{22}/);
  }, 60_000);

  it.skipIf(GATED)('the account\'s owner does not see it (the oper case above bound it)', async () => {
    const c = await createRawSocketClient();
    try {
      await c.capLs();
      await c.capReq(['sasl']);
      const r = await authenticateSaslPlain(c, NAME, PASSWORD);
      expect(r.success, `SASL PLAIN as ${NAME}: ${r.error}`).toBe(true);
      c.capEnd();
      c.register(`inf${tag}o`);
      await c.waitForNumeric('001', 15000);
      await new Promise(res => setTimeout(res, 1500));
      const mark = c.allParsedLines.length;
      c.send(`PRIVMSG ${NICKSERV_NICK} :ACCOUNTINFO`);
      await c.waitForParsedLine(m => /Account Information for/.test(m.params[1] ?? ''), 8000);
      await new Promise(res => setTimeout(res, 2000));
      const info = c.allParsedLines.slice(mark).map(m => m.params[1] ?? '').join('\n');
      expect(info, 'setup: the owner gets the account information').toMatch(/Account Information for/);
      expect(info, 'the owner is not shown the Keycloak id').not.toMatch(/Keycloak ID:/);
    } finally {
      c.close();
    }
  }, 60_000);
});
