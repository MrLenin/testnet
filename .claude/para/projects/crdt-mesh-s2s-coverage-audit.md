# CRDT-mesh S2S wireline coverage audit (2026-07-23)

Independent ground-truth sweep of all server-facing tokens in the production fork's `parse.c msgtab[]`
(`nefarious` @ `ircv3.2-hardening`/`f557483`) vs their disposition on the CRDT branch
(`nefarious-crdt` @ `crdt-mesh`/`0d9fe5c`). Method: 4 parallel read-only agents partitioned by family,
each classifying every token DOC / CR-M / GW-only / TREE / N-A, grounded at file:line, cross-referenced
against the roadmap's known-OPEN list to separate GENUINE-MISS from KNOWN-DEFERRED. ~104 tokens/subtokens
audited (fam1 22, fam2 23, fam3 21, fam4 38). Per-family tables: scratchpad `s2s-audit-fam{1,2,3,4}.md`.

## Bottom line
State convergence is comprehensive; **targeted S2S DELIVERY is the systematic gap.** The mesh wired the
`crdt_route_unicast_try` / CR-M fallback for exactly SIX commands (PRIVMSG/NOTICE/TAGMSG/WALLOPS/KILL/INVITE);
~15 sibling targeted-delivery commands still emit only over the (MR-5-retired-among-CRDT-peers) P10 tree and
**dead-sink to a recipient homed on a mesh-only/stub-fronted leaf.** Plus a few STATE-representation gaps
(extended channel modes, bouncer alias soft-state) and one security-relevant broadcast gap (SASL CI).
Every gap bites only when the target is on a mesh-only leaf → a PARTITION scenario today (bounded, self-heals),
but UNIVERSAL after MR-6 (drop P10 links). **These are the gating work for MR-6; none is a live prod
emergency (cutover flags default off, tree still present).**

**LIVE-CONFIRMED 2026-07-25 (P2 channel-tier gating, broader than the "mesh-only leaf" framing above):**
the SOURCE side bites too, in tree-retirement STEADY STATE — a USER-sourced tree-relayed token (observed:
channel `MD`) from a server beyond the receiving node's truncated tree horizon is fake-direction-dropped
(the user's `cli_from` resolves to a mesh anchor; nef4 max-debug: `Fake direction: (AGAAB MD #chan …)`).
The 2026-07-24 beyond-horizon parse exemption covers SERVER-sourced only (`IsMeshStub(from)` — a user is
not a stub). Net effect: unregistered-channel metadata (spec §C3: memory+S2S only, no doc) converges only
within the source's tree horizon; +R/account metadata are immune (doc-converged). Fix = the same MR-6
CR-M-fallback family, or extending the exemption to user sources whose `cli_from` is an anchor —
design-pass it at MR-6, don't patch ad hoc.

## GENUINE-MISS gaps (NOT on the roadmap) — the high-value output

### Cluster A — targeted delivery has no CR-M fallback (one root cause, ~15 tokens, all MAJOR)
**SLICE 1 SHIPPED + LIVE-GATED GREEN 2026-07-28 (`dc86c3f` + `f757e0b` XQ gate-fix):**
whisper CR-M verified both directions (nef3<->nef7 mesh-only); XQUERY nef3->overlay-only nef7
tunneled end-to-end (REV-try cmd=Q -> CR-X emitted -> re-injected -> "Received extension query").
XQ gate-fix `f757e0b`: services_try's is_mesh_only EXCLUDES presented stubs (which still
dead-sink) — switched the two XQ forward sites to reply_try (IsMeshStub gate). **WHILE HERE,
FOUND + FIXED A SHIPPED REGRESSION (`b11de58`):** the gap-B CI fix (`2b1283d`) added an
unguarded `else if (m_cmd[0]=='I')` CI branch BEFORE the unicast INVITE handler — both ride
cmd 'I', so CI swallowed EVERY mesh INVITE into sasl_cache_invalidate_user(channelname)
(no security impact — accounts never start with '#' — but INVITE-over-mesh to a mesh-only
target was DEAD since 2b1283d). Proven live, fixed with a `&& target[0]=='*'` guard (CI always
"*", INVITE always a user numeric); re-gated INVITE delivers + no spurious CI. Original
slice-1 note follows:
**(prior)** CP/CN whisper now routes via crdt_route_unicast_try (real
minted msgid — the "*" placeholder is single-use per dedup window, never reuse it); XQ/XR
forward sites wired to the dormant CR-X 'Q'/'Y' cases (all three: mo_/ms_xquery, ms_xreply;
XREPLY builds user vs server numerics itself).

