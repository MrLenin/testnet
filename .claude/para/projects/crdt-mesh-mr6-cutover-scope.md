# MR-6 — overlay-as-primary transport (drop P10 links among CRDT peers) — SCOPE

Scoped 2026-07-29 against `nefarious-crdt` @ `crdt-mesh` (post-`b0a2cbd`/`d499f60`/`8477655`,
post-5-5f-Phase-B, post-Cluster-A/C/WALL*). Source-grounded (m_server.c / s_serv.c / m_crdt.c /
crdt_shadow.c / ircd.c / client.h read this pass; token dispositions from the 2026-07-23 S2S
coverage audit + the 2026-06-17 MR-5-5 sweep). This is a SCOPING document — no implementation.

Cross-ref: `crdt-mesh-roadmap.md` (MR-6 = OPEN item 6), `crdt-mesh-s2s-coverage-audit.md`,
memory `project_crdt_mr5_tree_retirement.md` (esp. finding (a): "MR-5 suppresses SERVER on the
EXISTING P10 link … moving CRDT peers onto the CRDTMESH overlay + dropping the P10 link is a
SEPARATE larger phase MR-6"), `crdt-mesh-meshmap-routing-r7.md`, `crdt-mesh-squit-as-split-scope.md`,
`bouncer-promotion-finish-scope.md` (the 2026-07-29 gate ledger).

## 0. Definition

MR-5 retired the P10 SERVER/BURST **tree structure** among CRDT peers but kept the **physical P10
links**: the direct two-endpoint SERVER handshake is never suppressed, so each CRDT pair with a
Connect block still forms a `STAT_SERVER` link that carries CR tokens, PING/PONG, EOB, and the
residual unconverted P10 tokens. MR-6 = drop those links entirely. Between CRDT nodes the ONLY
connections are `FLAG_CRDT_OVERLAY` edges (`mr_crdtmesh`, m_server.c:705 — STAT_HANDSHAKE forever,
never `IsServer`, never in `server_list[]`/name hash, CR tokens only). Every remote CRDT server is
then a Case-B synthetic anchor (`crdt_shadow_make_anchor`) minted from its CR H self-beacon; the
§17.7 gateway holds the single remaining P10 surface (legacy nef1/.2 + x3.services). Transport,
P10 framing, and YXX numerics are KEPT (R0 definition unchanged — CR rides P10 framing).

## 1. Current state — what already works over the pure overlay

The decisive fact: **the bed already runs a live approximation of MR-6 on the nef3↔nef7 axis.**
nef7's only P10 CRDT link is its uplink to nef5 (data/ircd7.conf); under `FEAT_CRDT_TREE_RETIRE`
its LINKS is itself + nef5 and it reaches nef3 (and everything else) exclusively via the doc +
CR over the nef7↔nef3 / nef7↔nef6 overlays. Every "overlay-only nef7" gate of the last week is
therefore an MR-6-shape gate:

- **Structural state + BURST**: users/nicks/channels/members/modes/topics/bans/kicks/quits all
  doc-native (Phase 3); at-link sync = CR F snapshot (`server_finish_burst`, s_serv.c:375-381);
  extended channel modes +A/+U/+L/exmodes in ShadowModeSnap (`573c6e1`, gate green incl. OPLEVELS
  A/U 2026-07-29); gateway_birth_modes extended render (`eba38ec`, gate green).
- **Live delivery**: channel PRIVMSG/NOTICE/TAGMSG CR-M flood/canonical-tree (R4a/R6/MR-2);
  unicast PM/NOTICE/TAGMSG via `crdt_route_unicast_try` (MR-1); KILL/INVITE 'K'/'I' (MR-4c/5-1);
  CP/CN whisper (`dc86c3f`); WALLOPS user-sourced + WALLUSERS + WALLCHOPS/VOICES/HOPS 'c'/'h'/'v'
  (`9087e75`+`14a1d99`, gates green); multiline to mesh-only targets.
- **Global state**: GLINE/SHUN/ZLINE/JUPE doc cutover flags; SASL CI cache-inval CR M 'I'
  (`2b1283d`); permanent metadata (era-2 P0-P3) + read-marker doc-native.
- **Services**: CR-X services bridge (`FEAT_CRDT_SERVICES_BRIDGE`) — SASL/AUTHENTICATE, XQ/XR
  (gate green), SVS J/P/M/D/N tunnel (`6cdddee`, SVSJOIN gate green through the x3 gateway edge).
- **Bouncer**: bsessions/bconns/leases doc-native (M2-M6d), eager-mint sub-second (2026-07-29),
  BS O doc-native, **FULL BX alias lifecycle over the overlay GATE GREEN 2026-07-29 (pool09):
  attach on nef7 + back-materialize on nef3 + gateway BX C synth + tombstone de-mat** — the
  roadmap's "bouncer BX cross-mesh BREAKS" prod-blocker is CLOSED (modulo the BX 'B' echo gate,
  §2.7).
