# CRDT-Mesh Tier C — correctness gaps over the retired tree (consolidated scope)

> SCOPED 2026-06-18, source-grounded @ `e5cd75c` (crdt-mesh) via two read-only agent passes:
> bouncer-analyst (5-5e bouncer) + general-purpose (CH 5-5f + C1/C3/C4 + the BATCH unknown).
> Consolidates the Tier C rows from `crdt-mesh-s2s-gap-audit.md` (C1–C5) and `crdt-mesh-mr5-tree-
> retirement.md` §9 (5-5e/5-5f) into one actionable plan. **Scope only — no code this turn.**
> Tier C = the **P1 band** (gate for CRDT carrying PROD traffic; P10 still present as fallback).

## 0. Headline findings (read first)

1. **★ The bouncer gap is BIGGER than the audit recorded: BS session-state convergence is ALSO
   broken, not just targeted BX.** The audit said "BS = broadcast → WORKS." That holds only on a
   *full* mesh. The bed is a **partial mesh** (e.g. `leaf2`/ircd4 and `leaf5`/ircd7 have no direct
   Connect block). BS uses `sendcmdto_serv_butone_v3` → walks `cli_serv(&me)->down` (`send.c:2020`);
   the CR-only overlay links and the MR-5-suppressed multi-hop CRDT servers are **not** in `->down`.
   So across a multi-hop-only CRDT pair, BS (and BX C/X/U/V, the alias-Client create/destroy
   broadcasts) **never arrive** → on the far leaf the alias is doubly absent (not in the doc by
   deliberate exclusion, AND never created as a live Client). Every targeted BX E/M/K to it then
   dead-sinks on top of that. **⇒ 5-5e is "converge session+alias state across the mesh, THEN deliver
   fan-out tokens," with BS convergence as the load-bearing prerequisite.**
2. **This is a gated DATA POINT, not yet a settled fact** — it must be MEASURED before any bouncer
   code (5-5e-0 below). The single measurement that reshapes the whole bouncer plan: *on ircd7, does
   `bounce_get_session` for a `leaf2`-hosted account show a populated alias roster under
   `FEAT_CRDT_TREE_RETIRE=on`?* Empty ⇒ BS-convergence-first (the big plan); populated ⇒ the bed's
   partial mesh still has a usable P10 path and the gap narrows to targeted-BX-only.
3. **Two rows shrink to ~free:** **C3 (targeted REDACT)** is broadcast-covered + folds into CH — no
   standalone work. The **BATCH_CMD `route_to` unknown** is resolved: all 4 sites are `MyConnect`-
   guarded → always local → **not a Tier C concern**.
4. **One row degrades:** **C4 (remote OPER)** is bidirectional dead-sink (request + reply numerics);
   recommend **accept-degraded** (doc-only) for P1 — works against any reachable server; cheap to add
   later as an MR-4c widening if wanted.
5. **Global hazard (every new re-inject/re-emit site): Invariant 2** — a frame re-injected with a
   source prefix that resolves to a `STAT_MESH_SERVER` (`cli_user==NULL`) must not hit an
   `IsServer`-exact `%C` branch → SIGSEGV. Run **c-auditor** on every new reinject site before merge.

## 1. The carriers (what each row routes over)

The one discriminator (per the gap audit): **broadcast** (`sendcmdto_serv_butone[/_v3]`, iterates
`->down`) never touches an anchor → WORKS; **targeted** `sendcmdto_one` to an anchor-resolved
server/user dead-sinks (fd=-1). Existing mesh carriers (all on `CMD_CRDT_REPLICATION`, dedup via
`crdt_m_seen`, TTL `CRDT_M_TTL_DEFAULT=32`):

- **CR-M** (`m_crdt.c` `crdt_route_unicast_try`, 'M' arm) — **user-unicast**, NumNick-target, routes by
  CR next-hop, delivers via `findNUser`+`MyConnect`, reconstructs a `nick!user@host` text line.
  Cmd codes today: P/N/T (PM/NOTICE/TAGMSG), K (KILL), I (INVITE), W (WALLOPS).
- **CR-X** (`crdt_services_emit`/`reinject`) — **server-numeric-routed, opaque verbatim P10 body**,
  flood+dedup, re-injects the body into a server handler. The Tier B services bridge.
