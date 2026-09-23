# Step 5 — Keycloak identity on the wire — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** The ircd sends each account's Keycloak user id alongside the account name; X3 binds each handle to that id on first use and refuses a later announcement that carries a different id.

**Architecture:** Three independently shippable parts. **A (x3, 5-pre):** X3 follows the ircd's `AC M` (account change) and `AC U` (account removed), which it mishandles today. **B (nefarious, 5a):** the id is parsed at SASL success, stored on `struct User`, emitted on `AC R|M` (fifth parameter) and in the burst `+r account:ts:id`, parsed back, relayed, and copied to bouncer aliases. **C (x3, 5b):** `handle_info.kc_id` persisted in saxdb and indexed; `handle_account` adopts on first use and refuses a mismatch with the same rule as `LOCAL`; a `REBIND` oper command; ACCOUNTINFO display.

**Tech Stack:** C (nefarious: autotools, CMocka; x3: autotools), TypeScript/Vitest on the bed, Docker bed (`scripts/dc.sh`).

**Spec:** `.claude/para/projects/account-timestamp-authority-2026-09.md` — design F, "Step 5 scope, from the site surveys" and its rulings D1–D4; design J (`LOCAL`). Survey detail: memory `project_step5_survey_findings.md`.

## Global Constraints

- **Rulings (spec):** id encoding = 22-char unpadded base64url of the 16 UUID bytes (D1); a mismatch is refused, and the session disconnected outside a burst, refused only during a burst (D2, the `LOCAL` rule); an impersonated login (authzid ≠ verified id) carries no id (D3); ircd-side bouncer identity is step 5c, not here (D4).
- **Absent id fails open** (ratified rule): a login path that carries no id behaves exactly as today.
- **Language in code and commits:** plain and defensive — "a different Keycloak user with this name", "mismatch", "refused", "disconnected". No attack narratives.
- **Branches:** nefarious work on `fix/wire-keycloak-id` off `origin/ircv3.2-hardening` (`4de99fa`); ships by direct push to `ircv3.2-hardening` and `ircv3.2-upgrade` on origin and upstream, one command per branch, no PR (ircv3-only). x3 work on `fix/ac-account-change` (Part A) and `feature/keycloak-id-binding` (Part C), each off `upstream/master` `5d7fadb`; each is its own PR, opened by the user; never branch one off the other (they share only `handle_account`, resolved at merge).
- **Part C must be built on top of Part A's merge** for testing on the bed (it needs `AC M` handled), and on top of step 4's `77bd045` (it reuses the refusal helper). For the bed, merge locally into an integration checkout; the PR branches stay independent.
- **Commit attribution:** end every commit with `Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>`.
- **Testing rules (CLAUDE.md):** never run the full Vitest suite; run from `tests/` with `IRC_HOST=localhost npm test -- src/...`; never two `npm test` at once; rebuild BOTH `nefarious` and `nefarious2` for cross-server cases (`scripts/dc.sh -l build nefarious nefarious2`, then `up -d --no-deps nefarious nefarious2`); check `df` first.
- **X3 restarts lose unsaved state:** call `flushX3Saxdb(handle)` (tests/src/helpers/bed-control.ts) before any `docker restart x3` in a test.
- **X3 staff commands** need `O3 GOD ON` first and `*account` to target an account; assert the success reply, not the absence of a refusal.
- **kc/ files** (`ircd/kc/*.c`, `include/kc/*.h`) are the in-tree libkc: they may gain functions but may not include ircd headers (`make check-kc-boundary`).
- **Do not reuse** X3's dead saxdb key `"id"`; the new key is `kc_id`.
- **`FLAGS_STAMPED` is never cleared** in X3 (one account per session is deliberate); `AC U` unbinds only.

## Review Focus

Inputs the spec implies but no task's tests exercise, most likely to matter first; each gets a test in its owning task:
1. **A grant reply without an ID token.** The id comes from the ID token's `sub`; an *access* token's `sub` depends on the `basic` client scope (Keycloak 25+), which the ircd's admin-capable client may not carry, so the plan never reads it. If the password grant reply has no `id_token`, the login proceeds with no id (fails open, silently). Task B2 tests the extractor on a payload without `sub` (returns 0, empty out); Task B7 asserts the bed's introduction carries an id, which fails if the grant stopped asking for `scope=openid`.
2. **Ids of the wrong shape on the wire** (a relaying hop truncating, a hand-typed value). Task B1 tests `account_id_valid` on 21/23-char and bad-alphabet inputs; Task C2 drops an invalid third field and binds as if absent.
3. **`RENAME` sharing the `AC R` fifth slot** (`parv[5] == "RENAME"` on the rename branches). Task B5's parser accepts a fifth parameter only when `account_id_valid()` — the literal never validates.
4. **A same-name re-authentication** (name unchanged, id changed): `sasl_complete_login` step 7 and `ms_account` both return early on an unchanged name, so no `AC` travels. Recorded as a known limit in Task B4's commit message; the burst re-sends the current id on relink.
5. **A restored bouncer ghost** has no id (records do not carry it until 5c): its burst `+r` carries `account:ts` only → X3 fails open, as before. Task B6 asserts an alias copies the primary's id, and that a ghost with none emits the two-field form.

---

# Part A — x3: follow the ircd's `AC M` and `AC U` (5-pre)

**Why:** `cmd_account` passes the subcommand *letter* to `handle_account` for anything but `C/H/S/R` (`src/proto-p10.c:1710-1711`). An account change (`M`) leaves X3 on the old handle; an account removal (`U`) leaves X3 bound; a handle literally named `M`, `U`, `D` or `A` would be bound. Small, its own subject, and Part C needs `M`.

### Task 1 (A1): Failing bed test — X3 follows account change and removal

**Files:**
- Create: `tests/src/services/x3-account-change.test.ts`

The ircd sends `AC <user> M <account> <ts>` when a registered client re-authenticates by SASL to a different account, and `AC <user> U` when the Keycloak webhook deauthenticates a client. On the bed the webhook secret in `ircd.conf` (`WEBHOOK_SECRET`) differs from the SPI's, so the test posts its own event with the ircd's secret to `http://<nefarious ip>:9090/keycloak-webhook`; read the secret from `data/ircd.conf` rather than hard-coding it.

- [ ] **Step 1: Write the test**

