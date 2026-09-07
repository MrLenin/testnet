# Strict-presence gate audit (2026-08-30) — pre-enablement findings

**Status: AUDIT COMPLETE, no fixes applied.** Requested by user ("worth auditing some of the history gate mechanics… particularly the presence one"). Feature `FEAT_CHATHISTORY_STRICT_PRESENCE` defaults OFF and is unset on bed+prod — this is preparation for enabling it. Agent audit (Opus) — findings 1, 3, 5 independently confirmed against my own reads of channel.c/replay.c/chathistory_presence.c; rest agent-reported with file:line.

Security property: "cannot read history outside your membership windows". Availability property: "CAN read everything within them". Both directions broken today.

## Security (false visibility) — CONFIRMED
1. **Open intervals never close across restart → unbounded forward visibility.** `presence_record_join` persists `open_since` immediately; `presence_shutdown`/`presence_init` never close/reconcile; `server_die` doesn't exit clients. Any member at shutdown has a forever-open interval on disk: kicked from the channel for a month, rejoin (join no-ops, `open_since!=0`), read the whole month. Defeats the property on the first restart. Needs boot-time close-all-open-intervals (or shutdown flush).
2. **Zombie sweep bypasses the hook** — `channel.c:960` calls static `remove_member_from_channel` directly (`while (remove_member_from_channel(chptr->members));`): open interval never closes. Same exposure without a restart.
3. **Bouncer replay paths are entirely unfiltered**: `replay.c:396` (`replay_next_channel` → `history_query_latest_after` → straight to batch; reached from s_user.c:586/814, m_bouncer.c:178, bouncer_session.c:7674) and `m_chathistory.c:4239/:4368` (fed autoreplay). Only the 7 `presence_filter_and_replay` callers filter. Floor is session detach time + current membership, not presence.
4. **Anchor transition on deauth**: session-anchored interval opened while unauthed stays open forever (part under account anchor misses it); after deauth the stale session record grants all t≥T0 including absences. Transition sites = the same set as the authusers drift fix (sasl_auth.c:626, m_account.c:199/256/451, s_user.c:2396, m_register.c:237, sasl_webhook.c:76) — none touch presence.

## Availability (false hiding) — CONFIRMED
5. **Bouncer primary+alias mutually cancel at JOIN → no interval ever opens.** In `add_user_to_channel`: member linked (channel.c:784) → `bounce_sync_alias_join` (channel.c:803, inside the !CHFL_ALIAS block) recursively adds the alias whose hook sees the primary as sibling → no-op; then the primary's own hook (channel.c:811) sees the alias as sibling → no-op. Any bouncer account with ≥1 local alias gets empty strict-presence batches for every channel, permanently. (PART side ordering is correct.) **Feature unusable for bouncer accounts — the target workload.**
6. **Presence records are server-local, never replicated** — reconnect via another server / netsplit windows / newly linked servers all hide legitimately-federated history. Structural.
7. **Case-fold mismatch**: presence layer folds ASCII-only while ircd casemapping folds `{|}~≡[\]^` + Latin-1 (`table_gen.c:133`); `session_find` hashes with ASCII fold but compares with `ircd_strcmp` (hash/comparator disagree → dup entries); filter keys on user-supplied target vs join-time chname. Fail-safe direction, silently hides.
8. **Runtime flip-on has no backfill/rehash hook** (`F_B(...,0,0,0)`): pre-existing memberships have no interval until part+rejoin; undocumented (doc/ has zero CHATHISTORY mentions).
9. **FIFO 64-interval cap, no adjacent-interval coalescing** — flaky mobile reconnects (the target workload) silently lose oldest windows within retention.

## SUSPECT
10. Two fail-OPENs in the filter: `!anchor → return count_in` (comment claims fail-safe, code shows everything; reachable in stranded-alias FLAG_ACCOUNT-vs-empty-account states) and `mtime==0 → visible` (federated CH R timestamps not verified numeric end-to-end — unresolved).
11. Session-record leaks: `presence_purge_session` keys on exit-time `cli_session_id` but the field is rewritten mid-life at 7 bouncer sites → orphaned records (heap growth, unfindable); `ephemeral_purge_session` runs before `remove_user_from_all_channels` so session-anchored PART is always a no-op.
12. Clock-skew discard (`end<open_since`) erases the whole window instead of clamping.

