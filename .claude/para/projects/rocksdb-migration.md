# Migrating Nefarious from libmdbx to RocksDB

## Why this is on the table

**Immediate trigger**: a supply-chain scanner flagged the gitflic.ru submodule URL as a risk, prompting this investigation. There is no Debian/Ubuntu/Fedora package for libmdbx — we already build it from source in a Dockerfile multistage. The supply-chain concern is not theoretical; it's been externally identified and we're presently shipping a vendored Russian git URL with no upstream packaging fallback.

Underlying reasons libmdbx upstream is no longer a partner we can rely on long-term:

1. The successor (MithrilDB) is **export-restricted** — explicitly excludes "countries unfriendly to Russia (i.e. acceded the sanctions, devil adepts and/or NATO)."
2. As of end-2025, libmdbx ships **only as amalgamated source**; tests and internal docs are closed-team.
3. Roadmap is "continuous movement towards MithrilDB."
4. **No distro packaging anywhere** — every consumer self-builds. By contrast, `librocksdb-dev` is in Debian/Ubuntu main, Fedora, Alpine, Homebrew. Switching backends drops the multistage source build entirely.

We mitigated the immediate scanner finding by switching the submodule URL to `github.com/Mithril-mine/libmdbx.git`. **This is scanner-cosmetics, not a real mitigation**. Verified facts:

- The Mithril-mine org's contact email is `mithril-mine@dqdkfa.ru` — Yuriev's personal domain (same as the official `libmdbx.dqdkfa.ru` site). It is unambiguously his own infrastructure under a pseudonymous org name created 2026-03-21.
- The repo ID is `44061596`, created `2015-10-11` — i.e., the *same* GitHub database row that was `erthink/libmdbx`. The README's narrative that GitHub "deleted" the project in 2022 is technically inconsistent with the URL redirect we observe today (`erthink/libmdbx` 301s to `Mithril-mine/libmdbx` via the preserved repo ID). GitHub preserves repo IDs only across rename/transfer, not actual deletion. Either the "deletion" was suspension/hiding, or it was reversed; no public statement explains which.
- Commits are GPG-signed and verify against Yuriev's known key (`F4818FAAF3D97BEF93E8...`).
- The README still says *"Github is blacklisted forever"* and frames 2022 as *"outright Github sabotage"* despite the active GitHub operation. The public stance and the operating reality are inconsistent.

So our submodule URL change moved us from "Russian git host that triggers scanners" to "GitHub mirror with an opaque restoration story, operated by a maintainer who publicly disowns GitHub while privately using it." The dependency itself — same person, same signing key, same political posture, same closed test suite, same export-restricted successor roadmap — has not changed. It does not fix the underlying packaging gap or the long-term direction.

We're pinned at commit `6b2501db` (Apache-2.0) and it works. The question is whether the supply-chain reality justifies migration cost. Alternatives evaluated and rejected: LMDB (regression on the exact pain that drove us to libmdbx — fixed mapsize, MDB_MAP_FULL, no middle-ground sync mode), SQLite (compression awkward, WAL single-writer), Sophia/Vinyl/ForestDB (moribund), WiredTiger (GPL-3 friction with our GPL-2-or-later). RocksDB (Apache-2.0 / GPL-2 dual, **distro-packaged everywhere**) is the serious contender.

This plan answers: **is the effort worth it?**

## Current libmdbx surface area

Verified by direct file audit, not just the prior summary.

### Files that include `<mdbx.h>` directly

| File | Role |
|---|---|
| `nefarious/ircd/history.c` | Chathistory storage. Hot path. |
| `nefarious/ircd/metadata.c` | IRCv3 metadata + readmarkers + bouncer-session storage env. |
| `nefarious/ircd/webpush_store.c` | Web Push subscription store. |
| `nefarious/ircd/ml_content.c` | Multiline message body store; **opens DBIs inside the history env**. |
| `nefarious/ircd/bouncer_session.c` | Bouncer session persistence; **opens DBI inside the metadata env via `metadata_get_env()`**. |
| `nefarious/include/history.h` | Re-exports `MDBX_*` types via `#include <mdbx.h>` for `struct HistoryMessage` consumers. |

### Three logical environments → seven sub-DBIs

