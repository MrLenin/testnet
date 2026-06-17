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

1. ~~**#4 — mesh-only nick/umode-change legacy gate**~~ **DONE 2026-06-12 (submodule `a59b21d`,
   testnet `b08b516`).** Exported `crdt_user_is_mesh_only` (was static) and gated both legacy relays
   on `!crdt_user_is_mesh_only(sptr)`: the `set_nick_name` FEAT_CRDT_PRIMARY NICK relay (s_user.c) +
   `send_umode_out` (fold the mesh-only subject into the per-server skip → ALL legacy peers skipped
   for a mesh-only subject). Mirrors the proven channel JOIN gateway gate (crdt_shadow.c:1893) +
   `crdt_gateway_user_intro`'s IsMeshStub skip. Wire-verified non-vacuous on the 5-node bed
   (tcpdump nef3↔legacy S2S): after a nef3↔nef4 cut, a mesh-only user's rename DEMONSTRABLY APPLIED
   on nef3 (set_nick_name ran) yet 0 legacy crossings, while a normal CRDT rename still crossed
   (gateway intact). cmocka green, 0 crashes. **QUIT follow-up also DONE 2026-06-12 (submodule `9d3054a`, testnet
   `460b0db`): the actual QUIT leak is exit_client's §17.7 QUIT gateway loop (s_misc.c:1049, NOT the
   local-only `sendcmdto_common_channels_butone` at :505) — gated by folding `crdt_user_is_mesh_only(
   victim)` into the FEAT_CRDT_PRIMARY skip, same one-liner pattern. Wire-verified non-vacuous (numeric
   AEAAA re-materialized + reconcile-exited on nef3, 0 QUIT for it on the legacy link; the only Q's seen
   were unrelated background AD* "EOF from client"). With this, the FULL mesh-only user lifecycle no
   longer leaks to legacy: intro / JOIN-PART-KICK / nick-umode / QUIT.**
2. ~~**#3 — CR H beacon carries the server NAME + right-size the anchor mask**~~ **DONE 2026-06-12
   (submodule `1f14ece`, testnet `9d1a483`).** Beacon extended append-only to `H <yxx> <ts>
   <nn_capacity> :<name>`; `crdt_beacon[]` gained name + base64 capacity; `crdt_shadow_make_anchor`
   uses the real name (was `mesh-<num>.crdt`) and right-sizes `client_list` to the owning server's real
   capacity (the server assigns client numerics within its own nn_mask, so a matching anchor mask fits
   every user, no collision) — ~32KB vs ~2MB/anchor (64×). Mixed-version safe (old-form parc==4 →
   placeholder name + MAX mask). Wire-verified on the 5-node bed (26 named beacons e.g. `H AI <ts> A]]
   :leaf5.fractalrealities.net`, cap A]]=4095, 0 old-form), cmocka green, 0 crashes.
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
proves intolerable.

