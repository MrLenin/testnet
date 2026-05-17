# Bouncer ghost auto-away

**Status:** Planned
**Author:** ibutsu
**Date:** 2026-04-30

## Problem

When a server restarts and restores held bouncer sessions from MDBX, the
ghosts are created in HOLDING state with no away message. To anyone
querying via WHOIS or seeing the ghost in a channel, the user appears
present — but they aren't, the connection is gone, just the ghost shell
remains so channel state and msgids survive.

## Approach

Auto-mark MDBX-restored ghosts as away with a configurable message.
Clear when a real connection attaches (revive, alias attach, or burst
absorb).

## Mechanics

### Set on ghost creation

In `bounce_create_ghost()` (the MDBX restore path,
[bouncer_session.c:1518](nefarious/ircd/bouncer_session.c#L1518)),
after the ghost's `User` struct is built and before it's added to the
client list:

```c
if (feature_bool(FEAT_BOUNCER_GHOST_AUTO_AWAY)) {
  const char *msg = feature_str(FEAT_BOUNCER_GHOST_AWAY_MSG);
  if (!msg || !*msg)
    msg = "Disconnected (bouncer)";
  user_set_away(cli_user(ghost), (char *)msg);
}
```

No new flag needed — it's just a regular `cli_user->away` string.
Aggregation, WHOIS, and `away-notify` paths handle it like any other
away message.

### Clear on revive

In `bounce_revive()`
([bouncer_session.c:2919](nefarious/ircd/bouncer_session.c#L2919)),
after `was_holding` is determined and before the socket transplant:

```c
if (was_holding && cli_user(ghost)->away) {
  /* Clear auto-away unless the attaching connection has draft/pre-away
   * intent indicated otherwise. The new socket's first /away (if any)
   * will set the real message via aggregation. */
  user_set_away(cli_user(ghost), NULL);
}
```

Special case: if the attaching client negotiated `draft/pre-away` and
sent `AWAY *` (con_pre_away == 2), leave the ghost's away in place —
the user explicitly opted out of network-visible presence. The
aggregation rules then fall back to whatever still-away connections
exist in the session, which on a fresh attach is just this one
auto-away ghost.

### Clear on burst absorb

The BS C reconcile path I added at
[bouncer_session.c:2167](nefarious/ircd/bouncer_session.c#L2167) calls
`exit_client(ghost)` when leaf's stale HOLDING ghost yields to hub's
ACTIVE session. The ghost's User struct (with its auto-away) is freed
as part of the exit. Nothing extra needed — the hub's effective-away
arrives via the BS C metadata or subsequent AWAY relay.

### Alias-attach interaction

When the first alias attaches to a HOLDING session (via SASL +
`bounce_auto_resume`), the alias becomes the new primary (or stays as
alias if there's an active session elsewhere). Either way, the
aggregation re-runs:

- If alias is `/away` with a real message → most-recent-wins, alias's
  message overrides auto-away.
- If alias is present (no away) → effective state becomes "present",
  auto-away cleared.
- If alias is `/away *` → effective considers only non-`*` connections.
  Without a present-or-real-away connection, the ghost's auto-away
  remains the visible state. Correct: user set themselves invisible to
  presence, but the underlying disconnect is still real.

## Configuration

Two new feature flags ([ircd_features.c](nefarious/ircd/ircd_features.c)):

- `FEAT_BOUNCER_GHOST_AUTO_AWAY` (bool, default `TRUE`)
- `FEAT_BOUNCER_GHOST_AWAY_MSG` (string, default `"Disconnected (bouncer)"`)

## Visibility

- `/WHOIS user` → standard 301 numeric `<user> :Disconnected (bouncer)`
- Channel `away-notify` → no broadcast at ghost-creation time
  (creation happens at server startup before any client is connected).
  WHOIS-on-demand is the normal path.
- After the user's clients reconnect, normal `away-notify` traffic
  flows.

## Edge cases

1. **User had set a real away before disconnect.** The persisted record
   doesn't currently snapshot `cli_user->away`. Either:
   - Persist the user's last away message and prefer it over
     auto-away on restore (more "natural" UX).
   - Always replace with auto-away on restore (simpler, "you're not
     just away, you're disconnected").
   The simpler option fits the intent — a disconnected ghost is
   meaningfully different from "stepped away from desk", and the user
   can override on reconnect.

2. **Multiple held sessions for same account.** Each ghost gets its own
   auto-away independently. WHOIS shows whichever is in the nick hash
   (only one can be, by definition). Aggregation across all of them
   gives "all auto-away" → effective is the auto-away message.

3. **Bounce hold (ghost from disconnect during runtime, not MDBX).**
   `bounce_hold_client()` could also apply the auto-away — same logic,
   the user just disconnected, ghost is "auto-away from this connection
   being gone". Apply there too for consistency.

4. **Server-set away via SVSAWAY (services).** If services force-set an
   away on a user, our auto-away on hold would clobber it. The
   persistence-snapshot approach (edge case 1) would handle this; the
   simpler approach loses it. Acceptable given how rarely SVSAWAY is
   used.

## Out of scope

- Persisting the actual pre-disconnect away message across restart —
  tracked separately if requested.
- Per-channel auto-away (e.g., differing message based on which channel
  the WHOIS came from). Not a real feature, just listing for completeness.

## Testing plan

1. Connect, hold session (disconnect with bouncer enabled).
2. Restart server → ghost restored.
3. WHOIS the ghost from another connected user → should show 301 with
   the configured auto-away.
4. Reconnect → SASL → revive → auto-away cleared. WHOIS shows present.
5. Alias attach to held session: WHOIS during attach shows auto-away,
   then transitions per aggregation once alias is present.
6. Burst absorb scenario (the BS C reconcile path): leaf ghost's
   auto-away replaced by hub's effective-away after reconcile.
