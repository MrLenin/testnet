# Recent Work Inventory — 2026-04-25 → 2026-05-04

Mechanical map of changes in the past ~10 days. **Facts only — no quality judgments.** Use this to decide what to keep, drop, isolate for human review, or treat as suspect.

## Scope summary

| repo | commits in range | aggregate diff |
|------|------------------|---------------|
| testnet (parent) | 0 | unchanged since 2026-04-23 |
| nefarious (submodule) | 150 | 77 files, +9295 / −4192 |
| x3 | 0 | unchanged |
| libkc | 0 | unchanged |
| nefarious-rs | 0 | unchanged |

All work is in the `nefarious` submodule. Date range for that submodule: `0b3cc9c` (2026-04-25 19:42) through `95895cd` (2026-05-04 16:58).

## Files with the largest changes

| file | net lines |
|------|----------:|
| ircd/bouncer_session.c | +3215 |
| ircd/history.c | +2945/−2945 |
| ircd/metadata.c | +999 |
| ircd/db_rocksdb.c | +872 (new file) |
| ircd/m_batch.c | +855 |
| ircd/m_bouncer.c | +558 |
| ircd/webpush_store.c | +546 |
| ircd/send.c | +439 |
| ircd/m_nick.c | +324 |
| include/bouncer_session.h | +186 |
| include/db_env.h | +139 (new file) |
| include/db_txn.h | +131 (new file) |
| include/db_cursor.h | +101 (new file) |

## Cluster A: Phase 7 — libmdbx → RocksDB storage swap

**Commits:** 31 (07c4792 through 95895cd, plus tail fixups)
**Aggregate diff:** 25 files, +3464 / −3265 (mostly self-cancelling — replacing libmdbx API calls with `db_*` abstraction layer)
**Files touched:** `ircd/history.c`, `ircd/metadata.c`, `ircd/ml_content.c`, `ircd/webpush_store.c`, `ircd/bouncer_session.c` (storage boundary only), `ircd/db_rocksdb.c` (new), `include/db_*.h` (new), `configure.in`, `Dockerfile`

**Sub-stages (ordered):**
- `07c4792` introduce db_* abstraction layer (libmdbx backend)
- `7382d99` implement RocksDB backend (db_rocksdb.c)
- `e45a4f6` … `12bc1be` convert metadata.c, ml_content.c, history.c boundaries to db_*
- `941bd95` … `d651303` convert history.c hot paths
- `3fa2f97` reshape reply_index DUPSORT → flat-key
- `3fb5e02` dual-backend Dockerfile
- `3a715e2` … `7b446a5` drop libmdbx-specific blocks
- `7e0b758` delete db_mdbx.c + transitional helpers
- `bff5e25` strip libmdbx from configure.in + Dockerfile
- `2903b80` rename m_mdbx → m_store, /MDBX → /STORE
- `ea4685b`, `95895cd` build fixups

**Character:** Boundary swap. Most line churn is mechanical (libmdbx call → db_* call). Two genuinely new pieces: `db_rocksdb.c` (the RocksDB backend implementation) and the reply_index reshape from MDBX_DUPSORT to flat-key encoding.

**Verifiability without trust:** Container builds, server starts, basic IRC ops work, `/STORE INFO` returns reasonable output, history queries return data. These are runtime-observable facts.

## Cluster B: Bouncer state-machine logic (BX R / split-brain / held-ghost / SQUIT)

**Commits:** ~50, spread across 2026-05-01 to 2026-05-04
**Primary file:** `ircd/bouncer_session.c` (now ~7300 lines per `wc -l`; +3215 net in this period)

**Major sub-clusters:**

### B1: BX R reconcile introduction
- `2955853` feat: BX R — bouncer session reconcile across S2S burst (initial implementation)