```typescript
/**
 * X3 follows the ircd's account changes.
 *
 * The ircd is the account authority for SASL logins.  When a registered
 * client re-authenticates to another account it sends AC M; when a Keycloak
 * event logs a client out it sends AC U.  X3 must rebind, or unbind, to
 * match -- until now it did neither (proto-p10.c passed the letter "M"/"U"
 * to handle_account as an account name).
 *
 * GATED behind X3_AC_CHANGE=1: needs x3 from fix/ac-account-change.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import * as fs from 'node:fs';
import { run } from '../helpers/bed-control';
import { createRawSocketClient, RawSocketClient } from '../helpers/index.js';
import { authenticateSaslPlain } from '../helpers/sasl';
import { NICKSERV_NICK } from '../helpers/x3-client';
import { getKeycloakAdminToken } from '../helpers/keycloak-sync';

const GATED = process.env.X3_AC_CHANGE !== '1';
const KC = process.env.KEYCLOAK_URL || 'http://localhost:8080';
const REALM = 'testnet';
const tag = Math.random().toString(36).slice(2, 7);
const FIRST = `testacc${tag}a`, SECOND = `testacc${tag}b`, PASSWORD = 'Change!2026';
let token = '';

async function kc(p: string, init: RequestInit = {}) {
  return fetch(`${KC}/admin/realms/${REALM}${p}`, { ...init,
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json', ...(init.headers || {}) } });
}
async function kcCreateUser(username: string): Promise<string> {
  const res = await kc('/users', { method: 'POST', body: JSON.stringify({
    username, enabled: true, emailVerified: true, email: `${username}@example.com`,
    credentials: [{ type: 'password', value: PASSWORD, temporary: false }] }) });
  if (!res.ok && res.status !== 409) throw new Error(`create ${username}: ${res.status}`);
  const q = await kc(`/users?username=${username}&exact=true`);
  return (await q.json())[0].id;
}
async function kcDeleteUser(username: string) {
  const q = await kc(`/users?username=${username}&exact=true`);
  const id = (await q.json())[0]?.id;
  if (id) await kc(`/users/${id}`, { method: 'DELETE' });
}
/** X3's view of who a client is: "Account Information for <name>" or "must be authenticated". */
async function x3Account(c: RawSocketClient): Promise<string> {
  c.clearRawBuffer();
  c.send(`PRIVMSG ${NICKSERV_NICK} :ACCOUNTINFO`);
  const line = await c.waitForLine(/Account Information for|You must be authenticated first/, 10000);
  const m = /Account Information for \x02?([^\x02\s]+)/.exec(line);
  return m ? m[1] : '';
}
async function saslLogin(c: RawSocketClient, account: string) {
  const r = await authenticateSaslPlain(c, account, PASSWORD);
  expect(r.success, `SASL as ${account}: ${r.error}`).toBe(true);
}
function ircdIp(): string {
  return run('docker', ['inspect', '-f', '{{range .NetworkSettings.Networks}}{{.IPAddress}}{{end}}', 'nefarious']).trim();
}
function ircdWebhookSecret(): string {
  const m = /"WEBHOOK_SECRET"\s*=\s*"([^"]+)"/.exec(fs.readFileSync('../data/ircd.conf', 'utf8'));
  if (!m) throw new Error('WEBHOOK_SECRET not in data/ircd.conf');
  return m[1];
}

describe('X3 follows the ircd account changes', () => {
  let firstId = '';
  beforeAll(async () => {
    if (GATED) return;
    token = await getKeycloakAdminToken();
    firstId = await kcCreateUser(FIRST);
    await kcCreateUser(SECOND);
    // Keycloak-created users reach X3 by LDAP autocreate on first login; nothing to register.
  }, 60_000);
  afterAll(async () => { if (GATED) return; await kcDeleteUser(FIRST); await kcDeleteUser(SECOND); });

  it.skipIf(GATED)('rebinds when a client re-authenticates to another account (AC M)', async () => {
    const c = await createRawSocketClient();
    await c.capLs(); await c.capReq(['sasl']);
    await saslLogin(c, FIRST);
    c.capEnd(); c.register(`acc${tag}m`);
    await c.waitForNumeric('001', 15000);
    expect(await x3Account(c)).toBe(FIRST);

    await saslLogin(c, SECOND);                // post-registration re-auth -> AC M
    expect(await x3Account(c)).toBe(SECOND);   // X3 followed
    c.close();
  }, 60_000);

  it.skipIf(GATED)('unbinds when the ircd removes the account (AC U)', async () => {
    const c = await createRawSocketClient();
    await c.capLs(); await c.capReq(['sasl']);
    await saslLogin(c, FIRST);
    c.capEnd(); c.register(`acc${tag}u`);
    await c.waitForNumeric('001', 15000);
    expect(await x3Account(c)).toBe(FIRST);

    // The event the Keycloak SPI would send on a logout/disable, with the ircd's own secret.
    const body = JSON.stringify({ type: 'LOGOUT', realmId: REALM, userId: firstId, username: FIRST, time: Date.now() });
    const res = await fetch(`http://${ircdIp()}:9090/keycloak-webhook`, { method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Webhook-Secret': ircdWebhookSecret() }, body });
    expect(res.status, 'ircd webhook accepted the event').toBeLessThan(300);

    await c.waitForLine(/ACCOUNT \*|You are now logged out|logged out/i, 15000).catch(() => {});
    expect(await x3Account(c)).toBe('');       // X3 unbound; the session is not "stamped" for a second AUTH
    c.close();
  }, 60_000);
});
```

- [ ] **Step 2: Run it against the current X3 — expect both cases red**

Run (from `tests/`): `X3_AC_CHANGE=1 IRC_HOST=localhost npm test -- src/services/x3-account-change.test.ts`
Expected: `rebinds…` fails (`FIRST` still bound); `unbinds…` fails (still `FIRST`). If the webhook POST is rejected (status ≥ 300), check `data/ircd.conf`'s `WEBHOOK_SECRET` and the event shape the ircd's `kc_webhook.c` expects (`event->username`, type `LOGOUT`) before touching X3.

- [ ] **Step 3: Commit the test alone (gated, so it is safe on main)**

```bash
cd /home/ibutsu/testnet && git add tests/src/services/x3-account-change.test.ts && git commit -m "tests: X3 must follow the ircd's AC M and AC U (x3 5-pre)"
```

### Task 2 (A2): Handle `AC M` and `AC U` in `cmd_account`

**Files:**
- Modify: `x3/src/proto-p10.c:1708-1712` (`cmd_account`, the `R` branch and the fall-through)
- Modify: `x3/src/nickserv.c` — no change needed for A; `handle_account` already binds through `set_user_handle_info`, which unlinks the old handle first (`nickserv.c:1022-1134`).

**Interfaces:**
- Produces: `cmd_account` calls `call_account_func(user, stamp)` for `R` and `M`, and `set_user_handle_info(user, NULL, 0)` for `U`. Part C changes what `stamp` contains for `R`/`M` (Task C2); Part A passes `argv[3]` as today.

- [ ] **Step 1: Replace the tail of `cmd_account`**

```c
    else if(!strcmp(argv[2],"R") || !strcmp(argv[2],"M"))
    {
        /* R: the ircd set an account; M: it changed one.  Either way argv[3]
         * is the account the user has NOW.  Drop the old binding first, so a
         * name X3 does not know (or refuses) leaves the user unbound rather
         * than on the previous handle. */
        if (!strcmp(argv[2],"M") && user->handle_info)
            set_user_handle_info(user, NULL, 0);
        if (argc > 3)
            call_account_func(user, argv[3]);
    }
    else if(!strcmp(argv[2],"U"))
    {
        /* The ircd removed the account.  Unbind only: FLAGS_STAMPED stays
         * set on purpose -- one account per session -- so this user cannot
         * AUTH to another handle later, exactly as after UNREGISTER. */
        if (user->handle_info)
            set_user_handle_info(user, NULL, 0);
    }
    /* A, D and anything else are replies or unknown: nothing to bind. */
    return 1;
```

- [ ] **Step 2: Build the X3 image and deploy it**

```bash
cd /home/ibutsu/testnet && scripts/dc.sh build x3 && scripts/dc.sh up -d --no-deps x3
timeout 150 bash -c 'until docker logs --tail 40 x3 2>&1 | grep -qE "W: DH Z x3.services"; do sleep 3; done'
```

- [ ] **Step 3: Run the test — expect green**

Run: `X3_AC_CHANGE=1 IRC_HOST=localhost npm test -- src/services/x3-account-change.test.ts`
Expected: 2 passed. X3's stdout shows `AC <num> M <SECOND> <ts>` followed by ACCOUNTINFO naming `SECOND`, and `AC <num> U` followed by "must be authenticated".

- [ ] **Step 4: Commit on `fix/ac-account-change`**

```bash
cd /home/ibutsu/testnet/x3 && git switch -c fix/ac-account-change 5d7fadb && git add src/proto-p10.c && git commit -F - <<'EOF'
proto-p10: follow the ircd's AC M and AC U

cmd_account handled only C/H/S/R; every other subcommand fell through to
call_account_func(user, argv[2]) -- the letter itself as an account name.
An account change (M) left the user on the previous handle, an account
removal (U) left the user bound, and a handle named M, U, D or A would
have been bound.

M now drops the old binding and binds argv[3] through the same path as R
(so LOCAL and, later, identity checks apply).  U unbinds only:
FLAGS_STAMPED is deliberately never cleared (one account per session),
matching what UNREGISTER does for its own users.

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>
EOF
```

---

# Part B — nefarious: carry the Keycloak user id (5a)

Branch: `git switch -c fix/wire-keycloak-id 4de99fa` in a worktree or the bed checkout (the bed checkout normally sits on `bed-deploy`; use a worktree under the scratchpad and deploy via `bed-deploy` = merge, as for the crash fixes). Tasks B1–B6 each end with a host build (`make -C ircd`) and a commit; B7 builds the images and tests on the bed. The current bed X3 ignores the new field (its `AC` handler reads only the account; its `+r` parser stops at the second colon), so Part B can deploy before Part C.

### Task 3 (B1): `account_id` — the compact id codec

**Files:**
- Create: `include/account_id.h`, `ircd/account_id.c`
- Modify: `ircd/Makefile.in` (add `account_id.c` to `IRCD_SRC` after `webpush_keyring.c`, line ~218)
- Create: `ircd/test/account_id_cmocka.c`; modify `ircd/test/Makefile.in` (`CMOCKA_TESTPROGS`, `DEP_SRC`, a rule)

**Interfaces (produced):**
```c
#define ACCOUNT_ID_LEN 22
int account_id_from_uuid(const char *uuid, char out[ACCOUNT_ID_LEN + 1]); /* 1 ok, 0 malformed */
int account_id_valid(const char *id);                                    /* exactly 22 base64url chars */
```

- [ ] **Step 1: Write the failing test** `ircd/test/account_id_cmocka.c`

```c
/*
 * account_id_cmocka.c - the compact Keycloak user id: 16 UUID bytes as
 * 22 unpadded base64url characters, the form carried on the wire.
 */
#include "config.h"
#include <stdarg.h>
#include <stddef.h>
#include <setjmp.h>
#include <string.h>
#include <cmocka.h>
#include "account_id.h"
#include "webpush_keyring.h"

