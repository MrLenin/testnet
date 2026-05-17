# Bouncer State Machine — As Designed vs As Implemented

Step 3 of the audit. Maps the state set and transitions for sessions, clients, and connections, separating what was specified in design docs from what's accreted in code. Reads against `bouncer-design-intent.md` and `bouncer-wire-protocol.md`.

## Three axes of state

The bouncer system has state at three distinct levels. Conflating them is one of the implementation hazards.

1. **Session state** — properties of the logical (account, sessid) tuple. Replicated across servers via BS.
2. **Client state** — properties of an individual `struct Client` (a connection or held-ghost). Per-server.
3. **Per-server connection-coordination state** — flags and counters that exist purely to coordinate cluster-B-style burst races. Per-server, transient.

## Session state — designed

From design intent + Mar 2 gist:

| state | meaning | enters when | leaves when |
|-------|---------|-------------|-------------|
| **ACTIVE** | one or more connections (primary + zero-or-more aliases) are alive on the network | session creation; or HELD → ACTIVE on reconnect | last connection clean-disconnects (→ HELD); explicit teardown (→ end); **network KILL of any session connection (→ end, all other connections also terminated)** |
| **HELD** | no connections alive; ghost retained as nick-holder | last connection clean-disconnects with persistence enabled | a client reconnects to the session (→ ACTIVE); hold-clock expires (→ end); explicit teardown (→ end); **KILL of the held ghost (→ end)** |

End states:
- **DESTROYED** — session record deleted from registry. Four paths: hold-expiry, explicit teardown (BOUNCER RESET / ORESET), network KILL of any session connection, network KILL of held ghost.