## Notes
- CHATHISTORY TARGETS not presence-filtered (metadata leak). OPS_OVERRIDE defaults 1 and grants `:full` bypass to channel ops (policy decision needed before enabling). Redaction-inheritance reads m->content while redact_filter uses dyn_content fallback (agree them). Per-JOIN/PART ~4KB read-modify-write on every server for every user network-wide (perf). Filter drop-log at L_INFO is noisy/identifying.
- Coverage: 2 cmocka cases on interval algebra only; hooks/anchors/filter/persistence/transitions untested.
- Ruled out clean: sibling self-exclusion ordering, alias part ordering, hold/revive/promote/BX X interval continuity, exit paths, fed requestor identity, PM handling, retention compaction, +H consistency, uint8 cap guard.

## Disposition (to agree with user)
Fix-before-enable minimum: #1 (boot-close open intervals), #2 (zombie sweep hook), #3 (filter the bouncer replay paths), #5 (alias sibling cancel — e.g. skip CHFL_ALIAS members in `anchor_sibling_in_channel`, or hook before `bounce_sync_alias_join`), #10 (fail-closed on !anchor). #4/#11 fold into an anchor-transition helper mirroring `channel_account_adjust` (same chokepoint sites). #6 is a design decision (replicate vs document server-affinity). Cross-ref: [[chathistory-missing-history-msgid-investigation]], authusers fix commit `4b92b1a`.

## Fix status (2026-08-30, hardening wave)
IMPLEMENTED (single commit on ircv3.2-hardening after 3afb78c):
- #1 boot-close: last-alive stamp (meta row, refreshed each maintenance sweep) + presence_init sweep closing stale open intervals at last-alive (clamped >= own start).
- #2 zombie sweep hooks presence_on_channel_remove per member.
- #3 all three unfiltered replay paths now call presence_filter_messages (replay.c channel leg, fed autoreplay local + merged legs).
- #5 anchor_sibling_in_channel skips CHFL_ALIAS memberships (bouncer accounts get intervals again; promote-order keeps continuity).
- #10 fail-closed: !anchor drops all (logged), mtime==0 hidden.
- #4/#11 presence_anchor_transfer() at all account transitions (same sites as channel_account_adjust; open-interval START carries across auth/rename; deauth closes account side, opens session side; sibling-aware) + presence_purge_session before all 7 sessid rewrites in bouncer_session.c.
- #7 case-fold now uses ircd ToLower (rfc1459 + Latin-1); old ASCII-fold rows age out via retention.
- #8 flip-on backfill via feature notify (presence_backfill_now walks all channels).
- #9 30s reconnect coalescing in record_apply_part; #12 skew clamp to zero-length instead of discard.
- cmocka: wraparound fixture spacing widened past the coalesce window + 2 new tests (coalescing, skew clamp). Vitest: chathistory-presence-transition.test.ts (REGISTER mid-membership: pre-auth window visible, pre-join hidden).
STILL OPEN (deliberate): #6 replication: USER DECISION 2026-08-30 — metadata-layer replication (presence intervals as account-scoped metadata riding the existing MD/LMDB network-wide machinery, same shape as readmarkers); implementation queued as the next strict-presence chunk, CHATHISTORY TARGETS presence leak (metadata), OPS_OVERRIDE default-on policy call, redaction dyn_content agreement (benign today), filter drop-log verbosity.

HOST-GATE NOTE 2026-08-30: recv_classify_cmocka fails 6 cap-boundary tests on the HOST (config.h/configure divergence artifact — link set untouched by any wave, image gates compile it fresh and pass). Docker image gate is canonical; host cmocka gate must use `make cmocka` (bare make skips the suites — a vacuous-gate trap that bit twice today).

