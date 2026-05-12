import { describe, it, expect, afterEach } from 'vitest';
import { execSync } from 'node:child_process';
import {
  createRawSocketClient,
  RawSocketClient,
  PRIMARY_SERVER,
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
} from '../helpers/bouncer.js';

/**
 * Restart-survival test for session-anchored oper grants (commit
 * 5a1ce20).  The grant is persisted on BounceSessionRecord
 * (bsr_oper_name + bsr_oper_granted_at, v9 format); when MDBX is
 * reloaded on startup, bounce_create_ghost calls
 * bounce_apply_oper_grant against the ghost, re-attaching the local
 * O:line privileges so the resumed connection comes back opered
 * without an explicit /OPER.
 *
 * This file is gated behind RUN_RESTART_TESTS=1 because it calls
 * `docker restart nefarious`, which would knock every other test off
 * the server for ~10 seconds.  Run explicitly:
 *
 *   RUN_RESTART_TESTS=1 IRC_HOST=localhost npm test -- \
 *     src/ircv3/bouncer-oper-restart.test.ts
 *
 */

const RUN = process.env.RUN_RESTART_TESTS === '1';

/** Wait until the nefarious container's healthcheck reports healthy
 * AND we can complete a CAP LS handshake.  Docker's healthcheck alone
 * sometimes flips to healthy a beat before the listener accepts. */
async function waitForNefariousReady(timeoutMs = 60_000): Promise<void> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    try {
      const status = execSync(
        "docker inspect -f '{{.State.Health.Status}}' nefarious",
        { encoding: 'utf8' }
      ).trim();
      if (status === 'healthy') {
        // Try a probe connect; if CAP LS comes back we're good.  Race
        // the CAP LS against a wall-clock timeout so a half-up server
        // (TCP accepts but doesn't speak) doesn't hang us forever.
        let probe: RawSocketClient | null = null;
        try {
          probe = await createRawSocketClient(
            PRIMARY_SERVER.host, PRIMARY_SERVER.port
          );
          await Promise.race([
            probe.capLs(),
            new Promise<never>((_, reject) =>
              setTimeout(() => reject(new Error('cap ls timeout')), 3000)
            ),
          ]);
          probe.capEnd();
          probe.send('QUIT');
          probe.close();
          return;
        } catch {
          if (probe) probe.close();
        }
      }
    } catch {
      // docker inspect failed; container may be mid-restart
    }
    await new Promise(r => setTimeout(r, 500));
  }
  throw new Error(`nefarious did not become ready within ${timeoutMs}ms`);
}

/** Send WHOIS for @a target and return true iff the reply included
 * RPL_WHOISOPERATOR (313).  Stops on 318 (end of whois). */
async function whoisIsOper(
  observer: RawSocketClient, target: string, timeoutMs = 5000,
): Promise<boolean> {
  observer.clearRawBuffer();
  observer.send(`WHOIS ${target}`);
  let sawOper = false;
  try {
    await observer.waitForParsedLine(
      m => {
        if (m.command === '313') { sawOper = true; return true; }
        return m.command === '318';
      },
      timeoutMs,
    );
  } catch { /* timeout — sawOper stays false */ }
  return sawOper;
}

