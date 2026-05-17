# NICKDELAY redesign — exponential backoff with cap + freebies

**Status:** Planning (not implemented)
**Author:** ibutsu
**Date:** 2026-05-12

## Current behavior

[s_user.c:1109-1128](nefarious/ircd/s_user.c#L1109-L1128) — flat `FEAT_NICKDELAY`
seconds (default 30) between nick changes. `cli_nextnick` is bumped by
`NICKDELAY` on every successful change; if the next attempt is within
`cli_nextnick`, refuse with `ERR_NICKTOOFAST` and add 2 seconds penalty.

A "freebie" exists: if the user didn't change nick for over 60s,
`cli_nextnick < CurrentTime` so the next change is unthrottled (and the
counter resets implicitly).

Result: every 30 seconds, one nick change. Fine for steady-state, but:

- Even **first** nick change after registration counts against the cap,
  making `/nick foo` on connect feel sluggish (no it doesn't — initial
  registration sets nextnick lower; but the principle of "first changes
  should be cheap" is unenforced).
- The 2-second penalty for an attempt-while-throttled is fixed; a real
  clone bot hammering NICK gets the same penalty as a fat-fingered user.
- No exponential pressure on repeat offenders.

User's stated intent (from prior conversation):
- exponential backoff with a cap
- a few freebies (so legitimate use isn't punished)

## Proposed design

Per-client state on Client struct:

```c
time_t  cli_nextnick;       /* existing — earliest time next change OK */
uint16_t cli_nick_changes;  /* new — count in current window */
time_t  cli_nick_decay;     /* new — when count last decayed */
```

Three knobs (features):

- `FEAT_NICKDELAY_BASE` — base delay (default 30)
- `FEAT_NICKDELAY_FREEBIES` — count of changes before throttling kicks in
  (default 3)
- `FEAT_NICKDELAY_CAP` — maximum delay (default 600 = 10 min)
- `FEAT_NICKDELAY_DECAY` — seconds without a change before counter halves
  (default 120)

### Algorithm

On nick-change attempt:

1. **Decay counter.** If `CurrentTime - cli_nick_decay >= FEAT_NICKDELAY_DECAY`:
   halve `cli_nick_changes` (floor 0); reset `cli_nick_decay` to now.
2. **Freebies.** If `cli_nick_changes < FEAT_NICKDELAY_FREEBIES`:
   allow immediately; increment `cli_nick_changes`; set `cli_nextnick`
   to `CurrentTime + BASE`; return OK.
3. **Throttle.** Compute required delay:
   `delay = min(BASE << (cli_nick_changes - FREEBIES), CAP)`.
4. If `CurrentTime < cli_nextnick`: reject with `ERR_NICKTOOFAST`;
   `cli_nextnick += 2` (existing penalty for impatient retry).
5. Else: allow; increment `cli_nick_changes`; set
   `cli_nextnick = CurrentTime + delay`; reset `cli_nick_decay`.

### Example traces

Default config: BASE=30, FREEBIES=3, CAP=600, DECAY=120.

| Change # | Delay imposed | Notes                          |
|----------|---------------|--------------------------------|
| 1        | 0s (freebie)  | counter=1                      |
| 2        | 0s (freebie)  | counter=2                      |
| 3        | 0s (freebie)  | counter=3 — last freebie       |
| 4        | 30s           | counter=4, 1 << 1 = 2 → 60? No, see below |
| 5        | 60s           | counter=5                      |
| 6        | 120s          | counter=6                      |
| 7        | 240s          | counter=7                      |
| 8        | 480s          | counter=8                      |
| 9        | 600s (cap)    | counter=9                      |

Adjustment: `delay = min(BASE * (1 << (changes - FREEBIES - 1)), CAP)`
gives the table above when changes=4 → 30s × 1 = 30s.

After 2 min of inactivity, counter halves; user gets some grace back.

## Compatibility

- Existing `FEAT_NICKDELAY` deprecated → aliased to `FEAT_NICKDELAY_BASE`
  (or stays as the legacy flat behavior if new knobs all 0).
- Default of FREEBIES=3 means non-flooders never feel a change vs. today
  (today they get 1 change/30s, new gives 3 instant + back to 30s ramp).
- Existing `ERR_NICKTOOFAST` numeric reused.

## Implementation order

1. Add 3 new struct fields + 3 features.
2. Rewrite the block at s_user.c:1109-1128 per algorithm above.
3. Tests:
   - 3 nick changes back-to-back → all succeed (freebies)
   - 4th immediate → 30s wait
   - 5th immediate after 30s → 60s wait
   - Wait 4 min, retry → freebies replenished
   - Cap test: 20 rapid changes → never exceeds 600s

## Open questions

1. **Bouncer interaction.** A bouncer client's NICK changes across reconnects
   shouldn't accumulate. Reset `cli_nick_changes` on bouncer revive (the
   ghost is a different process-level identity).
2. **Oper exemption.** Should opers bypass entirely? Current code doesn't
   exempt; preserve that (opers throttled too).
3. **/services use.** When ChanServ/AuthServ trigger nick changes (regain,
   release), should they be exempt? Already exempt — services are servers,
   only `IsUser(cptr)` triggers this block.

## Not blocking

Tests don't currently exercise nick-flood timing. Defer until either a
user complaint or a flood incident motivates it.
