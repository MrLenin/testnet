import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { URL, adminToken, createRealm, deleteRealm, runRealmSetup, uniqueRealm } from '../helpers/kc-spi-it';

async function admin(method: string, path: string, body?: unknown): Promise<Response> {
  return fetch(`${URL}/admin/realms/${path}`, {
    method,
    headers: { Authorization: `Bearer ${await adminToken()}`, 'Content-Type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
}

async function ok(method: string, path: string, body?: unknown): Promise<any> {
  const r = await admin(method, path, body);
  if (!r.ok) throw new Error(`${method} ${path}: ${r.status} ${await r.text()}`);
  const text = await r.text();
  return text ? JSON.parse(text) : null;
}

const executions = (realm: string, flow: string) =>
  ok('GET', `${realm}/authentication/flows/${encodeURIComponent(flow)}/executions`);

/** `steps`, each exactly once, REQUIRED, directly after the password step and in this order, at its level. */
function expectStepsAfterPassword(ex: any[], password: string, steps: string[]): void {
  const pw = ex.find((e: any) => e.providerId === password);
  steps.forEach((provider, i) => {
    const found = ex.filter((e: any) => e.providerId === provider);
    expect(found).toHaveLength(1);
    expect(found[0].level).toBe(pw.level);
    expect(found[0].index).toBe(pw.index + 1 + i);
    expect(found[0].requirement).toBe('REQUIRED');
  });
}

/** Runs the tool expecting a non-zero exit; returns the exit status and stderr. */
function runRealmSetupFailing(realm: string): { status: number; stderr: string } {
  try {
    runRealmSetup(realm);
  } catch (e: any) {
    return { status: e.status, stderr: String(e.stderr) };
  }
  throw new Error('irc_realm_setup.py exited 0');
}

// The tool copies the flows the realm has BOUND, not the built-in ones, so a custom flow is kept.
describe('irc_realm_setup.py flows', () => {
  const custom = uniqueRealm('flowcustom');
  const broken = uniqueRealm('flowbroken');
  beforeAll(async () => { await createRealm(custom); await createRealm(broken); });
  afterAll(async () => { await deleteRealm(custom); await deleteRealm(broken); });

  it('copies a custom bound direct-grant flow, keeping its difference, with the IRC steps after the password step', async () => {
    await ok('POST', `${custom}/authentication/flows/${encodeURIComponent('direct grant')}/copy`, {newName: 'custom dg'});
    await ok('POST', `${custom}/authentication/flows/${encodeURIComponent('custom dg')}/executions/execution`,
      {provider: 'allow-access-authenticator'});
    await ok('PUT', custom, {directGrantFlow: 'custom dg'});

    runRealmSetup(custom);
    runRealmSetup(custom);   // a second run changes nothing and exits 0

    const realm = await ok('GET', custom);
    expect(realm.directGrantFlow).toBe('irc direct grant');
    expect(realm.browserFlow).toBe('irc browser');
    const ex = await executions(custom, 'irc direct grant');
    expect(ex.filter((e: any) => e.providerId === 'allow-access-authenticator')).toHaveLength(1);
    expectStepsAfterPassword(ex, 'direct-grant-validate-password', ['irc-account-state', 'irc-credential-sync']);
    // The custom flow itself is left as it was.
    expect((await executions(custom, 'custom dg')).some((e: any) => ['irc-account-state', 'irc-credential-sync'].includes(e.providerId))).toBe(false);
  });

  it('puts only the sync step in the browser copy', async () => {
    const ex = await executions(custom, 'irc browser');
    expectStepsAfterPassword(ex, 'auth-username-password-form', ['irc-credential-sync']);
    expect(ex.some((e: any) => e.providerId === 'irc-account-state')).toBe(false);
  });

  it('adds the account-state step to a direct-grant copy an earlier version set up (password, then sync)', async () => {
    const before = await executions(custom, 'irc direct grant');
    const state = before.find((e: any) => e.providerId === 'irc-account-state');
    await ok('DELETE', `${custom}/authentication/executions/${state.id}`);
    expectStepsAfterPassword(await executions(custom, 'irc direct grant'), 'direct-grant-validate-password',
      ['irc-credential-sync']);

    runRealmSetup(custom);
    const after = await executions(custom, 'irc direct grant');
    expectStepsAfterPassword(after, 'direct-grant-validate-password', ['irc-account-state', 'irc-credential-sync']);
    expect(after.filter((e: any) => e.providerId === 'allow-access-authenticator')).toHaveLength(1);

    // A further run sends no write: the realm's admin events (which record every admin write) stay as they are.
    await ok('PUT', custom, {adminEventsEnabled: true});
    const adminEvents = async () => (await ok('GET', `${custom}/admin-events?max=1000`)).length;
    const writes = await adminEvents();
    runRealmSetup(custom);
    expect(await adminEvents()).toBe(writes);
    expect(await executions(custom, 'irc direct grant')).toEqual(after);
  });

  it('refuses a bound flow with no password step and changes nothing', async () => {
    await ok('POST', `${broken}/authentication/flows`,
      {alias: 'no password', providerId: 'basic-flow', topLevel: true, builtIn: false});
    await ok('POST', `${broken}/authentication/flows/${encodeURIComponent('no password')}/executions/execution`,
      {provider: 'direct-grant-validate-username'});
    await ok('PUT', broken, {directGrantFlow: 'no password'});

    const r = runRealmSetupFailing(broken);
    expect(r.status).toBe(1);
    expect(r.stderr).toContain('no password');
    expect(r.stderr).toContain('direct-grant-validate-password');

    const realm = await ok('GET', broken);
    expect(realm.directGrantFlow).toBe('no password');
    expect(realm.browserFlow).toBe('browser');
    const aliases = (await ok('GET', `${broken}/authentication/flows`)).map((f: any) => f.alias);
    expect(aliases).not.toContain('irc browser');
    expect(aliases).not.toContain('irc direct grant');
    expect((await admin('GET', `${broken}/roles/irc-read-credentials`)).status).toBe(404);
  });
});
