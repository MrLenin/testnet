# METADATA subsystem audit — protocol/wire/CRDT half

Tree: `/home/ibutsu/testnet/nefarious-crdt` @ `fdf93a5` ("metadata: propagate CLEAR as per-key S2S unsets; TTL-decode account_list").
All paths relative to that root unless absolute. Tags: [ERA1] Keycloak/X3-authoritative pull-cache, [ERA2] ircd-authoritative RocksDB, [F2B] CRDT-doc convergence (users only); [LIVE]/[DEAD]/[VESTIGIAL]/[BROKEN].

---

## 1. Client-facing handlers (m_metadata.c)

Dispatch: `m_metadata` `ircd/m_metadata.c:1252`. Registered in `ircd/parse.c:1030-1036` as `{ m_unregistered→m_metadata, CLIENT m_metadata, SERVER ms_metadata, OPER m_metadata, SERVICE m_ignore }` (actually `{ m_metadata, m_metadata, ms_metadata, m_metadata, m_ignore }`). Wire shape is draft/metadata-2: `METADATA <target> <subcommand> [args]` (parv[1]=target, parv[2]=subcmd, `m_metadata.c:1268-1276`).

Gates before dispatch:
- CAP gate: `CapActive(sptr, CAP_DRAFT_METADATA2)` else numeric 421 ERR_UNKNOWNCOMMAND (`:1257-1259`). CAP itself only advertised when `FEAT_CAP_draft_metadata_2` (default **FALSE**, `ircd/ircd_features.c:1213`).
- Rate limit: `check_metadata_rate_limit` `:1213-1239` — token/second via `FEAT_METADATA_RATE_LIMIT` (10/s), opers exempt, counters in `cli_metadata_lastcmd/cli_metadata_cmdcnt` (`include/client.h:578-579`). Over limit → `FAIL METADATA RATE_LIMITED` (`:1263`).
- Unknown subcmd → `FAIL METADATA SUBCOMMAND_INVALID` (`:1295-1297`).

### GET — `metadata_cmd_get` `:376-573` [ERA2][LIVE]
Layers touched, in order per key:
1. Target resolution `can_see_target` `:139-166` (channel must exist; `*` = self; user via `FindUser`). Nonexistent channel → `FAIL METADATA INVALID_TARGET` (`:401`). Nonexistent user: probes the store via `metadata_account_list(target)` treating target as an **account name** (`:406-420`); no rows → `FAIL INVALID_TARGET` (`:417,422`).
2. Replies wrapped in `BATCH metadata` (`send_batch_start` `:429`, end `:570`).
3. Key validation `is_valid_key` `:107-129` → `FAIL KEY_INVALID` (`:438`).
4. In-memory lookup: `metadata_get_channel`/`metadata_get_client` (`:446-449`); visibility filter `can_view_metadata` `:319-338`; hit → 761 RPL_KEYVALUE via `send_keyvalue` `:355-366` (`*` expanded to own nick).
5. **Store fallthrough (user)** `:461-509`: account = `cli_account` for online, or the raw target for offline; `metadata_account_get` `:475`; parses stored `P:` visibility prefix `:481-484` with owner/oper check `:487-496`; **promotes store row into live memory** via `metadata_set_client` `:503-506` (the M8 promotion — benign now only because CLEAR removes remote store rows first, see `ircd/metadata.c:1232-1238`).
6. `:511` — **"Nefarious is authoritative - no X3 query, just report not set"** — marks the removed [ERA1] MDQ send for users.
7. **Store fallthrough (channel)** `:514-556`: `metadata_account_get(target,…)` keyed by channel name; `P:` prefix → chanop/oper only `:531-543`; promotes into `metadata_set_channel` `:550-553`.
8. `:558` — second **"Nefarious is authoritative - no X3 query"** marker (channels).
9. Miss → 766 RPL_KEYNOTSET `:561-567`.

S2S: **none** (GET never leaves the node). [VESTIGIAL] residue: the function header `:368-374` still documents the ERA1 flow "3. If not in LMDB, send MDQ to X3 (response will be async)".

### SET — `metadata_cmd_set` `:648-882` [ERA2+F2B][LIVE]
- parc<4 → `FAIL INVALID_PARAMS` `:660`. Visibility parsing (`*`|`private`|implicit) `:675-691`. `is_valid_key` → `FAIL KEY_INVALID` `:693`.
- **Oper `*account` branch** `:702-795`: target `*<name>` (not bare `*`) = direct store write, oper-only (`FAIL KEY_NO_PERMISSION` `:706`), storage-unavailable → `FAIL INTERNAL_ERROR` `:713`. Applies limits (`metadata_check_limits` `:603-635` + persisted-row count `metadata_account_count_keys` `:753-755`) → `FAIL VALUE_INVALID`/`LIMIT_REACHED` `:758-768`. If any LOCAL client is on the account → `metadata_set_client` per client `:771-780` (permanent row + doc mirror); else offline → `metadata_account_set` `:783` which is a **TTL-stamped** write (`ircd/metadata.c:490-493`) — expires after CACHE_TTL and is **not doc-converged** (`ircd/crdt_shadow.c:2268-2269`). **No S2S broadcast, no subscriber notify — returns at `:794`.** Remote servers holding the account's user in memory never learn of the change. [BROKEN-ish asymmetry; see §5/§8]
- Server-managed key refusal `:802-807` (`metadata_key_is_server_managed`, prefix table = only `draft/persistence/`, `ircd/metadata.c:1446-1449`).
- Normal path: `can_see_target` → `FAIL INVALID_TARGET` `:810`; `can_modify_target` `:176-196` (self or oper; channel: chanop/halfop/oper) → `FAIL KEY_NO_PERMISSION` `:818`; limits → FAILs `:825-835`.
- Apply: `metadata_set_channel` (memory only) / `metadata_set_client` (memory + permanent store row + doc mirror) `:838-842`; error → `FAIL INTERNAL_ERROR` `:845`. Echo 761 `:851`.
- `wire_target` expansion `*`→nick `:861-863` (documented bug fix: literal `*` would be dropped by peers).
- Local notify: `notify_subscribers` only if PUBLIC `:866-868`.
- **S2S broadcast** `:871-879`: `sendcmdto_serv_butone_v3(sptr, CMD_METADATA, NULL, "%s %s %s :%s", wire_target, key, "P"|"*", value)`; delete form value-less `"%s %s"` `:877`.

