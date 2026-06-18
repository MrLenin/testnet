# CRDT-Mesh services-anchor bridge (Tier B) — design + plan

> **★ TIER B EFFECTIVELY CONCLUDED AT B1 (user direction 2026-06-18).** The prod direction is to implement
> account/registration/auth **NATIVELY in Nefarious against Keycloak** (the `SASL_LOCAL` model), NOT to relay
> service protocols to X3 over P10. X3 is unlikely to ever implement REGISTER/VERIFY/REGREPLY (and the rest of
> the X3 P10 service protocols). So bridging those relays to X3 (B2 LOC, B3 REGISTER, B6 XQUERY) is **moot** —
> there's nothing to bridge to. **B1 (SASL bridge) stays as a done+validated piece** useful for any deployment
> still using the X3-relay SASL path (and it proved the CR-X carrier), but the native-Keycloak prod path
> doesn't traverse the mesh to X3 for auth at all (each node authenticates against Keycloak locally). The
> COMMON services reachability over the retired tree already works: SASL (native Keycloak per-node, OR B1's
> bridge for X3-relay) + `PRIVMSG AuthServ`/bot replies (MR-4b). **B7 directed-PM is niche; B2-B6 moot.**
> ⇒ NEXT real work = **Tier C** (bouncer-over-mesh, CH federation, multiline-PM, REDACT, OPER) — un-gated,
> CRDT-mesh-native, prod-relevant — NOT more X3-relay bridging.