### B2: BX R fixes (multiple iterations)
- `6c22f3c` BX R winner side suppresses standard m_nick collision
- `498f156` BX R cross-sessid split-brain reconcile
- `6fe08e8` BX R split-brain reconcile + remove broken eefef52 yield path
- `4c376cf` BX R reconcile — origin gate + reset state on local-loses
- `a24d136` BX R reconcile must emit for active local-origin sessions too
- `7d8a86a` BX R yield must broadcast Q to clean up phantom ghosts
- `02b6604` BS C reconcile must broadcast Q to clean up phantom ghosts
- `961b5e1` BS C reconcile must match existing session origin
- `463f8b3` BX R active-vs-active split-brain demotes loser to alias
- `6d1c238` stop BX R reconcile ping-pong loop
- `a5db86f` retry deferred active-vs-active demotes at EOB
- `784b367` break BX R split-brain deadlock via held-ghost yield
- `45015b1` silent destroy in BX R held-ghost yield (no spurious legacy QUIT)
- `ea9b0af` m_nick split-merge consults BX R verdict before refusing

### B3: Held-ghost / N-burst handling
- `731cc7a` pre-burst BX R reconcile + burst hold ghosts as N
- `1aaeecb` burst hold ghosts via N; drop post-revive N+JOIN re-emit
- `4d52a39` **revert** of `1aaeecb`
- `8db7a36` server_estab: skip held-ghost N burst to non-IRCv3-aware peers
- `6d652c9` **revert** of `8db7a36`
- `8a433f1` held-ghost destroy uses BX X (no QUIT generation)
- `33281dc` introduce revived ghost to peers via N before BS A
- `f9c32e1` re-JOIN revived ghost's channels so peers refresh membership

### B4: BX F handshake
- `df8c361` synchronous BX F reconcile-before-burst + legacy-side-wins tiebreaker
- `1738050` gate has_legacy tiebreaker on peer support
- `a9e4cf0` gate BX F handshake on dedicated FLAG_BXF_AWARE
- `0d459de` fix BX F handshake regressions causing primary-split-brain

### B5: m_nick split-merge logic
- `f632c5e` hoist live-primary split-merge out of IsBouncerHold gate
- `eb8a0d1` symmetric live-primary split-merge — winner side skips m_nick
- `bc36e75` live-primary split-merge demote for graceful net-rejoin
- `eefef52` split-merge silent yield in rebind for restore-pending mismatch
- `c3f74b2` held-ghost split-brain winner silent-drops instead of KILL
- `519e0d1` refuse to kill account-bearing local user for unauth incoming
- `e3cdb55` defer mid-SASL Unknown clients on N collision
- `230ea1e` use session origin as split-merge tiebreaker

### B6: SQUIT promotion ordering
- `81fa8d7` SQUIT alias promote must run before exit_downlinks
- `4cafcd1` don't null hs_client in prepare_squit; let promote remove channels
- `a0c69e0` execute SQUIT promotions before broadcasting SQUIT to peers

### B7: Demote / promote (active-vs-active)
- `6e861f4` bounce_demote_live decrements user->joined on flip
- `a97f7e8` legacy QUIT for demoted primary in active-vs-active resolution
- `bb7ce43` drop legacy-wins; legacy uses native BX P + Q for primary changes
- `6129785` always hold on primary disconnect; promote only at hold expiry

**Character:** New protocol logic. Wire format invented (BX R, BS C, BS A, BS T, BX F, BX X, BX P, BX U) and iteratively reshaped. Reverts in B3 and reshape in B7 are markers of design churn — code went out, came back, went out again with different shape.

**Verifiability without trust:** No external referent. Behavior depends on multi-server S2S timing. irctest doesn't cover bouncer-protocol semantics. Runtime testing requires reproducing specific multi-server collision races, which is the territory tonight's two failed reproductions came from.

## Cluster C: BX-protocol extensions for IRCv3 features

**Commits:** ~25
**Files:** `ircd/bouncer_session.c`, `ircd/m_batch.c`, `ircd/ml_content.c`, `ircd/m_bouncer.c`, `include/bouncer_session.h`