**WALL* carrier — SCOPED 2026-07-28, forward-compat guard LANDED (`bac5770`):**
The channel-delivery cmdstr map DEFAULTS any unknown cmd letter to PRIVMSG, so a future
targeted-WALL frame reaching a peer without its receiver logic would deliver to ALL members
as a PRIVMSG (privilege leak — same shared-letter hazard as the CI/INVITE 'I' collision).
Guard landed: the channel branch now requires a known cmd (P/N/T); unknown channel-target
cmds drop locally and relay-only.  This MUST precede any WALL* emit by a bed generation.
Two sub-families to build:
1. **Channel-targeted WC/WV/WH** — deliver to a member-privilege subset (WALLCHOPS→SKIP_NONOPS;
   WALLHOPS→SKIP_NONHOPS = chanops+halfops; WALLVOICES→SKIP_NONVOICES = chanops+halfops+voiced,
   send.c:2418-2420).  NEW channel-family CR-M cmd letters (e.g. c/h/v — distinct from P/N/T/K/I/W
   and in-branch distinguishable per the 'I' lesson); receiver applies the IsChanOp/IsHalfOp/
   HasVoice filter in the channel loop + emits the right client command (WALLCHOPS/VOICES/HOPS)
   with its "%H :@ %s" format; extend the guard's known-cmd set.  Emit sites: the SKIP_NON*
   sendcmdto_channel_butone calls in m_wallchops/voices/hops.
2. **WALLUSERS (WU)** — network-wide +w-USER broadcast (not channel) via sendwallto_group_butone
   WALL_WALLUSERS; MR-2b crdt_route there is WALL_WALLOPS-only.  The receiver 'W' branch hardcodes
   sendwallto_local(WALL_WALLOPS), so WU needs a separate letter (e.g. 'U') → WALL_WALLUSERS
   local delivery.  Broadcast, no member-leak; an old peer mis-maps 'U'→PRIVMSG-to-'*' = benign drop.
**MIXED-VERSION:** gate the emit behind FEAT_CRDT_ROUTE_WALL (default off), flip only after a full
bed roll (receivers must be everywhere first — the emit skips CRDT-aware peers on P10).

**SHIPPED 2026-07-28 (`14a1d99`, flag-gated OFF — inert until flip):**
- **WALLUSERS ('U') COMPLETE** — receiver (sendwallto_local WALL_WALLUSERS, target "*") + emit
  (send.c computes crdt_letter W/U by type+flag, skips CRDT-aware peers on P10 like WALLOPS).
- **WC/WV/WH ('c'/'h'/'v') RECEIVERS in place** — dedicated CR-M channel branch, member filter
  (c=chanops / h=+halfops / v=+voiced), "@ "/"% "/"+ " prefix in the frame text.
- **DEFERRED — WC/WV/WH EMIT:** a channel broadcast can't use the flat all-server flood WALLUSERS
  uses; needs R6a-style tree-demote-among-CRDT + msgid dedup (else CRDT peers double-deliver via
  P10 AND CR-M). Receivers ready.
- **WC/WV/WH EMIT SHIPPED `9087e75`** — `crdt_wall_demote()` (R6a scan + tree-relay suppression to
  CRDT peers) + `crdt_wall_flood()` (CR-M c/h/v), called under the SAME predicate at all 6 sites so
  demote/flood can't disagree.  No cross-plane msgid dedup needed: walls carry no wire msgid and the
  demote guarantees the tree copy never reaches a CRDT peer.  Body = final client text INCLUDING the
  "@ "/"% "/"+ " prefix.
