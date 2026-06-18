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
| A1 | **Directed PM/NOTICE** `/msg nick@server` | `ircd_relay.c:1135` (PRIVMSG), `:1248` (NOTICE) | `relay_directed_*` calls bare `sendcmdto_one(from,CMD_PRIVATE/NOTICE,acptr,…)` — the MR-1 `crdt_route_unicast_try` guard exists on the PRIVATE path (`:1406`) but was NEVER added here → anchored target dead-sinks | add the same `crdt_route_unicast_try(sptr,'P'/'N',acptr,…)` guard. **Quick win — closes an MR-1 hole.** |
| A2 | **INVITE relays** (3 of 4 sites) | `m_invite.c:341, 367, 369` | only `:227` got the MR-4c `crdt_user_is_mesh_only→crdt_route_unicast_try('I')` guard; the other three relay sites are bare `sendcmdto_one(sptr,CMD_INVITE,acptr,…)` → anchored invitee dead-sinks | extend the `crdt_user_is_mesh_only` guard to all three. **Quick win — closes an MR-4c hole.** |

### Tier B — the SERVICES-REACHABILITY class (broader than the scoped SASL relay) — CORRECTNESS
All target the x3 pseudo-server (or the requesting server's back-leg), which is an **anchor** on a CRDT leaf.
The MR-5-5 "SASL gateway-translate" must be generalized to a **services-anchor bridge** covering this whole
class, not just `m_authenticate.c`/`m_sasl.c`.
| # | Gap | Site(s) |
|---|---|---|
| B1 | SASL relay (already scoped) | `m_authenticate.c:283-294`, `m_sasl.c:150/153/303`, `m_endburst.c:228` |
| B2 | LOC origination → x3 (CMD_ACCOUNT S/H/C) | `s_auth.c:496/501/507` |
| B3 | REGISTER / VERIFY → x3 | `m_register.c:113` (RG), `:132` (VF); back-leg REGREPLY `:392` |
| B4 | AC R rename-permission → x3 | `m_rename.c:435` |
| B5 | AC A/D LOC reply | `m_account.c:318/321/324/364` |
| B6 | **XQUERY / XREPLY** (open-ended services query channel) | `m_xquery.c:116/144`, `s_auth.c:2942`, `m_xreply.c:123` |

**Treatment:** route the whole to-/from-services class over the MR-4b CR-M gateway bridge (x3 fronted as an
anchor by the gateway). Single fix family. **B6 (XQUERY) is open-ended** — any X3 module using cross-mesh
XQUERY silently drops; if none do, B6 can be accept-degraded, but B1–B5 are required (X3 SASL/registration
is non-negotiable for prod).

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