static void canonical_uuid_encodes_to_22_chars(void **state)
{
  char out[ACCOUNT_ID_LEN + 1];
  unsigned char raw[16]; size_t n = 0;
  (void)state;
  assert_int_equal(account_id_from_uuid("6ba7b810-9dad-11d1-80b4-00c04fd430c8", out), 1);
  assert_int_equal(strlen(out), ACCOUNT_ID_LEN);
  assert_int_equal(account_id_valid(out), 1);
  /* round trip: the 22 chars decode to the UUID's bytes */
  assert_int_equal(webpush_b64url_decode(out, strlen(out), raw, sizeof(raw), &n), 0);
  assert_int_equal(n, 16);
  assert_int_equal(raw[0], 0x6b); assert_int_equal(raw[15], 0xc8);
}

static void zero_uuid_is_all_A(void **state)
{
  char out[ACCOUNT_ID_LEN + 1];
  (void)state;
  assert_int_equal(account_id_from_uuid("00000000-0000-0000-0000-000000000000", out), 1);
  assert_string_equal(out, "AAAAAAAAAAAAAAAAAAAAAA");
}

static void hex_case_and_hyphens_do_not_matter(void **state)
{
  char a[ACCOUNT_ID_LEN + 1], b[ACCOUNT_ID_LEN + 1], c[ACCOUNT_ID_LEN + 1];
  (void)state;
  assert_true(account_id_from_uuid("6BA7B810-9DAD-11D1-80B4-00C04FD430C8", a));
  assert_true(account_id_from_uuid("6ba7b8109dad11d180b400c04fd430c8", b));
  assert_true(account_id_from_uuid("6ba7b810-9dad-11d1-80b4-00c04fd430c8", c));
  assert_string_equal(a, b);
  assert_string_equal(b, c);
}

static void malformed_uuid_is_refused(void **state)
{
  char out[ACCOUNT_ID_LEN + 1] = "keep";
  (void)state;
  assert_int_equal(account_id_from_uuid("6ba7b810-9dad-11d1-80b4-00c04fd430c", out), 0);  /* 31 digits */
  assert_int_equal(account_id_from_uuid("6ba7b810-9dad-11d1-80b4-00c04fd430c8f", out), 0); /* 33 */
  assert_int_equal(account_id_from_uuid("6ba7b810-9dad-11d1-80b4-00c04fd430cg", out), 0);  /* not hex */
  assert_int_equal(account_id_from_uuid("", out), 0);
  assert_int_equal(account_id_from_uuid(NULL, out), 0);
  assert_string_equal(out, "keep");                                                  /* untouched */
}

static void only_22_base64url_chars_are_valid(void **state)
{
  (void)state;
  assert_true(account_id_valid("a6p7gJ2tEdGAtADAT9QwyA"));
  assert_true(account_id_valid("AAAAAAAAAAAAAAAAAAAAAA"));
  assert_true(account_id_valid("-_-_-_-_-_-_-_-_-_-_-_"));
  assert_false(account_id_valid("a6p7gJ2tEdGAtADAT9Qwy"));   /* 21 */
  assert_false(account_id_valid("a6p7gJ2tEdGAtADAT9QwyAA")); /* 23 */
  assert_false(account_id_valid("a6p7gJ2tEdGAtADAT9Qwy="));  /* padding */
  assert_false(account_id_valid("a6p7gJ2tEdGAtADAT9Qw+A"));  /* standard alphabet */
  assert_false(account_id_valid("RENAME"));
  assert_false(account_id_valid(""));
  assert_false(account_id_valid(NULL));
}

int main(void)
{
  const struct CMUnitTest tests[] = {
    cmocka_unit_test(canonical_uuid_encodes_to_22_chars),
    cmocka_unit_test(zero_uuid_is_all_A),
    cmocka_unit_test(hex_case_and_hyphens_do_not_matter),
    cmocka_unit_test(malformed_uuid_is_refused),
    cmocka_unit_test(only_22_base64url_chars_are_valid),
  };
  return cmocka_run_group_tests(tests, NULL, NULL);
}
```

Makefile.in additions (test): `account_id_cmocka` in `CMOCKA_TESTPROGS` after `db_casefold_cmocka`; `account_id_cmocka.c` in `DEP_SRC`; rule:
```make
# account_id tests - the compact Keycloak user id codec (pure; links the
# webpush base64url helpers it reuses)
ACCOUNT_ID_CMOCKA_OBJS = account_id_cmocka.o ../account_id.o ../webpush_keyring.o
account_id_cmocka: $(ACCOUNT_ID_CMOCKA_OBJS)
	${CC} -o $@ $(LDFLAGS) $(ACCOUNT_ID_CMOCKA_OBJS) $(CMOCKA_LIBS)
```

- [ ] **Step 2: Run it — expect a build failure (no `account_id.h`)**

Run: `cd nefarious && ./config.status --file=ircd/test/Makefile && make -C ircd/test account_id_cmocka`
Expected: fails to compile (header missing).

- [ ] **Step 3: Implement** `include/account_id.h` (the interface above, with the doc comments) and `ircd/account_id.c`:

```c
/*
 * account_id.c - the compact form of a Keycloak user id.
 *
 * Keycloak identifies a user by a UUID.  On the P10 wire and in services'
 * database it travels as the 16 bytes in unpadded base64url: 22 characters
 * instead of 36, fitting the burst NICK line alongside the account name.
 */
#include "config.h"
#include "account_id.h"
#include "webpush_keyring.h"
#include <ctype.h>
#include <string.h>

static int hexval(int c)
{
  if (c >= '0' && c <= '9') return c - '0';
  if (c >= 'a' && c <= 'f') return c - 'a' + 10;
  if (c >= 'A' && c <= 'F') return c - 'A' + 10;
  return -1;
}

int account_id_from_uuid(const char *uuid, char out[ACCOUNT_ID_LEN + 1])
{
  unsigned char raw[16];
  int digits = 0, hi = -1;
  const char *p;

  if (!uuid)
    return 0;
  for (p = uuid; *p; p++) {
    int v;
    if (*p == '-')
      continue;                    /* the canonical 8-4-4-4-12 hyphens */
    if ((v = hexval((unsigned char)*p)) < 0 || digits == 32)
      return 0;
    if (hi < 0)
      hi = v;
    else {
      raw[digits / 2] = (unsigned char)((hi << 4) | v);
      hi = -1;
    }
    digits++;
  }
  if (digits != 32)
    return 0;
  return webpush_b64url_encode(raw, sizeof(raw), out, ACCOUNT_ID_LEN + 1) == ACCOUNT_ID_LEN;
}

int account_id_valid(const char *id)
{
  int i;

  if (!id)
    return 0;
  for (i = 0; id[i]; i++) {
    int c = (unsigned char)id[i];
    if (!(isalnum(c) || c == '-' || c == '_'))
      return 0;
  }
  return i == ACCOUNT_ID_LEN;
}
```

Note `webpush_b64url_encode` returns the length written (22 for 16 bytes) or -1; the comparison is the success test.

- [ ] **Step 4: Run — expect 5 passed**

Run: `make -C ircd account_id.o && make -C ircd/test account_id_cmocka && ./ircd/test/account_id_cmocka`
Expected: `[  PASSED  ] 5 test(s).` If `zero_uuid_is_all_A` disagrees about the exact string, the codec's alphabet is wrong, not the test.

- [ ] **Step 5: Commit**

```bash
git add include/account_id.h ircd/account_id.c ircd/Makefile.in ircd/test/account_id_cmocka.c ircd/test/Makefile.in
git commit -m "account_id: compact form of a Keycloak user id (22-char base64url)"
```
(add the Co-Authored-By trailer.)

### Task 4 (B2): `kc_jwt_extract_sub` — the user id from the ID token

**Files:**
- Modify: `ircd/kc/kc_jwt.c` (beside `kc_jwt_extract_created_at`, ~line 722), `include/kc/kc_jwt.h:60`
- Modify: `ircd/kc/kc_keycloak.c` (`parse_access_token` 135-176, `kc_user_verify_password` 1354-1359, `kc_access_token_free` 1581-1598), `include/kc/kc_keycloak.h:43-57`
- Modify: `ircd/test/kc_jwt_cmocka.c` (it `#include`s `../kc/kc_jwt.c`; add two cases)

**Why the ID token, not the access token:** the ircd's Keycloak client is an admin-capable one (it manages accounts and receives Keycloak events), and an access token's `sub` claim comes from the `basic` client scope, which such a client may not carry. An ID token carries `sub` by definition (OpenID Connect Core, section 2), independent of client scopes: on the bed the `basic` scope's `sub` mapper targets only the access token and introspection. Asking the password grant for `scope=openid` makes Keycloak return the ID token in the same reply, so this costs no extra request and no admin call, which is the preference for the ircd whenever feasible. Confirmed on the bed 2026-09-23 (Keycloak 26.4.7): the grant as `x3-services` with `scope=openid` returns `id_token` whose `sub` equals the access token's.

**Interfaces (produced):** `int kc_jwt_extract_sub(const char *token, char *out, size_t out_size);` — 1 and the `sub` claim copied on success; 0 (and `out[0] = '\0'`) when the token is malformed or has no `sub`. `struct kc_access_token` gains `char *id_token; size_t id_token_size;` (NULL when the reply carried none).