- **WALLUSERS LIVE GATE GREEN 2026-07-28:** all 5 nodes rolled to the receiver, flag enabled on the
  EMITTER only (nef3), `+w` user on overlay-only nef7 received `$ wallgate-probe` and the wire shows
  `CRDT M <msgid> U ADAAF * 32` — the CR-M 'U' frame, not a tree copy.
  **FLAG-FLIP MECHANICS (bed):** `/SET` needs `PRIV_SET` which the testbed Operator block does NOT
  grant → set it in the config Features block instead.  `data/ircd*.conf` is owned by UID 1234 and
  NOT writable by the host user: edit from INSIDE the container (nef3's config is rw-mounted) using
  temp-file + `cat >` truncation — never `sed -i`/`mv`, which rename and break the per-file bind
  mount — then `docker kill --signal=HUP`.  The edit reaches the host file through the bind mount.
- **WC/WV/WH LIVE GATE GREEN 2026-07-28 — all four assertions:** op on overlay-only nef7 received
  WALLCHOPS, voiced member received WALLVOICES, and the PLAIN member received NEITHER (the privilege
  filter — the leak the forward-compat guard `bac5770` exists to prevent).  Wire:
  `CRDT M <msgid> c ADAAA #wcgate 32 :@ wc-chops-probe` — 'c' letter, channel target, prefixed body.
  **⇒ WALL* 100% COMPLETE + GATED (WALLUSERS + WC/WV/WH, emit + receivers).**

**SVS + BX SHIPPED 2026-07-28 (`6cdddee`) — LIVE GATE PENDING.** SVS J/P/M/D/N: each relay branch
tunnels to the target's HOME over CR-X before the unchanged tree broadcast; re-emit + re-inject cases
dispatch into ms_svs*.  **MINT AT MESH ENTRY ONLY** (`!IsServer(cptr) || !IsCrdtAware(cptr)`) — the SVS
relay is a tree BROADCAST, so per-hop re-mint would tunnel N copies (each mint = own msgid, CR-X dedup
can't collapse).  SVSNICK applies per-hop (no early return) so its tunnel is additionally `!MyUser`-gated
— only the authoritative home mints the doc nick op.  BX 'B': bounce_alias_echo's 2 remote BX E sends +
forward_bxm_line tunnel to a mesh-only alias/primary home, re-injected into ms_bouncer_transfer; BX M
rebuilds the line with the forward_fed_reply join pattern (round-trips all 3 param shapes).  All
self-gate (reply_try=0 → original P10 send).  **GATE GREEN 2026-07-28 (SVS half):** OpServ (`/msg O3 SVSJOIN`, after AuthServ auth — SVSJOIN is
services-only, `m_ignore` in the OPER msgtab slot, so an oper CANNOT originate it; drive gates through
X3) toward a target homed on overlay-only nef7 → nef3 `REV-try cmd=J` → `CR-X emitted dst=AI` → nef7
`CR-X recv cmd=J` + `re-injected locally` → **target joined**.  This also exercises the §17.7
gateway-edge mint (the SVSJOIN arrives from the non-CRDT x3 link).  BX half still ungated (needs an
alias homed on nef7 receiving a PM echo).  Bed nick: OpServ is **`O3`** here, not "OpServ".

**⇒ CLUSTER A CODE-COMPLETE + GATED** (CP/CN ✅, XQ/XR ✅, WALL* ✅ both halves, SVS ✅, BX shipped).
**ONLY REMAINING: the BX live gate — BLOCKED on a PRE-EXISTING bed defect**, not on the BX carrier:
cross-server alias attach doesn't land (a SASL'd client on a leaf gets a normal welcome instead of
routing through `bounce_setup_local_alias`, so `hs_aliases[]` stays empty).  Two tests are already
skipped for it (`bouncer-cross-server-promote`, `bouncer-alias-multi-server`).  The BX 'B' carrier
cannot be exercised until that lands.
Live gate for slice 1: whisper nef3→mesh-only user + XQUERY toward an anchored service
leaf, both directions.
Same shape as the KILL/INVITE dead-sink that MR-4 fixed with CR-M, but never extended to these siblings.
Fix pattern is uniform: route the cross-server leg through `crdt_route_unicast_try` (unicast) / a CR carrier.
- **CPRIVMSG (CP) + CNOTICE (CN)** — the `whisper()` path does a direct `sendcmdto_one` (s_user.c:1553/1558)
  bypassing the mesh router → whisper to a mesh-only target silently dropped (an ordinary PM to the same
  user IS carried). **Most severe (directed-message loss).**
- **WALLCHOPS (WC) / WALLVOICES (WV) / WALLHOPS (WH) / WALLUSERS (WU)** — targeted wallops via
  `sendcmdto_channel_butone` / CR-M gated to `WALL_WALLOPS` only (send.c:3130) → chanops/voiced/etc. on a
  mesh-only peer never receive them.
- **SVSJOIN / SVSPART / SVSMODE / SVSQUIT (+ weakly SVSNICK)** — services force-commands, no unicast fallback
  → aimed at a user homed on a CRDT-only leaf, forward over a tree that no longer exists → effect lost.
  (Effects that DO reach an applying node converge fine via the core doc; SVSQUIT partly saved by KILL-CR-M,
  SVSNICK by flood+gateway.)
- **BX E (alias echo) + BX M (multiline echo)** — ephemeral cross-peer alias echo via raw
  `sendcmdto_one(CMD_BOUNCER_TRANSFER)` / `forward_bxm_line` (bouncer_session.c:9590), tree-only → lost to an
  alias homed on an overlay-only peer.
- **XQUERY (XQ) + XREPLY (XR)** — services RPC, tree-only; the CR-X bridge has DORMANT 'Q'/'Y' dispatch cases
  (m_crdt.c:552/582) but no forward caller → dead-sink to a mesh-only target. (Latent — wiring half-exists.)

### Cluster B — SASL cache invalidation (SECURITY, MAJOR) — ✅ FIXED 2026-07-26 (`2b1283d`)
- **CI (CACHEINVAL)** — was P10-tree-only; an overlay-only leaf kept a **stale positive auth cache →
  revoked/changed credentials accepted up to `FEAT_SASL_POSCACHE_TTL`=300s.**
- **FIX SHIPPED:** dual-plane `ci_broadcast()` (sasl_webhook.c) replaces all 5 raw CI emit sites — v3
  tree copy (legacy) + one mesh **CR M cmd `I`** broadcast (msgid-deduped flood). mesh-mint at the
  origin webhook sites + at the ms_cacheinval relay ONLY when the CI arrived from a non-CRDT peer
  (`!IsCrdtAware(cptr)` = §17.7 gateway edge; no per-hop re-mint). Receiver (m_crdt.c CR M `I`) does
  LOCAL invalidate only (MR-2b `W` precedent — no legacy re-emit → no dual-plane echo loop). Additive
  (crdt_gossip_message self-gates → mesh-off = old behavior). Live-gated: POST credential event to
  hub nef3 → mesh CI reached overlay-only **nef7** in ~1s, each peer exactly once, origin local once,
  no storm/echo, converged. The lowest-hanging MR-6 gate; first S2S-audit cluster closed.

### Cluster C — state not represented in the doc (structural, needs a schema add)
- **Extended channel modes — MAJOR — ✅ FIXED 2026-07-28 (`573c6e1`, live-gated).** ShadowModeSnap now
  carries xmode (CRDT_EXMODE_MASK = all persistent exmode bits) + upass/apass/redir. **LESSON: +A/+U/+L are
  STRING-ONLY modes** — channel.c sets chptr->mode.{apass,upass,redir} directly and the renderer gates on
  *string; the MODE_APASS/UPASS/REDIRECT bits are modebuf-transport flags, NEVER set in mode.mode. First cut
  gated capture on the bit → always false → nothing carried (caught by DBG trace: build=none, apply=redir'').
  Fixed to gate on string presence; apply copies strings directly (no bit) so a materialized channel is
  byte-identical to native. Append-only fields, length-tolerant parse (mode_snap_parse) = version-safe both
  ways. GATE: overlay-only nef7 materialized `+PlL 50 #redir` identical to nef3 (exmode +P + redirect string).
  +A/+U covered by the same string path (+L is the live proof; founder-pass setup n/a on bed). DEFERRED:
  gateway_birth_modes rendering exmode/+A/+U to legacy at CRDT-birth (legacy-presentation edge, not data-loss).
- **Bouncer alias soft-state — MAJOR/MINOR.** Aliases are excluded from the users doc, and **BX N (alias
  nick), BX K (snomask), BX V (visibility)** got neither a doc field nor a CR carrier → cross-peer alias
  drift. Root cause: 5-5e models durable session/connection STATE (bsessions/bconns + lease) but not the
  alias soft-state/echo subcommands. Fix: add alias fields to `bconns` (or a companion) + a CR carrier.

## Roadmap-accuracy corrections (claims the audit contradicts)
- **REDACT** — roadmap says "live redaction is broadcast-covered"; actual live path is
  `sendcmdto_serv_butone_v3(CMD_REDACT)` (send tree-only, no CR-M) → holds only while P10 links persist;
  belongs with Cluster A / 5-5f, not "covered."
- **WALLOPS** — MR-2b "WALLOPS DONE" is USER-sourced only; **server-sourced WALLOPS stays P10** (send.c:3131).

## KNOWN-DEFERRED (roadmap already tracks — confirmed, not re-litigating)
RENAME (F4, channel split-brain, MAJOR/CRITICAL); TEMPSHUN + SVSNOOP (F3, MINOR — largely ephemeral/rare);
SMO/SNO/DESYNCH/WEBPUSH (F5 ephemeral notices); CHATHISTORY + REDACT-for-CH (5-5f); remote-targeted queries
STATS/TRACE/LINKS/MAP/ADMIN/INFO/VERSION/LUSERS/MOTD/RULES/TIME/remote-WHOIS (~12, `hunt_server_cmd`
tree-only → the `/CRDT map|peers|status` introspection is the by-design substitute, full bite at MR-6);
ACCOUNT live login/logout (Tier B; snapshot-time doc field only); ephemeral/TTL metadata + MDQ (burst gap);
SETTIME (scoped out, layering — HLC+NTP handle skew); QUIT reason (cosmetic); SETHOST in-place drift (cosmetic).

## Verified CLEAN (mesh-native, no gap — the reassuring negative space)
- Core presence/channel STATE: NICK/QUIT/KILL/JOIN/CREATE/PART/KICK/TOPIC/classic-MODE all DOC + live-deliver;
  KILL/INVITE mesh-native CR-M; CR F replaces BURST for a fresh peer (modulo the extended-modes gap).
- All four global bans GLINE/SHUN/ZLINE/JUPE = DOC (engine LWW + cutover + gateway); this session's fixes
  (gline &me-reconcile guard, M13 expiry tombstones incl jupe 3-site, M12 same-second lastmod) re-verified.
- Full Tier-C user-attribute set AWAY/SETNAME/SWHOIS/SVSIDENT/SVSINFO/MARK/SILENCE = DOC.
- METADATA-2 (permanent) + read-marker (MR) = DOC; multiline content reaches mesh-only targets (un-batched).
- Bouncer durable state BS C/A/D/X/U/O/T + BX C/X/U/P = DOC (bsessions/bconns + M6c-1 synth + M6d lease);
  SASL + AUTHENTICATE mesh-native via the CR-X services bridge (FEAT_CRDT_SERVICES_BRIDGE).

## Recommended fix order (if/when this becomes work — all gate MR-6, none urgent)
1. **Cluster B (CI)** first — it's the only SECURITY gap (revoked creds accepted 300s on overlay leaves).
2. **Cluster A** as one uniform sweep — extend `crdt_route_unicast_try`/CR-M to CP/CN, the targeted WALL*,
   the SVS force-commands, BX E/M, and wire the dormant XQ/XR CR-X cases. Single pattern, ~15 call sites.
3. **Cluster C** — the two doc-schema adds (extended channel modes; bouncer alias soft-state). +A/+U first
   (security/founder-protection).
4. Fold the REDACT + server-WALLOPS corrections into the roadmap; reclassify REDACT out of "covered."

## 2026-07-27 — IsServer-exact SOURCE-gate sweep (anchor/stub sources, invariant-2 handler-side)

Full msgtab server-slot sweep (97 handlers + reachable helpers) for `IsServer(sptr)` gates that
silently mis-handle a mesh-anchor source (the class the account-prop fix `75783ce`/`bf7f358` swept
for services handlers; re-triggered by the ms_chathistory find). **FIXED this pass (Phase 0 cycle):**
- `m_chathistory.c` entry gate (silent drop of every legacy-originated federated query on inner mesh
  nodes — the mixed-bed wedge) + reply dead-sink + missing multi-hop reply forwarding (both branches).
- `m_silence.c:337` **CRASH** — stub-sourced SILENCE U fell past the server branch into
  `apply_silence(sptr)` → `cli_user(stub)->silence` NULL deref; X3 emits SILENCE from its server
  numeric, so remote-triggerable on any tree-retired leaf. Gate now `IsServer || IsMeshStub`.
- `m_fake.c:115` — stub-sourced FAKE rejected with protocol_violation; fakehost has NO doc backstop
  (shadow carries realname/swhois/sethost, not fakehost) → silently lost on the leaf. Gate relaxed.

**DEFERRED (low, noted per feedback_no_silent_defer):**
- `m_gline.c:140` / `m_shun.c:140` / `m_zline.c:140` — `if (IsServer(sptr)) flags |= *_FORCE`: a
  stub source loses only the expire-bounds bypass; bans still apply and converge via the doc track.
  Fix opportunistically when next in those files.
- `m_batch.c:527` REVIEW — S2S BATCH with anchor source unclear/likely unreachable; revisit at MR-6.
- BS/BX residual: no IsServer DROP gates, but the nine `bounce_alias_*` sub-handlers were not
  individually traced for unguarded `cli_user(sptr)` on a stub source. Follow-up trace if
  BX-with-stub-source becomes a supported path (M6c gateway synth suggests doc-convergence makes it
  unlikely today).
- `m_topic.c:153` theoretical: raw legacy-SERVER TOPIC with no setter + FEAT_HOST_IN_TOPIC derefs
  `cli_user(from)` — X3 always topics from a service-bot user with setter; unreachable via services.

## 2026-07-27 — latent header nit (found during 5-5f B3)
`include/handlers.h:308` declares `forward_history_write`'s 5th parameter as `int`; the
definition (`m_chathistory.c`) uses `enum HistoryMessageType`. ABI-identical (small enum
promotes to int) so it is NOT a bug, but it means m_chathistory.c cannot include handlers.h
without a conflicting-types error — that file therefore declares what it needs locally.
Fix opportunistically (type the prototype as the enum + include history.h in handlers.h, or
retype the definition to int); do not sweep mid-feature.

## 2026-09-20 — DELTA re-audit @ crdt-mesh `4981680` (two c-auditor passes, verified by hand)

Scope: (a) every P10 transmission with no mesh carrier (msgtab 142 rows / 98 server handlers /
1088 emit sites; letter completeness both directions clean; invariant-3 raw-primitive writes: zero);
(b) every convergence that waits for the 30 s tick / beacon instead of the event that changed it
(41 verify_cb call sites + 13 nested sweeps = 54 converge points, each cross-checked for an eager twin).
Verified at the cited lines; F3 verified LIVE (SNO from hub2 lands twice on leaf2, once on the primary).

### Defects (not plain misses)
- **F1 — `TOK_CRDTMESH "CM"` collides with `TOK_CLEARMODE "CM"`** (include/msg.h:340 vs :604, the only
  duplicate token). add_msg_element is last-writer-wins and CRDTMESH registers after CLEARMODE (parse.c:590
  vs :1126), its SERVER slot is m_ignore → **every inbound S2S CLEARMODE is silently dropped on every
  crdt-mesh node.** Local CLEARMODE (long name) works and its doc mint converges CRDT→CRDT; legacy→CRDT
  (X3/OpServ CLEARMODE on the primary) never applies and the stale snapshot can be re-asserted back to
  legacy via §17.7. The overlay handshake uses the long name (m_server.c:827) so the token buys nothing.
- **F3 — SNO/SMO double-deliver to CRDT peers that still hold a P10 link.** sendto_opmask_butone_global
  (send.c:3481-3490) sends the tree copy to every downlink with no IsCrdtAware skip (sendwallto_group_butone
  has one at :3398) and then gossips 'O' (:3509); same in ms_sno (m_sno.c:57+65) and ms_smo (m_smo.c:57+64).
  Tree copy has no msgid → undedupable. LIVE: hub2 origin → leaf2 count=2, primary count=1. Today's
  `sno_gate.py` watched only the overlay-only node (cannot duplicate) and printed only the first match —
  TRAP: broadcast gates must watch a P10-linked CRDT peer and COUNT matches (script now prints count=).
- **F2 — DESYNCH double-mints at the gateway edge.** sendwallto_group_butone sets letter 'D' for every
  WALL_DESYNCH and gossips at :3408 whoever called it; ms_desynch then gossips a second 'D' with a fresh
  msgid (m_desynch.c:117-121) for a legacy-arrived DESYNCH. +g opers on every mesh node see it twice.

### Genuine misses, ranked (bed: hub2=nefarious3 gateway with P10 to the primary; leaf5=nefarious7 overlay-only)
- **M1 PN has no gateway-edge mint** (m_markread.c:486 ms_presencesync tree-relays only; origin mint is at
  chathistory_presence.c:737). A legacy-origin presence close never reaches leaf5 → strict-presence pages
  from leaf5's store silently drop those rows. Catch-up item 3 shipped the origin half only. Siblings that
  DO mint at the edge: TK (m_token.c:235/245), SNO/SMO, CI, MR (m_markread.c:533).
- **M2 REDACT has no mesh carrier** (m_redact.c:362/473, m_chathistory.c:5552; zero crdt refs). leaf5 keeps
  and re-serves redacted rows, incl. through federated pages. Roadmap correction from 07-23 still open.
- **M3 WEBPUSH removals bypass the doc and get resurrected** (m_webpush.c:545 403-reap, :1271
  forget-account, :1941 stale sweep — no crdt_shadow_webpush_remove; the client-driven paths :368/:483/:2348
  do). reconcile_webpush re-adds every live doc entry → PERSISTENCE DESTROY subscriptions come back at
  the next tick; a 403'd endpoint is pushed to forever. Hard-invariant-5 violation.
- **M3b WEBPUSH `WP K`/`WP V` key ring tree-only** (m_webpush.c:1592/1659/2299; no doc collection). Key
  rotation never reaches leaf5 → stale vapid key, pushes from leaf5 fail.
- **M4 FAKE never reaches the doc** (m_fake.c:134-136: hide_hostmask then CMD_FAKE, no crdt_shadow_user_add;
  every sibling handler mints). leaf5 materializes the wrong host and a full reconcile can overwrite the
  live value. SETHOST (m_sethost.c:135/212/305, crdt_gate=0) is the same fix.
- **M5 SASL `*` broadcast tree-only** (m_sasl.c:137/140 relay, :340 abort) — only the unicast agent leg is
  bridged (CR X 'A'). Mechanism list `SASL * * M :…` never reaches leaf5 → wrong `sasl=` CAP value.
- **M6 masked PRIVMSG/NOTICE (`$*.dom`, `$#host`) dead-sink on mesh-only users** (ircd_relay.c:2055/2097/
  2120/2143; sendcmdto_match_butone skips cli_fd(cli_from)<0 at send.c:3449). Network announcements skip leaf5.
- **M7 MARK subtypes WEBIRC/SSLCLIEXP/KILL/WEBSOCKET/DNSBL tags** (m_mark.c:128/165/173/186/195; burst
  re-emits s_user.c:1002-1042) — no CrdtUserRecord field. Unresolved: whether add_mark tags feed enforcement.
- **M8 PRIVS tree-only** (client.c:378/388, m_privs.c:157; handler ready since 55df651, carrier missing).
  HasPriv() false on leaf5 for remote opers → oper actions and alias priv sync fail closed.
- **M9 ML capability announce tree-only** (m_batch.c:2792). leaf5 never learns peers' multiline limits →
  permanent un-batched degradation (graceful).
- **M10 server-sourced WALLOPS** (send.c:3329 gate cli_user(from); m_server.c:199/238, m_wallops.c:107).
- **M11 bouncer alias soft-state** (Cluster C, still open): BX U identity fields (bouncer_session.c:7543),
  BX N (:9431), BX K (:7900/9049/10586/10604), BX V (:923/10654/10665) — no bconn field.
- **M12 GITSYNC tree-only, never audited** (m_gitsync.c:411/413/706/708). `GITSYNC * force` never reaches
  leaf5 → silent config divergence on an overlay-only node.
- DESYNCH settime path (m_settime.c:166/244) raw tree emit — minor, SETTIME scoped out.

### Should-be-eager (an explicit event exists but the 30 s tick / 90 s beacon is the trigger)
- **SE-3 ms_squit drops a SQUIT naming a mesh anchor** (m_squit.c:99-103, crash-safety motivated). x3 gone
  → leaf5 routes SASL at the anchor for 90-120 s → login timeouts instead of immediate failure. Safe
  teardown exists (crdt_shadow_retire_mesh_stub); unresolved: callable from inside parse()?
- **SE-2 convert_to_stub stamps recv_ts=now** (crdt_shadow.c:2312) though its own comment says only
  seen_since_tick/miss_ticks need seeding. A just-died direct peer is beacon-fresh for 90 s → store stays
  "reachable" (no partial tag, queries tunnelled to a corpse), held sessions unrevivable (blease
  holder_fresh), orphan grace restarts. One assignment.
- **SE-1 CR F apply runs no reconcile suite** unless IsBurstOrBurstAck (m_crdt.c:923); the delta path
  (:859-892) runs all twenty. Fix-A repaired state stays doc-only ≤30 s; retention isupport not re-derived.
  Unresolved: is the omission deliberate for the mid-legacy-burst case (crdt_present_stub refuses nested
  reconcile at :2278)? The non-bursting branch is safe.
- **SE-7 M6d stand-down tick-paced** (bouncer_session.c:2469-2508; deferred note at :1519): ≤30 s dual
  primary after heal; the lease-claim delta already runs reconcile_bouncer (m_crdt.c:891) but not the sweep.
- **SE-4 doc-learned store not synthesized to legacy until the tick**: m_crdt.c:880 re-derives retention
  on the CH_STORAGE delta but does not call crdt_shadow_ch_storage_synth_to(NULL) (:6320). The literal
  missing sibling of 6204d08.
- **SE-6 dead primary's bconn lingers 30 s** (crdt_shadow_bconn_reap tick-only; alias tombstone is eager
  at bouncer_session.c:9263). Source of the benign per-tick M4 roster-mismatch NOTICE.
