# CRDT-mesh: mesh-map → presence/reachability input (path to R7)

Plan (2026-06-13) for promoting the gossiped **mesh-map** (built this session, observability-only)
into the authoritative **server-presence / reachability** source, retiring the P10 SERVER/SQUIT tree
among CRDT-aware servers (**R7**). Designed by the Plan agent; respects the decided architecture
(flood routing done; topology replicated / reachability derived locally; `check_loop_and_lh` stays for
legacy P10; legacy = pure P10 + §17.7 at every step; numerics/YXX/server_list KEPT). See
[[project_crdt_meshmap_command]], `crdt-mesh-roadmap.md`, `crdt-mesh-tier2-scope.md`.

## STAGE 1 DONE (2026-06-13) + REVISED ARC

S1 (`384d822`, testnet `e0c68bd`) shipped the shadow oracle: `crdt_meshmap_set_diff` (pure, cmocka
11/11) + `crdt_shadow_presence_diff` logging BFS-vs-beacon-vs-P10 divergences each verify cycle + on
`/CRDT status`. Log-only, 0 crashes.

**Empirical finding (steady + partition on the 5-node bed) — it ARBITRATED the architecture:**
- `BFS-vs-beacon = 0` ALWAYS (steady AND through a partition). `crdt_meshmap_reachable` prunes the
  target by its own freshness, and beacons flood, so a server's OWN beacon IS its reachability proof
  → **BFS ≡ beacon-set for presence.** The **beacon-set is the presence oracle**; BFS is for the
  topology diagram + future routing, NOT presence. (The Plan agent's "transitive-keep" case never
  fired, as predicted.)
- Partition: `treeOnly 1` — BFS+beacon dropped the cut node at beacon-stale (90s) while the P10 tree
  still listed it (ping-timeout pending). **The mesh signal LEADS the P10 tree** on a silent split →
  mesh-presence is at least as responsive as P10 SQUIT. The agent's Stage-6 "detection-latency gap"
  worry is dissolved. (The current verify `servers` count is itself the lagging P10 view.)

**This collapses the original 7-stage arc.** The beacon-set is ALREADY the signal the staleness sweep
+ the materialize/anchor gate use — so there is no "build BFS-based presence" work. Revised arc:
- **S1 DONE** — shadow oracle (beacon-set = presence oracle, confirmed).
- **S2 (NEXT, safe)** — internal presence reporting → beacon-set: move the verify `servers` census off
  the lagging P10 count onto the beacon-fresh count (the `/CRDT status` `mesh reachable` already uses
  the mesh/BFS = beacon signal). Diagnostic-only; removes the measured P10 lag.
- **S3** — keep-gate precision: `crdt_shadow_mesh_reachable` (exit_client) consults the specific
  server's beacon-reachability instead of "any peer exists" (shadow-verify old-vs-new verdict first;
  the staleness sweep backstops it). The last internal-presence coarseness.
- **S4 — R7 CORE** — suppress SERVER/SQUIT among CRDT-aware-both-ends: SQUIT (departure carried by the
  beacon-stale sweep) then SERVER-J (introduction carried by beacon→anchor), per-direction
  `IsCrdtAware` gated; legacy keeps both + §17.7. Extend the proven pre-`check_loop_and_lh` stub-retire
  + R6c pre-retire-SQUIT slot-free discipline to the anchor/SERVER-suppressed relink (numeric reuse).
- **S5 — R7 endgame gate** — default-on under `FEAT_CRDT_PRIMARY` + all-CRDT-aware; §17.7 gateway the
  sole P10 surface for any legacy straggler.

BFS/adjacency stays observability + (future) routing; it is NOT on the presence/teardown path. The
original agent staging below is preserved as the design-reasoning record; S2-S5 above supersede its
S1-S7 mapping.

---

## Code reality (traced)
- Keep-vs-teardown decision = `crdt_shadow_mesh_reachable(victim)` in `exit_client` (s_misc.c:1103) —
  COARSE: true iff `MyConnect(srv)` AND *any* other `IsCrdtSyncTarget` exists (crdt_shadow.c:546). It
  asks "do I have any CRDT peer left," NOT "can gossip reach `srv`."
