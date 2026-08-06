# Native account registration with Keycloak-link verification — design

**Date:** 2026-08-05
**Status:** approved (design); implementation plan pending
**Scope:** Nefarious fork (`m_register.c`, libkc, SASL error surface),
`keycloak-webhook-spi` (SCRAM provider adaptation), testnet realm config + E2E
tests. No X3 code.
**Origin:** the 2026-08-04 X3-merge reconciliation flagged that the ircd advertises
`draft/account-registration` while `/REGISTER` relays RG into the void (a
client-visible lie). Rubin leans minimal IRC-based flow; the spec's verification
messaging is largely implementation-defined, and `VERIFY` is not the mandated
mechanism — which this design exploits.

## Goal

Make `/REGISTER` real: accounts born in Keycloak (per the standing 2026-07-30
decision "register is going to register in keycloak"), flowing to LDAP via the
WRITABLE federation, picked up by X3 via `ldap_autocreate` — with **email
verification as pure Keycloak-side policy** that the ircd respects but does not
implement. The IRC-side flow is minimal: no verification cookies, no pending
registration state, no `/VERIFY` completion mechanism, no mailer in the ircd.

## Ground truth (verified 2026-08-05; file:line)

**The spec permits the minimal flow.** `draft/account-registration` defines
`REGISTER VERIFICATION_REQUIRED` only as "further action is required"; the
mechanism is unspecified, `VERIFY` is one supported path rather than a
requirement, and the spec is silent on clients disconnecting between REGISTER
and verification — out-of-band (emailed link) completion is legitimate. All
human-readable messaging is implementation-defined.

**Current ircd surface** (all in `nefarious/`):
- CAP advertised as `before-connect,custom-account-name` (`ircd/m_cap.c:364`),
  feature-gated on `FEAT_CAP_draft_account_registration` (default off,
  `ircd_features.c:1210`). `email-required` and `min/max-password-length` are
  not advertised despite length enforcement (5/300, `m_register.c:209,216`).
- `m_register` validates length only (no account-name grammar, no email syntax),
  then relays `RG <services> <me>!<fd>.<saslcookie> <acct> <email> :<password>`
  to the first `+s` server (`m_register.c:106-118`) — cleartext password on the
  P10 link, and the cookie is **never allocated** (a non-SASL client sends
  `fd.0`, so `find_prereg_client`'s cookie check at `m_register.c:344`
  degenerates to fd-only matching with no fd-reuse protection).
- The reply tail is complete and reusable: `ms_regreply`'s `S` arm does the
  full local completion (pre-reg: `cli_saslaccount` + `SetSASLComplete` +
  `auth_set_account`, `m_register.c:433-445`; post-reg: `SetAccount` +
  `metadata_load_account` + ACCOUNT-notify, `:415-432`). The `V` arm is a
  stateless one-liner (`:448-451`) — correct by accident for this design. The
  `F` arm picks machine-readable FAIL codes by **substring-matching the
  human message text** (`strstr(message,"exists")` etc., `:453-466`).
- Pre-reg clients are bounded by `FEAT_CONNECTTIMEOUT` (60s default,
  `ircd_features.c:917`) — no email round-trip fits; any design requiring the
  client to stay connected through verification is stillborn.
- SASL-after-successful-REGISTER on the same connection is blocked by
  `SetSASLComplete` (`m_authenticate.c:154-161`); the account rides
  `cli_saslaccount` instead. By design; unchanged here.

**libkc surface** (`include/kc/kc_keycloak.h`, `ircd/kc/kc_keycloak.c`):
- `kc_user_create` (`kc_keycloak.c:1063-1121`) posts only
  `username`/`enabled:true`(hardcoded)/`email`/pre-hashed-credential; it cannot
  set `emailVerified` or `requiredActions`. Zero callers today.
- `kc_user_update` (`:1141-1165`) is a generic full-representation PUT — can
  set anything, but partial PUTs clobber (same warning as
  `setup-keycloak.sh:854`).