- [ ] **Step 1: Write the failing tests** (append to `kc_jwt_cmocka.c` before `main`, register in `main`):

```c
/* header.payload.signature with a hand-built payload; only the payload matters here */
static char *jwt_with_payload(const char *json)
{
    char *b64 = NULL, *p, *tok;
    size_t n = kc_base64_encode_alloc(json, strlen(json), &b64);   /* standard alphabet */
    assert_non_null(b64);
    for (p = b64; *p; p++) {                                        /* -> base64url, unpadded */
        if (*p == '+') *p = '-';
        else if (*p == '/') *p = '_';
        else if (*p == '=') { *p = '\0'; break; }
    }
    (void)n;
    tok = malloc(strlen(b64) + 8);
    sprintf(tok, "e30.%s.sig", b64);                                 /* "e30" = {} */
    free(b64);
    return tok;
}

static void test_extract_sub_present(void **state) {
    char out[64] = "x";
    char *tok = jwt_with_payload("{\"sub\":\"6ba7b810-9dad-11d1-80b4-00c04fd430c8\",\"exp\":9999999999}");
    (void)state;
    assert_int_equal(kc_jwt_extract_sub(tok, out, sizeof(out)), 1);
    assert_string_equal(out, "6ba7b810-9dad-11d1-80b4-00c04fd430c8");
    free(tok);
}

static void test_extract_sub_absent_or_malformed(void **state) {
    char out[64] = "x";
    char *tok = jwt_with_payload("{\"exp\":9999999999}");
    (void)state;
    assert_int_equal(kc_jwt_extract_sub(tok, out, sizeof(out)), 0);   /* no sub: not an ID token */
    assert_string_equal(out, "");
    free(tok);
    strcpy(out, "x");
    assert_int_equal(kc_jwt_extract_sub("not.a.jwt", out, sizeof(out)), 0);
    assert_string_equal(out, "");
    assert_int_equal(kc_jwt_extract_sub(NULL, out, sizeof(out)), 0);
    assert_int_equal(kc_jwt_extract_sub("h.p", NULL, 0), 0);
}
```
`main`: add `cmocka_unit_test(test_extract_sub_present), cmocka_unit_test(test_extract_sub_absent_or_malformed),`.

- [ ] **Step 2: Run — expect a compile failure** (`kc_jwt_extract_sub` undeclared)

Run: `make -C ircd/test kc_jwt_cmocka`

- [ ] **Step 3: Implement** in `kc_jwt.c`, after `kc_jwt_extract_created_at`:

```c
int
kc_jwt_extract_sub(const char *token, char *out, size_t out_size)
{
    const char *dot1, *dot2, *sub;
    char *payload_b64, *payload;
    size_t payload_b64_len, payload_len = 0;
    json_error_t error;
    json_t *root, *claim;
    int ok = 0;

    if (out && out_size)
        out[0] = '\0';
    if (!token || !out || !out_size)
        return 0;

    /* Payload sits between the first and second '.' */
    if (!(dot1 = strchr(token, '.')) || !(dot2 = strchr(dot1 + 1, '.')))
        return 0;
    payload_b64_len = dot2 - dot1 - 1;
    if (!(payload_b64 = malloc(payload_b64_len + 1)))
        return 0;
    memcpy(payload_b64, dot1 + 1, payload_b64_len);
    payload_b64[payload_b64_len] = '\0';
    payload = base64url_decode_alloc(payload_b64, &payload_len);
    free(payload_b64);
    if (!payload)
        return 0;
    root = json_loadb(payload, payload_len, 0, &error);
    free(payload);
    if (!root)
        return 0;

    claim = json_object_get(root, "sub");
    if (json_is_string(claim) && (sub = json_string_value(claim)) && *sub
        && strlen(sub) < out_size) {
        strcpy(out, sub);
        ok = 1;
    }
    json_decref(root);
    return ok;
}
```
Header: after the `created_at` declaration:
```c
/**
 * Extract the "sub" claim -- the Keycloak user id -- from a JWT (the ID
 * token of a password grant) without validation: Keycloak minted it in
 * reply to the credentials we just sent.
 * @return 1 and the claim in out, or 0 with out empty when absent/malformed.
 */
int kc_jwt_extract_sub(const char *token, char *out, size_t out_size);
```

- [ ] **Step 3b: Ask for the ID token and keep it** (`kc_keycloak.c`, `kc_keycloak.h`). No unit harness links `kc_keycloak.c` (it needs libcurl), so this change is covered by Task B7's bed test, which fails if the introduction carries no id.

`include/kc/kc_keycloak.h`, in `struct kc_access_token` after `scope_size`:
```c
    char *id_token;               /* OpenID Connect ID token; NULL when the grant did not ask for one */
    size_t id_token_size;
```
`parse_access_token`, after the `scope` block:
```c
    tok->id_token = json_get_string(json, "id_token");
    if (tok->id_token)
        tok->id_token_size = strlen(tok->id_token);
```
`kc_access_token_free`, after the `refresh_token` block (an ID token names the user; zero it like the others):
```c
    if (token->id_token) {
        memset(token->id_token, 0, token->id_token_size);
        free(token->id_token);
    }
```
`kc_user_verify_password`: both `snprintf` format strings become
```c
        "grant_type=password&scope=openid&client_id=%s&client_secret=%s&username=%s&password=%s",
```
with the argument lists unchanged. `openid` is the OpenID Connect marker, not a removable client scope, so no client configuration can leave it out.

- [ ] **Step 4: Run — expect all kc_jwt cases to pass**, then `make -C ircd` (recompiles `kc_keycloak.c`) and `make check-kc-boundary` (the kc files gained no ircd includes).

- [ ] **Step 5: Commit** — `kc: ask the password grant for an ID token and read its "sub" (the Keycloak user id)`.

### Task 5 (B3): Fields — where the id lives on the ircd

**Files:**
- Modify: `include/struct.h:93-94` (`struct User`), `include/client.h:568-569` and `777-779` (SASL staging + accessor), `include/sasl_auth.h:78` (`struct SASLSession`), `ircd/sasl_auth.c:286-293` (`struct poscache_entry`)
- Modify: `ircd/s_auth.c:460-467` (`auth_complete_sasl`), `ircd/m_account.c:206-207` (`U`), `ircd/sasl_webhook.c:82-83` (`deauth_client`)

**Interfaces (produced):** `cli_user(x)->kc_id[ACCOUNT_ID_LEN + 1]` (empty = unknown); `cli_saslkcid(x)` staging on `struct Client`; `session->kc_id`; `poscache_entry.kc_id`.

- [ ] **Step 1: Add the fields**

`struct.h`, after `acc_create`:
```c
  char               kc_id[ACCOUNT_ID_LEN + 1];  /**< Keycloak user id, compact; "" = unknown */
```
(`struct.h` must `#include "account_id.h"`.)

`client.h`, after `cli_saslacccreate`:
```c
  char cli_saslkcid[ACCOUNT_ID_LEN + 1]; /**< SASL authenticated Keycloak user id, compact; "" = none */
```
and beside the accessors:
```c
/** Get SASL authenticated Keycloak user id (compact). */
#define cli_saslkcid(cli)       ((cli)->cli_saslkcid)
```

`sasl_auth.h`, after `acc_created_at`:
```c
  /* Keycloak user id of the verified identity, compact ("" = not in hand) */
  char               kc_id[ACCOUNT_ID_LEN + 1];
```

`sasl_auth.c` `struct poscache_entry`, after `created_at`:
```c
  char                  kc_id[ACCOUNT_ID_LEN + 1]; /**< Keycloak user id, compact; "" = unknown */
```

- [ ] **Step 2: Hand off at registration and clear on removal**

`s_auth.c` `auth_complete_sasl`, inside the `if`, before `SetAccount`:
```c
    ircd_strncpy(cli_user(client)->kc_id, cli_saslkcid(client), sizeof(cli_user(client)->kc_id));
```
`m_account.c` `U` branch, right after `ircd_strncpy(cli_user(acptr)->account, "", ACCOUNTLEN + 1);`:
```c
        cli_user(acptr)->acc_create = 0;      /* the removed account's, not the next one's */
        cli_user(acptr)->kc_id[0] = '\0';
```
`sasl_webhook.c` `deauth_client`, next to where the account name is cleared (82-83): the same two lines.

- [ ] **Step 3: Build** `make -C ircd` — expect clean (fields only). **Commit** — `account: store the Keycloak user id with the account (fields only)`.

### Task 6 (B4): `sasl_complete_login` carries the id; every mechanism supplies it

**Files:**
- Modify: `include/sasl_auth.h:116-117`, `ircd/sasl_auth.c` (`sasl_complete_login` 586-704; `poscache_insert` ~297, `poscache_check` ~329; call sites 759, 899, 957, 1149, 1260, 1725, 1899; SCRAM stash ~1446; ECDSA stash ~1774), `ircd/m_sasl.c:251`

**Interfaces:** `void sasl_complete_login(struct Client *sptr, const char *account, time_t acc_create, const char *kc_id);` — `kc_id` compact or NULL/"" for none.

