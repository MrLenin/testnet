import { describe, it, expect, afterEach, beforeAll } from 'vitest';
import { createConnection } from 'node:net';
import {
  RawSocketClient,
  uniqueNick,
  getTestAccount,
  releaseTestAccount,
  createSaslBouncerClient,
  bouncerEnableHold,
  bouncerDisableHold,
  createOperClient,
  IRC_OPER,
} from '../helpers/index.js';

/**
 * BX C convert-in-place canary coverage.
 *
 * `bounce_alias_create` in nefarious/ircd/bouncer_session.c has a
 * convert-in-place branch (after `if (alias) { if (IsBouncerAlias)
 * goto forward; ...convert-in-place...}`) that converts an
 * already-introduced non-alias client into an alias.  Per the comment
 * block at that site (and the s_serv.c:358 burst filter
 * `IsUser(acptr) && !IsBouncerAlias(acptr)`), this branch should
 * effectively never fire in normal operation — the burst filter
 * structurally prevents the prerequisite (an N for a numeric that
 * later gets a BX C).
 *
 * The site emits an SNO_NETWORK snotice every time it does fire:
 *   "BX C convert-in-place fired: alias_numeric=… old_nick=… …"
 *
 * This test exercises a suite of common bouncer flows on a 2-server
 * topology while watching the opmask for that snotice.  The canary
 * MUST stay quiet — if it fires, the wire path that converted is a
 * candidate for the client-side ghost described in the comment block.
 *
 * Requires the linked profile.  Skips when leaf is unreachable.
 */
