# CRDT-Mesh MR-3 — Legacy presence into the mesh (scope)

> Status: **scoping only — not scheduled.** Focused, source-grounded plan for MR-3 of the mesh-native
> routing track. Supersedes the MR-3 bullet in `crdt-mesh-native-routing-scope.md` §6 (which still
> carries the pre-correction "doc `servers`-map" framing — see §8 below). Grounded against current
> source by a Plan-agent pass (2026-06-16); line numbers are as-of that pass.
>
> Read first: `crdt-mesh-native-routing-scope.md` (the §0 FATAL CORRECTION + the overall MR-0…MR-5 arc),
> memory `project_crdt_r7a_squit_only` (why SERVER-intro retirement is infeasible without this).

## 1. Goal (corrected)

Make a CRDT-aware leaf with **no direct P10 link** to a legacy (non-CRDT) server still see that legacy
server and its users, by representing legacy presence on the **single-writer CR H beacon path** — the
gateway **proxy-beacons** each legacy server it fronts, and leaves **anchor** it from that beacon via
the existing Case-B `crdt_shadow_make_anchor` path — so the legacy server's P10 SERVER intro **no longer
has to be relayed across the CRDT mesh.**

**NON-NEGOTIABLE:** legacy presence does **NOT** go in the doc `servers` LWW collection.
`crdt_shadow_server_add()` is a deliberate no-op (`crdt_shadow.c:539-542`); its rationale (`:512-538`)
documents that per-server ACTIVE/SPLIT in the convergent doc was built in Phase 4a, **live-tested, and
proved non-convergent** (reachability is per-viewpoint; racing SPLIT/ACTIVE ops GC before the self-heal
propagates → permanently-stale nodes). The mesh-map's *topology (single-writer beacon) vs reachability
(derived locally)* split exists to replace that failure; MR-3 rides the converged half. The `servers`
collection is **empty in production** (`crdt_shadow.c:533`) — only the beacon set is authoritative.

**Why this unblocks R7b/MR-5.** The exact reason R7b was reverted is in-code at `crdt_shadow.c:609-617`:
suppress a CRDT server's SERVER intro and everything relayed through it (e.g. `x3.services` behind the
gateway) orphans on a leaf with no direct P10 link, **because legacy servers don't beacon, so the anchor
fallback can't fire either.** MR-3 *makes legacy servers beacon (by proxy)*, so the anchor fallback
fires — the precondition that lets MR-5 suppress the SERVER intro safely.

## 2. Mechanism (extend-vs-new, file:line)

| Mechanism | Action |
|---|---|
| `crdt_gossip_beacon` (`m_crdt.c:394`) | **EXTEND** — after the `&me` beacon, loop the gateway's directly-linked legacy servers (`cli_serv(&me)->down`, select `IsServer && !IsCrdtAware`, as `crdt_gateway_has_legacy_peer` does at `crdt_shadow.c:653-661`) and emit one beacon **per legacy numeric**: `cli_yxx(legacy)`, `cli_serv(legacy)->nn_capacity`, `cli_name(legacy)`, **`peers="*"`** |
| `crdt_shadow_beacon_record` (`crdt_shadow.c:111`) | **no change** — keys on the beacon's `<srvYXX>` (`parv[2]`), not the relayer, so a foreign-numeric proxy-beacon is accepted; `peers="*"` is guarded out of the mesh-map (`:128`) |
| `ms_crdt` 'H' relay (`m_crdt.c:695-722`) | **no change** — already relays fresh foreign beacons onward to N-hop leaves |
| Case-B anchor: `crdt_materialize_one_user` (`crdt_shadow.c:2113-2125`) + `crdt_shadow_make_anchor` (`:729`) | **no change** — on a no-direct-link leaf `FindNServer` fails → Case-B checks the proxy-beacon is fresh → anchors the legacy server (`STAT_MESH_SERVER` dead-sink, named/sized from the beacon); legacy users hang off it |
| Legacy SERVER relay → CRDT peers: `ms_server` (`m_server.c:950-965`), `server_estab` (`s_serv.c:197-213, 267-291`) | **NEW guard** — suppress the SERVER intro of a **legacy subject** toward a **CRDT-aware peer** (keep it toward legacy; keep CRDT-server intros) |
| `crdt_should_suppress_intro` (new pure fn, `crdt_meshmap.c` beside `crdt_should_suppress_tree` `:411`) | **NEW** — `meshmap_on && primary && peer_aware && !subject_aware`; cmocka-pinned truth table |
| Departure: staleness sweep (`crdt_shadow.c:3370-3382`) | **no change** — gateway stops proxy-beaconing on legacy-link drop → leaves sweep-retire the anchor after the (proxy) stale threshold; identical to R7a CRDT-peer departure |
| Ownership/lease | **NEW** (§3a) |

