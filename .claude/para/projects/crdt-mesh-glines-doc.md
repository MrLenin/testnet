# CRDT-Mesh — GLINEs as CRDT-native doc state (global-state-into-doc track)

> The persistent-network-state counterpart to the broadcast-tunnel work (MR-2/2b).
> Per the MR-2b decision: ephemeral notifications tunnel over CR; **persistent state
> (GLINE/SHUN/JUPE/ZLINE bans) belongs in the CRDT doc as collections**, exactly as
> Phase 3i did for channel bans (CHAN_BANS OR-Sets). GLINE is the first + highest-value.
>
> **This increment = step 1: the GLINE CRDT engine collection (cmocka-pinned).** The
> live wiring is the explicit follow-on (see Phasing).

## Model

A global G-line is a network ban keyed by its `user@host` (or `*@ip/bits`, or realname/
badchan) mask. Model it as a single LWW-map `glines` keyed by the mask string, value a
fixed-layout `CrdtGlineRecord` — mirroring the `users`/`chanmeta` LWW collections. G-lines
already carry a `lastmod` for P10 conflict resolution; in the doc the LWW is by HLC (the
op timestamp), and `lastmod`/`expire`/`lifetime`/`flags` ride as record fields for faithful
materialization back to a live G-line at cutover.

```c
struct CrdtGlineRecord {
  uint64_t expire;     /* gl_expire   */
  uint64_t lastmod;    /* gl_lastmod (P10 conflict ts, carried for materialize) */
  uint64_t lifetime;   /* gl_lifetime */
  uint32_t flags;      /* gl_flags subset (ACTIVE/IPMASK/BADCHAN/REALNAME/LOCAL...) */
  uint8_t  addr[16];   /* gl_addr (ip-glines) */
  uint8_t  bits; uint8_t pad[3];
  char     reason[CRDT_GLINEREASONLEN];
};
```
Key = the mask (like chanmeta keys by channel name — not stored in the record).

## Engine touchpoints (mirror chanmeta; the "add an LWW collection" checklist)
- **include/crdt_state.h:** `CrdtGlineRecord` struct + `CRDT_GLINEREASONLEN`; `CRDT_COLL_GLINES`
  enum; `struct CrdtLWWMap glines;` in `CrdtNetworkState`; `crdt_gline_set`/`crdt_gline_del` decls.
- **ircd/crdt_state.c:** `crdt_lwwmap_init/clear(&st->glines)`; `lww_for` case
  `CRDT_COLL_GLINES → &st->glines`; **both** digests `digest_lww(acc,&st->glines,9)` (salt 9 free);
  `crdt_gline_set` (op-recording, like `crdt_chanmeta_set`) + `crdt_gline_del` (via the existing
  `mint_meta_delete`).
- **ircd/crdt_wire.c:** one `snap_put_lww(&w,&st->glines,CRDT_COLL_GLINES,&lww_total)` line.
  **GC + snapshot-DEserialize are GENERIC** (`lww_for` over the enum) → no change there.
- **cmocka:** a `crdt_gline` suite — set/get, LWW update (newer ts wins / older loses), delete
  (tombstone), HLC-merge convergence, round-trip record fidelity.

## Phasing (this increment = step 1)
1. **Engine collection (this commit):** the above + cmocka. Inert (no caller yet); cmocka gates
   the image. Correct, self-contained — the foundation.
