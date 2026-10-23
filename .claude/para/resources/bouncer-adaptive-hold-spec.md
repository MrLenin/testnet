<!-- Source: https://gist.github.com/MrLenin/c2dbd7bad0a6b2af471cdfe059a79c46 (bouncershit.md, updated 2026-01-29); recovered 2026-10-20 while fixing the hold timer (memory bouncer-hold-not-adaptive). The implementation diverged: hs_connect_count (resumes + alias attaches, 2bb04f9) replaced hs_attach_count in the formula; bounce_hold_client() arms the flat base; the accrual lives in the dead bounce_detach(). -->

## Phase 4: Adaptive Hold Times

**Goal:** The longer a user actively uses the bouncer, the longer their session lingers when they disconnect. Abandoned sessions decay back to the base hold and expire.

### Design Rationale

With automatic bouncer (Phase 2), each account has one session — their persistent network identity. The question is: how long should that session be held when the user disconnects?

A flat hold time (e.g. 4 hours) treats a daily user the same as someone who connected once. That's wrong. A user who has bounced daily for a month has demonstrated that they come back — their session should wait longer. Conversely, a session that nobody resumes is abandoned and should expire sooner, not linger at whatever hold time it earned.

- **Earned hold**: Each resume extends the session's hold time. Usage builds trust.
- **Idle decay**: A held session that nobody resumes loses its earned hold over time, decaying toward the base. Abandoned sessions don't linger.

### New Session Fields

Add to `BouncerSession` in `bouncer_session.h`:

```c
unsigned int hs_attach_count;         /**< Number of times resumed */
time_t hs_total_active;             /**< Cumulative active time (seconds) */
```

`hs_attach_count` tracks how many times the session has been resumed. `hs_total_active` accumulates time spent in ACTIVE state (updated on each detach: `hs_total_active += CurrentTime - hs_last_active`).

### Adaptive Hold Duration

Replace the fixed hold time with a computed value:

```c
static time_t bounce_compute_hold_time(struct BouncerSession *session)
{
  time_t base = feature_int(FEAT_BOUNCER_SESSION_HOLD);  /* default 4h */
  time_t max  = feature_int(FEAT_BOUNCER_MAX_HOLD);      /* default 14d */

  /* Never-resumed sessions get base hold only */
  if (session->hs_attach_count == 0)
    return base;

  /* Scale by attach count: each resume adds 25% of base, capped at max */
  time_t bonus = base * session->hs_attach_count / 4;
  time_t computed = base + bonus;

  /* Additional bonus for cumulative active time: 1h per 24h active */
  if (session->hs_total_active > 0)
    computed += (session->hs_total_active / 86400) * 3600;

  /* Idle decay: the longer a session sits in HOLDING without being
   * resumed, the less hold time it earns on subsequent expiry checks.
   * Decay starts after 50% of the computed hold has elapsed idle.
   * Each additional 25% of computed hold spent idle halves the
   * remaining hold time. This means actively-used sessions keep
   * their earned hold, while abandoned sessions shed it. */
  if (session->hs_disconnect_time > 0) {
    time_t idle = CurrentTime - session->hs_disconnect_time;
    time_t decay_start = computed / 2;
    if (idle > decay_start) {
      time_t over = idle - decay_start;
      time_t decay_unit = computed / 4;
      if (decay_unit > 0) {
        int halvings = over / decay_unit;
        if (halvings > 0) {
          time_t remaining = computed - idle;
          for (int i = 0; i < halvings && remaining > base; i++)
            remaining = remaining / 2;
          /* Floor at base hold — never decay below the minimum */
          computed = idle + ((remaining > base) ? remaining : base);
        }
      }
    }
  }

  return (computed > max) ? max : computed;
}
```

This replaces the current `feature_int(FEAT_BOUNCER_SESSION_HOLD)` call in `bounce_hold_client()` and the BS H handler.

**How idle decay works:**

A session earns hold time through usage (attaches, active time). But once it enters HOLDING, if it isn't resumed, that earned time decays:

1. **Grace period**: First 50% of computed hold passes with no penalty
2. **Decay phase**: After that, every additional 25% of computed hold spent idle halves the remaining hold time
3. **Floor**: Hold never decays below the base hold time (`FEAT_BOUNCER_SESSION_HOLD`)

**Practical effect**: Sessions that are truly abandoned lose their earned hold and expire closer to the base time. Sessions that are actively bounced keep their full earned hold because they never idle long enough to trigger decay.

**Scaling examples** (base = 4h, max = 14d):
| Attach count | Active time | Idle time | Hold duration |
|-------------|-------------|-----------|---------------|
| 0 (never resumed) | 0 | any | 4h (base, no earning) |
| 1 | 2h | 0 | 5h |
| 4 | 24h | 0 | 9h |
| 4 | 24h | 4.5h (grace) | 9h (no decay yet) |
| 4 | 24h | 7h (past grace) | ~6.5h (decaying) |
| 20 | 14d | 0 | 14d (max cap) |
| 20 | 14d | 10d (long idle) | ~4h (decayed to floor) |

### New Feature Flag

| Feature | Type | Default | Description |
|---------|------|---------|-------------|
| `FEAT_BOUNCER_MAX_HOLD` | int | 1209600 (14d) | Maximum adaptive hold time in seconds |
