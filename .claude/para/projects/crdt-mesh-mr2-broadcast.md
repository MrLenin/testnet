# CRDT-Mesh MR-2 — Mesh-native broadcast (channel, over the canonical shared tree)

> Third phase of mesh-native routing (scope §6; builds on MR-0's canonical tree +
> MR-1's TTL). Generalizes the R4a **channel** CR-M flood (~2·E) to forwarding over
> the **canonical shared spanning tree** (N−1), with the §0 correctness backstops:
> msgid dedup (already on CR M), TTL (MR-1), and **flood-fallback during adjacency
> flux** (the gap-safety the shared tree needs). Behind a default-off flag.
>
> **Scope note (no silent defer):** this session does the **channel** broadcast leg
> (absorbs R4a). The **all-server** broadcast leg (WALLOPS/GLINE/SHUN/JUPE/ZLINE/
> SETTIME over the mesh) is **MR-2b**, deferred — those P10 broadcast tokens carry no
> msgid today (the §0 prerequisite is unmet for them) and rerouting them is a separate,
> larger, more invasive change. MODE/KICK/TOPIC/JOIN/PART are already CRDT (the doc) —
> not broadcast traffic, no change.

## Why a shared tree needs a flux backstop (the §7a [High] gap)

At steady state every node computes the **byte-identical** canonical tree (proven live
in MR-0), so tree-forwarding is loop-free, gap-free, N−1. The risk is the convergence-lag
window: while adjacency is still propagating, nodes can hold *different* trees → a node may
forward to a neighbor that doesn't expect it (**duplicate** — harmless, msgid-dedup) **or
not forward to a node that does** (**gap** — a lost message, a real regression vs flood).
Mitigation: **tree-forward only when the mesh-map is stable; flood while it is in flux.**
This bounds gaps to zero (we flood exactly when trees can disagree) and keeps N−1 at steady
state. Flood is gap-free always (reaches everyone via every path, dedup-collapsed).

## Design

### 1. Stability signal (integration, crdt_shadow.c)
`g_mesh_changed_ts` bumped to `CurrentTime` whenever a mesh-map row's **peer-set changes**
(not on a same-set beacon refresh), at both feed sites (foreign beacon :124, our own
:170). `crdt_meshmap_row_changed(m,node,peers,n)` (pure, cmocka) compares the new peer-set
to the stored row (count + ordered values; a spurious reorder only causes a brief extra
flood — safe). A removal propagates as neighbors' peer-set changes + our own peer-set change
on a dropped link → captured. `crdt_shadow_mesh_bcast_stable(now)` =
`(now - g_mesh_changed_ts) > CRDT_MESH_BCAST_STABLE` (35 s, > the 30 s beacon interval) AND
we have ≥1 CRDT peer. Unstable → flood; stable → tree.

### 2. Tree-neighbor derivation (pure, cmocka)
`crdt_meshmap_tree_neighbors(tu, tv, nedges, node, out, max)` — given a canonical tree edge
set (from `crdt_meshmap_canon_tree`) and a node, return that node's tree-incident neighbors
(the forwarding set). cmocka: triangle tree {(1,2),(1,3)} → nbrs(1)={2,3}, nbrs(2)={1};
K4 star → nbrs(1)={2,3,4}, nbrs(2)={1}.

### 3. Tree-forward send (integration, m_crdt.c)
`crdt_tree_forward_chan(except_num, msgid, cmd, srcfull, target, ttl, text)`: compute
`crdt_meshmap_canon_tree` → `crdt_meshmap_tree_neighbors(self)` → send the CR M to each
tree-neighbor's peer (`crdt_peer_by_num`) **except `except_num`** (the receive edge; −1 at
the origin). Per-message canon_tree recompute is microseconds at PoC scale (cache opt noted
for scale).

### 4. Wiring (channel CR M only; unicast unchanged from MR-1)
- **Origin** (`crdt_gossip_message`, channel target): flag on + stable → `crdt_tree_forward_chan(-1,…)`;
  else the existing flood. (Builds `srcfull` from `NumNick(from)` once.)
- **Relay** (`ms_crdt` M leg, channel target): flag on + stable → `crdt_tree_forward_chan(cptr_num,…)`;
  else the existing TTL-bounded flood.
- Unicast (MR-1) and the legacy/gateway bridge (R6b) are untouched.

### 5. Flag `FEAT_CRDT_ROUTE_BCAST` (default-off)
Default-off → channel CR M floods exactly as today (R4a). On → tree-forward when stable,
flood when in flux.

## Validation
cmocka first (tree_neighbors + row_changed; canon_tree already pinned). Build (symlink
advances). 5-node bed:
1. **Inert (flag off):** a message to a channel with members on multiple CRDT nodes reaches
   all; CR-M send fan-out = flood (unchanged); converged; 0 crash. No regression.
2. **Flag-on, stable:** same channel message reaches every member-bearing node **exactly-once**,
   but each node's CR-M send count = its **tree degree** (N−1 total), not flood (~2·E). Verify
   by counting `CRDT M <chan>` sends per node in the logs.
3. **Flux:** trigger a topology change (stop/start a node) → during reconverge the channel
   message **floods** (no gap: every member still receives exactly-once); after ~stable window
   → back to tree-forward. 0 crash.

## Live validation result (2026-06-15, 5-node bed)
- cmocka **23/23** (added `test_tree_neighbors` + `test_row_changed`).
- **Inert (flag off):** channel message to a multi-node channel reaches all members
  exactly-once via flood; converged; 0 crashes. No regression.
- **Flag on, stable:** same message reaches every member node **exactly-once**, and the
  CR-M parse count is `origin=0, each leaf=1, TOTAL=N−1=4` — the clean canonical-tree star
  (no duplicates, no gap). 0 crashes.
- **Flux (stop a leaf, send during the window):** all remaining members still receive
  exactly-once (flood-fallback — both the stability gate AND the unresolved-tree-edge
  guard cover it); 0 crashes.

### Investigation note (the apparent "gap" was a measurement artifact)
A first pass *looked* like hub2 only forwarded to 2 of 4 leaves. Instrumentation
(`MR2DBG`, since removed) proved hub2 resolved **all 4** tree-neighbours and sent to all
4; every leaf received exactly once. The confusion: the CR-M command token logs as **`CR M`
on a P10-server link** (compressed, "Server Parsing") but **`CRDT M` on a CRDTMESH overlay
link** (full name, "Client Parsing"), and a send may log as "Adding buffer" *or* "Copying
old buffer" — so greps for `CRDT M`/`Adding buffer` undercounted. Same `CR M`-vs-`CRDT M`
gotcha as MR-1. **Hardening kept:** `crdt_tree_forward_chan` resolves every tree-neighbour
to a direct peer first and **flood-falls-back if any is unresolvable** (an asymmetric/stale
canonical-tree edge that isn't a directly-sendable link), so a tree edge can never silently
gap a subtree.

## Constraints (standing)
Submodule push `origin crdt-mesh`; testnet pointer + MR-2 docs only; trailer `Co-Authored-By:
Claude Opus 4.8 (1M context) <noreply@anthropic.com>`; author MrLenin; `data/ircd*.conf`
uncommitted (carries the flag-enable); flag default-off in the table; throwaway harness not
committed; `scripts/dc.sh`. Update roadmap + memory on landing. **Commit per phase.**
