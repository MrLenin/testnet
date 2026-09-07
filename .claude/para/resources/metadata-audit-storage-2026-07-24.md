# METADATA subsystem audit — storage & lifecycle half

Tree audited: `/home/ibutsu/testnet/nefarious-crdt` (crdt-mesh branch checkout). All paths below are relative to that root unless absolute.
Era tags: [ERA1] X3-authoritative + per-node MDQ cache; [ERA2] ircd-authoritative RocksDB; [F2B] CRDT-doc convergence (users only).
Status tags: [LIVE] has callers and works; [DEAD] zero callers; [VESTIGIAL] reachable only via a retired era's traffic; [BROKEN] reachable but wrong.

---

## 1. Layer inventory

### Layer A — in-memory lists

Fields: `cli_metadata` (`include/client.h:576`, accessor `:778`), `cli_metadatasub` (`client.h:577`), rate-limit fields (`client.h:578-579`); `chptr->metadata` (`include/channel.h:417`). Entry struct `MetadataEntry` (`include/metadata.h:51-56`) carries `visibility` in memory only.

**Writers**
| Function | Loc | Era | Status | Notes |
|---|---|---|---|---|
| `create_entry` (static) | `ircd/metadata.c:1094` | ERA1 | LIVE | defaults `visibility=PUBLIC` |
| `metadata_set_client` | `ircd/metadata.c:1285` | ERA2 | LIVE | memory write + store write for authed users (`:1327` permanent set, `:1341` delete); umode-flag sync table `:1261-1275`, applied `:1346-1368` |
| `metadata_set_channel` | `ircd/metadata.c:1558` | ERA2 | LIVE | **memory only — never touches the store** |
| `metadata_load_account` | `ircd/metadata.c:1494` | ERA2 | LIVE | store→memory eager fill at account attach (frees old list `:1512`, assigns `metadata_account_list` result `:1517`) |
| store→memory promotion in `metadata_get_client` | `ircd/metadata.c:1239-1251` | ERA2 | LIVE | lazy fill, `create_entry` direct (deliberately does NOT re-persist), marks entry `VIS_PRIVATE` `:1245` |
| store→memory promotion (user GET) | `ircd/m_metadata.c:503-506` | ERA1 | LIVE | via `metadata_set_client` → **re-persists permanently + mirrors into doc** (see §2) |
| store→memory promotion (channel GET) | `ircd/m_metadata.c:549-553` | ERA1 | LIVE | via `metadata_set_channel` (memory only) |
| `ms_metadata` S2S apply | `ircd/m_metadata.c:1584-1588` | ERA2 | LIVE | under doc-mirror suspend `:1580/:1638` |
| `metadata_clear_client` | `ircd/metadata.c:1420` | ERA2 | LIVE | frees list + wipes store (`metadata_account_clear`) |
| `metadata_clear_channel` | `ircd/metadata.c:1619` | ERA2 | LIVE | memory only |
| `metadata_free_client` | `ircd/metadata.c:1523` | ERA2 | LIVE | disconnect path (`ircd/list.c:469`); store untouched |
| `metadata_free_channel` | `ircd/metadata.c:1652` | ERA2 | LIVE | channel destruction (`ircd/channel.c:468`) |
| `metadata_free_entry` / `free_entry_list` | `ircd/metadata.c:1123` / `:1135` | — | LIVE | |

