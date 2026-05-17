# Bouncer registration-deferral 30s wait — investigation

**Status:** Investigated 2026-05-12; concluded "bounded by netburst physics, not a hardcoded timeout"
**Author:** ibutsu

## Question

When a bouncer client completes SASL during an in-progress netburst, the
client sees:

```
NOTICE * :*** Bouncer: SASL complete, waiting for burst convergence before
                 registration (usually <30s)
```

…and waits up to ~30s before completing registration. Is the 30s a hardcoded
timeout we can shorten?

## Trace

- [s_auth.c:723-733](nefarious/ircd/s_auth.c#L723-L733) — after SASL completes,
  if `bounce_burst_in_progress()` is true and the account is bouncer-enabled,
  `bounce_defer_registration()` queues the client.
- [bouncer_session.c:7750-7813](nefarious/ircd/bouncer_session.c#L7750-L7813) —
  pending list; drained in `bounce_drain_pending_registrations()`.
- [m_endburst.c:140-142](nefarious/ircd/m_endburst.c#L140-L142) — at every
  `END_OF_BURST`, if no peer is still bursting, drain pending registrations.

## Conclusion

The 30s is **not a hardcoded timeout**. It is the actual netburst settling
time — drain fires the moment the last peer's `END_OF_BURST` arrives and
`bounce_burst_in_progress()` returns 0. The "<30s" string in the notice is
calibration prose for the operator.

## Why the deferral exists

`register_user()` broadcasts `N` network-wide synchronously. If we registered
immediately during burst, the fresh standalone primary would race the peer's
in-flight `N` for the same account at non-bouncer-aware peers (legacy ircu),
which would KILL on `user@host` collision before any BX gate could converge.

Per [memory: project_bouncer_burst_desync.md], D.2 at-N-time handles
BX-aware peers, but legacy peers can't participate in the gate.

## What it would take to shorten

Three theoretical levers — none are "reasonable" right now:

**A. Per-account convergence tracking** (preferred long-term).
Add a new BX subcommand "all peers have introduced their N for account
`<acct>`." Release just that account's pending registration instead of
waiting burst-wide. Requires: new wire token; peer-count tracking in
session-table; replay path for late peers. Multi-week.

**B. Optimistic release + retract-on-collision** (risky).
Register immediately, KILL the local primary if a colliding N arrives later.
Visible to the user as "logged in… then kicked." Reintroduces the bug the
deferral was built to fix.

**C. Compress burst content** (already enabled via `--with-zstd`).
Burst is already as fast as the link can carry the data. Returns are
diminishing without burst-content reduction.

## Verdict

Don't fix. The 30s is bounded by burst duration, which is bounded by
network volume. The deferral is already optimal for the current wire
protocol. If we want sub-burst registration, lever A is the right
direction, but it's a deferred design item — file it under "post-merge,
post-rocksdb."

## Cross-reference

- [memory: project_bouncer_burst_desync.md] — original observation
- `.claude/plans/bouncer-burst-revive.md` — adjacent at-N-time path
