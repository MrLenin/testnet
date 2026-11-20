import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import {
  URL, auth, adminToken, createRealm, deleteRealm, createUser, setPassword, getUser, putUser, getCredentials,
  passwordGrant, ircdToken, ircCredentials, runRealmSetup, pbkdf2Cred, uniqueRealm, verifierMatches,
  ldapAddUser, ldapSetPassword, addLdapProvider,
} from '../helpers/kc-spi-it';

const LEGACY_ATTRIBUTES = {
  scram_sha256_salt: ['c2FsdA=='], scram_sha256_iterations: ['4096'],
  scram_sha256_stored_key: ['c3RvcmVk'], scram_sha256_server_key: ['c2VydmVy'],
  x3_scram_salt: ['c2FsdA=='], x3_scram_sha256_stored_key: ['c3RvcmVk'],
};

async function allUsers(realm: string): Promise<any[]> {
  const r = await fetch(`${URL}/admin/realms/${realm}/users?briefRepresentation=false&max=1000`, auth(await adminToken()));
  if (!r.ok) throw new Error(`list users ${realm}: ${r.status}`);
  return r.json();
}

// The tests run in file order and share users: 'life' carries its password from one test to the next.
describe('SCRAM verifier lifecycle (password set, login, LDAP, account page, cleanup)', () => {
  const realm = uniqueRealm('life');
  let t: string;
  let id: string;
  beforeAll(async () => {
    await createRealm(realm, {passwordPolicy: 'scramSha256'});
    runRealmSetup(realm, ['--service-client', 'ircd']);
    t = await ircdToken(realm);
    id = await createUser(realm, 'life');
  });
  afterAll(async () => { await deleteRealm(realm); });

  it('a plaintext password set through Keycloak yields a matching verifier at once', async () => {
    expect(await setPassword(realm, id, 'First-Pass-1')).toBe(204);
    const s = (await ircCredentials(realm, 'life', t)).body.scram;
    expect(verifierMatches(s, 'First-Pass-1')).toBe(true);
    expect(s.iterations).toBe(4096);
    expect(Buffer.from(s.salt, 'base64')).toHaveLength(16);
  });

  it('a user loaded with a pre-hashed password has no verifier until the first password login', async () => {
    await createUser(realm, 'imported', {credentials: [pbkdf2Cred('Imported-Pass-1')]});
    expect((await ircCredentials(realm, 'imported', t)).body.scram).toBeUndefined();
    expect((await passwordGrant(realm, 'imported', 'Imported-Pass-1')).status).toBe(200);
    expect(verifierMatches((await ircCredentials(realm, 'imported', t)).body.scram, 'Imported-Pass-1')).toBe(true);
  });

  it('replacing the password behind the SPI drops the old verifier; the next login makes the new one', async () => {
    const pw = (await getCredentials(realm, id)).find(c => c.type === 'password');
    const del = await fetch(`${URL}/admin/realms/${realm}/users/${id}/credentials/${pw.id}`,
      {method: 'DELETE', headers: {Authorization: `Bearer ${await adminToken()}`}});
    expect(del.status).toBe(204);
    expect(await putUser(realm, id, {credentials: [pbkdf2Cred('Second-Pass-2')]})).toBe(204);
    expect((await ircCredentials(realm, 'life', t)).body.scram).toBeUndefined();
    expect((await passwordGrant(realm, 'life', 'Second-Pass-2')).status).toBe(200);
    const s = (await ircCredentials(realm, 'life', t)).body.scram;
    expect(verifierMatches(s, 'Second-Pass-2')).toBe(true);
    expect(verifierMatches(s, 'First-Pass-1')).toBe(false);
  });

  it('an LDAP-linked user gets a verifier at login, and a password changed in LDAP is repaired at the next login', async () => {
    ldapAddUser('linked', 'Ldap-Pass-1');
    await addLdapProvider(realm, 'WRITABLE');
    expect((await ircCredentials(realm, 'linked', t)).body.scram).toBeUndefined();
    expect((await passwordGrant(realm, 'linked', 'Ldap-Pass-1')).status).toBe(200);
    expect(verifierMatches((await ircCredentials(realm, 'linked', t)).body.scram, 'Ldap-Pass-1')).toBe(true);
    ldapSetPassword('linked', 'Ldap-Pass-2');   // X3's path: Keycloak is not told
    // Known limit while LDAP remains: there is no local password for the verifier to follow.
    expect(verifierMatches((await ircCredentials(realm, 'linked', t)).body.scram, 'Ldap-Pass-1')).toBe(true);
    expect((await passwordGrant(realm, 'linked', 'Ldap-Pass-2')).status).toBe(200);
    const s = (await ircCredentials(realm, 'linked', t)).body.scram;
    expect(verifierMatches(s, 'Ldap-Pass-2')).toBe(true);
    expect(verifierMatches(s, 'Ldap-Pass-1')).toBe(false);
  });

  it('once the realm is set up, the account page lists the SCRAM entry read-only for a user who has one', async () => {
    const token = (await passwordGrant(realm, 'life', 'Second-Pass-2')).body.access_token;
    const r = await fetch(`${URL}/realms/${realm}/account/credentials`,
      {headers: {...(auth(token).headers as object), Accept: 'application/json'}});
    expect(r.status).toBe(200);
    const body = await r.json();
    const entry = body.find((c: any) => c.type === 'irc-scram-sha256');
    expect(entry).toBeDefined();
    expect(entry.createAction).toBeUndefined();
    expect(entry.updateAction).toBeUndefined();
    expect(entry.removeable).toBe(false);
    expect(entry.userCredentialMetadatas).toHaveLength(1);
    expect(JSON.stringify(body)).not.toContain('storedKey');
    expect(JSON.stringify(body)).not.toContain('serverKey');
  });

  it('a failed login derives nothing and no user attribute is ever written', async () => {
    await createUser(realm, 'imported2', {credentials: [pbkdf2Cred('Imported-Pass-2')]});
    expect((await passwordGrant(realm, 'imported2', 'Wrong-Pass-2')).status).toBe(401);
    expect((await ircCredentials(realm, 'imported2', t)).body.scram).toBeUndefined();
    const users = await allUsers(realm);
    expect(users.map(u => u.username)).toEqual(expect.arrayContaining(['life', 'imported', 'linked', 'imported2']));
    for (const u of users) {
      expect(Object.keys(u.attributes ?? {}).filter(k => k.toLowerCase().includes('scram'))).toEqual([]);
    }
  });

  it('the cleanup removes the old attributes', async () => {
    const legacy = await createUser(realm, 'legacy');
    expect(await putUser(realm, legacy, {attributes: {...LEGACY_ATTRIBUTES, keep_me: ['yes']}})).toBe(204);
    expect(Object.keys((await getUser(realm, legacy)).attributes)).toEqual(expect.arrayContaining(Object.keys(LEGACY_ATTRIBUTES)));
    runRealmSetup(realm, ['--drop-legacy-scram-attributes']);
    const attrs = (await getUser(realm, legacy)).attributes ?? {};
    expect(Object.keys(attrs).filter(k => k.includes('scram'))).toEqual([]);
    expect(attrs.keep_me).toEqual(['yes']);
  });
});
