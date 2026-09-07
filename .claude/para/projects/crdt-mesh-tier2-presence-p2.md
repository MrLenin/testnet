# Plan: CRDT-mesh Tier-2 Phase P2 (Case B) — synthetic mesh anchor

## Status: SHIPPED & VERIFIED 2026-06-10 (submodule e01e1ff / testnet 2f2f312).
Prereq P1 (Case A) shipped (d411c92 / 8984a7e). Parent: [crdt-mesh-tier2-presence.md](crdt-mesh-tier2-presence.md).

**DONE — all 4 steps + both gotchas, exactly as planned.** Live-verified nef3/4/5+overlay: split-born
user on isolated nef5 materializes on nef4 via a synthetic anchor (`synthetic anchor for server AG`),
WHOIS 311 (was 401 in P1), deliver-TO works, **0 crashes** (anchor-path valgrind clean); full partition
→ beacon stale → anchor retired (`retiring mesh stub mesh-AG.crdt`, the updown==NULL synthetic path, no
remove_dlink crash); clean relink → 3-way converges (a freshly-restarted nef4 reaches full 7/7). The
transient post-relink "8/7, 1 mismatch" was a quit user lingering in the doc until reconcile cleared it
— self-healed, not a bug. STILL DEFERRED: mesh-only user nick/umode CHANGE → legacy leak; Step 5 spike
(CR H carries server name → real WHOIS name + right-sized client mask, currently MAX ~2MB/anchor).

## Problem (Case B)
A mesh server NOT directly linked to the partitioned server (e.g. nef4 reaches nef5 via nef3)
holds no stub: at SQUIT `crdt_shadow_mesh_reachable` requires `MyConnect(srv)`, so nef4 tears
nef5 down entirely. `FindNServer(nef5)` → NULL → `crdt_materialize_one_user` skips → nef5's users
are invisible/unaddressable on nef4 (`WHOIS` → 401). Blocks split-born visibility on non-stub-holders
AND server-relayed delivery.

