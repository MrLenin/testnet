# CRDT-Mesh — S2S gap audit (comprehensive, before MR-5 go-live)

> Scope: every server-to-server send in `ircd/*.c`, classified against the MR-5 P10-SERVER-tree
> retirement. Source-grounded c-auditor sweep of `nefarious-crdt` @ `aaaf8b4` (crdt-mesh), 2026-06-17.
> Audit branch staged at `f3c8c71` (pre-MR-5 baseline) as `s2s-gap-audit`. Read-only; no code changed.
> Companion to `crdt-mesh-mr5-tree-retirement.md` §9 (this SUPERSEDES the 7-subsystem view — it found more).

## Why this exists

The MR-5-5 pass scoped 7 named subsystems. This audit enumerated **all** S2S send sites to find what that
missed. It did — including **coverage holes in already-"DONE" work** (MR-1 unicast + MR-4c INVITE were
applied to the primary path but not all relay sites) and a **services-reachability class far broader than
the scoped SASL relay**. None of these are dismissible; several are user-facing correctness.

## The governing mechanism (the one discriminator)

A far CRDT server / its users / x3.services / legacy servers exist on a remote CRDT node ONLY as a mesh
**anchor**: `make_client(NULL, STAT_MESH_SERVER)`, `fd=-1`, `cli_serv->updown=NULL`, **no `add_dlink`**
(`crdt_shadow.c:866-905`). Therefore, per send primitive:

- **BROADCAST** (`sendcmdto_serv_butone[/_v3]`, `sendcmdto_flag_serv_butone`) iterates `cli_serv(&me)->down`
  (`send.c:1709/1884/2020`) = direct physical CRDT↔CRDT links → **never touches an anchor** → hop-by-hop →
  **WORKS**. (Confirmed: anchors are never in `->down`.)
- **TARGETED** `sendcmdto_one(from,cmd,to,…)` → `to=cli_from(to)` (`send.c:1105`) → for a server/user
  resolved through an anchor, `cli_from` is the fd=-1 dead Connection → **silently dropped** → **BREAKS**.
- **`hunt_server_cmd`/`_prio_cmd`** resolve a numeric/target then `sendcmdto_one` → dead-sink at an anchor →
  **OPS-DEGRADE** (reply lost; no crash).
- **LINK-LOCAL** (PING/PONG/PROTO/ERROR/BURST/EOB, the CR substrate) only ever to a directly-connected peer
  → never routed → safe.
- A loop guarded `if (!IsServer(x)) continue` SKIPS anchors (`STAT_MESH_SERVER` is not `STAT_SERVER`) →
  **silent-skip degrade** (anchored member gets nothing), not a dead-sink crash.

**So per site the only question is: broadcast (works) vs targeted-at-a-possibly-anchored-server/user
(breaks) vs hunt_server (ops-degrade).** Sweep totals: `sendcmdto_one` 498 sites, `serv_butone` 123,
`_v3` 74, `flag_serv_butone` 38, `hunt_server_cmd` 37, `hunt_server_prio_cmd` 4. Bare `hunt_server` /
`sendto_serv_but_one` appear only in dead comments.

## REMAINING GAPS (not covered by the DONE list or MR-5-5 §9), by severity

### Tier A — correctness, user-facing, HOLES IN ALREADY-"DONE" WORK (fix first; small)
| # | Gap | Site(s) | Why it breaks | Fix |
|---|---|---|---|---|
| A2 | **INVITE relays in `ms_invite`** | `m_invite.c:341` (non-existent channel) + `:369` (remote). **NOT `:367`** (the `MyConnect` LOCAL branch). | the `ms_invite` S2S relay sites were bare `sendcmdto_one` → anchored invitee dead-sinks | **✅ DONE + LIVE-VALIDATED 2026-06-18 (`a0e3b50` + `82d1a75`).** Plus an `ich==NULL` branch in the CR-M 'I' HOME handler (`m_crdt.c:688`) for the non-existent-channel form. **NB — live-testing found the guard PREDICATE itself was wrong** (see below). |

