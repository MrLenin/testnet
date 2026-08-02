import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import {
  X3Client,
  PRIMARY_SERVER,
  uniqueChannel,
  uniqueId,
  X3_ADMIN,
} from '../helpers/index.js';

/**
 * evilnet/channel-relocate E2E — consent-based channel renaming.
 *
 * Spec: docs/specs/channel-relocate.md (vendored, evilnet/ namespace).
 * Server side: nefarious/ircd/m_rename.c (relocate_execute, tombstone
 * lifecycle, status snapshot) + m_join.c (restore-on-follow); X3 side:
 * x3/src/proto-p10.c cmd_rename + x3/src/chanserv.c husk sweep.
 *
 * Relocation mode is selected by the ircd feature RENAME_CONSENT; the
 * tombstone grace period is RELOCATE_GRACE. This bed runs
 * RENAME_CONSENT=TRUE / RELOCATE_GRACE=45 (data/ircd.conf + data/ircd2.conf),
 * with the matching X3 side at relocate_grace 45 (X3_RELOCATE_GRACE in
 * .env.local -> docker/x3.conf-dist). Case 4 depends on the 45s value; every
 * other case only needs "grace is long enough to still be alive".
 *
 * ------------------------------------------------------------------
 * TOPOLOGY GUARD (nefarious/ircd/m_rename.c rename_legacy_blocker()):
 * RENAME is refused outright while ANY linked server is neither
 * IRCv3-aware nor rename-capable. On this bed that is
 * upstream.fractalrealities.net (unmodified upstream) plus the two CRDT
 * mesh anchors leaf4/leaf5.fractalrealities.net. Unlike
 * channel-rename-services.test.ts, which *detects* the guard and skips,
 * this suite REMOVES it: beforeAll opers up (AUTH to AuthServ auto-opers
 * testadmin) and SQUITs the three blockers, and every rename-driving case
 * re-SQUITs first because those links auto-reconnect on a timer that is
 * shorter than this suite's runtime.
 *
 * The bed is NOT restored by this file — vitest cannot restart containers.
 * After a run, restore it from a shell with
 *   docker restart nefarious3      # relinks P10, re-materializes the anchors
 *   docker restart nefarious-upstream   # if upstream did not auto-relink
 * and verify with an oper /LINKS that all 9 servers are back (testnet,
 * hub2, leaf, leaf2, leaf3, leaf4, leaf5, upstream, x3.services).
 *
 * ------------------------------------------------------------------
 * BED NOISE THIS SUITE DELIBERATELY DOES NOT ASSERT ON:
 *  - hub2 (nefarious3) and its leaves run the *nefarious-crdt* fork, which
 *    has no relocation engine. Its CRDT document keeps a copy of the old
 *    channel alive across the relocation and re-asserts state onto it
 *    ("CRDT create-reconcile: created channel #old from doc", followed by a
 *    network `MODE #old +R`). That is a mesh/prod-fork coexistence artifact
 *    of this testbed, not relocation behaviour: assertions here are scoped
 *    to what the LOCAL server sends the client, and never to the absence of
 *    an unrelated MODE on the tombstone.
 *  - `501 <letter> :Unknown user MODE flag` echoes back from the unmodified
 *    upstream server for any fork-only umode (+F, +M, ...) while it is
 *    linked. Case 5 asserts the umode took effect (MODE reply / 221), not
 *    the absence of that numeric.
 */

const X3_SERVICE = 'X3';
const X3_TIMEOUT = 15000;
const RENAME_WAIT = 15000;
const GRACE_SECONDS = 45;

/** Servers that trip rename_legacy_blocker() on this bed. */
const LEGACY_BLOCKERS = [
  'upstream.fractalrealities.net',
  'leaf4.fractalrealities.net',
  'leaf5.fractalrealities.net',
];

const RELOCATE_CAP = 'evilnet/channel-relocate';
const RENAME_CAP = 'draft/channel-rename';

async function settle(ms: number): Promise<void> {
  await new Promise((r) => setTimeout(r, ms));
}

/**
 * Connect + register a client negotiating exactly `caps` (possibly none).
 * `caps === null` means "never send CAP at all", which is how the no-cap
 * member class of the spec's partition table is produced.
 */
async function connectClient(nick: string, caps: string[] | null): Promise<X3Client> {
  const client = new X3Client();
  await client.connect(PRIMARY_SERVER.host, PRIMARY_SERVER.port);
  if (caps !== null) {
    await client.capLs();
    if (caps.length > 0) await client.capReq(caps);
    client.capEnd();
  }
  client.register(nick);
  await client.waitForNumeric('001', 20000);
  // Post-001 welcome traffic (host-hiding MODE +x, PM-history NOTICE) has to
  // land before we start reasoning about what a client did or did not see.
  await settle(1200);
  return client;
}

interface RenameOutcome {
  outcome: 'success' | 'fail';
  code?: string;
  description?: string;
  raw?: string;
}

