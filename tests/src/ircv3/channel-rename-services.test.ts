import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import {
  X3Client,
  PRIMARY_SERVER,
  uniqueChannel,
  uniqueId,
  getTestAccount,
  releaseTestAccount,
  waitForChannelMode,
  X3_ADMIN,
} from '../helpers/index.js';

/**
 * Services-Arbitrated Channel Rename E2E (draft/channel-rename + X3 AC R query)
 *
 * Exercises RENAME on a REGISTERED (+R) channel, which nefarious forwards to
 * X3 as `AC <unum> R <cookie> <#chan> RENAME <newname>` and X3 answers with
 * `AC <cookie> A` (allow) or `AC <cookie> D :<reason>` (deny). Design doc:
 * .claude/para/projects/x3-channel-rename-impl-plan.md (§3/§4/§5).
 *
 * LIVE-BED FACTS THIS SUITE DEPENDS ON (verified 2026-07-31 against this
 * deployment — nef1 + x3 only, nefarious2 deliberately stopped):
 *  - The channel service bot's live nick is **X3**, not ChanServ. x3-client.ts's
 *    higher-level helpers (registerChannel/addUser/getAccess/unregisterChannel/
 *    etc.) hardcode 'ChanServ' and do NOT work against this bed's bot, so this
 *    file talks to X3 with raw serviceCmd()/send() calls instead of those
 *    helpers. (The container's live x3.conf is generated in-image from
 *    x3.conf-dist + X3_* env vars per docker-compose.yml — the checked-in
 *    data/x3.conf with nick "ChanServ" is NOT what the container runs.) This
 *    is worth folding into x3-client.ts / the x3-services skill later; out of
 *    scope for this suite.
 *  - testadmin (X3_ADMIN) has max_owned=2. This suite is written to hold at
 *    most one testadmin-owned channel at a time (a second, transient one is
 *    registered+unregistered within a single test for the name-collision
 *    case), and cleans up defensively in beforeAll/afterAll so a crashed
 *    prior run can't strand this run under the cap.
 *
 * TOPOLOGY GUARD (see nefarious/ircd/m_rename.c rename_legacy_blocker()):
 * RENAME refuses outright — for BOTH registered and unregistered channels —
 * while any non-IRCv3-aware, non-service server is linked to the network
 * (`FAIL RENAME CANNOT_RENAME <chan> :A linked server does not support
 * channel rename`). On this testbed that depends on which servers are up
 * when the suite runs. We cannot know at module-load time which topology is
 * live, and describe.skipIf/test.skipIf evaluate at module load (see
 * project_vitest_skipif_timing_bug.md) — so skipping there would be wrong.
 * Instead, case 1 (the first rename attempt) detects the guard at RUNTIME and
 * sets `legacyBlocked`; every later case that depends on a rename actually
 * completing checks that flag first and early-returns with a logged skip
 * rather than asserting anything about arbitration it never got to exercise.
 * Case 3 (rename onto a name that is already registered) is NOT guarded by
 * this flag: a registered channel's ChanServ presence keeps it "live" on the
 * ircd, so nefarious's own `FindChannel(newname)` check rejects the rename
 * with CHANNEL_NAME_IN_USE before the legacy-topology guard even runs.
 */

const X3_SERVICE = 'X3';
const X3_TIMEOUT = 15000;
const RENAME_WAIT = 15000; // server-side AC round trip times out at 10s

let legacyBlocked = false;
let legacyBlockedKnown = false;

async function connectRenameClient(nick: string): Promise<X3Client> {
  const client = new X3Client();
  await client.connect(PRIMARY_SERVER.host, PRIMARY_SERVER.port);
  await client.capLs();
  await client.capReq(['draft/channel-rename', 'standard-replies']);
  client.capEnd();
  client.register(nick);
  await client.waitForNumeric('001');
  // Let post-001 welcome traffic (host-hiding NOTICE/MODE, PM-history notice) settle.
  await new Promise((r) => setTimeout(r, 1000));
  client.clearRawBuffer();
  return client;
}

