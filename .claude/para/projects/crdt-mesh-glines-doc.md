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
2. **Shadow-write (next):** hook the canonical gline state-change points in `gline.c`
   (`gline_add`/`gline_modify`/`gline_remove`/expire) to `crdt_gline_set`/`_del` — the doc now
   tracks live G-lines; observe it **converges across the mesh** (digest) with no behavior change.
3. **Cutover (later):** reconcile live G-lines *from* the doc (+ gateway to legacy), suppress the
   P10 `GL` token among CRDT peers (flag-gated), like the Phase-3 reconciles.

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
