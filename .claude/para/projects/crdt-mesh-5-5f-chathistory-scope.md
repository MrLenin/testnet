# Chathistory federation — scoping (mixed-bed interop + 5-5f mesh transport)

**Status:** SCOPED 2026-07-26; **Phase A VOID** (disproven by instrumentation — see memory
`project_chathistory_federation_gap.md`: discovery works, the red tests were test-env
artifacts); **Phase 0 IMPLEMENTED 2026-07-27** (mixed-bed interop, below). B1–B3 open.
**Supersedes:** the 5-5c band-aid contract in `3cd3861` (partially — see Phase 0).
**Companion (OUT OF SCOPE, deferred):** the bloom-filter channel-ad optimization in
`federation-dedup-s2s-msgid.md`.

---

## TL;DR

- **(A) prod-fork federation discovery bug — VOID.** The "server_ads[] stays empty on a
  late-linker" hypothesis was disproven live: ads land, discovery works, 7/7 tests pass
  native+isolated. The 5 red tests were (1) CRDT-bed pollution + (2) valgrind slowness
  vs the 5s fed timeout. Do not implement the EOB ad-replay; nothing is broken there.
- **(Phase 0) mixed-bed interop — IMPLEMENTED 2026-07-27.** Root cause of the "CRDT-bed
  pollution": mesh nodes advertise CH A S into legacy `server_ads[]` (via the gateway),
  legacy dutifully queries them, and the query dies inside the mesh node — on a
  CR-snapshot link the legacy net-burst is suppressed, so legacy servers exist on inner
  mesh nodes only as lazily-minted synthetic anchors (`STAT_MESH_SERVER`), and
  `ms_chathistory`'s `!IsServer(sptr)` gate silently discarded anchor-sourced queries
  (hard-invariant 2, handler-side). Three fixes (see "Phase 0 as-built" below):
  source gate accepts stubs, replies route via the arrival link when the origin is
  anchored, and reqid-prefix reply forwarding added on BOTH branches — the prod fork
  could never traverse >1 hop either (replies were dropped at the first intermediate;
  masked because the tests only ever used a directly-linked pair).
