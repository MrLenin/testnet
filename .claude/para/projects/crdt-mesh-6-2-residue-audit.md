# MR-6-2 — tree-broadcast residue + hunt_server disposition audit

Audited 2026-07-29 against `nefarious-crdt` @ `crdt-mesh` (post-MR-6-1, `6b79a41`). Scope:
`crdt-mesh-mr6-cutover-scope.md` §2.3/§2.4 + the §1 gap table.

**Provenance / coverage honesty.** Three c-auditor sub-agents were dispatched and **all three
returned** (group 1 = core state/bouncer/crdt/svs, 153 sites; group 2 = IRCv3/ephemeral/
global-state/notify, 109 sites; the IsServer-exact lookup sweep). The primary agent had already
completed an independent full sweep while they ran, so **every area is double-covered** and the
disagreements below were adjudicated by hand against the source.

- `[own]` = primary agent's sweep: a scripted enumeration of all 250 broadcast call sites in
  `ircd/*.c` (regex over the five broadcast primitives, each with a 14-line preceding-context
  window auto-scanned for `sendcmdto_set_skip_crdt_servers` / `crdt_*` adjacency), plus direct
  reads of the send.c dispatch loops, `hunt_server[_prio]_cmd`, the CRDT doc schema
  (`include/crdt_state.h`), the CR M / CR X letter dispatch (`m_crdt.c`), and ~30 individually-read
  ambiguous call sites.
