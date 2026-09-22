# CRDT-mesh: the reply direction (server → user toward a tree-absent home)

Batch 6 item 3 of `crdt-mesh-s2s-coverage-audit.md`. Design pass 2026-09-21; status at the bottom.

## The gap

Every carrier shipped so far moves an EVENT (a message, a mode, a kill, a services command) to the
node that must act on it. What comes back — the numerics and NOTICEs a server sends to the user
who asked — still rides the tree only. On a node where the requester's home server is a mesh
stub/anchor (`STAT_MESH_SERVER`, dead-sink Connection, fd -1) the reply is built, handed to
`send_buffer`, and dropped by `can_send` (send.c:1101-1105, 1236-1244). Witnessed: GITSYNC replies
from the node that executed the 'J' broadcast, the forwarded `PRIVS <nick>` query's answer, every
remote-executed hunt (`MOTD`/`VERSION`/`ADMIN`/`INFO`/`TIME`/`LUSERS` with a server argument), and
the numerics of any `ms_` handler that answers a remote user with `send_reply`. (Remote WHOIS
already sidesteps it by answering locally when the destination is mesh-only,
`whois_dest_is_mesh_only`; idle time is the only owner-exact datum it loses.)

Size of the class (c-auditor inventory, 2026-09-21, 583 unicast call sites + 1 136 `send_reply`
sites): `send_reply` (all numerics, `ircd_reply.c:83-177`) builds its own MsgBuf and calls
`send_buffer` DIRECTLY — it never passes through `sendcmdto_one`; the seven `sendcmdto_*one*`
variants (send.c:1338/1415/1465/1514/1605/1679/1719) all do `to = cli_from(to)` and end in
`send_buffer`; `do_numeric`'s relay (s_numeric.c:147) is a `sendcmdto_one`. Server-sourced
NOTICE/PONG/BX to a possibly-remote user: 18 sites in `ms_gitsync`, 6 `ms_connect`, 4
`ms_version`, 11 uping, 3 `ms_settime`, 3 asll, `ms_kill:256`, `ms_ping:251/275`, `ms_rping:149`,
`do_oper` autojoin notices, `do_whois:353`, `connect_server` (s_bsd.c:1612 is deliberately
remote), `exit_client:978`, BX M to a remote alias (m_batch.c:360-383, 1350, 1402 — no mesh try),
ACCOUNT LOC forward (m_account.c:446-452, `acptr` can be a user, no try on that leg).

## Design

### One hook, at the single choke point: `send_buffer`

`send_buffer(to, mb, prio)` is the only function every family reaches (send_reply, the seven
sendcmdto_one variants, sendrawto_one) and it still holds the ORIGINAL `to` — the user — when it
is entered. Before its `to = cli_from(to)`:

```
if (crdt_reply_route_try(to, mb))      /* tunnelled over the mesh instead of the dead sink */
  return;
```

`crdt_reply_route_try` (m_crdt.c) fires only when ALL hold:

- `cli_user(to)` (a user), `!MyConnect(to)`, and `IsMeshStub(cli_from(to))` — the exact
  dead-sink test. A PRESENTED stub on the gateway still dead-sinks, so it is `IsMeshStub` on
  `cli_from`, never `crdt_server_is_mesh_only` (the presented-stub trap).
- `crdt_shadow_active()`.
- The line parses as a SERVER-form P10 line (source = a 2- or 5-char numeric) and its token is
  not on the exclusion list (below).

**The source is not tested, and does not need to be.** The design first said "server-sourced
only"; the implementation keys on the RECIPIENT alone, which is both simpler and strictly
safer, because two structural properties fence the hook in (verified by reading every
`send_buffer` call site, 2026-09-21):

1. A line built for a CLIENT destination (`msgq_make(0, …)`, or any formatter with no token
   form) renders its source as a NAME. The parse rejects it, the hook returns 0, and the line
   falls through to the drop exactly as before. So every client-form fan-out — `vsendto_mode_butone`,
   `send_batch_*`, the standard-reply builder — is out of reach by construction.