- [ ] **Step 1: The completion function**

Prototype (header and definition) gains `const char *kc_id`. In the body, after step 4 (`cli_saslacccreate`):
```c
  /* 4b. Keycloak user id: set or cleared on every login, never inherited
   * from a previous one.  An invalid value counts as none. */
  ircd_strncpy(cli_saslkcid(sptr),
               (kc_id && account_id_valid(kc_id)) ? kc_id : "",
               sizeof(cli_saslkcid(sptr)));
```
In step 7, after `if (cli_saslacccreate(sptr)) cli_user(sptr)->acc_create = ...;`:
```c
      ircd_strncpy(cli_user(sptr)->kc_id, cli_saslkcid(sptr), sizeof(cli_user(sptr)->kc_id));
```
and the extended-accounts propagation becomes:
```c
      if (feature_bool(FEAT_EXTENDED_ACCOUNTS)) {
        if (cli_user(sptr)->kc_id[0]) {
          /* Fifth parameter: the Keycloak user id.  The timestamp keeps its
           * place (0 when unknown) so the id is always the fifth. */
          sendcmdto_serv_butone(&me, CMD_ACCOUNT, NULL, "%C %c %s %Tu %s",
                                sptr, type, cli_user(sptr)->account,
                                cli_user(sptr)->acc_create, cli_user(sptr)->kc_id);
        } else if (cli_user(sptr)->acc_create) {
          ... (unchanged)
```
`sasl_auth.c` needs `#include "account_id.h"` (and `kc/kc_jwt.h` if not already).

- [ ] **Step 2: The positive cache**

`poscache_insert(const char *username, const char *account, uint64_t hash, time_t created_at, const char *kc_id)`: store `ircd_strncpy(e->kc_id, kc_id ? kc_id : "", sizeof(e->kc_id));` on both the update and the new-entry paths.
`poscache_check(uint64_t hash, char *account, size_t account_size, time_t *created_at, char *kc_id, size_t kc_id_size)`: on a hit, `if (kc_id) ircd_strncpy(kc_id, e->kc_id, kc_id_size);`.

- [ ] **Step 3: The call sites** — one helper keeps the rule in one place:

```c
/** The id to announce: the verified user's own, and only when the login
 * identity IS the verified user.  An impersonated login (authzid granted
 * by FEAT_SASL_TRUSTED_AUTHZID) carries none: the id in hand belongs to
 * the verifier, not to the account being logged into. */
static const char *sasl_id_for(const char *login_as, const char *verified,
                               const char *verified_id)
{
  return (verified_id && verified_id[0] && 0 == ircd_strcmp(login_as, verified))
         ? verified_id : NULL;
}
```

| Site | Change |
|---|---|
| `sasl_plain_cb` (759) | before the insert: `char kcid[ACCOUNT_ID_LEN + 1] = ""; char sub[64]; if (token && token->id_token && kc_jwt_extract_sub(token->id_token, sub, sizeof(sub))) account_id_from_uuid(sub, kcid);` then `poscache_insert(session->authcid, session->authcid, session->cred_hash, token ? token->created_at : 0, kcid);` and `sasl_complete_login(acptr, login_as, ..., sasl_id_for(login_as, session->authcid, kcid));` |
| cache hit (899) | `char cached_kcid[ACCOUNT_ID_LEN + 1] = "";` passed to `poscache_check(...)`, then `sasl_complete_login(sptr, login_as, cached_created_at, sasl_id_for(login_as, cached_account, cached_kcid));` |
| `sasl_external_cb` (957) | `char kcid[ACCOUNT_ID_LEN + 1] = ""; if (users[0].id) account_id_from_uuid(users[0].id, kcid);` → pass `kcid[0] ? kcid : NULL` (no authzid on this path) |
| OAUTHBEARER introspection (1149) and local JWT (1260) | `char kcid[ACCOUNT_ID_LEN + 1] = ""; if (info->sub) account_id_from_uuid(info->sub, kcid);` → `sasl_id_for(login_as, info->username, kcid)` — compute before `kc_jwt_token_info_free(info)`; `info->sub` is whatever the client's own token carries, and a missing one means no id (Step 4 note) |
| SCRAM creds callback (1446) | after `session->acc_created_at = user->created_at;`: `session->kc_id[0] = '\0'; if (user->id) account_id_from_uuid(user->id, session->kc_id);` |
| `sasl_scram_complete` (1725) | `sasl_id_for(login_as, session->authcid, session->kc_id)` |
| ECDSA key callback (1774) | same stash as SCRAM |
| `sasl_ecdsa_client_response` (1899) | same as SCRAM completion |
| `m_sasl.c:251` (relay through X3) | `sasl_complete_login(acptr, cli_saslaccount(acptr), cli_saslacccreate(acptr), NULL);` — the wire from X3 carries no id |

- [ ] **Step 4: Build** `make -C ircd` — expect clean; run `./ircd/test/account_id_cmocka` and `kc_jwt_cmocka` again. **Commit** — `sasl: announce the Keycloak user id with the account` with a body noting: PLAIN reads it from the ID token's `sub` (Task B2 makes the password grant ask for `scope=openid`); EXTERNAL, SCRAM and ECDSA take it from the user record those mechanisms already fetch; OAUTHBEARER carries one only when the client's own bearer token has `sub` (a token minted without the `basic` scope has none, so that login carries no id — the userinfo endpoint is the non-admin source if that ever matters, and it is not part of step 5); an impersonated login carries none (D3); a same-name re-authentication sends no `AC` (unchanged early return), so a changed id on an unchanged name reaches other servers only at the next burst.

### Task 7 (B5): The wire — `AC` fifth parameter and `+r account:ts:id`

**Files:**
- Modify: `ircd/m_account.c:289-326` (`R`/`M` parse + relay), `ircd/s_user.c:2771-2779` (`umode_str`), `ircd/s_user.c:2592-2604` (`set_user_mode`)

- [ ] **Step 1: Parse and relay in `ms_account`** — replace the `if (parc > 4) { acc_create = atoi(parv[4]); ... }` block and the relay:

```c
        if (parc > 4) {
          cli_user(acptr)->acc_create = atoi(parv[4]);
          Debug((DEBUG_DEBUG, "Received timestamped account: account \"%s\", "
                 "timestamp %Tu", parv[3], cli_user(acptr)->acc_create));
        } else
          cli_user(acptr)->acc_create = 0;

        /* Fifth parameter: the Keycloak user id, compact.  Anything else
         * in that slot -- RENAME's marker, a value an older hop cut
         * short -- is not an id and leaves it unknown. */
        if (parc > 5 && account_id_valid(parv[5]))
          ircd_strncpy(cli_user(acptr)->kc_id, parv[5], sizeof(cli_user(acptr)->kc_id));
        else
          cli_user(acptr)->kc_id[0] = '\0';
```
relay:
```c
        if (cli_user(acptr)->kc_id[0])
          sendcmdto_serv_butone(sptr, CMD_ACCOUNT, cptr, "%C %c %s %Tu %s",
                                acptr, type, parv[3], cli_user(acptr)->acc_create,
                                cli_user(acptr)->kc_id);
        else if (parc > 4)
          sendcmdto_serv_butone(sptr, CMD_ACCOUNT, cptr, "%C %c %s %s",
                                acptr, type, parv[3], parv[4]);
        else
          sendcmdto_serv_butone(sptr, CMD_ACCOUNT, cptr, "%C %c %s",
                                acptr, type, parv[3]);
```
(`m_account.c` includes `account_id.h`.)

- [ ] **Step 2: Emit in `umode_str`** — replace the `if (cli_user(cptr)->acc_create) { ... }` block:

```c
    if (cli_user(cptr)->acc_create || cli_user(cptr)->kc_id[0]) {
      char nbuf[24 + ACCOUNT_ID_LEN];
      /* ":ts" as before; with an id, ":ts:id" -- ts is 0 when unknown so
       * the id is always the third field. */
      if (cli_user(cptr)->kc_id[0])
        ircd_snprintf(0, t = nbuf, sizeof(nbuf), ":%Tu:%s",
                      cli_user(cptr)->acc_create, cli_user(cptr)->kc_id);
      else
        ircd_snprintf(0, t = nbuf, sizeof(nbuf), ":%Tu", cli_user(cptr)->acc_create);
      while ((*m++ = *t++))
        ; /* Empty loop */
      m--; /* back up over nul-termination */
    }
```

- [ ] **Step 3: Parse in `set_user_mode`** — inside `if ((ts = strchr(account, ':'))) { ... }`, after `cli_user(acptr)->acc_create = atoi(ts);`:

```c
        {
          const char *id = strchr(ts, ':');
          if (id && account_id_valid(id + 1))
            ircd_strncpy(cli_user(acptr)->kc_id, id + 1, sizeof(cli_user(acptr)->kc_id));
          else
            cli_user(acptr)->kc_id[0] = '\0';
        }
```
and in the `else` (no colon at all) set `cli_user(acptr)->kc_id[0] = '\0';` — the `+r` arrived without one.

