# CRDT-mesh branch review — fix backlog (2026-07-21)

Whole-branch defensive review of `nefarious-crdt` @ `f33b86b` (branch `crdt-mesh`),
diff base `da8845c`. Method: 14 parallel subagent units partitioned by system, each
grounding findings at `file:line`; every CRITICAL and MAJOR re-verified against source
by hand. Read-only — nothing was reproduced on a live bed, so reachability notes are
reasoned from code unless stated otherwise.

**Severity context:** `FEAT_CRDT_PRIMARY` and all four `FEAT_CRDT_*_CUTOVER` flags
default **0** (experimental / opt-in). That bounds the live blast radius today — but
these are exactly the flags the promotion-to-prod gate turns on
(`project_crdt_bouncer_gateway_legacy`), so this backlog is pre-promotion work.

## Bottom line

The engine's convergence logic is fundamentally sound: the hard invariants that
historically bit this codebase (single-writer gate, dead-tombstone reconciles, ctime
min-register, `%C` stub-crash, delete-tombstone reclaim) are holding. The defects
cluster in two places — **memory-safety at the wire trust boundary** (5 crashes) and
**two systemic design gaps** that each recur across many subsystems. This is a finite,
patternable fix list, not architectural rot.

---

## Theme A — reclaim discipline was never generalized

The rule *"reclaim a live doc entry by minting a DELETE gated on causal stability,
never local-free and never leave-live"* is correctly implemented for per-member
metadata (`crdt_state_reclaim_orphan_member_meta`) but was never extended to five other
collections. Each is the same-shape unbounded-growth / resurrection leak:

| # | Collection | Site | Effect |
|---|---|---|---|
| M6  | `CrdtChannel` + 3 OR-sets | `crdt_state_gc` walks `chan_buckets` read-only (crdt_state.c:2013) | ~3 KB/channel forever; only whole-doc `crdt_state_clear` frees |
| M10 | channel topic/modes/chanmeta LWW | `crdt_shadow_channel_destroy` only `crdt_chan_ctime_clear` (crdt_shadow.c:582) | grows + bloats every CR F snapshot |
| M9  | per-user silence masks | `crdt_shadow_user_remove` never touches `silences` (crdt_shadow.c:631) | growth **+ numeric-reuse bleed** (see below) |
| M8  | account metadata on CLEAR | raw `db_writebatch_del`, no doc tombstone (metadata.c:791) | **active resurrection** ~30s later via SET-heal |
| M13 | gline/shun/zline/jupe on expiry | wall-clock expiry local-frees (gline.c:95, jupe.c:312) | ban doc + snapshot grow forever |

M9's bleed: a reused P10 numeric inherits a departed user's silence masks via
`crdt_shadow_sync_user_silences` (crdt_shadow.c:2033, applied at materialize :3640 and
reconcile :4011), so the new user's senders are silently dropped by source-side
`is_silenced` with no way for them to see or clear it.