```
history env                           metadata env                webpush env
├── messages   (MDBX_APPEND hot)      ├── metadata                ├── subscriptions
├── msgid_index                       ├── readmarkers             └── config
├── targets                           └── bouncer_sessions
├── quotas
├── reply_index   (MDBX_DUPSORT)
├── ml_content
└── ml_paste_secrets
```

### libmdbx-only features actually relied on

| Feature | Sites | Why it matters |
|---|---|---|
| `MDBX_APPEND` flag | history.c:920, 1104 | Skip B-tree traversal on monotonic-timestamp inserts. Hot path. |
| `mdbx_env_set_geometry` | history.c:655, metadata.c:289, webpush_store.c:150 | Dynamic file grow/shrink — the reason we left LMDB. |
| `MDBX_SAFE_NOSYNC` + `mdbx_env_set_option(MDBX_opt_sync_period, ...)` | history.c:673, 692 | Durable-but-fast sync mode at 16.16-fixed-point seconds. |
| `mdbx_env_defrag` | history.c:3547, 3587; metadata.c:1953, 1993 | Online compaction, oper command. |
| `mdbx_cache_init` / `mdbx_cache_get_SingleThreaded` | metadata.c:130, 381, 466 | Single-threaded B-tree traversal cache for metadata reads. |
| `mdbx_txn_park` / `mdbx_txn_unpark` | history.c:1394, 1419 | Yield long read txn to writers without losing cursor state. |
| `mdbx_env_warmup` | metadata.c:389, history.c:785 | Prefault pages on startup. |
| `mdbx_gc_info` | metadata.c:1908, 2063; history.c:3506, 3649 | Free-page diagnostics for `STATS M`. |
| `mdbx_reader_check` | history.c:3318 | Reap stale reader slots after a bad shutdown. |
| `MDBX_NORDAHEAD` | metadata.c:306 | Disable madvise(WILLNEED) for random-access workload. |
| `MDBX_DUPSORT` | history.c:755 (one DBI) | Multi-value-per-key, used by reply/context index. |

### Drop-in calls (~85% of usage)

env/txn/dbi/cursor lifecycle, CRUD (`mdbx_get/put/del`, cursor-`MDBX_FIRST/NEXT/SET_RANGE/SET_KEY/PREV/LAST`), `mdbx_dbi_stat`, `mdbx_env_stat_ex`, the `MDBX_val` struct.

### User-facing surface

`m_mdbx.c` — `/MDBX <DEFRAG | SYNC | GC | INFO> [history | metadata | all]`. Oper-only. Will need rename (`/STORE` or keep `/MDBX` as alias) and subcommand semantics rework — RocksDB has `Compact`, no manual `Sync` / `GC` in the same shape.

### Build / packaging

- `configure.in:960-997` — `--with-mdbx[-includes][-libs]`, defines `USE_MDBX`.
- `Dockerfile:24-37, 62` — multistage build of libmdbx from source via cmake, then `COPY --from=` of `.so` + `mdbx.h` into the runtime stage. `--with-mdbx=/usr` at configure time.

### App-level zstd compression layer

`USE_ZSTD` paths in history.c (around the `mdbx_put`/`mdbx_get` sites) and metadata.c. Per-feature `COMPRESS_THRESHOLD` and `COMPRESS_LEVEL`. RocksDB has native block-level zstd in column-family options — this layer can potentially retire, see Phase 5.

## What maps to what in RocksDB