**RATIONALE CORRECTED (2026-06-13 — the mesh-map work refutes the old "impossible" framing).** The
original argument here was: path-vector needs a convergent replicated TOPOLOGY table = exactly the
per-viewpoint reachability state the fork ABANDONED (the Phase-4a `servers`-map; crdt_shadow.c "no
amount of patching makes a per-viewpoint value robust as shared state") → building it = re-litigating
that failure. **That conflated TOPOLOGY with REACHABILITY.** Reachability ("can I reach X") is
per-viewpoint and genuinely un-shareable — still true, never replicate it. But TOPOLOGY ("X's own
direct links") is per-OWNER, single-writer per key — and the [observability mesh-map](#observability--mesh-map--crdt-command-2026-06-13-done)
just proved it converges live (out of the digest, digest stable across a partition). That is the
link-state model: flood per-owner adjacency, derive reachability LOCALLY. So the convergent topology
table the rationale said couldn't exist DOES — the "impossible" blocker is gone. What remains for
routing-grade use is ordinary routing discipline ON TOP of it (tighter liveness than the 90s
beacon-stale for forwarding, loop-freedom DURING convergence via seq-numbers/hold-downs/the
path-vector path, next-hop computation) — standard problems (OSPF/BGP), NOT a convergence
impossibility. **Tier-2 risk downgrades: "re-litigate an un-convergeable failure" → "apply known
routing discipline on a proven convergent topology substrate."** Flood-first still stands as the
cheaper R4 delivery path (it sidesteps routing entirely); path-vector is now an option-not-a-wall if
unicast efficiency later demands it.
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
- **R2 — recursive-subtree keep-alive** · M · prerequisite · **VERIFIED 2026-06-12 (already
  implemented; confirmed working — no code change).** Test (`/tmp/crdt4c/r2test.sh`, throwaway): P10
  tree nef3(hub2)→nef4(leaf2)→nef6(leaf4, **depth-2**) + a CR overlay nef6↔nef3; a user `r2deep` on
  nef6. Cut nef3↔nef4 (severs nef6 from the P10 tree; its overlay to nef3 survives). Result: nef4 →
  Case-A stub (`leaf2 tree-split but mesh-reachable`); **nef6 (depth-2, RELAYED via nef4) →
  Case-B synthetic anchor** (`synthetic anchor for server AH = leaf4.fractalrealities.net` — the R2
  recursive re-materialize, AND #3's real-name path confirmed LIVE, which the dense-mesh #3 test
  couldn't trigger). `r2deep` survived continuously on nef3 (WHOIS 311 throughout, 8/8 users,
  0 mismatch — no flicker-out), **0 crashes** (recursive-teardown UAF risk clean), no ghost dupe
  cut→heal. Caveats (both known testbed-infra, not R2): WHOIS 312 is HIS-masked (`*.network`) so the
  real anchor name was confirmed via nef3's log; and the P10 relink didn't re-form in 112s post-heal
  (recurring autoconnect-wedge after iptables cut) — but the doc held 0 mismatch with no dupe the
  whole time, and a clean recreate-5 reconverges. **R2 done.**
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
  **R4a DONE for PRIVMSG 2026-06-11 (submodule 88eb8aa, testnet aa9878d) — THE PRIZE ACHIEVED: live channel PRIVMSG
  rides the CR-M mesh + survives a tree-edge cut with ZERO interruption, exactly-once (validated r4achan steady 40/40 +
  cut 40/40, 0 dup, 0 crash). New per-server per-msgid local-delivery dedup (crdt_shadow_chan_local_check_add) separate
  from the flood dedup; widened trigger to all-CRDT-peer members; server-relay floods only at the CRDT entry point. See
  `crdt-mesh-r4a-channel-flood.md` + memory. FOLLOW-UP: NOTICE + TAGMSG parity (same pattern, separate fns), then R4b
  (unicast hybrid: tree-primary + targeted failover, NOT full flood).**
  **R4b RESOLVED 2026-06-11 (decision, no code): ACCEPT THE R3 HYBRID as the unicast answer — tree-primary + mesh-only
  CR-M failover (already shipped in R3, validated 60/60 0-dup). The only loss across a cut is the single
  in-flight-at-cut-instant PM (irreducible IRC netsplit semantics). Pure-flooding unicast was rejected (the spike measured
  it pays broadcast-cost for a 1-recipient message, ~2·E); the overlay-only pre-emptive-copy optimization is noted as a
  future option if a use case ever needs zero-interruption unicast, but it isn't worth the complexity now. **R4 COMPLETE
  (R4a channel flood + R4b unicast hybrid).** Next: R5.**
- **R5 — gateway becomes the live-traffic legacy bridge** · L. Make §17.7 bridge live CR M ↔ legacy
  P10 PRIVMSG/NOTICE/TAGMSG + removals/QUIT/KICK/SQUIT (close crdt_shadow.c:1267/1456 "stays on P10"
  gaps), so legacy interop no longer needs the tree as primary. Demo: legacy nef1 + CRDT peers, a
  legacy user messages a CRDT user across a partition, bridged.
- **R6 — demote the P10 tree to legacy-only** · **CORE DONE 2026-06-12 (R6a+R6b, PRIVMSG+NOTICE;
  submodule `a99bffb`, testnet `2555385`).** Among CRDT-aware peers, channel PRIVMSG/NOTICE now rides
  CR-M as authoritative; the tree carries it only to legacy via the gateway bridge. NO check_loop_and_lh
  change (that's R7). **The roadmap's "network-wide all-CRDT gate" was SUPERSEDED** by a per-direction
  `IsCrdtAware(cli_from(member))` gate (incrementally deployable; no split-belief issue). Two coupled
  parts: **R6a** (one-shot `skip_crdt_servers_once`, mirror of R4a's skip_local; the 4 channel relay
  fns set it before the relay when the CR-M flood covers a directly-connected CRDT-aware peer;
  sendcmdto_channel_butone[_with_client_tags] skip those server directions) + **R6b** (gateway CR-M→
  legacy bridge in ms_crdt 'M', inside the dup-local block, skip mesh-only sources). **KEY EMPIRICAL
  FINDING: R6a ALONE STARVES LEGACY** (legacy GOT 0/12, CRDT 12/12) — the plan's + design-review's
  "tree still reaches legacy" assumption is FALSE when legacy sits behind CRDT hops (the tree is
  suppressed at every CRDT hop, so a CRDT-origin msg reaches the gateway only via CR-M → must be
  bridged). R6b is REQUIRED, and double-free (R6a ensures the tree never carries CRDT-origin to the
  gateway → bridge is the sole legacy path; legacy-origin arrives via tree, dedup-marked, skips the
  bridge). Verified 5-node + legacy: CRDT 12/12 (CR-M) + legacy 12/12 (bridge), tree demoted (0 tree
  copies on the CRDT S2S link), exactly-once, tree-cut failover 10/10, 0 crashes. No cmocka
  (integration-layer routing; wire/delivery-verified). **TAGMSG also DONE 2026-06-12 (submodule `cdfd449`, testnet `34f300b`):** demoted its
  tree leg (`sendcmdto_serv_butone_v3` consumes the same one-shot skip_crdt flag, skips CRDT-aware
  downlinks; BATCH callers unaffected) + the gateway bridges CR-M TAGMSG to legacy IRCv3 peers via the
  v3 `@tags` form (skip mesh-only). Both-or-neither (demote alone would starve legacy). Verified
  5-node + legacy (message-tags clients): CRDT 8/8 via CR-M + legacy 8/8 via bridge, tree `TM`=0 on the
  CRDT link, exactly-once, 0 crashes. **R6 CHANNEL COVERAGE COMPLETE (PRIVMSG/NOTICE/TAGMSG).**
  Remaining: **unicast** stays tree-primary + mesh failover (R4b, deliberately not in R6).
- **R6c — partition faithful legacy bridge** · **DONE 2026-06-12 (submodule `aa8dc98`, testnet
  `80bf15a`).** Unblocks the R5 wall: a gateway PRESENTS a partitioned-but-mesh-reachable stub to
  legacy as a P10 subtree (new FLAG_CRDT_PRESENTED flips `crdt_user_is_mesh_only` → all §17.7 gates
  emit for its users, zero call-site edits), retire-SQUITs cleanly on relink (before the real SERVER →
  no duplicate-server collision). Verified 5-node + legacy: legacy WHOIS sees partition-side `alice`
  post-cut (R5 wall gave nothing) + bob (legacy) receives alice's channel PRIVMSGs FAITHFULLY (8/8,
  `:alice … PRIVMSG`), no nick-collision, exactly-once; forced relink → clean handoff (0 ghost, 0
  duplicate-server, 0 collision); 0 crashes. **KEY FIX during impl: present() must NOT run the reconcile
  suite (it is called from inside a reconcile via make_anchor → nested reconcile double-introduced users
  → numeric-collision ghost-kill); the ambient reconcile emits them once now that the stub is PRESENTED.**
  **All-legacy-channel edge — FIXED 2026-06-12 (flood-on-partition, submodule `ebf375e`, testnet
  `2892522`):** a partition-aware node (holds ≥1 STAT_MESH_SERVER stub) now floods channel traffic
  unconditionally (`crdt_have_mesh_stub()`, O(1) counter; inert in steady state), so a partitioned
  user's channel msgs reach legacy via the gateway even with NO other CRDT channel member. Verified:
  isolate nef6, alice+bob(legacy) only → bob got all 8 (was 0). Caveat: triggers once the node DETECTS
  the partition (holds stubs) — a node behind a one-sided cut detects via its uplink's ping-timeout
  SQUIT; until then it floods nothing extra (its tree relay is dead anyway, no regression); a real
  symmetric split detects promptly. **Remaining limitations (accepted):** reverse unicast PM
  legacy→stub-user still drops (R4b); multi-gateway presenting the same stub to the same legacy server
  out of scope (single-gateway topo).
- **R7a — retire P10 SQUIT among CRDT peers** · M · **DONE 2026-06-14 (testnet `data/ircd*.conf` flag,
  default-off; submodule pending commit).** Among CRDT-aware-both-ends peers a server departure rides the
  CR H beacon set (stale beacon → S3 keep-gate + sweep retire it) instead of an up-front P10 SQUIT.
  `FEAT_CRDT_MESHMAP_PRESENCE` (shared with the S3 precise keep-gate). Pure `crdt_should_suppress_tree`
  (cmocka) + `crdt_tree_presence_suppress` + Q-1/Q-2 guards (s_misc.c). Validated: 5-node bringup 5/5/0,
  all leaves 7/7, R7-shadow=0 (real), 0 crashes, commanded /SQUIT clean. Detail: [[project_crdt_r7a_squit_only]].
- **R7b — retire BURST + SERVER tree** · XL · **endgame, INFEASIBLE as prefix-hiding (2026-06-14).** Live
  attempt (full SERVER suppression) **broke leaf user-materialization**: P10 is a flat namespace with
  HIERARCHICAL delivery — a relayed SERVER carries a source-prefix every downstream server must already
  know, so suppressing a CRDT server's SERVER intro orphans everything sourced through it (legacy DH=x3/
  services, Bj relayed behind hub2 → a leaf with no direct P10 link to the suppressed introducer drops
  them → 7/0; legacy servers don't beacon → no anchor fallback). **You cannot hide an intermediate P10
  SERVER; SERVER retirement needs MESH-NATIVE routing (flat presentation) or an all-CRDT-aware network
  with NO legacy relayed through the mesh — NOT suppression.** (BURST is already conditional/CR-F-replaced;
  retiring it standalone is moot without SERVER retirement.) Synthetic-anchor identity already works for
  CRDT-origin servers. Gate: ALL peers CRDT-aware AND services folded into the IRCd (`project_x3_
  nefarious_merge`; **do NOT plan X3-as-CRDT-peer**). §17.7 gateway is the last P10 surface for legacy.

### Mesh-native routing (the R7b enabler) — scope: `crdt-mesh-native-routing-scope.md`
The routing layer R7b actually needs. **Primary track = pure-CRDT (MR-0/1/2 + TTL + dedup, no
legacy gateway) — MR-0/1/2 DONE this session.** Phases MR-0…MR-5 (plan per phase:
`crdt-mesh-mr0-routing-table.md`, …; **MR-3 scoped + 3a DONE: `crdt-mesh-mr3-legacy-presence.md`** — the
legacy-gateway track, beacon-proxied presence NOT the doc servers-map).
- **MR-3a — proxy-beacon legacy presence (inert/shadow)** · M · **DONE 2026-06-17 (submodule `31311cb`).**
  Gateway proxy-beacons its legacy subtree (single-writer via `!IsCrdtAware(cli_from)`); `crdt_should_suppress_intro`
  pure fn + cmocka (for 3c); shadow oracle `crdt_shadow_legacy_presence_diff`. Flag `FEAT_CRDT_LEGACY_PRESENCE`
  (default off). Validated on the hybrid bed (nef3↔legacy testnet↔x3): far leaf nef7 shows testnet+x3
  `beacon=FRESH`, gateway `ABSENT` (single-writer), inert (SERVER relay still wins), 0 crash. Next: MR-3b
  (anchor-from-beacon on a cut leaf) → MR-3c (suppress legacy SERVER intro toward CRDT peers, flag-enable).
- **MR-0 — routing table (observability)** · S · **DONE 2026-06-15 (submodule pending commit).**
  Two net-new pure primitives (cmocka 20/20): `crdt_meshmap_nexthop` (per-viewpoint unicast
  shortest-path first-hop, the MR-1 input) + `crdt_meshmap_canon_tree` (root-free Kruskal-lex
  canonical broadcast tree — viewpoint-independent, the MR-2 input; today's `_spanning` is
  self-rooted). Integration: `/CRDT route` oper view + `crdt_shadow_route_diff` oracle (mesh
  next-hop vs P10 `cli_from`, in the verify timer). **Observability-only — derives/measures,
  routes nothing.** Live 5-node: converged identical mdigest, **canonical tree byte-identical on
  every node**, valid next-hops, **`p10Only==0`** (the real gate; no adjacency gap), 0 crashes;
  cut/heal tracked the topology change + re-converged. **KEY finding: the original `mismatch==0`
  exit criterion was WRONG** — the CRDT adjacency is intentionally richer than the P10 tree
  (cross-links + CRDTMESH overlay), so `mismatch>0` is the normal/correct state; `p10Only==0` is
  the gate, `meshOnly>0` = overlay/stub wins, both transient `p10Only`/`meshOnly` spikes on
  cut/heal = the convergence-lag the oracle exists to measure.
- **MR-1 — mesh-native unicast (CRDT↔CRDT)** · M · **DONE 2026-06-15 (submodule `2ca81ba..`;
  flag default-off, enabled in testbed `data/ircd*.conf`).** Routes user-unicast (PRIVMSG/NOTICE/
  TAGMSG) over CR to CRDT-aware destinations via the MR-0 next-hop table, TTL-bounded, P10
  fallback. Pieces: `crdt_route_action` pure decision (cmocka, deliver/drop/next-hop/flood);
  TTL on the CR M wire (`M … <tgt> <ttl> :<text>`, parc-compatible, default 32 = storm-backstop);
  `crdt_route_unicast_try` (the one trigger helper at all 6 sites: ircd_relay ×4 + m_tagmsg ×2);
  receiver relay split (channel=flood, unicast=next-hop); flag `FEAT_CRDT_ROUTE_UNICAST`.
  **Default-off = today's behavior exactly** (mesh-stub→flood, live→P10). Validated: cmocka 21/21;
  inert PM exactly-once over P10 (no regression); flag-on PM travels as a `CRDT M` next-hop frame
  (TTL=32), P10 tree fully bypassed, delivered exactly-once, 0 crashes. Crash bug caught+fixed by
  live test (next-hop format string dropped the target placeholder → TTL int read as char* →
  SIGSEGV). Tree-disconnect met by-construction (never touches the tree) + R6c.
- **MR-2 — mesh-native broadcast (channel, over the canonical shared tree)** · M · **DONE
  2026-06-15 (submodule `551521e..`; flag default-off, enabled in testbed `data/ircd*.conf`).**
  Generalizes the R4a channel CR-M flood (~2·E) to forward over the MR-0 canonical tree (N−1)
  when the mesh is stable, flood-fallback during flux. Pieces: `crdt_meshmap_tree_neighbors`
  + `crdt_meshmap_row_changed` (pure, cmocka 23/23); `g_mesh_changed_ts` +
  `crdt_shadow_mesh_bcast_stable` (35 s settle gate — tree only once adjacency converged, flood
  during the lag = gap-safe); `crdt_tree_forward_chan` (origin + relay) hardened to
  flood-fallback if any tree edge isn't a directly-sendable link; `FEAT_CRDT_ROUTE_BCAST`.
  **all-server broadcast (WALLOPS/GLINE/…) = MR-2b, deferred** (those P10 tokens carry no msgid
  yet). Validated: inert flood (no regression); flag-on stable = N−1 star (CR-M parses
  origin=0/each-leaf=1/total=4), exactly-once; flux (stop a leaf, send) = flood-fallback,
  exactly-once, no gap; 0 crashes. NB the "gap" scare was a `CR M` (P10-server token) vs
  `CRDT M` (overlay token) grep artifact — instrumentation proved full N−1 coverage.
- **MR-2b — all-server broadcast (WALLOPS class) over the mesh** · S · **DONE 2026-06-15
  (submodule `2ca310b..`; flag default-off = `FEAT_CRDT_ROUTE_BCAST`, shared with MR-2).**
  Ephemeral all-server notifications (WALLOPS) ride CR M as `cmd='W'` target `*`, tree-forwarded
  over the canonical tree (reuses MR-2 carrier), each node delivers to its local +w opers.
  `sendwallto_group_butone` (user-sourced WALLOPS only) skips CRDT-aware downlinks + emits one
  `crdt_gossip_message('W','*',msgid,text)`; new `sendwallto_local` does the receiver +w delivery;
  ms_crdt `cmd='W'` branch + `'*'` added to the broadcast relay. **Architectural split
  (user-confirmed): ephemeral notifications tunnelled; persistent network state (GLINE/SHUN/JUPE/
  ZLINE bans, SETTIME) is NOT — it belongs in the CRDT doc as collections (the Phase-3i channel-ban
  precedent) = a separate future "global-state-into-doc" track.** Deferred this phase:
  server-sourced WALLOPS (cli_user==NULL → P10), WALLUSERS/DESYNCH (trivial follow-ons). Validated:
  flag-on WALLOPS reaches +w opers on all 4 CRDT leaves exactly-once, carried as `CRDT M … W … *`
  (P10 suppressed toward CRDT peers, legacy still P10), 0 crashes.

### Global-state-into-doc track (persistent network state as CRDT collections, NOT tunnelled)
The MR-2b counterpart: GLINE/SHUN/JUPE/ZLINE bans + SETTIME are network STATE → CRDT doc
collections (the Phase-3i channel-ban precedent), not ephemeral broadcasts. Plan:
`crdt-mesh-glines-doc.md`.
- **GLINE step 1 — CRDT engine collection** · S · **DONE 2026-06-15 (submodule `07a82b2..`).**
  New `GLINES` LWW-map keyed by ban mask → `CrdtGlineRecord` (expire/lastmod/lifetime/flags/addr/
  bits/reason), mirroring `chanmeta`: enum + map + `lww_for` + both digests (salt 9) + snapshot
  serialize + op-recording `crdt_gline_set`/`crdt_gline_del` (GC + snapshot-deserialize generic via
  `lww_for`). cmocka `test_gline_op_replicates` (set/update/delete via delta + digest converge +
  snapshot roundtrip). **Inert** (no caller yet — empty collection doesn't perturb the digest);
  cmocka gates the image; 5-node bringup still single-mdigest, 0 crashes.
- **GLINE step 2 — shadow-write** · S · **DONE 2026-06-15 (submodule `d235c28..7b9c6ab`).** Hook the
  canonical gline.c state-change points (`gline_add`/`activate`/`deactivate`/`modify`/`remove`) to
  `crdt_shadow_gline_add`/`_remove` — key = ban mask, record = expire/lastmod/lifetime/flags/addr/bits/
  reason. **Single-writer** via `from_crdt_peer(from)` (the mesh ENTRY server writes once; CRDT-aware
  peers receiving the P10 GL relay skip + get it via CR sync → single-origin, no clock-skew amplification;
  same gate as the channel/user hooks). Local G-lines self-skip; expiry leaves the lifetime-bearing
  record. **SHADOW-ONLY** (gated `shadow_on()`/FEAT_CRDT_ENABLED, doc plane only — live G-lines still
  P10-propagate; no behavior change). Validated live on the 5-node mesh: global GLINE → written once at
  nef3 → all 5 converge to a new common mdigest; /REMOVE → tombstone → all 5 converge back to the exact
  pre-gline baseline mdigest; a local GLINE left the doc untouched; 0 mismatches, 0 crashes. No new engine
  logic → no new cmocka (step 1's `test_gline_op_replicates` still gates).
- **GLINE step 3a — reconcile-from-doc + §17.7 gateway** · M · **DONE 2026-06-16 (submodule `7b9c6ab..1045381`).**
  Flag `FEAT_CRDT_GLINE_CUTOVER` (default off). `crdt_shadow_reconcile_glines()` (wired into the verify timer +
  CR delta-apply path) drives live global G-lines FROM the doc: ADD/heal/drift via `gline_add`/`gline_modify`
  (field echo guard, NOT lastmod → no churn; carries `rec->lastmod` → no legacy ping-pong; `do_gline` kicks
  locals; expired never materialized), REMOVE via the new engine gate `crdt_gline_is_explicitly_removed`
  (doc-tombstone, never mere absence) + a `-mask` gateway. Re-entrancy guard `g_gline_reconciling` → the gline
  shadow hooks self-skip so a doc-driven materialize never re-mints (the #1 hazard). cmocka extended. Safe
  no-op while P10 still flows (the inert-then-flip discipline).
- **GLINE step 3b — suppress P10 GL among CRDT peers** · S · **DONE 2026-06-16 (submodule `..a153076`).**
  Under the flag, `gline_propagate`/`gline_modify` demote to legacy-only (`sendcmdto_flag_serv_butone` forbid
  FLAG_CRDT_AWARE; forbid=FLAG_LAST_FLAG when off ⇒ byte-identical to the old path), and `gline_burst`/
  `gline_resend` skip CRDT-aware targets. Makes 3a's reconcile the transport + the legacy-only emits the §17.7
  gateway. **Validated live (5-node all-CRDT mesh):** global GLINE on nef3 reaches all four leaves ONLY via
  the doc — each logs `gline-reconcile: drove 1 … from doc` (P10 GL suppressed ⇒ not echo-guarded to 0); live
  on leaf nef7 via `STATS g` with the carried lastmod; `/REMOVE` → all four `removed 1`, gone via STATS g;
  converges; 0 crashes/restarts. The doc is now the transport for global G-lines among CRDT peers. Gateway-to-
  legacy witness (non-CRDT/x3 peer) is a follow-on (current bed is all-CRDT).
- **SHUN as CRDT doc state (engine + shadow-write + cutover)** · M · **DONE 2026-06-16 (submodule `a153076..8a3912d`).**
  The GLINE template applied 1:1 to SHUN (silence ban, P10 SU token, no badchan, single `GlobalShunList`) —
  landed as ONE commit (mechanical mirror + flag `FEAT_CRDT_SHUN_CUTOVER` default-off ⇒ behavior-neutral).
  Engine: SHUNS LWW-map + `CrdtShunRecord` (digest salt 13) + `crdt_shun_set/_del/_is_explicitly_removed` +
  cmocka `test_shun_op_replicates`. Shadow-write: `crdt_shadow_shun_add/_remove` at the 5 shun.c sites.
  Cutover: `crdt_shadow_reconcile_shuns()` (+ `g_shun_reconciling` guard) + suppress P10 SU. **Validated live
  (5-node mesh):** global SHUN on nef3 → all four leaves `shun-reconcile: drove 1 … from doc`, live on leaf
  nef7 via `STATS S` (uppercase! lowercase s=spoofhosts) with carried lastmod; `/REMOVE` → all four `removed 1`;
  0 crashes.
- **ZLINE as CRDT doc state** · S · **DONE 2026-06-16 (submodule `8a3912d..ebeaa8f`).** Third template
  application (IP-ban sibling, P10 ZL token). One structural simplification: a SINGLE `zl_mask` field (no
  user@host split, no realname/version/badchan) → doc key = `zl_mask`. ONE commit (mirror + flag
  `FEAT_CRDT_ZLINE_CUTOVER` default-off). ZLINES LWW-map + `CrdtZlineRecord` (digest **salt 14**) +
  `crdt_zline_*` + cmocka `test_zline_op_replicates`; `crdt_shadow_zline_add/_remove` (5 sites);
  `crdt_shadow_reconcile_zlines()` (+ `g_zline_reconciling`) + suppress P10 ZL. **Validated live:** global
  ZLINE on nef3 → all four leaves `zline-reconcile: drove 1`, live on leaf nef7 via `STATS Z` (uppercase;
  lowercase z=memory) with carried lastmod; `/REMOVE` → all four `removed 1`; 0 crashes.
- **JUPE as CRDT doc state** · M · **DONE 2026-06-16 (submodule `ebeaa8f..349f511`).** Fourth collection, first
  NON-ban (juped server name, P10 JU). **Adapted** template: keyed by server name; no lifetime/addr; jupe has
  no modify/force-remove → a global jupe is "removed" by DEACTIVATION (SET-inactive, never tombstone), drift
  handled by RECREATE (jupe_free+jupe_add); expire is a DURATION from CurrentTime (not absolute/TStime);
  do_jupe SQUITs a matching local server; `GlobalJupeList` made non-static. One commit (flag
  `FEAT_CRDT_JUPE_CUTOVER` default-off). JUPES LWW-map + `CrdtJupeRecord` (**salt 15**) + `crdt_jupe_*` +
  cmocka `test_jupe_op_replicates`; reconcile + suppress P10 JU. **Validated live:** global JUPE on nef3 → all
  four leaves `jupe-reconcile: drove 1`; `JUPE -server` deactivate → all four `drove 1` (recreate-inactive
  drift path); converges (uniq=1 mdigest); 0 crashes. (STATS J HIS-masked by default — materialization proven
  by reconcile logs.)
- **SETTIME — SCOPED OUT (user-confirmed 2026-06-16), track CLOSED.** SETTIME is NOT doc state: `ms_settime`/
  `mo_settime` do exactly `TSoffset -= dt` (a one-shot per-server clock-offset adjustment — no record, no key,
  no list), priority-routed (`hunt_server_prio_cmd`/`sendcmdto_prio_one`), and skipped entirely under
  `FEAT_RELIABLE_CLOCK`. Modeling it as a CRDT collection is a **layering inversion** — the doc's whole
  ordering model (HLC + LWW) *depends on* the clock, so making clock-adjustment into doc content makes the
  transport's correctness depend on the very thing transported. It's a control-plane primitive, neither a ban
  record (doc) nor a user notification (the MR-2b tunnel). **At MR-5** (P10 retirement) SETTIME would ride the
  mesh as a **priority control-message** (a TTL'd CR tunnel, like WALLOPS but priority-routed), NOT doc state —
  deferred to that track. **The global-state-into-doc track is COMPLETE: GLINE + SHUN + ZLINE + JUPE** are all
  CRDT-native (doc transport among CRDT peers, P10 token suppressed, §17.7 gateway to legacy); persistent
  network ban/jupe state now lives in the CRDT doc.

### Two spikes the arc needs
1. ~~**R4 bandwidth measurement**~~ — **DONE 2026-06-11** (`crdt-mesh-r4-bandwidth-spike.md`). Measured
   the CR-delta flood fan-out on the 5-node bed: **10 crossings/op no-batch (2.5× the N−1 optimum),
   3.6 blob-crossings/op under load** (batching amortizes) — **bounded, not exponential → path-vector
   NOT forced.** Decision: **flood, shaped** — widen CR M for CHANNEL traffic (broadcast ≈ tree cost,
   dedup-gated for exactly-once), keep UNICAST hybrid (tree-primary + targeted overlay failover, NOT a
   full N-way flood — flood cost ≈ 2·E so pure-flood unicast is wasteful). Re-measure in bytes if R4a lands.
2. ~~R1 liveness oracle~~ — DONE (CR H beacon). No longer a spike.

### Dependencies / gates
Fix A (post-heal convergence) — DONE, the foundation. R1 liveness — DONE. R2 — VERIFIED 2026-06-12.
R3 — DONE. R4 (headline) — DONE (R4a channel flood + R4b unicast hybrid). R5 — BLOCKED-by-design,
folded into R6. **Critical path now resumes at R6** (demote tree to legacy-only; absorbs R5). R7 is
gated on all-CRDT + services-fold (out of this arc's control — separate project). Per-op scoped
reconcile (deferred) becomes relevant at R4+ scale, not before. Track A #3/#4/#4-QUIT all DONE
2026-06-12; remaining Track A = cosmetic batch + AUTOCHANMODES verify.

## Recommended overall order
Track A (#4, #3) can land anytime, independent. Track B critical path: **R2 → R3 → R4 (headline) → R5 →
R6 → R7(endgame)**. R1 + Fix A already clear the foundation. The first big demonstrable milestone is
**R4** (live traffic survives a tree cut with zero interruption) — that's the visible payoff of "P10
routing retired." Everything before R4 (R2/R3) is prerequisite hardening; everything after (R5/R6/R7)
is widening + endgame.

## Observability — mesh-map + /CRDT command (2026-06-13, DONE)
On-demand oper introspection: `/CRDT [map|peers|status]` (`mo_crdt` in `m_crdtinfo.c`, reusing the
existing `MSG_CRDT_REPLICATION` msgtab OPER slot; CLIENT=`m_not_oper`, SERVER=`ms_crdt` unchanged).
Renders the gossiped mesh topology as a `/MAP`-style ASCII tree (roles + beacon age + x-links + legacy
peers), an adjacency list, and an on-demand `crdt_shadow_verify` summary + role census + partition state.

**The modeling fix that makes global mesh-state safe** (revives the abandoned Phase-4a servers-map
correctly): replicate **adjacency** (each node declares only its OWN direct-peer set → single-writer per
key → converges), **derive reachability LOCALLY** (BFS over the union, prune beacon-stale). This is
link-state flooding, not the per-viewpoint reachability value that diverged. Adjacency rides the existing
**CR H beacon** (append-only `peers` field: `H <srv> <ts> <cap> <peers> :<name>`, back-compat because
`name` stays trailing/`parv[parc-1]`), which is **OUTSIDE `crdt_state_digest`** → physically cannot move
the digest. New pure module `crdt_meshmap.c/.h` (BFS/spanning/cross-edges, cmocka `crdt_meshmap_cmocka`
10/10 gates the image). Verified live on the 5-node mesh: global topology from one node, partition prunes
reachability while the digest holds steady + stays equal across nodes, reconverged on heal, 0 crashes.

**HARD SCOPE — observability-only.** The mesh-map feeds the command, NOT materialization/routing (those
keep the local `FindNServer` check). Promoting the gossiped map to a routing input ("SPLIT iff
unreachable via all transports") is the deliberate **Tier-2** step — that is where R7/endgame risk lives;
do NOT let it ride along with observability.

## Direction correction (2026-06-13): CRDT does NOT gate on services-fold — it enables it
R7 above is phrased "gated on all-CRDT-aware AND services-folded-into-nefarious," which mis-reads as the
services-fold gating CRDT. **Inverted:** a CRDT doc is precisely the "reliable reconciliation without a
central DB" a clean services-fold needs, so CRDT work proceeds INDEPENDENTLY and must not block on the
(long-term) X3→nefarious merge. The all-CRDT-aware prerequisite for retiring the BURST/SERVER tree stands;
the services-fold is a *consumer* of the CRDT substrate, not a gate on it.

## Not-yet-on-CRDT — transport gaps (low initial priority, the next expansion class)
The doc is CRDT-authoritative for **structural** state only (users/nicks/channels/members/modes/topics/
bans/kick/quit — Phase 3 complete). These IRCv3 stateful subsystems are **still pure P10, no CRDT
transport**, and are the natural follow-on once Tier-2 routing matures (they're also what makes a
folded-in services durable without re-adding a DB):
- **chathistory federation** (CH tokens) — only a cherry-picked per-link cleanup bugfix touched it, not transport.
- **metadata** (MD/MDQ), **read-marker** (MR), **redaction**, **event-playback**.
- **bouncer session state** (BS/BX), away, silence, invite list, per-member join time, monitor, webpush.

## Constraints
Standing CRDT-mesh rules: submodule push to `origin crdt-mesh`, testnet pointer staged as ONLY
`nefarious-crdt`, `Co-Authored-By` trailer, configs uncommitted, cmocka gates the image, verify the
`ircd.YYYYMMDDHHMM` symlink advances per build.
