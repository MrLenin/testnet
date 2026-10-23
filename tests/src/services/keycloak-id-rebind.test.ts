/**
 * X3 binds each handle to the Keycloak user id the ircd announces.  When an
 * announcement carries a different id, the account was recreated in Keycloak
 * (Rubin, 2026-09-24: "if field in x3 is empty, populate it. if its there but
 * different, delete+recreate data in x3.db ... so the first time they show up
 * on irc with a new uuid (recreated account) it resets them"): the handle
 * starts over -- bound to the new id, with the old data (channel access,
 * registration date, ...) gone -- the login goes through, nobody is
 * disconnected, and the sessions that were logged in ride along onto the
 * fresh handle.  The id a reset (or a REBIND) replaced is remembered, so
 * sessions that still announce it (bursts, alias attaches, the ircd's login
 * cache) bind instead of resetting the account again.
 *
 * What this bed lets a test see, and how the cases are built around it:
 * - X3 sees bouncer PRIMARIES and legacy users only; an alias introduction
 *   (BX C) is a no-op for services.  A second connection of a logged-in
 *   account is an alias, invisible to X3 and answered through its primary.
 *   So the "different id" is driven by the primary's own re-authentication
 *   (OAUTHBEARER; AC M carries the id), after the stored id was changed by
 *   hand with REBIND -- no Keycloak deletion involved.  A re-authentication
 *   to the SAME account name announces nothing (known limit), so the primary
 *   goes to a second account and back.
 * - A closed client leaves a held bouncer ghost, and the next login of the
 *   account revives it or attaches instead of announcing the account, so
 *   ghosts are reaped (oper KILL) before a case that needs a plain login.
 * - This bed's Keycloak SPI posts account events to the ircd, which deauths
 *   every session of a deleted account before the recreated user can log in;
 *   the recreate case therefore starts with nothing connected.
 *
 * GATED behind KC_ID_BIND=1: needs nefarious from fix/wire-keycloak-id and
 * x3 from feature/keycloak-identity.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { spawnSync } from 'node:child_process';
import * as net from 'node:net';
import { createRawSocketClient, RawSocketClient, PRIMARY_SERVER } from '../helpers/index.js';
import { authenticateSaslPlain, authenticateSaslOAuthBearer } from '../helpers/sasl';
import { createOperClient, NICKSERV_NICK, OPSERV_NICK } from '../helpers/x3-client';
import { getKeycloakAdminToken } from '../helpers/keycloak-sync';

const GATED = process.env.KC_ID_BIND !== '1';
/** The bed's X3 runs with keycloak_id_reset on (the gated behaviour). */
const RESET = process.env.KC_ID_RESET === '1';
const KC = process.env.KEYCLOAK_URL || 'http://localhost:8080';
const REALM = 'testnet';

// 'test*' is swept by src/scripts/cleanup-tests.ts.
const tag = Math.random().toString(36).slice(2, 7);
const NAME = `testreb${tag}`;
const SECOND = `testreb${tag}s`;                                 // a detour account for the re-authentication
const CHAN = `#testreb${tag}`;
const PASSWORD = 'Rebind!2026';
const PASSWORD_AFTER = 'Rebind!2026-again';
/** Ids no Keycloak user has; what an oper would type from the admin console. */
const BOGUS = '6ba7b810-9dad-11d1-80b4-00c04fd430c8';
const BOGUS2 = '6ba7b811-9dad-11d1-80b4-00c04fd430c8';

let token = '';

async function kc(p: string, init: RequestInit = {}): Promise<Response> {
  return fetch(`${KC}/admin/realms/${REALM}${p}`, {
    ...init,
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json', ...(init.headers || {}) },
  });
}

