# SQUIT-as-SPLIT (§17.3) — read-only scope (2026-06-09)

Verdict up front: **the headline is already delivered, the remaining work is modest (not the
pervasive rewrite it looked like), but its VALUE only materializes in a MESH (Phase 4). Doing it
standalone in the current star is correct-but-no-observable-change. Recommend coupling it with
Phase 4 (as step 1), not doing it in isolation.**

## The §17.3 vision
SQUIT = a single server-level state change (server→SPLIT, ONE LWW write, ZERO user/membership
tombstones) instead of 15,000 individual `crdt_user_remove`/`crdt_orset_remove` ops. Users on a
SPLIT server are hidden at *doc query time* (`crdt_user_visible`), not tombstoned. Relink =
server→ACTIVE (one write), users reappear via delta sync, no re-BURST.

## The decisive clarification — §17.3.4 (why this is MODEST, not pervasive)
"The CRDT state change is invisible to clients. **The local server still: (2) removes
Client/Membership structs from local memory (the P10 exit_downlinks cascade)**; sends QUIT to local
clients; sends SQUIT to P10 peers as normal." So the **live IRCd teardown STAYS** — there is NO new
"hidden-but-live user" concept, NO pervasive WHO/WHOIS/NAMES/routing/nick-space filtering. The
`crdt_user_visible` filtering in §17.3.3 is for the **doc's internal queries only** (materialize /
digest / counts), not the live client-facing path.

## What is ALREADY delivered (verified in 3c + 3m)
- **Zero-tombstone SQUIT — the §17.3 headline — is ALREADY met, incidentally, by the 3a
  single-writer gate.** On a CRDT-peer SQUIT, `exit_downlinks`→`exit_one_client`→
  `crdt_shadow_user_remove` and `remove_user_from_channel`→`crdt_shadow_part` both self-skip
  (`from_crdt_peer(cli_from(user))` is true — the owning server is a CRDT peer), so the doc is NOT
  tombstoned. The split server's users + memberships are RETAINED in the doc. (Confirmed reasoning
  in the 3m commit.)
- **BURST-free relink — ALREADY met by 3c.** On relink, `server_finish_burst` sends a CR F snapshot
  (doc_ready) instead of P10 BURST; materialize re-creates the users. (3c verified: "nef5 rejoining
  established nef3 applied a 3644-byte CR F and materialized 7 users + 3 channels, 0 P10 N tokens.")
- **No split-ghosts — ALREADY met** by the `crdt_materialize_one_user` owning-server-absent guard:
  during a split, `FindNServer(splitsrv)` fails → users are not re-materialized; on relink it
  succeeds → they return. (3m verified: SQUIT cascade torn down cleanly, no assert.)
- **Clean merge on relink — ALREADY met** by Phase 2 sync: stale doc values from before the split
  are overwritten by the home server's higher-HLC writes on re-sync.

So in the **current star topology**, the full netsplit story already works end-to-end and is
zero-tombstone. There is no bug §17.3 fixes here.

## What §17.3 actually ADDS (the modest delta)
1. **Explicit server-SPLIT state in the doc** (the `servers` LWW map — *currently EMPTY*; the entire
   `crdt_server_set/squit/relink` + `crdt_user_visible` machinery exists in the engine but is
   **completely unwired**). This replaces the implicit `FindNServer-absent` heuristic with an
   authoritative, CRDT-propagated state.
2. **`crdt_user_visible` as the materialize/reconcile gate** (server-SPLIT) instead of (or alongside)
   `FindNServer-absent`.
3. A **new producer surface**: the `servers` map must be POPULATED — `crdt_server_set(ACTIVE)` on
   every server introduce (server_estab / SERVER handling) and `crdt_server_squit` on SQUIT of a
   CRDT-aware peer, `crdt_server_relink` on relink. None of this exists today.

## Integration surface (modest, thanks to §17.3.4)
- `crdt_shadow_server_add/squit/relink` hooks (new, small) → call `crdt_server_set/squit/relink` +
  eager push. Wire: server introduce (s_serv.c server_estab / m_server), SQUIT (exit_client's
  `IsServer(victim)` branch, s_misc.c:908), relink (server_estab).
- Replace/augment the `FindNServer`-absent guard in `crdt_materialize_one_user` (and the channel
  create/member reconcilers) with `crdt_user_visible` (server-state-aware).
- Engine `servers` map already wired through init/clear/snapshot/digest/lww_for (it's a first-class
  collection); no engine change expected (possibly a `crdt_server_is_split` accessor for symmetry).
- NO live-path query filtering (the live teardown stays per §17.3.4).

## The catch — VALUE needs a MESH (Phase 4)
Explicit SPLIT-state beats the `FindNServer-absent` heuristic only when a server can be **split from
one peer but reachable via another** — i.e. a partial partition with redundant paths. The current
topology is a **star** (nef1—nef3—nef4,nef5; leaves reach everything only via nef3), so a leaf SQUIT
is *fully* gone and `FindNServer-absent ≡ SPLIT` — explicit state changes nothing observable.
Partition-tolerance / cross-server split consistency / divergent-then-merge — the actual reasons
CRDT beats the P10 tree on splits — are only **exercisable in a mesh**. That's Phase 4.

Edge cases the proposal already specs (§17.3.5): recursive SQUIT (each subtree server its own SPLIT),
quick-reconnect (LWW HLC: ACTIVE write beats in-flight SPLIT), real QUIT during split (the home
server records `crdt_user_remove`, propagates on relink — works with our 3m delete-on-leave).

## Recommendation
- **Do NOT do SQUIT-as-SPLIT standalone now.** In the star it is correct-but-inert (the heuristic
  already delivers the zero-tombstone, BURST-free, ghost-free behavior). The explicit-state rewrite
  would be ~refactor-for-future with no observable payoff and a new producer surface (servers map) to
  maintain.
- **Couple it with Phase 4 as step 1.** Build the mesh topology (redundant leaf↔leaf links / a second
  hub), where SPLIT-state is actually meaningful, and wire `crdt_server_squit/relink` + the
  `crdt_user_visible` gate there — then the partition-tolerance value is demonstrable.
- **If you want a standalone correctness win NOW (star-independent): host-rep parity** (the 3o/3l
  deferral — carry realhost+cloak in CrdtUserRecord + a host reconcile; unblocks +x/sethost cutover
  + fixes the legacy re-cloak display). Better ROI than an inert SQUIT-as-SPLIT.

## If you still want to do the light version now
Scope = the modest integration above (server map producer hooks + `crdt_user_visible` materialize
gate), explicitly NO live filtering. ~1 build. Low risk. Payoff = the model is explicit + Phase-4-
ready, but zero observable change in the star. Reasonable as "pay the Phase 4 prerequisite early."