2. Every SERVER-form fan-out loop already skips a dead-sink link before it reaches `send_buffer`:
   the channel server half tests `cli_fd(cli_from(member->user)) < 0` (send.c:2892), and
   `sendcmdto_match_butone` — the masked PRIVMSG/NOTICE path that the mesh carries as 'G'/'g' —
   tests the same (send.c:3500). A stub has fd -1, so channel and masked traffic never reach
   the hook at all.

What is left is exactly `send_reply` plus the seven unicast formatters: the server→user lines
this item is about. That is why no named carrier can double-fire.

The buffer text is the complete P10 server-form line, `[@A<time><msgid> ]<src> <tok>
<dstYXXXXX> <params>\r\n` (`msgq_make` formatted it against the link, so `%C` already rendered
numerics). A one-line accessor `msgq_text(mb, &len)` exposes it (MsgBuf is opaque to send.c). The
hook parses only the prefix: an optional `@…` tag word, then the source numeric (2 chars =
server, 5 = user), then the token. Nothing else is interpreted.

Why no `from`/`cmd` context is needed: the source is IN the line, and the exclusion list is by
token. Why this is safe against double delivery (the inventory's rule): every existing mesh
carrier is `if (!crdt_route_*()) sendcmdto_one()` — the P10 copy is SKIPPED when the mesh takes
the message, so a line that reaches `send_buffer` toward a stub is by construction one the mesh
did not carry. The remaining risks are state the DOC already converged, and fan-out amplification:

**Exclusion list (by token):** `M` (MODE): `do_oper` :254/271/273 sends the umode echo to a
remote `sptr`, and umodes ride the user record (`crdt_state.h:88`) — the home node would print
the mode twice. Nothing else in the inventory is a server→USER line whose effect the doc also
carries (ACCOUNT's owner tunnel and the SVS* re-emits are server-targeted; METADATA/MARKREAD/
REDACT/WEBPUSH S2S emits target servers; tempshun/KILL/INVITE/redact single sends are
`MyUser`-gated). The list is a `switch` in one place; grow it, never the predicate.

**Amplification fence:** a line is tunnelled once, at the node that BUILT it. The receiver
delivers to a local user only; if the user is not local it relays by the existing CR M unicast
routing (next-hop or flood + msgid dedup), never re-enters `send_buffer` with a stub `to`
(delivery is `sendrawto_one` to a `MyConnect` client, whose `cli_from` is itself).

### The frame: CR M letter `Y` (raw server line to a user)

Reuse the user-routed CR M carrier (next-hop toward the owner, flood fallback, msgid dedup,
onward relay — all already there for `P`/`N`/`T`/`K`/`I` unicast):

```
:<srv> CR M <msgid> Y <srcYY|srcYXXXXX> <dstYXXXXX> <ttl> :[@A…] <tok> <params>
```

- source token = the line's own prefix (a server source is re-encoded to 2 chars by
  `crdt_m_source_token`'s rule; a user source stays 5). The receiver already discriminates
  server-form (2 chars) from user-form.
- text = the line from the token onward, tags first if present, CRLF stripped. Length: a P10
  line is ≤512 bytes; the CR M framing adds ~40, and CR M lines already carry PRIVMSG bodies, so
  the same chunking discipline (`s2s_chunk`) applies if it ever overflows — the numeric family
  never will (they were built to fit the 512 wire).
- Letter `Y` is unused on CR M ('Y' is a CR X letter = XREPLY; the tables are independent).

### The destination: re-inject through the server-side entry

On the home node (`findNUser(dst)` is `MyConnect`) the receiver calls
`crdt_reply_reinject(srctoken, text)`:

1. Resolve the source: 2-char → `ssrv = FindNServer(src)`; under LEGACY_PRESENCE every reachable
   server — including legacy ones fronted by a gateway — has an anchor here, so this resolves; if
   not, `ssrv = &me` (the rewrite `FEAT_HIS_REWRITE` applies to non-opers anyway). 5-char →
   `findNUser(src)`, else drop (a user-sourced raw line to a mesh-only user is not a case the
   existing carriers leave over; logged at debug).
2. `@A<time><msgid>` present → stash into `cli_s2s_msgid(&me)`/time for the duration of the
   re-inject (what `parse_server` does on `cptr` for a P10 arrival) so `fwd_label_find` batches a
   forwarded labeled reply exactly as on the tree; clear after.
3. Numeric token → split `[target, rest]` (parse.c:2106-2111 keeps a numeric's tail as ONE
   parameter, colon preserved) → `do_numeric(num, 1, &me, ssrv, 3, parv)`. Its gate
   `!IsServer(sptr)` (s_numeric.c:68) becomes `!(IsServer(sptr) || IsMeshStub(sptr))` — the
   inventory found this is ALSO an independent drop point today: parse.c admits an anchor-prefixed
   numeric over a CRDT-aware link (`CrdtAcceptBeyondHorizonSource`) and `do_numeric` then drops
   it. Same treatment `m_privs.c:95`, `m_markread.c:476`, `m_chathistory.c:6694`, `m_account.c:225`
   already got.
4. Any other token → message-table lookup, call the SERVER handler with `(cptr=&me, sptr=ssrv,
   parc, parv)` after the CR X splitter's parv rules (factored out of `crdt_services_reinject`
   into `crdt_split_p10_body()` — three re-injects share it; cmocka'd). Covers NOTICE (`O`),
   PONG (`Z`), BX (`BX` — T1 below must land first), ACCOUNT (`AC`) and anything future. The
   handler's own `IsServer(sptr)` gates are the per-handler audit of 2026-07-27; a token that
   turns out to need `|| IsMeshStub` gets it then, like the four above.

`cptr=&me` mirrors `crdt_services_reinject`; `do_numeric`'s `cli_from(acptr) == cptr` cannot
match (`&me` is nobody's link). `parse_server(&me, line)` was rejected: its fake-direction check
needs `IsServer(cptr) && IsCrdtAware(cptr)` for a stub prefix, which `&me` fails.

### Prerequisites folded in (from the BS/BX trace, item 1b)

- **T1** `defer_bx_for_alias` :9793/9795 paired gate (`IsServer || IsMeshStub || IsMe`) — the
  `&me` re-inject of a BX arriving before its BX C is otherwise dropped; the `Y` carrier's BX M
  leg would hit the same queue.
- **T2** run the four link cleanups in `crdt_shadow_convert_to_stub` and before the Case-B
  anchor free; 30 s TTL on BX M batches; clear the burst flags on conversion (REVIEW-1).

### The request direction (hunt family) — explicit, not generic

Server-TARGETED dead-sinks are NOT hooked generically (the blast radius is every P10 line built
toward a stub link, some of which are meant to be swallowed). Two explicit sites:

- `hunt_server_cmd` / `hunt_server_prio_cmd` (s_user.c:203/312): before the send, if
  `IsMeshStub(acptr)`, flood a CR X frame `X <msgid> <srcYY> <dstYY> L <ttl> :<srcYXXXXX|YY>
  <tok> <params>` (the body carries its OWN source prefix because CR X's `srcYY` is a server
  numeric and hunts are user-sourced) and return `HUNTED_PASS`. The destination re-injects
  through the same `crdt_reply_reinject` (message-table path). The reply comes back through `Y`.
  Letter `L` on CR X is free. Covers WHOIS-with-idle (keep `whois_dest_is_mesh_only`'s local
  answer as the fallback when the hunt cannot route), MOTD, VERSION, ADMIN, INFO, TIME, LUSERS,
  RULES, the PRIVS query. STATS/TRACE/LINKS/MAP stay tree-only by design (`/CRDT map|peers|status`
  is the oper substitute).
- `abort_sasl` (m_sasl.c:336): admits a stub agent at :324 then sends `SASL … D A` bare — add the
  `crdt_route_services_try(acptr, 'A', body)` that `sasl_forward` (m_authenticate.c:127) has.
  One line, same commit as the reply half.

Ship order: (a) T1+T2 (item 1b); (b) reply half: `msgq_text`, hook, `Y`, re-inject, `do_numeric`
gate, `abort_sasl`; (c) request half: `L` at the two hunts. Each with its gate; (b) and (c) can be
one deploy.

### Side finding — checked, NOT a bug

The inventory flagged `send_umode_out` (s_user.c:1725-1727) for using `crdt_user_is_mesh_only`,
which is false for a gateway-PRESENTED stub. Verified: a presented stub's users WERE introduced to
legacy by the gateway (that is what presenting means), so the MODE toward legacy is correct there
and the dead-sink copy is harmless (the doc carries the umode). No change.

### Gates (bed, five-node fleet + primary legacy)

- `gitsync_gate.py` (reply-based) from an oper on leaf5 (overlay-only) and on hub2: the
  "Triggering GitSync…"/status NOTICEs from every executing node arrive, once each (today: only
  the tree-reachable ones).
- `privs_gate.py` extended: `PRIVS <remote-nick>` from leaf5 for a user on the primary and vice
  versa — the forwarded query's 270 numerics arrive (today: silence).
- New `hunt_gate.py`: `VERSION hub2`, `TIME primary`, `MOTD leaf2` from leaf5; `WHOIS nick nick`
  for a leaf5 user from the primary (idle now owner-exact); each reply exactly once.
- Labeled: `@label=x VERSION hub2` from leaf5 → the numerics land inside the label batch.
- Negative: the masked/channel/PRIVMSG one-copy gates unchanged; `OPER` on leaf5 by a remote
  path shows ONE mode line (the MODE exclusion).
- `bed_regress.sh` 10 suites; soak.
- cmocka: `crdt_split_p10_body` (parv rules, colon-trailing, MAXPARA cap) and the prefix parser
  of the hook (tag word / 2-vs-5 source / token) — pure string functions, engine-purity rule.

### Residue (named up front)

- Lines to a user homed on a LEGACY server via the gateway already ride the tree from the
  gateway; the hook is stub-only and leaves that path alone.
- A reply whose origin server has NO anchor on the home node (beacon stale) is rewritten to
  `&me`; the oper-visible source name is then the home server. Cosmetic, bounded by the beacon
  window.
- `verify_emit` (crdt_shadow.c:4100) and the 28 `m_crdtinfo.c` NOTICEs are `mo_`-only today; if
  `/CRDT status <server>` is ever hunted they come for free through `Y`.
- Server-targeted dead-sinks beyond the two explicit sites stay as they are (design choice above).

## Inventory (c-auditor 2026-09-21, verified where cited)

- `send_reply` → own MsgBuf → `send_buffer` (ircd_reply.c:145-158, 170-176): the hook MUST be in
  `send_buffer`. All seven `sendcmdto_*one*` variants swap `to` for its link first.
- parse.c:2106-2111 + 2177-2209: numerics split as exactly `[target, rest]`, colon preserved.
- s_numeric.c:67-69 rejects a `STAT_MESH_SERVER` source (second drop point).
- Double-carriage: KILL/INVITE/ACCOUNT-reply/BX E all `if (!route) send` — safe; SVS*, METADATA,
  MARKREAD, REDACT, WEBPUSH, CH federation target SERVERS — out of the predicate; MODE umode echo
  (m_oper.c:254/271/273) — doc-carried → EXCLUDE; ACCOUNT owner tunnel (m_account.c:190-192) is
  gateway-edge-fenced against amplification — server-targeted, untouched; snomask sync macro
  (bouncer_session.c:7896) never even calls for a stub peer → M11, not this item.
- Genuine gaps the hook closes for free: BX M to a remote alias (m_batch.c), ACCOUNT LOC forward
  (m_account.c:446-452), PONG/RPONG to a remote requester, uping/connect/settime/version/lusers
  notices.

## Implementation notes (2026-09-21)

- The seven `sendcmdto_*one*` formatters now pass the ORIGINAL recipient to `send_buffer`
  (which swaps in the link itself, so the normal path is byte-identical); the hook is one call at
  the top of `send_buffer`. The 'Y' text is the whole server-form line (tags, source, token,
  params) so the same `crdt_line_reinject` serves 'Y' and the CR X 'L' request.
- `crdt_p10_split` keeps parse_server's cap rule (the last slot takes the rest of the line).
- `do_numeric` admits `IsMeshStub || IsMe` sources (the &me fallback is STAT_ME, not STAT_SERVER).
- Forwarded labels: the tag is applied on `&me` (what `do_numeric` reads for a local recipient)
  and on the requester's stub link (what `send_reply`'s remote branch reads via `cli_from(to)`);
  the hunt path does NOT arm the send override (it would leak into the next send) — the label
  rides inside the frame instead.
- The hunt's `IsIRCv3Aware(acptr)` label gate admits a stub (every mesh node is aware).
- **A mesh stub is formatted as a SERVER link.** This was the bug the first bed run found: a
  stub fails the exact `IsServer` test, so `%C` rendered NAMES and the formatters chose the long
  command name — the far end could not resolve the source, the target or the command, and every
  hunted reply died at `FindNServer("hub2.fractalrealities.net")`. Fixed at the formatter level:
  `ircd_snprintf.c`'s `%C` treats an `IsMeshStub` destination as a server, and the ten
  `IsServer(to) || IsMe(to)` token/tag choices in send.c's seven unicast formatters admit a stub
  too. Those lines were ALL dropped before, so the blast radius is exactly the carried set.
  `msg_find_token` still falls back to the command trie, so a long-name line re-injects anyway.
- A stub destination whose carrier is down gets ERR_NOSUCHSERVER "Server is not reachable"
  instead of silence.

## The carriers move a BOUNDED token set (c-auditor sweep, 2026-09-21 19:20)

The sweep of all 97 server-slot handlers found that the re-inject's own `&me` fallback (used when
the line's source numeric resolves to no local Client) is the MIRROR of the stub hazard: `&me` is
`STAT_ME`, so it fails the exact `IsServer` test exactly as a stub does, and **asserts are compiled
in by default** (`configure.in:283`), so `assert(IsServer(cptr))` is an abort, not a no-op. Eight
handlers carry that assert. Reachable-today crashes it found, all verified by hand:

| site | shape | reachable via |
|---|---|---|
| `m_pong.c:115` `assert(IsServer(cptr))` | abort | **trivially**: `m_ping.c:274` answers a remote user with PONG; a client on a mesh-only node running `/PING <server>` aborted its OWN node |
| `m_whois.c:356` `cli_user(sptr)->username` | SIGSEGV | the 'L' hunt when the requester has no local Client and the WHOIS target is an oper with +W |
| `m_rping.c:129`, `m_rehash.c:210/212` | abort / SIGSEGV | hunted commands |
| `m_silence.c:341` gate lacks `IsMe`; `apply_silence` derefs | SIGSEGV | SILENCE to a remote user |

Rather than audit and repair ninety-odd handlers that were never written for this source, the
carriers now move **only the tokens they were built to move** (`crdt_line_token_ok`, m_crdt.c):

- reply set ('Y'): every numeric, plus NOTICE, PRIVMSG, PONG, PRIVS, ACCOUNT, BX, BS.
- hunt set ('L'): VERSION, TIME, ADMIN, INFO, LUSERS, MOTD, RULES, WHOIS, PRIVS.
- refused, by design: MODE (the record carries umodes), KILL/INVITE/TAGMSG (their own letters),
  STATS/TRACE/LINKS/MAP (oper introspection, `/CRDT map|peers|status` is the substitute), and
  REHASH/CONNECT/UPING/SETTIME/RPING — **oper ACTIONS, whose authority the carrier cannot convey**:
  with `cptr = &me` they answer ERR_NOPRIVILEGES even when they run. That is the sweep's §2C
  finding turned into a rule rather than a surprise.

A refused token is logged and dropped; the emit side refuses the same set, so an uncarryable hunt
answers ERR_NOSUCHSERVER "Server is not reachable" instead of vanishing. Widening the set means
reading that handler for invariant 2 AND for authority it cannot be given here.

Fixed inside the set: the PONG assert admits `IsMe`; the WHOIS courtesy notice checks `cli_user`;
`find_ban` returns NULL for a userless source (defence in depth -- it formats the source mask
BEFORE walking the list, so even an empty ban list crashed).

Left as recorded hazards, out of the carried set and unreachable today (audit doc has the list):
the other seven `assert(IsServer(cptr))`, `m_silence.c:341`+`apply_silence`, `m_rehash.c:210/212`,
`find_member_link`/`client_can_send_to_channel` (stub), and the `IsServer||IsMeshStub` gates that
omit `IsMe` in `m_mode.c:283`, `m_topic.c:130`, `channel.c:2385`, `channel.c:5286`.

## Open items (queued, not yet applied)

- **Split the re-inject's parameters with the token's own cap.** `crdt_line_reinject` splits into
  up to `MAXPARA+1` parameters; `parse_server` splits into at most `mptr->parameters` and leaves
  the remainder in the last one (parse.c:2178). They agree whenever the trailing parameter carries
  its ':' (which server-form lines do), so nothing the gate exercises differs — but a token whose
  trailing parameter has spaces and no colon would be split differently than on the wire. Look up
  `mptr` first and pass `mptr->parameters` as the cap.

## Gate record (2026-09-21 evening / 2026-09-22 early)

| gate | result |
|---|---|
| `hunt_gate.py 6674 6669 6670 6667 6673` (overlay-only origin -> hub2, leaf2, the LEGACY primary, leaf4) | PASS: VERSION/TIME/ADMIN/WHOIS one reply line each, 317 idle owner-exact, labelled VERSION inside its batch |
| `hunt_gate.py 6667 6674 6673` (legacy origin -> the two mesh-only nodes) | PASS, labels included (needed the presentation-flag fix) |
| `privsq_gate.py 6674 6669 6667` (forwarded PRIVS query) | PASS from hub2 AND from the legacy primary; was SILENT before |
| `gitsync_gate.py 6674` (reply notices) | PASS: all five mesh nodes answer; was tree-reachable ones only |
| `bed_regress.sh` | 10/10 suites, 44 tests |
| `crdt-mesh-absence` | 2/2 on a quiet bed. NOTE: run straight after bed_regress it fails its FIRST assertion (the page is already partial before the test stops anything) -- the documented split-window pollution, which is why the regress runner puts the presence suites first. Re-run clean to judge it. |
| cmocka | 107/107 |
| soak (1 h, 12 ticks x 5 nodes) | CLEAN: 0 valgrind invalid reads/writes, 0 asserts, 0 protocol violations, 0 doc mismatches, all nodes running |

## Status

- 2026-09-21 18:05: design complete; user agreed 18:14 ("Sounds good").
- 2026-09-21 19:10: 1b shipped `a12b8ac` (+ fork `31f2002` BX M TTL); reply + request halves
  shipped `ba3183d` (cmocka 107/107, host build clean); fleet rebuild running; gates next:
  `hunt_gate.py`, `privsq_gate.py`, `gitsync_gate.py`, then `bed_regress.sh` + soak.