## #6 implementation sketch — metadata-layer replication (user-ratified 2026-08-30)
Follow the READMARKER precedent, not client-visible METADATA keys (METADATA_VALUE_LEN=1024 too small for a 256-interval record; readmarkers already use a dedicated DBI in the metadata LMDB + their own MR broadcast, network-wide on every server).
- **Storage**: move account-anchored presence records from the history-env CF into a dedicated DBI in the metadata LMDB (same durability domain as readmarkers; "available on ALL servers" by construction once replicated). Session anchors stay in-memory/local (connection-scoped by nature).
- **Wire**: broadcast interval CLOSE events S2S (join opens are already observed network-wide via P10 JOIN/BURST; what diverges is closes during splits and pre-link history). Shape: piggyback on the MR/MD family — `PR <account> <channel> <start> <end>` closed-interval announce, propagated butone like MR.
- **Merge = interval-set UNION** (monotone, CRDT-flavored): the user's own server's observations are authoritative for their presence; union is availability-correct and security-correct (a window one side recorded as absence during a split WAS presence per the origin server). Union + the existing FIFO cap + retention truncation = bounded state.
- **Link-time catch-up**: on burst/link, exchange per-account record digests or just lazily heal via the close-event flood going forward + accept that pre-link history fills in as PR events arrive (option: a PR sync for accounts with active members, bounded).
- Order of work: (1) DBI move + PR token + union merge, (2) burst catch-up policy, (3) retire the per-server history-env presence CF (migration: read-old-write-new for one release).

## #6 IMPLEMENTED (2026-08-30, second chunk) — PN replication
- Account presence records moved to the METADATA env (dedicated "presence" CF beside readmarkers; presence_init relocated to ircd.c after metadata_lmdb_init — history_init runs earlier and its env is the wrong domain). Feature never enabled anywhere → no data migration needed.
- New S2S token `PN` ("PRESENCE"): `PN <account> <channel> <start> <end>` closed-interval flood, MR-pattern butone relay, handler ms_presencesync in m_markread.c; applied regardless of local feature setting (readmarker parity — data stays warm), no-op without the env.
- Emit: presence_record_part's account branch broadcasts the just-closed window (feature-gated + server-init-gated). Session anchors never replicate (connection-local). Boot-close sweep does NOT broadcast (no links yet at boot — residue noted).
- Merge: record_union_close — sorted insert, overlap/30s-adjacency union, open interval untouched, FIFO cap honored; idempotent + order-independent (flood-safe). Pinned by cmocka test_presence_remote_close_union.
- Residue/open: link-time catch-up (pre-link history fills only as future PN events arrive — bounded PR-sync on burst is the sketched follow-up); PN not yet in P10_PROTOCOL_REFERENCE.md (doc when wave lands).

### PN residue: far-side detection-lag over-grant (inherent, bounded)
A member observed by a peer BEFORE that peer notices a split gets its interval closed at the peer's TEARDOWN time, not the true part time — union with the origin's true window cannot shrink it (union is monotone; origin-authoritative). Over-grant is bounded by the peer's dead-link detection lag (worst case ~ping timeout). Accepted: messages sent within that lag after a mid-split part may be visible via that peer. Shrinking would require provisional/retractable intervals — deliberately not built. Found via the split-heal test's first red (postId leak); test now waits for far-side teardown before opening the window under test.

### Note: 1-second interval granularity
Presence intervals are epoch-second with inclusive ends; a message in the same wall-clock second as the closing part truncates onto the interval end and stays visible (sub-second over-grant, inherent to the record format). Tests asserting gap-hiding must cross a second boundary (replication tests use >1.4s sleeps).

GATE-DISCIPLINE NOTE (bit three times 2026-08-30): any `; FAIL=0` or bare `;` after an && chain makes the cmocka gate vacuous when an earlier step fails (loop over zero binaries → green). Gates must use set -e / explicit if-blocks AND assert the built-suite COUNT (>=20) before iterating.
