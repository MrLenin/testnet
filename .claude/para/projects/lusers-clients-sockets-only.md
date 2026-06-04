# RPL_LUSERME — count live sockets only (drop held ghosts)

**Status:** Design (not implemented)
**Author:** ibutsu
**Date:** 2026-06-04
**Depends on:** [[rpl-localusers-announced-count]] (the announced counters
ship the user-facing line; this plan corrects the *clients* line).

## Motivation

After the announced-count fix shipped on prod-test, `LUSERS` shows:

```
I have 7 clients and 1 servers       <- UserStats.local_clients (sockets)
Current local users: 7 Max: 8        <- UserStats.local_announced_clients
```

And the matching `STATS L` output:

```
Thunderbird.US.Hub  (server)
vibebot
ibutsu_
Rubin
d0nk`                                 <- 4 visible local clients + 1 server
```

`STATS L` iterates `LocalClientArray` keyed on fd, so held ghosts
(`cli_fd == -1`) don't appear there.  But `local_clients` does count
them, so the line `I have 7 clients` is off by 3 against the 4
actually-connected sockets.

The user's stated principle:
> "clients should show real connections, users should show announced users"

`RPL_LUSERME` is the *clients* line.  It needs to read a counter that
tracks live TCP sockets only — no ghosts.

## Investigation — where ghost-counting happens today

### Three contributing sites

1. **`bounce_create_ghost` at boot-time MDBX restore**
   ([bouncer_session.c:2921-2931](nefarious/ircd/bouncer_session.c#L2921-L2931))
   bumps `local_clients`, `clients`, `local_announced_clients`,
   `announced_clients` for the synthetic ghost.  The ghost has no fd,
   so the socket-side bumps are wrong for LUSERME.  The announced-side
   bumps are correct (the ghost will be N-burst to peers).

2. **`bounce_hold_client` — primary's socket disconnect**
   ([bouncer_session.c:4953-5003](nefarious/ircd/bouncer_session.c#L4953-L5003))
   sets `BouncerHold` and calls `close_connection(cptr)` but does
   **not** decrement `local_clients` / `clients`.  The original
   register-time bump from `Count_unknownbecomesclient` persists
   through the entire ghost lifetime.

3. **`s_misc.c` IsBouncerHold branch — reconcile/destroy paths**
   ([s_misc.c:407-447](nefarious/ircd/s_misc.c#L407-L447)) calls
   `Count_clientdisconnects` which decrements all four counters at
   destroy time.  Today this balances the register-time +1 of
   `local_clients` (the ghost stayed counted; destroy removes the
   count).  In the new scheme — where the hold transition already
   decremented `local_clients` — this would double-decrement.

### What gets called on which path

| Lifecycle event                      | Today: local_clients | Today: announced |
|--------------------------------------|---------------------|------------------|
| Primary registers (register_user)    | +1                  | +1               |
| Primary's socket closes → hold       | 0 (kept)            | 0 (kept, still N-visible) |
| Held ghost revived (new socket)      | 0                   | 0                |
| Held ghost destroyed (hold expire)   | -1 (via Count_clientdisconnects on ClearBouncerHold + IsUser exit) | -1 |
| Boot ghost spawn (from MDBX)         | +1 (synthetic bump) | +1 (synthetic bump) |

Net at end of session: 0 in both counters.  But during the
ghost-period rows in the middle, `local_clients` is +1 even though
there's no socket.  That's the visible bug.

## Proposal — `local_clients` / `clients` mean *live TCP sockets only*

Change the meaning of `local_clients` and `clients` so the counter
tracks live sockets, not "Client structs that exist."  The announced
counters already track network-visible identities (per
[[rpl-localusers-announced-count]]), which covers what ghosts
*are*.  So between `local_clients` and `local_announced_clients`, we
correctly express: this many sockets, this many network-visible users
— and they legitimately disagree when ghosts/aliases are around.

### Bookkeeping changes — by site

| Lifecycle event                      | New: local_clients | New: announced |
|--------------------------------------|--------------------|----------------|
| Primary registers                    | +1                 | +1             |
| Primary's socket closes → hold       | **-1 (NEW: add in `bounce_hold_client`)** | 0 (unchanged) |
| Ghost revived (new socket attaches)  | **+1 (NEW: add in `bounce_revive`)** | 0 |
| Held ghost destroyed                 | 0 (was already 0; skip the local_clients side in `Count_clientdisconnects`) | -1 |
| Boot ghost spawn                     | **0 (NEW: drop the bump)** | +1 (unchanged) |

### Implementation sketch

**Site 1: `bounce_create_ghost`** ([bouncer_session.c:2921-2931](nefarious/ircd/bouncer_session.c#L2921-L2931))

Drop the `++UserStats.local_clients` and `++UserStats.clients` bumps
(and the corresponding `_max` saves).  Keep the announced-side bumps
unchanged — the ghost is still N-visible.

**Site 2: `bounce_hold_client`** ([bouncer_session.c:4953+](nefarious/ircd/bouncer_session.c#L4953))

After `close_connection(cptr)` (line 5003), add:

```c
/* Decrement socket-side counters — the TCP connection is gone.
 * Announced counters stay; the user is still N-visible on the
 * network as a held ghost. */
