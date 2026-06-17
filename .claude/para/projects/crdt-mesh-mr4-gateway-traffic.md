# CRDT-Mesh MR-4 — Gateway as the mesh's legacy face: P10↔CR traffic translation (scope)

> Status: **MR-4a/4b/4c DONE + live-validated; MR-4d (multi-gateway gating) is the only remaining piece.** Source-grounded (Plan-agent passes).
> HEADLINE ACHIEVED: a CRDT user on a leaf with NO direct P10 link to legacy can PM / KILL / INVITE a legacy user across the §17.7 gateway (PM gets a reply; KILL kills + converges via the doc tombstone; INVITE delivers with the channel). Submodules `f7d35f5`/`93bd33d`/`4ef1a97`/`696ba93`/`a7cb3f5`.
> Builds on MR-3 (legacy PRESENCE, done — `crdt-mesh-mr3-legacy-presence.md`). MR-4 = legacy TRAFFIC.
> Read first: `crdt-mesh-native-routing-scope.md` (§0 corrections, the MR-0…MR-5 arc).

## 1. Goal

MR-3 made legacy *presence* mesh-native (a far leaf sees a legacy server as a `STAT_MESH_SERVER`
beacon-anchor + its users via the doc, SERVER intro suppressed). **Presence ≠ delivery.** MR-4 fixes the
one traffic direction that is broken: **CR→P10 unicast at the gateway** — a CRDT user messaging a legacy
user. MR-4 sits between MR-3 (legacy half of R7b) and MR-5 (CRDT half): without working reverse-unicast,
retiring the tree (MR-5) would strand legacy-targeted PMs with no fallback.

## 2. The dead-sink — CONFIRMED (file:line)

`PRIVMSG AuthServ` from a CRDT user on nef7 (AuthServ on the x3 anchor):
1. `relay_private_message` (`ircd_relay.c:1406`) → `crdt_route_unicast_try(sptr,'P',acptr,…)`.
2. `crdt_route_unicast_try` (`m_crdt.c:329`): `tsrv = cli_user(tgt)->server` = the x3 anchor, which is
   `STAT_MESH_SERVER` + `SetCrdtAware` (`crdt_shadow.c:754/788`) → `IsMeshStub(tsrv)` TRUE → the gate
   (`m_crdt.c:344`) **claims** the message (P10 send skipped, `ircd_relay.c:1412`) — **flag-independent.**
3. next-hop: x3's proxy-beacon carried `peers="*"`, which `crdt_shadow_beacon_record` **excludes from the
   mesh-map** (`crdt_shadow.c:128`) → `crdt_meshmap_nexthop` returns −1 → `known=0`.
4. `crdt_route_action(…known=0…)` → `CRDT_ROUTE_FLOOD` → floods to all CRDT peers.
5. reaches the gateway; `ms_crdt` 'M' unicast deliver (`m_crdt.c:644-662`) gates `if (tgt && MyConnect(tgt))`
   — **`MyConnect(AuthServ)` is FALSE** (behind the real legacy P10 link) → **silently dropped.**

So: **floods then silently drops at the gateway** (TTL+dedup contain the flood; no error/storm). The
gateway holds the real P10 link but the 'M' handler only does *local* (`MyConnect`) delivery — no CR→P10
re-emit. Bug exists whenever MR-3 legacy presence is on, regardless of routing flags.

## 3. Mechanism (extend-vs-new, file:line)

