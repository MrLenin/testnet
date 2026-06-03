# Legacy BX P handler — graceful in-place conversion

**Status:** Design (not implemented)
**Author:** ibutsu
**Date:** 2026-06-02
**Depends on:** [[rpl-localusers-announced-count]] (the announced-count plan
defines the conversion case that triggers this).

## Motivation

The announced-count plan ([[rpl-localusers-announced-count]]) identified
that legacy peers (upstream evilnet/nefarious2 master, which only
implements the BX P subcommand from [`m_bouncer_transfer.c`](nefarious-upstream/ircd/m_bouncer_transfer.c))
silently drop BX C — so the **in-place conversion** of an N-introduced
client into an alias of an existing primary causes drift on legacy
peers:

1. `UserStats.clients` permanently inflated by 1 (no Q ever arrives).
2. Nick-hash table strands the now-stale numeric.

The original plan proposed dual-emitting a plain Q to legacy peers
alongside BX C to modern peers.  But Q has a user-visible side effect
on legacy: clients see the user `QUIT` (with whatever reason text we
choose), which is misleading — the user didn't actually leave the
network; they merged into an existing identity.

A cleaner alternative: use the **existing BX P swap path** in the
legacy handler, which already does the right thing for this case
without any user-visible QUIT.  This plan researches that, and
considers whether the upstream patch needs explicit extension or
whether the existing semantics already suffice.

## Investigation — current legacy BX P semantics