async function attemptRename(
  client: X3Client,
  oldName: string,
  newName: string,
  reason: string
): Promise<RenameOutcome> {
  client.send(`RENAME ${oldName} ${newName} :${reason}`);
  try {
    const msg = await client.waitForParsedLine(
      (m) =>
        (m.command === 'RENAME' && m.params[0]?.toLowerCase() === oldName.toLowerCase()) ||
        (m.command === 'FAIL' && m.params[0]?.toUpperCase() === 'RENAME'),
      RENAME_WAIT
    );
    if (msg.command === 'RENAME') return { outcome: 'success', raw: msg.raw };
    return { outcome: 'fail', code: msg.params[1], description: msg.trailing, raw: msg.raw };
  } catch {
    return { outcome: 'fail', code: 'NO_REPLY', description: 'no RENAME/FAIL within timeout' };
  }
}

/**
 * Assert that a rename a case depends on actually happened, and separate the
 * two ways it can not have: the legacy-topology guard (a blocker relinked —
 * an environment problem, reported with its own actionable message) versus
 * any other FAIL (a real failure of the thing under test).
 *
 * Every issuer in this suite negotiates draft/channel-rename, so `success`
 * here means attemptRename() saw the RENAME message come back.
 */
function assertRenamed(result: RenameOutcome, what: string): void {
  if (result.outcome === 'fail' && /linked server/i.test(result.description ?? '')) {
    throw new Error(
      `${what}: rename_legacy_blocker() fired despite the beforeAll SQUITs — a ` +
        `blocker relinked mid-run. Re-check LEGACY_BLOCKERS / squitBlockers(). Raw: ${result.raw}`
    );
  }
  expect(
    result.outcome,
    `${what}: RENAME failed (${result.code}) ${result.description ?? ''}`
  ).toBe('success');
}

/** True if `client` received a JOIN of `channel` for its own nick. */
function sawOwnJoin(client: X3Client, channel: string, nick: string): boolean {
  return client.allParsedLines.some(
    (m) =>
      m.command === 'JOIN' &&
      m.params[0]?.toLowerCase() === channel.toLowerCase() &&
      m.source?.nick?.toLowerCase() === nick.toLowerCase()
  );
}

/** True if `client` received a PART of `channel` sourced from `nick`. */
function sawPartFrom(client: X3Client, channel: string, nick: string): boolean {
  return client.allParsedLines.some(
    (m) =>
      m.command === 'PART' &&
      m.params[0]?.toLowerCase() === channel.toLowerCase() &&
      m.source?.nick?.toLowerCase() === nick.toLowerCase()
  );
}