**Readers**
| Function | Loc | Era | Status | Notes |
|---|---|---|---|---|
| `metadata_get_client` | `ircd/metadata.c:1151` | ERA2 | LIVE | virtual presence/`away_message`/`last_present` keys `:1159-1220` (FEAT_PRESENCE_AGGREGATION; **shared static buffers** `presence_entry`/`presence_value` `:72-73`), memory scan `:1223-1226`, then store promotion `:1239` |
| `metadata_list_client` | `ircd/metadata.c:1377` | ERA1 | LIVE | memory only; callers: LIST `m_metadata.c:916`, CLEAR-broadcast `:988`, SYNC `:1116`, join-notify `:282`, WHOIS `ircd/m_whois.c:256`, self-burst `metadata.c:1394` |
| `metadata_get_channel` | `ircd/metadata.c:1536` | ERA1 | LIVE | memory only; also `ircd/m_history.c:201` |
| `metadata_list_channel` | `ircd/metadata.c:1609` | ERA1 | LIVE | memory only |
| `metadata_count_client` / `metadata_count_channel` | `ircd/metadata.c:1472` / `:1632` | ERA2 | LIVE | limit checks `m_metadata.c:627/:631` |
| `metadata_burst_self_to_client` | `ircd/metadata.c:1384` | ERA2 | LIVE | client-facing BATCH; callers `ircd/s_user.c:721` (register_user), `s_user.c:547` (ghost revive), `ircd/bouncer_session.c:7997` (alias attach) |
| inline S2S user-metadata netburst | `ircd/s_serv.c:545-553` | ERA2 | LIVE | reads `cli_metadata` directly; gated `FEAT_METADATA_BURST` (default 1, `ircd/ircd_features.c:1280`) + `IsIRCv3Aware` |
| inline S2S channel-metadata netburst | `ircd/channel.c:1645-1653` | ERA2 | LIVE | reads `chptr->metadata` directly, same gates |
| `metadata_send_join_notifications` | `ircd/m_metadata.c:268` | ERA1 | LIVE | caller `ircd/channel.c:5519` |
| subscription API `metadata_sub_add/del/check/list/count/free` | `ircd/metadata.c:1680-1795` | ERA1 | LIVE | `sub_free` also on CAP disable `ircd/m_cap.c:675/:711`; memory-only, session-scoped |
| `ms_metadataquery` channel branch | `ircd/m_metadata.c:1352-1376` | ERA1 | VESTIGIAL | see §4 (MDQ) |

### Layer B — RocksDB `metadata_cf` store (env shared with `readmarkers_cf`, `bouncer_sessions`)

Env/CF handles `ircd/metadata.c:85-88`; key format `account\0key` (`build_lmdb_key` `:112`); TTL wrapper `T<ts>|value` (`encode_ttl_value` `:142`, `decode_ttl_value` `:166`, `is_value_expired` `:215`); optional zstd (magic check `ircd/ircd_compress.c:38`).

**Writers**
| Function | Loc | Era | Status | Notes |
|---|---|---|---|---|
| `metadata_account_set_ts` (static chokepoint) | `ircd/metadata.c:419` | ERA2/F2B | LIVE | TTL-encode + compress; on commit calls `crdt_shadow_metadata_set` `:482` (doc mirror, permanent = ts==0) |
| `metadata_account_set` (TTL = CurrentTime) | `ircd/metadata.c:490` | ERA1 | LIVE | callers: last_present persist `ircd/account_conn.c:465`; oper offline `*account` SET `m_metadata.c:783`; S2S **channel** cache `m_metadata.c:1631`; profile deletes `ircd/persistence_profile.c:235/322/414`; doc-reap delete `ircd/crdt_shadow.c:2395`; wrapped by `metadata_channel_persist` `metadata.c:902` |
| `metadata_account_set_permanent` | `ircd/metadata.c:498` | ERA2 | LIVE | callers: `metadata_set_client` `metadata.c:1328`; doc heal `crdt_shadow.c:2335`; profiles `persistence_profile.c:234/383/405` |
| `metadata_account_set_raw` | `ircd/metadata.c:511` | ERA1 | VESTIGIAL | only callers = Z-passthrough `m_metadata.c:1616/:1618`; no TTL wrapper; see §4 |
| `metadata_account_clear` | `ircd/metadata.c:773` | ERA2/F2B | LIVE | prefix-scan delete + per-key doc tombstone `:817`; callers: `metadata_clear_client` `metadata.c:1436` only |
| `metadata_account_purge_expired` | `ircd/metadata.c:918` | ERA1 | LIVE | TTL sweep; timer `ircd/ircd.c:1237` (TT_PERIODIC, FEAT_METADATA_PURGE_FREQUENCY default 3600), callback `ircd.c:895` gated on FEAT_METADATA_CACHE_ENABLED `:900` + TTL>0 `:907`; re-arm `ircd.c:878` / `ircd_features.c:735` |
| `metadata_readmarker_set` | `ircd/metadata.c:622` | ERA2 | LIVE | `readmarkers_cf`, newer-wins; callers `ircd/m_markread.c:363/445`, doc reconcile `crdt_shadow.c:2200` |
| `metadata_channel_persist` | `ircd/metadata.c:900` | ERA2 | **DEAD** | zero callers, zero declarations (grep across `include/` + `ircd/*.h` empty) |