- **NEW proposed:** **CR 'B'** (bouncer) + **CR 'C'** (chathistory) — both modeled on **CR-X**
  (opaque-body, server-routed, re-inject), NOT on CR-M's text model. Consider generalizing CR-X into
  one opaque-body re-inject carrier with a payload-handler tag rather than three near-identical arms.

**THE routing-predicate lesson (cost a live bug):** route on `crdt_route_unicast_try` / `IsMeshStub`,
**never** gate CR routing on `crdt_user_is_mesh_only` (= `IsMeshStub && !IsPresented`) — it returns
false for a gateway-PRESENTED stub that still dead-sinks. Pattern everywhere:
`if (!crdt_route_*_try(...)) sendcmdto_one(...)`.

Flags: reuse `FEAT_CRDT_TREE_RETIRE` (the guard these react to) + `FEAT_CRDT_GATEWAY_BRIDGE` (re-emit)
+ `FEAT_CRDT_ROUTE_UNICAST` (CR-M). No new per-subsystem flags.

## 2. Per-row scope

### C5 / 5-5f — CHATHISTORY federation over CR (the keystone; PROD-RELEVANT; build L)
Store is **local-witness-gated** (`has_local_interest`, `ircd_relay.c:169-195`) → each node stores only
what its members witnessed; cross-node gaps fill via federated `CH Q`→reply. **This is correctness
(history completeness), not redundancy** — and tree-retirement turns previously-fillable gaps into
permanent holes (a regression it introduces).
- **Dead-sink sites** (`FindNServer`→anchor): `m_chathistory.c:3781-3808` (`start_fed_query`),
  `:1967-1983` (TARGETS), `:4204-4220` (auto-replay). Plus intermediate Q re-forward `:4388-4394`.
- **Degraded (direct-link only, not dead):** `:4058-4068` (REDACT fed Q), `:4415-4435` (legacy Q-prop).
- **Machinery:** `struct FedRequest`/`fed_requests[64]`; **reqid = `cli_yxx(&me)`+counter (`:3738`) —
  originator-tagged**; `servers_pending` pre-counted (`:3753`), decremented per `E` (`:4779`)→0⇒
  `complete_fed_request`; reply routing = pure P10 prefix to `sptr` (R/Z/B/T/E at `:4564/4589/4663/
  4743/4761`); **WB chunk reassembly** `struct ChunkEntry` keyed `reqid:msgid` (`:2223-2235,4714`);
  **timeout safety net** `fed_timeout_callback` (`:3558-3585`) ⇒ a dead-sink does NOT wedge but blocks
  the FULL `FEAT_CHATHISTORY_TIMEOUT` (the latency the band-aid fixes).
- **Treatment:** model on CR-X. Forward: gate `IsMeshStub` at the 3 query sites → tunnel the verbatim
  `Q …` body toward the storage server numeric → re-inject into `ms_chathistory`. Reply: route back by
  **the origin numeric embedded in the reqid prefix** (no new correlation state needed) → re-inject.
- **Hard parts:** chunk reassembly over a **lossy/unordered flood** (add an explicit chunk index/total
  so a missing middle chunk is *detectable*, not silently decoded to garbage — today `chunk->link=cptr`
  assumes a stable P10 link); dedup keyed on the **carrier frame msgid, not the reqid** (reqid spans
  many frames); `servers_pending` accounting when a server is tunneled-to vs skipped.

### 5-5c — CH band-aid (do FIRST; build S; composes with 5-5f)
NOT present in the tree today. Skip `server_ads[]` entries whose `FindNServer` resolves `IsMeshStub` in
the 3 query loops (`:3790,1975,4213`) + matching guard in `count_storage_servers` (`:3628`). Converts
the full-timeout latency-wedge into an immediate (incomplete) answer. 5-5f later flips each skip into a
tunnel — strictly a `servers_pending` correction, no conflict.