**Legacy users (no change):** already minted into the `users` doc by the gateway when their P10 NICK
registers (`crdt_shadow_user_add` at `s_user.c:1019`; `from_crdt_peer` self-skip does NOT fire because
`cli_from` is the legacy server). Leaves materialize them onto the proxy-beaconed legacy-server anchor
via the Phase-3l reconcile-users path.

## 3. Hard problems — resolutions

**(a) Ownership / lease (CRITICAL-2) — PARTIALLY DECIDED, handoff DEFERRED to MR-4.** The gateway is the
sole beaconer of every legacy row; if it partitions *from the mesh* (legacy still up), leaves stop
receiving the proxy-beacon and false-retire live legacy servers at the 90s floor. **Decided for MR-3
(safe under single-gateway):** a **longer lease for proxy-origin rows** — tag the beacon as proxied (an
append-only one-char marker, mixed-version safe) and apply `CRDT_BEACON_STALE_PROXY` (≫ 90s) to
proxy-origin anchors in Case-B + the sweep. Trade-off is explicit: a genuinely-dead legacy server
lingers as a ghost longer, but under single-gateway the only thing that stops the proxy-beacon while
legacy is up is a gateway↔mesh partition — and a ghost during a partition beats retiring a live server
(the doc re-materializes it the instant the gateway rejoins, as native stubs heal at `m_server.c:893`).
**Deferred to MR-4:** true ownership handoff (a standby gateway taking over the proxy-beacon) — needs
the §0 standby-promotion machinery, meaningless under single-gateway.

**(b) HLC across the legacy boundary — DECIDED (no new code; document the invariant).** Legacy runs no
HLC; the gateway stamps legacy `users` writes with its **own** HLC (already true — `crdt_shadow_user_add`
→ `crdt_user_set(&g_crdt,…)` stamps from `g_crdt.clock`). Invariant to record: every legacy doc write is
HLC-stamped by the gateway, ordering deterministically by (gateway-physical-ms, logical, numeric) like
any gateway-origin write. Caveat: two gateways would stamp the same legacy user differently — another
reason single-gateway is a hard prerequisite.

**(c) Single-gateway prerequisite — STATED (assumption, enforced by topology).** MR-3 assumes exactly
one CRDT node fronts a given legacy net. If violated: (1) two proxy-beaconers for one numeric → the row
flaps by max-`emit_ts` = the servers-map non-convergence re-imported; (2) two HLC stampers (3b); (3) a
P10 loop on the legacy side (duplicate-SERVER at `server_estab`, ~30s before any beacon detection).
MR-3 adds a **defensive log/warn** if it ever sees a *second* CR H beacon for a numeric it is itself
proxy-beaconing, but must not try to resolve it. Multi-gateway prevent-by-construction = MR-4 / §0.

**(d) `legacy_net_id` — FORWARD DEPENDENCY (not needed at MR-3).** Disambiguates "second gateway to the
SAME net (loop)" vs "different net (fine)"; under single-gateway there is no second gateway. Note it as
an MR-4 requirement (configured field, rides the beacon).

**(e) Mixed-deployment invariant — STATED.** A legacy anchor is visible only where the proxy-beacon
reaches, which is only over CR links → the CRDT-aware subgraph must be CR-connected; a CRDT pair
reachable only *through* a tree-only node keeps the P10 tree for that pair (unchanged mesh-map
assumption).

