# Retire the Account-TS Rebind Gate — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Remove `acc_ts_match` — the last consumer of the account timestamp anywhere on the
network — from the bouncer rebind authorization gate, and make every rebind record which
gate authorized it.

**Architecture:** `bounce_rebind_ghost_to_remote_primary()` authorizes a rebind if any of
three conditions hold: (a) the introducing server matches the session's recorded origin,
(b) the introducing message carries a matching `,S` sessid tag, or (c) the incoming account
timestamp matches the held ghost's. (c) was added as a receiver-side fallback in
`219ab03` and explicitly scheduled for removal once the sender-side fix `8cf493c` proved
itself. It never was. The decision logic is extracted into a pure, unit-testable module
first — following the `bounce_converge_peer_wins()` precedent — so the removal is verified
by tests rather than by waiting for production events that occur four times a year.

**Tech Stack:** C (nefarious ircd, autotools), CMocka, Docker Compose bed, Vitest.

**Spec:** `.claude/para/projects/account-timestamp-authority-2026-09.md` (design E, sequencing step 2)

## Global Constraints

- **Branch:** `fix/retire-rebind-acc-ts-gate` off the fork's working branch. Push to **both**
  `ircv3.2-hardening` and `ircv3.2-upgrade` (`feedback_push_both_fork_branches`).
- **Do not remove the `incoming_acc_ts` parameter** from
  `bounce_rebind_ghost_to_remote_primary()` (`bouncer_session.c:5913`, declared
  `include/bouncer_session.h:1137`, called `m_nick.c:516`). It stays as diagnostic context
  in the refusal log — which becomes the thing operators read if this change is wrong.
- **Do not remove `bsr_acc_create`** from the persisted record. It becomes vestigial, but
  dropping a field costs another record-version migration for no benefit.
- **Do not touch `acc_create` parsing, propagation, or the primary→alias copies.** The ircd
  remains a courier for the value, exactly as upstream nefarious is.
- **Rebuild both servers** for any cross-server test — `build nefarious` does not rebuild
  `nefarious2` (`project_dc_rebuild_both_servers`).
- Check `df` before rebuilds; builder-cache prune first if tight (`bed-disk-full-cores`).

---

## File Structure

| File | Responsibility | Change |
|---|---|---|
| `include/bouncer_rebind_auth.h` | Enum + one pure function declaration | Create |
| `ircd/bouncer_rebind_auth.c` | The gate decision, no ircd dependencies | Create |
| `ircd/test/bouncer_rebind_auth_cmocka.c` | CMocka suite over the decision | Create |
| `ircd/Makefile.in` | Build the new module | Modify (near `:220`) |
| `ircd/test/Makefile.in` | Build and run the new suite | Modify (`:44`, `:78`, `:362`) |
| `ircd/bouncer_session.c` | Call the helper; log the result | Modify `:5972-6009`, `:6098` |

The extraction mirrors `bouncer_converge.c` / `include/bouncer_converge.h`, which exists for
exactly this reason: *"the module is pure (no ircd deps)"* (`ircd/test/Makefile.in:358`), so
it links into a CMocka binary without the server.

---

### Task 1: Extract the gate into a pure, tested module

**Files:**
- Create: `include/bouncer_rebind_auth.h`, `ircd/bouncer_rebind_auth.c`,
  `ircd/test/bouncer_rebind_auth_cmocka.c`
- Modify: `ircd/Makefile.in`, `ircd/test/Makefile.in`, `ircd/bouncer_session.c:5972-6009`

**Interfaces:**
- Consumes: nothing.
- Produces: `enum BounceRebindAuth { BRA_NONE, BRA_ORIGIN, BRA_SESSID, BRA_ACC_TS }` and
  `enum BounceRebindAuth bounce_rebind_auth(int origin_match, int sessid_match, int acc_ts_match);`
  plus `const char *bounce_rebind_auth_name(enum BounceRebindAuth);`. Task 2 changes this
  module's behaviour and nothing else.

- [ ] **Step 1: Create the branch**

```bash
cd /home/ibutsu/testnet/nefarious
git checkout -b fix/retire-rebind-acc-ts-gate
```

- [ ] **Step 2: Write the failing test**

Create `ircd/test/bouncer_rebind_auth_cmocka.c`:

```c
/* cmocka suite for bounce_rebind_auth (include/bouncer_rebind_auth.h).
 *
 * The rebind gate authorizes on any of three independent signals. Real
 * rebinds occur about four times per five months in production, so the
 * decision is pinned here rather than observed in the field.
 */
#include <stdarg.h>
#include <stddef.h>
#include <setjmp.h>
#include <string.h>
#include <cmocka.h>

#include "../../include/bouncer_rebind_auth.h"

static void test_no_signal_refuses(void **state)
{
  (void)state;
  assert_int_equal(bounce_rebind_auth(0, 0, 0), BRA_NONE);
}

static void test_origin_alone_authorizes(void **state)
{
  (void)state;
  assert_int_equal(bounce_rebind_auth(1, 0, 0), BRA_ORIGIN);
}

static void test_sessid_alone_authorizes(void **state)
{
  (void)state;
  assert_int_equal(bounce_rebind_auth(0, 1, 0), BRA_SESSID);
}

static void test_acc_ts_alone_authorizes(void **state)
{
  (void)state;
  /* Task 2 flips this to BRA_NONE. Until then it pins current behaviour. */
  assert_int_equal(bounce_rebind_auth(0, 0, 1), BRA_ACC_TS);
}

static void test_sessid_supersedes_origin(void **state)
{
  (void)state;
  /* Redesign A.2/C.2: sessid is the canonical session identity; hs_origin is
   * historical-only metadata. Where both hold, the report must say sessid. */
  assert_int_equal(bounce_rebind_auth(1, 1, 0), BRA_SESSID);
  assert_int_equal(bounce_rebind_auth(1, 1, 1), BRA_SESSID);
}

static void test_stronger_signal_wins_over_acc_ts(void **state)
{
  (void)state;
  /* acc_ts is the weakest signal and must never be reported when a
   * stronger one is present -- otherwise the log undercounts the real
   * gates and overcounts the one we are trying to retire. */
  assert_int_equal(bounce_rebind_auth(1, 0, 1), BRA_ORIGIN);
  assert_int_equal(bounce_rebind_auth(0, 1, 1), BRA_SESSID);
}

static void test_names_are_stable(void **state)
{
  (void)state;
  /* These strings land in a log operators grep. */
  assert_string_equal(bounce_rebind_auth_name(BRA_NONE),   "none");
  assert_string_equal(bounce_rebind_auth_name(BRA_ORIGIN), "origin");
  assert_string_equal(bounce_rebind_auth_name(BRA_SESSID), "sessid");
  assert_string_equal(bounce_rebind_auth_name(BRA_ACC_TS), "account-TS");
}

int main(void)
{
  const struct CMUnitTest tests[] = {
    cmocka_unit_test(test_no_signal_refuses),
    cmocka_unit_test(test_origin_alone_authorizes),
    cmocka_unit_test(test_sessid_alone_authorizes),
    cmocka_unit_test(test_acc_ts_alone_authorizes),
    cmocka_unit_test(test_sessid_supersedes_origin),
    cmocka_unit_test(test_stronger_signal_wins_over_acc_ts),
    cmocka_unit_test(test_names_are_stable),
  };
  return cmocka_run_group_tests(tests, NULL, NULL);
}
```

- [ ] **Step 3: Wire the test into the build**

`ircd/test/Makefile.in` — three edits, mirroring `bouncer_converge`:

At `:44`, in the binary list, after `bouncer_converge_cmocka \`:

```
	bouncer_rebind_auth_cmocka \
```

At `:78`, in the source list, after `bouncer_converge_cmocka.c \`:

```
	bouncer_rebind_auth_cmocka.c \
```

After the `bouncer_converge` rules (around `:364`):

```make
# bouncer_rebind_auth tests - the module is pure (no ircd deps)
bouncer_rebind_auth_test.o: ../bouncer_rebind_auth.c ../../include/bouncer_rebind_auth.h
	${CC} ${CFLAGS} ${CPPFLAGS} -c -o $@ ../bouncer_rebind_auth.c

BOUNCER_REBIND_AUTH_CMOCKA_OBJS = bouncer_rebind_auth_cmocka.o bouncer_rebind_auth_test.o
bouncer_rebind_auth_cmocka: $(BOUNCER_REBIND_AUTH_CMOCKA_OBJS)
	${CC} -o $@ $(LDFLAGS) $(BOUNCER_REBIND_AUTH_CMOCKA_OBJS) $(CMOCKA_LIBS)