## Design — a SYNTHETIC mesh anchor, created LAZILY at materialize
Instead of converting a departing Client (Case A), create a synthetic `STAT_MESH_SERVER` anchor on
demand at materialize time. It reuses every Case-A mesh-only code path (%C-as-server, gateway-skip,
send-drop, beacon staleness-retire). Created with a **fresh owned dead Connection** (the spike's
crash hazards don't apply to a never-socketed Connection) and registered in `server_list[]` but
**NOT** wired as a routing downlink.

### Key validated facts (Plan agent, against source)
- `make_server` (list.c:456) only allocs the Server struct — does NOT touch `->down`/`add_dlink`. The
  thing that makes a server a routing downlink is the explicit `add_dlink(&cli_serv(sptr)->down,...)`
  in `ms_server` (m_server.c:915). **The anchor must NOT call add_dlink** (mirror the FLAG_CRDT_OVERLAY
  precedent at m_server.c:782-790: set `cli_serv(anchor)->up=&me`, leave `updown=NULL`).
- `SetServerYXX(c, anchor, capacity)` (numnicks.c:271) sets `server_list[num]=anchor` + allocs
  `client_list`. `client_list != NULL` is the marker `exit_one_client` (s_misc.c:316) uses to
  `ClearServerYXX` (free the slot) on teardown → registration/cleanup are symmetric. Safe to register
  for a SQUIT'd numeric (slot already freed).
- Relink ordering is ALREADY correct: `mr_server`/`ms_server` pre-retire by `FindClient(host)` then
  **fall back to `FindNServer(parv[6])`** (m_server.c:640/891) BEFORE `check_loop_and_lh`+`SetServerYXX`
  — the anchor is in `server_list` under that numeric, so the numeric fallback finds+retires it before
  the real server claims the slot. No collision window.
- `make_client(NULL)` Connection: `con_fd=-1`, no socket, no timer, `freeflag=0`. `can_send` returns 0
  for `cli_fd==-1` (send.c:967) → every send to the anchor/its users drops, never touches a socket.
  `cli_from(anchor)==anchor` ⇒ `MyConnect(anchor)` true (like a Case-A stub); users via
  `make_client(cli_from(anchor))` share it, `MyConnect(user)=false`. Free path clean (users freed
  first NULL their cli_connect; anchor freed last → dealloc_connection, no close() since fd=-1, no
  double-free).
- **Lazy is sound; nothing at SQUIT changes.** When nef4 tears down relayed nef5, its users'
  `crdt_shadow_user_remove` self-skips (`from_crdt_peer(cli_from(user)==nef3)` true — nef3 IsServer+
  IsCrdtAware) → NO tombstone → no Fix-A divergence. (Fix-C guarantee covers Case B for free.)

### The two gotchas this design turns on
1. **No add_dlink** — else the anchor enters every `cli_serv(&me)->down` broadcast loop (send.c
   3073/1684/1859/1992/2112/3149) + the SQUIT cascade (s_misc.c:1022) + `/links`/`/map`. The anchor
   is FindNServer-resolvable WITHOUT being a routing downlink (exactly the overlay-peer trick, plus
   SetServerYXX for the server_list/client_list it needs).
2. **Retire must branch on `updown==NULL`** — `exit_one_client`'s server teardown does
   `remove_dlink(...updown)` which asserts non-NULL (list.c:665). Case A `SetServer(stub)` then
   exit_one_client (it has a real dlink). A synthetic anchor has `updown==NULL` → it must stay
   `STAT_MESH_SERVER` through `exit_one_client` (IsServer-exact skips the remove_dlink branch) while
   still hitting `ClearServerYXX` (gated on client_list) + the generic hRemClient/free tail. Traced
   clean.

## Phased steps
1. **s_misc.c `crdt_shadow_retire_mesh_stub`** (~779): only `SetServer(stub)` when
   `cli_serv(stub)->updown != NULL` (Case A); leave a synthetic anchor (updown==NULL) as
   STAT_MESH_SERVER through `exit_one_client`. Prereq safety net; harmless before anchors exist.
   (Do FIRST.) The existing beacon-staleness sweep + relink pre-retire then "just work" for anchors.
2. **crdt_shadow.c new `crdt_shadow_make_anchor(numstr, num)`** (~402): `make_client(NULL,
   STAT_MESH_SERVER)`; `make_server`; `cli_serv->up=&me` (NO add_dlink); placeholder `cli_name`
   (`mesh-<num>` until Step 5) + cli_info; `SetServerYXX(nc,nc,NN_MAX_CLIENT-1)` (MAX mask — see
   Risk 2); `SetFlag(FLAG_MAP)` + `SetCrdtAware`; `add_client_to_list`+`hAddClient`; seed
   `crdt_beacon[num].recv_ts=CurrentTime`. Deliberately NO `Count_newremoteserver` (symmetric with
   exit_one_client not decrementing for a non-IsServer stub).
3. **crdt_shadow.c `crdt_materialize_one_user`** (~1017): when `FindNServer(srvnum)==NULL`, if
   `CurrentTime - crdt_beacon[idx].recv_ts <= CRDT_BEACON_STALE` (mesh-reachable) →
   `srv = crdt_shadow_make_anchor(...)`; else keep returning NULL (full partition → users hidden =
   correct SPLIT). Fall through to the existing materialize. Single chokepoint for both
   mat_create_user_cb (bulk) + recon_user_cb (delta).
4. **ircd_relay.c `server_relay_*`**: add the IsMeshStub→`crdt_gossip_message` CR M hook (mirror the
   already-present `relay_*` hooks) to: `server_relay_private_message` (~1567, 'P'),
   `server_relay_private_notice` (~1682, 'N'), `server_relay_channel_message` (~771, 'P' per-member),
   `server_relay_channel_notice` (~870, 'N' per-member). Remote-origin (2-hop) delivery to mesh-only
   users. (`server_relay_masked_*`/`directed_*` out of scope.)
5. **(separate spike) CR H beacon carries the server NAME**: `crdt_gossip_beacon` emits
   `H <num> <ts> :<name>`; receiver stores name per numeric; make_anchor uses it for cli_name (real
   WHOIS/links) + would let us right-size the client_list mask. Append-only param (old receivers
   ignore). Optional polish.

## Risks (ranked)
1. **(High) Anchor becomes a routing downlink** if add_dlink ever added → broadcast/SQUIT/links
   leakage. Mitigation: Step 1 makes retire work WITHOUT a dlink; Step 2 forbids add_dlink + comment;
   verify `/links`,`/map` show no phantom.
2. **(High) client_list mask sizing.** Doc carries no nn_capacity → too-small mask silently drops
   colliding split-born users (numnicks.c:240). Mitigation: MAX mask (~2MB/anchor; rare, retired on
   relink, ≤ a few concurrent). Step 5 (name+capacity in beacon) right-sizes later. **Most important
   correctness gotcha.**
3. **(Med) `remove_dlink(NULL)` assert** — addressed by Step 1's updown guard; trace all 3 retire
   callers (sweep, relink ×2) with a synthetic anchor.
4. **(Med) Placeholder name** until Step 5: WHOIS shows `mesh-<num>`; relink pre-retire's
   FindClient(host) misses but FindNServer(num) fallback retires it. Confirm.
5. **(Low) overlay vs anchor**: overlay peer keeps nef5 num in cli_yxx but NOT server_list +
   STAT_HANDSHAKE (not IsMeshStub) → excluded from sweep, no server_list collision. Verified.
6. **(Low) counts drift** — skip Count_newremoteserver for the anchor (exit_one_client doesn't
   decrement a non-IsServer stub); user counts are symmetric via materialize/exit_one_client.

## Test plan (live nef3/4/5 + overlay; CASE B = nef4 sees nef5's users)
1. Split-born visibility: SQUIT nef3↔nef5; connect `bob` to nef5 during split; within ~1 verify
   cycle `WHOIS bob` on **nef4** returns the user (not 401), **0 crashes** (the headline Case-B fix).
2. Deliver-TO local-origin: nef4 user → PM/NOTICE/channel to `bob` → delivered via CR M on nef5.
3. Deliver-TO remote-origin: nef3 user → PM/channel to `bob` (remote-origin at nef4) → delivered
   (exercises server_relay hooks, Step 4).
4. Full partition: drop nef4↔nef5 overlay too → beacon stale ≤90s → sweep retires the anchor, `bob`
   gone on nef4 with no tombstone, **0 crashes**.
5. Clean relink: restore nef3↔nef5 → ms_server numeric-fallback pre-retires the anchor before
   SetServerYXX → real nef5 claims slot, `bob` via P10 burst, no dup-server, no collision, 0 crashes.
6. Regression: Case A (direct SQUIT) still converts in place + retires via the SetServer branch.
TDD: factor the beacon-gate + updown-retire branch to be assertable; bulk is integration-bound → live.

## Build order
Step 1 → Step 2+3 (test 1/2/4/5) → Step 4 (test 3) → Step 5 (separate commit/spike).

## Constraints
Standing CRDT-mesh rules: submodule push origin crdt-mesh, testnet pointer staged as ONLY
nefarious-crdt, Co-Authored-By trailer, configs uncommitted, cmocka gates the image, verify the
`ircd.YYYYMMDDHHMM` symlink advances (NB6).
