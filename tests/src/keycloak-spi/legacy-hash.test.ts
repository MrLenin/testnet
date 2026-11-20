import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { createRealm, deleteRealm, createUser, putUser, getUser, getCredentials, passwordGrant, uniqueRealm } from '../helpers/kc-spi-it';

// A pre-hashed credential, as Keycloak's admin API takes it: the SPI's stored form.
const cred = (algorithm: string, value: string, salt: string) => ({
  type: 'password',
  secretData: JSON.stringify({ value, salt }),
  credentialData: JSON.stringify({ hashIterations: 1, algorithm }),
});
const md5 = (v: string) => cred('x3-md5', v, '');

describe('legacy password hashes (x3-md5, ldap-ssha)', () => {
  const realm = uniqueRealm('legacy');
  beforeAll(async () => { await createRealm(realm); });
  afterAll(async () => { await deleteRealm(realm); });

  it('an x3-md5 hash loaded onto an existing user logs in, keeps the id, and is re-hashed', async () => {
    const id = await createUser(realm, 'legacy');
    expect(await putUser(realm, id, { credentials: [md5('Xr4ilOzQ4PCOq3aQ0qbuaQ==')] })).toBe(204);
    expect((await passwordGrant(realm, 'legacy', 'wrong')).status).toBe(401);
    expect((await passwordGrant(realm, 'legacy', 'secret')).status).toBe(200);
    expect((await getUser(realm, id)).id).toBe(id);
    const algo = JSON.parse((await getCredentials(realm, id))[0].credentialData).algorithm;
    expect(algo).not.toBe('x3-md5');          // Keycloak re-hashed to the realm policy
    expect((await passwordGrant(realm, 'legacy', 'secret')).status).toBe(200);
  });

  it('an ldap-ssha hash logs in', async () => {
    const id = await createUser(realm, 'ssha');
    expect(await putUser(realm, id, { credentials: [cred('ldap-ssha', 'uJDd0BIdJ9Z7yDCZNWdgYeb33+c=', 'AQIDBA==')] })).toBe(204);
    expect((await passwordGrant(realm, 'ssha', 'wrong')).status).toBe(401);
    expect((await passwordGrant(realm, 'ssha', 'secret')).status).toBe(200);
  });

  it('a Latin-1 legacy password logs in', async () => {
    const id = await createUser(realm, 'latin1');
    expect(await putUser(realm, id, { credentials: [md5('ASbPH24NuiQK9MVTfKUdDg==')] })).toBe(204);
    expect((await passwordGrant(realm, 'latin1', 'pässword')).status).toBe(200);
  });
});
