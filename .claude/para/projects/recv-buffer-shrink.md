# Recv-side buffer shrink — per-connection memory footprint

**Status:** Design (not implemented)
**Author:** ibutsu
**Date:** 2026-06-01

## Motivation

`struct Connection` carries three inline byte buffers sized for the
worst case unconditionally:

| Field                                    | Size           | Used when                                  |
|------------------------------------------|----------------|--------------------------------------------|
| `con_buffer[FULL_MSG_SIZE]`              | 8703 B         | Always (per-line scratch in `read_packet`) |
| `con_ws_frame_buf[FULL_MSG_SIZE]`        | 8703 B         | WebSocket only (partial-frame reassembly)  |
| `con_ws_frag_buf[16384]`                 | 16384 B        | WebSocket only (continuation-frame reasm)  |

Per non-WS legacy client: **~33 KB of inline buffer fat** that's never
written to — the WS buffers are entirely dead weight on a TCP-only
connection, and `con_buffer` only needs `BUFSIZE+2` (514 B) for a
client that hasn't ACKed `message-tags`.

At prod-test's historical peak (676 local clients, [[project-prod-test-history]]),
that's ~22 MB of unused per-Connection inline state.  Not catastrophic
in absolute terms but linear in concurrent connections, and the
fork's per-connection state is already heavier than upstream baseline
([[feedback-fork-vs-upstream-honesty]]) — any easy reduction here
buys back some of that growth headroom.

The [[per-class-recvq-buffers]] refactor (`eb743d1`) addressed flood
*accounting* but didn't touch the *buffer sizing* — they were
deliberately split since the accounting refactor was already a hot-path
change and adding allocation lifecycle on top would have muddied review.

## Investigation — what's actually in the tree

### Buffer use sites

`con_buffer` is written by:
- `ircd/s_bsd.c:1020,1072` — `client_buffer = cli_buffer(cptr)` —
  WS handshake accumulator path.
- `ircd/s_bsd.c:1286` — `dbuf_getmsg(&recvQ, cli_buffer(cptr), FULL_MSG_SIZE)` —
  the main parser-drain path.

The third caller is the hot path: every line a client sends gets
`dbuf_getmsg`'d into `cli_buffer`.  The size argument (`FULL_MSG_SIZE`)
bounds how much `dbuf_getmsg` will copy, so changing the underlying
buffer size means changing this argument in lockstep.

`con_ws_frame_buf` is written by:
- `ircd/s_bsd.c:1123` — `memcpy(cli_ws_frame_buf(cptr) + ..., readbuf, copy_len)`
  in the WS partial-frame path.  Only touched after `IsWebSocket(cptr)`.

`con_ws_frag_buf` is written by:
- `ircd/s_bsd.c:1165` — fragment-reassembly path for continuation frames.
  Only touched after `IsWebSocket(cptr)`.

Both WS buffers are dead code paths on TCP connections — the
`IsWebSocket(cptr)` gate at `s_bsd.c:1109` short-circuits the whole
block.

### CAP_MSGTAGS ACK path

Need to identify the exact site that flips the client from
"no tags" to "tags allowed".  Candidates: `m_cap.c` ACK handler.
This is the point where `con_buffer` would need to grow from
`BUFSIZE+2` to `FULL_MSG_SIZE`.

### WS handshake completion site

`s_bsd.c:331` (`IsWebSocket(cptr)` check) and surrounding handshake
detection.  This is the point where `con_ws_frame_buf` and
`con_ws_frag_buf` would be allocated on demand.

## Proposal — three independent shrinks

The three buffers are independently fixable.  Land them as separate
commits in this order — each one independently reversible, each one
buys some memory back.

### Shrink 1 — WS buffers behind pointers (easiest win)

Replace inline arrays with heap pointers:

```c
unsigned char *con_ws_frame_buf;   /* NULL until WS handshake completes */
char          *con_ws_frag_buf;    /* NULL until WS handshake completes */
```

Allocate at WS handshake completion (`s_bsd.c:~331` or whoever sets
`IsWebSocket`).  Free in `free_connection` / wherever Connection
teardown happens — need to verify the free path is single.