### C2 / 5-5e — BOUNCER over the mesh (PROD-BLOCKER; needs the §0.2 measurement first)
See §0.1 — the gap includes **BS/BX-structural convergence**, not just targeted BX.
- **Targeted dead-sinks** (re-verified @ e5cd75c): BX E `bouncer_session.c:6367,6384,8235`,
  `m_batch.c:1326,1374`; BX M `m_batch.c:351-374` (`emit_bxm_to_remote_member`),
  `bouncer_session.c:8820-8829` (`forward_bxm_line`); BX K `bouncer_session.c:6835`. **Latent (no
  MyConnect gate):** `bounce_forward_pm_to_aliases` `:6298-6303` — dead-sinks an anchored alias as a
  *user-format PM* (the recipient's own conversation silently lost), NOT covered by the existing
  `mesh_delivered` skip.
- **Broadcast-that-doesn't-cross-the-mesh:** BS (`:3718,3750,…`) + BX C/X/U/V (`:5952,915,4679,…`).
- **Alias-addressability DECISION = (a) CR route by numeric to the alias's home node.** CR routing is
  by `cli_user(tgt)->server` numeric + `findNUser`+`MyConnect` delivery — **orthogonal to the doc**, so
  the deliberate alias doc-exclusion is NOT an obstacle. **Reject (b)** relax the doc-exclusion (a
  doc-born alias = a non-MyConnect Client introduced without BX C → violates the alias intro invariant
  + single-home/single-socket vs LWW-convergent → invites multi-primary divergence; verify oracle
  `crdt_shadow.c:1807` would mismatch on every alias) and **(c)** a bouncer-presence beacon (wrong tool
  for high-cardinality mutable per-account state; degenerates to "BS over a 2nd transport" = divergence).
- **Design:** (3.1) new **CR 'B'** carrier (opaque BS/BX body, flood+dedup, re-inject into
  `bounce_handle_*` with `cptr`=CR uplink, **preserving the true source prefix as sptr**) for BS + BX
  C/X/U/V convergence; (3.2) `crdt_route_bx_try(tgt, body)` for the targeted BX E/M/K sites (the
  `if(!try)sendcmdto_one` pattern). **3.1 likely makes 3.2 mostly unnecessary** — once the alias exists
  + BS converged on the far leaf, the originating node fans out locally (like today's `mesh_delivered`
  skip); 3.2 shrinks to the `!MyConnect` forward sub-cases. **Settle via the 5-5e-0 spike.**
- **Invariant verdicts (no break, but care):** #3 re-inject MUST carry the original source prefix (not
  a mesh-rewritten one) — stale origin = live-session hijack; #8 re-inject `sptr`/`cptr` must match a
  normal P10 arrival exactly (cptr/sptr confusion = `cli_user(server)==NULL` SIGSEGV); **#7 secondary
  gap** — a BS-C reconcile yield whose loser is an *alias* exits via a normal Q that **won't
  tombstone-propagate** (aliases doc-excluded) → alias-loser cleanup needs **BX X over CR 'B'**.
- **Riskiest:** the 5-5e-1 re-inject `sptr`/`cptr` reconstruction (sits on #3 + #8 simultaneously —
  the two worst historical failure modes). Get it byte-exact via round-trip cmocka before any live run.
- **Hazards:** BX-before-BS/BX-C reorder (existing `defer_bx_for_alias` replay covers it — verify the
  drain `bx_drain_in_progress:9132` fires on a CR-'B'-delivered BX C); multi-gateway double-delivery
  (CR 'B' must carry a msgid + dedup like CR-M; MR-4d `should_standby` election is the precedent);
  hold/revive-across-mesh reconcile depends on BS fully converging first (highest-risk live case);
  never global-burst-gate the re-inject (NB12) — scope any guard per-session.
- **Phasing:** 5-5e-0 spike/measure (0.5d, **gates everything**) → 5-5e-1 CR 'B' carrier (1.5–2d) →
  5-5e-2 alias-loser BX X cleanup + defer/replay (1d) → 5-5e-3 targeted `crdt_route_bx_try` *if still
  needed* (1d) → 5-5e-4 live validation on leaf2↔ircd7 + hold/revive matrix (1d).
- **Validation:** cmocka (`crdt_route_bx_try` truth table incl. a regression that it never keys on
  `crdt_user_is_mesh_only`; CR 'B' dedup; body+source round-trip). Live: non-adjacent pair
  leaf2↔ircd7, account user with primary on leaf2 + a 2nd connection (alias); assert the alias roster
  converges on ircd7, PM echo / multiline / snomask reach every connection, hold/revive converges to
  one winner with no phantom on ircd7, alias-loser is cleaned up; oracle: verify mismatch stays 0
  (aliases still excluded), 0 crashes, `crdt_dead_sink_dropped` does not increment for BX.

### C1 — MULTILINE PM (+ channel multiline) federation (build M)
- **Dead-sinks** (`cli_from(target)`→anchor): `m_batch.c:1413-1446` (remote DM-target PM),
  `:1198-1248` (remote alias forward), **`:1522-1571` (CHANNEL multiline per remote member — a real
  hole NOT covered by the R4a CR-M channel flood, because channel multiline goes through m_batch/
  `ms_multiline`, not `ircd_relay.c`)**, `:2328-2360` + `:2536-2566` (`ms_multiline` legacy/re-relay).