> **⚠ PRESENTED-STUB ROUTING BUG (found + fixed 2026-06-18, `82d1a75`) — a deeper, pre-existing defect than A2.** MR-5-1/MR-4c gated INVITE/KILL mesh-routing on `crdt_user_is_mesh_only(target)` (= `IsMeshStub && !IsPresented`). On the GATEWAY, R6c PRESENTS an anchored stub to legacy (`SetPresented`), so that predicate is **false** for a presented stub's users — but their `cli_from` is still the dead-sink anchor, so the P10 fallback silently drops the INVITE/KILL. **PRIVMSG never had this** — it calls `crdt_route_unicast_try` UNCONDITIONALLY (keyed on `IsMeshStub`), P10 fallback only on 0. Fixed all INVITE sites (`m_invite.c:224/341/369`) + KILL (`m_kill.c:142`) to the PRIVMSG pattern. Live-validated: Alice@nef3 INVITE Bob@nef7 (a presented stub on nef3) now delivers (wire-traced CR-M 'I' → home delivery); was dropped. **Lesson: `crdt_user_is_mesh_only` is correct for §17.7 legacy-EMIT gates but WRONG as a CR-M routing predicate — audit any other site that routes on it.** MR-5-1's earlier "INVITE validated" only exercised a target-LOCAL invitee (MyConnect branch), never this cross-node presented-stub path.

