import { describe, it, expect, afterEach } from 'vitest';
import { execSync } from 'node:child_process';
import {
  RawSocketClient,
  createRawSocketClient,
  PRIMARY_SERVER,
  SECONDARY_SERVER,
  IRC_OPER,
  uniqueNick,
  getTestAccount,
  releaseTestAccount,
} from '../helpers/index.js';
import {
  createBouncerClient,
  createSaslBouncerClient,
  bouncerEnableHold,
  bouncerDisableHold,
  disconnectAbruptly,
} from '../helpers/bouncer.js';

/**
 * A bouncer session's Keycloak id (deferred-items C1, 2026-10-22).
 *
 * The session record did not keep the account's Keycloak id, so a ghost
 * restored from the database had none, and a session that began with an
 * X3 login (AC R carries no id) never got one: the rebind gate's id check
 * and X3's binding had nothing to compare.  The record keeps it now
 * (DB v12), and a ghost without one adopts the id of the SASL login that
 * revives it (user decision 2026-10-21).  A revive whose login carries a
 * DIFFERENT id is refused; that needs an account deleted and recreated
 * under the same name without the webhook ending the session first, which
 * the bed cannot stage -- `bounce_rebind_kc_conflict` is covered by cmocka.
 *
 * CHECK <nick> shows "Keycloak id:: <id>" for an account that has one.
 */

const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));
const RUN_RESTART = process.env.RUN_RESTART_TESTS === '1';
const ID = /Keycloak id::\s*([A-Za-z0-9_-]{22})\b/;

async function operClient(host = PRIMARY_SERVER.host, port = PRIMARY_SERVER.port): Promise<RawSocketClient> {
  const op = await createRawSocketClient(host, port);
  await op.capLs();
  op.capEnd();
  op.register(uniqueNick('kcop'));
  await op.waitForNumeric('001');
  await sleep(300);
  op.send(`OPER ${IRC_OPER.name} ${IRC_OPER.password}`);
  await op.waitForNumeric('381', 5000);
  return op;
}

/** The Keycloak id CHECK reports for @a nick on @a op's server, or null. */
async function checkId(op: RawSocketClient, nick: string): Promise<string | null> {
  const mark = op.allParsedLines.length;
  op.send(`CHECK ${nick}`);
  const end = Date.now() + 6000;
  while (Date.now() < end) {
    const lines = op.allParsedLines.slice(mark);
    const hit = lines.map(m => m.params[m.params.length - 1] ?? '').find(t => ID.test(t));
    if (hit)
      return ID.exec(hit)![1];
    if (lines.some(m => m.command === '291'))   // end of CHECK
      return null;
    await sleep(100);
  }
  return null;
}

async function waitForNefariousReady(timeoutMs = 60_000): Promise<void> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    try {
      const status = execSync("docker inspect -f '{{.State.Health.Status}}' nefarious",
        { encoding: 'utf8' }).trim();
      if (status === 'healthy') {
        let probe: RawSocketClient | null = null;
        try {
          probe = await createRawSocketClient(PRIMARY_SERVER.host, PRIMARY_SERVER.port);
          await Promise.race([
            probe.capLs(),
            new Promise<never>((_, reject) => setTimeout(() => reject(new Error('cap ls timeout')), 3000)),
          ]);
          probe.capEnd();
          probe.send('QUIT');
          probe.close();
          return;
        } catch {
          if (probe) probe.close();
        }
      }
    } catch { /* mid-restart */ }
    await sleep(1000);
  }
  throw new Error('nefarious did not come back');
}

describe('Bouncer session Keycloak id', () => {
  const clients: RawSocketClient[] = [];
  const poolAccounts: string[] = [];
  const track = <T extends RawSocketClient>(c: T): T => { clients.push(c); return c; };

  afterEach(async () => {
    for (const c of clients) { try { c.close(); } catch { /* */ } }
    clients.length = 0;
    for (const a of poolAccounts) releaseTestAccount(a);
    poolAccounts.length = 0;
  });

  it('a SASL login\'s id is known on both servers', async () => {
    const { account, password, fromPool } = await getTestAccount();
    if (fromPool) poolAccounts.push(account);
    const { client, nick } = await createBouncerClient(account, password, { nick: uniqueNick('kcs') });
    track(client);
    const op = track(await operClient());
    const leafOp = track(await operClient(SECONDARY_SERVER.host, SECONDARY_SERVER.port));
    await sleep(1000);

    const here = await checkId(op, nick);
    expect(here, 'the hub knows the login\'s Keycloak id').not.toBeNull();
    expect(await checkId(leafOp, nick), 'the leaf knows the same id').toBe(here);

    await bouncerDisableHold(client);
    client.send('QUIT');
  }, 60_000);

  it('a session that began with an X3 login adopts the id of the SASL login that revives it', async () => {
    const { account, password, fromPool } = await getTestAccount();
    if (fromPool) poolAccounts.push(account);

    // Log in through AuthServ: AC R carries no Keycloak id.
    const first = track(await createRawSocketClient());
    await first.capLs();
    first.capEnd();
    const nick = uniqueNick('kcx');
    first.register(nick);
    await first.waitForNumeric('001');
    await sleep(500);
    first.send(`PRIVMSG AuthServ :AUTH ${account} ${password}`);
    await first.waitForParsedLine(m => m.command === 'NOTICE'
      && /recogni[sz]e you|now identified|authenticated/i.test(m.params[1] ?? ''), 15_000);
    await sleep(1000);
    await bouncerEnableHold(first);

    const op = track(await operClient());
    expect(await checkId(op, nick), 'setup: an X3 login gives the session no Keycloak id').toBeNull();

    disconnectAbruptly(first);
    await sleep(2500);

    const back = await createSaslBouncerClient(account, password, { nick: uniqueNick('kcxb') });
    track(back.client);
    expect(back.nick, 'setup: the SASL login revived the held session').toBe(nick);
    await sleep(1000);

    expect(await checkId(op, nick), 'the revived session carries the login\'s Keycloak id').not.toBeNull();

    await bouncerDisableHold(back.client);
    back.client.send('QUIT');
  }, 90_000);

  (RUN_RESTART ? it : it.skip)('a session restored after an ircd restart keeps its Keycloak id', async () => {
    const { account, password, fromPool } = await getTestAccount();
    if (fromPool) poolAccounts.push(account);
    const { client: first, nick } = await createBouncerClient(account, password, { nick: uniqueNick('kcr') });
    track(first);
    let op = await operClient();
    const before = await checkId(op, nick);
    op.close();
    expect(before, 'setup: the session has an id').not.toBeNull();
    // Let the dirty-persist timer write the record.
    await sleep(3000);
    disconnectAbruptly(first);
    await sleep(1500);

    execSync('docker restart nefarious', { encoding: 'utf8' });
    await waitForNefariousReady();
    // The bouncer holds 001 back until burst convergence settles.
    await sleep(35_000);

    op = track(await operClient());
    expect(await checkId(op, nick), 'the restored ghost has the id from its record').toBe(before);

    const back = await createSaslBouncerClient(account, password, { nick: uniqueNick('kcr2') });
    track(back.client);
    expect(back.nick, 'setup: the reconnect revived the restored session').toBe(nick);
    await bouncerDisableHold(back.client);
    back.client.send('QUIT');
  }, 180_000);
});
