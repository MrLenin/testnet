/**
 * The account timestamp check works the way it originally did: X3's own
 * registration date is canonical and is never overwritten, and a wire
 * timestamp that differs from it refuses the bind.
 *
 * The LDAP bridge (a52968b) "reconciled" a difference by overwriting X3's
 * record with the directory's value, which destroyed the registration date of
 * every account whose directory entry had ever been recreated and defeated the
 * check in the one case it existed for. Legacy servers still authenticate
 * through X3 over LDAP, so the check stays and goes back to its original form
 * (user, 2026-09-24); the Keycloak id is the identity signal on the fork path.
 *
 * Two paths meet in handle_account(), the AC-*receiver* path:
 *
 * - A stamp X3 made itself.  `AuthServ AUTH` stamps the user with the
 *   account's registration date (cmd_auth -> set_user_handle_info(stamp=1)
 *   -> AC R account ts), and the ircd carries that stamp into every later
 *   burst.  When saxdb's date is then changed underneath it -- here by
 *   editing the database while X3 is stopped, the way a restore or a
 *   migration would -- the replayed stamp no longer matches and X3 refuses
 *   the bind.  That is the delete detector doing its job.
 * - A SASL login.  The ircd completes SASL against Keycloak and announces
 *   the account with no timestamp of its own (0), so X3 checks nothing and
 *   binds; the registration date stays what saxdb says.
 *
 * The bridge did neither: it bound the stale stamp and overwrote the date.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { execSync } from 'node:child_process';
import * as fs from 'node:fs';
import { createX3Client, createOperClient, NICKSERV_NICK, OPSERV_NICK, X3Client } from '../helpers/x3-client';
import { createRawSocketClient, RawSocketClient, uniqueId } from '../helpers/index.js';
import { authenticateSaslPlain } from '../helpers/sasl';

/* Red until x3 `feature/keycloak-identity` is on the bed: the default bed branch
 * still carries the LDAP backfill, which binds and overwrites. Run with
 * X3_TS_ORIGINAL=1 against a bed built from that branch. (An explicit gate, not
 * a silent skipIf -- same convention as LEGACY_MODE_LETTERS.) */
const GATED = process.env.X3_TS_ORIGINAL !== '1';

const ACCOUNT = `tsdrift${Math.random().toString(36).slice(2, 8)}`;
const PASSWORD = 'TsDrift!2026';
/** 2024-01-01T00:00:00Z — comfortably older than any bed directory entry. */
const OLD_REGISTER = 1704067200;

