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
**SLICE 1 SHIPPED 2026-07-28 (`dc86c3f`, LIVE GATE PENDING — self-gating fallbacks, old path
untouched when they return 0):** CP/CN whisper now routes via crdt_route_unicast_try (real
minted msgid — the "*" placeholder is single-use per dedup window, never reuse it); XQ/XR
forward sites wired to the dormant CR-X 'Q'/'Y' cases (all three: mo_/ms_xquery, ms_xreply;
XREPLY builds user vs server numerics itself).  REMAINING (next session): targeted WALL*
(WC/WV/WH/WU — needs a CR-M member-FILTER extension: new cmd letters + receiver-side
op/voice/halfop filtering + mixed-version check on unknown-cmd handling), SVS
force-commands (SVSJOIN/PART/MODE/QUIT/NICK — CR-X toward the target's home server,
receiver re-injects), BX E/M alias echo (CR carrier in bouncer_session.c:9590 family).
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
- **Extended channel modes — MAJOR.** The doc `modes` collection stores only `CRDT_MODE_MASK`
  (p/s/m/t/i/n/k/l/R/D/registered). ZERO carriage for: the **exmode** bits
  (EXMODE_PERSIST/PUBLICHISTORY/NOSTORAGE — gate chathistory storage + channel persistence), **+A/+U**
  (APASS/UPASS oplevel passwords — **founder protection, security**), **+L** (redirect). Since CR F replaces
  BURST and P10 BURST is skipped (s_serv.c:377), a channel materialized on a mesh-only peer silently loses
  these. Steady-state masked by residual P10 MODE relay; hard break at MR-6. Fix: extend the modes doc value.
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