- Real reachability backstops, both per-NODE-beacon (not transitive, not the mesh-map):
  the **beacon-staleness retire sweep** (crdt_shadow.c:2538, retire stub if no CR H 90s) and the
  **materialize/anchor gate** (crdt_shadow.c:1296, anchor iff owning server's own beacon fresh).
- `g_meshmap` is fed by the same CR H beacons but read by NOTHING except `/CRDT`.
- **Sharp edge:** mesh-map reachability is a SUPERSET of P10 reachability (its edges include CR-only
  overlays). So shadow-divergence vs the local `FindNServer` view is EXPECTED/benign in the overlay
  case → Stage 1 must CLASSIFY divergences, not count them.

## Stage 1 — mesh-map shadow oracle (inert + shadow-verify; mutates nothing) ← START HERE
Compare the mesh-map BFS against the decisions it will REPLACE (the beacon-staleness sweep + the
materialize gate), not the coarse keep-gate.
- **1a cmocka FIRST (engine-pure, TDD):** `crdt_meshmap_reach_diff(map, from, now, stale,
  pernode_fresh[], out_diff[])` → per-numeric class: 0 agree · 1 transitive-keep (BFS-reachable but
  own-beacon-stale: reachable via a fresh relay; mesh-map keeps, coarse drops) · 2 isolated-island
  (own-beacon-fresh but BFS-unreachable; mesh-map drops, coarse keeps). Tests: stale-but-relay-reachable
  tail (case1), fresh disconnected component (case2), healthy full-agree, clean-partition subtree agree.
- **1b integration (log-only):** in `crdt_shadow_verify_cb` (~2493), after `crdt_gossip_beacon`,
  compute `crdt_meshmap_reachable` + `reach_diff` vs the per-node beacon-freshness array; log one
  structured classified line per live server, side-by-side with the P10 `FindNServer` verdict. NO
  meshmap result feeds any decision.
- **1c (cheap):** add a "mesh-map vs beacon-sweep divergences: N (transitive-keep K, isolated-island J)"
  line to `/CRDT status`.
- **EXIT CRITERION:** on the 5-node bed across a recreate-clean cut+heal, every divergence is class-1
  (expected when an overlay survives) or transient class-2 during sub-second beacon warmup; NO
  steady-state class-2, no flap; mdigest stable+equal throughout.

## Stage 2 — tighter safe liveness (the routing-grade gap)
Fuse two signals: (a) **direct-link edge-down** = immediate hard event (no beacon wait); (b) mesh-map
BFS for transitive reachability. Do NOT lower global beacon cadence first.
- 2a (pure, cmocka): edge-down self-row reconcile — mark a directly-declared edge known-down NOW,
  overriding our own last beacon row so BFS reflects a local cut same-tick. Tests: edge-down makes a
  leaf-only node BFS-unreachable instantly; edge-down on a redundant edge leaves reachability intact.
- 2b (integration, still log-only): hook the self-row refresh into the SQUIT/exit + overlay-loss paths.
- Flap/loop: link-state RECOMPUTES (no routing-loop hazard; CR-M flood+dedup already handle delivery).
  Keep the 3-tick/90s **hold-down** before any teardown when the mesh-map becomes authoritative.

## Stage 3 — mesh-map authoritative for the RETIRE decision (lowest-stakes mutation)
Replace the per-node `recv_ts > CRDT_BEACON_STALE` test in the staleness sweep (crdt_shadow.c:2538)
with the mesh-map BFS-unreachable verdict + hold-down. STRICTLY more correct + fails safe: today's
sweep over-retires (kills a stub still reachable via a fresh relay = the class-1 case); the mesh-map
keeps it. New retire-set ⊆ old retire-set in the dangerous direction. Behind `FEAT_CRDT_MESHMAP_PRESENCE`
(default off): inert → verify (log old-vs-new retire sets, confirm subset) → enable. Executor
`crdt_shadow_retire_mesh_stub` unchanged. Full partition still tears down (BFS from self reaches only
self → all retired).

## Stage 4 — mesh-map authoritative for the MATERIALIZE/anchor gate
`crdt_materialize_one_user` Case-B (crdt_shadow.c:1296): anchor iff BFS-reachable (not per-node-beacon).
Closes the R2 flicker (anchor a server reachable via a relay whose own beacon lapsed) while correctly
withholding anchors for BFS-unreachable (SPLIT). **KEY SAFETY (the symmetry property):** anchor-create
and stub-retire now share the SAME BFS signal (Stage 3 FIRST) → anchorable ⟺ not-retire-able → they
cannot disagree → no un-tearable ghost. Same gate; inert→verify (log anchor deltas, never anchor a
BFS-unreachable server)→enable.

## Stage 5 — unify the keep-gate
`crdt_shadow_mesh_reachable` (crdt_shadow.c:525): ask the mesh-map "is `srv` BFS-reachable excluding the
dying edge" instead of "any peer exists." Removes the last coarse heuristic in keep/teardown. SAFETY-
CRITICAL (`exit_downlinks` / hs_client dangle class): change only the PREDICATE, keep the convert-vs-
teardown executors byte-for-byte; keep `MyConnect`-only (stub validity); shadow-verify verdicts first.

## Stage 6 — suppress SERVER/SQUIT among CRDT-aware-both-ends (R7 core)
- **6a suppress SQUIT** to CRDT-aware-both-ends (emit sites: exit_client ~909 + s_serv broadcast). Legacy
  still gets SQUIT (no other presence signal; R6c presented-stub bridges them). Departure now driven by
  the Stage-3 mesh-map sweep. Riskiest flip → shadow-verify: emit SQUIT AND log "mesh-map would retire in
  T" to measure the detection-latency gap.
- **6b suppress SERVER (J)** to CRDT-aware receivers (s_serv.c:204/281) → peer learns the server from CR H
  beacon → mesh-map → anchor. Closes the SERVER half (BURST already CR-F-replaced). = R7.
- **Numeric reuse on relink:** server_list/YXX KEPT. Extend the proven pre-`check_loop_and_lh` stub-retire
  (m_server.c:638) + R6c pre-retire-SQUIT slot-free sequencing to the ANCHOR + SERVER-suppressed relink
  path (retire the colliding anchor before admitting new presence on the same numeric). Live-test only.

## Stage 7 — R7 endgame gate
Stage 6 + both-ends gates IS R7 for an all-CRDT region. Residual is operational: make the gates
default-on under `FEAT_CRDT_PRIMARY` + an "all peers CRDT-aware" assertion; §17.7 gateway remains the
sole P10 surface for any legacy straggler. Services-fold is a CONSUMER, not a gate.

## cmocka-gateable (TDD first) vs live-only
- Pure (cmocka): reach_diff classification (S1); edge-down self-row reconcile + BFS-after-edge-down (S2);
  hold-down K-consecutive helper; the S3 subset property on constructed graphs.
- Live-only (5-node + legacy, recreate-clean, mdigest-gated, tcpdump the CRDT↔legacy link): anything
  touching Client/server_list/Connection/exit_client/server_estab (S3-enable, S4, S5, S6); numeric-reuse
  collision (S6); SQUIT/SERVER suppression wire behavior + legacy-bridge faithfulness.

## Open decisions (recommendations)
1. **Stage-1 comparison target** — vs the beacon-sweep + materialize gate (the decisions it replaces),
   NOT the coarse keep-gate. *Rec: confirm.* (Non-blocking for starting S1.)
2. **Faster presence beacon cadence** (10-15s lightweight, distinct from 30s verify beacon) — *Rec:
   DEFER*; the S2 direct-link event covers the fast local-cut case; a faster cadence is pure steady-state
   bandwidth that only helps the transitive case the stub/anchor model already rides out. Add only if
   S4/S6 testing shows a user-visible ghost window. (Bites at S2.)
3. **Stage-6 both-ends gating predicate** — (a) per-direction `IsCrdtAware(acptr)` on the receiver
   (incremental, R6a/R6b style) vs (b) network-wide "all CRDT-aware" assertion. *Rec: (a) for 6a/6b, (b)
   as the operational R7 default-on switch.* (Bites at S6.)
4. **Hold-down length when mesh-map authoritative (S3)** — *Rec: keep identical to today's 90s
   `CRDT_BEACON_STALE`* so S3 changes only per-node→transitive semantics, not timing (one variable at a
   time). (Bites at S3.)

## Constraints (standing)
Submodule push `origin crdt-mesh`; testnet pointer staged ONLY `nefarious-crdt`; `Co-Authored-By` trailer;
`data/ircd*.conf` uncommitted; throwaway harness not committed; cmocka gates the image; verify the
`ircd.YYYYMMDDHHMM` symlink advances; recreate-all for a clean bed; gate convergence on **mdigest**.
