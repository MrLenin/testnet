/**
 * The account registration date must survive authentication.
 *
 * X3 used to treat a wire/saxdb timestamp difference as a signal that the
 * directory account had been recreated, and "reconciled" by overwriting its own
 * record with the directory's value. That destroyed the registration date of
 * every account whose directory entry had ever been recreated -- and refused the
 * handle bind outright when the wire and the directory disagreed.
 *
 * MUST authenticate via SASL. The reconciliation lives in handle_account(),
 * which is the AC-*receiver* path: it runs only when the ircd completes SASL
 * itself against Keycloak and then announces the account to X3. Authenticating
 * with `AuthServ AUTH` instead goes through cmd_auth -> StampUser(), which makes
 * X3 the *sender* -- handle_account never runs and the test passes against
 * unfixed code.
 *
 * The divergence is created the way production acquired it: saxdb holds an older
 * date than the directory does. saxdb is edited directly rather than recreating
 * the directory entry, because that is the dormant-account case -- same
 * principal, stale local record -- and not name reuse.
 */
import { describe, it, expect, beforeAll } from 'vitest';
import { execSync } from 'node:child_process';
import * as fs from 'node:fs';
import { createX3Client, NICKSERV_NICK } from '../helpers/x3-client';
import { createRawSocketClient, RawSocketClient, uniqueId } from '../helpers/index.js';
import { authenticateSaslPlain } from '../helpers/sasl';

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

describe('account registration date survives authentication', () => {
  beforeAll(async () => {
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

    await flushSaxdb(ACCOUNT);                       // account must be on disk
    backdateRegister(ACCOUNT, OLD_REGISTER);
    await new Promise((r) => setTimeout(r, 15000));  // X3 relinks to the ircd
  }, 330_000);

  it('binds the handle even though saxdb disagrees with the directory', async () => {
    const client = await saslLogin(ACCOUNT, PASSWORD);
    const info = await ownAccountInfo(client);
    client.close();
    // A refused bind leaves the user +r on the ircd but unbound in X3, so
    // AuthServ reports no account rather than the handle's details.
    expect(
      info.some((l) => l.includes('Account Information')),
      `handle bind was refused: ${JSON.stringify(info)}`,
    ).toBe(true);
  }, 60_000);

  it('leaves the registration date untouched', async () => {
    const client = await saslLogin(ACCOUNT, PASSWORD);
    const info = await ownAccountInfo(client);
    client.close();
    // The bug overwrote this with the directory's createTimestamp (2026-xx).
    expect(parseRegisteredOn(info)).toBe(OLD_REGISTER);
  }, 60_000);
});
