# Plan: CRDT-mesh post-heal divergence — Fix A (digest-aware anti-entropy)

## Status
- **Fix C — DONE** (this session): `from_crdt_peer` treats a CRDT-aware `STAT_MESH_SERVER`
  stub as a peer, so `crdt_shadow_retire_mesh_stub` stops minting DELETE/PART tombstones
  for held users (honouring its zero-tombstone contract). This removes the *originator* of
  the specific divergence the full-partition-heal test created.
- **Fix A — DONE** (submodule 43fe632, testnet 82ccf0a): anti-entropy is now content-aware
  (CR S carries the doc digest; receiver escalates to CR F on SV-match/digest-mismatch).
  cmocka +2; live-verified beacon_heal.sh converges nef3==nef4==nef5 @+135s, escalations
  bounded (1/2/3, no storm), 0 crashes. The implementation matched this plan as written
  (whole-doc digest, SV-equal gate, no cooldown needed — one-round commutative convergence;
  legacy `S :<sv>` still accepted). Post-heal divergence blocker CLOSED (Fix C + Fix A).

## Problem (root-caused 2026-06-10, code-confirmed)

Anti-entropy reconciles purely on the **state vector** (`CrdtStateVector.seq[]`, per-origin
op-sequence counters — `include/crdt_types.h:246`). The doc **digest** hashes value **+ HLC**
per entry (`ircd/crdt_state.c:807,876`) — content the SV does *not* summarise — but the
digest is **never on the wire** (0 occurrences in `m_crdt.c`/`crdt_wire.c`; it exists only as
a local verify-NOTICE diagnostic, `ircd/crdt_shadow.c:641`).

The CR S exchange (`ms_crdt`, `ircd/m_crdt.c:248`): a peer sends its SV (`"S :<sv_b64>"`,
`crdt_sync_request`), and we reply with a **full snapshot iff `crdt_shadow_peer_behind_floor`**
(peer below our gc_floor), else a **delta** (`crdt_delta_encode` emits only `seq > remote.seq`,
`crdt_wire.c:166`; the apply path drops SV-covered ops *before* the LWW merge, `crdt_state.c:654`).

⇒ **Two replicas with equal SVs but different content are structurally unrepairable.** A delta
is empty (SVs match); no snapshot fires (not behind floor). Observed: after a full partition +
heal, nef4 stayed frozen at the pre-cut digest while nef3==nef5 converged elsewhere; a fresh op
afterwards layered on top of nef4's divergent base (3rd distinct digest) without healing it.

(The only content-level reconcile in the whole system is the **CR F snapshot** on reconnect,
`s_serv.c:348` → `crdt_wire.c:408`, which HLC-merges bypassing SV-dedup but mints no op and is
pair-local — so it heals the reconnecting pair and nobody else. Finding B in the audit.)

## Fix A — carry the digest on CR S, escalate to CR F on SV-match/digest-mismatch

### Wire change
Extend CR S from `S :<sv_b64>` to **`S <digest> :<sv_b64>`**, where `<digest>` is
`crdt_state_digest(&g_crdt)` (the doc digest; the materialized mdigest follows once the doc
converges, so one param suffices). Send as a fixed-width hex `%016llx` (or decimal `%llu`) —
hex keeps it compact and unambiguous.
- **Producer:** `crdt_sync_request` (`ircd/m_crdt.c:~118`) — `sendcmdto_one(&me, …, peer,
  "S %016llx :%s", (unsigned long long)crdt_state_digest(&g_crdt), b64)`.
