import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { generateKeyPairSync } from 'node:crypto';
import {
  createRealm, deleteRealm, createUser, setPassword, putUser, getCredentials, passwordGrant, runRealmSetup,
  ircCredentials, ircdToken, adminToken, auth, browserAction, uniqueRealm, URL,
} from '../helpers/kc-spi-it';

// One P-256 key in the three accepted forms, and its canonical PEM.
const DER_B64 = 'MFkwEwYHKoZIzj0CAQYIKoZIzj0DAQcDQgAEKLJJ+AMaKqWkklSdBPtg5g1EYjOD/2p3sm6m0kt/Ee1JscEYSXbnvNeAup3/FHS4Sdndi9gGVr/TmpAXadV43Q==';
const POINT_B64 = 'AyiySfgDGiqlpJJUnQT7YOYNRGIzg/9qd7JuptJLfxHt';
const PEM = '-----BEGIN PUBLIC KEY-----\nMFkwEwYHKoZIzj0CAQYIKoZIzj0DAQcDQgAEKLJJ+AMaKqWkklSdBPtg5g1EYjOD\n/2p3sm6m0kt/Ee1JscEYSXbnvNeAup3/FHS4Sdndi9gGVr/TmpAXadV43Q==\n-----END PUBLIC KEY-----\n';

const other = generateKeyPairSync('ec', { namedCurve: 'prime256v1' }).publicKey;
const OTHER_KEY = other.export({ type: 'spki', format: 'der' }).toString('base64');
const OTHER_PEM = other.export({ type: 'spki', format: 'pem' }) as string;
const P384_KEY = generateKeyPairSync('ec', { namedCurve: 'secp384r1' }).publicKey
  .export({ type: 'spki', format: 'der' }).toString('base64');

const ecdsaCred = (publicKey: string) => ({ type: 'irc-ecdsa-pubkey', credentialData: JSON.stringify({ publicKey }) });

async function accountCredentials(realm: string, username: string, password: string): Promise<{ token: string; list: any[] }> {
  const token = (await passwordGrant(realm, username, password)).body.access_token;
  const r = await fetch(`${URL}/realms/${realm}/account/credentials`,
    { headers: { ...(auth(token).headers as object), Accept: 'application/json' } });
  expect(r.status).toBe(200);
  return { token, list: await r.json() };
}

