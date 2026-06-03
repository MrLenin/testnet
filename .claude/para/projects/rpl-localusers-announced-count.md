# RPL_LOCALUSERS — show N-announced count instead of socket count

**Status:** Design (not implemented)
**Author:** ibutsu
**Date:** 2026-06-02

## Motivation

`LUSERS` output currently includes three count lines that confuse
each other:

```
I have 8 clients and 1 servers                  ← RPL_LUSERME       (sockets)
Current local users: 8 Max: 676                 ← RPL_CURRENT_LOCAL (sockets)
Current global users: 308 Max: 785              ← RPL_CURRENT_GLOBAL (sockets, sort of)
```

The `RPL_LUSERME` line ("I have X clients") is correct as-is:
*clients* implies *connections*, so the socket count is the right
meaning.  But the `Current local/global users` lines should describe
the **network-visible user count** — what this server actually
announces to the rest of the network via N tokens — not the raw
socket count.

The two diverge in the bouncer subsystem on two axes.  Per the
bouncer architecture skill:

> Aliases are introduced via **BX C, not the N token** — other servers
> must never receive a Q token for an alias.

And per the held-ghost lifecycle ([bouncer_session.c:1804](nefarious/ircd/bouncer_session.c#L1804),
`BOUNCE_HOLDING` state): a primary connection that drops *keeps the
session N-announced* on the network — the ghost is still a visible
user on peer servers until either revived or destroyed.

So a bouncer session with one primary + three local aliases produces
**one** N-announce on the wire (the primary) but **four** socket
connections.  And a held ghost has **zero** sockets but **one**
N-announce.  Today, `RPL_CURRENT_LOCAL` shows the socket count via
`UserStats.local_clients`, getting both wrong.

The right three-way distinction:

| Entity          | `RPL_LUSERME` (sockets) | `RPL_CURRENT_LOCAL` (announced)      |
|-----------------|-------------------------|---------------------------------------|
| Vanilla user    | counted                 | counted                               |
| Bouncer primary | counted                 | counted (1 N-announce)                |
| Bouncer alias   | counted                 | **NOT** counted (BX C, not N)         |
| Held ghost      | **NOT** counted         | counted (still N-announced)           |

## Investigation — current accounting

### Counter source

`UserStats.local_clients` is bumped in two places:

1. `Count_unknownbecomesclient` ([querycmds.h:88-113](nefarious/include/querycmds.h#L88-L113))
   on every successful `register_user` — fires for primaries and
   local aliases alike.
2. `bounce_session.c:2921` — a separate increment in some bouncer
   path (alias attach? — verify during implementation).

It's decremented in `Count_clientdisconnects` and the alias-exit
branches in `exit_one_client`.  Per
[[project-bouncer-userstats-leak]] the two sides used to mismatch
on `bounce_copy_umodes`/`exit_one_client` paths; that fix is in the
working tree (uncommitted at time of writing).

Result today: `UserStats.local_clients` = socket count, including
aliases.

### Numeric format

[m_lusers.c:129-133](nefarious/ircd/m_lusers.c#L129-L133):

```c
send_reply(sptr, RPL_LUSERME, UserStats.local_clients,
                              UserStats.local_servers);
send_reply(sptr, RPL_CURRENT_LOCAL,  UserStats.local_clients,
                                     UserStats.local_clients_max);
send_reply(sptr, RPL_CURRENT_GLOBAL, UserStats.clients,
                                     UserStats.clients_max);
```

`RPL_LUSERME` correctly takes the socket count.  The other two need
new counters.

### Persistence

`UserStats.local_clients_max` and `UserStats.clients_max` are
written to the tunefile (`ircd.tune`) via `save_tunefile()` whenever
current exceeds historical max ([querycmds.h:96-101](nefarious/include/querycmds.h#L96-L101)).
This is how prod-test's 676 historical peak survived across reboots
(see [[project-prod-test-history]]).

### Cross-server propagation

P10 does **not** send aggregate count numbers over the wire — there
is no "here's my user count" message.  Instead, each server's view
of the global count is built locally by tallying inbound `N` and `Q`
tokens via [`Count_newremoteclient` / `Count_remoteclientquits`](nefarious/include/querycmds.h#L47-L60).
Each server also maintains a per-peer count in
`cli_serv(peer)->clients` ([struct.h:52](nefarious/include/struct.h#L52)),
incremented on every `N` received from that peer and decremented on
every `Q` from that peer.

This matters for our fix because **the wire mechanism is mostly
already correct**: aliases-introduced-fresh come via `BX C` (not
`N`), held ghosts are never `Q`'d while held, and
`bounce_promote_alias` handles `Q`-then-`N` correctly for
alias→primary on the wire.  Peers therefore compute the right
announced count for fresh aliases.

**But there's an in-place-conversion path that breaks the
symmetry.**  [bouncer_session.c:7441-7472](nefarious/ircd/bouncer_session.c#L7441-L7472)
handles the case where `BX C` arrives for a numeric that's already
known to this server as a normal `N`-introduced client (typical
shape: burst ordering put `N` before `BX C`, or a local-alias
setup completed and the corresponding `BX C` is now landing
network-wide).  The handler *converts the existing Client struct
into an alias in place* — sets `FLAG_BOUNCER_ALIAS`, copies
identity from the primary, etc. — **without emitting any `Q` on
the wire**.

Consequence:

- Every peer that previously received the original `N` for that
  numeric counted them.  Now the conversion happens — silently —
  and that peer's `UserStats.clients` is permanently inflated by
  one, because no `Q` ever arrives.  `cli_serv(alias_server)->clients`
  is similarly inflated.
- The same drift exists on every server in the network, not just
  the alias's host.  It accumulates over time as more aliases are
  formed via the conversion path.

**So the fix needs the BX C handler itself to decrement counters
on every server it lands on**, not just on us.  The hook:

```
in bounce_alias_create's "convert existing non-alias to alias" branch:
  if (!IsBouncerAlias(alias) /* was N-counted */) {
    --UserStats.announced_clients;
    if (MyConnect(alias))
      --UserStats.local_announced_clients;
    --(cli_serv(cli_user(alias)->server)->clients);
    /* mirror of Count_remoteclientquits, minus channel state */
  }
```

This runs symmetrically on every server processing the `BX C`
(BX is broadcast network-wide), so all peers reconcile their
announced count in lockstep.  No wire change — just the existing
`BX C` broadcast picking up bookkeeping duty on the way through.

For freshly-created remote aliases (the `make_client` /
`make_user` path at [bouncer_session.c:7475-7479](nefarious/ircd/bouncer_session.c#L7475-L7479)),
no decrement is needed — there was no prior `N` to undo.  The
counter just stays where it was.

The mirror property: **`UserStats.announced_clients` on every
server in the network converges to the same value** (modulo
in-flight propagation lag), because every event that changes the
count is broadcast either as `N` / `Q` (existing tokens) or `BX C`
(picks up the conversion-decrement above).  That's the value we
want to display in `RPL_CURRENT_GLOBAL` — anyone asking `LUSERS`
from anywhere on the net sees the same global figure.

Per-peer `cli_serv(peer)->clients` reconciles the same way — the
conversion-decrement hits the per-peer counter via the
`cli_user(alias)->server` pointer (which points at the alias's
host server post-conversion, but the count being decremented is
the one bumped by the original `N` — both point at the same
server in normal operation, since BX C arrives in-burst from the
same server that emitted the N).  Worth verifying during
implementation that this lines up; if `user->server` gets
rewritten before the decrement, the wrong per-peer counter
decrements.  Stash the original `user->server` before the
conversion if needed.

### Legacy-peer interop

Legacy peers (upstream evilnet/nefarious2 master, older
deployments) handle only `BX P` — they silently drop `BX C`,
`BX X`, `BX A`, every other modern bouncer subcommand.

**`bounce_promote_alias` is already legacy-correct.**
[bouncer_session.c:4631-4635](nefarious/ircd/bouncer_session.c#L4631-L4635)
emits `BX P` for the alias→primary transition, and legacy's
`BX P` handler does the in-place numeric swap (per
[[project-legacy-bx-p-handler]]).  Net count change on legacy: 0
(old primary numeric vacated, new primary numeric is the same
client identity).  Same net change on modern peers (where the
swap is handled via BX P's modern path).  No new work needed
here.

The breakage is on the other two transitions:

- **In-place conversion** (existing `N`-counted client becomes an
  alias of an existing primary): legacy received the original
  `N` for the now-alias numeric and counted the user.  `BX C`
  triggering the conversion is silently dropped, so legacy never
  knows the transition happened.  Result: legacy's
  `UserStats.clients` stays inflated by 1, AND its nick-hash
  table keeps the numeric pointing at the stale identity.  Both
  stay stranded indefinitely.
- **Held-ghost destroy** (any BX-flavored token emitted for the
  destroy event): same shape — legacy never decrements.

**Why not BX P for the conversion case?**  BX P semantically is
"identity at numeric A is now at numeric B" — an in-place swap.
For the conversion, the destination identity (the primary Y)
*already exists on legacy* — Y was N-introduced earlier and is
already counted.  A BX P from X to Y would either be rejected by
legacy as a collision or merge in a poorly-defined way; in any
case it's the wrong semantic.  Conversion is "X merges into
existing Y," not "X's identity moves to Y" — and merge has no
P10 representation outside `Q`.

So for these two specific cases, **emit a plain `Q` scoped to
legacy peers only** at the conversion / destroy sites.  Q is
universal P10 — legacy decrements correctly via
`Count_remoteclientquits`, clears the hash-table entry.  Modern
peers get only the BX event; the conversion-decrement handler
runs on them.

```
in conversion path:
  sendcmdto_bx_aware_serv_butone(..., CMD_BX, "C ...");   /* modern */
  sendcmdto_legacy_serv_butone(..., CMD_QUIT, "<reason>"); /* legacy */

in ghost-destroy path:
  sendcmdto_bx_aware_serv_butone(..., CMD_BX, "<destroy>"); /* modern */
  sendcmdto_legacy_serv_butone(..., CMD_QUIT, "<reason>");  /* legacy */
```

Implementation note: the dispatch helpers (`sendcmdto_bx_aware_*`
and `sendcmdto_legacy_*`) probably need to be added — verify
whether existing helpers (`sendcmdto_v3_serv_butone` ?) can be
reused with a peer-class filter.  The
[[project-legacy-bx-p-handler]] memo cautions against translating
BX P into Q+N specifically (that direction is wrong); this is the
opposite direction (BX C / destroy needs Q on legacy because BX C
is dropped) and should not conflict.

Summary table, where "legacy wire" is the addition required by
this plan:

| Transition                                          | Modern wire             | Legacy wire (today)    | Legacy wire (add) |
|-----------------------------------------------------|-------------------------|------------------------|-------------------|
| `bounce_promote_alias` (alias→primary)              | BX P                    | BX P (in-place swap)   | — already correct |
| N-introduced client converted to alias (BX C)       | BX C                    | (dropped — drift bug)  | Q                 |
| Held-ghost destroy (BOUNCE_DESTROYING)              | session-destroy wire    | (dropped — drift bug)  | Q                 |
| Alias destroy (BX X) — alias was never N'd to legacy | BX X                    | (dropped — no count to undo) | — no Q needed |

The fourth row is the consistency check: aliases that came in
via BX C alone were never visible to legacy (and would be
rewritten to primary on any egress per invariant 10), so
destroying them needs no legacy-side wire.  Only transitions
where legacy *had* an N-counted entry to undo need the Q.

## Proposal

Add two new counters that mirror `local_clients` / `clients` but count
**only N-announced users** (primaries, not bouncer aliases).  Use them
for `RPL_CURRENT_LOCAL` and `RPL_CURRENT_GLOBAL` — leave
`RPL_LUSERME` reading the existing socket-counting fields.

### State

```c
struct UserStatistics {
    /* ... existing fields ... */
    unsigned int local_announced_clients;       /* N-announced primaries on this server */
    unsigned int local_announced_clients_max;   /* historical peak, persisted */
    unsigned int announced_clients;             /* N-announced primaries network-wide */
    unsigned int announced_clients_max;         /* historical peak, persisted */
};
```

Cost: ~16 bytes of UserStatistics (four `unsigned int`).

### Bump/decrement points

The invariant: **announced count tracks "does this user have a
network-visible N-token right now."**  Sockets are a separate
question.

For `local_announced_clients`:

- **Bump:** `register_user` only when the client is **not** an alias
  (`!IsBouncerAlias(cptr)` at the end of registration).  Skip when
  `bounce_session.c` paths attach as alias.
- **Decrement:** in the primary→alias transition (when an existing
  primary becomes the alias of another session), and at session
  destroy (transition to `BOUNCE_DESTROYING` /
  [bouncer_session.c:758](nefarious/ircd/bouncer_session.c#L758)).
- **Bump:** `bounce_promote_alias` (alias→primary transition).

**No change on `BOUNCE_ACTIVE` → `BOUNCE_HOLDING`** ([bouncer_session.c:1804](nefarious/ircd/bouncer_session.c#L1804)).
The socket goes away (decrementing `local_clients`) but the
N-announce stays on the network, so the announced count stays.
Mirror: **no change on `BOUNCE_HOLDING` → `BOUNCE_ACTIVE` revive**
([bouncer_session.c:1689](nefarious/ircd/bouncer_session.c#L1689)) —
new socket appears (`local_clients` bumps) but the N-announce was
never gone.

This way, the announced count exactly tracks "does this user occupy
a slot on a peer server's user list right now."  A `LUSERS` from any
witness on the network would agree.

For `announced_clients` (the global view): mirror the above on every
local N-announce / N-receive / Q-receive that bumps `clients` today.
Specifically, the inbound N handler also needs the gate
(`if (!isalias_in_burst)` — verify the burst-time alias-introduction
path during implementation).

### Tunefile

Persist the two new `*_max` fields in `ircd.tune` next to the
existing `local_clients_max` and `clients_max`.  Existing fields stay
for backwards compatibility — they continue to track socket-count
high-water marks, which is still informative for capacity planning.

### Numeric emission

[m_lusers.c:132-133](nefarious/ircd/m_lusers.c#L132-L133):

```c
send_reply(sptr, RPL_CURRENT_LOCAL,  UserStats.local_announced_clients,
                                     UserStats.local_announced_clients_max);
send_reply(sptr, RPL_CURRENT_GLOBAL, UserStats.announced_clients,
                                     UserStats.announced_clients_max);
```

`RPL_LUSERME` ([line 129](nefarious/ircd/m_lusers.c#L129)) keeps
reading `UserStats.local_clients` — sockets are the right unit there.

## What this gives users

| Output line                             | Today                              | After                                              |
|-----------------------------------------|------------------------------------|----------------------------------------------------|
| `I have X clients`                      | 8 (sockets)                        | 8 (sockets) — unchanged                            |
| `Current local users: X Max: Y`         | 8 / 676 (sockets, sockets)         | network-visible user count (primaries + ghosts, excluding aliases); fresh Max accumulates from deploy |
| `Current global users: X Max: Y`        | 308 / 785 (asymmetric — local aliases counted, remote not) | network-visible global count, consistent across all servers |

The `Max` field on the new counters starts at zero on the first boot
after deploy and accumulates from there — historical peaks under the
old semantics are lost on the announced-count side.  That's fine:
the old `local_clients_max` (676 on prod-test) still represents the
historical socket peak, just isn't user-facing anymore.

## Migration

Two commits:

**1. Add counters + bump/decrement instrumentation.**
Add the four new `UserStatistics` fields, accessor macros, bumps and
decrements at the listed sites, tunefile persistence (saves and
restores).  Don't change `m_lusers.c` yet — the new counters
accumulate alongside the existing ones, divergence is visible via
debug logging.  Verify with bouncer-alias attach/promote scenarios
in the testnet that the counters track correctly.

**2. Switch numeric emission to new counters.**
Update `m_lusers.c` to read the announced counters for
`RPL_CURRENT_LOCAL` / `RPL_CURRENT_GLOBAL`.  `RPL_LUSERME` stays on
`local_clients`.

## Testing

### Integration (testnet)

New file: `tests/src/ircv3/lusers-announced-count.test.ts`.

Bouncer-alias case:
- Set up a bouncer session with one primary + 2 local aliases.
- Send `LUSERS` from a witness client.
- Assert `RPL_LUSERME` shows 4 sockets (3 bouncer + 1 witness).
- Assert `RPL_CURRENT_LOCAL` shows 2 announced users (primary +
  witness) and Max is at least 2.
- Cause one alias to be promoted to primary (disconnect the original
  primary).  Assert announced count stays at 2 (still one primary,
  just a different one).
- Cause the now-primary to spawn a fresh alias.  Assert announced
  count stays at 2.

Held-ghost case (the second axis):
- Set up a vanilla bouncer-class client (1 socket, 1 N-announce).
- Witness sends `LUSERS`: assert 2 sockets / 2 announced.
- Drop the client's socket (without normal `QUIT`).  Session
  transitions to `BOUNCE_HOLDING`.
- Witness sends `LUSERS` again: assert 1 socket / 2 announced.
  The ghost is still a real user on the network — peers haven't
  seen Q for it — so the announced count is unchanged from the
  drop.
- Within the hold window, reconnect a new client and revive the
  session.  `LUSERS`: 2 sockets / 2 announced — same as before
  the drop.
- Let the hold window expire (or force-destroy).  `LUSERS`:
  1 socket / 1 announced — the ghost finally counted down only
  when it was destroyed, not when its socket went away.

Non-bouncer regression:
- Vanilla client connects.  All three counts agree (no bouncer state
  divergence).

Multi-server (for `RPL_CURRENT_GLOBAL` and cross-peer convergence):
- 2-server topology, bouncer session with primary on server A and
  alias on server B.
- Fresh-alias case: BX C lands on B with no prior N for that
  numeric.  Each server's `LUSERS` should show 1 announced
  global user (just the primary).
- Conversion case (the more interesting one): start a regular user
  on B, then promote them into the session as an alias via a
  flow that causes BX C to arrive for an already-N-counted
  numeric.  Verify both A and B decrement their announced count
  to match.  Without the BX C handler decrement, B would stay at
  +1, A would stay at +1, and they'd disagree about the network
  size.
- Held-ghost across servers: primary on A drops while B has an
  alias.  `LUSERS` from A, B, and a witness C should all report
  the same announced count throughout the hold window and after
  hold-expiry destroy.

Cross-peer convergence assertion: after any sequence of bouncer
operations, the announced count reported by `LUSERS` on every
server in the test topology must be identical.  If any server
disagrees, the wire-reconcile is broken — fail loudly.

Legacy-peer interop assertion: 3-server topology with one server
running the unmodified upstream (nefarious-upstream submodule —
BX P only, no BX C/X/A understanding).  After the same bouncer
operation sequence, `LUSERS` on the legacy peer must agree with
the modern peers' announced count.  This catches missing Q
emissions on the conversion / destroy paths — without them, the
legacy peer's count would drift upward while modern peers stay
correct.

## Open questions

- **Bump-site audit:** the bouncer-session.c paths that attach
  aliases and promote them must be cross-referenced against the
  bump/decrement table above.  This is the highest-risk part of the
  change — getting it wrong means the counter drifts permanently
  (similar shape to [[project-bouncer-userstats-leak]]).

- **Held-ghost destroy emits Q:** verify that session destroy
  (`BOUNCE_DESTROYING` transition) emits a `Q` token on the wire so
  peers' `Count_remoteclientquits` fires and their announced count
  drops in lockstep with ours.  If destroy is silent on the wire,
  peers' counts would drift upward over time on every hold-window
  expiry — a separate bug worth catching here.

- **`cli_user(alias)->server` invariant at BX C decrement time:**
  the conversion-decrement hits the per-peer `cli_serv(server)->clients`
  via `cli_user(alias)->server`.  If the BX C handler rewrites
  `user->server` *before* the decrement runs, the wrong per-peer
  counter decrements.  Stash the original pointer at function
  entry if necessary.

- **Bidirectional convergence test:** the integration test should
  verify that *all* peers (not just our server) report the same
  global announced count after a sequence of alias-create,
  alias-conversion, alias-destroy events.  Without that
  cross-peer assertion, we'd only catch local drift, not
  network-wide drift.

- **Reset Max or preserve historical?** Default is "let the new Max
  start at 0 and grow naturally."  Alternative: at first boot after
  the tunefile format upgrade, initialise
  `local_announced_clients_max = local_clients_max` as a one-time
  estimate.  Cleanest is probably "fresh start" — but
  prod-test would lose ~676 of historical signal which it's been
  carrying for a while.

- **WHO/NAMES count consistency:** WHO and NAMES iterate the actual
  network state to count users, so they're already correct (counting
  primaries because aliases aren't on the wire for legacy-peer
  reachable WHO).  Sanity check this assumption during the
  testnet integration tests — if `WHO 0` shows a different number
  than `RPL_CURRENT_LOCAL` claims, our counter is wrong.

- **Tunefile schema compat:** adding fields to `ircd.tune` —
  verify save/restore handles missing fields gracefully so an
  upgrade from an older binary doesn't crash on tunefile read.

## Not blocking

Cosmetic accuracy fix.  Land alongside other bouncer-accounting
cleanups (the [[project-bouncer-userstats-leak]] fix is the natural
companion since both touch the same instrumentation paths) and
include in the next upstream-PR cycle.
