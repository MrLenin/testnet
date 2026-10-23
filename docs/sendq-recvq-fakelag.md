# SendQ, RecvQ and fakelag in Nefarious

How the three per-connection flow controls work, and how each applies to
client connections versus server links. Line references are into the
`nefarious` submodule as of 2026-10-19.

## 1. RecvQ: inbound bytes

Every local connection owns a receive queue (a `DBuf`, `cli_recvQ`). For a
client, bytes read from the socket are appended to it
(`ircd/s_bsd.c:1515`) and pulled back out one line at a time by the parse
loop (`ircd/s_bsd.c:1537`). Two checks guard it.

### Per-line caps (before the append)

The byte classifier (`include/recv_classify.h`, called from `read_packet`)
walks the inbound stream and tracks the size of the `@tag` region and the
message region of each line. Caps depend on the direction:

| Direction | Tag region | Message region |
|---|---|---|
| Client | 4095 | `FULL_MSG_SIZE` = 8191 + 512 = 8703 |
| Server / handshake | 8191 | 512 (legacy P10 body) |

Overrun exits the connection with `Excess Flood: tag region too large` or
`Excess Flood: message region too large` (clients) /
`Excess Flood: S2S body exceeds 512` (servers).

### Queue-depth cap

The limit is the class `recvq`, falling back to the feature `CLIENT_FLOOD`
(default 1024 bytes). `get_recvq()` (`ircd/class.c:325`) resolves it by
walking the connection's attached confs for the first one with a class and
caches the answer in `con_max_recvq`. `/OPER` resets the cache
(`ircd/m_oper.c:230`) so the Opers class value takes over.

The cap is enforced with one full message of headroom
(`get_recvq() + FULL_MSG_SIZE`), because the recvQ may legitimately hold a
single large in-flight line (SASL OAUTHBEARER, a big-tag PRIVMSG) before
the parse loop has run:

1. **Read gate** (`ircd/s_bsd.c:1118`): if a registered user's queue is
   already over the limit, the server does not read the socket at all.
   This is TCP back-pressure, not a kill.
2. **Post-append check** (`ircd/s_bsd.c:1533`): if the queue is over the
   limit after an append, the client is exited with `Excess Flood`.

Line handling details:

- A line without CRLF stays queued while the queue is under
  `FULL_MSG_SIZE - 2` (`FLAG_NONL` is set and parsing waits for more).
  Over that, the queue is cleared and the client gets `ERR_INPUTTOOLONG`.
- Lines left in the queue when the parse loop stops (see fakelag) are
  retried by a 2-second process timer (`ircd/s_bsd.c:1585`,
  `client_timer_callback` re-enters `read_packet` with `socket_ready = 0`).
- Multiline batch size is budgeted at the parser layer
  (`FEAT_MULTILINE_MAX_BYTES` in `m_batch.c`), not here.

### Servers

Server links never use the receive queue. A registered server, and a link
still in handshake, is handed straight from the read buffer to
`server_dopacket` / `connect_dopacket` (`ircd/s_bsd.c:1167-1197`). The
depth cap is gated on `IsUser()`, so it cannot apply. Only the per-line
classifier runs, with the server profile above.

### WebSocket

Frames are decoded and the payload is appended to the same recvQ
(`ircd/s_bsd.c:1487`), under the same classifier. Frames that add no recvQ
bytes (PING, PONG, empty data or continuation frames) would escape every
meter, so they have their own debt clock (`con_ws_ctl_since`,
`include/websocket.h:40`): +2 s per frame, and a client more than 20 s
ahead of now is closed with 1008 and exited as `Excess Flood`. A data frame
over `WS_MAX_PAYLOAD` (16384) gets Close 1009.

## 2. Fakelag: the per-connection debt clock

Fakelag is a timestamp, not a counter. Each connection carries `cli_since`
(`con_since`), a time that commands push into the future. It "drains" at
one second per second simply because it is compared against
`CurrentTime`. Three rules define it.

### Charging (`ircd/parse.c:1651-1671`)

For each command parsed from a client:

```
lagmin    = class fakelagminimum   (unset / -1  ->  2)
lagfactor = class fakelagfactor    (unset / -1  ->  120)

if ((cmd is MFLG_SLOW || sender is not an oper) && lagfactor > 0)
    cli_since += lagmin + bytes / lagfactor
```

`fakelagfactor = 0` in the class disables fakelag for that class entirely.
`get_lag_min()` / `get_lag_factor()` (`ircd/class.c:354,383`) resolve and
cache the class values the same way as recvq; a cached value of -2 forces a
fresh class lookup.

### Stalling (`ircd/s_bsd.c:1537-1538`)