if (UserStats.local_clients > 0) --UserStats.local_clients;
if (UserStats.clients > 0) --UserStats.clients;
```

**Site 3: `bounce_revive`** (around [bouncer_session.c:5325+](nefarious/ircd/bouncer_session.c#L5325))

After the socket transplant (Step 6a-7), add the bumps:

```c
/* Socket-side counters: ghost gained a live TCP connection.
 * Announced counters stay; the user is already N-visible. */
++UserStats.local_clients;
++UserStats.clients;
if (UserStats.local_clients > UserStats.local_clients_max) {
  UserStats.local_clients_max = UserStats.local_clients;
  save_tunefile();
}
if (UserStats.clients > UserStats.clients_max) {
  UserStats.clients_max = UserStats.clients;
  save_tunefile();
}
```

**Site 4: ghost destroy via `Count_clientdisconnects`**

Today `Count_clientdisconnects` decrements *all four* counters (with
the existing `!IsBouncerAlias` gate on the announced side).  With the
new scheme, the local_clients side has already been zeroed by the
hold transition (or never bumped for boot ghosts).  Two routes to
fix:

A. **Skip local_clients decrement at the ghost-exit sites** by
   inlining a different decrement call in the `IsBouncerHold` branch
   of `exit_one_client` ([s_misc.c:407+](nefarious/ircd/s_misc.c#L407))
   and in the normal-path ghost destroy (where `ClearBouncerHold`
   runs just before `exit_client` — those go through the regular
   `IsUser` exit branch which calls `Count_clientdisconnects`).

B. **Have the macro consult `cli_fd(cptr) < 0` as a gate** for the
   local_clients/clients decrement: if no fd, no socket was
   contributing, no decrement.  Cleaner — one place to enforce the
   invariant.

**Recommendation: (B).**  The fd check is a natural property of "is
this Client backed by a live socket right now?" and applies
universally — including any future ghost-like code paths we haven't
thought of.  The macro becomes:

```c
#define Count_clientdisconnects(cptr, UserStats) \
  do \
  { \
    if (cli_fd(cptr) >= 0) { \
      --UserStats.local_clients; --UserStats.clients; \
    } \
    if (!IsBouncerAlias(cptr)) { \
      --UserStats.local_announced_clients; \
      --UserStats.announced_clients; \
    } \
    if (cli_fd(cptr) >= 0 \
        && match(feature_str(FEAT_DOMAINNAME), cli_sockhost(cptr)) == 0) \
      --current_load.local_count; \
  } while(0)
```

The `current_load.local_count` site gets the same `cli_fd >= 0` gate
because that counter is also a socket-side tally.

### What `Count_unknownbecomesclient` needs

No change needed — when a client transitions from STAT_UNKNOWN to
STAT_USER, they have a live socket (otherwise the transition
wouldn't be happening through that macro).  The bump correctly counts
their socket.

### `Count_newremoteclient` / `Count_remoteclientquits`

No change needed — these fire on N / Q wire events from remote
peers, which by construction count network-visible users (the
announced semantic).  Today these also bump `UserStats.clients`
unconditionally; with the new scheme that's still right because
N-receipt means a real user appears on the network and *some* server
has a live socket for them (just not us).

But wait — there's a subtle issue.  `UserStats.clients` is meant to
be "live network users with sockets" if we follow the
`local_clients = live sockets` logic globally.  Ghosts on remote
servers don't have sockets either.  Should `clients` count them?

Two interpretations:
- **`clients` = sum of local_clients across the network** (live
  sockets globally).  Then remote ghosts shouldn't bump `clients`
  either.  But we don't have a wire signal for "remote ghost
  spawned" — the burst N is what we count, and that's emitted for
  ghosts too.
- **`clients` = "total registered users" (anyone with a Client
  struct on any server)**.  This matches today's behaviour and is
  what RPL_LUSERCLIENT (numeric 251 "There are X users") historically
  meant.

Lean toward keeping `clients` semantics as today (global headcount),
with `local_clients` becoming socket-only.  RPL_LUSERME is *our*
clients — that's the socket-only one.  RPL_LUSERCLIENT is the
network-wide one and stays as it was.

Concretely: only `local_clients` semantics change.  `clients` stays
counting all registered users including held-ghost-state ones, same
as today.  The hold/revive transition only touches `local_clients`,
not `clients`.

### Updated implementation sketch (corrected)

| Lifecycle event                      | local_clients | clients | local_announced | announced |
|--------------------------------------|---------------|---------|-----------------|-----------|
| Primary registers                    | +1            | +1      | +1              | +1        |
| Primary's socket closes → hold       | -1            | 0       | 0               | 0         |
| Ghost revived (new socket attaches)  | +1            | 0       | 0               | 0         |
| Held ghost destroyed                 | 0             | -1      | -1              | -1        |
| Boot ghost spawn                     | 0             | +1      | +1              | +1        |
| Remote N received                    | 0             | +1      | 0               | +1        |
| Remote Q received                    | 0             | -1      | 0               | -1        |

`local_clients` is purely socket-side; `clients` stays at "all
registered users known to this server."  Net session lifecycle (for
the local primary case): +1 register, -1 hold, +1 revive, -1 destroy
= 0 for `local_clients`.  And +1 register, -1 destroy = 0 for
`clients`.  Consistent.

### Macro variant

Given the local_clients vs clients asymmetry above, the macro fix
is:

```c
#define Count_clientdisconnects(cptr, UserStats) \
  do \
  { \
    /* clients always: every registered user that disconnects */ \
    --UserStats.clients; \
    /* local_clients only when socket existed: ghosts already \
     * zero'd via bounce_hold_client */ \
    if (cli_fd(cptr) >= 0) \
      --UserStats.local_clients; \
    if (!IsBouncerAlias(cptr)) { \
      --UserStats.local_announced_clients; \
      --UserStats.announced_clients; \
    } \
    if (cli_fd(cptr) >= 0 \
        && match(feature_str(FEAT_DOMAINNAME), cli_sockhost(cptr)) == 0) \
      --current_load.local_count; \
  } while(0)
