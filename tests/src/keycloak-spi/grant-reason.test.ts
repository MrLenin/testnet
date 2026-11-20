import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import {
  URL, auth, adminToken, createRealm, deleteRealm, createUser, setPassword, getUser, passwordGrant, runRealmSetup,
  uniqueRealm, otpCred, totp, pbkdf2Cred, ircdToken, ircCredentials, verifierMatches,
} from '../helpers/kc-spi-it';

const OTP_SECRET = 'grant-reason-otp-secret';

async function admin(method: string, path: string, body?: unknown): Promise<any> {
  const r = await fetch(`${URL}/admin/realms/${path}`, {
    method,
    headers: { Authorization: `Bearer ${await adminToken()}`, 'Content-Type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  if (!r.ok) throw new Error(`${method} ${path}: ${r.status} ${await r.text()}`);
  const text = await r.text();
  return text ? JSON.parse(text) : null;
}

async function setRealmAttribute(realm: string, name: string, value: string): Promise<void> {
  const rep = await admin('GET', realm);
  await admin('PUT', realm, { attributes: { ...(rep.attributes ?? {}), [name]: value } });
}

/** The realm's stored login-error events for one user, newest first. */
async function loginErrors(realm: string, userId: string): Promise<any[]> {
  const r = await fetch(`${URL}/admin/realms/${realm}/events?type=LOGIN_ERROR&user=${userId}`, auth(await adminToken()));
  if (!r.ok) throw new Error(`events ${realm}: ${r.status}`);
  return r.json();
}

function expectNoReason(body: any): void {
  expect(body).not.toHaveProperty('irc_state');
  expect(body).not.toHaveProperty('irc_reasons');
}

// One realm with the defaults (its user profile requires an email, first and last name; OTP for a user
// with an OTP credential), the flows from the set-up tool, stored events, and brute-force detection with
// a high failure limit.
describe('password grant: the reason an account was refused', () => {
  const realm = uniqueRealm('grantreason');
  beforeAll(async () => {
    await createRealm(realm, {
      passwordPolicy: 'scramSha256', eventsEnabled: true, bruteForceProtected: true, failureFactor: 30,
    });
    runRealmSetup(realm, ['--service-client', 'ircd']);
  });
  afterAll(async () => { await deleteRealm(realm); });

  const numFailures = async (id: string) =>
    (await admin('GET', `${realm}/attack-detection/brute-force/users/${id}`)).numFailures;

  const cases: [string, object, boolean, string[]][] = [
    ['verify', { emailVerified: false, requiredActions: ['VERIFY_EMAIL'] }, false, ['verify_email']],
    ['temp', {}, true, ['update_password']],
    ['totp', { requiredActions: ['CONFIGURE_TOTP'] }, false, ['configure_totp']],
  ];
  it.each(cases)('%s: names the reason', async (name, extra, temporary, reasons) => {
    const id = await createUser(realm, name, extra);
    expect(await setPassword(realm, id, `Pw-${name}-1`, temporary)).toBe(204);
    const r = await passwordGrant(realm, name, `Pw-${name}-1`);
    expect(r.status).toBe(400);
    expect(r.body.error).toBe('invalid_grant');
    expect(r.body.error_description).toBe('Account is not fully set up');
    expect(r.body.irc_state).toBe('incomplete');
    expect(r.body.irc_reasons).toEqual(reasons);
  });

  it('names an action Keycloak adds at login (an incomplete profile: verify_profile)', async () => {
    const id = await createUser(realm, 'noprofile', { email: null, emailVerified: false });
    expect(await setPassword(realm, id, 'Pw-noprofile-1')).toBe(204);
    const r = await passwordGrant(realm, 'noprofile', 'Pw-noprofile-1');
    expect(r.status).toBe(400);
    expect(r.body.error).toBe('invalid_grant');
    expect(r.body.error_description).toBe('Account is not fully set up');
    expect(r.body.irc_state).toBe('incomplete');
    expect(r.body.irc_reasons).toEqual(['verify_profile']);
  });

  it('records the refusal as Keycloak does (resolve_required_actions), not as a failed login', async () => {
    const id = await createUser(realm, 'counted', { requiredActions: ['VERIFY_EMAIL'] });
    expect(await setPassword(realm, id, 'Pw-counted-1')).toBe(204);
    for (let i = 0; i < 2; i++) {
      expect((await passwordGrant(realm, 'counted', 'Pw-counted-1')).body.irc_state).toBe('incomplete');
    }
    const events = await loginErrors(realm, id);
    expect(events).toHaveLength(2);
    expect(events.every((e: any) => e.error === 'resolve_required_actions')).toBe(true);
    const bf = await admin('GET', `${realm}/attack-detection/brute-force/users/${id}`);
    expect(bf.numFailures).toBe(0);
  });

  it('a wrong password on an incomplete account gets no reason', async () => {
    const r = await passwordGrant(realm, 'verify', 'wrong');
    expect(r.status).toBe(401);
    expect(r.body.error_description).toBe('Invalid user credentials');
    expectNoReason(r.body);
  });

  it('a wrong password on a disabled account gets no reason either', async () => {
    const id = await createUser(realm, 'off', { enabled: false, requiredActions: ['VERIFY_EMAIL'] });
    expect(await setPassword(realm, id, 'Pw-off-1')).toBe(204);
    const r = await passwordGrant(realm, 'off', 'wrong');
    expect([400, 401]).toContain(r.status);
    expect(r.body.error).toBe('invalid_grant');
    expectNoReason(r.body);
  });

  it('the right password on a disabled account gets Keycloak\'s own refusal', async () => {
    const r = await passwordGrant(realm, 'off', 'Pw-off-1');
    expect(r.status).toBe(400);
    expect(r.body).toEqual({ error: 'invalid_grant', error_description: 'Account disabled' });
  });

  // The step runs once every factor the flow demands is satisfied: until then a password alone earns no reason.
  it('a second factor still due: the right password alone gets what a wrong one gets, and changes nothing', async () => {
    const extra = { requiredActions: ['VERIFY_EMAIL'], credentials: [otpCred(OTP_SECRET)] };
    const otherId = await createUser(realm, 'otpother', extra);
    expect(await setPassword(realm, otherId, 'Pw-otpother-1')).toBe(204);
    const wrong = await passwordGrant(realm, 'otpother', 'wrong');

    const id = await createUser(realm, 'otpinc', extra);
    expect(await setPassword(realm, id, 'Pw-otpinc-1')).toBe(204);
    const right = await passwordGrant(realm, 'otpinc', 'Pw-otpinc-1');
    expect(right.status).toBe(wrong.status);
    expect(right.body).toEqual(wrong.body);
    expectNoReason(right.body);
    expect((await getUser(realm, id)).requiredActions).toEqual(['VERIFY_EMAIL']);
    // Keycloak's OTP step failed the login and counted it, as it does for a wrong code; the step added nothing.
    expect(await numFailures(id)).toBe(1);

    const withCode = await passwordGrant(realm, 'otpinc', 'Pw-otpinc-1', { totp: totp(OTP_SECRET) });
    expect(withCode.status).toBe(400);
    expect(withCode.body).toEqual({
      error: 'invalid_grant', error_description: 'Account is not fully set up',
      irc_state: 'incomplete', irc_reasons: ['verify_email'],
    });
    expect(await numFailures(id)).toBe(1);
  });

  it('a complete account with a second factor: the password alone is refused by Keycloak and makes no verifier', async () => {
    await createUser(realm, 'otpdone', { credentials: [pbkdf2Cred('Pw-otpdone-1'), otpCred(OTP_SECRET)] });
    const t = await ircdToken(realm);
    const alone = await passwordGrant(realm, 'otpdone', 'Pw-otpdone-1');
    expect(alone.status).toBe(401);
    expect(alone.body).toEqual({ error: 'invalid_grant', error_description: 'Invalid user credentials' });
    expect((await ircCredentials(realm, 'otpdone', t)).body.scram).toBeUndefined();

    const withCode = await passwordGrant(realm, 'otpdone', 'Pw-otpdone-1', { totp: totp(OTP_SECRET) });
    expect(withCode.status).toBe(200);
    expectNoReason(withCode.body);
    expect(verifierMatches((await ircCredentials(realm, 'otpdone', t)).body.scram, 'Pw-otpdone-1')).toBe(true);
  });

  it('a complete account still gets its token', async () => {
    const id = await createUser(realm, 'done');
    expect(await setPassword(realm, id, 'Pw-done-1')).toBe(204);
    const r = await passwordGrant(realm, 'done', 'Pw-done-1');
    expect(r.status).toBe(200);
    expect(typeof r.body.access_token).toBe('string');
    expectNoReason(r.body);
  });
});

// A realm whose user profile does not require an email (the email attribute's `required` removed), so a
// user without one is complete until the realm turns the IRC email rule on.
describe('password grant: the email rules', () => {
  const realm = uniqueRealm('grantemail');
  beforeAll(async () => {
    await createRealm(realm, { passwordPolicy: 'scramSha256' });
    runRealmSetup(realm);
    const profile = await admin('GET', `${realm}/users/profile`);
    for (const a of profile.attributes) {
      if (a.name === 'email') delete a.required;
    }
    await admin('PUT', `${realm}/users/profile`, profile);
  });
  afterAll(async () => { await deleteRealm(realm); });

  it('the email rules apply only when the realm turns them on', async () => {
    const id = await createUser(realm, 'nomail', { email: null, emailVerified: false });
    expect(await setPassword(realm, id, 'Pw-nomail-1')).toBe(204);
    const before = await passwordGrant(realm, 'nomail', 'Pw-nomail-1');
    expect(before.status).toBe(200);

    await setRealmAttribute(realm, 'irc.requireEmail', 'true');
    const after = await passwordGrant(realm, 'nomail', 'Pw-nomail-1');
    expect(after.status).toBe(400);
    expect(after.body.error).toBe('invalid_grant');
    expect(after.body.error_description).toBe('Account is not fully set up');
    expect(after.body.irc_state).toBe('incomplete');
    expect(after.body.irc_reasons).toEqual(['email_missing']);
  });
});