M8's resurrection: `metadata_account_clear` (metadata.c:755, reached from `METADATA
CLEAR` m_metadata.c:895 and `ACCOUNT … U` m_account.c:186) raw-deletes the store but the
doc still holds the key, so `reconcile_metadata_set_cb` (crdt_shadow.c:2270 — every verify
cycle + every delta-apply) re-writes the cleared value; no peer ever learns of the clear.

**Fix as a pattern:** one shared reclaim-sweep helper mirroring
`crdt_state_reclaim_orphan_member_meta` — mint `crdt_*_del` gated on *fully-gone +
causally-stable* (idempotent, multi-writer-benign, GC-reclaimable). Keep the
`CrdtChannel` struct + ctime incarnation alive for the resurrection guard; reap only the
meta.

## Theme B — HLC / wall-clock interface fragility

The mesh is HLC-internal but repeatedly interfaces raw wall-clock, and every such seam
breaks or diverges under NTP correction / VM-resume clock movement:

- **M2** beacon liveness keyed on unvalidated remote `emit_ts`: the accept gate
  (`emit_ts > stored`, crdt_shadow.c:129) early-returns *before* the `recv_ts =
  CurrentTime` update at :132, so one future-dated beacon — or a peer's backward NTP
  step — freezes `recv_ts`, the staleness sweep (`CurrentTime - recv_ts > STALE`) then
  retires a **live** server (stub torn down, mesh-only users unreachable).
- **U6 clock note** a forward clock step >90 s reaps *all* overlays and *all* stubs at
  once (`crdt_overlay_is_stale` :255 + sweep :4959 both compare CurrentTime to
  CurrentTime-stamped ts). Self-heals but flaps.
- **M11** mesh topic is pure HLC-LWW (`crdt_topic_set` crdt_state.c:563); the gateway
  re-emits with `chptr->topic_time` (crdt_shadow.c:4260) and legacy applies
  `if (topic_time > ts) reject` (m_topic.c:405). Under skew a causally-later mesh topic
  can carry an *earlier* topic_time → legacy island rejects and keeps its own →
  permanent split until a newer topic supersedes both.
- **m15** member_status is never cleared on part (crdt_shadow.c:536); the "rejoin stamps
  status=0 at a newer HLC" guard inverts under skew + sync-lag → stale `+o` wins LWW →
  `reconcile_member_status` re-ops a plain rejoiner.
- **M12** same-second ban `lastmod` collision (see Bans below).

**Fix as a theme:** monotonic clocks for liveness (or N-consecutive-stale ticks before
retirement); fold legacy TS (`topic_time`, `lastmod`) into the merge ordering with HLC as
tiebreak, rather than bolting it on at the gateway; delete-on-leave for member_status.

---

## CRITICAL — crashes / corruption on malformed or mismatched peer input

All five are reachable from a linked or overlay peer sending unexpected bytes.
Memory-safety must not depend on peer correctness. **All verified against source.**

### C1 — decoded `origin`/`tag.origin` index the state vector with no bounds check
`crdt_op_decode` reads `op->origin` and `op->tag.origin` as raw `uint16` (0–65535)
(crdt_wire.c:141,149). They flow unchecked into `seq[CRDT_MAX_SERVERS]` (=4096): an OOB
read at `crdt_sv_has_seen` and a conditional OOB **write** at `crdt_sv_update`
(crdt_state.c:1504,1557; inline bodies crdt_types.h:256,262), plus the OR-Set GC
(`stable->seq[t.origin]`, crdt_types.c:267,299) and `crdt_delta_encode`
(`remote->seq[op->origin]`, crdt_wire.c:175). Flagged independently by three units.
**Fix:** the sibling `crdt_sv_decode` already clamps `o < CRDT_MAX_SERVERS`
(crdt_wire.c:98) — apply the same guard in `crdt_op_decode` and `snap_get_orset`, or at
the top of `crdt_state_apply_op`.

### C2 — unknown collection byte → NULL-map dereference
`op->coll` is a raw `uint8` (crdt_wire.c:144). Any value outside the switch makes
`lww_for` return NULL (crdt_state.c:1492); `crdt_lwwmap_set(NULL,…)` then derefs
`map->nbuckets` in `lww_find` (crdt_types.c:369). Also a forward-compat hazard — an op
from a newer peer carrying a collection this build doesn't know crashes it. **Fix:** the
snapshot path already guards `if (map)` (crdt_wire.c:432); add the same to the
`apply_op` else-branch.

### C3 — chunk-reassembly table never released on peer disconnect
`s2s_chunk_cleanup_link` (s2s_chunk.c:96) has **zero production callers** — only the test
suite. A peer that SQUITs mid-stream leaks its slot forever; 64 leaked slots → all CR
delta/snapshot reassembly fails network-wide with no operator error; and a reused
`Client*` address matches `chunk_find` and appends a new peer's chunks onto the dead
buffer → corrupt blob into decode. **The chathistory federation reassembly *does* wire
its cleanup (chathistory_fed_cleanup_link ← s_misc.c:329)** — the pattern is known, it was
just missed here. **Fix:** call `s2s_chunk_cleanup_link(cptr)` from the CRDT-peer/overlay
exit path.

### C4 — receive-side reassembly unbounded + unchecked allocation
`s2s_chunk_feed` grows `alloc = (len + add + 1) * 2` with no ceiling (s2s_chunk.c:72-75)
and never checks `malloc` (:46) or `realloc` (:74) — a NULL return is followed
immediately by `memcpy(e->buf + e->len, …)` (:76). The send side caps at `CR_SNAP_MAX`
but the receiver trusts the peer to send the terminator. **Fix:** cap the reassembled
length at ~`CR_SNAP_MAX` (abort + free the slot on exceed); check every allocation.

### C5 — server-sourced KILL over the mesh → `NumNick(from)` NULL-deref
`do_kill` passes its source `sptr` into `crdt_route_unicast_try(sptr, 'K', victim, …)`
(m_kill.c:150), which guards only the *victim* (crdt_wire.c… m_crdt.c:355), not `from`.
`sptr` can be a **server** (nick-collision kills, services kills forwarded via `ms_kill`;
`do_kill` itself branches `IsServer(sptr)` at :124). The emit runs `NumNick(from)`
(m_crdt.c:267,274 and the next-hop path :387), which expands to
`cli_yxx((cli_user(c))->server)` (numnicks.h:54) → derefs `cli_user(server)` = NULL →
remote crash. Reachable during a partition (an anchor exists — the normal Tier-2 state)
on a server-sourced collision kill for a user homed on the anchored server — exactly the
split/heal window where collisions happen. **Fix:** handle `IsServer(from)` in
`crdt_route_unicast_try` / `crdt_gossip_message` (emit a server-form source prefix; the
CR M 'K' receiver's `findNUser` fallback at m_crdt.c:835 already copes with an unresolved
source).

> **Invariant 2 is NOT fully contained.** C5 is an invariant-2 crash the `%C`-focused
> sweeps missed because it is on the *send* path (`NumNick(from)`), not the formatter.
> A second untraced suspect: jupe reconcile → `do_jupe` → `exit_client_msg` on a name
> that `FindServer` might resolve to a `STAT_MESH_SERVER` (crdt_shadow.c:2849 → jupe.c:91).
> **Action:** targeted c-auditor re-sweep of `NumNick(from)` / server-or-stub-as-source
> across *all* new CR emit sites.

---

## MAJOR — realistic correctness bugs (beyond the two themes)

- **M1 (engine)** `crdt_orset_remove` increments its count unconditionally but writes
  `out_tags` only while `n < max_out`, then returns the full `n` (crdt_types.c:248,250).
  Callers use a 64-slot stack array (`crdt_chan_remove` crdt_state.c:290, and the
  ban/silence siblings) and read `removed[i]` for `i < n` → stack over-read that mints
  REMOVE ops with garbage `tag.origin`/`seq`, feeding C1. The ban-remove path is the
  realistic trigger (each `+b` re-add mints a fresh tag, no same-mask dedup). **Fix:**
  clamp the counter to `max_out` in the primitive.
- **M4 (anti-entropy)** a document over `CR_SNAP_MAX` (~256 KB) fails to encode and
  `send_crdt_snapshot` silently sends nothing (crdt_wire.c:284, m_crdt.c:103). A peer
  below `gc_floor` can't be served a delta either → permanently divergent, no error.
  **Fix:** detect encode overflow; raise the cap or log+alarm.
- **M5 (channels)** legacy BURST `+b/+e` are never mirrored into the doc — m_burst.c
  calls only `crdt_shadow_topic` (:390); bans are linked directly into `chptr->banlist`
  (:472-483) with no ModeBuf → no `crdt_shadow_lists`. Pure-CRDT leaves materialize the
  channel with no bans until a later interactive `+b/-b` heals it. **Fix:** mirror the
  finalized lists into the doc after the BURST ban block, or record as a deliberate
  deferral.
- **M7 (delivery)** a multiline DM to a mesh-only user loses every line after the first:
  the mesh-stub branch reuses one `batch_base_msgid` for every line (m_batch.c:1432), so
  the receiver's 90 s msgid dedup drops lines 2..N. The sibling *channel* path mints a
  fresh `generate_msgid` per line (m_batch.c:1664) — do the same here. Manifests when
  `FEAT_MSGID` is on.
- **M14 (bouncer)** the alias reap treats "no bconn in the doc" as "tombstoned":
  `crdt_shadow_bconn_present` returns `crdt_bconn_get(…) != NULL`, which is NULL for a
  tombstone *and* for a never-written key (crdt_shadow.c:685). A bconn is only written by
  a CRDT node, so an alias hosted on a **legacy** server never has one — the reap
  (bouncer_session.c:2347) then de-materializes a live alias every cycle and emits `BX X`
  to the legacy server. The sibling *session* reap is safe because it gates on
  `hs_client == NULL` first (:2291); the alias reap has no spare. **Fix:** resolve the
  alias host (`FindNServer(ba_server)`) and require `IsCrdtAware(srv) || IsMeshStub(srv)`
  before treating an absent bconn as reap-eligible; skip legacy-hosted aliases (their
  teardown rides legacy `BX X`).

## MAJOR — test coverage (the gate is sound but blind to the above)

The cmocka gate itself is **fixed** (see Sound) — but the three engine CRITICALs live in
an entirely untested surface:

- No malformed / truncated / out-of-range **decode** test at all (`crdt_op_decode` is
  never called directly). A single decode-hardening suite (origin/tag.origin ≥ 4096,
  out-of-range coll, truncated op/delta, `crdt_orset_remove` into an undersized buffer)
  would have caught C1, C2, and M1.
- No standalone **HLC** primitive test; invariant-4 HLC padding-independence of the
  digest is untested.
- No **permuted-order** merge commutativity/idempotence test (convergence tests use a
  fixed two-direction exchange).
- Meshmap: no insertion-order-permutation **determinism** test (rows always ascending),
  no **divergent-map** test.

## Selected MINOR / NOTE worth tracking

- **m12** a non-propagating local oper (`!PRIV_PROPAGATE`) leaks `+o` across the mesh:
  the legacy send withholds `o` but `crdt_shadow_user_add` mirrors the full umode into the
  doc, and `FORCE_OPER_PROP` re-gateways it onward (m_oper.c:238, crdt_shadow.c:622,3905)
  → oper network-wide, counted in remote `UserStats.opers`/WHOIS. Inverts the
  `PRIV_PROPAGATE` contract; gate the doc `o`-mirror on it, or document "mesh is one
  network".
- **m16** overlay-announced numeric isn't bounded to `CRDT_MAX_SERVERS` (mr_crdtmesh
  accepts ≤3 base64 chars, m_server.c:722). No OOB (downstream indexers all guard) but a
  >4095/wrapping numeric shares a CR-plane SV/beacon/meshmap slot with a real server →
  mis-anchor / liveness misjudgement. Reject numerics outside `[0, CRDT_MAX_SERVERS)`.
- **m17 / m18** no cross-guard between the SERVER and CRDTMESH state machines, and the
  overlay path skips the jupe + CRULE checks `mr_server` enforces. Self-healing /
  policy-consistency, but the "overlay is never IsServer" invariant is unenforced at the
  handler boundary.
- **m13 / m14 (topic/kick)** topic echo-guard compares text only (RPL_TOPICWHOTIME can
  diverge); a kick-raced-rejoin under skew can render a later plain PART as a stale KICK.
- **skip_crdt_servers_once fragility** (send.c:142) — an unscoped global one-shot; every
  current set-site is safe (set immediately before a consuming send) but a future
  set-then-early-return would leak the suppression into the next broadcast → silent
  doc-vs-legacy divergence. Flagged by two units. Consider `assert(== 0)` at
  `bounce_broadcast` entry or scoping the flag to the send.
- **m19** `UserStats.clients` can over-count by 1 on a convert-then-cross-node-promote
  (bouncer_session.c:7527 unconditional `++` vs a convert-in-place alias that kept its
  N-intro credit). Safe drift direction (inflated `/LUSERS`, no assert crash).
- **NOTE (bans)** doc→live ban enforcement is gated on `FEAT_CRDT_PRIMARY`, so a
  non-primary CRDT member won't disconnect matching users for a converged ban
  (deployment-dependent). Jupe "removal" is deactivation (re-SET inactive), never a
  tombstone, so its remove-pass is dead and inactive jupes accumulate (folds into M13).

## Verified sound — negative space (do not re-investigate)

- **cmocka gate is FIXED.** The 2026-06-18 tee-pipe no-op is repaired:
  `test-cmocka` captures `rc=$?` before `cat` (Makefile.in:193) and `exit 1`s on any
  failure; the Dockerfile `&&`-chains it so a failing suite fails the image (:88); both
  `crdt_cmocka` and `crdt_meshmap_cmocka` are in `CMOCKA_TESTPROGS`; a SIGSEGV in a test
  returns non-zero. Resolves the old `project_cmocka_gate_broken` concern.
- **Invariants hold:** 1 (single-writer gate includes `IsMeshStub` on every mutating
  hook), 3 (op-recording setters everywhere on live paths; only the dead test-only
  `crdt_nick_force_rename` uses raw primitives), 4 (HLC hashed field-by-field; digests
  XOR-fold order-independently), 5 (delete-tombstone reclaim mints DELETEs, gated on
  fully-gone), 6/Fix-A (equal-SV/different-digest → CR F, tested both sides), 7 (ctime
  min-register + ts=0 zombie guard), 11 (every doc-removal reconcile live-walks +
  present-checks; the M6c-1 dead-tombstone-branch trap is fixed and documented).
- **Invariant 2 contained *except* the send-path holes in C5 / the jupe suspect:** the
  `%C` formatter fix is correct and load-bearing; `m_links`/`m_map`/`make_zombie`/`m_nick`
  are safe with a stub; the dead-sink discipline (`can_send`: `IsDead || IsMe || fd<0`
  after `to = cli_from(to)`) is universal.
- **Overlay auth is at full parity with SERVER:** Connect-block match on name *and*
  source IP, `CONF_CRDTMESH` required, SSL fingerprint verified, password checked; an
  overlay never becomes `IsServer`/`SetServerYXX`/`add_dlink`.
- **Routing:** unicast path selection is mutually exclusive (no origin double-send); the
  Kruskal spanning tree is deterministic across nodes; channel delivery is exactly-once in
  the normal contiguous-CRDT topology.
- **UserStats** rework is flag-keyed (`FLAG_COUNTED_OPER/INV`) with a `free_client`
  backstop — closes the `.2 UserStats.opers>0` underflow class.
- **Per-attribute pipelines** (AWAY / SETNAME / SVSINFO / SVSIDENT / SWHOIS / MARK /
  SETHOST / read-marker / metadata-except-clear) are correct; the embedded-NUL
  `account\0key` metadata key is NUL-safe end to end; `marker_merge` is a true
  MAX-register that never regresses.
- **Bouncer:** `s_bsd` `bounce_promote_alias(local_only=1)` cannot promote a remote alias
  (winner loop skips non-local homes → returns -1 → hold+defer, the BX-X-race-safe path).

## Recommended fix order

1. **The 5 CRITICALs** — small and localized; C1/C2 have an in-tree guard to copy. Add
   the malformed-wire cmocka suite alongside (it catches three of them).
2. **The invariant-2 re-sweep** — `NumNick(from)` / server-or-stub source on every new CR
   emit path, plus the jupe → `do_jupe` suspect.
3. **Theme A** as one shared reclaim helper; **Theme B** as monotonic-clock liveness +
   legacy-TS-in-merge-order + delete-on-leave for member_status.
4. **Remaining per-system MAJORs** — M7 per-line msgid, M5 burst-ban mirror, M14
   alias-reap host check, M12 ban `lastmod` force, M4 snapshot-overflow alarm.

## Coverage / what wasn't reached

- Static, read-only throughout — no build, no live bed, no test execution. Skew- and
  amplification-contingent findings (M2, M11, M12, the `"*"`-msgid flood) are reasoned
  from control flow, not measured.
- `make_ban` / `pretty_extmask` cross-server canonical-parity for `+b/+e` masks was not
  traced (a mismatch would cause dup masks / reconcile flip-flop).
- The `FindServer`-returns-stub → `do_jupe`/`exit_client_msg` crash class (invariant-2
  jupe suspect) was flagged but not confirmed.
- Multi-gateway BS/BX fan-out is explicitly out of scope (MR-4 is single-gateway).
- 32-bit `size_t` overflow paths in the codec are latent on the 64-bit testbed only.
