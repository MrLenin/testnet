# Metadata P0 — Shrink the Surface (retirements + burst fix) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Phase P0 of `.claude/para/projects/metadata-era2-completion.md` — delete the audited era-1/era-2 dead code (MDQ, Z passthrough, dead functions, lying flags), fix the user-burst target token, and wire store shutdown. No behavior redesign; every deletion is auditable dead code.

**Architecture:** Pure subtraction plus two one-liners (`server_die` shutdown call, burst `%C`→`cli_name`). The audits at `.claude/para/resources/metadata-audit-{storage,wire}-2026-07-24.md` are the authority for every deletion target (each has file:line there). Line numbers below are audit-time hints — **anchor by symbol, not line**.

**Tech Stack:** C (ircu/Nefarious), RocksDB store layer, cmocka (in-build gate), Docker 5-node CRDT bed.

## Global Constraints

- Tree: `/home/ibutsu/testnet/nefarious-crdt`, branch `crdt-mesh`. Do NOT touch `/home/ibutsu/testnet/nefarious` (prod fork).
- `metadata_channel_load` (metadata.c:909 + its `!USE_ROCKSDB` stub) MUST SURVIVE this phase — it is revived by spec §B3 in P2. Mark it: `/* deliberately kept unwired: revived by metadata-era2-completion.md §B3 (P2) */`.
- The STORE-layer zstd compression (`metadata_account_set_ts` → ircd_compress) is NOT the wire `Z` passthrough. Only the wire path dies. Do not touch ircd_compress.c.
- The plain (non-Z) channel TTL-cache write in `ms_metadata` (audit-time `m_metadata.c:1624-1631`) STAYS in P0 — it dies in P2 (§B5). P0 removes only the `Z`/compressed arm of that block.
- Engine files (`crdt_types.c`, `crdt_state.c`, `crdt_hlc.c`, `crdt_wire.c`) are untouched in P0.
- Host build verifies each task; Docker build (in-build cmocka gates the image) is the canonical final gate. Freshness oracle: the `ircd.YYYYMMDDHHMM` symlink must ADVANCE per node.
- Use `scripts/dc.sh` (never raw `docker compose`). Do not run the full Vitest suite. Do not commit `data/ircd*.conf` or throwaway tooling.
- Commit messages end with: `Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>`.
- Host build commands (from `/home/ibutsu/testnet/nefarious-crdt`):
  - compile: `make -C ircd ircd` (tree is already configured; if no `ircd/Makefile`, run `./configure --enable-debug` first)
  - cmocka: `make -C ircd/test crdt_cmocka && ./ircd/test/crdt_cmocka` — expect `[  PASSED  ] <N> test(s).`, exit 0

---

### Task 1: Retire MDQ (dead pull-cache protocol)

**Files:**
- Modify: `ircd/m_metadata.c` (delete `ms_metadataquery` + its doc-comment block, audit-time :1301-1430)
- Modify: `include/msg.h` (delete `MSG_METADATAQUERY` / `TOK_METADATAQUERY` / `CMD_METADATAQUERY`, :563-565)
- Modify: `ircd/parse.c` (delete the METADATAQUERY msgtab entry, :1037-1043)
- Modify: `include/handlers.h` (delete the `ms_metadataquery` declaration)

**Interfaces:** none produced; consumers verified zero (whole-ecosystem grep in audit wire §3 — no sender in nefarious-crdt, prod fork, or X3).

- [ ] **Step 1:** Delete the `ms_metadataquery` function and the `/** ... services (X3) ... */` comment block immediately above it in `ircd/m_metadata.c`.
- [ ] **Step 2:** Delete the three METADATAQUERY defines in `include/msg.h`, the full msgtab entry in `ircd/parse.c` (the `{ MSG_METADATAQUERY, TOK_METADATAQUERY, ... }` block including its handler-array lines), and the extern in `include/handlers.h`.
- [ ] **Step 3:** Verify: `grep -rn "METADATAQUERY\|ms_metadataquery" ircd/ include/` → expect ZERO hits.
- [ ] **Step 4:** Host build + cmocka (commands in Global Constraints) → both green.
- [ ] **Step 5:** Commit: `git add -u && git commit -m "P0: retire MDQ responder (dead pull-cache protocol, zero senders ecosystem-wide)"` (+ trailer).

