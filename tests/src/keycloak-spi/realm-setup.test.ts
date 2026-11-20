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

  it('copies a custom bound direct-grant flow, keeping its difference, with the sync step after the password step', async () => {
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
    const pw = ex.find((e: any) => e.providerId === 'direct-grant-validate-password');
    const sync = ex.filter((e: any) => e.providerId === 'irc-credential-sync');
    expect(sync).toHaveLength(1);
    expect(sync[0].level).toBe(pw.level);
    expect(sync[0].index).toBe(pw.index + 1);
    expect(sync[0].requirement).toBe('REQUIRED');
    // The custom flow itself is left as it was.
    expect((await executions(custom, 'custom dg')).some((e: any) => e.providerId === 'irc-credential-sync')).toBe(false);
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
