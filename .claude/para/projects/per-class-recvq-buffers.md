# Per-class recvQ accounting — flood protection that matches wire semantics

**Status:** Shipped — `eb743d1` (nefarious) "recv-class flood: per-region byte classifier replaces per-CAP boost arithmetic"
**Author:** ibutsu
**Date:** 2026-05-12 (revised 2026-05-18 — multiline split out, single-buffer model)

> **Scope note (2026-06-01):** This plan covered *flood accounting* —
> replacing per-CAP boost arithmetic in the recv path with a streaming
> classifier.  It did **not** shrink the underlying `con_buffer` /
> `con_ws_frame_buf` / `con_ws_frag_buf` inline arrays, which remain
> sized for the worst case unconditionally.  Follow-on plan:
> [recv-buffer-shrink.md](recv-buffer-shrink.md).

## Motivation

`FEAT_CLIENT_FLOOD` predates message-tags and multiline.  It buckets all
incoming wire bytes into one recvQ and applies one cap.  With IRCv3
size-extending caps in play, the current model has to pick one of:

- **Static cap** (e.g., bump to 16384 to fit a max-tag message) — abusable;
  legacy clients still get the inflated headroom they don't need.
- **Per-CAP conditional boost** (current fix, [s_bsd.c:1253-1261](nefarious/ircd/s_bsd.c#L1253-L1261)) —
  works, but the arithmetic grows as new caps land; the boost is granted to
  any CAP-active client whether or not the in-flight line is actually
  oversized; multiline gets a whole-batch boost just for opening a batch.

The wire stream already has natural semantic classes — tags vs message
body, with multiline as a separate parser-layer concern.  Account for
them separately at the byte-append boundary and the flood logic falls
out of a small streaming classifier instead of cap arithmetic.

## Investigation — what's actually in the tree

### Current recv flood path ([s_bsd.c:1234-1320](nefarious/ircd/s_bsd.c#L1234-L1320))

```c
/* Whole readbuf goes into one dbuf. */
if (length > 0 && dbuf_put(&(cli_recvQ(cptr)), readbuf, length) == 0)
    return exit_client(cptr, cptr, &me, "dbuf_put fail");

/* Composite cap built from per-CAP boosts. */
max_recvq = get_recvq(cptr);
if (CapActive(cptr, CAP_MSGTAGS))      max_recvq += IRCV3_TAG_MAX;
if (cli_ml_batch_id(cptr)[0] || CapActive(cptr, CAP_DRAFT_MULTILINE))
    max_recvq += FEAT_MULTILINE_MAX_BYTES;

if (DBufLength(&(cli_recvQ(cptr))) > max_recvq)
    return exit_client(cptr, cptr, &me, "Excess Flood");

/* ... parse loop drains dbuf_getmsg into cli_buffer ... */

/* Post-parse safety: multiline-capable client that did NOT actually
 * open a batch loses the multiline boost retroactively. */
if (IsUser(cptr) && !cli_ml_batch_id(cptr)[0]
    && CapActive(cptr, CAP_DRAFT_MULTILINE)
    && DBufLength(&(cli_recvQ(cptr))) > get_recvq(cptr))
    return exit_client(cptr, cptr, &me, "Excess Flood");
```

Pain points the above reveals:
- The boost is granted on **capability ACK**, not **actual oversized byte
  arrival**.  A tags-CAP client gets +8191 headroom every read cycle whether
  they used tags this cycle or not.
- Multiline boost is whole-batch (16384 default) — clients can park 16 KB of
  abuse in recvQ as long as they keep a batch open.  Post-parse recheck
  catches the no-batch case but not the open-batch case.
- The cap arithmetic grows monotonically as new size-extending CAPs land
  (the next one will be whatever follows multiline).

### Current multiline byte enforcement ([m_batch.c:794-802](nefarious/ircd/m_batch.c#L794-L802))

```c
int max_bytes = feature_int(FEAT_MULTILINE_MAX_BYTES);
if (con_ml_total_bytes(con) + len > max_bytes) {
    send_fail_ctx(sptr, "BATCH", "MULTILINE_MAX_BYTES",
                  "Multiline batch max-bytes exceeded", "%d", max_bytes);
    clear_multiline_batch(con);
    return -1;
}
/* ... store msg ... */
con_ml_total_bytes(con) += len;
```

This is the right place — it's after per-line parsing, the FAIL response
is spec-correct, and it runs only when a batch is open.  **The recv path
doesn't need to know about multiline at all.**  The current recv-side
boost is redundant with this enforcement and accidentally weaker (no
named FAIL, just a generic Excess Flood when the dbuf overflows).

### Current tag-size enforcement ([parse.c:1442-1453](nefarious/ircd/parse.c#L1442-L1453))

```c
if (total_tags_len > 8191) { ServerStats->is_ref++; return -1; }
if (!IsServer(cptr) && !IsHandshake(cptr) && total_tags_len > 4095) {
    send_reply(from, ERR_INPUTTOOLONG);
    return -1;
}
```

Parser-side, **after** a full line has been assembled.  This means a
client can push 8 KB of garbage tag bytes per line and get all 8 KB into
recvQ before the line completes and gets rejected.  Moving the 4095/8191
checks into the byte-append classifier kills the flood at byte N+1 of
the tag region instead of byte N of the whole line.

## Proposal — single recvQ + streaming classifier with per-class counters

Drop the per-CAP boost arithmetic in s_bsd.c.  Replace it with a tiny
streaming classifier that runs as each readbuf byte is appended to
`cli_recvQ`.  The classifier tracks per-class byte counts for the
*in-flight line only* — they reset on `\r\n`.

### State on Connection

```c
struct Connection {
    /* ... existing fields ... */
    unsigned char con_recv_state;       /* RECV_TAGS or RECV_MSG */
    unsigned int  con_recv_tag_bytes;   /* bytes of @-region in current line */
    unsigned int  con_recv_msg_bytes;   /* bytes of msg-region in current line */
};
```

Cost: 9 bytes per Connection (5 with bitfield packing).  No allocation,
no lifecycle.

### Classifier states

```c
enum {
    RECV_TAGS = 0,   /* inside @...; before first SPACE on this line */
    RECV_MSG  = 1,   /* prefix + command + args + trailing; until \r\n */
};
```

### Transitions

| From       | Byte    | To       | Side effect                          |
|------------|---------|----------|--------------------------------------|
| line start | `@`     | RECV_TAGS | tag_bytes++; count includes `@`      |
| line start | other   | RECV_MSG | msg_bytes++                          |
| RECV_TAGS  | ` `     | RECV_MSG | (separator — counted in neither)     |
| RECV_TAGS  | `\r\n`  | line start | reset both counters (TAGMSG case)  |
| RECV_TAGS  | other   | RECV_TAGS | tag_bytes++                          |
| RECV_MSG   | `\r\n`  | line start | reset both counters                 |
| RECV_MSG   | other   | RECV_MSG | msg_bytes++                          |

### Per-class caps (checked at each increment)

| Class | Client cap                                | Server cap (S2S inbound)        | Source                          |
|-------|-------------------------------------------|---------------------------------|---------------------------------|
| TAGS  | 4095 (incl. `@`)                          | 8191 (incl. `@`)                | IRCv3 message-tags spec         |
| MSG   | `BUFSIZE` (512)                           | `BUFSIZE` (512)                 | IRCv3 spec / P10 contract       |

Both directions cap the body region at 512 bytes.  Sources:
- **Server (S2S):** P10 maintains the 512-byte body limit; relaxing it
  on recv would let an upstream-non-conformant peer push us into a
  state we can't faithfully forward to legacy peers.
- **Client:** IRCv3 message-tags spec is explicit that **tags grow but
  the body stays at "the standard 510 byte tag-less message limit"**
  (= `BUFSIZE - 2`).  Nefarious's own outbound P10 chunks at `BUFSIZE`
  per line (m_burst.c, m_names.c), confirming the bound is mutual.

`FULL_MSG_SIZE` (= `IRCV3_TAG_MAX + BUFSIZE` = 8703) is the **total
line cap** (tags + body), not a body cap — a frequent point of
confusion when reading the existing parse / dbuf code, which uses
`FULL_MSG_SIZE` as the per-line read budget.  The classifier
separates the two regions and applies the body bound to the body
alone.

Overflow → `exit_client` with a named reason:
- `Excess Flood: tag region too large` — moves the parse.c 4095/8191
  check forward into recv, kills mid-line instead of after assembly.
- `Excess Flood: message region too large` — same as today's
  ERR_INPUTTOOLONG path, but pre-empts dbuf_getmsg.
- `Excess Flood: S2S body exceeds 512` — new, named kill for a peer
  violating the P10 body contract on inbound.

### Sustained-flood cap

`max_recvq = get_recvq(cptr) + FULL_MSG_SIZE` — one max-legal-line of
in-flight headroom on top of the class flood cap.  Per-line per-class
caps (above) bound any single line; the headroom covers the window
between `dbuf_put` (bytes have arrived) and `dbuf_getmsg` (parse loop
drains).  Without it, a single legitimate large message — e.g. a
chunked SASL `AUTHENTICATE` pipeline, a big-tag PRIVMSG — trips the
flood cap before the parser has a chance to consume it.

**Important real-world calibration:** pipelining is normal.  SASL
chunks at 400-byte payloads, so a typical OAUTHBEARER flow sends 2–4
AUTHENTICATE lines back-to-back.  With raw `get_recvq() = 1024` those
1.6–3.2 KB of pipelined frames trip the cap before parse drains them
— observed as "Excess Flood during SASL" in the field.  The
`+ FULL_MSG_SIZE` allowance fixes this without re-introducing per-CAP
arithmetic: every client gets the same uniform allowance regardless of
which caps are active.

This still kills the boost-without-use abuse described below — the
boost is no longer conditioned on a CAP, so there's no "free headroom
by negotiating a CAP and never using it."  It also still bounds tag
abuse via the per-line classifier caps (4095/8191).

## Multiline — explicitly out of scope for recv path

Multiline byte accounting **stays at [m_batch.c:794-802](nefarious/ircd/m_batch.c#L794-L802)**
where it already works correctly with proper `MULTILINE_MAX_BYTES` FAIL
semantics.  Recv path stops boosting recvQ for batch state entirely.

Why this is the right call:
- Multiline is parser-layer state (batch_id, msg list, lag accumulator) —
  recv-side bookkeeping has to mirror parser-side bookkeeping, and the
  two can desync (batch closed via timeout while bytes still in flight).
- The FAIL response (`MULTILINE_MAX_BYTES` with `%d` context param) is a
  spec-compliant signal to the client.  A recv-side kill is a blunt
  instrument that hides the protocol violation as "Excess Flood."
- Per-line caps (MSG ≤ FULL_MSG_SIZE) already constrain any individual
  multiline line — the parser sees one line at a time and enforces the
  cumulative cap incrementally as lines are stored.

Side effect: the post-parse strict recheck at
[s_bsd.c:1311-1320](nefarious/ircd/s_bsd.c#L1311-L1320) goes away.  It
exists today only because the recv-side boost can outlive its
justification; with no boost, there's nothing to retroactively rescind.

## Memory model

- Legacy client: `cli_recvQ` only, capped at `get_recvq()` (1024
  default).  No state churn, no extra allocations.
- `message-tags` client: same buffer, same cap.  Per-line tag region
  checked against 4095 by classifier.  No per-CAP boost, no per-CAP
  arithmetic.
- Multiline-active client: same buffer, same cap.  Cumulative batch
  bytes enforced by m_batch.c on the parser side, as today.

**Total state added per Connection: 3 fields (~9 bytes).**
**Total state removed: per-CAP boost arithmetic in s_bsd.c.**

## What this kills that today's model can't

- **Mid-line tag flood:** Client sends `@xxxxxxxx…` 8 KB of garbage before
  the SPACE.  Today: 8 KB lands in recvQ, parse.c rejects after assembly.
  New: classifier kills at tag_bytes == 4096 — 99% of the flood never gets
  allocated.
- **Open-batch sustained flood:** Client opens a multiline batch and
  streams 16 KB of well-formed lines slowly enough to evade lag throttle.
  Today: recvQ allowed to grow to `get_recvq() + 16384`.  New: recvQ
  bounded by `get_recvq()` flat; per-line caps still apply; m_batch.c
  enforces cumulative bytes with proper FAIL.
- **CAP-without-use abuse:** Tags-capable client never sends tags but
  keeps the +8191 headroom for non-tag flooding.  Today: yes, recvQ can
  grow.  New: the only allowance is the universal `+ FULL_MSG_SIZE`
  in-flight buffer, granted to every client identically.  There's no
  CAP-conditioned bonus, so negotiating a CAP and never using it grants
  zero advantage.  Sustained accumulation still trips the same cap.

## Migration

Three commits, each independently reversible:

**1. Add classifier (no flood-cap change yet)**
Add `con_recv_state`, `con_recv_tag_bytes`, `con_recv_msg_bytes` to
Connection.  Add `recv_classify(struct Connection *con, const char *buf,
size_t len)` that walks bytes and updates counters but **does not kill**.
Call from `read_packet` before `dbuf_put`.  Add debug log on per-class
overrun.  Validate via tests that classifier counters match parser-side
tag length / msg length after assembly.

**2. Switch enforcement to classifier**
- Make classifier return non-zero on per-class overrun.
- `read_packet`: if classifier returns nonzero, `exit_client` with the
  named reason.
- Delete the `max_recvq += IRCV3_TAG_MAX` and `+= FEAT_MULTILINE_MAX_BYTES`
  boost arithmetic.
- Delete the post-parse strict recheck.
- Move the [parse.c:1442-1453](nefarious/ircd/parse.c#L1442-L1453)
  tag-size check (now redundant in client path) — keep server-path check
  intact for incoming S2S.

**3. Cleanup**
- Remove `b483aad`'s tag-length recvQ boost ([s_bsd.c:1255-1256](nefarious/ircd/s_bsd.c#L1255-L1256)).
- Audit `get_recvq()` callers — they're now back to the pre-IRCv3
  meaning, no special-casing needed.

## Testing

The change touches a hot path (every byte every client reads) with
serious blast radius — a wrong cap kills legitimate clients, a missing
cap kills nothing.  Test plan is in three tiers: in-tree unit, testnet
integration, regression coverage of the cases that motivated the
existing code.

### Tier 1 — classifier unit tests (in-tree, ircd/)

Stand-alone tests for `recv_classify()` with no Connection or socket
involvement.  These run as part of the existing `ircd_*` build (model
on `ircd_string_test.c` or wherever the codebase keeps its few existing
self-tests; if none, this is a good time to add a minimal harness).

Cases:

| Input bytes                              | Expected end state                              |
|------------------------------------------|-------------------------------------------------|
| `PING :foo\r\n`                          | RECV_MSG, tag=0, msg=9, line reset after `\n`   |
| `@a=b PING :foo\r\n`                     | RECV_MSG, tag=4 (including `@`), msg=9          |
| `@a=b\r\n` (TAGMSG-shape, no body)       | RECV_TAGS→reset, tag never accumulated past 4   |
| `@aaa...` (4095 bytes) + `\r\n`          | Allowed, tag=4095                               |
| `@aaa...` (4096 bytes from client)       | Returns OVERRUN_TAG_CLIENT                      |
| `@aaa...` (8191 bytes from server)       | Allowed                                         |
| `@aaa...` (8192 bytes from server)       | Returns OVERRUN_TAG_SERVER                      |
| `XYZ` × (FULL_MSG_SIZE+1) from client    | Returns OVERRUN_MSG_CLIENT                      |
| `XYZ` × 513 from server                  | Returns OVERRUN_MSG_SERVER (S2S 512 limit)      |
| Single byte at a time (split feed)       | Same end state as whole-buffer feed             |
| Split mid-tag at byte 50 of 100          | Resumes correctly, final tag count = 100        |
| `\r` only, no `\n` (lone CR)             | Treated as line terminator OR ignored — pick one and document |
| Bare `\n` (no CR)                        | Treated as line terminator (existing parse.c behavior) |

The split-feed cases are the most important — they exercise the
state-resumability that the production hot path needs.  Drive them with
a fuzzed byte-by-byte feed across thousands of randomly-fragmented
inputs and assert that the end state matches whole-buffer feed.

### Tier 2 — testnet integration tests (`tests/src/ircv3/`)

New file: `tests/src/ircv3/recvq-flood.test.ts`.  Each test opens a
`RawSocketClient`, sends a crafted byte sequence, asserts on either the
kill reason in `ERROR :` or the connection-close path.

**Client-side per-class caps:**

```
it('kills mid-line on >4095 tag bytes from client', ...)
  → connect, send '@' + 'x'.repeat(4096)
  → expect ERROR with /tag region too large/ before any \r\n is sent
  → assert no garbage was queued — server killed within one read cycle

it('accepts exactly 4095 tag bytes from client', ...)
  → send '@' + 'x=' + 'y'.repeat(4091) + ' PING :ok\r\n'
  → expect PONG, connection still up

it('kills on >FULL_MSG_SIZE msg region from client', ...)
  → send PRIVMSG with single trailing arg exceeding FULL_MSG_SIZE
  → expect ERR_INPUTTOOLONG OR kill

it('does not boost recvQ for tags-CAP without use', ...)
  → ACK message-tags but only send legacy lines fast
  → expect kill at get_recvq() (no +IRCV3_TAG_MAX inflation)
  → diff against today: today this client would have +8191 headroom
```

**Non-CAP @ rejection (parse-layer pair):**

```
it('drops @-prefixed line from non-CAP client', ...)
  → connect without ACKing message-tags
  → send '@time=2026-01-01T00:00:00Z PING :probe\r\n'
  → expect NO PONG (line dropped) AND no kill (just refused)
  → ServerStats->is_ref++ verifiable via /STATS u or similar

it('accepts @-prefixed line from CAP-active client', ...)
  → same input but with message-tags ACKed
  → expect PONG
```

**Multiline still gets proper FAIL:**

```
it('multiline overflow yields MULTILINE_MAX_BYTES FAIL, not Excess Flood', ...)
  → BATCH +ml draft/multiline #chan, then PRIVMSG lines until cumulative >FEAT_MULTILINE_MAX_BYTES
  → expect FAIL BATCH MULTILINE_MAX_BYTES <cap>
  → assert connection stays UP (m_batch.c calls clear_multiline_batch but doesn't exit_client)
```

This is the no-regression test for the multiline-stays-in-parser
decision.  If someone re-introduces a recv-side multiline boost or kill,
this test catches the wrong kill path.

**Sustained-flood cap:**

```
it('sustained-flood cap is get_recvq() with no per-CAP arithmetic', ...)
  → ACK message-tags + multiline
  → pipeline well-formed messages until DBufLength > get_recvq()
  → expect Excess Flood kill
  → assert kill happens at the raw class limit, not class limit + boosts

it('legacy client unaffected — same cap behavior as before', ...)
  → no CAP
  → pipeline messages until kill
  → assert behavior matches a pre-change reference run
```

**S2S 512 body contract:**

```
it('S2S inbound: rejects body region >512 bytes', ...)
  → bring up server link via test harness
  → emit P10 message with body >512 from peer side
  → expect Excess Flood: S2S body exceeds 512 on the link
  → link drops, no garbage propagated

it('S2S inbound: accepts tag region up to 8191', ...)
  → emit P10 with @-region of 8000 bytes and 100-byte body
  → expect successful delivery, no kill
```

**WebSocket compatibility:**

```
it('classifier runs on decoded WS frames', ...)
  → connect via WS, send oversized tag inside a text frame
  → expect kill with same reason as TCP path
```

### Tier 3 — regression / "the bug we're fixing"

Pin the failure modes from the Pain points list explicitly so future
refactors can't silently re-introduce them:

```
it('mid-line tag flood gets killed before full line lands in recvQ', ...)
  → measure recvQ depth via /CHECK or test hook at kill time
  → assert depth < (tag cap + small slack), NOT the whole 8 KB

it('open-batch sustained flood capped at get_recvq()', ...)
  → BATCH +ml ...; then slow well-formed lines under lag threshold
  → assert recvQ never grows past get_recvq()
  → today's behavior: grows to get_recvq() + FEAT_MULTILINE_MAX_BYTES

it('CAP-without-use does not extend recvQ headroom', ...)
  → covered above; redundant pin so regression diff is obvious
```

### Property tests (worth doing)

For the classifier alone, drive a property-based fuzzer that:
1. Generates a random sequence of well-formed IRC lines.
2. Splits them at random byte boundaries into N reads.
3. Feeds each split sequentially.
4. Asserts: final classifier counters + state == reference (whole-buffer
   feed of the concatenation).

The classifier should be byte-deterministic regardless of TCP segment
boundaries.  This catches any state-resumability bug in CI before it
manifests as a "occasionally kills good clients" production report.

### Test order during migration

- Commit 1 (shadow classifier): land Tier 1 unit tests with it.  Assert
  classifier counters match parser-side measurements via debug log
  comparison.  No Tier 2/3 yet — nothing to flood-test.
- Commit 2 (switch enforcement): land all Tier 2 + Tier 3 tests.  This
  is where the kill-reason assertions matter.
- Commit 3 (cleanup): re-run Tier 2 to confirm no regression after
  removing the b483aad tactical boost.

## Open questions

- **TAGMSG / `@only-tags\r\n`:** Tag region followed directly by `\r\n`
  with no SPACE separator and no message body.  Classifier handles this
  natively: tag_bytes accumulates, `\r` resets without ever entering
  RECV_MSG.  No special case needed.
- **Mid-tag TCP boundary:** readbuf splits a tag mid-byte.  Classifier
  is byte-at-a-time and state-resumable — counters and state survive
  across `read_packet` calls until the line terminates.
- **CAP -message-tags mid-session:** Client drops the CAP after using it.
  The classifier doesn't care about CAP state — it classifies by wire
  shape, not capability.  A non-CAP client that sends `@tag` still hits
  the same 4095 cap at the byte-append boundary.  Separately, **parse.c
  must reject `@`-prefixed lines from clients that haven't ACKed
  message-tags** (today it parses them anyway): drop the line silently
  with `ServerStats->is_ref++` to prevent a non-negotiated client from
  using the tag surface as a free-bytes channel.  This is a parse-layer
  decision, but it pairs with the classifier — together they bound both
  the byte cost (recv) and the parsed-tag cost (parse) of tag abuse.
- **Server-to-server traffic:** P10 keeps the legacy 512-byte body limit
  for the message region — we may stretch tags (necessary, given how
  compact we already try to keep S2S tags) but **must never emit >512-byte
  bodies to legacy S2S peers**.  Inbound, the classifier applies separate
  caps for `IsServer(cptr) || IsHandshake(cptr)`:
    - Server tag region: 8191 (matches the existing parse.c ceiling).
    - Server msg region: 512 (legacy P10 body limit), not `FULL_MSG_SIZE`.

  Accepting >512-byte bodies inbound would let a misbehaving (or
  upstream-non-conformant) peer push us into a state we then can't
  faithfully relay to legacy peers.  Keep the limit strict on both
  ends.  The IRCv3-aware send-side gate already exists
  (commit 7cecc9b, `IsIRCv3Aware`) and handles the *tag* side; the body
  side is the unchanging P10 contract.

  Related: zstd S2S compression (`FEAT_COMPRESS_THRESHOLD` /
  `FEAT_COMPRESS_LEVEL`) is part of how we live within the 512-byte
  body — it pushes more *effective* content through the same wire
  budget and reduces total link overhead.  The compression operates on
  the link layer below the per-line cap, so the classifier doesn't
  interact with it; the 512 cap is what's on the wire after decompress.
- **WebSocket:** `cli_recvQ` is fed pre-decoded UTF-8 from
  [s_bsd.c:1222](nefarious/ircd/s_bsd.c#L1222).  Classifier runs on the
  decoded stream same as TCP — no change needed in WS handling.

## Not blocking

Today's per-CAP-conditional boost is correct and sufficient.  This plan
is the architectural endgame; land it when bouncer and persistence work
has settled and the recv path can absorb a refactor.  Commit `b483aad`
("read_packet: boost recvQ flood limit by one max-tag-length for msgtag
clients") is the tactical patch; this plan supersedes it cleanly.
