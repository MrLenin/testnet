import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { createRealm, deleteRealm, createUser, setPassword, putUser, getCredentials, adminToken, URL, ircdToken, ircCredentials, runRealmSetup, pbkdf2Cred, uniqueRealm } from '../helpers/kc-spi-it';

// The tests run in file order: the first expects 403 before the realm set-up tool grants the role.
describe('IRC credentials endpoint', () => {
  const realm = uniqueRealm('endpoint');
  let aliceId: string;
  beforeAll(async () => {
    await createRealm(realm);
    aliceId = await createUser(realm, 'alice');
  });
  afterAll(async () => { await deleteRealm(realm); });

  it('refuses callers without the role', async () => {
    expect((await ircCredentials(realm, 'alice', undefined)).status).toBe(401);
    expect((await ircCredentials(realm, 'alice', await ircdToken(realm))).status).toBe(403);   // before runRealmSetup
  });

  it('answers by username in any letter case, 404 for nobody', async () => {
    runRealmSetup(realm, ['--service-client', 'ircd']);
    const t = await ircdToken(realm);
    const r = await ircCredentials(realm, 'ALICE', t);
    expect(r.status).toBe(200); expect(r.body.username).toBe('alice'); expect(r.body.id).toBe(aliceId);
    expect(r.body.state).toBe('ok'); expect(r.body.reasons).toEqual([]);
    const none = await ircCredentials(realm, 'nobody', t);
    expect(none.status).toBe(404); expect(none.body).toEqual({error: 'user_not_found'});
  });

  it('sends Cache-Control: no-store', async () => {
    const r = await fetch(`${URL}/realms/${realm}/irc/credentials/alice`, {headers: {Authorization: `Bearer ${await ircdToken(realm)}`}});
    expect(r.status).toBe(200);
    expect(r.headers.get('cache-control')).toBe('no-store');
  });

  it('running the set-up tool again changes nothing', async () => {
    runRealmSetup(realm, ['--service-client', 'ircd']);
    expect((await ircCredentials(realm, 'alice', await ircdToken(realm))).status).toBe(200);
  });

  it('finds a username that needs percent-encoding', async () => {
    const t = await ircdToken(realm);
    // Keycloak refuses a backtick in a username (error-username-invalid-character); '@' is accepted and is percent-encoded as %40.
    await createUser(realm, 'a@b', {email: 'at-sign@spi-it.invalid'});
    const r = await ircCredentials(realm, 'a@b', t);
    expect(r.status).toBe(200); expect(r.body.username).toBe('a@b');
  });

  it('reports disabled and incomplete accounts', async () => {
    const t = await ircdToken(realm);
    await createUser(realm, 'dis', {enabled: false});
    const d = await ircCredentials(realm, 'dis', t);
    expect(d.body.state).toBe('disabled'); expect(d.body.reasons).toEqual(['disabled']);
    await createUser(realm, 'inc', {requiredActions: ['VERIFY_EMAIL']});
    const i = await ircCredentials(realm, 'inc', t);
    expect(i.body.state).toBe('incomplete'); expect(i.body.reasons).toEqual(['verify_email']);
  });

  it('returns a verifier bound to the current password and none once the password changes behind it', async () => {
    const t = await ircdToken(realm);
    const id = await createUser(realm, 'scrammy'); await setPassword(realm, id, 'Pw-scram-1');
    const cred = {type: 'irc-scram-sha256',
      secretData: JSON.stringify({storedKey: 'WG5d8oPm3OtcPnkdi4Uo7BkeZkBFzpcXkuLmtbsT4qY=', serverKey: 'wfPLwcE6nTWhTAmQ7tl2KeoiWGPlZqQxSrmfPwDl2dU='}),
      credentialData: JSON.stringify({salt: 'W22ZaJ0SNY7soEsUEjb6gQ==', iterations: 4096})};
    expect(await putUser(realm, id, {credentials: [cred]})).toBe(204);
    const r = await ircCredentials(realm, 'scrammy', t);
    expect(r.status).toBe(200);
    expect(r.body.scram).toEqual({salt: 'W22ZaJ0SNY7soEsUEjb6gQ==', iterations: 4096,
      storedKey: 'WG5d8oPm3OtcPnkdi4Uo7BkeZkBFzpcXkuLmtbsT4qY=', serverKey: 'wfPLwcE6nTWhTAmQ7tl2KeoiWGPlZqQxSrmfPwDl2dU='});
    expect(r.body.ecdsaPublicKey).toBeUndefined();

    const pw = (await getCredentials(realm, id)).find(c => c.type === 'password');
    const del = await fetch(`${URL}/admin/realms/${realm}/users/${id}/credentials/${pw.id}`,
      {method: 'DELETE', headers: {Authorization: `Bearer ${await adminToken()}`}});
    expect(del.status).toBe(204);
    expect(await putUser(realm, id, {credentials: [pbkdf2Cred('Pw-other-2')]})).toBe(204);
    const after = await ircCredentials(realm, 'scrammy', t);
    expect(after.status).toBe(200);
    expect(after.body.scram).toBeUndefined();
  });
});
