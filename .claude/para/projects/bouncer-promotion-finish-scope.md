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

**GAP B — cross-server hold divergence — FIXED 2026-07-28 (`177caf7` prod).** `METADATA *<account>`
(oper account-target form) was NODE-LOCAL in BOTH branches — the offline case (documented era-2 §A4
limitation) AND the online-local case (`metadata_set_client` never emits S2S; the account branch
returned without broadcasting).  Empirically confirmed before the fix: pool04 held a persisted
`draft/persistence/hold "0"` on the leaf with NO row on testnet — exactly the stale-opt-out state that
makes `bounce_auto_resume` hand out a plain welcome (the explicit-"0" early-return fires BEFORE the
e96fde1 `bounce_has_sessions` bypass).  The opt-out check itself was NOT relaxed (explicit opt-out must
keep winning); the fix is the wipe's reach: mo_metadata broadcasts the write in an account-target wire
form (`MD *account key [vis] [:value]`) and ms_metadata gained an account-form branch (apply to
locally-online clients on the account, else persist a PERMANENT row; same first-hop limit stop; relay
onward; old peers FindUser("*acct")→NULL→harmless drop).  Gated by
`metadata-limits.test.ts "S2S: oper *account write propagates"` (red→green TDD; set AND delete
converge); pool04 divergence healed live with one testnet-side delete.  Two notes for posterity:
(1) the Vitest global teardown IS the Gap B producer — it wipes hold on all 10 pool accounts through
one server per run; (2) convergence only heals what the origin actually writes — the teardown "found
nothing to delete" on testnet for pool04, so the leaf's stale row survived until an explicit delete
was issued (the value-less form always broadcasts, even when the origin has no row).  The crdt-mesh
twin needs no port: its storage chokepoint mirrors permanent account rows into the doc (Tier C F2-b).

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

### FULLY SETTLED 2026-07-28 — BOTH tests pass

`bouncer-alias-multi-server` **1/1 ✓** (attach) AND `bouncer-cross-server-promote` **1/1 ✓**
(`remote alias promoted via 0-tick deferred timer after primary QUIT`).  The entire "blocker"
was stale documentation.  **This also VALIDATES Gap C** — the promote chain
(`bounce_schedule_cross_server_promote` → `bounce_finish_cross_server_promote`, BX P, BS T)
now has live end-to-end coverage on the 2-server bed.  The obsolete comment block in the
promote test has been replaced with the verified status + a warning not to restore it.
Still open from this investigation: **GAP A** (ACTIVE-branch `hs_ghost_numeric` fallback →
parallel primary) and **GAP B** (node-local `METADATA *acct` wipe), plus the CRDT-mesh
session-propagation gap (no BS C/BS A reaches an overlay-only node; the doc must carry it).

### GAP A FIXED 2026-07-28 — `cfe3722` (prod) / `272d8d2` (crdt)

`bounce_resolve_hs_client_from_ghost()` extracted from the HELD branch's inline recovery and
called from BOTH remote branches, still routed through `bounce_hs_client_assign_checked` (the
account check is never bypassed).  Safety argued rather than assumed, and documented on the
helper: this is NOT a BS-token handler (no live sender at registration time) so hard-invariant 3
does not strictly bind, but the hs_origin composition risk after a cross-server rebind is real —
a mis-composed numeric either fails to resolve (safe) or resolves to another account's client
(refused), and the residual same-account-sibling case still yields an ALIAS, strictly better than
the parallel primary it replaces.  Verified `BOUNCE_RESUME_ALIAS_REMOTE` and `_ALIAS_LOCAL` both
funnel into `bounce_setup_local_alias` (s_user.c:596-600), so recovering a LOCAL client and
returning REMOTE changes no caller behavior.  Crdt placement differs: the M6d lease block sits
ahead of the alias-remote test there, so the call goes just inside that scope.
GATE: build + cmocka clean on both branches; `bouncer-alias-multi-server` +
`bouncer-cross-server-promote` **2/2** on the fixed prod binary.

#### GAP A positive repro — ATTEMPTED, INCONCLUSIVE (be honest about this)

Staged: primary+HOLD on testnet, alias attached on leaf (baseline `ALIAS_ATTACHED: 1` ✓), then
severed the leaf's uplink with `ss -K dst <testnet-ip>` from a netshoot sidecar in the leaf's
netns (`rc=0`, killed the ESTAB socket).  **The leaf then failed to autoconnect back within 5
minutes** — one `Connect to testnet.fractalrealities.net` attempt at sever+~30s and no retry
after; the pair stayed split until a manual `restart nefarious2`.

