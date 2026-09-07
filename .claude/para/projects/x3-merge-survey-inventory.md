# X3 Services Survey Inventory (for IRCd fold-in scoping)

Survey date: 2026-07-30. Findings only; no design or sequencing recommendations.

## 0. Provenance — what tree was surveyed

- Tree: `/home/ibutsu/testnet/x3`, branch `master` @ `052d6e0`, working tree clean.
- Deployed build: `x3/Dockerfile:21` — `./configure --prefix=/x3 --sysconfdir=/x3/data --localstatedir=/x3/data --with-ldap --enable-modules=snoop,memoserv,helpserv`.
- The **running container was verified to be built from master**: string-probe of `/x3/bin/x3` in the live container found `keycloak`: 0 hits, `histserv`: 0 hits, `ldap_enable`: 2 hits, `bouncer`: 4 hits (matches master's BX handler, no Keycloak branch code).
- Non-shipping branch `keycloak-integration` exists (+54k lines vs master: `src/x3_kc_adapter.c`, `src/x3_kc_bridge.c`, `src/x3_lmdb.c` [6032 lines], `src/x3_ssl.c`, `src/mod-histserv.c`, libkc dependency). Everything in this inventory refers to **master** unless explicitly flagged.
- Size: ~70k lines under `src/` (`wc -l src/*.c src/*.h` = 70191). Big files: chanserv.c 10260, opserv.c 7592, nickserv.c 6274, mod-helpserv.c 5044, proto-p10.c 4267, spamserv.c 3309, modcmd.c 2656.

## 1. Functional surface, by service bot

Command registration mechanisms: NickServ uses `nickserv_define_func()` (thin wrapper over modcmd, nickserv.c:6159-6210); ChanServ uses `DEFINE_COMMAND` → `modcmd_register(chanserv_module, ...)` (chanserv.c:10019-10024, table 10059-10175); OpServ uses `opserv_define_func()` (opserv.c:4670-4684, table 7414-7555). Counts: ChanServ 95 commands + 30 channel `set` options + 4 `uset` options (chanserv.c:10176-10219); OpServ 137; NickServ 39 + ~24 SET/OSET option keys (nickserv.c:6196-6234); HelpServ 35.

### NickServ / AuthServ (deployed nick "AuthServ", data/x3.conf:100-101)

Core account lifecycle (all in nickserv.c, registrations 6159-6210):
- `AUTH` (6159) — authenticate to an account; reads handle dict + passwd/LDAP; writes user->handle_info binding, emits P10 `AC` (irc_account, proto-p10.c:650).
- `REGISTER` (6161) / `OREGISTER` — create handle_info; writes nickserv_handle_dict + saxdb; LDAP add when writeback (nickserv.c:1163-1172).
- `UNREGISTER`/`OUNREGISTER` — delete account (+ LDAP delete, 596-603).
- `PASS`, `SET`/`OSET` (option dict 6196-6234: EMAIL, PASSWORD, FLAGS, ACCESS/LEVEL = opserv_level with LDAP writeback nickserv.c:3690, EPITHET, TITLE, FAKEHOST, MAXLOGINS, ANNOUNCEMENTS, LANGUAGE, KARMA, style/width cosmetics).
- Hostmask/cert auth material: `ADDMASK`/`DELMASK`/`OADDMASK`/`ODELMASK`, `ADDCERTFP`/`DELCERTFP`/O-variants (6165-6172).
- Cookie flows (email verification): `AUTHCOOKIE`, `RESETPASS`, `COOKIE`, `DELCOOKIE`, `ODELCOOKIE` (6191-6195), gated on email_enabled.
- `RENAME` (6178) — account rename; re-keys dict + LDAP rename (2029-2065). `MERGE` (min olevel 750, 6180) — merge two accounts.
- `GHOST` (6198), `ALLOWAUTH` (6160), `ACCOUNTINFO`, `USERINFO`, `STATUS`, `VACATION`.
- Staff/audit: `SEARCH` (olevel 100; `SEARCH UNREGISTER` 800), `MERGEDB` (999), `CHECKPASS` (601), `CHECKEMAIL`, `ADDIGNORE`/`DELIGNORE` (per-account ignore lists).
- Nick-ownership commands (`REGNICK`, `UNREGNICK`, `NICKINFO`, `RECLAIM`, 6183-6188) exist but are registered only when `!nickserv_conf.disable_nicks`.
- SASL server side: `handle_sasl_input` (5994) via `reg_sasl_input_func`; advertises PLAIN and EXTERNAL-if-certfp (sasl_packet, 5853-5856); auth backend `loc_auth` (2121) = LDAP bind if enabled (2146-2153, with autocreate 2155-2189) else local MD5-crypt `checkpass` (2202), or sslfp match (2206-2214).
- Auto-oper on auth: `handle_loc_auth_oper` (6088-6122) — grants umode +o/+a and PRIVS when `opserv_level` crosses configured thresholds.

Core-vs-convenience: AUTH/REGISTER/PASS/masks/certfp/cookies/rename/merge/oset-level are network-core; vacation, karma, epithet/title, style/width/color, toys of the SET namespace are conveniences.

### ChanServ (deployed nick "ChanServ", data/x3.conf:473-474)

Registered at chanserv.c:10059-10175. Categories with representative registrations:
- Registration lifecycle: `register` (10059, staff-flag +helping by default template), `unregister` (10074), `move` (10066 — re-point registration to a new channel name, cmd_move 2747), `merge` (10075), `csuspend`/`cunsuspend` (10067-10068, staff), `noregister`/`allowregister`/`dnrsearch` (do-not-register list, 10060-10065), `expire` (10161, +oper), `unvisited` (10163).
- Access management (state = userData entries in chanData): `adduser` (10077, access "manager"), `deluser`, `clvl`, `suspend`/`unsuspend` (user-level), `deleteme`, `mdelowner`/`mdelcoowner`/`mdelmanager`/`mdelop`/`mdelhalfop`/`mdelpeon`/`mdelpal` (10083-10089), `trim` (10093), `giveownership` (10096, access "owner" + loghostmask), `access`/`myaccess`/`users`/`wlist`/`clist`/`mlist`/`olist`/`hlist`/`plist` (10138-10146).
- Live channel control (reads access, emits P10 modes/kicks): `op`/`deop`/`hop`/`dehop`/`voice`/`devoice` (10102-10107), `up`/`down`/`upall`/`downall` (10098-10101), `kick`/`kickban`/`ban`/`unban`/`unbanall`/`unbanme`/`open` (10109-10115), `topic`/`mode`/`invite`/`inviteme` (10116-10119), `resync` (10122), `opchan` (10094).
- Persistent bans ("lamers"): `addlamer`/`addtimedlamer`/`dellamer`/`lamers` (10126-10134) — banData records enforced on join (handle_join 8482-8518).
- Settings: `set` (10120; 30 channel options incl. defaulttopic, topicmask, greeting, modes, enfops/enfhalfops/enfmodes/enftopic, automode, pubcmd, dynlimit, topicsnarf, nodelete, bantimeout, unreviewed — 10176-10207) and `uset` (autoinvite/autojoin/info/autoop, 10213-10219).
- Notes: `createnote`/`removenote` (olevel 800), `note`/`delnote` (10151-10152) — typed note system with per-type access/visibility.
- Info/log: `info`, `seen`, `names`, `events`, `last`, `peek` (10124-10148), `netinfo`/`ircops`/`helpers`/`staff` (10154-10157).
- Staff: `say`/`emote` (+oper, 10159-10160), `search` (+helping, 10162).
- Toys (pure convenience, flag +toy): `unf`, `ping`, `wut`, `8ball`, `d`, `huggle`, `calc`, `reply`, `roulette`, `shoot`, `spin` (10165-10175).

Passive behavior (not commands): join-time automode/greeting/userinfo (handle_join 8422-8621), dynamic limit (8525-8536), mode/topic enforcement (validate_op 1928, handle_mode ~8900), CTCP reaction (chanserv_ctcp_check 998), topic refresh/resync timers, channel expiry scan.

### OpServ / O3 (deployed nick "O3", data/x3.conf:333-334)

Table opserv.c:7414-7555 (levels shown are min opserv_level):
- Network bans: `GLINE`(600)/`UNGLINE`, `SHUN`(600)/`UNSHUN`, `SGLINE` via P10, `BLOCK`/`SBLOCK` (100, host-derived gline/shun), `GSYNC`/`SSYNC` (600, re-pull from ircd via remote STATS — numerics 247/542 handlers proto-p10.c:2413-2440), `REFRESHG`/`REFRESHS` (600, re-push all).
- Mass action / discrimination engine: `TRACE` (100; actions PRINT/COUNT/GLINE/SHUN/KILL/GAG/MARK/SVSJOIN..., 7528-7542), `GTRACE`/`STRACE` over stored glines/shuns, `CSEARCH` (channel search), `ADDALERT`/`DELALERT` (800-999 depending on reaction, 7415-7428) — standing alerts run against every new user.
- Clone/trust: `ADDTRUST`/`DELTRUST`/`EDITTRUST` (800; trusted-host clone allowances, persisted), `CLONE` (999, create fake client), `COLLIDE` (800), untrusted_max limits enforced in new-user hook.
- Abuse tools: `GAG`/`UNGAG` (600), `DEFCON` (900), `ADDBAD`/`DELBAD`/`ADDEXEMPT`/`DELEXEMPT` (800, "bad channel" wordlist → auto-moderate).
- Channel intervention: `OP`/`DEOP`/`HOP`/`DEHOP`/`OPALL`/`DEOPALL`/`HOPALL`/`DEHOPALL`/`VOICEALL`/`DEVOICEALL` (100-400), `MODE`(100), `CLEARBANS`(300), `CLEARMODES`(400), `KICK`/`KICKBAN`(100), `FORCEKICK`(800), `KICKALL`/`KICKBANALL`(400/450), `BAN`/`UNBAN`(100), `INVITE`/`INVITEME`(100), `CHANINFO`(0), `WHOIS`(0), `JOIN`/`PART`(601).
- Server/link control: `JUMP`(900, change uplink), `RECONNECT`(900), `ROUTING ADDPLAN/DELPLAN/ADDSERVER/DELSERVER/MAP/SET` + `REROUTE` (800, persisted routing plans), `JUPE`/`UNJUPE`(900), `SETTIME`(901).
- Services admin: `DIE`/`RESTART`/`REHASH`/`REOPEN`/`LOG`(900), `RAW`(999), `DUMP`(999), `SET`(900), `PRIVSET`(900, P10 PRIVS), `RESERVE`/`UNRESERVE`(800, nick reservation with fake clients), `RESETMAX`, `ACCESS`(0), `QUERY`, `MAP`, `SVSNICK`/`SVSJOIN`/`SVSPART`(999), `MARK`(900, P10 MK).
- `STATS ALERTS/BAD/GAGS/GLINES/SHUNS/LINKS/MAX/NETWORK/NETWORK2/RESERVED/ROUTING/TIMEQ/TRUSTED/UPLINK/UPTIME/MEMORY` (7509-7526).

### Global (deployed nick "Global", data/x3.conf:615-616)
`LIST`, `MESSAGE`, `MESSAGES`, `NOTICE`, `REMOVE` (global.c:853-857) — persistent network announcement messages (saxdb, global.c:873), replayed to users on connect/auth per target class.

### MemoServ (module, compiled in deployed image; bot "MemoServ", data/x3.conf:834-835)
`send`, `list`, `read`, `delete`, `cancel`, `history`, `expire` (+oper), `expiry`, `status`, `set`, `oset` (mod-memoserv.c:1336-1346). Account-to-account memos, saxdb-persisted (1333).

### HelpServ (module, compiled in deployed image)
35 commands (mod-helpserv.c:4924+, e.g. LIST/NEXT/PICKUP for the request queue), dynamic per-support-channel bots created at runtime; own saxdb section (5009). Support-ticket queue with helper statistics.

### Snoop (module, compiled in deployed image)
No user commands — mirrors connect/join/part/kick/nick/auth events into a channel via a configured bot (mod-snoop.c:342 reads "bot" from config; testnet points it at O3, data/x3.conf:807+).

### SpamServ (core file, always compiled; init at main-common.c:485)
Registered commands spamserv.c:3263-3294 (REGISTER/UNREGISTER per channel, trust lists, badwords/exceptions, flood/caps/adv scanners with per-channel SET). **Disabled in testnet config** (nick commented out, data/x3.conf:710).

### Present in source but NOT in the deployed build
`--enable-modules=snoop,memoserv,helpserv` only; excluded: mod-sockcheck.c (proxy scanner with its own TCP prober), mod-blacklist.c (DNSBL via sar.c resolver), mod-track.c (event tracker), mod-python.c (embedded Python), mod-qserver.c (raw-TCP query server), mod-webtv.c (WebTV workarounds).

## 2. Persistent state model

### saxdb (flat text, recdb format)
Registered databases (name → reader/writer): NickServ (nickserv.c:6255), ChanServ (chanserv.c:10231), OpServ (opserv.c:7576), Global (global.c:873), gline (gline.c:312), shun (shun.c:313), modcmd (modcmd.c:2626), sendmail-queue (mail-common.c:157), MemoServ (mod-memoserv.c:1333), HelpServ (mod-helpserv.c:5009), SpamServ (spamserv.c:3245), python (mod-python.c:2078, not compiled). Each can be its own file or a section of one "mondo" file (saxdb.c:36,57,96-98). **Deployed testnet uses a single mondo `x3.db`** (data/x3.conf:967-975; container `/x3/data/x3.db` confirmed). Periodic timed writes per-db (`write_interval`) plus write-on-exit; human-readable/hand-editable.

### Entities and keys (all primary keys are NAMES, no stable IDs anywhere)
- **Account** `struct handle_info` (nickserv.h:93-120). Key: handle string, in `nickserv_handle_dict` (nickserv.c:172; saxdb record key = handle, nickserv_saxdb_write 4148-4155). Holds: MD5-crypt passwd, email, hostmask list, SSL-fingerprint list, ignore list, one pending cookie, notes, `opserv_level`, 32 single-char flags, karma, fakehost/epithet, lastseen, plus in-memory links: online userNodes, owned nicks, channel-access entries.
- **Owned nick** `struct nick_info` (nickserv.h:122-128), key: nick in `nickserv_nick_dict` (174); only active when `disable_nicks` is off.
- **Registered channel** `struct chanData` (chanserv.h:87-122). **Keyed by channel name**: saxdb record key is `channel->channel->name` (chanserv.c:9837); in-memory it is a doubly-linked list `channelList` (chanserv.c:810) hung off the live chanNode's `channel_info` pointer. There is **no stable channel identity** — `MOVE` (cmd_move chanserv.c:2747+) re-points the same chanData at a different chanNode/name, and the next db write records it under the new name. Fields: registered/visited/ownerTransfer timestamps, topic/greeting/topic_mask, registrar, enforced modes, 30 flags, per-channel level options (`lvlOpts`) and char options (`chOpts`), then sub-collections.
- **Channel access entry** `struct userData` (chanserv.h:137-158) — the many-to-many join of account↔channel: access level (1-500), autoop/autoinvite flags, seen/expiry timestamps, info line. Double-linked into both the chanData list and the handle_info list (152-157). Persisted inside the channel record under `users`, sub-keyed by handle name (chanserv_write_users 9742-9766).
- **Persistent channel ban** ("lamer") `struct banData` (chanserv.h:171+), persisted under `bans` in the channel record (9769+), enforced at join (8482-8518).
- **Channel notes** dict keyed by note-type name; note types themselves are a ChanServ-db-level collection with per-type access/visibility rules (chanserv_write_note_type 9815-9835 region).
- **Suspensions** (channel + per-user) with `previous` chain (chanserv_write_suspended 9792-9805); **giveownership history** records (chanserv.h:196, KEY_GIVEOWNERSHIP chanserv.c:9579) with a transfer cooldown timestamp.
- **OpServ db** (opserv_saxdb_write): reserved nicks (keyed by nick), bad words, exempt channels, **trusted hosts keyed by IP string** (limit/expiry/issuer/reason), gags (by mask), alerts (by name, with discrim text + reaction), routing plans + options, historic max clients.
- **glines/shuns**: X3 keeps its own copies in dedicated saxdb sections (gline.c:312, shun.c:313) and re-pushes/re-pulls via GL/SU + remote STATS (numerics 247/542).
- **modcmd db**: persisted command bindings/aliases and per-command access overrides, plus service-bot definitions (modcmd_saxdb 2626, writes e.g. `channel_access` overrides modcmd.c:2128-2129) — i.e. the *permission wiring itself* is persistent state.
- **Referential integrity**: everything cross-references by name string, resolved at db-read; account RENAME/UNREGISTER walks and fixes dependent structures (and appends to `sync.log` — see §6).

### LDAP (compile-time `--with-ldap`, runtime `ldap_enable`)
x3ldap.c API: bind-check auth (`ldap_check_auth`:125), admin bind (110), search/get info (139/181), add account (367), delete (404), rename (419), modify password/email (551), set oper-level attribute (`ldap_do_oslevel`:499), oper-group membership add/remove (619/647). Usage pattern in nickserv: LDAP is an **auth oracle + optional mirror** (writeback on register/unregister/rename/email/password when `ldap_writeback`; autocreate local handle on successful LDAP bind, nickserv.c:2146-2189). saxdb remains the store of record for everything except the password check when LDAP is on. **Deployed testnet: compiled in but disabled at runtime** — `"ldap_enable" "0"` (data/x3.conf:272).

## 3. Privilege / authority model

### Channel access scale (chanserv.h:26-35)
`UL_PEON=1, UL_HALFOP=150, UL_OP=200, UL_MANAGER=300 (=UL_PRESENT — the level whose presence keeps a channel from expiring), UL_COOWNER=400, UL_OWNER=500, UL_HELPER=600` (virtual staff level, never stored).

### How access is checked
- Lookup: `_GetChannelUser` (chanserv.c:892-951). With the override flag, a staff member whose account has the HELPING flag gets a synthetic access-600 entry from `helperList` — unless the channel is `nodelete`-protected and their opserv_level is below `nodelete_level` (899-924). This is the staff-override backdoor, and it is flagged in command logs.
- Command gating: `svccmd_can_invoke` (modcmd.c:448-594). Each command carries `min_channel_access` populated from the registration's `"access","manager"`-style template (parsed at modcmd.c:359-362); REQUIRE_CHANUSER compares `uData->access < cmd->min_channel_access` (510-513). Staff use beyond one's true access is tagged ACTION_OVERRIDE/ACTION_STAFF for audit (584-592). Because modcmd bindings persist to saxdb, **per-network re-tuning of any command's required level is data, not code**.
- Per-channel thresholds: `lvlOpts[]` (enum chanserv.h:37-47: enfops, enfhalfops, enfmodes, enftopic, pubcmd, setters, userinfo, inviteme, topicsnarf) checked by `check_user_level` (chanserv.c:957-972), with an owner-exemption rule for setters >500 (969-970).

### Interaction with IRC +o
- Join-time: `handle_join` (chanserv.c:8422) auto-applies modes when `chAutomode` allows: access ≥ UL_OP → +o, ≥ UL_HALFOP → +h, ≥ UL_PEON → +v (8572-8583); plain automode for no-access users per channel option (8542-8547); suppressed during burst and join-floods (8540, 8602).
- Enforcement: giving +o via ChanServ commands or raw MODE is validated by `validate_op` (1928-1936): the victim must have access ≥ UL_OP or the actor must clear the channel's `lvlEnfOps` threshold; parallel `validate_deop`, halfop variants (1946-1964); server-observed mode changes are policed in the mode hook (8925).
- IRC +o (channel op) confers **nothing** in X3's model by itself; all authority flows from the access entry (or staff flags).

### What "founder" means
There is no founder field. Registration creates a userData at access 500 for the registrant (chanserv.c:2619: `add_channel_user(cData, handle, UL_OWNER, 0, NULL, 0)`). `ADDUSER` cannot create a peer: the actor's access must strictly exceed the new level (cmd_adduser: `if(actor->access <= access_level) reply("CSMSG_NO_BUMP_ACCESS")`), so a second 500 requires staff override. `GIVEOWNERSHIP` (7312) swaps the 500 entry, records a `giveownership` audit struct and enforces a transfer cooldown (`ownerTransfer` + `giveownership_timeout`, chanserv.c:63,9125). Channel expiry is driven by presence of ≥UL_PRESENT (300) users (`chanserv_write_users` returns high_present, 9742-9749; visited refresh 8585-8586).

### Account-level privilege (distinct axis)
- `handle_info->opserv_level` (0-1000, nickserv.h:112). Checked by `oper_has_access` (nickserv.c:658-680): requires **both** IRC oper status (umode +o via `IsOper`, or HELPING flag for level-0 checks) **and** sufficient opserv_level; `OPER_SUSPENDED` account flag vetoes. So OpServ authority = ircd O-line ∧ services level, a dual gate.
- Set via `OSET ACCESS|LEVEL` (opt_level nickserv.c:3704; requires the setter to outrank the target; LDAP oslevel writeback 3690). Admin threshold defaults to 800 (opserv.c:7230, `opserv_conf_admin_level` 7334). Notable ladder points from the command tables: 100 trace/channel intervention, 300-450 mass channel ops, 600 gline/shun/gag, 601 join/part/checkpass, 650 hostscan, 750 account merge, 800 trusts/alerts/reserves/routing/dnr-notes, 900 die/restart/jupe/defcon/raw-privs, 999 raw/dump/clone/svs*.
- Account flags add orthogonal grants: HELPING (staff override + suspended-channel access), NETWORK/SUPPORT helper flags (modcmd.c:544-563), IMPERSONATE 'I' hard-floored at 999 (nickserv.c:6141-6145).

## 4. IRCd↔services boundary (P10)

### Dispatch model
Single token→handler dict built in `init_parse` (proto-p10.c:2814-2957); both long commands and tokens registered. Client commands arrive as P10 `P` (PRIVMSG) to a service numnick and are dispatched through `privmsg_funcs[]` indexed by the local bot's numnick (proto-p10.c:351-352, 477-478, 743-744); modcmd routes from there. **Unknown/unregistered commands are logged `PARSE ERROR` and dropped** (parse_line, proto-p10.c:3020-3022) — nothing is replied.

### Received & genuinely handled (handler function exists, table 2815-2957)
SERVER/PASS/ERROR/SQUIT, EOB `EB` + ack `EA`, PING/PONG (incl. ASLL), N (nick intro + change), Q (quit), D (kill), AC (account stamp), FA (fakehost), B (burst), C (create), J/L (join/part), K (kick), M (mode), OM (opmode), CM (clearmode), T (topic) + topic numerics 331/332/333, A (away), U (silence), W (whois), V (version), AD (admin), R (stats), GL (gline), SGL (sgline), SU (shun), SSU (sshun), SJ/SN/SP (svsjoin/svsnick/svspart), MK (mark), PRIVS, RI (rping), AU (SASL — `cmd_sasl` 1519 → nickserv `handle_sasl_input`), **BX (BOUNCER_TRANSFER, fork extension, `cmd_bouncer_transfer` 1740)**, gline/shun stats numerics 247/542, err-nick 432.

### Received & explicitly ignored (`cmd_dummy`, 54 registrations)
SWHOIS, TEMPSHUN, SMO, SNO, RPONG, DESTRUCT, INVITE, DESYNCH, WALLCHOPS/WALLVOICES/WALLHOPS/WALLOPS/WALLUSERS, EXEMPT (dnsbl), ALIST, SPAMFILTER, LUSERS, SETTIME, ZLINE, REMOVE, TRACE, MOTD, UPING, and a batch of numerics (401/403/404/439/441/442/443/461/467, 219/230/345).

### NOT implemented at all — the specific asks
Verified by grepping all of `src/` (not just the table):
- **REGISTER (`RG`) / VERIFY / REGREPLY: absent.** No token, no handler, no string match anywhere in x3 master.
- **Channel RENAME (`RN`): absent.** All "RENAME" hits in x3 are the NickServ *account*-rename command (nickserv.c:6178) and helpserv text.
- **LOC: absent as a P10 command.** X3's "LOC" is the login-on-connect *concept* implemented via the SASL path (`loc_auth` nickserv.c:2121); there is no `LOC` token handler.
- **XQUERY (`XQ`) / XREPLY (`XR`): absent.** (Upstream srvx had XQUERY support; x3 master does not.)
- Also absent: MD (metadata), MR, TG, CI — none of the fork's IRCv3 S2S extensions. parse_line does skip a leading `@tags` block (proto-p10.c:2999-3004), so tagged S2S lines don't break framing.

Nefarious (fork, `ircv3.2-hardening`) defines and emits all of these toward services: `include/msg.h:376-381` (XQ/XR), `539-541` (REGISTER=RG), `556-557` (RENAME=RN); `ircd/m_register.c:114` sends CMD_REGISTER at the services server; `ircd/m_xquery.c:116,144` and `ircd/s_auth.c:3031` send XQUERY. Against deployed X3 these land in parse_line as PARSE ERROR log lines and are silently dropped; no reply/REGREPLY/XREPLY ever comes back.

### Sent by X3 (emit API, proto-p10.c:489-1941)
PASS/SERVER introduction (irc_pass 843, irc_introduce 849, irc_server 526), N user-introduce/nick (616/671), Q (1008), SQ (685), EB/EA (786/792), AC account stamp (650), FA fakehost (659), B channel burst for owned state (896), J/L/K, M/OM/CM (1036, opmode/clearmode via opserv), T (1142) + fetchtopic (677), I invite (1055), GL (861) / ungline (884), SU (868) / unshun (890), SETTIME (875), SJ/SN/SP svsjoin/svsnick/svspart (1078/1112/1084), SVSQUIT (1090), D kill (1024), MK mark (1217), SW swhois (1118), TEMPSHUN (1126), PRIVS (1934/1941), AU SASL replies (1296), SNO server notice (1286), W remote whois replies via numerics (1206), R stats request (1106), RI/RO rping/rpong, P/O privmsg/notice, WA wallops (719), RAW escape hatch (1200).

## 5. External dependencies

- **The ircd uplink** (single P10 link; multiple configured uplinks with cycling, `max_cycles` data/x3.conf:61).
- **LDAP** — only optional network service on master (x3ldap.c, OpenLDAP client API; see §2). Deployed: compiled, runtime-disabled.
- **Email** — pluggable at configure time (configure.ac:258-260): default `mail-sendmail.c` (forks the local sendmail binary) or `mail-smtp.c` (its own SMTP client on ioset). Deployed image uses the default (Dockerfile has no `--with-mail`). Mail queue persisted via saxdb (mail-common.c:157).
- **DNS** — `sar.c` (2074 lines, a self-contained async resolver) is linked, but its only consumer is mod-blacklist (not compiled in deployed image).
- **Keycloak: confirmed X3 master CANNOT reach it.** There is no HTTP client of any kind on master — grep for keycloak/curl/http across `src/` yields only a help-text URL (modcmd.c:2066) and an unrelated configure macro (configure.ac:113-129). The Keycloak capability (libkc adapter `src/x3_kc_adapter.c`/`x3_kc_bridge.c`, coalesced REST updates, webhook, libmdbx cache `x3_lmdb.c`) exists **only on the non-shipping `keycloak-integration` branch**. The running container binary contains zero "keycloak" strings. On the testnet, Keycloak is reached by *nefarious* (libkc), never by X3; X3's only conceivable path to Keycloak-managed accounts would be LDAP federation, which is currently disabled in config.
- Everything else (event loop ioset*, timers timeq, dicts, slab allocator, logging) is in-process.

## 6. Size and shape of the code

### Clean-ish layers (separable)
- **ioset** (ioset.c + epoll/select/kevent backends) — self-contained event loop.
- **proto-p10.c / proto-common.c** — the wire boundary. Consumers see: `irc_*` emit functions + `reg_*_func` event hooks (typedefs hash.h:410-455: server_link, new_user, del_user, nick_change, account, new_channel, join, part, kick, topic, mode, privmsg/notice per-bot, sasl_input...). A proto-bahamut once existed upstream; the abstraction line is real, though P10-isms (numnicks, burst rules) leak into hash.h structs.
- **saxdb** — persistence engine fully behind reader/writer callbacks (saxdb.c:33-58).
- **modcmd** — command routing/binding/permission layer, reusable in principle, though it has hard extern knowledge of chanserv/nickserv (modcmd.c:449 `extern struct userNode *chanserv`, chanserv-specific gating 482-515, `modcmd_get_handle_info`).
- **tools/dict/timeq/alloc** — dependency-light utility floor.

### The tangle
- Network state is bare globals: `dict_t channels, clients, servers` (hash.c:35-37) mutated by proto and read by every service; `struct userNode`/`chanNode` (hash.h:218/285) carry service-owned pointers (`handle_info`, `channel_info`) directly, so nickserv/chanserv state is threaded through the "generic" state layer.
- The three monoliths (chanserv 10260 / opserv 7592 / nickserv 6274 lines) each mix command handlers, enforcement hooks, config parsing, and saxdb serialization in one file; nickserv.c additionally contains the whole SASL server, LDAP glue, cookie/email flows.
- OpServ reaches down into link management (JUMP/RECONNECT/routing manipulate the uplink layer directly).
- Cross-service calls are direct function calls against each other's headers, not via any service interface.

### Dead / vestigial / site-specific
- mod-webtv.c (451 lines, WebTV client workarounds) — vestigial.
- mod-qserver.c (raw-TCP query server, srvx 2006) — not built.
- ChanServ toys (10165-10175) + karma — conveniences.
- `#ifdef notdef` burst-ban block (chanserv.c:8441-8465), commented-out WARN commands (opserv.c:7524, 7551-7553), `config.h.in~` committed, EXTRA_PROGRAMS checkdb/globtest (src/Makefile.am:11,89-90).
- Afternet-specific hardcodes: cookie-email bodies point at afternet.org URLs (nickserv.c:391,399,413), LDAP dn example (x3ldap.c:133), dev-team notice (modcmd.c:2066).
- `SyncLog` (log.c:1042-1068): appends REGISTER/RENAME/UNREGISTER lines to a flat `sync.log` for an external account-sync consumer that is **not in this repo** (legacy Afternet replication trail); `parselog` (log.c:1070+) can replay service commands from logs.
- Master-vs-srvx fork deltas relevant here: BX bouncer-transfer handler (proto-p10.c:1740, latest commit 7e48cc5), SASL support, sslfp auth, S2S tag skip, UL_HALFOP=150 level inserted into the classic srvx scale.
- Testnet config quirk: data/x3.conf contains `histserv` blocks (627-630, 847+) but **no histserv code exists on master** — mod-histserv.c lives only on `keycloak-integration`; the running master binary ignores the unknown config block (0 "histserv" strings in binary).

## 7. Could not determine / explicitly unverified

- Per-command state-effect for every one of the 95 ChanServ / 137 OpServ commands was categorized from the registration tables and spot-read handlers, not exhaustively traced line-by-line.
- Whether any consumer of `sync.log` still exists (external to repo).
- Whether the testnet ircd currently relays any SASL to X3 at runtime versus handling everything locally against Keycloak (both code paths exist; runtime traffic not observed during this survey).
- HelpServ's full 35-command semantics (queue mechanics summarized from registrations only).
- The exact behavioral delta of `upstream/bouncer-transfer` and other local branches vs master was not audited (only `keycloak-integration` was diffstat'd).

## 8. Addendum 2026-08-04 — post-survey X3 changes (survey base: master @ `052d6e0`)

X3 moved substantially in the five days after the survey (branch
`feature/channel-relocate-testnet` @ `a2ad2f0`, plus PRs #57/#58/#59). The
sequencing doc's "Reconciliation pass 2026-08-04" is the analysis; raw deltas
against this inventory:

- **§4 "Channel RENAME (`RN`): absent" is stale.** X3 now handles `RN`
  (`proto-p10.c:3235-3236`) including the relocate consent split — positional
  marker `RN <old> <new> C :<reason>` (`RELOCATE_MARKER`, `proto-p10.c:2515`,
  detected `:2603`) dispatching `RelocateChannel()` (`hash.c:797`) vs
  `RenameChannel()` (`hash.c:767`).
- **§4 rename *authorization* is answered now.** `cmd_account`'s `R` branch gates
  on `argc >= 7 && argv[5]=="RENAME"` (`proto-p10.c:1738-1762`) — the legacy
  4-arg account stamp is unaffected — and replies `AC <cookie> A/D RENAME`.
  Deny ladder `chanserv_rename_allowed()` (`chanserv.c:8552`), owner-gated
  (`UL_OWNER`).
- **New ChanServ state (converter-relevant):** saxdb-persisted rename-DNRs
  (`chanserv_rename_dnr()`, `chanserv.c:2129`; `rename_dnr_duration` default
  86400; fingerprint reason string `"Channel was renamed"`), relocate tombstones
  + husk sweep with burst re-arm (`chanserv_relocate_tombstone()` `:2191`,
  `chanserv_relocate_husk_check()` `:2254`), service-bot follow
  (`chanserv_relocate_bots()` `:2913`), config keys `rename_dnr_duration` /
  `relocate_grace` (`chanserv.c:9440-9448`).
- **§3 registered-mode emission redesigned** (PR #57): X3 now emits `+R`
  (registered) unconditionally on register/unregister/move/DB-load + handle_join
  self-heal; `+z` is a new X3 `MODE_PERSIST` bit set only when `off_channel>0`.
  The survey-era truth (no marker ever emitted, `off_channel` gate) is history.
- **P10 `server.type` is now 9** (was hardcoded 8 in the docker template; testnet
  flipped 2026-08-01, `X3_SERVER_TYPE`).
- **Config path redesign approved, unimplemented** (2026-08-04 env-interpolation
  spec): recdb parser gains `${VAR}` / `${VAR:-default}` interpolation on quoted
  values; `x3.conf-dist` + entrypoint sed retire. Measured while scoping it:
  `database_get` ~491 call sites; `conf_get_data`-style path lookups ~145 across
  27 files + ~24 `conf_register` reload callbacks.

## 9. Delta addendum 2026-08-06 — unpark survey re-run

Run per the sequencing doc's unpark policy (re-verify deltas 3/5 before Phase 0).
Baseline: the §8 addendum (x3 `feature/channel-relocate-testnet` @ `a2ad2f0`).

- **Code delta: NONE.** x3 working tree clean, HEAD still `a2ad2f0`, and
  `git rev-list --count HEAD..origin/{master,feature/channel-relocate-testnet}`
  both 0 after fetch. §8 remains the complete post-survey inventory; the §8
  feature-growth warning (delta 5) has not compounded further.
- **NEW FINDING — the Keycloak→X3 webhook consumer does not exist.** User
  reported the path dead at unpark; source-verified: `grep -rl webhook x3/src/`
  matches nothing — this X3 has **no HTTP listener and no keycloak-webhook
  handler at all** (the endpoint concept belongs to the dead x3 fork the SPI's
  SCRAM spec also came from). Yet the bed's `.env.local` still lists
  `http://x3:9080/keycloak-webhook` first in
  `KC_SPI_EVENTS_LISTENER_WEBHOOK_EVENTS_URL` (before the live
  `http://nefarious:9090/keycloak-webhook`), so every Keycloak user/admin event
  fires a doomed delivery + retry cycle (visible as recurring
  `WebhookEventListenerProvider ... attempt 1 failed, retrying` WARNs in
  keycloak logs). Consequences for the merge: (a) the demotion package (Phase 3)
  has one FEWER integration to preserve — X3 never consumed Keycloak events in
  this lineage; cache-coherence toward X3 flows only via LDAP sync + P10; (b)
  bed hygiene item (user's `.env.local`, their edit): drop the `x3:9080` entry
  to silence the retry noise — needs a keycloak restart to take effect; (c) the
  SPI's residual "X3's expected format" prose describes a consumer that does
  not exist — genuinely stale, contra the 2026-08-06 hardening session's
  initial read.