**(a) `fronted_by` — append-only beacon field (NEW positional).** No existing signal identifies the
fronting gateway (the H beacon is relayed verbatim, re-sourced from `&me`, so the emitter is lost; the
`crdt_beacon[]` record stores only ts/name/cap). Add `<frontedByYXX>` to the **proxy-beacon only**, wire
`:&me CR H <legacyYXX> <ts> <cap> "*" <frontedByYXX> :<name>` — emit `cli_yxx(&me)` in
`crdt_proxy_beacon_legacy` (`m_crdt.c:413`); parse/relay append-only in the 'H' handler (`m_crdt.c:728-749`,
name stays `parv[parc-1]` → old binaries ignore it → mixed-version safe); store in a new
`crdt_beacon[].fronted_by` (`crdt_shadow.c:100`, set in `crdt_shadow_beacon_record` `:111`). **Doubles as
the proxy-row lease tag** (non-empty `fronted_by` ⇒ proxy-origin ⇒ apply `CRDT_BEACON_STALE_PROXY`) AND the
**multi-gateway loop signal** (a 2nd beacon for a numeric I front, different `fronted_by`).

**(b) Route legacy-target unicast toward the gateway (EXTEND `crdt_route_unicast_try`).** When
`IsMeshStub(tsrv) && crdt_beacon[owner].fronted_by != 0`, compute next-hop toward `fronted_by` instead of
`owner` (`m_crdt.c:357-364`) — the gateway has a real mesh-map row, so it routes (not floods). Mirror in
the 'M' relay arm (`m_crdt.c:682-720`). Flood stays the fallback (gateway beacon stale). cmocka-pin the
pure re-target decision.

**(c) CR→P10 bridge at the gateway (NEW else-branch, `m_crdt.c:644-662`).** When the 'M' target resolves
to a real P10 legacy user we front (`findNUser(tgt)` + `tgt`'s server `IsServer && !IsCrdtAware` reached via
our legacy link — the same `!IsCrdtAware(cli_from(L))` single-writer test) and `!MyConnect(tgt)`, **re-emit
as P10** `sendcmdto_one(srcc, CMD_PRIVATE/NOTICE/TAGMSG, tgt, …)` — the direct-message analog of the R6b
channel bridge (`m_crdt.c:626-643`). Source = `findNUser(srcyxx)`, gated by `crdt_user_is_mesh_only(srcc)`
(`crdt_shadow.c:302`) exactly as the channel bridge: a not-yet-presented mesh-only sender needs a fallback
(server-/numeric-sourced re-emit, or drop+counter — **decision §8**).

No new transport, no doc change, no new file.

## 4. Traffic-class matrix (works-today vs gap)

| Class | Dir | Status |
|---|---|---|
| Unicast PRIVMSG/NOTICE/TAGMSG | **CR→legacy** | **GAP (headline)** — dead-sink §2 |
| Unicast PRIVMSG/NOTICE/TAGMSG | legacy→CR | WORKS (`server_relay_private_message` → `crdt_route_unicast_try`/tree; CRDT target P10-present on gateway) |
| Unicast INVITE | either | GAP (smaller) — no mesh integration; legacy-anchor target dead-sinks. MR-4c |
| Unicast KILL | either | GAP + ordering (KILL-vs-trailing-msg). MR-4c |
| Channel msg/MODE/KICK/TOPIC/JOIN/PART | both | WORKS (R4a/R6b + §17.7 reconcile gateway) |
| All-server WALLOPS | both | WORKS (MR-2b CR-M 'W' + tree to legacy) |
| All-server GLINE/SHUN/ZLINE/JUPE | both | WORKS (doc-native cutover + §17.7 legacy-only re-emit) |
| Server-targeted (STATS/TRACE/SQUIT/CONNECT/MAP/LINKS) | — | OUT (tree-walking; MR-5 operator tooling) |

**⇒ MR-4's mandatory scope = the unicast CR→legacy bridge.** INVITE/KILL are same-shape follow-ons.

## 5. Hard problems (decided / deferred)

- **Multi-gateway loop — gate is MR-4-blocking (MR-4d), tiebreak deferred.** `fronted_by` is the loop
  signal; add `legacy_net_id` (configured, append-only beacon positional) + **deterministic establishment
  gating** at `server_estab` (lowest-gateway-numeric per `legacy_net_id` over the converged beacon set;
  agreement-by-rule, not consensus) + standby-promotion-on-stale-beacon + clean SQUIT-on-loss. The
  split-brain-both-healthy backstop (P10 SERVER-collision tiebreak) is deferred.
