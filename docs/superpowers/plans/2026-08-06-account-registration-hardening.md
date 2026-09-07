# Account-Registration Hardening Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Close the five standing items that block enabling `draft/account-registration` on an exposed network: cross-connection REGISTER rate limiting, SCRAM-gate parity with PLAIN (kills the legacy-account lockout), SPI identity scrub + the passwordPolicy provisioning gap, X3-residue measurement, and CAP value notification on policy flips.

**Spec:** `docs/superpowers/specs/2026-08-06-account-registration-hardening-design.md` (approved 2026-08-06).

**Architecture:** A new pure, CMocka-gated throttle module (`ircd/register_throttle.c`) consulted by `m_register.c`; one new scalar in `struct kc_user` parsed from `requiredActions` and used by the SCRAM gate; hand-written CAP-notify hooks replacing the value-less generic one; testnet provisioning fixes (SQL index, `passwordPolicy` in both realm bodies); SPI provider-ID rename with a sequenced live deploy.

**Tech Stack:** C (ircu/Nefarious), CMocka, jansson, Keycloak 26.4.7 admin REST, Java (Keycloak SPI, Maven), TypeScript/Vitest E2E.

**Repos/branches:** nefarious `feature/account-registration` (continue on it), keycloak-webhook-spi `feature/scram-attr-rename` (continue on it), testnet `main`.

## Global Constraints

- **Runtime facts already verified live (2026-08-06) — do not re-derive, do not "verify first":**
  - The Keycloak search-by-username endpoint (`/admin/realms/testnet/users?username=X&exact=true` — the endpoint `kc_user_get()` uses) **does include `requiredActions`** in its default representation. Part 2's primary design holds; the spec's fallbacks (a)/(b) are dead.
  - The live realm's `passwordPolicy` string is exactly `x3Scram` (no parentheses/arguments).
  - `cap_set_value()` (`ircd/m_cap.c:411`) never touches the notify batch — a value-only change notifies nobody. Part 5 is a real fix, not a comment.