- **Chathistory federation (5-5f)**: Phase B B1→B4 closed BOTH directions (publish/consume over
  the mesh + legacy-ward capability synth `7e61bd9`) + Phase 0 legacy↔mesh interop (`2c91f6b`) —
  the MR-5-5 "permanent history holes" prod-blocker is CLOSED.
- **Presence/liveness substrate**: CR H beacons (append-only: ts, capacity, peers-adjacency,
  fronted_by, name) = the presence oracle; beacon-stale retire sweep (miss-tick counted,
  crdt_shadow.c ~6234); overlay half-open detection via CR-traffic miss-ticks +
  `crdt_overlay_is_stale` teardown in check_pings (ircd.c:652-660, `f33b86b`); overlay
  auto-reconnect in try_connections (ircd.c:546-567, doesn't consume the `done` slot); account
  propagation to overlay-only nodes (`b0a2cbd` + `d499f60` dual-plane fix); nick-collision
  resolver live-gated (2026-07-29); owner sweep + DECOMMISSION + membership re-assert (orphan
  hygiene); ms_mark IsMe (`17f9d5e`); partition-reap channel-death fix (destruct bracket).
- **Anchors as first-class recipients**: the 2026-07-27 IsServer-exact source-gate sweep fixed
  ms_chathistory entry/reply, m_silence.c:337 crash, m_fake.c:115.

### What still rides the P10 link between CRDT peers today (the thing MR-6 removes)

Enumerated by class. "Dies at MR-6" = the emit iterates `cli_serv(&me)->down` (send.c broadcast
walks direct STAT_SERVER links only — anchors are never in `->down`) or targets via
`hunt_server`/`sendcmdto_one` through a `cli_from` that will no longer exist.

| # | Class | Today's carrier between CRDT peers | MR-6 disposition |
|---|---|---|---|
| 1 | Link handshake: PASS+SERVER, +C aware-flag exchange, EOB/EOB_ACK, PING/PONG | the direct P10 link | replaced by PASS+CRDTMESH handshake + CR S pull + CR H + overlay miss-tick liveness (§2.1 parity gaps) |
| 2 | N/nick intro, JOIN/MODE/channel, TOPIC, QUIT, at-link BURST | already doc/CR F — the P10 link carries none of it (Phase 3 forbids relay to CRDT-aware) | none — done |
| 3 | Unicast PRIVMSG to users of the DIRECT P10 neighbor | still tree-delivered when a live P10 path exists (R4b hybrid: `crdt_route_unicast_try` fires only for mesh-only/anchored targets) | automatic — with the link gone the neighbor's users are anchor-hosted, MR-1 path fires (the nef3↔nef7 axis proves it) |
| 4 | Remote queries: STATS/TRACE/LINKS/MAP/ADMIN/INFO/VERSION/LUSERS/MOTD/RULES/TIME/remote-WHOIS (~12 `hunt_server_cmd` tokens) | tree-only | DIES (silent dead-sink). Decide: clean error numeric vs CR tunnel vs `/CRDT map\|peers\|status` as the by-design substitute (§5 Q3) |
| 5 | AC/account | login converges via doc (3l re-mint `b0a2cbd`); the live AC broadcast still rides the tree; LOGOUT (AC U) deliberately NOT doc-driven | LOGOUT direction needs a decision (deferred 2026-07-29 as too destructive on doc lag); login side already covered |
| 6 | MD/metadata, ephemeral tier | permanent = doc; ephemeral/TTL caches + unregistered-channel MD = P10 only, and USER-sourced tree tokens beyond the horizon are ALREADY fake-direction-dropped (audit 2026-07-25 live confirm) | needs the audit's prescribed design pass: CR-M fallback for user-sourced tokens whose `cli_from` is an anchor, or accept-ephemeral-loss explicitly |
| 7 | BS/BX bouncer | durable state doc-native; BX E/M echo tunneled via CR-X 'B' (`6cdddee`) | BX 'B' echo live gate still unrun (alias on nef7 receiving a PM echo) — now unblocked by the alias-attach fix |
| 8 | Server-sourced WALLOPS, SMO/SNO/DESYNCH/WEBPUSH-notice (Tier C F5), REDACT (`sendcmdto_serv_butone_v3`, audit correction: NOT covered) | tree broadcast | DIES. F5-class needs a CR carrier or explicit accept-loss; REDACT needs the Cluster-A treatment (state side is in CH storage; the live broadcast leg is what dies) |
| 9 | SVS force-commands' tree-broadcast leg | CR-X tunnel to the target's home SHIPPED; the unchanged tree broadcast still delivers to other nodes | verify the tunnel+doc alone suffices when the broadcast leg dies (SVSMODE side effects on non-home nodes converge via doc) |
| 10 | RENAME (Tier C F4) | P10, BLOCKED on services integration | hard MR-6 gate per roadmap ("gated on Tier C completeness") — or explicitly waived (§5 Q5) |
| 11 | OPMODE/CLEARMODE/DESTRUCT + gline-family targeted `<server>` legs (Tier D) | tree broadcast / targeted | state effects converge via doc (entry node applies + mints); the per-server APPLY legs and targeted forms die — needs the §3 Phase-2 reclassification sweep (doc-redundant vs load-bearing) |
| 12 | SETTIME | priority tree route; scoped at MR-5 as "a TTL'd priority CR tunnel, NOT doc state" | decide: build the tunnel or drop under FEAT_RELIABLE_CLOCK/NTP+HLC (§5 Q6) |
| 13 | m_batch S2S `route_to`/`acptr` provenance (m_batch.c:247/269/2289/2308, :527 anchor-source) | UNRESOLVED since the 2026-06-17 audit, "revisit at MR-6" | must be traced this arc |
| 14 | Oper CONNECT/SQUIT of a CRDT peer | P10 semantics | replaced by overlay-CONNECT (does not exist — §2.2) + DECOMMISSION (`244fdf6`, exists) |

## 2. Gap list — mesh-native replacement + risk per gap

### 2.1 Overlay link-establishment parity (NEW CODE, small) — the enabling mechanics
`mr_crdtmesh` (m_server.c:705-841) ends with only `crdt_sync_request(cptr)` (:838) — a CR S
advertise/pull. Compare `server_finish_burst` (s_serv.c:354): CRDT-aware P10 peers get
(a) `crdt_shadow_beacon_burst` (:364-365 — LOAD-BEARING, not latency: Case-B materialize
requires a FRESH beacon, crdt_shadow.c:147/238) and (b) an eager `crdt_send_snapshot` push
(:377). A freshly-established overlay gets neither → an overlay-only cold-booting node sits
blind until the 30s beacon flood + anti-entropy tick. Fix = call `crdt_shadow_beacon_burst(cptr)`
(and optionally an eager CR F when the peer's SV shows below-gc_floor) at the end of
`mr_crdtmesh` on BOTH sides. **Risk: LOW** (reuses proven single-target primitives;
`crdt_gossip_beacon_to` already exists). Also: cold boot with zero P10 links never runs
`crdt_shadow_doc_ready`'s P10-BURST fallback — the CR F pull is the only initial sync; must be
gated live (fresh overlay-only boot → full materialize).

### 2.2 Overlay operability (NEW CODE, small)
- Oper `CONNECT` cannot force an overlay (skill-documented; try_connections-only, default
  CONNECTFREQUENCY cycle). Needs an overlay-aware CONNECT branch (`connect_overlay` exists,
  ircd.c:563 — just needs an oper-command path) or a `/CRDT connect <server>` subcommand.
- `/CRDT map|peers|status` is the LINKS/MAP substitute — already built (MR-0/observability).
- **Risk: LOW.** Pure ops ergonomics, but a hard prerequisite for running a bed where the overlay
  is the only transport (today a wedged overlay = wait up to 10 min).

### 2.3 Tree-broadcast residue sweep (ANALYSIS + ~small code, the long tail)
Every remaining `sendcmdto_serv_butone[_v3]`/`sendwallto_group_butone` caller NOT already
CRDT-demoted reaches ZERO CRDT peers once `->down` holds no STAT_SERVER links. Two sub-classes:
- **Doc-redundant** (effect minted at the entry node, converges via doc: OPMODE/CLEARMODE mode
  changes, gline-family activations, SVS effects on the home): broadcast death is harmless —
  verify and mark, don't build.
- **Load-bearing** (notify-only or per-node apply with no doc twin: server-sourced WALLOPS,
  SMO/SNO/DESYNCH, WEBPUSH notices, REDACT live leg, DESTRUCT?): each needs a CR carrier
  (MR-2b 'W' pattern / new letters per the CI-'I'-collision lesson: guard letters in-branch)
  or an explicit accept-loss note.
**Risk: MEDIUM** — the class is enumerable (c-auditor sweep, the 2026-06-17 audit is the seed
list) but the per-token verdicts must be decided, not defaulted (decide-don't-defer discipline).

### 2.4 hunt_server remote queries (~12 tokens)
No CR carrier. Options: (a) accept-dead + clean error ("server is mesh-reachable only — use
/CRDT"), (b) CR-X-style request/reply tunnel (XQ/XR precedent — the plumbing now exists and is
proven), (c) leave silent-dead (rejected: violates take-bug-reports-at-face-value ops hygiene).
**Risk: LOW-MEDIUM** (bounded, mechanical if (b); user decision on scope — §5 Q3).

### 2.5 SQUIT/netsplit semantics without tree links (design, then small code)
With no P10 link there is no SQUIT event between CRDT peers at all (R7a already suppresses it;
at MR-6 there is nothing to suppress). Split = beacon-stale (90s miss-tick) → stub/anchor retire
→ users exit. Consequences to design (squit-as-split doc + meshmap plan are the substrate):
- **Detection latency**: a hard overlay loss is detected per-EDGE quickly (miss-tick/EOF) but
  server-DEATH is only the 90s beacon staleness. The meshmap S2 "edge-down self-row reconcile"
  (crdt-mesh-meshmap-routing-r7.md Stage 2) is the designed accelerator: a node's own overlay
  edge-down updates its beacon adjacency same-tick; BFS-unreachable + hold-down = retire. Decide
  whether 90s is acceptable for MR-6 phase 1 (recommend: yes, one variable at a time) and whether
  S2/S3/S4 (meshmap-authoritative retire/materialize) ship inside MR-6 (recommend: phase 3).
- **User-visible netsplit shape**: anchor retire exits users one server at a time with generic
  quits, no `*.net *.split` batching. Decide presentation (cosmetic, but visible).
- **The `servers` LWW map / §17.3 SPLIT state stays UNWIRED** — beacon-set is the presence
  oracle (S1 empirical finding: BFS ≡ beacon-set); do NOT resurrect per-viewpoint reachability
  (invariant 10).
- **Admin removal** = DECOMMISSION (already shipped, auto-dissolving marker). /SQUIT of a mesh
  peer should error toward DECOMMISSION.
**Risk: MEDIUM** — semantics, not mechanism; the mechanism is all live today (every partition
gate exercises it).

### 2.6 Gateway singularity + failover (MR-4d-3, deferred-to-here by design)
At MR-6 endgame the gateway is the ONLY node with P10 links (legacy + x3). Gateway death =
network loses services/SASL/legacy until another node promotes. MR-4d shipped the election
(`crdt_gateway_should_standby`, fronted_by/min_fronter) but MR-4d-3 (legacy_net_id conf +
establishment gating + standby promotion, `FEAT_CRDT_GATEWAY_GATING`) and the 2-gateway live
test were explicitly deferred "post-MR-5 — only prevents a 2nd active gateway, which can't exist
pre-MR-5". MR-6 is where they come due. Also required: gateway keeps FULL P10 emit toward legacy
(`crdt_gateway_user_intro`, birth modes, BS/BX/CH synth — all unchanged; the both-ends gates
auto-handle it).
**Risk: MEDIUM-HIGH** (multi-writer legacy presentation is the classic double-delivery/collision
hazard; the election is built but never live-exercised with 2 gateways).

### 2.7 Residual live gates (no new code, just runs)
BX 'B' echo over CR-X (alias on nef7 receiving a PM echo — unblocked now); multi-gateway live
test (couples to 2.6); SASL Path-3 with `SASL_LOCAL=FALSE` (X3-only auth) over the bridge on an
overlay-only node; watch-items from 2026-07-29 (legacy host/umode drift is FIXED — confirm it
holds under MR-6 load).

### 2.8 Mixed-topology connectivity invariant
MR-5's mixed-path invariant generalizes: the CRDT subgraph must be OVERLAY-connected (every CRDT
pair reachable via CR edges), with enough redundancy that a single edge loss doesn't partition.
Live gate = MR-0 `crdt_shadow_route_diff` (`p10Only==0` today; at MR-6 the check inverts to
"meshmap BFS reaches every fresh-beacon server"). Config discipline: ≥2 disjoint overlay paths
per node (the bed already has this shape). A guard at cutover: refuse to drop the last P10 CRDT
link (or refuse boot overlay-primary) if the overlay graph is not redundant — or at minimum log
loudly.

## 3. Phased increments (smallest-first, each independently gateable on the 5-node bed)

Per-node/per-link incremental — legacy stays pure P10 + gateway at every step. Flags: new
`FEAT_CRDT_OVERLAY_PRIMARY` (default off) for the node-level behaviors; reuse
`FEAT_CRDT_TREE_RETIRE`/`FEAT_CRDT_GATEWAY_BRIDGE`/`FEAT_CRDT_SERVICES_BRIDGE` (all already on
in the bed); `FEAT_CRDT_GATEWAY_GATING` arrives in phase 4.

- **MR-6-0 — overlay parity + ops plumbing** (S). §2.1 beacon-burst/eager-snapshot at
  `mr_crdtmesh`, §2.2 overlay CONNECT, §2.8 connectivity guard (log-only). Inert w.r.t.
  topology. GATE: restart an overlay peer → uplink logs the beacon-burst on the OVERLAY link;
  full materialize the same second (the MR-5 beacon-burst gate, re-run on a CR-only edge).
- **MR-6-1 — one leaf pair drops its P10 tree link** (M). Config-only cutover after 6-0:
  remove nef7's P10 Connect to nef5, add a nef7↔nef5 crdtmesh overlay (nef7 then has overlays
  to nef3/nef5/nef6 and ZERO P10 links — a true overlay-only node, incl. cold boot).
  `FEAT_CRDT_OVERLAY_PRIMARY` on nef7 suppresses any "no uplink" warnings and asserts the boot
  path. GATE: cold-boot nef7 overlay-only → full fleet materialize; the standing regression
  battery against nef7 (mat-check 0 fleet-wide, alias E2E pool run, WALL*, CH federation both
  directions, GLINE cutover, SVSJOIN via x3, CI invalidation, /CRDT map shows it); 24h soak,
  0 crashes/valgrind.
- **MR-6-2 — tree-broadcast residue + hunt_server disposition sweep** (M-L). §2.3 c-auditor
  sweep → per-token verdicts (doc-redundant / CR carrier / accept-dead+error) → implement the
  load-bearing carriers (F5 letters, REDACT leg, server-WALLOPS) + the m_batch provenance trace
  (§1 row 13) + the beyond-horizon user-sourced token design pass (§1 row 6). GATE: each new
  carrier's targeted gate against overlay-only nef7; negative gates for accept-dead tokens
  (clean numeric, no silent drop, no crash from anchor sources — c-auditor invariant-2 re-sweep).
- **MR-6-3 — SQUIT-as-split semantics** (M). §2.5: split-presentation decision, /SQUIT→
  DECOMMISSION error path, optionally meshmap S2 edge-down acceleration + S3/S4
  (meshmap-authoritative retire/materialize — shadow-verify first per that plan's staging).
  GATE: partition an overlay-only node (netns sidecar) → split detected ≤ decided bound, users
  retire cleanly, heal re-materializes, 0 ghosts/dupes (the standing partition-cycle gate), and
  the §17.5 collision gate re-run across the heal.
- **MR-6-4 — endgame: all CRDT nodes overlay-only, single elected gateway** (L). Convert the
  remaining CRDT-pair P10 links (nef3↔nef4, nef3↔nef5, nef4↔nef6, nef5↔nef7-already-done) to
  overlays; gateway nef3 keeps P10 to .2/upstream/x3 only. MR-4d-3 (`FEAT_CRDT_GATEWAY_GATING`,
  legacy_net_id, standby promotion) + the 2-gateway live test (nef4 as standby gateway with a
  dormant legacy Connect). GATE: the R7b oracle fleet-wide (every leaf 100% users/channels via
  doc); kill the gateway → standby promotes, legacy/services traffic resumes, NO double-delivery
  while both P10-link; the full promotion-gate battery (bouncer, CH, SASL) through the promoted
  gateway.

Dependencies: 6-0 → 6-1; 6-2 and 6-3 independent after 6-1 (6-2 informs 6-4's "nothing left on
the tree" precondition); 6-4 last, additionally gated on Tier C F4/F5 disposition (§5 Q5).

## 4. Hard invariants at risk, per phase (skill numbering)

- **All phases — #2 (IsServer-exact branches crash on stub/anchor sources).** MR-6 makes anchor
  sources the STEADY STATE for every remote server, not the partition case. The 2026-07-27 sweep
  fixed the known handlers; each phase must re-run the c-auditor sweep over any token class newly
  carried (6-2 especially). Watch `%C` formatter sites and `cli_user(sptr)` derefs in the nine
  `bounce_alias_*` sub-handlers (audit-flagged, untraced).
- **6-0/6-1 — #9 (beacon emits unconditionally).** The beacon becomes the SOLE presence signal
  (no P10 SQUIT backstop at all). Any regression in beacon cadence/burst = fleet-wide false
  retire. Also GC: `crdt_state_gc` skips at zero live `IsCrdtSyncTarget` peers — an overlay-only
  node with all overlays down must not GC-diverge (existing behavior, but newly reachable state;
  pin with a gate).
- **6-1 — #5/#7 (tombstone-mint vs local-free; ctime incarnation).** Cold-boot overlay-only =
  restart re-import + materialize churn; the restart-amplifier class (stale store rows minted
  with NOW HLCs — the hold-"0" lesson) and the partition-reap destruct bracket must hold. Watch
  the op-less-tombstone stickiness note (permanent residue growth on a node that snapshots often).
- **6-2 — the CI-'I' shared-letter hazard.** Every new CR-M cmd letter must be in-branch
  distinguishable + guarded (the forward-compat unknown-cmd drop `bac5770`); mixed-version rule:
  receivers fleet-wide one bed generation before any emit flag flips.
- **6-3 — #11 (doc-removal reconciles live-walk + `*_is_explicitly_removed`).** Faster split
  detection (meshmap S2/S3) changes retire timing; every reap it accelerates must keep the
  explicit-tombstone gate (never absence), and the membership re-assert rule (a doc-driven PART
  may never remove a live local member) must survive re-timing.
- **6-4 — #1 (single-writer incl. mesh stubs) + bouncer inv#3/#6.** Two gateways = two potential
  writers of legacy-presentation state and two BS/BX synth sources; the election must guarantee
  exactly-one-active BEFORE the second gateway's P10 link can establish (that is MR-4d-3's whole
  job). Legacy-ward user intro from the wrong gateway = numeric collision on .2.
- **Throughout — #10.** Reachability stays a LOCAL determination (beacon + BFS-local); no
  replicated reachability, no path-vector, regardless of unicast-efficiency temptation.

## 5. Open design questions (need user decisions)

1. **Split-detection bound (6-3):** accept the 90s beacon-stale as the netsplit latency for
   MR-6, or pull meshmap S2 edge-down acceleration into scope? (Recommend: 90s for 6-1..6-2,
   S2 in 6-3.)
2. **Netsplit UX:** how should an anchor-retire present to clients — per-user generic quits
   (today) or synthesized `server1 server2`-style split quits/batching? Cosmetic but public.
3. **hunt_server remote-query scope (6-2):** which of the ~12 must WORK at MR-6 (CR tunnel)
   vs error cleanly toward `/CRDT`? (Recommend: error-cleanly for all in 6-2; tunnel only
   remote-WHOIS if ops demand it — it's the only user-facing one.)
4. **Hybrid capability:** after 6-4, do CRDT nodes KEEP dormant P10 Connect blocks as a
   break-glass fallback (config present, autoconnect off), or go pure-overlay? Break-glass keeps
   `check_loop_and_lh`/burst code load-bearing forever; pure-overlay simplifies but makes
   rollback a config exercise.
5. **Tier C gate:** roadmap says MR-6 is "gated on Tier C completeness". F4 RENAME is blocked on
   services integration; F5 ephemeral notices are unbuilt. Hard gate, or waive F4 (accept RENAME
   degraded network-wide) and fold F5 into 6-2's carrier sweep?
6. **SETTIME:** build the priority CR tunnel scoped at MR-5, or declare it dead under
   HLC+NTP/`FEAT_RELIABLE_CLOCK`? (Recommend: dead + clean error; a clock-adjust control message
   over the clock-dependent transport is the layering inversion the SETTIME scope-out already
   named.)
7. **AC U LOGOUT direction** (deferred 2026-07-29 as destructive-on-lag): MR-6 makes the tree AC
   the last carrier — decide the doc-driven logout design (tombstone the account field with a
   grace window?) or accept logout-divergence-until-reconnect.
8. **Gateway HA bar (6-4):** is automatic standby promotion (MR-4d-3) a hard MR-6 exit
   criterion, or is "manual gateway restart, mesh keeps running degraded" acceptable for the
   first endgame gate?
9. **Bed shape for 6-1:** convert nef7 (recommended — every recent gate already targets it) or
   a less-loaded pair first (nef6↔nef4)?

## 6. Explicitly OUT of MR-6 scope

Full wire-protocol replacement (CR keeps riding P10 framing; YXX numerics kept — R0); services
folded into the IRCd (`project_x3_nefarious_merge` — the gateway bridges x3 indefinitely; do NOT
plan X3-as-CRDT-peer); path-vector routing (invariant 10 / R4 spike verdict); legacy peers ever
speaking CR (gateway is the boundary); prod-fork (`nefarious`) cherry-picks.

---

## Execution log

### 2026-07-29 — MR-6-0 SHIPPED + GATED (`1d3a012`)

6-0a (establish parity): `mr_crdtmesh` tail now `crdt_shadow_beacon_burst(cptr)` before the
CR S pull (both sides run it).  GATE: at the CRDTMESH handshake on nef7↔nef6, the wire shows the
immediate CR H burst (self-beacon + fresh far-server replays) — no more 30s blind window.
No unsolicited CR F (deliberate): bidirectional CR S pull + Fix-A escalation covers it.

6-0b (operability): `/CRDT link <server>` forces an overlay (re)connect — try_connections-style
dedupe (live/in-progress overlay scan), backoff cancel, connect_overlay.  GATE: killed overlay
forced back up in SECONDS vs the 10-min cycle.  Learned along the way: a half-dead overlay
Client blocks the dedupe until reaped (read-error/probe), so "link refused: already
up/connecting" right after a kill is CORRECT behavior, not a bug — retry after the reap.

Fleet note: nefarious3-7 share ONE compose image — any `--build nefariousN` updates all five
services' image and the next `up -d` recreates the whole fleet (+ prod/x3 when their images
drifted).  Explains every uniform-binary observation; plan waves accordingly.

NEXT: 6-1 (nef7 drops its last P10 link behind FEAT_CRDT_OVERLAY_PRIMARY) — but first the §5
user decisions, esp. #9 (bed shape) which 6-1 consumes directly.

### 2026-07-29 — MR-6-1 execution: cold-boot GREEN; battery findings

Cutover shipped: FEAT_CRDT_OVERLAY_PRIMARY (decl+reg+status render + §2.8 <2-edge guard in the
verify cycle); ircd7 leaf3 P10→crdtmesh overlay + FEAT on; ircd5 leaf5 P10-passive→crdtmesh
passive.  TWO self-inflicted boot crashes en route, both classic: F_B registration order must
match the enum (features[] boot assert — took the whole fleet down via the shared image), and
config Class{} must precede the Connect that references it (nef7 exit 7).  Fleet-wide outage
~25 min; both fixed.

COLD-BOOT GATE GREEN: nef7 booted with ZERO P10 links, 3 overlay edges (incl. the new leaf3
edge), full materialize from doc alone (5 users/3 channels/0 gaps, drained from 8 within ~90s),
redundancy guard quiet at 3 edges (and correctly ALARMING during link-up), /CRDT status renders
OVERLAY-PRIMARY.

BATTERY FINDINGS (the point of the battery):
1. **sasl cap silently un-advertised on the overlay-only node** (nef5 offered it; nef7 didn't):
   `sasl_server_available`'s tail is IsServer-exact (`find_match_server`) — x3 is an ANCHOR on
   nef7.  Scoped risk #2 (anchors-as-steady-state exposing IsServer-exact branches) arriving in
   phase 1, not 6-2.  FIXED: mesh-anchor branch (FindClient + IsMeshStub + crdt_server_is_mesh_only
   + FEAT_CRDT_SERVICES_BRIDGE) in m_cap.c; the `"*"` wildcard branch (UserStats.servers) left
   IsServer-exact → 6-2 sweep item.
2. Status census on an overlay-primary node reads `0 crdt, 0 legacy, 1 stub; partitioned=YES` —
   the partition heuristic (crdt_have_mesh_stub) and server counts need re-basing for
   anchors-as-steady-state.  6-2 item, cosmetic-but-misleading.
3. Post-registration AuthServ AUTH does not alias-attach (attach decision runs at register_user)
   — not a bug, but battery scripts must use SASL like real bouncer clients.

### 2026-07-29 (cont) — MR-6-1 battery GREEN, code committed (`6b79a41`)

- sasl fix two-parted: the anchor-aware availability branch (code) AND
  `SASL_DEFAULT_MECHANISMS = "PLAIN"` on nef7 (config) — X3's dynamic mech broadcast is P10-only
  and can never reach an overlay-only node; the static fallback is the documented legacy path.
  Mech-list-into-the-doc queued as a 6-2 carrier item.
- ALIAS E2E GREEN over zero-P10: SASL 903 (CR-X), registered as the primary's nick,
  `BOUNCER ALIAS_ATTACHED ... as alias on leaf5`.
- Held-primary residue exercised the full pipeline live: umode mat-gap on consumers →
  owner-sweep reaped the orphan record (~3 min) → consumers de-materialized → fleet quiet.
  No new bug; the machinery composes.
- CH-federation battery leg NOT re-run to completion (probe harness stalled at registration on
  a CAP-REQ non-SASL path; server-side auth completed — looks like probe CAP-flow, not server;
  identical clients registered fine all day).  Prior coverage: 5-5f Phase B gated this axis.
  Re-run during the 24h soak.
- REMAINING for 6-1 CLOSE: 24h soak (0 crashes/valgrind, mat-check quiet), CH re-run, then the
  standing regression battery items (WALL*, GLINE cutover, CI) as soak spot-checks.

SOAK RESTARTED 2026-07-29 19:25 UTC on the crash-fix binary (ircd.202607291925, all 5 nodes) —
the 6-2 audit found a REACHABLE UAF (ms_squit exit_client on an anchor) before the first soak
was 90 min old, so it was fixed + redeployed rather than soaking a binary we knew was wrong.
Exit check due ~2026-07-30 19:25 UTC.  Superseded baseline below (kept for the record):

SOAK STARTED 2026-07-29 ~18:05 UTC (nef7/nef5 boot; nef3/4/6 18:12) — baseline: all running,
fleet mat-check 0, valgrind clean.  Exit check due ~2026-07-30 18:00 UTC: zero crashes/restarts
(compare StartedAt), valgrind zero invalid accesses on nef7, mat-check quiet, no BELOW-REDUNDANCY
alarms, + the CH federation re-run.  A session-length anomaly monitor runs while the driving
session lives; across sessions, verify via `docker inspect StartedAt` against these baselines.

## §5 decisions — user rulings 2026-07-29

- **#9 bed shape: nef7** (done — 6-1 shipped against it).
- **#4 hybrid capability: PURE OVERLAY, apart from the gateway.** CRDT nodes keep NO dormant
  break-glass P10 Connect blocks; only the gateway retains P10 (to legacy/.2/upstream/x3).
  Consequence: rollback is a config exercise, and `check_loop_and_lh`/BURST paths stop being
  load-bearing between CRDT peers at 6-4 — treat their retirement as in-scope cleanup, and make
  the §2.8 overlay-redundancy guard a HARD precondition (no P10 safety net left).
- **#5 Tier C gate: UNSURE — left open.** Revisit before 6-4; F4 RENAME is blocked on services
  regardless, so the practical question is only whether F5 hard-gates the endgame.
- **#7 AC U LOGOUT: NEEDS DOING.** Design + implement the doc-driven logout (the direction
  deliberately not driven since 2026-07-29 because `ms_account 'U'` destroys sessions + clears
  metadata on a possibly-lagging doc read). Schedule: before 6-4 (at MR-6 the tree AC is the
  last carrier); candidate design = tombstone the account field with a grace window +
  MyConnect/ownership gating, mirroring the derived-state lesson (drive the real handler, don't
  hand-roll state).
- **#8 gateway HA: NOT a hard exit criterion for the first 6-4 gate.** Valuable, but sequenced
  AFTER the rest is proven; first endgame gate may accept "manual gateway restart, mesh keeps
  running degraded". Keep MR-4d-3 code in place; the 2-gateway live test moves to a follow-on.

CH FEDERATION SOAK LEG — GREEN 2026-07-29 15:05 EDT: message written on the gateway (nef3,
#chfed) retrieved via `CHATHISTORY LATEST` on the OVERLAY-ONLY node (nef7), zero P10 links.
Both earlier "failures" were probe bugs, not server: (1) CAP-flow ordering, (2) **message tags
shift field indices** — a `@time=...` prefix makes p[1] the source, not the numeric, so the
probe never saw its own 001.  Tag-aware splitting is mandatory in any probe that enables
server-time (scratchpad chfed3.py is the reference).  6-1 exit now needs only the 24h soak.
