# Bouncer ghost-to-primary revive on burst (no QUIT/JOIN)

**Status:** Implemented (needs test)
**Author:** ibutsu
**Date:** 2026-04-30

## Problem

When a leaf restores a bouncer-session ghost from MDBX at startup and
later links to a hub that has the same session as ACTIVE with a live
primary client, the leaf's standard P10 nick-collision path kills both
the ghost and the incoming primary because they share `user@host`. See
[project_bouncer_burst_desync.md](memory/project_bouncer_burst_desync.md)
for the observed log timeline.

The collision logic at
[m_nick.c:391-470](nefarious/ircd/m_nick.c#L391-L470) does the right
thing for *unrelated* clients with the same nick. It does the wrong
thing for a bouncer ghost colliding with its own session's live
primary — those aren't independent clients, they're one logical user
in two representational states.

## Approach: rekey the ghost in place on N introduction

Detect the ghost-vs-primary-of-same-session case at the top of the
collision logic, before any kill is queued. Rebind the ghost's
existing Client struct to the incoming primary's numeric and live
state, preserving channel memberships and (importantly) emitting no
QUIT and no JOIN. The ghost was always the user; the leaf just rebinds
its representation.

## Detection

At [m_nick.c:391](nefarious/ircd/m_nick.c#L391), after `acptr =
SeekClient(nick)` finds a client and before the collision logic kicks
in:

- `IsServer(sptr)` (the incoming N is from a server, not a local
  nick-change collision)
- `IsBouncerHold(acptr)` (acptr is a held ghost on this server)
- The incoming N's account name (parsed from parv[7] after umode)
  matches `cli_user(acptr)->account`

When all three hold, branch into the revive path instead of the
collision path.

## Rebind primitive

New function in `bouncer_session.c`:

```c
int bounce_rebind_ghost_to_remote_primary(struct Client *ghost,
                                           struct Client *server,
                                           const char *new_numeric,
                                           time_t new_lastnick,
                                           /* + other N params */);
```

Steps:

1. Find the bouncer session for ghost (via account lookup).
2. `hRemClient(ghost)` — remove from nick hash (we'll re-add fresh).
3. `RemoveYXXClient(cli_user(ghost)->server, cli_yxx(ghost))` —
   release the ghost's local numeric.
4. Update ghost's fields from N parameters:
   - `cli_user(ghost)->server = server` (the remote hub)
   - `SetRemoteNumNick(ghost, new_numeric)` (BjAAA)
   - `cli_lastnick(ghost) = new_lastnick`
   - Update IP, host, umodes if they came in different
5. `ClearFlag(ghost, FLAG_BOUNCERHOLD)` — no longer holding.
6. `hAddClient(ghost)` — re-register in nick hash with same nick.
7. `session->hs_client = ghost` — session points to live ghost.
8. `session->hs_state = BOUNCE_ACTIVE` if it was HOLDING.

Channel memberships are untouched — the ghost stays in every channel
it was in, with the same modes, same join_msgid, etc. Local clients
who were already seeing the ghost in their channels simply continue to
see it — no JOIN echo needed because membership didn't change.

## What about the BS C / BS A / BX C that follow?

After the rebind, BS C arrives saying "active session Bj-2". Session
state on leaf is already BOUNCE_ACTIVE (we set it). BS C handler for
an existing active session is a no-op or refresh.

BS A says "AAA attach". Mostly tracking metadata, doesn't depend on
the rebind specifically.

BX C says "BjAAA primary, BjAAB alias". Now `findNUser(BjAAA)` returns
the rebound ghost. The alias create proceeds normally. **This is the
specific failure case from the trace** — BX C "primary BjAAA not
found" — that gets fixed by the rebind.

## What about subsequent burst events?

Channel BURST (B token) for channels the ghost is on: since we kept
the ghost's channel memberships, the leaf's view already has them.
The B token is a syncing operation; if state matches, no-op. If the
hub's view differs (e.g. modes added since the disconnect), B
reconciles.

EOB (end of burst): nothing special.

## Edge cases

1. **Different nick on hub vs ghost.** Hub introduces N for the
   primary with a *different* nick than what the leaf's ghost has
   (e.g. ghost was "ibutsu" but hub now has "ibutsu_"). This shouldn't
   happen for a session revive — same account → same nick — but if it
   does, fall through to existing collision logic. The detection
   keys on nick-match in the SeekClient path, so different nicks
   wouldn't even trigger the rebind.

2. **Different account.** SeekClient returns a ghost with account
   "alice", incoming N has account "bob". Different users, real
   collision — fall through to existing collision logic.

3. **Multiple ghosts for same account.** Shouldn't happen — one
   session per (account, sessid). If somehow it does, rebind the
   first match.

4. **Ghost has aliases (locally).** Local aliases of the ghost (if
   any) need their `alias_primary` pointer updated to the rebound
   ghost. Walk the alias list and update — same numeric pattern as
   bounce_promote_alias.

5. **No matching session found for ghost.** Bug state — log a warning
   and fall through to collision path. Better to lose the rebind
   optimization than to corrupt state.

6. **Hub's primary numeric collides with another local numeric on
   leaf.** RemoveYXXClient + SetRemoteNumNick handle the numeric
   reassignment; if the new numeric is already taken, that's a real
   collision unrelated to the rebind and should fail loudly.

## What we don't do

- **No KILL emit.** The ghost stays alive, just rebound. No QUIT to
  channels.
- **No JOIN emit.** Channel state preserved.
- **No N forward to other servers.** The leaf is just learning about
  the primary; other servers learned about it through their own N
  handlers (or already had it).
- **No BX P emit.** The ghost's old numeric was local-only (assigned
  by `SetLocalNumNick` during `bounce_create_ghost`'s MDBX restore),
  never propagated. No other server has that numeric in its
  nick↔numeric map, so there's no swap to announce. BX P is for
  cross-server alias↔primary promotions and is unaffected by this
  revive path. Future BX P from hub post-rebind continues to work
  via the existing handler.

## Legacy peer compatibility

The rebind is **wire-level invisible to legacy peers** — no S2S
messages emitted as part of it, only local state mutation
(hash-table re-key, numeric assignment, flag clear). Legacy peers
don't see any side effects.

The detection gates are specific enough to avoid false positives on
legacy traffic:

- `IsBouncerHold(acptr)` requires FLAG_BOUNCERHOLD on the local
  client struct. Only set by `bounce_create_ghost()` on MDBX-restored
  ghosts. Normal users from legacy peers never have this flag.
- Account name match. Legacy nefarious does propagate AC tokens, so
  account names cross legacy hops. If the incoming N has the same
  account as our ghost, by definition it IS the same logical user
  (services-authenticated, account names unique per network).
- If a legacy peer doesn't propagate account on N (absent or `"*"`),
  the match fails and we fall through to the unchanged collision
  logic. No regression.

Cases involving legacy peers:

| Scenario | Rebind triggers? | Behaviour |
|---|---|---|
| Legacy user from legacy peer, unrelated nick collision with our ghost | No (account differs / absent) | Existing collision logic — unchanged |
| Legacy peer N-introduces our held user (account match) | Yes | Ghost rebinds to peer's numeric. Same as IRCV3-aware case. |
| Legacy peer N-introduces a non-bouncer user, no ghost on us | No (no IsBouncerHold) | Normal N handling — unchanged |
| Legacy peer N for a nick we have as a normal live user | No (acptr is not BouncerHold) | Existing collision logic — unchanged |

Timestamp note: today's collision logic compares `lastnick` and uses
`user@host` differ to decide who lives. The rebind ignores both —
bouncer ghost and primary share user@host (so legacy collision logic
would kill both today), and lastnick comparison is meaningless when
they're the same logical user. The rebind path is taken before any
of that analysis runs.

## Testing plan

- 2-server testnet:
  1. Connect ibutsu to leaf (creates session, leaf holds primary).
  2. Disconnect from leaf (session → HOLDING, leaf holds ghost).
  3. Restart leaf. Leaf restores ghost from MDBX.
  4. Reconnect ibutsu to hub (creates new session activated; hub has
     live primary).
  5. Hub→leaf burst. Without this fix: collision kills both, channels
     vanish. With this fix: ghost rebinds, channels preserved.
- Check no QUIT visible to other channel members during step 5.
- Check `findNUser(primary_numeric)` resolves on leaf after burst.
- Check `BX C` for any aliases of that primary succeeds.

## Out of scope

- Cleaning up the legacy collision logic — leave it as-is for
  non-bouncer collisions.
- Pre-emptive ghost-cleanup on BS C — the rebind on N is more direct
  and avoids a state where the session is "active" but the primary
  client doesn't exist yet.

## Implementation notes (2026-04-30)

- New primitive `bounce_rebind_ghost_to_remote_primary()` in
  [bouncer_session.c](nefarious/ircd/bouncer_session.c) — declared in
  [bouncer_session.h](nefarious/include/bouncer_session.h).
- Detection inserted at [m_nick.c:407](nefarious/ircd/m_nick.c#L407),
  immediately after `assert(acptr != sptr)` and before the IsUnknown
  branch.
- Account name extracted from N umode params by walking the +mode flag
  string in `parv[6]` and consuming one arg per arg-taking flag (r, h,
  f, C, c — fixed order matches `umode_str()` output).
- `hs_origin` is intentionally **not** updated on rebind — that
  bookkeeping is owned by the session-ownership transition path
  (auto-resume / BX P), not by the leaf-side representation rebind.
- Connection ownership: ghost's own `Connection` is freed
  (`free_connection`) and replaced with `cli_connect(server)` so
  outbound routing goes through the server link.
- UserStats counter rebalance: `--local_clients`, `++cli_serv(server)
  ->clients`. `clients` total stays the same.
