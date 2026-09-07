# Chathistory comprehensive audit — 2026-09-06

Trigger: twelve-plus chathistory bugs in one week (2026-08-30 → 09-06), most of them the
same mechanism leaking at a layer the previous fix did not touch. User: "too many chathistory
bugs popping up. I think it needs a comprehensive audit." This is that audit: read-only,
seven parallel dimensions, consolidated here. No code was changed for it.

Code under audit: fork head `7920490` (`ircv3.2-hardening`). Per-dimension reports (full
detail, every finding with file:line, trigger, effect, confidence) live in the session
scratchpad `audit/1-query-walks.md` … `7-test-coverage.md`; the durable content is here.

Prior art this audit builds on (not re-derived): `chathistory-presence-paging.md`,
`chathistory-strict-presence-audit.md`, `chathistory-missing-history-msgid-investigation.md`,
`ircv3-spec-merge-audit-2026-09.md`, memory `project_s2s_msgid_override_leak.md`.

Totals: 1 CRITICAL, 16 HIGH, ~30 MEDIUM, ~30 LOW across 6 code dimensions; spec: 52 conform /
17 deviate / 4 unhandled of 73 clauses. **Almost none of the findings is pinned by a test.**

---

## Why the bugs keep coming: five recurring mechanisms

Every fix this week addressed one instance of one of these. The audit found the other
instances. Fix the mechanism, not the instance.

**M1. Filtering after the walk instead of inside it.** The limit is consumed by rows the
client never sees, so pages come back short or empty with no end tag, and paginators stall.
Instances: unreceivable row types (fixed for on-demand queries `7920490`, NOT for bouncer
replay, NOT on the federated responder); typing-only TAGMSG (three post-walk copies, none in
the walk); redaction filter after the walk (on-demand only, absent from bouncer replay);
TARGETS crowd-out (fixed on-demand `f0a6dbd`, NOT in the bouncer PM replay leg); AROUND's
reference row bypasses the type mask; the ephemeral requester's page on a federated responder
is walked unfiltered then post-filtered on the origin.

**M2. Two implementations of the same policy that drift.** On-demand handlers vs `replay.c`
bouncer replay vs the federated responder vs the (dead) `chathistory_auto_replay` copy. The
bouncer replay path lacks: context attach, redact filter, type mask, TARGETS filter. The cap
source differs too: the row-type gate uses the session-UNION caps (`CapActive`) while every
tag emission uses the connection's OWN caps (`CapRecipientHas`).

**M3. Cursors resolved to a millisecond, not a row.** Every `msgid=` reference is turned into
a timestamp and the msgid discarded; the walk then excludes or includes the WHOLE
millisecond. Same-ms rows are ordinary after the HLC repack (logical counter lives in the
msgid, not the stored ms), so msgid pagination silently drops siblings (BEFORE/AFTER/LATEST)
or repeats the anchor (BETWEEN). Also: BETWEEN ignores selector order, AROUND `timestamp=T`
loses the row at T, ISO fractions parsed without digit normalisation.

**M4. One event, several times / several ids (the one-time-per-message rule, again).**
Shipped for PRIVMSG/NOTICE/JOIN/PART/QUIT-local. Still broken: multiline (row = HLC at close,
live @time = wall clock, S2S = wall clock, msgid = HLC at mint; four times), KICK (three
times), NICK S2S tag = wall clock, MODE/TOPIC/REDACT live @time = wall clock, REDACT context
row = wall clock, remote-user QUIT rows take the msgid from the server LINK's tag stash
(foreign msgid on KILL/collision/SQUIT), Tier-2 multiline replay repeats one msgid on every
line while the live fallback puts it on the first only.

**M5. Federation was never audited as a system.** Ownership, completeness and the wire
budget were each assumed: shallow-copied rows are freed twice; the merge keeps the newest
`limit` for every subcommand; timeout/SQUIT stamps `chathistory-end` with responders
outstanding; CH R/Z/B silently overflow 510 bytes on prod-length hostmasks; storage ads are
link-order dependent (a look-alike of the SOLO condition we already misdiagnosed once).

---

## Findings, ranked (fix-worthy set)

Severity: C critical, H high, M medium, L low. "Pin" = existing test covers it.

