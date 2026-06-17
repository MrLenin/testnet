# CRDT-Mesh — Mesh-Native Routing (R7b enabler): Scope & Outline

> Status: **scoping only — not scheduled for implementation.** This is the design on-hand for the one
> thing that R7b (retiring the P10 SERVER/SQUIT/BURST tree among CRDT peers) actually needs: a routing
> layer that does not depend on P10's tree.
>
> Read first: `nefarious-crdt/doc/CRDT_MESH_IMPLEMENTATION.md` and `…/CRDT_S2S_PROTOCOL.md` (the
> as-implemented state this builds on). Related: `crdt-mesh-roadmap.md` (R7a done / R7b infeasible-as-
> prefix-hiding), memory `project_crdt_r7a_squit_only`.

---

## 0. Adversarial review outcome & revised direction (2026-06-15)

A Plan-agent adversarial pass (grounded in source) returned **"sound-with-one-fatal-gap."** The
routing-layer half is buildable; the gateway headline is solvable but was mis-framed; and one
load-bearing premise was flat wrong. The corrections below **supersede** the original sections noted;
the rest of the document is retained for context and amended by these.

**FATAL CORRECTION — legacy presence must NOT go in the doc `servers` collection (supersedes §4.2/§7.7).**
The original plan had the gateway mirror legacy *server* presence into the `servers` LWW collection,
with leaves anchoring from the doc. But `crdt_shadow_server_add()` is a deliberate **no-op**
(`crdt_shadow.c:502-505`); its 27-line rationale (`:475-501`) documents that exactly this — per-server
ACTIVE/SPLIT in the convergent doc — was built in Phase 4a, **live-tested, and proved non-convergent**
(reachability is per-viewpoint; racing SPLIT/ACTIVE ops get GC'd before the self-heal propagates →
permanently-stale nodes). It is the very failure the mesh-map's topology-vs-reachability split was
built to *replace*. Reviving it sinks MR-3/MR-5 and the whole R7b payoff. **Revised approach:**
represent legacy presence via the **single-writer beacon path** — the gateway proxy-beacons liveness
for each legacy server it fronts (single-writer = the converged property the multi-writer servers-map
lacked) + a single-writer legacy-server row; leaves anchor from the beacon exactly as for CRDT servers.
(Open: ownership/lease when the gateway partitions — see CRITICAL-2 in the review notes, §7a.)

**GATEWAY REFRAME — prevent-by-construction, not detect-then-elect (supersedes §7.1).** Detect-after-
the-fact is structurally too late: a second gateway's legacy link does its P10 damage (duplicate-SERVER
collisions, squit cascade) at `server_estab`, ≥30 s before any beacon-based detection could fire.
Therefore:
- **Steady state = single gateway by construction.** A legacy-facing CRDT node gates its legacy-link
  *establishment* on a locally-computed **deterministic agreement function** (e.g. lowest gateway
  numeric for a given `legacy_net_id`) over the converged beacon set — it does not bring the link up
  unless it is the designated gateway. (Agreement-by-rule, **not** a runnable election — a CRDT doc
  converges values, it cannot run consensus.)
- **`legacy_net_id`** (a *configured* network identity, gossiped on the beacon) is the missing
  primitive that distinguishes "second gateway to the SAME legacy net" (loop) from "gateway to a
  DIFFERENT net" (fine). P10 has no native per-network token (MISSING-1).
- **"Election" → standby-promotion-on-confirmed-failure only.** Backups stay configured-but-not-
  established; one promotes when the incumbent's beacon goes stale; the loser of any contention cleanly
  **SQUITs** its legacy link (never "just stop routing" — that leaves a half-open link legacy still
  believes is live).