**Saves:** ~24.6 KB per TCP connection (the overwhelming majority).
**Risk:** Low.  WS code paths are gated by `IsWebSocket(cptr)`; the
pointer must be non-NULL before first WS frame, which is guaranteed
because the handshake completes before any frame can arrive.
**Test:** existing WS tests should pass unchanged; add an assert that
`cli_ws_frame_buf(cptr) != NULL` on entry to the partial-frame path
to catch any ordering regression in CI.

### Shrink 2 — `con_buffer` lazy-sized to negotiated CAP

Replace inline array with a heap pointer + capacity:

```c
char           *con_buffer;         /* heap, sized by con_buffer_cap */
unsigned short  con_buffer_cap;     /* current allocation, BUFSIZE+2 or FULL_MSG_SIZE */
```

Allocate `BUFSIZE+2` at Connection creation in `make_connection` /
wherever it's zeroed.  Grow to `FULL_MSG_SIZE` (realloc) on
`CAP_MSGTAGS` ACK.  Update `dbuf_getmsg` callsite to pass
`cli_buffer_cap(cptr)` instead of literal `FULL_MSG_SIZE`.

**Saves:** ~8.2 KB per non-tags client.  Less than Shrink 1 because
tags is widely ACKed by IRCv3 clients, but legacy clients (eggdrop,
older scripts, irssi without IRCv3 plugins) and tags-incapable bots
still benefit.

**Risk:** Medium.  The realloc happens at CAP ACK time — by then the
client is mid-registration but `read_packet` may already have called
`dbuf_getmsg` with the old smaller buffer.  Two concrete hazards:

1. **Realloc mid-line:** if a CAP ACK arrives while there's pending
   data in recvQ, the next `dbuf_getmsg` call must use the new
   capacity.  `cli_buffer_cap` is read at each `dbuf_getmsg` site so
   this is safe by construction — but adding any future caller that
   caches the cap value across reads needs to invalidate on CAP ACK.
   Easiest: read `cli_buffer_cap(cptr)` at use, never cache.

2. **CAP ACK before USER:** CAP negotiation runs before registration
   completes.  `con_buffer` is allocated at make_connection time
   (before CAP), so the initial small-size buffer is in place during
   the CAP exchange — and CAP lines themselves fit easily in
   `BUFSIZE+2`.  CAP ACK happens before any tagged user message can
   arrive (the client has to wait for the `CAP` reply before sending
   tags).  No race.

3. **Realloc failure:** if `realloc` fails the client must die
   cleanly — same path as any other allocation failure (`exit_client`
   with "out of memory").  Realloc on growth means the existing
   buffer contents need to be preserved if the realloc returns the
   same pointer; otherwise the OS does the copy.

**Test:** unit test for `con_buffer_cap` transitions; integration
test that a legacy client (no CAP) and a tagged client (CAP +
message-tags) both round-trip large-tag messages correctly post-ACK.

### Shrink 3 — `con_ws_frag_buf` size negotiation (smallest, lowest priority)

The 16384-byte WS fragment buffer is fixed-size regardless of
expected frame size.  Could be made smaller by default and grown on
first continuation-frame arrival, but the marginal saving is on top
of Shrink 1 (which already heap-allocates it lazily for non-WS) — so
this only matters for WS connections that never use continuation
frames.  Not worth the complexity unless we find evidence of a real
WS workload that pays this cost meaningfully.

**Verdict:** out of scope for v1; revisit if WS becomes a more
significant share of connections.

## Memory model — before vs after

Per-connection inline buffer state, by connection type:

| Connection type             | Before   | After (Shrink 1+2)             | Delta    |
|-----------------------------|----------|--------------------------------|----------|
| TCP legacy (no CAP)         | 33.2 KB  | 514 B (con_buffer heap)        | -32.7 KB |
| TCP message-tags client     | 33.2 KB  | 8703 B (con_buffer heap)       | -24.5 KB |
| WS legacy                   | 33.2 KB  | 514 + 24576 B = 25 KB          | -8.2 KB  |
| WS message-tags client      | 33.2 KB  | 8703 + 24576 B = 32.5 KB       | -700 B   |

The TCP-legacy path is the dominant case in practice and gets the
deepest cut.  TCP-tagged clients still save ~24 KB by skipping the WS
buffers.  WS clients save less, but they're a small minority.

