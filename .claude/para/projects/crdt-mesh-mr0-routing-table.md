# CRDT-Mesh MR-0 — Routing table (observability)

> First concrete phase of the mesh-native-routing track (scope:
> `crdt-mesh-native-routing-scope.md`). **Observability-only — no behaviour change.**
> Derives the routing artifacts the later phases need and measures them against the
> live P10 tree, in the project's standard *inert → shadow-measure → enable* discipline
> (this phase is the inert+shadow half; nothing is promoted to a routing input here).
>
> Read first: `nefarious-crdt/doc/CRDT_MESH_IMPLEMENTATION.md`, the scope doc §4.1 /
> §6 MR-0 / §7a, and `crdt_meshmap.h` (the substrate).

## Goal & exit criterion

Produce, from the already-converged mesh-map (single-writer CR H beacon adjacency), the
two routing artifacts mesh-native routing will run on, **derive them only / route nothing**:

1. **Unicast next-hop table** — from this node, the direct neighbour on the shortest path
   toward every reachable server (the input MR-1 unicast will use).
2. **Canonical (viewpoint-independent) broadcast spanning tree** — the *shared* tree every
   node computes identically from the same adjacency (the input MR-2 broadcast will flood
   over). This is **net-new**: today's `crdt_meshmap_spanning` is per-viewpoint self-rooted
   (every caller passes `ournum` as root) — fine for unicast-from-self, wrong for a shared
   broadcast tree (§7a [High]).

Expose both via a new `/CRDT route` oper view, and add a **routing shadow-oracle**
(`crdt_shadow_route_diff`, the analogue of `crdt_shadow_presence_diff`) that, per
destination, diffs the derived mesh next-hop against the P10 tree's actual next-hop
(`cli_from`). 

