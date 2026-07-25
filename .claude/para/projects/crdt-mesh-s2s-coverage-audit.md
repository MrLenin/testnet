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

### Cluster B — SASL cache invalidation (SECURITY, MAJOR)
- **CI (CACHEINVAL)** — SASL positive-auth-cache invalidation is P10-tree-only (`sendcmdto_serv_butone_v3`
  over `cli_serv(&me)->down`, send.c:2026); no doc, no CR carrier, not in the CR-X bridge switch. An
  overlay-only leaf keeps a **stale positive auth cache → revoked/changed credentials accepted up to
  `FEAT_SASL_POSCACHE_TTL`=300s.** Fix: a CR broadcast carrier for CI (or fold into the CR-X services bridge).

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
