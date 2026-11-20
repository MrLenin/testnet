import { execFileSync } from 'node:child_process';
import { createHash, createHmac, pbkdf2Sync, randomBytes } from 'node:crypto';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

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

/** The password grant; `extra` adds form parameters (for example `totp`, the one-time code). */
export async function passwordGrant(realm: string, username: string, password: string,
  extra: Record<string, string> = {}): Promise<{ status: number; body: any }> {
  const r = await fetch(`${URL}/realms/${realm}/protocol/openid-connect/token`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ grant_type: 'password', client_id: 'probe', username, password, ...extra }),
  });
  return { status: r.status, body: await r.json().catch(() => null) };
}

/** A client-credentials token of one of the realm's confidential clients (`ircd`, `reader`). */
export async function serviceToken(realm: string, clientId: string): Promise<string> {
  const r = await fetch(`${URL}/realms/${realm}/protocol/openid-connect/token`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ grant_type: 'client_credentials', client_id: clientId, client_secret: CLIENT_SECRET }),
  });
  if (!r.ok) throw new Error(`serviceToken ${realm} ${clientId}: ${r.status}`);
  return (await r.json()).access_token;
}

export async function ircdToken(realm: string): Promise<string> {
  return serviceToken(realm, 'ircd');
}

/** Grants the realm role `role` to the service account of the client `clientId`. */
export async function grantRealmRole(realm: string, clientId: string, role: string): Promise<void> {
  const token = await adminToken();
  const get = async (path: string) => {
    const r = await fetch(`${URL}/admin/realms/${realm}/${path}`, auth(token));
    if (!r.ok) throw new Error(`grantRealmRole GET ${path}: ${r.status}`);
    return r.json();
  };
  const [client] = await get(`clients?clientId=${encodeURIComponent(clientId)}&search=false`);
  if (!client) throw new Error(`grantRealmRole: no client ${clientId}`);
  const account = await get(`clients/${client.id}/service-account-user`);
  const rep = await get(`roles/${encodeURIComponent(role)}`);
  const r = await fetch(`${URL}/admin/realms/${realm}/users/${account.id}/role-mappings/realm`,
    json(token, 'POST', [{ id: rep.id, name: rep.name }]));
  if (r.status !== 204) throw new Error(`grantRealmRole ${role}: ${r.status} ${await r.text()}`);
}

/** The admin API's user search with `q` (space-separated `attribute:value` pairs), as the ircd's certificate lookup does it. */
export async function adminSearch(realm: string, q: string): Promise<any[]> {
  const r = await fetch(`${URL}/admin/realms/${realm}/users?q=${encodeURIComponent(q)}`, auth(await adminToken()));
  if (!r.ok) throw new Error(`adminSearch ${q}: ${r.status}`);
  return r.json();
}