| libmdbx concept | RocksDB equivalent | Sharp edge |
|---|---|---|
| `MDBX_env` | `rocksdb_t*` (one per env) | One per logical store. Three total (history/metadata/webpush). |
| `MDBX_dbi` (named sub-database) | Column Family (`rocksdb_column_family_handle_t*`) | Open at `rocksdb_open_column_families()` time. Adding a new CF later requires `rocksdb_create_column_family`. |
| `MDBX_txn` (write) | `rocksdb_writebatch_t` + `rocksdb_write()` | Single-threaded ircd: write batches are sufficient; we do **not** need TransactionDB or OptimisticTransactionDB. |
| `MDBX_txn` (read snapshot) | `const rocksdb_snapshot_t*` + `rocksdb_readoptions_set_snapshot()` | Stable view across multiple reads; required for the long-read paths in history.c. |
| `mdbx_get` | `rocksdb_get_cf()` | `errptr` model for errors. Caller frees returned value with `rocksdb_free()`. **Lifetime model differs from libmdbx mmap pointers** — every `get` is a heap copy. Hot reads will allocate. |
| `mdbx_put` | `rocksdb_put_cf()` or `rocksdb_writebatch_put_cf()` | No `MDBX_NOOVERWRITE` semantic; emulate with prior `get`. Not needed for our usage. |
| `mdbx_del` | `rocksdb_delete_cf()` / `rocksdb_writebatch_delete_cf()` | Tombstones; LSM compacts away over time. |
| `mdbx_cursor_*` | `rocksdb_iterator_t*` (`rocksdb_create_iterator_cf`) | `Seek/SeekToFirst/SeekToLast/Next/Prev`. Iterator pins a snapshot implicitly. |
| `MDBX_SET_KEY` | `Seek(key)` then check exact match | RocksDB `Seek` is `>=`; explicit equality check needed. |
| `MDBX_SET_RANGE` | `Seek(key)` | Identical semantics. |
| `MDBX_FIRST` / `MDBX_LAST` | `SeekToFirst` / `SeekToLast` | Drop-in. |
| `MDBX_NEXT` / `MDBX_PREV` | `Next` / `Prev` | Drop-in. |
| `MDBX_DUPSORT` (one DBI) | **Encode the dup value into the key** — see DUPSORT section. | **Migration is not mechanical.** |
| `MDBX_NEXT_DUP` | Iterator `Next` + key prefix check | Loop until key prefix changes. |
| `MDBX_APPEND` flag | `Options::PrepareForBulkLoad()` is wrong shape (changes whole-DB tuning). For our pattern: just rely on RocksDB's internal `MemTable` insertion — **inserting at the largest key is already cheap in a skiplist memtable**. The optimization isn't needed. |
| `MDBX_SAFE_NOSYNC` + sync interval | `WriteOptions::sync = false` + `Options::WAL_bytes_per_sync` + `Options::manual_wal_flush` (or `wal_ttl_seconds`) | **Semantics differ.** libmdbx's SAFE_NOSYNC keeps DB consistent across crash, only loses last unsynced txns. RocksDB with `sync=false` writes go to OS page cache; on power loss, WAL replay recovers. Equivalent durability profile but different mechanism — verify in test. |
| `mdbx_env_set_geometry` (autogrow) | Native — RocksDB files grow as needed | Drop the upper-bound concept; RocksDB has no fixed-mapsize equivalent. Autogrow becomes the only mode. |
| `mdbx_env_defrag` | `rocksdb_compact_range_cf()` (full compaction over key range) | Different cost model: rewrites SST files, doesn't shrink a btree in place. Manual compaction is normally a code smell in RocksDB; auto-compaction handles it. The `/MDBX DEFRAG` oper command becomes mostly a no-op or a `CompactRange(NULL, NULL)` for those who want it. |
| `mdbx_cache_init` / `mdbx_cache_get_SingleThreaded` | `rocksdb_cache_create_lru()` (block cache) at `Options` level | RocksDB's block cache is process-global per-env and serves the same purpose. Our hand-rolled FNV cache layer in metadata.c can be **deleted**. |
| `mdbx_txn_park` / `mdbx_txn_unpark` | Iterator + snapshot — no equivalent | RocksDB long-running iterators don't block writers (LSM, not B-tree-with-MVCC-overflow). Park/unpark logic in history.c:1380-1450 can be **deleted entirely**. |
| `mdbx_env_warmup` | `rocksdb_options_set_advise_random_on_open(0)` + first read | Block cache warms on demand. Drop the explicit warmup call. |
| `mdbx_gc_info` | `rocksdb_property_value("rocksdb.estimate-num-keys")` etc. | `STATS M` reformatted to LSM-relevant numbers (level sizes, pending compaction, write-amp). |
| `mdbx_reader_check` | N/A | RocksDB doesn't use a reader-table file; no equivalent. Remove. |
| `MDBX_NORDAHEAD` | `Options::advise_random_on_open = true` | Default-on in RocksDB anyway. |
| `mdbx_dbi_stat` | `rocksdb_property_int_value_cf(... "rocksdb.estimate-num-keys")` | Approximate; mention in `/STATS M`. |
| Native zstd compression | `Options::compression = kZSTD` per CF + `compression_per_level` | See Phase 5 — opportunity to retire app-level zstd. |