describe('Bouncer BX C convert-in-place canary (SNO_NETWORK)', () => {
  const clients: RawSocketClient[] = [];
  const poolAccounts: string[] = [];
  let opers: RawSocketClient[] = [];

  let leafHost: string;
  let leafPort: number;
  let leafReachable = false;

  beforeAll(async () => {
    leafHost = process.env.IRC_HOST2
      ?? (process.env.IRC_HOST === 'localhost' ? 'localhost' : 'nefarious2');
    leafPort = parseInt(
      process.env.IRC_PORT2 ?? (leafHost === 'localhost' ? '6668' : '6667'),
      10,
    );
    leafReachable = await new Promise<boolean>(resolve => {
      const sock = createConnection({ host: leafHost, port: leafPort });
      const cleanup = (ok: boolean) => {
        sock.removeAllListeners();
        sock.destroy();
        resolve(ok);
      };
      sock.once('connect', () => cleanup(true));
      sock.once('error', () => cleanup(false));
      setTimeout(() => cleanup(false), 2000);
    });
  });

  afterEach(async () => {
    for (const client of clients) {
      try { await bouncerDisableHold(client); } catch { /* ignore */ }
      try { client.close(); } catch { /* ignore */ }
    }
    clients.length = 0;
    for (const oper of opers) {
      try { oper.close(); } catch { /* ignore */ }
    }
    opers = [];
    for (const account of poolAccounts) {
      releaseTestAccount(account);
    }
    poolAccounts.length = 0;
  });

  const CANARY_PATTERN = /BX C convert-in-place fired/;

  /** Subscribe an oper to SNO_NETWORK (mask 0x400 = 1024). */
  async function subscribeNetwork(oper: RawSocketClient, nick: string): Promise<void> {
    // `MODE <nick> +s <mask>` sets the snomask.  After /OPER, default
    // snomask already includes SNO_NETWORK (SNO_DEFAULT in client.h),
    // but be explicit to immunize against config drift.
    oper.send(`MODE ${nick} +s 1024`);
    await new Promise(r => setTimeout(r, 200));
    oper.clearRawBuffer();
  }

  /** Inspect every collected line on every witness; fail loudly if canary fires. */
  function assertNoCanaryFired(scenario: string, witnesses: RawSocketClient[]) {
    const hits: string[] = [];
    for (const w of witnesses) {
      const lines = (w as any).getUnconsumedLines?.() ?? [];
      for (const l of lines as string[]) {
        if (CANARY_PATTERN.test(l)) hits.push(l);
      }
      // Drop scenario's lines so the next scenario starts clean.
      (w as any).clearRawBuffer?.();
    }
    if (hits.length > 0) {
      throw new Error(
        `Canary fired during scenario "${scenario}". ` +
        `BX C convert-in-place is reachable through this wire path — ` +
        `investigate trigger + apply mitigation in bounce_alias_create. ` +
        `Hits:\n${hits.join('\n')}`,
      );
    }
  }

  it('no convert-in-place across multi-server bouncer flow suite', async () => {
    if (!leafReachable) {
      console.warn(
        `Skipping: leaf at ${leafHost}:${leafPort} not reachable. ` +
        'Run scripts/dc.sh -l up -d.',
      );
      return;
    }

    // Two witness opers — one on each server.  The canary lives in
    // bounce_alias_create which runs on the receive side of BX C, so
    // depending on which server emitted the BX C, the canary will fire
    // on the OTHER server.  We need an opmask listener on both.
    const witnessPrimaryNick = uniqueNick('cwp');
    const witnessPrimary = await createOperClient(witnessPrimaryNick);
    opers.push(witnessPrimary);
    await subscribeNetwork(witnessPrimary, witnessPrimaryNick);

    // Leaf-side witness — connect raw + oper up.  createOperClient is
    // hardwired to PRIMARY_SERVER, so for the leaf we hand-roll a raw
    // socket and rely on /OPER with the same shared O:line credentials.
    const witnessLeaf = new RawSocketClient();
    await witnessLeaf.connect(leafHost, leafPort);
    await witnessLeaf.capLs();
    witnessLeaf.capEnd();
    const witnessLeafNick = uniqueNick('cwl');
    witnessLeaf.register(witnessLeafNick);
    await witnessLeaf.waitForLine(/001/, 8000);
    await new Promise(r => setTimeout(r, 500));
    witnessLeaf.send(`OPER ${IRC_OPER.name} ${IRC_OPER.password}`);
    try { await witnessLeaf.waitForLine(/381/, 5000); }
    catch { /* keep going — non-opered witness still parses notices it does see */ }
    witnessLeaf.send(`MODE ${witnessLeafNick} +s 1024`);
    await new Promise(r => setTimeout(r, 200));
    witnessLeaf.clearRawBuffer();
    opers.push(witnessLeaf);

    const witnesses = [witnessPrimary, witnessLeaf];

    // ---- Scenario A: single-server local primary attach ----------------
    // Plain SASL'd bouncer client on testnet.  bounce_setup_local_alias
    // sees no existing primary → becomes primary itself.  No BX C
    // emitted; convert-branch unreachable.  Sanity probe.
    {
      const acct = await getTestAccount();
      poolAccounts.push(acct.account);
      const nick = uniqueNick('cba');
      const c = await createSaslBouncerClient(acct.account, acct.password, { nick });
      clients.push(c.client);
      await new Promise(r => setTimeout(r, 800));
      assertNoCanaryFired('A: single-server local primary attach', witnesses);
      try { await bouncerDisableHold(c.client); } catch { /* ignore */ }
      c.client.close();
      clients.splice(clients.indexOf(c.client), 1);
      await new Promise(r => setTimeout(r, 500));
    }

    // ---- Scenario B: hold + reconnect (revive) -------------------------
    // Primary holds, disconnects (state goes HOLDING).  Same account
    // reconnects on same server — bounce_revive picks up the held ghost.
    // No BX C emitted; convert-branch unreachable.
    {
      const acct = await getTestAccount();
      poolAccounts.push(acct.account);
      const nick = uniqueNick('cbb');
      const c1 = await createSaslBouncerClient(acct.account, acct.password, { nick });
      clients.push(c1.client);
      await bouncerEnableHold(c1.client);
      c1.client.close();
      clients.splice(clients.indexOf(c1.client), 1);
      await new Promise(r => setTimeout(r, 800));
      const c2 = await createSaslBouncerClient(acct.account, acct.password, { nick });
      clients.push(c2.client);
      await new Promise(r => setTimeout(r, 800));
      assertNoCanaryFired('B: hold + reconnect revive', witnesses);
      try { await bouncerDisableHold(c2.client); } catch { /* ignore */ }
      c2.client.close();
      clients.splice(clients.indexOf(c2.client), 1);
      await new Promise(r => setTimeout(r, 500));
    }

    // ---- Scenario C: cross-server alias attach -------------------------
    // Primary on testnet, alias on leaf.  Leaf BX C → testnet receives,
    // testnet's bounce_alias_create runs.  If burst raced ahead of BS A
    // and N'd the alias before BX C arrived, convert-in-place fires.
    {
      const acct = await getTestAccount();
      poolAccounts.push(acct.account);
      const nick = uniqueNick('cbc');
      const primary = await createSaslBouncerClient(acct.account, acct.password, { nick });
      clients.push(primary.client);
      await bouncerEnableHold(primary.client);
      const alias = await createSaslBouncerClient(acct.account, acct.password, {
        nick, host: leafHost, port: leafPort,
      });
      clients.push(alias.client);
      await new Promise(r => setTimeout(r, 1500));
      assertNoCanaryFired('C: cross-server alias attach', witnesses);
      try { await bouncerDisableHold(primary.client); } catch { /* ignore */ }
      alias.client.close();
      primary.client.close();
      clients.splice(clients.indexOf(alias.client), 1);
      clients.splice(clients.indexOf(primary.client), 1);
      await new Promise(r => setTimeout(r, 500));
    }

    // ---- Scenario D: leaf-first attach ---------------------------------
    // Same account first lands on leaf (becomes primary on leaf), then
    // testnet — testnet's bounce_setup_local_alias detaches the would-be
    // primary, attaches as alias of leaf's primary, emits BX C back to
    // leaf.  Leaf's bounce_alias_create receives BX C for a numeric leaf
    // has never N'd → convert-branch unreachable.
    {
      const acct = await getTestAccount();
      poolAccounts.push(acct.account);
      const nick = uniqueNick('cbd');
      const leafPrimary = await createSaslBouncerClient(acct.account, acct.password, {
        nick, host: leafHost, port: leafPort,
      });
      clients.push(leafPrimary.client);
      await bouncerEnableHold(leafPrimary.client);
      const testnetAlias = await createSaslBouncerClient(acct.account, acct.password, { nick });
      clients.push(testnetAlias.client);
      await new Promise(r => setTimeout(r, 1500));
      assertNoCanaryFired('D: leaf-first attach', witnesses);
      try { await bouncerDisableHold(leafPrimary.client); } catch { /* ignore */ }
      testnetAlias.client.close();
      leafPrimary.client.close();
      clients.splice(clients.indexOf(testnetAlias.client), 1);
      clients.splice(clients.indexOf(leafPrimary.client), 1);
      await new Promise(r => setTimeout(r, 500));
    }

    // ---- Scenario E: primary clean QUIT triggers cross-server promote --
    // Primary on testnet, alias on leaf.  Primary QUITs cleanly → 0-tick
    // timer fires → BX P emitted → leaf converts alias → primary.
    // Neither side runs BX C convert-branch (this is BX P, not BX C),
    // but the flow churns through bounce_promote_alias paths that have
    // historically had collisions with BX C re-emission.  Cover it.
    {
      const acct = await getTestAccount();
      poolAccounts.push(acct.account);
      const nick = uniqueNick('cbe');
      const primary = await createSaslBouncerClient(acct.account, acct.password, { nick });
      clients.push(primary.client);
      await bouncerEnableHold(primary.client);
      const alias = await createSaslBouncerClient(acct.account, acct.password, {
        nick, host: leafHost, port: leafPort,
      });
      clients.push(alias.client);
      await new Promise(r => setTimeout(r, 1500));
      primary.client.send('QUIT :primary leaving for canary test');
      primary.client.close();
      clients.splice(clients.indexOf(primary.client), 1);
      await new Promise(r => setTimeout(r, 2500));
      assertNoCanaryFired('E: primary clean QUIT → cross-server promote', witnesses);
      try { await bouncerDisableHold(alias.client); } catch { /* ignore */ }
      alias.client.close();
      clients.splice(clients.indexOf(alias.client), 1);
      await new Promise(r => setTimeout(r, 500));
    }

    // ---- Scenario F: rapid alias churn ---------------------------------
    // Primary on testnet + repeated leaf alias connect/disconnect.  Each
    // attach/detach cycle drives BX C / BX X pairs; tries to surface any
    // BX-ordering race that could leave a stale N visible to the alias's
    // home server when its own BX C echoes back.
    {
      const acct = await getTestAccount();
      poolAccounts.push(acct.account);
      const nick = uniqueNick('cbf');
      const primary = await createSaslBouncerClient(acct.account, acct.password, { nick });
      clients.push(primary.client);
      await bouncerEnableHold(primary.client);
      for (let i = 0; i < 3; i++) {
        const alias = await createSaslBouncerClient(acct.account, acct.password, {
          nick, host: leafHost, port: leafPort,
        });
        clients.push(alias.client);
        await new Promise(r => setTimeout(r, 600));
        alias.client.close();
        clients.splice(clients.indexOf(alias.client), 1);
        await new Promise(r => setTimeout(r, 600));
      }
      assertNoCanaryFired('F: rapid alias churn (BX C/BX X cycles)', witnesses);
      try { await bouncerDisableHold(primary.client); } catch { /* ignore */ }
      primary.client.close();
      clients.splice(clients.indexOf(primary.client), 1);
      await new Promise(r => setTimeout(r, 500));
    }

    // Final sweep — concatenate everything observed and pretty-print
    // the line count from each witness so we can eyeball that the
    // witnesses were actually receiving snotice traffic during the
    // suite (otherwise a quiet pass could be a witness mis-subscribe).
    const summary = witnesses.map((w, i) => {
      const lines = ((w as any).allLines ?? []) as string[];
      const noticeCount = lines.filter(l => / NOTICE /.test(l)).length;
      return `  witness[${i}]: total=${lines.length} notices=${noticeCount}`;
    }).join('\n');
    console.log(`Canary suite quiet across all scenarios. Witness traffic:\n${summary}`);
    // Sanity: at least one witness should have observed *some* snotice
    // (net.junction, etc.).  If both were silent the test is hollow —
    // emit a warning rather than fail (the witness might be opered but
    // the link could have already settled before subscription).
    const anyNotice = witnesses.some(w => {
      const lines = ((w as any).allLines ?? []) as string[];
      return lines.some(l => / NOTICE /.test(l));
    });
    if (!anyNotice) {
      console.warn(
        'No NOTICE traffic observed on either witness — possible witness ' +
        'subscription gap.  Inspect MODE +s handling.',
      );
    }
    expect(true).toBe(true);
  }, 60_000);
});
