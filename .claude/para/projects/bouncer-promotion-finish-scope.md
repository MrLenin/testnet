# Bouncer promotion-gate finish — remaining/deferred items scope

Scoped 2026-06-26 (bouncer-analyst `a6fa8ebf44795318f`, source-verified). Follows the M6c-1
capstone landing (`f0a84da` / ptr `ce8090a`): gateway re-originates BS C/D/A/X to a bouncer-aware
legacy peer from the doc, validated. This doc scopes the REMAINING Track-1 items to call the CRDT
fork genuinely shippable as prod. All of M6c-1 was for the session PRIMARY; most of what remains is
the ALIAS analog plus a few independent items.

Cross-ref: [[project_crdt_m6c1_gateway_synth]], [[project_crdt_bouncer_gateway_legacy]],
[[project_crdt_tier_c_scope]], [[project_bouncer_alias_promote_deferred]].

## Corrected stale memory claims (source evidence)
- **"no alias reap exists" — FALSE.** Two reaps exist: `crdt_shadow_bconn_reap` (crdt_shadow.c:719,
  cb :684) = owner-side doc reap (tombstones a `bconns` entry where `host==me` && `findNUser==NULL`;
  no wire token, doesn't touch the live Client); `bounce_crdt_replica_reap` (bouncer_session.c:2247)
  = replica teardown on owner tombstone.
- **"alias materialize never proven (0 aliases)" — VALIDATION gap, not code gap.**
  `bounce_materialize_alias_from_doc` (bouncer_session.c:8328) + `reconcile_bconn_cb` (crdt_shadow.c
  :1104) exist and are wired into BOTH the verify timer (crdt_shadow.c:4288) and the eager m_crdt
  ingest (m_crdt.c:694). 0 aliases were observed only because no test ever opened a 2nd connection.

## Items

### Item 1 — BX alias path (CENTERPIECE, critical path). HIGH effort / MED-HIGH risk.
**PROGRESS 2026-06-26:**
- **Inc-0 DONE + committed (`bef3cdd`)** — detect-and-log + crdt_parse_bconn_key helper. INERT
  pre-suppression (P10 BX C/X relay masks the doc path); validated inert on the bed.
- **Inc-1 IN WORKING TREE (UNCOMMITTED) — create-path proven, destroy NOT clean. DO NOT commit as-is.**
  Edits (bouncer_session.c, 42 ins): skip_crdt before the 3 BX C emits (setup_local_alias :7782,
  finish_live :6370, alias_create forward :8249) + eager crdt_shadow_bconn_set at alias-create
  (setup_local_alias) + eager crdt_shadow_bconn_remove at alias-untrack (owner-gated server==&me).
  NO BX X suppression (deliberate — destroy still rides P10 BX X).
  - ✅ **CREATE validated** (run WITHOUT the eager-remove): gateway materialize log fires sub-second
    (0.2s) + **.2 LISTSESSIONS aliases:1** — the doc-materialize→alias_create-forward IS the legacy
    synth, working. Suppression confirmed (materialize became the path, was masked before).
  - ❌ **DESTROY resurrection bug**: the eager bconn WRITE means after BX X removes the alias, a still-
    LIVE doc bconn makes reconcile RE-MATERIALIZE it; the ~30s reap then tombstones the doc but the
    de-mat gap (reconcile skips tombstones) strands it → **.2 stays aliases:1** after disconnect.
  - ⚠️ eager-remove (added to close the resurrection at the owner) → re-run showed **.2 aliases:0 at the
    CREATE check** (ambiguous: eager-remove misfiring during create, OR slow-run test-timing — that run
    had materialize lat 6.8s vs 0.2s, so .2 may just have lagged the fixed check). UNRESOLVED.
  - **ROBUST FIX = Inc-2 de-materialize-on-tombstone** (below): closes the resurrection regardless of
    BX-X-vs-tombstone-delta ordering. The eager-remove alone has a residual race (reconcile in the
    window between P10 BX X and the CRDT tombstone re-materializes).
  - See **Inc-2 SCOPE** below (analyst-verified) for the full plan.

#### Inc-2c — BX X suppression + de-mat FIX: DONE 2026-06-27 (`5328b29`, ptr `47145ec`, pushed). **BX ALIAS PATH FULLY DOC-NATIVE.**
Inc-2c (suppress alias BX X among CRDT peers, s_misc.c, IsBouncerAlias-gated so the held-ghost/BS path is
untouched) made the de-mat the SOLE destroy path — which **EXPOSED that the Inc-2 de-mat was DEAD CODE**:
it lived in reconcile_bconn_cb's tombstone branch, but `crdt_lwwmap_foreach` SKIPS deleted entries
(crdt_types.c:502 `if (!e->deleted)`) ⇒ that branch is UNREACHABLE for a tombstone. The de-mat never
fired (count 0, aliases stranded on .2); the P10 BX X had silently been doing all destroy work, masking
it. **THE FIX: rewrote de-mat as `bounce_crdt_alias_reap()` — the alias analog of the proven
`bounce_crdt_replica_reap`: LIVE-WALK accountHash→sessions→hs_aliases[] + new `crdt_shadow_bconn_present()`
oracle (crdt_bconn_get→NULL for tombstone), collect-then-act; gateway synths BX X (skip_crdt, &me,
numeric-keyed), then `bounce_dematerialize_replica_alias` silent teardown. Removed the dead tombstone-branch
+ ctx collect/act machinery.** VALIDATED 5/5 same-leaf create→destroy + churn: .2 aliases:1→0 stays-0,
**de-mat FIRES every rep (count 1..5 = live-exercised, no longer dead code)**, 0 crashes. ⇒ Inc-2c did its
job: forcing the path both exposed the bug AND proved the fix. **LESSON: crdt_lwwmap_foreach skips deleted
— doc-removal reconciles MUST live-walk + check *_present(), never foreach the tombstone (mirror
replica_reap), same as the BS path.** BED GOTCHAS hit: (1) aggressive churn floods wedge .2's bouncer state
+ kill nef7 (valgrind) → restart .2 + docker start nef7; (2) after recreating nef3-7, re-form gateway↔.2
via `/CONNECT testnet 4496` (`/tmp/relink.py` retries); (3) use POLL not fixed-sleep for .2 checks.

#### Inc-2 — race-proof DESTROY: DONE 2026-06-26 (Inc-0 `bef3cdd`, Inc-1 `fac6e42`, Inc-2 `a051a5f`, ptr `bdcf8b1`, pushed)
**BX ALIAS PATH COMPLETE (create + destroy).** Inc-2a confirmed create-`.2=0` was TEST-TIMING
(poll → aliases:1 reliably ~5s; the eager-remove does NOT fire mid-attach) ⇒ Inc-1 committed. Inc-2b
shipped Design A: `bounce_dematerialize_replica_alias()` (silent BX-X-receiver teardown, NOT exit_client)
+ collect-then-act in reconcile_bconn_cb tombstone branch + gateway BX X synth (skip_crdt, numeric-keyed
&me source). **VALIDATED: same-leaf create→destroy ×5 + induced churn — .2 aliases:1→0, STAYS 0 (18s
hold) every rep, 0 crashes/valgrind.** **HONEST GAP: the de-mat path did NOT live-trigger (de-mat-log
count 0 across 13 reps incl. aggressive multi-leaf churn) — the resurrection race is rare (BX-X→tombstone
window is tight, both from the owner leaf near-simultaneously); could not be forced.** ⇒ de-mat is
correct-BY-CONSTRUCTION (proven primitives) + validated as a no-op-when-not-needed safety net (no
false-fire), but its firing path is behaviorally unexercised. The observed-once stranding is closed by
construction. **Inc-2c (suppress BX X = Design B) would make de-mat the SOLE destroy path → forces it to
be exercised; DEFERRED (P10-retirement arc, own flag, after alias-lifecycle proof).** Bed gotcha hit:
nef7 (leaf5) exited(1) during churn — known valgrind flakiness, not my code (no segv/assert); `docker
start` recovers; harnesses now tolerate a down node.

#### Inc-2 SCOPE — race-proof DESTROY (analyst `a7b876afa0d1f05a1`, source-verified 2026-06-26)

**★ STRUCTURAL FACT that reframes the bug:** `crdt_shadow_reconcile_bouncer()` runs EAGERLY on every
applied delta (m_crdt.c:694, in the `applied>0` CR U/D block — added for M6c-1 BS A/D). It is NOT
verify-timer-only. ⇒ `reconcile_bconn_cb`'s tombstone branch (crdt_shadow.c:1137-1154) is ALREADY
invoked sub-second on the DEL delta that tombstones the bconn — it just logs (Inc-0). The de-materialize
goes THERE; no new pass/timer/window. The 30s `crdt_shadow_bconn_reap` (:719) is the OWNER-side
tombstone-MINTER (separate); the gateway-side de-mat rides the eager reconcile. (The scope's earlier
"30s reap too slow / residual race" framing was conflating these.)

**Q1 — create `.2=0` ROOT-CAUSED = TEST-TIMING, not a mid-attach untrack.** `bounce_alias_untrack` (the
only caller of the eager `crdt_shadow_bconn_remove`) is reached ONLY from exit/BX X paths
(bounce_alias_destroy :8520, exit_one_client s_misc.c:399) — NEVER from the attach path
(register_user → bounce_auto_resume ALIAS_LOCAL :1318 → bounce_setup_local_alias, which only SETs). So
the eager-remove cannot tombstone the just-written bconn during create. The `.2=0` run was slow
(materialize 6.8s) and the `.2` check fired before the SET delta converged. **FIX = poll `.2` for
aliases:1 (not a fixed sleep). Keep the eager-remove (correct + load-bearing for prompt tombstone).
This unblocks COMMITTING Inc-1.** Key agreement verified (no false-reap of a live alias): ba_numeric
:7699 == eager-set key alias_full :7818 == sweep key :2152 == reap keep-gate :710.

**Q2 — DE-MAT design (the fix):** new `bounce_dematerialize_replica_alias(alias)` in bouncer_session.c
mirroring the BX X-receiver SILENT teardown (:8519-8538), NOT exit_client/exit_one_client (that path's
alias branch checks FLAG_KILLED → whole-session cascade = bouncer inv#6 hazard). Steps:
s2s_bxm_cleanup_alias → bounce_alias_untrack (on gateway server!=&me ⇒ its eager-remove no-ops, single-
writer safe) → remove_user_from_all_channels (NO part op: crdt_shadow_part gated `!IsMemberAlias`,
channel.c:924, and replica-alias memberships are CHFL_ALIAS) → RemoveYXXClient → remove_client_from_list
(no crdt hook). Deliberately AVOIDS crdt_shadow_user_remove (only in exit_one_client). **Predicate** (=
Inc-0 log predicate promoted to action): tombstoned bconn + crdt_parse_bconn_key ok + findNUser(aliasn)
+ IsBouncerAlias + !MyConnect. **MID-WALK SAFE = collect-then-act** (mirror bounce_crdt_replica_reap
:2266): push doomed into a fixed array during the foreach, act after crdt_lwwmap_foreach returns in
crdt_shadow_reconcile_bouncer (:1191); re-resolve findNUser + re-check before acting (ABA/idempotency).
Confirmed: de-mat writes NO doc collection on the gateway (single-writer holds).

**Q3 — BX X suppression: SHIP DESIGN A for Inc-2; defer B.** A = KEEP BX X ungated (P10 relay = primary
destroy, emitted ungated at s_misc.c:1035 + bounce_alias_destroy forward :8541) + de-mat-on-tombstone as
the resurrection SAFETY NET. The P10 BX X and the CRDT tombstone become two IDEMPOTENT removals of the
same Client — whichever lands first removes it, the second no-ops (findNUser NULL / `if(!target) goto
forward` :8503). **Correct regardless of P10-vs-CRDT ordering, no synth, no source/numeric reasoning.**
B (suppress BX X among CRDT peers + gateway synthesizes BX X) = the P10-retirement target (Inc-2c,
DEFERRED, own flag, after a live alias-lifecycle proof): removes the safety net ⇒ one missed de-mat =
permanent legacy ghost. NB: BX X receiver lookup is numeric-only (findNUser, :8493) so a `&me`-sourced
synth is fine for B (unlike BS A/D which need the owning-leaf source per inv#3) — but not needed for A.

**Q4 — invariants (Design A):** inv#1 (de-mat arms no timer — don't "fix" a miss with a retry timer);
inv#6/#7 (silent removal via the BX X primitive, never exit_client/QUIT/FLAG_KILLED — the whole reason
for the manual helper); inv#8 (guard findNUser NULL + IsBouncerAlias before cli_user derefs; guard
cli_user before RemoveYXXClient); single-writer (de-mat removes only the local Client, writes no doc on
the non-owner; the OWNER mints the tombstone). Item-2 cross-attach race: de-mat's IsBouncerAlias gate
skips a not-yet-alias racing user (safe); keep cross-leaf CREATE out of the correctness gate (racy
independent of destroy).

**PLAN:** Inc-2a (NO code) — re-run same-leaf create on clean bed (`/tmp/clean_bed.py` first), POLL `.2`
for aliases:1 → confirms Q1 timing + authorizes committing Inc-1. **Inc-2b (the fix, FEAT_CRDT_BOUNCER_DOC
gated)** — add bounce_dematerialize_replica_alias + collect-then-act in reconcile_bconn_cb/
reconcile_bouncer; ship Design A. **Inc-2c (DEFERRED)** — Design B (suppress BX X + synth), P10-retirement
arc, own flag, after alias-lifecycle proof. **VALIDATION (gate):** clean bed; same-leaf create→destroy
×≥5, assert `.2 aliases:1`→`aliases:0` with ZERO resurrection; confirm de-mat log fires on the DEL delta
(sub-second, not 30s); cross-leaf best-effort (destroy must leave aliases:0 everywhere); 0 crashes +
valgrind (de-mat frees a Client under a foreach — collect-then-act must show no UAF); stock-upstream
inv#6/#7 control (port 6671 authoritative WHOIS) — note if upstream-link blocks it.

**Data to gather:** (1) Inc-2a poll result (load-bearing — unblocks Inc-1 commit); (2) de-mat fires from
m_crdt.c:694 eager path (de-mat log right after a `CRDT sync: applied` carrying the tombstone);
(3) crdt_gateway_has_legacy_peer() true in the bed (it is — Item 4 MAP); (4) multi-gateway out of scope
(A is double-BX-X-idempotent = multi-gw-safer than B anyway). Continuable analyst `a7b876afa0d1f05a1`.

(original scope below)
The BX alias path is **still 100% on legacy P10 BX C/X/U/K/V** — none of the M6b-1b/M6c-1 (doc-native
+ skip_crdt + gateway-synthesis) treatment that PRIMARIES got. Gap is real.
- Ungated emit sites (none call `sendcmdto_set_skip_crdt_servers()`): `bounce_setup_local_alias`
  BX C :7782 + paired legacy BX P :7792; `bounce_finish_live` BX C :6370 + legacy Q loop :6406;
  `bounce_alias_create` forward BX C :8249/:8254 + legacy BX P :8272. Receiver `bounce_alias_create`
  (:7922) has NO `from_crdt_peer` self-skip; `bounce_alias_destroy` BX X relay :8500 ungated.
- NO `crdt_m6c1_synth_bx_*` helper exists. The doc-materialize path re-emits via the ungated relay
  (reaches both CRDT peers = redundant-with-doc leak, AND legacy = accidental synthesis via BX P).
- Numeric/present-stub: BX C/X are NUMERIC-prefixed (`YYXXX`). `bounce_materialize_alias_from_doc`
  resolves via `FindNServer` and explicitly accepts a mesh stub (:8345), routes via `cli_from`
  (inv#8 guard :8347). **R6c present-stub is the LOAD-BEARING prerequisite** — owning leaf must be a
  presented stub on .2 or both FindNServer and the legacy BX P numerics fail.
- Fix = mirror BS: (1) skip_crdt at the 3 BX C sites + BX X relay + inbound self-skip → doc carries
  the alias among CRDT peers; (2) add `crdt_m6c1_synth_bx_c`/`_x` for clean gateway re-origination
  (+ paired BX P / BX X) from the doc at materialize + tombstone.
- Increments: Inc-0 detect-and-log (would-synth + legacy-peer + alias-server-is-stub) → Inc-1
  skip_crdt + self-skip (RISKIEST: removes the only cross-CRDT alias transport) → Inc-2 synth helpers
  + drop ungated BX P/Q relay; validate lifecycle on .2 (LISTSESSIONS / WHO `G` flag / CHFL_ALIAS).
- Hazards: inv#1 (materialized aliases never arm hold/promote timers); inv#3 (synth source = owning-
  leaf present-stub, like `crdt_m6c1_synth_bs_ad` sources `cli_user(uc)->server` not `&me`); inv#6/#7
  (keep Q / BX P in-place swap for legacy retraction, NEVER FLAG_KILLED — already correct at :6406/
  :8272); inv#8 (re-guard `cli_user(uc)`); single-writer (bconn doc single-writer-per-host, gate
  crdt_shadow.c:2145 — synth emits wire only, never writes doc on a non-owner).