Consequence: the new SASL client on the leaf connected while the primary was genuinely
UNREACHABLE, so `findNUser` on the composed ghost numeric correctly returned NULL, hs_client
stayed NULL, and orphan-reclaim fired — which is the CORRECT behaviour for a real split (the new
client took over the session, welcome came back under the primary's nick `gaP4364`).  **This
exercised the split case, not GAP A.**  GAP A needs the post-RELINK state: primary re-introduced
by burst (so the numeric resolves) while hs_client is still NULL.

So the fix currently rests on: build + cmocka + 2/2 non-regression + the code argument.  The
targeted path is NOT yet proven live.  To finish it, the repro needs a reliable relink — either
drive `CONNECT` from an oper on the leaf after the sever (testnet's Operator block grants
`set`/`rehash` but NOT squit/connect; nef3's grants neither — so a config edit is needed first),
or shorten the leaf's reconnect backoff for the test.  Worth turning into the standing link-flap
regression test the analyst proposed rather than an ad-hoc script.

#### Harness traps hit while gating this (all cost real time)

1. **Nick reuse across runs is only fatal when the ghost's account DIFFERS from the one you
   authenticate as.**  Registration does NOT hard-433 on a bouncer-held nick: `m_nick.c:319-329`
   defers the collision through auth (`auth_defer_nick`) when the holder is a bouncer ghost/session
   — then, per the comment there and confirmed by the maintainer, **a mismatch between the
   authenticated account and the session's account produces the LATE 433**; a match revives or
   attaches.  My `bxprim` gate hit exactly that: the leftover ghost belonged to `testadmin` while
   the script had been switched to authenticate as `pool07`.  So: use unique nicks per run
   (`uniqueNick()`), and never reuse a nick across accounts.
   *Correction:* two ad-hoc probes I ran to "confirm the softening" were VACUOUS — the hold
   returned `SETTINGS_UPDATED` rather than `SESSION_CREATED`, no ghost persisted (a plain client
   later took the nick freely), so they exercised a free nick and prove nothing either way.  The
   deferral semantics above rest on the code + maintainer, not on those probes.  If you want a
   real test, first assert `SESSION_CREATED` and then assert the nick is still occupied after the
   holder disconnects.
2. **`python3` buffers stdout when piped** — a long repro shows NOTHING until it exits, so you fly
   blind.  Use `python3 -u` for anything you intend to watch.
3. **A rolling `docker logs --since Nm` poll can MISS a one-shot event.**  Waiting for a relink by
   grepping `--since 5m` every 10s never matched, because the burst fired immediately on restart
   and aged out of the window before the first poll — the bed was healthy the whole time and the
   PROBE was wrong.  For one-shot events either grep the whole log, anchor `--since` to a fixed
   start timestamp, or verify functionally (here: connect and read the 251 server count).

### GAP A is PARTIAL — the relink case has no ghost numeric at all (code-verified 2026-07-28)

Reading `bounce_burst` (`bouncer_session.c:3570`) while building the link-flap test: on a relink it
sends **only `BS C`** per session (plus `BS O` for an oper grant).  Its `BS C` format carries
account/sessid/token/state/created/attach_count/total_active/channels — **no ghost numeric**.  And
`hs_ghost_numeric` is written in only two places: the DB-restore ghost path (`:3275`) and the BS D
wire field (`:3805`), plus the BS A/BS D handlers on replicas.  Every `bounce_broadcast(...,'A',...)`
site is event-driven (attach/resume/hold-create: `:1212`, `:1265`, `:5526`, `m_bouncer.c:102/168`,
`m_persistence.c:224`) — **none fires on relink.**

⇒ A replica created fresh by a relink burst has hs_client NULL **and hs_ghost_numeric EMPTY**, so
`bounce_resolve_hs_client_from_ghost()` returns immediately and the GAP A fix does NOT help it.
The fix covers only the case where a BS A/BS D had already populated the numeric and hs_client was
later nulled (Client free on SQUIT, collision kill, refused install).

**RETRACTED by the live test — the relink case WORKS.**  Ran it (primary+HOLD on testnet, restart
the leaf to force the burst, new same-account client on the leaf) and the leaf's own log shows the
attach succeeding:
`NOTE BOUNCER ALIAS_ATTACHED :Attached to session AZ+qej+McGOqSDENTjwcYQ as alias on leaf` and
`Bouncer: alias rlP9151 created for session ... on leaf`.  My script printed
"ALIAS_ATTACHED: 0 -> SECOND PRIMARY (gap confirmed)" — that verdict was a HARNESS BUG: the client
read loop stops at the first of 001/422/433 and the 001 arrives BEFORE the notice, so it never read
it.  **Always confirm a bouncer verdict against the server log, not just the client stream.**

So: the code observations above stand (burst `BS C` really does carry no ghost numeric, and no
`BS A` fires on relink), but the INFERENCE that the relink case therefore manufactures a parallel
primary is FALSE — something else resolves the primary on that path.  What remains genuinely
undetermined is whether the GAP A fix is load-bearing here or whether this path already worked
before it; `bounce_hs_client_assign_checked` only logs on REFUSAL, so a successful recovery is
silent.  Wiring the `LS_USER` sink (see the diagnostic prereq above) would answer it in one run.

### LS_USER sink WIRED 2026-07-28 (do this before any further bouncer debugging)

The branch-decision logs in `bounce_auto_resume` / `bounce_setup_local_alias` were being discarded
because `LS_USER` had no sink.  Added to BOTH prod-pair servers:

```
     "LOG" = "USER" "FILE" "ircd-user.log";
     "LOG" = "USER" "LEVEL" "INFO";
```

**Where to put it:** NOT `data/ircd*.conf` — those are UID-1234-owned and the host user can't write
them.  The live file is `/home/nefarious/ircd/base.conf` INSIDE each container (generated from
`base.conf-dist`, so it uses 5-space indent and `LEVEL "CRIT"`, not the host file's formatting —
a sed keyed to the host file's shape silently matches nothing).  Edit in place with awk/sed to a
temp file + `cat >` truncation (never `sed -i`/`mv`: a rename breaks the per-file bind mount), then
`docker kill --signal=HUP`.  The file is created lazily on the first LS_USER write.

Confirmed live: `ircd-user.log` now carries `check_auth_finished` entry/exit and `Bouncer HOLD:`
lines that were previously invisible.

**Why this matters for GAP A:** the `:1200` ACTIVE log prints `hs_client=%p` BEFORE
`bounce_resolve_hs_client_from_ghost()` runs, so the pair of lines is a decisive discriminator —
`hs_client=(nil)` followed by "ACTIVE alias_remote path" proves the helper recovered the pointer
(fix load-bearing); a non-nil pointer there proves the path never needed it.

### GAP A: SETTLED with evidence — the fix is DEFENSIVE, not demonstrated-necessary

With the LS_USER sink live, the relink scenario finally logged its own decision on the leaf:

```
Bouncer: ACTIVE session AZ+qjm7IcGOmel3k8fg/Qg found for pool01
         (origin=Bj me=AC hs_client=0x0000000014edb0c0 alias_count=0)
Bouncer: ACTIVE alias_remote path for pool01 session AZ+qjm7IcGOmel3k8fg/Qg (primary on testnet)
bounce_setup_local_alias: converting rlN3752 to alias of rlP3752
```

That `hs_client=%p` is printed BEFORE `bounce_resolve_hs_client_from_ghost()` runs, and it is
**NON-NULL** — so the helper early-returned and contributed nothing.  **The post-relink path already
worked; the GAP A fix is NOT load-bearing there.**  (The HELD path likewise logged
`HELD alias_remote path` + a successful alias conversion for pool02.)  Something already populates
`hs_client` on a burst-created replica — worth identifying if this area is revisited, since it also
explains why the missing ghost numeric in burst BS C never mattered.

Standing assessment of the fix (`cfe3722` / `272d8d2`): the ASYMMETRY it removes is real (HELD had
the recovery, ACTIVE did not), the change is a strict improvement, and it is gated by build +
cmocka + 2/2 cross-server tests.  But the state it repairs — `hs_client` NULL *with*
`hs_ghost_numeric` set — has NOT been observed live.  The analyst's reachability argument
(`bounce_null_hs_client_pointing_at` on Client free, a refused `bounce_hs_client_assign_checked`
install) is plausible but unconfirmed.  **Treat it as defensive hardening, not a proven bug fix.**
Anyone wanting to prove or retire it should force those two states directly rather than via a
relink, which demonstrably does not produce them.

### 2026-07-29 — the "mesh session propagation" blocker DISSOLVED; the real blocker is account-prop

**The recorded gap ("a session on nef3 never reaches overlay-only nef7; the doc must carry it")
was WRONG — the doc ALREADY carries it and the pipeline works.**  Proven live on the crdt bed:
holder sweep (`bounce_crdt_bsess_sweep`, 30s) → doc → eager push → nef7's
`crdt_shadow_reconcile_bouncer` materialized pool02's replica session at 0:26:45 — ONE second before
a same-account client registered there.  Census (`CRDT bouncer doc: 4 session(s), 2 connection(s),
4 lease(s)`) is identical on hub and overlay-only nodes.  **End-to-end tick latency is up to ~75s**
(two 30s ticks + slack); an 8s wait between "primary up on nef3" and "connect to nef7" is too
short and produces a false "no session" verdict (it created a parallel session — retried with 75s
and the replica was there).

**Why the alias attach STILL fails on nef7 (the ACTUAL BX-gate blocker):** with the replica present,
`bounce_auto_resume` takes the ACTIVE path, `hs_client` is NULL, and the Gap A helper composes the
ghost numeric and finds the CORRECT candidate (the real nef3 primary) — but nef7's copy of that
client carries a STALE ACCOUNT (log: `refusing M6d alias-target hs_client install for session …
(account=pool05) — candidate yp33261 has account=pool02`).  `bounce_hs_client_assign_checked`
correctly refuses (without it this would be a cross-account session hijack — **the Gap A defensive
check is load-bearing on the crdt bed even though it isn't on prod**), the alias path is
unavailable, and orphan-reclaim manufactures a parallel primary.  Root cause = the known
**account-propagation gap to overlay-only nodes** (memory: "account-prop reliable only on hub
nef3"; scope: `crdt-mesh-3l-users.md`).  Fix THAT and the BX gate unblocks.

**The hold-"0" reversion hunt (how we got here), for posterity:**
- nef7's store held stale `draft/persistence/hold "0"` for pool01–03 → silent
  `bounce_auto_resume` early-return (explicit opt-out wins by design) → plain welcome regardless
  of sessions.  This was the FIRST layer masking everything.
- Restarting a node runs a boot-time store→doc backfill that mints STALE store rows into the doc
  with FRESH HLCs: nef7's 0:23 restart minted its stale "0"s ~3 min later, which LWW-beat "1"
  writes made seconds EARLIER on nef3 and re-imposed "0" network-wide via the reconcile.  A
  restart is therefore a stale-value AMPLIFIER for any store row that diverged before it.
- New diag `/CRDT key <account> <metakey>` (crdt `24a48f1`) prints the doc entry + HLC + wallclock
  delta — flags FUTURE entries.  `/CRDT clockstep 0` reads the live fake-clock offset (all 5 nodes
  were +0; live skew ruled out).
- UNRESOLVED one-off: pre-restart nef3 showed fresh hold writes never landing in its store
  (store read "0" at t+1s post-write; zzztest through the same path persisted fine) while the doc
  had NO hold entry at all.  The process was replaced by the diag rebuild before the mechanism was
  isolated; if it recurs the diag + phase-watch (store read at t+1s) pins it in minutes.
- Post-restart everything behaves: hold=1 lands (store+doc), sticks through quit, converges to
  nef7 (~30s), and nef7's auto_resume then correctly finds the replica.

**Harness traps found (all cost real time):**
- `tests/src/scripts/cleanup-tests.ts` pool-hold wipe was a LIFETIME NO-OP: old target-second
  syntax (`METADATA SET *poolNN key` → FAIL SUBCOMMAND_INVALID) accepted by its own
  `|FAIL METADATA` regex, AND iterated pool00–09 (accounts are pool01–10).  Fixed 2026-07-29.
- METADATA is CAP-gated (`draft/metadata-2`) — without the cap the command 421s.  Client syntax is
  target-FIRST (`METADATA <target> GET <key>`).
- An UNOPERED reader of a private key gets 766 NOTSET even when the row exists (deliberate
  existence-leak fix) — a probe that fails to oper produces a vacuous "not set" verdict.

### 2026-07-29 (cont.) — account-prop fix SHIPPED (`b0a2cbd`); hold-"0" re-mint is the remaining saboteur

**Account-prop fix (crdt `b0a2cbd`, deployed nef3+nef7):** producer — `ms_account` now re-mints the
doc user record at all three syntax tails (U/R/M + old), single-writer safe via the `from_crdt_peer`
gate; consumer — `recon_user_cb` gained an ACCOUNT drift clause (drives `ms_account` R/M,
SERVER-sourced, skip_crdt one-shot = legacy gateway).  LOGOUT direction deliberately not driven
(`AC U` destroys bouncer sessions + clears metadata — too destructive on doc lag) — DEFERRED.
Gate: compiles, deployed, mat-check shows zero `account` gaps + no regression; **the drift-heal
fire + full alias E2E are still UNGATED** because of the item below.

**OPEN BUG — stale hold-"0" re-mint (the thing that sabotaged every alias gate tonight):**
`/CRDT key pool06 draft/persistence/hold` on nef7 showed `"0" writer=6` (nef5 — a node NOT touched
all night) minted at ~1:38:39, ~4s AFTER nef3's genuine `"1"` (SESSION_CREATED 1:38:35) → "0" wins
LWW → reconcile re-imposes "0" on every store → `bounce_auto_resume` silently early-returns on the
explicit opt-out.  nef5's DEBUG log shows NO inbound "0" on the wire — the mint came from a LOCAL
write path on nef5 at peer-relink time.  Pattern so far: doc-absent window (post-GC or fresh boot)
+ any node holding a stale store row → that node re-mints the stale value with a NOW HLC and
clobbers genuinely-newer state.  Same shape seen at nef3's boot (writer=3 mint ~3min post-restart)
and nef7's 0:23 restart (poisoned pool01-03).  UNIDENTIFIED: the exact local code path on nef5
that wrote "0" (candidates: umode -b flag→metadata sync via set_user_mode on burst/MODE processing;
a bouncer path; NOT ms_metadata — suspend bracket held, wire clean).  NEXT STEPS: (1) find the
writer — grep set_user_mode 'b' MODE_DEL reachability from burst/relink, and add a one-line
LS_SYSTEM log at m_bouncer/persistence/s_user hold-"0" write sites naming the caller; (2) design
fix: backfill/boot mints of PRE-EXISTING store rows must not carry a NOW HLC (epoch-HLC mint, or
no mint at all — doc-absent means unknown, not "assert my copy"); (3) then re-run the pool06 alias
E2E (primary nef3 + hold, 75s, connect nef7, expect `ACTIVE alias_remote path` + 
`bounce_setup_local_alias: converting` in nef7's ircd-user.log).

Bed-state note: pool01–03 hold="0" in the doc (nef7-boot mints), pool06 "0" (nef5 mint); healing =
any newer genuine "1" write (SET HOLD on) AFTER the last stale mint wins and re-imposes everywhere.

### 2026-07-29 (final) — hold-"0" re-mint ROOT-CAUSED + FIXED (`d499f60`); ALIAS-ATTACH GATE GREEN

The re-mint was a **dual-plane coherence loop**, not a backfill: metadata→flag sync set
FLAG_BNC_HOLDPREF (wire umode 'b') without re-minting the doc user record → doc umode letters
lacked 'b' while burst carried +b to peers → each peer's umode-reconcile drove `-b` → `case 'b'`
MODE_DEL called `metadata_set_client(hold,"0")` UNGATED for the remote user → chokepoint minted
"0" with a NOW HLC → beat the home's genuine "1".  The "boot backfill amplifier" = the same
mechanism firing en masse at relink burst; the per-tick `umode N` mat-gaps = the -b/+b fight.
FIX (one plane per fact): MyUser-gate the flag→metadata writes in set_user_mode ('Y' + 'b');
re-mint the user record in metadata_set_client when a synced flag actually flips.

**GATE GREEN (fleet-deployed, all 5 nodes, waves of ≤2):** pool07 primary+hold on nef3 → 80s →
same account on overlay-only nef7 → `ACTIVE alias_remote path` + `bounce_setup_local_alias:
converting zp76552 to alias of zp36552`, client welcomed under the PRIMARY's nick.  hs_client was
NULL at entry — the Gap A ghost-numeric recovery (`272d8d2`) resolved it AND the account check
passed (`b0a2cbd`): both validated load-bearing in the same run.  Zero "0" mints on the former
minter; doc hold=1, writer=home only.  **THE BX-GATE BLOCKER IS CLEARED.**
Remaining for the full BX gate: verify the alias's doc bconn materializes back on the primary's
side (nef3 aliases:1) + the destroy half over the overlay — next session.

### 2026-07-29 — **FULL BX GATE GREEN over the overlay** (pool09 run, post-`d499f60` fleet)

All four legs in one run: (1) session nef3 (`SESSION_CREATED`), (2) nef7 alias attach
(`ACTIVE alias_remote path`, primary's nick, ALIAS_ATTACHED on the client stream), (3)
**back-materialization on nef3**: `M6c-1 BX Inc0: materialized alias AIAAD from doc` + BX C synth
to legacy (`created 0 replica + 1 alias(es)`), (4) **destroy half**: `BX Inc-2: de-materialized
stale replica alias (doc bconn tombstoned)` after the alias quit.  The alias lifecycle is
doc-native across the mesh including the overlay-only node.  **MR-6 BX gate: CLOSED.**

Prereq bed hygiene (recurring trap, now understood): the bouncer DB restores held ghost sessions
across container rebuilds, so pool accounts accumulate stale sessions and `BOUNCER SET HOLD on`
answers "session limit reached" (no session created → nothing to mirror → a gate silently tests
nothing).  Cleanup = attach each account + `BOUNCER SET HOLD off` (destroys session network-wide);
done for pool01-09 (pool04/07 were alias-attached to still-held sessions; pool10 SASL creds
drifted, 904).  ALWAYS check for `SESSION_CREATED` (not `SETTINGS_UPDATED`) before trusting a gate.

### 2026-07-29 — ms_mark IsMe fix (`17f9d5e`) fleet-deployed + VERIFIED

Zero "MARK from non-server" violations on nef3/5/7 post-deploy (was: wallops spam every verify tick
with MARK drift + silently DEAD cversion/sslfp/geoip convergence).  The per-tick umode-oscillation
mat-gaps are also gone (cured by `d499f60`).  Remaining mat-check residue, both pre-existing and
separate: (a) `dp32573 in doc, not live` on nef3 — held-session ghost's doc user record vs no live
client (reap/hold interplay, watch-item); (b) `BjAAA/BjAAB fields: host umode` — legacy-side (prod)
user host/umode drift in the mirror, the known legacy-leaf residue class.

### 2026-07-29 — gateway_birth_modes extended-render IMPLEMENTED (`eba38ec`), gate deferred

Birth bridge now emits +A/+U/+L (string-presence-gated) + exmode bits + widened entry gate
(extended-only channels were skipped).  GATE PLAN (next session): partition nef3 from the mesh (or
use a legacy-peer relink) so a channel with apass/upass/redir/exmode set on nef7 is doc-resident
BEFORE nef3 births it; then assert the legacy peer (prod testnet) sees the extended modes on the
birthed channel.  A fresh-channel test races the eager birth and proves nothing.

### 2026-07-29 — **birth-modes extended-render GATE GREEN** (`eba38ec` deployed nef3)

Partition choreography via the nef3 rebuild window: #bmgate created on nef7 with
`+stinMTSlL 47 #bmover` (exmodes M/T/S + redirect; +A/+U skipped — MODE syntax rejected the pass
args, revisit separately) while nef3 was down.  On boot+sync nef3 logged
`create-reconcile: created channel #bmgate from doc` immediately followed by the legacy-ward
`M #bmgate +stinMTSlL 47 #bmover <ts>` — the full extended set (exmode letters + redirect string)
in the birth emit, which pre-fix carried only classic+key/limit.  MR-6 residue list is now:
+A/+U set-syntax question (client-side; not a bridge gap), held-ghost doc record watch-item,
legacy host/umode mirror drift, pool10 creds.

### OPEN — held-ghost stale doc user record across restart (watch-item promoted to problem statement)

`mat-check gap: user ADAAN (dp32573) in doc, not live` every tick on nef3, no owner-sweep/reap
lines at all.  Chronology: pool09's primary quit ~2:27 → session HELD (ghost dp32573, numeric
ADAAN) → nef3 REBUILT 3:06 → bouncer DB restored the held session with a NEW ghost numeric → the
doc user record under the OLD numeric ADAAN is orphaned (findNUser NULL) and nothing reaps it.
Hypothesis: the owner sweep's reap-gating (invariant-11 / orphan-reap characterization: spare
records tied to live sessions) spares it because pool09 HAS a session, while the record's numeric
can never resolve again.  NEXT SESSION: load project_crdt_orphan_reap_characterization + the
invariant-11 lesson, decide whether restore-time should re-key/tombstone the old-numeric record
(bounce_db_restore side) or the sweep should reap session-owned records whose numeric is dead.

### 2026-07-29 — held-ghost residue ROOT-CAUSED + FIXED (`8477655`), reap VERIFIED

The owner sweep's burst-defer was GLOBAL over all IsServer links; x3.services never sends EB
(perpetually in burst), so the sweep was permanently disabled on any node with a legacy path to
services — the gateway, exactly where legacy-adjacent residue accumulates.  Overlay nodes see x3
as a mesh anchor (not IsServer), which is why the 2026-07-26 live gates passed.  Same lesson
reconcile_users' per-user burst guard already encoded, now applied here: defer only on a
DIRECTLY-CONNECTED bursting link (real inbound resync); 2-pass debounce stays.  VERIFIED on nef3:
`owner-sweep: reaping own-origin user record ADAAN` fired one debounce cycle after deploy; the
"in doc, not live" mat-gap is gone.  (The residue's origin — bouncer-DB restore re-keys held
ghosts to new numerics across restart, orphaning old-numeric records — is now handled by the
sweep as designed.)

### 2026-07-29 — legacy host/umode mirror drift ROOT-CAUSED + FIXED; +A/+U + pool10 questions closed

**Drift mechanism (BjAAA/BjAAB, every-tick `fields: host umode` on all four mesh nodes, gateway
clean):** the doc record was RIGHT (== nef3 live: host `pool00.Users.Network`, umodes `xrCc`);
the mesh nodes' LIVE copies were stale (raw-IP host, `xr` only) and the reconcile could never
converge them, because (a) the umode delta cannot drive param'd modes — `set_user_mode` cases
C/c/r/h/f require a following value the delta doesn't carry and the record doesn't store — and
(b) no clause drives the displayed host at all (it's DERIVED state: hidden-host style/cloak).
The poisoned copies came from materializing a HALF-INTRO record: `set_user_mode`'s tail mint
fires during N-intro parse (set_nick_name applies umodes BEFORE register_user derives
cloak/hidden-host), publishing flags `+xrCc` with the still-raw host; a mesh node that
materialized from that snapshot could then never heal (account already converged → the
ms_account-driven hide_hostmask re-derivation never fired again).

**Fix (both sides):** (1) owner: gate the set_user_mode tail mint on `IsRegistered` — the
register_user tail (which runs user_setcloaked + hide_hostmask FIRST) mints moments later with
derived state; (2) consumer: derived-state convergence clause in `crdt_reconcile_user_update`
after the umode/account drives — `user_setcloaked(live)` when rec has C/c but live lacks the
flags (cloaks compute from ip + shared keys, owner-identical), and `hide_hostmask(live)` on
host drift (self-noops when converged, proper CHGHOST emission).  nef5 rebuilt: baseline clean
(Bj mat-gaps zero).  Standing 30s mat-check is the long-run gate fleet-wide.

**+A/+U set-syntax question CLOSED — not a bridge gap:** `mode_parse_apass/upass` are reached
for client sources only under `FEAT_OPLEVELS` (channel.c `case 'A'/'U'`), which the bed leaves
off (commented out in ircd.conf) — the "unknown mode char" spray was the unconsumed password
argument.  Server-sourced A/U always parses, and the extended birth render drives A/U via the
same modebuf_mode_string path the gate proved with REDIRECT.  To client-gate A/U end-to-end,
enable OPLEVELS on the writer node (deliberately not done mid-bed: it changes oplevel burst
semantics).

**pool10 "cred drift" CLOSED — pool10 does not exist:** Keycloak (realm `testnet`) provisions
exactly pool00..pool09 (kcadm-verified).  The 904 was a probe against a non-provisioned
account; cleanup-tests.ts pool range corrected to 00..09 (the earlier 01..10 comment was wrong).

Gate caveat (per no-silent-defer): the new consumer derivation clause was NOT separately
live-exercised — nef5's baseline healed by re-materializing from the now-healthy record, and the
driftgate2 differential (mid-session auth, fixed nef5 vs unfixed nef4) converged on BOTH nodes
via the normal ms_account→hide_hostmask path (account+umode co-drift in one tick).  The poisoned
state needs the materialize-from-half-intro interleaving (burst/partition op ordering), which
has no on-demand repro.  The mechanism is code-proven (mint ordering in set_user_mode vs
register_user) and the fleet-wide 30s mat-check is the standing regression alarm.

### 2026-07-29 — OPLEVELS enabled bed-wide + A/U GATE GREEN; oplevel-drift reconcile fixed (live-exercised)

`"OPLEVELS" = "TRUE"` enabled in all 7 configs (inode-preserving truncation writes + fleet HUP —
no restarts, no relink).  A/U gate: fresh channel on nef5, client-set `+A adminpass1` /
`+U userpass1` accepted (324 `+mtnAU`), values converged byte-identical on the gateway, the
LEGACY primary, and the overlay-only leaf (CHECK: `+mtnAU adminpass1 userpass1`, same ctime).

The first gate run surfaced a real drift the feature had been masking: `#oplgate member status
doc=1 live=1` every tick on the P10-CREATE-path branch — mat_member_cb compares member OPLEVEL
(log printed only status), but reconcile_mstatus_cb's echo guard early-returned on equal status
bits, so an oplevel-only drift (create-time level on P10-path nodes vs the owner's manager level
after +A) was checked-but-never-driven.  Fixed both sides, oplevel scoped to OPPED members (it
is op-grant data, junk otherwise): the echo-guard branch now silently corrects m->oplevel from
the doc (no wire emission — oplevel rides op grants), and the mat-check only compares oplevel
while opped + prints both values (`doc=st/opl live=st/opl`).  Deployed in 3 waves; second gate
run: `member-status-reconcile: drove 1 member(s)` on 4 nodes with status already in sync — the
new clause IS the thing that fired — and zero member gaps fleet-wide.  (A transient
`channel in doc, not live` strand on nef3 after the gate channel dissolved self-repaired within
one anti-entropy cycle.)  Client +A/+U is now testable on the bed for posterity.

### 2026-07-29 — EAGER-MINT SHIPPED + GATED: bsess E2E 13-31s → SUB-SECOND

The user's latency concern closed.  Producer side was the whole wait: the M2/M4 doc mirror was
sweep-only (30s tick) while the consumer already reconciled per-delta (M6c-1 Inc-2).  Shipped:
- `bounce_crdt_bsess_mint_one(s, conns)` extracted from the sweep (M2 record + M4 me-hosted
  roster, self-gating single-writer); sweep keeps the M3/M4 de-risk diagnostics + M5 lease +
  M6d stand-down TIMER-ONLY (settled-state semantics).
- Eager calls at 11 mutation sites: bounce_create / attach / hold_client / revive /
  promote_alias / rebind_ghost / session_transition / apply_remote_oper_grant / m_oper grant /
  s_user -o|-O grant-clears / m_bouncer SET SESSION HOLD; the M6c-1 Inc-1 ad-hoc alias bconn
  write generalized into the helper.
- **hold_override was minted but DROPPED on the consumer** (replica-create hardcoded -1,
  reconcile never applied drift; `SET SESSION <id> HOLD on|off` has NO BS carrier — the doc is
  its only path).  Fixed both consumer points (doc-apply clause + replica-create copy).
- **Create-time eager M5 lease claim** (bounce_create only): consumers' replica-create gates on
  the lease; sweep-only claim made new-session replicas materialize at the next 30s tick (~19s
  measured).  A fresh sessid's claim is uncontested by construction; crdt_blease_decide still
  arbitrates and a contested (<0) result is NOT claimed eagerly — M6d conflict stays timer-paced.

GATES (all live): flip-path — T0 01:22:55.463 SET SESSION HOLD off on nef3 → nef7
`hold_override -> 0 (doc-apply)` at 5:22:55 (SAME SECOND, was 13-31s).  Create-path —
SESSION_CREATED 01:28:57 → nef5 AND nef7 `created 1 replica session(s)` at 5:28:57 (same
second, was ~19-30s).

RESIDUE (Item-5 orphan class, noted not chased): BOUNCER ORESET of a HOLDING ghost leaves the
bsess doc record un-tombstoned (destroy-path ordering skips the MyConnect-gated
crdt_shadow_bsess_remove) → stale record makes the M3 election-divergence diagnostic fire on
the owner every tick (diagnostic-only; the stale lease is inert — M6d needs a live local
primary).  Fold into the existing deferred Item 5 (orphan doc-record reap for bsess/bconn).

### 2026-07-29 — NICK-COLLISION LIVE GATE GREEN (§17.5) + partition-reap channel-death fix

**Collision gate** (roadmap item 2 closed): netns-sidecar partition of nef7 (iptables DROP + ss -K
its 2 S2S links); split-born `collgate` on BOTH nef7 and nef3; heal + forced `CONNECT
leaf3` from nef7.  Resolution: nef7 `CRDT nick-collision: force-renamed local collgate -> AIAAA
(lost 'collgate')` — the loser got a clean NICK echo on its own socket and STAYED CONNECTED the
full 15-min hold; the winner never saw a thing; end state fleet-consistent (collgate + AIAAA both
live everywhere); valgrind zero invalid accesses.  Rule check: both claims were the SAME
user@host (host-bridge ip + ident `cg`) → §17.5's same-identity branch = NEWER wins (reconnect
semantics) — the observed outcome is per-spec (older-wins applies only to DIFFERING identities).

**Bonus find — partition-reap permanently killed alive-elsewhere channels:** post-heal, #TheOps/
#OperServ/#MrSnoopy stayed "in doc, not live" on nef7 forever.  Chain: anchor retirement reaped
x3's users (correctly WITHOUT doc tombstones — single-writer), emptying the service channels →
local destruct bumped the LOCAL ctime incarnation (invariant 7) → post-heal the doc members are
present-not-removed FOREVER (the bots never left), so invariant 7's "stays dead until the
tombstone clears the member" branch can never resolve → permanent local channel death.  Fix: a
reachability-destruct bracket around crdt_shadow_retire_mesh_stub's reap — channel destructs
inside it are MECHANICAL (path loss), and skip the ctime bump so reconcile-create can resurrect
from the doc.  GATE: re-ran the identical partition cycle on the fixed binary — channels died at
retirement and CAME BACK ~2 min after heal with no restart (`create-reconcile: created channel`
+ NAMES shows @MemoServ); fleet mat-check zero.

(Doc correction for the skill: `ctime_del` IS serialized in the CR F snapshot (crdt_wire.c:359)
— the "per-server-local" note is about the DIGEST not hashing it; the wire does carry it.)

### 2026-07-29 (morning) — ORESET/HOLD-off orphan FIXED (`5d44734`): bounce_destroy_owned

The Item-5-class orphan from last night root-caused: FIVE sites (m_bouncer SET HOLD off,
m_persistence SET OFF + DETACH, s_user umode hold-pref clear, bounce_kill_session) cleared
`hs_client = NULL` BEFORE `bounce_destroy` to unanchor the primary from later exit cleanup —
silently defeating the destroy's MyConnect single-writer tombstone gate (5-5e M2), so
bsess/blease doc records orphaned on every such destroy.  `bounce_destroy_owned()` tombstones
while hs_client still proves ownership, then unanchors + destroys; all five converted.
GATE (non-vacuous): 2 sessions destroyed via the HOLD-off path + a third left HOLDING as the
live M3 election subject → two sweeps, ZERO divergence (pre-fix the oldest orphan wins the doc
election every tick).  Residue: pool03's PRE-fix orphaned records remain inert until the Item-5
reap (they only surface when pool03 has a live session).
