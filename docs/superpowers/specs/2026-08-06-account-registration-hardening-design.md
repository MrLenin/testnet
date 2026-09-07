# Account-registration hardening — design

**Date:** 2026-08-06
**Status:** approved (design); implementation plan pending
**Scope:** Nefarious fork (`m_register.c` + a new throttle module, libkc, `sasl_auth.c`,
`m_cap.c`), `keycloak-webhook-spi` (identity scrub), testnet provisioning
(`scripts/setup-keycloak.sh`, `scripts/keycloak-db-indexes.sql`) + tests.
**Origin:** the five standing items left by
`2026-08-05-account-registration-design.md` after that feature shipped
(`project_account_registration_shipped`). Two are enablement preconditions; three
are hygiene. Facts below were re-verified against the code on 2026-08-06 — three
items changed shape as a result.

## Goal

Make `draft/account-registration` safe to enable on an exposed network. Two
blockers must close (abuse throttling; the legacy-account SCRAM lockout), and
three smaller gaps that the shipping review parked should close with them since
they touch the same files.

## Ground truth (verified 2026-08-06; file:line)

**Rate limiting — nothing reusable exists at the right granularity.**
- `IPcheck` is per-IP but **accept-time only**: `ip_registry_check_local()`
  (`ircd/IPcheck.c:270-319`) implements exactly the shape we want (rolling
  window: reset `attempts` when `CONNECTED_SINCE(last_connect) >
  CLONE_PERIOD`, else `attempts++`, refuse at `CLONE_LIMIT`) but its
  `struct IPRegistryEntry` (`IPcheck.c:49-56`) carries no registration counter
  and its public API (`include/IPcheck.h:19-26`) exposes only connect/disconnect
  hooks plus `IPcheck_nr()`. No per-IP per-command throttle is exposed.
- `check_target_limit()`/`add_target()` (`ircd/s_user.c:1410-1469`, `:1375-1401`)
  are **per-Client** (`cli_targets`/`cli_nexttarget`), not per-IP — useless
  against N fresh connections.
- Best per-command precedent to imitate: the metadata token bucket
  `check_metadata_rate_limit()` (`ircd/m_metadata.c:1303-1329`) — feature-int
  limit, `IsOper` bypass, per-second reset, `send_fail(..., "RATE_LIMITED", ...)`;
  and the AWAY cooldown (`ircd/m_away.c:173-182`, `cli_nextaway`). Both per-Client.
- `cli_ip(cptr)` (`include/client.h:618`, field `:518`) **is populated for
  pre-registration clients** — set at accept in `add_connection()`
  (`ircd/s_bsd.c:816`), before connection registration. So a per-IP key is
  available at the `m_register` point.
- Insertion point: all synchronous validation ends with the
  `sasl_local_available()` gate (`ircd/m_register.c:476-480`); the in-flight
  cookie is armed at `:488-490`, ctx allocated `:492-502`, first async hop
  `kc_user_get` at `:518`.
- `m_register.c:428`'s own comment already states cross-connection limiting is
  unaddressed.

**SCRAM-gate parity — the asymmetry is confirmed, and the fix is small.**
- SCRAM gate: `if (register_verify_email_policy() && !user->email_verified)`
  (`ircd/sasl_auth.c:1372-1383`). Its only signal is the boolean.
- PLAIN's signal is *not* a parsed field: the ROPC grant fails and
  `kc_classify_grant_error()` (`ircd/kc/kc_error_classify.c:25-27`) maps
  "not fully set up" → `KC_UNVERIFIED` (`include/kc/kc_keycloak.h:30`), handled
  at `sasl_auth.c:739-751`. PLAIN therefore keys on *a pending required action*;
  SCRAM keys on *a flag that legacy accounts also have false*. That is the
  lockout.
- `parse_user()` (`ircd/kc/kc_keycloak.c:185-261`) parses `emailVerified` at
  `:199` and **never reads top-level `requiredActions`** (the only occurrences
  are write-side, `:1122-1126`). `struct kc_user`
  (`include/kc/kc_keycloak.h:60-82`) is **all scalars — no array/list field
  precedent**, and `kc_user_free()` (`kc_keycloak.c:1580-1591`) frees pointers
  individually with no loop.
- **Endpoint caveat:** the SCRAM path's `kc_user_get()` uses
  `kc_url_user_by_username(..., exact=1)` (`kc_keycloak.c:1035`) — the
  **search/list** endpoint, not `GET /users/{id}`. Whether that response shape
  carries `requiredActions` must be confirmed at runtime before the gate relies
  on it.