async function kcCreate(password: string, username: string = NAME): Promise<string> {
  const res = await kc('/users', {
    method: 'POST',
    body: JSON.stringify({
      username, enabled: true, emailVerified: true, email: `${username}@example.com`,
      credentials: [{ type: 'password', value: password, temporary: false }],
    }),
  });
  if (!res.ok && res.status !== 409) throw new Error(`create: ${res.status} ${await res.text()}`);
  return (await (await kc(`/users?username=${username}&exact=true`)).json())[0].id;
}

async function kcDelete(username: string = NAME): Promise<string> {
  const id = (await (await kc(`/users?username=${username}&exact=true`)).json())[0]?.id;
  if (id) await kc(`/users/${id}`, { method: 'DELETE' });
  return id ?? '';
}

/** An access token from the realm's public IRC client (its sub is the user's id). */
async function kcUserToken(password: string, username: string = NAME): Promise<string> {
  const res = await fetch(`${KC}/realms/${REALM}/protocol/openid-connect/token`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ grant_type: 'password', client_id: 'irc-client', username, password }),
  });
  if (!res.ok) throw new Error(`token for ${username}: ${res.status} ${await res.text()}`);
  return (await res.json()).access_token as string;
}

/** The 22-character form of a Keycloak UUID, as the ircd announces it and X3 stores and prints it. */
function compactId(uuid: string): string {
  return Buffer.from(uuid.replace(/-/g, ''), 'hex').toString('base64url');
}

async function login(nick: string, password: string): Promise<{ c: RawSocketClient; ok: boolean; closed: boolean }> {
  const c = await createRawSocketClient();
  await c.capLs();
  await c.capReq(['sasl']);
  const r = await authenticateSaslPlain(c, NAME, password);
  c.capEnd();
  c.register(nick);
  const closed = await c.waitForLine(/ KILL \S+ :|ERROR :Closing Link/, 12000).then(() => true, () => false);
  if (!closed) await c.waitForNumeric('001', 12000).catch(() => {});
  return { c, ok: r.success, closed };
}

/** X3's view of who a client is: the account name, or '' when X3 has no binding. */
async function boundAccount(c: RawSocketClient): Promise<string> {
  c.clearRawBuffer();
  c.send(`PRIVMSG ${NICKSERV_NICK} :ACCOUNTINFO`);
  const line = await c.waitForLine(/Account Information for|must be authenticated/, 8000).catch(() => '');
  return /Account Information for \x02?([^\x02\s]+)/.exec(line)?.[1] ?? '';
}

/** Run one service command as an oper with the security override on; returns the reply lines joined. */
async function asOper(command: string, service: string = NICKSERV_NICK): Promise<string> {
  const op = await createOperClient();
  try {
    const god = await op.serviceCmd(OPSERV_NICK, 'GOD ON');
    expect(god.join('\n'), 'GOD ON').toMatch(/Security override has been enabled|already have security override enabled/);
    return (await op.serviceCmd(service, command)).join('\n');
  } finally {
    op.close();
  }
}

/** KILL a held ghost so the account's next login announces itself instead of reviving it. */
async function reap(nick: string): Promise<void> {
  const op = await createOperClient();
  try {
    op.send(`KILL ${nick} :test cleanup`);
    await new Promise((r) => setTimeout(r, 1500));
  } finally {
    op.close();
  }
}

/** "Registered on: Mon Jan  1 00:00:00 2024" -> epoch seconds (ctime(), container in UTC). */
function registeredOn(info: string): number {
  const line = info.split('\n').find((l) => l.includes('Registered on:'));
  expect(line, `no "Registered on:" in:\n${info}`).toBeDefined();
  const t = Date.parse(`${line!.split('Registered on:')[1].trim()} UTC`);
  expect(Number.isNaN(t), `unparseable date in "${line}"`).toBe(false);
  return Math.floor(t / 1000);
}