- [ ] **Step 4: Build; wire check on the host is not possible — B7 covers it. Commit** — `account: carry the Keycloak user id on AC and in the burst +r`.

### Task 8 (B6): Bouncer aliases inherit the primary's id

**Files:** `ircd/bouncer_session.c:7554-7555`, `8050-8051`, `8108-8109`

- [ ] **Step 1:** after each `user->acc_create = cli_user(primary)->acc_create;`:
```c
  ircd_strncpy(user->kc_id, cli_user(primary)->kc_id, sizeof(user->kc_id));
```
A restored ghost (`bounce_create_ghost`, 2976-2979) sets no id — records do not carry one until step 5c — so its burst `+r` is the two-field form.

- [ ] **Step 2: Build. Commit** — `bouncer: aliases carry the primary's Keycloak user id`.

### Task 9 (B7): Bed test — the id is on the wire

**Files:**
- Create: `tests/src/ircv3/account-id-wire.test.ts` (gated `WIRE_KC_ID=1`)

- [ ] **Step 1: Deploy** — in the bed checkout: `git switch bed-deploy && git reset --hard 4de99fa && git merge --no-ff fix/retire-rebind-acc-ts-gate fix/wire-keycloak-id`, then `cd .. && scripts/dc.sh -l build nefarious nefarious2 && scripts/dc.sh -l up -d --no-deps nefarious nefarious2`; confirm both `readlink -f /home/nefarious/bin/ircd` advanced; wait for X3 to relink.

- [ ] **Step 2: Write the test**

```typescript
/**
 * The Keycloak user id rides the wire with the account (design F, 5a).
 *
 * After a SASL PLAIN login, X3's stdout shows the user's introduction from
 * the ircd with +r account:ts:id, where id is 22 base64url characters; a
 * later re-authentication shows AC ... M account ts id.  nefarious2 shows
 * the same introduction, rebuilt by the hop from its own copy.
 *
 * GATED behind WIRE_KC_ID=1: needs nefarious from fix/wire-keycloak-id on
 * both servers.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { run } from '../helpers/bed-control';
import { createRawSocketClient } from '../helpers/index.js';
import { authenticateSaslPlain } from '../helpers/sasl';
import { getKeycloakAdminToken } from '../helpers/keycloak-sync';

const GATED = process.env.WIRE_KC_ID !== '1';
const KC = process.env.KEYCLOAK_URL || 'http://localhost:8080';
const REALM = 'testnet';
const tag = Math.random().toString(36).slice(2, 7);
const A = `testwid${tag}a`, B = `testwid${tag}b`, PASSWORD = 'Wire!2026';
const ID = '[A-Za-z0-9_-]{22}';
let token = '';
let idA = '';

async function kc(p: string, init: RequestInit = {}) {
  return fetch(`${KC}/admin/realms/${REALM}${p}`, { ...init,
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json', ...(init.headers || {}) } });
}
async function kcCreateUser(username: string): Promise<string> {
  const res = await kc('/users', { method: 'POST', body: JSON.stringify({
    username, enabled: true, emailVerified: true, email: `${username}@example.com`,
    credentials: [{ type: 'password', value: PASSWORD, temporary: false }] }) });
  if (!res.ok && res.status !== 409) throw new Error(`create ${username}: ${res.status}`);
  return (await (await kc(`/users?username=${username}&exact=true`)).json())[0].id;
}
async function kcDeleteUser(username: string) {
  const id = (await (await kc(`/users?username=${username}&exact=true`)).json())[0]?.id;
  if (id) await kc(`/users/${id}`, { method: 'DELETE' });
}
/** Compact form of a canonical UUID, as the ircd encodes it. */
function compact(uuid: string): string {
  return Buffer.from(uuid.replace(/-/g, ''), 'hex').toString('base64url');
}
function logs(container: string): string {
  return run('docker', ['logs', '--since', '3m', container]);
}

describe('Keycloak user id on the wire', () => {
  beforeAll(async () => {
    if (GATED) return;
    token = await getKeycloakAdminToken();
    idA = await kcCreateUser(A);
    await kcCreateUser(B);
  }, 60_000);
  afterAll(async () => { if (GATED) return; await kcDeleteUser(A); await kcDeleteUser(B); });

  it.skipIf(GATED)('introduction carries +r account:ts:id, and it is the Keycloak id', async () => {
    const nick = `wid${tag}n`;
    const c = await createRawSocketClient();
    await c.capLs(); await c.capReq(['sasl']);
    const r = await authenticateSaslPlain(c, A, PASSWORD);
    expect(r.success, r.error).toBe(true);
    c.capEnd(); c.register(nick);
    await c.waitForNumeric('001', 15000);
    await new Promise((res) => setTimeout(res, 2000));

    const intro = new RegExp(` N ${nick} \\d+ \\d+ \\S+ \\S+ \\+\\S*r\\S* ${A}:\\d+:(${ID})`);
    const seenByX3 = intro.exec(logs('x3'));
    expect(seenByX3, 'X3 saw the introduction with a third field').not.toBeNull();
    expect(seenByX3![1]).toBe(compact(idA));
    expect(intro.exec(logs('nefarious2')), 'nefarious2 saw it too (rebuilt by the hop)').not.toBeNull();
    c.close();
  }, 60_000);

  it.skipIf(GATED)('a re-authentication announces AC M with the new id', async () => {
    const nick = `wid${tag}m`;
    const c = await createRawSocketClient();
    await c.capLs(); await c.capReq(['sasl']);
    expect((await authenticateSaslPlain(c, A, PASSWORD)).success).toBe(true);
    c.capEnd(); c.register(nick);
    await c.waitForNumeric('001', 15000);
    expect((await authenticateSaslPlain(c, B, PASSWORD)).success).toBe(true);
    await new Promise((res) => setTimeout(res, 2000));

    const ac = new RegExp(` AC \\S+ M ${B} \\d+ (${ID})`);
    expect(ac.exec(logs('x3')), 'X3 saw AC M with an id').not.toBeNull();
    expect(ac.exec(logs('nefarious2')), 'nefarious2 saw AC M with an id').not.toBeNull();
    c.close();
  }, 60_000);
});
```
If the first case finds an introduction with only `account:ts`, check the grant first: the request must carry `scope=openid` and the reply must include `id_token` (Review Focus 1) before suspecting the codec or the wire.

- [ ] **Step 3: Run** `WIRE_KC_ID=1 IRC_HOST=localhost npm test -- src/ircv3/account-id-wire.test.ts` — expect 2 passed; also re-run `src/keycloak/keycloak.test.ts` (expect the known 23/2) and `src/ircv3/bouncer-holding-state.test.ts`.

- [ ] **Step 4: Commit the test** (testnet) and push the nefarious branch per the Global Constraints (four `git push` commands, one per remote/branch), then rebuild `bed-deploy` from the pushed tip.

---

# Part C — x3: bind the handle to the id (5b)

**Branch:** developed on `feature/keycloak-id-binding` off `feature/local-handle-flag` (`77bd045`) — it reuses step 4's refusal helpers, which live in the same file. Per `feedback_no_stacked_prs_upstream`, its **PR is opened only after step 4 merges to master**, then rebased onto master; until then it is a bed-only branch. Part A's `AC M` fix must also be present for the bed (merge it into the integration checkout).

**Index note:** step 7 (dispose-by-identity) will index handles by id; step 5 stores the id and reads it per-login only. Do not add the dict here (YAGNI until step 7).

### Task 10 (C1): The field, persisted

**Files:** `x3/src/nickserv.h:100-127` (`handle_info`), `x3/src/nickserv.c` — `KEY_*` (~101), `free_handle_info` (560), saxdb write (~4221), saxdb read (~4954)

**Interfaces (produced):** `hi->kc_id` (`char *`, NULL = unknown); saxdb key `"kc_id"`.

- [ ] **Step 1: Field + key.** `nickserv.h`, after `char *fakehost;`:
```c
    char *kc_id;    /* Keycloak user id (compact base64url); NULL = unknown */
```
`nickserv.c`, by `#define KEY_FAKEHOST`:
```c
#define KEY_KC_ID "kc_id"
```

- [ ] **Step 2: Free, write, read.**
`free_handle_info`, after `free(hi->fakehost);`:
```c
    free(hi->kc_id);
```
saxdb write, after the `KEY_INFO` line:
```c
        if (hi->kc_id)
            saxdb_write_string(ctx, KEY_KC_ID, hi->kc_id);
```
saxdb read, after the `KEY_INFO` block:
```c
    str = database_get_data(obj, KEY_KC_ID, RECDB_QSTRING);
    if (str)
        hi->kc_id = strdup(str);
```