2. **Shadow-write (DONE 2026-06-15, submodule `d235c28..7b9c6ab`):** `crdt_shadow_gline_add`/`_remove`
   (crdt_shadow.c) hooked at the canonical gline.c points — `gline_add` (SET), `gline_activate` (SET),
   `gline_deactivate` (DELETE if freed / SET if just deactivated), `gline_modify` (SET), `gline_remove`
   (DELETE). Key = ban mask (`gl_user[@gl_host]`, mirroring `gline_propagate`'s wire); record carries
   expire/lastmod/lifetime/flags/addr/bits/reason for cutover-faithful materialize. **Single-writer**
   via `from_crdt_peer(from)` (same gate as channel/user hooks): the mesh ENTRY server (local oper or a
   services/legacy GL relay) writes once; CRDT-aware peers receiving the P10 GL relay skip and get the
   record via CR sync → single-origin, no clock-skew amplification. Local G-lines self-skip; expiry
   leaves the lifetime-bearing record (materializer ignores expired → no doc op). Gated `shadow_on()`
   (FEAT_CRDT_ENABLED), doc-plane only — live G-lines still P10-propagate, **no behavior change**.
   **Validated live (5-node mesh):** global GLINE on nef3 → written once at the entry server → all 5
   converge to a new common mdigest; `/REMOVE` → tombstone → all 5 converge back to the exact pre-gline
   baseline mdigest; a local GLINE left the doc untouched. 0 mismatches, 0 crashes. (No new engine logic
   → no new cmocka; step 1's `test_gline_op_replicates` still gates the image.)
3. **Cutover (DONE 2026-06-16, submodule `7b9c6ab..a153076`):** flag `FEAT_CRDT_GLINE_CUTOVER` (default off).
   Split 3a/3b per the inert→flip discipline.
   - **3a (`..1045381`) reconcile-from-doc + §17.7 gateway:** `crdt_shadow_reconcile_glines()` (verify timer +
     CR delta path). ADD/heal/drift via `gline_add`/`gline_modify` (field echo guard not lastmod → no churn;
     carries `rec->lastmod` → no legacy ping-pong; `do_gline` kicks; expired skipped); REMOVE via the new
     engine gate `crdt_gline_is_explicitly_removed` (doc-tombstone, never absence) + `-mask` gateway. The #1
     hazard (re-mint loop) closed by the `g_gline_reconciling` re-entrancy guard — gline shadow hooks self-skip
     during the pass (the analog of `reconcile_topic_cb` writing `chptr->topic` directly). cmocka extended.
   - **3b (`..a153076`) suppress P10 GL among CRDT peers:** `gline_propagate`/`gline_modify` → legacy-only
     (`sendcmdto_flag_serv_butone` forbid FLAG_CRDT_AWARE; off ⇒ no filter ⇒ byte-identical); `gline_burst`/
     `gline_resend` skip CRDT-aware targets. Makes 3a the transport.

   **Validated live (5-node all-CRDT mesh):** global GLINE on nef3 → all four leaves materialize FROM the doc
   (`gline-reconcile: drove 1`), live on leaf nef7 via `STATS g` with the origin's carried lastmod; `/REMOVE`
   → all four `removed 1`, gone via STATS g; converges; 0 crashes. **The doc is now the transport for global
   G-lines among CRDT peers.** Gateway-to-legacy (non-CRDT/x3 witness) deferred (bed is all-CRDT). NB the
   oper/Opers class has `gline=no` in container base.conf → grant via sed+REHASH+fresh-oper; global GLINE needs
   target `*` (`GLINE +mask * <exp> :reason`).

## Track continuation
Same "global-state-into-doc" pattern next applies to **SHUN / JUPE / ZLINE / SETTIME** (each: engine LWW
collection → shadow-write → cutover reconcile + suppress its P10 token). GLINE is the proven template.

## Validation (this increment)
cmocka green (gates the image; verify the `ircd.YYYYMMDDHHMM` symlink advances). No live behavior
change (inert) — a converged 5-node bringup must still show identical mdigest + 0 crashes (the new
empty collection must not perturb the digest when unused).

## Constraints (standing)
Submodule push `origin crdt-mesh`; testnet pointer + this doc only; trailer `Co-Authored-By:
Claude Opus 4.8 (1M context) <noreply@anthropic.com>`; author MrLenin; `data/ircd*.conf`
uncommitted; throwaway harness not committed; `scripts/dc.sh`; update roadmap + memory on landing;
**commit per phase**. NB5: a state cut to CRDT MUST use an op-recording setter (done here) or it
only replicates via snapshot, never delta.