| # | Sev | Mech | Finding | Where | Pin |
|---|---|---|---|---|---|
| 1 | C | M5 | **Double free through the fed merge.** `merge_messages` memcpy's local rows incl. `raw_content`/`dyn_content`; replay frees the copies, `free_fed_request` frees the originals. Trigger: storage-server origin, short local page with any row >256 B (zstd) or any multiline, ≥1 advertised peer. Verified by hand. | m_chathistory.c:4047-4070, 4080-4127, 3840-3875; replay.c:786-792 | no |
| 2 | H | M3 | **msgid cursors truncated to a millisecond.** BEFORE/AFTER/LATEST-anchor/BETWEEN/AROUND with `msgid=` drop every sibling row in the anchor's ms (or repeat the anchor, BETWEEN). Silent, repeatable, unrecoverable by paging. | history.c:1866-1877, 1902-1914, 1946-1959, 2216-2236 | no |
| 3 | H | M3 | **BETWEEN ignores selector order + start bound inclusive.** Always the OLDEST `limit` rows of the window, ascending; spec counts from the first selector, both bounds exclusive. goguma's whole backlog path is BETWEEN → loops on the same page. Found independently by 3 auditors. | history.c:2262-2270, 2296, 2314-2316 | no |
| 4 | H | M2 | **Bouncer auto-replay replays REDACTED content.** `replay_next_channel`/`_pm` skip `history_attach_context` + `redact_filter_messages`; `history_redact_message` is a no-op so the original is on disk. | replay.c:575-690 vs m_chathistory.c:1458-1476 | no |
| 5 | H | M1/M2 | **Bouncer channel replay walk has no type mask**; `is_last_page` judged on the raw count. Exactly the empty-page bug fixed for on-demand today, still live for reattach. | replay.c:585-607 | no |
| 6 | H | M1/M2 | **Bouncer PM replay leg crowded out**: `history_query_targets(..., 50, NULL)` in key order, channels first → PMs silently never replayed on a busy server. Missed by `f0a6dbd`. | replay.c:820-830 | no |
| 7 | H | M2 | **Row-type gate uses session-union caps, tags use own caps.** A connection without event-playback / message-redaction receives JOIN/PART/MODE/REDACT lines if a sibling negotiated them. | m_chathistory.c:507-544 | no |
| 8 | H | M1/M5 | **Requester type mask not on CH Q.** Responder pages count unreceivable rows → origin drops them at send → empty batch, no end tag, nothing to page from. Non-storage leaves hit this first (local count always 0). | m_chathistory.c:5262-5280 | no |
| 9 | H | M5 | **Fed merge keeps newest `limit` for every subcommand.** Wrong for AFTER/AROUND/ascending BETWEEN → permanent holes in forward paging (reconnect catch-up). `FedRequest` does not record the subcommand. | m_chathistory.c:4062-4070, 1980-2003 | no |
| 10 | H | M5 | **Timeout/SQUIT claims completeness.** `ET_EXPIRE` completes with responders outstanding and stamps `chathistory-end`; nothing on server exit touches `fed_requests[]`. 5 s stall + false end tag. | m_chathistory.c:4118-4123, 4157-4180; s_misc.c:293-304 | no |
| 11 | H | M5 | **CH R/Z/B overflow the 510-byte P10 line** when `sender+account` > ~57-59 bytes (header ≈51 + S + A, chunk fixed at 400). R content cut silently; Z/B base64 corrupted → row (whole multiline) dropped while `E` still counts it. Prod hostmasks hit it, docker ones don't. CH W/WB share the constants. | m_chathistory.c:131-235, 2984-3055; msgq.c:349-352 | no |
| 12 | H | M4 | **Multiline: one msgid, four times.** Row = HLC at close, live @time = gettimeofday, S2S = gettimeofday, msgid = HLC at mint (truncation-notice mints move it further). Receivers store their own close time. | m_batch.c:951-966, 1482, 1604, 1678, 2298, 2350, 2550 | no |
| 13 | H | M4 | **Remote-user QUIT rows take the msgid from the server link's stash** (`cli_s2s_msgid(bcptr)` = last message parsed on that link) whenever the exit is not the user's own QUIT: KILL of a remote user, collision, SQUIT. Foreign msgid on N rows; msgid index entry overwritten, orphaning the real PRIVMSG. | s_misc.c:485-490; client.h:666; list.c:261 | no |
| 14 | M | M4 | Tier-2 multiline replay (batch, no draft/multiline) repeats the msgid on every line; live fallback puts it on the first only → msgid-deduping clients keep line 1 of every multiline in history. | m_chathistory.c:800-842 vs m_batch.c:430-460 | live only |
| 15 | M | M4 | Multiline PM path has no `IsServiceClient`/`IsServer` gate (8d55d06 covered single-line only) → bot session ids back in TARGETS. | m_batch.c:1686-1735, 2558-2605 | single-line only |
| 16 | M | M4 | KICK/NICK/MODE/TOPIC/REDACT time disagreements (row vs live @time vs S2S tag), REDACT context row = gettimeofday (breaks `history_lookup_message` once the index row is gone). | m_kick.c:276-310; s_user.c:1341-1347; channel.c:2778; m_topic.c:198-206; m_redact.c:296-306, 405-409; send.c:189-197 | no |
| 17 | M | M1 | Spec: TAGMSG rows + the `+draft/chathistory-gap` tag are sent to clients WITHOUT `message-tags` (two MUST NOTs). | m_chathistory.c:514, 931 | no |
| 18 | M | M3 | AROUND `timestamp=T` never returns the row at T; ISO fraction `.5`→5 ms, `.123456`→999 ms. | history.c:2134-2155, 887-938 | no |
| 19 | M | M2 | PM target by plain nick resolves to the CURRENT holder; a nick TARGETS just listed (from stored rows) returns an empty end-tagged page once someone else holds it. | m_chathistory.c:1163-1186 | departed case only |
| 20 | M | M2 | A client's own CHATHISTORY cancels an in-flight bouncer catch-up replay mid-stream (batch closed, rest dropped, no notice). Modern clients issue LATEST right after JOIN — the exact victims. | replay.c:900-902, 1009-1010 | no |
| 21 | M | M5 | Storage ads (`CH A S`) only self-advertised at END_OF_BURST_ACK; far subtree never re-flooded to a new link → asymmetric, link-order-dependent federation; presents as SOLO. Multi profile can reproduce. | m_endburst.c:190-199; send.c:2158-2166 | no |
| 22 | M | M5 | Local `truncated` verdict lost when federating; `fed_requests[64]` exhaustion falls back to local-only WITH the local end-tag verdict; responder unfiltered for ephemeral requesters; TARGETS on responder hides everything for session-anchored requesters under strict presence. | m_chathistory.c:1593-1603, 4347-4353, 5232-5256 | partial |
| 23 | M | M4 | Targets CF: blind overwrite (late older row regresses "latest"); PM pair keys never cleaned after purge (empty conversations listed); bumped by every row type so TARGETS orders by latest EVENT (spec: message) and event-only channels are listed. | history.c:1330-1337, 1350, 1509-1516, 2734-2736 | no |
| 24 | M | M4 | REDACT of a row the local store lacks → `UNKNOWN_MSGID` (CH Q lookup only when history entirely unavailable). | m_redact.c:178-247 | single-server |
| 25 | M | spec | FAIL context shapes: `INVALID_TARGET`/`MESSAGE_ERROR` lack `the_given_command`; `REDACT_WINDOW_EXPIRED` lacks `<window>`; federated REDACT FAILs lack `<target>`. | m_chathistory.c:1553…1929, 2531; m_redact.c | codes only |
| 26 | M | spec | Multiline replay truncates every line to 511 bytes (`first_line[512]`) in all three tiers and never restores concat composition. Content loss. | m_chathistory.c:607, 742-828; m_batch.c:1663 | no |
| 27 | M | spec | Batch reference ids embed the P10 numeric whose alphabet includes `[` `]` → spec-illegal batch id for ~3% of clients; strict parsers drop the batch. | m_chathistory.c:495-500, 748; numnicks.c:102-107 | no |
| 28 | M | cost | `CHATHISTORY <unknown nick>` → unbounded targets-CF scan (limit 1,000,000) + a 20-row query per PM pair, per request, for any registered client. | m_chathistory.c:1181-1185 → replay.c:325-360 | no |
| 29 | L | policy | Non-spec `draft/chathistory=<int>` cap value (pinned as REQUIRED by chathistory.test.ts:1341) and invented `+draft/chathistory-gap` tag in the `draft/` namespace, undocumented, ungated. Rules `no-invented-extensions` / `evilnet_extensions_own_cap`. | m_cap.c:613-617; m_chathistory.c:899-943 | pins the violation |
| 30 | L | various | Orphaned context REDACT after parent filtered; `:full` cannot open access (only presence); GAP marker direction in PM batches; ephemeral ring only behind LATEST; trailing `;` in inner batch tags; `send_history_batch` truncates on sendQ after stamping end; dead `chathistory_auto_replay` copy; blank multiline line to non-multiline client; REDACT accepts non-message msgids; unknown legacy msgid → empty page WITH end tag; permissive unix refs flip inclusivity; redact set capped at 100; quota counters never decremented by purge; +Y multiline writes no GAP; TAGMSG/multiline channel rows skip the local-interest and REQUIRE_AUTH gates; CH W REDACT unguarded (duplicate context rows); channel rename has no history hook; `MAX_FED_MESSAGES` 500 aggregate cap; duplicate `CH E` double-decrement; no CHATHISTORY-specific throttle. | see per-dimension reports | no |