> **★ B1 (SASL) DONE + LIVE-VALIDATED 2026-06-18 (submodule `5e1f5dd`).** testadmin SASL PLAIN on nef7
> (`SASL_LOCAL=FALSE` → Path-3; x3 a mesh-only anchor) succeeds end-to-end in 0.1s (903 + 900 logged in),
> wire-traced forward (leaf→gateway→x3) + reverse (x3→gateway→leaf); 5 CRDT + legacy + x3 all 0 crashes.
> CR-X carrier built exactly as designed. **THREE implementation corrections found via live debugging
> (all fixed):** (1) the CR-X frame must carry the **originating server** (`srcSrvYXX`) so the gateway
> re-emits to x3 with that source → x3 replies to the origin, not the gateway. (2) **Gateway-as-proxy
> reverse:** under tree-retirement x3 only knows the gateway, so when the gateway lacks the origin's
> anchor it re-emits with `src=&me` and x3 replies to the GATEWAY — caught at the **token-prefix-mismatch**
> path in `ms_sasl` (route by the token's first-2-char server numeric, `crdt_route_services_reply_by_num`).
> Both reverse paths now exist (the `!IsMe` owner path when the gateway has the anchor + the token-mismatch
> fallback). (3) The leaf re-inject runs `ms_sasl(sptr=&me)`, whose `IsServer(sptr)` guard rejected it →
> relaxed to accept `IsMe` (a mesh-validated local re-injection, unforgeable by a client). **B2-B6 + B7 =
> NEXT (same carrier; sites enumerated below). B7 needs the carrier to also carry a USER source.**


> Source-grounded design (Plan agent @ `82d1a75`, 2026-06-18). Fixes the S2S-audit Tier B class:
> a far CRDT leaf reaches x3.services ONLY as a mesh anchor (dead-sink) — every command TO x3 and
> reply FROM x3 drops. X3 SASL is a non-negotiable prod-blocker. Companion: `crdt-mesh-s2s-gap-audit.md`.

## Mechanism: one new `CR X` sub-code (services-bridge carrier)

The CR-M 'M' carrier is USER-target-addressed (`crdt_route_unicast_try` derefs `cli_user(tgt)`). Services
traffic is SERVER-addressed (forward→x3; reverse→originating leaf). So a NEW sub-code, NOT an 'M' overload.

Wire: `:<src> CR X <msgid> <dstSrvYXX> <p10cmd> <ttl> :<verbatim P10 args>`
- `dstSrvYXX` = 2-char destination SERVER numeric (fwd: x3's; rev: originating leaf's, = the token's first 2 chars / `cli_yxx`).
- `p10cmd` = one letter naming the P10 cmd to re-emit: `A`=SASL `C`=ACCOUNT `G`=REGISTER `V`=VERIFY `R`=REGREPLY `Q`=XQUERY `Y`=XREPLY.
- `:<args>` = the exact param tail of the original `sendcmdto_one`, carried OPAQUELY. **The bridge is a dumb pipe — it never parses auth.**
- Routing = same as `crdt_route_unicast_try` but owner = `dstSrvYXX` directly (no `cli_user` deref): reuse `crdt_meshmap_nexthop` + `crdt_route_action` + `crdt_peer_by_num` + `crdt_m_seen` dedup + MR-4d `crdt_shadow_should_standby` election.

## Stateless (the key simplification)
The `<srvnum>!fd.cookie` SASL token (`m_authenticate.c:283`) already encodes origin server + fd + cookie;
REGISTER/VERIFY/prereg tokens too; LOC uses `.fd.cookie` + server-numeric reverse routing. So:
- Forward: gateway re-emits to x3 with the token verbatim; x3 echoes it. No gateway state.
- Reverse: gateway reads `parv[1]` (originating leaf numeric) → `dstSrvYXX` → tunnel. Leaf reads `fd.cookie` → `LocalClientArray[fd]` + cookie match (`m_sasl.c:184-193`) → local client. **No per-bridge state; pure router.**
- `cli_saslagent` lives on the leaf's client; after the first reply it becomes the x3 anchor → continuation `C` cmds (`m_authenticate.c:294`) route over CR-X too (round-trip closure). ✓

## Two halves
- **Forward (leaf→x3):** wrap each Tier B forward `sendcmdto_one(&me,CMD_*,target,…)` with `crdt_route_services_try(target,p10cmd,args)` → 1=handled / 0=fall through to P10. Route when the target server is mesh-only — use a new `crdt_server_is_mesh_only(srv)` = `IsMeshStub(srv) && !IsPresented(srv)` (on a leaf x3 is never presented, so correct). `dstSrvYXX` = x3's OWN numeric (`crdt_meshmap_nexthop` finds the gateway; no need to name it). Gateway re-emits real P10 to x3 in the CR-X arm when it resolves `dstSrvYXX` to a LIVE legacy P10 link, gated `FEAT_CRDT_GATEWAY_BRIDGE` + `should_standby` (MR-4d).
- **Reverse (x3→leaf):** at each reverse `if(!IsMe) sendcmdto_one(sptr,CMD_*,acptr,…)` hook `crdt_route_services_reply_try(acptr/owner,p10cmd,args)`. **Detect mesh-only by `cli_from`-is-dead (MR-4 style), NOT IsPresented** (presented-stub trap — the gateway-side bug from the INVITE fix). Tunnel CR-X to the leaf numeric. Leaf delivers by re-injecting the verbatim args into the existing `ms_sasl`/`ms_account`/`ms_regreply`/`ms_xreply` (token finds the local client). **Reverse delivery = call the existing ms_ handler with un-tunneled args.**

## Hook sites
- B1 SASL: fwd `m_authenticate.c:278-296` (the `if(acptr)` branch; the `else` broadcast `*` form already WORKS). rev `m_sasl.c:148`. `m_endburst.c:228` is a broadcast → NO bridge needed.
- B2 LOC: fwd `s_auth.c:496/501/507`; rev `m_account.c:362` (p10cmd `C`).
- B3 REGISTER/VERIFY/REGREPLY: `m_register.c:113/132/391` (`G`/`V`/`R`).
- B4 rename: fwd `m_rename.c:435` (`C`); reverse is LOCAL cookie-dispatch (`m_account.c:333-352`) → no extra rev work.
- B6 XQUERY/XREPLY: `m_xquery.c:116/144` + `m_xreply.c:122` (`Q`/`Y`). P1-OPTIONAL (open-ended; wire it, cheap).
- B7 directed PM/NOTICE: `ircd_relay.c:1135/1248` — BESPOKE (real-user source must be carried + bouncer-alias rewrite preserved). Sequence LAST; add a source-numeric field to the frame.

**One mechanism covers B1-B6; B7 adds a source field.**

## Flag strategy
- New `FEAT_CRDT_SERVICES_BRIDGE` (default FALSE) gates the leaf CR-X emit (fwd) + gateway CR-X tunnel (rev).
- Reuse `FEAT_CRDT_GATEWAY_BRIDGE` for the gateway P10 re-emit (both directions' gateway legs).
- Both off ⇒ today's exact P10 behaviour (dead-sink-to-anchor). Controlled rollout.

## B2-B7 — per-subsystem findings (2026-06-18, from reading the sites; NOT trivial B1 mirrors)

Investigating the remaining Tier B sites showed they each have wrinkles beyond B1's pattern — do NOT
blind-implement. The headline is a **cross-cutting prerequisite**:

- **★ PREREQUISITE — services anchors aren't recognized as services.** `find_services_server()`
  (`m_register.c:60`) requires `IsServer(acptr) && IsService(acptr)`, and the directed-PM path requires
  `IsService(acptr)` (`ircd_relay.c:1111/1232`). But a Case-B synthetic anchor is `STAT_MESH_SERVER`
  (IsServer=FALSE) and is NOT marked `IsService` (make_anchor doesn't set it; the +s flag isn't propagated
  to the leaf via the proxy-beacon). So on a leaf, REGISTER (B3) and directed-PM (B7) **can't even find x3**
  → their forward never fires. **B1 SASL dodged this** because `find_match_server(FEAT_SASL_SERVER)` resolves
  by NAME (ignores IsServer/IsService). FIX (enabler for B3/B7): propagate the service flag to the anchor —
  carry it on the proxy-beacon (CR H) + `SetService` in `crdt_shadow_make_anchor` when the beacon says the
  server is a service — and/or teach `find_services_server` to accept `IsMeshStub && IsService` anchors.
- **B3 REGISTER/VERIFY/REGREPLY — NOT ACTIONABLE (user 2026-06-18): X3 as-is does NOT speak
  REGISTER/VERIFY/REGREPLY** (essentially unusable). The CR-X carrier already includes the `G`/`V`/`R`
  cmd codes, so B3 is "carrier-ready, blocked on X3-side implementation" — DROP from the active list until
  X3 gains these P10 tokens; bridging to a service that ignores them is pointless. (Was the cleanest mirror
  by token shape, below, hence the detail — kept for if/when X3 implements it.)
- ~~B3 REGISTER/VERIFY/REGREPLY~~ (`m_register.c:113/132` fwd, `:391` rev) — token `server!fd.cookie`
  (IDENTICAL to SASL) → the reverse uses the proven token-mismatch routing (B1 model). Server-sourced (&me).
  The CLEANEST mirror once the prerequisite is solved. Note `FEAT_REGISTER_SERVER` default "*" → find any
  IsService server (hits the anchor-recognition gap). REGREPLY rev: `find_prereg_client` fails on the gateway
  (prereg client is on the leaf) → MUST route by the token's server first (like B1's token-mismatch).
- **B2 LOC** (`s_auth.c:496/501/507` fwd, `m_account.c:362` rev) — token `.fd.cookie` has an EMPTY server
  field → the origin is only in the P10 source prefix, NOT the token. So the gateway-proxy reverse (route by
  token-origin, B1's model) has nothing to route by. Needs EITHER the gateway to introduce the leaf to x3
  (so x3 replies to a known leaf numeric → gateway anchor → tunnel; but that re-exposes leaves to legacy) OR
  gateway state (cookie→origin map). A real design decision — NOT a mirror.
- **B4 rename** (`m_rename.c:435` fwd, CMD_ACCOUNT R) — forward is server-sourced; reverse is LOCAL
  cookie-dispatch (no extra reverse). Forward mirrors B1 once the prerequisite is solved.
- **B6 XQUERY/XREPLY** (`m_xquery.c:116/144`, `m_xreply.c:122`) — USER-sourced (the oper issuing XQUERY) →
  the CR-X frame must carry a USER numeric source (carrier extension: re-emit src = `findNUser(srcyxx) ??
  FindNServer(srcyxx) ?? &me`). XREPLY reverse target may be a user or server.
- **B7 directed PM/NOTICE `nick@services`** (`ircd_relay.c:1135/1248`) — needs BOTH the anchor-IsService
  prerequisite (else `!IsService` → ERR_NOSUCHNICK before the forward) AND a USER-source carrier (the source
  is the messaging user). Reverse is FREE (the service replies via a normal user-PM → MR-1/MR-4b). Forward
  only, once both are solved. Validatable via `PRIVMSG nick@x3.services`.

**Recommended order for the next session (REVISED — B3 dropped, X3 doesn't speak it):** confirm WHICH P10
service protocols X3 actually speaks first (it speaks SASL [B1 done] + directed-PM; LOC/XQUERY/rename TBD —
ASK or test). Then: (0) the anchor-service-recognition prerequisite [unblocks B7's IsService check + B6] +
the carrier user-source extension [B6/B7], (1) **B7 directed-PM** [X3 handles it, the most validatable:
`PRIVMSG nick@x3.services`], (2) B6 XQUERY [if X3 uses it], (3) B2 LOC [if X3 speaks LOC; the hard reverse].
B3 REGISTER/B4 rename = blocked on X3-side support. Each is flag-gated; the CR-X carrier is proven by B1.

## Sub-steps
1. **S1 mechanism (TDD-first):** `crdt_route_services_try` + `crdt_route_services_reply_try` + `'X'` arm in `ms_crdt` + `crdt_server_is_mesh_only` (crdt_shadow.c) + `FEAT_CRDT_SERVICES_BRIDGE`. **cmocka FIRST.**
2. **S2 B1 forward** (`m_authenticate.c:278-296`).
3. **S3 B1 reverse** (`m_sasl.c:148`).
4. **S4 live-validate B1** (5-5a recipe below) — the keystone.
5. B2/B5 LOC → B3 REGISTER → B4 rename → B6 XQUERY → B7 directed (bespoke).

## cmocka (pure logic, TDD)
- Token round-trip: `<srvnum>!fd.cookie` → `dstSrvYXX` = first 2 chars; verbatim-args byte-preserved emit→frame→re-emit (the dumb-pipe invariant — highest value, proves auth tokens can't corrupt).
- `crdt_route_action` server-target path (4 verdicts, no cli_user deref).
- `crdt_server_is_mesh_only`: anchor→1, presented stub→0, live server→0.
- `crdt_m_seen` dedup of a CR-X msgid.

## 5-5a characterization (force Path-3 + observe)
Bed has `SASL_LOCAL=TRUE` everywhere → local Keycloak absorbs PLAIN/OAUTHBEARER (Path-1), Path-3 never hit.
X3 DOES speak P10 SASL (`x3.conf:302 sasl_enable 1`). To force Path-3 on a leaf: **set `SASL_LOCAL=FALSE` on
nef7** → `sasl_local_available()`→0, no IAuth → `m_authenticate.c:227` Path-3 → `find_match_server("x3.services")`
→ the x3 ANCHOR → `sendcmdto_one(CMD_SASL,anchor,…)` → dead-sink → client hangs to `FEAT_SASL_TIMEOUT` (30s)
→ ERR_SASLFAIL. That's the baseline. Capture fwd token + (from a gateway-local auth) the reverse subcmds
(`m_sasl.c:237-268`: C challenge / L login / D S done / D F|A fail|abort / M mechlist). After CR-X: client
completes SASL within the timeout.

## Risks
1. **Auth-critical (HIGHEST):** corruption/misroute = login outage. Mitigation: dumb opaque pipe + cmocka token round-trip gate + flag default-off.
2. **`FEAT_SASL_TIMEOUT` (30s) vs CR round-trip latency:** prefer NEXTHOP over FLOOD (fresh x3 beacon); validate end-to-end latency under real hop count.
3. **MR-4d double-delivery (two gateways):** reuse `crdt_shadow_should_standby`. Latent in single-gw bed.
4. **PRESENTED-stub predicate trap:** gateway reverse-catch MUST use `cli_from`-dead detection, NOT IsPresented (the bug the INVITE fix just closed). cmocka + assertion guard.
5. **fd-reuse across bridge delay:** existing stale-check (`m_sasl.c:196-203`) + cookie match guard it (token-based). Confirm in live-validate.