- **No email-flow call exists** — no `/send-verify-email` or
  `/execute-actions-email` URL builder (`include/kc/kc_url.h:16-37`).
- `struct kc_user.email_verified` is parsed (`kc_keycloak.c:198`) and read
  nowhere.
- ROPC (`kc_user_verify_password`, `:1205-1250`): HTTP 400/401 collapse to
  `KC_FORBIDDEN` without reading the body (`:718-737`) — Keycloak's
  `invalid_grant` / "Account is not fully set up" (pending required action) is
  indistinguishable from a wrong password.

**Webhook path is a dead end for this feature** (accepted): the SPI filters out
`VERIFY_EMAIL`/`REGISTER`/`UPDATE_PROFILE` user events by default
(`WebhookEventListenerProvider.java:58-63`), user-event payloads carry no
representation, and the ircd handler acts only on credential events, USER
DELETE, and USER UPDATE with `enabled:false` (`sasl_webhook.c:159-195`). No
live "you are now verified" push is possible without SPI + handler work.

**Deployment:** realm has `verifyEmail: false`, `registrationAllowed: true`,
no `smtpServer`, and no mail container exists. **User decision 2026-08-05: the
testbed will likely never enable SMTP on Keycloak** — tests must assert
flag-state, never mail delivery.

**SCRAM plumbing already lives in the webhook SPI — designed for the dead X3
fork.** `keycloak-webhook-spi` ships `ScramCredentialProvider` (a
`CredentialInputUpdater`, type `x3-scram-sha256`) and
`ScramPasswordPolicyProvider`: both derive RFC 7677 SCRAM-SHA-256 material
(PBKDF2-HMAC-SHA256, 4096 iterations, 16-byte salt, StoredKey/ServerKey) from
the **plaintext** at password-set time and store it in user attributes
`x3_scram_{salt,iterations,stored_key,server_key}`
(`ScramCredentialProvider.java:92-124`). The ircd advertises SCRAM-SHA-256
only (`sasl_auth.c:1933`) and its kc client reads exactly those attribute
names first, `x3_scram_sha256_*` as legacy fallback (`kc_keycloak.c:211-230`);
the SASL verify path consumes them (`sasl_auth.c:1299-1435`). Caveats: the
providers' contract and commentary date from the dead X3 `keycloak-integration`
fork ("so X3 can update its SCRAM cache"), they only fire on **plaintext**
credential sets — the policy provider explicitly does not run during
admin-API credential imports with pre-hashed values
(`ScramPasswordPolicyProvider.java:26-28`) — and relying on them from the
REGISTER path would mean shipping the plaintext in the create payload.

**AuthServ `AUTH` is a raw LDAP bind** (`x3/src/x3ldap.c:125`) and the WRITABLE
federation writes the password through to LDAP at creation — the legacy
services-auth path authenticates unverified accounts regardless of
`emailVerified`. Accepted limitation (see below).

## Design

### Who answers REGISTER: locally, on every server — the relay dies

