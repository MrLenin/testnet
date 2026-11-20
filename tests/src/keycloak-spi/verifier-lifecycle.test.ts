import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import {
  URL, auth, adminToken, createRealm, deleteRealm, createUser, setPassword, getUser, putUser, getCredentials,
  passwordGrant, ircdToken, ircCredentials, runRealmSetup, pbkdf2Cred, uniqueRealm, verifierMatches,
  ldapAddUser, ldapSetPassword, ldapDeleteUser, addLdapProvider, setLdapEditMode, legacyScramAttributes, userIdOf,
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
  afterAll(async () => { await deleteRealm(realm); ldapDeleteUser('linked'); });

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

describe('a password changed through Keycloak for an LDAP-linked user (provider validates the password policy)', () => {
  const realm = uniqueRealm('ldapset');
  let t: string;
  beforeAll(async () => {
    await createRealm(realm, {passwordPolicy: 'scramSha256'});
    runRealmSetup(realm, ['--service-client', 'ircd']);
    t = await ircdToken(realm);
    ldapAddUser('pwset', 'Ldap-Old-1');
    await addLdapProvider(realm, 'WRITABLE', {validatePasswordPolicy: true});
  });
  afterAll(async () => { await deleteRealm(realm); ldapDeleteUser('pwset'); });

  it('the verifier follows the new password at once', async () => {
    expect((await passwordGrant(realm, 'pwset', 'Ldap-Old-1')).status).toBe(200);
    expect(verifierMatches((await ircCredentials(realm, 'pwset', t)).body.scram, 'Ldap-Old-1')).toBe(true);
    expect(await setPassword(realm, await userIdOf(realm, 'pwset'), 'Ldap-New-2')).toBe(204);
    const s = (await ircCredentials(realm, 'pwset', t)).body.scram;
    expect(verifierMatches(s, 'Ldap-New-2')).toBe(true);
    expect(verifierMatches(s, 'Ldap-Old-1')).toBe(false);
    expect((await passwordGrant(realm, 'pwset', 'Ldap-New-2')).status).toBe(200);   // the directory has it too
  });
});

describe('a refused password change', () => {
  const realm = uniqueRealm('refused');
  let t: string;
  beforeAll(async () => {
    await createRealm(realm, {passwordPolicy: 'scramSha256 and length(12)'});
    runRealmSetup(realm, ['--service-client', 'ircd']);
    t = await ircdToken(realm);
  });
  afterAll(async () => { await deleteRealm(realm); });

  it('stores nothing for a user without a password', async () => {
    const id = await createUser(realm, 'nopass');
    expect(await setPassword(realm, id, 'short-1')).toBe(400);
    expect((await getCredentials(realm, id)).filter(c => c.type === 'irc-scram-sha256')).toEqual([]);
  });

  it('leaves an existing verifier as it was', async () => {
    const id = await createUser(realm, 'keeper');
    expect(await setPassword(realm, id, 'Long-Enough-Pass-1')).toBe(204);
    const before = (await ircCredentials(realm, 'keeper', t)).body.scram;
    expect(verifierMatches(before, 'Long-Enough-Pass-1')).toBe(true);
    expect(await setPassword(realm, id, 'short-2')).toBe(400);
    expect((await ircCredentials(realm, 'keeper', t)).body.scram).toEqual(before);
  });
});

describe('legacy attribute verifiers (read by IRC servers deployed before the credential)', () => {
  const realm = uniqueRealm('legattr');
  const X3_SCRAM = ['x3_scram_salt', 'x3_scram_iterations', 'x3_scram_stored_key', 'x3_scram_server_key'];
  let id: string;
  beforeAll(async () => {
    await createRealm(realm, {passwordPolicy: 'scramSha256'});
    runRealmSetup(realm);
    id = await createUser(realm, 'legacy-a');
    expect(await setPassword(realm, id, 'Legacy-Pass-A')).toBe(204);
  });
  afterAll(async () => { await deleteRealm(realm); });
  const scramKeys = async () => Object.keys((await getUser(realm, id)).attributes ?? {}).filter(k => k.includes('scram'));

  it('a login keeps the families that are verifiers of the password just proven and removes the others', async () => {
    const forA = legacyScramAttributes('Legacy-Pass-A');
    const x3ForA = legacyScramAttributes('Legacy-Pass-A', 'x3_scram_sha256_');
    const x3ForOther = legacyScramAttributes('Some-Other-Pass', 'x3_scram_');
    expect(await putUser(realm, id, {attributes: {...forA, ...x3ForA, ...x3ForOther}})).toBe(204);
    expect((await passwordGrant(realm, 'legacy-a', 'Legacy-Pass-A')).status).toBe(200);
    const attrs = (await getUser(realm, id)).attributes;
    expect(attrs).toMatchObject({...forA, ...x3ForA});
    for (const k of X3_SCRAM) expect(attrs[k]).toBeUndefined();
  });

  it('a password set through Keycloak removes them', async () => {
    expect((await scramKeys()).length).toBeGreaterThan(0);
    expect(await setPassword(realm, id, 'Legacy-Pass-B')).toBe(204);
    expect(await scramKeys()).toEqual([]);
  });

  it('a login with a different password removes attributes for the old one', async () => {
    expect(await putUser(realm, id, {attributes: legacyScramAttributes('Legacy-Pass-A')})).toBe(204);
    expect((await scramKeys()).length).toBe(4);
    expect((await passwordGrant(realm, 'legacy-a', 'Legacy-Pass-B')).status).toBe(200);
    expect(await scramKeys()).toEqual([]);
  });
});

// The legacy attributes live in Keycloak's own database, not in the directory: a READ_ONLY provider
// refuses attribute writes through the federated user, and that must neither stop the verifier nor keep them.
describe('legacy attribute verifiers on a READ_ONLY LDAP-linked user', () => {
  const realm = uniqueRealm('legro');
  const X3_SCRAM = ['x3_scram_salt', 'x3_scram_iterations', 'x3_scram_stored_key', 'x3_scram_server_key'];
  let t: string;
  beforeAll(async () => {
    await createRealm(realm, {passwordPolicy: 'scramSha256'});
    runRealmSetup(realm, ['--service-client', 'ircd']);
    t = await ircdToken(realm);
  });
  afterAll(async () => { await deleteRealm(realm); ldapDeleteUser('rouser'); });

  it('a login stores the verifier, keeps the matching family and removes the other', async () => {
    ldapAddUser('rouser', 'Ro-Pass-1');
    const provider = await addLdapProvider(realm, 'WRITABLE');
    const id = await userIdOf(realm, 'rouser');
    const matching = legacyScramAttributes('Ro-Pass-1');
    const other = legacyScramAttributes('Some-Other-Pass', 'x3_scram_');
    expect(await putUser(realm, id, {attributes: {...(await getUser(realm, id)).attributes, ...matching, ...other}})).toBe(204);
    await setLdapEditMode(realm, provider, 'READ_ONLY');

    expect((await passwordGrant(realm, 'rouser', 'Ro-Pass-1')).status).toBe(200);
    expect(verifierMatches((await ircCredentials(realm, 'rouser', t)).body.scram, 'Ro-Pass-1')).toBe(true);
    const attrs = (await getUser(realm, id)).attributes;
    expect(attrs).toMatchObject(matching);
    for (const k of X3_SCRAM) expect(attrs[k]).toBeUndefined();
  });
});