### Transactions: pessimistic, optimistic, or just write batches?

Nefarious's IRCd is **single-threaded event-driven**. There's exactly one writer at any moment. We never need read-modify-write conflict resolution because the event loop serializes everything. Therefore:

- **Use `rocksdb_t` (the plain DB), not `rocksdb_transactiondb_t` or `rocksdb_optimistictransactiondb_t`.**
- **Use `rocksdb_writebatch_t` for atomic multi-key writes.** A WriteBatch is the equivalent of an MDBX write txn: stage all puts/dels, then commit with `rocksdb_write()`. Atomic, durable per WriteOptions.
- **Use snapshots for reads that need a stable view across multiple `get`/iterator calls** — `rocksdb_create_snapshot()` / `rocksdb_readoptions_set_snapshot()`.

This means we bypass the entire RocksDB transaction-API complexity. Big simplification.

### DUPSORT migration (the only invasive data-shape change)

`reply_index` DBI today:

```
key:   "<target>\0<parent_msgid>"          (DUPSORT — many values per key)
val:   "<timestamp>\0<child_msgid>"
```

RocksDB has no DUPSORT. Standard pattern: fold the discriminator into the key.

```
key:   "<target>\0<parent_msgid>\0<timestamp>\0<child_msgid>"
val:   ""   (or 1 byte sentinel)
```

Then `MDBX_NEXT_DUP` becomes "iterator `Next` while key starts with `<target>\0<parent_msgid>\0`."

Concrete: history.c:519, history.c:2785 each loop on `MDBX_NEXT_DUP`. Translation:

```c
/* libmdbx pattern (current):
 *   rc = mdbx_cursor_get(c, &k, &v, MDBX_SET_KEY);
 *   while (rc == 0) { ...; rc = mdbx_cursor_get(c, &k, &v, MDBX_NEXT_DUP); }
 */

/* RocksDB pattern (target):
 *   build prefix: "<target>\0<parent_msgid>\0"
 *   rocksdb_iter_seek(it, prefix, prefix_len);
 *   while (rocksdb_iter_valid(it)) {
 *     size_t klen; const char *k = rocksdb_iter_key(it, &klen);
 *     if (klen < prefix_len || memcmp(k, prefix, prefix_len) != 0) break;
 *     // suffix = k + prefix_len; suffix_len = klen - prefix_len;
 *     // suffix is "<timestamp>\0<child_msgid>"
 *     ...
 *     rocksdb_iter_next(it);
 *   }
 */
```

`reply_index_del` (history.c:497-522) which currently scans for a matching child to delete becomes a single `Delete(target\0parent\0timestamp\0child)` once we know the timestamp — even simpler than today.

**Data migration**: existing reply_index entries are in the old shape. The on-startup migration tool (Phase 6) walks the libmdbx reply_index DBI and rewrites each `(key, val)` into the new flat-key form in the RocksDB CF.

## Phase plan

Phases are sequenced so each one is independently shippable. After any phase you can stop and the codebase is in a working, testable state.

### Phase 0 — Abstraction layer (kick-the-can option)

Wrap every `mdbx_*` call site behind a thin internal API. Single backend (libmdbx) under the hood. No semantic change.

Headers (new):
- `nefarious/include/db_env.h` — env open/close/sync/defrag/stats
- `nefarious/include/db_txn.h` — txn begin/commit/abort + write-batch surface
- `nefarious/include/db_cursor.h` — iterator/cursor primitives
- `nefarious/include/db_types.h` — `db_val` struct (mirror of `MDBX_val`/`rocksdb` slice shape)

Implementation (new):
- `nefarious/ircd/db_mdbx.c` — libmdbx backend implementing the abstraction.

Caller changes:
- `history.c`, `metadata.c`, `webpush_store.c`, `ml_content.c`, `bouncer_session.c` — replace `mdbx_*` calls with `db_*` calls.
- `include/history.h` — stop re-exporting `<mdbx.h>`; export opaque `db_*` types instead.
- `m_mdbx.c` — keep oper command but route through abstraction.

