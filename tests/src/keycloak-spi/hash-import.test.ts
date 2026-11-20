import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { spawnSync } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  URL, adminToken, createRealm, deleteRealm, createUser, getCredentials, passwordGrant, ircdToken, ircCredentials,
  runRealmSetup, uniqueRealm, verifierMatches, userIdOf, getUser, ldapAddUser, ldapDeleteUser, addLdapProvider,
} from '../helpers/kc-spi-it';

const TOOL = resolve(dirname(fileURLToPath(import.meta.url)), '../../../keycloak-webhook-spi/tools/import_ldap_hashes.py');
const MD5_SECRET = '{MD5}Xr4ilOzQ4PCOq3aQ0qbuaQ==';   // MD5 of "secret"
const MD5_BODY = 'Xr4ilOzQ4PCOq3aQ0qbuaQ';
const salt = Buffer.from([1, 2, 3, 4]);
const SSHA_SECRET = '{SSHA}' + Buffer.concat([createHash('sha1').update('secret').update(salt).digest(), salt]).toString('base64');

const entry = (uid: string, ...lines: string[]) => [`dn: uid=${uid},ou=people,dc=spi-it,dc=invalid`, `uid: ${uid}`, ...lines].join('\n');
const LDIF = [
  entry('alice', 'userPassword:: ' + Buffer.from(MD5_SECRET).toString('base64')),
  entry('bob', 'userPassword: ' + SSHA_SECRET),
  entry('carol'),
  entry('erin', 'userPassword: {CRYPT}$1$abc$def'),
  entry('zed', 'userPassword: ' + MD5_SECRET),
].join('\n\n') + '\n';

function run(realm: string, ldif: string, args: string[] = []): { status: number; out: string; counts: Record<string, number> } {
  const r = spawnSync('python3', [TOOL, '--ldif', ldif, '--url', URL, '--realm', realm, '--admin-user', 'admin',
    '--admin-pass-env', 'SPI_IT_ADMIN_PASS', ...args],
  { env: { ...process.env, SPI_IT_ADMIN_PASS: 'spi-it-admin', PYTHONDONTWRITEBYTECODE: '1' }, encoding: 'utf-8' });
  const counts: Record<string, number> = {};
  for (const line of r.stdout.split('\n')) {
    const m = line.match(/^(\S+) (\d+)$/);
    if (m) counts[m[1]] = Number(m[2]);
  }
  return { status: r.status ?? -1, out: r.stdout + r.stderr, counts };
}

describe('LDAP hash import tool', () => {
  const realm = uniqueRealm('himport');
  let dir: string, ldif: string, token: string;
  const ids: Record<string, string> = {};
  const passwordCount = async (u: string) => (await getCredentials(realm, ids[u])).filter(c => c.type === 'password').length;

  beforeAll(async () => {
    await createRealm(realm, { passwordPolicy: 'scramSha256' });
    runRealmSetup(realm, ['--service-client', 'ircd']);
    token = await ircdToken(realm);
    for (const u of ['alice', 'bob', 'carol', 'erin']) ids[u] = await createUser(realm, u);
    dir = mkdtempSync(join(tmpdir(), 'hash-import-'));
    ldif = join(dir, 'users.ldif');
    writeFileSync(ldif, LDIF);
  });
  afterAll(async () => { rmSync(dir, { recursive: true, force: true }); await deleteRealm(realm); });

  it('a dry run changes nothing and reports what it would do', async () => {
    const r = run(realm, ldif);
    expect(r.status).toBe(0);
    expect(r.counts).toEqual({ 'would-load': 2, 'no-password': 1, 'no-such-user': 1, 'unsupported:{CRYPT}': 1 });
    expect(await passwordCount('alice')).toBe(0);
    expect((await passwordGrant(realm, 'alice', 'secret')).status).toBe(401);
  });

  it('--apply loads the hashes and the original passwords work', async () => {
    const r = run(realm, ldif, ['--apply']);
    expect(r.status).toBe(0);
    expect(r.counts).toEqual({ loaded: 2, 'no-password': 1, 'no-such-user': 1, 'unsupported:{CRYPT}': 1 });
    expect((await passwordGrant(realm, 'alice', 'wrong')).status).toBe(401);
    expect((await passwordGrant(realm, 'alice', 'secret')).status).toBe(200);
    expect((await passwordGrant(realm, 'bob', 'secret')).status).toBe(200);
    expect(await passwordCount('erin')).toBe(0);
  });

  it('after the first login the IRC endpoint serves a verifier of the original password', async () => {

    expect(verifierMatches((await ircCredentials(realm, 'alice', token)).body.scram, 'secret')).toBe(true);
  });

  it('a second --apply loads nothing and creates no second password', async () => {
    const r = run(realm, ldif, ['--apply']);
    expect(r.status).toBe(0);
    expect(r.counts['already-has-password']).toBe(2);
    expect(r.counts.loaded).toBe(0);
    expect(await passwordCount('alice')).toBe(1);
    expect(await passwordCount('bob')).toBe(1);
  });

  it('the output never contains a hash', async () => {
    const ssha = SSHA_SECRET.slice('{SSHA}'.length);
    for (const args of [[], ['--apply']]) {
      const out = run(realm, ldif, args).out;
      expect(out).not.toContain(MD5_BODY);
      expect(out).not.toContain(ssha.slice(0, 20));
    }
  });

  it('a user the admin API refuses is reported by name, the run goes on and the exit status is 1', async () => {
    // fred lacks an attribute the realm's User Profile later makes required for admins, so the write of his hash is refused; gina has it
    const r2 = uniqueRealm('himport-fail');
    await createRealm(r2);
    try {
      const url = `${URL}/admin/realms/${r2}/users/profile`;
      const hdr = async () => ({ Authorization: `Bearer ${await adminToken()}`, 'Content-Type': 'application/json' });
      const profile = await (await fetch(url, { headers: await hdr() })).json();
      const badge = { name: 'badge', permissions: { view: ['admin'], edit: ['admin'] } };
      const put = async (attr: object) => expect((await fetch(url, { method: 'PUT', headers: await hdr(),
        body: JSON.stringify({ ...profile, attributes: [...profile.attributes, attr] }) })).status).toBe(200);
      await put(badge);
      await createUser(r2, 'fred');
      await createUser(r2, 'gina', { attributes: { badge: ['1'] } });
      await put({ ...badge, required: { roles: ['admin'] } });
      const f = join(dir, 'fail.ldif');
      writeFileSync(f, [entry('fred', 'userPassword: ' + MD5_SECRET), entry('gina', 'userPassword: ' + MD5_SECRET)].join('\n\n') + '\n');
      const r = run(r2, f, ['--apply']);
      expect(r.status).toBe(1);
      expect(r.counts).toEqual({ failed: 1, loaded: 1 });
      expect(r.out).toMatch(/user fred: .*HTTP 400/);
      expect(r.out).not.toContain(MD5_BODY);
    } finally {
      await deleteRealm(r2);
    }
  });
});