### LIST — `metadata_cmd_list` `:887-929` [ERA2][LIVE]
Memory-only walk (`metadata_list_client/channel`) inside `BATCH metadata`; visibility-filtered 761 per key. **Does NOT consult the store** — offline-account store rows and un-promoted rows are invisible to LIST (asymmetric with GET). `FAIL INVALID_PARAMS`/`INVALID_TARGET` `:896,904`. No S2S.

### CLEAR — `metadata_cmd_clear` `:934-1002` [ERA2+F2B][LIVE, fixed fdf93a5]
Permission FAILs `:942,950,958`. Then (fix, don't re-report): broadcasts a value-less per-key unset for every **in-memory** key BEFORE clearing `:982-992` (`sendcmdto_serv_butone_v3 … "%s %s"` `:990`). Then `metadata_clear_channel` (memory only, `ircd/metadata.c:1619-1626`) or `metadata_clear_client` (memory + `metadata_account_clear` store wipe + per-key doc tombstones, `ircd/metadata.c:1420-1438`, `:809-818`). Documented residuals in the block comment `:964-981`: channel store rows never deleted (pre-existing leak — TTL purge eventually reaps them since channel rows are TTL-stamped); store-only keys never hydrated into origin memory aren't broadcast. No confirmation reply is sent (`:1000` "Confirmation - send empty keyvalue?" — spec-divergent silence).

### SUB / UNSUB / SUBS — `:1007-1093` [ERA2][LIVE]
`metadata_cmd_sub` `:1007`: `FEAT_METADATA_MAX_SUBS` cap → `FAIL TOO_MANY_SUBS` `:1031`; ok → 770 RPL_METADATASUBOK. `metadata_cmd_unsub` `:1047`: 771 RPL_METADATAUNSUBOK; silently ignores not-subscribed (`metadata_sub_del` returns -1 → no reply). `metadata_cmd_subs` `:1078`: 772 RPL_METADATASUBS in `BATCH metadata-subs`. All purely local (see §6). No S2S.

### SYNC — `metadata_cmd_sync` `:1146-1205` [ERA2][LIVE]
`FAIL INVALID_PARAMS`/`INVALID_TARGET` `:1156,1164`. No subs → silent return `:1170-1173`. Without client batch support → 774 RPL_METADATASYNCLATER `:1180` (and then never actually syncs later — the "later" is unimplemented). Channel targets sync channel + every member's subscribed keys `:1184-1195` via `sync_target_metadata` `:1103-1139` (memory-only, batch-tagged raw METADATA lines). No S2S.

### Server-side handlers registered here too
- `ms_metadata` `:1454` (see §2), `ms_metadataquery` `:1319` (see §3).

---

## 2. S2S propagation map

### Senders of CMD_METADATA (MD)
All broadcast sites use `sendcmdto_serv_butone_v3` (`ircd/send.c`, IRCv3-aware **tree** downlinks only; skips legacy peers, burst-gated peers; overlay CR-only edges are never in `cli_serv(&me)->down` — skill `nefarious-crdt/.claude/skills/crdt-mesh/SKILL.md:88-91` — so MD always rides the P10 tree, no mesh loop):

| Site | Trigger | Payload shape | Notes |
|---|---|---|---|
| `ircd/m_metadata.c:872` | local client SET (value) | `<nick|#chan> <key> <P|*> :<value>` | origin broadcast |
| `ircd/m_metadata.c:877` | local client SET (delete) | `<nick|#chan> <key>` | value-less unset |
| `ircd/m_metadata.c:990` | local CLEAR, per in-memory key | `<nick|#chan> <key>` | fdf93a5 |
| `ircd/m_metadata.c:1649` | ms_metadata relay (compressed) | `<tgt> <key> <P|*> Z :<b64>` | relay-only; nothing originates Z (see §8) |
| `ircd/m_metadata.c:1654` | ms_metadata relay (plain) | `<tgt> <key> <P|*> :<value>` | onward flood |
| `ircd/m_metadata.c:1660` | ms_metadata relay (unset) | `<tgt> <key>` | onward flood |
| `ircd/m_bouncer.c:723` / `:761` | BOUNCER SET HOLD on/off | `<nick> draft/persistence/hold P :1|0` | bypasses m_metadata path; explicit broadcast |
| `ircd/m_persistence.c:217` / `:234` / `:252` | PERSISTENCE SET ON/OFF/DEFAULT | hold `P :1` / `P :0` / value-less | DEFAULT = unset |
| `ircd/m_persistence.c:646` / `:651` / `:656` | PERSISTENCE REPLAY SET | `draft/persistence/auto-replay P :1|0` / unset | |
| `ircd/m_persistence.c:791` | PERSISTENCE DETACH | hold `P :0` | |
| `ircd/m_history.c:155` | oper HISTORY LIMIT/QUOTA on channel | `<#chan> <key> :<value>` | **old format, no visibility token** — receiver's back-compat branch `m_metadata.c:1503-1506` treats parv[3] as value, PUBLIC |
| `ircd/s_serv.c:548` | netburst per user metadata entry | `%C <key> <P|*> :<value>` — **target is the user's numnick** | [BROKEN], see §4 |
| `ircd/channel.c:1648` | netburst per channel metadata entry (in `send_channel_modes`) | `<#chan> <key> <P|*> :<value>` | works |
| `ircd/m_metadata.c:1362,1372,1399,1422` | ms_metadataquery answers (`sendcmdto_one(&me, CMD_METADATA, cptr, …)`) | `<account|#chan> <key> <P|*> :<value>` | targeted, not broadcast; [VESTIGIAL] — no querier exists |

Not metadata-bearing but store-adjacent: `persistence_profile.c:234-235,322,383,405,414` write `draft/persistence/*` profile rows straight to the store (permanent) with **no S2S emission** — cross-server visibility of profile keys relies wholly on the F2B doc (accounts only) or nothing on legacy topologies.

### Receive side — `ms_metadata` `ircd/m_metadata.c:1454-1665` [ERA2+F2B][LIVE]
- Parse `:1489-1507`: `parv[3]` is visibility only if exactly `*` or `P` `:1491-1493`; `Z` flag `:1496-1499` marks base64+zstd passthrough; otherwise old-format `parv[3]`=value `:1503-1506`. Value-less (parc==3) ⇒ unset.
- `is_valid_key` silently drops `:1509-1510`.
- Compressed: base64 decode `:1513-1520` (fail → treat as plain), zstd decompress to `plain_value` `:1538-1551`; undecompressable or no-zstd build → **drop, no store, no relay** `:1550,1556`.
- **Target resolution `:1522-1532`: channel must exist (`FindChannel`) else drop; user via `FindUser(target)` — nick hash only — else drop.** Unknown targets are dropped **without relaying** (in a chain topology the hub knows all online users, so this only bites numnick targets (§4) and account-name targets, i.e. MDQ answers).
- Limits enforced on relayed values too `:1560-1571` (drop, no relay, log) — flood stops at first hop.
- **[F2B] single-writer suspend**: `crdt_shadow_metadata_suspend(1)` `:1580` wraps the apply + cache writes so the storage chokepoint does NOT re-mint a doc op (origin already did); resume `:1638`. Placed after the early-return drops so the suspend can't leak.
- Apply to live memory `:1584-1588`: `metadata_set_channel` / `metadata_set_client` with `plain_value` — **value-less arrives as NULL ⇒ both delete the in-memory entry, and for users `metadata_set_client(NULL)` also deletes the store row** (`ircd/metadata.c:1330-1343`). This is exactly what the fdf93a5 CLEAR fix leans on: remote memory AND store cleared, so GET's store-promotion has nothing to re-animate. Channel unsets clear memory only (store row left to the TTL purge).
- Store cache block `:1590-1636` (values only): user targets deliberately skipped — `metadata_set_client` already persisted permanently; the old re-write here TTL-downgraded permanent user rows (bug, fixed; comment `:1594-1601`). Channels: cached under channel name — compressed raw via `metadata_account_set_raw` with `P:` prefix when private `:1608-1622`, plain via TTL-stamped `metadata_account_set` with `P:` prefix `:1624-1631`. So channel metadata on non-origin servers is a 4h-TTL cache row; on the ORIGIN server it is memory-only (never persisted anywhere — `metadata_set_channel` has no store write) [ERA2 incomplete].
- TTL-prefixed values: **never on the wire.** `T<ts>|` wrapping is applied/stripped entirely inside the store layer (`encode_ttl_value` `ircd/metadata.c:142`, `decode_ttl_value` `:166`, get `:392-402`, list `:738-753` per fdf93a5). ms_metadata sees only plain (or `P:`-prefixed store rows via its own writes).
- Notify local subscribers if PUBLIC `:1640-1643` (remote SET does trigger local notifies — §6).
- Onward relay `:1645-1662` preserving compression/visibility/unset form, `butone(cptr)`.
- Note: no origin-server validation beyond the generic parse; visibility `P` is honored, but the doc-converged copy strips visibility entirely (§5 asymmetry).

---

## 3. MDQ — half-dismantled pull-cache protocol

- Token: `MSG_METADATAQUERY`/`TOK_METADATAQUERY "MDQ"`/`CMD_METADATAQUERY` `include/msg.h:563-565`. Parse entry `ircd/parse.c:1037-1043`: server slot only (`ms_metadataquery`), everything else `m_ignore`.
- **Answer half — `ms_metadataquery` `ircd/m_metadata.c:1319-1430`: still fully implemented.** Channel-in-memory single/all-key answers `:1349-1376`; account answers from store `:1379-1426` (all-keys via `metadata_account_list` `:1388`, single via `metadata_account_get` `:1413`, `P:` prefix decoded to `P` vis `:1394,1417`). Replies are targeted MD to the asking direction (`sendcmdto_one(&me, CMD_METADATA, cptr, …)` `:1362,1372,1399,1422`). Header comment still says "allows services (X3) to query" `:1303-1305`. `:1344` "Nefarious is authoritative - answer from local LMDB/memory".
- **Query half — nothing sends MDQ.** `CMD_METADATAQUERY` appears ONLY in msg.h, parse.c, handlers.h, and the handler itself (whole-tree grep). X3 (`/home/ibutsu/testnet/x3/src`) contains zero references to MDQ or METADATA. The prod fork (`/home/ibutsu/testnet/nefarious`) also has zero `CMD_METADATAQUERY` send sites. So no peer in the ecosystem ever queries.
- **Reply-acceptance half in ms_metadata: gone.** An MDQ answer targets an account name / offline user; `ms_metadata:1529-1531` drops any target that isn't an online nick or an existing channel. Even if something queried, the asker could not absorb user answers. (The channel-cache write block `:1602-1636` is the only surviving descendant of the ERA1 cache-fill path — it now serves S2S channel-SET caching, not MDQ replies.)
- **Verdict:** query-send [ERA1][DEAD, removed]; answer-service `ms_metadataquery` [ERA1][VESTIGIAL — live code, zero possible callers]; reply-acceptance [ERA1][DEAD, removed]; header/docs describing the flow [VESTIGIAL]. The pull-cache protocol is dead in both directions; only the responder husk remains wired into parse.c.
- Declared intent markers: `include/metadata.h:364` "X3 dependency removed - Nefarious is now authoritative", `:380` "MDQ removed - Nefarious answers GET from local LMDB only"; `ircd/metadata.c:1797` same.

---

## 4. Netburst

### Legacy (non-CRDT) IRCv3-aware peer — what it receives
- **Per-user metadata** `ircd/s_serv.c:544-554`: inside the N-burst loop, gated `feature_bool(FEAT_METADATA_BURST) && IsIRCv3Aware(cptr)` `:545` (gate added in `7cecc9b` because X3/vanilla ircu log PARSE ERROR on MD). One MD per in-memory entry: `sendcmdto_one(cli_user(acptr)->server, CMD_METADATA, cptr, "%C %s %s :%s", acptr, …)` `:548`.
  **[BROKEN] The `%C` target renders as the user's NUMNICK** (dest is a server ⇒ `ircd_snprintf.c:2047-2056` emits `cli_yxx(server)+cli_yxx(user)`), but the receiving `ms_metadata` resolves targets with `FindUser()` = nick-hash (`include/hash.h:59,72`; `m_metadata.c:1529`), which cannot resolve numnicks ⇒ **every bursted user-metadata row is silently dropped (and not relayed) by the receiver** (`:1530-1531`). Present since the original ERA1 commit `ca033ea` ("cache-aware metadata with X3 detection and write queue"); every other bursted per-user extension (e.g. CMD_MARK `s_serv.c:505`) uses `cli_name`. Practical effect: after a legacy link, remote in-memory metadata is empty until a steady-state SET or a store-side path (auth-time `metadata_load_account` / GET lazy fill) repopulates it — which works only for account-backed keys that were permanent rows on the receiving side already, i.e. effectively nothing new crosses. This is almost certainly the substrate of the `project_ephemeral_metadata_burst_gap` memory item.
- **Per-channel metadata** `ircd/channel.c:1643-1653`: at the end of `send_channel_modes` (after TOPIC burst), same double gate `:1645`; one MD per entry with `chptr->chname` as target `:1648`. The receiver has already created the channel from the preceding B line ⇒ `FindChannel` succeeds ⇒ applied to memory + cached as a TTL store row. **Channel burst WORKS.** (The task context's "channel-side burst absence" is inverted — see Surprises.)
- **Non-IRCv3-aware legacy peer (X3, vanilla ircu):** receives no MD at all (both burst gates + `sendcmdto_serv_butone_v3`'s dispatch filter skip it). Steady-state metadata simply does not exist for those peers.
- The in-`metadata.c` `metadata_burst_client`/`metadata_burst_channel` are argument-swallowing **stubs** (`ircd/metadata.c:1853-1858`, `:1864-1869`) with **zero callers** [DEAD]; the real implementations are the inline blocks above.

### CRDT peer — what it receives
- Phase 3c cutover `ircd/s_serv.c:367-381`: a CRDT-aware peer with `FEAT_CRDT_PRIMARY` and `crdt_shadow_doc_ready()` gets the **CR F snapshot instead of the whole P10 N/BURST loop** (early return `:380`) — so the broken numnick MD burst never even runs for it.
- CR F carries the metadata collection: `crdt_snapshot_encode` `ircd/crdt_wire.c:299`, `snap_put_lww(&w, &st->metadata, CRDT_COLL_METADATA, …)` `:337` (Tier C F2-b), routed on decode via `crdt_state_lww_for` `ircd/crdt_state.c:1606`. Confirmed.
- Apply path: `m_crdt.c:763-780` (CR F) → `crdt_shadow_apply_snapshot` → if mid-burst `crdt_shadow_materialize_live()` `:779-780` — **materialize_live does NOT include the metadata reconcile** (`crdt_shadow.c:3867` body has zero `reconcile` calls); the store materialization of snapshot metadata waits for the next CR D delta apply (`m_crdt.c:747`) or the 30s verify cycle (`crdt_shadow_verify_cb` `crdt_shadow.c:5046` → `:5091`). Up-to-30s post-link latency for doc-carried metadata to land in the local store.
- Cold-boot fallback `s_serv.c:372-374`: doc not ready ⇒ CRDT peer receives the normal P10 burst, i.e. the broken user-MD path, too.
- What the doc does NOT carry (so a pure-overlay/doc-only peer never gets): channel metadata (excluded `crdt_shadow.c:2240-2241`), non-account (transient user) metadata, TTL rows (last_present, oper-offline-SETs), visibility bits (§5).

---

## 5. CRDT layer (metadata parts)

### Doc key + mint sites
- `metadata_doc_key` `ircd/crdt_shadow.c:2233-2249`: opaque `account\0metakey`, **byte-identical to the metadata_cf storage key**; returns 0 (excluded) for empty account/key, for `IsChannelName(account)` `:2240-2241` (channels never converge), and for oversize.
- Op mints (all call sites that create metadata doc ops):
  1. `crdt_shadow_metadata_set` `:2257-2280` — called from exactly one place: the storage chokepoint `metadata_account_set_ts` `ircd/metadata.c:479-482` (fires on every successful store commit). Value branch: `permanent==0` (TTL-stamped write) → **skip, not shared truth** `:2268-2269`; permanent → `crdt_metadata_set` + `crdt_sync_push` `:2270-2271`. Delete branch: tombstone only if the key is currently doc-present (`crdt_metadata_get` guard `:2274-2276`, prevents spurious tombstones for TTL-cache deletes) → `crdt_metadata_del` + push. NOTE the delete branch ignores `permanent`, so a plain user-key delete (which arrives via TTL-wrapper `metadata_account_set(acct,key,NULL)` `ircd/metadata.c:1342`) DOES tombstone a converged key — correct.
  2. `crdt_shadow_metadata_remove_key` `:2292-2304` — raw-storage-key variant, called only from `metadata_account_clear`'s per-key loop `ircd/metadata.c:817` (bulk `db_writebatch_del` bypasses the chokepoint; without this the doc SET survives and reconcile SET-heals the cleared value back ~30s later — "active resurrection", comment `:810-816` / `crdt_shadow.c:2284-2287`). Same doc-present guard.
  - Guards on both: `shadow_on() && !g_metadata_reconciling && !g_metadata_remote_applying` `:2262,2295` — the latter set by `crdt_shadow_metadata_suspend` `:2226-2229` from `ms_metadata` (single-writer: only the ORIGIN server mirrors; P10-relayed applies never re-enter the doc).
  3. `metadata_account_set_raw` `ircd/metadata.c:511-538` commits to the store **without any doc mirror** — used only for the Z-compressed channel cache (channels excluded from doc anyway), so currently harmless, but it is a hole in the "storage chokepoint covers everything" claim if it ever gains a user-target caller.
- Engine ops: `crdt_metadata_set/del/get/is_explicitly_removed` `ircd/crdt_state.c:876-918` over LWW map `st->metadata` (`crdt_lwwmap_*`; init `:155`, clear `:179`), ops tagged `CRDT_OP_SET/DELETE` + `CRDT_COLL_METADATA` `:884,:901` (`include/crdt_state.h:278`).

### Reconcile — STORE-ONLY, confirmed
`crdt_shadow_reconcile_metadata` `ircd/crdt_shadow.c:2367-2410`, dispatched from (a) eager delta apply `ircd/m_crdt.c:747`, (b) 30s verify cycle `ircd/crdt_shadow.c:5091` (inside `crdt_shadow_verify_cb` `:5046`). Whole pass under `g_metadata_reconciling` so store writes don't re-mint ops `:2375,2404`.
- SET heal `reconcile_metadata_set_cb` `:2311-2337`: splits the opaque key at NUL, echo-guard against identical store value `:2332-2334`, writes via `metadata_account_set_permanent` `:2335`. **Touches only the store — never `cli_metadata` live memory, never notify_subscribers. Confirmed: no Client lookup anywhere in the pass.**
- DELETE store-walk `reconcile_metadata_del_collect` `:2349-2360` + apply loop `:2382-2397`: walks every metadata_cf key (`metadata_account_foreach_key` `ircd/metadata.c:999-1020`), reaps only keys the doc has **EXPLICITLY tombstoned** (`crdt_metadata_is_explicitly_removed` — never on mere absence, sync-lag safety `:2339-2341`), collect-then-act (live iterator), capped at `CRDT_METADATA_REMOVE_MAX` 256/cycle `:2221,:2398-2401`, deletes via `metadata_account_set(…, NULL)` `:2395`.
- Tombstone/GC: metadata tombstones are LWW-map deleted-entries in the doc; they persist so the del-walk can gate on them, subject to the engine's causal-stability GC (`crdt_shadow_gc` `:4985`, peer-SV based) — no metadata-specific GC.

### CLEAR/unset propagation summary (both channels)
Origin: per-key S2S unset broadcast (`m_metadata.c:990`) + per-key doc tombstones (`metadata.c:817`). Tree peers: ms_metadata unset under suspend → memory+store delete, no doc write. Doc-only peers: del-walk reaps the store row within a reconcile tick.

### Asymmetries: doc vs S2S CMD_METADATA
1. **Scope**: doc = permanent account-keyed user metadata only; S2S MD = everything (channels, non-account users, all visibilities). Channel + transient metadata have no doc backstop.
2. **Visibility**: S2S MD carries `P|*`; the doc value is the bare string — visibility is stripped on the doc path (`crdt_shadow_metadata_set` stores value only `:2270`), and `reconcile` rematerializes rows with no `P:` prefix ⇒ a private user key surfacing on a doc-only peer via GET's store branch reads as public `*` (`m_metadata.c:481-484` finds no prefix). (User-row visibility is not persisted anywhere, see §8 — the doc merely inherits that gap.)
3. **Liveness**: S2S MD updates live `cli_metadata` and fires subscriber notifies; reconcile updates the store only. On a node reachable only via the doc (tree split with overlay alive; future MR-5 tree retirement): no notify ever fires, and an online user whose key is already hydrated in memory keeps serving the **stale memory value** — GET checks memory first (`metadata.c:1223-1226`) and the lazy fill only runs on memory-miss (`:1239`). Same for doc deletes: the del-walk removes the store row but not the in-memory entry. Today the redundant P10 tree hides this; it becomes a correctness gap the moment MR-5 retires the tree for MD (M8's ghost, doc edition — worth putting on the MR-6 gate list).
4. **Latency**: S2S MD is immediate; doc is push+reconcile (sub-second on delta, up to 30s after CR F snapshot, §4).
5. **Dual delivery**: tree-connected CRDT peers receive both; idempotent (echo guard `:2332`, suspend guard `:1580`).

---

## 6. SUB / notify layer

- Storage: per-Client singly-linked `struct MetadataSub` list, `cli_metadatasub` (`include/client.h:577,780`), ops `metadata_sub_add/del/check/list/count/free` `ircd/metadata.c:1680-1795`. **Local-only, in-memory, per connection**: never persisted, never sent S2S, freed on disconnect (`metadata_free_client` `:1523-1529`). A bouncer alias/reconnect starts with zero subs.
- Notify fan-out: `notify_subscribers` `ircd/m_metadata.c:214-260` — iterates LOCAL clients (`LocalClientArray`), requires `CapActive(CAP_DRAFT_METADATA2)` + `metadata_sub_check`, visibility scoping (shares-channel-or-self for users `:242-244`, membership for channels `:245-247`), raw `:server METADATA <target> <key> * [:<value>]` lines `:251-258`.
- **Remote SET → local notify: YES.** `ms_metadata` calls `notify_subscribers` after apply `:1640-1643` — but only for PUBLIC values; and value-less unsets notify with no value param. Local SETs likewise notify only PUBLIC (`:866-868`) — private changes are never notified, not even to the owner (spec divergence; draft/metadata-2 notifies the target's own sessions).
- Doc-path deliveries never notify (§5.3).
- Join-time backfill: `metadata_send_join_notifications` `ircd/m_metadata.c:268-311` (member+channel keys the joiner subscribed to, non-private), called from join `ircd/channel.c:5519`. Self-metadata BATCH on registration/revive: `metadata_burst_self_to_client` `ircd/metadata.c:1384-1415`, called `ircd/s_user.c:547,721`, `ircd/bouncer_session.c:7997`.

---

## 7. Feature-flag truth table (FEAT_METADATA_* + adjacent)

Enum: `include/ircd_features.h:374-377,424-431`; table: `ircd/ircd_features.c:1218-1221,1279-1286`.

| Flag (default) | Read at | Actual live effect on this branch | Era | Verdict |
|---|---|---|---|---|
| `METADATA_MAX_KEYS` (20) | `m_metadata.c:608,749`; `metadata.c:849` | per-target user-key budget (memory + persisted-row count), server-managed keys exempt; enforced on client SET, oper `*account` SET, and S2S apply | ERA2 | LIVE |
| `METADATA_MAX_VALUE_BYTES` (300) | `m_metadata.c:609` | value length + UTF-8 gate via `metadata_check_limits` (client SET `:825`, S2S `:1565`) | ERA2 | LIVE |
| `METADATA_MAX_SUBS` (50) | `m_metadata.c:1018` | SUB cap | ERA2 | LIVE |
| `METADATA_RATE_LIMIT` (10) | `m_metadata.c:1215` | per-second command cap, opers exempt | ERA2 | LIVE |
| `METADATA_CACHE_ENABLED` (TRUE) | `ircd.c:900`; `metadata.c:1815` | ONLY gates the purge-timer callback (and the dead `metadata_get_client_cached`). Store reads/writes are unconditional. Setting FALSE just stops physical purging (expiry checks still hide stale rows) | ERA1 | VESTIGIAL (name lies) |
| `METADATA_X3_TIMEOUT` | **nowhere — flag does not exist in this tree** | none | ERA1 | DEAD (removed) |
| `METADATA_QUEUE_SIZE` | **nowhere — flag does not exist in this tree** | none | ERA1 | DEAD (removed) |
| `METADATA_BURST` (TRUE) | `s_serv.c:545`; `channel.c:1645` | channel-metadata netburst works; user-metadata netburst is emitted but discarded by every receiver (numnick target, §4) | ERA2 | LIVE(channel) / BROKEN(user) |
| `METADATA_DB` ("metadata") | `ircd.c:1344` | RocksDB env path (init threaded, gated on `FEAT_CAP_draft_metadata_2` `ircd.c:1343`) | ERA2 | LIVE |
| `METADATA_DB_AUTOGROW` (TRUE) | `metadata.c:237-243` | picks size_floor 0 vs fixed 100MB in `db_env_opts` — libmdbx semantics; effect under RocksDB marginal | ERA2(mdbx) | VESTIGIAL |
| `METADATA_DB_NORDAHEAD` (TRUE) | `metadata.c:244-248` | sets `random_access` hint | ERA2(mdbx) | VESTIGIAL |
| `METADATA_CACHE_SLOTS` (128) | **registered `ircd_features.c:1284`, zero reads** | none — the mdbx FNV B-tree cache it tuned was retired (`metadata.c:99-103`) | ERA2(mdbx) | DEAD |
| `METADATA_CACHE_TTL` (14400) | `metadata.c:380,398,749,935` | expiry for **TTL-stamped rows only**: S2S channel cache (`m_metadata.c:1631`), oper offline `*account` SETs (`m_metadata.c:783`), `last_present` (`account_conn.c:465`). User rows are permanent (`T0|`) and immune | ERA1→narrowed | LIVE (narrow) |
| `METADATA_PURGE_FREQUENCY` (3600) | `ircd.c:883,1238`; notify `ircd_features.c:731-738` → `metadata_purge_restart_timer` `ircd.c:877-890` | periodic `metadata_account_purge_expired` (`metadata.c:918-992`), min 60s on re-arm | ERA1→narrowed | LIVE |
| adj: `CAP_draft_metadata_2` (**FALSE**) | `ircd_features.c:1213`; `ircd.c:1343` | advertises the CAP and gates store init; whole subsystem is client-dead without it (S2S/burst paths still run) | ERA2 | LIVE |
| adj: `PRESENCE_AGGREGATION` | `metadata.c:1159` | virtual `presence`/`away_message`/`last_present` GET keys from bouncer session state `:1163-1219` | F2B-adjacent | LIVE |

### FEATURE_FLAGS_CONFIG.md mismatches (`/home/ibutsu/testnet/FEATURE_FLAGS_CONFIG.md`)
- `:222` `FEAT_METADATA_X3_TIMEOUT` "Seconds to wait for X3 before using cache-only mode" — flag **does not exist**; no X3 wait exists.
- `:223` `FEAT_METADATA_QUEUE_SIZE` "Maximum pending writes when X3 is unavailable" — flag **does not exist**; no write queue exists.
- `:232` "X3 Detection: Automatically detects X3 availability via heartbeat on METADATA updates" — no such code anywhere (grepped x3_available/heartbeat/queue: zero hits).
- `:233` "Write Queue: Queues writes when X3 is unavailable, replays when reconnected" — no such code.
- `:221` CACHE_ENABLED "Enable RocksDB metadata caching" — actually only toggles the purge timer.
- `:224` BURST "Send metadata during netburst to linking servers" — sent, but the user half is discarded by receivers (numnick bug).
- `:1078-1108` whole MDQ section describes the ERA1 flow ("Nefarious sends MDQ to X3 if data not in local cache… X3 looks up data in Keycloak") — contradicted by `m_metadata.c:511,558,1344` and by X3 containing no MDQ/MD code at all. Only the "Response: Standard MD tokens" half (the responder) still exists.
- `:226-229` CACHE_TTL/PURGE/AUTOGROW/NORDAHEAD rows are accurate-ish (AUTOGROW/NORDAHEAD already flagged as legacy there).

---

## 8. Dead / vestigial inventory (wire side)

| Item | Where | Callers | Verdict |
|---|---|---|---|
| `ms_metadataquery` responder | `m_metadata.c:1319-1430` + `parse.c:1038-1043` | reachable only from a peer that sends MDQ — **zero senders in nefarious-crdt, prod nefarious, and X3** | [ERA1] VESTIGIAL (dead protocol, live code) |
| MDQ query-send + reply-acceptance | removed; markers `m_metadata.c:511,558`; `metadata.h:364,380`; `metadata.c:1797` | — | [ERA1] DEAD (cleanly removed) |
| ERA1 X3 heartbeat / write queue | nothing in tree (grep x3_available, metadata_queue, x3_detect, heartbeat) | — | DEAD (fully removed; survives only in FEATURE_FLAGS_CONFIG.md) |
| Z compressed passthrough receive+relay | `m_metadata.c:79-102 (base64_decode), 1496-1499, 1512-1520, 1538-1558, 1608-1622, 1649-1652` | **no origin ever emits Z** — the only `" Z :"` emitter is the relay itself (`:1649`); path exercisable only by a foreign implementation | [ERA2] VESTIGIAL |
| `metadata_get_client_cached` | `metadata.c:1805-1845`, decl `metadata.h:362` | 0 | DEAD |
| `metadata_channel_persist` / `metadata_channel_load` | `metadata.c:900-912` (+ stubs `:1037-1038`) | 0 | DEAD (channel persistence-on-origin was never wired) |
| `metadata_burst_client` / `metadata_burst_channel` stubs | `metadata.c:1853-1869`, decls `metadata.h:372,378` | 0 (real impls inline in `s_serv.c:544` / `channel.c:1643`) | DEAD |
| `METADATA_MAX_KEYS` / `METADATA_MAX_SUBS` macros | `metadata.h:40,43` | 0 (feature ints rule) | DEAD |
| `FEAT_METADATA_CACHE_SLOTS` | `ircd_features.h:429`, `ircd_features.c:1284` | 0 reads | DEAD |
| `$`-prefixed virtual-key skips | `metadata.c:1239 (key[0] != '$')`, `:1829` | virtual keys are `presence`/`away_message`/`last_present` — none `$`-prefixed (`metadata.c:63-69`); comment `:1191` still says "$away_message" | VESTIGIAL |
| stale ERA1 comments | `m_metadata.c:368-374` (GET flow step 3 "send MDQ to X3"), `:1301-1318` (ms_metadataquery "services (X3)"), `metadata.h:70-82` "LMDB", ubiquitous `metadata_lmdb_*` naming over RocksDB | — | VESTIGIAL (cosmetic) |
| `server_managed_prefixes` drift | table = only `draft/persistence/` (`metadata.c:1446-1449`); header + comment claim `bouncer/, session/, system/` (`metadata.h:269-276`, `metadata.c:1440-1445`) | — | VESTIGIAL comment; no writer uses those prefixes today, but nothing protects them either |
| oper `*account` SET emits no S2S/notify | `m_metadata.c:702-795` returns `:794` before broadcast; offline branch writes a TTL row `:783` (expires in 4h, not doc-converged per `crdt_shadow.c:2268`) | — | BROKEN-ish design gap: "offline cleanup" works locally only, silently decays |
| user-metadata netburst | `s_serv.c:548` numnick target vs `FindUser` receiver | — | BROKEN since `ca033ea` (§4) |
| user-row visibility persistence | private flag never stored for user rows (`metadata_set_client`→`set_permanent` raw value `metadata.c:1328`); restore paths disagree: `metadata_account_list` hardcodes PUBLIC `:759` (auth-time eager load) vs GET lazy fill hardcodes PRIVATE `:1245` | — | BROKEN (privacy: a `private` user key set before a restart comes back PUBLIC via the load_account path) |
| origin-side channel persistence | `metadata_set_channel` memory-only; only RECEIVING servers cache channel rows (TTL) `m_metadata.c:1602-1631`; origin loses channel metadata on restart, remotes lose it after CACHE_TTL | — | ERA2 incomplete |

---

## Surprises (contradicting the task context)

1. **The netburst polarity is inverted from the brief.** Channel-side burst is NOT absent — it's implemented inline in `send_channel_modes` (`channel.c:1643-1653`) and works. It's the USER-side burst (`s_serv.c:544-554`) that is de-facto absent: it emits MD with a `%C` numnick target that the receiving `ms_metadata` (`FindUser`, nick hash) can never resolve, so every row is silently dropped since the feature's first commit (`ca033ea`). The `metadata_burst_channel` "stub" in metadata.c is real but irrelevant — both burst stubs are uncalled decoys.
2. **FEAT_METADATA_X3_TIMEOUT and FEAT_METADATA_QUEUE_SIZE do not exist in this tree at all** — not as enum, table entry, or read. They live only in FEATURE_FLAGS_CONFIG.md. The ERA1 heartbeat/write-queue machinery they configured is completely gone (cleanest part of the dismantling), so the doc rows describe pure fiction rather than dormant code.
3. **MDQ is dead in every direction ecosystem-wide**: X3 contains no MDQ *or MD* code at all, and even prod nefarious has no MDQ sender. Plus ms_metadata can no longer accept the account-name-targeted MD frames an MDQ answer would produce — so the surviving responder isn't just unused, its output would be unparseable by its own sibling.
4. **The doc path is store-only by design but that design has a fuse**: because GET prefers memory and reconcile never touches `cli_metadata` or notifies, doc-only delivery (overlay-leaf during a tree split, or post-MR-5) reproduces exactly the M8 staleness class the fdf93a5 CLEAR fix just killed on the tree path — for values AND deletes. Fine today (tree is redundant), gates MR-5/MR-6.
5. **Oper `METADATA SET *account …` never propagates**: no S2S broadcast (returns before the broadcast site), and the offline-account branch writes a TTL-stamped row that the doc mirror deliberately refuses to converge (`permanent==0`) and the purge sweep deletes within CACHE_TTL — so the documented "offline cleanup" use case silently self-destructs after 4h and never reaches other nodes' stores or memories.
6. **Private visibility is unpersisted for user rows** and the two store→memory restore paths disagree (eager load ⇒ PUBLIC `metadata.c:759`, lazy GET fill ⇒ PRIVATE `:1245`), so a `private` key survives a reconnect as public via the auth-time path — a small privacy hole independent of the wire.
7. Minor: `metadata_account_set_raw` skips the CRDT mirror chokepoint (`metadata.c:511-538` — no `crdt_shadow_metadata_set` call), currently unreachable for users (Z path is originator-less), but it falsifies the "storage chokepoint covers all origins" comment at `metadata.c:479-481` if ever reused.