## 4. Phasing (inert → shadow → flag-enable). Flag: `FEAT_CRDT_LEGACY_PRESENCE` (default off)

- **MR-3a — proxy-beacon emit + shadow oracle (INERT). DONE 2026-06-17 (submodule `31311cb`).** Extended
  `crdt_gossip_beacon` (`crdt_proxy_beacon_legacy`): the gateway beacons each legacy server in its subtree,
  SINGLE-WRITER via `!IsCrdtAware(cli_from(L))` (only the node reaching it via a legacy link beacons it;
  covers multi-hop — x3 behind testnet). `crdt_should_suppress_intro` pure fn + exhaustive cmocka (for 3c,
  not wired). Shadow oracle `crdt_shadow_legacy_presence_diff` (verify timer). **Validated on the hybrid
  bed:** flag on → far leaf nef7 shows BOTH legacy servers (testnet + x3) `beacon=FRESH` (proxy-beacon
  propagated mesh-wide → Case-B anchorable); gateway shows them `ABSENT` (it emits = single-writer); SERVER
  relay still wins so no anchor fires (inert); 0 crashes. **Bed note:** after a CRDT-node recreate the
  legacy `.2`/x3 hold stale links and reject (`All connections in use`) until ping-timeout — restart `.2`
  (or wait) then `/CONNECT testnet… 4496` to re-form the gateway link.
- **MR-3b — anchor-from-beacon validated (still no suppress).** On a test leaf, cut the direct P10 path
  to the legacy SERVER (so `FindNServer` fails) with the CR mesh up; confirm Case-B
  `crdt_shadow_make_anchor` fires from the proxy-beacon and materializes the legacy users. *De-risks the
  anchor path before any suppression.*
- **MR-3c — suppress the legacy SERVER relay (FLAG-ENABLE).** Flip `FEAT_CRDT_LEGACY_PRESENCE`: the
  `crdt_should_suppress_intro` guard skips the legacy SERVER intro toward CRDT-aware peers → the
  proxy-beacon + Case-B anchor become the *only* way a no-direct-link leaf learns the legacy server.
  *Proves the exact R7b failure case now passes (§5).* Reversible by clearing the flag;
  `crdt_shadow_server_add` stays a no-op throughout (servers-map never touched).

## 5. Validation (5-node hybrid bed: nef3–7 + legacy `testnet`/`x3.services`)

Gateway = the CRDT node with the legacy Connect block (e.g. nef3 ↔ x3.services). Target leaf = a CRDT
node with NO direct P10 link to the legacy introducer, reaching nef3 only via CR (e.g. nef7).

**EXIT = the R7b failure case passing:** nef7 materializes `x3.services`'s users via the beacon-anchored
path, with no SERVER intro for the legacy server on any CR link.

1. **Wire (negative):** with the flag on, tcpdump nef7's CR links → **no `SERVER x3.services`** crosses
   any CRDT link; the `CR H <legacyYXX> … :x3.services` proxy-beacon **is** present + flooding fresh.
2. **Presence (positive):** on nef7, `FindNServer(<x3 num>)` → a `STAT_MESH_SERVER` anchor named
   `x3.services`; an X3 user (AuthServ) is present + addressable (`/WHOIS`; a PM routes via CR M
   `crdt_route_unicast_try`). *This is the user materializing on a far leaf with no direct P10 link.*
3. **Convergence gate:** mdigest matches across nef3–7 → legacy presence did NOT enter the digest (it
   rides the ephemeral beacon, not the doc).
4. **Cut the gateway↔mesh** (legacy still up): with the proxy-lease (§3a) the anchor persists past 90s
   (no false retirement). Then cut the gateway↔legacy link → proxy-beacon stops → nef7 sweep-retires the
   anchor after the proxy stale threshold.