- **SE-5 own mesh-map row only refreshes on the beacon tick** (crdt_shadow_local_peers called only from
  crdt_gossip_beacon_to); link-down calls nothing → stability window arms late. Routing suboptimality only.
- **SE-8 DIE/RESTART emit no farewell** (zero crdt refs in m_die.c/m_restart.c) — the multiplier behind
  SE-2/SE-3; a final withdraw beacon would collapse all three windows.
- **SE-9 ch_synth_last never cleared, no withdrawal synth** (crdt_shadow.c:1328-1363; foreach skips
  tombstones). A store that leaves and returns with the same retention is never re-advertised to a
  legacy peer that cleared its ad (stub SQUIT) in between. Permanent, not 30 s.
- Ruled out (eager already, tick = backstop): all doc→live reconcilers on delta, all doc mint families,
  retention re-derive, own store publish, legacy store publish+withdraw, absence close on beacon arrival,
  bouncer session mints, beacon handoff at link (both transports), stub retire on relink. By design:
  GC, CR S anti-entropy, beacon emit, stub retirement on staleness, log-only oracles.

### Execution (2026-09-20 evening, crdt-mesh `e0eacc0` + `deeac37`, pushed, fleet on it)
- `e0eacc0` **F1 FIXED**: TOK_CRDTMESH → "MH". Gate `clearmode_gate.py 6667 6674 6669 6674`: before, oper
  CLEARMODE on the primary left `+m` + 1 ban on hub2 and leaf5; after, `+` and 0 bans on both.
  **F3 FIXED**: IsCrdtAware skip in sendto_opmask_butone_global + ms_sno/ms_smo relay to legacy links only
  when minted. Gate `sno_gate.py` (now prints count=): hub2→leaf2 count 2→1; hub2→primary/leaf5 1;
  leaf5→hub2/primary 1. **F2 FIXED**: ms_desynch second mint removed (code-read only — no cheap DESYNCH
  trigger on the bed; the wall path's single mint is the same one WALLOPS relies on).
- `deeac37` **M1 FIXED**: PN gateway-edge mint. Gate `pn_gate2.py 6667`: nefarious7 mesh-PN 0→1 (nef4/5
  get tree+mesh, idempotent close). **SE-4 FIXED**: synth_to(NULL) on the CH_STORAGE delta. Gate
  `retention_gate.py 6674 6667 21`: primary's token 20.9 s → 1.1 s. **SE-2 FIXED**: recv_ts no longer
  stamped at stub conversion; gate = crdt-mesh-absence suite (result below).

- `06e8f7f` + `474e60a` **QUIT reason** (deferral review): first cut as an ephemeral CR M 'Q' minted before
  the tombstone — gate `quit_gate.py 6674 6669 6670 6667`: hub2 + primary OK, **leaf2 (two mesh hops) still
  "Quit"** — the letter and the delta took different paths and the delta won.  LESSON: a value that must be
  present WHEN a state change is applied has to travel ON the op, not beside it.  Final: the reason is the
  user DELETE op's value (tombstone keeps none → digest/snapshot-neutral, old peers ignore it); the engine
  parks (numeric, reason) in a ring when the winning delete applies (cmocka `test_user_remove_reason_rides_
  delete`), the doc-driven exit consumes it.  Gate: leaf5→hub2/leaf2/primary/leaf4, primary→hub2/leaf5/
  leaf2, leaf2→leaf5/primary all carry the reason; netsplit reasons ride too.  `06e8f7f` also **SVSNOOP over
  CR M 'Z'** (svsnoop_apply_local shared by ms_svsnoop + receiver; gateway-edge mint, tree relay to legacy
  only) — code-read only, no bed trigger (X3 has no SVSNOOP command).
- SE-2 gate: crdt-mesh-absence suite 2/2 on `deeac37` (partial+complete 72 s; token drop/rise).

### Proposed fix order (batches 1-3b done above; the rest pending)
1. ~~F1 token collision~~ DONE `e0eacc0`.
2. ~~F3 + F2 duplicates~~ DONE `e0eacc0`.
3. ~~M1 PN edge mint + SE-2 recv_ts + SE-4 synth-on-delta~~ DONE `deeac37`; ~~QUIT reason + SVSNOOP~~ DONE `474e60a`.
4. M3 webpush tombstones (+ M3b key ring needs a small doc collection) and M2 REDACT (CR M letter with
   store-side apply) — the two data-integrity items.
5. M4 FAKE/SETHOST mint, M5 SASL mech list (CR M), M8 PRIVS (doc field or CR M), M6 masked messages
   (CR M fallback in the Cluster A pattern), M12 GITSYNC (CR M), M9 ML, M10 server WALLOPS.
6. SE-1, SE-3, SE-7, SE-8 need a design pass each (burst ordering, parse re-entrancy, lease semantics,
   shutdown sequencing); SE-9 with the synth rework; M7 after the enforcement question; M11 = Cluster C.

### Deferral review (2026-09-20, user request: "the reasons may no longer stand")
**Umbrella reason is GONE.** The 07-23 bottom line deferred everything under "bites only when the target is on
a mesh-only leaf → partition scenario today, universal after MR-6; cutover flags default off, tree still
present". Since MR-6-1 (07-30) nefarious7 is an overlay-only node in STEADY STATE, and the bed runs every
cutover flag TRUE (ircd3.conf: ROUTE_UNICAST/BCAST/WALL, *_CUTOVER, LEGACY_PRESENCE, GATEWAY_BRIDGE,
TREE_RETIRE, SERVICES_BRIDGE, BOUNCER_DOC). Every "bites at MR-6" item bites now, on every gate we run.

| Deferral | Original reason | Verdict now |
|---|---|---|
| TEMPSHUN (F3) | ephemeral/rare | **CLOSED** — doc `tempshuns` shipped |
| SMO/SNO/DESYNCH (F5) | ephemeral notices | **CLOSED** today (with F2/F3 defects to fix) |
| WEBPUSH (F5) | ephemeral | **CLOSED as F5**, reopened as M3/M3b (doc holes) |
| CHATHISTORY (5-5f) | later slice | **CLOSED** (tunnel + doc stores + federated SEARCH) |
| ACCOUNT live login/logout (Tier B) | snapshot-only field | **CLOSED** — doc mint m_account.c:430/630 + MR-6-2 tunnel |
| gline/shun/zline FORCE, m_batch.c:527, m_topic.c:153 (07-27) | low | **CLOSED** 55df651 / f04879e |
| REDACT-for-CH | 5-5f slice | **PROMOTE** = M2 (data integrity; overlay-only nodes re-serve redacted rows) |
| SETHOST in-place drift | cosmetic | **PROMOTE** — same fix as M4 FAKE (host mint), one change |
| QUIT reason | cosmetic | **PROMOTE (cheap)** — reason no longer partition-only: every remote quit on every mesh node exits with the literal "Quit" (crdt_shadow.c:5380); carry the reason on the user tombstone op |
| Ephemeral/TTL METADATA + MDQ | spec §C3 = memory+S2S only, no doc; "burst gap" | **PROMOTE** — the reason was about the DOC; CR M exists precisely for ephemeral data. Live-confirmed 07-25 that user-sourced ephemeral MD is fake-direction-dropped beyond the tree horizon — the last user-sourced tree-relayed token. Emit sites m_metadata.c:936/941/1060; a CR M letter with local apply |
| SVSNOOP (F3) | rare | **PROMOTE (cheap)** — server-targeted like SVS*; one more CR X letter in the existing re-inject table (m_crdt.c:694-710) |
| hunt_server family (~20 remote queries) | `/CRDT map/peers/status` is the substitute | **SPLIT.** Stands for oper introspection (MAP/LINKS/STATS/TRACE). Does NOT stand for user-facing remote WHOIS (`WHOIS nick nick` for a user on a mesh-only node: idle/away/channels), and weakly for MOTD/VERSION/ADMIN/INFO/TIME/LUSERS. Two directions needed: the request (generic CR X "hunt" letter carrying the token + re-inject, same table) and the NUMERIC replies toward a requester homed on a mesh-only node (do numerics dead-sink? — verify, then design once for the whole family) |
| RENAME (F4) + RLO | channel split-brain; "blocked on services" | **PROMOTE — reason LAPSED.** A real gate on 07-23 (X3 had no relocate support then); it lapsed when X3 relocate shipped 2026-08-02 and prod X3 was never the bar for the bed. The bed's X3 checkout now carries relocate design D (`a2ad2f0` issuer-only mover set, `d7a7bbf`, `3b9988c`) and the fork side is shipped, so RENAME/RLO are fully exercisable on the bed. The mesh half is the only gap: m_rename.c has zero mesh handling → a RENAME arriving from legacy leaves the doc on the old key, the gateway re-asserts it, the channel splits PERMANENTLY; RLO toward a user on a mesh-only node dead-sinks (gateway-only). Design item now: doc-side rename op (tombstone old key + create new with ctime + move member/ban sets, single-writer at the gateway edge) + RLO over CR X/CR M |
| SETTIME | HLC+NTP layering | **STANDS**; the DESYNCH-on-SETTIME raw emit (m_settime.c:166/244) is minor |
| BS/BX residual `cli_user(stub)` trace (07-27) | BX-with-stub-source unlikely | **PROMOTE the trace** — anchors are steady state; nine bounce_alias_* sub-handlers untraced (c-auditor, read-only) |
| handlers.h:308 prototype nit | mid-feature | trivial, do with the next m_chathistory.c touch |
| Orphan-reap Inc 2 (destructive) | characterize first | **STANDS until SE-2/SE-8** — beacon-freshness accuracy is the precondition for a destructive reap; fix those first, then re-open |
| Bloom filter for CH A F | inert path | STANDS |
| M7 FEAT_CRDT_BOUNCER_DOC fallback removal | user's call | unchanged; note the doc-off path has been untested since 5-5e |

Net effect on the fix order above: add QUIT reason + SVSNOOP to batch 3 (cheap, shipped patterns),
ephemeral MD over CR M to batch 4 (with REDACT — both are "user-sourced content that dies at the horizon"),
remote WHOIS + numeric-reply direction and the RENAME doc op to the design-pass list, and the BS/BX
stub-source trace to the next c-auditor run.
