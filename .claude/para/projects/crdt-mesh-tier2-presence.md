# Plan: CRDT-mesh Tier-2 presence — materialize mesh-only users (the keystone)

## Status: Q1 SPIKE DONE + PHASE P1 (Case A) SHIPPED 2026-06-10 (submodule d411c92, testnet 8984a7e). Phase P2 (Case B) next.

**P1 DONE (Case A — stub-holder):** %C treats IsMeshStub as a server (ircd_snprintf.c, crash
chokepoint); materialize gate admits IsMeshStub (F1a); crdt_user_is_mesh_only() + skip §17.7
legacy gateway emits NICK/JOIN/KICK/PART (F1b). Live-verified nef3/4/5 (partial partition): a
split-born user materializes on the stub-holder, WHOIS-visible, deliver TO+FROM over the mesh,
**0 crashes**, P1-path valgrind clean, clean relink (converges, no dup, stub reaps the user).
**P2 (Case B) SCOPED + source-validated 2026-06-10 — see [crdt-mesh-tier2-presence-p2.md](crdt-mesh-tier2-presence-p2.md).**
Design: a SYNTHETIC STAT_MESH_SERVER anchor created LAZILY at materialize (make_client(NULL)+make_server,
fresh dead Connection, SetServerYXX but NO add_dlink so it's FindNServer-resolvable yet not a routing
downlink), gated on CR H beacon freshness, retired by the existing beacon-staleness sweep + relink
pre-retire (numeric fallback). Nothing changes at SQUIT (Fix-C from_crdt_peer self-skip avoids a
tombstone divergence). + server_relay_* CR M hooks (4 fns) for remote-origin delivery. Two gotchas:
no add_dlink (routing leak) and retire must branch on updown==NULL (remove_dlink(NULL) assert).
Also deferred: a mesh-only user's nick/umode CHANGE relays to legacy via set_nick_name/set_user_mode.
NOT coded — plan only.

This is the Tier-2 keystone. It unlocks **server-relayed delivery** (the `server_relay_*`
hooks) and removes the **split-born-user visibility** gap. It is *not* a mop-up — it sits
exactly on the T2-c crash boundary, so it gets a plan + a spike before any code.

## Problem

