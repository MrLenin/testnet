# send_buffer NULL-deref via synchronous ET_ERROR re-entrancy

**Status:** Diagnosis complete, fix prototyped in working tree, **not committed**
**Author:** ibutsu
**Date:** 2026-05-19

## Summary

`send_buffer` (send.c:1116) NULL-derefs `cli_sendM(to)` when an
`epoll_ctl` failure inside `update_write` triggers a synchronous
`ET_ERROR` event that recursively tears down the same client the
outer `exit_client` is in the middle of sending an ERROR line to.

Trigger: any path where `exit_client → sendrawto_one → send_buffer`
runs against a client whose fd is invalid (EBADF, ENOENT, etc.).
Reliably reproduced by `tests/src/ircv3/recvq-flood.test.ts` which
creates rapid pre-reg clients that get killed.  Rare but possible in
production at high churn.

Both our fork and upstream are affected (same send.c / engine_epoll.c
shape, same unguarded `exit_client_msg` in `client_sock_callback`).

## Diagnosis

### The crash

Valgrind:
```
==1== Invalid read of size 4
==1==    at 0x224FE7: send_buffer (send.c:1116)
==1==    by 0x22517E: sendrawto_one (send.c:1165)
==1==    by 0x213043: exit_client (s_misc.c:803)
==1==    by 0x2140DD: exit_client_msg (s_misc.c:1039)
==1==    by 0x1911DB: check_pings (ircd.c:620)
==1==  Address 0xa0 is not stack'd, malloc'd or (recently) free'd
==1== Process terminating with default action of signal 11 (SIGSEGV)
```

Offset confirmation via gdb:
```
$ gdb -batch -ex 'p (int)&((struct Connection*)0)->con_sendM' ircd
$1 = 160        # == 0xA0
```

So `cli_connect(to)` was `NULL` at the increment.

### Why cli_connect went NULL mid-function

Disassembly of send_buffer (release build, gcc -O2 -g):
```
+316: mov  %rbp,%rsi              ; buf
+319: call msgq_add                ; queues ERROR — succeeds (log line emitted)
+324: mov  0x20(%rbx),%rdi         ; rdi = to->cli_connect
+335: call client_add_sendq         ; succeeds
+343: call update_write             ; <-- recursive cleanup runs inside
+348: mov  0x20(%rbx),%rax          ; reload to->cli_connect (NULL after recursion)
+359: addl $0x1,0xa0(%rax)          ; CRASH: NULL+0xa0
```

Compiler reloads `to->cli_connect` after `update_write` because it
cannot prove the call doesn't mutate.  Empirically it does — see
chain below.

### The re-entrancy chain

1. `check_pings` periodic sweep → `auth_ping_timeout(cptr)` →
   `exit_client_msg(cptr, cptr, &me, "Registration Timeout")` →
   **outer** `exit_client`.
2. Outer `exit_client` at `s_misc.c:768` sets `FLAG_CLOSING` on victim.
3. Outer `exit_client` at `s_misc.c:803` calls
   `sendrawto_one(victim, "ERROR :Closing Link: ...")`.