### Task 2: Remove the Z compressed passthrough

**Files:**
- Modify: `ircd/m_metadata.c` (static `base64_decode` :79-102; `Z` parse branch :1496-1499; decode blocks :1513-1520 and :1538-1558; the `is_compressed` arm of the channel store-cache :1608-1622; the `Z`-form relay :1649-1652)
- Modify: `ircd/metadata.c` (delete `metadata_account_set_raw` :511-538 + any `!USE_ROCKSDB` twin)
- Modify: `include/metadata.h` (delete the `metadata_account_set_raw` declaration)

**Interfaces:** none; `metadata_account_set_raw`'s only callers are the Z store arm deleted in the same task (audit storage §1B).

- [ ] **Step 1:** In `ms_metadata`, remove the `Z` detection in the parse (so `parv[3]` is visibility-or-old-format only), the base64/zstd decode paths (the value flows through as plain text unconditionally), the `is_compressed` store arm inside the channel cache block (keep the plain TTL arm), and the `Z` relay format (keep the plain value/unset relays). Collapse any now-single-use `plain_value` indirection to taste — behavior for plain frames must be byte-identical.
- [ ] **Step 2:** Delete static `base64_decode` from `m_metadata.c` and `metadata_account_set_raw` from `metadata.c` + header.
- [ ] **Step 3:** Verify: `grep -n "base64_decode\|set_raw\|is_compressed\|\" Z \"\|Z :" ircd/m_metadata.c ircd/metadata.c include/metadata.h` → zero relevant hits (manually confirm any residual `Z` hit is unrelated text).
- [ ] **Step 4:** Host build + cmocka green.
- [ ] **Step 5:** Commit: `"P0: remove Z compressed metadata passthrough (originator-less; closes set_raw chokepoint bypass)"` (+ trailer).

### Task 3: Delete dead functions, stubs, and macros

**Files:**
- Modify: `ircd/metadata.c` — delete `metadata_get_client_cached` (:1805-1845), `metadata_channel_persist` (:900-902), `metadata_burst_client` (:1853-1858), `metadata_burst_channel` (:1864-1869), `metadata_defrag` (:1926-…), `metadata_valid_key` (:1064-…), `metadata_init` (:1047-1051); each including its `#else`/`!USE_ROCKSDB` stub twin if present. Add above `metadata_channel_load`: `/* deliberately kept unwired: revived by metadata-era2-completion.md §B3 (P2) */`
- Modify: `ircd/m_metadata.c` — delete static `parse_visibility` (:579)
- Modify: `include/metadata.h` — delete decls :362 (`get_client_cached`), :372/:378 (burst stubs), :395 (`defrag`), :173 (`valid_key`), the `metadata_init` decl (:65), and macros `METADATA_MAX_KEYS`/`METADATA_MAX_SUBS` (:40,:43). KEEP the `metadata_shutdown` decl (:68) — Task 4 gives it a caller.

**Interfaces:** none; all targets have 0 callers (audit storage §4, wire §8).

- [ ] **Step 1:** Delete the functions/macros listed above; add the channel_load marker comment.
- [ ] **Step 2:** Verify per symbol: `for s in metadata_get_client_cached metadata_channel_persist metadata_burst_client metadata_burst_channel metadata_defrag metadata_valid_key parse_visibility metadata_init METADATA_MAX_KEYS METADATA_MAX_SUBS; do grep -rn "\b$s\b" ircd/ include/; done` → zero hits — EXCEPT `METADATA_MAX_KEYS`/`METADATA_MAX_SUBS`, where the grep legitimately still hits the LIVE feature-flag machinery (`FEAT_METADATA_MAX_*` reads and the token-pasted `F_I(METADATA_MAX_KEYS,…)` table rows in ircd_features.c): only the two `#define` macros in metadata.h die; the features stay. (Caveat added post-execution per the final review — the original "zero hits" wording was wrong for those two.) Then `grep -n "metadata_channel_load" ircd/ include/ -r` → exactly the definition, its no-DB stub, and the marker comment.
- [ ] **Step 3:** Host build + cmocka green.
- [ ] **Step 4:** Commit: `"P0: delete dead metadata functions/stubs/macros (era-1/2 husks, 0 callers each)"` (+ trailer).

