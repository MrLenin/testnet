# Retire the X3 Timestamp Delete-Detector — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Stop X3 silently overwriting account registration dates, and stop it refusing
handle binds, by replacing the timestamp reconciliation in `handle_account()` with
detect-and-log.

**Architecture:** X3's account timestamp was a delete detector (*wire TS newer than saxdb ⇒
the directory account was recreated ⇒ different principal ⇒ refuse*). The ircd cannot see
saxdb, so the detector began firing on legitimate logins, and a migration bridge made X3
converge onto the directory instead — disabling the control and overwriting the evidence.
This plan removes the disabled detector. Delete detection is rebuilt separately (spec step
5); this change is **escalation-neutral**, because the reconciliation already binds the
reuse case.

**Tech Stack:** C (X3 services, autotools), Docker Compose bed, Vitest integration tests,
Keycloak admin REST, OpenLDAP.

**Spec:** `.claude/para/projects/account-timestamp-authority-2026-09.md` (design B, sequencing step 1)

## Global Constraints

- **Target branch:** `fix/retire-timestamp-detector`, branched from **`upstream/master`**
  (`evilnet/x3` @ `5d7fadb`) — the branch production runs. Not from `master`, not from
  `feature/ldap-identity-binding`.
- **`hi->registered` must never be written outside handle creation.** After this change the
  only assignments are `nickserv_register()` and the saxdb loader.
- **No `return;` may remain** inside the `if(hi && timestamp && hi->registered != timestamp)`
  block. Every early return there is a silent handle-bind refusal.
- **Do not touch** `ldap_get_user_create_time()` itself, nor its callers at
  `nickserv.c:1188` (registration) or `:5669` (autocreate). Those are initial assignment,
  not backfill, and stay.
- **Never edit a live `x3.db`.** X3 flushes on a timer and at shutdown and will overwrite
  you. Stop the container, edit, start.
- Upstream PR rule: based on `upstream/master`, one subject, never stacked on another PR's
  branch (`feedback_no_stacked_prs_upstream`).

---

## File Structure

| File | Responsibility | Change |
|---|---|---|
| `x3/src/nickserv.c` | `handle_account()` — the AC-arrival auth path | Replace lines `5577-5631` (the reconciliation block) with detect-and-log |
| `tests/src/services/account-timestamp.test.ts` | Integration test for date preservation and bind success | Create |

Only one source file changes. The block being replaced is self-contained: it sits between
`hi = dict_find(nickserv_handle_dict, stamp, NULL);` and the `#else` of the enclosing
`#ifdef WITH_PROTOCOL_P10`.

---

### Task 1: Retire the reconciliation

**Files:**
- Modify: `x3/src/nickserv.c:5577-5631`
- Test: `tests/src/services/account-timestamp.test.ts` (create)

**Interfaces:**
- Consumes: nothing from earlier tasks — this is the first.
- Produces: `handle_account()` that binds unconditionally on timestamp difference and never
  mutates `hi->registered`. Task 2 depends on that behaviour being in the built image.

- [ ] **Step 1: Branch from the production base**

```bash
cd /home/ibutsu/testnet/x3
git fetch upstream
git checkout -b fix/retire-timestamp-detector upstream/master
git log -1 --oneline    # expect 5d7fadb
```

- [ ] **Step 2: Write the failing test**

Create `tests/src/services/account-timestamp.test.ts`:

```typescript
/**
 * The account registration date must survive authentication.
 *
 * X3 used to treat a wire/saxdb timestamp difference as a signal that the
 * directory account had been recreated, and "reconciled" by overwriting its own
 * record with the directory's value. That destroyed the registration date of
 * every account whose directory entry had ever been recreated -- and refused the
 * handle bind outright when the wire and the directory disagreed.
 *
 * The divergence is created here the way production acquired it: saxdb holds an
 * older date than the directory does. We edit saxdb directly rather than
 * recreating the directory entry, because that is the dormant-account case --
 * same principal, stale local record -- and not name reuse.
 */
import { describe, it, expect, beforeAll } from 'vitest';
import { execSync } from 'node:child_process';
import { createX3Client, NICKSERV_NICK } from '../helpers/x3-client';

const ACCOUNT = `tsdrift${Math.random().toString(36).slice(2, 8)}`;
const PASSWORD = 'TsDrift!2026';
/** 2024-01-01T00:00:00Z — comfortably older than any bed directory entry. */
const OLD_REGISTER = 1704067200;

function sh(cmd: string): string {
  return execSync(cmd, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
}

/** Rewrite one handle's "register" value in saxdb, with X3 stopped. */
function backdateRegister(handle: string, epoch: number): void {
  sh('docker stop x3');                       // flushes saxdb on shutdown
  sh(`docker cp x3:/x3/data/x3.db /tmp/${handle}.db`);
  const fs = require('node:fs') as typeof import('node:fs');
  const db = fs.readFileSync(`/tmp/${handle}.db`, 'utf8');
  const re = new RegExp(`("${handle}" \\{[^}]*?"register" ")(\\d+)(")`);
  expect(db).toMatch(re);                     // fail loudly if the shape changed
  fs.writeFileSync(`/tmp/${handle}.db`, db.replace(re, `$1${epoch}$3`));
  sh(`docker cp /tmp/${handle}.db x3:/x3/data/x3.db`);
  sh('docker start x3');
}

/** "Registered on: Sat Jan 01 00:00:00 2024" -> epoch seconds. */
function parseRegisteredOn(lines: string[]): number {
  const line = lines.find((l) => l.includes('Registered on:'));
  expect(line, `no "Registered on:" in:\n${lines.join('\n')}`).toBeDefined();
  const when = line!.split('Registered on:')[1].trim();
  const t = Date.parse(when);
  expect(Number.isNaN(t), `unparseable date: "${when}"`).toBe(false);
  return Math.floor(t / 1000);
}

describe('account registration date survives authentication', () => {
  beforeAll(async () => {
    const c = await createX3Client();
    // registerAndActivate() handles the e-mail cookie round-trip; plain
    // registerAccount() leaves the handle unactivated and AUTH will refuse it.
    const reg = await c.registerAndActivate(ACCOUNT, PASSWORD, `${ACCOUNT}@example.com`);
    expect(reg.success, `registration failed: ${JSON.stringify(reg)}`).toBe(true);
    c.close();
    backdateRegister(ACCOUNT, OLD_REGISTER);
    await new Promise((r) => setTimeout(r, 8000));   // X3 relinks to the ircd
  }, 90_000);

  it('binds the handle even though saxdb disagrees with the directory', async () => {
    const c = await createX3Client();
    const res = await c.auth(ACCOUNT, PASSWORD);
    expect(res.success, `auth refused: ${JSON.stringify(res)}`).toBe(true);
    c.close();
  }, 30_000);

  it('leaves the registration date untouched', async () => {
    const c = await createX3Client();
    await c.auth(ACCOUNT, PASSWORD);
    // ACCOUNTINFO is an AuthServ command (nickserv_define_func), so it goes to
    // NICKSERV_NICK ('AuthServ') -- not to X3, which is ChanServ on this bed.
    const info = await c.serviceCmd(NICKSERV_NICK, `ACCOUNTINFO ${ACCOUNT}`);
    c.close();
    // The bug overwrote this with the directory's createTimestamp (2026-xx).
    expect(parseRegisteredOn(info)).toBe(OLD_REGISTER);
  }, 30_000);
});
```

- [ ] **Step 3: Sanity-check the helper API (no additions needed)**

The test uses only methods that already exist. Confirm:

```bash
cd /home/ibutsu/testnet
grep -nE "async (registerAndActivate|auth|serviceCmd)\(" tests/src/helpers/x3-client.ts
grep -nE "^\s{2}close\(" tests/src/helpers/ircv3-client.ts
grep -n "NICKSERV_NICK" tests/src/helpers/x3-client.ts
```

Expected: `registerAndActivate` (:286), `auth` (:404), `serviceCmd` (:118), `close()` on the
`RawSocketClient` base in `ircv3-client.ts` (:1471), and
`NICKSERV_NICK = process.env.X3_NICKSERV_NICK || 'AuthServ'` (:37).

There is no `accountInfo()` wrapper and none is needed — `serviceCmd(NICKSERV_NICK, ...)`
is the generic path. Note the bed's service nicks are non-default (ChanServ is `X3`,
OpServ is `O3`), which is why the constant is used rather than a literal
(`project_x3_service_nicks_chanserv_helper_gap`).

- [ ] **Step 4: Build the current code and watch the test fail**

```bash
cd /home/ibutsu/testnet
scripts/dc.sh build x3 && scripts/dc.sh up -d x3
IRC_HOST=localhost npx vitest run tests/src/services/account-timestamp.test.ts
```

Expected: the second test FAILS — `expected 1767225600 to be 1704067200` or similar, because
`handle_account()` overwrote `registered` with the directory's value. The first test may
pass (the "correcting saxdb" branch does bind).

Also confirm the mechanism in the log:

```bash
scripts/dc.sh logs x3 | grep "correcting saxdb"
```

- [ ] **Step 5: Replace the reconciliation with detect-and-log**

In `x3/src/nickserv.c`, replace the whole block at `5577-5631`:

```c
    if(hi && timestamp && hi->registered != timestamp)
    {
        /* The wire timestamp and saxdb no longer have to agree.
         *
         * This comparison was a delete detector: a newer wire timestamp meant
         * the directory account had been destroyed and recreated, so the
         * principal was not the one this handle belongs to.  It stopped working
         * when the ircd took over SASL -- the ircd cannot see saxdb, so it
         * stamps what Keycloak exposes, and the detector began firing on
         * ordinary logins.  The interim fix converged saxdb onto the directory,
         * which disabled the control and destroyed the registration date at the
         * same time.
         *
         * Account identity is now established by delete detection (Keycloak
         * lifecycle events), not by this comparison.  So: record the divergence
         * and carry on.  Never overwrite hi->registered -- it is a registration
         * date, displayed to users, and nothing else compares it.  Never refuse
         * the bind -- refusing leaves the user +r on the ircd but unbound here,
         * authenticated yet silently stripped of all channel access.
         */
        log_module(MAIN_LOG, LOG_INFO,
                   "%s using account %s: wire timestamp %lu differs from saxdb %lu "
                   "(registration date preserved; binding)",
                   user->nick, stamp, (unsigned long)timestamp,
                   (unsigned long)hi->registered);
    }
```

Note what this deletes: three `return;` statements, both `hi->registered = ...` assignments,
and the `#ifdef WITH_LDAP` / `#else` split (both arms now behave identically, so the
conditional compilation has nothing to choose between).

- [ ] **Step 6: Verify the constraints hold**

```bash
cd /home/ibutsu/testnet/x3
grep -n "hi->registered = " src/nickserv.c
```

Before the change `upstream/master` has **6** assignments. Exactly two must disappear —
`:5592` (`= ldap_time`, the overwrite) and `:5610` (`= timestamp`, the LDAP-unavailable
overwrite). **Expect 4 remaining:**

| Line | Site | Keep because |
|---|---|---|
| `:1189` | `nickserv_register()`, LDAP branch | initial assignment at creation |
| `:1192` | `nickserv_register()`, non-LDAP branch | initial assignment at creation |
| `:4941` | saxdb loader | restoring the stored value |
| `:5671` | autocreate | initial assignment for a handle created from an existing entry |

```bash
# No early return left in the divergence block:
sed -n '5577,5600p' src/nickserv.c | grep -n "return;"
# expect no output

# ldap_get_user_create_time drops from 3 call sites to 2:
grep -c "ldap_get_user_create_time(" src/nickserv.c   # expect 2
```

- [ ] **Step 7: Rebuild and verify the test passes**

```bash
cd /home/ibutsu/testnet
scripts/dc.sh build x3 && scripts/dc.sh up -d x3
IRC_HOST=localhost npx vitest run tests/src/services/account-timestamp.test.ts
```

Expected: both tests PASS. The log should now carry the new line:

```bash
scripts/dc.sh logs x3 | grep "registration date preserved"
scripts/dc.sh logs x3 | grep "correcting saxdb"   # expect NO output
```

- [ ] **Step 8: Commit**

```bash
cd /home/ibutsu/testnet/x3
git add src/nickserv.c
git commit -m "nickserv: stop overwriting registration dates and refusing binds on timestamp drift

The wire/saxdb timestamp comparison in handle_account() was a delete detector:
a newer wire timestamp meant the directory account had been recreated, so the
principal was not this handle's owner and the bind had to be refused.

It stopped working when the ircd took over SASL. The ircd cannot see saxdb, so
it stamps what Keycloak exposes, and the detector began firing on ordinary
logins. The interim fix (a52968b) converged saxdb onto the directory -- which
disabled the control and destroyed the registration date in the same motion.
In the exact case the detector existed to catch, it now adopts the new
timestamp and binds anyway.

Removing it is escalation-neutral: the reconciliation already binds the reuse
case. Account identity moves to Keycloak delete detection, tracked separately.

Two failure modes go away. hi->registered is no longer overwritten, so
registration dates stop being destroyed on every auth where the directory entry
was ever recreated. And three early returns go away -- each one left the user
+r on the ircd but unbound in X3: authenticated, yet silently stripped of all
channel access.

Co-Authored-By: Claude Opus 5 (1M context) <noreply\@anthropic.com>"
```

---