---

## Test coverage (dimension 7)

37 suites / ~221 tests mapped. Coverage is wide on LATEST-channel-single-server and thin
everywhere else:

- **No chathistory test runs against a legacy (upstream) P10 peer.** All "federation" coverage is fork-vs-fork.
- **AROUND** is barely covered (≥1 row asserted), never with presence, never cross-server.
- **Unknown/malformed msgid refs** effectively untested; **BETWEEN reversed / zero-width** untested.
- **Multiline inside a history batch**: the sole test's assertion is gated behind a hint string the server can never emit — structurally inert.
- **Auto-replay after revive with a limit**: never verified end to end (bouncer-pm-replay asserts shape only).
- **REDACT via history**: once, single-server, channel-only, never with event-playback.
- Cross-server PM identity with one unauthenticated side: never. Federation timeout / peer down at query time: never. Presence filtering is effectively single-server-only.

Also: `describe.skipIf` at module load and sleep-based timing remain common (known pattern).

---

## Proposed fix order (for agreement before any code)

Each wave is one commit-set with its tests written first; waves are ordered by blast radius
and by "closes a mechanism" rather than by severity alone.

**Wave 0 — memory safety (today).** #1 double free: unlink-and-transfer in `merge_messages`
(or deep-copy) and null `req->local_msgs`/`fed_msgs` after the merge. Test: federated LATEST
with a >256-byte row on the origin.

**Wave 1 — one replay pipeline (closes M1+M2).** Make `replay.c` bouncer replay call the SAME
page builder the on-demand handlers use (attach context → redact filter → walk with
`query_row_filter` incl. type mask → presence), delete `chathistory_auto_replay` and the dead
local branch, put typing-TAGMSG in the walk mask, wire the TARGETS filter into the PM replay
leg, switch the row-type gate to `CapRecipientHas`. Fixes #4 #5 #6 #7 and half of #30.
Tests: bouncer reattach with redacted row / long JOIN run / busy targets CF / mixed-cap
session.

**Wave 2 — cursor is a key, not a millisecond (closes M3).** Seek on the full
`target\0ts\0msgid` key for msgid refs in all five walks; BETWEEN honours selector order
(reverse walk with a floor) and excludes both bounds; AROUND includes the row at T; ISO
fraction digit-normalised (or rejected under STRICT). Fixes #2 #3 #18. Tests: same-ms
siblings via multi-target NICK/QUIT rows; BETWEEN reversed; AROUND on an exact @time.

**Wave 3 — federation as a system (closes M5).** Subcommand on `FedRequest` + direction-aware
trim; requester type mask (and presence anchor) on CH Q; `servers_pending` honoured on timeout
and a SQUIT hook over `fed_requests[]`; per-row header-sized chunking for CH R/Z/B/W; re-flood
known ads at END_OF_BURST_ACK; carry local `truncated`; fail-open (no end tag) on slot
exhaustion. Fixes #8 #9 #10 #11 #21 #22. Tests need the multi profile and a long-hostmask
client.

