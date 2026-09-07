# Fork Hardening — Batch 0 (client-reachable criticals) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Close the two client-reachable CRITICALs — the SASL authzid account-takeover (F-A1) and the unguarded snprintf-accumulator stack overflows (F-MB1 + F-SW1 ×3) — on the `ircv3.2-hardening` branch.

**Architecture:** F-A1 gates authzid impersonation behind an operator allowlist (a pure `authzid_in_allowlist(csv, authcid)` helper fed from a new `FEAT_SASL_TRUSTED_AUTHZID` string list) applied at every `login_as` decision, and stores the KC-verified authcid (not the asserted identity) in the positive-auth cache. T1 replaces four `x += ircd_snprintf(…, sizeof(buf)-x, …)` accumulators with a single clamping helper `str_appendf(buf, buflen, &pos, fmt, …)` that advances `pos` by *actual* bytes written and no-ops when full.

**Tech Stack:** C (ircu/nefarious), GNU autotools, CMocka unit tests (gate the Docker image), Vitest integration tests (testnet, `tests/`).

## Global Constraints
- `ircd_strncpy` is strlcpy-like: the size arg is the **full** destination buffer size (copies ≤ n-1, always NUL-terminates). Never pass `sizeof(x)-1`.
- **One commit per finding/cluster**; commits must survive the Phase-2 rebase as distinct units. Branch: `ircv3.2-hardening` off `ircv3.2-upgrade` in the `nefarious` submodule.
- **Never modify existing irctest/Vitest test files** (`feedback_no_test_changes`); only add new ones.
- Build/test via `scripts/dc.sh` (sources `.env.local`), never raw `docker compose`. CMocka runs in the Docker build and gates the image.
- Read the `sasl-keycloak` and `nefarious-codebase` skills before editing SASL / C accessor code.
- Pure logic (the two helpers) must be unit-testable with only `test_stub.o` + `ircd_string.o` — no `Client`/`feature_*` deps inside the helper; read the feature string in the caller and pass it in (engine-purity rule).

## File structure
- `include/ircd_string.h` — declare `str_appendf` and `authzid_in_allowlist` (pure string helpers).
- `ircd/ircd_string.c` — define both helpers.
- `ircd/test/ircd_string_cmocka.c` — add unit tests for both helpers (suite already linked + gated).
- `ircd/m_batch.c`, `ircd/bouncer_session.c` — convert the 4 accumulator sites to `str_appendf`.
- `include/ircd_features.h`, `ircd/ircd_features.c` — add `FEAT_SASL_TRUSTED_AUTHZID`.
- `ircd/sasl_auth.c` — add `sasl_resolve_login_identity`, apply at the 7 `login_as` sites, fix the poscache store.
- `tests/src/sasl/authzid-impersonation.test.ts` — new Vitest integration test (testnet superproject).

---

### Task 1: `str_appendf` clamping helper + convert the 4 overflow sites (F-MB1 + F-SW1)

**Files:**
- Modify: `include/ircd_string.h` (add declaration)
- Modify: `ircd/ircd_string.c` (add definition)
- Test: `ircd/test/ircd_string_cmocka.c` (add unit tests + register)
- Modify: `ircd/m_batch.c` (`format_batch_open_tags`, ~115-160)
- Modify: `ircd/bouncer_session.c` (3 sites: ~3640, ~5945, ~7309)

**Interfaces:**
- Produces: `int str_appendf(char *buf, size_t buflen, size_t *pos, const char *fmt, ...)` — appends formatted text at `buf + *pos`, advances `*pos` by the bytes **actually** written (never the would-be length), no-ops and returns 0 when `*pos >= buflen`. Returns bytes written this call. Always leaves `buf` NUL-terminated within `buflen`.

- [ ] **Step 1: Write the failing unit tests** — append to `ircd/test/ircd_string_cmocka.c` (before the `main`/test-registration array):