Today a remote user is materialized as a live `Client` only if its owning server is
**P10-reachable from here** — the gate `srv = FindNServer(srvnum); if (!srv || !IsServer(srv))
return NULL;` in `crdt_materialize_one_user` ([crdt_shadow.c:1005](../../nefarious-crdt/ircd/crdt_shadow.c#L1005)).
For a *mesh-only* user (its owning server partitioned off the P10 tree but reachable via the
CRDT mesh) this gate skips, so:

- **Case A — the stub-holder** (e.g. nef3, directly linked to the partitioned nef5): nef5's
  *existing* users are KEPT live by the stub conversion (not re-materialized), but a **new
  split-born** user (connected to nef5 *during* the split) is in the converged doc yet never
  materialized — its server is a `STAT_MESH_SERVER` stub, `IsServer` is false.
- **Case B — a non-directly-linked mesh server** (e.g. nef4, which reached nef5 via nef3):
  when nef5 partitions, nef4 tears nef5 down entirely (T2-c keeps a stub only for a
  `MyConnect` peer). `FindNServer(nef5)` returns NULL → **none** of nef5's users (existing or
  new) are present on nef4. This is why a nef4 user can't even address a nef5 user during the
  split, which in turn is why the `server_relay_*` CR M hooks have nothing to fire on.

## The two hard design questions (the spike must answer these)

### Q1 — ANSWERED BY SPIKE 2026-06-10 (controlled live repro on nef3, valgrind stack)
**The dead-sink Connection is NOT the problem.** `make_client(cli_from(stub), …)` onto the
stub's `close_connection`'d Connection (fd=-1, FLAG_DEADSOCKET) succeeds, and every send path
uniformly skips a parent with `IsDead || cli_fd(cli_from)==-1` ([send.c:967](../../nefarious-crdt/ircd/send.c#L967)
unicast; 2613/2741/2926/3056/3117 channel), so nothing ever writes to the dead socket. The
materialized user was created fine.

**The crash is the §17.7 gateway re-intro, and it's the same class as Fix C.** After
materialize, `recon_user_cb` calls `crdt_gateway_user_intro(nc)` ([crdt_shadow.c:1213](../../nefarious-crdt/ircd/crdt_shadow.c#L1213)),
which emits a P10 `NICK` to legacy servers via `sendcmdto_flag_serv_butone(srv=stub, …)`. The
`%C` formatter ([ircd_snprintf.c:2047-2052](../../nefarious-crdt/ircd/ircd_snprintf.c#L2047))
branches on `IsServer(cptr)` — which is **exact `== STAT_SERVER`**, so the `STAT_MESH_SERVER`
stub falls into the *user* branch and derefs `cli_user(stub)->server`. A server-stub has
`cli_serv` set and **`cli_user == NULL`** → NULL deref → SIGSEGV. (valgrind: `Invalid read …
Address 0x0` at `doprintf` ← `sendcmdto_flag_serv_butone` ← `crdt_gateway_user_intro` ←
`recon_user_cb`.)

**Implication — the anchor design is much simpler than feared; the real fixes are narrow:**
- **(F1) Don't gateway-intro mesh-only users.** Skip `crdt_gateway_user_intro` when the owning
  server is a mesh stub. This is correct *anyway*: a mesh-only user propagates to other
  mesh servers via the **CRDT doc** (each materializes it locally), not via a P10 `NICK`
  announce; and on relink the real server re-bursts the genuine `NICK`. So legacy (non-CRDT)
  peers simply don't learn of partitioned users until relink — acceptable and intended.
- **(F2) Audit `IsServer`-exact paths that take a stub as a message SOURCE.** The `%C` deref is
  one instance; any `sendcmdto_*(srv=stub, …)` or `IsServer(x)?server:user` branch a stub flows
  through as origin has the same NULL-`cli_user` hazard. **c-auditor sweep**: "stub /
  STAT_MESH_SERVER as a message source or `IsServer`-exact branch." (Deliver TO/FROM in T2-b/c
  dodged this by reconstructing the source prefix into `sendrawto` instead of `%C` of the stub.)
- The **per-server "mesh route anchor" idea is NOT needed for Case A** — the existing stub's
  dead-sink Connection is a fine routing parent once F1 stops the crashing gateway intro. The
  anchor is only relevant for **Case B** (servers that have no stub because the partitioned
  server was non-`MyConnect`); there a lightweight stub-equivalent (or simply *also* stubbing
  relayed-but-mesh-reachable servers) is the open design question — but Case B is **not**
  required for the headline win (split-born visibility + deliver on the stub-holder).

### Q2 — how does SEND to a mesh-only user become a gossip, not a P10 route?
Unchanged and already solved by T2-b: delivery keys off `IsMeshStub(cli_user(target)->server)`
in the relay hooks. A user materialized onto a stub inherits that predicate for free; the
`server_relay_*` hooks need the same check added (factor into `crdt_user_is_mesh_only`).

## Revised approach (post-spike — Case A first, the headline)

**Phase P1 (Case A — the headline, low-risk now that Q1 is answered):**
1. **F1**: in `crdt_materialize_one_user`, allow materialize when the owning server is a mesh
   stub (`IsServer(srv) || IsMeshStub(srv)`), parenting on the stub's Connection (proven safe).
2. **F1**: gate `crdt_gateway_user_intro` to no-op for a mesh-stub-owned user (skip the P10
   `NICK` announce that crashes + is semantically wrong for a mesh-only user).
3. **F2**: c-auditor sweep for other `IsServer`-exact-as-source hazards a materialized mesh-only
   user hits (its own NICK/QUIT/MODE relay, channel-membership relay with it as source); fix by
   either treating `IsMeshStub` as a server in those spots or routing via reconstructed prefixes.
4. Retire path: the existing `crdt_shadow_retire_mesh_stub` already tears down held users on
   relink; confirm it also reaps these newly-materialized split-born users (they share the stub
   Connection) before the real server re-registers its numeric.

**Phase P2 (Case B — server-relay + non-stub-holder visibility):** the harder half; needs a
stub-equivalent on non-`MyConnect` mesh servers (or stub relayed-but-mesh-reachable servers).
Defer until P1 lands and is proven; re-scope then.

## Original approach (superseded by the spike — kept for context)

1. **Generalize the stub into a per-server "mesh route anchor"** present on every mesh server
   for a partitioned-but-mesh-reachable server (not only the `MyConnect` stub-holder). Anchor
   invariants: not `IsServer`/`IsClient`; bitmask-excluded from routing/WHO/netburst (as
   `STAT_MESH_SERVER` already is); a Connection that does NOT crash `make_client`/`sendrawto`
   but whose send is a no-op (delivery happens via CR M gossip). Audit every `cli_from`/
   `cli_serv` deref reachable on it (the T2-c NULL-deref risk).
2. **Lift the materialize gate** to also materialize users whose owning server resolves to a
   mesh anchor (replace `!IsServer(srv)` with "not a live tree server AND not a mesh anchor"),
   parenting new Clients on the anchor — *never* on a dead-sink Connection.
3. **Uniform mesh-send predicate**: factor the T2-b `IsMeshStub(server)` check into a helper
   (`crdt_user_is_mesh_only(acptr)`) and apply it in BOTH `relay_*` and `server_relay_*`
   (private/channel, msg/notice/TAGMSG) → server-relayed delivery + split-born visibility both
   close.
4. **echo-message / chathistory** for mesh-only targets ride the same delivery path once
   presence + send-interception exist; add as a follow-on increment, not in the keystone.

## Crash-risk checklist (this is the T2-c boundary — be paranoid)
- NEVER `make_client` / `sendrawto` against a `socket_del`'d Connection. The anchor's
  Connection must be constructed to survive both (or delivery must bypass the Connection
  entirely and go straight to CR M).
- Anchor must be bitmask-excluded from every `IsServer`/`IsClient`/`IsRegistered` test and the
  SQUIT cascade (verify, as for `STAT_MESH_SERVER`).
- `findNUser`/`hAddClient` collision: a materialized mesh-only user and a later P10 re-intro on
  relink must not double-register (the existing `findNUser` idempotence guard + the relink
  pre-retire of the anchor must cover this — audit the ordering).
- Numeric reuse: on relink, the real server re-registers its numeric; the anchor + its
  materialized users must be retired BEFORE that (mirror `crdt_shadow_retire_mesh_stub`'s
  pre-retire, now applied to the generalized anchor on every mesh server).

## Test plan
- **cmocka**: engine-level is already covered (materialize is integration-layer). The new
  surface is Client-lifecycle, not engine — so live tests carry it, plus targeted asserts if a
  unit seam can be made.
- **Live (nef3/4/5 + overlay)**:
  1. Partition nef5. Connect a NEW user U to nef5 *during* the split. Assert U materializes on
     BOTH nef3 (stub-holder) and nef4 (Case B) as a live, addressable presence; `shadow verify`
     0 mismatch; **0 crashes** (the headline risk).
  2. A nef4 user messages U (PRIVMSG/NOTICE/TAGMSG) → delivered to U on nef5 via the mesh
     (server-relay path). Reverse direction too.
  3. Heal → U converges to a normal P10 presence, anchor retired, no double-register, digests
     converge (regression vs the Fix C/Fix A heal test).
- Valgrind clean on the new path on all three (the T2-c crashes were caught exactly here).

## Sequencing
**Q1 spike DONE** — verdict: the anchor-with-fresh-Connection idea is unnecessary for Case A;
the dead-sink stub Connection is a fine routing parent, and the crash was the gateway P10
re-intro (`%C` of a `STAT_MESH_SERVER` stub → `cli_user(NULL)` deref, the Fix-C class). So the
fallback IS the plan: **do Phase P1 (Case A) next** — F1 (materialize onto the stub + skip the
gateway intro) + F2 (c-auditor sweep of `IsServer`-exact-as-source hazards). P1 closes
split-born visibility + deliver on the stub-holder with low risk. **Phase P2 (Case B)** —
server-relay + non-stub-holder visibility — is the harder half (needs a Case-B stub-equivalent);
re-scope after P1 lands. Recommend an explicit go/no-go before P1 since it lifts the deliberate
Tier-1/2 materialize gate.

## Constraints
Standing CRDT-mesh rules: submodule push to `origin crdt-mesh`, testnet pointer staged as ONLY
`nefarious-crdt`, `Co-Authored-By: Claude Opus 4.8 (1M context)` trailer; configs uncommitted;
cmocka gates the image; verify the `ircd.YYYYMMDDHHMM` symlink advances per build (NB6).