```
while (recvQ has data && !NoNewLine && (IsTrusted || cli_since - CurrentTime < 10))
    parse one line
```

Lines are parsed only while the clock is less than 10 s ahead of now.
Past that, the remaining lines sit in the recvQ and the 2-second timer
retries them. **Fakelag never disconnects anyone by itself.** The only kill
in this area is the recvQ byte cap: a client that keeps sending while
stalled eventually fills the queue and is exited as `Excess Flood`.

### Floor (`ircd/s_bsd.c:1131`)

On every read that delivers data, if `cli_since` has fallen behind
`cli_lasttime` it is pulled up to it. Idle time never banks a surplus
below "now". (Until 2026-10-20 the post-registration credit was a clock
set below now, and this floor erased it on the first read after 001; it
is a separate credit now, see below.)

With the defaults (2 s minimum, 10 s window) a client gets a burst of about
five commands and then one every two seconds.

### Who is charged

- **Opers** skip the charge only for commands *not* flagged `MFLG_SLOW`.
  That list is short: AUTHENTICATE, BOUNCER SESSION / TRANSFER, CACHEINVAL,
  CAP, FINGERPRINT, GLINE, MULTILINE, SASL, SETHOST, SHUN, STARTTLS,
  WALLHOPS, ZLINE. Everything else (PRIVMSG, JOIN, WHO, MODE...) is SLOW
  and charges opers too. The practical oper exemption is an Opers class
  with `fakelagfactor = 0`. `/OPER` resets the cached values
  (`ircd/m_oper.c:231-232`) so the Opers class applies from then on.
- **Pre-registration is free.** `struct Connection` is zeroed at
  allocation (`ircd/list.c:160`), so the cached factor reads 0 and the
  `lagfactor > 0` test fails until registration forces a class lookup
  (`ircd/s_user.c:497-498`). This is deliberate so SASL OAUTHBEARER
  pipelining is not throttled. The recvQ byte cap still applies
  (`CLIENT_FLOOD`, no class attached yet).
- **Authenticated clients get a one-shot credit after 001.**
  `FEAT_POSTREG_GRACE` (default 20 s) goes into `con_lagcredit`, and
  `fakelag_charge()` (`include/fakelag.h`, called from the charge in
  `ircd/parse.c`) spends it: each command's charge is absorbed by the
  credit first and only the remainder reaches the clock. Granted at
  fresh registration, held-session revive and alias attach. Every
  command is still charged; the initial budget is ~15 commands instead
  of ~5, enough for the MONITOR / METADATA SUB / WHO / MODE burst modern
  clients send. The credit only decreases (it survives idle time, the
  clock floor cannot touch it). Anonymous connections keep the classic
  burst.
- **Multiline batches** are not charged per line while the batch is open
  (`ircd/parse.c:1669`, gated on `cli_ml_batch_id`). On a *successful*
  close (`multiline_apply_cooldown`, `ircd/m_batch.c:668`) the connection
  pays a flat `MULTILINE_COOLDOWN_BASE` (2 s) on `cli_since` plus a
  multiline-only cooldown:

  ```
  raw     = 2 + total_bytes / 128
  applied = raw * FEAT_MULTILINE_COOLDOWN_DISCOUNT / 100
  con_ml_cooldown_until = now + applied
  ```

  The cooldown blocks only the next `BATCH +draft/multiline`; other
  commands are unaffected. Discount 0 = no cooldown and no flat charge.
  Rejected batches pay nothing.
- **Shunned clients** have their commands dropped (`ircd/parse.c:1645`)
  before the charge point, so shunned traffic costs nothing on the clock.
- **Servers** are `IsTrusted` (`STAT_CONNECTING | STAT_HANDSHAKE |
  STAT_ME | STAT_SERVER`), which bypasses the parse-loop gate, and server
  traffic never goes through `parse_client` anyway. There is no fakelag on
  S2S.

### Writers of `cli_since` (complete list)

| Where | Effect |
|---|---|
| `ircd/list.c:249`, `ircd/s_auth.c:1489` | reset to now at connect / auth start |
| `ircd/s_bsd.c:1132` | floor to last-read time |
| `ircd/parse.c:1670` | per-command charge |
| `ircd/m_batch.c:694` | flat multiline close charge |
| `ircd/s_user.c`, `ircd/bouncer_session.c` (grant sites) | post-registration credit, via `con_lagcredit`, not `cli_since` |

## 3. SendQ: outbound bytes

Every local connection owns a message queue (`MsgQ`, `cli_sendQ`) with a
normal and a priority lane. All output enters through `send_buffer()`
(`ircd/send.c:1224`), which is where the cap lives.

### The cap

