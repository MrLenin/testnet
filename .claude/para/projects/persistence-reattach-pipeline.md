# Reattach pipeline: pre-001 ATTACH + client-anchored catch-up cursor (design)

**Status:** SHIPPED 2026-08-28 — nefarious `9bc57d4` (ircv3.2-hardening / evilnet ircv3.2-upgrade). Bed down at build time: attach tests written per spec, not live-run.
Covers gist residual gaps 1 (post-001 attach RTT) and 2 (server-computed
delta) of the mobile-seamless-sessions writeup — they merge into one
protocol change.

## Facts (verified in tree @ 7a47da1)

- **ATTACH is already pre-registration.** parse.c's PERSISTENCE entry
  deliberately uses `m_persistence` in the UNREG slot; ATTACH works in the
  SASL-complete/pre-CAP-END window via `persistence_account_for()`'s
  `IsSASLComplete && cli_saslaccount[0]` branch, and is *refused* once
  registered (`IsUser` gate — registration-window-only by design). Its
  entire effect is pinning `con_active_profile`. So the gist's "attach
  costs its own round trip" is already false for the profile half: the
  attach rides the pipelined registration flight today.
- **All replay machinery is timestamp-cursor based.** `replay_start_bouncer`
  takes a `time_t`; store queries are `target|timestamp|msgid`-keyed and
  per-target. Channel legs advance past account read-markers; PM legs use
  `history_query_targets` (and do NOT consult read-markers — parity gap).
- **msgid → global timestamp exists**: `history_msgid_to_timestamp()` is a
  target-independent lookup against the msgid index (returns -1 for
  evicted/never-stored). No cross-target AFTER-msgid query exists and none
  is needed (see below).
- **No server-side delivery cursor exists** (BouncerSession has only coarse
  time_t fields), and adding per-message delivery tracking would be
  invasive bookkeeping on the hot send path.

## Design decision: client-anchored, server-driven

The gist's gap 2 imagined the *server* tracking what was delivered. The
client already durably knows its last-seen msgid per buffer (its §6
contract) — and one *global* msgid anchor suffices because
`history_msgid_to_timestamp` gives a total-order cursor. So: the client
supplies its newest globally-last-seen msgid; the server converts it once
and drives the existing replay machinery from that point. No new store
index, no delivery tracking, no new query shape.

## Protocol

```
PERSISTENCE ATTACH <profile> [<msgid>]
```

- Optional trailing `<msgid>`: the client's last-seen msgid (any buffer —
  the newest it holds). Registration-window-only, same as ATTACH today.
- Advertised via a new token in the draft/persistence CAP value
  (e.g. `attach-cursor`), alongside the existing `list`/`attach` tokens.

Pipelined flight becomes:
`CAP REQ … / AUTHENTICATE … / PERSISTENCE ATTACH work abc123 / NICK / USER / CAP END`
— one write; 001 arrives with revive + replay already cursor-anchored.

## Server behavior

1. Stash the cursor on the Connection next to `con_active_profile`
   (`con_attach_cursor[MSGID_LEN]`), propagated temp→ghost at the same
   site that propagates the profile (bouncer_session.c ~5503).
2. At the four `replay_start_bouncer` trigger sites, if a cursor is
   pinned: `history_msgid_to_timestamp()` once; use that timestamp as
   `since` instead of the idle/disconnect-derived one. (Client cursor may
   be older than the disconnect point — trust it; the replay limit caps
   volume. Channels still advance past read-markers as today.)
3. **Unknown/evicted msgid:** do not fail silently (current callers'
   habit). Reply `FAIL PERSISTENCE CURSOR_UNKNOWN <msgid> :…`, then fall
   back to the server-derived since-time so the client still converges —
   the FAIL tells it a full resync may be warranted.
4. **Chathistory-cap interaction:** today auto-replay is skipped when the
   client negotiated `draft/chathistory`. An explicit cursor is an explicit
   request for server-driven catch-up: run the replay even for
   chathistory-capable clients when (and only when) a cursor was supplied.
   This is the entire gap-2 win — the TARGETS + N×AFTER dance collapses
   into one server-driven batch the client msgid-dedups as usual.

## Residue / explicitly out of scope

- PM read-marker parity (PM legs don't consult read-markers) — separate,
  pre-existing.
- Federated (no local store) fallback remains channels-only, timestamp-only.
- Nothing changes for clients that don't send the cursor.
- **Ordering decision (2026-08-28):** the backfill stays sendq-aware
  (paced) and may interleave with newly-arriving live traffic at batch
  boundaries; no backfill fence. Clients order by server-time and dedup
  by msgid (the gist's §6 contract). Note the recv side is already
  favorable: the catch-up trigger fires inside the revive path, so
  backfill batches enqueue before any client-pipelined post-registration
  commands are parsed.

## Size estimate

~80-120 lines: parser arg + CAP token + Connection field + propagation +
cursor override at 4 trigger sites + FAIL path. Vendored spec docs
(areas/draft-persistence-spec.md, projects/persistence-spec.md) gain the
`[<msgid>]` arg + token. Tests: pipelined-ATTACH-with-cursor +
evicted-cursor fallback in persistence suites.