- **Feature-table trap:** entries in the `enum Feature` (`include/ircd_features.h`) and the `features[]` table (`ircd/ircd_features.c`) MUST be in the same relative order — a mismatch is a boot assert (fleet-crash class). Insert new enum entries and table entries at matching positions.
- **Bed safety:** nefarious3–7 are the CRDT fleet with their own images — never build or recreate them. Use `scripts/dc.sh` only (never raw `docker compose`); scoped builds (`scripts/dc.sh -l build nefarious nefarious2`) and scoped `up -d nefarious nefarious2`. `up -d --build` is forbidden. Cross-server tests require rebuilding BOTH nefarious and nefarious2.
- **Uncommitted user hunks in `data/ircd.conf`** (`require_sasl yes→no` in the Bouncer class; Operator `*@*` → two scoped masks): these are the user's, must stay unstaged, byte-identical, never committed and never reverted. When committing conf changes, stage only your own hunks (`git add -p` or `git diff` + apply to index selectively). Verify with `git diff --cached` before committing.
- **Testing rules:** never run the full Vitest suite; targeted runs only (`cd tests && IRC_HOST=localhost npm test -- src/ircv3/account-registration.test.ts`). Never modify irctest files. Every new E2E test cleans up the accounts it mints (`trackCreatedAccount` + the file's existing afterAll cleanup).
- **libkc boundary:** files under `ircd/kc/` / `include/kc/` may not include ircd headers (`make check-kc-boundary` enforces; runs with every `make`).
- Host has full nefarious build deps: implementers run real `make` + CMocka on the host. Docker stays the canonical gate (Task 6).
- `FEAT_CAP_draft_account_registration` default stays **off**. Nothing in this plan enables it anywhere new.
- FAIL replies use standard-replies shape: `FAIL REGISTER <CODE> <account> :<message>` via the existing `send_fail()`.
- The throttle counts **attempts, not successes**, and opers bypass it.

---

### Task 1: `register_throttle` module (TDD, CMocka-gated)

**Files:**
- Create: `nefarious/include/register_throttle.h`
- Create: `nefarious/ircd/register_throttle.c`
- Create: `nefarious/ircd/test/register_throttle_cmocka.c`
- Modify: `nefarious/ircd/Makefile.in` (add `register_throttle.c` to the source list — mirror exactly how `m_register.c` appears, in every list it appears in, alphabetical position)
- Modify: `nefarious/ircd/test/Makefile.in` (CMOCKA_TESTPROGS non-KC section, DEP_SRC, build rule)

**Interfaces:**
- Produces (Task 2 consumes verbatim):
  ```c
  enum reg_throttle_result { REG_THROTTLE_OK = 0, REG_THROTTLE_IP, REG_THROTTLE_GLOBAL };
  enum reg_throttle_result reg_throttle_check(const struct irc_in_addr *ip,
                                              time_t now, int limit, int period,
                                              int global_limit);
  void reg_throttle_expire(time_t now, int period);
  void reg_throttle_clear(void);
  ```

Design points binding this task (from the spec):
- Per-IP rolling window with IPcheck's shape: counter resets when `period` has elapsed since the **last counted** attempt; otherwise increment and refuse at `limit`. Refusals do NOT update the window anchor (a hammering client must eventually get back in) and do not count.
- Server-wide fixed-window backstop: `global_limit` per `period`, anchored at the window's first attempt.
- `limit <= 0` disables the per-IP limiter; `global_limit <= 0` disables the global one; `period <= 0` disables both. Each independently.
- A per-IP refusal must NOT consume global budget (check per-IP first, return before the global block).
- IP canonicalization copies IPcheck's intent: IPv4 → 6to4 (`2002:aabb:ccdd::`), IPv6 keyed on the first /64 (words 4–7 masked to zero). One /64 = one budget.
- Fixed-size table, no allocation, no timers, no ircd includes beyond `res.h` (module must link standalone in CMocka with no stubs). No `log_write` in the module — callers log.
- Eviction: within a bucket prefer a free slot, then an expired entry, then the oldest live entry. Evicting a live entry is safe (worst case: extra budget).

- [ ] **Step 1: Write the header**

```c
/* include/register_throttle.h
 * Cross-connection throttle for the IRCv3 REGISTER command.
 *
 * Deliberately pure: the caller supplies the clock and the limits, the
 * module owns all state.  No struct Client, no feature reads, no timers,
 * no logging -- which is what lets the CMocka suite gate the arithmetic
 * without a running ircd.  See ircd/register_throttle.c.
 */
#ifndef INCLUDED_register_throttle_h
#define INCLUDED_register_throttle_h
#ifndef INCLUDED_sys_types_h
#include <sys/types.h>      /* time_t */
#define INCLUDED_sys_types_h
#endif

struct irc_in_addr;

enum reg_throttle_result {
  REG_THROTTLE_OK = 0,
  REG_THROTTLE_IP,        /* per-IP window exhausted */
  REG_THROTTLE_GLOBAL     /* server-wide cap reached */
};

/* Test-and-count in one call: on OK the attempt is recorded against both
 * limiters.  A refusal records nothing (a refused client must get back in
 * once the window since its last COUNTED attempt elapses).
 * limit <= 0 disables the per-IP limiter, global_limit <= 0 the global
 * one, period <= 0 both. */
extern enum reg_throttle_result reg_throttle_check(const struct irc_in_addr *ip,
                                                   time_t now, int limit,
                                                   int period, int global_limit);
/* Aging sweep: frees entries whose `period`-second window has elapsed
 * (period <= 0 frees everything).  Nothing schedules this -- expiry is
 * lazy (on contact); it exists for tests and any future caller that
 * wants to reclaim memory eagerly. */
extern void reg_throttle_expire(time_t now, int period);
/* Full reset (tests). */
extern void reg_throttle_clear(void);

#endif /* INCLUDED_register_throttle_h */
```

- [ ] **Step 2: Write the failing CMocka suite**

`ircd/test/register_throttle_cmocka.c`. The test build compiles the module with `-DREG_THROTTLE_TABLE_BITS=0` (one bucket) and `-DREG_THROTTLE_BUCKET_DEPTH=4`, so every address collides and eviction is exercised without hash gymnastics.

```c
/* register_throttle_cmocka.c - unit tests for ircd/register_throttle.c.
 * Compiled against a 1-bucket, 4-slot table (see test/Makefile.in) so the
 * eviction paths are reachable with arbitrary addresses. */
#include <stdarg.h>
#include <stddef.h>
#include <setjmp.h>
#include <string.h>
#include <cmocka.h>
#include <netinet/in.h>

#include "res.h"
#include "register_throttle.h"

static struct irc_in_addr mk_v4(int a, int b, int c, int d)
{
  struct irc_in_addr ip;
  memset(&ip, 0, sizeof(ip));
  ip.in6_16[6] = htons((a << 8) | b);
  ip.in6_16[7] = htons((c << 8) | d);
  return ip;
}

static struct irc_in_addr mk_v6(unsigned short w0, unsigned short w1,
                                unsigned short w2, unsigned short w3,
                                unsigned short w7)
{
  struct irc_in_addr ip;
  memset(&ip, 0, sizeof(ip));
  ip.in6_16[0] = htons(w0);
  ip.in6_16[1] = htons(w1);
  ip.in6_16[2] = htons(w2);
  ip.in6_16[3] = htons(w3);
  ip.in6_16[7] = htons(w7);
  return ip;
}

#define T0 1000000

static int setup(void **state)
{
  (void)state;
  reg_throttle_clear();
  return 0;
}

/* limit attempts pass, the next refuses */
static void test_ip_limit_exhaustion(void **state)
{
  struct irc_in_addr ip = mk_v4(10, 0, 0, 1);
  (void)state;
  assert_int_equal(REG_THROTTLE_OK, reg_throttle_check(&ip, T0,     3, 3600, 0));
  assert_int_equal(REG_THROTTLE_OK, reg_throttle_check(&ip, T0 + 1, 3, 3600, 0));
  assert_int_equal(REG_THROTTLE_OK, reg_throttle_check(&ip, T0 + 2, 3, 3600, 0));
  assert_int_equal(REG_THROTTLE_IP, reg_throttle_check(&ip, T0 + 3, 3, 3600, 0));
}

/* window elapses since last counted attempt -> fresh budget */
static void test_ip_window_reset(void **state)
{
  struct irc_in_addr ip = mk_v4(10, 0, 0, 2);
  (void)state;
  assert_int_equal(REG_THROTTLE_OK, reg_throttle_check(&ip, T0, 1, 60, 0));
  assert_int_equal(REG_THROTTLE_IP, reg_throttle_check(&ip, T0 + 30, 1, 60, 0));
  /* boundary: exactly period after the last COUNTED attempt (T0) */
  assert_int_equal(REG_THROTTLE_OK, reg_throttle_check(&ip, T0 + 60, 1, 60, 0));
}

/* refusals must not slide the window: hammering at t+30, t+45 does not
 * push recovery past T0+period */
static void test_refusals_do_not_extend_window(void **state)
{
  struct irc_in_addr ip = mk_v4(10, 0, 0, 3);
  (void)state;
  assert_int_equal(REG_THROTTLE_OK, reg_throttle_check(&ip, T0, 1, 60, 0));
  assert_int_equal(REG_THROTTLE_IP, reg_throttle_check(&ip, T0 + 30, 1, 60, 0));
  assert_int_equal(REG_THROTTLE_IP, reg_throttle_check(&ip, T0 + 45, 1, 60, 0));
  assert_int_equal(REG_THROTTLE_OK, reg_throttle_check(&ip, T0 + 60, 1, 60, 0));
}

/* distinct IPv4 addresses have independent budgets */
static void test_distinct_ips_independent(void **state)
{
  struct irc_in_addr a = mk_v4(10, 0, 0, 4), b = mk_v4(10, 0, 0, 5);
  (void)state;
  assert_int_equal(REG_THROTTLE_OK, reg_throttle_check(&a, T0, 1, 3600, 0));
  assert_int_equal(REG_THROTTLE_IP, reg_throttle_check(&a, T0 + 1, 1, 3600, 0));
  assert_int_equal(REG_THROTTLE_OK, reg_throttle_check(&b, T0 + 2, 1, 3600, 0));
}

/* IPv6: same /64 shares one budget, different /64 does not */
static void test_v6_slash64_grouping(void **state)
{
  struct irc_in_addr a = mk_v6(0x2001, 0xdb8, 1, 1, 0x0001);
  struct irc_in_addr b = mk_v6(0x2001, 0xdb8, 1, 1, 0xbeef); /* same /64 */
  struct irc_in_addr c = mk_v6(0x2001, 0xdb8, 1, 2, 0x0001); /* different /64 */
  (void)state;
  assert_int_equal(REG_THROTTLE_OK, reg_throttle_check(&a, T0, 1, 3600, 0));
  assert_int_equal(REG_THROTTLE_IP, reg_throttle_check(&b, T0 + 1, 1, 3600, 0));
  assert_int_equal(REG_THROTTLE_OK, reg_throttle_check(&c, T0 + 2, 1, 3600, 0));
}

/* zero disables each limiter independently; period<=0 disables both */
static void test_zero_disables(void **state)
{
  struct irc_in_addr ip = mk_v4(10, 0, 0, 6);
  int i;
  (void)state;
  for (i = 0; i < 50; i++)
    assert_int_equal(REG_THROTTLE_OK, reg_throttle_check(&ip, T0 + i, 0, 3600, 0));
  reg_throttle_clear();
  for (i = 0; i < 50; i++)
    assert_int_equal(REG_THROTTLE_OK, reg_throttle_check(&ip, T0 + i, 5, 0, 5));
}

/* global cap trips across distinct IPs even with per-IP disabled */
static void test_global_cap(void **state)
{
  struct irc_in_addr a = mk_v4(10, 1, 0, 1), b = mk_v4(10, 1, 0, 2),
                     c = mk_v4(10, 1, 0, 3);
  (void)state;
  assert_int_equal(REG_THROTTLE_OK,     reg_throttle_check(&a, T0,     0, 60, 2));
  assert_int_equal(REG_THROTTLE_OK,     reg_throttle_check(&b, T0 + 1, 0, 60, 2));
  assert_int_equal(REG_THROTTLE_GLOBAL, reg_throttle_check(&c, T0 + 2, 0, 60, 2));
  /* fixed window anchored at first attempt: frees at T0+60 */
  assert_int_equal(REG_THROTTLE_OK,     reg_throttle_check(&c, T0 + 60, 0, 60, 2));
}

/* a per-IP refusal must not consume global budget */
static void test_ip_refusal_spares_global(void **state)
{
  struct irc_in_addr a = mk_v4(10, 2, 0, 1), b = mk_v4(10, 2, 0, 2);
  (void)state;
  assert_int_equal(REG_THROTTLE_OK, reg_throttle_check(&a, T0,     1, 3600, 2));
  assert_int_equal(REG_THROTTLE_IP, reg_throttle_check(&a, T0 + 1, 1, 3600, 2));
  /* global still has 1 of 2 left; b consumes it, then trips */
  assert_int_equal(REG_THROTTLE_OK,     reg_throttle_check(&b, T0 + 2, 1, 3600, 2));
  /* b's per-IP budget is spent too, so use a third IP for the global trip */
  {
    struct irc_in_addr c = mk_v4(10, 2, 0, 3);
    assert_int_equal(REG_THROTTLE_GLOBAL, reg_throttle_check(&c, T0 + 3, 1, 3600, 2));
  }
}

/* with the test's 1x4 table, a 5th distinct live IP evicts the oldest */
static void test_eviction_oldest_live(void **state)
{
  struct irc_in_addr ip[5];
  int i;
  (void)state;
  for (i = 0; i < 5; i++)
    ip[i] = mk_v4(10, 3, 0, i + 1);
  for (i = 0; i < 4; i++)
    assert_int_equal(REG_THROTTLE_OK, reg_throttle_check(&ip[i], T0 + i, 1, 3600, 0));
  /* table full of live entries; the 5th evicts ip[0] (oldest) */
  assert_int_equal(REG_THROTTLE_OK, reg_throttle_check(&ip[4], T0 + 10, 1, 3600, 0));
  /* ip[0] got fresh budget by eviction (accepted safety trade-off) --
   * and its re-insert evicts the new oldest, ip[1] */
  assert_int_equal(REG_THROTTLE_OK, reg_throttle_check(&ip[0], T0 + 11, 1, 3600, 0));
  /* ip[3] (newest of the originals) was never evicted: still refused */
  assert_int_equal(REG_THROTTLE_IP, reg_throttle_check(&ip[3], T0 + 12, 1, 3600, 0));
}

/* expired entries are reused before live ones are evicted */
static void test_expired_reused_before_eviction(void **state)
{
  struct irc_in_addr ip[5];
  int i;
  (void)state;
  for (i = 0; i < 5; i++)
    ip[i] = mk_v4(10, 4, 0, i + 1);
  assert_int_equal(REG_THROTTLE_OK, reg_throttle_check(&ip[0], T0, 1, 60, 0));
  for (i = 1; i < 4; i++)  /* three live entries, well inside their window */
    assert_int_equal(REG_THROTTLE_OK, reg_throttle_check(&ip[i], T0 + 100, 1, 60, 0));
  /* ip[0]'s entry is expired at T0+100, so its slot is reclaimed by an
   * incoming address; with one slot still free, ip[4] fits without
   * touching any LIVE entry -- which is the property under test: */
  assert_int_equal(REG_THROTTLE_OK, reg_throttle_check(&ip[4], T0 + 101, 1, 60, 0));
  /* the live entries kept their state: all still refused */
  for (i = 1; i < 4; i++)
    assert_int_equal(REG_THROTTLE_IP, reg_throttle_check(&ip[i], T0 + 102, 1, 60, 0));
}

/* reg_throttle_expire frees expired entries; reg_throttle_clear frees all */
static void test_expire_and_clear(void **state)
{
  struct irc_in_addr a = mk_v4(10, 5, 0, 1), b = mk_v4(10, 5, 0, 2);
  (void)state;
  assert_int_equal(REG_THROTTLE_OK, reg_throttle_check(&a, T0, 1, 60, 0));
  assert_int_equal(REG_THROTTLE_OK, reg_throttle_check(&b, T0 + 50, 1, 60, 0));
  reg_throttle_expire(T0 + 70, 60);        /* a expired, b still live */
  assert_int_equal(REG_THROTTLE_OK, reg_throttle_check(&a, T0 + 71, 1, 60, 0));
  assert_int_equal(REG_THROTTLE_IP, reg_throttle_check(&b, T0 + 72, 1, 60, 0));
  reg_throttle_clear();
  assert_int_equal(REG_THROTTLE_OK, reg_throttle_check(&b, T0 + 73, 1, 60, 0));
}

int main(void)
{
  const struct CMUnitTest tests[] = {
    cmocka_unit_test_setup(test_ip_limit_exhaustion, setup),
    cmocka_unit_test_setup(test_ip_window_reset, setup),
    cmocka_unit_test_setup(test_refusals_do_not_extend_window, setup),
    cmocka_unit_test_setup(test_distinct_ips_independent, setup),
    cmocka_unit_test_setup(test_v6_slash64_grouping, setup),
    cmocka_unit_test_setup(test_zero_disables, setup),
    cmocka_unit_test_setup(test_global_cap, setup),
    cmocka_unit_test_setup(test_ip_refusal_spares_global, setup),
    cmocka_unit_test_setup(test_eviction_oldest_live, setup),
    cmocka_unit_test_setup(test_expired_reused_before_eviction, setup),
    cmocka_unit_test_setup(test_expire_and_clear, setup),
  };
  return cmocka_run_group_tests(tests, NULL, NULL);
}
```

- [ ] **Step 3: Wire the test build and run it to verify it fails**

`ircd/test/Makefile.in`:
- Add `register_throttle_cmocka \` to `CMOCKA_TESTPROGS` (the non-KC section, after `recv_classify_cmocka`).
- Add `register_throttle_cmocka.c \` to `DEP_SRC` (before `test_stub.c`).
- Add the build rule next to the other CMocka rules:

```make
# register_throttle tests - the module is recompiled with a 1-bucket,
# 4-slot table so eviction is reachable without hash-collision gymnastics.
# No test_stub.o: the module is pure by design (no log_write, no ircd deps).
register_throttle_test.o: ../register_throttle.c ../../include/register_throttle.h
	${CC} ${CFLAGS} ${CPPFLAGS} -DREG_THROTTLE_TABLE_BITS=0 -DREG_THROTTLE_BUCKET_DEPTH=4 -c -o $@ ../register_throttle.c

REGISTER_THROTTLE_CMOCKA_OBJS = register_throttle_cmocka.o register_throttle_test.o
register_throttle_cmocka: $(REGISTER_THROTTLE_CMOCKA_OBJS)
	${CC} -o $@ $(LDFLAGS) $(REGISTER_THROTTLE_CMOCKA_OBJS) $(CMOCKA_LIBS)
```

Run: `cd nefarious/ircd/test && make register_throttle_cmocka`
Expected: FAIL to build (`../register_throttle.c: No such file or directory`).

- [ ] **Step 4: Implement the module**

```c
/* ircd/register_throttle.c
 * Cross-connection throttle for REGISTER (m_register.c).
 *
 * Two independent limiters:
 *  - per-IP rolling window, IPcheck-shaped: the counter resets when
 *    `period` has elapsed since the last COUNTED attempt, otherwise it
 *    increments and refuses at `limit`.  Refusals record nothing, so a
 *    hammering client still recovers `period` after its last counted
 *    attempt.
 *  - a server-wide fixed window (`global_limit` per `period`), so a
 *    botnet spread over many IPs cannot mint unbounded accounts here.
 *
 * Addresses are canonicalized the way IPcheck does it: IPv4 -> 6to4,
 * IPv6 keyed on the first /64 (the rest is user-controlled).
 *
 * Storage is a fixed-size open hash with per-bucket LRU eviction: memory
 * never grows with attacker IP count, and evicting a live entry merely
 * grants that IP fresh budget -- never a crash.  Expiry is lazy (on
 * contact); nothing schedules reg_throttle_expire().
 *
 * The module is deliberately pure -- the caller supplies now and the
 * limits -- so ircd/test/register_throttle_cmocka.c gates it in the
 * build.  Keep it free of feature reads, Client accessors, and logging.
 */
#include "config.h"
#include "register_throttle.h"
#include "res.h"

#include <netinet/in.h>
#include <string.h>

/* Overridable so the CMocka build can shrink the table to force
 * collisions and eviction (see test/Makefile.in). */
#ifndef REG_THROTTLE_TABLE_BITS
#define REG_THROTTLE_TABLE_BITS 6
#endif
#ifndef REG_THROTTLE_BUCKET_DEPTH
#define REG_THROTTLE_BUCKET_DEPTH 4
#endif
#define REG_THROTTLE_TABLE_SIZE (1 << REG_THROTTLE_TABLE_BITS)

struct reg_throttle_entry {
  struct irc_in_addr addr;   /* canonical (see reg_canon) */
  time_t last;               /* last counted attempt */
  int attempts;              /* counted attempts in the current window */
  int in_use;
};

static struct reg_throttle_entry
  reg_table[REG_THROTTLE_TABLE_SIZE][REG_THROTTLE_BUCKET_DEPTH];
static time_t reg_global_start;   /* global window anchor (first attempt) */
static int reg_global_count;

/* IPv4 -> 6to4, IPv6 -> first /64 with the host half zeroed, so a plain
 * memcmp compares canonical keys.  Same intent as IPcheck's
 * ip_registry_canonicalize()/48-or-64-bit match. */
static void reg_canon(struct irc_in_addr *out, const struct irc_in_addr *in)
{
  memset(out, 0, sizeof(*out));
  if (irc_in_addr_is_ipv4(in)) {
    out->in6_16[0] = htons(0x2002);
    out->in6_16[1] = in->in6_16[6];
    out->in6_16[2] = in->in6_16[7];
  } else {
    out->in6_16[0] = in->in6_16[0];
    out->in6_16[1] = in->in6_16[1];
    out->in6_16[2] = in->in6_16[2];
    out->in6_16[3] = in->in6_16[3];
  }
}

static unsigned int reg_hash(const struct irc_in_addr *canon)
{
  unsigned int res = canon->in6_16[0] ^ canon->in6_16[1]
                   ^ canon->in6_16[2] ^ canon->in6_16[3];
  return res & (REG_THROTTLE_TABLE_SIZE - 1);
}

enum reg_throttle_result reg_throttle_check(const struct irc_in_addr *ip,
                                            time_t now, int limit,
                                            int period, int global_limit)
{
  if (period <= 0)
    return REG_THROTTLE_OK;

  if (limit > 0 && ip) {
    struct irc_in_addr canon;
    struct reg_throttle_entry *bucket, *match = 0, *reusable = 0, *oldest = 0;
    int i;

    reg_canon(&canon, ip);
    bucket = reg_table[reg_hash(&canon)];
    for (i = 0; i < REG_THROTTLE_BUCKET_DEPTH; ++i) {
      struct reg_throttle_entry *e = &bucket[i];
      if (e->in_use && now - e->last < period) {
        if (0 == memcmp(&e->addr, &canon, sizeof(canon))) {
          match = e;
          break;
        }
        if (!oldest || e->last < oldest->last)
          oldest = e;
      } else if (!reusable) {
        reusable = e;              /* free or expired: reuse first */
      }
    }

    if (match) {
      if (match->attempts >= limit)
        return REG_THROTTLE_IP;   /* refusal: no count, no window slide */
      ++match->attempts;
      match->last = now;
    } else {
      struct reg_throttle_entry *e = reusable ? reusable : oldest;
      /* oldest can only be null if the bucket is empty, in which case
       * reusable is set; e is never null */
      memcpy(&e->addr, &canon, sizeof(canon));
      e->last = now;
      e->attempts = 1;
      e->in_use = 1;
    }
  }

  if (global_limit > 0) {
    if (now - reg_global_start >= period) {
      reg_global_start = now;
      reg_global_count = 0;
    }
    if (reg_global_count >= global_limit)
      return REG_THROTTLE_GLOBAL;
    ++reg_global_count;
  }

  return REG_THROTTLE_OK;
}

void reg_throttle_expire(time_t now, int period)
{
  int b, i;
  for (b = 0; b < REG_THROTTLE_TABLE_SIZE; ++b)
    for (i = 0; i < REG_THROTTLE_BUCKET_DEPTH; ++i) {
      struct reg_throttle_entry *e = &reg_table[b][i];
      if (e->in_use && (period <= 0 || now - e->last >= period))
        e->in_use = 0;
    }
}

void reg_throttle_clear(void)
{
  memset(reg_table, 0, sizeof(reg_table));
  reg_global_start = 0;
  reg_global_count = 0;
}
```

(Design note, for the reviewer: `reg_throttle_expire` takes `period` as a parameter — entries do not store the window, and the caller is the only party that knows it. This keeps the sweep consistent with the lazy-expiry path in `reg_throttle_check` instead of inventing a magic constant.)

- [ ] **Step 5: Run the CMocka suite to verify it passes**

Run: `cd nefarious/ircd/test && make register_throttle_cmocka && ./register_throttle_cmocka`
Expected: all 11 tests PASS.

- [ ] **Step 6: Wire into the ircd build and verify full build**

Add `register_throttle.c` to `ircd/Makefile.in` exactly as `m_register.c` appears (source list; if there is a parallel objects list, mirror there too — check with `grep -n 'm_register' ircd/Makefile.in`). Then run a full host build:

Run: `cd nefarious && make` (this also runs `check-kc-boundary`)
Expected: clean build, no new warnings from the new files.

- [ ] **Step 7: Commit**

```bash
cd nefarious
git add include/register_throttle.h ircd/register_throttle.c ircd/test/register_throttle_cmocka.c ircd/Makefile.in ircd/test/Makefile.in
git commit -m "register: add cross-connection throttle module (per-IP window + global backstop)"
```

---

### Task 2: Feature flags + m_register wiring

**Files:**
- Modify: `nefarious/include/ircd_features.h` (enum, after `FEAT_REGISTER_VERIFY_EMAIL` at :366)
- Modify: `nefarious/ircd/ircd_features.c` (table, after the `F_B(REGISTER_VERIFY_EMAIL, ...)` at :1216 — POSITION MUST MATCH THE ENUM)
- Modify: `nefarious/ircd/m_register.c` (throttle check insertion + `#include "register_throttle.h"`)
- Modify: `nefarious/doc/readme.features` (three new entries next to `REGISTER_VERIFY_EMAIL` at :1864)

**Interfaces:**
- Consumes: Task 1's `reg_throttle_check` signature (`m_register` calls only `reg_throttle_check`; `expire`/`clear` have no ircd caller yet).
- Produces: `FEAT_REGISTER_THROTTLE_LIMIT` (default 3), `FEAT_REGISTER_THROTTLE_PERIOD` (default 3600), `FEAT_REGISTER_THROTTLE_GLOBAL` (default 60). Conf names for Task 6: `"REGISTER_THROTTLE_LIMIT"` etc.

- [ ] **Step 1: Add the enum entries**

In `include/ircd_features.h` immediately after `FEAT_REGISTER_VERIFY_EMAIL,`:

```c
  FEAT_REGISTER_THROTTLE_LIMIT,
  FEAT_REGISTER_THROTTLE_PERIOD,
  FEAT_REGISTER_THROTTLE_GLOBAL,
```

- [ ] **Step 2: Add the table entries at the matching position**

In `ircd/ircd_features.c` immediately after `F_B(REGISTER_VERIFY_EMAIL, 0, 0, feature_notify_accountreg_capvalue),`:

```c
  /* Cross-connection REGISTER throttle (register_throttle.c, consulted by
   * m_register.c): LIMIT counted attempts per PERIOD seconds per client
   * IP (/64 for IPv6), plus a server-wide GLOBAL backstop per PERIOD.
   * 0 disables that limiter; attempts are counted, not successes; opers
   * bypass.  Defaults are meant for an exposed network -- the testnet bed
   * pins LIMIT/GLOBAL to 0 in its confs. */
  F_I(REGISTER_THROTTLE_LIMIT, 0, 3, 0),
  F_I(REGISTER_THROTTLE_PERIOD, 0, 3600, 0),
  F_I(REGISTER_THROTTLE_GLOBAL, 0, 60, 0),
```

- [ ] **Step 3: Verify enum/table order parity**

Run: `grep -n 'REGISTER_VERIFY_EMAIL\|REGISTER_THROTTLE' include/ircd_features.h ircd/ircd_features.c`
Expected: in BOTH files the order is VERIFY_EMAIL, THROTTLE_LIMIT, THROTTLE_PERIOD, THROTTLE_GLOBAL with no other feature interleaved. (A mismatch is a boot assert — fleet-crash class.)

- [ ] **Step 4: Insert the throttle check in m_register()**

Add `#include "register_throttle.h"` to `m_register.c`'s include block (with the other `"..."` includes, alphabetical). Then insert between the `sasl_local_available()` gate (ends `m_register.c:480` with `return 0; }`) and the `#ifdef USE_LIBKC` cookie-arming block (`:482`):

```c
  /* Cross-connection throttle: per-IP rolling window plus a server-wide
   * backstop (register_throttle.c).  Placed after all synchronous
   * validation and before the in-flight cookie/context, so a throttled
   * request neither arms the guard nor derives credentials.  Attempts
   * are counted, not successes: a later duplicate-name or Keycloak
   * failure still consumed budget, so account-name enumeration is not
   * free.  Opers bypass (metadata-limiter precedent). */
  if (!IsOper(sptr)) {
    enum reg_throttle_result tres =
      reg_throttle_check(&cli_ip(cptr), CurrentTime,
                         feature_int(FEAT_REGISTER_THROTTLE_LIMIT),
                         feature_int(FEAT_REGISTER_THROTTLE_PERIOD),
                         feature_int(FEAT_REGISTER_THROTTLE_GLOBAL));
    if (tres != REG_THROTTLE_OK) {
      if (tres == REG_THROTTLE_GLOBAL)
        log_write(LS_SYSTEM, L_WARNING, 0,
                  "REGISTER: server-wide registration cap reached "
                  "(client %C)", cptr);
      send_fail(sptr, "REGISTER", "RATE_LIMITED", account,
                "Too many registration attempts; try again later");
      return 0;
    }
  }
```

Note: the reply message is identical for both refusal reasons on purpose (do not leak whether the server-wide cap is the one tripping); the global case is logged for operators instead. Declare `enum reg_throttle_result tres` where the file's style demands (C89-style declarations at block top are fine as written).

- [ ] **Step 5: Also update the stale comment at m_register.c:428**

The in-flight-guard comment ends with `(Cross-connection rate limiting is a separate, unaddressed concern.)` — replace that sentence with `(Cross-connection rate limiting is the register_throttle.c check below.)`.

- [ ] **Step 6: Build**

Run: `cd nefarious && make`
Expected: clean build.

- [ ] **Step 7: Document the features**

In `doc/readme.features`, insert directly after the `REGISTER_VERIFY_EMAIL` entry (match the file's entry format exactly — name line, ` * Type:` / ` * Default:` lines, blank line, prose):

```
REGISTER_THROTTLE_LIMIT
 * Type: integer
 * Default: 3

Maximum counted REGISTER attempts per client IP address (per /64 for
IPv6) within REGISTER_THROTTLE_PERIOD seconds.  Attempts are counted,
not successes: a rejected duplicate account name or a failed backend
call still consumes budget, so account-name enumeration is rate-limited
too.  A throttled client receives FAIL REGISTER RATE_LIMITED.  IRC
operators bypass the throttle.  0 disables the per-IP limiter.

REGISTER_THROTTLE_PERIOD
 * Type: integer
 * Default: 3600

The window, in seconds, for both REGISTER_THROTTLE_LIMIT and
REGISTER_THROTTLE_GLOBAL.  A client's per-IP window resets once this
many seconds pass after its last counted attempt.  0 disables both
limiters.

REGISTER_THROTTLE_GLOBAL
 * Type: integer
 * Default: 60

Server-wide cap on counted REGISTER attempts per
REGISTER_THROTTLE_PERIOD, regardless of source IP -- the backstop that
bounds account minting from a botnet spread across many addresses.
Trips are logged at L_WARNING.  Note this is per-server, not
per-network: each server enforces its own budget.  0 disables the
global limiter.
```

- [ ] **Step 8: Commit**

```bash
cd nefarious
git add include/ircd_features.h ircd/ircd_features.c ircd/m_register.c doc/readme.features
git commit -m "register: enforce cross-connection throttle (FEAT_REGISTER_THROTTLE_*)"
```

---

### Task 3: SCRAM-gate parity (`verify_email_pending`)

**Files:**
- Modify: `nefarious/include/kc/kc_keycloak.h` (struct kc_user, after `email_verified` at :67)
- Modify: `nefarious/ircd/kc/kc_keycloak.c` (`parse_user()`, after the `emailVerified` parse at :199)
- Modify: `nefarious/ircd/sasl_auth.c` (SCRAM gate at :1372)
- Modify: `nefarious/doc/readme.features` (rewrite the `REGISTER_VERIFY_EMAIL` CAUTION paragraph)

**Interfaces:**
- Produces: `bool verify_email_pending` on `struct kc_user` (false unless top-level `requiredActions` contains exactly `"VERIFY_EMAIL"`). Task 6's E2E parity legs assert the resulting behavior.
- Ground truth (verified live 2026-08-06, Global Constraints): the search-by-username endpoint used by `kc_user_get()` DOES return `requiredActions`. No fallback path is needed; do not implement one.

- [ ] **Step 1: Add the struct field**

In `include/kc/kc_keycloak.h`, after `bool email_verified;`:

```c
    /* Top-level requiredActions[] contains "VERIFY_EMAIL": verification
     * was requested for this account and is still pending.  Distinguishes
     * a daemon-born unverified account (action pending -> refuse) from a
     * legacy account that merely predates emailVerified (no action ->
     * allow).  Parsed in parse_user(); scalar, so kc_user_free() is
     * untouched. */
    bool verify_email_pending;
```

- [ ] **Step 2: Parse it**

In `ircd/kc/kc_keycloak.c` `parse_user()`, immediately after `user->email_verified = json_get_bool(json, "emailVerified", 0);` (:199):

```c
    /* Top-level requiredActions: the only action the ircd cares about is
     * VERIFY_EMAIL (set by kc_user_create_full under the verification
     * policy).  Absent or empty array => false (the memset above).
     * Confirmed live 2026-08-06 that the search-by-username
     * representation used by kc_user_get() carries this field. */
    {
        json_t *actions = json_object_get(json, "requiredActions");
        if (actions && json_is_array(actions)) {
            size_t ai;
            for (ai = 0; ai < json_array_size(actions); ai++) {
                json_t *act = json_array_get(actions, ai);
                if (act && json_is_string(act)
                    && strcmp(json_string_value(act), "VERIFY_EMAIL") == 0) {
                    user->verify_email_pending = true;
                    break;
                }
            }
        }
    }
```

(No ircd headers — this file is inside the kc boundary; `strcmp` and jansson are already in use in this file.)

- [ ] **Step 3: Flip the SCRAM gate to the parity signal**

In `ircd/sasl_auth.c` at :1370-1372, replace the comment and condition:

```c
  /* Spec: SCRAM verifies locally and bypasses the ROPC required-action
   * gate, so enforce the verification policy here.  Parity with PLAIN:
   * key on the pending VERIFY_EMAIL required action (what the ROPC
   * "Account is not fully set up" error keys on), NOT the bare
   * emailVerified flag -- legacy accounts all have emailVerified=false
   * but no pending action, and must not be locked out when the policy
   * is enabled. */
  if (register_verify_email_policy() && user->verify_email_pending) {
```

The refusal body (log, `FAIL AUTHENTICATE VERIFICATION_REQUIRED`, session teardown at :1373-1389) is unchanged.

- [ ] **Step 4: Build and run the existing kc CMocka suites**

Run: `cd nefarious && make && cd ircd/test && make cmocka && for t in kc_*_cmocka; do ./$t; done`
Expected: clean build (boundary check included), all existing kc suites pass.

Determination recorded here per the spec's conditional ("if the existing kc suites can host it"): they cannot — `parse_user()` is static inside `kc_keycloak.c`, whose object drags the curl/event-loop stack none of the standalone suites link. The parse's three observable outcomes (action pending → refused; no action → allowed; verified → allowed) are covered by Task 6's E2E parity legs instead. Do not add a unit suite for it.

- [ ] **Step 5: Rewrite the readme.features caveat**

In `doc/readme.features`, the `REGISTER_VERIFY_EMAIL` entry's final paragraph (begins `CAUTION: on a realm that already has accounts`) — replace the whole paragraph with:

```
Both SASL PLAIN and SASL SCRAM-SHA-256 gate on the same signal: a
pending VERIFY_EMAIL required action on the Keycloak account (PLAIN via
the ROPC "Account is not fully set up" error, SCRAM via the
requiredActions field fetched with the user).  Accounts that predate
this feature have emailVerified=false but no pending required action,
so enabling the policy does not lock them out of either mechanism; only
accounts created by REGISTER while the policy is on (which carry the
required action until the verification link is followed) are held to
verification.
```

- [ ] **Step 6: Commit**

```bash
cd nefarious
git add include/kc/kc_keycloak.h ircd/kc/kc_keycloak.c ircd/sasl_auth.c doc/readme.features
git commit -m "sasl: SCRAM verification gate keys on pending VERIFY_EMAIL action (parity with PLAIN, unlocks legacy accounts)"
```

---

### Task 4: CAP value notification on policy flip

**Files:**
- Modify: `nefarious/ircd/m_register.c` (rework `feature_notify_accountreg_capvalue` at :97-102, add `feature_notify_cap_accountreg`)
- Modify: `nefarious/include/capab.h` (declare the new hook next to :144)
- Modify: `nefarious/ircd/ircd_features.c` (delete `DEFINE_CAP_NOTIFY("draft/account-registration", draft_account_registration)` at :591; repoint the table entry at :1210)

**Interfaces:**
- Consumes: `send_cap_notify(const char*, int, const char*)` and `cap_set_value(enum Capab, const char*)` (`include/capab.h:135,139`); `ACCOUNTREG_CAPVALUE_EMAIL/_NOEMAIL` macros (`m_register.c:78-84`).
- Produces: `void feature_notify_cap_accountreg(void)` — the table hook for `FEAT_CAP_draft_account_registration`.

Two confirmed gaps close here (Global Constraints): `cap_set_value()` never notifies, and the generic `DEFINE_CAP_NOTIFY` hook for this cap sends `CAP NEW` with a NULL value even though this cap's value is load-bearing.

- [ ] **Step 1: Rework the hooks in m_register.c**

Replace `feature_notify_accountreg_capvalue()` (:97-102) with:

```c
/** Current draft/account-registration CAP 302 value under the active
 * policy. */
static const char *accountreg_capvalue(void)
{
  return feature_bool(FEAT_REGISTER_VERIFY_EMAIL) ?
    ACCOUNTREG_CAPVALUE_EMAIL : ACCOUNTREG_CAPVALUE_NOEMAIL;
}

/** Feature-notify hook for FEAT_REGISTER_VERIFY_EMAIL.
 *
 * Keeps the draft/account-registration CAP value in step with the policy.
 * cap_set_value() only updates the stored CAP LS value -- it does not
 * notify -- so a policy flip must also emit CAP NEW with the new value
 * to cap-notify clients (only when the capability itself is advertised).
 * During a rehash the notify batch (cap_notify_begin_batch/flush)
 * deduplicates this against feature_notify_cap_accountreg(). */
void feature_notify_accountreg_capvalue(void)
{
  cap_set_value(CAP_DRAFT_ACCOUNTREG, accountreg_capvalue());
  if (feature_bool(FEAT_CAP_draft_account_registration))
    send_cap_notify("draft/account-registration", 1, accountreg_capvalue());
}

/** Feature-notify hook for FEAT_CAP_draft_account_registration itself.
 *
 * Replaces the generic DEFINE_CAP_NOTIFY hook, which sent CAP NEW with
 * no value: this capability's value is load-bearing (email-required,
 * password bounds), so enabling the cap must advertise it. */
void feature_notify_cap_accountreg(void)
{
  cap_set_value(CAP_DRAFT_ACCOUNTREG, accountreg_capvalue());
  if (feature_bool(FEAT_CAP_draft_account_registration)) {
    send_cap_notify("draft/account-registration", 1, accountreg_capvalue());
    log_write(LS_SYSTEM, L_INFO, 0,
              "draft/account-registration: capability enabled, "
              "sent CAP NEW to cap-notify clients");
  } else {
    send_cap_notify("draft/account-registration", 0, NULL);
    log_write(LS_SYSTEM, L_INFO, 0,
              "draft/account-registration: capability disabled, "
              "sent CAP DEL to cap-notify clients");
  }
}
```

- [ ] **Step 2: Declare and repoint**

- `include/capab.h`, next to the existing `extern void feature_notify_accountreg_capvalue(void);` (:144), add:
  ```c
  extern void feature_notify_cap_accountreg(void);
  ```
- `ircd/ircd_features.c:591`: delete the line `DEFINE_CAP_NOTIFY("draft/account-registration", draft_account_registration)`.
- `ircd/ircd_features.c:1210`: change the table entry to
  ```c
  F_B(CAP_draft_account_registration, 0, 0, feature_notify_cap_accountreg),
  ```

- [ ] **Step 3: Build and check for the orphaned symbol**

Run: `cd nefarious && make 2>&1 | grep -i 'warn\|error' | head; grep -n 'feature_notify_cap_draft_account_registration' ircd/ ircd/*.c -r`
Expected: clean build; zero remaining references to the old generated hook name.

- [ ] **Step 4: Commit**

```bash
cd nefarious
git add ircd/m_register.c include/capab.h ircd/ircd_features.c
git commit -m "cap: draft/account-registration notifies with its value on cap enable and policy flip"
```

---

### Task 5: Testnet provisioning — dead SQL index + passwordPolicy

**Files:**
- Modify: `scripts/keycloak-db-indexes.sql` (:26-29)
- Modify: `scripts/setup-keycloak.sh` (both realm bodies: PUT :72-95, POST :102-126)

**Interfaces:**
- Produces: realm bodies carrying `"passwordPolicy": "x3Scram"` (the live-read value — Global Constraints). Task 7 later flips this string to `scramSha256`; do NOT use the new name yet (Keycloak refuses policy strings naming providers that are not loaded).

- [ ] **Step 1: Fix the index**

Replace lines 26-29 of `scripts/keycloak-db-indexes.sql` with:

```sql
-- Partial index for SCRAM attributes (queried together during SASL).
-- Covers both prefixes: scram_sha256_* is written at REGISTER time by the
-- ircd (kc_cred_derive.c) and by the webhook SPI on web-flow password
-- changes; legacy accounts keep x3_scram_* until their next password
-- change.  DROP first so re-running the init container upgrades the old
-- x3_scram_%-only predicate in place (IF NOT EXISTS alone would keep it).
DROP INDEX IF EXISTS idx_user_attribute_scram;
CREATE INDEX IF NOT EXISTS idx_user_attribute_scram
  ON user_attribute (user_id, name)
  WHERE name LIKE 'scram_sha256_%' OR name LIKE 'x3_scram_%';
```

(The section comments at :5 and :80 mention SCRAM only generically — verify neither names `x3_scram` and leave them if so.)

- [ ] **Step 2: Apply it live and verify**

Run: `scripts/dc.sh up keycloak-db-indexes` then confirm:
`scripts/dc.sh logs keycloak-db-indexes | tail -20` shows no ERROR, and the index predicate is live — the indexes container connects with `PGHOST=master.postgresql.service.consul PGDATABASE=db_keycloak`; verify from the same image: rerun is enough, then check via a one-off `scripts/dc.sh run --rm keycloak-db-indexes psql -c "\d+ user_attribute" | grep scram` (expect both `LIKE` arms in the predicate). If `run --rm` needs the SQL-mount override, plain `docker exec` into a fresh `up` of the service is equivalent — what matters is observing the new predicate.

- [ ] **Step 3: Provision the password policy**

In `scripts/setup-keycloak.sh`, add to BOTH JSON bodies (the update PUT at :72-95 and the create POST at :102-126), directly after the `"requiredActions": [],` line in each:

```
      "passwordPolicy": "x3Scram",
```

And add this comment above the PUT `curl` (extend the existing comment block at :65-68):

```bash
  # passwordPolicy: the x3Scram provider (keycloak-webhook-spi
  # ScramPasswordPolicyProvider) derives scram_sha256_* attributes on
  # web-flow password changes.  Value read from the live realm 2026-08-06;
  # it was previously attached by hand in the UI and silently lost on any
  # realm recreate.  When the SPI provider ID is renamed (scramSha256),
  # update BOTH bodies -- Keycloak refuses a policy string naming a
  # provider that is not loaded.
```

- [ ] **Step 4: Run the script against the live realm and verify no clobber**

Run: `scripts/setup-keycloak.sh` (idempotent update path), then:

```bash
TOKEN=$(curl -s -X POST "http://localhost:8080/realms/master/protocol/openid-connect/token" \
  -H "Content-Type: application/x-www-form-urlencoded" \
  -d "username=admin" -d "password=admin" -d "grant_type=password" -d "client_id=admin-cli" \
  | grep -o '"access_token":"[^"]*"' | cut -d'"' -f4)
curl -s -H "Authorization: Bearer $TOKEN" http://localhost:8080/admin/realms/testnet \
  | python3 -c "import json,sys;print(json.load(sys.stdin)['passwordPolicy'])"
```

Expected: `x3Scram`.

- [ ] **Step 5: Commit (testnet repo — stage ONLY these two files)**

```bash
git add scripts/keycloak-db-indexes.sql scripts/setup-keycloak.sh
git diff --cached --stat   # must show exactly these two files
git commit -m "keycloak: provision passwordPolicy (was UI-only, lost on recreate); SCRAM attr index covers both prefixes"
```

---

### Task 6: Bed conf, Docker gate, and E2E (throttle + parity + CAP notify + X3 measurement)

**Files:**
- Modify: `data/ircd.conf`, `data/ircd2.conf` (Features blocks — pin throttle off on the bed)
- Modify: `tests/src/ircv3/account-registration.test.ts` (three new describe blocks)

**Interfaces:**
- Consumes: Task 2's conf names (`REGISTER_THROTTLE_LIMIT/PERIOD/GLOBAL`), Task 3's gate behavior, Task 4's notify behavior. File helpers already present: `connectPreReg(server, caps)`, `waitForParsedLine`, `uniqueAccount(prefix)`, `trackCreatedAccount`, `scramSha256Login`, `kcSetVerification`, `kcGetUserByUsername`, `getKeycloakAdminToken`, `quitAndClose`, `IRC_OPER` (helpers barrel).
- Oper `/SET` feature-toggle precedent: `tests/src/ircv3/chathistory-strict-presence.test.ts:41-56`; the bed opers have `set = yes` for exactly this purpose.

- [ ] **Step 1: Pin the throttle off in the bed confs**

In `data/ircd.conf` and `data/ircd2.conf` Features blocks (next to `"CAP_draft_account_registration"`), add:

```
   # REGISTER throttle pinned off on the bed: the E2E suite fires many
   # REGISTERs from one host IP.  The throttle tests enable it at runtime
   # via oper /SET and restore 0 afterwards.  C defaults are 3/3600/60.
   "REGISTER_THROTTLE_LIMIT" = "0";
   "REGISTER_THROTTLE_GLOBAL" = "0";
```

(PERIOD stays at its C default; the tests /SET it short and restore it.)

**Constraint reminder:** `data/ircd.conf` carries the user's unstaged hunks (require_sasl, Operator masks). Stage only these Features-block hunks; verify with `git diff --cached data/ircd.conf` that nothing else is staged.

- [ ] **Step 2: Rebuild BOTH servers (scoped) and restart them (scoped)**

```bash
scripts/dc.sh -l build nefarious nefarious2
scripts/dc.sh -l up -d nefarious nefarious2
```

Expected: both containers healthy (`scripts/dc.sh -l ps nefarious nefarious2`); startup logs clean (`scripts/dc.sh logs nefarious | tail -30`) — this is also the boot-assert gate for Task 2's feature-table order. Never touch nefarious3-7.

- [ ] **Step 3: Record the X3 baseline (Part 4 measurement — before)**

Locate the db: `scripts/dc.sh exec x3 sh -c 'ls /home/x3/data/x3.db || find / -name x3.db 2>/dev/null'`. Then count handle records: `scripts/dc.sh exec x3 sh -c 'grep -c "^\t\"" <path>'` is NOT the required shape — instead count accounts with the suite's prefixes (read the prefixes from `uniqueAccount()` call sites in the test file, e.g. `reg…`): `scripts/dc.sh exec x3 sh -c 'grep -oE "\"(reg|thr)[a-z0-9]+\"" <path> | sort -u | wc -l'`. Record the exact command and number in the task report — this is a measurement, not an assertion; adapt the pattern to the real prefixes found in the file.

- [ ] **Step 4: Add the throttle E2E describe block**

Append to `account-registration.test.ts` (adapting helper names ONLY if the file's differ — audit while editing per `feedback_tests_may_be_wrong`). Throttle attempts deliberately target an already-existing account: ACCOUNT_EXISTS failures still consume budget (counted attempts), and nothing new is minted.

```ts
/** Registered + opered raw connection (file-level helper — the CAP-notify
 * block reuses it).  connectPreReg leaves CAP negotiation open and never
 * registers, so this closes negotiation and registers a nick first. */
async function createOperOn(server: ServerConfig, caps: string[] = []): Promise<RawSocketClient> {
  const client = await connectPreReg(server, caps);
  client.capEnd();
  client.register(`op${uniqueId().slice(0, 6)}`);
  await client.waitForNumeric('001', 15000);
  client.send(`OPER ${IRC_OPER.name} ${IRC_OPER.password}`);
  await client.waitForNumeric('381', 5000);
  return client;
}

describe('REGISTER throttling (cross-connection)', () => {
  let oper: RawSocketClient;
  let seededAccount: string;

  async function setFeature(name: string, value: string): Promise<void> {
    oper.send(`SET ${name} ${value}`);
    // Server confirms with a NOTICE; a brief settle is enough (pattern from
    // chathistory-strict-presence.test.ts).
    await new Promise(r => setTimeout(r, 300));
  }

  /** One REGISTER attempt on a fresh pre-reg connection; returns the FAIL
   * code or 'SUCCESS'. */
  async function attemptRegister(account: string): Promise<string> {
    const client = await connectPreReg(PRIMARY_SERVER, ['draft/account-registration']);
    try {
      client.send(`REGISTER ${account} * regthrpass1`);
      const reply = await client.waitForParsedLine(
        msg =>
          (msg.command === 'REGISTER' && msg.params[0] === 'SUCCESS') ||
          (msg.command === 'FAIL' && msg.params[0] === 'REGISTER'),
        15000
      );
      return reply.command === 'FAIL' ? reply.params[1] : 'SUCCESS';
    } finally {
      await quitAndClose(client);
    }
  }

  beforeAll(async () => {
    // Seed one real account (tracked for cleanup); all throttle attempts
    // then reuse its name so they fail ACCOUNT_EXISTS and mint nothing.
    seededAccount = trackCreatedAccount(uniqueAccount('thr'));
    const first = await attemptRegister(seededAccount);
    expect(first).toBe('SUCCESS');

    oper = await createOperOn(PRIMARY_SERVER);
  }, 60000);

  afterAll(async () => {
    // Restore the bed's pinned-off state even on failure.
    if (oper) {
      await setFeature('REGISTER_THROTTLE_LIMIT', '0');
      await setFeature('REGISTER_THROTTLE_GLOBAL', '0');
      await setFeature('REGISTER_THROTTLE_PERIOD', '3600');
      await quitAndClose(oper);
    }
  }, 30000);

  it('per-IP limit refuses the N+1th attempt and recovers after the window', async () => {
    await setFeature('REGISTER_THROTTLE_PERIOD', '3');
    await setFeature('REGISTER_THROTTLE_LIMIT', '2');
    expect(await attemptRegister(seededAccount)).toBe('ACCOUNT_EXISTS'); // counted
    expect(await attemptRegister(seededAccount)).toBe('ACCOUNT_EXISTS'); // counted
    expect(await attemptRegister(seededAccount)).toBe('RATE_LIMITED');   // refused
    await new Promise(r => setTimeout(r, 3500));                          // window elapses
    expect(await attemptRegister(seededAccount)).toBe('ACCOUNT_EXISTS'); // fresh budget
    await setFeature('REGISTER_THROTTLE_LIMIT', '0');
  }, 60000);

  it('global backstop trips independently of the per-IP limiter', async () => {
    await setFeature('REGISTER_THROTTLE_PERIOD', '3');
    await setFeature('REGISTER_THROTTLE_GLOBAL', '2');
    expect(await attemptRegister(seededAccount)).toBe('ACCOUNT_EXISTS');
    expect(await attemptRegister(seededAccount)).toBe('ACCOUNT_EXISTS');
    expect(await attemptRegister(seededAccount)).toBe('RATE_LIMITED');
    await setFeature('REGISTER_THROTTLE_GLOBAL', '0');
    await new Promise(r => setTimeout(r, 3500));  // let the global window drain
  }, 60000);

  it('opers bypass the throttle', async () => {
    await setFeature('REGISTER_THROTTLE_PERIOD', '60');
    await setFeature('REGISTER_THROTTLE_LIMIT', '1');
    // The opered connection REGISTERs repeatedly; never RATE_LIMITED.
    for (let i = 0; i < 3; i++) {
      oper.send(`REGISTER ${seededAccount} * regthrpass1`);
      const reply = await oper.waitForParsedLine(
        msg => msg.command === 'FAIL' && msg.params[0] === 'REGISTER',
        15000
      );
      expect(reply.params[1]).not.toBe('RATE_LIMITED'); // ACCOUNT_EXISTS expected
    }
    await setFeature('REGISTER_THROTTLE_LIMIT', '0');
    await setFeature('REGISTER_THROTTLE_PERIOD', '3600');
  }, 60000);
});
```

- [ ] **Step 5: Add the SCRAM-parity describe block (the lockout regression test)**

Runs against SECONDARY (policy on) with the file's existing skip-if-unavailable pattern. The account is daemon-born on nefarious2 (so it HAS the required action), then reshaped via admin REST into legacy form.

**Do NOT use `describe.skipIf` for the secondary-server gate** — it evaluates at module load and silently skips (this bit the repo before: 63 tests silently skipped; see memory `project_vitest_skipif_timing_bug`). Use the file's existing pattern: a `secondaryReachable` flag set in `beforeAll` via `isSecondaryServerAvailable()`, with `if (!secondaryReachable) return warnUnreachable();` at the top of each test (exactly as the file's verification-on describe at :595-607 does — reuse its `warnUnreachable`).

```ts
describe('SCRAM verification gate: required-action parity', () => {
  let secondaryReachable = false;
  beforeAll(async () => {
    secondaryReachable = await isSecondaryServerAvailable();
  });

  // legacy-shaped: emailVerified=false AND no pending required action.
  it('legacy-shaped account authenticates via SCRAM with the policy ON', async () => {
    if (!secondaryReachable) return warnUnreachable();
    const account = trackCreatedAccount(uniqueAccount('par'));
    const password = 'paritypass1';
    const client = await connectPreReg(SECONDARY_SERVER, ['sasl', 'draft/account-registration']);
    client.send(`REGISTER ${account} ${account}@example.test ${password}`);
    await client.waitForParsedLine(
      msg => msg.command === 'REGISTER' && msg.params[0] === 'VERIFICATION_REQUIRED', 15000);
    await quitAndClose(client);

    const token = await getKeycloakAdminToken();
    const user = await waitForKcUser(token, account);
    // Strip the action but leave emailVerified=false: exactly a legacy account.
    const res = await fetch(`${KEYCLOAK_URL}/admin/realms/${KEYCLOAK_REALM}/users/${user.id}`, {
      method: 'PUT',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ emailVerified: false, requiredActions: [] }),
    });
    expect(res.ok).toBe(true);

    // THE regression assertion: SCRAM must succeed (pre-fix it was refused).
    const scram = await connectPreReg(SECONDARY_SERVER, ['sasl']);
    const result = await scramSha256Login(scram, account, password);
    expect(result.success).toBe(true);   // ScramResult { success, numeric, failMsg? }
    await quitAndClose(scram);
  }, 60000);

  it('daemon-born unverified account is refused on SCRAM until verified, then allowed', async () => {
    if (!secondaryReachable) return warnUnreachable();
    const account = trackCreatedAccount(uniqueAccount('par'));
    const password = 'paritypass1';
    const client = await connectPreReg(SECONDARY_SERVER, ['draft/account-registration']);
    client.send(`REGISTER ${account} ${account}@example.test ${password}`);
    await client.waitForParsedLine(
      msg => msg.command === 'REGISTER' && msg.params[0] === 'VERIFICATION_REQUIRED', 15000);
    await quitAndClose(client);

    const refused = await connectPreReg(SECONDARY_SERVER, ['sasl']);
    const r1 = await scramSha256Login(refused, account, password);
    expect(r1.success).toBe(false);      // VERIFICATION_REQUIRED path
    await quitAndClose(refused);

    const token = await getKeycloakAdminToken();
    const user = await waitForKcUser(token, account);
    await kcSetVerification(token, user.id, true);

    const allowed = await connectPreReg(SECONDARY_SERVER, ['sasl']);
    const r2 = await scramSha256Login(allowed, account, password);
    expect(r2.success).toBe(true);
    await quitAndClose(allowed);
  }, 60000);
});
```

Audit note for the implementer: the file may already contain a daemon-born-SCRAM-refused leg from the shipping work — if so, fold the until-verified/then-allowed halves into it rather than duplicating; the NEW content that must exist afterwards is the legacy-shaped success leg. (`scramSha256Login` returns `ScramResult { success, numeric, failMsg? }` — the sketch already matches; `KEYCLOAK_URL`/`KEYCLOAK_REALM` consts and `waitForKcUser` are file-level helpers.)

- [ ] **Step 6: Add the CAP-notify describe block**

On PRIMARY (`CAP_draft_account_registration` is TRUE in `data/ircd.conf:576`; `REGISTER_VERIFY_EMAIL` is off there, so flip it TRUE→FALSE and restore):

```ts
describe('CAP value notification on policy flip', () => {
  it('flipping REGISTER_VERIFY_EMAIL sends CAP NEW with the updated value', async () => {
    const watcher = await connectPreReg(PRIMARY_SERVER, ['cap-notify']);
    watcher.capEnd();
    watcher.register(`capw${uniqueId().slice(0, 5)}`);
    await watcher.waitForNumeric('001', 15000);

    const oper = await createOperOn(PRIMARY_SERVER);

    try {
      oper.send('SET REGISTER_VERIFY_EMAIL TRUE');
      const capNew = await watcher.waitForParsedLine(
        msg => msg.command === 'CAP' && msg.params[1] === 'NEW'
            && msg.params[2].includes('draft/account-registration='),
        10000
      );
      expect(capNew.params[2]).toContain('email-required');

      oper.send('SET REGISTER_VERIFY_EMAIL FALSE');
      const capNew2 = await watcher.waitForParsedLine(
        msg => msg.command === 'CAP' && msg.params[1] === 'NEW'
            && msg.params[2].includes('draft/account-registration='),
        10000
      );
      expect(capNew2.params[2]).not.toContain('email-required');
      expect(capNew2.params[2]).toContain('min-password-length=5');
    } finally {
      oper.send('SET REGISTER_VERIFY_EMAIL FALSE');  // restore even on assert failure
      await new Promise(r => setTimeout(r, 300));
      await quitAndClose(oper);
      await quitAndClose(watcher);
    }
  }, 60000);
});
```

- [ ] **Step 7: Run the targeted suite**

Run: `cd tests && IRC_HOST=localhost npm test -- src/ircv3/account-registration.test.ts`
Expected: all pre-existing tests still green, all new tests green. If a new test is flaky on timing, fix the test's waits (never the assertions) — throttle windows are /SET-controlled, so the timings are deterministic.

- [ ] **Step 8: Record the X3 measurement (after) and conclude Part 4**

Re-run the Step 3 count command. Expected per the spec's evidence: the count returns to the Step 3 baseline (the cleanup sweep now sees the accounts). Record before/after numbers and the verdict in the task report. If a residue remains, STOP and report it (scoping the fix is a human decision per the spec — "not designed in advance for a problem that may not exist").

- [ ] **Step 9: Commit (stage carefully)**

```bash
git add tests/src/ircv3/account-registration.test.ts
git add -p data/ircd.conf     # ONLY the REGISTER_THROTTLE Features hunk
git add -p data/ircd2.conf    # ONLY the REGISTER_THROTTLE Features hunk
git diff --cached             # verify: no require_sasl / Operator-mask hunks
git commit -m "tests: REGISTER throttle, SCRAM-parity regression, CAP-notify E2E; pin throttle off in bed confs"
```

---

### Task 7: SPI identity scrub + coordinated live rename

**Files (keycloak-webhook-spi, branch `feature/scram-attr-rename`):**
- Modify: `src/main/java/net/afternet/keycloak/webhook/ScramPasswordPolicyProviderFactory.java` (:31 `PROVIDER_ID = "x3Scram"` → `"scramSha256"`, :32 `DISPLAY_NAME = "X3 SCRAM-SHA-256"` → `"SCRAM-SHA-256"`)
- Modify: `src/main/java/net/afternet/keycloak/webhook/ScramCredentialProviderFactory.java` (:24 `"x3-scram-sha256"` → `"scram-sha256"` — unregistered factory, free rename)
- Modify: `src/main/java/net/afternet/keycloak/webhook/WebhookEventListenerProvider.java` (rename fields `X3_RESOURCE_TYPES` → `WATCHED_RESOURCE_TYPES`, `X3_USER_EVENTS` → `WATCHED_USER_EVENTS`, plus their comments)
- Modify (prose/javadoc only — replace X3 attributions with "the ircd" / neutral wording): `WebhookEventListenerProviderFactory.java:20,28,35`, `WebhookConfig.java:65,85`, `ScramPasswordPolicyProvider.java:28`, `ScramCredentialProvider.java:77,149,158`
- Modify (testnet): `scripts/setup-keycloak.sh` (policy string `x3Scram` → `scramSha256` in BOTH bodies + the Task 5 comment)

**Sequencing is the point** (Keycloak refuses a policy string naming an unloaded provider): SPI code → build+deploy → verify provider loaded → flip live realm policy → update provisioning script → verify web-flow write path.

**Dependency:** Task 5 must be complete (provisioning carries the policy at all).

- [ ] **Step 1: Apply the renames and scrub**

Make the four code renames above. For the prose lines, replace X3-specific attribution accurately: the SCRAM attribute contract's counterpart is `nefarious/ircd/kc/kc_cred_derive.c` (registration-time), not X3. Grep gate before committing:

Run: `grep -rn 'x3Scram\|x3-scram\|X3 SCRAM\|X3_' src/main/java` → expected: zero hits. (`x3_scram` attribute names were already scrubbed; confirm still zero.)

- [ ] **Step 2: Build the jar via the compose builder and redeploy Keycloak**

```bash
scripts/dc.sh up keycloak-spi-build      # maven build from ./keycloak-webhook-spi into the providers volume
scripts/dc.sh logs keycloak-spi-build | tail -3   # expect 'Webhook SPI JAR built and copied to providers'
scripts/dc.sh restart keycloak
# wait for healthy:
until curl -sf http://localhost:8080/realms/master >/dev/null; do sleep 2; done
```

- [ ] **Step 3: Flip the live realm's password policy (new provider now loaded)**

```bash
TOKEN=$(curl -s -X POST "http://localhost:8080/realms/master/protocol/openid-connect/token" \
  -H "Content-Type: application/x-www-form-urlencoded" \
  -d "username=admin" -d "password=admin" -d "grant_type=password" -d "client_id=admin-cli" \
  | grep -o '"access_token":"[^"]*"' | cut -d'"' -f4)
curl -s -X PUT "http://localhost:8080/admin/realms/testnet" \
  -H "Authorization: Bearer $TOKEN" -H "Content-Type: application/json" \
  -d '{"passwordPolicy": "scramSha256"}'
curl -s -H "Authorization: Bearer $TOKEN" http://localhost:8080/admin/realms/testnet \
  | python3 -c "import json,sys;print(json.load(sys.stdin)['passwordPolicy'])"
```

Expected: `scramSha256`. If the PUT errors (HTTP 400 naming the policy), the provider did not load — STOP, check `scripts/dc.sh logs keycloak | grep -i scram`, do not retry with the old name.

- [ ] **Step 4: Update the provisioning script**

In `scripts/setup-keycloak.sh`, change `"passwordPolicy": "x3Scram",` → `"passwordPolicy": "scramSha256",` in BOTH bodies, and update the Task 5 comment's provider name. Re-run `scripts/setup-keycloak.sh`; re-verify the realm still reports `scramSha256`.

- [ ] **Step 5: Verify the policy provider writes scram_sha256_* on a password change**

Create a throwaway user and set its password through Keycloak's credential machinery (which runs password policies), then check attributes:

```bash
# create
curl -s -X POST "http://localhost:8080/admin/realms/testnet/users" \
  -H "Authorization: Bearer $TOKEN" -H "Content-Type: application/json" \
  -d '{"username": "scramprobe1", "enabled": true}'
UID=$(curl -s -H "Authorization: Bearer $TOKEN" \
  "http://localhost:8080/admin/realms/testnet/users?username=scramprobe1&exact=true" \
  | python3 -c "import json,sys;print(json.load(sys.stdin)[0]['id'])")
# password change through the policy pipeline
curl -s -X PUT "http://localhost:8080/admin/realms/testnet/users/$UID/reset-password" \
  -H "Authorization: Bearer $TOKEN" -H "Content-Type: application/json" \
  -d '{"type": "password", "value": "Probepass123", "temporary": false}'
# attributes must now carry the scram_sha256_* set
curl -s -H "Authorization: Bearer $TOKEN" "http://localhost:8080/admin/realms/testnet/users/$UID" \
  | python3 -c "import json,sys;a=json.load(sys.stdin).get('attributes',{});print(sorted(k for k in a if 'scram' in k))"
# cleanup
curl -s -X DELETE "http://localhost:8080/admin/realms/testnet/users/$UID" -H "Authorization: Bearer $TOKEN"
```

Expected: `['scram_sha256_iterations', 'scram_sha256_salt', 'scram_sha256_server_key', 'scram_sha256_stored_key']`. If the attribute list is empty, the policy pipeline did not invoke the provider — record exactly what was observed and STOP (deployment/ordering problem, human decision).

- [ ] **Step 6: Confirm SASL SCRAM still works end-to-end against a policy-written credential**

Run the existing SCRAM legs only: `cd tests && IRC_HOST=localhost npm test -- src/ircv3/account-registration.test.ts -t SCRAM`
Expected: green (the ircd reads `scram_sha256_*` first-tier; the rename changed no attribute names).

- [ ] **Step 7: Commit both repos**

```bash
cd keycloak-webhook-spi
git add src/main/java/net/afternet/keycloak/webhook/
git commit -m "identity: rename x3Scram provider to scramSha256; scrub residual X3 attribution"
cd ..
git add scripts/setup-keycloak.sh
git commit -m "keycloak: provision scramSha256 password policy (SPI provider renamed)"
```

---

## Task ordering

1 → 2 (module before wiring). 3 and 4 independent of 1-2 and of each other. 5 → 7 (provisioning before rename). 6 requires 2+3+4 (rebuilds the servers with all nefarious changes) and should run before 7 (so Step 6's SCRAM re-check in Task 7 runs against a bed that already passed the full file). Recommended execution order: **1, 2, 3, 4, 5, 6, 7**.

## Not in this plan (spec's scope boundaries)

Cross-server/network registration accounting; the `metadata-2` CAP-value notify gap (same shape, different feature — noted, not fixed); `IPcheck` behavior changes; X3-side code changes; enabling `FEAT_CAP_draft_account_registration` anywhere new (separate decision after this lands).