- **HARD-BLOCKED by Item 2.**

### Item 2 — Alias-lifecycle live proof (DE-ENTANGLER, prerequisite). DONE 2026-06-26.
**RESULT: de-entangler ANSWERED — proceed to Item 1.** Live 2-conn test on the 5-node bed:
- ✅ **An alias attach WRITES a bconn to the CRDT doc** (`doc (1,1,1)→(1,2,1)` when conn B aliased).
  The doc carries aliases ⇒ suppressing P10 BX C (Item 1) is SAFE data-wise. This was the gate.
- ✅ **bconn doc WRITE is verify-timer-paced (~21s lag measured)** ⇒ Item 1 Inc-1 needs an EAGER
  `crdt_shadow_bconn_set` at alias-create (same fix as BS sessions), else alias convergence lags.
- ✅ Alias **reaps from the doc** on disconnect (`(1,2,1)→(1,1,1)`, ~24s, verify-timer-paced).
- The doc→.2 materialize + reap-to-.2 via DOC can't be proven yet — **that path doesn't exist; it IS
  what Item 1 builds.** Today .2 gets the alias via the UNGATED P10 BX C multi-hop relay (confirmed:
  gateway nef3's own doc still showed 1 conn while .2 already showed aliases:1 ⇒ delivered by P10, not
  doc-materialize). So Item 1's synth (crdt_m6c1_synth_bx_c/_x) IS required. reap→.2 de-materialize
  decision deferred to Item 1 Inc-0 instrumentation (cleaner than inferring through LISTSESSIONS).