Tests pass unchanged. Output: same binary, same on-disk format, same behavior. **This phase has standalone value as a hedge** — if migration gets shelved or libmdbx upstream becomes actually hostile, we have a clean swap point.

**Effort**: 4-7 person-days. Confidence high. The libmdbx call sites are ~250 distinct invocations across ~7000 lines; mechanical wrapping is straightforward. Risk: the `MDBX_val` lifetime model (pointers into the mmap, valid for the txn duration) needs to be preserved or explicitly replaced with a copy-out model. Erring toward copy-out is slightly slower today but maps cleanly to RocksDB's `rocksdb_get` semantics.

### Phase 1 — Build system: detect both backends

`configure.in`:
- Add `--with-rocksdb=DIR`, `--with-rocksdb-includes=DIR`, `--with-rocksdb-libs=DIR`.
- Define `USE_ROCKSDB` symbol parallel to `USE_MDBX`.
- New `--with-storage-backend=mdbx|rocksdb` switch picks which `db_*.c` is compiled in. Default keeps libmdbx for now.
- Detect `librocksdb` via `AC_CHECK_LIB(rocksdb, rocksdb_open)` and the C header `rocksdb/c.h`.

Dockerfile:
- Drop the libmdbx multistage build.
- Add `librocksdb-dev` (Debian 12 ships librocksdb 7.x; verify `apt-cache show librocksdb-dev`). For the runtime image, add `librocksdb7.8` (or whatever the runtime package is named).
- C++ runtime: librocksdb pulls in libstdc++. The IRCd is a C executable; linking against a C++ shared library requires the linker driver to know — pass `-lstdc++` explicitly in `MDBX_LDFLAGS` equivalent (`ROCKSDB_LDFLAGS`). No exception unwinding crosses the boundary because `rocksdb/c.h` catches all C++ exceptions and surfaces them as `errptr` strings. **This is the single biggest unknown**; verify with a hello-world link before committing.

**Effort**: 1-2 person-days. Confidence medium-high. C++ runtime linkage is not unknown territory (libcurl-with-OpenSSL projects deal with it routinely) but exact symbol-version pinning may bite.

### Phase 2 — RocksDB backend behind the abstraction

New file: `nefarious/ircd/db_rocksdb.c` — implements `db_env.h` / `db_txn.h` / `db_cursor.h` against `rocksdb/c.h`.

Both backends now compile. `--with-storage-backend=rocksdb` builds against RocksDB; default still libmdbx.

Sub-tasks:
- Open three envs (history/metadata/webpush), each with their declared CFs.
- Implement WriteBatch wrapper for the "txn" abstraction.
- Implement snapshot wrapper for read-side abstraction.
- Iterator wrapper with `seek_key`, `seek_range`, `seek_first`, `seek_last`, `next`, `prev`, `valid`, `key`, `value`, `close`.
- Block-cache + write-buffer Options tuned for the three workloads:
  - `history` env: large write buffer (64MB), zstd compression, level-style compaction, large block cache (256MB default).
  - `metadata` env: small write buffer (16MB), zstd, block cache (64MB).
  - `webpush` env: tiny (4MB write buffer, no compression — small payloads).
- Implement `db_compact_range_full()` for the `/MDBX DEFRAG` oper command.
- Implement `db_stats()` returning RocksDB property values for `STATS M`.

**Effort**: 5-9 person-days. Confidence medium. The C API is verbose and DUPSORT translation is in this phase. WriteBatch atomicity semantics need tests.

### Phase 3 — Pilot: `webpush_store.c`

Smallest module (723 lines). No DUPSORT, no APPEND, simple key-value with one full-table-scan iterator (`subscriptions` enumeration for VAPID key advertise).

- Switch this single module to use the RocksDB backend selectively (compile-time or even runtime, via a config flag pointing webpush at `/var/lib/nefarious/webpush.rocksdb` while history/metadata still use libmdbx files).
- Validate: VAPID round-trip, subscribe/unsubscribe, persistence across restart.
- Performance: irrelevant at this scale (handful of writes per minute at most).

Output: confidence the abstraction holds; one production module on RocksDB. Operators see a new `/var/lib/nefarious/webpush.rocksdb/` directory layout (multiple SST files instead of `data.mdb`).

