# Strict presence: millisecond granularity

**Status:** IMPLEMENTED 2026-09-02 (user: "I think it should be done") as three commits on
`ircv3.2-hardening`: row stamping = event time (`chathistory: a message has one time`), the live
`@time` carrying the same event time (`send: the live @time carries the event's time`), and
HLC-stamped presence (`presence: intervals stamped with the event's HLC, so same-millisecond
events order`). **Design change during implementation:** the bed showed milliseconds alone still
leak — the witness's message and the JOIN land in the same millisecond on a local bed (and on a
busy channel), and a millisecond stamp cannot order them. Presence time is therefore the event's
HLC packed as `(ms << 16) | logical` (the msgid embeds both), with the JOIN's msgid minted
*before* the membership hook so the interval opens at the JOIN's own stamp. cmocka 10/10; bed
verification below. Parent: `chathistory-presence-paging.md`.

## The gotcha

Message rows carry millisecond timestamps (`"%lu.%03lu"`); presence intervals store whole
seconds (`open_since`, `intervals[].start/end` are `int64_t` epoch seconds) with inclusive
edges, and `parse_history_seconds` truncates a row's stamp before comparing. A row in the same
second as a JOIN is "present" even if it was sent before the JOIN; same for the PART second.
Never hides real presence; leaks ≤1s of pre-join / post-part content at each edge. Bit the
anchor-transition test (join landing in the pre-join message's second) and needs spacing in
every presence scenario.

## Clock model (the crux — decided by reading, not by preference)

**Today (a bug, flagged by the user 2026-09-02):** every server stamps the rows it stores with
**its own clock at observation time** — `ircd_relay.c:567/724/881/976` (`gettimeofday`; the
remote relay sites take the shared msgid from the incoming tag but never `cli_s2s_time_ms`),
`channel.c:138` (`store_channel_event`, JOIN/PART), `m_tagmsg.c:172`. Yet the **live** `@time`
delivered to that server's clients is the origin's tag time (`send.c:553`), and TOPIC/KICK/MODE
rows already store the tag time (`m_topic.c:167`, `m_kick.c:416`, `channel.c:2770`). Consequences:
the same msgid has a different `time` live vs. replayed on every non-origin server; the
msgid→timestamp index differs per server, so a `BEFORE msgid=` anchor resolves to a different
point on each responder; federated merges sort rows from different servers by clocks that
disagree by the link latency; and presence edges skew the same way.

**Decision: fix the rows first, then presence follows one rule — event time = the S2S tag time
when present, else the local HLC.** This is safe because `parse.c:1886` already feeds every
incoming tag into the HLC (`hlc_global_receive`), so any local event after receiving a remote
message gets a time ≥ the remote's: causal order across servers holds regardless of NTP skew,
which is the property a raw local clock cannot give. Row side: the four relay sites and
`store_channel_event` use `cli_s2s_time_ms(cptr)` when set (the joinbuf already carries it as
`jb_msgid_time_ms` since `d55797c`), else `hlc_global_event()` — the same choice `send.c` makes
for the live tag, so live and replayed `time` agree. Presence side: the hooks take the same
event time (tag for remote JOIN/PART, HLC for local), in milliseconds. Existing rows keep their
old stamps; keys are sorted per channel so mixed stamps only wobble ordering by latency within
the retention window.

This supersedes the earlier "local clock everywhere" draft of this section, which was correct
only as long as the rows stayed on the local clock.

Ordering guarantees already hold on one host (single-threaded, sequential):
- JOIN: `add_user_to_channel` → `presence_on_channel_add` (opens) runs **before** `memb->join_tv`
  is taken (`channel.c:5549`) and the JOIN row is stored → `open_since ≤ row.ts`. ✓
- PART: `part_tv` is taken (`channel.c:5466`) and the row stored **before**
  `remove_user_from_channel` → `presence_on_channel_remove` (closes) → `end ≥ row.ts`. ✓
- KICK/QUIT: rows stored in `m_kick.c` / `s_misc.c` with `gettimeofday` before the removal path;
  verify at implementation time, same shape.
So inclusive edges stay correct at ms resolution; no need for the exclusive-edge alternative.

## Changes (file:line from the 2026-09-02 tree)

### `ircd/chathistory_presence.c`
- Units: `open_since`, `start`, `end` become epoch **milliseconds**. Struct layout unchanged
  (`int64_t`), so `sizeof(struct presence_record)` and the `acct_load` size check are untouched.
- `record_apply_join/part` (299-352): `time_t when` → `int64_t when_ms`. Coalescing literal
  `+ 30` at 325, and in the union merge at 535 and 565 → `PRESENCE_COALESCE_MS` (30000).
- `record_was_present` (356), `record_next_visible` (~697-725): compare ms.
- `parse_history_seconds` (1047) → `parse_history_ms("sec.mmm")` = sec×1000+mmm; callers at
  1094 (post-filter), 1124 (redact parent), 1171 (walk hook).
- Hooks: `presence_on_channel_add/remove` (832, 855), `presence_backfill_now` (879),
  `presence_anchor_transfer` (918, 943): `CurrentTime` → `presence_now_ms()` (`gettimeofday`).
- `presence_touch_last_alive` (380-384) writes ms; boot-close (446-471) reads `last_alive` and
  every `open_since` through the migration helper.
- Retention sweep (1262): `cutoff_ms = now_ms − days×86400000`; interval compares in ms.
- PN emit `presence_broadcast_close` (608, `"%s %s %Tu %Tu"`) and `presence_burst_sync`
  (1002-1003): emit ms (`%lu` on LP64, or a formatted buffer).
- `presence_apply_close` (575): takes ms.
- **Migration helper** `presence_norm_ms(v)`: `v < 100000000000 ? v*1000 : v` (seconds epoch is
  ~1.7e9, ms epoch ~1.7e12; unambiguous for ~50,000 years). Applied on: `acct_load` (each
  field), boot-close iteration, retention-sweep iteration, `last_alive` read, PN receive. Records
  rewrite themselves in ms the first time they mutate; no offline migration, no version field.

### `ircd/m_markread.c` (PN receive, `ms_presencesync` 440-470)
- Parse with `strtoull`, normalize via the helper, pass ms. Relay verbatim (already does).

### `ircd/history.c` (`history_filter_row`, the boundary seek)
- `skip_to` is ms: forward seek key `"%ld.%03ld"` of `skip_to`; reverse: seek `skip_to + 1` ms
  then one `prev`. Progress guard compares against the row's ms (`strtoll` of "sec" is not
  enough — parse the ".mmm" too).