/** Register a channel via X3 (bot nick X3, not ChanServ — see header comment). */
async function registerChannelX3(
  client: X3Client,
  channel: string
): Promise<{ success: boolean; lines: string[] }> {
  client.clearRawBuffer();
  client.send(`PRIVMSG ${X3_SERVICE} :REGISTER ${channel}`);

  const lines: string[] = [];
  let success = false;
  const start = Date.now();

  while (Date.now() - start < X3_TIMEOUT) {
    try {
      const line = await client.waitForLine(
        new RegExp(`${X3_SERVICE}.*(JOIN|NOTICE)`, 'i'),
        Math.min(3000, X3_TIMEOUT - (Date.now() - start))
      );

      if (line.includes(X3_SERVICE) && / JOIN /.test(line)) {
        success = true;
        lines.push(line);
        break;
      }

      if (line.includes(X3_SERVICE) && /NOTICE/.test(line)) {
        lines.push(line);
        const lower = line.toLowerCase();
        if (
          lower.includes('already registered') ||
          lower.includes('must be opped') ||
          lower.includes('not authenticated') ||
          lower.includes('access denied') ||
          lower.includes('illegal channel') ||
          lower.includes('only network staff')
        ) {
          break;
        }
        if (lower.includes('register')) {
          success = true;
          break;
        }
      }
    } catch {
      break;
    }
  }

  return { success, lines };
}

/** Unregister a channel via X3, handling the two-step confirmation code flow. */
async function unregisterChannelX3(client: X3Client, channel: string): Promise<void> {
  const lines1 = await client.serviceCmd(X3_SERVICE, `UNREGISTER ${channel}`, X3_TIMEOUT);
  // The confirmation line is "...you must use 'unregister #chan CODE'." —
  // note there's no space between CODE and the closing quote+period, so a
  // trailing \S+ greedily swallows "'." into the captured code. Confirm
  // codes are hex hashes; match only hex chars to avoid that.
  const confirmLine = lines1.find((l) => /unregister\s+\S+\s+[0-9a-f]+/i.test(l));
  if (!confirmLine) return;
  const m = confirmLine.match(/unregister\s+(\S+)\s+([0-9a-f]+)/i);
  if (!m) return;
  await client.serviceCmd(X3_SERVICE, `UNREGISTER ${m[1]} ${m[2]}`, X3_TIMEOUT);
}

/**
 * Defensive cleanup: unregister every channel testadmin currently OWNS
 * (per AuthServ ACCOUNTINFO's "Channel(s): Owner:#foo CoOwner:#bar ..."
 * line). Guards against a crashed prior run stranding this run at
 * max_owned=2 even though this run's channel names are always fresh
 * (uniqueChannel()).
 */
