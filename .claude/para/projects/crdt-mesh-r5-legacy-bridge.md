# R5 — gateway becomes the live-traffic legacy bridge (design)

Goal (roadmap R5): make the §17.7 gateway bridge LIVE traffic (PRIVMSG/NOTICE/TAGMSG) between the CR-M
mesh and legacy P10 peers, so legacy interop no longer needs the P10 tree as the PRIMARY transport.
Demo: legacy nef1 + CRDT peers; a legacy user messages a CRDT user (and vice versa) ACROSS a partition,
bridged. Prereq R4 (live traffic over the mesh) is COMPLETE. Started 2026-06-11.

## What's already done (don't rebuild)
- **Legacy → CRDT** live traffic: handled by R4a's entry-point flood — a CRDT server that receives a
  channel msg from a NON-CRDT direction (`!IsCrdtAware(one)`) floods CR M into the mesh
  (ircd_relay.c server_relay_channel_message/notice, m_tagmsg ms_tagmsg). ✓
- **Event model → legacy** (users/channels/topics/modes/members/KICK/QUIT): already gatewayed via the
  §17.7 pattern (drive the doc change through the real handler; its now-legacy-only P10 relay emits to
  legacy, forbidding CRDT-aware via `sendcmdto_flag_serv_butone(..., FLAG_CRDT_AWARE, ...)`). SQUIT
  stays P10 (§17.3, deferred). So removals/QUIT/KICK already reach legacy. ✓
- So R5's genuinely-new piece is **CR-M (ephemeral live message) → legacy P10**.

## The new piece: CR-M → legacy bridge
Live messages are EPHEMERAL (CR M, not doc state), so the "drive through the real handler" pattern does
NOT apply — there's no doc op. The bridge must live in the **CR-M receive handler** (m_crdt.c, the 'M'
case): when delivering a channel/unicast message, ALSO emit a P10 PRIVMSG/NOTICE/TAGMSG to LEGACY
server-directions that have members (mirroring the topic gateway's `sendcmdto_flag_serv_butone(...,
FLAG_CRDT_AWARE, ...)` — emit to servers, skip CRDT-aware).

## THE CRUX (why R5 is L-sized + entangled with R6): steady-state double-delivery to legacy
In R4 the P10 tree is still PRIMARY and STILL carries live traffic to legacy (sendcmdto_channel_butone
relays to ALL directions with members, including legacy). If R5 also bridges CR-M → legacy, a legacy
member gets BOTH the tree copy AND the gateway copy → double. And we CANNOT dedup at the legacy member
(it's on a server we don't control — no crdt_chan_local there).

The arrival-order analysis:
- The crdt_chan_local dedup (R4a) gates the bridge for "tree arrived first": if THIS server already
  saw the msgid via the tree, the tree already relayed to its legacy directions → skip the bridge. ✓
- BUT "CR-M arrived first, tree second": the bridge fires (legacy via gateway), THEN the tree copy
  arrives and its RELAY to legacy directions fires too (the tree RELAY is NOT dedup-gated — only LOCAL
  delivery is, via skip_local) → DOUBLE to legacy. ✗

So a clean steady-state R5 needs ALSO gating the tree's *legacy relay* by msgid — a deeper change than
R4a's local-delivery gate (the relay path inside sendcmdto_channel_butone). This is exactly what R6
(demote the P10 tree to legacy-only / stop the tree carrying CRDT-origin live traffic) resolves: once
the tree no longer carries CRDT-origin live traffic among CRDT peers, the gateway is the SOLE CR→legacy
path and there's no double.

→ **R5 and R6 are naturally one unit for the steady-state case.** Three ways to proceed:

### Options
1. **Partition-scoped R5 (smallest demo).** Bridge CR-M → legacy ONLY when the tree path to that legacy
   peer is down (this server received the msg via CR-M, not the tree — the crdt_chan_local "CR-M was
   first/only arrival" signal). In steady state (tree up) the tree handles legacy, the bridge is inert;
   across a partition the bridge fires. Caveat: the "CR-M first, tree later" race can still double if the
   tree transiently recovers mid-message — acceptable for the partition DEMO (rare, and netsplit
   semantics tolerate it), but not a clean steady-state guarantee. Lowest code; proves the roadmap demo.
2. **Merge R5+R6 (the clean path).** Build the CR-M→legacy bridge AND demote the tree for CRDT-origin
   live traffic together: among CRDT-aware servers, suppress the tree's live-traffic relay (so CR-M is
   the sole carrier + the gateway is the sole legacy bridge). No double by construction. Bigger; needs
   the tree-relay suppression (the R6 piece — gate sendcmdto_channel_butone's SERVER relay to skip
   CRDT-aware directions for CRDT-origin live traffic, keeping legacy directions to the gateway). This is
   the proposal's real trajectory; L→XL.
3. **Defer R5/R6.** R4 already delivers the headline (live traffic over the mesh, tree as backup); the
   tree-as-primary-for-legacy is fine until there's a concrete need to retire it. Park R5/R6 behind the
   services-fold (R7's gate) — they only matter for the all-CRDT-network endgame.

## Recommendation
Given R4 is the demonstrable headline and R5's clean form is really R5+R6 (tree retirement — the
endgame), the highest-value-per-risk path is **Option 1 (partition-scoped bridge)** as a *demo* of
legacy-across-partition bridging, OR **Option 3 (defer)** if we'd rather consolidate effort toward the
services-fold (the actual gate for full P10 retirement). Option 2 (merge R5+R6) is correct but is the
big tree-retirement lift and shouldn't be rushed.

## First slice (if Option 1)
In the CR-M 'M' handler, after the (non-dup) local delivery, if `!IsCrdtAware`-gateway has legacy
directions with members for the channel/target, emit the P10 PRIVMSG/NOTICE/TAGMSG to them via
`sendcmdto_flag_serv_butone(..., FLAG_CRDT_AWARE, ...)` — gated to fire only on a CR-M-first arrival
(the tree didn't deliver here). Test: 2-CRDT + 1-legacy topology, cut the legacy↔CRDT tree edge, a CRDT
user messages a channel with a legacy member, confirm the legacy member receives it via the bridge,
exactly once, and steady-state (tree up) shows no double.

## RESULT (2026-06-11): Option 1 BUILT + TESTED → BLOCKED by a hard P10 wall → DEFERRED to R6

Option 1 (partition-scoped bridge) was implemented and tested on the live 5-node mesh, then
**reverted** (decision: "Document + defer to R6"). It cannot deliver a partition-side user's live
traffic to legacy with faithful source identity. The reason is architectural, not a bug.

### What was built (now reverted, working tree back at R4a `9b5966f`)
- `m_crdt.c` CR-M 'M' channel branch (inside the `!crdt_shadow_chan_local_check_add` "CR-M was the
  first arrival here" block): `if (ch && !is_tag) { srcc = findNUser(srcyxx); if (srcc) {
  crdt_shadow_bridge_intro_legacy(srcc); sendcmdto_flag_serv_butone(srcc, CMD_PRIVATE/NOTICE, ...,
  FLAG_CRDT_AWARE, "%H :%s", ch, m_text); } }`.
- `crdt_shadow_bridge_intro_legacy(nc)` (crdt_shadow.c) — a copy of `crdt_gateway_user_intro`'s
  two-call FLAG_IPV6 server-sourced NICK but WITHOUT the `IsMeshStub` skip, windowed-idempotent
  (dedup by user numeric, 90s). The intent: announce the mesh-only sender to legacy so the bridged
  PRIVMSG isn't dropped as an unknown source.

### Why it can't work (evidence: 3 live probes + a tcpdump wire capture, see /tmp/crdt4c/r5probe*.sh)
Topology used: legacy `testnet`(.2, CRDT-off) — nef3 `hub2`(.6, gateway) — dense CRDT mesh
nef3/nef4(.7)/nef5(.9)/nef6(.14)/nef7(.15). Cut = iptables DROP on the nef3↔nef4 edge only; nef4
stays mesh-reachable via nef5/nef6.

1. **Cut → nef3 removes nef4's users from legacy via per-user `Q :Quit`** (wire-confirmed: the
   nef3↔legacy S2S link carried `… AEAAP Q :Quit`, plus only PING/PONG — no SQUIT, no NICK, no
   PRIVMSG). So after the cut, `WHOIS <sender>` on legacy = `401 No such nick`.
2. **Tier-1 re-materializes those users on nef3 as mesh-stub users** (`WHOIS <sender>` on nef3 =
   found, shown `@#r5`). So `findNUser(srcyxx)` does eventually succeed on nef3.