**NEW FINDING A — cross-server alias auto-attach is RACY (pre-existing, not BX-introduced):** a fresh
SASL conn gets its OWN session_id; whether conn B (different leaf) becomes an ALIAS vs a PARALLEL
primary depends on bounce_auto_resume finding A's session across the convergence lag (run 1: aliased
→ (1,2,1); run 2: parallel → (2,2,2), never merged in 60s). This is the .skip'd
`bouncer-alias-multi-server.test.ts` race. Item 1's BX suppression must handle the parallel-then-merge
case; **deterministic alias testing = SAME-LEAF (both conns to one leaf, local session lookup can't
lose the race) or explicit resume-with-token.**

**NEW FINDING B (CRITICAL test infra) — bouncer sessions are RocksDB-PERSISTED in a docker VOLUME**
(`metadata_get_bouncer_cf()`, FEAT_BOUNCER_PERSIST; volume `testnet_metadata_data`). ⇒ container
recreate / `.2` restart does NOT clean the bed — held sessions are restored from disk (saw a 234m-old
ghost). PERSIST is TRUE only on .2/upstream (ircd.conf/ircd2.conf); CRDT leaves (ircd3-7.conf) do NOT
persist. **CLEAN-BED RECIPE (`/tmp/clean_bed.py`, VERIFIED → .2 ABSENT): oper on EVERY node {.2,nef3-7}
+ loop `BOUNCER ORESET testadmin` until NO_SUCH_SESSION** (ORESET no-sessid kills only the FIRST
session, m_bouncer.c:597, so loop; it does bounce_broadcast('X')+bounce_destroy→bounce_db_del so doc
tombstones converge + .2 persistence clears). Run this before EVERY bouncer test; `.2` restart alone
is insufficient.