- [ ] **Step 3: Build + a smoke check.** `cd /home/ibutsu/testnet && scripts/dc.sh build x3` — expect clean. This task has no behaviour yet; it is verified by C3's persistence test. **Commit** — `nickserv: store a handle's Keycloak user id in saxdb (field only)`.

### Task 11 (C2): `handle_account` — adopt on first use, refuse a mismatch

**Files:** `x3/src/nickserv.c` — the message table (~232, by `NSMSG_LOCAL_ACCOUNT_KILL`), the step-4 helpers (5580-5634), `handle_account` (5637-5655)

**Interfaces:** reuses `struct local_claim` and `nickserv_kill_local_claim` (generalised to carry a reason); adds `nickserv_bind_identity(user, hi, wire_id)`.

- [ ] **Step 1: Write the failing bed test** `tests/src/services/keycloak-id-binding.test.ts` (gated `KC_ID_BIND=1`). It needs Part B on the ircd and Part C on X3.

```typescript
/**
 * A handle is bound to its Keycloak user id on first login, and a later
 * login as a DIFFERENT Keycloak user with the same name is refused
 * (design F, 5b).  Deleting a name in Keycloak and recreating it makes a
 * new user id: that is the case this catches.
 *
 * GATED behind KC_ID_BIND=1.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { run, flushX3Saxdb } from '../helpers/bed-control';
import { createRawSocketClient, RawSocketClient } from '../helpers/index.js';
import { authenticateSaslPlain } from '../helpers/sasl';
import { NICKSERV_NICK } from '../helpers/x3-client';
import { getKeycloakAdminToken } from '../helpers/keycloak-sync';

const GATED = process.env.KC_ID_BIND !== '1';
const KC = process.env.KEYCLOAK_URL || 'http://localhost:8080';
const REALM = 'testnet';
const tag = Math.random().toString(36).slice(2, 7);
const NAME = `testkid${tag}`, PASSWORD = 'Ident!2026';
let token = '';

async function kc(p: string, init: RequestInit = {}) {
  return fetch(`${KC}/admin/realms/${REALM}${p}`, { ...init,
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json', ...(init.headers || {}) } });
}
async function kcCreate(): Promise<string> {
  const res = await kc('/users', { method: 'POST', body: JSON.stringify({
    username: NAME, enabled: true, emailVerified: true, email: `${NAME}@example.com`,
    credentials: [{ type: 'password', value: PASSWORD, temporary: false }] }) });
  if (!res.ok && res.status !== 409) throw new Error(`create: ${res.status}`);
  return (await (await kc(`/users?username=${NAME}&exact=true`)).json())[0].id;
}
async function kcDelete() {
  const id = (await (await kc(`/users?username=${NAME}&exact=true`)).json())[0]?.id;
  if (id) await kc(`/users/${id}`, { method: 'DELETE' });
}
async function login(nick: string): Promise<{ c: RawSocketClient; ok: boolean; killed: boolean }> {
  const c = await createRawSocketClient();
  await c.capLs(); await c.capReq(['sasl']);
  const r = await authenticateSaslPlain(c, NAME, PASSWORD);
  c.capEnd(); c.register(nick);
  const killed = await c.waitForLine(/ KILL \S+ :|ERROR :Closing Link/, 12000).then(() => true, () => false);
  if (!killed) await c.waitForNumeric('001', 12000).catch(() => {});
  return { c, ok: r.success, killed };
}
async function boundAccount(c: RawSocketClient): Promise<string> {
  c.clearRawBuffer();
  c.send(`PRIVMSG ${NICKSERV_NICK} :ACCOUNTINFO`);
  const line = await c.waitForLine(/Account Information for|must be authenticated/, 8000).catch(() => '');
  return /Account Information for \x02?([^\x02\s]+)/.exec(line)?.[1] ?? '';
}

describe('a handle binds to its Keycloak user id', () => {
  beforeAll(async () => { if (GATED) return; token = await getKeycloakAdminToken(); await kcCreate(); }, 60_000);
  afterAll(async () => { if (GATED) return; await kcDelete(); });

  it.skipIf(GATED)('adopts the id on first login and keeps the same id across logins', async () => {
    const first = await login(`kid${tag}a`);
    expect(first.ok && !first.killed, 'first login bound').toBe(true);
    expect(await boundAccount(first.c)).toBe(NAME);
    first.c.close();

    const again = await login(`kid${tag}b`);          // same Keycloak user, same id
    expect(again.killed, 'the rightful owner is not killed').toBe(false);
    expect(await boundAccount(again.c)).toBe(NAME);
    again.c.close();
  }, 90_000);

  it.skipIf(GATED)('refuses a different Keycloak user who took the name back', async () => {
    // The binding from the first test is on disk; persist it, then recreate
    // the Keycloak user so the name resolves to a new id.
    await flushX3Saxdb(NAME);
    await kcDelete();
    await kcCreate();                                  // new user id for the same name

    const impostor = await login(`kid${tag}c`);
    expect(impostor.killed, 'the new-id login is refused and disconnected').toBe(true);
    impostor.c.close();
  }, 120_000);
});
```

- [ ] **Step 2: Run — expect the second case red** (first passes even without C: no stored id yet, so nothing to mismatch). `KC_ID_BIND=1 IRC_HOST=localhost npm test -- src/services/keycloak-id-binding.test.ts`.

- [ ] **Step 3: Message + generalise the kill helper.** Message table, after `NSMSG_LOCAL_ACCOUNT_KILL`:
```c
    { "NSMSG_IDENTITY_KILL", "Account unavailable." },
```
`struct local_claim` gains a reason, and the kill helper uses it:
```c
struct local_claim {
    char numeric[COMBO_NUMERIC_LEN+1];
    char handle[NICKSERV_HANDLE_LEN+1];
    const char *reason;   /* a message-table key (static literal) */
};
```
In `nickserv_kill_local_claim`, replace the `DelUser(... "NSMSG_LOCAL_ACCOUNT_KILL")` with `user_find_message(user, claim->reason)`, and in `nickserv_refuse_local` set `claim->reason = "NSMSG_LOCAL_ACCOUNT_KILL";` before `timeq_add`.

- [ ] **Step 4: The identity check.** Add, after `nickserv_refuse_local`:
```c
/* Bind a handle to the Keycloak user id the ircd announced, or refuse.
 * wire_id is the compact id or NULL (no id on the wire -> nothing to do,
 * per the fail-open rule).  Returns non-zero when the announcement must be
 * refused: a stored id that differs is a DIFFERENT Keycloak user with this
 * name, so -- like a LOCAL handle -- refuse, and outside a burst kill the
 * claimant (X3 cannot take back an account the ircd already set). */
static int
nickserv_bind_identity(struct userNode *user, struct handle_info *hi,
                       const char *wire_id)
{
    struct local_claim *claim;

    if (!wire_id || !*wire_id)
        return 0;                               /* fail open: no id to check */

    if (!hi->kc_id) {
        hi->kc_id = strdup(wire_id);            /* first use: adopt */
        return 0;
    }
    if (!strcmp(hi->kc_id, wire_id))
        return 0;                               /* same user */

    if (user->uplink->burst) {
        log_module(NS_LOG, LOG_ERROR, "%s announced account %s with a "
                   "different Keycloak id during a burst: refused",
                   user->nick, hi->handle);
        return 1;
    }
    log_module(NS_LOG, LOG_ERROR, "%s announced account %s with a different "
               "Keycloak id: refused, killing", user->nick, hi->handle);
    if (!(claim = calloc(1, sizeof(*claim))))
        return 1;
    safestrncpy(claim->numeric, user->numeric, sizeof(claim->numeric));
    safestrncpy(claim->handle, hi->handle, sizeof(claim->handle));
    claim->reason = "NSMSG_IDENTITY_KILL";
    timeq_add(now, nickserv_kill_local_claim, claim);
    return 1;
}
```

- [ ] **Step 5: Parse the id in `handle_account` and call the check.** Replace the stamp-split head (5645-5655) with:
```c
    time_t timestamp = 0;
    char wire_id[23] = "";            /* compact Keycloak id, "" = none */
    char *colon2;

    colon = strchr(stamp, ':');
    if(colon && colon[1])
    {
        /* Second colon, if any, begins the Keycloak id: account:ts:id */
        colon2 = strchr(colon + 1, ':');
        if (colon2 && colon2[1] && strlen(colon2 + 1) == 22)
            safestrncpy(wire_id, colon2 + 1, sizeof(wire_id));
        *colon = 0;
        timestamp = strtol(colon+1, NULL, 10);
    }
    hi = dict_find(nickserv_handle_dict, stamp, NULL);
    /* Before the timestamp reconciliation, which would otherwise rewrite a
     * LOCAL handle's registration time from the claimant's directory entry */
    if (hi && nickserv_refuse_local(user, hi))
        return;
    /* Then the identity: a stored id that differs is a different Keycloak
     * user with this name. */
    if (hi && nickserv_bind_identity(user, hi, wire_id))
        return;