```c
/* ========== str_appendf ========== */

static void test_str_appendf_basic(void **state)
{
    (void)state;
    char buf[16];
    size_t pos = 0;
    buf[0] = '\0';
    assert_int_equal(str_appendf(buf, sizeof(buf), &pos, "%s", "ab"), 2);
    assert_int_equal(str_appendf(buf, sizeof(buf), &pos, "%d", 34), 2);
    assert_string_equal(buf, "ab34");
    assert_int_equal((int)pos, 4);
}

static void test_str_appendf_clamps_at_buffer_end(void **state)
{
    (void)state;
    char buf[8];              /* 7 usable + NUL */
    size_t pos = 0;
    buf[0] = '\0';
    /* would-be 11 chars, but only 7 fit; pos must clamp to 7, not 11 */
    str_appendf(buf, sizeof(buf), &pos, "%s", "hello world");
    assert_true(pos <= sizeof(buf) - 1);
    assert_int_equal(buf[sizeof(buf) - 1], '\0');
    /* a further append must be a safe no-op, never writing past the buffer */
    assert_int_equal(str_appendf(buf, sizeof(buf), &pos, "%s", "XYZ"), 0);
    assert_true(pos <= sizeof(buf) - 1);
}

static void test_str_appendf_noop_when_pos_at_end(void **state)
{
    (void)state;
    char buf[4] = "abc";
    size_t pos = 3;
    assert_int_equal(str_appendf(buf, sizeof(buf), &pos, "z"), 0);
    assert_string_equal(buf, "abc");
    assert_int_equal((int)pos, 3);
}
```

Then register them in the CMocka test array in the same file (the `cmocka_unit_test(...)` list passed to `cmocka_run_group_tests`):

```c
    cmocka_unit_test(test_str_appendf_basic),
    cmocka_unit_test(test_str_appendf_clamps_at_buffer_end),
    cmocka_unit_test(test_str_appendf_noop_when_pos_at_end),
```

- [ ] **Step 2: Run the suite to verify the new tests fail to compile/link** (helper undefined):

Run: `make -C ircd/test cmocka 2>&1 | tail -20` (or, in Docker, the `make cmocka` step)
Expected: build/link FAIL — `undefined reference to 'str_appendf'`.

- [ ] **Step 3: Declare the helper** in `include/ircd_string.h` (next to `ircd_strncpy`, ~line 31):

```c
extern int str_appendf(char* buf, size_t buflen, size_t* pos,
                       const char* fmt, ...);
```

- [ ] **Step 4: Define the helper** in `ircd/ircd_string.c` (near the other string helpers; ensure `#include <stdarg.h>` and `#include "ircd_snprintf.h"` are present):

```c
/** Append a formatted string at buf[*pos], clamping to buflen.
 * Advances *pos by the number of bytes ACTUALLY written (never the
 * would-be length that ircd_vsnprintf returns), and is a safe no-op once
 * the buffer is full.  buf stays NUL-terminated within buflen.
 * Use this instead of the unguarded `x += ircd_snprintf(0, buf+x,
 * buflen-x, ...)` idiom, which overflows once x reaches buflen.
 */
int str_appendf(char* buf, size_t buflen, size_t* pos, const char* fmt, ...)
{
  va_list args;
  int would;
  size_t remaining, wrote;

  if (!buf || !pos || *pos >= buflen)
    return 0;                       /* full or invalid: no-op */

  remaining = buflen - *pos;        /* >= 1 */
  va_start(args, fmt);
  would = ircd_vsnprintf(0, buf + *pos, remaining, fmt, args);
  va_end(args);

  if (would <= 0)
    return 0;
  /* ircd_vsnprintf writes at most remaining-1 chars + NUL and returns the
   * would-be length; the bytes actually written are min(would, remaining-1). */
  wrote = ((size_t)would < remaining) ? (size_t)would : (remaining - 1);
  *pos += wrote;
  return (int)wrote;
}
```

- [ ] **Step 5: Run the suite to verify the helper tests pass:**

Run: `make -C ircd/test cmocka && make -C ircd/test test-cmocka 2>&1 | tail -20`
Expected: PASS (all `test_str_appendf_*`).

- [ ] **Step 6: Convert `format_batch_open_tags`** (`ircd/m_batch.c`, ~115-160) to the helper. Replace the body's `int pos` with `size_t pos`, and replace every `pos += ircd_snprintf(0, buf + pos, buflen - pos, …)` and every `buf[pos++] = …` with `str_appendf(buf, buflen, &pos, …)`. The rewritten function:

