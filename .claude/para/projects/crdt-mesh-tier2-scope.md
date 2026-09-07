# CRDT-Mesh Tier 2 — live-traffic failover over the mesh (SCOPING, 2026-06-10)

First-pass scope for Tier 2. Tier 1 (Phase 4: redundant **state** paths) is complete — the CRDT
*document* stays converged across any single link loss and merges cleanly on relink. Tier 2 is the
declared trajectory: make **live traffic** (PRIVMSG/NOTICE/TAGMSG, and live *presence* —
JOIN/PART/QUIT visibility) survive a tree-edge loss too, so users on a server that is
**tree-partitioned but mesh-reachable** do **not** disappear and remain messageable.

This is a routing-protocol-level change ("effectively retire P10 single-path routing among
CRDT-aware servers"), so it is scoped here but **not** started without an architecture decision.

---

## The headline Tier 2 must deliver

Cut the P10 nef3—nef5 edge while the overlay nef4↔nef5 stays up. Tier 1 today: nef5's users vanish
from nef3/nef4's *live* nets (the §17.3.4 cascade) — only the *doc* stays fresh. **Tier 2: nef5's
users stay visible and reachable** — a PRIVMSG from a nef3 user to a nef5 user is delivered over the
mesh (nef3→nef4→overlay→nef5), and vice-versa. The split is invisible to clients.

---

## Current reality (live-routing map — see commit/agent notes)

- **Single-next-hop tree routing.** `sendcmdto_one()` routes via `to = cli_from(to)` (send.c:1186);
  `cli_from` for a remote user is set ONCE at introduction (`cli_connect=cli_connect(from)`,
  list.c:248) and never re-routed. One link per target.
- **Channel fan-out** walks `chptr->members` and dedups per-message via `sentalong_marker`
  (send.c:2731-2772). No per-channel server list.
- **`exit_downlinks()` (s_misc.c:743-767)** is THE teardown to change: on a dead server link it
  loops the dead server's `client_list` (762-766) and `exit_one_client()`s **every** user behind it.
- **`check_loop_and_lh()` (m_server.c:122-350)** is the spanning-tree enforcer: a redundant link is
  SQUIT'd (timestamp, then name tiebreak). The reason a CRDT overlay had to be CR-only (4b).
- **Routing table** = the tree: `cli_serv(s)->up` / `->down`, `server_list[]` by numeric, FindNServer.

## Tier-1 substrate Tier 2 builds on (already shipped)

- **CRDT gossip fabric**: `CR S` (state vector → delta/snapshot), `CR D/U` (op deltas, chunked b64
  via `s2s_chunk_feed`, CR_CHUNK_LEN=400), `CR F` (snapshot). **Eager multi-hop relay**
  (`crdt_relay_delta`, m_crdt.c:162/221) + **SV dedup** terminate the flood. This is already a
  multi-path, loop-free, partition-tolerant broadcast substrate.
- **The overlay (4b)**: a redundant CR-only edge that survives the spanning tree. Deliberately NOT a
  P10 routing edge.
- **Local reachability (4c)**: `FindNServer`/`IsServer` at the materialize gate already answers "is
  this server reachable via a live transport from here" — the gate Tier 2 keys live-delivery off.
- **HLC-seeded msgid** (`@A<time><msgid>`, project_hlc_msgid_format) + `derive_channel_msgid` — a
  ready dedup/order key for multi-path live delivery.

---

## The core problem (two halves)

1. **Don't tear down mesh-reachable users.** When a tree link dies, suppress `exit_downlinks` for
   users whose owning server is still reachable via a CRDT path; keep them as live Clients, marked
   "delivery route = mesh." Fall back to real teardown only when fully unreachable (the 4c gate).
2. **Deliver live traffic to/from them over the mesh** — a delivery path that isn't the dead tree
   link.

---

## Architecture options (THE decision)

### Option A — overlay becomes a P10 routing edge (failover routing)
Make the overlay carry + route live P10 messages; on tree-link death, recompute next-hops
(`cli_from`) for affected users to traverse the overlay. Closest to P10 semantics.
**Cons:** undoes 4b's "overlay is not a routing edge"; needs loop-free multi-path routing layered
over a graph with cycles (the tree's single-path + sentalong dedup assume no cycles); invasive
routing-layer surgery; `check_loop_and_lh` must stop killing the redundant edge.

### Option B — live traffic rides the CRDT mesh as ephemeral gossip (CRDT-native)
PRIVMSG/NOTICE/TAGMSG → a new **ephemeral** broadcast token (`CR M`) gossiped over ALL CRDT
transports (tree edges + overlays) with the existing eager-relay + **msgid dedup**; each server
delivers to its LOCAL members; the payload is **ephemeral** — never enters the LWW doc/oplog/snapshot.
**Pros:** reuses the entire Tier-1 substrate; multi-path + loop-free + partition-tolerant for free;
this is the "CRDT replaces P10" thesis end-state. **Cons:** introduces an ephemeral message class
(TTL/no-persist, ordering); naïvely floods every message over the mesh (bandwidth) unless paired with
real routing for unicast.

### Option C — hybrid, RECOMMENDED staging (P10 tree steady-state; CR-M failover; converge toward B)
Steady-state live traffic keeps using the efficient P10 tree (unchanged). Only traffic to/from a
**tree-unreachable-but-mesh-reachable** server fails over to `CR M` gossip. Then widen `CR M`'s scope
incrementally until it can fully replace tree routing among CRDT peers (the Option-B end-state).
**Why:** smallest blast radius per step; steady state unaffected (no perf regression); each increment
is independently testable with the partition harness from 4c; naturally lands at B.

---

## Sub-phase decomposition (Option C → B)

- **T2-a — survive the split (presence only).** Suppress `exit_downlinks` for mesh-reachable servers;
  keep their users live + reachable-marked when the tree link dies but a CRDT path exists. Fall back
  to teardown when the 4c reachability gate says fully unreachable. *Visible win on its own (users
  stop vanishing); messages to them still fail until T2-b.* Self-contained, safety-critical.
- **T2-b — outbound failover (deliver TO a mesh-only user).** Unicast to a tree-unreachable user →
  `CR M` gossip instead of the dead `cli_from`. Channel fan-out: members on mesh-only servers get a
  `CR M` broadcast leg.
- **T2-c — inbound + echo (deliver FROM a mesh-only server's users).** The partitioned server's local
  users' messages reach the rest via `CR M`; dedup on receipt; deliver to local members everywhere.
- **T2-d — dup/order/transition hardening.** msgid dedup across tree+mesh (a message may arrive via
  BOTH during failover/heal); HLC ordering; clean steady→failover→heal transitions (no double-deliver,
  no gap). Reuse the 4c partition harness.
- **T2-e — relax `check_loop_and_lh` for CRDT pairs (the B end-state, riskiest, last).** Let redundant
  CRDT links SURVIVE as routing edges so the mesh is a true multi-path fabric (route, don't flood, for
  unicast) rather than a failover. Deepest change (network-wide SQUIT/collision/burst semantics).

---

## Hard problems / risks

1. **Ephemeral-over-CRDT.** Live messages are fire-and-forget — they must NOT enter the LWW
   maps/oplog/snapshot (those are persistent doc state). `CR M` needs its own eager-relay + msgid-LRU
   dedup path, distinct from the op pipeline. (Biggest new design surface.)
2. **Dup/order across paths.** During failover/heal a message can traverse the tree AND the mesh →
   msgid dedup (HLC-seeded msgid exists); channel fan-out must dedup a member reachable both ways.
3. **`exit_downlinks` suppression is safety-critical.** Keeping users alive when their server is
   tree-gone risks ghosts/leaks if the mesh path ALSO dies. The 4c local-reachability gate must
   decide keep-vs-teardown, and a full partition must still tear down cleanly (no leaked Clients —
   recall the hs_client/heap-dangle class of bugs).
4. **`check_loop_and_lh` relaxation (T2-e)** changes spanning-tree invariants network-wide — defer to
   last; gate behind CRDT-aware-both-ends.
5. **Legacy P10 interop.** Non-CRDT peers (the nef1 gateway) keep pure tree semantics; `CR M` failover
   is CRDT-aware-only; the §17.7 gateway boundary still applies. A legacy user behind a split is still
   lost (can't be helped without CRDT on that path).
6. **Performance.** Flooding every PRIVMSG over the mesh (full B) costs bandwidth; Option C avoids
   steady-state cost; full B needs T2-e's routing to avoid flooding unicast.

---

## Decisions
1. **Architecture: C→B — DECIDED 2026-06-10.** P10 tree for steady-state live traffic; ephemeral
   `CR M` gossip failover for tree-unreachable-but-mesh-reachable targets; widen toward the
   CRDT-native end-state (B) incrementally.
2. **First increment: T2-a alone** (recommended) — users survive the split (presence-only), the
   visible self-contained foundation; defer to-/from-delivery to T2-b/c. *Confirm at kickoff.*
3. **Ephemeral model: new `CR M` token** (recommended) — eager-relay + msgid-LRU dedup, distinct from
   the persistent op/LWW pipeline; never enters the doc/oplog/snapshot. *Confirm at kickoff.*

## Not in scope / deferred
- X3-as-peer (proposal Phase 5) — superseded by X3-in-nefarious.
- The 4b overlay-autoconnect-retry bug (workaround: restart nef4) — fix opportunistically; T2 testing
  will exercise the overlay heavily so it'll likely get fixed alongside.