async function ircCall(method: string, path: string, token?: string, body?: unknown): Promise<{ status: number; body: any }> {
  const headers: Record<string, string> = {};
  if (token) headers.Authorization = `Bearer ${token}`;
  if (body !== undefined) headers['Content-Type'] = 'application/json';
  const r = await fetch(`${URL}${path}`, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
  const text = await r.text();
  let parsed: any = null;
  try { parsed = text ? JSON.parse(text) : null; } catch { parsed = text; }
  return { status: r.status, body: parsed };
}

/** PUT /realms/{realm}/irc/certfp/{username} with `{sha256, sha512, name}`. */
export async function certfpAdd(realm: string, username: string, body: object, token?: string): Promise<{ status: number; body: any }> {
  return ircCall('PUT', `/realms/${realm}/irc/certfp/${encodeURIComponent(username)}`, token, body);
}

/** DELETE /realms/{realm}/irc/certfp/{username}/{sha512}. */
export async function certfpDelete(realm: string, username: string, sha512: string, token?: string): Promise<{ status: number; body: any }> {
  return ircCall('DELETE', `/realms/${realm}/irc/certfp/${encodeURIComponent(username)}/${encodeURIComponent(sha512)}`, token);
}

/** GET /realms/{realm}/irc/certfp/{username}. */
export async function certfpList(realm: string, username: string, token?: string): Promise<{ status: number; body: any }> {
  return ircCall('GET', `/realms/${realm}/irc/certfp/${encodeURIComponent(username)}`, token);
}

export function uniqueRealm(prefix: string): string {
  return `${prefix}-${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
}

/** GET /realms/{realm}/irc/credentials/{username}; the username is percent-encoded as one path segment. */
export async function ircCredentials(realm: string, username: string, token?: string): Promise<{ status: number; body: any }> {
  const r = await fetch(`${URL}/realms/${realm}/irc/credentials/${encodeURIComponent(username)}`,
    token ? auth(token) : undefined);
  return { status: r.status, body: await r.json().catch(() => null) };
}

/** Runs tools/irc_realm_setup.py against the throwaway Keycloak; the test fails if the tool exits non-zero. */
export function runRealmSetup(realm: string, args: string[] = []): void {
  const tool = resolve(dirname(fileURLToPath(import.meta.url)), '../../../keycloak-webhook-spi/tools/irc_realm_setup.py');
  execFileSync('python3', [tool, '--url', URL, '--realm', realm, '--admin-user', ADMIN_USER,
    '--admin-pass-env', 'SPI_IT_ADMIN_PASS', ...args],
  { env: { ...process.env, SPI_IT_ADMIN_PASS: ADMIN_PASS }, stdio: 'pipe' });
}

/** True when `scram` (an endpoint `scram` object) is a verifier of `password`: StoredKey recomputed with its salt and iterations. */
export function verifierMatches(scram: any, password: string): boolean {
  if (!scram) return false;
  const salted = pbkdf2Sync(password, Buffer.from(scram.salt, 'base64'), scram.iterations, 32, 'sha256');
  const clientKey = createHmac('sha256', salted).update('Client Key').digest();
  return createHash('sha256').update(clientKey).digest('base64') === scram.storedKey;
}

/**
 * The legacy user-attribute form of a SCRAM-SHA-256 verifier of `password`, under one attribute family
 * (`scram_sha256_`, `x3_scram_` or `x3_scram_sha256_`): base64 salt/keys, decimal iterations, as the old policy wrote them.
 */
export function legacyScramAttributes(password: string, family = 'scram_sha256_'): Record<string, string[]> {
  const salt = randomBytes(16);
  const salted = pbkdf2Sync(password, salt, 4096, 32, 'sha256');
  const storedKey = createHash('sha256').update(createHmac('sha256', salted).update('Client Key').digest()).digest();
  const serverKey = createHmac('sha256', salted).update('Server Key').digest();
  return {
    [`${family}salt`]: [salt.toString('base64')], [`${family}iterations`]: ['4096'],
    [`${family}stored_key`]: [storedKey.toString('base64')], [`${family}server_key`]: [serverKey.toString('base64')],
  };
}

/** The id of the realm's user with exactly this username. */
export async function userIdOf(realm: string, username: string): Promise<string> {
  const r = await fetch(`${URL}/admin/realms/${realm}/users?username=${encodeURIComponent(username)}&exact=true`,
    auth(await adminToken()));
  if (!r.ok) throw new Error(`userIdOf ${username}: ${r.status}`);
  const found = await r.json();
  if (found.length !== 1) throw new Error(`userIdOf ${username}: ${found.length} matches`);
  return found[0].id;
}

// The throwaway directory (container ldap-spi-it); no port is published, so it is driven with docker exec.
const LDAP_BASE = 'dc=spi-it,dc=invalid';
const LDAP_USERS = `ou=users,${LDAP_BASE}`;
const LDAP_ADMIN_DN = `cn=admin,${LDAP_BASE}`;
const LDAP_ADMIN_PASS = 'spi-it-ldap';

function ldap(tool: string, args: string[], input?: string): void {
  execFileSync('docker', ['exec', '-i', 'ldap-spi-it', tool, '-x', '-H', 'ldap://localhost',
    '-D', LDAP_ADMIN_DN, '-w', LDAP_ADMIN_PASS, ...args], { input, stdio: 'pipe' });
}

function ldapExists(dn: string): boolean {
  try {
    ldap('ldapsearch', ['-LLL', '-b', dn, '-s', 'base', 'dn']);
    return true;
  } catch (e: any) {
    if (e.status === 32) return false;   // LDAP noSuchObject
    throw e;
  }
}

/** Adds (or replaces) an inetOrgAnonAccount under ou=users with a complete profile, then sets its password. */
export function ldapAddUser(uid: string, password: string): void {
  if (!ldapExists(LDAP_USERS)) {
    ldap('ldapadd', [], `dn: ${LDAP_USERS}\nobjectClass: organizationalUnit\nou: users\n`);
  }
  const dn = `uid=${uid},${LDAP_USERS}`;
  if (ldapExists(dn)) ldap('ldapdelete', [dn]);
  ldap('ldapadd', [], `dn: ${dn}\nobjectClass: inetOrgAnonAccount\nuid: ${uid}\ncn: ${uid}\nsn: Test\nmail: ${uid}@spi-it.invalid\n`);
  ldapSetPassword(uid, password);
}

/** Removes the entry if it exists, so a later realm's full sync does not import it. */
export function ldapDeleteUser(uid: string): void {
  const dn = `uid=${uid},${LDAP_USERS}`;
  if (ldapExists(dn)) ldap('ldapdelete', [dn]);
}

/** Changes the password in the directory only (as X3 does): Keycloak is not told. */
export function ldapSetPassword(uid: string, password: string): void {
  ldap('ldappasswd', ['-s', password, `uid=${uid},${LDAP_USERS}`]);
}

/**
 * Links the realm to the directory (users under ou=users, periodic sync off), runs one full sync, returns the provider id.
 * `validatePasswordPolicy` is the provider's "Validate password policy" switch (Keycloak's default: off).
 * Registrations are not synced: users the tests create through Keycloak stay local, and the shared directory
 * collects no entries that a later run's full sync would import into its fresh realm.
 */
export async function addLdapProvider(realm: string, editMode: 'WRITABLE' | 'READ_ONLY',
  opts: { validatePasswordPolicy?: boolean } = {}): Promise<string> {
  const token = await adminToken();
  const config: Record<string, string> = {
    connectionUrl: 'ldap://ldap-spi-it:389', usersDn: LDAP_USERS, bindDn: LDAP_ADMIN_DN, bindCredential: LDAP_ADMIN_PASS,
    authType: 'simple', vendor: 'other', usernameLDAPAttribute: 'uid', rdnLDAPAttribute: 'uid',
    uuidLDAPAttribute: 'entryUUID', userObjectClasses: 'inetOrgAnonAccount', searchScope: '1', trustEmail: 'true',
    pagination: 'true', editMode, importEnabled: 'true', syncRegistrations: 'false', enabled: 'true',
    fullSyncPeriod: '-1', changedSyncPeriod: '-1', cachePolicy: 'NO_CACHE',
    validatePasswordPolicy: String(opts.validatePasswordPolicy ?? false),
  };
  const body = {
    name: 'ldap', providerId: 'ldap', providerType: 'org.keycloak.storage.UserStorageProvider',
    config: Object.fromEntries(Object.entries(config).map(([k, v]) => [k, [v]])),
  };
  const r = await fetch(`${URL}/admin/realms/${realm}/components`, json(token, 'POST', body));
  if (r.status !== 201) throw new Error(`addLdapProvider ${realm}: ${r.status} ${await r.text()}`);
  const id = r.headers.get('location')!.split('/').pop()!;
  const s = await fetch(`${URL}/admin/realms/${realm}/user-storage/${id}/sync?action=triggerFullSync`, json(token, 'POST'));
  if (!s.ok) throw new Error(`LDAP full sync ${realm}: ${s.status} ${await s.text()}`);
  return id;
}

/** Switches an existing LDAP provider's edit mode (for example WRITABLE to READ_ONLY). */
export async function setLdapEditMode(realm: string, providerId: string, editMode: 'WRITABLE' | 'READ_ONLY'): Promise<void> {
  const token = await adminToken();
  const g = await fetch(`${URL}/admin/realms/${realm}/components/${providerId}`, auth(token));
  if (!g.ok) throw new Error(`setLdapEditMode lookup ${providerId}: ${g.status}`);
  const component = await g.json();
  component.config.editMode = [editMode];
  const r = await fetch(`${URL}/admin/realms/${realm}/components/${providerId}`, json(token, 'PUT', component));
  if (r.status !== 204) throw new Error(`setLdapEditMode ${providerId}: ${r.status} ${await r.text()}`);
}

/** A pre-hashed pbkdf2-sha256 password credential representation, as the admin API accepts it. */
export function pbkdf2Cred(password: string): object {
  const salt = randomBytes(16);
  const hash = pbkdf2Sync(password, salt, 27500, 64, 'sha256');
  return {
    type: 'password',
    secretData: JSON.stringify({ value: hash.toString('base64'), salt: salt.toString('base64') }),
    credentialData: JSON.stringify({ hashIterations: 27500, algorithm: 'pbkdf2-sha256' }),
  };
}

/** An OTP credential representation (TOTP, the realm's default policy: HmacSHA1, 6 digits, 30 s), as the admin API accepts it. */
export function otpCred(secret: string): object {
  return {
    type: 'otp', userLabel: 'test',
    secretData: JSON.stringify({ value: secret }),
    credentialData: JSON.stringify({ subType: 'totp', digits: 6, counter: 0, period: 30, algorithm: 'HmacSHA1' }),
  };
}

/** The current TOTP code for `secret` under the default policy; Keycloak keys the HMAC with the secret's UTF-8 bytes. */
export function totp(secret: string, now = Date.now()): string {
  const counter = Buffer.alloc(8);
  counter.writeBigUInt64BE(BigInt(Math.floor(now / 1000 / 30)));
  const h = createHmac('sha1', Buffer.from(secret, 'utf8')).update(counter).digest();
  const o = h[h.length - 1] & 0xf;
  return String((h.readUInt32BE(o) & 0x7fffffff) % 1_000_000).padStart(6, '0');
}

// The public client browserAction logs in through; its redirect URI is never fetched, only recognised.
const BROWSER_CLIENT = 'spi-it-browser';
const BROWSER_REDIRECT = 'https://spi-it.invalid/callback';

function htmlUnescape(s: string): string {
  return s.replace(/&(?:#(\d+)|#x([0-9a-f]+)|(amp|quot|apos|lt|gt));/gi, (_, dec, hex, name) =>
    dec ? String.fromCodePoint(Number(dec)) : hex ? String.fromCodePoint(parseInt(hex, 16))
      : ({ amp: '&', quot: '"', apos: "'", lt: '<', gt: '>' } as Record<string, string>)[name.toLowerCase()]);
}

/** The (HTML-unescaped) action URL of the page's first form. */
function formAction(html: string): string {
  const m = /<form\b[^>]*\baction="([^"]*)"/i.exec(html);
  if (!m) throw new Error(`browserAction: no form on the page: ${html.slice(0, 300)}`);
  return htmlUnescape(m[1]);
}

/**
 * Runs the application-initiated action `action` in a browser-like session: an authorization request
 * with `kc_action`, the login form (the realm's bound browser flow) with `username` / `password`, then the
 * action's form with `fields`. Cookies are kept by hand and redirects followed one by one. `status` is the
 * `kc_action_status` of the redirect back to the client, or `form` when the action's form is shown again
 * (`html` is that page). Adds a public client with the standard flow to the realm if it has none.
 */
export async function browserAction(realm: string, username: string, password: string, action: string,
  fields: Record<string, string>): Promise<{ status: string; html: string }> {
  const token = await adminToken();
  const found = await fetch(`${URL}/admin/realms/${realm}/clients?clientId=${BROWSER_CLIENT}&search=false`, auth(token));
  if (!found.ok) throw new Error(`browserAction client lookup: ${found.status}`);
  if ((await found.json()).length === 0) {
    const created = await fetch(`${URL}/admin/realms/${realm}/clients`, json(token, 'POST', {
      clientId: BROWSER_CLIENT, enabled: true, publicClient: true, standardFlowEnabled: true,
      directAccessGrantsEnabled: false, redirectUris: [BROWSER_REDIRECT],
    }));
    if (created.status !== 201) throw new Error(`browserAction client: ${created.status} ${await created.text()}`);
  }

  const jar = new Map<string, string>();
  const send = async (url: string, form?: Record<string, string>): Promise<Response> => {
    const headers: Record<string, string> = { Cookie: [...jar].map(([k, v]) => `${k}=${v}`).join('; ') };
    if (form) headers['Content-Type'] = 'application/x-www-form-urlencoded';
    const r = await fetch(url, { method: form ? 'POST' : 'GET', redirect: 'manual', headers,
      body: form ? new URLSearchParams(form) : undefined });
    for (const c of r.headers.getSetCookie()) {
      const [pair, ...attrs] = c.split(';');
      const eq = pair.indexOf('=');
      const name = pair.slice(0, eq).trim();
      const value = pair.slice(eq + 1).trim();
      const expires = attrs.map(a => a.trim()).find(a => /^expires=/i.test(a));
      const gone = value === '' || attrs.some(a => /^\s*max-age=0\s*$/i.test(a))
        || (expires !== undefined && Date.parse(expires.slice(8)) <= Date.now());
      if (gone) jar.delete(name); else jar.set(name, value);
    }
    return r;
  };
  // Follows redirects until a page is shown (its HTML) or Keycloak sends the browser back to the client (that URL).
  const settle = async (r: Response): Promise<{ back?: globalThis.URL; html?: string }> => {
    for (let hops = 0; hops < 10; hops++) {
      if (r.status < 300 || r.status >= 400) {
        if (r.status !== 200) throw new Error(`browserAction: HTTP ${r.status} at ${r.url}: ${(await r.text()).slice(0, 300)}`);
        return { html: await r.text() };
      }
      const next = new globalThis.URL(r.headers.get('location')!, r.url);
      if (next.href.startsWith(BROWSER_REDIRECT)) return { back: next };
      r = await send(next.href);
    }
    throw new Error('browserAction: too many redirects');
  };
  const done = (back: globalThis.URL) => ({ status: back.searchParams.get('kc_action_status') ?? '', html: '' });

  const start = new globalThis.URL(`${URL}/realms/${realm}/protocol/openid-connect/auth`);
  start.search = new URLSearchParams({ client_id: BROWSER_CLIENT, redirect_uri: BROWSER_REDIRECT,
    response_type: 'code', scope: 'openid', kc_action: action }).toString();
  const login = await settle(await send(start.href));
  if (login.back) throw new Error(`browserAction: no login form, sent back to ${login.back.href}`);
  const afterLogin = await settle(await send(formAction(login.html!), { username, password }));
  if (afterLogin.back) return done(afterLogin.back);
  if (afterLogin.html!.includes('id="kc-form-login"')) throw new Error(`browserAction: login as ${username} failed`);
  const after = await settle(await send(formAction(afterLogin.html!), fields));
  return after.back ? done(after.back) : { status: 'form', html: after.html! };
}
