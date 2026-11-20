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

const IRC_STEPS = ['irc-account-state', 'irc-credential-sync'];

/** The flow's top-level executions, a sub-flow shown as 'flow'. */
const topLevel = (ex: any[]) => ex.filter((e: any) => e.level === 0).map((e: any) => (e.authenticationFlow ? 'flow' : e.providerId));

/** The direct-grant copy ends with the IRC steps, each once in the whole flow, REQUIRED. */
function expectIrcStepsLast(ex: any[], before: string[]): void {
  expect(topLevel(ex).slice(-(before.length + IRC_STEPS.length))).toEqual([...before, ...IRC_STEPS]);
  for (const provider of IRC_STEPS) {
    const found = ex.filter((e: any) => e.providerId === provider);
    expect(found).toHaveLength(1);
    expect(found[0].requirement).toBe('REQUIRED');
  }
}

/** A run of the tool sends no write: the realm's admin events (which record every admin write) stay as they are. */
async function expectNoWritesOnRerun(realm: string): Promise<void> {
  await ok('PUT', realm, {adminEventsEnabled: true});
  const adminEvents = async () => (await ok('GET', `${realm}/admin-events?max=1000`)).length;
  const writes = await adminEvents();
  const flow = await executions(realm, 'irc direct grant');
  runRealmSetup(realm);
  expect(await adminEvents()).toBe(writes);
  expect(await executions(realm, 'irc direct grant')).toEqual(flow);
}

async function move(realm: string, flow: string, provider: string, direction: 'raise' | 'lower', times = 1): Promise<void> {
  for (let i = 0; i < times; i++) {
    const e = (await executions(realm, flow)).find((x: any) => x.providerId === provider);
    await ok('POST', `${realm}/authentication/executions/${e.id}/${direction}-priority`);
  }
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

  it('copies a custom bound direct-grant flow, keeping its difference, with the IRC steps last', async () => {
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
    expectIrcStepsLast(ex, ['flow', 'allow-access-authenticator']);
    // The custom flow itself is left as it was.
    expect((await executions(custom, 'custom dg')).some((e: any) => IRC_STEPS.includes(e.providerId))).toBe(false);
    await expectNoWritesOnRerun(custom);
  });

  it('puts only the sync step in the browser copy, directly after the password form', async () => {
    const ex = await executions(custom, 'irc browser');
    expectStepsAfterPassword(ex, 'auth-username-password-form', ['irc-credential-sync']);
    expect(ex.some((e: any) => e.providerId === 'irc-account-state')).toBe(false);
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

// The built-in direct-grant flow: username, password, then the conditional OTP sub-flow.  The IRC steps go after
// all of it, from a fresh copy and from the layouts earlier versions of the tool left.
describe('irc_realm_setup.py direct-grant layout', () => {
  const realm = uniqueRealm('flowlayout');
  const DG = 'irc direct grant';
  const FINAL = ['direct-grant-validate-username', 'direct-grant-validate-password', 'flow', ...IRC_STEPS];
  beforeAll(async () => { await createRealm(realm); });
  afterAll(async () => { await deleteRealm(realm); });

  it('fresh: username, password, conditional OTP, then the IRC steps; the browser copy keeps the sync after the form', async () => {
    runRealmSetup(realm);
    const ex = await executions(realm, DG);
    expect(topLevel(ex)).toEqual(FINAL);
    expectIrcStepsLast(ex, ['flow']);
    expect(ex.find((e: any) => e.level === 0 && e.authenticationFlow).displayName).toContain('Conditional OTP');
    expectStepsAfterPassword(await executions(realm, 'irc browser'), 'auth-username-password-form', ['irc-credential-sync']);
    await expectNoWritesOnRerun(realm);
  });

  it('from the layout with only the sync step, after the password step (password, sync, OTP)', async () => {
    const state = (await executions(realm, DG)).find((e: any) => e.providerId === 'irc-account-state');
    await ok('DELETE', `${realm}/authentication/executions/${state.id}`);
    await move(realm, DG, 'irc-credential-sync', 'raise');
    expect(topLevel(await executions(realm, DG))).toEqual(
      ['direct-grant-validate-username', 'direct-grant-validate-password', 'irc-credential-sync', 'flow']);

    runRealmSetup(realm);
    expect(topLevel(await executions(realm, DG))).toEqual(FINAL);
    expectIrcStepsLast(await executions(realm, DG), ['flow']);
    await expectNoWritesOnRerun(realm);
  });

  it('from the layout with both steps after the password step (password, state, sync, OTP)', async () => {
    await move(realm, DG, 'irc-account-state', 'raise');
    await move(realm, DG, 'irc-credential-sync', 'raise');
    expect(topLevel(await executions(realm, DG))).toEqual(
      ['direct-grant-validate-username', 'direct-grant-validate-password', ...IRC_STEPS, 'flow']);

    runRealmSetup(realm);
    expect(topLevel(await executions(realm, DG))).toEqual(FINAL);
    expectIrcStepsLast(await executions(realm, DG), ['flow']);
    await expectNoWritesOnRerun(realm);
  });
});