```

- [ ] **Step 6: Build, deploy, run — expect both cases green.** Rebuild x3, deploy, wait for relink, re-run the C2 test. Also re-run step 4's `X3_LOCAL_FLAG=1 ... local-handle-flag.test.ts` — the shared helper change must not regress it. **Commit** — `nickserv: bind a handle to its Keycloak user id; refuse a different one`, body noting: adopt on first use, mismatch refused (killed outside a burst, D2), no id on the wire is left alone (fail open).

### Task 12 (C3): `REBIND` — re-bind or clear a handle's id

**Files:** `x3/src/nickserv.c` (a new `cmd_rebind`, its registration ~6260, messages), `x3/src/nickserv.help` (a `REBIND` entry near `RENAME`)

- [ ] **Step 1: Write the failing bed test** — append to `keycloak-id-binding.test.ts`:
```typescript
  it.skipIf(GATED)('an oper REBIND lets the rightful owner back in', async () => {
    // Continues from the refused state: clear the binding, then the current
    // Keycloak user logs in and re-adopts.
    const op = await import('../helpers/x3-client').then(m => m.createOperClient());
    await op.serviceCmd('O3', 'GOD ON');
    const reply = await op.serviceCmd(NICKSERV_NICK, `REBIND *${NAME} *`);
    op.close();
    expect(reply.join('\n')).toMatch(/binding cleared|Keycloak id/i);

    const owner = await login(`kid${tag}d`);
    expect(owner.killed, 'after REBIND the current user is accepted').toBe(false);
    expect(await boundAccount(owner.c)).toBe(NAME);
    owner.c.close();
  }, 90_000);
```

- [ ] **Step 2: Run — expect red** (REBIND unknown: "command not found").

- [ ] **Step 3: Implement.** A small UUID→compact encoder (X3 has no base64url helper), then the command:
```c
/* 16 bytes -> 22 unpadded base64url chars.  Mirrors nefarious account_id. */
static const char kcid_b64[] =
    "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_";
static int
handle_kcid_from_uuid(const char *uuid, char out[23])
{
    unsigned char raw[16];
    int digits = 0, hi = -1, i, o = 0;
    const char *p;
    if (!uuid) return 0;
    for (p = uuid; *p; p++) {
        int v;
        if (*p == '-') continue;
        if (*p >= '0' && *p <= '9') v = *p - '0';
        else if (*p >= 'a' && *p <= 'f') v = *p - 'a' + 10;
        else if (*p >= 'A' && *p <= 'F') v = *p - 'A' + 10;
        else return 0;
        if (digits == 32) return 0;
        if (hi < 0) hi = v; else { raw[digits/2] = (hi << 4) | v; hi = -1; }
        digits++;
    }
    if (digits != 32) return 0;
    for (i = 0; i < 16; i += 3) {                 /* last group is 16%3==1 byte */
        unsigned int n = raw[i] << 16;
        int bytes = 1;
        if (i + 1 < 16) { n |= raw[i+1] << 8; bytes = 2; }
        if (i + 2 < 16) { n |= raw[i+2];      bytes = 3; }
        out[o++] = kcid_b64[(n >> 18) & 63];
        out[o++] = kcid_b64[(n >> 12) & 63];
        if (bytes > 1) out[o++] = kcid_b64[(n >> 6) & 63];
        if (bytes > 2) out[o++] = kcid_b64[n & 63];
    }
    out[o] = 0;
    return o == 22;
}

static NICKSERV_FUNC(cmd_rebind)
{
    struct handle_info *hi;
    char compact[23];

    NICKSERV_MIN_PARMS(3);
    if (!(hi = get_victim_oper(user, argv[1])))
        return 0;
    if (!strcmp(argv[2], "*")) {
        free(hi->kc_id);
        hi->kc_id = NULL;
        reply("NSMSG_REBIND_CLEARED", hi->handle);
        return 1;
    }
    if (!handle_kcid_from_uuid(argv[2], compact)) {
        reply("NSMSG_REBIND_BADID");
        return 0;
    }
    free(hi->kc_id);
    hi->kc_id = strdup(compact);
    reply("NSMSG_REBIND_SET", hi->handle);
    return 1;
}
```
Messages (table):
```c
    { "NSMSG_REBIND_CLEARED", "Keycloak id binding cleared for account %s; the next login will adopt one." },
    { "NSMSG_REBIND_SET", "Keycloak id set for account %s." },
    { "NSMSG_REBIND_BADID", "Give the account's Keycloak ID -- the UUID from the admin console (e.g. 6ba7b810-9dad-11d1-80b4-00c04fd430c8), or * to clear." },
```
Registration, by `RENAME`:
```c
    nickserv_define_func("REBIND", cmd_rebind, 0, 1, 0);
```
(level 0 = oper-only via `+helping`, as `OSET`; `get_victim_oper` enforces outranking — it is not an `OSET` option, so `SEARCH SET` cannot reach it.)

- [ ] **Step 4: `nickserv.help`** near `RENAME`:
```
"REBIND" (
        "/msg $N REBIND <*account> <keycloak-id|*>",
        "Sets or clears the Keycloak user id an account is bound to. Use the UUID from the Keycloak admin console, or * to clear the binding so the next login adopts one. For recovering an account whose Keycloak user was legitimately recreated.",
        "$uSee Also:$u accountinfo"
);
```

- [ ] **Step 5: Build, deploy, run — expect green** (all three C cases). **Commit** — `nickserv: REBIND to re-bind or clear a handle's Keycloak id`.

### Task 13 (C4): Show the id in ACCOUNTINFO

**Files:** `x3/src/nickserv.c` — `cmd_handleinfo` oper block (after the FLAGS reply, ~1814), message table

- [ ] **Step 1: Add the test** — append to `keycloak-id-binding.test.ts`, inside the adopt test after the first `boundAccount`:
```typescript
    // an oper sees the bound id
    const op = await import('../helpers/x3-client').then(m => m.createOperClient());
    await op.serviceCmd('O3', 'GOD ON');
    const info = await op.serviceCmd(NICKSERV_NICK, `ACCOUNTINFO *${NAME}`);
    op.close();
    expect(info.join('\n'), 'oper ACCOUNTINFO shows a Keycloak id').toMatch(/Keycloak ID:\s*[A-Za-z0-9_-]{22}/);
```

- [ ] **Step 2: Run — expect red** (no such line).

- [ ] **Step 3: Implement.** Message table:
```c
    { "NSMSG_HANDLEINFO_KC_ID", "Keycloak ID: %s" },
```
In `cmd_handleinfo`, in the oper-gated region (after the FLAGS block, before OPSERV_LEVEL):
```c
    if (hi->kc_id)
        reply("NSMSG_HANDLEINFO_KC_ID", hi->kc_id);
```

- [ ] **Step 4: Build, deploy, run the full C suite green.** **Commit** — `nickserv: ACCOUNTINFO shows an account's Keycloak id to opers`.

---

## Self-review

**Spec coverage (design F "Step 5 scope"):** 5-pre `AC M`/`AC U` → Part A. 5a: id source (PLAIN: the ID token's `sub`; EXTERNAL/SCRAM/ECDSA: the user record they already fetch; OAUTHBEARER: the client's own token, none without `sub`) → B2, B4; fail-open paths → B4 (helper + `sasl_id_for`); `struct User.kc_id`, cleared on U/M → B3; wire `AC` + `+r` + relay → B5; bouncer alias copy → B6; not-in-5a crdt gateway → noted in B intro. 5b: `handle_info.kc_id` + saxdb (not the dead `"id"`) → C1; adopt/refuse (LOCAL rule) → C2; `REBIND` not an OSET option → C3; ACCOUNTINFO → C4. Rulings: D1 compact → B1; D2 refuse+kill/burst → C2; D3 impersonation carries none → B4 `sasl_id_for`; D4 ircd-side gap is 5c → out of scope, stated.

**Placeholders:** none — every step has the code or the exact command.

**Type consistency:** `account_id_from_uuid`/`account_id_valid`/`ACCOUNT_ID_LEN` (B1) used verbatim in B3/B4/B5; `kc_jwt_extract_sub(token, out, size)` (B2) used in B4; `sasl_complete_login(..., kc_id)` (B4) matches all nine call sites incl. `m_sasl.c`; `cli_saslkcid`/`cli_user(x)->kc_id`/`session->kc_id`/`poscache_entry.kc_id` consistent B3↔B4; X3 `hi->kc_id`, `KEY_KC_ID`, `nickserv_bind_identity`, `struct local_claim.reason`, `NSMSG_IDENTITY_KILL`/`NSMSG_REBIND_*`/`NSMSG_HANDLEINFO_KC_ID` consistent C1–C4.

**Review Focus:** (1) no `id_token`/`sub` → B2 test + B7 note; (2) bad-shape id → B1 `account_id_valid` cases + C2 22-char guard; (3) `RENAME` slot → B5 `account_id_valid` gate ("RENAME" never validates); (4) same-name re-auth → B4 commit note; (5) id-less restored ghost → B6 note + B5's two-field fallback. All five owned.

**Known limits (carried, not fixed here):** a changed id on an unchanged name travels only at the next burst (5a); legacy/crdt hops strip the id → those users fail open (5a); ircd keeps its own account-keyed state by name → step 5c (D4).