3. **But the bridge never reaches legacy.** The wire capture during the flood showed nef3 emitting
   nothing to legacy except keepalives — no bridge NICK, no bridge PRIVMSG. Two compounding reasons:
   (a) a **timing gap** — the re-materialize runs on the periodic reconcile (verify timer), not
   synchronously at cut, so during the message burst `findNUser` is often still NULL; and (b) the
   **fundamental P10 wall** — even with a valid mesh-stub `srcc`, neither a NICK nor a PRIVMSG
   sourced from it is routable to legacy, because the sender's **owning server (nef4) was removed
   from legacy's tree**. A P10 user numeric encodes its server; legacy cannot place a user whose
   server it doesn't have. This is *exactly* why `crdt_gateway_user_intro` (crdt_shadow.c:~1306)
   **deliberately** `return`s on `IsMeshStub(srv)` — the original author already knew mesh-stub →
   legacy user-intro is unsupported. The R5 `bridge_intro` just re-emitted the same un-routable NICK.

The control always passed: the on-mesh receiver (cr on nef5) got 20/20 — CR-M flows fine over the
mesh; CR-M local delivery uses the converged **doc record** (`crdt_shadow_user_record`), which needs
no live Client and no legacy server-presence. Only the **legacy P10 bridge** hits the wall.

### The real requirement (→ R6)
Faithful cross-partition bridging to legacy requires **presenting the partitioned server to legacy
as a P10 subtree behind the gateway** (`:hub2 SERVER nef4 …` → legacy, then users via the existing
gateway with the IsMeshStub skip dropped, then live traffic routes normally), and on relink
**SQUIT-ing the presented server from legacy before the real one returns** (collision handling).
That is the R6 "tree-demote / gateway-as-boundary-router" lift, not a contained R5 demo.

### Status
- **Legacy → CRDT** live bridge: DONE (R4a entry-point flood). ✓
- **Event model → legacy** (users/channels/topics/modes/members/KICK/QUIT): DONE (§17.7 gateway). ✓
- **CR-M (live message) → legacy** for a **partition-side** sender: **BLOCKED by design**, deferred
  to R6. (Steady-state CR-M→legacy would also need the R6 tree-relay suppression to avoid double —
  see "THE CRUX" above; so R5's clean form was always R5+R6.)

## Constraints (standing)
Submodule push to `origin crdt-mesh`; testnet pointer staged ONLY as `nefarious-crdt`; `Co-Authored-By`
trailer; cmocka gates the image; verify the `ircd.YYYYMMDDHHMM` symlink advances per build.