```c
static int format_batch_open_tags(char *buf, size_t buflen,
                                   struct Client *to, struct Client *from,
                                   const char *timebuf, const char *msgid,
                                   const char *label, const char *ctags)
{
  size_t pos = 0;
  int use_tags = CapOwnHas(to, CAP_MSGTAGS);
  int has_label = (label && *label && CapOwnHas(to, CAP_LABELEDRESP));
  int has_ctags = (ctags && *ctags && use_tags);
  int has_account = (use_tags && from && IsUser(from) && IsAccount(from)
                     && CapOwnHas(to, CAP_ACCOUNTTAG));

  if (!use_tags && !has_label)
    return 0;

  buf[0] = '\0';
  str_appendf(buf, buflen, &pos, "@");
  if (has_label)
    str_appendf(buf, buflen, &pos, "label=%s", label);
  if (use_tags && timebuf && *timebuf) {
    if (pos > 1) str_appendf(buf, buflen, &pos, ";");
    str_appendf(buf, buflen, &pos, "time=%s", timebuf);
  }
  if (use_tags && msgid && *msgid) {
    if (pos > 1) str_appendf(buf, buflen, &pos, ";");
    str_appendf(buf, buflen, &pos, "msgid=%s", msgid);
  }
  if (has_account) {
    if (pos > 1) str_appendf(buf, buflen, &pos, ";");
    str_appendf(buf, buflen, &pos, "account=%s", cli_user(from)->account);
  }
  if (has_ctags) {
    if (pos > 1) str_appendf(buf, buflen, &pos, ";");
    str_appendf(buf, buflen, &pos, "%s", ctags);
  }
  str_appendf(buf, buflen, &pos, " ");
  return (int)pos;
}
```

- [ ] **Step 7: Convert the three bouncer channel-list accumulators** in `ircd/bouncer_session.c` (~3640, ~5945, ~7309). At each site, change the accumulator local from `int` to `size_t` (e.g. `chans_len`, `len`, `chanlist_len`) and its guarded-separator write, then replace each `X += ircd_snprintf(0, BUF + X, sizeof(BUF) - X, FMT, …)` with `str_appendf(BUF, sizeof(BUF), &X, FMT, …)`. Concretely for the ~3640 site (apply the same shape to the other two):

```c
          alias_chans[0] = '\0';
          for (memb = cli_user(alias)->channel; memb;
               memb = memb->next_channel) {
            if (IsZombie(memb) || IsDelayedJoin(memb))
              continue;
            if (chans_len > 0)
              str_appendf(alias_chans, sizeof(alias_chans), &chans_len, " ");
            if (memb->join_msgid[0])
              str_appendf(alias_chans, sizeof(alias_chans), &chans_len,
                          "%s@%s", memb->channel->chname, memb->join_msgid);
            else
              str_appendf(alias_chans, sizeof(alias_chans), &chans_len,
                          "%s", memb->channel->chname);
          }
```

(Declare `size_t chans_len = 0;` — likewise `size_t len = 0;` at ~5945 and `size_t chanlist_len = 0;` at ~7309. Verify no other code consumes these locals as `int`.)

- [ ] **Step 8: Build the server to confirm the conversions compile:**

Run: `scripts/dc.sh -l --profile multi build nefarious 2>&1 | tail -25`
Expected: build succeeds; the CMocka gate (incl. the new `str_appendf` tests) passes.

- [ ] **Step 9: Commit:**

```bash
cd nefarious
git add include/ircd_string.h ircd/ircd_string.c ircd/test/ircd_string_cmocka.c ircd/m_batch.c ircd/bouncer_session.c
git commit -m "fork-hardening: fix snprintf-accumulator stack overflows via str_appendf (F-MB1, F-SW1)

Replace four unguarded 'x += ircd_snprintf(0, buf+x, sizeof(buf)-x, ...)'
accumulators (format_batch_open_tags + 3 bouncer channel-list builders),
where sizeof(buf)-x underflows once x exceeds buf, with a clamping
str_appendf() helper that advances by actual bytes written. Unit-tested."
```

---

### Task 2: SASL authzid allowlist gate + poscache fix (F-A1)

**Files:**
- Modify: `include/ircd_string.h` (declare `authzid_in_allowlist`)
- Modify: `ircd/ircd_string.c` (define it)
- Test: `ircd/test/ircd_string_cmocka.c` (unit tests for the pure helper)
- Modify: `include/ircd_features.h`, `ircd/ircd_features.c` (new `FEAT_SASL_TRUSTED_AUTHZID`)
- Modify: `ircd/sasl_auth.c` (`sasl_resolve_login_identity`, the 7 `login_as` sites, the poscache store)
- Test: `tests/src/sasl/authzid-impersonation.test.ts` (new Vitest integration)