4. Inside `send_buffer`: `msgq_add` ✓, `client_add_sendq` ✓.
5. `update_write(to)` → `socket_events` → `engine_set_events`
   ([engine_epoll.c:225-236](nefarious/ircd/engine_epoll.c#L225-L236)).
6. `epoll_ctl(EPOLL_CTL_MOD, fd, ...)` returns -1 (fd is dead, EBADF).
7. On `epoll_ctl < 0`, `engine_set_events` calls
   `event_generate(ET_ERROR, sock, errno)`.
8. Nefarious's event model is **synchronous** —
   `event_add == event_execute` (see [[project-libkc-event-adapter]]).
   `event_generate(ET_ERROR)` immediately invokes
   `client_sock_callback` on the same client.
9. `client_sock_callback(ET_ERROR)` at [s_bsd.c:1556-1589](nefarious/ircd/s_bsd.c#L1556-L1589):
   sets `FLAG_DEADSOCKET`, calls `ssl_abort`, falls through.
10. At [s_bsd.c:1687](nefarious/ircd/s_bsd.c#L1687):
    `exit_client_msg(cptr, cptr, &me, fmt, msg)` — **recursive
    exit_client mid-frame of outer**.
11. Inner `exit_client`: this time `IsDead` is true, so the
    sendrawto_one at line 803 is correctly skipped.  Proceeds through
    cleanup: `exit_one_client → close_connection → ...
    → remove_client_from_list` which zeroes `cli_connect`,
    then `dealloc_client` (freelist alloc — memory stays mapped on
    `clientFreeList`, doesn't `free()`, which is why valgrind reports
    "not stack'd/malloc'd/freed" instead of UAF).
12. Stack unwinds back into outer `send_buffer` at line 1116.
13. `++(cli_sendM(to))` = `++((cli_connect(to))->con_sendM)`.
    `cli_connect(to)` is now NULL → NULL+0xa0 deref → SIGSEGV.

### Why this is rare in production but reliable under our flood tests

- The fd must be invalid at the exact moment `update_write` runs
  inside `exit_client`'s sendrawto_one.
- Pre-registration clients are the typical victim — their fds can
  race with auth state cleanup, NIO error paths, SSL handshake
  failures, etc.
- Our `recvq-flood.test.ts` rapidly fires `exit_client` against
  pre-reg clients with dying fds — reliable reproduction.
- The code at [s_bsd.c:1647](nefarious/ircd/s_bsd.c#L1647) already
  asserts `0 == cli_connect(cptr) || con == cli_connect(cptr)` —
  i.e. the codebase already acknowledges this is a legal state, but
  `send_buffer` doesn't defend against it.

## Proposed fix

Re-entrancy guard in `client_sock_callback` just before the final
unguarded `exit_client_msg`:

```c
/* Re-entrancy guard.  Nefarious's event model is synchronous
 * (event_add == event_execute).  If we got here via an ET_ERROR
 * synthesised from inside engine_set_events on epoll_ctl failure —
 * which can happen when send_buffer → update_write → socket_events
 * tries to MOD a dead fd — then the outer frame is already inside
 * exit_client (FLAG_CLOSING set at s_misc.c:768).  A recursive
 * exit_client_msg here would run remove_client_from_list, zero
 * cli_connect, and return into the outer send_buffer mid-line,
 * which then NULL-derefs at `++cli_sendM(to)`.  Let the outer
 * frame finish the teardown; we've already marked DEADSOCKET. */
if (HasFlag(cptr, FLAG_CLOSING))
  return;

exit_client_msg(cptr, cptr, &me, fmt, msg);
```

Patched in working tree at [nefarious/ircd/s_bsd.c](nefarious/ircd/s_bsd.c)
around line 1687.  **Not committed.**

### Why this fix shape

- **Localised.**  Single place, single condition.  Doesn't touch
  the event model or the engine_*.c family.
- **Uses an existing flag.**  `FLAG_CLOSING` is pre-existing
  (defined `set when closing to suppress errors`) and is already
  set at the entry of `exit_client` for MyConnect victims.  No new
  state.
- **No false positives.**  The flag is only set inside
  `exit_client` for local clients — exactly the case we want to
  short-circuit.
- **Preserves cleanup semantics.**  The outer frame will continue
  through `exit_one_client → close_connection → ...` after
  send_buffer returns.  FLAG_DEADSOCKET is already set by inner
  ET_ERROR handling, so dead-fd accounting is correct.

### Alternatives considered

**Defer ET_ERROR generation to next event-loop iteration**
*(engine_set_events level)*.  Cleaner from a model perspective —
synchronous re-entry from inside a syscall failure is dubious — but
requires changes in every engine_*.c, plus an event-deferral
mechanism that nefarious doesn't currently use uniformly.  Larger
blast radius; deferred.

**Defensive NULL check in send_buffer**.  E.g.
`if (!cli_connect(to)) return;` after `update_write(to)`.  Catches
the specific symptom but doesn't fix the underlying invariant
violation, and other code holding a Client* across `update_write`
remains vulnerable (replay.c, m_list.c also call update_write).
Rejected as papering over the bug.

**Recursion counter / lock on the Client**.  Generic re-entrancy
protection.  Over-engineered for a single observed re-entry path.

## Test coverage

The bug is already covered by `tests/src/ircv3/recvq-flood.test.ts`
indirectly — without the fix, nefarious crashes within ~8.5 minutes
of a single test run under valgrind, due to check_pings sweeping the
test's leftover pre-reg clients.

Pre-fix run: container exited code 1, valgrind log shows the SIGSEGV
trace above.
Post-fix run: 6/6 pass, container survives, fresh valgrind log is
36 lines (just startup banner).

If we want a dedicated test pinning this specific race, it would
need to:
1. Connect a client.
2. Force its fd into EBADF state mid-registration (hard from
   userspace — typically requires a kill-switch in test infrastructure
   or a fault-injection harness in nefarious itself).
3. Trigger auth_ping_timeout.

Easier path: rely on `recvq-flood.test.ts` as the integration-level
trip-wire and add a comment there pointing at this plan.

## Upstream impact

Upstream nefarious2 has the **identical** code shape:

- [nefarious-upstream/ircd/send.c:244-254](nefarious-upstream/ircd/send.c#L244-L254):
  same `msgq_add → client_add_sendq → update_write → ++cli_sendM`
  sequence.
- [nefarious-upstream/ircd/engine_epoll.c:217](nefarious-upstream/ircd/engine_epoll.c#L217):
  same synchronous `event_generate(ET_ERROR, sock, errno)` on
  epoll_ctl failure.
- `client_sock_callback` ends with the same unguarded
  `exit_client_msg`.

All other engine_*.c files (kqueue, select, devpoll, poll) emit
`event_generate(ET_ERROR, ...)` from at least one syscall-failure
site.  All of them route into `client_sock_callback` for client
sockets, so the single guard at the end of that function covers
every engine on every platform.

The fix is upstreamable.  Two lines + comment, no new flags or
helpers.  Would suggest landing on upstream as a separate small
commit (not bundled with our IRCv3 work) so it can be cherry-picked
to maintenance branches.

## Open questions

- **Should `update_write` be made non-recursive at the engine level?**
  The synchronous `event_generate(ET_ERROR, ...)` from inside
  `epoll_ctl` failure is a pattern that bites here.  Deferring to
  next iteration would close the entire class of "re-entered during
  send" bugs.  But it's a bigger change.  Out of scope for this
  fix; worth a separate design pass.

- **Are there other re-entrancy paths into client_sock_callback that
  this guard would inadvertently swallow?**  Inspection of all
  `event_generate(ET_ERROR, ...)` call sites shows they all originate
  from engine_*.c syscall-failure handlers, which fire either from
  socket setup or from `engine_set_events/set_state` calls inside
  `socket_events`.  `socket_events` is called from `update_write`
  and from a handful of state-change sites.  None of those are
  expected to be inside an exit_client frame other than via
  send_buffer.  Risk seems low.

- **Should we instrument production?**  Adding a log line or
  counter when the guard fires would tell us how often this
  re-entrancy actually happens.  Cheap to add.  Decide after
  shipping the fix.

## Decision needed

Ship the FLAG_CLOSING guard as a single small commit:
- here (fork) for our immediate stability
- upstream as a cherry-pickable patch

Or hold for a deeper redesign of the synchronous event-error
dispatch.  Recommendation: ship the guard now (proven safe under
testing, addresses the observed crash) and treat the deeper
redesign as a separate follow-up.
