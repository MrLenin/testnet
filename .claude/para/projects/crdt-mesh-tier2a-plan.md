# CRDT-Mesh T2-a — mesh-survivable presence (implementation plan, 2026-06-10)

## STATUS (2026-06-10): survive + relink SHIPPED & VALIDATED; full-partition teardown DEFERRED
Implemented the in-place mesh-server stub + relink reconciliation. Validated live (clean run):
partial split (cut P10 nef3↔nef5) → survivor **survives** on nef3 as a stub (conversion notice,
nef3 stays 8/8 users vs Tier-1's drop, nef5 a `STAT_MESH_SERVER` stub = "2 servers"); relink →
stub **retired** (notice) before `check_loop_and_lh`, nef5 re-registers (back to "3 servers"), **no
numnick collision, no crash**, and all three **reconverge** (same mdigest) within one verify cycle
(the 4c gc_floor snapshot-fallback carries the re-materialized users to nef4). The 6 files changed:
client.h (STAT_MESH_SERVER/IsMeshStub/SetMeshStub), crdt_shadow.c (conversion in
crdt_shadow_server_squit→int + materialize gate accepts IsMeshStub), crdt_shadow.h, s_misc.c
(exit_client early-return on kept + crdt_shadow_retire_mesh_stub — defined here because
exit_one_client is static), ircd.c (check_pings exempts IsMeshStub), m_server.c (retire stub before
check_loop_and_lh at both mr_server + ms_server). Implementation notes vs the plan below: (a) a NEW
`STAT_MESH_SERVER` status was used, not a FLAG — the bitmask design auto-excludes a new status from
every IsServer/IsClient/IsRegistered mask, which is *lower* audit-risk than a flag-on-reused-status;
(b) the conversion does NOT remove the tree DLink (so retire's exit_one_client remove_dlink doesn't
hit assert(lp!=0); STAT_MESH_SERVER is IsServer-gated out of tree walks anyway); (c) the relink
pre-retire had to move BEFORE check_loop_and_lh (the stub's kept name trips the duplicate-server
check otherwise); (d) the dead-sink works for free — close_connection already left cli_fd==-1 +
FLAG_DEADSOCKET, and remote users share the server's Connection so cli_from(user)==stub auto-routes
to the dead sink.

**DEFERRED — full-partition teardown (needs a mesh-liveness signal).** The keep-vs-teardown gate is
coarse ("any live IsCrdtSyncTarget besides the dying link"); it CANNOT detect a full partition,
because on nef3 the nef4 transport still exists even when nef5 is fully unreachable. A correct
full-partition teardown needs a liveness/staleness primitive (heartbeat or doc-freshness-with-
activity-awareness) — an SV-staleness heuristic would falsely retire an *idle-but-reachable* server
(re-introducing the vanish bug), so it was NOT hacked in. Consequence: on a full or permanent
partition the stub PERSISTS (frozen users, retired cleanly only on relink) — bounded (one stub per
departed server), no crash/leak-growth, fine for the testnet; a permanent departure leaks one stub
until restart. This is the next T2-a-hardening / Tier-2-liveness increment.


First Tier-2 increment. Architecture is decided (Hybrid C→B — see
[crdt-mesh-tier2-scope.md](crdt-mesh-tier2-scope.md)). T2-a is the safety-critical foundation: keep a
tree-departed-but-mesh-reachable server's users **alive and visible** during a partition instead of
the SQUIT cascade removing them. **Presence-only** — messages *to* them are dropped (delivery is
T2-b). Full partition must still tear down cleanly; relink must reconcile without ghosts.

## Scope
**In:** on a CRDT-server SQUIT, if the server is still mesh-reachable, keep its users as live remote
Clients (WHO/NAMES/channel member lists unchanged); drop sends to them; tear down cleanly when the
mesh path also dies; reconcile on relink.
**Out (later phases):** delivering messages to/from stub users (T2-b/c); dup/order hardening (T2-d);
keeping redundant CRDT links as routing edges (T2-e); recursive-downlink keep-alive (v1 is leaf-only).

---

## Recommended mechanism — in-place "mesh-server stub" (option a)

On SQUIT, **convert** the departing server's `Client` into a non-tree stub *before* the cascade runs,
and **skip** it in the cascade. Do NOT destroy+recreate (option b) — that frees and rebuilds dozens of
`Client`/`Membership` structs (channel-membership loss, numnick-reuse races, UserStats double-count,
and a visible QUIT/JOIN flap = exactly the "vanish" T2-a must prevent). The in-place stub keeps every
pointer stable; nothing flaps.

**The stub** (a `Client` that was nef5-the-server):
- `!IsServer` → invisible to every tree/routing/SQUIT walk (`exit_downlinks` recursion s_misc.c:752,
  loop-detect, burst loops).
- keeps `cli_serv` + `client_list[]` + `nn_mask` + its `server_list[]` slot → `findNUser`/`FindNServer`
  still resolve its users.
- tree `DLink` (`cli_serv->updown`) removed from the uplink's `down` list (done in conversion, so the
  cascade doesn't).
- **`cli_fd = -1` (dead sink)** and each stub user's `cli_from = the stub itself`.

**The key insight (closes the UAF + gives the drop for free):** a kept user's `cli_user(u)->server`
*and* `cli_from(u)` both point at the **same valid, never-freed stub Client**. Any
`sendcmdto_one(...,u,...)` → `cli_from(u)=stub` → `can_send(stub)` sees `cli_fd==-1` → **returns 0,
dropped** (send.c:967). No wire traffic, no UAF, unconditional presence-only drop. The doc still flows
over the *real* transports (`crdt_sync_push`/`crdt_relay_delta` iterate `IsCrdtSyncTarget`, which the
dead stub is not — correctly excluded).

**Status representation — DESIGN CHOICE (resolve at kickoff):** the stub must be `!IsServer` while
keeping `cli_serv`. Two ways: (i) a new `STAT_MESH_SERVER` (clean, but per the 4b lesson a new
`cli_status` forces a network-wide audit of every `cli_status`/`IsServer`-adjacent test); (ii) reuse a
non-server status + a `FLAG_MESH_STUB` (mirrors how 4b used `FLAG_CRDT_OVERLAY` on a non-`IsServer`
client rather than a new STAT_, deliberately to avoid that audit). **Lean (ii)** for consistency with
4b; add `IsMeshStub`/`SetMeshStub` macros near `FLAG_CRDT_OVERLAY` (client.h:~208). Either way an
exhaustive `grep -n "cli_user(.*)->server" ircd/*.c` audit for `IsServer(cli_user(u)->server)`
assumptions is mandatory (the hot WHO/WHOIS/NAMES/channel paths only deref fields — `cli_name`,
`FLAG_MAP`, `IsService` — so they're safe; assert-level checks are the risk).

---

## Keep-vs-teardown gate (local signal)

No replicated servers-map (removed in 4c). The local signal that "the departing server is still
mesh-reachable" is **coarse and conservative**:

> at SQUIT time, does there exist ≥1 live `IsCrdtSyncTarget` Client *other than the dying link*?

`IsCrdtSyncTarget(x)` = `MyConnect(x) && IsCrdtAware(x) && (IsServer(x) || IsCrdtOverlay(x))`
(client.h:1184) — exactly the gossip fan-out set. Multi-hop is handled naturally:
- **nef3** (dying link = P10 nef3↔nef5): survivor = nef4's P10 link (CRDT-aware IsServer) → nef5's doc
  keeps arriving via nef4's relay. ✓
- **nef4** (lost its only P10 path to nef5): survivor = the overlay (IsCrdtOverlay, direct). ✓

Coarse = it can over-keep in pathological topologies ("a CRDT peer exists but can't actually reach
nef5"). **Safe**, because the full-partition teardown + the per-tick reconcile are the backstops:
if the doc never refreshes nef5's users, the last-transport-death teardown removes them. Over-keeping
briefly IS the T2-a goal; under-keeping re-introduces the vanish bug. **Ship the coarse gate**; a
precise per-server reachability oracle is a Tier-2-later concern.

Factor the math out as `crdt_mesh_should_keep(int live_transports_excl_dying)` (engine, cmocka-tested);
`crdt_pick_survivor_transport(dying)` does the GlobalClientList scan (Client-bound).

---

## Change points (file:line) — the steps

1. **client.h (~208/1049/1184):** `FLAG_MESH_STUB` + `IsMeshStub`/`SetMeshStub`; status decision above. No behavior change.
2. **crdt_shadow.c materialize gate (~917):** `IsServer(srv)` → `(IsServer(srv) || IsMeshStub(srv))`. Realizes the §4c `crdt_transport_reachable` intent ("reachable via tree OR mesh"). Inert until stubs exist.
3. **Engine predicate** `crdt_mesh_should_keep` (+ cmocka RED→GREEN: 0 → teardown, ≥1 → keep).
4. **`crdt_shadow_server_split_to_stub(srv)`** (new, called from the existing `crdt_shadow_server_squit` hook at s_misc.c:1039 — runs BEFORE `exit_downlinks`, with `cli_serv->up` still valid; that ordering is already deliberate). Does: gate (§2) → if keep: re-point each user `cli_from=srv`; `remove_dlink` the stub's `updown`; clear IsServer + set FLAG_MESH_STUB + `cli_fd=-1` + `FLAG_MAP` (so WHO keeps showing it); KEEP the `server_list[]` slot. **v1 leaf-only:** if `cli_serv(srv)->down != NULL` → return "teardown" (don't keep). Returns keep/teardown.
5. **exit_client cascade gate (s_misc.c:1030-1057):** when split_to_stub returns "kept", skip both `exit_downlinks(victim)` and `exit_one_client(victim)`; emit the netsplit batch only for genuinely-torn-down nodes.
6. **Explicit stub teardown + full-partition trigger:** `crdt_shadow_retire_mesh_stub(srv)` — loop `client_list[]` calling `exit_client` per user (so QUITs reach local users + doc tombstones fire — a stub is `!IsServer` so `exit_downlinks` won't do it), then exit the stub. `crdt_shadow_transport_lost()` sweep (called whenever any `IsCrdtSyncTarget` exits — incl. the overlay's `exit_one_client` STAT_HANDSHAKE path) re-evaluates all stubs: any with no live transport → retire. Verify-timer backstop (crdt_shadow_verify_cb ~1997) catches silent transport death (≤30s).
7. **Relink pre-retire (s_serv.c server_estab ~123, before `SetServerYXX`):** if `server_list[numeric]` is a mesh-stub, `crdt_shadow_retire_mesh_stub` it FIRST (frees stub users), THEN let burst/Tier-1-materialize re-introduce nef5's users onto the fresh `client_list`. Avoids the numnick/server_list collision. v1 accepts a brief relink flap (stub QUIT → re-materialize JOIN); flap-free adopt-in-place is a later refinement.

---

## Safety invariants (cross-checked vs exit_one_client)
- **No UAF:** stub + its `cli_serv`/`client_list` never freed during the split; users keep valid
  `cli_user->server`=stub and `cli_from`=stub; cascade skipped for the kept subtree.
- **No leaked Clients:** stub stays in GlobalClientList + server_list; at teardown (relink/full-part)
  the *normal* exit path frees everything. Zero net leak across split→{relink|full-partition}.
- **IPcheck balance:** stub users are remote (`!MyConnect`) → not IPChecked → no-op. Conversion
  touches nothing.
- **UserStats balance:** conversion does NO UserStats accounting (users stay live). Final teardown
  decrements once via exit_one_client. **Server count (`Count_remoteserverquits`): handle at stub
  retire — restore `SetServer` transiently before `exit_client(stub)` so the tested teardown path
  decrements exactly once** (DECIDED — reuses proven accounting; the alt explicit `--servs` is more
  error-prone).
- **numnick/client_list consistency:** server_list slot + client_list entries unchanged through the
  split; `RemoveYXXClient` only at genuine teardown.
- **Tree integrity:** stub's `updown` removed exactly once (conversion); relink wires a *fresh* server
  after the stub is gone.
- **GC floor:** `crdt_shadow_gc` iterates `IsCrdtSyncTarget` → dead stub excluded, real transports
  included → no premature tombstone GC of nef5's still-needed ops.
- **Run all live tests under `--enable-debug`** (assertions live) — the primary safety gate given the
  hs_client UAF history.

---

## Test strategy
- **cmocka:** only the pure predicate `crdt_mesh_should_keep` is engine-testable (the suite links no
  Client). Be honest: the stub conversion / cli_from re-point / cascade-skip are Client/tree-bound and
  are **live-tested only**.
- **Live partition harness** (reuse this session's throwaway pattern — netns sidecar `ss -K dst <ip>`
  to drop the established socket immediately + `iptables -A ... -j DROP` to hold the partition;
  `CRDT shadow verify` NOTICE digest as oracle). Assertions:
  1. **Survive partial split:** after cutting P10 nef3↔nef5 (overlay up), nef3 & nef4 `WHO`/`NAMES`
     still list nef5's users; verify NOTICE `real == crdt` users (no count divergence), `mdigest`
     matches pre-split. (Tier-1 baseline: `real` drops.)
  2. **Sends drop:** PRIVMSG nef3-user → nef5-stub-user: no delivery, no error, no crash.
  3. **Full partition tears down:** also cut the overlay → within one tick nef5's users gone from
     nef3 & nef4; `/STATS` user+server counts return to baseline (no leak).
  4. **Relink no-dups:** restore the edge → nef5's users appear exactly once (no numnick-collision
     KILL, no count divergence); `mdigest` re-converges; Client count == pre-split baseline.
  5. **No assert-fail / UAF** through the whole sequence under `--enable-debug`.

---

## Open questions for the user (kickoff)
1. **Leaf-only v1** (defer recursive-downlink keep-alive — if the departing server has tree-downlinks,
   full teardown)? *Recommend yes; the test topology (nef5 leaf off nef3) satisfies it.*
2. **Relink: brief flap (tear-down + re-materialize) for v1** vs flap-free adopt-in-place? *Recommend
   flap for v1 (simple, safe); refine later.*
3. **Status: new `STAT_MESH_SERVER` vs `FLAG_MESH_STUB` on a non-server status?** *Recommend the FLAG
   (4b precedent — avoid a network-wide cli_status audit).*
4. Stubs in `/MAP`,`/LINKS`? *Recommend NO (not tree nodes); their USERS show in WHO via FLAG_MAP.*

## Risks (honest)
- **Recursive downlinks** (highest) — mitigated by leaf-only v1.
- **Send-path `IsServer(cli_user(u)->server)` assumptions** — mandatory grep audit; a miss = crash.
- **Server-count accounting at stub retire** — handled via transient `SetServer` (above).
- **Overlay death latency** — DROP'd overlay detected only at ping timeout; verify-timer backstop
  bounds full-partition teardown to ≤30s.
- **Long-partition GC** — GC floor includes live transports (safe), but multi-hour partitions untested.
