// Helpers for the throwaway Keycloak (compose profile spi-it, port 18080).
// Never points at the bed's Keycloak.
export const URL: string = process.env.KC_SPI_IT_URL ?? 'http://localhost:18080';

const ADMIN_USER = 'admin';
const ADMIN_PASS = 'spi-it-admin';
const CLIENT_SECRET = 'spi-it-secret';

export function auth(token: string): RequestInit {
  return { headers: { Authorization: `Bearer ${token}` } };
}

function json(token: string, method: string, body?: unknown): RequestInit {
  return {
    method,
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  };
}

export async function adminToken(): Promise<string> {
  const r = await fetch(`${URL}/realms/master/protocol/openid-connect/token`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'password', client_id: 'admin-cli', username: ADMIN_USER, password: ADMIN_PASS,
    }),
  });
  if (!r.ok) throw new Error(`admin token failed: ${r.status}`);
  return (await r.json()).access_token;
}

export async function createRealm(name: string, extra: object = {}): Promise<void> {
  const token = await adminToken();
  const confidential = (clientId: string) => ({
    clientId, enabled: true, publicClient: false, secret: CLIENT_SECRET,
    serviceAccountsEnabled: true, standardFlowEnabled: false, directAccessGrantsEnabled: false,
  });
  const body = {
    realm: name, enabled: true,
    clients: [
      { clientId: 'probe', enabled: true, publicClient: true, directAccessGrantsEnabled: true, standardFlowEnabled: false },
      confidential('ircd'),
      confidential('reader'),
    ],
    attributes: { unmanagedAttributePolicy: 'ADMIN_EDIT' },
    ...extra,
  };
  const r = await fetch(`${URL}/admin/realms`, json(token, 'POST', body));
  if (r.status !== 201) throw new Error(`createRealm ${name}: ${r.status} ${await r.text()}`);
  // Declare the unmanaged-attribute policy through the profile too, so it is in force for this realm.
  const prof = await fetch(`${URL}/admin/realms/${name}/users/profile`, auth(token));
  if (prof.ok) {
    const cfg = await prof.json();
    cfg.unmanagedAttributePolicy = 'ADMIN_EDIT';
    const u = await fetch(`${URL}/admin/realms/${name}/users/profile`, json(token, 'PUT', cfg));
    if (!u.ok) throw new Error(`user profile update ${name}: ${u.status} ${await u.text()}`);
  }
}

export async function deleteRealm(name: string): Promise<void> {
  const r = await fetch(`${URL}/admin/realms/${name}`, { ...json(await adminToken(), 'DELETE') });
  if (r.status !== 204 && r.status !== 404) throw new Error(`deleteRealm ${name}: ${r.status}`);
}

export async function createUser(realm: string, username: string, extra: object = {}): Promise<string> {
  const token = await adminToken();
  const body = {
    username, enabled: true, email: `${username}@spi-it.invalid`, emailVerified: true,
    firstName: username, lastName: 'Test', ...extra,
  };
  const r = await fetch(`${URL}/admin/realms/${realm}/users`, json(token, 'POST', body));
  if (r.status !== 201) throw new Error(`createUser ${username}: ${r.status} ${await r.text()}`);
  return r.headers.get('location')!.split('/').pop()!;
}

export async function setPassword(realm: string, userId: string, password: string, temporary = false): Promise<number> {
  const r = await fetch(`${URL}/admin/realms/${realm}/users/${userId}/reset-password`,
    json(await adminToken(), 'PUT', { type: 'password', value: password, temporary }));
  return r.status;
}

export async function getUser(realm: string, userId: string): Promise<any> {
  const r = await fetch(`${URL}/admin/realms/${realm}/users/${userId}`, auth(await adminToken()));
  if (!r.ok) throw new Error(`getUser ${userId}: ${r.status}`);
  return r.json();
}

export async function putUser(realm: string, userId: string, patch: object): Promise<number> {
  const token = await adminToken();
  const g = await fetch(`${URL}/admin/realms/${realm}/users/${userId}`, auth(token));
  if (!g.ok) throw new Error(`putUser lookup ${userId}: ${g.status}`);
  const cur = await g.json();
  const r = await fetch(`${URL}/admin/realms/${realm}/users/${userId}`, json(token, 'PUT', { ...cur, ...patch }));
  return r.status;
}

export async function getCredentials(realm: string, userId: string): Promise<any[]> {
  const r = await fetch(`${URL}/admin/realms/${realm}/users/${userId}/credentials`, auth(await adminToken()));
  if (!r.ok) throw new Error(`getCredentials ${userId}: ${r.status}`);
  return r.json();
}

export async function passwordGrant(realm: string, username: string, password: string): Promise<{ status: number; body: any }> {
  const r = await fetch(`${URL}/realms/${realm}/protocol/openid-connect/token`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ grant_type: 'password', client_id: 'probe', username, password }),
  });
  return { status: r.status, body: await r.json().catch(() => null) };
}

export async function ircdToken(realm: string): Promise<string> {
  const r = await fetch(`${URL}/realms/${realm}/protocol/openid-connect/token`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ grant_type: 'client_credentials', client_id: 'ircd', client_secret: CLIENT_SECRET }),
  });
  if (!r.ok) throw new Error(`ircdToken ${realm}: ${r.status}`);
  return (await r.json()).access_token;
}

export function uniqueRealm(prefix: string): string {
  return `${prefix}-${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
}
