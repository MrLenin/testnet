# Metadata P2 — Channel Tier Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Phase P2 of `.claude/para/projects/metadata-era2-completion.md` §B — +R (registered) channel metadata becomes persistent and doc-converged: persistence at the set-chokepoint (B1), channel keys in the CRDT doc (B2), ±R transition hooks (B3), reconcile materialization into live channel memory (B4), removal of the era-1 remote TTL channel cache (B5), burst untouched (B6). Plus one listed spec deferral: the GET existence-leak 766 fix.

**Architecture:** Channel rows reuse the ENTIRE account-tier machinery with the channel name in the account slot: store key `#chan\0key` (exactly the era-1 cache's key shape), A2 visibility encoding, `metadata_account_set_permanent` as the write path, the generic opaque-key LWW doc collection (`CRDT_COLL_METADATA`), and `metadata_apply_converged` grown with a channel branch. The single new mechanism is the ±R transition hook pair. Order: doc-key + engine lock → set-chokepoint → materialization → ±R hooks → cache removal → live scenarios, because every later task writes or reads through the earlier ones.

**Tech Stack:** C (ircu/Nefarious), RocksDB store layer, CRDT shadow (crdt_shadow.c), cmocka in-build gate, 5-node Docker CRDT bed + tests/clocktest python drivers.

## Global Constraints

- Tree: `/home/ibutsu/testnet/nefarious-crdt`, branch `crdt-mesh`, base `530a7c6`. Do NOT touch `/home/ibutsu/testnet/nefarious`. All file:line anchors below verified at `530a7c6`.
- **A2 row encoding is settled law (P1)** — exactly ONE encoder (`metadata_account_set_ts`, metadata.c:444) and the decoders `metadata_account_get_vis`/`_list`. Channel rows written via `metadata_account_set_permanent` are non-exempt permanent rows: ALWAYS `P:`/`*:` prefixed. No caller ever pre-prefixes or self-parses. Era-1 TTL cache rows (bare or `P:`-prefixed TTL-class) decode under the existing class rules and age out via the purge sweep — no migration.
- **Doc-mirror discipline (verified at base):** `metadata_account_set_ts` mirrors through `crdt_shadow_metadata_set(account, key, stored_value, timestamp == 0)` (metadata.c:527), and the mirror itself self-gates: `!permanent` sets return without minting; deletes mint only if doc-present; `g_metadata_reconciling`/`g_metadata_remote_applying` self-skip (crdt_shadow.c:2257-2279). NOTHING in this plan may add a second doc-mirror site — all doc traffic flows through the set_ts chokepoint or `crdt_shadow_metadata_remove_key`.
- **Single-writer split (B1/B3 rule):** the store write runs on EVERY node (each materializes its own store); the doc mint runs ONLY at the entry node. Relayed `ms_metadata` applies are already bracketed by `crdt_shadow_metadata_suspend(1)`/`(0)` (m_metadata.c:1399/:1435) — B1 inherits that split for free. For B3's mode hook the entry-node predicate is: **mint when the ±R arrived from a local client or a non-CRDT (legacy/gateway-edge) link; suspend when it arrived from a CRDT-aware server link** — concretely `MyUser(cptr) || !(IsServer(cptr) && IsCrdtAware(cptr))` at the hook site. Do NOT use `MyConnect(sptr)`: on this bed X3 links to legacy `testnet`, so the services server is never MyConnect on any CRDT node and the mint would never fire anywhere; the hub's legacy tree link IS the mesh entry (the §17.7 gateway pattern).
- **Reads never write (A3, channel edition):** GET-path promotions and reconcile applies go through the new channel MEMORY primitives (Task 2) — never `metadata_set_channel`, which after B1 persists and (at the origin) doc-mints for +R channels.
- **Signature contract (Task 2 produces, later tasks consume):**
  - `struct MetadataEntry *metadata_channel_memory_put(struct Channel *chptr, const char *key, const char *value, int visibility)` and `void metadata_channel_memory_del(struct Channel *chptr, const char *key)` — pure `chptr->metadata` list ops + subscriber notify hook parity with `metadata_memory_put`/`_del` (metadata.c:1163/:1198); no store, no doc, no flag-sync.
  - `metadata_set_channel(chptr, key, value, visibility)` (metadata.c:1747) KEEPS its signature; gains the B1 store/doc leg iff `chptr->mode.mode & MODE_REGISTERED`.
  - `metadata_apply_converged` (metadata.c:1269) keeps its signature; Task 3 adds the `IsChannelName(account)` branch ahead of the user walk.
- **`metadata_apply_converged` stays memory+notify only** (P1 binding rule): no store write, no doc write, no mode-flag sync — the channel branch inherits this verbatim.
- Host build: `LIBRARY_PATH=$HOME/.local/lib make -C ircd ircd CPPFLAGS="-I. -I.. -I../include -I$HOME/.local/include"` → fresh `ircd/ircd`, zero new warnings. cmocka: `make -C ircd/test crdt_cmocka && ./ircd/test/crdt_cmocka` → all PASSED (86 at base; Task 1 adds rows to an existing test). Docker (`scripts/dc.sh -l --profile multi build nefarious3 nefarious4 nefarious5 nefarious6 nefarious7`) is the canonical gate; freshness = the `ircd.YYYYMMDDHHMM` symlink advances. Bed restarts in waves of ≤2 containers (overlay autoconnect is on a 10-min cycle).
- Integration behavior (channel hooks, reconcile, ±R) is verified LIVE via Task 6 scenarios — no cmocka suite links metadata.o (pre-existing; documented per `feedback_no_silent_defer`).
- Commit messages end with: `Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>`. One commit per task, subjects prefixed `P2:`.

## Non-goals (explicit)

- TTL-machinery retirement (purge sweep, `CACHE_TTL`) — survey belongs to P3; legacy rows still age out through it during P2.
- The `+ir` umode-mirror reorder (`set_user_mode` loop/post-loop split) — standalone fast-follow, user tier, not channel work.
- Private-notify `*` token + CLEAR legacy-broadcast vis token — cosmetic/doc items, P3.
- `last_present` / network presence; multi-identity; SYNC semantics (spec non-goals).

---

### Task 1: Engine lock + B2 — channel keys enter the doc

**Files:**
- Modify: `ircd/test/crdt_cmocka.c` (`test_metadata_op_replicates` :696)
- Modify: `ircd/crdt_shadow.c` (`metadata_doc_key` :2233, the `IsChannelName` exclusion :2240-2241 + the function's comment)

**Interfaces:**
- Consumes: the generic opaque-key LWW path (no engine change).
- Produces: doc acceptance of `#chan\0key` storage keys — Task 2's mirror calls start converging the moment B1 writes exist.

- [ ] **Step 1 (test first):** Extend `test_metadata_op_replicates` with channel-shaped opaque keys: SET `#p2chan\0topic-lang` → replicate → LWW overwrite from the second node → DELETE → snapshot (CR F) roundtrip, asserting convergence and tombstone behavior identical to the account-shaped keys already in the test. This is a regression LOCK (the engine is key-agnostic, so it passes immediately); the behavioral RED for B2 is live (Task 6 scenario 1) — the doc-key exclusion lives in the integration layer, which no cmocka suite links.
- [ ] **Step 2:** Run `make -C ircd/test crdt_cmocka && ./ircd/test/crdt_cmocka` → PASSED (new assertions green).
- [ ] **Step 3:** In `metadata_doc_key` drop the `IsChannelName(account)` early-return (:2240-2241) and update the function comment: channel keys converge as opaque `#chan\0key` per §B2; TTL-class channel writes remain excluded by the mirror's `!permanent` gate (metadata.c:527 → crdt_shadow.c:2268), NOT by key shape. Old peers' reconciles write the store row and never materialize memory — version-tolerant by construction.
- [ ] **Step 4:** Host build + cmocka green; zero new warnings.
- [ ] **Step 5:** Commit: `P2: channel metadata keys enter the CRDT doc (opaque #chan\0key; TTL writes still mirror-gated)` (+ trailer).

### Task 2: B1 — persistence at the set-chokepoint + channel memory primitives

**Files:**
- Modify: `ircd/metadata.c` (`metadata_set_channel` :1747; add `metadata_channel_memory_put`/`_del` next to the client memory primitives :1163/:1198)
- Modify: `include/metadata.h` (decls beside `metadata_memory_put` :201)
- Modify: `ircd/m_metadata.c` (GET channel-fallback promotion — the `metadata_set_channel` call at :564 and its "memory-only" comment :560 — switch to `metadata_channel_memory_put`)

**Interfaces:**
- Consumes: `metadata_account_set_permanent(account, key, value, visibility)` (P1 contract; visibility ignored on delete), `MODE_REGISTERED`.
- Produces: the channel memory primitives (signature in Global Constraints); `metadata_set_channel` = THE persist chokepoint for +R.

- [ ] **Step 1:** Add `metadata_channel_memory_put`/`metadata_channel_memory_del`: mirror the client versions' list handling (find-or-create in `chptr->metadata`, update value+visibility, free on del) including the subscriber-notify call the SET path performs today — factor from the existing `metadata_set_channel` body so the memory half lives in exactly one place (`metadata_set_channel` calls the memory primitive, then does its new persist leg).
- [ ] **Step 2:** In `metadata_set_channel`, after the memory half: iff `chptr->mode.mode & MODE_REGISTERED`, persist — `value != NULL` → `metadata_account_set_permanent(chptr->chname, key, value, visibility)`; `value == NULL` → `metadata_account_set_permanent(chptr->chname, key, NULL, visibility)`. Not +R → memory only (unchanged). Comment: runs on relayed applies too — every node persists its own store; only the origin mints doc ops (the m_metadata.c:1399 suspend bracket provides the split; state it, don't re-implement it).
- [ ] **Step 3:** Switch the GET-fallback promotion (m_metadata.c:564) to `metadata_channel_memory_put` and fix the :560 comment (reads never write — Global Constraints). Verify the relayed-apply site (:1403) and SET command site (:850) still call `metadata_set_channel` (they're the write paths, correct).
- [ ] **Step 4:** Verify sweep: `grep -n "metadata_set_channel" ircd/m_metadata.c ircd/metadata.c ircd/channel.c` → only :850 (SET cmd), :1403 (relayed apply, suspended), the CLEAR path (:986 region — value NULL, now also store-deleting for +R, which is B5's CLEAR-residue resolution), and metadata.c internals. Host build + cmocka green.
- [ ] **Step 5:** Commit: `P2: +R channel metadata persists at the set-chokepoint (store #chan\0key via A2; doc minted at origin only); channel memory primitives split out` (+ trailer).

### Task 3: B4 — reconcile materializes channel metadata into live memory

**Files:**
- Modify: `ircd/metadata.c` (`metadata_apply_converged` :1269 — channel branch; update the header comment :1239 and metadata.h :219-236)

**Interfaces:**
- Consumes: `metadata_channel_memory_put`/`_del` (Task 2), `FindChannel`.
- Produces: doc→live channel materialization; the reconcile's existing callers (crdt_shadow.c `reconcile_metadata_set_cb` :2311 SET/change path and the delete store-walk) need NO changes — they already pass the account slot through, which now carries `#chan` names post-B2.

- [ ] **Step 1:** At the top of `metadata_apply_converged`, branch on `IsChannelName(account)`: `FindChannel(account)` present → `metadata_channel_memory_put`/`_del` (which carry the subscriber notifies); channel absent → return (store-only is correct: memory materializes on +R per B3 or lazily via the read-only GET fallback). The existing user walk stays untouched below the branch. Memory+notify ONLY — no store, no doc, no mode-flag sync (binding rule).
- [ ] **Step 2:** Confirm by reading (note in the report, no code change expected): `reconcile_metadata_set_cb`'s echo-guard compares via `metadata_account_get_vis(account, ...)` — with a `#chan` account slot this reads the same `#chan\0key` store row B1 writes, so the guard's semantics hold for channels unchanged. The reconcile delete store-walk reaps `#chan\0key` rows generically (opaque keys); its `metadata_apply_converged(account, key, NULL, vis)` call now clears channel MEMORY via Step 1.
- [ ] **Step 3:** Host build + cmocka green.
- [ ] **Step 4:** Commit: `P2: doc reconcile materializes channel metadata into live chptr->metadata + fires subscriber notifies (memory+notify only)` (+ trailer).

### Task 4: B3 — ±R transition hooks

**Files:**
- Modify: `ircd/channel.c` (the mode-apply site where `MODE_REGISTERED` lands: `state->chptr->mode.mode |= flag_p[0]` :3581 / `&= ~flag_p[0]` :3584 — hook AFTER the flag flip, filtered to `flag_p[0] == MODE_REGISTERED`, likely as a small static helper called from both arms)
- Modify: `ircd/metadata.c` (`metadata_channel_load` :910 — currently `return metadata_account_list(channel);` with the "revived by §B3" comment — rework per Step 2)
- Modify: `include/metadata.h` (channel_load decl/comment)

**Interfaces:**
- Consumes: `metadata_account_set_permanent`, `metadata_account_clear` (:784), `metadata_account_list`, `metadata_channel_memory_put` (Task 2), `crdt_shadow_metadata_suspend` (crdt_shadow.h:412), the entry-node predicate (Global Constraints).
- Produces: +R persist-then-load; -R store wipe + per-key doc tombstones.

- [ ] **Step 1:** Write the hook helper with the single-writer gate: `int entry = MyUser(cptr) || !(IsServer(cptr) && IsCrdtAware(cptr));` — when NOT entry, bracket ALL of the hook's store work in `crdt_shadow_metadata_suspend(1)/(0)` (matching the m_metadata.c:1397-1435 pattern, resume unconditionally). The hook fires on every node applying ±R (mode_parse runs everywhere); the gate is what keeps the doc single-writer. Multi-mint would be LWW-benign but is a discipline violation (spec §B3).
- [ ] **Step 2 (+R):** persist-memory-first: walk `chptr->metadata`, `metadata_account_set_permanent(chptr->chname, entry->key, entry->value, entry->visibility)` for each. Then the load half: rework `metadata_channel_load(chptr)` to take the `struct Channel *` and, via `metadata_account_list(chptr->chname)`, insert store rows NOT already in `chptr->metadata` using `metadata_channel_memory_put` (decoded values + visibility from the list entries; free the list per its contract). At burst time memory is empty, so only the load half does work — this is the restart-hydration path (spec text; put it in the comment).
- [ ] **Step 3 (-R):** every node wipes its own store rows: `metadata_account_clear(chptr->chname)` (bulk store delete + per-key doc tombstones via `crdt_shadow_metadata_remove_key`; under suspend the tombstone mint self-skips, so non-entry nodes wipe store-only — exactly the split). Memory stays (the channel still exists, now ephemeral) — do NOT touch `chptr->metadata`.
- [ ] **Step 4:** Confirm the ±R pre-check at channel.c:4794 (servers-only for ±R without FORCE) means the hook only ever runs for server/services/OPMODE origins; note in the report.
- [ ] **Step 5:** Host build + cmocka green.
- [ ] **Step 6:** Commit: `P2: ±R transition hooks — +R persists memory + hydrates from store; -R wipes store with doc tombstones at the entry node only` (+ trailer).

### Task 5: B5 — retire the remote TTL channel cache; read-only fallback; existence-leak fix; B6 check

**Files:**
- Modify: `ircd/m_metadata.c` (the ms_metadata channel store-cache write block inside the relayed-apply path — locate via `grep -n "metadata_account_set\|IsChannelName" ircd/m_metadata.c` in the ms_ handler region around :1369-1435: the branch that TTL-writes `#chan` rows for NON-+R channels dies; the +R store write now happens inside `metadata_set_channel` per B1. The GET channel store-fallback (:481-570 region) STAYS, read-only — verify it promotes via `metadata_channel_memory_put` after Task 2)
- Modify: `ircd/m_metadata.c` (`metadata_cmd_get`: the denied-private-key `continue` path — emit `send_reply(sptr, RPL_KEYNOTSET, display, key)` (matching :578's expansion pattern) so denied == absent; spec "Known deferrals" item 3)

**Interfaces:**
- Consumes: B1 (the store write it replaces), the A2 decoders.
- Produces: no store rows for unregistered channels anywhere; CLEAR channel-store residue resolved (B1 delete branch + B4 tombstone reap as backstop).

- [ ] **Step 1:** Remove the non-+R channel TTL store-cache write block from the relayed apply. For a +R channel the relayed apply's `metadata_set_channel` call (:1403, under suspend) persists correctly (B1); for unregistered channels the apply is memory+relay only (spec §C3). Any dead helpers this orphans (grep before deleting) go too.
- [ ] **Step 2:** Existence-leak fix: in the GET denied-private path, reply 766 instead of silent `continue`. One-line; VALUE hiding is untouched (A2 guarantee).
- [ ] **Step 3 (B6, verify-only):** read the channel MD burst block (channel.c:1643-1653) and confirm untouched — tree/legacy peers keep MD burst; CRDT peers get the doc via CR F. State the confirmation in the report.
- [ ] **Step 4:** Host build + cmocka green. Verify sweep: `grep -n "metadata_account_set\b" ircd/m_metadata.c` → no TTL channel-cache writer remains.
- [ ] **Step 5:** Commit: `P2: retire the era-1 remote TTL channel cache (B1 owns +R store writes); GET denied-private now replies 766 (existence-leak closed)` (+ trailer).

### Task 6: Live scenarios 1/2/3 + regression drivers

**Files:**
- Create: `tests/clocktest/p2_chreg.py` (scenarios 1+3), `tests/clocktest/p2_restart.py` (scenario 2) — in the TESTNET repo (`/home/ibutsu/testnet`), NOT the submodule; model on `tests/clocktest/p1_doconly.py`/`leafauth_330.py` (Irc/open_opers/wait_converged helpers, PASS/FAIL verdict lines, `sys.exit`)

**Interfaces:** consumes the deployed Docker bed (all five nodes rebuilt + wave-restarted on the P2 binary; freshness via the `ircd.YYYYMMDDHHMM` symlink).

- [ ] **Step 1 (scenario 1+3, p2_chreg.py):** oper on hub nef3 creates `#p2reg`, OPMODE `+R` (local OPMODE = entry node), `METADATA #p2reg SET` a public + a private key; assert on overlay-reached leaf (nef7): GET/LIST show both (vis-correct: private only to opers/… per the channel rules), store row exists (GET after a memory-flush is not scriptable — LIST correctness + scenario 2 restart carry the store proof); then `-R` → assert mesh-wide: rows reaped from LIST on all five within convergence window, mdigest converges. PASS/FAIL verdict.
- [ ] **Step 2 (scenario 2, p2_restart.py):** with `#p2reg` +R and keys set (re-setup), restart the FULL bed in waves of ≤2 (nef3+nef4 → health → nef5+nef6 → health → nef7 — reuse the staged pattern), wait for tree + mesh; assert: +R channel metadata restored into GET/LIST on ≥2 nodes (doc→store→+R-burst-load→memory), unregistered channel `#p2eph` metadata gone everywhere, mdigest converges. PASS/FAIL verdict.
- [ ] **Step 3:** Rebuild the five images (`scripts/dc.sh -l --profile multi build nefarious3 nefarious4 nefarious5 nefarious6 nefarious7`), wave-restart, verify symlink freshness on all five, run both drivers + regression: `p1_vis.py`, `p1_operset.py`, `p1_doconly.py`, `leafauth_330.py` — all must PASS.
- [ ] **Step 4:** Commit (testnet repo): `P2 live gates: +R channel metadata converge/restart/unregister scenarios + P1/leafauth regression green` (+ trailer).

---

## Self-review notes

- Spec coverage: B1→Task 2, B2→Task 1, B3→Task 4, B4→Task 3, B5+deferral-766→Task 5, B6→Task 5 Step 3 (verify-only), scenarios 1/2/3→Task 6. §C3 falls out of Task 5 Step 1. CLEAR residue (spec B5 paragraph) resolved by Task 2 delete branch + Task 3 reap; called out in Task 5's Produces.
- The one spec-silent trap (GET promotion re-persisting after B1) is handled structurally in Task 2 via the memory primitives, consistent with P1's A3 rule.
- Type consistency: `metadata_channel_memory_put(chptr, key, value, visibility)` used identically in Tasks 2/3/4/5; entry-node predicate identical in Tasks 4 and Global Constraints.