At 676 peak local: ~22 MB → ~3 MB (TCP-legacy mix) or ~16 MB
(TCP-tags-dominant mix).  Either way meaningful and grows linearly.

## Migration

Three commits, independently reversible:

**1. Shrink 1 — WS buffers to heap.**  Add pointer fields,
`make_connection` initializes to NULL, WS-handshake completion site
allocates, `free_connection` frees.  Add assert at WS code paths
that pointer is non-NULL.

**2. Shrink 2 — `con_buffer` heap.**  Add pointer + cap fields.
`make_connection` allocates `BUFSIZE+2`.  CAP_MSGTAGS ACK reallocs to
`FULL_MSG_SIZE`.  All `cli_buffer` users read cap at use, never cache.
`free_connection` frees.

**3. Cleanup.**  Audit any remaining direct `sizeof(con_buffer)` /
`FULL_MSG_SIZE` references in the recv path that should now read
`cli_buffer_cap(cptr)`.  Update `recv_classify` if it makes any
assumption about buffer sizing (it shouldn't — it operates on bytes
as they arrive into `cli_recvQ`, not into `cli_buffer`).

## Testing

### Unit / CMocka

- Test `make_connection` initial state: `con_buffer != NULL`,
  `con_buffer_cap == BUFSIZE+2`, WS pointers NULL.
- Test CAP_MSGTAGS ACK transition: buffer grows to `FULL_MSG_SIZE`,
  capacity updated, original contents preserved.
- Test WS handshake completion: WS buffers allocated, sized
  correctly.
- Test `free_connection` releases all three heap allocations.

### Integration (testnet)

New file: `tests/src/ircv3/recv-buffer-shrink.test.ts`.

- Legacy client sends max-size legacy line (`PRIVMSG #ch :` + payload to
  514 bytes total).  Round-trips correctly with `BUFSIZE+2` buffer.
- Legacy client sends an over-`BUFSIZE+2` line.  Killed cleanly with
  the same kill reason as today (`Excess Flood` or `ERR_INPUTTOOLONG`).
- Message-tags client: ACK message-tags, send a `@key=val;...` tagged
  PRIVMSG with full 4095-byte tag region.  Lands correctly after the
  buffer grew.
- Message-tags client mid-stream: send a legacy line in the same
  socket cycle as a `CAP REQ message-tags`.  Verify the server
  responds to the legacy line with the small buffer, then ACKs CAP
  and accepts the next tagged line at the new buffer size.
- WS client: handshake + tagged PRIVMSG flow.  No regression.

### Stress

Run the existing flood tests (from the recv_classify refactor's test
suite) with the heap-backed buffers.  Should pass unchanged — the cap
behavior is unchanged, only the storage shape moves.

## Open questions

- **Allocation pool vs malloc-per-connection:** Could pool the
  `BUFSIZE+2` and `FULL_MSG_SIZE` buffers in two slab allocators to
  amortize malloc overhead.  Probably premature — `make_connection`
  isn't hot enough that one malloc per connection setup matters.
  Revisit only if profiling shows it.

- **`con_buffer_cap` field width:** 8703 fits in uint16_t (65535
  max), so `unsigned short` is fine.  If we ever raise
  `FULL_MSG_SIZE` past 64 KB, switch to uint32_t.

- **WS handshake → IsWebSocket transition:** need to verify there's
  a single, well-defined site where `IsWebSocket(cptr)` becomes true.
  If WS detection is incremental (multiple intermediate states), the
  WS-buffer alloc site needs to land on the *first* state that allows
  frame data to arrive.

- **`make_connection` vs `add_connection`:** which one is the right
  hook for the initial alloc?  Probably `make_connection`, but
  confirm — they're sometimes paired in confusing ways with
  `free_connection` cleanup.

- **Pre-existing similar work upstream:** worth checking
  evilnet/nefarious2 master to see if anything in this direction was
  contemplated upstream.  If yes, align the data layout so a future
  upstream PR is mergeable.

## Not blocking

The recv path works correctly with the current oversized buffers —
this is pure memory-footprint optimisation.  Land after bouncer
persistence + IRCv3 capability stabilisation has settled and the
recv path can absorb another structural change.  Pair with whatever
upstream-PR cycle naturally follows the recv_classify work.