**Readers**
| Function | Loc | Era | Status | Notes |
|---|---|---|---|---|
| `metadata_account_get` | `ircd/metadata.c:339` | ERA2 | LIVE | decompress + TTL-decode + expiry filter `:380-403`; ~25 call sites (m_metadata GET/MDQ/limits, account_conn last_present, persistence_profile, bouncer hold-pref reads `bouncer_session.c:841/1071/5464/6573`, `m_bouncer.c:853/985`, `m_persistence.c:94/123/588`, doc echo-guard `crdt_shadow.c:2332`) |
| `metadata_account_list` | `ircd/metadata.c:674` | ERA2 | LIVE | prefix iterate; TTL-decode + expiry skip `:745-753` (fdf93a5 fix); **all entries forced `VIS_PUBLIC`** `:759`; callers: `metadata_load_account` `:1516`, offline-target probe `m_metadata.c:407`, MDQ `* ` `m_metadata.c:1388`, profiles `persistence_profile.c:271/319/363/439`; wrapped by dead `metadata_channel_load` `:911` |
| `metadata_account_count_keys` | `ircd/metadata.c:837` | ERA2 | LIVE | one caller `m_metadata.c:754`; counts TTL rows without expiry check (documented approximation `:829-832`) |
| `metadata_account_foreach_key` | `ircd/metadata.c:999` | F2B | LIVE | raw key walk for doc delete-reconcile; caller `crdt_shadow.c:2381` |
| `metadata_readmarker_get` | `ircd/metadata.c:584` | ERA2 | LIVE | `m_markread.c:377/404/488`, `replay.c:383`, `m_chathistory.c:4190` |
| `metadata_channel_load` | `ircd/metadata.c:909` | ERA2 | **DEAD** | **confirmed zero callers** (grep over all `ircd/*.c`, `include/*.h`, `ircd/test/*` — only its own definition + the `!USE_ROCKSDB` stub `:1038`) |