**A1 RECLASSIFIED → Tier B (was mis-scoped here).** On reading the code to implement: `relay_directed_message`/`_notice` (`ircd_relay.c:1135/1248`) target a **services SERVER** (`acptr = FindServer(server+1)` gated `IsService`), NOT a remote user (the auditor's "remote user" was wrong — directed `nick@server` is services-only since the Vampire- brute-force fix). So `crdt_route_unicast_try` (which needs `cli_user(tgt)`) does NOT apply — this is the same x3-services dead-sink as the rest of Tier B, and its fix is the services-anchor bridge, not an MR-1 guard-extend. See B7 below.

### Tier B — the SERVICES-REACHABILITY class (broader than the scoped SASL relay) — CORRECTNESS
All target the x3 pseudo-server (or the requesting server's back-leg), which is an **anchor** on a CRDT leaf.
The MR-5-5 "SASL gateway-translate" must be generalized to a **services-anchor bridge** covering this whole
class, not just `m_authenticate.c`/`m_sasl.c`.
| # | Gap | Site(s) |
|---|---|---|
| B1 | SASL relay — **✅ DONE + LIVE-VALIDATED 2026-06-18 (`5e1f5dd`)** via the CR-X services-anchor bridge (testadmin SASL over the mesh, 0.1s, 0 crash). The carrier (CR X) + the gateway-proxy reverse model are proven; B2-B7 ride it. | `m_authenticate.c` (sasl_forward), `m_sasl.c` (reverse: !IsMe owner + token-mismatch) |
| B2 | LOC origination → x3 (CMD_ACCOUNT S/H/C) | `s_auth.c:496/501/507` |
| B3 | REGISTER / VERIFY → x3 | `m_register.c:113` (RG), `:132` (VF); back-leg REGREPLY `:392` |
| B4 | AC R rename-permission → x3 | `m_rename.c:435` |
| B5 | AC A/D LOC reply | `m_account.c:318/321/324/364` |
| B6 | **XQUERY / XREPLY** (open-ended services query channel) | `m_xquery.c:116/144`, `s_auth.c:2942`, `m_xreply.c:123` |
| B7 | **Directed PM/NOTICE `nick@services`** (was mis-scoped as Tier A1) | `ircd_relay.c:1135` (PRIVMSG), `:1248` (NOTICE) — `sendcmdto_one(from,CMD_PRIVATE/NOTICE, services-server, …)`; the server is an anchor on a far leaf |

**Treatment:** route the whole to-/from-services class over the MR-4b CR-M gateway bridge (x3 fronted as an
anchor by the gateway). Single fix family. **B6 (XQUERY) is open-ended** — any X3 module using cross-mesh
XQUERY silently drops; if none do, B6 can be accept-degraded, but B1–B5 are required (X3 SASL/registration
is non-negotiable for prod).

> **★ CONSOLIDATED + DEEPENED 2026-06-18 → `crdt-mesh-tier-c-scope.md`** (two agent passes @ `e5cd75c`).
> Key correction: **"BOUNCER BS = broadcast WORKS" (below + MR-5 §9 row 7) is TRUE ONLY ON A FULL MESH.**
> The bed is a partial mesh → BS/`BX C/X/U/V` (`sendcmdto_serv_butone_v3` over `->down`) don't cross a
> multi-hop-only CRDT pair → the alias is doubly absent (doc-excluded AND never created). So 5-5e =
> BS-convergence-first (new CR 'B' carrier), bigger than C2 records. Also: BATCH `route_to` unknown
> RESOLVED (all MyConnect → not Tier C); C3 REDACT broadcast-covered (no work); C4 OPER accept-degraded;
> the real C1 surprise is the CHANNEL-multiline hole (`m_batch.c:1522`). See the scope doc.

### Tier C — other correctness gaps
| # | Gap | Site(s) | Treatment |
|---|---|---|---|
| C1 | **MULTILINE PM federation** | `m_batch.c:1230, 1431` (`cli_from(alias/acptr)` of a remote PM target) | gate on `crdt_user_is_mesh_only`, tunnel the batch over CR-M (or fall back to the per-line PRIVMSG path the fn already has) |
| C2 | **BOUNCER BX K** (snomask → remote alias) | `bouncer_session.c:6835` | same as the scoped BX E/M — CR-M route when `crdt_user_is_mesh_only(_t)`. Adds to MR-5-5e |
| C3 | **Targeted REDACT relay** | `m_redact.c:90/92`, `m_chathistory.c:3962/3965` | prefer the broadcast RD path (already WORKS); else CR-M route the targeted form |
| C4 | **Remote OPER** (`/OPER server …`) | `m_oper.c:489, 545` | CR-M route the oper-up to the O-line server's home, or accept-degraded (oper against a directly-reachable server) |
| C5 | CH federated Q/W (already scoped = 5-5f) | `m_chathistory.c:1982/2509/3080/3807/4067/4219/4434` | CR-M route (see MR-5-5 §9) |

### Tier D — global state CONVERGES, only the scoped per-server leg breaks (P2 — defer to MR-6, not won't-fix)
Targeted `/<line> <server>` forwards: **GLINE** `m_gline.c:194/268/523/568`, **SHUN** `m_shun.c:190/264/515/560`,
**ZLINE** `m_zline.c:194/268/527/572`, **JUPE** `m_jupe.c:135/238`. The doc cutover replicates the *global*
line so network state still converges; only the operator's explicit "activate on THAT server" routed leg
dead-sinks. **Treatment: defer to P2** (doc covers global state in the hybrid window); CR-M route the scoped command at/before MR-6.

### Tier E — ops / cosmetic (P2 — defer to MR-6; required once there's no P10 fallback)
- **MULTILINE channel delivery to anchored members** — `m_batch.c:1528-1573` `if(!IsServer)continue` skips the
  anchor → anchored members miss channel multiline (silent, not a crash). Tunnel over CR or accept the
  PRIVMSG-fallback the doc path covers.
- **PRIVS** remote (`m_privs.c:66/167`), **GITSYNC** targeted (`m_gitsync.c:424/426/718/720`; the `*` form is
  broadcast + WORKS), **RPING/RPONG** (`m_rping.c:152/172/230`, `m_rpong.c`), **ASLL** (`m_asll.c:130/168`),
  **SETTIME-to-server** (`m_create.c:155`, `m_server.c:674`; the `->down` broadcast `m_settime.c:145` WORKS;
  per memory SETTIME rides the mesh as a priority control-message at MR-5), and the known hunt_server set
  (STATS/TRACE/LINKS/MAP/CONNECT/ADMIN/INFO/LUSERS/MOTD/NAMES/REHASH/RULES/TIME/UPING/VERSION/WHOIS/WHOWAS/CHECK).

### Verified SAFE (broadcast or link-local — checked, not skipped)
Full **SVS\*** family (svsnick/svsmode/svsjoin/svspart/svsident/svsquit/svsnoop/svsinfo) = `serv_butone`
broadcast with the target named in the payload → WORKS. Also broadcast-safe: SWHOIS, MARK, AWAY, TEMPSHUN,
SMO, SNO, OPMODE, CLEARMODE, DESTRUCT, DESYNCH, WEBPUSH, SETNAME, RENAME, the `*`-form GITSYNC,
SILENCE-broadcast, MD/MR/CI, broadcast REDACT, QUIT (manual `->down` loop). LINK-LOCAL: PING/PONG/PROTO/
ERROR/BURST/EOB. CR_REPLICATION sends to `peer` = the mesh substrate itself (direct CRDT links by design).

### Unresolved (needs a runtime-provenance trace before classifying)
- **BATCH_CMD `route_to` / `acptr`** — `m_batch.c:247/269` and `:2289/2308`. Whether `route_to` is always a
  direct link or can be a resolved-remote target is not statically provable; if remote, it joins Tier C
  (a BX-class targeted relay). Needs a trace of the batch-routing logic (~`m_batch.c:200-270`, `2270-2310`).

## Implications

1. **"DONE" ≠ done at every site.** MR-1 and MR-4c each guarded the primary path but missed relay/directed
   sites (A1, A2). Any future cutover must be audited at EVERY `sendcmdto_one` for that token, not just the
   headline one. A1/A2 are quick wins (extend an existing guard) and are plain bugs once the tree is retired.
2. **The SASL fix is really a services-anchor bridge** (Tier B) — generalize MR-5-5b to cover LOC/register/
   rename/XQUERY, all the same dead-sink to x3.

## Priority scale — WHEN, not IF (user 2026-06-17)

**Every gap here closes on the road to CRDT-as-primary; "degradation acceptable" means acceptable DURING the
dev window only, not a won't-fix.** The end state (MR-6: overlay-as-primary, P10 links dropped) has NO P10
fallback, so even the ops/cosmetic tiers must route over the mesh eventually. So "accept-degraded" below =
"deferred to a later priority band," never "abandoned." The bands map to the CRDT adoption stages:

- **P0 — now (dev hybrid).** **Tier A** (the MR-1/MR-4c guard holes). Plain bugs; land them regardless of
  sequencing. Cheap (extend an existing guard).
- **P1 — gate for CRDT carrying PROD traffic (still hybrid: P10 present as fallback).** **Tier B** (services
  / auth — X3 SASL+registration non-negotiable) + **Tier C** (correctness: directed-PM already in A, multiline
  PM, bouncer BX E/M/K, targeted REDACT, remote OPER, CH federation 5-5f). These are the user-visible
  correctness gaps; CRDT cannot carry production until they route over the mesh.
- **P2 — gate for CRDT-as-PRIMARY (MR-6: P10 links dropped, no fallback).** **Tier D** (scoped
  gline/shun/zline/jupe per-server legs) + **Tier E** (ops tooling: STATS/TRACE/LINKS/MAP/CONNECT hunt_server,
  multiline-to-anchored-members, PRIVS/GITSYNC/RPING/RPONG/ASLL/SETTIME-to-server). Tolerable while the P10
  tree still exists as a fallback; REQUIRED once it's gone — at MR-6 there is no other path.

This audit is the checklist for all three gates. Resolve the BATCH `route_to` unknown early (it may add to P1).

## Sequencing (within the bands)
P0: A1+A2 guard-extends. P1: B (services-anchor bridge, supersedes the SASL-only 5-5b) → C1/C2/C3/C4 → 5-5f
(CH) → 5-5e (bouncer, bouncer-analyst first). P2 (with/after MR-6): D → E (CR-M route the hunt_server /
ops / multiline classes; the P10 tree's removal forces these).