**Wave 4 — one time per event, the rest (closes M4).** Multiline: read the row time once at
mint, arm it for live/S2S, receivers store the origin time; QUIT rows for remote users take the
exit's own msgid (pre-stamp like the KILL path); KICK/NICK/MODE/TOPIC/REDACT arm the event time
on every emission; REDACT context row = msgid mint time; multiline PM service gate; Tier-2
multiline msgid on first line only; targets CF max() + PM cleanup + message-only bump. Fixes
#12-#16, #23. Tests: extend chathistory-time-consistency to every event type across two servers.

**Wave 5 — spec hygiene.** TAGMSG/gap tag gated on message-tags; FAIL context shapes; batch id
alphabet (map `[`/`]` or use a counter-only id); multiline replay line width; PM nick
resolution via stored pair when the live holder's identity has no rows (#19); replay cancel on
own CHATHISTORY (#20: let the client's query coexist, or finish the batch first); the two
policy items in #29 (decide: keep the cap value and document it under evilnet/, rename the gap
tag to `+evilnet.github.io/chathistory-gap`).

**Wave 6 — test debt.** Legacy-peer chathistory suite; AROUND both sides; malformed msgid;
multiline-in-history real assertion; auto-replay with limit; REDACT with event-playback;
federation timeout; presence cross-server.

---


## Presence (dimension 5) — 0 HIGH, 4 MEDIUM, 10 LOW

The walk hook, promote/revive/restore/boot ordering and the boot-close bound re-verified
clean. Findings:

| # | Sev | Finding | Where | Pin |
|---|---|---|---|---|
| P1 | M | `record_union_close` at the interval cap shifts only `pos-1` slots: a PN older than the newest window overwrites `intervals[cap-1]` → the account's NEWEST closed window vanishes on that server. Burst sync sends peers' records oldest-first, so any at-cap account hits it on every relink. | chathistory_presence.c:653-666 | no (cmocka union test never reaches the cap) |
| P2 | M | Interval END = slowest observer's receipt time. Only JOIN, local `#chan` PART via PARTALL, local QUIT and zombie-KICK stamp the event's HLC; ordinary PART closes from `joinbuf_flush` unarmed, remote QUIT/KILL/SQUIT at HLC-now, KICK victims unarmed via `make_zombie`. Every observing server broadcasts PN for every close, and the origin UNIONS the latest end. Messages sent right after a PART/KICK/QUIT become visible after rejoin (latency + skew window). Breaks the header's own "row time == interval edge" contract; same M4 mechanism as the write side. | channel.c:5728; s_misc.c:492; m_kick.c:315,450; chathistory_presence.c:641-643, 777-784 | same-server only |
| P3 | M | Strict presence ON with `draft/metadata-2` OFF: presence CF never opens, `presence_init` fails SILENTLY, `presence_query_filter_open` arms a zero record → every authed user gets an empty "complete" history for every non-+H channel, ephemeral users still work. Looks like an account bug; nothing in logs. | ircd.c:1328; chathistory_presence.c:502-508, 1343-1346 | no |
| P4 | M | `presence_burst_sync` sends PN to ANY EB peer incl. legacy (X3, upstream) — no `IsIRCv3Aware` gate (the CH A S gate 9 lines below has one) — and stops at 20000 lines in key order: X3 relink gets ~1.2 MB of unknown tokens (one error log each); accounts past the ceiling never get their split windows replicated. | m_endburst.c:185; chathistory_presence.c:1076, 1116 | no |
| P5-P14 | L | OFF→ON leaves stale `open_since` for members who left while OFF; AC R with an empty session anchor (legacy hop, no sessid) starts the account interval at auth time; type-mask skips step row-by-row (no seek) so ≥20000 consecutive event rows still empty a page under the scan cap; post-filter re-loads the 4 KB record per row (~101 db_gets per page) and PN fan-out is N×(N-1) RMWs per PART; remote KICK leaves the victim open on the kicker's server for one RTT; `build_acct_key` does not fold the account half while the sibling check compares case-insensitively; seconds-era migration reads an old END as `sec*1000` (loses ≤999 ms, ages out); alias exit purges the primary's session-anchored records (shared `hs_sessid`, only after deauth); delivery-vs-timestamp skew is inherent. | see report | no |

Add to the fix order: **P1 and P3 belong in Wave 0** (P1 is data loss on every relink for
busy accounts, P3 is a silent total outage with a one-line log fix and a fail-loud); **P2 joins
Wave 4** (arm the event time on every close; stop unioning a later observer's end past the
origin's own stamp — the origin's record should be authoritative for its own user's part);
**P4 joins Wave 3** (gate PN on `IsIRCv3Aware`, paginate past the ceiling). The type-mask
seek (P7) is a Wave 2 refinement: skip runs of unreceivable rows by seeking to the next row
whose type is in the mask, which needs a per-type index or a bounded look-ahead — decide there.

---


## Progress (2026-09-06, this session)

Waves 0-2 implemented in the `ircv3.2-hardening` worktree, built, CMocka green, deployed to
the bed, and verified there. Commits: `c319c02` (wave 0), `84b4946` (wave 1),
`637cb82` (wave 2). Findings closed: #1 (double free), #2 (msgid cursor -- code + build,
live pin is a gap, see below), #3 (BETWEEN order+exclusivity -- pinned), #4-#7 (bouncer replay
pipeline: redacted content, type mask, PM crowd-out, own-caps gate -- pinned), #18 (AROUND at T,
ISO fraction -- pinned), plus presence P1 (interval-cap, CMocka-pinned) and P3 (strict-presence
fail-loud). New tests: chathistory-fed-long-row, chathistory-replay-pipeline,
chathistory-cursor-keys; CMocka test_presence_union_close_at_cap.

