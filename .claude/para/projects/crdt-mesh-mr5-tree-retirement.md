# CRDT-Mesh MR-5 — Retire the P10 SERVER/BURST tree among CRDT-aware peers (scope)

> Status: **SCOPED 2026-06-17** (source-grounded, Plan-agent pass against `crdt-mesh` @ `f3c8c71`). Not implemented.
> The keystone phase: the SERVER-intro half of "retire the P10 tree among CRDT peers" (R7a did the SQUIT half).
> **VERDICT: FEASIBLE NOW** — MR-0..MR-4 (esp. MR-3c + Phase-3 user cutover) removed the R7b orphan cause.
> Read first: [[project_crdt_r7a_squit_only]] (the R7b infeasibility this overturns), `crdt-mesh-mr4-gateway-traffic.md` §11.

## 1. Feasibility verdict — the R7b infeasibility is OVERTURNED

R7b (2026-06-14) found SERVER-intro retirement infeasible: P10 is a flat namespace with HIERARCHICAL delivery, so suppressing a CRDT server's SERVER intro orphaned everything sourced through it. Live proof: `:nef3 SERVER DH` (DH=x3, legacy, behind hub2=nef3) reached a leaf with no direct P10 link to nef3 → unknown prefix → dropped (`parse.c:2008-2031`) → DH's users never materialized (split: WITH direct nef3 link = 7/7; WITHOUT = 7/0). The code comment at `crdt_shadow.c:649-652` named the cause: *legacy servers don't beacon, so the anchor fallback can't fire.*

**Two things changed since, both shipped + validated:**
1. **MR-3a: legacy servers now beacon** (`crdt_proxy_beacon_legacy`, `m_crdt.c:418`, single-writer) → `crdt_materialize_one_user` finds a fresh beacon → Case-B `crdt_shadow_make_anchor` fires → legacy users materialize from the doc. **MR-3c (`38afa65`) already validated nef7 (far leaf, no P10 link to nef3) keeps x3 + AuthServ via anchor+doc, 0 mismatch.** The exact R7b break is already fixed for legacy subjects.
2. **Phase-3: CRDT users were never P10-relayed to CRDT peers** (NICK forbids CRDT-aware, `s_user.c:862`; JOIN/PART/MODE/KICK/TOPIC forbid `FLAG_CRDT_AWARE`). A CRDT server's users reach peers via the doc, not via P10 sourced through that server.

**The decisive difference from R7b: a CRDT server beacons ITSELF** (`crdt_gossip_beacon` emits `cli_yxx(&me)`, `m_crdt.c`) → anchorable on any leaf, exactly like a legacy server now is. Every class of entity "sourced through" a suppressed CRDT server now arrives by a non-P10-SERVER path:

| Entity sourced through suppressed CRDT server `S` | Post-MR-5 path |
|---|---|
| `S` itself | `S`'s self-beacon → Case-B anchor on the leaf |
| CRDT users on `S` | doc + materialize onto the anchor (already doc-only) |
| Legacy users fronted via `S` (gateway) | MR-3 proxy-beacon anchor + doc (already live) |
| Sub-tree CRDT servers behind `S` | EACH self-beacons mesh-wide; leaf learns adjacency from the gossiped `peers` sets (`crdt_meshmap_nexthop` BFS), not the SERVER walk |

**Sub-tree safety:** the both-ends gate (`crdt_should_suppress_tree` = `meshmap_on && primary && peer_aware && subject_aware`) is safe for ANY (peer,subject) CRDT-aware pair regardless of relay depth, because the subject self-beacons + its position is gossiped. The R7b case was unsafe ONLY because the orphaned entity (legacy x3) did not beacon — MR-3a fixed that.

**THE ONE PREREQUISITE (mixed-path invariant):** suppression is safe only if the CRDT-aware subgraph is CR-connected (P10-server + CRDTMESH-overlay links = `IsCrdtSyncTarget`). A CRDT pair reachable ONLY through a tree-only (legacy) node is invisible to beacon flooding → suppressing WOULD orphan. The both-ends gate does NOT catch this. **Validation gate (not flag):** the MR-0 `crdt_shadow_route_diff` oracle's `p10Only==0` is the live check — never suppress if the mesh can't reach a server the tree can. Auto-satisfied in an all-CRDT segment.

## 2. Gap matrix — P10 S2S traffic among CRDT peers (the centerpiece)

DONE = already mesh-native; CORE = must close before/with MR-5 (else orphan); OPS = operator-tooling, degrades to anchor dead-sink (no crash).

