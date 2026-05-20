import { describe, it, expect, afterEach } from 'vitest';
import { execSync } from 'node:child_process';
import {
  createRawSocketClient,
  RawSocketClient,
  PRIMARY_SERVER,
  uniqueNick,
  uniqueChannel,
  getTestAccount,
  releaseTestAccount,
} from '../helpers/index.js';
import {
  createBouncerClient,
  createSaslBouncerClient,
  bouncerDisableHold,
  disconnectAbruptly,
} from '../helpers/bouncer.js';

/**
 * Validates that a held bouncer session's CHANNEL MEMBERSHIPS survive
 * a container restart, via the FEAT_BOUNCER_PERSIST + bounce_db_restore
 * path.
 *
 * Reported observation 2026-05-19 (ibutsu): bouncer connections don't
 * retain channel memberships across container rebuilds as well as
 * expected.  bounce_snapshot_channels writes the live channel list into
 * the session on JOIN/PART/KICK/MODE (via bounce_mark_dirty) and the
 * periodic timer (FEAT_BOUNCER_PERSIST_INTERVAL, default 5s) commits
 * dirty sessions to MDBX.  On restart, bounce_db_restore replays via
 * bounce_restore_channels, adding the ghost back to each persisted
 * channel.  Then bounce_revive transplants the new socket onto the
 * ghost, so the resumed client inherits the channel set.
 *
 * If channels don't come back, the breakage is somewhere in that
 * chain — most likely the persist-on-disconnect path didn't fire, the
 * MDBX write got dropped, or the restore happened but revive lost
 * the membership transfer.
 *
 * Gated behind RUN_RESTART_TESTS=1 (calls `docker restart nefarious`
 * which knocks every other test off the server for ~10 seconds).
 */
const RUN = process.env.RUN_RESTART_TESTS === '1';

async function waitForNefariousReady(timeoutMs = 60_000): Promise<void> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    try {
      const status = execSync(
        "docker inspect -f '{{.State.Health.Status}}' nefarious",
        { encoding: 'utf8' }
      ).trim();
      if (status === 'healthy') {
        let probe: RawSocketClient | null = null;
        try {
          probe = await createRawSocketClient(PRIMARY_SERVER.host, PRIMARY_SERVER.port);
          await Promise.race([
            probe.capLs(),
            new Promise<never>((_, reject) =>
              setTimeout(() => reject(new Error('cap ls timeout')), 3000)),
          ]);
          probe.capEnd();
          probe.send('QUIT');
          probe.close();
          return;
        } catch {
          if (probe) probe.close();
        }
      }
    } catch { /* docker inspect failed; mid-restart */ }
    await new Promise(r => setTimeout(r, 500));
  }
  throw new Error(`nefarious did not become ready within ${timeoutMs}ms`);
}

(RUN ? describe : describe.skip)(
  'Bouncer channel memberships survive ircd restart',
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

    it('resumed session is auto-joined to the channels held before restart',
       async () => {
      const { account, password, fromPool } = await getTestAccount();
      if (fromPool) poolAccounts.push(account);

      // 1. Connect with bouncer hold, join a couple of unique channels.
      const requestedNick = uniqueNick('chresta');
      const channels = [
        uniqueChannel('chrestA'),
        uniqueChannel('chrestB'),
      ];
      const { client: first, nick: anchorNick } =
        await createBouncerClient(account, password, { nick: requestedNick });
      track(first);

      for (const c of channels) {
        first.send(`JOIN ${c}`);
        await first.waitForJoin(c, undefined, 10000);
      }

      // 2. Let the periodic persist fire — interval is 5s by default
      //    (FEAT_BOUNCER_PERSIST_INTERVAL).  Wait a comfortable 8s so the
      //    dirty flag set by JOIN's bounce_mark_dirty drives an actual
      //    MDBX write before we yank the container.
      await new Promise(r => setTimeout(r, 8000));

      // 3. Abrupt drop so the session transitions to HOLDING with the
      //    channels still attached to the ghost.
      disconnectAbruptly(first);
      clients.length = 0;
      await new Promise(r => setTimeout(r, 500));

      // 4. Restart nefarious — bounce_db_restore should run on startup,
      //    re-create the ghost, and re-join it to the persisted channels.
      execSync('docker restart nefarious', { encoding: 'utf8' });
      await waitForNefariousReady();
      // Wait for the cross-server burst convergence the bouncer holds
      // back 001 on; the same 35s pad as bouncer-oper-restart.
      await new Promise(r => setTimeout(r, 35000));

      // 5. Reconnect (SASL).  bounce_auto_resume should attach this
      //    socket to the restored ghost, which is already in the
      //    channels.
      const resumed = await createSaslBouncerClient(account, password, {
        nick: uniqueNick('chrest2'),
      });
      track(resumed.client);

      // Give the revive a moment to settle.
      await new Promise(r => setTimeout(r, 1500));

      // 6. Verify membership on each restored channel.  Query NAMES
      //    from a fresh observer (not the resumed client itself), so
      //    we test the *visible* network state, not just the client's
      //    own buffer.
      const observer = track(await createRawSocketClient());
      await observer.capLs();
      observer.capEnd();
      observer.register(uniqueNick('chrestobs'));
      await observer.waitForNumeric('001');

      for (const channel of channels) {
        observer.clearRawBuffer();
        observer.send(`NAMES ${channel}`);
        const nameLines: string[] = [];
        while (true) {
          const msg = await observer.waitForParsedLine(
            m => m.command === '353' || m.command === '366', 15000,
          );
          if (msg.command === '353') nameLines.push(msg.raw);
          else break;
        }
        const combined = nameLines.join(' ').toLowerCase();
        expect(
          combined,
          `After restart + resume, ${anchorNick} should still be in ${channel}; ` +
          `NAMES output: ${nameLines.join(' | ')}`,
        ).toContain(anchorNick.toLowerCase());
      }

      // 7. From the resumed client's view — channel routes also work
      //    (we can PRIVMSG into a restored channel, observer receives).
      observer.send(`JOIN ${channels[0]}`);
      await observer.waitForJoin(channels[0]);
      observer.clearRawBuffer();
      resumed.client.send(`PRIVMSG ${channels[0]} :restart-channel-test`);
      await observer.waitForParsedLine(
        m => m.command === 'PRIVMSG' && m.trailing?.includes('restart-channel-test') === true,
        15000,
      );

      await bouncerDisableHold(resumed.client);
    }, 180_000);
  }
);
