# Universal ghost presence

> **Status: deferred (2026-05-03).** The disconnect race that originally
> motivated this plan was fixed independently by commit `6129785`
> (always-hold on primary disconnect; promote only at hold expiry).
> The ideas in this plan are still worthwhile, but the motivation
> shifts: the real value is **chathistory federation during splits**
> (every peer can buffer messages locally for offline users without
> requiring a routable path to the origin).  When picked back up,
> reframe around that goal — race elimination is a side benefit, not
> the driver.

## Premise

Every IRCv3-aware bouncer-class server maintains a local `Client*` representing
each known active bouncer session.  The local Client's "role" (primary, alias,
or passive ghost) is **derived state** — a function of two facts that are
already authoritative elsewhere:

- Is this server the session's origin? (`session->hs_origin == cli_yxx(&me)`)
- Does this server hold a live socket for that user? (`cli_fd(client) >= 0`)

| Origin? | Live socket? | Role | Existing flags |
|---------|--------------|------|----------------|
| yes     | yes          | **primary**           | none             |
| yes     | no           | **ghost-as-primary**  | `IsBouncerHold`  |
| no      | yes          | **alias**             | `IsBouncerAlias` |
| no      | no           | **ghost-as-alias**    | `IsBouncerHold + IsBouncerAlias` (new combined state) |

The slogan: **"a connection to one bouncer-aware server is a connection to all."**
Every peer reflects the session locally, so message routing, channel
membership, and chathistory buffering have a Client to anchor to regardless
of where the user's socket physically terminates.

## Why we want this

The disconnect race we just patched (`6129785`) was a symptom of a deeper
asymmetry: today, alias-disconnect on server B emits a wire message
(`BX X`) that mutates session state on server A, and primary-disconnect
on server A makes routing decisions that depend on the existence of
that alias.  Two servers mutating shared state via crossed wire
messages → race.

Under universal ghost presence:
- Alias-disconnect is **single-server**: B flips its own Client from alias
  to ghost-as-alias.  No wire mutation of session state.
- Primary-disconnect is **single-server**: A flips its own Client from
  primary to ghost-as-primary.  No wire mutation of session state.
- Origin movement is the only cross-server state change.  It happens
  on a deliberate path (BX P), not as a side effect of disconnects.

The settle-window timer I was about to write becomes unnecessary: the race
it was meant to absorb cannot occur, because no two servers concurrently
mutate session state in response to disconnects.

It also generalizes the chathistory-during-splits intuition the user
already articulated.  If the link between A and B drops, B's
ghost-as-alias keeps buffering messages addressed to that user.  When
the link returns, the buffered messages replay.  No special "we're in
a split" mode is needed; the universal-ghost invariant already covers
it.

## Existing pieces this builds on

- **`IsBouncerHold` ghosts as Client structs** — already work as
  in-channel, in-nick-hash buffers.  After commit `6d652c9` (revert of
  the held-ghost-N-burst skip) they're visible to legacy peers too.
- **`IsBouncerAlias` separate Client structs** — one Client per real
  alias connection, already routes correctly.  Added recently as part
  of the multi-bouncer-aware framework.
- **`bounce_revive` socket transplant** — already does "real client
  occupies a ghost slot" when a user reconnects to the origin.
  Generalizes naturally: the same machinery should fire when a real
  client connects to a non-origin server (occupying its
  ghost-as-alias slot to become an alias).
- **`hs_aliases[]` per-session array** — origin already tracks which
  servers have real connections.  Stays.  The new model just changes
  *what triggers updates to it* (see "Wire protocol" below).

## What's missing

1. **Universal ghost materialization on burst.**  Today, when a peer
   receives `BS C` for a session whose primary is on a different server,
   it stores the session record but does not always materialize a local
   Client.  Under the new model, it always does.

