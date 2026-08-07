/**
 * LDAP identity binding — account-name reuse must not inherit privileges.
 *
 * Deleting an account in Keycloak cascades the LDAP entry away but leaves X3's
 * saxdb handle behind, and everything keyed to that handle (channel access,
 * oper level) with it. Because both of X3's auth paths join saxdb to the
 * directory on nothing but the account NAME, whoever registered that name next
 * used to bind straight onto the previous owner's privileges.
 *
 * X3 now stores the directory's immutable identity key (entryUUID) on the
 * handle and compares it at auth. A rename preserves that key; a
 * delete-and-recreate mints a new one, which is what these tests exercise.
 */
import { describe, it, expect, beforeAll } from 'vitest';
import { createX3Client } from '../helpers/x3-client';
// NB: only getKeycloakAdminToken is imported. The realm-scoped helpers in
// keycloak-sync.ts default to realm 'irc' (KEYCLOAK_REALM is unset on this
// bed), which does not exist here — they 404. Token fetch is done inline below.
import { getKeycloakAdminToken } from '../helpers/keycloak-sync';

const KC = process.env.KEYCLOAK_URL || 'http://localhost:8080';
const REALM = 'testnet';

let token: string;

async function kc(path: string, init: RequestInit = {}): Promise<Response> {
  return fetch(`${KC}/admin/realms/${REALM}${path}`, {
    ...init,
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
      ...(init.headers || {}),
    },
  });
}

async function createUser(username: string, password: string): Promise<void> {
  const res = await kc('/users', {
    method: 'POST',
    body: JSON.stringify({
      username,
      enabled: true,
      emailVerified: true,
      email: `${username}@example.com`,
      credentials: [{ type: 'password', value: password, temporary: false }],
    }),
  });
  if (!res.ok && res.status !== 409) {
    throw new Error(`createUser ${username} failed: ${res.status} ${await res.text()}`);
  }
}

async function findUserId(username: string): Promise<string | undefined> {
  const res = await kc(`/users?username=${encodeURIComponent(username)}&exact=true`);
  const users = await res.json();
  return users[0]?.id;
}

async function deleteUser(username: string): Promise<void> {
  const id = await findUserId(username);
  if (id) await kc(`/users/${id}`, { method: 'DELETE' });
}

/** Prove a credential is actually valid at Keycloak (ROPC against the irc client). */
async function keycloakAccepts(username: string, password: string): Promise<boolean> {
  const res = await fetch(`${KC}/realms/${REALM}/protocol/openid-connect/token`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'password',
      client_id: process.env.KEYCLOAK_IRC_CLIENT || 'irc-client',
      username,
      password,
    }).toString(),
  });
  return res.ok;
}

/** Auth on a fresh connection — a handle binds per-session, so reuse would mask the result. */
async function authFresh(account: string, password: string) {
  const client = await createX3Client();
  try {
    return await client.auth(account, password, 20000);
  } finally {
    client.close();
  }
}

describe('LDAP identity binding', () => {
  beforeAll(async () => {
    token = await getKeycloakAdminToken();
  });

  it('refuses a handle whose directory identity was replaced by a name reuse', async () => {
    const account = `idb${Date.now().toString(36).slice(-6)}`;
    const original = 'Orig1nal!pass';
    const impostor = 'Imp0stor!pass';

    // The original owner registers and authenticates. X3 autocreates the handle
    // and binds it to this directory entry's entryUUID.
    await createUser(account, original);
    const first = await authFresh(account, original);
    expect(first.success, `original owner should auth: ${first.lines.join(' | ')}`).toBe(true);

    // The identity is destroyed Keycloak-side. The X3 handle survives — that is
    // the stranding this whole control exists to contain.
    await deleteUser(account);

    // Somebody else registers the same name. Different person, different
    // credential, brand new entryUUID, same string.
    await createUser(account, impostor);

    // The impostor's credential is genuinely VALID — Keycloak issues them a
    // token. Without this the test would also pass on a plain bad password,
    // which proves nothing about identity binding.
    expect(
      await keycloakAccepts(account, impostor),
      'impostor credential must be valid at Keycloak, or this test proves nothing',
    ).toBe(true);

    const second = await authFresh(account, impostor);
    expect(
      second.success,
      `name reuse must NOT open the stranded handle: ${second.lines.join(' | ')}`,
    ).toBe(false);
    expect(second.lines.join(' ')).toMatch(/no longer exists|contact network staff/i);

    await deleteUser(account);
  }, 180000);

  it('lets the same identity authenticate repeatedly', async () => {
    const account = `idb${Date.now().toString(36).slice(-6)}s`;
    const password = 'Stable1!pass';

    await createUser(account, password);
    const first = await authFresh(account, password);
    expect(first.success, `first auth: ${first.lines.join(' | ')}`).toBe(true);

    // Second auth compares against the identity stored on the first — this is
    // the check's false-positive guard.
    const second = await authFresh(account, password);
    expect(second.success, `repeat auth must still work: ${second.lines.join(' | ')}`).toBe(true);

    await deleteUser(account);
  }, 180000);
});