### Task 4: Wire store shutdown into server exit

**Files:**
- Modify: `ircd/ircd.c` (`server_die`, ~:385)
- Modify: `ircd/metadata.c` (confirm/trim `metadata_shutdown` :1053 → it must call `metadata_lmdb_shutdown()` and nothing era-1)

**Interfaces:**
- Consumes: existing `void metadata_shutdown(void)` (metadata.h:68).
- Produces: `server_die` closes the metadata RocksDB env (mirrors the existing `bounce_db_shutdown()` precedent). `server_panic` intentionally does NOT (panic path avoids touching state, same as bounce).

- [ ] **Step 1:** Read `metadata_shutdown`'s body; ensure it is exactly the env close (calls `metadata_lmdb_shutdown()`); trim anything else dead.
- [ ] **Step 2:** In `server_die` add the call directly after the bounce line:

```c
  bounce_db_shutdown();  /* Persist bouncer sessions before closing connections */
  metadata_shutdown();   /* close the metadata/readmarkers RocksDB env */
```

- [ ] **Step 3:** Host build green. Note for the record (out of P0 scope, same gap class): `history_shutdown` also has zero callers — the chathistory env is likewise never closed; tracked in the spec's §D as adjacent debt, not fixed here.
- [ ] **Step 4:** Commit: `"P0: close metadata RocksDB env in server_die (was never closed)"` (+ trailer).

### Task 5: Remove the lying cache flags

**Files:**
- Modify: `include/ircd_features.h` (remove `FEAT_METADATA_CACHE_ENABLED`, `FEAT_METADATA_CACHE_SLOTS` from the enum, ~:424-431)
- Modify: `ircd/ircd_features.c` (remove both table entries, ~:1279-1286)
- Modify: `ircd/ircd.c` (purge-timer callback ~:895-907: remove the `FEAT_METADATA_CACHE_ENABLED` gate; KEEP the `FEAT_METADATA_CACHE_TTL > 0` gate)

**Interfaces:** `FEAT_METADATA_CACHE_TTL`, `FEAT_METADATA_PURGE_FREQUENCY`, `FEAT_METADATA_BURST` remain (live, per spec §D). The purge sweep now runs whenever TTL > 0.

- [ ] **Step 1:** Remove both enum members + table entries; fix the purge gate in `ircd.c` (the CACHE_ENABLED read in `metadata_get_client_cached` died in Task 3).
- [ ] **Step 2:** Verify: `grep -rn "METADATA_CACHE_ENABLED\|METADATA_CACHE_SLOTS" ircd/ include/` → zero. Conf check (already verified at plan time): `data/ircd3.conf`…`ircd7.conf` contain neither name; `data/ircd.conf`/`ircd2.conf` do but belong to the PROD bed — leave them.
- [ ] **Step 3:** Host build + cmocka green.
- [ ] **Step 4:** Commit: `"P0: remove FEAT_METADATA_CACHE_{ENABLED,SLOTS} (drifted/dead since e16c222); purge sweep gates on TTL only"` (+ trailer).

### Task 6: Fix the user-burst target token (spec §C1)

**Files:**
- Modify: `ircd/s_serv.c` (~:544-554, the `FEAT_METADATA_BURST` user block)

**Interfaces:** receiver is `ms_metadata`'s `FindUser(target)` (nick hash) — the whole point of the fix.

- [ ] **Step 1:** In the per-user metadata burst `sendcmdto_one` call, change format `"%C %s %s :%s"` → `"%s %s %s :%s"` and the first payload argument `acptr` → `cli_name(acptr)`. Leave every other argument untouched. (Precedent: the CMD_MARK burst at ~:505 already uses `cli_name`.)
- [ ] **Step 2:** Host build green. Validation is inspection + gates only: between doc-ready CRDT peers the CR F cutover (`s_serv.c:367-381`) skips this loop entirely, so no live scenario on this bed exercises it — e2e proof is deferred to the prod-fork cherry-pick bed (documented in spec §Testing (5)).
- [ ] **Step 3:** Commit: `"P0: user metadata netburst targets nick not numnick (receiver resolves via FindUser; broken since ca033ea)"` (+ trailer).