function x3Logs(since: string): string {
  const r = spawnSync('docker', ['logs', '--since', since, 'x3'], { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
  return (r.stdout ?? '') + (r.stderr ?? '');
}

/** An announcement carrying the id a reset or REBIND replaced: refused, never a second reset. */
function staleLine(oldId: string, nowId: string): RegExp {
  return new RegExp(`account ${NAME} with the Keycloak id it had before \\(${compactId(oldId)}, now ${compactId(nowId)}\\): bind refused`);
}

const LEGACY_PORT = 6671;
/** The bed's legacy comparison slot (nefarious-upstream), if it is up: a user there is a separate X3 user, not a bouncer alias. */
async function legacySlotUp(): Promise<boolean> {
  return new Promise((resolve) => {
    const sock = net.connect(LEGACY_PORT, PRIMARY_SERVER.host);
    const done = (v: boolean) => { try { sock.destroy(); } catch { /* */ } resolve(v); };
    sock.once('connect', () => done(true));
    sock.once('error', () => done(false));
    setTimeout(() => done(false), 2000);
  });
}

function refuseLine(newId: string, oldId: string): RegExp {
  return new RegExp(`account ${NAME} with a different Keycloak id \\(${compactId(newId)}, stored ${compactId(oldId)}\\): bind refused`);
}

function resetLine(newId: string, oldId: string): RegExp {
  return new RegExp(`account ${NAME} with a different Keycloak id \\(${compactId(newId)}, was ${compactId(oldId)}\\): account data reset`);
}

/**
 * Bind the command to AuthServ.  X3 keeps a service's command bindings in
 * its database, and a service that already has some does not pick up a
 * module's new commands on restart, so an operator binds them once:
 * /msg O3 BIND AuthServ REBIND *nickserv.rebind.  Idempotent here.
 */
async function bindRebind(): Promise<void> {
  const reply = await asOper(`BIND ${NICKSERV_NICK} REBIND *nickserv.rebind`, OPSERV_NICK);
  expect(reply, 'REBIND bound to AuthServ').toMatch(/bound|already/i);
}

describe('a different Keycloak id under a bound name', () => {
  let idBefore = '';
  let idAfter = '';

  beforeAll(async () => {
    if (GATED) return;
    token = await getKeycloakAdminToken();
    idBefore = await kcCreate(PASSWORD);
    await kcCreate(PASSWORD, SECOND);
    await bindRebind();
  }, 60_000);

  afterAll(async () => {
    if (GATED) return;
    await kcDelete();
    await kcDelete(SECOND);
  });

  it.skipIf(GATED)('a bound session that re-authenticates with a different id is refused and reported, or reset when configured', async () => {
    const older = await login(`reb${tag}a`, PASSWORD);            // the primary, the one X3 sees
    const older2 = await login(`reb${tag}z`, PASSWORD);           // an alias of it: answered through the primary
    const op = await createOperClient();
    try {
      expect(older.ok && !older.closed, 'first login bound').toBe(true);
      expect(await boundAccount(older.c)).toBe(NAME);
      expect(await boundAccount(older2.c)).toBe(NAME);
      const before = await asOper(`ACCOUNTINFO *${NAME}`);
      expect(before, 'adopted the id on first use').toMatch(new RegExp(`Keycloak ID:\\s*${compactId(idBefore)}`));
      const dateBefore = registeredOn(before);

      // Something to lose: access on a registered channel.
      expect((await op.serviceCmd(OPSERV_NICK, 'GOD ON')).join('\n')).toMatch(/enabled/);
      op.send(`JOIN ${CHAN}`);
      await new Promise((r) => setTimeout(r, 1000));
      const reg = await op.registerChannel(CHAN);
      expect(reg.success, `REGISTER ${CHAN}: ${reg.lines.join(' | ')}`).toBe(true);
      const add = await op.addUser(CHAN, NAME, 200);
      expect(add.success, `ADDUSER: ${add.lines.join(' | ')}`).toBe(true);
      // USERS listing: the single-account ACCESS reply is worded differently and not parsed.
      const hasAccess = async () =>
        (await op.getAccess(CHAN)).some((a) => a.account.toLowerCase() === NAME.toLowerCase());
      expect(await hasAccess(), 'access granted').toBe(true);

      // A different id on the record, without touching Keycloak: clear, then
      // set one no user has (nothing remembered, since nothing was stored).
      expect(await asOper(`REBIND *${NAME} *`)).toMatch(/binding cleared/i);
      const rebound = await asOper(`REBIND *${NAME} ${BOGUS}`);
      expect(rebound).toMatch(/Keycloak id set/i);
      expect(rebound, 'REBIND to a new id detaches the sessions logged in under the old one').toMatch(/1 session\(s\) logged in under the previous id were detached/);
      expect(await boundAccount(older.c), 'the primary is nobody to X3 after the REBIND').toBe('');

      // The primary re-authenticates: away to a second account and back, since
      // a re-authentication to the same name announces nothing.  The way back
      // is AC M with its real id, which differs from the stored one -> reset.
      const away = await authenticateSaslOAuthBearer(older.c, await kcUserToken(PASSWORD, SECOND));
      expect(away.success, `re-authentication to ${SECOND}: ${away.error}`).toBe(true);
      await new Promise((res) => setTimeout(res, 2000));
      const back = await authenticateSaslOAuthBearer(older.c, await kcUserToken(PASSWORD));
      expect(back.success, `re-authentication back to ${NAME}: ${back.error}`).toBe(true);
      await new Promise((res) => setTimeout(res, 3000));

      expect(older.closed, 'nobody was disconnected').toBe(false);
      const after = await asOper(`ACCOUNTINFO *${NAME}`);
      if (RESET) {
        expect(await boundAccount(older.c), 'the primary is on the fresh handle').toBe(NAME);
        expect(await boundAccount(older2.c), 'its alias too').toBe(NAME);
        expect(x3Logs('120s'), 'X3 reset the account').toMatch(resetLine(idBefore, BOGUS));
        expect(after, 'bound to the announced id').toMatch(new RegExp(`Keycloak ID:\\s*${compactId(idBefore)}`));
        expect(after, 'and remembers the one it replaced').toMatch(new RegExp(`Previous Keycloak ID:\\s*${compactId(BOGUS)}`));
        expect(registeredOn(after), 'X3\'s own fresh date').toBeGreaterThanOrEqual(dateBefore);
        expect(await hasAccess(), 'channel access did not survive the reset').toBe(false);
      } else {
        // The default: the bind is refused and reported; the stored id and
        // the data stay.  The ircd keeps the user logged in; X3 does not know them.
        expect(x3Logs('120s'), 'X3 refused the bind').toMatch(refuseLine(idBefore, BOGUS));
        expect(x3Logs('120s'), 'and did not reset').not.toMatch(resetLine(idBefore, BOGUS));
        expect(await boundAccount(older.c), 'the primary is nobody to X3').toBe('');
        expect(await boundAccount(older2.c), 'its alias too').toBe('');
        expect(after, 'the stored id is kept').toMatch(new RegExp(`Keycloak ID:\\s*${compactId(BOGUS)}`));
        expect(after, 'nothing was replaced').not.toMatch(/Previous Keycloak ID:/);
        expect(registeredOn(after), 'the registration date is untouched').toBe(dateBefore);
        expect(await hasAccess(), 'channel access survives').toBe(true);
      }
    } finally {
      older.c.close();
      older2.c.close();
      await reap(`reb${tag}a`);
      await reap(`reb${tag}z`);
      try {
        const un = await op.unregisterChannel(CHAN);
        const code = /UNREGISTER \S+ (\S+)/.exec(un.lines.join('\n'))?.[1];
        if (code) await op.unregisterChannel(CHAN, code);
      } catch { /* best effort */ }
      op.close();
    }
  }, 240_000);

  it.skipIf(GATED)('an announcement carrying the id a change replaced is refused, never a second reset', async () => {
    // REBIND to another id keeps the replaced one (the sessions still carrying
    // it are this name's).  A login announcing the real id then binds.
    expect(await asOper(`REBIND *${NAME} ${BOGUS2}`)).toMatch(/Keycloak id set/i);
    const set = await asOper(`ACCOUNTINFO *${NAME}`);
    expect(set).toMatch(new RegExp(`Keycloak ID:\\s*${compactId(BOGUS2)}`));
    // With the reset on, the previous case bound the real id; by default it kept BOGUS.
    expect(set, 'REBIND remembers the id it replaced').toMatch(new RegExp(`Previous Keycloak ID:\\s*${compactId(RESET ? idBefore : BOGUS)}`));

    const marker = Math.floor(Date.now() / 1000);
    const c = await login(`reb${tag}b`, PASSWORD);              // a plain login: the ghosts were reaped
    try {
      expect(c.ok && !c.closed, 'login accepted at the ircd').toBe(true);
      // The real id is the one REBIND replaced (reset mode) or matches nothing
      // (default): either way the previous owner's sessions never bind.
      expect(await boundAccount(c.c), 'refused by X3').toBe('');
      expect(x3Logs('60s'), 'and reported').toMatch(RESET ? staleLine(idBefore, BOGUS2) : refuseLine(idBefore, BOGUS2));
    } finally {
      c.c.close();
      await reap(`reb${tag}b`);
    }
    const info = await asOper(`ACCOUNTINFO *${NAME}`);
    expect(info, 'the stored id is untouched').toMatch(new RegExp(`Keycloak ID:\\s*${compactId(BOGUS2)}`));
    expect(x3Logs(`${Math.max(1, Math.floor(Date.now() / 1000) - marker + 5)}s`), 'no second reset')
      .not.toMatch(new RegExp(`account ${NAME} with a different Keycloak id .*: account data reset`));
  }, 120_000);

  it.skipIf(GATED)('a recreated Keycloak user is refused by X3, or bound to its new id when the reset is configured', async () => {
    // A straggler: a session of the OLD owner on the legacy slot (a separate
    // X3 user, authenticated through AuthServ before the recreate).
    let straggler: RawSocketClient | null = null;
    if (await legacySlotUp()) {
      straggler = await createRawSocketClient(PRIMARY_SERVER.host, LEGACY_PORT);
      await straggler.capLs(); straggler.capEnd();
      straggler.register(`reb${tag}l`);
      await straggler.waitForNumeric('001', 25000);
      straggler.clearRawBuffer();
      straggler.send(`PRIVMSG AuthServ :AUTH ${NAME} ${PASSWORD}`);
      await straggler.waitForLine(/recogni[sz]e you|now identified|authenticated/i, 15000);
      expect(await boundAccount(straggler), 'the straggler is logged in before the recreate').toBe(NAME);
    }

    const oldId = await kcDelete();
    idAfter = await kcCreate(PASSWORD_AFTER);
    expect(idAfter, 'a recreated user has a new id').not.toBe(oldId);

    const fresh = await login(`reb${tag}c`, PASSWORD_AFTER);
    try {
      expect(fresh.ok, 'SASL accepted the recreated user').toBe(true);
      expect(fresh.closed, 'not disconnected').toBe(false);
      expect(await boundAccount(fresh.c), RESET ? 'X3 bound the login' : 'X3 refused the login').toBe(RESET ? NAME : '');
      if (straggler) {
        // Reset: the previous owner's session must not inherit the new owner's identity.
        // Default: nothing changed hands, the straggler is still the account's user.
        expect(await boundAccount(straggler), RESET ? 'the straggler was detached by the reset' : 'the straggler is untouched')
          .toBe(RESET ? '' : NAME);
      }
    } finally {
      fresh.c.close();
      await reap(`reb${tag}c`);
      if (straggler) { try { straggler.send('QUIT'); straggler.close(); } catch { /* */ } }
    }
    const info = await asOper(`ACCOUNTINFO *${NAME}`);
    if (RESET) {
      expect(x3Logs('120s'), 'X3 reset the account').toMatch(resetLine(idAfter, BOGUS2));
      expect(info, 'the handle carries the new id').toMatch(new RegExp(`Keycloak ID:\\s*${compactId(idAfter)}`));
      expect(info, 'and remembers the one it replaced').toMatch(new RegExp(`Previous Keycloak ID:\\s*${compactId(BOGUS2)}`));
    } else {
      expect(x3Logs('120s'), 'X3 refused and reported it').toMatch(refuseLine(idAfter, BOGUS2));
      expect(info, 'the stored id is kept').toMatch(new RegExp(`Keycloak ID:\\s*${compactId(BOGUS2)}`));
      expect(info, 'the remembered id is untouched').toMatch(new RegExp(`Previous Keycloak ID:\\s*${compactId(BOGUS)}`));
    }
  }, 180_000);

  it.skipIf(GATED)('REBIND to * clears both ids, and the next login adopts its own', async () => {
    expect(await asOper(`REBIND *${NAME} *`)).toMatch(/binding cleared/i);
    expect(await asOper(`ACCOUNTINFO *${NAME}`), 'clearing forgets both').not.toMatch(/Keycloak ID:/);

    const adopted = await login(`reb${tag}d`, PASSWORD_AFTER);
    try {
      expect(adopted.closed, 'with nothing stored the login is accepted').toBe(false);
      expect(await boundAccount(adopted.c)).toBe(NAME);
    } finally {
      adopted.c.close();
      await reap(`reb${tag}d`);
    }
    expect(await asOper(`ACCOUNTINFO *${NAME}`), 'the login adopted its own id')
      .toMatch(new RegExp(`Keycloak ID:\\s*${compactId(idAfter)}`));
  }, 120_000);

  it.skipIf(GATED)('every id a change replaced is remembered, not only the last one', async () => {
    // The previous case left the handle on the recreated user's id with
    // nothing remembered.  Two changes put that id second on the list; a
    // single remembered id (before 2026-10-22, deferred-items C2) knew only
    // BOGUS and took the login for another recreate.
    expect(await asOper(`REBIND *${NAME} ${BOGUS}`)).toMatch(/Keycloak id set/i);
    expect(await asOper(`REBIND *${NAME} ${BOGUS2}`)).toMatch(/Keycloak id set/i);
    const set = await asOper(`ACCOUNTINFO *${NAME}`);
    expect(set, 'the newest replaced id').toMatch(new RegExp(`Previous Keycloak ID:\\s*${compactId(BOGUS)}`));
    expect(set, 'and the one before it').toMatch(new RegExp(`Previous Keycloak ID:\\s*${compactId(idAfter)}`));

    const marker = Math.floor(Date.now() / 1000);
    const c = await login(`reb${tag}e`, PASSWORD_AFTER);
    try {
      expect(c.ok && !c.closed, 'login accepted at the ircd').toBe(true);
      expect(await boundAccount(c.c), 'refused by X3').toBe('');
      expect(x3Logs('60s'), 'as an earlier session of the name').toMatch(staleLine(idAfter, BOGUS2));
    } finally {
      c.c.close();
      await reap(`reb${tag}e`);
    }
    expect(await asOper(`ACCOUNTINFO *${NAME}`), 'the stored id is untouched')
      .toMatch(new RegExp(`Keycloak ID:\\s*${compactId(BOGUS2)}`));
    expect(x3Logs(`${Math.max(1, Math.floor(Date.now() / 1000) - marker + 5)}s`), 'no reset')
      .not.toMatch(new RegExp(`account ${NAME} with a different Keycloak id .*: account data reset`));
  }, 120_000);

  it.skipIf(GATED)('refuses a value that is not a Keycloak UUID', async () => {
    expect(await asOper(`REBIND *${NAME} not-an-id`)).toMatch(/Keycloak ID/i);
  }, 60_000);
});