- `[g1]` = group-1 sub-auditor (153 sites: 139 broadcast calls + 14 `->down` walks).
- `[g2]` = group-2 sub-auditor (109 instances across 38 files, paren-balancing sweep — it also
  caught 4 manual `->down` loops the primary's five-primitive regex could not see).
- `[srv]` = IsServer-exact lookup sub-auditor (18 `FindServer` + 29 `find_match_server` +
  11 `UserStats.servers` sites, all read in context).

**The primary agent's sweep was wrong in five places, all corrected below** and each re-verified by
hand against the source before the sub-auditor's finding was accepted:

1. **The crash section** (was "none new" — there are **two**: `ms_squit` and a latent `mode_parse`
   ternary). `[srv]`
2. **`sasl_auth.c:640-653`** (was doc-redundant — there is **no** `crdt_shadow_user_add` in that
   block; verified by reading :625-665). `[g2]`
3. **The `m_cap.c` `"*"` wildcard mechanism** (was "reads 0 and stops advertising" —
   `querycmds.c:48` initialises `UserStats.servers = 1`, so the branch is *vacuously true* and the
   defect is the opposite one: it advertises a cap whose relay blackholes). `[srv]`
4. **The whole "user_add makes it doc-redundant" class** — `crdt_shadow_user_add` **self-skips for
   a mesh-homed target** (`from_crdt_peer(cli_from)` single-writer gate). So for ACCOUNT, SVSINFO,
   SVSIDENT and server-sourced user MODE, the doc mint covers only *local/legacy-homed* targets;
   the mesh-homed leg has no carrier at all. This reclassifies 8 sites from doc-redundant to
   CR-carrier-needed. `[g1]`
5. **`m_svsnoop.c:141`** (was accept-dead — it is a per-node *apply*, so a mesh-homed target server
   never applies it). `[g1]`

Where a verdict rests on live-gate evidence rather than a code-visible doc twin, the row says so.

**Ruling applied (decision #4, 2026-07-29): PURE OVERLAY apart from the gateway.** CRDT nodes keep
**no dormant break-glass P10 Connect blocks**. Every verdict below is classified against a world
where *the only P10 links in existence are gateway↔legacy and gateway↔x3*. "Still works because
some P10 path happens to exist between CRDT peers" is **not** an accepted resting state and appears
nowhere as a verdict.

## Routing mechanics baseline (verified this pass)

- All five broadcast primitives walk `cli_serv(&me)->down` (send.c:1709 / 1887 / 2026 / 2148 /
  3194). **Overlay edges and anchors are never in `->down`** → on an overlay-only leaf every
  broadcast is a local no-op; on the gateway it reaches legacy + x3 only.
- `sendcmdto_set_skip_crdt_servers()` (send.c:144, consumed at :1780/:1958/:2707) is the one-shot
  demotion flag: a call site that sets it is already CR/doc-carried by design.
- **Anchor lookup matrix** (drives §3): `FindServer()` = `hSeekClient` masked `STAT_ME|STAT_SERVER`
  (hash.h:61) → **anchor-BLIND**. `find_match_server()` walks `server_list[]` with **no status
  check** (numnicks.c:447) → **finds anchors**. `FindClient()` (anchors are `hAddClient`'d,
  crdt_shadow.c:2297) and `FindNServer()` (`SetServerYXX`, crdt_shadow.c:2293) → **find anchors**.
- `sendcmdto_one(from,…,to,…)` resolves `to = cli_from(to)`; an anchor's Connection is a fresh
  dead sink (fd = −1, crdt_shadow.c:2261) → **silent drop, no crash**. This is the "silent-dead"
  shape behind every hunt_server row.
- Doc schema available for "is there a twin?" judgements (`include/crdt_state.h:66-95`,
  `include/crdt_shadow.h`): `CrdtUserRecord` carries nick/ident/host/realhost/**realname**/
  **account**/**swhois**/**away**/**version**/**sslclifp**/**countrycode**/**continentcode**/
  **umodes**/ip/nick_ts; plus collections for channels/members/member_status/kick_info/topics/
  modes/bans, silences, tempshuns, metadata, read-markers, webpush subscriptions,
  gline/shun/zline/jupe, bsess/bconn/blease, ch_storage, decommissions.
- CR carrier letters in use — **CR M**: `P N T` (privmsg/notice/tagmsg), `K` kill, `I` invite,
  `I`+target `*` = SASL cache-inval, `W` all-server WALLOPS, `U`+target `*` = WALLUSERS,
  `c h v` wallchops/hops/voices. **CR X**: `A` sasl, `C` account, `G` register, `V` verify,
  `R` regreply, `Q` xquery, `Y` xreply, `J P M D N` svs-family, `B` bouncer-transfer,
  `H` chathistory (m_crdt.c:551-572, :677-694, :946-1134).

## CRASH-risk findings (invariant-2 class) — **TWO, both real; they jump the queue**

The primary agent's sweep concluded "none new"; the `[srv]` sub-auditor found two, and **both were
re-verified by hand against the source this pass**. They precede every carrier in §6.

### CRASH-1 — `ms_squit` numeric fallback frees an anchor out from under its users `[srv]`

`ircd/m_squit.c:75-79`:

```c
acptr = FindServer(server);      /* STAT_ME|STAT_SERVER mask -> MISSES anchors */
if (!acptr)
  acptr = FindNServer(server);   /* server_list[] -> FINDS anchors */
```

The `FindServer` miss is silently repaired by the `FindNServer` fallback, which resolves the
**anchor**. Execution then proceeds into `exit_client`, where `IsServer(victim)` is **false** for a
`STAT_MESH_SERVER`, so the SQUIT branch (downlink teardown, held-user exit, `remove_dlink`) is
skipped and `exit_one_client` frees the server Client **while its materialized users still point at
it** — `cli_from` / `cli_user->server` use-after-free. A Case-A converted stub additionally leaves a
dangling DLink in `cli_serv(&me)->down`, and `crdt_mesh_stub_dec` never runs.

**Reachability:** low in steady state — SQUIT is suppressed among CRDT peers (R7a) — but any
numeric-form SQUIT that reaches this handler triggers it, and MR-6 makes anchors the steady state
for *every* remote server, so the population of possible victims goes from "the partition case" to
"all of them". **Fix: `if (IsMeshStub(acptr)) return 0;`** (or route to
`crdt_shadow_retire_mesh_stub`) before the exit path. Effort S. This is the archetype the scope's
§4 "#2 — anchor sources are the STEADY STATE" warning predicted.

### CRASH-2 — `mode_parse` forced-deop notice, latent `cli_user` NULL deref `[srv]`

`ircd/channel.c:4696-4697`:

```c
(IsServer(state->sptr) ? cli_name(state->sptr)
                       : cli_name((cli_user(state->sptr))->server))
```

An anchor `sptr` fails `IsServer`-exact and takes the **user arm** → `cli_user(anchor)` is NULL →
SIGSEGV. **Latent, not live**: no current caller passes an anchor as `state->sptr` (CRDT-driven
modes apply via `modebuf_init(&me)`). It is flagged because its two siblings in the same file were
already fixed and this one was missed — `channel.c:2307` and `channel.c:5206` both read
`(IsServer(sptr) || IsMeshStub(sptr)) ? … : cli_user(sptr)->…`, verified verbatim this pass.
**Fix: add `|| IsMeshStub(state->sptr)`.** Effort S. Any 6-2 carrier that lets a mesh source drive
`mode_parse` makes it live.

### Previously-closed hazards (re-verified, still correct)

| Hazard | Status |
|---|---|
| `%C` formatter takes the user branch for a `STAT_MESH_SERVER` (`cli_user == NULL`) → SIGSEGV | **FIXED** — `ircd_snprintf.c:2051` and `:2060` both test `IsServer \|\| IsMe \|\| IsMeshStub` |
| Channel-send fan-out called with a stub as `from` | **GUARDED** — `send.c:2211` and `:2302` assert `!IsServer(from) && !IsMe(from) && !IsMeshStub(from)`; both are user-message paths, never reached with an anchor |
| `IsServer`-exact **source** gates that could reject or deref an anchor source | Full enumeration of `if (!IsServer(sptr))` in `ircd/m_*.c` = 7 sites: m_oper.c:556, m_nick.c:429, m_nick.c:839, m_endburst.c:301, m_rpong.c:112, m_batch.c:527, m_server.c:236. **All seven are tree/legacy-only concepts** (EOB, RPONG, BT, link handshake, legacy NICK-collision KILL) reachable only over a real P10 link — i.e. only at the gateway, where the peer genuinely *is* `IsServer`. None is reachable with an anchor source at MR-6. The 2026-07-27 sweep's fixes (ms_chathistory entry/reply, m_silence.c:337, m_fake.c:115) are present and carry `IsMeshStub`; m_fake.c:115 re-verified verbatim this pass |

**Standing hazard for 6-2 implementation (not a current defect):** the CR-X reinject path
(m_crdt.c:677-694) dispatches `ms_*` handlers with `sptr = &me` — `STAT_ME`, which is **also not**
`IsServer`-exact. This is the ms_account / ms_mark IsMe-exemption family (`17f9d5e`). Every letter
currently reinjected (`A C R Q Y J P M D N B`) was checked and carries its exemption. **Any NEW
CR-X letter added by 6-2 must add the `IsMe` exemption to its handler's source gate in the same
commit** — this is the single most repeatable way to reintroduce the class.

## 1. hunt_server disposition (21 tokens, 43 call sites)

Uniform mechanism, verified in `hunt_server_cmd` (s_user.c:209-275) / `hunt_server_prio_cmd`
(s_user.c:297+): a local user's remote query resolves the target via `FindClient` (exact name) or
`find_match_server` (mask) — **both find anchors** — then `sendcmdto_one` writes into the anchor's
dead-sink Connection → **SILENT DROP, `HUNTED_PASS` returned, the user gets no reply and no
error**. Server-sourced forwards resolve via `FindNServer` (s_user.c:241) with the same outcome, so
a legacy oper's remote query for a CRDT peer silently dies at the gateway. Nothing errors; nothing
crashes; nothing logs.

**Verdict — `error-cleanly` for ALL 21 tokens, via ONE central fix (scope §5 Q3 recommendation).**
In both `hunt_server_cmd` and `hunt_server_prio_cmd`, after target resolution and before the
`sendcmdto_one`: if `IsMeshStub(acptr)` (equivalently `cli_fd(cli_from(acptr)) < 0`), emit
`SND_EXPLICIT | ERR_NOSUCHSERVER` with text *"<server> is reachable over the CRDT mesh only — use
/CRDT map|peers|status"* and return `HUNTED_NOSUCH`. **Effort S** — one branch × 2 functions
retires all 43 call sites. A CR-X request/reply tunnel (XQ/XR precedent) is deliberately **not**
built in 6-2.

| Token | file:line | Behavior toward an anchor target today | Verdict |
|---|---|---|---|
| ADMIN | m_admin.c:146,171 | silent drop | error-cleanly (central fix) |
| ASLL | m_asll.c:135,168 (prio) | silent drop | error-cleanly — link-latency concept dies with the tree |
| CHECK | m_check.c:110 | silent drop | error-cleanly |
| CONNECT (remote) | m_connect.c:139,269 | silent drop | error-cleanly + point at `/CRDT link` (6-0b) |
| INFO | m_info.c:111,145,182 | silent drop | error-cleanly |
| LINKS | m_links.c:130,178 | silent drop | error-cleanly — `/CRDT map` is the substitute |
| LUSERS | m_lusers.c:112,165 | silent drop | error-cleanly |
| MOTD | m_motd.c:121,149 | silent drop | error-cleanly |
| NAMES (remote) | m_names.c:259,261 | silent drop | error-cleanly — local doc view is already complete |
| OPERMOTD | m_opermotd.c:116,136 | silent drop | error-cleanly |
| REHASH (remote) | m_rehash.c:117,150,169,204 | silent drop | error-cleanly — CR-X tunnel is a later ops option |
| RPING | m_rping.c:164,221 | silent drop | error-cleanly |
| RULES | m_rules.c:116,136 | silent drop | error-cleanly |
| SETTIME | m_settime.c:149,237 (prio) | silent drop | error-cleanly — scope §5 Q6 (recommend: declare dead under HLC+NTP) |
| STATS (remote) | m_stats.c:150 | silent drop | error-cleanly |
| TIME | m_time.c:107 | silent drop | error-cleanly |
| TRACE | m_trace.c:140,153 | silent drop | error-cleanly — tree-route concept dead |
| UPING | m_uping.c:136,223 | silent drop | error-cleanly |
| VERSION | m_version.c:150,197 | silent drop | error-cleanly |
| WHOIS (remote `/whois nick nick`) | m_whois.c:495,576 | silent drop; user loses only idle/signon — all users are doc-materialized locally, so plain WHOIS is already complete | error-cleanly; **the only must-work candidate** if ops object |
| WHOWAS (remote) | m_whowas.c:127 | silent drop | error-cleanly |

## 2. Broadcast residue — verdict table

The primary sweep matched 250 sites via the five broadcast primitives (1 is a comment-line false
positive at gline.c:379 → **249 real**); the sub-auditors added **18 manual `->down` walks** the
regex could not see (14 `[g1]` + 4 `[g2]`), of which one is a real content-loss carrier (C23) and
the rest are read-only probes or legacy-scoped emits → **267 sites total**.

Counts after adjudication: **doc-redundant ≈146 · legacy-only-fine 40 · CR-carrier-needed 68 ·
accept-dead+clean-error 11 · scheduled-elsewhere 2**. Grouped by verdict, then token family; line
lists are exhaustive. Rows carry `[own]` / `[g1]` / `[g2]` / `[srv]` provenance where a sub-auditor
supplied or corrected the verdict; unmarked rows are the primary sweep's, corroborated by whichever
sub-auditor covered that file.

### 2a. doc-redundant (≈165) — broadcast death toward mesh peers is harmless

| Token family | file:line | Why it is covered |
|---|---|---|
| BS/BX session+conn lifecycle, `skip_crdt`-demoted | bouncer_session.c:2497,4306,4344,4364,4380,4387,4405,4411,4697,4709,4827,4832,4914,4936,4995,5000,6630,8078,8629,8634 | explicit `sendcmdto_set_skip_crdt_servers` in-window; bsess/bconn/blease doc collections |
| BS/BX lifecycle, no in-window marker | bouncer_session.c:4960,5028,5324,5329,7215,7662,7671,7791,8612,8935,8994,9034,9111,10150,10161,10175 | doc-native durable state (M2-M6d); **verdict rests on the 2026-07-29 pool09 live gate** (attach + back-materialize + gateway BX C synth + tombstone de-mat, all over zero-P10), not on a code-visible twin per site |
| BX AWAY re-broadcast | bouncer_session.c:10583,10589 | `away` is a `CrdtUserRecord` field; `crdt_shadow_user_add` at :10607 |
| JOIN/CREATE/PART/MODE/KICK | channel.c:1113,2939,2947,2958,5469,5599,5603,5770,5774,5781,5785,5803,5808 | Phase 3 doc-native (members OR-Set, member_status, modes, kick_info) |
| OPMODE | channel.c:2891,2900 | mode effect minted into the doc at the entry node |
| KICK | m_kick.c:285,288,445,448 | kick_info + members tombstone |
| TOPIC | m_topic.c:195,200,205,209 | topics LWW |
| NICK intro/change, BX hint, AWAY, MARK(doc fields) | s_user.c:774,879,892,924,930,954,1294,1298,1305 | user record (nick/nick_ts/away/sslclifp/version/geo). **s_user.c:2083 (server-sourced user MODE relay) and :926 (sslcliexp) moved out** → §2c C14/C6 `[g1]` |
| AWAY | m_away.c:308,315,330,380,389,486,488 | `away` field; `crdt_shadow_user_add` at :350,:398,:514 |
| SWHOIS | m_swhois.c:123,125 · m_oper.c:349 | `swhois` field; user_add at :130 / :353 |
| SETNAME | m_setname.c:175,269 | `realname` field; user_add at :199,:288 |
| ACCOUNT (login) — **local/legacy-homed targets only** | m_account.c:306,309,509 | `account`/`acc_create`; user_add at :327,:515; 3l re-mint `b0a2cbd`. **The mesh-homed-target leg is NOT covered** → §2c C13 `[g1]` |
| SASL cache-inval | sasl_webhook.c:64 | CR M `I` + target `*` (`2b1283d`) |
| MARK geoip/cversion/sslfp | m_mark.c:136,138,147,156,165 | user-record geo/version/sslclifp fields; user_add at :139,:148,:157 |
| SILENCE | m_silence.c:226,242 | silences collection + `crdt_shadow_sync_user_silences` |
| TEMPSHUN | m_tempshun.c:153,230 | `CrdtTempshun` LWW (Tier C F3) |
| MARKREAD | m_markread.c:369,452 | read-marker collection |
| WEBPUSH subscribe/unsubscribe | m_webpush.c:232,284,370,731,753 | webpush collection + `crdt_shadow_reconcile_webpush` |
| METADATA (permanent tier) | m_metadata.c:913,918,1037,1494,1499 | metadata collection (era-2 P0-P3). **Sub-case flagged:** the ephemeral/TTL tier and unregistered-channel MD have no doc twin — scope §1 row 6, tracked in §2c |
| METADATA persistence flags | m_history.c:155 · m_bouncer.c:723,761 · m_persistence.c:217,234,251,645,650,655,790 | same metadata collection |
| GLINE/SHUN/ZLINE/JUPE | gline.c:380,965 · shun.c:436,997 · zline.c:310,769 · jupe.c:120 · m_gline.c:360 · m_shun.c:356 · m_zline.c:360 | doc cutover flags + `crdt_shadow_{gline,shun,zline,jupe}_{add,remove}` |
| REMOVE | m_remove.c:142,183 | delegates to `gline_remove`/`zline_remove`/`shun_remove`, which mint the doc removal |
| KILL | m_kill.c:161 · m_nick.c:434,847,879 · m_svsnick.c:169 | CR M `K` (MR-4c); nick-collision resolver live-gated 2026-07-29 |
| SVS family (handler-side) | m_svsjoin.c:141 · m_svspart.c:145,147 · m_svsmode.c:134 · m_svsquit.c:73,75 · m_svsnick.c:191 | CR-X `J P M D N` tunnel fires in the handler at :139/:142/:132/:70/:189 (`6cdddee`) + doc state effects (scope §1 row 9). **m_oper.c:320,336 moved out** — those are *origin-side* emits that never run the handler → §2c C15 `[g1]` |
| TAGMSG | m_tagmsg.c:313,492 | `skip_crdt` + CR M `T` |
| CR-plane re-emit | m_crdt.c:1083,1095 | the CR plane itself |
| CHATHISTORY retention — **own-record advertisement only** | ircd_features.c:657 | `crdt_shadow_ch_storage_publish` carries our own store + retention, change-gated on the verify tick + EOB (≤30s) `[g1]`. **The relay legs m_chathistory.c:5237,5254 moved out** — `publish` is own-record-only and `synth_to` is doc→legacy only, so a *legacy* store's capability is never minted into the doc → §2c C16 `[g2]` |
| CHATHISTORY channel ads (A F / A + / A −) | m_chathistory.c:3151,3217,3255,3271,5288,5320,5352 | **degraded-but-covered**: per-channel ad precision is lost, but federation target discovery falls back to `crdt_shadow_ch_storage_foreach` (`collect_doc_target`, m_chathistory.c:3882) → queries fan to all doc-known stores. Cost is fanout width, not a history hole (the deferred bloom-filter item is the efficiency fix) |
| CLEARMODE | m_clearmode.c:297 | mode + ban removals minted at the entry node |
| DESTRUCT | m_destruct.c:197 · destruct_event.c:145 | ctime MIN-register incarnation (invariant 7) + the reachability-destruct bracket `74cbf1b` |

### 2b. legacy-only-fine (26) — deliberately gateway/legacy-facing; unaffected by decision #4

| Token family | file:line | Note |
|---|---|---|
| §17.7 gateway legacy-ward synth (SERVER/NICK/TOPIC/JOIN/KICK/PART/GLINE/SHUN/ZLINE/JUPE/BS) | crdt_shadow.c:1630,1636,1666,1671,1693,1698,2195,3498,3644,3785,3917,4903,4911,5433,5738,5869,5875 (17) | `sendcmdto_flag_serv_butone(…, FLAG_LAST_FLAG, FLAG_CRDT_AWARE, …)` = "to NON-CRDT-aware peers" — this **is** the gateway's job and must keep working |
| BX legacy-ward | bouncer_session.c:8088,8652 | `sendcmdto_legacy_serv_butone` by construction |
| BURST | m_burst.c:691,695 | only ever emitted on a real P10 link, i.e. gateway↔legacy |
| BURST net-rider KICK | m_burst.c:340 | only runs while processing a legacy BURST |
| EOB / EOB_ACK | m_endburst.c:126,306 | tree handshake; replaced among CRDT peers by CR S/H (§2.1, shipped in 6-0a) |
| SQUIT | s_misc.c:819 | CRDT-aware peers already excluded; legacy-ward only (R7a) |
| BX kill-forward | s_misc.c:1070 | `skip_crdt`-demoted; legacy leg only |

### 2c. CR-carrier-needed (49) — no doc twin; silently vanishes at MR-6 and matters

| # | Token family | file:line | What is lost | Effort |
|---|---|---|---|---|
| C1 | **Server-sourced WALLOPS** | m_wallops.c:107,123 · m_connect.c:197 · m_mode.c:270 · m_server.c:199,238 | `sendwallto_group_butone` (send.c:3131-3137) CR-routes **only when `cli_user(from)` is non-NULL** — user-sourced gets CR M `W`; **server-sourced (`from = &me`) is explicitly excluded and stays P10-tree**. Link errors, mode-hack alerts and CONNECT notices vanish network-wide | S |
| C2 | **WALLUSERS (server-sourced)** | m_wallusers.c:110,127 | same gate: CR M `U` fires only for `cli_user(from)` | S (same patch as C1) |
| C3 | **WALL_DESYNCH** | ircd_reply.c:68 · m_desynch.c:110 · m_settime.c:166,244 | `crdt_letter` is never set for `WALL_DESYNCH` at all — desync alarms are 100% tree-only | S (same patch as C1) |
| C4 | **SMO / SNO** (server-mask / snomask notices) | m_smo.c:54 · m_sno.c:54 | the Tier C F5 ephemeral-notice class; oper snomask traffic does not cross the mesh | S |
| C5 | **REDACT live leg** | m_redact.c:326,437 · m_chathistory.c:4194 | the storage side is in CH storage (doc); the **live broadcast leg** that makes peers delete/replace the rendered message has no carrier — scope §1 row 8 confirmed. Divergent visible history across nodes | M |
| C6 | **MARK (non-doc marks)** | m_mark.c:128 (WEBIRC),173 (KILL),182 (MARK) · m_notice.c:228 · s_user.c:917 (WEBIRC),920 (MARK),949 (KILL) | `CrdtUserRecord` covers version/sslfp/geo only; WEBIRC provenance, kill-marks and free-form marks have no field | S (extend the user record) |
| C7 | **FAKE (fakehost)** | m_fake.c:136 | `m_fake` mutates `cli_user->fakehost` + `hide_hostmask` but never calls `crdt_shadow_user_add`; the in-file comment already admits "FAKE has no doc backstop". Displayed host diverges per node | S (add user_add, mirroring m_svsident.c:109) |
| C8 | **PRIVS** | client.c:378,388 · m_privs.c:157 | oper-privilege propagation; no doc twin. Remote-oper capability checks diverge | S |
| C9 | **Bouncer alias field update (BX U)** | bouncer_session.c:7136,9034,9111 | the pool09 gate covered session/conn **lifecycle**, not these attribute deltas. `[g1]` marks this one **doc-redundant\* — needs verification**: primary attrs ride the user record, but whether mesh-side reconcile re-syncs replica *alias mirrors* is unresolved read-only. See §7 | S (if confirmed) |
| C10 | **SASL "*" broadcast leg + mech list** | m_sasl.c:137,140,336 · m_authenticate.c:321,325,328,332 | CR-X `A` covers *targeted* SASL; the wildcard broadcast (including `SASL * * M`, the mechanism list) is tree-only — see §4 | M |
| C11 | **RENAME** | m_rename.c:224,467,526 | Tier C F4, already blocked on services integration; at MR-6 it also loses its transport. Scope §5 Q5 (hard-gate vs waive) | M (blocked) |
| C12 | **GITSYNC** | m_gitsync.c:411,413,706,708 | config-distribution fan-out; overlay nodes never learn a sync action, and the admin believes it succeeded (silent config drift) | S |
| C13 | **ACCOUNT U/R/M toward a MESH-HOMED target** `[g1]` | m_account.c:237,306,309,509 | the tail `crdt_shadow_user_add` covers local/legacy-homed targets, but for a mesh-homed target the mint **self-skips** on the `from_crdt_peer(cli_from)` single-writer gate and the home never hears the dead P10 relay → the account change is lost, then reverted by reconcile. The LOC branch already has a CR-X tunnel (m_account.c:400) — this is the same fix on the U/R/M branch. **Auth-critical** | M |
| C14 | **Server-sourced user MODE relay** `[g1]` | s_user.c:2083 | per-hop umode apply never reaches a mesh-homed target's home; the single-writer home never re-mints, so the umode silently diverges | S |
| C15 | **Origin-side SVSJOIN** `[g1]` | m_oper.c:320,336 | `ms_svsjoin` *receivers* tunnel CR-X `J`, but these are **emitting** sites — the origin node never runs its own handler, so a pure-mesh origin loses the autojoin entirely | S |
| C16 | **CH A S / A R relay — legacy store capability into the doc** `[g2]` | m_chathistory.c:5237,5254 | `ch_storage_publish` is own-record-only; a *legacy* store's advertised capability never enters the doc, so overlay-only leaves cannot discover or federate from legacy stores | S |
| C17 | **SVSINFO / SVSIDENT toward a mesh-homed target** `[g1]` | m_svsinfo.c:72 · m_svsident.c:105 | same `user_add` self-skip shape as C13 — the Cluster-A tunnel pattern was never applied to these two | S each |
| C18 | **SVSNOOP** `[g1]` | m_svsnoop.c:141 | reclassified from accept-dead: this is a **per-node apply** (oper-block disable), so a mesh-homed target server never applies it. Needs a doc marker or a CR-X server-target form | S |
| C19 | **iauth XQUERY forward** `[srv]` | s_auth.c:3036 | the one XQUERY path **without** the CR-X tunnel — bare `sendcmdto_one(CMD_XQUERY)` into the services anchor's dead sink. Mirror `mo_xquery`'s `crdt_route_services_reply_try('Q', …)` | S |
| C20 | **REGISTER / account-registration services lookup** `[srv]` | m_register.c:70,88 | named mode: finds the anchor → RG dead-sinks. Wildcard mode: the loop requires `IsServer && IsService` → an anchor fails **both** → "services unavailable". Draft account-registration is dead on an overlay-only node | M |
| C21 | **Beacon carries no service flags** `[srv]` | CR H beacon struct, crdt_shadow.c:112-127 | the beacon carries name + capacity only — **no `+s`/`+h`** — so an x3 anchor never gets `FLAG_SERVICE`. This is the *root cause* under several §3 rows (ircd_relay.c:1143 `IsService` check, m_register/m_rename service discovery, m_check "Network Service" line, `crdt_present_stub` re-presenting x3 to legacy **without** `+s`). Carry an `s`/`h` flag char on CR H and apply it at anchor mint | S |
| C22 | **Legacy-origin METADATA never minted** `[g2]` | m_metadata.c:1466 (gates :1494,:1499) | `crdt_shadow_metadata_suspend(1)` is **unconditional**, but its premise ("origin already mirrored into the doc") is false for a *legacy* origin arriving at the §17.7 gateway. Contrast the correct entry-node gate at m_webpush.c:737 (`!IsCrdtAware(cptr)`). Fix = gate the suspend on `IsCrdtAware(cptr)` | S |
| C23 | **S2S multiline transit relay** `[g2]` | m_batch.c:2628 (`->down` loop) | a legacy/fork-origin multiline arriving at the gateway is **never** flooded or unicast to mesh members — the CRDT refs in the file stop at :1662 (client-origin only). This is **content loss**, not a framing degradation. Mirror the C1 per-line flood into the s2s batch-completion path. *(Missed by the primary sweep — it is a manual `->down` loop, not one of the five primitives)* | M |
| C24 | **CTCP-VERSION capture** `[g2]` | m_notice.c:228 | sets `cli_version` + broadcasts MARK CVERSION but never calls `crdt_shadow_user_add` at the origin; the mat-check (crdt_shadow.c:4299) *detects* the drift but does not heal it → doc `rec.version` goes stale | S |
| C25 | **BX K snomask** `[g1]` | bouncer_session.c:8612,10082,10100 | **no snomask field in any doc record** → a remote replica misses snotice delivery | S |
| C26 | **BX V alias visibility** `[g1]` | bouncer_session.c:918,10150,10161 | alias `CHFL_ALIAS` memberships are **not** in the doc (`crdt_shadow_join` skips aliases) → alias channel visibility has no doc twin | M |
| C27 | **$-mask messages** `[srv]` | `relay_masked_message` → `sendcmdto_match_butone` | tree-relayed → remote copies lost on an overlay-only node. Oper-facing | S |

### 2d. accept-dead + clean-error (7)

| Token | file:line | Disposition |
|---|---|---|
| S2S BATCH relay (BT) | m_batch.c:573 | netjoin/netsplit batch relay; presentation-only. Dies cleanly |
| S2S netjoin/netsplit batch emit | send.c:3565,3569,3573,3624 | `send_s2s_batch_start`/`_end` have **zero callers** — dormant machinery. Belongs to 6-3's netsplit-UX decision (scope §5 Q2) |
| MULTILINE cap advertise | m_batch.c:2580 | per-peer limit advertise; mesh multiline rides CR and does not consult peer `IsMultiline` |
| SETTIME spam loop | m_settime.c:143 (`->down`) `[g1]` | mesh nodes are never SETTIME'd; NTP + HLC are the real discipline (scope §5 Q6) |
| SASL agent-discovery broadcast | m_authenticate.c:321,325,328,332 `[g2]` | fires only when no agent Client resolves; on a leaf `->down` is empty → **AUTHENTICATE silently times out**. Must fail the AUTHENTICATE promptly rather than hang |
| SASL `D A` abort broadcast | m_sasl.c:336 `[g2]` | the targeted leg above it already tunnels; this fallback leaves a services-side session to its own timeout |

### 2e. Scheduled elsewhere (2) — decision #7 (AC `U` LOGOUT)

| Token | file:line | Note |
|---|---|---|
| ACCOUNT `U` (LOGOUT) | m_account.c:237 · sasl_webhook.c:109 | **Deliberately NOT doc-driven** (deferred 2026-07-29 as destructive on doc lag). Per decision #7 this is now scheduled work. **Constraints this audit adds:** (a) at MR-6 the tree AC is the *last* carrier and it is gone, so logout cannot survive as-is — this is now a correctness gap, not a nicety; (b) the login direction already writes `account`/`acc_create` into `CrdtUserRecord` via `crdt_shadow_user_add`, so the cheapest correct design is to write the **empty-account value into that same LWW field** — login and logout then serialize on one register and can never interleave into a resurrect; a separate tombstone-with-grace-window collection would create a second writer of the same logical value and re-open exactly the ordering hazard; (c) whatever is chosen must honour the hold-"0" lesson (`d499f60`) — dual-plane flag↔metadata writes stay MyUser-gated, or a remote logout will re-mint a stale record |

## 3. IsServer-exact / anchor-blind lookup sweep

`FindServer()` misses anchors; `find_match_server()` / `FindClient()` / `FindNServer()` find them.
Judgement-filtered: only branches whose **outcome changes** with anchors-as-steady-state are listed
(pure send-loop `IsDead` skips are excluded — those already behave correctly).

| Site / purpose | file:line | Behavior with an anchor | Verdict | Fix sketch |
|---|---|---|---|---|
| `sasl_server_available()` — the ARCHETYPE | m_cap.c:262-275 | `find_match_server` finds x3-as-anchor, but the pre-existing tail was `IsServer`-exact → sasl cap silently un-advertised on nef7 | **FIXED (MR-6-1)** — `FindClient` + `IsMeshStub` + `crdt_server_is_mesh_only` + `FEAT_CRDT_SERVICES_BRIDGE` branch | done |
| SASL `"*"` wildcard branch — **primary agent's verdict CORRECTED** | m_cap.c:258-259 | `UserStats.servers > 0` is **vacuously true**: `querycmds.c:48` initialises `servers = 1` for `&me` (verified this pass), so it never reads 0 and never stops advertising. The real defect is the mirror image — with `SASL_SERVER="*"` the node **keeps advertising sasl** while the wildcard relay (`sendcmdto_serv_butone`) has no P10 links to broadcast onto → **AUTHENTICATE blackholes**. Anchors are indeed uncounted (Case-B `make_client(NULL)` + `SetServerYXX` never touch the counters), but that is not what breaks it | **broken (wildcard config only; testnet uses a named server)** `[srv]` | in wildcard mode fall back to the services-bridge anchor rather than broadcasting |
| `UserStats.servers` counter symmetry | Case-B mint crdt_shadow.c:2261 vs Case-A convert :2211 | **inconsistent flavors** `[srv]`: Case-B synthetic anchors are never counted and never decremented (balanced at 0); Case-A converted stubs **stay counted** for the stub's lifetime because conversion bypasses `exit_one_client`, and retire restores `SetServer` → `Count_serverdisconnects` (also balanced). Net effect: gateways count their stubs, leaves do not | review (no live defect; a trap for anyone who later gates on this counter) | pick one flavor before anything depends on it |
| `/CRDT status` census + partition heuristic — **worse than cosmetic** | `crdt_mesh_stub_count` crdt_shadow.c:464, `crdt_have_mesh_stub` :465 (++ at :2226 convert, :2264 mint) · render m_crdtinfo.c:236 | at MR-6 steady state the counter is **permanently nonzero** → `partitioned=YES` forever. `[srv]` traced the consequence the primary sweep missed: this flag also drives the **R6c "partitioned → flood CR-M unconditionally / skip the tree" switches** at ircd_relay.c:587,624,784,813 · m_tagmsg.c:302,322 · m_batch.c:1544 · m_crdt.c:622, which therefore fire permanently. At MR-6 flood-as-carrier happens to be *correct* routing, so nothing breaks today — but the flag no longer means "partitioned": it **defeats MR-1 unicast selection** and would silently defeat any future digest/anti-storm gating keyed on it | **anchor-blind-broken (latent routing-efficiency + a live semantic lie)** | split the two meanings: "has a stub because tree-retired by design" (`FEAT_CRDT_OVERLAY_PRIMARY`) vs "has a stub because partitioned" (beacon-known server unreachable). Re-base the census on fresh-beacon + overlay-edge counts |
| `UserStats.servers` — all readers | m_cap.c:259 (above); LUSERS / STATS renders | undercounts by exactly the anchor population → an overlay-only node reports itself as a 1-server network | anchor-blind (cosmetic except for m_cap) | count anchors at `make_anchor`/retire, or move the availability decision off this counter |
| `FindServer()` — services / jupe / uworld lookups | ircd_relay.c:1143 (`nick@server` + `IsService`), :1264 (`$service` forward) · jupe.c:98 · m_pseudo.c:142 (service alias target) | x3 is an anchor → lookup returns NULL → **directed `nick@services`, `$service` routing and service aliases fail on an overlay-only node** | **anchor-blind-broken** | a `FindServer()`-or-anchor helper (`FindClient` + `IsMeshStub`), then route via the CR-X services bridge exactly as m_cap.c now does |
| `FindServer()` — oper / diag lookups | m_check.c:158,169 · m_ircops.c:119 · m_oper.c:482 · m_crdtinfo.c:338 · m_svsnoop.c:119 | target-by-name misses anchors → "no such server" for a server the node can see in `/CRDT map` | anchor-blind (ops-visible, low severity) | same helper, or an explicit "mesh-only" message |
| `FindServer()` — tree-only concepts | m_connect.c:156,287 · m_squit.c:75 · ircd.c:576 · m_ping.c:192,256 · send.c:2828,3057 (GlobalForwards) | anchors correctly excluded — you cannot CONNECT/SQUIT/PING a mesh peer over P10 | **already-fine** (but /SQUIT of a mesh peer should error toward DECOMMISSION — 6-3 item) | — |
| `find_match_server()` — SASL target | m_authenticate.c:255,270 | **finds** the anchor → `sendcmdto_one` into the dead sink → silent auth stall unless the CR-X `A` bridge fires first | already-fine *iff* `FEAT_CRDT_SERVICES_BRIDGE` is on (it is; MR-6-1 gated SASL 903 over zero-P10) — **a failure mode if the bridge is ever off** | assert/log when the resolved target is an anchor and the bridge is disabled |
| `find_match_server()` — gline / shun / jupe `<server>` targeting | m_gline.c:499 · m_shun.c:491 · m_jupe.c:231 | finds the anchor → the targeted leg dead-sinks; the *state* still converges via the doc cutover | already-fine (state), accept-dead (targeted form) | fold into the hunt_server clean-error message |
| `find_match_server()` — register / connect | m_register.c:70 · m_connect.c:256 | finds anchor → dead-sink | accept-dead | — |
| `IsServer`-exact **source** gates | m_oper.c:556 · m_nick.c:429,839 · m_endburst.c:301 · m_rpong.c:112 · m_batch.c:527 · m_server.c:236 | all seven are tree/legacy-only paths reachable only over a real P10 link → the peer genuinely is `IsServer` | **already-fine** | — |

## 4. SASL mechanism broadcast (X3 `SASL * * M`)

Confirmed **P10-only**. X3 emits `SASL * * M :mechs`; `ms_sasl` consumes it (m_sasl.c:129-134 →
`set_sasl_mechanisms`, storage `ircd.c:206`) and re-broadcasts via `sendcmdto_serv_butone`
(m_sasl.c:137-141) — a tree walk. An overlay-only node **never receives it and never can** (x3 is
an anchor there). MR-6-1 shipped the two-part mitigation: the anchor-aware `sasl_server_available()`
branch (m_cap.c:271-275) plus static `SASL_DEFAULT_MECHANISMS` (m_cap.c:219-222).

**Residual defect:** mech-list drift. Overlay nodes advertise the static list, P10 nodes the dynamic
one; `CAP LS sasl=<mechs>` values diverge across the fleet, and a mechanism X3 *drops* stays
advertised forever on overlay nodes. The `IsServer`-exact `"*"` wildcard branch (§3) compounds it.

**Doc-carrier design sketch (effort S-M).** An **LWW register keyed by service-server name** (or its
2-char numeric) → mech string; a new small collection, or a reuse of a server-scoped meta map.
**Single writer = the gateway**, the only node holding x3's P10 link and therefore the natural
owner. Write on `SASL * * M` receipt in `ms_sasl`; explicit tombstone on services de-present (never
absence — the invariant-11 rule). Readers: `get_effective_sasl_mechanisms()` (m_cap.c:206) consults
the doc value between the local-Keycloak override and the static fallback; the reconcile fires
`send_cap_notify("sasl", …)` on an observed change, reusing the existing CAP NEW/DEL machinery
(list.c:400-421 is the working model). **No new CR-M letter** — this is doc state, which also
sidesteps the CI-`I` shared-letter hazard entirely.

Note this carrier is *simplified* by decision #8 (gateway HA deferred): with a single gateway there
is exactly one writer, and the deferral removes the only scenario that would have needed
write-arbitration. LWW keeps it correct if a second gateway ever arrives at 6-4.

## 5. Scope §1 named rows — verified behavior

- **m_batch `route_to` / provenance (§1 row 13) — RESOLVED.** The 2026-06-17 line numbers had
  drifted. Current state: the multiline **DM leg is mesh-covered** (m_batch.c:1413-1431 —
  `IsMeshStub(target_server)` → per-line `crdt_route_unicast_try`, fresh msgid per line to defeat
  the 90s CR-M dedup) and the **channel leg is mesh-covered** (m_batch.c:1543-1552 `will_flood_cr` =
  `crdt_have_mesh_stub()` **or** any member on a stub → per-line `crdt_gossip_message` at
  :1655-1665, with the P10 leg suppressed toward CRDT-aware peers at :1567). At MR-6 steady state
  every remote member/target is anchor-hosted, so `will_flood_cr` always fires → covered.
  Presentation degrades from a grouped batch to per-line messages — documented and accepted.
  `route_to`/`acptr` in the delivery helpers are local-only (`MyConnect(route_to)` gate, :215).
  `ms_batch`'s anchor-source concern (:527) is a non-issue (see the crash table).
- **REDACT live leg** — confirmed uncarried → §2c C5.
- **Server-WALLOPS / SMO / SNO / DESYNCH (Tier C F5)** — confirmed uncarried, and the *reason* is
  now precise: the `cli_user(from)` gate in `sendwallto_group_butone` (send.c:3131-3137) → C1-C4.

## 6. Load-bearing carriers to build — priority order

**0. The two crash fixes come first** (both effort S, both one-liners): `IsMeshStub` guard in
`ms_squit` (m_squit.c:75-79) and `|| IsMeshStub(state->sptr)` in the mode_parse forced-deop notice
(channel.c:4696-4697). Neither is a carrier; both are prerequisites for running a bed where anchors
are the steady state.

1. **The WALL*/notice carrier (C1+C2+C3+C4 — Tier C F5 in one patch).** Widen
   `sendwallto_group_butone`'s CR gate to server-sourced messages (`from == &me`, reconstructing the
   prefix into `sendrawto` per invariant 2 rather than passing a server as `%C`), add a
   `WALL_DESYNCH` letter, and add SMO/SNO letters. **Highest value per line of code**: 14 of the 49
   CR-carrier sites, and it restores the operator-visibility surface that makes every *other* MR-6
   phase debuggable. Effort S. Guard every new letter in-branch (CI-`I` lesson) and ship receivers
   one bed generation before flipping any emit flag.
2. **The auth-path cluster: mesh-homed ACCOUNT (C13) + `sasl_auth` doc mint (C10) + the SASL
   mech-list doc register (§4) + the `"*"` wildcard fix (§3) + the iauth XQUERY tunnel (C19).**
   Promoted above the user-record work by the sub-auditors' findings: C13 is auth-critical (an
   account change on a mesh-homed user is lost *and then reverted by reconcile*), and C10 means
   local-SASL reauth on an overlay-only leaf reaches **nobody**. The LOC branch's CR-X tunnel
   (m_account.c:400) and `mo_xquery`'s `crdt_route_services_reply_try` are the working templates —
   this is pattern-application, not new design. Effort M overall.