### C1: BX M (multiline alias echo)
- `3abd4b5` BX M — multiline-aware bouncer alias echo across S2S
- `f85f0b1` Forward to remote multiline alias via CMD_MULTILINE batch
- `8c70a25` User-source BATCH wrapper for multiline batches
- `f3f2ef1` Sweep buffered BX M batches when alias is destroyed
- `b517453` Free S2S multiline + BX M batches on link drop
- `2ff30be` Forward-declare free_s2s_multiline_batch
- `6213ff1` Forward-declare s2s_bxm_cleanup_alias + hoist bx_drain_in_progress

### C2: BX U (per-alias cap discovery)
- `7abf95d` Per-alias cap discovery via BX U caps= for BX M dispatch
- `99e27a5` send BX U caps in bounce_burst alongside BX C per alias

### C3: BX C / BX J / pending-BX deferral *(entangled with cluster B — same flailing surface)*
- `7b15014` Defer BX subcommands targeting unknown alias until BX C arrives
- `ad6bd9a` pending-BX drain must replay in insertion order, not slot order
- `999af7e` BX J for cross-server alias channel-attach + JOIN msgid parity
- `f3fb834` m_join: skip duplicate JOIN when alias already auto-attached

These are wire-ordering / burst-race / cross-server alias-state fixes — same territory as B's BX R reconcile and split-brain handling. Treat C3 as part of the suspect surface, not as separate cleanly-shipped protocol work.

### C4: Multiline DM mirroring
- `2527cd4` Cross-server multiline DM alias mirroring + downstream discount
- `aafa790` Mirror multiline DMs to bouncer aliases via proper batch wrapper
- `f5fb37c` **revert** of an earlier multiline mirror attempt
- `a9ed18e` Mirror multiline DMs to bouncer aliases
- `41b8024` Skip local DM delivery when recipient is on another server
- `639ff0b` Multiline DM echo + truncation NOTICE tagging

**Character:** New wire-protocol subcommands for the bouncer. Most fixes are about delivery semantics, batch lifecycle, and ordering invariants. One revert in C4.

## Cluster D: IRCv3-aware S2S framework + compact tags

**Commits:** ~14, mostly 2026-04-29
- `e377159` IRCV3-aware S2S framework — link-time capability flag
- `cab0db4` sendcmdto_serv_butone_v3() helper
- `350769a` Gate fork-only S2S token emissions on FLAG_IRCV3AWARE
- `68002cb` Parse compact-tag ,C<client_tags> segment on S2S receive
- `3bf7fa8` Wire S2S-incoming client tags into local relay
- `45e5479` format_s2s_tags_with_client() — compact-tag with ,C segment
- `e463cc9` Emit ,C<client_tags> S2S in channel message relay
- `54be562` Emit ,C<client_tags> S2S on direct private messages
- `f90c503` Advertise IRCV3AWARE in initial SERVER handshake
- `fa58020` per-peer tagged/untagged buffer split in S2S broadcast
- `608b324` gate sendcmdto_one @A emission on FLAG_IRCV3AWARE
- `96816cb` legacy-peer S2S DM keeps @A msgid prefix
- `1134b78` **revert** of `96816cb`
- `d63236e` Drop verbose-format S2S parser path

**Character:** New framework wiring per-peer protocol-aware S2S delivery. One revert.

## Cluster E: Multiline limits + paste listener

**Commits:** ~7, 2026-04-29 to 2026-04-30
- `b276109` Add multiline buffer ceiling/shrink-delay feature flags
- `d7a3dba` Enforce network-wide multiline limits on S2S batch receive
- `eea88ed`, `e29ce5b` discount logic
- `e94ae0d` Multi-bind paste listener via Port { paste = yes; }
- `b5d950e` Accept '[' and ']' in paste IDs
- `419f8b0` Move paste URL outside bracketed truncation count
- `a707943` Truncation notice always from server; bypass +N

