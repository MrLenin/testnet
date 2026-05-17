# Step 4 — Bouncer-related client + membership flag inventory

Read against design intent. Brief — the flag set is small.

## Client flags

| flag | location | purpose | classification |
|------|----------|---------|----------------|
| `FLAG_BOUNCER_ALIAS` | `client.h:292` | Client struct represents an alias (not in nick hash, channel members carry `CHFL_ALIAS`) | **in-design** (Mar 2) |
| `FLAG_BOUNCER_HOLD` | `client.h:291` | Client struct represents a held ghost | **in-design** (pre-shadow-removal era) |
| `FLAG_KILLED` | `client.h:185` | Suppresses the standard QUIT broadcast on exit_one_client | **in-design** (inherited from P10), but **overloaded** — see KILL audit K4 |
| `FLAG_IRCV3AWARE` | `client.h:194` | Peer server speaks IRCv3 message-tag wire extensions | **in-design** (IRCv3 framework foundation) |
| `FLAG_BXF_AWARE` | `client.h:195` | Peer server speaks BX F handshake (gates burst tail on reconcile-end) | **cluster-B accretion**; user 2026-05-04 noted the *separate flag* is fine as defensive backwards-compat — the *underlying BX F mechanism* is the cluster-B issue |

## Channel membership flags

| flag | location | purpose | classification |
|------|----------|---------|----------------|
| `CHFL_ALIAS` | `channel.h:86` | Alias's invisible channel membership (excluded from NAMES/WHO/BURST/`chptr->users`, included in routing) | **in-design** (Mar 2) — 46 usages, actively load-bearing |
| `CHFL_HOLDING` | `channel.h:85` | Membership marker for held-ghost channel state | **in-design** (pre-shadow-removal era) — actively used in bouncer + WHO + NAMES paths |

## Findings

**F1 — Mutual exclusion not enforced between `FLAG_BOUNCER_ALIAS` and `FLAG_BOUNCER_HOLD`.** Per design intent, a client is either a held ghost OR an alias, never both. Per cluster C3 finding C2, the BX C in-place conversion path sets `FLAG_BOUNCER_ALIAS` without clearing `FLAG_BOUNCER_HOLD` — leaving both flags set. Currently masked by code paths that check `IsBouncerAlias` first; latent bug if any future code path inspects `IsBouncerHold` independently.

Recommended posture: at the point of conversion (`bouncer_session.c:4976` `SetBouncerAlias(alias)`), explicitly `ClearBouncerHold(alias)`. One-line fix.

**F2 — `FLAG_KILLED` overloading** is the same finding as KILL audit K4. Listed here for completeness — the flag's dual use as (a) network-KILL signal and (b) bouncer-internal silent-destroy marker is a design weakness that wants a separate flag for case (b).

**F3 — `FLAG_BXF_AWARE` separate from `FLAG_IRCV3AWARE` is the right pattern in principle.** Per user 2026-05-04. The deployment doesn't currently exercise the distinction, but defensive backwards-compatibility is worth keeping.

**F4 — `CHFL_HOLDING` is actively used.** Eight current usages across m_names, whocmds, and bouncer_session. Not dead code; legitimate state for held-ghost channel memberships.

**F5 — `CHFL_ALIAS` is heavily integrated.** 46 usages: routing, channel counters, NAMES/WHO suppression, mode-flag transfer on promote, bounce_sync_alias_join, etc. Core mechanism, not auxiliary.

## Net assessment

The flag set is small and mostly clean. Two issues:

1. **F1 (mutual exclusion not enforced on conversion)** — small bug, one-line fix.
2. **F2 (FLAG_KILLED overloading)** — design weakness, recommendation is to introduce a dedicated bouncer-internal silent-destroy flag (see KILL audit K4 for full discussion). Larger change, sequenced before any tightening of network-KILL session-end semantics.

No unused flags, no dead-code accretions, no obvious accumulation. The flag set as a whole reflects the design with reasonable fidelity.
