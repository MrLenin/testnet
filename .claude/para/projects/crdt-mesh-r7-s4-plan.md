# S4 — R7 core: suppress P10 SERVER/SQUIT among CRDT-aware-both-ends

> **OUTCOME (2026-06-14): split into R7a (done) + R7b (infeasible).**
> Shadow phase (all 6 guards inert + cmocka + measurement) confirmed SQUIT
> suppression clean (beacon present=1 at suppress-time, mesh retains presence).
> The full cutover (SERVER+SQUIT, shared flag) was ENABLED and **broke leaf
> user-materialization** (nef6/nef7 → 7/0). Instrumented root-cause: **P10 is a
> flat namespace with hierarchical delivery — a relayed SERVER carries a source-
> prefix every downstream server must already know. Suppressing a CRDT server's
> SERVER intro orphans everything sourced through it** — here the legacy servers
> DH(x3/services)/Bj relayed behind hub2: a leaf with no direct P10 link to the
> suppressed introducer drops `:nef3 SERVER DH` → DH's users never materialize
> (legacy servers don't beacon → no anchor fallback). Split: direct-P10-link-to-
> introducer = 7/7; not = 7/0.
> - **R7a (SHIPPED): SQUIT-only suppression** + SERVER intros KEPT. Validated
>   5/5/0 single-mdigest, all leaves 7/7, R7-shadow=0 (real), 0 crashes. SERVER
>   guards (S-2/S-3/S-4) + the cold-link beacon-burst were reverted; helper is
>   SQUIT-only. cmocka still pins the pure truth-table.
> - **R7b (SERVER retirement): NOT prefix-hiding.** Needs mesh-native routing
>   (flat presentation) or an all-CRDT-aware network with no legacy behind the
>   mesh. The plan below (full SERVER suppression) is retained for the record but
>   superseded by this finding. Memory: [[project_crdt_r7a_squit_only]].


Plan (2026-06-13, Plan agent + reviewed). The single highest-risk change in the CRDT-mesh project.
Stop emitting/relying on the P10 SERVER (introduction) + SQUIT (departure) tree primitives BETWEEN
CRDT-aware servers; derive presence from the CR H beacon set. Legacy peers keep pure P10 + §17.7.
Rides the SHARED `FEAT_CRDT_MESHMAP_PRESENCE` flag (S3 introduced it, default off) → S3 keep-gate
enable + S4 suppression flip on together as ONE validated presence cutover. NOT STARTED.

## Two corrections to the original sketch (the review's value)
1. **Stale sites + no separate SQUIT relay.** `ms_squit` (m_squit.c:60) does NOT relay — it just calls
   `exit_client`. ALL SQUIT propagation among servers is ONE loop: `exit_client` downlink broadcast at
   **s_misc.c:1047** (Q-2), plus the direct-to-killer SQUIT at **s_misc.c:909** (Q-1). s_serv.c:99 is the
   pre-burst reject, not a broadcast. (Sketch's "exit_client ~909 + s_serv broadcast" was wrong.)
2. **Numeric-reuse needs NO new code (scope shrink).** An anchor IS `STAT_MESH_SERVER` ⇒ `IsMeshStub`
   matches it ⇒ the existing `m_server.c:638`/`:893` `FindNServer`+retire already handles direct-attach-
   over-anchor; and a relayed relink with SERVER suppressed can't collide (no new `SetServerYXX` on the
   relayed peer). So S4 adds NO retire code — just live verification of relink topologies + a
   `SetServerYXX`-finds-occupied-slot canary log. (Sketch presumed new anchor-path code.)

## The unified gate (atomic cutover)
```
crdt_suppress_tree_presence(peer) :=
   feature_bool(FEAT_CRDT_MESHMAP_PRESENCE) && feature_bool(FEAT_CRDT_PRIMARY) && IsCrdtAware(peer)
```
**Both-ends rule:** suppress only when the RECEIVER is CRDT-aware AND the SUBJECT server is CRDT-aware
(a legacy subject has no beacon → must still be SERVER'd even to CRDT peers, else it goes invisible).
Default-off ⇒ inert. Same flag S3's keep-gate rides.

## Emission sites + gating
SERVER:
- S-1 `s_serv.c:144` direct physical handshake — **NEVER suppress** (the link coming up).
- S-2 `s_serv.c:204` (server_estab, introduce new cptr to existing peers) — suppress per existing peer.
- S-3 `s_serv.c:281` (server_estab, introduce existing servers to new cptr) — suppress per (cptr,subject).
- S-4 `m_server.c:957` (ms_server relay of a third server) — suppress per (downlink,subject).
- S-5 `crdt_present_stub` (R6c, legacy-only) + S-6 `s_serv.c:99` (reject) — **no change**.
SQUIT:
- Q-1 `s_misc.c:909` direct-to-killer (MyConnect victim) — suppress per killer-direction.
- Q-2 `s_misc.c:1047` THE broadcast loop — suppress per downlink. **The smallest first atom.**
- Q-3 `crdt_shadow.c:801` (R6c pre-retire to legacy) — **no change**.
Gating primitive: `sendcmdto_flag_serv_butone(...,forbid=FLAG_CRDT_AWARE,...)` (send.c:1596, R6c-proven)
for the flag-filtered sends; a direct `IsCrdtAware(dlp->value.cptr)` test in the per-`dlp` loops.

**Critical ordering fact:** Q-2 (the SQUIT broadcast, line 1043) runs BEFORE the keep-vs-teardown
decision (1083) + `crdt_shadow_mesh_reachable` (1103). So suppressing Q-2 means each RECEIVER
independently decides presence from its own beacon view — exactly what S1 proved works.

## Rollout order (soft→hard failure gradient), each inert→shadow→enable
- **S4a SQUIT first** (departure fails SOFT — transient ghost, self-healed by the sweep):
  - **S4a-1 = Q-2 broadcast guard. SMALLEST SAFE ATOM, start here.** One `if` in one loop; purely
    subtractive; the receiver's departure handling already LEADS the tree (S1).
  - S4a-2 = Q-1 direct-to-killer.
- **S4b SERVER second** (introduction fails HARDER — invisibility):
  - S4b-1 = S-4 (ms_server relay) — the relayed path, replacement (beacon→anchor) most proven (R2).
  - S4b-2 = S-2/S-3 (server_estab direct + burst) — shapes a cold-linking CRDT node's view (BURST
    already CR-F-replaced; newcomer materializes from snapshot + beacons).

## Shadow-measurement (before any flag flip)
Land guards in shadow form: still emit, but log what the beacon path will carry.
- SQUIT: `R7-shadow SQUIT victim=<> yxx=<> -> peer=<> : would-suppress; beacon age=<>s stale_in=<>s` →
  metric = detection gap **T** (S1 says T≤0; confirm for commanded /SQUIT + link-drop too).
- SERVER: `R7-shadow SERVER subject=<> -> peer=<> : would-suppress; subject beacon present=<0/1> age=<>` →
  a would-suppress subject with NO beacon = RED FLAG (would go invisible). Watch the cold-link burst (S-3).
Exit per sub-step: every would-suppress SQUIT T≤0, every would-suppress SERVER has a fresh subject
beacon, zero red flags, mdigest stable+equal across cut+heal.

## Hard risks + mitigations
- **R-GHOST (Q-2):** the beacon-stale sweep only retires `IsMeshStub`, NOT a non-stub `IsServer`. SAFE
  because exit_client's keep branch re-materializes relayed downlinks AS anchors (IsMeshStub) →
  sweep-eligible. INVARIANT TO TEST: after a partition, every non-directly-linked CRDT server is gone
  or `IsMeshStub` — no non-stub ghost; 0 leaked Clients (the hs_client dangle class).
- **R-NUM:** existing 638/893 + R6c covers direct-attach-over-anchor; relayed relink can't collide.
  Verify topologies 3 (anchor→direct attach) + 4 (relayed relink) live; `SetServerYXX`-occupied canary.
- **R-SPLITBRAIN:** per-direction gate on the peer's FLAG_CRDT_AWARE is symmetric by construction (both
  ends learn it from the same SERVER `+...C` flag); both-ends rule neutralizes a legacy straggler.
