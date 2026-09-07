# CRDT Orphan Reap — partition-safe ghost reap (milestone scope)

**Status:** Scoped 2026-06-28 (supersedes the parked `project_crdt_orphan_reap_scope`).
**★ 2026-07-26: Inc-2 CHARACTERIZATION RUN COMPLETE — see "Inc-2 characterization run"
section at the bottom. VERDICT: do NOT build the class-1 destructive user reap; the ghost
class no longer reproduces on the current build (3 partition geometries + churn, 0 ghosts).
Both Inc-2 gates resolved (gate-1 uncapturable / gate-2 PASS). The track's real successor
work is the two NEW findings: partition-cycle member-ORSet resurrection residue (a real,
deterministic leak) and the Fix-A tombstone-GC-skew snapshot storm (prod-scale wire cost).**
**★★ 2026-07-26 LATER: member-residue reclaim SHIPPED (`c0e38f5`, cmocka 92/92, Docker-gated)
— AND run 4 REPRODUCED the USER-record resurrection live (quit-during-partition users came
back network-wide as unkillable doc-present zombies when heal landed after complete mainland
tombstone GC; timing-dependent, yesterday's 3 clean runs were tombstone-carriage luck).
NEXT (needs approval): the OWNER-SIDE SWEEP (own-origin records with no live client → mint
DELETE). See the 2026-07-26 follow-up section.**
**Driver:** the FLAG_COUNTED counting unification (`15f6e20`) made bouncer-user ghosts
reliably *detectable* (gateway idles `UserStats.opers` above baseline; verify logs
`CRDT shadow user missing: <num> (<nick>)` every tick). They are not auto-reaped.
**Risk class:** HIGH — the failure mode of a wrong reap is **killing a live user**.
A naive absence-reap was implemented and **reverted** this session after it crashed
nodes under partitioned churn (see "Failed attempt"). This milestone is the safe path.

## The two ghost classes (one milestone)

Both are "a thing that should be gone but isn't," both ride the same partition-vs-death
oracle, but the residue is on opposite sides of the doc/live boundary:

1. **Stale-materialization (NEW, the live driver).** A materialized *remote user* lingers
   as a live `struct Client` on a node, but its `CRDT_COLL_USERS` doc record is **wholly
   absent** (no value, no tombstone). Invariant: a *present* doc entry never vanishes (GC
   reclaims only causally-stable tombstones — `crdt_lwwmap_gc_deleted`, crdt_types.c:460),
   so a user we *did* materialize that is now absent **was deleted** — its tombstone was
   **GC'd before the reap reached it**: the deleting peer left the gmin set (the GC floor
   "advances past a SQUIT peer"), so its DELETE went trivially causally-stable and the
   tombstone was reclaimed. **Reproduces reliably** under aggressive cross-leaf churn
   (4 ghosts on the gateway: AGAAP/prA0/prA4/prA5, `real=7 crdt=6`, `partitioned=YES`).
   `crdt_shadow_reconcile_user_removes` (crdt_shadow.c:3559) only reaps *explicit*
   tombstones, so these absent orphans are stranded. **Reap target = the live Client.**

2. **Doc-residue (the originally-scoped class).** When a node dies with no clean teardown,
   its single-writer doc records (`users` server=dead, `bconns` host=dead, `bsessions`
   primary-on-dead) have no live writer to tombstone → they LINGER and **re-materialize**
   as ghosts on restart. Increment-0 detect-and-log (`crdt_shadow_orphan_reap_scan`,
   crdt_shadow.c:752, `1cfd3bd`) showed this **self-heals on clean single-node death**
   (direct or mesh-only) — the doc held one connection across the kill. The only case
   residue lingered was a *partition*, where lingering is **correct** (§17.3 zero-tombstone,
   re-materialize on heal). The real residue ghost is the rarer **compound anchor-residue**
   (records from an earlier-killed node re-materializing when another node becomes their
   anchor). **Reap target = the doc record (write a DELETE tombstone).**

Class 1 is the one biting now and the priority. Class 2 is lower-urgency (self-heals) and
stays detect-and-log until the compound case is reproduced.

## The partition-safety oracle (proven, reuse it)

