# CRDT-mesh clocktest harness — live findings (2026-07-24, session 1)

Bed: nef3-7 recreated under `docker-compose.clocktest.yml` (hook build `ircd.202607240017`
= crdt-mesh `3eb3228`, valgrind OFF, nef4 `IRCD_FAKE_CLOCK_OFFSET=+30`, others 0).
Driver: `/tmp/crdt4c/clocktest/` (throwaway — ircdrv.py + spike1 + s1_m12 + s2_m15 + s5_m8 +
s5b_diag + s6_m13). Oper = plaintext `oper`/`shmoo`; configs gained `gline/jupe/rehash = yes;`
on the Operator block (all 5 ircdN.conf, in-place edit + HUP — note the per-file bind mounts:
nef3 rw, nef4-7 ro → host-side root write via throwaway container).

## Scenario verdicts

| # | Scenario | Verdict |
|---|---|---|
| spike | clockstep moves CurrentTime live; ± restore; nef4 boot skew +29.8 s visible | **PASS** |
| 1 | M12 same-second gline lastmod collision (nef3+nef5, mid-second fire) | **PASS** — one reason network-wide, converged 1.0 s, reconcile churn = one burst then silent, oplog GC to 0 |
| 2 | m15 skew delete-on-leave (+30 nef4; part; rejoin nef5; re-op) | **PASS** — no stale +o, orphan-reap backstop silent, re-op minted "30 s in the past" lands + sticks on the +30 node |
| 5 | M8 metadata CLEAR no-resurrect | **FAIL = REAL BUG FOUND** (below). Doc layer itself is correct: tombstone minted, converged, store rows reaped on every node |
| 6 | M13 stepped ban expiry tombstone+GC (gline + jupe) | **PASS** — 600 s gline AND jupe minted on nef7, converged; `/CRDT clockstep +700` on nef7 → both bans gone from ALL FIVE nodes in 17–18 s (0-offset nodes drop ~10 min "early" via the doc DELETEs); converged 1.0 s; tombstones GC-drained. The P3-3 "lifetimes too long to wait for" blocker is closed |

## S6 operational notes
- A big forward step is an NTP-step analogue: the stepped node's ESTABLISHED local
  clients look idle→**ping-dropped** (expected server behavior, not a bug); fresh
  connections are fine. Harness probes must tolerate + reconnect (s6 v2 does).
- Do NOT `clockstep` back after a big forward step — absolute-time timers re-armed
  while stepped go silent for the step's duration. **Restart the node instead**
  (env offset re-applies; nef7 re-initiates its own overlays so re-form is fast).
- The stepped node transiently reports `mismatch=1` on its own verify mid-reconcile;
  it clears. mdigest equality across nodes is the oracle, as everywhere else.

## 🐛 FINDING 1 (MAJOR): metadata GET→memory promotion re-animates deleted values

**Symptom (deterministic with polling):** account metadata key SET on nef3 (authed testadmin),
converged everywhere; `METADATA * CLEAR` on nef3; nef3+nef6 clean in ≤1 s, but **nef5 kept
serving the deleted value indefinitely** (>449 s, survives every verify cycle) — while all
five docs/digests were IDENTICAL and nef5's own reconcile logged `0 set, 1 removed`.

**Mechanism (three cooperating pieces, m_metadata.c):**
1. GET serves the **in-memory** client metadata first; on memory miss + LMDB hit it
   **promotes** the store row into the online target's in-memory metadata ("load into
   memory for faster subsequent access", m_metadata.c ~503).
2. CLEAR clears memory network-wide via the legacy MD broadcast (~instant), but on the
   crdt branch the **non-home store rows are reaped by the doc reconcile — up to one
   verify tick (≤30 s) later**.
3. Any GET landing in that gap re-promotes the not-yet-reaped LMDB row into memory.
   The re-promoted copy is then **permanent**: GET always hits memory first, no reconcile
   or reap covers remote users' in-memory metadata, and only the user's disconnect frees it.

Discriminator that proved it: only the node that was GET-polled across the CLEAR went
stale (nef5); a node first queried after the reap (nef6) is clean. First run's "self-heal
after ~5 min" = the test user disconnecting (client struct freed), not a reap.

**Prod exposure:** the promotion + memory-first read exist on the production branch too;
there the store-side clear is broadcast-synchronous so the window is network-thin, but the
same permanent-staleness applies to any GET that races it. The crdt branch widens the
window to a full verify tick → easily hit.

**ROOT CAUSE (deeper than the symptom above) + FIX — RESOLVED 2026-07-24, live-confirmed:**
The re-animation promotion was only the *carrier*. The real defect (FINDING 2 below) is that
`metadata_cmd_clear` emitted **no S2S message at all**, while SET broadcasts and populates every
peer's in-memory metadata. So remote in-memory copies were never invalidated by anything (the doc
reconcile reaps *stores* only).