/** `{SSHA}` of `password` with a random salt, as OpenLDAP stores it. */
function ssha(password: string): string {
  const s = randomBytes(8);
  return '{SSHA}' + Buffer.concat([createHash('sha1').update(password).update(s).digest(), s]).toString('base64');
}

describe('LDAP hash import: users still linked to the directory', () => {
  const realm = uniqueRealm('himport-ldap');
  const uid = `hlink${randomBytes(3).toString('hex')}`;
  const PW = 'Ldap-Orig-Pass-1';
  let dir: string, ldif: string, token: string, provider: string, id: string;
  const admin = async (method: string, path: string) =>
    fetch(`${URL}/admin/realms/${realm}/${path}`, { method, headers: { Authorization: `Bearer ${await adminToken()}` } });
  // Local password credentials only: for a linked user the list also shows the directory's password, without credentialData.
  const passwords = async () => (await getCredentials(realm, id)).filter(c => c.type === 'password' && c.credentialData).length;

  beforeAll(async () => {
    await createRealm(realm, { passwordPolicy: 'scramSha256' });
    runRealmSetup(realm, ['--service-client', 'ircd']);
    token = await ircdToken(realm);
    ldapAddUser(uid, PW);
    provider = await addLdapProvider(realm, 'WRITABLE');
    id = await userIdOf(realm, uid);
    expect((await getUser(realm, id)).federationLink).toBe(provider);
    dir = mkdtempSync(join(tmpdir(), 'hash-import-ldap-'));
    ldif = join(dir, 'linked.ldif');
    writeFileSync(ldif, entry(uid, 'userPassword: ' + ssha(PW)) + '\n');
  });
  afterAll(async () => { rmSync(dir, { recursive: true, force: true }); await deleteRealm(realm); ldapDeleteUser(uid); });

  it('a linked user is reported linked and not loaded, dry run and --apply alike; --allow-linked would load it', async () => {
    const dry = run(realm, ldif);
    expect(dry.status).toBe(0);
    expect(dry.counts).toEqual({ linked: 1, 'would-load': 0 });
    const applied = run(realm, ldif, ['--apply']);
    expect(applied.status).toBe(0);
    expect(applied.counts).toEqual({ linked: 1, loaded: 0 });
    expect(await passwords()).toBe(0);
    expect(run(realm, ldif, ['--allow-linked']).counts).toEqual({ 'would-load': 1 });
    expect(await passwords()).toBe(0);
  });

  it('the documented order: unlink the users, remove the provider, load; the original password logs in', async () => {
    expect((await passwordGrant(realm, uid, PW)).status).toBe(200);   // while linked: checked against the directory
    expect(verifierMatches((await ircCredentials(realm, uid, token)).body.scram, PW)).toBe(true);

    expect((await admin('POST', `user-storage/${provider}/unlink-users`)).status).toBe(204);
    expect((await admin('DELETE', `components/${provider}`)).status).toBe(204);
    expect((await getUser(realm, id)).federationLink).toBeUndefined();   // same account, same id, no link
    expect((await passwordGrant(realm, uid, PW)).status).toBe(401);       // no password until the load

    const r = run(realm, ldif, ['--apply']);
    expect(r.status).toBe(0);
    expect(r.counts).toEqual({ loaded: 1 });
    expect(await passwords()).toBe(1);
    // The loaded hash changes the password fingerprint, so the verifier made while linked is not served ...
    expect((await ircCredentials(realm, uid, token)).body.scram).toBeUndefined();
    expect((await passwordGrant(realm, uid, 'wrong')).status).toBe(401);
    expect((await passwordGrant(realm, uid, PW)).status).toBe(200);
    // ... until the next password login makes one for the re-hashed password.
    expect(verifierMatches((await ircCredentials(realm, uid, token)).body.scram, PW)).toBe(true);
  });
});