(RUN ? describe : describe.skip)(
  'Bouncer oper grant survives ircd restart (Phase G)',
  () => {
    const clients: RawSocketClient[] = [];
    const poolAccounts: string[] = [];

    const track = <T extends RawSocketClient>(c: T): T => { clients.push(c); return c; };

    afterEach(async () => {
      for (const c of clients) {
        try { c.close(); } catch { /* */ }
      }
      clients.length = 0;
      for (const a of poolAccounts) releaseTestAccount(a);
      poolAccounts.length = 0;
    });

    it('resumed session is opered automatically after `docker restart nefarious`',
       async () => {
      // 1) Get a pool account, attach with bouncer hold so the session
      //    survives the disconnect we're about to inflict.
      const { account, password, fromPool } = await getTestAccount();
      if (fromPool) poolAccounts.push(account);

      const { client: primary, nick } = await createBouncerClient(account, password, {
        nick: uniqueNick('opres'),
      });
      track(primary);

      // 2) /OPER on the primary.  The grant is recorded on the session
      //    via bounce_apply_oper_grant; on next persistence cycle it
      //    lands in bsr_oper_name in the MDBX record.
      primary.clearRawBuffer();
      primary.send(`OPER ${IRC_OPER.name} ${IRC_OPER.password}`);
      await primary.waitForNumeric('381', 5000);   // RPL_YOUREOPER

      // 3) Sanity-check oper bit is observable via WHOIS before restart.
      //    Uses a separate observer so we don't interfere with primary's
      //    buffer.
      {
        const obs = track(await createRawSocketClient());
        await obs.capLs();
        obs.capEnd();
        obs.register(uniqueNick('opobs'));
        await obs.waitForNumeric('001');
        const preOpered = await whoisIsOper(obs, nick);
        expect(preOpered,
          'baseline: WHOIS should report oper before restart').toBe(true);
        obs.send('QUIT');
      }

      // 4) Disconnect primary so the session goes into BOUNCE_HOLDING
      //    state.  The hold timer is FEAT_BOUNCER_SESSION_HOLD seconds
      //    (4h in our config), which is plenty for the persistence
      //    write to land before we kick the server.
      primary.close();
      clients.length = 0;
      await new Promise(r => setTimeout(r, 500));

      // 5) Restart nefarious.  bounce_db_restore runs at startup, loads
      //    every persisted BounceSessionRecord, creates ghosts, and
      //    fires bounce_apply_oper_grant for records with non-empty
      //    bsr_oper_name.
      execSync('docker restart nefarious', { encoding: 'utf8' });
      await waitForNefariousReady();
      // x3 reconnects on its own (max_cycles=0, max_tries=0 in x3.conf
      // mean it cycles uplinks forever).  We also have to wait for the
      // *bouncer registration deferral* — the bouncer holds back 001
      // for reconnecting clients until inter-server burst convergence
      // settles, which can take up to 30s in practice.  Without this
      // pause the resumed client times out on registration.
      await new Promise(r => setTimeout(r, 35000));

      // 5b) Diagnostic: WHOIS the GHOST (still in HOLDING after restore)
      //     before anyone has revived it.  If 313 appears here, the
      //     persistence + restore path worked and a remaining failure
      //     must be in revive.  If it doesn't appear, the persist or
      //     restore path is the suspect.
      {
        const ghostObs = track(await createRawSocketClient());
        await ghostObs.capLs();
        ghostObs.capEnd();
        ghostObs.register(uniqueNick('ghobs'));
        await ghostObs.waitForNumeric('001');
        await whoisIsOper(ghostObs, nick);
        // Result intentionally not asserted — informational only.
        // bounce_apply_oper_grant fires during MDBX restore but the
        // visibility-via-WHOIS check is the same load-bearing assertion
        // we make post-revive below.  Captured here for log scraping
        // when debugging.
        ghostObs.send('QUIT');
      }

      // 6) Reconnect with the same account.  bounce_auto_resume sees
      //    the held ghost and revives it (transplants the new socket
      //    onto the ghost, which already carries IsOper from the
      //    persisted grant).  We do NOT send /OPER.
      const resumed = await createSaslBouncerClient(account, password, {
        nick: uniqueNick('opres2'),
      });
      track(resumed.client);

      // 7) Verify the resumed connection is opered without us having
      //    sent /OPER this session.  WHOIS the canonical nick from a
      //    fresh observer and look for RPL_WHOISOPERATOR (313).
      const obs2 = track(await createRawSocketClient());
      await obs2.capLs();
      obs2.capEnd();
      obs2.register(uniqueNick('opobs2'));
      await obs2.waitForNumeric('001');

      const postOpered = await whoisIsOper(obs2, resumed.nick);
      expect(postOpered,
        'After ircd restart + bouncer resume, the revived session must be '
        + 'opered automatically — bsr_oper_name persistence + '
        + 'bounce_apply_oper_grant during MDBX restore should re-attach '
        + 'O:line privileges without requiring a fresh /OPER.'
      ).toBe(true);

      // Cleanup: drop hold so pool account doesn't carry hs_oper_grant
      // into the next test that recycles it.
      resumed.client.send('MODE ' + resumed.nick + ' -o');
      await new Promise(r => setTimeout(r, 200));
      await bouncerDisableHold(resumed.client);
    }, 180_000);

    it('grant clears post-restart if /DEOPER ran before disconnect',
       async () => {
      // Inverse case: confirm we're not just always re-opering.  /OPER,
      // then /MODE -o, then disconnect, restart, resume — should NOT
      // be opered.  This is the load-bearing safety check.
      const { account, password, fromPool } = await getTestAccount();
      if (fromPool) poolAccounts.push(account);

      const { client: primary, nick } = await createBouncerClient(account, password, {
        nick: uniqueNick('opnar'),
      });
      track(primary);

      primary.send(`OPER ${IRC_OPER.name} ${IRC_OPER.password}`);
      await primary.waitForNumeric('381', 5000);
      await new Promise(r => setTimeout(r, 200));

      // Drop oper on the same connection.  bounce_sync_session_umodes
      // should clear hs_oper_name on the session.
      primary.send(`MODE ${nick} -o`);
      await new Promise(r => setTimeout(r, 300));

      primary.close();
      clients.length = 0;
      await new Promise(r => setTimeout(r, 500));

      execSync('docker restart nefarious', { encoding: 'utf8' });
      await waitForNefariousReady();
      // x3 reconnects on its own (max_cycles=0, max_tries=0 in x3.conf
      // mean it cycles uplinks forever).  We also have to wait for the
      // *bouncer registration deferral* — the bouncer holds back 001
      // for reconnecting clients until inter-server burst convergence
      // settles, which can take up to 30s in practice.  Without this
      // pause the resumed client times out on registration.
      await new Promise(r => setTimeout(r, 35000));

      const resumed = await createSaslBouncerClient(account, password, {
        nick: uniqueNick('opnar2'),
      });
      track(resumed.client);

      const obs = track(await createRawSocketClient());
      await obs.capLs();
      obs.capEnd();
      obs.register(uniqueNick('opnaobs'));
      await obs.waitForNumeric('001');

      const opered = await whoisIsOper(obs, resumed.nick);
      expect(opered,
        'After /DEOPER + restart + resume, the session must NOT be opered '
        + '— hs_oper_name should have been cleared by the deop, so the '
        + 'persisted record has an empty bsr_oper_name and '
        + 'bounce_apply_oper_grant short-circuits on restore.'
      ).toBe(false);

      await bouncerDisableHold(resumed.client);
    }, 180_000);
  }
);