Beacon-staleness ALONE is insufficient (a partitioned node also goes stale). The
**lease (`CRDT_COLL_BLEASES`) is the death-vs-partition oracle** and must NEVER be reaped:
- `would_reap_A` = grace && **lease moved off the host** && no live client — **PARTITION-SAFE**
  (live-validated `1cfd3bd`: across a 226s netns partition `would_reap_A` stayed 0; a
  partition never moves the lease, only a revive bumps its generation).
- `would_reap_B` = also fires on `lease_dead`/`no_lease` — **FALSE-POSITIVES on partition**
  (the partitioned holder's beacon is stale everywhere). NOT usable without a longer grace
  or a survivor election.

For class 1 (stale-materialization) the analogous safe predicate is **doc-absence of an
already-materialized user whose absence is *causally justified***, not merely "absent here
right now." The naive version (absent + owner-connected + 2-pass debounce) is what failed.

## Why the naive absence-reap failed (this session, reverted)

Implemented `FLAG_CRDT_ORPHAN_PENDING` + absence-reap (owner connected+CRDT-aware,
!mesh-stub/!mesh-only, !bursting, 2-pass debounce). **Stable-bed safety test passed** (a live
held user survived 2+ ticks, no false-reap). **But under partitioned churn nef3+nef7 crashed**
`s_user.c opers<=clients+unknowns` — the same churn was 0-assert without the reap. During a
partition / CR-F snapshot resync, "absent here" does NOT imply "deleted everywhere": the local
doc copy can transiently lack a user that is alive on a partitioned owner, so the reap
false-fires, and reap+re-materialize churn transiently over-counts. **Lesson: an
owner-*connected* gate is not partition-safety; "connected" flaps during the exact churn that
creates ghosts.** The predicate must be anchored to a *positive supersession proof*, like the
lease oracle, not to local absence + liveness heuristics.

## Design

### Predicate (class 1, stale-materialization)
Reap a materialized non-MyUser, non-alias, non-mesh-only live Client `U` (numeric `num`,
owner server `S`) iff ALL:
- `crdt_user_get(num) == NULL` AND `!crdt_user_is_explicitly_removed(num)` (wholly absent); and
- **we are causally caught up with `S`**: `S` is a connected CRDT peer AND our state vector
  covers `S`'s component up to at least the point where `U`'s record would live (i.e. NOT
  mid-resync / mid-burst from `S`) — this is the missing rigor the naive version lacked; and
- a **revive/supersession proof OR a death proof** for the session — reuse the lease oracle:
  the bsession's lease moved off `S` (revive elsewhere) OR the lease names a dead holder past
  grace AND no live doc user for its roster (death); and
- a **grace** past the first absent observation (debounce CR-F resync), AND not bursting.

Open design question: whether the "causally caught up with S" + lease test is *sufficient* to
drop the live-Client false-reap, or whether class 1 should instead be driven from class 2's
machinery (reap the live Client only as a side effect of a *positively justified* doc tombstone,
never from bare local absence). **Lean toward the latter** — make the doc the single source of
truth: a live Client is reaped only when a tombstone (explicit or reaper-minted) justifies it,
never from "I can't find it locally." That removes the partition hazard by construction.

### Predicate (class 2, doc-residue) — already scoped
Option A (first): the lease-holder that REVIVES elects itself reaper + tombstones the dead
predecessor's user+bconn records at revive time (positive supersession = it just bumped the
gen; exactly one writer). Option B (later catch-all for no-revive crash): lowest-numeric live
survivor + idempotent LWW DELETE. Reaper writes `CRDT_OP_DELETE` with reaper-local HLC (> dead
node's last add → wins LWW). NEVER deref the dead host's `struct Client` (inv#8) — pure doc
reads + `crdt_beacon[H].recv_ts` only.

### Coordination order (no re-materialize)
user-record tombstone FIRST (load-bearing — ghost materializes from the user collection) →
bconn(primary+aliases) → bsess (or let `bounce_crdt_replica_reap` catch it post-bsess-tombstone).

## Increments

- **Inc 0 (DONE, `1cfd3bd`):** detect-and-log `crdt_shadow_orphan_reap_scan` (bconn residue);
  proved would_reap_A partition-safe, residue self-heals on clean death.
- **Inc 1 (NEW, this milestone's first build): a stale-materialization DETECTOR + characterizer.**
  Extend the scan (or a sibling) to walk live materialized users for the class-1 condition
  (doc-absent + the full predicate fields: owner-connected, caught-up, lease state, grace) and
  LOG `would_reap` WITHOUT deleting. Reuse the FLAG_COUNTED detector as the oracle: opers>baseline
  ⟺ ghosts. Validate the predicate stays 0 on the stable-bed safety case AND on a netns
  partition+heal (false-death gate), and flags exactly the churn ghosts (true case).
- **Inc 2: class-1 reap behind a dedicated sub-flag** (NOT FEAT_CRDT_BOUNCER_DOC) — only after
  Inc 1's predicate is shown false-positive-free across the partition harness. Prefer the
  "doc-justified tombstone drives the live reap" model over bare absence.
- **Inc 3 (optional, later): class-2 Option A** (revive-elects-reaper) once the compound
  anchor-residue case is reproduced.

## Validation harness (the regression oracles)
- **FALSE-death (the critical gate):** netns/iptables-nft partition a session-holding leaf >grace,
  then HEAL → `would_reap`=0 THROUGHOUT, session intact after heal. (The naive version would
  have failed this under churn — Inc 1 must prove it under *churn*, not just a quiet partition.)
- **TRUE case:** aggressive cross-leaf oper churn → after settle, the gateway's residual
  `UserStats.opers` returns to baseline (ghosts reaped) and `WHO` shows no leftover testadmin.
- **Safety:** a stable held user survives ≥3 verify ticks, every node 0-assert (both the
  underflow and the `opers<=clients+unknowns` over-count) across the whole run.
- Build all 5 via `scripts/dc.sh -l --profile multi build`; cmocka gate must stay green.
  Aggressive churn wedges leaf5/nef7 + flaps the mesh — budget for re-link, cap runs ≤1h.

## Constraints
Submodule push `origin crdt-mesh`; testnet pointer stages ONLY `nefarious-crdt`; trailer
`Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>`; engine layer
(crdt_types.c/crdt_state.c) stays Client-free for the cmocka harness — the reap lives in
crdt_shadow.c. Update `crdt-mesh-roadmap.md` + memory on each increment.

## Inc-2 characterization run (2026-07-26) — both gates resolved, verdict: pivot

Harness: `/tmp/crdt4c/orphanchar/` (throwaway; common.py + phase1a/1b/1c/2). Full-isolation
cut of nef5 = kill-first (`ss -K` per peer IP so RSTs escape → both sides SQUIT instantly)
then iptables-nft DROP both directions for all 3 CRDT peer IPs (.6/.7/.15) in a netshoot
sidecar — closes the June single-link leak (port-4496 match missed established-flow replies).

**Runs** (ghost subjects = plain users on nef4, quit while nef5 fully dark; scan active):
- **1a, 150s dark:** CLEANLY GONE. Stub-retire took live copies at ~dark+95; quit-tombstones
  still crossed at heal; no candidates, converged.
- **1b, 55s dark** (tombstones cross while ghosts' live Clients still up = the reconcile-vs-GC
  race): CLEANLY GONE within ~12s of heal. One transient `CRDT shadow user missing` blip
  (count-detector working as designed), zero stale-mat candidates, no would_reap=1.
- **1c, 260s dark** (heal after mainland retire+GC — the constructed resurrection window):
  CLEANLY GONE. Dark-side verify showed doc-surplus (`real=1 crdt=9`) — the OPPOSITE
  signature of the June ghosts (real>crdt) — and the stale presents were removed at estab.
- **2, 160s dark + churn** (55+55 connect/join/quit cycles on nef4+nef6 through cut+heal,
  live user held ON nef5): **GATE-2 PASS** — zero would_reap=1 for any alive user at 9
  sampled windows, held session intact + immediately mainland-visible post-heal, zero
  asserts, converged. Full multi-link isolation DID drive owner-beacon-stale (all 4
  mainland stubs retired on nef5 at ~+95-120s) — the suppression arm is now truly gated.

**Gate-1 (persistent would_reap=1 ghost): UNCAPTURABLE — the class-1 ghost no longer forms.**
The June "reproduces reliably" ghosts predate the eager-delta reconcile suite, Fix A, and
the count-fix wave; on aaeb657 the tombstone flow + eager reconcile cleans every geometry
tried. A destructive class-1 reap would be high-risk code with no reproducible target.
Inc-1's scan stays as the cheap sentinel (silent across all runs = healthy) in case an
unreproduced genesis (June's compound anchor-residue, legacy-gateway interactions) recurs.

**GC-model corrections** (the June narrative in this doc is wrong in three places):
- gmin = live `IsCrdtSyncTarget` links ONLY (crdt_shadow.c:5293) — a split peer leaves the
  stability set the moment its links die, NOT at stub-retire.
- A fully-isolated node **skips GC entirely** (`npeers<1 → return`) — its ops/tombstones
  wait for heal (observed: oplog frozen at 14-15 through every darkness, reclaimed ~10s
  after relink).
- Mainland reclaim is fast (~28s post-mint observed) BUT tombstones then live longer than
  the model implies via snapshot re-delivery: see the storm finding.

**NEW FINDING A — partition-cycle member-ORSet resurrection residue (real bug, deterministic).**
Users who quit while a partitioned node held their channel membership leak their member
OR-Set entries back into the CONVERGED network-wide doc at heal: the member-remove
tombstones are GC'd on the mainland during darkness; the healed node's still-present add
entries re-merge (merge-keep snapshot semantics, no SV-justified-absence purge at the ORSet
layer). Observed: `#ghostchar real=2 crdt=7` during 1c (all 7 = exactly the run's ghost
subjects), still `real=1 crdt=8` in the converged steady state after everything healed —
on every node. Control: 110 healthy-path join/quits (#churn, phase 2) leaked ZERO entries.
So: healthy quits clean; partition-spanning quits leak permanently (doc bloat + count-div
noise; the dead channel record itself also lingers "in doc, not live"). The USER collection
does NOT exhibit this (3/3 runs clean) — only membership. **This is the orphan-reap
track's real successor: extend the orphan-reclaim family (crdt_state_reclaim_orphan_member_meta
pattern — mint DELETEs, invariant-5 gate on the user being wholly-gone from the users
collection: `!contains && !is_explicitly_removed`) to the membership entries of fully-departed
users.** Safe by the same causal-stability argument as members_status/kick_info, and unlike
the class-1 user reap it has a reliable repro + is non-destructive to live Clients.

**NEW FINDING B — Fix-A tombstone-GC-skew snapshot storm (prod-scale cost concern).**
After a quit wave + partition, mainland nodes GC the tombstones on different ticks; the
doc digest INCLUDES tombstones, so GC skew = digest mismatch at equal SV → Fix A
escalates → full-snapshot exchanges that RE-DELIVER tombstones to already-reclaimed peers
→ re-mismatch → repeat until all nodes reclaim within one exchange window (~60s observed,
6+ full 10KB snapshots × 4 nodes for TWO users' tombstones). Self-limiting on the testbed,
but cost is O(doc) per event and prod-size docs exceed CR_SNAP_MAX (256KB) where the
below-floor path degrades to "stays DIVERGENT". Design options: exclude tombstones from
the CR S digest (digest only live content — mdigest-like), or suppress Fix-A escalation
when the SV-equal difference is tombstone-only.

**Open mechanism note (minor):** the exact estab-time step that removed the healed node's
stale user-record presents in 1c is not fully attributed (crdt_snapshot_apply is merge-keep;
no local mint fires — retire self-skips via the stub's kept FLAG_CRDT_AWARE; the heal
snapshot's byte size matched the storm-era with-tombstones snapshots, suggesting tombstone
carriage at estab outlived nef3's local reclaim). Outcome is 3/3 correct; attribute only if
finding-A work lands nearby anyway.
**→ RESOLVED 2026-07-26 (run 4, below): the 3/3 clean outcomes were tombstone-carriage
LUCK, not structure. The users layer has the same hole as finding A.**

## 2026-07-26 follow-up — finding-A reclaim SHIPPED; USER-layer resurrection REPRODUCED

**Finding-A fix shipped: `crdt_state_reclaim_orphan_members` (`c0e38f5`, skill sync
`1b8521c`).** TDD: 4 cmocka tests incl. a two-replica wire-shape residue-converges test
(92/92); Docker-gated on all 5 nodes (`ircd.202607260356`). Gate = the silences-sweep
oracle (owner wholly absent: `get==NULL && !is_deleted`); mints `crdt_chan_remove`
(part/kick op path) per orphan member; GC-cycle-only. Implementation trap the suite
caught: `CrdtChannel.name` is len-delimited (memdup, no NUL) — `crdt_chan_remove`
strlen()s its args, so the act phase must pass a NUL-terminated copy.

**Run 4 (phase1a re-run on the fixed build, freshly recreated bed): the USER-record
resurrection FIRED — `gh1a`/`gh1b` RESURRECTED-EVERYWHERE.** Quit-during-darkness users
came back at heal+1s as live materialized Clients + doc-present records on every node,
digest-converged. Mechanism (now attributed): the fresh bed GC'd the quit tombstones
COMPLETELY before the +150s heal (yesterday's 3 clean runs all healed while tombstones
or their Fix-A storm re-deliveries still existed somewhere); nef5's frozen presents
re-imported via the estab CR F exchange (merge-keep, nothing to beat them), Fix A
converged the network ONTO the zombie state. So the resurrection window is real and
purely timing-dependent: **heal after complete mainland tombstone GC = network-wide
zombie.** Yesterday's "no resurrection, structurally closed" conclusion is WITHDRAWN.

**Zombies are unkillable by KILL:** a non-owner KILL exits the local materialized Client
without minting a tombstone (single-writer self-skip) and reconcile re-materializes it
next tick. The owner (nef4) holds no live client for the record, so its quit path can
never fire. Only doc-level cleanup works — bed was purged via simultaneous all-5 stop
(docs reset), reconverged clean.

**⇒ OWNER-SIDE SWEEP: BUILT + SHIPPED same day (`cd0e1b9`, skill `b7db29c`).**
`crdt_shadow_own_user_sweep` (crdt_shadow.c, verify tick): each node sweeps its
OWN-origin user records (`rec->server == me`) with no live Client (findNUser) and mints
`crdt_user_remove` itself — single-writer clean; same-origin monotonic seqs make a
concurrent numeric-reuse SET win LWW. Kill-switch `FEAT_CRDT_OWNER_SWEEP` (default off;
TRUE in all 5 testbed confs); !bursting gate + 2-pass debounce; bounded 64/pass.
- cmocka `test_owner_remove_beats_snapshot_reimport` (93/93): owner re-delete beats a
  snapshot re-import; ALSO pinned the **op-less-tombstone stickiness** — a
  snapshot-delivered LWW tombstone has no local oplog op so `crdt_state_gc` never
  reclaims it (safe: accidental anti-resurrection anchor; cost: permanent local residue;
  explains part of the storm settle dynamics).
- **Live gate PASS (deterministic, unclean owner death):** docker-kill nef4 with a
  connected user → restart → stale own record re-imported + zombie re-materialized on
  peers ~2min → owner sweep reaped exactly that record at start+122s → 401 network-wide,
  ZERO false sweeps on other nodes, canaries intact, converged. Closes the June
  restart-re-materialization ghost too. (A partition-lottery phase1a rerun on the same
  build happened to dodge the resurrection window — tombstones crossed at heal — so the
  partition variant rides the same predicate rather than a dedicated live capture.)
The shipped member reclaim is the cleanup companion (memberships reap once the record
goes wholly absent). Longer-term structural options remain (either closes the hole AT
the merge): SV-justified-absence purge on snapshot apply, or m15-incarnation-anchors.
**Latency follow-up (`105052a`): eager sweep passes at EOB + non-burst CR F apply (mid-burst
applies self-defer via !bursting). Re-measured gate PASS at start+84s = 21s valgrind boot +
34s autoconnect + 29s sweep (EOB collect → next-tick reap). Prod-equivalent sweep latency:
≤30s after relink (restart path), seconds for steady-state Fix-A re-imports. Irreducible
floor: only the owner can assert death (§17.3) — zombie window = owner downtime + relink +
sweep. 2-pass debounce kept deliberately (destructive-code hedge).**

## 2026-07-26 (later still) — DECOMMISSION ("jupe without the jupe part") + the Fix-A
## oscillation find/fix — the never-returns gap CLOSED

**DECOMMISSION shipped (`244fdf6`).** The never-returns residue (permanent doc bloat for a
server that never relinks; ~1KB/user → one dead 250-user server approaches CR_SNAP_MAX) is
an OPERATOR fact, not an inferable one (June would_reap_B false-positive data stands) — and
a jupe is the wrong primitive because the common case (hardware loss, provider change) does
NOT want relink blocked. Design per user direction: `CRDT_COLL_DECOMMISSIONS` STANDING
marker (one-shot reaps get undone by merge-keep re-import — the resurrection lesson) +
`crdt_shadow_decomm_sweep` (tick+eager+EOB, FEAT_CRDT_OWNER_SWEEP family; reaps user records
+ bconns of marked servers; sessions/leases untouched — revive path owns them) + oper
`/CRDT decommission <server|2char-numeric> [remove|<reason>]` (REFUSED while target is
present/linked or beacon-fresh) + **AUTO-DISSOLVE before any reap** the moment the server
returns + `crdt_shadow_own_user_reassert` (a live local registered user with an
absent/tombstoned record is always wrong → re-mint; upgrades the count-detector's MyUser
half to self-healing). cmocka 95/95 (marker replication + reap-and-return LWW ordering).
**Live gate (wrongly-decommissioned-ALIVE shape, the worst case): early attempt REFUSED;
at beacon-stale marked + mainland reaped the isolated server's records; on heal the marker
auto-dissolved (two nodes) and the still-connected user was restored + mainland-visible at
heal+15s.** Known collateral CLOSED same day (`cb88069`): **membership re-assert** — a doc-driven
PART may never remove a LIVE local member (every legitimate local removal applies
live-first; an unattributed tombstone on a live MyUser member = reap residue → the
reconcile-remove refuses and re-mints join+status; KICK-via-doc still applies).
Full-cycle gate PASS: victim stayed connected AND in-channel on its home (zero
PARTs), back in mainland NAMES post-heal; multi-reaper re-mint churn bounded
(one round per reaper's arriving remove-ops, then stable). Re-assert path
itself live-unexercised (both runs healed via benign re-import — tombstones had GC'd first);
covered by design + the exact predicate. Harness note: phase4_decomm.py's final check
crashes because canary5 is never drained (ping-timeout) — script bug, not server.

**Fix-A OSCILLATION found live + FIXED (`5e84443`).** The decommission cycle's remove-churn
left the bed in a PERMANENT standing wave: all 5 nodes exchanging full snapshots every tick,
digests flipping between with-tombstones and without-tombstones values (~10 storms/min,
self-sustaining, >10 min observed). Root cause: the CR S digest hashed LWW tombstones +
OR-Set covered-tags/tombstones — per-node GC bookkeeping that snapshot exchange can NEVER
converge (merge-keep only re-adds; op-backed copies reclaim again → oscillate; op-less
copies stick forever). **Fix: GC-invariant Fix-A digest** — digest_lww skips deleted
entries, digest_orset hashes only uncovered add-tags, no tombstone list (new
`crdt_orset_tag_covered`). Tombstone-free collections hash byte-identically to the old
algorithm (mixed-version churn only while tombstones are in flight); mdigest untouched;
real content divergence still escalates. Old contrast test updated (it pinned the pre-fix
behavior deliberately); new `test_digest_gc_invariant` pins the skew shape; 96/96.
**Live verdict: full decommission cycle on the fixed build, then 4 minutes post-settle:
ZERO mismatch lines on all 5 nodes (old build: permanent).** This closes finding B's
worst manifestation; the residual storm cost concern (transient storms during normal
GC skew) is also gone by the same change.
Remaining known residues: legacy-leaf records (gateway-minted, owner is never a CRDT
node — out of the sweep's scope by design) and the Fix-A tombstone-skew storm cost.

Scan blindness confirmed as designed: stale-mat saw nothing (zombies are doc-present);
the owner-side count divergence (real<crdt on nef4) is the only current detector signal.

## Orphan-reap follow-ups surfaced by P3-5b2 review (2026-07-23) — for Inc 2
After P3-5b2 re-gated both bouncer reaps on *_is_explicitly_removed (not absence), two residues fall to the orphan-reap track:
1. ABSENT-from-doc materialized replica ALIAS (partition-heal ghost: gateway partitioned across the whole tombstone lifecycle -> tombstone GC'd among connected peers before the gateway returns -> gateway sees only absence). NOT detected by any current scan: crdt_shadow_stale_user_scan skips IsBouncerAlias (crdt_shadow.c:979); orphan_reap_scan only walks present-live foreign bconns. Needs an absent-materialized-alias detector. Non-crashing (lingering alias < spurious destroy).
2. PRESENT-LIVE record with no live owner (crashed CRDT host, or an owner teardown that frees the live object without tombstoning the doc: bounce_detach NULLs hs_client before bounce_destroy so the :1889 tombstone is skipped; hold_expire no-alias; KILL). Both old+new bouncer gates skip present-live, so pre-existing/unchanged; the orphan-reap track owns it (beacon-stale foreign host detection).