- **Ownership/lease (CRITICAL-2) — `fronted_by` makes the MR-3 lease concrete.** Non-empty `fronted_by` ⇒
  apply `CRDT_BEACON_STALE_PROXY` (longer) in Case-B + sweep. True handoff (standby takes over the
  proxy-beacon) is entangled with MR-4d.
- **HLC across legacy boundary — DECIDED (document; no code).** Gateway stamps legacy doc writes from its
  own `g_crdt.clock` (already true). Two gateways stamp differently ⇒ another reason single-gateway is hard-required.
- **Gateway SPOF/bottleneck — DEFERRED (note + measure via the oracle).**
- **Routing/bridge shadow-oracle — MR-4-BLOCKING (measure-first).** Per-class counters
  `cr_to_p10_bridged` / `dead_sink_dropped` / `flood_vs_routed` / `loop_detected`, surfaced via `/CRDT gateway`.

## 6. Phasing. Flags: `FEAT_CRDT_GATEWAY_BRIDGE` (bridge), `FEAT_CRDT_GATEWAY_GATING` (multi-gw), default off

- **MR-4a — dead-sink instrumentation (INERT). DONE + LIVE-VALIDATED 2026-06-17 (submodule `f7d35f5`).**
  `crdt_dead_sink_dropped` static counter + `log_write` "MR-4 dead-sink: CR-M %s for legacy user %s (on
  %s) dropped" at a new else-branch on the `m_crdt.c` 'M' unicast handler — detection of "a real legacy
  user we front" = `tgt && !MyConnect(tgt) && IsServer(tsrv) && !IsCrdtAware(tsrv) && cli_from(tsrv) &&
  !IsCrdtAware(cli_from(tsrv))` (`!IsCrdtAware(tsrv)` excludes anchors = SetCrdtAware). Lands at MR-4b's
  exact re-emit spot; no behavior change. **Validated:** two nef7-client PMs to AuthServ → exactly two
  drops on the gateway nef3 (`CR-M PRIVMSG for legacy user AuthServ (on x3.services) dropped`), fires only
  on the gateway, digest unaffected, 0 crashes. *Scope trim vs the original plan: the `fronted_by` beacon
  field + `/CRDT gateway` oracle moved to MR-4b — `fronted_by` is only USED there (route-to-gateway), so a
  beacon wire change now would propagate an unread field; the log line is sufficient for the 4a proof.*
- **MR-4b — the CR→P10 unicast bridge. HEADLINE. DONE + LIVE-VALIDATED 2026-06-17 (submodule `93bd33d`,
  log-level bump `<follow-up>`).** Only §3(c) re-emit + flag `FEAT_CRDT_GATEWAY_BRIDGE` (default off); §3(b)
  route-to-gateway/`fronted_by` **deferred to MR-4d** — proven unnecessary for single-gateway correctness:
  the CR-M flood already reaches the gateway, only the fronting node passes `!IsCrdtAware(tsrv)`, and
  `crdt_m_seen` dedups the flood per-node ⇒ exactly-once with no routing change. At the dead-sink branch,
  `sendcmdto_one(srcc, CMD_PRIVATE/NOTICE, tgt, "%C :%s", tgt, m_text)` (source `findNUser(srcyxx)`, gated
  `crdt_user_is_mesh_only` as R6b; else count the drop with a reason). TAGMSG deferred (its @tags unicast
  legacy form differs). **Validated** (x3 a synthetic anchor on far leaf nef7 ⇒ NO P10 path, so genuinely
  the CR→legacy bridge): nef7 client PMs AuthServ → full HELP reply returns. Gateway wire trace: inbound
  `CRDT M <id> P AIAAA DHAAC 32 :HELP` → re-emit `@<time> AIAAA P DHAAC :HELP` (source numeric preserved);
  `dead_sink_dropped`=0, digest converged (0 mismatch), 0 crashes. Bridge log bumped L_DEBUG→L_INFO so the
  re-emit shows in the SYSTEM log (testnet, per user).
- **MR-4c — INVITE + KILL (FLAG, same shape) + KILL-vs-trailing-msg ordering.**
- **MR-4d — multi-gateway prevent-by-construction (`FEAT_CRDT_GATEWAY_GATING`).** `legacy_net_id` +
  establishment gating + standby-promotion; SERVER-collision tiebreak a further deferred sub-step.

## 7. Validation (hybrid bed: nef3 gw ↔ legacy testnet↔x3↔upstream; nef4-7 CRDT, nef7 far leaf)

**Headline (MR-4b exit):** a CRDT user on **nef7 PMs AuthServ and gets a reply**, SERVER intro suppressed.
- Before MR-4b: PM silently dropped; `/CRDT gateway` on nef3 shows `dead_sink_dropped++`.
- After: PM delivers, reply returns; `cr_to_p10_bridged++`, `dead_sink_dropped`=0; mdigest still matches
  nef3-7 (bridge is ephemeral CR-M, never the doc). tcpdump nef3↔legacy shows the re-emitted P10 PM
  (sourced as the nef7 user behind the gateway); nef7 CR links show the 'M' frame **routed** (not flooded).

**Bed gotchas:** host = **nftables** → use `iptables-nft` in a `--cap-add NET_ADMIN nicolaka/netshoot
--net=container:<c>` sidecar (verify cut via ping). After a CRDT-node recreate, the legacy `.2`/x3 hold
stale links → `docker restart nefarious` + `/CONNECT testnet 4496` on nef3.

## 8. Residual hazards + pre-impl checklist

Hazards (ranked): [Crit] source attribution for a not-yet-presented mesh-only sender (use
`crdt_user_is_mesh_only` gate, define fallback); [Crit] multi-gateway loop if MR-4d lags MR-4b (gate the
bridge on the single-fronting-gateway test even before MR-4d); [High] exactly-once across the surviving
tree leg (dedup + `crdt_user_is_mesh_only` first-arrival idiom); [Med] `crdt_present_stub` must never
re-present a legacy-fronted anchor; [Med] KILL/trailing-msg ordering; [Low] append-only beacon parse.

Checklist: source-attribution fallback · `CRDT_BEACON_STALE_PROXY` value · `legacy_net_id` wire position +
warn-only(4b) vs gating(4d) · bridge flag granularity · fix INVITE/KILL in MR-4 vs defer to MR-5 · cmocka
truth table for the fronted-by next-hop re-target.

## 9. Corrections to `crdt-mesh-native-routing-scope.md` (source-verified)
- §4.3 "generalize §17.7 to all traffic" undersells it: unicast is a hard dead-sink (`m_crdt.c:646`), not
  a generalization — it needs a NEW re-emit branch (channel/all-server already work).
- §5 "Unicast user" row: a legacy target's anchor has `peers="*"` → unroutable (excluded from mesh-map,
  `crdt_shadow.c:128`) → the `fronted_by` primitive is REQUIRED, not covered by MR-1.
- §5 all-server row: GLINE/SHUN/ZLINE/JUPE are now doc-native cutover features with their own §17.7
  legacy-only re-emit — MR-4 only ensures the legacy *server* still gets the -line (it does).
- §7 item 7 ("reuse servers ACTIVE/SPLIT") = the proven-non-convergent path; MR-4 lease rides the beacon
  `fronted_by`, never the servers map.

## 10. MR-4c — INVITE/KILL CR→legacy bridge (source-grounded, Plan-agent pass 2026-06-17)

Same shape as MR-4b but INVITE/KILL are NOT on the CR-M carrier — they P10-route toward the anchor (a
STAT_MESH_SERVER dead sink) and die on the originating leaf. Fix: ride them over CR-M to the gateway, re-emit
as P10 there. The CR-M relay arm forwards ANY `<cmd>` verbatim + `crdt_m_seen` dedups by msgid, so new cmd
codes `'I'`/`'K'` need NO relay change — only new gateway re-emit branches. **`crdt_route_unicast_try` is
reused directly** (it already takes `cmd` and is purely mechanical — no need for a separate helper). Reuse
`FEAT_CRDT_GATEWAY_BRIDGE` (no new flag). **Predicate for "victim/target is a fronted legacy anchor user" =
`crdt_user_is_mesh_only(x)`** (= `IsMeshStub(srv) && !IsPresented(srv)`).

**Dead-sinks (confirmed):** INVITE `m_invite.c:213` (`sendcmdto_one(...CMD_INVITE...)` → anchor dead-sink);
KILL `m_kill.c:135` (`sendcmdto_serv_butone` → anchor not in `cli_serv(&me)->down`) PLUS a ghost-kill bug at
`m_kill.c:176` (`exit_client_msg` removes only the LOCAL copy → diverges till reconcile re-materializes).
Reverse (legacy-origin → CRDT target) already WORKS via P10 on the gateway — MR-4c is forward-only.

**MR-4c-1 KILL — DONE + VALIDATED 2026-06-17 (FIRST, fixes the ghost-kill divergence):** hook in `do_kill`
after `log_write_kill`: `if (!MyConnect(victim) && FEAT_CRDT_GATEWAY_BRIDGE && crdt_user_is_mesh_only(victim))
{ generate_msgid(kmid); crdt_route_unicast_try(sptr,'K',victim,kmid,msg); return 0; }` — routes over CR-M +
SKIPS the local exit (the doc-driven teardown is the SOLE authority). Gateway re-emit (`m_crdt.c` MR-4b
branch, new `'K'` dispatch): `sendcmdto_one(srcc, CMD_KILL, tgt, "%C :%s!%s %s", tgt, cli_name(&me),
cli_name(srcc), m_text)` (path mirrors do_kill's relay). **Teardown (traced):** gateway re-emits → legacy
removes user + QUITs back over the legacy link → gateway `exit_one_client`→`crdt_shadow_user_remove`:
`from_crdt_peer(cli_from)` is FALSE (legacy uplink) → writes `crdt_user_remove` tombstone → floods → far
leaves `reconcile_user_removes` `exit_client` the anchor copy. Inert until the flag (flag off = today's
behaviour incl. the latent ghost-kill). KILL hazards: ordering benign (document), no mass-kill (single
findNUser, no wildcard), no doc write on forward (pure transport), msgid via `generate_msgid` (NOT `"*"` —
distinct KILLs must not dedup).

**MR-4c-2 INVITE — DONE + VALIDATED 2026-06-17 (`a7cb3f5`). ⇒ MR-4c COMPLETE.** As designed below: hook the remote-target relay `m_invite.c:213`
(`if (!crdt_route_unicast_try(sptr,'I',acptr,inv_msgid,chptr->chname)) sendcmdto_one(...)`); gateway re-emit
`'I'`: `chptr=FindChannel(m_text)`; if live `sendcmdto_one(srcc, CMD_INVITE, tgt, "%s %H %Tu", cli_name(tgt),
chptr, chptr->creationtime)` (reconstruct `%Tu` from the gateway's OWN channel, NOT the wire) else fall back
to `"%C :%s"` (non-existent-channel form, `ms_invite.c:324`). invite-list write belongs on legacy (its
`ms_invite` runs `add_invite` since the target is local there) — CRDT side never calls add_invite for a
remote target. `RPL_INVITING`/invite-notify to the inviter stay local.

**Validation:** connect a real legacy user to `nefarious`(.2, port 6667). nef7 oper `KILL legacyguy :x` →
wire: nef7 CR-M `K`, gateway L_INFO "MR-4 bridge: CR-M KILL …", nef3↔legacy P10 KILL, legacyguy disconnects,
anchor copy vanishes on all CRDT nodes via tombstone, 0 crash. Negative (flag off): "dead-sink … KILL …
dropped (bridge off)", legacyguy survives.
