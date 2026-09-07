# Fakelag burst credit — per-connection reserve + global bonus pool

**Status:** Design (not implemented)
**Author:** ibutsu (with input from Rubin)
**Date:** 2026-06-01

## Motivation

The current `cli_since`-based fakelag is already an inverted token
bucket: `cli_since - now` is debt, every command adds
`~2 * lineFakelag` of debt, wall-clock drains it at 1 sec/sec, hit
`flood_limit` (~10s) and you die.  That shape is fine — it's tight
under sustained load and it doesn't penalise short bursts inside the
flood window.

The complaint is at the *idle → burst* transition.  Today, the
read-side resets `cli_since` to `now` if the client has been idle
([s_bsd.c:946-950](nefarious/ircd/s_bsd.c#L946-L950)):

```c
cli_lasttime(cptr) = CurrentTime;
if (cli_lasttime(cptr) > cli_since(cptr))
    cli_since(cptr) = cli_lasttime(cptr);
```

So idle time avoids penalty, but is *not banked*.  A user who's been
idle in a channel for 10 minutes gets exactly the same flood
allowance as one who has been actively typing — the moment they
start a burst, the normal 5-or-so command window kicks in and the
6th command stalls.

Rubin and ibutsu both want more burstiness at this transition: idle
should *earn* something.  The constraint: don't weaken steady-state
flood protection — abusers must not be able to "bank" credit they
didn't actually earn through real idle time.

## Investigation — current fakelag path

### Throttle gate

[s_bsd.c:1284](nefarious/ircd/s_bsd.c#L1284):

```c
if (DBufLength(&(cli_recvQ(cptr))) < 8192 &&
    (IsTrusted(cptr) || cli_since(cptr) - CurrentTime < 10))
  /* allow this client to be parsed */
```

`< 10` is the flood-window cap.  Anything that pushes
`cli_since - now` above 10 stalls the client until the bucket drains.

### Idle reset

[s_bsd.c:946-950](nefarious/ircd/s_bsd.c#L946-L950): snap `cli_since`
forward to `cli_lasttime` (= `CurrentTime`) on read.  Idle time
collapses to zero — no credit, no carry-over.

### Per-line bump

[parse.c:~1641](nefarious/ircd/parse.c#L1641): `cli_since += lag`
where `lag` is `2 * lineFakelag` (or the multiline charge).  This is
the debit side of the bucket — every command bumps `cli_since`
forward by 2 seconds (default).

### Existing exemptions

`IsTrusted(cptr)` (oper / U-line / server) bypasses the throttle.
Multiline cooldown is a separate timer ([[project-multiline-cooldown-redesign]],
shipped `b252f03`) that runs alongside `cli_since` for batch open.

## Proposal — three-tier credit: global pool → per-connection → cli_since

Two new meters on top of `cli_since`, each protecting a different
abuse mode and rewarding a different "good behaviour":

1. **Global burst pool** — *server-wide* shared credit bucket.
   Refills at a steady rate up to a cap.  Drains whenever any client
   bursts.  Quiet server → pool full → bonus headroom for everyone.
   Busy server → pool empty → falls back to per-connection layer.
   Rewards the network for being quiet by being more generous when it
   is.
2. **Per-connection bucket** — idle-banked credit, per Connection.
   Carries over real idle time as the client's *guaranteed minimum*
   burst budget.  Refills only during this connection's own idle
   time, capped at a per-connection max.  Survives even when the
   global pool is drained — the client's "earned" share.

Each command spends in this order:

1. **Global pool first** (if available).  The bonus is consumed
   first so the per-connection bucket — which represents *earned*
   reserve — stays full as long as possible.
2. **Per-connection bucket** (if global pool is empty).  The
   guaranteed minimum: even on a fully-saturated server, a client
   with banked idle credit can still burst.
3. **cli_since** (if both above are empty).  Today's mechanism.
   Kill on overflow.

Both new meters refill independently and have their own caps.
Sending a command advances *only the relevant meter's* refill
clock — the one it spent from — so an idle client banks per-
connection credit during quiet periods while a busy server keeps
the global pool drained.

### Why this hybrid

Pure per-connection (the first draft of this plan) has each user
banking their own reserve — predictable, unaffected by other users,
but doesn't scale with server load (a quiet server is no more
generous than a busy one).  Pure global pool (proposed mid-design)
is load-adaptive but tragedy-of-commons: a few aggressive clients
drain the pool and OAUTH connect-bursts become load-dependent — bad
for the "OAUTH always works" guarantee we want.

Hybrid gets both:
- Per-connection floor guarantees OAUTH/connect-bursts and
  idle-then-burst patterns work *regardless of server load*.
- Global bonus pool adds slack during quiet periods, naturally
  throttling during busy ones — and the throttling shows up where
  it can fail gracefully (sustained interactive use), not at the
  guarantees-we-care-about layer.

### State

**Per-Connection** (each user's earned reserve):

```c
struct Connection {
    /* ... existing fields ... */
    time_t       con_burst_credit;        /* banked credit, in seconds */
    time_t       con_burst_credit_last;   /* last refill clock */
};
```

Cost: 16 bytes per Connection (two `time_t`).

Reuse rather than re-derive `cli_lasttime` for the refill clock — they
look similar but have different semantics: `cli_lasttime` records
real activity for many purposes (idle calc, PING response, etc.),
while `con_burst_credit_last` records "last time we updated the
credit bucket" and is bumped on both refill and spend.  Keeping them
separate avoids accidental cross-talk.

**Global** (server-wide bonus pool):

```c
/* ircd/parse.c or s_bsd.c, file-scope or extern */
static time_t global_burst_pool_credit;       /* current pool credit, seconds */
static time_t global_burst_pool_last_refill;  /* last refill clock */
```

Cost: 16 bytes once, server-wide.  Initialised at startup to
`FEAT_BURST_POOL_INITIAL` (default = `FEAT_BURST_POOL_MAX`, full
pool at boot — generous to the connect-burst of users who land
right after a restart).

Single-threaded ircd, so no locking needed for the global state.
Both meters use `CurrentTime` (the per-read cached time), which is
already the standard idiom in the parse path.

### Refill logic — at the same site as the idle-reset

In [s_bsd.c:946-950](nefarious/ircd/s_bsd.c#L946-L950), replace the
current snap-to-now with credit refill:

```c
cli_lasttime(cptr) = CurrentTime;
if (cli_lasttime(cptr) > cli_since(cptr))
    cli_since(cptr) = cli_lasttime(cptr);

{
    time_t since_refill = CurrentTime - con_burst_credit_last(cli_connect(cptr));
    if (since_refill > 0) {
        time_t gain = (since_refill * feature_int(FEAT_BURST_CREDIT_REFILL_NUM))
                    / feature_int(FEAT_BURST_CREDIT_REFILL_DEN);
        con_burst_credit(cli_connect(cptr)) += gain;
        if (con_burst_credit(cli_connect(cptr)) > feature_int(FEAT_BURST_CREDIT_MAX))
            con_burst_credit(cli_connect(cptr)) = feature_int(FEAT_BURST_CREDIT_MAX);
        con_burst_credit_last(cli_connect(cptr)) = CurrentTime;
    }
}
```

(Numerator/denominator split lets the refill rate be a fraction — see
"Knobs" below.)

### Spend logic — three-tier at the per-line debit in parse.c

Replace the per-line `cli_since += lag` with a global-first, then
per-connection, then `cli_since` path:

```c
int lag = 2 * lineFakelag;
int remaining = lag;

/* Tier 1: global pool */
refill_global_pool();   /* lazy refill — see below */
if (global_burst_pool_credit > 0) {
    int spend = (global_burst_pool_credit >= remaining)
              ? remaining
              : global_burst_pool_credit;
    global_burst_pool_credit -= spend;
    remaining -= spend;
}

/* Tier 2: per-connection bucket */
if (remaining > 0 && con_burst_credit(cli_connect(cptr)) > 0) {
    int spend = (con_burst_credit(cli_connect(cptr)) >= remaining)
              ? remaining
              : con_burst_credit(cli_connect(cptr));
    con_burst_credit(cli_connect(cptr)) -= spend;
    con_burst_credit_last(cli_connect(cptr)) = CurrentTime;
    remaining -= spend;
}

/* Tier 3: fall through to cli_since for whatever's left */
if (remaining > 0)
    cli_since(cptr) += remaining;
```

Each tier supports fractional spend — a client with 1.5 commands'
worth in the per-connection bucket and a 2-command lag spends 1.5
from the bucket and bills the remaining 0.5 to `cli_since`.  No
partial credit is wasted at a tier boundary.

`refill_global_pool()` is a small inline helper that does the
`(now - last_refill) * rate` accumulator (capped at MAX) for the
global pool — called once per command from this spend path.
Lazy refill means the pool only updates when it's about to be
spent, which is fine — refill is monotonic and the gain is the
same whether computed lazily or continuously.

### Two-phase grant — fill at make_connection AND reset at register_user

Connection lifetime has two distinct burst phases, each of which needs
a full bucket independently:

1. **Pre-registration** (make_connection → register_user): `CAP LS`,
   one or more `CAP REQ`, multiple `AUTHENTICATE` rounds for SASL
   (OAUTH is 4-6 rounds), `NICK`, `USER`, `CAP END`.
2. **Post-registration churn** (register_user → steady state):
   initial `JOIN`s for autojoin channels, `MODE` for initial user
   modes, `WHO` / `WHOIS` / `MONITOR` calls, and now `CHATHISTORY`
   requests against each channel to backfill recent activity.  Modern
   IRCv3 clients fire all of this within the first 1-2 seconds after
   001.

Funding both from a single bucket-at-connect-time is borderline:
pre-reg can drain most of it (especially OAUTH), and the post-reg
churn would arrive with whatever crumbs are left.  Cleaner: grant a
fresh full bucket at **each** phase boundary.

Concretely:

- `make_connection`: set `con_burst_credit = FEAT_BURST_CREDIT_INITIAL`
  (default = `FEAT_BURST_CREDIT_MAX`).  Refill clock starts here.
- `register_user` (at the IsHandshake → IsUser transition, alongside
  RPL_WELCOME): set `con_burst_credit = FEAT_BURST_CREDIT_MAX` again
  (i.e. reset to full, regardless of remaining balance).  Refill
  clock advances to `CurrentTime`.

The reset-to-max at register_user is unconditional — any unspent
pre-reg credit doesn't carry over to the post-reg burst (would be
double-banking), but a partly-drained pre-reg bucket gets topped up
to a fresh full bucket for the post-reg churn.  This matches the
mental model: pre-reg and post-reg are different work units that
deserve independent budgets.

**Why not a single oversized initial bucket instead?**  An obvious
alternative is "set `INITIAL` to e.g. `2 * MAX` and skip the reset" —
simpler in code.  But that's abusable: a bot can connect, drain the
oversized bucket against pre-reg-allowed commands (CAP traffic
generation, AUTHENTICATE spam, etc.), disconnect, and reconnect for
a fresh oversized grant — no registration required.  The two-grant
shape naturally gates the second bucket behind *actually completing
registration*, which means a bot has to pass SASL/NICK/USER (and any
require_sasl class settings) before getting more credit.  The
abuse-cost is "you have to actually be a real user to keep getting
generous treatment," which is exactly what we want.

This is wider than originally scoped (post-registration only) for a
real reason: pre-registration in the nefarious source is *not*
fakelag-exempt today.  `IsTrusted` ([client.h:1031](nefarious/include/client.h#L1031))
covers server-side states (`STAT_CONNECTING | STAT_HANDSHAKE |
STAT_ME | STAT_SERVER`) but **not** `STAT_UNKNOWN_USER`, and the
parse-time gate at [parse.c:1628](nefarious/ircd/parse.c#L1628) is
`(MFLG_SLOW || !IsAnOper) && lagfactor > 0` — so a pre-reg user pays
full lag on every command.  With default `lagmin=2`, that's ~5
commands of headroom before the throttle fires — comfortably under
the SASL OAUTH command count, so the make_connection grant matters.

Bucket refills during AUTHENTICATE wait time (server-roundtrip is
typically 100ms-1s per round, partially refunding the spend), so the
20-second bucket comfortably covers the typical pre-reg sequence
even when each individual command costs 1-2 seconds.  Then the
register_user reset takes care of the post-reg churn cleanly.

Legacy clients (NICK + USER + maybe PING-PONG + a couple of JOINs)
don't burst hard at either phase boundary and don't exercise the
full bucket, but they retain it for whatever idle-then-burst
behaviour comes later.  No CAP-vs-legacy discrimination needed: the
grant + reset are universal, legacy just doesn't exercise either.

### Knobs

**Per-connection bucket — conservative base, CAP-gated bonuses:**

| Feature                          | Default                  | Meaning                                                                 |
|----------------------------------|--------------------------|-------------------------------------------------------------------------|
| `FEAT_BURST_CREDIT_MAX`          | 20 (seconds)             | Base bucket cap.  ~10 commands at `lineFakelag=1`.                      |
| `FEAT_BURST_CREDIT_INITIAL`      | `FEAT_BURST_CREDIT_MAX`  | Credit granted at `make_connection`.  Default = full base bucket.       |
| `FEAT_BURST_CREDIT_REFILL_NUM`   | 0                        | Base refill numerator.  **Default 0 = no steady-state refill.**         |
| `FEAT_BURST_CREDIT_REFILL_DEN`   | 1                        | Base refill denominator.                                                |

The default base refill of `0/1` is deliberate.  After the
connect-burst window (make_connection + register_user grants), a
vanilla client gets *no* steady-state refill — their bucket only
fills via the explicit grants and stays drained after they spend it.
This matches the principle that **the majority of real burstiness
need is pre/post-reg, not steady-state**.  Steady-state interactive
use is well-served by the global pool + cli_since.

**Per-CAP bonuses** (additive on top of base, only while the CAP is
active on this connection):

| CAP                     | Refill bonus      | Cap bonus | Rationale                                                          |
|-------------------------|-------------------|-----------|--------------------------------------------------------------------|
| `draft/typing`          | +1/sec            | +30s      | Strongest case.  TAGMSG burst pattern: each composed message lands as `+typing=active` + (optional `+typing=paused` mid-thought) + PRIVMSG.  The high-impact case is **idle → come back → react to backlog**: 5–10 outgoing messages with associated typing TAGMSGs = 15–30 wire commands in a few seconds, on top of any backlog-induced /msg targeting. |
| `draft/chathistory`     | +1/2 sec          | +10s      | Pagination requests can be bursty (BEFORE/AFTER chains)            |
| `monitor` / `MONITOR`   | +1/2 sec          | +10s      | Monitor list updates land in bursts                                |
| `draft/multiline`       | 0                 | 0         | Has its own cooldown timer ([[project-multiline-cooldown-redesign]])|

Bonuses are summed across all CAPs active on the Connection at the
moment of refill.  A client that has typed + chathistory + multiline
all negotiated gets `+1 + 0.5 + 0 = +1.5/sec refill` and
`+30s cap`.  Multiline contributes nothing here because its
burstiness is enforced by a different mechanism — listing it
explicitly in the table is documentation, not double-counting.

Implementation: per-CAP bonuses live in a small static table next
to the CAP definitions.  Refill walks the active-CAP bitmap once
per refill event and sums entries.  At ~4 entries today (and small
table churn over time) the cost is trivial; if it grows beyond a
dozen, cache the computed effective rate on the Connection and
invalidate on CAP ACK / DEL.

**Global pool:**

| Feature                          | Default                  | Meaning                                                                 |
|----------------------------------|--------------------------|-------------------------------------------------------------------------|
| `FEAT_BURST_POOL_MAX`            | 200 (seconds)            | Server-wide pool cap.  ~100 commands' worth of bonus headroom.          |
| `FEAT_BURST_POOL_INITIAL`        | `FEAT_BURST_POOL_MAX`    | Pool credit at boot.                                                    |
| `FEAT_BURST_POOL_REFILL_NUM`     | 1                        | Pool refill numerator.                                                  |
| `FEAT_BURST_POOL_REFILL_DEN`     | 1                        | Pool refill denominator.  Default 1/1 = 1 credit/sec real time.        |

Defaults give:
- New connections start with a full 20s per-connection bucket from
  the connect-grant.  Spend hits the global pool first, leaving the
  bucket intact for the post-reg reset.
- Pool refills at 1 credit/sec real time, capping at 200 (~100
  commands of server-wide bonus headroom, or 10/sec sustained).
- Vanilla client steady state: no per-conn refill.  Bucket drains
  on first idle-to-burst; subsequent bursts depend on the pool +
  cli_since.
- CAP-active client steady state: per-conn refill = sum of bonuses
  from active CAPs.  Typing-CAP client gets `+1/sec, +20s cap` —
  comfortably absorbs the typing-indicator command pattern
  indefinitely.

Pool defaults are admin-tunable per server size.  Small server
(~50 clients): consider lowering `BURST_POOL_REFILL` to keep pool
proportional to expected command rate.  Large server (~1000+):
raise `MAX` and `REFILL` to keep the pool responsive.  No good
universal default — pick numbers that match the interactive
command rate of your user base.

### Exemptions

- `IsTrusted(cptr)` — already bypasses fakelag entirely; credit logic
  no-ops because the throttle gate never fires.
- `IsServer(cptr)` — server connections don't fakelag; same as today.
- The multiline cooldown timer ([[project-multiline-cooldown-redesign]])
  is independent: it gates batch *open*, not per-line, and runs on
  `con_ml_cooldown_until` not `cli_since`.  Burst credit doesn't
  interact with it.

### Bouncer interaction

Each alias is a separate `Connection` with its own credit pool.
That's the right call — each alias is a separate IRC session from the
user's perspective, with its own typing cadence.  Sharing credit
across aliases would let one alias bank credit that another alias
spends, which sounds clever but is a flood-amplification path.

## Memory model

State added per Connection: **16 bytes** (two `time_t`).  No allocation,
no lifecycle.  Initialised to `FEAT_BURST_CREDIT_INITIAL` in
`make_connection`; reset to `FEAT_BURST_CREDIT_MAX` in `register_user`.

State added server-wide: **16 bytes** (two `time_t` file-scope statics
for the global pool).  No locking — single-threaded ircd.

State removed: none — `cli_since` and `cli_lasttime` stay.

## What this gives users

| Scenario                                                        | Today                       | After                                                                            |
|-----------------------------------------------------------------|-----------------------------|----------------------------------------------------------------------------------|
| Quiet server, idle 5 min, fire 5 commands                       | 5th command may stall       | All 5 free from global pool, per-conn bucket untouched                          |
| Quiet server, sustained typing 30 seconds                       | Same as today               | Pool absorbs most, per-conn bucket as backstop, no `cli_since` impact            |
| **Typing-CAP client: idle, come back, react to backlog**        | 6th+ command stalls         | 20–30 wire commands (typing TAGMSGs + PRIVMSGs) absorbed by `draft/typing` bonus cap (+30s = 50 total) |
| Busy server (pool drained), idle 5 min, fire 5 commands         | 5th command may stall       | All 5 free from per-conn bucket (the guaranteed reserve)                         |
| Busy server, sustained typing 30 seconds                        | Same as today               | Per-conn bucket drains fast, then `cli_since` accounting (today's behaviour)     |
| OAUTH SASL on busy server                                       | At-risk of throttle today   | Per-conn bucket guarantees OAUTH connect-burst regardless of pool state          |
| Coordinated burst from N bots                                   | Each hits cli_since         | First drains pool, rest hit per-conn buckets — capped at per-bot earned reserve  |
| Flood attack from cold start                                    | Killed via flood_limit      | ~10 free commands then killed (per-conn bucket is per-attacker cap)              |

The key property: the global pool's tragedy-of-commons is bounded by
the per-connection bucket.  No matter how aggressively other clients
drain the pool, your own banked-idle reserve is intact.  And no
matter how much the global pool refills during quiet hours, an
attacker can only spend their own per-connection bucket once before
their `cli_since` accounting kicks in — global pool credit only
makes the *first* burst easier, not every subsequent one.

## Migration

Four commits, each independently reversible:

**1. Add per-connection credit fields + refill logic, default to disabled.**
Add `con_burst_credit`, `con_burst_credit_last`, accessor macros, the
per-connection refill block in `s_bsd.c`, the two-grant points in
`make_connection` and `register_user`.  Don't change spend logic
yet.  Set `FEAT_BURST_CREDIT_MAX` default to `0` so the bucket never
fills.  No-op deployable — verifies field plumbing without
changing behaviour.

**2. Add global pool + three-tier spend logic in parse.c.**  Add the
global pool statics, the `refill_global_pool()` helper, and the
three-tier spend path at the per-line debit.  With both
`BURST_CREDIT_MAX=0` and `BURST_POOL_MAX=0` from commit 1 this is
still a no-op; the spend just falls all the way through to
`cli_since` like today.

**3. Flip per-connection default + admin-facing docs.**
`FEAT_BURST_CREDIT_MAX` default to 20, `_REFILL_NUM/_DEN` to 1/1.
Per-connection layer goes live first — pool stays disabled.
Document the per-connection knobs in `doc/example.conf` +
`doc/readme.features`.  This validates the per-connection
guarantees (OAUTH/autojoin) without the load-adaptive complexity
yet.

**4. Flip global pool default + admin-facing docs.**
`FEAT_BURST_POOL_MAX` default to 200, `_REFILL_NUM/_DEN` to 1/1.
Pool goes live.  Document.  This is where the "quieter server =
more burstiness" behaviour starts showing up; admins can monitor
pool refill/drain rates and tune.

## Testing

### Unit / CMocka

- Credit accrual math: `(now - last) * num / den`, saturating at MAX.
- Spend ordering: credit drained first, then cli_since, with
  fractional spend handled.
- `BURST_CREDIT_MAX=0` → bucket never fills; behaviour identical to
  today's `cli_since`-only path.
- Refill clock advances on both refill and spend (no double-bank
  during a fast send + idle + send sequence).

### Integration (testnet)

New file: `tests/src/ircv3/fakelag-burst-credit.test.ts`.

Per-connection layer:

- Connect, idle for 25 seconds, fire 12 PRIVMSG/PING commands
  back-to-back (with global pool drained beforehand).  Expect all 12
  succeed within 1 second (per-conn bucket was at cap = 20; 12
  commands × 2s lag = 24s < 20s credit + small cli_since slack).
- Same scenario with `BURST_CREDIT_MAX=0` server-side: expect 5–6
  commands through before the 7th stalls.  Confirms the knob works
  and that disabling reproduces today's behaviour.
- Sustained typing — send a command every 1.9 seconds for 60
  seconds.  Per-conn credit never accumulates (each send advances
  refill clock).  No kill, no stall.

Global pool layer:

- Drain the pool by issuing rapid commands across many test
  connections, then connect a fresh client and assert their
  per-conn bucket is consumed (not the pool, which is empty).
- Refill the pool by leaving the server idle for `BURST_POOL_MAX`
  seconds, then connect one client and burst — assert the per-conn
  bucket is *untouched* (pool absorbed it all).
- OAUTH-style mid-handshake test: drain the pool, connect with
  CAP+SASL OAUTH simulating 5 AUTHENTICATE rounds, assert the SASL
  flow completes (per-conn bucket guarantees it regardless of pool
  state).

Cross-tier interaction:

- Two clients, both idle.  Pool drained by a third client.  Verify
  both idle clients can still burst from their per-conn buckets
  independently — no cross-talk.
- One client bursts repeatedly to drain their per-conn bucket while
  pool is full.  Verify they get global pool credit on top of the
  per-conn bucket (total ~30 commands before cli_since impact, not
  ~10).

Flood from cold start (no prior idle, both pools assumed full):
- Fire commands as fast as possible.  Expect kill via flood_limit
  but with the higher bucket+pool ceiling — `~POOL_INITIAL +
  CREDIT_INITIAL + FLOOD_LIMIT` total commands before death.  Verify
  the kill still fires (it's just deferred).

### Regression

Run the existing flood-protection tests with `BURST_CREDIT_MAX=0` —
must match today's pass/fail exactly.  Then re-run with the new
default — verify no test that relied on "5 commands then stall"
silently widens to "15 commands then stall" (that's the intended
behaviour change but tests need updated thresholds).

## Client-side adaptation — advertise via vendor-prefixed ISUPPORT token

Well-behaved clients can pace themselves to match server policy if the
server tells them what it is.  Use **vendor-prefixed ISUPPORT tokens**
(RPL_ISUPPORT, numeric 005) for the advertisement.  ISUPPORT has no
formal vendor-namespace mechanism, but the de-facto convention used by
InspIRCd, UnrealIRCd and others is `VENDOR/TOKEN=VALUE`, which is
collision-safe enough in practice and self-documenting.

Sketch:

```
:server.afternet.org 005 nickname \
  evilnet/FAKELAG=2 evilnet/FLOOD-LIMIT=10 \
  evilnet/BURST-CREDIT-MAX=20 evilnet/BURST-CREDIT-REFILL=1/1 \
  evilnet/BURST-POOL-MAX=200 evilnet/BURST-POOL-REFILL=1/1 \
  :are supported by this server
```

Values mirror the `count/duration` shape that PR #589 uses for
`CHANLIMITS` so the per-connection (this plan) and per-channel
([[channel-mode-f]]) halves stay symmetric.  `evilnet/FAKELAG` is
seconds-per-line, `evilnet/FLOOD-LIMIT` is the kill threshold in
seconds-of-debt, `evilnet/BURST-CREDIT-MAX` is per-connection
bucket cap in seconds, `evilnet/BURST-CREDIT-REFILL` is `num/den`.
`evilnet/BURST-POOL-MAX` and `evilnet/BURST-POOL-REFILL` describe
the global pool — these are *static config*, not live state; a
client reading them learns the pool *size* and *refill rate* but
not the current credit level (which is server-internal and changes
constantly).  That's fine — the pool is bonus headroom, not a
guarantee.  Clients only need the per-connection numbers to
pace themselves predictably.

Vendor prefix: `evilnet/` — the upstream-org namespace under which
both Nefarious and X3 ship.  Not `AFTERNET/`, which is just the
network running the testnet — we want extensions to namespace under
the implementation, not the operator.  When companion specs mature
in IRCv3 (the per-connection fakelag side of
[ircv3-specifications#589](https://github.com/ircv3/ircv3-specifications/pull/589),
which currently only covers channel-level), drop the prefix if/when
the unprefixed names land in the spec.

Pairs with the channel-flood work ([[channel-mode-f]]) — same vendor
prefix, same `count/duration` rate language.  ISUPPORT covers
per-connection knobs (no CAP needed; unknown 005 tokens are ignored
by spec).  PR #589's in-band `CHANLIMITS` message covers per-channel
and gets its own CAP since it's a new server-initiated command; any
evilnet extension to that side ships under a dedicated
`evilnet/...` CAP rather than vendor-extending #589's standardized
CAP (see [[feedback-evilnet-extensions-own-cap]]).

## Open questions

- **Default refill rates:** Per-conn 1/1 (one credit per second idle)
  is intuitive ("idle N seconds, get N credit").  Pool refill is
  harder to pick a universal default for since it depends on server
  command-rate.  Maybe scale `BURST_POOL_REFILL` defaults with
  expected connection count — small server gets 1/2, large gets 2/1.
  Or land 1/1 universal and let admins tune.

- **Pool refill rate scaled by connection count?** A natural
  extension: instead of fixed `POOL_REFILL`, scale it by current
  `UserStats.local_clients`.  Quiet hours with 10 clients →
  refill = 10/sec; busy hours with 1000 → refill = 1000/sec.  Keeps
  per-user pool share roughly constant.  Pro: load-adaptive in both
  directions.  Con: pool ceases to throttle aggressively at scale
  — which might be the *wrong* behaviour (a 1000-user server should
  bursty-throttle harder, not less).  Default to fixed for now.

- **Per-class cap on per-conn bucket:** today's `flood_limit` is
  per-class (10s for normal, bigger for trusted).  `BURST_CREDIT_MAX`
  could follow the same per-class shape.  Implementation: read the
  class's flood headroom + a multiplier rather than a single global
  feature flag.

- **Credit visibility to user:** `/STATS` extension or a `NOTICE
  AUTH :You have X seconds of burst credit` line?  Probably no —
  keep the meters invisible.  Users who care about throttling care
  about *whether the next command will be throttled*, which is the
  combination of pool + per-conn + `cli_since`; surfacing any single
  one is misleading.  Spec'd `BURST-CREDIT-MAX` etc. ISUPPORT values
  tell well-behaved clients what to pace against without exposing
  the live state.

- **Pool drain visibility for opers:** `/STATS p` (pool) showing
  current credit, refill rate, drain rate over the last N seconds?
  Useful for admin tuning ("is my pool size right?").  Probably yes,
  oper-only.

- **Interaction with `IRCV3_TAG_MAX` flood:** tagged commands are
  still subject to `recv_classify` byte caps (see
  [[per-class-recvq-buffers]]).  Burst credit covers fakelag (the
  per-line wall-clock charge), not the byte-flood cap — a client
  with 20s of credit who pipes 100 KB of garbage still dies on
  recvQ overflow.  Good — independent meters, independent abuse
  modes.

- **`cli_lasttime` vs `con_burst_credit_last`:** I argued for
  separate fields to avoid cross-talk.  Worth double-checking the
  `cli_lasttime` callers — if they all want "real activity time"
  semantics, the split is correct.  Quick audit during commit 1.

- **Pre-existing similar work:** if upstream evilnet/nefarious2 has
  contemplated this or merged something similar, align the field
  layout.  Quick `git log --all --grep=fakelag` on upstream before
  committing.

- **Pool persistence across restart:** today the pool resets to
  `INITIAL` on boot.  Should it persist (e.g. in the tunefile next
  to `local_clients_max`)?  Argument for: continuity across reboots
  — clients reconnecting right after a restart don't get a
  freshly-full pool acting as a flood window.  Argument against:
  added complexity for marginal gain, and `INITIAL` is admin-
  tunable to whatever startup posture they want.  Lean against.

## Not blocking

Current fakelag is correct, just abrupt at the idle → burst
transition.  Land this when bouncer + IRCv3 work has settled and the
per-line hot path can absorb another structural change.  Pair with
the [[recv-buffer-shrink]] work if both land in the same review
cycle — they both touch `read_packet` adjacent code.
