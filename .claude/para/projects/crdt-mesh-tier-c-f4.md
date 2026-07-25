# Tier C F4 — RENAME over the mesh: BLOCKED on services integration

Investigated 2026-07-25 (code recon on crdt-mesh @ 773857d, X3 cross-check). Conclusion:
**do NOT pick F4 up as a CRDT convergence task now — it is prerequisite-blocked, not merely
hard.** The roadmap's "trickiest" undersold it.

## Current state of RENAME (ground truth, not theory)

`m_rename.c` (client `m_rename` + server `ms_rename`), IRCv3 `draft/channel-rename`:
- **Unregistered channel**: authority check is `IsChanOp(member)` (m_rename.c:395). Passes →
  `rename_channel()` + `send_rename_to_members` + `sendcmdto_serv_butone_v3(CMD_RENAME)`. WORKS.
- **Registered channel (+R)** (m_rename.c:414-443): the ircd cannot authorize it locally, so it
  fires a permission query at the services server — `AC <user> R <cookie> <chan> RENAME <newname>`
  — records a `PendingRename` (cookie), and returns to await a reply. **This protocol is the
  client half of a REAL X3 fork** (built by MrLenin + Claude previously) that implemented the
  channel-rename authority handler — it is NOT vaporware. BUT that fork is orphaned: X3
  investment is being wound down (Rubin's call — the whole rationale for [[project_x3_nefarious_merge]]),
  so the rename-capable X3 is not the shipping/upstream path. The testnet's x3 + evilnet/x3
  master carry no such handler, so in the deployed reality the query goes unanswered and the
  pending request times out. Net effect today = a dead path, but by ABANDONMENT-of-direction,
  not because the feature was never built.

## The authority trap (the load-bearing blocker)

You cannot converge a rename you cannot authorize. The ircd can locally evaluate exactly ONE
authority: `IsChanOp` (opped) — sufficient for unregistered channels, nothing else.
- Registered channels: authority = ChanServ access (founder / +n), which lives in SERVICES, not
  the ircd. The ircd doesn't hold it.
- Oplevels (`apass`/`upass`, ircu's founder-ranking) could give the ircd a services-independent
  founder notion — but **Afternet does not run oplevels**. Not available.
- Services: the authority handler EXISTS (our X3 fork) but is orphaned — X3 investment is
  winding down, so it's not a path we'll ship/maintain; the deployed X3 has no responder.
→ No authority source for registered-channel rename in the DEPLOYED system, and (by the X3
  wind-down) none coming from continued X3 work. Nothing legitimate to converge on the current
  bed; the authority must move into the integrated ircd. Converging the +R case now = MDQ-class
  dead surface.

## Why the only doable case isn't worth it

The lone convergeable case — unregistered/opped rename — is the HARDEST CRDT modeling in Tier C
for the LEAST value:
- Channels are keyed by NAME across every collection (members OR-set, topics, modes, ctime,
  chanmeta, bans, excepts, member_status). A rename is an atomic cross-collection re-key.
- Concurrent hazards: `#a→#b` on one node vs `#a→#c` on another (divergent target);
  `#a→#b` where `#b` already exists (collision); rename racing a live `JOIN #a`.
- The channels in question are EPHEMERAL (unregistered → no persistence; the metadata work
  already established unregistered channels are memory+S2S only). A rename of a throwaway
  channel is low-stakes.
Worst effort:value ratio in the tier.

## The real gate — and why integration dissolves BOTH problems

Valuable F4 (renaming REGISTERED channels) is downstream of services integration
([[project_x3_nefarious_merge]]). Integration fixes not just authority but the modeling:
- **Authority**: the ircd would own channel registration/founder state → can authorize a
  registered rename locally (no services round-trip, no dead path).
- **Modeling**: an integrated registration gives each channel a STABLE registration-identity.
  Key the doc collections on that identity instead of the mutable name, and "rename" becomes an
  LWW-set of a name attribute — the cross-collection re-key and the split-brain hazards
  evaporate. (This is the canonical CRDT rename pattern: identity ≠ name.)
So F4-done-right is genuinely blocked on integration, not just deferred by difficulty.

## Recommendation

- **DEFER F4**, marked blocked-on-integration (roadmap updated). Revisit as part of / after the
  services fold-in, and design channel-identity-not-name at that point.
- **Separate, independent, optional prod-fork honesty fix** (NOT F4, NOT CRDT): make
  `m_rename.c`'s registered-channel branch return a clean `FAIL ... CANNOT_RENAME`
  ("registered channel renames require services support, which is unavailable") instead of the
  silent pending-request-then-timeout. ~5 lines; improves the current prod fork; kills a
  feature that silently never works. Gated on user go-ahead.

## Cross-refs
Parent scope `crdt-mesh-tier-c-scope.md` (F4 one-liner, now superseded by this). Sibling F3
shipped (`crdt-mesh-tier-c-f3.md`). The integration prerequisite is [[project_x3_nefarious_merge]].
