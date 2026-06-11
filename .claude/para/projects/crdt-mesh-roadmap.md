# CRDT-mesh roadmap & P10-retirement scope

Durable roadmap for the remaining CRDT-mesh work, in two tracks: **(A) near-term polish/correctness**
(independent, low-risk, any order) and **(B) the P10-retirement arc** (R0→R7, the headline trajectory).
Authored 2026-06-11. Supersedes the scattered "remaining/deferred" notes; cross-ref
`crdt-mesh-tier2-scope.md` (the C→B decision), `crdt-mesh-tier2-presence.md`/`-p2.md` (P1/P2),
`compressed-marinating-teacup.md` (Tier-1 plan). Live state in personal memory
`project_crdt_mesh_phase0.md`.

## Where we are (2026-06-11)
Event model fully CRDT-authoritative (Phases 3a-3o). Tier-1 done (overlay + Fix A digest-aware
anti-entropy → doc converges across any partition). Tier-2 done: T2-a/b/c (mesh-stub keep + live
deliver TO/FROM), CR H full-partition liveness beacon, P1/P2 presence (split-born users visible +
addressable network-wide via synthetic anchors), TAGMSG over the mesh (local + remote), echo/history
for mesh-only targets. Hygiene: burst-path HLC-padding fixed, orphaned-LWW reclaim. **The P10 spanning
tree is still the PRIMARY routing for live traffic between connected CRDT servers; CR M is the
failover for partitioned/mesh-only destinations.** Retiring that primary role is Track B.

---

## Track A — near-term polish / correctness (independent; do in any order)
Low-risk, each self-contained, none blocks Track B. Rough order by value:

1. **#4 — mesh-only nick/umode-change legacy gate** (correctness completion). A mesh-only user
   changing nick/umode mid-partition leaks a NICK/MODE to legacy peers via `set_nick_name`/
   `set_user_mode`'s bundled relay. Fix: gate the legacy relay for mesh-only users (or skip the
   reconcile-update, accepting a stale shadow until relink). MEDIUM (shared-handler, apply-vs-relay).
2. **#3 — CR H beacon carries the server NAME + right-size the anchor mask** (cleanup). Anchors show
   `mesh-<num>.crdt` and reserve a MAX client mask (~2MB/anchor). Append-only beacon param `H <yxx>
   <ts> :<name>`; `crdt_beacon[]` gains a name; `crdt_shadow_make_anchor` uses it. Small. Minor synergy
   with R7 (anchor-as-normal-identity wants a real name).
3. **Cosmetic batch** (low ROI, anytime): legacy displayed-host cloak (host-rep parity for +x/sethost/
   account-cloak — ~300B doc fields); QUIT comment not carried (generic "Quit").
4. **AUTOCHANMODES** auto-modes→doc snapshot — dormant/untested; verify when the feature is enabled.

---

## Track B — the P10-retirement arc

### What "retire P10" means (R0 — the definition)
NOT a wire-protocol rewrite. The realistic target: **make the CR plane the routing layer for live
traffic among CRDT-aware servers**, demote the P10 spanning tree to legacy-only, retire P10 BURST +
SERVER-tree for all-CRDT networks, leaving the §17.7 gateway as the only P10 surface (for any residual
legacy peer). Transport/framing/parser/numnicks are KEPT substrate (CR rides P10 framing; YXX numerics
are also CRDT keys). Full wire replacement is endgame/out-of-scope.

### P10 layer retirement status (from the source audit)
| Layer | Replaced by CRDT? | Difficulty |
|---|---|---|
| TCP transport + framing | No (CR rides it) | endgame — KEEP |
| Wire token parser | partial (CR is one token) | endgame — KEEP the frame |
| **Spanning-tree routing** (cli_from single-next-hop, check_loop_and_lh) | No for connected peers | **HIGHEST** — the core |
| Numerics / identity (server_list, YXX) | No — and shouldn't be (dual-use CRDT keys) | KEEP unchanged |
| **BURST state sync** | **YES already** (CR F snapshot replaces it, s_serv.c:348; `crdt_shadow_doc_ready` guards a P10 fallback) | LOW — mostly done |
| **Live message routing** | partial (CR M for mesh-only) | HIGH — coupled to routing |