The legacy `ms_bouncer_transfer` ([m_bouncer_transfer.c:59-181](nefarious-upstream/ircd/m_bouncer_transfer.c#L59-L181))
processes only the `P` subcommand.  Wire format:

```
<server> BX P <old_numeric> <new_numeric> <sessid> <nick>
```

Two execution paths:

### Swap path ([lines 88-113](nefarious-upstream/ircd/m_bouncer_transfer.c#L88-L113))

Triggered when both `old_client` (parv[2]) and `new_client` (parv[3])
exist on this server.  Transfers channel memberships from old to new
(skipping channels new is already in), removes old from all channels,
and `exit_client`s old with the comment `"Bouncer transfer"` and
`FLAG_KILLED` set.

Net effect:
- `old_client` is killed — its socket exits cleanly via the standard
  IsUser exit path → `Count_clientdisconnects` (if local) /
  `Count_remoteclientquits` (if remote) → counter decrements,
  hash-table cleanup.
- `new_client` inherits any channels it wasn't already in (no-op
  for our case since alias and primary share channels by definition).
- A `QUIT` is emitted to common channels with the `"Bouncer transfer"`
  reason — but only to local users *who shared channels with old and
  not with new*, which for our case (alias→primary on the same
  account) is the empty set.  Other users don't see anything.

**This is exactly the semantic we want for the in-place conversion.**
Old (= the N-introduced client X) gets cleanly removed, new (= the
existing primary Y) inherits anything not already shared, and the
network-visible result on legacy is identical to "X seamlessly
merged into Y."  No user-visible QUIT to channel members.

### Numswap path ([lines 114-155](nefarious-upstream/ircd/m_bouncer_transfer.c#L114-L155))

Triggered when `old_client` exists but `new_client` doesn't.
Renumbers old's P10 numeric to new's numeric in place — same Client
struct, new numeric, same nick/channels/state.

This is the bouncer-transfer-promotion path (alias becoming primary
on a different server, where legacy doesn't know about the alias).
**Not what we want for in-place conversion** — that would just
rename X to Y's numeric, but Y exists as a separate entity.
Mercifully the numswap path requires `new_client` to NOT exist
(`!findNUser(parv[3])` check at line 130), so it's correctly
inhibited in our case.

## Proposal — modern dual-emits BX C to modern + BX P to legacy

For the in-place conversion path (the `bounce_alias_create` /
`bounce_setup_local_alias` conversion sites), modern servers should:

1. Emit `BX C` to BX-aware peers (modern), as today.
2. **Additionally** emit `BX P X Y sessid nick` to legacy peers,
   where X = the N-introduced numeric becoming alias, Y = the
   existing primary.

Legacy peers receive BX P, find both X and Y, hit the swap path,
clean up X cleanly.  Modern peers don't receive the BX P (so they
don't double-process — modern's own BX P handler is designed for
alias→primary promotion, which is a different operation).

**Why not just BX P universally?**  Modern peers' BX P handler
(in `bounce_handle_bxp`) interprets BX P as "alias→primary promote"
and runs `bounce_promote_alias` semantics.  That's the wrong
direction for our case (we're going N-introduced → alias, not
alias → primary).  Dual-emission with peer-class scoping is
required.

### Dispatch helper

The existing `sendcmdto_serv_butone` broadcasts to all peers.  We
need two new dispatch primitives:

```c
/* Send to peers that DO understand BX C (modern). */
void sendcmdto_bx_aware_serv_butone(...);

/* Send to peers that DON'T understand BX C (legacy — i.e. BX P
 * is their only bouncer subcommand). */
void sendcmdto_legacy_serv_butone(...);
```

Implementation hooks into the existing per-peer capability state
(server `prot` field in `struct Server`, or a dedicated flag set
during burst from the peer's `BURST` token capabilities).  A peer
is "BX-aware" if it advertises support for the modern bouncer
subset; otherwise legacy.

These helpers are also useful for any other dual-direction wire
shape we want in the future (e.g., MD-versus-MOTD-style backports).

### When to emit the dual BX P

At the in-place conversion sites:

| Site                                       | Modern wire (kept) | Legacy wire (new)              |
|--------------------------------------------|--------------------|--------------------------------|
| `bounce_setup_local_alias` ([bouncer_session.c](nefarious/ircd/bouncer_session.c)) | BX C | BX P X Y sessid nick |
| `bounce_alias_create` conversion branch ([bouncer_session.c:7496-7572](nefarious/ircd/bouncer_session.c#L7496-L7572)) | BX C (relayed) | BX P X Y sessid nick |

In both sites, the conversion is "the alias (X) is being absorbed
into the existing primary (Y)."  BX P semantics on legacy match
exactly.

For held-ghost destroy (the other case in the original plan), BX P
does NOT apply — the user is genuinely leaving the network there,
not merging.  Q is still the right legacy emission for ghost-destroy.

## Why this is better than Q-to-legacy

Comparing the two approaches at the in-place-conversion site:

| Dimension                                       | Q-to-legacy           | BX P-to-legacy        |
|-------------------------------------------------|-----------------------|-----------------------|
| Legacy `UserStats.clients` decrements           | Yes (via `Count_remoteclientquits`) | Yes (via `exit_client` in BX P swap) |
| Legacy hash-table cleanup                       | Yes                   | Yes                   |
| User-visible QUIT message on legacy             | **Yes** — channel users see QUIT | **No** — channel sets don't intersect |
| Reason text needs to be invented                | Yes ("Bouncer alias") | No (reuses "Bouncer transfer") |
| Wire-protocol semantics match the operation     | Loose — Q means "user left" | Tight — BX P means "this user is becoming that user" |
| Requires dispatch helper                        | Yes                   | Yes                   |
| Forward-compatible if a future legacy upgrade adds BX C | Indifferent  | **Yes** — the BX P handler signals intent that future upstream can build on |

BX P-to-legacy wins on user-visibility (no spurious QUIT messages
to legacy users) and on semantic clarity (the wire intent matches
the operation).  Both approaches need the dispatch helper, so
implementation cost is similar.

## Is an upstream patch extension actually needed?

**No, in the minimal version.**  The existing upstream BX P swap
path handles the in-place-conversion case correctly out of the
box.  The swap path:

- ✓ Removes the old numeric from the network (count decrements,
  hash entry clears).
- ✓ Doesn't produce a spurious user-visible QUIT (because the
  alias and primary share all channels).
- ✓ Has matching `cli_serv(server)->clients` decrement via the
  exit_client → Count_remoteclientquits path.

No upstream code changes needed.  The modern side does the dual
emission; legacy peers process the BX P with their existing
handler.

**Optional upstream cleanup** (separate PR if/when convenient):

- Add a comment block on `m_bouncer_transfer.c`'s BX P handler
  documenting the swap path's intended dual purpose — both
  "alias→primary promote" (the original intent) and "N-introduced
  client→alias of existing primary merge" (the new use case).
  Right now the comment only mentions promote.
- Consider adding a new explicit subcommand letter (e.g., `BX M`
  for "merge") so the intent is unambiguous on the wire.  This is
  a nicety, not a necessity — BX P's swap branch already does the
  right work.

## Migration

This work is dependent on [[rpl-localusers-announced-count]]
landing first (the announced-count fields and the BX C handler
decrement).  Once that's in:

**Commit 1.**  Add `sendcmdto_bx_aware_serv_butone` and
`sendcmdto_legacy_serv_butone` dispatch helpers.  Hook into the
per-peer capability detection.  No call sites yet; just the
plumbing.

**Commit 2.**  Update `bounce_setup_local_alias` to use the dual
emission: BX C to BX-aware, BX P to legacy.

**Commit 3.**  Update `bounce_alias_create` conversion branch
similarly.

**Commit 4** (optional).  Add the held-ghost destroy Q-to-legacy
emission for the case where merge semantics don't apply (the user
is genuinely leaving).  This still needs Q because there's no
"target primary" for a BX P swap.

**Commit 5** (optional, upstream).  Comment/documentation patch
to `m_bouncer_transfer.c` clarifying BX P's dual purpose.

## Testing

Integration test additions to `tests/src/ircv3/lusers-announced-count.test.ts`
(or a sibling file under the multi-server harness):

- 3-server topology: nefarious + nefarious2 (BX-aware) +
  nefarious-upstream (legacy).  Form a bouncer session with an
  alias.  Verify the in-place conversion lands cleanly:
  - Modern peers see BX C and decrement.
  - Legacy peer sees BX P and the swap path runs.
  - All three peers' `RPL_CURRENT_GLOBAL` converges to the same
    value.
- Held-ghost destroy across all three: still uses Q for the legacy
  peer (no merge target available).
- Cross-channel observer: legacy user shares a channel with both
  X and Y, watches for QUIT messages.  Expects NONE (since X and Y
  are the same identity from network POV).  Catches any future
  regression where the swap path starts emitting spurious QUITs.

## Open questions

- **Detecting BX-aware peers:** what's the canonical capability
  signal?  Burst-time advertisement, server-name pattern matching,
  or an explicit feature negotiation token in the BURST?  The
  existing modern-vs-legacy split in [[bouncer-architecture]]
  invariant 10 (`alias→primary rewrite on egress for non-BX-aware
  peers`) already implements this distinction somewhere — reuse
  the same predicate.

- **What if Y doesn't exist on legacy yet?**  Sequencing matters:
  modern emits BX C + BX P after the primary Y is already on the
  wire (via N).  If BX P arrives at legacy before N for Y (unusual
  but possible during burst), the swap-path's `new_client` lookup
  fails → falls through to numswap, which would renumber X to Y's
  numeric without Y existing.  That's wrong.  Mitigation: emit BX P
  AFTER ensuring N for Y has been broadcast in earlier wire
  ordering, or have the legacy handler defensively check for the
  N-token race (drop and re-queue).  Verify which is safer; lean
  toward the latter as a small upstream defensive fix.

- **Forward-compat with future upstream evolution:** if upstream
  eventually picks up BX C, the dual-emission becomes redundant
  for those peers.  Capability detection covers this automatically
  (peer is "BX-aware" → only gets BX C).  No deprecation churn.

## Not blocking

The announced-count plan is what's exposing the drift bugs and is
the priority.  This plan is the "make legacy peers stay in sync
cleanly" follow-up.  Land after [[rpl-localusers-announced-count]]
ships and we've observed the legacy drift in production for at
least one upgrade cycle, so the optimal upstream patch shape (if
any) is informed by real data.
