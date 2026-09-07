# P1 (account tier) plan-time discovery — metadata-era2-completion §A

Repo: `/home/ibutsu/testnet/nefarious-crdt` @ `236e1ff` (crdt-mesh, P0 landed). All paths below relative to repo root unless absolute. Line numbers verified at this commit.

---

## Item 1 — A3 eager-load: every account-attach site

An "attach" = a non-empty write into `cli_user(x)->account` (+ `SetAccount`). `cli_account(x)` is a read-only accessor (`include/client.h:734` — ternary, not assignable), so all writes are direct field copies; there are no whole-`struct User` memcpys (only the calloc in `make_user`, `ircd/s_user.c:112-116`). `metadata_load_account` (`ircd/metadata.c:1405-1428`) **frees `cli_metadata` and replaces it with the store list** — a full replace, so redundant/double calls are idempotent (wasted store iteration only), and it self-guards on `metadata_lmdb_is_available()` (:1415).

### A. Sites that already load (the known 4)

| # | Site | Flow | Load | Pre-reg? | Notes |
|---|---|---|---|---|---|
| 1 | `ircd/m_account.c:256` (stamp), `:257` SetAccount | S2S `AC R`/`AC M` (extended-accounts remote login/change) | YES, `:254`, before stamp | No (registered users, local or remote) | account = `parv[3]`, plain (acc_create separate `parv[4]`) |
| 2 | `ircd/m_account.c:398-399` | LOC: services `AC A` reply to a pre-reg client | YES, `:395` | **Yes** — pre-registration; `cli_user` exists (field deref'd); account from `cli_loc(acptr)->account` (staged by `ircd/m_pass.c:159`, plain string) | |
| 3 | `ircd/m_account.c:461-462` | Legacy (non-extended) S2S `AC <num> <account> [ts]` | YES, `:459` | No | ts is `parv[3]`, account plain |
| 4 | `ircd/sasl_auth.c:624-625` in `sasl_complete_login` (`:584`) | SASL success on an **already-registered** client (reauth / post-reg auth), `IsRegistered` branch `:618` | YES, `:622` | No | account = `cli_saslaccount`, plain |

### B. Sites with NO load (the A3 gap)

| # | Site | Flow | Pre-reg? | Load safe there? |
|---|---|---|---|---|
| 5 | `ircd/s_auth.c:465-466` in `auth_complete_sasl` (`:460`) | **Pre-reg SASL success** applied at auth completion: `cli_saslaccount` → account. Called from `check_auth_finished` (`:544`) at `:600`, i.e. BEFORE `register_user` (`:800`). Also the funnel for **pre-reg `REGISTER`** (draft/register): `ms_regreply` stages into `cli_saslaccount` + `SetSASLComplete` (`ircd/m_register.c:432-433`) | Yes (cli_user allocated — field deref'd) | Yes — account plain, store up (runtime) |
| 6 | `ircd/s_auth.c:2879-2880` in `iauth_cmd_done_account` (`:2855`) | **IAuth `D` with account** (iauthd assigns account) | Yes | Yes — the `account:ts` suffix is trimmed **in place before** the copy (`:2873-2877`), so the string is clean at stamp time; runs before `register_user` |
| 7 | `ircd/m_webirc.c:212-213` in `apply_webirc_changes` (`:127`) | **WEBIRC** `afternet.org/account` option (gated `WFLAG_TRUSTACCOUNT`) | Yes; note the `cli_user(cptr)` guard at `:211` — if WEBIRC precedes USER, `cli_user` is NULL and the account is silently dropped (pre-existing) | Yes when the guard passes — plain string |
| 8 | `ircd/m_register.c:416-419` in `ms_regreply` | **REGISTER success on an already-registered client** (post-reg branch) | No | Yes — plain account |
| 9 | `ircd/s_user.c:2528-2541` in `set_user_mode` (`:1978`), fed by the `'r'` case `:2395-2400` | **The umode `+r account[:ts]` funnel**: (a) remote NICK introduction / N-burst — `set_nick_name` applies burst umodes via `set_user_mode` at `ircd/s_user.c:1119` then calls `register_user` at `:1122`; (b) `SVSMODE +r` (`ircd/m_svsmode.c:122`); (c) any server MODE +r. Gated `!FlagHas(&setflags, FLAG_ACCOUNT) && IsAccount` so it only fires on a fresh attach | Client may be mid-intro (remote, pre-`register_user`) or already registered (svsmode) | **Caution: the `account` variable still holds `account:ts` here** — the trim happens inside the copy (`len` cut at `':'`, `:2531-2539`). A load placed BEFORE the stamp must not use the raw variable; placed AFTER the stamp, `cli_user->account` is clean. Store up |
| 10 | `ircd/crdt_shadow.c:3751-3755` in `crdt_materialize_one_user` (`:3674`) | **Mesh materialization** of a doc user record (bulk burst-replacement / delta apply) — remote mesh-stub client | No (hand-rolled `SetUser` at `:3757`; never passes `register_user`) | Yes — `rec->account` plain (acc_create separate field); runs post-init. Parity argument: remote clients DO get loads today via flow 1/3, so materialized remotes serving GET-from-memory need it too |
| 11 | `ircd/bouncer_session.c:3313` (+ `SetAccount` `:3338`) in `bounce_create_ghost` (`:3288`) | **Bouncer ghost restore** from bouncer DB at startup (`bounce_db_restore`, `:3441`) | No (hand-rolled `SetUser` `:3336`) | Yes — init order is contractual: `metadata_lmdb_init` `ircd/ircd.c:1343-1346` before `bounce_db_restore` `ircd/ircd.c:1391` (comment `:1388` states the ordering requirement). Without it, a restored ghost has empty `cli_metadata` until a lazy GET |

### C. Sites that do NOT need a load (classified, with reason)

- **Bouncer alias mirrors** — `ircd/bouncer_session.c:7752/:7770` (`bounce_convert_to_alias`, copies from primary; primary's own attach already loaded), `:8246` (convert-remote-N-to-alias branch), `:8303/:8331` (fresh remote alias in `bounce_alias_create`), `:8930-8934` (BX U alias field sync). Aliases are **removed from the nick hash** (`:7742` "Aliases must NOT be in the nick hash"; `:8322` "NOT in nick hash"), so metadata resolution (`FindUser`) always lands on the primary; alias `cli_metadata` is never consulted or bursted.
- **Detaches, not attaches** — `ircd/m_account.c:201-202` (`AC U` account-deletion wipe; correctly preceded by `metadata_clear_client` `:191`, which nukes store+memory — account is being deleted); `ircd/sasl_webhook.c:73-74` (`deauth_client` `:56` — webhook-driven logout: clears account but leaves `cli_metadata` memory entries attached to the now-unauthed client, and leaves the store alone. Store-alone is correct for logout; the lingering memory entries are a pre-existing hygiene wart, out of A3 scope but adjacent — note for the plan).
- **Staging, not attach** — `ircd/m_pass.c:159` writes `cli_loc(cptr)->account` (LOC scratch struct; real attach is flow 2). `ircd/account_conn.c:106` and the `crdt_shadow.c:650/:3610/:3622` writes target record/tracking structs, not clients.

### Chokepoint verdict

**There is no single existing chokepoint, but `register_user` (`ircd/s_user.c:391`) is downstream of 5 of the 7 uncovered flows** and is the cheap one to hook:

- Local: `check_auth_finished` runs `auth_complete_sasl` (`ircd/s_auth.c:600`) — covering pre-reg SASL AND pre-reg REGISTER — and IAuth/WEBIRC stamps also precede it; `register_user` is then called at `ircd/s_auth.c:800`.
- Remote: `set_nick_name` applies `+r` via `set_user_mode` (`ircd/s_user.c:1119`) then immediately calls `register_user` (`:1122`).

A single `if (IsAccount(sptr) && cli_user(sptr)->account[0]) metadata_load_account(...)` early in `register_user` (both MyConnect and remote branches — e.g. right after the require-sasl gate `:426-430`, before `Count_unknownbecomesclient`; the account string is complete and ts-trimmed on every inbound path by that point) covers flows 5, 6, 7, pre-reg-REGISTER, and 9(a) N-burst intro.

**Per-site residue (3 hooks + 1 policy):**
1. `ircd/m_register.c:417` post-reg REGISTER (already registered, no `register_user` pass).
2. `ircd/s_user.c:2541` — only for the already-registered case (svsmode/MODE +r on a live client). Guard with `IsRegistered(acptr)` so remote intros don't double-load (they hit the `register_user` hook 3 lines later at `:1122`); place AFTER the stamp so the trimmed `cli_user->account` is used.
3. `ircd/crdt_shadow.c:3755` mesh materialization.
4. `ircd/bouncer_session.c:3313-3338` ghost restore. **Related trap**: on ghost *revive*, the reviving socket's temp client gets the load (via the `register_user` hook) but the load lands on the temp client, not the ghost that survives — the ghost needs its own load at restore (this hook) since revive does not transfer `cli_metadata`.

Alias sites need nothing (documented above). Double-load is safe (replace semantics) but each extra call re-iterates the store prefix — the `IsRegistered` guard in residue-2 keeps burst cost at one load per user.

One semantic note for the plan: because `metadata_load_account` REPLACES `cli_metadata`, extending it to all attach paths also extends the existing "login wipes any pre-login memory-only metadata" behavior to those flows (spec-consistent — account truth wins — but say so in the commit).

---

## Item 2 — A2 visibility encoding: caller graph + threading

### (a) Callers of `metadata_account_set{,_ts,_permanent}` and what visibility they know

`metadata_account_set_ts` is **static** (`ircd/metadata.c:419`); only `metadata_account_set` (`:490`, TTL=CurrentTime) and `metadata_account_set_permanent` (`:498`, ts=0) are external. Callers:

**Value-writing callers (6):**

| Caller | What it knows |
|---|---|
| `ircd/metadata.c:1239` — `metadata_set_client`'s persist (`:1196`) | **HAS `visibility`** (function parameter, currently dropped at the store boundary). This is the biggest fan-in: every client `METADATA SET` (`ircd/m_metadata.c:796` with parsed vis from `:631-643`), every S2S `ms_metadata` user apply (`:1348`, wire vis parsed `:1296-1299`), oper `SET *account` online branch (`:732`), umode↔metadata sync (`ircd/s_user.c:2228-2375`, literal vis consts), bouncer hold/auto-replay (`ircd/m_bouncer.c:713/:758`, `ircd/m_persistence.c:216/:233/:644/:649/:790`, all `METADATA_VIS_PRIVATE`) |
| `ircd/m_metadata.c:738` — oper `SET *account` **offline** branch | **HAS parsed vis** (same `:631-643` parse) — currently dropped AND TTL'd (A4 flips to permanent) |
| `ircd/m_metadata.c:1376` — `ms_metadata` channel TTL cache | **HAS wire vis** and is the ONLY current pre-prefixer: builds `"P:%s"` at `:1371-1372` then calls `metadata_account_set`. Slated for deletion in P2 (B5) but alive through P1 |
| `ircd/account_conn.c:465` — `persist_last_present` (`:457`) | **No vis concept** — TTL row, never doc-mirrored (TTL skip), served PUBLIC by the virtual-key handler (`ircd/metadata.c:1027`). Encode as public (bare) = zero change |
| `ircd/persistence_profile.c:234/:383/:405` — profile writes (set / rename-copy / active-pointer) | **Server-managed, no explicit vis.** Conceptually private (their sibling `draft/persistence/hold` is written VIS_PRIVATE through path 1). `:383` copies a value obtained from `metadata_account_get` (`:379`) — post-A2 that get can return the decoded vis to thread through |
| `ircd/crdt_shadow.c:2335` — `reconcile_metadata_set_cb` doc heal | **Has the doc blob** (`docval`), which post-A2 *is* the vis-prefixed form — it must split prefix→(vis,raw) before calling, and fix its echo guard (see hazards) |

**Delete-only callers (vis-irrelevant):** `ircd/metadata.c:1253` (set_client delete), `ircd/persistence_profile.c:235/:322/:414`, `ircd/crdt_shadow.c:2395` (reconcile store-reap), `ircd/m_metadata.c:738` when value==NULL. (`metadata_account_clear` `ircd/metadata.c:736` bypasses set_ts via bulk writebatch + `crdt_shadow_metadata_remove_key` — untouched by A2.)

### (b) Every current `P:` encode/decode site

- **Encode (1 site)**: `ircd/m_metadata.c:1371-1372` (ms_metadata channel cache, above).
- **Decode (2 sites)**: `ircd/m_metadata.c:447-450` (GET user store-fallback: parse + owner/oper gate `:453-462`, serve `:464`, promote `:470-471`) and `:491-494` (GET channel store-fallback: parse + chanop/oper gate `:496-510`, promote `:517-518`).
- `ms_metadataquery` is **GONE** — zero grep hits for `METADATAQUERY` anywhere in `ircd/` + `include/`. Codebase-wide `== 'P'` sweep finds only unrelated hits (`ircd/m_crdt.c:987` CR-M cmd char, `ircd/bouncer_session.c:9028` BX P token). No other encode/decode exists.
- **Non-sites that look adjacent**: the S2S wire vis token `"P"`/`"*"` (parse `ircd/m_metadata.c:1296-1299`, emit `:1391-1394`) is separate from the store `P:` prefix; the internal `metadata_account_get` consumers (bouncer hold `ircd/bouncer_session.c:841/:1071/:5464/:6573`, `ircd/m_bouncer.c:853/:985`, `ircd/m_persistence.c:94/:123/:588`, profiles, account_conn) do **no** `P:` parsing — they rely on rows being bare today.

### (c) Exact current layering (splice target)

**Write** — `metadata_account_set_ts` (`ircd/metadata.c:419-486`), innermost→outermost:
1. raw `value`
2. → `encode_ttl_value` (`:447`; format `T<ts>|value`, `:142-156`; ts=0 for permanent)
3. → `compress_data` zstd if it wins (`:453-461`)
4. → `db_writebatch_put` (`:465`)

So the A2 row becomes: `zstd( T<ts>| ( [P:]value ) )` — the vis prefix must be applied to `value` **before step 2**. This matches what the ms_metadata channel cache already produces by pre-prefixing (its rows are `TTL(P:value)`), and what the GET fallbacks already expect (they run `metadata_account_get`, which strips zstd+TTL, then see `P:`).

**Read** — `metadata_account_get` (`ircd/metadata.c:339-408`): `is_compressed`→`decompress_data` (`:368-370`) → `decode_ttl_value` (`:374` / `:392`) → `is_value_expired` (`:384-388` / `:397-401`) → raw copy out. **No vis handling — a `P:` prefix passes through verbatim to every caller today.** `metadata_account_list` (`:637-731`): same decompress (`:691-699`) → TTL-strip + expiry-skip (`:708-716`) → `entry->visibility = METADATA_VIS_PUBLIC` hardcoded at `:724`. The three memory-restore consumers the spec names, at current lines: `metadata_load_account` (via list `:724` PUBLIC), the lazy fill in `metadata_get_client` (`:1062`, fill `:1147-1160`, hardcoded PRIVATE at `:1156`), and the m_metadata GET fallbacks (`:447/:491` — the only ones already decoding). Stale-comment rider: `ircd/persistence_profile.c:261-262/:365-366/:461-462` still claim list returns raw TTL-encoded values (list has decoded since the s5c_restore fix) — the re-get dance there is now redundant; fix or note while touching.

### (d) Doc-mirror capture point

`crdt_shadow_metadata_set(account, key, value, timestamp == 0)` is called at `ircd/metadata.c:482`, after commit, with the **raw pre-TTL, pre-compress `value` argument**. The shadow fn (`ircd/crdt_shadow.c:2257-2281`) gates on shadow_on/reconciling/remote-applying/`metadata_doc_key` (channels rejected `:2239-2240`) and permanent-only (`:2268-2269`), then `crdt_metadata_set` with the value bytes verbatim. **Post-A2 the doc value must be the vis-prefixed raw value** (spec: no TTL wrapper in doc). Since the mirror captures exactly the argument, the correct capture point is: build the `[P:]value` buffer once inside `set_ts` (before `encode_ttl_value`) and pass that same buffer to both `encode_ttl_value` and `crdt_shadow_metadata_set`. Suspend semantics are unaffected (`g_metadata_remote_applying` set by ms_metadata around `ircd/m_metadata.c:1342-1383`).

### Recommendation: **visibility PARAMETER on the three set functions** (not caller pre-prefixing)

Grounded in the caller census: of the 6 value-writers, **3 already hold an explicit vis** (`metadata.c:1239`, `m_metadata.c:738`, `m_metadata.c:1376`), **2 have a fixed conceptual vis** (last_present→PUBLIC, profiles→PRIVATE-by-decision or PUBLIC-for-no-change), and **1 (reconcile `crdt_shadow.c:2335`) holds the already-encoded doc blob** and merely needs a 3-line prefix-split. Nobody is left guessing. Pre-prefixing instead would push the encoding rule into 6+ call sites (and every future one), recreate the §D chokepoint-bypass fuse the P0 `metadata_account_set_raw` deletion just closed, and make double-application (`P:P:`) possible the moment one caller forgets who owns the encode. With a parameter, exactly one function (`set_ts`) owns encode; exactly two (`get`/`list`) own decode; the constraint "ONE encoding, never double-applied" is structural. Suggested shape: add `int visibility` to `metadata_account_set/set_permanent` (12 external call sites total incl. deletes — small, mechanical), keep static `set_ts` as the single encoder, and have `get`/`list` grow a vis out-param (`int *visibility` nullable / `entry->visibility` from decode) so the internal consumers (bouncer/profile/account_conn) keep receiving the STRIPPED value with zero changes.

### Hazards the plan must handle (found in this pass)

1. **Reconcile echo-guard mismatch** — `reconcile_metadata_set_cb` compares `metadata_account_get` output against `docval` bytes (`ircd/crdt_shadow.c:2331-2334`). Post-A2, get returns the STRIPPED value while docval is PREFIXED → permanent mismatch for every private key → a store re-write of every private row on every reconcile tick (no doc-op churn — `g_metadata_reconciling` suppresses the mirror — but constant store writes + bogus "applied" counts). The compare must be vis-aware ((decoded vis + raw) vs split docval).
2. **`P:` literal ambiguity** — a PUBLIC value that legitimately starts with `P:` will round-trip as PRIVATE-with-stripped-prefix under the spec's encoding (absent-prefix=public). This ambiguity has always existed on the GET-fallback read side but A2 makes it a write-side truth. Either escape it (e.g. public values starting `P:` get an explicit public marker) or document it as accepted; today nothing escapes.
3. **Old-peer internal readers** — the spec's mixed-version story ("old peers already parse P: on the GET fallback") covers only m_metadata's GET path. An OLD node reconciling a new prefixed doc value stores `P:x` bare and its **internal** `metadata_account_get` consumers (bouncer hold gating `bouncer_session.c:841` etc., profiles) will read `P:1` where they expect `1`. All `draft/persistence/*` keys are doc-converged permanent rows written PRIVATE, so this bites exactly the bouncer-hold class on stale peers. Fine on an all-upgraded bed; worth one line in the spec's compat paragraph.
4. **Stale-comment debris** (rider): `persistence_profile.c` comments per (c); `metadata_load_account`'s doc comment (`ircd/metadata.c:1400-1404` "Called when a user logs into an account") should list the post-A3 caller set; the load-bearing NOTE at `ircd/metadata.c:1143-1149` (lazy fill "is NOT called on every account-attach path") becomes false once A3 lands and must be rewritten to "backstop only".