## Cluster F: ISUPPORT / IRCv3 spec compliance

**Commits:** ~5, 2026-04-29
- `1e501f1` Advertise ACCOUNTEXTBAN ISUPPORT (IRCv3 #587)
- `82fe6aa` Advertise no-implicit-names ratified name (IRCv3 #590)
- `34b3a74` Recognise legacy +draft/reply alongside ratified +reply
- `cb63feb` Advertise EXTBAN as the canonical ISUPPORT token
- `788cedd` Drop EXTBANS, advertise only canonical EXTBAN
- `95ad8fa` Keep CAP_draft_no_implicit_names as deprecated config alias

**Character:** Spec compliance / token advertisement. Mostly small string changes.

## Cluster G: Counters / lifecycle / diagnostics

**Commits:** ~7
- `2314011` Plug counter leaks; add STATUS/LISTSESSIONS-all/HELP
- `508aeed` Account holding ghosts in UserStats.local_clients
- `4207633` Run require-sasl reject before Count_unknownbecomesclient
- `c0d97b6` Underflow guard + caller logging for UserStats.unknowns
- `6f66554` log instead of assert in ip_registry_disconnect underflow
- `8912d98` **revert** of `6f66554`
- `64febb0` hs_pending_demote_peer ircd_strncpy size

## Cluster H: Other small fixes

- `0b3cc9c` Skip MONITOR/WATCH notifications for bouncer alias lifecycle
- `d7fff0c` watch: suppress LOGOFF when nick still online via another client
- `ff02b3e` alias /nick must split S2S delivery
- `911d664` AWAY broadcast must use alias-aware S2S source selection
- `f192461` drop spurious NULL in sendcmdto_one_tags_ext args
- `88cca2e` tag bounce_destroy call sites for diagnosis
- `d7559e3` BOUNCER ORESET — oper-targeted session reset by account
- `00f6e6d` BOUNCER RESET subcommand for clean session teardown
- `5ab703d` Bouncer alias↔primary mirror across identity, burst, and AWAY paths
- `0f38988` Restore sendcmdto_one_tags_with_client arg count
- `f6f05e5` gate ghost rebind on session origin = introducing server
- `d38fe69` bounce_db_restore must respect FEAT_BOUNCER_ENABLE
- `dee294f` gate revive N+JOIN replay on was_restored to prevent dup-N collision

## Cluster I: Merges

- `c0087b0` Merge upstream/master into ircv3.2-upgrade (2026-04-30)

## Reverts in range

| revert commit | reverts | within cluster |
|---|---|---|
| `8912d98` | `6f66554` (assert→log diag) | G |
| `6d652c9` | `8db7a36` (skip held-ghost N burst to legacy) | B3 |
| `b05bbe8` | `a84edd3` (suppress channel notification on bouncer-internal QUIT) | B |
| `4d52a39` | `1aaeecb` (burst hold ghosts via N; drop revive re-emit) | B3 |
| `1134b78` | `96816cb` (legacy-peer S2S DM @A prefix) | D |
| `fd3a095` | `5d756b1` (short-circuit downstream-fragment walk on non-IRCv3) | C/D |
| `f5fb37c` | `a9ed18e` (mirror multiline DMs to bouncer aliases) | C4 |

7 reverts in 150 commits = ~4.7%. Concentrated in B3, C4, D.

## What this map is and isn't

This is a **mechanical inventory**. Every claim above is verifiable from `git log` / `git diff`. There is no quality assessment, no recommendation about what to keep, drop, or rewrite. That's your call.

If you want a human review, the natural slice points are the cluster boundaries: Phase 7 (A) is largely orthogonal to bouncer logic. The suspect surface is **B + C3** — wire-ordering, burst-race, BX R reconcile, and cross-server alias state are one tangled area, not two cleanly separable ones. C1, C2, C4, D, E, F, G, H are not part of that tangle.