```

- [ ] **Step 4: Run the test and watch it fail to build**

```bash
cd /home/ibutsu/testnet
scripts/dc.sh build nefarious 2>&1 | tail -20
```

Expected: FAIL — `bouncer_rebind_auth.h: No such file or directory`. The module does not
exist yet. This confirms the test is wired in and actually gates the build; the CMocka gate
was once a silent no-op because `tee` ate the exit code (`project_cmocka_gate_broken`), so
seeing a real failure here matters.

- [ ] **Step 5: Write the module**

Create `include/bouncer_rebind_auth.h`:

```c
#ifndef INCLUDED_bouncer_rebind_auth_h
#define INCLUDED_bouncer_rebind_auth_h
/*
 * Rebind authorization decision, isolated from the ircd so it can be
 * unit-tested. Real rebinds are rare (about four per five months in
 * production), so this decision is pinned by tests rather than observed.
 */

/** Which signal authorized a ghost rebind, in descending strength. */
enum BounceRebindAuth {
  BRA_NONE = 0,   /**< no signal; the rebind must be refused */
  BRA_ORIGIN,     /**< introducing server matches the session's recorded origin */
  BRA_SESSID,     /**< introducing message carried a matching ,S sessid tag */
  BRA_ACC_TS      /**< incoming account TS matched the ghost's (weakest) */
};

/** Decide which signal authorizes this rebind, strongest first.
 * Returns BRA_NONE when none apply. */
extern enum BounceRebindAuth bounce_rebind_auth(int origin_match,
                                                int sessid_match,
                                                int acc_ts_match);

/** Stable name for logging. Never NULL. */
extern const char *bounce_rebind_auth_name(enum BounceRebindAuth auth);

#endif /* INCLUDED_bouncer_rebind_auth_h */
```

Create `ircd/bouncer_rebind_auth.c`:

```c
/*
 * Rebind authorization decision. Pure: no ircd dependencies, so the
 * CMocka suite links it without the server.
 */
#include "bouncer_rebind_auth.h"

enum BounceRebindAuth
bounce_rebind_auth(int origin_match, int sessid_match, int acc_ts_match)
{
  /* Sessid first: per redesign A.2/C.2 it is the canonical session
   * identity and hs_origin is historical-only metadata, so where both
   * hold the sessid is what actually established trust. */
  if (sessid_match)
    return BRA_SESSID;
  if (origin_match)
    return BRA_ORIGIN;
  if (acc_ts_match)
    return BRA_ACC_TS;
  return BRA_NONE;
}

const char *
bounce_rebind_auth_name(enum BounceRebindAuth auth)
{
  switch (auth) {
  case BRA_ORIGIN: return "origin";
  case BRA_SESSID: return "sessid";
  case BRA_ACC_TS: return "account-TS";
  case BRA_NONE:   break;
  }
  return "none";
}
```

Add to `ircd/Makefile.in` near `:220`, after `bouncer_converge.c \`:

```
	bouncer_rebind_auth.c \
