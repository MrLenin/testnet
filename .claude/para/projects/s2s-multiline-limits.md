# S2S multiline limits enforcement

**Status:** Investigation / planning
**Author:** ibutsu
**Date:** 2026-04-29
**Depends on:** existing ML burst command (no new deps)

## Problem

The ML burst command at
[s_serv.c:224-235](nefarious/ircd/s_serv.c#L224-L235) advertises
`max-bytes` and `max-lines` per server during burst, propagating
network-wide so every server learns every multiline-capable peer's
limits ([m_batch.c:1860-1862](nefarious/ircd/m_batch.c#L1860-L1862)
stores them on `cli_serv(sptr)->ml_max_bytes`/`ml_max_lines`).

But nothing reads those values to make any policy decision. They sit
unused. We have the data; we never wrote the consumer.

This plan defines the consumer: enforce locally-originated multilines
against this server's `FEAT_MULTILINE_MAX_BYTES`/`FEAT_MULTILINE_MAX_LINES`
(local admin policy), but size receive buffers to handle the network
maximum so cross-server multilines from larger-limit servers can always
arrive and be displayed locally.

## Approach: send-local-enforce, receive-network-max

```
Server A: max-bytes=8192,  max-lines=200
Server B: max-bytes=16384, max-lines=100
Server C: max-bytes=4096,  max-lines=400
```

| Path | Limit |
|---|---|
| Local user submits multiline on A | `FEAT_MULTILINE_MAX_BYTES` for A (8192) |
| CAP advertised to local clients on A | A's local limits |
| Local user on C submits multiline | `FEAT_MULTILINE_MAX_BYTES` for C (4096) |
| Multiline received on C from B (16384 bytes) | Accepted, displayed locally |
| Buffer sizing for inbound batch state on any server | network max (16384 here) |
| Relay through us | passthrough; trust upstream's enforcement |

Asymmetric: send-side enforced locally (admin's choice), receive-side
sized to the network max (technical necessity to handle whatever any
server in the network can produce).

This honours each admin's intent ("my users will send small multilines")
without crippling cross-server delivery to local clients.

## Network max computation

```c
unsigned int compute_network_ml_max_bytes(void) {
  unsigned int max_bytes = feature_int(FEAT_MULTILINE_MAX_BYTES);
  struct Client *srv;

  for (srv = GlobalClientList; srv; srv = cli_next(srv)) {
    if (!IsServer(srv) || IsMe(srv) || !IsMultiline(srv))
      continue;
    if (cli_serv(srv)->ml_max_bytes == 0)
      continue;  /* unknown/legacy — don't include */
    if (cli_serv(srv)->ml_max_bytes > max_bytes)
      max_bytes = cli_serv(srv)->ml_max_bytes;
  }
  return max_bytes;
}
```

Same shape for `_lines`. Treats `ml_max_bytes == 0` as "unknown" — we
don't know what they can send; assume our own default for lower-bound
sanity.

Recompute on:
- ML burst received from a peer
- Server SQUIT (lazy — see resize policy below)
- REHASH that touches local FEAT_MULTILINE_MAX_BYTES/LINES

## Sanity ceiling

Cap the network max at a configured ceiling. Without this, a
misconfigured or hostile peer advertising max=1GB forces every server
to size buffers to match.

```c
F_I(MULTILINE_BUFFER_CEILING, 0, 65536, 0)  /* default: 4× IRCv3 recommended */
```

`compute_network_ml_max_bytes()` returns `min(actual_max, ceiling)`.
Above the ceiling, we accept up to ceiling and refuse anything bigger
on relay (treat as malformed; drop or error).

Default 65536 bytes (4× the typical IRCv3 recommendation of 16384) —
generous for legitimate use, protective against runaway configs.

Same idea for lines: `MULTILINE_BUFFER_LINES_CEILING`, default e.g. 1000.

## Resize policy — turned out to be unnecessary

The original plan called for eager-grow / lazy-shrink with realloc and a
shrink timer. That assumed S2S multiline batch state held a
pre-allocated fixed-size receive buffer. **It doesn't** —
`S2SMultilineBatch` accumulates messages as a heap-allocated linked
list (`MyMalloc` per message) at
[m_batch.c:1515](nefarious/ircd/m_batch.c#L1515). There is no buffer to
resize; just a running byte counter.

So the implementation collapsed to:

1. Add `total_bytes` field to `S2SMultilineBatch`.
2. Compute network max on demand in `add_s2s_multiline_message`.
3. Reject further additions when `total_bytes + len > network_max_bytes`
   or `msg_count >= network_max_lines`.
4. Log a warning, finish the batch with what's already accumulated.

Shipped at commit `d7a3dba`. `FEAT_MULTILINE_BUFFER_SHRINK_DELAY` is
unused; left in the codebase for now in case future work brings back
some form of cached state.

The original sketch is preserved below for posterity but should not be
implemented unless someone introduces a pre-allocated buffer.

(historical sketch — do not implement)


```c
static unsigned int effective_ml_buffer_bytes;
static unsigned int effective_ml_buffer_lines;
static struct Event shrink_timer;

void recompute_network_ml_max(void) {
  unsigned int target_bytes = compute_network_ml_max_bytes();
  unsigned int target_lines = compute_network_ml_max_lines();

  /* clamp to ceilings */
  if (target_bytes > feature_int(FEAT_MULTILINE_BUFFER_CEILING))
    target_bytes = feature_int(FEAT_MULTILINE_BUFFER_CEILING);
  if (target_lines > feature_int(FEAT_MULTILINE_BUFFER_LINES_CEILING))
    target_lines = feature_int(FEAT_MULTILINE_BUFFER_LINES_CEILING);

  if (target_bytes > effective_ml_buffer_bytes ||
      target_lines > effective_ml_buffer_lines) {
    /* grow immediately */
    cancel_shrink_timer();
    realloc_ml_buffers(target_bytes, target_lines);
    effective_ml_buffer_bytes = target_bytes;
    effective_ml_buffer_lines = target_lines;
  } else if (target_bytes < effective_ml_buffer_bytes ||
             target_lines < effective_ml_buffer_lines) {
    /* schedule shrink, don't realloc yet */
    schedule_shrink_timer(feature_int(FEAT_MULTILINE_BUFFER_SHRINK_DELAY));
  }
}

static void shrink_timer_fire(...) {
  unsigned int target_bytes = compute_network_ml_max_bytes();
  unsigned int target_lines = compute_network_ml_max_lines();
  /* clamp ... */
  if (target_bytes < effective_ml_buffer_bytes ||
      target_lines < effective_ml_buffer_lines) {
    realloc_ml_buffers(target_bytes, target_lines);
    effective_ml_buffer_bytes = target_bytes;
    effective_ml_buffer_lines = target_lines;
  }
}
```

Rationale: network flaps (ping timeouts, brief netsplits) are common.
Constantly resizing buffers up and down on every transient SQUIT is
wasteful and risky — in-flight messages mid-realloc could be lost.
Lazy shrink covers any reconnect within the delay window without buffer
churn.

## Mid-batch realloc safety

Multiline batches are short-lived (open → fragments → close) and
receive accumulates into per-server buffers. If a realloc fires
mid-batch:

- **Grow:** realloc copies existing contents; batch state preserved.
  Safe.
- **Shrink:** if a batch in progress is larger than the new target,
  realloc would truncate. Either avoid by only firing shrink when no
  S2S batch is open, OR delay shrink by another tick if any batch is
  active.

The lazy shrink delay almost always covers any in-flight batch's
lifetime, so the active-batch check is mostly defensive. Implement it
anyway; the cost is one extra timer reschedule.

## CAP advertisement to clients

Each server advertises its own `FEAT_MULTILINE_MAX_BYTES` and
`FEAT_MULTILINE_MAX_LINES` to its local clients via the existing
`draft/multiline=max-bytes=N,max-lines=M` CAP value at
[m_cap.c:528-529](nefarious/ircd/m_cap.c#L528-L529). **No change here**
— clients see the local server's limit, which is what they're actually
constrained by on submit. No CAP NEW churn from network topology
changes.

## Edge cases

1. **Server joins with new higher limit.** Network max grows. All
   servers immediately realloc upward. New multilines from the new
   server may be relayed through us; we have buffer space for them.

2. **Server with the highest limit SQUITs.** Network max drops (after
   shrink delay). Until then, we still hold space for the larger
   format; if that server reconnects, no realloc needed.

3. **Brief netsplit blip.** SQUIT fires shrink timer; reconnect within
   delay cancels. No realloc churn.

4. **Burst race.** Network max may briefly be wrong on the receiving
   side during burst. A multiline submitted in this window could be
   allowed-too-large or rejected-too-small relative to post-burst
   state. Window is small (link-establishment ms); accept.

5. **`ml_max_bytes == 0` from legacy peers.** Already noted in
   [m_batch.c:1855](nefarious/ircd/m_batch.c#L1855). Don't include
   0-valued entries in network max computation; treat as unknown.

6. **Floor.** If no IsMultiline servers known yet (early startup or
   very small network), use local FEAT_MULTILINE_MAX_BYTES as the
   floor so we never under-size our own outbound capacity.

## New feature flags

```c
F_I(MULTILINE_BUFFER_CEILING,       0, 65536, recompute_network_ml_max),
F_I(MULTILINE_BUFFER_LINES_CEILING, 0, 1000,  recompute_network_ml_max),
F_I(MULTILINE_BUFFER_SHRINK_DELAY,  0, 1800,  0),
```

Tuned via REHASH. Notify hook on the ceilings recomputes the network
max so a freshly-tightened ceiling takes effect at next event.

## Testing plan

### Unit-level

- Network max computation with various server configurations (legacy
  with 0, multiple sizes, single server, no servers).
- Ceiling clamping.
- Grow/shrink path: simulate ML burst with rising/falling values,
  assert realloc fires/doesn't fire correctly.
- Shrink timer cancel on subsequent grow.

### Integration

- 3-server testnet with limits 4096 / 8192 / 16384. Verify each
  server's local clients see correct local CAP value. Verify a 16384-
  byte multiline from largest-limit server arrives intact at the
  smallest-limit server's local client.
- Local user on smallest-limit server attempts 8192-byte multiline:
  rejected per local cap.
- Server with 16384 limit SQUITs. Wait shrink delay. Assert buffers
  shrink. Reconnect within delay. Assert no realloc.
- Server reconfigures `FEAT_MULTILINE_MAX_BYTES` larger via REHASH.
  Assert burst re-emits new value, peers grow buffers.

### Stress

- Mid-batch realloc: open a batch, manually trigger network max
  change, assert batch completes correctly.
- Many rapid SQUIT/reconnect cycles: assert timer cancellation works
  and we don't churn buffers.

## Rollout

1. **Computation infrastructure.** Add `compute_network_ml_max_bytes`/
   `_lines`, `effective_ml_buffer_bytes`/`_lines` state, and ceilings.
   Invoke recompute on ML burst receive and SQUIT, but don't act on
   the results yet (no realloc; no enforcement). Ship.
2. **Receive enforcement.** Resize the ML batch receive buffers based
   on `effective_ml_buffer_bytes`/`_lines`. Validate on burst race
   handling. Ship.
3. **Send enforcement.** Switch local user submission cap from
   `feature_int(FEAT_MULTILINE_MAX_BYTES)` (which it always was) to
   the same — no change. The CAP advertisement to local clients
   already shows local limits. Verify users on different-limit servers
   can send up to their own server's value and not beyond.
4. **Resize policy.** Wire up grow-immediately / shrink-lazily logic
   with the timer. Ship and observe.

Steps 1-2 are passive (infrastructure + receive sizing). Step 4 adds
the dynamic resize behaviour.

## Out of scope

- IRCV3AWARE framework — see
  [ircv3aware-s2s-framework.md](ircv3aware-s2s-framework.md), independent.
- Compact-tag client-tag relay — see
  [p10-compact-client-tags.md](p10-compact-client-tags.md), independent.
- Per-link multiline emission gating (e.g. for non-IRCV3AWARE peers,
  fall back to component messages). That's covered by the framework
  plan's spec-compliant fallback section.

## Open questions

1. `MULTILINE_BUFFER_CEILING` default of 65536 reasonable, or is the
   current `IRCV3_TAG_MAX` (8191) more appropriate? Differ in scope —
   the ceiling is for batch payload accumulation, not single-line tags.
   65536 errs on the generous side; can tighten if memory is a concern.
2. Should the realloc grow be incremental (e.g. round to next power of
   two) to avoid frequent small grows? Probably yes — realloc to the
   nearest power of two ≥ target.
3. Should `MULTILINE_BUFFER_SHRINK_DELAY` be shorter for testnet/
   debugging? A FEAT-tunable means yes, but worth a default-debug
   override for development.
