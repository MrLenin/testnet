# Tier C F3 — enforcement flags over the mesh (TEMPSHUN; SVSNOOP disposition)

Scoped + designed + **SHIPPED 2026-07-25** (crdt-mesh `773857d`, parent bump pending).
Parent scope: `crdt-mesh-tier-c-scope.md` §"Fix families" F3. Executed directly (TDD +
opus end review = SHIP) — F1-c-sized increment.

**DONE:** `CRDT_COLL_TEMPSHUNS` LWW register, entry-minted / home-applied; eager+verify+
materialize reconcile; quit + orphan reaps; cmocka 87/87 (`test_tempshun_replicates_and_reaps`);
live gate `tests/clocktest/f3_tempshun.py` PASS (hub oper shuns nef7-homed victim across the
tree horizon — enforce + un-shun + converge). **The eager-path wiring (m_crdt.c reconcile
suite) was the load-bearing fix** — without it the flag only converged on the 30s verify tick
and the live gate raced it (caught during live validation, not review). SVSNOOP = accept-degrade
(no emitter; not converged). Opus-review Minor (non-blocking, inherited from F1-c silences):
the orphan sweep on a non-home node holding tempshun(V)-via-delta-but-not-user(V) could reap a
live shun (window practically empty; registration precedes shun). Not F3-introduced.

## Recon facts (grounding)

- **TEMPSHUN** = one per-user flag (`FLAG_TEMPSHUN`, client.h:289), set/cleared by
  `mo_tempshun`/`ms_tempshun` (m_tempshun.c; +/- with target numeric; reason is notice-only,
  never stored), relayed unconditionally S2S. Enforced at the target's HOME server:
  parse.c:1599 `if (IsTempShun(cptr) || shun_lookup(...))` drops a local client's commands
  (shun semantics). **X3 emits it USER-sourced** (`irc_tempshun`, proto-p10.c:1126,
  `from->numeric` = an OpServ user) → under tree-retirement it is the live-confirmed gap-A
  class: fake-direction-dropped beyond the receiving node's tree horizon. An OpServ TEMPSHUN
  of a user homed 2+ tree hops out silently never lands. That is the F3 defect.
- **SVSNOOP** = per-server O-line kill switch (m_svsnoop.c: on the TARGET server only, `+` marks
  every CONF_OPERATOR line CONF_ILLEGAL + SetServerNoop; `-` rehashes + clears), relayed
  unconditionally. **X3 never emits it** (zero hits in x3/src) and there is no oper command —
  BUT it is standard ircu/P10 surface that OTHER services (uworld, srvx-family, other X-series)
  DO emit, so "no emitter" is X3-parochial and WRONG as a justification (corrected 2026-07-25
  after user pushback). The real reason it stays accept-degrade is architectural: the fork's
  direction is integrated services ([[project_x3_nefarious_merge]] — services fold INTO the
  ircd), so an external P10 service emitting SVSNOOP is a fading legacy-interop concern, not a
  forward requirement. Low-value to invest in.

## Decisions

1. **TEMPSHUN → CrdtUserRecord field** (the F1-b setter-hook pattern), NOT a separate
   collection and NOT a CR tunnel: it is per-user volatile state that must catch up after
   partitions (an enforcement flag delivered ephemerally would miss rejoining nodes), and the
   user record already has the exact machinery (wire roundtrip, LWW, reconcile, materialize).
2. **SVSNOOP → accept-degrade, documented**: stays a legacy tree token; no doc model, no CR
   carrier. **NB the fix shape, if ever wanted, is NOT F3-style convergence** — SVSNOOP is
   SERVER-sourced, so the account-prop parse exemption (`CrdtAcceptBeyondHorizonSource`) already
   ADMITS a beyond-horizon (mesh-anchor) SVSNOOP; the ONLY thing dropping it is `ms_svsnoop`'s
   own `!IsServer(sptr)` source gate (m_svsnoop.c:114) rejecting the stub. So the entire
   available fix is a ONE-LINE `IsMeshStub(sptr)` tolerance (the exact pattern the account-prop
   class sweep gave ms_account/ms_mode/ms_mark/m_privs; stub-safe — sptr only flows to
   `sendcmdto_serv_butone`, no cli_user deref), fixing the tree-relay-still-present window. Full
   doc convergence would only be for post-MR-6 mesh-only delivery (the general gap-A/CR-M work,
   not SVSNOOP-specific). DEFERRED (not applied): low value vs the integration direction, and
   un-live-gateable on the bed (no emitter to trigger it). Revisit iff a legacy-interop
   requirement surfaces. (F5-class disposition, recorded here so
   F3 is closed as a family.)