**Fix — MINIMAL/ADDITIVE (v1 over-reach corrected by a 2nd review):** The first attempt ALSO removed
the three read-time store→memory promotions ("Design A: reads never promote"). A second review
caught two CRITICALs proving that over-reach: (1) `metadata_load_account` is NOT called on every
account-attach path — `register_user` never calls it, and pre-registration SASL / WEBIRC / IAuth /
`MODE +r` / bouncer-ghost / mesh-materialized attaches all skip it (only 4 call sites: m_account ×3,
sasl_auth post-registration) → removing the user lazy fallback loses metadata for those users; (2)
`metadata_channel_load` has ZERO callers → the channel GET-fallback was the ONLY restore path for
persisted channel metadata after a channel empties+recreates. So the promotions are load-bearing
restore paths, NOT the bug. Final fix keeps them and is purely additive:
1. `metadata_cmd_clear` now enumerates the target's in-memory keys and broadcasts the existing
   value-less unset form (`MD <target> <key>`) for each before clearing — receivers apply via
   `ms_metadata → metadata_set_client(...,NULL)` (USER: memory+store; CHANNEL: memory only) under the
   doc-mirror suspend guard; the origin's `metadata_account_clear` mints the doc tombstones as before.
   With the store row cleared network-wide on the user path, the (kept) GET promotion has nothing to
   re-animate → the M8 bug is closed without removing any promotion.
2. `metadata_account_list` now TTL-decodes (`decode_ttl_value` + `is_value_expired` skip) exactly like
   `metadata_account_get` — a pre-existing gap (it returned raw `T0|value`) that surfaces on any
   reconnect via `load_account`; independent correctness fix, reviewer-confirmed clean.
Live: s5_m8.py PASS (CLEAR reaches nef5, no resurrect through 2+ cycles, converged, 0 restarts) AND
s5c_restore.py PASS (fresh reconnect → clean value via load_account, no `T0|`).
KNOWN RESIDUALS (documented, not regressions): Change-1 enumerates in-memory keys, so an offline-SET
key never hydrated into the origin's memory isn't broadcast (narrow; common in-session path covered);
channel-metadata store rows still leak on CLEAR (FINDING 4-adjacent, pre-existing); `metadata_get_
client_cached` (dead code, 0 callers) still has its own promotion; visibility hardcodes (FINDING 3).
Regression tests to KEEP: s5_m8.py (poll-across-CLEAR) + s5c_restore.py (fresh-reconnect restore).

## 🐛 FINDING 2 (MAJOR, prod-relevant): METADATA CLEAR never propagated S2S
`metadata_cmd_clear` cleared only LOCAL memory + store and returned — no `sendcmdto_serv_butone*`,
unlike `metadata_cmd_set` which broadcasts. SET populates every P10-reachable peer's live in-memory
metadata (`ms_metadata → metadata_set_client`), so post-SET every node holds the value in memory;
CLEAR then touched none of them. Deterministic (no race): SET, CLEAR, GET from a third node = stale.
**Production-branch bug too** — prod has no doc reconcile at all, so the remote memory copy is
*permanently* stale there until the user quits. Confirmed on the wire (receiving node got exactly one
MD line = the SET, never a clear). FIXED as part of the FINDING 1 resolution (change 1 above).

## 🐛 FINDING 3 (IMPORTANT, pre-existing, SEPARATE ITEM — security-adjacent): user private-metadata visibility not persisted
`metadata_set_client` persists user rows via `metadata_account_set_permanent(account,key,value)` with
the RAW value — the `P:` private-visibility prefix is written ONLY for channel rows (m_metadata.c
~1593, gated on `target_channel`). The store-read visibility parse in the offline-GET path therefore
never sees `P:` for a user row and defaults to public, and the offline-target GET path has NO
owner/oper gate before the store read → `METADATA GET <offline-account> <private-key>` can leak the
value to any requester. **Not introduced by the M8 fix; predates it; independent of the timing race.**
Not fixed here (separate scope). Fix direction: persist the visibility bit for user rows too (mirror
the channel `P:` encoding in the user store-write path), then the offline-GET visibility check works.
Tracked for a dedicated pass. [[crdt-mesh-s2s-coverage-audit]] is the neighboring metadata work.

## 🐛 FINDING 4 (MINOR, cosmetic): `crdt_mesh_stub_count` inc/dec leak
On a FRESH force-recreate with all 5 nodes reachable + converged + zero materialized stubs
(the GlobalClientList `IsMeshStub` walk in render_status reports `stub=0`), `/CRDT status`
still shows `partitioned=YES`. `crdt_have_mesh_stub()` (crdt_shadow.c:464) is just
`crdt_mesh_stub_count > 0` — a counter, not the live client-list count. On a fresh process the
counter starts at 0, so some transient bring-up stub (a node briefly reached via overlay before
its P10 link completes) was `crdt_mesh_stub_inc`'d and then retired/resolved via a path that
does NOT call `crdt_mesh_stub_dec` → the counter leaks >0 permanently. Effect is cosmetic (the
`partitioned=` display + any gating that trusts `crdt_have_mesh_stub`); routing/delivery use the
accurate reachability + client-list walk. Fix: audit every stub retire/resolve path (esp. the
"retired on relink" resolution vs the "beacon stale" retire) for a missing `crdt_mesh_stub_dec`.
Harness consequence: scenarios must key off the render_status `%d stub` field (accurate), never
`partitioned=`/`crdt_have_mesh_stub`.

