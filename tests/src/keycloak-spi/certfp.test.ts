import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { createHash, randomBytes } from 'node:crypto';
import {
  URL, adminToken, auth, createRealm, deleteRealm, createUser, setPassword, getUser, putUser, getCredentials,
  passwordGrant, runRealmSetup, uniqueRealm, ircdToken, ircCredentials, serviceToken, grantRealmRole, adminSearch,
  certfpAdd, certfpDelete, certfpList, browserAction, ldapAddUser, ldapDeleteUser, addLdapProvider,
} from '../helpers/kc-spi-it';

const ATTR = 'x509_fingerprints';
const LISTENER = 'irc-certfp-mirror';

/** A certificate's two names: the SHA-256 and SHA-512 of its DER (here random bytes), uppercase hex. */
function cert(): { sha256: string; sha512: string } {
  const der = randomBytes(400);
  return {
    sha256: createHash('sha256').update(der).digest('hex').toUpperCase(),
    sha512: createHash('sha512').update(der).digest('hex').toUpperCase(),
  };
}

async function admin(method: string, path: string, body?: unknown): Promise<Response> {
  return fetch(`${URL}/admin/realms/${path}`, {
    method,
    headers: { Authorization: `Bearer ${await adminToken()}`, 'Content-Type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
}

async function adminJson(method: string, path: string, body?: unknown): Promise<any> {
  const r = await admin(method, path, body);
  if (!r.ok) throw new Error(`${method} ${path}: ${r.status} ${await r.text()}`);
  const text = await r.text();
  return text ? JSON.parse(text) : null;
}

/** A user's bearer token for the account REST API. */
async function accountToken(realm: string, username: string, password: string): Promise<string> {
  const g = await passwordGrant(realm, username, password);
  expect(g.status).toBe(200);
  return g.body.access_token;
}

function accountHeaders(token: string): Record<string, string> {
  return { ...(auth(token).headers as Record<string, string>), Accept: 'application/json' };
}

async function accountCredentials(realm: string, token: string): Promise<any[]> {
  const r = await fetch(`${URL}/realms/${realm}/account/credentials`, { headers: accountHeaders(token) });
  expect(r.status).toBe(200);
  return r.json();
}

/** The user's `x509_fingerprints` as the admin API shows it, sorted (the stored values have no order); undefined when absent. */
async function mirror(realm: string, userId: string): Promise<string[] | undefined> {
  const values: string[] | undefined = (await getUser(realm, userId)).attributes?.[ATTR];
  return values === undefined ? undefined : [...values].sort();
}

/** Expected attribute values, in the order `mirror` returns them. */
const sorted = (...values: string[]): string[] => [...values].sort();

/** The usernames the ircd's login lookup finds for a SHA-256. */
async function lookup(realm: string, sha256: string): Promise<string[]> {
  return (await adminSearch(realm, `${ATTR}:${sha256}`)).map((u: any) => u.username);
}

/** `certFingerprints` of the read endpoint: the authority, computed from the credentials. */
async function certFingerprints(realm: string, username: string): Promise<string[]> {
  const r = await ircCredentials(realm, username, await ircdToken(realm));
  expect(r.status).toBe(200);
  return r.body.certFingerprints;
}

/** The id of the user's irc-certfp credential for this certificate. */
async function credentialIdOf(realm: string, userId: string, c: { sha512: string }): Promise<string> {
  const found = (await getCredentials(realm, userId))
    .filter((x: any) => x.type === 'irc-certfp' && JSON.parse(x.credentialData).sha512 === c.sha512);
  expect(found).toHaveLength(1);
  return found[0].id;
}

/** After a removal: the removed certificate is gone from the attribute, the lookup and the endpoint; `kept` is still there. */
async function expectRemoved(realm: string, username: string, userId: string,
  removed: { sha256: string }, kept: { sha256: string }): Promise<void> {
  expect(await mirror(realm, userId)).toEqual([kept.sha256]);
  expect(await lookup(realm, removed.sha256)).toEqual([]);
  expect(await lookup(realm, kept.sha256)).toEqual([username]);
  expect(await certFingerprints(realm, username)).toEqual([kept.sha256]);
}

/** Runs the set-up tool again and checks it sent no write (the admin events record every admin write). */
async function expectNoWritesOnRerun(realm: string, args: string[]): Promise<void> {
  await adminJson('PUT', realm, { adminEventsEnabled: true });
  const count = async () => (await adminJson('GET', `${realm}/admin-events?max=1000`)).length;
  const before = await count();
  runRealmSetup(realm, args);
  expect(await count()).toBe(before);
}

describe('certificate credential (irc-certfp)', () => {
  const realm = uniqueRealm('certfp');
  const C1 = cert(), C2 = cert(), C3 = cert(), C4 = cert(), C5 = cert(), C6 = cert(), C7 = cert(), C8 = cert(), CX = cert();
  let m: string;
  let readOnlyToken: string;
  let ownerId: string;
  let otherId: string;
  beforeAll(async () => {
    await createRealm(realm, { passwordPolicy: 'scramSha256' });
    runRealmSetup(realm, ['--service-client', 'ircd']);
    m = await ircdToken(realm);
    await grantRealmRole(realm, 'reader', 'irc-read-credentials');
    readOnlyToken = await serviceToken(realm, 'reader');
    ownerId = await createUser(realm, 'owner');
    expect(await setPassword(realm, ownerId, 'Pw-owner-1')).toBe(204);
    otherId = await createUser(realm, 'other');
    expect(await setPassword(realm, otherId, 'Pw-other-1')).toBe(204);
  });
  afterAll(async () => { await deleteRealm(realm); });

  it('the read endpoint lists no certificate for a user without one', async () => {
    expect(await certFingerprints(realm, 'owner')).toEqual([]);
    expect((await certfpList(realm, 'owner', m))).toEqual({ status: 200, body: { certificates: [] } });
  });

  it('adds a certificate, mirrors its SHA-256 into the attribute, and lists it by SHA-512', async () => {
    const added = await certfpAdd(realm, 'owner', { ...C1, name: 'laptop' }, m);
    expect(added.status).toBe(201);
    expect(added.body).toMatchObject({ sha512: C1.sha512, sha256: C1.sha256, name: 'laptop' });
    expect(typeof added.body.createdDate).toBe('number');
    expect((await getUser(realm, ownerId)).attributes.x509_fingerprints).toEqual([C1.sha256]);
    expect((await adminSearch(realm, `x509_fingerprints:${C1.sha256}`)).map((u: any) => u.username)).toEqual(['owner']);   // the ircd's login lookup
    expect((await certfpList(realm, 'owner', m)).body.certificates[0]).toMatchObject({ sha512: C1.sha512, sha256: C1.sha256, name: 'laptop' });
    expect(await certFingerprints(realm, 'owner')).toEqual([C1.sha256]);
    // The stored credential: one per certificate, labelled with its name, both digests in credentialData.
    const stored = (await getCredentials(realm, ownerId)).filter((c: any) => c.type === 'irc-certfp');
    expect(stored).toHaveLength(1);
    expect(stored[0].userLabel).toBe('laptop');
    expect(JSON.parse(stored[0].credentialData)).toEqual({ sha256: C1.sha256, sha512: C1.sha512 });
  });

  it('adding the same certificate again keeps one entry and its first name', async () => {
    expect((await certfpAdd(realm, 'owner', { ...C1, name: 'other name' }, m)).status).toBe(200);
    const list = (await certfpList(realm, 'owner', m)).body.certificates;
    expect(list).toHaveLength(1); expect(list[0].name).toBe('laptop');
    expect(await mirror(realm, ownerId)).toEqual([C1.sha256]);
  });

  it('another user cannot take a held certificate', async () => {
    const r = await certfpAdd(realm, 'other', { ...C1, name: 'x' }, m);
    expect(r.status).toBe(409); expect(r.body).toEqual({ error: 'taken' });
    expect((await getUser(realm, otherId)).attributes?.x509_fingerprints).toBeUndefined();
    expect((await certfpList(realm, 'other', m)).body.certificates).toEqual([]);
  });

  it('a pair with only one digest of a held certificate is a bad fingerprint, never a second credential', async () => {
    for (const body of [{ sha256: C1.sha256, sha512: CX.sha512 }, { sha256: CX.sha256, sha512: C1.sha512 }]) {
      const r = await certfpAdd(realm, 'owner', { ...body, name: 'mixed' }, m);
      expect(r.status).toBe(400); expect(r.body).toEqual({ error: 'bad_fingerprint' });
    }
    const list = (await certfpList(realm, 'owner', m)).body.certificates;
    expect(list).toHaveLength(1); expect(list[0]).toMatchObject({ sha512: C1.sha512, sha256: C1.sha256, name: 'laptop' });
    expect(await mirror(realm, ownerId)).toEqual([C1.sha256]);
  });

  it('refuses malformed fingerprints, bad names and callers without the role', async () => {
    expect((await certfpAdd(realm, 'owner', { sha256: C2.sha256.toLowerCase(), sha512: C2.sha512, name: 'x' }, m)).body).toEqual({ error: 'bad_fingerprint' });
    expect((await certfpAdd(realm, 'owner', { sha256: C2.sha256, sha512: C2.sha512.slice(1), name: 'x' }, m)).body).toEqual({ error: 'bad_fingerprint' });
    expect((await certfpAdd(realm, 'owner', { ...C2, name: '' }, m)).body).toEqual({ error: 'bad_name' });
    expect((await certfpAdd(realm, 'owner', { ...C2, name: 'x' }, undefined)).status).toBe(401);
    expect((await certfpAdd(realm, 'owner', { ...C2, name: 'x' }, readOnlyToken)).status).toBe(403);
  });

  it('every refusal has its status, and nothing was stored', async () => {
    const bad = await certfpAdd(realm, 'owner', { sha256: C2.sha256, sha512: C2.sha512 }, m);   // no name
    expect(bad).toEqual({ status: 400, body: { error: 'bad_name' } });
    expect(await certfpAdd(realm, 'owner', { ...C2, name: 'line\nbreak' }, m)).toEqual({ status: 400, body: { error: 'bad_name' } });
    expect(await certfpAdd(realm, 'owner', { ...C2, name: 'x'.repeat(65) }, m)).toEqual({ status: 400, body: { error: 'bad_name' } });
    expect(await certfpAdd(realm, 'owner', { sha256: 'AA:BB', sha512: C2.sha512, name: 'x' }, m)).toEqual({ status: 400, body: { error: 'bad_fingerprint' } });
    expect(await certfpAdd(realm, 'nobody', { ...C2, name: 'x' }, m)).toEqual({ status: 404, body: { error: 'user_not_found' } });
    // An unauthorised caller learns nothing about whether the user exists.
    for (const user of ['owner', 'nobody']) {
      expect((await certfpAdd(realm, user, { ...C2, name: 'x' }, readOnlyToken)).status).toBe(403);
      expect((await certfpList(realm, user, readOnlyToken)).status).toBe(403);
      expect((await certfpDelete(realm, user, C1.sha512, readOnlyToken)).status).toBe(403);
      expect((await certfpList(realm, user, undefined)).status).toBe(401);
      expect((await certfpDelete(realm, user, C1.sha512, undefined)).status).toBe(401);
    }
    expect((await certfpList(realm, 'nobody', m))).toEqual({ status: 404, body: { error: 'user_not_found' } });
    expect((await certfpList(realm, 'owner', m)).body.certificates).toHaveLength(1);
    expect(await mirror(realm, ownerId)).toEqual([C1.sha256]);
  });

  it('answers with Cache-Control: no-store', async () => {
    const r = await fetch(`${URL}/realms/${realm}/irc/certfp/owner`, { headers: { Authorization: `Bearer ${m}` } });
    expect(r.status).toBe(200);
    expect(r.headers.get('cache-control')).toBe('no-store');
  });

  it('a user cannot write the attribute themselves', async () => {
    const token = await accountToken(realm, 'owner', 'Pw-owner-1');
    const g = await fetch(`${URL}/realms/${realm}/account`, { headers: accountHeaders(token) });
    expect(g.status).toBe(200);
    const me = await g.json();
    expect(me.attributes?.[ATTR]).toEqual([C1.sha256]);   // visible to the user
    const p = await fetch(`${URL}/realms/${realm}/account`, {
      method: 'POST', headers: { ...accountHeaders(token), 'Content-Type': 'application/json' },
      body: JSON.stringify({ ...me, attributes: { ...me.attributes, [ATTR]: [C2.sha256] } }),
    });
    expect(p.status).toBe(400);
    expect((await p.json()).errorMessage).toBe('error-user-attribute-read-only');
    expect((await getUser(realm, ownerId)).attributes.x509_fingerprints).toEqual([C1.sha256]);
    expect(await lookup(realm, C2.sha256)).toEqual([]);
  });

  it('the account page lists the certificate as removable with no set-up action, and removing it there clears the attribute', async () => {
    // A user with no certificate is not offered the type: it has no set-up action.
    const none = await accountCredentials(realm, await accountToken(realm, 'other', 'Pw-other-1'));
    expect(none.find((c: any) => c.type === 'irc-certfp')).toBeUndefined();

    const token = await accountToken(realm, 'owner', 'Pw-owner-1');
    const entry = (await accountCredentials(realm, token)).find((c: any) => c.type === 'irc-certfp');
    expect(entry).toMatchObject({ type: 'irc-certfp', category: 'basic-authentication',
      displayName: 'irc-certfp-display-name', helptext: 'irc-certfp-help-text', removeable: true });
    expect(entry.createAction).toBeUndefined();
    expect(entry.updateAction).toBeUndefined();
    expect(entry.userCredentialMetadatas).toHaveLength(1);
    expect(entry.userCredentialMetadatas[0].credential.userLabel).toBe('laptop');

    // Route (a): the account REST API.  A second certificate shows the removal touches only its own value.
    expect((await certfpAdd(realm, 'owner', { ...C2, name: 'desktop' }, m)).status).toBe(201);
    expect(await mirror(realm, ownerId)).toEqual(sorted(C1.sha256, C2.sha256));
    const del = await fetch(`${URL}/realms/${realm}/account/credentials/${entry.userCredentialMetadatas[0].credential.id}`,
      { method: 'DELETE', headers: accountHeaders(token) });
    expect(del.status).toBe(204);
    await expectRemoved(realm, 'owner', ownerId, C1, C2);
  });

  it('removes through the endpoint by SHA-512', async () => {
    // Route (d).
    expect((await certfpAdd(realm, 'owner', { ...C3, name: 'tablet' }, m)).status).toBe(201);
    expect(await certfpDelete(realm, 'owner', C2.sha512, m)).toEqual({ status: 204, body: null });
    expect(await certfpDelete(realm, 'owner', C2.sha512, m)).toEqual({ status: 404, body: { error: 'not_found' } });
    await expectRemoved(realm, 'owner', ownerId, C2, C3);
  });

  it('a malformed or unknown SHA-512 on removal is not found, and an unknown user is user_not_found', async () => {
    for (const v of ['zz', C3.sha512.toLowerCase(), C3.sha256, CX.sha512]) {
      expect(await certfpDelete(realm, 'owner', v, m)).toEqual({ status: 404, body: { error: 'not_found' } });
    }
    expect(await certfpDelete(realm, 'nobody', C3.sha512, m)).toEqual({ status: 404, body: { error: 'user_not_found' } });
    expect(await mirror(realm, ownerId)).toEqual([C3.sha256]);
  });

  it('removal through the account console (delete_credential action) is mirrored', async () => {
    // Route (b): the application-initiated action the account console starts, confirmed on its form.
    const id = await createUser(realm, 'aia');
    expect(await setPassword(realm, id, 'Pw-aia-1')).toBe(204);
    expect((await certfpAdd(realm, 'aia', { ...C4, name: 'one' }, m)).status).toBe(201);
    expect((await certfpAdd(realm, 'aia', { ...C5, name: 'two' }, m)).status).toBe(201);
    const credId = await credentialIdOf(realm, id, C4);
    expect((await browserAction(realm, 'aia', 'Pw-aia-1', `delete_credential:${credId}`, { accept: '' })).status).toBe('success');
    await expectRemoved(realm, 'aia', id, C4, C5);
  });

  it('removal through the admin API is mirrored', async () => {
    // Route (c).
    const id = await createUser(realm, 'adm');
    expect((await certfpAdd(realm, 'adm', { ...C6, name: 'one' }, m)).status).toBe(201);
    expect((await certfpAdd(realm, 'adm', { ...C7, name: 'two' }, m)).status).toBe(201);
    const del = await admin('DELETE', `${realm}/users/${id}/credentials/${await credentialIdOf(realm, id, C6)}`);
    expect(del.status).toBe(204);
    await expectRemoved(realm, 'adm', id, C6, C7);
  });

  it('a certificate loaded through the admin API goes through the same checks', async () => {
    const id = await createUser(realm, 'loaded');
    const load = (c: object, userLabel?: string) => putUser(realm, id,
      { credentials: [{ type: 'irc-certfp', userLabel, credentialData: JSON.stringify(c) }] });
    expect(await load(C8, 'from admin')).toBe(204);
    expect(await mirror(realm, id)).toEqual([C8.sha256]);
    expect(await lookup(realm, C8.sha256)).toEqual(['loaded']);
    expect(await load(C8, 'renamed')).toBe(204);                               // already present: kept, not renamed
    expect(await load(C7, 'theirs')).toBe(409);                                // held by adm
    expect(await load({ sha256: C2.sha256.toLowerCase(), sha512: C2.sha512 }, 'x')).toBe(400);
    expect(await load(C2)).toBe(400);                                          // no name
    const list = (await certfpList(realm, 'loaded', m)).body.certificates;
    expect(list).toHaveLength(1); expect(list[0]).toMatchObject({ sha512: C8.sha512, name: 'from admin' });
    expect(await mirror(realm, id)).toEqual([C8.sha256]);
    expect(await lookup(realm, C7.sha256)).toEqual(['adm']);
  });

  it('the set-up tool declares the attribute: multivalued, seen by user and admin, edited by nobody', async () => {
    const profile = await adminJson('GET', `${realm}/users/profile`);
    const decl = profile.attributes.find((a: any) => a.name === ATTR);
    expect(decl.multivalued).toBe(true);
    expect([...decl.permissions.view].sort()).toEqual(['admin', 'user']);
    expect(decl.permissions.edit).toEqual([]);
  });

  it('an admin-API user update leaves the attribute alone, and an admin cannot type a value', async () => {
    const id = await createUser(realm, 'update');
    const C = cert();
    expect((await certfpAdd(realm, 'update', { ...C, name: 'laptop' }, m)).status).toBe(201);
    // A partial update with an empty attribute map, as admin-API clients send when they change another field.
    const partial = await admin('PUT', `${realm}/users/${id}`, { firstName: 'Changed', attributes: {} });
    expect(partial.status).toBe(204);
    expect((await getUser(realm, id)).firstName).toBe('Changed');
    expect(await mirror(realm, id)).toEqual([C.sha256]);
    expect(await lookup(realm, C.sha256)).toEqual(['update']);
    // The full representation sent back with another field changed (what the admin console's save does).
    expect(await putUser(realm, id, { lastName: 'Saved' })).toBe(204);
    expect(await mirror(realm, id)).toEqual([C.sha256]);
    // An attempt to type a value.
    const rep = await getUser(realm, id);
    const typed = await admin('PUT', `${realm}/users/${id}`,
      { ...rep, attributes: { ...rep.attributes, [ATTR]: [CX.sha256] } });
    expect(typed.status).toBe(400);
    expect((await typed.json()).errorMessage).toBe('error-user-attribute-read-only');
    expect(await mirror(realm, id)).toEqual([C.sha256]);
    expect(await lookup(realm, CX.sha256)).toEqual([]);
    expect(await lookup(realm, C.sha256)).toEqual(['update']);
  });

  it('the set-up tool restores the declaration and the listener, keeping the others, and a further run writes nothing', async () => {
    const profile = await adminJson('GET', `${realm}/users/profile`);
    profile.attributes.find((a: any) => a.name === ATTR).permissions = { view: ['admin'], edit: ['admin', 'user'] };
    await adminJson('PUT', `${realm}/users/profile`, profile);
    await adminJson('PUT', realm, { eventsListeners: ['jboss-logging'] });
    runRealmSetup(realm, ['--service-client', 'ircd']);
    const decl = (await adminJson('GET', `${realm}/users/profile`)).attributes.find((a: any) => a.name === ATTR);
    expect([...decl.permissions.view].sort()).toEqual(['admin', 'user']);
    expect(decl.permissions.edit).toEqual([]);
    expect([...(await adminJson('GET', realm)).eventsListeners].sort()).toEqual(['irc-certfp-mirror', 'jboss-logging']);
    await expectNoWritesOnRerun(realm, ['--service-client', 'ircd']);
  });

  it('the set-up tool corrects a declaration an earlier version made (edit for admin), then writes nothing', async () => {
    const profile = await adminJson('GET', `${realm}/users/profile`);
    profile.attributes.find((a: any) => a.name === ATTR).permissions = { view: ['admin', 'user'], edit: ['admin'] };
    await adminJson('PUT', `${realm}/users/profile`, profile);
    runRealmSetup(realm, ['--service-client', 'ircd']);
    const decl = (await adminJson('GET', `${realm}/users/profile`)).attributes.find((a: any) => a.name === ATTR);
    expect([...decl.permissions.view].sort()).toEqual(['admin', 'user']);
    expect(decl.permissions.edit).toEqual([]);
    await expectNoWritesOnRerun(realm, ['--service-client', 'ircd']);
  });

  it('the set-up tool creates irc-manage-certfp and grants both roles to the service client', async () => {
    expect((await admin('GET', `${realm}/roles/irc-manage-certfp`)).status).toBe(200);
    const client = (await adminJson('GET', `${realm}/clients?clientId=ircd&search=false`))[0];
    const account = await adminJson('GET', `${realm}/clients/${client.id}/service-account-user`);
    const roles = (await adminJson('GET', `${realm}/users/${account.id}/role-mappings/realm`)).map((r: any) => r.name);
    expect(roles).toEqual(expect.arrayContaining(['irc-read-credentials', 'irc-manage-certfp']));
  });
});

describe('certificate credential: a realm without the irc-certfp-mirror listener', () => {
  const realm = uniqueRealm('certfp-nolistener');
  const C1 = cert(), C2 = cert(), C3 = cert();
  let m: string;
  let id: string;
  beforeAll(async () => {
    await createRealm(realm, { passwordPolicy: 'scramSha256' });
    runRealmSetup(realm, ['--service-client', 'ircd']);
    await adminJson('PUT', realm, { eventsListeners: ['jboss-logging'] });
    m = await ircdToken(realm);
    id = await createUser(realm, 'stale');
    expect(await setPassword(realm, id, 'Pw-stale-1')).toBe(204);
    expect((await certfpAdd(realm, 'stale', { ...C1, name: 'one' }, m)).status).toBe(201);
    expect((await certfpAdd(realm, 'stale', { ...C2, name: 'two' }, m)).status).toBe(201);
  });
  afterAll(async () => { await deleteRealm(realm); });

  it('removals on the account page and in the admin API leave the attribute stale; certFingerprints stays right', async () => {
    expect((await adminJson('GET', realm)).eventsListeners).not.toContain(LISTENER);
    const token = await accountToken(realm, 'stale', 'Pw-stale-1');
    const del = await fetch(`${URL}/realms/${realm}/account/credentials/${await credentialIdOf(realm, id, C1)}`,
      { method: 'DELETE', headers: accountHeaders(token) });
    expect(del.status).toBe(204);
    expect(await mirror(realm, id)).toEqual(sorted(C1.sha256, C2.sha256));   // stale
    expect(await lookup(realm, C1.sha256)).toEqual(['stale']);          // the index still finds the removed certificate
    expect(await certFingerprints(realm, 'stale')).toEqual([C2.sha256]); // the authority does not list it

    expect((await admin('DELETE', `${realm}/users/${id}/credentials/${await credentialIdOf(realm, id, C2)}`)).status).toBe(204);
    expect(await mirror(realm, id)).toEqual(sorted(C1.sha256, C2.sha256));
    expect(await certFingerprints(realm, 'stale')).toEqual([]);
  });

  it('the next add through the endpoint rewrites the attribute from the credentials', async () => {
    expect((await certfpAdd(realm, 'stale', { ...C3, name: 'three' }, m)).status).toBe(201);
    expect(await mirror(realm, id)).toEqual([C3.sha256]);
    expect(await lookup(realm, C1.sha256)).toEqual([]);
  });
});

describe('certificate credential: a realm without the unmanaged-attribute policy', () => {
  const realm = uniqueRealm('certfp-nopolicy');
  const C1 = cert();
  let before: any;
  beforeAll(async () => {
    await createRealm(realm);
    const profile = await adminJson('GET', `${realm}/users/profile`);
    delete profile.unmanagedAttributePolicy;
    await adminJson('PUT', `${realm}/users/profile`, profile);
    before = await adminJson('GET', `${realm}/users/profile`);
    expect(before.unmanagedAttributePolicy).toBeUndefined();
    runRealmSetup(realm, ['--service-client', 'ircd']);
  });
  afterAll(async () => { await deleteRealm(realm); });

  it('the declaration is added without changing the rest of the profile', async () => {
    const after = await adminJson('GET', `${realm}/users/profile`);
    expect(after.attributes.filter((a: any) => a.name !== ATTR)).toEqual(before.attributes);
    expect({ ...after, attributes: undefined }).toEqual({ ...before, attributes: undefined });
    expect(after.attributes.filter((a: any) => a.name === ATTR)).toHaveLength(1);
  });

  it('the admin representation and the admin search show the attribute', async () => {
    const id = await createUser(realm, 'nopolicy');
    expect((await certfpAdd(realm, 'nopolicy', { ...C1, name: 'laptop' }, await ircdToken(realm))).status).toBe(201);
    expect(await mirror(realm, id)).toEqual([C1.sha256]);
    expect(await lookup(realm, C1.sha256)).toEqual(['nopolicy']);
  });
});

describe('certificate credential: a user linked to a READ_ONLY LDAP provider', () => {
  const realm = uniqueRealm('certfp-ldap');
  const uid = `certfp${randomBytes(4).toString('hex')}`;
  const C1 = cert(), C2 = cert();
  let m: string;
  let id: string;
  beforeAll(async () => {
    await createRealm(realm, { passwordPolicy: 'scramSha256' });
    runRealmSetup(realm, ['--service-client', 'ircd']);
    ldapAddUser(uid, 'Pw-ldap-1');
    await addLdapProvider(realm, 'READ_ONLY');
    m = await ircdToken(realm);
    const found = await adminJson('GET', `${realm}/users?username=${uid}&exact=true`);
    expect(found).toHaveLength(1);
    expect(found[0].federationLink).toBeTruthy();
    id = found[0].id;
  });
  afterAll(async () => { await deleteRealm(realm); ldapDeleteUser(uid); });

  it('gets a certificate added and mirrored, found by the lookup, and cleared on removal', async () => {
    expect((await certfpAdd(realm, uid, { ...C1, name: 'ldap laptop' }, m)).status).toBe(201);
    expect((await certfpAdd(realm, uid, { ...C2, name: 'ldap desktop' }, m)).status).toBe(201);
    expect(await mirror(realm, id)).toEqual(sorted(C1.sha256, C2.sha256));
    expect(await lookup(realm, C1.sha256)).toEqual([uid]);
    expect(await certFingerprints(realm, uid)).toEqual([C1.sha256, C2.sha256]);

    expect((await certfpDelete(realm, uid, C1.sha512, m)).status).toBe(204);
    await expectRemoved(realm, uid, id, C1, C2);

    // The account page's removal (through the listener) works for this user too.
    const token = await accountToken(realm, uid, 'Pw-ldap-1');
    const del = await fetch(`${URL}/realms/${realm}/account/credentials/${await credentialIdOf(realm, id, C2)}`,
      { method: 'DELETE', headers: accountHeaders(token) });
    expect(del.status).toBe(204);
    expect(await mirror(realm, id)).toBeUndefined();
    expect(await lookup(realm, C2.sha256)).toEqual([]);
    expect(await certFingerprints(realm, uid)).toEqual([]);
  });
});
