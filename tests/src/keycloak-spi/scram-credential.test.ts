import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { URL, auth, createRealm, deleteRealm, createUser, setPassword, putUser, getUser, getCredentials, passwordGrant, uniqueRealm } from '../helpers/kc-spi-it';

describe('SCRAM verifier as a credential (irc-scram-sha256)', () => {
  const realm = uniqueRealm('scram');
  beforeAll(async () => { await createRealm(realm); });
  afterAll(async () => { await deleteRealm(realm); });

  it('a verifier loaded through the admin API is a credential whose secret is never returned', async () => {
    const id = await createUser(realm, 'scram'); await setPassword(realm, id, 'Pw-scram-1');
    const cred = {type: 'irc-scram-sha256',
      secretData: JSON.stringify({storedKey: 'WG5d8oPm3OtcPnkdi4Uo7BkeZkBFzpcXkuLmtbsT4qY=', serverKey: 'wfPLwcE6nTWhTAmQ7tl2KeoiWGPlZqQxSrmfPwDl2dU='}),
      credentialData: JSON.stringify({salt: 'W22ZaJ0SNY7soEsUEjb6gQ==', iterations: 4096})};
    expect(await putUser(realm, id, {credentials: [cred]})).toBe(204);
    const listed = (await getCredentials(realm, id)).filter(c => c.type === 'irc-scram-sha256');
    expect(listed).toHaveLength(1);
    expect(JSON.stringify(listed)).not.toContain('WG5d8oPm3OtcPnkdi4Uo7BkeZkBFzpcXkuLmtbsT4qY=');
    expect(JSON.parse(listed[0].credentialData).passwordFingerprint).toMatch(/^[0-9a-f]{64}$/);
    expect(JSON.stringify((await getUser(realm, id)).attributes ?? {})).not.toContain('scram');
  });

  it('the account page credential list still loads for a user holding the credential, and never shows its secret', async () => {
    const token = (await passwordGrant(realm, 'scram', 'Pw-scram-1')).body.access_token;
    const r = await fetch(`${URL}/realms/${realm}/account/credentials`, {headers: {...(auth(token).headers as object), Accept: 'application/json'}});
    expect(r.status).toBe(200);
    const body = await r.json();
    expect(JSON.stringify(body)).not.toContain('WG5d8oPm3OtcPnkdi4Uo7BkeZkBFzpcXkuLmtbsT4qY=');
    // Keycloak lists only credential types that an authenticator in an enabled flow uses, so a type with
    // no authenticator is not listed at all; if a Keycloak version does list it, it must be read-only.
    const entry = body.find((c: any) => c.type === 'irc-scram-sha256');
    if (entry) { expect(entry.createAction).toBeUndefined(); expect(entry.removeable).toBe(false); }
    expect(body.find((c: any) => c.type === 'password')).toBeDefined();
  });
});