### `ircd/m_chathistory.c`
- TARGETS presence check (~2102): `act = strtoul(last_timestamp)` → ms parse.
- `history_query_targets` row stamps are already ms strings; nothing else.

### `include/chathistory_presence.h`
- Signatures to `int64_t` ms (`presence_record_join/part`, `presence_was_present`,
  `presence_next_visible`, `presence_apply_close`); doc comments say ms explicitly.

### Tests
- cmocka `chathistory_presence_cmocka.c`: `BASE_TS`, `join_ts/part_ts` and the coalescing
  test in ms; the F-CH3 wraparound test's 100-unit gaps must exceed `PRESENCE_COALESCE_MS`
  (use ×100000 ms). Add: same-ms ordering (row at `open_since` ms visible, row 1 ms earlier not),
  coalescing at exactly 30000 ms, migration helper on a seconds-era record.
- Vitest: `chathistory-presence-transition.test.ts` can drop the 1.5s spacing (keep it; harmless);
  `chathistory-presence-paging.test.ts` unchanged; the "same-second" entries in the
  `test-writing` skill become "same-millisecond", i.e. effectively gone.

### Docs
- `P10_PROTOCOL_REFERENCE.md`: PN `<start> <end>` are epoch milliseconds (seconds accepted on
  receive). `test-writing` skill + memory `project_chathistory_presence_paging.md` traps.

## Rollout / compatibility

- **Storage**: forward-compatible in place (magnitude migration); a downgrade would read ms as
  seconds → far-future intervals → history hidden until re-join. Acceptable for prod (no
  downgrade path expected); note it in the commit.
- **PN wire, mixed versions**: an old server receiving ms files a far-future interval — closed
  windows replicated from a new server become invisible there until it upgrades. Prod is one
  fork server and the CRDT fleet is the same code, so no gate is needed today. If a mixed
  fleet ever matters: gate ms emission on a link flag (`FLAG_PN_MS`, announced at link like
  `FLAG_BXF_AWARE`) and emit `start/1000` to old peers.
- **Cross-server edge skew**: goes away with event time — rows and presence on every server
  carry the origin's stamp for remote events and HLC time for local ones, and the HLC receive
  bump keeps local-after-remote ordered. What remains is NTP skew between origins for two
  *different* users' events, bounded by the HLC (a late clock is pulled forward on receipt).
  The origin's post-filter re-check of remote rows becomes exact rather than latency-fuzzy.
- **Row stamping change** (the bug fix that precedes this): four relay sites + `store_channel_event`
  + `m_tagmsg.c`; no storage migration (stamps are opaque sort keys); client-visible effect is
  that replayed `time` now equals the live `time` for cross-server messages. Ship it as its own
  commit, verify with a two-server test asserting live `@time` == CHATHISTORY `@time` for a
  message that crossed the link.

## Ms-only stamps under HLC presence

A row's presence time comes from its msgid (exact inside the millisecond). Two consumers hold
only a millisecond: a row whose msgid does not decode (legacy/foreign) reads as the *start* of
its millisecond — hidden when unorderable, the fail-safe direction for a message — while the
TARGETS listing's last-activity stamp reads as the *end* of its millisecond
(`PRESENCE_TIME_FROM_MS_LATE`), so activity in the join's own millisecond counts as witnessed.
TARGETS has **two** presence checks — the local page and the federated merge
(`complete_targets_fed`) — and both must use it; the bed's storage peers make every TARGETS
federate, so a missed second site hid every channel (`chathistory-targets-presence`). A listing
only names the channel; the rows themselves are still filtered exactly when queried.

## Residue found on the way (pre-existing, not fixed here)

- **Remote QUIT rows** keep a local mint time and msgid: `exit_client` is reached from SQUIT,
  ping-out and KILL contexts where the link's tag stash may belong to an unrelated earlier
  message, so `store_quit_events` deliberately does not consult it. A safe fix needs the QUIT
  handler (`ms_quit`) to hand the tag time/msgid down explicitly.
- **Remote KICKs are not stored at all** on receiving servers: `ms_kick` never calls
  `store_kick_event` (only `m_kick` does), despite the store's "receiver-side storage" comment.
  Event-playback of KICKs is origin-only today.

## Effort & risk

- ~1 day: presence.c ≈120 lines, hooks/receive/seek/targets ≈25, cmocka ≈40, docs; two bed
  build cycles (presence suite + paging/transition/strict-presence/replication files).
- Risks: (1) any hook that fires *after* its row is stored would invert an edge — audit
  KICK/QUIT/SQUIT/`channel_all_zombies` paths at implementation; (2) `ircd_snprintf` 64-bit
  formatting for PN; (3) the walk's reverse seek off-by-one at ms (cmocka-less; bed test).
- Not worth doing instead: exclusive edges (one-liners, but discards up to 1s of real presence
  at each edge); sub-second ordering via stored join msgids (record grows ~8KB, real migration).