> **Note: KILL ≠ clean disconnect.** The current code has paths that treat KILL as a normal disconnect for promote purposes (e.g., `bounce_promote_alias` runs after exit_client regardless of FLAG_KILLED on the primary). Per design intent (`bouncer-design-intent.md` invariant #12), network KILL of any session connection should terminate the entire session — aliases shouldn't survive. **Likely active-bug surface in the current code.** Step 4 reading of `bounce_promote_alias` and the exit_client paths should specifically check whether KILL semantics are honored.

Transitions in design:
```
                ┌─────────────────────────────────────────┐
                │                                         │
   creation ──> ACTIVE  ───── last conn drops ─────>  HELD ──── expiry/teardown ──> DESTROYED
                  │                                    │
                  │   ╱                                 ╲   ╱
                  │  ╱  ──── reconnect ─────────────────╲  ╱
                  │ ╱                                    ╲╱
                  │                                      ╱╲
                  │                                     ╱  ╲
                  ↓ explicit teardown / KILL no alias ↓
              DESTROYED
```

That's the entirety of the designed session lifecycle. **Two states.**

### What the gists do *not* address

- **Restore-from-persistence transition.** When a server boots and reads the persisted session record, what state is the session in? Does it enter HELD, or a transient "restore-pending" state, or directly ACTIVE if a client immediately reconnects? The gists are silent. This is part of the persistence-related gap surfaced earlier (equal-TS ghosts on relink).
- **In-flight transitions across S2S.** The gists treat session state as something each server independently tracks; the BS protocol replicates state changes. There's no notion of "session in state X on server A but state Y on server B during a transition" — implicitly, transitions are atomic per server.

## Session state — implemented (per code structures)

`BouncerSession` defines (from prior reading of `bouncer_session.h`):
- `hs_state` — enum with `BOUNCE_ACTIVE` and `BOUNCE_HOLDING` (and possibly more)
- `hs_restore_pending` — boolean flag. Not in any design doc.
- `hs_promoting` — boolean flag for SQUIT promotion in progress. Not in any design doc.
- `hs_pending_demote_peer[]` — string buffer for deferred active-vs-active demote target. Not in any design doc; cluster-B accretion.

So the designed two-state session machine has accreted three transient-state companions:
- `restore_pending` — session is still resolving against a peer's burst before it can act authoritatively.
- `promoting` — session is in the middle of an alias-to-primary swap during SQUIT.
- `pending_demote_peer` — session has been told it should yield to a peer but hasn't completed the demote yet.

**Status assessment:**
- **`hs_promoting`** — probably legitimate. SQUIT is multi-step (alias chosen, BX P broadcast, channel memberships transferred, ghost exits). Some flag during the multi-step is needed. Could be in-design even though the gist doesn't mention it. **Verify in step 4** that the flag is scoped to the actual multi-step window.
- **`hs_restore_pending`** — addresses the persistence gap, but is a winner-picking-style flag (we wait for the peer's burst to know if they have a "stronger" claim). Under the convergence-via-roster-union intent this flag's role evaporates: same (account, sessid) on both sides means *converge*, not *await arbitration*. **Probably reactive accretion**.
- **`hs_pending_demote_peer`** — direct cluster-B accretion. Stores "the peer numeric I should demote to once their N arrives." Under the convergence intent, demote-to-alias isn't the right resolution at all (deterministic dedup is), so this entire mechanism may be obsolete. **Reactive accretion**.

### Persistence questions — both answered "the design didn't decide"

User's honest answer 2026-05-04: persisted sessions were rushed in without the design discipline of the rest of the bouncer system. The two questions don't have clean designed answers — code in this region implements whatever the implementation evolved toward, not a specified policy. See `bouncer-design-intent.md` §"Persistence — under-designed by user admission" for full context.

Operationally for step 4:
- `hs_restore_pending`'s observed shape ("provisionally authoritative pending peer-burst arbitration") is an *accretion*, not a designed semantic. Code reading should not measure it against a "designed" baseline because there isn't one. Instead document what it does and flag whether it's fit for purpose given convergence-via-roster-union intent.
- Persisted aliases: `hs_aliases[]` exists per Mar 2, but what restoration *means* (sockets dead, only metadata survives) was never worked out. Treat related code paths as "implementing whatever evolved" and assess against the broader design intent (single-msgid invariant, lockstep nicks, no winner-picking, etc.) rather than a specific persistence design.

**Sustainable cleanup of cluster B almost certainly requires a coherent persistence-and-reconciliation design first.** That's a step *before* step 4-style code-vs-design work in this region — and it's a separate effort from this audit. Step 4 can still surface specific code-level findings (silent-defer markers, msgid gaps, undocumented edge cases), but the architectural-rework-of-persistence question is bigger and out of scope for the audit itself.

## Client state — designed

From Mar 2 gist:

| client kind | own numeric | in nick hash | network-visible | channel-member with |
|-------------|-------------|--------------|-----------------|---------------------|
| **regular** (non-bouncer) | yes | yes | yes | normal flags |
| **primary** | yes | yes | yes (to all peers) | normal flags |
| **alias** | yes | **no** | only to bouncer-aware peers | `CHFL_ALIAS` |
| **held ghost** | yes | yes | yes (to all peers, including legacy) | normal flags + `CHFL_HOLDING` membership flag |

Transitions:
- regular → primary: at session create, the registering client becomes the primary.
- regular → alias: at session attach, an additional registering client becomes an alias.
- alias → primary: via `BX P` (numeric swap) when the previous primary disconnects with at least one alias remaining.
- primary → held ghost: at last-connection-drop with persistence enabled, primary stays as a held ghost.
- held ghost → primary: at reconnect, ghost is "revived" by the new connection (socket transplanted, identity preserved).
- alias / primary / held ghost → destroyed: explicit teardown, KILL, or hold expiry.

### Mar 2-implied invariants

- **Aliases are never N-broadcast** — they appear on bouncer-aware peers only via `BX C`, not via the standard NICK introduction.
- **Held ghosts ARE N-broadcast** — they look to legacy peers like ordinary clients (per design intent, see `bouncer-design-intent.md` §"Legacy peer's view of a HELD session").
- **Primary↔alias nick lockstep** — invariant #3 from design intent.

## Client state — implemented (additional flags accreted)

The codebase has accumulated a number of client-level flags beyond the design's primary/alias/held-ghost trichotomy. From a quick scan of `client.h` and `bouncer_session.h` — full list to verify in step 4 — likely candidates include:

- `FLAG_BOUNCER_ALIAS` (`IsBouncerAlias`) — designed: maps to "alias" kind.
- `FLAG_BOUNCER_HOLD` (`IsBouncerHold`) — designed: maps to "held ghost" kind.
- `FLAG_BXF_AWARE` — accretion: cluster-B handshake-capability flag, for gating burst tail on BX F handshake completion. Marked as **post-design** since it exists only because BX F exists.
- `FLAG_KILLED` — pre-existing P10 flag, used heavily by bouncer code to suppress Q broadcasts on silent destroys (held-ghost yield, session move, etc.). Not bouncer-specific but bouncer's silent-destroy semantics depend on it.
- `CHFL_ALIAS` — designed: channel-membership flag for aliases.
- `CHFL_HOLDING` — designed: channel-membership flag for held ghosts.

Step 4 will catalogue all bouncer-related client flags, classify each, and flag any that exist purely to coordinate cluster-B-protocol races.

## Per-server connection-coordination state

This axis exists *only* in the implementation, *not* in any design doc. Examples (from prior reading and inventory):

- **`pending_bx[]`** (from `bx_drain_in_progress`, `s2s_bxm_cleanup_alias`, etc.) — buffered BX subcommands waiting for a BX C to land for an unknown alias numeric. Cluster C3 accretion.
- **BX M batch buffers** — multiline-batch lifecycle (sweep on alias destroy, drain on link drop). Cluster C1, post-design feature complexity.
- **`s2s_alias_source` / `s2s_want_tags`** — TLS contexts for alias-aware S2S source rewriting. Necessary for the alias model in general; not a bug, but adds machinery.

This entire axis is implementation-internal. The audit's question for step 4: how much of it would disappear if the scope-creep BX subcommands (R, F, J) were removed?

## Designed transitions vs implemented transitions — summary

| transition | designed | added by code | added why |
|------------|----------|---------------|-----------|
| ACTIVE ↔ HELD | yes | — | — |
| ACTIVE / HELD → DESTROYED | yes | — | — |
| ACTIVE → ACTIVE (primary swap via BX P) | yes | — | — |
| HELD → ACTIVE (socket transplant on reconnect) | yes | — | — |
| ACTIVE → ACTIVE (cross-server primary roam) | implied (via BX P with cross-server old/new) | — | — |
| (transient) restore_pending | no | yes | persistence-gap-driven, but currently shaped as winner-picking |
| (transient) promoting | partially (SQUIT is multi-step) | likely yes | SQUIT atomicity guard — probably legitimate |
| (transient) pending_demote_peer | no | yes | cluster-B active-vs-active demote — under convergence intent, this transition shouldn't exist |
| (transient) BX-F-handshake-pending | no | yes | gates burst tail on peer's BX R reconcile-end. Disappears if BX R/F disappear. |

## Step 4 entry points (what to read first)

In rough priority order:
1. **Session state enum + the three "transient flags" (`hs_restore_pending`, `hs_promoting`, `hs_pending_demote_peer`)** — what code paths set/clear each, and whether the transitions they gate would still be needed if cluster B's BX R/F machinery were removed.
2. **`bounce_revive_*` family** — the HELD → ACTIVE transition. Mar 2 specifies socket transplant; verify the code does that and not something more elaborate.
3. **`bounce_promote_alias` and SQUIT promotion path** — the alias → primary transition. Designed; verify the dual-mode (legacy swap vs IRCv3 alias path) is preserved.
4. **The BX C in-place-conversion path** at [bouncer_session.c:4949](../../nefarious/ircd/bouncer_session.c#L4949) — converts a non-alias local client (typically a held ghost) to an alias when a remote primary's BX C arrives. **This was the trigger for tonight's collision.** Mar 2 design treats alias creation as fresh-allocate; the in-place path is post-design accretion that interacts with the equal-TS persistence gap.
5. **Client flag set** — full inventory of bouncer-related client flags, classification per design vs accretion.

### Cross-cutting reading lens: silent deferrals + msgid gaps

Per user 2026-05-04: prior assistant work on this codebase had a habit of silently deferring edge cases without leaving findable notes — particularly around msgid handling. Step 4 reading should specifically:

- Flag any msgid-bearing event (JOIN echo, PART echo, NICK echo, PRIVMSG/NOTICE, multiline batch entries, BATCH wrappers, BX-J-coordinated alias auto-attaches, replay paths) where the msgid is **derived in more than one place** or **conditionally absent**. The single-msgid invariant says one msgid per logical event across all delivery paths; multiple derivation sites are a smell.
- Flag any code path that produces a message-bearing event but does *not* explicitly set / propagate a msgid. The absence is the bug.
- Flag any TODO / FIXME / "for now" comment, especially if vague — those are likely silent-deferral markers from prior work.
- Treat anything that *should* have a comment explaining a non-obvious choice but doesn't, as suspect. Especially in cluster B/C3 territory.

This is in addition to the design-vs-accretion classification each entry-point reading produces.