| Class | Carrier now | Status |
|---|---|---|
| **SERVER intro (J-form)** | P10 tree (`s_serv.c:208,289`, `m_server.c:961`) | **MR-5 TARGET** |
| BURST | CR-F snapshot (`server_finish_burst`, `s_serv.c:356`) | DONE (§3) |
| SQUIT | beacon-stale sweep (R7a) | DONE |
| NICK / QUIT / JOIN / PART / CREATE / MODE / KICK / TOPIC | doc (Phase 3) | DONE |
| PRIVMSG/NOTICE/TAGMSG unicast | CR-M next-hop (MR-1) | DONE |
| channel msg + WALLOPS | CR-M canon tree (MR-2/2b) | DONE |
| GLINE/SHUN/ZLINE/JUPE | doc cutover | DONE |
| **KILL — CRDT victim** | **P10** (`m_kill.c:155`, not CRDT-gated; MR-4c only routes mesh-only victims) | **CORE GAP** — widen MR-4c `'K'` to any CRDT-owned victim, or suppress P10 KILL + rely on doc tombstone |
| **INVITE — CRDT target** | **P10** (`m_invite.c`; MR-4c routes only anchor case) | **CORE-minor GAP** — widen MR-4c `'I'` |
| **METADATA(MD/MDQ) / CHATHISTORY(CH) / read-marker(MR) / bouncer(BS/BX) / SASL-AC / CAP-inval(CI) / redaction** | **pure P10, no CR transport** | **CORE GAP (largest unknown)** — sourced through a CRDT server → could orphan on a far leaf. Explicit decision required (route over CR-M, gateway-translate, or accept-degraded). Shadow-measure which actually cross a CRDT link first |
| SETTIME | P10 priority; scoped OUT | DEFERRED (rides mesh as priority CR tunnel, not doc) |
| STATS/TRACE/LINKS/MAP/CONNECT (remote) | `hunt_server_cmd` P10 next-hop | OPS GAP — anchor `cli_from==&me` dead-sink → reply lost (not crash). `/CRDT route`/`map` already show the mesh |
| `/SQUIT <peer>` command | hunt/exit_client | OPS GAP — define mesh meaning (force-stale beacon / CR control op) |
| numeric replies (server→server) | P10 next-hop | OPS-mostly GAP (same anchor dead-sink) |

**Bottom line:** all structural state + primary delivery is DONE. CORE gaps = KILL/INVITE of CRDT targets (ready machinery — widen MR-4c's `'K'`/`'I'`) + the stateful-subsystem P10 classes (the genuine unknown). Everything else is OPS-tier (tree-walking).

## 3. Initial sync without P10 BURST
CR-F snapshot already replaces BURST content (`s_serv.c:356-362`, gated `crdt_shadow_doc_ready()`); a fresh leaf materializes users/channels/members/modes/topics/bans from the doc — validated Phase-3c + MR-3b (nef7 full bring-up under a real cut). NOT in the doc snapshot but needed: **server topology** — comes from BEACONS (`peers` field → mesh-map), which flood on the ≤30s timer. **Gap = beacon-arrival latency on cold link** (bounded, self-heals next verify tick). Mitigation: an **event-driven beacon-burst at `server_estab`** (tried+reverted in R7b as not-needed-for-R7a; likely needed for MR-5 cold-link — gate on the MR-5-0 shadow log showing a real gap). Excluded modes +L/+U/+A (`CRDT_MODE_MASK`, `crdt_shadow.c:847`) — confirm none are S2S-relevant.

## 3b. The link itself — suppress SERVER on the EXISTING P10 link (not move to overlay)
MR-5 = suppress SERVER/BURST on the existing CRDT↔CRDT P10 link (the symmetric forward of R7a/MR-3c); the link stays up as a CR-carrying `STAT_SERVER`, PING/PONG preserved. The CRDTMESH overlay (`IsCrdtOverlay`, `mr_crdt`, `m_crdt.c:860`) coexists redundantly today (permanent `STAT_HANDSHAKE`, ping-exempt, not in the name hash). **Moving CRDT peers entirely onto the overlay + dropping the P10 link is a SEPARATE larger phase (MR-6 / transport-promotion)** — real overlay lifecycle (proper status, primary-autoconnect, first-class addressing). Out of MR-5's minimal scope.

## 4. Gateway dual-role — no conflict
MR-3c suppresses LEGACY subjects toward CRDT peers (`crdt_should_suppress_intro` = `… && !subject_aware`); MR-5 suppresses CRDT subjects toward CRDT peers (`crdt_should_suppress_tree` = `… && subject_aware`). Mutually exclusive by the `subject_aware` bit, same 3 relay sites. Legacy beacons ride CR H (sourced `&me`), independent of nef3's own SERVER intro. **Critical interaction (must verify):** the gateway must STILL P10-introduce CRDT servers TOWARD legacy so `crdt_gateway_user_intro` (`crdt_shadow.c:2436`, NICK sourced from the user's owning CRDT server) can place CRDT users on legacy — the both-ends gate handles this automatically (toward a legacy peer `peer_aware==false` → no suppression). `crdt_present_stub` (`:728`) is the partitioned-server fallback.