## ⚠️ PARTITION-SCENARIO BLOCKER (harness, not a server bug): redundant-star topology absorbs single-link drops
`/CRDT route` on the live bed shows the canonical broadcast tree is a STAR on hub2 (nef3):
`hub2-leaf2 hub2-leaf3 hub2-leaf4 hub2-leaf5`, `meshOnly 2` (the nef6↔nef3 / nef7↔nef3 overlays).
So every leaf has a DIRECT edge to nef3 in addition to its P10 uplink. Dropping one link (the
scope doc's single-socket recipe, e.g. nef6↔nef4) just reroutes over the leaf's overlay to nef3 —
`reachable` stays 5, NO mesh stub forms (a stub requires a node reached ONLY indirectly). This is
correct mesh behavior (redundancy working), but it means the partition scenarios (#3 U6, #4 M2,
#7 M11, #8 jupe) CANNOT manufacture a stub with a one-edge cut on this bed. To force a mesh-only
stub, isolate a node down to a single 2-hop path: cut ALL its direct edges to the observer's
component while leaving exactly one indirect route (per-node, multi-edge, topology-specific). This
is genuine partition engineering, not a script tweak — the scope doc's recipe predates the
overlay-dense testbed. Options: (a) build per-node multi-edge partition helpers; (b) stand up a
sparser bed (fewer overlays) for the partition tier; (c) defer the partition scenarios. The
NON-partition timing-race fixes (M12/m15/M13/M8) are fully validated without any of this.

## 🐛 FINDING 5 (dangling implementation, pre-existing — SEPARATE ITEM): `metadata_channel_load` has no caller
`metadata_channel_load` (metadata.c, `return metadata_account_list(channel);`) was added complete but
NEVER wired in — commit `92ea12a` "feat: Add LMDB persistence for metadata-2" (2025-12-24, Opus 4.5),
dead since written. It is the intended eager channel-metadata restore (symmetric to
`metadata_load_account` for users), so with it dead the ONLY path that repopulates a channel's
in-memory metadata after the channel empties + is recreated is the LAZY promotion in
`metadata_cmd_get`'s channel branch. That is exactly why removing that promotion regressed (2nd-review
Critical-2): the dead eager-load left the lazy GET-fallback as the sole restore path.
**Do NOT just "wire the eager load" (corrected 2026-07-24 after discussion — earlier note here
recommended exactly that; it's wrong).** There IS an ircd-side registration signal (`MODE_REGISTERED`
/`+R`, arrives at the MODE transition + on burst), so a trigger technically exists — but there is
NOTHING RELIABLE TO LOAD FROM. Channel metadata is (a) explicitly EXCLUDED from doc convergence
(`crdt_shadow.c:2240` `if (IsChannelName(account)) return 0;` "never converge channel metadata"), and
(b) never bursted (`metadata_burst_channel` is a STUB, metadata.c:1864) — unlike user metadata, which
got the full F2-b doc convergence + `metadata_burst_self_to_client` wiring. A node's local channel
store is populated ONLY by real-time `ms_metadata` MD-broadcast caching (m_metadata.c:1604), so an
eager `metadata_channel_load` at +R-time would hydrate node-local, possibly-empty/stale data. The dead
function is the visible edge of a HALF-BUILT subsystem (channel persistence added, channel
convergence never finished). The lazy GET-promotion is the HONEST design: it makes no convergence
promise, just pulls whatever the local store holds on demand — sidestepping both "when to load" and
"load from what." **Real fork:** either ACCEPT lazy-only (shipped; channel metadata = best-effort,
node-local, not convergent), OR do the real project — give channels the F2-b treatment (doc
convergence or a real `metadata_burst_channel`), after which the loader gets both a clean trigger
(materialize-with-+R) and something worth loading. Symmetric gap with
[[project_ephemeral_metadata_burst_gap]]; this is the channel half of what F2-b did for users.

## Harness lessons burned into the scenarios
- **Convergence oracle = mdigest** (GC-invariant). The raw doc digest legitimately flaps
  during per-node GC / expiry-tombstone waves; asserting on it gives false FAILs.
- **Convergence is a bounded-window property** (poll to converged, record time), never an
  instant snapshot 6 s after an event.
- **GLINE oper syntax needs the explicit `*` target** for a global gline
  (`GLINE +mask * <dur> :reason`); without it the command is a LOCAL gline (needs
  LOCAL_GLINE priv → 481, and never touches the doc).
- **STATS G lastmod is not a mint oracle** — the doc-reconcile drive rewrites the live
  entry's lastmod at drive time. Mint evidence = the "adding global GLINE ... expiring at
  E" notice (E − duration).
- **Same-second collisions: fire mid-second** (frac ~0.35); a fresh mask per attempt
  (re-activating an existing entry is a MODIFY, different notices).
- **Scenario glines: short expires (90 s)** — 600 s residue tombstones from an earlier
  scenario mutate the doc mid-way through later ones.
- The DEBUG-build log flood buries L_INFO lines — grep tight patterns, never eyeball tails.
