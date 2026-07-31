# X3 channel-rename support (near-term patch, pre-merge)

**IMPLEMENTED 2026-07-31 — E2E verified, NOT pushed.** x3 `feature/channel-rename`
@ a9d565e (9 commits), nefarious `feature/channel-rename` @ 6ad0c49 (5 commits,
incl. WP-burst v3-gate ride-along), testnet fd28684 (vitest 6/6). Full arbitrated
path live-gated: AC R query → owner A / non-owner `D :You must be the channel
owner` → RN → X3 re-key; stamp intact post-deny; timed DNR on old name works.
Implementation surprises (details in `.superpowers/sdd/x3-channel-rename-impl-plan/
progress.md`): **Task 8 added mid-plan — nothing ever set MODE_REGISTERED** (X3's
letter was Bahamut-relic 'z' = fork persist; remapped to 'R', unconditional
±R announces + heal-on-join); wipeout_channel needed MCP_FROM_SERVER (unknown letter
stranded ALL modes at zero on X3 restart); pending-rename table held a raw Channel*
across the 10s round-trip (UAF; now name-snapshot + re-resolve + dedup + completion
re-validation); the AC query emit needed the alias→primary rewrite. **The dynamic
guard fired correctly on first contact** with the full bed (upstream slot + CRDT
anchors, `+6` no `v`) — meaning RENAME stays refused on the standing full-bed
topology; the vitest suite detects that exact FAIL and skips dynamically. §6/§7
(redirect window, history chain) remain follow-on plans. Queue §9 unchanged
(PR #56 review before proposing the X3 PR).

Scoped 2026-07-30. Status: **DESIGN APPROVED — both §5 decisions made 2026-07-30:
(1) rename requires OWNER (500), staff override per convention, no new lvlOpt;
(2) RN delivery = targeted legacy-services forward (ircd forwards RN to direct
downlinks that are `IsService && !IsIRCv3Aware`);
(3) legacy-server policy = dynamic guard ships with this patch (refuse RENAME while
any non-v3-aware non-service server is linked) AND full upstream backport tracked as
its own follow-on (§2, "Frank framing") — prod may run mixed ircd topology, so the
backport is on the deployment path, not a courtesy.** chanNode* holder sweep done (§8).
Same-day additions from user: §6 redirect window, §7 chathistory/name-keyed storage
continuity — recommendations in place, awaiting user sign-off on those two sections,
then task-level implementation plan.

Registered-channel RENAME is one of the two broken capabilities motivating the X3→Nefarious
merge ([[x3-merge-sequencing]] §"Registered-channel RENAME" describes the *long-term* answer:
`chan_authorize(CV_RENAME)` in the daemon). This doc is the **near-term X3 patch** the user
asked for — make rename work against X3 as deployed, per "I left them live in the testnet as
the intention is to eventually fix them". It also fixes the AC…R stamp-poison bug as a
side effect, which is wanted regardless.

## 1. What already exists (ircd side, retained deliberately)

The fork's `m_rename.c` kept the whole services-arbitration machinery behind the
registered-channel refusal (`DO NOT delete as dead code`, m_rename.c:435):

- **Request** (emit currently disabled): `AC <user_numeric> R <cookie> <channel> RENAME <newname>`
  sent to the services server (same routing as RG — `find_services_server()`).
- **Reply**: `<x3num> AC <cookie> A` (approve) / `<x3num> AC <cookie> D :<reason>` (deny).
  Parsed in `m_account.c:331-360`: parv[1] that isn't a server numeric is treated as a
  pending-rename cookie; `pending_rename_complete/deny` fire from there. Timeout path,
  client-exit cleanup, and the cookie table all exist and are wired.
- **On approve**: `pending_rename_complete()` re-validates (name still free, channel name
  unchanged), performs the rename, and broadcasts `RN <old> <new> :<reason>` — **to
  IRCv3-aware peers only** (`sendcmdto_serv_butone_v3`, send.c:1991).

Why the emit is disabled: deployed X3's `AC` handler (proto-p10.c:1733) treats subcommand
`R` as an account stamp and reads our `<cookie>` as the stamp — one RENAME attempt sets
`FLAGS_STAMPED` and silently poisons that user's real account stamp for the session.

## 2. The delivery gap nobody noticed: X3 never sees RN at all

`RN` propagates only to `IsIRCv3Aware` peers (the `v` flag char in the P10 SERVER
handshake, m_server.c:496). X3 introduces itself `+s6o` (proto-p10.c:532) — a legacy peer.
Consequence **today, even for unregistered channels**: any rename silently diverges X3's
channel state (old-name chanNode with all members still in it; the renamed channel invisible
until someone joins and re-creates it from X3's perspective). The patch must close this for
both registered and unregistered channels.

Two candidate mechanisms (§5 decision 2):

- **(a) Targeted legacy-services forward (recommended).** Small ircd helper on the RN
  emission paths: after the v3 broadcast, walk direct downlinks and `sendcmdto_one` the RN
  to any that are `IsService && !IsIRCv3Aware`. Precedent: `sendcmdto_legacy_serv_butone`
  exists for exactly this class of problem (BX P pairing, send.c:2010). Blast radius =
  exactly RN, exactly services; real legacy ircds never see an unknown token.

  **Topology precondition (user probe 2026-07-30): legacy servers do NOT relay unknown
  tokens.** Upstream `parse_server` drops them silently (`ServerStats->is_unco++`,
  DEBUGMODE-only log, no relay, no error — nefarious-upstream parse.c:1572-1594), and
  P10 propagation is per-handler, so there is no generic pass-through. Therefore X3's
  **direct uplink must be a fork server** — only a fork server both receives RN and
  forwards it to a legacy service downlink. X3 behind a legacy hop = RN dies silently
  one hop upstream. Option (b) has the *same* precondition (a legacy uplink never
  receives the v3 broadcast at all), so this doesn't discriminate between them.

  **Frank framing (user, 2026-07-30) and DECISION.** Relay alone couldn't save a
  legacy server anyway: a server that forwarded RN without *applying* it diverges
  itself (keeps `#old` + members while the network operates on `#new`; every later
  mode/join/kick on `#new` is an unknown channel to it). So RENAME is only sound when
  either (1) legacy servers get a full backport (`ms_rename` + re-key + PART/JOIN
  synthesis for local clients + relay), or (2) there is no legacy in the mix except
  X3. **Decision: BOTH — guard now, backport also planned.**
  - *Guard (ships with this patch):* the `v` flag propagates network-wide in SERVER
    intros (s_serv.c:280), so every fork server knows which network members are
    v3-aware. Refuse RENAME (honest FAIL, same style as today's registered-channel
    refusal) while any non-v3-aware **non-service** server is linked; auto-relaxes
    when the last one delinks. This also fixes a **live bug that predates this
    work**: unregistered-channel renames currently execute with legacy servers
    linked and silently diverge them.
  - *Backport (tracked follow-on, own plan):* full rename application on
    evilnet/nefarious2 master (publish rights exist —
    memory `project_upstream_publish_rights`). NOT off-ramp work: production's
    "clean shutdown → rebuild → restart" plan was specifically the X3 merge-in, not
    the ircd fleet — prod may run mixed fork/legacy ircds for a period, and the
    backport is what lifts the guard's restriction during it.
- **(b) X3 advertises `v`.** One char in proto-p10.c:532/535, and X3 receives RN natively —
  plus the *entire* v3-gated stream (metadata burst, ML, TG, MR, BX C/X…), all landing as
  PARSE ERROR log lines unless we `cmd_dummy` each. Aligns with "anchors as steady state"
  long-term, but couples this patch to a much bigger behavioural surface.

## 3. X3 patch (the deliverable)

### 3a. AC `R` disambiguation + rename authorization (proto-p10.c `cmd_account`)

Legit stamp is `AC <target> R <account>` (argc==4). Rename request is argc==7 with
`argv[5]=="RENAME"`. Branch on that — belt (argc) and braces (keyword), exactly the
disambiguation m_rename.c's comment prescribes. In the rename branch:

- `user = GetUserN(argv[1])`, `cookie = argv[3]`, `chan = GetChannel(argv[4])`,
  `newname = argv[6]`.
- Deny (AC `<cookie>` D `:<reason>`) when: user unknown/not authed; channel registered and
  requester's access below the required level (§5 decision 1; staff `IsHelping` override
  follows the `_GetChannelUser` convention); `IsProtected(cData)` (nodelete — matches
  `cmd_move`'s refusal); registration suspended; `opserv_bad_channel(newname)`;
  new name already registered (`GetChannel(newname)->channel_info`); DNR match on the
  owner for `newname` (same loop as `cmd_move`, chanserv.c:2777).
- Channel unknown to X3 or unregistered → approve (nothing to protect; ircd only asks for
  +R channels, but don't trust that).
- Approve = `AC <cookie> A`. **Authorization only — no state change here.** The rename may
  still fail ircd-side (timeout, name grabbed in the race window); state moves only when RN
  arrives.

### 3b. RN handler (new `cmd_rename` + `init_parse` registration)

`parv[1]=old, parv[2]=new, parv[3]=:reason`; source = renaming user (log it). Effect:
re-key X3's view of the live channel, registration riding along.

**The hard part: `struct chanNode` ends `char name[1]`** (hash.h) — tail-allocated, so no
in-place rename for a longer name. Needs a `RenameChannel(chan, newname)` primitive in
hash.c: allocate the new-size node, copy the fixed head (modes/limit/keys/timestamp/topic),
*move* (not copy) `members` / `banlist` / `exemptlist` — updating each `modeNode->channel`
backpointer — re-point `channel_info` both ways (`cData->channel = new`), re-key the
`channels` dict, free the old node. saxdb needs nothing: the channel record is written
keyed by `channel->channel->name` (chanserv.c:9837), so the next dump persists the new key.

**Risk to burn down first: who else holds a `chanNode*`?** Known holders beyond members:
`chanData->channel`, spamserv's per-channel state, helpserv support-channel bots, snoop's
target channel, opserv alert/DNR state (names, probably not pointers), timer callback args
(chanserv topic-refresh/expiry — these take chanData, verify). Plan includes a c-auditor
sweep for `->channel` / `chanNode *` holders before writing the primitive. Any holder we
miss is a use-after-free, not a cosmetic bug.

Unregistered channels: same handler, just no chanData to ride along — this fixes the
existing silent divergence of §2.

### 3c. Nefarious side (small)

- Restore the request emit in `m_rename.c`'s registered branch, gated on a new feature
  flag (default **off**; pattern: `FEAT_REGISTER_SERVER`) so prod-test and any bed running
  old X3 keep today's honest refusal. Flip it in bed config when the X3 build deploys.
- The §2 delivery mechanism (whichever of a/b is chosen).

## 4. Tests

- Vitest (`tests/src/ircv3/`): registered-channel rename E2E — register via ChanServ,
  owner RENAME succeeds (FAIL absent, members renamed, `ChanServ INFO #new` shows the
  registration, `INFO #old` shows unregistered); below-threshold member gets the deny FAIL
  with X3's reason; rename onto a registered name denied; unregistered-channel rename with
  X3 linked → X3's state follows (op via ChanServ on the new name works).
- Stamp-poison regression: after a denied/attempted rename, the requester can still AUTH
  and gets stamped (the original bug's signature was the silent stamp discard).
- X3 has no unit harness; behavioural coverage lives in the vitest suite (per
  `feedback_no_silent_defer`: noted, not deferred silently).

## 5. Open decisions (user)

1. **Access level required to rename.** `cmd_move` — the nearest existing operation — is
   *staff-only* by default template. For a user-facing RENAME I'd propose **owner (500)**
   only, no new per-channel lvlOpt until someone asks (YAGNI; coowner 400 is the defensible
   alternative if owners-only proves annoying).
2. **RN delivery to X3**: (a) targeted legacy-services forward (recommended) vs (b) X3
   turns on the `v` flag. §2 has the trade-offs.

## 6. Rename aftermath A: redirect window on the old name (ircd side)

User addition 2026-07-30: a renamed registered channel's old name should act as a
redirect for a period, with a NOTICE.

Design (models on existing machinery — `MODE_REDIRECT` (+L) and `ERR_LINKCHANNEL` 470
already exist):

- On executing/applying a rename (both the local path and `ms_rename`), each server
  records a **tombstone** `oldname → newname, expiry` in a small in-memory table.
  TTL from a feature flag (`FEAT_RENAME_REDIRECT_TTL`, seconds; `0` disables; propose
  default 86400). Every fork server saw the RN, so the table is network-consistent
  without extra protocol.
- `JOIN #old` while tombstoned: do **not** create the channel; send a NOTICE
  ("#old was renamed to #new") + 470 and join the user to `#new` — same shape as +L
  redirect. Blocking creation is load-bearing: the first joiner would otherwise
  resurrect `#old` and shadow the redirect.
- In-memory only; a restart drops tombstones early. Accepted — TTL is a courtesy, not
  an invariant.
- **X3 synergy (optional, cheap):** on processing the approved rename, X3 places a
  timed DNR on the old name for the same window, so the old name can't be re-registered
  out from under the redirect — directly addresses the name-reuse/squatting class from
  [[x3-merge-sequencing]] §2.3.
- Open: should `RENAME` carry a client-visible opt-out (spec has none)? Propose no —
  TTL feature is server policy.

## 7. Rename aftermath B: name-keyed storage continuity (ircd side)

User addition 2026-07-30: chathistory must be thought through. Audit of what keys by
channel name on the fork:

- **Chathistory** — RocksDB keys are `"target\0timestamp\0msgid"` (history.c:26).
  A rename strands all prior rows under `#old`. Options: (i) eager migration of all
  rows — unbounded I/O, rejected; (ii) **rename-chain record** (recommended): persist a
  constant-size link `#new ← #old @ T_rename` in the targets CF; `CHATHISTORY` reads
  that walk backwards past `T_rename` continue iterating under the prior name
  (chains compose for multi-hop renames); (iii) accept the discontinuity — spec-legal
  (draft/chathistory has no rename concept) but user-hostile. The chain-follow is a
  read-time indirection, NOT per-viewer rewriting — it does not re-open the storage
  trap rejected twice before ([[shun-shadow-realm-concept]] context).

  **The chain record is bidirectional and the fence is REQUIRED (user probe
  2026-07-30: post-TTL name recreation).** Rows under `#old` are never migrated, so
  once the redirect TTL lapses and someone recreates `#old`, a naive backward walk
  from the recreated channel would serve the old community's conversation to the
  squatter. Therefore: (a) the chain is applied as a *time bound* — `#new`'s walk
  crosses into `#old` keyspace only for `t < T_rename`, so recreated-channel rows
  can never contaminate `#new`'s lineage; (b) the same record read from the source
  side is a **fence** — serving history for `#old` refuses to walk earlier than
  `T_rename`. Semantics: **history follows the community, not the name**; a
  recreated channel starts empty. Presence gating would blunt the bleed too, but
  correctness must not depend on another feature's configuration. Edge: a name can
  be a chain source repeatedly (recreate then rename again) — records per source
  form a piecewise timeline `(#old, T1)→#new, (#old, T2)→#other`; fence and forward
  walk both select by time interval. Still constant-size per rename.
- **Presence windows** (`chathistory_presence`, account-presence gating) — presence
  records are per-channel; the gate must chain-follow too, or pre-rename history is
  denied to everyone and (ii) is vacuous. Same chain record, same walk.
- **Read-markers** (m_markread.c: keyed `(session|account, target)`) — chain-follow on
  get (marker under `#old` answers for `#new`); sets always write the current name.
  Without this every client loses its read position at rename.
- **Channel metadata** — name-keyed but small and bounded: migrate rows eagerly at
  rename (no chain needed).
- **Bouncer sessions** — stored channel lists per session; a held session revived
  after a rename re-joins `#old` (§6 redirect catches it within TTL). Eagerly rewrite
  stored channel lists at rename — bounded work.
- **Reply-index keys** (history.c:446 include target) — cross-rename reply threading
  needs the same chain at lookup; edge case, note-and-defer if painful.
- **msgid derivation** (`derive_channel_msgid`, FNV-1a of name) — new msgids under the
  new name differ; harmless, no action.
- **crdt-mesh branch: explicitly OUT OF SCOPE here.** The CRDT doc keys channels by
  name with incarnation (`ctime`) semantics and HARD INVARIANTS around
  resurrection; rename-on-mesh needs its own design against the crdt-mesh skill —
  flagged for [[crdt-mesh-roadmap]], do not improvise it as part of this patch.

Sequencing note: §6/§7 are ircd-side and independent of the X3 patch (§3). The X3
patch + emit restore is shippable first — with §7(iii) discontinuity as the interim
behaviour — provided the §7 chain design is agreed as the follow-on, not silently
dropped (`feedback_no_silent_defer`).

## 8. chanNode* holder sweep — COMPLETE (c-auditor, 2026-07-30)

19 persistent holders found, all classified, none unresolved. Full report retained in
session; load-bearing results:

- `channels` dict: **key is an interior pointer into the node's `name[]`** and value is
  borrowed (hash.c:626, no free_keys/free_data) — RenameChannel must
  `dict_remove(old->name)` while old is alive, `dict_insert(new->name, new)`.
- `modeNode->channel` reachable exhaustively via moved `members` list; ban/exempt nodes
  are pure data.
- chanserv: only `chanData->channel`; **no chanserv timer captures a raw chanNode**
  (all 137 timeq calls audited — data args are chanData/userData/banData/etc.).
- **One direct timer capture**: opserv `opserv_part_channel` (opserv.c:2964, data =
  chanNode*) — `timeq_del` + re-add at rename (template at opserv.c:2986-2990).
- Module-owned holders (opserv alert discrims w/ LockChannel counts; spamserv chanInfo
  + per-user spam/flood node chains; helpserv bot helpchan/page_targets + a second
  interior-pointer dict key `helpserv_bots_bychan_dict`; snoop/track/blacklist conf
  slots): cleanest shape = a **`reg_channel_rename_func(old, new)` hook array in
  hash.c** next to the existing new/del channel hooks; each module re-points its own.
- New node must inherit `locks` (LockChannel refcounts) or holder reachability breaks.
- `bad_channel` flag is name-derived — re-evaluate `opserv_bad_channel(newname)` at
  rename rather than copying.
- Name-string-only state (DNRs, exempt/warn dicts, autojoin lists, trusted-account
  lists): no dangling pointers; semantically stale after rename — policy decision per
  list, default leave-as-is.

## 13. Multi-hop alias source rewrite — LIVE-VERIFIED 2026-07-31 (PASS)

The one path prior review couldn't close live: a bouncer ALIAS renaming a channel a hop
away from X3, confirming X3 sees the RN sourced from the PRIMARY numeric, not the alias.
Ran it on a briefly-isolated testnet+leaf+X3 tree (CRDT fleet parked ~10 min with user OK,
restored clean, soak resumed): primary ACAAD / alias ACAAE (BX C arg order = primary,alias);
X3 received exactly ONE RN `ACAAD RN #mhtest... ` — source = primary, never the alias.
PASS. Nuance found: the alias→primary rewrite actually fires at the ORIGIN server's v3
broadcast (`sendcmdto_serv_butone_v3`), so the RN is already primary-sourced before it
reaches testnet; testnet's `rename_forward_rcapable` rewrite is confirming defense-in-depth
for this path. Also (re)confirmed: RENAME is CAP-gated (client must negotiate
draft/channel-rename or gets 421); bed has BOUNCER_DEFAULT_HOLD=TRUE so a metadata wipe
reverts hold to on — cleanup must set explicit HOLD off. Invariant #10 holds end-to-end.

## 12. RN rides the `r` flag, services allowance dropped (user ask 2026-07-31, SHIPPED)

Once X3 advertises `r` (§10), special-casing it as a *service* for RN routing is
redundant. Fork now recognizes/propagates `r` and keys the RN path on the flag, not
`IsService` (commit 9d9efdb): FLAG_RENAME_CAPABLE + parse `r` in set_server_flags +
propagate at the 3 describe-another SERVER emit sites (own line stays `v`-only, no `r` —
fork servers ride the v3 path; only X3 advertises `r`); `rename_legacy_blocker` blocks
`IsServer && !IsIRCv3Aware && !IsRenameCapable` (was `&& !IsService`); the forward
(`rename_forward_rcapable`, was `_legacy_services`) targets `!IsIRCv3Aware &&
IsRenameCapable` downlinks (was `IsService`), alias→primary rewrite intact.
`find_services_server` keeps `IsService` (that finds X3 to send the AC *query* — unrelated
to RN routing). Bouncer-analyst review MERGE-READY (all 5 emit sites correct, invariant
#10 intact, RN reaches X3 exactly once). Live-gated: X3's `+s6or` seen on the wire and
propagated; rename + oplevel gates + vitest 7/7 all green on the r-flag binary (X3 gets RN
via the r-forward, re-keys its registration). Upstream (#94) already worked this way;
fork and upstream RN routing now consistent. NOTE: fork servers are NOT r-capable (they use
v); the two-emission structure (v3 broadcast + r-forward) remains — full single-broadcast
unification would need fork servers to advertise `r`, deferred as unnecessary.

## 11. Oplevel founder gate (user ask 2026-07-31, SHIPPED + live-gated)

When a channel has oplevels active (apass / +A), ownership is founder-based, so a plain
chanop opped by the founder must not rename the channel out from under them — only the
founder may. Added `rename_oplevel_ok(chptr, member)` in m_rename.c (both fork and
upstream trees), gating BOTH the request-time check (after the IsChanOp gate, before the
registered/unregistered split — so it covers every local rename) AND the
services-completion re-validation. No effect on channels without apass (any chanop may
rename, as before) or on X3-registered channels that don't use apass (X3's UL_OWNER stays
sole authority). **GOTCHA that bit us — see memory [[project_apass_present_mode_bit]]:**
first shipped testing `chptr->mode.mode & MODE_APASS`, which is a no-op (the bit isn't
persistently set); a live founder-vs-plain-op probe caught the bypass; correct test is the
string `chptr->mode.apass[0]`, founder = `OpLevel==0 || IsChannelManager`. Live-gated:
founder renames a +A channel OK, non-founder op refused with "Only the channel founder may
rename this channel", F2 rename path unregressed. Commits fork 02b1be5, upstream ea1336a.

## 10. Un-drafting #57 — the X3-side gate (found 2026-07-31 during backport review)

On **upstream** nefarious2, RN is broadcast only to servers advertising the new `r`
(rename-capable) SERVER flag (the fork uses `v`; upstream has no `v`). X3 introduces
`+s6o` — no `r` — so on an upstream network it would *authorize* renames (AC query
arrives fine) but **never receive the RN to apply them** → X3 state diverges. Fix,
required before #57 leaves draft: **X3 advertises `r` in `irc_server()`
(proto-p10.c:534/537 — add the flag letter to the `+s6o` string).** X3 already has
the RN handler. Also fold in F2 (the AC-cookie-vs-numeric aliasing — a `RENAME`
discriminator on the reply, mirroring the request-side keyword). See
[[nefarious-upstream-rename-backport]] §4a for both. On the FORK, X3 gets RN via the
targeted legacy-services forward regardless of `r`, so this is upstream-specific —
but advertising `r` is harmless on the fork and makes the forward redundant there
too, so do it unconditionally.

## 9. Queued (user, 2026-07-30 — not now, not silently dropped)

Before/alongside proposing the new X3 PR for this patch: **review the existing
un-merged X3 PR — evilnet/x3 #56** ("proto-p10: BX P merge case + silent variant for
probe lookups", MrLenin, updated 2026-06-06, branch `fix/bx-p-merge-and-silent-probes`).
It contains the bouncer-session convert-in-place (BX P) handling; sanity-check it
against the bouncer-architecture invariants and
[[legacy-bx-p-in-place-conversion]] before stacking a second services PR on top.

**Watch-item (user recollection, no surviving logs/chat):** at least one past instance
of X3 doing an N-numeric lookup on a *timestamp*. Unverifiable now; pattern-matches an
argument field-shift in N/AC parsing (same class as the crdt C29 legacy-cloak
field-shift: empty/shifted params make the parser consume later fields as values —
`GetUserN(<ts>)` is exactly what a shifted N line would produce). Standing response:
(a) the new AC rename branch validates argv shape strictly and never feeds unvalidated
fields to `GetUserN` (the cookie needs no user lookup at all); (b) if it recurs, grep
X3 `everything.log` for PARSE ERROR N-lines and AC lines with digit-string first args.

**Ride-along finding 2026-07-30 — FIXED ircd-side:** the fork's webpush burst (`WP B`)
was hitting X3 as PARSE ERROR spam (snoop-echoed into #TheOps). User ruling: **ircd
bug, not an X3 masking job** — `webpush_burst()` fired at link gated only on the
feature. Fixed by gating on `IsIRCv3Aware(cptr)` (s_serv.c:217, same pattern as the
ML burst fix eight lines below it). No X3 `cmd_dummy` for WP — receiver-side masking
would hide the next emitter bug of this class.
**Queued audit:** sweep for other v3-only tokens emitted through non-v3-filtered
helpers (`sendcmdto_one` at link/burst time is the suspect shape — WP B and ML were
both this bug).

## Cross-refs

[[x3-merge-sequencing]] (long-term daemon-homed authority; this patch is the bridge),
[[x3-merge-authority-model]], [[project_legacy_bx_p_handler]] (the legacy-forward
precedent), memory `project_x3_nefarious_merge`.