### THE key decision (highest risk): routing-layer = gossip-flood, NOT path-vector
To route live traffic over the mesh, something replaces single-next-hop `cli_from`. **Recommendation:
stage the gossip FLOOD (CR M + `crdt_relay_delta` + msgid-dedup + overlay edges — all shipped and
proven), widened incrementally; do NOT build path-vector/link-state** unless steady-state bandwidth
proves intolerable. Rationale: path-vector needs a convergent replicated TOPOLOGY table — exactly the
per-viewpoint reachability state the fork already ABANDONED as un-convergeable shared CRDT state
(the Phase-4a `servers`-map retirement, crdt_shadow.c:325 "no amount of patching makes a per-viewpoint
value robust as shared state"). Building it = re-litigating that failure, harder. If R4 bandwidth
forces it, that is its own spike (and a deliberate re-entry into the abandoned-4a problem space).
**Corollary — reframe T2-e:** do NOT relax `check_loop_and_lh` for P10 links (rejected Option A —
multi-path over a cyclic graph breaks the tree's single-path + sentalong dedup). Instead do multi-path
on the **CR plane via overlays-as-gossip-edges** (overlays are ALREADY first-class CR routing edges via
`IsCrdtSyncTarget`); leave the P10 tree a tree for legacy. This sidesteps the riskiest part entirely.

### Phases (each keeps the network functional + legacy-compatible throughout)
Legacy peers stay on pure P10 at every step (gated by `IsCrdtAware`/`IsCrdtSyncTarget` + the gateway).

- **R0 — baseline & gates** · S · no code. Lock the definition + a partition regression harness. *(done conceptually here.)*
- **R1 — precise mesh-liveness oracle** · **DONE this session** (CR H beacon `dcfe152`). Emits
  unconditionally every verify cycle (idle-but-reachable stays fresh → avoids the SV-staleness
  false-positive trap the agent flagged); staleness sweep retires stubs on full partition (verified
  partial-keeps / full-retires). This was the twice-deferred prerequisite — now solid. Routing can
  trust per-server reachability.
- **R2 — recursive-subtree keep-alive** · M · prerequisite. Generalize T2-a beyond leaf-only
  (s_misc.c:1075) so multi-hop partitioned subtrees survive as mesh-reachable. Risk: UAF/ghost in
  recursive teardown (run --enable-debug). Demo: 3-deep partition, all subtree users survive + heal.
- **R3 — dup/order hardening at scale (T2-d)** · M · prerequisite. Grow `crdt_m_seen` (256-ring,
  m_crdt.c:197) to an HLC-windowed/LRU dedup; harden steady↔failover↔heal so no message double-delivers
  or drops across tree+mesh. Key already available (HLC-seeded msgid). Demo: flap the tree edge under
  load → exactly-once both directions.
- **R4 — widen CR M to steady-state among CRDT peers (tree as backup)** · L · **the headline.** Route
  live unicast + channel traffic among CRDT-aware servers over CR M, tree still present as fallback.
  Generalize the `relay_*`/`server_relay_*` dead-sink branches from "mesh-only target" to "any
  CRDT-aware target"; `sendcmdto_one` gains a CR-aware path. Gated on both-ends-CRDT-aware. **Risk:
  bandwidth (flood of steady-state unicast)** — mitigate by keeping tree-delivery for same-edge peers,
  CR M only where it adds a path. If intolerable → the path-vector spike trigger. Demo: steady-state
  traffic survives a tree-edge cut with ZERO client-visible interruption (the prize).
  **SPIKE RESOLVED 2026-06-11 → refined shape (`crdt-mesh-r4-bandwidth-spike.md`): split R4 into
  R4a (CHANNEL traffic over CR-M flood — broadcast ≈ tree cost; the dead-sink branch generalizes from
  "≥1 mesh-only member" to "≥1 member on a CRDT peer", with R3 msgid-dedup gating exactly-once at the
  client) and R4b (UNICAST stays hybrid — tree-primary + targeted overlay failover, NOT a full flood,
  since flood cost ≈ 2·E). Path-vector rejected empirically. Do R4a first.**
- **R5 — gateway becomes the live-traffic legacy bridge** · L. Make §17.7 bridge live CR M ↔ legacy
  P10 PRIVMSG/NOTICE/TAGMSG + removals/QUIT/KICK/SQUIT (close crdt_shadow.c:1267/1456 "stays on P10"
  gaps), so legacy interop no longer needs the tree as primary. Demo: legacy nef1 + CRDT peers, a
  legacy user messages a CRDT user across a partition, bridged.
- **R6 — demote the P10 tree to legacy-only** · M. Among all-CRDT peers, stop routing live traffic over
  the tree (CR plane authoritative). NO check_loop_and_lh change (per the key decision). Gate on a
  network-wide "all CRDT-aware" check. Risk: split-belief transition (one peer tree, one mesh).
- **R7 — retire BURST + SERVER tree (all-CRDT networks)** · XL · **endgame, gated.** Stop emitting P10
  BURST (already conditional) + retire SERVER-tree introduction; synthetic-anchor identity becomes the
  normal path. Gate: ALL peers CRDT-aware AND **services folded into the IRCd** (X3-in-nefarious — the
  `project_x3_nefarious_merge` track; **do NOT plan X3-as-CRDT-peer**, explicitly wasted effort). §17.7
  gateway is the last P10 surface for any residual legacy peer.

### Two spikes the arc needs
1. ~~**R4 bandwidth measurement**~~ — **DONE 2026-06-11** (`crdt-mesh-r4-bandwidth-spike.md`). Measured
   the CR-delta flood fan-out on the 5-node bed: **10 crossings/op no-batch (2.5× the N−1 optimum),
   3.6 blob-crossings/op under load** (batching amortizes) — **bounded, not exponential → path-vector
   NOT forced.** Decision: **flood, shaped** — widen CR M for CHANNEL traffic (broadcast ≈ tree cost,
   dedup-gated for exactly-once), keep UNICAST hybrid (tree-primary + targeted overlay failover, NOT a
   full N-way flood — flood cost ≈ 2·E so pure-flood unicast is wasteful). Re-measure in bytes if R4a lands.
2. ~~R1 liveness oracle~~ — DONE (CR H beacon). No longer a spike.

### Dependencies / gates
Fix A (post-heal convergence) — DONE, the foundation. R1 liveness — DONE. R2 + R3 are the remaining
prerequisites before R4. R4 is the headline. R5/R6 follow. R7 is gated on all-CRDT + services-fold
(out of this arc's control — separate project). Per-op scoped reconcile (deferred) becomes relevant at
R4+ scale, not before.

## Recommended overall order
Track A (#4, #3) can land anytime, independent. Track B critical path: **R2 → R3 → R4 (headline) → R5 →
R6 → R7(endgame)**. R1 + Fix A already clear the foundation. The first big demonstrable milestone is
**R4** (live traffic survives a tree cut with zero interruption) — that's the visible payoff of "P10
routing retired." Everything before R4 (R2/R3) is prerequisite hardening; everything after (R5/R6/R7)
is widening + endgame.

## Constraints
Standing CRDT-mesh rules: submodule push to `origin crdt-mesh`, testnet pointer staged as ONLY
`nefarious-crdt`, `Co-Authored-By` trailer, configs uncommitted, cmocka gates the image, verify the
`ircd.YYYYMMDDHHMM` symlink advances per build.
