# Nefarious Event Loop Precision

## Current Design: 1-Second Granularity

The entire event system runs on **1-second granularity**. Here's the chain:

### Global Clock

`CurrentTime = time(NULL)` — updated once per loop iteration after the I/O syscall returns (`ircd/ircd.c:875`).

### Timers

Stored as `time_t` (whole seconds) in `t_expire` and `t_value` fields (`include/ircd_events.h:162-167`). Expiration is a simple integer compare: `CurrentTime < ptr->t_expire` (`ircd/ircd_events.c:569`).

Timer types:
- **TT_ABSOLUTE**: `t_expire = t_value` (fire at a specific wall-clock second)
- **TT_RELATIVE**: `t_expire = t_value + CurrentTime` (fire N seconds from now)
- **TT_PERIODIC**: Same as relative, re-enqueued after each fire

### Poll Timeout

Calculated as `(timer_next - CurrentTime) * 1000` for epoll (`ircd/engine_epoll.c:287`), but since both values are whole seconds, the timeout is always a multiple of 1000ms. kqueue and select explicitly zero their sub-second fields (`tv_nsec = 0`, `tv_usec = 0`).

### Loop Behavior

The loop blocks on the I/O multiplexer until either a socket has activity or the next timer fires. It does not spin-poll. `FEAT_POLLS_PER_LOOP` (default 200, minimum 20) controls the max events processed per iteration.

### Precision Summary

| Aspect | Resolution | Notes |
|--------|-----------|-------|
| Global Time (CurrentTime) | 1 second | `time_t`, updated only after syscall returns |
| Timer Storage | 1 second | `time_t t_expire` field |
| Timer Expiration Check | 1 second | Integer comparison only |
| Poll Timeout (epoll) | 1 millisecond | But calculated from 1-sec diff x 1000 |
| Poll Timeout (kqueue) | 1 second | Only tv_sec used, tv_nsec = 0 |
| Poll Timeout (select) | 1 microsecond | Possible but tv_usec always = 0 |
| Event Batching | Tunable | 20-200 events per loop (default 200) |
| Main Loop Frequency | I/O-driven | Blocks until next timer or I/O event |

## Would Increasing Precision Help?

Switching to sub-second timers (e.g., `gettimeofday()` or `clock_gettime()`) would mean:

### Potential Benefits

- **Faster SASL/auth flows** — the 0-second timer trick used in `ircd/ircd_kc_adapter.c` for deferred socket cleanup currently rounds to "next loop iteration." With ms-precision timers, you could express 5ms or 50ms delays instead of relying on the semantic ambiguity of `TT_RELATIVE, 0`.
- **Tighter ping/pong and timeout detection** — currently connection timeouts, PING intervals, and registration timeouts all snap to 1-second boundaries. A client that's 0.9s late looks the same as one that's 0.1s late.
- **Smoother rate limiting** — flood control, throttling, and similar features could be more granular instead of bucketing everything into 1-second windows.
- **More accurate chathistory timestamps** — `server-time` tags currently derive from `CurrentTime` which is only updated once per loop pass, so all messages processed in one batch share the same timestamp.

### Realistic Assessment

For an IRC server, **1-second precision is fine for almost everything**. IRC has always been a seconds-granularity protocol. The main place it actually hurts is the timestamp batching — multiple messages in a single loop pass get identical `server-time` tags, which can cause ordering ambiguity in chathistory. But even that's an edge case under normal load.

The biggest practical win would be if you're seeing timer-related jitter in the SASL/libkc async flows, where the coarse rounding means a "fire ASAP" timer might not execute for up to ~1 second if the loop is idle. Under load this is masked (I/O activity wakes the loop), but on a quiet server it could add perceptible latency to auth.

**TL;DR**: Not worth the refactor unless you're hitting a specific problem with auth latency on idle servers or chathistory timestamp collisions. The 0-second timer idiom works well enough in practice.
