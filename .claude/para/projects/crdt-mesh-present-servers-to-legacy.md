# CRDT-Mesh "B0 / MR-3d" — present mesh servers to legacy (natural services-reply routing)

> **★ DONE + LIVE-VALIDATED 2026-06-18 (submodule `e5cd75c`, crdt-mesh). B2 LOC done with it.**
> Source-grounded design (Plan agent @ `5e1f5dd`, 2026-06-18; user-confirmed direction). The clean
> foundation that makes services-reply routing (SASL, LOC, any X3 P10 flow) just normal P10 routing,
> REMOVING the per-subsystem reverse-routing hacks. Landed BEFORE B2 LOC; retroactively simplified B1.
> Companion: `crdt-mesh-services-bridge.md`, `crdt-mesh-mr3-legacy-presence.md`.
>
> **What shipped (vs the plan below):** S1 sweep = `crdt_present_one` / `crdt_shadow_present_mesh_servers`
> (verify timer, before reconcile) + `crdt_shadow_present_one_num` (CR-H ingest fast path, m_crdt.c) —
> reuses R6c `crdt_present_stub`/`make_anchor` wholesale; only the beacon-driven trigger is new. S3 LOC
> reverse = the one-liner at m_account.c (type-A/D `!IsMe` branch → `crdt_route_services_reply_try`). PLUS
> two things the plan under-scoped: (a) the LOC **forward** also needs tunneling — `loc_forward()` in
> s_auth.c (3 PASS-LOC sites, explicit NumNick numerics); (b) **ms_account needed the same IsMe relaxation
> as B1's ms_sasl** — the leaf re-inject runs `ms_account(&me,&me,…)` and the `if(!IsServer(sptr))
> protocol_violation("ACCOUNT from non-server")` guard rejected it (THE bug live-testing caught; the LOC
> analog of B1 correction #3). S4 (remove SASL token-mismatch fallback) DEFERRED 1 release (risk #5);
> validation confirmed SASL now uses the clean owner-path so it's dead-but-safe. EXTENDED_ACCOUNTS=TRUE
> required on the leaf to trigger PASS-LOC (`PASS :/account/password`). **Validated:** sweep presents
> user-less leaf4+leaf5, legacy ACCEPTS the J10 anchors, `PASS :/testadmin/testadmin123` on nef7 → logged
> in sub-second over the retired tree (x3 replied to :leaf5), B1 SASL still PASS, 0 crashes.

## The core insight

X3 sources its replies to whatever server sourced the forward (LOC: `proto-p10.c:1694` `server->numeric`;
SASL: `:1298` `dest->numeric`). Today the gateway re-emits a leaf's services-forward as `:gateway` (because
x3 doesn't know the leaf), so x3 replies to the gateway with no origin → forces the SASL token-mismatch
fallback + blocks LOC (the `.fd.cookie` token carries no origin, `m_account.c:117`). **If the gateway
PRESENTS the originating leaf to legacy as a P10 server** (R6c's `crdt_present_stub` already does exactly
this), the gateway re-emits preserving `:leaf` as source, x3 replies to `<leafYXX>`, which P10-routes to the
gateway, which tunnels CR-X to the leaf. **No token parsing, no per-subsystem reverse hook, no LOC state map.**

## Design decisions

- **Presentation scope = PROACTIVE beacon-driven sweep** (NOT on-demand). LOC's `FEAT_LOC_TIMEOUT=3` rules out
  on-demand (presenting a server mid-handshake races the 3s budget). The gateway presents ALL beacon-known
  mesh servers up front, so x3 already knows every leaf when the first forward arrives.
  - The gap today: `crdt_present_stub` only fires from `convert_to_stub` (Case A) / `make_anchor` (Case B),
    which only run for a server the gateway materialized a USER for. A beacon-known leaf with no materialized
    user is never presented → `FindNServer(<leaf>)` NULL on the gateway → `crdt_services_reemit` falls back to
    `src=&me`. The fix = a beacon-driven sweep that presents every fresh mesh server.
- **General reverse rule (subsumes all 3 hooks):** a P10 message arriving at the gateway destined for a
  presented mesh server (`IsMeshStub && IsPresented`) / a user homed on one → tunnel CR-X, don't P10-send.
  This IS `crdt_route_services_reply_try` (already exists, keys on `IsMeshStub`). It REPLACES: the SASL
  token-mismatch fallback (`m_sasl.c:174-186` + `crdt_route_services_reply_by_num` → DELETE) and the LOC
  state-map idea (DROP — never needed). One call at each per-command reverse forward point (SASL `m_sasl.c:162`
  already there; LOC `m_account.c:362` add it).
- **Forward simplification (mostly free):** the CR-X arm already resolves `ssrv=FindNServer(srcyxx)` + passes
  it to `crdt_services_reemit` (which prefers it over `&me`). It fell back to `&me` only because the leaf
  wasn't presented (FindNServer NULL). Once presented, it re-emits `:leaf` automatically. No forward code
  change beyond the sweep.
- **Flag = reuse `FEAT_CRDT_LEGACY_PRESENCE`** (symmetric counterpart of MR-3's proxy-beacon; default off).
  No new flag. Keep `FEAT_CRDT_SERVICES_BRIDGE` (tunnels) + `FEAT_CRDT_GATEWAY_BRIDGE` (P10 re-emit).

## No conflict with MR-5/MR-3/R6c
- MR-5 suppression is CRDT-both-ends (`crdt_should_suppress_tree`: peer+subj both IsCrdtAware) → never fires
  toward legacy. MR-5 is the REASON this is needed (once it retires the CRDT-server P10 intros among CRDT
  peers, explicit presentation is the only way legacy learns the leaf).
- MR-3 is the mirror (gateway proxy-beacons legacy INTO the mesh; this presents CRDT servers OUT). Hazard:
  the sweep MUST skip proxied/`fronted_by` beacon rows (never re-present a legacy-fronted anchor toward legacy).
- Reuse `crdt_present_stub` wholesale (emits the legacy-only SERVER intro, flips FLAG_CRDT_PRESENTED, forces
  IPv6). SQUIT/retire already handled: `crdt_shadow_retire_mesh_stub` (`s_misc.c:795`) emits the one legacy
  SQUIT for a presented stub on staleness/relink. Only the TRIGGER (sweep) is new.

## Sub-steps
1. **S1 (core):** new `crdt_shadow_present_mesh_servers()` (crdt_shadow.c) — iterate `crdt_beacon[]`; for each
   fresh, non-self, non-proxied row: `FindNServer(num)` → NULL? `make_anchor` (calls present_stub); a
   non-presented stub? `crdt_present_stub`; a real STAT_SERVER? **do nothing** (legacy knows it; presenting
   would duplicate-server). Gate `FEAT_CRDT_LEGACY_PRESENCE` + `crdt_gateway_has_legacy_peer()`. Call from the
   verify timer (backstop) + the CR-H ingest in `ms_crdt` (promptness vs the 3s LOC budget).
2. **S2:** verify the forward now re-emits `:leaf` (FindNServer(srcyxx) non-NULL); add a "presentation gap"
   log if ssrv NULL while the bridge is on. Likely no code.
3. **S3:** add `crdt_route_services_reply_try(acptr,'C',body)` before the P10 send at `m_account.c:362` (LOC
   reverse). Confirm `crdt_services_reinject case 'C'` → `ms_account` → `decode_auth_id(.fd.cookie)` resolves
   the leaf's local client. Body shape `<leafYXX> A .fd.cookie :account` (verbatim dumb-pipe).
4. **S4:** remove the SASL token-mismatch fallback (`m_sasl.c:174-186` + `crdt_route_services_reply_by_num`),
   now dead (the normal `!IsMe(acptr)` branch handles it). Optional: keep behind a transitional flag 1 release.
5. **S5:** audit retire — sweep-presented stubs (0 held users) still retire via the staleness sweep w/ the one
   legacy SQUIT. Verify-only.
6. **S6 cmocka:** sweep eligibility truth table; reverse-rule predicate (presented stub→tunnel, real→P10);
   LOC reverse body round-trip (dumb-pipe invariant); idempotent presentation.
7. **S7 live-validate** (recipe below).

## Live-validation (LOC)
Far leaf nef7 (x3 a mesh anchor). Set `FEAT_CRDT_LEGACY_PRESENCE`+`SERVICES_BRIDGE`+`GATEWAY_BRIDGE`=TRUE on
leaf+gateway (validate with TREE_RETIRE both off AND on — on is the true target). (1) presence: x3 `/LINKS`
shows the leaf behind the gateway; gateway `FindNServer(leafYXX)` = presented STAT_MESH_SERVER; SERVER intro
crossed gateway→legacy, NOT any CR link. (2) LOC: a fresh client on nef7 sends `PASS AuthServ testadmin
testadmin123` → forward CR-X `'C'` → gateway re-emits `:leaf ACCOUNT x3 C .fd.cookie ...` → x3 replies
`:x3 ACCOUNT <leafYXX> A .fd.cookie :<ts>` → gateway tunnels CR-X → leaf `ms_account`/`decode_auth_id` →
**client logged in as testadmin within 3s**, 0 crashes. (3) retire: SQUIT the leaf → one legacy SQUIT, x3
drops the subtree, no ghost. (4) regression: re-run B1 SASL (token-mismatch removed) → still PASSES via the
normal reverse branch.

## Risks
1. Churn (present-all): bounded by mesh size not traffic; SERVER/SQUIT per membership change; staleness window
   debounces; add present-hysteresis if needed.
2. Multi-gateway duplicate presentation / legacy loop: post-MR-5 territory (legacy_net_id + should_standby);
   single-gateway-safe via `crdt_gateway_has_legacy_peer()` now.
3. Presenting a numeric that's still a real STAT_SERVER → duplicate-server: the "do nothing if real" clause.
4. 3s LOC budget: proactive removes presentation from the critical path; only the CR round-trip remains (~0.1s
   in B1). Validate end-to-end latency.
5. Cutover dead-code (removing token-mismatch mid-rollout): keep `reply_by_num` 1 transitional release.

## Phase placement
B0 / MR-3d (MR-3's missing OUT direction) → simplify B1 (remove token-mismatch) → B2 LOC (one-line). Then the
rest of the priority scale (Tier C: bouncer/CH/multiline/REDACT/OPER).
