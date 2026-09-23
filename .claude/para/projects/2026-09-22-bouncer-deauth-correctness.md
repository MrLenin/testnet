# Account Deauth Correctness Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make account deauthorization a single, correct, account-level operation shared by every caller, so the live-in-prod local-alias gap closes and the webhook's session walk stops being able to split-brain the network.

**Architecture:** Extract the two pure decision points — BX U field identity and per-client deauth action — into an ircd-header-free module (`ircd/bouncer_deauth.c`) unit-tested under CMocka, following the existing `bouncer_converge.c` precedent. Then collapse the two drifted BX U field-apply blocks into one shared applier keyed on that enum, and collapse the two drifted deauth bodies (`ms_account 'U'` and `sasl_webhook.c:deauth_client`) into one shared local-application helper. The impure drivers keep their own S2S emission so loop-prevention semantics stay where they belong.

**Tech Stack:** C (ircu/Nefarious tree, autotools), CMocka for unit tests, Vitest + the testnet Docker bed for integration.

**Spec:** `.claude/para/projects/keycloak-webhook-audit-2026-09.md` — findings B-1 through B-8. Read it before starting; this plan argues from it.

## Scope

This is **plan 1 of 3** from that audit. It is deliberately the first because B-1 is live in prod today and because **B-2 must land before the webhook's username fix (P0-1) arms the session walk**.

- **This plan:** consumer-side deauth/kill correctness (B-1, B-2, B-3, B-4, B-6, B-7-side).
- **Plan 2 (not yet written):** payload contract re-derivation — P0-1, P0-2, the SPI's X3-shaped contract, `realmName`. Must not land before this plan.
- **Plan 3 (not yet written):** transport + operability — P0-3 config threading and bind/HMAC/realm checks, P0-4 STATS surface, P1-1 bed secret, P1-3 SCRAM payload, P1-4 SPI resource model.

**Explicitly deferred, not dropped** (per `feedback_no_silent_defer`):
- **B-5** (clearing the account detaches the client from its own session; possible immortal ghost) stays **instrumentation-only**. Nobody has reported the observable signature — an accountless client stuck in a channel, or an unusable nick. Task 9 adds the log trigger; sizing a fix waits for field data.
- **Network-wide forced disconnect.** Task 6 scopes the kill walk to local sockets and flips `WEBHOOK_KILL_ON_DELETE` to default off, because a correct network-wide forced disconnect needs its own design (per-client `CMD_KILL` with `FLAG_KILLED`, or a new account-level token). Shipping a kill that only half-propagates is worse than deauth. Recorded as an open design item at the end of this plan.

## Global Constraints

- **`ircd/bouncer_deauth.c` must stay free of ircd headers.** It is compiled standalone into the CMocka binary. Verbatim rule from `ircd/bouncer_converge.c:9-10`: "Keep this file free of ircd headers: it is compiled standalone for the cmocka suite."
- **`ircd_strncpy` has strlcpy semantics** — it always NUL-terminates and takes the full buffer size including the NUL. Pass `FIELDLEN + 1`, never `sizeof` a pointer. See the `nefarious-codebase` skill's truncation audit rule.
- **Never modify testnet or irctest test files to make code pass** (`feedback_no_test_changes`). Fix the server.
- **Do not stack PRs or PR branch→branch on evilnet repos** (`feedback_no_stacked_prs_upstream`).
- **Push every fork commit to both `ircv3.2-hardening` and `ircv3.2-upgrade` on both remotes** (`feedback_push_both_fork_branches`). The classifier may block the upgrade push; hand it to the user if so.
- **Do not commit without asking** (`feedback_no_overzealous_commits`). The commit steps in this plan are the *proposed* commit points — confirm with the user before the first one.
- **Build with `scripts/dc.sh`, never raw `docker compose`** (`feedback_use_dc_script`). `build nefarious` does **not** rebuild `nefarious2` — rebuild both for cross-server tests (`project_dc_rebuild_both_servers`).
- **Check `df` before rebuilds** (`bed-disk-full-cores`); prune builder cache first, never `docker image prune -a`.
- Working branch: `nefarious` is checked out on `bed-deploy`, which is currently identical to `origin/ircv3.2-hardening`. Deploy = stash + reset `bed-deploy` (`bed-deploy-branch`).

## Bouncer invariants this work must not break

From the `bouncer-architecture` skill; the analyst pass flagged these as the live ones for this change:

- **#1** — any `hs_state` change on the local side must be mirrored in the BX P / BS handler on replicas. A session-destroy fan-out must not leave a peer ACTIVE with a dead primary.
- **#2** — if any alias is renamed or has its identity touched, pair it with `sendcmdto_one(alias, CMD_NICK, …)`.
- **#3** — any `%s%s` numeric built in a BS/BX handler uses `cli_yxx(sptr)`, never `hs_origin`.
- **#6** — do **not** invent a "spare this alias" flag. Whole-session loss on kill is by design (`project_bouncer_legacy_collision_cascade`).
- **#9** — `userstats_count_clear/sync` must stay balanced on every new teardown path.
- **#10** — any new client-sourced S2S egress or notice needs the alias→primary rewrite plus a reply-delivery story for the asking connection.

## File Structure

**Create:**
- `include/bouncer_deauth.h` — the two pure enums + function declarations. No ircd headers.
- `ircd/bouncer_deauth.c` — pure implementations. No ircd headers.
- `ircd/test/bouncer_deauth_cmocka.c` — CMocka suite for both pure functions.
- `tests/src/bouncer/alias-account-propagation.test.ts` — bed integration test (2-server).

**Modify:**
- `ircd/Makefile.in:220` — add `bouncer_deauth.c` to the source list.
- `ircd/test/Makefile.in:44,78,358` — register the new CMocka suite.
- `ircd/bouncer_session.c:6756-6797` — `bounce_emit_alias_update`: local-apply block → shared applier.
- `ircd/bouncer_session.c:8676-8700` — `bounce_alias_update`: receiver block → shared applier.
- `ircd/bouncer_session.c` (new function) — `bounce_apply_alias_field()`, `bounce_account_deauth_apply()`.
- `include/bouncer_session.h` — declare the two new functions.
- `ircd/m_account.c:168-208` — `'U'` branch → shared helper.
- `ircd/sasl_webhook.c:51-131` — `deauth_client` → shared helper; `handle_sessions_for_account` → classifier-driven, local-only.
- `ircd/ircd_features.c:1182` — `WEBHOOK_KILL_ON_DELETE` default 1 → 0.

---

### Task 1: Pure BX U field identity

Gives both drifted apply blocks one source of truth to switch on, and makes the missing-field bug assertable without an ircd.

**Files:**
- Create: `include/bouncer_deauth.h`
- Create: `ircd/bouncer_deauth.c`
- Create: `ircd/test/bouncer_deauth_cmocka.c`
- Modify: `ircd/Makefile.in:220`
- Modify: `ircd/test/Makefile.in:44`, `:78`, `:358`

**Interfaces:**
- Consumes: nothing.
- Produces: `enum BounceAliasField { BX_ALIAS_FIELD_UNKNOWN = 0, BX_ALIAS_FIELD_HOST, BX_ALIAS_FIELD_REALHOST, BX_ALIAS_FIELD_REALNAME, BX_ALIAS_FIELD_FAKEHOST, BX_ALIAS_FIELD_CLOAKHOST, BX_ALIAS_FIELD_CLOAKIP, BX_ALIAS_FIELD_USERNAME, BX_ALIAS_FIELD_ACCOUNT, BX_ALIAS_FIELD_CAPS, BX_ALIAS_FIELD_COUNT }` and `enum BounceAliasField bounce_alias_field_id(const char *field);` plus `const char *bounce_alias_field_name(enum BounceAliasField id);`

- [ ] **Step 1: Write the failing test**

Create `ircd/test/bouncer_deauth_cmocka.c`:

```c
/* cmocka suite for the pure bouncer deauth decision points
 * (include/bouncer_deauth.h). */
#include <stdarg.h>
#include <stddef.h>
#include <setjmp.h>
#include <string.h>
#include <cmocka.h>

#include "../../include/bouncer_deauth.h"

/* Every field name that appears on the BX U wire.  The receiver in
 * bounce_alias_update() is the reference list; the local-apply block in
 * bounce_emit_alias_update() had drifted two fields behind it, which is
 * the bug this table exists to prevent recurring. */
static const char *const wire_fields[] = {
  "host", "realhost", "realname", "fakehost",
  "cloakhost", "cloakip", "username", "account", "caps"
};

static void test_account_is_a_known_field(void **state)
{
  (void)state;
  /* The live-in-prod bug: the local-apply block had no "account" case, so
   * local aliases never learned an account set or clear. */
  assert_int_equal(bounce_alias_field_id("account"), BX_ALIAS_FIELD_ACCOUNT);
  assert_int_equal(bounce_alias_field_id("caps"), BX_ALIAS_FIELD_CAPS);
}

static void test_every_wire_field_maps(void **state)
{
  (void)state;
  size_t i;
  for (i = 0; i < sizeof(wire_fields) / sizeof(wire_fields[0]); i++)
    assert_int_not_equal(bounce_alias_field_id(wire_fields[i]),
                         BX_ALIAS_FIELD_UNKNOWN);
}

static void test_field_ids_are_distinct_and_complete(void **state)
{
  (void)state;
  /* Completeness guard: the wire list and the enum must stay the same
   * size, so adding an enumerator without teaching the wire (or vice
   * versa) fails here rather than silently no-op'ing at runtime. */
  size_t n = sizeof(wire_fields) / sizeof(wire_fields[0]);
  size_t i, j;
  assert_int_equal((int)n, BX_ALIAS_FIELD_COUNT - 1);  /* -1 for UNKNOWN */
  for (i = 0; i < n; i++)
    for (j = i + 1; j < n; j++)
      assert_int_not_equal(bounce_alias_field_id(wire_fields[i]),
                           bounce_alias_field_id(wire_fields[j]));
}

static void test_round_trips_to_the_wire_name(void **state)
{
  (void)state;
  size_t i;
  for (i = 0; i < sizeof(wire_fields) / sizeof(wire_fields[0]); i++) {
    enum BounceAliasField id = bounce_alias_field_id(wire_fields[i]);
    assert_string_equal(bounce_alias_field_name(id), wire_fields[i]);
  }
}

static void test_unknown_and_null_are_unknown(void **state)
{
  (void)state;
  assert_int_equal(bounce_alias_field_id(NULL), BX_ALIAS_FIELD_UNKNOWN);
  assert_int_equal(bounce_alias_field_id(""), BX_ALIAS_FIELD_UNKNOWN);
  assert_int_equal(bounce_alias_field_id("nosuchfield"), BX_ALIAS_FIELD_UNKNOWN);
  /* Field names are matched case-insensitively on the wire, as
   * bounce_alias_update() used ircd_strcmp. */
  assert_int_equal(bounce_alias_field_id("ACCOUNT"), BX_ALIAS_FIELD_ACCOUNT);
  assert_ptr_equal(bounce_alias_field_name(BX_ALIAS_FIELD_UNKNOWN), NULL);
  assert_ptr_equal(bounce_alias_field_name(BX_ALIAS_FIELD_COUNT), NULL);
}

int main(void)
{
  const struct CMUnitTest tests[] = {
    cmocka_unit_test(test_account_is_a_known_field),
    cmocka_unit_test(test_every_wire_field_maps),
    cmocka_unit_test(test_field_ids_are_distinct_and_complete),
    cmocka_unit_test(test_round_trips_to_the_wire_name),
    cmocka_unit_test(test_unknown_and_null_are_unknown),
  };
  return cmocka_run_group_tests(tests, NULL, NULL);
}
```

- [ ] **Step 2: Run the test to verify it fails**

```bash
cd /home/ibutsu/testnet/nefarious/ircd/test && make bouncer_deauth_cmocka
```

Expected: FAIL at compile — `bouncer_deauth.h: No such file or directory`. That is the correct red state: the module does not exist yet.

- [ ] **Step 3: Write the header**

Create `include/bouncer_deauth.h`:

```c
/*
 * IRC - Internet Relay Chat, include/bouncer_deauth.h
 *
 * The two pure decision points of account deauthorization:
 *   1. BX U field identity — which alias field a wire name refers to.
 *      One enum both apply blocks switch on, so they cannot drift again
 *      (they had, by two fields, for the whole life of the BX U path).
 *   2. Per-client deauth action — what to do with one client when an
 *      account is deauthed or killed, from wire-visible flags alone.
 *
 * Pure (no ircd dependencies) so both are unit tested; see
 * ircd/bouncer_deauth.c for the standalone-compilation contract.
 */
#ifndef INCLUDED_bouncer_deauth_h
#define INCLUDED_bouncer_deauth_h

/** A field carried by the BX U (bouncer alias update) token. */
enum BounceAliasField {
  BX_ALIAS_FIELD_UNKNOWN = 0,
  BX_ALIAS_FIELD_HOST,
  BX_ALIAS_FIELD_REALHOST,
  BX_ALIAS_FIELD_REALNAME,
  BX_ALIAS_FIELD_FAKEHOST,
  BX_ALIAS_FIELD_CLOAKHOST,
  BX_ALIAS_FIELD_CLOAKIP,
  BX_ALIAS_FIELD_USERNAME,
  BX_ALIAS_FIELD_ACCOUNT,
  BX_ALIAS_FIELD_CAPS,
  BX_ALIAS_FIELD_COUNT           /**< enumerator count, not a field */
};

/** Map a BX U wire field name to its identity.
 * Matched case-insensitively, as the original ircd_strcmp dispatch was.
 * @param[in] field  Wire field name (may be NULL).
 * @return The field identity, or BX_ALIAS_FIELD_UNKNOWN.
 */
extern enum BounceAliasField bounce_alias_field_id(const char *field);

/** The canonical wire name for a field identity.
 * @param[in] id  A field identity.
 * @return The wire name, or NULL for UNKNOWN/COUNT/out of range.
 */
extern const char *bounce_alias_field_name(enum BounceAliasField id);

#endif /* INCLUDED_bouncer_deauth_h */
```

- [ ] **Step 4: Write the implementation**

Create `ircd/bouncer_deauth.c`:

```c
/*
 * IRC - Internet Relay Chat, ircd/bouncer_deauth.c
 *
 * This program is free software; you can redistribute it and/or modify
 * it under the terms of the GNU General Public License as published by
 * the Free Software Foundation; either version 2, or (at your option)
 * any later version.
 *
 * See include/bouncer_deauth.h.  Keep this file free of ircd headers:
 * it is compiled standalone for the cmocka suite.
 */
#include "bouncer_deauth.h"

#include <string.h>
#include <ctype.h>

/* Indexed by enum BounceAliasField; NULL at UNKNOWN so the enum value
 * doubles as the table index. */
static const char *const field_names[BX_ALIAS_FIELD_COUNT] = {
  NULL,           /* BX_ALIAS_FIELD_UNKNOWN   */
  "host",         /* BX_ALIAS_FIELD_HOST      */
  "realhost",     /* BX_ALIAS_FIELD_REALHOST  */
  "realname",     /* BX_ALIAS_FIELD_REALNAME  */
  "fakehost",     /* BX_ALIAS_FIELD_FAKEHOST  */
  "cloakhost",    /* BX_ALIAS_FIELD_CLOAKHOST */
  "cloakip",      /* BX_ALIAS_FIELD_CLOAKIP   */
  "username",     /* BX_ALIAS_FIELD_USERNAME  */
  "account",      /* BX_ALIAS_FIELD_ACCOUNT   */
  "caps"          /* BX_ALIAS_FIELD_CAPS      */
};

/* Local case-insensitive compare: ircd_strcmp lives behind an ircd
 * header, and this file may not include one.  BX U field names are
 * ASCII literals, so plain tolower() is sufficient and avoids pulling
 * in the IRC casemap (which differs only for []\~{}| — none of which
 * appear in a field name). */
static int field_casecmp(const char *a, const char *b)
{
  while (*a && *b) {
    int ca = tolower((unsigned char)*a);
    int cb = tolower((unsigned char)*b);
    if (ca != cb)
      return ca - cb;
    a++; b++;
  }
  return (unsigned char)*a - (unsigned char)*b;
}

enum BounceAliasField bounce_alias_field_id(const char *field)
{
  int i;

  if (!field || !field[0])
    return BX_ALIAS_FIELD_UNKNOWN;

  for (i = BX_ALIAS_FIELD_UNKNOWN + 1; i < BX_ALIAS_FIELD_COUNT; i++) {
    if (0 == field_casecmp(field, field_names[i]))
      return (enum BounceAliasField)i;
  }
  return BX_ALIAS_FIELD_UNKNOWN;
}

const char *bounce_alias_field_name(enum BounceAliasField id)
{
  if (id <= BX_ALIAS_FIELD_UNKNOWN || id >= BX_ALIAS_FIELD_COUNT)
    return NULL;
  return field_names[id];
}
```

- [ ] **Step 5: Wire the build**