5. **Relink:** gateway↔mesh restored → proxy-beacon resumes → anchor re-materializes (or the real SERVER
   returns first and `ms_server`'s pre-retire `m_server.c:893` swaps anchor→real cleanly).

## 6. Ranked residual hazards

1. **[Critical] Gateway↔mesh partition false-retirement** (CRITICAL-2). Proxy-lease (§3a) mitigates, not
   cures (trades false-retire for ghost-linger); the clean fix (ownership handoff) is MR-4. **Decide
   `CRDT_BEACON_STALE_PROXY`** (the tolerable false-presence window).
2. **[High] Single-gateway prerequisite is operational, not enforced.** A second legacy Connect block
   re-imports servers-map non-convergence + a P10 loop. MR-3 only logs/warns. **Decide:** warn-only vs a
   configure-time guard.
3. **[Medium] Anchor capacity sizing.** The proxy-beacon carries the legacy `nn_capacity`; if absent the
   anchor falls back to the MAX mask (~2MB/anchor, `crdt_shadow.c:760`). Confirm the gateway always has
   the legacy server's real capacity from `ms_server`.
4. **[Medium] `crdt_present_stub` must never re-present a legacy-fronted anchor back toward legacy.** Safe
   today (self-no-ops on a leaf with no legacy peer, `:674`); becomes a real hazard at MR-4 (second
   gateway). Record as an MR-4 invariant.
5. **[Low] Mixed-version beacon parsing.** The lease/proxy marker must be append-only so an old binary's
   `H` parse (`m_crdt.c:707`) still works (follow the existing `nn_cap`/`peers`/`name` positional discipline).

**Pre-implementation checklist:** `CRDT_BEACON_STALE_PROXY` value · proxy/lease wire marker (append-only)
· `peers="*"` sufficiency for mesh-map exclusion · warn-only vs configure-time single-gateway guard ·
confirm real `nn_capacity` for legacy · cmocka truth table for `crdt_should_suppress_intro`.

## 7. Dependencies

**MR-3 needs (all DONE, verified):** CR H beacon + `crdt_beacon[]` record/relay; Case-B anchor path;
staleness sweep + keep-gate + `FEAT_CRDT_MESHMAP_PRESENCE` (R7a); CR-M unicast (`crdt_route_unicast_try`,
MR-1) for the §5 positive test; the pure-decision-fn + cmocka pattern (`crdt_should_suppress_tree`).

**MR-4/MR-5 need from MR-3:** MR-5 (=R7b) needs the proxy-beacon-anchor as the precondition to suppress
the legacy SERVER intro (the gap at `crdt_shadow.c:609-617`); **MR-3c IS the legacy half of R7b**, MR-5
then suppresses CRDT-server intros among CRDT-both-ends peers (the SQUIT half is already wired at
`s_misc.c:1056`). MR-4 needs MR-3's lease tag extended to a true handoff + `legacy_net_id` + the
`crdt_present_stub` re-present guard.

## 8. Corrections to `crdt-mesh-native-routing-scope.md` (source-verified contradictions)

The §0 corrections in that doc are right, but body sections left un-rewritten now contradict §0 + source:
- **§6 MR-3 bullet (lines ~302-304) is WRONG** — still says "mirror legacy servers into the `servers`
  collection; leaves anchor from the doc." Contradicts §0 + `crdt_shadow.c:512-542`. Superseded by this doc.
- **§3 inventory (line ~122)** conflates the dead `servers` LWW (empty in prod, `:533`) with the live
  beacon set as "already authoritative."
- **§7 item 7 (line ~356)** "likely reuse the `servers` ACTIVE/SPLIT" is exactly the proven-non-convergent path.
- **Stale line numbers** throughout (MR-0/1/2 landing shifted `m_crdt.c`/`crdt_shadow.c`): no-op now
  `:512-542` (was `:475-505`); `crdt_gossip_beacon` `m_crdt.c:394` (was `:238`); `crdt_shadow_beacon_record`
  `crdt_shadow.c:111` (was `:89/97`); `crdt_present_stub` `:672`; `crdt_user_is_mesh_only` `:302`.
- **Framing:** MR-1/MR-2 are already implemented + flag-gated (`FEAT_CRDT_ROUTE_UNICAST/BCAST`), so the
  pure-CRDT track is substantially done; MR-3 here is the deprioritized legacy-track work, now scoped.
