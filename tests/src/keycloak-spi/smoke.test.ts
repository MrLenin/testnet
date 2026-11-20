import { describe, it, expect } from 'vitest';
import { URL, auth, adminToken, createRealm, deleteRealm, createUser, setPassword, passwordGrant, uniqueRealm } from '../helpers/kc-spi-it';

describe('keycloak-spi harness', () => {
  it('throwaway Keycloak has the SPI jar loaded', async () => {
    const info = await (await fetch(`${URL}/admin/serverinfo`, auth(await adminToken()))).json();
    expect(Object.keys(info.providers['password-policy'].providers)).toContain('scramSha256');
    expect(Object.keys(info.providers['eventsListener'].providers)).toContain('webhook-events');
  });
  it('a fresh realm and user can use the password grant', async () => {
    const realm = uniqueRealm('smoke'); await createRealm(realm);
    const id = await createUser(realm, 'alice'); await setPassword(realm, id, 'Smoke-Pass-1');
    expect((await passwordGrant(realm, 'alice', 'Smoke-Pass-1')).status).toBe(200);
    await deleteRealm(realm);
  });
});