describe('evilnet/channel-relocate (consent-based channel renaming)', () => {
  const clients: X3Client[] = [];
  const track = (c: X3Client): X3Client => {
    clients.push(c);
    return c;
  };

  let oper: X3Client;

  /**
   * Drop every server that trips rename_legacy_blocker(). Idempotent: a
   * blocker that is already gone answers 402 (no such server), which is a
   * success for our purposes. Called before every rename-driving case
   * because these links auto-reconnect within a couple of minutes.
   */
  async function squitBlockers(): Promise<void> {
    // Verify with LINKS rather than trusting the SQUITs: these links
    // auto-reconnect on a ~10 minute cycle, so one can come back between the
    // SQUIT and the RENAME it was supposed to clear the way for. Retry until
    // LINKS agrees they are all gone.
    for (let attempt = 0; attempt < 4; attempt++) {
      for (const server of LEGACY_BLOCKERS) {
        oper.send(`SQUIT ${server} :channel-relocate test gate`);
        // X3 reacts to the SQUIT storm with a burst of its own traffic and can
        // lag well behind; we only need the ircd to have processed the command.
        await settle(900);
      }
      await settle(1200);

      oper.clearRawBuffer();
      oper.send('LINKS');
      try {
        await oper.waitForNumeric('365', 10000);
      } catch {
        continue;
      }
      const linked = oper.allParsedLines
        .filter((m) => m.command === '364')
        .map((m) => m.params[1]?.toLowerCase());
      const stillUp = LEGACY_BLOCKERS.filter((s) => linked.includes(s.toLowerCase()));
      if (stillUp.length === 0) return;
      console.log(`[squitBlockers] still linked after attempt ${attempt + 1}: ${stillUp.join(', ')}`);
    }
    throw new Error(
      `could not clear the rename legacy blockers (${LEGACY_BLOCKERS.join(', ')}) — ` +
        'is the oper AUTH/auto-oper working?'
    );
  }

  /**
   * A rename that the case depends on succeeding. Always re-clears the legacy
   * blockers immediately beforehand: a case with more than one rename in it
   * (case 7) can otherwise have one relink between its own hops.
   */
  async function renameOrThrow(
    client: X3Client,
    oldName: string,
    newName: string,
    reason: string,
    what: string
  ): Promise<void> {
    await squitBlockers();
    assertRenamed(await attemptRename(client, oldName, newName, reason), what);
  }

  beforeAll(async () => {
    const operNick = `rlop${uniqueId().slice(0, 5)}`;
    oper = track(await connectClient(operNick, []));
    // AUTH to AuthServ auto-opers testadmin on this bed (X3 AUTO_OPER), which
    // is what grants the SQUIT privilege.
    oper.clearRawBuffer();
    oper.send(`PRIVMSG AuthServ@x3.services :AUTH ${X3_ADMIN.account} ${X3_ADMIN.password}`);
    // Fail here, loudly, rather than 15 cases later on an unexplained SQUIT
    // that silently did nothing: without the oper privilege every rename in
    // this file dies on the legacy-topology guard.
    // X3 answers a good AUTH with NSMSG_AUTH_SUCCESS ("I recognize you.") or,
    // on a repeat, NSMSG_ALREADY_AUTHED ("You are already authed to account
    // ..."). On this bed the auto-oper notice ("You have been auto-opered")
    // can arrive first, and it is the strongest confirmation available of the
    // thing we actually need — the SQUIT privilege — so it counts as success
    // too. Wait for the first AuthServ NOTICE that decides the question either
    // way rather than the first NOTICE of any kind.
    const AUTH_OK = /I recognize you|already authed|auto-opered/i;
    const AUTH_BAD = /incorrect|does not exist|denied|invalid|not authenticated|bad password/i;
    const authReply = await oper.waitForParsedLine(
      (m) =>
        m.command === 'NOTICE' &&
        m.source?.nick?.toLowerCase() === 'authserv' &&
        (AUTH_OK.test(m.trailing ?? '') || AUTH_BAD.test(m.trailing ?? '')),
      25000
    );
    expect(
      authReply.trailing ?? '',
      `AuthServ refused the ${X3_ADMIN.account} AUTH: ${authReply.raw}`
    ).toMatch(AUTH_OK);

    // The NOTICE is services talking; the privilege arrives separately, as
    // umode +o over P10. SQUIT is a silent no-op without it, so wait for the
    // umode itself rather than guessing a sleep long enough for it.
    let opered = false;
    for (let attempt = 0; attempt < 15 && !opered; attempt++) {
      await settle(1000);
      oper.clearRawBuffer();
      oper.send(`MODE ${operNick}`);
      try {
        const umodes = await oper.waitForNumeric('221', 5000);
        opered = /o/.test(umodes.params[1] ?? umodes.trailing ?? '');
      } catch {
        // keep polling
      }
    }
    expect(
      opered,
      `${X3_ADMIN.account} authed but never received umode +o — no SQUIT privilege, ` +
        'so every rename in this file would die on the legacy-topology guard'
    ).toBe(true);

    oper.clearRawBuffer();
    oper.send('LINKS');
    try {
      await oper.waitForNumeric('365', 10000);
    } catch {
      throw new Error('oper LINKS produced no end-of-list — AUTH/auto-oper likely failed');
    }
    const linked = oper.allParsedLines
      .filter((m) => m.command === '364')
      .map((m) => m.params[1]);
    expect(linked.length, `LINKS returned nothing useful: ${JSON.stringify(linked)}`).toBeGreaterThan(1);

    await squitBlockers();
  }, 90000);

  afterAll(async () => {
    for (const c of clients) {
      try {
        c.send('QUIT :channel-relocate suite done');
        c.close();
      } catch {
        // ignore
      }
    }
  }, 30000);

  // ------------------------------------------------------------------
  it('case 5: plumbing — CAP LS advertises the cap, ISUPPORT carries RELOCATE=<grace>, umode +F is settable', async () => {
    const nick = `rlplumb${uniqueId().slice(0, 5)}`;
    const client = track(await connectClient(nick, [RELOCATE_CAP]));

    // Capability is advertised AND grantable.
    expect(
      client.hasCapEnabled(RELOCATE_CAP),
      `${RELOCATE_CAP} was not ACKed — CAP LS/REQ plumbing is broken`
    ).toBe(true);

    // RPL_ISUPPORT token: RELOCATE=<grace-seconds>.
    const isupport = client.allParsedLines
      .filter((m) => m.command === '005')
      .flatMap((m) => m.params.slice(1));
    const relocateToken = isupport.find((t) => t.startsWith('RELOCATE='));
    expect(
      relocateToken,
      `no RELOCATE= token in ISUPPORT: ${JSON.stringify(isupport)}`
    ).toBeDefined();
    expect(relocateToken).toBe(`RELOCATE=${GRACE_SECONDS}`);

    // umode +F (FLAG_RELOCATE_FOLLOW) is freely user-settable and readable.
    client.clearRawBuffer();
    client.send(`MODE ${nick} +F`);
    const modeEcho = await client.waitForParsedLine(
      (m) =>
        m.command === 'MODE' &&
        m.params[0]?.toLowerCase() === nick.toLowerCase() &&
        (m.params[1] ?? '').includes('F'),
      10000
    );
    expect(modeEcho.params[1]).toContain('+F');

    client.clearRawBuffer();
    client.send(`MODE ${nick}`);
    const umodes = await client.waitForNumeric('221', 10000);
    expect(
      umodes.params[1] ?? umodes.trailing ?? '',
      'RPL_UMODEIS does not show +F after setting it'
    ).toMatch(/F/);
  }, 60000);

  // ------------------------------------------------------------------
  it('case 1: the member partition — issuer and +F move, relocate-cap and no-cap members stay and are notified per class', async () => {
    const oldName = uniqueChannel('rlpart');
    const newName = uniqueChannel('rlpartn');
    const sfx = uniqueId().slice(0, 5);

    // Class 1: the issuer, holding draft/channel-rename.
    const issuerNick = `rliss${sfx}`;
    const issuer = track(await connectClient(issuerNick, [RENAME_CAP]));
    // Class 2: umode +F, deliberately WITHOUT draft/channel-rename, to
    // exercise the legacy PART+JOIN presentation of a move.
    const followNick = `rlfol${sfx}`;
    const follower = track(await connectClient(followNick, null));
    // Class 3: evilnet/channel-relocate — must NOT be moved.
    const relocNick = `rlrel${sfx}`;
    const relocClient = track(await connectClient(relocNick, [RELOCATE_CAP]));
    // Class 4: no relevant caps at all — NOTICE fallback, must NOT be moved
    // and must NOT see a RENAME.
    const plainNick = `rlpln${sfx}`;
    const plain = track(await connectClient(plainNick, null));

    follower.clearRawBuffer();
    follower.send(`MODE ${followNick} +F`);
    await follower.waitForParsedLine(
      (m) =>
        m.command === 'MODE' &&
        m.params[0]?.toLowerCase() === followNick.toLowerCase() &&
        (m.params[1] ?? '').includes('F'),
      10000
    );

    for (const c of [issuer, follower, relocClient, plain]) {
      c.send(`JOIN ${oldName}`);
      await c.waitForJoin(oldName, undefined, 10000);
    }
    await settle(800);

    for (const c of [issuer, follower, relocClient, plain]) c.clearRawBuffer();

    await renameOrThrow(issuer, oldName, newName, 'moving day', 'case 1');
    await settle(3000);

    // --- issuer: moved, told with a RENAME message (it has the cap).
    const issuerRename = issuer.allParsedLines.find((m) => m.command === 'RENAME');
    expect(issuerRename, 'issuer never received the RENAME message').toBeDefined();
    expect(issuerRename!.params[0]?.toLowerCase()).toBe(oldName.toLowerCase());
    expect(issuerRename!.params[1]?.toLowerCase()).toBe(newName.toLowerCase());
    expect(issuerRename!.trailing).toBe('moving day');

    // --- +F follower: moved, told with the legacy PART+JOIN pair.
    expect(
      sawPartFrom(follower, oldName, followNick),
      '+F member never received its own PART of the old name'
    ).toBe(true);
    const followPart = follower.allParsedLines.find(
      (m) =>
        m.command === 'PART' &&
        m.params[0]?.toLowerCase() === oldName.toLowerCase() &&
        m.source?.nick?.toLowerCase() === followNick.toLowerCase()
    );
    expect(followPart!.trailing ?? '').toMatch(new RegExp(`renamed to ${newName}`, 'i'));
    expect(
      sawOwnJoin(follower, newName, followNick),
      '+F member never received its own JOIN of the new name'
    ).toBe(true);
    expect(
      follower.allParsedLines.some((m) => m.command === 'RENAME'),
      '+F member without draft/channel-rename received a RENAME message'
    ).toBe(false);

    // --- relocate-cap member: NOT moved, gets RELOCATE.
    const relocateMsg = relocClient.allParsedLines.find((m) => m.command === 'RELOCATE');
    expect(relocateMsg, 'relocate-cap member never received the RELOCATE message').toBeDefined();
    expect(relocateMsg!.params[0]?.toLowerCase()).toBe(oldName.toLowerCase());
    expect(relocateMsg!.params[1]?.toLowerCase()).toBe(newName.toLowerCase());
    expect(relocateMsg!.trailing).toBe('moving day');
    // Source is the issuing user's full mask, so a client can attribute it.
    expect(relocateMsg!.source?.nick?.toLowerCase()).toBe(issuerNick.toLowerCase());
    expect(
      sawOwnJoin(relocClient, newName, relocNick),
      'relocate-cap member was moved into the new channel without consenting'
    ).toBe(false);
    expect(
      relocClient.allParsedLines.some((m) => m.command === 'RENAME'),
      'relocate-cap member received a RENAME message (it asserts a move that did not happen)'
    ).toBe(false);

    // --- no-cap member: NOT moved, gets the fallback NOTICE, never a RENAME.
    const notice = plain.allParsedLines.find(
      (m) => m.command === 'NOTICE' && m.params[0]?.toLowerCase() === oldName.toLowerCase()
    );
    expect(notice, 'no-cap member never received the fallback channel NOTICE').toBeDefined();
    expect(notice!.trailing ?? '').toMatch(
      new RegExp(`${oldName} has moved to ${newName}`, 'i')
    );
    expect(notice!.trailing ?? '').toMatch(/moving day/);
    expect(
      plain.allParsedLines.some((m) => m.command === 'RENAME'),
      'no-cap member received a RENAME message despite never negotiating the cap'
    ).toBe(false);
    expect(
      plain.allParsedLines.some((m) => m.command === 'RELOCATE'),
      'no-cap member received a RELOCATE message despite never negotiating the cap'
    ).toBe(false);
    expect(
      sawOwnJoin(plain, newName, plainNick),
      'no-cap member was moved into the new channel without consenting'
    ).toBe(false);

    // --- stayers must see the movers leave (Task 2 finding M1): without this
    // their nick lists keep two ghosts for the whole grace period.
    for (const [c, who] of [
      [relocClient, 'relocate-cap'],
      [plain, 'no-cap'],
    ] as const) {
      expect(
        sawPartFrom(c, oldName, issuerNick),
        `${who} stayer never saw the issuer PART the tombstone`
      ).toBe(true);
      expect(
        sawPartFrom(c, oldName, followNick),
        `${who} stayer never saw the +F mover PART the tombstone`
      ).toBe(true);
    }

    // --- the tombstone's redirect is announced to whoever is left in it.
    const redirectMode = relocClient.allParsedLines.find(
      (m) =>
        m.command === 'MODE' &&
        m.params[0]?.toLowerCase() === oldName.toLowerCase() &&
        m.params[1] === '+L'
    );
    expect(redirectMode, 'tombstone never announced +L to its remaining members').toBeDefined();
    expect(redirectMode!.params[2]?.toLowerCase()).toBe(newName.toLowerCase());
  }, 120000);

  // ------------------------------------------------------------------
  it('case 2: joining the tombstone forwards the joiner to the new channel', async () => {
    await squitBlockers();

    const oldName = uniqueChannel('rltomb');
    const newName = uniqueChannel('rltombn');
    const sfx = uniqueId().slice(0, 5);

    const issuer = track(await connectClient(`rlti${sfx}`, [RENAME_CAP]));
    // A stayer keeps the tombstone populated so this case is about the
    // redirect, not about an empty channel.
    const stayerNick = `rlts${sfx}`;
    const stayer = track(await connectClient(stayerNick, [RELOCATE_CAP]));

    for (const c of [issuer, stayer]) {
      c.send(`JOIN ${oldName}`);
      await c.waitForJoin(oldName, undefined, 10000);
    }
    await settle(600);
    await renameOrThrow(issuer, oldName, newName, 'tombstone probe', 'case 2');
    await settle(1500);

    const joinerNick = `rltj${sfx}`;
    const joiner = track(await connectClient(joinerNick, null));
    joiner.clearRawBuffer();
    joiner.send(`JOIN ${oldName}`);

    // The landing channel is the assertion; the numeric that announces the
    // forward is an existing +L implementation detail (490/551 on this fork,
    // 470 in the spec's example) and is only reported, not asserted on.
    const landed = await joiner.waitForParsedLine(
      (m) =>
        m.command === 'JOIN' &&
        m.source?.nick?.toLowerCase() === joinerNick.toLowerCase(),
      15000
    );
    expect(
      landed.params[0]?.toLowerCase(),
      `joiner landed in ${landed.params[0]} instead of being forwarded to ${newName}`
    ).toBe(newName.toLowerCase());

    // This fork answers +L forwards with 490; the spec's example shows 470.
    // 551 also appears in the +L numeric family but is not a forward
    // announcement, so it is not accepted here — if it ever shows up, the
    // logged raw line below is where it will be visible.
    const forwardNumeric = joiner.allParsedLines.find(
      (m) => ['470', '490'].includes(m.command) && m.raw.includes(oldName)
    );
    expect(
      forwardNumeric,
      'no redirect numeric accompanied the forward — the client is left guessing why it moved'
    ).toBeDefined();
    console.log(`[case 2] forward numeric: ${forwardNumeric!.raw}`);
  }, 120000);

  // ------------------------------------------------------------------
  it('case 3: a member who declines the move regains its old status when it follows within grace', async () => {
    await squitBlockers();

    const oldName = uniqueChannel('rlfollow');
    const newName = uniqueChannel('rlfollown');
    const sfx = uniqueId().slice(0, 5);

    const issuerNick = `rlfi${sfx}`;
    const issuer = track(await connectClient(issuerNick, [RENAME_CAP]));
    const opNick = `rlfo${sfx}`;
    const opClient = track(await connectClient(opNick, [RELOCATE_CAP]));

    issuer.send(`JOIN ${oldName}`);
    await issuer.waitForJoin(oldName, undefined, 10000);
    opClient.send(`JOIN ${oldName}`);
    await opClient.waitForJoin(oldName, undefined, 10000);

    // The issuer created the channel, so it is opped; op the follower too.
    opClient.clearRawBuffer();
    issuer.send(`MODE ${oldName} +o ${opNick}`);
    await opClient.waitForParsedLine(
      (m) =>
        m.command === 'MODE' &&
        m.params[0]?.toLowerCase() === oldName.toLowerCase() &&
        m.params[1] === '+o' &&
        m.params[2]?.toLowerCase() === opNick.toLowerCase(),
      10000
    );

    await renameOrThrow(issuer, oldName, newName, 'follow me', 'case 3');
    await settle(1500);

    // It stayed behind (no consent), so it is a plain member of the tombstone
    // with its +o intact there and no presence at all in the new channel.
    expect(sawOwnJoin(opClient, newName, opNick)).toBe(false);

    opClient.clearRawBuffer();
    opClient.send(`JOIN ${newName}`);
    const joined = await opClient.waitForJoin(newName, opNick, 15000);
    expect(joined).toBeTruthy();

    // Status preservation: the snapshot taken at rename time is replayed as a
    // server MODE right after the JOIN.
    const restore = await opClient.waitForParsedLine(
      (m) =>
        m.command === 'MODE' &&
        m.params[0]?.toLowerCase() === newName.toLowerCase() &&
        (m.params[1] ?? '').includes('o') &&
        m.params[2]?.toLowerCase() === opNick.toLowerCase(),
      15000
    );
    expect(restore.params[1]).toContain('+o');
    console.log(`[case 3] status restore: ${restore.raw}`);
  }, 120000);

  // ------------------------------------------------------------------
  it('case 6: a live tombstone cannot itself be renamed', async () => {
    await squitBlockers();

    const oldName = uniqueChannel('rlnoren');
    const newName = uniqueChannel('rlnorenn');
    const sfx = uniqueId().slice(0, 5);

    const issuer = track(await connectClient(`rlni${sfx}`, [RENAME_CAP]));
    // Must stay INSIDE the tombstone and be opped there, or the attempt dies
    // on 442/482 before the tombstone guard is reached.
    const stayerNick = `rlns${sfx}`;
    const stayer = track(await connectClient(stayerNick, [RELOCATE_CAP, 'standard-replies']));

    issuer.send(`JOIN ${oldName}`);
    await issuer.waitForJoin(oldName, undefined, 10000);
    stayer.send(`JOIN ${oldName}`);
    await stayer.waitForJoin(oldName, undefined, 10000);

    stayer.clearRawBuffer();
    issuer.send(`MODE ${oldName} +o ${stayerNick}`);
    await stayer.waitForParsedLine(
      (m) =>
        m.command === 'MODE' &&
        m.params[0]?.toLowerCase() === oldName.toLowerCase() &&
        m.params[1] === '+o',
      10000
    );

    await renameOrThrow(issuer, oldName, newName, 'first move', 'case 6 setup');
    await settle(1500);

    stayer.clearRawBuffer();
    const second = await attemptRename(stayer, oldName, uniqueChannel('rlnoren2'), 'rename the grave');
    expect(second.outcome).toBe('fail');
    expect(second.code).toBe('CANNOT_RENAME');
    expect(second.description ?? '').toMatch(/tombstone/i);
    expect(second.description ?? '').not.toMatch(/linked server/i);
    console.log(`[case 6] ${second.raw}`);
  }, 120000);

  // ------------------------------------------------------------------
  it('case 7: a two-hop relocation chain flattens, and an #a-only op who follows straight to #c regains status', async () => {
    await squitBlockers();

    const chanA = uniqueChannel('rlcha');
    const chanB = uniqueChannel('rlchb');
    const chanC = uniqueChannel('rlchc');
    const sfx = uniqueId().slice(0, 5);

    const issuerNick = `rlci${sfx}`;
    const issuer = track(await connectClient(issuerNick, [RENAME_CAP]));
    const opNick = `rlco${sfx}`;
    const opClient = track(await connectClient(opNick, [RELOCATE_CAP]));

    issuer.send(`JOIN ${chanA}`);
    await issuer.waitForJoin(chanA, undefined, 10000);
    opClient.send(`JOIN ${chanA}`);
    await opClient.waitForJoin(chanA, undefined, 10000);

    opClient.clearRawBuffer();
    issuer.send(`MODE ${chanA} +o ${opNick}`);
    await opClient.waitForParsedLine(
      (m) =>
        m.command === 'MODE' &&
        m.params[0]?.toLowerCase() === chanA.toLowerCase() &&
        m.params[1] === '+o',
      10000
    );

    opClient.clearRawBuffer();
    await renameOrThrow(issuer, chanA, chanB, 'hop 1', 'case 7 hop 1');
    await settle(1500);
    await renameOrThrow(issuer, chanB, chanC, 'hop 2', 'case 7 hop 2');
    await settle(2000);

    // Chain flattening: #a's tombstone must be RE-pointed at #c, not left
    // pointing at #b (the spec forbids multi-hop resolution at join time).
    const redirects = opClient.allParsedLines.filter(
      (m) =>
        m.command === 'MODE' &&
        m.params[0]?.toLowerCase() === chanA.toLowerCase() &&
        m.params[1] === '+L'
    );
    expect(
      redirects.length,
      `expected #a's redirect to be announced twice (initial + retarget), saw ${redirects.length}`
    ).toBeGreaterThanOrEqual(2);
    expect(
      redirects[redirects.length - 1].params[2]?.toLowerCase(),
      "#a's tombstone still points at an intermediate name"
    ).toBe(chanC.toLowerCase());

    // The #a-only op never followed to #b; joining #c directly must still find
    // its snapshot (scan-past + retarget in relocate_snap_lookup).
    opClient.clearRawBuffer();
    opClient.send(`JOIN ${chanC}`);
    await opClient.waitForJoin(chanC, opNick, 15000);
    const restore = await opClient.waitForParsedLine(
      (m) =>
        m.command === 'MODE' &&
        m.params[0]?.toLowerCase() === chanC.toLowerCase() &&
        (m.params[1] ?? '').includes('o') &&
        m.params[2]?.toLowerCase() === opNick.toLowerCase(),
      15000
    );
    expect(restore.params[1]).toContain('+o');
    console.log(`[case 7] two-hop restore: ${restore.raw}`);
  }, 150000);

  // ------------------------------------------------------------------
  it('case 4: at grace expiry the tombstone PARTs its stragglers and dissolves', async () => {
    await squitBlockers();

    const oldName = uniqueChannel('rlgrace');
    const newName = uniqueChannel('rlgracen');
    const sfx = uniqueId().slice(0, 5);

    const issuer = track(await connectClient(`rlgi${sfx}`, [RENAME_CAP]));
    const stayerNick = `rlgs${sfx}`;
    const stayer = track(await connectClient(stayerNick, null));

    issuer.send(`JOIN ${oldName}`);
    await issuer.waitForJoin(oldName, undefined, 10000);
    stayer.send(`JOIN ${oldName}`);
    await stayer.waitForJoin(oldName, undefined, 10000);
    await settle(600);

    stayer.clearRawBuffer();
    await renameOrThrow(issuer, oldName, newName, 'grace probe', 'case 4');
    const renamedAt = Date.now();

    const sweepPart = await stayer.waitForParsedLine(
      (m) =>
        m.command === 'PART' &&
        m.params[0]?.toLowerCase() === oldName.toLowerCase() &&
        m.source?.nick?.toLowerCase() === stayerNick.toLowerCase(),
      (GRACE_SECONDS + 30) * 1000
    );
    const elapsed = (Date.now() - renamedAt) / 1000;
    expect(sweepPart.trailing ?? '').toMatch(new RegExp(`Channel has moved to ${newName}`, 'i'));
    // The sweep must land in the advertised window, from both sides: early
    // and a member who never consented loses its membership before the grace
    // it was promised; late and RELOCATE=<grace> is not what the server
    // actually does. Tolerance covers link latency and the timer's 1s tick.
    expect(
      elapsed,
      `tombstone swept after ${elapsed.toFixed(1)}s, outside the advertised ${GRACE_SECONDS}s grace window`
    ).toBeGreaterThan(GRACE_SECONDS * 0.85);
    expect(
      elapsed,
      `tombstone swept after ${elapsed.toFixed(1)}s, well past the advertised ${GRACE_SECONDS}s grace`
    ).toBeLessThan(GRACE_SECONDS * 1.4);
    console.log(`[case 4] sweep PART after ${elapsed.toFixed(1)}s: ${sweepPart.raw}`);

    // ...and the tombstone is gone from the local server afterwards.
    await settle(1500);
    stayer.clearRawBuffer();
    stayer.send(`MODE ${oldName}`);
    const gone = await stayer.waitForNumeric(['403', '324', '442'], 10000);
    expect(
      gone.command,
      `expected ERR_NOSUCHCHANNEL for the dissolved tombstone, got: ${gone.raw}`
    ).toBe('403');
  }, 180000);

  // ------------------------------------------------------------------
  it('case 8: a REGISTERED channel relocates — registration and the service bot follow, the tombstone is left unregistered', async () => {
    const oldName = uniqueChannel('rlreg');
    const newName = uniqueChannel('rlregn');
    const sfx = uniqueId().slice(0, 5);

    // testadmin owns the channel: X3's AC R arbitration for RENAME is
    // owner-only, so the issuer has to be the registrant.
    const ownerNick = `rlro${sfx}`;
    const owner = track(await connectClient(ownerNick, [RENAME_CAP, 'standard-replies']));
    owner.send(`PRIVMSG AuthServ@x3.services :AUTH ${X3_ADMIN.account} ${X3_ADMIN.password}`);
    await settle(8000);

    // testadmin has max_owned=2; a crashed prior run can strand this one under
    // the cap, so drop whatever it still owns first.
    const info = await owner.serviceCmd('AuthServ', 'ACCOUNTINFO', X3_TIMEOUT);
    const ownedLine = info.find((l) => /Channel\(s\):/i.test(l));
    for (const chan of ownedLine ? [...ownedLine.matchAll(/Owner:(#\S+)/gi)].map((m) => m[1]) : []) {
      const first = await owner.serviceCmd(X3_SERVICE, `UNREGISTER ${chan}`, X3_TIMEOUT);
      const confirm = first
        .map((l) => l.match(/unregister\s+(\S+)\s+([0-9a-f]+)/i))
        .find((m) => m);
      if (confirm) {
        await owner.serviceCmd(X3_SERVICE, `UNREGISTER ${confirm[1]} ${confirm[2]}`, X3_TIMEOUT);
      }
    }

    owner.send(`JOIN ${oldName}`);
    await owner.waitForJoin(oldName, undefined, 10000);
    await settle(800);

    owner.clearRawBuffer();
    owner.send(`PRIVMSG ${X3_SERVICE} :REGISTER ${oldName}`);
    const botJoin = await owner.waitForParsedLine(
      (m) =>
        m.command === 'JOIN' &&
        m.params[0]?.toLowerCase() === oldName.toLowerCase() &&
        m.source?.nick?.toUpperCase() === X3_SERVICE,
      X3_TIMEOUT
    );
    expect(botJoin, `${X3_SERVICE} never joined ${oldName} — REGISTER failed`).toBeTruthy();
    await settle(1500);

    // A stayer, so the tombstone has a witness for the bot's departure.
    const stayerNick = `rlrs${sfx}`;
    const stayer = track(await connectClient(stayerNick, [RELOCATE_CAP]));
    stayer.send(`JOIN ${oldName}`);
    await stayer.waitForJoin(oldName, undefined, 10000);
    await settle(600);

    owner.clearRawBuffer();
    stayer.clearRawBuffer();
    await renameOrThrow(owner, oldName, newName, 'registered relocate', 'case 8');
    await settle(4000);

    // --- the service bot followed onto the wire and re-took its ops there.
    const botFollow = owner.allParsedLines.find(
      (m) =>
        m.command === 'JOIN' &&
        m.params[0]?.toLowerCase() === newName.toLowerCase() &&
        m.source?.nick?.toUpperCase() === X3_SERVICE
    );
    expect(botFollow, `${X3_SERVICE} did not follow the relocation to ${newName}`).toBeDefined();
    console.log(`[case 8] bot follow: ${botFollow!.raw}`);

    const botOp = owner.allParsedLines.find(
      (m) =>
        m.command === 'MODE' &&
        m.params[0]?.toLowerCase() === newName.toLowerCase() &&
        (m.params[1] ?? '').includes('o') &&
        m.params.slice(2).some((p) => p?.toUpperCase() === X3_SERVICE)
    );
    expect(botOp, `${X3_SERVICE} followed to ${newName} but arrived unopped`).toBeDefined();
    console.log(`[case 8] bot re-op: ${botOp!.raw}`);

    // --- ...and left the tombstone, telling the stayers why.
    const botPart = stayer.allParsedLines.find(
      (m) =>
        m.command === 'PART' &&
        m.params[0]?.toLowerCase() === oldName.toLowerCase() &&
        m.source?.nick?.toUpperCase() === X3_SERVICE
    );
    expect(botPart, `${X3_SERVICE} stayed behind in the tombstone`).toBeDefined();
    expect(botPart!.trailing ?? '').toMatch(new RegExp(`relocated to ${newName}`, 'i'));

    // --- registration followed the community, not the name.
    const infoNew = await owner.serviceCmd(X3_SERVICE, `INFO ${newName}`, X3_TIMEOUT);
    expect(
      infoNew.some((l) => /Owner:\s*\S/i.test(l)),
      `INFO ${newName} does not show a registered channel: ${JSON.stringify(infoNew)}`
    ).toBe(true);
    expect(
      infoNew.some((l) => new RegExp(`${X3_ADMIN.account}`, 'i').test(l)),
      `INFO ${newName} does not show ${X3_ADMIN.account} as owner`
    ).toBe(true);

    const infoOld = await owner.serviceCmd(X3_SERVICE, `INFO ${oldName}`, X3_TIMEOUT);
    expect(
      infoOld.some((l) =>
        /has not been registered|does not exist|not (a )?registered|no such channel/i.test(l)
      ),
      `the tombstone is still registered with services: ${JSON.stringify(infoOld)}`
    ).toBe(true);
  }, 180000);
});