describe('ECDSA key credential', () => {
  const realm = uniqueRealm('ecdsa');
  let id: string;
  let enrolId: string;
  let t: string;
  beforeAll(async () => {
    await createRealm(realm, { passwordPolicy: 'scramSha256' });
    runRealmSetup(realm, ['--service-client', 'ircd']);
    t = await ircdToken(realm);
    id = await createUser(realm, 'ecdsa');
    enrolId = await createUser(realm, 'enrol');
    expect(await setPassword(realm, enrolId, 'Pw-enrol-1')).toBe(204);
  });
  afterAll(async () => { await deleteRealm(realm); });

  it('the set-up tool registers the set-up action enabled and not a default action, and restores that', async () => {
    const path = `${URL}/admin/realms/${realm}/authentication/required-actions/irc-ecdsa-enroll`;
    const get = async () => (await fetch(path, auth(await adminToken()))).json();
    expect(await get()).toMatchObject({ alias: 'irc-ecdsa-enroll', providerId: 'irc-ecdsa-enroll',
      name: 'IRC: add an ECDSA key', enabled: true, defaultAction: false });
    const off = await fetch(path, { method: 'PUT',
      headers: { Authorization: `Bearer ${await adminToken()}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ ...(await get()), enabled: false, defaultAction: true }) });
    expect(off.status).toBe(204);
    runRealmSetup(realm);
    expect(await get()).toMatchObject({ enabled: true, defaultAction: false });
  });

  it('a key loaded through the admin API comes back from the endpoint as canonical PEM', async () => {
    expect(await putUser(realm, id, { credentials: [ecdsaCred(POINT_B64)] })).toBe(204);
    expect((await ircCredentials(realm, 'ecdsa', t)).body.ecdsaPublicKey).toBe(PEM);
    const stored = (await getCredentials(realm, id)).filter(c => c.type === 'irc-ecdsa-pubkey');
    expect(stored).toHaveLength(1);
    expect(JSON.parse(stored[0].credentialData)).toEqual({ publicKey: PEM });
  });

  it('a bad key is refused', async () => {
    for (const bad of ['not a key', P384_KEY, '']) {
      expect(await putUser(realm, id, { credentials: [ecdsaCred(bad)] })).toBe(400);
    }
    expect(await putUser(realm, id, { credentials: [{ type: 'irc-ecdsa-pubkey', credentialData: 'not json' }] })).toBe(400);
    expect((await ircCredentials(realm, 'ecdsa', t)).body.ecdsaPublicKey).toBe(PEM);
    expect((await getCredentials(realm, id)).filter(c => c.type === 'irc-ecdsa-pubkey')).toHaveLength(1);
  });

  it('a second key loaded through the admin API replaces the first', async () => {
    expect(await putUser(realm, id, { credentials: [ecdsaCred(OTHER_KEY)] })).toBe(204);
    expect((await ircCredentials(realm, 'ecdsa', t)).body.ecdsaPublicKey).toBe(OTHER_PEM);
    expect((await getCredentials(realm, id)).filter(c => c.type === 'irc-ecdsa-pubkey')).toHaveLength(1);
  });

  it('the account page lists the type with its set-up action', async () => {
    // A user without a key: listed, with the action that adds one; the SCRAM entry is still there.
    const { list } = await accountCredentials(realm, 'enrol', 'Pw-enrol-1');
    const entry = list.find((c: any) => c.type === 'irc-ecdsa-pubkey');
    expect(entry).toMatchObject({ type: 'irc-ecdsa-pubkey', category: 'basic-authentication',
      displayName: 'irc-ecdsa-display-name', helptext: 'irc-ecdsa-help-text',
      createAction: 'irc-ecdsa-enroll', removeable: true, userCredentialMetadatas: [] });
    expect(entry.updateAction).toBeUndefined();
    const scram = list.find((c: any) => c.type === 'irc-scram-sha256');
    expect(scram).toBeDefined();
    expect(scram.userCredentialMetadatas).toHaveLength(1);
  });

  it('a user enrols a key through the set-up form, and a second enrolment replaces it', async () => {
    expect((await browserAction(realm, 'enrol', 'Pw-enrol-1', 'irc-ecdsa-enroll', { publicKey: 'garbage' })).status).toBe('form');
    expect((await ircCredentials(realm, 'enrol', t)).body.ecdsaPublicKey).toBeUndefined();
    expect((await browserAction(realm, 'enrol', 'Pw-enrol-1', 'irc-ecdsa-enroll', { publicKey: DER_B64 })).status).toBe('success');
    expect((await ircCredentials(realm, 'enrol', t)).body.ecdsaPublicKey).toBe(PEM);
    expect((await browserAction(realm, 'enrol', 'Pw-enrol-1', 'irc-ecdsa-enroll', { publicKey: OTHER_KEY })).status).toBe('success');
    expect((await ircCredentials(realm, 'enrol', t)).body.ecdsaPublicKey).toBe(OTHER_PEM);
    expect((await getCredentials(realm, enrolId)).filter(c => c.type === 'irc-ecdsa-pubkey')).toHaveLength(1);
  });

  it('the form does not show the submitted text back unescaped', async () => {
    const r = await browserAction(realm, 'enrol', 'Pw-enrol-1', 'irc-ecdsa-enroll', { publicKey: '<script>alert(1)</script>' });
    expect(r.status).toBe('form');
    expect(r.html).toContain('That is not an ECDSA P-256 public key.');
    expect(r.html).not.toContain('<script>alert(1)</script>');
    expect((await ircCredentials(realm, 'enrol', t)).body.ecdsaPublicKey).toBe(OTHER_PEM);
  });

  it('a user removes the key from the account page', async () => {
    const { token, list } = await accountCredentials(realm, 'enrol', 'Pw-enrol-1');
    const entry = list.find((c: any) => c.type === 'irc-ecdsa-pubkey');
    expect(entry.userCredentialMetadatas).toHaveLength(1);
    expect(entry.removeable).toBe(true);
    const credId = entry.userCredentialMetadatas[0].credential.id;
    const del = await fetch(`${URL}/realms/${realm}/account/credentials/${credId}`,
      { method: 'DELETE', headers: { ...(auth(token).headers as object), Accept: 'application/json' } });
    expect(del.status).toBe(204);
    expect((await ircCredentials(realm, 'enrol', t)).body.ecdsaPublicKey).toBeUndefined();
    expect((await getCredentials(realm, enrolId)).filter(c => c.type === 'irc-ecdsa-pubkey')).toHaveLength(0);
  });
});
