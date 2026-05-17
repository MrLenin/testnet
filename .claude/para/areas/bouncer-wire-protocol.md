# Bouncer Wire Protocol — As Designed vs As Implemented

Step 2 of the audit. **Designed-vs-implemented map** of every BS and BX subcommand currently in the code, traced to its design origin (or marked as undesignated). Reads against `bouncer-design-intent.md`.

## Method

For each subcommand currently dispatched in `bouncer_session.c`:
- **Designed in:** which gist (if any) specifies it
- **Wire format as designed:** the format the gist specifies
- **Purpose:** the role under design intent
- **Origin assessment:** in-design / refactor-of-design / scope-creep / undesignated

Wire-format compliance with the code's actual emit/parse — **deferred to step 4**. This document is about what should exist on the wire and why, not whether the bytes line up.

## BS — Bouncer Session (state replication)

Six subcommands dispatched at [bouncer_session.c:2170](../../nefarious/ircd/bouncer_session.c#L2170):

| sub | designed in | wire format (designed) | purpose | origin |
|-----|-------------|------------------------|---------|--------|
| C | Feb 23 (BV plan) + Mar 2 | `BS C <account> <sessid> <token> <state> <created> <attach_count> <total_active> :<channels>` | Create / replicate session record | **in-design** |
| A | Feb 23 + Mar 2 | `BS A <account> <sessid> <numeric>` | Attach: bind session to a current primary numeric (and via Mar 2 extension, communicate managing server) | **in-design** |
| D | Feb 23 + Mar 2 | `BS D <account> <sessid> <numeric> <ts> :<channels>` | Detach: session went HOLDING, ghost retained | **in-design** |
| X | Feb 23 + Mar 2 | `BS X <account> <sessid>` | Destroy: session ended (expiry / teardown / KILL) | **in-design** |
| U | Feb 23 + Mar 2 | `BS U <account> <sessid> <field>=<value>` | Update single field on the session record | **in-design** |
| T | Mar 2 | `BS T <account> <sessid> <new-origin-numeric>` | Transfer ownership (managing server changes — e.g., on SQUIT promotion) | **in-design** |

**BS L from the Mar 2 design is absent from the code.** Mar 2 specified `BS L <account> <sessid> + <alias-numeric> <server-numeric>` and the `-` form for alias add/remove. The current code embeds alias tracking inside `BX C` (which carries primary + alias numeric + chanlist) and `BX X` (alias destroy). This is a refactor — the role moved to BX, not lost. Probably reasonable; flag for step 5 as "design said BS L, code uses BX C/X to cover it — verify the role is fully covered."

**BS surface is clean** — all six subcommands trace to design.

## BX — Bouncer Transfer (active state changes)

Eleven subcommands dispatched at [bouncer_session.c:4416](../../nefarious/ircd/bouncer_session.c#L4416):

| sub | designed in | wire format (designed) | purpose | origin |
|-----|-------------|------------------------|---------|--------|
| C | Mar 2 | `BX C <primary_numeric> <alias_numeric> <account> <sessid> :<channels>` | Create alias on a remote server | **in-design** |
| X | Mar 2 | `BX X <alias_numeric>` | Destroy alias (silent — no QUIT to channels) | **in-design** |
| P | Feb 25 + Mar 2 | `BX P <old_numeric> <new_numeric> <sessid> <nick>` | Promote/transfer: numeric swap. Dual-mode: legacy = membership swap, IRCv3 = alias→primary promotion. **The one BX subcommand legacy peers also speak.** | **in-design** |
| N | Mar 2 | `BX N <primary_numeric> <new_nick> <ts>` | Sync nick change to remote aliases | **in-design** |
| U | Mar 2 | `BX U <alias_numeric> <field>=<value>` | Update an alias field (e.g., caps) | **in-design** |
| E | post-Mar-2 implementation | (filled in during implementation) | Echo-message analog: echoes messages that aliases wouldn't otherwise see but should (PMs delivered to the primary's server need to reach alias-holding servers too) | **post-design feature** (gap fill) |
| M | — | (not in any gist) | Multiline alias echo across S2S | **post-design feature** (cluster C1) |
| R | — | (not in any gist) | "Reconcile": session-vs-session split-brain resolution with last-active + lex tiebreakers, demote-loser-to-alias | **scope creep** (cluster B) |
| K | post-Mar-2 implementation | (filled in during implementation) | Snomask sync — OPER on primary's connection didn't propagate snomask to alias-holding servers, so alias connections didn't receive snotices the user was supposed to see | **post-design feature** (gap fill) |
| J | — | (not in any gist) | Cross-server alias channel-attach + JOIN msgid parity | **scope creep** (cluster C3) |
| F | — | (not in any gist) | "Handshake" — gates burst tail on peer's reconcile-end (paired with BX R) | **scope creep** (cluster B) |

### Origin classification rationale

- **In-design (5):** BX C/X/P/N/U are exactly the 5 subcommands Mar 2 specified. These are the protocol's intended surface for active state change.
- **Post-design feature (3):** BX M (multiline-batch echo), BX E (echo-message analog), and BX K (snomask sync) are all design gaps filled during implementation post-Mar-2 — legitimate additions that close real holes (multiline support, alias-needs-to-see-PM-echoes, OPER snomask propagating to alias-holding servers). These are *new feature work* tied to IRCv3 cap parity across distributed alias rosters, not scope creep. Their *lifecycle complexity* (sweep on alias destroy, drain on link drop, batch wrappers — all in BX M's case) is worth checking in step 4.
- **Scope creep — but partly real-gap-driven (BX R, BX F):** Mar 2 said stale ghosts lose via natural nick collision (older lastnick wins). That assumption fails for **persisted sessions**: both sides restore from the same persisted state, both ghosts end up with identical timestamps, P10's equal-TS rule kills both. The design has a real gap here. But the right primitive for closing the gap is **deterministic dedup as part of same-session convergence** (pick a survivor, silently destroy the duplicate, no contest), not the current code's winner-picking-with-demote. So cluster B is responding to a real problem with the wrong shape of solution. See [bouncer-design-intent.md](bouncer-design-intent.md#persistence-breaks-the-designs-natural-nick-collision-assumption) — "Persistence breaks the design's 'natural nick collision' assumption."
- **Real-gap-driven scope creep (BX J):** Cross-server alias auto-joins were generating JOIN events with no msgid, or with msgids that differed from the primary's JOIN msgid. When primary is on server A and alias is on server B, server B's per-server auto-attach for the alias couldn't know what msgid server A used for the primary's original JOIN — so the alias's JOIN msgid diverged from the primary's. **Concrete symptom: chathistory desync** between primary and alias for what's logically the same JOIN event.

  **Chronology:** Discovered during debugging of a HexChat auto-rejoin quirk (separate bug, fixed at the m_join layer in `f3fb834` "skip duplicate JOIN when alias already auto-attached"). While examining raw S2S logs from that debugging session, the missing msgid tag was noticed — distinct issue, distinct fix. Both landed in the same cluster (C3) because they were temporally adjacent, but they address different problems at different layers.

  **Deferred action (user 2026-05-04, not yet executed):** Revert `f3fb834` — user has already patched their HexChat fork to handle the auto-rejoin race smarter, removing the need for the server-side accommodation. The fix is a workaround for a client bug; reverting cleans up an asymmetric server-side concession. Wait for explicit user direction before performing the revert.

  This is a violation of the user's stated hard invariant: *"every event must use ONE msgid across all delivery paths (history, broadcast, S2S, federation, replay)"* (see `feedback_single_msgid.md` in user memory). Mar 2 said alias channel-attach is auto-sync per server, but didn't address how to preserve the single-msgid invariant when the auto-attach happens on a different server than the originating JOIN.

  This is the same family as BX R/BX F: real-gap-driven scope creep — Mar 2 has a hole, the response patches it with a wire subcommand. The audit question for step 5 is the same too: **could the gap be closed without the broadcast, while still preserving the single-msgid invariant?** Two candidates:
  - **Deterministic msgid derivation:** derive the alias-JOIN msgid from `(primary's full numeric, channel name, primary-join-time)` so all servers compute the same msgid for the same auto-attach event without needing to broadcast. Preserves the invariant by construction.
  - **Ride-along on BX C:** since BX C carries the alias's channel list at create time, the primary's per-channel JOIN msgids could ride along in the same message rather than needing a separate BX J broadcast.

  Both eliminate BX J as a separate subcommand while preserving the single-msgid invariant. Worth raising in step 5 as design alternatives, not implementing unilaterally.
- **Undesignated (2):** BX E and BX K aren't in any gist provided. They may be reasonable additions for features that weren't covered in design docs (oper snomask, echo-message routing) — or they may be reactive. Step 4 will read the code and classify them definitively.

### What "scope creep" means here

Not always "the code is wrong." Three distinct flavors after the BX E / BX K reclassification:

1. **Real-gap-driven scope creep** (BX R, BX F, BX J): the design has a gap, the code adds a subcommand to close it, but the *shape* of the response is questionable. BX R/F use winner-picking when convergence-via-roster-union is the design intent. BX J broadcasts coordination state when ride-along-on-BX C would preserve the same single-msgid invariant without a separate subcommand.
2. **Post-design feature / IRCv3 cap parity gap fill** (BX M, BX E, BX K): legitimate new wire-protocol work to close real gaps the Mar 2 design didn't cover — multiline batch lifecycle (BX M), per-PM echo to aliases (BX E), and oper-snomask propagation to alias-holding servers (BX K). These are not scope creep. Implementation lifecycles (especially BX M's batch wrapper / drain / sweep machinery) are still worth auditing in step 4.

Step 5 question for each: **what's the minimum protocol surface that satisfies design intent, including the gaps surfaced after Mar 2?** That number is almost certainly smaller than 11 BX subcommands.

## What about the legacy contract?

Per design intent (invariant #7) and Mar 2 ("Legacy fallback: BX P handler branches on `IsBouncerAlias(new)` — legacy takes swap path, IRCv3 takes alias path"), legacy peers should see **BX P only**. All other BS/BX subcommands should be silently dropped on legacy peers (legacy `parse.c` registers BX as `m_ignore` for unknown subcommand routing).

This means every code path that emits BS or BX should ask: "is this peer IRCv3-aware?" and gate accordingly. Step 4 will check whether emit-time gating is in place for each subcommand. The reverts in cluster D (FLAG_IRCV3AWARE gating, @A msgid prefix on legacy peers) are evidence that this gating has been buggy historically.

## Summary table

| token | subcommands in code | in-design | post-design feature | real-gap-driven |
|-------|---------------------|-----------|---------------------|-----------------|
| BS | 6 (C, A, D, X, U, T) | 6 | 0 | 0 |
| BX | 11 (C, X, P, N, U, E, M, R, K, J, F) | 5 | 3 (M, E, K) | 3 (R, F, J) |

**45% of BX subcommands are post-Mar-2 additions; ~27% are scope-creep-shaped responses to real gaps that may not need separate wire commands at all.** The BS surface is fully designed; the BX surface splits cleanly between "in-design," "legitimate post-design feature/gap-fill," and "real-gap-driven that needs design-intent reshaping."

## Step 4 entry points (which subcommands to read first against intent)

Priority order:
1. **BX R + BX F together** — these are the alleged scope creep and the highest-churn area. Read them with a single question: are they doing anything that Mar 2's "deterministic tiebreaker + natural nick collision" model couldn't? **(Step 4 cluster B done — see `bouncer-audit-cluster-b.md`.)**
2. **BX J + BX C interaction** — Mar 2 says alias channel-attach is auto-sync (each server independently when primary joins). BX J is broadcast-coordinated. Read for: why broadcast, and would the ride-along-on-BX C alternative (preserving the single-msgid invariant) cleanly subsume it?
3. **BX C in-place conversion path** — the bug surfaced tonight. Mar 2 design treats alias creation as a fresh-allocate; current code has an "existing client → convert in place" branch ([bouncer_session.c:4949](../../nefarious/ircd/bouncer_session.c#L4949)) that wasn't designed. This is where the held-ghost-vs-live-primary collision came from.
4. **BX M** — large surface (cluster C1 lifecycle complexity). Question: is the multiline-aware path a clean layer on top of BX, or is it tangled with the C3 deferral / drain machinery?
5. **BX E and BX K** — both classified as legitimate gap-fill features. Step 4 read should validate: implementations are scoped to their stated purpose (echo to aliases, snomask sync), no scope-creep-into-state-coherence, no silent-defer markers.
6. **BX P legacy vs IRCv3 branching** — Mar 2 specifies dual-mode dispatch on `IsBouncerAlias(new)`. Read for: does the current code maintain the design's clean two-branch structure, or has it accreted edge cases?