**Effort**: 2-3 person-days. Confidence high.

### Phase 4 — `metadata.c` (+ `bouncer_session.c`)

Larger module (2171 lines). Three CFs (metadata, readmarkers, bouncer_sessions). Caller in `bouncer_session.c` must move to the abstraction at the same time because they share the env.

Specific concerns:
- **Drop the hand-rolled FNV B-tree-cache** (metadata.c:101-134, 380-393, 463-471). RocksDB block cache replaces it. Net code reduction.
- **Drop `mdbx_env_warmup`** (metadata.c:389) — RocksDB block cache warms on demand.
- **Drop `MDBX_NORDAHEAD`** (metadata.c:306) — N/A.
- Re-implement `metadata_defrag` as `rocksdb_compact_range_cf` over each CF with a time budget approximated via callback throttling.
- Re-implement `metadata_get_env()` to return an opaque `db_env_t*`; `bouncer_session.c` moves to `db_*` API.

**Effort**: 4-6 person-days. Confidence medium. The cache layer rip-out is satisfying but needs a perf check on a real metadata-heavy load (account-mounted servers).

### Phase 5 — `history.c` + `ml_content.c` (the hard one)

4186 lines, hot path, DUPSORT.

Specific concerns:
1. **DUPSORT migration on `reply_index`** as designed above. Verify `reply_index_put`, `reply_index_del`, the cursor walks at history.c:519 and 2785.
2. **`MDBX_APPEND` removal** — confirm via benchmark that RocksDB skiplist memtable insert is not measurably slower on monotonic keys. Expected outcome: it's fine, no special handling needed.
3. **`mdbx_txn_park` / `mdbx_txn_unpark` removal** (history.c:1380-1450) — RocksDB iterators don't block writers. Delete the entire park/unpark scaffolding (~70 lines of complex code). **This is a quality-of-life win**.
4. **`MDBX_SAFE_NOSYNC` mapping** — `WriteOptions::sync = false`, plus `Options::manual_wal_flush = true` if we want to batch WAL flushes at the configured `FEAT_CHATHISTORY_DB_SYNC_INTERVAL`. A timer event flushes WAL every N seconds. Verify durability semantics with a kill-9 test.
5. **App-level zstd retirement decision**:
   - Option A (recommended): keep app-level zstd for now. RocksDB block compression operates on multi-KV blocks (~4KB) — for a single 200-byte chathistory entry, app-level zstd is comparable. Migration risk is lower if we don't change two things at once.
   - Option B: drop app-level zstd, set `Options::compression = kZSTD`. Saves ~200 lines. But mid-flight existing zstd-compressed data would need a one-shot decompress-then-recompress in the migration tool, doubling its complexity.
   - **Decision deferred to after Phase 5 lands with Option A**; revisit as a follow-up.
6. **`MDBX_MAP_FULL` retry/emergency-evict logic** (history.c:926, 949, 968, 1000, 1109) — RocksDB never returns "map full" (no fixed mapsize). The retry goto-ladders can be **simplified out**, with the underlying `history_emergency_evict()` now triggered only by disk-quota policy not by storage error. Simplification.

Benchmark step (must do before merge):
- Write a `tools/history_bench.c` that replays a recorded message stream at peak rate (target: 1000 msg/sec sustained, p99 store latency < 5ms). Run against both backends. Compare write-amp on disk over a 1-hour run.

**Effort**: 8-14 person-days. Confidence low-medium. DUPSORT + benchmark + the data-volume of this module make it the riskiest phase. The 8-day end is realistic only if benchmarks confirm RocksDB performs adequately without surprise tuning.

### Phase 6 — Data migration tooling

One-shot conversion: read libmdbx env, write RocksDB env. Three tools, one per env.

Approach: standalone binaries `nefarious-mdbx2rocks-{history,metadata,webpush}` linked against **both** backends. Open libmdbx env read-only, open RocksDB env, walk each DBI, write each KV into the corresponding CF (with reply_index re-keyed as in Phase 5).