**CAP NEW — the assumed gap is not the real one.** `CAP NEW` already emits
values on both paths: batched `cap_notify_flush()` (`ircd/m_cap.c:172-180`,
`"%s=%s"` when `entry->value[0]`) and immediate `send_cap_notify()`
(`:308-316`). Rehash wraps notify callbacks in
`cap_notify_begin_batch()`/`cap_notify_flush()` (`ircd/ircd_features.c:1721`,
`:1774`). The actual gap: `feature_notify_accountreg_capvalue()`
(`ircd/m_register.c:97-107`) only calls `cap_set_value()` — unlike the
`DEFINE_CAP_NOTIFY` hooks (`ircd_features.c:559-563`) it never calls
`send_cap_notify`, so **a policy flip updates the stored value but may notify
nobody**. Whether the batch picks it up is unverified.

**SPI identity — the coupling is worse than assumed, and there is a real
straggler.**
- **`passwordPolicy` is set NOWHERE in provisioning.** Neither the realm-update
  `PUT` body (`scripts/setup-keycloak.sh:72-95`) nor the create `POST` body
  (`:102-126`) contains the key; a repo-wide grep finds only prose. The
  `x3Scram` policy is attached **manually via the Keycloak UI**, so it is
  invisible to reprovisioning and silently lost on realm recreate.
- Live IDs: `ScramPasswordPolicyProviderFactory.java:31` `PROVIDER_ID =
  "x3Scram"`, `:32` `DISPLAY_NAME = "X3 SCRAM-SHA-256"` (registered:
  `META-INF/services/org.keycloak.policy.PasswordPolicyProviderFactory:1`).
  `ScramCredentialProviderFactory.java:24` `"x3-scram-sha256"` is **compiled but
  NOT registered** (its service file is comments only, `:1-4`).
- **STRAGGLER (real bug):** `scripts/keycloak-db-indexes.sql:29` builds a partial
  index `WHERE name LIKE 'x3_scram_%'` — the attributes are now
  `scram_sha256_*`, so **the index matches nothing** (references also at `:5`,
  `:26-27`, `:80`, `docker-compose.yml:946`).
- Scrub scope: provider-identity strings (above) plus prose/identifier mentions
  in `WebhookEventListenerProviderFactory.java:20,28,35`, `WebhookConfig.java:65,85`,
  `ScramPasswordPolicyProvider.java:28`, `ScramCredentialProvider.java:77,149,158`,
  and `WebhookEventListenerProvider.java` (`X3_RESOURCE_TYPES`/`X3_USER_EVENTS`
  field names + comments). Attribute names are already clean (zero `x3_scram` in
  SPI src).

## Design

### Part 1 — REGISTER rate limiting (the enablement blocker)