Wave 3 SHIPPED `e3490fd` (pushed both remotes, live on the linked 2-server bed).  Closed #8
(requester type mask on CH Q, applied in the responder walk with a bare filter when no presence
hook; forwarded across hops; older responders ignore the trailing param), #9 (direction-aware
merge trim: keep_oldest for AFTER/ascending BETWEEN), #10 (timeout/SQUIT with pending responders
marks the page incomplete), #11 (CH R/Z/B lines sized from a measured per-row header instead of
fixed 400), #21 (chathistory_reflood_ads re-advertises known storage servers to a newly linked
peer at END_OF_BURST_ACK), #22 partial (local_incomplete carried into merged completeness;
slot-exhaustion fail-open still residue).  CMocka green; two full 7-suite bed runs green (73/73).

Waves 4-6 not started (one-time-per-event for the remaining types, spec hygiene, test debt).


Wave 4 SHIPPED `b3a323d` + `6d1d0bf` (built, CMocka green, deployed to the linked bed; wide
17-suite regression gate 112/112 green; pushed to both remotes).  Closed #12 (multiline: one time =
the msgid's mint time for row/live/S2S/ml_content; receiver stores the origin's batch time),
#13 (remote-user QUIT rows: ms_quit arms its own line's tags via exit_arm_s2s_event; never the
link stash for KILL/collision/SQUIT; store_quit_events takes the event time), #14 (fallback
multiline replay: msgid on the first line only), #15 (multiline PM service gate), #16 (KICK /
NICK / MODE / TOPIC / REDACT: one event time for row, live tag, S2S tag), #23 + #28 (targets
index: message rows only, max() not overwrite, PM pair keys cleaned), presence P2 (PART in the
batched removal loop and KICK victims via make_zombie now close at the event time -- the
mechanism behind the one-off federated leak), P4 (burst sync gated on IsIRCv3Aware; ceiling
clip logged), and, pulled forward from wave 5 because seen live, #13-low (replay opener never
ends in ';') and #27 (batch ids from the spec alphabet: the client numeric suffix is gone).

Field report during this wave (user, 2026-09-06 evening): after the Seance #32 merge + reload,
"#operserv history in #linux".  Bed reproduction of the reattach opener showed exactly
`@batch=hist196AG]; :srv BATCH +hist195AG] chathistory #chan` (both defects above).  Seance's
parser tolerates both, so the prod trigger for the orphaned inner batch is NOT proven; the
client-side hole that turned an orphan into a misroute is closed in Seance PR #33
(findRequest no longer falls back to pending[0] for a batch that names a target; FAIL keeps
the fallback).  See memory `project_chathistory_audit_2026_09`.


Wave 5 SHIPPED `b1519f4` (deployed to both linked-bed servers as ircd.202609070055; 19-suite
gate 118/118 green at 23:00; pushed to origin + upstream ircv3.2-hardening).  Closed #17 (TAGMSG rows and the gap tag only to message-tags clients), #19 (PM by a
reused nick falls back to the stored pair), #25 (FAIL contexts: `<subcommand> <target>`,
`<window>` on REDACT_WINDOW_EXPIRED, `<target> <msgid>` on FORBIDDEN and fed UNKNOWN_MSGID),
#28 (unknown-nick lookup: filtered 200-cap walk instead of a full targets scan), #29 gap tag
renamed to `+evilnet.github.io/chathistory-gap`, #59 (REDACT refuses non-message msgids), L2
(purge decrements quotas), L11 (aggregate fed cap marks incomplete), L14 (duplicate CH E per-
responder guard), #22 residue (slot exhaustion withholds the end tag), PM gap-marker direction,
blank multiline lines never sent to non-multiline clients.