## TEMPSHUN design — REVISED during TDD-red (user-record model REJECTED)

**Why not a CrdtUserRecord field (the first draft):** reading m_tempshun.c killed it — the
flag is applied ONLY in the `MyUser(acptr)` branch (both handlers): the HOME server is the
sole flag holder; every other node just relays. But the tempshun VERB originates on the
OPER's (or gateway-entry) server — which does NOT own the victim's user record. An
origin-side record write would (a) violate the users-collection single-writer discipline,
(b) overwrite home-owned fields from a possibly-stale materialized copy, and (c) lose the
race against any home-side record refresh that fires before the home reconciles the flag
(LWW-newer refresh with tempshun=0 silently drops the shun). Wrong tool.

**Model: dedicated LWW collection `tempshuns`** (the F1-c SILENCE plumbing template, but LWW
not OR-Set, and origin-written not home-written):
- `CRDT_COLL_TEMPSHUNS`: key = victim numeric (5-char YXX), value =
  `struct CrdtTempshun { uint8_t active; char reason[CRDT_TEMPSHUN_REASONLEN]; }`
  (u8+chars → no interior/tail padding; memset anyway per invariant 4).
- **`-` replicates as active=0, never as a doc DELETE** — a rejoining/partitioned node must
  converge the un-shun; real DELETEs are minted only by the reaps below.
- **Writer = the ENTRY node** (LWW resolves multi-origin flips to the latest): `mo_tempshun`
  always (local oper); `ms_tempshun` only when the token arrived off a NON-CRDT link
  (`MyUser(cptr) || !(IsServer(cptr) && IsCrdtAware(cptr))` — the B3/gateway-edge predicate),
  so X3-sourced TS mints at the gateway and CRDT-relayed TS never double-mints. The legacy
  P10 relay stays untouched (legacy interop).
- **Apply = the HOME server's reconcile**: a `reconcile_tempshuns` pass in the full-walk
  suite — `findNUser(key)`; only `MyUser && !IsBouncerAlias` victims; drift-apply
  Set/ClearTempShun with the handler's own transition notices (victim NOTICE gated on
  FEAT_HIS_SHUN_REASON + SNO_GLINE opmask, reason from the doc value). Non-home nodes apply
  nothing (matching live behavior: remote copies never carry the flag).
- **Reaps** (the silences precedent, LWW edition): (a) `crdt_user_remove` mints a tempshun
  DELETE alongside `reclaim_user_silences` (flag dies with the user); (b) an orphan sweep
  `crdt_state_reclaim_orphan_tempshuns` in the verify GC for entries whose user record is
  fully gone (`!get && is_explicitly_removed`-style gate, invariant 5).
- Snapshot (CR F) + digest (fresh salt) + op-apply switch entries mirror the silences sites
  1:1 (crdt_state.c ~:1659/:1976/:2034; crdt_wire.c ~:371/:522).

## Tests

- **cmocka (engine, gates the image)**: user-record wire roundtrip with the tempshun bit set
  and clear (encode→decode), plus record-level LWW convergence of a tempshun flip between two
  states (the F1-b field-addition test shape).
- **Live gate** (`tests/clocktest/f3_tempshun.py`): client V homed on nef7 (2 tree hops from
  hub, the proven gap-A victim position) joins a channel with observer O on nef3. Oper on
  nef3 `TEMPSHUN + <V>` → assert (a) V's channel PRIVMSG is dropped (O sees nothing) within a
  convergence window — the flag reached V's HOME server via the doc even though the P10 TS
  token died at the horizon; (b) `TEMPSHUN -` restores delivery; (c) mesh mdigest converges.
  Regression: p2_chreg quick pass.

## Risks / invariants checked

- Invariant 8 (full-walk reconcile) untouched — one more field in the existing walk.
- Invariant 1/2 (stub gates): no new stub-as-source paths; ms_tempshun already stub-tolerant
  (P2 class sweep verdict WORK).
- The MyUser-skip carve-out is deliberately field-scoped (flag only) — nick/umode reconcile
  still never touches local users.
- Record refresh in ms_ handlers = N-node re-mint (F1-b precedent, LWW-benign).