### Task 2: Confirm no cross-path regression, then open the PR

**Files:**
- Test: `tests/src/services/authserv.test.ts`, `tests/src/services/opserv.test.ts`,
  `tests/src/services/chanserv.test.ts` (run only — do not modify)

**Interfaces:**
- Consumes: the built image from Task 1.
- Produces: a reviewed branch ready for an `evilnet/x3` PR against `master`.

- [ ] **Step 1: Run the service suites**

```bash
cd /home/ibutsu/testnet
IRC_HOST=localhost npx vitest run tests/src/services/authserv.test.ts
IRC_HOST=localhost npx vitest run tests/src/services/opserv.test.ts
IRC_HOST=localhost npx vitest run tests/src/services/chanserv.test.ts
```

Expected: PASS. These exercise `cmd_auth` and `loc_auth`, which this change does not touch —
a failure here means the edit landed in the wrong function.

Do **not** run the full suite (5+ minutes, drowns the signal).

- [ ] **Step 2: Confirm `ldap-identity-binding.test.ts` is absent, not failing**

```bash
IRC_HOST=localhost npx vitest run tests/src/services/ldap-identity-binding.test.ts
```

Expected: **FAIL**, and that is correct. `upstream/master` has no `ldap_uuid` field —
`4d29d8e` was never merged. This branch is based on production, which does not have the
feature. Record the failure as expected-on-this-base; do not "fix" it, and do not port the
feature here — that is a separate subject and a separate PR.

- [ ] **Step 3: Re-verify against a fresh account**

The Task 1 fixture is backdated. Confirm an ordinary account is unaffected:

```bash
IRC_HOST=localhost npx vitest run tests/src/services/account-timestamp.test.ts
scripts/dc.sh logs x3 --since 5m | grep -c "registration date preserved"
```

A freshly registered account whose saxdb agrees with the directory must produce **no** such
log line — the block only runs on divergence.

- [ ] **Step 4: Commit the test**

```bash
cd /home/ibutsu/testnet
git add tests/src/services/account-timestamp.test.ts
git commit -m "tests: registration date must survive authentication

Covers both failure modes of the timestamp reconciliation: the silent overwrite
of hi->registered, and the bind refusal that left a user +r on the ircd but
unbound in X3.

The divergence is created by backdating saxdb rather than recreating the
directory entry, so the test exercises the dormant-account case -- same
principal, stale local record -- and not name reuse.

Co-Authored-By: Claude Opus 5 (1M context) <noreply\@anthropic.com>"
```

- [ ] **Step 5: Push and hand off**

```bash
cd /home/ibutsu/testnet/x3
git push -u origin fix/retire-timestamp-detector
```

Then **stop**. Do not open the PR. Per `feedback_no_stacked_prs_upstream`, PRs against
`evilnet` are opened by the user, not on their behalf. Report: branch name, the base
(`upstream/master`), the one-subject framing, and that `ldap-identity-binding.test.ts` fails
on this base by design.

---

## Out of scope — tracked, not forgotten

This plan implements **sequencing step 1** of the spec. The spec was restructured on
2026-09-22 (design E) after it emerged that the account timestamp has exactly one consumer
network-wide. Two of the four workstreams originally listed here no longer exist.

| Spec step | Status |
|---|---|
| 2 — retire bouncer rebind gate (c) | Separate plan. Blocked on an operator judgement: whether four months of production constitutes the "confidence in A" (`8cf493c`) that `bouncer-burst-rebind-sessid-gap.md` asked for before removing `acc_ts_match`. |
| 3 — delete detection | Largest piece; blocked on the transport P0-3 fixes and two undecided constants (journal retention, batch limit N). |
| ~~seed `account_created_at`~~ | **Withdrawn.** No consumer to seed for. |
| ~~libkc fallback ladder~~ | **Withdrawn.** Nothing to supply. |
| ~~stamping consistency~~ | **Withdrawn.** Nothing compares the two values, so the inconsistency is harmless. |

**Note on the step-4 design point raised in an earlier draft of this plan.** That draft
flagged that the spec's proposed resolution — "X3 stops stamping and the ircd owns it
outright" — does not exist, because on `cmd_auth` X3 is the only party that knows the
authentication succeeded and must emit `AC` or leave those users without `+r`. That
observation stands, but it no longer needs resolving: with no consumer comparing the
values, it does not matter which value X3 stamps. Recorded here so the reasoning is not
rediscovered and mistaken for live work.

**This plan is unaffected by the restructure.** Step 1 was always independent, needs no
prerequisite, and stops permanent data loss on its own.
