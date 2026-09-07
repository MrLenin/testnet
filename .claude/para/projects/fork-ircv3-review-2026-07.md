# Nefarious fork IRCv3 review — fix backlog (2026-07-21)

Whole-subsystem defensive review of the **production** fork `nefarious` @ `3868b34`
(branch `ircv3.2-upgrade`) — the fork-exclusive IRCv3 code that ships today, distinct
from the `crdt-mesh` experiment (see `crdt-mesh-review-2026-07.md`). Method: 12 parallel
subagent units partitioned by system + a cross-cutting C sweep; every CRITICAL and MAJOR
re-verified against source by hand. Read-only — reachability notes are reasoned from code
unless marked self-verified.

## Bottom line

Unlike the CRDT review (whose bugs sit behind experimental flags), these are on the
**production path** and several are reachable by an ordinary authenticated client. The
findings cluster into four systemic themes. The negative space is also real: the bouncer
hard invariants, storage memory-safety, JWT signature enforcement, and the recent
networking fixes all hold — so these are specific gaps, not rot.

**Open question only the maintainer can answer (gates F-CN1):** is `FEAT_NATIVE_DNSBL`
enabled in the real deployment? If yes, F-CN1 is a live remote whole-server crash.

---

## CRITICAL (fix before shipping)

### F-A1 — SASL `authzid` grants arbitrary account takeover  ★ client-reachable, default-on
`sasl_handle_plain` verifies **authcid**+password against Keycloak but logs the client in
as the client-supplied **authzid**; the authorization check is a bare `TODO`
(sasl_auth.c:795). Callback sets `login_as = authzid[0] ? authzid : authcid`
(sasl_auth.c:692) → `sasl_complete_login(login_as)` (:708). `AUTHENTICATE PLAIN` with
`target\0me\0my-password` logs into `target` — copied into the account field, `+r` set,
target's metadata/hidden-host applied, broadcast network-wide (X3 access, account bans,
`~a:` extbans all follow). Same ungated pattern in OAUTHBEARER/SCRAM/ECDSA; EXTERNAL is
safe. **Amplification:** the positive-auth cache stores `login_as` keyed by the
attacker's own credential hash (:700), and a later cache hit resolves to `authzid ?
authzid : cached_account` (:828) — so the victim's *legitimate* logins then resolve to
the attacker's chosen account until TTL. PLAIN is in the default mechanism list. **Fix:**
reject a non-empty `authzid != authcid` unless the KC-authed authcid is on a trusted
service-account allowlist (RFC 4616); cache the KC-verified authcid, not `login_as`.

### F-MB1 / F-SW1 — unguarded snprintf-accumulator OOB stack write  ★ (Theme T1)
Four sites build a string with `x += ircd_snprintf(0, buf+x, sizeof(buf)-x, …)` in a loop
with **no `x < buflen-1` guard**. Because `ircd_snprintf` returns the *would-be* length
(ircd_snprintf.c:2149), once the content exceeds `buf`, `x` runs past `buflen` and
`sizeof(buf)-x` underflows to a huge `size_t`, so the next append writes out of bounds on
the stack:
- **F-MB1 (client)** `format_batch_open_tags` (m_batch.c:133-158) into `tagbuf[512]`;
  `con_ml_client_tags` (client-controlled, up to 511 bytes) overshoots and the trailing
  `buf[pos++]=' '; buf[pos]='\0'` writes ~2 bytes OOB. Reached by one client with
  `multiline`+`batch`+`message-tags` opening a batch with large client tags.
- **F-SW1 (client-influenced)** bouncer channel-list builders at bouncer_session.c:3640-3648
  (`alias_chans[512]`, BX C alias-sync), :5945-5949 (demote), :7309-7313 (BX C build).
  Here the append writes a **full channel name** OOB — larger than F-MB1 — once an alias's
  channel list exceeds 512 bytes (~20 channels, fewer with long names / join_msgids).
The correctly-guarded twins sit alongside: `build_channel_string` (bouncer_session.c:3516)
and `format_message_tags_with_client` (send.c). **Fix:** add the loop-level `x < buflen-1`
guard and clamp `x` to the actual written length after each `ircd_snprintf`, at all four
sites — and grep for the pattern in case there are more.

### F-CN1 — DNSBL-timeout `assert(0)` → `abort()`: remote whole-server crash  ★ conditional
`auth_ping_timeout` scans `flag <= AR_LAST_SCAN` (= `AR_SASL_PENDING`, index 6) then
handles only `AR_IAUTH_PENDING`; `AR_DNSBL_PENDING` (index 14) is handled nowhere and
falls through to `assert(0 && "Unexpectedly reached…")` (s_auth.c:1237). `FEAT_DNSBL_TIMEOUT`
is **referenced nowhere in the code** (defined only in the feature table) — nothing clears
`AR_DNSBL_PENDING` except the resolver callback. The project `assert` macro calls
`abort()` when `NDEBUG` is unset (ircd_log.h:150), and the shipped Docker build uses
`--enable-debug`. So with `FEAT_NATIVE_DNSBL` on, a client whose DNSBL lookup doesn't
complete before `FEAT_CONNECTTIMEOUT` (60s) crashes the whole server at connect-timeout
(a slow/unreachable DNSBL is enough — attacker or not). On an `NDEBUG` build it instead
wedges the client unregistered forever. **Fix:** add an `AR_DNSBL_PENDING` branch to
`auth_ping_timeout` (cancel `dnsbl_request`, clear flag, `check_auth_finished`) and
actually enforce `FEAT_DNSBL_TIMEOUT`.

### F-BC1 — bouncer alias-setup failure escalates to whole-session teardown  (narrow trigger)
`bounce_setup_local_alias` sets `SetBouncerAlias`/`alias_primary` (bouncer_session.c:7183-7188)
before allocating the numeric; if `SetLocalNumNick` fails (:7236) it returns -1 without
reverting, and the caller (s_user.c:595) does `SetFlag(FLAG_KILLED)` + `exit_client` → the
alias-KILL branch (s_misc.c:357-367) sets `FLAG_KILLED` on the *primary* and exits it →
ACTIVE-killed → `bounce_destroy` + all aliases. Net: a failed second connection kills the
healthy primary and destroys the account session network-wide. Trigger is narrow
(`SetLocalNumNick` fails only at numeric-pool saturation — unreachable on a 3-char/262144
pool with small maxcon). **Fix:** revert the alias transformation before returning -1, or
attempt `SetLocalNumNick` before the count-mutating point of no return.

---

## Systemic themes

- **T1 — unguarded snprintf accumulator (F-MB1, F-SW1×3):** covered above; one shared fix
  shape (loop guard + clamp to written length).
- **T2 — auth/access gated on the wrong identity:** authzid trusted over authcid (F-A1);
  JWT audience/issuer/nbf unchecked so any realm token logs in via OAUTHBEARER (F-K3);
  DM history keyed on the caller's live nick, not account (F-CH1). Each independently lets
  identity A act as identity B.
- **T3 — info-disclosure via reload/framing:** private metadata reloads as public (F-M1);
  raw `T<ts>|`/`P:` storage framing leaks to clients and defeats the private-check on the
  P10 path (F-M2).
- **T4 — use-after-free in teardown:** alias-KILL re-enters `exit_client` on the
  still-tracked alias (F-CN2); S2S multiline keeps a raw `sender` pointer freed only on
  link drop, not on the sender's QUIT (F-MB2).

---

## MAJOR (by system)

**Auth / SASL / libkc**
- **F-K3 — JWT audience/issuer/nbf unchecked** (kc_jwt.c:435-515; only sig+exp-if-present).
  A token minted for any client in the same Keycloak realm validates on OAUTHBEARER
  (sasl_auth.c:1115). No-exp token is eternal. Fix: require+check iss/aud/azp/nbf, enforce exp.
- **F-A2 — SASL relay `fd` OOB read** (m_sasl.c:184): `LocalClientArray[atoi(fdstr)]` from a
  linked peer, no `fd > HighestFd` guard (the guard exists at s_auth.c:3249). Same pattern
  in m_account.c decode_auth_id.
- **F-K1 — webhook fails open** (kc_webhook.c:614): the secret check is skipped when the
  secret is empty (the default), binding an unauthenticated destructive endpoint with no
  warning. **F-K2 — webhook secret compared with non-constant-time `strcmp`** (:616). NB:
  when a secret *is* configured, it is checked before dispatch, so the webhook is **not**
  forgeable — the risk is misconfiguration + timing.

**Chathistory**
- **F-CH1 — DM history via nick takeover** (m_chathistory.c:1069): PM key built from the
  caller's current nick with no account check; DMs are never presence-filtered. Fix: bind
  authed-PM access/keys to the account.
- **F-CH2 — channel-history cross-leak** (m_chathistory.c:1112): channel names (≤200) copied
  into a 62-byte `lookup_target`, truncating the query key to 60 chars while access is
  checked on the full name. Fix: size buffers to `CHANNELLEN+1` or reject over-length.
- **F-CH3 — presence-window loss** (chathistory_presence.c:290): `uint8_t count` overflows
  when the interval cap is set to 0 or ≥256 (no feature-layer min/max), silently deleting
  presence rows after ~255 join/parts. Fix: clamp cap to `PRESENCE_MAX_INTERVALS-1`.

**Metadata**
- **F-M1 — private metadata reloads as public** (metadata.c:735; `set_permanent` takes no
  visibility arg). **F-M2 — `metadata_account_list` omits `decode_ttl_value`** (:668-743) →
  raw framing leaks + defeats the private check on the P10 query. **F-M3 — `ms_markread`
  no validation** (m_markread.c:424): a peer sets an unbeatable lexicographic read-marker,
  permanent + network-wide, no operator reset. **F-M4 — `METADATA CLEAR` wipes
  server-managed keys** the SET guard protects (metadata.c:1298) and skips mode-sync.

**Bouncer**
- **F-BW1/F-BW2 — BX handlers trust wire numerics** (bouncer_session.c:7556, findNUser sites):
  convert-in-place absorbs an arbitrary named client with no account cross-check, and a
  short/malformed numeric resolves to an arbitrary client slot (→ convert or `exit_client`
  it). Server-only surface (needs a linked/buggy peer), but malformed tokens should drop
  cleanly. Fix: require exactly-5-char numerics + account match before mutating.
- **F-CN2 — alias-KILL re-entrancy UAF** (s_misc.c:357-387): untrack the alias before
  recursing into `exit_client(primary)`, or add a top-of-`exit_client` `FLAG_CLOSING`
  no-op guard.
- **F-MB2 — S2S multiline sender UAF** (m_batch.c:2018/2159): invalidate batches whose
  `sender == bcptr` on user exit, or store+re-resolve the numeric.
- **F-MB3 — S2S multiline batch: no timeout reaper / per-link cap** (m_batch.c:1977):
  slot-exhaustion DoS from a peer.
- **F-SW2 — drain-key truncation** (bouncer_session.c:8409): `alias_numeric[6]` copied with
  `sizeof-1`=5 truncates the 5-char YYXXX key → the `strcmp` at :8467 never matches →
  deferred BX for that alias never drains. Fix: full `sizeof`.

**Storage**
- **F-S1 — disk-full recovery is dead code** (db_rocksdb.c): `translate_errptr` has zero
  callers and `DB_ERR_FULL` is never produced, so the `history.c` emergency-evict path never
  fires — on ENOSPC chathistory silently stops persisting. Fix: map ENOSPC → `DB_ERR_FULL`
  and route errptrs through `translate_errptr`.

---

## Selected MINOR / NOTE

- **F-CH4 (MINOR)** `deserialize_message` uses `strchr` on non-NUL-terminated DB values
  (history.c:252/260/268) → OOB read on a corrupt record; use `memchr(end-p)`. **F-CH5**
  unbounded S2S chunk accumulation (m_chathistory.c:2341). **F-MB4** `m_redact` never clears
  the global `client_msgid_override` → stale msgid rides the next tagged send. **F-SW3**
  SCRAM `DupString` without free-first → overwrite-leak on re-entry (sasl_auth.c:1281…).
  **F-CN3** residual plaintext `ERROR` on the SSL/paste listener mask-reject branch
  (listener.c:570 — c4672d0 missed it). **F-CN4** `close(fd)` before `cli_fd=-1` → benign
  re-entrant double-close on non-socket-driven exits (fragile).
- **~13 `ircd_strncpy` stragglers** (metadata.c:971/1530 keys; bouncer 1898/3280;
  history.c quota 2695/2697/2853/2855; m_chathistory.c 1097/1112) — 1-char data loss at
  max-width inputs; part of a 66-site systemic `sizeof(x)-1` idiom. Batch-fixable.
- **F-M5/F-M6/F-M8** read-marker/metadata limits: markers never expire, no per-account cap,
  MARKREAD unrate-limited; no `MAX_KEYS`/`MAX_VALUE_BYTES` on the S2S/oper metadata paths.

## Verified sound — negative space (don't re-investigate)

- **Bouncer hard invariants** (1/2/3/5/6/9) hold; client cannot reach BS/BX (server-only);
  m_bouncer authorization and auto-resume identity gates are correct; promotion race
  converges deterministically; UserStats is flag-keyed and balanced.
- **Storage** memory-safety: bounds-checked deserialization, correct iterator/errptr
  lifecycle, NUL-separated injection-proof key encoding, atomic cross-CF writebatch.
- **SASL/libkc**: no KC-error→success mapping; async-callback UAF protection (fd+cookie,
  not `Client*`); JWT **signature verified and required** (no `alg:none` acceptance);
  base64 sound; webhook HTTP parser bounds-safe; curl lifecycle + TLS verification correct;
  URL builders escape all user input.
- **Networking**: the FD-leak fix (e74e7fc), plaintext-suppression (c4672d0, except the one
  missed branch), SSL_pending drain, send-buffer close-during-send re-entrancy, and
  auth-callback-after-free are all in place.
- **C sweep**: Client-vs-Connection accessor use is clean (no misuse); most raw `strcpy` are
  exact-sized/guarded; alloc pairing is clean except the SCRAM leak.

## Recommended fix order

1. **F-A1** (SASL takeover) — highest impact, client-reachable, default-on, localized fix.
2. **T1 overflows** (F-MB1 + F-SW1×3) — client-reachable memory corruption; one shared
   guard-and-clamp pattern; grep for more accumulator sites.
3. **F-CN1** — check whether `FEAT_NATIVE_DNSBL` is enabled first; if so, this is a live
   remote crash and jumps to the top.
4. **T2 auth-identity** (F-K3 JWT audience, F-CH1 DM-by-nick) and **T3 metadata privacy**
   (F-M1/F-M2) — the disclosure tier.
5. **T4 UAFs** (F-CN2, F-MB2), then F-BC1 and the remaining per-system MAJORs; batch the
   `ircd_strncpy` stragglers.

## Coverage / what wasn't reached

- Static, read-only — no build/bed run; skew/exhaustion/timing findings reasoned from code.
- Bouncer alias channel-sync group (`bounce_sync_alias_*`) and `bounce_compute_effective_away`
  bodies were flagged by the core-model unit for a second pass on counter discipline.
- `make_ban`/`pretty_extmask` parity, WebSocket frame decode fuzzing, `paste_listener.c`,
  and X3-side SASL were out of scope.
- The `m_account.c` LOC-stamp `ircd_strncpy` stragglers (memory) are outside the swept file
  set — re-check separately.

## F-BC1 deferred test (2026-07-21)
Fix shipped as reorder (SetLocalNumNick hoisted to top of bounce_setup_local_alias). The catching
test is fault-injection — stub/wrap SetLocalNumNick to return 0, drive bounce_setup_local_alias for
an account with a live local primary, assert: sptr not IsBouncerAlias, alias_primary NULL,
UserStats.{announced_clients,local_announced_clients,opers,inv_clients} and nick hash unchanged
(FindUser(nick) -> primary), primary's session still ACTIVE with aliases intact. Deferred because
bouncer_session.o cannot link in the cmocka harness without the whole ircd, and numeric-pool
exhaustion is impractical to force live. Coarse behavioral proxy: debug build with a tiny nn_mask,
exhaust the pool, attach an alias, verify the session survives.

## Candidate finding (F-BC1 reviewer FYI, 2026-07-21): numnicks.c SetLocalNumNick pool-exhaustion assert
numnicks.c:401-403: `assert(count < NN_MAX_CLIENT)` sits immediately before the graceful `return 0`
pool-exhaustion path. On asserts-enabled builds, numeric exhaustion aborts the process inside
SetLocalNumNick before any caller recovery (register_user reject, F-BC1 pristine-failure path) can
run. Same assert-as-error-handling family as F-CN1's auth_ping_timeout assert(0). Pre-existing,
untouched by F-BC1. Candidate for a later hardening batch: drop the assert or convert to log+return 0.

## F-A2 fix decision (2026-07-21): guard on MAXCONNECTIONS, not HighestFd
The finding text pointed at the s_auth.c `id > HighestFd` idiom as the guard to mirror. Corrected
during implementation (maintainer fd-reality catch): HighestFd is a mutable runtime high-water mark,
not the array bound. LocalClientArray is `[MAXCONNECTIONS]` (config.h, --with-maxcon), indexed by raw
socket fd, and os_set_fdlimit() caps real fds below MAXCONNECTIONS. The array is sparse in practice
(e.g. ~78 live fds of 4096), so the pre-existing `!LocalClientArray[fd]` NULL check already rejects
in-bounds-unused slots; the only true OOB is `fd >= MAXCONNECTIONS`. Shipped guard: `fd >= MAXCONNECTIONS`
at m_sasl.c ms_sasl and m_account.c decode_auth_id (fd is unsigned -> the one >= test also catches a
negative-wrapped atoi result). The existing s_auth.c:3268 `id > HighestFd` guard is stricter-but-safe
(HighestFd < MAXCONNECTIONS always) and not a bug, so left untouched.

## F-K3 empirical token facts (live testnet realm, 2026-07-21)
Minted a real ROPC access token (realm testnet, client x3-services, user testuser) and decoded it:
  iss = http://172.16.11.230:8080/realms/testnet   (KC FRONTEND url, NOT libkc's internal http://keycloak:8080)
  aud = "account"   (NOT the client -> validating aud against client_id would reject all legit tokens)
  azp = "x3-services"   (the authorized client -> THIS is the only claim identifying the issuing client)
  exp present, nbf ABSENT, typ=Bearer.
Implications for the fix: (1) require exp present (close eternal no-exp hole); (2) check nbf only if present
(KC omits it); (3) client binding must be azp-allowlist, NOT aud; (4) iss validation needs a configured
expected-issuer URL because internal base_url != frontend issuer url -- cannot be derived from realm.base_url.
JWKS signature verification already cryptographically binds the token to the realm keys, so iss is
defense-in-depth; azp-allowlist is the load-bearing check for 'any realm client can log in'.

## F-K3 FOLLOW-UP (Batch 2 review, 2026-07-21): OAUTHBEARER introspection-fallback policy bypass
F-K3 enforces iss/azp only on the LOCAL JWKS-validation path. The introspection fallback
(sasl_auth.c sasl_oauth_introspect_cb) logs in on active+username with NO iss/azp check, and libkc's
introspect-response parser (kc_keycloak.c OP_INTROSPECT ~line 780) does not populate info->iss/azp.
Reviewer verdict: DETERMINISTIC bypass, not theoretical -- any Keycloak client configured with a
non-RS256 signing alg ALWAYS misses local validation (kc_jwt only supports RS256) and lands on the
unprotected fallback, so a token from ANY realm client authenticates. Also a post-key-rotation window.
Fix options: (a) fail-closed reject in the introspect cb when issuer/allowed-clients configured and
not insecure; (b) full -- populate iss/azp from the introspect JSON in libkc + reuse the policy check;
(c) loud log only. In insecure mode (testnet) the fallback is a non-issue (policy bypassed).

## Deferred-items assessment (2026-07-21, read-only agent pass)
Investigated the limit/policy MINORs to decide fold-vs-defer before the crdt rebase.

- **F-M6 (metadata per-account cap bypass) -> FOLD-IN-NOW, mechanical (~25-40 LOC).** Cap (20 keys/300B, FEAT_METADATA_MAX_KEYS/MAX_VALUE_BYTES) IS enforced in metadata_cmd_set (m_metadata.c:728-762) but BYPASSED by the oper SET *account path (m_metadata.c:652-699, local-only) and ms_metadata S2S handler (m_metadata.c:1351-1532, network-wide, re-relays). Both write PERMANENT uncapped entries via metadata_set_client (metadata.c:1147-1233, no cap logic of its own). Fix = extract the existing check into a helper, call from both bypass sites. ADJACENT BUG: ms_metadata caches the same key it just wrote permanently as a 4h-TTL entry (m_metadata.c:1447-1491 vs :1427) -> silently downgrades permanent S2S user metadata to TTL on relaying servers -> swept ~4h later. Data-loss, 2-line fix, right next door.
- **F-CH5 (unbounded S2S chunk realloc) -> FOLD-IN-NOW, mechanical (~20-30 LOC).** append_write_chunk_data (m_chathistory.c:2336-2346) and its TWIN append_chunk_data (m_chathistory.c:3281-3291, review missed this) do unconditional *2 realloc with NO ceiling. MyRealloc failure -> nomem_handler -> exit(2) = WHOLE-DAEMON CRASH. Trigger: a single linked peer streaming +continuation lines at wire speed (parse_server has no fakelag). 64-slot cap exists (global, shared -> slot-exhaustion DoS across peers too) + per-link cleanup is wired (s_misc.c:324). Ready-made clamp constant: HISTORY_CONTENT_LEN(4096)/FEAT_MULTILINE_MAX_BYTES(16384) base64-expanded. Server-only surface (needs a linked peer) but crash-class -> fold in.
- **F-M5 + F-M8(MARKREAD half) -> DEFER-WITH-SCOPE (one ticket, not two).** SAME underlying gap: NO per-account cap/TTL on readmarkers_cf; markers never expire, targets not validated (any authed client mints unlimited (account,target) rows). readmarkers_cf has no purge (metadata_account_purge_expired is metadata_cf-only, metadata.c:842). Needs a POLICY DECISION on the cap's SHAPE, not just a number: (a) TTL-since-set [semantically wrong - a monthly-checked channel would vanish], (b) LRU count-cap [need FEAT_READMARKER_MAX_ENTRIES default, no precedent], (c) membership/account-deletion-driven [crosses into X3 DROP territory]. F-M8 "unrated-limited" framing corrected: MARKREAD has generic MFLG_SLOW fakelag like every cmd; the real gap is the accumulation cap = same as F-M5.
- **NEW/IMPORTANT: no storage backstop at all.** METADATA_MAP_SIZE (100MB, metadata.c:93) passed as size_max/size_floor is VESTIGIAL libmdbx-era; RocksDB backend (db_rocksdb.c:230-350) never reads it. So the 100MB "safety net" a maintainer might assume for F-M5/F-M6 is a NO-OP. Same size_max/size_floor pattern likely also in history.c + webpush_store.c (unverified). Consider a real RocksDB-level or app-level storage cap as its own item.

## Cheap-MINOR triage (2026-07-21, read-only agent pass) — all CONFIRMED-MECHANICAL
Verified against ircv3.2-hardening @ 06b191e. ~24-27 LOC / 7 files for the trivial set.
- F-CH4 (history.c:252/260/268 strchr on non-NUL DB value -> OOB read on corrupt record; fix strchr->memchr, sibling :288/:302 already do). 3 LOC. Corruption defense-in-depth.
- F-SW3 (sasl_auth.c SCRAM DupString w/o free-first: real sites are :1372/:1398/:1404 + :1493, NOT the review's :1281 which drifted). ~6-9 LOC. HARDENING ONLY - traced, no live double-call trigger under current sasl_continue WAITING_KC gate; label as such, don't overclaim.
- F-MB4 (m_redact.c:313 + :418 set client_msgid_override, NEVER clear; all 14 other users pair set+NULL e.g. m_tagmsg.c:264->:280). REAL correctness bug: stale REDACT msgid stamps next tagged send -> msgid collision. 2 LOC (add set_client_msgid(NULL) after each propagate).
- F-CN3 (listener.c:570 mask-reject branch sends raw "ERROR :Use another port" with NO ssl/paste guard; c4672d0 guarded the other 2 branches :535/:555). REAL, client-reachable (masked TLS/paste listener). 1-2 LOC (copy the guard).
- F-CN4 (bouncer_session.c:5193/:5211 in bounce_revive: close(cli_fd(ghost)) with no cli_fd=-1; sibling bounce_rebind :5700-5701 does it right). 2 LOC. HARDENING ONLY - benign today (fd overwritten at :5216 before any early return), fragile to future edits. s_bsd.c close paths are all CLEAN (e74e7fc) - NOT the F-CN4 site.
- strncpy stragglers: 10 CONFIRMED sites (metadata.c:971/1530, bouncer_session.c:1898/3280, history.c:2695/2697/2853/2855, m_chathistory.c:1097/1112). 10 LOC/4 files. m_account.c DROPPED - already fixed f53a8e9 (confirms memory project_strncpy_truncation_stragglers; backlog 're-check separately' now RESOLVED). CAVEAT: m_chathistory.c:1097/1112 share lines with MAJOR F-CH2 (62B lookup_target vs 200-char channel) - mechanical -1 does NOT fix F-CH2. Full 66-site population not re-swept (would need c-auditor).
- Bonus (m_metadata.c:956): METADATA key-length validator `> METADATA_KEY_LEN` is itself off-by-one vs the 64B buffer (64-char key passes validation, can't fit). Adjacent to F-M6. Flag only.

## Deferred-item DESIGN DIRECTION (maintainer, 2026-07-21)

### F-M5/F-M8 read-marker storage -> SHAPE RESOLVED (account-keyed; cardinality by session type)
Maintainer direction (2 msgs): "minimal storage needed to produce the needed function.
Bouncer profiles may need unique storage per [profile]. non-bouncer probably not." +
clarification: "bouncers may need *multiple storage* while account sessions would
probably only need single."
=> The distinction is STORAGE CARDINALITY, not persist-vs-ephemeral. (Earlier capture
   wrongly said non-bouncer = no persistence -- corrected.)
  - Key read-markers by ACCOUNT, not nick -- fixes the nick-reuse read (same class as
    F-CH1) and gives cross-disconnect persistence (F-M5).
  - BOUNCER sessions: MULTIPLE records -- one per profile, since each profile is a
    distinct view with its own read position => key (account, PROFILE, target).
    See [[project_bouncer_profile_model]].
  - PLAIN ACCOUNT sessions: SINGLE record per target, no profile dimension =>
    key (account, target).
  - "Minimal storage needed to produce the needed function" = exactly one read position
    per (account[, profile], target); don't over-store.
  - Growth bound: the working set is legitimate (targets a user actually reads); pair
    with target validation (only store for real channels/nicks, not arbitrary strings)
    so an authed client can't mint unlimited junk rows -- that, not a blind TTL/LRU cap,
    is the F-M5 fix. Ties to [[project_chathistory_design_intent]] (presence-gated).
  Still a deferred ticket (implementation not started), but the shape is now concrete.

### METADATA_MAP_SIZE / storage backstop -> RE-SPEC FROM SCRATCH
Maintainer: "I don't remember exactly how METADATA_MAP_SIZE was supposed to work; we
should maybe spec it like new." => It's a vestigial libmdbx-era constant the RocksDB
backend never reads (confirmed db_rocksdb.c). Do NOT try to reverse-engineer intent;
treat as a NEW design: brainstorm a real storage-limit mechanism for the RocksDB stores
(metadata, chathistory, readmarkers, webpush, bouncer-session) -- app-level quota vs
RocksDB-level, per-store vs global, eviction vs reject. Use the brainstorming skill when
picked up; own spec doc. Deferred, does not gate the rebase.

## Batch 4 verification side-observations (2026-07-22, controller code-reading — NOT fixed, triage at final whole-branch review)
- **Metadata visibility not round-tripped through persistence:** the lazy-restore path (metadata.c ~1097-1113) sets `entry->visibility = METADATA_VIS_PRIVATE` UNCONDITIONALLY — public keys come back private after restart (fail-safe direction, availability quirk not a leak). Separately, ms_metadata's S2S cache arm stores private values with a literal `P:` prefix inside the value (m_metadata.c ~1482) that no read path strips — restored values can carry `P:` garbage. Whole visibility-persistence story needs a design pass (candidate for the metadata storage-cap ticket).
- **Channel metadata persistence asymmetry:** local channel SETs are in-memory only (`metadata_set_channel` never persists; `metadata_channel_persist` has ZERO callers) while S2S-received channel metadata persists as TTL rows via ms_metadata's cache arm. Asymmetric + surprising; sole channel-persistence path is the S2S cache arm (which Batch 4 commit 2 deliberately keeps for channels).
- **Stale comment:** m_metadata.c ~701-706 claims server-managed prefixes are "bouncer/, session/, system/" but the real list (metadata.c server_managed_prefixes) is only `draft/persistence/`. Cosmetic; fix opportunistically.
- **metadata_valid_key() (metadata.c, PUBLIC) has the same `> METADATA_KEY_LEN` off-by-one** fixed in m_metadata.c's is_valid_key by Batch 4 commit 3 — currently DEAD CODE (zero callers, grep-confirmed by Batch 4 implementer 2026-07-22). Fix or delete in the mechanical MINOR sweep.

## Batch 5 controller analysis — multiline delivery (F-MB2/F-MB3), 2026-07-22 (verified vs source @ 2fbe666)
- **F-MB2 (sender UAF) CONFIRMED.** S2SMultilineBatch.sender is raw Client* (m_batch.c:1899), read at deliver_s2s_multiline_batch:2151. Sole cleanup s2s_multiline_cleanup_link fires from exit_one_client ONLY for IsServer (s_misc.c:324-325). A remote USER sender QUITing while its link stays up dangles ->sender. FIX: add `void s2s_multiline_cleanup_sender(struct Client *sender)` (free batches where ->sender==sender, mirror cleanup_link body), declare in include/m_batch.h, call at TOP of the IsUser(bcptr) block in exit_one_client (next to ephemeral_purge_session:336) so it runs for aliases/ghosts/normal users before any early return. Free-by-sender + free-by-link both null the slot → no double-free in a squit cascade (each batch freed once, then slot NULL).
- **F-MB3 (slot-exhaustion DoS) CONFIRMED.** create_s2s_multiline_batch (m_batch.c:1998) scans MAXCONNECTIONS(4096) for a free slot; no per-link cap, no timeout reaper. add_s2s_multiline_message DOES cap per-batch bytes/lines (2104-2117) so per-batch memory is bounded; the DoS is global slot exhaustion via many unterminated +batch starts. FIX (two-part): (a) per-link cap — count batches with ->link==link in create, refuse (return NULL + L_WARNING) at >= S2S_ML_MAX_BATCHES_PER_LINK; (b) opportunistic stale-reap in create — before allocating, free batches with (CurrentTime - start_time) > S2S_ML_BATCH_TIMEOUT. Per-link cap is the hard DoS bound (cap * num_servers « MAXCONNECTIONS); reap is hygiene for stale-within-quota. DECISION for brief: opportunistic reap (no new event timer) — bounded staleness acceptable given the cap; note the no-timer choice per feedback_no_silent_defer.
- **Bonus double-truncation in same functions:** create_s2s_multiline_batch:2006-2009 copies batch_id[16]/target[CHANNELLEN+1] via `ircd_strncpy(dst, src, sizeof-1)` then manual NUL — 1 char short; a 15-char batch_id truncates to 14 → find_s2s_multiline_batch strcmp mismatch → continuation/terminator lost. Fold `sizeof-1`→`sizeof` (drop the now-redundant manual NUL or keep it harmless) into the F-MB commit since these are the touched functions.

## Batch 5 accepted-risk / deferred (documented decisions, 2026-07-22)
- **BX X receive-side destroy is an inherent trust primitive.** `bounce_alias_destroy` (bouncer_session.c:8004) will `hRemClient`+free ANY resolved client; the wire (`BX X <numeric>`) carries no account, and on a replica a held ghost arrives as an ordinary remote user (flags are origin-local, comment 8017-8024). After Batch 5 the 5-char strict resolver stops MALFORMED numerics from mis-resolving, but a well-formed BX X for an unrelated numeric from a buggy/hostile peer still destroys it. UNCLOSABLE without adding an account field to the BX X wire format (protocol change, out of hardening scope). Do NOT gate BX X on IsBouncerAlias||IsBouncerHold — breaks replica held-ghost destroy.
- **BX P (promote) account-equality DEFERRED.** bounce_alias_promote (6924) does membership transfer + exit_client(old) with no account-equality between old/new. Batch 5's strict resolver covers the MALFORMED-numeric case; the residual (well-formed cross-account swap from a buggy peer) is the same trust-boundary as BX X above. Cheap to add later (`ircd_strcmp(cli_account(old),cli_account(new))` before swap) if a threat case emerges.

## Batch 5 residual F-BW2-class sites (DEFERRED with rationale, 2026-07-22)
Implementer's findNUser audit + controller follow-up folded BX E/M into F-BW2 (commit c1ecb95). Remaining raw/constructed-numeric findNUser sites NOT converted, needing their own audit (do NOT blind-swap):
- **bounce_visibility_membership (bouncer_session.c:918)** `findNUser(alias_full)` — HELPER taking alias_full as a param + broadcasting BX V. Safety depends on callers: the BX V receive handler (bounce_alias_visibility ~9284, now bx_find_user_strict-guarded) is one caller; needs confirmation ALL callers pass a validated 5-char numeric before this is declared safe. If any caller passes raw wire, add the guard here too.
- **BS A/H/D full_numeric sites (bouncer_session.c:4138, 4247)** `findNUser(full_numeric)` where full_numeric = ircd_snprintf("%s%s", cli_yxx(sptr), parv[N]) into [6]. NARROWER than BX E/M: the LIVE sender's 2-char server prefix (cli_yxx(sptr)) bounds mis-resolution to the sender's OWN server client space, not arbitrary. Different token family (BS, not BX). Needs analysis of whether a malformed parv suffix + the snprintf truncation can still misdeliver within the sender's server. Lower severity; separate audit item.
- 1111 (hs_origin+hs_ghost_numeric, internal), 4503 (winner_numeric, internal), and all `hs_aliases[i].ba_numeric` sites = roster-internal, SAFE (not wire).

## Batch 5 review MINORS -> final whole-branch review triage (2026-07-22)
- **hs_ghost_numeric sizeof-1 + manual-NUL anti-pattern** @ bouncer_session.c 3233/4141/4231/4996 — CURRENTLY HARMLESS (stores 3-char XXX into char[6], no data loss unlike F-SW2's 5-char case). Same class as F-SW2/F-MB3-bonus; fold into the strncpy MINOR sweep for consistency, not urgency.
- **F-MB3 create_s2s_multiline_batch does 2 O(MAXCONNECTIONS) passes** (reap+count, then free-slot scan). Correct (2nd scan benefits from reaped slots); collapse to 1 pass only if profiling ever flags it. Negligible.
- **F-BW1 happy-path (matching-account convert-in-place) has no integration test** — convert-in-place is a burst-ordering race the code says "should effectively never fire"; not deterministically constructible from Vitest. Mismatch-refusal canary is covered by code review. Accept as review-verified-only.

## NEW FINDING (2026-07-22, discovered via Batch 5 valgrind) — F-DS1: Invalid read in DESYNCH broadcast (CRASH-CAPABLE, PRE-EXISTING, not Batch 5)
- **F-DS1**: `sendwallto_group_butone` (send.c:3061) does an `Invalid read of size 8`, reached from `ms_desynch` (m_desynch.c:110). Triggered on nefarious2 by inbound S2S DESYNCH traffic during the Batch-5 cross-server test; caused a valgrind "the 'impossible' happened / signal was supposed to be fatal" abort → container exit 1. **NOT a Batch 5 regression**: proven by (a) no Batch-5-changed function appears as a fault frame (only benign whowas "still reachable" leak records reference bounce_alias_destroy→remove_client_from_list), (b) the PRIMARY server ran the IDENTICAL binary through the SAME test with 0 valgrind errors — the difference is nefarious2 processed DESYNCH/MARK S2S traffic the primary didn't. Pre-existing in the DESYNCH→WALLOPS-to-group path.
- **Severity: candidate CRITICAL** — an Invalid read in a broadcast send path reachable from a peer-sent DESYNCH command is a potential remote-triggerable SIGSEGV in a non-valgrind (production) build. Needs its own focused fix: audit sendwallto_group_butone's iteration (send.c:3061) for a freed/NULL client or a stale list cursor when invoked from the ms_desynch path. Full valgrind stack saved at scratchpad/nef2-valgrind.log during this session.
- Related recurring noise (likely same subsystem, separate): "Protocol Violation: MARK from non-server leaf2/leaf3" repeating in nefarious2 logs — a MARK-token routing/source-check quirk among linked nodes; unverified whether connected to F-DS1.

## F-DS1 RESOLVED 2026-07-22 (both producer classes) — was: sharpened root-cause
- **Mechanism:** send.c:3061 `cli_fd(cli_from(cptr))` expands to `((cptr->cli_connect)->con_client)->cli_connect->con_fd` — a double pointer-chase over every LocalClientArray[i] during the WALL_DESYNCH broadcast (from ms_desynch). The `< 0` guard is meant to skip dead-sink (fd=-1) clients, but the guard ITSELF derefs the chain, so if `cptr`'s Connection (cli_connect) was freed while LocalClientArray[i] is still populated, the read faults BEFORE the guard can skip it. Invalid read of size 8 = reading a freed Connection/Client pointer in the chain.
- **Trigger:** DESYNCH S2S traffic during teardown churn (a local connection whose Connection was freed but whose LocalClientArray slot wasn't nulled, or a client whose cli_from routes through a freed struct). Fired on nefarious2 (which received the DESYNCH), not the primary.
- **Fix direction (needs its own focused pass, candidate bouncer-analyst/c-auditor):** guard the loop against a dead/NULL Connection before the cli_from chase — e.g. skip when `!cli_connect(cptr)` or `IsDead(cptr)` first; AND/OR audit the teardown ordering that leaves a LocalClientArray entry with a freed cli_connect (the deeper bug — same class as the general "iterate LocalClientArray, deref cli_from without validity guard" pattern; check the other WALL_* broadcasts and similar loops). Do NOT just add a NULL check and call it done without understanding why the slot is stale — that's symptom-patching. Full valgrind stack: scratchpad/nef2-valgrind.log.

## F-DS1 RESOLUTION (2026-07-22): TWO producers, both fixed + validated
- **Class B — EBADF** (s_bsd.c ET_ERROR, commit 2db86e7): nulls cli_fd before clearing the fd-indexed slot; index lost, close_connection can't recover. Fix: clear LocalClientArray slot before nulling cli_fd (matches close_connection/bounce_revive idiom).
- **Class A — bounce_alias_destroy BX X on LOCAL alias** (commit a4eca89): on the alias's OWNING server, a network KILL cascade delivers BX X for the server's own local alias (MyConnect); handler assumed remote-only, remove_client_from_list w/o close_connection -> pooled-in-array -> desynch crash. Fix: (1) MyConnect branch does full canonical local-alias teardown (IPcheck/Count/userstats_count_clear/del_list_watch/close_connection), (2) free_client identity-guarded backstop clears any local client's slot at free time. This was the producer the alias-KILL test actually triggered (NO EBADF in logs). Validated: nef2 RestartCount=0 + valgrind-clean across 3 repro + stress cycles (was crash-on-first-run before).
- DEFERRED (analyst-flagged, separate): (a) s_bsd.c:1673 alias ET_ERROR branch checked before FLAG_CLOSING guard@1713 (re-entrancy, F-CN2 family); (b) WALL_ loop `assert(!cptr||cli_verify(cptr))` debug-only sweep to surface FUTURE Class-A producers deterministically; (c) ~200MB still-reachable Connection leak on the skipped-close_connection path (a4eca89's close_connection likely closes it — reconfirm).

## NEW FINDING (2026-07-23, discovered via crdt-mesh invariant-2 sweep) — F-BX-M1: NumNick(&me) NULL-deref in deliver_s2s_bxm_batch (PRODUCTION, not crdt)
Found while sweeping the crdt-mesh branch for invariant-2 (userless-source) crashes; the site is BASE bouncer code present on BOTH branches, so it's a **production** finding.
- **Site (production nefarious @ a4eca89):** `bouncer_session.c:8839` `from = &me;` graceful-fallback when the BX-M batch sender vanished mid-batch, then `NumNick(from)` (multiline batch-id build) + `cli_user(from)->host` deref `cli_user(&me)` = NULL → crash. (crdt-mesh copy: bouncer_session.c:9490/9500/9511.)
- **Gate:** the receiving local alias has BOTH `CAP_DRAFT_MULTILINE` and `CAP_BATCH` active AND the BX-M source user vanished between batch open and delivery (narrow cross-server race). Same userless-source class as F-DS1/C5/F-CN2.
- **Fix shape:** guard `from == &me` before the multiline-batch branch — either skip the batch-wrapped delivery (deliver inner messages plainly) or drop the undeliverable batch; must not `NumNick`/`cli_user`-deref a serverless `&me`. Needs a read of deliver_s2s_bxm_batch's non-batch path to pick the graceful degradation; bouncer-analyst if the session semantics are unclear.
- **Status:** NOT fixed on production. The crdt-mesh copy is being fixed in Phase-3 batch P3-2 (that tree is in active scope); the production twin on `ircv3.2-hardening` needs the identical guard — flagged to maintainer, not auto-applied (crdt-only was the active directive; a prod bouncer fix is a scope decision). Low urgency (narrow race) but a real remote-triggerable NULL-deref on the shipping path.