2. **Disconnect generalization.**  `bounce_should_hold` currently has
   an `MyUser` gate that limits the hold path to clients on their
   *origin* server.  Under the new model, both primary-on-origin and
   alias-on-non-origin disconnects should leave a ghost behind on
   their local server.  The `IsBouncerAlias` early-out in
   `s_bsd.c:1628-1631` and `m_quit.c:118-119` (currently sending
   `BX X` and destroying the alias Client) becomes wrong.

3. **"I lost my socket" notification.**  Today, alias-disconnect emits
   `BX X` to tell the origin "the alias is gone, decrement
   `hs_alias_count`."  Under the new model the alias's Client is not
   destroyed (it becomes ghost-as-alias), but the origin still needs
   to know that B has no live socket — for promotion-candidate
   selection and connection counts.  New (or repurposed) notification
   needed.

4. **Promote as origin-pointer move only.**  `bounce_promote_alias`
   today does substantial in-place struct surgery: clears CHFL_ALIAS,
   adds to nick hash, transfers channel modes, adjusts user-counters.
   Under the new model, promote becomes mostly an origin-pointer
   change broadcast (`BX P`); each server independently re-derives its
   local Client's role from the new origin and the live-socket fact.

5. **`BX X` shrinks in scope.**  Today it's a multi-purpose
   silent-destroy for both aliases and held ghosts.  Under the new
   model, individual Client destroys aren't a wire event at all —
   they're a local consequence of session destroy (`BS X`) or session
   move.  `BX X` arguably retires entirely or becomes "destroy this
   session's Client locally" without cross-server semantics.

## Wire protocol changes

### Materialization on `BS C`

`BS C <account> <sessid> <token> <state> <last_active> <attach_count>
<connect_count> :<chanlist>` already arrives at peers when a session
is created or learned.  Today, a non-origin receiver creates the
`BouncerSession` record but does **not** create a Client struct unless
something else (an `N` token, a `BX C` alias create) drives it.

