# Per-class recvQ buffers — flood protection that matches wire semantics

**Status:** Design (not implemented)
**Author:** ibutsu
**Date:** 2026-05-12

## Motivation

`FEAT_CLIENT_FLOOD` predates message-tags and multiline. It buckets all
incoming wire bytes into one recvQ and applies one cap. With IRCv3
size-extending caps in play, the current model has to pick one of:

- **Static cap** (e.g., bump to 16384 to fit a max-tag message) — abusable;
  legacy clients still get the inflated headroom they don't need.
- **Per-CAP conditional boost** (current fix, [s_bsd.c:1236-1247](nefarious/ircd/s_bsd.c#L1236-L1247))
  — works, but arithmetic in flood-check grows as new caps land; boost is
  granted to any CAP-active client whether or not they use it.

The wire stream already has natural semantic classes. Account for them
separately and the flood logic falls out of the buffer geometry.

## Proposal

Replace `cli_recvQ` (single dbuf) with three class-typed dbufs on the
Connection struct, each with its own cap:

| Field             | Cap source                          | Allocated when                   |
|-------------------|-------------------------------------|----------------------------------|
| `con_recvq_msg`   | `FEAT_CLIENT_FLOOD` (default 1024)  | always (legacy + everyone)       |
| `con_recvq_tags`  | `IRCV3_TAG_MAX` (8191, fixed by spec) | client ACKs `message-tags` CAP |
| `con_recvq_ml`    | `FEAT_MULTILINE_MAX_BYTES`          | client opens a multiline batch   |

(Multiline is the awkward one — see "Multiline" below.)

## Recv-path classifier

A streaming state machine consumes the staging buffer from `read()` and
routes bytes by class:

```c
enum recv_state {
  RECV_TAGS,       /* inside @...; before first SPACE */
  RECV_MSG,        /* prefix + command + args + trailing; until \r\n */
  RECV_ML_BODY     /* inside multiline batch — same as MSG but logged
                      against batch budget rather than per-line msg */
};
```

Transitions:
- Initial state: `RECV_TAGS` if first byte is `@`, else `RECV_MSG`.
- `RECV_TAGS` → `RECV_MSG` on first non-tag SPACE.
- Any state → reset to initial on `\r\n`.
- Inside multiline batch (`cli_ml_batch_id[0]`), MSG state's bytes are
  accounted against `con_recvq_ml` (per-batch budget) rather than
  per-line `con_recvq_msg`.

Each appended byte does a cap check on the destination buffer:
- `con_recvq_tags` overflow → `Excess Flood: tag overrun` (kill)
- `con_recvq_msg` overflow → `Excess Flood` (existing kill)
- `con_recvq_ml` overflow → `Excess Flood: batch overrun` (kill) and
  optionally `ERR_INPUTTOOLONG` warning before kill

## Parse-path reassembly

`dbuf_getmsg` today does "find `\r\n`, copy line into `cli_buffer`."
With split buffers, message assembly happens in two steps:

1. If `con_recvq_tags` has content, copy its current accumulator into
   `cli_buffer` (with `@` prefix).
2. Append a SPACE separator.
3. Copy `con_recvq_msg`'s content up to `\r\n` into `cli_buffer`.
4. Clear both tag and msg buffers (they hold only one message worth).
5. Dispatch.

The parser downstream sees the same single-buffer line it sees today.
Only the recv-side accumulation changes.

## Memory model

- Legacy client (no caps): one dbuf, 1024 byte budget. Same as today.
- `message-tags` only: two dbufs, 1024 + 8191 = 9215 byte budget.
  Today's per-CAP boost gives the same number — but in one buffer.
- Multiline-active: + `con_recvq_ml` allocated when batch opens, freed
  when batch closes.
- No silent boost-while-idle: tag buffer is allocated when CAP is ACKed
  (or even lazily on first `@`), freed on disconnect.

## What this kills that today's model can't

A malicious tags-capable client sending `@tag=$(8000_bytes_of_garbage)`
per message: today, `cli_recvQ` accumulates 8000 bytes of garbage tag +
50 bytes of body, total fits under boosted cap. They can do this
once per parse turn. Per-class model: same garbage hits the
8191-byte tag cap; second oversized tag attempt before the first is
parsed → exit_client with "tag overrun" (a different, named flood path).
Operators see *what kind* of flood it was in the kill message.

## Multiline

Multiline doesn't fit the per-stream metaphor as cleanly: it's a batch
of normal messages, not a parallel byte stream. The accounting model
that works:

- During `BATCH +<id>` … `BATCH -<id>`: per-line msg buffer caps still
  apply (each line is still ≤ FULL_MSG_SIZE).
- Cumulative bytes across all lines in the batch are tracked in
  `con_recvq_ml`, capped at `FEAT_MULTILINE_MAX_BYTES`.
- `con_recvq_ml` is an accounting counter, not a physical buffer — the
  bytes still flow through msg/tag buffers per line. Allocate on `BATCH +`,
  free on `BATCH -`.

This collapses the proposed "three buffers" to "two physical + one
counter," which is structurally cleaner anyway.

## Out of scope

- WebSocket and SSL feed already-decoded bytes into the classifier, so
  they don't need changes.
- Server-to-server (`IsServer(cptr)`) traffic bypasses this — servers
  use bigger fixed-cap dbuf paths that aren't subject to client flood.
- Existing post-parse multiline strict-recheck at
  [s_bsd.c:1298-1301](nefarious/ircd/s_bsd.c#L1298-L1301) — no longer
  needed; multiline counter is freed at BATCH `-`.

## Migration

1. Add `con_recvq_tags`, `con_recvq_ml_count` fields to Connection;
   keep `cli_recvQ` for now.
2. Add recv-side classifier in `read_packet` (s_bsd.c) — split incoming
   bytes by state but also still write everything to legacy `cli_recvQ`
   so existing parser keeps working (dual-write phase).
3. Add per-class cap checks in classifier; emit named flood kills.
4. Validate via tests that classifier byte-counts match dbuf content.
5. Switch parser to consume from per-class buffers; remove legacy
   `cli_recvQ`.
6. Remove `IRCV3_TAG_MAX` from main `max_recvq` arithmetic.

Phased so any single landing is reversible.

## Open questions

- **Tag-only message?** `@only-tags\r\n` with no body. Spec-wise this is
  TAGMSG. Current parser handles it; classifier needs to detect
  `\r\n` immediately after tag-region end and not require a SPACE
  separator before MSG accumulation begins.
- **Mid-tag disconnect.** If client closes mid-tag, `con_recvq_tags`
  holds partial content. Freed at exit_client — no leak.
- **Tag size enforcement.** RFC says client-side tags max 4094 + `@` +
  `;` = 4095. Server-side tags can be 8191. CAP_MSGTAGS is symmetric
  so we accept the larger; reject at-parse for client-introduced tags
  exceeding 4094? Today this is `total_tags_len > 4095` check in
  [parse.c:1435-1442](nefarious/ircd/parse.c#L1435-L1442). Move it into
  the classifier so we drop the line during recv rather than after
  full accumulation.

## Not blocking

Today's per-CAP-conditional boost (commit pending) is correct and
sufficient. This plan is the architectural endgame; land it when bouncer
and persistence work has settled and the recv path can absorb a
refactor.