**Exit (REVISED after live validation 2026-06-15 — see below):** the original "route-diff
mismatch == 0" criterion was **wrong**. The CRDT adjacency graph is *intentionally richer*
than the P10 tree (it carries cross-links + the CRDTMESH overlay edges), so the mesh
shortest-path legitimately picks different first-hops than the tree's single-uplink path —
`mismatch > 0` is the **normal, correct** steady state, not a fault. The real correctness
signals are:
- **`p10Only == 0`** — the mesh routes to every destination the tree reaches (no adjacency
  gap). *This* is the load-bearing exit criterion (the analogue of presence-diff's treeOnly).
- **canonical broadcast tree identical on every node** — the viewpoint-independence claim.
- **unicast next-hops are valid shortest paths** over the (richer) mesh adjacency.
- **state convergence** — identical digest/mdigest, presence-diff all-zero.
- convergence-lag divergence transient + bounded by the beacon-stale window; 0 crashes.

`mismatch` is a **measurement** (how far the mesh path diverges from the tree), not a
pass/fail gate. No flag flips any behaviour — `/CRDT route` is read-only and the oracle
only logs.

### Live validation result (2026-06-15, 5-node bed nef3=hub2 + leaf2-5)
- Converged: all 5 nodes `5 servers, 7/7 users, 3 channels, 0 mismatch`, identical
  `digest=a0783a892a7d6805 mdigest=912c7752de835d0f`, presence-diff all-zero, 0 crashes/cores.
- **Canonical broadcast tree byte-identical on every node**: `hub2-leaf2 hub2-leaf3
  hub2-leaf4 hub2-leaf5` (star at the lowest numeric — root-free Kruskal-lex). ✓
- Unicast next-hops are correct shortest paths (e.g. leaf4→leaf3 via hub2 — no direct mesh
  edge; leaf4→leaf2/leaf5 direct — cross-links present).
- route-diff: `p10Only 0` and `meshOnly 0` on **every** node; `mismatch` 1-3 per node =
  the leaves' cross-link/overlay edges that the P10 single-uplink tree doesn't have. Exactly
  the expected "mesh richer than tree" divergence.

## Net-new pure primitives (cmocka-first — these gate the image)

Both land in `crdt_meshmap.c` / `crdt_meshmap.h` (pure libc, already linked into
`crdt_meshmap_cmocka` as `../crdt_meshmap.o` — **no Makefile change**), TDD red→green like
the existing meshmap primitives. Both use `static` scratch (CRDT_MAX_SERVERS=4096 → no big
stack frames, matching `crdt_meshmap_spanning`/`_reachable`).

### 1. `crdt_meshmap_nexthop` — unicast next-hop from a viewpoint
```c
/** Per-destination first-hop from @a from over the shortest-path (BFS) tree.
 *  nexthop[d] = the direct neighbour of @a from on the shortest path from->d,
 *  or -1 for @a from itself and for unreachable d.  Neighbours expanded in
 *  ascending numeric order (deterministic, matches crdt_meshmap_spanning).
 *  @a nexthop is int16_t[CRDT_MAX_SERVERS].  Returns reachable count (>=1). */
int crdt_meshmap_nexthop(const struct CrdtMeshMap *m, uint16_t from,
                         time_t now, time_t stale, int16_t *nexthop);
```
Impl: BFS from `from`; when expanding edge u→v, `firsthop[v] = (u==from) ? v : firsthop[u]`.
Single pass, own static queue, neighbours sorted ascending.

cmocka contract:
- chain 1-2-3-4 from 1 → nexthop[2]=nexthop[3]=nexthop[4]=2; nexthop[1]=-1.
- star hub 1 → nexthop[2]=2, nexthop[3]=3, nexthop[4]=4 (direct).
- diamond 1-{2,3},4-{2,3} from 1 → nexthop[2]=2, nexthop[3]=3, **nexthop[4]=2** (4 via 2,
  2<3 — same tie-break as `_spanning`'s parent[4]=2).
- partition / disconnected → unreachable dest = -1; reachable count excludes them.
- from a leaf (chain from 4) → nexthop[1]=nexthop[2]=nexthop[3]=3.

### 2. `crdt_meshmap_canon_tree` — canonical shared broadcast tree (root-free, Kruskal-lex)
```c
/** Canonical (VIEWPOINT-INDEPENDENT) spanning forest over FRESH edges: Kruskal
 *  over undirected edges keyed (min,max) ascending + union-find.  A pure function
 *  of the fresh-edge set => every node computes the SAME tree (the shared-tree
 *  prerequisite for loop-free broadcast, scope §4.1).  Writes up to @a max tree
 *  edges as (u<v) into @a tu/@a tv; returns the TOTAL tree-edge count (> max =>
 *  truncated, like crdt_meshmap_crossedges).  Edge {u,v} exists iff both fresh and
 *  (v in peers[u] OR u in peers[v]) — symmetric closure, robust to warmup. */
int crdt_meshmap_canon_tree(const struct CrdtMeshMap *m, time_t now, time_t stale,
                            uint16_t *tu, uint16_t *tv, int max);
```
Impl: collect normalized fresh edges (min,max) into a static buffer, sort lex, unique,
Kruskal with union-find over [0,CRDT_MAX_SERVERS). `#define CRDT_MESH_MAXEDGES` documented;
exceeding it truncates and the integration layer logs (no silent cap — project rule).

cmocka contract (the **canonicality** assertions are the point — results are root-free, so
they differ from a rooted BFS):
- triangle 1-2-3 → tree {(1,2),(1,3)} (2 edges); **NOT** a from-3 BFS result — same from any
  viewpoint.
- diamond 1-{2,3},4-{2,3} → {(1,2),(1,3),(2,4)} (3 edges / 4 nodes).
- K4 fully meshed → lex-min = star at 1: {(1,2),(1,3),(1,4)} (3 edges).
- disconnected {1,2}+{5,6} → forest {(1,2),(5,6)} (2 edges, 2 trees).
- stale node pruned from the edge set; truncation returns total though only `max` written.

## Integration (no behaviour change)

### `/CRDT route` (m_crdtinfo.c)
New subcommand (dispatch `'r'`), alongside map/peers/status:
- **unicast table** — for each reachable destination: `name  via <next-hop name>  (Nhops)`
  using `crdt_meshmap_nexthop(self)` + `_spanning` depth.
- **broadcast tree** — render `crdt_meshmap_canon_tree` rooted-for-display at the lowest
  reachable numeric (display rooting is cosmetic; the edge set is the canonical artifact),
  /MAP-style, reusing the existing glyph renderer.
- **oracle line** — call `crdt_shadow_route_diff(sptr)`.

### `crdt_shadow_route_diff` (crdt_shadow.c) — the routing shadow-oracle
Mirror `crdt_shadow_presence_diff` exactly (gated `shadow_on() && FEAT_CRDT_PRIMARY`;
`to==NULL` → system log from the verify timer, a Client → NOTICE from `/CRDT route`):
- mesh next-hop: `crdt_meshmap_nexthop(self)` → `mesh_nh[d]` (neighbour numeric).
- P10 next-hop: for each CRDT-aware non-stub server `d`, `p10_nh[d] = numeric(cli_from(d))`
  (our direct neighbour toward d; `cli_from(d)==d` when d is directly linked).
- classify per destination: **agree** (same next-hop), **mismatch** (both reachable,
  different next-hop), **meshOnly** (mesh routes it, P10 doesn't — overlay/stub win,
  expected like presence-diff's meshExtra), **p10Only** (P10 reaches it, mesh doesn't —
  an adjacency gap to investigate before MR-1 trusts the table). Emit a one-line
  `CRDT route-diff: agree N mismatch N meshOnly N p10Only N` summary; cap any per-dest
  detail lines (MAT_LOG_CAP style).
- also call it from the verify timer (next to `presence_diff`) so steady-state numbers land
  in the system log without an oper poking `/CRDT route`.

No new feature flag (observability is unconditional under shadow_on); no doc/engine change;
no change to materialization or the existing FindNServer reachability path.

## Validation

cmocka green first (gates the image; verify the `ircd.YYYYMMDDHHMM` symlink advances after
`scripts/dc.sh -l --profile multi build nefarious3..7`). Then the 5-node bed (recreate all 5
for a clean bed):
1. converged 5/0 → `/CRDT route` on each node: unicast next-hops sane; **broadcast tree
   identical on every node** (the canonicality check — capture from all 5, diff).
2. `crdt_shadow_route_diff`: steady-state **p10Only==0** (the gate); mismatch may be >0
   (mesh cross-links/overlay shorter than the tree — expected) and meshOnly >0 only with
   overlay-only peers.
3. stop/start a leaf (or SQUIT/iptables a link) → oracle reflects the topology change then
   re-converges within the beacon-stale window (the bounded-lag claim); 0 crashes.

## Constraints (standing)

Submodule push `origin crdt-mesh`; testnet pointer staged **only** `nefarious-crdt`; commit
trailer `Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>`; author
MrLenin; `data/ircd*.conf` uncommitted; throwaway harness not committed; `scripts/dc.sh`
(not raw compose build); **ask before committing**. Update `crdt-mesh-roadmap.md` + memory on
landing.
