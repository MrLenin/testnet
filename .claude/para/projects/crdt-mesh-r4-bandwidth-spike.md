# R4 bandwidth spike — gossip-flood vs path-vector (RESOLVED: flood/hybrid)

Resolves the roadmap's **Spike #1** ("does the CR-M flood suffice for steady-state live traffic, or
is path-vector forced? Measure before committing R4's shape" — `crdt-mesh-roadmap.md` §"Two spikes").
Run 2026-06-11 on the freshly-built 5-node bed (8 CR edges: 4 tree + 4 overlay; diameter 4).

## Method
The existing **CR D delta flood** (eager multi-hop relay `crdt_relay_delta`, m_crdt.c:171; `applied>0`
+ state-vector dedup at m_crdt.c:298-306) is the *exact* gossip substrate R4 would reuse for live
messages — same `IsCrdtSyncTarget` peer set, same dedup. So we characterize R4's per-message flood by
injecting controlled doc ops (NICK changes on nef6, the deepest node — each mints one nick-LWW op that
floods as CR D) and counting **edge-crossings** = CR-delta receive log lines (`<YXX> CR D` tree form +
`:name CRDT D` overlay form) across all 5 nodes. Idle baseline = **0** crossings (clean window).
Harness: `/tmp/crdt4c/{nickflip.py,r4bw.sh,r4bw2.sh}` (throwaway, not committed).

## Results
| Run | Ops | Spacing | Total crossings | Per-op | Per-node |
|---|---|---|---|---|---|
| Under load | 10 | 1.5s (batches) | 36 | **3.6 blob-crossings/op** | n3=12 n4=9 n5=9 n6=0 n7=6 |
| No-batch   | 6  | 5s (isolated)  | 60 | **10.0 crossings/op**      | n3=20 n4=13 n5=15 n6=0 n7=12 |

Optimal (one apply per non-origin node) = N−1 = **4**. Theoretical max for 8 bidirectional edges = 16.

### Interpretation
- **The flood is BOUNDED, not exponential.** No-batch fan-out 10/op sits between optimal (4) and the
  16-edge ceiling — dedup (SV `applied>0` relay guard) suppresses ~6 of the 16 possible re-relays per
  op. An un-dedup'd flood would ping-pong into the hundreds. **Path-vector is NOT forced.**
- **Redundancy ≈ 2.5×** (10 vs 4) in this *dense* mesh — each node receives each op roughly once per
  incident CR edge before dedup stops the re-relay (nef3 the 4-edge hub gets ~3.3×/op; the 3-edge
  leaves ~2-2.5×). This is the cost of the redundant overlays — i.e. **flood cost ≈ 2·E**, growing with
  mesh density, NOT with a per-message target.
- **Batching is a strong mitigator.** Under load, op-coalescing into CR D blobs dropped the *blob*
  crossing count to 3.6/op — ~2.8× fewer wire frames than the no-batch op count. So the **byte** cost
  under real load is far below the 10×-raw figure; the periodic push + eager relay amortize.
- **Cost asymmetry (the decisive finding).** The flood delivers every message to *all* N servers (each
  must receive+dedup), regardless of recipient count:
  - **Channel/broadcast** msg: flood ~2.5× the spanning-tree's N−1 sends — **acceptable** (the message
    has to reach most servers anyway; batching amortizes).
  - **Unicast PM**: flood still hits all N (~2E crossings) for a *one-recipient* message vs the tree's
    path-length (1 hop adjacent … 4 hops worst here). **Wasteful, and worsens as the network grows.**

### Rough byte estimate (grounding)
CR M framing overhead ≈ 43–60 B over a bare PRIVMSG (msgid + `CR M <cmd> <srcYXX> <tgt>`; m_crdt.c:226).
A ~100 B channel line flooded = ~10 × ~150 B ≈ **1.5 KB** mesh-wide vs tree 4 × ~110 B ≈ 440 B (~3.4×).
Same line as a unicast PM = same ~1.5 KB flood vs tree 110 B–440 B (**3–14×**). Asymmetry confirmed.

## Recommendation — flood, shaped (NOT path-vector, NOT pure-flood-everything)
1. **Adopt the gossip flood** as R4's routing substrate (it's proven, bounded, and already shipped). Do
   **NOT** build path-vector/link-state — bandwidth does not prove intolerable, and path-vector re-opens
   the abandoned-4a per-viewpoint-topology problem (roadmap §"key decision"). Confirmed empirically.
2. **Widen CR M for CHANNEL traffic first** (R4a) — broadcast-shaped, where flood ≈ tree cost. Generalize
   the `relay_*`/`server_relay_*` mesh-only member branches (ircd_relay.c:560/846, m_tagmsg.c) from "≥1
   member is mesh-only" to "≥1 member is on a CRDT peer," with **R3's msgid dedup gating exactly-once at
   the client** (a member reachable via BOTH tree and flood must not double-receive — this is the hard
   part, and why R3 is the prerequisite).
3. **Keep UNICAST hybrid** (R4b) — tree-primary for the direct path; CR M only adds the *redundant/
   failover* path, not a full N-way flood. The mesh-only-target branch (ircd_relay.c:1297) already does
   the failover; "zero-interruption on a tree cut" for in-flight unicast wants the sender to *also* emit
   on overlay edges pre-emptively (1 extra copy), NOT flood to all N. Pure-flood unicast is the one thing
   the measurement says to avoid.
4. **Density discipline.** Flood cost ≈ 2·E, so keep the overlay set sparse-but-2-connected (the current
   4-overlay/5-node bed is already on the dense side for its size — fine for a testbed, but a production
   topology should not add overlays beyond 2-connectivity without re-measuring).
5. **Re-measure in BYTES under representative load** if/when R4a lands (this spike counted frames/ops;
   a byte-level `ss`-counter run under a realistic channel-chat load would tighten the 3.4× estimate).
   Not a blocker for starting R4a — the flood-vs-path-vector decision is settled.

## Bottom line
Flood viable, path-vector rejected (empirically, not just by argument). R4 = **flood channel traffic
(dedup-gated) + hybrid unicast (tree + targeted failover)**, in that order, with R3 exactly-once as the
gating prerequisite. The headline R4 demo (live traffic survives a tree cut, zero client interruption)
is reachable on this substrate without a routing-protocol rewrite.