**Interfaces:**
- Consumes: `str_appendf` is unrelated; this task consumes nothing from Task 1.
- Produces: `int authzid_in_allowlist(const char* csv, const char* authcid)` — 1 iff `authcid` (case-insensitively) matches a comma-or-space-separated token in `csv`; 0 if `csv` is NULL/empty or no match. Pure. And `const char* sasl_resolve_login_identity(struct SaslSession* session, const char* verified_id)` (static, in sasl_auth.c) — returns `session->authzid` only when it is non-empty, differs from `verified_id`, and `authzid_in_allowlist(feature_str(FEAT_SASL_TRUSTED_AUTHZID), verified_id)`; otherwise returns `verified_id`.

- [ ] **Step 1: Write the failing unit tests** for the pure allowlist helper — append to `ircd/test/ircd_string_cmocka.c` and register (as in Task 1 Step 1):

```c
/* ========== authzid_in_allowlist ========== */

static void test_authzid_allowlist_empty_denies(void **state)
{
    (void)state;
    assert_int_equal(authzid_in_allowlist(NULL, "svc"), 0);
    assert_int_equal(authzid_in_allowlist("", "svc"), 0);
}

static void test_authzid_allowlist_match_and_case(void **state)
{
    (void)state;
    assert_int_equal(authzid_in_allowlist("bnc,svc,relay", "svc"), 1);
    assert_int_equal(authzid_in_allowlist("bnc,svc,relay", "SVC"), 1); /* ci */
    assert_int_equal(authzid_in_allowlist("bnc svc relay", "relay"), 1); /* space-sep */
    assert_int_equal(authzid_in_allowlist("bnc,svc", "mallory"), 0);
    assert_int_equal(authzid_in_allowlist("bnc,svc", "sv"), 0);       /* no prefix match */
}
```

```c
    cmocka_unit_test(test_authzid_allowlist_empty_denies),
    cmocka_unit_test(test_authzid_allowlist_match_and_case),
```

- [ ] **Step 2: Run to verify FAIL** (undefined): `make -C ircd/test cmocka 2>&1 | tail -10` → `undefined reference to 'authzid_in_allowlist'`.

- [ ] **Step 3: Declare + define the pure helper.** In `include/ircd_string.h`:

```c
extern int authzid_in_allowlist(const char* csv, const char* authcid);
```

In `ircd/ircd_string.c`:

```c
/** Is @a authcid on the comma/space-separated @a csv allowlist (case-insensitive)?
 * Empty/NULL csv denies all.  Pure: caller passes feature_str(...) in. */
int authzid_in_allowlist(const char* csv, const char* authcid)
{
  const char *p;
  size_t alen;
  if (!csv || !*csv || !authcid || !*authcid)
    return 0;
  alen = strlen(authcid);
  for (p = csv; *p; ) {
    const char *start;
    size_t tlen;
    while (*p == ',' || *p == ' ' || *p == '\t')
      p++;
    start = p;
    while (*p && *p != ',' && *p != ' ' && *p != '\t')
      p++;
    tlen = (size_t)(p - start);
    if (tlen == alen && 0 == ircd_strncmp(start, authcid, alen))
      return 1;
  }
  return 0;
}
```

- [ ] **Step 4: Run to verify PASS:** `make -C ircd/test cmocka && make -C ircd/test test-cmocka 2>&1 | tail -15` → all `test_authzid_allowlist_*` PASS.

- [ ] **Step 5: Add the feature.** In `include/ircd_features.h` add `FEAT_SASL_TRUSTED_AUTHZID` to the `enum Feature` (near the other `FEAT_SASL_*` string features). In `ircd/ircd_features.c` add a string row (empty default → deny-all):

```c
  F_S(SASL_TRUSTED_AUTHZID, FEAT_NULL, 0, 0),
```

- [ ] **Step 6: Add the resolver + apply it at all 7 `login_as` sites** in `ircd/sasl_auth.c`. Add near the top of the file (after includes; needs `ircd_features.h`, `ircd_string.h`):

```c
/** Resolve the identity to authenticate as, enforcing the authzid allowlist.
 * Honors a client-asserted authzid only when it differs from the KC-verified
 * id AND that verified id is on FEAT_SASL_TRUSTED_AUTHZID; otherwise ignores
 * the authzid and authenticates as the verified id (closes F-A1). */
static const char *sasl_resolve_login_identity(struct SaslSession *session,
                                               const char *verified_id)
{
  if (session->authzid[0]
      && 0 != ircd_strcmp(session->authzid, verified_id)
      && authzid_in_allowlist(feature_str(FEAT_SASL_TRUSTED_AUTHZID), verified_id))
    return session->authzid;
  return verified_id;
}
```