Operator workflow:
1. Stop ircd.
2. Run conversion tools (background OK; estimate: ~10 min per GB).
3. Move libmdbx files aside (don't delete).
4. Update `ircd.conf` paths if needed.
5. Start ircd built with RocksDB backend.
6. Sanity-check via `/STATS M` and a CHATHISTORY query.
7. After a soak period, delete libmdbx files.

Alternative considered and rejected: dual-write during a transition window. Doubles every write, requires two open envs, and for a feature where we control both sides of the upgrade (operators we know personally) it's not worth the complexity.

**Effort**: 3-5 person-days. Confidence medium-high. Mechanical, but DUPSORT re-keying must be validated end-to-end (replied-to messages still resolvable post-migration).

### Phase 7 — Drop the libmdbx backend

Delete `db_mdbx.c`. Remove `--with-mdbx*` from configure. Remove libmdbx COPY from Dockerfile. Rename `m_mdbx.c` → `m_store.c` and `/MDBX` oper command → `/STORE` (with `/MDBX` kept as alias for one release).

Optionally simplify the abstraction layer if RocksDB-specific knobs (column families, block cache) want to leak through — but probably not worth it; the abstraction has value if a third migration ever happens.

**Effort**: 1-2 person-days. Confidence high.

## Risks called out

**1. C++ runtime in a C codebase** — Real but bounded. `rocksdb/c.h` catches all exceptions and converts to `errptr`. The link-time risk is libstdc++ version pinning across the build/runtime image boundary. **Mitigation**: Phase 1 builds and runs a hello-world `rocksdb_open()` C program in the actual runtime image before merging. Ceph and TiKV ship C consumers of librocksdb in production; this is well-trodden.

**2. Performance regression on chathistory hot path** — Real. LSM has higher write-amp than B-tree (4-30x typical at `kZSTD` + level compaction). For our scale (peak ~1000 msg/sec on the busiest deploys, ~2KB serialized per msg), worst-case write throughput burden is ~60MB/sec to disk after amplification. SSDs handle this trivially; HDDs would suffer. **Mitigation**: Phase 5 benchmark, with a "no-go" gate on p99 store latency > 10ms. Tune `level0_file_num_compaction_trigger`, `max_background_compactions`, `target_file_size_base` if needed.

**3. DUPSORT migration data correctness** — Real. The reply_index drives reactions/redacts/context-resolution; getting it wrong breaks IRCv3 features silently. **Mitigation**: Phase 6 tool emits a full diff report (count of source DBI entries vs count of CF entries with target prefix), and Phase 5 ships with a unit test that round-trips a message-with-replies through the new key shape.

**4. Operational tuning unknowns** — Real. Operators familiar with libmdbx's "one file, one mapsize, one defrag" model will encounter RocksDB's "many SSTs, level compaction, write stalls under pressure." **Mitigation**: ship a `doc/readme.rocksdb` with: how to read `STATS M` output, what to do if `rocksdb.num-running-compactions` stays high, when to manually `CompactRange` vs leave it alone. Default tuning should be conservative (small write buffers, aggressive compaction) — operators only need to tune if they hit problems.

**5. Binary footprint** — `librocksdb.so` is ~10MB. Docker image grows accordingly. Probably fine for our deployment model but worth flagging.

**6. Crash recovery semantics** — RocksDB WAL is fundamentally durable: on `sync = false`, OS-page-cache loss can lose the last few writes but never corrupts the DB (WAL replay on next open). libmdbx's MVCC + checksummed pages give a similar guarantee via different mechanism. **Mitigation**: Phase 5 includes a `kill -9 ircd` test with a `dd if=/dev/zero of=/proc/sys/vm/drop_caches` style invalidation, verify DB opens cleanly with at-most-N-second data loss.

**7. License** — RocksDB is dual-licensed Apache-2.0 / GPL-2. Nefarious is GPL-2-or-later. **Compatible** — link via the GPL-2 grant. (Apache-2.0 is also forward-compatible with GPL-3 if Nefarious ever moves there.) No friction.

## Effort estimate

| Phase | Days (best–worst) | Confidence | Notes |
|---|---|---|---|
| 0. Abstraction layer | 4–7 | high | Mechanical wrapping. Independently shippable. |
| 1. Build system | 1–2 | medium-high | C++ link risk in Dockerfile. |
| 2. RocksDB backend impl | 5–9 | medium | DUPSORT translation lives here. |
| 3. Pilot (webpush_store) | 2–3 | high | Smallest module. |
| 4. metadata.c migration | 4–6 | medium | Cache-layer rip-out is a net code reduction. |
| 5. history.c migration | 8–14 | low-medium | Hot path. Benchmark gates merge. |
| 6. Data migration tools | 3–5 | medium-high | DUPSORT re-keying must be validated. |
| 7. Drop libmdbx | 1–2 | high | Cleanup. |
| **Total** | **28–48 days** | | ~5–10 working weeks of one engineer. |

The wide range is dominated by Phase 5: if the benchmark says "RocksDB just works," it's the low end. If it says "we need to redesign the on-disk key shape to play well with bloom filters," the upper end (or higher) is realistic.

## Decision support: is it worth it?

**Cost of doing nothing (stay pinned at 6b2501db)**:
- Zero engineering cost today.
- Accepts that we never get bug fixes, never get performance improvements, never can audit upstream changes.
- If a CVE drops in libmdbx and only MithrilDB has the fix, we're stuck either back-porting blind (no internal docs available) or doing this migration in a hurry.
- Build dependency is a frozen tarball we vendor — increasingly weird as years pass.

**Cost of full migration (Phases 0–7)**: 28–48 days, with the tail risk that Phase 5 benchmarks come back disappointing and require additional tuning work.

**Cost-vs-value asymmetry by phase**:

| Phase | Cost | Value if we stop here |
|---|---|---|
| 0 only | 4–7 days | Hedge: clean swap point if we ever need to migrate fast. **Strongly recommend doing this regardless.** |
| 0+1 | 5–9 days | Hedge + RocksDB build feasibility proven. Modest. |
| 0+1+2+3 | 12–21 days | One module on RocksDB, both compile, abstraction proven. **Useful but awkward** — you don't want webpush on RocksDB while history is on libmdbx long-term. |
| Through Phase 5 | 24–41 days | Off libmdbx for everything except the migration tooling. |
| Through Phase 7 | 28–48 days | Done. |

**Recommendation framing**:

- **Do Phase 0 unconditionally.** It's cheap (≤ 1 work-week), it cleans up the codebase (consolidates ~250 scattered libmdbx calls behind one API), and it gives us the option to migrate later without it being a bigger project than today. Treat Phase 0 as "good engineering hygiene we'd want anyway, with a side effect of reducing future migration cost by ~50%."

- **Plan to commit to Phases 1–7**, but sequenced so each phase is independently shippable and can be paused. The "wait and see" framing was too soft given the actual context: the supply-chain risk has already been externally flagged once, and there is no distro packaging to fall back to if we ever need to drop the vendored build. The triggering events I'd want to wait for have effectively already occurred:

  1. ~~Supply-chain concern materializes externally~~ → already happened (the scanner finding that prompted this work).
  2. ~~Distro packaging gap~~ → permanent state, not a future risk. Every other dependency in our Dockerfile is `apt install`; libmdbx is the lone source-build outlier.
  3. A libmdbx CVE we cannot get a fix for — still in "wait and see" territory, but the closed-tests posture makes any future bug investigation harder.

- **Realistic sequencing**: Phase 0 first (~1 work-week), then Phase 1+2 to prove the build works (~1-2 weeks), then Phase 3 pilot (~3 days). Pause after Phase 3 to evaluate whether the abstraction holds up in practice; if it does, commit to Phases 4–7 over the following months. If it doesn't, we've spent ~3 weeks and still have the abstraction-layer hedge.

The full migration is sound engineering and would result in a more maintainable codebase (drop park/unpark, drop FNV cache, drop MAP_FULL retry ladders), plus drops the only source-build dependency in the Dockerfile. The investment is real but the alternative is "remain the only project on the network that vendors a Russian-developed unpackaged C dependency." That's a posture that gets harder to defend over time, not easier.

### Critical Files for Implementation

- `/home/ibutsu/testnet/nefarious/ircd/history.c`
- `/home/ibutsu/testnet/nefarious/ircd/metadata.c`
- `/home/ibutsu/testnet/nefarious/ircd/webpush_store.c`
- `/home/ibutsu/testnet/nefarious/configure.in`
- `/home/ibutsu/testnet/nefarious/Dockerfile`