### Task 7: Comment/claim truth pass

**Files:**
- Modify: `ircd/m_metadata.c` (GET flow header comment :368-374 — drop the "send MDQ to X3" step; describe memory → store fallback → 766)
- Modify: `include/metadata.h` (:364/:380 era markers — make them true post-Task-1: MDQ is removed entirely, responder included; server-managed prefix comment :269-276 aligned to the actual table = `draft/persistence/` only)
- Modify: `ircd/metadata.c` (:1440-1445 same prefix-comment alignment; :1797 stale MDQ marker)

**Interfaces:** none (comments only; the `metadata_lmdb_*`→`db` rename is explicitly OUT of scope, spec §D).

- [ ] **Step 1:** Apply the four comment corrections. No code changes.
- [ ] **Step 2:** Host build green (comment-only safety check).
- [ ] **Step 3:** Commit: `"P0: metadata comments tell the truth (MDQ gone, real server-managed prefix table)"` (+ trailer).

### Task 8: Docker gate + live sanity + phase publish

**Files:** none new (build + validation + git bookkeeping).

- [ ] **Step 1:** Build all five CRDT images: `scripts/dc.sh -l --profile multi build nefarious3 nefarious4 nefarious5 nefarious6 nefarious7` — the in-build cmocka gates each image (a failing suite fails the build).
- [ ] **Step 2:** `scripts/dc.sh -l --profile multi up -d nefarious3 nefarious4 nefarious5 nefarious6 nefarious7`, then verify freshness per node: `for n in 3 4 5 6 7; do docker exec nefarious$n readlink /home/nefarious/bin/ircd; done` → all five symlinks show the SAME new `ircd.YYYYMMDDHHMM` (must be newer than `202607240531`). Stale symlink ⇒ `--no-cache` rebuild (then `docker builder prune -f` if disk pressure).
- [ ] **Step 3:** Live sanity: `cd tests/clocktest && python3 s5c_restore.py` → expect final line `S5C-RESTORE PASS …` (exercises SET/GET/restore-via-load_account/CLEAR-propagation/mesh convergence — the fdf93a5 regression guard; P0 must not move it).
- [ ] **Step 4:** Push + pointer: in `nefarious-crdt`: `git push origin crdt-mesh`. In `/home/ibutsu/testnet`: `git add nefarious-crdt && git commit -m "nefarious-crdt: bump to <sha7> (metadata P0 — retire MDQ/Z/dead era-1 paths, burst target fix, store shutdown)"` (+ trailer). Stage ONLY the submodule pointer (standing crdt-mesh phase-commit OK; para/spec docs ride separately at user's word).
- [ ] **Step 5:** Append to `nefarious-crdt/.superpowers/sdd/progress.md`: `Metadata P0: complete (commits <base7>..<head7>, Docker gate green, s5c PASS)`.

## Self-review notes (done at write time)

- Spec §D coverage: MDQ ✅(T1), Z+set_raw ✅(T2), dead functions/macros ✅(T3), shutdown ✅(T4), flags ✅(T5), comment truth ✅(T7), FEATURE_FLAGS_CONFIG.md rewrite → deliberately P3 (docs phase), not here. §C1 ✅(T6).
- No placeholders; deletion targets carry symbol anchors + verification greps with expected-zero outcomes.
- Type consistency: only new call is `metadata_shutdown()` — existing `void(void)` decl kept in T3 explicitly for T4.
- TDD note (per `feedback_no_silent_defer`): pure deletions admit no red-green cycle; the gates are build + cmocka + grep-zero + the existing live regression driver (s5c). C1's behavioral test is impossible on this bed (CR F cutover) — deferred to the prod cherry-pick with the spec updated to say so.