(original scope below)
- bconn_reap reaps owner doc-roster entries (not the live BX-X destroy, which stays
  exit_one_client → bounce_broadcast('X') s_misc.c:1020+). Materialize+reap both exist+wired.
- **Latency seam to address in Inc-1 of Item 1:** the alias bconn doc WRITE is **verify-timer-only**
  (`bounce_crdt_bsess_sweep` :2143-2154, gated `strcmp(ba_server,me_yxx)`); there is NO eager
  `crdt_shadow_bconn_set` at alias-create (`bounce_setup_local_alias` doesn't call it). Read side got
  an eager hook (m_crdt.c:694), write side did not → fresh alias invisible in doc until next sweep.
  Consider an eager bconn write at alias create.
- Minimal proof: one CRFLAG_BOUNCER account, conn A on leaf-X (primary, held), conn B on leaf-Y same
  account/sessid → CHFL_ALIAS. Assert (1) bconns doc size=2 on all nodes; (2) gateway .2 materializes
  it (LISTSESSIONS shows 2 connections, WHO shows alias channels CHFL_ALIAS); (3) disconnect B →
  bconn_reap tombstones on leaf-Y, replica reap removes on .2, BX X reaches legacy.
- **MUST precede Item 1 Inc-1.** Fold with Item 1 Inc-0.

### Item 3 — M6b-2 buckets (BS O / BX K/V/U). MED effort / LOW-MED risk. Conditionally-blocking.
- `CrdtBouncerSession` (crdt_state.h:186) has state + hold_override, NO oper fields. `CrdtBouncerConn`
  (:204) has only caps. So BS O (oper grant hs_oper_name/hs_oper_granted_at, bouncer_session.c:4160,
  burst-replayed :3910) is NOT in the doc → a materialized replica/gateway loses the oper grant. BX U
  rich fields (host/realhost/realname/fakehost/cloak :6823) + BX K (snomask) + BX V (away/vis) absent.
- **DECIDED 2026-06-26 (user): BS O is a POST-GATE refinement (NOT critical path now), but network-
  level oper persistence "needs to persist eventually" — do NOT design it out.**

- **FINALIZED MODEL 2026-06-27 (user answers — IMPLEMENTING NOW):**
  1. **Reval authority = local O:line identity ONLY.** No OLVL/X3 query (the ircd has no way to query an
     account's X3 OLVL). The safety net for the "no local O:line" case is that **X3 auto-opers eligible
     introduced users** — so a user who loses their grant on a node still gets re-opered by services
     shortly after (cost = a delay + a missed auto-rejoin of oper-only channels). We do NOT build an
     account/OLVL revalidation tier.
  2. **What replicates = manual `/OPER` only.** This is already the existing behavior: only an explicit
     `opername` populates `hs_oper_name`; server-sourced/X3 `MODE +o` leaves it empty and is never
     recorded. No change needed to the record-gate — just carry `hs_oper_name`/`hs_oper_granted_at` in
     the doc.
  3. **Reval timing = RESTART ONLY.** A primary-MOVE must **persist** oper unconditionally — NO de-oper
     on transfer/materialize (the moved user may even have an O:line on the new primary; if not, X3
     auto-oper covers it). ⇒ The latent moved-primary bug is fixed by **removing** the per-server
     name-existence revalidation from the apply/materialize path (it currently runs against whatever
     leaf is now primary = wrong under mobility). The local-O:line check is confined to the **restart
     restore** path only.
  4. **Restart reval-miss handling = drop oper, log + snomask (no user NOTICE — no client is connected
     at restore time; X3 auto-oper re-grants on the user's next reconnect if still eligible).** De-oping
     a persisted oper otherwise requires an `ORESET` of the session (user's words: "gonna have to get
     used to doing an ORESET").

  ⇒ **Implementation shape:** (a) add `oper_name[]` + `oper_granted_at` to `CrdtBouncerSession`; carry
  them through bsess set/get + reconcile + the M6c-1 BS synth. (b) materialize/promote/transfer: apply
  the grant from the doc WITHOUT a local-conf check (persist-across-move). (c) restart restore
  (`bounce_db_restore`/persist path): the ONLY place that calls `find_oper_conf_by_name` — present ⇒
  keep +o, absent ⇒ drop (log+snomask). (d) BX U/K/V rich fields remain a separate later increment
  (out of this BS O pass).

- **ANALYST AUDIT 2026-06-27 (`a65c8490804a7516c`, source-verified) — PLAN APPROVED, two increments:**
  - **Inc-A (ship first, LOW risk, independently testable):** struct fields (oper_granted_at u64 in the
    existing u64 run + oper_name[31] trailing → re-pad to sizeof 192, no interior hole; memset-before-fill
    in the sweep is LOAD-BEARING for digest determinism since ircd_strncpy doesn't zero-fill) + sweep
    populate + reconcile populate-only (BOTH branches; **NO `hs_dirty` on the existing-replica sync — a
    replica must never drive a doc/persist write of a record it doesn't own**; doc IS truth on a replica)
    + restart fail-closed (E). Relay still carries BS O to legacy, so the synth is not yet needed — this
    satisfies the gate's DATA requirement alone.
  - **Inc-B (ship second, MUST land suppression+synth TOGETHER):** add `FEAT_CRDT_BOUNCER_DOC`-gated
    `sendcmdto_set_skip_crdt_servers()` to bounce_broadcast case 'O' (:4214) AND the receive re-relay
    (:4804), + `crdt_m6c1_synth_bs_o()` (`&me` source — BS O is account/sessid-keyed via
    bounce_find_by_token_sessid :4797, NOT numeric, so inv#3 does NOT bite, unlike BS A/D) fired from
    both reconcile branches, **C-before-O on first materialize** (receiver drops O if the session doesn't
    exist yet, :4798 guard). **inv#11 cousin: the surviving BS O relay is currently MASKING the absent
    synth — suppress-without-synth would strand the grant from .2 (exactly like BX X masked the dead
    de-mat). Never split across commits.**
  - **UserStats (inv#9) SAFE:** populate-on-replica adds zero counter activity; the remote primary's +o
    is counted by the network-wide (non-MyConnect) set_user_mode path (s_user.c:2494); the local
    promote/revive apply (MyConnect-gated, :7150) is the first local count, balanced by exit. No
    double-count. Restart drop needs NO decrement (apply never ran).
  - **Durability note (E):** clearing in-memory hs_oper_name isn't rewritten to disk until the next
    dirty event; a re-restart before that re-runs the (idempotent) drop. Acceptable; comment it.
  - **MOVED-PRIMARY latent bug = CLOSED by this model** (persist-across-move + reval-restart-only is its
    resolution).

- **IMPLEMENTED + VALIDATED 2026-06-27 — BS O FULLY DOC-NATIVE.**
  - **Inc-A `9a9f030` (ptr `fb2cae8`):** struct fields + sweep + reconcile populate (both branches, no
    hs_dirty) + restart fail-closed + cmocka (oper round-trip + sizeof==192 layout pin). Built (cmocka
    green); live same-leaf hold→revive re-opers; 0 crashes nef3-7.
  - **Inc-B `cc2d581` (ptr `af0de50`):** suppress BS O relay among CRDT peers (broadcast case 'O' +
    receive re-relay, FEAT_CRDT_BOUNCER_DOC-gated) + `crdt_m6c1_synth_bs_o` (&me source) from both
    reconcile branches (C-before-O). **DECISIVE VALIDATION:** /OPER testadmin on leaf3 (nef5) →
    owner leaf emits NO BS O to CRDT peers (suppressed); **gateway logs `synth BS O -> legacy ...
    grant=oper`** — the gateway is a CRDT peer with the relay suppressed, so it learned grant=oper
    ONLY from the doc ⇒ decisive doc-carry proof; **.2 receives `AD BS O testadmin ... oper`** (&me=gateway
    source) via the synth, not relay. 0 crashes nef3-7.
  - **CROSS-LEAF move note:** a disconnect-then-reconnect-elsewhere did NOT re-oper because the M6d
    resume-decision returned `action=0` (lease holder still alive → no cross-leaf revive); the dest leaf
    DID hold the grant (relay/doc) so a real M6d transfer would re-oper. Pre-existing M6d behavior,
    orthogonal to BS O.
  - **DEFERRED — restart fail-closed LIVE test:** no clean testbed fit. CRDT leaves don't persist by
    design; forcing FEAT_BOUNCER_PERSIST on a leaf creates a RocksDB-restore + doc-re-materialize
    dual-restore where the doc (still holding the valid grant network-wide) immediately re-supplies what
    the drop cleared — which is CORRECT-by-design (restart-drop is for standalone/non-doc persist nodes;
    the doc is authoritative for a CRDT node) but muddy to assert in isolation. The clean persist nodes
    (.2/upstream) run the `nefarious` submodule, not this code. Code is analyst-approved + reuses the
    proven find_oper_conf_by_name; logic exercised only at unit level. Revisit when a CRDT-fork standalone
    persist node exists (the real prod shape).
  - **FINDING (deferred, separate):** [[project_dot2_userstats_opers_assert]] — .2 `UserStats.opers>0`
    crash during clean-bed oper churn; legacy-peer (nefarious submodule) only, 0 on nef3-7, NOT from the
    synth. inv#9 audit of the X3-auto-oper + present-stub exit path. Flag to user.

  **BS O IS AN AUTHORIZATION CLAIM TO RE-VALIDATE, NOT A BIT TO REPLAY (binding design constraint).**
  Source-verified the current impl (bouncer_session.c): grant is stored only from an explicit
  `opername` (:7166), which `do_oper` sets from the LOCAL O:line. Restore/promote
  (`bounce_apply_oper_grant` :7059) re-validates by NAME-EXISTENCE against the LOCAL `GlobalConfList`
  (`find_oper_conf_by_name` :7040, walks CONF_OPERATOR by name); miss → FAIL-OPEN (:7070, stays
  non-oper, grant retained); the comment (:7032-39) states "we trust the grant — no host/password
  verification." Consequences:
  - **Remote/X3 oper is never persisted** — not by a re-validation decision but because it has NO
    opername to store (server-sourced MODE +o → `hs_oper_name` stays empty → :7188 else-branch). The
    classic identity-tag absence the user described.
  - **Manual /OPER re-validation is name-existence only**, NOT authorization-currency: if the O:line
    name still exists but the user's right was revoked (OLVL cut, host/access changed), it STILL
    re-grants. Security gap.
  - **MOVED-PRIMARY BUG (user-flagged, CONFIRMED latent today, pre-CRDT):** `find_oper_conf_by_name`
    runs against WHATEVER server is now the primary. O:lines are PER-SERVER, so after a transfer:
    dest has same-named O:line → re-grants with DEST's privs (may differ from origin); dest lacks it
    → silent demote. Non-deterministic, = f(which leaf the session landed on). CRDT mobility makes
    this the COMMON case (sessions materialize/move across nodes), not the rare one.

  ⇒ BS O design (when built): record the GRANTING CONTEXT in the doc (≥ granting server / authority),
  and re-validate against the DEFINED AUTHORITY on (re)materialization, split by grant type:
  (1) manual /OPER → authority is an O:line (per-server) — decide policy: re-check origin conf vs
  network-trust-until-revoked vs revalidate-on-full-restart-only; the current "any same-named O:line
  re-grants" is WRONG under mobility. (2) remote/X3 oper → authority is the ACCOUNT's current OLVL —
  re-query X3/account state on restore (the account-level model; more than classic ever did). Keep the
  CrdtBouncerSession doc-struct + reconcile extensible for this. The pre-existing moved-primary issue
  is worth a dedicated fix regardless of CRDT, but is post-gate.
- Increments: Inc-0 log doc-vs-live divergence (oper/snomask/away on replicas) → Inc-1 oper fields in
  CrdtBouncerSession (op-recording) + reconcile → Inc-2 BX U/K/V buckets. "Drive the real handler".

### Item 4 — Stock-upstream control re-confirm. DONE + VALIDATED 2026-06-26.
**RESULT: ghost-freedom against the live stock upstream CONFIRMED (inv#6/#7 control passes).**
CORRECTION: upstream was NOT unwired — my earlier "LINKS empty" was a HIS mask; `/MAP` on the gateway
(nef3/hub2) shows upstream + testnet(.2) BOTH directly linked (topology: hub2 ← upstream[stock,
draft/bouncer=False], leaf2, leaf3, testnet(.2)[bouncer-aware] ← x3). Test (clean bed via clean_bed.py,
authoritative WHOIS probe on upstream:6671 + PM liveness round-trip, 30s cross-leaf settle):
- baseline absent → CREATE primary on leaf3 → upstream WHOIS **present@leaf3** (primary presents
  correctly to the stock peer)
- HOLD (disconnect) → still present@leaf3, exactly one (held ghost = normal user to stock)
- REVIVE on leaf2 (cross-leaf = the M6d transfer) → WHOIS **present@leaf2** (the user MOVED leaf3→leaf2,
  exactly one, NO stale leaf3 entry, NO duplicate) + **PM liveness received=True** (revived user is LIVE,
  not a dead-sink ghost)
- DESTROY (BOUNCER RESET) → WHOIS **absent**, no lingering ghost. 0 crashes.
TESTBED NOTE: use the authoritative WHOIS probe (311 present@server / 401 absent), NOT WHO (gave a
WHO=1-vs-WHOIS=absent contradiction on the racy cross-leaf path); give the cross-leaf revive ≥30s to
settle (auto-resume race + M6d transfer). Original-topology mapping confirmed: gateway tests against
testnet(.2)/leaf for bouncer-aware + upstream for non-bouncer.

(original scope below)
- inv#6/#7 control vs no-bouncer `nefarious-upstream` (last run had upstream link DOWN = false pass).
- Test: gateway .2 + nefarious-upstream linked; held primary on a CRDT leaf; upstream sees exactly 1
  user (present face via BX P swap / Q), never a dup. (a) hold → upstream user GONE; (b) revive on
  another leaf → exactly 1, no ghost; (c) M6d demote heal → exactly 1, loser cleanly QUIT. CONFIRM
  upstream is actually linked before asserting. (= bouncer-cross-server-promote / convert-branch-ghost
  families pointed at the upstream slot.)

### Item 5 — Orphan/anchor-residue reap (parked). MED effort / MED risk. OUT of gate, deferrable.
- `crdt_shadow_orphan_reap_scan` (crdt_shadow.c:824, cb :767) at Inc-0 detect-and-log only (1cfd3bd).
  Predicate: foreign-host bconn (host!=me) + STALE self-beacon + 60s grace + lease-as-oracle
  (would_reap_A = partition-safe; would_reap_B = broader, false-positive on partition). Tracks
  user_in_doc → leak is USER+bconn+bsess (M4 orphan-LWW reap lag, NOT a demote bug; fires only for
  foreign dead hosts). 
- Out of the promotion gate (steady-state + clean transfer already handled by demote/M6d). **Test-bed
  contaminant flag:** if a promotion test docker-kills a leaf, un-reaped residue shows as ghosts on
  restart — could be misread as a gate failure. Promote Inc-0→real reap only after the
  netns-cut-vs-docker-kill oracle decides A vs B.

## RECOMMENDED DEPENDENCY-ORDERED SEQUENCE
1. **Item 2 — alias-lifecycle live proof** (LOW). De-entangler; surfaces the bconn-write latency seam.
2. **Item 4 — stock-upstream control re-confirm** (LOW). Parallel with 1 (independent). Re-baseline.
3. **Item 1 — BX alias path** (HIGH, TRUE CRITICAL PATH). Gated by 1. Inc-0→Inc-1→Inc-2; re-run 4's
   control after each increment.
4. **Item 3 — M6b-2 buckets** (MED). Independent; pull EARLIER (BS O first) IF gate includes opered.
5. **Item 5 — orphan reap** (MED). Independent hygiene; out of gate.

**Critical path = Item 1, hard-gated by Item 2. Items 3/4/5 independent (4=sign-off, 3=conditional, 5=deferrable).**

## Open data to gather before coding
1. ~~Does the gate include OPERED sessions?~~ DECIDED: BS O post-gate (see Item 3); persist eventually.
2. Item 2 Inc-0 on a real 2-attach bed: bconn doc reaches 2; owning leaf is a presented stub on .2;
   measure materialize-lag (verify-timer-only write) → decides if eager bconn write needed.
3. Trace one real BX C + BX P on the wire toward legacy to confirm inv#3 source (present-stub vs &me)
   before writing crdt_m6c1_synth_bx_c.
4. Confirm nefarious-upstream is linked before trusting Item 4.

## 2026-07-28 — cross-server alias attach: the "blocker" is TWO different things

Investigated because the BX-carrier live gate (S2S-audit Cluster A) was recorded as blocked on
"cross-server alias attach doesn't work" (the skip note in `bouncer-cross-server-promote.test.ts`).

**FINDING 1 — over P10 it WORKS; the skip-note premise is STALE.** Verified live twice on the prod
pair (testnet:6667 primary + leaf:6668 alias, SASL PLAIN, same account):
`:leaf NOTE BOUNCER ALIAS_ATTACHED :Attached to session <sid> as alias on leaf...`, and the alias's
001 comes back under the PRIMARY's nick (the ghost's nick wins, as `createSaslBouncerClient` documents).
**The missing precondition is the SESSION:** a SASL'd client alone creates none — the test calls
`bouncerEnableHold()` (`BOUNCER SET HOLD on` → `SESSION_CREATED`) FIRST, and only then does a second
same-account connection attach.  A repro without that step gets a plain welcome and looks like the
bug.  ⇒ `bouncer-cross-server-promote` + `bouncer-alias-multi-server` should be re-run; their skip
reason no longer reproduces.

**FINDING 2 — across the CRDT MESH it genuinely FAILS (new, real).** Same flow, primary on nef3 +
alias on overlay-only nef7: SASL succeeds on nef7 (x3 `D S`, client registers with `pool07:<ts>`),
40s settle for doc convergence — and NO attach.  Root cause is upstream of the alias code:
**nef3 emitted no `BS C` for the new session and nef7 has ZERO knowledge of the sessid** (0 log
matches).  The session never reaches the overlay-only node by either plane, so there is nothing for
`bounce_setup_local_alias` to find.  Next step: determine whether the 5-5e M6a doc-native bouncer
mirror (bsessions/bconns) covers session CREATE at `BOUNCER SET HOLD`, or only later state changes —
a session minted while the peer is overlay-only may never be doc-mirrored/eager-pushed.

**HARNESS LESSONS (cost me three false failures):** (a) held ghosts KEEP THEIR NICKS — a gate that
reuses fixed nicks gets `433 Nickname is already in use` and the client never registers (looks like
"attach failed"); use unique nicks per run like the suite's `uniqueNick()`.  (b) `testadmin` is
polluted with held sessions from ad-hoc runs; use a clean pool account (`poolNN`/`poolpassNN`).

### Code-level corroboration (bouncer-analyst, 2026-07-28)

**Why the skip note misleads:** `bouncer-cross-server-promote.test.ts` carries TWO stacked, contradictory
comment blocks — lines ~82-89 (newer: root cause fixed in `e9b3b34`, blocked on pool/Keycloak drift) and
~101-116 (older, pre-fix: "blocked on an upstream issue"). The older one reads first and is obsolete.
Decisive history: the sibling test covering the SAME attach step, `bouncer-alias-multi-server.test.ts`,
was **un-skipped in `19b48a7` ("cross-server alias attach works", 2026-05-16)** and is still un-skipped;
the promote test was re-skipped hours EARLIER in `2762d31` for "pending pool/Keycloak sync stability",
never for the attach defect.

**The historical mechanism (now fixed):** `BOUNCER SET HOLD on` used to emit `BS C` but not `BS A`, so a
replica's `hs_client` stayed NULL → the ALIAS_REMOTE gate (`bouncer_session.c:1209-1218`) failed → control
fell to the orphan-reclaim branch (`:1225-1234`) → `bounce_attach()` returned 1 → `register_user` fell
through to the NORMAL welcome + `N` broadcast.  Exactly the reported symptom.  Closed by `e9b3b34`
(BS A from both create paths) + `abac5f4` (S2S METADATA hold broadcast) + `e96fde1` (session-exists
bypass) — all ancestors of the current prod HEAD.  ⇒ the defect was in the session-establishing
BROADCAST (`m_bouncer.c`), not the registration path, the BS C handler, or `bounce_setup_local_alias`.

**GAP A — REAL LATENT BUG, still open, both branches.** The HELD branch of `bounce_auto_resume` recovers a
NULL `hs_client` via `hs_ghost_numeric` + `findNUser` (`bouncer_session.c:1107-1114`); the **ACTIVE branch
(`:1209-1224`) has NO equivalent** — it logs "ACTIVE remote alias unavailable" and drops into orphan
reclaim, i.e. silently manufactures a PARALLEL PRIMARY (same failure shape as the historical bug, reached
another way).  Reachable in steady state (not burst — `s_serv.c:499-503` orders `bounce_burst` after the N
loop): `bounce_null_hs_client_pointing_at()` (`:2552-2564`) nulls it on Client free (primary's server
SQUIT+relink, collision kill), and `bounce_hs_client_assign_checked()` (`:2586-2609`) refuses a mismatched
BS A install leaving NULL while `hs_ghost_numeric` is written unconditionally at `:4151`.
FIX: hoist `:1107-1114` into a helper and call it at the top of BOTH remote branches, still routed through
`bounce_hs_client_assign_checked` (don't bypass the account check).  Stresses invariant #3 (numeric
composed from `hs_origin` — the existing site's own comment `:1092-1106` flags this; widening it needs
that audit note updated) and must not weaken #6.  TEST: link-flap variant of alias-multi-server — SQUIT
leaf↔hub, relink, third SASL connection on the leaf, assert exactly ONE primary in `/CHECK -b`.

**GAP B — cross-server hold divergence.** `METADATA *<account>` (oper account-target form) is NODE-LOCAL
by design (`m_metadata.c:749-754`), and the pool cleanup wipes `draft/persistence/hold` through a testnet
oper only (`account-pool.ts:351-356`) — so a leaf can retain `"0"` from a prior run.  Masked today only
because `bouncerEnableHold` re-broadcasts `"1"` first; any cross-server bouncer test relying on
`BOUNCER_DEFAULT_HOLD` WITHOUT calling it will silently get a plain user on the leaf and look exactly like
the old bug (`bouncer_session.c:1069-1071` returns 0 on explicit "0" before the e96fde1 bypass).  Do NOT
relax that check — an explicit opt-out must keep winning; fix the wipe's reach instead.

**GAP C — the promote half is genuinely unvalidated:** nothing exercises
`bounce_schedule_cross_server_promote` → `bounce_finish_cross_server_promote` (`:4718-4797`).  Also `BS T`
goes out via `sendcmdto_serv_butone_v3` (IRCv3-aware peers only), so a legacy peer in the path keeps a
stale `hs_origin` — fine on the 2-server bed, a problem with x3/upstream in between.

**DIAGNOSTIC PREREQ:** `bounce_auto_resume` logs its chosen branch at `bouncer_session.c:1118/1123/1200/
1214/1219/1227/1235/1250/1262` and `bounce_setup_local_alias` at `:7145/7161/7186`, all `LS_USER L_INFO`
— but `data/ircd.conf:269-270` and `data/ircd2.conf:222-223` configure only the SYSTEM subsystem, and
LS_USER defaults to no sink (`ircd_log.c:163`).  **Every one of those lines is discarded today.**  Add
`"LOG" = "USER" "FILE" "ircd-user.log";` + `"LOG" = "USER" "LEVEL" "INFO";` to both configs before
debugging this area again — one run then names the branch taken.

### SETTLED 2026-07-28 by running the suite

`IRC_HOST=localhost npm test -- src/ircv3/bouncer-alias-multi-server.test.ts` →
**`✓ creates an alias on leaf when same account is already primary on testnet` (1 passed).**
Cross-server alias attach is CONFIRMED WORKING in the committed suite.  The
`bouncer-cross-server-promote` narrative is obsolete; only its stale lower comment block
(lines ~101-116) should be deleted — the newer block (~82-89, pool↔Keycloak SASL drift) is
the accurate one.  NB that test is NOT `it.skip` — it is a live `it()` that early-returns
when the leaf is unreachable, so it has been silently passing-as-noop, not skipping.