- **Last-resort backstop:** the split-brain-both-healthy case (incumbent partitioned from the mesh but
  still legacy-linked → a standby promotes → two live gateways) is **unresolvable at the CRDT layer**;
  it needs a P10-side **SERVER-collision tiebreak** (lower-numeric gateway wins; the higher self-aborts
  `server_estab` on seeing the incumbent's prefix already arriving from legacy).

**PHASING REPRIORITIZED (amends §6).** The **pure-CRDT fast track is now the PRIMARY target**, not a
footnote. An all-CRDT segment (no legacy behind the mesh) deletes the fatal gap, the entire gateway
apparatus, and CRITICAL-2 — leaving a self-contained routing problem (shared tree + unicast + TTL +
dedup) that ships R7b for greenfield CRDT segments. The **legacy-gateway story becomes a separate,
harder, later project** whose value is shrinking anyway (the X3→nefarious merge removes the biggest
legacy server the gateway exists to serve). Note also: **MR-3 is a prerequisite of MR-1/MR-2 for legacy
destinations** (can't route to a legacy user whose server isn't mesh-representable) — in the pure-CRDT
track there are no legacy destinations so the dependency dissolves; in the legacy track MR-3 must
precede MR-1/2.

**Hard prerequisites promoted from "open question" to "must-have" (amends §5/§7):**
- **TTL / hop-limit on every routed frame.** Confirmed absent everywhere today (termination is
  SV-dedup for durable deltas + the 90 s msgid window for CR M). A next-hop-routed unicast over a
  transiently-inconsistent graph has **no** dedup and **no** TTL → one inconsistency is a packet storm.
  TTL is a prerequisite of **MR-1**, not a later refinement.
- **A msgid on every broadcast frame.** Dedup is the stated correctness backstop for spanning-tree
  disagreement during convergence lag, but only CR M carries a dedupable msgid today; MODE/KICK/TOPIC/
  GLINE/WALLOPS/SETTIME do not. Prerequisite of **MR-2**.
- **Event-driven beacon on adjacency change.** Beacons are timer-only (30 s) so reconvergence /
  black-hole / failover windows are bounded by the 90 s staleness floor — including a **90 s legacy
  outage floor** on gateway failover. A "my adjacency changed, beacon now" fast-path is needed to make
  any of these acceptable.

**The 3 decisions that gate going forward:**
1. Can **single-writer** (beacon-proxied) legacy presence be shown convergent under a partition test
   where the multi-writer servers-map failed? If not, the legacy track is dead → pure-CRDT only.
2. Adopt **`legacy_net_id` + prevent-by-construction** gateway gating (above).
3. Make **pure-CRDT routing the primary deliverable**; treat the legacy gateway as separate/maybe-never.

---

## 1. Goal

Make the CRDT mesh the **routing substrate** for server-to-server traffic among CRDT-aware servers,
so the P10 SERVER/SQUIT tree (and the BURST it carries) can be retired between them. Legacy (non-CRDT)
P10 servers keep pure P10, reached through a CRDT↔legacy **gateway**. The end state: a network of
CRDT-aware servers needs **no spanning tree, no SERVER introductions, no SQUIT cascade** to deliver
messages — presence comes from the doc + beacons (already true), and *routing* comes from the mesh.

This is explicitly the enabler R7b lacked. It is large (XL), multi-phase, and gated; this document
scopes it, it does not commit to it.

---

## 2. Why the tree can't just be suppressed (the R7b finding, restated)

P10 is a **flat server namespace with hierarchical delivery**. Two consequences make naïve SERVER
suppression impossible (proven live — see roadmap R7b / memory):

1. **Every relaying server's prefix must be known network-wide.** `ms_server` attaches a relayed
   server under its source-prefix and *drops* any message whose prefix it doesn't know. Suppressing a
   CRDT server's SERVER intro orphans everything sourced through it.
2. **Legacy servers are relayed *into* the mesh as P10 SERVER intros today**, carrying a CRDT-server
   prefix. Suppress that prefix and the legacy server (e.g. `x3.services` behind the gateway) vanishes
   on any CRDT leaf that has no direct P10 link to the introducer → its users can't materialize.

The fix is **not** to hide prefixes; it is to **stop routing over the P10 message layer** between CRDT
peers and route over the mesh instead — and to represent legacy presence in the *doc*, not via P10
SERVER relayed across the mesh. Then there is no prefix to be unknown.

---

## 3. What already exists (the substrate we build on)

Mesh-native routing is **mostly promotion of existing fallback mechanisms to the primary path**, not
green-field. Inventory of what's already shipped and reusable:

| Capability | Where | Reuse for routing |
|---|---|---|
| Server presence (doc) | `servers` LWW collection; CR H beacon set | "who exists" — already authoritative, tree-independent |
| User presence/identity (doc) | `users` LWW collection + synthetic anchors | "who is where" — numeric→server map for routing + source attribution |
| Reachability + topology | `crdt_meshmap.c` (BFS, **deterministic spanning tree**, cross-edges) | the routing graph — already converged, locally derived, single-writer adjacency |
| Ephemeral message gossip | **CR M** (`m_crdt.c`): source-from-doc, deliver-local, relay, windowed dedup | the prototype of mesh-native message delivery (today a *partition fallback*) |
| Channel-over-mesh + legacy bridge | R4a (CR M channel flood) + R6b (CR-M→legacy) | mesh-native channel broadcast, already partly the primary path |
| Partition presentation to legacy | R6c (`crdt_present_stub`, `FLAG_CRDT_PRESENTED`) | the seed of "gateway = legacy face of the mesh" |
| Doc→legacy state bridge | §17.7 gateway (drive-through-real-handler) | the template for doc→legacy *traffic* bridging |
| Liveness without SQUIT | R7a (beacon-stale + keep-gate + sweep) | server-departure detection already tree-independent |
| Numeric capacity advertisement | CR H beacon `nn_cap`; doc | replaces the capacity field SERVER carried |

**Key reframing:** CR M already does mesh-native unicast+channel delivery (with dedup and doc-sourced
identity) — it is just scoped to mesh-only targets as a partition fallback. Mesh-native routing is
largely *"make the CR-M-class path primary for CRDT-aware destinations, shaped for efficiency, and
mirror legacy presence into the doc so the tree is no longer load-bearing."*

---

## 4. Target model

### 4.1 The routing graph = the gossiped mesh-map

The mesh-map already converges a **single-writer adjacency** (each node owns its peer-set on its CR H
beacon, outside the digest → cannot diverge) and derives a **deterministic BFS spanning tree** +
cross-edges locally. Promote this from observability to routing:

- **Broadcast (channel, all-server):** forward along a **shared canonical spanning tree** — every node
  independently computes the *same* tree from the same adjacency, then floods tree-edges except the one
  it received from → N−1 cost, loop-free, no per-source state, no SERVER/SQUIT maintenance. Cross-edges
  are **failover**, not primary. **Determinism is essential** (the tree only works if all nodes agree),
  so build it by a **canonical lexicographic construction**, preferring the **root-free** form:
  - *(preferred)* **lexicographically-minimal spanning tree** — Kruskal over edges keyed
    `(min(u,v), max(u,v))` + union-find. No root agreement at all (a pure function of the edge set),
    and churn-stable (an edge change perturbs only one fundamental cycle). Unweighted → does not
    minimize depth.
  - *(alternative)* **rooted canonical BFS** — root = canonical lowest numeric, neighbours in lex order
    (≈ today's `crdt_meshmap_spanning`, `crdt_meshmap.c:138`). Minimal depth → lowest latency, but
    requires root agreement (root can flap when the lowest-numeric node joins/leaves).

  Pick by measurement at scale (R4-spike methodology): latency (favours BFS depth) vs reconvergence
  churn + no-root-flap (favours MST-lex). Both are pure, cmocka-pinnable like the existing meshmap
  primitives. **Caveat:** canonicality only guarantees *same graph → same tree*; it does NOT cover the
  convergence-lag window where nodes hold *different* adjacency — that still needs the msgid + TTL +
  flood-fallback backstop (§0). (Lex-BFS *the algorithm* is itself rooted and its chordal-recognition
  properties aren't what's needed; the value here is the canonical lexicographic ordering, which either
  form provides.)
- **Unicast (user→user, server-targeted):** path-selected **next-hop** toward the destination's owning
  server (from the spanning tree / shortest path), not a flood. (The R4 bandwidth spike already ruled
  out pure-flood unicast: flood ≈ 2·E.)
- **Robustness during convergence lag:** adjacency converges with a small lag, so nodes can transiently
  disagree on the tree. Backstop with the **existing windowed msgid dedup** (loops are harmless) and a
  **flood-fallback** when next-hop is unknown/stale. This is the same "primary fast path + gossip
  substrate for robustness" pattern the eager CR-D relay already uses.

> Decision to resolve with measurement (R4-spike methodology): shared-deterministic-tree vs
> reverse-path-forwarding vs flood-shaped. Recommendation: shared-tree primary + dedup/flood backstop.

### 4.2 Legacy presence rides the single-writer BEACON path, not the doc `servers` map  *(corrected per §0)*

> ⚠ The original draft put legacy server presence in the `servers` doc collection. **That is the
> Phase-4a model the code already proved non-convergent** (`crdt_shadow.c:475-505`) — see §0 FATAL
> CORRECTION. The corrected design below uses the *converged* half of the topology split (single-writer
> beacons), never the failed `servers` map.

The crux that resolves the R7b breakage — **nothing is P10-relayed into the mesh, so no prefix can be
unknown** — still holds; only the carrier changes from the (failed) doc `servers` map to the (proven)
beacon path:

- The **gateway proxy-beacons each legacy server it fronts**: it emits a CR H beacon carrying the
  legacy server's numeric / name / capacity (today `crdt_gossip_beacon`, `m_crdt.c:238`, beacons only
  for `&me` — extending it to foreign numerics is the work; the receive side already keys on the
  beacon's `<srvYXX>` field, not the relayer, so it would accept it). **Single writer = the converged
  property** the multi-writer servers-map lacked. CRDT leaves then **anchor the legacy server from the
  beacon** via the existing `crdt_shadow_make_anchor` Case-B path, exactly as for a CRDT server — **no
  P10 SERVER intro ever crosses into the CRDT mesh.**
- Legacy *users* are already minted into the `users` doc by the node that processes the P10 NICK
  (that's why the gateway held the X3 service users during R7b debugging); leaves materialize them onto
  the proxy-beaconed legacy-server anchor.
- **Ownership/lease (open, CRITICAL-2):** the gateway is the *sole* writer/beaconer for legacy state.
  When it partitions from the mesh, that state goes stale at 90 s while legacy is still up. Needs a
  defined ownership-handoff (ties into the standby-promotion failover, §0/§7.1) and possibly a
  longer-than-beacon lease for gateway-proxied legacy rows.

### 4.3 The gateway = the legacy face of the entire mesh

To the legacy P10 network, the whole CRDT mesh appears as **one P10 subtree behind the gateway**
(R6c generalized from a single stub to the whole mesh). The gateway:

- holds the real P10 link(s) to legacy and is the **only** P10 attachment point for the mesh;
- translates **P10 → CR** (legacy-originated traffic enters the mesh as mesh-routed CR) and
  **CR → P10** (mesh traffic to legacy members re-emitted as P10, sourced correctly — the §17.7
  gateway already does this for state; generalize to all traffic);
- presents CRDT servers/users to legacy as P10 SERVER/NICK behind itself (so legacy prefixes are
  always the gateway or things behind it — known by construction).

### 4.4 Transport: the CRDTMESH overlay becomes the first-class CRDT↔CRDT link

Today the `crdtmesh` overlay is a **second-class redundant backstop** — a CR-only edge layered on top
of the P10 server links so doc/liveness still flows if a P10 edge drops, implemented as a permanent-
`STAT_HANDSHAKE` link dispatched through the UNREG `mr_crdt` slot (a deliberate minimal hack). **Mesh-
native routing is the tipping point that makes it first-class**, because in the pure-CRDT endgame the
two link kinds *specialize*:

- **CRDT↔CRDT = the overlay** (pure CR, no tree baggage). Once SERVER/SQUIT/BURST are retired among
  CRDT peers, a "CRDT-aware P10 server link" is a hollowed-out half-state — a `STAT_SERVER` carrying no
  tree, no burst, no squit, only CR. The overlay is the **honest primitive for exactly that**: never a
  server, never carried the tree, already CR-only. The right endgame link is the overlay, not a
  tree-link with its tree surgically removed.
- **CRDT↔legacy = the P10 server link** (tree needed toward legacy), held only by the gateway.

This **reframes MR-5 (R7b)**: instead of "suppress SERVER/SQUIT/BURST on CRDT-aware P10 links" (hollow
out the tree-link), the cleaner path is "**make CRDT↔CRDT links overlays**, on which there is *nothing*
to suppress" — tree-retirement falls out for free because an overlay never carried a tree. Both
approaches converge on the same wire (a CR-only link); the overlay reaches it without the half-state.

**Cost — the honest "annoying" part** (work the original "no new transport" non-goal glossed over):
- a **proper lifecycle/status** instead of permanent-`STAT_HANDSHAKE` + UNREG-slot dispatch (a real
  registered CR-peer state, clean teardown/relink — not the ping-exempt + beacon-stale hack alone);
- making the overlay the **primary autoconnect form** for CRDT peers (today it is often passive/
  redundant — see the `crdtmesh` Connect blocks in `data/ircd*.conf`, mostly `autoconnect = no`);
- solidifying **numeric/identity registration** (today partition-tolerant but ad-hoc) and **addressing**
  (the doc + mesh-map already give numeric→server; the overlay peer must be first-class addressable);
- a **migration** from existing CRDT-aware P10 links to overlays (new deployments can start
  overlay-primary; mixed must interoperate per the §7a CRDT-subgraph-connectivity invariant).

The "no new **socket** layer" non-goal still holds — this is the *existing* CR-over-TCP transport,
promoted from second-class to primary. What it is **not** is free. (This phase likely sits in the
pure-CRDT track alongside / as part of MR-5; it does not require the legacy gateway.)

---

## 5. Routing primitives to cover

A complete replacement of P10 message routing must handle every traffic class the tree carries today:

| Class | Examples | Mesh-native approach |
|---|---|---|
| **Unicast user** | PRIVMSG/NOTICE/TAGMSG to a user, INVITE, KILL, WALLOPS-to-user | next-hop toward target's server (CR M generalized, path-selected) |
| **Channel broadcast** | PRIVMSG/NOTICE/TAGMSG #chan, MODE, KICK, TOPIC, JOIN/PART | shared-tree flood to member-bearing servers (R4a/R6b generalized) |
| **All-server broadcast** | WALLOPS, GLINE/SHUN/JUPE/ZLINE, global server notices, SETTIME | shared-tree flood to all CRDT servers + gateway→legacy |
| **Server-targeted** | remote STATS/TRACE, CONNECT, the SQUIT *command*, MOTD | next-hop to the named server; oper/admin path |
| **State** (already CRDT) | NICK/user/channel/member/ban/mode/topic | already the doc — no change |
| **Numeric allocation** | (was in SERVER intro) | beacon `nn_cap` + doc — already covered |

Order-sensitivity audit (each must be confirmed CRDT-resolved or sequenced):

- **NICK collision** — already resolved (§17.5 force-rename, home-server-authoritative, doc-level) —
  mesh reordering does not change it.
- **KILL** vs racing message/NICK — KILL is a doc delete (tombstone) + a notice; LWW/tombstone
  ordering resolves the state, but the *unicast KILL delivery* timing vs an in-flight message needs a
  validation pass.
- **Channel MODE / member races** — already CRDT (OR-Sets + priority + LWW) — fine.
- **Commands assuming tree walk** (LINKS, MAP, TRACE, STATS l, /SQUIT, /CONNECT) — these enumerate or
  traverse the P10 tree; they need mesh-aware reimplementation or gateway translation. Bounded set;
  mostly oper/admin. (`/CRDT map` already shows the mesh — generalize.)

---

## 6. Phasing (each gated, shadow-measured, reversible — the project's standard discipline)

> **Reprioritized per §0:** the **pure-CRDT track (MR-0/1/2 + TTL + dedup, no legacy) is the primary
> deliverable** and ships R7b for greenfield CRDT segments. MR-3/MR-4 (legacy gateway) are a separate,
> later, possibly-never track. Cross-deps the review found: MR-3 precedes MR-1/2 *for legacy
> destinations*; MR-0 must **write** the shared-root spanning tree (net-new, not "print existing");
> the gateway gating belongs at MR-3, not MR-4.

Mirrors how R4→R6→R7a landed: build inert, measure in shadow, enable behind a flag, validate on the
5-node hybrid bed before the next phase.

- **MR-0 — Routing table (observability).** Derive next-hop + a shared deterministic spanning tree
  from the existing mesh-map; expose via `/CRDT route`. Log next-hop vs the P10 tree's path (a
  presence-diff analog). No behavior change. *Exit: derived routes match the P10 tree on the converged
  bed; convergence-lag bounded.*
- **MR-1 — Mesh-native unicast (CRDT↔CRDT), shadow then primary.** Route user-unicast over CR to
  CRDT-aware destinations using the routing table; keep the P10 tree as fallback. Generalize CR M off
  the mesh-only restriction. *Exit: unicast delivered mesh-native with the tree disconnected (in test),
  exactly-once, latency within target.*
- **MR-2 — Mesh-native broadcast.** Channel + all-server broadcast over the shared tree (absorbs/
  generalizes R4a/R6b). *Exit: WALLOPS/GLINE/channel reach every CRDT server + legacy via the gateway,
  exactly-once, N−1 cost.*
- **MR-3 — Legacy presence into the mesh (via the BEACON, not the doc).** ⚠ The "into the `servers`
  collection" wording here was the pre-§0 framing and is **WRONG** (the `servers` map is the proven-non-
  convergent Phase-4a path, `crdt_shadow.c:512-542`). **Corrected + fully scoped in the standalone doc
  `crdt-mesh-mr3-legacy-presence.md`:** the gateway **proxy-beacons** each legacy server it fronts
  (single-writer); CRDT leaves **anchor** it from that beacon (Case-B `crdt_shadow_make_anchor`); the
  legacy SERVER intro toward CRDT peers is suppressed (`crdt_should_suppress_intro`). Flag
  `FEAT_CRDT_LEGACY_PRESENCE`; lease (`CRDT_BEACON_STALE_PROXY`) for the gateway-partition case;
  single-gateway prerequisite. *Exit: a CRDT leaf with no direct P10 link sees all legacy servers+users
  via the beacon-anchored path (the exact R7b failure case now passes).*
- **MR-4 — Gateway as the mesh's legacy face.** Formalize P10↔CR translation for all traffic classes;
  define the single/designated-gateway model (§7). *Exit: legacy interop matrix green across cut/relink
  with the gateway as sole P10 face.* **Fully scoped + source-grounded: `crdt-mesh-mr4-gateway-traffic.md`.**
  Key correction to the bullets above: only **CR→legacy UNICAST** is a real gap (a confirmed dead-sink at
  `m_crdt.c:646` — floods then drops, because the 'M' handler only does `MyConnect` delivery); channel /
  all-server / P10→CR-unicast / doc-native bans already work. Fix = a `fronted_by` append-only beacon field
  + route-to-gateway + a CR→P10 re-emit branch (reusing the R6b channel-bridge idiom). MR-4a (inert oracle +
  fronted_by) → MR-4b (the bridge, `FEAT_CRDT_GATEWAY_BRIDGE`) → MR-4c (INVITE/KILL) → MR-4d (multi-gateway
  gating, `legacy_net_id`). NB the §5 "Unicast user" row is WRONG that MR-1 covers it (a legacy anchor has
  `peers="*"` → unroutable; `fronted_by` is REQUIRED) — see that doc §9.
- **MR-5 — Retire SERVER/SQUIT/BURST among CRDT peers (= R7b).** With routing + legacy presence fully
  mesh-native, suppress SERVER intros among CRDT-aware-both-ends peers (the thing R7b couldn't do), and
  drop BURST entirely (CR-F already replaces it). One flag, atomic with the rest. *Exit: a pure-CRDT
  segment forms, converges, routes, and bridges legacy with zero SERVER/SQUIT on CRDT links.*

Reuse the shadow-measurement harness + the mdigest-gated 5-node bed throughout.

---

## 7. Hard problems & open questions (resolve before implementing)

1. **Multi-gateway topology (the loop risk) — CHOSEN MODEL, REFRAMED in §0.** *(The "detect-then-
   elect" framing below is superseded by §0's prevent-by-construction gating: detection-after-the-fact
   is too late — P10 loop damage lands at `server_estab`, ≥30 s before any beacon-based detection. Gate
   legacy-link **establishment** on the deterministic agreement function + a configured `legacy_net_id`;
   election degrades to standby-promotion-on-failure; a P10 SERVER-collision tiebreak is the last-resort
   backstop for the split-brain-both-healthy case. Read §0.)*
   Default is a **single, implicitly designated gateway** per legacy network (the normal topology: exactly one CRDT node links legacy —
   an operational/topology choice, not a runtime protocol). The **safety net**: if an *unintentional*
   loop forms (a second CRDT node also links the same legacy network → legacy sees two paths to the
   mesh → a P10 loop), the mesh **detects** it and **elects** one designated gateway; the other(s)
   stand down (stop routing legacy↔mesh, and SQUIT their legacy link). This keeps the common case
   zero-cost while making the misconfiguration self-correcting rather than catastrophic. Remaining
   mechanism questions (the implementation detail to pin, under adversarial review):
   - **Detection:** how does a gateway learn another gateway fronts the *same* legacy network (vs a
     different one)? Candidates: the doc — each gateway writes "I front legacy net X" into a doc
     collection, and a second writer for the same X is the loop signal; or observing a duplicate
     server/numeric arriving from two mesh directions. (Each gateway only sees legacy via its own P10
     link, so cross-gateway awareness must come through the mesh/doc.)
   - **Election:** convergent designation (lowest numeric? longest-lived link? the doc holds the
     winner), split-brain avoidance, and what happens to in-flight traffic during the election window.
   - **Prevent-vs-detect:** whether detect-after-the-fact is fast enough or the loop does P10 damage
     (duplicate servers / desync / kills) before detection fires — i.e. whether some prevention by
     construction is also needed. **This is the single biggest mechanism question.**
2. **Shared-tree vs flood-shaped vs RPF** for broadcast (§4.1) — decide by measurement; affects
   loop-freedom and cost. Convergence-lag transient loops must be bounded + dedup-covered.
3. **Routing convergence under churn/partition** — when adjacency changes, next-hop must re-converge
   without persistent loops or black-holes. TTL/hop-limit as a hard backstop? Need a bound on
   reconvergence time and a flood-fallback trigger.
4. **Order-sensitive delivery** (§5) — KILL/collision/oper-command races; confirm CRDT-resolved or add
   minimal sequencing (per-source FIFO is free over a single CR link but not across multi-path mesh).
5. **Tree-walking commands** (LINKS/MAP/TRACE/STATS/SQUIT/CONNECT) — reimplement over the mesh-map or
   translate at the gateway; enumerate the full set.
6. **Migration / mixed networks** — a partially-migrated network has CRDT and tree segments; routing
   must work when only *some* peers are mesh-native (this is basically today's "tree kept + CR
   additive" — the retirement is the final per-segment step). Define the per-link capability handshake.
7. **Legacy liveness representation** — gateway-proxied beacons vs the doc `servers` SPLIT flag; the
   `servers` collection already has ACTIVE/SPLIT — likely reuse it.
8. **Security/trust** — CR currently trusts any CRDT-aware peer; mesh routing widens the blast radius
   of a malicious/buggy peer (it can now route, not just gossip state). Consider per-op origin
   validation against the doc (the numeric→server map) — partly there in CR M's doc-sourced identity.

---

## 7a. Additional adversarial-review findings (2026-06-15)

Beyond §0's three corrections (severity in brackets):

- **[High] Shared spanning tree is net-new and loop-free only under identical converged adjacency.**
  Today's `crdt_meshmap_spanning` is per-viewpoint self-rooted, observability-only (every caller passes
  `ournum` as root). A shared deterministic root (lowest reachable numeric) is new code; during the
  ≤90 s convergence lag nodes can build different trees → both duplicate delivery *and* gaps.
  Correctness backstop = msgid-on-every-broadcast + TTL + flood-fallback (§0 prerequisites), not a
  measurement outcome. cmocka-pin the shared-root BFS.
- **[Medium] KILL / trailing-message ordering** over multi-path mesh: a victim's last PRIVMSG can
  arrive *after* its delete-tombstone → dropped or zombie. State merges commutatively; *delivery* order
  does not. MR-1 removes the per-source FIFO a single CR link gives today — needs an explicit ordering
  or accept/drop rule per source.
- **[Medium] Tree-walking oper commands are not cosmetic.** At MR-5 `/SQUIT <crdt-peer>` and `/CONNECT`
  have no tree edge to act on — define their mesh meaning (force-stale a beacon? a CR control op?).
  They are the operator's only incident tools on a misbehaving mesh link.
- **[Medium] Mixed-deployment invariant (make explicit):** mesh-native routing requires the
  **CRDT-aware subgraph to be connected by CR links**. A CRDT pair reachable only *through* a tree-only
  node is invisible to the mesh-map and must fall back to tree for that pair.
- **[Missing] HLC across the legacy boundary:** legacy servers run no HLC, so gateway-minted legacy LWW
  writes need a defined timestamp source or they resolve arbitrarily against post-MR-5 doc-native
  writes.
- **[Missing] Gateway SPOF + write/translate bottleneck:** at MR-4 the gateway is sole P10 face, sole
  legacy proxy-beaconer, and sole CR↔P10 translator for the whole mesh — unscoped scaling / failure
  blast radius.
- **[Missing] Routing shadow-oracle:** the R7a discipline was *measure first*. The routing layer needs
  its own oracle — a "routed-vs-tree-delivered diff" analogous to `crdt_shadow_presence_diff`
  (`crdt_shadow.c:1034`) — plus loop-detected / black-hole / dedup-drop counters and `/CRDT route` +
  `/CRDT gateway` introspection. Only MR-0 gestures at this.

---

## 8. Non-goals / explicitly out of scope

- **Retiring P10 for legacy peers.** Legacy stays pure P10 behind the gateway, forever or until folded
  into the IRCd (`project_x3_nefarious_merge`). Mesh-native routing is **CRDT-peer-to-CRDT-peer only**.
- **A new *socket* layer.** Routing rides the *existing* CR-over-TCP transport. NB (§4.4): this
  **does** promote the existing CRDTMESH overlay from second-class backstop to the **first-class primary
  CRDT↔CRDT link** — transport *promotion*, not a new transport, but real lifecycle work, not free.
- **Changing the CRDT engine / doc model.** State replication is done (Phase 3); this is purely the
  *routing* layer on top.
- **Multi-network / federation** beyond the single Afternet-style network.
- **Implementing any of this now.** This document is the plan-on-hand; MR-0 is the first concrete step
  if/when scheduled.

---

## 9. Pre-implementation decision checklist

Before MR-0 is worth starting, get explicit answers to:

1. Gateway model: **DECIDED** — single implicit designated gateway, with loop-triggered detection +
   election as the safety net (§7.1). Remaining: the detection + election *mechanism* (and whether any
   prevention-by-construction is also needed) — under adversarial review.
2. Broadcast discipline: shared deterministic tree (recommended) vs flood-shaped vs RPF? (§7.2)
3. Is the target ever an **all-CRDT network** (no legacy)? If so, MR-3/MR-4 simplify enormously and
   MR-5 is reachable much sooner — worth a separate "pure-CRDT fast track."
4. Acceptable reconvergence-time bound under churn (drives TTL/fallback design). (§7.3)
5. Does this wait on the X3→nefarious merge (which removes the biggest legacy server) or proceed
   independently? (Roadmap notes services-fold is long-term and CRDT shouldn't gate on it.)

---

## 10. Validation strategy (when implemented)

Same discipline that landed R4–R7a: pure-C routing primitives **cmocka-pinned** up front (the
mesh-map already is); each phase lands **inert → shadow-measure → flag-enable**; validate on the
**5-node hybrid bed** (`nef3–nef7` + legacy `testnet`/`x3.services`) with **mdigest-gated** convergence
and a wire-level check (tcpdump: traffic on CR links, absent SERVER/SQUIT on CRDT links at MR-5, P10
intact on the legacy link). The MR-3 exit criterion is literally the R7b failure case (a no-direct-
link leaf materializing legacy users) now passing — a concrete, already-understood regression test.

---

## 11. One-paragraph summary

Mesh-native routing replaces P10 tree *routing* (not P10 itself) among CRDT-aware servers by promoting
already-shipped fallbacks — the CR-M gossip path, the mesh-map's deterministic spanning tree, doc
anchors, and the §17.7 gateway — to the primary path, and by mirroring **legacy** server/user presence
into the **doc** (so nothing is P10-relayed into the mesh and no prefix can be unknown). The gateway
becomes the single P10 face of the mesh. Once routing + legacy presence are mesh-native (MR-0…MR-4),
SERVER/SQUIT/BURST can finally be retired among CRDT peers (MR-5 = R7b). The single biggest open
question is the multi-gateway model; the rest is incremental, gated, and measurable on the existing
bed.
