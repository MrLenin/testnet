# Tier C F2 — RocksDB feature-state over the mesh (MD / MR / RD)

> Scoped 2026-06-29 (two read-only recon passes + user decisions). Continues
> `crdt-mesh-tier-c-scope.md` §F2. F1 complete (`57c6575`). These three are
> RocksDB-backed (unlike the in-memory F1 user fields) and semantically distinct.

## Decomposition (they are NOT one pattern)

| | State / key | Merge | Churn | S2S today | CRDT shape |
|---|---|---|---|---|---|
| **MR** read-marker | `account\0target` → ts | **monotonic MAX** | HIGH | MR broadcast | **max-register** collection → RocksDB |
| **MD** metadata | `account\0key` / `#chan\0key` → val+vis+TTL | LWW (CLEAR=del) | LOW | MD/MDQ broadcast | LWW-map collection → RocksDB |
| **RD** redaction | per-message (in chathistory) | append-only | very LOW | RD broadcast | — (reclassified) |

- **RD → reclassified to 5-5f (CH federation).** Live redaction is already broadcast-covered; its
  only mesh gap is *federated query* of redacted history, which is the deferred chathistory track. RD
  is NOT F2 work. (Per the scope audit's own §RD note.)
- **MR + MD are the F2 work.** This session: **F2-a (MR)**. F2-b (MD) scoped below, built next.

## Per-profile caveat (resolved 2026-06-29)
markread today is **account-anchored persistent** (RocksDB `readmarkers_cf` `account\0target`, S2S) OR
**session-anchored ephemeral** (in-memory `(session_id,target)`, no S2S, purged on session end).
**Per-profile *persistent* markread has NOT landed** (persistence profiles exist as account-metadata
keys `draft/persistence/profile/...`, but markread is not profile-keyed).
**Design rule: the doc collection keys by the markread STORAGE key as an OPAQUE BLOB** — no
account-stripping logic in the CRDT layer. If per-profile markread is later built (storage key →
`account\0sessid\0target`), the convergence inherits it with zero CRDT change. The ephemeral session
variant stays local (never doc'd — ephemeral by design). Generalizes to MD ("and maybe other things").

---

## F2-a — read-marker (MR) over the mesh  [DONE 2026-06-29 — `8eec2df`, ptr `29eaf16`]
> **RESULT:** built as designed (lexical-max-register, opaque key, additive mirror+reconcile).
> cmocka `test_marker_op_replicates` (max-no-regress guard) [OK]. LIVE: testadmin set MARKREAD on nef3
> → mirror fired → marker propagated to all 5 docs → **overlay-only leaf nef7 (received NO P10 MR)
> converged it to readmarkers_cf purely via the doc (applied=1)** = the Tier C gap closed; tree-reachable
> nef4 got it via P10 (doc redundant/idempotent) — additive. 0 crash. NB the live exercise needs the
> client to negotiate `draft/read-marker` CAP + a working SASL account-prop (only the hub had reliable
> account-prop on the partially-recreated bed — a bed-state artifact, not a code issue).


### Why convergence is needed
Read-markers are account-anchored for **multi-device sync**: device A on server X advances the marker;
device B (same account) on server Y must see it. Under tree-retirement the `MR` broadcast doesn't reach
an overlay-only leaf Y → device B sees a stale marker. The doc converges it + backfills on link.

### Multi-writer + MAX merge (the one new engine primitive)
The SAME account updates from ANY server it connects to ⇒ **multi-writer**. A read-marker is monotonic
(only advances — `metadata_readmarker_set` already "only if newer"). So the merge MUST be
**max-on-the-value-timestamp**, NOT HLC-LWW (which could regress a marker under concurrent
lower-value-later-write). Max is an order-independent, idempotent join ⇒ multi-writer-safe by
construction. This is the `bleases`/`ctime` comparator-register pattern: storage is a `CrdtLWWMap`, but
the SET apply path uses a custom max-merge and the digest is value-aware.

### Engine (TDD-first; clone the bleases comparator-register)
- `st->markers` `CrdtLWWMap` + `CRDT_COLL_MARKERS`. Value = the read-marker timestamp (uint64 ms).
- `crdt_marker_set(st, key, key_len, ts_ms)` — op-recording; local merge = max (keep higher ts_ms).
- apply-dispatch: `CRDT_OP_SET` → `marker_merge` (max(ts); tie → higher HLC/writer for determinism);
  `CRDT_OP_DELETE` is unused (markers don't delete; account GC handles departure — see GC).
- digest (full + materialized, salt 20) — value-aware (hash key + ts_ms), padding-independent.
- snapshot: reuse the LWW-map snapshot section (coll-byte routed; `snap_put_lww`/decoder route by coll —
  NO new snapshot section needed, unlike SILENCE's OR-Set). Confirm the decoder's `lww_for` returns
  `&st->markers` for `CRDT_COLL_MARKERS` so snapshot round-trips. **Verify: does the generic LWW
  snapshot decode call the plain lww_set (wrong — would bypass max-merge) or route through apply?** If
  it bypasses max-merge, a snapshot could regress vs a concurrently-higher local value — mirror how
  bleases handles snapshot decode (special-cased) and do the same for markers.
- GC: a marker for a departed account is orphan-reclaimable. LOW priority (markers are small + re-set);
  can lean on the existing tombstone GC if deletes are ever minted, else a periodic account-existence
  sweep. Note as a follow-up; not required for F2-a correctness.
- cmocka `test_marker_op_replicates`: delta add, **max-wins on concurrent inverted value/HLC**
  (the regression guard — the whole point), multi-writer converge, snapshot roundtrip.

### Shadow (doc ↔ RocksDB, NOT a Client struct — mirrors the GLINE reconcile, not user-materialize)
- **Mirror** (on a local account-anchored MARKREAD set, m_markread.c): `crdt_shadow_marker_set(account,
  target, ts)` → `crdt_marker_set` keyed by the markread storage key (opaque) + `crdt_sync_push`.
  Multi-writer: no single-writer gate (max-merge is safe); but skip when the set came FROM the doc
  reconcile (re-entrancy guard, clone `g_gline_reconciling`) to avoid a write loop.
- **Reconcile** (doc → RocksDB): `crdt_shadow_reconcile_markers()` — foreach `st->markers`, call
  `metadata_readmarker_set(account, target, ts)` (already newer-wins + idempotent). Dispatched from the
  verify cycle + eager delta-apply (like `crdt_shadow_reconcile_glines`). Re-entrancy guarded so the
  RocksDB write doesn't re-mirror. Targeted-per-key would be better at high churn (note as scale
  follow-up); full-walk is fine at testbed scale.
- **No gateway-to-legacy emit needed** — ADDITIVE: the P10 `MR` broadcast still reaches legacy + tree
  neighbours; the doc only adds the overlay-leaf reach. (Same additive stance as SILENCE/F1.)

### Validation (live, 5-node bed)
cmocka green (max-merge regression guard especially). Live: account logs in on nef7(leaf5), MARKREAD
advances a target's marker; reconnect the SAME account on nef4(leaf2, overlay-only) → MARKREAD query
returns the converged (advanced) marker. Concurrent advance from two nodes → both converge to the MAX
(no regression). 0 crashes. (Account-anchored requires a registered account — use the X3/SASL path or a
test account; if the CRDT-only bed lacks services, validate the engine max-merge via cmocka + the
doc-convergence via the digest + a direct readmarker read, noting the services-gated live exercise like
the F1-b MARK precedent.)

---

## F2-b — metadata (MD) over the mesh  [DONE 2026-06-29 — `e7be832`, ptr `893a90e`]

> **RESULT:** built as scoped (plain HLC-LWW, opaque account\0key, permanent-only, single-writer,
> additive). cmocka `test_metadata_op_replicates` (SET/LWW/DELETE/snapshot) [OK] in the 61-test suite.
> LIVE (5-node bed): overlay-only leaf nef6 (cut from the P10 tree, reachable ONLY via the nef3 CRDT
> overlay) converged a permanent metadata SET **purely via the doc** — set on nef3 after the cut, ZERO
> P10 MD received (count=0), doc propagated (nef6 metadata-docsize 6→7), reconcile wrote it to nef6's
> metadata_cf, reconnect-GET on nef6 returned the value. CLEAR converged the same way: doc tombstone →
> nef6 docsize 7→6 → delete store-walk reaped it (GET → "key not set"), other keys untouched. Tree-
> reachable nodes get it via P10 (echo-guard prevents double-write — additive). 0 crash.
> NB the reconcile result log is **L_INFO** (LS_SYSTEM **L_DEBUG is filtered** from the container log —
> that cost real debug time; the marker/F2-a reconcile log at L_DEBUG is invisible too). Account-metadata
> visibility is not stored at the account layer, so a reconnect-GET shows "private" regardless of the set
> visibility — a PRE-EXISTING account-store reload quirk, not F2-b (F2-b converges the value blob, which
> is correct). Deferred (user): network-wide last_present (TTL + not-S2S) wants a MAX-register slice.

## F2-b — metadata (MD) over the mesh  [scope as built 2026-06-29]

> The one-paragraph scope below the original header was thinner than reality. After reading
> `metadata.c`/`m_metadata.c`/`persistence_profile.c` the scope is tightened (decisions locked, grounded):

### Locked scope decisions (recon-driven, 2026-06-29)
1. **Account metadata ONLY** — the persistent `metadata_cf` store, key `account\0key` (build_lmdb_key).
   Channel metadata is in-memory-primary + separately bursted (no account anchor → its own future track);
   non-account client metadata is ephemeral (dies with the connection, never persisted). Neither has the
   overlay-leaf *persistence* gap that motivates Tier C. OUT of scope, documented.
2. **Permanent values ONLY into the doc.** User prefs (`metadata_set_client` → `_set_permanent`, ts=0) +
   profile config (`persistence_profile.c` → `_set_permanent`) are permanent. TTL-bound writes
   (`account_conn.c last_present`, `ms_metadata` remote-value cache) are per-SERVER-derived caches —
   excluded (they'd churn the doc + are not shared truth). The "TTL wrinkle" from the old scope is moot:
   we converge permanent (ts=0) entries, so there is no per-node expiry to replicate.
3. **No visibility in the doc.** The account layer (`metadata_account_set*`) stores NO visibility — it is
   purely an in-memory client/channel concept. Doc value = the raw blob. (Drops "visibility+TTL+blob".)
4. **Plain HLC-LWW, like GLINES.** GLINES use the GENERIC apply path (crdt_state_apply_op `else` branch)
   + generic snapshot encode/decode — NO special-case needed (unlike F2-a markers' max-merge). Engine
   work is therefore minimal: a collection + setters + a digest line + one snapshot encode line.
5. **Single-writer** via a `g_metadata_remote_applying` guard (crdt_shadow.c), set by `ms_metadata`
   around its P10-relayed store writes — the metadata analog of GLINE's `from_crdt_peer(from)`. Only the
   ORIGIN server mirrors a SET into the doc; tree peers that also persist it (online-account case) do NOT
   re-mirror. Keeps LWW single-writer-per-event (multi-writer-over-time on account move is fine: newer
   HLC wins). Without this, every tree peer with the user online would double-write the same key.
6. **Full SET + DELETE convergence, ADDITIVE.** SET enters the doc on permanent set; DELETE (CLEAR /
   key-delete) mints a tombstone — but ONLY if the key is doc-present (no spurious tombstones for
   TTL-cache deletes). Reconcile = GLINE shape: SET-foreach (echo-guarded `_set_permanent`) + DELETE
   store-walk over `metadata_cf` (db_iter) collecting `crdt_metadata_is_explicitly_removed` keys →
   `metadata_account_set(...,NULL)`, collect-then-act. The store-walk handles backfill-on-link (a key
   cleared while a leaf was offline arrives as a snapshot tombstone, caught by the walk). P10 MD broadcast
   is UNTOUCHED → tree+legacy unaffected; the doc only adds overlay-leaf reach.

### Hook chokepoint
Mirror at `metadata_account_set_ts` (metadata.c) — the single point where "an account k/v was persisted"
is unambiguous across local-cmd / S2S / profile-config origins. Call
`crdt_shadow_metadata_set(account, key, value, permanent)` with `permanent = (timestamp==0)`; that fn
holds ALL gates (shadow_on, g_metadata_reconciling, g_metadata_remote_applying, eligibility). Keeps the
metadata.c touch to one call; all CRDT logic lives in crdt_shadow.c (cmocka-clean — metadata.c is not
linked into the engine harness).

### Engine (crdt_state.h/.c, crdt_wire.c) — clone GLINES, key by explicit klen like F2-a markers
- `CRDT_COLL_METADATA` enum (after MARKERS); `struct CrdtLWWMap metadata;` member; init/clear;
  `case CRDT_COLL_METADATA: return &st->metadata;` in lww_for.
- `crdt_metadata_set(st,key,klen,val,vlen)` / `crdt_metadata_del(st,key,klen)` /
  `crdt_metadata_is_explicitly_removed(st,key,klen)` / `crdt_metadata_get(st,key,klen)` — clone
  crdt_gline_set/del but explicit klen (key has an embedded NUL) + variable blob value.
- apply-dispatch: NONE needed (generic `else` LWW path handles SET/DELETE).
- snapshot: `snap_put_lww(&w,&st->metadata,CRDT_COLL_METADATA,&lww_total)` after markers; decode is the
  generic LWW path (lww_for routes it; NO special-case). Version-tolerant (old peer: lww_for→NULL→skip).
- digest: `digest_lww(acc,&st->metadata,21)` (salt 21, free) in BOTH crdt_state_digest +
  crdt_state_digest_materialized (plain LWW → generic digest_lww, not a value-aware one).
- cmocka `test_metadata_op_replicates`: SET delta replicate; LWW newer-HLC-wins; DELETE tombstone +
  is_explicitly_removed; snapshot roundtrip (incl. a deleted entry).

### Shadow (crdt_shadow.c) — clone marker_set + reconcile_glines
- `g_metadata_reconciling`, `g_metadata_remote_applying` statics.
- `crdt_shadow_metadata_set(account,key,value,permanent)` — gates; key=account\0key; permanent set →
  crdt_metadata_set+push; delete (value NULL) → del+push IFF crdt_metadata_get present; TTL set → skip.
- `crdt_shadow_metadata_suspend(int)` — toggles g_metadata_remote_applying (called by ms_metadata).
- `crdt_shadow_reconcile_metadata()` — SET foreach (echo-guard via metadata_account_get compare →
  `metadata_account_set_permanent`) + DELETE store-walk (db_iter metadata_cf, parse account\0key, gate
  on is_explicitly_removed, collect, `metadata_account_set(...,NULL)`). Under g_metadata_reconciling.
  Dispatch after markers at the verify cycle (~crdt_shadow.c:4738) + eager delta-apply (m_crdt.c:684).
- Needs a `metadata_cf` iterator accessor (add `metadata_iter_account_keys`-style helper in metadata.c
  exposing db_iter over metadata_cf, or reuse an existing one — confirm before adding).

### Deferred follow-up: network-wide last_present (2026-06-29, user decision)
`last_present` (account_conn.c) is TTL-bound AND **not S2S today** — purely per-server-local ("last seen
HERE"). It is NOT converged by F2-b (the permanent-only rule excludes it). Converging it = a NEW feature:
network-wide "last seen anywhere", which needs a **MAX-timestamp merge** (the read-marker/`markers`
pattern), NOT plain LWW — LWW (most-recent-WRITER) would be subtly wrong for a monotonic timestamp.
Same category: the oper-sets-metadata-on-offline-account path (m_metadata.c:687, also TTL + not-S2S).
DECISION: ship F2-b (permanent user metadata) now; track last_present as a separate MAX-register slice.
KEY FINDING that made permanent-only sufficient: a user metadata key is stored PERMANENT on the server
where the account is online (the authoritative origin write that's also the S2S-broadcast trigger) and
TTL-CACHED on relay servers (ms_metadata) — so "permanent" exactly tags the origin write, and every
overlay leaf reconciles the doc copy back out as a PERMANENT, GET-queryable store entry. permanent-only
therefore UPGRADES queryability on overlay leaves (authoritative copy, not an expiring cache); it does
not drop it.

### Validation (live, 5-node bed) — same recipe as F2-a
cmocka green. Live: testadmin (SASL account) METADATA SET `*testadmin foo :bar` (or a self key) on nef3 →
mirror fires → doc converges → overlay-only leaf nef7 reconcile drives it into its metadata_cf
(applied>0, no P10 MD received) = gap closed; tree leaf nef4 via P10 (doc idempotent). CLEAR → tombstone
→ leaf store-walk deletes it. 0 crash. NB account-prop reliable on the hub on the partially-recreated bed.

## Constraints (standing)
Submodule push `origin crdt-mesh`; testnet pointer stages ONLY `nefarious-crdt`; trailer
`Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>`; `data/ircd*.conf` uncommitted;
no throwaway tooling committed; use `scripts/dc.sh`; verify the `ircd.YYYYMMDDHHMM` symlink advances;
cache-bust the build to see the cmocka run fresh; commit per phase OK (`feedback_crdt_commit_each_phase`).
