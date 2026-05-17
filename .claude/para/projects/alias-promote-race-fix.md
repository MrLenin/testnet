# Alias-promote race fix — immediate promote without BX P / BX X collision

## Goal

Restore the design intent: when a primary cleanly QUITs with at least one alias remaining, immediately promote an alias via BX P (numeric swap).  No deferring to hold-expiry.

## The race we're closing

Current `m_quit.c:125` comment:

> "No immediate-promote shortcut: a primary QUIT with aliases attached holds first (same reasoning as s_bsd.c — promote and a concurrent BX X for the chosen alias race on the wire). Promotion runs only from bounce_hold_expire after the network has settled."

Concrete scenario:
- Primary on A cleanly QUITs.
- Alias X on B is *concurrently* exiting (BX X in flight from B).
- A's `bounce_promote_alias` selects X (still appears alive locally), emits BX P.
- B's BX X and A's BX P race on the wire — peers see different orders.
- Result: corrupted session state on some subset of peers.

## Proposed fix: two-layer defense

### Layer 1: Prefer local alias (eliminates the common case)

Modify `bounce_promote_alias`'s tiebreaker to prefer **local-server aliases** over remote ones.  Tiebreaker order:

1. Among local aliases: oldest `cli_firsttime` wins.
2. If no local aliases, fall back to current cross-server tiebreaker.

Rationale: a local alias's exit is detectable *synchronously* — the promoting server is the authority for any same-server alias's state.  The wire-race window only exists for cross-server BX P / BX X collisions.  Preferring local eliminates the race for the typical "primary disconnects, user still has another client on the same server" pattern.

### Layer 2: One-tick deferral for cross-server promote (narrows the remaining window)

When the chosen winner is a remote alias, defer the BX P emission to a 0-second `TT_RELATIVE` timer instead of inline.

The event loop processes all currently-queued I/O before running timers (see `engine_loop` order).  A 0-tick deferral lets any *same-tick* BX X for the winner — already sitting in the promoting server's recv buffer — process first.  If the winner is gone by the time the timer fires, re-evaluate and pick another alias (or destroy the session if no aliases remain).

This is the same `TT_RELATIVE, 0` pattern used for `socket_del` safety (see `ircd_kc_adapter.c` precedent in memory).

This **does not** close the truly-cross-server in-flight race (BX X already on the wire from B → C when A emits BX P).  For that residual case:

### Layer 3 (optional): BX P drop-on-no-winner

Update the BX P inbound handler (currently around `bouncer_session.c:6286`) to be tolerant when the referenced winner numeric is unknown — silently drop the BX P (peer already saw BX X first; its view is consistent with "no swap happened, session destroyed").  Promoter, if it doesn't receive any feedback, considers the promote successful from its own POV.  Sessions where this race fires end up in a transient asymmetric state but converge via the next BS C / EB heartbeat.

## Implementation plan

### m_quit.c

Remove the comment block and the "no immediate-promote shortcut" gating.  Call `bounce_promote_alias` directly when `bounce_should_hold` returns true AND the session has at least one alias.  If promote succeeds, no HOLDING state; if it fails (no live aliases — only happens if all aliases died between bounce_should_hold and bounce_promote_alias), fall through to the existing hold path.

### bouncer_session.c::bounce_promote_alias

Modify the tiebreaker loop:

```c
/* Prefer local-server aliases.  Local aliases' state is synchronously
 * authoritative on this server, so promoting one cannot race a
 * concurrent BX X from another server — there is no other server in
 * the picture.  Only fall back to remote-alias selection if no local
 * candidates exist. */
const char *me_yxx = cli_yxx(&me);
int local_only = 1;  /* first pass: local-only */
for (int pass = 0; pass < 2; pass++) {
  for (j = 0; j < session->hs_alias_count; j++) {
    struct Client *candidate = findNUser(session->hs_aliases[j].ba_numeric);
    if (!candidate || !IsBouncerAlias(candidate))
      continue;
    if (local_only
        && 0 != ircd_strcmp(session->hs_aliases[j].ba_server, me_yxx))
      continue;
    if (!winner_numeric || cli_firsttime(candidate) < oldest_time) {
      oldest_time = cli_firsttime(candidate);
      winner_server = session->hs_aliases[j].ba_server;
      winner_numeric = session->hs_aliases[j].ba_numeric;
      winner_idx = j;
    }
  }
  if (winner_numeric)
    break;  /* found a local winner */
  local_only = 0;  /* second pass: any alias */
}
```

When `winner_server != me_yxx` (remote winner), the caller schedules a 0-tick timer instead of broadcasting BX P inline.  Local winners broadcast immediately as today (no race).

### bounce_promote_alias return shape

Currently returns `0` (success) or `-1` (no alias).  Add `1` (success-deferred) for the remote-winner case.  Caller (m_quit) handles the three return values:
- `0` — promoted inline, session now ACTIVE under new primary
- `1` — promote scheduled for next tick, session in transient state (still HOLDING-ish but with a pending promote)
- `-1` — no alias available, fall through to bounce_hold_client

### New helper: bounce_schedule_promote(session)

Creates a 0-second `TT_RELATIVE` timer that re-runs the winner selection at fire-time (because the network may have moved on between `bounce_promote_alias` call and timer fire).  If winner still alive, broadcast BX P + BS T inline at that point.  If no alive aliases remain, call `bounce_destroy` (session is gone).

### BX P handler robustness (Layer 3, deferred)

Don't necessarily land in v1 — could be a follow-up if we observe the residual cross-server race in practice.

## Test coverage

`tests/src/ircv3/bouncer-alias-promote.test.ts` currently pins the *deferred* semantics ("session HOLDING after primary QUIT, ghost retained, alias intact").  Replace that with:

1. **Primary QUIT with local alias remaining**: alias swaps in via BX P, session state == ACTIVE, primary numeric is now the old alias's numeric.  Test runs against current docker compose (no `--profile linked`), local alias only.

2. **Primary QUIT with only remote alias** (`--profile linked`): defer + retry observed — initial /CHECK -b after QUIT shows transient HOLDING or already-ACTIVE within a short window (~tens of ms).  Test should be lenient on timing but assert final state is ACTIVE with the remote alias as new primary.

Both should be in scope of the fix.

## Open questions for review

1. Is the local-alias preference acceptable, or do you want strictly-deterministic cross-server tiebreaker (e.g., lex-lower numeric) regardless of server?  Local-preference changes promote behavior in a way observable from the network.

2. Is the 0-tick deferral acceptable UX-wise?  Sub-millisecond gap between primary QUIT and alias-becomes-primary network announcement — generally invisible but technically a tiny window where the session has no primary.

3. Should Layer 3 (BX P drop-on-no-winner) land in v1 or wait?  v1 without it has a residual cross-server race; impact is "session destroyed" (the failure mode design intent anyway expects on KILL — clean QUIT is supposed to survive, so this matters).