3. **The user-record extension: MARK non-doc marks + FAKE + PRIVS + server-sourced MODE
   (C6+C7+C8+C14), plus the beacon service flag (C21).** Fifteen sites, all fixed by adding fields
   to `CrdtUserRecord` (or an adjacent per-user LWW) and calling `crdt_shadow_user_add` — the exact
   pattern m_svsident.c:109 and m_mark.c:139 already use. Do them in one commit so the struct grows
   once; honour invariant 4 (field-by-field HLC copies, memset-then-fill). C21 rides along because
   it is the root cause under four separate §3 rows and is a one-char beacon addition.

Then, in descending order and not part of the top three: the Cluster-A stragglers
(C15+C17+C18, S each — same `reply_try` pattern as #2), REDACT live leg (C5, M), the multiline
s2s transit carrier (C23, M — content loss, so rank it above cosmetics), legacy-origin METADATA
gate (C22, S), CH A S/A R legacy-store mint (C16, S), REGISTER services lookup (C20, M), bouncer
BX K snomask / BX V visibility (C25+C26), GITSYNC (C12, S), CTCP-VERSION mint (C24, S), `$`-mask
messages (C27, S), the central hunt_server clean-error (§1, S — trivial but touches every remote
query, so gate it deliberately), the `crdt_have_mesh_stub` semantic split (§3 — do this *before*
anything new keys on the partition flag), and the `FindServer()`-or-anchor helper for the
services/jupe/pseudo lookups (§3, S).

RENAME (C11) stays blocked on services per scope §5 Q5 — note `[g2]`'s sharpening: every channel
collection is keyed by chname, so an un-carried RENAME leaves mesh peers holding the **old-name
channel entirely**, a doc/live key split rather than a lost notification. AC `U` LOGOUT (§2e) is
scheduled separately under decision #7 but is now a *correctness* item — the tree carrier it relied
on ceases to exist at MR-6.

## 7. Open items the audit could not settle read-only

1. **BX U alias-mirror resync** `[g1]` (bouncer_session.c:7136,9034,9111 — §2c C9): whether
   mesh-side reconcile re-syncs replica *alias* mirrors when it applies primary attribute drift
   directly, versus only via handlers that call `bounce_emit_alias_update`. If it does not, replica
   alias identity fields drift silently. **Decides whether C9 is a carrier or a non-issue.**
2. **Overlay command-acceptance filter** `[srv]`: whether the MR-6-0 overlay link accepts arbitrary
   P10 beyond CR tokens. If it does, CRASH-1 (`ms_squit`) and the latent CRASH-2 (`mode_parse` with
   an anchor source) both gain reachability. **A targeted read of the overlay read path settles it
   — do this before deciding CRASH-1's severity.**
3. **Legacy dest-`*` CHATHISTORY queries** `[g2]` (m_chathistory.c:4819): whether prod-fork legacy
   peers still emit broadcast dest-`*` CH Q when B4-synth'd adverts exist. If yes, mesh stores are
   invisible to that query. Needs a wire trace, not code reading.
4. **Ephemeral metadata parity** (m_metadata.c:913, m_history.c:155 for unregistered channels):
   memory-only by design; whether mesh parity is wanted is a design decision, tracked in the
   existing `project_ephemeral_metadata_burst_gap` thread. Scope §1 row 6.
5. **PRIVS carrier shape** (C8): the right mechanism depends on the deferred session-anchored-oper
   design (`project_oper_session_state`). Do not pick a mechanism without that decision.

### Gate plan for 6-2
Each new carrier gets a targeted gate against overlay-only nef7. Negative gates for the accept-dead
tokens: clean numeric, no silent drop, **no crash from an anchor source** — re-run the c-auditor
invariant-2 sweep over every token class newly carried, and specifically re-check the `IsMe`
exemption on any handler newly reachable through a CR-X reinject.