- **BATCH_CMD unknown RESOLVED → NOT Tier C:** `m_batch.c:247/269` are in `deliver_multiline_dm_to_one`
  which returns early at `:221` on `!MyConnect(route_to)`; `:2289/2308` are `MyConnect`-guarded at
  `:2265`. All 4 always local.
- **Treatment:** the fn already has a per-line PRIVMSG fallback (`:1251-1268,1447-1468,1572-1584`) → at
  the remote-target sites, gate `crdt_route_unicast_try`/`IsMeshStub` and deliver **per-line over CR-M
  'P'/'N'** (reuses the existing fallback loop + existing carrier codes), NOT a batch-wrapper tunnel.
- **Hazard:** the channel relay (`:1522`) per-member loop must dedup (mirror the `ircd_relay.c` R4a
  `crdt_shadow_chan_local` pattern) to avoid double-delivery against any tree copy.
- Unicast PM site `:1413` is an S quick-win; channel+alias is the M part.

### C3 — Targeted REDACT — COVERED, no standalone work (build: none)
`m_redact.c:90/92` are `!MyUser`-guarded local delivery; `:323/431` are `sendcmdto_serv_butone_v3`
broadcast (works); `m_chathistory.c:3962/3965` local-guarded, S2S at `:3974` is broadcast. The only
dead-sink is the fed msgid-lookup `Q … X` (`:4067`) which folds into C5. **Live+propagated REDACT is
fully broadcast-covered; the fed sub-path is closed for free by the C5 fix.**

### C4 — Remote OPER — ACCEPT-DEGRADED for P1 (doc-only; optional M later)
`m_oper.c:489` (`/OPER server`, `FindServer`→`sendcmdto_one CMD_OPER`) + `:545` (`ms_oper` forward,
`FindNServer`). **Bidirectional dead-sink** — even forced through, the YOUREOPER + `+o`/snomask MODE
reply numerics route back to the oper's client (an anchor on the home) and dead-sink. Low-freq,
oper-initiated, works against any directly-reachable server → degrade now, document. If promoted: widen
MR-4c's client-targeted `'K'`/`'I'` pattern (request → home server numeric; reply numerics → oper
client numeric over CR-M; correlation is stateless — no reqid table).

## 3. Recommended implementation order + costs

1. **5-5c** CH band-aid (S) — stops the fed latency-wedge; composes with 5-5f.
2. **C1 unicast multiline PM** `m_batch.c:1413` (S) — drop-in `crdt_route_unicast_try` + per-line CR-M.
3. **C1 channel + alias multiline** `:1522`/`:1198` (M) — per-member CR-M with R4a-style dedup.
4. **5-5e bouncer** — BUT do **5-5e-0 (measure §0.2)** before 1–3 if convenient (it's read-only and
   reshapes the biggest row). Then 5-5e-1…4. (L; PROD-BLOCKER; bouncer-analyst scope above.)
5. **C5 / 5-5f** full CH federation over CR (L; keystone) — closes C3's fed sub-path for free.
6. **C4** remote OPER — accept-degraded (doc-only) now.

Quick wins: 5-5c, C1-unicast. Free: C3. Deep: 5-5e, 5-5f. Degrade: C4. **Every new reinject/re-emit
site → c-auditor for the Invariant-2 `%C`/STAT_MESH_SERVER crash before merge.**