The limit is the class `sendq`, falling back to the feature
`DEFAULTMAXSENDQLENGTH` (default 40000). `get_sendq()` (`ircd/class.c:296`)
resolves and caches it like recvq; `/OPER` resets it.

If the queue is **already** over the cap when a new line arrives
(`ircd/send.c:1249`), the connection is dropped via
`dead_link(to, "Max sendQ exceeded")`. For a server, an `SNO_OLDSNO`
notice `Max SendQ limit exceeded for <server>: <len> > <cap>` goes to opers
first. Nothing is throttled before this point: the queue either drains or
the link dies.

### Draining

- `send_buffer` adds the line, lists the connection on `send_queues`,
  arms write interest (`update_write`), and flushes immediately if the line
  is priority or the queue just crossed another 1 KB boundary
  (`cli_lastsq`).
- `send_queued()` (`ircd/send.c:1137`) loops `deliver_it()` until the queue
  is empty or the socket blocks. `flush_connections()` (`ircd/send.c:1113`)
  walks `send_queues` once per main-loop pass.
- `deliver_it()` (`ircd/s_bsd.c:394`) does the non-blocking `writev` (or
  `SSL_write`). A partial write sets `FLAG_BLOCKED`; the `ET_WRITE` event
  (`ircd/s_bsd.c:1883`) clears it and calls `send_queued` again.
- **Priority** lines (the ping check's PING, WALLOPS, services traffic under
  `FLUSH_ULINE_IMMEDIATE`) jump the queue, except on a blocked TLS socket:
  OpenSSL must be re-handed the exact record it refused, so a priority line
  queued while blocked is demoted to in-order (`ircd/send.c:1244-1247`).
- **WebSocket**: the sendQ holds raw IRC lines; `deliver_it` frames them on
  the way out, one frame per CRLF. A partially written frame is held in
  `con_ws_txrem` so the retry presents identical bytes.
- **Global memory** for dbufs and msgqs is bounded by `FEAT_BUFFERPOOL`
  (27 MB default); past it allocations fail and the affected client is
  exited (`dbuf_put fail`).

### Producers that pace themselves on the sendQ

- `/LIST` continues (`list_next_channels`) only on a writable event with the
  queue under 2048 bytes (`ircd/s_bsd.c:1886`).
- Bouncer replay continues under the same 2048-byte rule
  (`ircd/s_bsd.c:1884`) and additionally stops when the queue exceeds
  `FEAT_REPLAY_SENDQ_THRESHOLD` percent of the cap (default 50,
  `sendq_replay_ok`, `ircd/replay.c:819`). 0 disables that check.

### Servers

Server links use exactly the same mechanism with a different class (the
Connect block's class). The only differences are the size and the oper
notice. There is no pacing on S2S output, so a peer that stops reading for
long enough is dropped with `Max sendQ exceeded`: the classic sendq split.

## 4. Configuration summary

Class block keys (`doc/example.conf:115-157`):

```
Class {
  sendq = size;             # bytes; default DEFAULTMAXSENDQLENGTH (40000)
  recvq = size;             # bytes; default CLIENT_FLOOD (1024)
  fakelagminimum = number;  # seconds per command; unset -> 2
  fakelagfactor = number;   # bytes per extra second; unset -> 120; 0 = off
};
```

Features: `CLIENT_FLOOD`, `DEFAULTMAXSENDQLENGTH`, `BUFFERPOOL`,
`POSTREG_GRACE` (20), `MULTILINE_COOLDOWN_DISCOUNT`,
`REPLAY_SENDQ_THRESHOLD` (50).

### What the testnet bed runs (`tools/docker/base.conf-dist`)

| Class | sendq | recvq | fakelag |
|---|---|---|---|
| Server, LeafServer | 9,000,000 | n/a (servers skip recvQ) | n/a |
| Users, Local | 160,000 | unset -> 1024 (+8703 headroom) | factor 0: disabled |
| Opers | 160,000 | unset -> 1024 (+8703 headroom) | unset -> 2 s + len/120 |

On the bed, ordinary clients are never fakelagged. The Opers class, lacking
the two fakelag keys, is the only client class that is actually throttled,
and that for every SLOW command (which is nearly all of them).

## 5. Quick reference

| | Client | Server link |
|---|---|---|
| RecvQ depth cap | class `recvq` / CLIENT_FLOOD + one message; `Excess Flood` | not used; bytes go straight to the parser |
| Per-line cap | tags 4095, line 8703 | tags 8191, body 512 |
| Fakelag | `lagmin + len/factor` per command; stall at 10 s ahead; never kills | none (`IsTrusted`) |
| SendQ cap | class `sendq` / DEFAULTMAXSENDQLENGTH; `Max sendQ exceeded` | same, plus an oper notice |
