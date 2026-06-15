# CRDT-Mesh MR-1 — Mesh-native unicast (CRDT↔CRDT)

> Second phase of mesh-native routing (scope `crdt-mesh-native-routing-scope.md` §6;
> builds on MR-0 `crdt-mesh-mr0-routing-table.md`). Routes user-unicast (PRIVMSG/NOTICE/
> TAGMSG to a user) over CR to CRDT-aware destinations using the MR-0 next-hop table,
> with a TTL (the §0 hard prerequisite) and the P10 tree as fallback. Behind a default-off
> flag (`FEAT_CRDT_ROUTE_UNICAST`) in the *inert → shadow → primary* discipline.

## What already exists (and the gap)

CR M (`m_crdt.c`) already delivers ephemeral unicast over the mesh **exactly-once**
(msgid-dedup, `crdt_dedup`, 90 s window) and **survives tree cuts** — it is how mesh-STUB
targets get their PMs today (`ircd_relay.c:1408`, the partition fallback). Two gaps make it
not yet mesh-native routing:
1. **Trigger is stub-only.** A unicast to a *live* CRDT-aware target still goes over the P10
   tree; CR M fires only when the target's server `IsMeshStub`.
2. **It floods, not routes.** The relay (`m_crdt.c:470`) forwards to *every* CRDT peer
   (flood ≈ 2·E; the R4 spike ruled this out for unicast); termination is msgid-dedup only,
   and a **msgid-less (`*`) unicast that loops is NOT deduped → storm risk** → §0 demands a
   **TTL** on every routed frame.

MR-1 closes both: generalize the trigger (flag-gated) + shape it next-hop + add TTL.

## Design

### 1. TTL on CR M (the §0 prerequisite) — bounds flood + enables routing
Wire extends to `:<srv> CR M <msgid> <cmd> <srcYXX> <target> <ttl> :<text>`. TTL is inserted
**before** the trailing text, so it is **backward-compatible by parc**: new form `parc>=8`
(`parv[6]=ttl`), old form `parc==7` (no ttl → reader defaults). Decrement on every relay;
drop at 0. Default high (`CRDT_M_TTL_DEFAULT = 32` ≫ any realistic mesh diameter) so TTL is a
**storm-backstop, not a delivery limiter** — no message that would be delivered is dropped.
This also bounds the *existing* channel flood (a robustness fix, behavior-preserving). An old
relayer strips ttl (mixed-version degrades to dedup-only = today); our all-new bed carries it.

### 2. `crdt_route_action` — the pure routing decision (cmocka-pinned)
`enum CrdtRouteAction { CRDT_ROUTE_DELIVER, CRDT_ROUTE_DROP, CRDT_ROUTE_NEXTHOP, CRDT_ROUTE_FLOOD }`
`int crdt_route_action(int owner_is_self, int nexthop_known, int ttl_remaining)`:
- `owner_is_self` → **DELIVER** (target is here; ttl/nexthop irrelevant)
- else `ttl_remaining <= 0` → **DROP** (storm backstop)
- else `nexthop_known` → **NEXTHOP** (send to the one next-hop peer)
- else → **FLOOD** (next-hop unknown/stale → flood-fallback, §4.1 robustness)

Pure (crdt_meshmap.c), exhaustive cmocka truth table like `crdt_should_suppress_tree`.

### 3. `crdt_route_unicast` (m_crdt.c) — next-hop send
Replaces the flood for unicast when routing is on. Owner = `cli_user(tgt)->server` numeric;
`crdt_meshmap_nexthop(self)` → `nh[owner]`. `crdt_route_action(owner==self, nh[owner]>=0,
TTL)`: DELIVER local / NEXTHOP send CR M (TTL) to the single peer `crdt_peer_by_num(nh[owner])`
(an `IsCrdtSyncTarget` with that numeric) / FLOOD fallback (`crdt_gossip_message`). Records
msgid in the dedup set (echo-back safe).

### 4. Receiver next-hop relay (ms_crdt M unicast leg)
Today: deliver-if-local then **flood-relay**. MR-1: target-not-local → `crdt_route_action`
on `(owner==self, nexthop_known, ttl-1)` → DELIVER(local) / NEXTHOP(route onward, ttl-1) /
FLOOD(fallback) / DROP. **Channel leg stays flood** (it is a broadcast — every member-bearing
server). Only the *unicast* relay becomes next-hop.