Then replace each `login_as` assignment (7 sites) with a call. Exact edits:
- Line ~692: `const char *login_as = sasl_resolve_login_identity(session, session->authcid);`
- Line ~828: `const char *login_as = sasl_resolve_login_identity(session, cached_account);`
- Line ~1060: `const char *login_as = sasl_resolve_login_identity(session, info->username);`
- Line ~1117: `const char *login_as = sasl_resolve_login_identity(session, info->username);`
- Line ~1554: `const char *login_as = sasl_resolve_login_identity(session, session->authcid);`
- Line ~1728: `const char *login_as = sasl_resolve_login_identity(session, session->authcid);`

(The struct name `struct SaslSession` and field `authzid` are as used at those sites — confirm the exact type name via `cli_saslsession`'s declaration and match it in the resolver signature.)

- [ ] **Step 7: Fix the poscache poisoning.** At line ~700 change the store from the asserted identity to the verified authcid so a cache hit can never return an impersonated account:

```c
      poscache_insert(session->authcid, session->authcid, session->cred_hash,
                      token ? token->created_at : 0);
```

(The hit site at ~828 already re-applies `sasl_resolve_login_identity` per Step 6, so an allowlisted authzid still works on a cache hit; a non-allowlisted one resolves to the cached authcid.)

- [ ] **Step 8: Write the failing Vitest integration test** — new file `tests/src/sasl/authzid-impersonation.test.ts` in the **testnet superproject** (model structure on an existing SASL test under `tests/src/`; use the project's SASL/CAP client helpers). It must assert: (a) `AUTHENTICATE PLAIN` with base64 of `victim\0attacker\0<attacker-pass>` does **not** log in as `victim` (expect SASL success as `attacker` or SASLFAIL, and the resulting account/whois is `attacker`, never `victim`); (b) a normal `attacker\0attacker\0<pass>` still succeeds. Do **not** modify any existing test file.

- [ ] **Step 9: Run the integration test against the current build to confirm RED** (impersonation currently succeeds):

Run: `IRC_HOST=localhost npm test -- src/sasl/authzid-impersonation.test.ts`
Expected: FAIL — the current server logs the client in as `victim`.

- [ ] **Step 10: Rebuild with the fix and confirm GREEN:**

```bash
scripts/dc.sh -l --profile multi up -d --build nefarious
IRC_HOST=localhost npm test -- src/sasl/authzid-impersonation.test.ts
```
Expected: PASS — impersonation rejected/downgraded; normal login still works. (Verify the `ircd.YYYYMMDDHHMM` symlink advanced so the test ran against the new binary.)

- [ ] **Step 11: Commit:**

```bash
cd nefarious
git add include/ircd_string.h ircd/ircd_string.c ircd/test/ircd_string_cmocka.c include/ircd_features.h ircd/ircd_features.c ircd/sasl_auth.c
git commit -m "fork-hardening: gate SASL authzid impersonation behind allowlist + fix poscache (F-A1)

authzid != authcid is honored only when the KC-verified authcid is on the
new (default-empty) FEAT_SASL_TRUSTED_AUTHZID list; otherwise the client
authenticates as the verified id. Applied at all 7 login_as sites (PLAIN/
OAUTHBEARER/SCRAM/ECDSA). Positive-auth cache now stores the verified
authcid, not the asserted identity, closing the cache-poisoning amplifier."
cd ..
git add tests/src/sasl/authzid-impersonation.test.ts
git commit -m "test: add SASL authzid impersonation regression test (F-A1)"
```

---

## Self-review notes
- **Spec coverage:** Batch 0 = F-A1 (Task 2) + T1/F-MB1/F-SW1 (Task 1). Both from spec §Batch 0. ✓
- **Semantics choice (flag for maintainer):** the design said untrusted authzid is "rejected"; this plan implements the uniform, non-breaking variant — **ignore the untrusted authzid and authenticate as the verified authcid** — because it applies identically at all 7 sites with no per-site reject handling and still fully closes the impersonation. If you prefer a hard `ERR_SASLFAIL`, that's a follow-up at the PLAIN capture site.
- **Type consistency:** `str_appendf(char*, size_t, size_t*, const char*, ...)` and `authzid_in_allowlist(const char*, const char*)` are used identically wherever referenced. The bouncer accumulator locals must be `size_t` to match `str_appendf`'s `size_t *pos`.
- **Grounding to confirm at implementation:** the exact `struct SaslSession` type name (from `cli_saslsession`), and that `ircd_vsnprintf` is the va_list entry point in `ircd_snprintf.h`.