```

Same for the boot-ghost-spawn change: `bounce_create_ghost` keeps
the `clients` bump (registered user, network-visible) and drops only
the `local_clients` bump.

## Memory model

No new fields.  All work is bookkeeping adjustments to existing
counters.

## Migration

Three commits, each independently reversible:

**1. Macro update + boot-ghost socket-side drop.**
Gate `local_clients` / `current_load.local_count` decrements in
`Count_clientdisconnects` on `cli_fd >= 0`.  Drop the
`++UserStats.local_clients` bump in `bounce_create_ghost` (keep
`clients` + announced bumps).  This commit alone is a no-op for
the common case (live sockets all have fd >= 0) but stops the
boot-time over-count.

**2. Hold transition decrement.**
Add `--UserStats.local_clients` after `close_connection(cptr)` in
`bounce_hold_client`.  Now primary→ghost correctly drops the socket
count.

**3. Revive bump.**
Add `++UserStats.local_clients` after the Step 6a-7 socket transplant
in `bounce_revive`.  Symmetric to commit 2.  After this, the
end-to-end accounting for a primary's lifecycle is correct.

## Testing

### Integration (testnet)

New file: `tests/src/ircv3/lusers-clients-sockets-only.test.ts`.

- **Primary disconnects to hold**: LUSERME drops by 1; announced
  unchanged.
  - Create bouncer-enabled client, enable hold.
  - Drop socket without QUIT.
  - LUSERS from witness: clients -1, users unchanged.
- **Primary revives**: LUSERME bumps by 1; announced unchanged.
  - From the above state, reconnect.
  - LUSERS: clients +1, users unchanged.
- **Held ghost destroyed**: LUSERME unchanged; announced -1.
  - From the dropped-to-hold state, let the hold expire (or force
    destroy via the bouncer disable path).
  - LUSERS: clients unchanged (ghost wasn't counted), users -1.
- **Boot ghost from MDBX**: LUSERME unchanged before/after a
  forced container restart with the session persisted; announced
  +1.
  - Persist a session, restart container, witness LUSERS post-boot.

### Regression

Run the existing announced-count tests
(`tests/src/ircv3/lusers-announced-count.test.ts`) — the announced
counter behaviour is unchanged by this work.

Run `tests/src/ircv3/bouncer-alias-promote.test.ts` and any other
bouncer lifecycle tests that might implicitly read local_clients or
clients.  These should not change behaviour for live-socket cases
(the change only affects ghost/socketless cases).

## Open questions

- **Underflow protection at `bounce_hold_client`'s new decrement**:
  current code uses `if (UserStats.local_clients > 0) --...` style
  in a few places.  Use the same pattern for safety against any
  startup edge case where the counter might be 0.
- **STATS u (per-server stats) reading clients**: verify
  `RPL_STATSCONN` and similar use `UserStats` fields and behave
  correctly with the new semantics.  Likely no change needed.
- **`max_client_count` / `max_connection_count`**: these track
  highest live-connection peaks.  Already tied to live sockets via
  the bump site at `Count_unknownbecomesclient`.  Verify the revive
  bump also updates them so the peak is accurate.

## Not blocking

Cosmetic accuracy fix for LUSERME on bouncer-heavy servers.  Land
alongside the deferred bouncer cleanup work; pairs naturally with
the upcoming oper-SIGKILL persistence fix
([[oper-persistence-sigkill-fix]] — `m_oper.c:285` should call
`bounce_mark_dirty(sptr)` instead of flipping `hs_dirty = 1` directly).