function sh(cmd: string): string {
  return execSync(cmd, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
}

/** Force X3 to write saxdb now, and wait until the handle is actually on disk.
 *
 * SIGQUIT is X3's write-databases signal (main.c sigaction_writedb sets
 * do_write_dbs; ioset.c's main loop then calls saxdb_write_all). X3 installs a
 * handler, so this does not dump core.
 *
 * Neither obvious alternative works. Shutdown is unreliable: docker's 10s stop
 * timeout expires during the squit and the container dies on SIGKILL (137)
 * before the write lands. And `O3 WRITE <db>` refuses this bed's database --
 * cmd_write skips any db with a mondo_section, and the bed keeps every section
 * in one x3.db.
 */
async function flushSaxdb(handle: string): Promise<void> {
  sh('docker kill -s QUIT x3');
  // Be generous. The signal handler only sets do_write_dbs; the write happens
  // when ioset's main loop next comes round, and engine->loop() can sit in poll
  // for many seconds on a quiet bed. Observed landing ~23s after the signal.
  for (let i = 0; i < 120; i++) {
    await new Promise((r) => setTimeout(r, 500));
    // Copy out and inspect on the host: nesting quotes through
    // `docker exec sh -c 'grep ...'` is fragile and fails in the wrong direction.
    sh(`docker cp x3:/x3/data/x3.db /tmp/${handle}.check.db`);
    if (fs.readFileSync(`/tmp/${handle}.check.db`, 'utf8').includes(`"${handle}"`))
      return;
  }
  throw new Error(`saxdb never persisted "${handle}" after SIGQUIT`);
}

/** Rewrite one handle's "register" value in saxdb, with X3 stopped. */
function backdateRegister(handle: string, epoch: number): void {
  sh('docker stop -t 30 x3');
  sh(`docker cp x3:/x3/data/x3.db /tmp/${handle}.db`);
  const db = fs.readFileSync(`/tmp/${handle}.db`, 'utf8');
  const re = new RegExp(`("${handle}" \\{[^}]*?"register" ")(\\d+)(")`);
  expect(db).toMatch(re);                     // fail loudly if the shape changed
  fs.writeFileSync(`/tmp/${handle}.db`, db.replace(re, `$1${epoch}$3`));
  sh(`docker cp /tmp/${handle}.db x3:/x3/data/x3.db`);
  sh('docker start x3');
}

/** Connect, authenticate by SASL PLAIN, and finish registration. */
async function saslLogin(account: string, password: string): Promise<RawSocketClient> {
  const client = await createRawSocketClient();
  await client.capLs();
  const caps = await client.capReq(['sasl']);
  expect(caps.ack, 'server did not ACK the sasl capability').toContain('sasl');

  const res = await authenticateSaslPlain(client, account, password);
  expect(res.success, `SASL PLAIN failed: ${JSON.stringify(res)}`).toBe(true);

  client.capEnd();
  client.register(`ts${uniqueId()}`);
  await client.waitForNumeric('001', 15000);
  return client;
}

/** Ask AuthServ for the caller's own ACCOUNTINFO and collect the notices.
 *
 * cmd_handleinfo with no argument falls back to the caller's handle; passing a
 * bare name would be resolved as a *nick* ("User with nick ... does not exist").
 */
async function ownAccountInfo(client: RawSocketClient): Promise<string[]> {
  client.clearRawBuffer();
  client.send(`PRIVMSG ${NICKSERV_NICK} :ACCOUNTINFO`);
  await new Promise((r) => setTimeout(r, 4000));
  return client.getUnconsumedLines().filter((l) => l.includes('NOTICE'));
}

/** "Registered on: Mon Jan  1 00:00:00 2024" -> epoch seconds.
 *
 * X3 formats this with ctime(), which emits no timezone. The container runs
 * UTC; this host does not. Parsing the bare string would silently shift the
 * result by the host's offset, so UTC is appended explicitly.
 */
function parseRegisteredOn(lines: string[]): number {
  const line = lines.find((l) => l.includes('Registered on:'));
  expect(line, `no "Registered on:" in:\n${lines.join('\n')}`).toBeDefined();
  const when = line!.split('Registered on:')[1].trim();
  const t = Date.parse(`${when} UTC`);
  expect(Number.isNaN(t), `unparseable date: "${when}"`).toBe(false);
  return Math.floor(t / 1000);
}

/** Run one AuthServ command as an oper with the security override on; returns the reply lines. */
async function asOper(command: string): Promise<string[]> {
  const op = await createOperClient();
  try {
    const god = await op.serviceCmd(OPSERV_NICK, 'GOD ON');
    expect(god.join('\n'), 'GOD ON').toMatch(/Security override has been enabled|already have security override enabled/);
    return await op.serviceCmd(NICKSERV_NICK, command);   // awaited: the finally below closes the socket
  } finally {
    op.close();
  }
}

/** X3's log since `since`, both streams. */
function x3Logs(since: string): string {
  return sh(`docker logs --since ${since} x3 2>&1`);
}

describe('account registration date survives authentication', () => {
  /** Authenticated through AuthServ before the date was changed: carries X3's old stamp. */
  let stamped: X3Client | undefined;

  afterAll(() => {
    stamped?.close();
  });

  beforeAll(async () => {
    // Guard the hook, not just the tests: it stops and restarts x3 and edits
    // its database, which must never happen when the suite is gated off.
    if (GATED) return;
    const c = await createX3Client();
    // E-mail verification is off on this bed, so REGISTER completes immediately
    // ("Account has been registered to you.") and authenticates the caller --
    // there is no activation cookie. registerAndActivate() waits for one that
    // never arrives.
    const reg = await c.registerAccount(ACCOUNT, PASSWORD, `${ACCOUNT}@example.com`);
    expect(reg.success, `registration failed: ${JSON.stringify(reg)}`).toBe(true);
    c.close();

    // X3 writes the account through to LDAP; Keycloak federates from there.
    // Poll until SASL actually works, rather than guessing at a sync interval.
    let ready = false;
    for (let i = 0; i < 12 && !ready; i++) {
      try {
        const probe = await saslLogin(ACCOUNT, PASSWORD);
        probe.close();
        ready = true;
      } catch {
        await new Promise((r) => setTimeout(r, 10000));
      }
    }
    expect(ready, `${ACCOUNT} never became usable for SASL`).toBe(true);

    // X3 stamps this one itself, with the date it knows now; the ircd keeps
    // the stamp and replays it to X3 in every burst from here on.
    stamped = await createX3Client();
    const authed = await stamped.auth(ACCOUNT, PASSWORD);
    expect(authed.success, `AUTH failed: ${JSON.stringify(authed)}`).toBe(true);
    expect((await ownAccountInfo(stamped)).some((l) => l.includes('Account Information')), 'bound after AUTH').toBe(true);

    await flushSaxdb(ACCOUNT);                       // account must be on disk
    backdateRegister(ACCOUNT, OLD_REGISTER);         // X3 restarts: the burst replays the stamp
    await new Promise((r) => setTimeout(r, 15000));  // X3 relinks to the ircd
  }, 330_000);

  it.skipIf(GATED)('refuses a stamp that no longer matches saxdb, and never rewrites the date to it', async () => {
    // The replayed stamp is the old date; saxdb now says 2024.  The check as
    // it originally was refuses: the user stays +r on the ircd but unbound in
    // X3, so AuthServ reports no account rather than the handle's details.
    const info = await ownAccountInfo(stamped!);
    expect(
      info.some((l) => l.includes('Account Information')),
      `the stale stamp was bound: ${JSON.stringify(info)}`,
    ).toBe(false);
    expect(x3Logs('180s'), 'X3 logged the mismatch').toMatch(
      new RegExp(`using account ${ACCOUNT} but timestamp does not match: wire=\\d+ saxdb=${OLD_REGISTER}`),
    );
    // Nothing "corrected" saxdb from the stamp or from the directory.
    expect(parseRegisteredOn((await asOper(`ACCOUNTINFO *${ACCOUNT}`)))).toBe(OLD_REGISTER);
  }, 60_000);

  it.skipIf(GATED)('binds a SASL login, which carries no timestamp, and leaves the date untouched', async () => {
    const client = await saslLogin(ACCOUNT, PASSWORD);
    const info = await ownAccountInfo(client);
    client.close();
    expect(
      info.some((l) => l.includes('Account Information')),
      `handle bind was refused: ${JSON.stringify(info)}`,
    ).toBe(true);
    // The bridge overwrote this with the directory's createTimestamp (2026-xx).
    expect(parseRegisteredOn(info)).toBe(OLD_REGISTER);
  }, 60_000);
});