## 4. Open questions / data to gather BEFORE code
- **★ 5-5e-0 (gates the bouncer plan):** measure whether BS converges to a non-adjacent CRDT pair under
  `FEAT_CRDT_TREE_RETIRE` today (ircd7's alias roster for a leaf2 account). Also confirm whether the
  CR-only overlay links carry `sendcmdto_serv_butone` broadcasts at all, or only `CMD_CRDT_REPLICATION`
  (if overlay-only, BS genuinely can't cross them → 3.1 mandatory).
- Confirm there is currently NO instrumentation catching the BX dead-sink (BX uses
  `CMD_BOUNCER_TRANSFER`, not `CMD_CRDT_REPLICATION`, so it dead-sinks at `sendcmdto_one` before any CR
  arm; `crdt_dead_sink_dropped` won't see it). A read-only BX dead-sink probe may be worth a 5-5e-0a.
- Decide CR 'B' + CR 'C' as separate arms vs generalizing CR-X into one tagged opaque-body carrier.

## 4b. ★ DEEP-DRILL EMPIRICAL FINDINGS (2026-06-18) — supersede the conflicting code-traces

Two follow-up agent passes (bouncer transport + CH internals) PLUS a live 5-5e-0 measurement. The live
measurement is ground truth and **overturns a confident code-trace**, so it governs.

### 5-5e-0 RESULT (measured, decisive): bouncer session convergence is SPLIT-BRAIN under TREE_RETIRE
Method: `testadmin` via SASL on a CRDT node + `BOUNCER SET HOLD on` (the actual session-create trigger —
NOT a bare authenticated connection; a connection-class/`draft/bouncer` thing is NOT required, `SET HOLD`
is), then `BOUNCER LISTSESSIONS *` (oper) on each node, comparing the session-id.
- ircd4 (leaf2) session `AZ7cJWoJ…`; **hub2/ircd3 (adjacent) shows the SAME id** → converges one hop.
- ircd7 (leaf5) session `AZ7cJwJN…` (a DIFFERENT id); **leaf3/ircd5 (adjacent to ircd7) shows that SAME
  `AZ7cJwJN…`**. So two ISLANDS: `{ircd4,hub2}` vs `{leaf3,ircd7}` — a SPLIT-BRAIN session for one account.
- The clusters did NOT merge **even though hub2↔leaf3 is a live direct P10 link** (`/MAP` on hub2 lists
  leaf3 as a tree child). ⇒ BS reaches only the **origin's direct P10 neighbours (~1 hop); it is NOT
  flooded onward** between CRDT-aware peers under TREE_RETIRE.

### Resolves the agent conflict
- The first bouncer pass ("BS convergence broken on the partial mesh") is **VALIDATED** (the outcome is
  real) — though its "the alias is doubly absent / not in `->down`" reasoning was imprecise.
- The deep bouncer pass ("BS CONVERGES at rest; the P10 relay tree is intact; CR 'B' is partition-only")
  is **EMPIRICALLY REFUTED.** Its `->down` hop-by-hop trace assumed the re-broadcast floods the whole
  tree; live data shows it does not (stops after one hop between CRDT peers). **Do not act on "converges
  at rest."** CR 'B' (BS/BX over the CRDT sync mesh) is **REQUIRED AT REST**, not just under partition.

### ★ BIGGER IMPLICATION (new, P0 re-audit): the gap audit's "broadcast = SAFE" premise is VIOLATED
`/MAP` on hub2 = `{hub2, leaf3, leaf2, testnet, upstream, x3}` — **leaf4/leaf5 are ABSENT** (intro-
suppressed → reachable only as overlay anchors). So under TREE_RETIRE the **P10 tree is FRAGMENTED**; a
`sendcmdto_serv_butone[/_v3]` broadcast reaches only the emitter's P10-tree component, NOT every node.
The gap audit's core discriminator ("BROADCAST iterates `->down` → never touches an anchor → WORKS")
holds only for a *connected* P10 tree — which TREE_RETIRE does not provide. **Therefore every "broadcast
= SAFE/WORKS" classification (the audit's whole "Verified SAFE" list: SVS\*, SWHOIS, MARK, AWAY, SNO/SMO,
OPMODE, CLEARMODE, DESTRUCT, broadcast REDACT, QUIT, etc.) is SUSPECT for overlay-only nodes** — any
pure-P10 broadcast NOT also doc/CR-carried will island. (Doc/CR-carried state is fine: the CRDT doc
converges across all 8 nodes, digests/0-mismatch — that's why users/channels/modes/glines are unaffected.)
**Action: re-audit the SAFE list — for each, is it doc/CR-carried (fine) or pure-P10-broadcast (islands)?**
This likely ADDS rows to Tier C/D/E and is the highest-value next analysis.

### CH deep-drill (de-risks C5; from the CH internals pass) — all confirmed source-grounded
- **CR-X wire actually carries the origin numeric**: `X <msgid> <srcSrvYXX> <dstSrvYXX> <p10cmd> <ttl>
  :<body>` (the `m_crdt.c:409` doc-comment is stale). So CH replies route back trivially.
- **Reply routing**: reqid = `cli_yxx(&me)`+counter = the ORIGINATOR's numeric, intact everywhere →
  the reply node sets CR-C `dstSrvYXX = reqid[0..1]` → flood-by-dst + dedup; intermediates DON'T re-parse
  reqid; exactly one node (origin) re-injects; unknown/timed-out reqid = clean no-op (existing NULL guard).
- **Chunk reassembly = THE keystone risk**: the federated REPLY uses the CH **B** chunker (NOT WB — WB is
  write-forward). Today completeness = "absence of trailing `+`" + blind arrival-order append → over a
  lossy/unordered flood a reordered/lost-middle chunk **silently decodes truncated garbage and
  `add_fed_message`s it** (silent data corruption). FIX (must land WITH the tunnel): add `(seq, nchunks)`
  + a `got_mask` bitmap to `ChunkEntry`, retire `+`, complete ⇄ mask full, holed ⇒ **log+drop (NOT
  re-request** — `fed_timeout` already bounds it). cmocka first: out-of-order + dropped-middle ⇒ rejected,
  never truncated-add.
- **Dedup**: per-CR-C-FRAME `generate_msgid` (globally unique) via `crdt_m_seen_check_add`; key = carrier
  frame msgid, NEVER the reqid (spans frames). Same-chunk-via-two-paths → same msgid → exactly once.
- **servers_pending**: rule = count ⟺ dispatch-that-can-`E`. 5-5c skips `IsMeshStub` in BOTH
  `count_storage_servers` + the 3 query loops (consistent, incomplete); 5-5f flips both to count-and-tunnel
  together; `fed_timeout` backstops a genuinely-unreachable tunneled stub. No conflict.
- **No materialize race**: the storage node answers from RocksDB **by channel name** (no `FindChannel`/
  live-materialize needed); reply arms need only the pre-created `FedRequest` slot → no reply-before-request
  window; origin's `findNUser` is already NULL-guarded. Do NOT global-burst-gate (NB12). 'C' re-inject uses
  `cptr=sptr=&me` (safe — not a stub prefix); c-auditor anyway.

### CR 'B' design (the FIX for 5-5e, from the deep bouncer pass — valid even though its "partition-only" framing was wrong)
Frame `CR B <msgid> <ttl> <srcnumeric> :<verbatim BS/BX body>`, flooded over the `IsCrdtSyncTarget` set
(which DOES reach all nodes — that's how the doc converges), dedup on frame msgid via `crdt_m_seen`.
Re-inject MUST set `sptr = FindNServer(srcnumeric)` (the TRUE origin — Invariant #3; NEVER `&me` like
CR-X's services reinject, NEVER `hs_origin`) and `cptr` = the CR uplink, reproducing a normal P10 arrival
byte-exactly; assert `IsServer(src)||IsMeshStub(src)` and keep a server `sptr` out of any `cli_user(sptr)`
deref (Invariant #8 crash site `s_user.c:1288` `cli_yxx(cli_user(sptr)->server)`). The `parse.c:2037`
fake-direction guard is intentionally bypassed → msgid dedup is the SOLE loop terminator. Targeted BX
E/M/K to anchored aliases remain a separate (real, at-rest) gap → `crdt_route_bx_try`.

### Open code-traces for the implementation phase (do FIRST)
1. **The exact gate** that stops the BS re-broadcast between CRDT-aware peers (bouncer handler relay vs a
   TREE_RETIRE broadcast-suppression vs intro-suppression side-effect). Pin it before building CR 'B' so
   the fix hooks the right spot (and to know if un-gating P10 relay is even an option vs CR 'B').
2. **The broadcast-reachability re-audit** (the P0 above): which "SAFE" broadcasts are doc/CR-carried
   (fine) vs pure-P10 (island). Determines the true Tier C/D/E surface.

## 5. Cross-refs
Supersedes the Tier C rows in `crdt-mesh-s2s-gap-audit.md` (and **corrects its "BS = WORKS"** to
"WORKS only on a full mesh; partial-mesh multi-hop pairs need CR 'B'"). Extends
`crdt-mesh-mr5-tree-retirement.md` §9 (5-5e/5-5f). Builds on the CR-X services bridge
(`crdt-mesh-services-bridge.md`, `crdt-mesh-present-servers-to-legacy.md`) and MR-1/MR-2/MR-4 carriers.
Bouncer changes MUST re-read `bouncer-architecture` skill + keep the bouncer-analyst agent in the loop
(continue agent `a7ea2bed6c1ee62b5` for follow-up).