Nothing reusable exists, so this is a **new, self-contained module** —
`ircd/register_throttle.c` + `include/register_throttle.h` — deliberately pure
so it gates in CMocka (the project's TDD default) rather than needing bed runs
to validate arithmetic.

Two independent limiters, both consulted before any work is done:

1. **Per-IP rolling window.** Keyed on `cli_ip()` (valid pre-registration).
   Semantics copied from `ip_registry_check_local()` deliberately — operators
   already understand that shape: reset the counter when the window has elapsed
   since the last attempt, otherwise increment and refuse at the limit.
   - `FEAT_REGISTER_THROTTLE_LIMIT` (default **3**) attempts per
   - `FEAT_REGISTER_THROTTLE_PERIOD` seconds (default **3600**).
2. **Server-wide backstop.** One counter, no keying, so a botnet spread across
   many IPs still cannot mint unbounded accounts on this server:
   `FEAT_REGISTER_THROTTLE_GLOBAL` registrations per `PERIOD` (default **60**).
   Zero disables either limiter (so `0` = the pre-change behavior, and the
   default-off CAP keeps everything inert until deliberately enabled).

Interface (the module owns its own state; no `struct Client` fields, no
`IPcheck` surgery):

```c
/* include/register_throttle.h */
enum reg_throttle_result {
  REG_THROTTLE_OK = 0,
  REG_THROTTLE_IP,        /* per-IP window exhausted */
  REG_THROTTLE_GLOBAL     /* server-wide cap reached */
};
/* Test-and-count in one call: on OK the attempt is recorded. */
enum reg_throttle_result reg_throttle_check(const struct irc_in_addr *ip,
                                           time_t now, int limit, int period,
                                           int global_limit);
void reg_throttle_expire(time_t now);   /* aging sweep */
void reg_throttle_clear(void);          /* rehash/test reset */
```

Passing `now`/limits as parameters (rather than reading `CurrentTime` and
`feature_int` inside) is what makes it testable; `m_register` supplies them.

- **Counted attempts = attempts, not successes.** A rejected duplicate name or
  a Keycloak failure still consumes budget; otherwise enumeration is free.
- **Oper bypass**, matching the metadata limiter's `IsOper` exemption. No
  exemption for pre-reg clients — they are the threat.
- **Placement:** immediately after the `sasl_local_available()` gate
  (`m_register.c:480`) and **before** the in-flight cookie is armed (`:488`) —
  so a throttled request neither arms the guard nor allocates/derives. Reply:
  `FAIL REGISTER RATE_LIMITED <account> :<message>` (spec code; mirrors the
  metadata limiter's `RATE_LIMITED` idiom).
- **Storage:** small fixed-size hash of per-IP entries with LRU/expiry eviction
  under a hard cap (memory must not grow with attacker IP count); eviction of a
  live entry is safe — worst case an attacker gets extra budget, never a crash.
  The global counter is two integers (window start + count).
- **Aging is lazy — no timer.** Entries expire on contact: a lookup whose entry
  is older than `PERIOD` is treated as absent and reused, and eviction under the
  cap reclaims the oldest. `reg_throttle_expire()` exists for the CMocka suite
  and any future caller; nothing schedules it. This keeps the module free of
  event-loop coupling (and therefore unit-testable).

### Part 2 — SCRAM-gate parity (kills the legacy-lockout hazard)

Give SCRAM the same signal PLAIN has. Since `struct kc_user` has no array
precedent and only one action matters, add **one scalar**, not a list:

```c
/* include/kc/kc_keycloak.h — struct kc_user */
bool verify_email_pending;   /* requiredActions[] contains "VERIFY_EMAIL" */
```

`parse_user()` gains a top-level `requiredActions` scan next to the
`emailVerified` parse (`kc_keycloak.c:199`): iterate the array if present, set
the bool on an exact `"VERIFY_EMAIL"` match. Absent array ⇒ false. No
allocation, so `kc_user_free()` is untouched.

The SCRAM gate becomes parity with PLAIN:

```c
if (register_verify_email_policy() && user->verify_email_pending) { /* refuse */ }
```

Legacy accounts (no pending action) are unaffected by construction — no
backfill, no flag day. A daemon-born unverified account is refused on both
mechanisms.

**Verification obligation (first implementation step):** confirm the
search-by-username response (`kc_url_user_by_username`, the endpoint SCRAM's
`kc_user_get` actually uses) includes `requiredActions`. If it does **not**,
the fallback — in preference order — is (a) have the SCRAM path use
`kc_user_get_by_id` semantics/`GET /users/{id}` where the field is documented,
or (b) keep the `email_verified` gate but require BOTH signals
(`!email_verified && verify_email_pending`) so absence of the action still
means "don't lock out". Do not ship a gate whose signal was never observed.

`doc/readme.features`' `REGISTER_VERIFY_EMAIL` caveat paragraph gets rewritten
once the parity fix lands — the lockout it warns about will no longer exist.

### Part 3 — SPI identity scrub + the provisioning gap it exposes

Three pieces, smallest-risk first:

1. **Fix the dead index (independent, ship anytime):**
   `scripts/keycloak-db-indexes.sql:29` must match the live attribute names.
   During the migration window both prefixes exist (legacy accounts keep
   `x3_scram_*` until their next password change), so the predicate covers
   **both**: `WHERE name LIKE 'scram_sha256_%' OR name LIKE 'x3_scram_%'`.
   Update the surrounding comments (`:5`, `:26-27`, `:80`).
2. **Make the password policy provisioned, not manual.** This is the more
   valuable half of the "identity scrub" and stands on its own: add
   `passwordPolicy` to **both** realm bodies in `scripts/setup-keycloak.sh`
   (create `POST` `:102-126` and update `PUT` `:72-95`) so the SCRAM policy
   survives reprovisioning and realm recreation. The value must preserve
   whatever the live realm currently has (read it first via admin REST; do not
   invent a policy string — clobbering a live password policy is a
   user-facing regression).
3. **Rename the provider IDs — only after (2) is in place**, because (2) is what
   makes the rename safely repeatable. `x3Scram` → `scramSha256`;
   `DISPLAY_NAME` → `"SCRAM-SHA-256"`; `x3-scram-sha256` →
   `scram-sha256` (that factory is unregistered, so it is a free rename).
   Sequence: ship the SPI with the new ID → update `setup-keycloak.sh`'s
   policy string → redeploy Keycloak → flip the live realm's policy → verify a
   web-flow password change still writes `scram_sha256_*` attributes → then
   remove the old ID. **Keycloak refuses unknown policy providers**, so the
   flip order matters: new provider must be loaded before the policy string
   names it. Prose/comment scrub rides along in the same commit.

### Part 4 — X3-side residue verification (likely already closed)

Evidence suggests this self-closed: the X3-recognition assertion added in the
shipping work introduces the account to X3, which makes it visible to
`scripts/cleanup-tests.ts`'s AuthServ sweep (post-run output now shows
`X3 Accounts deleted: 1`). This part is therefore **a measurement, not a
change**: count `handle` records in the live `x3.db` before and after a suite
run, and confirm the count returns to baseline. If a residue remains, the fix
is scoped then (either extend the sweep or delete X3-side in the suite's
`afterAll` alongside the Keycloak delete) — not designed in advance for a
problem that may not exist.

### Part 5 — CAP value notification on policy flip

Not the assumed "CAP NEW carries no value" — it does. The fix is that
`feature_notify_accountreg_capvalue()` (`m_register.c:97-107`) updates the
stored value without notifying. Make it match the `DEFINE_CAP_NOTIFY` hooks:
after `cap_set_value()`, emit the change through the existing notify path so
the rehash batch (`ircd_features.c:1721`/`:1774`) carries it. **Verify first**
whether the batch already picks up a value-only change; if it does, this part
is a comment stating so and nothing more. Same-shape gap in `metadata-2` is
noted, not fixed here (different feature, its own value semantics).

## Testing

- **CMocka (gates the build):** `reg_throttle_check` — window reset boundary,
  limit-exhausted refusal, distinct IPs independent, global cap independent of
  per-IP, `0` disables each limiter, eviction under the entry cap, aging frees
  entries. Pure arithmetic with injected `now`, so no bed dependency.
  Plus: `requiredActions` parsing (present/absent/other-actions-only/exact-match)
  as a `parse_user` unit case if the existing kc suites can host it.
- **E2E (bed):** per-IP throttle — N+1 sequential REGISTERs from one client IP,
  the last gets `FAIL REGISTER RATE_LIMITED`, and after `PERIOD` (test-scoped
  short value) it succeeds again; oper bypass; global cap with the per-IP limit
  set permissive. SCRAM parity — a legacy-shaped account (`emailVerified=false`,
  **no** required action, set via admin REST) authenticates via SCRAM with the
  policy **on** (this is the regression test for the lockout); a daemon-born
  unverified account is refused on both PLAIN and SCRAM; after the admin flip,
  both succeed. SPI — web-flow password change still writes `scram_sha256_*`
  after the provider rename.
- **Measurement, not assertion:** Part 4's `x3.db` handle count (recorded in the
  implementation report, not a test).
- Every new/changed test cleans up the accounts it mints, per the leak lesson.

## Accepted limitations

1. **Per-server, not per-network, throttling.** Both limiters are node-local;
   an attacker spreading across N servers gets N× budget. Cross-server
   registration accounting would need new S2S state — out of scope, and the
   global backstop makes each server's exposure bounded and observable.
2. **Throttle state is not persisted** across restart (same as `IPcheck`).
3. **Legacy `x3_scram_*` accounts keep their attributes** until their next
   password change; the DB index covers both prefixes for that window, and the
   ircd's read-order fallback already handles it.
4. **The SPI provider rename requires a coordinated deploy** with a live realm
   edit; it is sequenced (Part 3) but cannot be made atomic.

## Scope boundaries

- **Not this spec:** cross-server/network-wide registration accounting; the
  `metadata-2` CAP-value notify gap; any change to `IPcheck`'s own connect-rate
  behavior; X3-side code.
- The `FEAT_CAP_draft_account_registration` default stays **off**; this spec
  makes enabling it *possible*, and the decision to enable anywhere exposed
  remains separate.
