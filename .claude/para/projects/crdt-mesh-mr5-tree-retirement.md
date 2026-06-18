# CRDT-Mesh MR-5 — Retire the P10 SERVER/BURST tree among CRDT-aware peers (scope)

> Status: **THE KEYSTONE IS DONE + LIVE-VALIDATED (R7b OVERTURNED). MR-5-0 (`45540d1`) + MR-5-1 (`e48083c`) + MR-5-2/5-3 SERVER suppression (`d1fe32a`) + event-driven beacon-burst (`aaaf8b4`) all landed.** Flag SEPARATE `FEAT_CRDT_TREE_RETIRE` (§6). Only remaining MR-5 refinement = MR-5-5 (stateful-subsystem decision MD/CH/MR/BS-BX/CI).
> RESULT: with the flag on, a far CRDT leaf's P10 LINKS shows ONLY itself + its one direct neighbor; all other CRDT + legacy servers are mesh anchors, users materialize via the doc, KILL/INVITE/PM route over the mesh. The P10 spanning tree among CRDT peers is retired.
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

## 6. Decomposition — flag decision REVISED at impl: SEPARATE `FEAT_CRDT_TREE_RETIRE`, not the shared flag
**The agent recommended reusing `FEAT_CRDT_MESHMAP_PRESENCE` (one semantic cutover). At MR-5-0 I diverged: a SEPARATE flag `FEAT_CRDT_TREE_RETIRE` (default off).** Why: that shared flag is ALREADY ON in the bed (R7a SQUIT suppression is live) — so reusing it would make the SERVER cutover go live the instant MR-5-2 wires the gate (the flag's already on), skipping the controlled per-step validation flip the riskiest phase demands. A separate flag keeps the SERVER cutover independently gated from the live SQUIT suppression. The SERVER-relay sites already call `crdt_intro_presence_suppress` (legacy, MR-3c); MR-5 adds a SECOND check at each via a dedicated `crdt_server_intro_suppress(peer, subject)` (same both-ends `crdt_should_suppress_tree` gate, but on `FEAT_CRDT_TREE_RETIRE`).
- **MR-5-0 — DONE + VALIDATED 2026-06-17 (submodule `45540d1`).** `crdt_server_intro_suppress` (crdt_shadow.c) wired INERT (return DISCARDED) at the 3 sites (s_serv.c ×2, m_server.c); while `FEAT_CRDT_TREE_RETIRE` is off it shadow-logs "MR-5-shadow SERVER subject=… → peer=… would-suppress; beacon present/age". **GREEN BOARD confirmed (steady state):** after a leaf relinked post-convergence, its uplink logged every CRDT subject toward it `present=1` with fresh beacons (ages 11-55s, stale_in 35-79s) ⇒ each anchorable ⇒ R7b overturned LIVE. **COLD-LINK GAP characterized:** at `server_estab` during bringup the beacon hasn't arrived (`present=0`, nef3/4/5 hubs ×4 each) ⇒ MR-5-3 should pair with the event-driven beacon-burst. Inert verified (all 5 CRDT servers still in a far leaf's LINKS, nothing suppressed; 0 crash/mismatch). cmocka `crdt_should_suppress_tree` already pins the decision.
- **MR-5-1 — DONE + LEGACY-no-regression-validated 2026-06-17 (submodule `e48083c`).** Not a "widen the predicate" — `crdt_user_is_mesh_only(target)` ALREADY flips true for a CRDT user once MR-5 anchors its server; the real gap was the HOME-side delivery (the `'K'`/`'I'` CR-M arrives at a MyConnect CRDT user, which MR-4c excluded). Added: `m_crdt.c` 'M' handler MyConnect branches for `'K'` (`exit_client_msg` the local victim + kill notice, mirroring do_kill ⇒ the exit writes the doc tombstone = the teardown propagation) and `'I'` (`add_invite` + notify, mirroring m_invite); +s_misc.h. Decoupled the m_kill/m_invite route hooks from `FEAT_CRDT_GATEWAY_BRIDGE` (routing to a mesh-only target is always required; bridge flag only gates the legacy re-emit). Inert until MR-5-2 (pre-MR-5 a CRDT user's server is P10-introduced ⇒ not mesh-only ⇒ KILL/INVITE stay on P10). Validated LEGACY no-regression (nef7 KILLs/INVITEs legacyguy → gateway re-emit still fires, 0 crash, 8/8); the CRDT home-delivery is exercised at MR-5-2.
- **MR-5-2 + MR-5-3 (suppress the SERVER intro) — DONE + LIVE-VALIDATED 2026-06-17 (submodule `d1fe32a`). R7b OVERTURNED.** All 3 sites gated (the 5-2/5-3 split collapsed — impl trace: `s_serv.c:287` introduce-existing delivers servers to a leaf at ITS OWN link time, so gating only the relay leaves that burst flowing): `m_server.c:959` (relay) + `s_serv.c:206` (broadcast-new) + `s_serv.c:287` (introduce-existing), each `if (crdt_server_intro_suppress(...)) continue;`, flag `FEAT_CRDT_TREE_RETIRE` (off ⇒ inert). NB: the direct two-endpoint handshake is NEVER suppressed (only 3rd-party propagation) so the P10 link still forms — CR tokens/beacons flow over it; only the SERVER tree is retired. **Validated:** far leaf nef7 P10 LINKS = ONLY itself + its 1 direct neighbor; CRDT verify 6/6 users materialized, 8 servers (5 CRDT + 3 legacy anchors), 0 mismatch (the R7b 7/0 is now 6/6); cross-CRDT KILL (nef7→nef3 user, home-delivery + tombstone → gone everywhere) + cross-CRDT INVITE (target got `:invsrc INVITE … #meshinv`); single doc digest + mdigest across all 5, oplog=0, 0 crashes. **Cold-link gap (MR-5-0's `present=0`) manifested as a transient 6/0 at bringup, self-healed to 6/6 once beacons flooded (~30-60s).**

- **Event-driven beacon-burst — DONE + LIVE-VALIDATED 2026-06-17 (submodule `aaaf8b4`).** `crdt_shadow_beacon_burst(peer)` (crdt_shadow.c), called from `server_finish_burst` for any CRDT-aware peer (covers BOTH the CR F snapshot path and the cold-boot BURST fallback), hands the new peer the full current beacon set at link time: (a) our self-beacon + (b) our proxy-legacy beacons via the new single-target `crdt_gossip_beacon_to(only)` (refactor of `crdt_gossip_beacon`/`crdt_proxy_beacon_legacy`), plus (c) a replay of every FRESH far-server beacon we hold. Replayed (c) beacons carry peers="*" + omit fronted_by (mesh-map + MR-4d election are observability-only, self-correct next tick); gated fresh (no resurrection); loop-safe via emit_ts dedup. **KEY: this is load-bearing, not just latency** — `crdt_materialize_one_user` (crdt_shadow.c:2306) REQUIRES a fresh beacon to Case-B-anchor a no-P10-link server, so without the burst a leaf's snapshot lands but materializes 0 far-server users until the next 30s flood. **Validated:** restart a leaf into the converged 5-node mesh → its uplink logs `MR-5 beacon-burst: handed <leaf> our liveness set + 7 replayed far-server beacon(s) at link time`, and in the SAME second the leaf applies the CR F snapshot + materializes all 6 users + 3 channels (the residual boot→link delay is P10 autoconnect, NOT a beacon gap). All 5 reconverge to one digest+mdigest, oplog=0, 0 crashes. The burst count scales with mesh knowledge during convergence (0→2→4→6→7 replayed). Log at L_INFO.
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

---

## 9. MR-5-5 — stateful-subsystem decision (SCOPED 2026-06-17, source-grounded @ `aaaf8b4`)

> **SUPERSEDED/EXPANDED by the comprehensive S2S audit → `crdt-mesh-s2s-gap-audit.md` (2026-06-17).** The
> 7-subsystem view below is correct but INCOMPLETE — the full `sendcmdto_*` sweep found more: holes in
> already-"DONE" work (directed `/msg nick@server` never got the MR-1 guard `ircd_relay.c:1135/1248`; INVITE
> guarded at only 1 of 4 sites `m_invite.c:341/367/369`) + a services-reachability class FAR broader than the
> scoped SASL relay (LOC/REGISTER/VERIFY/rename/XQUERY all dead-sink to the x3 anchor). Use the audit doc's
> tiered list (A=DONE-holes, B=services class, C=other correctness, D=converges-but-scoped-leg, E=ops) as the
> go-live checklist; the sub-step order below is revised in the audit's "Sequencing suggestion".

**The one mechanism that governs everything (verified):** an anchor is `make_client(NULL, STAT_MESH_SERVER)` (`crdt_shadow.c:870`) with `fd=-1`, `cli_serv->updown=NULL`, and **NO `add_dlink`** — so it is NOT in `cli_serv(&me)->down`. Therefore:
- **Broadcast** (`sendcmdto_serv_butone[/_v3]`) iterates `cli_serv(&me)->down` (`send.c:1884,2020`) = direct physical CRDT↔CRDT P10 links only → **never touches an anchor**, propagates hop-by-hop over the still-alive direct links → **WORKS** (given the keystone's mixed-path `p10Only==0` invariant).
- **Targeted** `sendcmdto_one(..., <server-or-user-resolved-through-an-anchor>, ...)` → `cli_from()` is the dead-sink fd=-1 → **silently dropped** → BREAKS.

**So the single discriminator per subsystem = does its S2S flow do a targeted send to an anchor-resolved server, or is it a pure broadcast?** There are **zero `hunt_server` uses** in any of the 7 subsystems.

### Gap matrix (one row per subsystem)

| # | Subsystem | Wire / files | Routing | Verdict | DECISION |
|---|---|---|---|---|---|
| 1 | Metadata MD/MDQ | `m_metadata.c`,`metadata.c` | MD sync = `serv_butone_v3` broadcast (`:799,1516`); GET local-only (MDQ vestigial, replies to `cptr`) | **WORKS-AS-IS** | accept-as-is |
| 2 | Read-marker MR | `m_markread.c` | broadcast only (`:368,447`); session markers local | **WORKS-AS-IS** | accept-as-is |
| 3 | Cache-inval CI | `sasl_webhook.c` | flood-fill broadcast (`:137-187`,`ms_cacheinval:328`) | **WORKS-AS-IS** | accept-as-is |
| 4 | Redaction RD | `m_redact.c` | live redact = broadcast (`:323,431`); fed msgid-lookup shares CH | **WORKS** (fed sub-path degrades w/ CH) | accept-as-is; fed folds into CH |
| 5 | SASL relay / AC | `m_sasl.c`,`m_authenticate.c`,`m_account.c` | AC = broadcast (`sasl_auth.c:622`) + doc-carried (WORKS). **Path-3 relay** `sendcmdto_one(&me,CMD_SASL,acptr,…)` to x3 (`m_authenticate.c:283-294`) + `ms_sasl` reply leg (`m_sasl.c:148-155`) + LOC (`m_account.c:310-364`) → **x3/origin is an ANCHOR on a far leaf**. Bed: ALL nodes `SASL_SERVER="x3.services"` + `SASL_LOCAL=TRUE` (verified) → local-Keycloak tried first, X3 relay is the configured fallback + the prod path | **AC WORKS; relay BREAKS** (mechs that fall through to Path-3) | **gateway-translate REQUIRED — X3-based SASL is NON-NEGOTIABLE for prod-test (user 2026-06-17). Accept-degraded is a TEMPORARY bed waypoint only** (local-Keycloak masks the break for PLAIN/OAUTHBEARER); MR-5-5b must land before CRDT carries prod SASL |
| 6 | Chathistory CH | `m_chathistory.c`,`history.c`,`ircd_relay.c` | a STORE node stores a channel msg ONLY if it has a LOCAL member/alias present (`has_local_interest` gate, `ircd_relay.c:180-194` — "STORE servers without users in a channel don't receive the msg via P10 anyway; they rely on CH W forwarding"). So each node's store = only what its own members witnessed; **federation (`CH Q`) is how a node fills gaps for msgs it did NOT locally witness.** Federated Q/W = `sendcmdto_one(&me,CMD_CHATHISTORY,server,…)`, `server=FindNServer()`→anchor (`:1982,2509,3807`) | **DEGRADES — a CORRECTNESS gap, not redundancy (user 2026-06-17):** local-witnessed history works, but cross-node gap-fill dead-sinks → permanent history holes. **Tree-retirement ACTIVELY introduces this** (federation worked over the P10 tree pre-MR-5) — a regression for CH | **accept-degraded for now (user's call) BUT correctness-relevant, not "redundancy".** Proper fix = **CR-M route for CH Q/W** (next-hop toward the storage owner; req/reply correlation + WB chunk reassembly) — prod-relevant, tracked. 5-5c timeout-harden is a BAND-AID (stops the wedge, does NOT fill the gap) |
| 7 | Bouncer BS/BX | `bouncer_session.c`,`m_bouncer.c` | BS convergence = broadcast (WORKS). **BX E/M** `sendcmdto_one(sptr,CMD_BOUNCER_TRANSFER,target,…)` to a remote alias (`:8235,8820`); aliases are deliberately EXCLUDED from the doc (`IsBouncerAlias` skipped `crdt_shadow.c:558,583,1729,2587,2712,3308`) + resolved by numeric (`findNUser`) → on a far leaf an alias on an anchored CRDT server is UNADDRESSABLE (no doc entry + anchor dead-sink) | **BS WORKS / BX cross-mesh BREAKS** — and **`BOUNCER_ENABLE=TRUE` on ALL CRDT servers ircd3-7 (verified 2026-06-17; the bed runs bouncer mesh-wide, NOT off)** so the break is LIVE | **accept-degraded for now (user 2026-06-17) but a PROD-BLOCKER, not dormant.** Fix = CR-M route for BX E/M + a decision on alias presence over the mesh (doc-exclusion is deliberate per the alias invariants → likely CR-M, not doc); REQUIRES bouncer-analyst review |

### Prod-forward framing (user 2026-06-17)
**This is not a throwaway PoC — if results stay favourable, CRDT is the way forward.** So the "accept-degraded" rows are TEMPORARY waypoints, not destinations. Three of them are **correctness** issues that MUST be addressed before CRDT carries production traffic, NOT follow-ons: **(i) SASL X3 relay** — hard prod-blocker (X3-based SASL is non-negotiable); **(ii) bouncer over the mesh** — enabled mesh-wide today, BX cross-mesh is a live correctness break; **(iii) CH federation** — store is local-witness-gated, so cross-node gap-fill is correctness (history completeness), and tree-retirement turns previously-fillable gaps into permanent holes (an MR-5-introduced regression). Degradation is acceptable *for now* only because the bed masks/tolerates them (local-Keycloak for SASL; no cross-mesh alias traffic exercised yet; users mostly read their own node's witnessed history). The ONLY genuine "redundancy, harmless" rows are MD/MR/CI/RD (all broadcast). Track (i)–(iii) as blockers.

### Sub-step order
- **MR-5-5a — SASL shadow-measure / characterize (FIRST).** Read-only dead-sink probe (mirror MR-5-0 / `crdt_dead_sink_dropped`): log every targeted `sendcmdto_one` in m_sasl/m_authenticate/m_account(LOC) whose resolved target `IsMeshStub`/dead-sink, on nef7. Purpose is NOT build-vs-accept (the build is decided — X3 SASL is required) but to CHARACTERIZE the flow: which frames/legs cross a dead-sink, the cookie/agent state to carry, and to exercise Path-3 the bed must drive a mechanism that falls through local-Keycloak (e.g. an X3-only/legacy-account auth, or temporarily `SASL_LOCAL=FALSE` on nef7).
- **MR-5-5b — SASL gateway-translate (REQUIRED; the headline prod-blocker fix).** New CR-M cmd code `'S'` for the leaf↔gateway SASL hop + gateway CR→P10 re-emit toward x3 + reverse for the reply, keyed on the `<yxx>!fd.cookie` token; mirrors the MR-4b/4c bridge (`m_crdt.c:713-784`). Gate the re-emit on the EXISTING `FEAT_CRDT_GATEWAY_BRIDGE`. Auth-critical + timeout-sensitive → isolate. cmocka: the token split + relay-vs-broadcast decision.
- **MR-5-5c — CH timeout band-aid (NOT the fix).** Skip anchored `server_ads[]` entries so a federated `CH Q` doesn't wedge a `FedRequest` on an impossible reply (clean timeout). This stops the wedge but does NOT fill the gap — CH gap-fill is a correctness concern (store is local-witness-gated, `ircd_relay.c:180`), so the REAL fix is the CR-M route below.
- **MR-5-5f (PROD-RELEVANT) — CH federation over CR-M.** Route `CH Q`/`CH W` next-hop toward the storage owner over the CR-M carrier (req/reply correlation via the `FedRequest`/`fed_requests[]` machinery; WB chunk reassembly over the mesh). Closes the history-gap regression tree-retirement introduces. Scope after the auth/bouncer blockers; higher build cost than SASL.
- **MR-5-5d — doc-only decisions** for MD/MR/CI/RD (accept-as-is) + record the bouncer break (accept-degraded for now, PROD-BLOCKER tracked). One commit recording rationale + the dead-sink counter logs.
- **MR-5-5e (PROD-BLOCKER, separate track) — bouncer over the mesh.** BX E/M cross-mesh route + alias-presence decision (CR-M, not doc — doc-exclusion of aliases is a deliberate invariant). REQUIRES a bouncer-analyst pass against the alias hard-invariants before any code. Scope it after 5-5b; do not fold into the MD/MR doc commit.

### Flag strategy
Reuse **`FEAT_CRDT_TREE_RETIRE`** for accept-degraded guards + shadow logging (inseparable from the retirement they react to). If 5-5b is built, gate its re-emit on the existing **`FEAT_CRDT_GATEWAY_BRIDGE`** (same class as MR-4b/4c). No new per-subsystem flags.

### Shadow-measurement plan (run on the live bed BEFORE building)
Principle: do not over-build CR transport for a flow that never crosses a dead-sink. Add the read-only probe (§MR-5-5a), exercise each subsystem from nef7 (SASL login; a federated CHATHISTORY query for a far-only-archived channel; set metadata / mark-read / Keycloak account change / redact — confirm broadcasts reach all 5 + target no anchor; bouncer skipped, off), and gate build-vs-accept on the per-subsystem anchor-target count. **SASL is the single decisive measurement.**