- **(B) 5-5f: chathistory over the retired P10 tree** — CH Q/reply are tree-routed
  `sendcmdto_one`, so they dead-sink at mesh anchors, and overlay-only nodes (nef7)
  never hear ads at all. Under R6a tree-demote there is exactly ONE stored copy
  network-wide (the origin's), so the witness redundancy that used to mask federation
  gaps is gone → permanent history holes. A MR-6 gate. **Phase B = B1 → B2 → B3.**

Ship order: **Phase 0 (done) → B1 → B2 → B3.**

## Phase 0 as-built (2026-07-27)

Files: `m_chathistory.c` on BOTH `nefarious-crdt` (crdt-mesh) and `nefarious`
(ircv3.2-hardening); testnet `tests/src/helpers/ircv3-client.ts` + `data/ircd{,2}.conf`.

1. **Source gate (crdt only):** `ms_chathistory` entry accepts `IsServer || IsMeshStub`.
2. **`ch_fed_reply_target()` (crdt only):** replies for a query whose origin resolves to
   a stub/anchor (dead-sink `cli_from`) are routed via `cptr` — the link the query
   arrived on, i.e. the P10 path the query itself took. B3's CR tunnel replaces this.
3. **`forward_fed_reply()` (BOTH branches):** R/B/Z/T/E receive branches forward
   non-local reqids hop-by-hop toward `FindNServer(reqid[0..1])` (reqid =
   `<yy><counter>`), rebuilding the frame faithfully (only the trailing param can hold
   spaces). Drops when origin is unknown/local(stale)/anchored or the send would bounce
   back out the arrival link (loop guard). This is what lets a reply cross
   nef5 → hub2 → primary → secondary.
4. **Test infra:** SECONDARY_SERVER default derives from how the primary is addressed
   (host run → localhost:6668) so host runs can never silently all-skip again;
   `CHATHISTORY_TIMEOUT` 5→3 on the prod pair so server-side partial completion always
   beats the vitest clients' 5s wait (was a dead heat).

**Phase 0 residue (deliberate, → B3):** the four 5-5c `IsMeshStub` skips STAND — a mesh
node still never *initiates* federation toward an anchored (legacy) storage server.
A Q whose dest resolves to an anchor at a transit node (e.g. the gateway forwarding a
legacy query toward a tree-split mesh node that legacy still counts as a real server)
gets an **`E <reqid> 0` synthesized on the dest's behalf** so the requester's
`servers_pending` completes promptly instead of wedging to the fed timeout — that
tree-split state is routine on this bed. Replies transiting an anchor-only hop are
dropped (rare; requires nested splits). Mesh-originated reads rely on local witness
copies until B1 (storage symmetry) + B3 (CR tunnel) land.

## THE HARD SCALE CONSTRAINT (decides the whole discovery design)

Test churn produces **tens of thousands of channels**. Any discovery scheme that is
**O(#channels)** on the wire is dead on arrival — this is exactly why `CH A F` (the
per-server *full channel list* advertisement: "here are all the channels I have history
for") was **incredibly spammy** and is already disabled in query routing
(m_chathistory.c:3707-3720).

**Rule for all phases: federation discovery is O(#servers), never O(#channels).**

Two discovery layers must never be conflated:
1. **Storage *capability*** (per-server: "S stores history, retention N") — O(#servers),
   tiny. This is ALL that 5-5f discovery carries.
2. **Per-*channel* history-availability** ("S has `#foo`") — O(#channels), the spammy
   `CH A F` layer. **Explicitly OUT OF SCOPE.** Its non-spammy replacement is the deferred
   bloom-filter plan (`CH A B`, a compact fixed-size per-server probe). 5-5f inherits
   today's channel-layer behavior: fan a query to every storage server, empty ones reply
   `CH E 0`. B1 (below) makes that fan-out rare, so the missing bloom filter is a deferred
   optimization for an uncommon path, not a gap.

---

## Current architecture (as-built, file:line anchors on `crdt-mesh`)

All server-side CH machinery is in `ircd/m_chathistory.c` (~5,142 lines). `history.c` =
RocksDB query/store layer; `chathistory_presence.c` = per-anchor presence intervals
(strict-mode replay filter only). Neither touches the wire.

**Storage (who stores a message):** `store_channel_history` (ircd_relay.c:170).
Witness-gated (ircd_relay.c:201-227): a relayed message is stored only if the node has a
local member (or member-alias) in the channel — hubs don't store what they only relay.
Skips: `+P` EXMODE_NOSTORAGE, `REQUIRE_AUTH && authusers==0 && !+H` (REQUIRE_AUTH default
OFF), `+Y` sender → gap marker. `server_relay_channel_message` (ircd_relay.c:864)
preserves the origin server's S2S msgid (unified-msgid `ef81fc9`) so every witnessing
server stores the SAME msgid → exact dedup. Defaults: `CHATHISTORY_STORE` and
`CHATHISTORY_FEDERATION` both TRUE (ircd_features.c:1232/1235) → every CRDT node stores +
federates.

**Advertisement (capability):** `m_endburst.c:207-220` — on a direct peer's END_OF_BURST
(`MyConnect(sptr)`), send `CH A S <retention>` + `send_channel_advertisements` (CH A F),
gated `CHATHISTORY_STORE && IsIRCv3Aware(sptr)`. EOB IS still sent on CRDT cutover links
(s_serv.c:377-379 after the CR F snapshot). Receipt: `ms_chathistory` "A" handler
(m_chathistory.c:4850) fills `server_ads[numeric]` (struct ChathistoryAd) and propagates
`sendcmdto_serv_butone_v3`. **CH A F channel-list filter is disabled in routing**
(:3707-3720) — every storage peer is queried, empties return `CH E 0`.

**Query → federation (client read):** `chathistory_latest`/BEFORE/AFTER/AROUND (:1388…)
→ `should_federate` (:1205, channel + FEAT + `local_count < limit`) → `start_fed_query`
(:3742): `count_storage_servers` (:3668) walks `server_ads[]` skipping self, **IsMeshStub
(5-5c :3696)**, U-lined, retention-not-covering; 0 ⇒ NULL ⇒ local-only reply. Else a
FedRequest slot (`MAX_FED_REQUESTS`), `servers_pending = count`, 5s timer, dispatch loop
(:3838-3872) sends `CH Q <target> <L|B|A|R|W|X> <sel> <limit> <reqid> <dest_yxx>` via
`sendcmdto_one` (tree-routed). `reqid` = origin `<yxx><counter>` (:3797), so reply routing
is derivable from it.

**Server side (`ms_chathistory` :4408):** `Q` :4425 multi-hop by dest_numeric (forward if
not-for-us :4450; legacy-propagate to advertised direct links if no dest :4467). Local
RocksDB query → `send_ch_response` (`CH R` plain / `CH B` base64-chunked / `CH Z` zstd)
then `CH E <reqid> <count>`. Replies accumulate into `find_fed_request(reqid)` (unknown
reqid → dropped); `CH E` decrements `servers_pending`; at ≤0 → `complete_fed_request`
(:3579) → `merge_messages` (:3481, msgid-exact + semantic dedup, chronological) →
`presence_filter_and_replay`. 5s timeout completes partial.

**Write-forward (non-STORE nodes):** `forward_history_write` (:2614) → FIRST direct P10
downlink with a storage ad (:2662-2678, direct links only, no mesh awareness). PM history
is NEVER federated — write-forwarded instead; PM CH Q returns `E 0` (:4552).

**Bouncer auto-replay fed:** `chathistory_auto_replay_fed` (:4363) → per-channel local-else
`CH Q L *` fan-out (IsMeshStub skip :4278). **Federated REDACT:** `CH Q X` exact-msgid then
`complete_redact_fed` (:3899) — same transport, same gap.

**5-5c band-aid (`3cd3861`, +19 lines):** skips `IsMeshStub` servers in
`count_storage_servers` AND all three dispatch loops in lockstep (so `servers_pending`
matches dispatch — before it, an unreachable-but-counted anchor wedged every FedRequest to
the 5s timeout). After it: requests complete promptly but **knowingly exclude anchored
stores**. Commit contract: *"5-5f replaces these skips with a CR carrier that tunnels CH Q/
reply toward the anchored storage owner."*

---

## Phase A — prod-fork federation discovery fix (the 5 red tests)

**Root cause (now confirmed from code, was a standing hypothesis):** `server_ads[]` is
empty on any server that linked *after* a storage server advertised. `CH A S` fires ONCE,
at a direct peer's EOB (m_endburst.c:214); there is **no burst-time replay of third-party
ads** and ads are **never persisted**. So a server that links later learns only its direct
peer's own ad + subsequent live propagations — never the ads that were broadcast before it
linked. In the tests the secondary client JOINs the channel only at query time (no
secondary-local member at message time → P10 never delivered the PRIVMSG there, and the
witness gate wouldn't store it anyway), so federation is the ONLY read path and an empty
`server_ads[]` ⇒ `count_storage_servers()==0` ⇒ `start_fed_query` returns NULL ⇒ immediate
empty batch = the observed "secondary returns 0".

The 2 passing tests corroborate: *netsplit-availability* queries the PRIMARY only (local,
never federates); *retrieves-via-federation* has soft-skip early returns.

**Fix:** on receiving a direct peer's EOB, **replay the storage-capability ads we already
know** to that peer — our own (as today) PLUS the still-present third-party entries in
`server_ads[]` (each server whose `FindNServer` resolves) as `CH A S`/`CH R`-style
capability lines. A late-linker then learns the full storage-capability map. Bounded by
#servers (O(#servers), never touches channel lists — respects the scale rule). Idempotent
(receipt just refreshes `server_ads[numeric]`).

**Secondary hardening (only if the replay alone doesn't green all 5):** persist `server_ads`
capability across the link so a re-link doesn't blank it; SQUIT-cleanup stale entries.
Decide after measuring — the replay is the primary fix.

**Files:** m_chathistory.c (EOB ad-replay helper + the `send_channel_advertisements`
neighborhood), m_endburst.c (call site). **Tests:** the existing
`tests/src/ircv3/chathistory-federation.test.ts` suite is the gate (5 red → green); no new
test files (fix the server, per `feedback_no_test_changes`). **Size: S.** **Risk: LOW** —
additive replay, prod-fork, no mesh interaction. Ships to the prod fork too (the bug is
prod-fork; the crdt branch inherits it).

---

## Phase B — 5-5f: chathistory over the retired tree

Three sub-phases, individually correct and de-risking each other. Recommended in full over
the B3-only band-aid: B3 without B2 still leaves overlay-only nodes blind, and B1 removes
federation from the steady-state critical path for the least code.

### B1 — restore witness-store on the CR-M delivery path (survey Option 3)

**✅ IMPLEMENTED 2026-07-27 (`b05982e`).** As scoped: `store_channel_history` exported
(ircd_relay.h, gates travel with it), CR-M P/N first-arrival store inside the chan_local
dedup, origin msgid off the frame, arrival-time timestamp (server-relay parity), TAGMSG +
mesh-stub sources skipped (a stub's MyConnect is true → would defeat the local-interest
gate). Live gate: nef3→nef5 CR-M delivery (untagged prefixes, tree suppressed), local
CHATHISTORY limit==count returned all origin-msgid'd messages in 176ms, ZERO CH Q.
Runtime note: only nef5 runs the B1 binary until the next bed-wide roll; the committed
image is uniform.

**Problem:** under R6a tree-demote the tree relay to CRDT peers is suppressed
(ircd_relay.c:935-947); remote copies arrive via `crdt_gossip_message('P'…)` and the CR-M
channel-delivery block (m_crdt.c:875-901) delivers to local members via `sendrawto_one` and
**never stores**. So mesh steady state = exactly ONE stored copy (the origin's). The
multi-witness redundancy that made federation a rare fallback is gone.

**Fix:** in the CR-M channel-delivery block, when we deliver to ≥1 local member, **store**
the message with the SAME witness semantics as the tree path — factor `store_channel_history`
out of ircd_relay.c static scope; honor `+P`/REQUIRE_AUTH/`+Y`/client-tags-sentinel gates;
the origin msgid is already on the CR-M frame; `crdt_shadow_chan_local_check_add` already
dedups tree-vs-mesh double-arrival, so storage stays single-copy-per-node with a
network-consistent msgid. Restores pre-mesh storage symmetry → steady-state cross-node
reads resolve LOCALLY (no federation, no fan-out).

**Files:** m_crdt.c (~50-80 lines), ircd_relay.c + history.h (de-static + prototype).
**Tests:** cmocka not applicable (integration path); LIVE gate — message sent on nef3,
confirm it is stored + locally queryable on a mesh peer that has a member, without any CH Q.
**Size: S.** **Risk: LOW-MEDIUM** — storage-volume returns to pre-mesh status quo (every
witnessing node stores again); MUST gate on actual local delivery (never store on a
mesh-stub-only relay hop). Does NOT fix discovery — a complement, not standalone.

### B2 — mesh-native storage-capability discovery (survey Option 2, discovery half)

**Problem:** CH A S/R travel P10 only. Overlay-only nef7 has no P10 links → never
advertises, never hears ads → `server_ads[]` empty → federation never STARTS on it, and its
store is invisible. Post-MR-6 there is no EOB to hang CH A S on at all.

**Fix:** a small **per-server** doc collection `CRDT_COLL_CH_STORAGE` — one LWW register per
server: `{stores: bool, retention: u32}` (+ maybe last-update). **O(#servers), never
per-channel** (the scale rule — this is capability, layer 1, NOT CH A F). Converges
everywhere incl. overlay-only, survives churn, needs no EOB. `server_ads[]` becomes
dual-populated (legacy CH A S via the tree/gateway + doc via the mesh) → apply the CRDT hard
lessons: wire into the m_crdt.c **EAGER-delta reconcile suite** (F3 lesson — else 30s-tick
convergence races live gates) and reap on **explicit tombstone, never doc-absence** (F2-c
lesson — data-loss window). A server mints its own capability on shadow-init / feature
change; the reconcile materializes doc entries into `server_ads[]` (or a thin accessor) for
peers not learned via P10.

**Files:** crdt engine (crdt_state.h/.c collection + digest salt + snapshot wire, following
the decommission/tempshun template), crdt_shadow.c (mint on init, reconcile → server_ads),
m_crdt.c (eager reconcile call), m_chathistory.c (accessor swap so `count_storage_servers`
sees doc-learned servers). **Tests:** cmocka (collection replication + reconcile);
LIVE — nef7 learns nef3 stores + issues a federated query it could not before. **Size: M.**
**Risk: MEDIUM-HIGH** but pays down the whole discovery debt; the right shape for the MR-6
endgame.

### B3 — CR tunnel for CH Q / reply (survey Option 1; the 5-5c contract)

**Problem:** `CH Q`/replies are targeted `sendcmdto_one` → dead-sink at a STAT_MESH_SERVER
anchor. The four `IsMeshStub` skips are the band-aid; anchored stores are excluded.

**Fix:** tunnel the CH query/reply payloads in a routed CR frame toward the storage owner.
Reuse the CR-M unicast machinery (`M <msgid> <cmd> <src> <target> <ttl> :<text>` already
does msgid-deduped next-hop routing via `crdt_route_unicast_try`) with a CH sub-carrier, OR
new CR-X bridge cases that re-invoke `ms_chathistory(&me,…)` locally (the dormant XQ/XR
pattern, m_crdt.c:549-554). **Replace the four `IsMeshStub` skips with tunnel-dispatch that
STILL counts in `servers_pending`** (the 5-5c invariant — a tunneled query that can't route
must decrement pending or the wedge returns). Replies tunnel back keyed by reqid (origin
numeric is the reqid prefix → route derivable). 512b framing: CH R/B/Z chunking already
exists; nest carefully (don't double-inflate the body — the 512 cap is immutable).

**Files:** m_chathistory.c (4 dispatch sites + a tunnel reply-send helper +
`servers_pending` accounting), m_crdt.c (~150-250 lines: sub-carrier cases, forward,
re-dispatch). **Tests:** cmocka for the framing/routing helpers; LIVE — a node with NO
local copy federates a query THROUGH an anchor to the real storage owner and gets the
history back. **Size: M.** **Risk: MEDIUM** — reply-loss accounting, nested chunk framing,
double-delivery if both P10 and overlay paths exist (msgid-dedup covers CR-M but a
CH-in-CR wrapper must reuse it).

**B3-gateway slice (user directive 2026-07-27: "the gateway should relay the real
responses if it can, instead of just saying there's nothing").** The Phase-0 `E 0` synth
at the gateway's Q-forward is availability-only; the ideal is real answers.

> ### ⛔ IMPLEMENTED 2026-07-27 BUT **NO LIVE TRIGGER — BLOCKED ON B2**
>
> **The "shippable before B2" premise below is DISPROVEN.** It assumed legacy keeps
> serving ads that crossed before a node became anchored. It does not:
> `exit_one_client` calls **`clear_server_ad(bcptr)` (s_misc.c:319)** for every
> server that exits, so the instant a node leaves the tree — SQUIT, split, or the
> R6c stub conversion — *every* node that observes the exit forgets it stores
> history. An ad is only (re)created by a `CH A S` at EOB over a **real P10 link**,
> which an anchored/overlay-only node by definition never has.
>
> Therefore: **no requester ever dispatches a CH Q whose dest is a mesh stub**, so
> neither the B3 tunnel *nor* the Phase-0 `E 0` synth can fire. Both are correct
> defensive code on an unreachable path until discovery can advertise a node that
> has no P10 link — which **is exactly B2**.
>
> Live-gate attempts (both correctly FAILED, 0/3, and diagnosed rather than
> massaged): SQUIT leaf2 @ hub2 → primary held no AE ad at all; SQUIT leaf3 @ hub2
> → primary *had* AG's ad, hub2 converted to stub and re-presented via R6c, but the
> propagated SQUIT cleared AG at the primary first, so the re-query dispatched only
> to AC/AD. Ads are also empirically **patchy** across restarts (leaf2 advertised on
> the secondary in the Phase-0 run, absent on the primary later) — another thing a
> doc-based capability collection fixes by construction.
>
> **Revised order: B2 → (re-gate B3-gateway) → B3-full.** The code below is committed
> but must be treated as UNVERIFIED until B2 gives it a trigger; gate it as part of B2.
>
> **Also fold into B2 — the reply-direction asymmetry** (found 2026-07-27 reviewing the
> hardening→crdt-mesh merge): the B3 slice made the QUERY direction tunnel to an anchored
> counterpart, but `forward_fed_reply` still *drops* a reply whose origin resolves to a
> mesh anchor (its `!IsServer(origin)` test). Two halves of one feature now disagree. The
> completion is to call `crdt_ch_tunnel_try()` there before dropping — deliberately not
> done yet, because it is the same no-live-trigger family as the rest of this box. The
> code comment at `forward_fed_reply` records the asymmetry so it is not mistaken for an
> oversight. Gate it with B2 alongside the tunnel itself.

The gateway transit case as built (implementation is sound; only the trigger is missing):
- Gateway, Q-forward, dest = anchor: instead of synthesizing, wrap the Q in a routed CR
  frame toward the anchored owner (reuse `crdt_route_unicast_try` next-hop routing +
  msgid dedup). If the CR route lookup fails IMMEDIATELY → fall back to the `E 0` synth
  (the 5-5c accounting invariant — never leave pending uncredited). Mid-flight tunnel
  loss falls to the requester's fed timeout (rare: beacon-fresh-but-unroutable).
- Owner: unwrap, run the local query with replies emitted through a tunnel-transport
  variant of `send_ch_response` (re-chunk INSIDE the CR frame budget — never nest a
  full 500-byte CH line in a wrapper; the 512 cap is immutable), tunneled back keyed by
  reqid toward the gateway.
- Gateway: unwrap replies and hand them to the EXISTING P10-side machinery
  (`forward_fed_reply` path resolves the reqid-prefix origin and relays legacy-ward).
- The `E 0` synth STAYS as the permanent fallback layer (unroutable owner, tunnel
  disabled, pre-B3 nodes) — B3 makes it the exception path, not the answer.
Revised ship order option: B1 → B3-gateway-slice → B2 → B3-full (mesh-initiated
federation via the 5-5c skip replacement). B2's legacy-ward capability synth must stay
gated on reachability (tree-resolvable OR tunnel-routable) so legacy is never advertised
a store that only ever answers empty.

---

## Constraints every phase must respect (from memory + the survey)

- **O(#servers) discovery, never O(#channels)** — the scale rule (tens of thousands of
  channels after churn). No per-channel advertising, spammy or otherwise.
- **512-byte P10 body cap is immutable** (`project_s2s_512_compression_rationale`) — growth
  is tag-side / compression (CH Z) / chunking (CH B) only, never body inflation.
- **One msgid per event, carried verbatim** (`feedback_single_msgid`,
  `federation-dedup-s2s-msgid`) — exact dedup depends on the origin-msgid-preserving store;
  any new carrier carries it verbatim. Merge order chronological (IRCv3).
- **Storage consent + witness model intentional** (`project_chathistory_design_intent`) —
  `authusers==0 → no storage` under REQUIRE_AUTH, member-gated default access, strict
  presence is a *replay* filter not a storage gate, `+H` is the public knob. Do not broaden
  storage past these gates.
- **Auto-replay stays bouncer/account-anchored** (`project_chathistory_auto_replay_bouncer_only`).
- **PM history stays on write-forward / consent** — never federated; untouched.
- **CH wire is fork-exclusive → carte-blanche** (`project_chathistory_s2s_tag_migration`) —
  no dual-emit/compat; if B3 re-touches the wire, the compact S2S-tag migration
  (`@A<time_7><msgid_14>` HLC precedent) is the natural companion.
- **CH A F / bloom filter OUT OF SCOPE** — the deferred `federation-dedup-s2s-msgid.md`
  optimization; 5-5f fans out to all storage servers (bounded by #servers), B1 makes that
  rare.

## Non-goals (explicit)

1. Per-channel history advertisement in any form (CH A F resurrection).
2. The bloom-filter query-pruning optimization (separate deferred plan).
3. PM/DM history federation.
4. The compact CH S2S-tag migration (adjacent, optional, only if B3 re-touches the wire).
5. Changing the storage-consent / witness / strict-presence model.

## Open questions for implementation time

- Phase A: does EOB ad-replay alone green all 5 tests, or is `server_ads` persistence +
  SQUIT-cleanup also needed? (Measure; replay is primary.)
- B2: materialize doc capability INTO `server_ads[]`, or add a parallel accessor
  `count_storage_servers` consults? (Prefer the accessor — keeps the legacy table as the
  P10 source of truth, avoids a dual-writer on one struct.)
- B3: reuse CR-M with a CH cmd letter vs. new CR-X bridge cases? (Lean CR-X — CH Q/reply is
  request/response, not the fire-and-forget broadcast CR-M models; and it isolates the
  nested-chunk framing from the live-message path.)
</content>