```

- [ ] **Step 6: Run the test and watch it pass**

```bash
cd /home/ibutsu/testnet
scripts/dc.sh build nefarious 2>&1 | grep -E "bouncer_rebind_auth|tests?: .*(PASSED|FAILED)" | tail -10
```

Expected: `[  PASSED  ] 7 test(s).`

- [ ] **Step 7: Use the module in the gate and record the result**

In `ircd/bouncer_session.c`, add near the other includes:

```c
#include "bouncer_rebind_auth.h"
```

Declare a variable that outlives the scoped block. Immediately before the `{` at `:5972`:

```c
  enum BounceRebindAuth rebind_auth = BRA_NONE;
```

Inside the block, replace the `if (!origin_match && !sessid_match && !acc_ts_match)` refusal
test and the two `Debug` reporting branches that follow it with:

```c
    rebind_auth = bounce_rebind_auth(origin_match, sessid_match, acc_ts_match);

    if (rebind_auth == BRA_NONE) {
      Debug((DEBUG_INFO,
             "bounce_rebind: refusing — session %s origin %s != introducing "
             "server %s, no sessid-tag match (wire ,S='%s'), no account-TS "
             "match (incoming=%ld ghost=%ld, account %s); peer is not the "
             "canonical primary",
             session->hs_sessid, session->hs_origin, cli_yxx(server),
             wire_sessid ? wire_sessid : "",
             (long)incoming_acc_ts, (long)cli_user(ghost)->acc_create,
             cli_user(ghost)->account));
      return -1;
    }

    Debug((DEBUG_INFO,
           "bounce_rebind: authorizing via %s — session %s origin %s, "
           "introducing server %s, account %s",
           bounce_rebind_auth_name(rebind_auth), session->hs_sessid,
           session->hs_origin, cli_yxx(server), cli_user(ghost)->account));
```

Then extend the persistent success log at `:6098`, which is the one that survives — the
`Debug` stream only covers since container start, while `ircd-user.log` holds five months:

```c
  log_write(LS_USER, L_TRACE, 0,
            "Bouncer rebind: ghost %s rebound to remote primary %s on %s "
            "(session %s, authorized via %s)", cli_name(ghost), new_numeric,
            cli_name(server), session->hs_sessid,
            bounce_rebind_auth_name(rebind_auth));
```

- [ ] **Step 8: Verify the build and the gate's behaviour is unchanged**

```bash
cd /home/ibutsu/testnet
scripts/dc.sh build nefarious && scripts/dc.sh build nefarious2
scripts/dc.sh -l up -d
IRC_HOST=localhost npx vitest run tests/src/ircv3/bouncer-hold-lifecycle.test.ts \
                                  tests/src/ircv3/bouncer-stale-replica.test.ts \
                                  tests/src/ircv3/bouncer-multi-attach.test.ts 2>&1 | tail -15
```

Expected: PASS. This task is a refactor plus a log field — behaviour is identical, so any
failure means the extraction changed the decision. These three cover the hold/revive and
cross-server paths the gate sits on; the full `tests/src/ircv3/bouncer-*.test.ts` set is
available if a failure needs widening, but do not run the whole suite (5+ minutes of noise).

- [ ] **Step 9: Commit**

```bash
cd /home/ibutsu/testnet/nefarious
git add include/bouncer_rebind_auth.h ircd/bouncer_rebind_auth.c \
        ircd/test/bouncer_rebind_auth_cmocka.c ircd/Makefile.in \
        ircd/test/Makefile.in ircd/bouncer_session.c
git commit -m "bouncer: record which signal authorized each ghost rebind

The rebind gate authorizes on any of three signals -- origin match, sessid-tag
match, or account-TS match -- and until now the only record of which one fired
was a Debug() line. Debug output lives in the container's stdout, which covers
since the last start; the persistent ircd-user.log holds months. So in practice
nobody could tell which gate was carrying the load.

That matters because the account-TS arm was always meant to be temporary, and
the case for removing it rests on knowing whether it ever fires. Production
sees about four rebinds per five months, so this is not a question observation
answers quickly -- the decision is extracted into a pure module and pinned by
CMocka instead, following bounce_converge_peer_wins().

Behaviour is unchanged. Sessid is reported ahead of origin because redesign
A.2/C.2 makes it the canonical session identity, and the weakest signal is
never reported when a stronger one is present -- otherwise the log would
overcount exactly the arm under review.

Co-Authored-By: Claude Opus 5 (1M context) <noreply\@anthropic.com>"
```

---

### Task 2: Retire the account-TS arm

**Files:**
- Modify: `ircd/bouncer_rebind_auth.c`, `include/bouncer_rebind_auth.h`,
  `ircd/test/bouncer_rebind_auth_cmocka.c`, `ircd/bouncer_session.c:5978-5980`

**Interfaces:**
- Consumes: `bounce_rebind_auth()` from Task 1.
- Produces: the same function, now returning `BRA_NONE` when account-TS is the only signal.
  `BRA_ACC_TS` is retained in the enum so old log lines stay interpretable.

- [ ] **Step 1: Flip the test to the intended behaviour**

In `ircd/test/bouncer_rebind_auth_cmocka.c`, replace `test_acc_ts_alone_authorizes`:

```c
static void test_acc_ts_alone_no_longer_authorizes(void **state)
{
  (void)state;
  /* Retired 2026-09. The account timestamp is a services-supplied value the
   * ircd otherwise only couriers, and matching on it is too coarse: two
   * unrelated non-bouncer connections sharing an account matched each other.
   * 8cf493c propagates the sessid through burst, which is what this arm was
   * standing in for. */
  assert_int_equal(bounce_rebind_auth(0, 0, 1), BRA_NONE);
}
```

Update the name in `main()`, and in `test_stronger_signal_wins_over_acc_ts` the two
assertions still hold unchanged — a stronger signal still wins — so leave them as the guard
that the removal did not disturb the other arms.

- [ ] **Step 2: Run the test and watch it fail**

```bash
cd /home/ibutsu/testnet
scripts/dc.sh build nefarious 2>&1 | grep -A3 "acc_ts_alone" | head -10
```

Expected: FAIL — `0x3 != 0x0`, i.e. still returning `BRA_ACC_TS`.

- [ ] **Step 3: Remove the arm**

In `ircd/bouncer_rebind_auth.c`, delete the `acc_ts_match` branch:

```c
enum BounceRebindAuth
bounce_rebind_auth(int origin_match, int sessid_match, int acc_ts_match)
{
  /* acc_ts_match is accepted and ignored: retired 2026-09, see the header.
   * The parameter stays so callers and old log lines keep their shape. */
  (void)acc_ts_match;

  if (sessid_match)
    return BRA_SESSID;
  if (origin_match)
    return BRA_ORIGIN;
  return BRA_NONE;
}
```

In `include/bouncer_rebind_auth.h`, annotate the enumerator rather than deleting it:

```c
  BRA_ACC_TS      /**< retired 2026-09; never returned. Kept so log lines
                       written before the retirement remain interpretable. */
```

Leave `acc_ts_match` computed in `bouncer_session.c:5978-5980`: it still feeds the refusal
`Debug`, which is the line an operator reads if this change turns out to be wrong.

- [ ] **Step 4: Run the test and watch it pass**

```bash
cd /home/ibutsu/testnet
scripts/dc.sh build nefarious 2>&1 | grep -E "bouncer_rebind_auth|PASSED|FAILED" | tail -5
```

Expected: `[  PASSED  ] 7 test(s).`

- [ ] **Step 5: Verify the rebind path still works where it should**

```bash
scripts/dc.sh build nefarious2
scripts/dc.sh -l up -d
IRC_HOST=localhost npx vitest run tests/src/ircv3/bouncer-hold-lifecycle.test.ts \
                                  tests/src/ircv3/bouncer-stale-replica.test.ts \
                                  tests/src/ircv3/bouncer-multi-attach.test.ts 2>&1 | tail -15
```

Expected: PASS. The sessid path (`8cf493c`) now carries the burst case alone. A failure here
is the answer to the question this whole change asks — capture the failing scenario, because
it means option A does not in fact cover it, and stop rather than adapting the test.

- [ ] **Step 6: Commit**

```bash
cd /home/ibutsu/testnet/nefarious
git add ircd/bouncer_rebind_auth.c include/bouncer_rebind_auth.h \
        ircd/test/bouncer_rebind_auth_cmocka.c
git commit -m "bouncer: retire the account-TS rebind authorization arm

219ab03 added account-TS matching as a receiver-side fallback for the case
where a leaf re-links during burst carrying a user whose account matches a held
ghost, and neither the origin nor a sessid tag matches. 8cf493c then fixed that
properly on the sender side by propagating the sessid through burst. The
fallback was kept as defense-in-depth with an explicit note to demote or remove
it once A had production confidence -- four months ago.

It is too coarse to keep on its merits: bounce_set_n_sessid_hint() already
warns it 'can rebind unrelated non-bouncer connections that happen to share an
account'. The account timestamp is a services-supplied value that the ircd
otherwise only parses and forwards; upstream nefarious never compares it at
all, and after this change neither do we.

acc_ts_match is still computed and still appears in the refusal Debug, because
that line is what an operator reads if this turns out to be wrong. BRA_ACC_TS
stays in the enum so log lines written before the retirement remain readable.

Co-Authored-By: Claude Opus 5 (1M context) <noreply\@anthropic.com>"
```

- [ ] **Step 7: Push to both fork branches**

```bash
cd /home/ibutsu/testnet/nefarious
git push -u origin fix/retire-rebind-acc-ts-gate
```

Then report. Per `feedback_push_both_fork_branches` the work must reach both
`ircv3.2-hardening` and `ircv3.2-upgrade`; the classifier has historically blocked the
upgrade push, in which case hand the user the exact command rather than retrying.

---

## What this unblocks

With `acc_ts_match` gone, **nothing anywhere reads the account timestamp** — upstream
nefarious never did, and X3's use is retired by the step 1 plan. That is the premise design
E rests on, and it is what withdraws the `account_created_at` carrier attribute, the libkc
fallback ladder, the seeding migration, the realm protocol mapper, and the cross-path
stamping fix.

## What to watch afterwards

The failure mode is rare and loud, not silent: a refused rebind produces the "Overruled by
older nick" churn from `bouncer-burst-rebind-sessid-gap.md`, at a path frequency of roughly
four events per five months. Watch for:

```bash
grep "authorized via" ircd-user.log        # which gate now carries rebinds
grep "Overruled by older nick" ircd-*.log  # the symptom if this was wrong
```

If a refusal does appear, the fix is to extend the sessid propagation to whatever case it
exposes — not to restore the account-TS arm, which would re-introduce a coarse match on a
value nothing else on the network consumes.