async function cleanupOwnedChannels(client: X3Client): Promise<void> {
  const lines = await client.serviceCmd('AuthServ', 'ACCOUNTINFO', X3_TIMEOUT);
  const chanLine = lines.find((l) => /Channel\(s\):/i.test(l));
  if (!chanLine) return;
  const owned = [...chanLine.matchAll(/Owner:(#\S+)/gi)].map((m) => m[1]);
  for (const chan of owned) {
    try {
      await unregisterChannelX3(client, chan);
    } catch {
      // best-effort
    }
  }
}

interface RenameOutcome {
  outcome: 'success' | 'fail';
  code?: string;
  description?: string;
}

async function attemptRename(
  client: X3Client,
  oldName: string,
  newName: string,
  reason: string
): Promise<RenameOutcome> {
  client.clearRawBuffer();
  client.send(`RENAME ${oldName} ${newName} :${reason}`);
  const msg = await client.waitForParsedLine(
    (m) => m.command === 'RENAME' || (m.command === 'FAIL' && m.params[0]?.toUpperCase() === 'RENAME'),
    RENAME_WAIT
  );
  if (msg.command === 'RENAME') return { outcome: 'success' };
  return { outcome: 'fail', code: msg.params[1], description: msg.trailing };
}

describe('Services-Arbitrated Channel Rename (X3 AC R arbitration)', () => {
  const clients: X3Client[] = [];
  const trackClient = (c: X3Client): X3Client => {
    clients.push(c);
    return c;
  };

  let owner: X3Client;
  let ownerNick: string;

  let nonOwner: X3Client | undefined;
  let nonOwnerNick: string | undefined;
  let nonOwnerAccount: string | undefined;

  // Tracks the live name of the channel used across cases 1/2/5/6.
  let mainChannelOriginal: string;
  let mainChannelCurrent: string;
  let case1RenameSucceeded = false;

  beforeAll(async () => {
    ownerNick = `rnowner${uniqueId().slice(0, 5)}`;
    owner = trackClient(await connectRenameClient(ownerNick));

    const authResult = await owner.auth(X3_ADMIN.account, X3_ADMIN.password, 20000);
    if (!authResult.success) {
      const check = await owner.checkAuth(15000);
      if (!check.authenticated) {
        throw new Error(`testadmin AUTH failed: ${authResult.error ?? 'no response'}`);
      }
    }

    // See header comment — protects against a crashed prior run leaving
    // testadmin at max_owned=2 before this run even starts.
    await cleanupOwnedChannels(owner);
  }, 40000);

  afterAll(async () => {
    if (owner) {
      await cleanupOwnedChannels(owner).catch(() => {});
    }
    if (nonOwnerAccount) {
      releaseTestAccount(nonOwnerAccount);
    }
    for (const c of clients) {
      try {
        c.send('QUIT');
        c.close();
      } catch {
        // ignore
      }
    }
  }, 30000);

  it('case 1: owner renames a registered channel; X3 state follows', async () => {
    mainChannelOriginal = uniqueChannel('rnsvc');
    mainChannelCurrent = mainChannelOriginal;

    owner.send(`JOIN ${mainChannelOriginal}`);
    await owner.waitForJoin(mainChannelOriginal);
    await new Promise((r) => setTimeout(r, 500));

    const reg = await registerChannelX3(owner, mainChannelOriginal);
    expect(reg.success, `REGISTER ${mainChannelOriginal} failed: ${JSON.stringify(reg.lines)}`).toBe(true);

    const newName = uniqueChannel('rnsvc2');
    const result = await attemptRename(owner, mainChannelOriginal, newName, 'Owner rebrand test');

    if (
      result.outcome === 'fail' &&
      result.code === 'CANNOT_RENAME' &&
      /linked server/i.test(result.description ?? '')
    ) {
      legacyBlocked = true;
      legacyBlockedKnown = true;
      console.log(
        '[channel-rename-services] topology guard fired on the very first RENAME ' +
          '(a non-IRCv3-aware, non-service server is linked) — dynamically skipping ' +
          'every arbitration-dependent assertion for the rest of this run.'
      );
      // Nothing moved: the channel is still registered under its original name.
      return;
    }

    legacyBlocked = false;
    legacyBlockedKnown = true;

    expect(result.outcome, `RENAME failed: ${result.code} ${result.description}`).toBe('success');
    mainChannelCurrent = newName;
    case1RenameSucceeded = true;

    await new Promise((r) => setTimeout(r, 1000));

    const infoNew = await owner.serviceCmd(X3_SERVICE, `INFO ${newName}`, X3_TIMEOUT);
    expect(infoNew.some((l) => /registered/i.test(l) && !/not registered/i.test(l))).toBe(true);

    // RenameChannel() removes the old name from X3's channel hash entirely
    // (design doc §1: dict_remove while the old node is still alive), so
    // INFO on it doesn't even reach the "not registered" reply — it hits
    // the generic "channel does not exist" guard first (MSG_INVALID_CHANNEL,
    // main-common.c) since there's no live channel by that name any more.
    const infoOld = await owner.serviceCmd(X3_SERVICE, `INFO ${mainChannelOriginal}`, X3_TIMEOUT);
    expect(
      infoOld.some((l) =>
        /does not exist|not (a )?registered|no such channel|never been registered/i.test(l)
      )
    ).toBe(true);

    // Access list intact under the new name — testadmin still shows as owner.
    const access = await owner.serviceCmd(X3_SERVICE, `ACCESS ${newName} *${X3_ADMIN.account}`, X3_TIMEOUT);
    expect(access.some((l) => /owner/i.test(l))).toBe(true);
  }, 45000);

  it('case 2: non-owner with op-level access is denied with the owner-only reason', async () => {
    if (legacyBlocked) {
      console.log('[skip] case 2: topology-blocked run, no arbitration path to exercise');
      return;
    }

    const acct = await getTestAccount();
    nonOwnerAccount = acct.account;
    nonOwnerNick = `rnnonown${uniqueId().slice(0, 5)}`;
    nonOwner = trackClient(await connectRenameClient(nonOwnerNick));

    const authResult = await nonOwner.auth(acct.account, acct.password, 20000);
    if (!authResult.success) {
      const check = await nonOwner.checkAuth(15000);
      expect(check.authenticated, `pool account ${acct.account} failed to auth`).toBe(true);
    }

    const addResult = await owner.serviceCmd(
      X3_SERVICE,
      `ADDUSER ${mainChannelCurrent} *${acct.account} 200`,
      X3_TIMEOUT
    );
    expect(
      addResult.some((l) => /added|access|user list/i.test(l)),
      `ADDUSER failed: ${JSON.stringify(addResult)}`
    ).toBe(true);

    nonOwner.send(`JOIN ${mainChannelCurrent}`);
    await nonOwner.waitForJoin(mainChannelCurrent);

    // Force op explicitly rather than relying on auto-op timing — RENAME
    // requires chanop, and we want to hit the owner-only arbitration
    // check, not an unrelated ERR_CHANOPRIVSNEEDED.
    owner.send(`PRIVMSG ${X3_SERVICE} :OP ${mainChannelCurrent} ${nonOwnerNick}`);
    const opped = await waitForChannelMode(nonOwner, mainChannelCurrent, nonOwnerNick, '@', 10000);
    expect(opped, 'non-owner never got opped — cannot exercise the RENAME permission check').toBe(true);

    const target = uniqueChannel('rnperm');
    const result = await attemptRename(nonOwner, mainChannelCurrent, target, 'unauthorized rename attempt');

    expect(result.outcome).toBe('fail');
    expect(result.code).toBe('CANNOT_RENAME');
    expect(result.description ?? '').toMatch(/you must be the channel owner/i);
  }, 60000);

  it('case 3: rename onto an already-registered channel name is denied', async () => {
    // Registers a second, transient channel to use as the rename target,
    // then unregisters it before returning — testadmin must never hold
    // more than max_owned=2 (mainChannelCurrent + this one = 2).
    const targetChan = uniqueChannel('rntarget');
    owner.send(`JOIN ${targetChan}`);
    await owner.waitForJoin(targetChan);
    await new Promise((r) => setTimeout(r, 500));

    const reg = await registerChannelX3(owner, targetChan);
    expect(reg.success, `REGISTER ${targetChan} failed: ${JSON.stringify(reg.lines)}`).toBe(true);

    try {
      const result = await attemptRename(
        owner,
        mainChannelCurrent,
        targetChan,
        'collision with a registered channel'
      );

      expect(result.outcome).toBe('fail');
      // A registered channel's ChanServ presence keeps it "live" on the
      // ircd, so nefarious's own FindChannel(newname) check rejects this
      // before services is even asked (CHANNEL_NAME_IN_USE) — see header
      // comment. Accept CANNOT_RENAME too in case that ordering changes.
      expect(['CHANNEL_NAME_IN_USE', 'CANNOT_RENAME']).toContain(result.code);
    } finally {
      await unregisterChannelX3(owner, targetChan);
    }
  }, 45000);

  it('case 4: unregistered channel rename succeeds; old name becomes a fresh channel', async () => {
    const oldName = uniqueChannel('rnfree');
    const newName = uniqueChannel('rnfree2');

    owner.send(`JOIN ${oldName}`);
    await owner.waitForJoin(oldName);
    await new Promise((r) => setTimeout(r, 300));

    const result = await attemptRename(owner, oldName, newName, 'unregistered channel rename');

    if (legacyBlocked) {
      expect(result.outcome).toBe('fail');
      expect(result.code).toBe('CANNOT_RENAME');
      expect(result.description ?? '').toMatch(/linked server/i);
      return;
    }

    expect(result.outcome, `RENAME failed: ${result.code} ${result.description}`).toBe('success');

    // Old name is gone entirely (no services state ever existed for it):
    // joining it creates a brand new, empty channel rather than resuming
    // the renamed-away one.
    const rejoinNick = `rnrejoin${uniqueId().slice(0, 5)}`;
    const rejoiner = trackClient(await connectRenameClient(rejoinNick));
    rejoiner.send(`JOIN ${oldName}`);
    const join = await rejoiner.waitForJoin(oldName, rejoinNick, 5000);
    expect(join).toBeTruthy();

    rejoiner.clearRawBuffer();
    rejoiner.send(`NAMES ${oldName}`);
    const names = await rejoiner.waitForNumeric('353', 5000);
    const nameList = names.trailing ?? names.raw;
    // Fresh channel: the rejoiner is the only (and thus first, opped) member.
    expect(nameList).toMatch(new RegExp(`@${rejoinNick}\\b`, 'i'));
    expect(nameList.toLowerCase()).not.toContain(ownerNick.toLowerCase());
  }, 30000);

  it('case 5: a denied rename does not poison the requester\'s account stamp', async () => {
    if (legacyBlocked || !nonOwner || !nonOwnerNick || !nonOwnerAccount) {
      console.log('[skip] case 5: case 2 never produced a denied requester to regress-check');
      return;
    }

    nonOwner.clearRawBuffer();
    nonOwner.send(`WHOIS ${nonOwnerNick}`);
    const acctReply = await nonOwner.waitForNumeric('330', 5000);
    // RPL_WHOISACCOUNT: <requester> <nick> <account> :is logged in as
    expect(acctReply.params[2]?.toLowerCase()).toBe(nonOwnerAccount.toLowerCase());
  }, 15000);

  it('case 6: the old name is do-not-register while the post-rename DNR stands', async () => {
    if (legacyBlocked || !case1RenameSucceeded) {
      console.log('[skip] case 6: case 1 never completed a rename, so no DNR was ever created');
      return;
    }

    // REGISTER is bound with MODCMD_REQUIRE_CHANNEL ("+acceptchan,+channel"
    // in chanserv.c's DEFINE_COMMAND(register, ...)) — it needs a currently
    // *live* channel to bind to, and RenameChannel() left nothing behind at
    // the old name (case 1's INFO assertion already proved that). So the
    // DNR check is unreachable until the old name exists as a channel again
    // — recreate it with a plain JOIN (nothing in services claims it; this
    // is exactly the "someone reuses the name" scenario the DNR guards
    // against) and THEN attempt REGISTER.
    owner.send(`JOIN ${mainChannelOriginal}`);
    await owner.waitForJoin(mainChannelOriginal);
    await new Promise((r) => setTimeout(r, 300));

    const lines = await owner.serviceCmd(X3_SERVICE, `REGISTER ${mainChannelOriginal}`, X3_TIMEOUT);
    const denied = lines.some((l) => /only network staff may register/i.test(l));

    expect(
      denied,
      `REGISTER ${mainChannelOriginal} was not blocked by the rename DNR: ${JSON.stringify(lines)}`
    ).toBe(true);
  }, 30000);
});