- **Back-compat:** the receiver must accept BOTH forms. Detect by parc/positionally: if the
  first post-`S` arg is the b64 SV (old form) vs a digest followed by the SV (new form). Since
  the SV blob is always the **last** param (`parv[parc-1]`), read the digest from `parv[2]`
  only when `parc >= 4`; when `parc == 3` (old peer) treat digest as "unknown" → skip
  escalation (degrade to today's behaviour). All testnet peers run the fork, so this is purely
  defensive.

### Receive logic (`ms_crdt`, the `sub=='S'` branch, `ircd/m_crdt.c:248`)
After `crdt_shadow_record_peer_sv(...)`:
```
if (crdt_shadow_peer_behind_floor(svbytes, svn))
    send_crdt_snapshot(cptr);                       /* existing: peer below GC floor   */
else if (have_peer_digest                            /* new form                        */
         && crdt_sv_equal(svbytes, svn)              /* peer SV == ours for all origins */
         && peer_digest != crdt_state_digest(&g_crdt))
    send_crdt_snapshot(cptr);                        /* NEW: SV-invisible divergence    */
else
    send_crdt_delta(cptr, svbytes, svn);             /* existing                        */
```
- **New helper `crdt_shadow_sv_equal(sv, len)`** (or reuse the decode in
  `crdt_shadow_peer_behind_floor`): returns 1 iff the decoded peer SV equals `g_crdt.local_sv`
  on every origin. Gating escalation on **SV-equal** is what prevents snapshot storms during
  normal op-lag: when SVs differ (the common transient), the existing delta path heals it and
  digests reconverge on their own; we only escalate in the pathological equal-SV/diff-digest
  case.
- The snapshot's HLC-merge (`crdt_wire.c:408`) then converges the two docs in **one round**;
  the next CR S shows equal digests → no further snapshots. Convergence is the storm-control.

### Storm safety / hysteresis (decide at implementation)
One snapshot should converge a pair, so a cooldown may be unnecessary. But to be safe against a
divergence the snapshot *cannot* resolve in one round (shouldn't exist under LWW, but defensive):
add a per-peer "last divergence-snapshot at" timestamp and suppress re-escalation within, say,
2× the verify interval (60s). Log each escalation (`"CRDT sync: digest mismatch at equal SV
(peer=%016llx local=%016llx) -> full snapshot to %s"`) so bring-up is observable.

## TDD (cmocka — engine level, where it belongs)
The reconcile primitive is engine code (`crdt_state.c`/`crdt_wire.c`), which links in the cmocka
harness with only `test_stub.o`. Add to `ircd/test/crdt_cmocka.c` (currently 37 suites):
1. **`test_equal_sv_can_differ_in_content`** — build two `CrdtNetworkState`, apply the *same*
   op-sequences so SVs are identical, but force a different surviving HLC/value for one key
   (e.g. a direct `crdt_lwwmap_set` with a higher HLC on one side). Assert SVs equal
   (`crdt_sv_equal`-style compare) AND `crdt_state_digest` differs. (Proves the bug is real at
   the engine level.)
2. **`test_snapshot_apply_converges_equal_sv_divergence`** — from state 1, encode a snapshot on
   the "winning" side and `crdt_snapshot_apply` it to the "losing" side; assert both digests
   now equal. (Proves the escalation's repair mechanism works.)

The CR S parse/escalation glue (in `m_crdt.c`/`crdt_shadow.c`) is Client-dependent integration
code, NOT in the cmocka harness — verify it via the live `beacon_heal.sh` partition/heal test
(already extended to assert nef3==nef4==nef5 digest convergence) plus an injected pure-content
divergence if one can be constructed without the retire path.

## Risks
1. **Snapshot storm** — mitigated by gating on SV-equal (only the pathological case escalates)
   + one-round convergence + optional per-peer cooldown. Highest risk; the SV-equal gate is the
   key control.
2. **Digest collision masking a real divergence** — `crdt_state_digest` is a 64-bit FNV-style
   hash; a collision hiding a true divergence is ~2⁻⁶⁴. Acceptable.
3. **Wire back-compat** — handled by positional parse (SV is always last param); old peers
   degrade to today's behaviour. All testnet peers are fork builds anyway.
4. **Cost** — `crdt_state_digest` is O(doc); already computed every 30s verify. CR S is also
   ~30s. Negligible at PoC scale; revisit with per-collection digests if the doc grows large
   (per-collection digest would also *bound the snapshot* to the diverged collection — a future
   refinement, not needed now).
5. **Stale Docker build masking the change** (recurring NB6) — verify the `ircd.YYYYMMDDHHMM`
   symlink advances + grep a new log string; `--no-cache` if stale.

## Commit / constraints
Standing CRDT-mesh rules: submodule push to `origin crdt-mesh`, testnet pointer staged as ONLY
`nefarious-crdt`, `Co-Authored-By: Claude Opus 4.8 (1M context)` trailer; configs uncommitted;
cmocka gates the image. Build via `scripts/dc.sh -l --profile multi up -d --build nefarious3
nefarious4 nefarious5`.