In `ircd/Makefile.in`, add to the source list immediately after line 220 (`bouncer_converge.c \`):

```make
	bouncer_deauth.c \
```

In `ircd/test/Makefile.in`, add to `CMOCKA_TESTPROGS` after line 44 (`bouncer_converge_cmocka \`):

```make
	bouncer_deauth_cmocka \
```

Add to the sources list after line 78 (`bouncer_converge_cmocka.c \`):

```make
	bouncer_deauth_cmocka.c \
```

Add the build rules after line 364 (after the `bouncer_converge_cmocka` rule):

```make
# bouncer_deauth tests - the module is pure (no ircd deps)
bouncer_deauth_test.o: ../bouncer_deauth.c ../../include/bouncer_deauth.h
	${CC} ${CFLAGS} ${CPPFLAGS} -c -o $@ ../bouncer_deauth.c

BOUNCER_DEAUTH_CMOCKA_OBJS = bouncer_deauth_cmocka.o bouncer_deauth_test.o
bouncer_deauth_cmocka: $(BOUNCER_DEAUTH_CMOCKA_OBJS)
	${CC} -o $@ $(LDFLAGS) $(BOUNCER_DEAUTH_CMOCKA_OBJS) $(CMOCKA_LIBS)
```

- [ ] **Step 6: Run the test to verify it passes**

```bash
cd /home/ibutsu/testnet/nefarious/ircd/test && make bouncer_deauth_cmocka && ./bouncer_deauth_cmocka
```

Expected: PASS, 5 tests. If `test_field_ids_are_distinct_and_complete` fails on the count assertion, the enum and `wire_fields[]` have drifted — that is the guard working; reconcile them.

- [ ] **Step 7: Confirm the kc boundary guard still passes**

```bash
cd /home/ibutsu/testnet/nefarious && make check-kc-boundary
```

Expected: PASS. The new file is not under `ircd/kc/`, so it is outside the allow-list's scope; this step confirms the guard was not disturbed.

- [ ] **Step 8: Propose the commit** (confirm with the user first — `feedback_no_overzealous_commits`)

```bash
cd /home/ibutsu/testnet/nefarious
git add include/bouncer_deauth.h ircd/bouncer_deauth.c \
        ircd/test/bouncer_deauth_cmocka.c ircd/Makefile.in ircd/test/Makefile.in
git commit -m "bouncer: one pure identity for every BX U alias field

The BX U field dispatch existed twice -- the local-apply block in
bounce_emit_alias_update() and the receiver in bounce_alias_update() --
and had drifted two fields apart: the local block handled neither
account nor caps.  Give both a single enum to switch on, with a cmocka
completeness guard so the next field cannot be half-implemented.

No behaviour change yet; the apply blocks move over in the next commit.

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>"
```

---

### Task 2: One shared alias-field applier — closes B-1

This is the live-in-prod fix. After this task, local aliases learn account **sets** (SASL login, `AC R`/`AC M`) and account **clears** (`AC U`, webhook deauth), and their `caps` persist.

**Files:**
- Modify: `include/bouncer_session.h` (declare the applier)
- Modify: `ircd/bouncer_session.c:6774-6789` (local-apply block)
- Modify: `ircd/bouncer_session.c:8678-8729` (receiver block)

**Interfaces:**
- Consumes: `bounce_alias_field_id()`, `enum BounceAliasField` from Task 1.
- Produces: `void bounce_apply_alias_field(struct Client *alias, enum BounceAliasField id, const char *value);` — caller must have already established that `alias` is a non-NULL `IsBouncerAlias` client with `cli_user(alias)` set.

- [ ] **Step 1: Declare the applier**

In `include/bouncer_session.h`, near the other alias declarations, add:

```c
/** Apply one BX U field update to a bouncer alias.
 *
 * The single applier for both directions: the local-alias pass inside
 * bounce_emit_alias_update() (aliases on the primary's own server, which
 * the S2S broadcast deliberately skips for loop prevention) and the
 * bounce_alias_update() receiver (aliases reached over BX U).  Having
 * one body is the point -- the two open-coded dispatches had drifted
 * two fields apart, so local aliases silently never learned account or
 * caps changes.
 *
 * @param[in] alias  A bouncer alias with cli_user() set.  The caller has
 *                   already validated IsBouncerAlias().
 * @param[in] id     Field identity from bounce_alias_field_id().
 * @param[in] value  New value; "" clears for account.
 */
extern void bounce_apply_alias_field(struct Client *alias,
                                     enum BounceAliasField id,
                                     const char *value);
```

Add `#include "bouncer_deauth.h"` to `include/bouncer_session.h`'s include block so `enum BounceAliasField` is in scope.

- [ ] **Step 2: Write the applier**

In `ircd/bouncer_session.c`, add above `bounce_emit_alias_update` (which is at `:6756`):

```c
/** See include/bouncer_session.h. */
void bounce_apply_alias_field(struct Client *alias, enum BounceAliasField id,
                              const char *value)
{
  assert(0 != alias);
  assert(0 != cli_user(alias));
  assert(0 != value);

  switch (id) {
  case BX_ALIAS_FIELD_HOST:
    ircd_strncpy(cli_user(alias)->host, value, HOSTLEN + 1);
    break;
  case BX_ALIAS_FIELD_REALHOST:
    ircd_strncpy(cli_user(alias)->realhost, value, HOSTLEN + 1);
    break;
  case BX_ALIAS_FIELD_REALNAME:
    ircd_strncpy(cli_info(alias), value, REALLEN + 1);
    break;
  case BX_ALIAS_FIELD_FAKEHOST:
    ircd_strncpy(cli_user(alias)->fakehost, value, HOSTLEN + 1);
    break;
  case BX_ALIAS_FIELD_CLOAKHOST:
    ircd_strncpy(cli_user(alias)->cloakhost, value, HOSTLEN + 1);
    break;
  case BX_ALIAS_FIELD_CLOAKIP:
    ircd_strncpy(cli_user(alias)->cloakip, value, HOSTLEN + 1);
    break;
  case BX_ALIAS_FIELD_USERNAME:
    ircd_strncpy(cli_user(alias)->username, value, USERLEN + 1);
    break;

  case BX_ALIAS_FIELD_ACCOUNT:
    /* Both directions: "" clears, anything else sets.  This case was
     * absent from the local-apply block, so every account set (SASL
     * success, AC R, AC M) and every clear (AC U, webhook deauth) was
     * lost for aliases on the primary's own server. */
    ircd_strncpy(cli_user(alias)->account, value, ACCOUNTLEN + 1);
    if (value[0] != '\0')
      SetAccount(alias);
    else
      ClearAccount(alias);
    break;

  case BX_ALIAS_FIELD_CAPS: {
    /* Update the BounceAlias entry's ba_caps for this alias.  Walk
     * the alias's account's sessions, find the matching entry by
     * full YYXXX numeric, set ba_caps + ba_caps_known.  Sender-side
     * BX M dispatch consults this to pick BX M vs BX E. */
    unsigned long caps = strtoul(value, NULL, 16);
    if (IsAccount(alias)) {
      struct AccountSessions *as =
        bounce_find_by_account(cli_user(alias)->account);
      if (as) {
        char full_numeric[6];
        struct BouncerSession *sess;
        int i;
        ircd_snprintf(0, full_numeric, sizeof(full_numeric), "%s%s",
                      cli_yxx(cli_user(alias)->server), cli_yxx(alias));
        for (sess = as->as_sessions; sess; sess = sess->hs_anext) {
          for (i = 0; i < sess->hs_alias_count; i++) {
            if (0 == strcmp(sess->hs_aliases[i].ba_numeric, full_numeric)) {
              sess->hs_aliases[i].ba_caps = (unsigned int)caps;
              sess->hs_aliases[i].ba_caps_known = 1;
              /* Persist updated caps (per redesign B.6 lifecycle hook)
               * so post-restart we know each alias's caps without
               * waiting for peer's BX U on next link. */
              bounce_db_put(sess);
            }
          }
        }
      }
    }
    break;
  }

  case BX_ALIAS_FIELD_UNKNOWN:
  case BX_ALIAS_FIELD_COUNT:
    break;
  }
}
```

- [ ] **Step 3: Move the local-apply block onto the applier**

In `ircd/bouncer_session.c`, replace the whole local-apply `if/else if` chain at `:6774-6789` (from `if (0 == ircd_strcmp(field, "host"))` through the `username` branch) so the block reads:

```c
    /* Local aliases on this (primary's) server: apply the field update
     * directly. The S2S broadcast below skips us for loop-prevention,
     * so without this pass our own local aliases stay stale. */
    if (alias && IsBouncerAlias(alias) && MyConnect(alias))
      bounce_apply_alias_field(alias, bounce_alias_field_id(field), value);
```

- [ ] **Step 4: Move the receiver block onto the applier**

In `ircd/bouncer_session.c`, replace the receiver's `if/else if` chain at `:8678-8729` (from `/* Apply update based on field name */` through the `caps` branch and its trailing `else { Debug(...) }`) with:

```c
  /* Apply update based on field name */
  {
    enum BounceAliasField fid = bounce_alias_field_id(field);
    if (fid == BX_ALIAS_FIELD_UNKNOWN)
      Debug((DEBUG_INFO, "BX U: unknown field '%s' for alias %s",
             field, alias_numeric));
    else
      bounce_apply_alias_field(alias, fid, value);
  }
```

Leave the `forward:` label and its broadcast exactly as they are.

- [ ] **Step 5: Build the ircd**

```bash
cd /home/ibutsu/testnet && scripts/dc.sh build nefarious nefarious2
```

Expected: clean build. `bouncer_session.c` must compile without a `-Wswitch` warning — if one appears, a new enumerator was added in Task 1 without a case here.

- [ ] **Step 6: Re-run the full CMocka suite**

```bash
cd /home/ibutsu/testnet/nefarious/ircd/test && make && for t in $(ls *_cmocka | grep -v '\.'); do ./$t >/dev/null || echo "FAIL: $t"; done; echo done
```

Expected: no `FAIL:` lines. This is a refactor of a shared path — the whole suite is the regression gate, not just the new file.

- [ ] **Step 7: Propose the commit**

```bash
cd /home/ibutsu/testnet/nefarious
git add include/bouncer_session.h ircd/bouncer_session.c
git commit -m "bouncer: local aliases learn account and caps changes again

bounce_emit_alias_update()'s local-apply pass handled seven of the nine
BX U fields.  account and caps were missing, so an alias on the primary's
own server never learned an account set (SASL success, AC R, AC M) or an
account clear (AC U, webhook deauth): it kept FLAG_ACCOUNT and the old
account string indefinitely, still passing +r/+R/+D/ACCOUNTONLY and still
resolving through bounce_find_by_account.  Remote aliases were fine --
the receiver had both cases -- so the divergence was invisible on a
single-server bed.

Both directions now share bounce_apply_alias_field(), so there is one
body to keep correct instead of two to keep in sync.

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>"
```

---

### Task 3: Pure per-client deauth classifier

Encodes the two gates the webhook walk is missing — locality (B-2) and held-ghost handling (B-6) — where they can be tested without a network.

**Files:**
- Modify: `include/bouncer_deauth.h`
- Modify: `ircd/bouncer_deauth.c`
- Modify: `ircd/test/bouncer_deauth_cmocka.c`

**Interfaces:**
- Consumes: nothing from earlier tasks.
- Produces: `struct BounceDeauthSubject { int is_user; int is_account; int account_matches; int is_alias; int is_hold; int is_local; };`, `enum BounceDeauthAction { BOUNCE_DEAUTH_SKIP = 0, BOUNCE_DEAUTH_CLEAR_ACCOUNT, BOUNCE_DEAUTH_KILL_SOCKET, BOUNCE_DEAUTH_DESTROY_SESSION };`, and `enum BounceDeauthAction bounce_deauth_classify(const struct BounceDeauthSubject *s, int do_kill);`

- [ ] **Step 1: Write the failing tests**

Append to `ircd/test/bouncer_deauth_cmocka.c`, before `main()`:

```c
/* A matching, local, live primary: the ordinary case. */
static struct BounceDeauthSubject subj_primary(void)
{
  struct BounceDeauthSubject s;
  memset(&s, 0, sizeof(s));
  s.is_user = 1;
  s.is_account = 1;
  s.account_matches = 1;
  s.is_local = 1;
  return s;
}

static void test_local_primary_is_cleared_or_killed(void **state)
{
  (void)state;
  struct BounceDeauthSubject s = subj_primary();
  assert_int_equal(bounce_deauth_classify(&s, 0), BOUNCE_DEAUTH_CLEAR_ACCOUNT);
  assert_int_equal(bounce_deauth_classify(&s, 1), BOUNCE_DEAUTH_KILL_SOCKET);
}

static void test_remote_client_is_never_touched(void **state)
{
  (void)state;
  /* B-2: exit_client() on a remote victim emits no KILL and sends a
   * victim-sourced QUIT on every downlink, which the victim's own side
   * discards as wrong-direction -- permanent split-brain.  A remote
   * client is the other server's job; we reach it with AC U instead. */
  struct BounceDeauthSubject s = subj_primary();
  s.is_local = 0;
  assert_int_equal(bounce_deauth_classify(&s, 0), BOUNCE_DEAUTH_SKIP);
  assert_int_equal(bounce_deauth_classify(&s, 1), BOUNCE_DEAUTH_SKIP);
}

static void test_held_ghost_destroys_the_session(void **state)
{
  (void)state;
  /* B-6: a held ghost is an IsUser client with an account, so it matched
   * the old walk.  Deauthing it clears the account out from under the
   * session's own hs_client; killing it leaves the session HOLDING with
   * the DB record intact because FLAG_KILLED is unset.  Neither is the
   * right primitive -- tear the session down explicitly. */
  struct BounceDeauthSubject s = subj_primary();
  s.is_hold = 1;
  assert_int_equal(bounce_deauth_classify(&s, 0), BOUNCE_DEAUTH_DESTROY_SESSION);
  assert_int_equal(bounce_deauth_classify(&s, 1), BOUNCE_DEAUTH_DESTROY_SESSION);
}

static void test_alias_skipped_on_clear_killed_on_kill(void **state)
{
  (void)state;
  /* Aliases mirror the primary's account via bounce_apply_alias_field,
   * so a direct clear would double-apply and would leak the alias
   * numeric to legacy peers via AC U (aliases are BX C-introduced).
   * Kills still take every socket -- whole-session loss is by design
   * (invariant #6). */
  struct BounceDeauthSubject s = subj_primary();
  s.is_alias = 1;
  assert_int_equal(bounce_deauth_classify(&s, 0), BOUNCE_DEAUTH_SKIP);
  assert_int_equal(bounce_deauth_classify(&s, 1), BOUNCE_DEAUTH_KILL_SOCKET);
}

static void test_non_matching_and_non_user_are_skipped(void **state)
{
  (void)state;
  struct BounceDeauthSubject s = subj_primary();
  s.account_matches = 0;
  assert_int_equal(bounce_deauth_classify(&s, 0), BOUNCE_DEAUTH_SKIP);
  assert_int_equal(bounce_deauth_classify(&s, 1), BOUNCE_DEAUTH_SKIP);

  s = subj_primary();
  s.is_user = 0;
  assert_int_equal(bounce_deauth_classify(&s, 1), BOUNCE_DEAUTH_SKIP);

  s = subj_primary();
  s.is_account = 0;
  assert_int_equal(bounce_deauth_classify(&s, 1), BOUNCE_DEAUTH_SKIP);
}

static void test_null_subject_is_skipped(void **state)
{
  (void)state;
  assert_int_equal(bounce_deauth_classify(NULL, 0), BOUNCE_DEAUTH_SKIP);
  assert_int_equal(bounce_deauth_classify(NULL, 1), BOUNCE_DEAUTH_SKIP);
}
```

Register them in `main()`'s `tests[]`:

```c
    cmocka_unit_test(test_local_primary_is_cleared_or_killed),
    cmocka_unit_test(test_remote_client_is_never_touched),
    cmocka_unit_test(test_held_ghost_destroys_the_session),
    cmocka_unit_test(test_alias_skipped_on_clear_killed_on_kill),
    cmocka_unit_test(test_non_matching_and_non_user_are_skipped),
    cmocka_unit_test(test_null_subject_is_skipped),
```

- [ ] **Step 2: Run the tests to verify they fail**

```bash
cd /home/ibutsu/testnet/nefarious/ircd/test && make bouncer_deauth_cmocka
```

Expected: FAIL at compile — `unknown type name 'struct BounceDeauthSubject'`.

- [ ] **Step 3: Add the declarations**

Append to `include/bouncer_deauth.h`, before the closing `#endif`:

```c
/** One client, as the deauth walk sees it.  All fields are booleans
 * taken from the client's flags so the decision is testable without a
 * Client, a network, or a session table. */
struct BounceDeauthSubject {
  int is_user;          /**< IsUser(cptr) */
  int is_account;       /**< IsAccount(cptr) */
  int account_matches;  /**< account == the account being deauthed */
  int is_alias;         /**< IsBouncerAlias(cptr) */
  int is_hold;          /**< IsBouncerHold(cptr) -- a held ghost */
  int is_local;         /**< MyConnect(cptr) */
};

/** What the walk should do with one client. */
enum BounceDeauthAction {
  BOUNCE_DEAUTH_SKIP = 0,        /**< leave it entirely alone */
  BOUNCE_DEAUTH_CLEAR_ACCOUNT,   /**< deauth in place, stay connected */
  BOUNCE_DEAUTH_KILL_SOCKET,     /**< disconnect this socket */
  BOUNCE_DEAUTH_DESTROY_SESSION  /**< tear the bouncer session down */
};

/** Classify one client for an account deauth or kill.
 *
 * Locality is the load-bearing gate: a remote client must always be
 * SKIP.  exit_client() on a remote victim emits no KILL and broadcasts a
 * victim-sourced QUIT on every downlink, which servers on the victim's
 * own side discard as wrong-direction -- leaving the account holder
 * online at home and gone elsewhere.  Remote clients are reached by the
 * account-level AC U broadcast, which their own server applies.
 *
 * @param[in] s        The client's flags (NULL is SKIP).
 * @param[in] do_kill  Non-zero to disconnect rather than deauth in place.
 * @return The action to take.
 */
extern enum BounceDeauthAction
bounce_deauth_classify(const struct BounceDeauthSubject *s, int do_kill);
```

- [ ] **Step 4: Write the implementation**

Append to `ircd/bouncer_deauth.c`:

```c
enum BounceDeauthAction
bounce_deauth_classify(const struct BounceDeauthSubject *s, int do_kill)
{
  if (!s)
    return BOUNCE_DEAUTH_SKIP;

  /* Only registered users carrying the account in question. */
  if (!s->is_user || !s->is_account || !s->account_matches)
    return BOUNCE_DEAUTH_SKIP;

  /* Never act on a client we do not own the socket for. */
  if (!s->is_local)
    return BOUNCE_DEAUTH_SKIP;

  /* A held ghost has no live socket; the session is the thing to remove,
   * and neither a clear nor a socket kill accomplishes that. */
  if (s->is_hold)
    return BOUNCE_DEAUTH_DESTROY_SESSION;

  if (do_kill)
    return BOUNCE_DEAUTH_KILL_SOCKET;

  /* Aliases take the account clear through the primary's field
   * propagation, not directly. */
  if (s->is_alias)
    return BOUNCE_DEAUTH_SKIP;

  return BOUNCE_DEAUTH_CLEAR_ACCOUNT;
}
```

- [ ] **Step 5: Run the tests to verify they pass**

```bash
cd /home/ibutsu/testnet/nefarious/ircd/test && make bouncer_deauth_cmocka && ./bouncer_deauth_cmocka
```

Expected: PASS, 11 tests.

- [ ] **Step 6: Propose the commit**

```bash
cd /home/ibutsu/testnet/nefarious
git add include/bouncer_deauth.h ircd/bouncer_deauth.c ircd/test/bouncer_deauth_cmocka.c
git commit -m "bouncer: pure classifier for the account deauth walk

Encodes the two gates the webhook's GlobalClientList walk lacks: a
remote client is never touched (exit_client on a remote victim emits no
KILL and sends a wrong-direction QUIT, split-braining the network), and a
held ghost gets its session destroyed rather than its account cleared or
its absent socket killed.

Pure, so the decision table is a unit test rather than a two-server bed
run.  Callers move over in the next commits.

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>"
```

---

### Task 4: One shared local deauth application — closes B-3

`ms_account 'U'` destroys the account's sessions and clears its metadata; `deauth_client` does neither. That drift is why a webhook deauth leaves the originating server holding a revivable session and a `bounce_db` record for a deleted account while every peer discards theirs. One body, both callers.

**Files:**
- Modify: `include/bouncer_session.h` (declare the helper)
- Modify: `ircd/bouncer_session.c` (add the helper)
- Modify: `ircd/m_account.c:174-207`
- Modify: `ircd/sasl_webhook.c:51-100`

**Interfaces:**
- Consumes: `bounce_apply_alias_field()` (Task 2) indirectly, via `bounce_emit_alias_update`.
- Produces: `void bounce_account_deauth_apply(struct Client *acptr);`

**Why the S2S emission stays at the call sites:** `ms_account 'U'` is a *receiver* — it relays with `sendcmdto_serv_butone(sptr, …, cptr, …)` for loop prevention and reuses the inbound msgid. `sasl_webhook.c` is an *originator* — it broadcasts from `&me` and mints its own. Folding either into the shared helper would force one of them to lie about its provenance. The `CAP_ACCNOTIFY` channel notify also stays at the call sites because it must sit inside each caller's msgid wrapping.

- [ ] **Step 1: Declare the helper**

In `include/bouncer_session.h`:

```c
/** Apply an account deauthorization to one client, locally.
 *
 * The shared body of every deauth: the AC U receiver (ms_account) and
 * the Keycloak webhook both call it.  They had separate copies and the
 * copies drifted -- the webhook's omitted the session destroy and the
 * metadata clear, so the deauthing server kept a revivable session and a
 * bounce_db record for an account every peer had discarded.
 *
 * Does NOT emit anything on the network and does NOT send the
 * CAP_ACCNOTIFY channel notice: the receiver relays while the originator
 * broadcasts, and each wraps the notice in its own msgid, so both stay
 * at the call site.
 *
 * The account string is still set on entry and cleared on exit -- the
 * metadata and presence lookups key off it.
 *
 * @param[in] acptr  A client with IsAccount() set.
 */
extern void bounce_account_deauth_apply(struct Client *acptr);
```

- [ ] **Step 2: Write the helper**

In `ircd/bouncer_session.c`:

```c
/** See include/bouncer_session.h. */
void bounce_account_deauth_apply(struct Client *acptr)
{
  struct BouncerSession *sess;

  assert(0 != acptr);
  assert(0 != cli_user(acptr));
  assert(0 != cli_user(acptr)->account[0]);

  /* Destroy all bouncer sessions for this account before clearing it.
   * Re-lookup each iteration because bounce_destroy() may free the
   * AccountSessions struct when the last session is removed. */
  while ((sess = bounce_find_any_session(cli_user(acptr)->account)) != NULL)
    bounce_destroy(sess);

  /* Clear all persisted metadata for this account from the store and
   * free in-memory metadata entries.  Must happen while the account
   * string is still set so the lookup key is valid. */
  metadata_clear_client(acptr);

  /* Decrement authusers for all channels this user is in.
   * channel_account_adjust skips CHFL_ALIAS memberships, so a deauth
   * addressed at an alias numeric cannot steal counts the alias never
   * added. */
  channel_account_adjust(acptr, -1);

  /* Strict-presence anchor transfer: account -> session, closing the
   * account-anchored open interval (deauth previously left it open
   * forever -- unbounded forward visibility). */
  presence_anchor_transfer(acptr, cli_user(acptr)->account, 0,
                           cli_session_id(acptr), 1);

  /* Emit the alias account-clear BEFORE clearing: bounce_emit_alias_update
   * bails on !IsAccount(primary), so clearing first silently stranded
   * every alias with a stale FLAG_ACCOUNT. */
  bounce_emit_alias_update(acptr, "account", "");

  ClearAccount(acptr);
  ircd_strncpy(cli_user(acptr)->account, "", ACCOUNTLEN + 1);
}
```

- [ ] **Step 3: Point `ms_account 'U'` at the helper**

In `ircd/m_account.c`, replace everything from the `/* Destroy all bouncer sessions … */` comment at `:174` through the `ircd_strncpy(cli_user(acptr)->account, "", ACCOUNTLEN + 1);` at `:207` with:

```c
        bounce_account_deauth_apply(acptr);
```

Leave the `protocol_violation` guard and the `assert` above it, and the entire msgid/`ACCNOTIFY`/relay tail below it, untouched.

- [ ] **Step 4: Point `deauth_client` at the helper**

In `ircd/sasl_webhook.c`, rewrite `deauth_client` as:

```c
static void deauth_client(struct Client *cptr, const char *reason)
{
  if (!IsAccount(cptr) || !cli_user(cptr))
    return;

  /* Tell the user why before the account goes away. */
  sendcmdto_one(&me, CMD_NOTICE, cptr, "%C :%s", cptr, reason);

  /* Shared with ms_account's AC U receiver: session destroy, metadata
   * clear, authusers, presence anchor, alias propagation, account clear. */
  bounce_account_deauth_apply(cptr);

  /* Notify channel members with account-notify capability. */
  sendcmdto_common_channels_capab_butone(cptr, CMD_ACCOUNT, cptr,
                                          CAP_ACCNOTIFY, CAP_NONE, "*");

  /* Propagate the account clear.  "AC <numeric> U" is EXTENDED_ACCOUNTS
   * syntax; the legacy AC grammar has no unregister form at all (a
   * legacy parser reads "U" as an account name and raises a protocol
   * violation on the already-registered user).  Task 6 handles the
   * legacy case -- by then this branch is unconditional. */
  sendcmdto_serv_butone(&me, CMD_ACCOUNT, NULL, "%C U", cptr);

  wh_stats.sessions_killed++;
}
```

Remove the now-unused `#include "channel.h"`, `"chathistory_presence.h"` and `"bouncer_session.h"` only if no other reference remains — check with `grep -n "channel_account_adjust\|presence_anchor_transfer\|bounce_" ircd/sasl_webhook.c` before deleting any include.

- [ ] **Step 5: Build and run the full CMocka suite**

```bash
cd /home/ibutsu/testnet && scripts/dc.sh build nefarious nefarious2 && \
  cd nefarious/ircd/test && make && \
  for t in $(ls *_cmocka | grep -v '\.'); do ./$t >/dev/null || echo "FAIL: $t"; done; echo done
```

Expected: clean build, no `FAIL:` lines.

- [ ] **Step 6: Propose the commit**

```bash
cd /home/ibutsu/testnet/nefarious
git add include/bouncer_session.h ircd/bouncer_session.c ircd/m_account.c ircd/sasl_webhook.c
git commit -m "bouncer: one deauth body for AC U and the Keycloak webhook

The two deauth paths were open-coded copies and had drifted: the
webhook's omitted the bouncer-session destroy and the metadata clear
that ms_account's AC U receiver performs.  A webhook deauth therefore
left the originating server holding a revivable session, its bounce_db
record and the persisted metadata for an account every peer had already
discarded -- and bounce_apply_oper_grant re-grants oper from the session
without re-verifying the account.

S2S emission and the ACCNOTIFY notice stay at the call sites: the
receiver relays and reuses the inbound msgid, the originator broadcasts
from &me and mints its own.

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>"
```

---

### Task 5: Classifier-driven, local-only session walk — closes B-2 and B-6

**Files:**
- Modify: `ircd/sasl_webhook.c:102-131` (`handle_sessions_for_account`)
- Modify: `ircd/ircd_features.c:1182` (`WEBHOOK_KILL_ON_DELETE` default)

**Interfaces:**
- Consumes: `bounce_deauth_classify()`, `struct BounceDeauthSubject`, `enum BounceDeauthAction` (Task 3); `bounce_account_deauth_apply()` (Task 4).
- Produces: nothing new.

- [ ] **Step 1: Rewrite the walk**

In `ircd/sasl_webhook.c`, replace `handle_sessions_for_account` with:

```c
/** Apply an account deauth or kill to every LOCAL session of an account.
 *
 * Local only, deliberately.  GlobalClientList is network-wide, and
 * exit_client() on a remote victim emits no KILL while broadcasting a
 * victim-sourced QUIT on every downlink -- servers on the victim's own
 * side discard it as wrong-direction, so the account holder stays online
 * at home and disappears elsewhere, permanently, with no oper-visible
 * KILL.  Remote sessions are reached by the AC U broadcast, which each
 * server applies to its own clients.
 *
 * Walks GlobalClientList -- O(n), but account disable/delete is rare.
 */
static void handle_sessions_for_account(const char *account, const char *reason,
                                         int do_kill)
{
  struct Client *cptr, *next;

  for (cptr = GlobalClientList; cptr; cptr = next) {
    struct BounceDeauthSubject subj;
    enum BounceDeauthAction action;

    next = cli_next(cptr);

    memset(&subj, 0, sizeof(subj));
    subj.is_user         = IsUser(cptr) ? 1 : 0;
    subj.is_account      = IsAccount(cptr) ? 1 : 0;
    subj.account_matches = (cli_user(cptr)
                            && 0 == ircd_strcmp(cli_user(cptr)->account,
                                                account)) ? 1 : 0;
    subj.is_alias        = IsBouncerAlias(cptr) ? 1 : 0;
    subj.is_hold         = IsBouncerHold(cptr) ? 1 : 0;
    subj.is_local        = MyConnect(cptr) ? 1 : 0;

    action = bounce_deauth_classify(&subj, do_kill);

    switch (action) {
    case BOUNCE_DEAUTH_SKIP:
      break;

    case BOUNCE_DEAUTH_CLEAR_ACCOUNT:
      log_write(LS_SYSTEM, L_INFO, 0,
                "WEBHOOK: Deauthing session for %C (account %s): %s",
                cptr, account, reason);
      deauth_client(cptr, reason);
      break;

    case BOUNCE_DEAUTH_KILL_SOCKET:
      log_write(LS_SYSTEM, L_INFO, 0,
                "WEBHOOK: Killing session for %C (account %s): %s",
                cptr, account, reason);
      exit_client_msg(cptr, cptr, &me, "%s", reason);
      wh_stats.sessions_killed++;
      break;

    case BOUNCE_DEAUTH_DESTROY_SESSION: {
      /* Held ghost: no live socket to notify or kill.  Remove the
       * session itself, which is what "the account is gone" means for a
       * hold, and which neither a clear nor exit_client_msg() achieves
       * (the latter leaves it HOLDING with the DB record intact because
       * FLAG_KILLED is unset). */
      struct BouncerSession *sess;
      log_write(LS_SYSTEM, L_INFO, 0,
                "WEBHOOK: Destroying held session for %C (account %s): %s",
                cptr, account, reason);
      while ((sess = bounce_find_any_session(account)) != NULL)
        bounce_destroy(sess);
      wh_stats.sessions_killed++;
      break;
    }
    }
  }
}
```

Add `#include "bouncer_deauth.h"` to the `USE_LIBKC` include block in `ircd/sasl_webhook.c`.

**Iterator note (B-7):** the saved `next` is safe here because nothing on this path sets `FLAG_KILLED`, which is what gates every cross-client `exit_client()` in the teardown chain (`s_misc.c:357-379`, `:426-430`, `:648-670`, `:690-704`). `add_client_to_list` inserts at the head, so aliases are always walked before their primary. **If a future change makes this path set `FLAG_KILLED`, the saved `next` becomes a dangling pointer** — see `s_misc.c:361-371` for the `F-CN2` comment documenting a prior UAF of exactly that shape. Re-walk the loop with a two-pass collect-then-act if that ever changes.

- [ ] **Step 2: Flip the `KILL_ON_DELETE` default and fix the comment**

In `ircd/ircd_features.c:1182`, change:

```c
  F_B(WEBHOOK_KILL_ON_DELETE, 0, 1, 0),
```

to:

```c
  /* Default OFF: deauth (AC U) propagates correctly network-wide, a
   * local-only kill does not.  Forced network-wide disconnect needs its
   * own design -- see the open design item in
   * .claude/para/projects/2026-09-22-bouncer-deauth-correctness.md */
  F_B(WEBHOOK_KILL_ON_DELETE, 0, 0, 0),
```

In `ircd/sasl_webhook.c`, the comments above both `handle_sessions_for_account` calls currently read "Default: deauth (AC U). KILL_ON_DELETE escalates to disconnect." That was **wrong** for delete — `F_B`'s third argument is `def_int`, so the default was 1. It is now accurate for both; leave the wording and add to the delete-side one:

```c
    /* Default: deauth (AC U), which propagates network-wide.
     * KILL_ON_DELETE escalates to disconnecting LOCAL sockets only. */
```

- [ ] **Step 3: Verify the new default reads back**

```bash
cd /home/ibutsu/testnet && scripts/dc.sh build nefarious nefarious2 && scripts/dc.sh up -d nefarious && sleep 15 && \
  docker exec nefarious sh -c 'grep -c WEBHOOK_KILL_ON_DELETE /dev/null' ; \
  scripts/irc-test.sh 2>/dev/null | head -1 || true
```

Then as an oper, confirm via `/STATS f` that `WEBHOOK_KILL_ON_DELETE` is absent from the changed-features list (features at their default are not reported). Expected: absent, i.e. the default is now what the conf does not override.

- [ ] **Step 4: Propose the commit**

```bash
cd /home/ibutsu/testnet/nefarious
git add ircd/sasl_webhook.c ircd/ircd_features.c
git commit -m "webhook: scope the account session walk to local clients

GlobalClientList is network-wide and the walk had no MyConnect gate, so
a Keycloak delete ran exit_client_msg() on remote clients.  That emits no
KILL and broadcasts a victim-sourced QUIT on every downlink; servers on
the victim's side discard it as wrong-direction, so the account holder
stayed connected at home and vanished elsewhere -- permanent split-brain,
invisible to opers.  Remote sessions are reached by the AC U broadcast.

Held ghosts now get their session destroyed instead of being deauthed
(clearing the account out from under the session's own hs_client) or
'killed' (which left the session HOLDING with its DB record, because
FLAG_KILLED is unset on this path).

WEBHOOK_KILL_ON_DELETE defaulted to TRUE -- F_B's third argument is
def_int, not the current value -- so this was the default path, contrary
to the comment beside it.  Default it off: deauth propagates correctly,
a local-only kill does not.

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>"
```

---

### Task 6: Legacy-accounts coherence — closes B-4

Under `FEAT_EXTENDED_ACCOUNTS` off, `AC U` is suppressed but `BX U <numeric> account=` is not, so remote aliases lose the account while the primary keeps it everywhere except the deauthing server — and a relink re-teaches the account from the peer's N token, silently undoing the local clear.

**Files:**
- Modify: `ircd/bouncer_session.c` (`bounce_emit_alias_update`)
- Modify: `ircd/sasl_webhook.c` (`handle_user_event` guard)

- [ ] **Step 1: Refuse rather than half-apply**

In `ircd/sasl_webhook.c`, at the top of `handle_user_event`'s deauth-triggering branches (both the delete and the disable arm), guard before calling `handle_sessions_for_account`:

```c
    /* Deauth is not implementable under legacy accounts: the legacy AC
     * grammar has no unregister form, so peers cannot be told, while the
     * BX U alias propagation would still fire -- leaving one session whose
     * connections disagree about their own account and a network that
     * disagrees with us.  A relink then re-teaches the account from the
     * peer's N token, undoing the local clear.  Refuse loudly instead. */
    if (!feature_bool(FEAT_EXTENDED_ACCOUNTS)
        && !feature_bool(FEAT_WEBHOOK_KILL_ON_DELETE)) {
      log_write(LS_SYSTEM, L_WARNING, 0,
                "WEBHOOK: account %s deauth REFUSED -- EXTENDED_ACCOUNTS is "
                "off and KILL_ON_DELETE is off; no coherent deauth exists. "
                "Enable one of them.", event->username);
      return;
    }
```

Use `FEAT_WEBHOOK_KILL_ON_DISABLE` in the disable arm's copy of the guard.

- [ ] **Step 2: Gate the alias emit to match**

In `ircd/bouncer_session.c`'s `bounce_emit_alias_update`, wrap the `account`-field S2S broadcast so it cannot outrun `AC U`:

```c
    /* The account field rides AC U's coherence rules: if the network
     * cannot be told the account was cleared (legacy accounts have no
     * AC unregister form), do not tell the aliases either -- a
     * half-applied clear leaves one session's connections disagreeing
     * about their own account. */
    if (bounce_alias_field_id(field) == BX_ALIAS_FIELD_ACCOUNT
        && value[0] == '\0'
        && !feature_bool(FEAT_EXTENDED_ACCOUNTS))
      continue;

    sendcmdto_serv_butone(&me, CMD_BOUNCER_TRANSFER, NULL,
                          "U %s %s=%s",
                          sess->hs_aliases[i].ba_numeric, field, value);
```

- [ ] **Step 3: Build and run the CMocka suite**

```bash
cd /home/ibutsu/testnet && scripts/dc.sh build nefarious nefarious2 && \
  cd nefarious/ircd/test && make && \
  for t in $(ls *_cmocka | grep -v '\.'); do ./$t >/dev/null || echo "FAIL: $t"; done; echo done
```

Expected: clean build, no `FAIL:` lines.

- [ ] **Step 4: Propose the commit**

```bash
cd /home/ibutsu/testnet/nefarious
git add ircd/bouncer_session.c ircd/sasl_webhook.c
git commit -m "webhook: do not half-apply a deauth under legacy accounts

AC U was suppressed when EXTENDED_ACCOUNTS is off -- correctly, the
legacy AC grammar has no unregister form -- but the BX U account= alias
propagation was not gated with it.  Remote aliases therefore lost the
account while the primary kept it on every server but this one, so one
session's connections disagreed about their own account; for a remote
user the next link burst re-taught the account from the peer's N token
and silently undid the local clear.

Refuse the deauth loudly instead, and hold the alias emit to the same
coherence rule as AC U.

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>"
```

---

### Task 7: Bed integration test for the local-alias account clear

The CMocka suites prove the decision tables. This proves the thing that was actually broken: a **local** alias — an alias on the same server as its primary — losing its account on deauth.

**The trigger is available today, before plan 2.** `handle_user_event`'s disable branch needs `event->username` and `representation.enabled == false`. A synthetic payload can supply a root-level `username` (which is exactly what the SPI does for credential events), so the disable path is reachable now even though Keycloak's own `USER/UPDATE` payload cannot reach it. That is what makes this task testable ahead of the contract fix.

**Files:**
- Create: `tests/src/ircv3/bouncer-deauth-local-alias.test.ts`
- Modify: `docker-compose.yml` (publish the webhook port to loopback on the bed only)

- [ ] **Step 1: Publish the webhook port to loopback on the bed**

In `docker-compose.yml`, in the `nefarious` service's `ports:` list, add:

```yaml
      - 127.0.0.1:9090:9090
```

Loopback-only deliberately: the audit's P0-3 is that this endpoint is a mass-deauth primitive behind a static plaintext secret. The bed needs host reachability for the test; nothing beyond the host should get it.

- [ ] **Step 2: Write the failing test**

Create `tests/src/ircv3/bouncer-deauth-local-alias.test.ts`:

```ts
import { describe, it, expect, afterEach } from 'vitest';
import { request } from 'node:http';
import {
  RawSocketClient,
  uniqueNick,
  getTestAccount,
  releaseTestAccount,
  createSaslBouncerClient,
  bouncerDisableHold,
} from '../helpers/index.js';

/**
 * B-1 regression: a LOCAL bouncer alias must lose its account when the
 * account is deauthed.
 *
 * bounce_emit_alias_update()'s local-apply pass handled seven of the nine
 * BX U fields; `account` was not one of them.  The S2S broadcast skips
 * the primary's own server for loop prevention, so an alias sharing a
 * server with its primary was the one case nothing cleared -- it kept
 * FLAG_ACCOUNT and the account string indefinitely.  Remote aliases were
 * always fine, which is why a single-server bed never showed it.
 *
 * Driven through the Keycloak webhook's account-disable branch, which is
 * reachable with a synthetic payload carrying a root-level `username`.
 */
describe('Bouncer deauth clears LOCAL alias accounts', () => {
  const clients: RawSocketClient[] = [];
  const poolAccounts: string[] = [];

  const WEBHOOK_PORT = parseInt(process.env.WEBHOOK_PORT ?? '9090', 10);
  const WEBHOOK_SECRET = process.env.WEBHOOK_SECRET ?? 'x3-webhook-secret';

  afterEach(async () => {
    for (const client of clients) {
      try { await bouncerDisableHold(client); } catch { /* ignore */ }
      try { client.close(); } catch { /* ignore */ }
    }
    clients.length = 0;
    for (const account of poolAccounts) releaseTestAccount(account);
    poolAccounts.length = 0;
  });

  /** POST a Keycloak-shaped webhook event to the ircd. Resolves to the status code. */
  function postWebhook(body: unknown): Promise<number> {
    const payload = JSON.stringify(body);
    return new Promise((resolve, reject) => {
      const req = request(
        {
          host: '127.0.0.1',
          port: WEBHOOK_PORT,
          path: '/keycloak-webhook',
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'Content-Length': Buffer.byteLength(payload),
            'X-Webhook-Secret': WEBHOOK_SECRET,
          },
          timeout: 5000,
        },
        res => {
          res.resume();
          res.once('end', () => resolve(res.statusCode ?? 0));
        },
      );
      req.once('error', reject);
      req.once('timeout', () => { req.destroy(new Error('webhook POST timeout')); });
      req.end(payload);
    });
  }

  /** Ask the server what account it thinks `nick` has, via WHOIS 330. */
  async function whoisAccount(
    client: RawSocketClient,
    nick: string,
  ): Promise<string | null> {
    client.clearRawBuffer();
    client.send(`WHOIS ${nick}`);
    // 318 = RPL_ENDOFWHOIS terminates; 330 = RPL_WHOISACCOUNT carries it.
    await client.waitForLine(l => / 318 /.test(l), 5000);
    const line = client.rawBuffer.split('\r\n').find(l => / 330 /.test(l));
    if (!line) return null;
    // ":server 330 <asker> <nick> <account> :is logged in as"
    return line.split(' ')[4] ?? null;
  }

  it('clears the account on both the primary and its same-server alias', async () => {
    const { account, password } = await getTestAccount();
    poolAccounts.push(account);

    // Primary and alias on the SAME server -- the local-alias case.
    const primary = await createSaslBouncerClient(account, password, {
      nick: uniqueNick('deauthp'),
    });
    clients.push(primary.client);
    const alias = await createSaslBouncerClient(account, password, {
      nick: uniqueNick('deautha'),
    });
    clients.push(alias.client);

    // Precondition: both connections are logged in.
    expect(await whoisAccount(primary.client, primary.nick)).toBe(account);
    expect(await whoisAccount(primary.client, alias.nick)).toBe(account);

    // Disable the account via the webhook's USER/UPDATE branch.
    const status = await postWebhook({
      id: 'test-deauth-1',
      time: Date.now(),
      realmId: 'testnet',
      resourceType: 'USER',
      operationType: 'UPDATE',
      username: account,
      representation: JSON.stringify({ enabled: false }),
    });
    expect(status).toBe(200);

    // The walk is synchronous inside the event-loop tick that drains the
    // webhook queue; give it a moment to be observable.
    await new Promise(r => setTimeout(r, 1000));

    // Both connections must have lost the account.  Before the fix the
    // alias assertion failed while the primary's passed.
    expect(await whoisAccount(primary.client, primary.nick)).toBeNull();
    expect(await whoisAccount(primary.client, alias.nick)).toBeNull();
  }, 30000);
});
```

- [ ] **Step 3: Run the test against the CURRENT build to confirm it fails on the alias**

Check out the pre-Task-2 build first if the fix is already deployed, otherwise run as-is:

```bash
cd /home/ibutsu/testnet && df -h /var/lib/docker | tail -1 && \
  IRC_HOST=localhost npm test -- src/ircv3/bouncer-deauth-local-alias.test.ts
```

Expected on an unfixed build: the primary's `toBeNull()` passes and the **alias's fails**, reporting the account still present. That is the red state and the exact shape of the prod bug.

- [ ] **Step 4: Deploy the fixed build and re-run**

```bash
cd /home/ibutsu/testnet && scripts/dc.sh build nefarious nefarious2 && \
  scripts/dc.sh -l up -d && sleep 20 && \
  IRC_HOST=localhost npm test -- src/ircv3/bouncer-deauth-local-alias.test.ts
```

Expected: PASS.

- [ ] **Step 5: Confirm no collateral damage in the neighbouring bouncer suites**

```bash
cd /home/ibutsu/testnet && \
  IRC_HOST=localhost npm test -- src/ircv3/bouncer-alias-multi-server.test.ts \
                                src/ircv3/bouncer-cross-server-promote.test.ts \
                                src/ircv3/bouncer-convert-branch-ghost.test.ts
```

Expected: PASS. These are the suites that cover the alias paths this plan refactored. **Do not run the full suite** — 5+ minutes and it drowns the signal.

- [ ] **Step 6: Propose the commit**

```bash
cd /home/ibutsu/testnet
git add tests/src/ircv3/bouncer-deauth-local-alias.test.ts docker-compose.yml
git commit -m "tests: regression for the local-alias account clear on deauth

Drives the webhook's account-disable branch and asserts both the primary
and a same-server alias lose the account.  Fails on any build before the
bounce_apply_alias_field consolidation, with the alias keeping its
account -- the shape of the live prod bug.

Publishes the bed webhook port on loopback only so the test can reach it.

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>"
```

---

### Task 8: `alias_primary` sweep at client free — closes B-7's side bug

Pre-existing, independent of the webhook, surfaced by the iterator audit. There is a universal sweep for `hs_client` (`bounce_null_hs_client_pointing_at`, called from `list.c:343`, `list.c:556` and `s_misc.c:728`) but **none** for `cli_user(alias)->alias_primary`. Any `exit_client_msg` on a primary with aliases where hold is disabled — G-line/K-line enforcement, `bounce_should_hold()` returning NULL — leaves a surviving alias pointing at a recycled `struct Client`, which UAFs at the next alias→primary rewrite (`ircd_relay.c:601`, `:757`, `:856`, `:944`).

**Files:**
- Modify: `include/bouncer_session.h`
- Modify: `ircd/bouncer_session.c`
- Modify: `ircd/list.c:343`, `ircd/list.c:556`, `ircd/s_misc.c:728` — all three existing `hs_client` sweep sites

**Interfaces:**
- Produces: `void bounce_null_alias_primary_pointing_at(struct Client *gone);`

- [ ] **Step 1: Locate the three assignment sites and the existing sweep**

```bash
cd /home/ibutsu/testnet/nefarious && \
  grep -n "alias_primary" ircd/*.c include/*.h && \
  grep -n "bounce_null_hs_client_pointing_at" ircd/*.c include/*.h
```

Expected: three `alias_primary` assignment sites in `bouncer_session.c`, and the `hs_client` sweep called from **three** places — `list.c:343`, `list.c:556` and `s_misc.c:728` (verified 2026-09-22). Confirm the line numbers before editing; they shift as the earlier tasks in this plan land.

- [ ] **Step 2: Declare and write the sweep, mirroring the `hs_client` one**

In `include/bouncer_session.h`:

```c
/** Null every alias's alias_primary that points at a departing client.
 *
 * The mirror of bounce_null_hs_client_pointing_at() for the other
 * direction.  exit_client() does not promote or reap aliases when hold
 * is disabled (bounce_should_hold() returning NULL, e.g. G-line
 * enforcement), so a surviving alias can outlive its primary; once
 * free_client() recycles the struct, the next alias->primary rewrite in
 * ircd_relay.c reads freed memory.
 *
 * @param[in] gone  The client being removed.
 */
extern void bounce_null_alias_primary_pointing_at(struct Client *gone);
```

In `ircd/bouncer_session.c`:

```c
/** See include/bouncer_session.h. */
void bounce_null_alias_primary_pointing_at(struct Client *gone)
{
  struct Client *cptr;

  if (!gone)
    return;

  for (cptr = GlobalClientList; cptr; cptr = cli_next(cptr)) {
    if (!IsBouncerAlias(cptr) || !cli_user(cptr))
      continue;
    if (cli_user(cptr)->alias_primary == gone)
      cli_user(cptr)->alias_primary = NULL;
  }
}
```

- [ ] **Step 3: Call it wherever the `hs_client` sweep is called**

Immediately after **each** existing `bounce_null_hs_client_pointing_at(...)` call, add the matching sweep with the same argument that site passes:

- `ircd/list.c:343` → `bounce_null_alias_primary_pointing_at(cptr);`
- `ircd/list.c:556` → `bounce_null_alias_primary_pointing_at(cptr);`
- `ircd/s_misc.c:728` → `bounce_null_alias_primary_pointing_at(bcptr);`

The `s_misc.c` site passes `bcptr`, not `cptr` — copy the neighbouring call's argument, do not assume the name.

- [ ] **Step 4: Confirm every consumer still tolerates a NULL `alias_primary`**

```bash
cd /home/ibutsu/testnet/nefarious && grep -n -B1 -A3 "alias_primary" ircd/ircd_relay.c
```

Expected: **all six** rewrite sites (`:601`, `:757`, `:856`, `:944`, `:1038`, `:1111`) already guard with `IsBouncerAlias(sptr) && cli_user(sptr)->alias_primary` before dereferencing — verified 2026-09-22, so a NULL degrades to "no rewrite" rather than crashing, which is what makes this sweep safe to add. If a new unguarded site has appeared since, guard it in this task.

- [ ] **Step 5: Build and run the CMocka suite**

```bash
cd /home/ibutsu/testnet && scripts/dc.sh build nefarious nefarious2 && \
  cd nefarious/ircd/test && make && \
  for t in $(ls *_cmocka | grep -v '\.'); do ./$t >/dev/null || echo "FAIL: $t"; done; echo done
```

Expected: clean build, no `FAIL:` lines.

- [ ] **Step 6: Propose the commit**

```bash
cd /home/ibutsu/testnet/nefarious
git add include/bouncer_session.h ircd/bouncer_session.c ircd/list.c
git commit -m "bouncer: sweep alias_primary when a client is freed

bounce_null_hs_client_pointing_at() protects the session->client
direction at free_client(); nothing protected the alias->primary
direction.  exit_client() does not promote or reap aliases when hold is
disabled (bounce_should_hold() returning NULL, e.g. G-line enforcement),
so an alias can outlive its primary and then read a recycled struct at
the next alias->primary rewrite in ircd_relay.c.

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>"
```

---

### Task 9: Instrumentation for B-5 (no fix yet)

B-5 — clearing the account detaches a live client from its own session, because `bounce_get_session()` early-returns on `!IsAccount()` — has a theoretical tail where `bounce_session_assert_invariant` false-positives on a live client, nulls `hs_client` defensively, and leaves `bounce_hold_expire` unable to exit the ghost: an immortal, accountless client holding a nick. **Nobody has reported that signature.** This task makes it detectable rather than sizing a fix for a hypothesis.

**Files:**
- Modify: `ircd/bouncer_session.c` (`bounce_session_assert_invariant`, around `:2128-2141`)

- [ ] **Step 1: Make the false-positive distinguishable**

At the `hs_client`-account-mismatch branch, the existing warning cannot distinguish a genuinely recycled heap slot from a deliberately deauthed live client. Extend it:

The existing branch is entered when `!IsAccount(p) || account mismatch`, and a deliberately deauthed live client satisfies `!IsAccount(p)` — so it lands here indistinguishably from a recycled slot. Keep the existing wording and add the discriminator. **Use the identifiers already in scope at that site — `site`, `session`, `p`, `cli_account()`, `cli_name()`** (not `where`/`sess`/`hs_client`; verified 2026-09-22):

```c
      /* A deauthed-but-live client is NOT a recycled heap slot: the
       * account was cleared under it on purpose (webhook / AC U) while
       * hs_client still points at a perfectly valid Client.  Nulling
       * defensively in that case can leave bounce_hold_expire with a
       * NULL ghost and an immortal accountless client holding a nick.
       * Tag the two cases apart so the field can tell us which occurs.
       * See B-5 in
       * .claude/para/projects/keycloak-webhook-audit-2026-09.md */
      log_write(LS_USER, L_WARNING, 0,
                "session_invariant[%s]: session %s (account=%s) hs_client "
                "%s has account=%s — %s; nulling defensively",
                site ? site : "?", session->hs_sessid, session->hs_account,
                cli_name(p),
                IsAccount(p) ? cli_account(p) : "<none>",
                IsUser(p) && !IsAccount(p)
                  ? "LIVE-DEAUTHED live client"
                  : "heap-aliased dangling pointer");
```

- [ ] **Step 2: Build, deploy, and record the watch**

```bash
cd /home/ibutsu/testnet && scripts/dc.sh build nefarious nefarious2 && scripts/dc.sh -l up -d
```

Then add to the audit doc's B-5 entry: the grep to run is
`docker logs nefarious 2>&1 | grep 'session_invariant\[.*LIVE-DEAUTHED'`.
If that line ever appears in the field, B-5's tail is real and gets its own plan. If it never appears, B-5 closes as theoretical.

- [ ] **Step 3: Propose the commit**

```bash
cd /home/ibutsu/testnet/nefarious
git add ircd/bouncer_session.c
git commit -m "bouncer: distinguish a deauthed live client from a recycled slot

bounce_session_assert_invariant() treats any hs_client whose account
disagrees with hs_account as a recycled heap slot and nulls it.  A
deliberately deauthed live client looks identical, and nulling there can
leave bounce_hold_expire with a NULL ghost -- an immortal accountless
client holding a nick.  Nobody has reported that signature; log the two
cases distinguishably so the field can settle it before anyone sizes a
fix.

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>"
```

---

## Open design item (deliberately not in this plan)

**Network-wide forced disconnect.** Task 5 scopes the kill walk to local sockets and Task 5 Step 2 defaults `WEBHOOK_KILL_ON_DELETE` off, because there is no correct network-wide forced-disconnect primitive on this path today. The three candidates, for a later decision:

1. **Per-client `CMD_KILL`** for each remote session — gets `FLAG_KILLED` and normal KILL propagation, and makes the disconnect oper-visible. Interacts with `project_bouncer_legacy_collision_cascade` (do not gate session-destroy on `FLAG_KILL_NICK_COLLISION`) and with invariant #6.
2. **A new account-level token** ("deauth and disconnect every socket for this account"), which each server applies locally. Cleanest semantically, but it is a protocol addition and needs a legacy story.
3. **Leave it as deauth only** and let each server's own webhook listener handle its local sockets — correct only if every server runs a listener, which also makes B-8's duplicate-`AC U` wallops routine.

Until one is chosen, "kill on delete" means "deauth network-wide, and additionally disconnect local sockets if the operator turns it on".

## Self-review

**1. Spec coverage.** Audit findings vs tasks: B-1 → Tasks 1, 2, 7. B-2 → Tasks 3, 5. B-3 → Task 4. B-4 → Task 6. B-5 → Task 9 (instrumentation only, by design). B-6 → Tasks 3, 5. B-7 iterator → documented as safe-today in Task 5 Step 1 with the trigger condition named; B-7's `alias_primary` side bug → Task 8. B-8 (duplicate `AC U` wallops) → **not addressed**; it is cosmetic and its correct resolution depends on the open design item above (whether every server runs a listener). Recorded here rather than silently dropped. P0-1/P0-2/P0-3/P0-4 and the SPI findings are plans 2 and 3, per the Scope section.

**2. Placeholder scan.** No TBD/TODO, no "add error handling", no "similar to Task N", no test steps without test code. Task 8 Steps 1 and 4 are deliberately verification-first (`grep` then edit) because the line numbers shift as earlier tasks land — the step says what to expect and what to do if the expectation fails, which is a check, not a placeholder.

**3. Type consistency.** `enum BounceAliasField` / `BX_ALIAS_FIELD_*` used identically in Tasks 1, 2, 6. `bounce_alias_field_id()` and `bounce_alias_field_name()` match their Task 1 declarations. `struct BounceDeauthSubject` field names (`is_user`, `is_account`, `account_matches`, `is_alias`, `is_hold`, `is_local`) are identical in the Task 3 declaration, the Task 3 tests, and the Task 5 caller. `enum BounceDeauthAction` enumerators match across Tasks 3 and 5. `bounce_apply_alias_field(alias, id, value)` and `bounce_account_deauth_apply(acptr)` match their declarations and call sites.

**One thing to verify at execution time, not assumed here:** Task 2 Step 1 adds `#include "bouncer_deauth.h"` to `include/bouncer_session.h`. If that creates an include cycle or a build order problem, forward-declare the enum in `bouncer_session.h` instead and include the header only in the `.c` files. Check the build, do not assume.