## 5. Hazards / mitigations
- **Numeric collision** (anchor `SetServerYXX` vs a later direct link): no new code — `IsMeshStub` + `FindNServer`-retire + beacon-stale sweep handle it; add a `SetServerYXX`-occupied canary log + verify relink topologies.
- **Partition/reconvergence**: beacon-stale sweep (R7a-proven); GC floor counts only live `IsCrdtSyncTarget` peers → partitioned server drops, GC advances, CR-F catches up on rejoin. MR-5 changes nothing here.
- **NEVER revive the Phase-4a doc `servers` map** (`crdt_shadow_server_add` no-op, proven non-convergent) — presence rides beacons (single-writer, out of digest), as MR-0/MR-3.
- **Flap/oscillation**: 90s `CRDT_BEACON_STALE` + 35s `crdt_shadow_mesh_bcast_stable` damp anchor thrash; validate a flapping-edge.
- **Mixed-path orphan** (§1 invariant): validation gate via `p10Only==0`, not a flag.
- **KILL/INVITE/stateful-subsystem orphan**: close KILL/INVITE (MR-5-1) before flipping; explicit decision for MD/CH/MR/BS-BX/CI (MR-5-5).
- **Rollback**: default-off flag → byte-identical to today (`FLAG_LAST_FLAG` forbid trick); flip back → SERVER intros restore, anchors retire via sweep, real SERVERs re-arrive next link cycle.

## 6. Decomposition (reuse `FEAT_CRDT_MESHMAP_PRESENCE` — the SERVER half of R7a's beacon-trust decision; do NOT add a new flag)
The SERVER-relay sites already call `crdt_intro_presence_suppress` (legacy, MR-3c); MR-5 adds a SECOND check at each: `crdt_tree_presence_suppress(peer, subject, "SERVER")` (the CRDT-both-ends gate, already cmocka-pinned via `crdt_should_suppress_tree`).
- **MR-5-0 (FIRST — shadow oracle, INERT).** SERVER-suppression shadow log at the 3 sites, mirroring R7a's R7-shadow SQUIT line (extend the `crdt_tree_presence_suppress` shadow branch `kind` to "SERVER"): for each would-suppress CRDT subject, log its self-beacon present/age. Exit: zero red flags (every would-suppress subject has a fresh beacon ⇒ anchor will fire). Measure-first, no behavior change.
- **MR-5-1 (close the KILL/INVITE CORE gaps).** Widen MR-4c's `'K'`/`'I'` CR-M route from `crdt_user_is_mesh_only` to any CRDT-aware-owned target. Inert behind the bridge flag until validated.
- **MR-5-2 (suppress SERVER relay — `m_server.c:959`).** The relayed-third-server path (replacement most-proven). Flag-enable. **Exit = the R7b regression oracle (§7).**
- **MR-5-3 (suppress at `server_estab` — `s_serv.c:206,287`).** Cold-link view; pair with the event-driven beacon-burst if MR-5-0 showed a gap.
- **MR-5-4 (BURST retirement).** Already CR-F-replaced + `IsCrdtAware(cptr)`-gated; mostly verification.
- **MR-5-5 (stateful-subsystem decision).** Explicit accept-degraded-or-route for MD/CH/MR/BS-BX/CI (no silent defer). Likely a follow-on, but DECIDE at MR-5.
cmocka: `crdt_should_suppress_tree` truth table (already pinned). Live-only: all estab/ms_server behavior, partition teardown (0 leaks), relink, cold-link timing, KILL/INVITE delivery, wire absence-on-CRDT / presence-on-legacy.

## 7. Validation (5-node hybrid bed; nef3 gw ↔ legacy testnet/x3; nef4-7 CRDT, nef7 far leaf)
1. **R7b regression oracle (THE gate):** flag on → a leaf with no direct P10 link to a suppressed server (nef7) STILL shows **7/7 not 7/0** (legacy via MR-3 anchor + CRDT via doc).
2. Cross-CRDT PM (MR-1) / channel (MR-2) / KILL+INVITE (MR-5-1) deliver exactly-once with SERVER suppressed.
3. Gateway dual-role: tcpdump — SERVER present on the legacy link, absent on CRDT links; CRDT-user NICK still placed on legacy.
4. Partition/heal: cut nef7↔nef5 (overlays intact) → anchors hold + retire via sweep; heal → reconverge, 0 ghost, 0 leaked Client.
5. mdigest single across all 5 throughout (presence is out-of-digest); `p10Only==0`.
6. Cold link: recreate a leaf, measure beacon→materialize latency; decide on the event-driven beacon-burst.
7. 0 crashes / 0 leaks; `SetServerYXX`-occupied canary silent.
Bed gotchas: nftables → `iptables-nft` via netshoot `--cap-add NET_ADMIN`; after recreate, `docker restart nefarious` + oper `/CONNECT testnet.fractalrealities.net 4496`.

## 8. Relationship to the rest of the roadmap
MR-5 unblocks the deferred **MR-4d-3** (multi-gateway establishment gating — needs CRDT servers mesh-only to even have a 2nd gateway) + the **MR-4d multi-gateway double-delivery LIVE test**. The overlay-as-primary transport promotion is a follow-on **MR-6**. The stateful-subsystem CR transport (MR-5-5) is the largest remaining unknown after the SERVER cutover.