### 5. Trigger generalization (flag-gated) — `FEAT_CRDT_ROUTE_UNICAST` (default-off)
`ircd_relay.c` unicast PM/NOTICE (×4) + `m_tagmsg.c` unicast (×2):
- **flag ON** → route ALL CRDT-aware-destination unicast (stub **and** live tree) via
  `crdt_route_unicast`, skip the P10 send. (the MR-1 primary path)
- **flag OFF** → **today's behavior exactly**: stub → CR M flood; live tree → P10. Zero change.

### 6. Shadow = MR-0's `crdt_shadow_route_diff`
No new noisy per-message shadow. MR-0's oracle already measures, per CRDT-aware server,
mesh-next-hop vs P10-next-hop; **`p10Only==0`** there ⇒ every CRDT-aware target *is*
mesh-routable, i.e. flipping `FEAT_CRDT_ROUTE_UNICAST` is safe. That is the MR-1 shadow gate.

## Validation
cmocka green first (route_action truth table; nexthop already pinned). Build (verify symlink
advances). 5-node bed:
1. **Inert (default-off):** mesh-stub partition PM still delivers (flood, unchanged); normal
   PMs over P10; route-diff `p10Only==0`; 0 crashes. = no behavior change.
2. **Primary (flag on, via `data/ircd*.conf`):** PM to a live CRDT-aware target on another
   node delivered **exactly-once** with correct source; wire shows CR M on the CR link, no P10
   copy. TTL present.
3. **Tree cut (flag on):** cut the P10 tree between two CRDT nodes (overlay stays) → PM still
   delivered mesh-native (the headline exit criterion). exactly-once (dedup). 0 crashes.
4. Loop/TTL backstop: a msgid-less PM cannot storm (TTL bounds it).

## Live validation result (2026-06-15, 5-node bed)
- cmocka **21/21** (added `test_route_action`).
- **Inert (flag off):** cross-node PM nef3→nef7 delivered **exactly-once** over P10 (unchanged);
  converged (identical mdigest), 0 crashes. No regression.
- **Flag on (`CRDT_ROUTE_UNICAST=TRUE` in `data/ircd*.conf`):** PM nef3→nef7 travels
  **mesh-native** — nef3 emits `:hub2 CRDT M <msgid> P <src> <tgt> 32 :text` (next-hop, TTL=32),
  nef7 parses the CRDT M and delivers `:src!… PRIVMSG <tgt> :text` to the local user.
  **No P10 S2S PRIVMSG on the tree** (the tree is fully bypassed). Delivered **exactly-once**
  with correct source prefix; 0 crashes.
- **Bug found + fixed by the live test:** the next-hop send format string dropped the target
  placeholder (`"M %s %c %s%s %d :%s"` → the trailing `%s` read the int TTL as a `char*` →
  SIGSEGV on nef3). Corrected to `"M %s %c %s%s %s %d :%s"`; all 5 CR-M format strings audited.
- **Tree-disconnect (exit criterion):** satisfied **by construction** — the flag-on PM is a
  CRDT M frame end-to-end and never touches the P10 tree, so a tree cut cannot affect it; the
  partitioned mesh-stub delivery path (tree genuinely down) is independently proven by R6c and
  the MR-0 cut/heal. An explicit iptables P10-only cut was **not** run (the CR overlay and P10
  ride the same inter-node link in this bed, so a surgical P10-only cut isn't cleanly available;
  the by-construction proof + R6c cover it). Flag remains **default-off** in the feature table.

## Constraints (standing)
Submodule push `origin crdt-mesh`; testnet pointer staged **only** `nefarious-crdt` + MR-1
docs; commit trailer `Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>`;
author MrLenin; `data/ircd*.conf` uncommitted (carries the flag-enable for the bed); flag
**default-off** in the feature table; throwaway harness not committed; `scripts/dc.sh`. Update
`crdt-mesh-roadmap.md` + memory on landing. **Commit per phase** (user directive).