Same posture as SASL, which already talks to Keycloak from every daemon:
`m_register`/`m_verify` handle the command locally via libkc. **The RG/VF/RR
relay machinery is deleted outright** (user decision 2026-08-05: "relayed
registration will never happen" — X3 will never grow RG/VF handlers):
`send_register_rg`/`send_verify_vf`, `ms_regreply` and the `RR` reply parsing,
the `RG`/`VF`/`RR` tokens (`msg.h:539-549`) and their `parse.c` entries, and
`FEAT_REGISTER_SERVER`. The `S`-arm completion tail is not lost — its logic
moves into the kc callback. On a build or deployment without Keycloak, the
existing default already does the right thing:
`FEAT_CAP_draft_account_registration` is off, the CAP is not advertised, and
REGISTER answers `DISABLED`. No new S2S traffic; the registrar-topology
question stays parked with the merge.

This delivers the parked X3-merge plan's Phase 1 "native REGISTER" item early —
`x3-merge-sequencing.md` gets a cross-reference when this ships (no silent
fork of that plan).

### The flow

1. **Local validation** (extends today's): account-name grammar per nick rules
   (today: length only) → `FAIL REGISTER BAD_ACCOUNT_NAME`; password length
   5/300 → `WEAK_PASSWORD`; email syntax checked minimally, and email is
   **required** (reject `*`/empty with `INVALID_EMAIL`) only when verification
   policy is on.
2. **Existence check:** `kc_user_search` on the account name →
   `FAIL REGISTER ACCOUNT_EXISTS`. Keycloak's view includes the federated LDAP
   directory, so one check covers both stores. (Legacy saxdb-only handles with
   no LDAP entry are invisible to it — accepted residue.)
3. **Create — one call, no plaintext on the wire.** The ircd derives all
   credential material in-house at REGISTER (user decision 2026-08-05: the
   registration payload must not carry the plaintext to Keycloak):
   - a **pre-hashed PBKDF2 credential** for Keycloak's own store — exactly
     what `kc_user_create`'s existing `cred_data`/`secret_data` parameters
     were built for (`kc_keycloak.c:1079-1097`); ROPC verifies against it
     normally;
   - the **SCRAM-SHA-256 attributes** (next section), included in the same
     create payload;
   - `email`, and — when verification policy is on — `"emailVerified": false`
     + `"requiredActions": ["VERIFY_EMAIL"]`.
   (The plaintext still crosses to Keycloak on every SASL PLAIN login — ROPC
   is inherently plaintext-in; this decision is about the registration
   payload, not that existing path.)
   - **Verification task (impl plan): LDAP write-through under pre-hashed
     import.** Gate 1b observed Keycloak→LDAP `{SSHA}` write-through for a
     *plaintext web-flow* password set. A hash import may write the LDAP
     entry without a bindable `userPassword` (or skip the credential write).
     Confirm: the entry is created; whether `userPassword` is usable; whether
     a federation credential-write failure can abort the create; and that
     X3's AC-stamp autocreate (`nickserv.c:5641+`) recognizes the account
     without a successful bind. If daemon-born accounts end up **SASL-only**
     (LDAP bind dead for them), that *narrows* accepted limitation 1 — the
     AuthServ AUTH bypass then applies only to web-flow/legacy accounts —
     and is documented, not fought.
     *(2026-08-06 probe: confirmed. Admin-REST create with
     `credentialData`/`secretData` (`pbkdf2-sha256`, 27500 iterations,
     `dklen=32`, both fields base64) returns 201 and the LDAP entry is
     created (`objectClass: inetOrgAnonAccount`, `uid`/`sn`/`cn` populated)
     but carries **no `userPassword` attribute at all** — not merely a
     different scheme. `ldapwhoami` as the new user returns "Invalid
     credentials (49)". The create does NOT abort on the missing
     credential write — it still returns 201. ROPC against the same user
     with the plaintext password succeeds (200, access token issued),
     confirming `dklen=32` is the correct, accepted key size — no need to
     fall back to 64. Full trace in
     `.superpowers/sdd/2026-08-05-account-registration/task-0-report.md`.)*

4. **Verification off** (today's realm): complete immediately from the kc
   callback by reusing the existing `S`-arm tail verbatim (pre-reg and
   post-reg variants) → `REGISTER SUCCESS`.
5. **Verification on:** after create, fire the new libkc email-trigger call
   (`PUT /admin/realms/{realm}/users/{id}/send-verify-email`; one new URL
   builder + thin wrapper). **Send failure is non-fatal and logged** — on a
   mailer-less deployment the call fails (Keycloak 500) but the account state
   is still correct and completable out-of-band (admin flip, or any future
   mailer). Reply `REGISTER VERIFICATION_REQUIRED <account>` with message text:
   check your email for a verification link, then log in normally (SASL). **The
   server stores nothing** — no cookie, no timer, no pending record. The
   client may disconnect; the pending state lives entirely in Keycloak.

### SCRAM credential seeding (required at REGISTER)

Server-side SCRAM material (salt, iterations, StoredKey, ServerKey) can only
be derived while the plaintext exists — REGISTER is that moment (user
requirement 2026-08-05). Without it, daemon-born accounts can never
authenticate via SCRAM-SHA-256.

**Mechanism: the ircd derives in-house** (user decision 2026-08-05 — using
the SPI for this would require shipping the plaintext in the create payload,
rejected above). At REGISTER the ircd computes RFC 7677 SCRAM-SHA-256
material (random 16-byte salt, 4096 iterations, PBKDF2 → StoredKey/ServerKey)
matching the SPI's parameters exactly, and includes the SCRAM attributes in
the create payload. Primitives exist: `hmac_sha256`/`sha256_hash` in
`sasl_auth.c`, PBKDF2 via OpenSSL (`PKCS5_PBKDF2_HMAC` — also needed for the
Keycloak credential import above). Derivation must round-trip against the
ircd's own verify path (`sasl_auth.c:1299-1435`) in CMocka.

**Attribute rename: the `x3_` prefix dies** (user decision 2026-08-05 — the
attributes outlive X3). Canonical names become
`scram_sha256_{salt,iterations,stored_key,server_key}` — mechanism-explicit
(room for future mechanisms), the legacy sha256-infixed spelling minus the
prefix. Both writers emit the new names (ircd create payload; SPI providers).
The kc client's read order becomes: `scram_sha256_*` → legacy `x3_scram_*` →
legacy `x3_scram_sha256_*` (`kc_keycloak.c:211-230` already implements the
two-tier fallback; it gains the new first tier). No bulk migration: existing
accounts keep authenticating via the fallbacks and converge to the new names
on their next password change. `x3_opserv_level` and friends are out of scope
here.

**The SPI keeps the other direction.** Users created or changing passwords
entirely via Keycloak's web flow get their SCRAM attributes from the existing
`ScramCredentialProvider`/`ScramPasswordPolicyProvider` — that also covers
regeneration when a daemon-born account later changes its password via the
web flow, so SCRAM material follows the live password in both directions.
The SPI adaptation therefore consists of: the attribute rename above, and
re-pointing the dead-fork commentary/contract ("so X3 can update its SCRAM
cache") at the ircd as consumer. Derivation parameters are already identical
(SHA-256, 4096 iterations — both sides must stay in lockstep, stated as a
contract comment in both trees).

One residue, stated per no-silent-defer: a password change made through a
path that neither the SPI hooks nor the ircd sees (e.g. a future admin-API
pre-hashed reset by other tooling) would strand stale SCRAM attributes that
still validate the **old** password until the next SPI- or ircd-mediated
change. No such path exists in this deployment today.

### Policy knob

One new feature, `FEAT_REGISTER_VERIFY_EMAIL` (default off — matches the
testbed realm's `verifyEmail: false`). When on: email required at REGISTER,
`email-required` appears in the CAP value, create carries
`emailVerified:false` + `VERIFY_EMAIL` required action, and the email trigger
fires. The deployment is responsible for keeping this consistent with realm
policy; the ircd does not read realm config.

### VERIFY: graceful decline, never a poll-login

The emailed link carries a Keycloak action token, not a typeable code, so
`/VERIFY` cannot complete verification. It also must **not** become a
poll-that-logs-in: a code-less VERIFY granting login once `emailVerified`
flips would let anyone claim a freshly verified account. `/VERIFY` under
Keycloak mode replies `FAIL VERIFY INVALID_CODE` with message text pointing at
the email link + SASL. (Also fixes today's behavior where a failed VERIFY
answers in the `REGISTER` namespace.) Spec-clean: VERIFY is not the mandated
mechanism.

### Enforcement — how Keycloak-side verification is respected

- **Free path:** the pending `VERIFY_EMAIL` required action makes Keycloak
  refuse ROPC — unverified SASL PLAIN fails closed with zero new code.
- **De-opacified:** `OP_VERIFY_PASSWORD` parses the error body
  (`error`/`error_description`) and maps "Account is not fully set up" /
  `invalid_grant`-with-required-action to a new `KC_UNVERIFIED` result; the
  SASL layer surfaces "verify your email, then try again" instead of
  wrong-password. The SASL credential-cache fallback on
  `KC_FORBIDDEN`/`KC_NOT_FOUND` (`sasl_auth.c:741`) must **not** engage on
  `KC_UNVERIFIED` (a fresh account has no cached hash, but the rule is stated,
  not assumed).
- **SCRAM must gate on verification itself.** SCRAM verifies locally against
  the stored SCRAM attributes and never touches ROPC, so the required-action
  refusal does not cover it — and daemon-born accounts now *have* SCRAM
  credentials. When `FEAT_REGISTER_VERIFY_EMAIL` is on, the SCRAM credential
  callback refuses users with `email_verified == false` (the first real
  reader of that parsed-but-never-read field) with the same
  verify-your-email messaging.
- ECDSA remains inapplicable (a client keypair is not derivable from a
  password; registered separately).

### Reply/CAP surface cleanup (swept in)

- CAP value gains `min-password-length=5,max-password-length=300`, and
  `email-required` when the policy feature is on (the value string becomes
  policy-dependent — computed at advertise time instead of the static
  `_CAP_V` literal).
- The local path returns structured errors from libkc — the `F` arm's
  message-text substring matching dies entirely with the relay.
- Pre-reg completion routing gets a real random cookie (allocated at REGISTER
  time, SASL-style `m_authenticate.c:190-193`) instead of `fd.0` — closing
  the fd-reuse window for the async kc callback. The callback must also
  tolerate the client having exited (same discipline as SASL parking).
- Missing validation codes added where validation now exists:
  `INVALID_EMAIL`/`UNACCEPTABLE_EMAIL`, `BAD_ACCOUNT_NAME` for grammar.
  `COMPLETE_CONNECTION_REQUIRED` stays unused (before-connect is supported and
  advertised).

## Accepted limitations (deliberate, documented, not deferred silently)

1. **AuthServ `AUTH` bypass:** the raw LDAP bind authenticates unverified
   accounts. Verification gates SASL only, until X3's auth surface is demoted
   (merge Window 1). User-ratified 2026-08-05. May *narrow* under the
   pre-hashed credential import: if the federation writes no bindable
   `userPassword` for daemon-born accounts, the bypass applies only to
   web-flow/legacy accounts and daemon-born accounts are SASL-only
   (per the LDAP write-through verification task).
   *(2026-08-06 probe: narrows, confirmed. Pre-hashed admin-REST import
   writes an LDAP entry with no `userPassword` attribute — `ldapwhoami`
   fails "Invalid credentials". For daemon-born (REGISTER-created)
   accounts, the raw-LDAP-bind path AuthServ `AUTH` relies on is dead —
   the bypass does not apply to them. It still applies to web-flow/legacy
   accounts, whose plaintext password-set goes through Keycloak's
   `updateCredential` path and does write `{SSHA}` to LDAP (per Gate 1b).
   Net effect: REGISTER-created accounts are SASL-only from day one,
   ahead of the merge Window 1 demotion.)*
2. **Legacy saxdb-only collisions:** an account name existing only in X3's
   saxdb (no LDAP entry) is invisible to the existence check; X3-side behavior
   on first bind is unchanged from today's `ldap_autocreate` reality.
3. **No live verification push:** a connected client learns verification
   succeeded by attempting SASL, not by server notice (webhook SPI would need
   event-filter + payload work — future nicety).
4. **Policy/realm consistency is operational**, not enforced: if
   `FEAT_REGISTER_VERIFY_EMAIL` disagrees with realm behavior, accounts are
   still created correctly; only messaging quality degrades.

## Testing (no SMTP — flag-state only, per user decision)

- **CMocka (gates the build):** account-name/email validators; the ROPC error
  body → `KC_UNVERIFIED` mapping (pure JSON/string parsing, table-driven);
  SCRAM derivation round-trip — material derived at REGISTER must verify
  through the ircd's own SCRAM verify path, plus a fixed-vector cross-check
  against the SPI's derivation (lockstep guard).
  *(2026-08-06 probe: confirmed body, verbatim —
  `{"error":"invalid_grant","error_description":"Account is not fully set up"}`
  at HTTP 400, for ROPC against a user created with `emailVerified:false` +
  `requiredActions:["VERIFY_EMAIL"]`. Matches the expected fixture exactly;
  the `KC_UNVERIFIED` classifier can match on this literal string.)*
- **E2E, verification off (bed default, runnable today):** REGISTER →
  `REGISTER SUCCESS` → account visible in Keycloak (admin REST) and present
  in LDAP (entry existence confirmed; **assert absence of `userPassword`**,
  not a scheme value — per the 2026-08-06 probe the pre-hashed import
  writes no `userPassword` at all, so any test asserting a bindable LDAP
  password for a daemon-born account will fail by design) → SASL PLAIN
  succeeds on a fresh connection → X3 recognizes the account (AC-stamp
  path — the LDAP bind path is confirmed dead for daemon-born accounts,
  not merely "may be dead"). Unskip the `.skip`ed registration test
  (`tests/src/ircv3/sasl.test.ts:288`) and point it at this path.
- **E2E, SCRAM seeding:** after REGISTER, admin REST asserts the
  `scram_sha256_{salt,iterations,stored_key,server_key}` attributes exist
  (new canonical names); SASL
  **SCRAM-SHA-256** with the registered password succeeds on a fresh
  connection. Under verification-on: SCRAM is refused while unverified,
  succeeds after the flag flip.
- **E2E, verification on:** enable `FEAT_REGISTER_VERIFY_EMAIL` (test-scoped
  server config), then: REGISTER → `VERIFICATION_REQUIRED` → admin REST
  asserts `emailVerified == false` and `requiredActions` contains
  `VERIFY_EMAIL` → SASL PLAIN **fails** with the unverified message (not
  wrong-password) → test flips the flag via admin REST (`emailVerified: true`,
  clear required action — exactly what the emailed link does) → SASL PLAIN
  succeeds. `/VERIFY` returns the graceful decline. The send-verify-email call
  fails against the mailer-less realm and must be observed **non-fatal**
  (registration state unaffected; failure logged).
- **Pre-reg leg:** REGISTER before connection registration on both paths
  (SUCCESS completes via `cli_saslaccount`; VERIFICATION_REQUIRED leaves the
  client unauthenticated and able to complete connection normally).
- irctest has `account_registration.py` upstream — run it against the fork as
  a conformance cross-check once green.

## Scope boundaries

- **Fork-only.** Keycloak and the whole `draft/account-registration` surface
  are fork-exclusive; upstream carries none of this code, so deleting the
  relay has no upstream implication.
- **No X3 code.** X3 sees new accounts exactly as it sees Gate 1b accounts
  today (LDAP autocreate).
- **Not this spec:** the X3-merge Phase 1 account *authority* work (registry
  env, UUID directory rows) — this is only the REGISTER verb; webhook-driven
  live completion; any `/VERIFY`-code mechanism; ircd-side mailing.

## Open follow-ups (out of scope here)

- Webhook SPI event-filter + representation for `VERIFY_EMAIL` → live client
  notice on verification (would also enable auto-login UX for still-connected
  post-reg clients — needs its own abuse analysis).
- `KC_UNVERIFIED`-style body parsing could also distinguish disabled accounts
  ("Account disabled") for better SASL messaging generally.
- When the X3 merge unparks, fold this into Phase 1 as the already-done
  native-REGISTER item (sequencing doc cross-ref).
