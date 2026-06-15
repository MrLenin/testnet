# CRDT-Mesh MR-2b — all-server broadcast over the mesh (WALLOPS class)

> Continues MR-2 (channel broadcast). Routes the **ephemeral all-server notification**
> class — WALLOPS — over the CRDT mesh (reusing the MR-2 CR-M tree-forward carrier) instead
> of the P10 tree, behind the existing `FEAT_CRDT_ROUTE_BCAST` flag.
>
> **Architectural split (user-confirmed 2026-06-15):** ephemeral notifications (WALLOPS) are
> *tunnelled* over CR (no state); **persistent network state** (GLINE/SHUN/JUPE/ZLINE bans,
> SETTIME) is **NOT** tunnelled — it belongs in the CRDT doc as collections, exactly as Phase 3
> did for channel bans (CHAN_BANS OR-Sets). That is a **separate future "global-state-into-doc"
> track**, not MR-2b. Tunnelling state would fight the doc model (double-apply, ordering).

## Design (reuses the MR-2 carrier)

A WALLOPS rides CR M as a new `cmd='W'` with target `*` (all-server). It tree-forwards over
the canonical tree like a channel broadcast (msgid dedup + TTL + flood-fallback already there
from MR-2); each receiver delivers it to its **local +w opers** and forwards on.

### 1. `send.c`
- New `sendwallto_local(from, type, text)` — the local +w/+g delivery loop (the existing one in
  `sendwallto_group_butone`, but taking a plain string), so the mesh receiver can deliver
  without re-broadcasting. (No refactor of the existing varargs loop — a sibling helper.)
- `sendwallto_group_butone`: for `type==WALL_WALLOPS` AND `FEAT_CRDT_ROUTE_BCAST` AND a
  **user-sourced** WALLOPS (`cli_user(from)` — see scope note): format the text once
  (`ircd_vsnprintf`), **skip CRDT-aware downlinks** in the server loop (they get the mesh copy),
  and after the loop emit one `crdt_gossip_message(from, 'W', "*", <generate_msgid>, text)`.
  Local delivery + non-CRDT (legacy) downlinks are unchanged → legacy still sees it via P10.
- `+#include "handlers.h"` (for `crdt_gossip_message`).

### 2. `m_crdt.c`
- `crdt_gossip_message`: extend the tree-forward branch to also match `target[0]=='*'`
  (all-server broadcast), so WALLOPS tree-forwards when stable, floods otherwise — same as a
  channel.
- `ms_crdt` M handler: a `cmd=='W'` delivery branch → `sendwallto_local(findNUser(srcyxx),
  WALL_WALLOPS, m_text)` (deliver to local +w); and add `'*'` to the broadcast-relay condition
  so it tree-forwards/floods like a channel (not unicast).

### 3. Flag
Reuses **`FEAT_CRDT_ROUTE_BCAST`** (already default-off, enabled in the testbed conf). Off →
WALLOPS stays pure P10 (today's behaviour).

## Scope / deferrals (no silent defer)
- **User-sourced WALLOPS only** this phase. A *server*-sourced WALLOPS (`from` is a server →
  `cli_user(from)==NULL`, NumNick would be invalid) stays on P10. Server-sourced is rarer; the
  tree still carries it until MR-5. Mesh-routing it needs a server-numeric source path — a
  small MR-2b follow-on.
- **WALLUSERS / DESYNCH** (same function, other `type`s) stay P10 for now — trivial follow-ons
  (another `cmd` letter each); WALLOPS is the representative.
- **GLINE/SHUN/JUPE/ZLINE/SETTIME** → the separate CRDT-native-doc track (above).
- No new pure logic → no new cmocka (the carrier reuses MR-0/MR-2 primitives already pinned).

## Validation
Build (symlink advances). 5-node bed:
1. **Inert (flag off):** an oper WALLOPS reaches +w opers on all nodes via P10 (unchanged).
2. **Flag on:** an oper +w on nef-A issues WALLOPS → +w opers on the other CRDT nodes receive
   it **once**, carried as `CRDT M … W … * …` (mesh), with the P10 WALLOPS suppressed toward
   CRDT-aware downlinks. exactly-once; 0 crashes. (legacy peer, if any, still gets P10.)
3. 0 crashes across a couple of WALLOPS.

## Constraints (standing)
Submodule push `origin crdt-mesh`; testnet pointer + MR-2b doc only; trailer `Co-Authored-By:
Claude Opus 4.8 (1M context) <noreply@anthropic.com>`; author MrLenin; `data/ircd*.conf`
uncommitted; flag default-off; throwaway harness not committed; `scripts/dc.sh`. Update roadmap
+ memory on landing. **Commit per phase.**