**Cap value decision REVERSED with evidence.** The user chose "drop `draft/chathistory=<int>`"
on my recommendation; a checkout of goguma (lib/irc/caps.dart + client_controller.dart
_fetchBacklog) shows goguma pages a target's backlog with `max = caps.chatHistory; if (max == 0)
max = 1000` and stops when a page is shorter than max.  A bare cap => max 1000 against our
clamp of 100 => every full page looks short => ONE page per target.  Dropping it would truncate
goguma's backlog.  KEPT, rationale recorded at the advertisement (m_cap.c) and in
FEATURE_FLAGS_CONFIG.md (whose `limit=…,pm=…` form was stale).  User CONFIRMED keep 2026-09-06
23:21 ("doesn't break anything, seems to make goguma work better; likely an extension of
soju").  Scope of the evidence: only goguma's BETWEEN backlog loop reads it (its TARGETS
paging uses ISUPPORT CHATHISTORY); a bare cap only bites when CHATHISTORY_MAX < 1000.

Not done in wave 5 (residue): #20 (a client's own CHATHISTORY cancels its reattach replay --
the per-client ReplayState is single-slot; coexistence needs a second slot or queuing), #26
(a stored concat line over the wire limit is still cut at the buffer; restoring concat
composition needs the split points, lost at store), #73 (unknown legacy msgid => empty page
stamped end; a MESSAGE_ERROR would be more honest), `:full` cannot open access, ephemeral ring
only behind LATEST, permissive unix refs.

Wave 6 tests WRITTEN and GREEN on the wave 5 build (`tests/src/ircv3/chathistory-audit-wave6.test.ts`,
5/5 in the 23:00 gate): AROUND both sides + pivot (msgid and timestamp), unknown/malformed msgid refs
never hang, multiline-in-history (nested batch, msgid on opener only / first line only),
REDACT via history with and without message-redaction, bouncer auto-replay limit + end tag.
NOT constructible on the linked bed: legacy-peer chathistory (nefarious-upstream links only
to hub2, a CRDT node -> needs the mixed-version multi run), federation timeout / peer down at
query time, presence cross-server via the leaf (deferred with the multi run).

### Bed-topology finding (important for testing federation)
The docker `multi` profile's nefarious3-7 build from the `nefarious-crdt` submodule
(branch crdt-mesh @ 8956de7).  Same IRCd codebase as `nefarious`, on a divergent branch that is
BEHIND on the ircv3.2-hardening fixes (so no Wave 0-3 code) and AHEAD on the CRDT-mesh work.  So
the Wave 3 federation code runs only on nefarious + nefarious2 (the linked `-l` bed); nef3-7
federate on the older CH code -- per the user, "crdt can do fed, it just won't be current."  That
makes the multi bed a MIXED-VERSION network of the same IRCd, i.e. the genuine rolling-upgrade
case for the CH wire.  Topology nuance (user, 2026-09-06): some CRDT nodes are PURE CRDT (mesh
only, no P10 tree link) and others still do their primary link as CRDT-over-P10.  CH federation
rides P10 routing, so ONLY the CRDT-over-P10 nodes are reachable storage peers; a pure-CRDT node
never sends CH A S over P10 and is outside the CH wire (reaching it is Tier B mesh-history work,
not this wire).  Hazard closed in `chathistory_reflood_ads`: an ad can linger for a server that
advertised over P10, then retired its tree link into a STAT_MESH_SERVER stub; using that stub as
a %C source SIGSEGVs (crdt skill invariant #2) -- the re-flood now requires exact IsServer(owner).
Useful to verify (a) #21
re-flood (new hub learns nef3-7 ads, relink nef2, nef2 should receive them) and (b) backward
compatibility of the new CH Q trailing mask param (old responders must ignore it; multi-hop
forward must pass it through).  Not yet run -- an available next step.

### Federation x strict-presence intermittent leak (MONITOR)
During the FIRST post-deploy 7-suite run, chathistory-presence-paging leaked hidden rows (5
cases, 7-12 rows each) ONLY with federation on and only that once; 3 isolated runs + a second
full 7-suite run were clean (73/73).  Root: Wave 1 correctly shrinks the local page (event rows
uncounted), so a strict-presence query now federates more often; the responder (and origin
post-filter) can momentarily show the requester present in the absence gap if a remote PN unions
a wider interval (audit P2/F2) or during the post-restart presence transient.  The origin's
presence_filter_messages is meant to be the authoritative backstop.  NOT reproduced after the
post-restart window; likely the boot transient, but the P2 union bug is the plausible mechanism
under load -- fix P2 in Wave 4 and it closes for good.  This is a privacy-relevant item: keep it
flagged.

### Gate-night infrastructure findings (not chathistory)

- 21:12 gate died with Vitest `ENOSPC` after 118 green: root FS 100% (11 GB of stale valgrind
  cores + 7 GB builder cache).  Cleaned; memory `bed-disk-full-cores`.
- The rerun then failed 9 cases with `Timeout waiting for parsed message`: pool01's held bouncer
  session had reached MAXCHANNELS=50 from the unique channels these suites JOIN every run, so a
  checkout revived onto it and every JOIN answered 405.  Fixed in tests/src/helpers/account-pool.ts
  (`killHeldSessions`: oper WHO+KILL of held ghosts at checkout); memory
  `pool-account-session-channel-cap`.
- valgrind on the primary: 16 uninitialised-value hits, one mechanism, bouncer hold persisting a
  never-initialised Membership field (add_user_to_channel -> bounce_db_put).  Pre-existing; memory
  `bouncer-membership-uninit-persist`.

### Residue / gaps opened this session
- **msgid same-millisecond cursor pin.** The fix (seek key carries the msgid) is verified by
  reading, the build, and the build_key/parse_key CMocka layout tests, but is not pinned by a
  live behavioural test: the bed spaces even a single-segment burst ~3 ms apart so same-ms
  same-target siblings are not reproducible from a client, and the history CMocka harness has
  no live-DB query path to craft them. A DB-backed query harness would close it (own task).


## Holistic re-review of waves 0-3 (2026-09-07 00:00) — WAVE 7 SHIPPED (7a `200dc46`, 7b `36d6f10`)

Three parallel read-only reviewers (page builder/cursors, federation, presence), each told to grep
every sibling consumer of the mechanism its wave touched. Every finding below was re-verified by
hand against `b1519f4` before listing. Raw reports: session scratchpad `rr-findings.md`.

### Crash / data-loss (fix first)
- R1 `m_chathistory.c:5819` (CH B) + `:6136` (CH WB): `parc == 7` takes the non-continuation
  branch and reads `parv[7]` (the NULL terminator) -> NULL deref. Server-trust-gated, but R2 is a
  live producer of truncated lines. Fix: `if (parc < 9) return 0;` in both arms.
- R2 `m_chathistory.c:3096-3153`: CH W/WB write-forward still uses the fixed 400-byte
  `CH_CHUNK_B64_SIZE`; header alone reaches 431, msgq cuts at 510. Same class as wave-3 #11 on
  R/Z/B, missed on the sibling path. `CHATHISTORY_WRITE_FORWARD` is ON by default and on both bed
  confs. Fix: reuse `send_ch_response`'s measured `full`/`cont` budget; delete the macro.
- R3 `replay.c:1060-1069`: ATTACH cursor msgid reduced to a timestamp -> `latest_after` floor
  `target\0ts\0` -> same-ms rows after the cursor never replayed (wave 2's exact defect, unfixed
  on the bouncer path). Fix: thread a floor msgid through `history_query_latest_after` /
  `chathistory_page_since` / `replay_start_bouncer_at`.
- R4 `history.c:1801-1805`: reverse-walk floor check `klen >= floor_keylen &&` is dodged by a
  shorter row key; wave 2 made floors full row keys, so a longer client-supplied msgid ignores the
  anchor (LATEST) or returns rows outside the window (desc BETWEEN). Ascending sibling `:2397`
  already compares on min length. Fix: min-length memcmp. (Store-side msgid length is unvalidated.)
- R5 `chathistory_presence.c:420-426`: `record_apply_part`'s coalesce merges the open window into
  the last closed one without lowering `.start`; a PN-unioned window from another connection that
  starts after `open_since` erases the local connection's earlier presence (hide direction; bouncer
  multi-connection is the main audience). Fix: replace the bespoke block with
  `record_union_close(r, open_since, end)`.

### Wrong answers
- R6 `m_chathistory.c:4802-4818` `complete_redact_fed`: `CapActive` (session union) gate on an
  unrouted send -> REDACT to a connection without the cap. `m_redact.c` sets `cap_route_ctx`.
  Fix: `CapRecipientHas`. Same class outside chathistory: `m_markread.c:279`,
  `m_metadata.c:223/:282` (flagged, separate subsystem).
- R7 `m_chathistory.c:4948-5160` `chathistory_auto_replay_fed` (only when
  `!history_is_available()` — no fork node today): CH Q lacks requester token + type mask;
  no `redact_filter_messages` / `history_attach_context`; ignores `since_time`; completeness
  `!fed_truncated` ignores limit (end tag on a full page). Fix: route through the shared pipeline.
- R8 `m_chathistory.c:5571-5592`: fed responder never ORs `fed_hook->truncated`; W/R never
  limit+1 probed -> origin stamps end tag on a scan-capped or full federated BETWEEN page.
- R9 `m_chathistory.c:4581-4585`: `keep_oldest` from ms-only `fed_ref_to_unix` vs walk direction
  by full key -> same-ms selectors: walk descends, merge trims oldest. Fix: expose walk direction.
- R10 `m_chathistory.c:4185`: `merge_messages` orders by timestamp only, no msgid tie-break ->
  same-ms rows from two legs can land in non-key order; next AFTER (now an exact seek) skips one.
- R11 `m_endburst.c:197-208`: `chathistory_reflood_ads` sits inside
  `if (FEAT_CHATHISTORY_STORE && IsIRCv3Aware)`; a relay-only hub (the #21 topology) never
  refloods. Fix: hoist to `if (IsIRCv3Aware(sptr))`.
- R12 `m_chathistory.c:5992`: CH A F relays `parv[3]` after `strtok_r` mangled it -> one channel
  per hop (latent; Layer-1 ads currently ignored by `count_storage_servers`).
- R13 `m_chathistory.c:5615`: CH C context line unmeasured (`client_tags[512]` + ~170 header) ->
  msgq cuts mid-tag, receiver stores the fragment. Fix: measure / cut at `;`.
- R14 `m_chathistory.c:2790` `struct ChunkEntry` `sender[64]`/`account[64]` vs
  `HISTORY_SENDER_LEN` 118 -> long hostmask cut on CH B reassembly (one layer under #11).
- R15 `m_chathistory.c:6138`: CH WB first-chunk type switch lacks `'R'` -> chunked redact stored
  as PRIVMSG.
- R16 `channel.c:1150-1171`: +Z SSL kick sweep calls `make_zombie` without
  `presence_set_event_time` arming (every `m_kick.c` site arms) -> origin/peer stamp divergence.

### Consistency / hygiene
- R17 `chathistory_presence.c:1131` burst sync never emits `open_since` -> interval open across a
  split is never syncable to the peer that lost it. Fix: synthetic `[open_since, now]` PN.
- R18 `chathistory_presence.c:915-939` sibling walk skips alias but not zombie; backfill `:1003`
  skips both. Fix: add `IsZombie`.
- R19 `m_chathistory.c:2462/:5036` TARGETS + auto-replay slot exhaustion don't set
  `fed_start_capacity_miss` (handlers do) -> fail open.
- R20 `m_chathistory.c:5378` legacy fan-out drops ref2/token/mask (pre-existing; BETWEEN answered
  `E 0`).
- R21 header `int64_t` vs definition `time_t` for `presence_record_join/part` + `(time_t)` casts
  `:801` (LP64-only safe).
- R22 PERF `presence_filter_messages` does one `acct_load` per row. Fix: single snapshot.
- R23 Stale comments (6 presence sites: "epoch seconds" vs packed HLC, etc.).
- R24 OK-by-design, decide deliberately: `s_misc.c:393/:440` alias / held-ghost teardown closes
  presence at clock time (no history-row partner).

### Verified clean by the reviewers
All five local handlers via `query_row_filter` + `query_page_complete`; responder installs mask +
veto; ownership / free paths after the merge rewrite (no double free, no leak, timeout vs early
completion, late R, dup E); key builders (no hand-built keys); `ref_to_s2s` keeps msgid on the
wire; AROUND T-1ms; ISO fraction; `e_seen` bounds; R/Z/B budget arithmetic (max 509); reassembly
growth cap; SQUIT cleanup link; mesh-stub `%C` audit complete (4 non-`&me` sources, all guarded);
wave-0 `record_union_close` correct under a 900k-mutation differential fuzz (cap strictly hides,
never grants); all interval writers respect the cap; all readers packed-vs-packed; every lifecycle
edge (JOIN/PART/KICK/QUIT/SQUIT/hold/revive/BX P/anchor transfer) hooked; init order cannot fire a
spurious strict-presence refusal; PN gated `IsIRCv3Aware` both ways.

### Open questions from the reviewers
- SQUIT of an advertised peer mid-query waits the full `CHATHISTORY_TIMEOUT` (3 s on the bed)
  instead of decrementing `servers_pending` at `clear_server_ad` time. Latency budget?
- Fed auto-replay fires a network query even when `open_query_presence` failed closed (all results
  then dropped). Intentional?
- A lowered `CHATHISTORY_PRESENCE_MAX_INTERVALS` trims lazily per record, not at SET time.

### Wave 7 status (2026-09-07 01:10)
- 7a `200dc46` (R1-R5) deployed 00:35, 11-suite gate green once the first suite was rerun
  after X3 relinked (the first run started inside the relink window; trap recorded).
- 7b `36d6f10` (R6-R19, R21-R23) deployed 00:58, 22-suite gate 131/132 + the one CAP LS
  timeout green in isolation.
- `1cba653` membership join_msgid memset deployed 01:26; valgrind uninitialised hits 16 -> 0.
- ALL THREE PUSHED to origin + upstream ircv3.2-hardening 01:35.
- R20 (legacy fan-out drops ref2/token/mask) and R24 (alias/ghost teardown closes presence at
  clock time) left as documented decisions, see below.

### Wave 7c SHIPPED `466f1d3` (2026-09-07 02:30, 17-suite gate 137/137, pushed both remotes)
- #20 -> (b) suspend/resume: the on-demand page is served first, the catch-up state keeps its
  cursor and is reinstalled by replay_cancel; replay_continue reopens the batch. No live pin
  (millisecond window on a local bed); persistence-attach + replay-pipeline cover the path.
- #26 -> (b) re-split at word boundaries: one splitter for all three tiers, concat tag on
  continuations for multiline clients, over-long single line goes into the nested batch. The
  real pre-fix behaviour was "sent whole, over the limit" (1125-byte line), not "cut". Pin.
- #73 -> (a) FAIL MESSAGE_ERROR <sub> <target> <msgid> on BEFORE/AFTER/AROUND/BETWEEN; LATEST
  tolerant (anchor dropped, fed query too). Pin.

### Remaining residue -- decisions were (user 2026-09-07 01:54: #20 b, #26 b, #73 a)

**#20 A client's own CHATHISTORY cancels its reattach replay.** Scope is narrower than the
audit said: the bouncer replay only runs for a chathistory-capable client when it supplied an
ATTACH cursor (bouncer_session.c:7723), i.e. it explicitly asked for server-driven catch-up.
`replay_start_batch` (replay.c:896) then cancels that catch-up on the client's first on-demand
query because ReplayState is one slot per client. Options:
  (a) Queue: an on-demand query arriving during a bouncer replay is parked (one pending slot,
      FAIL CHATHISTORY on a second) and served when the replay ends. Correct, ~60 lines.
  (b) Serve the on-demand query first, then RESUME the bouncer replay from where it stopped
      (ReplayState keeps its cursor; only the in-flight page is re-fetched). Best UX, ~100 lines.
  (c) Keep cancel, but close the outer bouncer-replay batch cleanly and send a NOTICE that
      catch-up was cut so the client knows to page itself. Cheapest; honest.
  Recommendation: (c) now (the client that pages itself gets everything anyway), (b) later
  if a real client depends on the cursor catch-up.

**#26 Stored multiline concat lines over the wire limit are cut at the buffer.** Restoring the
original `draft/multiline` concat composition needs the split points, which are lost at store
time (the store keeps the joined line). Options:
  (a) Store the split points (a small offsets list alongside dyn_content; new CF field, migration
      for old rows = "no split points, cut as today").
  (b) Re-split at replay on a byte budget at word boundaries, tagged `draft/multiline-concat`.
      Not the client's original composition but semantically the same text; no schema change.
  Recommendation: (b). The spec only promises the concatenated text, not the original chunking.

**#73 Unknown legacy msgid => empty page stamped chathistory-end.** A BEFORE/AFTER/LATEST
against a msgid the store never had (pre-repack id, or a client's stale cursor) returns an empty
batch WITH the end tag, which reads as "no more history". Options:
  (a) `FAIL CHATHISTORY MESSAGE_ERROR <sub> <target> <msgid>` (spec: MESSAGE_ERROR is the
      generic "message could not be retrieved" code). Clients then fall back to timestamps.
  (b) Empty batch WITHOUT the end tag (client paging continues but with nothing to anchor on).
  Recommendation: (a) for BEFORE/AFTER/AROUND/BETWEEN; keep LATEST tolerant (spec: an unknown
  LATEST anchor is "the latest messages", the anchor only bounds).

**Open questions from the reviewers**
- SQUIT of an advertised peer mid-query waits the full CHATHISTORY_TIMEOUT rather than
  decrementing servers_pending at clear_server_ad time. 3 s on the bed. Fix is ~15 lines if the
  latency matters.
- Fed auto-replay still fires a network query when open_query_presence failed closed (results
  all dropped). One `if`. Harmless; recommend skipping the query.
- A lowered CHATHISTORY_PRESENCE_MAX_INTERVALS trims lazily per record. Acceptable as is.

## Residue / explicitly deferred

- Federated responder presence for session-anchored requesters needs the anchor's record on
  the wire (same slot as the type mask) — design item inside Wave 3, not a quick fix.
- `history_redact_message` stays a no-op by design (audit trail); all hiding is read-side,
  so every read path MUST go through the shared page builder (Wave 1 is the guard).
- RocksDB `history_db_utilization` is hard-coded 0: watermark eviction and the maintenance
  tick are dead; retention is `history_purge_old` only. Not a chathistory-correctness bug;
  noted for the storage owner.
- `history_store_message` logs every store at L_INFO — prod log volume, unrelated.