- **R-LEGACY:** suppress only toward CRDT peers; CRDT server's SERVER/SQUIT still flows to legacy
  directly + R6c bridges a partitioned one. tcpdump: present on legacy link, ABSENT on CRDT links.
- **R-COUPLING:** S3 keep-gate + S4 suppression flip on the SAME flag — consistent (both trust beacons)
  but two blast sites. Mitigate by validating each in shadow first, then ONE flip on the green bed. (The
  anchor gate already uses raw beacon freshness regardless of the flag — the constant before/after.)
- **R-BURSTORDER (S-3):** a cold-linking CRDT node learns servers from beacons+CR-F, not the SERVER walk;
  a not-yet-arrived beacon delays materializing that server's users to the next verify tick. Verify
  beacons flood promptly at link-up; the S-3 shadow log catches a gap. Optional one-shot beacon burst at
  server_estab (DEFER until a gap is shown).

## cmocka vs live-only
- cmocka: extract pure `crdt_should_suppress_tree(meshmap_on, primary, peer_aware, subject_aware)` →
  unit-test the truth table (the only pure surface).
- Live-only (5-node + legacy, recreate-clean, mdigest-gated, tcpdump): all exit_client/server_estab/
  ms_server behavior; full-partition teardown (0 leaks); relink topologies 3+4; cold-link view;
  detection-gap T; SQUIT/SERVER wire absence on CRDT links + presence on legacy.

## Open decisions (recommendations)
1. **Numeric-reuse = verification-only, no new code** — confirm (the review found the machinery already
   covers it). If you know a topology needing retire-then-readmit of a real SERVER over an anchor, name it.
2. **Q-1 (direct-to-killer) — suppress too** (consistent, low-value, harmless) — confirm.
3. **Cold-link beacon burst — DEFER** (let the shadow log prove a gap first) — confirm.
4. **Extract pure `crdt_should_suppress_tree` for cmocka** — confirm.
5. **Ride `FEAT_CRDT_MESHMAP_PRESENCE` (atomic with S3), no new S4 flag** — confirm.

## Constraints (standing)
Submodule push `origin crdt-mesh`; testnet pointer ONLY `nefarious-crdt`; `Co-Authored-By` trailer;
`data/ircd*.conf` uncommitted; cmocka gates image; verify `ircd.YYYYMMDDHHMM` advances; recreate-all for
a clean bed; mdigest-gated convergence; tcpdump the CRDT↔legacy link for wire verification.