**Env plumbing**: `metadata_lmdb_init` `metadata.c:227` [LIVE, `ircd/ircd.c:130/:1348`, threaded init, path = FEAT_METADATA_DB `ircd.c:1344`]; `metadata_lmdb_is_available` `:328` [LIVE, everywhere]; `metadata_get_env`/`metadata_get_bouncer_cf` `:300/:306` [LIVE, bouncer persistence piggyback `bouncer_session.c:428-429/3063-3064/3204-3205/3455-3456`]; `metadata_lmdb_shutdown` `:312` [**DEAD** — only caller is `metadata_shutdown` `:1053` which itself has zero callers → env is never closed on exit]; stats/maintenance: `metadata_report_stats` `:1874` [LIVE `s_stats.c:741`], `metadata_report_defrag` `:1942` [LIVE `m_store.c:104`], `metadata_sync` `:1961` [LIVE `m_store.c:136`], `metadata_report_gc` `:1970` [LIVE `m_store.c:166`], `metadata_report_store_info` `:1995` [LIVE `m_store.c:191`], `metadata_defrag` `:1926` [**DEAD** — zero callers; `/STORE DEFRAG` uses `metadata_report_defrag`'s own `db_env_compact` instead].

### Layer C — CRDT doc (`g_crdt.metadata`, users only)

Collection `include/crdt_state.h:362`; doc key = the storage key byte-for-byte (`account\0metakey`).

| Function | Loc | Era | Status | Notes |
|---|---|---|---|---|
| `metadata_doc_key` (static) | `ircd/crdt_shadow.c:2233` | F2B | LIVE | **channels excluded: `IsChannelName(account) → return 0`** `:2242` — confirmed |
| `crdt_shadow_metadata_set` | `ircd/crdt_shadow.c:2257` | F2B | LIVE | mirror from `metadata_account_set_ts` `metadata.c:482`; only `permanent` SETs enter doc (`:2268-2270` TTL sets skipped); delete only if doc-present `:2274-2278`; gates `shadow_on`/`g_metadata_reconciling`/`g_metadata_remote_applying` `:2262` |
| `crdt_shadow_metadata_remove_key` | `ircd/crdt_shadow.c:2292` | F2B | LIVE | raw-key tombstone from `metadata_account_clear` `metadata.c:817` (M8 fix 30537cc) |
| `crdt_shadow_metadata_suspend` | `ircd/crdt_shadow.c:2226` | F2B | LIVE | set/cleared by `ms_metadata` `m_metadata.c:1580/:1638` (single-writer: only origin mirrors) |
| `reconcile_metadata_set_cb` | `ircd/crdt_shadow.c:2311` | F2B | LIVE | doc→store heal via `metadata_account_set_permanent` `:2335`, echo-guarded `:2332` |
| `reconcile_metadata_del_collect` | `ircd/crdt_shadow.c:2349` | F2B | LIVE | store-walk, reaps only `crdt_metadata_is_explicitly_removed` keys, cap 256/cycle `:2185` |
| `crdt_shadow_reconcile_metadata` | `ircd/crdt_shadow.c:2367` | F2B | LIVE | callers: eager delta-apply `ircd/m_crdt.c:747` + 30s verify cycle `ircd/crdt_shadow.c:5091`; deletes go through `metadata_account_set(NULL)` `:2395` |
| engine ops `crdt_metadata_set/del/is_explicitly_removed/get` | `ircd/crdt_state.c:876/894/909/915` | F2B | LIVE | LWW map; snapshot in CR F `ircd/crdt_wire.c:337`; digest salt 21 `crdt_state.c:1975/:2033` |

---

## 2. User-metadata lifecycle trace

**SET (local client, authed)** — `metadata_cmd_set` `m_metadata.c:648` → limits `:825` → `metadata_set_client` `:841` → memory (`metadata.c:1303-1322`) + store permanent (`:1327-1329`, `T0|value`, **visibility not encoded**) → doc mirror (`metadata.c:482` → `crdt_shadow.c:2257`, permanent path) → local subscriber notify `m_metadata.c:867` → S2S broadcast `:871-879` (visibility `P`/`*` on the wire). Remote server: `ms_metadata` `:1454` → suspend doc mirror `:1580` → `metadata_set_client` `:1587` (memory + store permanent on every server holding the user) → resume `:1638` → notify + relay `:1641-1662`. **Unauthed user**: memory only (`account==NULL` skips both store branches `metadata.c:1294-1295`), no doc.

**SET (oper, `*account` offline)** — `m_metadata.c:702-795`: offline branch writes `metadata_account_set` `:783` = **TTL-stamped** (expires after FEAT_METADATA_CACHE_TTL, default 14400s) and **drops the requested visibility entirely** (`visibility` used only in the echo `:792`); not doc-mirrored (TTL sets excluded `crdt_shadow.c:2269`). Online branch uses `metadata_set_client` per local connection `:777` (permanent). No S2S broadcast in either branch — other servers learn nothing.

**GET** — `metadata_cmd_get` `m_metadata.c:376`. Order: memory via `metadata_get_client` `:448` (virtual presence keys first `metadata.c:1159-1220`, then list scan `:1223`). The **three store→memory promotions**, confirmed exactly:
1. `ircd/metadata.c:1239-1251` — inside `metadata_get_client`: authed + key not `$`-prefixed + store hit → `create_entry` directly (no re-persist), entry marked `VIS_PRIVATE`. Load-bearing per its own comment `:1233-1238` (metadata_load_account is skipped by pre-reg SASL, WEBIRC, IAuth, MODE +r, bouncer-ghost, mesh-materialized attach paths).
2. `ircd/m_metadata.c:474-507` (user fallback, promotion at `:503-506`) — re-reads the store, parses a `P:` prefix that user rows never carry (see §5), then promotes via `metadata_set_client` → **side effect: re-persists the row as permanent and mirrors it into the doc**. A GET can therefore upgrade a TTL cache row (e.g. a legacy row, or an oper's offline TTL write) to permanent doc-converged state.
3. `ircd/m_metadata.c:515-556` (channel fallback, promotion at `:549-553`) — store read keyed by channel name, promotes into `chptr->metadata` (memory only).

**Account attach → `metadata_load_account`** (`metadata.c:1494`) — **all 4 callers**: `ircd/m_account.c:254` (AC `M`/`R` remote account change), `m_account.c:395` (LOC auth-id `A` path), `m_account.c:459` (legacy timestamped AC), `ircd/sasl_auth.c:622` (local SASL, **post-registration reauth branch only** — gated `IsRegistered && account differs` `:617-620`). Pre-registration local SASL, IAuth, WEBIRC, bouncer-ghost materialization do NOT call it; those clients start with empty memory and rely on promotion #1 per-key (so LIST/WHOIS/self-burst show nothing until individual GETs).

**Account detach (AC `U`, unregister/logout)** — `m_account.c:190`: `metadata_clear_client` → frees memory **and wipes every persisted store row for the account** (`metadata_account_clear`), minting doc tombstones (`metadata.c:817`) that propagate the wipe mesh-wide via the reconcile reap. In place since 0816620 (2026-01-30). Note this also deletes server-managed `draft/persistence/*` rows — the store clear is prefix-wide.

**Disconnect** — `ircd/list.c:469` → `metadata_free_client` `metadata.c:1523`: memory + subs freed, store deliberately untouched (comment `:1525`). Unauthed users' metadata dies here permanently.

**Expiry/TTL** — encode at write (`metadata.c:447`), enforced on read in `metadata_account_get` `:380-403` and `metadata_account_list` `:745-753`, and by the purge sweep `metadata_account_purge_expired` `:918` (hourly timer). **Not enforced**: the in-memory layer (a promoted entry outlives its store row's expiry until disconnect); `metadata_account_count_keys` `:837` (counts expired rows); `metadata_account_foreach_key`; permanent rows (`ts==0` → `is_value_expired` false `:217`). `last_present` is written TTL-stamped (`account_conn.c:465`) so it evaporates for accounts offline > TTL.

**Doc → local** — reconcile writes the **store only** (`crdt_shadow.c:2335/2395`); an online user's `cli_metadata` is not updated and no subscriber notify fires. Memory is consulted first on GET, so a doc-delivered change is invisible to that server's users until reattach/disconnect (the tree-side P10 MD broadcast masks this today; it becomes user-visible staleness once MR-6 retires MD among CRDT peers).

---

## 3. Channel-metadata lifecycle trace

**SET on a channel** (`metadata_cmd_set` → `metadata_set_channel` `m_metadata.c:839`, or `HISTORY SET LIMIT/QUOTA` → `ircd/m_history.c:149` + its own broadcast `:155`): writes **memory only** on the origin (`metadata_set_channel` `metadata.c:1558` has no store branch; `metadata_channel_persist` `:900` exists for exactly this and was never wired). S2S broadcast → on **remote** servers `ms_metadata` applies to memory `:1585` AND caches to the store under the channel name `:1602-1635` — but via `metadata_account_set` `:1631`, i.e. **TTL-stamped**: the only store copies of channel metadata live on non-origin servers and expire after 4h (then purged). Private channel values get a `P:` prefix there (`:1626-1627`). Doc: never (`metadata_doc_key` channel exclusion `crdt_shadow.c:2242`).

**Server restart** — `chptr->metadata` is gone; **nothing reloads channel metadata from the store**: `metadata_channel_load` (`metadata.c:909`) has **zero callers — confirmed** (grep over `ircd/`, `include/`, tests: only definition + `!USE_ROCKSDB` stub `:1038`). Channel state is re-learned only through the inline netburst from a peer that still holds it in memory (`channel.c:1645-1653`), or accidentally resurrected per-key by a `METADATA GET` hitting a remote server's un-expired TTL cache row (`m_metadata.c:515-556`). A full-network restart loses all channel metadata (including `history.limit`/`history.quota`) except what those stale TTL rows can resurrect within the window.

**Netburst** — `metadata_burst_channel` `metadata.c:1864` is a **stub — confirmed** (empty body, zero callers). The real burst is inline in `channel.c:1645-1653` (per-entry `MD` after modes/topic, gated `FEAT_METADATA_BURST` + `IsIRCv3Aware`). Same story for users: `metadata_burst_client` `:1853` stub, real code `s_serv.c:545-553`. Note `ms_metadata` drops (no apply, no cache, **no relay**) when the target channel/user is unknown locally (`m_metadata.c:1525-1531`), so mid-burst ordering matters and an intermediate hub without the channel severs propagation.

**Channel destruction** — `ircd/channel.c:468` `metadata_free_channel`: memory freed, nothing persisted, no doc. When the last member leaves, channel metadata is gone network-wide (modulo the remote TTL-cache resurrection above).

**+R / MODE_REGISTERED interplay** — **none exists**: zero `MODE_REGISTERED` references in `metadata.c`, `m_metadata.c`, `m_history.c` (grep empty). Channel-metadata lifetime is tied purely to the in-memory channel object; registered status neither persists metadata nor gates it.

---

## 4. Dead / vestigial inventory (storage side)

Zero-caller functions (grep across `ircd/*.c`, `include/*.h`, `ircd/test/*`, excluding own definition/declaration):

| Symbol | Loc | Era | Verdict |
|---|---|---|---|
| `metadata_channel_load` | `metadata.c:909` | ERA2 | DEAD — 0 callers, not even declared in any header; the intended restart-reload path, never wired (born 92ea12a) |
| `metadata_channel_persist` | `metadata.c:900` | ERA2 | DEAD — 0 callers, undeclared; the intended channel-SET store write, never wired |
| `metadata_get_client_cached` | `metadata.c:1805` | ERA1 | DEAD — 0 callers (declared `metadata.h:362`); its "cache-through" job was absorbed by `metadata_get_client`'s internal promotion |
| `metadata_burst_client` | `metadata.c:1853` | ERA1 | DEAD stub — 0 callers; real burst inline `s_serv.c:545` |
| `metadata_burst_channel` | `metadata.c:1864` | ERA1 | DEAD stub — 0 callers; real burst inline `channel.c:1645` |
| `metadata_init` / `metadata_shutdown` | `metadata.c:1047/:1053` | ERA1 | DEAD — 0 callers each; consequence: `metadata_lmdb_shutdown` `:312` is unreachable and the RocksDB env is never closed on process exit |
| `metadata_defrag` | `metadata.c:1926` | ERA2 | DEAD — 0 callers (declared `metadata.h:395`); `/STORE` uses `metadata_report_defrag` instead |
| `metadata_valid_key` | `metadata.c:1064` | ERA1 | DEAD — 0 callers; the live validator is the *static* `is_valid_key` `m_metadata.c:107`, and the two **diverge** (dead one allows `:`; live one does not) |
| `parse_visibility` | `m_metadata.c:579` | ERA1 | DEAD static — 0 uses; `metadata_cmd_set` parses visibility inline `:675-691` |

Vestigial / write-only / read-only paths:

- **MDQ (`ms_metadataquery`)** `m_metadata.c:1319`, registered `ircd/parse.c:1038-1042` — [ERA1] VESTIGIAL receive-only: **zero in-tree senders** of `CMD_METADATAQUERY` (grep empty); kept for a legacy X3 that might still pull. Its channel branch reads memory only and its own comment `:1377-1378` is confused about the store schema.
- **Z compressed passthrough** (`ms_metadata` parse `:1496-1499`, decode `:1513-1520`, store `:1608-1622`, relay `:1649`) — [ERA1] VESTIGIAL: no originator anywhere in-tree (the only `"Z :%s"` emitter is the relay itself), so the chain can never start. Inside it, the private variant `metadata_account_set_raw("P:"+zstd)` `:1611-1616` is [BROKEN-if-reached]: the stored blob starts `P:` not the zstd magic, so `metadata_account_get` `:367-368` takes the uncompressed path and returns `P:<binary zstd>` as the value. `base64_decode` `m_metadata.c:79` and `metadata_account_set_raw` `metadata.c:511` exist solely for this path.
- **ERA1 feature flags**: `FEAT_METADATA_CACHE_SLOTS` (`ircd_features.h:429`, default `ircd_features.c:1284`) — **zero readers** since the mdbx B-tree cache was retired (comment `metadata.c:99-103`); VESTIGIAL. `FEAT_METADATA_CACHE_ENABLED` — two readers: the DEAD `metadata_get_client_cached` `:1815` and the purge-timer gate `ircd.c:900`; so today its only real effect is *disabling the TTL purge sweep* — semantics drifted far from its name. `FEAT_METADATA_CACHE_TTL` / `FEAT_METADATA_PURGE_FREQUENCY` remain LIVE (TTL wrapper + sweep). **`FEAT_METADATA_X3_TIMEOUT` and `FEAT_METADATA_QUEUE_SIZE` no longer exist in this tree** (removed in e16c222; grep empty).
- **`P:` visibility-prefix parsing on user account rows** (`m_metadata.c:481-496`) — read path for data no write path produces anymore (user store rows are written prefix-less via `metadata_account_set_permanent`); only pre-e16c222 legacy rows or the dead Z path could produce it. VESTIGIAL for users, LIVE for channel rows (`:525-543`, written at `:1626-1627`).
- **Header decoys**: `metadata.h` still declares the dead `metadata_get_client_cached` (`:362`), `metadata_burst_client/channel` (`:372/:378`), `metadata_defrag` (`:395`), `metadata_valid_key` (`:173`), `metadata_init/shutdown` (`:65/:68`), and carries the ERA-transition tombstone comments `:364` ("X3 dependency removed") and `:380` ("MDQ removed - Nefarious answers GET from local LMDB only" — the MDQ *handler* is in fact still registered).

---

## 5. Persistence gaps — what survives a restart

| State | Memory | Store (`metadata_cf`) | CRDT doc |
|---|---|---|---|
| **User, authed, normal SET** | lost at restart/disconnect; rebuilt fully only via the 4 `metadata_load_account` sites; per-key lazily via promotion `metadata.c:1239` on other attach paths (LIST/WHOIS/self-burst stay empty until then) | **survives** (`T0\|` permanent, every server holding the user at SET time) | **survives & converges** (F2B); reconcile re-heals the store |
| **User, unauthed (ephemeral)** | only copy; dies at disconnect (`list.c:469`) and restart | never written (`metadata.c:1294` gate) | never |
| **User, oper offline `*account` SET** | n/a | written **TTL-stamped** `m_metadata.c:783` → gone after FEAT_METADATA_CACHE_TTL (default 4h) + purge | no (TTL sets excluded) |
| **`last_present`** | virtual key from bouncer session | TTL-stamped `account_conn.c:465` → lost for accounts offline > TTL | no |
| **Channel** | per-server; origin has memory only; lost when channel destructs or server restarts | **origin: never written.** Remote receivers only, TTL-stamped `m_metadata.c:1631` → purged in ~4h; nothing ever reloads it (`metadata_channel_load` dead) except the GET resurrection `m_metadata.c:515` | **never** (`crdt_shadow.c:2242`) |
| **Read markers** | n/a | survives (`readmarkers_cf`, no TTL wrapper) | survives (F2-a) |

**Visibility flag: effectively NOT persisted for users.** The store has no visibility column; the only encoding is the ad-hoc `P:` value prefix, which the current user write paths never emit (`metadata_set_client` → `metadata_account_set_permanent(account, key, value)` `metadata.c:1328` stores the bare value; the oper offline path also drops it). Consequences, each with its own contradictory guess at reload time:
- `metadata_account_list` (backs `metadata_load_account` and MDQ) hardcodes **`VIS_PUBLIC`** for every row (`metadata.c:759`) → a private key set before a restart comes back public on reattach.
- the `metadata_get_client` promotion hardcodes **`VIS_PRIVATE`** (`metadata.c:1245`) → conservative, but then...
- the `metadata_cmd_get` fallback (`m_metadata.c:474-507`) re-reads the same raw row, sees no `P:`, treats it as **public**, serves it to any viewer, and rewrites the in-memory entry `VIS_PUBLIC` — so even the conservative default is undone by the second lookup path. Net: "private" user metadata is a single-session, single-server property; it does not survive restart, reattach, or even a third-party GET on a restarted server. Channel rows do carry `P:` in the remote TTL cache (`m_metadata.c:1626`), making channels the only place visibility half-persists.

Other gaps: doc→store heal never touches live clients' memory or notifies subscribers (§2 end); `ms_metadata`'s unknown-target early-return drops S2S updates for the whole downstream subtree (`m_metadata.c:1526-1531`); the store is never closed at shutdown (unreachable `metadata_lmdb_shutdown`), relying on RocksDB WAL recovery.

---

## 6. Git era-dating (`git log --follow -- ircd/metadata.c`)

| Date | Commit | Marker |
|---|---|---|
| 2025-12-24 | `f823288` | birth: "Add draft/metadata-2 implementation" (memory only) |
| 2025-12-24 | `92ea12a` | "Add LMDB persistence for metadata-2" — **introduces `metadata_channel_load`/`metadata_channel_persist` (confirmed via pickaxe), already unwired** |
| 2025-12-24 | `a3cea43` | "metadata visibility storage support" (the `P:` prefix scheme) |
| 2025-12-24 | `ca033ea` / `fdd0c93` | ERA1 apex: "cache-aware metadata with X3 detection and write queue", "Complete MDQ flow with multi-hop routing" (X3_TIMEOUT/QUEUE_SIZE flags born) |
| 2025-12-24 | `6de2af3` | TTL-based cache expiry (the `T<ts>\|` wrapper) |
| **2026-01-26** | **`e16c222`** | **ERA1→ERA2 transition: "Make Nefarious authoritative for metadata/read markers/presence"** — removes MDQ sends + X3_TIMEOUT/QUEUE_SIZE, adds the "Nefarious is authoritative" comments (pickaxe-confirmed on all three) |
| 2026-01-30 | `0816620` | `*account` oper targets + the AC `U` `metadata_clear_client` wipe |
| 2026-01-31 | `856c7e7` | libmdbx migration; MARKREAD moves into the metadata env |
| 2026-05-04 | `a319a51` (+ `24484d2`, `802d564`) | Phase 7: db_* abstraction + RocksDB rename |
| **2026-06-29** | **`81f70b4`** | **F2B era: "Tier C F2-b (metadata / MD): converge permanent account metadata over the mesh"** |
| 2026-07-22 | `5f62495` | F-M6: limits enforced on oper + S2S write paths |
| 2026-07-23 | `30537cc` | M8 fix: doc tombstone on CLEAR |
| 2026-07-24 | `fdf93a5` | CLEAR → per-key S2S unsets; `metadata_account_list` TTL-decode (the two pre-acknowledged fixes) |

---

## Surprises (vs. the briefing context)

1. **`FEAT_METADATA_X3_TIMEOUT` and `FEAT_METADATA_QUEUE_SIZE` are already gone** from this tree (removed in `e16c222`, 2026-01-26). The surviving ERA1 flags are `CACHE_TTL` (live), `CACHE_ENABLED` (semantics drifted to "purge-sweep enable"), `CACHE_SLOTS` (zero readers).
2. **MDQ is not fully removed**: `ms_metadataquery` is still registered (`parse.c:1038`) and answers, even though nothing in-tree sends MDQ and `metadata.h:380` claims "MDQ removed".
3. **Netburst is NOT the stubs**: `metadata_burst_client/channel` are decoys; real per-entry MD burst is inline in `s_serv.c:545` and `channel.c:1645`, gated on `FEAT_METADATA_BURST` (default ON) + `IsIRCv3Aware`. So channel metadata *does* cross a netburst — restart recovery of channel metadata exists, but only peer-memory-shaped, never store-shaped.
4. **The briefing's "metadata_load_account eagerly loads at account-attach" is only quarter-true**: exactly 4 call sites; the pre-registration SASL/IAuth/WEBIRC/ghost paths skip it by design and lean on the lazy GET promotion (`metadata.c:1233-1238` documents this as load-bearing) — leaving LIST/WHOIS/self-burst empty after restart until keys are individually GETted.
5. **The m_metadata.c GET promotion is a write path in disguise**: `m_metadata.c:503` re-persists whatever it finds as *permanent* and doc-mirrors it — a GET can promote a TTL cache row (oper offline write, legacy row) into permanent, mesh-converged state.
6. **Channel store rows are only ever written by *non-origin* servers, TTL-stamped** (`m_metadata.c:1631` via ms_metadata): the origin keeps memory only, remote copies self-destruct in ~4h, and the sole reader that could restore them at boot (`metadata_channel_load`) is dead. The channel store layer is a cache of somebody else's channel that nobody reloads — except the accidental per-key GET resurrection.
7. **Visibility is lost at the store boundary for users**, and the three reload paths disagree (list→PUBLIC, metadata.c promotion→PRIVATE, m_metadata.c fallback→PUBLIC + serves it) — "private" does not survive restart and can be undone by a third-party GET (§5).
8. **AC `U` (unregister/logout from services) permanently wipes all persisted metadata for the account** and, on this branch, tombstones it in the doc (`m_account.c:190` → `metadata_account_clear` → `crdt_shadow.c:2292`) — mesh-wide destruction on what X3 also emits at ordinary logout; and the prefix-wide store clear takes server-managed `draft/persistence/*` rows with it.
9. **The metadata RocksDB env is never closed**: `metadata_shutdown`/`metadata_lmdb_shutdown` are unreachable (zero callers).
10. **Doc reconcile heals the store but not live memory**: no `cli_metadata` update, no subscriber notify — invisible today because P10 MD still broadcasts, but it becomes the user-visible staleness surface once MR-6 retires MD among CRDT peers.
11. Minor: the dead `metadata_valid_key` and the live static `is_valid_key` disagree on `:` in key names; `parse_visibility` is a dead static; `ircd/metadata.o`/`m_metadata.o` build artifacts sit in the source dir.