**Change:** the `BS C` receiver materializes a ghost-as-alias Client
struct using `make_client(NULL, STAT_USER)` with `IsBouncerHold` and
`IsBouncerAlias` both set.  The numeric is allocated locally
(receiver's YXX prefix + a fresh slot).  The nick is the session's
nick (taken from primary metadata in the `BS C` payload, or fetched
from chathistory/account state if not present).  Channel memberships
are NOT created here — they arrive via channel B burst with
`CHFL_HOLDING` already, same as today's held ghosts.

The receiver also does **not** emit anything in response.  This is a
pure local materialization triggered by burst replication.

### "Real connection lost" notification

When a real connection on a non-origin server disconnects (today: alias
goes away, BX X sent), the new behavior is:
- Local: `SetBouncerHold(client)`, keep CHFL_ALIAS on memberships,
  drop the socket fd, the Client is now ghost-as-alias.  No
  destruction.
- Wire: emit a notification to origin so it can update
  `hs_aliases[].ba_active` (or similar liveness flag) and recompute
  `hs_alias_count` for promote candidate purposes.

**Wire format option A** — repurpose `BS A` (currently "alias attach"):
```
BS A <account> <sessid> <numeric_or_">
```
where `>` (or some other sentinel) means "this server is now ghost-only;
my Client struct is still there but no real socket."  Origin
distinguishes the two by the sentinel.

**Wire format option B** — new `BS L` (lost-socket):
```
BS L <account> <sessid> <numeric>
```
Cleaner separation.  Existing `BS A` stays "I gained a real socket."

Recommend option B for clarity.  Cost: one new subcommand.

The reciprocal "I gained a real socket" path is unchanged: when a real
client connects to a server and finds a local ghost-as-alias, it
transplants the socket onto it (`bounce_revive` generalized) and
emits `BS A` to origin.  Origin updates its alias array.

### `BX P` (origin move)

Wire format unchanged.  Receiver semantics simplified:
- Update `session->hs_origin` to the new value.
- Re-derive every local Client's role.  In practice this means:
  - On the *old* origin: the primary Client becomes ghost-as-primary
    (if no live socket — usual disconnect path) or alias (if
    somehow still has live socket — edge case from cooperative
    roaming).
  - On the *new* origin: the alias Client becomes primary (drop
    `IsBouncerAlias`, add to nick hash if not already there).
  - On all *other* peers: their ghost-as-alias stays a ghost-as-alias;
    only the routing target shifts to the new origin.

Today's `BX P` does explicit channel-member surgery on the receiver.
Under the new model, the channel members are already correct because
each Client has its own memberships from burst — only the in-place
"who is the canonical primary" pointer changes.

### `BX X`

Becomes superfluous for individual Client teardown.  The two existing
producers:
- `exit_client` for `IsBouncerAlias || IsBouncerHold` — replaced by
  the new "real connection lost" notification (above) in the
  alias-disconnect case; replaced by no-op in the ghost-destroy case
  (because session-destroy via `BS X` is the only thing that destroys
  a ghost now).
- `bounce_destroy_yielded_ghost` (BX R loser yielding) — replaced by
  `BS X` on the loser's session record, which fans out to all peers
  who then locally destroy their Client.

Once both call sites move, `BX X` (the wire token) can be retired or
relegated to legacy compatibility shim.

### `BS X` (session destroy)

Already exists.  Becomes the **only** path to client struct
destruction under the new model.  When a session record is destroyed
on origin (hold expired with no aliases, BX R yield, etc.), `BS X`
fans out, and every peer destroys its local Client struct as part of
session cleanup.

## Disconnect path under the new model

```
local primary disconnects (origin server)
      ↓
SetBouncerHold(primary)   ← local-only flip, no wire emission
hs_state = HOLDING
start hold timer (FEAT_BOUNCER_SESSION_HOLD)
      ↓
[hold timer fires]
      ↓
hs_alias_count > 0 → emit BX P (origin move) to a chosen alias's
                       server.  No FLAG_KILLED, no exit_client on the
                       held primary — it becomes ghost-as-alias as a
                       consequence of origin moving away from us.
hs_alias_count == 0 → emit BS X (session destroy).  All peers
                       destroy their local Client.

local alias disconnects (non-origin server)
      ↓
SetBouncerHold(alias)    ← local-only flip, alias becomes ghost-as-alias
emit BS L <numeric> to origin
      ↓
origin: update hs_aliases[].ba_active = 0; recompute hs_alias_count

local ghost-as-alias disconnects: cannot happen (no live socket to
                                  begin with).

local ghost-as-primary expires (hold timer): described above under
                                              primary disconnect.
```

## Race elimination by construction

The two-clients-disconnect-simultaneously race we just hit:

```
A: primary disconnects
   - SetBouncerHold(A's Client) — A's primary becomes ghost-as-primary
   - start hold timer
   - no wire emission

B: alias disconnects
   - SetBouncerHold(B's Client) — B's alias becomes ghost-as-alias
   - emit BS L AAAAB to origin (= A)

[messages settle]

A receives BS L AAAAB:
   - hs_aliases[for B] marked inactive
   - hs_alias_count decrements

[hold timer eventually fires on A]
   - hs_alias_count == 0 (assuming no other aliases) → emit BS X
   - or > 0 → emit BX P to a survivor

No race.  Both servers mutate only their own local state in response
to local events.  The only cross-server mutation (`hs_aliases[]` on
origin) is driven by a single wire event from a single source.
```

## Memory cost

Today, a peer that's not the origin and has no real connection has
a `BouncerSession` record (~few hundred bytes) but no Client.  Under
the new model it also has a Client struct (~few hundred bytes) plus
its channel memberships.  Memory roughly doubles for inactive peers.

For a network with N bouncer-aware servers and S active bouncer
sessions, total Client structs grow from `S` (one per session at
origin) to `N × S` (every server has one for every session).
Channel memberships grow correspondingly.

For our testnet (3-4 IRCv3 servers, maybe a few hundred sessions),
this is rounding error.  For a production network with dozens of
servers and tens of thousands of sessions, it could matter.  The
`FEAT_BOUNCER_REPLICATE_GHOSTS` opt-out (default on for IRCv3 servers,
off for memory-constrained edges) is a reasonable escape hatch but
should not be needed for our deployment.

## Migration phases

### Phase 1 — Universal materialization on `BS C`
Smallest-blast-radius starting point.  After this, every IRCv3 server
has Client structs for every known session, but disconnect/promote
behavior is unchanged.

- Modify `bounce_session_create` (BS C handler) to allocate a local
  ghost-as-alias Client when none exists.
- Update channel B burst handling so the new ghosts get
  `CHFL_HOLDING` channel memberships matching the session's
  `hs_channels[]`.
- Verify no double-materialization: if a Client already exists
  (e.g. introduced via `N` from origin), the BS C path is a no-op.
- Verify no orphan: if BS C arrives before channel B for the
  ghost's channels, the ghost has no memberships until channel B
  arrives.  That's fine — channel B will add them.

Expected behavior after phase 1: legacy peers see the same world they
do today.  IRCv3 peers materialize more ghosts but use them only for
buffering (not yet for disconnect handling).

### Phase 2 — Disconnect → ghost generalization
Remove the `IsBouncerAlias` early-out paths in `s_bsd.c` and
`m_quit.c`.  Replace `BX X` emission on alias-disconnect with `BS L`
emission.  Drop `MyUser` gate in `bounce_should_hold`.

After this phase, primary and alias disconnects both leave a local
ghost behind.  The race condition is structurally impossible.

The settle-timer band-aid I was going to add does not get added —
this phase makes it unnecessary.

### Phase 3 — Promote as origin-move
Refactor `bounce_promote_alias` to a smaller function: emit `BX P`,
update `hs_origin`, rely on `BX P` receiver-side logic to flip every
peer's Client role.  Drop the explicit channel-member surgery.

Receiver-side `BX P` becomes a uniform "re-derive my Client's role
from the new origin" pass.  Same code on every peer (origin server,
new-primary's server, and uninvolved peers).

### Phase 4 — Retire `BX X` for client-level destroys
Both `exit_client` (alias/ghost) and `bounce_destroy_yielded_ghost`
stop emitting `BX X`.  Session-level `BS X` is the only client
destruction trigger.  `BX X` wire token can be removed entirely or
kept as a no-op for compatibility with mid-rolling-upgrade peers.

### Phase 5 — Cleanup
Remove now-unused fields and functions:
- `bounce_finish_live_primary_demote` (legacy-Q-on-demote) becomes
  redundant if `BX P` drives all primary changes.
- The "destroy yielded ghost" path simplifies to `BS X`.
- The `FLAG_KILLED`-gated-on-promote-success logic in
  `bounce_hold_expire` (added in `bb7ce43`) becomes obsolete because
  we no longer call `exit_client` on the held primary at promote time.

## Open questions

1. **Nick hash.**  Currently the held ghost is in the nick hash on
   its origin server.  Under the new model, every server has a
   ghost-as-alias Client for the same nick.  Only the **origin's**
   Client should be in the global nick hash; non-origin Clients are
   findable only by numeric.  Verify this matches existing alias
   behavior (aliases are not in nick hash) — yes, `hAddClient` is
   currently called only from `bounce_promote_alias` in the
   ghost-becomes-primary case, and `hRemClient` symmetrically.
   Ghost-as-alias on non-origin servers should NOT call `hAddClient`.
   Potential issue: nick lookup on a non-origin server for the
   purpose of routing /MSG by nick — does it find the ghost-as-alias
   Client struct, or fall through to find the origin's primary via
   the network?  Need to trace `whocmd` / `hash_find_client` paths
   to confirm correct behavior.

2. **Channel membership and `CHFL_ALIAS` vs `CHFL_HOLDING`.**
   Today, aliases hide from `NAMES` via `CHFL_ALIAS`.  Held ghosts
   appear in `NAMES` (because the ghost IS the user's only network
   presence during hold).  Under the new model, ghost-as-alias on a
   non-origin server is a per-server local representation of a user
   whose canonical presence is on origin.  Should it appear in
   `NAMES` queries on its local server?  If yes, multiple `NAMES`
   entries for the same user (one per server).  If no, hidden like
   `CHFL_ALIAS` — but then channel-member-count diverges from
   real-user-count by the number of servers, which might break
   `MODE +l` and similar.  Probably want `CHFL_HOLDING` on
   ghost-as-alias to keep them invisible in `NAMES` (mirroring
   alias behavior).

3. **Channel routing.**  When server B has a ghost-as-alias for
   user X, and a message is sent to a channel X is in, B's ghost
   receives it (just like today's held ghost).  But B's ghost is not
   the canonical user — origin's Client is.  Do we deliver
   to *both*?  Or does B's ghost suppress local delivery so only
   origin's Client receives?  Simplest answer: ghost-as-alias acts
   exactly like CHFL_ALIAS today — silent receiver for buffering
   purposes, no client-visible delivery.

4. **Legacy peers in the network.**  Production legacy
   (`m_bouncer_transfer.c` from upstream `feat/bouncer-transfer`)
   doesn't speak `BS C` or `BS L`.  Legacy stays on its current
   model: bursted N tokens for the canonical primary,
   numeric-swap on `BX P`.  IRCv3-aware servers maintain the
   universal-ghost invariant only among themselves; legacy peers
   see a flatter view.  This should "just work" because the
   IRCv3-aware servers' ghost machinery is internal — legacy never
   sees the extra Client structs (they're not bursted as `N`).

5. **MDBX persistence.**  Currently `bounce_db_restore` recreates
   ghost Clients only on the origin server (`MyUser`-ish gate).
   Under the new model, every IRCv3 server should restore ghosts
   from MDBX for every session it knows about (i.e., every session
   in its local MDBX store).  If a non-origin peer doesn't have the
   session in MDBX (because it was learned via burst, not persisted
   locally), restore on boot is empty — that's fine, the next
   `BS C` burst from origin will materialize it.

6. **Performance on burst.**  More Client allocations during burst.
   Profile if it becomes noticeable.  Current `bounce_db_restore`
   already does this work for the origin's view; adding it for
   non-origin sessions is a multiplier.

## Out of scope (for now)

- Replacing `BX X` semantics in the legacy compat shim.  Production
  legacy keeps its `BX P` numeric-swap behavior; we don't touch it.
- Cross-net federation of universal ghosts (e.g., between independent
  Afternet instances).  This is a single-network design.
- Persisted ghost-as-alias on non-origin servers via MDBX.  Phase 5
  cleanup territory; only matters for survival across restart of
  non-origin peers.

## Validation tests to write before merge

- Two-client simultaneous disconnect race (the bug that prompted this
  plan).  Should result in clean session state, no protocol
  violations, no channel-membership loss.
- Reconnect within hold window: revive on origin works, alias
  pickup on non-origin works (formerly "alias creates by attach";
  under new model, "ghost-as-alias revives via socket transplant").
- Origin migration: explicit roaming via `BX C` continues to work,
  produces correct origin-pointer state on every peer.
- Hold expiry with aliases on multiple servers: promote picks one,
  others smoothly become ghost-as-alias of the new origin.
- Hold expiry with no aliases: session destroy fans out via `BS X`,
  every peer cleans up its local Client.
- Legacy peer in topology: legacy view stays consistent throughout
  the above scenarios (numeric swap on `BX P`, no phantoms).

## Estimated diff size

Phase 1: ~150 lines (BS C handler + helpers).
Phase 2: ~100 lines (s_bsd.c + m_quit.c shortcuts removed; new BS L
         emission/handler; bounce_should_hold gate relaxed).
Phase 3: ~200 lines (bounce_promote_alias refactor + BX P receiver
         simplification; net delete).
Phase 4: ~50 lines deleted (BX X call sites stop emitting).
Phase 5: variable — depends on how much pre-existing legacy-Q
         machinery becomes dead code.

Total: maybe net-zero or slight negative LOC, with substantially
simpler invariants.
